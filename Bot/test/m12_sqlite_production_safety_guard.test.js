'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { SqliteStore, getCanonicalProdDbPath } = require('../src/sqliteStore');
const { ForensicLogger, getCanonicalProdDataDir } = require('../src/forensicLogger');

function fileSha256(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const data = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

describe('M12: SQLite Production Safety Guard & Isolation Verification', () => {
  const prodDbPath = getCanonicalProdDbPath();
  const prodDataDir = getCanonicalProdDataDir();
  let prodHashBefore = null;
  let prodSizeBefore = null;

  before(() => {
    if (fs.existsSync(prodDbPath)) {
      prodHashBefore = fileSha256(prodDbPath);
      prodSizeBefore = fs.statSync(prodDbPath).size;
    }
  });

  after(() => {
    // Assert production database was not touched at all
    if (fs.existsSync(prodDbPath)) {
      const prodHashAfter = fileSha256(prodDbPath);
      const prodSizeAfter = fs.statSync(prodDbPath).size;
      assert.strictEqual(prodHashAfter, prodHashBefore, 'FATAL: Production state.sqlite hash was modified during test!');
      assert.strictEqual(prodSizeAfter, prodSizeBefore, 'FATAL: Production state.sqlite size changed during test!');
    }
  });

  it('1. SqliteStore rejects save() on production database when in test environment', async () => {
    const store = new SqliteStore(prodDbPath);
    await assert.rejects(
      async () => {
        await store.save({ items: [] });
      },
      err => {
        assert.strictEqual(err.code, 'PROD_DB_MUTATION_FORBIDDEN_IN_TEST');
        assert.match(err.message, /Tests are strictly forbidden from mutating the production database/);
        return true;
      }
    );
  });

  it('2. SqliteStore rejects update() on production database when in test environment', async () => {
    const store = new SqliteStore(prodDbPath);
    await assert.rejects(
      async () => {
        await store.update(s => {
          s.items = [];
          return s;
        });
      },
      err => {
        assert.strictEqual(err.code, 'PROD_DB_MUTATION_FORBIDDEN_IN_TEST');
        assert.match(err.message, /Tests are strictly forbidden from mutating the production database/);
        return true;
      }
    );
  });

  it('3. ForensicLogger rejects prune() targeting production data directory', async () => {
    const logger = new ForensicLogger({ dataDir: prodDataDir });
    await assert.rejects(
      async () => {
        await logger.prune();
      },
      err => {
        assert.strictEqual(err.code, 'PROD_FORENSIC_MUTATION_FORBIDDEN_IN_TEST');
        assert.match(err.message, /Tests are strictly forbidden from mutating production forensic logs/);
        return true;
      }
    );
  });

  it('4. ForensicLogger rejects reconcile() targeting production data directory', async () => {
    const logger = new ForensicLogger({ dataDir: prodDataDir });
    await assert.rejects(
      async () => {
        await logger.reconcile();
      },
      err => {
        assert.strictEqual(err.code, 'PROD_FORENSIC_MUTATION_FORBIDDEN_IN_TEST');
        assert.match(err.message, /Tests are strictly forbidden from mutating production forensic logs/);
        return true;
      }
    );
  });

  it('5. Isolated temporary test database performs mutations and prune/reconcile cleanly', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm12-safe-test-'));
    try {
      const testDb = path.join(tempDir, 'state.sqlite');
      const store = new SqliteStore(testDb, { items: [{ id: 'test-1', state: 'pending' }] });

      // Save
      await store.save({ items: [{ id: 'test-1', state: 'processing' }] });
      const loaded1 = await store.load();
      assert.strictEqual(loaded1.items[0].state, 'processing');

      // Update
      await store.update(s => {
        s.items[0].state = 'published';
        return s;
      });
      const loaded2 = await store.load();
      assert.strictEqual(loaded2.items[0].state, 'published');

      // Forensic logger in tempDir
      const now = Date.now();
      const logger = new ForensicLogger({
        store,
        dataDir: tempDir,
        clock: () => now
      });

      await logger.record({ eventType: 'test_event', details: { ok: true } });
      const pruneRes = await logger.prune();
      assert.strictEqual(pruneRes.prunedCount, 0);

      const recRes = await logger.reconcile();
      assert.strictEqual(recRes.reconciled, true);

      await store.close();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      assert.strictEqual(fs.existsSync(tempDir), false, 'Temporary test directory must be completely removed');
    }
  });

  it('6. Concurrency conflict retry and rollback on error in isolated test database', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm12-concurrency-test-'));
    try {
      const testDb = path.join(tempDir, 'state.sqlite');
      const store = new SqliteStore(testDb, { counter: 0 });

      // Concurrent updates
      const workers = Array.from({ length: 10 }, () =>
        store.update(s => {
          s.counter = (s.counter || 0) + 1;
          return s;
        })
      );
      await Promise.all(workers);

      const finalState = await store.load();
      assert.strictEqual(finalState.counter, 10, 'All 10 concurrent updates must serialize without loss');

      // Mid-write failure and rollback
      await assert.rejects(
        async () => {
          await store.update(() => {
            throw new Error('INTENTIONAL_MUTATOR_FAILURE');
          });
        },
        /INTENTIONAL_MUTATOR_FAILURE/
      );

      // Verify state was rolled back and untouched
      const rolledBackState = await store.load();
      assert.strictEqual(rolledBackState.counter, 10, 'Counter must remain 10 after failed update');

      await store.close();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('7. settle_item_53d0f458 atomically settles item, archives attempt, and adjusts only historical Nov 1 quota', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm12-settle-test-'));
    try {
      const dbPath = path.join(tempDir, 'state.sqlite');
      const logPath = path.join(tempDir, 'forensic.jsonl');
      const { settleItem53d0, SETTLEMENT_TARGET } = require('../scripts/settle_item_53d0f458');

      const initialItem = {
        id: SETTLEMENT_TARGET.id,
        state: 'ambiguous',
        reason: 'unresolved_in_finally',
        payload: {
          text: SETTLEMENT_TARGET.fullText,
          account: SETTLEMENT_TARGET.accountId
        },
        attempt: {
          token: 'token-53d0-test',
          phase: 'dispatching',
          startedAt: '2026-11-01T19:50:53.963Z'
        }
      };

      const initialQuota = {
        '2026-11-01': { [SETTLEMENT_TARGET.accountId]: 9 },
        '2026-11-03': { [SETTLEMENT_TARGET.accountId]: 10 }
      };

      const store = new SqliteStore(dbPath, {
        items: [initialItem],
        posting: { quota: initialQuota },
        forensicLogs: []
      });
      await store.load();
      await store.close();

      // 1. Dry run verification
      const dryRes = await settleItem53d0({ dbPath, logFilePath: logPath, isApply: false });
      assert.strictEqual(dryRes.settled, false, 'Dry run must not settle');

      const storeDry = new SqliteStore(dbPath);
      const stateDry = await storeDry.load();
      await storeDry.close();
      assert.strictEqual(stateDry.items[0].state, 'ambiguous', 'State must remain ambiguous after dry-run');

      // 2. Apply settlement
      const applyRes = await settleItem53d0({ dbPath, logFilePath: logPath, isApply: true });
      assert.strictEqual(applyRes.settled, true, 'Apply must settle item');

      const storeApplied = new SqliteStore(dbPath);
      const stateApplied = await storeApplied.load();
      await storeApplied.close();

      const settledItem = stateApplied.items[0];
      assert.strictEqual(settledItem.state, 'published');
      assert.strictEqual(settledItem.outcome, 'published');
      assert.strictEqual(settledItem.tweetId, SETTLEMENT_TARGET.tweetId);
      assert.strictEqual(settledItem.url, SETTLEMENT_TARGET.url);
      assert.strictEqual(settledItem.publishedAt, SETTLEMENT_TARGET.publishedAt);
      assert.strictEqual(settledItem.attempt, undefined, 'Active attempt must be cleared');
      assert.ok(settledItem.archivedAttempt, 'archivedAttempt must be saved');
      assert.strictEqual(settledItem.archivedAttempt.token, 'token-53d0-test');

      // Verify quota: Nov 1 incremented from 9 to 10; Nov 3 unchanged at 10!
      assert.strictEqual(stateApplied.posting.quota['2026-11-01'][SETTLEMENT_TARGET.accountId], 10, 'Nov 1 quota must be 10');
      assert.strictEqual(stateApplied.posting.quota['2026-11-03'][SETTLEMENT_TARGET.accountId], 10, 'Nov 3 quota must NOT be double-counted (remains 10)');

      // Verify audit log
      const auditEvt = (stateApplied.forensicLogs || []).find(e => e.eventType?.includes('settle_53d0f458_snowflake_published'));
      assert.ok(auditEvt, 'Settlement audit event must exist in forensicLogs');
      assert.ok(auditEvt.id, 'Audit event must have unique id');
      assert.ok(auditEvt.epoch, 'Audit event must have numeric epoch');

      // Verify log file
      assert.ok(fs.existsSync(logPath), 'Log file must be created');
      const logContent = fs.readFileSync(logPath, 'utf8');
      assert.ok(logContent.includes('settle_53d0f458_snowflake_published'));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('8. settle_item_53d0f458 enforces Compare-and-Set and prevents duplicate quota increment', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm13-cas-test-'));
    try {
      const dbPath = path.join(tempDir, 'state.sqlite');
      const logPath = path.join(tempDir, 'forensic.jsonl');
      const { settleItem53d0, SETTLEMENT_TARGET } = require('../scripts/settle_item_53d0f458');

      // Initial state: Item is in 'processing' (not ambiguous) -> CAS should reject
      const store = new SqliteStore(dbPath, {
        items: [{
          id: SETTLEMENT_TARGET.id,
          state: 'processing',
          payload: { text: SETTLEMENT_TARGET.fullText }
        }],
        posting: { quota: { '2026-11-01': { [SETTLEMENT_TARGET.accountId]: 9 } } }
      });
      await store.load();
      await store.close();

      await assert.rejects(
        () => settleItem53d0({ dbPath, logFilePath: logPath, isApply: true }),
        /INVALID_ITEM_STATE/
      );

      // Now set to ambiguous with valid text prefix
      const store2 = new SqliteStore(dbPath);
      await store2.update(s => {
        s.items[0].state = 'ambiguous';
        return s;
      });
      await store2.close();

      // First apply should succeed
      const res1 = await settleItem53d0({ dbPath, logFilePath: logPath, isApply: true });
      assert.strictEqual(res1.settled, true);

      // Verify quota is 10
      const store3 = new SqliteStore(dbPath);
      const state3 = await store3.load();
      assert.strictEqual(state3.posting.quota['2026-11-01'][SETTLEMENT_TARGET.accountId], 10);
      await store3.close();

      // Re-running apply on already published item should be an idempotent no-op without re-incrementing quota
      const res2 = await settleItem53d0({ dbPath, logFilePath: logPath, isApply: true });
      assert.strictEqual(res2.settled, false, 'Second run must be idempotent no-op');

      const store4 = new SqliteStore(dbPath);
      const state4 = await store4.load();
      assert.strictEqual(state4.posting.quota['2026-11-01'][SETTLEMENT_TARGET.accountId], 10, 'Quota must remain 10 (no double increment)');
      await store4.close();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('9. settle_item_53d0f458 blocks execution on production db unless explicitly approved', async () => {
    const { settleItem53d0 } = require('../scripts/settle_item_53d0f458');
    const res = await settleItem53d0({ isApply: true });
    assert.strictEqual(res.settled, false);
    assert.strictEqual(res.status, 'BLOCKED_PENDING_OWNER_APPROVAL');
  });

  it('10. isXContentRejection classifies 187, 186 and explicit rejection reasons without account strikes', () => {
    const { isXContentRejection } = require('../src/xFailureClassification');
    assert.strictEqual(isXContentRejection({ failure: 'ambiguous', xResponseKind: 'graphql_errors', xErrorCode: 187 }), true);
    assert.strictEqual(isXContentRejection({ failure: 'ambiguous', xResponseKind: 'graphql_errors', xErrorCode: 186 }), true);
    assert.strictEqual(isXContentRejection({ failure: 'ambiguous', xResponseKind: 'graphql_errors', xErrorCode: 226 }), false);
    assert.strictEqual(isXContentRejection({ rejectionReason: 'duplicate_content' }), true);
    assert.strictEqual(isXContentRejection({ rejectionReason: 'length_exceeded' }), true);
    assert.strictEqual(isXContentRejection({ rejectionReason: 'tweet_tombstone' }), true);
    assert.strictEqual(isXContentRejection({ failure: 'banned', xResponseKind: 'graphql_errors', xErrorCode: 187 }), false);
    assert.strictEqual(isXContentRejection({ failure: 'ambiguous', xResponseKind: 'graphql_errors', xErrorCode: 326 }), false);
  });
});
