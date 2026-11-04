'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createHermeticWorkspace } = require('../fixtures/hermetic_workspace');
const { SqliteStore, assertMutationAllowed } = require('../../src/sqliteStore');
const { ForensicLogger, assertForensicMutationAllowed } = require('../../src/forensicLogger');
const { withForensicMutex, mutexDbPath } = require('../../src/forensicMutex');
const { Queue } = require('../../src/queue');
const { settleItem53d0, SETTLEMENT_TARGET } = require('../../scripts/settle_item_53d0f458');

describe('02_durable_sqlite_and_outbox: SqliteStore WAL, OCC Retry, CAS Closure Reset, Worktree Prod Guard, Queue & Outbox', () => {
  it('S-01: SqliteStore load() returns independent snapshots, update() increments revision in WAL mode, and async mutator throws TRANSACTION_ASYNC_YIELD (FINDING-025)', async () => {
    const ws = createHermeticWorkspace('yj-bot-test-s01-');
    try {
      const store = ws.registerStore(new SqliteStore(ws.dbPath, { items: [], counter: 0 }));
      const initial = await store.load();
      assert.deepStrictEqual(initial, { items: [], counter: 0 });
      initial.counter = 999; // Mutating returned snapshot must not affect store
      const second = await store.load();
      assert.strictEqual(second.counter, 0);

      await store.update(s => {
        s.counter += 1;
        return s;
      });
      const updated = await store.load();
      assert.strictEqual(updated.counter, 1);

      // TRANSACTION_ASYNC_YIELD inside _transaction or update()
      assert.throws(
        () => store._transaction(async () => ({})),
        /TRANSACTION_ASYNC_YIELD/
      );
      await assert.rejects(
        async () => store.update(async s => {
          await new Promise(r => setTimeout(r, 5));
          s.counter = 500;
          return s;
        }),
        /TRANSACTION_ASYNC_YIELD/
      );
      const afterRollback = await store.load();
      assert.strictEqual(afterRollback.counter, 1);
    } finally {
      await ws.cleanup();
    }
  });

  it('S-02: OCC revision conflict retry resets CAS closure flags on Pass 2 when competing writer disables account (PERSIST-OBS-04 / RUN-02)', async () => {
    const ws = createHermeticWorkspace('yj-bot-test-s02-');
    try {
      const storeA = ws.registerStore(new SqliteStore(ws.dbPath, {
        cycle: { state: 'running', runId: 'run-1' },
        accounts: [{
          id: 'acc-1',
          username: 'user1',
          userId: '1001',
          cookieFile: '/tmp/c1',
          checkGeneration: 'gen-1',
          enabled: true,
          status: 'مفعل'
        }],
        items: [{
          id: 'item-1',
          state: 'processing',
          payload: { text: 'Hello' },
          attempt: {
            phase: 'claimed',
            token: 'tok-1',
            runId: 'run-1',
            accountId: 'acc-1'
          }
        }]
      }));
      await storeA.load();

      const rawDb = new DatabaseSync(ws.dbPath);
      try {
        let passCount = 0;
        let dispatchReady = false;

        await storeA.update(s => {
          dispatchReady = false;
          passCount += 1;
          const i = s.items.find(x => x.id === 'item-1');
          const a = s.accounts.find(x => x.id === 'acc-1' && x.enabled !== false && !x.needsOwnerCaptcha);
          if (
            s.cycle?.state === 'running' &&
            i?.state === 'processing' &&
            i.attempt?.phase === 'claimed' &&
            i.attempt?.token === 'tok-1' &&
            a
          ) {
            i.attempt.phase = 'dispatching';
            dispatchReady = true;
          }
          // If storeA runs mutator outside BEGIN IMMEDIATE, simulate competing commit after Pass 1
          if (passCount === 1 && !storeA.db.isTransaction) {
            const row = rawDb.prepare('SELECT json, revision FROM state WHERE id = 1').get();
            const parsed = JSON.parse(row.json);
            parsed.accounts[0].enabled = false;
            parsed.accounts[0].needsOwnerCaptcha = true;
            parsed.accounts[0].status = 'كابتشا (مطلوب حل يدوي)';
            rawDb.prepare('UPDATE state SET json = ?, revision = revision + 1 WHERE id = 1 AND revision = ?')
              .run(JSON.stringify(parsed), row.revision);
          }
          return s;
        });

        const finalState = await storeA.load();
        if (passCount > 1) {
          assert.strictEqual(dispatchReady, false, 'Pass 2 must reset dispatchReady to false when competing writer disabled account');
          assert.strictEqual(finalState.items[0].attempt.phase, 'claimed');
        } else {
          // When update() executes mutator inside BEGIN IMMEDIATE, competing writers are serialized at SQLite engine level
          assert.strictEqual(passCount, 1);
          assert.strictEqual(dispatchReady, true);
          assert.strictEqual(finalState.items[0].attempt.phase, 'dispatching');
        }
      } finally {
        rawDb.close();
      }
    } finally {
      await ws.cleanup();
    }
  });

  it('S-03: Worktree-aware production DB & forensic mutation guard blocks mutations targeting both worktree and canonical /root/Projects/YJAutoPostOnX/Bot/data (PERSIST-OBS-05)', async () => {
    const worktreeProdDb = path.resolve(__dirname, '../../data/state.sqlite');
    const canonicalProdDb = '/root/Projects/YJAutoPostOnX/Bot/data/state.sqlite';
    const worktreeProdData = path.resolve(__dirname, '../../data');
    const canonicalProdData = '/root/Projects/YJAutoPostOnX/Bot/data';

    assert.throws(
      () => assertMutationAllowed(worktreeProdDb),
      err => /PROD_DB_MUTATION_FORBIDDEN|PRODUCTION_DB_MUTATION_FORBIDDEN/.test(err.code || err.message)
    );
    assert.throws(
      () => assertMutationAllowed(canonicalProdDb),
      err => /PROD_DB_MUTATION_FORBIDDEN|PRODUCTION_DB_MUTATION_FORBIDDEN/.test(err.code || err.message)
    );
    assert.throws(
      () => assertForensicMutationAllowed(worktreeProdData),
      err => /PROD_FORENSIC_MUTATION_FORBIDDEN|PRODUCTION_FORENSIC_MUTATION_FORBIDDEN/.test(err.code || err.message)
    );
    assert.throws(
      () => assertForensicMutationAllowed(canonicalProdData),
      err => /PROD_FORENSIC_MUTATION_FORBIDDEN|PRODUCTION_FORENSIC_MUTATION_FORBIDDEN/.test(err.code || err.message)
    );
  });

  it('S-04: ForensicLogger transactional outbox replay, fail-closed reconcile on load/read error (PERSIST-OBS-01), and ForensicMutex dead-PID reclamation', async () => {
    const ws = createHermeticWorkspace('yj-bot-test-s04-');
    try {
      const store = ws.registerStore(new SqliteStore(ws.dbPath, { forensicLogs: [], pendingForensicOutbox: [] }));
      const logger = new ForensicLogger({ store, dataDir: ws.tempDir, logFile: ws.logFile });

      // Record event and verify it lands in both SQLite and JSONL and clears outbox
      const rec = await logger.record({
        id: 'evt-1',
        eventType: 'post_ambiguous',
        accountId: 'acc-1',
        xErrorMessage: 'secret auth_token=hidden123'
      });
      assert.ok(!rec.xErrorMessage.includes('hidden123'));

      await logger.flushOutbox();
      const s1 = await store.load();
      assert.strictEqual((s1.pendingForensicOutbox || []).length, 0);
      const fileContent1 = fs.readFileSync(ws.logFile, 'utf8');
      assert.ok(fileContent1.includes('evt-1'));

      // Simulate crash between SQLite outbox write and JSONL append
      await store.update(s => {
        const crashEvent = {
          id: 'evt-crash-2',
          timestamp: new Date().toISOString(),
          epoch: Date.now(),
          eventType: 'post_success',
          accountId: 'acc-1'
        };
        s.forensicLogs.push(crashEvent);
        s.pendingForensicOutbox ||= [];
        s.pendingForensicOutbox.push(crashEvent);
        return s;
      });

      const flushRes = await logger.flushOutbox();
      assert.strictEqual(flushRes.flushed, 1);
      assert.strictEqual(flushRes.newlyAppended, 1);
      // Second flush is idempotent
      const flushRes2 = await logger.flushOutbox();
      assert.strictEqual(flushRes2.flushed, 0);

      // PERSIST-OBS-01: reconcile() must fail closed if store.load() throws (never wiping forensic.jsonl!)
      const failingStore = {
        async load() {
          throw new Error('SIMULATED_SQLITE_READ_ERROR');
        },
        async update() {
          throw new Error('SHOULD_NOT_BE_CALLED');
        }
      };
      const failingLogger = new ForensicLogger({ store: failingStore, dataDir: ws.tempDir, logFile: ws.logFile });
      await assert.rejects(() => failingLogger.reconcile(), /SIMULATED_SQLITE_READ_ERROR/);

      const survivingLines = fs.readFileSync(ws.logFile, 'utf8').trim().split('\n').filter(Boolean);
      assert.strictEqual(survivingLines.length, 2, 'forensic.jsonl must remain intact after failed store.load()');

      // ForensicMutex dead-PID lock reclamation
      const mPath = mutexDbPath(ws.logFile);
      const mDb = new DatabaseSync(mPath);
      try {
        mDb.exec(`CREATE TABLE IF NOT EXISTS forensic_mutex (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          owner_pid INTEGER NOT NULL,
          owner_start TEXT NOT NULL,
          owner_token TEXT NOT NULL
        );`);
        // PID 99999999 is guaranteed non-existent (ESRCH)
        mDb.prepare('INSERT OR REPLACE INTO forensic_mutex (id, owner_pid, owner_start, owner_token) VALUES (1, 99999999, ?, ?)')
          .run('12345', 'dead-token');
      } finally {
        mDb.close();
      }

      let acquiredInsideMutex = false;
      await withForensicMutex(ws.logFile, async () => {
        acquiredInsideMutex = true;
      }, { timeoutMs: 2000 });
      assert.strictEqual(acquiredInsideMutex, true, 'ForensicMutex must reclaim lock held by dead PID');
    } finally {
      await ws.cleanup();
    }
  });

  it('S-05: Queue.requeue blocks ambiguous/published items with AMBIGUOUS_REQUEUE_FORBIDDEN (PERSIST-OBS-02 / XT-04) and recoverProcessing archives claimed attempts', async () => {
    const ws = createHermeticWorkspace('yj-bot-test-s05-');
    try {
      const store = ws.registerStore(new SqliteStore(ws.dbPath, {
        items: [
          {
            id: 'item-claimed',
            state: 'processing',
            payload: { text: 'Claimed pre-dispatch', account: 'acc-1' },
            attempt: { phase: 'claimed', token: 'tok-c', accountId: 'acc-1' }
          },
          {
            id: 'item-dispatching',
            state: 'processing',
            payload: { text: 'In-flight post-dispatch', account: 'acc-1' },
            attempt: { phase: 'dispatching', token: 'tok-d', accountId: 'acc-1' }
          },
          {
            id: 'item-ambiguous',
            state: 'ambiguous',
            payload: { text: 'Already quarantined' }
          },
          {
            id: 'item-published',
            state: 'published',
            url: 'https://x.com/u/status/1',
            payload: { text: 'Already published' }
          }
        ]
      }));
      const queue = new Queue(store);

      // Startup crash recovery
      await queue.recoverProcessing({ state: 'ambiguous', reason: 'startup_crash_recovery' });
      const recovered = await store.load();
      const cItem = recovered.items.find(i => i.id === 'item-claimed');
      const dItem = recovered.items.find(i => i.id === 'item-dispatching');
      assert.strictEqual(cItem.state, 'pending', 'Pre-dispatch claimed item must revert to pending');
      assert.strictEqual(cItem.payload.account, 'acc-1', 'Pinned account must be preserved');
      assert.strictEqual(dItem.state, 'ambiguous', 'Post-dispatch item must be quarantined as ambiguous');

      // PERSIST-OBS-02 / XT-04: Queue.requeue on ambiguous or published item MUST throw AMBIGUOUS_REQUEUE_FORBIDDEN
      await assert.rejects(
        () => queue.requeue('item-ambiguous'),
        err => err.code === 'AMBIGUOUS_REQUEUE_FORBIDDEN' || /AMBIGUOUS_REQUEUE_FORBIDDEN/.test(err.message)
      );
      await assert.rejects(
        () => queue.requeue('item-published'),
        err => err.code === 'AMBIGUOUS_REQUEUE_FORBIDDEN' || /AMBIGUOUS_REQUEUE_FORBIDDEN/.test(err.message)
      );

      const afterReject = await store.load();
      assert.strictEqual(afterReject.items.find(i => i.id === 'item-ambiguous').state, 'ambiguous');
      assert.strictEqual(afterReject.items.find(i => i.id === 'item-published').state, 'published');
    } finally {
      await ws.cleanup();
    }
  });

  it('S-06: settle_item_53d0f458.js enforces full 64-char SHA-256 CAS, 9->10 quota rule, outbox dual-write, and production gate', async () => {
    const ws = createHermeticWorkspace('yj-bot-test-s06-');
    try {
      // 1. Production DB path is blocked without explicit approval
      const blocked = await settleItem53d0({
        dbPath: path.resolve(__dirname, '../../data/state.sqlite'),
        logFilePath: ws.logFile,
        isApply: true,
        allowProdSettlement: false
      });
      assert.strictEqual(blocked.settled, false);
      assert.strictEqual(blocked.status, 'BLOCKED_PENDING_OWNER_APPROVAL');

      // 2. Seed temp DB with tampered 1-char text -> must reject with FULL_SHA256_MISMATCH
      const store = new SqliteStore(ws.dbPath, {
        items: [{
          id: SETTLEMENT_TARGET.id,
          state: 'ambiguous',
          accountId: SETTLEMENT_TARGET.accountId,
          payload: { text: SETTLEMENT_TARGET.fullText + '!' },
          attempt: { token: 'old-tok', phase: 'dispatching' }
        }],
        posting: {
          quota: {
            [SETTLEMENT_TARGET.historicalDay]: { [SETTLEMENT_TARGET.accountId]: 9 }
          }
        }
      });
      await store.load();
      await store.close();

      await assert.rejects(
        () => settleItem53d0({ dbPath: ws.dbPath, logFilePath: ws.logFile, isApply: true }),
        /FULL_SHA256_MISMATCH/
      );

      // 3. Fix text to exact full SHA-256 match and settle 9 -> 10
      const storeFix = new SqliteStore(ws.dbPath);
      await storeFix.update(s => {
        s.items[0].payload.text = SETTLEMENT_TARGET.fullText;
        return s;
      });
      await storeFix.close();

      const res = await settleItem53d0({ dbPath: ws.dbPath, logFilePath: ws.logFile, isApply: true });
      assert.strictEqual(res.settled, true);
      assert.strictEqual(res.status, 'APPLIED');

      const verifyStore = ws.registerStore(new SqliteStore(ws.dbPath));
      const settledState = await verifyStore.load();
      const item = settledState.items.find(i => i.id === SETTLEMENT_TARGET.id);
      assert.strictEqual(item.state, 'published');
      assert.strictEqual(item.url, SETTLEMENT_TARGET.url);
      assert.strictEqual(item.archivedAttempt?.token, 'old-tok');
      assert.strictEqual(item.attempt, undefined);
      assert.strictEqual(
        settledState.posting.quota[SETTLEMENT_TARGET.historicalDay][SETTLEMENT_TARGET.accountId],
        10
      );
      assert.strictEqual((settledState.pendingForensicOutbox || []).length, 0);
      assert.ok(fs.readFileSync(ws.logFile, 'utf8').includes('m14_settle_53d0f458_snowflake_published'));

      // 4. Re-running settlement is an idempotent no-op (quota stays 10, never 11)
      await verifyStore.close();
      const idempotentRes = await settleItem53d0({ dbPath: ws.dbPath, logFilePath: ws.logFile, isApply: true });
      assert.strictEqual(idempotentRes.status, 'NOOP');
    } finally {
      await ws.cleanup();
    }
  });
});
