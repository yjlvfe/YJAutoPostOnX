'use strict';
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  SessionGuardRegistry,
  resetSessionsForTest,
  acquireSession,
  countActiveSessions,
  MAX_PROJECT_SESSIONS
} = require('../src/sessionGuard');

describe('M14: Session Guard Hardening & Path Safety Regression Tests', () => {
  let tempDir;
  let testDbPath;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm14-sg-hardening-'));
    testDbPath = path.join(tempDir, 'leases.sqlite');
    process.env.SESSION_GUARD_DB_PATH = testDbPath;
  });

  after(() => {
    delete process.env.SESSION_GUARD_DB_PATH;
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    resetSessionsForTest(testDbPath);
  });

  it('1. resetSessionsForTest throws CUSTOM_PATH_REQUIRED when called without path', () => {
    assert.throws(
      () => resetSessionsForTest(),
      err => {
        assert.strictEqual(err.code, 'RESET_CUSTOM_PATH_REQUIRED');
        return true;
      }
    );
  });

  it('2. resetSessionsForTest throws PROD_PATH_RESET_FORBIDDEN when targeting production DB path', () => {
    const prodPath = path.resolve(__dirname, '../data/session_leases.sqlite');
    assert.throws(
      () => resetSessionsForTest(prodPath),
      err => {
        assert.strictEqual(err.code, 'PROD_PATH_RESET_FORBIDDEN');
        return true;
      }
    );
  });

  it('3. resetSessionsForTest throws TEMP_DIR_REQUIRED when path is outside temporary directory', () => {
    const nonTempPath = '/etc/session_leases.sqlite';
    assert.throws(
      () => resetSessionsForTest(nonTempPath),
      err => {
        assert.strictEqual(err.code, 'TEMP_DIR_REQUIRED');
        return true;
      }
    );
  });

  it('4. resetSessionsForTest throws SYMLINK_RESET_FORBIDDEN when target is a symlink', () => {
    const realTarget = path.join(tempDir, 'real.sqlite');
    fs.writeFileSync(realTarget, 'data');
    const symlinkPath = path.join(tempDir, 'symlink_lease.sqlite');
    fs.symlinkSync(realTarget, symlinkPath);

    assert.throws(
      () => resetSessionsForTest(symlinkPath),
      err => {
        assert.strictEqual(err.code, 'SYMLINK_RESET_FORBIDDEN');
        return true;
      }
    );

    // Verify realTarget was NOT deleted!
    assert.ok(fs.existsSync(realTarget), 'Real file behind symlink must NOT be deleted');
  });

  it('5. PID reuse resistance: PID with recycled non-node cmdline is treated as dead and reconciled', () => {
    const reg = new SessionGuardRegistry(testDbPath);
    // Find or simulate a PID whose cmdline is NOT 'node' (e.g. PID 1 /sbin/init or systemd)
    const nonNodePid = 1;
    reg.db.prepare(`
      INSERT INTO session_leases (lease_id, account_id, session_key, node_pid, child_pid, acquired_at, heartbeat_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('recycled_lease_1', 'acc_rec', 'key_rec', nonNodePid, null, Date.now() - 5000, Date.now() - 5000);

    // Since PID 1 is init/systemd and not node, reconcileOrphans must recognize it as dead owning node process!
    assert.strictEqual(reg.countActive(), 0, 'Recycled non-node PID must be pruned as orphan');
    reg.close();
  });

  it('6. Saturated capacity: 6th acquisition attempt denied fail-closed without spawning workers', () => {
    const leases = [];
    for (let i = 0; i < MAX_PROJECT_SESSIONS; i++) {
      leases.push(acquireSession({ accountId: `sat_${i}` }));
    }
    assert.strictEqual(countActiveSessions(), 5);

    assert.throws(
      () => acquireSession({ accountId: 'sat_6_attempt' }),
      err => {
        assert.strictEqual(err.code, 'MAX_PROJECT_SESSIONS_EXCEEDED');
        assert.strictEqual(err.activeCount, 5);
        assert.strictEqual(err.maxLimit, 5);
        return true;
      }
    );

    leases.forEach(l => l.release());
    assert.strictEqual(countActiveSessions(), 0);
  });
});
