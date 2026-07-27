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
const storeHealth = require('./storeHealth');

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
      // Anything left mid-flight by a previous process is resolved before the
      // first lease of this session.
      store.reconcileStartup({ requestId: `startup:${Date.now()}` });
      store.reclaimExpiredLeases({ requestId: `startup-reclaim:${Date.now()}` });
      cachedStore = store;

      // Health, then backup, then retention — in that order, and awaited, so
      // the first lease of this session cannot happen before the gate has been
      // evaluated. Publishing from a store nobody has checked is exactly the
      // hole this closes.
      try {
        const maintenance = await storeHealth.runStartupMaintenance(store);
        if (maintenance.health.blocked) {
          log.error(`Durable store is unhealthy — publishing is blocked: ${maintenance.health.blocking.join('; ')}`);
        } else if (maintenance.health.warnings.length) {
          log.info(`Durable store warnings: ${maintenance.health.warnings.join('; ')}`);
        }
      } catch (error) {
        // A maintenance failure must not open the gate. If we cannot establish
        // health, we do not know it is safe to publish.
        log.error('Startup store maintenance failed:', error?.message || error);
        try {
          store.setHealthGate({ blocked: true, reason: `MAINTENANCE_FAILED: ${error?.message || error}` });
        } catch (gateError) {
          log.error('Could not latch the health gate:', gateError?.message || gateError);
        }
      }

      return store;
    })();
    storePromise.catch(() => { storePromise = null; });
  }
  return storePromise;
}

function textOf(item) {
  return item && item.payload && typeof item.payload.text === 'string' ? item.payload.text : '';
}

