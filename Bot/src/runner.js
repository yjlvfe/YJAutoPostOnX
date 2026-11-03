'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createTelegramApi } = require('./telegramApi');
const { config } = require('./env');
const { createBot } = require('./index');
const { projectStatus } = require('./status');
const { isDue, riyadhDateParts } = require('./scheduling');
const { TelegramUi } = require('./telegramUi');
const { createLinkExports } = require('./linkExports');
const { DirectXAdapter } = require('./directX');
const { VpnSlotManager } = require('./dockerVpn');
const { riyadhDay, accountCapacity, quotaAdmission } = require('./quota');
const { normalizeSubnet } = require('./forensicLogger');
const { logStructured, sanitizeError, extractErrorCode } = require('./structuredLogger');
const { isKnownTwikitParserFailure } = require('./knownTwikitParserFailure');
const { recordUnsuccessfulAttempt } = require('./attemptOutcomes');
const { classifyPublishOutcome } = require('./publishOutcome');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class SingleInstanceLock {
  constructor(lockPath, { timeoutMs = 15_000, retryMs = 50, staleMs = 120_000 } = {}) {
    this.lockPath = path.resolve(lockPath);
    this.timeoutMs = timeoutMs;
    this.retryMs = retryMs;
    this.staleMs = staleMs;
    this.token = null;
    this.lastHolderPid = null;
  }

  get locked() { return Boolean(this.token); }

  async acquire() {
    await fs.mkdir(path.dirname(this.lockPath), { recursive: true });
    const deadline = Date.now() + this.timeoutMs;
    const token = crypto.randomUUID();
    while (true) {
      try {
        const handle = await fs.open(this.lockPath, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, token, acquiredAt: new Date().toISOString() }) + '\n');
        await handle.close();
        this.token = token;
        return async () => this.release(token);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (await this.recoverStale()) continue;
        if (Date.now() >= deadline) {
          let holderPid = this.lastHolderPid;
          try {
            const current = JSON.parse(await fs.readFile(this.lockPath, 'utf8'));
            if (Number.isInteger(current?.pid) && current.pid > 0) holderPid = current.pid;
          } catch (err) {
            logStructured(null, { level: 'warn', component: 'single_instance_lock', event: 'lock_read_parse_failed', operation: 'readFile', result: 'failed', errorCode: extractErrorCode(err), sanitizedError: sanitizeError(err), suppressionReason: 'corrupt_lock_payload' });
          }
          const msg = holderPid
            ? `Telegram runner lock is held by PID ${holderPid}: ${this.lockPath}`
            : `Telegram runner lock is held: ${this.lockPath}`;
          const locked = new Error(msg);
          locked.code = 'INSTANCE_LOCKED';
          if (holderPid) locked.pid = holderPid;
          throw locked;
        }
        await sleep(Math.min(this.retryMs, Math.max(1, deadline - Date.now())));
      }
    }
  }

  async recoverStale() {
    let stat;
    try { stat = await fs.stat(this.lockPath); } catch (error) { return error.code === 'ENOENT'; }
    let record;
    try { record = JSON.parse(await fs.readFile(this.lockPath, 'utf8')); } catch (err) {
      logStructured(null, { level: 'warn', component: 'single_instance_lock', event: 'stale_lock_parse_failed', operation: 'recoverStale.parse', result: 'failed', errorCode: extractErrorCode(err), sanitizedError: sanitizeError(err) });
      record = null;
    }
    let dead = false;
    if (Number.isInteger(record?.pid) && record.pid > 0) {
      try { process.kill(record.pid, 0); } catch (error) { dead = error.code === 'ESRCH'; }
      // A long-lived polling service is not stale just because its lock is old.
      if (!dead) {
        this.lastHolderPid = record.pid;
        return false;
      }
    }
    if (!(dead || (!record && Date.now() - stat.mtimeMs >= this.staleMs))) return false;
    // Atomic recovery: rename to an isolated stale path first to eliminate race conditions
    const stalePath = `${this.lockPath}.stale.${crypto.randomUUID()}`;
    try {
      await fs.rename(this.lockPath, stalePath);
    } catch (error) {
      return error.code === 'ENOENT';
    }
    try {
      if (record?.token) {
        try {
          const moved = JSON.parse(await fs.readFile(stalePath, 'utf8'));
          if (moved.token !== record.token) {
            await fs.rename(stalePath, this.lockPath).catch(err => {
              logStructured(null, { level: 'error', component: 'single_instance_lock', event: 'stale_lock_restore_failed', operation: 'recoverStale.restore', result: 'failed', errorCode: extractErrorCode(err), sanitizedError: sanitizeError(err) });
            });
            return false;
          }
        } catch (err) {
          logStructured(null, { level: 'warn', component: 'single_instance_lock', event: 'stale_lock_token_read_failed', operation: 'recoverStale.verifyToken', result: 'failed', errorCode: extractErrorCode(err), sanitizedError: sanitizeError(err) });
        }
      }
      await fs.unlink(stalePath);
      return true;
    } catch (error) {
      return error.code === 'ENOENT';
    }
  }

  async release(token = this.token) {
    if (!token || token !== this.token) return false;
    this.token = null;
    try {
      const record = JSON.parse(await fs.readFile(this.lockPath, 'utf8'));
      if (record.token !== token) return false;
      await fs.unlink(this.lockPath);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }
}

function updateId(update) {
  return Number.isSafeInteger(update?.update_id) ? update.update_id : null;
}

/**
 * Claim a cycle item and consume no external resource until the claim wins.
 * Quota and cycle checks live in the same durable update as the processing
 * transition, so a quota boundary cannot trigger VPN/browser work.
 */
async function claimCycleItem({ store, itemId, accountId, runId, signal, clock = () => new Date() }) {
  const result = { claimed: false, reason: 'item_unavailable', token: crypto.randomUUID() };
  await store.update(state => {
    if (signal?.aborted) { result.reason = 'aborted'; return state; }
    if (state.cycle?.state !== 'running' || state.cycle.runId !== runId) { result.reason = 'cycle_stopped'; return state; }
    const item = (state.items || []).find(entry => entry.id === itemId);
    if (!item || item.state !== 'pending') return state;
    const account = (state.accounts || []).find(entry => entry.id === accountId && entry.enabled !== false);
    if (!account) { result.reason = 'account_unavailable'; return state; }
    if (item.payload?.account && item.payload.account !== accountId) return state;
    if (accountCapacity(state, account, clock()).remaining <= 0) { result.reason = 'quota_exhausted'; return state; }
    item.state = 'processing';
    item.claimedAt = new Date(clock()).toISOString();
    state.posting ||= {}; state.posting.publishingAt = item.claimedAt; state.posting.nextPostAt = null;
    item.attempt = { phase: 'claimed', token: result.token, runId: state.cycle.runId, accountId, startedAt: item.claimedAt };
    const run = state.telegramUi?.run;
    if (run?.runId === state.cycle.runId && !item.payload?.account && run.accountIds?.includes(accountId)) run.cursor = (run.accountIds.indexOf(accountId) + 1) % run.accountIds.length;
    result.claimed = true;
    result.reason = null;
    return state;
  });
  return result;
}

async function stopCycleForQuota({ store, runId, clock = () => new Date() }) {
  await store.update(state => {
    if (state.cycle?.state === 'running' && (!runId || state.cycle.runId === runId)) {
      state.telegramUi ||= {};
      if (state.telegramUi.run) state.telegramUi.pendingReport = { ...structuredClone(state.telegramUi.run), endedAt: new Date(clock()).toISOString() };
      state.cycle = {
        ...state.cycle,
        state: 'stopped',
        runId: null,
        reason: 'daily_quota_exhausted',
        updatedAt: new Date(clock()).toISOString()
      };
    }
    return state;
  });
}

function selectAccount(state, run, item, now = new Date(), excluded = new Set()) {
  const ids = run.accountIds || [];
  const available = id => {
    const account = (state.accounts || []).find(a => a.id === id && a.enabled !== false);
    if (!account || excluded.has(id)) return false;
    if (['محظور', 'كابتشا', 'معزول (3 إخفاقات)'].includes(account.status) || (account.failures || 0) >= 3) return false;
    return accountCapacity(state, account, now).remaining > 0;
  };
  if (item.payload?.account) return ids.includes(item.payload.account) && available(item.payload.account) ? item.payload.account : null;
  const cursor = state.telegramUi?.run?.cursor || 0;
  for (let n = 0; n < ids.length; n++) {
    const id = ids[(cursor + n) % ids.length];
    if (available(id)) return id;
  }
  return null;
}

// A single deadline covers VPN, adapter open/publish AND close. Racing a
// non-cooperative dependency never authorizes late dispatch; the signal and
// exact durable attempt fence are checked again by onDispatch.
function attemptScope(parentSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  const timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
  parentSignal?.addEventListener('abort', abort, { once: true });
  if (parentSignal?.aborted) abort();
  const error = () => Object.assign(new Error('Attempt ended'), { code: timedOut ? 'ATTEMPT_TIMEOUT' : 'ATTEMPT_ABORTED' });
  return {
    signal: controller.signal,
    async wait(work) {
      if (controller.signal.aborted) throw error();
      let rejectAbort;
      const aborted = new Promise((_, reject) => { rejectAbort = () => reject(error()); controller.signal.addEventListener('abort', rejectAbort, { once: true }); });
      try { return await Promise.race([Promise.resolve().then(work), aborted]); }
      finally { controller.signal.removeEventListener('abort', rejectAbort); }
    },
    dispose() { clearTimeout(timer); parentSignal?.removeEventListener('abort', abort); controller.abort(); }
  };
}

