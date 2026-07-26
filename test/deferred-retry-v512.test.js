/**
 * ⏸️ Deferred retry vs. permanent retirement — Regression Test
 * ================================================================================
 * User requirement: on a TRANSIENT (network) publish failure, try the next post
 * immediately instead of stalling, but don't permanently lose this one — it must
 * come back automatically. Non-transient failures (selector/platform/unknown)
 * are retired instead, so a post that can never go out cannot block the queue.
 *
 * The retry budget used to be a JSON attempt counter beside the queue. It now
 * lives in the workflow store: markDeferred increments a durable pre-dispatch
 * failure count and retires the item once the budget is spent. That means the
 * counter can no longer disagree with the queue, and it survives a crash.
 *
 * Every assertion below is BEHAVIOURAL — this file used to grep xPoster.js for
 * the names of functions it expected to be called, which passes happily while
 * the engine is completely broken and fails loudly on a rename that changed
 * nothing. The three real hazards are pinned by driving the engine instead:
 *
 *   H1  A transient failure must not consume the post — deferring is a delay.
 *   H2  A post that can NEVER go out must eventually be retired, not retried
 *       forever at the head of the queue.
 *   H3  Playwright's native locator actions throw their OWN errors.TimeoutError
 *       on a genuine DOM/selector regression. If the classifier checks the
 *       error NAME before the selector message, a real breakage is mis-bucketed
 *       as 'network' and defers silently forever instead of surfacing.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const SANDBOX = path.join(os.tmpdir(), 'xposter-deferred-test-' + Date.now());
os.homedir = () => SANDBOX;
fs.mkdirSync(path.join(SANDBOX, '.config', 'x-poster-bot-profile'), { recursive: true });

let passed = 0;
let failed = 0;
function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}

// ── Fake browser: fails typing with a caller-chosen error ────────────────
// `nextError` decides how the composer fails, which is what the classifier
// reads. Anything not listed types successfully and publishes.
let nextError = null;
let statusSeq = 0;

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
      press: async () => {},
      type: async () => { if (nextError) throw nextError(); },
    },
    locator: () => ({ click: async () => {}, focus: async () => {} }),
    $: async (selector) => {
      if (selector === '[data-testid="toast"]') {
        statusSeq++;
        return fakeEl({
          $: async () => ({ getAttribute: async () => `/i/web/status/def${statusSeq}` }),
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
const { ReportEngine } = require('../dev/automation/reportEngine');

const OUT_DIR = path.join(SANDBOX, 'out');

/** A Playwright-style TimeoutError raised by a native locator action. */
function locatorTimeout() {
  const err = new Error(
    'locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for locator(\'[data-testid="tweetTextarea_0"]\')'
  );
  err.name = 'TimeoutError';
  return err;
}

function networkDown() {
  return new Error('net::ERR_INTERNET_DISCONNECTED');
}

async function stateOf(text) {
  const store = await durableQueue.getStore();
  const all = durableQueue.readAllItems(store,
    ['queued', 'deferred', 'leased', 'dispatch_started', 'published', 'dead', 'ambiguous', 'discarded']);
  const match = all.find((item) => durableQueue.textOf(item) === text);
  return match ? match.state : null;
}

/** Make every deferred item eligible again, as elapsed time would. */
async function elapseBackoff() {
  const store = await durableQueue.getStore();
  store.db.prepare("UPDATE workflow_items SET available_at_ms = ? WHERE state = 'deferred'")
    .run(Date.now() - 1);
}

async function runOnce(maxPosts = 1) {
  global.isRunning = true;
  return xPoster.start(
    // The timing floors are zeroed: this file exercises failure CLASSIFICATION
    // and the retry budget, neither of which has anything to do with waiting.
    // publish-fixes-v511 pins the real production floors.
    { speed: 0, minCooldownMs: 0, networkRecoveryMs: 0, maxPosts, outputFolder: OUT_DIR, profile: 'Default' },
    () => {}
  );
}

