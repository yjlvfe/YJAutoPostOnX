'use strict';

// RED->GREEN gates for the high/medium findings of the two independent reviews:
//  H1  empty external identifiers must never count as confirmed publication
//  H2  preparation outcomes must be classified (cancel / retryable / terminal)
//  #1  a closed run or deleted profile must not cross the dispatch boundary
//  #4  managed media must be verified BEFORE the irreversible boundary
//  M5  eligible deferred items must be discardable
//  M2  markDeferred must stay idempotent when availableAtMs is omitted
//  #8  keyset pagination must not skip rows sharing a timestamp

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkflowStore } = require('../dev/automation/workflowStore');
const { dispatchNext } = require('../dev/automation/publishWorkflow');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xposter-hardening-'));
const media = path.join(root, 'photo.png');
fs.writeFileSync(media, crypto.randomBytes(64));

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

async function emptyProofIsNeverConfirmed() {
  const store = freshStore('proof');
  try {
    const { profileId, runId } = ctx(store, 'proof');
    store.enqueue({ items: [{ text: 'needs real proof' }], requestId: 'e1' });

    const result = await dispatchNext({
      store,
      profileId,
      runId,
      prepare: (item) => ({ renderedText: item.payload.text }),
      dispatch: async () => ({ confirmed: true, externalUrl: '   ', externalId: '' }),
    });

    assert.strictEqual(result.status, 'ambiguous_post_dispatch',
      'blank external identifiers are not authoritative proof of publication');
    assert.strictEqual(store.getItem(result.item.id).state, 'ambiguous');
  } finally {
    store.close();
  }
}

async function preparationOutcomesAreClassified() {
  // Terminal preparation error -> dead, never auto-retried.
  const terminalStore = freshStore('terminal');
  try {
    const { profileId, runId } = ctx(terminalStore, 'terminal');
    terminalStore.enqueue({ items: [{ text: 'poison' }], requestId: 'e1' });
    const poison = new Error('payload can never render');
    poison.classification = 'terminal';

    const first = await dispatchNext({
      store: terminalStore,
      profileId,
      runId,
      prepare: () => { throw poison; },
      dispatch: async () => { throw new Error('must never dispatch'); },
    });
    assert.strictEqual(first.status, 'terminal_error_pre_dispatch');
    assert.strictEqual(terminalStore.getItem(first.item.id).state, 'dead');

    const second = await dispatchNext({
      store: terminalStore,
      profileId,
      runId,
      prepare: () => { throw poison; },
      dispatch: async () => { throw new Error('must never dispatch'); },
    });
    assert.strictEqual(second.status, 'empty', 'a dead item must not be leased again');
  } finally {
    terminalStore.close();
  }

  // Retryable preparation error -> deferred with future availability (backoff).
  const retryStore = freshStore('retry');
  try {
    const { profileId, runId } = ctx(retryStore, 'retry');
    retryStore.enqueue({ items: [{ text: 'temporary' }], requestId: 'e1' });
    const flaky = new Error('network hiccup');
    flaky.classification = 'retryable';

    const result = await dispatchNext({
      store: retryStore,
      profileId,
      runId,
      prepare: () => { throw flaky; },
      dispatch: async () => { throw new Error('must never dispatch'); },
    });
    assert.strictEqual(result.status, 'retryable_error_pre_dispatch');
    const item = retryStore.getItem(result.item.id);
    assert.strictEqual(item.state, 'deferred');
    assert.ok(item.availableAtMs > Date.now(), 'a retryable failure must back off into the future');
    assert.strictEqual(retryStore.listQueued({ limit: 10 }).length, 0,
      'a backed-off item must not be immediately eligible');
  } finally {
    retryStore.close();
  }

  // Cancellation is an operator action, not a platform failure.
  const cancelStore = freshStore('cancel');
  try {
    const { profileId, runId } = ctx(cancelStore, 'cancel');
    cancelStore.enqueue({ items: [{ text: 'stopped' }], requestId: 'e1' });
    let cancelled = false;

    const result = await dispatchNext({
      store: cancelStore,
      profileId,
      runId,
      isCancelled: () => cancelled,
      prepare: () => { cancelled = true; throw new Error('aborted by Stop'); },
      dispatch: async () => { throw new Error('must never dispatch'); },
    });
    assert.strictEqual(result.status, 'cancelled_pre_dispatch');
    const item = cancelStore.getItem(result.item.id);
    assert.strictEqual(item.state, 'queued');
    assert.strictEqual(item.preDispatchFailureCount, 0,
      'Stop must not be accounted as a publishing failure');
  } finally {
    cancelStore.close();
  }
}

function closedRunAndDeletedProfileCannotCrossBoundary() {
  const store = freshStore('boundary');
  try {
    const { profileId, runId } = ctx(store, 'boundary');
    store.enqueue({ items: [{ text: 'a' }, { text: 'b' }], requestId: 'e1' });

    const leasedA = store.leaseNext({ profileId, runId });
    store.finishRun({ runId, status: 'closed', requestId: 'finish' });
    assert.throws(
      () => store.beginDispatch({
        id: leasedA.id,
        leaseToken: leasedA.leaseToken,
        renderedText: 'a',
        requestId: 'begin-a',
      }),
      (error) => error.code === 'RUN_NOT_ACTIVE',
      'a run closed during preparation must block the irreversible boundary',
    );
    assert.notStrictEqual(store.getItem(leasedA.id).state, 'dispatch_started');

    const run2 = store.startRun({ requestId: 'r2' });
    const leasedB = store.leaseNext({ profileId, runId: run2.id });
    store.softDeleteProfile({ profileId, requestId: 'del' });
    assert.throws(
      () => store.beginDispatch({
        id: leasedB.id,
        leaseToken: leasedB.leaseToken,
        renderedText: 'b',
        requestId: 'begin-b',
      }),
      (error) => error.code === 'PROFILE_NOT_ACTIVE',
      'a profile deleted during preparation must block the irreversible boundary',
    );
    assert.notStrictEqual(store.getItem(leasedB.id).state, 'dispatch_started');
  } finally {
    store.close();
  }
}

