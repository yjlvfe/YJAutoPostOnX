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

function createTrackingVpn(rotations = []) {
  return {
    ensure: async (accountId) => ({
      exitIp: '10.200.0.1',
      proxy: 'socks5h://127.0.0.1:18801',
      slot: 1
    }),
    health: async () => ({ healthy: true, exitIp: '10.200.0.1' }),
    rotate: async (accountId) => {
      rotations.push({ accountId, rotatedAt: Date.now() });
    }
  };
}

describe('Empirical Challenger M1.2: Deep Adversarial Fault Tolerance Suite', () => {

  // =========================================================================
  // SECTION 1: Network, Proxy & VPN Error Strike Immunity (Zero Penalty)
  // =========================================================================
  describe('1. Network, Proxy & VPN Fault Tolerance & Zero-Strike Guarantee', () => {

    test('1.1 SOCKS5 ECONNREFUSED in open() does not increment strikes and triggers VPN rotation', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chall-net-econnrefused-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const c1 = path.join(tempDir, 'c1.json');
      fs.writeFileSync(c1, '{}');

      const notifications = [];
      const rotations = [];
      const mockApi = createMockTelegramApi(notifications);
      const mockVpn = createTrackingVpn(rotations);

      const store = new SqliteStore(dbPath, {
        items: [
          { id: 'post-socks5', state: 'pending', payload: { text: 'SOCKS5 error test' } }
        ],
        accounts: [
          { id: 'acc-socks', username: 'socks_user', userId: '111', enabled: true, cookieFile: c1, failures: 0 }
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
            reason: 'connect ECONNREFUSED 127.0.0.1:18801 over socks5 proxy'
          }
        }),
        publish: async () => {
          throw new Error('Unreachable: should not publish on failed open');
        },
        close: async () => {}
      });

      await run({
        token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
        dataDir: tempDir, api: mockApi, vpnManager: mockVpn,
        maxPolls: 0, publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
        logger: { log: () => {}, error: () => {} },
        onRuntimeReady: async (ctx) => {
          await ctx.start({ stopAfterSuccess: false });
          await ctx.wait();
        }
      });

      const state = await store.load();
      const acc = state.accounts.find(a => a.id === 'acc-socks');
      assert.strictEqual(acc.failures, 0, 'SOCKS5 ECONNREFUSED must NEVER increment failure strikes');
      assert.strictEqual(acc.enabled, true, 'Account must remain enabled');
      assert.notStrictEqual(acc.status, 'معزول (3 إخفاقات)');
      assert.ok(rotations.length >= 1, 'VPN rotation must be triggered for network proxy error');
      assert.strictEqual(rotations[0].accountId, 'acc-socks');

      // Post must remain pending and untouched
      const item = state.items.find(i => i.id === 'post-socks5');
      assert.strictEqual(item.state, 'pending');
      assert.strictEqual(item.attempt, undefined);
    });

    test('1.2 NordVPN reset during vpnSlots.ensure (VPN_TRANSIENT_UNAVAILABLE) preserves failure count', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chall-net-vpn-transient-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const c1 = path.join(tempDir, 'c1.json');
      fs.writeFileSync(c1, '{}');

      const notifications = [];
      const mockApi = createMockTelegramApi(notifications);

      let ensureAttempts = 0;
      const failingVpn = {
        ensure: async () => {
          ensureAttempts++;
          const err = new Error('NordVPN container reset: proxy_unreachable');
          err.code = 'VPN_NOT_READY';
          throw err;
        },
        health: async () => ({ healthy: false }),
        rotate: async () => {}
      };

      const store = new SqliteStore(dbPath, {
        items: [
          { id: 'post-vpn-transient', state: 'pending', payload: { text: 'VPN transient test' } }
        ],
        accounts: [
          // Account already had 1 legitimate failure strike from a previous cycle
          { id: 'acc-vpn-drop', username: 'drop_user', userId: '222', enabled: true, cookieFile: c1, failures: 1 }
        ],
        cycle: { state: 'stopped', runId: null },
        settings: { dailyQuota: 10, delayMinSeconds: 1, delayMaxSeconds: 1 },
        posting: {}
      });
      await store.load();

      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async () => ({ slot: 1, identity: { authenticated: true } }),
        publish: async () => ({ published: true, url: 'https://x.com/drop_user/status/1' }),
        close: async () => {}
      });

      await run({
        token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
        dataDir: tempDir, api: mockApi, vpnManager: failingVpn,
        maxPolls: 0, publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
        logger: { log: () => {}, error: () => {} },
        onRuntimeReady: async (ctx) => {
          await ctx.start({ stopAfterSuccess: false });
          await ctx.wait();
        }
      });

      const state = await store.load();
      const acc = state.accounts.find(a => a.id === 'acc-vpn-drop');
      assert.strictEqual(acc.failures, 1, 'Transient VPN drop must NOT increment failures from 1 to 2');
      assert.strictEqual(acc.enabled, true, 'Account must remain enabled');

      // Post remains pending
      const item = state.items.find(i => i.id === 'post-vpn-transient');
      assert.strictEqual(item.state, 'pending');
      assert.strictEqual(item.attempt, undefined);
    });

    test('1.3 Simulated SOCKS5 timeout and connection reset patterns in adapter.open()', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chall-net-timeout-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const c1 = path.join(tempDir, 'c1.json');
      fs.writeFileSync(c1, '{}');

      const notifications = [];
      const rotations = [];
      const mockApi = createMockTelegramApi(notifications);
      const mockVpn = createTrackingVpn(rotations);

      const store = new SqliteStore(dbPath, {
        items: [
          { id: 'post-timeout', state: 'pending', payload: { text: 'Timeout test' } }
        ],
        accounts: [
          { id: 'acc-timeout', username: 'timeout_user', userId: '333', enabled: true, cookieFile: c1, failures: 0 }
        ],
        cycle: { state: 'stopped', runId: null },
        settings: { dailyQuota: 10, delayMinSeconds: 1, delayMaxSeconds: 1 },
        posting: {}
      });
      await store.load();

      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async () => {
          // Open throws error matching socks proxy timeout pattern
          const err = new Error('socks5 connection timeout after 15000ms: connecterror');
          err.code = 'ETIMEDOUT';
          throw err;
        },
        publish: async () => {
          throw new Error('Unreachable');
        },
        close: async () => {}
      });

      await run({
        token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
        dataDir: tempDir, api: mockApi, vpnManager: mockVpn,
        maxPolls: 0, publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
        logger: { log: () => {}, error: () => {} },
        onRuntimeReady: async (ctx) => {
          await ctx.start({ stopAfterSuccess: false });
          await ctx.wait();
        }
      });

      const state = await store.load();
      const acc = state.accounts.find(a => a.id === 'acc-timeout');
      assert.strictEqual(acc.failures, 0, 'SOCKS5 timeout error must NOT increment failure strikes');
      assert.strictEqual(acc.enabled, true);
      assert.strictEqual(state.items.find(i => i.id === 'post-timeout').state, 'pending');
    });
  });

  // =========================================================================
  // SECTION 2: Pre-Dispatch Crash Recovery (recoverProcessing)
  // =========================================================================
  describe('2. Pre-Dispatch Crash Recovery in Queue.recoverProcessing', () => {

    test('2.1 Pure claimed phase resets to pending without loss across batch variations', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chall-crash-recover-'));
      const dbPath = path.join(tempDir, 'state.sqlite');

      const itemsToSeed = [];
      // 5 claimed items (pre-dispatch)
      for (let i = 1; i <= 5; i++) {
        itemsToSeed.push({
          id: `item-claimed-${i}`,
          state: 'processing',
          claimedAt: new Date().toISOString(),
          attempt: {
            phase: 'claimed',
            token: `token-claimed-${i}`,
            runId: 'run-alpha',
            accountId: `acc-${i}`
          },
          payload: { text: `Pre-dispatch message ${i}` }
        });
      }

      // 5 dispatching items (post-dispatch fence crossed)
      for (let i = 1; i <= 5; i++) {
        itemsToSeed.push({
          id: `item-dispatching-${i}`,
          state: 'processing',
          claimedAt: new Date().toISOString(),
          attempt: {
            phase: 'dispatching',
            token: `token-disp-${i}`,
            runId: 'run-alpha',
            accountId: `acc-disp-${i}`
          },
          payload: { text: `Dispatching message ${i}` }
        });
      }

      // 3 dispatch_started items (legacy / explicit state)
      for (let i = 1; i <= 3; i++) {
        itemsToSeed.push({
          id: `item-started-${i}`,
          state: 'dispatch_started',
          claimedAt: new Date().toISOString(),
          attempt: {
            token: `token-started-${i}`,
            runId: 'run-alpha',
            accountId: `acc-started-${i}`
          },
          payload: { text: `Started message ${i}` }
        });
      }

      // 2 already published items
      itemsToSeed.push({
        id: 'item-pub-1',
        state: 'published',
        publishedAt: new Date().toISOString(),
        url: 'https://x.com/user/status/9991'
      });
      itemsToSeed.push({
        id: 'item-pub-2',
        state: 'published',
        publishedAt: new Date().toISOString(),
        url: 'https://x.com/user/status/9992'
      });

      const store = new SqliteStore(dbPath, {
        items: itemsToSeed,
        accounts: []
      });
      await store.load();

      const queue = new Queue(store);
      await queue.recoverProcessing({ state: 'ambiguous', reason: 'daemon_sigkill_recovery' });

      const reloadedStore = new SqliteStore(dbPath);
      const state = await reloadedStore.load();

      // Verify all 5 claimed items reverted safely to pending
      for (let i = 1; i <= 5; i++) {
        const item = state.items.find(x => x.id === `item-claimed-${i}`);
        assert.strictEqual(item.state, 'pending', `item-claimed-${i} must be reset to pending`);
        assert.strictEqual(item.attempt, undefined, 'attempt token must be cleared');
        assert.strictEqual(item.claimedAt, undefined, 'claimedAt must be cleared');
        assert.strictEqual(item.outcome, undefined);
      }

      // Verify all 5 dispatching items quarantined as ambiguous with attribution
      for (let i = 1; i <= 5; i++) {
        const item = state.items.find(x => x.id === `item-dispatching-${i}`);
        assert.strictEqual(item.state, 'ambiguous', `item-dispatching-${i} must be ambiguous`);
        assert.strictEqual(item.outcome, 'ambiguous');
        assert.strictEqual(item.reason, 'daemon_sigkill_recovery');
        assert.strictEqual(item.accountId, `acc-disp-${i}`, 'accountId attribution preserved');
        assert.strictEqual(item.result?.attemptToken, `token-disp-${i}`, 'attemptToken attribution preserved');
        assert.ok(item.completedAt, 'completedAt timestamp set');
      }

      // Verify dispatch_started items quarantined as ambiguous
      for (let i = 1; i <= 3; i++) {
        const item = state.items.find(x => x.id === `item-started-${i}`);
        assert.strictEqual(item.state, 'ambiguous', `item-started-${i} must be ambiguous`);
        assert.strictEqual(item.reason, 'daemon_sigkill_recovery');
        assert.strictEqual(item.accountId, `acc-started-${i}`);
      }

      // Verify published items were completely untouched
      assert.strictEqual(state.items.find(x => x.id === 'item-pub-1').state, 'published');
      assert.strictEqual(state.items.find(x => x.id === 'item-pub-2').state, 'published');
    });

    test('2.2 Full reboot cycle: recovered pending items can immediately be published by fresh runner', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chall-crash-reboot-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const c1 = path.join(tempDir, 'c1.json');
      fs.writeFileSync(c1, '{}');

      const mockApi = createMockTelegramApi();

      // Seed a claimed item simulating a crash before dispatch
      const store = new SqliteStore(dbPath, {
        items: [
          {
            id: 'item-crash-recovered',
            state: 'processing',
            claimedAt: new Date().toISOString(),
            attempt: { phase: 'claimed', token: 'old-crash-token', runId: 'dead-run-id' },
            payload: { text: 'Survivor post' }
          }
        ],
        accounts: [
          { id: 'acc-reboot', username: 'reboot_user', userId: '555', enabled: true, cookieFile: c1, failures: 0 }
        ],
        cycle: { state: 'stopped', runId: null },
        settings: { dailyQuota: 10, delayMinSeconds: 1, delayMaxSeconds: 1 },
        posting: {}
      });
      await store.load();

      // 1. Simulate runner initialization crash recovery hook
      const queue = new Queue(store);
      await queue.recoverProcessing({ state: 'ambiguous', reason: 'reboot' });

      // Verify it is pending before launch
      let preLaunch = await store.load();
      assert.strictEqual(preLaunch.items[0].state, 'pending');

      // 2. Launch new runner cycle
      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async () => ({
          slot: 1,
          identity: { authenticated: true, username: 'reboot_user', userId: '555' }
        }),
        publish: async ({ onDispatch }) => {
          await onDispatch({ accountId: 'acc-reboot' });
          return { published: true, url: 'https://x.com/reboot_user/status/123456' };
        },
        close: async () => {}
      });

      await run({
        token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
        dataDir: tempDir, api: mockApi, vpnManager: createTrackingVpn(),
        maxPolls: 0, publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
        logger: { log: () => {}, error: () => {} },
        onRuntimeReady: async (ctx) => {
          await ctx.start({ stopAfterSuccess: true });
          await ctx.wait();
        }
      });

      // 3. Verify post was published successfully without being lost
      const finalState = await store.load();
      const item = finalState.items.find(x => x.id === 'item-crash-recovered');
      assert.strictEqual(item.state, 'published', 'Recovered item must publish successfully');
      assert.strictEqual(item.url, 'https://x.com/reboot_user/status/123456');
      assert.strictEqual(item.accountId, 'acc-reboot');
    });
  });

  // =========================================================================
  // SECTION 3: Pre-Dispatch Account Failure Immediate Post Transfer
  // =========================================================================
  describe('3. Pre-Dispatch Account Failure Multi-Account Transfer', () => {

    test('3.1 Cascading pre-dispatch failure: Account A fails -> Account B fails -> Account C publishes in same pass', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chall-cascade-transfer-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const c1 = path.join(tempDir, 'c1.json');
      const c2 = path.join(tempDir, 'c2.json');
      const c3 = path.join(tempDir, 'c3.json');
      fs.writeFileSync(c1, '{}');
      fs.writeFileSync(c2, '{}');
      fs.writeFileSync(c3, '{}');

      const notifications = [];
      const mockApi = createMockTelegramApi(notifications);

      const store = new SqliteStore(dbPath, {
        items: [
          { id: 'post-cascade', state: 'pending', payload: { text: 'Cascade test post' } }
        ],
        accounts: [
          { id: 'acc-a', username: 'user_a', userId: '101', enabled: true, cookieFile: c1, failures: 0 },
          { id: 'acc-b', username: 'user_b', userId: '102', enabled: true, cookieFile: c2, failures: 0 },
          { id: 'acc-c', username: 'user_c', userId: '103', enabled: true, cookieFile: c3, failures: 0 }
        ],
        cycle: { state: 'stopped', runId: null },
        settings: { dailyQuota: 10, delayMinSeconds: 1, delayMaxSeconds: 1 },
        posting: {}
      });
      await store.load();

      const accountAttempts = { 'acc-a': 0, 'acc-b': 0, 'acc-c': 0 };

      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async ({ account }) => {
          accountAttempts[account.id] = (accountAttempts[account.id] || 0) + 1;
          if (account.id === 'acc-a') {
            return {
              slot: 1,
              identity: { authenticated: false, accountFailure: 'cookie_expired', reason: 'cookies rejected' }
            };
          }
          if (account.id === 'acc-b') {
            return {
              slot: 2,
              identity: { authenticated: false, accountFailure: 'auth_rejected', reason: 'password reset' }
            };
          }
          return {
            slot: 3,
            identity: { authenticated: true, username: 'user_c', userId: '103' }
          };
        },
        publish: async ({ onDispatch }) => {
          await onDispatch({ accountId: 'acc-c' });
          return { published: true, url: 'https://x.com/user_c/status/987654' };
        },
        close: async () => {}
      });

      await run({
        token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
        dataDir: tempDir, api: mockApi, vpnManager: createTrackingVpn(),
        maxPolls: 0, publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
        logger: { log: () => {}, error: () => {} },
        onRuntimeReady: async (ctx) => {
          await ctx.start({ stopAfterSuccess: true });
          await ctx.wait();
        }
      });

      const state = await store.load();

      // Post was successfully published by acc-c in the very same pass!
      const item = state.items.find(x => x.id === 'post-cascade');
      assert.strictEqual(item.state, 'published');
      assert.strictEqual(item.accountId, 'acc-c');
      assert.strictEqual(item.accountUsername, 'user_c');
      assert.strictEqual(item.url, 'https://x.com/user_c/status/987654');

      // Failure strikes properly registered
      const accA = state.accounts.find(a => a.id === 'acc-a');
      const accB = state.accounts.find(a => a.id === 'acc-b');
      const accC = state.accounts.find(a => a.id === 'acc-c');
      assert.strictEqual(accA.failures, 1, 'Account A received strike 1');
      assert.strictEqual(accB.failures, 1, 'Account B received strike 1');
      assert.strictEqual(accC.failures, 0, 'Account C succeeded (0 failures)');

      // Verify attempts: A was called once, B was called once, C was called once
      assert.strictEqual(accountAttempts['acc-a'], 1);
      assert.strictEqual(accountAttempts['acc-b'], 1);
      assert.strictEqual(accountAttempts['acc-c'], 1);
    });

    test('3.2 Pre-dispatch account failure: immediate post transfer without post loss in single pass', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chall-transfer-singlepass-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const c1 = path.join(tempDir, 'c1.json');
      const c2 = path.join(tempDir, 'c2.json');
      fs.writeFileSync(c1, '{}');
      fs.writeFileSync(c2, '{}');

      const notifications = [];
      const mockApi = createMockTelegramApi(notifications);

      const store = new SqliteStore(dbPath, {
        items: [
          { id: 'post-transfer-immediate', state: 'pending', payload: { text: 'Immediate transfer post' } }
        ],
        accounts: [
          { id: 'acc-failing-1', username: 'fail_user_1', userId: '201', enabled: true, cookieFile: c1, failures: 0 },
          { id: 'acc-success-2', username: 'success_user_2', userId: '202', enabled: true, cookieFile: c2, failures: 0 }
        ],
        cycle: { state: 'stopped', runId: null },
        settings: { dailyQuota: 10, delayMinSeconds: 1, delayMaxSeconds: 1 },
        posting: {}
      });
      await store.load();

      let attemptsAcc1 = 0;
      let attemptsAcc2 = 0;

      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async ({ account }) => {
          if (account.id === 'acc-failing-1') {
            attemptsAcc1++;
            return {
              slot: 1,
              identity: { authenticated: false, accountFailure: 'cookie_expired', reason: 'cookies expired' }
            };
          }
          attemptsAcc2++;
          return {
            slot: 2,
            identity: { authenticated: true, username: 'success_user_2', userId: '202' }
          };
        },
        publish: async ({ onDispatch }) => {
          await onDispatch({ accountId: 'acc-success-2' });
          return { published: true, url: 'https://x.com/success_user_2/status/999888' };
        },
        close: async () => {}
      });

      await run({
        token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
        dataDir: tempDir, api: mockApi, vpnManager: createTrackingVpn(),
        maxPolls: 0, publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
        logger: { log: () => {}, error: () => {} },
        onRuntimeReady: async (ctx) => {
          await ctx.start({ stopAfterSuccess: true });
          await ctx.wait();
        }
      });

      const state = await store.load();
      // Post was transferred and published by acc-success-2
      const item = state.items.find(x => x.id === 'post-transfer-immediate');
      assert.strictEqual(item.state, 'published');
      assert.strictEqual(item.accountId, 'acc-success-2');
      assert.strictEqual(item.accountUsername, 'success_user_2');

      // acc-failing-1 received exactly 1 failure strike
      const acc1 = state.accounts.find(a => a.id === 'acc-failing-1');
      assert.strictEqual(acc1.failures, 1);
      assert.strictEqual(acc1.enabled, true);

      // acc-success-2 has 0 failures and 1 quota deduction
      const acc2 = state.accounts.find(a => a.id === 'acc-success-2');
      assert.strictEqual(acc2.failures, 0);

      assert.strictEqual(attemptsAcc1, 1);
      assert.strictEqual(attemptsAcc2, 1);
    });

    test('3.3 All accounts fail pre-dispatch: cycle halts gracefully, post preserved in pending state', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chall-all-fail-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const c1 = path.join(tempDir, 'c1.json');
      const c2 = path.join(tempDir, 'c2.json');
      fs.writeFileSync(c1, '{}');
      fs.writeFileSync(c2, '{}');

      const notifications = [];
      const mockApi = createMockTelegramApi(notifications);

      const store = new SqliteStore(dbPath, {
        items: [
          { id: 'post-all-fail', state: 'pending', payload: { text: 'All fail test post' } }
        ],
        accounts: [
          { id: 'acc-all-fail-1', username: 'all_fail_1', userId: '501', enabled: true, cookieFile: c1, failures: 0 },
          { id: 'acc-all-fail-2', username: 'all_fail_2', userId: '502', enabled: true, cookieFile: c2, failures: 0 }
        ],
        cycle: { state: 'stopped', runId: null },
        settings: { dailyQuota: 10, delayMinSeconds: 1, delayMaxSeconds: 1 },
        posting: {}
      });
      await store.load();

      let attemptsAcc1 = 0;
      let attemptsAcc2 = 0;

      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async ({ account }) => {
          if (account.id === 'acc-all-fail-1') {
            attemptsAcc1++;
            return {
              slot: 1,
              identity: { authenticated: false, accountFailure: 'cookie_expired', reason: 'cookies expired 1' }
            };
          }
          if (account.id === 'acc-all-fail-2') {
            attemptsAcc2++;
            return {
              slot: 2,
              identity: { authenticated: false, accountFailure: 'cookie_expired', reason: 'cookies expired 2' }
            };
          }
          return { slot: 3, identity: { authenticated: false } };
        },
        publish: async () => {
          throw new Error('Should not reach publish');
        },
        close: async () => {}
      });

      await run({
        token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
        dataDir: tempDir, api: mockApi, vpnManager: createTrackingVpn(),
        maxPolls: 0, publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
        logger: { log: () => {}, error: () => {} },
        onRuntimeReady: async (ctx) => {
          await ctx.start({ stopAfterSuccess: true });
          await ctx.wait();
        }
      });

      const state = await store.load();

      // Cycle must halt gracefully
      assert.strictEqual(state.cycle?.state, 'stopped');

      // Post must remain pending (not lost, not published, not ambiguous)
      const item = state.items.find(x => x.id === 'post-all-fail');
      assert.strictEqual(item.state, 'pending');

      // Both accounts must have received exactly 1 failure strike (distributed across natural cycles)
      const acc1 = state.accounts.find(a => a.id === 'acc-all-fail-1');
      const acc2 = state.accounts.find(a => a.id === 'acc-all-fail-2');
      assert.strictEqual(acc1.failures, 1);
      assert.strictEqual(acc2.failures, 1);
      assert.strictEqual(acc1.enabled, true);
      assert.strictEqual(acc2.enabled, true);

      // Verify each account was attempted once in this pass
      assert.strictEqual(attemptsAcc1, 1);
      assert.strictEqual(attemptsAcc2, 1);

      // Arabic suspension alert was sent
      const suspensionMsg = notifications.find(n =>
        (typeof n === 'string' ? n : n?.text)?.includes('جميع الحسابات غير مؤهلة أو في فترة انتظار؛ توقفت الدورة وبقيت المنشورات في الانتظار.')
      );
      assert.ok(suspensionMsg, 'Expected suspension notification to be sent when all accounts fail');
    });
  });

  // =========================================================================
  // SECTION 4: Concurrency, Fencing & Stale Attempt Token Integrity
  // =========================================================================
  describe('4. Concurrency & Attempt Token Fencing', () => {

    test('4.1 Stale onDispatch call with old attempt token is rejected (DISPATCH_REJECTED)', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chall-token-fence-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const c1 = path.join(tempDir, 'c1.json');
      fs.writeFileSync(c1, '{}');

      const mockApi = createMockTelegramApi();

      const store = new SqliteStore(dbPath, {
        items: [
          { id: 'post-fence', state: 'pending', payload: { text: 'Fence test' } }
        ],
        accounts: [
          { id: 'acc-fence', username: 'fence_user', userId: '301', enabled: true, cookieFile: c1, failures: 0 }
        ],
        cycle: { state: 'stopped', runId: null },
        settings: { dailyQuota: 10, delayMinSeconds: 1, delayMaxSeconds: 1 },
        posting: {}
      });
      await store.load();

      let capturedOnDispatch = null;

      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async () => ({
          slot: 1,
          identity: { authenticated: true, username: 'fence_user', userId: '301' }
        }),
        publish: async ({ onDispatch }) => {
          capturedOnDispatch = onDispatch;
          // First call succeeds
          await onDispatch({ accountId: 'acc-fence' });
          return { published: true, url: 'https://x.com/fence_user/status/112233' };
        },
        close: async () => {}
      });

      await run({
        token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
        dataDir: tempDir, api: mockApi, vpnManager: createTrackingVpn(),
        maxPolls: 0, publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
        logger: { log: () => {}, error: () => {} },
        onRuntimeReady: async (ctx) => {
          await ctx.start({ stopAfterSuccess: true });
          await ctx.wait();
        }
      });

      const state = await store.load();
      assert.strictEqual(state.items[0].state, 'published');

      // Attempting to invoke the captured onDispatch again MUST reject with DISPATCH_REJECTED code
      assert.ok(capturedOnDispatch, 'onDispatch callback was captured');
      await assert.rejects(
        () => capturedOnDispatch({ accountId: 'acc-fence' }),
        err => {
          assert.strictEqual(err.code, 'DISPATCH_REJECTED');
          assert.match(err.message, /DISPATCH_REJECTED/);
          return true;
        }
      );
    });

    test('4.2 Parallel SQLite state mutations do not corrupt attempt tokens or duplicate posts', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chall-parallel-sqlite-'));
      const dbPath = path.join(tempDir, 'state.sqlite');

      const store = new SqliteStore(dbPath, {
        items: [
          { id: 'parallel-item-1', state: 'pending', payload: { text: 'Concurrent post' } }
        ],
        accounts: [
          { id: 'acc-par-1', username: 'par_1', userId: '401', enabled: true, failures: 0 },
          { id: 'acc-par-2', username: 'par_2', userId: '402', enabled: true, failures: 0 }
        ]
      });
      await store.load();

      // Launch 10 simultaneous store.update operations trying to claim the same item
      const claimAttempts = await Promise.all(
        Array.from({ length: 10 }, async (_, idx) => {
          return store.update(s => {
            const item = s.items.find(i => i.id === 'parallel-item-1');
            if (item && item.state === 'pending') {
              item.state = 'processing';
              item.claimedAt = new Date().toISOString();
              item.attempt = {
                phase: 'claimed',
                token: `parallel-token-${idx}`,
                accountId: `acc-par-${(idx % 2) + 1}`
              };
              return s;
            }
            return s;
          }).then(s => {
            const item = s.items.find(i => i.id === 'parallel-item-1');
            return item?.attempt?.token === `parallel-token-${idx}`;
          });
        })
      );

      // Exactly ONE claim must have succeeded!
      const winningClaims = claimAttempts.filter(Boolean);
      assert.strictEqual(winningClaims.length, 1, 'Exactly one concurrent attempt must win claim');

      const finalState = await store.load();
      assert.strictEqual(finalState.items[0].state, 'processing');
      assert.ok(finalState.items[0].attempt?.token.startsWith('parallel-token-'));
    });
  });
});
