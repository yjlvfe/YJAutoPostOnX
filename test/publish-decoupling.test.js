/**
 * 🔓 Publish/Referral Decoupling — Regression Test (v5.10.0)
 * ===========================================================
 * User requirement: publishing must be 100% independent of the referral
 * system. The referral link is a STUDIO concern (baked into post text at
 * generation time). The publish engine ONLY takes posts from the queue and
 * publishes them AS-IS.
 *
 * Guards against regressions of the v5.9.0 bug where the publish engine:
 *   - refused to start when referral was enabled with no saved link
 *     ("⛔ نظام الإحالة مفعّل لكن لا يوجد رابط إحالة محفوظ" → 0 posts consumed)
 *   - rewrote queue text via referralService.sanitizePost (stripping URLs)
 *   - dead-lettered queue posts via validator.validatePost (LINK_MISMATCH…)
 *
 * Checks:
 *   1. xPoster source has NO referralService / validator require
 *   2. xPoster source has NO sanitizePost / validatePost / config_error logic
 *   3. requiring xPoster does NOT load referralService or validator (runtime)
 *   4. worst-case referral state (enabled + no link) — publish engine still
 *      exposes start/startMulti with no gate anywhere in its source
 *   5. studio side untouched: referralService + validator still work standalone
 */

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

// Isolated sandbox — never touch the user's real ~/.config state
const SANDBOX = path.join(os.tmpdir(), 'xposter-decoupling-test-' + Date.now());
os.homedir = () => SANDBOX;
fs.mkdirSync(path.join(SANDBOX, '.config', 'x-poster-bot-profile'), { recursive: true });

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}

const XPOSTER_PATH = require.resolve('../dev/automation/xPoster');
const REFERRAL_PATH = require.resolve('../dev/automation/referralService');
const VALIDATOR_PATH = require.resolve('../dev/security/validator');

// ── 1+2. Static: publish engine source is referral-free ──
console.log('📋 Test 1: xPoster source contains no referral coupling');
const src = fs.readFileSync(XPOSTER_PATH, 'utf8');
// Strip comments so documentation mentioning the old design doesn't false-positive
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
assert(!/require\(['"][^'"]*referralService['"]\)/.test(code), 'no require(referralService)');
assert(!/require\(['"][^'"]*security\/validator['"]\)/.test(code), 'no require(security/validator)');
assert(!code.includes('sanitizePost'), 'no sanitizePost call');
assert(!code.includes('validatePost'), 'no validatePost call');
assert(!code.includes('config_error'), 'no config_error gate');
assert(!code.includes('نظام الإحالة'), 'no referral-system message in publish engine');

// ── 3. Runtime: requiring xPoster pulls in neither module ──
console.log('📋 Test 2: requiring xPoster does not load referral modules');
delete require.cache[XPOSTER_PATH];
delete require.cache[REFERRAL_PATH];
delete require.cache[VALIDATOR_PATH];
const xPoster = require(XPOSTER_PATH);
assert(!require.cache[REFERRAL_PATH], 'referralService NOT in require.cache after loading xPoster');
assert(!require.cache[VALIDATOR_PATH], 'validator NOT in require.cache after loading xPoster');
assert(typeof xPoster.start === 'function' && typeof xPoster.startMulti === 'function',
  'xPoster still exports start + startMulti');

// ── 4. Worst-case referral state cannot gate publishing ──
console.log('📋 Test 3: referral enabled + NO link — state that used to block publishing');
const referralService = require(REFERRAL_PATH);
referralService.setEnabled(true); // enabled, and no link saved in sandbox
assert(referralService.isEnabled() === true, 'referral enabled in sandbox');
assert(referralService.getLinkOrNull() === null, 'no link saved (the exact state that blocked v5.9.0)');
// The old gate returned status 'config_error' before consuming anything.
// With the decoupled engine there is no code path that can produce it:
assert(!src.includes("'config_error'") && !src.includes('"config_error"'),
  'publish engine has no config_error status at all');

// ── 5. Studio side untouched ──
console.log('📋 Test 4: studio-side referral tools still work standalone');
const validator = require(VALIDATOR_PATH);
const link = 'https://www.mexc.com/acquisition/custom-sign-up?shareCode=mexc-TEST01';
referralService.setLink(link);
assert(referralService.getLinkOrNull() === link, 'referralService.setLink/getLink works');
const sanitized = referralService.sanitizePost('انضم عبر {link} الآن');
assert(sanitized.text.includes(link), 'sanitizePost still injects link (studio tool)');
const v = validator.validatePost(`جرّب المنصة ${link}`, link);
assert(v.valid === true, 'validator.validatePost still validates (studio tool)');

console.log(`\n${failed === 0 ? '✅' : '❌'} publish-decoupling: ${passed} passed, ${failed} failed`);
try { fs.rmSync(SANDBOX, { recursive: true }); } catch (e) {}
if (failed > 0) process.exit(1);
