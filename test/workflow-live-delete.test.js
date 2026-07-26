'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkflowStore } = require('../dev/automation/workflowStore');
const { dispatchNext } = require('./helpers/dispatchDriver');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xposter-workflow-live-delete-'));
let store;
(async () => {
  try {
    store = new WorkflowStore({ rootDir: root });
    const profile = store.createProfile({ name: 'Default', requestId: 'profile-live-delete' });
    const run = store.startRun({ requestId: 'run-live-delete' });
    const [a, b] = store.enqueue({
      items: [
        { text: 'A publishes', media_path: null },
        { text: 'B user deletes', media_path: null },
      ],
      requestId: 'enqueue-live-delete',
    }).items;

    const dispatchedTexts = [];
    const first = await dispatchNext({
      store,
      profileId: profile.id,
      runId: run.id,
      prepare: async (claimed) => {
        assert.strictEqual(claimed.id, a.id);
        const deleted = store.discardQueued({
          id: b.id,
          expectedRevision: b.revision,
          requestId: 'delete-b-while-a-is-leased',
        });
        assert.strictEqual(deleted.state, 'discarded');
        return { renderedText: claimed.payload.text };
      },
      dispatch: async ({ item }) => {
        dispatchedTexts.push(item.payload.text);
        return { confirmed: true, externalUrl: 'https://x.com/test/status/a' };
      },
    });
    assert.strictEqual(first.state, 'published');

    const second = await dispatchNext({
      store,
      profileId: profile.id,
      runId: run.id,
      prepare: async () => { throw new Error('deleted B must not be prepared'); },
      dispatch: async ({ item }) => { dispatchedTexts.push(item.payload.text); },
    });
    assert.strictEqual(second.status, 'empty');
    assert.deepStrictEqual(dispatchedTexts, ['A publishes']);
    assert.strictEqual(store.getItem(b.id).state, 'discarded');

    console.log('✅ workflow live delete: deleting future B while A runs prevents B dispatch');
  } finally {
    if (store) store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
