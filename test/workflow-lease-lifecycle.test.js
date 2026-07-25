'use strict';

// RED->GREEN gates for long-term-use durability:
//  L1  a lease that expires during a slow prepare() must not strand the item
//  L2  an expired lease owned by a dead run must be reclaimable without restart
//  L3  reconcileStartup must quarantine one bad row, not abort every item
//
// L1/L2 matter because the global recovery gate means a single stranded item
// can wedge the entire queue until the user restarts the app.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkflowStore } = require('../dev/automation/workflowStore');
const { dispatchNext } = require('../dev/automation/publishWorkflow');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xposter-lease-'));

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

async function slowPreparationRenewsInsteadOfStranding() {
  const store = freshStore('renew');
  try {
    const { profileId, runId } = ctx(store, 'renew');
    store.enqueue({ items: [{ text: 'slow prepare' }], requestId: 'e1' });

    let dispatched = 0;
    const result = await dispatchNext({
      store,
      profileId,
      runId,
      leaseMs: 400,
      // Preparation outlives the lease window; the workflow must keep the lease
      // alive rather than lose the item at the boundary. The margin is a full
      // order of magnitude so GC/scheduling jitter cannot flake this.
      prepare: async (item) => {
        await new Promise((resolve) => setTimeout(resolve, 1_200));
        return { renderedText: item.payload.text };
      },
      dispatch: async () => { dispatched += 1; return { confirmed: true, externalId: 'ok-1' }; },
    });

    assert.strictEqual(result.status, 'confirmed',
      'a slow but successful preparation must still publish exactly once');
    assert.strictEqual(dispatched, 1);
    assert.strictEqual(store.getItem(result.item.id).state, 'published');
  } finally {
    store.close();
  }
}

function expiredLeaseOfDeadRunIsReclaimed() {
  const store = freshStore('reclaim');
  try {
    const { profileId, runId } = ctx(store, 'reclaim');
    store.enqueue({ items: [{ text: 'stranded' }], requestId: 'e1' });

    const leased = store.leaseNext({ profileId, runId, leaseMs: 1 });
    assert.strictEqual(leased.state, 'leased');

    // The owning run dies without releasing (crash / forced Stop).
    store.finishRun({ runId, status: 'crashed', requestId: 'crash' });

    // Without restarting the whole app, a new run must be able to reclaim it.
    const run2 = store.startRun({ requestId: 'r2' });
    const reclaimed = store.reclaimExpiredLeases({ requestId: 'reclaim-1', graceMs: 0 });
    assert.strictEqual(reclaimed.reclaimedIds.length, 1,
      'an expired lease owned by a dead run must be reclaimable in-process');

    const item = store.getItem(leased.id);
    assert.strictEqual(item.state, 'queued');
    assert.strictEqual(store.countUnresolvedRecovery(), 0,
      'a pre-boundary lease never became an irreversible dispatch');

    const released = store.leaseNext({ profileId, runId: run2.id });
    assert.strictEqual(released.id, leased.id, 'the reclaimed item must be dispatchable again');
  } finally {
    store.close();
  }
}

function liveLeaseIsNeverStolen() {
  const store = freshStore('nosteal');
  try {
    const { profileId, runId } = ctx(store, 'nosteal');
    store.enqueue({ items: [{ text: 'in flight' }], requestId: 'e1' });

    const leased = store.leaseNext({ profileId, runId, leaseMs: 60_000 });
    const reclaimed = store.reclaimExpiredLeases({ requestId: 'reclaim-live' });
    assert.strictEqual(reclaimed.reclaimedIds.length, 0,
      'a live lease under an active run must never be stolen');
    assert.strictEqual(store.getItem(leased.id).state, 'leased');
  } finally {
    store.close();
  }
}

function reconcileQuarantinesBadRowInsteadOfAborting() {
  const store = freshStore('quarantine');
  try {
    const { profileId, runId } = ctx(store, 'quarantine');
    store.enqueue({ items: [{ text: 'good' }, { text: 'corrupt' }], requestId: 'e1' });

    // One healthy dispatch_started item.
    const good = store.leaseNext({ profileId, runId });
    store.beginDispatch({
      id: good.id,
      leaseToken: good.leaseToken,
      renderedText: 'good',
      requestId: 'begin-good',
    });

    // Simulate an item/attempt split-brain: a legitimately dispatch_started row
    // whose attempt record became unreadable (older buggy build, partial repair,
    // manual surgery). The item state itself is reached through the normal API.
    const badLease = store.leaseNext({ profileId, runId, allowUnresolvedRecovery: true });
    const badAttempt = store.beginDispatch({
      id: badLease.id,
      leaseToken: badLease.leaseToken,
      renderedText: 'corrupt',
      requestId: 'begin-bad',
      // Fixture setup only: deliberately builds a second unresolved row so we
      // can prove recovery quarantines it instead of aborting.
      allowUnresolvedRecovery: true,
    });
    const bad = { id: badLease.id };
    // Desynchronize only the attempt side, leaving the item at dispatch_started.
    store.db.prepare(`
      UPDATE dispatch_attempts SET phase = 'ambiguous' WHERE id = ?
    `).run(badAttempt.attemptId);

    // Recovery must still process the healthy item rather than refusing to start.
    const result = store.reconcileStartup({ requestId: 'reconcile-1' });
    assert.ok(result.ambiguousIds.includes(good.id),
      'a healthy dispatch_started item must still be recovered into ambiguous');
    assert.ok(Array.isArray(result.quarantinedIds) && result.quarantinedIds.includes(bad.id),
      'the inconsistent row must be quarantined, not abort the whole recovery');
    assert.strictEqual(store.getItem(bad.id).state, 'ambiguous',
      'a quarantined row must be conservatively unresolved, never auto-eligible');
  } finally {
    store.close();
  }
}

async function main() {
  await slowPreparationRenewsInsteadOfStranding();
  expiredLeaseOfDeadRunIsReclaimed();
  liveLeaseIsNeverStolen();
  reconcileQuarantinesBadRowInsteadOfAborting();
  console.log('✅ workflow lease lifecycle: renewal, dead-run reclamation, no theft, quarantined recovery');
}

main()
  .then(() => fs.rmSync(root, { recursive: true, force: true }))
  .catch((error) => {
    fs.rmSync(root, { recursive: true, force: true });
    console.error(error);
    process.exit(1);
  });
