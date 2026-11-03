'use strict';

const { riyadhDay } = require('./quota');

// Counts outcomes only when the owning claim actually transitions in the
// durable SQLite state. "ambiguous" never implies that X rejected the post.
const RETAIN_DAYS = 14;
function recordUnsuccessfulAttempt(state, { accountId, outcome, at = new Date() } = {}) {
  if (!accountId || !['failed', 'ambiguous'].includes(outcome)) return false;
  state.posting ||= {};
  const byDay = state.posting.attemptOutcomes ||= {};
  const day = riyadhDay(at);
  const dayStats = byDay[day] ||= {};
  const counters = dayStats[accountId] ||= { failed: 0, ambiguous: 0 };
  counters[outcome] = (Number.isSafeInteger(counters[outcome]) && counters[outcome] >= 0 ? counters[outcome] : 0) + 1;
  // Keep the durable state bounded. ISO date strings sort chronologically.
  const oldDays = Object.keys(byDay).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  for (const oldDay of oldDays.slice(0, Math.max(0, oldDays.length - RETAIN_DAYS))) delete byDay[oldDay];
  return true;
}

function getUnsuccessfulAttempts(state, accountId, at = new Date()) {
  const counters = state?.posting?.attemptOutcomes?.[riyadhDay(at)]?.[accountId] || {};
  const failed = Number.isSafeInteger(counters.failed) && counters.failed > 0 ? counters.failed : 0;
  const ambiguous = Number.isSafeInteger(counters.ambiguous) && counters.ambiguous > 0 ? counters.ambiguous : 0;
  return { failed, ambiguous, total: failed + ambiguous };
}

module.exports = { recordUnsuccessfulAttempt, getUnsuccessfulAttempts };
