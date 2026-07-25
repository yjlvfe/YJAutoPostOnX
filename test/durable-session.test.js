'use strict';

// Gates for DurableSession — the primitives xPoster's publish loop uses.
// These prove the loop-shaped API keeps the durable guarantees, because a
// convenience wrapper is exactly where they tend to leak away.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xposter-session-home-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
const realHomedir = os.homedir;
os.homedir = () => home;

const durableQueue = require('../dev/automation/durableQueue');
const { DurableSession } = require('../dev/automation/durableSession');

async function main() {
  await durableQueue.addPosts(['post one', 'post two', 'post three']);

  const session = await DurableSession.open('Default');
  assert.strictEqual(session.queuedCount(), 3);

  // ── happy path: exactly one dispatch, then published ──────────────────────
  const first = session.claimNext();
  assert.strictEqual(first.text, 'post one');
  assert.strictEqual(session.pastBoundary, false);

  const begun = session.beginDispatch('post one');
  assert.strictEqual(begun.ok, true);
  assert.strictEqual(session.pastBoundary, true,
    'the boundary must be committed before the keystroke');

  session.markPublished({ externalUrl: 'https://x.com/status/1' });
  assert.strictEqual(session.queuedCount(), 2);
  assert.strictEqual(session.unresolvedCount(), 0);

  // ── Stop before the boundary returns the post untouched ───────────────────
  const second = session.claimNext();
  assert.strictEqual(second.text, 'post two');
  session.release('stopped_by_user');
  assert.strictEqual(session.queuedCount(), 2, 'a stopped post stays in the queue');
  const reclaimed = session.claimNext();
  assert.strictEqual(reclaimed.text, 'post two', 'and is claimable again immediately');

  // ── post-boundary ambiguity blocks everything ─────────────────────────────
  assert.strictEqual(session.beginDispatch('post two').ok, true);
  session.markAmbiguous('stopped_after_submit');
  assert.strictEqual(session.unresolvedCount(), 1);

  const blocked = session.claimNext();
  assert.ok(blocked && blocked.blocked === true,
    'no post may be claimed while an earlier dispatch is unaccounted for');
  assert.strictEqual(blocked.reason, 'recovery_required');

  // Another profile in another run is equally blocked.
  const other = await DurableSession.open('2- Second');
  const otherClaim = other.claimNext();
  assert.ok(otherClaim && otherClaim.blocked === true,
    'the block is global, not per profile');
  other.close();

  // Resolving it lets work resume.
  const pending = (await durableQueue.getRecoveryItems('Default')).pending;
  assert.strictEqual(pending.length, 1);
  assert.strictEqual(pending[0].text, 'post two');
  await durableQueue.requeueRecovery('Default', 'pending', 'post two', {
    confirmedNotPublished: true,
  });
  assert.strictEqual(session.unresolvedCount(), 0);

  // ── pre-boundary failures are classified, never silently retried forever ──
  const third = session.claimNext();
  assert.ok(third && !third.blocked);
  session.markDeferred('network_glitch', new Error('ECONNRESET'), 60_000);
  assert.ok(!session.store.listQueued({ limit: 10 }).some((i) => i.id === third.id),
    'a deferred post must not be immediately re-eligible');

  const fourth = session.claimNext();
  session.markTerminal('selector_regression', new Error('composer missing'));
  const recovery = await durableQueue.getRecoveryItems('Default');
  assert.ok(recovery.deadLetters.some((entry) => entry.text === fourth.text),
    'a permanent pre-boundary failure lands in dead letters, never on X');

  // ── media integrity is enforced at the boundary ───────────────────────────
  const picture = path.join(home, 'shot.png');
  fs.writeFileSync(picture, crypto.randomBytes(80));
  await durableQueue.addPosts([{ text: 'with picture', media_path: picture }]);
  const withMedia = session.claimNext();
  assert.strictEqual(withMedia.text, 'with picture');
  assert.ok(withMedia.mediaPath && fs.existsSync(withMedia.mediaPath));
  // Intact media must be publishable.
  assert.strictEqual(session.beginDispatch('with picture').ok, true);
  session.markPublished({ externalUrl: 'https://x.com/status/2' });

  await durableQueue.addPosts([{ text: 'tampered picture', media_path: picture }]);
  const tampered = session.claimNext();
  fs.writeFileSync(tampered.mediaPath, Buffer.from('corrupted'));
  const refused = session.beginDispatch('tampered picture');
  assert.strictEqual(refused.ok, false, 'corrupt media must refuse the boundary');
  assert.strictEqual(refused.code, 'MEDIA_INTEGRITY_FAILED');
  assert.strictEqual(session.store.getItem(tampered.id).state, 'dead',
    'a refused item must land somewhere durable, never stay leased');

  // ── closing a session releases an unstarted claim ─────────────────────────
  await durableQueue.addPosts(['final post']);
  const held = session.claimNext();
  assert.ok(held && !held.blocked);
  session.close();
  const after = await DurableSession.open('Default');
  const reclaimedAfterClose = after.claimNext();
  assert.strictEqual(reclaimedAfterClose.text, held.text,
    'closing a run must not strand the post it was holding');
  after.release('test_done');
  after.close();

  // This test deliberately corrupted a managed blob, so integrityCheck MUST
  // still be reporting it — silence here would mean the detector is broken.
  const report = await durableQueue.integrityCheck();
  assert.strictEqual(report.ok, false,
    'the deliberately corrupted blob must still be reported');
  assert.strictEqual(report.mediaProblems.length, 1);
  assert.strictEqual(report.stateConsistencyViolations.length, 0,
    'no item/attempt split-brain may result from normal operation');
  assert.strictEqual(report.orphanedMediaFiles.length, 0,
    'normal operation must not leak orphaned media');
  console.log('✅ durable session: claim/boundary/publish/ambiguity/classification/media/close passed');
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
