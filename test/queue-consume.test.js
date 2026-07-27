/**
 * 🗑️ Consumable queue, end-to-end through the REAL engine
 * ============================================================================
 * User report: "ما يحذف حذف تام من الطابور — بعدما يخلص العمل يقوم بإرجاع كل
 * المنشورات". After a run finished, every post it had just published was back
 * in the queue. Root cause: nothing was ever deleted, so nothing had to "come
 * back" — publishing only bumped a per-profile cursor.
 *
 * The queue now lives in the SQLite workflow store, and the cursor model is
 * gone entirely. This file pins the same user-visible guarantees against that
 * store, driving the REAL xPoster.start()/startMulti() over a fake browser:
 *
 *   1. A run always starts at the HEAD of the queue.
 *   2. A post that publishes successfully leaves the queue immediately and
 *      permanently.
 *   3. It never comes back — not at the end of the run, not on the next run,
 *      and not for another profile.
 *   4. A post that did NOT publish is never consumed.
 *   5. A published post stays in the dedup archive after leaving the queue.
 *
 * durable-outcomes.test.js pins the same invariants directly on the store.
 * This file is the other half of the pair: it proves xPoster's loop actually
 * REACHES those store operations. A cutover can satisfy every invariant there
 * while calling none of it — which is exactly what happened once already.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const SANDBOX = path.join(os.tmpdir(), 'xposter-consume-test-' + Date.now());
os.homedir = () => SANDBOX;
process.env.HOME = SANDBOX; // belt-and-suspenders: see smoke.test.js for why
fs.mkdirSync(path.join(SANDBOX, '.config', 'x-poster-bot-profile'), { recursive: true });
fs.mkdirSync(path.join(SANDBOX, '.config', 'x-poster-profiles', '2- ثاني'), { recursive: true });

let passed = 0;
let failed = 0;
function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}

// ── Fake Playwright browser/page harness ────────────────────────────────
// Enough surface for xPoster.start()'s HAPPY PATH (toast found on the first
// try) to complete without ever touching a real browser. Captures every string
// typed into the composer so we can verify REAL posting order, not just the
// display text. Any text in `failTexts` throws a network-flavoured error
// instead of typing, to exercise the "must NOT be consumed" path.
const typedTexts = [];
const failTexts = new Set();

// Deliberately module-level, NOT per-page. The store enforces UNIQUE on a
// post's external URL, so a per-page counter would hand run 2 the same
// /status/fake1 that run 1 already recorded. markPublished would then raise
// SQLITE_CONSTRAINT_UNIQUE, the item would be quarantined as ambiguous, and the
// global recovery gate would wedge every later run — a test artefact that looks
// exactly like a product bug.
let statusSeq = 0;

function makeFakePage() {
  const fakeEl = (extra = {}) => ({ $: async () => fakeEl(), ...extra });
  return {
    goto: async () => {},
    bringToFront: async () => {},
    setViewportSize: async () => {},
    evaluate: async () => undefined, // only scrollTo() calls hit this on the happy path
    url: () => 'https://x.com/home',
    mouse: { move: async () => {}, wheel: async () => {} },
    keyboard: {
      press: async () => {},
      type: async (text) => {
        if (failTexts.has(text)) throw new Error('net::ERR_INTERNET_DISCONNECTED');
        typedTexts.push(text);
      },
    },
    locator: () => ({ click: async () => {}, focus: async () => {} }),
    // `$` backs waitForSelectorInterruptible — always "found" immediately,
    // and the toast element resolves a fake status link.
    $: async (selector) => {
      if (selector === '[data-testid="toast"]') {
        statusSeq++;
        return fakeEl({
          $: async () => ({ getAttribute: async () => `/i/web/status/fake${statusSeq}` }),
        });
      }
      return fakeEl();
    },
  };
}

const browserManagerPath = require.resolve('../dev/automation/browserManager');
require.cache[browserManagerPath] = {
  id: browserManagerPath,
  filename: browserManagerPath,
  loaded: true,
  exports: {
    launchBrowser: async () => {
      const page = makeFakePage();
      return { pages: () => [page], close: async () => {} };
    },
  },
};

const durableQueue = require('../dev/automation/durableQueue');
const xPoster = require('../dev/automation/xPoster');

const OUT_DIR = path.join(SANDBOX, 'out');

/** The live queue, exactly as the UI's get-queue IPC returns it. */
async function queueTexts() {
  return (await durableQueue.getQueue()).map(p => (typeof p === 'string' ? p : p.text));
}

