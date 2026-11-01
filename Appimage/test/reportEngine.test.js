'use strict';

const { ReportEngine } = require('../dev/automation/reportEngine');
const fs = require('fs').promises;
const path = require('path');
const assert = require('assert');

const TEST_DIR = '/tmp/report-engine-test';

async function setup() {
  try { await fs.rm(TEST_DIR, { recursive: true }); } catch (e) { /* ok */ }
  await fs.mkdir(TEST_DIR, { recursive: true });
}

async function teardown() {
  try { await fs.rm(TEST_DIR, { recursive: true }); } catch (e) { /* ok */ }
}

// === Test 1: Constructor creates directory ===
async function testConstructorCreatesDir() {
  const testDir = path.join(TEST_DIR, 'test1');
  const r = new ReportEngine(testDir);
  await new Promise(resolve => setTimeout(resolve, 200));
  const exists = await fs.access(testDir).then(() => true).catch(() => false);
  assert.strictEqual(exists, true, 'Directory should be created');
  console.log('PASS: testConstructorCreatesDir');
}

// === Test 2: startRun initializes all state ===
async function testStartRun() {
  const r = new ReportEngine(TEST_DIR);
  r.startRun();
  assert.ok(r.runId, 'runId should be set');
  assert.ok(r.startTime, 'startTime should be set');
  assert.strictEqual(r.endTime, null, 'endTime should be null');
  assert.deepStrictEqual(r.stats, { totalPosts: 0, success: 0, failed: 0, unconfirmed: 0, retried: 0, deadLetter: 0, deferred: 0 }, 'stats should be zeroed');
  assert.deepStrictEqual(r.performance, { postTimes: [] }, 'performance should be empty');
  assert.deepStrictEqual(r.failures, [], 'failures should be empty');
  assert.deepStrictEqual(r.timeline, [], 'timeline should be empty');
  console.log('PASS: testStartRun');
}

// === Test 3: logEvent appends to timeline ===
async function testLogEvent() {
  const r = new ReportEngine(TEST_DIR);
  r.startRun();
  r.logEvent({ level: 'info', event: 'POST_START', postId: 'p1', attempt: 1, message: 'started' });
  assert.strictEqual(r.timeline.length, 1, 'timeline should have 1 entry');
  assert.ok(r.timeline[0].timestamp, 'entry should have timestamp');
  assert.strictEqual(r.timeline[0].event, 'POST_START');
  assert.strictEqual(r.timeline[0].postId, 'p1');
  assert.strictEqual(r.timeline[0].attempt, 1);
  assert.strictEqual(r.timeline[0].details, 'started');
  console.log('PASS: testLogEvent');
}

// === Test 4: RETRY event increments retried stat ===
async function testRetryIncrementsRetried() {
  const r = new ReportEngine(TEST_DIR);
  r.startRun();
  r.logEvent({ level: 'warn', event: 'RETRY', postId: 'p1', attempt: 2, message: 'retrying' });
  assert.strictEqual(r.stats.retried, 1, 'retried should be 1');
  r.logEvent({ level: 'warn', event: 'RETRY', postId: 'p1', attempt: 3, message: 'retrying again' });
  assert.strictEqual(r.stats.retried, 2, 'retried should be 2');
  console.log('PASS: testRetryIncrementsRetried');
}

// === Test 5: POST_FAIL does NOT increment retried ===
async function testPostFailDoesNotIncrementRetried() {
  const r = new ReportEngine(TEST_DIR);
  r.startRun();
  r.stats.retried = 2; // simulate existing retries
  r.logEvent({ level: 'error', event: 'POST_FAIL', postId: 'p1', attempt: 3, message: 'failed' });
  assert.strictEqual(r.stats.retried, 2, 'POST_FAIL should NOT increment retried');
  console.log('PASS: testPostFailDoesNotIncrementRetried');
}