// ── Paginating reads ─────────────────────────────────────────────────────────
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

  // Retention moves finished work out of the live table to bound growth. The
  // dedup corpus must follow it there, or every post older than the retention
  // cutoff silently becomes eligible to be generated and published again.
  let archivedCursor = null;
  for (;;) {
    const page = store.listArchivedTexts({ limit: 500, after: archivedCursor });
    if (page.length === 0) break;
    for (const row of page) {
      if (row.text.trim()) texts.push(row.text);
    }
    const last = page[page.length - 1];
    archivedCursor = { archivedAtMs: last.archivedAtMs, id: last.id };
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
 * Delete the rows the operator selected, addressed by id.
 *
 * This is the path the queue screen uses. Deleting by text discarded EVERY row
 * carrying that text, so selecting one of two identical posts removed both and
 * the count returned to the UI was not the count of what was asked for.
 *
 * `expectedRevision` pins each deletion to the row as it was rendered. An item
 * that has since been leased or crossed the dispatch boundary is reported
 * blocked, never silently claimed as deleted — that post may still go out.
 */
async function bulkDeleteByIds(descriptors) {
  const store = await getStore();
  const list = Array.isArray(descriptors) ? descriptors : [];
  let deleted = 0;
  const blocked = [];

  for (const entry of list) {
    const id = typeof entry === 'string' ? entry : (entry && entry.id);
    const expectedRevision = typeof entry === 'object' && entry && Number.isInteger(entry.expectedRevision)
      ? entry.expectedRevision
      : null;
    if (typeof id !== 'string' || !id.trim()) {
      blocked.push({ id: String(id), reason: 'MISSING_ID' });
      continue;
    }
    const row = store.db
      .prepare('SELECT state, revision FROM workflow_items WHERE id = ?')
      .get(id);
    if (!row) { blocked.push({ id, reason: 'ITEM_NOT_FOUND' }); continue; }
    if (row.state !== 'queued' && row.state !== 'deferred') {
      blocked.push({ id, reason: `IN_FLIGHT_${row.state.toUpperCase()}`, state: row.state });
      continue;
    }
    if (expectedRevision !== null && row.revision !== expectedRevision) {
      blocked.push({ id, reason: 'REVISION_CONFLICT', state: row.state });
      continue;
    }
    try {
      store.discardQueued({
        id,
        expectedRevision: row.revision,
        requestId: `bulk-delete-id:${id}:${row.revision}`,
      });
      deleted += 1;
    } catch (error) {
      blocked.push({ id, reason: error.code || 'CONFLICT' });
    }
  }

  return { deleted, blocked, remaining: readAllQueuedItems(store).length };
}

/**
 * Delete EVERY row carrying one of these texts.
 *
 * Deliberately a bulk operation, and named as one. The per-row delete in the UI
 * goes through bulkDeleteByIds — this exists for clear-all style callers and
 * for scripts that only have a text.
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
  // Paged: an item past position 1000 was previously neither deleted nor
  // reported as blocked, so the UI showed a silent no-op.
  for (const item of readAllItems(store, ['queued', 'deferred', 'leased', 'dispatch_started'])) {
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
  return { deleted, blocked, remaining: readAllQueuedItems(store).length };
}

// ── Recovery ─────────────────────────────────────────────────────────────────

/**
 * Everything awaiting a human decision.
 *
 * `pending` are items that crossed the irreversible boundary with an unknown
 * outcome — they may or may not be live on X, so only the user can decide.
 * `deadLetters` are items that failed before the boundary and never went out.
 *
 * Both carry `id` and `revision`. Those are not decoration: they are the only
 * way the operator's click can name the row they were actually looking at.
 */
async function getRecoveryItems(_profileName) {
  const store = await getStore();
  const pending = store.listRecovery().map((item) => ({
    id: item.id,
    revision: item.revision,
    state: item.state,
    kind: 'pending',
    text: textOf(item),
    reason: item.reason,
    profileName: item.lastProfile ? item.lastProfile.name : null,
    attemptedText: item.currentAttempt ? item.currentAttempt.renderedText : null,
    evidence: item.currentAttempt ? item.currentAttempt.evidence : null,
    at: item.updatedAtMs ? new Date(item.updatedAtMs).toISOString() : null,
  }));
  const deadLetters = readAllItems(store, ['dead']).map((item) => ({
    id: item.id,
    revision: item.revision,
    state: item.state,
    kind: 'dead',
    text: textOf(item),
    reason: item.reason,
    error: item.error,
    at: item.updatedAtMs ? new Date(item.updatedAtMs).toISOString() : null,
  }));
  return { pending, deadLetters };
}

// ── Identity-addressed mutations ─────────────────────────────────────────────
//
// Every mutation below names its target by the durable UUID, optionally pinned
// to the revision the operator saw.
//
// The previous versions took the post TEXT and resolved it with
// `.find(item => textOf(item) === postText)`. Text is not an identity. Two rows
// may legally hold the same text — the enqueue dedup spans the backlog and the
// unresolved states but not `dead`, and requeueing a dead row whose text is
// already queued produces a matching pair — and `.find` returns whichever the
// scan reaches first, which is not the row under the operator's cursor. The
// observed result was a requeue reported as successful while a DIFFERENT post
// went back into the queue and the clicked one stayed dead.
//
// These return a typed result rather than a boolean. `false` told the UI
// nothing: "not found", "already resolved by another window" and "wrong state"
// all collapsed into one silent failure.

function failure(reason, code = null, extra = {}) {
  return { ok: false, reason, code, ...extra };
}

/**
 * Map a store conflict onto a result the UI can explain, without losing it.
 *
 * The original error rides along on `.error` so the text wrappers can keep
 * their historical contract of propagating conflicts — a caller that expects
 * CONFIRMATION_REQUIRED to throw must not silently receive `false` instead.
 * Anything that is not a typed store conflict is a bug, and is rethrown.
 */
function fromConflict(error) {
  if (error && error.code) {
    return { ...failure(error.message, error.code), error };
  }
  throw error;
}

/** Look up one item by id, restricted to the states this action may touch. */
async function findAddressed(id, states) {
  const store = await getStore();
  if (typeof id !== 'string' || !id.trim()) return { store, item: null, reason: 'MISSING_ID' };
  const row = store.db
    .prepare('SELECT state FROM workflow_items WHERE id = ?')
    .get(id);
  if (!row) return { store, item: null, reason: 'ITEM_NOT_FOUND' };
  if (!states.includes(row.state)) {
    return { store, item: null, reason: 'INVALID_STATE', state: row.state };
  }
  const item = readAllItems(store, [row.state]).find((i) => i.id === id);
  return { store, item: item || null, reason: item ? null : 'ITEM_NOT_FOUND' };
}

/**
 * Put one recovery item back in the queue, addressed by id.
 *
 * For an ambiguous item this REQUIRES the user to confirm it was not published,
 * because requeueing something already live on X duplicates it irreversibly.
 */
async function requeueRecoveryById({ id, kind, expectedRevision = null, options = {} } = {}) {
  const states = kind === 'dead' ? ['dead'] : ['ambiguous'];
  const { store, item, reason, state } = await findAddressed(id, states);
  if (!item) return failure(reason, reason, { id, state: state || null });
  if (expectedRevision !== null && item.revision !== expectedRevision) {
    return failure('REVISION_CONFLICT', 'REVISION_CONFLICT', { id, revision: item.revision });
  }

  try {
    if (kind === 'dead') {
      store.requeueTerminal({
        id: item.id,
        expectedRevision: item.revision,
        requestId: `requeue-dead:${item.id}:${item.revision}`,
      });
    } else {
      store.resolveRecovery({
        id: item.id,
        action: 'requeue',
        confirmedNotPublished: options.confirmedNotPublished === true,
        evidence: options.evidence || null,
        expectedRevision: item.revision,
        requestId: `requeue-ambiguous:${item.id}:${item.revision}`,
      });
    }
  } catch (error) {
    return fromConflict(error);
  }
  return { ok: true, id: item.id };
}

/**
 * Close one recovery item, addressed by id.
 *
 * A dead letter never crossed the boundary, so it is tombstoned as `discarded`.
 * An ambiguous item MAY be live on X, so it is closed as reviewed rather than
 * deleted — its attempt and evidence stay on the record.
 */
async function discardRecoveryById({ id, kind, expectedRevision = null } = {}) {
  const states = kind === 'dead' ? ['dead'] : ['ambiguous'];
  const { store, item, reason, state } = await findAddressed(id, states);
  if (!item) return failure(reason, reason, { id, state: state || null });
  if (expectedRevision !== null && item.revision !== expectedRevision) {
    return failure('REVISION_CONFLICT', 'REVISION_CONFLICT', { id, revision: item.revision });
  }

  try {
    if (kind === 'dead') {
      store.discardQueued({
        id: item.id,
        expectedRevision: item.revision,
        requestId: `discard-dead:${item.id}:${item.revision}`,
      });
    } else {
      store.resolveRecovery({
        id: item.id,
        action: 'close',
        evidence: { closedBy: 'user' },
        expectedRevision: item.revision,
        requestId: `discard-recovery:${item.id}:${item.revision}`,
      });
    }
  } catch (error) {
    return fromConflict(error);
  }
  return { ok: true, id: item.id };
}

/** Confirm one ambiguous item really was published, with proof, addressed by id. */
async function confirmRecoveryPublishedById({ id, proof = {}, expectedRevision = null } = {}) {
  const { store, item, reason, state } = await findAddressed(id, ['ambiguous']);
  if (!item) return failure(reason, reason, { id, state: state || null });
  if (expectedRevision !== null && item.revision !== expectedRevision) {
    return failure('REVISION_CONFLICT', 'REVISION_CONFLICT', { id, revision: item.revision });
  }
  if (!item.currentAttemptId) {
    return failure('NO_OPEN_ATTEMPT', 'NO_OPEN_ATTEMPT', { id: item.id });
  }

  try {
    store.markPublished({
      attemptId: item.currentAttemptId,
      externalId: proof.externalId || null,
      externalUrl: proof.externalUrl || null,
      evidence: { confirmed: true, source: 'manual_operator_check', ...proof },
      requestId: `confirm-published:${item.id}:${item.revision}`,
    });
  } catch (error) {
    return fromConflict(error);
  }
  return { ok: true, id: item.id };
}

// ── Text-addressed wrappers ──────────────────────────────────────────────────
//
// Kept for callers that legitimately have only a text (scripts, migrations,
// tests), but they now REFUSE an ambiguous text instead of guessing. If two
// rows carry the same text there is no answer to "which one did you mean", and
// picking the first was the defect.

async function resolveUniqueByText(states, postText) {
  const store = await getStore();
  const matches = readAllItems(store, states).filter((item) => textOf(item) === postText);
  if (matches.length === 0) return { id: null, reason: 'ITEM_NOT_FOUND' };
  if (matches.length > 1) return { id: null, reason: 'AMBIGUOUS_TEXT', count: matches.length };
  return { id: matches[0].id, reason: null };
}

/** Boolean contract, with store conflicts propagating as they always did. */
function unwrap(result) {
  if (result.ok) return true;
  if (result.error) throw result.error;
  return false;
}

async function requeueRecovery(_profileName, kind, postText, options = {}) {
  const { id } = await resolveUniqueByText(kind === 'dead' ? ['dead'] : ['ambiguous'], postText);
  if (!id) return false;
  return unwrap(await requeueRecoveryById({ id, kind, options }));
}

async function discardRecovery(_profileName, kind, postText) {
  const { id } = await resolveUniqueByText(kind === 'dead' ? ['dead'] : ['ambiguous'], postText);
  if (!id) return false;
  return unwrap(await discardRecoveryById({ id, kind }));
}

async function confirmRecoveryPublished(postText, proof = {}) {
  const { id } = await resolveUniqueByText(['ambiguous'], postText);
  if (!id) return false;
  return unwrap(await confirmRecoveryPublishedById({ id, proof }));
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

/** Full health verdict, and the latch beginDispatch actually reads. */
async function checkHealth({ verifyMedia = true } = {}) {
  const store = await getStore();
  return storeHealth.evaluate(store, { verifyMedia });
}

/** The cheap re-check a run must pass before it may publish anything. */
async function gateBeforeRun(options = {}) {
  const store = await getStore();
  return storeHealth.gateBeforeRun(store, options);
}

/** Take a verified backup now, on the operator's request. */
async function backupNow(options = {}) {
  const store = await getStore();
  return store.backup(options);
}

/** Apply the retention policy now, on the operator's request. */
async function applyRetention(options = {}) {
  const store = await getStore();
  return store.applyRetention(options);
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
  bulkDeleteByIds,
  bulkDeleteByText,
  getRecoveryItems,
  requeueRecoveryById,
  discardRecoveryById,
  confirmRecoveryPublishedById,
  requeueRecovery,
  discardRecovery,
  confirmRecoveryPublished,
  runMaintenance,
  integrityCheck,
  checkHealth,
  gateBeforeRun,
  backupNow,
  applyRetention,
  countUnresolved,
  toLegacyEntry,
  textOf,
};
