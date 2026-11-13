'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createTelegramApi } = require('./telegramApi');
const { config } = require('./env');
const { createBot } = require('./index');
const { projectStatus } = require('./status');
const { createPublicationScheduler } = require('./scheduling');
const { TelegramUi } = require('./telegramUi');
const { createLinkExports } = require('./linkExports');
const { DirectXAdapter } = require('./directX');
const { VpnSlotManager } = require('./dockerVpn');
const { riyadhDay, accountCapacity, quotaAdmission } = require('./quota');
const { isPublicIp } = require('./publicIp');
const { normalizeSubnet } = require('./forensicLogger');
const { logStructured, sanitizeError, extractErrorCode } = require('./structuredLogger');
const { isKnownTwikitParserFailure } = require('./knownTwikitParserFailure');
const { isXContentRejection } = require('./xFailureClassification');
const { recordUnsuccessfulAttempt, recordRunAttemptOutcome } = require('./attemptOutcomes');
const { classifyPublishOutcome, buildOwnerAssistedIntent } = require('./publishOutcome');
const { SingleInstanceLock } = require('./singleInstance');
const { isClaimableInState, protectedTextKeys, isProvenPreDispatch, MAX_PRE_DISPATCH_RETRIES } = require('./queue');
const { AccountWorkerPool } = require('./accountWorkerPool');
// An isolated candidate must never be shown as live while this runner still
// writes canonical JSON. Fail before acquiring resources, not after startup.
function normalizedRuntimeGuard(options = {}) {
  if (options.enableNormalizedMutation || options.enableNormalizedDashboard || options.normalizedDashboardReader) {
    throw Object.assign(new Error('NORMALIZED_RUNTIME_NOT_INTEGRATED'), { code: 'NORMALIZED_RUNTIME_NOT_INTEGRATED' });
  }
}
const {
  isCaptchaStatus,
  isBannedStatus,
  isUnverifiedStatus,
  isAccountInactive,
  evaluateAccountUse,
  MAX_COOKIE_FILE_BYTES
} = require('./accounts');

const sleep = (ms, signal) => new Promise(resolve => {
  if (signal?.aborted) return resolve();
  let done = false;
  let timer = null;
  const finish = () => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', finish);
    resolve();
  };
  timer = setTimeout(finish, Math.max(0, Number(ms) || 0));
  if (typeof timer?.unref === 'function') timer.unref();
  signal?.addEventListener('abort', finish, { once: true });
});

function sleepWithSignal(sleepImpl, ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  const waitPromise = Promise.resolve(sleepImpl(ms, signal));
  if (!signal) return waitPromise;
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve();
    signal.addEventListener('abort', onAbort, { once: true });
    waitPromise.then(
      val => { signal.removeEventListener('abort', onAbort); resolve(val); },
      err => { signal.removeEventListener('abort', onAbort); reject(err); }
    );
  });
}

function isNonPenalizingPreDispatchError(err, { signal } = {}) {
  if (signal?.aborted) return true;
  const code = String(err?.code || '').toUpperCase();
  if ([
    'ATTEMPT_ABORTED', 'BORROW_ABORTED', 'POOL_FENCED', 'POOL_CLOSED',
    'PREPARATION_ABORTED', 'ACCOUNT_WORKER_DRAINING', 'MAX_PROJECT_SESSIONS_EXCEEDED',
    'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNABORTED',
    'DIRECT_X_IDENTITY_READ_UNAVAILABLE'
  ].includes(code)) return true;
  if (/^(VPN_|POOL_|WORKER_|PROXY_|SOCKS_)/.test(code)) return true;
  return err?.transientError === true;
}

function isTransientSettlementError(err) {
  const code = String(err?.code || '').toUpperCase();
  if ([
    'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND',
    '57P01', '57P02', '57P03', '40001', '40P01', '08006', '08003', '08001'
  ].includes(code)) return true;
  return /econnreset|etimedout|terminating connection|connection.*terminated|deadlock|serialization failure|connection refused/i.test(String(err?.message || ''));
}

const MAX_WEIGHTED_TWEET_CHARS = 280;
const TCO_URL_WEIGHT = 23;

function withBoundedTimeout(promise, ms, code = 'OPERATION_TIMEOUT') {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error(`Operation timed out after ${ms}ms`), { code }));
    }, ms);
    if (typeof timer?.unref === 'function') timer.unref();
  });
  return Promise.race([Promise.resolve(promise), timeoutPromise]).finally(() => {
    clearTimeout(timer);
  });
}

function moveItemToTailLocal(state, itemId) {
  if (!state || !itemId) return false;
  const queueMod = require('./queue');
  if (typeof queueMod.moveItemToQueueTail === 'function') {
    queueMod.moveItemToQueueTail(state, itemId);
  } else if (Array.isArray(state.items)) {
    const idx = state.items.findIndex(entry => entry && entry.id === itemId);
    if (idx >= 0 && idx < state.items.length - 1) {
      const [moved] = state.items.splice(idx, 1);
      state.items.push(moved);
    }
  }
  const runItemIds = state.telegramUi?.run?.itemIds;
  if (Array.isArray(runItemIds)) {
    const rIdx = runItemIds.indexOf(itemId);
    if (rIdx >= 0 && rIdx < runItemIds.length - 1) {
      runItemIds.splice(rIdx, 1);
      runItemIds.push(itemId);
    }
  }
  return true;
}

function computeWeightedTweetLength(text) {
  if (typeof text !== 'string' || !text) return 0;
  const normalized = text.normalize('NFC');
  let urlWeight = 0;
  const withoutUrls = normalized.replace(/https?:\/\/\S+/gi, () => {
    urlWeight += TCO_URL_WEIGHT;
    return '';
  });
  let charWeight = 0;
  for (const ch of withoutUrls) {
    const cp = ch.codePointAt(0);
    // X twitter-text v3 weight-1 code point ranges
    const isSingleWeight =
      (cp >= 0x0000 && cp <= 0x10ff) ||
      (cp >= 0x2000 && cp <= 0x200d) ||
      (cp >= 0x2010 && cp <= 0x201f) ||
      (cp >= 0x2032 && cp <= 0x2037);
    charWeight += isSingleWeight ? 1 : 2;
  }
  return urlWeight + charWeight;
}

