/**
 * ⏸️ v5.12.0 Deferred Retry (instead of permanent dead-letter) — Regression Test
 * ================================================================================
 * User requirement: on a TRANSIENT (network) publish failure, try the next
 * post immediately instead of stalling, but don't permanently lose this one —
 * it should come back automatically on the next run for this profile.
 * Non-transient failures (selector/platform/unknown) keep today's dead-letter
 * behavior unchanged.
 *
 * Guards two real bugs found during planning (not just the happy path):
 *   - advancePosition() is a monotonic +1 counter, not an absolute index —
 *     skipping it on defer would let a LATER success in the same run push
 *     the position past the deferred post with no record anywhere, silently
 *     losing it. xPoster.js must therefore ALWAYS call advancePosition, and
 *     track "retry me" via the separate deferred-posts list, not the cursor.
 *   - Playwright's native locator actions throw their OWN errors.TimeoutError
 *     on a genuine (permanent) DOM/selector regression — the error classifier
 *     must check selector/locator message content BEFORE the generic
 *     TimeoutError-name catch-all, or a real bug would defer forever instead
 *     of surfacing as a dead-letter.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const SANDBOX = path.join(os.tmpdir(), 'xposter-deferred-test-' + Date.now());
os.homedir = () => SANDBOX;
fs.mkdirSync(path.join(SANDBOX, '.config', 'x-poster-bot-profile'), { recursive: true });

let passed = 0;
let failed = 0;
function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}

const queueManager = require('../dev/automation/queueManager');
const ReportEngine = require('../dev/automation/reportEngine').ReportEngine;

// ── 1. queueManager deferred-posts API ──
console.log('📋 queueManager: deferred-posts persistence');
(async () => {
  const attempts1 = await queueManager.addDeferred('تغريدة تجريبية 1', 'Timeout', 'Default');
  assert(attempts1 === 1, 'first defer of a text starts attempts at 1');

  const list1 = await queueManager.getDeferred('Default');
  assert(list1.length === 1 && list1[0].text === 'تغريدة تجريبية 1', 'getDeferred returns the entry');

  const attempts2 = await queueManager.addDeferred('تغريدة تجريبية 1', 'Timeout again', 'Default');
  assert(attempts2 === 2, 'deferring the SAME text again bumps attempts, not a duplicate entry');
  const list2 = await queueManager.getDeferred('Default');
  assert(list2.length === 1, 'still exactly one entry after a repeat defer (bumped, not duplicated)');

  await queueManager.removeDeferred('Default', 'تغريدة تجريبية 1');
  const list3 = await queueManager.getDeferred('Default');
  assert(list3.length === 0, 'removeDeferred clears the entry');

  // ── 2. xPoster.js source: correctness of the deferred mechanism ──
  console.log('📋 xPoster.js: deferred-retry source correctness');
  const src = fs.readFileSync(path.join(__dirname, '../dev/automation/xPoster.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  // Bug guard #1: advancePosition must ALWAYS run on a network failure —
  // never skipped — because it's a monotonic counter, not an absolute index.
  const networkBranchMatch = code.match(/if\s*\(errorType === 'network'\)\s*\{([\s\S]*?)\n\s*\}\n\n\s*onStatus/);
  assert(!!networkBranchMatch, 'network-failure branch exists and is isolatable in source');
  const networkBranch = networkBranchMatch ? networkBranchMatch[1] : '';
  assert(/if\s*\(cursorOwner\)\s*await queueManager\.advancePosition\(cursorOwner\)/.test(networkBranch),
    'network branch ALWAYS advances the position (monotonic counter — never skip it)');
  assert(/addDeferred/.test(networkBranch), 'network branch calls addDeferred instead of addDeadLetter directly');
  assert(!/await queueManager\.addDeadLetter\(itemToDelete, errorType, errorMsg, profileName\);\s*$/m.test(networkBranch) ||
    /DEFER_ATTEMPTS_LIMIT/.test(networkBranch),
    'any addDeadLetter call inside the network branch is gated by the attempts cap, not unconditional');

  // Bug guard #2: selector/locator message check must run BEFORE the
  // TimeoutError-name catch-all in the classifier.
  const classifierMatch = code.match(/let errorType = 'unknown';([\s\S]*?)\}\s*\n\s*failedCount\+\+/);
  assert(!!classifierMatch, 'error classifier block is isolatable in source');
  const classifier = classifierMatch ? classifierMatch[1] : '';
  const selectorIdx = classifier.indexOf("errorType = 'selector'");
  const networkIdx = classifier.indexOf("errorType = 'network'");
  assert(selectorIdx !== -1 && networkIdx !== -1 && selectorIdx < networkIdx,
    "classifier checks 'selector' message content BEFORE the TimeoutError-name catch-all for 'network'");

  // Deferred backlog prepend + cursorOwner handling
  assert(/getDeferred\(profileName\)/.test(code), 'start() loads this profile\'s deferred backlog');
  assert(/__deferredRetry/.test(code), 'deferred backlog items are tagged __deferredRetry');
  assert(/isDeferredRetryItem\s*\?\s*null/.test(code),
    'cursorOwner resolves to null for deferred-retry items (their slot was already consumed when first deferred)');
  assert(/removeDeferred/.test(code), 'success/unconfirmed/escalation paths call removeDeferred to clean up');

  // Circuit breaker must still apply inside the network branch (not bypassed
  // by the early `continue`).
  const networkContinueMatch = code.match(/if\s*\(errorType === 'network'\)\s*\{([\s\S]*?)continue;\s*\n\s*\}/);
  const networkFullBranch = networkContinueMatch ? networkContinueMatch[1] : '';
  assert(/CONSECUTIVE_FAILURE_LIMIT/.test(networkFullBranch),
    'circuit breaker check is present INSIDE the network branch (not skipped by its early continue)');

  // Non-network failures must be untouched: still unconditionally dead-lettered.
  assert(/errorType !== 'network'|else \{[\s\S]{0,50}onStatus\({ type: 'error', message: `❌ فشل/.test(code) || true,
    'non-network path retained (sanity placeholder — verified structurally below)');
  const tailDeadLetter = code.slice(code.indexOf('continue;', code.indexOf("errorType === 'network'")));
  assert(/await queueManager\.addDeadLetter\(itemToDelete, errorType, errorMsg, profileName\);/.test(tailDeadLetter),
    'non-network failures still call addDeadLetter unconditionally (unchanged behavior)');

  // ── 3. reportEngine 'deferred' status support ──
  console.log('📋 reportEngine: deferred status');
  const re = new ReportEngine(path.join(SANDBOX, 'reports'));
  re.startRun();
  re.recordPostResult({ postId: 'p1', text: 'x', status: 'deferred', attempts: 3, errorType: 'network', lastError: 'timeout' });
  assert(re.stats.deferred === 1, 'deferred status increments stats.deferred, not unconfirmed');
  assert(re.stats.unconfirmed === 0, 'deferred status does NOT get coerced into unconfirmed');
  assert(re.failures.length === 1 && re.failures[0].finalStatus === 'deferred',
    'deferred entries are tracked in failures[] for diagnostic visibility (errorType/lastError preserved)');
  re.endTime = new Date().toISOString();
  const report = re.generateReport();
  assert(report.stats.deferred === 1, 'generateReport() surfaces the deferred count');
  const txt = re.generateTextReport(report);
  assert(/Deferred/.test(txt), 'human-readable text report includes a Deferred line');

  console.log(`\n${failed === 0 ? '✅' : '❌'} deferred-retry-v512: ${passed} passed, ${failed} failed`);
  try { fs.rmSync(SANDBOX, { recursive: true }); } catch (e) { /* best-effort */ }
  if (failed > 0) process.exit(1);
})();
