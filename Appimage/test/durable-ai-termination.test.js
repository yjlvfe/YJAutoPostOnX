'use strict';

/**
 * XP-001 / XP-009 — AI session termination, budgets, and worker caps.
 *
 * The bug this pins down: a session that hit a terminal auth failure (401/403)
 * was marked `_terminal` and its loop returned — but `spawnMissing()` only
 * checked whether a session had a *live loop promise*, not whether it was
 * allowed to run again. Every surviving sibling called `spawnMissing()` at each
 * of its own round boundaries, so the dead session was resurrected and burned
 * another provider call, forever. Two workers on a bad API key reached 50
 * requests and only stopped because the probe cancelled from outside.
 *
 * Everything here drives the REAL SessionManager from dev/automation. The
 * provider is a counting fake, so "no extra request" is proven by the call
 * count on the production code path, not by reading source text.
 *
 * Every test is bounded twice — by a wall-clock timeout AND by a call-count
 * guard that cancels the manager — so a regression fails loudly instead of
 * hanging the suite.
 */

const assert = require('assert');
const {
  SessionManager,
  STATUS,
  HARD_LIMITS,
} = require('../dev/automation/sessionManager');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.log(`  ✗ ${name}\n      ${error.message}`);
  }
}

/**
 * A manager that never terminates must fail the test, not wedge the runner.
 *
 * The guard timer is deliberately NOT unref'd. Every timer inside SessionManager
 * is unref'd, so while the pool sits in a backoff there is nothing left holding
 * the event loop open and node would exit 0 in the middle of the suite —
 * silently "passing" the very tests that are supposed to catch a spinning pool.
 */
function withTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`TIMEOUT after ${ms}ms: ${label}`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/** Engine stub — the dedup/context/angle helpers the manager calls each round. */
function fakeEngine(overrides = {}) {
  return {
    syncSessionDedup() {},
    buildAcceptedContext() { return ''; },
    selectAngles() { return [{ id: 'a1', label: 'angle' }]; },
    ...overrides,
  };
}

function authError() {
  const error = new Error('401 Unauthorized — invalid api key');
  error.status = 401;
  return error;
}

/**
 * Build a manager whose provider is a counting fake. `callGuard` force-cancels
 * once the count passes a ceiling so a respawn regression is measurable rather
 * than infinite.
 */
function harness({ sessionCount = 1, callCeiling = 25, runRound, ingest, engine, ...rest } = {}) {
  const state = { calls: 0, cancelled: false, perSession: new Map() };
  const manager = new SessionManager({
    engine: engine || fakeEngine(),
    runRound: async (args) => {
      state.calls++;
      const n = args.session.num;
      state.perSession.set(n, (state.perSession.get(n) || 0) + 1);
      if (state.calls >= callCeiling) state.cancelled = true;
      return runRound(args, state);
    },
    ingest: ingest || (() => 0),
    isCancelled: () => state.cancelled,
    sessionCount,
    // Keep backoff microscopic: this suite measures call counts, not sleeping.
    baseBackoffMs: 50,
    maxBackoffMs: 60,
    ...rest,
  });
  return { manager, state };
}

// ── XP-001.1 — one worker, terminal auth failure ─────────────────────────────
async function singleWorkerTerminalStopsAtOneCall() {
  console.log('\n📋 XP-001.1 single worker, 401');
  const { manager, state } = harness({
    sessionCount: 1,
    runRound: async () => { throw authError(); },
  });

  const result = await withTimeout(manager.run(() => false), 10_000, 'single worker 401');

  check('exactly one provider call — the terminal session is never re-sent', () => {
    assert.strictEqual(state.calls, 1, `expected 1 call, got ${state.calls}`);
  });
  check('manager reports a typed failure, not success', () => {
    assert.ok(result, 'run() must return a result object');
    assert.strictEqual(result.status, 'failed', `expected status "failed", got ${JSON.stringify(result && result.status)}`);
  });
  check('failure names the reason', () => {
    assert.strictEqual(result.reason, 'all_workers_terminal');
  });
  check('the session is in the terminal lifecycle state', () => {
    assert.strictEqual(manager.sessions[0].status, STATUS.TERMINAL);
  });
  check('the run never claims the target was met', () => {
    assert.strictEqual(result.targetMet, false);
  });
}

