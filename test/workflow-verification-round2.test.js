'use strict';

// RED->GREEN gates for the two defects found by the second verification round
// at commit a82b978:
//
//  V1  BYPASS CONFIRMED: when beginDispatch fails with LEASE_EXPIRED,
//      resolveBoundaryGuardFailure returned without transitioning, leaving the
//      item STRANDED in 'leased' — invisible in listQueued, listRecovery and
//      countUnresolvedRecovery. The user believes it was published.
//      Observed: status=lease_lost_pre_dispatch, item.state=leased,
//                listQueued=0, listRecovery=0, countUnresolved=0
//
//  V2  pruneIdempotency deleted the replay records of an item that was STILL
//      unresolved (ambiguous). That operation is by definition still pending,
//      so a legitimate retry would re-execute instead of replaying.
//      Observed: deleted=5 while the item remained ambiguous.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkflowStore } = require('../dev/automation/workflowStore');
const { dispatchNext } = require('../dev/automation/publishWorkflow');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xposter-verify2-'));

function freshStore(name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return new WorkflowStore({ rootDir: dir });
}

function ctx(store, label) {
  const profile = store.createProfile({ name: `P-${label}`, requestId: `p-${label}` });
  const run = store.startRun({ requestId: `r-${label}` });
  return { profileId: profile.id, runId: run.id };
}

// V1 — an expired lease must never leave the item invisible.
async function expiredLeaseAtBoundaryIsNeverStranded() {
  const store = freshStore('stranded');
  try {
    const { profileId, runId } = ctx(store, 'stranded');
    store.enqueue({ items: [{ text: 'expiring' }], requestId: 'e1' });

    let transportCalls = 0;
    const result = await dispatchNext({
      store,
      profileId,
      runId,
      leaseMs: 30,
      // Block the event loop so the renewal timer is starved — exactly the
      // real-world pattern (synchronous render / fs / large JSON in prepare).
      prepare: (item) => {
        const until = Date.now() + 200;
        while (Date.now() < until) { /* deliberate synchronous stall */ }
        return { renderedText: item.payload.text };
      },
      dispatch: async () => { transportCalls += 1; return { confirmed: true, externalId: 'x' }; },
    });

    assert.strictEqual(transportCalls, 0, 'an expired lease must not reach the transport');

    const items = store.listItems({ states: ['queued', 'leased', 'deferred', 'dead'], limit: 10 });
    assert.strictEqual(items.length, 1);
    const item = items[0];
    assert.notStrictEqual(item.state, 'leased',
      `an item must never remain stranded in 'leased' after dispatchNext returns (got ${item.state})`);

    // It must be visible somewhere the user or the next run can act on.
    const visible = store.listQueued({ limit: 10 }).length + store.listRecovery().length;
    assert.ok(visible >= 1,
      'the item must be discoverable in the queue or the recovery list, never invisible');
    void result;
  } finally {
    store.close();
  }
}

// V2 — replay records of an in-flight operation must survive pruning.
function pruneKeepsRecordsOfUnresolvedOperations() {
  const store = freshStore('prune-safety');
  try {
    const { profileId, runId } = ctx(store, 'prune-safety');
    store.enqueue({ items: [{ text: 'in flight' }], requestId: 'e1' });
    const leased = store.leaseNext({ profileId, runId });
    const attempt = store.beginDispatch({
      id: leased.id,
      leaseToken: leased.leaseToken,
      renderedText: 'in flight',
      requestId: 'begin-1',
    });
    store.markAmbiguous({
      attemptId: attempt.attemptId,
      reason: 'unknown_outcome',
      requestId: 'amb-1',
    });
    assert.strictEqual(store.countUnresolvedRecovery(), 1);

    // Prune far in the future: every record is "aged", but the operation this
    // item belongs to has NOT finished, so its replay protection must remain.
    const future = Date.now() + (365 * 86_400_000);
    store.pruneIdempotency({ olderThanMs: 7 * 86_400_000, now: future });

    const survivors = store.db
      .prepare('SELECT request_id FROM api_requests ORDER BY request_id')
      .all().map((row) => row.request_id);
    assert.ok(survivors.includes('begin-1'),
      'the boundary record of an unresolved item must never be pruned');
    assert.ok(survivors.includes('amb-1'),
      'the ambiguity record of an unresolved item must never be pruned');

    // Replay must still be honoured for the still-pending operation.
    const replay = store.markAmbiguous({
      attemptId: attempt.attemptId,
      reason: 'unknown_outcome',
      requestId: 'amb-1',
    });
    assert.strictEqual(replay.state, 'ambiguous');
    assert.strictEqual(store.countUnresolvedRecovery(), 1,
      'replaying must not create a second unresolved dispatch');
  } finally {
    store.close();
  }
}

// V2b — once everything is resolved, pruning must actually reclaim space.
function pruneStillWorksOnceResolved() {
  const store = freshStore('prune-works');
  try {
    const { profileId, runId } = ctx(store, 'prune-works');
    store.enqueue({ items: [{ text: 'done' }], requestId: 'e1' });
    const leased = store.leaseNext({ profileId, runId });
    const attempt = store.beginDispatch({
      id: leased.id,
      leaseToken: leased.leaseToken,
      renderedText: 'done',
      requestId: 'begin-1',
    });
    store.markPublished({
      attemptId: attempt.attemptId,
      externalUrl: 'https://x.com/status/9',
      evidence: { confirmed: true },
      requestId: 'pub-1',
    });
    assert.strictEqual(store.countUnresolvedRecovery(), 0);

    const before = store.db.prepare('SELECT COUNT(*) AS n FROM api_requests').get().n;
    const future = Date.now() + (365 * 86_400_000);
    const pruned = store.pruneIdempotency({ olderThanMs: 7 * 86_400_000, now: future });
    assert.ok(pruned.deleted >= before,
      'with nothing in flight, aged records must be fully reclaimable');
    assert.strictEqual(store.getItem(leased.id).state, 'published');
    assert.strictEqual(store.integrityCheck().ok, true);
  } finally {
    store.close();
  }
}

async function main() {
  await expiredLeaseAtBoundaryIsNeverStranded();
  pruneKeepsRecordsOfUnresolvedOperations();
  pruneStillWorksOnceResolved();
  console.log('✅ workflow verification round 2: no stranded lease, prune respects in-flight operations');
}

main()
  .then(() => fs.rmSync(root, { recursive: true, force: true }))
  .catch((error) => {
    fs.rmSync(root, { recursive: true, force: true });
    console.error(error);
    process.exit(1);
  });
