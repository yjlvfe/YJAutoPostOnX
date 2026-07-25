'use strict';

/**
 * durableSession.js — durable publish primitives shaped for xPoster's loop.
 *
 * xPoster's loop is battle-tested (stop handling, rate limits, retries, toast
 * confirmation), so this keeps that structure and replaces only the STATE
 * operations underneath it. Each method maps one legacy queueManager call onto
 * a single durable transaction.
 *
 * The critical rule the old code could not enforce: `beginDispatch` commits
 * BEFORE Ctrl+Enter, and once committed nothing may return the item to an
 * automatically eligible state. Pre-boundary failures are cheap and reversible;
 * post-boundary outcomes are ambiguous until a human or remote proof resolves.
 */

const crypto = require('crypto');
const durableQueue = require('./durableQueue');

function rid(prefix, id) {
  return `${prefix}:${id}:${crypto.randomUUID()}`;
}

class DurableSession {
  constructor({ store, profileId, runId, profileName }) {
    this.store = store;
    this.profileId = profileId;
    this.runId = runId;
    this.profileName = profileName;
    this.current = null;      // the leased item
    this.attempt = null;      // the committed dispatch attempt, if any
  }

  static async open(profileName) {
    const store = await durableQueue.getStore();
    const profileId = await durableQueue.resolveProfileId(profileName);
    const run = store.startRun({ requestId: rid('run', profileName) });
    return new DurableSession({ store, profileId, runId: run.id, profileName });
  }

  /** How many posts are ready to publish right now. */
  queuedCount() {
    return this.store.listQueued({ limit: 1000 }).length;
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
      return { ok: true, attemptId: this.attempt.attemptId };
    } catch (error) {
      const resolved = this._resolveGuardFailure(error);
      return { ok: false, code: error.code || 'DISPATCH_REFUSED', error, resolved };
    }
  }

  /** A guard refused pre-boundary: land the item somewhere durable and visible. */
  _resolveGuardFailure(error) {
    const item = this.current;
    if (!item) return null;
    const base = { id: item.id, leaseToken: item.leaseToken, error: { message: error.message, code: error.code || null } };
    try {
      if (error.code === 'MEDIA_INTEGRITY_FAILED') {
        const dead = this.store.markTerminal({ ...base, reason: 'media_integrity_failed', requestId: rid('dead-media', item.id) });
        this.current = null;
        return dead;
      }
      if (error.code === 'RECOVERY_REQUIRED' || error.code === 'RUN_NOT_ACTIVE' || error.code === 'PROFILE_NOT_ACTIVE') {
        const released = this.store.releasePreDispatch({
          ...base,
          reason: `refused_${(error.code || 'guard').toLowerCase()}`,
          countAsFailure: false,
          requestId: rid('release-guard', item.id),
        });
        this.current = null;
        return released;
      }
      if (error.code === 'LEASE_EXPIRED' || error.code === 'LEASE_CONFLICT') {
        this.store.reclaimExpiredLeases({ requestId: rid('reclaim', item.id), graceMs: 0 });
        this.current = null;
        return this.store.getItem(item.id);
      }
      const deferred = this.store.markDeferred({
        ...base,
        reason: 'unknown_boundary_guard_failure',
        availableAtMs: Date.now() + 300_000,
        requestId: rid('defer-guard', item.id),
      });
      this.current = null;
      return deferred;
    } catch {
      this.current = null;
      return null;
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
