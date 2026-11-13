'use strict';

const { isClaimableInState, protectedTextKeys } = require('./queue');
const { evaluateAccountUse, isAccountInactive, isCaptchaStatus, isBannedStatus, isUnverifiedStatus } = require('./accounts');

const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' });
function riyadhDay(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now ?? Date.now());
  const validDate = isNaN(d.getTime()) ? new Date() : d;
  const parts = Object.fromEntries(dayFormatter.formatToParts(validDate).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function riyadhNow(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now ?? Date.now());
  return isNaN(d.getTime()) ? new Date() : d;
}

// Canonical account revision signature matching runner.js launchCycle / update cooling
function coolingRevision(account) {
  return JSON.stringify(['cookieFile', 'enabled', 'needsOwnerCaptcha', 'checkGeneration'].map(k => account?.[k]));
}

// Settings override per-account limits, as in the production runner. No limit
// means unlimited; malformed persisted values fail closed instead of inventing capacity.
function accountCapacity(state, account, now = new Date()) {
  const day = riyadhDay(now);
  const configured = state.settings?.dailyQuota ?? account.quota;
  const limit = configured == null ? Infinity : Number.isSafeInteger(configured) && configured > 0 ? configured : 0;
  const raw = state.posting?.quota?.[day]?.[account.id] ?? 0;
  const used = Number.isSafeInteger(raw) && raw >= 0 ? raw : Infinity;
  return { id: account.id, day, used, limit, remaining: Math.max(0, limit === Infinity && used !== Infinity ? Infinity : limit - used) || 0 };
}

function quotaMessage({ used = 0, limit = 0 } = {}) {
  return `⚠️ الكوتا اليومية للحسابات ممتلئة (${used}/${limit})، يرجى الانتظار حتى الغد الساعة 00:00 بتوقيت مكة لتصفير الكوتا تلقائياً، أو زيادة الكوتا من الإعدادات.`;
}

// Resolve capacity against pending work, not merely a spare unrelated account:
// a queue pinned entirely to an exhausted account is quota-blocked too.
function quotaAdmission(state, { accounts = state.accounts || [], items = state.items || [], now = new Date() } = {}) {
  const enabled = accounts.filter(a => a.enabled !== false &&
    !a.needsOwnerCaptcha &&
    (Number(a.failures) || 0) < 3 &&
    !isAccountInactive(a.status) &&
    !isUnverifiedStatus(a.status) &&
    !isCaptchaStatus(a.status) &&
    !isBannedStatus(a.status) &&
    !String(a.status || '').includes('معزول') &&
    !['challenge', 'locked', 'captcha', 'suspended', 'banned', 'accountFailure'].some(k => Boolean(a[k])));
  const protectedTexts = protectedTextKeys(state.items || [], state);
  const pending = items.filter(x => isClaimableInState(x, state, protectedTexts) && typeof x.payload?.text === 'string' && x.payload.text.trim());
  const relevant = enabled.filter(a => pending.some(x => !x.payload.account || x.payload.account === a.id));
  const capacities = relevant.map(a => accountCapacity(state, a, now));
  const exhausted = capacities.length > 0 && capacities.every(a => a.remaining <= 0);
  const used = capacities.reduce((sum, a) => sum + a.used, 0);
  const limit = capacities.reduce((sum, a) => sum + a.limit, 0);
  return { exhausted, day: riyadhDay(now), capacities, used, limit, reason: exhausted ? 'daily_quota_exhausted' : null, message: exhausted ? quotaMessage({ used, limit }) : null };
}

