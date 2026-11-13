'use strict';

/**
 * durableSession.js — durable publish primitives shaped for xPoster's loop.
 *
 * xPoster's loop is battle-tested (stop handling, rate limits, retries, toast
 * confirmation), so this keeps that structure and replaces only the STATE
 * operations underneath it: each method is one durable transaction against the
 * workflow store.
 *
 * The critical rule the old code could not enforce: `beginDispatch` commits
 * BEFORE Ctrl+Enter, and once committed nothing may return the item to an
 * automatically eligible state. Pre-boundary failures are cheap and reversible;
 * post-boundary outcomes are ambiguous until a human or remote proof resolves.
 */

const crypto = require('crypto');
const durableQueue = require('./durableQueue');
const { resolveBoundaryGuardFailure } = require('./dispatchBoundary');

function rid(prefix, id) {
  return `${prefix}:${id}:${crypto.randomUUID()}`;
}

/**
 * How often a held claim renews its lease, and how long each renewal buys.
 *
 * Preparation is slow by design — human-like typing delays, a media upload, a
 * toast wait — and can legitimately outlast a single lease. Without renewal the
 * lease simply expired mid-preparation: `beginDispatch` then refused with
 * LEASE_EXPIRED (safe, but the work was wasted) and, worse, the item became
 * claimable by another worker while this one was still composing it.
 */
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_LEASE_MS = 180_000;

class DurableSession {
  constructor({ store, profileId, runId, profileName }) {
    this.store = store;
    this.profileId = profileId;
    this.runId = runId;
    this.profileName = profileName;
    this.current = null;      // the leased item
    this.attempt = null;      // the committed dispatch attempt, if any
    this._heartbeatTimer = null;
    this._heartbeatFailures = 0;
    this.lastHeartbeatError = null;
  }

