#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { snapshotProductionFiles, verifyProductionSnapshot } = require('./fixtures/hermetic_workspace');

const BOT_DIR = path.resolve(__dirname, '..');
const TEST_DIR = __dirname;

process.env.NODE_ENV = 'test';
process.env.YJ_TEST_MODE = '1';
process.env.PYTHONDONTWRITEBYTECODE = '1';

function listMatchingFiles(dir, suffix) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith(suffix))
    .sort()
    .map(f => path.join(dir, f));
}

function listTempTestDirs() {
  const tmp = os.tmpdir();
  try {
    return new Set(
      fs.readdirSync(tmp).filter(name =>
        name.startsWith('yj-bot-test-') ||
        name.startsWith('yj-bot-py-') ||
        name.startsWith('yj-test-')
      )
    );
  } catch {
    return new Set();
  }
}

function findPycFiles(dir) {
  const found = [];
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...findPycFiles(full));
    } else if (entry.name.endsWith('.pyc')) {
      found.push(full);
    }
  }
  return found;
}

function resolvePythonInterpreter() {
  const candidates = [
    process.env.DIRECT_X_PYTHON,
    path.join(BOT_DIR, '.venv-direct-x', 'bin', 'python'),
    '/root/Projects/YJAutoPostOnX/Bot/.venv-direct-x/bin/python',
    'python3',
    'python'
  ].filter(Boolean);

  for (const bin of candidates) {
    if (bin.includes('/') && !fs.existsSync(bin)) continue;
    const probe = spawnSync(bin, ['-B', '-c', 'import httpx, twikit; print("OK")'], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
    });
    if (probe.status === 0 && (probe.stdout || '').includes('OK')) {
      return bin;
    }
  }
  throw new Error('PYTHON_INTERPRETER_UNAVAILABLE: No Python interpreter with twikit and httpx found.');
}

