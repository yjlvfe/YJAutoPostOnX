/**
 * 🔄 Session Manager — Parallel Generation Sessions (Growing Thread v4.4.0)
 * ==========================================================================
 * Each generation wave sends the FULL conversation thread (system + all prior
 * rounds) to the AI so Anthropic's prompt cache serves the static system
 * prefix cheaply from round 2 onward (~40-60% input token saving).
 *
 * Architecture (growing thread, persisted):
 *   - Every round appends user + assistant turns to session.messages (cap: 16).
 *   - Sessions are persisted across restarts via the `persist` callback so the
 *     prompt cache prefix survives app restarts.
 *   - acceptedBodies (last 60) are persisted across restarts for dedup only.
 *
 * Strict round order per session (spec):
 *   [round start] → sync() (pull shared queue+preview into this session's
 *   dedup state) → build round context (avoid-list + inspiration) → send AI
 *   growing-thread request → ingest accepted → [round end]
 *
 * Golden rule: a session NEVER gets interrupted mid-round. Session count
 * changes (raise/lower) and dedup syncing happen ONLY between rounds.
 *
 * This module is provider-agnostic and Electron-free so it can be unit-tested:
 * the HTTP round-trip is injected as `runRound`.
 */

/** How many accepted bodies a session carries for dedup context. */
const MAX_ACCEPTED_BODIES = 60;

/**
 * Session lifecycle.
 *
 * The distinction that matters is STOPPED vs TERMINAL. STOPPED is *parked* —
 * the worker count was lowered below this session's index, and raising it again
 * brings the session back. TERMINAL is *spent* — the credential was rejected,
 * the failure budget ran out, or the session stopped making progress. A spent
 * session is never respawned by the pool; only an explicit operator reset
 * (resetTerminalSessions(), wired to the "reset sessions" IPC) revives it,
 * because the only thing that can change the outcome is a configuration or
 * credential change the operator has to make.
 *
 * Collapsing those two into one state is what let a dead worker be resurrected
 * at every surviving sibling's round boundary, burning a provider request each
 * time, forever.
 */
const STATUS = Object.freeze({
  IDLE: 'idle',            // created, not started a round yet
  RUNNING: 'running',      // 🟢 currently inside an AI round
  WAITING: 'waiting',      // 🟡 alive but between rounds
  STOPPED: 'stopped',      // ⏸️ parked: count lowered below this index (reversible)
  TERMINAL: 'terminal',    // 🔴 spent: never respawned without an explicit reset
  CANCELLED: 'cancelled',  // ✋ the operator cancelled the run
  DONE: 'done',            // target reached
});

/** States from which the pool must never start a new round. */
const NON_RESPAWNABLE = Object.freeze(new Set([
  STATUS.TERMINAL,
  STATUS.CANCELLED,
  STATUS.DONE,
]));

/**
 * Absolute ceilings. These are backstops, not the primary control — per-session
 * failure and no-progress budgets normally stop a run long before any of these.
 * They exist so that no code path can issue an unbounded number of paid
 * provider requests, whatever the UI or a caller asks for.
 *
 * MAX_WORKERS is deliberately conservative: every worker holds one in-flight
 * provider request (up to 120s) plus a growing 16-message thread in memory, and
 * 32 concurrent requests on one API key is already past what typical providers
 * allow per key. The UI, the IPC handler and the manager all clamp to this same
 * number so there is exactly one answer to "how many workers can run".
 */
const HARD_LIMITS = Object.freeze({
  MAX_WORKERS: 32,
  MAX_TOTAL_CALLS: 1000,
  MAX_TOTAL_ROUNDS: 1000,
  MAX_ELAPSED_MS: 2 * 60 * 60_000,   // 2 hours
});

/** Provider replies that no amount of retrying can fix. */
const TERMINAL_ERROR_RE = /\b(401|403)\b|unauthorized|forbidden|invalid api key|authentication/i;

/**
 * Coerce any caller-supplied worker count into [1, MAX_WORKERS].
 *
 * Strings, decimals, NaN, Infinity, negatives and absurd values all arrive here
 * from the renderer's number input and from IPC, and each of them used to be
 * able to size an array of session objects before anything validated it.
 */