  /**
   * Keep the claim alive for as long as it is held.
   *
   * Started automatically when an item is claimed and stopped by every terminal
   * transition, so no caller has to remember to do it — the previous design
   * exposed heartbeat() as a method the live engine simply never called, while
   * the test driver did, which made the tests healthier than production.
   */
  _startHeartbeat(leaseMs = HEARTBEAT_LEASE_MS) {
    this._stopHeartbeat();
    this._heartbeatFailures = 0;
    const interval = Math.max(1_000, Math.min(HEARTBEAT_INTERVAL_MS, Math.floor(leaseMs / 3)));
    this._heartbeatTimer = setInterval(() => {
      // Once the dispatch is committed the lease is already released by the
      // store; renewing past the boundary would be meaningless.
      if (!this.current || this.attempt) { this._stopHeartbeat(); return; }
      try {
        this.store.renewLease({
          id: this.current.id,
          leaseToken: this.current.leaseToken,
          leaseMs,
        });
        this._heartbeatFailures = 0;
        this.lastHeartbeatError = null;
      } catch (error) {
        // A failed renewal is not fatal on its own — the boundary re-checks the
        // lease inside its own transaction and refuses if it really is gone.
        // Record it so the refusal can be explained rather than mysterious.
        this._heartbeatFailures++;
        this.lastHeartbeatError = { message: error.message, code: error.code || null };
        if (this._heartbeatFailures >= 3) this._stopHeartbeat();
      }
    }, interval);
    if (this._heartbeatTimer.unref) this._heartbeatTimer.unref();
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  /** True while a claim is being kept alive — for tests and diagnostics. */
  get heartbeatActive() { return this._heartbeatTimer !== null; }

  static async open(profileName) {
    const store = await durableQueue.getStore();
    const profileId = await durableQueue.resolveProfileId(profileName);
    const run = store.startRun({ requestId: rid('run', profileName) });
    return new DurableSession({ store, profileId, runId: run.id, profileName });
  }

  /** How many posts are ready to publish right now.
   *  Paged: listQueued clamps at 1000, so a larger queue reported exactly 1000
   *  and the operator saw a number that stopped moving as posts went out. */
  queuedCount() {
    return durableQueue.readAllQueuedItems(this.store).length;
  }

  /**
   * Everything still outstanding — what the operator's counter must show.
   *
   * Distinct from queuedCount() on purpose. The publisher's loop cares about
   * what it may claim right now; the operator's counter must include posts that
   * are merely waiting out a backoff or held by another worker, or the display
   * drops to 0 while work remains and the natural response is to add it again.
   */
  backlogCount() {
    return durableQueue.readAllBacklogItems(this.store).length;
  }

  /** Items awaiting a human decision — publishing is blocked while > 0. */
  unresolvedCount() {
    return this.store.countUnresolvedRecovery();
  }

  /**
   * Claim the next publishable post.
   *
   * Returns null when the queue is empty, or { blocked: true } when an earlier
   * dispatch is still unaccounted for — in that case NOTHING may be published,
   * by any profile, until the user resolves it.
   */
  claimNext({ leaseMs = 120_000 } = {}) {
    try {
      const item = this.store.leaseNext({
        profileId: this.profileId,
        runId: this.runId,
        leaseMs,
      });
      if (!item) { this.current = null; return null; }
      this.current = item;
      this.attempt = null;
      // The claim is now held; keep it alive for as long as preparation takes.
      this._startHeartbeat(leaseMs);
      const media = item.media && item.media.length > 0 ? item.media[0] : null;
      return {
        id: item.id,
        text: item.payload.text,
        mediaPath: media ? media.managedPath : null,
        payload: item.payload,
      };
    } catch (error) {
      if (error.code === 'RECOVERY_REQUIRED') {
        this.current = null;
        return { blocked: true, reason: 'recovery_required', details: error.details || null };
      }
      throw error;
    }
  }

  /** Keep a long preparation from losing its claim. */
  heartbeat({ leaseMs = 120_000 } = {}) {
    if (!this.current) return false;
    try {
      this.store.renewLease({ id: this.current.id, leaseToken: this.current.leaseToken, leaseMs });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * THE IRREVERSIBLE BOUNDARY. Must be called — and must succeed — immediately
   * before Ctrl+Enter, never after. Returns false if a guard refused, in which
   * case the caller must NOT press the key.
   */
  beginDispatch(renderedText) {
    if (!this.current) throw new Error('no claimed item to dispatch');
    try {
      this.attempt = this.store.beginDispatch({
        id: this.current.id,
        leaseToken: this.current.leaseToken,
        renderedText: typeof renderedText === 'string' ? renderedText : this.current.payload.text,
        requestId: rid('begin', this.current.id),
      });
      // The boundary releases the lease inside its own transaction, so renewal
      // is meaningless from here on. Stop immediately rather than leaving a
      // live interval to notice on its next tick.
      this._stopHeartbeat();
      return { ok: true, attemptId: this.attempt.attemptId };
    } catch (error) {
      const resolved = this._resolveGuardFailure(error);
      return { ok: false, code: error.code || 'DISPATCH_REFUSED', error, resolved };
    }
  }

  /**
   * A guard refused pre-boundary: land the item somewhere durable and visible.
   *
   * The policy itself lives in dispatchBoundary.js. Whatever it decides, the
   * claim is dropped here: an item left in 'leased' shows up in neither the
   * queue nor the recovery screen.
   */
  _resolveGuardFailure(error) {
    const item = this.current;
    if (!item) return null;
    try {
      const resolved = resolveBoundaryGuardFailure({ store: this.store, item, error });
      return resolved.item;
    } catch {
      return null;
    } finally {
      this._stopHeartbeat();
      this.current = null;
    }
  }

  /** Confirmed published, with authoritative proof (a real post URL/ID). */
  markPublished({ externalUrl = null, externalId = null, evidence = null } = {}) {
    if (!this.attempt) throw new Error('markPublished requires a committed dispatch');
    const result = this.store.markPublished({
      attemptId: this.attempt.attemptId,
      externalId,
      externalUrl,
      evidence: { confirmed: true, ...(evidence || {}) },
      requestId: rid('published', this.current.id),
    });
    this._stopHeartbeat();
    this.current = null;
    this.attempt = null;
    return result;
  }

  /**
   * The keystroke went out but the outcome is unknown (missing toast, rejected
   * promise, Stop pressed after submit, crash). NEVER auto-retried.
   */
  markAmbiguous(reason, error = null, evidence = null) {
    if (!this.attempt) throw new Error('markAmbiguous requires a committed dispatch');
    const result = this.store.markAmbiguous({
      attemptId: this.attempt.attemptId,
      reason: reason || 'ambiguous_publish_result',
      error: error ? { message: error.message || String(error), code: error.code || null } : null,
      evidence,
      requestId: rid('ambiguous', this.current.id),
    });
    this._stopHeartbeat();
    this.current = null;
    this.attempt = null;
    return result;
  }

  /** Pre-boundary transient failure: retry later with backoff. */
  markDeferred(reason, error = null, backoffMs = 300_000) {
    if (!this.current) return null;
    const result = this.store.markDeferred({
      id: this.current.id,
      leaseToken: this.current.leaseToken,
      reason: reason || 'transient_failure',
      error: error ? { message: error.message || String(error), code: error.code || null } : null,
      availableAtMs: Date.now() + backoffMs,
      requestId: rid('deferred', this.current.id),
    });
    this._stopHeartbeat();
    this.current = null;
    return result;
  }

  /** Pre-boundary permanent failure: it never went out, and never will. */
  markTerminal(reason, error = null) {
    if (!this.current) return null;
    const result = this.store.markTerminal({
      id: this.current.id,
      leaseToken: this.current.leaseToken,
      reason: reason || 'permanent_failure',
      error: error ? { message: error.message || String(error), code: error.code || null } : null,
      requestId: rid('terminal', this.current.id),
    });
    this._stopHeartbeat();
    this.current = null;
    return result;
  }

  /**
   * Give the claim back untouched — the post never left the queue.
   *
   * Used for Stop and rate limits: an operator action is not a publishing
   * failure, so it must not count against the item's retry budget.
   */
  release(reason = 'released', { countAsFailure = false } = {}) {
    if (!this.current) return null;
    const result = this.store.releasePreDispatch({
      id: this.current.id,
      leaseToken: this.current.leaseToken,
      reason,
      countAsFailure,
      requestId: rid('release', this.current.id),
    });
    this._stopHeartbeat();
    this.current = null;
    return result;
  }

  /** True once the keystroke has been committed for the current item. */
  get pastBoundary() {
    return this.attempt !== null;
  }

  close(status = 'closed') {
    // A claim still held at close would otherwise wait for lease expiry.
    if (this.current && !this.attempt) {
      try { this.release('run_ended'); } catch { /* best effort */ }
    }
    try {
      this.store.finishRun({ runId: this.runId, status, requestId: rid('finish', this.runId) });
    } catch { /* run may already be closed */ }
  }
}

module.exports = { DurableSession };
