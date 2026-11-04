'use strict';
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SqliteStore } = require('../src/sqliteStore');
const { ForensicLogger } = require('../src/forensicLogger');
const { settleItem53d0, SETTLEMENT_TARGET } = require('../scripts/settle_item_53d0f458');

describe('M14: Outbox Automatic Drain & Quota Baseline Idempotency Tests', () => {
  let tempDir;
  let dbPath;
  let logPath;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm14-outbox-quota-'));
    dbPath = path.join(tempDir, 'state.sqlite');
    logPath = path.join(tempDir, 'logs', 'forensic.jsonl');
  });

  after(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    if (fs.existsSync(logPath)) fs.unlinkSync(logPath);
  });

  it('1. ForensicLogger.prototype.flushOutbox automatically drains pending events with durable append', async () => {
    const event1 = { id: 'evt-out-1', timestamp: new Date().toISOString(), eventType: 'test_event_1' };
    const event2 = { id: 'evt-out-2', timestamp: new Date().toISOString(), eventType: 'test_event_2' };

    const store = new SqliteStore(dbPath, {
      pendingForensicOutbox: [event1, event2]
    });
    await store.load();

    const logger = new ForensicLogger({
      dataDir: tempDir,
      store,
      logFile: logPath
    });

    const res = await logger.flushOutbox();
    assert.strictEqual(res.flushed, 2);
    assert.strictEqual(res.newlyAppended, 2);

    // Verify written to JSONL
    assert.ok(fs.existsSync(logPath));
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 2);

    // Verify outbox cleared in SQLite
    const state = await store.load();
    assert.strictEqual(state.pendingForensicOutbox.length, 0);
    await store.close();
  });

  it('2. ForensicLogger.prototype.reconcile absorbs pendingForensicOutbox and clears outbox', async () => {
    const event = { id: 'evt-reconcile-1', epoch: Date.now(), timestamp: new Date().toISOString(), eventType: 'reconcile_event' };
    const store = new SqliteStore(dbPath, {
      forensicLogs: [],
      pendingForensicOutbox: [event]
    });
    await store.load();

    const logger = new ForensicLogger({
      dataDir: tempDir,
      store,
      logFile: logPath
    });

    const recResult = await logger.reconcile();
    assert.strictEqual(recResult.reconciled, true);

    const state = await store.load();
    assert.strictEqual(state.pendingForensicOutbox.length, 0, 'pendingForensicOutbox must be cleared by reconcile');
    assert.ok(state.forensicLogs.some(e => e.id === 'evt-reconcile-1'), 'Event must be in forensicLogs');
    await store.close();
  });

  it('3. Fault injection / simulated crash: un-flushed outbox event survives and flushes on restart', async () => {
    // Phase 1: Simulate SQLite commit of state mutation + pending outbox event
    const event = { id: 'crash-evt-1', timestamp: new Date().toISOString(), eventType: 'pre_crash_event' };
    const store = new SqliteStore(dbPath, {
      pendingForensicOutbox: [event]
    });
    await store.load();
    // "Crash" happens here before JSONL append!
    await store.close();

    // Phase 2: Restart bot service with new store & logger instance
    const restartedStore = new SqliteStore(dbPath);
    await restartedStore.load();
    const restartedLogger = new ForensicLogger({
      dataDir: tempDir,
      store: restartedStore,
      logFile: logPath
    });

    // Automatic startup flush
    const flushRes = await restartedLogger.flushOutbox();
    assert.strictEqual(flushRes.flushed, 1);
    assert.strictEqual(flushRes.newlyAppended, 1);

    // Verify event is now durably in JSONL
    const content = fs.readFileSync(logPath, 'utf8');
    assert.ok(content.includes('crash-evt-1'));

    await restartedStore.close();
  });

  it('4. settle_item_53d0f458 quota idempotency: Nov 1 baseline adjusts 9 -> 10, never to 11 even if flag lost', async () => {
    const initialItem = {
      id: SETTLEMENT_TARGET.id,
      state: 'ambiguous',
      payload: {
        text: SETTLEMENT_TARGET.fullText,
        account: SETTLEMENT_TARGET.accountId
      }
    };

    // Pre-settlement production baseline: crytpokingxvo8 had 9 posts published on Nov 1
    const store = new SqliteStore(dbPath, {
      items: [initialItem],
      posting: { quota: { '2026-11-01': { [SETTLEMENT_TARGET.accountId]: 9 } } }
    });
    await store.load();
    await store.close();

    // First settlement execution: 9 -> 10
    const res1 = await settleItem53d0({ dbPath, logFilePath: logPath, isApply: true });
    assert.strictEqual(res1.settled, true);

    const s1 = new SqliteStore(dbPath);
    const state1 = await s1.load();
    assert.strictEqual(state1.posting.quota['2026-11-01'][SETTLEMENT_TARGET.accountId], 10, 'Nov 1 quota must be 10');

    // Simulate lost flag (e.g. migration or DB rollback stripped settledQuotaCredited)
    await s1.update(s => {
      const itm = s.items.find(i => i.id === SETTLEMENT_TARGET.id);
      delete itm.settledQuotaCredited;
      return s;
    });
    await s1.close();

    // Second execution: must recognize item is already settled, resulting in idempotent NOOP without increasing quota!
    const res2 = await settleItem53d0({ dbPath, logFilePath: logPath, isApply: true });
    assert.strictEqual(res2.status, 'NOOP', 'Second execution on already settled item must be idempotent NOOP');

    const s2 = new SqliteStore(dbPath);
    const state2 = await s2.load();
    assert.strictEqual(state2.posting.quota['2026-11-01'][SETTLEMENT_TARGET.accountId], 10, 'Quota must remain strictly 10, never increment to 11');
    await s2.close();
  });
});
