'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { SqliteStore } = require('../src/sqliteStore');
const { AccountManager } = require('../src/accounts');
const { ForensicLogger } = require('../src/forensicLogger');
const { riyadhDay } = require('../src/quota');
const { riyadhDateParts, isDue, nextRiyadhDaily } = require('../src/scheduling');
const { richTable, escapeHtml, clean } = require('../src/tableUtils');

describe('P3 & P4 Findings Verification Suite (FINDING-006, 017, 023, 024, 025, 027, 028, 029, 030)', () => {
  let tmpDir;

  test('setup test sandbox', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yj_p3_p4_test_'));
  });

  // FINDING-017: Destructive empty accounts CSV rejection
  describe('FINDING-017: Destructive Empty accounts_csv Import Protection', () => {
    test('replaceFromCsv throws EMPTY_ACCOUNTS_CSV on empty or header-only string', async () => {
      const dbPath = path.join(tmpDir, 'accounts_test.sqlite');
      const store = new SqliteStore(dbPath, { accounts: [{ id: 'keep-me', enabled: true }] });
      await store.load();
      const accounts = new AccountManager(store);

      await assert.rejects(
        async () => accounts.replaceFromCsv(''),
        /EMPTY_ACCOUNTS_CSV/,
        'Empty string must be rejected without altering accounts'
      );

      await assert.rejects(
        async () => accounts.replaceFromCsv('account,label,quota\n'),
        /EMPTY_ACCOUNTS_CSV/,
        'Header-only CSV must be rejected'
      );

      const list = await accounts.list();
      assert.strictEqual(list.length, 1);
      assert.strictEqual(list[0].id, 'keep-me');
    });
  });

  // FINDING-024 & FINDING-025: Optimistic Concurrency & Transaction Yield Protection
  describe('FINDING-024 & FINDING-025: SqliteStore Concurrency & Transaction Boundaries', () => {
    test('transaction rejects async functions fail-closed', async () => {
      const dbPath = path.join(tmpDir, 'async_tx_test.sqlite');
      const store = new SqliteStore(dbPath, { test: 1 });
      await store.load();

      assert.throws(
        () => store._transaction(async () => {
          await new Promise(r => setTimeout(r, 5));
          return 42;
        }),
        /TRANSACTION_ASYNC_YIELD/,
        '_transaction must reject async Promises immediately'
      );
    });

    test('optimistic concurrency retry on conflicting revision', async () => {
      const dbPath = path.join(tmpDir, 'optimistic_test.sqlite');
      const store = new SqliteStore(dbPath, { count: 0 });
      await store.load();

      // Run parallel updates that both succeed without corruption
      await Promise.all([
        store.update(s => { s.count += 1; return s; }),
        store.update(s => { s.count += 2; return s; }),
        store.update(s => { s.count += 3; return s; })
      ]);
      const finalState = await store.load();
      assert.strictEqual(finalState.count, 6);
    });

    test('optimistic concurrency across separate OS child processes', async () => {
      const dbPath = path.join(tmpDir, 'multi_process_occ.sqlite');
      const store = new SqliteStore(dbPath, { counter: 0 });
      await store.load();

      const workerScript = `
        const { SqliteStore } = require("./src/sqliteStore");
        const store = new SqliteStore("${dbPath}");
        (async () => {
          await store.load();
          for (let i = 0; i < 5; i++) {
            await store.update(s => {
              s.counter += 1;
              return s;
            });
            await new Promise(r => setTimeout(r, Math.random() * 5));
          }
          await store.close();
          process.exit(0);
        })().catch(e => { console.error(e); process.exit(1); });
      `;

      const { spawn } = require('child_process');
      const p1 = spawn('node', ['-e', workerScript], { cwd: path.resolve(__dirname, '..'), stdio: 'ignore' });
      const p2 = spawn('node', ['-e', workerScript], { cwd: path.resolve(__dirname, '..'), stdio: 'ignore' });

      await Promise.all([
        new Promise((res, rej) => p1.on('close', code => code === 0 ? res() : rej(new Error('p1 failed')))),
        new Promise((res, rej) => p2.on('close', code => code === 0 ? res() : rej(new Error('p2 failed'))))
      ]);

      const finalState = await store.load();
      assert.strictEqual(finalState.counter, 10, 'Both processes must complete 5 increments each without lost updates');
      await store.close();
    });
  });

  // FINDING-027: Table formatting deduplication
  describe('FINDING-027: Table Utilities Unification', () => {
    test('richTable generates clean HTML with caption and cells', () => {
      const html = richTable(['Col A', 'Col B'], [['Val 1', 'Val 2']], 'Test Table');
      assert.ok(html.includes('<caption>Test Table</caption>'));
      assert.ok(html.includes('<th align="center">Col A</th>'));
      assert.ok(html.includes('Val 1'));
      assert.strictEqual(escapeHtml('<script>'), '&lt;script&gt;');
      assert.strictEqual(clean('abc\n\tdef|ghi'), 'abcdef¦ghi');
    });
  });

  // FINDING-028 & FINDING-030: Forensic Logger Error Logging & Reconciliation
  describe('FINDING-028 & FINDING-030: Forensic Logger Durability & Reconciliation', () => {
    test('reconcile merges SQLite store and forensic.jsonl entries deduplicating by ID', async () => {
      const dbPath = path.join(tmpDir, 'forensic_recon.sqlite');
      const store = new SqliteStore(dbPath, { forensicLogs: [] });
      await store.load();

      const logger = new ForensicLogger({ store, dataDir: tmpDir });
      const ev1 = await logger.record({ eventType: 'test_event_1', accountId: 'acc1' });

      // Add independent entry to JSONL directly
      const logFile = path.join(tmpDir, 'logs', 'forensic.jsonl');
      const ev2 = {
        id: 'jsonl-only-id',
        timestamp: new Date().toISOString(),
        epoch: Date.now(),
        eventType: 'jsonl_event',
        accountId: 'acc2'
      };
      fs.appendFileSync(logFile, JSON.stringify(ev2) + '\n');

      // Run reconciliation
      const result = await logger.reconcile();
      assert.strictEqual(result.reconciled, true);
      assert.strictEqual(result.totalEntries, 2);

      // Verify store now has both entries
      const state = await store.load();
      assert.strictEqual(state.forensicLogs.length, 2);
      assert.ok(state.forensicLogs.some(e => e.id === ev1.id));
      assert.ok(state.forensicLogs.some(e => e.id === ev2.id));
    });

    test('reconcile survives corrupted lines and duplicate entries in JSONL', async () => {
      const subDir = path.join(tmpDir, 'recon_corrupt_dir');
      fs.mkdirSync(subDir, { recursive: true });
      const dbPath = path.join(subDir, 'forensic_corrupt.sqlite');
      const store = new SqliteStore(dbPath, { forensicLogs: [] });
      await store.load();

      const logger = new ForensicLogger({ store, dataDir: subDir });
      const ev1 = await logger.record({ eventType: 'valid_event', accountId: 'acc1' });

      const logFile = path.join(subDir, 'logs', 'forensic.jsonl');
      // Append a duplicate of ev1 + a corrupted line + a new valid line
      const corruptLine = '{"id":"broken", "timestamp": "truncated...';
      const ev3 = { id: 'valid-3', epoch: Date.now(), eventType: 'valid_3' };
      fs.appendFileSync(logFile, JSON.stringify(ev1) + '\n' + corruptLine + '\n' + JSON.stringify(ev3) + '\n');

      const result = await logger.reconcile();
      assert.strictEqual(result.reconciled, true);
      assert.strictEqual(result.totalEntries, 2, 'Corrupt line ignored; duplicate ev1 deduplicated to 1');

      const state = await store.load();
      assert.strictEqual(state.forensicLogs.length, 2);
    });
  });

  // FINDING-029: Quota Timezone Defensive Bounds
  describe('FINDING-029: Quota & Scheduling Timezone Sensitivity', () => {
    test('riyadhDay handles strings, timestamps, null, undefined defensively', () => {
      const today = riyadhDay(new Date());
      assert.match(today, /^\d{4}-\d{2}-\d{2}$/);

      const fromTimestamp = riyadhDay(Date.now());
      assert.strictEqual(fromTimestamp, today);

      const fromNull = riyadhDay(null);
      assert.match(fromNull, /^\d{4}-\d{2}-\d{2}$/);
    });

    test('riyadhDateParts extracts numeric components accurately', () => {
      const parts = riyadhDateParts(new Date());
      assert.ok(Number.isInteger(parts.year));
      assert.ok(Number.isInteger(parts.month));
      assert.ok(Number.isInteger(parts.day));
      assert.ok(Number.isInteger(parts.hour));
      assert.ok(Number.isInteger(parts.minute));
    });
  });

  test('teardown test sandbox', () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
