const fs = require('fs').promises;
const path = require('path');
const os = require('os');

// ===== PER-PROFILE PATHS =====
const GLOBAL_PROFILES_DIR = path.join(os.homedir(), '.config', 'x-poster-profiles');

function getProfileDataDir(profileName) {
  const name = profileName || 'Default';
  if (name === 'Default') {
    // Backward compatibility — Default uses old path
    return path.join(os.homedir(), '.config', 'x-poster-bot-profile');
  }
  return path.join(GLOBAL_PROFILES_DIR, name);
}

function getQueueFile(profileName) {
  return path.join(getProfileDataDir(profileName), 'queue.json');
}

function getPendingFile(profileName) {
  return path.join(getProfileDataDir(profileName), 'pending-verification.json');
}

function getDeadLettersFile(profileName) {
  return path.join(getProfileDataDir(profileName), 'dead-letters.json');
}

// 🔒 Serialization mutex — prevents race conditions on concurrent queue operations
let _queueLock = Promise.resolve();

async function withLock(fn) {
  _queueLock = _queueLock.then(fn, fn);
  return _queueLock;
}

async function ensureDir(profileName) {
  const dir = getProfileDataDir(profileName);
  try {
    await fs.access(dir);
  } catch {
    await fs.mkdir(dir, { recursive: true });
  }
}

async function getQueue(profileName) {
  await ensureDir(profileName);
  try {
    const data = await fs.readFile(getQueueFile(profileName), 'utf8');
    return JSON.parse(data);
  } catch (e) {
    return [];
  }
}

async function saveQueue(queue, profileName) {
  await ensureDir(profileName);
  await fs.writeFile(getQueueFile(profileName), JSON.stringify(queue, null, 2));
}

async function addPosts(newPosts, profileName) {
  return withLock(async () => {
    const existingQueue = await getQueue(profileName);
    const existingTexts = new Set(existingQueue.map(p => typeof p === 'string' ? p : p.text));

    let added = 0;
    let skippedDuplicate = 0;

    const uniqueNewPosts = newPosts.map(postItem => {
      if (postItem === null || postItem === undefined) return null;
      const post = typeof postItem === 'string' ? postItem : (postItem.text || '');
      const text = typeof post === 'string' ? post.trim().replace(/^\"|\"$/g, '').replace(/\"\"/g, '\"').trim() : '';
      const mediaPath = typeof postItem === 'object' ? postItem.media_path : null;
      
      if (!text) return null;
      if (existingTexts.has(text)) {
        skippedDuplicate++;
        return null;
      }
      existingTexts.add(text);
      added++;
      
      return mediaPath ? { text, media_path: mediaPath } : text;
    }).filter(p => p !== null);

    const updatedQueue = [...existingQueue, ...uniqueNewPosts];
    await saveQueue(updatedQueue, profileName);
    return { added, skippedDuplicate, total: updatedQueue.length };
  });
}

async function deletePost(postText, profileName) {
  return withLock(async () => {
    const queue = await getQueue(profileName);
    const updatedQueue = queue.filter(p => {
      const itemText = typeof p === 'string' ? p : p.text;
      return itemText !== postText;
    });
    await saveQueue(updatedQueue, profileName);
  });
}

async function bulkDelete(indices, profileName) {
  return withLock(async () => {
    const queue = await getQueue(profileName);
    const updatedQueue = queue.filter((_, index) => !indices.includes(index));
    await saveQueue(updatedQueue, profileName);
    return updatedQueue;
  });
}

async function getPendingVerification(profileName) {
  await ensureDir(profileName);
  try {
    const data = await fs.readFile(getPendingFile(profileName), 'utf8');
    return JSON.parse(data);
  } catch (e) {
    return [];
  }
}

async function addToPending(postText, profileName) {
  return withLock(async () => {
    await ensureDir(profileName);
    const pending = await getPendingVerification(profileName);
    pending.push({ text: postText, addedAt: new Date().toISOString() });
    await fs.writeFile(getPendingFile(profileName), JSON.stringify(pending, null, 2));
  });
}

async function clearQueue(profileName) {
  await saveQueue([], profileName);
}

async function getDeadLetters(profileName) {
  await ensureDir(profileName);
  try {
    const data = await fs.readFile(getDeadLettersFile(profileName), 'utf8');
    return JSON.parse(data);
  } catch (e) {
    return [];
  }
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
  getQueue,
  addPosts,
  deletePost,
  bulkDelete,
  clearQueue,
  getPendingVerification,
  addToPending,
  getDeadLetters,
  addDeadLetter
};
