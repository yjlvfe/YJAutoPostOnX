'use strict';

const RIYADH = 'Asia/Riyadh';
function riyadhDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: RIYADH, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  return Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
}
function isDue({ hour = 9, minute = 0 } = {}, date = new Date()) {
  const p = riyadhDateParts(date); return p.hour === hour && p.minute === minute;
}
function nextRiyadhDaily({ hour = 9, minute = 0 } = {}, now = new Date()) {
  const p = riyadhDateParts(now);
  const today = Date.UTC(p.year, p.month - 1, p.day, hour, minute) - 3 * 60 * 60 * 1000;
  const current = now.getTime();
  return new Date(today > current ? today : today + 86400000);
}
module.exports = { RIYADH, riyadhDateParts, isDue, nextRiyadhDaily };
