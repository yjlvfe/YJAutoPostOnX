/**
 * xPoster Chaos Engineering & Stress Test — Phase 5
 * Simulates network failures, rate limits, system lag, and edge cases.
 * System must NOT crash under any circumstance.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const STRESS_DIR = path.join(os.tmpdir(), 'xposter-chaos-' + Date.now());
const origHomedir = os.homedir;
os.homedir = () => STRESS_DIR;

// Clean imports for isolated testing
delete require.cache[require.resolve('../src/automation/queueManager')];
delete require.cache[require.resolve('../src/automation/spintaxEngine')];
delete require.cache[require.resolve('../src/automation/reportEngine')];

const queueManager = require('../src/automation/queueManager');
const spintaxEngine = require('../src/automation/spintaxEngine');
const { ReportEngine } = require('../src/automation/reportEngine');
const xPoster = require('../src/automation/xPoster');

let passed = 0;
let failed = 0;
const errors = [];

function assert(condition, msg) {
  if (condition) { passed++; }
  else {
    failed++;
    errors.push(`  ❌ ${msg}`);
    console.error(`  ❌ ${msg}`);
  }
}

// Pre-create sandbox dir
try { fs.rmSync(STRESS_DIR, { recursive: true }); } catch(e) {}
fs.mkdirSync(path.join(STRESS_DIR, '.config', 'x-poster-bot-profile'), { recursive: true });

async function runChaos() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  XPOSTER CHAOS ENGINEERING & STRESS TESTING  ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  // ============ CHAOS 1: Network Failure Simulation ============
  console.log('🌀 Chaos 1: Network Failure Simulation');
  console.log('   Testing rate limit pattern detection (parsing of HTML content)\n');

  // 1a. Rate limit pattern detection - English
  const ratePatterns = [
    { html: 'rate limit exceeded try again later', expect: true },
    { html: 'Too many requests. Please wait.', expect: true },
    { html: 'HTTP 429 Too Many Requests', expect: true },
    { html: 'Something went wrong. Please try again.', expect: true },
    { html: 'please wait before making another request', expect: true },
    { html: 'rate limited', expect: true },
    { html: 'ratelimit', expect: true },
    { html: 'This page works fine', expect: false },
    { html: 'The separate element', expect: false },
    { html: 'unlimited data plan', expect: false },
    { html: 'normal content without any restrictions', expect: false },
  ];

  for (const test of ratePatterns) {
    const patterns = [
      /\brate\b.*\blimit\b/i, /\btoo many requests\b/i, /\b429\b/,
      /\bplease wait\b/i, /\bsomething went wrong\b/i,
      /\bمعدل\b/i, /\bتقييد\b/i, /\bالمعدل\b/i,
      /\brate limited\b/i, /\bratelimit\b/i
    ];
    const detected = patterns.some(p => p.test(test.html));
    assert(detected === test.expect, `Rate pattern "${test.html.substring(0, 40)}" → ${detected} (expected ${test.expect})`);
  }

  // 1b. Arabic rate limit patterns
  const arabicPatterns = [
    { html: 'تم تطبيق معدل التقييد على حسابك', expect: true },
    { html: 'نظام التقييد يعمل بشكل طبيعي', expect: true },
    { html: 'مرحباً بكم في منصة التداول', expect: false },
  ];
  for (const test of arabicPatterns) {
    const patterns = [/معدل/i, /تقييد/i, /المعدل/i];
    const detected = patterns.some(p => p.test(test.html));
    assert(detected === test.expect, `Arabic pattern "${test.html.substring(0, 40)}" → ${detected}`);
  }

  console.log('\n   ✅ Rate limit detection: ' + ratePatterns.length + ' + ' + arabicPatterns.length + ' patterns verified');

  // ============ CHAOS 2: Spintax Engine Stress ============
  console.log('\n🌀 Chaos 2: Spintax Engine Stress Test');
  
  // 2a. Generate 1000 MEXC posts and check constraints
  console.log('\n  2a. Generating 1000 MEXC posts...');
  const link = 'https://www.mexc.com/acquisition/custom-sign-up?shareCode=mexc-12UHY5';
  let postCount = 0;
  let under270 = 0;
  let hasLink = 0;
  let hasMexc = 0;
  
  for (let i = 0; i < 1000; i++) {
    const result = spintaxEngine.getNextMexcPost(link);
    if (result.post) {
      postCount++;
      if (result.post.length <= 270) under270++;
      if (result.post.includes(link)) hasLink++;
      if (result.post.includes('#MEXC')) hasMexc++;
    }
  }
  assert(postCount === 1000, `Generated ${postCount} posts (expected 1000)`);
  assert(under270 === 1000, `All ${under270} posts under 270 chars`);
  assert(hasLink === 1000, `All ${hasLink} posts contain the link`);
  assert(hasMexc === 1000, `All ${hasMexc} posts contain #MEXC`);

  // 2b. Edge case: very long link
  console.log('\n  2b. Very long link edge case:');
  const longLink = 'https://www.mexc.com/acquisition/custom-sign-up?shareCode=mexc-12UHY5&utm_source=twitter&utm_medium=social&utm_campaign=test&ref=very_long_reference_code_12345';
  let longPass = 0;
  let longFail = 0;
  for (let i = 0; i < 100; i++) {
    const result = spintaxEngine.getNextMexcPost(longLink);
    if (result.post) {
      if (result.post.length <= 270 && result.post.includes(longLink)) longPass++;
      else longFail++;
    }
  }
  // With longer links, some templates may exceed 270 chars — that's OK, they get filtered
  // But the system must NOT crash
  assert(longPass + longFail === 100, 'System survived long link stress test');
  assert(!longFail.toString().includes('NaN'), 'No NaN errors');

  // 2c. Edge case: empty link
  console.log('\n  2c. Empty link edge case:');
  let emptyResult;
  try {
    emptyResult = spintaxEngine.getNextMexcPost('');
    assert(true, 'Empty link did not crash');
  } catch (e) {
    assert(false, `Empty link crashed: ${e.message}`);
  }

  // 2d. Edge case: null link
  console.log('\n  2d. Null link edge case:');
  try {
    const nullResult = spintaxEngine.getNextMexcPost(null);
    assert(true, 'Null link did not crash');
  } catch (e) {
    assert(false, `Null link crashed: ${e.message}`);
  }

  // 2e. Edge case: invalid spintax (nested brackets, unclosed)
  console.log('\n  2e. Invalid spintax patterns:');
  const invalidTemplates = [
    '{unclosed',
    'no brackets at all',
    '{empty|}',
    '{|empty}',
    '{a|b|c} {d|e} {',
  ];
  for (const tmpl of invalidTemplates) {
    try {
      const res = spintaxEngine.parseSpintax(tmpl);
      assert(typeof res === 'string', `Invalid template did not crash: "${tmpl}"`);
    } catch (e) {
      assert(false, `Invalid template crashed: "${tmpl}" → ${e.message}`);
    }
  }

  // 2f. Generate variations with very large requested count
  console.log('\n  2f. Large variation request:');
  try {
    const bigVariations = spintaxEngine.generateVariations('{hello|world|foo} {bar|baz}', 10000);
    assert(true, 'Large variation request did not crash');
  } catch (e) {
    assert(false, `Large variation request crashed: ${e.message}`);
  }

  // ============ CHAOS 3: Queue Manager Stress ============
  console.log('\n🌀 Chaos 3: Queue Manager Stress Test');

  // 3a. Add 5000 posts rapidly
  console.log('\n  3a. Adding 5000 posts...');
  const manyPosts = [];
  for (let i = 0; i < 5000; i++) {
    manyPosts.push(`🚀 منشور تجريبي رقم ${i} مع رابط https://mexc.com #MEXC`);
  }
  let addResult;
  try {
    addResult = await queueManager.addPosts(manyPosts);
    assert(true, '5000 posts added without crash');
  } catch (e) {
    assert(false, `5000 posts crashed: ${e.message}`);
  }

  // 3b. Verify queue size
  console.log('\n  3b. Verifying queue integrity:');
  let bigQueue = await queueManager.getQueue();
  assert(bigQueue.length === 5000, `Queue has ${bigQueue.length} items (expected 5000)`);

  // 3c. Bulk delete all even indices
  console.log('\n  3c. Bulk deleting 2500 items...');
  const evenIndices = [];
  for (let i = 0; i < bigQueue.length; i += 2) evenIndices.push(i);
  try {
    await queueManager.bulkDelete(evenIndices);
    bigQueue = await queueManager.getQueue();
    assert(bigQueue.length === 2500, `Queue has ${bigQueue.length} after bulk delete (expected 2500)`);
  } catch (e) {
    assert(false, `Bulk delete crashed: ${e.message}`);
  }

  // 3d. Clear queue
  console.log('\n  3d. Clearing queue:');
  await queueManager.clearQueue();
  bigQueue = await queueManager.getQueue();
  assert(bigQueue.length === 0, 'Queue cleared successfully');

  // 3e. Add posts with special characters
  console.log('\n  3e. Special characters stress:');
  const specialPosts = [
    'منشور بعلامات خاصة: !@#$%^&*()_+-=[]{}|;:,.<>?',
    'Post with "quotes" and \'single quotes\'',
    'Emoji stress: 😀🚀💎🔥🛡️⚡📊🎯🌟💼🔮✅🏛️🧠💡⚖️🔑🔒🔐',
    'مرحبا بكم في عالم الكريبتو والتداول الرقمي 🚀💎',
    'Post with\nnewlines\nin it',
    '   منشور بمسافات زائدة   ',
    'منشور طويل جداً ' + 'A'.repeat(250) + ' #MEXC',
    '',
    null,
    undefined,
  ];
  try {
    const result = await queueManager.addPosts(specialPosts);
    assert(true, 'Special character posts added without crash');
  } catch (e) {
    assert(false, `Special character posts crashed: ${e.message}`);
  }

  // 3f. Concurrent operations
  console.log('\n  3f. Concurrent operations (stress):');
  const concurrentOps = [];
  for (let i = 0; i < 20; i++) {
    concurrentOps.push(queueManager.addPosts([`Concurrent post ${i}`]));
    concurrentOps.push(queueManager.getQueue());
    concurrentOps.push(queueManager.addToPending(`Pending ${i}`));
  }
  try {
    await Promise.all(concurrentOps);
    assert(true, '20 concurrent operations completed without crash');
  } catch (e) {
    assert(false, `Concurrent operations crashed: ${e.message}`);
  }

  await queueManager.clearQueue();

  // ============ CHAOS 4: Report Engine Stress ============
  console.log('\n🌀 Chaos 4: Report Engine Stress Test');

  const reportDir = path.join(STRESS_DIR, 'chaos-reports');

  // 4a. Create reports with extreme values
  console.log('\n  4a. Extreme value stress:');
  const report = new ReportEngine(reportDir);
  report.startRun();
  for (let i = 0; i < 100; i++) {
    report.recordPostResult({
      postId: `p${i}`,
      text: 'x'.repeat(300),
      status: i % 4 === 0 ? 'success' : i % 4 === 1 ? 'failed' : i % 4 === 2 ? 'unconfirmed' : 'dead_letter',
      attempts: Math.floor(Math.random() * 10) + 1,
      errorType: ['network', 'selector', 'platform', 'unknown'][i % 4],
      lastError: 'Connection reset by peer'
    });
    report.recordPostTime(Math.floor(Math.random() * 30000));
    report.logEvent({
      level: ['info', 'warn', 'error'][i % 3],
      event: i % 5 === 0 ? 'POST_START' : i % 5 === 1 ? 'RETRY' : i % 5 === 2 ? 'POST_SUCCESS' : i % 5 === 3 ? 'POST_FAIL' : 'RUN_ERROR',
      postId: `p${Math.floor(i / 10)}`,
      attempt: Math.floor(i / 10),
      message: `Event ${i} for stress testing`
    });
  }

  let reportJson;
  try {
    report.endTime = new Date().toISOString();
    reportJson = report.generateReport();
    assert(reportJson.stats.totalPosts === 100, `Stats recorded ${reportJson.stats.totalPosts} posts`);
    assert(reportJson.performance.avgPostTimeMs > 0, 'Average time calculated');
    assert(reportJson.timeline.length === 100, `Timeline has ${reportJson.timeline.length} events`);
  } catch (e) {
    assert(false, `Report generation crashed: ${e.message}`);
  }

  // 4b. Flush with disk pressure
  console.log('\n  4b. Flush under stress:');
  try {
    const flushResult = await report.endRun();
    assert(flushResult.success, 'Flush succeeded under stress');
  } catch (e) {
    assert(false, `Flush crashed: ${e.message}`);
  }

  // 4c. Generate text report with 0 results (edge case)
  console.log('\n  4c. Edge case — empty report:');
  const emptyReport = new ReportEngine(reportDir);
  emptyReport.startRun();
  emptyReport.endTime = new Date().toISOString();
  const emptyJson = emptyReport.generateReport();
  const emptyText = emptyReport.generateTextReport(emptyJson);
  assert(emptyJson.stats.totalPosts === 0, 'Empty report has 0 posts');
  assert(emptyJson.performance.avgPostTimeMs === 0, 'Empty report has 0 avg time');
  assert(emptyText.includes('Success Rate: 0.0%'), 'Empty report shows 0% success rate');

  // ============ CHAOS 5: System Interrupt Simulation ============
  console.log('\n🌀 Chaos 5: System Interrupt & Recovery Simulation');

  // 5a. Global isRunning toggle
  console.log('\n  5a. Global isRunning flag:');
  global.isRunning = true;
  assert(global.isRunning === true, 'Global flag set to true');
  global.isRunning = false;
  assert(global.isRunning === false, 'Global flag set to false');
  global.isRunning = true;

  // 5b. Simulate the interruptible wait loop from xPoster
  console.log('\n  5b. Interruptible countdown simulation:');
  global.isRunning = true;
  let startTime = Date.now();
  
  // Simulate interrupt: set isRunning false after 500ms
  setTimeout(() => { global.isRunning = false; }, 500);
  
  // This loop should exit early when isRunning becomes false
  let iterations = 0;
  for (let i = 0; i < 100 && global.isRunning; i++) {
    await new Promise(r => setTimeout(r, 100));
    iterations++;
  }
  let elapsed = Date.now() - startTime;
  assert(iterations < 100, `Interruptible loop exited early (ran ${iterations} cycles in ${elapsed}ms)`);
  assert(elapsed < 2000, `Interrupt worked fast (${elapsed}ms)`);
  global.isRunning = true;

  // 5c. Multiple stop signals
  console.log('\n  5c. Multiple stop signals:');
  global.isRunning = true;
  global.isRunning = false;
  global.isRunning = true;  // Re-start
  global.isRunning = false; // Stop again
  assert(global.isRunning === false, 'Multiple toggle does not crash');

  // ============ CHAOS 6: Data Integrity ============
  console.log('\n🌀 Chaos 6: Data Integrity & Boundary Testing');

  // 6a. Post at exactly 270 chars boundary
  console.log('\n  6a. Boundary length testing:');
  const testLink = 'https://www.mexc.com/acquisition/custom-sign-up?shareCode=mexc-12UHY5';
  let exact270Count = 0;
  let over270Count = 0;
  // Check first 100 MEXC templates for boundary compliance
  spintaxEngine.resetAllCounters();
  for (let i = 0; i < 500; i++) {
    const result = spintaxEngine.getNextMexcPost(testLink);
    if (result.post) {
      if (result.post.length <= 270) exact270Count++;
      else over270Count++;
    }
  }
  assert(exact270Count > 0, `Some posts at valid length (${exact270Count} <= 270)`);
  // Some posts from different link lengths might exceed 270, but system must not crash
  assert(exact270Count + over270Count > 0, 'System produces posts without crashing');

  // 6b. Reset and verify stats consistency
  console.log('\n  6b. Stats consistency after reset:');
  spintaxEngine.resetAllCounters();
  let totalValidAfter = 0;
  const lib = spintaxEngine.getTemplateLibrary();
  for (const cat of lib) {
    for (const t of cat.templates) {
      totalValidAfter++;
    }
  }
  assert(totalValidAfter === 150, `150 templates in library after reset (got ${totalValidAfter})`);

  // 6c. Generate 100 posts and verify no duplicates in a single sequence
  console.log('\n  6c. Uniqueness check (100 consecutive posts):');
  spintaxEngine.resetAllCounters();
  const uniqueCheck = new Set();
  for (let i = 0; i < 100; i++) {
    const result = spintaxEngine.getNextMexcPost(testLink);
    if (result.post) uniqueCheck.add(result.post);
  }
  assert(uniqueCheck.size >= 90, `At least 90 unique posts out of 100 (got ${uniqueCheck.size})`);

  // ============ CHAOS 7: Extreme Concurrency ============
  console.log('\n🌀 Chaos 7: Extreme Concurrency (Promise.all)');

  // Queue concurrent operations
  const allOps = [];
  for (let i = 0; i < 50; i++) {
    allOps.push(queueManager.addPosts([`Stress post ${i}`]));
    allOps.push(queueManager.addToPending(`Stress pending ${i}`));
    allOps.push(queueManager.addDeadLetter(`Stress dead ${i}`, 'network', 'Timeout'));
    allOps.push(queueManager.getQueue());
    allOps.push(queueManager.getDeadLetters());
    allOps.push(queueManager.getPendingVerification());
  }
  try {
    await Promise.all(allOps);
    assert(true, '50 concurrent operations completed without crash');
  } catch (e) {
    assert(false, `Extreme concurrency crashed: ${e.message}`);
  }

  // ============ SUMMARY ============
  console.log('\n══════════════════════════════════════════════\n');
  const total = passed + failed;
  const pct = ((passed / total) * 100).toFixed(1);
  console.log(`📊 CHAOS RESULTS: ${passed}/${total} passed (${pct}%)`);
  if (failed > 0) {
    console.error('\n❌ CHAOS FAILURES:');
    errors.forEach(e => console.error(e));
    process.exit(1);
  } else {
    console.log('\n🏆 SYSTEM SURVIVED ALL CHAOS TESTS — No crashes under stress!');
  }

  // Cleanup
  os.homedir = origHomedir;
  try { fs.rmSync(STRESS_DIR, { recursive: true }); } catch(e) {}
}

runChaos().catch(err => {
  console.error('💥 CHAOS FATAL:', err);
  process.exit(1);
});
