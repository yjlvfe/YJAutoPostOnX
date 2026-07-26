'use strict';

/**
 * durableQueue.js — the live bridge between the app and WorkflowStore.
 *
 * This replaces the split JSON files (queue/published/posting/pending/dead/
 * deferred) with the single authoritative SQLite store, while keeping the
 * function names the app already calls so the UI and IPC layers stay stable.
 *
 * The important difference is the PUBLISH path. The old flow was a sequence of
 * independent file writes around an irreversible keystroke; the new flow is
 * lease -> beginDispatch (committed) -> transport -> published/ambiguous, where
 * every transition is a single transaction and nothing can auto-retry once the
 * boundary is crossed.
 *
 * Legacy JSON is migrated exactly once, on first use, behind a lock.
 */

const os = require('os');
const path = require('path');
const log = require('../utils/logger');
const { WorkflowStore } = require('./workflowStore');
const { migrateLegacyWorkflow } = require('./workflowMigration');
const { listProfilesOrdered, profileDataDir } = require('./profileRegistry');
const workflowBackup = require('./workflowBackup');

const SHARED_DIR = path.join(os.homedir(), '.config', 'x-poster-shared');

let storePromise = null;
let cachedStore = null;

/**
 * Open the store, migrating legacy JSON on first use.
 *
 * Migration is idempotent and one-way: it never rewrites the JSON sources, and
 * a completed migration is detected by a durable marker rather than by the
 * absence of files.
 */
async function getStore() {
  if (cachedStore && !cachedStore.closed) return cachedStore;
  if (!storePromise) {
    storePromise = (async () => {
      const profileNames = await listProfilesOrdered();
      const profileDirs = profileNames.map((name) => ({ name, dir: profileDataDir(name) }));
      try {
        migrateLegacyWorkflow({ rootDir: SHARED_DIR, sharedDir: SHARED_DIR, profileDirs });
      } catch (error) {
        // A migration that cannot complete must not silently fall back to a
        // half-built state — publishing from an incomplete queue is worse than
        // refusing to start.
        log.error('Legacy workflow migration failed:', error?.message || error);
        throw error;
      }
      const store = new WorkflowStore({ rootDir: SHARED_DIR });
      try {
        // Fail closed before the first mutation. Cleanup-only findings (orphaned
        // bytes) are intentionally not startup blockers; corruption, FK errors,
        // missing media and item/attempt split-brain are.
        assertHealthyResult(store.integrityCheck(), 'startup_pre_recovery');

        // Anything left mid-flight by a previous process is resolved before the
        // first lease of this session.
        store.reconcileStartup({ requestId: `startup:${Date.now()}` });
        store.reclaimExpiredLeases({ requestId: `startup-reclaim:${Date.now()}` });
        assertHealthyResult(store.integrityCheck(), 'startup_post_recovery');
      } catch (error) {
        try { store.close(); } catch { /* best effort */ }
        throw error;
      }
      cachedStore = store;
      return store;
    })();
    storePromise.catch(() => { storePromise = null; });
  }
  return storePromise;
}

function textOf(item) {
  if (item && item.payload && typeof item.payload.text === 'string') return item.payload.text;
  if (item && typeof item.text === 'string') return item.text;
  return '';
}

function criticalHealthProblems(health) {
  if (!health || typeof health !== 'object') return ['missing_health_result'];
  const problems = [];
  if (health.quickCheck !== 'ok') problems.push('quick_check');
  if (Array.isArray(health.foreignKeyViolations) && health.foreignKeyViolations.length) problems.push('foreign_keys');
  if (Array.isArray(health.mediaProblems) && health.mediaProblems.length) problems.push('managed_media');
  if (Array.isArray(health.stateConsistencyViolations) && health.stateConsistencyViolations.length) problems.push('state_consistency');
  return problems;
}

function assertHealthyResult(health, phase = 'runtime') {
  const problems = criticalHealthProblems(health);
  if (problems.length === 0) return health;
  const error = new Error(`Workflow store health gate failed at ${phase}: ${problems.join(', ')}`);
  error.code = 'WORKFLOW_HEALTH_FAILED';
  error.phase = phase;
  error.health = health;
  throw error;
}

