'use strict';

const { isPublicIp } = require('./publicIp');
const { accountCapacity } = require('./quota');
const { escapeHtml, clean, richTable, preTable } = require('./tableUtils');

function accountStatus(account) {
  const status = String(account.status || '').trim();
  if (status === 'محظور' || ['suspended', 'banned'].includes(status.toLowerCase())) return 'محظور';
  if (status === 'كابتشا' || status.startsWith('كابتشا') || status.toLowerCase() === 'captcha' || account.needsOwnerCaptcha === true) return 'كابتشا';
  return account.enabled === false ? 'غير مفعل' : 'مفعل';
}

function getVisibleAccounts(state, { all = false } = {}) {
  const allAccounts = state?.accounts || [];
  return all ? allAccounts : allAccounts.filter(a => {
    const status = String(a.status || '').trim();
    const isBanned = status === 'محظور' || ['suspended', 'banned'].includes(status.toLowerCase());
    if (isBanned) return true;
    const isCaptcha = status === 'كابتشا' || status.startsWith('كابتشا') || status.toLowerCase() === 'captcha' || a.needsOwnerCaptcha === true;
    if (isCaptcha) return true;
    const isInactive = status === 'غير مفعل' || status === 'غير نشط' || status === 'خامل' || ['disabled', 'inactive'].includes(status.toLowerCase()) || a.enabled === false;
    if (isInactive) return false;
    return status === 'مفعل' || a.enabled !== false;
  });
}

