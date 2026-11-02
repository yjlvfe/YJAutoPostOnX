'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const { run, SingleInstanceLock } = require(path.join(ROOT, 'src/runner'));
const { SqliteStore } = require(path.join(ROOT, 'src/sqliteStore'));
const { Queue } = require(path.join(ROOT, 'src/queue'));
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

function createAdvancingClock(initialTime = Date.now()) {
  let current = initialTime;
  return {
    clock: () => new Date(current),
    setTime: (newTime) => { current = newTime; },
    advance: (ms) => { current += ms; },
    sleepFn: async (ms) => { current += Math.max(1, ms || 1000); }
  };
}

describe('Milestone M3 Edge-Case Hardening Suite', () => {

  // =========================================================================
  // EDGE CASE 1: Crash Recovery for 'dispatch_started' and 'processing' Items
  // =========================================================================
  describe('1. Startup Crash Recovery: dispatch_started & processing Quarantine', () => {

    test('1.1 Queue.recoverProcessing directly recovers both processing AND dispatch_started items to ambiguous', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-crash-queue-'));
      const dbPath = path.join(tempDir, 'state.sqlite');

      const store = new SqliteStore(dbPath, {
        items: [
          {
            id: 'item-proc',
            state: 'processing',
            payload: { text: 'In flight processing post' },
            result: { attemptToken: 'token-proc-123', accountId: 'acc-1' }
          },
          {
            id: 'item-dispatch-started',
            state: 'dispatch_started',
            payload: { text: 'In transport dispatch started post' },
            result: { attemptToken: 'token-dispatch-456', accountId: 'acc-2', socketOpened: true }
          },
          {
            id: 'item-pending',
            state: 'pending',
            payload: { text: 'Pending post' }
          },
          {
            id: 'item-published',
            state: 'published',
            payload: { text: 'Published post' },
            result: { url: 'https://x.com/status/100' }
          }
        ],
        accounts: [],
        posting: { quota: {} }
      });
      await store.load();

      const queue = new Queue(store);
      await queue.recoverProcessing({ state: 'ambiguous', reason: 'startup_crash_recovery' });

      const state = await store.load();

      // Verify processing item recovered
      const procItem = state.items.find(x => x.id === 'item-proc');
      assert.strictEqual(procItem.state, 'ambiguous');
      assert.strictEqual(procItem.outcome, 'ambiguous');
      assert.strictEqual(procItem.reason, 'startup_crash_recovery');
      assert.strictEqual(procItem.result.reason, 'startup_crash_recovery');
      assert.strictEqual(procItem.result.attemptToken, 'token-proc-123', 'attemptToken preserved');
      assert.ok(typeof procItem.completedAt === 'string');

      // Verify dispatch_started item recovered
      const dispItem = state.items.find(x => x.id === 'item-dispatch-started');
      assert.strictEqual(dispItem.state, 'ambiguous');
      assert.strictEqual(dispItem.outcome, 'ambiguous');
      assert.strictEqual(dispItem.reason, 'startup_crash_recovery');
      assert.strictEqual(dispItem.result.reason, 'startup_crash_recovery');
      assert.strictEqual(dispItem.result.attemptToken, 'token-dispatch-456', 'attemptToken preserved');
      assert.strictEqual(dispItem.result.socketOpened, true, 'Custom metadata preserved');
      assert.ok(typeof dispItem.completedAt === 'string');

      // Verify pending and published items untouched
      const pendItem = state.items.find(x => x.id === 'item-pending');
      assert.strictEqual(pendItem.state, 'pending');
      assert.strictEqual(pendItem.outcome, undefined);

      const pubItem = state.items.find(x => x.id === 'item-published');
      assert.strictEqual(pubItem.state, 'published');
      assert.strictEqual(pubItem.result.url, 'https://x.com/status/100');

      // Verify 0 quota deducted
      assert.deepStrictEqual(state.posting.quota, {});
      await store.close();
    });

    test('1.2 Runner startup executes recoverProcessing across mixed batches of processing and dispatch_started', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-crash-runner-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const lockPath = path.join(tempDir, 'runner.lock');

      const store = new SqliteStore(dbPath, {
        items: [
          {
            id: 'crashed-item-1',
            state: 'dispatch_started',
            payload: { text: 'Crashed during socket transport write' },
            result: { attemptToken: 'tok-socket-999', accountId: 'acc-crash' }
          },
          {
            id: 'crashed-item-2',
            state: 'processing',
            payload: { text: 'Crashed before socket boundary' },
            result: { attemptToken: 'tok-proc-888', accountId: 'acc-crash' }
          }
        ],
        accounts: [
          { id: 'acc-crash', username: 'crash_user', enabled: true, failures: 0, status: 'مفعل', quota: 5 }
        ],
        posting: { quota: {} }
      });
      await store.load();
      await store.close();

      const notifications = [];
      const mockApi = createMockTelegramApi(notifications);

      await run({
        token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
        dataDir: tempDir, lockPath, api: mockApi,
        maxPolls: 1, pollMs: 10,
        logger: { log: () => {}, error: () => {} }
      });

      const verifyStore = new SqliteStore(dbPath);
      const state = await verifyStore.load();

      const item1 = state.items.find(x => x.id === 'crashed-item-1');
      assert.strictEqual(item1.state, 'ambiguous');
      assert.strictEqual(item1.outcome, 'ambiguous');
      assert.strictEqual(item1.reason, 'startup_crash_recovery');
      assert.strictEqual(item1.result.reason, 'startup_crash_recovery');
      assert.strictEqual(item1.result.attemptToken, 'tok-socket-999');
      assert.ok(typeof item1.completedAt === 'string');

      const item2 = state.items.find(x => x.id === 'crashed-item-2');
      assert.strictEqual(item2.state, 'ambiguous');
      assert.strictEqual(item2.outcome, 'ambiguous');
      assert.strictEqual(item2.reason, 'startup_crash_recovery');
      assert.strictEqual(item2.result.reason, 'startup_crash_recovery');
      assert.strictEqual(item2.result.attemptToken, 'tok-proc-888');
      assert.ok(typeof item2.completedAt === 'string');

      // Strict guarantee: 0 quota deduction for ambiguous crash recovery
      const today = riyadhDay();
      assert.strictEqual(state.posting?.quota?.[today]?.['acc-crash'] || 0, 0, 'Zero quota deducted on crash recovery');

      await verifyStore.close();
    });
  });

  // =========================================================================
  // EDGE CASE 2: Account Toggle Mid-Flight During Active Publishing Cycle
  // =========================================================================
  describe('2. Dynamic Account Switching Mid-Flight', () => {

    test('2.1 Toggling accounts during active cycle dynamically reallocates slots, preserves runId, zero post loss', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-midflight-toggle-'));
      const dbPath = path.join(tempDir, 'state.sqlite');

      const cA = path.join(tempDir, 'a.json'); fs.writeFileSync(cA, '{}');
      const cB = path.join(tempDir, 'b.json'); fs.writeFileSync(cB, '{}');
      const cC = path.join(tempDir, 'c.json'); fs.writeFileSync(cC, '{}');

      const accounts = [
        { id: 'acc-1', username: 'user_1', userId: '101', cookieFile: cA, enabled: true, failures: 0, status: 'مفعل', quota: 1 },
        { id: 'acc-2', username: 'user_2', userId: '102', cookieFile: cB, enabled: true, failures: 0, status: 'مفعل', quota: 1 },
        { id: 'acc-3', username: 'user_3', userId: '103', cookieFile: cC, enabled: false, failures: 0, status: 'غير مفعل', quota: 2 }
      ];

      const items = [
        { id: 'post-alpha', state: 'pending', payload: { text: 'Alpha message' } },
        { id: 'post-beta', state: 'pending', payload: { text: 'Beta message' } },
        { id: 'post-gamma', state: 'pending', payload: { text: 'Gamma message' } }
      ];

      const store = new SqliteStore(dbPath, {
        accounts,
        items,
        settings: { delayMinSeconds: 15, delayMaxSeconds: 30, dailyQuota: null },
        cycle: { state: 'stopped', runId: null }
      });
      await store.load();

      const publishedPosts = [];
      let initialRunId = null;
      let uiInstance = null;
      let toggleExecuted = false;
      const releasedSlots = [];

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
          publishedPosts.push({ text: payload.text, accountId: session.account.id });

          // Trigger dynamic toggle immediately after first post publishes
          if (payload.text === 'Alpha message' && !toggleExecuted && uiInstance) {
            toggleExecuted = true;

            // 1. Disable acc-2
            await uiInstance.accountToggle({
              parsed: { action: 'toggle', value: 'acc-2' },
              acknowledge: async () => {}
            }, {
              callback_query: { id: 'cb-t1', from: { id: 1 }, message: { chat: { id: 1 }, message_id: 10 } }
            });

            // 2. Enable acc-3
            await uiInstance.accountToggle({
              parsed: { action: 'toggle', value: 'acc-3' },
              acknowledge: async () => {}
            }, {
              callback_query: { id: 'cb-t2', from: { id: 1 }, message: { chat: { id: 1 }, message_id: 11 } }
            });
          }

          return {
            published: true,
            url: `https://x.com/${session.account.username}/status/${Date.now()}`
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
          release: async (accId) => { releasedSlots.push(accId); return 0; }
        },
        maxPolls: 0, publishAdapterFactory, attemptTimeoutMs: 5000,
        logger: { log: () => {}, error: () => {} },
        onRuntimeReady: async (ctx) => {
          uiInstance = ctx.ui;
          const startRes = await ctx.start({ stopAfterSuccess: false });
          initialRunId = startRes.runId;
          await ctx.wait();
        }
      });

      const finalState = await store.load();

      // Zero post loss: exactly 3 posts published
      assert.strictEqual(publishedPosts.length, 3, 'Zero post loss: all 3 posts published');

      // Post 1 published by acc-1
      assert.strictEqual(publishedPosts[0].text, 'Alpha message');
      assert.strictEqual(publishedPosts[0].accountId, 'acc-1');

      // Post 2 published by acc-3 (the replacement!), NOT disabled acc-2
      assert.strictEqual(publishedPosts[1].text, 'Beta message');
      assert.strictEqual(publishedPosts[1].accountId, 'acc-3', 'acc-3 claimed post-beta');

      // Post 3 published by active pool (acc-1 or acc-3), never acc-2
      assert.strictEqual(publishedPosts[2].text, 'Gamma message');
      assert.ok(['acc-1', 'acc-3'].includes(publishedPosts[2].accountId));
      assert.ok(!publishedPosts.some(p => p.accountId === 'acc-2'), 'Disabled acc-2 must NEVER publish');

      // Slot reallocation verified
      assert.ok(releasedSlots.includes('acc-2'), 'vpnSlots.release must be called when acc-2 is disabled');

      // Zero cycle reset: runId bit-for-bit unchanged
      assert.strictEqual(finalState.telegramUi?.run?.runId, initialRunId, 'Cycle runId must not be reset');
      assert.deepStrictEqual(finalState.telegramUi?.run?.accountIds, ['acc-1', 'acc-3'], 'Dynamic run accountIds updated');
      assert.strictEqual(finalState.items.every(i => i.state === 'published'), true);
    });
  });

  // =========================================================================
  // EDGE CASE 3: 3rd Strike Isolation Simultaneous with Empty Backup List
  // =========================================================================
  describe('3. 3rd Strike Isolation with Empty Backup List', () => {

    test('3.1 3rd strike on last remaining active account gracefully halts cycle with exactly ONE notification', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-3rd-strike-solo-'));
      const dbPath = path.join(tempDir, 'state.sqlite');

      const cookieFile = path.join(tempDir, 'solo.json');
      fs.writeFileSync(cookieFile, '{}');

      // Account already has 2 strikes! Next failure will be the 3rd strike.
      const accounts = [
        { id: 'acc-solo', username: 'solo_user', userId: '501', cookieFile, enabled: true, failures: 2, status: 'مفعل', quota: 5 }
      ];

      const items = [
        { id: 'post-solo', state: 'pending', payload: { text: 'Post for solo account' } }
      ];

      const store = new SqliteStore(dbPath, {
        accounts,
        items,
        settings: { delayMinSeconds: 15, delayMaxSeconds: 30 },
        cycle: { state: 'stopped', runId: null }
      });
      await store.load();

      let attemptsCount = 0;
      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async () => ({
          slot: 0,
          account: accounts[0],
          identity: { authenticated: true, username: 'solo_user', userId: '501' }
        }),
        publish: async () => {
          attemptsCount++;
          // Fail before dispatch boundary (pre-dispatch failure)
          const err = new Error('Session cookie rejected by X');
          err.accountFailure = 'cookie_expired';
          throw err;
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
          await ctx.start({ stopAfterSuccess: false });
          await ctx.wait();
        }
      });

      const finalState = await store.load();

      // Account must be isolated with 3 failures
      const acc = finalState.accounts.find(a => a.id === 'acc-solo');
      assert.strictEqual(acc.failures, 3, 'Failures must reach exactly 3');
      assert.strictEqual(acc.enabled, false, 'Account must be disabled');
      assert.strictEqual(acc.status, 'معزول (3 إخفاقات)', 'Status must be isolated');

      // Zero active accounts remain
      const activeCount = finalState.accounts.filter(a => a.enabled !== false).length;
      assert.strictEqual(activeCount, 0, 'Zero active accounts remaining');

      // Item was pre-dispatch: must remain in pending state without corruption or unconfirmed publish
      const item = finalState.items.find(i => i.id === 'post-solo');
      assert.strictEqual(item.state, 'pending', 'Pre-dispatch failure post must be safely pending for future retry');

      // Exactly ONE isolation notification must be dispatched
      const isolationAlerts = notifications.filter(n => n.includes('تم عزل الحساب') && n.includes('solo_user'));
      assert.strictEqual(isolationAlerts.length, 1, 'Exactly one isolation alert must be sent');
      assert.ok(isolationAlerts[0].includes('لا توجد حسابات مؤهلة متبقية؛ توقفت الدورة'));

      // Cycle cleanly stopped
      assert.strictEqual(finalState.cycle?.state, 'stopped', 'Cycle must be stopped');
    });
  });

  // =========================================================================
  // EDGE CASE 4: Midnight Date Rollover Quota Accounting
  // =========================================================================
  describe('4. Midnight Date Rollover Quota Accounting', () => {

    test('4.1 Publishing across Riyadh midnight boundary transitions quota keys seamlessly without debiting previous day', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-midnight-quota-'));
      const dbPath = path.join(tempDir, 'state.sqlite');

      const cookieFile = path.join(tempDir, 'user.json');
      fs.writeFileSync(cookieFile, '{}');

      const accounts = [
        { id: 'acc-daily', username: 'daily_user', userId: '701', cookieFile, enabled: true, failures: 0, status: 'مفعل', quota: 5 }
      ];

      const items = [
        { id: 'post-day1', state: 'pending', payload: { text: 'Day 1 Post at 23:59:50' } },
        { id: 'post-day2', state: 'pending', payload: { text: 'Day 2 Post at 00:00:20' } }
      ];

      // Initial state: Start 10 seconds before midnight Riyadh time on 2026-11-02
      // Riyadh is UTC+3. 2026-11-02 23:59:50 Riyadh = 2026-11-02 20:59:50 UTC
      const timeBeforeMidnight = new Date('2026-11-02T20:59:50.000Z').getTime();
      const timeManager = createAdvancingClock(timeBeforeMidnight);

      const day1Str = riyadhDay(timeManager.clock());
      assert.strictEqual(day1Str, '2026-11-02', 'Day before midnight must be 2026-11-02');

      const store = new SqliteStore(dbPath, {
        accounts,
        items,
        settings: { delayMinSeconds: 15, delayMaxSeconds: 30, dailyQuota: null },
        posting: { quota: {} },
        cycle: { state: 'stopped', runId: null }
      });
      await store.load();

      let postIndex = 0;
      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async () => ({
          slot: 0,
          account: accounts[0],
          identity: { authenticated: true, username: 'daily_user', userId: '701' }
        }),
        publish: async ({ onDispatch }) => {
          postIndex++;
          await onDispatch({ accountId: 'acc-daily' });

          if (postIndex === 1) {
            // First post publishes before midnight
            return {
              published: true,
              url: `https://x.com/daily_user/status/10001`
            };
          } else {
            // Advance clock across midnight!
            // 2026-11-03 00:00:20 Riyadh = 2026-11-02 21:00:20 UTC (advance 30 seconds)
            timeManager.setTime(new Date('2026-11-02T21:00:20.000Z').getTime());
            return {
              published: true,
              url: `https://x.com/daily_user/status/10002`
            };
          }
        },
        close: async () => {}
      });

      const notifications = [];
      const mockApi = createMockTelegramApi(notifications);

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
          await ctx.start({ stopAfterSuccess: false });
          await ctx.wait();
        }
      });

      const finalState = await store.load();

      // Check quota table in SQLite
      const day2Str = riyadhDay(timeManager.clock());
      assert.strictEqual(day2Str, '2026-11-03', 'Day after rollover must be 2026-11-03');

      // Verify Day 1 quota is preserved intact
      assert.strictEqual(
        finalState.posting.quota['2026-11-02']?.['acc-daily'],
        1,
        'Day 1 quota must be exactly 1'
      );

      // Verify Day 2 quota is recorded independently
      assert.strictEqual(
        finalState.posting.quota['2026-11-03']?.['acc-daily'],
        1,
        'Day 2 quota must be exactly 1'
      );

      // Verify capacity calculation reflects Day 2 capacity
      const capacityDay2 = accountCapacity(finalState, accounts[0], timeManager.clock());
      assert.strictEqual(capacityDay2.day, '2026-11-03');
      assert.strictEqual(capacityDay2.used, 1);
      assert.strictEqual(capacityDay2.remaining, 4);

      // Both posts confirmed published
      assert.strictEqual(finalState.items.every(i => i.state === 'published'), true);
    });
  });

});
