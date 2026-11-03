'use strict';
/**
 * Strict project-wide interprocess session cap guard.
 * Enforces a hard ceiling of at most 5 concurrent DirectX / Twikit / browser
 * sessions across all processes, containers, and accounts on the host.
 *
 * Backed by an atomic, interprocess SQLite transactional lease registry with
 * alive-process verification (ESRCH), heartbeat fencing, and untracked-process
 * detection. Never reclaims a lease based solely on TTL while the process lives.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const MAX_PROJECT_SESSIONS = 5;
const DEFAULT_DB_PATH = path.resolve(__dirname, '../data/session_leases.sqlite');
const HEARTBEAT_INTERVAL_MS = 5_000;

function getLeaseDbPath() {
  if (process.env.SESSION_GUARD_DB_PATH) {
    return path.resolve(process.env.SESSION_GUARD_DB_PATH);
  }
  return DEFAULT_DB_PATH;
}

function isPidAlive(pid, expectedPattern) {
  if (!pid || typeof pid !== 'number' || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err.code === 'ESRCH') return false;
    // EPERM means process exists but belongs to another user (definitely alive)
    if (err.code === 'EPERM') return true;
    return false;
  }
  if (expectedPattern) {
    try {
      const cmdlinePath = `/proc/${pid}/cmdline`;
      if (fs.existsSync(cmdlinePath)) {
        const cmd = fs.readFileSync(cmdlinePath, 'utf8');
        if (!expectedPattern.test(cmd)) {
          return false; // PID was recycled by an unrelated process
        }
      }
    } catch (err) {
      if (err.code === 'EACCES' || err.code === 'EPERM') {
        // Permission barrier: fail closed by assuming alive so we never prematurely release or orphan
        return true;
      }
      if (err.code === 'ENOENT') {
        return false;
      }
    }
  }
  return true;
}

function countUntrackedDirectXProcesses(trackedChildPids = new Set()) {
  const procDir = '/proc';
  if (!fs.existsSync(procDir)) {
    const err = new Error('PROCESS_VISIBILITY_UNVERIFIED: Cannot inspect /proc to account for running DirectX processes.');
    err.code = 'PROCESS_VISIBILITY_UNVERIFIED';
    throw err;
  }
  let entries;
  try {
    entries = fs.readdirSync(procDir);
  } catch (err) {
    const e = new Error(`PROCESS_VISIBILITY_UNVERIFIED: Failed to read /proc: ${err.message}`);
    e.code = 'PROCESS_VISIBILITY_UNVERIFIED';
    throw e;
  }
  let untracked = 0;
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = parseInt(entry, 10);
    if (pid === process.pid || trackedChildPids.has(pid)) continue;
    try {
      const cmdlinePath = path.join(procDir, entry, 'cmdline');
      if (fs.existsSync(cmdlinePath)) {
        const cmd = fs.readFileSync(cmdlinePath, 'utf8');
        if (cmd.includes('direct_x_bridge.py') || cmd.includes('direct_x_compat.py')) {
          untracked++;
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        const e = new Error(`PROCESS_VISIBILITY_UNVERIFIED: Cannot inspect cmdline for process ${entry}: ${err.message}`);
        e.code = 'PROCESS_VISIBILITY_UNVERIFIED';
        throw e;
      }
    }
  }
  return untracked;
}

class SessionGuardRegistry {
  constructor(dbPath) {
    this.dbPath = dbPath || getLeaseDbPath();
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(this.dbPath);
    this._withRetry(() => {
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec('PRAGMA busy_timeout = 5000;');
    });
    this._initSchema();
  }

  _initSchema() {
    this._withRetry(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS session_leases (
          lease_id TEXT PRIMARY KEY,
          account_id TEXT,
          session_key TEXT UNIQUE,
          node_pid INTEGER NOT NULL,
          child_pid INTEGER,
          acquired_at INTEGER NOT NULL,
          heartbeat_at INTEGER NOT NULL,
          meta TEXT
        );
      `);
    });
  }

  close() {
    try {
      this.db.close();
    } catch {}
  }

  /**
   * Reconciles orphan leases: proves owning process/session dead via ESRCH before removal.
   * Never removes a lease if node_pid or child_pid is still running!
   */
  reconcileOrphans() {
    const rows = this.db.prepare('SELECT lease_id, node_pid, child_pid, heartbeat_at FROM session_leases').all();
    const toDelete = [];
    const trackedChildPids = new Set();

    for (const row of rows) {
      const nodeAlive = isPidAlive(row.node_pid, /node/i);
      const childAlive = row.child_pid ? isPidAlive(row.child_pid, /python|direct_x/i) : false;

      if (row.child_pid && childAlive) {
        trackedChildPids.add(row.child_pid);
      }

      // If BOTH node process and child process are confirmed dead, lease is orphaned
      if (!nodeAlive && !childAlive) {
        toDelete.push(row.lease_id);
      }
    }

    if (toDelete.length > 0) {
      const stmt = this.db.prepare('DELETE FROM session_leases WHERE lease_id = ?');
      for (const id of toDelete) {
        stmt.run(id);
      }
    }

    return { purged: toDelete.length, trackedChildPids };
  }

  countActive() {
    this.reconcileOrphans();
    const rows = this.db.prepare('SELECT child_pid FROM session_leases').all();
    const trackedPids = new Set(rows.map(r => r.child_pid).filter(Boolean));
    const untracked = countUntrackedDirectXProcesses(trackedPids);
    const dbCount = rows.length;
    return dbCount + untracked;
  }

  _withRetry(fn, maxRetries = 100) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return fn();
      } catch (err) {
        const isBusy = (err.code === 'ERR_SQLITE_ERROR' || err.message?.includes('locked') || err.message?.includes('busy'));
        if (isBusy && attempt < maxRetries - 1) {
          const delayMs = 15 + Math.floor(Math.random() * 35);
          try {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
          } catch {
            const until = Date.now() + delayMs;
            while (Date.now() < until) {}
          }
          continue;
        }
        throw err;
      }
    }
  }

  acquire({ accountId, sessionKey, childPid, meta } = {}) {
    const key = sessionKey || (accountId ? `account_${accountId}` : `anon_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const now = Date.now();
    const leaseId = `lease_${accountId || 'anon'}_${now}_${Math.random().toString(36).slice(2, 8)}`;

    return this._withRetry(() => {
      this.db.exec('BEGIN IMMEDIATE;');
      try {
        this.reconcileOrphans();
        const currentLeases = this.db.prepare('SELECT child_pid, session_key FROM session_leases').all();

        // Check if this exact session_key already holds an active lease
        const existing = currentLeases.find(l => l.session_key === key);
        if (existing) {
          const err = new Error(`DUPLICATE_SESSION_LEASE: A live lease already exists for session_key '${key}'.`);
          err.code = 'DUPLICATE_SESSION_LEASE';
          throw err;
        }

        const trackedPids = new Set(currentLeases.map(r => r.child_pid).filter(Boolean));
        if (childPid) trackedPids.add(childPid);
        const untracked = countUntrackedDirectXProcesses(trackedPids);
        const totalActive = currentLeases.length + untracked;

        if (totalActive >= MAX_PROJECT_SESSIONS) {
          const err = new Error(`MAX_PROJECT_SESSIONS_EXCEEDED: Project-wide limit of ${MAX_PROJECT_SESSIONS} concurrent sessions reached (active: ${totalActive}, db: ${currentLeases.length}, untracked: ${untracked}).`);
          err.code = 'MAX_PROJECT_SESSIONS_EXCEEDED';
          err.activeCount = totalActive;
          err.maxLimit = MAX_PROJECT_SESSIONS;
          throw err;
        }

        this.db.prepare(`
          INSERT INTO session_leases (lease_id, account_id, session_key, node_pid, child_pid, acquired_at, heartbeat_at, meta)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          leaseId,
          accountId || null,
          key,
          process.pid,
          childPid || null,
          now,
          now,
          meta ? JSON.stringify(meta) : null
        );

        this.db.exec('COMMIT;');

        return {
          leaseId,
          sessionKey: key,
          accountId: accountId || null,
          acquiredAt: now
        };
      } catch (err) {
        try { this.db.exec('ROLLBACK;'); } catch {}
        throw err;
      }
    });
  }

  updateChildPid(leaseId, childPid) {
    if (!leaseId || !childPid) return;
    try {
      this.db.prepare('UPDATE session_leases SET child_pid = ?, heartbeat_at = ? WHERE lease_id = ?').run(
        childPid,
        Date.now(),
        leaseId
      );
    } catch {}
  }

  heartbeat(leaseId) {
    if (!leaseId) return;
    try {
      this.db.prepare('UPDATE session_leases SET heartbeat_at = ? WHERE lease_id = ?').run(Date.now(), leaseId);
    } catch {}
  }

  release(leaseId) {
    if (!leaseId) return false;
    return this._withRetry(() => {
      this.db.exec('BEGIN IMMEDIATE;');
      try {
        const info = this.db.prepare('DELETE FROM session_leases WHERE lease_id = ?').run(leaseId);
        this.db.exec('COMMIT;');
        return info.changes > 0;
      } catch (err) {
        try { this.db.exec('ROLLBACK;'); } catch {}
        return false;
      }
    });
  }

  getAudit() {
    this.reconcileOrphans();
    const rows = this.db.prepare('SELECT * FROM session_leases ORDER BY acquired_at ASC').all();
    const trackedPids = new Set(rows.map(r => r.child_pid).filter(Boolean));
    const untracked = countUntrackedDirectXProcesses(trackedPids);
    const totalActive = rows.length + untracked;

    return {
      maxLimit: MAX_PROJECT_SESSIONS,
      activeCount: totalActive,
      dbLeaseCount: rows.length,
      untrackedProcessCount: untracked,
      availableSlots: Math.max(0, MAX_PROJECT_SESSIONS - totalActive),
      leases: rows.map(r => ({
        leaseId: r.lease_id,
        accountId: r.account_id,
        sessionKey: r.session_key,
        nodePid: r.node_pid,
        childPid: r.child_pid,
        nodeAlive: isPidAlive(r.node_pid),
        childAlive: r.child_pid ? isPidAlive(r.child_pid) : null,
        ageMs: Date.now() - r.acquired_at,
        heartbeatAgeMs: Date.now() - r.heartbeat_at
      }))
    };
  }
}

