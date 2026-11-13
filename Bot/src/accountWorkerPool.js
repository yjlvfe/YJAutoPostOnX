'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { DirectXAdapter } = require('./directX');
const { SessionGuardRegistry } = require('./sessionGuard');

const MAX_PROJECT_SESSIONS = 5;

function defaultAccountRevision(account) {
  return JSON.stringify(['cookieFile', 'enabled', 'needsOwnerCaptcha', 'checkGeneration'].map(k => account?.[k]));
}

class AccountWorkerPool {
  constructor({
    maxWorkers = MAX_PROJECT_SESSIONS,
    adapterFactory = null,
    vpnSlots,
    logger = console,
    accountRevision = defaultAccountRevision,
    closeTimeoutMs = 5000,
    sessionGuardRegistry = null,
    cleanupRetryMs = 250
  } = {}) {
    this.maxWorkers = maxWorkers;
    this.adapterFactory = adapterFactory;
    this.vpnSlots = vpnSlots;
    this.logger = logger;
    this.accountRevision = accountRevision;
    this.closeTimeoutMs = closeTimeoutMs;
    this.sessionGuardRegistry = sessionGuardRegistry;
    this.cleanupRetryMs = Math.max(25, Math.min(5000, Number.isFinite(cleanupRetryMs) ? cleanupRetryMs : 250));

    this.workers = new Map(); // accountId -> WorkerRecord
    this.draining = new Map(); // accountId -> Promise<void>
    this.pendingOpenTasks = new Map(); // accountId -> Promise<WorkerRecord>
    this.preparations = new Map(); // runPreparationId -> Set<accountId>
    this.activeRunId = null;
    this.generation = 1;
    this.fenced = false;
    this.closed = false;

    // Clean up startup orphans
    this.startupReady = this.cleanStartupOrphans();
    // Keep rejection observed until an admission method awaits and fails closed.
    this.startupReady.catch(() => {});
  }

  async cleanStartupOrphans() {
    if (this.sessionGuardRegistry === false) {
      return { purged: 0 };
    }
    try {
      const registry = this.sessionGuardRegistry || new SessionGuardRegistry();
      try { return await registry.reconcileOrphans(); }
      finally { if (!this.sessionGuardRegistry) await registry.close(); }
    } catch (err) {
      this.logger.warn?.(JSON.stringify({ event: 'orphan_cleanup_warning', code: err?.code }));
      throw err;
    }
  }

  get activeCount() {
    return this.workers.size; // draining records remain owned in workers, never double-count them
  }

  get totalAllocated() {
    return this.activeCount + this.pendingOpenTasks.size;
  }

  hasWorker(accountId) {
    const w = this.workers.get(String(accountId));
    return Boolean(w && w.state !== 'draining' && !this.draining.has(String(accountId)));
  }

  getWorker(accountId) {
    const w = this.workers.get(String(accountId));
    if (!w || w.state === 'draining' || this.draining.has(String(accountId))) return null;
    return {
      accountId: w.accountId,
      slot: w.slot,
      userId: w.userId,
      username: w.username,
      cookieFingerprint: w.cookieFingerprint,
      accountRevision: w.accountRevision,
      localOnly: w.localOnly,
      routeIdentity: w.routeIdentity,
      identity: w.session?.identity,
      receipt: w.session?.receipt,
      busy: w.busy,
      state: w.state
    };
  }

  fenceAdmission() {
    this.fenced = true;
  }

