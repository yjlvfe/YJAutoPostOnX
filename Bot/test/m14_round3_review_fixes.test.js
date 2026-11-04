'use strict';
const { DatabaseSync } = require('node:sqlite');
const { withForensicMutex, mutexDbPath } = require('../src/forensicMutex');
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { SqliteStore } = require('../src/sqliteStore');
const { ForensicLogger } = require('../src/forensicLogger');
const { TelegramUi } = require('../src/telegramUi');
const { accountRecord } = require('../src/accounts');
const { settleItem53d0, flushPendingForensicOutbox, SETTLEMENT_TARGET } = require('../scripts/settle_item_53d0f458');

describe('M14 Round 3: Comprehensive Review Blocker Regression Tests', () => {
  let tempDir;
  let dbPath;
  let logPath;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm14-round3-'));
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
    const lockFile = `${logPath}.lock`;
    if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
  });

  /* -------------------------------------------------------------------------- */
  /* P0-1: Canonical CAPTCHA Status Predicate & No-Deadlock Tests               */
  /* -------------------------------------------------------------------------- */

  describe('P0-1: Canonical CAPTCHA Status & UI CAS No-Deadlock', () => {
    it('1. accmanage:verify_captcha resolves UI-created status "كابتشا (مطلوب حل يدوي)" without deadlocking', async () => {
      const testAccount = {
        id: 'acc_ui_captcha',
        username: 'ui_user',
        userId: '99991',
        enabled: false,
        status: 'كابتشا (مطلوب حل يدوي)',
        needsOwnerCaptcha: true,
        captchaIncidentId: 'inc_ui_1',
        cookieFile: '/tmp/cookies_ui.json'
      };

      const store = new SqliteStore(dbPath, {
        accounts: [accountRecord(testAccount)]
      });
      await store.load();

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
          verify: async () => ({
            authenticated: true,
            username: 'ui_user',
            userId: '99991',
            challenge: false,
            locked: false,
            captcha: false,
            suspended: false,
            banned: false,
            accountFailure: null
          })
        }
      });

      const res = await ui.accountManage(
        { parsed: { action: 'verify_captcha', value: 'acc_ui_captcha' } },
        { callback_query: { id: 'cb_ui', from: { id: 123 }, message: { chat: { id: 123 }, message_id: 10 } } }
      );

      assert.strictEqual(res.verified, true, 'Verification must succeed without deadlocking on UI status');
      assert.strictEqual(res.status, 'غير مفعل');

      const finalState = await store.load();
      const a = finalState.accounts.find(acc => acc.id === 'acc_ui_captcha');
      assert.strictEqual(a.status, 'غير مفعل');
      assert.strictEqual(a.enabled, false, 'Must remain disabled pending explicit owner enable');
      assert.strictEqual(a.needsOwnerCaptcha, false);
      assert.strictEqual(a.captchaIncidentId, undefined);
      ui.stopTicker();
      await store.close();
    });

    it('2. accmanage:verify_captcha resolves runner-created status "كابتشا" cleanly', async () => {
      const testAccount = {
        id: 'acc_runner_captcha',
        username: 'runner_user',
        userId: '99992',
        enabled: false,
        status: 'كابتشا',
        needsOwnerCaptcha: true,
        captchaIncidentId: 'inc_runner_1',
        cookieFile: '/tmp/cookies_runner.json'
      };

      const store = new SqliteStore(dbPath, {
        accounts: [accountRecord(testAccount)]
      });
      await store.load();

      const ui = new TelegramUi({
        bot: {
          store,
          transport: {
            sendMessage: async () => {},
            editMessageText: async () => {},
            acknowledgeCallback: async () => {}
          }
        },
        isolatedVerifier: {
          verify: async () => ({
            authenticated: true,
            username: 'runner_user',
            userId: '99992',
            challenge: false,
            locked: false,
            captcha: false,
            suspended: false,
            banned: false,
            accountFailure: null
          })
        }
      });

      const res = await ui.accountManage(
        { parsed: { action: 'verify_captcha', value: 'acc_runner_captcha' } },
        { callback_query: { id: 'cb_runner', from: { id: 123 }, message: { chat: { id: 123 } } } }
      );

      assert.strictEqual(res.verified, true);
      assert.strictEqual(res.status, 'غير مفعل');
      ui.stopTicker();
      await store.close();
    });
  });

  /* -------------------------------------------------------------------------- */
  /* P0-2: CAPTCHA Notification Delivery Verification & Retry                  */
  /* -------------------------------------------------------------------------- */

  describe('P0-2: Delivery Verification, Failure Retry & Concurrency', () => {
    it('1. sendIsolationAlert does NOT record delivery if runner notify returns rejected', async () => {
      const testAccount = {
        id: 'acc_alert_fail',
        username: 'alert_user',
        status: 'كابتشا',
        needsOwnerCaptcha: true,
        captchaIncidentId: 'inc_alert_retry_1'
      };

      const store = new SqliteStore(dbPath, {
        accounts: [accountRecord(testAccount)]
      });
      await store.load();

      let notifyCalls = 0;
      let shouldSucceed = false;

      const ui = new TelegramUi({
        bot: { store, transport: {} },
        notify: async () => {
          notifyCalls++;
          if (!shouldSucceed) {
            // Emulate runner.js Promise.allSettled with rejected send
            return [{ status: 'rejected', reason: new Error('TELEGRAM_NETWORK_TIMEOUT') }];
          }
          // Successful delivery
          return [{ status: 'fulfilled', value: { ok: true, message_id: 8871 } }];
        }
      });

      // Attempt 1: Delivery fails
      const r1 = await ui.sendIsolationAlert({ account: testAccount, reason: 'captcha' });
      assert.strictEqual(r1, null, 'Must return null on unacknowledged delivery');
      assert.strictEqual(notifyCalls, 1);

      // Verify that SQLite does NOT have lastNotifiedCaptchaIncidentId set!
      let state = await store.load();
      let a = state.accounts.find(acc => acc.id === 'acc_alert_fail');
      assert.strictEqual(a.lastNotifiedCaptchaIncidentId, undefined, 'Must NOT mark incident as delivered on failure');

      // Attempt 2: Delivery now succeeds
      shouldSucceed = true;
      const r2 = await ui.sendIsolationAlert({ account: testAccount, reason: 'captcha' });
      assert.ok(r2, 'Must return message on successful delivery');
      assert.strictEqual(notifyCalls, 2);

      // Verify delivery is now durably marked in SQLite
      state = await store.load();
      a = state.accounts.find(acc => acc.id === 'acc_alert_fail');
      assert.strictEqual(a.lastNotifiedCaptchaIncidentId, 'inc_alert_retry_1');

      // Attempt 3: Immediate third call is suppressed by deduplication
      const r3 = await ui.sendIsolationAlert({ account: a, reason: 'captcha' });
      assert.strictEqual(r3, null, 'Must be suppressed as already delivered');
      assert.strictEqual(notifyCalls, 2, 'No redundant notify call');
      await store.close();
    });

    it('2. sendIsolationAlert concurrent calls for SAME incident are serialized with in-flight guard', async () => {
      const testAccount = {
        id: 'acc_alert_race',
        username: 'race_user',
        status: 'كابتشا',
        needsOwnerCaptcha: true,
        captchaIncidentId: 'inc_alert_race_1'
      };

      const store = new SqliteStore(dbPath, {
        accounts: [accountRecord(testAccount)]
      });
      await store.load();

      let notifyCalls = 0;
      let resolveSlowNotify;
      const slowNotifyPromise = new Promise(r => { resolveSlowNotify = r; });

      const ui = new TelegramUi({
        bot: { store, transport: {} },
        notify: async () => {
          notifyCalls++;
          await slowNotifyPromise;
          return [{ status: 'fulfilled', value: { ok: true, message_id: 8872 } }];
        }
      });

      // Launch two concurrent alerts for the same incident simultaneously
      const p1 = ui.sendIsolationAlert({ account: testAccount, reason: 'captcha' });
      const p2 = ui.sendIsolationAlert({ account: testAccount, reason: 'captcha' });

      resolveSlowNotify();
      const [res1, res2] = await Promise.all([p1, p2]);

      // Exactly ONE must send; the other must be suppressed by inFlightAlerts
      const deliveredCount = [res1, res2].filter(Boolean).length;
      assert.strictEqual(deliveredCount, 1, 'Exactly one concurrent alert must be dispatched');
      assert.strictEqual(notifyCalls, 1, 'Only 1 Telegram API call must occur');
      await store.close();
    });
  });

  /* -------------------------------------------------------------------------- */
  /* P1-3: Outbox Lock Stealing & Ownership Defense                             */
  /* -------------------------------------------------------------------------- */

  describe('P1-3: Outbox Lock Ownership, No Stealing & Crash Recovery', () => {
    it('1. SQLite mutex is not stolen from a live holder even if the operation is slow', async () => {
      const logger1 = new ForensicLogger({ dataDir: tempDir, logFile: logPath });
      let entered = false;
      await logger1._withLogLock(async () => {
        const db = new DatabaseSync(mutexDbPath(logPath));
        const owner = db.prepare('SELECT owner_pid FROM forensic_mutex WHERE id=1').get();
        assert.strictEqual(owner.owner_pid, process.pid);
        db.close();
        await assert.rejects(
          withForensicMutex(logPath, async () => { entered = true; }, { timeoutMs: 150 }),
          err => err.code === 'FORENSIC_LOG_LOCK_TIMEOUT'
        );
      });
      assert.strictEqual(entered, false, 'The competing writer must never enter a live critical section');
    });

    it('2. SQLite mutex reclaims orphaned ownership only when process death is proven', async () => {
      const logger = new ForensicLogger({ dataDir: tempDir, logFile: logPath });
      await logger._withLogLock(async () => {}); // initialize schema
      const db = new DatabaseSync(mutexDbPath(logPath));
      db.prepare('INSERT INTO forensic_mutex (id, owner_pid, owner_start, owner_token) VALUES (1, ?, ?, ?)')
        .run(99999999, '0', 'dead_token');
      db.close();

      let executed = false;
      await logger._withLogLock(async () => { executed = true; });
      assert.strictEqual(executed, true, 'Dead PID lease must be reclaimed safely');
      const check = new DatabaseSync(mutexDbPath(logPath));
      assert.strictEqual(check.prepare('SELECT COUNT(*) AS n FROM forensic_mutex').get().n, 0);
      check.close();
    });

    it('3. flushPendingForensicOutbox uses the exact same lock serialization as ForensicLogger', async () => {
      const store = new SqliteStore(dbPath, {
        pendingForensicOutbox: [{ id: 'evt-shared-lock-1', epoch: Date.now(), timestamp: new Date().toISOString() }]
      });
      await store.load();

      const res = await flushPendingForensicOutbox(store, logPath);
      assert.strictEqual(res.flushed, 1);
      assert.strictEqual(res.newlyAppended, 1);

      // Verify written to JSONL
      const content = fs.readFileSync(logPath, 'utf8');
      assert.ok(content.includes('evt-shared-lock-1'));
      await store.close();
    });
  });

  /* -------------------------------------------------------------------------- */
  /* P1-4: Quota Baseline Fail-Closed Validation Tests                         */
  /* -------------------------------------------------------------------------- */

  describe('P1-4: Exact Historical Quota Baselines (No Guessing)', () => {
    it('1. 9 items / quota 9 -> authorized to exactly 10', async () => {
      const existingItems = Array.from({ length: 9 }, (_, idx) => ({
        id: `exist_${idx}`,
        state: 'published',
        publishedAt: '2026-11-01T14:00:00.000Z',
        accountId: SETTLEMENT_TARGET.accountId,
        payload: { text: `text_${idx}`, account: SETTLEMENT_TARGET.accountId }
      }));

      const targetItem = {
        id: SETTLEMENT_TARGET.id,
        state: 'ambiguous',
        payload: { text: SETTLEMENT_TARGET.fullText, account: SETTLEMENT_TARGET.accountId }
      };

      const store = new SqliteStore(dbPath, {
        items: [...existingItems, targetItem],
        posting: { quota: { '2026-11-01': { [SETTLEMENT_TARGET.accountId]: 9 } } }
      });
      await store.load();
      await store.close();

      const res = await settleItem53d0({ dbPath, logFilePath: logPath, isApply: true });
      assert.strictEqual(res.settled, true);

      const s = new SqliteStore(dbPath);
      const state = await s.load();
      assert.strictEqual(state.posting.quota['2026-11-01'][SETTLEMENT_TARGET.accountId], 10);
      await s.close();
    });

    it('2. 9 items / quota 10 -> verified already credited, stays 10', async () => {
      const existingItems = Array.from({ length: 9 }, (_, idx) => ({
        id: `exist_${idx}`,
        state: 'published',
        publishedAt: '2026-11-01T14:00:00.000Z',
        accountId: SETTLEMENT_TARGET.accountId
      }));

      const targetItem = {
        id: SETTLEMENT_TARGET.id,
        state: 'ambiguous',
        payload: { text: SETTLEMENT_TARGET.fullText, account: SETTLEMENT_TARGET.accountId }
      };

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
      assert.strictEqual(state.posting.quota['2026-11-01'][SETTLEMENT_TARGET.accountId], 10, 'Must remain strictly 10');
      await s.close();
    });

    it('3. 9 items / quota 11 -> fails closed with QUOTA_RECONCILIATION_AMBIGUOUS', async () => {
      const existingItems = Array.from({ length: 9 }, (_, idx) => ({
        id: `exist_${idx}`,
        state: 'published',
        publishedAt: '2026-11-01T14:00:00.000Z',
        accountId: SETTLEMENT_TARGET.accountId
      }));

      const targetItem = {
        id: SETTLEMENT_TARGET.id,
        state: 'ambiguous',
        payload: { text: SETTLEMENT_TARGET.fullText, account: SETTLEMENT_TARGET.accountId }
      };

      const store = new SqliteStore(dbPath, {
        items: [...existingItems, targetItem],
        posting: { quota: { '2026-11-01': { [SETTLEMENT_TARGET.accountId]: 11 } } }
      });
      await store.load();
      await store.close();

      await assert.rejects(
        () => settleItem53d0({ dbPath, logFilePath: logPath, isApply: true }),
        /QUOTA_RECONCILIATION_AMBIGUOUS/
      );
    });

    it('4. 0 items / quota 8 -> fails closed with QUOTA_RECONCILIATION_AMBIGUOUS', async () => {
      const targetItem = {
        id: SETTLEMENT_TARGET.id,
        state: 'ambiguous',
        payload: { text: SETTLEMENT_TARGET.fullText, account: SETTLEMENT_TARGET.accountId }
      };

      const store = new SqliteStore(dbPath, {
        items: [targetItem],
        posting: { quota: { '2026-11-01': { [SETTLEMENT_TARGET.accountId]: 8 } } }
      });
      await store.load();
      await store.close();

      await assert.rejects(
        () => settleItem53d0({ dbPath, logFilePath: logPath, isApply: true }),
        /QUOTA_RECONCILIATION_AMBIGUOUS/
      );
    });
  });
});
