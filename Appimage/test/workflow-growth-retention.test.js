'use strict';

// RED->GREEN gates for the long-term growth findings of the adversarial review:
//  P1  a failed enqueue leaves managed media bytes with no referencing row and
//      no way to ever reclaim them (measured: silent, unbounded disk growth)
//  P2  api_requests dominates DB growth (53.5% at 200 posts, ~102MB at 10k)
//      because it stores a full duplicate copy of every response
//  P4  cleanup errors in _stageMedia's finally block mask the real error
//  P5  item/attempt split-brain is invisible to integrityCheck

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { WorkflowStore } = require('../dev/automation/workflowStore');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xposter-growth-'));

function freshStore(name, options = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return new WorkflowStore({ rootDir: dir, ...options });
}

function ctx(store, label) {
  const profile = store.createProfile({ name: `P-${label}`, requestId: `p-${label}` });
  const run = store.startRun({ requestId: `r-${label}` });
  return { profileId: profile.id, runId: run.id };
}

// P1 — orphaned media must be detectable and reclaimable.
function orphanMediaIsDetectedAndSwept() {
  const store = freshStore('orphans', { busyTimeoutMs: 50 });
  const blocker = new Database(store.dbPath);
  try {
    const picture = path.join(root, 'orphan.png');
    fs.writeFileSync(picture, crypto.randomBytes(96));

    // Hold a write lock so the enqueue transaction cannot commit.
    blocker.pragma('busy_timeout = 50');
    blocker.exec('BEGIN IMMEDIATE');

    assert.throws(
      () => store.enqueue({ items: [{ text: 'x', media_path: picture }], requestId: 'e1' }),
      (error) => /SQLITE_BUSY/.test(error.code || error.message),
    );
    blocker.exec('ROLLBACK');

    assert.strictEqual(store.listItems({ states: ['queued'], limit: 10 }).length, 0);

    const report = store.integrityCheck();
    assert.strictEqual(report.orphanedMediaFiles.length, 1,
      'integrityCheck must surface media bytes that no row references');
    assert.strictEqual(report.ok, false, 'a leaked blob must not be reported as healthy');

    // A young orphan is protected: a concurrent enqueue may be mid-commit.
    const untouched = store.sweepOrphanMedia({ graceMs: 3_600_000 });
    assert.strictEqual(untouched.deleted.length, 0,
      'the grace period must protect blobs from an in-flight enqueue');

    const swept = store.sweepOrphanMedia({ graceMs: 0 });
    assert.strictEqual(swept.deleted.length, 1);
    assert.ok(swept.reclaimedBytes >= 96);
    assert.strictEqual(store.integrityCheck().orphanedMediaFiles.length, 0);
  } finally {
    try { blocker.close(); } catch { /* already closed */ }
    store.close();
  }
}

// P1b — a live blob must never be swept.
function sweepNeverTouchesReferencedMedia() {
  const store = freshStore('sweep-safe');
  try {
    const picture = path.join(root, 'kept.png');
    fs.writeFileSync(picture, crypto.randomBytes(64));
    const item = store.enqueue({
      items: [{ text: 'keep', media_path: picture }],
      requestId: 'e1',
    }).items[0];
    const managedPath = store.getItem(item.id).media[0].managedPath;

    const swept = store.sweepOrphanMedia({ graceMs: 0 });
    assert.strictEqual(swept.deleted.length, 0, 'a referenced blob must never be swept');
    assert.ok(fs.existsSync(managedPath));
    assert.strictEqual(store.integrityCheck().ok, true);
  } finally {
    store.close();
  }
}

