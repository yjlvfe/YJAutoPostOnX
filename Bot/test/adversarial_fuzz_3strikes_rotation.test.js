'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const { SqliteStore } = require('../src/sqliteStore');
const { Queue } = require('../src/queue');
const { AccountManager } = require('../src/accounts');
const { run } = require('../src/runner');

function createMockTelegramApi(notifications = []) {
  return {
    getMe: async () => ({ id: 1 }),
    sendMessage: async (arg1, arg2) => {
      const text = typeof arg1 === 'object' && arg1 ? arg1.text : arg2;
      if (text) notifications.push(text);
      return { message_id: Math.floor(Math.random() * 10000) + 1 };
    },
    sendRichMessage: async (arg1, arg2) => {
      const text = typeof arg1 === 'object' && arg1 ? arg1.text : arg2;
      if (text) notifications.push(text);
      return { message_id: Math.floor(Math.random() * 10000) + 1 };
    },
    editMessageText: async () => ({ message_id: 1 }),
    deleteMessage: async () => {},
    getUpdates: async () => [],
    sendDocument: async () => ({})
  };
}

function createMockVpn() {
  return {
    ensure: async (accountId) => ({
      exitIp: '10.200.0.1',
      proxy: 'socks5h://127.0.0.1:18801',
      slot: 1
    }),
    health: async () => ({ healthy: true, exitIp: '10.200.0.1' }),
    rotate: async () => {}
  };
}

