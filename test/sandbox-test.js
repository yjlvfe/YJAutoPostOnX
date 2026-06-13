/**
 * xPoster Sandbox Simulation — Phase 4
 * Tests ALL core business logic in an isolated sandbox.
 * No browser/display needed — focuses on data layer integrity.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const SANDBOX_DIR = path.join(os.tmpdir(), 'xposter-sandbox-test-' + Date.now());
const ORIG_PROFILE_DIR = path.join(os.homedir(), '.config', 'x-poster-bot-profile');

// Override profile dir by temporarily mocking homedir
const origHomedir = os.homedir;
os.homedir = () => SANDBOX_DIR;

// Clean import
delete require.cache[require.resolve('../src/automation/queueManager')];
delete require.cache[require.resolve('../src/automation/reportEngine')];
delete require.cache[require.resolve('../src/automation/spintaxEngine')];

const queueManager = require('../src/automation/queueManager');
const spintaxEngine = require('../src/automation/spintaxEngine');
const { ReportEngine } = require('../src/automation/reportEngine');

// Stats
let passed = 0;
let failed = 0;
const errors = [];

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    const err = `  ❌ ${msg}`;
    console.error(err);
    errors.push(err);
  }
}

async function runAll() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  XPOSTER SANDBOX SIMULATION TEST SUITE   ║');
  console.log('╚══════════════════════════════════════════╝\n');

  // 1. Clean sandbox
  try { fs.rmSync(SANDBOX_DIR, { recursive: true }); } catch(e) {}
  fs.mkdirSync(SANDBOX_DIR, { recursive: true });
  // Also create the config subdir
  const configDir = path.join(SANDBOX_DIR, '.config', 'x-poster-bot-profile');
  fs.mkdirSync(configDir, { recursive: true });

  // ===== TEST 1: QUEUE MANAGER =====
  console.log('📦 Test Suite 1: Queue Manager');
  
  // 1a. Empty queue
  console.log('\n  1a. Initial empty queue:');
  let queue = await queueManager.getQueue();
  assert(Array.isArray(queue), 'Queue returns an array');
  assert(queue.length === 0, 'Fresh queue is empty');

  // 1b. Add posts
  console.log('\n  1b. Adding posts:');
  const testPosts = [
    '🚀 أول منشور تجريبي مع رابط https://mexc.com #MEXC',
    '💎 ثاني منشور مع تحليل السوق https://mexc.com #MEXC',
    '📊 ثالث منشور عن التداول https://mexc.com #MEXC',
    { text: '📈 منشور مع ميديا https://mexc.com #MEXC', media_path: '/tmp/test-image.png' }
  ];
  const len1 = await queueManager.addPosts(testPosts);
  assert(len1 === 4, `Queue has 4 items after adding (got ${len1})`);

  // 1c. Check duplicates are rejected
  console.log('\n  1c. Duplicate rejection:');
  const len2 = await queueManager.addPosts(['🚀 أول منشور تجريبي مع رابط https://mexc.com #MEXC']);
  assert(len2 === 4, 'Duplicate not added (still 4 items)');

  // 1d. Get queue and verify content
  console.log('\n  1d. Queue content:');
  queue = await queueManager.getQueue();
  assert(queue.length === 4, `Queue has 4 items (got ${queue.length})`);
  assert(typeof queue[0] === 'string', 'First item is a string');
  assert(typeof queue[3] === 'object', 'Fourth item is an object (has media)');
  assert(queue[3].media_path === '/tmp/test-image.png', 'Media path preserved');

  // 1e. Delete single post
  console.log('\n  1e. Delete single post:');
  await queueManager.deletePost('🚀 أول منشور تجريبي مع رابط https://mexc.com #MEXC');
  queue = await queueManager.getQueue();
  assert(queue.length === 3, 'Queue has 3 items after deletion');
  assert(!queue.includes('🚀 أول منشور تجريبي مع رابط https://mexc.com #MEXC'), 'Deleted item not in queue');

  // 1f. Bulk delete
  console.log('\n  1f. Bulk delete:');
  queue = await queueManager.getQueue();
  await queueManager.bulkDelete([0, 1]);
  queue = await queueManager.getQueue();
  assert(queue.length === 1, 'Queue has 1 item after bulk delete');

  // 1g. Pending verification
  console.log('\n  1g. Pending verification:');
  await queueManager.addToPending('منشور معلق للتحقق');
  let pending = await queueManager.getPendingVerification();
  assert(pending.length === 1, 'Pending queue has 1 item');
  assert(pending[0].text === 'منشور معلق للتحقق', 'Pending text preserved');

  // 1h. Dead letters
  console.log('\n  1h. Dead letters:');
  await queueManager.addDeadLetter('منشور فاشل', 'network', 'ECONNREFUSED');
  await queueManager.addDeadLetter('منشور فاشل 2', 'selector', 'TimeoutError');
  let dead = await queueManager.getDeadLetters();
  assert(dead.length === 2, 'Dead letters queue has 2 items');
  assert(dead[0].errorType === 'network', 'Error type preserved');
  assert(dead[1].errorMsg === 'TimeoutError', 'Error message preserved');

  // 1i. Clear queue
  console.log('\n  1i. Clear queue:');
  await queueManager.clearQueue();
  queue = await queueManager.getQueue();
  assert(queue.length === 0, 'Queue is empty after clear');

  console.log('\n📦 Test Suite 1 complete');

  // ===== TEST 2: SPINTAX ENGINE =====
  console.log('\n📦 Test Suite 2: Spintax Engine');

  // 2a. Basic spintax parsing
  console.log('\n  2a. Basic spintax parsing:');
  const result1 = spintaxEngine.parseSpintax('{مرحباً|أهلاً} {بالعالم|بالجميع}');
  assert(typeof result1 === 'string', 'Parsed spintax returns string');
  assert(result1.length > 0, 'Parsed result is non-empty');
  assert(!result1.includes('{') || result1.indexOf('{') > result1.indexOf('}'), 'All brackets resolved');

  // 2b. Generate variations
  console.log('\n  2b. Generate variations:');
  const variations = spintaxEngine.generateVariations('{خيار1|خيار2|خيار3} {هذا|ذاك}', 10);
  assert(variations.length <= 10, `Generated ${variations.length} variations (max 6 unique)`);
  assert(variations.length > 0, 'Generated at least 1 variation');

  // 2c. Estimate variations
  console.log('\n  2c. Estimate variations:');
  const estimate = spintaxEngine.estimateVariations('{أ|ب|ج} {1|2}');
  assert(estimate === 6, `Estimated 6 variations (got ${estimate})`);

  // 2d. Template library
  console.log('\n  2d. Template library:');
  const lib = spintaxEngine.getTemplateLibrary();
  assert(Array.isArray(lib), 'Library is an array');
  assert(lib.length > 0, 'Library has categories');
  assert(lib[0].category, 'Category has name');
  assert(lib[0].templates.length > 0, 'Category has templates');

  // 2e. MEXC post generation
  console.log('\n  2e. MEXC post generation:');
  const testLink = 'https://www.mexc.com/acquisition/custom-sign-up?shareCode=mexc-12UHY5';
  for (let i = 0; i < 5; i++) {
    const post = spintaxEngine.getNextMexcPost(testLink);
    assert(post.post !== undefined, `Post ${i+1} has .post field`);
    assert(post.post.length <= 270, `Post ${i+1} is under 270 chars (${post.post.length})`);
    assert(post.post.includes(testLink), `Post ${i+1} contains the link`);
    assert(post.post.includes('#MEXC'), `Post ${i+1} contains #MEXC`);
    assert(post.templateId !== undefined, `Post ${i+1} has templateId`);
    assert(post.variation !== undefined, `Post ${i+1} has variation index`);
  }

  // 2f. MEXC stats
  console.log('\n  2f. MEXC stats:');
  const stats = spintaxEngine.getMexcStats();
  assert(stats.templates === 150, `Has 150 templates (got ${stats.templates})`);
  assert(typeof stats.sequences === 'number', 'Sequence counter exists');
  assert(stats.totalValidPosts > 0, `Has valid posts (${stats.totalValidPosts})`);

  // 2g. Reset counters and verify
  console.log('\n  2g. Reset counters:');
  spintaxEngine.resetAllCounters();
  const statsAfter = spintaxEngine.getMexcStats();
  assert(statsAfter.sequences === 0, 'Sequence reset to 0');

  // 2h. Test with different link length
  console.log('\n  2h. Custom link length:');
  const shortLink = 'https://mexc.com/ref?code=test123';
  const customPost = spintaxEngine.getNextMexcPost(shortLink);
  assert(customPost.post !== undefined, 'Custom link works');
  assert(customPost.post.includes(shortLink), 'Custom link in post');

  console.log('\n📦 Test Suite 2 complete');

  // ===== TEST 3: REPORT ENGINE =====
  console.log('\n📦 Test Suite 3: Report Engine');

  const reportDir = path.join(SANDBOX_DIR, 'reports');

  // 3a. Constructor creates directory
  console.log('\n  3a. Constructor:');
  const report = new ReportEngine(reportDir);
  assert(report instanceof ReportEngine, 'ReportEngine instantiated');
  assert(report.reportDir === reportDir, 'Report directory set');

  // 3b. Start run
  console.log('\n  3b. Start run:');
  report.startRun();
  assert(report.runId, 'Run ID generated');
  assert(report.startTime, 'Start time set');
  assert(report.endTime === null, 'End time null initially');

  // 3c. Log events
  console.log('\n  3c. Log events:');
  report.logEvent({ level: 'info', event: 'POST_START', postId: 'p1', attempt: 1, message: 'started' });
  report.logEvent({ level: 'warn', event: 'RETRY', postId: 'p1', attempt: 2, message: 'retrying' });
  report.logEvent({ level: 'error', event: 'POST_FAIL', postId: 'p1', attempt: 3, message: 'failed' });
  assert(report.timeline.length === 3, 'Timeline has 3 events');
  assert(report.stats.retried === 1, 'Retried stat incremented (1, not 2 — POST_FAIL excluded)');

  // 3d. Record post results
  console.log('\n  3d. Post results:');
  report.recordPostResult({ postId: 'p1', text: 'ok', status: 'success', attempts: 1 });
  report.recordPostResult({ postId: 'p2', text: 'unc', status: 'unconfirmed', attempts: 2 });
  report.recordPostResult({ postId: 'p3', text: 'fail', status: 'failed', attempts: 3, errorType: 'network', lastError: 'timeout' });
  report.recordPostResult({ postId: 'p4', text: 'dead', status: 'dead_letter', attempts: 3, errorType: 'unknown', lastError: 'weird' });
  assert(report.stats.totalPosts === 4, 'Total posts counted');
  assert(report.stats.success === 1, '1 success');
  assert(report.stats.unconfirmed === 1, '1 unconfirmed');
  assert(report.stats.failed === 1, '1 failed');
  assert(report.stats.deadLetter === 1, '1 dead letter');
  assert(report.failures.length === 2, '2 failures tracked');

  // 3e. Record times
  console.log('\n  3e. Performance metrics:');
  report.recordPostTime(1000);
  report.recordPostTime(3000);
  report.recordPostTime(2000);
  assert(report.performance.postTimes.length === 3, '3 times recorded');

  // 3f. Generate report
  console.log('\n  3f. Report generation:');
  report.endTime = new Date().toISOString();
  const reportData = report.generateReport();
  assert(reportData.runId, 'Report has runId');
  assert(reportData.stats, 'Report has stats');
  assert(reportData.performance, 'Report has performance');
  assert(reportData.performance.avgPostTimeMs === 2000, 'Average time correct');
  assert(reportData.performance.maxPostTimeMs === 3000, 'Max time correct');
  assert(reportData.performance.minPostTimeMs === 1000, 'Min time correct');

  // 3g. Text report format
  console.log('\n  3g. Text report:');
  const textReport = report.generateTextReport(reportData);
  assert(textReport.includes('XPOSTER RUN REPORT'), 'Report header present');
  assert(textReport.includes('Success Rate:'), 'Success rate present');
  assert(textReport.includes('network'), 'Error types in report');

  // 3h. Flush to files
  console.log('\n  3h. Flush to files:');
  const flushResult = await report.endRun();
  assert(flushResult.success, 'Flush succeeded');
  assert(fs.existsSync(flushResult.jsonPath), 'JSON file created');
  assert(fs.existsSync(flushResult.txtPath), 'TXT file created');

  // Verify JSON content
  const jsonContent = JSON.parse(fs.readFileSync(flushResult.jsonPath, 'utf8'));
  assert(jsonContent.runId, 'JSON file has valid runId');
  assert(jsonContent.stats.totalPosts === 4, 'JSON file has correct stats');

  console.log('\n📦 Test Suite 3 complete');

  // ===== SUMMARY =====
  console.log('══════════════════════════════════════════\n');
  const total = passed + failed;
  const pct = ((passed / total) * 100).toFixed(1);
  console.log(`📊 RESULTS: ${passed}/${total} passed (${pct}%)`);
  if (failed > 0) {
    console.error('\n❌ FAILURES:');
    errors.forEach(e => console.error(e));
    process.exit(1);
  } else {
    console.log('\n✅ ALL TESTS PASSED — Sandbox Simulation successful!');
  }

  // Cleanup
  os.homedir = origHomedir;
  try { fs.rmSync(SANDBOX_DIR, { recursive: true }); } catch(e) {}
}

runAll().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
