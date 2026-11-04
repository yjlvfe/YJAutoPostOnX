'use strict';
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  MAX_PROJECT_SESSIONS,
  acquireSession,
  countActiveSessions,
  getSessionAudit,
  resetSessionsForTest
} = require('../src/sessionGuard');

describe('Session Cap Guard & 5-Session Strict Ceiling', () => {
  let tempDir;
  let testDbPath;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm13-sg-ceiling-'));
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

  it('1. permits up to exactly 5 concurrent sessions', () => {
    const leases = [];
    for (let i = 0; i < MAX_PROJECT_SESSIONS; i++) {
      const lease = acquireSession({ accountId: `acc-${i}`, pid: 1000 + i });
      assert.ok(lease.leaseId);
      leases.push(lease);
    }
    assert.strictEqual(countActiveSessions(), 5);

    const audit = getSessionAudit();
    assert.strictEqual(audit.activeCount, 5);
    assert.strictEqual(audit.availableSlots, 0);

    // Cleanup
    leases.forEach(l => l.release());
    assert.strictEqual(countActiveSessions(), 0);
  });

  it('2. strictly fails closed on the 6th session attempt with MAX_PROJECT_SESSIONS_EXCEEDED', () => {
    const leases = [];
    for (let i = 0; i < 5; i++) {
      leases.push(acquireSession({ accountId: `slot-${i}` }));
    }

    assert.throws(
      () => acquireSession({ accountId: 'slot-6th-attempt' }),
      err => {
        assert.strictEqual(err.code, 'MAX_PROJECT_SESSIONS_EXCEEDED');
        assert.ok(err.message.includes('Project-wide limit of 5 concurrent sessions reached'));
        return true;
      }
    );

    // Releasing one allows a new session
    leases[0].release();
    assert.strictEqual(countActiveSessions(), 4);

    const newLease = acquireSession({ accountId: 'slot-replacement' });
    assert.ok(newLease.leaseId);
    assert.strictEqual(countActiveSessions(), 5);

    // Cleanup
    leases.slice(1).forEach(l => l.release());
    newLease.release();
    assert.strictEqual(countActiveSessions(), 0);
  });

  it('3. release is idempotent and ignores multiple release calls', () => {
    const lease = acquireSession({ accountId: 'idempotent-test' });
    assert.strictEqual(countActiveSessions(), 1);
    lease.release();
    assert.strictEqual(countActiveSessions(), 0);
    lease.release(); // Should not throw or decrement below 0
    assert.strictEqual(countActiveSessions(), 0);
  });
});