// ── XP-001.2 — two workers, both terminal ────────────────────────────────────
async function twoWorkersTerminalEachCalledOnce() {
  console.log('\n📋 XP-001.2 two workers, both 401');
  const { manager, state } = harness({
    sessionCount: 2,
    runRound: async () => { throw authError(); },
  });

  const result = await withTimeout(manager.run(() => false), 10_000, 'two workers 401');

  check('exactly two provider calls total — no cross-worker resurrection', () => {
    assert.strictEqual(state.calls, 2, `expected 2 calls, got ${state.calls}`);
  });
  check('each worker was called exactly once', () => {
    assert.strictEqual(state.perSession.get(1), 1, `session 1: ${state.perSession.get(1)}`);
    assert.strictEqual(state.perSession.get(2), 1, `session 2: ${state.perSession.get(2)}`);
  });
  check('manager ends failed, not success', () => {
    assert.strictEqual(result.status, 'failed');
  });
  check('the manager did not need an external cancel to stop', () => {
    assert.strictEqual(state.cancelled, false, 'call ceiling was hit — the pool was still spinning');
  });
}

// ── XP-001.3 — one terminal worker must not starve a healthy one ─────────────
async function terminalWorkerDoesNotBlockHealthyWorker() {
  console.log('\n📋 XP-001.3 one terminal + one healthy');
  let accepted = 0;
  const target = 6;
  const { manager, state } = harness({
    sessionCount: 2,
    callCeiling: 40,
    runRound: async ({ session }) => {
      if (session.num === 1) throw authError();
      return { cores: ['x'], usage: { input: 1, output: 1 } };
    },
    ingest: () => { accepted += 2; return 2; },
  });

  const result = await withTimeout(manager.run(() => accepted >= target), 10_000, 'mixed pool');

  check('the terminal worker made exactly one call', () => {
    assert.strictEqual(state.perSession.get(1), 1, `session 1 calls: ${state.perSession.get(1)}`);
  });
  check('the healthy worker reached the target', () => {
    assert.ok(accepted >= target, `accepted=${accepted}`);
  });
  check('the run reports success because the target was met', () => {
    assert.strictEqual(result.status, 'success');
    assert.strictEqual(result.targetMet, true);
  });
  check('the terminal session is still terminal, not revived to waiting', () => {
    assert.strictEqual(manager.sessions[0].status, STATUS.TERMINAL);
  });
}

// ── XP-001.4 — every worker terminal: no hang, no false success ──────────────
async function allWorkersTerminalEndsImmediately() {
  console.log('\n📋 XP-001.4 all workers terminal');
  const { manager, state } = harness({
    sessionCount: 4,
    callCeiling: 40,
    runRound: async () => { throw authError(); },
  });

  const started = Date.now();
  const result = await withTimeout(manager.run(() => false), 10_000, 'all terminal');
  const elapsed = Date.now() - started;

  check('one call per worker and no more', () => {
    assert.strictEqual(state.calls, 4, `expected 4 calls, got ${state.calls}`);
  });
  check('the manager returns promptly instead of idling', () => {
    assert.ok(elapsed < 5000, `took ${elapsed}ms`);
  });
  check('status is failed with all_workers_terminal', () => {
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.reason, 'all_workers_terminal');
  });
  check('no worker is left in a runnable state', () => {
    const runnable = manager.sessions.filter(s => s.status === STATUS.RUNNING || s.status === STATUS.WAITING);
    assert.strictEqual(runnable.length, 0, `runnable sessions: ${runnable.length}`);
  });
}

// ── XP-001.5 — ingest() throwing must consume budget, not spin ───────────────
async function throwingIngestIsBounded() {
  console.log('\n📋 XP-001.5 ingest() always throws');
  const { manager, state } = harness({
    sessionCount: 2,
    callCeiling: 60,
    runRound: async () => ({ cores: ['x'], usage: { input: 1, output: 1 } }),
    ingest: () => { throw new Error('ingest exploded'); },
    maxConsecutiveFailures: 3,
  });

  const result = await withTimeout(manager.run(() => false), 20_000, 'throwing ingest');

  check('provider calls stay inside the consecutive-failure budget', () => {
    // 2 workers × 3 allowed consecutive failures = 6.
    assert.ok(state.calls <= 6, `expected <= 6 calls, got ${state.calls}`);
  });
  check('the loop stopped on its own, without the external cancel guard', () => {
    assert.strictEqual(state.cancelled, false, 'call ceiling hit — the error path was retrying without a budget');
  });
  check('result is a typed failure', () => {
    assert.strictEqual(result.status, 'failed');
  });
}

