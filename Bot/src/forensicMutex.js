'use strict';

// Shared, crash-recoverable, per-log mutex. All producers use the SAME SQLite
// registry; unlike a stale-file unlink/rename, transaction ownership cannot be
// stolen between an ownership check and replacement.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const LOCK_WAIT_MS = 10_000;
function processStartTicks(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const end = stat.lastIndexOf(')');
    if (end < 0) return null;
    // /proc/<pid>/stat field 22 (starttime), indexed from field 3 after comm.
    return stat.slice(end + 2).trim().split(/\s+/)[19] || null;
  } catch {
    // A missing or unreadable identity must never prove that a lock is stale.
    return null;
  }
}

function ownerDefinitelyDead(pid, originalStart) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    return err.code === 'ESRCH'; // EPERM and all uncertain errors fail closed.
  }
  const currentStart = processStartTicks(pid);
  // Protect against PID reuse. If /proc is inaccessible, KEEP the lock.
  return Boolean(originalStart && currentStart && originalStart !== currentStart);
}

function mutexDbPath(logFile) {
  const resolved = path.resolve(logFile);
  const parent = fs.realpathSync(path.dirname(resolved));
  return path.join(parent, path.basename(resolved) + '.mutex.sqlite');
}

function retryableBusy(err) {
  return /(?:SQLITE_BUSY|SQLITE_LOCKED|database is locked|database is busy)/i.test(String(err?.code || '') + ' ' + String(err?.message || ''));
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function withForensicMutex(logFile, fn, { timeoutMs = LOCK_WAIT_MS } = {}) {
  if (!logFile) return fn();
  if (typeof fn !== 'function') throw new TypeError('forensic mutex requires a callback');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new TypeError('invalid mutex timeout');

  const ownStart = processStartTicks(process.pid);
  if (!ownStart) {
    throw Object.assign(new Error('PROCESS_VISIBILITY_UNVERIFIED: /proc/self/stat unavailable for log mutex.'), {
      code: 'PROCESS_VISIBILITY_UNVERIFIED'
    });
  }

  const dbFile = mutexDbPath(logFile);
  const db = new DatabaseSync(dbFile);
  const token = crypto.randomUUID();
  let held = false;
  let transaction = false;
  try {
    // Schema creation itself can race between independently starting workers.
    // Retry BUSY at initialization as well as during ownership acquisition.
    const deadline = Date.now() + timeoutMs;
    let initialized = false;
    while (!initialized && Date.now() < deadline) {
      try {
        db.exec('PRAGMA busy_timeout = 300; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
        db.exec(`CREATE TABLE IF NOT EXISTS forensic_mutex (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          owner_pid INTEGER NOT NULL,
          owner_start TEXT NOT NULL,
          owner_token TEXT NOT NULL
        );`);
        initialized = true;
      } catch (err) {
        if (!retryableBusy(err)) throw err;
        await wait(20 + Math.floor(Math.random() * 30));
      }
    }
    if (!initialized) {
      throw Object.assign(new Error('FORENSIC_LOG_LOCK_TIMEOUT: could not initialize shared mutex.'), {
        code: 'FORENSIC_LOG_LOCK_TIMEOUT'
      });
    }

    while (!held && Date.now() < deadline) {
      try {
        db.exec('BEGIN IMMEDIATE;');
        transaction = true;
        const owner = db.prepare(
          'SELECT owner_pid, owner_start, owner_token FROM forensic_mutex WHERE id = 1'
        ).get();
        if (!owner || ownerDefinitelyDead(owner.owner_pid, owner.owner_start)) {
          db.prepare(`INSERT INTO forensic_mutex (id, owner_pid, owner_start, owner_token)
            VALUES (1, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              owner_pid=excluded.owner_pid,
              owner_start=excluded.owner_start,
              owner_token=excluded.owner_token`).run(process.pid, ownStart, token);
          held = true;
        }
        db.exec('COMMIT;');
        transaction = false;
      } catch (err) {
        if (transaction) {
          try { db.exec('ROLLBACK;'); } catch {}
          transaction = false;
        }
        if (!retryableBusy(err)) throw err;
      }
      if (!held) await wait(20 + Math.floor(Math.random() * 30));
    }

    if (!held) {
      throw Object.assign(new Error('FORENSIC_LOG_LOCK_TIMEOUT: active or uncertain owner; log write deferred.'), {
        code: 'FORENSIC_LOG_LOCK_TIMEOUT'
      });
    }
    return await fn();
  } finally {
    if (transaction) {
      try { db.exec('ROLLBACK;'); } catch {}
    }
    try {
      if (held) {
        db.exec('BEGIN IMMEDIATE;');
        try {
          db.prepare(`DELETE FROM forensic_mutex
            WHERE id = 1 AND owner_pid = ? AND owner_start = ? AND owner_token = ?`
          ).run(process.pid, ownStart, token);
          db.exec('COMMIT;');
        } catch (err) {
          try { db.exec('ROLLBACK;'); } catch {}
          throw err;
        }
      }
    } finally {
      db.close();
    }
  }
}

module.exports = { withForensicMutex, mutexDbPath, processStartTicks };
