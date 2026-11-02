'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const { createLinkExports, dayOf, csv } = require(path.join(ROOT, 'src/linkExports'));
const {
  TelegramUi,
  MAX_ACTIVE_ACCOUNTS,
  ISOLATION_REASONS,
  formatIsolationReason,
  buildIsolationMessage
} = require(path.join(ROOT, 'src/telegramUi'));
const {
  SingleInstanceLock,
  isConflict409,
  executeWithConflictBackoff
} = require(path.join(ROOT, 'src/singleInstance'));
const { SqliteStore } = require(path.join(ROOT, 'src/sqliteStore'));

function createMockTelegramApi() {
  const sentDocuments = [];
  const sentMessages = [];
  return {
    sentDocuments,
    sentMessages,
    getMe: async () => ({ id: 1, is_bot: true, username: 'test_bot' }),
    sendMessage: async (arg1, arg2) => {
      const text = typeof arg1 === 'object' && arg1 ? arg1.text : arg2;
      const chatId = typeof arg1 === 'object' && arg1 ? arg1.chat_id : arg1;
      sentMessages.push({ chatId, text });
      return { message_id: Math.floor(Math.random() * 10000) + 1 };
    },
    sendDocument: async (payload) => {
      sentDocuments.push(payload);
      return { message_id: Math.floor(Math.random() * 10000) + 1 };
    },
    editMessageText: async () => ({ message_id: 1 }),
    deleteMessage: async () => {},
    answerCallbackQuery: async () => {},
    getUpdates: async () => []
  };
}

