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

describe('M14 Round 4: Verified Review Blocker Regression Tests', () => {
  let tempDir;
  let dbPath;
  let logPath;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm14-round4-'));
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
  /* P0-A & P0-B: Per-Chat Verified Delivery & Failure Recovery                 */
  /* -------------------------------------------------------------------------- */

  describe('P0-A & P0-B: Verified Delivery Receipts & Per-Chat State Tracking', () => {
    it('1. sendIsolationAlert rejects undefined, null, true, and unacknowledged objects', async () => {
      const testAccount = {
        id: 'acc_no_receipt',
        username: 'unverified_user',
        status: 'كابتشا',
        needsOwnerCaptcha: true,
        captchaIncidentId: 'inc_receipt_1'
      };

      const store = new SqliteStore(dbPath, { accounts: [accountRecord(testAccount)] });
      await store.load();

      // Test cases of invalid receipts that MUST NOT be marked delivered
      const invalidReceipts = [
        undefined,
        null,
        true,
        false,
        {},
        { ok: false },
        { ok: true }, // missing message_id
        { message_id: null },
        [{ status: 'rejected', reason: new Error('Network error') }],
        [{ status: 'fulfilled', value: undefined }],
        [{ status: 'fulfilled', value: { ok: false } }],
        [{ status: 'fulfilled', value: { ok: true } }] // missing message_id
      ];

      for (const invalidReceipt of invalidReceipts) {
        const ui = new TelegramUi({
          bot: { store, transport: {} },
          autoStartTicker: false,
          notify: async () => invalidReceipt
        });

        const res = await ui.sendIsolationAlert({ account: testAccount, reason: 'captcha' });
        assert.strictEqual(res, null, `Invalid receipt ${JSON.stringify(invalidReceipt)} must return null`);

        const state = await store.load();
        const a = state.accounts.find(acc => acc.id === 'acc_no_receipt');
        assert.strictEqual(a.lastNotifiedCaptchaIncidentId, undefined, 'Must not mark delivered on invalid receipt');
        await ui.destroy();
      }

      await store.close();
    });

    it('2. dual-chat delivery: partial failure does NOT mark incident complete and retries only pending chat', async () => {
      const testAccount = {
        id: 'acc_dual_chat',
        username: 'dual_admin_user',
        status: 'كابتشا',
        needsOwnerCaptcha: true,
        captchaIncidentId: 'inc_dual_1'
      };

      const store = new SqliteStore(dbPath, { accounts: [accountRecord(testAccount)] });
      await store.load();

      const chatOwner = '528864559';
      const chatBrother = '5535435580';

      const mockAuth = {
        chats: new Set([chatOwner, chatBrother])
      };

      let attemptCount = 0;
      let sentTargetsLog = [];

      const ui = new TelegramUi({
        bot: { store, auth: mockAuth, transport: {} },
        autoStartTicker: false,
        notify: async (text, options) => {
          attemptCount++;
          const targetChatIds = options?.targetChatIds || [chatOwner, chatBrother];
          sentTargetsLog.push([...targetChatIds]);

          if (attemptCount === 1) {
            // Attempt 1: chatOwner succeeds, chatBrother fails
            return targetChatIds.map(cid => {
              if (cid === chatOwner) {
                return { status: 'fulfilled', value: { ok: true, message_id: 1630, chat_id: chatOwner } };
              }
              return { status: 'rejected', reason: new Error('ETIMEDOUT') };
            });
          }

          // Attempt 2: retry succeeds for the remaining chat (chatBrother)
          return targetChatIds.map(cid => ({
            status: 'fulfilled',
            value: { ok: true, message_id: 1631, chat_id: cid }
          }));
        }
      });

      // --- Turn 1: First alert dispatch ---
      const r1 = await ui.sendIsolationAlert({ account: testAccount, reason: 'captcha' });
      assert.ok(r1, 'Returns message text because chatOwner succeeded');
      assert.deepStrictEqual(sentTargetsLog[0], [chatOwner, chatBrother], 'Turn 1 targets both admin chats');

      // Verify DB state after Turn 1:
      let state = await store.load();
      let a = state.accounts.find(acc => acc.id === 'acc_dual_chat');
      assert.deepStrictEqual(a.captchaDeliveredChats, [chatOwner], 'Only chatOwner is marked in captchaDeliveredChats');
      assert.strictEqual(a.lastNotifiedCaptchaIncidentId, undefined, 'Incident is NOT marked complete because chatBrother failed');

      // --- Turn 2: Retry alert dispatch ---
      const r2 = await ui.sendIsolationAlert({ account: a, reason: 'captcha' });
      assert.ok(r2, 'Returns message text because chatBrother succeeded');
      assert.deepStrictEqual(sentTargetsLog[1], [chatBrother], 'Turn 2 retries ONLY pending chatBrother (no duplicate to chatOwner!)');

      // Verify DB state after Turn 2:
      state = await store.load();
      a = state.accounts.find(acc => acc.id === 'acc_dual_chat');
      assert.deepStrictEqual(a.captchaDeliveredChats.sort(), [chatBrother, chatOwner].sort(), 'Both chats are now delivered');
      assert.strictEqual(a.lastNotifiedCaptchaIncidentId, 'inc_dual_1', 'Incident is now marked 100% complete');

      // --- Turn 3: Subsequent call is completely suppressed ---
      const r3 = await ui.sendIsolationAlert({ account: a, reason: 'captcha' });
      assert.strictEqual(r3, null, 'Turn 3 must be completely suppressed');
      assert.strictEqual(attemptCount, 2, 'No redundant notify call made');

      await ui.destroy();
      await store.close();
    });

    it('3. runner integration: code 326 / Arkose failure invokes durable alert, disables account, prevents POST', async () => {
      const runnerMod = require('../src/runner');
      const cookieFile = path.join(tempDir, 'fake_cookies.json');
      fs.writeFileSync(cookieFile, JSON.stringify([{ name: 'auth_token', value: '123' }]));

      const testAccount = {
        id: 'acc_runner_326',
        username: 'runner_captcha_user',
        userId: '887766',
        enabled: true,
        status: 'مفعل',
        cookieFile
      };

      const testItem = {
        id: 'item_326_1',
        state: 'pending',
        payload: { text: 'Test tweet that should never post live' }
      };

      const runnerStore = new SqliteStore(dbPath, {
        accounts: [accountRecord(testAccount)],
        items: [testItem],
        settings: { delayMinSeconds: 1, delayMaxSeconds: 2 }
      });
      await runnerStore.load();
      await runnerStore.close();

      const deliveredAlerts = [];
      const mockApi = {
        getMe: async () => ({ id: 123456, is_bot: true, username: 'test_yj_bot' }),
        sendMessage: async ({ chat_id, text }) => {
          deliveredAlerts.push({ chat_id, text });
          return { ok: true, result: { message_id: 1632, chat: { id: chat_id } } };
        },
        answerCallbackQuery: async () => ({ ok: true }),
        getUpdates: async () => [],
        getFile: async () => ({ file_path: 'mock' }),
        downloadFile: async () => Buffer.from('mock')
      };

      let publishCallCount = 0;
      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async () => ({
          slot: 1,
          identity: {
            authenticated: false,
            accountFailure: 'captcha',
            xErrorCode: 326,
            reason: 'Arkose CAPTCHA challenge detected'
          }
        }),
        publish: async () => {
          publishCallCount++;
          return { published: false };
        },
        close: async () => {}
      });

      // Run runner with maxPolls: 0 so it executes the cycle and returns cleanly
      await runnerMod.run({
        token: 'test_token',
        userId: '528864559',
        chatId: '528864559',
        allowedUserIds: ['528864559'],
        allowedChatIds: ['528864559'],
        dataDir: tempDir,
        api: mockApi,
        vpnManager: {
          ensure: async () => ({ exitIp: '198.51.100.1', proxy: 'socks5h://127.0.0.1:18801' }),
          health: async () => ({ healthy: true }),
          rotate: async () => {}
        },
        maxPolls: 0,
        publishAdapterFactory,
        sleepFn: async () => {},
        attemptTimeoutMs: 3000,
        logger: { log: () => {}, error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
        onRuntimeReady: async (ctx) => {
          await ctx.start({ stopAfterSuccess: true });
        }
      });

      // Verify ZERO calls were made to publish (no POST to X)
      assert.strictEqual(publishCallCount, 0, 'Zero publish calls allowed after CAPTCHA detection');

      // Verify that isolation alert was delivered through Telegram API with human instructions
      assert.ok(deliveredAlerts.length > 0, 'Isolation alert must be delivered to Telegram');
      const captchaAlert = deliveredAlerts.find(a => a.text.includes('كابتشا'));
      assert.ok(captchaAlert, 'Alert text must reference captcha isolation');
      assert.ok(captchaAlert.text.includes('الموقع/التطبيق الرسمي'), 'Alert text must include human-only instructions');

      // Verify final account state in SQLite
      const finalStore = new SqliteStore(dbPath);
      const finalState = await finalStore.load();
      const finalAcc = finalState.accounts.find(a => a.id === 'acc_runner_326');

      assert.strictEqual(finalAcc.enabled, false, 'Account must be disabled immediately');
      assert.strictEqual(finalAcc.status, 'كابتشا', 'Status must be set to كابتشا');
      assert.strictEqual(finalAcc.needsOwnerCaptcha, true, 'needsOwnerCaptcha must be true');
      assert.strictEqual(finalAcc.captchaCode, 326, 'captchaCode must preserve 326');
      assert.ok(finalAcc.captchaIncidentId, 'captchaIncidentId must be populated');
      assert.strictEqual(finalAcc.lastNotifiedCaptchaIncidentId, finalAcc.captchaIncidentId, 'lastNotifiedCaptchaIncidentId must be recorded');
      assert.deepStrictEqual(finalAcc.captchaDeliveredChats, ['528864559'], 'captchaDeliveredChats must record confirmed chat delivery');

      await finalStore.close();
    });
  });

  /* -------------------------------------------------------------------------- */
  /* P0-C: Periodic Unverified Session Preservation of Pending CAPTCHA          */
  /* -------------------------------------------------------------------------- */

  describe('P0-C: Periodic Check Does NOT Destroy Pending CAPTCHA Workflow', () => {
    it('1. CAPTCHA -> unverified refresh -> owner verify success leaves account disabled', async () => {
      const testAccount = {
        id: 'acc_p0c',
        username: 'pending_captcha_user',
        userId: '778899',
        enabled: false,
        status: 'كابتشا (مطلوب حل يدوي)',
        needsOwnerCaptcha: true,
        captchaIncidentId: 'incident_p0c_1',
        checkGeneration: 'gen_orig_1',
        cookieFile: '/tmp/cookies_p0c.json'
      };

      const store = new SqliteStore(dbPath, { accounts: [accountRecord(testAccount)] });
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
        autoStartTicker: false,
        isolatedVerifier: {
          verify: async () => ({
            authenticated: true,
            username: 'pending_captcha_user',
            userId: '778899',
            challenge: false,
            locked: false,
            captcha: false,
            suspended: false,
            banned: false,
            accountFailure: null
          })
        }
      });

      // Step 1: Simulate a periodic background check encountering auth_session_unverified
      const checkApplied = await ui.recordAccountCheck(
        'acc_p0c',
        {
          isolated: true,
          vpnHealthy: true,
          exitIp: '192.0.2.1',
          authenticated: false,
          accountFailure: 'auth_session_unverified'
        },
        { session: true, source: 'x-session', refresh: true }
      );
      assert.strictEqual(checkApplied, true);

      // Verify that the pending CAPTCHA status and generation were PRESERVED!
      let state = await store.load();
      let a = state.accounts.find(acc => acc.id === 'acc_p0c');
      assert.strictEqual(a.status, 'كابتشا (مطلوب حل يدوي)', 'Status must NOT be overwritten to غير محقق');
      assert.strictEqual(a.needsOwnerCaptcha, true, 'needsOwnerCaptcha must remain true');
      assert.strictEqual(a.captchaIncidentId, 'incident_p0c_1', 'Incident ID must remain unchanged');
      assert.strictEqual(a.checkGeneration, 'gen_orig_1', 'checkGeneration must NOT be altered');

      // Step 2: Owner completes challenge on official X website and clicks "✅ تم الحل"
      const res = await ui.accountManage(
        { parsed: { action: 'verify_captcha', value: 'acc_p0c' } },
        { callback_query: { id: 'cb_p0c', from: { id: 123 }, message: { chat: { id: 123 }, message_id: 20 } } }
      );

      assert.strictEqual(res.verified, true, 'Verification MUST succeed under CAS');
      assert.strictEqual(res.status, 'غير مفعل');

      state = await store.load();
      a = state.accounts.find(acc => acc.id === 'acc_p0c');
      assert.strictEqual(a.status, 'غير مفعل', 'Account must be غير مفعل');
      assert.strictEqual(a.enabled, false, 'Must remain disabled pending explicit manual owner enable');
      assert.strictEqual(a.needsOwnerCaptcha, false, 'Challenge must be cleared');

      await ui.destroy();
      await store.close();
    });
  });

  /* -------------------------------------------------------------------------- */
  /* P1-D: Atomic Inode/Token-Fenced Orphan Lock Recovery Race                  */
  /* -------------------------------------------------------------------------- */

  describe('P1-D: SQLite-fenced orphan recovery', () => {
    it('1. three concurrent contenders cannot overlap during orphan reclamation', async () => {
      const logger1 = new ForensicLogger({ dataDir: tempDir, logFile: logPath });
      const logger2 = new ForensicLogger({ dataDir: tempDir, logFile: logPath });
      const logger3 = new ForensicLogger({ dataDir: tempDir, logFile: logPath });
      await logger1._withLogLock(async () => {}); // initialize SQLite registry
      const db = new DatabaseSync(mutexDbPath(logPath));
      db.prepare('INSERT INTO forensic_mutex (id, owner_pid, owner_start, owner_token) VALUES (1, ?, ?, ?)')
        .run(99999999, '0', 'orphaned_token');
      db.close();

      let active = 0;
      let maxActive = 0;
      let completed = 0;
      await Promise.all([logger1, logger2, logger3].map(logger =>
        logger._withLogLock(async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise(resolve => setTimeout(resolve, 50));
          active -= 1;
          completed += 1;
        })
      ));
      assert.strictEqual(maxActive, 1, 'Mutual exclusion must hold even when stale owner is reclaimed');
      assert.strictEqual(completed, 3);
      const check = new DatabaseSync(mutexDbPath(logPath));
      assert.strictEqual(check.prepare('SELECT COUNT(*) AS n FROM forensic_mutex').get().n, 0);
      check.close();
    });
  });
});
