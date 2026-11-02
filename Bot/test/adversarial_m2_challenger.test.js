'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const { run, SingleInstanceLock } = require(path.join(ROOT, 'src/runner'));
const { SqliteStore } = require(path.join(ROOT, 'src/sqliteStore'));

describe('Milestone M2 Adversarial Challenge Suite', () => {

  // =========================================================================
  // Challenge 1: Startup Crash Recovery to Ambiguous State
  // =========================================================================
  describe('Challenge 1: Startup Crash Recovery', () => {
    test('transitions all processing items to ambiguous with startup_crash_recovery audit', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-adv-recovery-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const lockPath = path.join(tempDir, 'runner.lock');

      const store = new SqliteStore(dbPath, {
        items: [
          {
            id: 'proc-item-1',
            state: 'processing',
            claimedAt: new Date(Date.now() - 60000).toISOString(),
            payload: { text: 'In flight crash item 1' },
            result: { attemptToken: 'token-alpha', accountId: 'acc-1' }
          },
          {
            id: 'proc-item-2',
            state: 'processing',
            claimedAt: new Date(Date.now() - 30000).toISOString(),
            payload: { text: 'In flight crash item 2' }
          },
          {
            id: 'proc-item-3',
            state: 'processing',
            claimedAt: new Date(Date.now() - 10000).toISOString(),
            payload: { text: 'In flight crash item 3' },
            result: { someKey: 'original-value' }
          },
          { id: 'pending-item-1', state: 'pending', payload: { text: 'Pending item 1' } },
          { id: 'pending-item-2', state: 'pending', payload: { text: 'Pending item 2' } },
          { id: 'published-item-1', state: 'published', payload: { text: 'Published 1' }, result: { url: 'https://x.com/post/1' } },
          { id: 'ambiguous-item-1', state: 'ambiguous', payload: { text: 'Ambiguous 1' }, outcome: 'ambiguous', reason: 'previous_crash' },
          { id: 'failed-item-1', state: 'failed', payload: { text: 'Failed 1' }, error: 'some error' },
          { id: 'cancelled-item-1', state: 'cancelled', payload: { text: 'Cancelled 1' }, reason: 'queue_replaced' }
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

      // Check all 3 processing items are recovered
      for (const id of ['proc-item-1', 'proc-item-2', 'proc-item-3']) {
        const item = state.items.find(x => x.id === id);
        assert.ok(item, `Item ${id} must exist in state`);
        assert.strictEqual(item.state, 'ambiguous', `${id} state must be ambiguous`);
        assert.strictEqual(item.outcome, 'ambiguous', `${id} outcome must be ambiguous`);
        assert.strictEqual(item.reason, 'startup_crash_recovery', `${id} reason must be startup_crash_recovery`);
        assert.strictEqual(item.result?.reason, 'startup_crash_recovery', `${id} result.reason must be startup_crash_recovery`);
        assert.ok(typeof item.completedAt === 'string', `${id} completedAt must be timestamp`);
        assert.ok(!Number.isNaN(Date.parse(item.completedAt)), `${id} completedAt must be valid date`);
      }

      // Check existing result metadata is preserved (not wiped)
      const item1 = state.items.find(x => x.id === 'proc-item-1');
      assert.strictEqual(item1.result.attemptToken, 'token-alpha', 'Existing attemptToken must be preserved');
      assert.strictEqual(item1.result.accountId, 'acc-1', 'Existing accountId must be preserved');

      const item3 = state.items.find(x => x.id === 'proc-item-3');
      assert.strictEqual(item3.result.someKey, 'original-value', 'Existing custom result keys must be preserved');

      // Verify that non-processing items are completely unmodified
      const pending1 = state.items.find(x => x.id === 'pending-item-1');
      assert.strictEqual(pending1.state, 'pending');
      assert.strictEqual(pending1.outcome, undefined);

      const pub1 = state.items.find(x => x.id === 'published-item-1');
      assert.strictEqual(pub1.state, 'published');
      assert.strictEqual(pub1.result?.url, 'https://x.com/post/1');

      const amb1 = state.items.find(x => x.id === 'ambiguous-item-1');
      assert.strictEqual(amb1.state, 'ambiguous');
      assert.strictEqual(amb1.reason, 'previous_crash', 'Old ambiguous item reason must not be overwritten');

      const failed1 = state.items.find(x => x.id === 'failed-item-1');
      assert.strictEqual(failed1.state, 'failed');

      const canc1 = state.items.find(x => x.id === 'cancelled-item-1');
      assert.strictEqual(canc1.state, 'cancelled');

      await verifyStore.close();
    });

    test('recovers safely when items list is empty or contains zero processing items', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-adv-empty-recovery-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const lockPath = path.join(tempDir, 'runner.lock');

      const store = new SqliteStore(dbPath, { items: [], accounts: [] });
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
      assert.deepStrictEqual(state.items, []);
      await verifyStore.close();
    });
  });

  // =========================================================================
  // Challenge 2: Rapid Restart Race & 15s Lock Acquisition
  // =========================================================================
  describe('Challenge 2: Rapid Restart Lock Acquisition & Timeout Hardening', () => {
    test('rapid restart race: process 2 with 15s timeout acquires lock when process 1 releases after 3 seconds', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-adv-lock-restart-'));
      const lockPath = path.join(tempDir, 'runner.lock');

      // Process 1 acquires lock
      const lock1 = new SingleInstanceLock(lockPath, { timeoutMs: 15_000 });
      const release1 = await lock1.acquire();
      assert.strictEqual(lock1.locked, true);

      // Process 1 will release after 3,000ms
      const releaseDelayMs = 3_000;
      setTimeout(async () => {
        await release1();
      }, releaseDelayMs);

      // Process 2 starts and attempts to acquire lock with 15,000ms timeout
      const lock2 = new SingleInstanceLock(lockPath, { timeoutMs: 15_000, retryMs: 100 });
      const startTime = Date.now();

      let lock2Acquired = false;
      let lock2Error = null;
      let release2 = null;

      try {
        release2 = await lock2.acquire();
        lock2Acquired = true;
      } catch (err) {
        lock2Error = err;
      }

      const elapsed = Date.now() - startTime;

      // Clean up lock2 if acquired
      if (release2) await release2();

      // Stress check: did process 2 wait and acquire, or crash immediately?
      assert.strictEqual(
        lock2Error,
        null,
        `Process 2 crashed with ${lock2Error?.code} (${lock2Error?.message}) after ${elapsed}ms instead of waiting for lock release!`
      );
      assert.strictEqual(lock2Acquired, true, 'Process 2 must successfully acquire lock');
      assert.ok(
        elapsed >= releaseDelayMs - 100,
        `Process 2 should have waited at least ${releaseDelayMs}ms, but finished in ${elapsed}ms`
      );
      assert.ok(
        elapsed < 15_000,
        `Process 2 should acquire well before the 15s timeout, took ${elapsed}ms`
      );
    });

    test('recovers stale lock when holding PID is dead (ESRCH)', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-adv-lock-dead-'));
      const lockPath = path.join(tempDir, 'runner.lock');

      // Dead PID check
      const deadPid = 99999999;
      try { process.kill(deadPid, 0); assert.fail('Dead PID unexpectedly exists'); } catch (e) { assert.strictEqual(e.code, 'ESRCH'); }

      fs.writeFileSync(lockPath, JSON.stringify({
        pid: deadPid,
        token: 'dead-token',
        acquiredAt: new Date(Date.now() - 60000).toISOString()
      }) + '\n');

      const lock = new SingleInstanceLock(lockPath, { timeoutMs: 15_000 });
      const release = await lock.acquire();
      assert.strictEqual(lock.locked, true);

      const record = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      assert.strictEqual(record.pid, process.pid);
      await release();
    });

    test('recovers stale lock when lockfile is corrupt/empty and older than staleMs', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-adv-lock-corrupt-'));
      const lockPath = path.join(tempDir, 'runner.lock');

      fs.writeFileSync(lockPath, 'CORRUPT_NOT_JSON');
      // Set mtime to 3 minutes ago (> staleMs 120s)
      const pastTime = (Date.now() - 180_000) / 1000;
      fs.utimesSync(lockPath, pastTime, pastTime);

      const lock = new SingleInstanceLock(lockPath, { timeoutMs: 15_000, staleMs: 120_000 });
      const release = await lock.acquire();
      assert.strictEqual(lock.locked, true);

      const record = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      assert.strictEqual(record.pid, process.pid);
      await release();
    });
  });

  // =========================================================================
  // Challenge 3: Telegram 409 Conflict Handling (Transient vs Persistent)
  // =========================================================================
  describe('Challenge 3: Telegram 409 Conflict Handling', () => {
    test('transient 409: sleeps conflictBackoffMs, logs warning, and recovers polling', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-adv-409-transient-'));
      const lockPath = path.join(tempDir, 'runner.lock');

      let pollCount = 0;
      let sleepCalls = [];

      const customSleep = async (ms) => {
        sleepCalls.push({ ms, timestamp: Date.now() });
      };

      const mockApi = {
        getMe: async () => ({ id: 1, username: 'testbot' }),
        getUpdates: async () => {
          pollCount++;
          if (pollCount === 1) {
            const err = new Error('Conflict: terminated by other getUpdates request');
            err.statusCode = 409;
            err.telegramCode = 409;
            throw err;
          }
          return []; // Subsequent poll succeeds
        },
        sendMessage: async () => ({})
      };

      const errorLogs = [];
      const standardLogs = [];

      await run({
        token: 'test-token',
        userId: '1',
        chatId: '1',
        dataDir: tempDir,
        lockPath,
        api: mockApi,
        maxPolls: 2,
        pollMs: 10,
        conflictBackoffMs: 2000,
        maxConflictRetries: 1,
        sleepFn: customSleep,
        logger: {
          log: msg => standardLogs.push(msg),
          error: msg => errorLogs.push(msg)
        }
      });

      assert.strictEqual(pollCount, 2, 'Must poll twice: 1 initial conflict + 1 recovery poll');

      // Verify sleepFn was called with 2000ms
      assert.ok(
        sleepCalls.some(s => s.ms === 2000),
        `Must have invoked sleepFn with conflictBackoffMs (2000ms), calls: ${JSON.stringify(sleepCalls)}`
      );

      // Verify transient warning was logged
      const transientLog = errorLogs.find(l => l.includes('telegram_conflict_transient'));
      assert.ok(transientLog, 'Must log telegram_conflict_transient event');
      const parsed = JSON.parse(transientLog);
      assert.strictEqual(parsed.code, 'TELEGRAM_CONFLICT_RETRY');
      assert.strictEqual(parsed.retry, 1);
      assert.strictEqual(parsed.backoffMs, 2000);

      // Verify runner did NOT log final fatal telegram_conflict
      assert.ok(!errorLogs.some(l => l.includes('"event":"telegram_conflict"')), 'Must not log fatal telegram_conflict on transient recovery');
    });

    test('persistent 409: retries once, then aborts immediately without endless polling', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-adv-409-persist-'));
      const lockPath = path.join(tempDir, 'runner.lock');

      let pollCount = 0;
      const sleepCalls = [];
      const customSleep = async (ms) => {
        sleepCalls.push(ms);
      };

      const mockApi = {
        getMe: async () => ({ id: 1, username: 'testbot' }),
        getUpdates: async () => {
          pollCount++;
          const err = new Error('Conflict: terminated by other getUpdates request');
          err.statusCode = 409;
          err.telegramCode = 409;
          throw err;
        },
        sendMessage: async () => ({})
      };

      const errorLogs = [];
      let runnerErr = null;

      try {
        await run({
          token: 'test-token',
          userId: '1',
          chatId: '1',
          dataDir: tempDir,
          lockPath,
          api: mockApi,
          maxPolls: 10, // Generous maxPolls to prove it does NOT loop endlessly
          pollMs: 10,
          conflictBackoffMs: 2000,
          maxConflictRetries: 1,
          sleepFn: customSleep,
          logger: {
            log: () => {},
            error: msg => errorLogs.push(msg)
          }
        });
      } catch (err) {
        runnerErr = err;
      }

      assert.ok(runnerErr, 'Runner must reject on persistent 409');
      assert.strictEqual(runnerErr.code, 'TELEGRAM_CONFLICT');
      assert.strictEqual(pollCount, 2, 'Must stop polling after exactly 2 attempts (1 initial + 1 retry)');

      // Verify sleepFn was called once for the retry backoff
      assert.deepStrictEqual(sleepCalls, [2000]);

      // Verify both transient log and final conflict log are present
      assert.ok(errorLogs.some(l => l.includes('telegram_conflict_transient')), 'Must log transient warning');
      assert.ok(errorLogs.some(l => l.includes('"event":"telegram_conflict"')), 'Must log fatal telegram_conflict event');

      // Verify lockfile was cleanly deleted upon abort
      assert.strictEqual(fs.existsSync(lockPath), false, 'Lockfile must be released on abort');
    });

    test('resets conflict retries counter after a successful poll', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-adv-409-reset-'));
      const lockPath = path.join(tempDir, 'runner.lock');

      let pollCount = 0;
      const mockApi = {
        getMe: async () => ({ id: 1, username: 'testbot' }),
        getUpdates: async () => {
          pollCount++;
          // Poll 1: 409 Conflict
          if (pollCount === 1) {
            const err = new Error('Conflict');
            err.statusCode = 409;
            throw err;
          }
          // Poll 2: Success
          if (pollCount === 2) {
            return [];
          }
          // Poll 3: 409 Conflict again (should retry again because Poll 2 succeeded)
          if (pollCount === 3) {
            const err = new Error('Conflict');
            err.statusCode = 409;
            throw err;
          }
          // Poll 4: Success
          return [];
        },
        sendMessage: async () => ({})
      };

      const errorLogs = [];
      await run({
        token: 'test-token',
        userId: '1',
        chatId: '1',
        dataDir: tempDir,
        lockPath,
        api: mockApi,
        maxPolls: 4, // 1 (409 retry 1), 2 (success, reset), 3 (409 retry 1 again), 4 (success)
        pollMs: 10,
        conflictBackoffMs: 10,
        maxConflictRetries: 1,
        sleepFn: async () => {},
        logger: { log: () => {}, error: msg => errorLogs.push(msg) }
      });

      assert.strictEqual(pollCount, 4, 'Must complete 4 polls without aborting on 409');
      const transientLogs = errorLogs.filter(l => l.includes('telegram_conflict_transient'));
      assert.strictEqual(transientLogs.length, 2, 'Must log transient conflict warning twice (once per reset cycle)');
      assert.ok(!errorLogs.some(l => l.includes('"event":"telegram_conflict"')), 'Must never escalate to fatal conflict');
    });

    test('non-409 network error does not trigger conflict backoff logic', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-adv-500-'));
      const lockPath = path.join(tempDir, 'runner.lock');

      let pollCount = 0;
      const sleepCalls = [];

      const mockApi = {
        getMe: async () => ({ id: 1, username: 'testbot' }),
        getUpdates: async () => {
          pollCount++;
          if (pollCount === 1) {
            const err = new Error('Internal Server Error');
            err.statusCode = 500;
            throw err;
          }
          return [];
        },
        sendMessage: async () => ({})
      };

      const errorLogs = [];
      await run({
        token: 'test-token',
        userId: '1',
        chatId: '1',
        dataDir: tempDir,
        lockPath,
        api: mockApi,
        maxPolls: 2,
        pollMs: 10,
        conflictBackoffMs: 2000,
        sleepFn: async ms => sleepCalls.push(ms),
        logger: { log: () => {}, error: msg => errorLogs.push(msg) }
      });

      assert.strictEqual(pollCount, 2);
      assert.ok(!errorLogs.some(l => l.includes('telegram_conflict_transient')), '500 error must not log conflict transient');
      assert.deepStrictEqual(sleepCalls, [10], 'Must sleep normal pollMs (10ms), not conflictBackoffMs (2000ms)');
    });
  });
});
