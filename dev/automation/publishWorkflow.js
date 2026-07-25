'use strict';

const crypto = require('crypto');

const DEFAULT_BACKOFF_MS = 5 * 60_000;

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
 * Classify a preparation failure.
 *
 * A permanent failure must NOT return the item to the automatically eligible
 * queue: that is how a poison item retries forever. A transient failure gets a
 * bounded backoff. Everything unknown is treated as retryable-with-backoff,
 * which is the conservative choice: it never loses the item and never spins.
 */
function classifyPreparationError(error) {
  const declared = error && typeof error.classification === 'string' ? error.classification : null;
  if (declared === 'terminal' || declared === 'retryable') return declared;
  if (error && (error.code === 'ERR_INVALID_ARG_TYPE' || error instanceof TypeError)) return 'terminal';
  return 'retryable';
}

function isRecoveryBlock(error) {
  return Boolean(error) && error.code === 'RECOVERY_REQUIRED';
}

/**
 * Publication proof must be authoritative.
 *
 * An empty or whitespace-only identifier is not proof — treating it as proof
 * would irreversibly tombstone an item that may never have been posted.
 */
function hasAuthoritativeProof(evidence) {
  if (!evidence || evidence.confirmed !== true) return false;
  const id = typeof evidence.externalId === 'string' ? evidence.externalId.trim() : '';
  const url = typeof evidence.externalUrl === 'string' ? evidence.externalUrl.trim() : '';
  return id.length > 0 || url.length > 0;
}

/**
 * Turn a pre-boundary guard failure into a durable, visible state.
 *
 * The item is still 'leased' at this point and the transport was never called,
 * so nothing here can duplicate a post. What matters is that the item never
 * stays leased: that state is invisible in both the queue and recovery views.
 */
function resolveBoundaryGuardFailure({ store, item, error, backoffMs }) {
  const code = error && error.code;
  const details = { id: item.id, leaseToken: item.leaseToken, error: serializeError(error) };

  // Locally provable corruption cannot repair itself by retrying.
  if (code === 'MEDIA_INTEGRITY_FAILED') {
    const dead = store.markTerminal({
      ...details,
      reason: 'media_integrity_failed',
      requestId: requestId('terminal-media-integrity'),
    });
    return { ...dead, status: 'terminal_error_pre_dispatch', error, item: dead };
  }

  // Stop / profile deletion / lost lease: the operator or another worker won.
  // Release without penalising the item.
  if (code === 'RUN_NOT_ACTIVE' || code === 'PROFILE_NOT_ACTIVE') {
    const released = store.releasePreDispatch({
      ...details,
      reason: code === 'RUN_NOT_ACTIVE' ? 'run_closed_before_dispatch' : 'profile_deleted_before_dispatch',
      countAsFailure: false,
      requestId: requestId('release-boundary-guard'),
    });
    return { ...released, status: 'cancelled_pre_dispatch', error, item: released };
  }

  // Another item became unresolved while we prepared: hold this one back.
  if (code === 'RECOVERY_REQUIRED') {
    const released = store.releasePreDispatch({
      ...details,
      reason: 'blocked_by_unresolved_recovery',
      countAsFailure: false,
      requestId: requestId('release-recovery-required'),
    });
    return {
      ...released,
      status: 'blocked',
      reason: 'recovery_required',
      details: error.details || null,
      error,
      item: released,
    };
  }

  // A lost/expired lease means someone else may now own the item. Do not force
  // a transition we cannot prove we still own; leave reclamation to the store.
  if (code === 'LEASE_EXPIRED' || code === 'LEASE_CONFLICT') {
    return { status: 'lease_lost_pre_dispatch', state: null, item: null, error };
  }

  // Unknown guard failure: back off rather than spin, but stay recoverable.
  const deferred = store.markDeferred({
    ...details,
    reason: 'unknown_boundary_guard_failure',
    availableAtMs: Date.now() + backoffMs,
    requestId: requestId('defer-boundary-guard'),
  });
  return { ...deferred, status: 'retryable_error_pre_dispatch', error, item: deferred };
}

/**
 * Dispatch at most one queue item.
 *
 * The irreversible boundary is WorkflowStore.beginDispatch(). After it commits,
 * no thrown error, cancellation, timeout, or missing confirmation may return the
 * item to an automatically eligible state.
 */
