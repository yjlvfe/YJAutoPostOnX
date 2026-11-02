'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { SqliteStore } = require('../src/sqliteStore');
const { Queue } = require('../src/queue');
const { AccountManager, accountRecord } = require('../src/accounts');
const { run } = require('../src/runner');

function createMockApi(notifications = []) {
  return {
    getMe: async () => ({ id: 1 }),
    sendMessage: async (arg1, arg2) => {
      const text = typeof arg1 === 'object' && arg1 ? arg1.text : arg2;
      if (text) notifications.push(text);
      return { message_id: 1 };
    },
    sendRichMessage: async (arg1, arg2) => {
      const text = typeof arg1 === 'object' && arg1 ? arg1.text : arg2;
      if (text) notifications.push(text);
      return { message_id: 1 };
    },
    editMessageText: async () => ({ message_id: 1 }),
    deleteMessage: async () => {},
    getUpdates: async () => [],
    sendDocument: async () => ({})
  };
}

function createMockVpn() {
  return {
    ensure: async () => ({ exitIp: '1.2.3.4', proxy: 'socks5h://127.0.0.1:18801' }),
    health: async () => ({ healthy: true, exitIp: '1.2.3.4' }),
    rotate: async () => {}
  };
}

describe('Milestone M1 Core Runner & Queue Fixes Verification', () => {

  // -------------------------------------------------------------------------
  // 1. Ambiguous Strike Accounting & Attribution in SQLite
  // -------------------------------------------------------------------------
  describe('1. Ambiguous Outcomes & Strike Accounting', () => {
    test('1.1 Ambiguous outcome increments account failure strike and persists accountId/accountUsername in SQLite', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-ambig-strike-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const cookiePath = path.join(tempDir, 'c1.json');
      fs.writeFileSync(cookiePath, '{}');

      const notifications = [];
      const mockApi = createMockApi(notifications);

      const store = new SqliteStore(dbPath, {
        items: [
          { id: 'item-ambig-1', state: 'pending', payload: { text: 'Ambiguous strike test' } }
        ],
        accounts: [
          { id: 'acc-test', username: 'test_user', userId: '1001', enabled: true, cookieFile: cookiePath, failures: 0 }
        ],
        cycle: { state: 'stopped', runId: null },
        settings: { dailyQuota: 10, delayMinSeconds: 1, delayMaxSeconds: 1 },
        posting: {}
      });
      await store.load();

      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async () => ({
          slot: 1,
          identity: { authenticated: true, username: 'test_user', userId: '1001' }
        }),
        publish: async ({ onDispatch }) => {
          await onDispatch({ accountId: 'acc-test' });
          return { published: false, ambiguous: true, reason: 'publish_confirmation_missing' };
        },
        close: async () => {}
      });

      await run({
        token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
        dataDir: tempDir, api: mockApi, vpnManager: createMockVpn(),
        maxPolls: 0, publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
        logger: { log: () => {}, error: () => {} },
        onRuntimeReady: async (ctx) => {
          await ctx.start({ stopAfterSuccess: false });
          await ctx.wait();
        }
      });

      const state = await store.load();

      // Check item state and attribution in SQLite
      const item = state.items.find(x => x.id === 'item-ambig-1');
      assert.strictEqual(item.state, 'ambiguous', 'Item must be quarantined as ambiguous');
      assert.strictEqual(item.accountId, 'acc-test', 'Ambiguous item must retain accountId attribution in SQLite');
      assert.strictEqual(item.accountUsername, 'test_user', 'Ambiguous item must retain accountUsername attribution in SQLite');
      assert.strictEqual(item.reason, 'publish_confirmation_missing');

      // Check account failure strike incremented in SQLite
      const acc = state.accounts.find(a => a.id === 'acc-test');
      assert.strictEqual(acc.failures, 1, 'Account failure strike must increment to 1 on ambiguous outcome');
      assert.strictEqual(acc.enabled, true, 'Account must still be enabled on first failure');
      assert.strictEqual(notifications.filter(n => n.includes('نتيجة نشر غامضة')).length, 0,
        'Ambiguous item must produce a forensic event, not a per-item Telegram message');

      // Quota must NOT be deducted
      assert.strictEqual(state.posting?.quota?.[Object.keys(state.posting?.quota || {})[0]]?.['acc-test'] || 0, 0, 'No quota deducted for ambiguous');
    });

    test('1.2 Account isolates automatically upon 3rd failure strike with single notification', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-3-strikes-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const c1 = path.join(tempDir, 'c1.json');
      fs.writeFileSync(c1, '{}');

      const notifications = [];
      const mockApi = createMockApi(notifications);

      // Account starts with 2 failures already recorded
      const store = new SqliteStore(dbPath, {
        items: [
          { id: 'item-final-strike', state: 'pending', payload: { text: 'Strike 3 test' } }
        ],
        accounts: [
          { id: 'acc-strike3', username: 'strike_user', userId: '2001', enabled: true, cookieFile: c1, failures: 2 }
        ],
        cycle: { state: 'stopped', runId: null },
        settings: { dailyQuota: 10, delayMinSeconds: 1, delayMaxSeconds: 1 },
        posting: {}
      });
      await store.load();

      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async () => ({
          slot: 1,
          identity: { authenticated: true, username: 'strike_user', userId: '2001' }
        }),
        publish: async ({ onDispatch }) => {
          await onDispatch({ accountId: 'acc-strike3' });
          return { published: false, ambiguous: true, reason: 'publish_author_or_id_unverified' };
        },
        close: async () => {}
      });

      await run({
        token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
        dataDir: tempDir, api: mockApi, vpnManager: createMockVpn(),
        maxPolls: 0, publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
        logger: { log: () => {}, error: () => {} },
        onRuntimeReady: async (ctx) => {
          await ctx.start({ stopAfterSuccess: false });
          await ctx.wait();
        }
      });

      const state = await store.load();
      const acc = state.accounts.find(a => a.id === 'acc-strike3');
      assert.strictEqual(acc.failures, 3, 'Account failures must reach 3');
      assert.strictEqual(acc.enabled, false, 'Account must be disabled on 3rd failure');
      assert.strictEqual(acc.status, 'معزول (3 إخفاقات)', 'Account status must be isolated');

      // Check single isolation alert was sent
      const isolationAlerts = notifications.filter(n => n.includes('تم عزل الحساب') && n.includes('معزول (3 إخفاقات)'));
      assert.strictEqual(isolationAlerts.length, 1, 'Exactly one isolation alert must be sent');
      assert.strictEqual(notifications.filter(n => n.includes('نتيجة نشر غامضة')).length, 0,
        'Account isolation should produce one alert, not an additional ambiguous item alert');
    });

    test('1.3 Successful post resets failure strikes to 0', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-reset-success-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const c1 = path.join(tempDir, 'c1.json');
      fs.writeFileSync(c1, '{}');

      const mockApi = createMockApi();

      // Account starts with 2 failures
      const store = new SqliteStore(dbPath, {
        items: [
          { id: 'item-success', state: 'pending', payload: { text: 'Success reset test' } }
        ],
        accounts: [
          { id: 'acc-recovering', username: 'good_user', userId: '3001', enabled: true, cookieFile: c1, failures: 2 }
        ],
        cycle: { state: 'stopped', runId: null },
        settings: { dailyQuota: 10, delayMinSeconds: 1, delayMaxSeconds: 1 },
        posting: {}
      });
      await store.load();

      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async () => ({
          slot: 1,
          identity: { authenticated: true, username: 'good_user', userId: '3001' }
        }),
        publish: async ({ onDispatch }) => {
          await onDispatch({ accountId: 'acc-recovering' });
          return { published: true, url: 'https://x.com/good_user/status/777888' };
        },
        close: async () => {}
      });

      await run({
        token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
        dataDir: tempDir, api: mockApi, vpnManager: createMockVpn(),
        maxPolls: 0, publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
        logger: { log: () => {}, error: () => {} },
        onRuntimeReady: async (ctx) => {
          await ctx.start({ stopAfterSuccess: true });
          await ctx.wait();
        }
      });

      const state = await store.load();
      const acc = state.accounts.find(a => a.id === 'acc-recovering');
      assert.strictEqual(acc.failures, 0, 'Failures must reset to 0 upon successful post');
    });
  });

  // -------------------------------------------------------------------------
  // 2. Exclude Network/VPN Errors from Strikes
  // -------------------------------------------------------------------------
  describe('2. Network/VPN Error Strike Exclusion', () => {
    test('2.1 Transient network_proxy_error does NOT increment account failures', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-net-proxy-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const c1 = path.join(tempDir, 'c1.json');
      fs.writeFileSync(c1, '{}');

      const mockApi = createMockApi();

      const store = new SqliteStore(dbPath, {
        items: [
          { id: 'item-net-err', state: 'pending', payload: { text: 'Network error test' } }
        ],
        accounts: [
          { id: 'acc-net', username: 'net_user', userId: '4001', enabled: true, cookieFile: c1, failures: 0 }
        ],
        cycle: { state: 'stopped', runId: null },
        settings: { dailyQuota: 10, delayMinSeconds: 1, delayMaxSeconds: 1 },
        posting: {}
      });
      await store.load();

      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async () => ({
          slot: 1,
          identity: {
            authenticated: false,
            accountFailure: 'network_proxy_error',
            reason: 'SOCKS5 proxy connection reset by peer'
          }
        }),
        publish: async () => {
          throw new Error('Should not reach publish');
        },
        close: async () => {}
      });

      await run({
        token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
        dataDir: tempDir, api: mockApi, vpnManager: createMockVpn(),
        maxPolls: 0, publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
        logger: { log: () => {}, error: () => {} },
        onRuntimeReady: async (ctx) => {
          await ctx.start({ stopAfterSuccess: false });
          await ctx.wait();
        }
      });

      const state = await store.load();
      const acc = state.accounts.find(a => a.id === 'acc-net');
      assert.strictEqual(acc.failures, 0, 'Network proxy error must NEVER increment account failure strikes');
      assert.strictEqual(acc.enabled, true, 'Account must remain enabled');
      assert.notStrictEqual(acc.status, 'معزول (3 إخفاقات)');
    });
  });

  // -------------------------------------------------------------------------
  // 3. Pre-Dispatch Post Protection & Crash Recovery in queue.js
  // -------------------------------------------------------------------------
  describe('3. Pre-Dispatch Post Protection & Crash Recovery in queue.js', () => {
    test('3.1 recoverProcessing resets claimed (pre-dispatch) posts to pending', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-queue-recover-'));
      const dbPath = path.join(tempDir, 'state.sqlite');

      const store = new SqliteStore(dbPath, {
        items: [
          {
            id: 'item-pre-dispatch',
            state: 'processing',
            payload: { text: 'Pre-dispatch claimed post' },
            claimedAt: new Date().toISOString(),
            attempt: { phase: 'claimed', token: 'tok-1', runId: 'run-1' }
          },
          {
            id: 'item-mid-dispatch',
            state: 'processing',
            payload: { text: 'In-flight post' },
            attempt: { phase: 'dispatching', token: 'tok-2', runId: 'run-1' }
          },
          {
            id: 'item-started',
            state: 'dispatch_started',
            payload: { text: 'Dispatch started post' },
            attempt: { token: 'tok-3', runId: 'run-1' }
          }
        ],
        accounts: []
      });
      await store.load();

      const queue = new Queue(store);
      await queue.recoverProcessing({ state: 'ambiguous', reason: 'crash_restart' });

      const state = await store.load();

      // Claimed item MUST be reset to pending (never lost!)
      const preDispatchItem = state.items.find(x => x.id === 'item-pre-dispatch');
      assert.strictEqual(preDispatchItem.state, 'pending', 'Pre-dispatch post must be reset to pending');
      assert.strictEqual(preDispatchItem.attempt, undefined, 'Attempt must be deleted');
      assert.strictEqual(preDispatchItem.claimedAt, undefined, 'claimedAt must be deleted');

      // Mid-dispatch items MUST be quarantined as ambiguous (to prevent double-posting)
      const midDispatchItem = state.items.find(x => x.id === 'item-mid-dispatch');
      assert.strictEqual(midDispatchItem.state, 'ambiguous', 'Mid-dispatch post must be quarantined as ambiguous');
      assert.strictEqual(midDispatchItem.reason, 'crash_restart');

      const startedItem = state.items.find(x => x.id === 'item-started');
      assert.strictEqual(startedItem.state, 'ambiguous', 'dispatch_started post must be quarantined as ambiguous');
      assert.strictEqual(startedItem.reason, 'crash_restart');
    });

    test('3.2 Pre-dispatch account failure immediately transfers post to next eligible account in same pass', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-predispatch-transfer-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const c1 = path.join(tempDir, 'c1.json');
      const c2 = path.join(tempDir, 'c2.json');
      fs.writeFileSync(c1, '{}');
      fs.writeFileSync(c2, '{}');

      const mockApi = createMockApi();

      const store = new SqliteStore(dbPath, {
        items: [
          { id: 'post-1', state: 'pending', payload: { text: 'Post 1 to transfer' } },
          { id: 'post-2', state: 'pending', payload: { text: 'Post 2 following' } }
        ],
        accounts: [
          { id: 'acc-1', username: 'bad_auth', userId: '5001', enabled: true, cookieFile: c1, failures: 0 },
          { id: 'acc-2', username: 'good_auth', userId: '5002', enabled: true, cookieFile: c2, failures: 0 }
        ],
        cycle: { state: 'stopped', runId: null },
        settings: { dailyQuota: 10, delayMinSeconds: 1, delayMaxSeconds: 1 },
        posting: {}
      });
      await store.load();

      let acc1Calls = 0;
      let acc2Calls = 0;

      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async ({ account }) => {
          if (account.id === 'acc-1') {
            acc1Calls++;
            return {
              slot: 1,
              identity: { authenticated: false, accountFailure: 'auth_rejected', reason: 'bad credentials' }
            };
          }
          acc2Calls++;
          return {
            slot: 2,
            identity: { authenticated: true, username: 'good_auth', userId: '5002' }
          };
        },
        publish: async ({ onDispatch }) => {
          await onDispatch({ accountId: 'acc-2' });
          return { published: true, url: 'https://x.com/good_auth/status/9090' };
        },
        close: async () => {}
      });

      await run({
        token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
        dataDir: tempDir, api: mockApi, vpnManager: createMockVpn(),
        maxPolls: 0, publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
        logger: { log: () => {}, error: () => {} },
        onRuntimeReady: async (ctx) => {
          await ctx.start({ stopAfterSuccess: true });
          await ctx.wait();
        }
      });

      const state = await store.load();
      // post-1 must have been transferred to acc-2 and published
      const p1 = state.items.find(x => x.id === 'post-1');
      assert.strictEqual(p1.state, 'published');
      assert.strictEqual(p1.accountId, 'acc-2');
      assert.strictEqual(p1.accountUsername, 'good_auth');

      // acc-1 received a failure strike
      const a1 = state.accounts.find(a => a.id === 'acc-1');
      assert.strictEqual(a1.failures, 1);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Multi-Account Boundaries (5 Active Max & Independent Quota)
  // -------------------------------------------------------------------------
  describe('4. Multi-Account Boundaries & Ceilings', () => {
    test('4.1 Enforces MAX_ACTIVE_ACCOUNTS = 5 limit', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-5active-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const store = new SqliteStore(dbPath, { accounts: [] });
      await store.load();

      const manager = new AccountManager(store, { maxActiveAccounts: 5 });

      // Add 5 active accounts
      for (let i = 1; i <= 5; i++) {
        await manager.add({ id: `acc-${i}`, username: `user_${i}`, enabled: true });
      }

      let accounts = await manager.list();
      let activeCount = accounts.filter(a => a.enabled !== false).length;
      assert.strictEqual(activeCount, 5, 'Exactly 5 accounts must be active');

      // Add 6th account — must be auto-disabled
      const acc6 = await manager.add({ id: 'acc-6', username: 'user_6', enabled: true });
      assert.strictEqual(acc6.enabled, false, '6th account must be auto-disabled');
      assert.strictEqual(acc6.status, 'غير مفعل');

      // Trying to enable the 6th account via update must throw
      await assert.rejects(
        () => manager.update('acc-6', { enabled: true }),
        /At most 5 active accounts are supported/
      );
    });
  });
});
