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
const durableQueue = require('../dev/automation/durableQueue');
const { SessionManager, STATUS } = require('../dev/automation/sessionManager');
const { inspectToast } = require('../dev/automation/xPoster');

function toast(text, href = null) {
  return {
    textContent: async () => text,
    $: async () => href ? ({ getAttribute: async () => href }) : null,
  };
}

function queueTexts(entries) {
  return entries.map((entry) => typeof entry === 'string' ? entry : entry?.text);
}

function recoveryMutation(item, requestId) {
  return { id: item.id, expectedRevision: item.revision, requestId };
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

  // Recovery state, driven through the exact surface the UI's IPC handlers call.
  // The scenario is a process that died between Ctrl+Enter and the confirmation
  // toast: the post may or may not be live on X, so only a human can resolve it.
  await durableQueue.addPosts(['post-a', 'post-b']);
  const store = await durableQueue.getStore();
  const profileId = await durableQueue.resolveProfileId('Default');
  const run = store.startRun({ requestId: 'resilience-run' });

  const leased = store.leaseNext({ profileId, runId: run.id, leaseMs: 60_000 });
  assert.strictEqual(leased.payload.text, 'post-a', 'the run claims the head of the queue');
  store.beginDispatch({
    id: leased.id,
    leaseToken: leased.leaseToken,
    renderedText: leased.payload.text,
    requestId: 'resilience-begin',
  });
  // Crash: the boundary is committed, the outcome never recorded. Reopening the
  // store must resolve it — leaving it in 'dispatch_started' would be invisible
  // in both the queue and the recovery screen.
  await durableQueue.closeStore();

  const reopened = await durableQueue.getStore();
  assert.strictEqual(reopened.countUnresolvedRecovery(), 1,
    'a dispatch interrupted by a crash is unresolved after restart, not silently retried');
  assert.deepStrictEqual(queueTexts(await durableQueue.getQueue()), ['post-b'],
    'the interrupted post is out of the auto-publish queue — it may already be live on X');

  let recovery = await durableQueue.getRecoveryItems('Default');
  const pendingA = recovery.pending[0];
  assert.strictEqual(pendingA.text, 'post-a', 'the interrupted post is visible for a human decision');

  await assert.rejects(
    async () => durableQueue.requeueRecovery(
      'Default',
      'pending',
      recoveryMutation(pendingA, 'resilience-requeue-without-confirmation'),
      {},
    ),
    (error) => error.code === 'CONFIRMATION_REQUIRED',
    'requeueing without confirming it was never published must be refused'
  );
  await durableQueue.requeueRecovery(
    'Default',
    'pending',
    recoveryMutation(pendingA, 'resilience-requeue-confirmed'),
    { confirmedNotPublished: true, evidence: { checked: true } },
  );
  assert.deepStrictEqual(queueTexts(await durableQueue.getQueue()), ['post-b', 'post-a'],
    'once the user confirms it never went out, it is publishable again');
  assert.strictEqual(reopened.countUnresolvedRecovery(), 0, 'resolving it unblocks publishing for every profile');

  // A pre-boundary permanent failure is retired instead: it never went out, so
  // it can be retired safely, and it stays visible rather than being discarded.
  const bItem = durableQueue.readAllItems(reopened, ['queued'])
    .find((item) => durableQueue.textOf(item) === 'post-b');
  // A fresh run: the crashed process's run was closed by startup reconciliation,
  // so its token can no longer authorise a lease.
  await assert.rejects(
    async () => reopened.leaseNext({ profileId, runId: run.id, leaseMs: 60_000 }),
    (err) => err.code === 'RUN_NOT_ACTIVE',
    'a run that did not survive the crash cannot keep claiming posts'
  );
  const run2 = reopened.startRun({ requestId: 'resilience-run-2' });
  const bLease = reopened.leaseNext({ profileId, runId: run2.id, leaseMs: 60_000 });
  assert.strictEqual(bLease.id, bItem.id, 'post-b is next at the head');
  reopened.markTerminal({
    id: bLease.id,
    leaseToken: bLease.leaseToken,
    reason: 'selector',
    error: { message: 'missing selector', code: null },
    requestId: 'resilience-terminal',
  });
  assert.deepStrictEqual(queueTexts(await durableQueue.getQueue()), ['post-a'],
    'retiring the failed post removes exactly that post');
  recovery = await durableQueue.getRecoveryItems('Default');
  assert.strictEqual(recovery.deadLetters[0].text, 'post-b', 'a retired post remains visible and recoverable');

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
  const failureOutcome = await failureManager.run(() => false);
  assert.strictEqual(failureCalls, 3, 'session circuit breaker stops repeated failures');
  // TERMINAL, not STOPPED. STOPPED means "parked because the worker count was
  // lowered" and IS respawned when the count rises; a session that burned its
  // failure budget must never be respawned by a sibling's round boundary.
  assert.strictEqual(failureManager.sessions[0].status, STATUS.TERMINAL, 'failed session is retired, not merely parked');
  assert.strictEqual(failureOutcome.status, 'failed', 'a pool that produced nothing reports failed');
  assert.strictEqual(failureOutcome.targetMet, false, 'a failed run never claims the target was met');

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
  const emptyOutcome = await emptyManager.run(() => false);
  assert.strictEqual(emptyCalls, 3, 'no-progress budget stops endless empty success rounds');
  assert.strictEqual(emptyManager.sessions[0].status, STATUS.TERMINAL, 'no-progress session is retired, not merely parked');
  assert.strictEqual(emptyOutcome.status, 'failed', 'no accepted posts ⇒ failed, never success');

  console.log('✅ resilience-v518: atomic storage, recovery state, toast semantics, and AI budgets passed');
}

main().finally(() => {
  clearInterval(keepAlive);
  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch {}
}).catch(err => {
  console.error(err);
  process.exitCode = 1;
});