async function dispatchNext({
  store,
  profileId,
  runId,
  prepare,
  dispatch,
  isCancelled = () => false,
  leaseMs = 60_000,
  backoffMs = DEFAULT_BACKOFF_MS,
}) {
  if (!store || typeof store.leaseNext !== 'function') throw new TypeError('store is required');
  if (typeof prepare !== 'function') throw new TypeError('prepare must be a function');
  if (typeof dispatch !== 'function') throw new TypeError('dispatch must be a function');
  if (typeof isCancelled !== 'function') throw new TypeError('isCancelled must be a function');

  let item;
  try {
    item = store.leaseNext({ profileId, runId, leaseMs });
  } catch (error) {
    // A globally unresolved dispatch blocks every profile. Surface it as a
    // first-class outcome so callers stop instead of treating it as a crash.
    if (isRecoveryBlock(error)) {
      return {
        status: 'blocked',
        state: null,
        item: null,
        reason: 'recovery_required',
        details: error.details || null,
      };
    }
    throw error;
  }
  if (!item) return { status: 'empty', state: null, item: null };

  if (isCancelled()) {
    // Stop is an operator action, not a platform failure: release without
    // counting it against the item's failure budget.
    const released = store.releasePreDispatch({
      id: item.id,
      leaseToken: item.leaseToken,
      reason: 'cancelled_before_prepare',
      countAsFailure: false,
      requestId: requestId('release-cancelled-before-prepare'),
    });
    return { ...released, status: 'cancelled_pre_dispatch', item: released };
  }

  let prepared;
  // Keep the lease alive while preparation runs. Losing it at the boundary
  // would strand the item, and the global recovery gate would then wedge the
  // whole queue until the user restarts.
  // Renew well inside the window (a third of it) so a slow tick still lands
  // before expiry. A fixed floor would be coarser than short leases.
  const renewEveryMs = Math.max(25, Math.floor(leaseMs / 3));
  let renewTimer = null;
  const startRenewals = () => {
    if (typeof store.renewLease !== 'function') return;
    renewTimer = setInterval(() => {
      try {
        store.renewLease({ id: item.id, leaseToken: item.leaseToken, leaseMs });
      } catch {
        // Losing the renewal race is not fatal here: the boundary re-checks
        // ownership and will refuse if the lease is genuinely gone.
      }
    }, renewEveryMs);
    if (typeof renewTimer.unref === 'function') renewTimer.unref();
  };
  const stopRenewals = () => {
    if (renewTimer !== null) {
      clearInterval(renewTimer);
      renewTimer = null;
    }
  };

  try {
    startRenewals();
    prepared = await prepare(item);
  } catch (error) {
    stopRenewals();
    // Snapshot cancellation once: calling isCancelled() twice can disagree.
    const cancelled = isCancelled();
    if (cancelled) {
      const released = store.releasePreDispatch({
        id: item.id,
        leaseToken: item.leaseToken,
        reason: 'cancelled_during_prepare',
        countAsFailure: false,
        requestId: requestId('release-cancelled-during-prepare'),
      });
      return { ...released, status: 'cancelled_pre_dispatch', error, item: released };
    }

    if (classifyPreparationError(error) === 'terminal') {
      const dead = store.markTerminal({
        id: item.id,
        leaseToken: item.leaseToken,
        reason: 'terminal_prepare_failure',
        error: serializeError(error),
        requestId: requestId('terminal-prepare-failed'),
      });
      return { ...dead, status: 'terminal_error_pre_dispatch', error, item: dead };
    }

    const deferred = store.markDeferred({
      id: item.id,
      leaseToken: item.leaseToken,
      reason: 'retryable_prepare_failure',
      error: serializeError(error),
      availableAtMs: Date.now() + backoffMs,
      requestId: requestId('defer-prepare-failed'),
    });
    return { ...deferred, status: 'retryable_error_pre_dispatch', error, item: deferred };
  }
  stopRenewals();

  if (isCancelled()) {
    const released = store.releasePreDispatch({
      id: item.id,
      leaseToken: item.leaseToken,
      reason: 'cancelled_after_prepare',
      countAsFailure: false,
      requestId: requestId('release-cancelled-after-prepare'),
    });
    return { ...released, status: 'cancelled_pre_dispatch', item: released };
  }

  if (!prepared || typeof prepared.renderedText !== 'string') {
    // A contract violation can never succeed by retrying: it is terminal.
    const error = new TypeError('prepare must return { renderedText }');
    const dead = store.markTerminal({
      id: item.id,
      leaseToken: item.leaseToken,
      reason: 'invalid_prepared_payload',
      error: serializeError(error),
      requestId: requestId('terminal-invalid-prepared'),
    });
    return { ...dead, status: 'terminal_error_pre_dispatch', error, item: dead };
  }

  // Durable boundary: this transaction must commit before the transport receives
  // the command. Any failure here propagates and dispatch is never called.
  //
  // Every guard error must be resolved into a durable state here. Letting it
  // escape would leave the item stranded in 'leased': invisible to both the
  // queue and the recovery screen, so the user believes it was published.
  let attempt;
  try {
    attempt = store.beginDispatch({
      id: item.id,
      leaseToken: item.leaseToken,
      renderedText: prepared.renderedText,
      requestId: requestId('begin-dispatch'),
    });
  } catch (error) {
    return resolveBoundaryGuardFailure({ store, item, error, backoffMs });
  }

  let evidence;
  try {
    evidence = await dispatch({ item, attempt, prepared });
  } catch (error) {
    const cancelled = isCancelled();
    const ambiguous = store.markAmbiguous({
      attemptId: attempt.attemptId,
      reason: cancelled ? 'cancelled_after_dispatch_boundary' : 'transport_rejected_after_dispatch_boundary',
      error: serializeError(error),
      requestId: requestId('mark-ambiguous'),
    });
    return {
      ...ambiguous,
      status: cancelled ? 'cancelled_post_dispatch' : 'ambiguous_post_dispatch',
      error,
      item: ambiguous,
    };
  }

  if (hasAuthoritativeProof(evidence)) {
    const externalId = typeof evidence.externalId === 'string' && evidence.externalId.trim()
      ? evidence.externalId.trim() : null;
    const externalUrl = typeof evidence.externalUrl === 'string' && evidence.externalUrl.trim()
      ? evidence.externalUrl.trim() : null;
    const published = store.markPublished({
      attemptId: attempt.attemptId,
      externalId,
      externalUrl,
      evidence,
      requestId: requestId('mark-published'),
    });
    return { ...published, status: 'confirmed', item: published };
  }

  const ambiguous = store.markAmbiguous({
    attemptId: attempt.attemptId,
    reason: isCancelled()
      ? 'cancelled_after_dispatch_boundary'
      : 'missing_strong_confirmation_after_dispatch',
    evidence: evidence || null,
    requestId: requestId('mark-unconfirmed-ambiguous'),
  });
  return {
    ...ambiguous,
    status: isCancelled() ? 'cancelled_post_dispatch' : 'ambiguous_post_dispatch',
    item: ambiguous,
  };
}

module.exports = {
  dispatchNext,
  serializeError,
  classifyPreparationError,
  hasAuthoritativeProof,
};
