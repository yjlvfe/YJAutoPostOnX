'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xposter-native-sqlite-'));
const dbPath = path.join(root, 'probe.sqlite');
let db;
try {
  db = new Database(dbPath);
  const journal = db.pragma('journal_mode = WAL', { simple: true });
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = FULL');
  db.exec('CREATE TABLE probe(id TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT');
  const commit = db.transaction(() => {
    db.prepare('INSERT INTO probe(id, value) VALUES (?, ?)').run('one', 'electron-native');
  });
  commit.immediate();

  assert.strictEqual(journal, 'wal');
  assert.deepStrictEqual(db.prepare('SELECT * FROM probe').get(), {
    id: 'one',
    value: 'electron-native',
  });
  assert.strictEqual(db.pragma('quick_check', { simple: true }), 'ok');
  assert.deepStrictEqual(db.pragma('foreign_key_check'), []);
  console.log('✅ workflow native SQLite runtime: WAL/transaction/quick_check passed');
} finally {
  if (db) db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
