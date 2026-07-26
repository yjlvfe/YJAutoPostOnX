'use strict';

/**
 * XP-007 — the run summary disagreed with the database.
 *
 * `successCount++` ran BEFORE `markPublished` committed. When the commit then
 * failed on the UNIQUE external_url constraint, the item was correctly moved to
 * `ambiguous` — but the increment had already happened and was never undone. A
 * probe measured a run reporting success=2, unconfirmed=1 against a store
 * holding published=1, ambiguous=1. The operator was told two posts went out
 * and the archive knew about one.
 *
 * The invariant: a post counts as a success only once its published row is
 * committed, and the outcomes are mutually exclusive.
 *
 * This drives the real xPoster loop over a fake browser whose toast hands back
 * the SAME status URL twice, which is exactly what makes the second commit
 * collide.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = path.join(os.tmpdir(), 'xposter-outcome-truth-' + Date.now());
os.homedir = () => SANDBOX;
fs.mkdirSync(path.join(SANDBOX, '.config', 'x-poster-bot-profile'), { recursive: true });

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
}

// A toast that always reports the SAME status URL. The first post commits it;
// the second collides on external_url UNIQUE.
const STUCK_URL = '/i/web/status/stuck-duplicate';

function makeFakePage() {
  const fakeEl = (extra = {}) => ({ $: async () => fakeEl(), ...extra });
  // The toast must APPEAR as a result of the keystroke, or xPoster's baseline
  // snapshot and its confirmation poll see the same signature and the post is
  // classified unconfirmed — which would never reach the commit under test.
  // Typing marks the start of a new post, so the toast resets with it.
  let submitted = false;
  return {
    goto: async () => {},
    bringToFront: async () => {},
    setViewportSize: async () => {},
    evaluate: async () => undefined,
    url: () => 'https://x.com/home',
    mouse: { move: async () => {}, wheel: async () => {} },
    keyboard: {
      press: async (key) => { if (key === 'ControlOrMeta+Enter') submitted = true; },
      type: async () => { submitted = false; },
    },
    locator: () => ({ click: async () => {}, focus: async () => {} }),
    $: async (selector) => {
      if (selector === '[data-testid="toast"]') {
        if (!submitted) return null;         // nothing on screen yet
        return fakeEl({ $: async () => ({ getAttribute: async () => STUCK_URL }) });
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

async function countInState(state) {
  const store = await durableQueue.getStore();
  return durableQueue.readAllItems(store, [state]).length;
}

async function duplicateUrlDoesNotInflateSuccess() {
  console.log('\n📋 XP-007.1 duplicate external URL');

  await durableQueue.addPosts(['TRUTH_1', 'TRUTH_2']);
  global.isRunning = true;
  const res = await xPoster.start(
    { speed: 0, minCooldownMs: 0, networkRecoveryMs: 0, maxPosts: 2, outputFolder: OUT_DIR, profile: 'Default' },
    () => {},
  );

  const published = await countInState('published');
  const ambiguous = await countInState('ambiguous');

  console.log(`      run reported: success=${res.success} unconfirmed=${res.unconfirmed}`);
  console.log(`      store holds : published=${published} ambiguous=${ambiguous}`);

  check('exactly one post committed as published', published === 1, `published=${published}`);
  check('the colliding post is parked as ambiguous', ambiguous === 1, `ambiguous=${ambiguous}`);

  // THE BUG: this used to be 2.
  check('the run reports exactly as many successes as committed published rows',
    res.success === published, `success=${res.success} published=${published}`);
  check('the ambiguous post is counted as unconfirmed, not as a success',
    res.unconfirmed === ambiguous, `unconfirmed=${res.unconfirmed} ambiguous=${ambiguous}`);

  const total = res.success + res.unconfirmed + res.failed;
  check('every post the run owned has exactly one outcome', total === 2,
    `success=${res.success} unconfirmed=${res.unconfirmed} failed=${res.failed}`);
  check('an ambiguous outcome never also counts as success',
    res.success + res.unconfirmed === published + ambiguous,
    `reported=${res.success + res.unconfirmed} durable=${published + ambiguous}`);
}

/**
 * XP-003 — the transport executed its side effect and THEN rejected.
 *
 * `postingAttempted` used to be assigned after the await, so a rejection from a
 * keystroke that had already reached the page left pastBoundary=true with
 * postingAttempted=false. The unwind then attempted markTerminal from
 * `dispatch_started`, hit INVALID_STATE, and stranded the item there — visible
 * in neither the queue nor the recovery screen, and blocking every profile
 * until a restart reconciled it.
 */
