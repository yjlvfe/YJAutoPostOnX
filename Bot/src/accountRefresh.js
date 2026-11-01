'use strict';
const { setTimeout: delay } = require('node:timers/promises');
const { isPublicIp } = require('./publicIp');
const revisionKeys = ['checkGeneration', 'cookieFile', 'enabled', 'username', 'userId'];
const sameRevision = (a, b) => a && b && revisionKeys.every(k => a[k] === b[k]);
const confirmed = result => result?.isolated === true && result.vpnHealthy === true && isPublicIp(result.exitIp || result.ip) &&
  (result.authenticated === true || ['banned', 'captcha', 'auth'].includes(result.accountFailure));

// Only unfinished/changed generations enter the network. Panel I/O never gates
// admission or durable results; the UI's single delivery owner drains at shutdown.
function createAccountRefresh(ui, { retryMs = 2000 } = {}) {
  const controller = new AbortController();
  const job = { controller, pending: new Set(), task: null };
  const active = new Map(), completed = new Map();
  let renderTask, dirty = false;
  const render = () => {
    if (controller.signal.aborted) return;
    dirty = true;
    if (renderTask) return;
    renderTask = (async () => { while (dirty && !controller.signal.aborted) { dirty = false; await ui.refreshPanels(true).catch(() => {}); } })().finally(() => { renderTask = null; });
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
  const lane = async id => {
    let failures = 0;
    while (!controller.signal.aborted) {
      try {
        const state = await ui.bot.store.load();
        const account = state.accounts?.find(a => a.id === id);
        if (!account) { job.pending.delete(id); render(); return; }
        // Pre-network barrier check: ensure no active in-flight claim before network call
        const busy = (state.items || []).some(i => ['processing', 'dispatch_started'].includes(i.state) && (i.attempt?.accountId === id || i.accountId === id));
        if (busy) {
          await delay(retryMs, undefined, { signal: controller.signal }).catch(() => {});
          continue;
        }
        // The verifier owns timeout, abort and cleanup. Do not race away its join.
        const result = await ui.isolatedVerifier.verify(account, { persistResult: false, signal: controller.signal });
        if (!confirmed(result)) throw Object.assign(new Error('Unconfirmed account observation'), { retryAfterMs: result?.readDiagnostic?.httpStatus === 429 ? Math.min(900000, Math.max(60000, (result.readDiagnostic.retryAfterSeconds || 60) * 1000)) : 0 });
        if (controller.signal.aborted) return;
        let committed;
        const applied = await ui.recordAccountCheck(id, result, { session: true, expectedAccount: account,
          refresh: true, signal: controller.signal, onApplied: value => { committed = value; } });
        if (applied === false) throw new Error('Observation deferred or superseded');
        // Production writer captures this revision inside the same transaction.
        completed.set(id, committed || account);
        job.pending.delete(id); render(); return;
      } catch (error) {
        if (controller.signal.aborted) return;
        failures++;
        await delay(Math.max(error.retryAfterMs || 0, Math.min(30000, retryMs * 2 ** Math.min(failures - 1, 4))), undefined, { signal: controller.signal }).catch(() => {});
      }
    }
  };
  job.run = async () => {
    try {
      while (!controller.signal.aborted) {
        try {
          const accounts = await ui.bot.accounts.list();
          if (controller.signal.aborted) break;
          const ids = new Set(accounts.map(a => a.id));
          for (const id of job.pending) if (!ids.has(id)) job.pending.delete(id);
          for (const account of accounts) {
            if (active.has(account.id) || sameRevision(completed.get(account.id), account)) continue;
            job.pending.add(account.id);
            const work = lane(account.id).finally(() => { active.delete(account.id); job.nudge(); });
            active.set(account.id, work);
          }
          render();
          if (!active.size && !job.pending.size) break;
        } catch { /* A failed snapshot must not turn a refresh into success. */ }
        await pause();
      }
    } finally {
      await Promise.allSettled([...active.values()]);
      if (ui.accountRefreshJob === job) ui.accountRefreshJob = null;
      render();
    }
  };
  return job;
}
module.exports = { createAccountRefresh };
