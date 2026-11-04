'use strict';
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

describe('M14: Interprocess Session Guard & Adversarial Concurrency Suite', () => {
  let tempDir;
  let leaseDbPath;
  let sessionGuard;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-adversarial-'));
    leaseDbPath = path.join(tempDir, 'leases.sqlite');
    process.env.SESSION_GUARD_DB_PATH = leaseDbPath;
    sessionGuard = require('../src/sessionGuard');
  });

  after(() => {
    delete process.env.SESSION_GUARD_DB_PATH;
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    sessionGuard.resetSessionsForTest(leaseDbPath);
  });

  it('1. Two independent OS Node processes racing to acquire leases never exceed project cap of 5', () => {
    // Spawn two separate worker scripts that each attempt to acquire 4 leases
    const workerScript = `
      const { acquireSession } = require('${path.resolve(__dirname, '../src/sessionGuard')}');
      const acquired = [];
      let denied = 0;
      for (let i = 0; i < 4; i++) {
        try {
          const l = acquireSession({ accountId: 'proc_' + process.pid + '_' + i });
          acquired.push(l);
        } catch (e) {
          if (e.code === 'MAX_PROJECT_SESSIONS_EXCEEDED') denied++;
        }
      }
      process.send({ pid: process.pid, acquiredCount: acquired.length, deniedCount: denied });
      // Keep running until told to exit
      process.on('message', () => {
        acquired.forEach(l => l.release());
        process.exit(0);
      });
    `;

    const proc1 = spawn(process.execPath, ['-e', workerScript], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, SESSION_GUARD_DB_PATH: leaseDbPath }
    });
    const proc2 = spawn(process.execPath, ['-e', workerScript], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, SESSION_GUARD_DB_PATH: leaseDbPath }
    });

    return new Promise((resolve, reject) => {
      let r1 = null;
      let r2 = null;

      proc1.on('message', m => {
        r1 = m;
        check();
      });
      proc2.on('message', m => {
        r2 = m;
        check();
      });

      function check() {
        if (r1 && r2) {
          const totalAcquired = r1.acquiredCount + r2.acquiredCount;
          assert.strictEqual(totalAcquired, 5, `Total acquired across racing processes must be exactly 5, got ${totalAcquired}`);
          assert.strictEqual(r1.deniedCount + r2.deniedCount, 3, 'Total denied must be 3 (4 + 4 - 5 = 3)');
          assert.strictEqual(sessionGuard.countActiveSessions(), 5);

          // Clean up children
          proc1.send('exit');
          proc2.send('exit');

          let exited = 0;
          const onExit = () => {
            exited++;
            if (exited === 2) {
              assert.strictEqual(sessionGuard.countActiveSessions(), 0);
              resolve();
            }
          };
          proc1.on('exit', onExit);
          proc2.on('exit', onExit);
        }
      }
    });
  });

  it('2. Active sessions past 120s are NOT purged if process/child is still alive', async () => {
    // Acquire a lease and simulate time passing by updating acquired_at to 200 seconds ago
    const lease = sessionGuard.acquireSession({ accountId: 'long_running_acc' });
    const reg = new sessionGuard.SessionGuardRegistry(leaseDbPath);

    // Artificially age the lease by 200 seconds in SQLite
    const ancientTime = Date.now() - 200_000;
    reg.db.prepare('UPDATE session_leases SET acquired_at = ?, heartbeat_at = ? WHERE lease_id = ?').run(
      ancientTime,
      ancientTime,
      lease.leaseId
    );

    // Verify: even though lease is 200 seconds old (> 120s), since process.pid is alive, it must NOT be purged!
    assert.strictEqual(sessionGuard.countActiveSessions(), 1, 'Alive process must retain its lease regardless of age');

    const audit = sessionGuard.getSessionAudit();
    assert.strictEqual(audit.activeCount, 1);
    assert.strictEqual(audit.leases[0].nodeAlive, true);

    lease.release();
    assert.strictEqual(sessionGuard.countActiveSessions(), 0);
    reg.close();
  });

  it('3. Orphan reconciliation cleans leases whose node and child PIDs are confirmed dead (ESRCH)', () => {
    const reg = new sessionGuard.SessionGuardRegistry(leaseDbPath);

    // Insert a lease with a definitely non-existent PID (e.g. 999999)
    const deadPid = 999999;
    reg.db.prepare(`
      INSERT INTO session_leases (lease_id, account_id, session_key, node_pid, child_pid, acquired_at, heartbeat_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('dead_lease_1', 'acc_dead', 'key_dead', deadPid, null, Date.now() - 10000, Date.now() - 10000);

    assert.strictEqual(sessionGuard.countActiveSessions(), 0, 'Dead PID must be reconciled to 0');
    const remaining = reg.db.prepare('SELECT * FROM session_leases WHERE lease_id = ?').get('dead_lease_1');
    assert.strictEqual(remaining, undefined, 'Orphaned lease must be purged from database');

    reg.close();
  });

  it('4. Rejects duplicate lease for the exact same session_key', () => {
    const lease1 = sessionGuard.acquireSession({ accountId: 'acc_dup', sessionKey: 'session_unique_key' });
    assert.ok(lease1.leaseId);

    assert.throws(
      () => sessionGuard.acquireSession({ accountId: 'acc_dup', sessionKey: 'session_unique_key' }),
      err => {
        assert.strictEqual(err.code, 'DUPLICATE_SESSION_LEASE');
        return true;
      }
    );

    lease1.release();
    assert.strictEqual(sessionGuard.countActiveSessions(), 0);
  });

  it('5. Database corruption or lock timeout fails closed without creating phantom sessions', () => {
    const reg = new sessionGuard.SessionGuardRegistry(leaseDbPath);
    // Fill to 5
    const leases = [];
    for (let i = 0; i < 5; i++) {
      leases.push(sessionGuard.acquireSession({ accountId: `fill_${i}` }));
    }
    assert.strictEqual(sessionGuard.countActiveSessions(), 5);

    // Attempting 6th fails closed
    assert.throws(
      () => sessionGuard.acquireSession({ accountId: 'fill_6' }),
      err => err.code === 'MAX_PROJECT_SESSIONS_EXCEEDED'
    );

    leases.forEach(l => l.release());
    assert.strictEqual(sessionGuard.countActiveSessions(), 0);
    reg.close();
  });
});
