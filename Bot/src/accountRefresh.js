'use strict';
const { setTimeout: delay } = require('node:timers/promises');
const { isPublicIp } = require('./publicIp');
const { isBannedStatus, isCaptchaStatus } = require('./accounts');
const { logStructured, sanitizeError, extractErrorCode } = require('./structuredLogger');
const revisionKeys = ['checkGeneration', 'cookieFile', 'enabled', 'username', 'userId'];
const sameRevision = (a, b) => a && b && revisionKeys.every(k => a[k] === b[k]);
// Bulk refresh is not an owner reactivation or CAPTCHA-resolution workflow.
// Unverified credentials remain checkable: a read may establish real evidence.
const RESTRICTED_STATUSES = new Set([
  'غير مفعل', 'غير نشط', 'disabled', 'inactive',
  'isolated', 'معزول', 'معزول (3 إخفاقات)',
  'locked', 'مقفل', 'مغلق', 'suspended', 'banned', 'محظور', 'كابتشا'
]);
const isRestrictedStatus = status => {
  if (!status || typeof status !== 'string') return false;
  const s = status.trim(), lower = s.toLowerCase();
  return RESTRICTED_STATUSES.has(s) || RESTRICTED_STATUSES.has(lower) ||
    isBannedStatus(s) || isCaptchaStatus(s) ||
    lower.includes('locked') || lower.includes('isolated') || s.includes('معزول');
};
const included = account => Boolean(account && account.enabled !== false && account.cookieFile &&
  !isRestrictedStatus(account.status) &&
  !['needsOwnerCaptcha', 'challenge', 'locked', 'captcha', 'suspended', 'banned', 'accountFailure', 'isolated'].some(key => Boolean(account[key])));
const confirmed = result => Boolean(
  result &&
  result.isolated === true &&
  result.vpnHealthy === true &&
  isPublicIp(result.exitIp || result.ip) &&
  (
    result.authenticated === true ||
    result.authenticated === false ||
    result.accountFailure != null ||
    result.readDiagnostic != null ||
    result.state != null
  )
);
const sessionContention = error => ['DUPLICATE_SESSION_LEASE', 'MAX_PROJECT_SESSIONS_EXCEEDED', 'SESSION_REGISTRY_BUSY'].includes(error?.code);

