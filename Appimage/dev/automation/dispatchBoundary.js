'use strict';

/**
 * dispatchBoundary.js — the ONE policy for a guard refusing at the boundary.
 *
 * `beginDispatch` is the irreversible boundary: once it commits, the keystroke
 * may be sent and no failure afterwards can return the item to an automatically
 * eligible state. This module covers the other side — a guard REFUSING to
 * commit — where nothing was submitted and the item is still 'leased'.
 *
 * The single rule that matters: the item must never be left in 'leased'. That
 * state appears in neither the queue nor the recovery screen, so the operator
 * sees a post that has silently ceased to exist and assumes it published.
 *
 * DurableSession (the shipped engine, wrapped around xPoster's loop) and the
 * test driver in test/helpers/dispatchDriver.js both use this. They each used
 * to carry their own copy, which is the kind of duplication where one gets
 * fixed and the other is forgotten — on a rule about irreversible publishing.
 */

const crypto = require('crypto');

/** Bounded backoff for a guard failure nobody has classified. */
const DEFAULT_GUARD_BACKOFF_MS = 5 * 60_000;

function requestId(prefix) {
  return `${prefix}:${crypto.randomUUID()}`;
}

function serializeError(error) {
  if (!error) return null;
  return {
    name: typeof error.name === 'string' ? error.name : 'Error',
    message: typeof error.message === 'string' ? error.message : String(error),
    code: typeof error.code === 'string' ? error.code : null,
  };
}

/**
 * Resolve a pre-boundary guard failure into a durable, visible state.
 *
 * Returns `{ outcome, item, ... }` where `outcome` names what was decided:
 *   terminal   — locally provable corruption; retrying cannot repair it.
 *   released   — the operator or another worker won; no failure is charged.
 *   blocked    — an unresolved dispatch elsewhere is holding everything.
 *   lease_lost — ownership can no longer be proven; reclaimed instead of forced.
 *   deferred   — unclassified; back off rather than spin, but stay recoverable.
 *
 * @param {object}   args.store    open WorkflowStore
 * @param {object}   args.item     the leased item (needs id + leaseToken)
 * @param {Error}    args.error    the error beginDispatch threw
 * @param {number}  [args.backoffMs]
 */
function resolveBoundaryGuardFailure({ store, item, error, backoffMs = DEFAULT_GUARD_BACKOFF_MS }) {
  const code = error && error.code;
  const base = { id: item.id, leaseToken: item.leaseToken, error: serializeError(error) };

  // Locally provable corruption cannot repair itself by retrying.
  if (code === 'MEDIA_INTEGRITY_FAILED') {
    const dead = store.markTerminal({
      ...base,
      reason: 'media_integrity_failed',
      requestId: requestId('terminal-media-integrity'),
    });
    return { outcome: 'terminal', item: dead, state: dead.state, error };
  }

  // Stop / profile deletion / a dispatch elsewhere awaiting a human: the
  // operator or another worker won. Release without penalising the item.
  if (code === 'RUN_NOT_ACTIVE' || code === 'PROFILE_NOT_ACTIVE' || code === 'RECOVERY_REQUIRED') {
    const reason = code === 'RUN_NOT_ACTIVE' ? 'run_closed_before_dispatch'
      : code === 'PROFILE_NOT_ACTIVE' ? 'profile_deleted_before_dispatch'
        : 'blocked_by_unresolved_recovery';
    const released = store.releasePreDispatch({
      ...base,
      reason,
      countAsFailure: false,
      requestId: requestId(`release-${reason}`),
    });
    return {
      outcome: code === 'RECOVERY_REQUIRED' ? 'blocked' : 'released',
      item: released,
      state: released.state,
      reason,
      details: code === 'RECOVERY_REQUIRED' ? (error.details || null) : null,
      error,
    };
  }

  // A lost/expired lease means ownership can no longer be proven, so we must not
  // force a transition with a token that may be stale. But the item must never
  // be left invisible in 'leased': reclaim it (an expired lease is pre-boundary
  // by definition, so this cannot duplicate a post). If another worker
  // legitimately owns it now, the reclaim is a no-op and they proceed.
  if (code === 'LEASE_EXPIRED' || code === 'LEASE_CONFLICT') {
    let reclaimed;
    try {
      reclaimed = store.reclaimExpiredLeases({ requestId: requestId('reclaim-lost-lease'), graceMs: 0 });
    } catch (reclaimError) {
      // Best-effort here; startup reconciliation is the backstop.
      reclaimed = { reclaimedIds: [], error: serializeError(reclaimError) };
    }
    const current = store.getItem(item.id);
    return {
      outcome: 'lease_lost',
      item: current,
      state: current ? current.state : null,
      reclaimedIds: reclaimed ? reclaimed.reclaimedIds : [],
      error,
    };
  }

  // Unknown guard failure: back off rather than spin, but stay recoverable.
  const deferred = store.markDeferred({
    ...base,
    reason: 'unknown_boundary_guard_failure',
    availableAtMs: Date.now() + backoffMs,
    requestId: requestId('defer-boundary-guard'),
  });
  return { outcome: 'deferred', item: deferred, state: deferred.state, error };
}

module.exports = {
  DEFAULT_GUARD_BACKOFF_MS,
  requestId,
  serializeError,
  resolveBoundaryGuardFailure,
};
