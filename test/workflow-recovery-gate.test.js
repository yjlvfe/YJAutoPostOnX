'use strict';

// RED->GREEN gate for the blocker found by independent review:
// an unresolved (dispatch_started/ambiguous) item anywhere in the store must
// block EVERY automatic lease/dispatch, for every profile and run — not just
// the profile that created the ambiguity. Publishing is irreversible, so a
// second post must never go out while a previous one is unaccounted for.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkflowStore } = require('../dev/automation/workflowStore');
const { dispatchNext } = require('../dev/automation/publishWorkflow');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xposter-recovery-gate-'));
let store;

async function main() {
  store = new WorkflowStore({ rootDir: root });

  const profileA = store.createProfile({ name: 'A', requestId: 'p-a' });
  const profileB = store.createProfile({ name: 'B', requestId: 'p-b' });
  const runA = store.startRun({ requestId: 'run-a' });

  // Two independent items: the first becomes unresolved, the second must stay put.
  store.enqueue({
    items: [{ text: 'first post' }, { text: 'second post' }],
    requestId: 'seed',
  });

  // Drive item one across the irreversible boundary, then leave it ambiguous.
  const first = await dispatchNext({
    store,
    profileId: profileA.id,
    runId: runA.id,
    prepare: (item) => ({ renderedText: item.payload.text }),
    dispatch: async () => { throw new Error('transport rejected after keystroke'); },
  });
  assert.strictEqual(first.status, 'ambiguous_post_dispatch');
  assert.strictEqual(store.getItem(first.item.id).state, 'ambiguous');

  const unresolved = store.listRecovery();
  assert.strictEqual(unresolved.length, 1, 'the ambiguous item must be globally visible');

  // A different profile in a different run must be blocked, not merely empty.
  const runB = store.startRun({ requestId: 'run-b' });
  let prepareCalls = 0;
  let dispatchCalls = 0;
  const second = await dispatchNext({
    store,
    profileId: profileB.id,
    runId: runB.id,
    prepare: (item) => { prepareCalls += 1; return { renderedText: item.payload.text }; },
    dispatch: async () => { dispatchCalls += 1; return { confirmed: true, externalId: 'x' }; },
  });

  assert.strictEqual(second.status, 'blocked',
    'an unresolved dispatch must block every other automatic dispatch');
  assert.strictEqual(prepareCalls, 0, 'a blocked dispatch must not prepare anything');
  assert.strictEqual(dispatchCalls, 0, 'a blocked dispatch must never reach the transport');

  const stillQueued = store.listQueued({ limit: 10 });
  assert.strictEqual(stillQueued.length, 1, 'the second item must remain queued and untouched');
  assert.strictEqual(stillQueued[0].payload.text, 'second post');

  // leaseNext itself is the authoritative gate, not just the orchestration wrapper.
  assert.throws(
    () => store.leaseNext({ profileId: profileB.id, runId: runB.id }),
    (error) => error.code === 'RECOVERY_REQUIRED',
    'leaseNext must refuse while global recovery is unresolved',
  );

  // Once the operator resolves it, normal dispatch resumes. Confirming a real
  // publication goes through the ambiguous attempt with authoritative proof.
  store.markPublished({
    attemptId: store.getItem(first.item.id).currentAttemptId,
    externalUrl: 'https://x.com/status/1',
    evidence: { confirmed: true, source: 'manual_operator_check' },
    requestId: 'resolve-1',
  });
  assert.strictEqual(store.getItem(first.item.id).state, 'published');
  assert.strictEqual(store.listRecovery().length, 0);

  const resumed = await dispatchNext({
    store,
    profileId: profileB.id,
    runId: runB.id,
    prepare: (item) => ({ renderedText: item.payload.text }),
    dispatch: async () => ({ confirmed: true, externalUrl: 'https://x.com/status/2' }),
  });
  assert.strictEqual(resumed.status, 'confirmed');
  assert.strictEqual(store.getItem(resumed.item.id).state, 'published');

  console.log('✅ workflow recovery gate: unresolved dispatch blocks every profile until resolved');
}

main()
  .then(() => { if (store) store.close(); fs.rmSync(root, { recursive: true, force: true }); })
  .catch((error) => {
    if (store) { try { store.close(); } catch {} }
    fs.rmSync(root, { recursive: true, force: true });
    console.error(error);
    process.exit(1);
  });