  _validateSession({ session, account, route, expectedSlot }) {
    if (!session || typeof session !== 'object' || session.closed) {
      return { valid: false, reason: 'SESSION_MISSING_OR_CLOSED' };
    }
    if (session.state !== 'authenticated') {
      return { valid: false, reason: `SESSION_STATE_INVALID: ${session.state}` };
    }

    const identity = session.identity;
    if (!identity || typeof identity !== 'object' || identity.authenticated !== true) {
      return { valid: false, reason: 'IDENTITY_NOT_AUTHENTICATED' };
    }
    if (!identity.userId || !/^\d+$/.test(String(identity.userId))) {
      return { valid: false, reason: 'IDENTITY_USERID_INVALID' };
    }
    if (typeof identity.username !== 'string' || !identity.username.trim()) {
      return { valid: false, reason: 'IDENTITY_USERNAME_INVALID' };
    }
    if (['challenge', 'locked', 'captcha', 'suspended', 'banned', 'restricted', 'accountFailure'].some(k => Boolean(identity[k]))) {
      return { valid: false, reason: 'IDENTITY_FAILURE_FLAG_SET' };
    }

    // Account identity matching if configured
    if (account?.userId && String(identity.userId) !== String(account.userId)) {
      return { valid: false, reason: 'IDENTITY_USERID_MISMATCH' };
    }
    if (account?.username && identity.username.toLowerCase() !== String(account.username).toLowerCase()) {
      return { valid: false, reason: 'IDENTITY_USERNAME_MISMATCH' };
    }

    // Valid cookie binding receipt requirement
    const receipt = session.receipt;
    if (!receipt || typeof receipt !== 'object') {
      return { valid: false, reason: 'RECEIPT_MISSING' };
    }
    if (receipt.userId != null && String(receipt.userId) !== String(identity.userId)) {
      return { valid: false, reason: 'RECEIPT_USERID_MISMATCH' };
    }
    if (receipt.username != null && String(receipt.username).toLowerCase() !== identity.username.toLowerCase()) {
      return { valid: false, reason: 'RECEIPT_USERNAME_MISMATCH' };
    }

    // Cookie fingerprint matching
    const identityFp = identity.cookieFingerprint;
    const receiptFp = receipt.cookieFingerprint;
    if (identityFp && receiptFp && identityFp !== receiptFp) {
      return { valid: false, reason: 'COOKIE_FINGERPRINT_MISMATCH' };
    }
    if (account?.cookieFingerprint) {
      if (identityFp && account.cookieFingerprint !== identityFp) {
        return { valid: false, reason: 'ACCOUNT_FINGERPRINT_MISMATCH' };
      }
      if (receiptFp && account.cookieFingerprint !== receiptFp) {
        return { valid: false, reason: 'ACCOUNT_FINGERPRINT_MISMATCH' };
      }
    }

    // Route identity matching
    const slot = Number.isInteger(route?.slot) ? route.slot : (expectedSlot ?? 0);
    const routeIdentity = route?.exitIp || route?.proxy || (slot != null ? String(slot) : null);

    if (session.routeIdentity && routeIdentity && session.routeIdentity !== routeIdentity) {
      return { valid: false, reason: 'SESSION_ROUTE_IDENTITY_MISMATCH' };
    }
    if (receipt.routeIdentity && routeIdentity && receipt.routeIdentity !== routeIdentity) {
      return { valid: false, reason: 'RECEIPT_ROUTE_IDENTITY_MISMATCH' };
    }
    if (identity.routeIdentity && routeIdentity && identity.routeIdentity !== routeIdentity) {
      return { valid: false, reason: 'IDENTITY_ROUTE_IDENTITY_MISMATCH' };
    }
    if (session.slot != null && slot != null && session.slot !== slot) {
      return { valid: false, reason: 'SESSION_SLOT_MISMATCH' };
    }
    if (receipt.slot != null && slot != null && receipt.slot !== slot) {
      return { valid: false, reason: 'RECEIPT_SLOT_MISMATCH' };
    }
    if (route?.slot != null && expectedSlot != null && route.slot !== expectedSlot) {
      return { valid: false, reason: 'ROUTE_SLOT_MISMATCH' };
    }

    let cookieFingerprint = identityFp || receiptFp || account?.cookieFingerprint || '';
    if (!cookieFingerprint && account?.cookieFile) {
      try {
        if (fs.existsSync(account.cookieFile)) {
          const content = fs.readFileSync(account.cookieFile, 'utf8');
          cookieFingerprint = crypto.createHash('sha256').update(content.trim()).digest('hex');
        }
      } catch {}
    }

    return { valid: true, identity, receipt, slot, routeIdentity, cookieFingerprint };
  }

