'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { WorkflowStore, WorkflowConflictError } = require('../dev/automation/workflowStore');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xposter-workflow-state-'));
const dbPath = path.join(root, 'workflow.sqlite');
let store;

function expectConflict(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof WorkflowConflictError, `expected WorkflowConflictError, got ${error}`);
    assert.strictEqual(error.code, code);
    return true;
  });
}

try {
  store = new WorkflowStore({ rootDir: root });
  const profile = store.createProfile({ name: 'Default', requestId: 'profile-default' });
  const run = store.startRun({ requestId: 'run-1' });

  const payload = {
    text: 'durable item',
    media_path: null,
    metadata: { source: 'test' },
    options: { mode: 'strict' },
  };

  const firstEnqueue = store.enqueue({ items: [payload], requestId: 'enqueue-1' });
  const replayedEnqueue = store.enqueue({
    items: [{
      options: { mode: 'strict' },
      metadata: { source: 'test' },
      media_path: null,
      text: 'durable item',
    }],
    requestId: 'enqueue-1',
  });
  assert.deepStrictEqual(replayedEnqueue, firstEnqueue, 'same requestId must replay the same response');
  assert.strictEqual(store.listQueued({ limit: 100 }).length, 1, 'idempotent enqueue must not duplicate rows');
  expectConflict(
    () => store.enqueue({ items: [{ ...payload, text: 'different' }], requestId: 'enqueue-1' }),
    'IDEMPOTENCY_KEY_REUSED',
  );

  const item = store.getItem(firstEnqueue.items[0].id);
  assert.match(item.id, /^[0-9a-f-]{36}$/i);
  assert.deepStrictEqual(item.payload, payload);
  assert.strictEqual(item.state, 'queued');

  const lease = store.leaseNext({ profileId: profile.id, runId: run.id, leaseMs: 60_000 });
  assert.strictEqual(lease.id, item.id);
  assert.strictEqual(lease.state, 'leased');
  assert.ok(lease.leaseToken);

  const attempt = store.beginDispatch({
    id: item.id,
    leaseToken: lease.leaseToken,
    renderedText: 'durable item',
    requestId: 'dispatch-1',
  });
  assert.strictEqual(store.getItem(item.id).state, 'dispatch_started');
  const replayedAttempt = store.beginDispatch({
    renderedText: 'durable item',
    leaseToken: lease.leaseToken,
    id: item.id,
    requestId: 'dispatch-1',
  });
  assert.deepStrictEqual(replayedAttempt, attempt, 'same requestId must replay after state changed');
  expectConflict(
    () => store.beginDispatch({
      id: item.id,
      leaseToken: lease.leaseToken,
      renderedText: 'durable item',
      requestId: 'dispatch-2',
    }),
    'INVALID_STATE',
  );

  const ambiguous = store.markAmbiguous({
    attemptId: attempt.attemptId,
    reason: 'delivered_then_rejected',
    error: { message: 'transport promise rejected after delivery' },
    requestId: 'ambiguous-1',
  });
  assert.strictEqual(ambiguous.state, 'ambiguous');
  assert.strictEqual(store.listRecovery({ includeClosed: false })[0].id, item.id);
  expectConflict(
    () => store.resolveRecovery({ id: item.id, action: 'requeue', requestId: 'unsafe-requeue' }),
    'CONFIRMATION_REQUIRED',
  );

  const requeued = store.resolveRecovery({
    id: item.id,
    action: 'requeue',
    confirmedNotPublished: true,
    requestId: 'safe-requeue',
  });
  assert.strictEqual(requeued.state, 'queued');
  assert.deepStrictEqual(requeued.payload, payload, 'full payload must survive ambiguous recovery');

  const secondLease = store.leaseNext({ profileId: profile.id, runId: run.id, leaseMs: 60_000 });
  const secondAttempt = store.beginDispatch({
    id: item.id,
    leaseToken: secondLease.leaseToken,
    renderedText: 'durable item',
    requestId: 'dispatch-3',
  });
  const published = store.markPublished({
    attemptId: secondAttempt.attemptId,
    externalUrl: 'https://x.com/test/status/1',
    requestId: 'published-1',
  });
  assert.strictEqual(published.state, 'published');
  expectConflict(
    () => store.resolveRecovery({
      id: item.id,
      action: 'requeue',
      confirmedNotPublished: true,
      requestId: 'resurrect-published',
    }),
    'INVALID_STATE',
  );

  const queuedForDelete = store.enqueue({
    items: [{ text: 'delete me before dispatch', media_path: null }],
    requestId: 'enqueue-delete',
  }).items.map(row => store.getItem(row.id))[0];
  const discarded = store.discardQueued({
    id: queuedForDelete.id,
    expectedRevision: queuedForDelete.revision,
    requestId: 'discard-1',
  });
  assert.strictEqual(discarded.state, 'discarded');
  assert.ok(!store.listQueued({ limit: 100 }).some((row) => row.id === discarded.id));

  store.close();
  store = null;

  const raw = new Database(dbPath);
  try {
    assert.throws(
      () => raw.prepare('UPDATE workflow_items SET payload_json = ? WHERE id = ?')
        .run(JSON.stringify({ text: 'mutated' }), item.id),
      /immutable/i,
    );
    assert.throws(
      () => raw.prepare("UPDATE workflow_items SET state = 'queued' WHERE id = ?")
        .run(item.id),
      /invalid state transition/i,
    );
    assert.strictEqual(raw.pragma('quick_check', { simple: true }), 'ok');
    assert.deepStrictEqual(raw.pragma('foreign_key_check'), []);
  } finally {
    raw.close();
  }

  console.log('✅ workflow state machine: idempotency, CAS transitions, ambiguity and tombstones passed');
} finally {
  if (store) store.close();
  fs.rmSync(root, { recursive: true, force: true });
}
