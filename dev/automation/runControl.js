'use strict';

/**
 * runControl.js — the ONE happens-before point between Stop and a dispatch.
 *
 * The bug this exists to make impossible: Stop was a bare global boolean.
 * `stop-automation` set `global.isRunning = false` and fired `stopActive()`
 * without awaiting anything, while the posting loop checked that boolean at
 * scattered interruption points. Between the last of those checks and the
 * keystroke there was an `await` (the baseline toast snapshot), so a Stop that
 * landed in that window was simply never observed: the loop committed the
 * dispatch and pressed Ctrl+Enter anyway. The operator pressed Stop and a tweet
 * went out — and Stop had already reported success.
 *
 * The model here is deliberately small:
 *
 *   - A run owns a RunToken. The token has exactly one state:
 *     active → cancelling → cancelled.
 *
 *   - `tryEnterDispatch()` and `requestStop()` are both SYNCHRONOUS and contain
 *     no `await`. In a single-threaded event loop that makes them atomic with
 *     respect to each other, so "who won" is decided at one well-defined
 *     linearization point instead of being smeared across an await.
 *
 *   - Whoever gets there first wins, and the loser is told the truth:
 *       * Stop first  ⇒ tryEnterDispatch() refuses. No transport may happen.
 *       * Dispatch first ⇒ requestStop() reports `dispatchInFlight: true` and
 *         hands back a `join()` the caller MUST await. Stop does not get to
 *         claim it won before that attempt has settled.
 *
 * Nothing here talks to the store, the browser, or Electron, so the gate can be
 * tested directly — and it is, over both interleavings, in
 * test/workflow-stop-boundary-race.test.js.
 */

const STATE = Object.freeze({
  ACTIVE: 'active',
  CANCELLING: 'cancelling',
  CANCELLED: 'cancelled',
});

/** How long a Stop waits for an in-flight dispatch before reporting a timeout. */
const DEFAULT_JOIN_TIMEOUT_MS = 30_000;

let seq = 0;

class RunToken {
  constructor({ runId = null, label = null } = {}) {
    this.runId = runId || `run-${++seq}`;
    this.label = label;
    this.state = STATE.ACTIVE;
    this.stopReason = null;
    this.stoppedAt = null;
    this._inFlight = null;     // the single in-flight dispatch ticket, if any
    this._stopWaiters = [];
  }

  get active() { return this.state === STATE.ACTIVE; }
  get stopping() { return this.state === STATE.CANCELLING; }
  get cancelled() { return this.state !== STATE.ACTIVE; }

  /**
   * Claim the right to perform ONE irreversible transport call.
   *
   * SYNCHRONOUS BY CONTRACT — do not add an await to this method. The caller
   * must invoke it with no await between it and the transport call itself,
   * because that gap is precisely the window this class exists to close.
   *
   * @returns {{ok: true, ticket: object} | {ok: false, reason: string}}
   */
  tryEnterDispatch(label = 'dispatch') {
    if (this.state !== STATE.ACTIVE) {
      return { ok: false, reason: this.state === STATE.CANCELLING ? 'stopping' : 'cancelled' };
    }
    if (this._inFlight) {
      // One irreversible action at a time per run, by construction.
      return { ok: false, reason: 'dispatch_already_in_flight' };
    }
    let settle;
    const settled = new Promise((resolve) => { settle = resolve; });
    const ticket = {
      label,
      startedAt: Date.now(),
      settled,
      _settle: settle,
      outcome: null,
      done: false,
    };
    this._inFlight = ticket;
    return { ok: true, ticket };
  }

  /** True while an irreversible action is outstanding. */
  get dispatchInFlight() { return this._inFlight !== null; }

  /**
   * Release the gate once the transport call has settled — published,
   * ambiguous, refused, whatever. Always call this in a `finally`.
   */
  leaveDispatch(ticket, outcome = null) {
    if (!ticket || ticket.done) return;
    ticket.done = true;
    ticket.outcome = outcome;
    if (this._inFlight === ticket) this._inFlight = null;
    ticket._settle(outcome);
    // A Stop that was waiting on this dispatch can now complete.
    if (this.state === STATE.CANCELLING && !this._inFlight) this._drainStopWaiters();
  }

  _drainStopWaiters() {
    const waiters = this._stopWaiters;
    this._stopWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /**
   * Request that this run stop.
   *
   * The state flip is synchronous, so every `tryEnterDispatch()` from this
   * moment on refuses. Returns a descriptor whose `join()` the caller MUST
   * await before reporting the run stopped: if a dispatch was already in
   * flight, the side effect may already be out on the network and the only
   * honest thing to do is wait for it to settle.
   */
  requestStop(reason = 'user_stop') {
    const alreadyStopping = this.state !== STATE.ACTIVE;
    if (!alreadyStopping) {
      this.state = STATE.CANCELLING;
      this.stopReason = reason;
      this.stoppedAt = Date.now();
    }
    // Captured synchronously — this is what makes the verdict honest.
    const inFlight = this._inFlight;

    const join = async (timeoutMs = DEFAULT_JOIN_TIMEOUT_MS) => {
      let timedOut = false;
      if (this._inFlight) {
        const waited = new Promise((resolve) => { this._stopWaiters.push(resolve); });
        let timer;
        const deadline = new Promise((resolve) => {
          timer = setTimeout(() => { timedOut = true; resolve(); }, timeoutMs);
          if (timer.unref) timer.unref();
        });
        await Promise.race([waited, deadline]);
        clearTimeout(timer);
      }
      // A join timeout is NOT success. The run stays 'cancelling' so nothing
      // new can start, and the caller is told the attempt is unaccounted for.
      if (!timedOut) this.state = STATE.CANCELLED;
      return {
        runId: this.runId,
        stopped: !timedOut,
        timedOut,
        dispatchInFlight: !!inFlight,
        settledOutcome: inFlight ? inFlight.outcome : null,
        state: this.state,
      };
    };

    return {
      runId: this.runId,
      alreadyStopping,
      // Whether an irreversible action was already committed when Stop arrived.
      // If true, Stop did NOT win and must not pretend it did.
      dispatchInFlight: !!inFlight,
      reason,
      join,
    };
  }
}

/**
 * The set of runs currently alive in this process.
 *
 * `stopAll()` is what the Stop IPC calls: it flips every token synchronously
 * (so no new dispatch can start anywhere), then joins them all.
 */
class RunRegistry {
  constructor() { this.tokens = new Set(); }

  create(options) {
    const token = new RunToken(options);
    this.tokens.add(token);
    return token;
  }

  release(token) { this.tokens.delete(token); }

  get size() { return this.tokens.size; }

  /** True while any run is mid-stop — used to refuse a new Start. */
  get stopping() {
    for (const token of this.tokens) if (token.stopping) return true;
    return false;
  }

  /**
   * Stop every live run. The flip loop is synchronous and completes before any
   * await, so by the time the first join begins, every token already refuses
   * new dispatches.
   */
  stopAll(reason = 'user_stop', timeoutMs = DEFAULT_JOIN_TIMEOUT_MS) {
    const requests = [];
    for (const token of this.tokens) requests.push(token.requestStop(reason));
    return {
      requests,
      dispatchInFlight: requests.some((r) => r.dispatchInFlight),
      join: async () => {
        const results = await Promise.all(requests.map((r) => r.join(timeoutMs)));
        return results;
      },
    };
  }
}

module.exports = {
  STATE,
  DEFAULT_JOIN_TIMEOUT_MS,
  RunToken,
  RunRegistry,
};