async function assertHealthy(options = {}) {
  const store = await getStore();
  return assertHealthyResult(store.integrityCheck(options), 'runtime');
}

// ── Paginating reads// ── Paginating reads ─────────────────────────────────────────────────────────
//
// WorkflowStore.listQueued hard-clamps `limit` to 1000 and listItems to 10000,
// so a single call can never see a queue larger than that. Every read below
// therefore pages on the store's keyset cursor, exactly as getPublishedTexts
// already did.
//
// This is not a cosmetic limit. The same reads feed the queue the UI counts,
// the duplicate check in addPosts, and the semantic-dedup corpus main.js builds
// before AI generation — so a post sitting past position 1000 was invisible to
// all three, and the app would queue and publish a second copy of it.

/** Page size per call. Below both store clamps, so one page is always honoured. */
const PAGE_SIZE = 500;

/** Every queued/deferred item, paged on queue_seq. */
function readAllQueuedItems(store) {
  const all = [];
  let after = null;
  for (;;) {
    const page = store.listQueued({ limit: PAGE_SIZE, after });
    if (page.length === 0) break;
    all.push(...page);
    if (page.length < PAGE_SIZE) break;
    after = { queueSeq: page[page.length - 1].queueSeq };
  }
  return all;
}

/** Every item in `states`, paged on the composite (updatedAtMs, id) cursor. */
function readAllItems(store, states) {
  const all = [];
  let after = null;
  for (;;) {
    const page = store.listItems({ states, limit: PAGE_SIZE, after });
    if (page.length === 0) break;
    all.push(...page);
    if (page.length < PAGE_SIZE) break;
    const last = page[page.length - 1];
    after = { updatedAtMs: last.updatedAtMs, id: last.id };
  }
  return all;
}

/**
 * States that represent work the app still owes an outcome on.
 *
 * `queued` is only the part that is claimable RIGHT NOW. A post whose network
 * attempt failed sits in `deferred` until its backoff elapses; one a worker is
 * composing sits in `leased`; one whose keystroke went out sits in
 * `dispatch_started`/`ambiguous` awaiting a human. Every one of those is
 * outstanding work, and none of them appeared in the queue the operator saw.
 */
const BACKLOG_STATES = Object.freeze(['queued', 'deferred', 'leased']);
const UNRESOLVED_STATES = Object.freeze(['dispatch_started', 'ambiguous']);

/** Everything outstanding for display: claimable now plus waiting plus in-flight. */
function readAllBacklogItems(store) {
  return readAllItems(store, BACKLOG_STATES)
    .sort((a, b) => (a.queueSeq ?? 0) - (b.queueSeq ?? 0));
}

/**
 * Every text that must block a duplicate enqueue.
 *
 * This used to read only the ready rows, so re-adding a post that was merely
 * DEFERRED was accepted silently: the durable backlog then held two rows for
 * the same text, and both eventually published. Dedup has to span every state
 * that still owes an outcome, including the ones awaiting a human decision —
 * re-adding a post whose first attempt may already be live on X is exactly the
 * duplicate this whole design exists to prevent.
 */
function collectQueuedTexts(store) {
  const texts = new Set();
  for (const item of readAllItems(store, [...BACKLOG_STATES, ...UNRESOLVED_STATES])) {
    const text = textOf(item);
    if (text) texts.add(text);
  }
  return texts;
}

/** Shape a durable item like the legacy queue entry the UI expects. */
function toLegacyEntry(item) {
  const media = item.media && item.media.length > 0 ? item.media[0] : null;
  return {
    id: item.id,
    text: textOf(item),
    media_path: media ? (media.managedPath || media.originalPath) : null,
    state: item.state,
    revision: item.revision,
  };
}

/**
 * Resolve a profile name/**
 * Resolve a profile name to its stable UUID, creating it if needed.
 *
 * Profile identity must never be the display name: renaming or deleting a
 * profile in the UI must not orphan the queue items it owns.
 */
