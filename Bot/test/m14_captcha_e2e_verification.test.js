'use strict';
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SqliteStore } = require('../src/sqliteStore');
const { AccountManager, accountRecord } = require('../src/accounts');
const { DirectXAdapter } = require('../src/directX');
const { TelegramUi } = require('../src/telegramUi');

describe('M14: CAPTCHA State Machine & Human Verification E2E Tests', () => {
  let tempDir;
  let dbPath;
  let store;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm14-captcha-e2e-'));
    dbPath = path.join(tempDir, 'state.sqlite');
  });

  after(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    store = new SqliteStore(dbPath, {
      accounts: [],
      items: [],
      telegramUi: {}
    });
    await store.load();
  });

  it('1. accountRecord preserves all durable challenge fields across update and reload', async () => {
    const mgr = new AccountManager(store, { maxActiveAccounts: 5 });
    const initial = {
      id: 'acc_test_1',
      username: 'testuser',
      userId: '12345678',
      cookieFile: '/tmp/fake.json',
      enabled: false,
      status: 'كابتشا (مطلوب حل يدوي)',
      needsOwnerCaptcha: true,
      captchaDetectedAt: 1700000000000,
      captchaCode: 326,
      captchaReason: 'Arkose challenge required',
      captchaIncidentId: 'inc_test_123',
      lastCaptchaVerifyAt: 1700000010000,
      captchaResolvedAt: null,
      unverifiedReason: 'test_unverified'
    };

    const added = await mgr.add(initial);
    assert.strictEqual(added.needsOwnerCaptcha, true);
    assert.strictEqual(added.captchaCode, 326);
    assert.strictEqual(added.captchaIncidentId, 'inc_test_123');
    assert.strictEqual(added.enabled, false);

    // Perform an update (e.g. updating delayMs or label)
    const updated = await mgr.update('acc_test_1', { label: 'New Label', delayMs: 15 });
    assert.strictEqual(updated.label, 'New Label');
    // Durable challenge fields must NOT be silently dropped!
    assert.strictEqual(updated.needsOwnerCaptcha, true, 'needsOwnerCaptcha must be preserved across update');
    assert.strictEqual(updated.captchaCode, 326, 'captchaCode must be preserved');
    assert.strictEqual(updated.captchaIncidentId, 'inc_test_123', 'captchaIncidentId must be preserved');
    assert.strictEqual(updated.captchaDetectedAt, 1700000000000, 'captchaDetectedAt must be preserved');
    assert.strictEqual(updated.enabled, false, 'Account needing captcha must remain disabled');
  });

  it('2. recordAccountCheck does NOT clear needsOwnerCaptcha or change status during periodic refresh', async () => {
    const testAccount = {
      id: 'acc_captcha_1',
      username: 'user_captcha',
      enabled: false,
      status: 'كابتشا (مطلوب حل يدوي)',
      needsOwnerCaptcha: true,
      captchaIncidentId: 'inc_abc',
      cookieFile: '/tmp/fake.json'
    };

    await store.update(s => {
      s.accounts = [accountRecord(testAccount)];
      return s;
    });

    const ui = new TelegramUi({
      bot: { store, transport: { sendMessage: async () => {} } }
    });

    // Simulate periodic refresh observation that returns authenticated: true
    await ui.recordAccountCheck('acc_captcha_1', {
      isolated: true,
      vpnHealthy: true,
      exitIp: '187.1.2.3',
      authenticated: true,
      username: 'user_captcha'
    }, {
      refresh: true,
      session: true,
      healthy: true,
      ip: '187.1.2.3'
    });

    const afterRefresh = await store.load();
    const acc = afterRefresh.accounts.find(a => a.id === 'acc_captcha_1');
    assert.strictEqual(acc.needsOwnerCaptcha, true, 'needsOwnerCaptcha must NOT be cleared by periodic refresh');
    assert.strictEqual(acc.status, 'كابتشا (مطلوب حل يدوي)', 'status must remain captcha');
    assert.strictEqual(acc.enabled, false, 'enabled must remain false');
  });

  it('3. DirectXAdapter.prototype.verifyAccount performs read-only identity verification safely', async () => {
    const adapter = new DirectXAdapter({ allowPublish: false });

    // Mock open and close on adapter
    adapter.open = async ({ account }) => {
      return {
        state: 'authenticated',
        identity: {
          authenticated: true,
          username: account.username,
          userId: account.userId || '987654321',
          challenge: false,
          locked: false,
          captcha: false,
          suspended: false,
          banned: false,
          accountFailure: null
        }
      };
    };
    adapter.close = async () => {};

    const res = await adapter.verifyAccount({
      account: { id: 'acc_v', username: 'valid_user', userId: '987654321', proxy: 'socks5h://127.0.0.1:18801', cookieFile: '/tmp/f.json' }
    });

    assert.strictEqual(res.verified, true);
    assert.strictEqual(res.authenticated, true);
    assert.strictEqual(res.username, 'valid_user');
    assert.strictEqual(res.userId, '987654321');
    assert.strictEqual(res.challenge, false);
    assert.strictEqual(res.captcha, false);
    assert.strictEqual(res.suspended, false);
  });

  it('4. DirectXAdapter.prototype.verifyAccount detects username/userId mismatch fail-closed', async () => {
    const adapter = new DirectXAdapter({ allowPublish: false });

    adapter.open = async () => ({
      state: 'authenticated',
      identity: {
        authenticated: true,
        username: 'different_user',
        userId: '11111111',
        challenge: false
      }
    });
    adapter.close = async () => {};

    const res = await adapter.verifyAccount({
      account: { id: 'acc_mismatch', username: 'expected_user', userId: '987654321', proxy: 'socks5h://127.0.0.1:18801', cookieFile: '/tmp/f.json' }
    });

    assert.strictEqual(res.verified, false);
    assert.strictEqual(res.reason, 'identity_mismatch');
  });

  it('5. accmanage:verify_captcha atomic rate-limiting CAS prevents simultaneous tap bypass', async () => {
    const testAccount = {
      id: 'acc_rl',
      username: 'rate_limited_user',
      enabled: false,
      status: 'كابتشا',
      needsOwnerCaptcha: true,
      cookieFile: '/tmp/fake.json'
    };

    await store.update(s => {
      s.accounts = [accountRecord(testAccount)];
      return s;
    });

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
          authenticated: false,
          challenge: true,
          accountFailure: 'challenge_still_active'
        })
      }
    });

    const rawPayload = {
      callback_query: {
        id: 'cb1',
        from: { id: 123 },
        message: { chat: { id: 123 }, message_id: 10 }
      }
    };

    // First tap
    const r1 = await ui.accountManage({ parsed: { action: 'verify_captcha', value: 'acc_rl' } }, rawPayload);
    assert.strictEqual(r1.rateLimited, undefined, 'First tap proceeds to verification');

    // Immediate second tap (within 30s)
    let ackText = '';
    const r2 = await ui.accountManage(
      {
        parsed: { action: 'verify_captcha', value: 'acc_rl' },
        acknowledge: async (text) => { ackText = text; }
      },
      rawPayload
    );

    assert.strictEqual(r2.rateLimited, true, 'Second tap must be rate limited');
    assert.ok(ackText.includes('يرجى الانتظار'), 'Acknowledge must display wait message');
  });

  it('6. accmanage:verify_captcha transitions account to غير مفعل on pass without auto-enabling', async () => {
    const testAccount = {
      id: 'acc_pass',
      username: 'cleared_user',
      userId: '55555',
      enabled: false,
      status: 'كابتشا',
      needsOwnerCaptcha: true,
      captchaIncidentId: 'inc_pass_1',
      cookieFile: '/tmp/fake.json'
    };

    await store.update(s => {
      s.accounts = [accountRecord(testAccount)];
      return s;
    });

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
        verify: async (acc) => ({
          authenticated: true,
          username: 'cleared_user',
          userId: '55555',
          challenge: false,
          locked: false,
          captcha: false,
          suspended: false,
          accountFailure: null
        })
      }
    });

    const rawPayload = {
      callback_query: {
        id: 'cb2',
        from: { id: 123 },
        message: { chat: { id: 123 }, message_id: 10 }
      }
    };

    const res = await ui.accountManage(
      { parsed: { action: 'verify_captcha', value: 'acc_pass' } },
      rawPayload
    );

    assert.strictEqual(res.verified, true);
    assert.strictEqual(res.status, 'غير مفعل');

    const state = await store.load();
    const acc = state.accounts.find(a => a.id === 'acc_pass');
    assert.strictEqual(acc.status, 'غير مفعل', 'Status must be set to غیر مفعل');
    assert.strictEqual(acc.enabled, false, 'Account must remain disabled until owner explicitly toggles enable');
    assert.strictEqual(acc.needsOwnerCaptcha, false, 'needsOwnerCaptcha must be cleared');
    assert.strictEqual(acc.captchaIncidentId, undefined, 'captchaIncidentId must be cleared');
  });

  it('7. sendIsolationAlert deduplicates alert once per incident with incident reset', async () => {
    const notifications = [];
    const ui = new TelegramUi({
      bot: { store, transport: {} },
      autoStartTicker: false,
      notify: async msg => {
        notifications.push(msg);
        return { ok: true, message_id: 100 + notifications.length };
      }
    });

    const acc = {
      id: 'acc_inc_test',
      username: 'incident_user',
      status: 'كابتشا',
      needsOwnerCaptcha: true,
      captchaIncidentId: 'incident_001'
    };

    // 1st alert for incident_001
    const msg1 = await ui.sendIsolationAlert({ account: acc, reason: 'captcha', otherActiveCount: 1 });
    assert.ok(msg1, 'First alert must be emitted');
    assert.strictEqual(notifications.length, 1);

    // 2nd alert for SAME incident_001
    const msg2 = await ui.sendIsolationAlert({ account: acc, reason: 'captcha', otherActiveCount: 1 });
    assert.strictEqual(msg2, null, 'Duplicate alert for same incident must be suppressed');
    assert.strictEqual(notifications.length, 1, 'No second notification sent');

    // Incident cleared, then a NEW incident occurs with incident_002
    acc.captchaIncidentId = 'incident_002';
    const msg3 = await ui.sendIsolationAlert({ account: acc, reason: 'captcha', otherActiveCount: 1 });
    assert.ok(msg3, 'New incident must emit an alert');
    assert.strictEqual(notifications.length, 2, 'Second distinct incident is notified');
  });
});