  async prepareCycle({ state, accountIds = null, snapshot = null, signal = null } = {}) {
    await this.startupReady;
    if (this.fenced || this.closed) {
      return { ready: false, reasons: ['مجمع العمال مغلق أو متوقف'], ids: [], receipt: null };
    }
    if (signal?.aborted) {
      throw Object.assign(new Error('Preparation aborted'), { code: 'PREPARATION_ABORTED' });
    }

    const stateAccounts = state?.accounts || [];
    const targetIds = accountIds ? new Set(accountIds.map(String)) : null;

    const candidates = stateAccounts.filter(a => {
      if (targetIds && !targetIds.has(String(a.id))) return false;
      if (a.enabled === false) return false;
      if (a.needsOwnerCaptcha || a.status === 'معزول (3 إخفاقات)' || (a.failures || 0) >= 3) return false;
      if (['challenge', 'locked', 'captcha', 'suspended', 'banned', 'accountFailure'].some(k => Boolean(a[k]))) return false;
      if (typeof a.cookieFile !== 'string' || !a.cookieFile.trim()) return false;
      if (!Number.isInteger(state?.vpnSlots?.[String(a.id)])) return false;
      return true;
    });

    const runPreparationId = crypto.randomUUID();
    const preparedIds = new Set();
    const reasons = [];

    // Evict stale idle non-candidate workers before computing remaining slot capacity
    const candidateIdSet = new Set(candidates.map(c => String(c.id)));
    const staleIdleNonCandidates = [];
    for (const [id, worker] of this.workers.entries()) {
      if (!candidateIdSet.has(id) && !worker?.busy && worker?.state !== 'borrowed' && worker?.state !== 'draining' && !this.draining.has(id)) {
        staleIdleNonCandidates.push(id);
      }
    }
    if (staleIdleNonCandidates.length > 0) {
      await Promise.allSettled(staleIdleNonCandidates.map(id => this.drain(id)));
      if (this.closed || this.fenced || signal?.aborted) {
        return { ready: false, reasons: ['مجمع العمال متوقف'], ids: [], receipt: null };
      }
    }

    // Bound candidate selection by remaining capacity under maxWorkers
    const currentNonCandidateActive = Array.from(this.workers.keys()).filter(id => !candidateIdSet.has(id) && !this.draining.has(id)).length;
    const availableSlots = Math.max(0, this.maxWorkers - currentNonCandidateActive - this.draining.size - this.pendingOpenTasks.size);
    const eligibleCandidates = candidates.slice(0, availableSlots);

    const tasks = eligibleCandidates.map(async account => {
      if (signal?.aborted) return;
      const accId = String(account.id);

      const existing = this.workers.get(accId);
      const currentRevision = this.accountRevision(account);
      const expectedSlot = Number.isInteger(state?.vpnSlots?.[accId]) ? state.vpnSlots[accId] : null;

      if (existing && existing.state !== 'draining' && !this.draining.has(accId)) {
        // Check if revision or slot changed
        if (existing.accountRevision === currentRevision && (expectedSlot == null || existing.slot === expectedSlot)) {
          preparedIds.add(accId);
          existing.preparationId = runPreparationId;
          return;
        } else {
          // Invalidate and drain old worker before replacing
          try {
            await this.drain(accId);
          } catch (drainErr) {
            this.logger.warn?.(JSON.stringify({
              event: 'worker_prepare_drain_failed',
              accountId: accId,
              code: drainErr?.code,
              error: drainErr?.message
            }));
            reasons.push(`تعذر إغلاق العامل السابق للحساب ${account.username || accId}`);
            return;
          }
        }
      }

      if (this.activeCount + this.pendingOpenTasks.size >= this.maxWorkers) {
        reasons.push(`تم بلوغ الحد الأقصى للجلسات (${this.maxWorkers})؛ تعذر تجهيز الحساب ${account.username || accId}`);
        return;
      }

      // Open new worker
      try {
        await this._admitWorker({ account, expectedSlot, runPreparationId, signal });
        preparedIds.add(accId);
      } catch (err) {
        this.logger.warn?.(JSON.stringify({
          event: 'worker_prepare_failed',
          accountId: accId,
          code: err?.code,
          error: err?.message
        }));
        reasons.push(`فشل تجهيز العامل للحساب ${account.username || accId}`);
      }
    });

    await Promise.all(tasks);

    if (this.closed || this.fenced || signal?.aborted) {
      if (preparedIds.size > 0) {
        this.preparations.set(runPreparationId, preparedIds);
        await this.discardPreparation(runPreparationId, signal?.aborted ? 'preparation_aborted' : 'pool_fenced');
      }
      return { ready: false, reasons: ['مجمع العمال متوقف'], ids: [], receipt: null };
    }
    this.preparations.set(runPreparationId, preparedIds);

    const readyWorkers = Array.from(preparedIds)
      .map(id => this.workers.get(id))
      .filter(w => w && w.state !== 'draining');

    const isReady = readyWorkers.length > 0;
    if (!isReady && !reasons.length) {
      reasons.push('لا يوجد حسابات جاهزة لتشغيل العمال');
    }

    const receipt = isReady ? Object.freeze({
      kind: 'worker_pool_readiness',
      version: 1,
      runPreparationId,
      preparedAt: new Date().toISOString(),
      generation: this.generation,
      workers: Object.freeze(readyWorkers.map(w => Object.freeze({
        accountId: w.accountId,
        slot: w.slot,
        userId: w.userId,
        username: w.username,
        cookieFingerprint: w.cookieFingerprint,
        accountRevision: w.accountRevision,
        localOnly: w.localOnly,
        routeIdentity: w.routeIdentity
      })))
    }) : null;

    return {
      ready: isReady,
      reasons: isReady ? [] : reasons,
      ids: readyWorkers.map(w => w.accountId),
      receipt,
      commit: (runId) => {
        this.bindRun(runId, runPreparationId);
      },
      discard: async (reason) => {
        await this.discardPreparation(runPreparationId, reason);
      }
    };
  }

