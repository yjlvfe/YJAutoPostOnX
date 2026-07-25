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
const { dispatchNext } = require('./publishWorkflow');
const { listProfilesOrdered, resolveProfilePath } = require('./profileRegistry');

const SHARED_DIR = path.join(os.homedir(), '.config', 'x-poster-shared');

let storePromise = null;
let cachedStore = null;

function legacyProfileDir(profileName) {
  const name = profileName || 'Default';
  if (name === 'Default') return path.join(os.homedir(), '.config', 'x-poster-bot-profile');
  return resolveProfilePath(name);
}

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
      const profileDirs = profileNames.map((name) => ({ name, dir: legacyProfileDir(name) }));
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
      // Anything left mid-flight by a previous process is resolved before the
      // first lease of this session.
      store.reconcileStartup({ requestId: `startup:${Date.now()}` });
      store.reclaimExpiredLeases({ requestId: `startup-reclaim:${Date.now()}` });
      cachedStore = store;
      return store;
    })();
    storePromise.catch(() => { storePromise = null; });
  }
  return storePromise;
}

function textOf(item) {
  return item && item.payload && typeof item.payload.text === 'string' ? item.payload.text : '';
}

/** Shape a durable item like the legacy queue entry the UI expects. */
function toLegacyEntry(item) {
  const media = item.media && item.media.length > 0 ? item.media[0] : null;
  const text = textOf(item);
  if (!media) return text;
  return { text, media_path: media.managedPath || media.originalPath };
}

/**
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
    legacyPath: legacyProfileDir(name),
    requestId: `create-profile:${name}`,
  });
  return created.id;
}

// ── Queue reads ──────────────────────────────────────────────────────────────

async function getQueue() {
  const store = await getStore();
  return store.listQueued({ limit: 1000 }).map(toLegacyEntry);
}

/** Full item records, for callers that need IDs/state rather than bare text. */
async function getQueueDetailed() {
  const store = await getStore();
  return store.listQueued({ limit: 1000 });
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
  const existing = new Set([
    ...store.listQueued({ limit: 1000 }).map(textOf),
  ]);

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
    return { added: 0, skippedDuplicate, total: store.listQueued({ limit: 1000 }).length };
  }
  const result = store.enqueue({ items, requestId: `add-posts:${Date.now()}:${items.length}` });
  return {
    added: result.items.length,
    skippedDuplicate,
    total: store.listQueued({ limit: 1000 }).length,
  };
}

/**
 * Delete by text, addressed against live state.
 *
 * A queued item is discarded into a non-resurrectable tombstone. An item that
 * is already leased or past the dispatch boundary is NOT silently reported as
 * deleted — that was the old bug where the UI claimed success while the post
 * still went out.
 */
async function bulkDeleteByText(texts) {
  const store = await getStore();
  const wanted = new Set((texts || []).filter((t) => typeof t === 'string'));
  if (wanted.size === 0) return { deleted: 0, blocked: [], remaining: (await getQueue()).length };

  let deleted = 0;
  const blocked = [];
  for (const item of store.listItems({ states: ['queued', 'deferred', 'leased', 'dispatch_started'], limit: 1000 })) {
    const text = textOf(item);
    if (!wanted.has(text)) continue;
    if (item.state === 'queued' || item.state === 'deferred') {
      try {
        store.discardQueued({
          id: item.id,
          expectedRevision: item.revision,
          requestId: `bulk-delete:${item.id}:${item.revision}`,
        });
        deleted += 1;
      } catch (error) {
        blocked.push({ text, reason: error.code || 'CONFLICT' });
      }
    } else {
      blocked.push({ text, reason: `IN_FLIGHT_${item.state.toUpperCase()}` });
    }
  }
  return { deleted, blocked, remaining: store.listQueued({ limit: 1000 }).length };
}

// ── Recovery ─────────────────────────────────────────────────────────────────