// Read-only estimate of this run's remaining Riyadh-day quota, not queue drain.
// Publishing is serial with a GLOBAL delay; account count never divides it.
function estimateCycle(state, { now = new Date(), eligible = a => a.enabled !== false } = {}) {
  const nowMs = +new Date(now), run = state.telegramUi?.run || {}, items = state.items || [];
  const ids = new Set(run.itemIds || []), runAccounts = new Set(run.accountIds || []);
  const orderedAccounts = run.accountIds || [];
  const accounts = (state.accounts || []).filter(a => runAccounts.has(a.id) && eligible(a) && (a.failures || 0) < 3);
  const initialCapacities = new Map(accounts.map(a => [a.id, accountCapacity(state, a, now).remaining]));
  const protectedTexts = protectedTextKeys(items, state), byId = new Map(items.map(item => [item.id, item]));

  const nextAt = Date.parse(state.posting?.nextPostAt || '');
  const result = { remaining: null, seconds: null, finishAt: null, bounds: null, nextAt: Number.isFinite(nextAt) ? nextAt : null, reason: null, meanDelay: null };
  const unavailable = reason => ({ ...result, reason });

  if (state.cycle?.state !== 'running' || !run.runId || run.runId !== state.cycle.runId) {
    return unavailable(state.settings?.schedule?.enabled === true && state.cycle?.state === 'stopped' ? 'scheduled_not_running' : 'not_running');
  }

  if (state.posting?.publishingAt || items.some(i => ids.has(i.id) && ['processing', 'dispatch_started', 'ambiguous'].includes(i.state))) {
    return unavailable('unresolved_publish');
  }

  let totalShared = 0;
  const pinnedMap = {};
  const simulatedTexts = new Set(protectedTexts);
  const candidates = [];
  for (const id of ids) {
    const item = byId.get(id);
    if (!item || typeof item.payload?.text !== 'string' || !item.payload.text.trim()) continue;
    const textKey = item.payload.text.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
    if (textKey && simulatedTexts.has(textKey)) continue;
    if (!(item.state === 'processing' || isClaimableInState(item, state, protectedTexts))) continue;
    if (textKey) simulatedTexts.add(textKey);
    candidates.push(item);
    if (item.payload.account) {
      pinnedMap[item.payload.account] = (pinnedMap[item.payload.account] || 0) + 1;
    } else {
      totalShared++;
    }
  }

  const C = accounts.reduce((sum, a) => sum + (initialCapacities.get(a.id) || 0), 0);
  let P = 0;
  for (const a of accounts) {
    P += Math.min(pinnedMap[a.id] || 0, initialCapacities.get(a.id) || 0);
  }
  let Rlo = Math.max(P, Math.min(totalShared, C));
  let Rhi = Math.min(C, totalShared + P);
  if (run.stopAfterSuccess) {
    Rlo = Math.min(Rlo, 1);
    Rhi = Math.min(Rhi, 1);
  }

  const retryOrderUnknown = items.some(i => ids.has(i.id) && isClaimableInState(i, state, protectedTexts) && (i.preDispatchRetries || 0) > 0);
  if (Rlo !== Rhi && retryOrderUnknown) {
    return unavailable('retry_order_unknown');
  }

  let remaining = 0, cursor = Number.isSafeInteger(run.cursor) && run.cursor >= 0 ? run.cursor : 0;
  const capacity = new Map(initialCapacities);
  for (const item of candidates) {
    let account = item.payload.account;
    if (!account) {
      for (let n = 0; n < orderedAccounts.length; n++) {
        const candidate = orderedAccounts[(cursor + n) % orderedAccounts.length];
        if ((capacity.get(candidate) || 0) > 0) {
          account = candidate;
          cursor = (orderedAccounts.indexOf(candidate) + 1) % orderedAccounts.length;
          break;
        }
      }
    }
    if ((capacity.get(account) || 0) > 0) {
      remaining++;
      capacity.set(account, capacity.get(account) - 1);
    }
  }
  if (run.stopAfterSuccess) remaining = Math.min(remaining, 1);
  if (Rlo === Rhi) remaining = Rlo;
  result.remaining = remaining;

  if (!remaining) return unavailable('no_capacity');

  if (accounts.some(a => {
    const pause = state.posting?.cooling?.[a.id];
    return Number(pause?.until) > nowMs && pause.revision === coolingRevision(a);
  })) return unavailable('external_wait');

  if (!Number.isFinite(nextAt) || nextAt < nowMs) return unavailable('unknown_next');

  const min = Number.isSafeInteger(state.settings?.delayMinSeconds) ? state.settings.delayMinSeconds : 15;
  const max = Number.isSafeInteger(state.settings?.delayMaxSeconds) ? Math.max(min, state.settings.delayMaxSeconds) : min;
  const below = Math.max(0, Math.min(max, 14) - min + 1), lo = Math.max(15, min), count = Math.max(0, max - lo + 1);
  const mean = (15 * below + (lo + max) * count / 2) / (max - min + 1);

  const Dlo = Math.max(15, min);
  const Dhi = Math.max(15, max);
  const W = Math.max(0, (nextAt - nowMs) / 1000);
  const minSeconds = Math.max(0, W) + Math.max(0, remaining - 1) * Dlo;
  const maxSeconds = Math.max(0, W) + Math.max(0, remaining - 1) * Dhi;
  const finishAtMin = nowMs + minSeconds * 1000;
  const finishAtMax = nowMs + maxSeconds * 1000;
  const bounds = { minSeconds, maxSeconds, secondsMin: minSeconds, secondsMax: maxSeconds, finishAtMin, finishAtMax };

  const seconds = Math.max(0, W) + Math.max(0, remaining - 1) * mean;
  const finishAt = nowMs + seconds * 1000;

  result.meanDelay = mean;
  result.bounds = bounds;

  if (riyadhDay(finishAt) !== riyadhDay(now) || riyadhDay(bounds.finishAtMax) !== riyadhDay(now)) {
    return unavailable('quota_day_boundary');
  }

  return { ...result, seconds, finishAt, bounds, meanDelay: mean };
}

