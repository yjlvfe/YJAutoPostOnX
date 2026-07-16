const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const log = require('../utils/logger');

// ===== SHARED QUEUE — one queue.json for ALL profiles =====
// A CONSUMABLE FIFO: publishing always takes queue[0], and a post that goes out
// successfully is removed from queue.json immediately and permanently
// (consumePost). A post is therefore published exactly ONCE, by whichever
// profile reaches it first — the queue is work to divide, not a playlist each
// account replays.
//
// This replaces the old "append-only queue + per-profile position cursor"
// model (positions.json), which never deleted anything: publishing only bumped
// a counter, so every published post stayed in queue.json and reappeared in the
// UI the moment the run ended. That cursor also contradicted the rate-limit
// hand-off design, which assumes an unpublished post is still IN the queue for
// the next account to pick up. positions.json is no longer read or written; a
// leftover file from an older version is inert and can be deleted.

const SHARED_DIR  = path.join(os.homedir(), '.config', 'x-poster-shared');
const QUEUE_FILE  = path.join(SHARED_DIR, 'queue.json');
// Texts of posts that actually went out, kept AFTER they leave the queue.
// The "never repeat the same meaning, with no time window" guarantee used to
// ride on queue.json being append-only — every post ever added stayed there and
// so stayed in the semantic-dedup corpus. Now that publishing deletes the post,
// that corpus would shrink and the studio could regenerate a tweet it already
// published. This archive keeps the guarantee without keeping the post in the
// queue: it feeds dedup, it is never republished from.
const PUBLISHED_FILE = path.join(SHARED_DIR, 'published.json');

// Legacy per-profile paths (kept for session browser data — NOT for queue)
const GLOBAL_PROFILES_DIR = path.join(os.homedir(), '.config', 'x-poster-profiles');

function getProfileDataDir(profileName) {
  const name = profileName || 'Default';
  if (name === 'Default') {
    return path.join(os.homedir(), '.config', 'x-poster-bot-profile');
  }
  return path.join(GLOBAL_PROFILES_DIR, name);
}

// Pending / dead-letters / deferred still live per-profile (profile-specific)
function getPendingFile(profileName) {
  return path.join(getProfileDataDir(profileName), 'pending-verification.json');
}
function getDeadLettersFile(profileName) {
  return path.join(getProfileDataDir(profileName), 'dead-letters.json');
}
// v5.12.0: transient (network) failures land here instead of dead-letters —
// see addDeferred/getDeferred/removeDeferred below.
function getDeferredFile(profileName) {
  return path.join(getProfileDataDir(profileName), 'deferred-posts.json');
}

// 🔒 Serialization mutex
// ⚡ FIX: use .then(fn, () => fn()) so that if fn rejects, the error handler
// re-invokes fn with NO arguments (not with the Error object as first arg).
// The old .then(fn, fn) pattern would pass the rejection reason as the first
// argument to fn on retry — _saveQueueRaw(queue) would receive an Error
// instead of the queue array and write garbage to queue.json.
let _queueLock = Promise.resolve();
async function withLock(fn) {
  _queueLock = _queueLock.then(fn, () => fn());
  return _queueLock;
}

async function ensureSharedDir() {
  try { await fs.access(SHARED_DIR); }
  catch { await fs.mkdir(SHARED_DIR, { recursive: true }); }
}

async function ensureDir(profileName) {
  const dir = getProfileDataDir(profileName);
  try { await fs.access(dir); }
  catch { await fs.mkdir(dir, { recursive: true }); }
}