// Singleton instance per Node process
let defaultRegistry = null;

function getRegistry() {
  if (!defaultRegistry) {
    defaultRegistry = new SessionGuardRegistry();
  }
  return defaultRegistry;
}

function countActiveSessions() {
  return getRegistry().countActive();
}

function acquireSession({ accountId, sessionKey, childPid, meta } = {}) {
  const reg = getRegistry();
  const leaseInfo = reg.acquire({ accountId, sessionKey, childPid, meta });

  let released = false;
  let heartbeatTimer = setInterval(() => {
    if (released) return;
    reg.heartbeat(leaseInfo.leaseId);
  }, HEARTBEAT_INTERVAL_MS);
  if (heartbeatTimer.unref) heartbeatTimer.unref();

  const release = () => {
    if (released) return;
    released = true;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    reg.release(leaseInfo.leaseId);
  };

  const bindChild = (pid) => {
    if (released || !pid) return;
    leaseInfo.childPid = pid;
    reg.updateChildPid(leaseInfo.leaseId, pid);
  };

  return {
    leaseId: leaseInfo.leaseId,
    sessionKey: leaseInfo.sessionKey,
    release,
    bindChild,
    lease: leaseInfo
  };
}

function getSessionAudit() {
  return getRegistry().getAudit();
}