function clampWorkerCount(value, fallback = 5) {
  const n = typeof value === 'number' ? value : parseInt(value, 10);
  if (!Number.isFinite(n)) return Math.min(Math.max(1, Math.floor(fallback) || 1), HARD_LIMITS.MAX_WORKERS);
  const i = Math.floor(n);
  if (i < 1) return 1;
  return Math.min(i, HARD_LIMITS.MAX_WORKERS);
}

/** Coerce an optional positive budget, falling back to the hard ceiling. */
function clampBudget(value, ceiling) {
  const n = typeof value === 'number' ? value : parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return ceiling;
  return Math.min(Math.floor(n), ceiling);
}

/**
 * A single persistent generation session (one continuous AI conversation).
 */
class GenerationSession {
  constructor(num, system) {
    this.num = num;                 // 1-based session number (Session #num)
    this.system = system;           // static system block (cached prefix)
    this.messages = [];             // persistent conversation thread
    this.exactKeys = new Set();     // G3 dedup — rebuilt each round via sync()
    this.tokenSets = [];            // G3 semantic dedup token bodies
    this.acceptedBodies = [];       // bodyOnly() of this session's accepted posts (for context)
    this.status = STATUS.IDLE;
    this.roundsCompleted = 0;
    this.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
  }

  /**
   * Serializable snapshot for cross-restart persistence.
   *
   * `system` is deliberately NOT included. Every session in a pool shares the
   * manager's system block verbatim, and the envelope's fingerprint is a hash
   * OF that block — a snapshot is only ever restored when it matches. Writing
   * it per session stored the same multi-KB prompt once per worker.
   */
  toJSON() {
    return {
      num: this.num,
      // GROWING THREAD (v4.4.0): persist the last 16 messages so the
      // conversation thread survives app restarts. The thread is what feeds
      // Anthropic's prompt cache (cached prefix is re-served from round 2).
      messages: this.messages.slice(-16),
      acceptedBodies: this.acceptedBodies.slice(-MAX_ACCEPTED_BODIES),
      roundsCompleted: this.roundsCompleted,
      usage: this.usage,
    };
  }

  /** Rehydrate from a persisted snapshot. */
  static fromJSON(obj, fallbackSystem) {
    // `obj.system` only exists in snapshots written before the envelope carried
    // it; the fallback is the authoritative source for everything newer.
    const s = new GenerationSession(obj.num, obj.system || fallbackSystem);
    // GROWING THREAD (v4.4.0): restore the persisted thread so prompt cache
    // continuity is maintained across restarts.
    s.messages = Array.isArray(obj.messages) ? obj.messages.slice(-16) : [];
    // Re-capped on the way IN as well as out. An older or hand-edited file
    // would otherwise reintroduce an unbounded list that every later write
    // faithfully preserved.
    s.acceptedBodies = Array.isArray(obj.acceptedBodies)
      ? obj.acceptedBodies.slice(-MAX_ACCEPTED_BODIES)
      : [];
    s.roundsCompleted = Number(obj.roundsCompleted) || 0;
    if (obj.usage) s.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, ...obj.usage };
    s.status = STATUS.WAITING;
    return s;
  }
}

/**
 * Orchestrates a pool of persistent sessions toward a target count.
 *
 * @param {object} deps
 * @param {object} deps.engine         - contentEngine (syncSessionDedup, buildAcceptedContext, selectAngles, …)
 * @param {function} deps.runRound      - async ({ session, angles, acceptedContext, inspirationSummary }) => { cores, usage }
 *                                        MUST append the user turn + assistant reply onto session.messages and return parsed cores + usage.
 * @param {function} deps.ingest        - (cores, session) => number  (validates+dedups+accepts; returns gained; emits live preview)
 * @param {function} [deps.onStatus]    - (sessionsSnapshot, totals) => void  (UI status emitter)
 * @param {function} [deps.isCancelled] - () => boolean
 * @param {function} [deps.getSessionCount] - () => number  (live desired session count, may change mid-run)
 * @param {function} [deps.persist]     - (sessionsArray) => void  (save snapshot for resume)
 */
