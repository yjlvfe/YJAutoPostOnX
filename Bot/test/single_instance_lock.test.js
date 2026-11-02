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

    const lock2 = new SingleInstanceLock(lockPath, { timeoutMs: 0 });
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

  test('rapid restart race: secondary instance with timeoutMs acquires lock when primary releases after delay', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-lock-rapid-restart-'));
    const lockPath = path.join(tempDir, 'runner.lock');

    const lock1 = new SingleInstanceLock(lockPath);
    const release1 = await lock1.acquire();
    assert.strictEqual(lock1.locked, true);

    setTimeout(async () => {
      await release1();
    }, 200);

    const lock2 = new SingleInstanceLock(lockPath, { timeoutMs: 2000, retryMs: 20 });
    const startTime = Date.now();
    const release2 = await lock2.acquire();
    const elapsed = Date.now() - startTime;

    assert.strictEqual(lock2.locked, true);
    assert.ok(elapsed >= 150, `Expected wait for release, took ${elapsed}ms`);
    assert.ok(elapsed < 2000, `Expected acquisition within timeout, took ${elapsed}ms`);

    await release2();
    assert.strictEqual(fs.existsSync(lockPath), false);
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

  test('run() terminates polling and throws TELEGRAM_CONFLICT on persistent 409 Conflict after backoff', async () => {
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
        conflictBackoffMs: 10,
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
    assert.strictEqual(pollCount, 2, 'Must stop polling after initial 409 backoff retry (1 initial + 1 retry)');
    assert.ok(logs.some(l => l.includes('telegram_conflict_transient')), 'Must log transient warning');
    assert.ok(logs.some(l => l.includes('telegram_conflict')), 'Must log telegram_conflict event');
  });

  test('run() recovers from transient initial 409 Conflict and continues polling after backoff', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-runner-409-transient-'));
    const lockPath = path.join(tempDir, 'telegram-runner.lock');

    let pollCount = 0;
    const mockApi = {
      getMe: async () => ({ id: 1, username: 'testbot' }),
      getUpdates: async () => {
        pollCount++;
        if (pollCount === 1) {
          const conflictErr = Object.assign(new Error('Conflict: terminated by other getUpdates request; make sure that only one bot instance is running'), {
            code: 'TELEGRAM_API_ERROR',
            statusCode: 409,
            telegramCode: 409
          });
          throw conflictErr;
        }
        return [];
      },
      sendMessage: async () => ({})
    };

    const logs = [];
    await run({
      token: 'test-token',
      userId: '1',
      chatId: '1',
      dataDir: tempDir,
      lockPath,
      api: mockApi,
      maxPolls: 2,
      pollMs: 10,
      conflictBackoffMs: 10,
      logger: {
        log: (msg) => logs.push(msg),
        error: (msg) => logs.push(msg)
      }
    });

    assert.strictEqual(pollCount, 2, 'Must retry after initial 409 and succeed');
    assert.ok(logs.some(l => l.includes('telegram_conflict_transient')), 'Must log transient conflict warning');
  });

  test('run() recovers in-flight processing items to ambiguous on startup', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-runner-recovery-'));
    const dbPath = path.join(tempDir, 'state.sqlite');
    const lockPath = path.join(tempDir, 'telegram-runner.lock');
    const { SqliteStore } = require(path.join(ROOT, 'src/sqliteStore'));
    const store = new SqliteStore(dbPath, {
      items: [
        { id: 'item-crashed-1', state: 'processing', claimedAt: new Date().toISOString() },
        { id: 'item-done-1', state: 'published' },
        { id: 'item-pending-1', state: 'pending' }
      ],
      accounts: []
    });
    await store.load();
    await store.close();

    const mockApi = {
      getMe: async () => ({ id: 1, username: 'testbot' }),
      getUpdates: async () => [],
      sendMessage: async () => ({})
    };

    await run({
      token: 'test-token',
      userId: '1',
      chatId: '1',
      dataDir: tempDir,
      lockPath,
      api: mockApi,
      maxPolls: 1,
      pollMs: 10,
      logger: { log: () => {}, error: () => {} }
    });

    const verifyStore = new SqliteStore(dbPath);
    const state = await verifyStore.load();
    const recovered = state.items.find(x => x.id === 'item-crashed-1');
    assert.strictEqual(recovered.state, 'ambiguous', 'In-flight item must be transitioned to ambiguous');
    assert.strictEqual(recovered.outcome, 'ambiguous');
    assert.strictEqual(recovered.result?.reason, 'startup_crash_recovery');
    assert.strictEqual(recovered.reason, 'startup_crash_recovery');
    assert.ok(recovered.completedAt, 'completedAt must be populated');

    const itemDone = state.items.find(x => x.id === 'item-done-1');
    assert.strictEqual(itemDone.state, 'published', 'Already published item untouched');

    const itemPending = state.items.find(x => x.id === 'item-pending-1');
    assert.strictEqual(itemPending.state, 'pending', 'Pending item untouched');

    await verifyStore.close();
  });

  test('SingleInstanceLock defaults timeoutMs to 15,000ms', () => {
    const lock = new SingleInstanceLock('/tmp/dummy.lock');
    assert.strictEqual(lock.timeoutMs, 15_000, 'SingleInstanceLock default timeoutMs must be 15,000ms');
  });
});
