/**
 * 🔍 Auditor — only RUNTIME-REACHABLE URLs are hardcoded-link findings
 * ============================================================================
 * The hardcoded-link check exists to guarantee the referral link stays external
 * (settings), never baked into source. Its filter always documented that it
 * skips "code patterns, comments, and known safe patterns" — but comment
 * stripping was never implemented, so merely DOCUMENTING a URL in a comment
 * (the daily-post-limit upsell page that isLimitUrl() detects) raised a
 * permanent 🔴 CRITICAL that couldn't be cleared without deleting the
 * explanation. A permanently-red audit is an ignored audit.
 *
 * The risk of stripping comments is the opposite error — going quiet on a REAL
 * hardcoded link — so this test pins down both directions.
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

const { extractUrls } = require('../dev/security/validator');

// stripComments is module-internal on purpose (not part of the auditor's API);
// lift it out of the source so this test exercises the real implementation
// rather than a copy that could drift.
const auditorSrc = fs.readFileSync(path.join(__dirname, '../dev/security/auditor.js'), 'utf8');
const stripFnSrc = auditorSrc.match(/function stripComments\([\s\S]*?\n}/);
if (!stripFnSrc) {
  console.error('❌ stripComments() not found in auditor.js — did the audit lose its comment filter?');
  process.exit(1);
}
// eslint-disable-next-line no-eval
const stripComments = eval('(' + stripFnSrc[0] + ')');

const scan = (src) => extractUrls(stripComments(src));

console.log('📋 Comments must NOT be reported as hardcoded links');
assert(
  scan('// upsell page (https://x.com/i/premium_sign_up?referring_page=daily_post_limit)\nconst a = 1;').length === 0,
  'a URL in a line comment is not a finding (the real xPoster.js case that was permanently red)'
);
assert(
  scan('/* docs: https://mexc.com/register?ref=SECRET123 */\nconst a = 1;').length === 0,
  'a URL in a block comment is not a finding'
);

console.log('📋 Real hardcoded links must STILL be caught');
assert(
  scan("const link = 'https://mexc.com/register?ref=SECRET123';").includes('https://mexc.com/register?ref=SECRET123'),
  'a hardcoded link in a string is still reported — the check keeps its teeth'
);
assert(
  scan("const link = 'https://mexc.com/register?ref=SECRET123'; // trailing note")
    .includes('https://mexc.com/register?ref=SECRET123'),
  'a hardcoded link is caught even when the same line ends with a comment'
);
assert(
  scan("const u = 'https://x.com/home';").includes('https://x.com/home'),
  "the '//' inside a URL is not mistaken for a comment start"
);

console.log('📋 The live source is clean under the fixed rule');
const xposterSrc = fs.readFileSync(path.join(__dirname, '../dev/automation/xPoster.js'), 'utf8');
assert(
  xposterSrc.includes('premium_sign_up'),
  'xPoster.js still documents/detects the daily-post-limit URL (the fix did not delete the explanation)'
);

console.log(`\n${failed === 0 ? '✅' : '❌'} auditor-comments: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