  async _drainWorker(worker) {
    if (!worker) return;
    worker.state = 'draining';
    if (worker.cleanupTimer) {
      clearTimeout(worker.cleanupTimer);
      worker.cleanupTimer = null;
    }

    try {
      const drainDeadline = Date.now() + Math.max(30000, this.closeTimeoutMs || 5000);
      while (worker.busy && Date.now() < drainDeadline) {
        await new Promise(r => setTimeout(r, 50));
      }
      if (worker.adapter && worker.session) {
        await worker.adapter.close({ session: worker.session, timeoutMs: this.closeTimeoutMs });
      }
      if (!worker.routeReleased) {
        await worker.route?.release?.();
        worker.routeReleased = true;
      }
      if (this.workers.get(worker.accountId) === worker) {
        this.workers.delete(worker.accountId);
      }
      this.generation++;
    } catch (err) {
      this.logger.error?.(JSON.stringify({ event: 'worker_cleanup_pending', accountId: worker.accountId, code: err?.code }));
      this._scheduleCleanup(worker);
      throw Object.assign(new Error('Worker cleanup remains unverified'), {
        code: 'POOL_CLEANUP_PENDING',
        causeCode: err?.code
      });
    }
  }

  async _openWorker({ account, expectedSlot, runPreparationId, signal }) {
    const accId = String(account.id);
    let route = null;

    if (typeof this.vpnSlots?.acquireRoute === 'function') {
      route = await this.vpnSlots.acquireRoute(accId, { signal });
    } else if (typeof this.vpnSlots?.ensure === 'function') {
      route = await this.vpnSlots.ensure(accId, { signal });
    } else {
      route = { slot: expectedSlot ?? 0, proxy: null, exitIp: null, release() {} };
    }

    const slot = Number.isInteger(route?.slot) ? route.slot : (expectedSlot ?? 0);
    const adapter = this.adapterFactory ? this.adapterFactory() : new DirectXAdapter({ allowPublish: true, sessionGuardRegistry: this.sessionGuardRegistry });

    let session;
    try {
      session = await adapter.open({
        account,
        proxy: route.proxy,
        slot,
        signal
      });
    } catch (openErr) {
      if (openErr?.code === 'DIRECT_X_CLEANUP_UNVERIFIED' && openErr.session) {
        const quarantined = {
          accountId: accId,
          slot,
          userId: null,
          username: account.username || null,
          cookieFingerprint: '',
          accountRevision: this.accountRevision(account),
          localOnly: false,
          routeIdentity: route?.exitIp || route?.proxy || String(slot),
          session: openErr.session,
          adapter,
          route,
          busy: false,
          state: 'draining',
          preparationId: runPreparationId,
          createdAt: Date.now()
        };
        this.workers.set(accId, quarantined);
        this._scheduleCleanup(quarantined);
        throw openErr;
      }
      try { route?.release?.(); } catch {}
      throw openErr;
    }

    const check = this._validateSession({ session, account, route, expectedSlot });

    const worker = {
      accountId: accId,
      slot: check.valid ? check.slot : slot,
      userId: check.valid ? (check.identity.userId || null) : (session?.identity?.userId || null),
      username: check.valid ? (check.identity.username || null) : (session?.identity?.username || null),
      cookieFingerprint: check.valid ? check.cookieFingerprint : (session?.identity?.cookieFingerprint || session?.receipt?.cookieFingerprint || ''),
      accountRevision: this.accountRevision(account),
      localOnly: Boolean(check.valid ? (check.identity.localOnly || check.receipt.localOnly) : false),
      routeIdentity: check.valid ? check.routeIdentity : (route?.exitIp || route?.proxy || String(slot)),
      session,
      adapter,
      route,
      busy: false,
      state: check.valid ? 'idle' : 'draining',
      preparationId: runPreparationId,
      createdAt: Date.now()
    };

    if (!check.valid) {
      // Keep ownership until cleanup is positively verified, including rejection.
      this.workers.set(accId, worker);
      await this._drainWorker(worker);
      throw Object.assign(
        new Error(`Returned session is not usable: ${check.reason}`),
        { code: 'WORKER_SESSION_UNVERIFIED', reason: check.reason }
      );
    }

    this.generation++;
    return worker;
  }

