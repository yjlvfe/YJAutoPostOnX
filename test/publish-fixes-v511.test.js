/**
 * 🩹 v5.11.0 Publishing Fixes — Regression Test
 * ==============================================
 * Guards the three user-reported fixes:
 *
 * FIX #1 — "huge deleted count while everything visibly posts fine":
 *   The missed-toast double-check used `tweetButtonInline` visibility, which
 *   is ALWAYS true on x.com/home (the inline composer button never leaves the
 *   DOM). A published post with a missed toast was retyped, rejected by X as
 *   a duplicate, failed all retries, and got dead-lettered. The check must
 *   now read the COMPOSER TEXT (X clears it the instant a tweet is accepted).
 *
 * FIX #2 — "generation strictness insane, want a middle ground":
 *   SemanticIndex default thresholds relaxed 0.35/0.28 → 0.5/0.42 (clear
 *   restatements still rejected; same-theme-different-specifics passes).
 *
 * FIX #3 — "counter resets when moving to the next profile":
 *   `maxPosts` is ONE GLOBAL target across all profiles: startMulti passes
 *   the REMAINING share + a cumulative statsBase to each next profile, and
 *   stops the whole batch once the target is reached.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// Isolated sandbox — never touch the user's real ~/.config state
const SANDBOX = path.join(os.tmpdir(), 'xposter-v511-test-' + Date.now());
os.homedir = () => SANDBOX;
fs.mkdirSync(path.join(SANDBOX, '.config', 'x-poster-bot-profile'), { recursive: true });

let passed = 0;
let failed = 0;
function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}

const XPOSTER_PATH = require.resolve('../dev/automation/xPoster');
const src = fs.readFileSync(XPOSTER_PATH, 'utf8');
// Strip comments so explanatory docs don't false-positive the source checks
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

// ── FIX #1: composer-text check replaced the always-true button check ──
console.log('📋 Fix #1: missed-toast double-check uses composer text');
assert(!code.includes('tweetButtonInline'),
  'old always-true tweetButtonInline heuristic is gone (code, comments excluded)');
assert(/composerText/.test(code), 'composer-text double-check exists');
assert(/composerText\s*!==\s*null\s*&&\s*composerText\.trim\(\)\.length\s*===\s*0/.test(code),
  'empty composer ⇒ post went out (unconfirmed), not a retype-retry');

// ── FIX #2: dedup thresholds looser than the original "insane strictness" ──
// Exact current values (revised again in v5.12.1 for volume-priority) are
// owned by semantic-dedup.test.js; this just guards against a regression
// back to the original 0.35/0.28 that prompted this fix in the first place.
console.log('📋 Fix #2: semantic dedup looser than original strictness');
const { SemanticIndex } = require('../dev/automation/semanticIndex');
const idx = new SemanticIndex();
assert(idx.simThreshold > 0.35, `simThreshold (${idx.simThreshold}) is looser than the original 0.35`);
assert(idx.containThreshold > 0.28, `containThreshold (${idx.containThreshold}) is looser than the original 0.28`);
const custom = new SemanticIndex({ simThreshold: 0.3, containThreshold: 0.2 });
assert(custom.simThreshold === 0.3 && custom.containThreshold === 0.2,
  'explicit threshold overrides still respected');

// ── FIX #3: global maxPosts across profiles + cumulative counters ──
console.log('📋 Fix #3: global target + continuing counters across hand-offs');
assert(/globalMax\s*-\s*doneSoFar/.test(code),
  'startMulti passes the REMAINING share of the global target to the next profile');
assert(/statsBase:\s*\{\s*success:\s*totalSuccess,\s*failed:\s*totalFailed\s*\}/.test(code),
  'startMulti passes cumulative statsBase so UI counters continue (41, 42, …)');
assert(/doneSoFar\s*>=\s*globalMax/.test(code),
  'startMulti stops the whole batch once the global target is reached');
assert(/statsBase\.success\s*\+\s*successCount/.test(code),
  'start() emits cumulative success counts (base + own)');
assert(!/stats:\s*\{\s*success:\s*successCount,\s*failed:\s*failedCount\s*\}/.test(code),
  'no per-profile-only stats emission remains');
assert(/unconfirmedCount\+\+/.test(code) && /unconfirmed:\s*unconfirmedCount/.test(code),
  'unconfirmed posts are counted and returned (they consume the global target)');

// start/startMulti still exported and loadable without electron
const xPoster = require(XPOSTER_PATH);
assert(typeof xPoster.start === 'function' && typeof xPoster.startMulti === 'function',
  'xPoster still exports start + startMulti');

console.log(`\n${failed === 0 ? '✅' : '❌'} publish-fixes-v511: ${passed} passed, ${failed} failed`);
try { fs.rmSync(SANDBOX, { recursive: true }); } catch (e) { /* best-effort */ }
if (failed > 0) process.exit(1);
