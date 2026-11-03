'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const { SingleInstanceLock, run } = require(path.join(ROOT, 'src/runner'));
const { SqliteStore } = require(path.join(ROOT, 'src/sqliteStore'));

const LIVE_LOCK_PATH = path.join(ROOT, 'data/telegram-runner.lock');
const LIVE_DB_PATH = path.join(ROOT, 'data/state.sqlite');

describe('Empirical Adversarial Challenge M2: Process Lock & State Concurrency', () => {

  describe('Objective 1: SingleInstanceLock Mutual Exclusion & Immunity', () => {

    test('independent test process fails cleanly when attempting to acquire live daemon lock', async () => {
      // Ensure live lock exists
      assert.ok(fs.existsSync(LIVE_LOCK_PATH), 'Live lockfile must exist');
      const lockStatBefore = fs.statSync(LIVE_LOCK_PATH);
      const lockRawBefore = fs.readFileSync(LIVE_LOCK_PATH, 'utf8');
      const lockDataBefore = JSON.parse(lockRawBefore);
      assert.ok(lockDataBefore.pid > 0, 'Live lock must record active PID');

      const secondaryLock = new SingleInstanceLock(LIVE_LOCK_PATH, { timeoutMs: 0 });
      const t0 = Date.now();

      let caughtError = null;
      try {
        await secondaryLock.acquire();
      } catch (err) {
        caughtError = err;
      }

      const elapsed = Date.now() - t0;
      assert.ok(caughtError, 'Secondary lock acquisition must throw');
      assert.strictEqual(caughtError.code, 'INSTANCE_LOCKED');
      assert.strictEqual(caughtError.pid, lockDataBefore.pid);
      assert.match(caughtError.message, /Telegram runner lock is held by PID/);
      assert.ok(elapsed < 1000, `Expected fast fail, took ${elapsed}ms`);

      // Verify lockfile was not touched or corrupted
      const lockStatAfter = fs.statSync(LIVE_LOCK_PATH);
      const lockRawAfter = fs.readFileSync(LIVE_LOCK_PATH, 'utf8');
      assert.strictEqual(lockStatAfter.ino, lockStatBefore.ino, 'Inode must remain identical');
      assert.strictEqual(lockRawAfter, lockRawBefore, 'Lock content must be unmodified');

      // Verify daemon PID is still alive
      let pidAlive = false;
      try { process.kill(lockDataBefore.pid, 0); pidAlive = true; } catch {}
      assert.strictEqual(pidAlive, true, 'Live daemon process must remain alive');
    });

    test('multi-process concurrent acquisition attack: all workers cleanly rejected with zero lock displacement', async () => {
      const lockRaw = fs.readFileSync(LIVE_LOCK_PATH, 'utf8');
      const expectedPid = JSON.parse(lockRaw).pid;
      const initialSha = crypto.createHash('sha256').update(lockRaw).digest('hex');

      const CONCURRENCY = 10;
      const workerPromises = Array.from({ length: CONCURRENCY }, (_, i) => {
        return new Promise(resolve => {
          const script = `
            const { SingleInstanceLock } = require('${path.join(ROOT, 'src/runner')}');
            const lock = new SingleInstanceLock(process.argv[1], { timeoutMs: 2000 });
            lock.acquire()
              .then(() => { process.stdout.write(JSON.stringify({ acquired: true })); })
              .catch(err => {
                process.stdout.write(JSON.stringify({
                  acquired: false,
                  code: err.code,
                  pid: err.pid
                }));
              });
          `;
          const child = spawn(process.execPath, ['-e', script, LIVE_LOCK_PATH], { stdio: ['ignore', 'pipe', 'pipe'] });
          let out = '';
          child.stdout.on('data', d => out += d);
          child.on('close', code => {
            try {
              resolve({ code, data: JSON.parse(out) });
            } catch (e) {
              resolve({ code, error: e.message, out });
            }
          });
        });
      });

      const results = await Promise.all(workerPromises);
      assert.strictEqual(results.length, CONCURRENCY);

      for (const res of results) {
        assert.strictEqual(res.code, 0, 'Child process must exit cleanly');
        assert.strictEqual(res.data.acquired, false, 'No secondary child must acquire lock');
        assert.strictEqual(res.data.code, 'INSTANCE_LOCKED');
        assert.strictEqual(res.data.pid, expectedPid);
      }

      // Check SHA256 of lockfile remained unchanged
      const currentRaw = fs.readFileSync(LIVE_LOCK_PATH, 'utf8');
      const currentSha = crypto.createHash('sha256').update(currentRaw).digest('hex');
      assert.strictEqual(currentSha, initialSha, 'Lockfile SHA256 must be identical after multi-process stress');
    });

    test('run() entry point fails immediately and does not invoke Telegram polling API when lock is held', async () => {
      let apiCalled = false;
      const mockApi = {
        getMe: async () => { apiCalled = true; return { id: 999 }; },
        getUpdates: async () => { apiCalled = true; return []; }
      };

      let error = null;
      try {
        await run({
          token: 'm2-challenge-token',
          userId: '1',
          chatId: '1',
          dataDir: path.join(ROOT, 'data'),
          lockPath: LIVE_LOCK_PATH,
          lockTimeoutMs: 1500,
          api: mockApi,
          logger: { log: () => {}, error: () => {} }
        });
      } catch (err) {
        error = err;
      }

      assert.ok(error, 'run() must throw');
      assert.strictEqual(error.code, 'INSTANCE_LOCKED');
      assert.strictEqual(apiCalled, false, 'Telegram API must not be called when lock is held');
    });
  });

  describe('Objective 2: Concurrent SQLite State Access & Zero Contention', () => {
    const os = require('node:os');
    let tempDir = null;
    let testDbPath = null;
    const TEST_ITEM_COUNT = 4455;

    before(async () => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm2-concurrency-'));
      testDbPath = path.join(tempDir, 'state.sqlite');
      const items = Array.from({ length: TEST_ITEM_COUNT }, (_, i) => ({ id: `item-${i}` }));
      const store = new SqliteStore(testDbPath, { items });
      await store.load();
      await store.close();
    });

    after(() => {
      if (tempDir && fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    test('rapid multi-process concurrent reads experience zero SQLITE_BUSY or lock contention errors', async () => {
      const NUM_PROCESSES = 8;
      const READS_PER_PROCESS = 25;

      const workers = Array.from({ length: NUM_PROCESSES }, (_, procIndex) => {
        return new Promise(resolve => {
          const script = `
            const { DatabaseSync } = require('node:sqlite');
            const db = new DatabaseSync(process.argv[1]);
            const stmt = db.prepare('SELECT id, revision, length(json) as len, json FROM state WHERE id = 1');
            let busyCount = 0;
            let successCount = 0;
            const errors = [];
            for (let i = 0; i < ${READS_PER_PROCESS}; i++) {
              try {
                const row = stmt.get();
                if (row && row.id === 1 && row.revision >= 0 && row.json) {
                  const parsed = JSON.parse(row.json);
                  if (Array.isArray(parsed.items) && parsed.items.length === ${TEST_ITEM_COUNT}) {
                    successCount++;
                  } else {
                    errors.push('Item count mismatch: ' + parsed.items?.length);
                  }
                } else {
                  errors.push('Invalid row');
                }
              } catch (err) {
                if (err.message && err.message.includes('busy')) busyCount++;
                errors.push(err.code + ': ' + err.message);
              }
            }
            db.close();
            process.stdout.write(JSON.stringify({ successCount, busyCount, errors }));
          `;
          const child = spawn(process.execPath, ['-e', script, testDbPath], { stdio: ['ignore', 'pipe', 'pipe'] });
          let out = '';
          child.stdout.on('data', d => out += d);
          child.on('close', code => {
            try {
              resolve({ code, data: JSON.parse(out) });
            } catch (e) {
              resolve({ code, error: e.message, out });
            }
          });
        });
      });

      const results = await Promise.all(workers);
      let totalSuccess = 0;
      let totalBusy = 0;
      const allErrors = [];

      for (const res of results) {
        assert.strictEqual(res.code, 0, 'Worker must exit with 0');
        totalSuccess += res.data.successCount;
        totalBusy += res.data.busyCount;
        if (res.data.errors.length) allErrors.push(...res.data.errors);
      }

      assert.strictEqual(totalSuccess, NUM_PROCESSES * READS_PER_PROCESS, 'All reads must succeed');
      assert.strictEqual(totalBusy, 0, 'Must have exactly zero SQLITE_BUSY errors');
      assert.strictEqual(allErrors.length, 0, 'Must have zero read errors');
    });

    test('SqliteStore concurrent load calls serialize cleanly and preserve state integrity', async () => {
      const store = new SqliteStore(testDbPath);
      const CONCURRENCY = 20;

      const reads = Array.from({ length: CONCURRENCY }, () => store.load());
      const states = await Promise.all(reads);

      assert.strictEqual(states.length, CONCURRENCY);
      for (const s of states) {
        assert.ok(s, 'State must be non-null');
        assert.strictEqual(Array.isArray(s.items), true);
        assert.strictEqual(s.items.length, TEST_ITEM_COUNT);
      }
      await store.close();
    });

    test('DatabaseSync read-only mode executes cleanly with PRAGMA journal_mode=WAL', () => {
      const db = new DatabaseSync(testDbPath, { readOnly: true });
      const pragmaWal = db.prepare('PRAGMA journal_mode').get();
      assert.strictEqual(pragmaWal.journal_mode, 'wal');

      const integrity = db.prepare('PRAGMA integrity_check').get();
      assert.strictEqual(integrity.integrity_check, 'ok');

      const row = db.prepare('SELECT id, revision FROM state WHERE id = 1').get();
      assert.strictEqual(row.id, 1);
      assert.ok(row.revision >= 0);

      db.close();
    });
  });
});
