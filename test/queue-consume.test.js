/**
 * 🗑️ Consumable queue — "published means deleted, permanently"
 * ============================================================================
 * User report: "ما يحذف حذف تام من الطابور — بعدما يخلص العمل يقوم بإرجاع كل
 * المنشورات". After a run finished, every post it had just published was back
 * in the queue.
 *
 * Root cause: nothing was ever deleted, so nothing had to "come back".
 * queue.json was append-only; publishing only bumped a per-profile counter in
 * positions.json, and the UI's get-queue returned the WHOLE queue.json ignoring
 * that counter. Published posts had therefore never left the list — they
 * reappeared the moment the UI refreshed, and any loss of positions.json
 * silently republished the entire queue from the top.
 *
 * Required behavior, and what this test pins down:
 *   1. A run always starts at the FIRST post in the queue.
 *   2. A post that publishes successfully (link captured) is deleted from
 *      queue.json IMMEDIATELY and permanently.
 *   3. It is never returned to the queue — not at the end of the run, not on
 *      the next run, and not for another profile.
 *   4. A post that did NOT publish is never deleted.
 *
 * This drives the REAL xPoster.start()/startMulti() against a fully mocked
 * browser and asserts on the actual on-disk queue + the actually-typed text,
 * so it fails if the engine ever stops consuming (or starts over-consuming).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const SANDBOX = path.join(os.tmpdir(), 'xposter-consume-test-' + Date.now());
os.homedir = () => SANDBOX;
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
function makeFakePage() {
  let seq = 0;
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
        seq++;
        return fakeEl({
          $: async () => ({ getAttribute: async () => `/i/web/status/fake${seq}` }),
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

const queueManager = require('../dev/automation/queueManager');
const xPoster = require('../dev/automation/xPoster');

const OUT_DIR = path.join(SANDBOX, 'out');
const QUEUE_FILE = path.join(SANDBOX, '.config', 'x-poster-shared', 'queue.json');

/** Read queue.json straight off disk — the source of truth the UI reads. */
function queueOnDisk() {
  return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'))
    .map(p => (typeof p === 'string' ? p : p.text));
}