// === Test 6: recordPostResult updates stats correctly ===
async function testRecordPostResult() {
  const r = new ReportEngine(TEST_DIR);
  r.startRun();
  r.recordPostResult({ postId: 'p1', text: 'ok', status: 'success', attempts: 1 });
  r.recordPostResult({ postId: 'p2', text: 'unc', status: 'unconfirmed', attempts: 1 });
  r.recordPostResult({ postId: 'p3', text: 'fail', status: 'failed', attempts: 3, errorType: 'network', lastError: 'timeout' });
  r.recordPostResult({ postId: 'p4', text: 'dead', status: 'dead_letter', attempts: 3, errorType: 'unknown', lastError: 'weird' });
  assert.strictEqual(r.stats.totalPosts, 4);
  assert.strictEqual(r.stats.success, 1);
  assert.strictEqual(r.stats.unconfirmed, 1);
  assert.strictEqual(r.stats.failed, 1);
  assert.strictEqual(r.stats.deadLetter, 1);
  assert.strictEqual(r.failures.length, 2);
  assert.strictEqual(r.failures[0].errorType, 'network');
  assert.strictEqual(r.failures[1].finalStatus, 'dead_letter');
  console.log('PASS: testRecordPostResult');
}

// === Test 7: generateReport produces correct JSON schema ===
async function testGenerateReportSchema() {
  const r = new ReportEngine(TEST_DIR);
  r.startRun();
  r.logEvent({ level: 'info', event: 'POST_START', postId: 'p1', attempt: 1, message: 'start' });
  r.recordPostResult({ postId: 'p1', text: 'hello', status: 'success', attempts: 1 });
  r.recordPostTime(5000);
  r.endTime = new Date().toISOString();
  const report = r.generateReport();
  // Verify all required fields
  assert.ok(report.runId);
  assert.ok(report.startTime);
  assert.ok(report.endTime);
  assert.strictEqual(typeof report.durationSeconds, 'number');
  assert.ok(report.stats);
  assert.ok(report.performance);
  assert.ok(Array.isArray(report.failures));
  assert.ok(Array.isArray(report.timeline));
  assert.strictEqual(typeof report.performance.avgPostTimeMs, 'number');
  assert.strictEqual(typeof report.performance.maxPostTimeMs, 'number');
  assert.strictEqual(typeof report.performance.minPostTimeMs, 'number');
  assert.strictEqual(report.performance.avgPostTimeMs, 5000);
  assert.strictEqual(report.performance.maxPostTimeMs, 5000);
  assert.strictEqual(report.performance.minPostTimeMs, 5000);
  assert.strictEqual(report.timeline.length, 1);
  assert.strictEqual(report.failures.length, 0);
  console.log('PASS: testGenerateReportSchema');
}

// === Test 8: Performance metrics with multiple values ===
async function testPerformanceMetrics() {
  const r = new ReportEngine(TEST_DIR);
  r.startRun();
  r.recordPostTime(1000);
  r.recordPostTime(3000);
  r.recordPostTime(2000);
  r.endTime = new Date().toISOString();
  const report = r.generateReport();
  assert.strictEqual(report.performance.avgPostTimeMs, 2000);
  assert.strictEqual(report.performance.maxPostTimeMs, 3000);
  assert.strictEqual(report.performance.minPostTimeMs, 1000);
  console.log('PASS: testPerformanceMetrics');
}

// === Test 9: Performance metrics with no posts ===
async function testPerformanceEmpty() {
  const r = new ReportEngine(TEST_DIR);
  r.startRun();
  r.endTime = new Date().toISOString();
  const report = r.generateReport();
  assert.strictEqual(report.performance.avgPostTimeMs, 0);
  assert.strictEqual(report.performance.maxPostTimeMs, 0);
  assert.strictEqual(report.performance.minPostTimeMs, 0);
  console.log('PASS: testPerformanceEmpty');
}

