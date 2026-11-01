'use strict';
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
function evaluate({ now, heartbeatAt, pollAt, timeoutMs }) {
  return { eventLoopStalled: now - heartbeatAt > timeoutMs, pollingStalled: now - pollAt > timeoutMs, action: 'alert_only' };
}
if (!isMainThread && workerData?.yjWatchdog) {
  let heartbeatAt = Date.now(), pollAt = heartbeatAt, alarm = '';
  parentPort.on('message', message => { heartbeatAt = Date.now(); pollAt = message.pollAt; });
  parentPort.postMessage({ event: 'watchdog_ready' });
  setInterval(() => {
    const result = evaluate({ now: Date.now(), heartbeatAt, pollAt, timeoutMs: workerData.timeoutMs });
    const stalled = result.eventLoopStalled || result.pollingStalled;
    const signature = `${result.eventLoopStalled}:${result.pollingStalled}`;
    // A polling alarm must not hide a later event-loop freeze. Report each
    // transition, not each tick; this monitor deliberately never sends signals.
    if (stalled && signature !== alarm) {
      parentPort.postMessage(result);
      process.stderr.write(JSON.stringify({ event: 'watchdog_stall', ...result }) + '\n');
    }
    alarm = stalled ? signature : '';
  }, workerData.intervalMs);
}
function startWatchdog({ timeoutMs = 180000, intervalMs = 5000, onAlarm = () => {}, onReady = () => {} } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(intervalMs) || intervalMs <= 0 || intervalMs >= timeoutMs) throw new TypeError('Invalid watchdog timing');
  let pollAt = Date.now();
  const worker = new Worker(__filename, { workerData: { yjWatchdog: true, timeoutMs, intervalMs } });
  worker.on('message', message => message.event === 'watchdog_ready' ? onReady(message) : onAlarm(message));
  worker.on('error', () => process.stderr.write('{"event":"watchdog_monitor_error","action":"alert_only"}\n'));
  const timer = setInterval(() => worker.postMessage({ pollAt }), intervalMs);
  timer.unref(); worker.unref();
  return { poll: () => { pollAt = Date.now(); }, close: async () => { clearInterval(timer); await worker.terminate(); } };
}
module.exports = { startWatchdog, evaluate };