// ── Shared queue read/write ──────────────────────────────────────────────────
// 🔒 C4: Internal helpers (NO lock) for use INSIDE already-locked sections.
// The public functions below wrap these with withLock() — calling a locking
// public fn from inside a withLock block would deadlock (Promise chain not
// re-entrant), so internal callers use the _Raw helpers.
async function _getQueueRaw() {
  await ensureSharedDir();
  try {
    const data = await fs.readFile(QUEUE_FILE, 'utf8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

async function _saveQueueRaw(queue) {
  await ensureSharedDir();
  await fs.writeFile(QUEUE_FILE, JSON.stringify(queue, null, 2));
}

/** Text of a queue entry — entries are stored either as a bare string or as
 *  { text, media_path }. */
function postTextOf(item) {
  if (typeof item === 'string') return item;
  return item && typeof item === 'object' ? (item.text || '') : '';
}

// Public: lock-protected reads/writes (for IPC + external callers).
// Internal callers already inside withLock use the _Raw helpers above.
async function getQueue(/* profileName ignored — queue is global */) {
  return withLock(_getQueueRaw);
}

// ── Consume ──────────────────────────────────────────────────────────────────

/**
 * Permanently remove a post from the shared queue.
 *
 * Called the instant a post is confirmed published, so it can never be
 * republished by this profile, by another profile, or by a later run — and so
 * it disappears from the UI list for good. This is the ONLY thing that makes
 * the queue shrink during a run.
 *
 * Matches on the STORED text (the first occurrence — FIFO), not on an index:
 * an index captured before publishing can be invalidated by a concurrent
 * add/delete from the UI, which would silently delete the wrong post. Pass the
 * raw stored text, NOT the spintax-expanded text that was actually typed.
 *
 * @param {string} postText - the post as stored in the queue.
 * @param {{ published?: boolean }} [opts] - `published: true` also records the
 *   text in the published archive, so the studio's semantic dedup keeps seeing
 *   it forever. Pass false (the default) when removing a post that never went
 *   out — e.g. escalating to a dead-letter — so the user is still free to
 *   regenerate that idea later.
 * @returns {boolean} true if an entry was removed.
 */
async function consumePost(postText, opts = {}) {
  return withLock(async () => {
    const queue = await _getQueueRaw();
    const idx = queue.findIndex(item => postTextOf(item) === postText);
    if (idx === -1) return false;
    queue.splice(idx, 1);
    await _saveQueueRaw(queue);
    if (opts.published) {
      // Best-effort: a post that went out must never be resurrected by an
      // archive write failing, so this can't be allowed to throw.
      try {
        const archive = await _getPublishedRaw();
        archive.push({ text: postText, publishedAt: new Date().toISOString() });
        await fs.writeFile(PUBLISHED_FILE, JSON.stringify(archive, null, 2));
      } catch (e) {
        log.error('Failed to archive published post (dedup corpus may miss it):', e?.message);
      }
    }
    return true;
  });
}

async function _getPublishedRaw() {
  await ensureSharedDir();
  try {
    return JSON.parse(await fs.readFile(PUBLISHED_FILE, 'utf8'));
  } catch {
    return [];
  }
}

/** Texts of every post that has actually been published. Feeds the studio's
 *  semantic-dedup corpus — see PUBLISHED_FILE. */
async function getPublishedTexts() {
  return withLock(async () => {
    const archive = await _getPublishedRaw();
    return archive.map(e => (typeof e === 'string' ? e : e && e.text)).filter(t => typeof t === 'string' && t.trim());
  });
}

// ── Add / delete posts ───────────────────────────────────────────────────────
async function addPosts(newPosts, /* profileName ignored */ _profileName) {
  return withLock(async () => {
    const existingQueue = await _getQueueRaw();
    const existingTexts = new Set(existingQueue.map(p => typeof p === 'string' ? p : p.text));

    let added = 0;
    let skippedDuplicate = 0;

    const uniqueNewPosts = newPosts.map(postItem => {
      if (postItem === null || postItem === undefined) return null;
      const post = typeof postItem === 'string' ? postItem : (postItem.text || '');
      const text = typeof post === 'string' ? post.trim().replace(/^\"|\"$/g, '').replace(/\"\"/g, '\"').trim() : '';
      const mediaPath = typeof postItem === 'object' ? postItem.media_path : null;

      if (!text) return null;
      if (existingTexts.has(text)) { skippedDuplicate++; return null; }
      existingTexts.add(text);
      added++;
      return mediaPath ? { text, media_path: mediaPath } : text;
    }).filter(p => p !== null);

    const updatedQueue = [...existingQueue, ...uniqueNewPosts];
    await _saveQueueRaw(updatedQueue);
    return { added, skippedDuplicate, total: updatedQueue.length };
  });
}

async function bulkDelete(indices /* profileName not needed */) {
  return withLock(async () => {
    const queue = await _getQueueRaw();
    const sortedIndices = new Set(indices);
    const updatedQueue = queue.filter((_, i) => !sortedIndices.has(i));
    await _saveQueueRaw(updatedQueue);
    return updatedQueue;
  });
}

// ── Pending / Dead-letters (still per-profile) ───────────────────────────────
// 🔒 C4: read pending inside the SAME withLock block so parallel calls
// don't race — both reads and writes are serialised under the same mutex.
async function addToPending(postText, profileName) {
  return withLock(async () => {
    await ensureDir(profileName);
    // Read pending UNDER the lock (was lock-less → race window).
    let pending = [];
    try {
      pending = JSON.parse(await fs.readFile(getPendingFile(profileName), 'utf8'));
    } catch { pending = []; }
    pending.push({ text: postText, addedAt: new Date().toISOString() });
    await fs.writeFile(getPendingFile(profileName), JSON.stringify(pending, null, 2));
  });
}

async function getDeadLetters(profileName) {
  await ensureDir(profileName);
  try {
    const data = await fs.readFile(getDeadLettersFile(profileName), 'utf8');
    return JSON.parse(data);
  } catch { return []; }
}

async function addDeadLetter(postText, errorType, errorMsg, profileName) {
  return withLock(async () => {
    await ensureDir(profileName);
    const letters = await getDeadLetters(profileName);
    letters.push({ text: postText, errorType, errorMsg, failedAt: new Date().toISOString() });
    await fs.writeFile(getDeadLettersFile(profileName), JSON.stringify(letters, null, 2));
  });
}

// ── Deferred posts (v5.12.0) ─────────────────────────────────────────────────
// Transient (network) publish failures land here instead of a permanent
// dead-letter: "try another post now, retry this one on the next run" per
// the user's request. Distinct from dead-letters (which are for failures
// unlikely to succeed on retry — see xPoster.js's errorType classification).
async function getDeferred(profileName) {
  await ensureDir(profileName);
  try {
    const data = await fs.readFile(getDeferredFile(profileName), 'utf8');
    return JSON.parse(data);
  } catch { return []; }
}

/**
 * Add a deferred entry, or bump the attempt count if this exact text is
 * already deferred for this profile. Returns the entry's new `attempts`
 * count so the caller can decide whether to give up and fall through to a
 * permanent dead-letter instead (see CONSECUTIVE_FAILURE_LIMIT-style caps
 * in xPoster.js) — this function only persists, it never decides.
 */
async function addDeferred(postText, errorMsg, profileName) {
  return withLock(async () => {
    await ensureDir(profileName);
    const list = await getDeferred(profileName);
    const now = new Date().toISOString();
    const existing = list.find(d => d.text === postText);
    if (existing) {
      existing.attempts = (existing.attempts || 1) + 1;
      existing.lastDeferredAt = now;
      existing.errorMsg = errorMsg;
    } else {
      list.push({ text: postText, attempts: 1, firstDeferredAt: now, lastDeferredAt: now, errorMsg });
    }
    await fs.writeFile(getDeferredFile(profileName), JSON.stringify(list, null, 2));
    return existing ? existing.attempts : 1;
  });
}

/** Remove a deferred entry (on success, or after it's escalated to a dead-letter). */
async function removeDeferred(profileName, postText) {
  return withLock(async () => {
    await ensureDir(profileName);
    const list = await getDeferred(profileName);
    const updated = list.filter(d => d.text !== postText);
    if (updated.length !== list.length) {
      await fs.writeFile(getDeferredFile(profileName), JSON.stringify(updated, null, 2));
    }
  });
}

module.exports = {
  getProfileDataDir,
  // Shared queue
  getQueue,
  consumePost,
  getPublishedTexts,
  addPosts,
  bulkDelete,
  // Per-profile
  addToPending,
  addDeadLetter,
  getDeferred,
  addDeferred,
  removeDeferred,
};
