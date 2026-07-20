/**
 * profileRegistry.js — mandatory profile numbering + ordered listing
 * ==================================================================
 * Every profile carries a MANDATORY sequence number inside its name, added
 * by the system (never typed by the user): the Default profile is #1, and
 * each created profile gets the next number — "2- محمد", "3- علي", … The
 * run order and the "start from the selected profile" logic both key off
 * this number.
 */

'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs').promises;
const rateLimitStore = require('./rateLimitStore');

// Resolved lazily so tests can point HOME at an isolated directory.
function profilesDir() {
  return path.join(os.homedir(), '.config', 'x-poster-profiles');
}

function assertSafeProfileName(name, { allowDefault = true } = {}) {
  if (allowDefault && name === 'Default') return 'Default';
  if (typeof name !== 'string') throw new Error('اسم البروفايل غير صالح');
  const value = name.trim();
  if (!value || value === '.' || value === '..' || value.includes('\0') || /[\\/]/.test(value)) {
    throw new Error('اسم البروفايل يحتوي على مسار غير مسموح');
  }
  if (path.basename(value) !== value) throw new Error('اسم البروفايل غير صالح');
  return value;
}

function resolveProfilePath(name) {
  const safe = assertSafeProfileName(name, { allowDefault: false });
  const base = path.resolve(profilesDir());
  const resolved = path.resolve(base, safe);
  if (!resolved.startsWith(`${base}${path.sep}`)) throw new Error('مسار البروفايل خارج المجلد المسموح');
  return resolved;
}

/** Sequence number of a profile, or null if the name carries none. Default is always 1. */
function profileNumber(name) {
  if (name === 'Default') return 1;
  const m = /^(\d+)\s*-\s*/.exec(name || '');
  return m ? parseInt(m[1], 10) : null;
}

/** The label part of a profile name, without its sequence-number prefix. */
function stripLeadingNumber(name) {
  return (name || '').replace(/^\d+\s*-\s*/, '').trim();
}

/** Sort profile names by sequence number; un-numbered legacy names go last. */
function sortProfilesByNumber(names) {
  return [...names].sort((a, b) => {
    const na = profileNumber(a), nb = profileNumber(b);
    if (na !== null && nb !== null) return (na - nb) || a.localeCompare(b, 'ar');
    if (na !== null) return -1;
    if (nb !== null) return 1;
    return a.localeCompare(b, 'ar');
  });
}

/** Ordered list of all profiles: Default (#1) first, then by number. */
async function listProfilesOrdered() {
  let names = [];
  try {
    const entries = await fs.readdir(profilesDir(), { withFileTypes: true });
    names = entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch { /* profiles dir doesn't exist yet */ }
  if (!names.includes('Default')) names.unshift('Default');
  return sortProfilesByNumber(names);
}

/** Next free sequence number (Default counts as #1). */
async function nextProfileNumber() {
  const names = await listProfilesOrdered();
  let max = 1;
  for (const n of names) {
    const num = profileNumber(n);
    if (num !== null && num > max) max = num;
  }
  return max + 1;
}

/**
 * One-shot migration: older installs have un-numbered profile folders. Give
 * each one its mandatory number and carry its queue cursor + cooldown along,
 * so nothing resets when the folder is renamed.
 */
async function migrateUnnumberedProfiles() {
  let entries;
  try {
    entries = await fs.readdir(profilesDir(), { withFileTypes: true });
  } catch { return; }
  const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);
  const unnumbered = dirs
    .filter(n => n !== 'Default' && profileNumber(n) === null)
    .sort((a, b) => a.localeCompare(b, 'ar'));
  for (const oldName of unnumbered) {
    try {
      const num = await nextProfileNumber();
      const newName = `${num}- ${oldName}`;
      await fs.rename(path.join(profilesDir(), oldName), path.join(profilesDir(), newName));
      rateLimitStore.renameProfile(oldName, newName);
      console.log(`Profile migrated: "${oldName}" → "${newName}"`);
    } catch (e) {
      console.error(`Profile numbering migration failed for "${oldName}":`, e?.message);
    }
  }
}

module.exports = {
  profilesDir,
  profileNumber,
  stripLeadingNumber,
  sortProfilesByNumber,
  listProfilesOrdered,
  nextProfileNumber,
  migrateUnnumberedProfiles,
  assertSafeProfileName,
  resolveProfilePath,
};
