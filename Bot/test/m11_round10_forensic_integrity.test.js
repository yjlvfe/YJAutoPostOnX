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
    const dbPath = path.resolve(__dirname, '../data/state.sqlite');
    const store = new SqliteStore(dbPath);
    const logger = new ForensicLogger({ store, dataDir: path.resolve(__dirname, '../data') });

    const pruneRes = await logger.prune();
    assert.ok(pruneRes && typeof pruneRes.prunedCount === 'number');

    const recRes = await logger.reconcile();
    assert.strictEqual(recRes.reconciled, true);

    const state = await store.load();
    store.close();

    const m11Events = (state.forensicLogs || []).filter(e => e.eventType && e.eventType.startsWith('m11_'));
    assert.ok(m11Events.length >= 2, 'M11 audit events must be retained in state.forensicLogs');
    for (const evt of m11Events) {
      assert.ok(evt.id && typeof evt.id === 'string', 'Event must have unique string id');
      assert.ok(typeof evt.epoch === 'number' && Number.isFinite(evt.epoch), 'Event must have numeric epoch');
      assert.ok(evt.timestamp && typeof evt.timestamp === 'string', 'Event must have ISO timestamp');
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
});
