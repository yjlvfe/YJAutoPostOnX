'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const { run, SingleInstanceLock } = require(path.join(ROOT, 'src/runner'));
const { SqliteStore } = require(path.join(ROOT, 'src/sqliteStore'));
const { TelegramUi } = require(path.join(ROOT, 'src/telegramUi'));
const { VpnSlotManager } = require(path.join(ROOT, 'src/dockerVpn'));
const { riyadhDay, accountCapacity } = require(path.join(ROOT, 'src/quota'));

function createMockTelegramApi(notifications = []) {
  return {
    getMe: async () => ({ id: 1, is_bot: true, username: 'test_bot' }),
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
    answerCallbackQuery: async () => {},
    getUpdates: async () => [],
    sendDocument: async () => ({ message_id: 1 })
  };
}

function createMockTransport() {
  return {
    acknowledgeCallback: async () => {},
    sendMessage: async () => ({ message_id: 1 }),
    editMessageText: async () => ({ message_id: 1 }),
    keyboard: () => ({ keyboard: [], resize_keyboard: true })
  };
}

function createAdvancingClock(initialTime = Date.now()) {
  let current = initialTime;
  return {
    clock: () => new Date(current),
    sleepFn: async (ms) => { current += Math.max(1, ms || 1000); }
  };
}

