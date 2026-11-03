'use strict';
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { SqliteStore } = require('../src/sqliteStore');

const SETTLEMENT_TARGET = {
  id: '53d0f458-3144-4e89-a1af-202a8893afc6',
  tweetId: '2116981347772498219',
  url: 'https://x.com/crytpokingxvo8/status/2116981347772498219',
  accountId: 'x-930e0054b395228aefa9',
  accountUsername: 'crytpokingxvo8',
  publishedAt: '2026-11-01T19:50:59.577Z',
  historicalDay: '2026-11-01'
};

async function settleItem53d0({ dbPath, logFilePath, isApply } = {}) {
  const targetDb = dbPath || path.resolve(__dirname, '../data/state.sqlite');
  const targetLog = logFilePath || path.resolve(__dirname, '../data/logs/forensic.jsonl');

  console.log(`=== SETTLE 53d0f458 SCRIPT (Mode: ${isApply ? 'APPLY' : 'DRY-RUN'}) ===`);
  console.log('Target database:', targetDb);

  const store = new SqliteStore(targetDb);
  const nowEpoch = Date.now();
  const nowIso = new Date(nowEpoch).toISOString();

  let auditEvent = null;
  let settled = false;

  if (isApply) {
    await store.update(state => {
      state.items ||= [];
      state.forensicLogs ||= [];
      state.posting ||= {};
      state.posting.quota ||= {};

      const item = state.items.find(i => i.id === SETTLEMENT_TARGET.id);
      if (!item) {
        throw new Error(`Target item ${SETTLEMENT_TARGET.id} not found in state.items`);
      }

      if (item.state === 'published') {
        console.log(`Item ${SETTLEMENT_TARGET.id} is already marked published. No-op.`);
        return state;
      }

      // Archive attempt
      if (item.attempt) {
        item.archivedAttempt = structuredClone(item.attempt);
        delete item.attempt;
      }

      item.state = 'published';
      item.outcome = 'published';
      item.tweetId = SETTLEMENT_TARGET.tweetId;
      item.url = SETTLEMENT_TARGET.url;
      item.publishedAt = SETTLEMENT_TARGET.publishedAt;
      item.accountId = SETTLEMENT_TARGET.accountId;
      item.accountUsername = SETTLEMENT_TARGET.accountUsername;
      item.settlementDiagnostic = {
        settledAt: nowIso,
        method: 'snowflake_timestamp_correlation',
        snowflakeIso: '2026-11-01T19:50:59.577Z',
        runnerDispatchStartedAt: '2026-11-01T19:50:53.963Z',
        deltaMs: 5614
      };
      delete item.reason;
      delete item.failureDiagnostic;

      // Historical quota adjustment (Nov 1 historical only; NO impact on Nov 3 today quota)
      state.posting.quota[SETTLEMENT_TARGET.historicalDay] ||= {};
      const currentNov1Quota = state.posting.quota[SETTLEMENT_TARGET.historicalDay][SETTLEMENT_TARGET.accountId] || 0;
      state.posting.quota[SETTLEMENT_TARGET.historicalDay][SETTLEMENT_TARGET.accountId] = currentNov1Quota + 1;

      auditEvent = {
        id: randomUUID(),
        timestamp: nowIso,
        epoch: nowEpoch,
        eventType: 'm12_settle_53d0f458_snowflake_published',
        details: {
          itemId: SETTLEMENT_TARGET.id,
          tweetId: SETTLEMENT_TARGET.tweetId,
          url: SETTLEMENT_TARGET.url,
          accountId: SETTLEMENT_TARGET.accountId,
          publishedAt: SETTLEMENT_TARGET.publishedAt,
          historicalDay: SETTLEMENT_TARGET.historicalDay,
          nov1QuotaBefore: currentNov1Quota,
          nov1QuotaAfter: currentNov1Quota + 1
        }
      };
      state.forensicLogs.push(auditEvent);
      settled = true;

      return state;
    });

    await store.close();

    if (auditEvent) {
      try {
        await fsp.appendFile(targetLog, JSON.stringify(auditEvent) + '\n', { mode: 0o600 });
        console.log(`Persisted settlement audit event to ${targetLog}`);
      } catch (err) {
        console.error(`Warning: Failed to append to ${targetLog}:`, err.message);
      }
    }

    console.log(`Settlement of ${SETTLEMENT_TARGET.id} completed. Published status recorded.`);
  } else {
    // Dry run
    const state = await store.load();
    const item = (state.items || []).find(i => i.id === SETTLEMENT_TARGET.id);
    await store.close();

    console.log(`[DRY RUN] Item ${SETTLEMENT_TARGET.id} found in state: ${item ? item.state : 'NOT FOUND'}`);
    console.log(`[DRY RUN] Would update state -> published with URL ${SETTLEMENT_TARGET.url}`);
    console.log(`[DRY RUN] Would increment Nov 1 quota for ${SETTLEMENT_TARGET.accountId} without affecting today.`);
  }

  return { settled, target: SETTLEMENT_TARGET };
}

async function main() {
  const isApply = process.argv.includes('--apply');
  await settleItem53d0({ isApply });
}

if (require.main === module) {
  main().catch(err => {
    console.error('Settlement operation failed:', err);
    process.exit(1);
  });
}

module.exports = { main, settleItem53d0, SETTLEMENT_TARGET };
