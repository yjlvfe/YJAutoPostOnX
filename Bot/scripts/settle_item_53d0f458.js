'use strict';
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { randomUUID, createHash } = require('node:crypto');
const { SqliteStore } = require('../src/sqliteStore');
const { ForensicLogger } = require('../src/forensicLogger');

const SETTLEMENT_TARGET = {
  id: '53d0f458-3144-4e89-a1af-202a8893afc6',
  tweetId: '2116981347772498219',
  url: 'https://x.com/crytpokingxvo8/status/2116981347772498219',
  accountId: 'x-930e0054b395228aefa9',
  accountUsername: 'crytpokingxvo8',
  publishedAt: '2026-11-01T19:50:59.577Z',
  historicalDay: '2026-11-01',
  fullText: '📌 الفارق الحقيقي بين المقامرة والتداول الواعي هو أمر وقف الخسارة. تخلّ عن عنادك واعترف بخطأ الصفقة قبل أن تمسح محفظتك بالكامل.\n\nافتح حسابك الاستثماري في MEXC بكود MEXC-12UHY5\n\n#إدارة_المخاطر #تداول',
  expectedTextPrefix: '📌 الفارق الحقيقي بين المقامرة والتداول الواعي هو أمر وقف ال',
  expectedTextSha256Prefix: '6175d09d7a46563c',
  expectedSha256Full: '6175d09d7a46563c051342f26ec9559a88689ccc3644eee690fdc95fc116133b'
};

function getRiyadhDate(dateInput) {
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(d);
}

function isProdDb(targetPath) {
  if (!targetPath) return true;
  try {
    const resolved = path.resolve(targetPath);
    const prod = path.resolve(__dirname, '../data/state.sqlite');
    if (resolved === prod) return true;
    if (fs.existsSync(resolved) && fs.existsSync(prod)) {
      return fs.realpathSync(resolved) === fs.realpathSync(prod);
    }
  } catch {}
  return false;
}

async function flushPendingForensicOutbox(store, targetLog) {
  const logger = new ForensicLogger({
    store,
    logFile: targetLog,
    dataDir: path.dirname(path.dirname(targetLog))
  });
  return logger.flushOutbox();
}

