'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { SqliteStore } = require('../src/sqliteStore');
const { run } = require('../src/runner');

function createMockApi(notifications = []) {
  return {
    getMe: async () => ({ id: 1, username: 'TestBot' }),
    sendMessage: async (arg1, arg2) => {
      const text = typeof arg1 === 'object' && arg1 ? arg1.text : arg2;
      if (text) notifications.push(text);
      return { message_id: notifications.length };
    },
    sendRichMessage: async (arg1, arg2) => {
      const text = typeof arg1 === 'object' && arg1 ? arg1.text : arg2;
      if (text) notifications.push(text);
      return { message_id: notifications.length };
    },
    editMessageText: async () => ({ message_id: 1 }),
    deleteMessage: async () => {},
    getUpdates: async () => [],
    sendDocument: async () => ({ message_id: 99999, ok: true })
  };
}

function createMockVpn(slotIp = '10.200.0.10') {
  return {
    ensure: async (accountId) => ({ slot: 0, port: 18801, exitIp: slotIp, proxy: 'socks5h://127.0.0.1:18801' }),
    health: async () => ({ healthy: true, exitIp: slotIp }),
    rotate: async () => {}
  };
}

describe('Challenger R4-M1-2: Empirical Verification of PR #11 Alert & Forensic Fencing', () => {

  // =========================================================================
  // Task 1 & Task 2: Single Ambiguous Outcome (Adapter return path)
  // =========================================================================
  test('Task 1 & 2: Single ambiguous return suppresses per-item Telegram alerts and preserves forensicLogger event', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'challenger-ambig-return-'));
    const dbPath = path.join(tempDir, 'state.sqlite');
    const cookiePath = path.join(tempDir, 'cookie_1.json');
    fs.writeFileSync(cookiePath, '{}');

    const notifications = [];
    const mockApi = createMockApi(notifications);

    const store = new SqliteStore(dbPath, {
      items: [
        { id: 'item-ambig-ret-001', state: 'pending', payload: { text: 'Challenger test post 1' } }
      ],
      accounts: [
        { id: 'acc-challenger-1', username: 'challenger_user', userId: '5001', enabled: true, cookieFile: cookiePath, failures: 0 }
      ],
      cycle: { state: 'stopped', runId: null },
      settings: { dailyQuota: 10, delayMinSeconds: 1, delayMaxSeconds: 1 },
      posting: {},
      forensicLogs: []
    });
    await store.load();

    const publishAdapterFactory = () => ({
      supportsDispatchCallback: true,
      open: async ({ account }) => ({
        slot: 0,
        port: 18801,
        exitIp: '10.200.0.42',
        identity: { authenticated: true, username: account.username, userId: account.userId }
      }),
      publish: async ({ onDispatch }) => {
        // Crossed irreversible boundary
        await onDispatch({ accountId: 'acc-challenger-1' });
        return { published: false, ambiguous: true, reason: 'publish_confirmation_missing' };
      },
      close: async () => {}
    });

    await run({
      token: 'test_token', userId: '100', chatId: '200', allowedUserIds: ['100'], allowedChatIds: ['200'],
      dataDir: tempDir, api: mockApi, vpnManager: createMockVpn('10.200.0.42'),
      maxPolls: 0, publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
      logger: { log: () => {}, error: () => {} },
      onRuntimeReady: async (ctx) => {
        await ctx.start({ stopAfterSuccess: false });
        await ctx.wait();
      }
    });

    const finalState = await store.load();

    // 1. Task 1 Verification: Zero Telegram alerts emitted for single ambiguous outcome
    const itemAlerts = notifications.filter(n => !n.includes('لا توجد روابط منشورات مؤكدة'));
    assert.strictEqual(itemAlerts.length, 0, `Expected 0 Telegram notifications, got ${itemAlerts.length}: ${JSON.stringify(itemAlerts)}`);

    // 2. Item state verification in SQLite
    const item = finalState.items.find(x => x.id === 'item-ambig-ret-001');
    assert.ok(item, 'Item must exist in state');
    assert.strictEqual(item.state, 'ambiguous', 'Item must be transitioned to ambiguous');
    assert.strictEqual(item.accountId, 'acc-challenger-1', 'Item must retain accountId attribution');
    assert.strictEqual(item.accountUsername, 'challenger_user', 'Item must retain accountUsername attribution');
    assert.strictEqual(item.reason, 'publish_confirmation_missing', 'Item must retain exact failure reason');

    // 3. Strike accounting verification
    const account = finalState.accounts.find(a => a.id === 'acc-challenger-1');
    assert.strictEqual(account.failures, 1, 'Account failure strike must increment from 0 to 1');
    assert.strictEqual(account.enabled, true, 'Account must remain enabled after 1 strike');

    // 4. Quota preservation verification
    const quotaMap = finalState.posting?.quota || {};
    let totalDeductions = 0;
    for (const day of Object.keys(quotaMap)) {
      totalDeductions += (quotaMap[day]?.['acc-challenger-1'] || 0);
    }
    assert.strictEqual(totalDeductions, 0, 'Quota must NOT be deducted for ambiguous outcome');

    // 5. Task 2 Verification: Forensic logger received and stored post_ambiguous event
    const forensicLogs = finalState.forensicLogs || [];
    const ambiguousEvents = forensicLogs.filter(e => e.eventType === 'post_ambiguous');
    assert.strictEqual(ambiguousEvents.length, 1, 'Forensic logger must record exactly one post_ambiguous event');

    const ev = ambiguousEvents[0];
    assert.strictEqual(ev.accountId, 'acc-challenger-1', 'Forensic event must include accountId');
    assert.strictEqual(ev.username, 'challenger_user', 'Forensic event must include username');
    assert.strictEqual(ev.details?.itemId, 'item-ambig-ret-001', 'Forensic event details must include itemId');
    assert.strictEqual(ev.details?.reason, 'publish_confirmation_missing', 'Forensic event details must include reason');
    assert.strictEqual(ev.xErrorMessage, 'publish_confirmation_missing', 'Forensic event must include xErrorMessage');
    assert.strictEqual(ev.exitIp, '10.200.0.42', 'Forensic event must include exitIp');

    // Also verify JSONL log file
    const jsonlPath = path.join(tempDir, 'logs', 'forensic.jsonl');
    assert.ok(fs.existsSync(jsonlPath), 'Forensic JSONL log file must exist on disk');
    const jsonlContent = fs.readFileSync(jsonlPath, 'utf8');
    assert.ok(jsonlContent.includes('"eventType":"post_ambiguous"'), 'JSONL must contain post_ambiguous entry');
    assert.ok(jsonlContent.includes('item-ambig-ret-001'), 'JSONL must contain itemId');
  });

  // =========================================================================
  // Task 1 & Task 2: Post-dispatch Exception (Account-specific error)
  // =========================================================================
  test('Task 1 & 2: Post-dispatch non-transport error suppresses Telegram alert, preserves forensicLogger event, and increments strike', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'challenger-ambig-ex-'));
    const dbPath = path.join(tempDir, 'state.sqlite');
    const cookiePath = path.join(tempDir, 'cookie_ex.json');
    fs.writeFileSync(cookiePath, '{}');

    const notifications = [];
    const mockApi = createMockApi(notifications);

    const store = new SqliteStore(dbPath, {
      items: [
        { id: 'item-post-dispatch-crash', state: 'pending', payload: { text: 'Post-dispatch crash test' } }
      ],
      accounts: [
        { id: 'acc-crash-test', username: 'crash_user', userId: '5002', enabled: true, cookieFile: cookiePath, failures: 0 }
      ],
      cycle: { state: 'stopped', runId: null },
      settings: { dailyQuota: 10, delayMinSeconds: 1, delayMaxSeconds: 1 },
      posting: {},
      forensicLogs: []
    });
    await store.load();

    const publishAdapterFactory = () => ({
      supportsDispatchCallback: true,
      open: async ({ account }) => ({
        slot: 1,
        port: 18802,
        exitIp: '10.200.0.99',
        identity: { authenticated: true, username: account.username, userId: account.userId }
      }),
      publish: async ({ onDispatch }) => {
        // Cross irreversible dispatch boundary
        await onDispatch({ accountId: 'acc-crash-test' });
        // Simulating author/status verification error after dispatch
        const err = new Error('unverified_author_or_missing_tweet_id');
        err.xErrorCode = 187;
        throw err;
      },
      close: async () => {}
    });

    await run({
      token: 'test_token', userId: '100', chatId: '200', allowedUserIds: ['100'], allowedChatIds: ['200'],
      dataDir: tempDir, api: mockApi, vpnManager: createMockVpn('10.200.0.99'),
      maxPolls: 0, publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
      logger: { log: () => {}, error: () => {} },
      onRuntimeReady: async (ctx) => {
        await ctx.start({ stopAfterSuccess: false });
        await ctx.wait();
      }
    });

    const finalState = await store.load();

    // 1. Task 1 Verification: Zero Telegram alerts
    const alerts = notifications.filter(n => !n.includes('لا توجد روابط منشورات مؤكدة'));
    assert.strictEqual(alerts.length, 0, `Expected 0 Telegram alerts on post-dispatch exception, got: ${JSON.stringify(alerts)}`);

    // 2. Item quarantined as ambiguous with full attribution
    const item = finalState.items.find(x => x.id === 'item-post-dispatch-crash');
    assert.strictEqual(item.state, 'ambiguous', 'Item must be transitioned to ambiguous');
    assert.strictEqual(item.accountId, 'acc-crash-test', 'Item must retain accountId');
    assert.strictEqual(item.accountUsername, 'crash_user', 'Item must retain accountUsername');

    // 3. Account failures incremented
    const account = finalState.accounts.find(a => a.id === 'acc-crash-test');
    assert.strictEqual(account.failures, 1, 'Account strike must increment to 1');
    assert.strictEqual(account.enabled, true, 'Account must remain enabled');

    // 4. Task 2 Verification: Forensic logger records post_ambiguous with error code & message
    const forensicLogs = finalState.forensicLogs || [];
    const ambiguousEvents = forensicLogs.filter(e => e.eventType === 'post_ambiguous');
    assert.strictEqual(ambiguousEvents.length, 1, 'Forensic logger must record exactly one post_ambiguous event');

    const ev = ambiguousEvents[0];
    assert.strictEqual(ev.accountId, 'acc-crash-test');
    assert.strictEqual(ev.username, 'crash_user');
    assert.strictEqual(ev.details?.itemId, 'item-post-dispatch-crash');
    assert.strictEqual(ev.details?.reason, 'exception_after_dispatch');
    assert.strictEqual(ev.xErrorCode, 187);
    assert.strictEqual(ev.xErrorMessage, 'unverified_author_or_missing_tweet_id');
  });

  // =========================================================================
  // Transport Post-Dispatch: Network error isolates item but spares account strike
  // =========================================================================
  test('Transport error after dispatch isolates item as ambiguous but does not increment account failure strike', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'challenger-ambig-net-'));
    const dbPath = path.join(tempDir, 'state.sqlite');
    const cookiePath = path.join(tempDir, 'cookie_net.json');
    fs.writeFileSync(cookiePath, '{}');

    const notifications = [];
    const mockApi = createMockApi(notifications);

    const store = new SqliteStore(dbPath, {
      items: [
        { id: 'item-net-crash', state: 'pending', payload: { text: 'Network crash test' } }
      ],
      accounts: [
        { id: 'acc-net-test', username: 'net_user', userId: '5005', enabled: true, cookieFile: cookiePath, failures: 0 }
      ],
      cycle: { state: 'stopped', runId: null },
      settings: { dailyQuota: 10, delayMinSeconds: 1, delayMaxSeconds: 1 },
      posting: {},
      forensicLogs: []
    });
    await store.load();

    const publishAdapterFactory = () => ({
      supportsDispatchCallback: true,
      open: async ({ account }) => ({
        slot: 1,
        port: 18802,
        exitIp: '10.200.0.70',
        identity: { authenticated: true, username: account.username, userId: account.userId }
      }),
      publish: async ({ onDispatch }) => {
        await onDispatch({ accountId: 'acc-net-test' });
        const netErr = new Error('read ECONNRESET');
        netErr.code = 'ECONNRESET';
        throw netErr;
      },
      close: async () => {}
    });

    await run({
      token: 'test_token', userId: '100', chatId: '200', allowedUserIds: ['100'], allowedChatIds: ['200'],
      dataDir: tempDir, api: mockApi, vpnManager: createMockVpn('10.200.0.70'),
      maxPolls: 0, publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
      logger: { log: () => {}, error: () => {} },
      onRuntimeReady: async (ctx) => {
        await ctx.start({ stopAfterSuccess: false });
        await ctx.wait();
      }
    });

    const finalState = await store.load();

    // Zero Telegram alerts
    const alerts = notifications.filter(n => !n.includes('لا توجد روابط منشورات مؤكدة'));
    assert.strictEqual(alerts.length, 0);

    // Item quarantined as ambiguous because dispatch was crossed
    const item = finalState.items.find(x => x.id === 'item-net-crash');
    assert.strictEqual(item.state, 'ambiguous');

    // Account failure strike is NOT incremented (R3 network error exclusion)
    const account = finalState.accounts.find(a => a.id === 'acc-net-test');
    assert.strictEqual(account.failures, 0, 'Transport/proxy error must NOT increment account failure strike');
    assert.strictEqual(account.enabled, true);

    // Forensic event recorded
    const forensicLogs = finalState.forensicLogs || [];
    assert.strictEqual(forensicLogs.filter(e => e.eventType === 'post_ambiguous').length, 1);
  });

  // =========================================================================
  // Task 3: 3rd Consecutive Strike Isolation Alert (Virtual Clock Pacing)
  // =========================================================================
  test('Task 3: Exactly ONE isolation alert emitted on 3rd consecutive strike, zero alerts on strikes 1 and 2', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'challenger-3strikes-'));
    const dbPath = path.join(tempDir, 'state.sqlite');
    const cookiePath = path.join(tempDir, 'cookie_3s.json');
    fs.writeFileSync(cookiePath, '{}');

    const notifications = [];
    const mockApi = createMockApi(notifications);

    let virtualTime = 1700000000000;
    const clock = () => new Date(virtualTime);
    const sleepFn = async (ms) => {
      virtualTime += Math.max(1, ms || 1000);
    };

    // Initial state: 0 failures, 3 items across natural turns
    const store = new SqliteStore(dbPath, {
      items: [
        { id: 'item-strike-1', state: 'pending', payload: { text: 'Strike 1 item' } },
        { id: 'item-strike-2', state: 'pending', payload: { text: 'Strike 2 item' } },
        { id: 'item-strike-3', state: 'pending', payload: { text: 'Strike 3 item' } }
      ],
      accounts: [
        { id: 'acc-strike-chain', username: 'strike_target', userId: '5003', enabled: true, cookieFile: cookiePath, failures: 0 }
      ],
      cycle: { state: 'stopped', runId: null },
      settings: { dailyQuota: 10, delayMinSeconds: 5, delayMaxSeconds: 5 },
      posting: {},
      forensicLogs: []
    });
    await store.load();

    let attemptCount = 0;
    const publishAdapterFactory = () => ({
      supportsDispatchCallback: true,
      open: async ({ account }) => ({
        slot: 0,
        port: 18801,
        exitIp: '10.200.0.50',
        identity: { authenticated: true, username: account.username, userId: account.userId }
      }),
      publish: async ({ onDispatch }) => {
        attemptCount++;
        await onDispatch({ accountId: 'acc-strike-chain' });
        return { published: false, ambiguous: true, reason: 'publish_confirmation_missing' };
      },
      close: async () => {}
    });

    await run({
      token: 'test_token', userId: '100', chatId: '200', allowedUserIds: ['100'], allowedChatIds: ['200'],
      dataDir: tempDir, api: mockApi, vpnManager: createMockVpn('10.200.0.50'),
      maxPolls: 0, publishAdapterFactory, clock, sleepFn, attemptTimeoutMs: 3000,
      logger: { log: () => {}, error: () => {} },
      onRuntimeReady: async (ctx) => {
        await ctx.start({ stopAfterSuccess: false });
        await ctx.wait();
      }
    });

    const finalState = await store.load();

    // Verify 3 attempts occurred
    assert.strictEqual(attemptCount, 3, `Expected 3 attempts to be made, got ${attemptCount}`);

    // All 3 items quarantined as ambiguous
    assert.strictEqual(finalState.items.filter(i => i.state === 'ambiguous').length, 3, 'All 3 items must be ambiguous');

    // Account state verification: strictly isolated
    const account = finalState.accounts.find(a => a.id === 'acc-strike-chain');
    assert.strictEqual(account.failures, 3, 'Account failures must reach exactly 3');
    assert.strictEqual(account.enabled, false, 'Account must be disabled (isolated)');
    assert.strictEqual(account.status, 'معزول (3 إخفاقات)', 'Account status must be isolated');

    // Task 3 Verification: Notifications check
    // Exactly 1 alert total!
    const itemAlerts = notifications.filter(n => !n.includes('لا توجد روابط منشورات مؤكدة'));
    assert.strictEqual(itemAlerts.length, 1,
      `Expected exactly 1 notification total across all 3 strikes, received ${itemAlerts.length}: ${JSON.stringify(itemAlerts)}`);

    const isolationAlert = itemAlerts[0];
    assert.ok(isolationAlert.includes('تم عزل الحساب @strike_target تلقائياً'), 'Alert must announce account isolation');
    assert.ok(isolationAlert.includes('معزول (3 إخفاقات)'), 'Alert must specify isolation reason');
    assert.ok(!isolationAlert.includes('نتيجة نشر غامضة'), 'Alert must NOT contain ambiguous spam text');

    // Forensic logger verification: 3 post_ambiguous events + 1 account_isolated_3_failures event
    const forensicLogs = finalState.forensicLogs || [];
    const ambiguousLogs = forensicLogs.filter(e => e.eventType === 'post_ambiguous');
    const isolationLogs = forensicLogs.filter(e => e.eventType === 'account_isolated_3_failures');

    assert.strictEqual(ambiguousLogs.length, 3, 'Must record 3 post_ambiguous forensic events');
    assert.strictEqual(isolationLogs.length, 1, 'Must record exactly 1 account_isolated_3_failures event');
    assert.strictEqual(isolationLogs[0].accountId, 'acc-strike-chain');
    assert.strictEqual(isolationLogs[0].username, 'strike_target');
    assert.strictEqual(isolationLogs[0].details?.failures, 3);
    assert.strictEqual(isolationLogs[0].details?.isolated, true);
  });

  // =========================================================================
  // Adversarial Stress: Multi-Account Isolation Continuity & Single Alert
  // =========================================================================
  test('Multi-Account: Isolation on strike 3 emits single alert and cycle continues with remaining account', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'challenger-multi-acc-'));
    const dbPath = path.join(tempDir, 'state.sqlite');
    const c1 = path.join(tempDir, 'c1.json');
    const c2 = path.join(tempDir, 'c2.json');
    fs.writeFileSync(c1, '{}');
    fs.writeFileSync(c2, '{}');

    const notifications = [];
    const mockApi = createMockApi(notifications);

    let virtualTime = 1700000000000;
    const clock = () => new Date(virtualTime);
    const sleepFn = async (ms) => {
      virtualTime += Math.max(1, ms || 1000);
    };

    // Account A has 2 failures. Account B has 0 failures.
    const store = new SqliteStore(dbPath, {
      items: [
        { id: 'item-acc-a', state: 'pending', payload: { text: 'For Account A' } },
        { id: 'item-acc-b', state: 'pending', payload: { text: 'For Account B' } }
      ],
      accounts: [
        { id: 'acc-A', username: 'user_alpha', userId: '6001', enabled: true, cookieFile: c1, failures: 2 },
        { id: 'acc-B', username: 'user_beta', userId: '6002', enabled: true, cookieFile: c2, failures: 0 }
      ],
      cycle: { state: 'stopped', runId: null },
      settings: { dailyQuota: 10, delayMinSeconds: 1, delayMaxSeconds: 1 },
      posting: {},
      forensicLogs: []
    });
    await store.load();

    const publishAdapterFactory = () => ({
      supportsDispatchCallback: true,
      open: async ({ account }) => ({
        slot: account.id === 'acc-A' ? 0 : 1,
        port: account.id === 'acc-A' ? 18801 : 18802,
        exitIp: account.id === 'acc-A' ? '10.200.0.1' : '10.200.0.2',
        identity: { authenticated: true, username: account.username, userId: account.userId }
      }),
      publish: async ({ session, onDispatch }) => {
        if (session.identity.username === 'user_alpha') {
          // Strike 3 for Account A
          await onDispatch({ accountId: 'acc-A' });
          return { published: false, ambiguous: true, reason: 'publish_confirmation_missing' };
        } else {
          // Account B succeeds
          await onDispatch({ accountId: 'acc-B' });
          return { published: true, url: 'https://x.com/user_beta/status/2000000000000000001' };
        }
      },
      close: async () => {}
    });

    await run({
      token: 'test_token', userId: '100', chatId: '200', allowedUserIds: ['100'], allowedChatIds: ['200'],
      dataDir: tempDir, api: mockApi, vpnManager: createMockVpn(),
      maxPolls: 0, publishAdapterFactory, clock, sleepFn, attemptTimeoutMs: 3000,
      logger: { log: () => {}, error: () => {} },
      onRuntimeReady: async (ctx) => {
        await ctx.start({ stopAfterSuccess: false });
        await ctx.wait();
      }
    });

    const finalState = await store.load();

    // Account A is isolated
    const accA = finalState.accounts.find(a => a.id === 'acc-A');
    assert.strictEqual(accA.failures, 3);
    assert.strictEqual(accA.enabled, false);
    assert.strictEqual(accA.status, 'معزول (3 إخفاقات)');

    // Account B is healthy and published its post
    const accB = finalState.accounts.find(a => a.id === 'acc-B');
    assert.strictEqual(accB.failures, 0);
    assert.strictEqual(accB.enabled, true);

    const itemA = finalState.items.find(i => i.id === 'item-acc-a');
    assert.strictEqual(itemA.state, 'ambiguous');

    const itemB = finalState.items.find(i => i.id === 'item-acc-b');
    assert.strictEqual(itemB.state, 'published');
    assert.strictEqual(itemB.url, 'https://x.com/user_beta/status/2000000000000000001');

    // Exactly 1 isolation alert sent, mentioning continuing with remaining account (1)
    assert.strictEqual(notifications.length, 1, `Expected exactly 1 notification, got ${notifications.length}: ${JSON.stringify(notifications)}`);
    assert.ok(notifications[0].includes('تم عزل الحساب @user_alpha تلقائياً'));
    assert.ok(notifications[0].includes('ومواصلة الدورة عبر بقية الحسابات (1)'));

    // Quota: Only Account B deducted
    const day = Object.keys(finalState.posting?.quota || {})[0];
    assert.strictEqual(finalState.posting?.quota?.[day]?.['acc-A'] || 0, 0, 'No quota for Account A');
    assert.strictEqual(finalState.posting?.quota?.[day]?.['acc-B'], 1, 'Account B quota deducted 1');
  });

  // =========================================================================
  // Adversarial Stress: Success resets strikes, preventing premature isolation
  // =========================================================================
  test('Strike Reset: Successful post resets failure counter to 0 in SQLite', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'challenger-reset-'));
    const dbPath = path.join(tempDir, 'state.sqlite');
    const c1 = path.join(tempDir, 'c1.json');
    fs.writeFileSync(c1, '{}');

    const notifications = [];
    const mockApi = createMockApi(notifications);

    // Account starts with 2 failures
    const store = new SqliteStore(dbPath, {
      items: [
        { id: 'item-reset-success', state: 'pending', payload: { text: 'Success resets failures' } }
      ],
      accounts: [
        { id: 'acc-reset', username: 'reset_user', userId: '7001', enabled: true, cookieFile: c1, failures: 2 }
      ],
      cycle: { state: 'stopped', runId: null },
      settings: { dailyQuota: 10, delayMinSeconds: 0, delayMaxSeconds: 0 },
      posting: {},
      forensicLogs: []
    });
    await store.load();

    const publishAdapterFactory = () => ({
      supportsDispatchCallback: true,
      open: async ({ account }) => ({
        slot: 0,
        port: 18801,
        exitIp: '10.200.0.77',
        identity: { authenticated: true, username: account.username, userId: account.userId }
      }),
      publish: async ({ onDispatch }) => {
        await onDispatch({ accountId: 'acc-reset' });
        return { published: true, url: 'https://x.com/reset_user/status/3000000000000000001' };
      },
      close: async () => {}
    });

    await run({
      token: 'test_token', userId: '100', chatId: '200', allowedUserIds: ['100'], allowedChatIds: ['200'],
      dataDir: tempDir, api: mockApi, vpnManager: createMockVpn(),
      maxPolls: 0, publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
      logger: { log: () => {}, error: () => {} },
      onRuntimeReady: async (ctx) => {
        await ctx.start({ stopAfterSuccess: false });
        await ctx.wait();
      }
    });

    const finalState = await store.load();
    const account = finalState.accounts.find(a => a.id === 'acc-reset');
    assert.strictEqual(account.failures, 0, 'Failures must be reset to 0 after success');
    assert.strictEqual(account.enabled, true);
    assert.strictEqual(notifications.length, 0, 'Zero alerts emitted');
  });

});
