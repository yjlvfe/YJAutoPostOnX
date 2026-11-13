'use strict';
// Browserless, process-isolated X adapter. See python/README.md for the durable
// dispatch contract. Neither credentials nor remote exception bodies are logged.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { acquireSession } = require('./sessionGuard');
const { isDefinitiveXRejection } = require('./xFailureClassification');

const { randomUUID } = require('node:crypto');
const activeProcesses = new Set();
// A refused release still owns the reservation even when spawn never made a child.
const pendingLeaseCleanup = new Set();
async function releaseUnspawnedLease(lease, { cancelSpawn = false } = {}) {
  pendingLeaseCleanup.add(lease);
  const retry = async () => {
    let released = false;
    try {
      if (cancelSpawn) { await lease.cancelChildSpawn(); cancelSpawn = false; }
      released = await lease.release() === true;
    } catch {}
    if (released) pendingLeaseCleanup.delete(lease);
    else { const timer = setTimeout(retry, 100); timer.unref?.(); }
  };
  await retry();
}
function cleanupActiveProcesses() {
  for (const child of activeProcesses) {
    signalChild(child, 'SIGKILL');
  }
}
if (!global._directXCleanupHook) {
  global._directXCleanupHook = true;
  process.once('exit', cleanupActiveProcesses);
  process.on('SIGINT', () => { cleanupActiveProcesses(); if (process.listenerCount('SIGINT') <= 1) process.exit(130); });
  process.on('SIGTERM', () => { cleanupActiveProcesses(); if (process.listenerCount('SIGTERM') <= 1) process.exit(143); });
}

function signalChild(child, signal) {
  try {
    if (child._directXGroup && Number.isSafeInteger(child.pid) && child.pid > 1) process.kill(-child.pid, signal);
    else if (child.exitCode === null && child.signalCode == null && Number.isSafeInteger(child.pid) && child.pid > 1) child.kill(signal);
  } catch {}
}
function groupAlive(child) {
  if (!child._directXGroup || !child.pid) return false;
  try { process.kill(-child.pid, 0); } catch (err) { return err.code !== 'ESRCH'; }
  // Zombies cannot execute; unreadable process state fails shut.
  if (process.platform !== 'linux') return true;
  try {
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      let stat;
      try { stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8'); }
      catch (err) { if (err.code === 'ENOENT') continue; throw err; }
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      if (Number(fields[2]) === child.pid && !['Z', 'X', 'x'].includes(fields[0])) return true;
    }
    return false;
  } catch { return true; }
}

