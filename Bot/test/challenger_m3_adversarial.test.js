'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const { run, SingleInstanceLock } = require(path.join(ROOT, 'src/runner'));
const { SqliteStore } = require(path.join(ROOT, 'src/sqliteStore'));
const { Queue } = require(path.join(ROOT, 'src/queue'));
const { riyadhDay, accountCapacity } = require(path.join(ROOT, 'src/quota'));
const {
  createDockerRuntime,
  slotPort,
  containerName,
  MAX_SLOTS
} = require(path.join(ROOT, 'src/dockerVpn'));
const { isPublicIp } = require(path.join(ROOT, 'src/publicIp'));

const KNOWN_HOST_SERVER_IP = '64.112.42.39';

const IP_SERVICES = [
  'https://api.ipify.org',
  'https://icanhazip.com',
  'https://ifconfig.me/ip'
];

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

function curlCommand(args, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const proc = spawn('curl', args);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`curl timed out after ${timeoutMs}ms: curl ${args.join(' ')}`));
    }, timeoutMs);

    proc.stdout.on('data', chunk => { stdout += chunk; });
    proc.stderr.on('data', chunk => { stderr += chunk; });
    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`curl exited with code ${code}: ${stderr.trim()}`));
    });
    proc.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function probeSocks5ExitIp(port, retries = 2) {
  for (const service of IP_SERVICES) {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const out = await curlCommand([
          '--noproxy', '',
          '--socks5-hostname', `127.0.0.1:${port}`,
          '--ipv4',
          '--fail',
          '--max-time', '8',
          '--silent',
          service
        ]);
        const ip = out.trim();
        if (isPublicIp(ip)) {
          return ip;
        }
      } catch {}
    }
  }
  throw new Error(`Failed to retrieve public IP through SOCKS5 proxy on port ${port}`);
}