function isTestEnvironment() {
  return Boolean(
    process.env.NODE_ENV === 'test' ||
    process.env.NODE_TEST_CONTEXT ||
    process.env.npm_lifecycle_event === 'test' ||
    process.env.YJ_TEST_MODE === '1' ||
    process.argv.some(arg => typeof arg === 'string' && (arg.includes('test') || arg.includes('--test')))
  );
}

function resetSessionsForTest(customDbPath) {
  if (!isTestEnvironment()) {
    const err = new Error('FORBIDDEN_OUTSIDE_TEST: resetSessionsForTest can only be invoked in a verified test environment.');
    err.code = 'RESET_FORBIDDEN_OUTSIDE_TEST';
    throw err;
  }
  if (!customDbPath || typeof customDbPath !== 'string') {
    const err = new Error('CUSTOM_PATH_REQUIRED: resetSessionsForTest requires an explicit temporary database path.');
    err.code = 'RESET_CUSTOM_PATH_REQUIRED';
    throw err;
  }

  const resolved = path.resolve(customDbPath);
  const prodCanonical = DEFAULT_DB_PATH;
  if (resolved === prodCanonical || resolved.startsWith(path.dirname(prodCanonical))) {
    const err = new Error('PROD_PATH_RESET_FORBIDDEN: Refusing to unlink production session lease registry.');
    err.code = 'PROD_PATH_RESET_FORBIDDEN';
    throw err;
  }

  // Enforce that path resides strictly inside system temporary directory
  const realTmpDir = fs.realpathSync(os.tmpdir());
  let targetDir = path.dirname(resolved);
  let canonicalTargetDir;
  try {
    canonicalTargetDir = fs.realpathSync(targetDir);
  } catch {
    canonicalTargetDir = targetDir;
  }

  if (!canonicalTargetDir.startsWith(realTmpDir) && !resolved.startsWith(realTmpDir)) {
    const err = new Error('TEMP_DIR_REQUIRED: customDbPath must reside inside a temporary test directory.');
    err.code = 'TEMP_DIR_REQUIRED';
    throw err;
  }

  // Check target file and every parent directory component for symlinks to prevent traversal
  let current = resolved;
  while (current && current !== path.dirname(current)) {
    if (fs.existsSync(current)) {
      try {
        const lstat = fs.lstatSync(current);
        if (lstat.isSymbolicLink()) {
          const err = new Error('SYMLINK_RESET_FORBIDDEN: Refusing to unlink target with symbolic link in path.');
          err.code = 'SYMLINK_RESET_FORBIDDEN';
          throw err;
        }
      } catch (e) {
        if (e.code === 'SYMLINK_RESET_FORBIDDEN') throw e;
      }
    }
    current = path.dirname(current);
  }

  // Extra check: ensure realpath does not point to production database
  let realTarget;
  try {
    realTarget = fs.realpathSync(resolved);
  } catch {
    realTarget = resolved;
  }
  if (realTarget === prodCanonical || realTarget.startsWith(path.dirname(prodCanonical))) {
    const err = new Error('PROD_PATH_RESET_FORBIDDEN: Refusing to unlink production session lease registry.');
    err.code = 'PROD_PATH_RESET_FORBIDDEN';
    throw err;
  }

  if (defaultRegistry) {
    try { defaultRegistry.close(); } catch {}
    defaultRegistry = null;
  }

  try {
    if (fs.existsSync(resolved)) fs.unlinkSync(resolved);
    if (fs.existsSync(resolved + '-wal')) fs.unlinkSync(resolved + '-wal');
    if (fs.existsSync(resolved + '-shm')) fs.unlinkSync(resolved + '-shm');
  } catch {}
}

module.exports = {
  MAX_PROJECT_SESSIONS,
  SessionGuardRegistry,
  acquireSession,
  countActiveSessions,
  getSessionAudit,
  resetSessionsForTest
};
