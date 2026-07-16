/**
 * ⏸️ v5.12.0 Deferred Retry (instead of permanent dead-letter) — Regression Test
 * ================================================================================
 * User requirement: on a TRANSIENT (network) publish failure, try the next
 * post immediately instead of stalling, but don't permanently lose this one —
 * it should come back automatically on the next run for this profile.
 * Non-transient failures (selector/platform/unknown) keep today's dead-letter
 * behavior unchanged.
 *
 * Reworked for the consumable queue: a deferred post is simply NOT consumed,
 * so it stays in the shared queue and the next run finds it at the head. The
 * old position cursor (and the "re-inject the backlog at the start of a run"
 * machinery it required) is gone. deferred-posts.json survives purely as an
 * attempt COUNTER so a post that can never publish is eventually escalated to
 * a dead-letter instead of blocking the head of the queue forever.
 *
 * Guards the real bugs (not just the happy path):
 *   - A deferred post must NOT be consumed — consuming it on a transient
 *     failure would delete a post that never went out.
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

  // Bug guard #1: a transient failure must NOT consume the post — that's the
  // whole point of deferring. The only consumePost allowed in this branch is
  // the one gated behind the attempts cap (escalation to a dead-letter).
  const networkBranchMatch = code.match(/if\s*\(errorType === 'network'\)\s*\{([\s\S]*?)\n\s*\}\n\n\s*onStatus/);
  assert(!!networkBranchMatch, 'network-failure branch exists and is isolatable in source');
  const networkBranch = networkBranchMatch ? networkBranchMatch[1] : '';
  assert(!/advancePosition/.test(networkBranch), 'network branch does not use the removed position cursor');
  assert(/addDeferred/.test(networkBranch), 'network branch calls addDeferred instead of addDeadLetter directly');
  const capMatch = networkBranch.match(/if\s*\(attemptsSoFar > DEFER_ATTEMPTS_LIMIT\)\s*\{([\s\S]*?)\}\s*else\s*\{/);
  assert(!!capMatch, 'attempts-cap escalation block is isolatable in source');
  const beforeCap = networkBranch.slice(0, networkBranch.indexOf('if (attemptsSoFar'));
  assert(!/consumePost/.test(beforeCap),
    'a deferred post is NOT consumed — it stays in the queue so the next run retries it');
  assert(/consumePost/.test(capMatch ? capMatch[1] : ''),
    'only the over-the-cap escalation consumes the post (into dead-letters)');

  // Bug guard #2: selector/locator message check must run BEFORE the
  // TimeoutError-name catch-all in the classifier.
  const classifierMatch = code.match(/let errorType = 'unknown';([\s\S]*?)\}\s*\n\s*failedCount\+\+/);
  assert(!!classifierMatch, 'error classifier block is isolatable in source');
  const classifier = classifierMatch ? classifierMatch[1] : '';
  const selectorIdx = classifier.indexOf("errorType = 'selector'");
  const networkIdx = classifier.indexOf("errorType = 'network'");
  assert(selectorIdx !== -1 && networkIdx !== -1 && selectorIdx < networkIdx,
    "classifier checks 'selector' message content BEFORE the TimeoutError-name catch-all for 'network'");

  // The backlog must NOT be re-injected into the run any more: the deferred
  // post is still IN the queue, so prepending a copy would publish it twice.
  assert(!/__deferredRetry/.test(code), 'no deferred-retry re-injection (the post is already in the queue)');
  assert(!/cursorOwner|advancePosition|getProfileQueue/.test(code),
    'the position-cursor model is fully removed from the publish engine');
  assert(/removeDeferred/.test(code), 'success/unconfirmed/escalation paths call removeDeferred to clean up');

  // Circuit breaker must still apply inside the network branch (not bypassed
  // by the early `continue`).
  const networkContinueMatch = code.match(/if\s*\(errorType === 'network'\)\s*\{([\s\S]*?)continue;\s*\n\s*\}/);
  const networkFullBranch = networkContinueMatch ? networkContinueMatch[1] : '';
  assert(/CONSECUTIVE_FAILURE_LIMIT/.test(networkFullBranch),
    'circuit breaker check is present INSIDE the network branch (not skipped by its early continue)');

  // Non-network failures: still unconditionally dead-lettered, and now also
  // consumed so a permanently-broken post can't block the head of the queue.
  const tailDeadLetter = code.slice(code.indexOf('continue;', code.indexOf("errorType === 'network'")));
  assert(/await queueManager\.addDeadLetter\(itemText, errorType, errorMsg, profileName\);/.test(tailDeadLetter),
    'non-network failures still call addDeadLetter unconditionally (unchanged behavior)');
  assert(/await queueManager\.consumePost\(itemText\);/.test(tailDeadLetter),
    'non-network failures consume the post (dead-letters keep the text — nothing is lost)');

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