// P2 — idempotency records must be prunable, or the DB grows without bound.
function idempotencyRecordsArePrunable() {
  const store = freshStore('prune');
  try {
    const { profileId, runId } = ctx(store, 'prune');
    for (let i = 0; i < 20; i += 1) {
      store.enqueue({ items: [{ text: `post ${i}` }], requestId: `enqueue-${i}` });
    }
    // Complete one item fully so terminal records exist.
    const leased = store.leaseNext({ profileId, runId });
    const attempt = store.beginDispatch({
      id: leased.id,
      leaseToken: leased.leaseToken,
      renderedText: 'post 0',
      requestId: 'begin-0',
    });
    store.markPublished({
      attemptId: attempt.attemptId,
      externalUrl: 'https://x.com/status/1',
      evidence: { confirmed: true },
      requestId: 'publish-0',
    });

    const before = store.db.prepare('SELECT COUNT(*) AS n FROM api_requests').get().n;
    assert.ok(before >= 20);

    // Records are immutable, so age the window instead of rewriting rows:
    // ask what would be prunable 30 days from now.
    const future = Date.now() + (30 * 86_400_000);
    const pruned = store.pruneIdempotency({ olderThanMs: 7 * 86_400_000, now: future });
    assert.ok(pruned.deleted >= before,
      'aged idempotency records must be reclaimable');
    assert.strictEqual(store.db.prepare('SELECT COUNT(*) AS n FROM api_requests').get().n, 0);

    // Pruning must not damage durable state or the audit trail.
    assert.strictEqual(store.getItem(leased.id).state, 'published');
    assert.strictEqual(store.integrityCheck().ok, true);

    // A fresh request still replays correctly after pruning.
    const first = store.enqueue({ items: [{ text: 'after prune' }], requestId: 'post-prune' });
    const replay = store.enqueue({ items: [{ text: 'after prune' }], requestId: 'post-prune' });
    assert.deepStrictEqual(replay, first);
  } finally {
    store.close();
  }
}

// P2b — recent records must survive so idempotent retry still works.
function pruneKeepsRecentRecords() {
  const store = freshStore('prune-recent');
  try {
    const created = store.enqueue({ items: [{ text: 'recent' }], requestId: 'recent-1' });
    const pruned = store.pruneIdempotency({ olderThanMs: 7 * 86_400_000 });
    assert.strictEqual(pruned.deleted, 0, 'recent idempotency records must be kept');
    assert.deepStrictEqual(
      store.enqueue({ items: [{ text: 'recent' }], requestId: 'recent-1' }),
      created,
    );
  } finally {
    store.close();
  }
}

// P4 — a cleanup failure must not replace the real error.
function cleanupFailureDoesNotMaskRealError() {
  const store = freshStore('mask');
  const realUnlink = fs.unlinkSync;
  try {
    const missing = path.join(root, 'definitely-missing.png');
    fs.unlinkSync = function patched(target) {
      // Simulate antivirus/backup software holding the temp file.
      if (String(target).includes('.tmp')) {
        const error = new Error('EPERM: operation not permitted, unlink');
        error.code = 'EPERM';
        throw error;
      }
      return realUnlink.call(this, target);
    };

    let caught = null;
    try {
      store.enqueue({ items: [{ text: 'x', media_path: missing }], requestId: 'e1' });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught, 'a missing source must fail the enqueue');
    assert.notStrictEqual(caught.code, 'EPERM',
      'a cleanup EPERM must not mask the real media error');
  } finally {
    fs.unlinkSync = realUnlink;
    store.close();
  }
}

// P5 — split-brain must be visible before the next restart.
function splitBrainIsDetected() {
  const store = freshStore('split');
  try {
    const { profileId, runId } = ctx(store, 'split');
    store.enqueue({ items: [{ text: 'split' }], requestId: 'e1' });
    const leased = store.leaseNext({ profileId, runId });
    const attempt = store.beginDispatch({
      id: leased.id,
      leaseToken: leased.leaseToken,
      renderedText: 'split',
      requestId: 'begin-1',
    });

    assert.strictEqual(store.integrityCheck().ok, true);

    // Desynchronize only the attempt side, as raw SQL or an old build would.
    store.db.prepare(`
      UPDATE dispatch_attempts SET phase = 'published', resolution_at_ms = ? WHERE id = ?
    `).run(Date.now(), attempt.attemptId);

    const report = store.integrityCheck();
    assert.strictEqual(report.ok, false, 'split-brain must not be reported as healthy');
    assert.strictEqual(report.stateConsistencyViolations.length, 1);
    assert.strictEqual(report.stateConsistencyViolations[0].itemId, leased.id);
  } finally {
    store.close();
  }
}

orphanMediaIsDetectedAndSwept();
sweepNeverTouchesReferencedMedia();
idempotencyRecordsArePrunable();
pruneKeepsRecentRecords();
cleanupFailureDoesNotMaskRealError();
splitBrainIsDetected();
fs.rmSync(root, { recursive: true, force: true });
console.log('✅ workflow growth: orphan media GC, idempotency pruning, unmasked errors, split-brain detection');
