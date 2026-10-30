'use strict';

const { isIP } = require('node:net');
const { accountCapacity } = require('./quota');
const CHECK_MAX_AGE_MS = 5 * 60 * 1000;
const escapeHtml = text => String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clean = value => String(value ?? '').replace(/[\r\n\t\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\|/g, '¦').slice(0, 48);
const attributed = check => check?.isolated === true && ['isolated-verifier', 'vpn-slot-manager'].includes(check.source) && Number.isFinite(Date.parse(check.checkedAt));
const fresh = (check, now) => attributed(check) && new Date(now).getTime() - Date.parse(check.checkedAt) >= 0 && new Date(now).getTime() - Date.parse(check.checkedAt) <= CHECK_MAX_AGE_MS;

function checkedTime(check) {
  const date = new Date(Date.parse(check.checkedAt) + 3 * 60 * 60 * 1000);
  return `${date.toISOString().slice(0, 19).replace('T', ' ')} +03:00`;
}

function richTable(headers, rows, caption = '') {
  const parts = ['<table bordered compact>'];
  if (caption) parts.push(`<caption>${escapeHtml(caption)}</caption>`);
  if (headers && headers.length) {
    parts.push('<tr>' + headers.map(h => `<th align="center">${escapeHtml(h)}</th>`).join('') + '</tr>');
  }
  for (const row of rows) {
    parts.push('<tr>' + row.map((cell, idx) => {
      const align = (headers.length === 2 && idx === 1) ? 'right' : 'center';
      return `<td align="${align}">${escapeHtml(cell)}</td>`;
    }).join('') + '</tr>');
  }
  parts.push('</table>');
  return parts.join('');
}

function preTable(headers, rows, caption = '') {
  return richTable(headers, rows, caption);
}

function accountStatus(account, capacity, checks = {}, now = new Date()) {
  if (account.enabled === false) return 'معطل';
  if (!attributed(checks.session)) return 'جلسة غير مفحوصة';
  if (!fresh(checks.session, now)) return 'فحص قديم';
  if (checks.session.challenge === true || checks.session.locked === true || checks.session.captcha === true) return 'كابتشا';
  if (checks.session.suspended === true || checks.session.banned === true) return 'محظور';
  if (checks.session.authenticated !== true || !/^[A-Za-z0-9_]{1,15}$/.test(account.username || '') || checks.session.username?.toLowerCase() !== account.username.toLowerCase()) return 'جلسة غير صالحة';
  if (!attributed(checks.vpn)) return 'VPN غير مفحوص';
  if (!fresh(checks.vpn, now)) return 'فحص قديم';
  if (checks.vpn.healthy !== true || !isIP(checks.vpn.ip || '')) return 'VPN غير سليم';
  if (!(capacity.remaining > 0)) return 'ممتلئ';
  return 'فعال';
}

function formatAccountTable(state, { now = new Date() } = {}) {
  const accounts = state.accounts || [];
  const footnotes = [];
  const rows = accounts.map((account, i) => {
    const checks = state.telegramUi?.accountChecks?.[account.id] || {};
    const capacity = accountCapacity(state, account, now);
    const ip = fresh(checks.vpn, now) && checks.vpn.healthy === true && isIP(checks.vpn.ip || '') ? checks.vpn.ip : 'غير متاح';
    for (const [kind, check] of [['الجلسة', checks.session], ['VPN', checks.vpn]]) {
      if (attributed(check)) footnotes.push(`${i + 1} ${kind}: ذاكرة مؤقتة · ${check.source} · ${checkedTime(check)}${fresh(check, now) ? '' : ' · فحص قديم'}`);
    }
    return [String(i + 1), account.username ? '@' + clean(account.username) : 'غير متحقق', `${Number.isFinite(capacity.used) ? capacity.used : '?'} / ${capacity.limit === Infinity ? '∞' : capacity.limit}`.replace(/ /g, ''), ip, accountStatus(account, capacity, checks, now)];
  });
  return [richTable(['#', 'الحساب (@)', 'الكوتا', 'Exit IP', 'الحالة'], rows, 'إدارة الحسابات المفعلة'), ...(!rows.length ? ['\nلا توجد حسابات مضافة.'] : []), ...footnotes].join('\n');
}

module.exports = { formatAccountTable, accountStatus, attributed, fresh, checkedTime, CHECK_MAX_AGE_MS, escapeHtml, clean, preTable, richTable };
