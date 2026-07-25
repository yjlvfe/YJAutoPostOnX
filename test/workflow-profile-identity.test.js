'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkflowStore } = require('../dev/automation/workflowStore');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xposter-workflow-profile-'));
let store;
try {
  store = new WorkflowStore({ rootDir: root });
  const profile = store.createProfile({ name: '2- Original', requestId: 'profile-create' });
  const run = store.startRun({ requestId: 'profile-run' });
  const item = store.enqueue({
    items: [{ text: 'profile identity item', media_path: null }],
    requestId: 'profile-item',
  }).items[0];
  const lease = store.leaseNext({ profileId: profile.id, runId: run.id, leaseMs: 60_000 });
  const attempt = store.beginDispatch({
    id: item.id,
    leaseToken: lease.leaseToken,
    renderedText: item.payload.text,
    requestId: 'profile-dispatch',
  });
  store.markAmbiguous({
    attemptId: attempt.attemptId,
    reason: 'profile_identity_probe',
    requestId: 'profile-ambiguous',
  });

  const renamed = store.renameProfile({
    profileId: profile.id,
    newName: '2- Renamed',
    requestId: 'profile-rename',
  });
  assert.strictEqual(renamed.id, profile.id);
  assert.strictEqual(renamed.name, '2- Renamed');

  const deleted = store.softDeleteProfile({
    profileId: profile.id,
    requestId: 'profile-delete',
  });
  assert.strictEqual(deleted.id, profile.id);
  assert.strictEqual(deleted.status, 'deleted');

  const recovery = store.listRecovery({ includeClosed: false });
  assert.strictEqual(recovery.length, 1);
  assert.strictEqual(recovery[0].lastProfile.id, profile.id,
    'workflow ownership must retain immutable profile UUID after rename/delete');
  assert.strictEqual(recovery[0].lastProfile.name, '2- Renamed');
  assert.strictEqual(recovery[0].lastProfile.status, 'deleted');
  assert.strictEqual(store.integrityCheck().ok, true);

  console.log('✅ workflow profile identity: rename/delete preserve UUID ownership passed');
} finally {
  if (store) store.close();
  fs.rmSync(root, { recursive: true, force: true });
}
