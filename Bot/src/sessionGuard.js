'use strict';
/**
 * Strict project-wide interprocess session cap guard.
 * Enforces a hard ceiling of at most 5 concurrent DirectX / Twikit / browser
 * sessions across all processes, containers, and accounts on the host.
 *
 * Backed by an atomic, interprocess SQLite transactional lease registry with
 * alive-process verification (ESRCH + /proc/<pid>/stat field 22 starttime),
 * heartbeat fencing, and untracked-process detection.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const MAX_PROJECT_SESSIONS = 5;
const DEFAULT_DB_PATH = path.resolve(__dirname, '../data/session_leases.sqlite');
const CANONICAL_HOST_PROD_DB_PATH = '/root/Projects/YJAutoPostOnX/Bot/data/session_leases.sqlite';
const HEARTBEAT_INTERVAL_MS = 5_000;

function isTestEnvironment() {
  return Boolean(
    process.env.NODE_ENV === 'test' ||
    process.env.NODE_TEST_CONTEXT ||
    process.env.npm_lifecycle_event === 'test' ||
    process.env.YJ_TEST_MODE === '1' ||
    process.execArgv.some(arg => typeof arg === 'string' && arg.includes('--test')) ||
    process.argv.some(arg => typeof arg === 'string' && (arg.includes('test') || arg.includes('--test')))
  );
}

function getCandidateProdPaths() {
  const candidates = [
    DEFAULT_DB_PATH,
    CANONICAL_HOST_PROD_DB_PATH
  ];
  if (process.env.BOT_PRODUCTION_DATA_DIR) {
    candidates.push(path.resolve(process.env.BOT_PRODUCTION_DATA_DIR, 'session_leases.sqlite'));
  }
  return Array.from(new Set(candidates.map(p => path.resolve(p))));
}

function isTargetingProdSessionDb(filePath) {
  if (!filePath) return false;
  const resolved = path.resolve(String(filePath));
  const candidates = getCandidateProdPaths();

  let targetReal = null;
  let targetStat = null;
  try {
    if (fs.existsSync(resolved)) {
      targetReal = fs.realpathSync(resolved);
      targetStat = fs.statSync(resolved);
    } else if (fs.existsSync(path.dirname(resolved))) {
      targetReal = path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
    }
  } catch {}

  for (const prodPath of candidates) {
    const prodDir = path.dirname(prodPath);
    if (resolved === prodPath || resolved.startsWith(prodDir + path.sep)) return true;
    try {
      let prodReal = prodPath;
      if (fs.existsSync(prodPath)) {
        prodReal = fs.realpathSync(prodPath);
        if (targetStat) {
          const prodStat = fs.statSync(prodPath);
          if (prodStat.dev === targetStat.dev && prodStat.ino === targetStat.ino) return true;
        }
      } else if (fs.existsSync(prodDir)) {
        prodReal = path.join(fs.realpathSync(prodDir), path.basename(prodPath));
      }
      if (targetReal && (targetReal === prodReal || targetReal.startsWith(path.dirname(prodReal) + path.sep))) {
        return true;
      }
    } catch {}
  }
  return false;
}

function assertSessionDbMutationAllowed(filePath) {
  if (isTestEnvironment() && isTargetingProdSessionDb(filePath)) {
    const err = new Error('PRODUCTION_DB_MUTATION_FORBIDDEN: Tests are strictly forbidden from mutating production session_leases.sqlite');
    err.code = 'PRODUCTION_DB_MUTATION_FORBIDDEN';
    throw err;
  }
}

function getLeaseDbPath() {
  const envPath = process.env.SESSION_GUARD_DB_PATH || process.env.DIRECT_X_SESSION_DB_PATH;
  if (envPath) {
    return path.resolve(envPath);
  }
  return DEFAULT_DB_PATH;
}

function getPidStartTime(pid) {
  if (!pid || typeof pid !== 'number' || pid <= 0) return null;
  try {
    const statPath = `/proc/${pid}/stat`;
    if (!fs.existsSync(statPath)) return null;
    const content = fs.readFileSync(statPath, 'utf8');
    const closeParen = content.lastIndexOf(')');
    if (closeParen === -1) return null;
    // Field 1 is pid, Field 2 is (comm). Fields after ')' start at Field 3 (index 0).
    // Field 22 (starttime) is at index 22 - 3 = 19.
    const fields = content.slice(closeParen + 2).trim().split(/\s+/);
    const starttime = fields[19];
    return starttime && /^\d+$/.test(starttime) ? starttime : null;
  } catch {
    return null;
  }
}

function isPidAlive(pid, expectedPattern, expectedStartTime = null) {
  if (!pid || typeof pid !== 'number' || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err.code === 'ESRCH') return false;
    // EPERM means process exists but belongs to another user (definitely alive)
    if (err.code === 'EPERM') return true;
    return false;
  }
  if (expectedStartTime != null) {
    const actualStartTime = getPidStartTime(pid);
    if (actualStartTime != null && String(actualStartTime) !== String(expectedStartTime)) {
      return false; // PID was recycled by a newer process with a different starttime
    }
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

const isProcessAlive = isPidAlive;

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
    this.dbPath = path.resolve(dbPath || getLeaseDbPath());
    assertSessionDbMutationAllowed(this.dbPath);
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
          owner_starttime TEXT,
          child_pid INTEGER,
          child_starttime TEXT,
          acquired_at INTEGER NOT NULL,
          heartbeat_at INTEGER NOT NULL,
          meta TEXT
        );
      `);
      const columns = this.db.prepare('PRAGMA table_info(session_leases)').all().map(c => c.name);
      if (!columns.includes('owner_starttime')) {
        this.db.exec('ALTER TABLE session_leases ADD COLUMN owner_starttime TEXT;');
      }
      if (!columns.includes('child_starttime')) {
        this.db.exec('ALTER TABLE session_leases ADD COLUMN child_starttime TEXT;');
      }
    });
  }

  close() {
    try {
      this.db.close();
    } catch {}
  }

  /**
   * Reconciles orphan leases: proves owning process/session dead via ESRCH or starttime mismatch before removal.
   * Never removes a lease if node_pid or child_pid is still running with matching starttime!
   */
  reconcileOrphans() {
    const rows = this.db.prepare(
      'SELECT lease_id, node_pid, owner_starttime, child_pid, child_starttime, heartbeat_at FROM session_leases'
    ).all();
    const toDelete = [];
    const trackedChildPids = new Set();

    for (const row of rows) {
      const nodeAlive = isPidAlive(row.node_pid, /node/i, row.owner_starttime);
      const childAlive = row.child_pid ? isPidAlive(row.child_pid, /python|direct_x/i, row.child_starttime) : false;

      if (row.child_pid && childAlive) {
        trackedChildPids.add(row.child_pid);
      }

      // If BOTH node process and child process are confirmed dead (or PID reused), lease is orphaned
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
    const rows = this.db.prepare('SELECT child_pid, child_starttime FROM session_leases').all();
    const trackedPids = new Set(
      rows
        .filter(r => r.child_pid && isPidAlive(r.child_pid, /python|direct_x/i, r.child_starttime))
        .map(r => r.child_pid)
    );
    const untracked = countUntrackedDirectXProcesses(trackedPids);
    const dbCount = rows.length;
    return dbCount + untracked;
  }

  _withRetry(fn, maxRetries = 100) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return fn();
      } catch (err) {
        const isBusy = (
          err.code === 'ERR_SQLITE_ERROR' ||
          err.code === 'SQLITE_BUSY' ||
          err.message?.includes('locked') ||
          err.message?.includes('busy')
        );
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

  acquire({ accountId, sessionKey, childPid, ownerStartTime: suppliedOwnerStartTime, childStartTime: suppliedChildStartTime, meta } = {}) {
    assertSessionDbMutationAllowed(this.dbPath);
    const key = sessionKey || (accountId ? `account_${accountId}` : `anon_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const now = Date.now();
    const leaseId = `lease_${accountId || 'anon'}_${now}_${Math.random().toString(36).slice(2, 8)}`;
    const ownerStartTime = suppliedOwnerStartTime !== undefined ? suppliedOwnerStartTime : getPidStartTime(process.pid);
    const childStartTime = suppliedChildStartTime !== undefined ? suppliedChildStartTime : (childPid ? getPidStartTime(childPid) : null);

    return this._withRetry(() => {
      this.db.exec('BEGIN IMMEDIATE;');
      try {
        this.reconcileOrphans();
        const currentLeases = this.db.prepare('SELECT child_pid, child_starttime, session_key FROM session_leases').all();

        // Check if this exact session_key already holds an active lease
        const existing = currentLeases.find(l => l.session_key === key);
        if (existing) {
          const err = new Error(`DUPLICATE_SESSION_LEASE: A live lease already exists for session_key '${key}'.`);
          err.code = 'DUPLICATE_SESSION_LEASE';
          throw err;
        }

        const trackedPids = new Set(
          currentLeases
            .filter(r => r.child_pid && isPidAlive(r.child_pid, /python|direct_x/i, r.child_starttime))
            .map(r => r.child_pid)
        );
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
          INSERT INTO session_leases (lease_id, account_id, session_key, node_pid, owner_starttime, child_pid, child_starttime, acquired_at, heartbeat_at, meta)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          leaseId,
          accountId || null,
          key,
          process.pid,
          ownerStartTime,
          childPid || null,
          childStartTime,
          now,
          now,
          meta ? JSON.stringify(meta) : null
        );

        this.db.exec('COMMIT;');

        return {
          leaseId,
          sessionKey: key,
          accountId: accountId || null,
          ownerStartTime,
          childStartTime,
          acquiredAt: now
        };
      } catch (err) {
        try { this.db.exec('ROLLBACK;'); } catch {}
        throw err;
      }
    });
  }

  bindChildProcess(leaseId, childPid, childStartTime = undefined) {
    if (!leaseId || !childPid) {
      const err = new Error('INVALID_BIND_ARGS: leaseId and childPid are required');
      err.code = 'INVALID_BIND_ARGS';
      throw err;
    }
    assertSessionDbMutationAllowed(this.dbPath);
    const resolvedChildStart = childStartTime !== undefined ? childStartTime : getPidStartTime(childPid);
    return this._withRetry(() => {
      this.db.exec('BEGIN IMMEDIATE;');
      try {
        const info = this.db.prepare(
          'UPDATE session_leases SET child_pid = ?, child_starttime = ?, heartbeat_at = ? WHERE lease_id = ?'
        ).run(childPid, resolvedChildStart, Date.now(), leaseId);
        if (!info || info.changes < 1) {
          const err = new Error(`LEASE_NOT_FOUND: Cannot bind child PID ${childPid} to missing lease ${leaseId}`);
          err.code = 'LEASE_NOT_FOUND';
          throw err;
        }
        this.db.exec('COMMIT;');
        return true;
      } catch (err) {
        try { this.db.exec('ROLLBACK;'); } catch {}
        throw err;
      }
    });
  }

  updateChildPid(leaseId, childPid, childStartTime = undefined) {
    return this.bindChildProcess(leaseId, childPid, childStartTime);
  }

  heartbeat(leaseId) {
    if (!leaseId) return false;
    assertSessionDbMutationAllowed(this.dbPath);
    return this._withRetry(() => {
      const info = this.db.prepare('UPDATE session_leases SET heartbeat_at = ? WHERE lease_id = ?').run(Date.now(), leaseId);
      return Boolean(info && info.changes > 0);
    });
  }

  release(leaseId) {
    if (!leaseId) return false;
    assertSessionDbMutationAllowed(this.dbPath);
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
    const trackedPids = new Set(
      rows
        .filter(r => r.child_pid && isPidAlive(r.child_pid, /python|direct_x/i, r.child_starttime))
        .map(r => r.child_pid)
    );
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
        ownerStartTime: r.owner_starttime || null,
        childPid: r.child_pid,
        childStartTime: r.child_starttime || null,
        nodeAlive: isPidAlive(r.node_pid, /node/i, r.owner_starttime),
        childAlive: r.child_pid ? isPidAlive(r.child_pid, /python|direct_x/i, r.child_starttime) : null,
        ageMs: Date.now() - r.acquired_at,
        heartbeatAgeMs: Date.now() - r.heartbeat_at
      }))
    };
  }
}

// Singleton instance per Node process
let defaultRegistry = null;

function getRegistry() {
  const targetPath = getLeaseDbPath();
  if (defaultRegistry && defaultRegistry.dbPath !== targetPath) {
    try { defaultRegistry.close(); } catch {}
    defaultRegistry = null;
  }
  if (!defaultRegistry) {
    defaultRegistry = new SessionGuardRegistry(targetPath);
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
    try { reg.heartbeat(leaseInfo.leaseId); } catch {}
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

  const bindChildProcess = (pid) => {
    if (released) {
      const err = new Error('SESSION_LEASE_RELEASED: Cannot bind child to a released lease.');
      err.code = 'SESSION_LEASE_RELEASED';
      throw err;
    }
    if (!pid) {
      const err = new Error('INVALID_CHILD_PID: Child PID is required.');
      err.code = 'INVALID_CHILD_PID';
      throw err;
    }
    try {
      reg.bindChildProcess(leaseInfo.leaseId, pid);
      leaseInfo.childPid = pid;
      leaseInfo.childStartTime = getPidStartTime(pid);
    } catch (err) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
      release();
      throw err;
    }
  };

  return {
    leaseId: leaseInfo.leaseId,
    sessionKey: leaseInfo.sessionKey,
    release,
    bindChild: bindChildProcess,
    bindChildProcess,
    lease: leaseInfo
  };
}

function getSessionAudit() {
  return getRegistry().getAudit();
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
  if (isTargetingProdSessionDb(resolved)) {
    const err = new Error('PROD_PATH_RESET_FORBIDDEN: Refusing to unlink production session lease registry.');
    err.code = 'PROD_PATH_RESET_FORBIDDEN';
    throw err;
  }

  // Enforce that path resides strictly inside system temporary directory or scratch directory
  const allowedTmpDirs = [fs.realpathSync(os.tmpdir()), '/tmp'];
  if (process.env.TMPDIR && fs.existsSync(process.env.TMPDIR)) {
    try { allowedTmpDirs.push(fs.realpathSync(process.env.TMPDIR)); } catch {}
  }
  let targetDir = path.dirname(resolved);
  let canonicalTargetDir;
  try {
    canonicalTargetDir = fs.realpathSync(targetDir);
  } catch {
    canonicalTargetDir = targetDir;
  }

  const inAllowedTmp = allowedTmpDirs.some(tmp =>
    canonicalTargetDir.startsWith(tmp) || resolved.startsWith(tmp)
  );
  if (!inAllowedTmp) {
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

  if (isTargetingProdSessionDb(resolved)) {
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
  resetSessionsForTest,
  getPidStartTime,
  isPidAlive,
  isProcessAlive,
  isTargetingProdSessionDb,
  assertSessionDbMutationAllowed
};