function parseNodeTestCounts(output) {
  const passMatches = [...output.matchAll(/(?:ℹ|#)\s+pass\s+(\d+)/g)];
  const failMatches = [...output.matchAll(/(?:ℹ|#)\s+fail\s+(\d+)/g)];
  const cancelMatches = [...output.matchAll(/(?:ℹ|#)\s+cancelled\s+(\d+)/g)];

  const passed = passMatches.length > 0 ? Number(passMatches[passMatches.length - 1][1]) : 0;
  const failed = failMatches.length > 0 ? Number(failMatches[failMatches.length - 1][1]) : 0;
  const cancelled = cancelMatches.length > 0 ? Number(cancelMatches[cancelMatches.length - 1][1]) : 0;

  return { passed, failed, cancelled };
}

function parsePythonTestCounts(output) {
  const ranMatch = output.match(/Ran\s+(\d+)\s+tests?/i);
  const ran = ranMatch ? Number(ranMatch[1]) : 0;
  const ok = /\nOK(?:\s+\([^)]*\))?\s*$/.test(output.trim());
  const failMatch = output.match(/FAILED\s*\(([^)]+)\)/);
  let failed = 0;
  if (failMatch) {
    for (const part of failMatch[1].split(',')) {
      const m = part.match(/(?:failures|errors)=(\d+)/i);
      if (m) failed += Number(m[1]);
    }
    if (failed === 0) failed = 1;
  }
  const passed = ok ? ran : Math.max(0, ran - failed);
  return { passed, failed, cancelled: 0 };
}

function verifyNoLegacyTestFiles() {
  const pyDir = path.join(BOT_DIR, 'python');
  if (fs.existsSync(pyDir)) {
    const strayPyTests = fs.readdirSync(pyDir).filter(f => f.startsWith('test_') && f.endsWith('.py'));
    if (strayPyTests.length > 0) {
      throw new Error(`LEGACY_PYTHON_TESTS_PRESENT: Found unretired test files in Bot/python/: ${strayPyTests.join(', ')}`);
    }
  }
  if (fs.existsSync(path.join(BOT_DIR, 'TEST_RUNNER'))) {
    throw new Error('LEGACY_TEST_RUNNER_PRESENT: Bot/TEST_RUNNER directory must be retired.');
  }
  const rootTestFiles = fs.readdirSync(TEST_DIR).filter(f => f.endsWith('.test.js') || f.endsWith('_test.py'));
  if (rootTestFiles.length > 0) {
    throw new Error(`LEGACY_ROOT_TESTS_PRESENT: Found legacy test files directly under Bot/test/: ${rootTestFiles.join(', ')}`);
  }
}

function runStage(name, cmd, args, timeoutMs, parser) {
  console.log(`\n=== [${name}] ===`);
  const startedAt = Date.now();
  const res = spawnSync(cmd, args, {
    cwd: BOT_DIR,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      YJ_TEST_MODE: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONPATH: [
        path.join(BOT_DIR, 'python'),
        path.join(TEST_DIR, 'fixtures'),
        path.join(TEST_DIR, 'python')
      ].join(path.delimiter)
    }
  });

  const combined = `${res.stdout || ''}\n${res.stderr || ''}`;
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);

  const durationMs = Date.now() - startedAt;
  const counts = parser(combined);
  const timedOut = res.error?.code === 'ETIMEDOUT' || res.signal === 'SIGTERM';
  const ok = !timedOut && res.status === 0 && counts.passed > 0 && counts.failed === 0 && counts.cancelled === 0;

  if (!ok) {
    console.error(`❌ [${name}] FAILED (status=${res.status}, signal=${res.signal}, pass=${counts.passed}, fail=${counts.failed}, cancelled=${counts.cancelled})`);
  } else {
    console.log(`✅ [${name}] PASSED (${counts.passed} tests in ${durationMs}ms)`);
  }

  return {
    name,
    ok,
    exitCode: res.status ?? 1,
    signal: res.signal || null,
    durationMs,
    ...counts
  };
}

function main() {
  const startedAt = Date.now();
  console.log('==============================================================================');
  console.log(' YJAutoPostOnX Unified Hermetic Test Suite (Bot/test/run_all.js)');
  console.log('==============================================================================');

  verifyNoLegacyTestFiles();
  const preProdSnapshot = snapshotProductionFiles();
  const preTempDirs = listTempTestDirs();

  const nodeFiles = listMatchingFiles(path.join(TEST_DIR, 'node'), '.test.js');
  const pyFiles = listMatchingFiles(path.join(TEST_DIR, 'python'), '.py').filter(f => path.basename(f).startsWith('test_'));
  const e2eFiles = listMatchingFiles(path.join(TEST_DIR, 'e2e'), '.e2e.test.js');

  if (nodeFiles.length === 0 || pyFiles.length === 0 || e2eFiles.length === 0) {
    throw new Error(`MISSING_TEST_SUITES: node=${nodeFiles.length}, python=${pyFiles.length}, e2e=${e2eFiles.length}`);
  }

  const pythonBin = resolvePythonInterpreter();
  const stages = [];

  stages.push(
    runStage(
      'Stage 1: Node Unit & Integration Suites (Bot/test/node/*.test.js)',
      process.execPath,
      ['--test', '--test-concurrency=2', '--test-timeout=30000', ...nodeFiles],
      90_000,
      parseNodeTestCounts
    )
  );

  stages.push(
    runStage(
      'Stage 2: Python Bridge Suites (Bot/test/python/test_*.py)',
      pythonBin,
      ['-B', '-m', 'unittest', 'discover', '-s', 'test/python', '-p', 'test_*.py', '-v'],
      60_000,
      parsePythonTestCounts
    )
  );

  stages.push(
    runStage(
      'Stage 3: Nonposting Service E2E Suites (Bot/test/e2e/*.e2e.test.js)',
      process.execPath,
      ['--test', '--test-concurrency=1', '--test-timeout=45000', ...e2eFiles],
      90_000,
      parseNodeTestCounts
    )
  );

  verifyProductionSnapshot(preProdSnapshot);

  const pycInTest = findPycFiles(TEST_DIR);
  if (pycInTest.length > 0) {
    throw new Error(`BYTECODE_POLLUTION_DETECTED: Found .pyc files in Bot/test/: ${pycInTest.join(', ')}`);
  }

  const postTempDirs = listTempTestDirs();
  const leakedTempDirs = [...postTempDirs].filter(d => !preTempDirs.has(d));
  if (leakedTempDirs.length > 0) {
    for (const d of leakedTempDirs) {
      try { fs.rmSync(path.join(os.tmpdir(), d), { recursive: true, force: true }); } catch {}
    }
    throw new Error(`LEAKED_TEMP_DIRS: Test suite leaked temporary directories: ${leakedTempDirs.join(', ')}`);
  }

  const summary = {
    ok: stages.every(s => s.ok),
    totalPassed: stages.reduce((acc, s) => acc + s.passed, 0),
    totalFailed: stages.reduce((acc, s) => acc + s.failed, 0),
    totalCancelled: stages.reduce((acc, s) => acc + s.cancelled, 0),
    durationMs: Date.now() - startedAt,
    productionDbUntouched: true,
    leakedTempDirs: 0,
    stages
  };

  console.log('\n==============================================================================');
  console.log(' TEST SUITE SUMMARY:', JSON.stringify(summary));
  console.log('==============================================================================');

  if (!summary.ok) {
    process.exit(1);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('FATAL TEST RUNNER ERROR:', err.message);
    process.exit(1);
  }
}

module.exports = { main };
