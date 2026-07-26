'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkflowStore } = require('../dev/automation/workflowStore');
const { dispatchNext } = require('./helpers/dispatchDriver');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xposter-workflow-cross-profile-'));
let store;
(async () => {
  try {
    store = new WorkflowStore({ rootDir: root });
    const profileA = store.createProfile({ name: '2- A', requestId: 'profile-a' });
    const profileB = store.createProfile({ name: '3- B', requestId: 'profile-b' });
    const runA = store.startRun({ requestId: 'run-a' });
    const runB = store.startRun({ requestId: 'run-b' });
    const item = store.enqueue({
      items: [{ text: 'global item attempted by A', media_path: null }],
      requestId: 'enqueue-cross-profile',
    }).items[0];

    const leaseA = store.leaseNext({ profileId: profileA.id, runId: runA.id, leaseMs: 60_000 });
    const attemptA = store.beginDispatch({
      id: item.id,
      leaseToken: leaseA.leaseToken,
      renderedText: item.payload.text,
      requestId: 'dispatch-a',
    });
    store.markAmbiguous({
      attemptId: attemptA.attemptId,
      reason: 'crash_after_dispatch',
      requestId: 'ambiguous-a',
    });

    let dispatchesByB = 0;
    const resultB = await dispatchNext({
      store,
      profileId: profileB.id,
      runId: runB.id,
      prepare: async () => { throw new Error('B must not prepare A ambiguous item'); },
      dispatch: async () => { dispatchesByB += 1; },
    });
    // Must be an explicit recovery block, not an incidental "empty queue".
    assert.strictEqual(resultB.status, 'blocked');
    assert.strictEqual(resultB.reason, 'recovery_required');
    assert.strictEqual(dispatchesByB, 0);

    const globalRecovery = store.listRecovery({ includeClosed: false });
    assert.strictEqual(globalRecovery.length, 1);
    assert.strictEqual(globalRecovery[0].id, item.id);
    assert.strictEqual(globalRecovery[0].lastProfile.id, profileA.id);

    console.log('✅ workflow cross-profile recovery: A ambiguity blocks B and remains globally visible');
  } finally {
    if (store) store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
