'use strict';

/**
 * dispatchDriver.js — a TEST DRIVER for one full publish cycle.
 *
 * This is not shipped code. The application has exactly one publish state
 * machine — DurableSession, driven by xPoster's loop — and this file exists so
 * the store-semantics suites can exercise a complete lease → boundary →
 * transport → outcome cycle without a browser.
 *
 * It used to live in dev/automation/publishWorkflow.js, where it looked like a
 * second shipped publish engine. Nothing in the app ever called it, so the
 * suites built on it could all pass while the engine that actually ships was
 * broken — which is precisely what happened. The irreversible-boundary POLICY it
 * relies on is not duplicated here: it is imported from the shipped
 * dev/automation/dispatchBoundary.js, so these tests still pin real behaviour.
 *
 * End-to-end coverage of the shipped loop lives in queue-consume.test.js,
 * deferred-retry-v512.test.js and stop-during-toast-wait.test.js, which drive
 * the real xPoster against a fake browser.
 */

const {
  DEFAULT_GUARD_BACKOFF_MS: DEFAULT_BACKOFF_MS,
  requestId,
  serializeError,
  resolveBoundaryGuardFailure,
} = require('../../dev/automation/dispatchBoundary');

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
 * dispatchNext's vocabulary for each shared boundary-guard outcome.
 *
 * The POLICY lives in dispatchBoundary.js — this only renames its result into
 * the `status` strings dispatchNext's callers already switch on.
 */
const GUARD_STATUS = {
  terminal: 'terminal_error_pre_dispatch',
  released: 'cancelled_pre_dispatch',
  blocked: 'blocked',
  lease_lost: 'lease_lost_pre_dispatch',
  deferred: 'retryable_error_pre_dispatch',
};

function resolveGuardFailureAsDispatchResult({ store, item, error, backoffMs }) {
  const resolved = resolveBoundaryGuardFailure({ store, item, error, backoffMs });
  const status = GUARD_STATUS[resolved.outcome];
  const base = resolved.item ? { ...resolved.item } : { state: resolved.state };
  const result = { ...base, status, error, item: resolved.item };
  if (resolved.outcome === 'blocked') {
    result.reason = 'recovery_required';
    result.details = resolved.details || null;
  }
  if (resolved.outcome === 'lease_lost') {
    result.state = resolved.state;
    result.reclaimedIds = resolved.reclaimedIds;
  }
  return result;
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
    return resolveGuardFailureAsDispatchResult({ store, item, error, backoffMs });
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
