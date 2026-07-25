'use strict';

// RED->GREEN gates for the defects confirmed by the second independent review
// of commit c9e7907/fda4403:
//
//  R1  BLOCKER REOPENED: a worker that leased BEFORE an ambiguity appeared can
//      still cross the irreversible boundary. leaseNext is gated, beginDispatch
//      is not, so the "no second post while one is unaccounted for" guarantee
//      is bypassed by a concurrent in-flight prepare().
//  R2  Guard errors thrown by beginDispatch escape dispatchNext and strand the
//      item in 'leased': invisible in both listQueued and listRecovery.
//  R3  preDispatchFailureCount is incremented but never enforced, so an
//      unclassified poison item retries forever.
//  R4  store.markPublished accepts blank proof (defense in depth is missing;
//      it is called directly by manual recovery paths).
//  R5  An expired lease under a STILL-ACTIVE run is never reclaimed.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkflowStore } = require('../dev/automation/workflowStore');
const { dispatchNext } = require('../dev/automation/publishWorkflow');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xposter-gap-'));

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

// R1 — the concurrency case the previous test missed entirely.
async function inFlightLeaseCannotCrossBoundaryAfterAmbiguity() {
  const store = freshStore('inflight');
  try {
    const a = ctx(store, 'a');
    const b = ctx(store, 'b');
    store.enqueue({ items: [{ text: 'first' }, { text: 'second' }], requestId: 'e1' });

    // B leases and parks inside prepare() BEFORE any ambiguity exists.
    let releaseB;
    const bParked = new Promise((resolve) => { releaseB = resolve; });
    let bTransportCalls = 0;
    const bPromise = dispatchNext({
      store,
      profileId: b.profileId,
      runId: b.runId,
      leaseMs: 60_000,
      prepare: async (item) => { await bParked; return { renderedText: item.payload.text }; },
      dispatch: async () => { bTransportCalls += 1; return { confirmed: true, externalId: 'b-1' }; },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Meanwhile A crosses the boundary and ends unresolved.
    const aResult = await dispatchNext({
      store,
      profileId: a.profileId,
      runId: a.runId,
      prepare: (item) => ({ renderedText: item.payload.text }),
      dispatch: async () => { throw new Error('rejected after keystroke'); },
    });
    assert.strictEqual(aResult.status, 'ambiguous_post_dispatch');
    assert.strictEqual(store.countUnresolvedRecovery(), 1);

    // B resumes. It must NOT publish while A is unaccounted for.
    releaseB();
    const bResult = await bPromise;

    assert.strictEqual(bTransportCalls, 0,
      'an in-flight worker must not reach the transport once recovery is required');
    assert.notStrictEqual(bResult.status, 'confirmed',
      'a second post must never go out while a previous one is unresolved');
    assert.strictEqual(store.countUnresolvedRecovery(), 1,
      'the blocked worker must not create a second unresolved dispatch');
    // And it must not vanish: it is either back in the queue or explicitly held.
    const bItem = store.getItem(bResult.item ? bResult.item.id : bResult.id);
    assert.ok(['queued', 'deferred'].includes(bItem.state),
      `a blocked pre-boundary item must stay recoverable, got ${bItem.state}`);
  } finally {
    store.close();
  }
}

// R2 — a boundary guard must never strand the item outside every view.
async function guardFailureNeverStrandsItem() {
  const store = freshStore('strand');
  try {
    const { profileId, runId } = ctx(store, 'strand');
    const mediaPath = path.join(root, 'strand.png');
    fs.writeFileSync(mediaPath, crypto.randomBytes(48));
    const enqueued = store.enqueue({
      items: [{ text: 'corrupt media', media_path: mediaPath }],
      requestId: 'e1',
    }).items[0];

    // Corrupt the managed blob so the pre-boundary integrity guard fires.
    fs.writeFileSync(store.getItem(enqueued.id).media[0].managedPath, Buffer.from('tampered'));

    let transportCalls = 0;
    const result = await dispatchNext({
      store,
      profileId,
      runId,
      prepare: (item) => ({ renderedText: item.payload.text }),
      dispatch: async () => { transportCalls += 1; },
    });

    assert.strictEqual(transportCalls, 0, 'corrupt media must never reach the transport');
    const item = store.getItem(enqueued.id);
    assert.notStrictEqual(item.state, 'leased',
      'a boundary guard failure must not leave the item stranded in leased');
    // Locally provable corruption cannot fix itself, so it must be terminal.
    assert.strictEqual(item.state, 'dead');
    assert.strictEqual(result.status, 'terminal_error_pre_dispatch');
    assert.strictEqual(store.countUnresolvedRecovery(), 0,
      'a pre-boundary failure is not an irreversible ambiguity');
  } finally {
    store.close();
  }
}

// R3 — an unclassified poison item must eventually stop consuming the queue.
async function repeatedRetryableFailuresBecomeTerminal() {
  const store = freshStore('poison');
  try {
    const { profileId, runId } = ctx(store, 'poison');
    store.enqueue({ items: [{ text: 'poison' }], requestId: 'e1' });

    let lastResult = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      lastResult = await dispatchNext({
        store,
        profileId,
        runId,
        backoffMs: 0,
        prepare: () => { throw new Error('transient-looking but permanent'); },
        dispatch: async () => { throw new Error('must never dispatch'); },
      });
      if (lastResult.status === 'empty') break;
    }

    const items = store.listItems({ states: ['dead'], limit: 10 });
    assert.strictEqual(items.length, 1,
      'an item failing preparation repeatedly must end terminal, not retry forever');
    assert.ok(items[0].preDispatchFailureCount >= 5);
  } finally {
    store.close();
  }
}

// R4 — defense in depth at the store layer, not only in the orchestrator.
function storeRejectsBlankPublicationProof() {
  const store = freshStore('proof-store');
  try {
    const { profileId, runId } = ctx(store, 'proof-store');
    store.enqueue({ items: [{ text: 'needs proof' }], requestId: 'e1' });
    const leased = store.leaseNext({ profileId, runId });
    const attempt = store.beginDispatch({
      id: leased.id,
      leaseToken: leased.leaseToken,
      renderedText: 'needs proof',
      requestId: 'begin-1',
    });

    assert.throws(
      () => store.markPublished({
        attemptId: attempt.attemptId,
        externalId: '   ',
        externalUrl: '',
        evidence: { confirmed: true },
        requestId: 'publish-blank',
      }),
      (error) => error.code === 'PROOF_REQUIRED',
      'the store itself must refuse to tombstone an item without authoritative proof',
    );
    assert.strictEqual(store.getItem(leased.id).state, 'dispatch_started');
  } finally {
    store.close();
  }
}

// R5 — an expired lease is pre-boundary by definition; run liveness is irrelevant.
function expiredLeaseUnderActiveRunIsReclaimed() {
  const store = freshStore('expired-active');
  try {
    const { profileId, runId } = ctx(store, 'expired-active');
    store.enqueue({ items: [{ text: 'expired under active run' }], requestId: 'e1' });

    const leased = store.leaseNext({ profileId, runId, leaseMs: 1 });
    assert.strictEqual(leased.state, 'leased');
    // Run stays ACTIVE — this is the common real-world case.
    const reclaimed = store.reclaimExpiredLeases({ requestId: 'reclaim-1', graceMs: 0 });
    assert.strictEqual(reclaimed.reclaimedIds.length, 1,
      'an expired lease must be reclaimable even while its run is still active');
    assert.strictEqual(store.getItem(leased.id).state, 'queued');
  } finally {
    store.close();
  }
}

async function main() {
  await inFlightLeaseCannotCrossBoundaryAfterAmbiguity();
  await guardFailureNeverStrandsItem();
  await repeatedRetryableFailuresBecomeTerminal();
  storeRejectsBlankPublicationProof();
  expiredLeaseUnderActiveRunIsReclaimed();
  console.log('✅ workflow review gaps: in-flight boundary gate, no stranding, failure cap, store-level proof, lease reclaim');
}

main()
  .then(() => fs.rmSync(root, { recursive: true, force: true }))
  .catch((error) => {
    fs.rmSync(root, { recursive: true, force: true });
    console.error(error);
    process.exit(1);
  });
