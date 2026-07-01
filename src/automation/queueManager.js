const fs = require('fs').promises;
const path = require('path');
const os = require('os');

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

// Pending / dead-letters still live per-profile (they're profile-specific)
function getPendingFile(profileName) {
  return path.join(getProfileDataDir(profileName), 'pending-verification.json');
}
function getDeadLettersFile(profileName) {
  return path.join(getProfileDataDir(profileName), 'dead-letters.json');
}

// 🔒 Serialization mutex
let _queueLock = Promise.resolve();
async function withLock(fn) {
  _queueLock = _queueLock.then(fn, fn);
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

async function saveQueue(queue) {
  return withLock(() => _saveQueueRaw(queue));
}

// ── Position tracker ─────────────────────────────────────────────────────────
async function getPositions() {
  return withLock(_getPositionsRaw);
}

async function savePositions(positions) {
  return withLock(() => _savePositionsRaw(positions));
}

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
 * Reset a profile's position to 0 (start over from beginning).
 */
async function resetPosition(profileName) {
  return withLock(async () => {
    const positions = await _getPositionsRaw();
    positions[profileName] = 0;
    await _savePositionsRaw(positions);
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

async function deletePost(postText /* profileName not needed */) {
  return withLock(async () => {
    const queue = await _getQueueRaw();
    const idx = queue.findIndex(p => {
      const t = typeof p === 'string' ? p : p.text;
      return t === postText;
    });
    if (idx === -1) return; // already gone

    const updatedQueue = queue.filter((_, i) => i !== idx);
    await _saveQueueRaw(updatedQueue);

    // Shift all profile positions that were PAST the deleted index
    const positions = await _getPositionsRaw();
    let changed = false;
    for (const name of Object.keys(positions)) {
      if (positions[name] > idx) {
        positions[name] = Math.max(0, positions[name] - 1);
        changed = true;
      }
    }
    if (changed) await _savePositionsRaw(positions);
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

// 🔒 C5: clearQueue now runs under lock + uses _Raw helpers (was lock-less →
// could race with a concurrent addPosts/deletePost and corrupt queue.json).
async function clearQueue() {
  return withLock(async () => {
    await _saveQueueRaw([]);
    await _savePositionsRaw({});
  });
}

// ── Pending / Dead-letters (still per-profile) ───────────────────────────────
async function getPendingVerification(profileName) {
  await ensureDir(profileName);
  try {
    const data = await fs.readFile(getPendingFile(profileName), 'utf8');
    return JSON.parse(data);
  } catch { return []; }
}

async function addToPending(postText, profileName) {
  return withLock(async () => {
    await ensureDir(profileName);
    const pending = await getPendingVerification(profileName);
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

module.exports = {
  getProfileDataDir,
  // Shared queue
  getQueue,
  getProfileQueue,
  getProfilePosition,
  advancePosition,
  resetPosition,
  addPosts,
  deletePost,
  bulkDelete,
  clearQueue,
  // Per-profile
  getPendingVerification,
  addToPending,
  getDeadLetters,
  addDeadLetter,
};
