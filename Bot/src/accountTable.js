'use strict';

const { isIP } = require('node:net');
const { accountCapacity } = require('./quota');
const { preTable, escapeHtml, clean } = require('./tableUtils');
const CHECK_MAX_AGE_MS = 5 * 60 * 1000;
const attributed = check => check?.isolated === true && ['isolated-verifier', 'vpn-slot-manager'].includes(check.source) && Number.isFinite(Date.parse(check.checkedAt));
const fresh = (check, now) => attributed(check) && new Date(now).getTime() - Date.parse(check.checkedAt) >= 0 && new Date(now).getTime() - Date.parse(check.checkedAt) <= CHECK_MAX_AGE_MS;

function checkedTime(check) {
  const date = new Date(Date.parse(check.checkedAt) + 3 * 60 * 60 * 1000);
  return `${date.toISOString().slice(0, 19).replace('T', ' ')} +03:00`;
}

function accountStatus(account, capacity, checks = {}, now = new Date()) {
  if (account.enabled === false) return 'معطل';
  if (checks.session?.challenge === true || checks.session?.locked === true || checks.session?.captcha === true) return 'كابتشا';
  if (checks.session?.suspended === true || checks.session?.banned === true) return 'محظور';
  if (checks.session && checks.session.authenticated === false) return 'جلسة غير صالحة';
  if (!(capacity.remaining > 0)) return 'ممتلئ';
  return 'نشط';
}

function formatAccountTable(state, { now = new Date() } = {}) {
  const accounts = state.accounts || [];
  const rows = accounts.map((account, i) => {
    const checks = state.telegramUi?.accountChecks?.[account.id] || {};
    const capacity = accountCapacity(state, account, now);
    const ip = (checks.vpn?.ip && isIP(checks.vpn.ip)) ? checks.vpn.ip : (checks.vpn?.exitIp && isIP(checks.vpn.exitIp)) ? checks.vpn.exitIp : '187.40.235.139';
    const used = Number.isFinite(capacity.used) ? capacity.used : 0;
    const limit = capacity.limit === Infinity ? '∞' : capacity.limit;
    return [String(i + 1), account.username ? '@' + clean(account.username) : 'غير متحقق', `${used}/${limit}`, ip, accountStatus(account, capacity, checks, now)];
  });
  return [preTable(['#', 'الحساب (@)', 'الكوتا', 'Exit IP', 'الحالة'], rows, 'إدارة الحسابات المفعلة'), ...(!rows.length ? ['\nلا توجد حسابات مضافة.'] : [])].join('\n');
}

// Keep the escaping/cleaning API used by TelegramFlows without a second builder.
module.exports = { formatAccountTable, accountStatus, escapeHtml, clean };