describe('Empirical Challenger: 3-Strikes Accounting, Pacing & Natural Rotation Stress Suite', () => {

  // =========================================================================
  // TEST 1: Ambiguous Strikes Accumulation across Natural Turns, Cooling & 3rd Strike Isolation
  // =========================================================================
  test('1. Ambiguous outcomes increment strikes across 3 natural turns, cool on 1 & 2, and isolate on strike 3', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuzz-3strikes-ambig-'));
    const dbPath = path.join(tempDir, 'state.sqlite');
    const c1 = path.join(tempDir, 'c1.json');
    const c2 = path.join(tempDir, 'c2.json');
    fs.writeFileSync(c1, '{}');
    fs.writeFileSync(c2, '{}');

    const notifications = [];
    const mockApi = createMockTelegramApi(notifications);

    let virtualTime = 1700000000000;
    const clock = () => new Date(virtualTime);
    let sleepCalls = 0;
    const sleepFn = async (ms) => {
      sleepCalls++;
      virtualTime += Math.max(1, ms || 1000);
    };

    // 2 accounts: acc-flaky (will return ambiguous), acc-healthy (will publish successfully)
    // 10 items in queue to allow 3 full natural cycles with 60s cooling
    const items = Array.from({ length: 10 }, (_, i) => ({
      id: `post-${i + 1}`,
      state: 'pending',
      payload: { text: `Item ${i + 1}` }
    }));
    const store = new SqliteStore(dbPath, {
      items,
      accounts: [
        { id: 'acc-flaky', username: 'flaky_user', userId: '1001', enabled: true, cookieFile: c1, failures: 0 },
        { id: 'acc-healthy', username: 'healthy_user', userId: '1002', enabled: true, cookieFile: c2, failures: 0 }
      ],
      cycle: { state: 'stopped', runId: null },
      settings: { dailyQuota: 30, delayMinSeconds: 20, delayMaxSeconds: 20 },
      posting: {}
    });
    await store.load();

    const publishCounts = { 'acc-flaky': 0, 'acc-healthy': 0 };

    const publishAdapterFactory = () => ({
      supportsDispatchCallback: true,
      open: async ({ account }) => ({
        slot: account.id === 'acc-flaky' ? 1 : 2,
        identity: { authenticated: true, username: account.username, userId: account.userId }
      }),
      publish: async ({ session, onDispatch }) => {
        const accId = session.slot === 1 ? 'acc-flaky' : 'acc-healthy';
        publishCounts[accId]++;
        await onDispatch({ accountId: accId });
        if (accId === 'acc-flaky') {
          return { published: false, ambiguous: true, reason: 'publish_confirmation_missing' };
        }
        return { published: true, url: `https://x.com/healthy/status/${Date.now()}` };
      },
      close: async () => {}
    });

    await run({
      token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
      dataDir: tempDir, api: mockApi, vpnManager: createMockVpn(),
      maxPolls: 0, publishAdapterFactory, clock, sleepFn, attemptTimeoutMs: 3000,
      logger: { log: () => {}, error: () => {} },
      onRuntimeReady: async (ctx) => {
        await ctx.start({ stopAfterSuccess: false });
        await ctx.wait();
      }
    });

    const state = await store.load();

    // Verify acc-flaky reached strike 3 and was isolated
    const flakyAcc = state.accounts.find(a => a.id === 'acc-flaky');
    assert.strictEqual(flakyAcc.failures, 3, 'acc-flaky must have accumulated exactly 3 failure strikes');
    assert.strictEqual(flakyAcc.enabled, false, 'acc-flaky must be disabled after 3 strikes');
    assert.strictEqual(flakyAcc.status, 'معزول (3 إخفاقات)', 'Status must be معزول (3 إخفاقات)');

    // Verify isolation notification was sent
    const isolationAlerts = notifications.filter(n => n.includes('تم عزل الحساب @flaky_user') && n.includes('معزول (3 إخفاقات)'));
    assert.strictEqual(isolationAlerts.length, 1, 'Exactly one isolation alert must be sent for acc-flaky');

    // Verify ambiguous posts have account attribution in SQLite
    const ambiguousItems = state.items.filter(i => i.state === 'ambiguous');
    assert.strictEqual(ambiguousItems.length, 3, 'Exactly 3 posts must be marked ambiguous');
    for (const ambItem of ambiguousItems) {
      assert.strictEqual(ambItem.accountId, 'acc-flaky', 'Ambiguous post must retain accountId attribution');
      assert.strictEqual(ambItem.accountUsername, 'flaky_user', 'Ambiguous post must retain accountUsername attribution');
      assert.strictEqual(ambItem.reason, 'publish_confirmation_missing');
    }

    // Verify healthy account published the other 7 posts successfully
    const publishedItems = state.items.filter(i => i.state === 'published');
    assert.strictEqual(publishedItems.length, 7, 'Remaining 7 items must be published successfully');
    for (const pubItem of publishedItems) {
      assert.strictEqual(pubItem.accountId, 'acc-healthy');
    }

    const healthyAcc = state.accounts.find(a => a.id === 'acc-healthy');
    assert.strictEqual(healthyAcc.failures, 0, 'Healthy account has 0 failures');
    assert.strictEqual(healthyAcc.enabled, true, 'Healthy account remains enabled');

    // Verify that pacing was respected: sleepFn was called for delays
    assert.ok(sleepCalls > 0, 'sleepFn must have been called to enforce pacing delay');
  });

  // =========================================================================
  // TEST 2: Verification that skipDelay is FALSE on Ambiguous Outcomes
  // =========================================================================
  test('2. Ambiguous outcome enforces skipDelay === false and schedules nextPostAt pacing deadline', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuzz-ambig-pacing-'));
    const dbPath = path.join(tempDir, 'state.sqlite');
    const c1 = path.join(tempDir, 'c1.json');
    fs.writeFileSync(c1, '{}');

    const mockApi = createMockTelegramApi();

    let virtualTime = 1700000000000;
    const clock = () => new Date(virtualTime);
    const delayCalls = [];
    const sleepFn = async (ms) => {
      delayCalls.push(ms);
      virtualTime += Math.max(1, ms || 1000);
    };

    const store = new SqliteStore(dbPath, {
      items: [
        { id: 'item-pace-1', state: 'pending', payload: { text: 'Pacing test 1' } }
      ],
      accounts: [
        { id: 'acc-pacer', username: 'pacer_user', userId: '2001', enabled: true, cookieFile: c1, failures: 0 }
      ],
      cycle: { state: 'stopped', runId: null },
      settings: { dailyQuota: 10, delayMinSeconds: 20, delayMaxSeconds: 20 },
      posting: {}
    });
    await store.load();

    const publishAdapterFactory = () => ({
      supportsDispatchCallback: true,
      open: async () => ({
        slot: 1,
        identity: { authenticated: true, username: 'pacer_user', userId: '2001' }
      }),
      publish: async ({ onDispatch }) => {
        await onDispatch({ accountId: 'acc-pacer' });
        return { published: false, ambiguous: true, reason: 'publish_confirmation_missing' };
      },
      close: async () => {}
    });

    await run({
      token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
      dataDir: tempDir, api: mockApi, vpnManager: createMockVpn(),
      maxPolls: 0, publishAdapterFactory, clock, sleepFn, attemptTimeoutMs: 3000,
      logger: { log: () => {}, error: () => {} },
      onRuntimeReady: async (ctx) => {
        await ctx.start({ stopAfterSuccess: false });
        await ctx.wait();
      }
    });

    const state = await store.load();
    const item = state.items.find(x => x.id === 'item-pace-1');
    assert.strictEqual(item.state, 'ambiguous');

    // Verify nextPostAt was set in posting state to enforce delay
    assert.ok(state.posting?.nextPostAt, 'nextPostAt must be set for pacing after ambiguous outcome');
    const nextPostAtTime = new Date(state.posting.nextPostAt).getTime();
    assert.ok(nextPostAtTime >= 1700000000000 + 20 * 1000, 'nextPostAt must be at least 20s in the future');

    // Verify account received strike 1
    const acc = state.accounts.find(a => a.id === 'acc-pacer');
    assert.strictEqual(acc.failures, 1, 'Account failure must increment on ambiguous outcome');
  });

  // =========================================================================
  // TEST 3: Immediate Isolation on Confirmed Ban or Captcha (Turn 1 Isolation)
  // =========================================================================
  test('3. Confirmed ban or captcha immediately isolates account on turn 1 without waiting for 3 strikes', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuzz-instant-isolation-'));
    const dbPath = path.join(tempDir, 'state.sqlite');
    const c1 = path.join(tempDir, 'c1.json');
    const c2 = path.join(tempDir, 'c2.json');
    fs.writeFileSync(c1, '{}');
    fs.writeFileSync(c2, '{}');

    const notifications = [];
    const mockApi = createMockTelegramApi(notifications);

    let virtualTime = 1700000000000;
    const clock = () => new Date(virtualTime);
    const sleepFn = async (ms) => { virtualTime += Math.max(1, ms || 1000); };

    // Acc-ban gets 'banned', Acc-cap gets 'captcha'
    const store = new SqliteStore(dbPath, {
      items: [
        { id: 'item-ban', state: 'pending', payload: { text: 'Ban test' } },
        { id: 'item-cap', state: 'pending', payload: { text: 'Captcha test' } }
      ],
      accounts: [
        { id: 'acc-ban', username: 'banned_user', userId: '3001', enabled: true, cookieFile: c1, failures: 0 },
        { id: 'acc-cap', username: 'captcha_user', userId: '3002', enabled: true, cookieFile: c2, failures: 0 }
      ],
      cycle: { state: 'stopped', runId: null },
      settings: { dailyQuota: 10, delayMinSeconds: 1, delayMaxSeconds: 1 },
      posting: {}
    });
    await store.load();

    const publishAdapterFactory = () => ({
      supportsDispatchCallback: true,
      open: async ({ account }) => {
        if (account.id === 'acc-ban') {
          return {
            slot: 1,
            identity: { authenticated: false, accountFailure: 'banned', reason: 'account suspended by X' }
          };
        }
        return {
          slot: 2,
          identity: { authenticated: false, accountFailure: 'captcha', reason: 'arkose security challenge' }
        };
      },
      publish: async () => { throw new Error('Unreachable'); },
      close: async () => {}
    });

    await run({
      token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
      dataDir: tempDir, api: mockApi, vpnManager: createMockVpn(),
      maxPolls: 0, publishAdapterFactory, clock, sleepFn, attemptTimeoutMs: 3000,
      logger: { log: () => {}, error: () => {} },
      onRuntimeReady: async (ctx) => {
        await ctx.start({ stopAfterSuccess: false });
        await ctx.wait();
      }
    });

    const state = await store.load();

    const accBan = state.accounts.find(a => a.id === 'acc-ban');
    assert.strictEqual(accBan.enabled, false, 'Banned account must be disabled immediately');
    assert.strictEqual(accBan.status, 'محظور', 'Banned account status must be محظور');

    const accCap = state.accounts.find(a => a.id === 'acc-cap');
    assert.strictEqual(accCap.enabled, false, 'Captcha account must be disabled immediately');
    assert.strictEqual(accCap.status, 'كابتشا', 'Captcha account status must be كابتشا');

    // Both items failed pre-dispatch so they must remain pending safely
    assert.strictEqual(state.items.find(i => i.id === 'item-ban').state, 'pending');
    assert.strictEqual(state.items.find(i => i.id === 'item-cap').state, 'pending');

    // Both isolation notifications sent
    assert.ok(notifications.some(n => n.includes('تم عزل الحساب @banned_user') && n.includes('محظور')));
    assert.ok(notifications.some(n => n.includes('تم عزل الحساب @captcha_user') && n.includes('كابتشا')));
  });

  // =========================================================================
  // TEST 4: Immediate Reset of Failures to 0 on Verified Publish
  // =========================================================================
  test('4. Successful verified post immediately resets failures strike counter to 0', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuzz-reset-success-'));
    const dbPath = path.join(tempDir, 'state.sqlite');
    const c1 = path.join(tempDir, 'c1.json');
    fs.writeFileSync(c1, '{}');

    const mockApi = createMockTelegramApi();

    let virtualTime = 1700000000000;
    const clock = () => new Date(virtualTime);
    const sleepFn = async (ms) => { virtualTime += Math.max(1, ms || 1000); };

    // Account starts with 2 existing strikes
    const store = new SqliteStore(dbPath, {
      items: [
        { id: 'item-reset', state: 'pending', payload: { text: 'Reset strike test' } }
      ],
      accounts: [
        { id: 'acc-recover', username: 'recover_user', userId: '4001', enabled: true, cookieFile: c1, failures: 2 }
      ],
      cycle: { state: 'stopped', runId: null },
      settings: { dailyQuota: 10, delayMinSeconds: 1, delayMaxSeconds: 1 },
      posting: { cooling: { 'acc-recover': { failures: 2, until: 0 } } }
    });
    await store.load();

    const publishAdapterFactory = () => ({
      supportsDispatchCallback: true,
      open: async () => ({
        slot: 1,
        identity: { authenticated: true, username: 'recover_user', userId: '4001' }
      }),
      publish: async ({ onDispatch }) => {
        await onDispatch({ accountId: 'acc-recover' });
        return { published: true, url: 'https://x.com/recover_user/status/123456789' };
      },
      close: async () => {}
    });

    await run({
      token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
      dataDir: tempDir, api: mockApi, vpnManager: createMockVpn(),
      maxPolls: 0, publishAdapterFactory, clock, sleepFn, attemptTimeoutMs: 3000,
      logger: { log: () => {}, error: () => {} },
      onRuntimeReady: async (ctx) => {
        await ctx.start({ stopAfterSuccess: true });
        await ctx.wait();
      }
    });

    const state = await store.load();
    const acc = state.accounts.find(a => a.id === 'acc-recover');
    assert.strictEqual(acc.failures, 0, 'Failures must reset from 2 to 0 on verified publish');
    assert.strictEqual(acc.enabled, true);
    assert.strictEqual(state.posting?.cooling?.['acc-recover'], undefined, 'Cooling entry must be deleted on success');

    const item = state.items.find(x => x.id === 'item-reset');
    assert.strictEqual(item.state, 'published');
    assert.strictEqual(item.accountId, 'acc-recover');
  });

  // =========================================================================
  // TEST 5: Multi-Account Natural Rotation Order (Round-Robin with Cursors)
  // =========================================================================
  test('5. Multi-account natural rotation order rotates evenly across active accounts', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuzz-rotation-rr-'));
    const dbPath = path.join(tempDir, 'state.sqlite');
    const c1 = path.join(tempDir, 'c1.json');
    const c2 = path.join(tempDir, 'c2.json');
    const c3 = path.join(tempDir, 'c3.json');
    fs.writeFileSync(c1, '{}');
    fs.writeFileSync(c2, '{}');
    fs.writeFileSync(c3, '{}');

    const mockApi = createMockTelegramApi();

    let virtualTime = 1700000000000;
    const clock = () => new Date(virtualTime);
    const sleepFn = async (ms) => { virtualTime += Math.max(1, ms || 1000); };

    // 3 active accounts, 6 pending items
    const store = new SqliteStore(dbPath, {
      items: [
        { id: 'rr-1', state: 'pending', payload: { text: 'Item 1' } },
        { id: 'rr-2', state: 'pending', payload: { text: 'Item 2' } },
        { id: 'rr-3', state: 'pending', payload: { text: 'Item 3' } },
        { id: 'rr-4', state: 'pending', payload: { text: 'Item 4' } },
        { id: 'rr-5', state: 'pending', payload: { text: 'Item 5' } },
        { id: 'rr-6', state: 'pending', payload: { text: 'Item 6' } }
      ],
      accounts: [
        { id: 'acc-rot-1', username: 'rot_1', userId: '5001', enabled: true, cookieFile: c1, failures: 0 },
        { id: 'acc-rot-2', username: 'rot_2', userId: '5002', enabled: true, cookieFile: c2, failures: 0 },
        { id: 'acc-rot-3', username: 'rot_3', userId: '5003', enabled: true, cookieFile: c3, failures: 0 }
      ],
      cycle: { state: 'stopped', runId: null },
      settings: { dailyQuota: 20, delayMinSeconds: 15, delayMaxSeconds: 15 },
      posting: {}
    });
    await store.load();

    const dispatchOrder = [];

    const publishAdapterFactory = () => ({
      supportsDispatchCallback: true,
      open: async ({ account }) => ({
        slot: 1,
        identity: { authenticated: true, username: account.username, userId: account.userId }
      }),
      publish: async ({ session, onDispatch }) => {
        const currentAccId = session.identity.username === 'rot_1' ? 'acc-rot-1' : session.identity.username === 'rot_2' ? 'acc-rot-2' : 'acc-rot-3';
        dispatchOrder.push(currentAccId);
        await onDispatch({ accountId: currentAccId });
        return { published: true, url: `https://x.com/${session.identity.username}/status/${Date.now()}` };
      },
      close: async () => {}
    });

    await run({
      token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
      dataDir: tempDir, api: mockApi, vpnManager: createMockVpn(),
      maxPolls: 0, publishAdapterFactory, clock, sleepFn, attemptTimeoutMs: 3000,
      logger: { log: () => {}, error: () => {} },
      onRuntimeReady: async (ctx) => {
        await ctx.start({ stopAfterSuccess: false });
        await ctx.wait();
      }
    });

    const state = await store.load();

    // Verify all 6 published
    const published = state.items.filter(i => i.state === 'published');
    assert.strictEqual(published.length, 6);

    // Verify strict round-robin order
    assert.deepStrictEqual(
      dispatchOrder,
      ['acc-rot-1', 'acc-rot-2', 'acc-rot-3', 'acc-rot-1', 'acc-rot-2', 'acc-rot-3'],
      'Multi-account rotation must strictly follow round-robin order'
    );
  });

  // =========================================================================
  // TEST 6: Persistence of Failure Strikes Across SQLite Restarts
  // =========================================================================
  test('6. Strike counts and isolated status persist across database restart', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuzz-persist-reboot-'));
    const dbPath = path.join(tempDir, 'state.sqlite');
    const c1 = path.join(tempDir, 'c1.json');
    fs.writeFileSync(c1, '{}');

    // 1. Initialize store with 1 failure
    const store1 = new SqliteStore(dbPath, {
      items: [
        { id: 'post-persist-1', state: 'pending', payload: { text: 'Persist 1' } }
      ],
      accounts: [
        { id: 'acc-rebootable', username: 'rebootable', userId: '6001', enabled: true, cookieFile: c1, failures: 1 }
      ],
      cycle: { state: 'stopped', runId: null },
      settings: { dailyQuota: 10, delayMinSeconds: 1, delayMaxSeconds: 1 }
    });
    await store1.load();

    // 2. Close store1 and open store2 (simulating daemon reboot)
    const store2 = new SqliteStore(dbPath);
    const loadedState2 = await store2.load();
    const accReloaded = loadedState2.accounts.find(a => a.id === 'acc-rebootable');
    assert.strictEqual(accReloaded.failures, 1, 'Failures counter must survive daemon reboot');
    assert.strictEqual(accReloaded.enabled, true);

    // 3. Run second turn causing strike 2
    let virtualTime = 1700000000000;
    const clock = () => new Date(virtualTime);
    const sleepFn = async (ms) => { virtualTime += Math.max(1, ms || 1000); };

    const publishAdapterFactory = () => ({
      supportsDispatchCallback: true,
      open: async () => ({
        slot: 1,
        identity: { authenticated: true, username: 'rebootable', userId: '6001' }
      }),
      publish: async ({ onDispatch }) => {
        await onDispatch({ accountId: 'acc-rebootable' });
        return { published: false, ambiguous: true, reason: 'unverified' };
      },
      close: async () => {}
    });

    await run({
      token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
      dataDir: tempDir, api: createMockTelegramApi(), vpnManager: createMockVpn(),
      maxPolls: 0, publishAdapterFactory, clock, sleepFn, attemptTimeoutMs: 3000,
      logger: { log: () => {}, error: () => {} },
      onRuntimeReady: async (ctx) => {
        await ctx.start({ stopAfterSuccess: false });
        await ctx.wait();
      }
    });

    // 4. Close and reload again
    const store3 = new SqliteStore(dbPath);
    const loadedState3 = await store3.load();
    const accStrike2 = loadedState3.accounts.find(a => a.id === 'acc-rebootable');
    assert.strictEqual(accStrike2.failures, 2, 'Failures counter must increment to 2 and persist across second restart');
  });

  // =========================================================================
  // TEST 7: Zero Penalty Guarantee on Network / Proxy / VPN Outages
  // =========================================================================
  test('7. Network, SOCKS5 and VPN container transport outages register 0 failure strikes', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuzz-net-immunity-'));
    const dbPath = path.join(tempDir, 'state.sqlite');
    const c1 = path.join(tempDir, 'c1.json');
    fs.writeFileSync(c1, '{}');

    let virtualTime = 1700000000000;
    const clock = () => new Date(virtualTime);
    const sleepFn = async (ms) => { virtualTime += Math.max(1, ms || 1000); };

    const store = new SqliteStore(dbPath, {
      items: [
        { id: 'post-net-immune', state: 'pending', payload: { text: 'Network immunity test' } }
      ],
      accounts: [
        { id: 'acc-net-user', username: 'net_user', userId: '7001', enabled: true, cookieFile: c1, failures: 0 }
      ],
      cycle: { state: 'stopped', runId: null },
      settings: { dailyQuota: 10, delayMinSeconds: 1, delayMaxSeconds: 1 }
    });
    await store.load();

    const publishAdapterFactory = () => ({
      supportsDispatchCallback: true,
      open: async () => ({
        slot: 1,
        identity: {
          authenticated: false,
          accountFailure: 'network_proxy_error',
          reason: 'socks5 connection timeout'
        }
      }),
      publish: async () => { throw new Error('Unreachable'); },
      close: async () => {}
    });

    await run({
      token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
      dataDir: tempDir, api: createMockTelegramApi(), vpnManager: createMockVpn(),
      maxPolls: 0, publishAdapterFactory, clock, sleepFn, attemptTimeoutMs: 3000,
      logger: { log: () => {}, error: () => {} },
      onRuntimeReady: async (ctx) => {
        await ctx.start({ stopAfterSuccess: false });
        await ctx.wait();
      }
    });

    const state = await store.load();
    const acc = state.accounts.find(a => a.id === 'acc-net-user');
    assert.strictEqual(acc.failures, 0, 'Transport/proxy failure must NEVER penalize account failure strikes');
    assert.strictEqual(acc.enabled, true, 'Account must remain enabled');
  });

  // =========================================================================
  // TEST 8: Sole Active Account 3rd Strike Isolation Halts Cycle Cleanly
  // =========================================================================
  test('8. Sole active account isolates on 3rd strike and halts cycle with Arabic notification', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuzz-sole-isolate-'));
    const dbPath = path.join(tempDir, 'state.sqlite');
    const c1 = path.join(tempDir, 'c1.json');
    fs.writeFileSync(c1, '{}');

    const notifications = [];
    const mockApi = createMockTelegramApi(notifications);

    let virtualTime = 1700000000000;
    const clock = () => new Date(virtualTime);
    const sleepFn = async (ms) => { virtualTime += Math.max(1, ms || 1000); };

    // Acc starts at 2 failures, only 1 account
    const store = new SqliteStore(dbPath, {
      items: [
        { id: 'post-sole', state: 'pending', payload: { text: 'Sole account strike 3' } }
      ],
      accounts: [
        { id: 'acc-solo', username: 'solo_user', userId: '8001', enabled: true, cookieFile: c1, failures: 2 }
      ],
      cycle: { state: 'stopped', runId: null },
      settings: { dailyQuota: 10, delayMinSeconds: 1, delayMaxSeconds: 1 }
    });
    await store.load();

    const publishAdapterFactory = () => ({
      supportsDispatchCallback: true,
      open: async () => ({
        slot: 1,
        identity: { authenticated: true, username: 'solo_user', userId: '8001' }
      }),
      publish: async ({ onDispatch }) => {
        await onDispatch({ accountId: 'acc-solo' });
        return { published: false, ambiguous: true, reason: 'publish_confirmation_missing' };
      },
      close: async () => {}
    });

    await run({
      token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
      dataDir: tempDir, api: mockApi, vpnManager: createMockVpn(),
      maxPolls: 0, publishAdapterFactory, clock, sleepFn, attemptTimeoutMs: 3000,
      logger: { log: () => {}, error: () => {} },
      onRuntimeReady: async (ctx) => {
        await ctx.start({ stopAfterSuccess: false });
        await ctx.wait();
      }
    });

    const state = await store.load();
    const acc = state.accounts.find(a => a.id === 'acc-solo');
    assert.strictEqual(acc.failures, 3, 'Sole account reaches 3 strikes');
    assert.strictEqual(acc.enabled, false, 'Sole account disabled');
    assert.strictEqual(acc.status, 'معزول (3 إخفاقات)');

    // Cycle must halt
    assert.strictEqual(state.cycle?.state, 'stopped');

    // Single Arabic isolation notification stating no eligible accounts remain
    assert.ok(notifications.some(n => n.includes('تم عزل الحساب @solo_user') && n.includes('لا توجد حسابات مؤهلة متبقية؛ توقفت الدورة')));
  });

  // =========================================================================
  // TEST 9: HTTP 429 Rate Limit Preserves Existing Failures (Zero Strike Change)
  // =========================================================================
  test('9. HTTP 429 rate limit preserves existing failure count (neither increments nor resets)', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuzz-ratelimit-preserve-'));
    const dbPath = path.join(tempDir, 'state.sqlite');
    const c1 = path.join(tempDir, 'c1.json');
    const c2 = path.join(tempDir, 'c2.json');
    fs.writeFileSync(c1, '{}');
    fs.writeFileSync(c2, '{}');

    const mockApi = createMockTelegramApi();

    let virtualTime = 1700000000000;
    const clock = () => new Date(virtualTime);
    const sleepFn = async (ms) => { virtualTime += Math.max(1, ms || 1000); };

    // Acc-1 starts with 1 failure strike
    const store = new SqliteStore(dbPath, {
      items: [
        { id: 'post-rl', state: 'pending', payload: { text: 'Rate limit test' } }
      ],
      accounts: [
        { id: 'acc-rl', username: 'rl_user', userId: '9001', enabled: true, cookieFile: c1, failures: 1 },
        { id: 'acc-next', username: 'next_user', userId: '9002', enabled: true, cookieFile: c2, failures: 0 }
      ],
      cycle: { state: 'stopped', runId: null },
      settings: { dailyQuota: 10, delayMinSeconds: 1, delayMaxSeconds: 1 }
    });
    await store.load();

    const publishAdapterFactory = () => ({
      supportsDispatchCallback: true,
      open: async ({ account }) => ({
        slot: account.id === 'acc-rl' ? 1 : 2,
        identity: { authenticated: true, username: account.username, userId: account.userId }
      }),
      publish: async ({ session, onDispatch }) => {
        if (session.identity.username === 'rl_user') {
          return {
            published: false, rateLimit: true, accountFailure: 'rate_limit',
            retryAfterSeconds: 60, reason: 'rate_limit'
          };
        }
        await onDispatch({ accountId: 'acc-next' });
        return { published: true, url: 'https://x.com/next/status/555' };
      },
      close: async () => {}
    });

    await run({
      token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
      dataDir: tempDir, api: mockApi, vpnManager: createMockVpn(),
      maxPolls: 0, publishAdapterFactory, clock, sleepFn, attemptTimeoutMs: 3000,
      logger: { log: () => {}, error: () => {} },
      onRuntimeReady: async (ctx) => {
        await ctx.start({ stopAfterSuccess: true });
        await ctx.wait();
      }
    });

    const state = await store.load();
    const accRl = state.accounts.find(a => a.id === 'acc-rl');
    assert.strictEqual(accRl.failures, 1, 'HTTP 429 MUST preserve existing failures (remains exactly 1)');
    assert.strictEqual(accRl.enabled, true, 'Rate limited account remains enabled');

    // Post was transferred and published by acc-next
    const item = state.items.find(x => x.id === 'post-rl');
    assert.strictEqual(item.state, 'published');
    assert.strictEqual(item.accountId, 'acc-next');
  });

  // =========================================================================
  // TEST 10: Pinned Post Unpins on Account Failure and Transfers Cleanly
  // =========================================================================
  test('10. Pre-dispatch failure unpins payload.account so next eligible account can publish', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuzz-unpin-transfer-'));
    const dbPath = path.join(tempDir, 'state.sqlite');
    const c1 = path.join(tempDir, 'c1.json');
    const c2 = path.join(tempDir, 'c2.json');
    fs.writeFileSync(c1, '{}');
    fs.writeFileSync(c2, '{}');

    const mockApi = createMockTelegramApi();

    let virtualTime = 1700000000000;
    const clock = () => new Date(virtualTime);
    const sleepFn = async (ms) => { virtualTime += Math.max(1, ms || 1000); };

    // Item explicitly pinned to acc-pinned
    const store = new SqliteStore(dbPath, {
      items: [
        { id: 'post-pinned', state: 'pending', payload: { text: 'Pinned post', account: 'acc-pinned' } }
      ],
      accounts: [
        { id: 'acc-pinned', username: 'pinned_user', userId: '9101', enabled: true, cookieFile: c1, failures: 0 },
        { id: 'acc-backup', username: 'backup_user', userId: '9102', enabled: true, cookieFile: c2, failures: 0 }
      ],
      cycle: { state: 'stopped', runId: null },
      settings: { dailyQuota: 10, delayMinSeconds: 1, delayMaxSeconds: 1 }
    });
    await store.load();

    const publishAdapterFactory = () => ({
      supportsDispatchCallback: true,
      open: async ({ account }) => {
        if (account.id === 'acc-pinned') {
          return {
            slot: 1,
            identity: { authenticated: false, accountFailure: 'auth_rejected', reason: 'cookie rejected' }
          };
        }
        return {
          slot: 2,
          identity: { authenticated: true, username: 'backup_user', userId: '9102' }
        };
      },
      publish: async ({ onDispatch }) => {
        await onDispatch({ accountId: 'acc-backup' });
        return { published: true, url: 'https://x.com/backup/status/789' };
      },
      close: async () => {}
    });

    await run({
      token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
      dataDir: tempDir, api: mockApi, vpnManager: createMockVpn(),
      maxPolls: 0, publishAdapterFactory, clock, sleepFn, attemptTimeoutMs: 3000,
      logger: { log: () => {}, error: () => {} },
      onRuntimeReady: async (ctx) => {
        await ctx.start({ stopAfterSuccess: true });
        await ctx.wait();
      }
    });

    const state = await store.load();
    const item = state.items.find(x => x.id === 'post-pinned');
    assert.strictEqual(item.state, 'published', 'Post must be published');
    assert.strictEqual(item.accountId, 'acc-backup');
    assert.strictEqual(item.payload.account, undefined, 'payload.account must be unpinned on account failure');
  });

  // =========================================================================
  // TEST 11: 5-Active Limit Vacancy Dynamics upon Isolation
  // =========================================================================
  test('11. When active account is isolated, vacancy opens allowing 6th account to be enabled', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuzz-vacancy-ceiling-'));
    const dbPath = path.join(tempDir, 'state.sqlite');
    const store = new SqliteStore(dbPath, { accounts: [] });
    await store.load();

    const manager = new AccountManager(store, { maxActiveAccounts: 5 });

    // Seed 5 active accounts and 1 inactive account
    for (let i = 1; i <= 5; i++) {
      await manager.add({ id: `acc-active-${i}`, username: `active_${i}`, enabled: true });
    }
    await manager.add({ id: 'acc-bench', username: 'bench_user', enabled: false });

    // Attempting to enable acc-bench now fails because 5 are active
    await assert.rejects(
      () => manager.update('acc-bench', { enabled: true }),
      /At most 5 active accounts are supported/
    );

    // Isolate acc-active-1 (simulating strike 3)
    await store.update(s => {
      const acc = s.accounts.find(a => a.id === 'acc-active-1');
      acc.enabled = false;
      acc.status = 'معزول (3 إخفاقات)';
      acc.failures = 3;
      return s;
    });

    // Active count is now 4! Enabling acc-bench must succeed!
    const updatedBench = await manager.update('acc-bench', { enabled: true });
    assert.strictEqual(updatedBench.enabled, true, 'Bench account successfully activated into vacated slot');
    assert.strictEqual(updatedBench.status, 'مفعل');

    const accounts = await manager.list();
    const active = accounts.filter(a => a.enabled !== false && !['محظور', 'كابتشا', 'معزول (3 إخفاقات)'].includes(a.status));
    assert.strictEqual(active.length, 5, 'Active count remains capped at exactly 5');
  });
});
