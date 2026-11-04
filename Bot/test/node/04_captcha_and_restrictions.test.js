'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createHermeticWorkspace } = require('../fixtures/hermetic_workspace');
const { FakeTelegramApi } = require('../fixtures/fake_telegram_server');
const { SqliteStore } = require('../../src/sqliteStore');
const { AccountManager } = require('../../src/accounts');
const { TelegramUi } = require('../../src/telegramUi');
const { createBot } = require('../../src/index');

function createTestBotAndUi(ws, api, { isolatedVerifier, notify } = {}) {
  const bot = createBot({
    dataDir: ws.tempDir,
    auth: {
      allowedUserIds: ['528864559', '5535435580'],
      allowedChatIds: ['528864559', '5535435580']
    },
    telegram: {
      send: payload => api.sendMessage(payload),
      sendRichMessage: payload => api.sendRichMessage(payload),
      editMessageText: payload => api.editMessageText(payload),
      deleteMessage: payload => api.deleteMessage(payload),
      answerCallback: payload => api.answerCallbackQuery(payload)
    }
  });
  ws.registerStore(bot.store);

  const defaultNotify = async (text, { targetChatIds } = {}) => {
    const targets = Array.isArray(targetChatIds) && targetChatIds.length > 0
      ? targetChatIds
      : ['528864559', '5535435580'];
    return Promise.allSettled(targets.map(async chat_id => {
      const res = await api.sendMessage({ chat_id, text });
      return {
        chat_id: String(chat_id),
        ok: Number.isInteger(res?.message_id) && res.message_id > 0,
        message_id: res?.message_id,
        raw: res
      };
    }));
  };

  const ui = new TelegramUi({
    bot,
    launch: async () => {},
    clock: () => new Date('2026-11-04T12:00:00Z'),
    isolatedVerifier: isolatedVerifier || {
      verify: async (acc) => ({
        isolated: true,
        vpnHealthy: true,
        exitIp: '203.0.114.11',
        authenticated: true,
        username: acc.username,
        userId: acc.userId || '1001'
      }),
      health: async () => ({ isolated: true, vpnHealthy: true, ip: '203.0.114.11' })
    },
    notify: notify || defaultNotify
  });

  return { bot, ui };
}