function extractTwidUserId(cookieFile) {
  try {
    const raw = fs.readFileSync(cookieFile, 'utf8');
    const m = raw.match(/["']?twid["']?\s*[:=]\s*["']?(?:u%3D|u=)(\d+)["']?/);
    return m ? m[1] : null;
  } catch { return null; }
}

function validateProxy(proxy) {
  if (typeof proxy !== 'string' || !/^socks5h:\/\/(127\.0\.0\.1|localhost):1880[1-5]$/.test(proxy)) {
    const error = new Error('An explicit per-account localhost SOCKS5h proxy is required');
    error.code = 'DIRECT_X_PROXY_REQUIRED';
    throw error;
  }
  return proxy;
}
const unsent = reason => ({ status: 'not_ready', published: false, posted: false, ambiguous: false, blocked: true, reason });
const ambiguous = reason => ({ status: 'ambiguous', published: false, posted: false, ambiguous: true, retryable: false, reason });
const handle = value => typeof value === 'string' && /^@?[A-Za-z0-9_]{1,15}$/.test(value) ? value.replace(/^@/, '').toLowerCase() : null;
const expected = account => handle(account?.username || account?.handle || account?.expectedUsername || account?.identity);
const numericId = value => typeof value === 'string' && /^\d+$/.test(value);
const validIdentity = identity => identity?.authenticated === true &&
  (identity?.state === 'authenticated' || identity?.state === 'ready_local') &&
  !identity?.accountFailure && !identity?.suspended && !identity?.banned && !identity?.challenge &&
  !identity?.locked && !identity?.captcha && !identity?.restricted && handle(identity.username) && numericId(identity.userId);
const readDiagnostic = value => ({
  phase: ['user_state', 'settings', 'verify_credentials', 'profile'].includes(value?.phase) ? value.phase : 'bridge',
  httpStatus: Number.isInteger(value?.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599 ? value.httpStatus : null,
  ...(Number.isFinite(value?.retryAfterSeconds) && value.retryAfterSeconds >= 0 ? { retryAfterSeconds: Math.min(900, Math.max(60, value.retryAfterSeconds)) } : {})
});


function defaultPythonExecutable() {
  if (process.env.DIRECT_X_PYTHON) return process.env.DIRECT_X_PYTHON;
  const venvPython = path.resolve(__dirname, '../.venv-direct-x/bin/python');
  try {
    fs.accessSync(venvPython, fs.constants.X_OK);
    return venvPython;
  } catch {
    // A system interpreter may have unrelated/unpinned dependencies. Keep
    // explicit injection for tests/operators, but never silently downgrade.
    throw Object.assign(new Error('Pinned Direct X Python is unavailable; install .venv-direct-x or set DIRECT_X_PYTHON explicitly'), { code: 'DIRECT_X_PYTHON_REQUIRED' });
  }
}


class DirectXAdapter {
  constructor({ pythonExecutable = defaultPythonExecutable(), allowPublish = false,
    openTimeoutMs = 30_000, publishTimeoutMs = 100_000, onDispatch, sessionGuardRegistry = null, spawnProcess = spawn } = {}) {
    this.pythonExecutable = pythonExecutable;
    this.allowPublish = allowPublish === true;
    this.openTimeoutMs = checkedTimeout(openTimeoutMs);
    this.publishTimeoutMs = checkedTimeout(publishTimeoutMs);
    this.onDispatch = onDispatch;
    this.sessionGuardRegistry = sessionGuardRegistry;
    if (typeof spawnProcess !== 'function') throw new TypeError('spawnProcess must be callable');
    this.spawnProcess = spawnProcess;
    this.sessions = new WeakMap();
  }

  async open({ account, accountRecord, proxy, signal } = {}) {
    validateProxy(proxy);
    const selected = accountRecord || account;
    if (!selected || typeof selected !== 'object' || !selected.id || !(selected.cookieFile || selected.cookiePath)) {
      throw Object.assign(new Error('Account id and cookie file are required'), { code: 'DIRECT_X_ACCOUNT_REQUIRED' });
    }
    const configured = selected.username || selected.handle || selected.expectedUsername || selected.identity;
    if ((configured && !handle(configured)) || (selected.userId != null && (typeof selected.userId !== 'string' || !/^\d+$/.test(selected.userId)))) {
      throw Object.assign(new Error('Configured account identity is invalid'), { code: 'DIRECT_X_AUTH_IDENTITY_INVALID' });
    }
    if (signal?.aborted) throw Object.assign(new Error('Open cancelled'), { code: 'DIRECT_X_STOPPED' });
    const lease = await acquireSession({ accountId: selected.id, ...(this.sessionGuardRegistry ? { registry: this.sessionGuardRegistry } : {}) });
    const session = { accountId: String(selected.id), identity: null, closed: false, dead: false, poisoned: false, poisonReason: null, state: 'opening' };
    let child;
    let state;
    let spawnPrepared = false;
    try {
      await lease.prepareChildSpawn();
      spawnPrepared = true;
      if (signal?.aborted) throw Object.assign(new Error('Open cancelled'), { code: 'DIRECT_X_STOPPED' });
      // Private process group: cancellation covers inherited descendants too.
      child = this.spawnProcess(this.pythonExecutable, ['-I', '-u', path.resolve(__dirname, '../python/direct_x_bridge.py')], {
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1', ...(process.env.DIRECT_X_TIMELINE_VERIFY_SECONDS ? { DIRECT_X_TIMELINE_VERIFY_SECONDS: process.env.DIRECT_X_TIMELINE_VERIFY_SECONDS } : {}) },
      });
      // Own lifecycle before awaiting binding: exit/error may arrive during it.
      let resolveExited;
      const exited = new Promise(resolve => { resolveExited = resolve; });
      state = { session, child, exited, buffer: '', pending: null, dead: false, usedRequestIds: new Set(), activeRequest: null, busy: false, poisoned: false, poisonReason: null, identity: null, receipt: null, lease, released: false };
      this.sessions.set(session, state);
      activeProcesses.add(child);
      child._directXGroup = process.platform !== 'win32' && Boolean(child.pid);
      let releaseInFlight = false;
      let releaseAttempts = 0;
      const releaseWhenEnded = async () => {
        if (state.released || releaseInFlight) return;
        releaseInFlight = true;
        if (groupAlive(child)) {
          releaseInFlight = false;
          signalChild(child, 'SIGKILL');
          const timer = setTimeout(releaseWhenEnded, 25);
          timer.unref?.();
          return;
        }
        let released=false;
        try {
          // ChildProcess with no PID is an authoritative never-spawned outcome.
          // Any returned PID/bind ambiguity stays quarantined; never cancel it.
          if (!child.pid) await lease.cancelChildSpawn();
          released = await lease.release() === true;
        } catch {}
        releaseInFlight = false;
        if(!released){
          // Bounded caller close fails shut; retain cleanup ownership and slot.
          const delayMs = releaseAttempts < 5 ? 100 : Math.min(2000, 100 * Math.pow(2, Math.min(5, releaseAttempts - 4)));
          releaseAttempts++;
          const timer=setTimeout(releaseWhenEnded,delayMs);timer.unref?.();return;
        }
        state.released = true;
        activeProcesses.delete(child);
        resolveExited();
      };
      child.once('close', () => { this._failed(state); releaseWhenEnded(); });
      child.on('error', () => this._failed(state));
      // Exit precedes stdio close; buffered final protocol output still belongs
      // to the pending command. Its existing deadline bounds a missing close.
      child.on('exit', () => { state.processExited = true; });
      child.stderr.on('data', () => {});
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on('error', () => this._failed(state));
      child.stdout.on('end', () => this._failed(state));
      child.stdout.on('data', chunk => {
        state.buffer += chunk.toString('utf8');
        let index;
        while ((index = state.buffer.indexOf('\n')) >= 0) {
          if (index > 1_048_576) return this._failed(state);
          const line = state.buffer.slice(0, index);
          state.buffer = state.buffer.slice(index + 1);
          const trimmed = line.trim();
          if (!trimmed) continue;
          try { this._message(state, JSON.parse(trimmed)); } catch { this._failed(state); }
          if (state.dead) return;
        }
        if (state.buffer.length > 1_048_576) this._failed(state);
      });
      let bindTimer;
      try {
        const binding = typeof lease.bindChildProcess === 'function' ? lease.bindChildProcess(child.pid) : lease.bindChild?.(child.pid);
        const bindingPromise = Promise.resolve(binding);
        bindingPromise.catch(() => {});
        await Promise.race([bindingPromise, new Promise((_, reject) => {
          bindTimer = setTimeout(() => reject(Object.assign(new Error('Child binding timed out'), { code: 'DIRECT_X_BIND_TIMEOUT' })), this.openTimeoutMs);
          bindTimer.unref?.();
        })]);
      } finally { clearTimeout(bindTimer); }
      lease.pid = child.pid;
    } catch (spawnError) {
      if (state) {
        this._failed(state);
        try {
          await this.close({ session, timeoutMs: 700 });
        } catch (closeError) {
          if (closeError && closeError.code === 'DIRECT_X_CLEANUP_UNVERIFIED') {
            closeError.session = session;
            closeError.cause = spawnError;
          }
          throw closeError;
        }
      } else await releaseUnspawnedLease(lease, { cancelSpawn: spawnPrepared });
      throw spawnError;
    }
    try {
      const resolvedCookie = path.resolve(String(selected.cookieFile || selected.cookiePath));
      const effectiveUserId = selected.userId || extractTwidUserId(resolvedCookie);
      const slotMatch = proxy.match(/:1880([1-5])$/);
      const slot = selected.slot != null && Number.isInteger(Number(selected.slot))
        ? Number(selected.slot)
        : (slotMatch ? Number(slotMatch[1]) : 1);
      const mode = selected.verifyNetwork ? 'check' : 'publish';
      const result = await this._command(state, {
        op: 'open',
        slot,
        mode,
        account: {
          id: String(selected.id),
          username: expected(selected),
          userId: effectiveUserId,
          cookieFile: resolvedCookie,
          use_cache: Boolean(effectiveUserId && !selected.verifyNetwork),
          slot
        },
        proxy
      }, { timeout: this.openTimeoutMs, signal });
      const identity = result.identity;
      const receipt = result.receipt || identity?.receipt || null;
      const isAccountFailed = Boolean(result.accountFailure || identity?.accountFailure || identity?.state === 'suspended' || identity?.state === 'blocked');
      if (!isAccountFailed && validIdentity(identity) && (!expected(selected) || expected(selected) === handle(identity.username)) &&
          (!selected.userId || selected.userId === identity.userId)) {
        state.identity = Object.freeze({ ...identity, username: handle(identity.username) });
        state.receipt = receipt ? Object.freeze({ ...receipt }) : null;
        session.identity = { ...state.identity };
        session.receipt = state.receipt;
        session.state = 'authenticated';
      } else {
        session.identity = { state: 'identity_unverified', authenticated: false, accountFailure: result.accountFailure || identity?.accountFailure, reason: result.reason || identity?.reason || (isAccountFailed ? 'account_suspended_or_failed' : 'identity_unverified'), readDiagnostic: readDiagnostic(result.readDiagnostic), retryable: result.retryable === true && result.reason === 'identity_read_unavailable' && !result.accountFailure && !identity?.accountFailure };
        session.state = 'blocked';
      }
    } catch (error) {
      try {
        await this.close({ session });
      } catch (closeError) {
        if (closeError && closeError.code === 'DIRECT_X_CLEANUP_UNVERIFIED') {
          closeError.session = session;
          closeError.cause = error;
          throw closeError;
        }
        throw error;
      }
      throw Object.assign(new Error('Direct X session could not be verified'), { code: signal?.aborted ? 'DIRECT_X_STOPPED' : 'DIRECT_X_IDENTITY_READ_UNAVAILABLE', causeCode: error?.code || 'BRIDGE_PROTOCOL_UNAVAILABLE' });
    }
    if (session.state === 'blocked') {
      try {
        await this.close({ session });
      } catch (closeError) {
        if (closeError && closeError.code === 'DIRECT_X_CLEANUP_UNVERIFIED') {
          closeError.session = session;
        }
        throw closeError;
      }
    }
    return session;
  }

  async verifyPublishedTweet({ account, proxy, tweetId, expectedText, signal, timeoutMs = 25000 } = {}) {
    if (!account || !proxy || !tweetId) {
      return { verified: false, reason: 'verifier_unavailable' };
    }
    let session = null;
    try {
      session = await this.open({ account: { ...account, verifyNetwork: true }, proxy, signal });
      const state = this.sessions.get(session);
      if (!state || state.dead || session.closed || session.state !== 'authenticated' || !validIdentity(state.identity)) {
        return {
          verified: false,
          tweetId: null,
          userId: session?.identity?.userId || null,
          username: session?.identity?.username || null,
          url: null,
          reason: session?.identity?.accountFailure || session?.identity?.reason || 'auth_session_unverified'
        };
      }
      const res = await this._command(
        state,
        { op: 'verify_tweet_by_id', tweetId: String(tweetId), expectedText },
        { timeout: checkedTimeout(timeoutMs), signal }
      );
      return {
        verified: Boolean(res && res.verified),
        tweetId: res?.tweetId || null,
        userId: res?.userId || null,
        username: res?.username || null,
        url: res?.url || null,
        reason: res?.reason || null
      };
    } catch (err) {
      return {
        verified: false,
        tweetId: null,
        userId: null,
        username: null,
        url: null,
        reason: err?.code || err?.message || 'lookup_failed'
      };
    } finally {
      await this.close({ session });
    }
  }

  async verifyAccount({ account, proxy, signal } = {}) {
    const selected = account;
    if (!selected || typeof selected !== 'object' || !selected.id) {
      throw Object.assign(new Error('Account required for verification'), { code: 'DIRECT_X_ACCOUNT_REQUIRED' });
    }
    const effectiveProxy = proxy || selected.proxy;
    validateProxy(effectiveProxy);

    let session = null;
    try {
      session = await this.open({ account: { ...selected, verifyNetwork: true }, proxy: effectiveProxy, signal });
      const identity = session?.identity;
      const isAuthenticated = session?.state === 'authenticated' && identity?.authenticated === true;
      const expectedUsername = handle(selected.username || selected.handle);
      const actualUsername = handle(identity?.username);
      const usernameMatch = !expectedUsername || (actualUsername && actualUsername === expectedUsername);
      const expectedUserId = selected.userId ? String(selected.userId) : null;
      const actualUserId = identity?.userId ? String(identity.userId) : null;
      const userIdMatch = !expectedUserId || (actualUserId && actualUserId === expectedUserId);
      const flagsClear = !identity?.challenge && !identity?.locked && !identity?.captcha &&
                         !identity?.suspended && !identity?.banned && !identity?.accountFailure;

      const verified = Boolean(isAuthenticated && usernameMatch && userIdMatch && flagsClear);
      return {
        verified,
        authenticated: Boolean(isAuthenticated),
        username: actualUsername || null,
        userId: actualUserId || null,
        challenge: Boolean(identity?.challenge),
        locked: Boolean(identity?.locked),
        captcha: Boolean(identity?.captcha || identity?.accountFailure === 'captcha'),
        suspended: Boolean(identity?.suspended || identity?.banned || identity?.accountFailure === 'banned'),
        accountFailure: identity?.accountFailure || null,
        retryable: identity?.retryable === true,
        transientError: identity?.retryable === true && !identity?.accountFailure,
        readDiagnostic: identity?.readDiagnostic,
        reason: verified ? null : (identity?.accountFailure || identity?.reason || (!usernameMatch || !userIdMatch ? 'identity_mismatch' : 'verification_failed'))
      };
    } catch (err) {
      if(err?.code === 'DIRECT_X_CLEANUP_UNVERIFIED')throw err;
      return {
        verified: false,
        authenticated: false,
        challenge: false,
        locked: false,
        captcha: err.code === 'DIRECT_X_CAPTCHA' || err.accountFailure === 'captcha',
        suspended: err.code === 'DIRECT_X_BANNED' || err.accountFailure === 'banned',
        accountFailure: ['banned','captcha','cookie_expired','auth_rejected','auth_session_unverified'].includes(err.accountFailure) ? err.accountFailure : null,
        transientError: !err.accountFailure, errorCode: err.code || 'BRIDGE_UNAVAILABLE',
        reason: err.code || 'verification_failed'
      };
    } finally {
      if (session) {
        await this.close({ session });
      }
    }
  }

  async publish({ session, payload = {}, confirmPublish = false, signal, onDispatch, requestId } = {}) {
    const state = this.sessions.get(session);
    if (state?.dispatchAttempted && state.dead) return ambiguous('dispatch_already_attempted');
    if (!state || state.dead || session?.closed || !validIdentity(state.identity)) return unsent('auth_session_unverified');
    if (state.poisoned) return unsent(state.poisonReason || 'worker_poisoned');

    const reqId = typeof requestId === 'string' && requestId.trim() ? requestId.trim() : randomUUID();
    state.usedRequestIds ||= new Set();
    if (state.usedRequestIds.has(reqId)) return ambiguous('dispatch_already_attempted');

    if (state.busy) return unsent('auth_session_busy');
    if (signal?.aborted) return unsent('stopped');
    const text = payload.text ?? payload.content ?? payload.body;
    if (typeof text !== 'string' || !text.trim()) return unsent('invalid_text');
    if (Object.keys(payload).some(key => !['text', 'content', 'body'].includes(key) && !(key === 'media' && (payload.media == null || String(payload.media).trim() === '')))) return unsent('unsupported_payload');
    if (!(this.allowPublish && confirmPublish === true)) return { status: 'dry_run', ready: true, published: false, posted: false };
    const callback = onDispatch || this.onDispatch;
    if (typeof callback !== 'function') return unsent('durable_dispatch_callback_required');
    state.busy = true;
    const requestContext = {
      requestId: reqId,
      op: 'publish',
      dispatch: false,
      acknowledged: false,
      used: false,
      finished: false,
      settledResult: null
    };
    state.activeRequest = requestContext;
    try {
      const result = await this._command(state, { op: 'publish', text }, {
        timeout: this.publishTimeoutMs, signal, callback, accountId: session.accountId,
        requestId: reqId, requestContext
      });
      requestContext.settledResult = result;
      if (result.status !== 'published') {
        if (requestContext.used && isDefinitiveXRejection(result)) {
          return { ...result, retryable: false };
        }
        if (result.rateLimit === true || result.status === 'rate_limit') {
          if (requestContext.used || result.ambiguous) {
            this._markPoisoned(state, result.reason || 'rate_limit');
            return {
              ...ambiguous(result.reason || 'rate_limit'),
              rateLimit: true,
              retryable: false,
              accountFailure: result.accountFailure || 'rate_limit',
              retryAfterSeconds: result.retryAfterSeconds || 60,
              rawError: result.rawError,
              xErrorCode: result.xErrorCode,
              xErrorMessage: result.xErrorMessage,
              xResponseKind: result.xResponseKind,
              verificationError: result.verificationError,
              httpStatus: result.httpStatus,
            transactionDegraded: typeof result.transactionDegraded === 'boolean' ? result.transactionDegraded : null,
            };
          }
          return {
            status: 'rate_limit',
            published: false,
            posted: false,
            rateLimit: true,
            ambiguous: false,
            retryable: true,
            accountFailure: 'rate_limit',
            retryAfterSeconds: result.retryAfterSeconds || 60,
            reason: result.reason || 'rate_limit',
            rawError: result.rawError,
            xErrorCode: result.xErrorCode,
            xErrorMessage: result.xErrorMessage,
            xResponseKind: result.xResponseKind,
            verificationError: result.verificationError,
            httpStatus: result.httpStatus,
            transactionDegraded: typeof result.transactionDegraded === 'boolean' ? result.transactionDegraded : null,
          };
        }
        if (requestContext.used || result.ambiguous) {
          this._markPoisoned(state, result.reason || 'publish_ambiguous');
          return {
            ...ambiguous(result.reason || 'publish_unverified'),
            retryable: false,
            accountFailure: result.accountFailure,
            rejectionReason: result.rejectionReason || null,
            retryAfterSeconds: result.retryAfterSeconds,
            rawError: result.rawError,
            xErrorCode: result.xErrorCode,
            fetchError: result.fetchError,
            xResponseKind: result.xResponseKind,
            xErrorMessage: result.xErrorMessage,
            httpStatus: result.httpStatus,
            transactionDegraded: typeof result.transactionDegraded === 'boolean' ? result.transactionDegraded : null,
            verificationError: result.verificationError,
            timelineChecks: Number.isInteger(result.timelineChecks) ? result.timelineChecks : 0
          };
        }
        if (result.reason === 'worker_poisoned') {
          this._markPoisoned(state, 'worker_poisoned');
        }
        return {
          ...unsent(result.reason || (result.rateLimit ? 'rate_limit' : 'auth_pre_dispatch_failed')),
          accountFailure: result.accountFailure || (result.rateLimit ? 'rate_limit' : undefined),
          rawError: result.rawError,
          xErrorCode: result.xErrorCode,
          fetchError: result.fetchError,
          xResponseKind: result.xResponseKind,
          xErrorMessage: result.xErrorMessage,
          httpStatus: result.httpStatus,
            transactionDegraded: typeof result.transactionDegraded === 'boolean' ? result.transactionDegraded : null,
          verificationError: result.verificationError,
          rateLimit: Boolean(result.rateLimit),
          retryAfterSeconds: result.retryAfterSeconds,
          readDiagnostic: readDiagnostic(result.readDiagnostic),
          retryable: result.retryable === true && result.reason === 'identity_read_unavailable' && !result.accountFailure
        };
      }
      if (!requestContext.used || !numericId(result.tweetId) || result.userId !== state.identity.userId || handle(result.username) !== state.identity.username) {
        this._markPoisoned(state, 'publish_author_or_id_unverified');
        return {
          ...ambiguous('publish_author_or_id_unverified'),
          accountFailure: result.accountFailure || null,
          xErrorCode: result.xErrorCode ?? null,
          xErrorMessage: result.xErrorMessage || null,
          xResponseKind: result.xResponseKind || null,
          httpStatus: Number.isInteger(result.httpStatus) ? result.httpStatus : null,
          transactionDegraded: typeof result.transactionDegraded === 'boolean' ? result.transactionDegraded : null,
        };
      }
      return {
        status: 'published',
        published: true,
        posted: true,
        tweetId: result.tweetId,
        username: state.identity.username,
        userId: state.identity.userId,
        url: result.tweetUrl || result.url || `https://x.com/${state.identity.username}/status/${result.tweetId}`,
        recoveredFromTimeline: Boolean(result.recoveredFromTimeline || result.recovered_from_timeline),
        accountFailure: result.accountFailure || null,
        xErrorCode: result.xErrorCode ?? null,
        xErrorMessage: result.xErrorMessage || null,
        ok: true
      };
    } catch (err) {
      if (requestContext.used) {
        this._markPoisoned(state, 'publish_confirmation_missing');
        return { ...ambiguous('publish_confirmation_missing'), retryable: false, rawError: err?.message };
      }
      return signal?.aborted ? unsent('stopped') : { ...unsent('identity_read_unavailable'), retryable: true, rawError: err?.message };
    } finally {
      requestContext.finished = true;
      if (state.activeRequest === requestContext) state.activeRequest = null;
      state.busy = false;
    }
  }

  _command(state, command, { timeout, signal, callback, accountId, requestId, requestContext }) {
    if (state.dead || state.pending) return Promise.reject(new Error('Bridge unavailable'));
    return new Promise((resolve, reject) => {
      const cmdRequestId = requestId || command.requestId || randomUUID();
      const pending = {
        requestId: cmdRequestId,
        op: command.op,
        resolve: value => { cleanup(); resolve(value); },
        reject: err => { cleanup(); reject(err || new Error('Bridge unavailable')); },
        callback,
        accountId,
        dispatch: false,
        acknowledged: false,
        requestContext
      };
      let timer = null;
      const stop = () => {
        if (pending.dispatch || requestContext?.dispatch) {
          this._markPoisoned(state, 'post_dispatch_timeout');
          return pending.reject(new Error('Post dispatch timeout'));
        }
        this._failed(state);
      };
      const onAbort = () => {
        if (pending.dispatch || requestContext?.dispatch) {
          return;
        }
        stop();
      };
      timer = setTimeout(stop, timeout);
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (state.pending === pending) state.pending = null;
      };
      state.pending = pending;
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted && !pending.dispatch) return stop();
      try {
        state.child.stdin.write(JSON.stringify({ ...command, requestId: pending.requestId }) + '\n');
      } catch {
        stop();
      }
    });
  }

  _message(state, message) {
    const pending = state.pending;
    if (!pending || state.dead) return this._failed(state);
    if (!message || typeof message !== 'object' || Array.isArray(message)) return this._failed(state);
    const msgOp = message.op || message.operation;
    if (typeof message.requestId !== 'string' || !message.requestId || message.requestId !== pending.requestId || msgOp !== pending.op) {
      return this._failed(state);
    }
    if (message.event === 'dispatch_ready') {
      if (pending.op !== 'publish' || pending.dispatch || !pending.callback) return this._failed(state);
      pending.dispatch = true;
      state.dispatchAttempted = true;
      if (pending.requestContext) {
        pending.requestContext.dispatch = true;
        pending.requestContext.used = true;
      }
      state.usedRequestIds.add(pending.requestId);
      Promise.resolve().then(() => {
        if (state.pending !== pending || state.dead) return false;
        return pending.callback({ accountId: pending.accountId, requestId: pending.requestId });
      }).then(ack => {
        if (state.pending !== pending || state.dead) return;
        if (ack !== true) return this._failed(state);
        pending.acknowledged = true;
        if (pending.requestContext) pending.requestContext.acknowledged = true;
        try {
          state.child.stdin.write(JSON.stringify({ op: 'dispatch_ack', operation: pending.op, requestId: pending.requestId }) + '\n');
        } catch {
          this._failed(state);
        }
      }, () => this._failed(state));
    } else if (message.event === 'result') {
      const result = message.result;
      if (!result || typeof result !== 'object' || Array.isArray(result)) return this._failed(state);
      if (result.status === 'published' && !pending.acknowledged) {
        pending.resolve({ ...result, status: 'ambiguous', published: false, posted: false,
          ambiguous: true, reason: 'dispatch_ack_missing' });
      } else pending.resolve(result);
    } else this._failed(state);
  }

  _markPoisoned(state, reason = 'worker_poisoned') {
    const poisonReason = reason || 'worker_poisoned';
    state.poisoned = true;
    state.poisonReason = poisonReason;
    if (state.session) {
      state.session.poisoned = true;
      state.session.poisonReason = poisonReason;
    }
  }

  _failed(state) {
    if (state.dead) return;
    state.dead = true;
    if (state.session) state.session.dead = true;
    state.buffer = '';
    try { state.child.stdout?.destroy(); } catch {}
    try { state.child.stderr?.destroy(); } catch {}
    try { state.child.stdin?.destroy(); } catch {}
    signalChild(state.child, 'SIGKILL');
    state.pending?.reject();
  }

  async close({ session, timeoutMs = 3000 } = {}) {
    if (!session) return;
    session.closed = true;
    const state = this.sessions.get(session);
    if (state) {
      if (state.activeRequest && (state.activeRequest.dispatch || state.activeRequest.used) && !state.activeRequest.finished) {
        const drainLimitMs = Math.min(60_000, Math.max(500, Number.isFinite(timeoutMs) ? timeoutMs : 3000));
        let drainTimer;
        try {
          await Promise.race([
            new Promise(resolve => {
              const check = () => {
                if (!state.activeRequest || state.activeRequest.finished || state.dead) return resolve();
                setTimeout(check, 10).unref?.();
              };
              check();
            }),
            new Promise(resolve => { drainTimer = setTimeout(resolve, drainLimitMs); })
          ]);
        } finally {
          if (drainTimer) clearTimeout(drainTimer);
        }
      }

      const hardTimeoutMs = Math.min(300_000, Math.max(700, Number.isFinite(timeoutMs) ? timeoutMs : 3000));
      let forceTimer = null;
      let hardTimer = null;
      try {
        if (!state.dead) {
          state.dead = true;
          if (state.session) state.session.dead = true;
          state.pending?.reject();
          try {
            state.child.stdin?.write(JSON.stringify({ op: 'close', requestId: randomUUID() }) + '\n');
          } catch {}
          try {
            state.child.stdin?.end();
            signalChild(state.child, 'SIGTERM');
          } catch {}
          forceTimer = setTimeout(() => {
            signalChild(state.child, 'SIGKILL');
          }, 500);
          forceTimer.unref?.();
        }
        const timedOut = await Promise.race([
          state.exited.then(() => false),
          new Promise(resolve => {
            hardTimer = setTimeout(() => resolve(true), hardTimeoutMs);
            // Keep bounded close alive after stdio destruction.
          })
        ]);
        if (timedOut) {
          signalChild(state.child, 'SIGKILL');
          throw Object.assign(new Error('Direct X child termination is unverified'), { code: 'DIRECT_X_CLEANUP_UNVERIFIED' });
        }
        this.sessions.delete(session);
      } finally {
        if (forceTimer) clearTimeout(forceTimer);
        if (hardTimer) clearTimeout(hardTimer);
        try { state.child.stdin?.destroy(); } catch {}
        try { state.child.stdout?.destroy(); } catch {}
        try { state.child.stderr?.destroy(); } catch {}
        // Only the pre-installed close/group watcher releases ownership.
        // Timeout or successful signal is not proof of termination.
      }
    }
  }
}
function checkedTimeout(value) {
  if (!Number.isFinite(value) || value < 1 || value > 300_000) throw new TypeError('Invalid direct X timeout');
  return value;
}
module.exports = { DirectXAdapter, validateProxy };