function getCurrentRunStats(state) {
  const run = state?.telegramUi?.run;
  const result = new Map();
  if (!run?.runId) return result;
  const addStat = (accountId, bucket) => {
    if (!accountId || !['succeeded', 'failed', 'ambiguous'].includes(bucket)) return;
    const stats = result.get(accountId) || { succeeded: 0, failed: 0, ambiguous: 0 };
    stats[bucket]++;
    result.set(accountId, stats);
  };
  const seenTokens = new Set();
  const itemsWithRunAttempts = new Set();
  const itemsWithTerminalRunAttempt = new Set();
  const unmatchedTokenlessLedger = new Map();
  const retryTokens = new Set();
  const retryItems = new Set();
  // Register exclusions before counting either source. A marked receipt must
  // suppress its unmarked mirror too, without suppressing a later terminal attempt.
  const excludeRetry = (itemId, token) => {
    if (itemId != null) retryItems.add(itemId);
    if (token) retryTokens.add(token);
  };
  for (const entry of Array.isArray(run.attemptLedger) ? run.attemptLedger : []) {
    if (entry && (!entry.runId || entry.runId === run.runId) && entry.preDispatchRetry === true && entry.outcome === 'failed') {
      excludeRetry(entry.itemId, entry.attemptToken);
    }
  }
  for (const item of state?.items || []) {
    const attempts = Array.isArray(item?.archivedAttempts) ? item.archivedAttempts : (item?.archivedAttempt ? [item.archivedAttempt] : []);
    for (const attempt of attempts) {
      if (attempt?.runId === run.runId && attempt.preDispatchRetry === true && attempt.phase === 'claimed' &&
        (!attempt.outcomeState || attempt.outcomeState === 'failed')) excludeRetry(item.id, attempt.token);
    }
  }

  for (const entry of Array.isArray(run.attemptLedger) ? run.attemptLedger : []) {
    if (!entry || (entry.runId && entry.runId !== run.runId)) continue;
    if ((entry.preDispatchRetry === true && entry.outcome === 'failed') || retryTokens.has(entry.attemptToken)) {
      excludeRetry(entry.itemId, entry.attemptToken);
      continue;
    }
    const bucket = entry.outcome === 'published' ? 'succeeded' : entry.outcome;
    if (!['succeeded', 'failed', 'ambiguous'].includes(bucket) || !entry.accountId) continue;
    if (entry.attemptToken) {
      if (seenTokens.has(entry.attemptToken)) continue;
      seenTokens.add(entry.attemptToken);
    } else {
      const key = `${entry.itemId || ''}:${entry.accountId}:${bucket}`;
      unmatchedTokenlessLedger.set(key, (unmatchedTokenlessLedger.get(key) || 0) + 1);
    }
    if (entry.itemId) {
      itemsWithRunAttempts.add(entry.itemId);
      if (bucket === 'succeeded' || bucket === 'ambiguous') {
        itemsWithTerminalRunAttempt.add(entry.itemId);
      }
    }
    addStat(entry.accountId, bucket);
  }

  for (const item of state?.items || []) {
    if (!item) continue;
    const attempts = Array.isArray(item.archivedAttempts)
      ? item.archivedAttempts
      : (item.archivedAttempt ? [item.archivedAttempt] : []);
    for (const attempt of attempts) {
      if (!attempt || attempt.runId !== run.runId) continue;
      if (retryTokens.has(attempt.token) || (attempt.preDispatchRetry === true && attempt.phase === 'claimed' &&
        (!attempt.outcomeState || attempt.outcomeState === 'failed'))) {
        excludeRetry(item.id, attempt.token);
        continue;
      }
      let bucket = null;
      if (attempt.outcomeState === 'published' || attempt.outcomeState === 'succeeded') {
        bucket = 'succeeded';
      } else if (attempt.outcomeState === 'ambiguous') {
        bucket = 'ambiguous';
      } else if (attempt.outcomeState === 'failed') {
        bucket = 'failed';
      } else if (attempt.phase === 'dispatching' && (attempt.failedAt || attempt.failure || attempt.errorCode)) {
        bucket = 'ambiguous';
      } else if (attempt.failedAt || attempt.failure || attempt.errorCode) {
        bucket = 'failed';
      } else {
        continue;
      }
      const accountId = attempt.accountId || item.accountId;
      if (!accountId) continue;
      if (attempt.token) {
        if (seenTokens.has(attempt.token)) {
          if (item.id != null) {
            itemsWithRunAttempts.add(item.id);
            if (bucket === 'succeeded' || bucket === 'ambiguous') {
              itemsWithTerminalRunAttempt.add(item.id);
            }
          }
          continue;
        }
        seenTokens.add(attempt.token);
      } else {
        const key = `${item.id || ''}:${accountId}:${bucket}`;
        const prev = unmatchedTokenlessLedger.get(key) || 0;
        if (prev > 0) {
          unmatchedTokenlessLedger.set(key, prev - 1);
          if (item.id != null) {
            itemsWithRunAttempts.add(item.id);
            if (bucket === 'succeeded' || bucket === 'ambiguous') {
              itemsWithTerminalRunAttempt.add(item.id);
            }
          }
          continue;
        }
      }
      if (item.id != null) {
        itemsWithRunAttempts.add(item.id);
        if (bucket === 'succeeded' || bucket === 'ambiguous') {
          itemsWithTerminalRunAttempt.add(item.id);
        }
      }
      addStat(accountId, bucket);
    }
  }

  const ids = new Set(Array.isArray(run.itemIds) ? run.itemIds : []);
  const seenItems = new Set();
  for (const item of state?.items || []) {
    if (!item || !ids.has(item.id) || seenItems.has(item.id)) continue;
    seenItems.add(item.id);
    const hasPriorRunAttempt = itemsWithRunAttempts.has(item.id);
    if (hasPriorRunAttempt && (itemsWithTerminalRunAttempt.has(item.id) || !['published', 'ambiguous'].includes(item.state))) {
      continue;
    }
    if (!hasPriorRunAttempt && item.archivedAttempt?.runId && item.archivedAttempt.runId !== run.runId) continue;
    if (Array.isArray(item.archivedAttempts) && item.archivedAttempts.length > 0 && item.archivedAttempts.every(a => a?.runId && a.runId !== run.runId)) continue;
    if (run.startedAt && item.publishedAt && Date.parse(item.publishedAt) < Date.parse(run.startedAt)) continue;
    const contentRejected = item.state === 'cancelled' && (
      item.archivedAttempt?.failure === 'content_rejected' ||
      ['tweet_text_too_long', 'text_too_long', 'tweet_too_long', 'rejected_length_exceeded'].includes(item.reason)
    );
    if (retryItems.has(item.id) && !contentRejected && !['published', 'ambiguous'].includes(item.state)) continue;
    const bucket = contentRejected ? 'failed' : { published: 'succeeded', failed: 'failed', ambiguous: 'ambiguous' }[item.state];
    if (!bucket) continue;
    const accountId = hasPriorRunAttempt
      ? (item.accountId || item.payload?.account)
      : (item.accountId || item.archivedAttempt?.accountId || item.payload?.account);
    if (!accountId) continue;
    addStat(accountId, bucket);
  }
  return result;
}

