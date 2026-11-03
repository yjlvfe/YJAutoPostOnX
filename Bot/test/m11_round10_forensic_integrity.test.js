'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { ForensicLogger } = require('../src/forensicLogger');
const { SqliteStore } = require('../src/sqliteStore');

describe('M11 Round 10: Forensic Integrity & Reversion Resilience', () => {
  it('1. apply_m11_ambiguous_recovery.js is permanently disabled and exits with error', () => {
    const scriptPath = path.resolve(__dirname, '../scripts/apply_m11_ambiguous_recovery.js');
    const res = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });
    assert.strictEqual(res.status, 1, 'Script must exit with status 1');
    assert.ok(res.stderr.includes('apply_m11_ambiguous_recovery.js is PERMANENTLY DISABLED'), 'Must output safety error');
  });

  it('2. revert_false_recovery_m11.js defaults to DRY-RUN mode without mutating state', () => {
    const scriptPath = path.resolve(__dirname, '../scripts/revert_false_recovery_m11.js');
    const res = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });
    assert.strictEqual(res.status, 0, 'Dry-run must exit cleanly with status 0');
    assert.ok(res.stdout.includes('Mode: DRY-RUN'), 'Must indicate DRY-RUN mode');
  });

  it('3. Audit events survive ForensicLogger.prune() and reconcile()', async () => {
    const os = require('node:os');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm11-forensic-test-'));
    try {
      const dbPath = path.join(tempDir, 'state.sqlite');
      const now = Date.now();
      const initialLogs = [
        {
          id: 'test-m11-revert-1',
          timestamp: new Date(now).toISOString(),
          epoch: now,
          eventType: 'm11_revert_false_recovery',
          details: { count: 4 }
        },
        {
          id: 'test-m11-enrich-1',
          timestamp: new Date(now).toISOString(),
          epoch: now,
          eventType: 'm11_audit_13_ambiguous_accounts',
          details: { enriched: 13 }
        },
        {
          id: 'test-old-expired-1',
          timestamp: new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(),
          epoch: now - 10 * 24 * 60 * 60 * 1000,
          eventType: 'post_attempt',
          details: { old: true }
        }
      ];

      const store = new SqliteStore(dbPath, { forensicLogs: initialLogs });
      const logger = new ForensicLogger({ store, dataDir: tempDir, clock: () => now });

      const pruneRes = await logger.prune();
      assert.ok(pruneRes && typeof pruneRes.prunedCount === 'number');
      assert.strictEqual(pruneRes.prunedCount, 1, 'Expired event (>7 days) must be pruned');

      const recRes = await logger.reconcile();
      assert.strictEqual(recRes.reconciled, true);

      const state = await store.load();
      await store.close();

      const m11Events = (state.forensicLogs || []).filter(e => e.eventType && e.eventType.startsWith('m11_'));
      assert.strictEqual(m11Events.length, 2, 'M11 audit events must be retained in state.forensicLogs');
      for (const evt of m11Events) {
        assert.ok(evt.id && typeof evt.id === 'string', 'Event must have unique string id');
        assert.ok(typeof evt.epoch === 'number' && Number.isFinite(evt.epoch), 'Event must have numeric epoch');
        assert.ok(evt.timestamp && typeof evt.timestamp === 'string', 'Event must have ISO timestamp');
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('4. Item 53d0f458 snowflake timestamp exactly matches forensic log timestamp', () => {
    const tweetId = 2116981347772498219n;
    const twitterEpoch = 1288834974657n;
    const timestampMs = Number((tweetId >> 22n) + twitterEpoch);
    const snowflakeIso = new Date(timestampMs).toISOString();

    assert.strictEqual(snowflakeIso, '2026-11-01T19:50:59.577Z', 'Snowflake must calculate exact 19:50:59.577Z timestamp');
  });

  it('5. Audit report Reports/audit_ambiguous_m11.json has zero missing accountId', () => {
    const reportPath = path.resolve(__dirname, '../Reports/audit_ambiguous_m11.json');
    assert.ok(fs.existsSync(reportPath), 'Audit report must exist');
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    assert.strictEqual(report.total, 30, 'Total ambiguous items must be exactly 30');
    const missing = report.items.filter(i => !i.accountId);
    assert.strictEqual(missing.length, 0, 'No items should be missing accountId');
  });

  it('6. revert_false_recovery_m11 skips audit events when state has 0 mutations', async () => {
    const os = require('node:os');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm11-revert-idempotent-'));
    try {
      const dbPath = path.join(tempDir, 'state.sqlite');
      const logPath = path.join(tempDir, 'forensic.jsonl');
      const { runReversion, REVERT_ITEMS, ENRICH_13_ITEMS } = require('../scripts/revert_false_recovery_m11');

      // Initialize clean state where all items are already ambiguous and enriched
      const items = [
        ...REVERT_ITEMS.map(r => ({ id: r.id, state: 'ambiguous', reason: r.reason, accountId: r.accountId, accountUsername: r.accountUsername })),
        ...ENRICH_13_ITEMS.map(e => ({ id: e.itemId, state: 'ambiguous', accountId: e.accountId, accountUsername: e.accountUsername }))
      ];

      const store = new SqliteStore(dbPath, { items, forensicLogs: [] });
      await store.load();
      await store.close();

      const res = await runReversion({ dbPath, logFilePath: logPath, isApply: true });
      assert.strictEqual(res.revertedCount, 0, 'Reverted count must be 0');
      assert.strictEqual(res.enrichedCount, 0, 'Enriched count must be 0');

      const storeCheck = new SqliteStore(dbPath);
      const stateCheck = await storeCheck.load();
      await storeCheck.close();

      assert.strictEqual((stateCheck.forensicLogs || []).length, 0, 'Must NOT record any events when 0 mutations occurred');
      assert.strictEqual(fs.existsSync(logPath), false, 'Log file must NOT be appended when 0 mutations occurred');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('7. revert_false_recovery_m11 preserves and archives original attempt metadata', async () => {
    const os = require('node:os');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm11-revert-archive-'));
    try {
      const dbPath = path.join(tempDir, 'state.sqlite');
      const logPath = path.join(tempDir, 'forensic.jsonl');
      const { runReversion } = require('../scripts/revert_false_recovery_m11');

      const originalAttempt = {
        token: 'att-token-123',
        phase: 'dispatching',
        startedAt: '2026-11-03T03:00:00.000Z'
      };

      const items = [
        {
          id: '3a982de7-76b0-450f-a712-e10861b26dda',
          state: 'published',
          url: 'https://x.com/fake/1',
          attempt: originalAttempt
        }
      ];

      const store = new SqliteStore(dbPath, { items });
      await store.load();
      await store.close();

      const res = await runReversion({ dbPath, logFilePath: logPath, isApply: true });
      assert.strictEqual(res.revertedCount, 1);

      const storeCheck = new SqliteStore(dbPath);
      const stateCheck = await storeCheck.load();
      await storeCheck.close();

      const item = stateCheck.items.find(i => i.id === '3a982de7-76b0-450f-a712-e10861b26dda');
      assert.strictEqual(item.state, 'ambiguous');
      assert.deepStrictEqual(item.archivedAttempt, originalAttempt, 'Original attempt must be preserved in archivedAttempt');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