async function resolveProfileId(profileName) {
  const store = await getStore();
  const name = profileName || 'Default';
  const existing = store.db
    .prepare('SELECT id, status FROM profiles WHERE name = ?')
    .get(name);
  if (existing && existing.status === 'active') return existing.id;
  if (existing) {
    store.restoreProfile({
      profileId: existing.id,
      requestId: `restore-profile:${existing.id}`,
    });
    return existing.id;
  }
  const created = store.createProfile({
    name,
    legacyPath: profileDataDir(name),
    requestId: `create-profile:${name}`,
  });
  return created.id;
}

// ── Queue reads ──────────────────────────────────────────────────────────────

/**
 * What the operator's queue screen shows: everything outstanding.
 *
 * Deliberately NOT just the ready rows. A queue that reported "empty" while a
 * deferred post was waiting an hour to retry is a lie in the only direction
 * that matters — the operator adds the post again, and it goes out twice.
 */
async function getQueue() {
  const store = await getStore();
  return readAllBacklogItems(store).map(toLegacyEntry);
}

/**
 * Full item records with the state metadata the UI needs to explain WHY an item
 * is not going out yet: its state, when it becomes eligible, why it was
 * deferred, and how many attempts it has already cost.
 */
async function getQueueDetailed() {
  const store = await getStore();
  return readAllBacklogItems(store).map((item) => ({
    ...item,
    notBeforeMs: item.availableAtMs || null,
    waitingMs: item.availableAtMs ? Math.max(0, item.availableAtMs - Date.now()) : 0,
    deferReason: item.reason || null,
    attempts: item.preDispatchFailureCount || 0,
  }));
}

/** Only what can be claimed right now — the publisher's view, not the UI's. */
async function getReadyNow() {
  const store = await getStore();
  return readAllQueuedItems(store);
}

/** Counts for the UI, split so "0 ready" can never be shown as "0 total". */
async function getBacklogCounts() {
  const store = await getStore();
  const counts = { queued: 0, deferred: 0, leased: 0, unresolved: 0 };
  for (const state of BACKLOG_STATES) {
    counts[state] = readAllItems(store, [state]).length;
  }
  counts.unresolved = store.countUnresolvedRecovery();
  counts.backlog = counts.queued + counts.deferred + counts.leased;
  counts.readyNow = counts.queued;
  return counts;
}

async function getPublishedTexts() {
  const store = await getStore();
  const texts = [];
  let cursor = null;
  // Paginated so a long-lived install never loads the whole corpus at once.
  for (;;) {
    const page = store.listItems({ states: ['published'], limit: 500, after: cursor });
    if (page.length === 0) break;
    for (const item of page) {
      const text = textOf(item);
      if (text.trim()) texts.push(text);
    }
    const last = page[page.length - 1];
    cursor = { updatedAtMs: last.updatedAtMs, id: last.id };
    if (page.length < 500) break;
  }
  return texts;
}

// ── Queue writes ─────────────────────────────────────────────────────────────

async function addPosts(newPosts, _profileName) {
  const store = await getStore();
  // The WHOLE queue, not the first page: a duplicate past position 1000 was
  // otherwise queued a second time and published twice.
  const existing = collectQueuedTexts(store);

  const items = [];
  let skippedDuplicate = 0;
  for (const raw of newPosts || []) {
    if (raw === null || raw === undefined) continue;
    const source = typeof raw === 'string' ? raw : (raw.text || '');
    const text = typeof source === 'string'
      ? source.trim().replace(/^"|"$/g, '').replace(/""/g, '"').trim()
      : '';
    if (!text) continue;
    if (existing.has(text)) { skippedDuplicate += 1; continue; }
    existing.add(text);
    const mediaPath = typeof raw === 'object' && raw ? raw.media_path || null : null;
    items.push(mediaPath ? { text, media_path: mediaPath } : { text });
  }

  if (items.length === 0) {
    return { added: 0, skippedDuplicate, total: readAllQueuedItems(store).length };
  }
  const result = store.enqueue({ items, requestId: `add-posts:${Date.now()}:${items.length}` });
  return {
    added: result.items.length,
    skippedDuplicate,
    // The real total, not a capped one — this is the number the UI reports back.
    total: readAllQueuedItems(store).length,
  };
}

