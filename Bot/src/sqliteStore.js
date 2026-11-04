'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  throw new Error(`NODE_SQLITE_UNAVAILABLE: node:sqlite requires Node.js >= 22.5.0 (running on ${process.version}): ${err.message}`);
}

function secureFileMode(file, { missing = false } = {}) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (missing && error.code === 'ENOENT') return; throw error; }
  if (!stat.isFile()) throw new Error('SQLite path must be a regular file, not a symlink');
  // Never open/close live database, SHM or WAL descriptors outside SQLite:
  // close releases this process's POSIX locks, including other connections'.
  // The canonical parent is private; reject nonregular paths before chmod.
  if ((stat.mode & 0o777) !== 0o600) fs.chmodSync(file, 0o600);
}

const HOST_PROD_DATA_DIR = '/root/Projects/YJAutoPostOnX/Bot/data';

function getProtectedProdDbPaths() {
  const dirs = [
    path.resolve(__dirname, '../data'),
    HOST_PROD_DATA_DIR,
  ];
  if (process.env.BOT_PRODUCTION_DATA_DIR) {
    dirs.push(path.resolve(process.env.BOT_PRODUCTION_DATA_DIR));
  }
  const paths = new Set();
  for (const dir of dirs) {
    const resolvedDir = path.resolve(dir);
    paths.add(path.join(resolvedDir, 'state.sqlite'));
    try {
      if (fs.existsSync(resolvedDir)) {
        paths.add(path.join(fs.realpathSync(resolvedDir), 'state.sqlite'));
      }
    } catch {}
  }
  return Array.from(paths);
}

function getCanonicalProdDbPath() {
  const paths = getProtectedProdDbPaths();
  return paths[0];
}

function resolveProductionDbPath() {
  return getCanonicalProdDbPath();
}

function isTestEnvironment() {
  return Boolean(
    process.env.NODE_ENV === 'test' ||
    process.env.NODE_TEST_CONTEXT ||
    process.env.npm_lifecycle_event === 'test' ||
    process.env.YJ_TEST_MODE === '1' ||
    process.execArgv.some(arg => typeof arg === 'string' && (arg.includes('test') || arg.includes('--test'))) ||
    process.argv.some(arg => typeof arg === 'string' && (arg.includes('test') || arg.includes('--test')))
  );
}

function isTargetingProd(filePath) {
  if (!filePath) return false;
  const protectedPaths = getProtectedProdDbPaths();
  try {
    const resolved = path.resolve(filePath);
    if (protectedPaths.includes(resolved)) return true;
    let targetStat = null;
    if (fs.existsSync(resolved)) {
      const real = fs.realpathSync(resolved);
      if (protectedPaths.includes(real)) return true;
      try { targetStat = fs.statSync(resolved); } catch {}
    }
    const dir = path.dirname(resolved);
    if (fs.existsSync(dir)) {
      const canonicalKey = path.join(fs.realpathSync(dir), path.basename(resolved));
      if (protectedPaths.includes(canonicalKey)) return true;
    }
    if (targetStat) {
      for (const prodPath of protectedPaths) {
        try {
          if (fs.existsSync(prodPath)) {
            const prodStat = fs.statSync(prodPath);
            if (prodStat.dev === targetStat.dev && prodStat.ino === targetStat.ino) {
              return true;
            }
          }
        } catch {}
      }
    }
  } catch {}
  return false;
}

function assertMutationAllowed(key) {
  if (isTestEnvironment()) {
    if (isTargetingProd(key)) {
      const err = new Error('PROD_DB_MUTATION_FORBIDDEN_IN_TEST (PRODUCTION_DB_MUTATION_FORBIDDEN): Tests are strictly forbidden from mutating the production database (state.sqlite). Use an isolated temporary database in a temporary test directory.');
      err.code = 'PROD_DB_MUTATION_FORBIDDEN_IN_TEST';
      throw err;
    }
  }
}

function isMutatorEnvelope(value, draft) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value === draft) return false;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('state') || !keys.includes('result')) return false;
  return value.state !== null && typeof value.state === 'object';
}

// All connections in this process must wait asynchronously for one another:
// a synchronous SQLite busy wait would otherwise block an awaited mutator.
const queues = new Map();
function serialize(key, fn) {
  const previous = queues.get(key) || Promise.resolve();
  const operation = previous.then(fn);
  const settled = operation.catch(() => {});
  queues.set(key, settled);
  settled.then(() => { if (queues.get(key) === settled) queues.delete(key); });
  return operation;
}

