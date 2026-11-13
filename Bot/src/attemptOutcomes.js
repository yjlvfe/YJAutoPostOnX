'use strict';

// Load quota lazily: queue -> attemptOutcomes -> quota -> queue is a
// legitimate startup path, and eager imports expose quota's partial exports.
function riyadhDay(...args) {
  return require('./quota').riyadhDay(...args);
}

// Counts outcomes only when the owning claim actually transitions in the
// durable SQLite state. "ambiguous" never implies that X rejected the post.
const RETAIN_DAYS = 14;

function recordRunAttemptOutcome(state, { runId, accountId, itemId, attemptToken, outcome, at = new Date(), preDispatchRetry = false } = {}) {
  const normalizedOutcome = outcome === 'published' ? 'succeeded' : outcome;
  if (!state || typeof state !== 'object' || !accountId || !['succeeded', 'failed', 'ambiguous'].includes(normalizedOutcome)) {
    return false;
  }
  const run = state.telegramUi?.run;
  if (!run || typeof run !== 'object' || typeof run.runId !== 'string' || !run.runId) {
    return false;
  }
  const targetRunId = runId || run.runId;
  if (targetRunId !== run.runId) {
    return false;
  }
  if (!runId && state.cycle?.runId && state.cycle.runId !== run.runId) {
    return false;
  }
  run.attemptLedger = Array.isArray(run.attemptLedger) ? run.attemptLedger : [];
  let resolvedItemId = itemId || null;
  let resolvedToken = attemptToken || null;
  if ((!resolvedToken || !resolvedItemId) && Array.isArray(state.items)) {
    for (const item of state.items) {
      if (!item || (resolvedItemId && item.id !== resolvedItemId)) continue;
      if (item.attempt && item.attempt.accountId === accountId && (!item.attempt.runId || item.attempt.runId === run.runId)) {
        if (!resolvedItemId && item.id) resolvedItemId = item.id;
        if (!resolvedToken && item.attempt.token) resolvedToken = item.attempt.token;
        break;
      }
    }
    if (!resolvedToken) {
      for (const item of state.items) {
        if (!item || (resolvedItemId && item.id !== resolvedItemId)) continue;
        const attempts = Array.isArray(item.archivedAttempts)
          ? item.archivedAttempts
          : (item.archivedAttempt ? [item.archivedAttempt] : []);
        for (let idx = attempts.length - 1; idx >= 0; idx--) {
          const att = attempts[idx];
          if (att && att.runId === run.runId && (att.accountId || item.accountId) === accountId && att.token) {
            if (!run.attemptLedger.some(e => e && e.attemptToken === att.token)) {
              if (!resolvedItemId && item.id) resolvedItemId = item.id;
              resolvedToken = att.token;
              // A token inferred from an archived retry keeps its original
              // classification; callers must not turn it into a terminal failure.
              if (normalizedOutcome === 'failed' && att.preDispatchRetry === true && att.phase === 'claimed' &&
                (!att.outcomeState || att.outcomeState === 'failed')) preDispatchRetry = true;
              break;
            }
          }
        }
        if (resolvedToken) break;
      }
    }
  }
  if (resolvedToken && run.attemptLedger.some(entry => entry && entry.attemptToken === resolvedToken)) {
    return false;
  }
  const atDate = at instanceof Date ? at : new Date(at ?? Date.now());
  const atIso = Number.isFinite(atDate.getTime()) ? atDate.toISOString() : new Date().toISOString();
  const entry = {
    runId: run.runId,
    accountId,
    outcome: normalizedOutcome,
    at: atIso
  };
  if (preDispatchRetry === true && normalizedOutcome === 'failed') entry.preDispatchRetry = true;
  if (resolvedItemId != null) entry.itemId = resolvedItemId;
  if (resolvedToken != null) entry.attemptToken = resolvedToken;
  run.attemptLedger.push(entry);
  return true;
}

function recordUnsuccessfulAttempt(state, { accountId, outcome, at = new Date(), runId, itemId, attemptToken, preDispatchRetry = false } = {}) {
  if (!accountId || !['failed', 'ambiguous'].includes(outcome)) return false;
  // A receipt token represents one owning attempt, even if a caller retries
  // recording the same durable transition. Check before mutating daily totals.
  let effectiveToken = attemptToken;
  if (!effectiveToken && itemId && Array.isArray(state?.items)) {
    const item = state.items.find(i => i?.id === itemId);
    effectiveToken = item?.attempt?.token || item?.archivedAttempt?.token;
  }
  if (effectiveToken) {
    const ledger = state.telegramUi?.run?.attemptLedger;
    if (Array.isArray(ledger) && ledger.some(entry => entry && entry.attemptToken === effectiveToken)) return false;
  }
  state.posting ||= {};
  const byDay = state.posting.attemptOutcomes ||= {};
  const day = riyadhDay(at);
  const dayStats = byDay[day] ||= {};
  const counters = dayStats[accountId] ||= { failed: 0, ambiguous: 0 };
  counters[outcome] = (Number.isSafeInteger(counters[outcome]) && counters[outcome] >= 0 ? counters[outcome] : 0) + 1;
  // Keep the durable state bounded. ISO date strings sort chronologically.
  const oldDays = Object.keys(byDay).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  for (const oldDay of oldDays.slice(0, Math.max(0, oldDays.length - RETAIN_DAYS))) delete byDay[oldDay];
  recordRunAttemptOutcome(state, { runId, accountId, itemId, attemptToken: effectiveToken || attemptToken, outcome, at, preDispatchRetry });
  return true;
}

function getUnsuccessfulAttempts(state, accountId, at = new Date()) {
  const counters = state?.posting?.attemptOutcomes?.[riyadhDay(at)]?.[accountId] || {};
  const failed = Number.isSafeInteger(counters.failed) && counters.failed > 0 ? counters.failed : 0;
  const ambiguous = Number.isSafeInteger(counters.ambiguous) && counters.ambiguous > 0 ? counters.ambiguous : 0;
  return { failed, ambiguous, total: failed + ambiguous };
}

module.exports = { recordUnsuccessfulAttempt, recordRunAttemptOutcome, getUnsuccessfulAttempts };
