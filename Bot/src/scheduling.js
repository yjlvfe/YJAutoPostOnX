'use strict';

const RIYADH = 'Asia/Riyadh';
function riyadhDateParts(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date ?? Date.now());
  const validDate = isNaN(d.getTime()) ? new Date() : d;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: RIYADH, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(validDate);
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
// Preserve the existing policy: one scheduled start per Riyadh day, only in
// the configured minute. Downtime does not authorize an overdue catch-up run.
function scheduleOccurrence(settings = {}, now = new Date()) {
  const schedule = settings?.schedule;
  if (!schedule?.enabled || !isDue(schedule, now)) return null;
  const p = riyadhDateParts(now);
  const day = `${p.year}-${p.month}-${p.day}`;
  return { day, hour: schedule.hour, minute: schedule.minute, revision: settings.scheduleRevision || 0 };
}
function sameOccurrence(a, b) {
  return Boolean(a && b && a.day === b.day && a.hour === b.hour && a.minute === b.minute && a.revision === b.revision);
}

function matchesScheduleOccurrence(settings = {}, expectedOccurrence = null) {
  if (!expectedOccurrence) return false;
  const schedule = settings?.schedule;
  if (!schedule?.enabled) return false;
  const expectedHour = Number(expectedOccurrence.hour);
  const expectedMinute = Number(expectedOccurrence.minute);
  const actualHour = Number(schedule.hour ?? 9);
  const actualMinute = Number(schedule.minute ?? 0);
  if (!Number.isSafeInteger(expectedHour) || !Number.isSafeInteger(expectedMinute)) return false;
  if (actualHour !== expectedHour || actualMinute !== expectedMinute) return false;
  return (settings.scheduleRevision || 0) === (expectedOccurrence.revision || 0);
}
function createPublicationScheduler({ settings, start, clock = () => new Date(), onError = () => {}, setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
  let stopped = false, task = null, attempted = null;
  const tick = () => {
    if (stopped) return Promise.resolve();
    if (task) return task;
    const work = Promise.resolve().then(async () => {
      const current = await settings.get();
      if (stopped) return;
      const occurrence = scheduleOccurrence(current, clock());
      if (!occurrence) return;
      const key = JSON.stringify(occurrence);
      if (key === attempted) return;
      // One bounded attempt per occurrence (including rejection/error), not an
      // open retry loop or repeated owner warnings during the due minute.
      attempted = key;
      await start(occurrence);
    }).catch(error => { try { onError(error); } catch {} });
    task = work;
    work.finally(() => { if (task === work) task = null; });
    return work;
  };
  const timer = setIntervalFn(tick, 1000); timer?.unref?.();
  return { tick, stop: () => { stopped = true; clearIntervalFn(timer); return task || Promise.resolve(); } };
}
module.exports = { RIYADH, riyadhDateParts, isDue, nextRiyadhDaily, scheduleOccurrence, sameOccurrence, matchesScheduleOccurrence, createPublicationScheduler };
