'use strict';

// The five publish-outcome contracts, pinned at the STORE level:
//   * a published post leaves the queue and stays archived for dedup;
//   * a failed post is NOT consumed — it stays publishable;
//   * a repeatedly-failing post is eventually retired instead of blocking the head;
//   * an ambiguous outcome is never auto-retried and blocks publishing globally;
//   * stopping is not a failure and must not spend the retry budget.
//
// These are the invariants. queue-consume.test.js proves the other half — that
// xPoster's loop actually reaches these store operations at the right moments —
// by driving the real engine against a fake browser. Both are needed: a cutover
// can satisfy every invariant here while never calling any of it.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkflowStore } = require('../dev/automation/workflowStore');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xposter-outcomes-'));
let n = 0;

function fresh(label, options = {}) {
  const dir = path.join(root, `${label}-${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  const store = new WorkflowStore({ rootDir: dir, ...options });
  const profile = store.createProfile({ name: `P-${label}`, requestId: `p-${label}` });
  const run = store.startRun({ requestId: `r-${label}` });
  return { store, profileId: profile.id, runId: run.id };
}

/** Lease + commit the dispatch boundary, as xPoster does around Ctrl+Enter. */
function claimAndDispatch(store, profileId, runId, tag) {
  const item = store.leaseNext({ profileId, runId, leaseMs: 60_000 });
  assert.ok(item, 'expected an item to lease');
  const attempt = store.beginDispatch({
    id: item.id,
    leaseToken: item.leaseToken,
    renderedText: item.payload.text,
    requestId: `begin-${tag}-${item.id}`,
  });
  return { item, attempt };
}

function publishedLeavesQueueButStaysArchived() {
  const { store, profileId, runId } = fresh('published');
  try {
    store.enqueue({ items: [{ text: 'A' }, { text: 'B' }], requestId: 'e1' });
    const { item, attempt } = claimAndDispatch(store, profileId, runId, 'pub');

    store.markPublished({
      attemptId: attempt.attemptId,
      externalUrl: 'https://x.com/i/web/status/1',
      evidence: { ok: true },
      requestId: `pub-${item.id}`,
    });

    const queued = store.listQueued({ limit: 100 }).map((i) => i.payload.text);
    assert.deepStrictEqual(queued, ['B'], 'a published post must leave the queue');

    // The dedup corpus must outlive the queue entry, or the studio would happily
    // regenerate a tweet that is already live on X.
    const published = store.listItems({ states: ['published'], limit: 100 }).map((i) => i.payload.text);
    assert.deepStrictEqual(published, ['A'], 'a published post stays archived for dedup');

    console.log('  ✓ published leaves the queue and stays archived');
  } finally { store.close(); }
}

function failedPostIsNotConsumed() {
  const { store, profileId, runId } = fresh('deferred');
  try {
    store.enqueue({ items: [{ text: 'A' }], requestId: 'e1' });
    const item = store.leaseNext({ profileId, runId, leaseMs: 60_000 });

    // Pre-boundary network failure — nothing was submitted.
    store.markDeferred({
      id: item.id,
      leaseToken: item.leaseToken,
      reason: 'network_failure',
      requestId: `def-${item.id}`,
    });

    const queued = store.listQueued({ limit: 100 }).map((i) => i.payload.text);
    assert.deepStrictEqual(queued, ['A'], 'a failed post is still publishable — consumption follows success only');

    const archived = store.listItems({ states: ['published'], limit: 100 });
    assert.strictEqual(archived.length, 0, 'a post that never went out must not be archived as published');

    console.log('  ✓ a failed post stays in the queue and is not archived');
  } finally { store.close(); }
}

function repeatedFailureRetiresInsteadOfBlockingTheHead() {
  // maxPreDispatchFailures is the store's own retry budget — the replacement for
  // deferred-posts.json's attempt counter.
  const { store, profileId, runId } = fresh('retire', { maxPreDispatchFailures: 3 });
  try {
    store.enqueue({ items: [{ text: 'poison' }], requestId: 'e1' });

    let last = null;
    for (let i = 0; i < 3; i++) {
      const item = store.leaseNext({ profileId, runId, leaseMs: 60_000 });
      assert.ok(item, `expected the item to still be leasable on attempt ${i + 1}`);
      last = store.markDeferred({
        id: item.id,
        leaseToken: item.leaseToken,
        reason: 'network_failure',
        availableAtMs: Date.now() - 1,
        requestId: `def-${i}-${item.id}`,
      });
    }

    assert.strictEqual(last.state, 'dead',
      'a post that can never go out must be retired, not left blocking the queue head');
    assert.strictEqual(store.listQueued({ limit: 100 }).length, 0, 'the queue head is freed');

    console.log('  ✓ an exhausted post is retired to dead, freeing the queue head');
  } finally { store.close(); }
}

function ambiguousIsNeverAutoRetriedAndBlocksEveryProfile() {
  const { store, profileId, runId } = fresh('ambiguous');
  try {
    store.enqueue({ items: [{ text: 'A' }, { text: 'B' }], requestId: 'e1' });
    const { item, attempt } = claimAndDispatch(store, profileId, runId, 'amb');

    store.markAmbiguous({
      attemptId: attempt.attemptId,
      reason: 'ambiguous_publish_result',
      requestId: `amb-${item.id}`,
    });

    assert.strictEqual(store.countUnresolvedRecovery(), 1, 'the ambiguous item is unresolved');

    // The gate is GLOBAL: a second profile must not be able to publish either.
    const other = store.createProfile({ name: 'P-other', requestId: 'p-other' });
    const otherRun = store.startRun({ requestId: 'r-other' });
    assert.throws(
      () => store.leaseNext({ profileId: other.id, runId: otherRun.id, leaseMs: 60_000 }),
      (err) => err.code === 'RECOVERY_REQUIRED',
      'an unresolved dispatch must block publishing for EVERY profile, not just its own'
    );

    // It is visible to the operator without any limit window.
    assert.strictEqual(store.listRecovery().length, 1, 'the item is listed for manual resolution');

    console.log('  ✓ ambiguous blocks every profile and is never auto-retried');
  } finally { store.close(); }
}

function stoppingDoesNotSpendTheRetryBudget() {
  const { store, profileId, runId } = fresh('stop', { maxPreDispatchFailures: 2 });
  try {
    store.enqueue({ items: [{ text: 'A' }], requestId: 'e1' });

    // Stop pressed before the boundary, three times over. An operator action is
    // not a publishing failure, so the post must survive all of them.
    for (let i = 0; i < 3; i++) {
      const item = store.leaseNext({ profileId, runId, leaseMs: 60_000 });
      assert.ok(item, `stop ${i + 1}: the post must still be claimable`);
      store.releasePreDispatch({
        id: item.id,
        leaseToken: item.leaseToken,
        reason: 'stopped_by_user',
        countAsFailure: false,
        requestId: `rel-${i}-${item.id}`,
      });
    }

    const queued = store.listQueued({ limit: 100 }).map((i) => i.payload.text);
    assert.deepStrictEqual(queued, ['A'], 'stopping must never retire a post');

    console.log('  ✓ stopping is not a failure and never spends the retry budget');
  } finally { store.close(); }
}

const tests = [
  ['published leaves queue, stays archived', publishedLeavesQueueButStaysArchived],
  ['failed post not consumed', failedPostIsNotConsumed],
  ['exhausted post retired', repeatedFailureRetiresInsteadOfBlockingTheHead],
  ['ambiguous blocks globally', ambiguousIsNeverAutoRetriedAndBlocksEveryProfile],
  ['stop is not a failure', stoppingDoesNotSpendTheRetryBudget],
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}: ${error.message}`);
  }
}

try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }

if (failed > 0) {
  console.error(`\n❌ xposter durable outcomes: ${failed} failed`);
  process.exit(1);
}
console.log('✅ xposter durable outcomes: every publish-outcome contract holds in the store');
