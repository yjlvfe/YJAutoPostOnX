const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const log = require('../utils/logger');

// ===== SHARED QUEUE — one queue.json for ALL profiles =====
// Each profile has its own "position pointer" so it continues from where it left off.
// This is the single source of truth for all posts across all profiles.

const SHARED_DIR  = path.join(os.homedir(), '.config', 'x-poster-shared');
const QUEUE_FILE  = path.join(SHARED_DIR, 'queue.json');
const POS_FILE    = path.join(SHARED_DIR, 'positions.json');   // { profileName: index }

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

async function _getPositionsRaw() {
  await ensureSharedDir();
  try {
    const data = await fs.readFile(POS_FILE, 'utf8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

async function _savePositionsRaw(positions) {
  await ensureSharedDir();
  await fs.writeFile(POS_FILE, JSON.stringify(positions, null, 2));
}

// Public: lock-protected reads/writes (for IPC + external callers).
// Internal callers already inside withLock use the _Raw helpers above.
async function getQueue(/* profileName ignored — queue is global */) {
  return withLock(_getQueueRaw);
}

// ── Position tracker ─────────────────────────────────────────────────────────

/**
 * Get the current queue position for a profile.
 * Returns the index of the next post to publish (0-based).
 */
async function getProfilePosition(profileName) {
  // 🔒 C4: read under lock so we don't race with a concurrent write.
  return withLock(async () => {
    const positions = await _getPositionsRaw();
    const pos = positions[profileName] ?? 0;
    const queue = await _getQueueRaw();
    // Clamp to valid range
    return Math.min(pos, queue.length);
  });
}

/**
 * Advance the profile position by `count` posts.
 * Called by xPoster after each successful/failed post.
 */
async function advancePosition(profileName, count = 1) {
  return withLock(async () => {
    const positions = await _getPositionsRaw();
    const queue = await _getQueueRaw();
    const current = positions[profileName] ?? 0;
    positions[profileName] = Math.min(current + count, queue.length);
    await _savePositionsRaw(positions);
    return positions[profileName];
  });
}

/**
 * Move a profile's queue cursor to a new profile name (profile rename).
 * Without this, renaming a profile silently reset it to post #1.
 */
async function renameProfilePosition(oldName, newName) {
  return withLock(async () => {
    const positions = await _getPositionsRaw();
    if (Object.prototype.hasOwnProperty.call(positions, oldName)) {
      positions[newName] = positions[oldName];
      delete positions[oldName];
      await _savePositionsRaw(positions);
    }
  });
}

/** Drop a profile's queue cursor entirely (profile deletion). */
async function removeProfilePosition(profileName) {
  return withLock(async () => {
    const positions = await _getPositionsRaw();
    if (Object.prototype.hasOwnProperty.call(positions, profileName)) {
      delete positions[profileName];
      await _savePositionsRaw(positions);
    }
  });
}

/**
 * Get the slice of the queue that a profile should post next.
 * Returns { posts, startIndex } where posts[0] is at queue[startIndex].
 */
async function getProfileQueue(profileName) {
  // 🔒 C4: atomic snapshot of queue + position (no torn read).
  return withLock(async () => {
    const queue = await _getQueueRaw();
    const positions = await _getPositionsRaw();
    let startIndex = positions[profileName] ?? 0;
    startIndex = Math.min(startIndex, queue.length);
    const posts = queue.slice(startIndex);
    return { posts, startIndex, total: queue.length };
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
    const sortedIndices = [...new Set(indices)].sort((a, b) => a - b);
    const updatedQueue = queue.filter((_, i) => !sortedIndices.includes(i));
    await _saveQueueRaw(updatedQueue);

    // Shift profile positions
    const positions = await _getPositionsRaw();
    let changed = false;
    for (const name of Object.keys(positions)) {
      let pos = positions[name];
      for (const idx of sortedIndices) {
        if (pos > idx) pos--;
      }
      pos = Math.max(0, Math.min(pos, updatedQueue.length));
      if (pos !== positions[name]) { positions[name] = pos; changed = true; }
    }
    if (changed) await _savePositionsRaw(positions);
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
  getProfileQueue,
  getProfilePosition,
  advancePosition,
  renameProfilePosition,
  removeProfilePosition,
  addPosts,
  bulkDelete,
  // Per-profile
  addToPending,
  addDeadLetter,
  getDeferred,
  addDeferred,
  removeDeferred,
};
