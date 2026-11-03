'use strict';
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { SqliteStore } = require('../src/sqliteStore');
const { ForensicLogger } = require('../src/forensicLogger');
const { TelegramUi } = require('../src/telegramUi');
const { accountRecord } = require('../src/accounts');
const { settleItem53d0, SETTLEMENT_TARGET } = require('../scripts/settle_item_53d0f458');
const {
  resetSessionsForTest,
  countUntrackedDirectXProcesses
} = require('../src/sessionGuard');

describe('M14 Round 2: Independent Review Blocker Regression Tests', () => {
  let tempDir;
  let dbPath;
  let logPath;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm14-round2-'));
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

  /* -------------------------------------------------------------------------- */
  /* P0-A: Historical Quota Reconciliation Tests                                */
  /* -------------------------------------------------------------------------- */

  describe('P0-A: Historical Quota Reconciliation & Baseline Idempotency', () => {
    it('1. ambiguous + quota=9 credits to exactly 10', async () => {
      // 9 existing published items on Nov 1
      const existingItems = Array.from({ length: 9 }, (_, idx) => ({
        id: `existing_${idx}`,
        state: 'published',
        publishedAt: '2026-11-01T15:00:00.000Z',
        accountId: SETTLEMENT_TARGET.accountId,
        payload: { text: `text_${idx}`, account: SETTLEMENT_TARGET.accountId }
      }));

      const initialItem = {
        id: SETTLEMENT_TARGET.id,
        state: 'ambiguous',
        payload: {
          text: SETTLEMENT_TARGET.fullText,
          account: SETTLEMENT_TARGET.accountId
        }
      };

      const store = new SqliteStore(dbPath, {
        items: [...existingItems, initialItem],
        posting: { quota: { '2026-11-01': { [SETTLEMENT_TARGET.accountId]: 9 } } }
      });
      await store.load();
      await store.close();

      const res = await settleItem53d0({ dbPath, logFilePath: logPath, isApply: true });
      assert.strictEqual(res.settled, true);
      assert.strictEqual(res.status, 'APPLIED');

      const s = new SqliteStore(dbPath);
      const state = await s.load();
      assert.strictEqual(state.posting.quota['2026-11-01'][SETTLEMENT_TARGET.accountId], 10);
      const item = state.items.find(i => i.id === SETTLEMENT_TARGET.id);
      assert.strictEqual(item.settledQuotaCredited, true);
      await s.close();
    });

    it('2. ambiguous + quota=10 with missing flag stays 10, never increments to 11', async () => {
      // 9 existing published items from baseline
      const existingItems = Array.from({ length: 9 }, (_, idx) => ({
        id: `existing_${idx}`,
        state: 'published',
        publishedAt: '2026-11-01T15:00:00.000Z',
        accountId: SETTLEMENT_TARGET.accountId,
        payload: { text: `text_${idx}`, account: SETTLEMENT_TARGET.accountId }
      }));

      // Item 53d0 is still ambiguous and missing settledQuotaCredited flag
      const targetItem = {
        id: SETTLEMENT_TARGET.id,
        state: 'ambiguous',
        payload: {
          text: SETTLEMENT_TARGET.fullText,
          account: SETTLEMENT_TARGET.accountId
        }
      };

      // Current quota is already 10 (already counted in a previous run)
      const store = new SqliteStore(dbPath, {
        items: [...existingItems, targetItem],
        posting: { quota: { '2026-11-01': { [SETTLEMENT_TARGET.accountId]: 10 } } }
      });
      await store.load();
      await store.close();

      const res = await settleItem53d0({ dbPath, logFilePath: logPath, isApply: true });
      assert.strictEqual(res.settled, true);

      const s = new SqliteStore(dbPath);
      const state = await s.load();
      // Quota MUST remain strictly 10, NEVER 11!
      assert.strictEqual(state.posting.quota['2026-11-01'][SETTLEMENT_TARGET.accountId], 10, 'Quota must remain strictly 10');
      const item = state.items.find(i => i.id === SETTLEMENT_TARGET.id);
      assert.strictEqual(item.settledQuotaCredited, true);
      await s.close();
    });

    it('3. ambiguous + quota < existingPublishedCount fails closed with QUOTA_RECONCILIATION_AMBIGUOUS', async () => {
      // 9 published items on Nov 1
      const existingItems = Array.from({ length: 9 }, (_, idx) => ({
        id: `existing_${idx}`,
        state: 'published',
        publishedAt: '2026-11-01T15:00:00.000Z',
        accountId: SETTLEMENT_TARGET.accountId
      }));

      const targetItem = {
        id: SETTLEMENT_TARGET.id,
        state: 'ambiguous',
        payload: {
          text: SETTLEMENT_TARGET.fullText,
          account: SETTLEMENT_TARGET.accountId
        }
      };

      // Corrupt state: quota is 5, less than 9 existing published items!
      const store = new SqliteStore(dbPath, {
        items: [...existingItems, targetItem],
        posting: { quota: { '2026-11-01': { [SETTLEMENT_TARGET.accountId]: 5 } } }
      });
      await store.load();
      await store.close();

      await assert.rejects(
        async () => settleItem53d0({ dbPath, logFilePath: logPath, isApply: true }),
        err => {
          assert.ok(err.message.includes('QUOTA_RECONCILIATION_AMBIGUOUS'));
          return true;
        }
      );
    });
  });

  /* -------------------------------------------------------------------------- */
  /* P0-B: Forensic Outbox Durability & Locking Tests                           */
  /* -------------------------------------------------------------------------- */

  describe('P0-B: Outbox Durability & File Write Fault Injection', () => {
    it('1. reconcile does NOT clear SQLite outbox if file write fails', async () => {
      const event = { id: 'evt-fail-write-1', epoch: Date.now(), timestamp: new Date().toISOString(), eventType: 'test_persist' };
      const store = new SqliteStore(dbPath, {
        forensicLogs: [],
        pendingForensicOutbox: [event]
      });
      await store.load();

      // Point logFile into a path where a parent component is a regular file (triggers ENOTDIR even for root)
      const blockingFile = path.join(tempDir, 'blocking_file');
      fs.writeFileSync(blockingFile, 'blocking_content');
      const badLogPath = path.join(blockingFile, 'logs', 'forensic.jsonl');

      const logger = new ForensicLogger({
        dataDir: tempDir,
        store,
        logFile: badLogPath
      });

      await assert.rejects(
        logger.reconcile(),
        err => Boolean(err)
      );

      // Verify pendingForensicOutbox was NOT cleared from SQLite!
      const state = await store.load();
      assert.strictEqual(state.pendingForensicOutbox.length, 1, 'Outbox must NOT be cleared when file persistence fails');
      assert.strictEqual(state.pendingForensicOutbox[0].id, 'evt-fail-write-1');

      // Clean up blocking file so tempDir can be removed
      fs.unlinkSync(blockingFile);
      await store.close();
    });

    it('2. _withLogLock serializes concurrent flushes without dropped events or duplicates', async () => {
      const event1 = { id: 'evt-lock-1', epoch: Date.now(), timestamp: new Date().toISOString(), eventType: 'concurrent_1' };
      const event2 = { id: 'evt-lock-2', epoch: Date.now() + 1, timestamp: new Date().toISOString(), eventType: 'concurrent_2' };

      const store = new SqliteStore(dbPath, {
        pendingForensicOutbox: [event1, event2]
      });
      await store.load();

      const logger1 = new ForensicLogger({ dataDir: tempDir, store, logFile: logPath });
      const logger2 = new ForensicLogger({ dataDir: tempDir, store, logFile: logPath });

      // Run two flushes concurrently
      const [res1, res2] = await Promise.all([
        logger1.flushOutbox(),
        logger2.flushOutbox()
      ]);

      const totalAppended = res1.newlyAppended + res2.newlyAppended;
      assert.strictEqual(totalAppended, 2, 'Exactly 2 events must be appended without duplication');

      const content = fs.readFileSync(logPath, 'utf8').trim().split('\n');
      assert.strictEqual(content.length, 2, 'File must contain exactly 2 lines');

      const state = await store.load();
      assert.strictEqual(state.pendingForensicOutbox.length, 0, 'Outbox must be drained completely');
      await store.close();
    });
  });

  /* -------------------------------------------------------------------------- */
  /* P0-C: Stale CAPTCHA Verification CAS Tests                                 */
  /* -------------------------------------------------------------------------- */

  describe('P0-C: Stale CAPTCHA Verification CAS & Injected Event B', () => {
    it('1. Event B injected during verification of Event A rejects stale verification', async () => {
      const initialAccount = {
        id: 'acc_concurrency',
        username: 'target_user',
        userId: '11223344',
        enabled: false,
        status: 'كابتشا',
        needsOwnerCaptcha: true,
        captchaIncidentId: 'incident_A',
        checkGeneration: 'gen_1',
        cookieFile: '/tmp/cookies_A.json'
      };

      const store = new SqliteStore(dbPath, {
        accounts: [accountRecord(initialAccount)]
      });
      await store.load();

      let resolveSlowVerify;
      const verifyPromise = new Promise(resolve => { resolveSlowVerify = resolve; });

      const messages = [];
      const ui = new TelegramUi({
        bot: {
          store,
          transport: {
            sendMessage: async (_, text) => messages.push(text),
            editMessageText: async () => {},
            acknowledgeCallback: async () => {}
          }
        },
        isolatedVerifier: {
          verify: async () => {
            // Wait for test to inject event B before returning success
            await verifyPromise;
            return {
              authenticated: true,
              username: 'target_user',
              userId: '11223344',
              challenge: false,
              locked: false,
              captcha: false,
              suspended: false,
              accountFailure: null
            };
          }
        }
      });

      const rawPayload = {
        callback_query: {
          id: 'cb_race',
          from: { id: 123 },
          message: { chat: { id: 123 }, message_id: 20 }
        }
      };

      // Trigger verification for incident A (starts async verification)
      const verifyOp = ui.accountManage(
        { parsed: { action: 'verify_captcha', value: 'acc_concurrency' } },
        rawPayload
      );

      // Simulate Event B occurring in background while verification A is in flight:
      // A new CAPTCHA challenge is detected, updating captchaIncidentId to 'incident_B'
      await store.update(s => {
        const a = s.accounts.find(acc => acc.id === 'acc_concurrency');
        a.captchaIncidentId = 'incident_B';
        a.checkGeneration = 'gen_2';
        return s;
      });

      // Now allow the slow verification A to complete
      resolveSlowVerify();
      const result = await verifyOp;

      // Result MUST be marked stale and rejected!
      assert.strictEqual(result.verified, false);
      assert.strictEqual(result.stale, true);
      assert.strictEqual(result.reason, 'newer_incident_occurred');

      // Verify that account state was NOT unblocked or cleared!
      const postState = await store.load();
      const a = postState.accounts.find(acc => acc.id === 'acc_concurrency');
      assert.strictEqual(a.needsOwnerCaptcha, true, 'needsOwnerCaptcha must remain true');
      assert.strictEqual(a.captchaIncidentId, 'incident_B', 'Incident B must be preserved');
      assert.strictEqual(a.enabled, false, 'Account must remain disabled');

      // Verify owner warning message was dispatched
      assert.ok(messages.some(m => m.includes('تم إلغاء نتيجة التحقق') && m.includes('newer_incident_occurred')));
      await store.close();
    });
  });

  /* -------------------------------------------------------------------------- */
  /* P1-D: Session Guard Visibility and Reset Hardening                         */
  /* -------------------------------------------------------------------------- */

  describe('P1-D: Session Guard Path and Visibility Safety', () => {
    it('1. resetSessionsForTest rejects symlinked parent directory with SYMLINK_RESET_FORBIDDEN', () => {
      const realSubDir = path.join(tempDir, 'real_dir');
      fs.mkdirSync(realSubDir);
      const symlinkDir = path.join(tempDir, 'symlink_parent_dir');
      fs.symlinkSync(realSubDir, symlinkDir);

      const targetDbInSymlinkDir = path.join(symlinkDir, 'leases.sqlite');
      fs.writeFileSync(path.join(realSubDir, 'leases.sqlite'), 'data');

      assert.throws(
        () => resetSessionsForTest(targetDbInSymlinkDir),
        err => {
          assert.strictEqual(err.code, 'SYMLINK_RESET_FORBIDDEN');
          return true;
        }
      );
    });

    it('2. check_session acknowledges local configuration only without claiming network login', async () => {
      const testAccount = {
        id: 'acc_local_cfg',
        username: 'config_user',
        enabled: true,
        status: 'مفعل'
      };

      const store = new SqliteStore(dbPath, {
        accounts: [accountRecord(testAccount)]
      });
      await store.load();

      let ackText = '';
      const ui = new TelegramUi({
        bot: { store, transport: { acknowledgeCallback: async () => {} } }
      });

      const res = await ui.accountManage(
        {
          parsed: { action: 'check_session', value: 'acc_local_cfg' },
          acknowledge: async (text) => { ackText = text; }
        },
        { callback_query: { id: 'cb3', from: { id: 123 }, message: { chat: { id: 123 } } } }
      );

      assert.strictEqual(res.checked, 'session');
      assert.ok(ackText.includes('فحص تكوين محلي فقط'), 'Must indicate local configuration check only');
      assert.ok(!ackText.includes('جلسة X صالحة'), 'Must NOT claim valid live X session');
      await store.close();
    });
  });
});