class SessionManager {
  constructor(deps) {
    this.engine = deps.engine;
    this.runRound = deps.runRound;
    this.ingest = deps.ingest;
    this.onStatus = deps.onStatus || (() => {});
    this.isCancelled = deps.isCancelled || (() => false);
    this.getSessionCount = deps.getSessionCount || (() => this.desiredCount);
    // v5.12.0 dynamic prompt mode: live callback returning the current set of
    // over-saturated angle ids to exclude from this round's angle pool.
    // Default no-op keeps custom-prompt-mode runs byte-identical to before.
    this.getBurnedIds = deps.getBurnedIds || (() => new Set());
    this.persist = deps.persist || (() => {});
    this.chunk = deps.chunk || 10;          // tweets requested per round per session
    this.desiredCount = clampWorkerCount(deps.sessionCount, 5);
    this.sessions = [];                      // GenerationSession[]
    this.system = deps.system || '';
    this.inspirationSummary = deps.inspirationSummary || '';
    // Shared, cross-session dedup sources (the live queue + preview).
    this.sharedQueue = deps.sharedQueue || [];
    this.sharedPreview = deps.sharedPreview || [];
    // Throttled status emit + debounced persist — with large pools (100s of
    // sessions) unthrottled per-round emits/writes are O(n²) per wave and
    // concurrent writes to the same snapshot file can corrupt it.
    this._lastEmitAt = 0;
    this._emitTimer = null;
    this._persistTimer = null;
    this._persistDirty = false;
    this._persistChain = Promise.resolve();
    this.maxConsecutiveFailures = Math.max(1, Number(deps.maxConsecutiveFailures) || 5);
    this.maxNoProgressRounds = Math.max(1, Number(deps.maxNoProgressRounds) || 10);
    this.baseBackoffMs = Math.max(50, Number(deps.baseBackoffMs) || 1000);
    this.maxBackoffMs = Math.max(this.baseBackoffMs, Number(deps.maxBackoffMs) || 30000);

    // Pool-wide budgets. Every one of these is finite, so there is no
    // combination of inputs that yields an unbounded number of paid requests.
    this.maxTotalCalls = clampBudget(deps.maxTotalCalls, HARD_LIMITS.MAX_TOTAL_CALLS);
    this.maxTotalRounds = clampBudget(deps.maxTotalRounds, HARD_LIMITS.MAX_TOTAL_ROUNDS);
    this.maxElapsedMs = clampBudget(deps.maxElapsedMs, HARD_LIMITS.MAX_ELAPSED_MS);

    // Budget accounting. `_callsAttempted` counts REQUESTS, not successes: a
    // 401 costs a round-trip and must spend the budget just like a 200 does.
    this._callsAttempted = 0;
    this._startedAt = 0;
    this._budgetStop = null;    // reason code, once any budget trips
    this._madeProgress = false; // has any round ever accepted anything?
  }

  /** Live desired session count, clamped and guarded against a broken getter. */
  _liveCount() {
    let raw;
    try { raw = this.getSessionCount(); } catch { raw = null; }
    return clampWorkerCount(raw, this.desiredCount || 1);
  }

  /**
   * Which pool-wide budget (if any) is spent. Checked immediately before every
   * provider request and at every round boundary, so the ceiling is an upper
   * bound on requests actually issued, not on requests already paid for.
   */
  _budgetExhausted() {
    if (this._callsAttempted >= this.maxTotalCalls) return 'budget_calls_exhausted';
    if (Date.now() - this._startedAt >= this.maxElapsedMs) return 'budget_time_exhausted';
    let rounds = 0;
    for (const s of this.sessions) rounds += s.roundsCompleted;
    if (rounds >= this.maxTotalRounds) return 'budget_rounds_exhausted';
    return null;
  }

  /** True once any budget has tripped; latches so the whole pool winds down. */
  _budgetSpent() {
    if (this._budgetStop) return true;
    const reason = this._budgetExhausted();
    if (reason) { this._budgetStop = reason; return true; }
    return false;
  }

  /** Retire a session permanently. Only resetTerminalSessions() undoes this. */
  _markTerminal(session, reason) {
    session.status = STATUS.TERMINAL;
    session._terminal = true;          // legacy flag: existing callers read it
    session._terminalReason = reason;
  }

