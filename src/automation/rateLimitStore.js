/**
 * rateLimitStore.js — persistent per-profile rate-limit cooldown tracking.
 *
 * When X.com rate-limits a profile, we record the profile name + when the
 * cooldown expires. This survives app restarts so the user is warned
 * ("this profile is limited, N min left") instead of silently retrying a
 * blocked account.
 *
 * Storage: one JSON file shared across profiles:
 *   ~/.config/x-poster-bot-profile/rate-limits.json
 *   { "<profileName>": { until: <epochMs>, since: <epochMs>, source: "x|default", note: "" }, ... }
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const STORE_DIR = path.join(os.homedir(), '.config', 'x-poster-bot-profile');
const STORE_PATH = path.join(STORE_DIR, 'rate-limits.json');

// Default cooldown when X gives us no explicit duration. X "daily" post
// limits typically reset on a rolling window; 60 min is a safe, useful default.
const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;

function _read() {
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function _write(obj) {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(obj, null, 2));
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Record that a profile hit a rate limit.
 * @param {string} profileName
 * @param {number} [durationMs] - cooldown length; defaults to DEFAULT_COOLDOWN_MS
 * @param {object} [meta] - { source, note }
 * @returns {{ until: number, since: number }}
 */
function setCooldown(profileName, durationMs, meta = {}) {
  const name = profileName || 'Default';
  const now = Date.now();
  const ms = (typeof durationMs === 'number' && durationMs > 0) ? durationMs : DEFAULT_COOLDOWN_MS;
  const store = _read();
  store[name] = {
    until: now + ms,
    since: now,
    source: meta.source || 'default',
    note: meta.note || '',
  };
  _write(store);
  return store[name];
}

/**
 * Get the active cooldown for a profile, or null if none / expired.
 * Auto-prunes expired entries.
 * @param {string} profileName
 * @returns {{ until: number, since: number, remainingMs: number, source: string, note: string } | null}
 */
function getCooldown(profileName) {
  const name = profileName || 'Default';
  const store = _read();
  const entry = store[name];
  if (!entry) return null;
  const remainingMs = entry.until - Date.now();
  if (remainingMs <= 0) {
    // expired — prune it
    delete store[name];
    _write(store);
    return null;
  }
  return { ...entry, remainingMs };
}

/** True if the profile is currently cooling down. */
function isCoolingDown(profileName) {
  return getCooldown(profileName) !== null;
}

/** Manually clear a profile's cooldown (e.g. user override). */
function clearCooldown(profileName) {
  const name = profileName || 'Default';
  const store = _read();
  if (store[name]) {
    delete store[name];
    _write(store);
    return true;
  }
  return false;
}

/**
 * Return all active (non-expired) cooldowns, pruning expired ones.
 * @returns {Object<string, {until, since, remainingMs, source, note}>}
 */
function getAllCooldowns() {
  const store = _read();
  const now = Date.now();
  const out = {};
  let changed = false;
  for (const [name, entry] of Object.entries(store)) {
    const remainingMs = entry.until - now;
    if (remainingMs <= 0) { delete store[name]; changed = true; continue; }
    out[name] = { ...entry, remainingMs };
  }
  if (changed) _write(store);
  return out;
}

/**
 * Parse a cooldown duration (ms) out of X.com rate-limit page text.
 * Recognizes English + Arabic phrasings like:
 *   "try again in 25 minutes", "wait 2 hours", "بعد 30 دقيقة", "خلال ساعتين"
 * Returns null when no explicit duration is found (caller uses default).
 * @param {string} text
 * @returns {number|null}
 */
function parseCooldownFromText(text) {
  if (!text) return null;
  const t = text.toLowerCase();

  // English: "in 25 minute(s)", "25 mins", "2 hour(s)", "wait 30 seconds"
  const enMin = t.match(/(\d+)\s*(?:minute|minutes|min|mins)\b/);
  const enHr  = t.match(/(\d+)\s*(?:hour|hours|hr|hrs)\b/);
  const enSec = t.match(/(\d+)\s*(?:second|seconds|sec|secs)\b/);

  // Arabic: "30 دقيقة", "2 ساعة", "45 ثانية"
  const arMin = t.match(/(\d+)\s*دقيق/);
  const arHr  = t.match(/(\d+)\s*ساع/);
  const arSec = t.match(/(\d+)\s*ثاني/);

  let ms = 0;
  if (enHr)  ms += parseInt(enHr[1], 10)  * 60 * 60 * 1000;
  if (enMin) ms += parseInt(enMin[1], 10) * 60 * 1000;
  if (enSec) ms += parseInt(enSec[1], 10) * 1000;
  if (arHr)  ms += parseInt(arHr[1], 10)  * 60 * 60 * 1000;
  if (arMin) ms += parseInt(arMin[1], 10) * 60 * 1000;
  if (arSec) ms += parseInt(arSec[1], 10) * 1000;

  // Arabic dual forms without a number: "ساعتين" (2h), "دقيقتين" (2m)
  if (!ms && /ساعتين/.test(t)) ms = 2 * 60 * 60 * 1000;
  if (!ms && /دقيقتين/.test(t)) ms = 2 * 60 * 1000;

  return ms > 0 ? ms : null;
}

/** Human-readable remaining time, Arabic. */
function formatRemaining(ms) {
  if (ms <= 0) return 'انتهى';
  const totalSec = Math.ceil(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h} ساعة و ${m} دقيقة`;
  if (m > 0) return `${m} دقيقة و ${s} ثانية`;
  return `${s} ثانية`;
}

module.exports = {
  STORE_PATH,
  DEFAULT_COOLDOWN_MS,
  setCooldown,
  getCooldown,
  isCoolingDown,
  clearCooldown,
  getAllCooldowns,
  parseCooldownFromText,
  formatRemaining,
};
