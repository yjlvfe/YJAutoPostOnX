'use strict';

const { isPublicIp } = require('./publicIp');
const { accountCapacity } = require('./quota');
const { getUnsuccessfulAttempts } = require('./attemptOutcomes');
const { escapeHtml, clean, richTable, preTable } = require('./tableUtils');

function accountStatus(account) {
  const status = String(account.status || '').trim();
  if (status === 'محظور' || ['suspended', 'banned'].includes(status.toLowerCase())) return 'محظور';
  if (status === 'كابتشا' || status.toLowerCase() === 'captcha') return 'كابتشا';
  return account.enabled === false ? 'غير مفعل' : 'مفعل';
}

function formatAccountTable(state, { now = new Date(), refreshingIds, all = false } = {}) {
  const allAccounts = state.accounts || [];
  const accounts = all ? allAccounts : allAccounts.filter(a => {
    const status = String(a.status || '').trim();
    const isBanned = status === 'محظور' || ['suspended', 'banned'].includes(status.toLowerCase());
    if (isBanned) return false;
    const isCaptcha = status === 'كابتشا' || status.toLowerCase() === 'captcha';
    if (isCaptcha) return true;
    const isInactive = status === 'غير مفعل' || status === 'خامل' || ['disabled', 'inactive'].includes(status.toLowerCase()) || a.enabled === false;
    if (isInactive) return false;
    return status === 'مفعل' || a.enabled !== false;
  });
  const rows = accounts.map((account, i) => {
    const checks = state.telegramUi?.accountChecks?.[account.id] || {};
    const capacity = accountCapacity(state, account, now);
    const unsuccessful = getUnsuccessfulAttempts(state, account.id, now);
    const ip = [account.exitIp, checks.vpn?.ip].find(value => isPublicIp(value)) || '—';
    return [String(i + 1), account.username ? '@' + clean(account.username) : 'غير متحقق', `${Number.isFinite(capacity.used) ? capacity.used : '?'} / ${capacity.limit === Infinity ? '∞' : capacity.limit}`.replace(/ /g, ''), ip, `${unsuccessful.failed}/${unsuccessful.ambiguous}`, refreshingIds?.has(account.id) ? 'جاري التحديث' : accountStatus(account)];
  });
  return [richTable(['#', 'الحساب (@)', 'الكوتا', 'Exit IP', 'فشل/غامض', 'الحالة'], rows, 'إدارة الحسابات المفعلة') + '\nفشل/غامض: محاولات فاشلة / نتائج إرسال غير مؤكدة، محسوبة منذ تفعيل العداد (اليوم بتوقيت الرياض).', ...(!rows.length ? ['\nلا توجد حسابات مضافة.'] : [])].join('\n');
}

module.exports = { formatAccountTable, accountStatus, escapeHtml, clean, preTable, richTable };
