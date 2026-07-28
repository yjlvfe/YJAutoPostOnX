'use strict';

/**
 * XP-002 — Stop wins before the boundary, yet a transport call still happened.
 *
 * The window: xPoster takes a baseline toast snapshot (an await), then commits
 * `beginDispatch` and presses Ctrl+Enter. `stop-automation` sets
 * global.isRunning = false and fires stopActive() without awaiting a join, so a
 * Stop landing during that snapshot await was simply not observed — the code
 * walked straight through the boundary and pressed the key. The probe measured
 * submitCalls=1 with stopFlagObservedBySubmit=true, and the post became
 * ambiguous: the operator pressed Stop and a tweet went out anyway.
 *
 * The barrier here is deterministic and needs no production test hook: the fake
 * page fires Stop from inside the very `page.$('[data-testid="toast"]')` call
 * that xPoster awaits immediately before the boundary. That reproduces the
 * probe's interleaving exactly, every run.
 *
 * "No transport" is measured as zero Ctrl+Enter presses reaching the fake
 * keyboard — the real side-effecting call — not by reading source text.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = path.join(os.tmpdir(), 'xposter-stop-race-' + Date.now());
os.homedir = () => SANDBOX;
process.env.HOME = SANDBOX; // belt-and-suspenders: see smoke.test.js for why
fs.mkdirSync(path.join(SANDBOX, '.config', 'x-poster-bot-profile'), { recursive: true });

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
}

// ── Fake browser ────────────────────────────────────────────────────────────
// `transportCalls` counts ONLY the irreversible action: Ctrl+Enter on the
// composer. Everything else is scaffolding.
const bus = {
  transportCalls: 0,
  stopFiredAt: null,
  onBaselineToast: null,   // barrier hook, set per scenario
  onTransport: null,
  onType: null,
  toastQueries: 0,
  pressed: [],
  typed: [],
};

function makeFakePage() {
  const fakeEl = (extra = {}) => ({ $: async () => fakeEl(), ...extra });
  return {
    goto: async () => {},
    bringToFront: async () => {},
    setViewportSize: async () => {},
    evaluate: async () => undefined,
    url: () => 'https://x.com/home',
    mouse: { move: async () => {}, wheel: async () => {} },
    keyboard: {
      press: async (key) => {
        bus.pressed.push(key);
        if (key === 'ControlOrMeta+Enter') {
          bus.transportCalls++;
          if (bus.onTransport) await bus.onTransport();
        }
      },
      type: async (text) => {
        bus.typed.push(text);
        if (bus.onType) await bus.onType();
      },
    },
    locator: () => ({ click: async () => {}, focus: async () => {} }),
    $: async (selector) => {
      if (selector === '[data-testid="toast"]') {
        bus.toastQueries++;
        // The FIRST toast query of a post is xPoster's pre-boundary baseline
        // snapshot. That is the await Stop has to be able to win.
        if (bus.toastQueries === 1 && bus.onBaselineToast) await bus.onBaselineToast();
        return fakeEl({
          $: async () => ({ getAttribute: async () => `/i/web/status/race${bus.transportCalls}` }),
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
const CFG = { speed: 0, minCooldownMs: 0, networkRecoveryMs: 0, outputFolder: OUT_DIR, profile: 'Default' };

function resetBus() {
  bus.transportCalls = 0;
  bus.stopFiredAt = null;
  bus.onBaselineToast = null;
  bus.onTransport = null;
  bus.onType = null;
  bus.toastQueries = 0;
  bus.pressed = [];
  bus.typed = [];
}

/**
 * Give a scenario a queue containing exactly its own post.
 *
 * Runs always start at the HEAD of the shared queue, so a post left behind by
 * an earlier scenario would be the one that actually gets published — and the
 * scenario would measure the wrong item while looking green.
 */
async function seedQueueWith(text) {
  await clearRecoveryGate();
  const leftovers = (await durableQueue.getQueue())
    .map((p) => (typeof p === 'string' ? p : p.text))
    .filter((t) => t !== text);
  if (leftovers.length) await durableQueue.bulkDeleteByText(leftovers);
  await durableQueue.addPosts([text]);
  const head = (await durableQueue.getQueue()).map((p) => (typeof p === 'string' ? p : p.text))[0];
  if (head !== text) throw new Error(`fixture failed: queue head is ${head}, expected ${text}`);
}

const ALL_STATES = ['queued', 'deferred', 'leased', 'dispatch_started', 'ambiguous', 'published', 'dead', 'discarded'];

/**
 * The store's root directory is captured when durableQueue loads, so scenarios
 * share one database. Every assertion is therefore scoped to the scenario's own
 * post text rather than to global counts.
 */
