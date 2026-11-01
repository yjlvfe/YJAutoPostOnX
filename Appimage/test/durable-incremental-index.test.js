'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkflowStore } = require('../dev/automation/workflowStore');
const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yj-incremental-index-'));
let store;
try {
  store = new WorkflowStore({ rootDir });
  const text = 'أوامر السوق قد تنفذ على عدة مستويات سعرية إذا كان عمق دفتر الأوامر ضعيفا';
  store.indexFtsText(text);
  store.indexFtsText(text);
  assert.strictEqual(store.db.prepare('SELECT COUNT(*) n FROM dedup_fts').get().n, 1, 'repeated indexing must not multiply archive candidates');
  // An existing nonempty FTS must not suppress backfill of missing legacy rows.
  const archived = store.db.prepare('INSERT INTO archived_items (id,state,text,published_at_ms,archived_at_ms) VALUES (?, ?, ?, ?, ?)');
  for (let i = 0; i < 37; i++) archived.run(`legacy-${i}`, 'published', `حماية عبارة الاسترداد القديمة ${i} تمنع فقدان النسخة الاحتياطية للمحفظة`, i, i);
  let page = store.syncDedupIndex({ limit: 7 });
  let visits = page.processed;
  assert.ok(page.processed <= 7, 'backfill must be bounded per event-loop slice');
  store.close();
  store = new WorkflowStore({ rootDir });
  while (!page.done) {
    page = store.syncDedupIndex({ limit: 7 });
    visits += page.processed;
    assert.ok(page.processed <= 7);
  }
  assert.strictEqual(visits, 38, 'FTS rows created and covered by this backfill must not be revisited');
  const old = 'حماية عبارة الاسترداد القديمة 36 تمنع فقدان النسخة الاحتياطية للمحفظة';
  assert.strictEqual(store.reserveExactHash(old), false, 'old archive has durable canonical exact coverage');
  assert.ok(store.searchSimilarTexts(old).includes(old));
  assert.strictEqual(store.db.prepare('SELECT COUNT(*) n FROM dedup_fts').get().n, 38);
  assert.strictEqual(store.db.prepare('SELECT COUNT(*) n FROM archived_items').get().n, 37, 'indexing must not rewrite historical source rows');
  console.log('✅ idempotent bounded archive backfill resumes from disk and covers nonempty partial indexes');
} finally { if (store) store.close(); fs.rmSync(rootDir, { recursive: true, force: true }); }

// Legacy FTS rows need their exact/key entries populated even when the rowid
// sequence is sparse and another connection appends while backfill is paused.
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yj-index-gaps-'));
  let first; let second;
  try {
    first = new WorkflowStore({ rootDir: root });
    const db = first.db;
    const insertArchive = db.prepare('INSERT INTO archived_items (id,state,text,published_at_ms,archived_at_ms) VALUES (?, ?, ?, ?, ?)');
    const archives = ['archive alpha one', 'archive beta two', 'archive gamma three'];
    archives.forEach((text, i) => insertArchive.run(`sparse-${i}`, 'published', text, i, i));
    const insertFts = db.prepare('INSERT INTO dedup_fts (rowid,content,concepts) VALUES (?, ?, ?)');
    insertFts.run(10, 'legacy sparse kiwi', 'legacy sparse kiwi');
    insertFts.run(20, 'legacy sparse kumquat', 'legacy sparse kumquat');
    let page = first.syncDedupIndex({ limit: 1 });
    assert.strictEqual(page.cursor.fts, 10);
    page = first.syncDedupIndex({ limit: 1 });
    assert.strictEqual(page.cursor.fts, 20);
    page = first.syncDedupIndex({ limit: 1 });
    assert.strictEqual(page.cursor.fts, 21, 'new covered row may advance only across a contiguous boundary');
    second = new WorkflowStore({ rootDir: root });
    const external = 'external concurrent persimmon';
    second.indexFtsText(external);
    page = first.syncDedupIndex({ limit: 1 });
    assert.strictEqual(page.cursor.fts, 22);
    assert.strictEqual(first.reserveExactHash(external), false, 'external FTS row still receives exact coverage');
    insertFts.run(40, 'legacy appended dragonfruit', 'legacy appended dragonfruit');
    page = first.syncDedupIndex({ limit: 1 });
    assert.strictEqual(page.cursor.fts, 40, 'sparse unproven legacy row must be scanned');
    assert.strictEqual(first.reserveExactHash('legacy appended dragonfruit'), false);
    while (!page.done) page = first.syncDedupIndex({ limit: 1 });
    assert.strictEqual(db.prepare('SELECT count(*) AS n FROM archived_items').get().n, 3);
    assert.strictEqual(db.prepare('SELECT count(*) AS n FROM dedup_fts').get().n, 7);
    assert.strictEqual(db.prepare('SELECT count(*) AS n FROM dedup_fts_keys').get().n, 7);
    assert.strictEqual(db.prepare('SELECT count(*) AS n FROM dedup_exact_hash').get().n, 7);
    assert.ok(first.searchSimilarTexts('legacy appended dragonfruit').includes('legacy appended dragonfruit'));
    second.close(); second = null;
    first.close(); first = new WorkflowStore({ rootDir: root });
    assert.strictEqual(first.syncDedupIndex({ limit: 1 }).processed, 0);
    assert.strictEqual(first.db.pragma('quick_check', { simple: true }), 'ok');
    console.log('✅ sparse legacy and concurrent unproven FTS rows are scanned and survive reopen');
  } finally {
    if (second) second.close();
    if (first) first.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// An injected SQLite failure after some inserts must roll back the whole page,
// including its cursor, before a later reopen/retry.
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yj-index-rollback-'));
  let check;
  try {
    check = new WorkflowStore({ rootDir: root });
    const db = check.db;
    const insert = db.prepare('INSERT INTO archived_items (id,state,text,published_at_ms,archived_at_ms) VALUES (?, ?, ?, ?, ?)');
    ['rollback alpha', 'rollback beta', 'rollback gamma'].forEach((text, i) => insert.run(`rollback-${i}`, 'published', text, i, i));
    db.exec("CREATE TRIGGER fail_test_exact BEFORE INSERT ON dedup_exact_hash WHEN NEW.text_sample = 'rollback beta' BEGIN SELECT RAISE(ABORT, 'injected backfill failure'); END");
    assert.throws(() => check.syncDedupIndex({ limit: 3 }), /injected backfill failure/);
    for (const table of ['dedup_fts', 'dedup_fts_keys', 'dedup_exact_hash']) {
      assert.strictEqual(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0, `${table} rollback`);
    }
    assert.strictEqual(db.prepare("SELECT count(*) AS n FROM workflow_metadata WHERE key = 'dedup_backfill_v2'").get().n, 0);
    assert.strictEqual(db.prepare('SELECT count(*) AS n FROM archived_items').get().n, 3);
    check.close(); check = new WorkflowStore({ rootDir: root });
    check.db.exec('DROP TRIGGER fail_test_exact');
    let page;
    do { page = check.syncDedupIndex({ limit: 3 }); } while (!page.done);
    for (const table of ['dedup_fts', 'dedup_fts_keys', 'dedup_exact_hash']) {
      assert.strictEqual(check.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 3);
    }
    assert.strictEqual(check.reserveExactHash('rollback beta'), false);
    assert.ok(check.searchSimilarTexts('rollback beta').includes('rollback beta'));
    assert.strictEqual(check.db.pragma('quick_check', { simple: true }), 'ok');
    console.log('✅ injected page failure rolls back cursor and indexes; reopen retry succeeds');
  } finally {
    if (check) check.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