  /**
   * Charge one failure against a session's budget and retire it if spent.
   *
   * Every throw from anywhere in the round pipeline lands here — the provider
   * call, ingest(), and the engine's sync/context/angle helpers alike. The old
   * code only charged failures thrown by the provider call; a throw from
   * ingest() or the engine hit a bare catch-log-sleep-continue that spent no
   * budget at all, so a permanently broken ingest retried forever.
   */
  _chargeFailure(session, err) {
    const message = (err && err.message) ? err.message : String(err);
    session.status = STATUS.WAITING;
    session._lastError = message;
    session._consecutiveFailures = (session._consecutiveFailures || 0) + 1;
    if (TERMINAL_ERROR_RE.test(message)) {
      this._markTerminal(session, 'provider_rejected_credentials');
    } else if (session._consecutiveFailures >= this.maxConsecutiveFailures) {
      this._markTerminal(session, 'consecutive_failures_exhausted');
    }
    this._emitStatus();
  }

  /**
   * Bring retired sessions back. This is the ONLY way out of TERMINAL, and it
   * exists because the operator has to change something (API key, model, base
   * URL) before another attempt can end differently.
   */
  resetTerminalSessions() {
    let revived = 0;
    for (const s of this.sessions) {
      if (s.status !== STATUS.TERMINAL) continue;
      s.status = STATUS.WAITING;
      delete s._terminal;
      delete s._terminalReason;
      delete s._lastError;
      s._consecutiveFailures = 0;
      s._noProgressRounds = 0;
      revived++;
    }
    this._budgetStop = null;
    return revived;
  }

  /** Restore persisted sessions (called before run when resuming). */
  loadSessions(snapshots) {
    if (!Array.isArray(snapshots) || !snapshots.length) return;
    this.sessions = snapshots.map(o => GenerationSession.fromJSON(o, this.system));
  }

  /** Ensure exactly `count` sessions exist (create new, mark extras stopped). */
  _reconcileSessionCount(count) {
    // Runs at EVERY round boundary of EVERY session — skip the O(n) sweep
    // when nothing changed, or large pools pay O(n²) per wave for nothing.
    if (count === this._reconciledCount && this.sessions.length >= count) return;
    // Grow: create new sessions starting fresh from the static system block.
    while (this.sessions.length < count) {
      const num = this.sessions.length + 1;
      this.sessions.push(new GenerationSession(num, this.system));
    }
    // Shrink: sessions beyond `count` stop accepting new rounds but are kept
    // (resume if count is raised again). Sessions within range that were
    // stopped get reactivated to WAITING.
    this.sessions.forEach((s, i) => {
      if (i >= count) {
        if (s.status !== STATUS.STOPPED) s.status = STATUS.STOPPED;
      } else if (s.status === STATUS.STOPPED) {
        s.status = STATUS.WAITING;
      }
    });
    this._reconciledCount = count;
  }

