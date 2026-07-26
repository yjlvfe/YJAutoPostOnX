'use strict';

// Live-integration gates for durableQueue.js — the bridge the app actually
// calls. These prove the durable semantics survive the adapter layer, because
// an adapter that quietly reintroduces the old text-keyed, split-write model
// would undo the whole repair.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xposter-live-home-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
const realHomedir = os.homedir;
os.homedir = () => home;

const durableQueue = require('../dev/automation/durableQueue');
// A full lease -> boundary -> transport cycle, without a browser. Not shipped
// code — see the header of test/helpers/dispatchDriver.js.
const { dispatchNext } = require('./helpers/dispatchDriver');

async function main() {
  // ── add / read ─────────────────────────────────────────────────────────────
  const media = path.join(home, 'pic.png');
  fs.writeFileSync(media, crypto.randomBytes(64));

  const added = await durableQueue.addPosts([
    'first post',
    { text: 'second post', media_path: media },
    'first post', // duplicate
    '   ',        // empty
  ]);
  assert.strictEqual(added.added, 2);
  assert.strictEqual(added.skippedDuplicate, 1);

  const queue = await durableQueue.getQueue();
  assert.strictEqual(queue.length, 2);
  assert.strictEqual(queue[0], 'first post', 'plain posts keep the legacy string shape');
  assert.strictEqual(typeof queue[1], 'object');
  assert.strictEqual(queue[1].text, 'second post');
  assert.ok(fs.existsSync(queue[1].media_path), 'media must resolve to a real managed file');

  // ── publish path ───────────────────────────────────────────────────────────
  const store = await durableQueue.getStore();
  const profileId = await durableQueue.resolveProfileId('Default');
  const profile = { id: profileId };
  const run = store.startRun({ requestId: 'r-1' });

  let transportCalls = 0;
  const published = await dispatchNext({
    store,
    profileId: profile.id,
    runId: run.id,
    prepare: (item) => ({ renderedText: item.payload.text }),
    dispatch: async () => {
      transportCalls += 1;
      return { confirmed: true, externalUrl: 'https://x.com/status/100' };
    },
  });
  assert.strictEqual(published.status, 'confirmed');
  assert.strictEqual(transportCalls, 1, 'the transport must be called exactly once');

  // A published post leaves the queue permanently but stays in the dedup corpus.
  const afterPublish = await durableQueue.getQueue();
  assert.strictEqual(afterPublish.length, 1);
  const publishedTexts = await durableQueue.getPublishedTexts();
  assert.ok(publishedTexts.includes('first post'),
    'published text must remain visible to semantic dedup');

  // ── ambiguity blocks everything ────────────────────────────────────────────
  const ambiguous = await dispatchNext({
    store,
    profileId: profile.id,
    runId: run.id,
    prepare: (item) => ({ renderedText: item.payload.text }),
    dispatch: async () => { throw new Error('rejected after keystroke'); },
  });
  assert.strictEqual(ambiguous.status, 'ambiguous_post_dispatch',
    `expected post-boundary ambiguity, got ${ambiguous.status}: ${ambiguous.error && ambiguous.error.message} (${ambiguous.error && ambiguous.error.code})`);
  assert.strictEqual(await durableQueue.countUnresolved(), 1);

  const recovery = await durableQueue.getRecoveryItems('Default');
  assert.strictEqual(recovery.pending.length, 1);
  assert.strictEqual(recovery.pending[0].text, 'second post');
  assert.strictEqual(recovery.pending[0].attemptedText, 'second post',
    'the operator must see exactly what was attempted');

  // Adding more posts must not let publishing resume while unresolved.
  await durableQueue.addPosts(['third post']);
  const blocked = await dispatchNext({
    store,
    profileId: profile.id,
    runId: run.id,
    prepare: () => { throw new Error('must not prepare while blocked'); },
    dispatch: async () => { throw new Error('must not dispatch while blocked'); },
  });
  assert.strictEqual(blocked.status, 'blocked');
  assert.strictEqual(blocked.reason, 'recovery_required');

  // ── requeueing an ambiguous item demands explicit confirmation ─────────────
  await assert.rejects(
    async () => durableQueue.requeueRecovery('Default', 'pending', 'second post'),
    (error) => error.code === 'CONFIRMATION_REQUIRED',
    'requeueing a possibly-published post must require explicit confirmation',
  );

  assert.strictEqual(
    await durableQueue.requeueRecovery('Default', 'pending', 'second post', {
      confirmedNotPublished: true,
    }),
    true,
  );
  assert.strictEqual(await durableQueue.countUnresolved(), 0,
    'resolving recovery must unblock the queue');

  // ── deletion is authoritative, never optimistic ────────────────────────────
  const deletion = await durableQueue.bulkDeleteByText(['third post']);
  assert.strictEqual(deletion.deleted, 1);
  assert.ok(!(await durableQueue.getQueue()).some((entry) =>
    (typeof entry === 'string' ? entry : entry.text) === 'third post'));

  // An in-flight item must NOT report a successful delete.
  const run2 = store.startRun({ requestId: 'r-2' });
  const leased = store.leaseNext({ profileId: profile.id, runId: run2.id });
  const leasedText = leased.payload.text;
  const blockedDelete = await durableQueue.bulkDeleteByText([leasedText]);
  assert.strictEqual(blockedDelete.deleted, 0,
    'an in-flight post must never be reported as deleted');
  assert.strictEqual(blockedDelete.blocked.length, 1);
  assert.ok(blockedDelete.blocked[0].reason.startsWith('IN_FLIGHT'));
  store.releasePreDispatch({
    id: leased.id,
    leaseToken: leased.leaseToken,
    reason: 'test_cleanup',
    countAsFailure: false,
    requestId: 'release-test',
  });

  // ── dead letters can be requeued ───────────────────────────────────────────
  const run3 = store.startRun({ requestId: 'r-3' });
  const toKill = store.leaseNext({ profileId: profile.id, runId: run3.id });
  store.markTerminal({
    id: toKill.id,
    leaseToken: toKill.leaseToken,
    reason: 'test_dead',
    requestId: 'kill-1',
  });
  const deadText = toKill.payload.text;
  const recovery2 = await durableQueue.getRecoveryItems('Default');
  assert.ok(recovery2.deadLetters.some((entry) => entry.text === deadText));
  assert.strictEqual(await durableQueue.requeueRecovery('Default', 'dead', deadText), true);
  assert.ok((await durableQueue.getQueue()).some((entry) =>
    (typeof entry === 'string' ? entry : entry.text) === deadText),
    'a requeued dead letter must return to the queue');

  // ── maintenance is safe and bounded ────────────────────────────────────────
  const maintenance = await durableQueue.runMaintenance();
  assert.ok(typeof maintenance.reclaimedLeases === 'number');
  assert.strictEqual((await durableQueue.integrityCheck()).ok, true);

  console.log('✅ durable queue live integration: add/read/publish/recovery/delete/maintenance passed');
}

main()
  .then(async () => {
    await durableQueue.closeStore();
    os.homedir = realHomedir;
    fs.rmSync(home, { recursive: true, force: true });
  })
  .catch(async (error) => {
    try { await durableQueue.closeStore(); } catch { /* already closed */ }
    os.homedir = realHomedir;
    fs.rmSync(home, { recursive: true, force: true });
    console.error(error);
    process.exit(1);
  });
