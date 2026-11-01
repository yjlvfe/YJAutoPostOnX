'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { WorkflowStore } = require('../dev/automation/workflowStore');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xposter-workflow-faults-'));
const dbPath = path.join(root, 'workflow.sqlite');
let store;
let lockDb;
try {
  store = new WorkflowStore({ rootDir: root, busyTimeoutMs: 25 });
  const profile = store.createProfile({ name: 'Default', requestId: 'fault-profile' });
  const run = store.startRun({ requestId: 'fault-run' });
  const [lockedItem, leasedCrashItem, dispatchCrashItem] = store.enqueue({
    items: [
      { text: 'locked transition', media_path: null },
      { text: 'lease crash', media_path: null },
      { text: 'dispatch crash', media_path: null },
    ],
    requestId: 'fault-items',
  }).items.map(row => store.getItem(row.id));

  lockDb = new Database(dbPath);
  lockDb.pragma('busy_timeout = 0');
  lockDb.exec('BEGIN IMMEDIATE');
  assert.throws(
    () => store.discardQueued({
      id: lockedItem.id,
      expectedRevision: lockedItem.revision,
      requestId: 'discard-while-locked',
    }),
    (error) => error && (error.code === 'SQLITE_BUSY' || /locked/i.test(error.message)),
  );
  assert.strictEqual(store.getItem(lockedItem.id).state, 'queued');
  assert.strictEqual(store.getItem(lockedItem.id).revision, lockedItem.revision);
  lockDb.exec('ROLLBACK');
  lockDb.close();
  lockDb = null;

  const leaseOne = store.leaseNext({ profileId: profile.id, runId: run.id, leaseMs: 60_000 });
  assert.strictEqual(leaseOne.id, lockedItem.id);
  // Discard the first item through the worker-safe pre-dispatch path so the next
  // two fixtures can model a lease-only crash and a post-boundary crash.
  store.releasePreDispatch({
    id: leaseOne.id,
    leaseToken: leaseOne.leaseToken,
    reason: 'skip_fixture',
    requestId: 'release-first',
  });
  store.discardQueued({
    id: leaseOne.id,
    expectedRevision: store.getItem(leaseOne.id).revision,
    requestId: 'discard-first-after-release',
  });

  const leaseOnly = store.leaseNext({ profileId: profile.id, runId: run.id, leaseMs: 60_000 });
  assert.strictEqual(leaseOnly.id, leasedCrashItem.id);
  const dispatchLease = store.leaseNext({ profileId: profile.id, runId: run.id, leaseMs: 60_000 });
  assert.strictEqual(dispatchLease.id, dispatchCrashItem.id);
  store.beginDispatch({
    id: dispatchLease.id,
    leaseToken: dispatchLease.leaseToken,
    renderedText: dispatchCrashItem.payload.text,
    requestId: 'begin-before-crash',
  });

  store.close();
  store = new WorkflowStore({ rootDir: root, busyTimeoutMs: 25 });
  const reconciliation = store.reconcileStartup({ requestId: 'startup-reconcile' });
  assert.ok(reconciliation.requeuedLeaseIds.includes(leasedCrashItem.id));
  assert.ok(reconciliation.ambiguousIds.includes(dispatchCrashItem.id));
  assert.strictEqual(store.getItem(leasedCrashItem.id).state, 'queued');
  assert.strictEqual(store.getItem(dispatchCrashItem.id).state, 'ambiguous');
  assert.strictEqual(store.listRecovery({ includeClosed: false }).length, 1);
  assert.strictEqual(store.integrityCheck().ok, true);

  console.log('✅ workflow fault gates: SQLITE_BUSY atomicity and restart reconciliation passed');
} finally {
  if (lockDb) {
    try { lockDb.exec('ROLLBACK'); } catch {}
    lockDb.close();
  }
  if (store) store.close();
  fs.rmSync(root, { recursive: true, force: true });
}
