'use strict';

/**
 * profileLifecycle.js — rename and delete a profile without losing its identity.
 *
 * The bug this replaces: the IPC handlers renamed a DIRECTORY and migrated a
 * cooldown, and touched the durable store not at all. But `resolveProfileId()`
 * maps a profile to its store row BY NAME, so the next run after a rename
 * minted a brand-new UUID — leaving the old row active alongside the new one.
 * Everything keyed to the old identity (published history, recovery items,
 * in-flight leases) silently detached from the profile the operator was
 * looking at. Deleting was worse: the directory went away while the durable
 * profile stayed `active`, so `beginDispatch` still returned ok and a deleted
 * profile could publish.
 *
 * The rules here:
 *
 *   - The UUID is the identity. The name is a mutable label, nothing more.
 *   - Rename is staged (store → filesystem → cooldown) with a rollback, so a
 *     failure halfway cannot leave the two disagreeing about which name is real.
 *   - Delete is ordered so that the durable state stops publishing FIRST and
 *     the bytes go away last. Cancel the run, join it, mark the profile
 *     deleted, and only then touch the filesystem — the reverse order allows a
 *     window where a run is still publishing from a directory being deleted.
 *   - Nothing here deletes recovery or published evidence. A profile can be
 *     removed; the proof of what it published cannot.
 *
 * Extracted from main.js so it is reachable without booting Electron — the IPC
 * handlers are thin wrappers over these functions, and the tests drive the same
 * code the app runs.
 */

const fsp = require('fs').promises;

const durableQueue = require('./durableQueue');
const rateLimitStore = require('./rateLimitStore');
const {
  listProfilesOrdered,
  assertSafeProfileName,
  resolveProfilePath,
  stripLeadingNumber,
  profileNumber,
  nextProfileNumber,
} = require('./profileRegistry');

/** Resolve the durable row for a profile name without creating one. */
async function findProfileRow(name) {
  const store = await durableQueue.getStore();
  return store.db.prepare('SELECT id, name, status FROM profiles WHERE name = ?').get(name) || null;
}

/**
 * Rename a profile, keeping its UUID.
 *
 * @param {object} deps.stopRuns  async (profileName) => void — cancel + join any
 *                                run publishing as this profile. A rename while
 *                                a run holds a claim would otherwise leave the
 *                                run pointing at a directory that moved.
 */
async function renameProfile(oldName, newName, { stopRuns = null } = {}) {
  if (!oldName || oldName === 'Default') {
    return { success: false, code: 'DEFAULT_IMMUTABLE', error: 'لا يمكن تعديل البروفايل الافتراضي' };
  }
  const safeOld = assertSafeProfileName(oldName, { allowDefault: false });
  // Renaming changes only the LABEL — the profile keeps its sequence number.
  const label = stripLeadingNumber(newName || '').replace(/[/<>:"\\|?*.]/g, '').trim();
  if (!safeOld || !label) return { success: false, code: 'INVALID_NAME', error: 'الاسم غير صالح' };

  const keepNum = profileNumber(safeOld) ?? await nextProfileNumber();
  const safeNew = assertSafeProfileName(`${keepNum}- ${label}`, { allowDefault: false });

  if (safeNew === safeOld) {
    const row = await findProfileRow(safeOld);
    return { success: true, unchanged: true, profile: { name: safeOld, id: row ? row.id : null } };
  }

  const existing = await listProfilesOrdered();
  // Case- and Unicode-insensitive duplicate check: two profiles whose labels
  // differ only by case or composition are the same profile to a human, and
  // the filesystem may or may not agree depending on the platform.
  const norm = (s) => stripLeadingNumber(s).normalize('NFC').toLocaleLowerCase();
  if (existing.some((n) => n !== safeOld && norm(n) === norm(safeNew))) {
    return { success: false, code: 'NAME_EXISTS', error: 'يوجد بروفايل بنفس الاسم بالفعل' };
  }

  if (stopRuns) await stopRuns(safeOld);

  // The UUID is resolved BEFORE anything moves, so the rename is applied to the
  // identity that already owns this profile's history.
  const store = await durableQueue.getStore();
  const profileId = await durableQueue.resolveProfileId(safeOld);

  const oldPath = resolveProfilePath(safeOld);
  const newPath = resolveProfilePath(safeNew);

  // Stage 1 — durable identity. If this fails nothing has moved yet.
  store.renameProfile({
    profileId,
    newName: safeNew,
    requestId: `rename-profile:${profileId}:${safeNew}`,
  });

  // Stage 2 — filesystem. On failure, put the durable name back so the two
  // never disagree; a half-applied rename is what orphans a queue.
  try {
    await fsp.rename(oldPath, newPath);
  } catch (error) {
    try {
      store.renameProfile({
        profileId,
        newName: safeOld,
        requestId: `rename-profile-rollback:${profileId}:${safeOld}:${Date.now()}`,
      });
    } catch { /* the reconciliation below is the backstop */ }
    return { success: false, code: 'FS_RENAME_FAILED', error: error.message, profileId };
  }

  // Stage 3 — cooldown is keyed by name; without this a renamed profile
  // silently loses an active rate-limit cooldown.
  try { rateLimitStore.renameProfile(safeOld, safeNew); } catch { /* best-effort */ }

  return { success: true, profileId, profile: { id: profileId, name: safeNew } };
}

/**
 * Delete a profile: stop publishing as it, retire it durably, then remove bytes.
 *
 * @param {object} deps.stopRuns  async (profileName) => void — cancel + join.
 */
async function deleteProfile(profileName, { stopRuns = null, removeFiles = true } = {}) {
  if (!profileName || profileName === 'Default') {
    return { success: false, code: 'DEFAULT_IMMUTABLE', error: 'لا يمكن حذف البروفايل الافتراضي' };
  }
  const safeName = assertSafeProfileName(profileName, { allowDefault: false });

  // 1. Stop any run publishing as this profile and WAIT for it. A delete that
  //    races a live dispatch must not win before the keystroke has settled.
  if (stopRuns) await stopRuns(safeName);

  const store = await durableQueue.getStore();
  const row = await findProfileRow(safeName);

  // 2. Retire the durable identity FIRST. From this moment `beginDispatch`
  //    refuses with PROFILE_NOT_ACTIVE, so nothing can publish as this profile
  //    even if a worker is somehow still mid-loop.
  let profileId = row ? row.id : null;
  if (row && row.status === 'active') {
    store.softDeleteProfile({
      profileId: row.id,
      requestId: `soft-delete-profile:${row.id}`,
    });
  }

  // 3. Only now remove the bytes. Recovery and published evidence live in the
  //    store and are deliberately untouched — a deleted profile does not erase
  //    the record of what it published.
  if (removeFiles) {
    try {
      await fsp.rm(resolveProfilePath(safeName), { recursive: true, force: true });
    } catch (error) {
      return {
        success: false, code: 'FS_DELETE_FAILED', error: error.message, profileId,
        durablyDeleted: true,
      };
    }
  }

  try { rateLimitStore.clearCooldown(safeName); } catch { /* best-effort */ }

  return { success: true, profileId, durablyDeleted: !!profileId };
}

module.exports = { renameProfile, deleteProfile, findProfileRow };