  async getOrOpenWorker({ account, state = null, signal = null } = {}) {
    await this.startupReady;
    if (this.fenced || this.closed) {
      throw Object.assign(new Error('POOL_FENCED: Pool admission fenced or pool closed'), { code: 'POOL_FENCED' });
    }
    if (signal?.aborted) {
      throw Object.assign(new Error('OPEN_ABORTED: Open aborted'), { code: 'OPEN_ABORTED' });
    }
    const accId = String(account.id);
    const existing = this.workers.get(accId);
    const currentRevision = this.accountRevision(account);
    const expectedSlot = Number.isInteger(state?.vpnSlots?.[accId]) ? state.vpnSlots[accId] : null;

    if (existing && existing.state !== 'draining' && !this.draining.has(accId)) {
      if (existing.accountRevision === currentRevision && (expectedSlot == null || existing.slot === expectedSlot)) {
        return existing;
      }
      // Stale revision or slot: drain old worker before admitting replacement
      await this.drain(accId);
    }
    if (this.workers.has(accId) || this.draining.has(accId)) {
      throw Object.assign(new Error('Prior worker cleanup pending'), { code: 'ACCOUNT_WORKER_DRAINING' });
    }
    if (this.pendingOpenTasks.has(accId)) {
      return this.pendingOpenTasks.get(accId);
    }
    if (this.activeCount + this.pendingOpenTasks.size >= this.maxWorkers) {
      throw Object.assign(new Error(`MAX_PROJECT_SESSIONS_EXCEEDED: Pool capacity limit of ${this.maxWorkers} reached`), { code: 'MAX_PROJECT_SESSIONS_EXCEEDED' });
    }
    return this._admitWorker({ account, expectedSlot, runPreparationId: null, signal });
  }

  _admitWorker({ account, expectedSlot, runPreparationId, signal }) {
    const accId = String(account.id);
    if (this.closed || this.fenced || signal?.aborted) {
      return Promise.reject(Object.assign(new Error('Pool admission fenced'), { code: 'POOL_FENCED' }));
    }
    if (this.pendingOpenTasks.has(accId)) return this.pendingOpenTasks.get(accId);
    if (this.workers.has(accId) || this.draining.has(accId)) {
      return Promise.reject(Object.assign(new Error('Prior worker cleanup pending'), { code: 'ACCOUNT_WORKER_DRAINING' }));
    }
    if (this.activeCount + this.pendingOpenTasks.size >= this.maxWorkers) {
      return Promise.reject(Object.assign(new Error(`MAX_PROJECT_SESSIONS_EXCEEDED: Pool capacity limit of ${this.maxWorkers} reached`), { code: 'MAX_PROJECT_SESSIONS_EXCEEDED' }));
    }

    const openPromise = Promise.resolve().then(async () => {
      let worker;
      try {
        worker = await this._openWorker({ account, expectedSlot, runPreparationId, signal });
      } finally {
        if (this.pendingOpenTasks.get(accId) === openPromise) {
          this.pendingOpenTasks.delete(accId);
        }
      }
      this.workers.set(accId, worker); // own the cleanup handle before any post-open await
      if (this.closed || this.fenced || this.draining.has(accId) || signal?.aborted) {
        await this._drainWorker(worker);
        throw Object.assign(new Error('Pool fenced during open'), { code: 'POOL_FENCED' });
      }
      return worker;
    });

    this.pendingOpenTasks.set(accId, openPromise);
    return openPromise;
  }