// ── XP-001.6 — pre-round engine throws must consume budget too ───────────────
async function throwingEngineStepsAreBounded() {
  console.log('\n📋 XP-001.6 engine pipeline throws');
  for (const method of ['syncSessionDedup', 'buildAcceptedContext', 'selectAngles']) {
    const { manager, state } = harness({
      sessionCount: 1,
      callCeiling: 30,
      engine: fakeEngine({ [method]: () => { throw new Error(`${method} exploded`); } }),
      runRound: async () => ({ cores: [], usage: {} }),
      maxConsecutiveFailures: 3,
    });

    const result = await withTimeout(manager.run(() => false), 20_000, `throwing ${method}`);

    check(`${method}: bounded, no provider call escapes`, () => {
      assert.strictEqual(state.calls, 0, `expected 0 provider calls, got ${state.calls}`);
    });
    check(`${method}: manager ends failed rather than looping`, () => {
      assert.strictEqual(result.status, 'failed');
      assert.strictEqual(state.cancelled, false, 'external ceiling was needed to stop the loop');
    });
  }
}

// ── XP-001.7 — cancel during backoff exits promptly and does not restart ─────
async function cancelDuringBackoffIsBounded() {
  console.log('\n📋 XP-001.7 cancel during backoff');
  let cancelled = false;
  let calls = 0;
  const manager = new SessionManager({
    engine: fakeEngine(),
    runRound: async () => { calls++; return { cores: [], usage: { input: 1 } }; },
    ingest: () => 0,                       // no progress ⇒ the loop backs off
    isCancelled: () => cancelled,
    sessionCount: 2,
    baseBackoffMs: 400,
    maxBackoffMs: 400,
  });

  const running = manager.run(() => false);
  setTimeout(() => { cancelled = true; }, 250);
  const started = Date.now();
  const result = await withTimeout(running, 10_000, 'cancel during backoff');
  const elapsed = Date.now() - started;
  const callsAtStop = calls;
  await new Promise(r => setTimeout(r, 300));

  check('the run exits within the backoff window, not after it', () => {
    assert.ok(elapsed < 3000, `took ${elapsed}ms`);
  });
  check('cancellation is reported as cancelled, never success', () => {
    assert.strictEqual(result.status, 'cancelled');
    assert.strictEqual(result.targetMet, false);
  });
  check('no provider call happens after run() resolved', () => {
    assert.strictEqual(calls, callsAtStop, `calls grew from ${callsAtStop} to ${calls} after the run ended`);
  });
}

// ── XP-001.8 — the headline invariant ────────────────────────────────────────
async function successOnlyWhenTargetMet() {
  console.log('\n📋 XP-001.8 success ⇔ target met');
  let accepted = 0;
  const target = 10;
  const { manager } = harness({
    sessionCount: 1,
    callCeiling: 40,
    runRound: async () => ({ cores: ['x'], usage: { input: 1 } }),
    // Only ever reaches 4 of 10, then stalls.
    ingest: () => { if (accepted < 4) { accepted += 2; return 2; } return 0; },
    maxNoProgressRounds: 3,
  });

  const result = await withTimeout(manager.run(() => accepted >= target), 20_000, 'partial target');

  check('a run that fell short is "partial", never "success"', () => {
    assert.strictEqual(result.status, 'partial', `got ${result.status}`);
  });
  check('the partial result carries the reason it stopped', () => {
    assert.ok(result.reason, 'reason must be set');
  });
  check('targetMet is false', () => {
    assert.strictEqual(result.targetMet, false);
  });
}

