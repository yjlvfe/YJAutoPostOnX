'use strict';

// Real process-crash durability.
//
// The reconciliation test in workflow-fault-injection.test.js uses a clean
// close() — which runs wal_checkpoint(TRUNCATE) — so it proves reopen, not
// crash recovery. This test SIGKILLs a child immediately after the irreversible
// boundary commits, leaving an un-checkpointed WAL behind, then verifies the
// parent recovers correctly.
//
// Without this, a future change (e.g. synchronous=NORMAL "for performance")
// would silently destroy the durability guarantee.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xposter-crash-'));
const storeModule = path.resolve(__dirname, '../dev/automation/workflowStore.js');
const childScript = path.join(root, 'crash-child.js');

fs.writeFileSync(childScript, `
'use strict';
const { WorkflowStore } = require(${JSON.stringify(storeModule)});
const store = new WorkflowStore({ rootDir: ${JSON.stringify(root)} });
const profile = store.createProfile({ name: 'Crash', requestId: 'p-crash' });
const run = store.startRun({ requestId: 'r-crash' });
store.enqueue({ items: [{ text: 'crash victim' }], requestId: 'e-crash' });
const leased = store.leaseNext({ profileId: profile.id, runId: run.id, leaseMs: 60000 });
const attempt = store.beginDispatch({
  id: leased.id,
  leaseToken: leased.leaseToken,
  renderedText: 'crash victim',
  requestId: 'begin-crash',
});
process.stdout.write(JSON.stringify({ itemId: leased.id, attemptId: attempt.attemptId }));
// Die exactly at the worst moment: the boundary is committed, the transport
// result is unknown, and nothing was checkpointed or closed.
process.kill(process.pid, 'SIGKILL');
`);

const electron = path.resolve(__dirname, '../node_modules/electron/dist/electron');
const child = spawnSync(electron, [childScript], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  encoding: 'utf8',
});

assert.strictEqual(child.signal, 'SIGKILL',
  `the child must actually be killed, got signal=${child.signal} status=${child.status}`);
const { itemId } = JSON.parse(child.stdout.trim());

// An un-checkpointed WAL is the whole point: it proves no clean shutdown ran.
const dbPath = path.join(root, 'workflow.sqlite');
const walPath = `${dbPath}-wal`;
assert.ok(fs.existsSync(walPath) && fs.statSync(walPath).size > 0,
  'a real crash must leave an un-checkpointed WAL behind');

const { WorkflowStore } = require('../dev/automation/workflowStore');
const store = new WorkflowStore({ rootDir: root });
try {
  // The committed boundary must have survived the kill.
  assert.strictEqual(store.getItem(itemId).state, 'dispatch_started',
    'the dispatch boundary must be durable across SIGKILL');

  const reconciliation = store.reconcileStartup({ requestId: 'startup-after-crash' });
  assert.ok(reconciliation.ambiguousIds.includes(itemId),
    'an item that crossed the boundary before the crash must become ambiguous');
  assert.deepStrictEqual(reconciliation.quarantinedIds, [],
    'a clean crash must not produce quarantined rows');

  const item = store.getItem(itemId);
  assert.strictEqual(item.state, 'ambiguous');
  assert.ok(item.currentAttempt, 'the attempted content must survive for manual reconciliation');
  assert.strictEqual(item.currentAttempt.renderedText, 'crash victim');

  assert.strictEqual(store.countUnresolvedRecovery(), 1,
    'the crashed dispatch must block further publishing until reconciled');

  const report = store.integrityCheck();
  assert.strictEqual(report.ok, true, `integrity must hold after a crash: ${JSON.stringify(report)}`);

  console.log('✅ workflow crash durability: SIGKILL leaves un-checkpointed WAL, recovery is correct');
} finally {
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
}