  async prepareAccount({ account, state = null, signal = null } = {}) {
    return this.getOrOpenWorker({ account, state, signal });
  }

  bindRun(runId, runPreparationId) {
    this.activeRunId = runId;
    const preparedIds = this.preparations.get(runPreparationId);
    if (preparedIds) {
      for (const id of preparedIds) {
        const w = this.workers.get(id);
        if (w && w.preparationId === runPreparationId) {
          w.preparationId = null;
          w.committedRunId = runId;
        }
      }
      this.preparations.delete(runPreparationId);
    }
  }

  async discardPreparation(runPreparationId, reason) {
    const preparedIds = this.preparations.get(runPreparationId);
    if (!preparedIds) return;

    this.preparations.delete(runPreparationId);
    const drainTasks = [];

    for (const id of preparedIds) {
      const w = this.workers.get(id);
      if (w && w.preparationId === runPreparationId) {
        drainTasks.push(this.drain(id));
      }
    }

    await Promise.allSettled(drainTasks);
  }

  async borrow(accountId, options = {}) {
    if (this.fenced || this.closed) {
      throw Object.assign(new Error('POOL_FENCED: Pool admission fenced or pool closed'), { code: 'POOL_FENCED' });
    }
    const signal = options?.signal;
    if (signal?.aborted) {
      throw Object.assign(new Error('BORROW_ABORTED: Borrow aborted'), { code: 'BORROW_ABORTED' });
    }

    const accId = String(accountId);

    // Reject borrowing an account worker for another account
    const requestedTarget = options?.targetAccountId || options?.forAccountId || options?.account?.id || (options?.accountId && String(options.accountId) !== accId ? options.accountId : null);
    if (requestedTarget && String(requestedTarget) !== accId) {
      throw Object.assign(
        new Error(`ACCOUNT_WORKER_MISMATCH: Cannot borrow worker for account ${accId} to serve account ${requestedTarget}`),
        { code: 'ACCOUNT_WORKER_MISMATCH' }
      );
    }

    const worker = this.workers.get(accId);

    if (!worker) {
      throw Object.assign(new Error(`ACCOUNT_WORKER_NOT_FOUND: No active worker found for account ${accId}`), { code: 'ACCOUNT_WORKER_NOT_FOUND' });
    }
    if (worker.state === 'draining' || this.draining.has(accId)) {
      throw Object.assign(new Error(`ACCOUNT_WORKER_DRAINING: Worker for account ${accId} is draining`), { code: 'ACCOUNT_WORKER_DRAINING' });
    }
    if (worker.busy || worker.state === 'borrowed') {
      throw Object.assign(new Error(`ACCOUNT_WORKER_BUSY: Worker for account ${accId} is already borrowed`), { code: 'ACCOUNT_WORKER_BUSY' });
    }

    // Verify expected revision or slot if specified
    if (options?.expectedRevision && worker.accountRevision !== options.expectedRevision) {
      throw Object.assign(new Error(`ACCOUNT_REVISION_MISMATCH: Worker revision mismatch for account ${accId}`), { code: 'ACCOUNT_REVISION_MISMATCH' });
    }
    if (options?.expectedSlot != null && worker.slot !== options.expectedSlot) {
      throw Object.assign(new Error(`ROUTE_SLOT_MISMATCH: Worker slot mismatch for account ${accId}`), { code: 'ROUTE_SLOT_MISMATCH' });
    }

    worker.busy = true;
    worker.state = 'borrowed';

    let released = false;
    const lease = {
      worker,
      session: worker.session,
      adapter: worker.adapter,
      route: worker.route,
      publish: async (opts = {}) => {
        if (this.fenced || this.closed) {
          throw Object.assign(new Error('Pool fenced during publish'), { code: 'POOL_FENCED' });
        }
        if (released) {
          throw Object.assign(new Error('Lease already released'), { code: 'LEASE_ALREADY_RELEASED' });
        }
        // Reject cross-account publish using this borrowed worker
        const targetAccId = opts?.targetAccountId || opts?.accountId || opts?.account?.id;
        if (targetAccId && String(targetAccId) !== String(worker.accountId)) {
          throw Object.assign(
            new Error(`ACCOUNT_WORKER_MISMATCH: Cannot publish for account ${targetAccId} using worker for account ${worker.accountId}`),
            { code: 'ACCOUNT_WORKER_MISMATCH' }
          );
        }
        return worker.adapter.publish({
          session: worker.session,
          ...opts
        });
      },
      release: async () => {
        if (released) return;
        released = true;
        worker.busy = false;
        if (worker.state === 'borrowed') {
          worker.state = 'idle';
        }
      }
    };

    return lease;
  }