async function settleItem53d0({ dbPath, logFilePath, isApply, allowProdSettlement } = {}) {
  const targetDb = dbPath || path.resolve(__dirname, '../data/state.sqlite');
  const targetLog = logFilePath || path.resolve(__dirname, '../data/logs/forensic.jsonl');

  console.log(`=== SETTLE 53d0f458 SCRIPT (Mode: ${isApply ? 'APPLY' : 'DRY-RUN'}) ===`);
  console.log('Target database:', targetDb);

  const isTargetingProduction = isProdDb(targetDb);
  if (isApply && isTargetingProduction && !allowProdSettlement && process.env.ALLOW_PROD_53D0_SETTLEMENT !== '1') {
    console.log('[BLOCKED] Direct production settlement is strictly gated. State is READY_FOR_OWNER_APPROVAL.');
    console.log('To execute on production, independent owner approval and ALLOW_PROD_53D0_SETTLEMENT=1 are required.');
    return {
      settled: false,
      status: 'BLOCKED_PENDING_OWNER_APPROVAL',
      reason: 'PRODUCTION_SETTLEMENT_REQUIRES_EXPLICIT_OWNER_APPROVAL',
      target: SETTLEMENT_TARGET
    };
  }

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
      state.pendingForensicOutbox ||= [];

      const item = state.items.find(i => i.id === SETTLEMENT_TARGET.id);
      if (!item) {
        throw new Error(`Target item ${SETTLEMENT_TARGET.id} not found in state.items`);
      }

      if (item.state === 'published') {
        console.log(`Item ${SETTLEMENT_TARGET.id} is already marked published. Idempotent no-op.`);
        return state;
      }

      // Strict Compare-and-Set invariant: item must be in ambiguous state
      if (item.state !== 'ambiguous') {
        throw new Error(`INVALID_ITEM_STATE: Item ${SETTLEMENT_TARGET.id} must be in 'ambiguous' state to settle (current: '${item.state}')`);
      }

      // Strict content verification: full 64-char SHA-256 hash
      const text = item.payload?.text || '';
      if (!text) {
        throw new Error(`MISSING_TEXT: Item ${SETTLEMENT_TARGET.id} text is missing`);
      }
      const fullHash = createHash('sha256').update(text, 'utf8').digest('hex');
      if (fullHash !== SETTLEMENT_TARGET.expectedSha256Full) {
        throw new Error(`FULL_SHA256_MISMATCH: Item ${SETTLEMENT_TARGET.id} full SHA-256 does not match expected (${fullHash} != ${SETTLEMENT_TARGET.expectedSha256Full})`);
      }

      // Account & provenance verification
      const itemAccId = item.accountId || item.payload?.account;
      if (itemAccId && itemAccId !== SETTLEMENT_TARGET.accountId) {
        throw new Error(`ACCOUNT_PROVENANCE_MISMATCH: Item account ${itemAccId} != ${SETTLEMENT_TARGET.accountId}`);
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

      // Historical quota adjustment strictly in Riyadh timezone for historical day
      const riyadhHistoricalDay = getRiyadhDate(SETTLEMENT_TARGET.publishedAt);
      const todayRiyadh = getRiyadhDate(nowEpoch);

      if (riyadhHistoricalDay !== SETTLEMENT_TARGET.historicalDay) {
        throw new Error(`HISTORICAL_DAY_MISMATCH: Target historical day ${SETTLEMENT_TARGET.historicalDay} != ${riyadhHistoricalDay}`);
      }

      state.posting.quota[riyadhHistoricalDay] ||= {};
      const currentHistoricalQuota = state.posting.quota[riyadhHistoricalDay][SETTLEMENT_TARGET.accountId] || 0;

      // Count existing published items for this account on historical day (excluding this item being settled)
      const existingPublishedCount = (state.items || []).filter(i =>
        i.id !== SETTLEMENT_TARGET.id &&
        (i.accountId === SETTLEMENT_TARGET.accountId || i.payload?.account === SETTLEMENT_TARGET.accountId) &&
        i.state === 'published' &&
        getRiyadhDate(i.publishedAt) === riyadhHistoricalDay
      ).length;

      // Fail-closed validation for the one-off settlement of item 53d0 on Nov 1:
      // The only proven historical transition is 9 -> 10, or an already-credited 10.
      // Arbitrary baselines (e.g. quota 8, quota 11, or arbitrary counts) are strictly rejected.
      let quotaCredited = false;

      if (currentHistoricalQuota === 10 && (existingPublishedCount === 9 || existingPublishedCount === 0)) {
        // Target is already credited
        item.settledQuotaCredited = true;
        quotaCredited = false;
        console.log(`[QUOTA_IDEMPOTENT] Quota for ${SETTLEMENT_TARGET.accountId} on ${riyadhHistoricalDay} already credited at authorized target of 10.`);
      } else if (currentHistoricalQuota === 9 && (existingPublishedCount === 9 || existingPublishedCount === 0)) {
        // Authorized transition from proven baseline 9 to target 10
        state.posting.quota[riyadhHistoricalDay][SETTLEMENT_TARGET.accountId] = 10;
        item.settledQuotaCredited = true;
        quotaCredited = true;
        console.log(`[QUOTA_CREDITED] Quota for ${SETTLEMENT_TARGET.accountId} on ${riyadhHistoricalDay} adjusted from 9 -> 10.`);
      } else {
        throw new Error(`QUOTA_RECONCILIATION_AMBIGUOUS: Unsupported or contradictory quota state for 53d0 settlement: currentHistoricalQuota=${currentHistoricalQuota}, existingPublishedCount=${existingPublishedCount} on ${riyadhHistoricalDay}. Only proven 9 -> 10 or verified 10 is authorized.`);
      }

      auditEvent = {
        id: randomUUID(),
        timestamp: nowIso,
        epoch: nowEpoch,
        eventType: 'm14_settle_53d0f458_snowflake_published',
        details: {
          itemId: SETTLEMENT_TARGET.id,
          tweetId: SETTLEMENT_TARGET.tweetId,
          url: SETTLEMENT_TARGET.url,
          accountId: SETTLEMENT_TARGET.accountId,
          publishedAt: SETTLEMENT_TARGET.publishedAt,
          historicalDayRiyadh: riyadhHistoricalDay,
          todayRiyadh,
          quotaCredited,
          quotaBefore: currentHistoricalQuota,
          quotaAfter: state.posting.quota[riyadhHistoricalDay][SETTLEMENT_TARGET.accountId],
          fullSha256: fullHash
        }
      };

      // Atomic Dual-Write: Persist outbox event in the SAME SQLite transaction
      state.forensicLogs.push(auditEvent);
      state.pendingForensicOutbox.push(auditEvent);
      settled = true;

      return state;
    });

    // Post-commit: Flush pending outbox to external logfile
    try {
      const flushResult = await flushPendingForensicOutbox(store, targetLog);
      console.log(`Flushed ${flushResult.flushed} outbox event(s) to ${targetLog}`);
    } catch (err) {
      console.warn(`Warning: Flush to ${targetLog} deferred to next cycle (${err.message}). Event remains safe in pendingForensicOutbox.`);
    }

    await store.close();
    console.log(`Settlement of ${SETTLEMENT_TARGET.id} completed. Published status recorded.`);
  } else {
    // Dry run
    const state = await store.load();
    const item = (state.items || []).find(i => i.id === SETTLEMENT_TARGET.id);
    await store.close();

    console.log(`[DRY RUN] Item ${SETTLEMENT_TARGET.id} found in state: ${item ? item.state : 'NOT FOUND'}`);
    console.log(`[DRY RUN] Would update state -> published with URL ${SETTLEMENT_TARGET.url}`);
    console.log(`[DRY RUN] Status: READY_FOR_OWNER_APPROVAL.`);
  }

  return {
    settled,
    status: isApply ? (settled ? 'APPLIED' : 'NOOP') : 'READY_FOR_OWNER_APPROVAL',
    target: SETTLEMENT_TARGET
  };
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

module.exports = { main, settleItem53d0, flushPendingForensicOutbox, SETTLEMENT_TARGET };
