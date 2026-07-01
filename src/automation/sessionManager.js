/**
 * 🔄 Session Manager — Parallel Generation Sessions (Stateless Flat v4.3.0)
 * ==========================================================================
 * Each generation wave sends ONE flat message (system + accepted context +
 * avoid-list) to the AI — no persistent conversation thread is kept.
 *
 * Architecture (stateless flat):
 *   - Every round builds a fresh 2-message request: [system, user].
 *   - No growing thread → no token bloat → ~44.5% cost saving vs threaded.
 *   - acceptedBodies (last 60) are persisted across restarts for dedup only.
 *
 * Strict round order per session (spec):
 *   [round start] → sync() (pull shared queue+preview into this session's
 *   dedup state) → build round context (avoid-list + inspiration) → send AI
 *   flat request → ingest accepted → [round end]
 *
 * Golden rule: a session NEVER gets interrupted mid-round. Session count
 * changes (raise/lower) and dedup syncing happen ONLY between rounds.
 *
 * This module is provider-agnostic and Electron-free so it can be unit-tested:
 * the HTTP round-trip is injected as `runRound`.
 */

const STATUS = Object.freeze({
  IDLE: 'idle',        // created, not started a round yet
  RUNNING: 'running',  // 🟢 currently inside an AI round
  WAITING: 'waiting',  // 🟡 alive but between rounds / paused (count lowered)
  STOPPED: 'stopped',  // 🔴 stopped (count lowered below this index, or cancelled)
  DONE: 'done',        // target reached
});

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

  /** Serializable snapshot for cross-restart persistence. */
  toJSON() {
    return {
      num: this.num,
      system: this.system,
      // GROWING THREAD (v4.4.0): persist the last 16 messages so the
      // conversation thread survives app restarts. The thread is what feeds
      // Anthropic's prompt cache (cached prefix is re-served from round 2).
      messages: this.messages.slice(-16),
      acceptedBodies: this.acceptedBodies.slice(-60),
      roundsCompleted: this.roundsCompleted,
      usage: this.usage,
    };
  }

  /** Rehydrate from a persisted snapshot. */
  static fromJSON(obj, fallbackSystem) {
    const s = new GenerationSession(obj.num, obj.system || fallbackSystem);
    // GROWING THREAD (v4.4.0): restore the persisted thread so prompt cache
    // continuity is maintained across restarts.
    s.messages = Array.isArray(obj.messages) ? obj.messages.slice(-16) : [];
    s.acceptedBodies = Array.isArray(obj.acceptedBodies) ? obj.acceptedBodies : [];
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
    this.persist = deps.persist || (() => {});
    this.chunk = deps.chunk || 10;          // tweets requested per round per session
    this.desiredCount = deps.sessionCount || 5;
    this.sessions = [];                      // GenerationSession[]
    this.system = deps.system || '';
    this.inspirationSummary = deps.inspirationSummary || '';
    // Shared, cross-session dedup sources (the live queue + preview).
    this.sharedQueue = deps.sharedQueue || [];
    this.sharedPreview = deps.sharedPreview || [];
  }

  /** Restore persisted sessions (called before run when resuming). */
  loadSessions(snapshots) {
    if (!Array.isArray(snapshots) || !snapshots.length) return;
    this.sessions = snapshots.map(o => GenerationSession.fromJSON(o, this.system));
  }

  /** Ensure exactly `count` sessions exist (create new, mark extras stopped). */
  _reconcileSessionCount(count) {
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
      accepted: s.acceptedBodies.length,
      cacheRead: s.usage.cacheRead,
      lastError: s._lastError || null,
    }));
  }

  _emitStatus() {
    try { this.onStatus(this.statusSnapshot(), this.totals()); } catch { /* best-effort */ }
  }

  /**
   * Run ONE round for a single session: sync → build context → AI turn →
   * ingest. Never interrupted once started.
   * @returns {Promise<number>} accepted gained this round
   */
  async _runSessionRound(session) {
    if (this.isCancelled()) return 0;

    // 1. sync() — pull shared queue+preview into this session's dedup state.
    //    ONLY here, at the very start of the round — never mid-round.
    this.engine.syncSessionDedup(session, this.sharedQueue, this.sharedPreview);

    // 2. Build the round context (avoid-list from THIS session's accepted +
    //    cross-session inspiration themes).
    const acceptedContext = this.engine.buildAcceptedContext(session.acceptedBodies);
    const angles = this.engine.selectAngles(this.chunk);

    // Clear stale error before starting; if this round fails, _lastError is
    // set again so the UI always shows FRESH errors, never stale ones.
    delete session._lastError;

    // 3. Send the AI turn inside the SAME persistent thread and wait.
    session.status = STATUS.RUNNING;
    this._emitStatus();
    let result;
    try {
      result = await this.runRound({
        session,
        angles,
        acceptedContext,
        inspirationSummary: this.inspirationSummary,
        chunk: this.chunk,
      });
    } catch (err) {
      session.status = STATUS.WAITING;
      session._lastError = err.message;
      this._emitStatus();
      return 0;
    }

    // 4. Accounting + ingest accepted posts into the shared queue.
    if (result && result.usage) {
      session.usage.input += result.usage.input || 0;
      session.usage.output += result.usage.output || 0;
      session.usage.cacheRead += result.usage.cacheRead || 0;
      session.usage.cacheWrite += result.usage.cacheWrite || 0;
      session.usage.calls++;
    }
    const gained = this.ingest((result && result.cores) || [], session) || 0;
    session.roundsCompleted++;
    session.status = STATUS.WAITING;
    this._emitStatus();
    return gained;
  }

  /**
   * Main loop: run persistent sessions in parallel until `getTargetMet()`
   * returns true or generation is cancelled. Each session loops its own
   * rounds; the pool re-syncs session count between rounds (golden rule).
   *
   * @param {function} getTargetMet - () => boolean  (e.g. accepted >= target)
   */
  async run(getTargetMet) {
    try { this._reconcileSessionCount(this.getSessionCount()); } catch (err) {
      console.error('Initial reconcile failed:', err.message);
    }

    // Each active session runs an independent round-loop. They share the
    // queue/preview; sync() at each round start propagates accepted posts.
    // CRITICAL: every step inside the loop is individually try/catch-wrapped
    // so one failure never crashes the session or its siblings.
    const sessionLoop = async (session) => {
      try {
        while (!getTargetMet() && !this.isCancelled()) {
          try {
            const liveCount = this.getSessionCount();
            // Golden rule: count changes apply BETWEEN rounds only.
            try { this._reconcileSessionCount(liveCount); } catch (err) {
              console.error(`Session #${session.num} reconcile failed:`, err.message);
              session._lastError = `reconcile: ${err.message}`;
              this._emitStatus();
            }
            if (session.num > liveCount) {
              // This session was switched off — park it (kept for resume).
              session.status = STATUS.STOPPED;
              this._emitStatus();
              return;
            }
            await this._runSessionRound(session);
            // Persist after each round so an app close mid-run is resumable.
            try {
              this.persist(this.sessions.map(s => s.toJSON()));
            } catch (err) {
              console.error(`Session #${session.num} persist failed:`, err.message);
            }
          } catch (err) {
            // Catch-all for any unexpected error in a single round iteration.
            // Log it, mark the session, and continue the loop (don't crash).
            console.error(`Session #${session.num} round error:`, err.message);
            session._lastError = err.message;
            this._emitStatus();
            // Brief pause before retrying to avoid tight error loops
            await new Promise(r => setTimeout(r, 2000));
          }
        }
        session.status = getTargetMet() ? STATUS.DONE : STATUS.WAITING;
        this._emitStatus();
      } catch (err) {
        // Outer catch: if anything throws outside the while (e.g. getTargetMet),
        // mark session stopped and return gracefully instead of crashing.
        console.error(`Session #${session.num} fatal:`, err.message);
        session.status = STATUS.STOPPED;
        session._lastError = err.message;
        this._emitStatus();
      }
    };

    const active = this.sessions.slice(0, this.getSessionCount());
    // Promise.allSettled: one session crashing never takes down the others.
    const results = await Promise.allSettled(active.map(s => sessionLoop(s)));
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected') {
        const reason = results[i].reason;
        console.error(`Session #${active[i].num} unhandled rejection:`, reason?.message || reason);
        active[i].status = STATUS.STOPPED;
        active[i]._lastError = reason?.message || 'Unhandled rejection';
        this._emitStatus();
      }
    }

    // Final persist.
    try { this.persist(this.sessions.map(s => s.toJSON())); } catch { /* best-effort */ }
  }
}

module.exports = { SessionManager, GenerationSession, STATUS };
