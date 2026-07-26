'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkflowStore } = require('../dev/automation/workflowStore');
const { dispatchNext } = require('./helpers/dispatchDriver');

function createHarness(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `xposter-dispatch-${label}-`));
  const store = new WorkflowStore({ rootDir: root });
  const profile = store.createProfile({ name: `profile-${label}`, requestId: `profile-${label}` });
  const run = store.startRun({ requestId: `run-${label}` });
  return {
    root,
    store,
    profile,
    run,
    cleanup() {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

async function deliveredThenRejected() {
  const h = createHarness('delivered-rejected');
  let dispatches = 0;
  try {
    const item = h.store.enqueue({
      items: [{ text: 'dispatch once', media_path: null }],
      requestId: 'enqueue-delivered-rejected',
    }).items[0];

    const result = await dispatchNext({
      store: h.store,
      profileId: h.profile.id,
      runId: h.run.id,
      prepare: async (claimed) => ({ renderedText: claimed.payload.text }),
      dispatch: async () => {
        dispatches += 1;
        throw new Error('transport promise rejected after remote accepted the shortcut');
      },
    });

    assert.strictEqual(dispatches, 1);
    assert.strictEqual(result.state, 'ambiguous');
    assert.strictEqual(h.store.getItem(item.id).state, 'ambiguous');

    const secondRun = await dispatchNext({
      store: h.store,
      profileId: h.profile.id,
      runId: h.run.id,
      prepare: async () => { throw new Error('must not prepare ambiguous item'); },
      dispatch: async () => { dispatches += 1; },
    });
    assert.strictEqual(secondRun.status, 'blocked');
    assert.strictEqual(secondRun.reason, 'recovery_required');
    assert.strictEqual(dispatches, 1, 'an ambiguous item must never auto-dispatch again');
  } finally {
    h.cleanup();
  }
}

async function stopBeforeDispatch() {
  const h = createHarness('stop-before');
  let dispatches = 0;
  try {
    const item = h.store.enqueue({
      items: [{ text: 'stop before', media_path: null }],
      requestId: 'enqueue-stop-before',
    }).items[0];

    const result = await dispatchNext({
      store: h.store,
      profileId: h.profile.id,
      runId: h.run.id,
      prepare: async (claimed) => ({ renderedText: claimed.payload.text }),
      dispatch: async () => { dispatches += 1; },
      isCancelled: () => true,
    });

    assert.strictEqual(dispatches, 0);
    assert.strictEqual(result.status, 'cancelled_pre_dispatch');
    assert.strictEqual(h.store.getItem(item.id).state, 'queued');
  } finally {
    h.cleanup();
  }
}

async function stopAfterDispatch() {
  const h = createHarness('stop-after');
  let dispatches = 0;
  let cancelled = false;
  try {
    const item = h.store.enqueue({
      items: [{ text: 'stop after', media_path: null }],
      requestId: 'enqueue-stop-after',
    }).items[0];

    const result = await dispatchNext({
      store: h.store,
      profileId: h.profile.id,
      runId: h.run.id,
      prepare: async (claimed) => ({ renderedText: claimed.payload.text }),
      dispatch: async () => {
        dispatches += 1;
        cancelled = true;
        throw new Error('context closed by stop after shortcut delivery');
      },
      isCancelled: () => cancelled,
    });

    assert.strictEqual(dispatches, 1);
    assert.strictEqual(result.status, 'cancelled_post_dispatch');
    assert.strictEqual(h.store.getItem(item.id).state, 'ambiguous');
  } finally {
    h.cleanup();
  }
}

async function confirmedPublication() {
  const h = createHarness('confirmed');
  let dispatches = 0;
  try {
    const item = h.store.enqueue({
      items: [{ text: 'confirmed post', media_path: null }],
      requestId: 'enqueue-confirmed',
    }).items[0];

    const result = await dispatchNext({
      store: h.store,
      profileId: h.profile.id,
      runId: h.run.id,
      prepare: async (claimed) => ({ renderedText: claimed.payload.text }),
      dispatch: async () => {
        dispatches += 1;
        return { confirmed: true, externalUrl: 'https://x.com/test/status/confirmed' };
      },
    });

    assert.strictEqual(dispatches, 1);
    assert.strictEqual(result.state, 'published');
    assert.strictEqual(h.store.getItem(item.id).state, 'published');
  } finally {
    h.cleanup();
  }
}

(async () => {
  await deliveredThenRejected();
  await stopBeforeDispatch();
  await stopAfterDispatch();
  await confirmedPublication();
  console.log('✅ publish workflow boundary: delivered rejection, Stop phases and confirmation passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
