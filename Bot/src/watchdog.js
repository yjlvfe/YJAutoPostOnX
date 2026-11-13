'use strict';
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

function monotonicMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function evaluate({ now, heartbeatAt, pollAt, timeoutMs, monotonicNow, monotonicHeartbeatAt, monotonicPollAt }) {
  const useMonotonicHeartbeat = Number.isFinite(monotonicNow) && Number.isFinite(monotonicHeartbeatAt);
  const useMonotonicPoll = Number.isFinite(monotonicNow) && Number.isFinite(monotonicPollAt);
  const eventLoopElapsedMs = useMonotonicHeartbeat ? monotonicNow - monotonicHeartbeatAt : now - heartbeatAt;
  const pollingElapsedMs = useMonotonicPoll ? monotonicNow - monotonicPollAt : now - pollAt;
  return {
    eventLoopStalled: eventLoopElapsedMs > timeoutMs,
    pollingStalled: pollingElapsedMs > timeoutMs,
    eventLoopElapsedMs,
    pollingElapsedMs,
    action: 'alert_only'
  };
}

if (!isMainThread && workerData?.yjWatchdog) {
  let heartbeatAt = Date.now();
  let pollAt = Number.isFinite(workerData.initialPollAt) ? workerData.initialPollAt : heartbeatAt;
  let monotonicHeartbeatAt = monotonicMs();
  let monotonicPollAt = Number.isFinite(workerData.initialMonotonicPollAt) ? workerData.initialMonotonicPollAt : monotonicHeartbeatAt;
  let alarm = '';
  parentPort.on('message', message => {
    heartbeatAt = Date.now();
    monotonicHeartbeatAt = monotonicMs();
    if (Number.isFinite(message?.pollAt)) pollAt = message.pollAt;
    if (Number.isFinite(message?.monotonicPollAt)) monotonicPollAt = message.monotonicPollAt;
  });
  parentPort.postMessage({ event: 'watchdog_ready' });
  setInterval(() => {
    const result = evaluate({
      now: Date.now(),
      heartbeatAt,
      pollAt,
      monotonicNow: monotonicMs(),
      monotonicHeartbeatAt,
      monotonicPollAt,
      timeoutMs: workerData.timeoutMs
    });
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
  let monotonicPollAt = monotonicMs();
  const worker = new Worker(__filename, {
    workerData: { yjWatchdog: true, timeoutMs, intervalMs, initialPollAt: pollAt, initialMonotonicPollAt: monotonicPollAt }
  });
  worker.on('message', message => message.event === 'watchdog_ready' ? onReady(message) : onAlarm(message));
  worker.on('error', () => process.stderr.write('{"event":"watchdog_monitor_error","action":"alert_only"}\n'));
  const timer = setInterval(() => worker.postMessage({ pollAt, monotonicPollAt }), intervalMs);
  timer.unref(); worker.unref();
  return {
    poll: () => {
      pollAt = Date.now();
      monotonicPollAt = monotonicMs();
    },
    close: async () => { clearInterval(timer); await worker.terminate(); }
  };
}

module.exports = { startWatchdog, evaluate };