// === Test 10: generateTextReport format ===
async function testGenerateTextReport() {
  const r = new ReportEngine(TEST_DIR);
  r.startRun();
  r.recordPostResult({ postId: 'p1', text: 'ok', status: 'success', attempts: 1 });
  r.recordPostResult({ postId: 'p2', text: 'fail', status: 'failed', attempts: 3, errorType: 'network', lastError: 'timeout' });
  r.recordPostResult({ postId: 'p3', text: 'fail2', status: 'failed', attempts: 3, errorType: 'selector', lastError: 'not found' });
  r.endTime = new Date().toISOString();
  const report = r.generateReport();
  const text = r.generateTextReport(report);
  assert.ok(text.includes('XPOSTER RUN REPORT'));
  assert.ok(text.includes('Run ID:'));
  assert.ok(text.includes('Total:'));
  assert.ok(text.includes('Success Rate:'));
  assert.ok(text.includes('Top Failures:'));
  assert.ok(text.includes('network'));
  assert.ok(text.includes('selector'));
  assert.ok(text.includes('Performance:'));
  console.log('PASS: testGenerateTextReport');
}

// === Test 11: flushAll creates files ===
async function testFlushAll() {
  const testDir = path.join(TEST_DIR, 'test-flush');
  const r = new ReportEngine(testDir);
  r.startRun();
  r.recordPostResult({ postId: 'p1', text: 'test', status: 'success', attempts: 1 });
  r.endTime = new Date().toISOString();
  const result = await r.flushAll();
  assert.ok(result.success, 'flush should succeed');
  assert.ok(result.jsonPath, 'jsonPath should be set');
  assert.ok(result.txtPath, 'txtPath should be set');
  // Verify files exist
  const jsonExists = await fs.access(result.jsonPath).then(() => true).catch(() => false);
  const txtExists = await fs.access(result.txtPath).then(() => true).catch(() => false);
  assert.ok(jsonExists, 'JSON file should exist');
  assert.ok(txtExists, 'TXT file should exist');
  console.log('PASS: testFlushAll');
}

// === Test 12: flushAll crash safety (write failure) ===
async function testFlushAllCrashSafety() {
  // Create a file at the target path to block directory creation
  const blockPath = path.join(TEST_DIR, 'test-block');
  await fs.writeFile(blockPath, 'blocker');
  const r = new ReportEngine(blockPath);
  r.startRun();
  r.recordPostResult({ postId: 'p1', text: 'test', status: 'success', attempts: 1 });
  r.endTime = new Date().toISOString();
  // Should not throw — should catch error and return success:false
  const result = await r.flushAll();
  assert.strictEqual(result.success, false, 'flush should fail gracefully when write is impossible');
  await fs.unlink(blockPath);
  console.log('PASS: testFlushAllCrashSafety');
}

// === Test 13: endRun calls flushAll ===
async function testEndRun() {
  const testDir = path.join(TEST_DIR, 'test-endrun');
  const r = new ReportEngine(testDir);
  r.startRun();
  r.recordPostResult({ postId: 'p1', text: 'test', status: 'success', attempts: 1 });
  const result = await r.endRun();
  assert.ok(result.success, 'endRun should return flush result');
  // Verify directory now has files
  const files = await fs.readdir(testDir);
  const jsonFiles = files.filter(f => f.endsWith('.json'));
  assert.ok(jsonFiles.length > 0, 'JSON files should exist after endRun');
  console.log('PASS: testEndRun');
}

// === Run all tests ===
async function runAll() {
  await setup();
  try {
    await testConstructorCreatesDir();
    await testStartRun();
    await testLogEvent();
    await testRetryIncrementsRetried();
    await testPostFailDoesNotIncrementRetried();
    await testRecordPostResult();
    await testGenerateReportSchema();
    await testPerformanceMetrics();
    await testPerformanceEmpty();
    await testGenerateTextReport();
    await testFlushAll();
    await testFlushAllCrashSafety();
    await testEndRun();
    console.log('\n=== ALL 13 TESTS PASSED ===');
  } catch (err) {
    console.error('\nTEST FAILED:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    await teardown();
  }
}

runAll();