async function run() {
  const posts = Array.from({ length: 10 }, (_, i) => `POST_${i + 1}`);
  await queueManager.addPosts(posts);

  // ── RUN 1: publish 2 posts ────────────────────────────────────────────
  console.log('📋 Run 1 — publish the first 2 posts');
  const msgs1 = [];
  global.isRunning = true;
  const res1 = await xPoster.start(
    { speed: 0, maxPosts: 2, outputFolder: OUT_DIR, profile: 'Default' },
    (s) => msgs1.push(s)
  );
  assert(res1.success === 2, `run 1 published 2 posts (got ${res1.success})`);
  assert(typedTexts[0] === 'POST_1' && typedTexts[1] === 'POST_2',
    `run 1 starts at the FIRST post and goes in order (got ${JSON.stringify(typedTexts.slice(0, 2))})`);

  const startMsg1 = msgs1.find(m => /يبدأ من المنشور/.test(m.message || ''));
  assert(!!startMsg1 && startMsg1.message.includes('#1'), 'run 1 announces starting at post #1');

  // 🎯 THE BUG: this is what used to still be 10.
  const afterRun1 = queueOnDisk();
  assert(afterRun1.length === 8,
    `queue.json SHRANK to 8 after publishing 2 (got ${afterRun1.length}) — published posts are deleted, not counted around`);
  assert(!afterRun1.includes('POST_1') && !afterRun1.includes('POST_2'),
    'the 2 published posts are GONE from the queue — not returned at the end of the run');
  assert(afterRun1[0] === 'POST_3', `the queue head is now the next unpublished post (got ${afterRun1[0]})`);

  // ── RUN 2: a fresh run must start at the new first post ───────────────
  console.log('📋 Run 2 — a new run resumes at the head, with no cursor involved');
  typedTexts.length = 0;
  const msgs2 = [];
  global.isRunning = true;
  const res2 = await xPoster.start(
    { speed: 0, maxPosts: 2, outputFolder: OUT_DIR, profile: 'Default' },
    (s) => msgs2.push(s)
  );
  assert(res2.success === 2, `run 2 published 2 more posts (got ${res2.success})`);
  assert(typedTexts[0] === 'POST_3' && typedTexts[1] === 'POST_4',
    `run 2 continues at POST_3/POST_4 — no post is ever published twice (got ${JSON.stringify(typedTexts.slice(0, 2))})`);

  const afterRun2 = queueOnDisk();
  assert(afterRun2.length === 6, `queue.json is down to 6 (got ${afterRun2.length})`);
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
    { speed: 0, maxPosts: 2, outputFolder: OUT_DIR, profile: '2- ثاني' },
    () => {}
  );
  assert(res3.success === 2, `profile 2 published 2 posts (got ${res3.success})`);
  assert(typedTexts[0] === 'POST_5' && typedTexts[1] === 'POST_6',
    `a second profile picks up where the queue is — it does NOT restart at POST_1 (got ${JSON.stringify(typedTexts.slice(0, 2))})`);
  const afterRun3 = queueOnDisk();
  assert(afterRun3.length === 4, `queue.json is down to 4 across both profiles (got ${afterRun3.length})`);

  // ── RUN 4: a post that FAILS must stay in the queue ───────────────────
  console.log('📋 Run 4 — a post that never published is never deleted');
  failTexts.add('POST_7');
  typedTexts.length = 0;
  global.isRunning = true;
  const res4 = await xPoster.start(
    { speed: 0, maxPosts: 2, outputFolder: OUT_DIR, profile: 'Default' },
    () => {}
  );
  const afterRun4 = queueOnDisk();
  assert(afterRun4.includes('POST_7'),
    'a post whose publish failed is STILL in the queue — consumption is tied to success, not to being attempted');
  assert(res4.failed >= 1, `the failed post was reported as failed (got failed=${res4.failed})`);
  assert(typedTexts.includes('POST_8'),
    'the run moved on to the next post instead of stalling on the failure');
  assert(!afterRun4.includes('POST_8'), 'the post that DID publish in run 4 was consumed');

  const deferred = await queueManager.getDeferred('Default');
  assert(deferred.length === 1 && deferred[0].text === 'POST_7',
    'the failed post is tracked as deferred (attempt counter only — the queue itself holds the retry)');
  // Checked HERE, while POST_7 is still unpublished — it goes out later in this
  // test once the simulated network recovers, at which point archiving it is
  // correct.
  const archivedAfterRun4 = await queueManager.getPublishedTexts();
  assert(!archivedAfterRun4.includes('POST_7'),
    'a post that FAILED is not archived as published — the user can still regenerate that idea');

  // ── Spintax: consume by STORED text, not by what was typed ────────────
  // A spintax post is typed as one of its variants ("SPIN_a"), but the queue
  // stores the template ("SPIN_{a|b}"). Consuming by the typed text would find
  // no match, so the post would never be deleted and would come back on every
  // run — the exact bug being fixed here, reintroduced through a side door.
  console.log('📋 Spintax — consumed by the stored template, not the typed variant');
  failTexts.clear();
  await queueManager.addPosts(['SPIN_{a|b}']);
  const beforeSpin = queueOnDisk().length;
  typedTexts.length = 0;
  global.isRunning = true;
  await xPoster.start(
    { speed: 0, maxPosts: 99, outputFolder: OUT_DIR, profile: 'Default' },
    () => {}
  );
  const afterSpin = queueOnDisk();
  assert(typedTexts.some(t => t === 'SPIN_a' || t === 'SPIN_b'),
    `the spintax post was typed as a resolved variant (got ${JSON.stringify(typedTexts.filter(t => t.startsWith('SPIN')))})`);
  assert(!afterSpin.includes('SPIN_{a|b}'),
    'the spintax post was consumed by its STORED template — it does not survive the run');
  assert(beforeSpin > 0 && afterSpin.length === 0,
    `the whole queue drained (got ${afterSpin.length} left: ${JSON.stringify(afterSpin)})`);

  // ── Published archive: dedup must outlive the queue entry ─────────────
  // "منع تكرار المعنى نهائياً — بلا نافذة زمنية" used to ride on queue.json
  // being append-only. Now that publishing deletes the post, the archive is
  // what keeps a published tweet in the studio's dedup corpus forever.
  console.log('📋 Published archive — dedup corpus outlives the queue entry');
  const published = await queueManager.getPublishedTexts();
  assert(published.includes('POST_1') && published.includes('POST_8'),
    'posts that went out are archived for dedup even though they left the queue');
  assert(published.includes('POST_7'),
    'POST_7 IS archived once it finally published on a later run (deferral is not a permanent verdict)');
  assert(published.some(t => t === 'SPIN_{a|b}'),
    'the spintax template is archived (dedup matches on what the studio would generate)');

  // ── Manual delete must survive the queue shrinking under it ───────────
  // The UI captures a row list, then publishing consumes the head post and
  // shifts every later position down by one. Deleting by that stale POSITION
  // removes a different post than the user picked — silently. Deletion is
  // therefore addressed by text, like consumePost.
  console.log('📋 Manual delete is content-addressed, not positional');
  await queueManager.addPosts(['DEL_A', 'DEL_B', 'DEL_C', 'DEL_D']);
  const uiSnapshot = (await queueManager.getQueue())
    .map((p, i) => ({ index: i, text: typeof p === 'string' ? p : p.text }))
    .filter(v => v.text.startsWith('DEL_'));
  const pick = uiSnapshot.find(v => v.text === 'DEL_C');
  // the queue shifts under the UI, exactly as a publish would
  await queueManager.consumePost('DEL_A', { published: true });
  await queueManager.bulkDeleteByText([pick.text]);
  const afterDel = queueOnDisk();
  assert(!afterDel.includes('DEL_C'),
    'the post the user actually picked is the one deleted');
  assert(afterDel.includes('DEL_D'),
    'the NEXT post is untouched — a stale row position would have deleted this one instead');
  assert(afterDel.includes('DEL_B'), 'unrelated posts are untouched');
  // clean up so the drain assertions below still hold
  await queueManager.bulkDeleteByText(['DEL_B', 'DEL_D']);

  // ── Durability: consumption survives a fresh read of the module ───────
  console.log('📋 Durability — the deletion is on disk, not in memory');
  const reread = (await queueManager.getQueue()).map(p => (typeof p === 'string' ? p : p.text));
  assert(JSON.stringify(reread) === JSON.stringify(queueOnDisk()),
    'a fresh getQueue() (what the UI calls) agrees with disk — the deletion is persisted, not just in memory');

  console.log(`\n${failed === 0 ? '✅' : '❌'} queue-consume: ${passed} passed, ${failed} failed`);
  try { fs.rmSync(SANDBOX, { recursive: true }); } catch (e) { /* best-effort */ }
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error('❌ test crashed:', e);
  try { fs.rmSync(SANDBOX, { recursive: true }); } catch (_) {}
  process.exit(1);
});
