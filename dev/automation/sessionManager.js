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
    // v5.12.0 dynamic prompt mode: live callback returning the current set of
    // over-saturated angle ids to exclude from this round's angle pool.
    // Default no-op keeps custom-prompt-mode runs byte-identical to before.
    this.getBurnedIds = deps.getBurnedIds || (() => new Set());
    this.persist = deps.persist || (() => {});
    this.chunk = deps.chunk || 10;          // tweets requested per round per session
    this.desiredCount = deps.sessionCount || 5;
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
  }

  /** Live desired session count, guarded against a broken getter. */
  _liveCount() {
    let c;
    try { c = parseInt(this.getSessionCount(), 10); } catch { c = 0; }
    return c >= 1 ? c : Math.max(1, this.desiredCount || 1);
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

    // 1. sync() — pull shared queue+preview into this session's dedup state.
    //    ONLY here, at the very start of the round — never mid-round.
    this.engine.syncSessionDedup(session, this.sharedQueue, this.sharedPreview);

    // 2. Build the round context (avoid-list from THIS session's accepted +
    //    cross-session inspiration themes).
    const acceptedContext = this.engine.buildAcceptedContext(session.acceptedBodies);
    const angles = this.engine.selectAngles(this.chunk, this.getBurnedIds());

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
        while (!getTargetMet() && !this.isCancelled()) {
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
            await this._runSessionRound(session);
            // Persist between rounds — debounced + serialized (one writer),
            // so an app close mid-run is resumable without write races.
            this._schedulePersist();
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
        if (getTargetMet() || this.isCancelled()) break;
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
  }
}

module.exports = { SessionManager, GenerationSession, STATUS };
