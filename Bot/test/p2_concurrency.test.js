'use strict';

/**
 * Phase P2 Concurrency & Network Safety Test Suite.
 *
 * Findings Covered:
 * 1. FINDING-004 & FINDING-005: Telegram multi-instance concurrency simulation.
 *    - Mutual exclusion: Two processes attempting to acquire SingleInstanceLock
 *      concurrently cannot both acquire the lock.
 *    - Unconditional lock removal bug (FINDING-005): Demonstrates how removing the
 *      lock while a process is alive defeats singleton enforcement, allowing a 2nd
 *      process to acquire the lock and run concurrently (FINDING-004), and reveals
 *      that the living process lacks any detection of lock loss.
 *    - Child process multi-instance concurrency reproduction.
 *
 * 2. FINDING-018: Socket read timeout mismatch in `telegramApi.js`.
 *    - Pre-fix defect demonstration: When client timeoutMs is less than the server's
 *      long-polling hold time, the client prematurely aborts with `TELEGRAM_TIMEOUT`.
 *    - Post-fix verification: `telegramApi.js` dynamically adapts `timeoutMs` for
 *      `getUpdates` to `Math.max(options.timeoutMs || 30_000, (params.timeout + 15) * 1000)`.
 *
 * Safety Contract:
 * - Does NOT interact with or restart yj-telegram-bot.service (PID 289644).
 * - All tests use isolated temporary directories and local ephemeral mock servers.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { fork } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const { SingleInstanceLock } = require(path.join(ROOT, 'src/runner'));
const { createTelegramApi, request } = require(path.join(ROOT, 'src/telegramApi'));

describe('FINDING-004 & FINDING-005: Telegram Multi-Instance Concurrency & Lock Removal', () => {
  let tempDir;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-concurrency-test-'));
  });

  after(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {}
  });

  test('Mutual exclusion: two instances cannot both acquire SingleInstanceLock simultaneously', async () => {
    const lockPath = path.join(tempDir, 'singleton.lock');
    const lock1 = new SingleInstanceLock(lockPath, { timeoutMs: 500, retryMs: 20 });
    const lock2 = new SingleInstanceLock(lockPath, { timeoutMs: 200, retryMs: 20 });

    // Instance 1 acquires the lock
    const release1 = await lock1.acquire();
    assert.strictEqual(lock1.locked, true, 'Instance 1 must report locked=true');
    assert.strictEqual(fs.existsSync(lockPath), true, 'Lock file must exist on disk');

    const lockData = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.strictEqual(lockData.pid, process.pid, 'Lock record must store acquiring process PID');
    assert.ok(lockData.token, 'Lock record must have an acquisition token');

    // Instance 2 attempts to acquire the lock concurrently
    let lock2Error = null;
    try {
      await lock2.acquire();
    } catch (err) {
      lock2Error = err;
    }

    assert.ok(lock2Error, 'Instance 2 must fail to acquire an actively held lock');
    assert.strictEqual(lock2Error.code, 'INSTANCE_LOCKED', 'Instance 2 must throw INSTANCE_LOCKED');
    assert.strictEqual(lock2.locked, false, 'Instance 2 must report locked=false');

    // Instance 1 releases the lock
    const released = await release1();
    assert.strictEqual(released, true, 'Instance 1 release must succeed');
    assert.strictEqual(lock1.locked, false, 'Instance 1 must report locked=false after release');
    assert.strictEqual(fs.existsSync(lockPath), false, 'Lock file must be deleted after clean release');
  });

  test('FINDING-005 reproducer: Unconditional lock removal defeats singleton and allows concurrent instances (FINDING-004)', async () => {
    const lockPath = path.join(tempDir, 'rm_f_simulation.lock');
    const lock1 = new SingleInstanceLock(lockPath, { timeoutMs: 500, retryMs: 20 });
    const lock2 = new SingleInstanceLock(lockPath, { timeoutMs: 500, retryMs: 20 });

    // 1. Instance 1 acquires the lock and is running
    const release1 = await lock1.acquire();
    assert.strictEqual(lock1.locked, true, 'Instance 1 acquired the lock');
    const token1 = lock1.token;

    // 2. Simulate systemd ExecStartPre=/bin/rm -f telegram-runner.lock while Instance 1 is alive
    console.log('\n[FINDING-005 Simulation] Executing unconditional lock removal (rm -f) while Instance 1 is alive...');
    fs.unlinkSync(lockPath);
    assert.strictEqual(fs.existsSync(lockPath), false, 'Lock file unlinked externally');

    // Verify Instance 1 status: Notice that Instance 1 has NO mechanism detecting that its lock was deleted!
    assert.strictEqual(lock1.locked, true, 'Defect: Instance 1 still assumes it holds the lock without knowing it was deleted');

    // 3. Instance 2 starts up and tries to acquire the lock
    console.log('[FINDING-004 Simulation] Instance 2 attempting to acquire lock after unconditional rm -f...');
    const release2 = await lock2.acquire();
    assert.strictEqual(lock2.locked, true, 'Instance 2 successfully acquired the lock because file was unlinked!');
    const token2 = lock2.token;

    // 4. CRITICAL REPRODUCTION: Both instances are now concurrently active!
    assert.notStrictEqual(token1, token2, 'Two different instance tokens coexist');
    assert.strictEqual(lock1.locked, true, 'Instance 1 believes it is running');
    assert.strictEqual(lock2.locked, true, 'Instance 2 believes it is running');
    console.log('[FINDING-004 / FINDING-005 Confirmed] Multi-instance collision! Both Instance 1 & 2 believe they hold the lock simultaneously.');

    // 5. Test release behavior when lock was stolen:
    // When Instance 1 tries to release, it detects that the lock on disk does not belong to it
    const releaseResult1 = await release1();
    assert.strictEqual(releaseResult1, false, 'Instance 1 release() returns false because token on disk belongs to Instance 2');
    assert.strictEqual(fs.existsSync(lockPath), true, 'Lock file still preserved for Instance 2');

    // Clean up Instance 2
    const releaseResult2 = await release2();
    assert.strictEqual(releaseResult2, true, 'Instance 2 clean release succeeds');
    assert.strictEqual(fs.existsSync(lockPath), false, 'Lock file removed after Instance 2 release');
  });

  test('Multi-process simulation: child process concurrency and lock removal collision', async () => {
    const lockPath = path.join(tempDir, 'child_process.lock');
    const workerScript = path.join(tempDir, 'worker.js');

    // Create worker helper script
    fs.writeFileSync(workerScript, `
      const { SingleInstanceLock } = require('${path.join(ROOT, 'src/runner')}');
      const lockPath = process.argv[2];
      const timeoutMs = Number(process.argv[3]) || 500;
      const lock = new SingleInstanceLock(lockPath, { timeoutMs, retryMs: 20 });

      (async () => {
        try {
          await lock.acquire();
          process.send({ event: 'ACQUIRED', pid: process.pid, token: lock.token });
          // Stay alive until told to exit
          process.on('message', async (msg) => {
            if (msg === 'RELEASE') {
              const res = await lock.release();
              process.send({ event: 'RELEASED', success: res });
              process.exit(0);
            }
          });
        } catch (err) {
          process.send({ event: 'ERROR', code: err.code, message: err.message });
          process.exit(1);
        }
      })();
    `);

    // Helper to spawn worker
    function spawnWorker(timeoutMs) {
      return new Promise((resolve) => {
        const child = fork(workerScript, [lockPath, String(timeoutMs)], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
        let resolved = false;
        child.on('message', (msg) => {
          if (!resolved) {
            resolved = true;
            resolve({ child, msg });
          }
        });
      });
    }

    // 1. Child 1 acquires lock
    const worker1 = await spawnWorker(1000);
    assert.strictEqual(worker1.msg.event, 'ACQUIRED');
    console.log(`\n[Child Worker 1] Lock acquired by Child PID: ${worker1.msg.pid}`);

    // 2. Child 2 tries to acquire lock while Child 1 is running -> fails with INSTANCE_LOCKED
    const worker2 = await spawnWorker(200);
    assert.strictEqual(worker2.msg.event, 'ERROR');
    assert.strictEqual(worker2.msg.code, 'INSTANCE_LOCKED');
    console.log('[Child Worker 2] Correctly rejected with INSTANCE_LOCKED while Child 1 is alive');

    // 3. Simulate rm -f lockPath while Child 1 is still alive
    console.log('[Simulation] External rm -f lockPath executed while Child 1 is running...');
    fs.unlinkSync(lockPath);

    // 4. Child 3 tries to acquire lock -> SUCCEEDS!
    const worker3 = await spawnWorker(1000);
    assert.strictEqual(worker3.msg.event, 'ACQUIRED');
    console.log(`[Child Worker 3] Acquired lock (PID: ${worker3.msg.pid}) despite Child 1 still running!`);

    // Both Child 1 and Child 3 are alive simultaneously
    assert.ok(worker1.child.connected, 'Child 1 is still connected and running');
    assert.ok(worker3.child.connected, 'Child 3 is still connected and running');
    console.log('[Multi-Process Defect Confirmed] Concurrent Telegram runner processes running simultaneously!');

    // Clean up children
    worker1.child.kill('SIGKILL');
    worker3.child.kill('SIGKILL');
  });

  test('Crash recovery: SingleInstanceLock recovers lock when recorded PID is dead', async () => {
    const lockPath = path.join(tempDir, 'dead_pid.lock');
    // Write a lock file with a non-existent dead PID (e.g. 9999999)
    const deadPid = 9999999;
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: deadPid,
      token: 'dead-process-token',
      acquiredAt: new Date(Date.now() - 60000).toISOString()
    }) + '\n');

    const lock = new SingleInstanceLock(lockPath, { timeoutMs: 500, retryMs: 20 });
    const release = await lock.acquire();

    assert.strictEqual(lock.locked, true, 'Lock must be acquired by recovering dead process lock');
    const newRecord = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.strictEqual(newRecord.pid, process.pid, 'New record must reflect current live PID');

    await release();
    assert.strictEqual(fs.existsSync(lockPath), false, 'Lock must be cleaned up');
  });
});

describe('FINDING-018: Telegram Polling Socket Read Timeout Mismatch in telegramApi.js', () => {
  let mockServer;
  let serverPort;
  let serverUrl;

  before(async () => {
    mockServer = http.createServer((req, res) => {
      let bodyStr = '';
      req.on('data', chunk => { bodyStr += chunk; });
      req.on('end', () => {
        let params = {};
        try { params = JSON.parse(bodyStr); } catch (_) {}

        if (req.url.includes('getUpdates')) {
          // If long-polling timeout is specified (e.g. timeout: 1 second = 1000ms),
          // simulate server holding connection for 350ms before returning empty updates.
          const serverHoldMs = params.timeout ? Math.min(params.timeout * 350, 400) : 0;
          setTimeout(() => {
            if (!res.writableEnded) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, result: [] }));
            }
          }, serverHoldMs);
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result: {} }));
        }
      });
    });

    await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', () => {
      serverPort = mockServer.address().port;
      serverUrl = `http://127.0.0.1:${serverPort}`;
      resolve();
    }));
  });

  after(async () => {
    if (mockServer) {
      await new Promise(resolve => mockServer.close(resolve));
    }
  });

  test('Pre-fix defect reproducer: unadapted socket timeout less than server long poll causes TELEGRAM_TIMEOUT', async () => {
    // In pre-fix telegramApi.js (commit 8c8d075), transfer() received a fixed timeoutMs (default 30,000ms or options.timeoutMs)
    // without scaling for params.timeout.
    // If a request had a socket timeout of 100ms while the server held for 350ms,
    // the Node client-side deadline fired at 100ms and threw TELEGRAM_TIMEOUT.
    const unadaptedTransfer = (timeoutMs) => {
      return new Promise((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1', port: serverPort, path: '/botfake/getUpdates',
          method: 'POST', headers: { 'content-type': 'application/json' },
          timeout: timeoutMs
        }, res => {
          res.on('data', () => {});
          res.on('end', () => resolve({ ok: true }));
        });
        const timer = setTimeout(() => {
          req.destroy(Object.assign(new Error('Telegram API timeout'), { code: 'TELEGRAM_TIMEOUT', ambiguous: true }));
        }, timeoutMs);
        req.on('error', err => {
          clearTimeout(timer);
          reject(err);
        });
        req.end(JSON.stringify({ offset: 0, timeout: 1 }));
      });
    };

    let caughtError = null;
    const start = Date.now();
    try {
      await unadaptedTransfer(100); // 100ms < 350ms server hold
    } catch (err) {
      caughtError = err;
    }
    const elapsed = Date.now() - start;

    console.log(`\n[FINDING-018 Pre-fix Defect] elapsed=${elapsed}ms, caught error:`, caughtError?.code, caughtError?.message);

    assert.ok(caughtError, 'Unadapted socket timeout must fail before server responds');
    assert.strictEqual(caughtError.code, 'TELEGRAM_TIMEOUT');
    assert.strictEqual(caughtError.ambiguous, true);
    assert.ok(elapsed >= 90 && elapsed < 300, `Timeout must fire near 100ms (actual: ${elapsed}ms)`);
  });

  test('Post-fix verification: telegramApi.js dynamically adapts timeoutMs for getUpdates', async () => {
    let capturedMeta = null;
    const mockRequest = (method, params, meta) => {
      capturedMeta = { method, params, meta };
      return { ok: true, result: [] };
    };

    // Case 1: 50s poll timeout -> timeoutMs should be at least (50 + 15) * 1000 = 65_000 ms
    await request('fake-token', 'getUpdates', { timeout: 50 }, { request: mockRequest });
    assert.strictEqual(capturedMeta.meta.timeoutMs, 65_000);

    // Case 2: 25s poll timeout -> timeoutMs should be (25 + 15) * 1000 = 40_000 ms
    await request('fake-token', 'getUpdates', { timeout: 25 }, { request: mockRequest });
    assert.strictEqual(capturedMeta.meta.timeoutMs, 40_000);

    // Case 3: 0s poll timeout -> Math.max(30_000, 15_000) = 30_000 ms
    await request('fake-token', 'getUpdates', { timeout: 0 }, { request: mockRequest });
    assert.strictEqual(capturedMeta.meta.timeoutMs, 30_000);

    // Case 4: explicit options.timeoutMs higher than formula -> Math.max(80_000, 65_000) = 80_000 ms
    await request('fake-token', 'getUpdates', { timeout: 50 }, { timeoutMs: 80_000, request: mockRequest });
    assert.strictEqual(capturedMeta.meta.timeoutMs, 80_000);

    // Case 5: non-getUpdates method (sendMessage) does not apply poll timeout adaptation
    await request('fake-token', 'sendMessage', { chat_id: 123, text: 'hi', timeout: 50 }, { timeoutMs: 10_000, request: mockRequest });
    assert.strictEqual(capturedMeta.meta.timeoutMs, 10_000);

    console.log('[FINDING-018 Fixed Verification] request() successfully adapts timeoutMs for all long-polling scenarios!');
  });

  test('Post-fix verification: createTelegramApi delegates getUpdates cleanly across live HTTP transfer', async () => {
    const api = createTelegramApi('test-token', { baseUrl: serverUrl });
    const updates = await api.getUpdates({ timeout: 1 });
    assert.strictEqual(Array.isArray(updates), true);
    assert.strictEqual(updates.length, 0);
    console.log('[FINDING-018 Fixed Verification] createTelegramApi successfully completed long-poll without premature timeout!');
  });
});