describe('04_captcha_and_restrictions: CAPTCHA Manual-Only Gate, TR-04/06 Race, UI-02/03, ACC-RAW-01, XT-03, RUN-03 & Dual-Chat Receipts', () => {
  it('C-01: Codes 326/353/399/241 isolate with needsOwnerCaptcha, XT-03 applies restrictions despite checkGeneration drift, and RUN-03 ignores transient verify errors', async () => {
    const ws = createHermeticWorkspace('yj-bot-test-c01-');
    try {
      const api = new FakeTelegramApi();
      const { bot, ui } = createTestBotAndUi(ws, api);
      const c1 = ws.writeSyntheticCookie('acc-1', { userId: '1001' });

      await bot.store.update(s => {
        s.accounts = [{
          id: 'acc-1',
          username: 'user1',
          userId: '1001',
          cookieFile: c1,
          enabled: true,
          status: 'مفعل',
          checkGeneration: 'gen-initial'
        }];
        return s;
      });

      // XT-03: Pass stale expectedAccount checkGeneration, but report critical accountFailure: 'captcha'
      const staleSnapshot = {
        id: 'acc-1',
        username: 'user1',
        userId: '1001',
        cookieFile: c1,
        enabled: true,
        checkGeneration: 'gen-stale-mismatch'
      };
      await ui.recordAccountCheck(
        'acc-1',
        { isolated: true, vpnHealthy: true, exitIp: '203.0.114.11', authenticated: false, accountFailure: 'captcha', captcha: true },
        { session: true, source: 'x-session', expectedAccount: staleSnapshot }
      );

      let st = await bot.store.load();
      let acc = st.accounts.find(a => a.id === 'acc-1');
      assert.strictEqual(acc.enabled, false, 'XT-03: Critical captcha restriction must isolate account even if checkGeneration drifted');
      assert.strictEqual(acc.needsOwnerCaptcha, true);
      assert.ok(acc.captchaIncidentId);
      const firstIncidentId = acc.captchaIncidentId;

      // Subsequent auth_session_unverified check must NEVER clear needsOwnerCaptcha or overwrite captchaIncidentId
      await ui.recordAccountCheck(
        'acc-1',
        { isolated: true, vpnHealthy: true, exitIp: '203.0.114.11', authenticated: false, accountFailure: 'auth_session_unverified' },
        { session: true, source: 'x-session', expectedAccount: acc }
      );
      st = await bot.store.load();
      acc = st.accounts.find(a => a.id === 'acc-1');
      assert.strictEqual(acc.needsOwnerCaptcha, true);
      assert.strictEqual(acc.captchaIncidentId, firstIncidentId);

      // RUN-03: Transient network/VPN error must NOT disable a healthy active account as unverified
      await bot.store.update(s => {
        s.accounts.push({
          id: 'acc-healthy',
          username: 'healthy_u',
          userId: '1002',
          cookieFile: c1,
          enabled: true,
          status: 'مفعل',
          checkGeneration: 'gen-h1'
        });
        return s;
      });
      const healthyAcc = (await bot.store.load()).accounts.find(a => a.id === 'acc-healthy');
      await ui.recordAccountCheck(
        'acc-healthy',
        { isolated: false, vpnHealthy: false, transientError: true, reason: 'VPN_TRANSIENT_UNAVAILABLE' },
        { session: false, source: 'vpn-health', expectedAccount: healthyAcc }
      );
      const afterTransient = (await bot.store.load()).accounts.find(a => a.id === 'acc-healthy');
      assert.strictEqual(afterTransient.enabled, true, 'RUN-03: Healthy account must stay enabled on transient VPN error');
      assert.strictEqual(afterTransient.status, 'مفعل');
    } finally {
      await ws.cleanup();
    }
  });

  it('C-02: UI-02/UI-03 disable preserves CAPTCHA status & verify_captcha clears needsOwnerCaptcha with CAS incident guard', async () => {
    const ws = createHermeticWorkspace('yj-bot-test-c02-');
    try {
      const api = new FakeTelegramApi();
      let verifyCalls = 0;
      let injectConcurrentIncident = false;

      const { bot, ui } = createTestBotAndUi(ws, api, {
        isolatedVerifier: {
          verify: async (acc) => {
            verifyCalls += 1;
            if (injectConcurrentIncident) {
              await bot.store.update(s => {
                const target = s.accounts.find(a => a.id === acc.id);
                target.captchaIncidentId = 'incident-new-b';
                target.checkGeneration = 'gen-new-b';
                return s;
              });
            }
            return {
              isolated: true,
              vpnHealthy: true,
              exitIp: '203.0.114.11',
              authenticated: true,
              username: acc.username,
              userId: acc.userId
            };
          }
        }
      });

      const c1 = ws.writeSyntheticCookie('acc-cap', { userId: '1001' });
      await bot.store.update(s => {
        s.accounts = [{
          id: 'acc-cap',
          username: 'cap_user',
          userId: '1001',
          cookieFile: c1,
          enabled: false,
          needsOwnerCaptcha: true,
          status: 'كابتشا (مطلوب حل يدوي)',
          captchaIncidentId: 'incident-a',
          checkGeneration: 'gen-a'
        }];
        return s;
      });

      const rawCb = {
        callback_query: {
          id: 'cb-1',
          from: { id: 528864559 },
          message: { message_id: 10, chat: { id: 528864559 } }
        }
      };

      // UI-02: Calling accmanage:disable or acctoggle:all_disable on CAPTCHA account MUST preserve CAPTCHA status
      await ui.accountManage({ parsed: { action: 'disable', value: 'acc-cap' } }, rawCb);
      await ui.accountToggle({ parsed: { action: 'all_disable', value: 'all' } }, rawCb);

      let acc = (await bot.store.load()).accounts.find(a => a.id === 'acc-cap');
      assert.strictEqual(acc.needsOwnerCaptcha, true);
      assert.ok(String(acc.status).includes('كابتشا'), `Expected CAPTCHA status preserved after disable, got ${acc.status}`);

      // UI-03: accountDetailText must show CAPTCHA indicator for 'كابتشا (مطلوب حل يدوي)'
      const detailText = ui.accountDetailText(acc);
      assert.ok(detailText.includes('كابتشا') || detailText.includes('CAPTCHA'));

      // Concurrent incident B preempting in-flight verify_captcha A must abort clearing
      injectConcurrentIncident = true;
      const staleRes = await ui.accountManage({ parsed: { action: 'verify_captcha', value: 'acc-cap' } }, rawCb);
      assert.strictEqual(staleRes.verified, false);
      assert.strictEqual(staleRes.stale, true);

      // Rate-limit CAS blocks immediate second tap within 30s
      const rateLimitedRes = await ui.accountManage({ parsed: { action: 'verify_captcha', value: 'acc-cap' } }, rawCb);
      assert.strictEqual(rateLimitedRes.rateLimited, true);

      // Advance lastCaptchaVerifyAt past 30s window and verify clean resolution
      injectConcurrentIncident = false;
      await bot.store.update(s => {
        s.accounts[0].lastCaptchaVerifyAt = Date.now() - 35_000;
        return s;
      });

      const okRes = await ui.accountManage({ parsed: { action: 'verify_captcha', value: 'acc-cap' } }, rawCb);
      assert.strictEqual(okRes.verified, true);

      acc = (await bot.store.load()).accounts.find(a => a.id === 'acc-cap');
      assert.strictEqual(acc.needsOwnerCaptcha, false);
      assert.strictEqual(acc.enabled, false, 'Account must stay disabled after verify_captcha until explicit owner enable');
    } finally {
      await ws.cleanup();
    }
  });

  it('C-03: TR-06 & TR-04 concurrent CAPTCHA isolation or 5th active account race inside store.update rejects enabling account', async () => {
    const ws = createHermeticWorkspace('yj-bot-test-c03-');
    try {
      const api = new FakeTelegramApi();
      const { bot, ui } = createTestBotAndUi(ws, api);
      const c1 = ws.writeSyntheticCookie('acc-race', { userId: '1001' });

      await bot.store.update(s => {
        s.accounts = [{
          id: 'acc-race',
          username: 'race_user',
          userId: '1001',
          cookieFile: c1,
          enabled: false,
          needsOwnerCaptcha: false,
          status: 'غير مفعل',
          checkGeneration: 'gen-1'
        }];
        return s;
      });

      // Intercept store.load() so that right AFTER accountToggle reads the initial 'غير مفعل' state,
      // a runner CAPTCHA isolation commits into SQLite BEFORE accountToggle's store.update() runs!
      const origLoad = bot.store.load.bind(bot.store);
      let raceInjected = false;
      bot.store.load = async function (...args) {
        const snap = await origLoad(...args);
        if (!raceInjected) {
          raceInjected = true;
          await bot.store.update(s => {
            const a = s.accounts.find(x => x.id === 'acc-race');
            a.enabled = false;
            a.needsOwnerCaptcha = true;
            a.status = 'كابتشا (مطلوب حل يدوي)';
            a.captchaIncidentId = 'inc-race-1';
            return s;
          });
        }
        return snap;
      };

      const rawCb = {
        callback_query: {
          id: 'cb-race',
          from: { id: 528864559 },
          message: { message_id: 11, chat: { id: 528864559 } }
        }
      };

      await ui.accountToggle({ parsed: { action: 'toggle', value: 'acc-race' } }, rawCb);
      bot.store.load = origLoad;

      const afterRace = (await bot.store.load()).accounts.find(a => a.id === 'acc-race');
      assert.strictEqual(afterRace.enabled, false, 'TR-06: In-transaction guard must block enabling an account isolated by CAPTCHA after load()');
      assert.strictEqual(afterRace.needsOwnerCaptcha, true);
      assert.ok(String(afterRace.status).includes('كابتشا'));
    } finally {
      await ws.cleanup();
    }
  });

  it('C-04: ACC-RAW-01 replaceFromCsv preserves needsOwnerCaptcha, captchaIncidentId, and banned status for matching accounts', async () => {
    const ws = createHermeticWorkspace('yj-bot-test-c04-');
    try {
      const store = ws.registerStore(new SqliteStore(ws.dbPath));
      const mgr = new AccountManager(store);

      await store.update(s => {
        s.accounts = [
          {
            id: 'acc-1',
            username: 'challenged_user',
            userId: '1001',
            enabled: false,
            needsOwnerCaptcha: true,
            status: 'كابتشا (مطلوب حل يدوي)',
            captchaIncidentId: 'inc-preserve-1'
          },
          {
            id: 'acc-2',
            username: 'banned_user',
            userId: '1002',
            enabled: false,
            status: 'محظور'
          }
        ];
        return s;
      });

      const csvInput = [
        'account,username,enabled',
        'acc-1,challenged_user,true',
        'acc-new-id,banned_user,true',
        'acc-3,clean_user,true'
      ].join('\n');

      const replaced = await mgr.replaceFromCsv(csvInput);
      const r1 = replaced.find(a => a.id === 'acc-1');
      const r2 = replaced.find(a => a.username === 'banned_user');
      const r3 = replaced.find(a => a.id === 'acc-3');

      assert.strictEqual(r1.enabled, false, 'ACC-RAW-01: Challenged account must remain disabled after CSV import');
      assert.strictEqual(r1.needsOwnerCaptcha, true, 'ACC-RAW-01: needsOwnerCaptcha must be preserved across CSV import');
      assert.strictEqual(r1.captchaIncidentId, 'inc-preserve-1');

      assert.strictEqual(r2.enabled, false, 'ACC-RAW-01: Banned account matched by username must remain disabled after CSV import');
      assert.strictEqual(r2.status, 'محظور');

      assert.strictEqual(r3.enabled, true, 'Unrestricted new account in CSV should be enabled');
    } finally {
      await ws.cleanup();
    }
  });

  it('C-05: Dual-chat isolation alerts require integer message_id receipts (TR-03), retry only failed chat on partial failure, and alert fresh on new incident', async () => {
    const ws = createHermeticWorkspace('yj-bot-test-c05-');
    try {
      const api = new FakeTelegramApi();
      // Chat 2 (5535435580) fails on attempt 1 with malformed response lacking message_id, then succeeds on attempt 2
      let chat2Attempts = 0;
      api.setChatFault('5535435580', (method) => {
        if (method === 'sendMessage') {
          chat2Attempts += 1;
          if (chat2Attempts === 1) {
            return { ok: true, result: {} }; // Missing integer message_id!
          }
        }
        return null;
      });

      const { bot, ui } = createTestBotAndUi(ws, api);
      await bot.store.update(s => {
        s.accounts = [{
          id: 'acc-alert',
          username: 'alert_user',
          enabled: false,
          needsOwnerCaptcha: true,
          status: 'كابتشا (مطلوب حل يدوي)',
          captchaIncidentId: 'inc-dual-1',
          captchaDeliveredIncidentId: 'inc-dual-1',
          captchaDeliveredChats: []
        }];
        return s;
      });

      const accSnap = (await bot.store.load()).accounts[0];

      // Attempt 1: Chat 528864559 succeeds, Chat 5535435580 returns missing message_id
      await ui.sendIsolationAlert({ account: accSnap, reason: 'captcha' });
      let st = await bot.store.load();
      assert.deepStrictEqual(st.accounts[0].captchaDeliveredChats, ['528864559']);
      assert.strictEqual(st.accounts[0].lastNotifiedCaptchaIncidentId, undefined, 'Incident must not be marked fully notified when Chat 2 lacked message_id');

      // Attempt 2: Retry sends ONLY to Chat 5535435580 (0 duplicate sends to 528864559)
      const chat1CountBefore = api.messages.filter(m => m.chat_id === '528864559').length;
      await ui.sendIsolationAlert({ account: st.accounts[0], reason: 'captcha' });
      const chat1CountAfter = api.messages.filter(m => m.chat_id === '528864559').length;
      assert.strictEqual(chat1CountAfter, chat1CountBefore, 'Chat 1 must not receive duplicate alert on partial retry');

      st = await bot.store.load();
      assert.deepStrictEqual(new Set(st.accounts[0].captchaDeliveredChats), new Set(['528864559', '5535435580']));
      assert.strictEqual(st.accounts[0].lastNotifiedCaptchaIncidentId, 'inc-dual-1');

      // New distinct incident (inc-dual-2) alerts both chats fresh
      await bot.store.update(s => {
        s.accounts[0].captchaIncidentId = 'inc-dual-2';
        s.accounts[0].captchaDeliveredIncidentId = 'inc-dual-2';
        s.accounts[0].captchaDeliveredChats = [];
        delete s.accounts[0].lastNotifiedCaptchaIncidentId;
        return s;
      });
      await ui.sendIsolationAlert({ account: (await bot.store.load()).accounts[0], reason: 'captcha' });
      st = await bot.store.load();
      assert.strictEqual(st.accounts[0].lastNotifiedCaptchaIncidentId, 'inc-dual-2');
    } finally {
      await ws.cleanup();
    }
  });
});
