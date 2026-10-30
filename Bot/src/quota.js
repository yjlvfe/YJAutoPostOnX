'use strict';

const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' });
function riyadhDay(now = new Date()) {
  const parts = Object.fromEntries(dayFormatter.formatToParts(new Date(now)).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
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
  const enabled = accounts.filter(a => a.enabled !== false);
  const pending = items.filter(x => x.state === 'pending' && typeof x.payload?.text === 'string' && x.payload.text.trim());
  const relevant = enabled.filter(a => pending.some(x => !x.payload.account || x.payload.account === a.id));
  const capacities = relevant.map(a => accountCapacity(state, a, now));
  const exhausted = capacities.length > 0 && capacities.every(a => a.remaining <= 0);
  const used = capacities.reduce((sum, a) => sum + a.used, 0);
  const limit = capacities.reduce((sum, a) => sum + a.limit, 0);
  return { exhausted, day: riyadhDay(now), capacities, used, limit, reason: exhausted ? 'daily_quota_exhausted' : null, message: exhausted ? quotaMessage({ used, limit }) : null };
}

module.exports = { riyadhDay, accountCapacity, quotaAdmission, quotaMessage };
