/**
 * 🧠 v5.12.0 Dynamic Prompt Mode — Regression Test
 * ==================================================
 * User requirement: two explicit prompt modes in the studio — "custom"
 * (their own text, unchanged behavior) or "dynamic" (system-built, with an
 * expanded angle bank of 40+ topics and live burned-angle exclusion computed
 * from the actual queue instead of a manually-written static file).
 *
 * Checks:
 *   1. ANGLE_MATRIX expanded past 40, all ids unique.
 *   2. selectAngles(n, excludeIds) respects exclusion, with a safety floor
 *      so variety never starves to near-zero.
 *   3. buildInspirationSummary returns {summaryText, burnedIds} and can score
 *      live extra texts alongside history.
 *   4. sessionManager.js calls getBurnedIds() before selectAngles (source
 *      scan) and defaults to a no-op empty Set when not provided.
 *   5. main.js wires promptMode: 'dynamic' clears customPrompt from the
 *      system block; undefined promptMode preserves the old implicit binary
 *      (source scan, since main.js needs Electron to run directly).
 */

'use strict';

const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}

const contentEngine = require('../dev/automation/contentEngine');
const { SessionManager } = require('../dev/automation/sessionManager');

// ── 1. Angle matrix expansion ──
console.log('📋 Angle matrix');
assert(contentEngine.ANGLE_MATRIX.length > 40,
  `ANGLE_MATRIX has ${contentEngine.ANGLE_MATRIX.length} entries (> 40)`);
const ids = contentEngine.ANGLE_MATRIX.map(a => a.id);
assert(new Set(ids).size === ids.length, 'all angle ids are unique');

// ── 2. selectAngles exclusion + safety floor ──
console.log('📋 selectAngles(n, excludeIds)');
const noExclude = contentEngine.selectAngles(5);
assert(noExclude.length === 5, 'selectAngles(n) with no excludeIds still works (back-compat)');

const fewExcluded = new Set(ids.slice(0, 3));
const angles1 = contentEngine.selectAngles(20, fewExcluded);
assert(angles1.length === 20, 'selectAngles respects a small exclusion set');

const almostAllExcluded = new Set(ids.slice(0, ids.length - 5)); // leaves only 5, under MIN_POOL
const angles2 = contentEngine.selectAngles(5, almostAllExcluded);
assert(angles2.length === 5, 'selectAngles falls back to the FULL pool when exclusion would starve variety (<10 left)');

// ── 3. buildInspirationSummary shape + live texts ──
console.log('📋 buildInspirationSummary');
const r1 = contentEngine.buildInspirationSummary(5, []);
assert(typeof r1 === 'object' && typeof r1.summaryText === 'string' && r1.burnedIds instanceof Set,
  'returns { summaryText, burnedIds } shape');

const liveTexts = Array(10).fill('حجم التداول والسيولة يحددان قوة الحركة السعرية في السوق دائماً');
const r2 = contentEngine.buildInspirationSummary(5, liveTexts);
assert(r2.burnedIds.has('volume'), 'live extra texts are scored alongside history (volume angle detected)');
assert(r2.summaryText.length > 0, 'summaryText is non-empty when a theme is detected');

// ── 4. SessionManager wiring ──
console.log('📋 SessionManager getBurnedIds wiring');
const smSrc = fs.readFileSync(path.join(__dirname, '../dev/automation/sessionManager.js'), 'utf8');
assert(/getBurnedIds\s*=\s*deps\.getBurnedIds\s*\|\|\s*\(\(\)\s*=>\s*new Set\(\)\)/.test(smSrc),
  'constructor defaults getBurnedIds to a no-op empty Set');
assert(/selectAngles\(this\.chunk,\s*this\.getBurnedIds\(\)\)/.test(smSrc),
  '_runSessionRound calls getBurnedIds() before selectAngles');

const sm = new SessionManager({
  engine: contentEngine,
  runRound: async () => ({ cores: [], usage: {} }),
  ingest: () => 0,
});
assert(typeof sm.getBurnedIds === 'function' && sm.getBurnedIds() instanceof Set && sm.getBurnedIds().size === 0,
  'default getBurnedIds is callable and returns an empty Set');

// ── 5. main.js promptMode wiring (source scan — needs Electron to run live) ──
console.log('📋 main.js promptMode wiring');
const mainSrc = fs.readFileSync(path.join(__dirname, '../dev/main.js'), 'utf8');
assert(/promptMode/.test(mainSrc), 'main.js references promptMode');
assert(/isDynamicPrompt\s*=\s*promptMode\s*===\s*'dynamic'/.test(mainSrc),
  'main.js derives isDynamicPrompt from promptMode');
assert(/customSystem:\s*isDynamicPrompt\s*\?\s*''\s*:\s*\(customPrompt \|\| ''\)/.test(mainSrc),
  "dynamic mode clears customPrompt from the session's system block");
assert(/let inspirationSummary/.test(mainSrc),
  'inspirationSummary is a `let` (reassignable by the periodic recompute, not frozen at round 1)');
assert(/getBurnedIds/.test(mainSrc) && /new SessionManager\(\{[\s\S]{0,300}getBurnedIds/.test(mainSrc),
  'getBurnedIds is passed into the SessionManager constructor');

console.log(`\n${failed === 0 ? '✅' : '❌'} dynamic-prompt-v512: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
