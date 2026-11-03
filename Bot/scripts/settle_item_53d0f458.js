'use strict';
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { randomUUID, createHash } = require('node:crypto');
const { SqliteStore } = require('../src/sqliteStore');

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
  const state = await store.load();
  const pending = state.pendingForensicOutbox || [];
  if (pending.length === 0) return { flushed: 0, newlyAppended: 0 };

  const dir = path.dirname(targetLog);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  // Read existing event IDs from targetLog to guarantee deduplication
  const existingIds = new Set();
  if (fs.existsSync(targetLog)) {
    try {
      const content = await fsp.readFile(targetLog, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.id) existingIds.add(parsed.id);
        } catch {}
      }
    } catch {}
  }

  const toAppend = pending.filter(e => !existingIds.has(e.id));
  if (toAppend.length > 0) {
    const lines = toAppend.map(e => JSON.stringify(e)).join('\n') + '\n';
    const fileHandle = await fsp.open(targetLog, 'a', 0o600);
    try {
      await fileHandle.write(lines);
      await fileHandle.sync(); // durable fsync policy
    } finally {
      await fileHandle.close();
    }
  }

  // Acknowledge and clear flushed events from SQLite outbox
  const flushedIds = new Set(pending.map(e => e.id));
  await store.update(s => {
    s.pendingForensicOutbox = (s.pendingForensicOutbox || []).filter(e => !flushedIds.has(e.id));
    return s;
  });

  return { flushed: pending.length, newlyAppended: toAppend.length };
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

      const expectedTargetQuota = Math.max(existingPublishedCount + 1, currentHistoricalQuota > 0 ? currentHistoricalQuota + 1 : 1);

      // Prevent duplicate quota increment:
      // Even if item.settledQuotaCredited flag was lost, if currentHistoricalQuota >= expectedTargetQuota,
      // it means this settlement was already counted.
      let quotaCredited = false;
      const isAlreadyCounted = Boolean(item.settledQuotaCredited) || (currentHistoricalQuota >= expectedTargetQuota && currentHistoricalQuota > existingPublishedCount);

      if (!isAlreadyCounted) {
        state.posting.quota[riyadhHistoricalDay][SETTLEMENT_TARGET.accountId] = expectedTargetQuota;
        item.settledQuotaCredited = true;
        quotaCredited = true;
      } else {
        item.settledQuotaCredited = true;
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