// Current-run totals across all accounts. The internal 'ambiguous' bucket is
// intentionally NOT part of the displayed totals.
function getCurrentRunTotals(state) {
  const totals = { succeeded: 0, failed: 0 };
  for (const stats of getCurrentRunStats(state).values()) { totals.succeeded += stats.succeeded; totals.failed += stats.failed; }
  return totals;
}

function getAccountExitIp(account, state = {}) {
  // Only an observed route bound to this account's current explicit slot is
  // evidence. Legacy IP fields, host IPs and list order cannot prove a route.
  if (!account || account.enabled === false || accountStatus(account) === 'غير مفعل') return '-';
  if (!Object.hasOwn(state.vpnSlots || {}, account.id)) return '-';
  const slot = state.vpnSlots[account.id];
  const observation = state.telegramUi?.accountChecks?.[account.id]?.vpn;
  if (!Number.isInteger(slot) || slot < 0 || slot >= 5 || observation?.slot !== slot) return '-';
  if (observation.checkGeneration !== account.checkGeneration) return '-';
  if (observation.healthy !== true || observation.isolated !== true || !isPublicIp(observation.ip)) return '-';
  return observation.ip;
}

// Presentation only: a past successful observation is not a live route check.
// Keep getAccountExitIp strict for callers making current-route decisions.
function getAccountIpDisplay(account, state = {}, { now = new Date() } = {}) {
  if (!account || !account.id) return '-';
  if (!Object.hasOwn(state?.vpnSlots || {}, account.id)) return '-';
  const slot = state.vpnSlots[account.id];
  if (!Number.isInteger(slot) || slot < 0 || slot >= 5) return '-';
  if (!account.checkGeneration || typeof account.checkGeneration !== 'string') return '-';
  const vpn = state.telegramUi?.accountChecks?.[account.id]?.vpn;
  if (!vpn) return '-';
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs)) return '-';

  const candidates = [vpn.lastSuccess, vpn].filter(observation => {
    if (!observation) return false;
    if (observation.slot !== slot) return false;
    if (observation.checkGeneration !== account.checkGeneration) return false;
    if (observation.healthy !== true || observation.isolated !== true || !isPublicIp(observation.ip)) return false;
    if (typeof observation.checkedAt !== 'string' || !observation.checkedAt.trim()) return false;
    const checkedMs = Date.parse(observation.checkedAt);
    return Number.isFinite(checkedMs) && checkedMs <= nowMs;
  });
  if (!candidates.length) return '-';
  candidates.sort((a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt));
  return candidates[0].ip;
}

function formatAccountTable(state, { now = new Date(), refreshingIds, all = false, mode = 'box' } = {}) {
  const accounts = getVisibleAccounts(state, { all });
  const rows = accounts.map((account, i) => {
    const capacity = accountCapacity(state, account, now);
    const ip = getAccountIpDisplay(account, state, { now });
    const cleanUser = account.username ? clean(account.username).replace(/^@/, '') : '';
    const accountCell = cleanUser ? `<a href="https://x.com/${cleanUser}">@${cleanUser}</a>` : 'غير متحقق';
    return [String(i + 1), accountCell, `${Number.isFinite(capacity.used) ? capacity.used : '?'} / ${capacity.limit === Infinity ? '∞' : capacity.limit}`.replace(/ /g, ''), ip, refreshingIds?.has(account.id) ? 'جاري التحديث' : accountStatus(account)];
  });
  const table = mode === 'rich'
    ? richTable(['#', 'الحساب (@)', 'الكوتا', 'Exit IP', 'الحالة'], rows, 'إدارة الحسابات المفعلة')
    : preTable(['#', 'الحساب (@)', 'الكوتا', 'Exit IP', 'الحالة'], rows, 'إدارة الحسابات المفعلة');
  return [table, ...(!rows.length ? ['\nلا توجد حسابات مضافة.'] : [])].join('\n');
}

module.exports = { formatAccountTable, getAccountExitIp, getAccountIpDisplay, getCurrentRunStats, getCurrentRunTotals, getVisibleAccounts, accountStatus, escapeHtml, clean, preTable, richTable };
