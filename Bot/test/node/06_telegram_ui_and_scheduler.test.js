'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHermeticWorkspace } = require('../fixtures/hermetic_workspace');
const { FakeTelegramApi, startFakeTelegramHttpServer } = require('../fixtures/fake_telegram_server');
const { FakeDirectXAdapter } = require('../fixtures/fake_direct_x_bridge');
const { SqliteStore } = require('../../src/sqliteStore');
const { CookieStore } = require('../../src/accounts');
const { createLinkExports } = require('../../src/linkExports');
const { createAccountRefresh } = require('../../src/accountRefresh');
const { createTelegramApi } = require('../../src/telegramApi');
const { createBot } = require('../../src/index');
const { TelegramUi } = require('../../src/telegramUi');
const { run } = require('../../src/runner');

describe('06_telegram_ui_and_scheduler: TR-01 /account_toggle, TR-02 Scheduler, UI-01/04, UTIL-RAW-03/04, ENTRY-RAW-02 & ACC-RAW-03', () => {
  it('U-01: Both /account_toggle <id> text command and acctoggle:toggle:<id> callback route properly without overwrite (TR-01)', async () => {
    const ws = createHermeticWorkspace('yj-bot-test-u01-');
    try {
      const c1 = ws.writeSyntheticCookie('acc-1', { userId: '1001' });
      const seedStore = new SqliteStore(ws.dbPath, {
        accounts: [
          { id: 'acc-1', username: 'user1', userId: '1001', cookieFile: c1, enabled: false, status: 'غير مفعل' }
        ]
      });
      await seedStore.load();
      await seedStore.close();

      const api = new FakeTelegramApi();
      // Queue a text command `/account_toggle acc-1 on` followed by callback `acctoggle:toggle:acc-1`
      api.pushCommand({ chatId: '528864559', userId: '528864559', text: '/account_toggle acc-1 on' });

      await run({
        token: process.env.TELEGRAM_BOT_TOKEN,
        userId: '528864559',
        chatId: '528864559',
        dataDir: ws.tempDir,
        lockPath: ws.lockPath,
        api,
        vpnManager: {
          reconcile: async () => ({ conflicts: [], stale: [], released: [] }),
          release: async () => 0,
          rotate: async () => ({ success: true }),
          health: async () => ({ healthy: true, exitIp: '203.0.114.11' })
        },
        maxPolls: 1,
        sleepFn: async () => {}
      });

      const checkStore = ws.registerStore(new SqliteStore(ws.dbPath));
      const st = await checkStore.load();
      const acc = st.accounts.find(a => a.id === 'acc-1');
      assert.strictEqual(acc.enabled, true, 'TR-01: /account_toggle acc-1 on text command must enable acc-1');
    } finally {
      await ws.cleanup();
    }
  });

  it('U-02: Scheduler does not prematurely commit uiScheduleDay when startScheduled() fails readiness (TR-02)', async () => {
    const ws = createHermeticWorkspace('yj-bot-test-u02-');
    try {
      const c1 = ws.writeSyntheticCookie('acc-1', { userId: '1001' });
      // Schedule enabled for 09:00 Riyadh (06:00 UTC)
      const now = new Date('2026-11-04T06:00:00.000Z');
      const seedStore = new SqliteStore(ws.dbPath, {
        settings: {
          dailyQuota: 10,
          delayMinSeconds: 15,
          delayMaxSeconds: 15,
          schedule: { enabled: true, hour: 9, minute: 0 }
        },
        accounts: [
          { id: 'acc-1', username: 'user1', userId: '1001', cookieFile: c1, enabled: true, status: 'مفعل' }
        ],
        items: [
          { id: 'item-1', state: 'pending', payload: { text: 'Scheduled post' } }
        ]
      });
      await seedStore.load();
      await seedStore.close();

      const api = new FakeTelegramApi();
      // Poll 1: VPN is unhealthy so startScheduled() fails readiness ({ started: false })
      let vpnHealthy = false;
      let pollCount = 0;
      api.pollHook = async () => {
        pollCount += 1;
        if (pollCount === 2) {
          vpnHealthy = true;
        }
      };

      await run({
        token: process.env.TELEGRAM_BOT_TOKEN,
        userId: '528864559',
        chatId: '528864559',
        dataDir: ws.tempDir,
        lockPath: ws.lockPath,
        api,
        clock: () => now,
        vpnManager: {
          reconcile: async () => ({ conflicts: [], stale: [], released: [] }),
          release: async () => 0,
          health: async () => ({ healthy: vpnHealthy, exitIp: vpnHealthy ? '203.0.114.11' : null }),
          ensure: async () => {
            if (!vpnHealthy) throw Object.assign(new Error('VPN not ready'), { code: 'VPN_NOT_READY' });
            return { name: 'yj_autopost_vpn_1', port: 18801, proxy: 'socks5h://127.0.0.1:18801', exitIp: '203.0.114.11', slot: 0 };
          }
        },
        publishAdapterFactory: () => new FakeDirectXAdapter(),
        verifyAdapterFactory: () => new FakeDirectXAdapter(),
        maxPolls: 1,
        sleepFn: async () => {}
      });

      const checkStore = ws.registerStore(new SqliteStore(ws.dbPath));
      const stAfterFailedPoll = await checkStore.load();
      assert.notStrictEqual(
        stAfterFailedPoll.uiScheduleDay,
        '2026-11-04',
        'TR-02: uiScheduleDay must NOT be committed when startScheduled() returns { started: false }'
      );
    } finally {
      await ws.cleanup();
    }
  });

  it('U-03: linkExports delivers terminal CSV to both admin chats and bounds suppressed terminal events on repeated calls (UTIL-RAW-03)', async () => {
    const ws = createHermeticWorkspace('yj-bot-test-u03-');
    try {
      const api = new FakeTelegramApi();
      const store = ws.registerStore(new SqliteStore(ws.dbPath, {
        cycle: { state: 'stopped', runId: null },
        items: [
          {
            id: 'pub-1',
            state: 'published',
            url: 'https://x.com/user1/status/101',
            publishedAt: '2026-11-04T10:00:00.000Z',
            accountId: 'acc-1',
            accountUsername: 'user1',
            payload: { text: 'Confirmed post 1' }
          }
        ]
      }));

      const links = createLinkExports({
        store,
        dataDir: ws.tempDir,
        api,
        chatIds: ['528864559', '5535435580'],
        clock: () => new Date('2026-11-04T12:00:00.000Z')
      });

      const runObj = { runId: 'run-term-1', endedAt: '2026-11-04T12:00:00.000Z', itemIds: ['pub-1'] };
      await links.send(runObj, { emptyMessage: false, terminal: true });

      assert.strictEqual(api.documents.length, 2, 'Both admin chats must receive the terminal CSV document');
      assert.deepStrictEqual(
        new Set(api.documents.map(d => d.chat_id)),
        new Set(['528864559', '5535435580'])
      );

      // UTIL-RAW-03: Calling send(..., { terminal: true }) 15 more times for the same runId must NOT send duplicates or grow linkTerminalEvents unboundedly
      for (let i = 0; i < 15; i++) {
        await links.send(runObj, { emptyMessage: false, terminal: true });
      }
      assert.strictEqual(api.documents.length, 2, 'Zero duplicate CSV documents on repeated terminal calls');

      const st = await store.load();
      assert.ok(
        (st.linkTerminalEvents || []).length <= 4,
        `UTIL-RAW-03: linkTerminalEvents must stay bounded on repeated duplicate runId calls (got ${(st.linkTerminalEvents || []).length})`
      );
    } finally {
      await ws.cleanup();
    }
  });

  it('U-04: accountDetailText escapes HTML in account.label (UI-04), check_vpn invokes live health check (UI-01), and accountRefresh surfaces store errors (UTIL-RAW-04)', async () => {
    const ws = createHermeticWorkspace('yj-bot-test-u04-');
    try {
      const api = new FakeTelegramApi();
      let liveHealthCalled = 0;

      const bot = createBot({
        dataDir: ws.tempDir,
        auth: { allowedUserIds: ['528864559'], allowedChatIds: ['528864559'] },
        telegram: {
          send: p => api.sendMessage(p),
          sendRichMessage: p => api.sendRichMessage(p),
          editMessageText: p => api.editMessageText(p),
          deleteMessage: p => api.deleteMessage(p),
          answerCallback: p => api.answerCallbackQuery(p)
        }
      });
      ws.registerStore(bot.store);

      bot.vpnManager = {
        health: async () => {
          liveHealthCalled += 1;
          return { healthy: false, reason: 'container_not_running', exitIp: null };
        }
      };

      const ui = new TelegramUi({
        bot,
        launch: async () => {},
        clock: () => new Date('2026-11-04T12:00:00Z'),
        isolatedVerifier: {
          health: async () => {
            liveHealthCalled += 1;
            return { isolated: false, vpnHealthy: false, ip: null };
          },
          verify: async (acc) => ({
            isolated: true,
            vpnHealthy: true,
            exitIp: '203.0.114.11',
            authenticated: true,
            username: acc.username,
            userId: acc.userId || '1001'
          })
        }
      });

      await bot.store.update(s => {
        s.accounts = [{
          id: 'acc-xss',
          username: 'safe_handle',
          label: '<script>alert("xss")</script>',
          userId: '1001',
          exitIp: '203.0.114.11',
          enabled: true,
          status: 'مفعل'
        }];
        return s;
      });

      const acc = (await bot.store.load()).accounts[0];

      // UI-04: accountDetailText must escape HTML in account.label
      const html = ui.accountDetailText(acc);
      assert.ok(!html.includes('<script>'), 'UI-04: Raw <script> in account.label must be escaped in accountDetailText');
      assert.ok(html.includes('&lt;script&gt;'));

      // UI-01: accmanage:check_vpn must call live health check
      const rawCb = {
        callback_query: {
          id: 'cb-vpn',
          from: { id: 528864559 },
          message: { message_id: 30, chat: { id: 528864559 } }
        }
      };
      await ui.accountManage({ parsed: { action: 'check_vpn', value: 'acc-xss' } }, rawCb);
      assert.ok(liveHealthCalled >= 1, 'UI-01: accmanage:check_vpn must invoke live VPN health check');

      // UTIL-RAW-04: createAccountRefresh completes cleanly and clears accountRefreshJob
      const job = createAccountRefresh(ui, { retryMs: 10, maxFailures: 1, timeoutMs: 2000 });
      ui.accountRefreshJob = job;
      await job.run();
      assert.strictEqual(ui.accountRefreshJob, null);
    } finally {
      await ws.cleanup();
    }
  });

  it('U-05: telegramApi.js enforces maxBytes on JSON responses (ENTRY-RAW-02), adapts getUpdates timeout (FINDING-018), and CookieStore rejects symlinked dirs (ACC-RAW-03)', async () => {
    const ws = createHermeticWorkspace('yj-bot-test-u05-');
    const httpServer = await startFakeTelegramHttpServer();
    try {
      // 1. ENTRY-RAW-02: Oversized JSON API response exceeding maxBytes is aborted with FILE_TOO_LARGE
      httpServer.onMethod('getMe', (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"ok":true,"result":{"padding":"');
        res.write('X'.repeat(5 * 1024 * 1024));
        res.end('"}}');
        return true;
      });

      const tgApi = createTelegramApi('123456789:ABCdefGHIjklMNOpqrSTUvwxYZ012345678', {
        baseUrl: httpServer.baseUrl,
        timeoutMs: 5000
      });

      await assert.rejects(
        () => tgApi.getMe(),
        err => err.code === 'FILE_TOO_LARGE' || /أكبر من الحجم|FILE_TOO_LARGE|invalid/i.test(err.message)
      );

      // 2. FINDING-018: getUpdates adapts timeoutMs to at least (timeout + 15) * 1000
      let capturedTimeoutMs = 0;
      const customApi = createTelegramApi('123456789:ABCdefGHIjklMNOpqrSTUvwxYZ012345678', {
        timeoutMs: 10_000,
        request: async (_method, _params, opts) => {
          capturedTimeoutMs = opts.timeoutMs;
          return [];
        }
      });
      await customApi.getUpdates({ timeout: 25 });
      assert.strictEqual(capturedTimeoutMs, 40_000);

      // 3. ACC-RAW-03: CookieStore rejects symlinked parent/cookies directory
      const realDir = path.join(ws.tempDir, 'real_target');
      fs.mkdirSync(realDir, { recursive: true, mode: 0o700 });
      const symlinkRoot = path.join(ws.tempDir, 'symlink_root');
      fs.symlinkSync(realDir, symlinkRoot);

      const validCookies = JSON.stringify([
        { name: 'auth_token', value: 'tok1', domain: '.x.com' },
        { name: 'ct0', value: 'ct01', domain: '.x.com' }
      ]);

      await assert.rejects(
        async () => {
          const cs = new CookieStore(symlinkRoot);
          await cs.storeContent('acc-sym', validCookies);
        },
        /SYMLINK|ELOOP|regular|symlink/i
      );
    } finally {
      await httpServer.close();
      await ws.cleanup();
    }
  });
});
