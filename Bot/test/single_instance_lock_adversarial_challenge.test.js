'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const { run, SingleInstanceLock } = require(path.join(ROOT, 'src/runner'));

describe('SingleInstanceLock Empirical Adversarial Challenge', () => {

  // Focus Scenario 1:
  // Process 1 holds lock and exits after 3 seconds. Process 2 with timeoutMs: 15_000 polls and successfully acquires lock without crashing.
  test('Focus Scenario 1: Process 1 holds lock and releases after 3s; Process 2 with 15s timeout polls and acquires cleanly', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-sil-scen1-'));
    const lockPath = path.join(tempDir, 'runner.lock');

    const lock1 = new SingleInstanceLock(lockPath, { timeoutMs: 15_000 });
    const release1 = await lock1.acquire();
    assert.strictEqual(lock1.locked, true, 'Process 1 must acquire lock');

    const holdTimeMs = 3_000;
    const releaseTimer = setTimeout(async () => {
      await release1();
    }, holdTimeMs);

    const lock2 = new SingleInstanceLock(lockPath, { timeoutMs: 15_000, retryMs: 50 });
    const startTime = Date.now();

    let release2 = null;
    let lock2Error = null;

    try {
      release2 = await lock2.acquire();
    } catch (err) {
      lock2Error = err;
    }

    const elapsed = Date.now() - startTime;
    clearTimeout(releaseTimer);

    assert.strictEqual(lock2Error, null, `Process 2 must not crash, got error: ${lock2Error?.message}`);
    assert.strictEqual(lock2.locked, true, 'Process 2 must have acquired the lock');
    if (release2) await release2();
    assert.strictEqual(lock2.locked, false, 'Process 2 lock must be released after release2()');
    assert.ok(
      elapsed >= holdTimeMs - 150,
      `Process 2 must have waited for Process 1 to release (~${holdTimeMs}ms), but elapsed was ${elapsed}ms`
    );
    assert.ok(
      elapsed < 15_000,
      `Process 2 must acquire well before 15s timeout, took ${elapsed}ms`
    );
  });

  // Focus Scenario 2:
  // Process 1 holds lock indefinitely. Process 2 with timeoutMs: 500 polls for at least 450ms and throws INSTANCE_LOCKED with PID attached.
  test('Focus Scenario 2: Process 1 holds lock indefinitely; Process 2 with timeoutMs: 500 polls >= 450ms and throws INSTANCE_LOCKED with PID attached', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-sil-scen2-'));
    const lockPath = path.join(tempDir, 'runner.lock');

    const lock1 = new SingleInstanceLock(lockPath, { timeoutMs: 15_000 });
    const release1 = await lock1.acquire();
    assert.strictEqual(lock1.locked, true);

    const lock2 = new SingleInstanceLock(lockPath, { timeoutMs: 500, retryMs: 50 });
    const startTime = Date.now();

    let lock2Error = null;
    try {
      await lock2.acquire();
    } catch (err) {
      lock2Error = err;
    }

    const elapsed = Date.now() - startTime;
    await release1();

    assert.ok(lock2Error, 'Process 2 must throw error when timeout expires');
    assert.strictEqual(lock2Error.code, 'INSTANCE_LOCKED', `Expected INSTANCE_LOCKED code, got ${lock2Error.code}`);
    assert.strictEqual(lock2Error.pid, process.pid, `Expected error.pid to match holder PID (${process.pid}), got ${lock2Error.pid}`);
    assert.ok(
      lock2Error.message.includes(`held by PID ${process.pid}`),
      `Error message must include PID: ${lock2Error.message}`
    );
    assert.ok(
      elapsed >= 450,
      `Process 2 must poll for at least 450ms before timing out, elapsed: ${elapsed}ms`
    );
    assert.ok(
      elapsed <= 3500,
      `Process 2 timeout should be bounded reasonably close to 500ms, elapsed: ${elapsed}ms`
    );
  });

  // Focus Scenario 3:
  // Process 1 holds lock. Process 2 with timeoutMs: 0 immediately throws INSTANCE_LOCKED in <1000ms.
  test('Focus Scenario 3: Process 1 holds lock; Process 2 with timeoutMs: 0 immediately throws INSTANCE_LOCKED in <1000ms', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-sil-scen3-'));
    const lockPath = path.join(tempDir, 'runner.lock');

    const lock1 = new SingleInstanceLock(lockPath, { timeoutMs: 15_000 });
    const release1 = await lock1.acquire();
    assert.strictEqual(lock1.locked, true);

    const lock2 = new SingleInstanceLock(lockPath, { timeoutMs: 0, retryMs: 50 });
    const startTime = Date.now();

    let lock2Error = null;
    try {
      await lock2.acquire();
    } catch (err) {
      lock2Error = err;
    }

    const elapsed = Date.now() - startTime;
    await release1();

    assert.ok(lock2Error, 'Process 2 must throw immediately');
    assert.strictEqual(lock2Error.code, 'INSTANCE_LOCKED', `Expected INSTANCE_LOCKED code, got ${lock2Error.code}`);
    assert.strictEqual(lock2Error.pid, process.pid, `Expected error.pid to match holder PID (${process.pid}), got ${lock2Error.pid}`);
    assert.ok(
      elapsed < 1000,
      `Process 2 with timeoutMs: 0 must fail in <1000ms, actual: ${elapsed}ms`
    );
  });

  // Focus Scenario 4: True OS Multi-Process SIGKILL Crash & Recovery
  // External process holds lock and is killed with SIGKILL (abrupt death). Incoming process detects dead PID via ESRCH and acquires immediately.
  test('Focus Scenario 4: External OS process holds lock, dies via SIGKILL; incoming process detects ESRCH and acquires cleanly', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-sil-scen4-'));
    const lockPath = path.join(tempDir, 'runner.lock');

    // Spawn an actual independent child process to acquire lock and keep holding it
    const childCode = `
      const { SingleInstanceLock } = require('${path.join(ROOT, 'src/runner')}');
      const lock = new SingleInstanceLock('${lockPath}');
      lock.acquire().then(() => {
        process.stdout.write('ACQUIRED\\n');
        setInterval(() => {}, 10000); // Keep alive indefinitely
      });
    `;

    const child = spawn(process.execPath, ['-e', childCode], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    await new Promise((resolve, reject) => {
      child.stdout.on('data', data => {
        if (data.toString().includes('ACQUIRED')) resolve();
      });
      child.on('error', reject);
    });

    const childPid = child.pid;
    assert.ok(childPid > 0, 'Child must have valid PID');

    // Verify lock file exists and has child's PID
    const lockData = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.strictEqual(lockData.pid, childPid);

    // Incoming process starts polling
    const lock2 = new SingleInstanceLock(lockPath, { timeoutMs: 5_000, retryMs: 50 });
    let release2 = null;

    // After 200ms, violently kill the child process with SIGKILL (no cleanup handler runs)
    const killTimer = setTimeout(() => {
      try { process.kill(childPid, 'SIGKILL'); } catch (_) {}
    }, 200);

    const startTime = Date.now();
    release2 = await lock2.acquire();
    const elapsed = Date.now() - startTime;
    clearTimeout(killTimer);

    assert.strictEqual(lock2.locked, true, 'Lock2 must be acquired');
    const newLockData = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.strictEqual(newLockData.pid, process.pid, 'Lock must now belong to current process');

    if (release2) await release2();
    assert.ok(elapsed < 4000, `Recovery from dead PID must happen promptly, took ${elapsed}ms`);
  });

  // Focus Scenario 5: Multi-Process Thundering Herd Mutual Exclusion
  // 5 concurrent instances all contend for the lock when Process 1 releases. Exactly 1 gets it, zero dual-ownership.
  test('Focus Scenario 5: 5 concurrent instances contend upon release; exactly 1 acquires and mutual exclusion holds', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-sil-scen5-'));
    const lockPath = path.join(tempDir, 'runner.lock');

    const primaryLock = new SingleInstanceLock(lockPath, { timeoutMs: 5000 });
    const releasePrimary = await primaryLock.acquire();

    // Release primary in 300ms
    setTimeout(async () => {
      await releasePrimary();
    }, 300);

    // 5 secondary instances with different timeouts and retries
    const contenders = Array.from({ length: 5 }, (_, i) => {
      return new SingleInstanceLock(lockPath, {
        timeoutMs: 2000,
        retryMs: 20 + i * 10
      });
    });

    const results = await Promise.allSettled(
      contenders.map(c => c.acquire())
    );

    const fulfilled = results.filter(r => r.status === 'fulfilled');
    // At least 1 contender must have succeeded
    assert.ok(fulfilled.length >= 1, `At least 1 contender should succeed, got ${fulfilled.length}`);

    // Verify currently locked instances count
    const currentlyLocked = contenders.filter(c => c.locked);
    // Since contenders didn't release yet, at most 1 can be locked at this instant
    assert.strictEqual(currentlyLocked.length, 1, `Exactly 1 contender can hold the lock simultaneously, got ${currentlyLocked.length}`);

    // Verify lockfile on disk
    const content = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.strictEqual(content.token, currentlyLocked[0].token, 'Disk lockfile must match the active lock holder token');

    // Clean up
    for (const r of fulfilled) {
      if (typeof r.value === 'function') await r.value();
    }
  });

  // Focus Scenario 6: release() token mismatch safety
  test('Focus Scenario 6: release() with wrong or foreign token returns false and does not destroy lock', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-sil-scen6-'));
    const lockPath = path.join(tempDir, 'runner.lock');

    const lock1 = new SingleInstanceLock(lockPath);
    const release1 = await lock1.acquire();

    // Try releasing with a random token
    const foreignReleaseResult = await lock1.release('fake-token-1234');
    assert.strictEqual(foreignReleaseResult, false, 'Release with wrong token must return false');
    assert.strictEqual(lock1.locked, true, 'Lock must remain active');
    assert.ok(fs.existsSync(lockPath), 'Lockfile must not be deleted');

    // Now release with real function
    await release1();
    assert.strictEqual(lock1.locked, false);
    assert.ok(!fs.existsSync(lockPath), 'Lockfile must now be deleted');
  });

  // Focus Scenario 7: run() entry point respects lockTimeoutMs and acquires upon delayed release
  test('Focus Scenario 7: run() entry point waits for lock release up to lockTimeoutMs and runs successfully', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-sil-scen7-'));
    const lockPath = path.join(tempDir, 'runner.lock');

    // Process 1 holds lock
    const primaryLock = new SingleInstanceLock(lockPath, { timeoutMs: 5000 });
    const releasePrimary = await primaryLock.acquire();

    // Release after 400ms
    setTimeout(async () => {
      await releasePrimary();
    }, 400);

    let getMeCalled = false;
    let pollCount = 0;
    const mockApi = {
      getMe: async () => { getMeCalled = true; return { id: 1, username: 'testbot' }; },
      getUpdates: async () => { pollCount++; return []; },
      sendMessage: async () => ({})
    };

    const startTime = Date.now();
    await run({
      token: 'test-token',
      userId: '1',
      chatId: '1',
      dataDir: tempDir,
      lockPath,
      lockTimeoutMs: 2000,
      api: mockApi,
      maxPolls: 1,
      pollMs: 10,
      logger: { log: () => {}, error: () => {} }
    });
    const elapsed = Date.now() - startTime;

    assert.ok(elapsed >= 350, `run() must have waited for lock release, elapsed: ${elapsed}ms`);
    assert.strictEqual(getMeCalled, true, 'getMe must be called after acquiring lock');
    assert.strictEqual(pollCount, 1, 'Poll must execute once');
    assert.ok(!fs.existsSync(lockPath), 'Lockfile must be unlinked upon clean exit of run()');
  });

  // Focus Scenario 8: run() entry point fails immediately if lock held past lockTimeoutMs without touching Telegram
  test('Focus Scenario 8: run() entry point fails with INSTANCE_LOCKED when lock timeout expires without touching Telegram API', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-sil-scen8-'));
    const lockPath = path.join(tempDir, 'runner.lock');

    const primaryLock = new SingleInstanceLock(lockPath, { timeoutMs: 5000 });
    const releasePrimary = await primaryLock.acquire();

    let getMeCalled = false;
    const mockApi = {
      getMe: async () => { getMeCalled = true; return { id: 1, username: 'testbot' }; },
      getUpdates: async () => [],
      sendMessage: async () => ({})
    };

    let runnerError = null;
    const startTime = Date.now();
    try {
      await run({
        token: 'test-token',
        userId: '1',
        chatId: '1',
        dataDir: tempDir,
        lockPath,
        lockTimeoutMs: 300,
        api: mockApi,
        maxPolls: 1,
        pollMs: 10,
        logger: { log: () => {}, error: () => {} }
      });
    } catch (err) {
      runnerError = err;
    }
    const elapsed = Date.now() - startTime;
    await releasePrimary();

    assert.ok(runnerError, 'run() must reject when lock cannot be acquired');
    assert.strictEqual(runnerError.code, 'INSTANCE_LOCKED');
    assert.strictEqual(runnerError.pid, process.pid);
    assert.strictEqual(getMeCalled, false, 'Telegram API must NEVER be contacted if lock acquisition fails');
    assert.ok(elapsed >= 250, `run() should wait approximately 300ms before timeout, took ${elapsed}ms`);
  });

});

