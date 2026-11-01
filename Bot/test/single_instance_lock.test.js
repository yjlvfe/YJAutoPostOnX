'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const { run, SingleInstanceLock } = require(path.join(ROOT, 'src/runner'));

describe('SingleInstanceLock and Concurrency Guards (FINDING-004, FINDING-005)', () => {
  test('primary instance acquires lock and records PID and token', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-lock-acquire-'));
    const lockPath = path.join(tempDir, 'runner.lock');
    const lock = new SingleInstanceLock(lockPath);

    const release = await lock.acquire();
    assert.strictEqual(lock.locked, true);

    const raw = fs.readFileSync(lockPath, 'utf8');
    const record = JSON.parse(raw);
    assert.strictEqual(record.pid, process.pid);
    assert.strictEqual(typeof record.token, 'string');
    assert.strictEqual(typeof record.acquiredAt, 'string');

    await release();
    assert.strictEqual(lock.locked, false);
    assert.strictEqual(fs.existsSync(lockPath), false);
  });

  test('secondary instance immediately throws INSTANCE_LOCKED when lock held by live process', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-lock-conflict-'));
    const lockPath = path.join(tempDir, 'runner.lock');

    const lock1 = new SingleInstanceLock(lockPath);
    const release1 = await lock1.acquire();

    const lock2 = new SingleInstanceLock(lockPath, { timeoutMs: 5000 });
    const startTime = Date.now();

    let errorCaught = null;
    try {
      await lock2.acquire();
    } catch (err) {
      errorCaught = err;
    }

    const elapsed = Date.now() - startTime;
    assert.ok(errorCaught, 'Should throw an error');
    assert.strictEqual(errorCaught.code, 'INSTANCE_LOCKED');
    assert.match(errorCaught.message, /Telegram runner lock is held/);
    // Should fail immediately without waiting for timeoutMs
    assert.ok(elapsed < 1000, `Expected immediate failure, took ${elapsed}ms`);

    await release1();
  });

  test('recovers stale lock if holding process is dead', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-lock-stale-'));
    const lockPath = path.join(tempDir, 'runner.lock');

    // Simulate a dead process lock with a non-existent PID
    // 99999999 is overwhelmingly likely to not exist
    const deadPid = 99999999;
    try { process.kill(deadPid, 0); assert.fail('PID unexpectedly exists'); } catch (e) { assert.strictEqual(e.code, 'ESRCH'); }

    fs.writeFileSync(lockPath, JSON.stringify({
      pid: deadPid,
      token: 'stale-token-dead-pid',
      acquiredAt: new Date(Date.now() - 3600_000).toISOString()
    }) + '\n');

    const lock = new SingleInstanceLock(lockPath);
    const release = await lock.acquire();
    assert.strictEqual(lock.locked, true);

    const record = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.strictEqual(record.pid, process.pid);
    assert.notStrictEqual(record.token, 'stale-token-dead-pid');

    await release();
  });

  test('run() immediately throws INSTANCE_LOCKED and avoids polling Telegram if lock is held', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-runner-singleton-'));
    const lockPath = path.join(tempDir, 'telegram-runner.lock');

    // Simulate existing running instance holding the lock
    const primaryLock = new SingleInstanceLock(lockPath);
    const release = await primaryLock.acquire();

    let getMeCalled = false;
    let getUpdatesCalled = false;

    const mockApi = {
      getMe: async () => { getMeCalled = true; return { id: 1, username: 'testbot' }; },
      getUpdates: async () => { getUpdatesCalled = true; return []; },
      sendMessage: async () => ({})
    };

    let runnerError = null;
    try {
      await run({
        token: 'test-token',
        userId: '1',
        chatId: '1',
        dataDir: tempDir,
        lockPath,
        lockTimeoutMs: 2000,
        api: mockApi,
        logger: { log: () => {}, error: () => {} }
      });
    } catch (err) {
      runnerError = err;
    }

    assert.ok(runnerError, 'Runner should reject');
    assert.strictEqual(runnerError.code, 'INSTANCE_LOCKED');
    assert.strictEqual(getMeCalled, false, 'getMe must NOT be called when locked');
    assert.strictEqual(getUpdatesCalled, false, 'getUpdates must NOT be called when locked');

    await release();
  });

  test('run() terminates polling immediately and throws TELEGRAM_CONFLICT on 409 Conflict', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-runner-409-'));
    const lockPath = path.join(tempDir, 'telegram-runner.lock');

    let pollCount = 0;
    const mockApi = {
      getMe: async () => ({ id: 1, username: 'testbot' }),
      getUpdates: async () => {
        pollCount++;
        const conflictErr = Object.assign(new Error('Conflict: terminated by other getUpdates request; make sure that only one bot instance is running'), {
          code: 'TELEGRAM_API_ERROR',
          statusCode: 409,
          telegramCode: 409
        });
        throw conflictErr;
      },
      sendMessage: async () => ({})
    };

    const logs = [];
    let runnerError = null;
    try {
      await run({
        token: 'test-token',
        userId: '1',
        chatId: '1',
        dataDir: tempDir,
        lockPath,
        api: mockApi,
        maxPolls: 5,
        pollMs: 10,
        logger: {
          log: () => {},
          error: (msg) => logs.push(msg)
        }
      });
    } catch (err) {
      runnerError = err;
    }

    assert.ok(runnerError, 'Runner should throw on 409 Conflict');
    assert.strictEqual(runnerError.code, 'TELEGRAM_CONFLICT');
    assert.strictEqual(pollCount, 1, 'Must stop polling after first 409, no repeated polling');
    assert.ok(logs.some(l => l.includes('telegram_conflict')), 'Must log telegram_conflict event');
  });
});
