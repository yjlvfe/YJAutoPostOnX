/**
 * 🔗 Referral Service — toggle-aware referral link manager
 * =========================================================
 * Single source of truth for the referral link + enabled toggle.
 * State persists in the Default profile config.json (referral_enabled,
 * referral_link). Designed so the link is OPTIONAL and EXTERNAL — when
 * the toggle is disabled, posts publish freely with no link injected.
 *
 * Public API (consumed by validator.js, linkService.js, auditor.js):
 *   init() -> state
 *   isEnabled() / setEnabled(bool)
 *   getLink() / getLinkOrNull() / setLink(url) / hasLink()
 *   getState()
 *   sanitizePost(text) -> { text, modified, warnings }
 *   checkConsistency() -> { consistent, issues }
 *   extractShareCode(url) -> code|null
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const LINK_PLACEHOLDER = '{link}';
// ⚡ C7: factory returns a FRESH regex instance each call so the /g
// lastIndex footgun (test() advances lastIndex; a false test leaves it
// polluted for the next call) can never leak state across invocations.
function makeURLRe() { return /https?:\/\/[^\s\n\r"']+/g; }

function configDir() {
  return path.join(os.homedir(), '.config', 'x-poster-bot-profile');
}
function configFile() {
  return path.join(configDir(), 'config.json');
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(cfg) {
  try {
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2), 'utf8');
  } catch (e) {
    // best-effort
  }
}

// In-memory cache, hydrated from config. Reads re-sync from disk so that
// multiple module instances (and the live app) always agree on state —
// the config file is the single source of truth.
let _state = {
  enabled: true,
  link: '',
};

/** Re-read state from disk into the in-memory cache, then return it. */
function _sync() {
  const cfg = readConfig();
  _state.enabled = (typeof cfg.referral_enabled === 'boolean') ? cfg.referral_enabled : true;
  _state.link = (typeof cfg.referral_link === 'string') ? cfg.referral_link : '';
  return _state;
}

function persist() {
  const cfg = readConfig();
  cfg.referral_enabled = _state.enabled;
  cfg.referral_link = _state.link;
  writeConfig(cfg);
}

function init() {
  _sync();
  // Ensure the fields exist on disk so other instances read consistent state
  persist();
  return getState();
}

function isValidUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return false;
  try {
    const u = new URL(url.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function isEnabled() {
  _sync();
  return _state.enabled === true;
}

function setEnabled(val) {
  _sync();
  _state.enabled = !!val;
  persist();
  return _state.enabled;
}

function hasLink() {
  _sync();
  return _state.enabled === true && typeof _state.link === 'string' && _state.link.trim().length > 0;
}

function getLink() {
  _sync();
  if (_state.enabled !== true) {
    throw new Error('REFERRAL_DISABLED: نظام الإحالة معطل — لا يمكن جلب الرابط.');
  }
  return _state.link;
}

function getLinkOrNull() {
  _sync();
  if (_state.enabled !== true) return null;
  return _state.link && _state.link.trim() ? _state.link : null;
}

function setLink(url) {
  _sync();
  if (_state.enabled !== true) {
    throw new Error('REFERRAL_DISABLED: نظام الإحالة معطل — فعّله أولاً قبل ضبط الرابط.');
  }
  if (typeof url !== 'string' || !url.trim()) {
    throw new Error('LINK_REQUIRED: الرابط مطلوب ولا يمكن أن يكون فارغاً.');
  }
  if (!isValidUrl(url)) {
    throw new Error('LINK_INVALID: الرابط غير صالح. يجب أن يبدأ بـ http(s).');
  }
  _state.link = url.trim();
  persist();
  return _state.link;
}

function getState() {
  _sync();
  return {
    enabled: _state.enabled,
    link: _state.link || '',
    hasLink: hasLink(),
    validated: hasLink() && isValidUrl(_state.link),
  };
}

/**
 * Prepare a post for publishing based on toggle state:
 *   - ENABLED:  replace {link} placeholder with the active link
 *   - DISABLED: strip {link} placeholder AND any hardcoded URLs
 * @returns {{ text: string, modified: boolean, warnings: string[] }}
 */
function sanitizePost(text) {
  const warnings = [];
  if (typeof text !== 'string') return { text: '', modified: false, warnings };
  let out = text;
  let modified = false;

  if (isEnabled()) {
    const link = getLinkOrNull();
    if (out.includes(LINK_PLACEHOLDER)) {
      if (link) {
        out = out.split(LINK_PLACEHOLDER).join(link);
        modified = true;
      } else {
        out = out.split(LINK_PLACEHOLDER).join('').replace(/\n{3,}/g, '\n\n');
        modified = true;
        warnings.push('REFERRAL_ENABLED_NO_LINK: التبديل مفعّل لكن لا يوجد رابط — تم حذف العنصر النائب.');
      }
    }
  } else {
    // Disabled: remove placeholder + strip every URL
    if (out.includes(LINK_PLACEHOLDER)) {
      out = out.split(LINK_PLACEHOLDER).join('');
      modified = true;
    }
    const urlRe = makeURLRe();  // ⚡ C7: fresh instance — no lastIndex leak
    if (urlRe.test(out)) {
      out = out.replace(makeURLRe(), '');
      modified = true;
      warnings.push('REFERRAL_DISABLED_LINK_STRIPPED: نظام الإحالة معطل — تم حذف الروابط من المنشور.');
    }
    if (modified) {
      // ⚡ L2: also collapse orphaned trailing spaces left by URL removal
      // and strip leading/trailing whitespace on each line.
      out = out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
    }
  }

  return { text: out, modified, warnings };
}

/**
 * Sanity-check toggle vs link state.
 * @returns {{ consistent: boolean, issues: string[] }}
 */
function checkConsistency() {
  const issues = [];
  if (isEnabled() && !hasLink()) {
    issues.push('نظام الإحالة مفعّل لكن لا يوجد رابط نشط.');
  }
  // Disabled + link present is fine (dormant). Disabled + no link is fine.
  return { consistent: issues.length === 0, issues };
}

/**
 * Extract the MEXC share/invite code from a referral URL.
 * Supports shareCode= and inviteCode= query params.
 * @returns {string|null}
 */
function extractShareCode(url) {
  if (!isValidUrl(url)) return null;
  try {
    const u = new URL(url.trim());
    return (
      u.searchParams.get('shareCode') ||
      u.searchParams.get('inviteCode') ||
      u.searchParams.get('sharecode') ||
      null
    );
  } catch {
    return null;
  }
}

module.exports = {
  init,
  isEnabled,
  setEnabled,
  getLink,
  getLinkOrNull,
  setLink,
  hasLink,
  getState,
  sanitizePost,
  checkConsistency,
  extractShareCode,
};
