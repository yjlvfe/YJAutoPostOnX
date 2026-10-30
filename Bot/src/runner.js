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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class SingleInstanceLock {
  constructor(lockPath, { timeoutMs = 1_000, retryMs = 50, staleMs = 120_000 } = {}) {
    this.lockPath = path.resolve(lockPath);
    this.timeoutMs = timeoutMs;
    this.retryMs = retryMs;
    this.staleMs = staleMs;
    this.token = null;
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
          const locked = new Error(`Telegram runner lock is held: ${this.lockPath}`);
          locked.code = 'INSTANCE_LOCKED';
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
    try { record = JSON.parse(await fs.readFile(this.lockPath, 'utf8')); } catch (_) { record = null; }
    let dead = false;
    if (Number.isInteger(record?.pid) && record.pid > 0) {
      try { process.kill(record.pid, 0); } catch (error) { dead = error.code === 'ESRCH'; }
      // A long-lived polling service is not stale just because its lock is old.
      if (!dead) return false;
    }
    if (!(dead || (!record && Date.now() - stat.mtimeMs >= this.staleMs))) return false;
    try { await fs.unlink(this.lockPath); return true; } catch (error) { return error.code === 'ENOENT'; }
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

function selectAccount(state, run, item, now = new Date()) {
  const ids = run.accountIds || [];
  const available = id => {
    const account = (state.accounts || []).find(a => a.id === id && a.enabled !== false);
    if (!account) return false;
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
  if (!identity) return true;
  if (identity.authenticated === false) return false;
  return true;
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
  lockTimeoutMs = 1_000,
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
  let ui; let bot; let abortController;
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
        answerCallback: payload => api.answerCallbackQuery(payload)
      }
    });
    const state = await bot.store.load();
    let offset = Number.isSafeInteger(state.telegram?.offset) ? state.telegram.offset : 0;
    const processed = new Set(Array.isArray(state.telegram?.processedUpdates) ? state.telegram.processedUpdates : []);
    const me = await api.getMe();
    logger.log(JSON.stringify({ event: 'telegram_ready', bot_id: me.id, username: me.username }));
    // VPN slot manager — per-account Docker containers
    const vpnSlots = vpnManager || new VpnSlotManager({ store: bot.store, logger: msg => logger.log(JSON.stringify({ event: 'vpn', message: msg })) });
    const links = createLinkExports({ store: bot.store, dataDir, api, chatIds: effectiveChatIds, logger });
    const notify = text => Promise.allSettled(effectiveChatIds.map(chat_id => Promise.resolve().then(() => api.sendMessage({ chat_id, text }))));

    let mappingsSafe = true;
    const reconcileResources = async () => {
      if (!vpnSlots.reconcile) return true; // Historical injected manager seam.
      try {
        const current = await bot.store.load();
        // Drafts own reservations until onboarding completes; they are not stale.
        const accountIds = [...new Set([...(current.accounts || []).map(a => a.id),
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
      async verify(account) {
        const attempt = attemptScope(null, attemptTimeoutMs);
        const adapter = verifyAdapterFactory ? verifyAdapterFactory() : new DirectXAdapter({ allowPublish: false });
        let session;
        try {
          const vpn = await attempt.wait(() => vpnSlots.ensure(account.id, { signal: attempt.signal }));
          const opened = Promise.resolve().then(() => adapter.open({ account, proxy: vpn.proxy, signal: attempt.signal }));
          opened.then(late => { if (attempt.signal.aborted) Promise.resolve().then(() => adapter.close({ session: late })).catch(() => {}); }, () => {});
          session = await attempt.wait(() => opened);
          const identity = session.identity;
          const result = { isolated: Boolean(vpn.exitIp), vpnHealthy: Boolean(vpn.exitIp), exitIp: vpn.exitIp,
            authenticated: Boolean(provenIdentity(identity, account)), state: identity?.state,
            username: provenIdentity(identity, account) ? identity.username : null,
            discovered: !account.username && Boolean(provenIdentity(identity, account)), resourceId: vpn.name };
          await ui?.recordAccountCheck(account.id, result, { session: true });
          return result;
        } catch (error) {
          await ui?.recordAccountCheck(account.id, { isolated: false, vpnHealthy: false, authenticated: false }, { session: true });
          throw error;
        } finally {
          const closing = Promise.resolve().then(() => adapter.close({ session, signal: attempt.signal }));
          try { await attempt.wait(() => closing); } finally { closing.catch(() => {}); attempt.dispose(); }
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
          } catch { check = { healthy: false }; }
          await ui?.recordAccountCheck(a.id, { isolated: check.healthy === true && Boolean(check.exitIp), vpnHealthy: check.healthy === true && Boolean(check.exitIp), exitIp: check.exitIp }, { source: 'vpn-slot-manager' });
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
      for (const itemId of itemIds) {
        let current = await bot.store.load();
        if (signal.aborted || current.cycle?.state !== 'running' || current.cycle.runId !== run.runId) break;
        const item = (current.items || []).find(entry => entry.id === itemId && entry.state === 'pending');
        if (!item) continue;
        const accountId = selectAccount(current, run, item, clock());
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
        let retryCount = 0, halt = false;
        while (!signal.aborted) {
        let retry = false, skipDelay = false;
        let adapter;
        let session, dispatchEntered = false, claim;
        const attempt = attemptScope(signal, attemptTimeoutMs);
        try {
          claim = await attempt.wait(() => claimCycleItem({ store: bot.store, itemId, accountId, runId: run.runId, signal: attempt.signal, clock }));
          if (!claim.claimed) {
            break;
          }
          let vpn;
          try {
            vpn = await attempt.wait(() => vpnSlots.ensure(accountId, { signal: attempt.signal }));
            await ui.recordAccountCheck(accountId, { isolated: Boolean(vpn.exitIp), vpnHealthy: Boolean(vpn.exitIp), exitIp: vpn.exitIp }, { source: 'vpn-slot-manager' });
          }
          catch (err) {
            await ui.recordAccountCheck(accountId, { isolated: false, vpnHealthy: false }, { source: 'vpn-slot-manager' });
            logger.error(JSON.stringify({ event: 'vpn_failed', account: accountId, code: err.code || 'VPN_ERROR' }));
            await bot.store.update(s => { const i = s.items.find(x => x.id === itemId); if (i?.state === 'processing') { i.state = 'pending'; delete i.attempt; } return s; });
            halt = true;
            await notify('تعذر الاتصال بشبكة VPN للحساب؛ توقفت الدورة وبقي المنشور في الانتظار.');
            break;
          }
          if (signal.aborted || (await bot.store.load()).cycle?.state !== 'running') {
            await bot.store.update(s => { const i = s.items.find(x => x.id === itemId); if (i?.state === 'processing') i.state = 'pending'; return s; });
            break;
          }
          adapter = publishAdapterFactory ? publishAdapterFactory() : new DirectXAdapter({ allowPublish: true });
          const opened = Promise.resolve().then(() => adapter.open({ account, proxy: vpn.proxy, signal: attempt.signal }));
          // A dependency ignoring cancellation may resolve after the deadline.
          opened.then(late => { if (attempt.signal.aborted) Promise.resolve().then(() => adapter.close({ session: late })).catch(() => {}); }, () => {});
          session = await attempt.wait(() => opened);
          if (provenIdentity(session.identity, account)) await ui.recordAccountCheck(accountId, {
            isolated: true, vpnHealthy: Boolean(vpn.exitIp), exitIp: vpn.exitIp,
            authenticated: true, username: session.identity.username
          }, { session: true, source: 'isolated-verifier' });
          else if (!publishAdapterFactory || session.identity?.username != null || session.identity?.userId != null) {
            await ui.recordAccountCheck(accountId, { isolated: true, vpnHealthy: Boolean(vpn.exitIp), exitIp: vpn.exitIp, authenticated: false }, { session: true });
            throw Object.assign(new Error('Identity unverified'), { code: 'DIRECT_X_AUTH_IDENTITY_UNVERIFIED' });
          }
          if (signal.aborted) { await bot.store.update(s => { const i = s.items.find(x => x.id === item.id); if (i?.state === 'processing') i.state = 'pending'; return s; }); break; }
          if (!session.identity?.authenticated) {
            await bot.store.update(s => { const i = s.items.find(x => x.id === item.id); if (i?.state === 'processing') i.state = 'pending'; return s; });
            await notify('تعذر تسجيل الدخول: ملف جلسة الحساب غير صالح أو الحساب مقيد. يرجى فحص الحساب والكوكيز.');
            halt = true;
          } else {
          let dispatchCalled = false;
          const onDispatch = async ({ accountId: reportedAccountId } = {}) => {
            if (dispatchCalled || attempt.signal.aborted || (reportedAccountId != null && reportedAccountId !== accountId)) throw Object.assign(new Error('Dispatch not admitted'), { code: 'DISPATCH_REJECTED' });
            dispatchCalled = true;
            let dispatchReady = false;
            dispatchEntered = true; // Failed durable acknowledgement may have committed.
            await attempt.wait(() => bot.store.update(s => {
              const i = s.items.find(x => x.id === itemId);
              const a = s.accounts.find(x => x.id === accountId && x.enabled !== false);
              if (!attempt.signal.aborted && s.cycle?.state === 'running' && s.cycle.runId === run.runId &&
                i?.state === 'processing' && i.attempt?.phase === 'claimed' && i.attempt?.token === claim.token &&
                i.attempt.runId === run.runId && i.attempt.accountId === accountId &&
                a?.username === account.username && a?.cookieFile === account.cookieFile && a?.userId === account.userId &&
                accountCapacity(s, a, clock()).remaining > 0 && JSON.stringify(i.payload) === JSON.stringify(item.payload)) {
                i.attempt.phase = 'dispatching'; dispatchReady = true;
              }
              return s;
            }));
            if (!dispatchReady || attempt.signal.aborted) throw Object.assign(new Error('Dispatch not admitted'), { code: 'DISPATCH_REJECTED' });
            return true;
          };
          // Historical injected adapters have no pre-send callback. Preserve that
          // test seam with an explicit pre-call fence; production Direct always
          // uses its precise bridge dispatch-ready handshake, never this path.
          if (publishAdapterFactory && !(adapter instanceof DirectXAdapter) && adapter.supportsDispatchCallback !== true) await onDispatch({ accountId });
          // Queue routing is runner metadata, not a direct-X content field.
          const directPayload = { ...item.payload }; delete directPayload.account;
          const result = await attempt.wait(() => adapter.publish({ session, payload: adapter instanceof DirectXAdapter ? directPayload : item.payload, confirmPublish: true, signal: attempt.signal, onDispatch }));
          if (result.published && !dispatchEntered) throw Object.assign(new Error('Missing dispatch fence'), { code: 'DISPATCH_FENCE_MISSING' });
          const callbackAdapter = adapter instanceof DirectXAdapter || adapter.supportsDispatchCallback === true;
          const newState = result.published && result.url ? 'published' : result.published || result.ambiguous || (callbackAdapter && dispatchEntered) ? 'ambiguous' : ['text_too_long', 'tweet_too_long'].includes(result.reason) ? 'cancelled' : 'pending';
          const publishedAt = new Date(clock()).toISOString();
          await bot.store.update(s => {
            const i = s.items.find(x => x.id === item.id);
            s.posting ||= {};
            s.posting.publishingAt = null;
            if (i) {
              delete i.attempt;
              const wasProcessing = i.state === 'processing';
              i.state = newState; i.reason = result.reason || null;
              if (newState === 'published') {
                i.publishedAt = publishedAt; i.url = result.url; i.accountId = accountId; i.accountUsername = account.username;
                if (wasProcessing) {
                  s.posting.quota ||= {};
                  const day = riyadhDay(new Date(publishedAt));
                  s.posting.quota[day] ||= {};
                  s.posting.quota[day][accountId] = (s.posting.quota[day][accountId] || 0) + 1;
                }
                // Publication confirmation and the next inter-publication
                // deadline are one durable state transition. This prevents a
                // restart after confirmation from bypassing the delay.
                const minSeconds = Number.isSafeInteger(s.settings?.delayMinSeconds) ? s.settings.delayMinSeconds : 15;
                const maxSeconds = Number.isSafeInteger(s.settings?.delayMaxSeconds) ? Math.max(minSeconds, s.settings.delayMaxSeconds) : minSeconds;
                const delaySeconds = Math.max(15, randomInt(minSeconds, maxSeconds + 1));
                s.posting.nextPostAt = new Date(new Date(publishedAt).getTime() + delaySeconds * 1000).toISOString();
              }
            }
            return s;
          });
          logger.log(JSON.stringify({ event: 'post_result', item: item.id, status: newState, account: accountId, reason: result.reason || result.status, url: result.url || null }));
          if (newState === 'published') {
            try { await links.write({ publishedAt }); } catch (error) { logger.error(JSON.stringify({ event: 'export_write_failed', code: error.code || 'UNKNOWN' })); await notify('تعذر حفظ ملف روابط المنشورات؛ يرجى مراجعة السجل وإعادة المحاولة.'); }
            ui.refreshPanels(true);
            if (onPostPersisted) await onPostPersisted({ itemId: item.id, accountId, publishedAt, url: result.url, stop: () => ui.stop() });
            if (run.stopAfterSuccess) { await ui.stop(); halt = true; }
          } else if (newState === 'ambiguous') {
            await notify('نتيجة النشر غير مؤكدة؛ توقفت الدورة ولن يعاد إرسال المنشور تلقائياً. يرجى التحقق من حساب X.');
            halt = true;
          } else if (result.blocked || /challenge|blocked|restrict|auth|login|cookie|vpn|rate.?limit/i.test(String(result.reason || '') + ' ' + String(result.status || ''))) {
            await notify('الحساب مقيد أو يتطلب تحققاً أمنياً؛ توقفت الدورة، يرجى فحص الحساب وملف الجلسة.');
            halt = true;
          } else if (newState === 'pending') { retry = true; }
          else if (newState === 'cancelled') { skipDelay = true; }
          }
        } catch (err) {
          logger.error(JSON.stringify({ event: 'post_error', item: item.id, code: err.code || 'UNKNOWN' }));
          await bot.store.update(s => { const i = s.items.find(x => x.id === item.id); if (i?.state === 'processing') { i.state = dispatchEntered || i.attempt?.phase === 'dispatching' ? 'ambiguous' : 'pending'; if (i.state === 'pending') delete i.attempt; } if (s.posting) s.posting.publishingAt = null; return s; });
          if (dispatchEntered) { await notify('نتيجة النشر غير مؤكدة؛ توقفت الدورة ولن يعاد إرسال المنشور تلقائياً.'); halt = true; }
          else if (/auth|login|cookie|challenge|restrict|vpn/i.test(String(err.code || '') + ' ' + String(err.message || ''))) { await notify('تعذر تسجيل الدخول أو الاتصال الآمن؛ توقفت الدورة وبقي المنشور في الانتظار.'); halt = true; }
          else if (['ATTEMPT_TIMEOUT', 'ATTEMPT_ABORTED', 'DISPATCH_REJECTED', 'DISPATCH_FENCE_MISSING'].includes(err.code)) halt = true;
          else retry = true;
        } finally {
          if (adapter) {
            const closing = Promise.resolve().then(() => adapter.close({ session, signal: attempt.signal }));
            try { await attempt.wait(() => closing); } catch { halt = true; }
            closing.catch(() => {});
          }
          attempt.dispose();
          await bot.store.update(s => {
            const i = s.items.find(x => x.id === itemId);
            if (i?.state === 'processing' && i.attempt?.token === claim?.token && i.attempt?.phase === 'claimed') { i.state = 'pending'; delete i.attempt; }
            if (s.posting) s.posting.publishingAt = null;
            return s;
          });
        }
        if (halt || signal.aborted) break;
        if (retry && retryCount < 3) { await sleepFn(1000 * 2 ** retryCount++); continue; }
        if (retry) await notify('تعذر نشر المنشور بعد المحاولات؛ بقي في الانتظار.');
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
        if (halt || signal.aborted) break;
      }
      const finished = await bot.store.load();
      const quota = quotaAdmission(finished, { accounts: (finished.accounts || []).filter(a => (run.accountIds || []).includes(a.id)), items: (finished.items || []).filter(i => itemIds.has(i.id)), now: clock() });
      if (!signal.aborted && quota.exhausted) {
        await stopCycleForQuota({ store: bot.store, runId: run.runId });
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
      onCycleStop: run => { abortController?.abort(); sendExport(run); },
      onCycleFinished: run => sendExport(run, { emptyMessage: false }) });
    // One reconciliation in flight bounds polling work; the tracked task is
    // drained before store close. Transport errors must not stop admission.
    let reconciliation;
    const reconcileLinks = () => {
      if (reconciliation) return reconciliation;
      const task = links.reconcile().catch(error => {
        logger.error(JSON.stringify({ event: 'export_reconcile_failed', code: error.code || 'UNKNOWN' }));
      });
      reconciliation = task;
      exportTasks.add(task);
      task.finally(() => { exportTasks.delete(task); if (reconciliation === task) reconciliation = null; });
      return task;
    };
    const restored = await ui.restore();
    await reconcileLinks(); // Unsafe restoration may stop work, but exports remain owed.
    if (restored?.resume) {
      const restoredState = await bot.store.load();
      if (restoredState.cycle?.state === 'running' && restoredState.cycle.runId === restored.resume.runId && !(restoredState.items || []).some(i => ['processing', 'ambiguous', 'dispatch_started'].includes(i.state))) await ui.resume(restored.resume);
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
    while (!stopping && polls < maxPolls) {
      polls += 1;
      try {
        reconcileLinks();
        await ui.refreshPanels();
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
        const updates = await api.getUpdates({ offset, timeout: pollTimeout, allowed_updates: ['message', 'callback_query'] }) || [];
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
                const accounts = await bot.accounts.replaceFromCsv(csv);
                return bot.transport.sendMessage(destination, `تم استبدال الحسابات (${accounts.length}).`);
              },
              cookie: async (request, raw) => {
                const destination = raw.message.chat.id;
                const accountId = request.command.args[0];
                let result;
                if (raw.message.document) {
                  const file = await api.getFile({ file_id: raw.message.document.file_id });
                  const content = await api.downloadFile(file.file_path);
                  result = await bot.cookies.storeContent(accountId, content.toString('utf8'));
                } else {
                  result = await bot.cookies.store(accountId, request.command.args[1]);
                }
                await bot.accounts.update(accountId, { cookieFile: result.path });
                return bot.transport.sendMessage(destination, `تم حفظ ملف جلسة الحساب ${accountId} (${result.format}). استخدم /cookie_verify ${accountId} للتحقق الآمن.`);
              },
              cookieVerify: async (request, raw) => {
                const destination = raw.message.chat.id;
                const accountId = request.command.args[0];
                const account = (await bot.accounts.list()).find(entry => entry.id === accountId);
                if (!account) throw Object.assign(new Error('Account not found'), { code: 'ACCOUNT_NOT_FOUND' });
                const result = await isolatedVerifier.verify(account);
                return bot.transport.sendMessage(destination, result.authenticated ? 'جلسة X صالحة.' : 'جلسة X غير صالحة أو لم تثبت هوية الحساب.');
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
        logger.error(JSON.stringify({ event: 'poll_failed', code: error.code || 'NETWORK' }));
        if (!stopping) await sleepFn(pollMs);
      }
    }
    logger.log(JSON.stringify({ event: 'telegram_stopped' }));
  } finally {
    await ui?.destroy();
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    try { await ui?.stop(); await ui?.job; await Promise.allSettled([...exportTasks]); await Promise.allSettled([...panelTasks, ...(ui?.panelLocks?.values() || [])]); } finally { try { await bot?.store?.close?.(); } finally { await release(); } }
  }
}

function isAmbiguousTelegramError(error) {
return Boolean(error?.ambiguous || ['TELEGRAM_TIMEOUT', 'TELEGRAM_INVALID_RESPONSE', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNABORTED'].includes(error?.code));
}

if (require.main === module) run().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { run, SingleInstanceLock, updateId, isAmbiguousTelegramError };
