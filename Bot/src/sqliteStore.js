'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

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
  constructor(file, initial = {}, { legacyFile } = {}) {
    this.file = path.resolve(file);
    this.initial = structuredClone(initial);
    this.legacyFile = legacyFile ? path.resolve(legacyFile) : null;
    this.state = null;
    this.db = null;
    this.closed = false;
    // Resolve aliases of the parent directory so different instances share a queue.
    const directory = path.dirname(this.file);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    this.key = path.join(fs.realpathSync(directory), path.basename(this.file));
  }

  _open() {
    if (this.closed) throw new Error('Store is closed');
    if (this.db) return;
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
      db.exec('PRAGMA busy_timeout=30000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      for (const suffix of ['-wal', '-shm']) {
        secureFileMode(this.key + suffix, { missing: true });
      }
      this.db = db;
    } catch (error) { db.close(); throw error; }
  }

  _transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      if (result && typeof result.then === 'function') {
        return result.then(value => { this.db.exec('COMMIT'); return value; }).catch(error => {
          try { this.db.exec('ROLLBACK'); } catch {} throw error;
        });
      }
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {} throw error;
    }
  }

  _readOrInitialize() {
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
      return JSON.parse(json);
    }
    if (version !== 1) throw new Error('Unsupported SQLite store version');
    const rows = this.db.prepare('SELECT id, json, revision FROM state').all();
    if (rows.length !== 1 || rows[0].id !== 1 || !Number.isSafeInteger(rows[0].revision) || rows[0].revision < 0) throw new Error('Invalid SQLite store record');
    return JSON.parse(rows[0].json);
  }

  _encode(value) {
    const json = JSON.stringify(value);
    if (json === undefined) throw new TypeError('State must be JSON serializable');
    return json;
  }

  async load() {
    return serialize(this.key, () => {
      this._open();
      const result = this._transaction(() => this._readOrInitialize());
      this.state = structuredClone(result);
      return structuredClone(result);
    });
  }

  async save(next) {
    const snapshot = structuredClone(next);
    return serialize(this.key, () => {
      this._open();
      const result = this._transaction(() => {
        this._readOrInitialize();
        const json = this._encode(snapshot);
        this.db.prepare('UPDATE state SET json = ?, revision = revision + 1 WHERE id = 1').run(json);
        return JSON.parse(json);
      });
      this.state = structuredClone(result);
      return structuredClone(result);
    });
  }

  async update(mutator) {
    return serialize(this.key, async () => {
      this._open();
      const result = await this._transaction(async () => {
        const current = this._readOrInitialize();
        const draft = structuredClone(current);
        const next = await mutator(draft);
        const json = this._encode(next === undefined ? draft : next);
        this.db.prepare('UPDATE state SET json = ?, revision = revision + 1 WHERE id = 1').run(json);
        return JSON.parse(json);
      });
      this.state = structuredClone(result);
      return structuredClone(result);
    });
  }

  async close() {
    return serialize(this.key, () => {
      if (this.db) this.db.close();
      this.db = null;
      this.closed = true;
    });
  }
}

module.exports = { SqliteStore };
