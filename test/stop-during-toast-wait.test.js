/**
 * 🛑 Regression test for a gap an independent review found in the
 * crash/stop-recovery fix: a STOPPED_BY_USER thrown from INSIDE
 * waitForPostConfirmation — i.e. AFTER Ctrl+Enter was already pressed and
 * markPosting() already wrote the durable marker, the single highest-risk
 * moment for a duplicate/lost post — used to unwind straight past the retry
 * loop's "stopping is not a publishing failure" handling. That handling only
 * ran on a NORMAL loop exit, so the exception path left a stale
 * posting-state.json marker and the post silently missing from that run's
 * own stats, only picked up by the NEXT run's startup recovery pass.
 *
 * This drives the REAL xPoster.start() against a fake browser that never
 * produces a toast and flips global.isRunning=false mid-poll (simulating
 * Stop pressed while waiting for confirmation), and asserts the post is
 * quarantined to pending-verification IMMEDIATELY — not one run later.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const SANDBOX = path.join(os.tmpdir(), 'xposter-stop-during-toast-' + Date.now());
os.homedir = () => SANDBOX;
fs.mkdirSync(path.join(SANDBOX, '.config', 'x-poster-bot-profile'), { recursive: true });

let passed = 0;
let failed = 0;
function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}

function makeFakePage() {
  let toastPolls = 0;
  const fakeEl = (extra = {}) => ({ $: async () => fakeEl(), ...extra });
  return {
    goto: async () => {},
    bringToFront: async () => {},
    setViewportSize: async () => {},
    evaluate: async () => undefined,
    url: () => 'https://x.com/home',
    mouse: { move: async () => {}, wheel: async () => {} },
    keyboard: { press: async () => {}, type: async () => {} },
    locator: () => ({ click: async () => {}, focus: async () => {} }),
    $: async (selector) => {
      if (selector === '[data-testid="toast"]') {
        toastPolls++;
        // Poll #1 is the pre-Ctrl+Enter baseline (always empty). Poll #2 is
        // the FIRST check made from inside waitForPostConfirmation — i.e.
        // after Ctrl+Enter/markPosting already ran. Simulate the user
        // pressing Stop right there: no toast ever arrives.
        if (toastPolls === 2) global.isRunning = false;
        return null;
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
  await queueManager.addPosts(['STOP_MID_TOAST']);

  global.isRunning = true;
  const res = await xPoster.start(
    { speed: 0, maxPosts: 1, outputFolder: OUT_DIR, profile: 'Default' },
    () => {}
  );

  assert(res.status === 'stopped', `run reports status 'stopped' (got ${res.status})`);
  assert(res.unconfirmed === 1,
    `the interrupted post is counted in THIS run's own stats, not silently dropped (got unconfirmed=${res.unconfirmed})`);

  const pending = await queueManager.getPending('Default');
  assert(pending.some(p => p.text === 'STOP_MID_TOAST' && p.reason === 'stopped_after_submit'),
    "the post lands in pending-verification with reason 'stopped_after_submit' IMMEDIATELY — not only after the next run's startup recovery");

  const queue = (await queueManager.getQueue()).map(p => (typeof p === 'string' ? p : p.text));
  assert(!queue.includes('STOP_MID_TOAST'),
    'the post is removed from the live queue so a later run cannot auto-repost it');

  console.log(`\n${failed === 0 ? '✅' : '❌'} stop-during-toast-wait: ${passed} passed, ${failed} failed`);
  try { fs.rmSync(SANDBOX, { recursive: true }); } catch (e) { /* best-effort */ }
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error('❌ test crashed:', e);
  try { fs.rmSync(SANDBOX, { recursive: true }); } catch (_) {}
  process.exit(1);
});