  _scheduleCleanup(worker) {
    if (worker.cleanupTimer || this.workers.get(worker.accountId) !== worker) return;
    worker.cleanupTimer = setTimeout(() => {
      worker.cleanupTimer = null;
      // Failure remains owned/quarantined and drain schedules its next attempt.
      this.drain(worker.accountId).catch(() => {});
    }, this.cleanupRetryMs);
    worker.cleanupTimer.unref?.();
  }

  async drain(accountId) {
    const accId = String(accountId);
    if (this.draining.has(accId)) return this.draining.get(accId);

    const pendingOpen = this.pendingOpenTasks.get(accId);
    const existingWorker = this.workers.get(accId);
    if (!existingWorker && !pendingOpen) return;

    const drainPromise = Promise.resolve().then(async () => {
      if (pendingOpen) {
        try {
          await pendingOpen;
        } catch {}
      }
      const worker = this.workers.get(accId);
      if (worker) {
        await this._drainWorker(worker);
      }
    }).finally(() => {
      if (this.draining.get(accId) === drainPromise) {
        this.draining.delete(accId);
      }
    });

    this.draining.set(accId, drainPromise);
    return drainPromise;
  }

  async drainAll({ timeoutMs } = {}) {
    this.fenceAdmission();
    await Promise.allSettled(Array.from(this.pendingOpenTasks.values()));
    const drainTasks = Array.from(this.workers.keys()).map(id => this.drain(id));
    await Promise.all(drainTasks);
  }

  rearm({ drain = false, timeoutMs, signal = null } = {}) {
    if (signal?.aborted) {
      throw Object.assign(new Error('Pool rearm aborted'), { code: 'POOL_REARM_ABORTED' });
    }
    if (drain) {
      const closedBeforeDrain = this.closed;
      this.fenceAdmission();
      return this.drainAll({ timeoutMs }).then(() => {
        if (!closedBeforeDrain && this.closed) {
          throw Object.assign(new Error('Cannot rearm pool closed during drain'), { code: 'POOL_CLOSED' });
        }
        if (signal?.aborted) {
          throw Object.assign(new Error('Pool rearm aborted'), { code: 'POOL_REARM_ABORTED' });
        }
        return this.rearm({ drain: false, signal });
      });
    }
    if (this.workers.size > 0 || this.draining.size > 0 || this.pendingOpenTasks.size > 0) {
      throw Object.assign(
        new Error('Cannot rearm pool until all workers and pending tasks are fully drained'),
        { code: 'POOL_REARM_ACTIVE_SESSIONS' }
      );
    }
    this.fenced = false;
    this.closed = false;
    this.draining.clear();
    this.pendingOpenTasks.clear();
    this.preparations.clear();
    this.activeRunId = null;
    this.generation++;
    return true;
  }

  reopen(options) {
    return this.rearm(options);
  }

  async close({ timeoutMs } = {}) {
    this.fenced = true;
    this.closed = true;

    const budget = Number.isFinite(timeoutMs) ? Math.max(1, timeoutMs) : Math.max(30000, this.closeTimeoutMs);
    let timer;
    const cleanup = (async () => {
      await Promise.allSettled(Array.from(this.pendingOpenTasks.values()));
      const results = await Promise.allSettled(Array.from(this.workers.keys()).map(id => this.drain(id)));
      if (results.some(r => r.status === 'rejected') || this.workers.size || this.pendingOpenTasks.size) {
        throw Object.assign(new Error('Pool cleanup remains unverified'), { code: 'POOL_CLEANUP_PENDING' });
      }
    })();
    try {
      await Promise.race([cleanup, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('Pool cleanup deadline exceeded'), { code: 'POOL_CLEANUP_PENDING' })), budget);
      })]);
    } finally { clearTimeout(timer); }
  }
}

module.exports = {
  AccountWorkerPool,
  MAX_PROJECT_SESSIONS
};