// ready is target admission only, never proof of a successful account check.
// Session leases remain owned by the verifier/directX shared session guard.
function createAccountRefresh(ui, { retryMs = 2000, maxFailures = 2, timeoutMs = 60000, readyTimeoutMs = 1000, preSeededIds = null } = {}) {
  const controller = new AbortController();
  const job = { controller, pending: new Set(preSeededIds || []), task: null, status: 'pending' };
  const active = new Map(), completed = new Map();
  let runTask, readyTimer, readySettled = false, resolveReady, timedOut = false;
  job.ready = new Promise(resolve => { resolveReady = resolve; });
  const settleReady = value => {
    if (readySettled) return;
    readySettled = true;
    clearTimeout(readyTimer);
    resolveReady(value);
  };
  controller.signal.addEventListener('abort', () => settleReady(false), { once: true });
  readyTimer = setTimeout(() => settleReady(false), Math.min(readyTimeoutMs, timeoutMs));
  readyTimer.unref?.();
  const overallTimeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  overallTimeout.unref?.();
  const report = (event, operation, error, accountId) => logStructured(ui?.bot?.logger || null, {
    level: 'warn', component: 'account_refresh', event, operation, accountId, result: 'failed',
    errorCode: extractErrorCode(error), sanitizedError: sanitizeError(error)
  });
  let renderTask, dirty = false;
  const render = () => {
    if (ui.destroyed) return;
    dirty = true;
    if (renderTask) return;
    renderTask = (async () => {
      while (dirty && !ui.destroyed) {
        dirty = false;
        try {
          if (ui.fastNavigation?.dirty) await ui.fastNavigation.refresh()?.catch(() => {});
          await ui.refreshPanels(true);
        }
        catch (err) { report('account_refresh_panel_failed', 'refreshPanels', err); }
      }
    })().finally(() => { renderTask = null; });
  };
  let wake;
  job.nudge = () => wake?.();
  const pause = async () => {
    const timer = new AbortController();
    const abort = () => timer.abort();
    controller.signal.addEventListener('abort', abort, { once: true });
    wake = abort;
    try { if (!controller.signal.aborted) await delay(retryMs, undefined, { signal: timer.signal }).catch(() => {}); }
    finally { wake = null; controller.signal.removeEventListener('abort', abort); }
  };
  const waitRetry = async ms => {
    if (!controller.signal.aborted) await delay(ms, undefined, { signal: controller.signal }).catch(() => {});
  };
  const accountsSnapshot = () => ui.bot.store.section ? ui.bot.store.section('accounts') : ui.bot.accounts.list();
  const laneSnapshot = async () => ui.bot.store.section ? {
    accounts: await ui.bot.store.section('accounts'), cycle: await ui.bot.store.section('cycle')
  } : ui.bot.store.load();
  const busyPosting = async (state, id) => {
    if (state.cycle?.state !== 'running') return false;
    if (typeof ui.bot.store.hasInFlightPostForAccount === 'function') return ui.bot.store.hasInFlightPostForAccount(id);
    const full = await ui.bot.store.load();
    return (full.items || []).some(i => ['processing', 'dispatch_started'].includes(i.state) && (i.attempt?.accountId === id || i.accountId === id));
  };
  const persist = async (id, account, result, options) => {
    for (let attempt = 0; !controller.signal.aborted; attempt++) {
      // Fence before the writer as well as inside its transaction/CAS. This also
      // protects restrictions from a disabled/deleted/replaced account revision.
      const latest = (await accountsSnapshot()).find(a => a.id === id);
      if (!included(latest) || !sameRevision(account, latest)) return false;
      let committed;
      try {
        const applied = await ui.recordAccountCheck(id, result, {
          ...options, expectedAccount: account, refresh: true, signal: controller.signal,
          onApplied: value => { committed = value; }
        });
        if (controller.signal.aborted) return false;
        if (applied === false) {
          job.pending.delete(id);
          render();
          return false;
        }
        completed.set(id, committed ? { ...account, ...committed } : account);
        job.pending.delete(id);
        render();
        return true;
      } catch (error) {
        if (controller.signal.aborted) return false;
        report('account_refresh_check_persist_failed', 'recordAccountCheck', error, id);
        // Reuse the same observation; a database error is never network/auth
        // evidence and never sends another verifier session or fake failure.
        if (attempt + 1 >= maxFailures) throw Object.assign(new Error('Account check persistence failed'), { code: 'ACCOUNT_CHECK_PERSIST_FAILED' });
        await waitRetry(retryMs);
      }
    }
    return false;
  };
  const lane = async id => {
    let failures = 0, captured;
    while (!controller.signal.aborted) {
      // Store failures intentionally live outside the verifier-error handler.
      const state = await laneSnapshot();
      const account = state.accounts?.find(a => a.id === id);
      if (!included(account)) { job.pending.delete(id); render(); return; }
      if (captured && !sameRevision(captured, account)) failures = 0;
      captured = account;
      if (await busyPosting(state, id)) { await waitRetry(retryMs); continue; }
      if (controller.signal.aborted) return;
      let result;
      const observationOrder = ui.beginAccountObservation?.();
      try {
        // The verifier owns the shared lease, abort, timeout and cleanup join.
        result = await ui.isolatedVerifier.verify(account, { persistResult: false, signal: controller.signal });
        if (!confirmed(result)) throw Object.assign(new Error('Unconfirmed account observation'), {
          retryAfterMs: result?.readDiagnostic?.httpStatus === 429 ? Math.min(900000, Math.max(60000, (result.readDiagnostic.retryAfterSeconds || 60) * 1000)) : 0
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error?.code === 'ACCOUNT_CHECK_PERSIST_FAILED') throw error;
        // A busy shared lease is admission pressure, not a failed observation.
        if (sessionContention(error)) { await waitRetry(retryMs); continue; }
        failures++;
        if (failures < maxFailures) {
          await waitRetry(Math.max(error.retryAfterMs || 0, Math.min(30000, retryMs * 2 ** Math.min(failures - 1, 4))));
          continue;
        }
        await persist(id, account, {
          isolated: false, vpnHealthy: false, transientError: true,
          lastError: sanitizeError(error), observationOrder
        }, { session: false, source: 'vpn-health' });
        return;
      }
      if (controller.signal.aborted) return;
      result = { ...result };
      if (!Number.isFinite(result.observationOrder) && Number.isFinite(observationOrder)) result.observationOrder = observationOrder;
      await persist(id, account, result, { session: true });
      return;
    }
  };
  const execute = async () => {
    job.status = 'running';
    try {
      while (!controller.signal.aborted) {
        try {
          const accounts = await accountsSnapshot();
          if (controller.signal.aborted) break;
          const targets = accounts.filter(included);
          const ids = new Set(targets.map(a => a.id));
          for (const id of job.pending) if (!ids.has(id)) job.pending.delete(id);
          for (const account of targets) if (!sameRevision(completed.get(account.id), account)) job.pending.add(account.id);
          // Complete target-set admission precedes all network admission/results.
          settleReady(true);
          for (const account of targets) {
            if (active.size >= 5) break;
            if (active.has(account.id) || sameRevision(completed.get(account.id), account)) continue;
            const work = lane(account.id).catch(error => {
              job.error ||= error;
              controller.abort();
            }).finally(() => { active.delete(account.id); job.nudge(); });
            active.set(account.id, work);
          }
          render();
          if (!active.size && !job.pending.size) break;
        } catch (error) {
          settleReady(false);
          report('account_refresh_snapshot_failed', 'accounts.list', error);
        }
        await pause();
      }
    } finally {
      clearTimeout(overallTimeout);
      settleReady(false);
      await Promise.allSettled([...active.values()]);
      job.status = job.error ? 'failed' : timedOut ? 'timed_out' : controller.signal.aborted ? 'cancelled' : 'completed';
      job.pending.clear();
      if (ui.accountRefreshJob === job) ui.accountRefreshJob = null;
      render();
    }
    if (job.error) throw job.error;
  };
  job.run = () => {
    if (!runTask) { runTask = execute(); job.task = runTask; }
    return runTask;
  };
  job.cancel = () => { controller.abort(); return job.run(); };
  return job;
}
module.exports = { createAccountRefresh, confirmed };