/**
 * Delete by durable item ID. IDs do not change when the queue is consumed,
 * reordered, deferred, or when two rows happen to contain identical text.
 */
function mutationRequest(raw, prefix) {
  if (typeof raw === 'string') {
    return { id: raw, expectedRevision: null, requestId: `${prefix}:legacy:${raw}` };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const expectedRevision = Number.isInteger(raw.expectedRevision) && raw.expectedRevision >= 0
    ? raw.expectedRevision
    : null;
  const requestId = typeof raw.requestId === 'string' && raw.requestId.trim()
    ? raw.requestId.trim()
    : `${prefix}:${id}:${expectedRevision ?? 'live'}`;
  return id ? { id, expectedRevision, requestId } : null;
}

/** Delete queue rows by stable UUID with compare-and-swap revision checks. */
async function bulkDeleteById(requests) {
  const store = await getStore();
  const normalized = (requests || []).map((entry) => mutationRequest(entry, 'bulk-delete-id')).filter(Boolean);
  if (normalized.length === 0) {
    return { deleted: 0, blocked: [], remaining: readAllBacklogItems(store).length };
  }

  const live = new Map(
    readAllItems(store, ['queued', 'deferred', 'leased', 'dispatch_started'])
      .map((item) => [item.id, item]),
  );
  let deleted = 0;
  const blocked = [];

  for (const request of normalized) {
    const item = live.get(request.id);
    if (!item) {
      blocked.push({ id: request.id, reason: 'NOT_FOUND' });
      continue;
    }
    if (request.expectedRevision !== null && request.expectedRevision !== item.revision) {
      blocked.push({
        id: item.id,
        text: textOf(item),
        reason: 'REVISION_CONFLICT',
        expectedRevision: request.expectedRevision,
        actualRevision: item.revision,
      });
      continue;
    }
    if (item.state !== 'queued' && item.state !== 'deferred') {
      blocked.push({ id: item.id, text: textOf(item), reason: `IN_FLIGHT_${item.state.toUpperCase()}` });
      continue;
    }
    try {
      store.discardQueued({
        id: item.id,
        expectedRevision: item.revision,
        requestId: request.requestId,
      });
      deleted += 1;
    } catch (error) {
      blocked.push({ id: item.id, text: textOf(item), reason: error.code || 'CONFLICT' });
    }
  }

  return { deleted, blocked, remaining: readAllBacklogItems(store).length };
}

/** Compatibility only: refuse duplicate text instead of guessing a row. */
async function bulkDeleteByText(texts) {
  const store = await getStore();
  const live = readAllItems(store, ['queued', 'deferred', 'leased', 'dispatch_started']);
  const requests = [];
  const blocked = [];
  for (const text of new Set((texts || []).filter((value) => typeof value === 'string'))) {
    const matches = live.filter((item) => textOf(item) === text);
    if (matches.length === 1) {
      requests.push({
        id: matches[0].id,
        expectedRevision: matches[0].revision,
        requestId: `bulk-delete-text-compat:${matches[0].id}:${matches[0].revision}`,
      });
    } else if (matches.length > 1) {
      blocked.push({ text, reason: 'AMBIGUOUS_TEXT_ADDRESS', ids: matches.map((item) => item.id) });
    } else {
      blocked.push({ text, reason: 'NOT_FOUND' });
    }
  }
  const result = await bulkDeleteById(requests);
  return { ...result, blocked: [...blocked, ...result.blocked] };
}

// ── Recovery// ── Recovery// ── Recovery ─────────────────────────────────────────────────────────────────

/**
 * Everything awaiting a human decision.
 *
 * `pending` are items that crossed the irreversible boundary with an unknown
 * outcome — they may or may not be live on X, so only the user can decide.
 * `deadLetters` are items that failed before the boundary and never went out.
 */
async function getRecoveryItems(_profileName) {
  const store = await getStore();
  const describe = (item) => ({
    id: item.id,
    revision: item.revision,
    text: textOf(item),
    media: (item.media || []).map((entry) => ({
      ordinal: entry.ordinal,
      sha256: entry.sha256,
      byteSize: entry.byteSize,
      managedPath: entry.managedPath,
    })),
    reason: item.reason,
    profileName: item.lastProfile ? item.lastProfile.name : null,
    attemptedText: item.currentAttempt ? item.currentAttempt.renderedText : null,
    evidence: item.currentAttempt ? item.currentAttempt.evidence : null,
    attemptId: item.currentAttempt ? item.currentAttempt.id : null,
    at: item.updatedAtMs ? new Date(item.updatedAtMs).toISOString() : null,
  });
  const pending = store.listRecovery().map(describe);
  const deadLetters = readAllItems(store, ['dead']).map(describe);
  return { pending, deadLetters };
}

function recoveryMatch(store, states, identity) {
  let request = mutationRequest(identity, 'recovery');
  if (typeof identity === 'string') {
    const direct = store.getItem(identity);
    if (direct && states.includes(direct.state)) {
      request = { id: direct.id, expectedRevision: direct.revision, requestId: 'recovery-id:' + direct.id + ':' + direct.revision };
    } else {
      const matches = readAllItems(store, states).filter((item) => textOf(item) === identity);
      if (matches.length > 1) {
        const error = new Error('Recovery text matches more than one durable item; refresh and use its ID.');
        error.code = 'AMBIGUOUS_TEXT_ADDRESS';
        error.ids = matches.map((item) => item.id);
        throw error;
      }
      if (matches.length === 0) return null;
      const item = matches[0];
      request = { id: item.id, expectedRevision: item.revision, requestId: 'recovery-text-compat:' + item.id + ':' + item.revision };
    }
  }
  if (!request) return null;
  if (typeof identity !== 'string' && request.expectedRevision === null) {
    const error = new Error('expectedRevision is required for recovery mutations.');
    error.code = 'REVISION_REQUIRED';
    throw error;
  }
  const item = store.getItem(request.id);
  if (!item || !states.includes(item.state)) return null;
  if (request.expectedRevision !== null && request.expectedRevision !== item.revision) {
    const error = new Error('The recovery item revision no longer matches. Refresh before acting.');
    error.code = 'REVISION_CONFLICT';
    error.expectedRevision = request.expectedRevision;
    error.actualRevision = item.revision;
    throw error;
  }
  return { request, item };
}

function requirePublishedProof(proof) {
  const externalUrl = typeof proof?.externalUrl === 'string' ? proof.externalUrl.trim() : '';
  const externalId = typeof proof?.externalId === 'string' ? proof.externalId.trim() : '';
  if (!externalUrl && !externalId) {
    const error = new Error('A status URL or external post ID is required to confirm publication.');
    error.code = 'PROOF_REQUIRED';
    throw error;
  }
  return { ...proof, externalUrl: externalUrl || null, externalId: externalId || null };
}

async function confirmPublished(identity, proof = {}) {
  const store = await getStore();
  const match = recoveryMatch(store, ['ambiguous'], identity);
  if (!match || !match.item.currentAttemptId) return false;
  const verifiedProof = requirePublishedProof(proof);
  store.markPublished({
    attemptId: match.item.currentAttemptId,
    externalId: verifiedProof.externalId,
    externalUrl: verifiedProof.externalUrl,
    evidence: { confirmed: true, source: 'manual_operator_check', ...verifiedProof },
    requestId: match.request.requestId,
  });
  return true;
}

async function confirmNotPublishedAndRequeue(identity, acknowledgement = {}) {
  const store = await getStore();
  const match = recoveryMatch(store, ['ambiguous'], identity);
  if (!match) return false;
  if (acknowledgement.confirmedNotPublished !== true) {
    const error = new Error('Explicit confirmedNotPublished=true is required.');
    error.code = 'CONFIRMATION_REQUIRED';
    throw error;
  }
  store.resolveRecovery({
    id: match.item.id,
    action: 'requeue',
    confirmedNotPublished: true,
    evidence: acknowledgement.evidence || null,
    requestId: match.request.requestId,
  });
  return true;
}

async function requeueDead(identity) {
  const store = await getStore();
  const match = recoveryMatch(store, ['dead'], identity);
  if (!match) return false;
  store.requeueTerminal({
    id: match.item.id,
    expectedRevision: match.item.revision,
    requestId: match.request.requestId,
  });
  return true;
}

async function discardDead(identity) {
  const store = await getStore();
  const match = recoveryMatch(store, ['dead'], identity);
  if (!match) return false;
  store.discardTerminal({
    id: match.item.id,
    expectedRevision: match.item.revision,
    requestId: match.request.requestId,
  });
  return true;
}

// Compatibility wrappers for older callers. Ambiguous rows may only be resolved
// by an explicit published/not-published decision; they cannot be generically closed.
async function requeueRecovery(_profileName, kind, identity, options = {}) {
  if (kind === 'dead') return requeueDead(identity);
  return confirmNotPublishedAndRequeue(identity, options);
}

async function discardRecovery(_profileName, kind, identity) {
  if (kind !== 'dead') {
    const error = new Error('Ambiguous publishing evidence cannot be discarded. Confirm published or confirm not published.');
    error.code = 'UNSAFE_RECOVERY_ACTION';
    throw error;
  }
  return discardDead(identity);
}

async function confirmRecoveryPublished(identity, proof = {}) {
  return confirmPublished(identity, proof);
}

// ── Maintenance// ── Maintenance// ── Maintenance ──────────────────────────────────────────────────────────────

/**
 * Bounded housekeeping for long-lived installs: reclaim stale leases, drop
 * orphaned media bytes, and prune the idempotency cache once nothing is in
 * flight. Safe to call on a timer; every step is a no-op when not needed.
 */
async function runMaintenance() {
  const store = await getStore();
  const reclaimed = store.reclaimExpiredLeases({ requestId: `maint-reclaim:${Date.now()}` });
  const media = store.sweepOrphanMedia();
  const pruned = store.pruneIdempotency({});
  const snapshot = await workflowBackup.maybeCreateSnapshot(store);
  return {
    reclaimedLeases: reclaimed.reclaimedIds.length,
    mediaFilesRemoved: media.deleted.length,
    mediaBytesReclaimed: media.reclaimedBytes,
    idempotencyPruned: pruned.deleted,
    prunedSkippedReason: pruned.skippedReason || null,
    snapshot,
  };
}

async function integrityCheck() {
  const store = await getStore();
  return store.integrityCheck();
}

async function createWorkflowSnapshot(options = {}) {
  const store = await getStore();
  assertHealthyResult(store.integrityCheck(), 'backup');
  return workflowBackup.createSnapshot(store, options);
}

async function listWorkflowSnapshots() {
  const store = await getStore();
  return workflowBackup.listSnapshots(store.rootDir);
}

async function countUnresolved() {
  const store = await getStore();
  return store.countUnresolvedRecovery();
}

async function closeStore() {
  if (cachedStore && !cachedStore.closed) {
    try { cachedStore.close(); } catch (error) { log.error('closing workflow store:', error?.message); }
  }
  cachedStore = null;
  storePromise = null;
}

module.exports = {
  getStore,
  closeStore,
  readAllQueuedItems,
  readAllItems,
  collectQueuedTexts,
  resolveProfileId,
  getQueue,
  getQueueDetailed,
  getReadyNow,
  getBacklogCounts,
  readAllBacklogItems,
  BACKLOG_STATES,
  UNRESOLVED_STATES,
  getPublishedTexts,
  addPosts,
  bulkDeleteById,
  bulkDeleteByText,
  getRecoveryItems,
  confirmPublished,
  confirmNotPublishedAndRequeue,
  requeueDead,
  discardDead,
  requeueRecovery,
  discardRecovery,
  confirmRecoveryPublished,
  runMaintenance,
  integrityCheck,
  assertHealthy,
  assertHealthyResult,
  criticalHealthProblems,
  createWorkflowSnapshot,
  listWorkflowSnapshots,
  countUnresolved,
  toLegacyEntry,
  textOf,
};