describe('Challenger M2 Adversarial Suite: Dynamic Switching, VPN Slots & Quota Lifecycle', () => {

  // =========================================================================
  // CHALLENGE 1: Dynamic Account Switching During Active Run
  // =========================================================================
  describe('Challenge 1: Dynamic Account Switching During Active Run', () => {

    test('1.1 Toggling accounts during active run updates run.accountIds dynamically and replacement account publishes subsequent posts without cycle restart', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-m2-switch-'));
      const dbPath = path.join(tempDir, 'state.sqlite');

      const cAlpha = path.join(tempDir, 'alpha.json'); fs.writeFileSync(cAlpha, '{}');
      const cBeta = path.join(tempDir, 'beta.json'); fs.writeFileSync(cBeta, '{}');
      const cGamma = path.join(tempDir, 'gamma.json'); fs.writeFileSync(cGamma, '{}');

      const accounts = [
        { id: 'acc-alpha', username: 'alpha_user', userId: '1001', cookieFile: cAlpha, enabled: true, failures: 0, status: 'مفعل', quota: 1 },
        { id: 'acc-beta', username: 'beta_user', userId: '1002', cookieFile: cBeta, enabled: true, failures: 0, status: 'مفعل', quota: 1 },
        { id: 'acc-gamma', username: 'gamma_user', userId: '1003', cookieFile: cGamma, enabled: false, failures: 0, status: 'غير مفعل', quota: 2 }
      ];

      const items = [
        { id: 'post-1', state: 'pending', payload: { text: 'Message 1' } },
        { id: 'post-2', state: 'pending', payload: { text: 'Message 2' } },
        { id: 'post-3', state: 'pending', payload: { text: 'Message 3' } }
      ];

      const store = new SqliteStore(dbPath, {
        accounts,
        items,
        settings: { delayMinSeconds: 15, delayMaxSeconds: 30, dailyQuota: null },
        cycle: { state: 'stopped', runId: null }
      });
      await store.load();

      const publishedBy = [];
      let cycleRunId = null;
      let uiRef = null;
      let switched = false;

      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async ({ account }) => ({
          slot: 0,
          account,
          identity: {
            authenticated: true,
            username: account.username,
            userId: account.userId
          }
        }),
        publish: async ({ session, payload, onDispatch }) => {
          await onDispatch({ accountId: session.account.id });
          publishedBy.push({ text: payload?.text, accountId: session.account.id });

          // Trigger dynamic toggle right after the first post publishes on acc-alpha!
          if (payload?.text === 'Message 1' && !switched && uiRef) {
            switched = true;
            // Disable acc-beta
            await uiRef.accountToggle({
              parsed: { action: 'toggle', value: 'acc-beta' },
              acknowledge: async () => {}
            }, {
              callback_query: { id: 'cb-1', from: { id: 1 }, message: { chat: { id: 1 }, message_id: 10 } }
            });
            // Enable acc-gamma
            await uiRef.accountToggle({
              parsed: { action: 'toggle', value: 'acc-gamma' },
              acknowledge: async () => {}
            }, {
              callback_query: { id: 'cb-2', from: { id: 1 }, message: { chat: { id: 1 }, message_id: 10 } }
            });
          }

          return {
            published: true,
            url: `https://x.com/${session.identity.username}/status/${Date.now()}`
          };
        },
        close: async () => {}
      });

      const notifications = [];
      const mockApi = createMockTelegramApi(notifications);
      const timeManager = createAdvancingClock();

      await run({
        token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
        dataDir: tempDir, api: mockApi,
        clock: timeManager.clock,
        sleepFn: timeManager.sleepFn,
        vpnManager: {
          ensure: async () => ({ exitIp: '187.40.234.102', proxy: 'socks5h://127.0.0.1:18801' }),
          health: async () => ({ healthy: true, exitIp: '187.40.234.102' }),
          rotate: async () => ({ success: true }),
          release: async () => 0
        },
        maxPolls: 0, publishAdapterFactory, attemptTimeoutMs: 5000,
        logger: { log: () => {}, error: () => {} },
        onRuntimeReady: async (ctx) => {
          uiRef = ctx.ui;
          const startRes = await ctx.start({ stopAfterSuccess: false });
          cycleRunId = startRes.runId;
          await ctx.wait();
        }
      });

      const finalState = await store.load();

      // 1. All 3 posts must be published
      assert.strictEqual(publishedBy.length, 3, 'All 3 posts must be successfully published');
      assert.strictEqual(publishedBy[0].text, 'Message 1');
      assert.strictEqual(publishedBy[0].accountId, 'acc-alpha');

      // 2. post-2 must be published by acc-gamma (the dynamic replacement!), NOT acc-beta
      assert.strictEqual(publishedBy[1].text, 'Message 2');
      assert.strictEqual(publishedBy[1].accountId, 'acc-gamma', 'post-2 must be claimed and published by the replacement account acc-gamma');

      // 3. post-3 must be published by acc-gamma, but NEVER acc-beta
      assert.strictEqual(publishedBy[2].text, 'Message 3');
      assert.strictEqual(publishedBy[2].accountId, 'acc-gamma');
      assert.ok(!publishedBy.some(p => p.accountId === 'acc-beta'), 'acc-beta must NEVER publish any post after being disabled');

      // 4. Verification that cycle was NOT restarted (finalState runId matches initial runId)
      assert.strictEqual(finalState.telegramUi?.run?.runId, cycleRunId, 'Cycle runId must remain identical (no restart)');
      assert.deepStrictEqual(finalState.telegramUi?.run?.accountIds, ['acc-alpha', 'acc-gamma'], 'Active run accountIds must reflect dynamic replacement');
      assert.strictEqual(finalState.items.every(i => i.state === 'published'), true, 'All items must be in published state');
    });

    test('1.2 accountManage enable/disable actions dynamically modify activeRun.accountIds identically during active run', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-m2-manage-switch-'));
      const dbPath = path.join(tempDir, 'state.sqlite');

      const c1 = path.join(tempDir, '1.json'); fs.writeFileSync(c1, '{}');
      const c2 = path.join(tempDir, '2.json'); fs.writeFileSync(c2, '{}');
      const c3 = path.join(tempDir, '3.json'); fs.writeFileSync(c3, '{}');

      const accounts = [
        { id: 'acc-1', username: 'user_1', userId: '2001', cookieFile: c1, enabled: true, failures: 0, status: 'مفعل', quota: 1 },
        { id: 'acc-2', username: 'user_2', userId: '2002', cookieFile: c2, enabled: true, failures: 0, status: 'مفعل', quota: 1 },
        { id: 'acc-3', username: 'user_3', userId: '2003', cookieFile: c3, enabled: false, failures: 0, status: 'غير مفعل', quota: 2 }
      ];

      const items = [
        { id: 'p-1', state: 'pending', payload: { text: 'Item 1' } },
        { id: 'p-2', state: 'pending', payload: { text: 'Item 2' } }
      ];

      const store = new SqliteStore(dbPath, {
        accounts,
        items,
        settings: { delayMinSeconds: 15, delayMaxSeconds: 30, dailyQuota: null },
        cycle: { state: 'stopped', runId: null }
      });
      await store.load();

      const publishedAccounts = [];
      let uiRef = null;
      let switched = false;

      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async ({ account }) => ({
          slot: 0,
          account,
          identity: { authenticated: true, username: account.username, userId: account.userId }
        }),
        publish: async ({ session, payload, onDispatch }) => {
          await onDispatch({ accountId: session.account.id });
          publishedAccounts.push(session.account.id);

          if (!switched && uiRef) {
            switched = true;
            // Disable acc-2 via accountManage
            await uiRef.accountManage({
              parsed: { action: 'disable', value: 'acc-2' },
              acknowledge: async () => {}
            }, {
              callback_query: { id: 'cb-m1', from: { id: 1 }, message: { chat: { id: 1 }, message_id: 11 } }
            });
            // Enable acc-3 via accountManage
            await uiRef.accountManage({
              parsed: { action: 'enable', value: 'acc-3' },
              acknowledge: async () => {}
            }, {
              callback_query: { id: 'cb-m2', from: { id: 1 }, message: { chat: { id: 1 }, message_id: 12 } }
            });
          }

          return { published: true, url: `https://x.com/status/${Date.now()}` };
        },
        close: async () => {}
      });

      const mockApi = createMockTelegramApi([]);
      const timeManager = createAdvancingClock();

      await run({
        token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
        dataDir: tempDir, api: mockApi,
        clock: timeManager.clock,
        sleepFn: timeManager.sleepFn,
        vpnManager: {
          ensure: async () => ({ exitIp: '187.40.234.102', proxy: 'socks5h://127.0.0.1:18801' }),
          health: async () => ({ healthy: true, exitIp: '187.40.234.102' }),
          rotate: async () => ({ success: true }),
          release: async () => 0
        },
        maxPolls: 0, publishAdapterFactory, attemptTimeoutMs: 5000,
        logger: { log: () => {}, error: () => {} },
        onRuntimeReady: async (ctx) => {
          uiRef = ctx.ui;
          await ctx.start({ stopAfterSuccess: false });
          await ctx.wait();
        }
      });

      assert.strictEqual(publishedAccounts.length, 2);
      assert.strictEqual(publishedAccounts[0], 'acc-1');
      assert.strictEqual(publishedAccounts[1], 'acc-3', 'acc-3 enabled via accountManage must publish p-2');
      assert.ok(!publishedAccounts.includes('acc-2'), 'acc-2 disabled via accountManage must never publish');
    });
  });

  // =========================================================================
  // CHALLENGE 2: VPN Slot Release, 5-Slot Saturation & Deadlock Prevention
  // =========================================================================
  describe('Challenge 2: VPN Slot Release, 5-Slot Saturation & Deadlock Prevention', () => {

    test('2.1 Five active accounts saturate all 5 VPN slots; 6th account is cleanly blocked', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-m2-vpn-sat-'));
      const dbPath = path.join(tempDir, 'state.sqlite');

      const accounts = [
        { id: 'acc-1', username: 'u1', enabled: true, status: 'مفعل' },
        { id: 'acc-2', username: 'u2', enabled: true, status: 'مفعل' },
        { id: 'acc-3', username: 'u3', enabled: true, status: 'مفعل' },
        { id: 'acc-4', username: 'u4', enabled: true, status: 'مفعل' },
        { id: 'acc-5', username: 'u5', enabled: true, status: 'مفعل' },
        { id: 'acc-6', username: 'u6', enabled: false, status: 'غير مفعل' }
      ];

      const vpnSlots = {
        'acc-1': 0,
        'acc-2': 1,
        'acc-3': 2,
        'acc-4': 3,
        'acc-5': 4
      };

      const store = new SqliteStore(dbPath, { accounts, vpnSlots });
      await store.load();

      const vpnManager = new VpnSlotManager({ store });
      const ui = new TelegramUi({
        bot: { store, transport: createMockTransport(), vpnManager }
      });

      // Attempting to allocate slot for acc-6 directly must throw allocation error
      await assert.rejects(
        async () => { await vpnManager.allocate('acc-6'); },
        /All five VPN slots are allocated/
      );

      // Attempting to enable acc-6 via accountToggle must be rejected with limitExceeded
      let ackCalled = false;
      const resToggle = await ui.accountToggle({
        parsed: { action: 'toggle', value: 'acc-6' },
        acknowledge: async (msg, alert) => {
          ackCalled = true;
          assert.strictEqual(alert, true);
          assert.match(msg, /الحد الأقصى 5/);
        }
      }, {
        callback_query: { id: 'cb-sat', from: { id: 1 }, message: { chat: { id: 1 }, message_id: 20 } }
      });

      assert.strictEqual(resToggle.limitExceeded, true);
      assert.strictEqual(ackCalled, true);
    });

    test('2.2 Disabling an account releases its VPN slot and allows replacement account to claim the freed slot without error', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-m2-vpn-realloc-'));
      const dbPath = path.join(tempDir, 'state.sqlite');

      const accounts = [
        { id: 'acc-1', username: 'u1', enabled: true, status: 'مفعل' },
        { id: 'acc-2', username: 'u2', enabled: true, status: 'مفعل' },
        { id: 'acc-3', username: 'u3', enabled: true, status: 'مفعل' },
        { id: 'acc-4', username: 'u4', enabled: true, status: 'مفعل' },
        { id: 'acc-5', username: 'u5', enabled: true, status: 'مفعل' },
        { id: 'acc-6', username: 'u6', enabled: false, status: 'غير مفعل' }
      ];

      const vpnSlots = {
        'acc-1': 0,
        'acc-2': 1,
        'acc-3': 2,
        'acc-4': 3,
        'acc-5': 4
      };

      const store = new SqliteStore(dbPath, { accounts, vpnSlots });
      await store.load();

      const vpnManager = new VpnSlotManager({ store });
      const ui = new TelegramUi({
        bot: { store, transport: createMockTransport(), vpnManager }
      });

      // 1. Disable acc-3 (which held slot 2)
      const resDisable = await ui.accountToggle({
        parsed: { action: 'toggle', value: 'acc-3' }
      }, {
        callback_query: { id: 'cb-dis', from: { id: 1 }, message: { chat: { id: 1 }, message_id: 21 } }
      });
      assert.strictEqual(resDisable.toggled, false);

      const stateAfterDisable = await store.load();
      assert.strictEqual(Object.hasOwn(stateAfterDisable.vpnSlots, 'acc-3'), false, 'Slot mapping for acc-3 must be removed');
      assert.strictEqual(Object.keys(stateAfterDisable.vpnSlots).length, 4, 'Exactly 4 slots must remain allocated');

      // 2. Enable replacement account acc-6
      const resEnable = await ui.accountToggle({
        parsed: { action: 'toggle', value: 'acc-6' }
      }, {
        callback_query: { id: 'cb-en', from: { id: 1 }, message: { chat: { id: 1 }, message_id: 22 } }
      });
      assert.strictEqual(resEnable.toggled, true);

      // 3. Allocate slot for acc-6 through vpnManager
      const claimedSlot = await vpnManager.allocate('acc-6');
      assert.strictEqual(claimedSlot, 2, 'Freed slot 2 must be cleanly recycled and claimed by acc-6');

      const stateAfterRealloc = await store.load();
      assert.strictEqual(stateAfterRealloc.vpnSlots['acc-6'], 2);
      assert.strictEqual(Object.keys(stateAfterRealloc.vpnSlots).length, 5);

      // Verify slot mappings are completely valid and injective (no duplicate slots)
      const allocatedSlots = Object.values(stateAfterRealloc.vpnSlots);
      assert.strictEqual(new Set(allocatedSlots).size, 5, 'All 5 allocated slots must be distinct (injective)');
      assert.deepStrictEqual(allocatedSlots.sort(), [0, 1, 2, 3, 4]);
    });

    test('2.3 VpnSlotManager reconcile() cleans up stale slots of disabled accounts without throwing', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-m2-reconcile-'));
      const dbPath = path.join(tempDir, 'state.sqlite');

      const store = new SqliteStore(dbPath, {
        accounts: [
          { id: 'acc-active-1', enabled: true },
          { id: 'acc-active-2', enabled: true },
          { id: 'acc-offline-3', enabled: false }
        ],
        vpnSlots: {
          'acc-active-1': 0,
          'acc-active-2': 1,
          'acc-offline-3': 2
        }
      });
      await store.load();

      const mockRuntime = {
        destroyContainer: async (slot) => ({ removed: true, slot }),
        healthCheck: async () => ({ healthy: true })
      };

      const vpnManager = new VpnSlotManager({ store, runtime: mockRuntime });

      // Run reconciliation filtering for enabled accounts only
      const plan = await vpnManager.reconcile({
        accountIds: ['acc-active-1', 'acc-active-2'],
        dryRun: false
      });

      assert.strictEqual(plan.stale.length, 1);
      assert.strictEqual(plan.stale[0].accountId, 'acc-offline-3');
      assert.strictEqual(plan.stale[0].slot, 2);
      assert.strictEqual(plan.conflicts.length, 0);

      const stateAfter = await store.load();
      assert.strictEqual(Object.hasOwn(stateAfter.vpnSlots, 'acc-offline-3'), false);
      assert.strictEqual(stateAfter.vpnSlots['acc-active-1'], 0);
      assert.strictEqual(stateAfter.vpnSlots['acc-active-2'], 1);
    });
  });

  // =========================================================================
  // CHALLENGE 3: Quota Preservation & Strike Reset on Account Toggling
  // =========================================================================
  describe('Challenge 3: Quota Preservation & Strike Reset on Account Toggling', () => {

    test('3.1 Disabling an account preserves its daily quota intact', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-m2-quota-pres-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const today = riyadhDay(new Date());

      const store = new SqliteStore(dbPath, {
        accounts: [
          { id: 'acc-valuable', username: 'valuable_trader', enabled: true, failures: 2, status: 'مفعل', quota: 10 }
        ],
        posting: {
          quota: {
            [today]: {
              'acc-valuable': 4 // Already published 4 posts today
            }
          }
        }
      });
      await store.load();

      const ui = new TelegramUi({
        bot: { store, transport: createMockTransport() }
      });

      // Disable account
      await ui.accountToggle({
        parsed: { action: 'toggle', value: 'acc-valuable' }
      }, {
        callback_query: { id: 'cb-q1', from: { id: 1 }, message: { chat: { id: 1 }, message_id: 30 } }
      });

      const disabledState = await store.load();
      const disabledAcc = disabledState.accounts.find(a => a.id === 'acc-valuable');
      assert.strictEqual(disabledAcc.enabled, false);
      assert.strictEqual(disabledAcc.status, 'غير مفعل');

      // CRITICAL CHECK: Quota must NOT be wiped or reset!
      assert.strictEqual(
        disabledState.posting.quota[today]['acc-valuable'],
        4,
        'Daily quota MUST be preserved when an account is disabled'
      );
    });

    test('3.2 Re-enabling an account resets failures counter to 0 while preserving today\'s quota', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-m2-strike-reset-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const today = riyadhDay(new Date());

      const store = new SqliteStore(dbPath, {
        accounts: [
          { id: 'acc-recovered', username: 'recovered_bot', enabled: false, failures: 3, status: 'معزول (3 إخفاقات)', quota: 10 }
        ],
        posting: {
          quota: {
            [today]: {
              'acc-recovered': 3
            }
          },
          cooling: {
            'acc-recovered': { until: Date.now() + 60000 }
          }
        },
        telegramUi: {
          accountChecks: {
            'acc-recovered': { vpn: { healthy: false } }
          }
        }
      });
      await store.load();

      const ui = new TelegramUi({
        bot: { store, transport: createMockTransport() }
      });

      // Re-enable account via accountToggle
      await ui.accountToggle({
        parsed: { action: 'toggle', value: 'acc-recovered' }
      }, {
        callback_query: { id: 'cb-q2', from: { id: 1 }, message: { chat: { id: 1 }, message_id: 31 } }
      });

      const reenabledState = await store.load();
      const reenabledAcc = reenabledState.accounts.find(a => a.id === 'acc-recovered');

      // 1. Failures counter MUST be reset to 0
      assert.strictEqual(reenabledAcc.failures, 0, 'failures counter MUST be reset to 0 on operator re-enable');
      assert.strictEqual(reenabledAcc.enabled, true);
      assert.strictEqual(reenabledAcc.status, 'مفعل');

      // 2. Cooling and stale accountChecks must be cleared
      assert.strictEqual(reenabledState.posting?.cooling?.['acc-recovered'], undefined, 'Cooling entry must be cleared');
      assert.strictEqual(reenabledState.telegramUi?.accountChecks?.['acc-recovered'], undefined, 'Stale account checks cleared');

      // 3. Quota MUST remain intact
      assert.strictEqual(
        reenabledState.posting.quota[today]['acc-recovered'],
        3,
        'Daily quota MUST remain 3 (preserved, not reset)'
      );

      // 4. Remaining capacity must calculate accurately against preserved quota
      const capacity = accountCapacity(reenabledState, reenabledAcc, new Date());
      assert.strictEqual(capacity.used, 3);
      assert.strictEqual(capacity.limit, 10);
      assert.strictEqual(capacity.remaining, 7, 'Remaining capacity must be 10 - 3 = 7');
    });

    test('3.3 Subsequent post by re-enabled account increments quota from preserved baseline', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-m2-post-quota-inc-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const today = riyadhDay(new Date());

      const cW = path.join(tempDir, 'w.json'); fs.writeFileSync(cW, '{}');

      const store = new SqliteStore(dbPath, {
        accounts: [
          { id: 'acc-workhorse', username: 'workhorse_bot', userId: '3001', cookieFile: cW, enabled: true, failures: 0, status: 'مفعل' }
        ],
        items: [
          { id: 'post-inc-1', state: 'pending', payload: { text: 'Increment Test' } }
        ],
        settings: { delayMinSeconds: 15, delayMaxSeconds: 30, dailyQuota: 10 },
        posting: {
          quota: {
            [today]: {
              'acc-workhorse': 7 // Baseline: 7 posts already used
            }
          }
        }
      });
      await store.load();

      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async ({ account }) => ({
          slot: 0,
          identity: { authenticated: true, username: account.username, userId: account.userId }
        }),
        publish: async ({ session, onDispatch }) => {
          await onDispatch({ accountId: 'acc-workhorse' });
          return { published: true, url: 'https://x.com/status/123456789' };
        },
        close: async () => {}
      });

      const mockApi = createMockTelegramApi([]);
      const timeManager = createAdvancingClock();

      await run({
        token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
        dataDir: tempDir, api: mockApi,
        clock: timeManager.clock,
        sleepFn: timeManager.sleepFn,
        vpnManager: {
          ensure: async () => ({ exitIp: '187.40.234.102', proxy: 'socks5h://127.0.0.1:18801' }),
          health: async () => ({ healthy: true, exitIp: '187.40.234.102' }),
          rotate: async () => ({ success: true })
        },
        maxPolls: 0, publishAdapterFactory, attemptTimeoutMs: 5000,
        logger: { log: () => {}, error: () => {} },
        onRuntimeReady: async (ctx) => {
          await ctx.start({ stopAfterSuccess: true });
          await ctx.wait();
        }
      });

      const postPublishState = await store.load();
      // Quota must increment from 7 to 8
      assert.strictEqual(
        postPublishState.posting.quota[today]['acc-workhorse'],
        8,
        'Quota must increment strictly to 8 after 1 verified live post'
      );
      const capAfter = accountCapacity(postPublishState, postPublishState.accounts[0], new Date());
      assert.strictEqual(capAfter.remaining, 2, 'Remaining capacity must decrease from 3 to 2');
    });
  });

  // =========================================================================
  // CHALLENGE 4: Adversarial Concurrency & Boundary Conditions
  // =========================================================================
  describe('Challenge 4: Adversarial Concurrency & Boundary Conditions', () => {

    test('4.1 Cursor resets safely when the account at cursor index is disabled mid-run', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-m2-cursor-'));
      const dbPath = path.join(tempDir, 'state.sqlite');

      const accounts = [
        { id: 'acc-0', username: 'u0', enabled: true },
        { id: 'acc-1', username: 'u1', enabled: true },
        { id: 'acc-2', username: 'u2', enabled: true }
      ];

      const store = new SqliteStore(dbPath, {
        accounts,
        cycle: { state: 'running', runId: 'run-cursor' },
        telegramUi: {
          run: {
            runId: 'run-cursor',
            accountIds: ['acc-0', 'acc-1', 'acc-2'],
            cursor: 2 // Cursor is pointing at acc-2 (the last element)
          }
        }
      });
      await store.load();

      const ui = new TelegramUi({
        bot: { store, transport: createMockTransport() }
      });
      ui.activeRun = {
        runId: 'run-cursor',
        accountIds: ['acc-0', 'acc-1', 'acc-2'],
        cursor: 2
      };

      // Disable acc-2
      await ui.accountToggle({
        parsed: { action: 'toggle', value: 'acc-2' }
      }, {
        callback_query: { id: 'cb-cur', from: { id: 1 }, message: { chat: { id: 1 }, message_id: 40 } }
      });

      const stateAfter = await store.load();
      // After disabling acc-2, accountIds length is 2. Cursor 2 >= 2, so it MUST reset to 0!
      assert.deepStrictEqual(stateAfter.telegramUi.run.accountIds, ['acc-0', 'acc-1']);
      assert.strictEqual(stateAfter.telegramUi.run.cursor, 0, 'Cursor must reset to 0 to prevent out-of-bounds index');
      assert.strictEqual(ui.activeRun.cursor, 0);
    });

    test('4.2 Disabling all accounts mid-cycle halts runner cleanly with notification', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-m2-all-disable-'));
      const dbPath = path.join(tempDir, 'state.sqlite');

      const cSolo = path.join(tempDir, 'solo.json'); fs.writeFileSync(cSolo, '{}');

      const accounts = [
        { id: 'acc-solo', username: 'solo_user', userId: '4001', cookieFile: cSolo, enabled: true, failures: 0, status: 'مفعل' }
      ];

      const items = [
        { id: 'item-orphan-1', state: 'pending', payload: { text: 'Orphan 1' } },
        { id: 'item-orphan-2', state: 'pending', payload: { text: 'Orphan 2' } }
      ];

      const store = new SqliteStore(dbPath, {
        accounts,
        items,
        settings: { delayMinSeconds: 15, delayMaxSeconds: 30, dailyQuota: 10 },
        cycle: { state: 'stopped', runId: null }
      });
      await store.load();

      let uiRef = null;

      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async ({ account }) => ({
          slot: 0,
          identity: { authenticated: true, username: account.username, userId: account.userId }
        }),
        publish: async ({ session, item, onDispatch }) => {
          await onDispatch({ accountId: 'acc-solo' });

          // Disable all accounts mid-run!
          await uiRef.accountToggle({
            parsed: { action: 'all_disable', value: 'all' }
          }, {
            callback_query: { id: 'cb-all-dis', from: { id: 1 }, message: { chat: { id: 1 }, message_id: 45 } }
          });

          return { published: true, url: 'https://x.com/status/999' };
        },
        close: async () => {}
      });

      const notifications = [];
      const mockApi = createMockTelegramApi(notifications);
      const timeManager = createAdvancingClock();

      await run({
        token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
        dataDir: tempDir, api: mockApi,
        clock: timeManager.clock,
        sleepFn: timeManager.sleepFn,
        vpnManager: {
          ensure: async () => ({ exitIp: '187.40.234.102', proxy: 'socks5h://127.0.0.1:18801' }),
          health: async () => ({ healthy: true, exitIp: '187.40.234.102' }),
          rotate: async () => ({ success: true }),
          release: async () => 0
        },
        maxPolls: 0, publishAdapterFactory, attemptTimeoutMs: 5000,
        logger: { log: () => {}, error: () => {} },
        onRuntimeReady: async (ctx) => {
          uiRef = ctx.ui;
          await ctx.start({ stopAfterSuccess: false });
          await ctx.wait();
        }
      });

      const finalState = await store.load();
      // Item 1 published, Item 2 stayed pending because all accounts became disabled
      assert.strictEqual(finalState.items.find(i => i.id === 'item-orphan-1').state, 'published');
      assert.strictEqual(finalState.items.find(i => i.id === 'item-orphan-2').state, 'pending');
      assert.strictEqual(finalState.cycle.state, 'stopped', 'Cycle must stop cleanly without infinite looping');
    });

    test('4.3 Rapid interleaved toggle operations preserve 5-active ceiling and bijective slot mapping', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-m2-rapid-toggle-'));
      const dbPath = path.join(tempDir, 'state.sqlite');

      const accounts = Array.from({ length: 8 }, (_, i) => ({
        id: `acc-race-${i}`,
        username: `racer_${i}`,
        enabled: i < 5,
        status: i < 5 ? 'مفعل' : 'غير مفعل'
      }));

      const vpnSlots = {
        'acc-race-0': 0,
        'acc-race-1': 1,
        'acc-race-2': 2,
        'acc-race-3': 3,
        'acc-race-4': 4
      };

      const store = new SqliteStore(dbPath, { accounts, vpnSlots });
      await store.load();

      const vpnManager = new VpnSlotManager({ store });
      const ui = new TelegramUi({
        bot: { store, transport: createMockTransport(), vpnManager }
      });

      // Rapid sequence of disable and enable toggles
      // Disable 0 and 1
      await ui.accountToggle({ parsed: { action: 'toggle', value: 'acc-race-0' } }, { callback_query: { id: 'c1', from: { id: 1 }, message: { chat: { id: 1 } } } });
      await ui.accountToggle({ parsed: { action: 'toggle', value: 'acc-race-1' } }, { callback_query: { id: 'c2', from: { id: 1 }, message: { chat: { id: 1 } } } });

      // Enable 5 and 6
      await ui.accountToggle({ parsed: { action: 'toggle', value: 'acc-race-5' } }, { callback_query: { id: 'c3', from: { id: 1 }, message: { chat: { id: 1 } } } });
      await ui.accountToggle({ parsed: { action: 'toggle', value: 'acc-race-6' } }, { callback_query: { id: 'c4', from: { id: 1 }, message: { chat: { id: 1 } } } });

      // Try enabling 7 (must fail because 2, 3, 4, 5, 6 are already 5 active!)
      const overLimitRes = await ui.accountToggle({ parsed: { action: 'toggle', value: 'acc-race-7' } }, { callback_query: { id: 'c5', from: { id: 1 }, message: { chat: { id: 1 } } } });
      assert.strictEqual(overLimitRes.limitExceeded, true, '6th enabled account must be rejected');

      // Now allocate slots for 5 and 6
      const s5 = await vpnManager.allocate('acc-race-5');
      const s6 = await vpnManager.allocate('acc-race-6');

      const finalState = await store.load();
      const activeAccounts = finalState.accounts.filter(a => a.enabled !== false && a.status === 'مفعل');
      assert.strictEqual(activeAccounts.length, 5, 'Exactly 5 accounts must be active');

      const usedSlots = Object.values(finalState.vpnSlots);
      assert.strictEqual(usedSlots.length, 5);
      assert.strictEqual(new Set(usedSlots).size, 5, 'All slots must be unique (no duplicate slot collisions)');
      assert.ok(usedSlots.every(s => Number.isInteger(s) && s >= 0 && s < 5));
    });
  });
});