function provenIdentity(identity, account) {
  return identity?.authenticated === true && /^[A-Za-z0-9_]{1,15}$/.test(identity.username || '') && typeof identity.userId === 'string' && /^\d+$/.test(identity.userId) &&
    (!account.username || account.username.toLowerCase() === identity.username.toLowerCase()) && (!account.userId || account.userId === identity.userId);
}

function parseIdList(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val.flatMap(parseIdList);
  return String(val)
    .split(/[,\s]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

async function run({
  token = config().TELEGRAM_BOT_TOKEN,
  userId = config().BOT_OWNER_ID,
  chatId = config().BOT_OWNER_CHAT_ID,
  allowedUserIds = config().BOT_ALLOWED_USER_IDS || config().BOT_ALLOWED_USERS,
  allowedChatIds = config().BOT_ALLOWED_CHAT_IDS,
  dataDir = config().BOT_DATA_DIR || path.join(__dirname, '..', 'data'),
  api = createTelegramApi(token),
  pollTimeout = 25,
  pollMs = 1_000,
  maxPolls = Infinity,
  sleepFn = sleep,
  lockPath = path.join(dataDir, 'telegram-runner.lock'),
  lockTimeoutMs = 15_000,
  conflictBackoffMs = 2_000,
  maxConflictRetries = 1,
  logger = console,
  clock = () => new Date(),
  randomInt = (min, max) => min + Math.floor(Math.random() * (max - min)),
  onRuntimeReady,
  onPostPersisted,
  vpnManager,
  publishAdapterFactory,
  verifyAdapterFactory,
  attemptTimeoutMs = 180_000
} = {}) {
  if (!Number.isFinite(attemptTimeoutMs) || attemptTimeoutMs < 1 || attemptTimeoutMs > 600_000) throw new TypeError('Invalid attempt timeout');
  const effectiveUserIds = Array.from(new Set([...parseIdList(userId), ...parseIdList(allowedUserIds)]));
  const effectiveChatIds = Array.from(new Set([...parseIdList(chatId), ...parseIdList(allowedChatIds)]));
  if (!parseIdList(userId).length || !parseIdList(chatId).length || !effectiveUserIds.length || !effectiveChatIds.length) throw new Error('BOT_OWNER_ID and BOT_OWNER_CHAT_ID are required');
  const lock = new SingleInstanceLock(lockPath, { timeoutMs: lockTimeoutMs });
  const release = await lock.acquire();
  let stopping = false;
  let ui; let bot; let abortController; let watchdog;
  const panelTasks = new Set();
  const trackPanel = promise => { const task = Promise.resolve(promise).catch(error => logger.error(JSON.stringify({ event: 'panel_refresh_failed', code: error.code || 'UNKNOWN' }))); panelTasks.add(task); task.finally(() => panelTasks.delete(task)); return task; };
  const exportTasks = new Set();
  const stop = () => { stopping = true; abortController?.abort(); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    bot = createBot({
      dataDir,
      auth: { allowedUserIds: effectiveUserIds, allowedChatIds: effectiveChatIds },
      accountLifecycle: {
        beforeMutation: async ({ operation }) => {
          if (operation === 'remove' || operation === 'replace') { await ui?.stop(); await ui?.job; }
        },
        onChange: async (accounts, { before = [] } = {}) => {
          const retained = new Set(accounts.map(account => account.id));
          for (const account of before) if (!retained.has(account.id)) {
            try { await vpnSlots.release(account.id); }
            catch (error) { mappingsSafe = false; logger.error(JSON.stringify({ event: 'vpn_release_failed', code: error.code || 'VPN_RELEASE_FAILED' })); }
          }
          await reconcileResources();
        }
      },
      telegram: {
        send: payload => api.sendMessage(payload),
        sendRichMessage: payload => api.sendRichMessage(payload),
        editMessageText: payload => api.editMessageText(payload),
        deleteMessage: payload => api.deleteMessage ? api.deleteMessage(payload) : Promise.resolve(),
        answerCallback: payload => api.answerCallbackQuery(payload)
      }
    });
    await bot.queue.recoverProcessing({ state: 'ambiguous', reason: 'startup_crash_recovery' });
    const state = await bot.store.load();
    let offset = Number.isSafeInteger(state.telegram?.offset) ? state.telegram.offset : 0;
    const processed = new Set(Array.isArray(state.telegram?.processedUpdates) ? state.telegram.processedUpdates : []);
    const me = await api.getMe();
    watchdog = require('./watchdog').startWatchdog({
      onReady: () => logger.log(JSON.stringify({ event: 'watchdog_ready', action: 'alert_only', timeoutMs: 180000 })),
      onAlarm: result => logger.error(JSON.stringify({ event: 'watchdog_alarm', ...result }))
    });
    logger.log(JSON.stringify({ event: 'telegram_ready', bot_id: me.id, username: me.username }));
    // VPN slot manager — per-account Docker containers
    const vpnSlots = vpnManager || new VpnSlotManager({ store: bot.store, logger: msg => logger.log(JSON.stringify({ event: 'vpn', message: msg })) });
    bot.vpnManager = vpnSlots;
    bot.forensicLogger?.prune().catch(error => {
      logStructured(logger, { level: 'warn', component: 'runner', event: 'forensic_prune_failed', operation: 'prune', result: 'failed', errorCode: extractErrorCode(error), sanitizedError: sanitizeError(error) });
    });
    bot.forensicLogger?.pruneBurnedSubnets().catch(error => {
      logStructured(logger, { level: 'warn', component: 'runner', event: 'forensic_prune_subnets_failed', operation: 'pruneBurnedSubnets', result: 'failed', errorCode: extractErrorCode(error), sanitizedError: sanitizeError(error) });
    });
    const links = createLinkExports({ store: bot.store, dataDir, api, chatIds: effectiveChatIds, logger, clock });
    const notify = async text => {
      const results = await Promise.allSettled(effectiveChatIds.map(chat_id => Promise.resolve().then(() => api.sendMessage({ chat_id, text }))));
      for (let i = 0; i < results.length; i++) {
        const res = results[i];
        if (res.status === 'rejected') {
          logStructured(logger, {
            level: 'error',
            component: 'runner',
            event: 'notify_send_failed',
            operation: 'sendMessage',
            result: 'failed',
            errorCode: extractErrorCode(res.reason),
            sanitizedError: sanitizeError(res.reason),
            details: { chatId: effectiveChatIds[i] }
          });
        } else {
          logStructured(logger, {
            level: 'info',
            component: 'runner',
            event: 'notify_send_success',
            operation: 'sendMessage',
            result: 'delivered_to_telegram_api',
            details: {
              chatId: effectiveChatIds[i],
              messageId: res.value?.message_id ?? null
            }
          });
        }
      }
      return results;
    };

    let mappingsSafe = true;
    const reconcileResources = async () => {
      if (!vpnSlots.reconcile) return true; // Historical injected manager seam.
      try {
        const current = await bot.store.load();
        // Drafts own reservations until onboarding completes; they are not stale.
        const accountIds = [...new Set([...(current.accounts || []).filter(a => a.enabled !== false).map(a => a.id),
          ...Object.values(current.telegramUi?.users || {}).map(u => u.draft?.id).filter(Boolean)])];
        const plan = await vpnSlots.reconcile({ accountIds, dryRun: true });
        if (plan.conflicts?.length) throw Object.assign(new Error('Unsafe VPN mappings'), { code: 'VPN_MAPPING_CONFLICT' });
        await vpnSlots.reconcile({ accountIds, dryRun: false });
        mappingsSafe = true;
      } catch (error) {
        mappingsSafe = false;
        logger.error(JSON.stringify({ event: 'vpn_reconcile_failed', code: error.code || 'VPN_RECONCILE_FAILED' }));
        await notify('تعذر تنظيف أو التحقق من موارد VPN؛ يلزم فحص تعارضات الحاويات قبل بدء النشر.');
      }
      return mappingsSafe;
    };
    await reconcileResources();
    // AccountManager invokes explicit lifecycle hooks installed by composition.
    // No per-instance method replacement or second resource lifecycle authority.

    // Browserless verifier: observed identity only, never expected-handle fallback.
    const isolatedVerifier = {
      async releaseDraft(accountId) {
        const current = await bot.store.load();
        if ((current.accounts || []).some(a => a.id === accountId) || Object.values(current.telegramUi?.users || {}).some(u => u.draft?.id === accountId)) return;
        await vpnSlots.release(accountId);
      },
      async verify(account, { persistResult = true, signal } = {}) {
        const persist = async result => {
          if (!persistResult || signal?.aborted) return;
          try { await ui?.recordAccountCheck(account.id, result, { session: true, expectedAccount: account }); }
          catch { throw Object.assign(new Error('Account check persistence failed'), { code: 'ACCOUNT_CHECK_PERSIST_FAILED' }); }
        };
        const attempt = attemptScope(signal, attemptTimeoutMs);
        const adapter = verifyAdapterFactory ? verifyAdapterFactory() : new DirectXAdapter({ allowPublish: false });
        let session, primaryError, route;
        try {
          // A shared read lease binds proxy/health to one unique mapping until
          // adapter teardown. No ensure/allocate fallback on dashboard refresh.
          let vpn;
          if (!persistResult) {
            if (!mappingsSafe || !vpnSlots.acquireReadRoute) throw Object.assign(new Error('Read-only VPN route unavailable'), { code: 'VPN_MAPPING_CONFLICT' });
            route = await vpnSlots.acquireReadRoute(account.id, { signal: attempt.signal });
            vpn = route;
            if (attempt.signal.aborted) throw Object.assign(new Error('Refresh cancelled'), { code: 'ATTEMPT_ABORTED' });
          } else vpn = await attempt.wait(() => vpnSlots.ensure(account.id, { signal: attempt.signal }));
          if (!persistResult && (!vpn.healthy || !vpn.proxy || !vpn.exitIp)) throw Object.assign(new Error('VPN route not ready'), { code: 'VPN_NOT_READY' });
          if (attempt.signal.aborted) throw Object.assign(new Error('Refresh cancelled'), { code: 'ATTEMPT_ABORTED' });
          const opened = Promise.resolve().then(() => adapter.open({ account: { ...account, verifyNetwork: true }, proxy: vpn.proxy, signal: attempt.signal }));
          if (persistResult) opened.then(late => { if (attempt.signal.aborted) Promise.resolve().then(() => adapter.close({ session: late })).catch(err => logStructured(logger, { level: 'warn', component: 'runner', event: 'adapter_close_failed', operation: 'close', result: 'failed', errorCode: extractErrorCode(err), sanitizedError: sanitizeError(err) })); }, err => logStructured(logger, { level: 'debug', component: 'runner', event: 'adapter_open_aborted', operation: 'open', result: 'aborted', sanitizedError: sanitizeError(err) }));
          session = persistResult ? await attempt.wait(() => opened) : await opened;
          if (attempt.signal.aborted) throw Object.assign(new Error('Refresh cancelled'), { code: 'ATTEMPT_ABORTED' });
          const identity = session.identity;
          const result = { isolated: Boolean(vpn.exitIp), vpnHealthy: Boolean(vpn.exitIp), exitIp: vpn.exitIp,
            authenticated: Boolean(provenIdentity(identity, account)), state: identity?.state, accountFailure: identity?.accountFailure, userId: identity?.userId,
            readDiagnostic: identity?.readDiagnostic,
            username: provenIdentity(identity, account) ? identity.username : null,
            discovered: !account.username && Boolean(provenIdentity(identity, account)), resourceId: vpn.name };
          await persist(result);
          return result;
        } catch (error) {
          primaryError = error;
          if (error?.code !== 'ACCOUNT_CHECK_PERSIST_FAILED') {
            try { await persist({ isolated: false, vpnHealthy: false, authenticated: false }); }
            catch (persistError) { primaryError = persistError; }
          }
          throw primaryError;
        } finally {
          const closing = Promise.resolve().then(() => adapter.close({ session, signal: attempt.signal }));
          try { if (persistResult) await attempt.wait(() => closing); else await closing; }
          catch (cleanupError) { if (!primaryError) throw cleanupError; }
          finally {
            route?.release();
            closing.catch(err => logStructured(logger, { level: 'warn', component: 'runner', event: 'adapter_closing_failed', operation: 'closing', result: 'failed', errorCode: extractErrorCode(err), sanitizedError: sanitizeError(err) }));
            attempt.dispose();
          }
        }
      },
      async health(account) {
        const check = await vpnSlots.health(account.id);
        return { isolated: check.healthy === true, vpnHealthy: check.healthy === true, ip: check.exitIp || null };
      }
    };

    // Runtime readiness — checks real conditions
    const runtimeReady = async () => {
      const reasons = [];
      const state = await bot.store.load();
      const accounts = (state.accounts || []).filter(a => a.enabled !== false && a.username && a.cookieFile);
      if (!accounts.length) reasons.push('لا يوجد حساب مفعل باسم مستخدم وملف جلسة');
      if (!(state.items || []).some(x => x.state === 'pending')) reasons.push('لا توجد منشورات في الانتظار');
      const explicitMin = state.settings?.delayMinSeconds;
      const explicitMax = state.settings?.delayMaxSeconds;
      if ((explicitMin != null && explicitMax == null) || (explicitMin == null && explicitMax != null) || explicitMin === null || explicitMax === null) {
        reasons.push('يجب تحديد الحد الأدنى والحد الأعلى للتأخير قبل بدء العمل');
      }
      const quota = quotaAdmission(state, { accounts, now: clock() });
      if (quota.exhausted) return { ready: false, reasons: [...reasons, quota.message] };
      if (!mappingsSafe) return { ready: false, reasons: [...reasons, 'تعارض موارد VPN يحتاج إلى مراجعة'] };
      // A read-only failed health probe must not prevent cold-start ensure.
      let anyVpnHealthy = false;
      const readiness = attemptScope(null, attemptTimeoutMs);
      try {
        for (const a of accounts.filter(a => accountCapacity(state, a, clock()).remaining > 0)) {
          let check;
          try {
            check = await readiness.wait(() => vpnSlots.health(a.id));
            if (!check.healthy) {
              const vpn = await readiness.wait(() => vpnSlots.ensure(a.id, { signal: readiness.signal }));
              check = { healthy: Boolean(vpn.exitIp), exitIp: vpn.exitIp };
            }
          } catch (err) {
            logStructured(logger, {
              level: 'warn',
              component: 'runner',
              event: 'vpn_health_probe_failed',
              accountId: a.id,
              operation: 'readiness.healthProbe',
              result: 'failed',
              errorCode: extractErrorCode(err),
              sanitizedError: sanitizeError(err)
            });
            check = { healthy: false };
          }
          await ui?.recordAccountCheck(a.id, { isolated: check.healthy === true && Boolean(check.exitIp), vpnHealthy: check.healthy === true && Boolean(check.exitIp), exitIp: check.exitIp }, { source: 'vpn-health', expectedAccount: a });
          if (check.healthy) { anyVpnHealthy = true; break; }
          if (readiness.signal.aborted) break;
        }
      } finally { readiness.dispose(); }
      if (accounts.length && !anyVpnHealthy) reasons.push('لا توجد حاوية VPN سليمة لأي حساب مفعل');
      return { ready: reasons.length === 0, reasons };
    };

    // One authoritative cycle; stop is checked at every admission boundary.
    const launchCycle = async run => {
      abortController = new AbortController();
      const signal = abortController.signal;
      // Keep the run's item ids as its durable admission boundary, but resolve
      // every item/account from SQLite at the boundary where it is admitted.
      // A long-running cycle must not use a stale pre-restart quota, account,
      // or item state snapshot.
      const itemIds = new Set(run.itemIds || []);
      const cooling = new Map();
      const accountRevision = a => JSON.stringify(['checkGeneration', 'cookieFile', 'enabled', 'username', 'userId'].map(k => a?.[k]));
      const initStore = await bot.store.load();
      if (initStore.posting?.cooling) {
        for (const [id, value] of Object.entries(initStore.posting.cooling)) {
          if (value?.until > clock().getTime() && accountRevision(initStore.accounts?.find(a => a.id === id)) === value.revision) {
            cooling.set(id, value);
          }
        }
      }
      let lastRotationSignature = null;
      const excluded = state => {
        for (const [id, value] of cooling) {
          if (accountRevision(state.accounts?.find(a => a.id === id)) !== value.revision || value.until <= clock().getTime()) {
            cooling.delete(id);
          }
        }
        const set = new Set([...cooling].filter(([, value]) => value.until > clock().getTime()).map(([id]) => id));
        return set;
      };

      const handleAccountFailure = async ({
        accountId,
        account,
        item,
        claim,
        session,
        failure,
        reason,
        retryAfterSeconds,
        rawError,
        xErrorCode
      }) => {
        const isPermanent = ['banned', 'captcha'].includes(failure);
        const isKnownParserError = isKnownTwikitParserFailure({ failure, rawError });
        const isRateLimit = failure === 'rate_limit' || Boolean(retryAfterSeconds) || reason === 'rate_limit';
        const isTransportOrVpn = failure === 'network_proxy_error' ||
          /network_proxy_error/i.test(String(failure || '')) ||
          /vpn|proxy|socks|network|timeout|connecterror|econnreset|econnrefused/i.test(String(reason || ''));
        let accountResult = {
          failures: 0,
          isolated: false,
          status: null,
          transportOutage: isTransportOrVpn
        };

        const currentSubnet = session?.exitIp ? normalizeSubnet(session.exitIp) : null;

        await bot.store.update(s => {
          const acc = s.accounts?.find(a => a.id === accountId);
          if (acc) {
            if (isPermanent) {
              acc.enabled = false;
              acc.status = failure === 'captcha' ? 'كابتشا' : 'محظور';
              acc.checkGeneration = crypto.randomUUID();
              accountResult.isolated = true;
              accountResult.status = acc.status;
              if (currentSubnet) {
                s.burnedSubnets ||= [];
                const exists = s.burnedSubnets.some(e => (typeof e === 'string' ? e : e.subnet) === currentSubnet);
                if (!exists) s.burnedSubnets.push({ subnet: currentSubnet, burnedAt: Date.now() });
              }
            } else if (isKnownParserError) {
              // A Twikit profile decode exception is a library failure, not a
              // failure of this X account. Quarantine the dispatched item and
              // retain existing strikes rather than incrementing the account.
              accountResult.failures = acc.failures || 0;
            } else if (isRateLimit) {
              // Rate limit: cooling only, no strike increment
            } else if (isTransportOrVpn) {
              // Transient network/proxy/VPN container issues: DO NOT increment account failure strikes
              accountResult.failures = acc.failures || 0;
            } else {
              // Increment persistent failure strike in SQLite
              acc.failures = (acc.failures || 0) + 1;
              accountResult.failures = acc.failures;
              if (acc.failures >= 3) {
                acc.enabled = false;
                acc.status = 'معزول (3 إخفاقات)';
                acc.checkGeneration = crypto.randomUUID();
                accountResult.isolated = true;
                accountResult.status = acc.status;
              }
            }
          }

          // Only the owning claim may be released. Never return a dispatching
          // attempt to pending: X could already have accepted the post.
          const i = s.items?.find(x => x.id === item?.id);
          if (i?.state === 'processing' && claim?.token && i.attempt?.token === claim.token) {
            if (i.attempt?.phase === 'claimed') {
              i.state = 'pending';
              recordUnsuccessfulAttempt(s, { accountId, outcome: 'failed', at: clock() });
              delete i.attempt;
              if (i.payload?.account === accountId) delete i.payload.account;
            } else {
              i.state = 'ambiguous';
              recordUnsuccessfulAttempt(s, { accountId, outcome: 'ambiguous', at: clock() });
              i.reason ||= 'account_failure_after_dispatch';
              i.accountId = accountId;
              i.accountUsername = account?.username;
              delete i.attempt;
            }
            if (s.posting) s.posting.publishingAt = null;
          }
          return s;
        });

        const sNow = await bot.store.load();
        const isCooling = a => {
          const c = cooling.get(a.id);
          return c && c.until > clock().getTime() && accountRevision(a) === c.revision;
        };
        const otherActive = (sNow.accounts || []).filter(a =>
          a.id !== accountId &&
          a.enabled !== false &&
          !['محظور', 'كابتشا', 'معزول (3 إخفاقات)'].includes(a.status) &&
          (a.failures || 0) < 3 &&
          (run.accountIds || []).includes(a.id) &&
          accountCapacity(sNow, a, clock()).remaining > 0 &&
          !isCooling(a)
        );

        if (accountResult.isolated) {
          cooling.delete(accountId);
          vpnSlots?.rotate(accountId).catch(err => logStructured(logger, { level: 'error', component: 'runner', event: 'vpn_rotate_failed', accountId, operation: 'handleAccountFailure.isolated.rotate', result: 'failed', errorCode: extractErrorCode(err), sanitizedError: sanitizeError(err) }));
        } else if (isRateLimit) {
          const delayMs = Math.min(900000, Math.max(60000, (retryAfterSeconds || 60) * 1000));
          const entry = {
            failures: cooling.get(accountId)?.failures || 0,
            until: clock().getTime() + delayMs,
            revision: accountRevision(account),
            retryAfterMs: delayMs
          };
          cooling.set(accountId, entry);
          await bot.store.update(s => {
            s.posting ||= {};
            s.posting.cooling ||= {};
            s.posting.cooling[accountId] = entry;
            return s;
          });
        } else if (isTransportOrVpn) {
          vpnSlots?.rotate(accountId).catch(err => logStructured(logger, { level: 'error', component: 'runner', event: 'vpn_rotate_failed', accountId, operation: 'handleAccountFailure.transport.rotate', result: 'failed', errorCode: extractErrorCode(err), sanitizedError: sanitizeError(err) }));
          const delayMs = 30000;
          const entry = {
            failures: accountResult.failures,
            until: clock().getTime() + delayMs,
            revision: accountRevision(account),
            retryAfterMs: delayMs
          };
          cooling.set(accountId, entry);
          await bot.store.update(s => {
            s.posting ||= {};
            s.posting.cooling ||= {};
            s.posting.cooling[accountId] = entry;
            return s;
          });
        } else {
          // Non-isolated failure: skip this account for the remainder of this pass (60s cooling if other accounts exist)
          const delayMs = otherActive.length > 0 ? 60000 : Math.min(60000, Math.max(1000, (sNow.settings?.delayMinSeconds ?? 15) * 1000));
          const entry = {
            failures: accountResult.failures,
            until: clock().getTime() + delayMs,
            revision: accountRevision(account)
          };
          cooling.set(accountId, entry);
          await bot.store.update(s => {
            s.posting ||= {};
            s.posting.cooling ||= {};
            s.posting.cooling[accountId] = entry;
            return s;
          });
        }

        bot.forensicLogger?.record({
          eventType: accountResult.isolated
            ? (accountResult.status === 'كابتشا' ? 'account_captcha' : accountResult.status === 'محظور' ? 'account_banned' : 'account_isolated_3_failures')
            : isKnownParserError ? 'twikit_profile_parse_error_no_strike' : isRateLimit ? 'account_rate_limited' : isTransportOrVpn ? 'transport_or_vpn_error' : 'account_failure_strike',
          accountId,
          username: account?.username,
          slot: session?.slot,
          port: session?.port,
          exitIp: session?.exitIp,
          subnet: currentSubnet,
          xErrorCode: xErrorCode ?? null,
          xErrorMessage: rawError || reason,
          details: { itemId: item?.id, failure, failures: accountResult.failures, isolated: accountResult.isolated, libraryParseFailure: isKnownParserError }
        }).catch(err => logStructured(logger, { level: 'error', component: 'runner', event: 'forensic_record_failed', accountId, operation: 'handleAccountFailure.record', result: 'failed', errorCode: extractErrorCode(err), sanitizedError: sanitizeError(err) }));

        if (accountResult.isolated) {
          if (otherActive.length > 0) {
            await notify(`تم عزل الحساب @${account.username || account.label} تلقائياً (${accountResult.status}) ومواصلة الدورة عبر بقية الحسابات (${otherActive.length}).`);
            return { halt: false, skipDelay: true, isolated: true, failures: accountResult.failures };
          } else {
            await notify(`تم عزل الحساب @${account.username || account.label} تلقائياً (${accountResult.status}). لا توجد حسابات مؤهلة متبقية؛ توقفت الدورة.`);
            return { halt: true, skipDelay: true, isolated: true, failures: accountResult.failures };
          }
        }

        if (failure === 'ambiguous') {
          // Ambiguous outcome isolates the item, not the cycle.
          // Do not halt the run unless the account was isolated on its 3rd strike.
          return { halt: false, skipDelay: false, isolated: false, failures: accountResult.failures };
        }

        if (otherActive.length > 0) {
          return { halt: false, skipDelay: true, isolated: false, failures: accountResult.failures };
        } else {
          await notify('جميع الحسابات غير مؤهلة أو في فترة انتظار؛ توقفت الدورة وبقيت المنشورات في الانتظار.');
          return { halt: true, skipDelay: true, isolated: false, failures: accountResult.failures };
        }
      };

      cycleLoop: while (!signal.aborted) {
      let claimedInPass = false;
      const passSnapshot = await bot.store.load();
      if (passSnapshot.telegramUi?.run?.accountIds) {
        run.accountIds = [...passSnapshot.telegramUi.run.accountIds];
      }
      const hints = new Map((passSnapshot.items || []).map(i => [i.id, i]));
      const passExcluded = excluded(passSnapshot);
      // Explain each routing decision once per changed state, not once per
      // queued post. Ordinary cooling/quota skips are not rotation failures.
      const rotation = (run.accountIds || []).map(id => {
        const acc = (passSnapshot.accounts || []).find(a => a.id === id);
        const quota = acc ? accountCapacity(passSnapshot, acc, clock()).remaining : 0;
        const pause = cooling.get(id);
        const reason = !acc ? 'missing_account'
          : acc.enabled === false ? 'disabled'
          : ['محظور', 'كابتشا', 'معزول (3 إخفاقات)'].includes(acc.status) || (acc.failures || 0) >= 3 ? 'isolated'
          : quota <= 0 ? 'quota_exhausted'
          : passExcluded.has(id) ? 'cooling'
          : 'eligible';
        return { accountId: id, reason, remainingQuota: quota === Infinity ? null : quota,
          coolingUntil: reason === 'cooling' ? pause?.until || null : null };
      });
      const rotationSignature = JSON.stringify({ cursor: passSnapshot.telegramUi?.run?.cursor || 0, rotation });
      if (rotationSignature !== lastRotationSignature) {
        lastRotationSignature = rotationSignature;
        logStructured(logger, { level: 'info', component: 'runner', event: 'account_rotation_decision',
          runId: run.runId, operation: 'cycleLoop.selectAccount', result: 'evaluated', rotation });
      }
      const itemIdsList = Array.from(itemIds);
      for (let itemIdx = 0; itemIdx < itemIdsList.length; itemIdx++) {
        const itemId = itemIdsList[itemIdx];
        // Do not deserialize the entire durable queue for every cooled/pinned
        // item. This snapshot is only a cheap skip hint; admission reloads below.
        const hint = hints.get(itemId);
        if (hint?.state !== 'pending' || !selectAccount(passSnapshot, run, hint, clock(), passExcluded)) continue;
        let current = await bot.store.load();
        if (!(run.accountIds || []).some(id => selectAccount(current, run, { payload: { account: id } }, clock(), excluded(current)))) break;
        if (signal.aborted || current.cycle?.state !== 'running' || current.cycle.runId !== run.runId) break;
        const item = (current.items || []).find(entry => entry.id === itemId && entry.state === 'pending');
        if (!item) continue;
        const accountId = selectAccount(current, run, item, clock(), excluded(current));
        if (!accountId) continue;
        let deadline = Date.parse(current.posting?.nextPostAt || '');
        while (Number.isFinite(deadline) && clock().getTime() < deadline && !signal.aborted) {
          await sleepFn(Math.min(1000, deadline - clock().getTime()));
          current = await bot.store.load();
          deadline = Date.parse(current.posting?.nextPostAt || '');
          if (current.cycle?.state !== 'running' || current.cycle.runId !== run.runId) break;
        }
        if (signal.aborted || current.cycle?.state !== 'running' || current.cycle.runId !== run.runId) break;
        const account = (current.accounts || []).find(a => a.id === accountId && a.enabled !== false);
        if (!account) continue;
        let halt = false, retryAfterMs = 0, preDispatchTransfer = false;
        let result;
        while (!signal.aborted) {
        let retry = false, skipDelay = false, safeTransient = false;
        let adapter;
        let session, openTask, dispatchEntered = false, claim;
        const attempt = attemptScope(signal, attemptTimeoutMs);
        try {
          claim = await attempt.wait(() => claimCycleItem({ store: bot.store, itemId, accountId, runId: run.runId, signal: attempt.signal, clock }));
          if (!claim.claimed) {
            break;
          }
          claimedInPass = true;
          let vpn;
          try {
            vpn = await attempt.wait(() => vpnSlots.ensure(accountId, { signal: attempt.signal }));
            if (!vpn.exitIp) throw new Error('VPN has no verified exit');
          }
          catch (err) {
            // Cancellation, ownership/configuration and durable-write errors are
            // not transport outages. Never disguise them as an automatic retry.
            if (attempt.signal.aborted || ['ACCOUNT_CHECK_PERSIST_FAILED', 'VPN_MAPPING_CONFLICT'].includes(err.code)) throw err;
            try { await ui.recordAccountCheck(accountId, { isolated: false, vpnHealthy: false }, { source: 'vpn-health', expectedAccount: account }); }
            catch { throw Object.assign(new Error('Account check persistence failed'), { code: 'ACCOUNT_CHECK_PERSIST_FAILED' }); }
            if (!(err.code === 'VPN_NOT_READY' || /timeout|readiness deadline|proxy_unreachable|container_not_healthy|server_ip_unavailable/.test(err.message || ''))) throw Object.assign(new Error('VPN readiness failed'), { code: 'VPN_READINESS_FAILED' });
            logger.error(JSON.stringify({ event: 'vpn_failed', account: accountId, code: err.code || 'VPN_ERROR' }));
            throw Object.assign(new Error('VPN readiness temporarily unavailable'), { code: 'VPN_TRANSIENT_UNAVAILABLE', recoverySafe: err.code === 'VPN_NOT_READY' || /timeout|readiness deadline|proxy_unreachable|container_not_healthy|server_ip_unavailable/.test(err.message || '') });
          }
          // Persistence has its own authority; it must not enter the VPN catch.
          try { await ui.recordAccountCheck(accountId, { isolated: Boolean(vpn.exitIp), vpnHealthy: Boolean(vpn.exitIp), exitIp: vpn.exitIp }, { source: 'vpn-health', expectedAccount: account }); }
          catch { throw Object.assign(new Error('Account check persistence failed'), { code: 'ACCOUNT_CHECK_PERSIST_FAILED' }); }
          if (signal.aborted || (await bot.store.load()).cycle?.state !== 'running') {
            await bot.store.update(s => {
              const i = s.items.find(x => x.id === itemId);
              if (i?.state === 'processing' && claim?.token && i.attempt?.token === claim.token) {
                i.state = 'pending';
                delete i.attempt;
              }
              return s;
            });
            break;
          }
          adapter = publishAdapterFactory ? publishAdapterFactory() : new DirectXAdapter({ allowPublish: true });
          const opened = openTask = Promise.resolve().then(() => adapter.open({ account, proxy: vpn.proxy, signal: attempt.signal }));
          // The finally owner joins even a late open and closes it exactly once.
          session = await attempt.wait(() => opened);
          if (session.identity?.accountFailure) await ui.recordAccountCheck(accountId, { accountFailure: session.identity.accountFailure }, { session: true, expectedAccount: account });
          if (provenIdentity(session.identity, account)) await ui.recordAccountCheck(accountId, {
            isolated: true, vpnHealthy: Boolean(vpn.exitIp), exitIp: vpn.exitIp,
            authenticated: true, username: session.identity.username
          }, { session: true, source: 'x-session', expectedAccount: account });
          else if (session.identity?.retryable === true && session.identity.reason === 'identity_read_unavailable' && !session.identity.accountFailure) {
            throw Object.assign(new Error('Identity read temporarily unavailable'), { code: 'DIRECT_X_IDENTITY_READ_UNAVAILABLE', readDiagnostic: session.identity.readDiagnostic });
          }
          else if (!publishAdapterFactory || session.identity?.username != null || session.identity?.userId != null) {
            await ui.recordAccountCheck(accountId, { isolated: true, vpnHealthy: Boolean(vpn.exitIp), exitIp: vpn.exitIp, authenticated: false }, { session: true, expectedAccount: account });
            throw Object.assign(new Error('Identity unverified'), { code: 'DIRECT_X_AUTH_IDENTITY_UNVERIFIED' });
          }
          if (signal.aborted) {
            await bot.store.update(s => {
              const i = s.items.find(x => x.id === item.id);
              if (i?.state === 'processing' && claim?.token && i.attempt?.token === claim.token) {
                i.state = 'pending';
                delete i.attempt;
              }
              return s;
            });
            break;
          }
          if (!session.identity?.authenticated) {
            const failure = session.identity?.accountFailure;
            const outcome = await handleAccountFailure({
              accountId,
              account,
              item,
              claim,
              session,
              failure,
              reason: session.identity?.reason || 'unauthenticated',
              retryAfterSeconds: session.identity?.readDiagnostic?.retryAfterSeconds
            });
            if (outcome.halt) { halt = true; }
            skipDelay = outcome.skipDelay;
            retry = false;
            if (!dispatchEntered) preDispatchTransfer = !outcome.halt;
            break;
          } else {
          let dispatchCalled = false;
          const onDispatch = async ({ accountId: reportedAccountId } = {}) => {
            if (dispatchCalled || attempt.signal.aborted || (reportedAccountId != null && reportedAccountId !== accountId)) throw Object.assign(new Error('Dispatch not admitted: DISPATCH_REJECTED'), { code: 'DISPATCH_REJECTED' });
            dispatchCalled = true;
            let dispatchReady = false;
            dispatchEntered = true; // Failed durable acknowledgement may have committed.
            await attempt.wait(() => bot.store.update(s => {
              const i = s.items.find(x => x.id === itemId);
              const a = s.accounts.find(x => x.id === accountId && x.enabled !== false);
              if (!attempt.signal.aborted && s.cycle?.state === 'running' && s.cycle.runId === run.runId &&
                i?.state === 'processing' && i.attempt?.phase === 'claimed' && i.attempt?.token === claim.token &&
                i.attempt.runId === run.runId && i.attempt.accountId === accountId &&
                a?.checkGeneration === account.checkGeneration && a?.username === account.username && a?.cookieFile === account.cookieFile && a?.userId === account.userId &&
                accountCapacity(s, a, clock()).remaining > 0 && JSON.stringify(i.payload) === JSON.stringify(item.payload)) {
                i.attempt.phase = 'dispatching'; dispatchReady = true;
              }
              return s;
            }));
            if (!dispatchReady || attempt.signal.aborted) throw Object.assign(new Error('Dispatch not admitted: DISPATCH_REJECTED'), { code: 'DISPATCH_REJECTED' });
            return true;
          };
          // Historical injected adapters have no pre-send callback. Preserve that
          // test seam with an explicit pre-call fence; production Direct always
          // uses its precise bridge dispatch-ready handshake, never this path.
          if (publishAdapterFactory && !(adapter instanceof DirectXAdapter) && adapter.supportsDispatchCallback !== true) await onDispatch({ accountId });
          // Queue routing is runner metadata, not a direct-X content field.
          const directPayload = { ...item.payload }; delete directPayload.account;
          const publishStartedAt = Date.now();
          const result = await attempt.wait(() => adapter.publish({ session, payload: adapter instanceof DirectXAdapter ? directPayload : item.payload, confirmPublish: true, signal: attempt.signal, onDispatch }));
          if (result.accountFailure) await ui.recordAccountCheck(accountId, { accountFailure: result.accountFailure }, { session: true, expectedAccount: account });
          if (result.published && !dispatchEntered) throw Object.assign(new Error('Missing dispatch fence'), { code: 'DISPATCH_FENCE_MISSING' });
          const newState = classifyPublishOutcome(result, dispatchEntered);
          logStructured(logger, {
            level: newState === 'ambiguous' ? 'warn' : 'info',
            component: 'runner',
            event: 'publish_attempt_observation',
            runId: run.runId,
            accountId,
            queueItemId: item.id,
            operation: 'DirectX.publish',
            result: newState,
            durationMs: Date.now() - publishStartedAt,
            errorCode: result.xErrorCode || result.reason || null,
            sanitizedError: result.rawError ? sanitizeError(result.rawError) : null,
            details: {
              dispatchEntered,
              bridgeStatus: result.status || null,
              textUtf16Length: typeof directPayload.text === 'string' ? directPayload.text.length : null,
              textCodePoints: typeof directPayload.text === 'string' ? Array.from(directPayload.text).length : null,
              verifiedNotPosted: result.verifiedNotPosted === true
            }
          });
          const publishedAt = new Date(clock()).toISOString();
          let transitioned = false;
          await bot.store.update(s => {
            const i = s.items.find(x => x.id === item.id);
            if (!i || i.state !== 'processing' || !i.attempt || !claim?.token || i.attempt.token !== claim.token) return s;
            s.posting ||= {};
            s.posting.publishingAt = null;
            transitioned = true;
            delete i.attempt;
            i.state = newState; i.reason = result.reason || null;
            if (newState !== 'published') recordUnsuccessfulAttempt(s, { accountId, outcome: newState === 'ambiguous' ? 'ambiguous' : 'failed', at: clock() });
            if (['published', 'ambiguous'].includes(newState)) {
              i.accountId = accountId; i.accountUsername = account?.username;
              const minSeconds = Number.isSafeInteger(s.settings?.delayMinSeconds) ? s.settings.delayMinSeconds : 15;
              const maxSeconds = Number.isSafeInteger(s.settings?.delayMaxSeconds) ? Math.max(minSeconds, s.settings.delayMaxSeconds) : minSeconds;
              const delaySeconds = Math.max(15, randomInt(minSeconds, maxSeconds + 1));
              s.posting.nextPostAt = new Date(new Date(publishedAt).getTime() + delaySeconds * 1000).toISOString();
            }
            if (newState === 'published') {
              i.publishedAt = publishedAt; i.url = result.url;
              const acc = s.accounts?.find(a => a.id === accountId);
              if (acc) {
                acc.failures = 0;
              }
              // Claim token fencing above makes this a single durable transition.
              s.posting.quota ||= {};
              const day = riyadhDay(new Date(publishedAt));
              s.posting.quota[day] ||= {};
              s.posting.quota[day][accountId] = (s.posting.quota[day][accountId] || 0) + 1;
            }
            return s;
          });
          if (!transitioned) break;
          logger.log(JSON.stringify({ event: 'post_result', item: item.id, status: newState, account: accountId, reason: result.reason || result.status, url: result.url || null }));
          if (newState === 'published') {
            bot.forensicLogger?.record({
              eventType: 'post_success',
              accountId,
              username: account?.username,
              slot: session?.slot,
              port: session?.port,
              exitIp: session?.exitIp,
              details: { itemId: item.id, url: result.url }
            }).catch(err => logStructured(logger, { level: 'error', component: 'runner', event: 'forensic_record_failed', accountId, operation: 'post_success.record', result: 'failed', errorCode: extractErrorCode(err), sanitizedError: sanitizeError(err) }));
            cooling.delete(accountId);
            await bot.store.update(s => {
              if (s.posting?.cooling) delete s.posting.cooling[accountId];
              const acc = (s.accounts || []).find(a => a.id === accountId);
              if (acc) acc.failures = 0;
              return s;
            });
            ui.refreshPanels(true);
            if (onPostPersisted) await onPostPersisted({ itemId: item.id, accountId, publishedAt, url: result.url, stop: () => ui.stop() });
            if (run.stopAfterSuccess) { await ui.stop(); halt = true; }
          } else if (newState === 'ambiguous') {
            bot.forensicLogger?.record({
              eventType: 'post_ambiguous',
              accountId,
              username: account?.username,
              slot: session?.slot,
              port: session?.port,
              exitIp: session?.exitIp,
              xErrorCode: result.xErrorCode,
              xErrorMessage: result.rawError || result.reason,
              details: { itemId: item.id, reason: result.reason, rawError: result.rawError, fetchError: result.fetchError }
            }).catch(err => logStructured(logger, { level: 'error', component: 'runner', event: 'forensic_record_failed', accountId, operation: 'post_ambiguous.record', result: 'failed', errorCode: extractErrorCode(err), sanitizedError: sanitizeError(err) }));
            // Preserve the per-item forensic event without spamming Telegram.
            // A single alert is emitted only when the account is isolated.
            const outcome = await handleAccountFailure({
              accountId,
              account,
              item,
              claim,
              session,
              failure: 'ambiguous',
              reason: result.reason || 'publish_confirmation_missing',
              rawError: result.rawError,
              xErrorCode: result.xErrorCode
            });
            if (outcome.halt) { halt = true; }
            skipDelay = false;
            retry = false;
            break;
          } else if (result.retryable === true && (!dispatchEntered && result.reason === 'identity_read_unavailable') && !result.accountFailure) {
            retry = true; safeTransient = true;
            if (result.readDiagnostic?.httpStatus === 429) retryAfterMs = Math.min(900000, Math.max(60000, (result.readDiagnostic.retryAfterSeconds || 60) * 1000));
          }
          else if (result.blocked || result.rateLimit || /challenge|blocked|restrict|auth|login|cookie|rate.?limit/i.test(String(result.reason || '') + ' ' + String(result.status || '')) || result.accountFailure) {
            const failure = result.accountFailure || (result.rateLimit ? 'rate_limit' : null);
            const outcome = await handleAccountFailure({
              accountId,
              account,
              item,
              claim,
              session,
              failure,
              reason: result.reason,
              retryAfterSeconds: result.retryAfterSeconds || result.readDiagnostic?.retryAfterSeconds
            });
            if (outcome.halt) { halt = true; }
            skipDelay = outcome.skipDelay;
            retry = false;
            if (!dispatchEntered) preDispatchTransfer = !outcome.halt;
            break;
          } else if (newState === 'pending') { retry = true; }
          else if (newState === 'cancelled') { skipDelay = true; }
          }
        } catch (err) {
          if (err.readDiagnostic?.httpStatus === 429) retryAfterMs = Math.min(900000, Math.max(60000, (err.readDiagnostic.retryAfterSeconds || 60) * 1000));
          logger.error(JSON.stringify({ event: 'post_error', item: item.id, code: err.code || 'UNKNOWN', readPhase: ['user_state','settings','profile','bridge'].includes(err.readDiagnostic?.phase) ? err.readDiagnostic.phase : undefined, httpStatus: Number.isInteger(err.readDiagnostic?.httpStatus) ? err.readDiagnostic.httpStatus : undefined }));
          bot.forensicLogger?.record({
            eventType: 'post_error',
            accountId,
            username: account?.username,
            slot: session?.slot,
            port: session?.port,
            exitIp: session?.exitIp,
            httpStatus: err.readDiagnostic?.httpStatus || err.httpStatus,
            xErrorCode: err.code || err.xErrorCode,
            xErrorMessage: err.message,
            endpoint: err.readDiagnostic?.phase || 'CreateTweet',
            rawResponseSnippet: err.rawBody || err.readDiagnostic?.snippet,
            details: { itemId: item.id }
          }).catch(err => logStructured(logger, { level: 'error', component: 'runner', event: 'forensic_record_failed', accountId, operation: 'post_error.record', result: 'failed', errorCode: extractErrorCode(err), sanitizedError: sanitizeError(err) }));
          await bot.store.update(s => {
            const i = s.items.find(x => x.id === item.id);
            if (i?.state === 'processing' && claim?.token && i.attempt?.token === claim.token) {
              i.state = dispatchEntered || i.attempt?.phase === 'dispatching' ? 'ambiguous' : 'pending';
              recordUnsuccessfulAttempt(s, { accountId, outcome: i.state === 'ambiguous' ? 'ambiguous' : 'failed', at: clock() });
              if (i.state === 'ambiguous') {
                i.accountId = accountId;
                i.accountUsername = account?.username;
                const minSeconds = Number.isSafeInteger(s.settings?.delayMinSeconds) ? s.settings.delayMinSeconds : 15;
                const maxSeconds = Number.isSafeInteger(s.settings?.delayMaxSeconds) ? Math.max(minSeconds, s.settings.delayMaxSeconds) : minSeconds;
                const delaySeconds = Math.max(15, randomInt(minSeconds, maxSeconds + 1));
                s.posting.nextPostAt = new Date(clock().getTime() + delaySeconds * 1000).toISOString();
              }
              if (i.state === 'pending') delete i.attempt;
              if (s.posting) s.posting.publishingAt = null;
            }
            return s;
          });
          if (dispatchEntered) {
            bot.forensicLogger?.record({
              eventType: 'post_ambiguous',
              accountId,
              username: account?.username,
              slot: session?.slot,
              port: session?.port,
              exitIp: session?.exitIp,
              xErrorCode: err.code || err.xErrorCode,
              xErrorMessage: err.message,
              details: { itemId: item.id, reason: 'exception_after_dispatch' }
            }).catch(err => logStructured(logger, { level: 'error', component: 'runner', event: 'forensic_record_failed', accountId, operation: 'post_ambiguous_dispatch.record', result: 'failed', errorCode: extractErrorCode(err), sanitizedError: sanitizeError(err) }));
            // Dispatch crossed the irreversible boundary — the post may have
            // been published. Isolate it as ambiguous but let the cycle continue
            // with remaining items instead of freezing the entire run.
            // No per-item alert: forensicLogger already recorded the ambiguity.
            const outcome = await handleAccountFailure({
              accountId,
              account,
              item,
              claim,
              session,
              failure: 'ambiguous',
              reason: err.code || err.message || 'exception_after_dispatch',
              rawError: err.message,
              xErrorCode: err.code || err.xErrorCode
            });
            if (outcome.halt) { halt = true; }
            skipDelay = false;
            retry = false;
            break;
          }
          else if (!dispatchEntered && (['DIRECT_X_IDENTITY_READ_UNAVAILABLE', 'VPN_TRANSIENT_UNAVAILABLE', 'VPN_READINESS_FAILED'].includes(err.code) || /vpn|proxy|socks/i.test(err.code || err.message))) {
            retry = true; safeTransient = err.code === 'DIRECT_X_IDENTITY_READ_UNAVAILABLE' || err.recoverySafe === true || /vpn|proxy|socks/i.test(err.code || err.message);
          } else if (err.code === 'ACCOUNT_CHECK_PERSIST_FAILED') halt = true;
          else if (/auth|login|cookie|challenge|restrict/i.test(String(err.code || '') + ' ' + String(err.message || ''))) {
            const failure = session?.identity?.accountFailure || result?.accountFailure || err.accountFailure;
            const outcome = await handleAccountFailure({
              accountId,
              account,
              item,
              claim,
              session,
              failure,
              reason: err.code || err.message,
              retryAfterSeconds: err.readDiagnostic?.retryAfterSeconds
            });
            if (outcome.halt) { halt = true; }
            skipDelay = outcome.skipDelay;
            retry = false;
            if (!dispatchEntered) preDispatchTransfer = !outcome.halt;
            break;
          }
          else if (['ATTEMPT_TIMEOUT', 'ATTEMPT_ABORTED', 'DISPATCH_REJECTED', 'DISPATCH_FENCE_MISSING'].includes(err.code)) halt = true;
          else retry = true;
        } finally {
          if (adapter) {
            // A cancelled open may still own resources; retain this job until
            // it settles and the real teardown joins before new admission.
            if (!session && openTask) {
              try { session = await openTask; }
              catch (openErr) {
                logStructured(logger, { level: 'warn', component: 'runner', event: 'adapter_open_task_failed', operation: 'openTask.finally', result: 'failed', errorCode: extractErrorCode(openErr), sanitizedError: sanitizeError(openErr) });
              }
            }
            const closing = Promise.resolve().then(() => adapter.close({ session, signal: attempt.signal }));
            try { await closing; }
            catch (closeErr) {
              halt = true;
              logStructured(logger, { level: 'error', component: 'runner', event: 'adapter_close_failed', operation: 'adapter.close', result: 'failed', errorCode: extractErrorCode(closeErr), sanitizedError: sanitizeError(closeErr) });
            }
            closing.catch(closeErr => logStructured(logger, { level: 'warn', component: 'runner', event: 'adapter_closing_rejected', operation: 'closing', result: 'failed', errorCode: extractErrorCode(closeErr), sanitizedError: sanitizeError(closeErr) }));
          }
          attempt.dispose();
          await bot.store.update(s => {
            const i = s.items.find(x => x.id === itemId);
            if ((i?.state === 'processing' || (i?.state === 'ambiguous' && !i?.reason)) && claim?.token && i.attempt?.token === claim.token) {
              if (i.attempt?.phase === 'claimed' && !dispatchEntered) {
                i.state = 'pending';
                recordUnsuccessfulAttempt(s, { accountId, outcome: 'failed', at: clock() });
                delete i.attempt;
              } else if (i.attempt?.phase === 'dispatching' || dispatchEntered) {
                i.state = 'ambiguous';
                recordUnsuccessfulAttempt(s, { accountId, outcome: 'ambiguous', at: clock() });
                i.reason ||= 'unresolved_in_finally';
                i.accountId ||= accountId;
                i.accountUsername ||= account?.username;
              }
              if (s.posting) s.posting.publishingAt = null;
            }
            return s;
          });
        }
        if (halt || signal.aborted) break;
        if (retry && safeTransient) {
          const failures = (cooling.get(accountId)?.failures || 0) + 1;
          const delayMs = Math.max(retryAfterMs, Math.min(300000, 30000 * 2 ** Math.min(failures - 1, 4)));
          const entry = { failures, until: clock().getTime() + delayMs, revision: accountRevision(account), retryAfterMs };
          cooling.set(accountId, entry);
          await bot.store.update(s => {
            s.posting ||= {};
            s.posting.cooling ||= {};
            s.posting.cooling[accountId] = entry;
            return s;
          });
          logger.log(JSON.stringify({ event: 'account_retry_deferred', account: accountId, delayMs }));
          // No terminal report/notification: this is a temporary account pause,
          // not a stopped session. Pending items remain in the same run.
        } else if (retry) {
          const sNow = await bot.store.load();
          const isCooling = a => {
            const c = cooling.get(a.id);
            return c && c.until > clock().getTime() && accountRevision(a) === c.revision;
          };
          const otherActive = (sNow.accounts || []).filter(a =>
            a.id !== accountId &&
            a.enabled !== false &&
            !['محظور', 'كابتشا', 'معزول (3 إخفاقات)'].includes(a.status) &&
            (a.failures || 0) < 3 &&
            (run.accountIds || []).includes(a.id) &&
            accountCapacity(sNow, a, clock()).remaining > 0 &&
            !isCooling(a)
          );
          if (otherActive.length > 0) {
            skipDelay = true;
          } else {
            await notify('تعذر نشر المنشور بعد المحاولات؛ بقي في الانتظار.');
            halt = true;
          }
        }
        if (skipDelay || retry) break;
        const remaining = await bot.store.load();
        const hasEligible = [...itemIds].some(id => {
          const candidate = (remaining.items || []).find(x => x.id === id && x.state === 'pending');
          return candidate && selectAccount(remaining, run, candidate, clock());
        });
        if (!hasEligible) break;
        const delayEnd = Date.parse(remaining.posting?.nextPostAt || '');
        while (Number.isFinite(delayEnd) && clock().getTime() < delayEnd && !signal.aborted) {
          await sleepFn(Math.min(1000, delayEnd - clock().getTime()));
        }
        break;
        }
        if (halt || signal.aborted) break cycleLoop;
        if (preDispatchTransfer) {
          itemIdx--;
        }
      }
      const next = await bot.store.load();
      if (signal.aborted || next.cycle?.state !== 'running' || next.cycle.runId !== run.runId) break;
      const pending = (next.items || []).filter(i => itemIds.has(i.id) && i.state === 'pending');
      if (!pending.some(i => selectAccount(next, run, i, clock()))) break;
      const ready = pending.some(i => selectAccount(next, run, i, clock(), excluded(next)));
      if (ready && !claimedInPass) await sleepFn(1000);
      if (!ready) {
        const coolingWait = [...cooling.values()].map(v => v.until - clock().getTime()).filter(ms => ms > 0);
        const minWait = coolingWait.length ? Math.min(...coolingWait) : 1000;
        await sleepFn(Math.min(1000, Math.max(1, minWait)));
      }
      }
      const finished = await bot.store.load();
      const quota = quotaAdmission(finished, { accounts: (finished.accounts || []).filter(a => (run.accountIds || []).includes(a.id)), items: (finished.items || []).filter(i => itemIds.has(i.id)), now: clock() });
      if (!signal.aborted && quota.exhausted) {
        await stopCycleForQuota({ store: bot.store, runId: run.runId, clock });
        await notify(quota.message);
      }
    };

    const sendExport = (run, options) => {
      const task = links.send(run, options).catch(async error => {
        logger.error(JSON.stringify({ event: 'export_send_failed', code: error.code || 'UNKNOWN' }));
        await notify('تعذر إنشاء أو إرسال ملف روابط المنشورات؛ يرجى مراجعة السجل وإعادة المحاولة.');
      });
      exportTasks.add(task); task.finally(() => exportTasks.delete(task)); return task;
    };
    ui = new TelegramUi({ bot, launch: launchCycle, clock, downloadDocument: async document => {
      const file = await api.getFile({ file_id: document.file_id });
      if (file.file_size > 2 * 1024 * 1024) throw new Error('الملف أكبر من 2 ميجابايت.');
      return api.downloadFile(file.file_path, { maxBytes: 2 * 1024 * 1024 });
    }, runtimeReady, isolatedVerifier, notify, onPanelTask: trackPanel,
      // Stop only fences dispatch. Export after the job settles so a confirmed
      // in-flight success cannot create a second report from final cleanup.
      onCycleStop: () => { abortController?.abort(); },
      onCycleFinished: async run => {
        await sendExport(run, { emptyMessage: false, terminal: true });
        await links.flush().catch(error => {
          logStructured(logger, {
            level: 'error',
            component: 'runner',
            event: 'link_export_flush_failed',
            runId: run?.runId || null,
            operation: 'onCycleFinished.flush',
            result: 'failed',
            errorCode: extractErrorCode(error),
            sanitizedError: sanitizeError(error)
          });
        });
      } });
    // One reconciliation in flight bounds polling work; the tracked task is
    // drained before store close. Transport errors must not stop admission.
    let reconciliation;
    const reconcileLinks = ({ startup = false } = {}) => {
      if (reconciliation) return reconciliation;
      const task = (startup ? links.reconcile() : links.flush()).catch(error => {
        logger.error(JSON.stringify({ event: 'export_reconcile_failed', code: error.code || 'UNKNOWN' }));
      });
      reconciliation = task;
      exportTasks.add(task);
      task.finally(() => { exportTasks.delete(task); if (reconciliation === task) reconciliation = null; });
      return task;
    };
    const restored = await ui.restore();
    await reconcileLinks({ startup: true }); // Interrupted work is a report boundary before any resume.
    if (restored?.resume) {
      const restoredState = await bot.store.load();
      if (restoredState.cycle?.state === 'running' && restoredState.cycle.runId === restored.resume.runId && !(restoredState.items || []).some(i => ['processing', 'dispatch_started'].includes(i.state))) await ui.resume(restored.resume);
    }
    if (onRuntimeReady) await onRuntimeReady({
      bot, ui,
      start: ({ maxItems, stopAfterSuccess = true } = {}) => ui.begin('control', undefined, undefined, { maxItems, stopAfterSuccess }),
      stop: () => ui.stop(),
      wait: () => ui.job || Promise.resolve(),
      shutdown: stop,
      state: () => bot.store.load()
    });
    let polls = 0;
    let conflictRetries = 0;
    while (!stopping && polls < maxPolls) {
      polls += 1;
      try {
        reconcileLinks();
        // Panel delivery must never gate incoming controls or scheduled work.
        trackPanel(ui.refreshPanels());
        try {
          const schedule = (await bot.settings.get()).schedule;
          const now = clock();
          if (schedule.enabled && isDue(schedule, now)) {
            const parts = riyadhDateParts(now);
            const day = `${parts.year}-${parts.month}-${parts.day}`;
            let due = false;
            await bot.store.update(current => {
              if (current.uiScheduleDay !== day) { current.uiScheduleDay = day; due = true; }
              return current;
            });
            if (due) await ui.startScheduled();
          }
        } catch (scheduleErr) {
          logger.error(JSON.stringify({ event: 'schedule_check_error', message: scheduleErr.message }));
        }
        const updates = await api.getUpdates({ offset, timeout: pollTimeout, allowed_updates: ['message', 'callback_query'] }) || [];
        conflictRetries = 0;
        watchdog?.poll();
        let retryFromAmbiguous = false;
        for (const update of updates) {
          const id = updateId(update);
          if (id === null) continue;
          if (retryFromAmbiguous) break;
          if (id < offset || processed.has(id)) continue;
          // Dispatch first. Persisting the offset before this point can lose an
          // update forever if the process crashes while handling it.
          let dispatchResult;
          try {
            dispatchResult = await bot.transport.dispatchUpdate(update, { auth: bot.auth, actions: {
              report: async (_, raw) => {
                const destination = raw.callback_query?.message?.chat?.id || raw.message?.chat?.id;
                const { formatReport } = require('./settings');
                return bot.transport.sendMessage(destination, formatReport({
                  status: await projectStatus({ cycle: bot.cycle, queue: bot.queue, vpnSlots, lock }),
                  accounts: await bot.accounts.list(), settings: await bot.settings.get()
                }));
              },
              accountAdd: async (request, raw) => {
                const destination = raw.message.chat.id;
                const account = await bot.accounts.add({ id: request.command.args[0], label: request.command.args.slice(1).join(' ') });
                return bot.transport.sendMessage(destination, `تمت إضافة الحساب: ${account.id}`);
              },
              accountUsername: async (request, raw) => {
                const [id, username] = request.command.args;
                if (!/^[A-Za-z0-9_]{1,15}$/.test(String(username || '').replace(/^@/, ''))) {
                  return bot.transport.sendMessage(raw.message.chat.id, 'أرسل /account_username ثم معرّف الحساب واسم مستخدم X الصحيح.');
                }
                await bot.accounts.update(id, { username });
                return bot.transport.sendMessage(raw.message.chat.id, 'تم حفظ هوية الحساب المتوقعة.');
              },
              accountToggle: async (request, raw) => {
                const [id, mode] = request.command.args;
                if (!['on', 'off'].includes(mode)) return bot.transport.sendMessage(raw.message.chat.id, 'استخدم /account_toggle account-id on أو off.');
                await bot.accounts.update(id, { enabled: mode === 'on' });
                return bot.transport.sendMessage(raw.message.chat.id, mode === 'on' ? 'تم تفعيل الحساب.' : 'تم تعطيل الحساب.');
              },
              accountRemove: async (request, raw) => {
                const destination = raw.message.chat.id;
                await bot.accounts.remove(request.command.args[0]);
                return bot.transport.sendMessage(destination, 'تم حذف الحساب.');
              },
              accountsCsv: async (request, raw) => {
                const destination = raw.message.chat.id;
                let csv = request.command.rawArgs;
                if (raw.message.document) {
                  const file = await api.getFile({ file_id: raw.message.document.file_id });
                  csv = (await api.downloadFile(file.file_path)).toString('utf8');
                }
                try {
                  const accounts = await bot.accounts.replaceFromCsv(csv);
                  return bot.transport.sendMessage(destination, `تم استبدال الحسابات (${accounts.length}).`);
                } catch (err) {
                  if (err.message && err.message.includes('EMPTY_ACCOUNTS_CSV')) {
                    logStructured(logger, {
                      level: 'warn',
                      component: 'runner',
                      event: 'empty_accounts_csv_rejected',
                      operation: 'accounts.replaceFromCsv',
                      result: 'rejected',
                      errorCode: 'EMPTY_ACCOUNTS_CSV',
                      sanitizedError: sanitizeError(err),
                      suppressionReason: 'empty_accounts_csv_prevented_wipe'
                    });
                    return bot.transport.sendMessage(destination, '⚠️ تم رفض استبدال الحسابات: ملف CSV فارغ أو لا يحتوي على أي حسابات.');
                  }
                  throw err;
                }
              },
              cookie: async (request, raw) => {
                const destination = raw.message.chat.id;
                const accountId = request.command.args[0];
                let result;
                if (raw.message.document) {
                  const file = await api.getFile({ file_id: raw.message.document.file_id });
                  const content = await api.downloadFile(file.file_path);
                  result = await bot.cookies.storeContent(`cred-${require('node:crypto').randomUUID()}`, content.toString('utf8'));
                } else {
                  result = await bot.cookies.store(`cred-${require('node:crypto').randomUUID()}`, request.command.args[1]);
                }
                await bot.accounts.update(accountId, { cookieFile: result.path });
                return bot.transport.sendMessage(destination, `تم حفظ ملف جلسة الحساب ${accountId} (${result.format}). استخدم /cookie_verify ${accountId} للتحقق الآمن.`);
              },
              cookieVerify: async (request, raw) => {
                const destination = raw.message.chat.id;
                const accountId = request.command.args[0];
                const account = (await bot.accounts.list()).find(entry => entry.id === accountId);
                if (!account) throw Object.assign(new Error('Account not found'), { code: 'ACCOUNT_NOT_FOUND' });
                // Verification is idempotent and generation-fenced, but may wait
                // on X for minutes. Never occupy the poll owner ahead of Stop.
                const task = Promise.resolve().then(async () => {
                  const result = await isolatedVerifier.verify(account);
                  await bot.transport.sendMessage(destination, result.authenticated ? 'جلسة X صالحة.' : 'جلسة X غير صالحة أو لم تثبت هوية الحساب.');
                }).catch(error => {
                  logStructured(logger, {
                    level: 'error',
                    component: 'runner',
                    event: 'cookie_verify_failed',
                    accountId,
                    operation: 'cookieVerify',
                    result: 'failed',
                    errorCode: extractErrorCode(error),
                    sanitizedError: sanitizeError(error),
                    code: error.code || 'UNKNOWN'
                  });
                });
                exportTasks.add(task);
                task.finally(() => exportTasks.delete(task));
                return { verifying: true };
              },
              delay: async (request, raw) => {
                const destination = raw.message.chat.id;
                const settings = await bot.settings.setDelay(request.command.args[0]);
                return bot.transport.sendMessage(destination, `تم ضبط التأخير: ${settings.delayMs}ms.`);
              },
              quota: async (request, raw) => {
                const destination = raw.message.chat.id;
                const settings = await bot.settings.setQuota(request.command.args[0]);
                return bot.transport.sendMessage(destination, `تم ضبط الحصة اليومية: ${settings.dailyQuota}.`);
              },
              schedule: async (request, raw) => {
                const destination = raw.message.chat.id;
                const [time, enabled = 'on'] = request.command.args;
                const [hour, minute] = String(time || '09:00').split(':').map(Number);
                const settings = await bot.settings.setSchedule({ hour, minute, enabled: enabled !== 'off' });
                return bot.transport.sendMessage(destination, `تم ضبط الجدولة: ${settings.schedule.enabled ? `${settings.schedule.hour}:${String(settings.schedule.minute).padStart(2, '0')}` : 'متوقفة'}.`);
              },
              ...ui.actions()
            } });
            offset = Math.max(offset, id + 1);
            processed.add(id);
            while (processed.size > 100) processed.delete(processed.values().next().value);
            await bot.store.update(current => ({ ...current, telegram: { offset, processedUpdates: [...processed] } }));
            logger.log(JSON.stringify({ event: 'update_dispatched', action: dispatchResult.action || null, handled: dispatchResult.handled === true }));
          } catch (error) {
            // Definite application rejection is durably dead-lettered; an
            // ambiguous transport failure is retried after restart.
            if (!isAmbiguousTelegramError(error)) {
              offset = Math.max(offset, id + 1);
              processed.add(id);
              while (processed.size > 100) processed.delete(processed.values().next().value);
              await bot.store.update(current => ({ ...current, telegram: { offset, processedUpdates: [...processed] } }));
            }
            if (isAmbiguousTelegramError(error)) retryFromAmbiguous = true;
            if (error.code !== 'UNAUTHORIZED') logger.error(JSON.stringify({ event: 'update_failed', code: error.code || 'UNKNOWN' }));
          }
        }
      } catch (error) {
        if (error.telegramCode === 409 || error.statusCode === 409 || /conflict/i.test(error.message || '')) {
          if (conflictRetries < maxConflictRetries && !stopping) {
            conflictRetries += 1;
            logger.error(JSON.stringify({
              event: 'telegram_conflict_transient',
              code: 'TELEGRAM_CONFLICT_RETRY',
              message: error.message,
              retry: conflictRetries,
              backoffMs: conflictBackoffMs
            }));
            await sleepFn(conflictBackoffMs);
            continue;
          }
          logger.error(JSON.stringify({ event: 'telegram_conflict', code: 'TELEGRAM_CONFLICT', message: error.message }));
          const conflictErr = Object.assign(new Error(`Telegram polling conflict: another instance is running (${error.message})`), { code: 'TELEGRAM_CONFLICT', cause: error });
          throw conflictErr;
        }
        logger.error(JSON.stringify({ event: 'poll_failed', code: error.code || 'NETWORK' }));
        if (!stopping) await sleepFn(pollMs);
      }
    }
    logger.log(JSON.stringify({ event: 'telegram_stopped' }));
  } finally {
    await watchdog?.close();
    await ui?.destroy();
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    try {
      await ui?.stop();
      await ui?.job;
      const exportResults = await Promise.allSettled([...exportTasks]);
      for (const res of exportResults) {
        if (res.status === 'rejected') {
          logStructured(logger, {
            level: 'error',
            component: 'runner',
            event: 'shutdown_export_task_failed',
            operation: 'shutdown',
            result: 'failed',
            errorCode: extractErrorCode(res.reason),
            sanitizedError: sanitizeError(res.reason)
          });
        }
      }
      const panelResults = await Promise.allSettled([...panelTasks, ...(ui?.panelLocks?.values() || [])]);
      for (const res of panelResults) {
        if (res.status === 'rejected') {
          logStructured(logger, {
            level: 'warn',
            component: 'runner',
            event: 'shutdown_panel_task_failed',
            operation: 'shutdown',
            result: 'failed',
            errorCode: extractErrorCode(res.reason),
            sanitizedError: sanitizeError(res.reason)
          });
        }
      }
    } finally {
      try { await bot?.store?.close?.(); } finally { await release(); }
    }
  }
}

function isAmbiguousTelegramError(error) {
return Boolean(error?.ambiguous || ['TELEGRAM_TIMEOUT', 'TELEGRAM_INVALID_RESPONSE', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNABORTED'].includes(error?.code));
}

if (require.main === module) run().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { run, SingleInstanceLock, updateId, isAmbiguousTelegramError };