function archiveAttemptRecord(item, extra = {}) {
  if (!item?.attempt) return;
  const archived = {
    ...structuredClone(item.attempt),
    ...extra
  };
  item.archivedAttempt = archived;
  item.archivedAttempts = Array.isArray(item.archivedAttempts) ? item.archivedAttempts : [];
  item.archivedAttempts.push(archived);
  if (item.archivedAttempts.length > 10) {
    item.archivedAttempts = item.archivedAttempts.slice(-10);
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
  const claimToken = crypto.randomUUID();
  let result = { claimed: false, reason: 'item_unavailable', token: claimToken };
  await store.update(state => {
    result = { claimed: false, reason: 'item_unavailable', token: claimToken };
    if (state.cycle?.state !== 'running' || state.cycle.runId !== runId) { result.reason = 'cycle_stopped'; return state; }
    if (signal?.aborted) { result.reason = 'aborted'; return state; }
    const item = (state.items || []).find(entry => entry.id === itemId);
    if (!isClaimableInState(item, state)) return state;
    const account = (state.accounts || []).find(entry =>
      entry.id === accountId &&
      entry.enabled !== false &&
      evaluateAccountUse(state, entry, { nowMs: new Date(clock()).getTime(), requireOwnerEnabled: true }).allowed &&
      !entry.needsOwnerCaptcha &&
      !isCaptchaStatus(entry.status) &&
      !isBannedStatus(entry.status) &&
      !isUnverifiedStatus(entry.status) &&
      entry.status !== 'معزول (3 إخفاقات)' &&
      (entry.failures || 0) < 3
    );
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
    if (!evaluateAccountUse(state, account, { nowMs: now.getTime(), requireOwnerEnabled: true }).allowed) return false;
    const hasValidCookie = typeof account.cookieFile === 'string' && account.cookieFile.trim();
    if (
      account.needsOwnerCaptcha ||
      isCaptchaStatus(account.status) ||
      isBannedStatus(account.status) ||
      isUnverifiedStatus(account.status) ||
      isAccountInactive(account.status) ||
      account.status === 'معزول (3 إخفاقات)' ||
      (account.failures || 0) >= 3
    ) return false;
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
  timer?.unref?.();
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

const X_STATUS_URL_RE = /^https:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d{10,25})(?:[/?#].*)?$/i;

async function settleOwnerAssistedPost(storeOrOptions, maybeOptions = {}) {
  const isFirstArgStore = storeOrOptions && typeof storeOrOptions.update === 'function';
  const store = isFirstArgStore ? storeOrOptions : storeOrOptions?.store;
  const options = isFirstArgStore ? (maybeOptions || {}) : (storeOrOptions || {});
  const { itemId, accountId, url, clock = () => new Date(), dataDir, api, chatIds, auth, logger = console } = options;

  if (!store || typeof store.update !== 'function') {
    throw new TypeError('settleOwnerAssistedPost requires a valid store');
  }
  if (!itemId) {
    throw Object.assign(new Error('itemId is required'), { code: 'OWNER_ASSISTED_ITEM_REQUIRED' });
  }
  const cleanUrl = String(url || '').trim();
  const match = X_STATUS_URL_RE.exec(cleanUrl);
  if (!match) {
    throw Object.assign(new Error('Invalid X status URL: expected https://x.com/<user>/status/<snowflake>'), { code: 'INVALID_X_STATUS_URL' });
  }
  const [, urlUsername, tweetId] = match;
  const snapshot = await store.load();
  const before = (snapshot.items || []).find(entry => entry.id === itemId);
  if (!before) throw Object.assign(new Error('Item not found'), { code: 'ITEM_NOT_FOUND' });
  if (before.state === 'published') {
    if (String(before.tweetId) !== tweetId) throw Object.assign(new Error('Published tweet conflict'), { code: 'PUBLISHED_TWEET_CONFLICT' });
    return { settled: true, item: structuredClone(before), url: before.url, tweetId, accountId: before.accountId, publishedAt: before.publishedAt };
  }
  if (!['pending', 'owner_assisted'].includes(before.state) || !before.ownerAssistedPackage) throw Object.assign(new Error('Not an owner-assisted handoff'), { code: 'INVALID_ITEM_STATE' });
  const selectedId = before.ownerAssistedPackage.accountId || before.accountId || before.payload?.account;
  const selected = (snapshot.accounts || []).find(a => a.id === selectedId);
  const reject = reason => Object.assign(new Error('unverified_publication_claim'), { code: 'unverified_publication_claim', reason });
  if (!selected || (accountId && accountId !== selected.id) || !selected.username || !selected.userId || selected.username.toLowerCase() !== urlUsername.toLowerCase()) throw reject('wrong_author');
  if (typeof options.verifyTweet !== 'function') throw reject('no_verifier');
  let proof;
  try { proof = await options.verifyTweet({ tweetId, url: cleanUrl, accountId: selected.id, username: selected.username, userId: selected.userId, expectedText: before.payload?.text }); }
  catch { throw reject('verifier_error'); }
  if (proof?.verified !== true) throw reject('not_verified');
  if (String(proof.tweetId) !== tweetId) throw reject('id_mismatch');
  if (String(proof.userId) !== String(selected.userId) || typeof proof.username !== 'string' || proof.username.toLowerCase() !== selected.username.toLowerCase()) throw reject('wrong_author');
  const publishedAt = new Date(clock()).toISOString();
  let newlySettled = false;
  let settledItem = null;
  let resolvedAccountId = null;

  await store.update(state => {
    settledItem = null;
    resolvedAccountId = null;
    const item = (state.items || []).find(entry => entry.id === itemId);
    if (!item) {
      throw Object.assign(new Error(`Item ${itemId} not found`), { code: 'ITEM_NOT_FOUND' });
    }
    if (item.state === 'published') {
      if (String(item.tweetId) !== tweetId) throw Object.assign(new Error('Published tweet conflict'), { code: 'PUBLISHED_TWEET_CONFLICT' });
      settledItem = structuredClone(item);
      resolvedAccountId = item.accountId || null;
      return state;
    }
    if (item.state !== 'pending' && item.state !== 'owner_assisted') {
      throw Object.assign(new Error(`Cannot settle item in state ${item.state}`), { code: 'INVALID_ITEM_STATE' });
    }
    const candidateAccountId = accountId || item.ownerAssistedPackage?.accountId || item.accountId || item.payload?.account || null;
    const acc = (state.accounts || []).find(a =>
      (candidateAccountId && a.id === candidateAccountId) ||
      (!candidateAccountId && a.username && a.username.toLowerCase() === urlUsername.toLowerCase())
    );
    if (acc?.username && acc.username.toLowerCase() !== urlUsername.toLowerCase()) {
      throw Object.assign(new Error('URL username does not match account username'), { code: 'ACCOUNT_USERNAME_MISMATCH' });
    }
    if (!item.ownerAssistedPackage || candidateAccountId !== selected.id || acc?.id !== selected.id || acc.userId !== selected.userId || acc.username !== selected.username || JSON.stringify(item.payload) !== JSON.stringify(before.payload)) throw reject('state_changed');
    if ((state.items || []).some(entry => entry.id !== itemId && entry.state === 'published' && String(entry.tweetId) === tweetId)) throw Object.assign(new Error('Tweet already claimed'), { code: 'TWEET_ALREADY_CLAIMED' });
    newlySettled = true;
    resolvedAccountId = candidateAccountId || acc?.id || null;
    const resolvedUsername = acc?.username || item.ownerAssistedPackage?.username || urlUsername;

    if (item.attempt) {
      archiveAttemptRecord(item, { settledAt: publishedAt, outcomeState: 'published' });
      delete item.attempt;
    }
    item.state = 'published';
    item.publishedAt = publishedAt;
    item.url = cleanUrl;
    item.tweetId = tweetId;
    item.accountId = resolvedAccountId;
    item.accountUsername = resolvedUsername;
    item.reason = null;
    delete item.failureDiagnostic;
    if (item.ownerAssistedPackage) {
      item.ownerAssistedPackage = {
        ...item.ownerAssistedPackage,
        settledAt: publishedAt,
        url: cleanUrl,
        tweetId
      };
    }
    if (acc) {
      acc.failures = 0;
    }
    state.posting ||= {};
    state.posting.quota ||= {};
    const day = riyadhDay(new Date(publishedAt));
    state.posting.quota[day] ||= {};
    if (resolvedAccountId) {
      state.posting.quota[day][resolvedAccountId] = (state.posting.quota[day][resolvedAccountId] || 0) + 1;
    }
    settledItem = structuredClone(item);
    return state;
  });

  if (!newlySettled) return { settled: true, item: settledItem, url: settledItem.url, tweetId, accountId: resolvedAccountId, publishedAt: settledItem.publishedAt };
  const rawChatIds = [
    ...(Array.isArray(chatIds) ? chatIds : parseIdList(chatIds))
  ];
  let effectiveChatIds = [];
  if (auth && typeof auth.filterChatIds === 'function') {
    effectiveChatIds = auth.filterChatIds(rawChatIds);
  } else if (auth && auth.chats instanceof Set && auth.chats.size > 0) {
    effectiveChatIds = [...new Set(rawChatIds.map(String))].filter(id => auth.chats.has(id));
  } else if (auth && auth.allowAll) {
    effectiveChatIds = [...new Set(rawChatIds.map(String))];
  }
  const effectiveDataDir = dataDir || (store.file ? path.dirname(store.file) : path.join(__dirname, '..', 'data'));
  const links = createLinkExports({
    store,
    dataDir: effectiveDataDir,
    api,
    chatIds: effectiveChatIds,
    logger,
    clock
  });
  if (settledItem) {
    await links.write(settledItem);
  }
  await links.reconcile({ deliver: Boolean(api) });

  return {
    settled: true,
    item: settledItem,
    url: cleanUrl,
    tweetId,
    accountId: resolvedAccountId,
    publishedAt
  };
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
  workerPool: injectedWorkerPool = null,
  bot: injectedBot = null,
  publishAdapterFactory,
  verifyAdapterFactory,
  attemptTimeoutMs = 180_000,
  openTeardownTimeoutMs = 2_000,
  closeTimeoutMs = 5_000,
  shutdownTimeoutMs = 15_000,
  normalizedDashboardReader: injectedNormalizedDashboardReader = null,
  enableNormalizedDashboard = false,
  enableNormalizedMutation = false
} = {}) {
  normalizedRuntimeGuard({ enableNormalizedMutation, enableNormalizedDashboard, normalizedDashboardReader: injectedNormalizedDashboardReader });
  if (!Number.isFinite(attemptTimeoutMs) || attemptTimeoutMs < 1 || attemptTimeoutMs > 600_000) throw new TypeError('Invalid attempt timeout');
  const effectiveUserIds = Array.from(new Set([...parseIdList(userId), ...parseIdList(allowedUserIds)]));
  const effectiveChatIds = Array.from(new Set([...parseIdList(chatId), ...parseIdList(allowedChatIds)]));
  if (!parseIdList(userId).length || !parseIdList(chatId).length || !effectiveUserIds.length || !effectiveChatIds.length) throw new Error('BOT_OWNER_ID and BOT_OWNER_CHAT_ID are required');
  const lock = new SingleInstanceLock(lockPath, { timeoutMs: lockTimeoutMs });
  const release = await lock.acquire();
  let stopping = false;
  const pollController = new AbortController();
  let ui; let bot; let abortController; let watchdog; let stopDailyLinks; let publicationScheduler; let unsubscribeSchedule; let loopDelay; let metricsTimer; let workerPool;
  let schedulerStopPromise = null;
  let pendingScheduleTick = null;
  const panelTasks = new Set();
  const trackPanel = promise => { const task = Promise.resolve(promise).catch(error => logger.error(JSON.stringify({ event: 'panel_refresh_failed', code: error.code || 'UNKNOWN' }))); panelTasks.add(task); task.finally(() => panelTasks.delete(task)).catch(() => {}); return task; };
  const exportTasks = new Set();
  const forensicTasks = new Set();
  const trackForensic = promise => {
    if (!promise || typeof promise.then !== 'function') return promise;
    const task = Promise.resolve(promise);
    forensicTasks.add(task);
    task.finally(() => forensicTasks.delete(task)).catch(() => {});
    return task;
  };
  const stop = () => {
    stopping = true;
    pollController.abort();
    stopDailyLinks?.();
    const stopSched = publicationScheduler?.stop?.();
    if (stopSched) schedulerStopPromise = stopSched;
    ui?.cancelPendingStarts();
    unsubscribeSchedule?.();
    abortController?.abort();
    workerPool?.fenceAdmission();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    bot = injectedBot || createBot({
      dataDir,
      auth: { allowedUserIds: effectiveUserIds, allowedChatIds: effectiveChatIds },
      accountLifecycle: {
        beforeMutation: async ({ operation, accountId }) => {
          if (operation === 'remove' || operation === 'replace') { await ui?.stop(); await ui?.job; }
          if (accountId) { await workerPool?.drain(accountId).catch(() => {}); }
        },
        onChange: async (accounts, { before = [] } = {}) => {
          const retained = new Set(accounts.map(account => account.id));
          for (const account of before) if (!retained.has(account.id)) {
            try {
              await workerPool?.drain(account.id).catch(() => {});
              await vpnSlots.release(account.id);
            }
            catch (error) { mappingsSafe = false; logger.error(JSON.stringify({ event: 'vpn_release_failed', code: error.code || 'VPN_RELEASE_FAILED' })); }
          }
          await reconcileResources();
        }
      },
      telegram: {
        send: payload => api.sendMessage(payload),
        ...(typeof api?.sendRichMessage === 'function' ? { sendRichMessage: payload => api.sendRichMessage(payload) } : {}),
        editMessageText: payload => api.editMessageText(payload),
        deleteMessage: payload => api.deleteMessage ? api.deleteMessage(payload) : Promise.resolve(),
        answerCallback: payload => api.answerCallbackQuery(payload)
      }
    });
    bot.logger = logger;
    // Normalized runtime is fail-closed until all canonical writer seams move.
    loopDelay=require('node:perf_hooks').monitorEventLoopDelay({resolution:20});loopDelay.enable();
    let previousUsage=process.cpuUsage(),previousMetricAt=Date.now();
    metricsTimer=setInterval(()=>{
      const elapsed=Date.now()-previousMetricAt,usage=process.cpuUsage(previousUsage);
      previousUsage=process.cpuUsage();previousMetricAt=Date.now();
      logger.log(JSON.stringify({event:'control_plane_resources',windowMs:elapsed,
        eventLoopP50Ms:+(loopDelay.percentile(50)/1e6).toFixed(2),eventLoopP95Ms:+(loopDelay.percentile(95)/1e6).toFixed(2),eventLoopMaxMs:+(loopDelay.max/1e6).toFixed(2),
        cpuMs:+((usage.user+usage.system)/1000).toFixed(2),rssBytes:process.memoryUsage().rss}));
      loopDelay.reset();
    },30000);metricsTimer.unref?.();
    await bot.queue.recoverProcessing({ state: 'ambiguous', reason: 'startup_crash_recovery' });
    await bot.store.update(s => {
      if (Array.isArray(s.linkOutbox)) {
        for (const entry of s.linkOutbox) {
          if (entry && entry.status === 'sending') entry.status = 'ambiguous';
        }
      }
      if (Array.isArray(s.notificationOutbox)) {
        for (const entry of s.notificationOutbox) {
          if (entry && (entry.status === 'sending' || entry.status === 'pending')) {
            entry.status = 'suppressed';
            entry.suppressed = true;
          }
        }
      }
      return s;
    });
    const state = await bot.store.load();
    let offset = Number.isSafeInteger(state.telegram?.offset) ? state.telegram.offset : 0;
    const processed = new Set(Array.isArray(state.telegram?.processedUpdates) ? state.telegram.processedUpdates : []);
    const persistTelegramProgress = async (nextOffset, nextProcessed) => {
      await bot.store.telegramProgress({ offset: nextOffset, processedUpdates: [...nextProcessed] });
      offset = nextOffset;
      processed.clear();
      for (const updateIdValue of nextProcessed) processed.add(updateIdValue);
    };
    const me = await api.getMe();
    watchdog = require('./watchdog').startWatchdog({
      onReady: () => logger.log(JSON.stringify({ event: 'watchdog_ready', action: 'alert_only', timeoutMs: 180000 })),
      onAlarm: result => logger.error(JSON.stringify({ event: 'watchdog_alarm', ...result }))
    });
    logger.log(JSON.stringify({ event: 'telegram_ready', bot_id: me.id, username: me.username }));
    // VPN slot manager — per-account Docker containers
    // Production must reuse the five pre-authorized VPN containers only.
    // VpnSlotManager defaults allowContainerCreate to false; do not override
    // that safety boundary from the service runner.
    const vpnSlots = vpnManager || new VpnSlotManager({ store: bot.store, logger: msg => logger.log(JSON.stringify({ event: 'vpn', message: msg })) });
    bot.vpnManager = vpnSlots;
    workerPool = injectedWorkerPool || new AccountWorkerPool({
      maxWorkers: 5,
      adapterFactory: publishAdapterFactory,
      vpnSlots,
      logger,
      closeTimeoutMs
    });
    bot.workerPool = workerPool;
    trackForensic(bot.forensicLogger?.prune().catch(error => {
      logStructured(logger, { level: 'warn', component: 'runner', event: 'forensic_prune_failed', operation: 'prune', result: 'failed', errorCode: extractErrorCode(error), sanitizedError: sanitizeError(error) });
    }));
    trackForensic(bot.forensicLogger?.pruneBurnedSubnets().catch(error => {
      logStructured(logger, { level: 'warn', component: 'runner', event: 'forensic_prune_subnets_failed', operation: 'pruneBurnedSubnets', result: 'failed', errorCode: extractErrorCode(error), sanitizedError: sanitizeError(error) });
    }));
    trackForensic(bot.forensicLogger?.flushOutbox?.().catch(error => {
      logStructured(logger, { level: 'warn', component: 'runner', event: 'forensic_outbox_flush_failed', operation: 'startup.flushOutbox', result: 'failed', errorCode: extractErrorCode(error), sanitizedError: sanitizeError(error) });
    }));
    const links = createLinkExports({ store: bot.store, dataDir, api, chatIds: effectiveChatIds, dailyChatId:parseIdList(chatId)[0], logger, clock });
    const notify = async (text, { targetChatIds, notificationKey } = {}) => {
      // Suppress operational background notifications from Telegram delivery.
      // Log structured for forensic audit and internal diagnostic visibility.
      logStructured(logger, {
        level: 'info',
        component: 'runner',
        event: 'operational_notification_suppressed',
        operation: 'notify',
        result: 'suppressed',
        notificationKey: notificationKey || null,
        text
      });
      return [];
    };

    let mappingsSafe = true;
    const reconcileResources = async ({ signal } = {}) => {
      if (signal?.aborted) return mappingsSafe;
      if (!vpnSlots.reconcile) return true; // Historical injected manager seam.
      const reconcileScope = signal ? attemptScope(signal, attemptTimeoutMs) : null;
      const waitStep = work => (reconcileScope ? reconcileScope.wait(work) : Promise.resolve().then(work));
      try {
        const current = await waitStep(() => bot.store.load());
        if (signal?.aborted) return mappingsSafe;
        if (current.settings?.publishMode === 'dry_run') {
          mappingsSafe = true;
          return true;
        }
        // Enabled accounts own reservations. Drafts and disabled accounts do not consume permanent slots.
        const accountIds = [...new Set((current.accounts || []).filter(a => a.enabled !== false).map(a => a.id))];
        const planOpts = reconcileScope ? { accountIds, dryRun: true, signal: reconcileScope.signal } : { accountIds, dryRun: true };
        const plan = await waitStep(() => vpnSlots.reconcile(planOpts));
        if (signal?.aborted) return mappingsSafe;
        if (plan.conflicts?.length) throw Object.assign(new Error('Unsafe VPN mappings'), { code: 'VPN_MAPPING_CONFLICT' });
        const applyOpts = reconcileScope ? { accountIds, dryRun: false, signal: reconcileScope.signal } : { accountIds, dryRun: false };
        await waitStep(() => vpnSlots.reconcile(applyOpts));
        if (signal?.aborted) return mappingsSafe;
        mappingsSafe = true;
      } catch (error) {
        if (signal?.aborted) return mappingsSafe;
        mappingsSafe = false;
        logger.error(JSON.stringify({ event: 'vpn_reconcile_failed', code: error.code || 'VPN_RECONCILE_FAILED' }));
        await notify('تعذر تنظيف أو التحقق من موارد VPN؛ يلزم فحص تعارضات الحاويات قبل بدء النشر.');
      } finally {
        reconcileScope?.dispose();
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
      async verify(account, { persistResult = true, signal, isDraft = false } = {}) {
        let session, primaryError, route, openTask, vpn;
        const persist = async result => {
          if (!persistResult || signal?.aborted) return;
          const effectiveSlot = Number.isInteger(result.slot) ? result.slot : (route?.slot ?? vpn?.slot ?? null);
          try { await ui?.recordAccountCheck(account.id, { ...result, slot: effectiveSlot }, { session: true, expectedAccount: account }); }
          catch { throw Object.assign(new Error('Account check persistence failed'), { code: 'ACCOUNT_CHECK_PERSIST_FAILED' }); }
        };
        const observationOrder=ui?.beginAccountObservation?.();
        const attempt = attemptScope(signal, attemptTimeoutMs);
        try {
        if (!isDraft && workerPool?.hasWorker(account.id)) {
          const w = workerPool.getWorker(account.id);
          if (w && w.identity) {
            const identity = w.identity;
            const exitIp = isPublicIp(w.routeIdentity) ? w.routeIdentity : null;
            const result = {
              isolated: Boolean(w.routeIdentity),
              vpnHealthy: Boolean(w.routeIdentity),
              exitIp,
              authenticated: Boolean(provenIdentity(identity, account)),
              state: identity?.state,
              accountFailure: (identity?.suspended || identity?.banned) ? 'banned' : identity?.accountFailure,
              suspended: Boolean(identity?.suspended || identity?.banned || identity?.accountFailure === 'banned'),
              banned: Boolean(identity?.banned || identity?.suspended || identity?.accountFailure === 'banned'),
              userId: w.userId,
              reason: identity?.reason,
              retryable: identity?.retryable === true,
              readDiagnostic: identity?.readDiagnostic,
              username: provenIdentity(identity, account) ? w.username : null,
              slot: Number.isInteger(w.slot) ? w.slot : null,
              observationOrder,
              discovered: !account.username && Boolean(provenIdentity(identity, account)),
              resourceId: w.routeIdentity
            };
            await persist(result);
            return result;
          }
        }
        const adapter = verifyAdapterFactory ? verifyAdapterFactory() : new DirectXAdapter({ allowPublish: false });
        try {
          const currentStore = await bot.store.load();
          const existingAccount = (currentStore.accounts || []).find(a => a.id === account.id);
          const hasDedicatedSlot = !isDraft && existingAccount && existingAccount.enabled !== false;

          if (hasDedicatedSlot && typeof vpnSlots.acquireRoute === 'function') {
            if (!mappingsSafe) throw Object.assign(new Error('VPN mapping unavailable'), { code: 'VPN_MAPPING_CONFLICT' });
            route = await vpnSlots.acquireRoute(account.id, { signal: attempt.signal });
            vpn = route;
          } else if (typeof vpnSlots.acquireReadRoute === 'function') {
            route = await vpnSlots.acquireReadRoute(account.id, { signal: attempt.signal, allowFallback: !hasDedicatedSlot });
            vpn = route;
          } else {
            vpn = await attempt.wait(() => vpnSlots.ensure(account.id, { signal: attempt.signal }));
          }
          if (attempt.signal.aborted) throw Object.assign(new Error('Refresh cancelled'), { code: 'ATTEMPT_ABORTED' });
          if (!persistResult && (vpn.healthy === false || !vpn.proxy || !vpn.exitIp)) throw Object.assign(new Error('VPN route not ready'), { code: 'VPN_NOT_READY' });
          if (attempt.signal.aborted) throw Object.assign(new Error('Refresh cancelled'), { code: 'ATTEMPT_ABORTED' });
          const opened = openTask = Promise.resolve().then(() => adapter.open({ account: { ...account, verifyNetwork: true }, proxy: vpn.proxy, signal: attempt.signal }));
          if (persistResult) opened.then(late => { if (attempt.signal.aborted) Promise.resolve().then(() => adapter.close({ session: late })).catch(err => logStructured(logger, { level: 'warn', component: 'runner', event: 'adapter_close_failed', operation: 'close', result: 'failed', errorCode: extractErrorCode(err), sanitizedError: sanitizeError(err) })); }, err => logStructured(logger, { level: 'debug', component: 'runner', event: 'adapter_open_aborted', operation: 'open', result: 'aborted', sanitizedError: sanitizeError(err) }));
          session = await attempt.wait(() => opened);
          if (attempt.signal.aborted) throw Object.assign(new Error('Refresh cancelled'), { code: 'ATTEMPT_ABORTED' });
          const identity = session.identity;
          const result = { isolated: Boolean(vpn.exitIp), vpnHealthy: Boolean(vpn.exitIp), exitIp: vpn.exitIp,
            authenticated: Boolean(provenIdentity(identity, account)), state: identity?.state, accountFailure: (identity?.suspended || identity?.banned) ? 'banned' : identity?.accountFailure, suspended: Boolean(identity?.suspended || identity?.banned || identity?.accountFailure === 'banned'), banned: Boolean(identity?.banned || identity?.suspended || identity?.accountFailure === 'banned'), userId: identity?.userId,
            reason: identity?.reason, retryable: identity?.retryable === true,
            readDiagnostic: identity?.readDiagnostic,
            username: provenIdentity(identity, account) ? identity.username : null,
            slot: Number.isInteger(vpn.slot) ? vpn.slot : null, observationOrder,
            discovered: !account.username && Boolean(provenIdentity(identity, account)), resourceId: vpn.name };
          await persist(result);
          return result;
        } catch (error) {
          primaryError = error;
          if (error?.code !== 'ACCOUNT_CHECK_PERSIST_FAILED') {
            const errText = `${error?.code || ''} ${error?.message || ''}`;
            const isTransient = Boolean(
              error?.transientError === true ||
              error?.recoverySafe === true ||
              ['ATTEMPT_TIMEOUT', 'ATTEMPT_ABORTED', 'VPN_NOT_READY', 'VPN_TRANSIENT_UNAVAILABLE', 'VPN_READINESS_FAILED', 'VPN_MAPPING_CONFLICT', 'DIRECT_X_IDENTITY_READ_UNAVAILABLE', 'MAX_PROJECT_SESSIONS_EXCEEDED', 'DUPLICATE_SESSION_LEASE'].includes(error?.code) ||
              /vpn|proxy|socks|timeout|readiness|aborted|network|connecterror|econnreset|econnrefused|etimedout|epipe|enotfound|eai_again|rate.?limit|429/i.test(errText)
            );
            try {
              await persist({
                isolated: false,
                vpnHealthy: false,
                authenticated: false, observationOrder,
                ...(isTransient ? { transientError: true, lastError: sanitizeError(error) } : {})
              });
            }
            catch (persistError) { primaryError = persistError; }
          }
          throw primaryError;
        } finally {
          if (!session && openTask) {
            let timedOutOpen = false;
            openTask.then(late => {
              if (timedOutOpen && late) {
                Promise.resolve().then(() => adapter.close({ session: late })).catch(() => {});
              }
            }, () => {});
            try {
              session = await withBoundedTimeout(openTask, openTeardownTimeoutMs, 'ADAPTER_OPEN_TEARDOWN_TIMEOUT');
            } catch {
              timedOutOpen = true;
            }
          }
          const closing = Promise.resolve().then(() => adapter.close({ session, signal: attempt.signal }));
          closing.catch(err => logStructured(logger, { level: 'warn', component: 'runner', event: 'adapter_closing_failed', operation: 'closing', result: 'failed', errorCode: extractErrorCode(err), sanitizedError: sanitizeError(err) }));
          try {
            await withBoundedTimeout(
              persistResult ? attempt.wait(() => closing) : closing,
              closeTimeoutMs,
              'ADAPTER_CLOSE_TIMEOUT'
            );
          }
          catch (cleanupError) { if (!primaryError || cleanupError?.code === 'DIRECT_X_CLEANUP_UNVERIFIED') throw cleanupError; }
          finally {
            route?.release();
            attempt.dispose();
          }
        }
        } finally {
          attempt.dispose();
        }
      },
      async health(account) {
        let check;
        const slot = await vpnSlots.getSlot(account.id);
        if (slot != null) {
          check = await vpnSlots.health(account.id);
        } else {
          let route;
          try {
            route = await vpnSlots.acquireReadRoute(account.id, { allowFallback: true });
            check = { healthy: route?.healthy === true, exitIp: route?.exitIp || route?.ip, slot: route?.slot };
          } catch (err) {
            check = { healthy: false, reason: err?.code || 'vpn_read_route_failed' };
          } finally {
            try { route?.release?.(); } catch {}
          }
        }
        const healthy = check?.healthy === true;
        const exitIp = check?.exitIp || check?.ip || null;
        const resSlot = Number.isInteger(check?.slot) ? check.slot : (Number.isInteger(slot) ? slot : null);
        return { isolated: healthy && Boolean(exitIp), vpnHealthy: healthy && Boolean(exitIp), exitIp, ip: exitIp, slot: resSlot };
      }
    };

    // Persistent worker preparation and readiness contract
    const prepareCycle = async ({ state: suppliedState, snapshot = null, signal = null, accountIds: explicitAccountIds = null, itemIds: explicitItemIds = null } = {}) => {
      if (signal?.aborted) {
        throw Object.assign(new Error('Preparation aborted'), { code: 'PREPARATION_ABORTED' });
      }
      const reasons = [];
      await reconcileResources({ signal }).catch(() => {});
      const state = suppliedState || await bot.store.load();
      const accountIds = explicitAccountIds ? new Set(explicitAccountIds) : null;
      const itemIds = explicitItemIds ? new Set(explicitItemIds) : null;
      const accounts = (state.accounts || []).filter(a => (!accountIds || accountIds.has(a.id)) &&
        a.enabled !== false && !a.needsOwnerCaptcha && !isCaptchaStatus(a.status) && !isBannedStatus(a.status) &&
        a.status !== 'معزول (3 إخفاقات)' && (a.failures || 0) < 3 &&
        !['challenge', 'locked', 'captcha', 'suspended', 'banned', 'accountFailure'].some(key => Boolean(a[key])) &&
        typeof a.cookieFile === 'string' && a.cookieFile.trim());
      if (!accounts.length) reasons.push('لا يوجد حساب مفعل باسم مستخدم وملف جلسة');
      const protectedTexts = protectedTextKeys(state.items || [], state);
      const pending = (state.items || []).filter(x => (!itemIds || itemIds.has(x.id)) && isClaimableInState(x, state, protectedTexts) && typeof x.payload?.text === 'string' && x.payload.text.trim());
      if (!pending.length) reasons.push('لا توجد منشورات في الانتظار');
      const explicitMin = state.settings?.delayMinSeconds;
      const explicitMax = state.settings?.delayMaxSeconds;
      if ((explicitMin != null && explicitMax == null) || (explicitMin == null && explicitMax != null) || explicitMin === null || explicitMax === null) {
        reasons.push('يجب تحديد الحد الأدنى والحد الأعلى للتأخير قبل بدء العمل');
      }
      const quota = quotaAdmission(state, { accounts, items: pending, now: clock() });
      if (quota.exhausted) return { ready: false, reasons: [...reasons, quota.message], ids: [], receipt: null, commit: () => {}, discard: async () => {} };
      if (reasons.length) return { ready: false, reasons, ids: [], receipt: null, commit: () => {}, discard: async () => {} };
      const candidates = accounts.filter(a => accountCapacity(state, a, clock()).remaining > 0 && pending.some(x => !x.payload.account || x.payload.account === a.id));
      if (!candidates.length) return { ready: false, reasons: ['لا توجد طاقة استيعابية كافية لأي حساب'], ids: [], receipt: null, commit: () => {}, discard: async () => {} };
      if (state.settings?.publishMode === 'dry_run') {
        const dryRunReceipt = {
          kind: 'worker_pool_readiness',
          version: 1,
          runPreparationId: crypto.randomUUID(),
          preparedAt: new Date().toISOString(),
          generation: workerPool?.generation || 1,
          workers: candidates.map(a => ({
            accountId: a.id,
            slot: state.vpnSlots?.[a.id] ?? 0,
            userId: a.userId,
            username: a.username,
            cookieFingerprint: 'dry_run',
            accountRevision: JSON.stringify(['cookieFile', 'enabled', 'needsOwnerCaptcha', 'checkGeneration'].map(k => a[k])),
            localOnly: true,
            routeIdentity: 'dry_run'
          }))
        };
        return { ready: candidates.length > 0, reasons, ids: candidates.map(a => a.id), receipt: dryRunReceipt, commit: () => {}, discard: async () => {} };
      }
      if (!mappingsSafe) return { ready: false, reasons: ['تعارض موارد VPN يحتاج إلى مراجعة'], ids: [], receipt: null, commit: () => {}, discard: async () => {} };

      if (!workerPool) {
        return { ready: candidates.length > 0, reasons, ids: candidates.map(a => a.id), receipt: null, commit: () => {}, discard: async () => {} };
      }

      if (workerPool.fenced && !workerPool.closed && typeof workerPool.rearm === 'function') {
        try {
          await workerPool.rearm({ drain: true, signal });
        } catch (err) {
          logStructured(logger, {
            level: 'warn',
            component: 'runner',
            event: 'worker_pool_rearm_failed',
            operation: 'prepareCycle.rearm',
            result: 'failed',
            errorCode: extractErrorCode(err),
            sanitizedError: sanitizeError(err)
          });
          return { ready: false, reasons: ['تعذر إعادة تهيئة مجمع العمال بعد الإيقاف'], ids: [], receipt: null, commit: () => {}, discard: async () => {} };
        }
      }

      const prep = await workerPool.prepareCycle({
        state,
        accountIds: candidates.map(a => a.id),
        snapshot,
        signal
      });

      return {
        ready: prep.ready && reasons.length === 0,
        reasons: prep.ready ? [] : [...reasons, ...prep.reasons],
        ids: prep.ids,
        receipt: prep.receipt,
        commit: prep.commit,
        discard: prep.discard
      };
    };

    // Readiness is an observation, not publish authority. The caller revision-
    // fences its start transaction; the adapter/onDispatch still verify identity.
    const runtimeReady = async (scope = {}, { state: suppliedState } = {}) => {
      const parentSignal = scope?.signal || null;
      const abortedResult = () => ({ ready: false, reasons: ['تم إلغاء بدء الدورة'], ids: [], aborted: true });
      if (parentSignal?.aborted) return abortedResult();
      const reasons = [];
      await reconcileResources({ signal: parentSignal }).catch(() => {});
      if (parentSignal?.aborted) return abortedResult();
      let state = suppliedState;
      if (!state) {
        if (parentSignal) {
          const loadScope = attemptScope(parentSignal, attemptTimeoutMs);
          try {
            state = await loadScope.wait(() => bot.store.load());
          } catch (err) {
            if (parentSignal.aborted) return abortedResult();
            throw err;
          } finally {
            loadScope.dispose();
          }
        } else {
          state = await bot.store.load();
        }
      }
      if (parentSignal?.aborted) return abortedResult();
      const accountIds = scope.accountIds ? new Set(scope.accountIds) : null;
      const itemIds = scope.itemIds ? new Set(scope.itemIds) : null;
      const accounts = (state.accounts || []).filter(a => (!accountIds || accountIds.has(a.id)) &&
        a.enabled !== false && !a.needsOwnerCaptcha && !isCaptchaStatus(a.status) && !isBannedStatus(a.status) &&
        a.status !== 'معزول (3 إخفاقات)' && (a.failures || 0) < 3 &&
        !['challenge', 'locked', 'captcha', 'suspended', 'banned', 'accountFailure'].some(key => Boolean(a[key])) &&
        typeof a.cookieFile === 'string' && a.cookieFile.trim());
      if (!accounts.length) reasons.push('لا يوجد حساب مفعل باسم مستخدم وملف جلسة');
      const protectedTexts = protectedTextKeys(state.items || [], state);
      const pending = (state.items || []).filter(x => (!itemIds || itemIds.has(x.id)) && isClaimableInState(x, state, protectedTexts) && typeof x.payload?.text === 'string' && x.payload.text.trim());
      if (!pending.length) reasons.push('لا توجد منشورات في الانتظار');
      const explicitMin = state.settings?.delayMinSeconds;
      const explicitMax = state.settings?.delayMaxSeconds;
      if ((explicitMin != null && explicitMax == null) || (explicitMin == null && explicitMax != null) || explicitMin === null || explicitMax === null) {
        reasons.push('يجب تحديد الحد الأدنى والحد الأعلى للتأخير قبل بدء العمل');
      }
      const quota = quotaAdmission(state, { accounts, items: pending, now: clock() });
      if (quota.exhausted) return { ready: false, reasons: [...reasons, quota.message], ids: [] };
      if (reasons.length) return { ready: false, reasons, ids: [] };
      const candidates = accounts.filter(a => accountCapacity(state, a, clock()).remaining > 0 && pending.some(x => !x.payload.account || x.payload.account === a.id));
      if (parentSignal?.aborted) return abortedResult();
      if (state.settings?.publishMode === 'dry_run') return { ready: candidates.length > 0, reasons, ids: candidates.map(a => a.id) };
      if (!mappingsSafe) return { ready: false, reasons: ['تعارض موارد VPN يحتاج إلى مراجعة'], ids: [] };
      const readiness = attemptScope(parentSignal, attemptTimeoutMs);
      const readyIds = new Set();
      let cursor = 0;
      const probe = async a => {
        if (readiness.signal.aborted) return;
        let route;
        try {
          if (typeof vpnSlots.acquireReadRoute === 'function') {
            try {
              route = await readiness.wait(() => Promise.resolve(vpnSlots.acquireReadRoute(a.id, { signal: readiness.signal, allowFallback: false })).then(acquired => {
                if (readiness.signal.aborted) { try { acquired?.release?.(); } catch {} return null; }
                return acquired;
              }));
            } catch (error) {
              if (readiness.signal.aborted || error.code !== 'VPN_NOT_READY') throw error;
            }
          }
          if (readiness.signal.aborted) return;
          const check = route || await readiness.wait(() => typeof vpnSlots.ensure === 'function'
            ? vpnSlots.ensure(a.id, { signal: readiness.signal, allowContainerCreate: false })
            : vpnSlots.health(a.id));
          if (readiness.signal.aborted) return;
          const expectedSlot = Number.isInteger(state.vpnSlots?.[a.id]) ? state.vpnSlots[a.id] : null;
          const slot = Number.isInteger(check?.slot) ? check.slot : null;
          const knownIp = check?.exitIp || (Number.isInteger(slot) ? state.telegramUi?.slotIps?.[slot] : null);
          const healthy = check?.healthy !== false && Number.isInteger(slot) && slot >= 0 && slot < 5 &&
            (expectedSlot == null || slot === expectedSlot) && isPublicIp(knownIp);
          const effectiveIp = healthy ? (isPublicIp(check?.exitIp) ? check.exitIp : knownIp) : undefined;
          if (readiness.signal.aborted) return;
          await readiness.wait(() => ui?.recordAccountCheck(a.id, {
            isolated: healthy, vpnHealthy: healthy, exitIp: effectiveIp, slot
          }, { source: 'vpn-health', expectedAccount: a, signal: readiness.signal }));
          if (readiness.signal.aborted) return;
          if (healthy) {
            state.vpnSlots ||= {};
            state.vpnSlots[a.id] = slot;
            readyIds.add(a.id);
          }
        } catch (err) {
          if (readiness.signal.aborted) return;
          logStructured(logger, { level: 'warn', component: 'runner', event: 'vpn_health_probe_failed', accountId: a.id,
            operation: 'readiness.healthProbe', result: 'failed', errorCode: extractErrorCode(err), sanitizedError: sanitizeError(err) });
        } finally { try { route?.release?.(); } catch {} }
      };
      try {
        await Promise.all(Array.from({ length: Math.min(5, candidates.length) }, async () => {
          while (!readiness.signal.aborted && cursor < candidates.length) await probe(candidates[cursor++]);
        }));
      } finally { readiness.dispose(); }
      if (parentSignal?.aborted) return abortedResult();
      const ids = candidates.filter(a => readyIds.has(a.id)).map(a => a.id);
      if (!ids.length) reasons.push('لا توجد حاوية VPN سليمة لأي حساب مفعل');
      return { ready: reasons.length === 0, reasons, ids };
    };

    runtimeReady.prepareCycle = prepareCycle;

    // One authoritative cycle; stop is checked at every admission boundary.
    const launchCycle = async run => {
      if(stopping)return;
      abortController = new AbortController();
      const signal = abortController.signal;
      if (workerPool?.fenced && !workerPool.closed && typeof workerPool.rearm === 'function') {
        await workerPool.rearm({ drain: true, signal }).catch(() => {});
      }
      // Keep the run's item ids as its durable admission boundary, but resolve
      // every item/account from SQLite at the boundary where it is admitted.
      // A long-running cycle must not use a stale pre-restart quota, account,
      // or item state snapshot.
      const itemIds = new Set(run.itemIds || []);
      const runPreDispatchRetries = new Map();
      const cooling = new Map();
      const accountRevision = a => JSON.stringify(['cookieFile', 'enabled', 'needsOwnerCaptcha', 'checkGeneration'].map(k => a?.[k]));
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
        xErrorCode,
        xResponseKind,
        rejectionReason
      }) => {
        const isPermanent = ['banned', 'captcha'].includes(failure);
        // Any post-dispatch outcome without a positively classified account failure is
        // uncertain, not evidence of an account fault: quarantine the item, never strike.
        const isUncertainPacing = failure === 'ambiguous';
        const isKnownParserError = isKnownTwikitParserFailure({ failure, rawError });
        const isContentReject = isXContentRejection({ failure, xErrorCode, xResponseKind, rejectionReason });
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
          accountResult = {
            failures: 0,
            isolated: false,
            status: null,
            transportOutage: isTransportOrVpn
          };
          const acc = s.accounts?.find(a => a.id === accountId);
          if (acc) {
            if (isPermanent) {
              acc.enabled = false;
              acc.status = failure === 'captcha' ? 'كابتشا' : 'محظور';
              if (failure === 'captcha') {
                // A new incident must never inherit delivery receipts from the previous CAPTCHA.
                // Repeated reports of the same unresolved challenge retain the same incident ID.
                const isNewIncident = !acc.needsOwnerCaptcha || !acc.captchaIncidentId;
                acc.needsOwnerCaptcha = true;
                if (isNewIncident) {
                  acc.captchaDetectedAt = Date.now();
                  acc.captchaIncidentId = crypto.randomUUID();
                  acc.captchaDeliveredChats = [];
                  acc.captchaDeliveredIncidentId = acc.captchaIncidentId;
                  delete acc.lastNotifiedCaptchaIncidentId;
                  delete acc.lastCaptchaAlertAt;
                }
                acc.captchaCode = xErrorCode || 326;
                acc.captchaReason = rejectionReason || reason || 'security_challenge_detected';
                account.needsOwnerCaptcha = acc.needsOwnerCaptcha;
                account.captchaDetectedAt = acc.captchaDetectedAt;
                account.captchaCode = acc.captchaCode;
                account.captchaReason = acc.captchaReason;
                account.captchaIncidentId = acc.captchaIncidentId;
                account.captchaDeliveredChats = [...(acc.captchaDeliveredChats || [])];
                account.captchaDeliveredIncidentId = acc.captchaDeliveredIncidentId;
                account.lastNotifiedCaptchaIncidentId = acc.lastNotifiedCaptchaIncidentId;
              }
              acc.checkGeneration = crypto.randomUUID();
              account.checkGeneration = acc.checkGeneration;
              account.enabled = false;
              account.status = acc.status;
              accountResult.isolated = true;
              accountResult.status = acc.status;
              if (currentSubnet) {
                s.burnedSubnets ||= [];
                const exists = s.burnedSubnets.some(e => (typeof e === 'string' ? e : e.subnet) === currentSubnet);
                if (!exists) s.burnedSubnets.push({ subnet: currentSubnet, burnedAt: Date.now() });
              }
            } else if (!isTransportOrVpn && !isRateLimit && (['auth_session_unverified','cookie_expired','auth_rejected','auth','unknown'].includes(failure) || !failure)) {
              // Preserve owner activation preference; status gates session use.
              acc.unverifiedReason = reason || 'auth_session_unverified';
              // Unverified authentication is not evidence that a pending CAPTCHA was solved.
              // Keep the owner-only gate intact, including its generation and incident ID.
              if (acc.needsOwnerCaptcha) {
                account.needsOwnerCaptcha = true;
                account.captchaIncidentId = acc.captchaIncidentId;
              } else {
                acc.status = 'غير محقق (جلسة غير مؤكدة)';
                acc.checkGeneration = crypto.randomUUID();
              }
              accountResult.isolated = true;
              accountResult.status = acc.status;
            } else if (isKnownParserError || isContentReject || isUncertainPacing) {
              // A parser error or a GraphQL content rejection is not an
              // account failure. Still quarantine the post after dispatch.
              accountResult.failures = acc.failures || 0;
            } else if (isRateLimit) {
              // Rate limit: cooling only, no strike increment
            } else if (isTransportOrVpn) {
              // Transient network/proxy/VPN container issues: DO NOT increment account failure strikes
              accountResult.failures = acc.failures || 0;
            } else {
              // Unclassified bridge/transport failure is not account evidence.
              accountResult.failures = acc.failures || 0;
            }
          }

          // Only the owning claim may be released. Never return a dispatching
          // attempt to pending: X could already have accepted the post.
          // Preserve explicit owner account pinning (i.payload.account) on pre-dispatch failure!
          const i = s.items?.find(x => x.id === item?.id);
          if (i?.state === 'processing' && claim?.token && i.attempt?.token === claim.token) {
            const isPreDispatch = isProvenPreDispatch(i);
            archiveAttemptRecord(i, {
              failedAt: new Date(clock()).toISOString(),
              outcomeState: isPreDispatch ? 'failed' : 'ambiguous',
              ...(isPreDispatch ? { preDispatchRetry: true } : {}),
              failure: failure || null,
              reason: reason || null,
              xErrorCode: xErrorCode ?? null
            });
            if (isPreDispatch) {
              i.state = 'pending';
              i.preDispatchRetries = (i.preDispatchRetries || 0) + 1;
              moveItemToTailLocal(s, i.id);
              recordUnsuccessfulAttempt(s, {
                accountId,
                outcome: 'failed',
                at: clock(),
                runId: run.runId,
                itemId: item.id,
                attemptToken: claim?.token,
                preDispatchRetry: i.state === 'pending' && i.archivedAttempt?.preDispatchRetry === true
              });
              delete i.attempt;
            } else {
              i.state = 'ambiguous';
              i.requeueApproved = false;
              recordUnsuccessfulAttempt(s, {
                accountId,
                outcome: 'ambiguous',
                at: clock(),
                runId: run.runId,
                itemId: item.id,
                attemptToken: claim?.token,
                preDispatchRetry: i.state === 'pending' && i.archivedAttempt?.preDispatchRetry === true
              });
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
          !a.needsOwnerCaptcha &&
          !isCaptchaStatus(a.status) &&
          !isBannedStatus(a.status) &&
          !isUnverifiedStatus(a.status) &&
          !isAccountInactive(a.status) &&
          (a.failures || 0) < 3 &&
          (run.accountIds || []).includes(a.id) &&
          accountCapacity(sNow, a, clock()).remaining > 0 &&
          !isCooling(a)
        );

        if (isContentReject && !isUncertainPacing) {
          // Do not cool or rotate an otherwise healthy account for a
          // content-specific rejection; the affected item stays quarantined.
          cooling.delete(accountId);
        } else if (accountResult.isolated) {
          cooling.delete(accountId);
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
          const prevFailures = (cooling.get(accountId)?.failures || 0) + 1;
          const delayMs = Math.min(300000, 30000 * 2 ** Math.min(prevFailures - 1, 4));
          const entry = {
            failures: prevFailures,
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
          const delayMs = isUncertainPacing ? 60000 : otherActive.length > 0 ? 60000 : Math.min(60000, Math.max(1000, (sNow.settings?.delayMinSeconds ?? 15) * 1000));
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

        trackForensic(bot.forensicLogger?.record({
          eventType: accountResult.isolated
            ? (isCaptchaStatus(accountResult.status) ? 'account_captcha' : accountResult.status === 'محظور' ? 'account_banned' : 'account_session_held')
            : isUncertainPacing ? 'uncertain_pacing_no_strike' : isKnownParserError ? 'twikit_profile_parse_error_no_strike' : isContentReject ? 'x_content_rejection_no_strike' : isRateLimit ? 'account_rate_limited' : isTransportOrVpn ? 'transport_or_vpn_error' : 'unclassified_failure_no_strike',
          accountId,
          username: account?.username,
          slot: session?.slot,
          port: session?.port,
          containerName: session?.containerName,
          exitIp: session?.exitIp,
          subnet: currentSubnet,
          xErrorCode: xErrorCode ?? null,
          xErrorMessage: rawError || reason,
          details: { itemId: item?.id, failure, failures: accountResult.failures, isolated: accountResult.isolated, libraryParseFailure: isKnownParserError, xResponseKind: xResponseKind || null, contentRejection: isContentReject }
        }).catch(err => logStructured(logger, { level: 'error', component: 'runner', event: 'forensic_record_failed', accountId, operation: 'handleAccountFailure.record', result: 'failed', errorCode: extractErrorCode(err), sanitizedError: sanitizeError(err) })));

        if (accountResult.isolated) {
          if (accountResult.status === 'كابتشا' || failure === 'captcha' || account.needsOwnerCaptcha) {
            // Unify live runner failure isolation through verified durable alerting
            const alertFn = ui?.sendIsolationAlert?.bind(ui);
            if (typeof alertFn === 'function') {
              await alertFn({
                account,
                reason: 'captcha',
                otherActiveCount: otherActive.length
              }).catch(err => {
                logStructured(logger, {
                  level: 'error',
                  component: 'runner',
                  event: 'captcha_isolation_alert_failed',
                  accountId,
                  operation: 'handleAccountFailure.sendIsolationAlert',
                  result: 'failed',
                  errorCode: extractErrorCode(err),
                  sanitizedError: sanitizeError(err)
                });
              });
            } else {
              const alertMsg = `تم عزل الحساب @${account.username || account.label} تلقائياً (السبب: كابتشا (مطلوب حل يدوي)) (حل التحقق من X بنفسك عبر الموقع/التطبيق الرسمي ثم اضغط تم الحل)${otherActive.length > 0 ? ` ومواصلة الدورة عبر بقية الحسابات (${otherActive.length}).` : '. لا توجد حسابات مؤهلة متبقية؛ توقفت الدورة.'}`;
              await notify(alertMsg).catch(err => {
                logStructured(logger, {
                  level: 'error',
                  component: 'runner',
                  event: 'captcha_fallback_alert_failed',
                  accountId,
                  sanitizedError: sanitizeError(err)
                });
              });
            }
          } else {
            if (isUnverifiedStatus(accountResult.status)) {
              const credential=['cookie_expired','auth_rejected','auth'].includes(failure);
              await notify(`تم تعليق استخدام جلسة الحساب @${account.username || account.label}: ${credential ? 'ثبت رفض المصادقة؛ يلزم تحديث الكوكيز.' : 'تعذر التحقق من الجلسة؛ لم يثبت حظر الحساب.'} لم يتغير اختيار تفعيل الحساب أو كوتاه.`);
            } else if (otherActive.length > 0) {
              await notify(`تم عزل الحساب @${account.username || account.label} تلقائياً (${accountResult.status}) ومواصلة الدورة عبر بقية الحسابات (${otherActive.length}).`);
            } else {
              await notify(`تم عزل الحساب @${account.username || account.label} تلقائياً (${accountResult.status}). لا توجد حسابات مؤهلة متبقية؛ توقفت الدورة.`);
            }
          }
          return { halt: otherActive.length === 0, skipDelay: true, isolated: true, failures: accountResult.failures };
        }

        const iNow = sNow.items?.find(x => x.id === item?.id);
        if (failure === 'ambiguous' || iNow?.state === 'ambiguous') {
          // Ambiguous outcome isolates the item, not the cycle.
          // Do not halt the run unless the account was isolated on its 3rd strike.
          return { halt: false, skipDelay: false, isolated: false, failures: accountResult.failures };
        }

        const protectedTexts = protectedTextKeys(sNow.items || []);
        const canRetryAfterCooling = (sNow.items || []).some(x =>
          itemIds.has(x.id) &&
          isClaimableInState(x, sNow, protectedTexts) &&
          selectAccount(sNow, run, x, clock())
        );
        if (otherActive.length > 0 || canRetryAfterCooling) {
          return { halt: false, skipDelay: true, isolated: false, failures: accountResult.failures };
        } else {
          await notify('جميع الحسابات غير مؤهلة أو في فترة انتظار؛ توقفت الدورة وبقيت المنشورات في الانتظار.');
          return { halt: true, skipDelay: true, isolated: false, failures: accountResult.failures };
        }
      };

      cycleLoop: while (!signal.aborted) {
      let claimedInPass = false;
      let passSnapshot = await bot.store.load();
      if (passSnapshot.telegramUi?.run?.accountIds) {
        run.accountIds = [...passSnapshot.telegramUi.run.accountIds];
      }
      // In live runtime (no injected publishAdapterFactory), if enabled eligible accounts
      // have missing session checks, refresh them via isolatedVerifier so
      // evaluateAccountUse does not drop valid accounts before adapter.open() can run.
      if (!publishAdapterFactory && typeof isolatedVerifier?.verify === 'function') {
        let refreshedAny = false;
        for (const id of run.accountIds || []) {
          if (signal.aborted) break;
          const acc = (passSnapshot.accounts || []).find(a => a.id === id && a.enabled !== false);
          if (!acc || acc.needsOwnerCaptcha || isCaptchaStatus(acc.status) || isBannedStatus(acc.status) || isUnverifiedStatus(acc.status) || isAccountInactive(acc.status) || (acc.failures || 0) >= 3) continue;
          if (accountCapacity(passSnapshot, acc, clock()).remaining <= 0) continue;
          const evalRes = evaluateAccountUse(passSnapshot, acc, { nowMs: clock().getTime(), requireOwnerEnabled: true });
          if (!evalRes.allowed && evalRes.reason === 'session_missing') {
            try {
              await isolatedVerifier.verify(acc, { persistResult: true, signal });
              refreshedAny = true;
            } catch {}
          }
        }
        if (refreshedAny && !signal.aborted) {
          passSnapshot = await bot.store.load();
        }
      }
      const hints = new Map((passSnapshot.items || []).map(i => [i.id, i]));
      const passProtectedTexts = protectedTextKeys(passSnapshot.items || []);
      const passExcluded = excluded(passSnapshot);
      // Explain each routing decision once per changed state, not once per
      // queued post. Ordinary cooling/quota skips are not rotation failures.
      const rotation = (run.accountIds || []).map(id => {
        const acc = (passSnapshot.accounts || []).find(a => a.id === id);
        const quota = acc ? accountCapacity(passSnapshot, acc, clock()).remaining : 0;
        const pause = cooling.get(id);
        const reason = !acc ? 'missing_account'
          : acc.enabled === false ? 'disabled'
          : acc.needsOwnerCaptcha || isCaptchaStatus(acc.status) || isBannedStatus(acc.status) || isUnverifiedStatus(acc.status) || isAccountInactive(acc.status) || acc.status === 'معزول (3 إخفاقات)' || (acc.failures || 0) >= 3 ? 'isolated'
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
      const movedToTailInPass = new Set();
      for (let itemIdx = 0; itemIdx < itemIdsList.length; itemIdx++) {
        const itemId = itemIdsList[itemIdx];
        // Do not deserialize the entire durable queue for every cooled/pinned
        // item. This snapshot is only a cheap skip hint; admission reloads below.
        const hint = hints.get(itemId);
        if (!isClaimableInState(hint, passSnapshot, passProtectedTexts) || !selectAccount(passSnapshot, run, hint, clock(), excluded(passSnapshot))) continue;
        let current = await bot.store.load();
        if (signal.aborted || current.cycle?.state !== 'running' || current.cycle.runId !== run.runId) break;
        let deadline = Date.parse(current.posting?.nextPostAt || '');
        let waitedForNextPostAt = false;
        while (Number.isFinite(deadline) && clock().getTime() < deadline && !signal.aborted) {
          waitedForNextPostAt = true;
          await sleepWithSignal(sleepFn, Math.min(1000, deadline - clock().getTime()), signal);
          if (signal.aborted) break;
          if (bot.store.section) {
            const [c, p] = await Promise.all([bot.store.section('cycle'), bot.store.section('posting')]);
            current = { ...current, cycle: c, posting: p };
          } else {
            current = await bot.store.load();
          }
          deadline = Date.parse(current.posting?.nextPostAt || '');
          if (current.cycle?.state !== 'running' || current.cycle.runId !== run.runId) break;
        }
        if (signal.aborted || current.cycle?.state !== 'running' || current.cycle.runId !== run.runId) break;
        if (waitedForNextPostAt) {
          current = await bot.store.load();
          if (signal.aborted || current.cycle?.state !== 'running' || current.cycle.runId !== run.runId) break;
        }
        if (!(run.accountIds || []).some(id => selectAccount(current, run, { payload: { account: id } }, clock(), excluded(current)))) break;
        const item = (current.items || []).find(entry => entry.id === itemId);
        if (!isClaimableInState(item, current)) continue;
        if (!item) continue;
        const accountId = selectAccount(current, run, item, clock(), excluded(current));
        if (!accountId) continue;
        const cursorBeforeClaim = current.telegramUi?.run?.runId === run.runId ? (current.telegramUi.run.cursor ?? 0) : null;
        const account = (current.accounts || []).find(a => a.id === accountId && a.enabled !== false);
        if (!account) continue;
        let halt = false, retryAfterMs = 0, preDispatchFailed = false, itemPreDispatchRetries = item.preDispatchRetries || 0;
        let result;
        while (!signal.aborted) {
        let retry = false, skipDelay = false;
        let adapter;
        let route = null;
        let session, openTask, dispatchEntered = false, claim;
        let workerLease = null;
        let poisonedWorker = false;
        let attemptError = null;
        let publishResult = null;
        const prepareScope = attemptScope(signal, attemptTimeoutMs);
        let publishScope = null;
        const attempt = {
          get signal() { return (publishScope || prepareScope).signal; },
          wait(work) { return (publishScope || prepareScope).wait(work); },
          dispose() {
            prepareScope.dispose();
            publishScope?.dispose();
          }
        };
        try {
          const publishMode = current.settings?.publishMode || 'direct_x';
          if (publishMode === 'dry_run') {
            const text = item.payload?.text || '';
            const weightedLen = computeWeightedTweetLength(text);
            const tooLong = weightedLen > MAX_WEIGHTED_TWEET_CHARS;
            const dryReason = tooLong ? 'tweet_text_too_long' : 'dry_run';
            logStructured(logger, {
              level: 'info',
              component: 'runner',
              event: 'publish_attempt_observation',
              runId: run.runId,
              accountId,
              queueItemId: item.id,
              operation: 'DirectX.publish',
              result: 'dry_run',
              durationMs: 0,
              errorCode: tooLong ? 186 : null,
              sanitizedError: null,
              details: {
                dispatchEntered: false,
                bridgeStatus: 'dry_run',
                textUtf16Length: typeof text === 'string' ? text.length : null,
                textCodePoints: typeof text === 'string' ? Array.from(text).length : null,
                weightedLength: weightedLen,
                validLength: !tooLong,
                verifiedNotPosted: false,
                xResponseKind: tooLong ? 'pre_dispatch_validation' : null,
                xErrorMessage: tooLong ? `Tweet text weighted length (${weightedLen}) exceeds ${MAX_WEIGHTED_TWEET_CHARS} limit` : null,
                httpStatus: null,
                transactionDegraded: null,
                verificationError: null
              }
            });
            logger.log(JSON.stringify({
              event: 'post_result',
              runId: run.runId,
              item: item.id,
              status: 'dry_run',
              account: accountId,
              reason: dryReason,
              url: null,
              dispatchEntered: false,
              durationMs: 0,
              xErrorCode: tooLong ? 186 : null,
              xResponseKind: tooLong ? 'pre_dispatch_validation' : null,
              xErrorMessage: tooLong ? `Tweet text weighted length (${weightedLen}) exceeds ${MAX_WEIGHTED_TWEET_CHARS} limit` : null,
              httpStatus: null,
              transactionDegraded: null,
              verificationError: null
            }));
            halt = true;
            skipDelay = true;
            retry = false;
            break;
          }
          claim = await attempt.wait(() => claimCycleItem({ store: bot.store, itemId, accountId, runId: run.runId, signal: attempt.signal, clock }));
          if (!claim.claimed) {
            break;
          }
          claimedInPass = true;
          const weightedLen = computeWeightedTweetLength(item.payload?.text || '');
          if (weightedLen > MAX_WEIGHTED_TWEET_CHARS) {
            const rejectedAt = new Date(clock()).toISOString();
            await bot.store.update(s => {
              const i = (s.items || []).find(x => x.id === itemId);
              if (i?.state === 'processing' && claim?.token && i.attempt?.token === claim.token) {
                archiveAttemptRecord(i, {
                  failedAt: rejectedAt,
                  outcomeState: 'failed',
                  failure: 'content_rejected',
                  reason: 'tweet_text_too_long',
                  xErrorCode: 186
                });
                delete i.attempt;
                i.state = 'cancelled';
                i.reason = 'tweet_text_too_long';
                i.failureDiagnostic = {
                  observedAt: rejectedAt,
                  dispatchEntered: false,
                  rejectionReason: 'tweet_text_too_long',
                  xResponseKind: 'pre_dispatch_validation',
                  xErrorCode: 186,
                  xErrorMessage: `Tweet text weighted length (${weightedLen}) exceeds ${MAX_WEIGHTED_TWEET_CHARS} limit`,
                  httpStatus: null,
                  verificationError: null
                };
                recordUnsuccessfulAttempt(s, {
                  accountId,
                  outcome: 'failed',
                  at: clock(),
                  runId: run.runId,
                  itemId: item.id,
                  attemptToken: claim?.token,
                  preDispatchRetry: i.state === 'pending' && i.archivedAttempt?.preDispatchRetry === true
                });
                if (s.posting) s.posting.publishingAt = null;
              }
              return s;
            });
            logger.log(JSON.stringify({
              event: 'post_result',
              runId: run.runId,
              item: item.id,
              status: 'cancelled',
              account: accountId,
              reason: 'tweet_text_too_long',
              url: null,
              dispatchEntered: false,
              durationMs: 0,
              xErrorCode: 186,
              xResponseKind: 'pre_dispatch_validation',
              xErrorMessage: `Tweet text weighted length (${weightedLen}) exceeds ${MAX_WEIGHTED_TWEET_CHARS} limit`,
              httpStatus: null,
              verificationError: null
            }));
            skipDelay = true;
            retry = false;
            break;
          }
          const allowLivePublish = publishMode === 'direct_x';
          if (publishMode === 'direct_x') {
            let vpn;
            if (workerPool) {
              if (!workerPool.hasWorker(accountId)) {
                await attempt.wait(() => workerPool.getOrOpenWorker({ account, state: current, signal: attempt.signal }));
              }
              workerLease = await attempt.wait(() => workerPool.borrow(accountId, { signal: attempt.signal }));
              adapter = workerLease.adapter;
              session = workerLease.session;
              route = workerLease.route;
              vpn = route;
              session.slot ??= vpn?.slot;
              session.exitIp ??= vpn?.exitIp;
              if (session.identity?.accountFailure) await ui.recordAccountCheck(accountId, { accountFailure: session.identity.accountFailure }, { session: true, expectedAccount: account });
            } else {
              try {
                if (typeof vpnSlots.acquireRoute === 'function') {
                  route = await attempt.wait(() => vpnSlots.acquireRoute(accountId, { signal: attempt.signal }));
                  vpn = route;
                } else {
                  vpn = await attempt.wait(() => vpnSlots.ensure(accountId, { signal: attempt.signal }));
                }
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
              try { await ui.recordAccountCheck(accountId, { isolated: Boolean(vpn.exitIp), vpnHealthy: Boolean(vpn.exitIp), exitIp: vpn.exitIp, slot: vpn.slot }, { source: 'vpn-health', expectedAccount: account }); }
              catch { throw Object.assign(new Error('Account check persistence failed'), { code: 'ACCOUNT_CHECK_PERSIST_FAILED' }); }
              if (signal.aborted || (await bot.store.load()).cycle?.state !== 'running') {
                await bot.store.update(s => {
                  const i = s.items.find(x => x.id === itemId);
                  if (i?.state === 'processing' && claim?.token && i.attempt?.token === claim.token) {
                    const isPreDispatch = !dispatchEntered && isProvenPreDispatch(i);
                    archiveAttemptRecord(i, {
                      failedAt: new Date(clock()).toISOString(),
                      outcomeState: isPreDispatch ? 'failed' : 'ambiguous',
                      ...(isPreDispatch ? { preDispatchRetry: true } : {}),
                      reason: 'cycle_aborted_pre_open'
                    });
                    if (isPreDispatch) {
                      i.state = 'pending';
                      if (cursorBeforeClaim != null && s.telegramUi?.run?.runId === run.runId && !i.payload?.account) {
                        s.telegramUi.run.cursor = cursorBeforeClaim;
                      }
                      preDispatchFailed = true;
                      moveItemToTailLocal(s, i.id);
                      recordUnsuccessfulAttempt(s, {
                        accountId,
                        outcome: 'failed',
                        at: clock(),
                        runId: run.runId,
                        itemId: item.id,
                        attemptToken: claim?.token,
                        preDispatchRetry: false
                      });
                    } else {
                      i.state = 'ambiguous';
                      i.requeueApproved = false;
                      i.reason ||= 'cycle_aborted_pre_open';
                      recordUnsuccessfulAttempt(s, {
                        accountId,
                        outcome: 'ambiguous',
                        at: clock(),
                        runId: run.runId,
                        itemId: item.id,
                        attemptToken: claim?.token,
                        preDispatchRetry: i.state === 'pending' && i.archivedAttempt?.preDispatchRetry === true
                      });
                    }
                    delete i.attempt;
                    if (s.posting) s.posting.publishingAt = null;
                  }
                  return s;
                });
                break;
              }
              adapter = publishAdapterFactory ? publishAdapterFactory() : new DirectXAdapter({ allowPublish: allowLivePublish });
              const opened = openTask = Promise.resolve().then(() => adapter.open({ account, proxy: vpn.proxy, signal: attempt.signal }));
              // The finally owner joins even a late open and closes it exactly once.
              session = await attempt.wait(() => opened);
              session.slot ??= vpn.slot; session.port ??= vpn.port;
              session.exitIp ??= vpn.exitIp; session.containerName ??= vpn.name;
              if (session.identity?.accountFailure) await ui.recordAccountCheck(accountId, { accountFailure: session.identity.accountFailure }, { session: true, expectedAccount: account });
              if (provenIdentity(session.identity, account)) await ui.recordAccountCheck(accountId, {
                isolated: true, vpnHealthy: Boolean(vpn.exitIp), exitIp: vpn.exitIp,
                authenticated: true, username: session.identity.username, userId: session.identity.userId
              }, { session: true, source: 'x-session', expectedAccount: account });
              else if (session.identity?.retryable === true && session.identity.reason === 'identity_read_unavailable' && !session.identity.accountFailure) {
                throw Object.assign(new Error('Identity read temporarily unavailable'), { code: 'DIRECT_X_IDENTITY_READ_UNAVAILABLE', readDiagnostic: session.identity.readDiagnostic });
              }
              else if (!publishAdapterFactory || session.identity?.username != null || session.identity?.userId != null) {
                await ui.recordAccountCheck(accountId, { isolated: true, vpnHealthy: Boolean(vpn.exitIp), exitIp: vpn.exitIp, authenticated: false }, { session: true, expectedAccount: account });
                throw Object.assign(new Error('Identity unverified'), { code: 'DIRECT_X_AUTH_IDENTITY_UNVERIFIED' });
              }
            }
            if (signal.aborted) {
              await bot.store.update(s => {
                const i = s.items.find(x => x.id === item.id);
                if (i?.state === 'processing' && claim?.token && i.attempt?.token === claim.token) {
                  const isPreDispatch = !dispatchEntered && isProvenPreDispatch(i);
                  archiveAttemptRecord(i, {
                    failedAt: new Date(clock()).toISOString(),
                    outcomeState: isPreDispatch ? 'failed' : 'ambiguous',
                    ...(isPreDispatch ? { preDispatchRetry: true } : {}),
                    reason: 'cycle_aborted_pre_dispatch'
                  });
                  if (isPreDispatch) {
                    i.state = 'pending';
                    if (cursorBeforeClaim != null && s.telegramUi?.run?.runId === run.runId && !i.payload?.account) {
                      s.telegramUi.run.cursor = cursorBeforeClaim;
                    }
                    preDispatchFailed = true;
                    moveItemToTailLocal(s, i.id);
                    recordUnsuccessfulAttempt(s, {
                      accountId,
                      outcome: 'failed',
                      at: clock(),
                      runId: run.runId,
                      itemId: item.id,
                      attemptToken: claim?.token,
                      preDispatchRetry: false
                    });
                  } else {
                    i.state = 'ambiguous';
                    i.requeueApproved = false;
                    i.reason ||= 'cycle_aborted_pre_dispatch';
                    recordUnsuccessfulAttempt(s, {
                      accountId,
                      outcome: 'ambiguous',
                      at: clock(),
                      runId: run.runId,
                      itemId: item.id,
                      attemptToken: claim?.token,
                      preDispatchRetry: i.state === 'pending' && i.archivedAttempt?.preDispatchRetry === true
                    });
                  }
                  delete i.attempt;
                  if (s.posting) s.posting.publishingAt = null;
                }
                return s;
              });
              break;
            }
          }
          if (publishMode === 'direct_x' && !session.identity?.authenticated) {
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
            if (!dispatchEntered) {
              preDispatchFailed = true;
              const snapAfter = await bot.store.load();
              const updatedItem = (snapAfter.items || []).find(x => x.id === item.id);
              if (updatedItem?.preDispatchRetries != null) itemPreDispatchRetries = updatedItem.preDispatchRetries;
            }
            break;
          } else {
          prepareScope.dispose();
          const adapterPublishMs = Number(adapter?.publishTimeoutMs);
          const publishBudgetMs = publishMode === 'owner_assisted'
            ? attemptTimeoutMs
            : (Number.isFinite(adapterPublishMs) && adapterPublishMs > 0
              ? Math.max(attemptTimeoutMs, adapterPublishMs + 15_000)
              : attemptTimeoutMs);
          publishScope = attemptScope(signal, publishBudgetMs);
          if (signal.aborted) throw Object.assign(new Error('Attempt ended'), { code: 'ATTEMPT_ABORTED' });
          let dispatchCalled = false;
          const onDispatch = async ({ accountId: reportedAccountId } = {}) => {
            if (dispatchCalled || attempt.signal.aborted || (reportedAccountId != null && reportedAccountId !== accountId)) throw Object.assign(new Error('Dispatch not admitted: DISPATCH_REJECTED'), { code: 'DISPATCH_REJECTED' });
            let dispatchReady = false;
            await attempt.wait(() => bot.store.update(s => {
              dispatchReady = false;
              const i = s.items.find(x => x.id === itemId);
              const a = s.accounts.find(x =>
                x.id === accountId &&
                x.enabled !== false &&
                !x.needsOwnerCaptcha &&
                !isCaptchaStatus(x.status) &&
                !isBannedStatus(x.status) &&
                !isUnverifiedStatus(x.status) &&
                !isAccountInactive(x.status) &&
                x.status !== 'معزول (3 إخفاقات)' &&
                evaluateAccountUse(s, x, { nowMs: new Date(clock()).getTime(), requireOwnerEnabled: true }).allowed
              );
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
            dispatchEntered = true;
            dispatchCalled = true;
            return true;
          };
          // Historical injected adapters have no pre-send callback. Preserve that
          // test seam with an explicit pre-call fence; production Direct always
          // uses its precise bridge dispatch-ready handshake, never this path.
          if (allowLivePublish && publishAdapterFactory && !(adapter instanceof DirectXAdapter) && adapter.supportsDispatchCallback !== true) await onDispatch({ accountId });
          // Queue routing is runner metadata, not a direct-X content field.
          const directPayload = { ...item.payload }; delete directPayload.account;
          if (!directPayload.media || (typeof directPayload.media === 'string' && !directPayload.media.trim())) delete directPayload.media;
          const publishStartedAt = Date.now();
          const result = publishMode === 'owner_assisted'
            ? buildOwnerAssistedIntent({ item, account })
            : await attempt.wait(() => adapter.publish({ session, payload: adapter instanceof DirectXAdapter ? directPayload : item.payload, confirmPublish: allowLivePublish, signal: attempt.signal, onDispatch }));
          publishResult = result;
          if (result?.rateLimit || result?.ambiguous || result?.reason === 'worker_poisoned' || session?.poisoned || session?.dead || session?.closed) {
            poisonedWorker = true;
          }
          if (result.published && !dispatchEntered) throw Object.assign(new Error('Missing dispatch fence'), { code: 'DISPATCH_FENCE_MISSING' });
          let newState = classifyPublishOutcome(result, dispatchEntered);
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
            errorCode: result.xErrorCode ?? result.reason ?? null,
            sanitizedError: result.rawError ? sanitizeError(result.rawError) : null,
            details: {
              dispatchEntered,
              bridgeStatus: result.status || null,
              textUtf16Length: typeof directPayload.text === 'string' ? directPayload.text.length : null,
              textCodePoints: typeof directPayload.text === 'string' ? Array.from(directPayload.text).length : null,
              verifiedNotPosted: result.verifiedNotPosted === true,
              xResponseKind: result.xResponseKind || null,
              xErrorMessage: result.xErrorMessage || null,
              httpStatus: Number.isInteger(result.httpStatus) ? result.httpStatus : null,
              transactionDegraded: typeof result.transactionDegraded === 'boolean' ? result.transactionDegraded : null,
              verificationError: result.verificationError || null
            }
          });
          const publishedAt = new Date(clock()).toISOString();
          const isZeroFeeMode = newState === 'dry_run' || newState === 'owner_assisted';
          const settlementForensicId = `post-settlement:${run.runId}:${item.id}:${claim?.token || 'unknown'}`;
          let transitioned = false;
          const maxSettlementAttempts = result?.published ? 4 : 1;
          for (let settleAttempt = 1; settleAttempt <= maxSettlementAttempts; settleAttempt++) {
            try {
              await bot.store.update(s => {
                transitioned = false;
                const i = s.items.find(x => x.id === item.id);
                if (!i) return s;
                const alreadyPublishedWithClaim =
                  result?.published === true &&
                  i.state === 'published' &&
                  claim?.token &&
                  (i.archivedAttempt?.token === claim.token ||
                    (Array.isArray(i.archivedAttempts) && i.archivedAttempts.some(a => a?.token === claim.token)));
                if (alreadyPublishedWithClaim) {
                  newState = 'published';
                  transitioned = true;
                  if (s.posting) s.posting.publishingAt = null;
                  return s;
                }
                if (i.state !== 'processing' || !i.attempt || !claim?.token || i.attempt.token !== claim.token) return s;
                const isPostDispatch = dispatchEntered || !isProvenPreDispatch(i);
                if (isPostDispatch && !['published', 'failed'].includes(newState)) {
                  newState = 'ambiguous';
                }
                s.posting ||= {};
                s.posting.publishingAt = null;
                transitioned = true;
                if (i.attempt) {
                  const outcomeState = newState === 'published'
                    ? 'published'
                    : newState === 'ambiguous'
                      ? 'ambiguous'
                      : (isZeroFeeMode && !isPostDispatch)
                        ? newState
                        : 'failed';
                  archiveAttemptRecord(i, { settledAt: publishedAt, outcomeState,
                    ...(!isPostDispatch && newState === 'pending' ? { preDispatchRetry: true } : {}) });
                }
                delete i.attempt;
                if (isZeroFeeMode && !isPostDispatch) {
                  i.state = 'pending';
                  i.reason = result.reason || newState;
                  if (newState === 'owner_assisted') {
                    i.ownerAssistedPackage = buildOwnerAssistedIntent({ item: i, account });
                  }
                  return s;
                }
                i.state = newState; i.reason = result.reason || null;
                if (newState === 'ambiguous') i.requeueApproved = false;
                if (newState === 'pending') {
                  i.preDispatchRetries = (i.preDispatchRetries || 0) + 1;
                  itemPreDispatchRetries = i.preDispatchRetries;
                  preDispatchFailed = true;
                  moveItemToTailLocal(s, i.id);
                }
                if (newState !== 'published') {
                  // Keep a bounded diagnosis on the durable queue item itself so
                  // incident reviews don't depend only on 7-day forensic retention.
                  i.failureDiagnostic = {
                    observedAt: publishedAt,
                    dispatchEntered: isPostDispatch,
                    rejectionReason: result.rejectionReason || null,
                    xResponseKind: result.xResponseKind || null,
                    xErrorCode: result.xErrorCode ?? null,
                    xErrorMessage: (result.xErrorMessage || result.rawError || result.reason)
                      ? sanitizeError(result.xErrorMessage || result.rawError || result.reason).slice(0, 512) : null,
                    httpStatus: Number.isInteger(result.httpStatus) ? result.httpStatus : null,
                  transactionDegraded: typeof result.transactionDegraded === 'boolean' ? result.transactionDegraded : null,
                    verificationError: result.verificationError ? sanitizeError(result.verificationError).slice(0, 512) : null,
                    timelineChecks: Number.isInteger(result.timelineChecks) ? result.timelineChecks : 0
                  };
                  bot.forensicLogger?.enqueue(s, {
                    id: settlementForensicId,
                    eventType: newState === 'failed' ? 'post_failed' : 'post_ambiguous',
                    accountId,
                    username: account?.username,
                    slot: session?.slot,
                    port: session?.port,
                    containerName: session?.containerName,
                    subnet: session?.exitIp ? normalizeSubnet(session.exitIp) : null,
                    exitIp: session?.exitIp,
                    xErrorCode: result.xErrorCode,
                    xErrorMessage: result.xErrorMessage || result.rawError || result.reason,
                    httpStatus: Number.isInteger(result.httpStatus) ? result.httpStatus : null,
                    details: { itemId: item.id, runId: run.runId, reason: result.reason, dispatchEntered: isPostDispatch }
                  });
                  recordUnsuccessfulAttempt(s, {
                    accountId,
                    outcome: newState === 'ambiguous' ? 'ambiguous' : 'failed',
                    at: clock(),
                    runId: run.runId,
                    itemId: item.id,
                    attemptToken: claim?.token,
                    preDispatchRetry: i.state === 'pending' && i.archivedAttempt?.preDispatchRetry === true
                  });
                } else {
                  delete i.failureDiagnostic;
                }
                if (['published', 'ambiguous'].includes(newState)) {
                  i.accountId = accountId; i.accountUsername = account?.username;
                  const minSeconds = Number.isSafeInteger(s.settings?.delayMinSeconds) ? s.settings.delayMinSeconds : 15;
                  const maxSeconds = Number.isSafeInteger(s.settings?.delayMaxSeconds) ? Math.max(minSeconds, s.settings.delayMaxSeconds) : minSeconds;
                  const delaySeconds = Math.max(15, randomInt(minSeconds, maxSeconds + 1));
                  s.posting.nextPostAt = new Date(new Date(publishedAt).getTime() + delaySeconds * 1000).toISOString();
                }
                if (newState === 'published') {
                  i.publishedAt = publishedAt; i.url = result.url;
                  if (result.tweetId != null) i.tweetId = String(result.tweetId);
                  bot.forensicLogger?.enqueue(s, {
                    id: settlementForensicId,
                    eventType: 'post_success',
                    accountId,
                    username: account?.username,
                    slot: session?.slot,
                    port: session?.port,
                    containerName: session?.containerName,
                    subnet: session?.exitIp ? normalizeSubnet(session.exitIp) : null,
                    exitIp: session?.exitIp,
                    details: { itemId: item.id, url: result.url, tweetId: result.tweetId ?? null }
                  });
                  recordRunAttemptOutcome(s, {
                    runId: run.runId,
                    accountId,
                    itemId: item.id,
                    attemptToken: claim?.token,
                    outcome: 'succeeded',
                    at: new Date(publishedAt)
                  });
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
              break;
            } catch (settleErr) {
              if (settleAttempt < maxSettlementAttempts && isTransientSettlementError(settleErr)) {
                logStructured(logger, {
                  level: 'warn',
                  component: 'runner',
                  event: 'publish_settlement_retry',
                  runId: run.runId,
                  accountId,
                  queueItemId: item.id,
                  attempt: settleAttempt,
                  errorCode: extractErrorCode(settleErr),
                  sanitizedError: sanitizeError(settleErr)
                });
                await sleepFn(25 * (2 ** (settleAttempt - 1)));
                continue;
              }
              throw settleErr;
            }
          }
          if (!transitioned) break;
          if (result.accountFailure) {
            try {
              await ui.recordAccountCheck(accountId, { accountFailure: result.accountFailure }, { session: true, expectedAccount: account });
            } catch (checkErr) {
              if (newState === 'published') {
                logStructured(logger, {
                  level: 'warn',
                  component: 'runner',
                  event: 'post_published_account_check_failed',
                  runId: run.runId,
                  accountId,
                  queueItemId: item.id,
                  errorCode: extractErrorCode(checkErr),
                  sanitizedError: sanitizeError(checkErr)
                });
              } else {
                throw checkErr;
              }
            }
          }
          if (newState === 'published') {
            // Re-run the durable event through the normal flusher after the
            // settlement commit. The stable ID makes this idempotent while
            // keeping the primary evidence in the same transaction.
            trackForensic(bot.forensicLogger?.record({
              id: settlementForensicId,
              eventType: 'post_success',
              accountId,
              username: account?.username,
              slot: session?.slot,
              port: session?.port,
              containerName: session?.containerName,
              subnet: session?.exitIp ? normalizeSubnet(session.exitIp) : null,
              exitIp: session?.exitIp,
              details: { itemId: item.id, url: result.url, tweetId: result.tweetId ?? null }
            }).catch(err => logStructured(logger, { level: 'error', component: 'runner', event: 'forensic_record_failed', accountId, operation: 'post_success.record', result: 'failed', errorCode: extractErrorCode(err), sanitizedError: sanitizeError(err) })));
          }
          logger.log(JSON.stringify({
            event: 'post_result',
            runId: run.runId,
            item: item.id,
            status: newState,
            account: accountId,
            reason: result.reason || result.status,
            url: result.url || null,
            dispatchEntered: Boolean(dispatchEntered),
            durationMs: Date.now() - publishStartedAt,
            xErrorCode: result.xErrorCode ?? null,
            xResponseKind: result.xResponseKind || null,
            xErrorMessage: result.xErrorMessage ? sanitizeError(result.xErrorMessage).slice(0, 512) : null,
            httpStatus: Number.isInteger(result.httpStatus) ? result.httpStatus : null,
              transactionDegraded: typeof result.transactionDegraded === 'boolean' ? result.transactionDegraded : null,
            verificationError: result.verificationError ? sanitizeError(result.verificationError).slice(0, 512) : null
          }));
          if (newState === 'published') {
            await bot.store.update(s => {
              const acc = (s.accounts || []).find(a => a.id === accountId);
              // A late success callback must not clear a newer account revision's
              // failures or cooling entry. The claim fence protects the item;
              // this revision fence protects account-side cleanup.
              if (!acc || accountRevision(acc) !== accountRevision(account)) return s;
              cooling.delete(accountId);
              if (s.posting?.cooling) delete s.posting.cooling[accountId];
              acc.failures = 0;
              return s;
            });
            if (onPostPersisted) await onPostPersisted({ itemId: item.id, accountId, publishedAt, url: result.url, stop: () => ui.stop() });
            if (run.stopAfterSuccess) { await ui.stop(); halt = true; }
          } else if (isZeroFeeMode) {
            if (newState === 'owner_assisted') {
              const pkg = buildOwnerAssistedIntent({ item, account });
              await notify(`📦 جاهز للنشر اليدوي الآمن (@${pkg.username || account.id}):\n${pkg.intentUrl}`);
            }
            halt = true;
            skipDelay = true;
            retry = false;
            break;
          } else if (newState === 'ambiguous' || newState === 'failed') {
            // The per-item publication evidence was enqueued atomically with
            // settlement above. Account diagnostics below remain separate.
            // Preserve the per-item forensic event without spamming Telegram.
            // A single alert is emitted only when the account is isolated.
            const outcome = await handleAccountFailure({
              accountId,
              account,
              item,
              claim,
              session,
              failure: result.accountFailure || (result.rateLimit ? 'rate_limit' : (newState === 'failed' ? null : 'ambiguous')),
              reason: result.reason || 'publish_confirmation_missing',
              retryAfterSeconds: result.retryAfterSeconds,
              rawError: result.rawError,
              xErrorCode: result.xErrorCode,
              xResponseKind: result.xResponseKind,
              rejectionReason: result.rejectionReason
            });
            if (outcome.halt) { halt = true; }
            skipDelay = false;
            retry = false;
            break;
          } else if (result.retryable === true && (!dispatchEntered && result.reason === 'identity_read_unavailable') && !result.accountFailure) {
            retry = true;
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
            if (!dispatchEntered) preDispatchFailed = true;
            break;
          } else if (newState === 'pending') { retry = true; }
          else if (newState === 'cancelled') { skipDelay = true; }
          }
        } catch (err) {
          attemptError = err;
          if (err?.code === 'DIRECT_X_CLEANUP_UNVERIFIED' || session?.dead || session?.poisoned || session?.closed) poisonedWorker = true;
          if (err.readDiagnostic?.httpStatus === 429) retryAfterMs = Math.min(900000, Math.max(60000, (err.readDiagnostic.retryAfterSeconds || 60) * 1000));
          logger.error(JSON.stringify({ event: 'post_error', item: item.id, code: err.code || 'UNKNOWN', readPhase: ['user_state','settings','verify_credentials','profile','bridge'].includes(err.readDiagnostic?.phase) ? err.readDiagnostic.phase : undefined, httpStatus: Number.isInteger(err.readDiagnostic?.httpStatus) ? err.readDiagnostic.httpStatus : undefined }));
          trackForensic(bot.forensicLogger?.record({
            eventType: 'post_error',
            accountId,
            username: account?.username,
            slot: session?.slot,
            port: session?.port,
              containerName: session?.containerName,
              subnet: session?.exitIp ? normalizeSubnet(session.exitIp) : null,
            exitIp: session?.exitIp,
            httpStatus: err.readDiagnostic?.httpStatus || err.httpStatus,
            xErrorCode: err.code || err.xErrorCode,
            xErrorMessage: err.message,
            endpoint: err.readDiagnostic?.phase || 'CreateTweet',
            rawResponseSnippet: err.rawBody || err.readDiagnostic?.snippet,
            details: { itemId: item.id }
          }).catch(err => logStructured(logger, { level: 'error', component: 'runner', event: 'forensic_record_failed', accountId, operation: 'post_error.record', result: 'failed', errorCode: extractErrorCode(err), sanitizedError: sanitizeError(err) })));
          await bot.store.update(s => {
            const i = s.items.find(x => x.id === item.id);
            if (i?.state === 'processing' && claim?.token && i.attempt?.token === claim.token) {
              const isPostDispatch = dispatchEntered || !isProvenPreDispatch(i);
              const skipRetryBurn = !isPostDispatch && isNonPenalizingPreDispatchError(err, { signal });
              if (i.attempt) {
                archiveAttemptRecord(i, {
                  failedAt: new Date(clock()).toISOString(),
                  outcomeState: isPostDispatch ? 'ambiguous' : 'failed',
                  ...(!isPostDispatch && !skipRetryBurn ? { preDispatchRetry: true } : {}),
                  errorCode: err.code || err.xErrorCode || null
                });
              }
              i.state = isPostDispatch ? 'ambiguous' : 'pending';
              if (!isPostDispatch) {
                if (!skipRetryBurn) {
                  i.preDispatchRetries = (i.preDispatchRetries || 0) + 1;
                  itemPreDispatchRetries = i.preDispatchRetries;
                }
                if (cursorBeforeClaim != null && s.telegramUi?.run?.runId === run.runId && !i.payload?.account) {
                  s.telegramUi.run.cursor = cursorBeforeClaim;
                }
                preDispatchFailed = true;
                moveItemToTailLocal(s, i.id);
              } else {
                i.requeueApproved = false;
              }
              i.failureDiagnostic = {
                observedAt: new Date(clock()).toISOString(),
                dispatchEntered: isPostDispatch,
                rejectionReason: err.rejectionReason || null,
                xResponseKind: err.xResponseKind || 'exception',
                xErrorCode: err.xErrorCode ?? err.code ?? null,
                xErrorMessage: err.message ? sanitizeError(err.message).slice(0, 512) : null,
                httpStatus: Number.isInteger(err.httpStatus) ? err.httpStatus : null,
                verificationError: err.verificationError ? sanitizeError(err.verificationError).slice(0, 512) : null
              };
              const exceptionOutcome = i.state === 'ambiguous' ? 'ambiguous' : 'failed';
              bot.forensicLogger?.enqueue(s, {
                id: `post-exception:${run.runId}:${item.id}:${claim?.token || 'unknown'}`,
                eventType: exceptionOutcome === 'ambiguous' ? 'post_ambiguous' : 'post_failed',
                accountId,
                username: account?.username,
                slot: session?.slot,
                port: session?.port,
                containerName: session?.containerName,
                subnet: session?.exitIp ? normalizeSubnet(session.exitIp) : null,
                exitIp: session?.exitIp,
                xErrorCode: err.code || err.xErrorCode,
                xErrorMessage: err.message,
                details: { itemId: item.id, runId: run.runId, reason: err.reason || err.code || 'exception', dispatchEntered: isPostDispatch }
              });
              recordUnsuccessfulAttempt(s, {
                accountId,
                outcome: exceptionOutcome,
                at: clock(),
                runId: run.runId,
                itemId: item.id,
                attemptToken: claim?.token,
                preDispatchRetry: i.state === 'pending' && i.archivedAttempt?.preDispatchRetry === true
              });
              if (i.state === 'ambiguous') {
                i.reason = String(err.reason || err.code || 'exception_after_dispatch');
                i.accountId = accountId;
                i.accountUsername = account?.username;
                const minSeconds = Number.isSafeInteger(s.settings?.delayMinSeconds) ? s.settings.delayMinSeconds : 15;
                const maxSeconds = Number.isSafeInteger(s.settings?.delayMaxSeconds) ? Math.max(minSeconds, s.settings.delayMaxSeconds) : minSeconds;
                const delaySeconds = Math.max(15, randomInt(minSeconds, maxSeconds + 1));
                s.posting.nextPostAt = new Date(clock().getTime() + delaySeconds * 1000).toISOString();
              }
              delete i.attempt;
              if (s.posting) s.posting.publishingAt = null;
            }
            return s;
          });
          if (err.code === 'DIRECT_X_CLEANUP_UNVERIFIED') { halt=true; retry=false; break; }
          if (dispatchEntered) {
            trackForensic(bot.forensicLogger?.record({
              eventType: 'post_ambiguous',
              accountId,
              username: account?.username,
              slot: session?.slot,
              port: session?.port,
              containerName: session?.containerName,
              subnet: session?.exitIp ? normalizeSubnet(session.exitIp) : null,
              exitIp: session?.exitIp,
              xErrorCode: err.code || err.xErrorCode,
              xErrorMessage: err.message,
              details: { itemId: item.id, reason: 'exception_after_dispatch' }
            }).catch(err => logStructured(logger, { level: 'error', component: 'runner', event: 'forensic_record_failed', accountId, operation: 'post_ambiguous_dispatch.record', result: 'failed', errorCode: extractErrorCode(err), sanitizedError: sanitizeError(err) })));
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
              failure: err.accountFailure || 'ambiguous',
              reason: err.code || err.message || 'exception_after_dispatch',
              retryAfterSeconds: err.retryAfterSeconds || err.readDiagnostic?.retryAfterSeconds,
              rawError: err.message,
              xErrorCode: err.code || err.xErrorCode,
              xResponseKind: err.xResponseKind,
              rejectionReason: err.rejectionReason
            });
            if (outcome.halt) { halt = true; }
            skipDelay = false;
            retry = false;
            break;
          }
          else if (!dispatchEntered && (['DIRECT_X_IDENTITY_READ_UNAVAILABLE', 'VPN_TRANSIENT_UNAVAILABLE', 'VPN_READINESS_FAILED'].includes(err.code) || /vpn|proxy|socks/i.test(err.code || err.message))) {
            retry = true;
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
            if (!dispatchEntered) preDispatchFailed = true;
            break;
          }
          else if (['ATTEMPT_TIMEOUT', 'ATTEMPT_ABORTED', 'DISPATCH_REJECTED', 'DISPATCH_FENCE_MISSING'].includes(err.code)) halt = true;
          else retry = true;
        } finally {
          if (workerLease) {
            try {
              const shouldDrainWorker = Boolean(
                poisonedWorker ||
                attemptError?.code === 'ATTEMPT_TIMEOUT' ||
                attemptError?.code === 'ATTEMPT_ABORTED' ||
                attemptError?.code === 'DIRECT_X_CLEANUP_UNVERIFIED' ||
                session?.dead ||
                session?.poisoned ||
                session?.closed ||
                publishResult?.ambiguous ||
                publishResult?.rateLimit ||
                publishResult?.reason === 'worker_poisoned'
              );
              if (shouldDrainWorker) {
                await workerPool.drain(accountId);
              } else {
                await workerLease.release();
              }
            } catch (releaseErr) {
              logStructured(logger, { level: 'warn', component: 'runner', event: 'worker_lease_release_failed', accountId, error: releaseErr?.message });
            }
          } else if (adapter) {
            // A cancelled open may still own resources; bound waiting for it,
            // and if it resolves late, close it asynchronously.
            if (!session && openTask) {
              let timedOutOpen = false;
              openTask.then(late => {
                if (timedOutOpen && late) {
                  Promise.resolve().then(() => adapter.close({ session: late })).catch(() => {});
                }
              }, () => {});
              try {
                session = await withBoundedTimeout(openTask, openTeardownTimeoutMs, 'ADAPTER_OPEN_TEARDOWN_TIMEOUT');
              } catch (openErr) {
                if(openErr?.code === 'DIRECT_X_CLEANUP_UNVERIFIED')halt=true;
                timedOutOpen = true;
                logStructured(logger, { level: 'warn', component: 'runner', event: 'adapter_open_task_failed', operation: 'openTask.finally', result: 'failed', errorCode: extractErrorCode(openErr), sanitizedError: sanitizeError(openErr) });
              }
            }
            const closing = Promise.resolve().then(() => adapter.close({ session, signal: attempt.signal }));
            closing.catch(closeErr => logStructured(logger, { level: 'warn', component: 'runner', event: 'adapter_closing_rejected', operation: 'closing', result: 'failed', errorCode: extractErrorCode(closeErr), sanitizedError: sanitizeError(closeErr) }));
            try {
              await withBoundedTimeout(closing, closeTimeoutMs, 'ADAPTER_CLOSE_TIMEOUT');
            } catch (closeErr) {
              halt = true;
              logStructured(logger, { level: 'error', component: 'runner', event: 'adapter_close_failed', operation: 'adapter.close', result: 'failed', errorCode: extractErrorCode(closeErr), sanitizedError: sanitizeError(closeErr) });
            }
          }
          if (!workerLease) {
            try { route?.release?.(); } catch (releaseError) {
              halt = true;
              logStructured(logger, { level: 'error', component: 'runner', event: 'vpn_route_release_failed', operation: 'route.release', result: 'failed', errorCode: extractErrorCode(releaseError), sanitizedError: sanitizeError(releaseError) });
            }
          }
          attempt.dispose();
          if (claim?.claimed && claim?.token) {
            await bot.store.update(s => {
              const i = s.items.find(x => x.id === itemId);
              if (i?.state === 'processing' && i.attempt?.token === claim.token) {
                const isPreDispatch = isProvenPreDispatch(i) && !dispatchEntered;
                archiveAttemptRecord(i, {
                  failedAt: new Date(clock()).toISOString(),
                  outcomeState: isPreDispatch ? 'failed' : 'ambiguous',
                  ...(isPreDispatch ? { preDispatchRetry: true } : {}),
                  reason: 'settled_in_finally'
                });
                if (isPreDispatch) {
                  const skipRetryBurn = isNonPenalizingPreDispatchError(attemptError, { signal });
                  i.state = 'pending';
                  if (!skipRetryBurn) {
                    i.preDispatchRetries = (i.preDispatchRetries || 0) + 1;
                    itemPreDispatchRetries = i.preDispatchRetries;
                  }
                  if (cursorBeforeClaim != null && s.telegramUi?.run?.runId === run.runId && !i.payload?.account) {
                    s.telegramUi.run.cursor = cursorBeforeClaim;
                  }
                  preDispatchFailed = true;
                  moveItemToTailLocal(s, i.id);
                  recordUnsuccessfulAttempt(s, {
                    accountId,
                    outcome: 'failed',
                    at: clock(),
                    runId: run.runId,
                    itemId: item.id,
                    attemptToken: claim?.token,
                    preDispatchRetry: !skipRetryBurn
                  });
                  delete i.attempt;
                } else {
                  i.state = 'ambiguous';
                  i.requeueApproved = false;
                  recordUnsuccessfulAttempt(s, {
                    accountId,
                    outcome: 'ambiguous',
                    at: clock(),
                    runId: run.runId,
                    itemId: item.id,
                    attemptToken: claim?.token,
                    preDispatchRetry: i.state === 'pending' && i.archivedAttempt?.preDispatchRetry === true
                  });
                  i.reason ||= 'unresolved_in_finally';
                  i.accountId ||= accountId;
                  i.accountUsername ||= account?.username;
                  delete i.attempt;
                }
                if (s.posting) s.posting.publishingAt = null;
              }
              return s;
            });
          }
        }
        if (halt || signal.aborted) break;
        if (retry) {
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
        }
        if (preDispatchFailed || skipDelay || retry) break;
        const remaining = await bot.store.load();
        const protectedTexts = protectedTextKeys(remaining.items || []);
        const hasEligible = (remaining.items || []).some(candidate => itemIds.has(candidate.id) && isClaimableInState(candidate, remaining, protectedTexts) && selectAccount(remaining, run, candidate, clock()));
        if (!hasEligible) break;
        const delayEnd = Date.parse(remaining.posting?.nextPostAt || '');
        while (Number.isFinite(delayEnd) && clock().getTime() < delayEnd && !signal.aborted) {
          await sleepWithSignal(sleepFn, Math.min(1000, delayEnd - clock().getTime()), signal);
        }
        break;
        }
        if (preDispatchFailed) {
          const runRetries = (runPreDispatchRetries.get(itemId) || 0) + 1;
          runPreDispatchRetries.set(itemId, runRetries);
          if (runRetries >= MAX_PRE_DISPATCH_RETRIES || itemPreDispatchRetries >= MAX_PRE_DISPATCH_RETRIES) {
            itemIds.delete(itemId);
          } else {
            if (itemIds.has(itemId)) {
              itemIds.delete(itemId);
              itemIds.add(itemId);
            }
            if (!movedToTailInPass.has(itemId) && itemIdx < itemIdsList.length - 1) {
              movedToTailInPass.add(itemId);
              itemIdsList.splice(itemIdx, 1);
              itemIdsList.push(itemId);
              itemIdx--;
            }
          }
        }
        if (halt || signal.aborted) break cycleLoop;
      }
      const next = await bot.store.load();
      if (signal.aborted || next.cycle?.state !== 'running' || next.cycle.runId !== run.runId) break;
      const protectedTexts = protectedTextKeys(next.items || []);
      const pending = (next.items || []).filter(i => itemIds.has(i.id) && isClaimableInState(i, next, protectedTexts));
      if (!pending.length) break;
      const canSelectOrRefresh = account => {
        if (!account || account.enabled === false) return false;
        if (account.needsOwnerCaptcha || isCaptchaStatus(account.status) || isBannedStatus(account.status) || isUnverifiedStatus(account.status) || isAccountInactive(account.status) || account.status === 'معزول (3 إخفاقات)' || (account.failures || 0) >= 3) return false;
        if (accountCapacity(next, account, clock()).remaining <= 0) return false;
        const evalRes = evaluateAccountUse(next, account, { nowMs: clock().getTime(), requireOwnerEnabled: true });
        return evalRes.allowed || evalRes.reason === 'session_missing';
      };
      const hasSelectableAccount = pending.some(i => {
        if (i.payload?.account) {
          const id = i.payload.account;
          if (!(run.accountIds || []).includes(id)) return false;
          const acc = (next.accounts || []).find(a => a.id === id);
          return canSelectOrRefresh(acc);
        }
        return (run.accountIds || []).some(id => {
          const acc = (next.accounts || []).find(a => a.id === id);
          return canSelectOrRefresh(acc);
        });
      });
      if (!pending.some(i => selectAccount(next, run, i, clock())) && !hasSelectableAccount) break;
      const ready = pending.some(i => selectAccount(next, run, i, clock(), excluded(next)));
      if (ready && !claimedInPass) await sleepWithSignal(sleepFn, 1000, signal);
      if (!ready) {
        const coolingWait = [...cooling.values()].map(v => v.until - clock().getTime()).filter(ms => ms > 0);
        const minWait = coolingWait.length ? Math.min(...coolingWait) : 1000;
        await sleepWithSignal(sleepFn, Math.min(1000, Math.max(1, minWait)), signal);
      }
      }
      const finished = await bot.store.load();
      const quota = quotaAdmission(finished, { accounts: (finished.accounts || []).filter(a => (run.accountIds || []).includes(a.id)), items: (finished.items || []).filter(i => itemIds.has(i.id)), now: clock() });
      if (!signal.aborted && quota.exhausted) {
        await stopCycleForQuota({ store: bot.store, runId: run.runId, clock });
        await notify(quota.message);
      }
      if (typeof workerPool?.drainAll === 'function') {
        await workerPool.drainAll({ timeoutMs: closeTimeoutMs }).catch(() => {});
      }
    };

    const sendExport = (run, options) => {
      const task = links.send(run, options).catch(async error => {
        logger.error(JSON.stringify({ event: 'export_send_failed', code: error.code || 'UNKNOWN' }));
        await notify('تعذر إنشاء أو إرسال ملف روابط المنشورات؛ يرجى مراجعة السجل وإعادة المحاولة.');
      });
      exportTasks.add(task); task.finally(() => exportTasks.delete(task)).catch(() => {}); return task;
    };
    ui = new TelegramUi({ bot, vpnManager: vpnSlots, launch: launchCycle, clock, downloadDocument: async document => {
      const file = await api.getFile({ file_id: document.file_id });
      if (file.file_size > 2 * 1024 * 1024) throw new Error('الملف أكبر من 2 ميجابايت.');
      return api.downloadFile(file.file_path, { maxBytes: 2 * 1024 * 1024 });
    }, downloadDocumentToFile: async (document, target, options) => {
      const file = await api.getFile({ file_id: document.file_id });
      if (file.file_size > options.maxBytes) throw Object.assign(new Error('FILE_TOO_LARGE'), { code:'FILE_TOO_LARGE' });
      return api.downloadFileTo(file.file_path,target,options);
    }, runtimeReady, isolatedVerifier, notify, onPanelTask: trackPanel,
      workerPool,
      drainWorkers: async ids => Promise.all((ids || []).map(id => workerPool?.drain(id))),
      exportTodayLinks: async ({chatId:targetChat,at}) => {
        const task=(async()=>{
          const result=await links.exportToday({at});
          if(result.empty)return api.sendMessage({chat_id:targetChat,text:'لا توجد روابط منشورات مؤكدة مسجلة لليوم حتى الآن.'});
          return api.sendDocument({chat_id:targetChat,filename:result.filename,content:result.content});
        })();
        exportTasks.add(task);
        try{return await task;}finally{exportTasks.delete(task);}
      },
      // Stop only fences dispatch. Export after the job settles so a confirmed
      // in-flight success cannot create a second report from final cleanup.
      onCycleStop: () => { abortController?.abort(); workerPool?.fenceAdmission(); },
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
    // Internal callers (imports, recovery, and direct AccountManager users)
    // must pass the same revision-bound verification fence as Telegram.
    if (bot.accounts) bot.accounts.activationVerifier = async account => {
      const verdict = await ui._preflightActivation(account.id);
      if (!verdict.allowed) return null;
      const current = await bot.store.load();
      return { session: current.telegramUi?.accountChecks?.[account.id]?.session || null };
    };
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
      task.finally(() => { exportTasks.delete(task); if (reconciliation === task) reconciliation = null; }).catch(() => {});
      return task;
    };
    ui.links=links;
    bot.drainWorkers = async ids => Promise.all((ids || []).map(id => workerPool?.drain(id)));
    if (bot.store.isPostgres && typeof bot.store.getDashboardSnapshot === 'function') {
      ui.normalizedDashboardIntervalMs = 1000;
      ui.normalizedDashboardReader = {
        read: day => bot.store.getDashboardSnapshot({ day, now: new Date(clock()).toISOString() }),
        close: async () => {}
      };
    }
    const restored = await ui.restore();
    await trackForensic(bot.forensicLogger?.flushOutbox?.().catch(() => {}));
    await reconcileLinks({ startup: true }); // Interrupted work is a report boundary before any resume.
    if (restored?.resume) {
      const restoredState = await bot.store.load();
      if (restoredState.cycle?.state === 'running' && restoredState.cycle.runId === restored.resume.runId && !(restoredState.items || []).some(i => ['processing', 'dispatch_started'].includes(i.state))) await ui.resume(restored.resume);
    }
    const defaultVerifyTweet = async ({ tweetId, accountId: targetAccountId, expectedText } = {}) => {
      const current = await bot.store.load();
      const account = (current.accounts || []).find(a => a.id === targetAccountId);
      if (!account) {
        return { verified: false, reason: 'account_not_found' };
      }
      let route = null;
      const verifyScope = attemptScope(abortController?.signal, 25_000);
      try {
        if (typeof vpnSlots.acquireReadRoute !== 'function') return { verified: false, reason: 'vpn_not_ready' };
        // An acquisition that ignores cancellation may finish after the timeout.
        // Release that late lease rather than leaving the slot permanently held.
        let abandoned = false;
        const acquisition = Promise.resolve().then(() => vpnSlots.acquireReadRoute(account.id, { signal: verifyScope.signal })).then(value => {
          if (abandoned) { try { value?.release?.(); } catch {} }
          return value;
        });
        try {
          route = await withBoundedTimeout(acquisition, 25_000, 'VERIFY_TWEET_VPN_TIMEOUT');
        } catch (error) {
          abandoned = true;
          throw error;
        }
        const vpn = route;
        if (!vpn?.proxy || typeof vpn.release !== 'function') {
          return { verified: false, reason: 'vpn_not_ready' };
        }
        const customAdapter = verifyAdapterFactory ? verifyAdapterFactory() : null;
        const verifierAdapter = typeof customAdapter?.verifyPublishedTweet === 'function'
          ? customAdapter
          : new DirectXAdapter({ allowPublish: false });
        return await withBoundedTimeout(
          verifierAdapter.verifyPublishedTweet({
            account,
            proxy: vpn.proxy,
            tweetId,
            expectedText,
            signal: verifyScope.signal
          }),
          25_000,
          'VERIFY_TWEET_TIMEOUT'
        );
      } finally {
        try { route?.release?.(); } catch {}
        verifyScope.dispose();
      }
    };
    const settleOwnerAssistedWithDefaults = opts => settleOwnerAssistedPost(bot.store, {
      dataDir,
      api,
      chatIds: effectiveChatIds,
      auth: bot.auth,
      logger,
      clock,
      verifyTweet: defaultVerifyTweet,
      ...opts
    });
    bot.settleOwnerAssistedPost = settleOwnerAssistedWithDefaults;
    bot.prepareCycle = prepareCycle;
    const { runnerStart, runnerStop } = createRunnerControls({
      ui,
      workerPool,
      getAbortController: () => abortController,
      isStopping: () => stopping
    });
    if (onRuntimeReady) await onRuntimeReady({
      bot, ui,
      start: runnerStart,
      stop: runnerStop,
      wait: () => ui.job || Promise.resolve(),
      shutdown: stop,
      state: () => bot.store.load(),
      settleOwnerAssistedPost: settleOwnerAssistedWithDefaults,
      prepareCycle,
      workerPool
    });
    await ui.initializeFastNavigation();
    await ui.flows.imports.recover();
    // Independent of publication schedule and getUpdates long polling.
    let dailyTask;
    const dailyTick=()=>{if(dailyTask)return;const task=links.daily().catch(error=>logger.error(JSON.stringify({event:'daily_links_failed',code:error.code||'UNKNOWN'})));dailyTask=task;exportTasks.add(task);task.finally(()=>{exportTasks.delete(task);dailyTask=null;}).catch(()=>{});};
    dailyTick();
    const dailyTimer=setInterval(dailyTick,1000);dailyTimer.unref?.();
    stopDailyLinks=()=>clearInterval(dailyTimer);
    let scheduleSettings = await bot.settings.get();
    unsubscribeSchedule = bot.store.onMutation?.(state => {
      if (state && state.settings) {
        scheduleSettings = state.settings;
      } else {
        bot.settings.get().then(s => { scheduleSettings = s; }).catch(() => {});
      }
    });
    publicationScheduler = createPublicationScheduler({
      settings: { get: async () => scheduleSettings }, clock,
      start: occurrence => stopping ? { started: false } : ui.startScheduled(occurrence),
      onError: error => logger.error(JSON.stringify({ event: 'schedule_check_error', code: error.code || 'UNKNOWN' }))
    });
    pendingScheduleTick = Promise.resolve(publicationScheduler.tick()).catch(error =>
      logger.error(JSON.stringify({ event: 'schedule_check_error', code: error.code || 'UNKNOWN' }))
    );
    watchdog?.poll();
    let polls = 0;
    let conflictRetries = 0;
    while (!stopping && polls < maxPolls) {
      polls += 1;
      try {
        reconcileLinks();
        // Panel updates come from canonical mutations and the active-cycle clock.
        // getUpdates remains an independent long poll.
        if(stopping)break;
        const updates = await api.getUpdates({ offset, timeout: pollTimeout, allowed_updates: ['message', 'callback_query'] }, { signal: pollController.signal }) || [];
        if (stopping) break; // Do not admit a late response after SIGTERM.
        conflictRetries = 0;
        watchdog?.poll();
        let retryFromAmbiguous = false;
        const batchReceivedAt=Date.now();
        // ACK every authorized callback before an earlier update's durable
        // progress write or long handler can delay its spinner dismissal.
        for(const update of updates) {
          try {bot.transport.prepareUpdate(update,{auth:bot.auth,logger,receivedAt:batchReceivedAt});}
          catch {} // Canonical dispatcher retains authorization/error handling.
        }
        for (const update of updates) {
          if(stopping)break;
          const id = updateId(update);
          if (id === null) continue;
          if (retryFromAmbiguous) break;
          if (id < offset || processed.has(id)) continue;
          // Dispatch first. Persisting the offset before this point can lose an
          // update forever if the process crashes while handling it.
          let dispatchResult;
          try {
            dispatchResult = await bot.transport.dispatchUpdate(update, { auth: bot.auth, logger, deferNavigation: true, actions: ui.actions({
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
                  if (file.file_size != null && file.file_size > MAX_COOKIE_FILE_BYTES) {
                    throw Object.assign(new Error('COOKIE_FILE_TOO_LARGE: حجم ملف الكوكيز يتجاوز 1 ميجابايت.'), { code: 'COOKIE_FILE_TOO_LARGE' });
                  }
                  const content = await api.downloadFile(file.file_path, { maxBytes: MAX_COOKIE_FILE_BYTES });
                  result = await bot.cookies.storeContent(`cred-${require('node:crypto').randomUUID()}`, content.toString('utf8'));
                } else {
                  const candidateName = String(request.command.args[1] || '').trim();
                  const isSafeBasename = candidateName &&
                    !candidateName.includes('/') &&
                    !candidateName.includes('\\') &&
                    !candidateName.includes('..') &&
                    candidateName === path.basename(candidateName) &&
                    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\.(?:cookies|json|txt)$/i.test(candidateName);
                  if (!isSafeBasename) {
                    return bot.transport.sendMessage(destination, '⚠️ مسار غير مسموح: يجب تحديد اسم ملف صالح محفوظ داخل مجلد الكوكيز الخاص فقط، أو إرسال ملف الكوكيز كمستند.');
                  }
                  const cookiesDir = bot.cookies.directory;
                  const target = path.join(cookiesDir, candidateName);
                  const lstat = await fs.lstat(target).catch(() => null);
                  if (!lstat || lstat.isSymbolicLink() || !lstat.isFile()) {
                    return bot.transport.sendMessage(destination, '⚠️ ملف الكوكيز المحدد غير موجود أو غير صالح داخل المجلد المحمي.');
                  }
                  const real = await fs.realpath(target).catch(() => null);
                  if (!real || real !== target || path.dirname(real) !== cookiesDir) {
                    return bot.transport.sendMessage(destination, '⚠️ مسار غير مسموح خارج المجلد المحمي.');
                  }
                  result = await bot.cookies.store(`cred-${require('node:crypto').randomUUID()}`, target);
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
                task.finally(() => exportTasks.delete(task)).catch(() => {});
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
            }) });
            const nextOffset = Math.max(offset, id + 1);
            const nextProcessed = new Set(processed);
            nextProcessed.add(id);
            while (nextProcessed.size > 100) nextProcessed.delete(nextProcessed.values().next().value);
            try {
              await persistTelegramProgress(nextOffset, nextProcessed);
            } catch (persistError) {
              stopping = true;
              logger.error(JSON.stringify({
                event: 'telegram_progress_persist_failed',
                code: persistError.code || 'TELEGRAM_PROGRESS_PERSIST_FAILED'
              }));
              break;
            }
            logger.log(JSON.stringify({ event: 'update_dispatched', action: dispatchResult.action || null, handled: dispatchResult.handled === true }));
          } catch (error) {
            // Definite application rejection is durably dead-lettered; an
            // ambiguous transport failure is retried after restart.
            if (!isAmbiguousTelegramError(error)) {
              const nextOffset = Math.max(offset, id + 1);
              const nextProcessed = new Set(processed);
              nextProcessed.add(id);
              while (nextProcessed.size > 100) nextProcessed.delete(nextProcessed.values().next().value);
              try {
                await persistTelegramProgress(nextOffset, nextProcessed);
              } catch (persistError) {
                stopping = true;
                logger.error(JSON.stringify({
                  event: 'telegram_progress_persist_failed',
                  code: persistError.code || 'TELEGRAM_PROGRESS_PERSIST_FAILED'
                }));
                break;
              }
            }
            if (isAmbiguousTelegramError(error)) retryFromAmbiguous = true;
            if (error.code !== 'UNAUTHORIZED') logger.error(JSON.stringify({ event: 'update_failed', code: error.code || 'UNKNOWN' }));
          }
        }
      } catch (error) {
        if (stopping && pollController.signal.aborted) break;
        if (error.telegramCode === 409 || error.statusCode === 409 || /conflict/i.test(error.message || '')) {
          const sanitizedMsg = sanitizeError(error) || 'another instance is running';
          if (conflictRetries < maxConflictRetries && !stopping) {
            conflictRetries += 1;
            logger.error(JSON.stringify({
              event: 'telegram_conflict_transient',
              code: 'TELEGRAM_CONFLICT_RETRY',
              message: sanitizedMsg,
              retry: conflictRetries,
              backoffMs: conflictBackoffMs
            }));
            await sleepWithSignal(sleepFn, conflictBackoffMs, pollController.signal);
            watchdog?.poll();
            continue;
          }
          logger.error(JSON.stringify({ event: 'telegram_conflict', code: 'TELEGRAM_CONFLICT', message: sanitizedMsg }));
          const conflictErr = Object.assign(new Error(`Telegram polling conflict: another instance is running (${sanitizedMsg})`), { code: 'TELEGRAM_CONFLICT' });
          if (error) {
            conflictErr.cause = Object.assign(new Error(sanitizedMsg), { telegramCode: error.telegramCode, statusCode: error.statusCode });
          }
          throw conflictErr;
        }
        logger.error(JSON.stringify({ event: 'poll_failed', code: error.code || 'NETWORK' }));
        if (!stopping) {
          await sleepWithSignal(sleepFn, pollMs, pollController.signal);
          watchdog?.poll();
        }
      }
    }
    logger.log(JSON.stringify({ event: 'telegram_stopped' }));
  } finally {
    stop();
    clearInterval(metricsTimer);loopDelay?.disable();
    for(const job of ui?.accountCheckTasks?.values() || [])job.controller.abort();
    // Quiesce independent producers before awaiting any network drain.
    if(ui){ui.destroyed=true;ui.tickerEnabled=false;clearInterval(ui.ticker);ui.ticker=null;ui.accountRefreshJob?.controller?.abort();}
    const shutdownEndsAt = Date.now() + shutdownTimeoutMs;
    const shutdownRemaining = () => Math.max(1, shutdownEndsAt - Date.now());
    const resourceDeadline=setTimeout(()=>{ Promise.resolve().then(()=>api.close?.()).catch(()=>{}); },shutdownTimeoutMs);
    resourceDeadline.unref?.();
    stopDailyLinks?.();
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    const closeFloorMs = Number.isFinite(closeTimeoutMs) && closeTimeoutMs > 0 ? closeTimeoutMs : 2_000;
    try {
      try {
        await withBoundedTimeout(Promise.resolve().then(() => watchdog?.close()), shutdownRemaining(), 'SHUTDOWN_WATCHDOG_TIMEOUT');
      } catch (watchdogErr) {
        logStructured(logger, {
          level: 'warn',
          component: 'runner',
          event: 'shutdown_watchdog_close_failed',
          operation: 'watchdog.close',
          result: 'failed',
          errorCode: extractErrorCode(watchdogErr),
          sanitizedError: sanitizeError(watchdogErr)
        });
      }
      const schedTasks = [schedulerStopPromise, pendingScheduleTick].filter(Boolean);
      if (schedTasks.length > 0) {
        try {
          await withBoundedTimeout(Promise.allSettled(schedTasks), Math.max(shutdownRemaining(), closeFloorMs), 'SHUTDOWN_SCHEDULER_TIMEOUT');
        } catch (schedErr) {
          logStructured(logger, {
            level: 'warn',
            component: 'runner',
            event: 'shutdown_scheduler_close_failed',
            operation: 'publicationScheduler.stop',
            result: 'failed',
            errorCode: extractErrorCode(schedErr),
            sanitizedError: sanitizeError(schedErr)
          });
        }
      }
      try {
        await withBoundedTimeout(Promise.resolve().then(()=>ui?.flows?.imports?.shutdown()),shutdownRemaining(),'SHUTDOWN_IMPORTS_TIMEOUT');
        await withBoundedTimeout(Promise.allSettled([...(ui?.deliveryTasks||[])]),shutdownRemaining(),'SHUTDOWN_NAVIGATION_TIMEOUT');
        await withBoundedTimeout(Promise.resolve().then(() => ui?.destroy()), shutdownRemaining(), 'SHUTDOWN_UI_DESTROY_TIMEOUT');
      } catch (uiDestroyErr) {
        logStructured(logger, {
          level: 'warn',
          component: 'runner',
          event: 'shutdown_ui_destroy_failed',
          operation: 'ui.destroy',
          result: 'failed',
          errorCode: extractErrorCode(uiDestroyErr),
          sanitizedError: sanitizeError(uiDestroyErr)
        });
      }
      try {
        await withBoundedTimeout(Promise.resolve().then(async () => {
          await ui?.stop();
          await ui?.job;
        }), shutdownRemaining(), 'SHUTDOWN_UI_STOP_TIMEOUT');
      } catch (uiStopErr) {
        logStructured(logger, {
          level: 'warn',
          component: 'runner',
          event: 'shutdown_ui_stop_failed',
          operation: 'ui.stop',
          result: 'failed',
          errorCode: extractErrorCode(uiStopErr),
          sanitizedError: sanitizeError(uiStopErr)
        });
      }
      try {
        const exportResults = await withBoundedTimeout(Promise.allSettled([...exportTasks]), shutdownRemaining(), 'SHUTDOWN_EXPORT_TASKS_TIMEOUT');
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
      } catch (exportTimeoutErr) {
        logStructured(logger, {
          level: 'warn',
          component: 'runner',
          event: 'shutdown_export_tasks_timeout',
          operation: 'shutdown.exportTasks',
          result: 'failed',
          errorCode: extractErrorCode(exportTimeoutErr),
          sanitizedError: sanitizeError(exportTimeoutErr)
        });
      }
      try {
        const panelResults = await withBoundedTimeout(Promise.allSettled([...panelTasks, ...(ui?.panelLocks?.values() || [])]), shutdownRemaining(), 'SHUTDOWN_PANEL_TASKS_TIMEOUT');
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
      } catch (panelTimeoutErr) {
        logStructured(logger, {
          level: 'warn',
          component: 'runner',
          event: 'shutdown_panel_tasks_timeout',
          operation: 'shutdown.panelTasks',
          result: 'failed',
          errorCode: extractErrorCode(panelTimeoutErr),
          sanitizedError: sanitizeError(panelTimeoutErr)
        });
      }
      try {
        const forensicResults = await withBoundedTimeout(Promise.allSettled([...forensicTasks]), shutdownRemaining(), 'SHUTDOWN_FORENSIC_TASKS_TIMEOUT');
        for (const res of forensicResults) {
          if (res.status === 'rejected') {
            logStructured(logger, {
              level: 'warn',
              component: 'runner',
              event: 'shutdown_forensic_task_failed',
              operation: 'shutdown',
              result: 'failed',
              errorCode: extractErrorCode(res.reason),
              sanitizedError: sanitizeError(res.reason)
            });
          }
        }
      } catch (forensicTimeoutErr) {
        logStructured(logger, {
          level: 'warn',
          component: 'runner',
          event: 'shutdown_forensic_tasks_timeout',
          operation: 'shutdown.forensicTasks',
          result: 'failed',
          errorCode: extractErrorCode(forensicTimeoutErr),
          sanitizedError: sanitizeError(forensicTimeoutErr)
        });
      }
    } finally {
      clearTimeout(resourceDeadline);
      // Every final closer is bounded too; a failed transport cannot retain the
      // process singleton forever after producers and dispatch have been fenced.
      for (const [operation, close] of [
        ['pool.close', () => workerPool?.close?.({ timeoutMs: closeTimeoutMs })],
        ['api.close', () => api.close?.()], ['store.close', () => bot?.store?.close?.()], ['singleton.release', release]
      ]) {
        try { await withBoundedTimeout(Promise.resolve().then(close), Math.max(shutdownRemaining(), closeFloorMs), 'SHUTDOWN_FINAL_CLOSE_TIMEOUT'); }
        catch (error) { logger.error(JSON.stringify({ event: 'shutdown_final_close_failed', operation, code: error.code || 'UNKNOWN' })); }
      }
    }
  }
}

function createRunnerControls({ ui, workerPool, getAbortController = () => null, isStopping = () => false } = {}) {
  let startFlight = null;
  const runnerStart = async (options = {}) => {
    const {
      source = 'control',
      id,
      value,
      maxItems,
      stopAfterSuccess = true,
      occurrence,
      taskId,
      taskGeneration,
      entryStopGeneration,
      preparingGeneration,
      callbackPanel,
      panel
    } = options || {};
    if (isStopping()) return { started: false, reasons: ['المشغل في حالة إيقاف'] };
    if (startFlight) return startFlight;
    const effectiveStopGeneration = entryStopGeneration ?? (ui?.stopGeneration || 0);
    const effectivePanel = panel ?? callbackPanel;
    const flight = Promise.resolve().then(() => ui.begin(source, id, value, {
      maxItems,
      stopAfterSuccess,
      occurrence,
      taskId,
      taskGeneration,
      entryStopGeneration: effectiveStopGeneration,
      preparingGeneration,
      panel: effectivePanel
    }))
      .finally(() => { if (startFlight === flight) startFlight = null; });
    startFlight = flight;
    return flight;
  };
  const runnerStop = async () => {
    const wasPendingStart = Boolean(startFlight);
    startFlight = null;
    ui?.cancelPendingStarts?.();
    const abortController = getAbortController();
    abortController?.abort();
    workerPool?.fenceAdmission?.();
    return ui?.stop?.(undefined, undefined, undefined, { wasPendingStart });
  };
  return { runnerStart, runnerStop };
}

function isAmbiguousTelegramError(error) {
return Boolean(error?.ambiguous || ['TELEGRAM_TIMEOUT', 'TELEGRAM_INVALID_RESPONSE', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNABORTED'].includes(error?.code));
}

if (require.main === module) run().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = {
  run,
  SingleInstanceLock,
  updateId,
  isAmbiguousTelegramError,
  claimCycleItem,
  selectAccount,
  computeWeightedTweetLength,
  MAX_WEIGHTED_TWEET_CHARS,
  MAX_PRE_DISPATCH_RETRIES,
  withBoundedTimeout,
  moveItemToTailLocal,
  settleOwnerAssistedPost,
  AccountWorkerPool,
  createRunnerControls
};