// ── XP-009 — worker caps and hostile counts ──────────────────────────────────
async function workerCountIsCapped() {
  console.log('\n📋 XP-009 worker caps and input validation');

  check('a hard worker cap is exported', () => {
    assert.ok(HARD_LIMITS && Number.isInteger(HARD_LIMITS.MAX_WORKERS), 'HARD_LIMITS.MAX_WORKERS must exist');
    assert.ok(HARD_LIMITS.MAX_WORKERS >= 1 && HARD_LIMITS.MAX_WORKERS <= 100, 'cap must be conservative');
  });

  const hostile = [
    ['zero', 0],
    ['negative', -1],
    ['decimal', 2.7],
    ['string', 'abc'],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['huge', 1_000_000],
    ['null', null],
  ];

  for (const [label, value] of hostile) {
    const manager = new SessionManager({
      engine: fakeEngine(),
      runRound: async () => ({ cores: [], usage: {} }),
      ingest: () => 0,
      sessionCount: value,
    });
    check(`sessionCount=${label} is clamped into [1, ${HARD_LIMITS.MAX_WORKERS}]`, () => {
      const n = manager.desiredCount;
      assert.ok(Number.isInteger(n), `desiredCount must be an integer, got ${n}`);
      assert.ok(n >= 1 && n <= HARD_LIMITS.MAX_WORKERS, `desiredCount=${n}`);
    });
  }

  // A live getter that returns junk mid-run must not create a million sessions.
  let live = 4;
  const { manager, state } = harness({
    sessionCount: 1,
    callCeiling: 200,
    getSessionCount: () => live,
    runRound: async () => ({ cores: ['x'], usage: { input: 1 } }),
    ingest: () => 1,
  });
  const running = manager.run(() => state.calls >= 12);
  setTimeout(() => { live = 5_000_000; }, 30);
  await withTimeout(running, 15_000, 'hostile live count');

  check('a hostile live worker count never allocates beyond the cap', () => {
    assert.ok(
      manager.sessions.length <= HARD_LIMITS.MAX_WORKERS,
      `allocated ${manager.sessions.length} sessions`,
    );
  });
}

// ── XP-009 — total call / round / time budgets ───────────────────────────────
async function globalBudgetsStopTheRun() {
  console.log('\n📋 XP-009 global budgets');

  const { manager, state } = harness({
    sessionCount: 2,
    callCeiling: 400,
    maxTotalCalls: 7,
    runRound: async () => ({ cores: ['x'], usage: { input: 1 } }),
    ingest: () => 1,                        // progress every round: only the budget can stop it
  });
  const result = await withTimeout(manager.run(() => false), 20_000, 'call budget');

  check('the total-call budget halts the pool', () => {
    assert.ok(state.calls <= 7, `expected <= 7 calls, got ${state.calls}`);
    assert.strictEqual(state.cancelled, false, 'external ceiling was needed');
  });
  check('the stop reason names the exhausted budget', () => {
    assert.strictEqual(result.reason, 'budget_calls_exhausted', `got ${result.reason}`);
  });
  check('an exhausted budget is not success', () => {
    assert.notStrictEqual(result.status, 'success');
  });

  const timed = harness({
    sessionCount: 1,
    callCeiling: 400,
    maxElapsedMs: 300,
    runRound: async () => {
      await new Promise(r => setTimeout(r, 60));
      return { cores: ['x'], usage: { input: 1 } };
    },
    ingest: () => 1,
  });
  const startedAt = Date.now();
  const timeResult = await withTimeout(timed.manager.run(() => false), 20_000, 'time budget');
  const took = Date.now() - startedAt;

  check('the elapsed-time budget halts the pool', () => {
    assert.ok(took < 5000, `took ${took}ms`);
    assert.strictEqual(timeResult.reason, 'budget_time_exhausted', `got ${timeResult.reason}`);
  });
}

(async () => {
  console.log('=== XP-001 / XP-009: AI termination, budgets, worker caps ===');
  await singleWorkerTerminalStopsAtOneCall();
  await twoWorkersTerminalEachCalledOnce();
  await terminalWorkerDoesNotBlockHealthyWorker();
  await allWorkersTerminalEndsImmediately();
  await throwingIngestIsBounded();
  await throwingEngineStepsAreBounded();
  await cancelDuringBackoffIsBounded();
  await successOnlyWhenTargetMet();
  await workerCountIsCapped();
  await globalBudgetsStopTheRun();

  console.log(`\n${failed === 0 ? '✅' : '❌'} durable-ai-termination: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  console.error('\n❌ suite crashed:', error && error.stack ? error.stack : error);
  process.exit(1);
});