function corruptManagedMediaFailsBeforeBoundary() {
  const store = freshStore('media-gate');
  try {
    const { profileId, runId } = ctx(store, 'media-gate');
    const enqueued = store.enqueue({
      items: [{ text: 'with media', media_path: media }],
      requestId: 'e1',
    }).items[0];

    const stored = store.getItem(enqueued.id).media[0];
    const managedPath = stored.managedPath;
    assert.ok(fs.existsSync(managedPath), 'managed media must exist after enqueue');

    // INTACT media must pass the guard. This is the regression that matters
    // most: a broken comparison here blocks every legitimate media post.
    const okLease = store.leaseNext({ profileId, runId });
    const okAttempt = store.beginDispatch({
      id: okLease.id,
      leaseToken: okLease.leaseToken,
      renderedText: 'with media',
      requestId: 'begin-intact',
    });
    assert.strictEqual(store.getItem(enqueued.id).state, 'dispatch_started',
      'intact managed media must cross the boundary normally');
    store.markPublished({
      attemptId: okAttempt.attemptId,
      externalUrl: 'https://x.com/status/7',
      evidence: { confirmed: true },
      requestId: 'publish-intact',
    });

    // Now corrupt a fresh item's blob and prove the guard fires.
    const second = store.enqueue({
      items: [{ text: 'second media', media_path: media }],
      requestId: 'e2',
    }).items[0];
    const secondPath = store.getItem(second.id).media[0].managedPath;
    fs.writeFileSync(secondPath, Buffer.from('tampered bytes'));

    const leased = store.leaseNext({ profileId, runId });
    assert.throws(
      () => store.beginDispatch({
        id: leased.id,
        leaseToken: leased.leaseToken,
        renderedText: 'second media',
        requestId: 'begin-media',
      }),
      (error) => error.code === 'MEDIA_INTEGRITY_FAILED',
      'tampered managed media must fail before the irreversible boundary',
    );
    assert.notStrictEqual(store.getItem(second.id).state, 'dispatch_started');
  } finally {
    store.close();
  }
}

function eligibleDeferredItemsAreDiscardable() {
  const store = freshStore('discard');
  try {
    const { profileId, runId } = ctx(store, 'discard');
    store.enqueue({ items: [{ text: 'deferrable' }], requestId: 'e1' });
    const leased = store.leaseNext({ profileId, runId });
    const deferred = store.markDeferred({
      id: leased.id,
      leaseToken: leased.leaseToken,
      reason: 'temporary',
      availableAtMs: Date.now(),
      requestId: 'defer-1',
    });
    assert.strictEqual(deferred.state, 'deferred');

    const discarded = store.discardQueued({
      id: deferred.id,
      expectedRevision: deferred.revision,
      requestId: 'discard-1',
    });
    assert.strictEqual(discarded.state, 'discarded');
    assert.strictEqual(store.leaseNext({ profileId, runId }), null,
      'a discarded item must never be resurrected');
  } finally {
    store.close();
  }
}

function deferDefaultStaysIdempotent() {
  const store = freshStore('idem');
  try {
    const { profileId, runId } = ctx(store, 'idem');
    store.enqueue({ items: [{ text: 'idem' }], requestId: 'e1' });
    const leased = store.leaseNext({ profileId, runId });

    const first = store.markDeferred({
      id: leased.id,
      leaseToken: leased.leaseToken,
      reason: 'temporary',
      requestId: 'defer-same',
    });
    const replay = store.markDeferred({
      id: leased.id,
      leaseToken: leased.leaseToken,
      reason: 'temporary',
      requestId: 'defer-same',
    });
    assert.deepStrictEqual(replay, first,
      'replaying the same request id with an omitted default must return the stored response');
  } finally {
    store.close();
  }
}

function paginationDoesNotSkipTimestampTies() {
  const store = freshStore('paging');
  try {
    store.enqueue({
      items: [{ text: 'p1' }, { text: 'p2' }, { text: 'p3' }],
      requestId: 'e1',
    });
    const stamp = Date.now();
    store.db.prepare('UPDATE workflow_items SET updated_at_ms = ?').run(stamp);

    const seen = new Set();
    let cursor = null;
    for (let page = 0; page < 5; page += 1) {
      const rows = store.listItems({ states: ['queued'], limit: 1, after: cursor });
      if (rows.length === 0) break;
      for (const row of rows) seen.add(row.payload.text);
      cursor = { updatedAtMs: rows[rows.length - 1].updatedAtMs, id: rows[rows.length - 1].id };
    }
    assert.deepStrictEqual([...seen].sort(), ['p1', 'p2', 'p3'],
      'keyset pagination must not skip rows that share a timestamp');
  } finally {
    store.close();
  }
}

async function main() {
  await emptyProofIsNeverConfirmed();
  await preparationOutcomesAreClassified();
  closedRunAndDeletedProfileCannotCrossBoundary();
  corruptManagedMediaFailsBeforeBoundary();
  eligibleDeferredItemsAreDiscardable();
  deferDefaultStaysIdempotent();
  paginationDoesNotSkipTimestampTies();
  console.log('✅ workflow hardening: proof, classification, boundary guards, media, discard, idempotency, paging passed');
}

main()
  .then(() => fs.rmSync(root, { recursive: true, force: true }))
  .catch((error) => {
    fs.rmSync(root, { recursive: true, force: true });
    console.error(error);
    process.exit(1);
  });