describe('Empirical Adversarial Challenge Suite: Milestone M3 Verification', () => {

  // =========================================================================
  // CHALLENGE 1: High-Volume Mixed-Batch Crash Recovery & Idempotency
  // =========================================================================
  describe('Challenge 1: High-Volume Mixed-Batch Crash Recovery & Invariant Quarantine', () => {

    test('1.1 Quarantines 30 in-flight items across dispatch_started and processing with zero quota and leaves 30 other items untouched', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-crash-recovery-'));
      const dbPath = path.join(tempDir, 'state.sqlite');

      const items = [];
      // 15 items in dispatch_started
      for (let i = 1; i <= 15; i++) {
        items.push({
          id: `disp-${i}`,
          state: 'dispatch_started',
          payload: { text: `Dispatch started payload ${i}` },
          result: { attemptToken: `token-disp-${i}`, socketOpened: true, accountId: `acc-${(i % 3) + 1}` }
        });
      }
      // 15 items in processing
      for (let i = 1; i <= 15; i++) {
        items.push({
          id: `proc-${i}`,
          state: 'processing',
          claimedAt: new Date(Date.now() - i * 1000).toISOString(),
          payload: { text: `Processing payload ${i}` },
          result: { attemptToken: `token-proc-${i}`, accountId: `acc-${(i % 3) + 1}`, customMeta: `meta-${i}` }
        });
      }
      // 10 items in pending
      for (let i = 1; i <= 10; i++) {
        items.push({
          id: `pend-${i}`,
          state: 'pending',
          payload: { text: `Pending payload ${i}` }
        });
      }
      // 5 items in published
      for (let i = 1; i <= 5; i++) {
        items.push({
          id: `pub-${i}`,
          state: 'published',
          payload: { text: `Published payload ${i}` },
          result: { url: `https://x.com/user/status/${1000 + i}` }
        });
      }
      // 5 items in failed
      for (let i = 1; i <= 5; i++) {
        items.push({
          id: `fail-${i}`,
          state: 'failed',
          payload: { text: `Failed payload ${i}` },
          error: `Network timeout ${i}`
        });
      }
      // 5 items in ambiguous (pre-existing historical ambiguous items)
      for (let i = 1; i <= 5; i++) {
        items.push({
          id: `ambig-${i}`,
          state: 'ambiguous',
          outcome: 'ambiguous',
          reason: 'unresolved_in_finally',
          payload: { text: `Historical ambiguous payload ${i}` },
          result: { reason: 'unresolved_in_finally' }
        });
      }
      // 5 items in cancelled
      for (let i = 1; i <= 5; i++) {
        items.push({
          id: `canc-${i}`,
          state: 'cancelled',
          reason: 'queue_replaced',
          payload: { text: `Cancelled payload ${i}` }
        });
      }

      assert.strictEqual(items.length, 60, 'Total injected items must be exactly 60');

      const store = new SqliteStore(dbPath, {
        items,
        accounts: [
          { id: 'acc-1', username: 'u1', enabled: true, failures: 0, status: 'مفعل', quota: 5 },
          { id: 'acc-2', username: 'u2', enabled: true, failures: 0, status: 'مفعل', quota: 5 },
          { id: 'acc-3', username: 'u3', enabled: true, failures: 0, status: 'مفعل', quota: 5 }
        ],
        posting: { quota: {} }
      });
      await store.load();

      const queue = new Queue(store);
      // Run recovery
      await queue.recoverProcessing({ state: 'ambiguous', reason: 'startup_crash_recovery' });

      const stateAfterFirst = await store.load();

      // Check all 15 dispatch_started items
      for (let i = 1; i <= 15; i++) {
        const item = stateAfterFirst.items.find(x => x.id === `disp-${i}`);
        assert.ok(item, `disp-${i} must exist`);
        assert.strictEqual(item.state, 'ambiguous');
        assert.strictEqual(item.outcome, 'ambiguous');
        assert.strictEqual(item.reason, 'startup_crash_recovery');
        assert.strictEqual(item.result?.reason, 'startup_crash_recovery');
        assert.strictEqual(item.result?.attemptToken, `token-disp-${i}`, 'attemptToken preserved');
        assert.strictEqual(item.result?.socketOpened, true, 'socketOpened flag preserved');
        assert.ok(typeof item.completedAt === 'string', 'completedAt must be ISO string');
      }

      // Check all 15 processing items
      for (let i = 1; i <= 15; i++) {
        const item = stateAfterFirst.items.find(x => x.id === `proc-${i}`);
        assert.ok(item, `proc-${i} must exist`);
        assert.strictEqual(item.state, 'ambiguous');
        assert.strictEqual(item.outcome, 'ambiguous');
        assert.strictEqual(item.reason, 'startup_crash_recovery');
        assert.strictEqual(item.result?.reason, 'startup_crash_recovery');
        assert.strictEqual(item.result?.attemptToken, `token-proc-${i}`, 'attemptToken preserved');
        assert.strictEqual(item.result?.customMeta, `meta-${i}`, 'customMeta preserved');
        assert.ok(typeof item.completedAt === 'string', 'completedAt must be ISO string');
      }

      // Check all 10 pending items are completely untouched
      for (let i = 1; i <= 10; i++) {
        const item = stateAfterFirst.items.find(x => x.id === `pend-${i}`);
        assert.strictEqual(item.state, 'pending');
        assert.strictEqual(item.outcome, undefined);
        assert.strictEqual(item.reason, undefined);
      }

      // Check all 5 published items
      for (let i = 1; i <= 5; i++) {
        const item = stateAfterFirst.items.find(x => x.id === `pub-${i}`);
        assert.strictEqual(item.state, 'published');
        assert.strictEqual(item.result?.url, `https://x.com/user/status/${1000 + i}`);
      }

      // Check all 5 failed items
      for (let i = 1; i <= 5; i++) {
        const item = stateAfterFirst.items.find(x => x.id === `fail-${i}`);
        assert.strictEqual(item.state, 'failed');
        assert.strictEqual(item.error, `Network timeout ${i}`);
      }

      // Check all 5 historical ambiguous items (must NOT have reason overwritten)
      for (let i = 1; i <= 5; i++) {
        const item = stateAfterFirst.items.find(x => x.id === `ambig-${i}`);
        assert.strictEqual(item.state, 'ambiguous');
        assert.strictEqual(item.reason, 'unresolved_in_finally', 'Historical reason must NOT be overwritten');
        assert.strictEqual(item.result?.reason, 'unresolved_in_finally');
      }

      // Check all 5 cancelled items
      for (let i = 1; i <= 5; i++) {
        const item = stateAfterFirst.items.find(x => x.id === `canc-${i}`);
        assert.strictEqual(item.state, 'cancelled');
        assert.strictEqual(item.reason, 'queue_replaced');
      }

      // Check Quota: STRICT 0 quota consumed
      assert.deepStrictEqual(stateAfterFirst.posting.quota, {}, 'Zero quota debited on recovery');

      // Idempotency: Run recoverProcessing a second time
      await queue.recoverProcessing({ state: 'ambiguous', reason: 'startup_crash_recovery' });
      const stateAfterSecond = await store.load();

      assert.strictEqual(stateAfterSecond.items.length, 60);
      assert.deepStrictEqual(stateAfterSecond.posting.quota, {});

      await store.close();
    });

    test('1.2 Runner startup executes crash recovery across mixed crash items and verifies 0 quota in runner cycle', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-runner-crash-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const lockPath = path.join(tempDir, 'runner.lock');

      const store = new SqliteStore(dbPath, {
        items: [
          {
            id: 'crash-disp-alpha',
            state: 'dispatch_started',
            payload: { text: 'Socket open during SIGKILL' },
            result: { attemptToken: 'tok-kill-1', accountId: 'acc-runner-crash' }
          },
          {
            id: 'crash-proc-beta',
            state: 'processing',
            payload: { text: 'Worker claimed item before OOM' },
            result: { attemptToken: 'tok-kill-2', accountId: 'acc-runner-crash' }
          },
          {
            id: 'normal-pending',
            state: 'pending',
            payload: { text: 'Normal pending item' }
          }
        ],
        accounts: [
          { id: 'acc-runner-crash', username: 'crash_bot_user', enabled: true, failures: 0, status: 'مفعل', quota: 10 }
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

      const item1 = state.items.find(x => x.id === 'crash-disp-alpha');
      assert.strictEqual(item1.state, 'ambiguous');
      assert.strictEqual(item1.outcome, 'ambiguous');
      assert.strictEqual(item1.reason, 'startup_crash_recovery');
      assert.strictEqual(item1.result?.reason, 'startup_crash_recovery');
      assert.strictEqual(item1.result?.attemptToken, 'tok-kill-1');

      const item2 = state.items.find(x => x.id === 'crash-proc-beta');
      assert.strictEqual(item2.state, 'ambiguous');
      assert.strictEqual(item2.outcome, 'ambiguous');
      assert.strictEqual(item2.reason, 'startup_crash_recovery');
      assert.strictEqual(item2.result?.reason, 'startup_crash_recovery');
      assert.strictEqual(item2.result?.attemptToken, 'tok-kill-2');

      const item3 = state.items.find(x => x.id === 'normal-pending');
      assert.strictEqual(item3.state, 'pending');

      const today = riyadhDay();
      assert.strictEqual(state.posting?.quota?.[today]?.['acc-runner-crash'] || 0, 0);

      await verifyStore.close();
    });
  });

  // =========================================================================
  // CHALLENGE 2: Rapid Concurrent Account Switching Under Network Delays
  // =========================================================================
  describe('Challenge 2: Rapid Concurrent Account Switching Under Network Delays', () => {

    test('2.1 Multi-toggle barrage during publishing maintains runId immutability, zero lost items, slot reallocation', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-toggle-barrage-'));
      const dbPath = path.join(tempDir, 'state.sqlite');

      const cA = path.join(tempDir, 'a.json'); fs.writeFileSync(cA, '{}');
      const cB = path.join(tempDir, 'b.json'); fs.writeFileSync(cB, '{}');
      const cC = path.join(tempDir, 'c.json'); fs.writeFileSync(cC, '{}');
      const cD = path.join(tempDir, 'd.json'); fs.writeFileSync(cD, '{}');
      const cE = path.join(tempDir, 'e.json'); fs.writeFileSync(cE, '{}');

      const accounts = [
        { id: 'acc-1', username: 'user_1', userId: '101', cookieFile: cA, enabled: true, failures: 0, status: 'مفعل', quota: 5 },
        { id: 'acc-2', username: 'user_2', userId: '102', cookieFile: cB, enabled: true, failures: 0, status: 'مفعل', quota: 5 },
        { id: 'acc-3', username: 'user_3', userId: '103', cookieFile: cC, enabled: false, failures: 0, status: 'غير مفعل', quota: 5 },
        { id: 'acc-4', username: 'user_4', userId: '104', cookieFile: cD, enabled: false, failures: 0, status: 'غير مفعل', quota: 5 },
        { id: 'acc-5', username: 'user_5', userId: '105', cookieFile: cE, enabled: false, failures: 0, status: 'غير مفعل', quota: 5 }
      ];

      const items = [];
      for (let i = 1; i <= 6; i++) {
        items.push({ id: `msg-${i}`, state: 'pending', payload: { text: `Message payload #${i}` } });
      }

      const store = new SqliteStore(dbPath, {
        accounts,
        items,
        settings: { delayMinSeconds: 15, delayMaxSeconds: 30, dailyQuota: null },
        cycle: { state: 'stopped', runId: null }
      });
      await store.load();

      const publishedLog = [];
      const releasedSlots = [];
      let initialRunId = null;
      let uiInstance = null;
      let toggleStep = 0;

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

          // Simulate network delay during publish
          await new Promise(r => setTimeout(r, 20));

          publishedLog.push({ text: payload.text, accountId: session.account.id });

          // Execute barrage of toggles as posts progress
          if (payload.text === 'Message payload #1' && toggleStep === 0 && uiInstance) {
            toggleStep = 1;
            // Barrage 1: Disable acc-2, Enable acc-3
            await uiInstance.accountToggle({
              parsed: { action: 'toggle', value: 'acc-2' },
              acknowledge: async () => {}
            }, { callback_query: { id: 'cb-1', from: { id: 1 }, message: { chat: { id: 1 }, message_id: 1 } } });

            await uiInstance.accountToggle({
              parsed: { action: 'toggle', value: 'acc-3' },
              acknowledge: async () => {}
            }, { callback_query: { id: 'cb-2', from: { id: 1 }, message: { chat: { id: 1 }, message_id: 2 } } });
          }

          if (payload.text === 'Message payload #2' && toggleStep === 1 && uiInstance) {
            toggleStep = 2;
            // Barrage 2: Disable acc-1, Enable acc-4 and acc-5
            await uiInstance.accountToggle({
              parsed: { action: 'toggle', value: 'acc-1' },
              acknowledge: async () => {}
            }, { callback_query: { id: 'cb-3', from: { id: 1 }, message: { chat: { id: 1 }, message_id: 3 } } });

            await uiInstance.accountToggle({
              parsed: { action: 'toggle', value: 'acc-4' },
              acknowledge: async () => {}
            }, { callback_query: { id: 'cb-4', from: { id: 1 }, message: { chat: { id: 1 }, message_id: 4 } } });

            await uiInstance.accountToggle({
              parsed: { action: 'toggle', value: 'acc-5' },
              acknowledge: async () => {}
            }, { callback_query: { id: 'cb-5', from: { id: 1 }, message: { chat: { id: 1 }, message_id: 5 } } });
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

      // Zero post loss: All 6 posts published
      assert.strictEqual(publishedLog.length, 6, 'All 6 posts must be successfully published');

      // Slot releases verified for disabled accounts
      assert.ok(releasedSlots.includes('acc-2'), 'vpnSlots.release called for acc-2');
      assert.ok(releasedSlots.includes('acc-1'), 'vpnSlots.release called for acc-1');

      // Zero cycle reset: runId bit-for-bit immutable
      assert.strictEqual(finalState.telegramUi?.run?.runId, initialRunId, 'runId must remain strictly immutable');

      // Dynamic accountIds updated in active run
      // At the end, acc-3, acc-4, acc-5 are the active enabled accounts
      const activeIds = finalState.telegramUi?.run?.accountIds || [];
      assert.ok(activeIds.includes('acc-3'));
      assert.ok(activeIds.includes('acc-4'));
      assert.ok(activeIds.includes('acc-5'));
      assert.ok(!activeIds.includes('acc-1'));
      assert.ok(!activeIds.includes('acc-2'));

      // Check posts after toggle step 2 were published ONLY by active accounts (acc-3, acc-4, acc-5)
      for (let i = 2; i < publishedLog.length; i++) {
        const post = publishedLog[i];
        assert.ok(
          ['acc-3', 'acc-4', 'acc-5'].includes(post.accountId),
          `Post ${post.text} published by ${post.accountId} which should be active, not disabled`
        );
      }

      assert.strictEqual(finalState.items.every(i => i.state === 'published'), true);
    });
  });

  // =========================================================================
  // CHALLENGE 3: Multi-Account 3-Strikes Cascading Isolation & Clean Halt
  // =========================================================================
  describe('Challenge 3: Multi-Account 3-Strikes Cascading Isolation & Clean Halt', () => {

    test('3.1 Cascading failure across all 3 active accounts isolates each with 1 notification, halts cycle with zero runaway spin', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-cascading-strikes-'));
      const dbPath = path.join(tempDir, 'state.sqlite');

      const cA = path.join(tempDir, 'a.json'); fs.writeFileSync(cA, '{}');
      const cB = path.join(tempDir, 'b.json'); fs.writeFileSync(cB, '{}');
      const cC = path.join(tempDir, 'c.json'); fs.writeFileSync(cC, '{}');

      // 3 accounts, each already having 2 failures!
      const accounts = [
        { id: 'acc-fail-1', username: 'user_f1', userId: '201', cookieFile: cA, enabled: true, failures: 2, status: 'مفعل', quota: 5 },
        { id: 'acc-fail-2', username: 'user_f2', userId: '202', cookieFile: cB, enabled: true, failures: 2, status: 'مفعل', quota: 5 },
        { id: 'acc-fail-3', username: 'user_f3', userId: '203', cookieFile: cC, enabled: true, failures: 2, status: 'مفعل', quota: 5 }
      ];

      const items = [
        { id: 'item-unprocessed-1', state: 'pending', payload: { text: 'Item for cascade test 1' } },
        { id: 'item-unprocessed-2', state: 'pending', payload: { text: 'Item for cascade test 2' } }
      ];

      const store = new SqliteStore(dbPath, {
        accounts,
        items,
        settings: { delayMinSeconds: 15, delayMaxSeconds: 30 },
        cycle: { state: 'stopped', runId: null }
      });
      await store.load();

      let publishCallCount = 0;
      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async ({ account }) => ({
          slot: 0,
          account,
          identity: {
            authenticated: false,
            accountFailure: 'cookie_expired',
            reason: 'Cookie session rejected'
          }
        }),
        publish: async () => {
          publishCallCount++;
          throw new Error('Should not reach publish with unauthenticated identity');
        },
        close: async () => {}
      });

      const notifications = [];
      const mockApi = createMockTelegramApi(notifications);
      const timeManager = createAdvancingClock();

      const startTime = Date.now();
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
      const elapsedTime = Date.now() - startTime;

      // Ensure execution halted quickly without runaway loop
      assert.ok(elapsedTime < 5000, `Execution must halt promptly without runaway spin (took ${elapsedTime}ms)`);

      const finalState = await store.load();

      // All 3 accounts must be isolated with failures = 3
      for (const id of ['acc-fail-1', 'acc-fail-2', 'acc-fail-3']) {
        const acc = finalState.accounts.find(a => a.id === id);
        assert.ok(acc, `${id} must exist`);
        assert.strictEqual(acc.failures, 3, `${id} failures must reach exactly 3`);
        assert.strictEqual(acc.enabled, false, `${id} must be disabled`);
        assert.strictEqual(acc.status, 'معزول (3 إخفاقات)', `${id} status must be isolated`);
      }

      // Check notification counts
      // Exactly 3 isolation notifications (one per account)
      const f1Alerts = notifications.filter(n => n.includes('user_f1') && n.includes('تم عزل الحساب'));
      const f2Alerts = notifications.filter(n => n.includes('user_f2') && n.includes('تم عزل الحساب'));
      const f3Alerts = notifications.filter(n => n.includes('user_f3') && n.includes('تم عزل الحساب'));
      assert.strictEqual(f1Alerts.length, 1, 'Exactly 1 isolation alert for user_f1');
      assert.strictEqual(f2Alerts.length, 1, 'Exactly 1 isolation alert for user_f2');
      assert.strictEqual(f3Alerts.length, 1, 'Exactly 1 isolation alert for user_f3');

      // Exactly 1 cycle halt alert when the final account was isolated
      const haltAlerts = notifications.filter(n => n.includes('لا توجد حسابات مؤهلة متبقية؛ توقفت الدورة'));
      assert.strictEqual(haltAlerts.length, 1, 'Exactly 1 cycle halt alert');

      // Cycle cleanly stopped
      assert.strictEqual(finalState.cycle?.state, 'stopped');

      // Items remain safely in pending state, unpinned, zero dropped
      for (const id of ['item-unprocessed-1', 'item-unprocessed-2']) {
        const item = finalState.items.find(i => i.id === id);
        assert.strictEqual(item.state, 'pending', `${id} must remain pending for future retry`);
        assert.strictEqual(item.attempt, undefined, `${id} attempt must be cleaned up`);
      }
    });
  });

  // =========================================================================
  // CHALLENGE 4: Multi-Day Calendar Date Rollover & PRAGMA WAL Atomic Persistence
  // =========================================================================
  describe('Challenge 4: Multi-Day Calendar Rollover & PRAGMA WAL Durability', () => {

    test('4.1 Multi-account publishing across 3 calendar days persists separate atomic quota records in SQLite WAL', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-multi-day-wal-'));
      const dbPath = path.join(tempDir, 'state.sqlite');

      const cA = path.join(tempDir, 'uA.json'); fs.writeFileSync(cA, '{}');
      const cB = path.join(tempDir, 'uB.json'); fs.writeFileSync(cB, '{}');

      const accounts = [
        { id: 'acc-A', username: 'user_A', userId: '301', cookieFile: cA, enabled: true, failures: 0, status: 'مفعل', quota: 5 },
        { id: 'acc-B', username: 'user_B', userId: '302', cookieFile: cB, enabled: true, failures: 0, status: 'مفعل', quota: 5 }
      ];

      const items = [
        { id: 'post-day1-a', state: 'pending', payload: { text: 'Day 1 Post A' } },
        { id: 'post-day1-b', state: 'pending', payload: { text: 'Day 1 Post B' } },
        { id: 'post-day2-a', state: 'pending', payload: { text: 'Day 2 Post A' } },
        { id: 'post-day2-b', state: 'pending', payload: { text: 'Day 2 Post B' } },
        { id: 'post-day3-a', state: 'pending', payload: { text: 'Day 3 Post A' } },
        { id: 'post-day3-b', state: 'pending', payload: { text: 'Day 3 Post B' } }
      ];

      // Start at Day 1: 2026-11-02 23:59:10 Riyadh (= 2026-11-02 20:59:10 UTC)
      // Leaving 50s before midnight so both post-day1-a and post-day1-b (with 15s delay) publish before midnight!
      const day1Utc = new Date('2026-11-02T20:59:10.000Z').getTime();
      const timeManager = createAdvancingClock(day1Utc);

      const store = new SqliteStore(dbPath, {
        accounts,
        items,
        settings: { delayMinSeconds: 15, delayMaxSeconds: 15, dailyQuota: null },
        posting: { quota: {} },
        cycle: { state: 'stopped', runId: null }
      });
      await store.load();

      let postCount = 0;
      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async ({ account }) => ({
          slot: 0,
          account,
          identity: { authenticated: true, username: account.username, userId: account.userId }
        }),
        publish: async ({ session, onDispatch }) => {
          postCount++;
          // Advance clock at the START of post 3 (to Day 2: 23:59:10 + rollover) and post 5 (to Day 3)
          if (postCount === 3) {
            // Advance to Day 2: 2026-11-03 23:59:10 Riyadh (= 2026-11-03 20:59:10 UTC)
            timeManager.setTime(new Date('2026-11-03T20:59:10.000Z').getTime());
          } else if (postCount === 5) {
            // Advance to Day 3: 2026-11-04 23:59:10 Riyadh (= 2026-11-04 20:59:10 UTC)
            timeManager.setTime(new Date('2026-11-04T20:59:10.000Z').getTime());
          }

          await onDispatch({ accountId: session.account.id });

          return {
            published: true,
            url: `https://x.com/${session.account.username}/status/${Date.now()}`
          };
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

      // Verify directly with raw DatabaseSync to check SQLite WAL mode and atomic persistence
      const rawDb = new DatabaseSync(dbPath);
      const journalMode = rawDb.prepare('PRAGMA journal_mode').get().journal_mode;
      assert.strictEqual(journalMode.toLowerCase(), 'wal', 'SQLite must operate in WAL journal mode');

      // Verify state through SqliteStore
      const verifyStore = new SqliteStore(dbPath);
      const state = await verifyStore.load();

      // Check all 6 posts published
      assert.strictEqual(state.items.every(i => i.state === 'published'), true);

      // Verify quotas are separated across all 3 days
      const q = state.posting.quota;
      assert.ok(q['2026-11-02'], 'Quota for 2026-11-02 must exist');
      assert.ok(q['2026-11-03'], 'Quota for 2026-11-03 must exist');
      assert.ok(q['2026-11-04'], 'Quota for 2026-11-04 must exist');

      // Day 1 had 2 posts (posts 1 and 2)
      const day1Total = Object.values(q['2026-11-02']).reduce((a, b) => a + b, 0);
      assert.strictEqual(day1Total, 2, 'Day 1 total quota must be exactly 2');

      // Day 2 had 2 posts (posts 3 and 4)
      const day2Total = Object.values(q['2026-11-03']).reduce((a, b) => a + b, 0);
      assert.strictEqual(day2Total, 2, 'Day 2 total quota must be exactly 2');

      // Day 3 had 2 posts (posts 5 and 6)
      const day3Total = Object.values(q['2026-11-04']).reduce((a, b) => a + b, 0);
      assert.strictEqual(day3Total, 2, 'Day 3 total quota must be exactly 2');

      // Total quota across all days must equal 6
      assert.strictEqual(day1Total + day2Total + day3Total, 6);

      rawDb.close();
      await verifyStore.close();
    });
  });

  // =========================================================================
  // CHALLENGE 5: Live Docker VPN Burst Stress & Zero Host IP Leak Gate
  // =========================================================================
  describe('Challenge 5: Live Docker VPN Burst Stress & Host IP Leak Gate', () => {
    const runtime = createDockerRuntime();

    test('5.1 All 5 Docker VPN containers exist, are running, healthy, owned, compatible', async () => {
      for (let slot = 0; slot < MAX_SLOTS; slot++) {
        const status = await runtime.containerStatus(slot);
        const name = containerName(slot);

        assert.strictEqual(status.exists, true, `Container ${name} must exist`);
        assert.strictEqual(status.running, true, `Container ${name} must be running`);
        assert.strictEqual(status.healthy, true, `Container ${name} must be healthy`);
        assert.strictEqual(status.healthStatus, 'healthy');
        assert.strictEqual(status.owned, true, `Container ${name} must have owner label`);
        assert.strictEqual(status.compatible, true, `Container ${name} must be compatible`);
      }
    });

    test('5.2 Parallel burst probes across all 5 SOCKS5 ports yield pairwise distinct IPs with zero host IP leak', async () => {
      // Fire 15 parallel probes across all 5 slots (3 parallel probes per slot simultaneously)
      const probePromises = [];

      for (let slot = 0; slot < MAX_SLOTS; slot++) {
        const port = slotPort(slot);
        for (let probeIdx = 0; probeIdx < 3; probeIdx++) {
          probePromises.push(
            probeSocks5ExitIp(port).then(exitIp => ({ slot, port, probeIdx, exitIp }))
          );
        }
      }

      const results = await Promise.all(probePromises);
      assert.strictEqual(results.length, 15, 'All 15 parallel burst probes must resolve');

      // Verify zero host IP leak on every single probe
      for (const res of results) {
        assert.ok(isPublicIp(res.exitIp), `Port ${res.port} returned valid public IP ${res.exitIp}`);
        assert.notStrictEqual(
          res.exitIp,
          KNOWN_HOST_SERVER_IP,
          `CRITICAL HOST LEAK DETECTED: Port ${res.port} probe #${res.probeIdx} leaked VPS host IP ${KNOWN_HOST_SERVER_IP}!`
        );
      }

      // Collect unique exit IP per slot
      const slotExitIps = new Map();
      for (const res of results) {
        if (!slotExitIps.has(res.slot)) {
          slotExitIps.set(res.slot, res.exitIp);
        } else {
          // Verify that probes for the same slot return the identical exit IP
          assert.strictEqual(
            res.exitIp,
            slotExitIps.get(res.slot),
            `Slot ${res.slot} exit IP must be stable across burst probes`
          );
        }
      }

      // Assert exactly 5 pairwise distinct exit IPs across the 5 slots
      const distinctIps = new Set(slotExitIps.values());
      assert.strictEqual(
        distinctIps.size,
        MAX_SLOTS,
        `All 5 slots must return pairwise distinct exit IPs! Observed: ${[...slotExitIps.values()].join(', ')}`
      );
    });

    test('5.3 dockerVpn runtime healthCheck returns verified exitIp and healthy status for all 5 slots', async () => {
      for (let slot = 0; slot < MAX_SLOTS; slot++) {
        const check = await runtime.healthCheck(slot);
        assert.strictEqual(check.healthy, true, `Slot ${slot} healthCheck must be healthy`);
        assert.ok(isPublicIp(check.exitIp), `Slot ${slot} exitIp (${check.exitIp}) must be valid public IPv4`);
        assert.notStrictEqual(
          check.exitIp,
          KNOWN_HOST_SERVER_IP,
          `Slot ${slot} exitIp must NOT match host server IP ${KNOWN_HOST_SERVER_IP}`
        );
        assert.strictEqual(check.port, slotPort(slot));
        assert.strictEqual(check.name, containerName(slot));
      }
    });

  });

});