  /** Aggregate token + progress totals across all sessions. */
  totals() {
    const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, rounds: 0 };
    for (const s of this.sessions) {
      t.input += s.usage.input; t.output += s.usage.output;
      t.cacheRead += s.usage.cacheRead; t.cacheWrite += s.usage.cacheWrite;
      t.calls += s.usage.calls; t.rounds += s.roundsCompleted;
    }
    const totalIn = t.input + t.cacheRead + t.cacheWrite;
    t.cacheHitPct = totalIn > 0 ? Number(((t.cacheRead / totalIn) * 100).toFixed(1)) : 0;
    return t;
  }

  /** Lightweight per-session snapshot for the UI status indicators. */
  statusSnapshot() {
    return this.sessions.map(s => ({
      num: s.num,
      status: s.status,
      rounds: s.roundsCompleted,
      accepted: s.acceptedCount ?? s.acceptedBodies.length,
      cacheRead: s.usage.cacheRead,
      lastError: s._lastError || null,
    }));
  }

  /**
   * Throttled status emit: at most one IPC emit per 250ms globally, with a
   * trailing emit so the LAST state always reaches the UI. Pass force=true
   * for the final end-of-run emit.
   */
  _emitStatus(force = false) {
    const emitNow = () => {
      this._lastEmitAt = Date.now();
      try { this.onStatus(this.statusSnapshot(), this.totals()); } catch { /* best-effort */ }
    };
    if (force) {
      if (this._emitTimer) { clearTimeout(this._emitTimer); this._emitTimer = null; }
      emitNow();
      return;
    }
    if (this._emitTimer) return;   // trailing emit already queued
    const since = Date.now() - this._lastEmitAt;
    if (since >= 250) { emitNow(); return; }
    this._emitTimer = setTimeout(() => { this._emitTimer = null; emitNow(); }, 250 - since);
    if (this._emitTimer.unref) this._emitTimer.unref();
  }

  /**
   * Debounced persist: sessions request a save after every round, but the
   * actual write happens at most every 1.5s and writes are SERIALIZED on a
   * promise chain — parallel sessions never race two writes into the same
   * snapshot file.
   */
  _schedulePersist() {
    this._persistDirty = true;
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      this._persistNow();
    }, 1500);
    if (this._persistTimer.unref) this._persistTimer.unref();
  }

  _persistNow() {
    if (!this._persistDirty) return this._persistChain;
    this._persistDirty = false;
    const snapshot = this.sessions.map(s => s.toJSON());
    this._persistChain = this._persistChain
      .then(() => this.persist(snapshot))
      .catch(err => console.error('Session persist failed:', err?.message));
    return this._persistChain;
  }

  /** Final flush at run end — cancel the debounce timer and write NOW. */
  async _flushPersist() {
    if (this._persistTimer) { clearTimeout(this._persistTimer); this._persistTimer = null; }
    this._persistDirty = true;
    await this._persistNow();
  }

  /**
   * Run ONE round for a single session: sync → build context → AI turn →
   * ingest. Never interrupted once started.
   * @returns {Promise<number>} accepted gained this round
   */
  async _runSessionRound(session) {
    if (this.isCancelled()) return 0;
    if (session.status === STATUS.TERMINAL) return 0;

    // Clear stale error before starting; if this round fails, _lastError is
    // set again so the UI always shows FRESH errors, never stale ones.
    delete session._lastError;
    session.status = STATUS.RUNNING;
    this._emitStatus();

    // ONE try/catch around the WHOLE pipeline. Every step below can throw, and
    // every throw must cost the session part of its failure budget — otherwise
    // a step that fails deterministically (a broken ingest, an engine helper
    // that always throws) spins without limit.
    try {
      // 1. sync() — pull shared queue+preview into this session's dedup state.
      //    ONLY here, at the very start of the round — never mid-round.
      this.engine.syncSessionDedup(session, this.sharedQueue, this.sharedPreview);

      // 2. Build the round context (avoid-list from THIS session's accepted +
      //    cross-session inspiration themes).
      const acceptedContext = this.engine.buildAcceptedContext(session.acceptedBodies);
      const angles = this.engine.selectAngles(this.chunk, this.getBurnedIds());

      // 3. Spend one unit of the pool's call budget — checked and incremented
      //    with no await in between, so the ceiling is exact.
      if (this._budgetSpent()) {
        session.status = STATUS.WAITING;
        return 0;
      }
      this._callsAttempted++;

      // 4. Send the AI turn inside the SAME persistent thread and wait.
      const result = await this.runRound({
        session,
        angles,
        acceptedContext,
        inspirationSummary: this.inspirationSummary,
        chunk: this.chunk,
      });

      // 5. Accounting + ingest accepted posts into the shared queue.
      if (result && result.usage) {
        session.usage.input += result.usage.input || 0;
        session.usage.output += result.usage.output || 0;
        session.usage.cacheRead += result.usage.cacheRead || 0;
        session.usage.cacheWrite += result.usage.cacheWrite || 0;
        session.usage.calls++;
      }
      const gained = this.ingest((result && result.cores) || [], session) || 0;
      session._consecutiveFailures = 0;
      session.roundsCompleted++;
      session.status = STATUS.WAITING;
      if (gained > 0) this._madeProgress = true;
      this._emitStatus();
      return gained;
    } catch (err) {
      this._chargeFailure(session, err);
      return 0;
    }
  }

  /**
   * Main loop: run persistent sessions in parallel until `getTargetMet()`
   * returns true or generation is cancelled. Each session loops its own
   * rounds; the pool re-syncs session count between rounds (golden rule).
   *
   * @param {function} getTargetMet - () => boolean  (e.g. accepted >= target)
   */
  async run(getTargetMet) {
    // Start the clock before anything can spend it. The elapsed-time budget is
    // measured from here, so a slow first launch counts against the run too.
    this._startedAt = Date.now();
    this._budgetStop = null;

    // Sessions launched per second when many start at once: a smooth ramp
    // instead of firing hundreds of simultaneous HTTP requests in one tick.
    // This delays LAUNCH only — once launched, every session loops freely.
    const LAUNCH_RATE = 25;
    const LAUNCH_SPACING_MS = Math.ceil(1000 / LAUNCH_RATE);
    let nextLaunchAt = 0;      // shared launch clock across ALL spawn calls
    const loops = new Map();   // session.num → running loop promise

    // Cancellable pre-launch wait (checks cancel/target every 250ms).
    const launchWait = async (ms) => {
      const end = Date.now() + ms;
      while (Date.now() < end && !this.isCancelled() && !getTargetMet()) {
        await new Promise(r => {
          const t = setTimeout(r, Math.min(250, Math.max(1, end - Date.now())));
          if (t.unref) t.unref();
        });
      }
    };

    // Each active session runs an independent round-loop. They share the
    // queue/preview; sync() at each round start propagates accepted posts.
    // CRITICAL: every step inside the loop is individually try/catch-wrapped
    // so one failure never crashes the session or its siblings.
    const sessionLoop = async (session, launchDelayMs) => {
      try {
        if (launchDelayMs > 0) await launchWait(launchDelayMs);
        while (!getTargetMet() && !this.isCancelled() && !this._budgetSpent()) {
          try {
            const liveCount = this._liveCount();
            // Golden rule: count changes apply BETWEEN rounds only. Raising
            // the count spawns loops for the new sessions right here.
            spawnMissing(liveCount);
            if (session.num > liveCount) {
              // This session was switched off — park it (kept for resume).
              session.status = STATUS.STOPPED;
              this._emitStatus();
              return;
            }
            const gained = await this._runSessionRound(session);
            // Persist between rounds — debounced + serialized (one writer),
            // so an app close mid-run is resumable without write races.
            this._schedulePersist();
            if (session.status === STATUS.TERMINAL) return;
            session._noProgressRounds = gained > 0 ? 0 : (session._noProgressRounds || 0) + 1;
            if (session._noProgressRounds >= this.maxNoProgressRounds) {
              // Spent, not parked: a session that has produced nothing for N
              // consecutive rounds must not be respawned by a sibling either.
              this._markTerminal(session, 'no_progress_exhausted');
              session._lastError = `No progress after ${session._noProgressRounds} consecutive rounds`;
              this._emitStatus();
              return;
            }
            if (gained === 0 && !getTargetMet() && !this.isCancelled() && !this._budgetSpent()) {
              const failures = Math.max(session._consecutiveFailures || 0, session._noProgressRounds || 0);
              const delay = Math.min(this.maxBackoffMs, this.baseBackoffMs * (2 ** Math.min(failures - 1, 8)));
              await launchWait(delay);
            }
          } catch (err) {
            // Anything unexpected in the iteration itself (not the round
            // pipeline, which charges its own failures). Charge it too — a
            // bare log-and-continue here is exactly how an unbounded retry
            // loop hides. If the budget is spent this retires the session.
            console.error(`Session #${session.num} round error:`, err && err.message);
            this._chargeFailure(session, err);
            if (session.status === STATUS.TERMINAL) return;
            await launchWait(Math.min(this.maxBackoffMs, this.baseBackoffMs));
          }
        }
        if (this.isCancelled()) session.status = STATUS.CANCELLED;
        else if (getTargetMet()) session.status = STATUS.DONE;
        else if (this._budgetStop) this._markTerminal(session, this._budgetStop);
        else session.status = STATUS.WAITING;
        this._emitStatus();
      } catch (err) {
        // Outer catch: if anything throws outside the while (e.g. getTargetMet),
        // the session cannot be trusted to run again — retire it.
        console.error(`Session #${session.num} fatal:`, err && err.message);
        this._markTerminal(session, 'session_loop_fault');
        session._lastError = err && err.message ? err.message : String(err);
        this._emitStatus();
      }
    };

    // Start a loop for every session that should be active but has none.
    // Called at start AND at every round boundary — so raising the count
    // mid-run actually brings the new sessions to life (previously they
    // were created but no loop ever ran them: they waited forever).
    const spawnMissing = (count) => {
      try { this._reconcileSessionCount(count); } catch (err) {
        console.error('Reconcile failed:', err.message);
      }
      const limit = Math.min(count, this.sessions.length);
      for (let i = 0; i < limit; i++) {
        const s = this.sessions[i];
        if (loops.has(s.num)) continue;
        // THE FIX for the unbounded-respawn bug. "Has no running loop" is not
        // the same as "may run": a session that returned because it was spent
        // also has no loop. Without this check every sibling's round boundary
        // resurrected it and paid for another provider request.
        if (NON_RESPAWNABLE.has(s.status)) continue;
        if (getTargetMet() || this.isCancelled() || this._budgetSpent()) break;
        // Take the next slot on the shared launch clock (LAUNCH_RATE/s).
        // A shared clock — NOT a per-call counter — so nested spawn calls
        // from session prologues keep the ramp instead of resetting it.
        const now = Date.now();
        const at = Math.max(now, nextLaunchAt);
        nextLaunchAt = at + LAUNCH_SPACING_MS;
        const delayMs = at - now;
        // Reserve the slot BEFORE starting the loop: sessionLoop's own
        // synchronous prologue calls spawnMissing, and without this
        // reservation it re-spawns ITSELF in unbounded recursion.
        loops.set(s.num, Promise.resolve());
        const p = sessionLoop(s, delayMs)
          .catch(err => {
            // sessionLoop already catches everything; this is belt-and-braces.
            console.error(`Session #${s.num} unhandled rejection:`, err?.message || err);
            s.status = STATUS.STOPPED;
            s._lastError = err?.message || 'Unhandled rejection';
            this._emitStatus();
          })
          .finally(() => loops.delete(s.num));
        loops.set(s.num, p);
      }
    };

    spawnMissing(this._liveCount());

    // Loops can spawn more loops (count raised mid-run) — drain until the
    // pool is fully empty, then flush the throttled status + pending persist.
    while (loops.size > 0) {
      await Promise.allSettled([...loops.values()]);
    }
    this._emitStatus(true);
    await this._flushPersist();
    return this._buildResult(getTargetMet);
  }

  /**
   * The run's verdict, derived from what actually happened.
   *
   * The invariant this exists to enforce: `success` if and only if the target
   * was met. Everything else is `partial` (some posts were accepted), `failed`
   * (none were) or `cancelled` — each with a reason code the caller can show
   * and act on. The old code returned `success: true` from main.js even on
   * 0/target, which is what made a pool of dead workers look like a good run.
   */
  _buildResult(getTargetMet) {
    let targetMet = false;
    try { targetMet = !!getTargetMet(); } catch { targetMet = false; }
    let cancelled = false;
    try { cancelled = !!this.isCancelled(); } catch { cancelled = false; }

    const considered = Math.min(this._liveCount(), this.sessions.length);
    const inScope = this.sessions.slice(0, considered);
    const terminal = inScope.filter(s => s.status === STATUS.TERMINAL);

    let status;
    let reason;
    if (targetMet) {
      status = 'success';
      reason = 'target_met';
    } else if (cancelled) {
      status = 'cancelled';
      reason = 'cancelled_by_user';
    } else {
      status = this._madeProgress ? 'partial' : 'failed';
      if (this._budgetStop) reason = this._budgetStop;
      else if (terminal.length > 0 && terminal.length >= considered) reason = 'all_workers_terminal';
      else reason = 'no_progress';
    }

    return {
      status,
      reason,
      targetMet,
      cancelled,
      madeProgress: this._madeProgress,
      callsAttempted: this._callsAttempted,
      elapsedMs: Date.now() - this._startedAt,
      budgetStop: this._budgetStop,
      terminalCount: terminal.length,
      workerCount: considered,
      totals: this.totals(),
      sessions: this.sessions.map(s => ({
        num: s.num,
        status: s.status,
        rounds: s.roundsCompleted,
        terminalReason: s._terminalReason || null,
        lastError: s._lastError || null,
      })),
    };
  }
}

module.exports = {
  SessionManager,
  GenerationSession,
  STATUS,
  HARD_LIMITS,
  clampWorkerCount,
};
