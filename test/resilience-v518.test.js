'use strict';

const assert = require('assert');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const sandbox = path.join(os.tmpdir(), `xposter-resilience-${process.pid}-${Date.now()}`);
os.homedir = () => sandbox;
const keepAlive = setInterval(() => {}, 1000);

const { atomicWriteJson, readJson } = require('../dev/utils/atomicJson');
const queueManager = require('../dev/automation/queueManager');
const { SessionManager, STATUS } = require('../dev/automation/sessionManager');
const { inspectToast } = require('../dev/automation/xPoster');

function toast(text, href = null) {
  return {
    textContent: async () => text,
    $: async () => href ? ({ getAttribute: async () => href }) : null,
  };
}

async function main() {
  await fsp.mkdir(sandbox, { recursive: true });

  const atomicFile = path.join(sandbox, 'atomic.json');
  await atomicWriteJson(atomicFile, { generation: 1 });
  await atomicWriteJson(atomicFile, { generation: 2 });
  await fsp.writeFile(atomicFile, '{broken');
  assert.deepStrictEqual(await readJson(atomicFile, null), { generation: 1 }, 'valid backup is used when primary JSON is corrupt');

  await Promise.all(Array.from({ length: 40 }, (_, i) => atomicWriteJson(atomicFile, { i })));
  const finalAtomic = JSON.parse(await fsp.readFile(atomicFile, 'utf8'));
  assert(Number.isInteger(finalAtomic.i), 'concurrent atomic writes leave valid JSON');

  await queueManager.addPosts(['post-a', 'post-b']);
  await queueManager.markPosting('post-a', 'Default');
  const recovered = await queueManager.recoverInterruptedPosts('Default');
  assert.strictEqual(recovered.length, 1, 'interrupted publish intent is recovered');
  assert.deepStrictEqual(await queueManager.getQueue(), ['post-b'], 'ambiguous post is removed from auto-publish queue');
  let recovery = await queueManager.getRecoveryItems('Default');
  assert.strictEqual(recovery.pending[0].text, 'post-a', 'ambiguous post is visible in pending recovery');
  await queueManager.requeueRecovery('Default', 'pending', 'post-a');
  assert.deepStrictEqual(await queueManager.getQueue(), ['post-b', 'post-a'], 'user can explicitly requeue a pending post');
  await queueManager.moveToDeadLetter('post-b', 'selector', 'missing selector', 'Default');
  assert.deepStrictEqual(await queueManager.getQueue(), ['post-a'], 'dead-letter move removes exactly the failed post');
  recovery = await queueManager.getRecoveryItems('Default');
  assert.strictEqual(recovery.deadLetters[0].text, 'post-b', 'dead-letter remains visible and recoverable');

  const confirmed = await inspectToast(toast('Your post was sent', '/user/status/123'));
  const error = await inspectToast(toast('Something went wrong. Try again.'));
  const limit = await inspectToast(toast('You are unable to post due to a rate limit.'));
  assert.strictEqual(confirmed.kind, 'confirmed', 'only a status URL is a strong success confirmation');
  assert.strictEqual(error.kind, 'error', 'error toast is never classified as success');
  assert.strictEqual(limit.kind, 'rate-limit', 'rate-limit toast is classified before success');

  const engine = {
    syncSessionDedup() {},
    buildAcceptedContext() { return ''; },
    selectAngles() { return []; },
  };
  let failureCalls = 0;
  const failureManager = new SessionManager({
    engine,
    runRound: async () => { failureCalls++; throw new Error('network down'); },
    ingest: () => 0,
    sessionCount: 1,
    getSessionCount: () => 1,
    maxConsecutiveFailures: 3,
    maxNoProgressRounds: 20,
    baseBackoffMs: 50,
    maxBackoffMs: 50,
  });
  await failureManager.run(() => false);
  assert.strictEqual(failureCalls, 3, 'session circuit breaker stops repeated failures');
  assert.strictEqual(failureManager.sessions[0].status, STATUS.STOPPED, 'failed session is visibly stopped');

  let emptyCalls = 0;
  const emptyManager = new SessionManager({
    engine,
    runRound: async () => { emptyCalls++; return { cores: [], usage: {} }; },
    ingest: () => 0,
    sessionCount: 1,
    getSessionCount: () => 1,
    maxConsecutiveFailures: 10,
    maxNoProgressRounds: 3,
    baseBackoffMs: 50,
    maxBackoffMs: 50,
  });
  await emptyManager.run(() => false);
  assert.strictEqual(emptyCalls, 3, 'no-progress budget stops endless empty success rounds');
  assert.strictEqual(emptyManager.sessions[0].status, STATUS.STOPPED, 'no-progress session is visibly stopped');

  console.log('✅ resilience-v518: atomic storage, recovery state, toast semantics, and AI budgets passed');
}

main().finally(() => {
  clearInterval(keepAlive);
  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch {}
}).catch(err => {
  console.error(err);
  process.exitCode = 1;
});