async function postBoundaryRejectionBecomesAmbiguous() {
  console.log('\n📋 XP-003.1 side effect executed, then the promise rejected');

  // A page whose Ctrl+Enter DOES the thing and then throws.
  const rejectingBrowser = {
    launchBrowser: async () => {
      const fakeEl = (extra = {}) => ({ $: async () => fakeEl(), ...extra });
      let submitted = false;
      const page = {
        goto: async () => {},
        bringToFront: async () => {},
        setViewportSize: async () => {},
        evaluate: async () => undefined,
        url: () => 'https://x.com/home',
        mouse: { move: async () => {}, wheel: async () => {} },
        keyboard: {
          press: async (key) => {
            if (key === 'ControlOrMeta+Enter') {
              submitted = true;                       // the side effect happened
              throw new Error('Target page, context or browser has been closed');
            }
          },
          type: async () => { submitted = false; },
        },
        locator: () => ({ click: async () => {}, focus: async () => {} }),
        $: async (selector) => {
          if (selector === '[data-testid="toast"]') {
            if (!submitted) return null;
            return fakeEl({ $: async () => ({ getAttribute: async () => '/i/web/status/rejected-1' }) });
          }
          return fakeEl();
        },
      };
      return { pages: () => [page], close: async () => {} };
    },
  };

  // Resolve any leftover unresolved item so the gate is open for this scenario.
  const store = await durableQueue.getStore();
  for (const state of ['ambiguous', 'dispatch_started']) {
    for (const item of durableQueue.readAllItems(store, [state])) {
      try {
        store.resolveRecovery({
          id: item.id, action: 'close', evidence: { closedBy: 'test-fixture' },
          requestId: `fixture-close:${item.id}:${item.revision}`,
        });
      } catch { /* best effort */ }
    }
  }

  require.cache[browserManagerPath].exports = rejectingBrowser;
  // xPoster destructured launchBrowser at load time, so reload it against the
  // rejecting stub rather than mutating an already-captured binding.
  delete require.cache[require.resolve('../dev/automation/xPoster')];
  const rejectingPoster = require('../dev/automation/xPoster');

  await durableQueue.addPosts(['REJECT_AFTER_SUBMIT']);
  global.isRunning = true;
  await rejectingPoster.start(
    { speed: 0, minCooldownMs: 0, networkRecoveryMs: 0, maxPosts: 1, outputFolder: OUT_DIR, profile: 'Default' },
    () => {},
  );

  let found = null;
  for (const state of ['queued', 'deferred', 'leased', 'dispatch_started', 'ambiguous', 'published', 'dead']) {
    for (const item of durableQueue.readAllItems(store, [state])) {
      if (durableQueue.textOf(item) === 'REJECT_AFTER_SUBMIT') found = { state, item };
    }
  }

  check('the item is not stranded in dispatch_started',
    found && found.state !== 'dispatch_started', `state=${found && found.state}`);
  check('a post whose side effect may have landed is ambiguous, not requeued',
    found && found.state === 'ambiguous', `state=${found && found.state}`);
  check('it was never dead-lettered or deferred',
    found && found.state !== 'dead' && found.state !== 'deferred', `state=${found && found.state}`);
  check('it is visible for manual reconciliation',
    store.countUnresolvedRecovery() >= 1, `unresolved=${store.countUnresolvedRecovery()}`);
}

(async () => {
  console.log('=== XP-007 / XP-003: reported outcomes match the database ===');
  try {
    await duplicateUrlDoesNotInflateSuccess();
    await postBoundaryRejectionBecomesAmbiguous();
  } catch (error) {
    failed++;
    console.error('\n❌ suite threw:', error && error.stack ? error.stack : error);
  }
  try { await durableQueue.closeStore(); } catch { /* best effort */ }
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(`\n${failed === 0 ? '✅' : '❌'} workflow-outcome-truth: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