async function findByText(text) {
  const store = await durableQueue.getStore();
  for (const state of ALL_STATES) {
    for (const item of durableQueue.readAllItems(store, [state])) {
      if (durableQueue.textOf(item) === text) return { state, item };
    }
  }
  return { state: null, item: null };
}

/**
 * Resolve any leftover unresolved item so the global recovery gate is open for
 * the next scenario. An unresolved dispatch blocks publishing for EVERY
 * profile, which is correct behaviour but would otherwise make scenario N+1
 * silently measure nothing. Keyed by id, never by text.
 */
async function clearRecoveryGate() {
  const store = await durableQueue.getStore();
  for (const state of ['ambiguous', 'dispatch_started']) {
    for (const item of durableQueue.readAllItems(store, [state])) {
      try {
        store.resolveRecovery({
          id: item.id,
          action: 'close',
          evidence: { closedBy: 'test-fixture' },
          requestId: `fixture-close:${item.id}:${item.revision}`,
        });
      } catch { /* some states cannot be closed directly; scenario asserts its own text */ }
    }
  }
}

// ── XP-002.1 — Stop wins before the boundary ────────────────────────────────
async function stopWinsBeforeBoundary() {
  console.log('\n📋 XP-002.1 Stop wins during the pre-boundary await');
  resetBus();
  await seedQueueWith('STOP_RACE_A');

  let stopResult = null;
  bus.onBaselineToast = () => {
    // Exactly what ipcMain's 'stop-automation' does: flip the flag and kick off
    // stopActive() WITHOUT awaiting it.
    bus.stopFiredAt = 'baseline-toast';
    stopResult = xPoster.stopActive();
  };

  global.isRunning = true;
  const res = await xPoster.start({ ...CFG, maxPosts: 1 }, () => {});
  await stopResult;

  check('the transport was never invoked after Stop won', bus.transportCalls === 0,
    `transportCalls=${bus.transportCalls}, pressed=${JSON.stringify(bus.pressed)}`);

  const found = await findByText('STOP_RACE_A');
  check('the post is back in the queue, not stranded', found.state === 'queued',
    `state=${found.state}`);
  check('Stop did not create an ambiguous item — nothing was submitted',
    found.state !== 'ambiguous' && found.state !== 'dispatch_started', `state=${found.state}`);
  check('the run reports it was stopped', res.status === 'stopped', `status=${res.status}`);
  check('Stop did not spend the item\'s retry budget',
    found.item && (found.item.failureCount || 0) === 0,
    `failureCount=${found.item && found.item.failureCount}`);
}

// ── XP-002.2 — the boundary wins, Stop lands after the keystroke ─────────────
async function boundaryWinsThenStop() {
  console.log('\n📋 XP-002.2 boundary wins, Stop lands after the keystroke');
  resetBus();
  await seedQueueWith('STOP_RACE_B');

  let stopResult = null;
  bus.onTransport = () => {
    bus.stopFiredAt = 'after-transport';
    stopResult = xPoster.stopActive();
  };

  global.isRunning = true;
  await xPoster.start({ ...CFG, maxPosts: 1 }, () => {});
  await stopResult;

  check('exactly one transport call — never a second press for the same item',
    bus.transportCalls === 1, `transportCalls=${bus.transportCalls}`);

  const found = await findByText('STOP_RACE_B');
  check('a post that may be live is published or ambiguous, never queued again',
    found.state === 'published' || found.state === 'ambiguous', `state=${found.state}`);
  check('it is not dead-lettered or deferred',
    found.state !== 'dead' && found.state !== 'deferred', `state=${found.state}`);
}

// ── XP-002.3 — Stop during typing (well before the boundary) ────────────────
async function stopDuringTypingNeverDispatches() {
  console.log('\n📋 XP-002.3 Stop during composition');
  resetBus();
  await seedQueueWith('STOP_RACE_C');

  // xPoster destructures launchBrowser at module load, so the stub cannot be
  // swapped per scenario — the barrier goes through the shared bus instead.
  let stopResult = null;
  bus.onType = () => {
    if (!stopResult) { bus.stopFiredAt = 'typing'; stopResult = xPoster.stopActive(); }
  };

  global.isRunning = true;
  await xPoster.start({ ...CFG, maxPosts: 1 }, () => {});
  await stopResult;

  check('the composer was actually reached', bus.typed.length > 0, `typed=${JSON.stringify(bus.typed)}`);
  check('no transport call when Stop lands during composition', bus.transportCalls === 0,
    `transportCalls=${bus.transportCalls}`);
  const found = await findByText('STOP_RACE_C');
  check('the post stays queued', found.state === 'queued', `state=${found.state}`);
}

