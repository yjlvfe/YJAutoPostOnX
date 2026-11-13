'use strict';
// Linux identities are scoped to a boot and PID namespace, not just a PID.
const fs = require('node:fs');
function readProcStat(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { missing: true };
  try {
    const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const end = text.lastIndexOf(')');
    const fields = text.slice(end + 2).trim().split(/\s+/);
    if (end < 0 || !/^\d+$/.test(fields[19] || '') || !/^\d+$/.test(fields[2] || '')) return { unknown: true };
    return { state: fields[0], ppid: Number(fields[1]), pgid: Number(fields[2]), sid: Number(fields[3]), starttime: fields[19] };
  } catch (error) { return error.code === 'ENOENT' || error.code === 'ESRCH' ? { missing: true } : { unknown: true }; }
}
function getPidStartTime(pid) {
  const stat = readProcStat(pid);
  return stat.missing || stat.unknown || ['Z', 'X', 'x'].includes(stat.state) ? null : stat.starttime;
}
function processStatus(pid, expectedStartTime = null) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'unknown';
  try { process.kill(pid, 0); } catch (error) { return error.code === 'ESRCH' ? 'dead' : 'unknown'; }
  const stat = readProcStat(pid);
  if (stat.missing || stat.unknown) return 'unknown';
  if (['Z', 'X', 'x'].includes(stat.state)) return 'dead';
  if (expectedStartTime == null) return 'unknown';
  return String(stat.starttime) === String(expectedStartTime) ? 'alive' : 'reused';
}
// Kernel membership check, not a /proc snapshot. Success can include zombies:
// retain conservatively until the group is reaped. Only ESRCH proves absence.
function processGroupStatus(pgid) {
  if (!Number.isSafeInteger(pgid) || pgid <= 0) return 'unknown';
  try { process.kill(-pgid, 0); return 'alive'; }
  catch (error) { return error.code === 'ESRCH' ? 'dead' : 'unknown'; }
}
function isPidAlive(pid, _expectedPattern, expectedStartTime = null) {
  return !['dead', 'reused'].includes(processStatus(pid, expectedStartTime));
}
function hostIdentity() {
  try {
    return `${fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${fs.readlinkSync('/proc/self/ns/pid')}`;
  } catch { return null; }
}
function visibilityError() {
  return Object.assign(new Error('PROCESS_VISIBILITY_UNVERIFIED: Complete local process visibility is required'), { code: 'PROCESS_VISIBILITY_UNVERIFIED' });
}
function scanProcesses() {
  let entries;
  try { entries = fs.readdirSync('/proc'); } catch { throw visibilityError(); }
  const processes = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    const stat = readProcStat(pid);
    if (stat.missing && processStatus(pid) === 'dead') continue;
    if (stat.missing || stat.unknown) throw visibilityError();
    if (['Z', 'X', 'x'].includes(stat.state)) continue;
    let argv;
    try { argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); }
    catch { if (processStatus(pid, stat.starttime) === 'dead') continue; throw visibilityError(); }
    processes.push({ pid, ...stat, directX: /(?:^|\/)python(?:\d+(?:\.\d+)*)?$/i.test(argv[0] || '') && argv.some(arg => /(?:direct_x_bridge|direct_x_compat)\.py/.test(arg)) });
  }
  return processes;
}
module.exports = { readProcStat, getPidStartTime, processStatus, processGroupStatus, isPidAlive, isProcessAlive: isPidAlive, hostIdentity, scanProcesses };