// A bounded SQL projection supplies run-order routing blocks, not item IDs or
// payloads. Counts cannot be pooled by account: shared posts consume quota in
// cursor order before later pinned posts. Refuse incomplete/unstable order.
function estimateProjectedCycle(state, projection = {}, { now = new Date(), eligible = a => a.enabled !== false, accountReason = null } = {}) {
  const nowMs = +new Date(now), run = state.telegramUi?.run || {};
  const nextAt = Date.parse(state.posting?.nextPostAt || '');
  const result = { remaining: null, seconds: null, finishAt: null, bounds: null, nextAt: Number.isFinite(nextAt) ? nextAt : null, reason: null, meanDelay: null };
  const unavailable = reason => ({ ...result, reason });
  if (state.cycle?.state !== 'running' || !run.runId || run.runId !== state.cycle.runId) {
    return unavailable(state.settings?.schedule?.enabled === true && state.cycle?.state === 'stopped' ? 'scheduled_not_running' : 'not_running');
  }
  if (!projection.scopeKnown) return unavailable('run_scope_unknown');
  if (projection.unresolvedPublish || state.posting?.publishingAt) return unavailable('unresolved_publish');
  if (projection.duplicateOrderUnknown) return unavailable('duplicate_order_unknown');
  if (projection.invalidBinding) return unavailable('invalid_account_binding');
  if (projection.truncated) return unavailable('projection_too_large');
  if (accountReason) return unavailable(accountReason);

  const ordered = run.accountIds || [];
  const accounts = (state.accounts || []).filter(a => ordered.includes(a.id) && eligible(a) && (a.failures || 0) < 3);
  const initialCapacities = new Map(accounts.map(a => [a.id, accountCapacity(state, a, now).remaining]));

  let totalShared = 0;
  const pinnedMap = {};
  for (const block of projection.blocks || []) {
    const count = block.count;
    if (!Number.isSafeInteger(count) || count < 0) return unavailable('invalid_projection');
    if (block.account != null) {
      pinnedMap[block.account] = (pinnedMap[block.account] || 0) + count;
    } else {
      totalShared += count;
    }
  }

  const C = accounts.reduce((sum, a) => sum + (initialCapacities.get(a.id) || 0), 0);
  let P = 0;
  for (const a of accounts) {
    P += Math.min(pinnedMap[a.id] || 0, initialCapacities.get(a.id) || 0);
  }
  let Rlo = Math.max(P, Math.min(totalShared, C));
  let Rhi = Math.min(C, totalShared + P);
  if (run.stopAfterSuccess) {
    Rlo = Math.min(Rlo, 1);
    Rhi = Math.min(Rhi, 1);
  }

  const retryOrderUnknown = Boolean(projection.retryOrderUnknown);
  if (Rlo !== Rhi && retryOrderUnknown) {
    return unavailable('retry_order_unknown');
  }

  const capacity = new Map(initialCapacities);
  let remaining = 0, cursor = Number.isSafeInteger(run.cursor) && run.cursor >= 0 ? run.cursor : 0;
  const participating = new Set();
  for (const block of projection.blocks || []) {
    let count = block.count;
    if (block.account != null) {
      const available = capacity.get(block.account) || 0;
      const used = Math.min(count, available);
      if (used) participating.add(block.account);
      remaining += used;
      capacity.set(block.account, available - used);
      continue;
    }
    // Skip complete round-robin rounds arithmetically. At most one partial
    // round per account exhaustion is inspected, even for a 50k shared block.
    while (count > 0) {
      const rotation = Array.from({ length: ordered.length }, (_, n) => (cursor + n) % ordered.length)
        .filter(index => (capacity.get(ordered[index]) || 0) > 0);
      if (!rotation.length) break;
      const rounds = Math.min(Math.floor(count / rotation.length), ...rotation.map(index => capacity.get(ordered[index])));
      if (rounds > 0) {
        for (const index of rotation) {
          const id = ordered[index];
          participating.add(id);
          capacity.set(id, capacity.get(id) - rounds);
        }
        const used = rounds * rotation.length;
        remaining += used;
        count -= used;
        cursor = (rotation[rotation.length - 1] + 1) % ordered.length;
      } else {
        const index = rotation[0], id = ordered[index];
        participating.add(id);
        capacity.set(id, capacity.get(id) - 1);
        remaining++;
        count--;
        cursor = (index + 1) % ordered.length;
      }
    }
  }
  if (run.stopAfterSuccess) remaining = Math.min(remaining, 1);
  if (Rlo === Rhi) remaining = Rlo;
  result.remaining = remaining;

  if (!remaining) return unavailable(projection.candidateCount ? 'no_capacity' : 'no_remaining');

  if (accounts.some(account => {
    if (!participating.has(account.id)) return false;
    const pause = state.posting?.cooling?.[account.id];
    return Number(pause?.until) > nowMs && pause.revision === coolingRevision(account);
  })) return unavailable('external_wait');

  if (!Number.isFinite(nextAt) || nextAt < nowMs) return unavailable('unknown_next');

  const min = Number.isSafeInteger(state.settings?.delayMinSeconds) ? state.settings.delayMinSeconds : 15;
  const max = Number.isSafeInteger(state.settings?.delayMaxSeconds) ? Math.max(min, state.settings.delayMaxSeconds) : min;
  const below = Math.max(0, Math.min(max, 14) - min + 1), lo = Math.max(15, min), count = Math.max(0, max - lo + 1);
  const mean = (15 * below + (lo + max) * count / 2) / (max - min + 1);

  const Dlo = Math.max(15, min);
  const Dhi = Math.max(15, max);
  const W = Math.max(0, (nextAt - nowMs) / 1000);
  const minSeconds = Math.max(0, W) + Math.max(0, remaining - 1) * Dlo;
  const maxSeconds = Math.max(0, W) + Math.max(0, remaining - 1) * Dhi;
  const finishAtMin = nowMs + minSeconds * 1000;
  const finishAtMax = nowMs + maxSeconds * 1000;
  const bounds = { minSeconds, maxSeconds, secondsMin: minSeconds, secondsMax: maxSeconds, finishAtMin, finishAtMax };

  const seconds = Math.max(0, W) + Math.max(0, remaining - 1) * mean;
  const finishAt = nowMs + seconds * 1000;

  result.meanDelay = mean;
  result.bounds = bounds;

  // Only the current Riyadh-day budget is known. A daily schedule is a new
  // admission decision, not authority to extrapolate tomorrow's run/quota.
  if (riyadhDay(finishAt) !== riyadhDay(now) || riyadhDay(bounds.finishAtMax) !== riyadhDay(now)) {
    return unavailable('quota_day_boundary');
  }

  return { ...result, seconds, finishAt, bounds, meanDelay: mean };
}

module.exports = {
  riyadhDay,
  riyadhNow,
  coolingRevision,
  accountCapacity,
  evaluateAccountUse,
  quotaAdmission,
  quotaMessage,
  estimateCycle,
  estimateProjectedCycle
};