// ── XP-002.4 — Stop is idempotent and joins ─────────────────────────────────
async function stopIsIdempotent() {
  console.log('\n📋 XP-002.4 Stop twice is idempotent');
  resetBus();
  await clearRecoveryGate();

  global.isRunning = true;
  const first = await xPoster.stopActive();
  const second = await xPoster.stopActive();

  check('stopActive() resolves both times without throwing', !!first && !!second);
  check('stopActive() reports a settled result', first.stopped === true && second.stopped === true,
    `first=${JSON.stringify(first)} second=${JSON.stringify(second)}`);
  check('the second Stop reports there was nothing left to join',
    second.joined === 0 || second.runsJoined === 0 || second.dispatchInFlight === false,
    `second=${JSON.stringify(second)}`);
}

// ── XP-002.5 — the gate itself, both interleavings, many times ──────────────
async function gateLinearizationIsDeterministic() {
  console.log('\n📋 XP-002.5 gate linearization (1000 iterations, both orders)');
  const { RunToken } = require('../dev/automation/runControl');

  let stopFirstTransport = 0;
  let dispatchFirstTransport = 0;
  let dispatchFirstStopSawInFlight = 0;

  for (let i = 0; i < 1000; i++) {
    // Order A: Stop reaches the gate first ⇒ dispatch must be refused.
    const a = new RunToken({ runId: `a${i}` });
    a.requestStop('user_stop');
    if (a.tryEnterDispatch('post').ok) stopFirstTransport++;

    // Order B: dispatch reaches the gate first ⇒ Stop must observe it in flight
    // and must not claim it won before the attempt settles.
    const b = new RunToken({ runId: `b${i}` });
    const ticket = b.tryEnterDispatch('post');
    if (ticket.ok) dispatchFirstTransport++;
    const stop = b.requestStop('user_stop');
    if (stop.dispatchInFlight) dispatchFirstStopSawInFlight++;
    b.leaveDispatch(ticket.ticket, { outcome: 'published' });
    await stop.join(1000);
  }

  check('Stop-first NEVER lets a dispatch through (0/1000)', stopFirstTransport === 0,
    `let through ${stopFirstTransport} times`);
  check('dispatch-first always proceeds (1000/1000)', dispatchFirstTransport === 1000,
    `proceeded ${dispatchFirstTransport} times`);
  check('Stop always observes an in-flight dispatch instead of claiming an early win',
    dispatchFirstStopSawInFlight === 1000, `observed ${dispatchFirstStopSawInFlight} times`);
}

// ── XP-002.6 — no new run may start while a stop is joining ─────────────────
async function noNewRunWhileStopping() {
  console.log('\n📋 XP-002.6 a new run is refused while stopping');
  resetBus();
  await seedQueueWith('STOP_RACE_D');

  // A stop is only genuinely "in progress" while it is joining a committed
  // dispatch. Recreate that window: fire Stop from inside the keystroke, so the
  // gate ticket is still held, and attempt a second run right there.
  let stopResult = null;
  let concurrent = null;
  let sawStopping = null;
  bus.onTransport = async () => {
    bus.stopFiredAt = 'after-transport';
    stopResult = xPoster.stopActive();
    sawStopping = true;
    concurrent = await xPoster.start({ ...CFG, maxPosts: 1, profile: 'Default' }, () => {});
  };

  global.isRunning = true;
  await xPoster.start({ ...CFG, maxPosts: 1 }, () => {});
  await stopResult;

  check('the window under test was actually entered', sawStopping === true);
  check('a second run started while the stop is joining is refused',
    concurrent && concurrent.status === 'refused',
    `status=${concurrent && concurrent.status}, reason=${concurrent && concurrent.reason}`);
  check('the refused run performed no transport of its own',
    bus.transportCalls === 1, `transportCalls=${bus.transportCalls}`);
}

(async () => {
  console.log('=== XP-002: Stop vs dispatch boundary ===');
  try {
    await stopWinsBeforeBoundary();
    await boundaryWinsThenStop();
    await stopDuringTypingNeverDispatches();
    await stopIsIdempotent();
    await gateLinearizationIsDeterministic();
    await noNewRunWhileStopping();
  } catch (error) {
    failed++;
    console.error('\n❌ suite threw:', error && error.stack ? error.stack : error);
  }
  try { await durableQueue.closeStore(); } catch { /* best effort */ }
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(`\n${failed === 0 ? '✅' : '❌'} workflow-stop-boundary-race: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