describe('Milestone M3: Telegram UI, CSV Export Deduplication, Single Isolation Alert & 409 Resilience', () => {

  // =========================================================================
  // 1. CSV EXPORT DEDUPLICATION (linkExports.js)
  // =========================================================================
  describe('1. CSV Export Deduplication (Bot/src/linkExports.js)', () => {

    test('1.1 Terminal export is delivered on first run when published posts exist', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-csv-test-1-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const now = new Date('2026-11-02T10:00:00.000Z');
      const day = dayOf(now);

      const store = new SqliteStore(dbPath, {
        items: [
          { id: 'item-1', state: 'published', url: 'https://x.com/status/1', publishedAt: now.toISOString(), payload: { text: 'Post 1' } },
          { id: 'item-2', state: 'published', url: 'https://x.com/status/2', publishedAt: now.toISOString(), payload: { text: 'Post 2' } }
        ],
        accounts: [{ id: 'acc-1', username: 'testuser', enabled: true }]
      });
      await store.load();

      const api = createMockTelegramApi();
      const links = createLinkExports({
        store,
        dataDir: tempDir,
        api,
        chatId: '123456',
        clock: () => now
      });

      const run1 = { runId: 'run-alpha', endedAt: now.toISOString(), itemIds: ['item-1', 'item-2'] };
      await links.send(run1, { terminal: true });

      assert.strictEqual(api.sentDocuments.length, 1, 'Exactly 1 CSV document sent on first terminal run');
      assert.strictEqual(api.sentDocuments[0].chat_id, '123456');
      assert.strictEqual(api.sentDocuments[0].filename, `links_${day}.csv`);
      assert.ok(api.sentDocuments[0].content.includes('https://x.com/status/1'));
      assert.ok(api.sentDocuments[0].content.includes('https://x.com/status/2'));

      const state = await store.load();
      assert.strictEqual(state.linkDeliveries.length, 1);
      assert.strictEqual(state.linkDeliveries[0].ok, true);
      assert.strictEqual(state.linkDeliveries[0].itemIds.length, 2);
    });

    test('1.2 Stopping cycle with zero new links suppresses duplicate CSV transmission', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-csv-test-2-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const now = new Date('2026-11-02T10:00:00.000Z');

      const store = new SqliteStore(dbPath, {
        items: [
          { id: 'item-1', state: 'published', url: 'https://x.com/status/1', publishedAt: now.toISOString(), payload: { text: 'Post 1' } },
          { id: 'item-2', state: 'published', url: 'https://x.com/status/2', publishedAt: now.toISOString(), payload: { text: 'Post 2' } }
        ],
        accounts: [{ id: 'acc-1', username: 'testuser', enabled: true }]
      });
      await store.load();

      const api = createMockTelegramApi();
      const logs = [];
      const logger = { log: msg => logs.push(msg), error: () => {} };
      const links = createLinkExports({
        store,
        dataDir: tempDir,
        api,
        chatId: '123456',
        logger,
        clock: () => now
      });

      // Run 1: Delivers the 2 posts
      const run1 = { runId: 'run-1', endedAt: now.toISOString(), itemIds: ['item-1', 'item-2'] };
      await links.send(run1, { terminal: true });
      assert.strictEqual(api.sentDocuments.length, 1, 'Run 1 delivered 1 CSV');

      // Run 2: Stopped cycle with NO new posts (same item IDs)
      const later = new Date('2026-11-02T10:05:00.000Z');
      const run2 = { runId: 'run-2', endedAt: later.toISOString(), itemIds: [] };
      await links.send(run2, { terminal: true });

      assert.strictEqual(api.sentDocuments.length, 1, 'Run 2 must NOT deliver duplicate CSV when zero new items exist');

      const state = await store.load();
      // Terminal event for run2 is marked suppressed and reconciled
      const run2Event = state.linkTerminalEvents.find(e => e.runId === 'run-2');
      assert.ok(run2Event, 'Terminal event recorded for run-2');
      assert.strictEqual(run2Event.suppressed, true, 'Terminal event marked suppressed');
      assert.strictEqual(run2Event.reconciled, true, 'Terminal event marked reconciled');

      // Verify log message confirms suppression
      const suppressionLog = logs.find(l => l.includes('link_export_terminal_suppressed'));
      assert.ok(suppressionLog, 'Logged link_export_terminal_suppressed event');
    });

    test('1.3 Publishing new links delivers an updated CSV on subsequent cycle stop', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-csv-test-3-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const now = new Date('2026-11-02T10:00:00.000Z');

      const store = new SqliteStore(dbPath, {
        items: [
          { id: 'item-1', state: 'published', url: 'https://x.com/status/1', publishedAt: now.toISOString(), payload: { text: 'Post 1' } }
        ],
        accounts: [{ id: 'acc-1', username: 'testuser', enabled: true }]
      });
      await store.load();

      const api = createMockTelegramApi();
      const links = createLinkExports({
        store,
        dataDir: tempDir,
        api,
        chatId: '123456',
        clock: () => now
      });

      // Run 1: Delivers 1 post
      await links.send({ runId: 'run-1', endedAt: now.toISOString(), itemIds: ['item-1'] }, { terminal: true });
      assert.strictEqual(api.sentDocuments.length, 1);

      // Now add item-2 to published posts
      await store.update(s => {
        s.items.push({
          id: 'item-2',
          state: 'published',
          url: 'https://x.com/status/2',
          publishedAt: now.toISOString(),
          payload: { text: 'Post 2' }
        });
        return s;
      });

      // Run 2: Stopping cycle with the new item present
      await links.send({ runId: 'run-2', endedAt: now.toISOString(), itemIds: ['item-2'] }, { terminal: true });
      assert.strictEqual(api.sentDocuments.length, 2, 'New item triggers second CSV delivery');
      assert.ok(api.sentDocuments[1].content.includes('https://x.com/status/1'));
      assert.ok(api.sentDocuments[1].content.includes('https://x.com/status/2'));
    });

    test('1.4 Deduplication by sha256 content hash prevents redundant delivery', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-csv-test-4-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const now = new Date('2026-11-02T10:00:00.000Z');
      const day = dayOf(now);

      const rows = [
        { id: 'item-1', state: 'published', url: 'https://x.com/status/1', publishedAt: now.toISOString(), payload: { text: 'Post 1' } }
      ];
      const csvContent = csv(rows);
      const expectedHash = crypto.createHash('sha256').update(csvContent).digest('hex');

      // Pre-populate state with an existing delivery having identical contentHash
      const store = new SqliteStore(dbPath, {
        items: rows,
        linkDeliveries: [{
          deliveryId: 'del-old',
          outboxId: 'out-old',
          runId: 'run-old',
          day,
          kind: 'document',
          chatId: '123456',
          itemIds: ['item-1'],
          contentHash: expectedHash,
          attempted: true,
          ok: true,
          attemptedAt: now.toISOString(),
          deliveredAt: now.toISOString(),
          messageId: 999
        }]
      });
      await store.load();

      const api = createMockTelegramApi();
      const links = createLinkExports({
        store,
        dataDir: tempDir,
        api,
        chatId: '123456',
        clock: () => now
      });

      await links.send({ runId: 'run-new', endedAt: now.toISOString(), itemIds: ['item-1'] }, { terminal: true });

      assert.strictEqual(api.sentDocuments.length, 0, 'No document sent because contentHash already delivered successfully');

      const state = await store.load();
      const terminalEvent = state.linkTerminalEvents.find(e => e.runId === 'run-new');
      assert.ok(terminalEvent);
      assert.strictEqual(terminalEvent.suppressed, true);
      assert.strictEqual(terminalEvent.reason, 'duplicate_content_hash');
    });
  });

  // =========================================================================
  // 2. SINGLE ISOLATION ALERT & RETRY SPAM SUPPRESSION (telegramUi.js)
  // =========================================================================
  describe('2. Single Clear Isolation Notification & Retry Spam Suppression (Bot/src/telegramUi.js)', () => {

    test('2.1 Format isolation reasons maps all failure classes accurately', () => {
      assert.strictEqual(formatIsolationReason('banned'), ISOLATION_REASONS.BANNED);
      assert.strictEqual(formatIsolationReason('محظور'), ISOLATION_REASONS.BANNED);
      assert.strictEqual(formatIsolationReason('permanent_ban'), ISOLATION_REASONS.BANNED);

      assert.strictEqual(formatIsolationReason('captcha'), ISOLATION_REASONS.CAPTCHA);
      assert.strictEqual(formatIsolationReason('كابتشا'), ISOLATION_REASONS.CAPTCHA);
      assert.strictEqual(formatIsolationReason('security_challenge'), ISOLATION_REASONS.CAPTCHA);

      assert.strictEqual(formatIsolationReason('3_failures'), ISOLATION_REASONS.STRIKES_EXCEEDED);
      assert.strictEqual(formatIsolationReason('معزول (3 إخفاقات)'), ISOLATION_REASONS.STRIKES_EXCEEDED);
      assert.strictEqual(formatIsolationReason('exceeded_strikes'), ISOLATION_REASONS.STRIKES_EXCEEDED);

      assert.strictEqual(formatIsolationReason('cookie_expired'), ISOLATION_REASONS.COOKIE_REJECTED);
      assert.strictEqual(formatIsolationReason('session_rejected'), ISOLATION_REASONS.COOKIE_REJECTED);
      assert.strictEqual(formatIsolationReason('رفض جلسة الكوكيز'), ISOLATION_REASONS.COOKIE_REJECTED);
    });

    test('2.2 buildIsolationMessage constructs correct Arabic notification text', () => {
      // With other accounts remaining:
      const msgContinuing = buildIsolationMessage({
        username: 'testuser',
        reason: '3_failures',
        otherActiveCount: 2
      });
      assert.strictEqual(
        msgContinuing,
        'تم عزل الحساب @testuser تلقائياً (السبب: تجاوز 3 إخفاقات طبيعية (Exceeded 3 qualified strikes)) ومواصلة الدورة عبر بقية الحسابات (2).'
      );

      // With no other accounts remaining:
      const msgHalted = buildIsolationMessage({
        username: '@banneduser',
        reason: 'banned',
        otherActiveCount: 0
      });
      assert.strictEqual(
        msgHalted,
        'تم عزل الحساب @banneduser تلقائياً (السبب: محظور قطعي (Permanent Ban)). لا توجد حسابات مؤهلة متبقية؛ توقفت الدورة.'
      );
    });

    test('2.3 sendIsolationAlert dispatches exactly 1 alert via notify', async () => {
      const notifications = [];
      const mockNotify = async text => { notifications.push(text); };
      const ui = new TelegramUi({
        bot: {},
        notify: mockNotify
      });

      const account = { id: 'acc-1', username: 'trader_x', status: 'معزول (3 إخفاقات)' };
      await ui.sendIsolationAlert({ account, reason: '3_failures', failures: 3, otherActiveCount: 1 });

      assert.strictEqual(notifications.length, 1, 'Exactly 1 notification sent');
      assert.ok(notifications[0].includes('@trader_x'));
      assert.ok(notifications[0].includes('السبب: تجاوز 3 إخفاقات طبيعية'));
      assert.ok(notifications[0].includes('ومواصلة الدورة عبر بقية الحسابات (1)'));
    });

    test('2.4 Transient strikes (1 and 2) are suppressed from sending Telegram notifications', async () => {
      const notifications = [];
      const mockNotify = async text => { notifications.push(text); };
      const ui = new TelegramUi({
        bot: {},
        notify: mockNotify
      });

      assert.strictEqual(ui.shouldNotifyStrike(1), false, 'Strike 1 must not notify');
      assert.strictEqual(ui.shouldNotifyStrike(2), false, 'Strike 2 must not notify');
      assert.strictEqual(ui.shouldNotifyStrike(3), true, 'Strike 3 must notify');

      const res1 = await ui.notifyStrike({ account: { username: 'user1' }, strikeNumber: 1 });
      assert.strictEqual(res1.notified, false);
      assert.strictEqual(res1.suppressed, true);

      const res2 = await ui.notifyStrike({ account: { username: 'user1' }, strikeNumber: 2 });
      assert.strictEqual(res2.notified, false);
      assert.strictEqual(res2.suppressed, true);

      assert.strictEqual(notifications.length, 0, 'Zero Telegram notifications emitted on transient strikes');

      // Strike 3 sends isolation alert
      const res3 = await ui.notifyStrike({ account: { username: 'user1' }, strikeNumber: 3 });
      assert.strictEqual(res3.notified, true);
      assert.strictEqual(notifications.length, 1, 'Strike 3 emits exactly 1 notification');
    });

    test('2.5 Queue stall notification is throttled to send only ONCE per stall event', async () => {
      const notifications = [];
      const mockNotify = async text => { notifications.push(text); };
      const ui = new TelegramUi({
        bot: {},
        notify: mockNotify
      });

      // Pass 1: Stall detected -> notification sent
      const stall1 = await ui.sendQueueStallAlert();
      assert.strictEqual(stall1.notified, true);
      assert.strictEqual(notifications.length, 1);
      assert.strictEqual(notifications[0], 'جميع الحسابات غير مؤهلة أو في فترة انتظار؛ توقفت الدورة وبقيت المنشورات في الانتظار.');

      // Pass 2: Repeated stall in next loop pass -> throttled
      const stall2 = await ui.sendQueueStallAlert();
      assert.strictEqual(stall2.notified, false);
      assert.strictEqual(stall2.throttled, true);
      assert.strictEqual(notifications.length, 1, 'No second notification sent during same stall');

      // Pass 3: Another repeated stall pass -> still throttled
      const stall3 = await ui.sendQueueStallAlert();
      assert.strictEqual(stall3.notified, false);
      assert.strictEqual(stall3.throttled, true);
      assert.strictEqual(notifications.length, 1);

      // Recovery: Reset stall state
      ui.resetQueueStall();

      // Pass 4: Next distinct stall event -> notification sent again
      const stall4 = await ui.sendQueueStallAlert();
      assert.strictEqual(stall4.notified, true);
      assert.strictEqual(notifications.length, 2, 'New stall event sends notification');
    });

    test('2.6 Wrapped ui.notify automatically enforces stall throttling and transient strike suppression', async () => {
      const notifications = [];
      const mockNotify = async text => { notifications.push(text); };
      const ui = new TelegramUi({
        bot: {},
        notify: mockNotify
      });

      // Direct calls with stall message
      await ui.notify('جميع الحسابات غير مؤهلة أو في فترة انتظار؛ توقفت الدورة وبقيت المنشورات في الانتظار.');
      await ui.notify('جميع الحسابات غير مؤهلة أو في فترة انتظار؛ توقفت الدورة وبقيت المنشورات في الانتظار.');
      await ui.notify('جميع الحسابات غير مؤهلة أو في فترة انتظار؛ توقفت الدورة وبقيت المنشورات في الانتظار.');

      assert.strictEqual(notifications.length, 1, 'Only 1 stall notification passed through to raw notify');

      // Direct calls with transient strike text
      await ui.notify('إخفاق مؤقت للحساب @acc1 محاولة 1 من 3');
      await ui.notify('محاولة 2 من 3 للحساب @acc1');
      assert.strictEqual(notifications.length, 1, 'Transient strike text blocked from raw notify');

      // Direct call with unformatted isolation message gets auto-formatted
      await ui.notify('تم عزل الحساب @foo تلقائياً (كابتشا) ومواصلة الدورة عبر بقية الحسابات (1).');
      assert.strictEqual(notifications.length, 2);
      assert.ok(notifications[1].includes('(السبب: تحدي أمني / كابتشا (Security Challenge / CAPTCHA))'));
    });
  });

  // =========================================================================
  // 3. DYNAMIC ACCOUNT TOGGLE & 5 ACTIVE LIMIT (telegramUi.js)
  // =========================================================================
  describe('3. Dynamic Account Toggle & 5 Active Limit (Bot/src/telegramUi.js)', () => {

    test('3.1 readiness check enforces MAX_ACTIVE_ACCOUNTS = 5 limit', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-readiness-'));
      const dummyCookie = path.join(tempDir, 'cookie.json');
      fs.writeFileSync(dummyCookie, JSON.stringify({ cookies: [] }));

      // Create state with 6 active accounts
      const accounts = Array.from({ length: 6 }, (_, i) => ({
        id: `acc-${i + 1}`,
        username: `user_${i + 1}`,
        cookieFile: dummyCookie,
        enabled: true,
        status: 'مفعل'
      }));

      const state = {
        accounts,
        items: [{ id: 'item-1', state: 'pending', payload: { text: 'Hello' } }],
        settings: { delayMinSeconds: 15, delayMaxSeconds: 30 }
      };

      const ui = new TelegramUi({ bot: {}, launch: async () => {} });
      const ready = await ui.readiness(state);

      assert.ok(ready.reasons.length > 0, 'readiness should return failure reasons');
      assert.ok(
        ready.reasons.some(r => r.includes('الحد الأقصى للحسابات المفعلة')),
        'readiness must reject when > 5 active accounts exist'
      );
    });

    test('3.2 accountToggle blocks enabling a 6th active account', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-toggle-'));
      const dbPath = path.join(tempDir, 'state.sqlite');

      const accounts = [
        { id: 'acc-1', username: 'user1', enabled: true, status: 'مفعل' },
        { id: 'acc-2', username: 'user2', enabled: true, status: 'مفعل' },
        { id: 'acc-3', username: 'user3', enabled: true, status: 'مفعل' },
        { id: 'acc-4', username: 'user4', enabled: true, status: 'مفعل' },
        { id: 'acc-5', username: 'user5', enabled: true, status: 'مفعل' },
        { id: 'acc-6', username: 'user6', enabled: false, status: 'غير مفعل' }
      ];

      const store = new SqliteStore(dbPath, { accounts });
      await store.load();

      let acknowledgedText = null;
      let acknowledgedAlert = false;

      const mockTransport = {
        sendMessage: async () => ({ message_id: 1 }),
        editMessageText: async () => ({ message_id: 1 }),
        acknowledgeCallback: async (id, text, alert) => {
          acknowledgedText = text;
          acknowledgedAlert = alert;
        }
      };

      const ui = new TelegramUi({
        bot: { store, transport: mockTransport }
      });

      const request = {
        parsed: { action: 'toggle', value: 'acc-6' }
      };
      const raw = {
        callback_query: {
          id: 'cb-1',
          from: { id: 1234 },
          message: { chat: { id: 1234 }, message_id: 10 }
        }
      };

      const result = await ui.accountToggle(request, raw);

      assert.strictEqual(result.limitExceeded, true, 'Result indicates limit exceeded');
      assert.ok(acknowledgedText.includes('تجاوزت الحد للحسابات المفعلة (الحد الأقصى 5)'));
      assert.strictEqual(acknowledgedAlert, true);

      // Verify acc-6 remains disabled in SQLite store
      const afterState = await store.load();
      const acc6 = afterState.accounts.find(a => a.id === 'acc-6');
      assert.strictEqual(acc6.enabled, false, 'acc-6 was not enabled');
    });

    test('3.3 accountManage blocks enabling a 6th active account', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-manage-'));
      const dbPath = path.join(tempDir, 'state.sqlite');

      const accounts = [
        { id: 'acc-1', username: 'user1', enabled: true, status: 'مفعل' },
        { id: 'acc-2', username: 'user2', enabled: true, status: 'مفعل' },
        { id: 'acc-3', username: 'user3', enabled: true, status: 'مفعل' },
        { id: 'acc-4', username: 'user4', enabled: true, status: 'مفعل' },
        { id: 'acc-5', username: 'user5', enabled: true, status: 'مفعل' },
        { id: 'acc-6', username: 'user6', enabled: false, status: 'غير مفعل' }
      ];

      const store = new SqliteStore(dbPath, { accounts });
      await store.load();

      let acknowledgedText = null;

      const mockTransport = {
        sendMessage: async () => ({ message_id: 1 }),
        editMessageText: async () => ({ message_id: 1 }),
        acknowledgeCallback: async (id, text) => { acknowledgedText = text; }
      };

      const ui = new TelegramUi({
        bot: { store, transport: mockTransport }
      });

      const request = {
        parsed: { action: 'enable', value: 'acc-6' }
      };
      const raw = {
        callback_query: {
          id: 'cb-2',
          from: { id: 1234 },
          message: { chat: { id: 1234 }, message_id: 10 }
        }
      };

      const result = await ui.accountManage(request, raw);

      assert.strictEqual(result.limitExceeded, true);
      assert.ok(acknowledgedText.includes('تجاوزت الحد للحسابات المفعلة'));

      const afterState = await store.load();
      assert.strictEqual(afterState.accounts.find(a => a.id === 'acc-6').enabled, false);
    });

    test('3.4 Disabling an account preserves cookies, quota, and other accounts VPN slots', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-preserve-'));
      const dbPath = path.join(tempDir, 'state.sqlite');

      const accounts = [
        { id: 'acc-1', username: 'user1', enabled: true, status: 'مفعل', quota: 25, cookieFile: '/path/cookie1.json' },
        { id: 'acc-2', username: 'user2', enabled: true, status: 'مفعل', quota: 50, cookieFile: '/path/cookie2.json' }
      ];

      const store = new SqliteStore(dbPath, {
        accounts,
        vpnSlots: { 'acc-1': 1, 'acc-2': 2 },
        cycle: { state: 'running' },
        telegramUi: { run: { accountIds: ['acc-1', 'acc-2'], cursor: 0 } }
      });
      await store.load();

      const mockTransport = {
        sendMessage: async () => ({ message_id: 1 }),
        editMessageText: async () => ({ message_id: 1 }),
        acknowledgeCallback: async () => {}
      };

      const releasedSlots = [];
      const mockVpnManager = {
        release: async id => { releasedSlots.push(id); }
      };

      const ui = new TelegramUi({
        bot: { store, transport: mockTransport, vpnManager: mockVpnManager }
      });

      const request = { parsed: { action: 'toggle', value: 'acc-1' } };
      const raw = { callback_query: { id: 'cb-3', from: { id: 1 }, message: { chat: { id: 1 } } } };

      await ui.accountToggle(request, raw);

      const afterState = await store.load();
      const acc1 = afterState.accounts.find(a => a.id === 'acc-1');
      const acc2 = afterState.accounts.find(a => a.id === 'acc-2');

      // acc-1 is disabled
      assert.strictEqual(acc1.enabled, false);
      assert.strictEqual(acc1.quota, 25, 'acc-1 quota is preserved');
      assert.strictEqual(acc1.cookieFile, '/path/cookie1.json', 'acc-1 cookieFile is preserved');

      // acc-2 remains active and untouched
      assert.strictEqual(acc2.enabled, true);
      assert.strictEqual(acc2.quota, 50, 'acc-2 quota is preserved');
      assert.strictEqual(acc2.cookieFile, '/path/cookie2.json', 'acc-2 cookieFile is preserved');

      // VPN slots: acc-1 released, acc-2 retained
      assert.strictEqual(afterState.vpnSlots['acc-1'], undefined, 'acc-1 VPN slot deleted');
      assert.strictEqual(afterState.vpnSlots['acc-2'], 2, 'acc-2 VPN slot preserved');

      // Active run list: acc-1 removed, acc-2 retained
      assert.deepStrictEqual(afterState.telegramUi.run.accountIds, ['acc-2']);
    });
  });

  // =========================================================================
  // 4. TELEGRAM 409 CONFLICT RESILIENCE (singleInstance.js & telegramUi.js)
  // =========================================================================
  describe('4. Telegram 409 Conflict Resilience (singleInstance.js & telegramUi.js)', () => {

    test('4.1 isConflict409 correctly identifies 409 Conflict variations', () => {
      assert.strictEqual(isConflict409({ statusCode: 409 }), true);
      assert.strictEqual(isConflict409({ telegramCode: 409 }), true);
      assert.strictEqual(isConflict409({ code: 409 }), true);
      assert.strictEqual(isConflict409({ code: 'TELEGRAM_CONFLICT' }), true);
      assert.strictEqual(isConflict409(new Error('409 Conflict: terminated by other getUpdates request')), true);
      assert.strictEqual(isConflict409(new Error('Telegram conflict error')), true);

      // Non-409 errors
      assert.strictEqual(isConflict409({ statusCode: 500 }), false);
      assert.strictEqual(isConflict409({ telegramCode: 400 }), false);
      assert.strictEqual(isConflict409(new Error('Network timeout')), false);
      assert.strictEqual(isConflict409(null), false);
    });

    test('4.2 SingleInstanceLock acquires and releases cleanly', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-lock-1-'));
      const lockPath = path.join(tempDir, 'test.lock');

      const lock = new SingleInstanceLock(lockPath);
      assert.strictEqual(lock.locked, false);

      const release = await lock.acquire();
      assert.strictEqual(lock.locked, true);
      assert.ok(fs.existsSync(lockPath));

      await release();
      assert.strictEqual(lock.locked, false);
      assert.strictEqual(fs.existsSync(lockPath), false);
    });

    test('4.3 SingleInstanceLock rejects concurrent live process with INSTANCE_LOCKED', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-lock-2-'));
      const lockPath = path.join(tempDir, 'test.lock');

      const lock1 = new SingleInstanceLock(lockPath, { timeoutMs: 5000 });
      await lock1.acquire();

      const lock2 = new SingleInstanceLock(lockPath, { timeoutMs: 200, retryMs: 20 });
      await assert.rejects(
        async () => { await lock2.acquire(); },
        err => {
          assert.strictEqual(err.code, 'INSTANCE_LOCKED');
          assert.strictEqual(err.pid, process.pid);
          return true;
        }
      );

      await lock1.release();
    });

    test('4.4 executeWithConflictBackoff retries on transient 409 and succeeds', async () => {
      let attempts = 0;
      const sleepTimes = [];
      const mockSleep = async ms => { sleepTimes.push(ms); };

      const fn = async () => {
        attempts++;
        if (attempts <= 2) {
          const err = new Error('409 Conflict: terminated by other getUpdates request');
          err.telegramCode = 409;
          throw err;
        }
        return 'success_on_attempt_3';
      };

      const result = await executeWithConflictBackoff(fn, {
        maxRetries: 3,
        initialBackoffMs: 50,
        maxBackoffMs: 500,
        sleepFn: mockSleep,
        logger: { error: () => {} }
      });

      assert.strictEqual(result, 'success_on_attempt_3');
      assert.strictEqual(attempts, 3, 'Executed 3 attempts');
      assert.strictEqual(sleepTimes.length, 2, 'Slept twice before retry');
      assert.ok(sleepTimes[0] >= 50, 'First backoff >= 50ms');
      assert.ok(sleepTimes[1] >= 100, 'Second backoff >= 100ms (exponential)');
    });

    test('4.5 executeWithConflictBackoff throws TELEGRAM_CONFLICT when retries exhausted', async () => {
      let attempts = 0;
      const mockSleep = async () => {};

      const persistent409Fn = async () => {
        attempts++;
        const err = new Error('409 Conflict: terminated by other getUpdates request');
        err.telegramCode = 409;
        throw err;
      };

      await assert.rejects(
        async () => {
          await executeWithConflictBackoff(persistent409Fn, {
            maxRetries: 2,
            initialBackoffMs: 10,
            sleepFn: mockSleep,
            logger: { error: () => {} }
          });
        },
        err => {
          assert.strictEqual(err.code, 'TELEGRAM_CONFLICT');
          assert.strictEqual(err.telegramCode, 409);
          return true;
        }
      );

      assert.strictEqual(attempts, 3, 'Initial attempt + 2 retries = 3 attempts total');
    });

    test('4.6 TelegramUi.prototype.handle409Conflict gracefully backs off and recovers', async () => {
      const logs = [];
      const sleepTimes = [];
      const ui = new TelegramUi({
        bot: { logger: { error: msg => logs.push(msg) } }
      });

      let callCount = 0;
      const retryFn = async () => {
        callCount++;
        if (callCount < 2) {
          const err = new Error('Conflict');
          err.telegramCode = 409;
          throw err;
        }
        return { recovered: true };
      };

      const initialErr = new Error('Conflict: terminated by getUpdates');
      initialErr.telegramCode = 409;

      const res = await ui.handle409Conflict(initialErr, {
        retryFn,
        maxRetries: 3,
        initialBackoffMs: 20,
        sleepFn: async ms => { sleepTimes.push(ms); }
      });

      assert.strictEqual(res.handled, true);
      assert.strictEqual(res.retried, true);
      assert.strictEqual(res.result.recovered, true);
      assert.strictEqual(sleepTimes.length, 2);
      assert.ok(logs.some(l => l.includes('telegram_ui_conflict_detected')));
    });

    test('4.7 TelegramUi actions catches 409 without crashing UI queue', async () => {
      const logs = [];
      const ui = new TelegramUi({
        bot: {
          logger: { error: msg => logs.push(msg) },
          store: { load: async () => ({}) }
        }
      });

      // Override menu action to throw 409 conflict
      ui.menu = async () => {
        const err = new Error('409 Conflict');
        err.telegramCode = 409;
        throw err;
      };

      const actions = ui.actions();
      const request = {};
      const raw = { message: { chat: { id: 100 }, from: { id: 200 } } };

      // Should resolve cleanly without uncaught exception
      await actions.menu(request, raw);

      assert.ok(logs.some(l => l.includes('telegram_ui_conflict_409')), '409 was caught and logged gracefully');
    });
  });

});