class SqliteStore {
  constructor(file, initial = {}, { legacyFile, readOnly = false } = {}) {
    this.file = path.resolve(file);
    this.initial = structuredClone(initial);
    this.legacyFile = legacyFile ? path.resolve(legacyFile) : null;
    this.readOnly = Boolean(readOnly);
    this.state = null;
    this.db = null;
    this.closed = false;
    this.lastSlowReadLog = 0;
    // Resolve aliases of the parent directory so different instances share a queue.
    const directory = path.dirname(this.file);
    if (!this.readOnly && (!isTestEnvironment() || !isTargetingProd(this.file))) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.chmodSync(directory, 0o700);
    }
    this.key = path.join(fs.existsSync(directory) ? fs.realpathSync(directory) : directory, path.basename(this.file));
  }

  _open() {
    if (this.closed) throw new Error('Store is closed');
    if (this.db) return;
    const isProtectedReadOnly = this.readOnly || (isTestEnvironment() && isTargetingProd(this.key));
    if (isProtectedReadOnly) {
      const stat = fs.lstatSync(this.key);
      if (!stat.isFile()) throw new Error('SQLite path must be a regular file, not a symlink');
      this.created = false;
      const db = new DatabaseSync(this.key, { readOnly: true });
      try {
        db.exec('PRAGMA busy_timeout=5000; PRAGMA query_only=ON;');
        this.db = db;
      } catch (error) { db.close(); throw error; }
      return;
    }
    // Refuse symlinks before chmod/SQLite open; the private canonical parent
    // is the trust boundary for subsequent SQLite-managed path operations.
    let fd;
    try {
      fd = fs.openSync(this.key, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      this.created = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      this.created = false;
    }
    if (fd !== undefined) fs.closeSync(fd);
    secureFileMode(this.key);
    for (const suffix of ['-wal', '-shm']) secureFileMode(this.key + suffix, { missing: true });
    const db = new DatabaseSync(this.key);
    try {
      db.exec('PRAGMA busy_timeout=30000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA wal_autocheckpoint=1000;');
      for (const suffix of ['-wal', '-shm']) {
        secureFileMode(this.key + suffix, { missing: true });
      }
      this.db = db;
    } catch (error) { db.close(); throw error; }
  }

  _transaction(fn, { immediate = true } = {}) {
    // A plain SELECT must not reserve the database writer lock. Defer the
    // transaction for load(), but retain BEGIN IMMEDIATE for all mutations.
    this.db.exec(immediate ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try {
      const result = fn();
      if (result && typeof result.then === 'function') {
        try { this.db.exec('ROLLBACK'); } catch {}
        throw new TypeError('TRANSACTION_ASYNC_YIELD: SQLite transaction must be synchronous; cannot hold locks across async Promise');
      }
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {} throw error;
    }
  }

  _readRecord() {
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version === 0) {
      // An existing uninitialized file may be a damaged former authority.
      // Never silently restore legacy state into it.
      if (!this.created) throw new Error('Existing SQLite store is uninitialized or corrupt');
      const objects = this.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get().n;
      if (objects !== 0) throw new Error('Unrecognized SQLite store schema');
      let value = structuredClone(this.initial);
      if (this.legacyFile) {
        try { value = JSON.parse(fs.readFileSync(this.legacyFile, 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      const json = this._encode(value);
      this.db.exec('CREATE TABLE state (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision >= 0)); PRAGMA user_version=1');
      this.db.prepare('INSERT INTO state (id, json, revision) VALUES (1, ?, 0)').run(json);
      return { data: JSON.parse(json), revision: 0 };
    }
    if (version !== 1) throw new Error('Unsupported SQLite store version');
    const rows = this.db.prepare('SELECT id, json, revision FROM state').all();
    if (rows.length !== 1 || rows[0].id !== 1 || !Number.isSafeInteger(rows[0].revision) || rows[0].revision < 0) throw new Error('Invalid SQLite store record');
    return { data: JSON.parse(rows[0].json), revision: rows[0].revision };
  }

  _readOrInitialize() {
    return this._readRecord().data;
  }

  _encode(value) {
    const json = JSON.stringify(value);
    if (json === undefined) throw new TypeError('State must be JSON serializable');
    return json;
  }

  async load() {
    const enqueuedAt = performance.now();
    return serialize(this.key, () => {
      const acquiredAt = performance.now();
      this._open();
      // BEGIN deferred avoids locking out writers for a read-only query.
      // An empty newly-created database may still initialize its schema.
      const result = this._transaction(() => this._readOrInitialize(), { immediate: false });
      // _readOrInitialize() produces a fresh parsed object; store owns it and
      // returns one independent clone rather than cloning the entire queue twice.
      this.state = result;
      const snapshot = structuredClone(result);
      const doneAt = performance.now();
      const totalMs = doneAt - enqueuedAt;
      if (totalMs >= 250 && Date.now() - this.lastSlowReadLog >= 30_000) {
        this.lastSlowReadLog = Date.now();
        try {
          process.stderr.write(JSON.stringify({
            event: 'sqlite_slow_read',
            at: new Date().toISOString(),
            totalMs: Math.round(totalMs),
            queueWaitMs: Math.round(acquiredAt - enqueuedAt),
            readAndCloneMs: Math.round(doneAt - acquiredAt)
          }) + '\n');
        } catch {
          // Logging must never change the transaction's success or stall reads.
        }
      }
      return snapshot;
    });
  }

  async save(next) {
    assertMutationAllowed(this.key);
    const snapshot = structuredClone(next);
    return serialize(this.key, () => {
      this._open();
      const result = this._transaction(() => {
        const { revision } = this._readRecord();
        const json = this._encode(snapshot);
        const res = this.db.prepare('UPDATE state SET json = ?, revision = revision + 1 WHERE id = 1 AND revision = ?').run(json, revision);
        if (res.changes !== 1) {
          throw Object.assign(new Error(`Optimistic concurrency conflict at revision ${revision}`), { code: 'OPTIMISTIC_CONCURRENCY_CONFLICT' });
        }
        return JSON.parse(json);
      });
      this.state = structuredClone(result);
      return structuredClone(result);
    });
  }

  async update(mutator) {
    assertMutationAllowed(this.key);
    if (this.readOnly) {
      const err = new Error('READ_ONLY_STORE: Cannot call update() on a read-only SqliteStore');
      err.code = 'READ_ONLY_STORE';
      throw err;
    }
    return serialize(this.key, async () => {
      this._open();
      let attempts = 0;
      while (attempts < 3) {
        attempts++;
        const { data: current, revision } = this._readRecord();
        const draft = structuredClone(current);
        const rawNext = mutator(draft);
        if (rawNext && typeof rawNext.then === 'function') {
          this._transaction(() => rawNext, { immediate: true });
        }
        let envelope = isMutatorEnvelope(rawNext, draft);
        let nextState = envelope ? rawNext.state : (rawNext === undefined ? draft : rawNext);
        let mutatorResult = envelope ? rawNext.result : undefined;
        let json = this._encode(nextState);
        try {
          const result = this._transaction(() => {
            let res = this.db.prepare('UPDATE state SET json = ?, revision = revision + 1 WHERE id = 1 AND revision = ?').run(json, revision);
            if (res.changes !== 1) {
              if (attempts < 3) {
                attempts++;
                const { data: freshCurrent, revision: freshRevision } = this._readRecord();
                const freshDraft = structuredClone(freshCurrent);
                const freshRawNext = mutator(freshDraft);
                if (freshRawNext && typeof freshRawNext.then === 'function') {
                  return freshRawNext;
                }
                envelope = isMutatorEnvelope(freshRawNext, freshDraft);
                nextState = envelope ? freshRawNext.state : (freshRawNext === undefined ? freshDraft : freshRawNext);
                mutatorResult = envelope ? freshRawNext.result : undefined;
                json = this._encode(nextState);
                res = this.db.prepare('UPDATE state SET json = ?, revision = revision + 1 WHERE id = 1 AND revision = ?').run(json, freshRevision);
              }
              if (res.changes !== 1) {
                throw Object.assign(new Error(`Optimistic concurrency conflict at revision ${revision}`), { code: 'OPTIMISTIC_CONCURRENCY_CONFLICT' });
              }
            }
            return JSON.parse(json);
          }, { immediate: true });
          this.state = structuredClone(result);
          const returned = structuredClone(result);
          if (envelope) {
            if (!Object.prototype.hasOwnProperty.call(returned, 'state')) {
              Object.defineProperty(returned, 'state', {
                value: structuredClone(result),
                enumerable: false,
                configurable: true,
                writable: true,
              });
            }
            if (!Object.prototype.hasOwnProperty.call(returned, 'result')) {
              Object.defineProperty(returned, 'result', {
                value: structuredClone(mutatorResult),
                enumerable: false,
                configurable: true,
                writable: true,
              });
            }
          }
          return returned;
        } catch (err) {
          if (err.code === 'OPTIMISTIC_CONCURRENCY_CONFLICT' && attempts < 3) {
            continue;
          }
          throw err;
        }
      }
    });
  }

  async close() {
    return serialize(this.key, () => {
      if (this.db) {
        if (!this.readOnly && (!isTestEnvironment() || !isTargetingProd(this.key))) {
          try { this.db.exec('PRAGMA wal_checkpoint(PASSIVE)'); } catch {}
        }
        this.db.close();
      }
      this.db = null;
      this.closed = true;
    });
  }
}

module.exports = {
  SqliteStore,
  getCanonicalProdDbPath,
  getProtectedProdDbPaths,
  resolveProductionDbPath,
  isTestEnvironment,
  isTargetingProd,
  assertMutationAllowed
};