/**
 * Everything awaiting a human decision.
 *
 * `pending` are items that crossed the irreversible boundary with an unknown
 * outcome — they may or may not be live on X, so only the user can decide.
 * `deadLetters` are items that failed before the boundary and never went out.
 */
async function getRecoveryItems(_profileName) {
  const store = await getStore();
  const pending = store.listRecovery().map((item) => ({
    id: item.id,
    text: textOf(item),
    reason: item.reason,
    profileName: item.lastProfile ? item.lastProfile.name : null,
    attemptedText: item.currentAttempt ? item.currentAttempt.renderedText : null,
    evidence: item.currentAttempt ? item.currentAttempt.evidence : null,
    at: item.updatedAtMs ? new Date(item.updatedAtMs).toISOString() : null,
  }));
  const deadLetters = store.listItems({ states: ['dead'], limit: 500 }).map((item) => ({
    id: item.id,
    text: textOf(item),
    reason: item.reason,
    error: item.error,
    at: item.updatedAtMs ? new Date(item.updatedAtMs).toISOString() : null,
  }));
  return { pending, deadLetters };
}

/**
 * Put a recovery item back in the queue.
 *
 * For an ambiguous item this REQUIRES the user to confirm it was not published,
 * because requeueing something already live on X duplicates it irreversibly.
 */
async function requeueRecovery(_profileName, kind, postText, options = {}) {
  const store = await getStore();
  const states = kind === 'dead' ? ['dead'] : ['ambiguous'];
  const match = store.listItems({ states, limit: 500 }).find((item) => textOf(item) === postText);
  if (!match) return false;

  if (kind === 'dead') {
    store.requeueTerminal({
      id: match.id,
      expectedRevision: match.revision,
      requestId: `requeue-dead:${match.id}:${match.revision}`,
    });
    return true;
  }

  store.resolveRecovery({
    id: match.id,
    action: 'requeue',
    confirmedNotPublished: options.confirmedNotPublished === true,
    evidence: options.evidence || null,
    requestId: `requeue-ambiguous:${match.id}:${match.revision}`,
  });
  return true;
}

async function discardRecovery(_profileName, kind, postText) {
  const store = await getStore();
  const states = kind === 'dead' ? ['dead'] : ['ambiguous'];
  const match = store.listItems({ states, limit: 500 }).find((item) => textOf(item) === postText);
  if (!match) return false;
  store.resolveRecovery({
    id: match.id,
    action: 'close',
    evidence: { closedBy: 'user' },
    requestId: `discard-recovery:${match.id}:${match.revision}`,
  });
  return true;
}

/** Confirm an ambiguous item really was published, with proof. */
async function confirmRecoveryPublished(postText, proof = {}) {
  const store = await getStore();
  const match = store.listRecovery().find((item) => textOf(item) === postText);
  if (!match || !match.currentAttemptId) return false;
  store.markPublished({
    attemptId: match.currentAttemptId,
    externalId: proof.externalId || null,
    externalUrl: proof.externalUrl || null,
    evidence: { confirmed: true, source: 'manual_operator_check', ...proof },
    requestId: `confirm-published:${match.id}:${match.revision}`,
  });
  return true;
}

// ── Maintenance ──────────────────────────────────────────────────────────────

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
  return {
    reclaimedLeases: reclaimed.reclaimedIds.length,
    mediaFilesRemoved: media.deleted.length,
    mediaBytesReclaimed: media.reclaimedBytes,
    idempotencyPruned: pruned.deleted,
    prunedSkippedReason: pruned.skippedReason || null,
  };
}

async function integrityCheck() {
  const store = await getStore();
  return store.integrityCheck();
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
  resolveProfileId,
  getQueue,
  getQueueDetailed,
  getPublishedTexts,
  addPosts,
  bulkDeleteByText,
  getRecoveryItems,
  requeueRecovery,
  discardRecovery,
  confirmRecoveryPublished,
  runMaintenance,
  integrityCheck,
  countUnresolved,
  dispatchNext,
  toLegacyEntry,
  textOf,
};
