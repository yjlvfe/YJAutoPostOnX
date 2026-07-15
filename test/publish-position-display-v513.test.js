/**
 * 📍 v5.13.0 — "publishing starts from a random post every time" fix
 * ====================================================================
 * User report: watching the live log, every run LOOKED like it picked a
 * random starting post instead of continuing where the last run left off
 * (e.g. day 1 reaches post #100, day 2 should start at #101).
 *
 * Root cause (confirmed by code + a passing isolated queueManager test):
 * the underlying queue-position persistence (positions.json →
 * advancePosition/getProfileQueue) was ALREADY correct — a fresh run really
 * does resume at the right index. The bug was in the LIVE STATUS MESSAGE:
 * `start()` announces "starts from post #101" ONCE at the top, then every
 * per-post status line said "Processing post 1...", "Processing post 2...”
 * — a SESSION-LOCAL counter that restarts at 1 on every run. Watching the
 * log, that reads as "it ignored the resume position and restarted from
 * scratch", even though positions.json was tracking correctly the whole
 * time. Priority hand-off / deferred-retry items (which are legitimately
 * out of sequence) made this worse by being folded into the same fake
 * counter with no indication they weren't part of the normal sequence.
 *
 * Fix: the per-post message now shows the TRUE absolute queue position
 * (queueStartIndex + sequentialPosted) for normal items, and a distinct
 * label (no fake number) for priority/deferred-retry items.
 *
 * This test drives the REAL `xPoster.start()` function twice in a row
 * (simulating "day 1" then "day 2") against a fully mocked browser/page, and
 * asserts on the actual live status messages + actually-typed post text —
 * not just a source-pattern check — to prove the fix holds end-to-end.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const SANDBOX = path.join(os.tmpdir(), 'xposter-posdisplay-test-' + Date.now());
os.homedir = () => SANDBOX;
fs.mkdirSync(path.join(SANDBOX, '.config', 'x-poster-bot-profile'), { recursive: true });

let passed = 0;
let failed = 0;
function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}

// ── Fake Playwright browser/page harness ────────────────────────────────
// Enough surface for xPoster.start()'s HAPPY PATH (toast found on the first
// try) to complete without ever touching a real browser. Captures every
// string typed into the composer so we can verify REAL posting order, not
// just the display text.
const typedTexts = [];
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
      type: async (text) => { typedTexts.push(text); },
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

async function run() {
  // 150-post queue, uniquely identifiable text per index.
  const posts = Array.from({ length: 150 }, (_, i) => `POST_${i + 1}`);
  await queueManager.addPosts(posts);

  // ── RUN 1 ("day 1"): publish 2 posts ──────────────────────────────────
  const msgs1 = [];
  global.isRunning = true;
  const res1 = await xPoster.start(
    { speed: 0, maxPosts: 2, outputFolder: OUT_DIR, profile: 'Default' },
    (s) => msgs1.push(s)
  );
  assert(res1.success === 2, `run 1 published 2 posts (got ${res1.success})`);

  const startMsg1 = msgs1.find(m => /يبدأ من المنشور/.test(m.message || ''));
  assert(!!startMsg1 && startMsg1.message.includes('#1'), 'run 1 announces starting at #1 (fresh profile)');

  const progressMsgs1 = msgs1.filter(m => /نشر المنشور رقم/.test(m.message || ''));
  assert(progressMsgs1.length === 2, `run 1 emitted 2 sequential progress messages (got ${progressMsgs1.length})`);
  assert(progressMsgs1[0].message.includes('رقم 1 '), `first progress message shows absolute #1 (got "${progressMsgs1[0]?.message}")`);
  assert(progressMsgs1[1].message.includes('رقم 2 '), `second progress message shows absolute #2 (got "${progressMsgs1[1]?.message}")`);
  assert(!progressMsgs1.some(m => /^Processing post \d+\.\.\.$/.test(m.message)),
    'the old session-local "Processing post N..." message is gone');

  assert(typedTexts[0] === 'POST_1' && typedTexts[1] === 'POST_2',
    `run 1 actually typed queue items in order (got ${JSON.stringify(typedTexts)})`);

  const posAfterRun1 = await queueManager.getProfilePosition('Default');
  assert(posAfterRun1 === 2, `positions.json advanced to 2 after run 1 (got ${posAfterRun1})`);

  // ── RUN 2 ("day 2", separate start() call — simulates stop/reopen) ────
  typedTexts.length = 0;
  const msgs2 = [];
  global.isRunning = true;
  const res2 = await xPoster.start(
    { speed: 0, maxPosts: 2, outputFolder: OUT_DIR, profile: 'Default' },
    (s) => msgs2.push(s)
  );
  assert(res2.success === 2, `run 2 published 2 more posts (got ${res2.success})`);

  const startMsg2 = msgs2.find(m => /يبدأ من المنشور/.test(m.message || ''));
  assert(!!startMsg2 && startMsg2.message.includes('#3'),
    `run 2 announces resuming at #3, NOT restarting at #1 (got "${startMsg2?.message}")`);

  const progressMsgs2 = msgs2.filter(m => /نشر المنشور رقم/.test(m.message || ''));
  assert(progressMsgs2[0]?.message.includes('رقم 3 '),
    `run 2's first live message shows absolute #3, continuing from run 1 — THIS is the reported bug (got "${progressMsgs2[0]?.message}")`);
  assert(progressMsgs2[1]?.message.includes('رقم 4 '),
    `run 2's second live message shows absolute #4 (got "${progressMsgs2[1]?.message}")`);

  assert(typedTexts[0] === 'POST_3' && typedTexts[1] === 'POST_4',
    `run 2 actually continued the real posting order at POST_3/POST_4 (got ${JSON.stringify(typedTexts)})`);

  const posAfterRun2 = await queueManager.getProfilePosition('Default');
  assert(posAfterRun2 === 4, `positions.json continued to 4 after run 2 (got ${posAfterRun2})`);

  // ── RUN 3: a deferred-retry item must NOT get a fake sequential number ─
  await queueManager.addDeferred('DEFERRED_TEXT', 'simulated network blip', 'Default');
  typedTexts.length = 0;
  const msgs3 = [];
  global.isRunning = true;
  const res3 = await xPoster.start(
    { speed: 0, maxPosts: 1, outputFolder: OUT_DIR, profile: 'Default' },
    (s) => msgs3.push(s)
  );
  assert(res3.success === 1, 'run 3 published the 1 allotted post');
  assert(typedTexts[0] === 'DEFERRED_TEXT', 'run 3 retried the deferred post FIRST, as designed');
  const deferredMsg = msgs3.find(m => /إعادة محاولة منشور مؤجَّل/.test(m.message || ''));
  assert(!!deferredMsg, 'deferred retry gets its own distinct label');
  assert(!msgs3.some(m => /نشر المنشور رقم/.test(m.message || '')),
    'deferred retry is NOT folded into the sequential position counter (no fake "رقم N")');
  const posAfterRun3 = await queueManager.getProfilePosition('Default');
  assert(posAfterRun3 === 4, `deferred-retry success does NOT advance the normal cursor (still 4, got ${posAfterRun3})`);
  const deferredLeft = await queueManager.getDeferred('Default');
  assert(deferredLeft.length === 0, 'deferred entry removed after its successful retry');

  console.log(`\n${failed === 0 ? '✅' : '❌'} publish-position-display-v5.13.0: ${passed} passed, ${failed} failed`);
  try { fs.rmSync(SANDBOX, { recursive: true }); } catch (e) { /* best-effort */ }
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error('❌ test crashed:', e);
  try { fs.rmSync(SANDBOX, { recursive: true }); } catch (_) {}
  process.exit(1);
});