async function main() {
  // ── H1: a transient failure defers, it does not consume ────────────────
  console.log('📋 A transient (network) failure defers the post instead of consuming it');
  await durableQueue.addPosts(['NET_FAIL']);
  nextError = networkDown;
  const res1 = await runOnce();

  assert(await stateOf('NET_FAIL') === 'deferred',
    `a network failure leaves the post DEFERRED (got ${await stateOf('NET_FAIL')}) — it was never submitted, so it must not be consumed`);
  assert(res1.failed === 1, `the failure is reported to the user (got failed=${res1.failed})`);
  assert(!(await durableQueue.getPublishedTexts()).includes('NET_FAIL'),
    'a post that never went out is not archived as published');

  // Deferral is a delay with a return date, not a verdict.
  //
  // "Not offered again" is about what a worker may CLAIM, which is the
  // ready-now view. It is not about what the operator can SEE: this assertion
  // used to read getQueue(), so satisfying it meant the queue screen showed
  // nothing at all while a post sat in backoff — the operator re-added it and
  // it published twice (XP-005). The two views are now separate, and both
  // halves are pinned here.
  const readyDuringBackoff = (await durableQueue.getReadyNow()).map(durableQueue.textOf);
  assert(!readyDuringBackoff.includes('NET_FAIL'),
    'while the backoff runs the post is not offered again — that is what stops a dead connection spinning the whole queue');
  assert((await durableQueue.getQueue()).includes('NET_FAIL'),
    'a deferred post stays VISIBLE in the backlog — an invisible post gets re-added and published twice');
  await elapseBackoff();
  assert((await durableQueue.getQueue()).includes('NET_FAIL'),
    'once the backoff elapses the post is publishable again, with no user action');

  // And it really does publish once the network recovers.
  nextError = null;
  await runOnce();
  assert(await stateOf('NET_FAIL') === 'published',
    'the deferred post publishes normally when the transient cause clears');

  // ── H2: a post that can never go out is retired ────────────────────────
  console.log('📋 A permanently-failing post is retired instead of blocking the head forever');
  await durableQueue.addPosts(['POISON', 'BEHIND_POISON']);
  nextError = networkDown;

  const store = await durableQueue.getStore();
  const budget = store.maxPreDispatchFailures;
  const failureCountOf = (text) => store.db
    .prepare("SELECT pre_dispatch_failure_count AS n FROM workflow_items WHERE json_extract(payload_json, '$.text') = ?")
    .get(text).n;

  // One real run over BOTH posts. A failing post must not stall the run.
  await runOnce(2);
  assert(await stateOf('POISON') === 'deferred' && await stateOf('BEHIND_POISON') === 'deferred',
    'the run reached the post BEHIND the failing one — a failure never blocks the head of the queue');
  assert(failureCountOf('POISON') === 1,
    `a real failed run increments the DURABLE failure count (got ${failureCountOf('POISON')}) — the budget survives a crash, unlike the old in-memory counter`);

  // Fast-forward POISON to its last permitted failure and drive another REAL
  // run, so the retirement itself is exercised rather than simulated. Only the
  // clock and the counter are fast-forwarded; every transition is the engine's.
  // BEHIND_POISON is held back so the claim is unambiguous — a deferred post
  // re-enters at the TAIL of the queue, not at its old position.
  store.db.prepare(
    "UPDATE workflow_items SET pre_dispatch_failure_count = ?, available_at_ms = ? WHERE json_extract(payload_json, '$.text') = ?"
  ).run(budget - 1, Date.now() - 1, 'POISON');
  store.db.prepare(
    "UPDATE workflow_items SET available_at_ms = ? WHERE json_extract(payload_json, '$.text') = ?"
  ).run(Date.now() + 3_600_000, 'BEHIND_POISON');
  await runOnce(1);

  assert(await stateOf('POISON') === 'dead',
    `POISON is retired to 'dead' once its ${budget}-failure budget is spent (got ${await stateOf('POISON')}) — a post that can never publish must not defer forever`);

  // Retired does not mean lost: it stays visible and requeueable.
  const recovery = await durableQueue.getRecoveryItems('Default');
  assert(recovery.deadLetters.some(d => d.text === 'POISON'),
    'a retired post stays visible in the recovery list — nothing is silently discarded');
  assert(await durableQueue.requeueRecovery('Default', 'dead', 'POISON'),
    'the user can put a retired post back in the queue');
  assert((await durableQueue.getQueue()).includes('POISON'), 'the requeued post is publishable again');
  await durableQueue.bulkDeleteByText(['POISON', 'BEHIND_POISON']);

  // ── H3: a real selector regression must NOT be treated as network ───────
  console.log('📋 A genuine locator regression surfaces instead of deferring silently');
  await durableQueue.addPosts(['SELECTOR_BREAK']);
  nextError = locatorTimeout;
  await runOnce();

  const selectorState = await stateOf('SELECTOR_BREAK');
  assert(selectorState === 'dead',
    `a locator TimeoutError is classified 'selector' and retired immediately (got ${selectorState}) — checking error.name first would bucket it as 'network' and defer it silently forever`);

  const afterSelector = await durableQueue.getRecoveryItems('Default');
  const deadEntry = afterSelector.deadLetters.find(d => d.text === 'SELECTOR_BREAK');
  assert(!!deadEntry && deadEntry.reason === 'selector',
    `the retirement reason names the real cause (got ${deadEntry ? deadEntry.reason : 'none'}) — the operator needs to know a SELECTOR broke, not "it failed"`);
  await durableQueue.bulkDeleteByText(['SELECTOR_BREAK']);

  // ── reportEngine 'deferred' status support ─────────────────────────────
  // A deferred post is neither a success nor a permanent failure. Collapsing it
  // into 'unconfirmed' would tell the user a post may be live on X when nothing
  // was ever submitted.
  console.log('📋 reportEngine: deferred is its own outcome');
  const re = new ReportEngine(path.join(SANDBOX, 'reports'));
  re.startRun();
  re.recordPostResult({ postId: 'p1', text: 'x', status: 'deferred', attempts: 3, errorType: 'network', lastError: 'timeout' });
  assert(re.stats.deferred === 1, 'deferred status increments stats.deferred, not unconfirmed');
  assert(re.stats.unconfirmed === 0, 'deferred status does NOT get coerced into unconfirmed');
  assert(re.failures.length === 1 && re.failures[0].finalStatus === 'deferred',
    'deferred entries are tracked in failures[] for diagnostic visibility (errorType/lastError preserved)');
  re.endTime = new Date().toISOString();
  const report = re.generateReport();
  assert(report.stats.deferred === 1, 'generateReport() surfaces the deferred count');
  assert(/Deferred/.test(re.generateTextReport(report)), 'human-readable text report includes a Deferred line');

  console.log(`\n${failed === 0 ? '✅' : '❌'} deferred-retry: ${passed} passed, ${failed} failed`);
  await durableQueue.closeStore();
  try { fs.rmSync(SANDBOX, { recursive: true }); } catch (e) { /* best-effort */ }
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('❌ test crashed:', e);
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (_) {}
  process.exit(1);
});