/** Items in a given set of store states — for asserting on what is NOT queued. */
async function itemsInStates(states) {
  const store = await durableQueue.getStore();
  return durableQueue.readAllItems(store, states).map(durableQueue.textOf);
}

async function run() {
  const posts = Array.from({ length: 10 }, (_, i) => `POST_${i + 1}`);
  await durableQueue.addPosts(posts);

  // ── RUN 1: publish 2 posts ────────────────────────────────────────────
  console.log('📋 Run 1 — publish the first 2 posts');
  const msgs1 = [];
  global.isRunning = true;
  const res1 = await xPoster.start(
    { speed: 0, minCooldownMs: 0, networkRecoveryMs: 0, maxPosts: 2, outputFolder: OUT_DIR, profile: 'Default' },
    (s) => msgs1.push(s)
  );
  assert(res1.success === 2, `run 1 published 2 posts (got ${res1.success})`);
  assert(typedTexts[0] === 'POST_1' && typedTexts[1] === 'POST_2',
    `run 1 starts at the FIRST post and goes in order (got ${JSON.stringify(typedTexts.slice(0, 2))})`);

  const startMsg1 = msgs1.find(m => /يبدأ من المنشور/.test(m.message || ''));
  assert(!!startMsg1 && startMsg1.message.includes('#1'), 'run 1 announces starting at post #1');

  // 🎯 THE BUG: this is what used to still be 10.
  const afterRun1 = await queueTexts();
  assert(afterRun1.length === 8,
    `the queue SHRANK to 8 after publishing 2 (got ${afterRun1.length}) — published posts leave the queue, they are not counted around`);
  assert(!afterRun1.includes('POST_1') && !afterRun1.includes('POST_2'),
    'the 2 published posts are GONE from the queue — not returned at the end of the run');
  assert(afterRun1[0] === 'POST_3', `the queue head is now the next unpublished post (got ${afterRun1[0]})`);

  // ── RUN 2: a fresh run must start at the new head ─────────────────────
  console.log('📋 Run 2 — a new run resumes at the head, with no cursor involved');
  typedTexts.length = 0;
  const msgs2 = [];
  global.isRunning = true;
  const res2 = await xPoster.start(
    { speed: 0, minCooldownMs: 0, networkRecoveryMs: 0, maxPosts: 2, outputFolder: OUT_DIR, profile: 'Default' },
    (s) => msgs2.push(s)
  );
  assert(res2.success === 2, `run 2 published 2 more posts (got ${res2.success})`);
  assert(typedTexts[0] === 'POST_3' && typedTexts[1] === 'POST_4',
    `run 2 continues at POST_3/POST_4 — no post is ever published twice (got ${JSON.stringify(typedTexts.slice(0, 2))})`);

  const afterRun2 = await queueTexts();
  assert(afterRun2.length === 6, `the queue is down to 6 (got ${afterRun2.length})`);
  assert(!afterRun2.some(p => ['POST_1', 'POST_2', 'POST_3', 'POST_4'].includes(p)),
    'nothing published in EITHER run has come back');

  // positions.json must not be resurrected — it is what made the old model lie.
  assert(!fs.existsSync(path.join(SANDBOX, '.config', 'x-poster-shared', 'positions.json')),
    'no positions.json is written any more (the cursor model is gone)');

  // ── RUN 3: another profile must not republish consumed posts ──────────
  console.log('📋 Run 3 — a second profile shares the queue, it does not replay it');
  typedTexts.length = 0;
  global.isRunning = true;
  const res3 = await xPoster.start(
    { speed: 0, minCooldownMs: 0, networkRecoveryMs: 0, maxPosts: 2, outputFolder: OUT_DIR, profile: '2- ثاني' },
    () => {}
  );
  assert(res3.success === 2, `profile 2 published 2 posts (got ${res3.success})`);
  assert(typedTexts[0] === 'POST_5' && typedTexts[1] === 'POST_6',
    `a second profile picks up where the queue is — it does NOT restart at POST_1 (got ${JSON.stringify(typedTexts.slice(0, 2))})`);
  assert((await queueTexts()).length === 4, 'the queue is down to 4 across both profiles');

  // ── RUN 4: a post that FAILS must not be consumed ─────────────────────
  console.log('📋 Run 4 — a post that never published is never consumed');
  failTexts.add('POST_7');
  typedTexts.length = 0;
  global.isRunning = true;
  const res4 = await xPoster.start(
    { speed: 0, minCooldownMs: 0, networkRecoveryMs: 0, maxPosts: 2, outputFolder: OUT_DIR, profile: 'Default' },
    () => {}
  );

  // The store answers "still publishable" with a backoff instead of leaving the
  // post at the head to be retried instantly, so it is briefly absent from
  // listQueued (which filters on available_at_ms). Absent-with-a-return-date is
  // NOT the same as consumed, and this is the distinction that matters: the
  // post must be in 'deferred', never in 'published' or 'discarded'.
  const deferred = await itemsInStates(['deferred']);
  assert(deferred.includes('POST_7'),
    'a post whose publish failed is DEFERRED, not consumed — it comes back automatically when the backoff elapses');
  assert(res4.failed >= 1, `the failed post was reported as failed (got failed=${res4.failed})`);
  assert(typedTexts.includes('POST_8'),
    'the run moved on to the next post instead of stalling on the failure');
  assert(!(await queueTexts()).includes('POST_8'), 'the post that DID publish in run 4 was consumed');

  // Checked HERE, while POST_7 is still unpublished. It goes out later in this
  // test once the simulated network recovers, at which point archiving it is
  // correct.
  const archivedAfterRun4 = await durableQueue.getPublishedTexts();
  assert(!archivedAfterRun4.includes('POST_7'),
    'a post that FAILED is not archived as published — the user can still regenerate that idea');

  // ── The deferred post really does come back ───────────────────────────
  // Not a formality: "not consumed" is worthless if the post is never eligible
  // again. Clear the backoff the way elapsed time would, and publish it.
  console.log('📋 A deferred post returns to the queue once its backoff elapses');
  failTexts.clear();
  const store = await durableQueue.getStore();
  store.db.prepare(
    "UPDATE workflow_items SET available_at_ms = ? WHERE state = 'deferred'"
  ).run(Date.now() - 1);
  assert((await queueTexts()).includes('POST_7'),
    'POST_7 is publishable again — deferral is a delay, not a verdict');

  // ── Spintax: consume the STORED text, not the typed variant ───────────
  // A spintax post is typed as one of its variants ("SPIN_a"), but the queue
  // stores the template ("SPIN_{a|b}"). Consuming by the typed text would find
  // no match, so the post would never leave the queue and would come back on
  // every run — the exact bug being fixed here, through a side door.
  console.log('📋 Spintax — consumed by the stored template, not the typed variant');
  await durableQueue.addPosts(['SPIN_{a|b}']);
  const beforeSpin = (await queueTexts()).length;
  typedTexts.length = 0;
  global.isRunning = true;
  await xPoster.start(
    { speed: 0, minCooldownMs: 0, networkRecoveryMs: 0, maxPosts: 99, outputFolder: OUT_DIR, profile: 'Default' },
    () => {}
  );
  const afterSpin = await queueTexts();
  assert(typedTexts.some(t => t === 'SPIN_a' || t === 'SPIN_b'),
    `the spintax post was typed as a resolved variant (got ${JSON.stringify(typedTexts.filter(t => t.startsWith('SPIN')))})`);
  assert(!afterSpin.includes('SPIN_{a|b}'),
    'the spintax post was consumed by its STORED template — it does not survive the run');
  assert(beforeSpin > 0 && afterSpin.length === 0,
    `the whole queue drained (got ${afterSpin.length} left: ${JSON.stringify(afterSpin)})`);

  // ── Published archive: dedup must outlive the queue entry ─────────────
  // "منع تكرار المعنى نهائياً — بلا نافذة زمنية" used to ride on the queue file
  // being append-only. Now that publishing removes the post, the archive is what
  // keeps a published tweet in the studio's dedup corpus forever.
  console.log('📋 Published archive — dedup corpus outlives the queue entry');
  const published = await durableQueue.getPublishedTexts();
  assert(published.includes('POST_1') && published.includes('POST_8'),
    'posts that went out are archived for dedup even though they left the queue');
  assert(published.includes('POST_7'),
    'POST_7 IS archived once it finally published on a later run (deferral is not a permanent verdict)');
  assert(published.some(t => t === 'SPIN_{a|b}'),
    'the spintax template is archived (dedup matches on what the studio would generate)');

  // A published post must never be re-queueable by the ordinary add path, or
  // the studio could quietly reintroduce a tweet that is already live on X.
  const readd = await durableQueue.addPosts(['POST_1']);
  assert(readd.added === 1 && (await queueTexts()).includes('POST_1'),
    'adding a published text back is an explicit user action and is allowed — the archive informs dedup, it is not a ban list');
  await durableQueue.bulkDeleteByText(['POST_1']);

  // ── Manual delete must survive the queue shrinking under it ───────────
  // The UI captures a row list, then publishing consumes the head post and
  // shifts every later position down by one. Deleting by that stale POSITION
  // removes a different post than the user picked — silently. Deletion is
  // therefore addressed by text.
  console.log('📋 Manual delete is content-addressed, not positional');
  await durableQueue.addPosts(['DEL_A', 'DEL_B', 'DEL_C', 'DEL_D']);
  const uiSnapshot = (await queueTexts())
    .map((text, index) => ({ index, text }))
    .filter(v => v.text.startsWith('DEL_'));
  const pick = uiSnapshot.find(v => v.text === 'DEL_C');
  // The queue shifts under the UI, exactly as a publish would.
  await durableQueue.bulkDeleteByText(['DEL_A']);
  await durableQueue.bulkDeleteByText([pick.text]);
  const afterDel = await queueTexts();
  assert(!afterDel.includes('DEL_C'), 'the post the user actually picked is the one deleted');
  assert(afterDel.includes('DEL_D'),
    'the NEXT post is untouched — a stale row position would have deleted this one instead');
  assert(afterDel.includes('DEL_B'), 'unrelated posts are untouched');

  // A delete that could not be honoured is REPORTED, never silently swallowed.
  const missing = await durableQueue.bulkDeleteByText(['NEVER_QUEUED']);
  assert(missing.deleted === 0,
    'deleting a text that is not in the queue reports 0 deleted rather than claiming success');

  await durableQueue.bulkDeleteByText(['DEL_B', 'DEL_D']);

  // ── Durability: the deletion is on disk, not in memory ────────────────
  console.log('📋 Durability — consumption survives reopening the store');
  const beforeReopen = await queueTexts();
  await durableQueue.closeStore();
  const afterReopen = await queueTexts();
  assert(JSON.stringify(beforeReopen) === JSON.stringify(afterReopen),
    'a reopened store agrees with the closed one — consumption is committed, not just in memory');

  // ── Every run is accounted for ────────────────────────────────────────
  // A run left 'active' is indistinguishable from a crash on the next startup,
  // and the row is never reclaimed.
  const openRuns = (await durableQueue.getStore()).db
    .prepare("SELECT COUNT(*) AS n FROM workflow_runs WHERE status = 'active'").get().n;
  assert(openRuns === 0,
    `every finished run is closed in the store (got ${openRuns} still 'active')`);

  console.log(`\n${failed === 0 ? '✅' : '❌'} queue-consume: ${passed} passed, ${failed} failed`);
  await durableQueue.closeStore();
  try { fs.rmSync(SANDBOX, { recursive: true }); } catch (e) { /* best-effort */ }
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error('❌ test crashed:', e);
  try { fs.rmSync(SANDBOX, { recursive: true }); } catch (_) {}
  process.exit(1);
});
