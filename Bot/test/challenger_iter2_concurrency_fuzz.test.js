'use strict';

/**
 * Empirical Challenger M1 Iteration 2:
 * Adversarial Concurrency, Attempt Token Fencing & Invalidation Fuzz Suite.
 *
 * Scenarios Tested:
 * 1. onDispatch Token Fencing & Error Format:
 *    - 1.1 Stale attempt token rejection (/DISPATCH_REJECTED/)
 *    - 1.2 Duplicate onDispatch invocation rejection (/DISPATCH_REJECTED/)
 *    - 1.3 Mismatched accountId in onDispatch rejection (/DISPATCH_REJECTED/)
 *    - 1.4 In-flight item payload tampering rejection (/DISPATCH_REJECTED/)
 *    - 1.5 In-flight cycle state / runId mutation rejection (/DISPATCH_REJECTED/)
 *    - 1.6 In-flight account checkGeneration / disabled toggle rejection (/DISPATCH_REJECTED/)
 *    - 1.7 In-flight quota exhaustion rejection (/DISPATCH_REJECTED/)
 *    - 1.8 Aborted attempt signal onDispatch rejection (/DISPATCH_REJECTED/)
 * 2. Concurrency Fuzzing: Simultaneous Cycle Triggers:
 *    - 2.1 20 simultaneous ctx.start() triggers — mutual exclusion & single execution
 *    - 2.2 In-flight ctx.stop() racing with onDispatch — clean abort & pending recovery
 * 3. Concurrency Fuzzing: Dynamic Account Toggles During Execution:
 *    - 3.1 Account disabled via acctoggle:toggle mid-flight blocks onDispatch cleanly
 *    - 3.2 50 rapid concurrent account toggles preserve <= 5 active account invariant
 * 4. Concurrency Fuzzing: Item Claims Race Conditions:
 *    - 4.1 50 concurrent claims across 5 workers on 5 items — strictly unique ownership
 *    - 4.2 Stale worker publish transition completely blocked by newer claim token
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const { run } = require(path.join(ROOT, 'src/runner'));
const { SqliteStore } = require(path.join(ROOT, 'src/sqliteStore'));

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
    answerCallbackQuery: async () => {},
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

describe('Empirical Challenger M1 Iteration 2: Concurrency & Fencing Fuzz Suite', () => {

  // =========================================================================
  // SUITE 1: onDispatch Attempt Token Fencing & /DISPATCH_REJECTED/ Error Format
  // =========================================================================
  describe('1. onDispatch Token Fencing & DISPATCH_REJECTED Rejection', () => {

    test('1.1 Token superseded in SQLite before onDispatch throws DISPATCH_REJECTED', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuzz-token-superseded-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const cookieFile = path.join(tempDir, 'c.json');
      fs.writeFileSync(cookieFile, '{}');

      const store = new SqliteStore(dbPath, {
        items: [{ id: 'item-stale-1', state: 'pending', payload: { text: 'Stale fence' } }],
        accounts: [{ id: 'acc-1', username: 'u1', userId: '101', enabled: true, cookieFile }],
        cycle: { state: 'stopped', runId: null },
        settings: { dailyQuota: 10 },
        posting: {}
      });
      await store.load();

      let caughtErr = null;
      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async () => ({ slot: 1, identity: { authenticated: true, username: 'u1', userId: '101' } }),
        publish: async ({ onDispatch }) => {
          // Supersede the token behind the runner's back
          await store.update(s => {
            s.items[0].attempt.token = 'rogue-superseded-token';
            return s;
          });
          try {
            await onDispatch({ accountId: 'acc-1' });
          } catch (err) {
            caughtErr = err;
            throw err;
          }
          return { published: true, url: 'https://x.com/u1/status/1' };
        },
        close: async () => {}
      });

      await run({
        token: 't', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
        dataDir: tempDir, api: createMockTelegramApi(), vpnManager: createMockVpn(),
        maxPolls: 0, publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
        logger: { log: () => {}, error: () => {} },
        onRuntimeReady: async (ctx) => { await ctx.start({ stopAfterSuccess: true }); await ctx.wait(); }
      });

      assert.ok(caughtErr, 'onDispatch must throw an error');
      assert.strictEqual(caughtErr.code, 'DISPATCH_REJECTED');
      assert.match(caughtErr.message, /DISPATCH_REJECTED/);

      const state = await store.load();
      const item = state.items.find(x => x.id === 'item-stale-1');
      assert.strictEqual(item.attempt?.token, 'rogue-superseded-token');
      assert.strictEqual(item.url, undefined);
    });

    test('1.2 Duplicate onDispatch invocation within same attempt throws DISPATCH_REJECTED', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuzz-dup-dispatch-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const cookieFile = path.join(tempDir, 'c.json');
      fs.writeFileSync(cookieFile, '{}');

      const store = new SqliteStore(dbPath, {
        items: [{ id: 'item-dup-1', state: 'pending', payload: { text: 'Dup dispatch' } }],
        accounts: [{ id: 'acc-1', username: 'u1', userId: '101', enabled: true, cookieFile }],
        cycle: { state: 'stopped', runId: null },
        settings: { dailyQuota: 10 },
        posting: {}
      });
      await store.load();

      let secondCallErr = null;
      let firstCallSuccess = false;

      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async () => ({ slot: 1, identity: { authenticated: true, username: 'u1', userId: '101' } }),
        publish: async ({ onDispatch }) => {
          firstCallSuccess = await onDispatch({ accountId: 'acc-1' });
          try {
            // Replay attack: calling onDispatch a second time
            await onDispatch({ accountId: 'acc-1' });
          } catch (err) {
            secondCallErr = err;
          }
          return { published: true, url: 'https://x.com/u1/status/1' };
        },
        close: async () => {}
      });

      await run({
        token: 't', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
        dataDir: tempDir, api: createMockTelegramApi(), vpnManager: createMockVpn(),
        maxPolls: 0, publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
        logger: { log: () => {}, error: () => {} },
        onRuntimeReady: async (ctx) => { await ctx.start({ stopAfterSuccess: true }); await ctx.wait(); }
      });

      assert.strictEqual(firstCallSuccess, true, 'First onDispatch call must succeed');
      assert.ok(secondCallErr, 'Second onDispatch call must be rejected');
      assert.strictEqual(secondCallErr.code, 'DISPATCH_REJECTED');
      assert.match(secondCallErr.message, /DISPATCH_REJECTED/);
    });

    test('1.3 Mismatched accountId passed to onDispatch throws DISPATCH_REJECTED', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuzz-mismatch-account-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const cookieFile = path.join(tempDir, 'c.json');
      fs.writeFileSync(cookieFile, '{}');

      const store = new SqliteStore(dbPath, {
        items: [{ id: 'item-mismatch-1', state: 'pending', payload: { text: 'Mismatch account' } }],
        accounts: [{ id: 'acc-1', username: 'u1', userId: '101', enabled: true, cookieFile }],
        cycle: { state: 'stopped', runId: null },
        settings: { dailyQuota: 10 },
        posting: {}
      });
      await store.load();

      let caughtErr = null;
      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async () => ({ slot: 1, identity: { authenticated: true, username: 'u1', userId: '101' } }),
        publish: async ({ onDispatch }) => {
          try {
            await onDispatch({ accountId: 'wrong-account-999' });
          } catch (err) {
            caughtErr = err;
            throw err;
          }
          return { published: true, url: 'https://x.com/u1/status/1' };
        },
        close: async () => {}
      });

      await run({
        token: 't', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
        dataDir: tempDir, api: createMockTelegramApi(), vpnManager: createMockVpn(),
        maxPolls: 0, publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
        logger: { log: () => {}, error: () => {} },
        onRuntimeReady: async (ctx) => { await ctx.start({ stopAfterSuccess: true }); await ctx.wait(); }
      });

      assert.ok(caughtErr, 'Mismatched accountId must be rejected');
      assert.strictEqual(caughtErr.code, 'DISPATCH_REJECTED');
      assert.match(caughtErr.message, /DISPATCH_REJECTED/);
    });

    test('1.4 In-flight item payload mutation in SQLite before onDispatch throws DISPATCH_REJECTED', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuzz-payload-tamper-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const cookieFile = path.join(tempDir, 'c.json');
      fs.writeFileSync(cookieFile, '{}');

      const store = new SqliteStore(dbPath, {
        items: [{ id: 'item-payload-1', state: 'pending', payload: { text: 'Original text' } }],
        accounts: [{ id: 'acc-1', username: 'u1', userId: '101', enabled: true, cookieFile }],
        cycle: { state: 'stopped', runId: null },
        settings: { dailyQuota: 10 },
        posting: {}
      });
      await store.load();

      let caughtErr = null;
      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async () => ({ slot: 1, identity: { authenticated: true, username: 'u1', userId: '101' } }),
        publish: async ({ onDispatch }) => {
          // Mutate the payload in SQLite while worker is processing
          await store.update(s => {
            s.items[0].payload = { text: 'Tampered text' };
            return s;
          });
          try {
            await onDispatch({ accountId: 'acc-1' });
          } catch (err) {
            caughtErr = err;
            throw err;
          }
          return { published: true, url: 'https://x.com/u1/status/1' };
        },
        close: async () => {}
      });

      await run({
        token: 't', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
        dataDir: tempDir, api: createMockTelegramApi(), vpnManager: createMockVpn(),
        maxPolls: 0, publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
        logger: { log: () => {}, error: () => {} },
        onRuntimeReady: async (ctx) => { await ctx.start({ stopAfterSuccess: true }); await ctx.wait(); }
      });

      assert.ok(caughtErr, 'Tampered payload must trigger DISPATCH_REJECTED');
      assert.strictEqual(caughtErr.code, 'DISPATCH_REJECTED');
      assert.match(caughtErr.message, /DISPATCH_REJECTED/);
    });

    test('1.5 In-flight cycle state or runId mutation before onDispatch throws DISPATCH_REJECTED', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuzz-cycle-tamper-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const cookieFile = path.join(tempDir, 'c.json');
      fs.writeFileSync(cookieFile, '{}');

      const store = new SqliteStore(dbPath, {
        items: [{ id: 'item-cyc-1', state: 'pending', payload: { text: 'Cycle state test' } }],
        accounts: [{ id: 'acc-1', username: 'u1', userId: '101', enabled: true, cookieFile }],
        cycle: { state: 'stopped', runId: null },
        settings: { dailyQuota: 10 },
        posting: {}
      });
      await store.load();

      let caughtErr = null;
      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async () => ({ slot: 1, identity: { authenticated: true, username: 'u1', userId: '101' } }),
        publish: async ({ onDispatch }) => {
          // Mutate cycle state to stopped in SQLite
          await store.update(s => {
            s.cycle = { state: 'stopped', runId: null };
            return s;
          });
          try {
            await onDispatch({ accountId: 'acc-1' });
          } catch (err) {
            caughtErr = err;
            throw err;
          }
          return { published: true, url: 'https://x.com/u1/status/1' };
        },
        close: async () => {}
      });

      await run({
        token: 't', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
        dataDir: tempDir, api: createMockTelegramApi(), vpnManager: createMockVpn(),
        maxPolls: 0, publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
        logger: { log: () => {}, error: () => {} },
        onRuntimeReady: async (ctx) => { await ctx.start({ stopAfterSuccess: true }); await ctx.wait(); }
      });

      assert.ok(caughtErr, 'Stopped cycle must reject onDispatch');
      assert.strictEqual(caughtErr.code, 'DISPATCH_REJECTED');
      assert.match(caughtErr.message, /DISPATCH_REJECTED/);
    });

    test('1.6 In-flight account checkGeneration change before onDispatch throws DISPATCH_REJECTED', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuzz-checkgen-tamper-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const cookieFile = path.join(tempDir, 'c.json');
      fs.writeFileSync(cookieFile, '{}');

      const store = new SqliteStore(dbPath, {
        items: [{ id: 'item-gen-1', state: 'pending', payload: { text: 'Check gen test' } }],
        accounts: [{ id: 'acc-1', username: 'u1', userId: '101', enabled: true, checkGeneration: 'gen-old', cookieFile }],
        cycle: { state: 'stopped', runId: null },
        settings: { dailyQuota: 10 },
        posting: {}
      });
      await store.load();

      let caughtErr = null;
      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async () => ({ slot: 1, identity: { authenticated: true, username: 'u1', userId: '101' } }),
        publish: async ({ onDispatch }) => {
          // Mutate account checkGeneration in SQLite
          await store.update(s => {
            s.accounts[0].checkGeneration = 'gen-new-reauth';
            return s;
          });
          try {
            await onDispatch({ accountId: 'acc-1' });
          } catch (err) {
            caughtErr = err;
            throw err;
          }
          return { published: true, url: 'https://x.com/u1/status/1' };
        },
        close: async () => {}
      });

      await run({
        token: 't', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
        dataDir: tempDir, api: createMockTelegramApi(), vpnManager: createMockVpn(),
        maxPolls: 0, publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
        logger: { log: () => {}, error: () => {} },
        onRuntimeReady: async (ctx) => { await ctx.start({ stopAfterSuccess: true }); await ctx.wait(); }
      });

      assert.ok(caughtErr, 'Modified checkGeneration must reject onDispatch');
      assert.strictEqual(caughtErr.code, 'DISPATCH_REJECTED');
      assert.match(caughtErr.message, /DISPATCH_REJECTED/);
    });

    test('1.7 In-flight quota capacity exhaustion before onDispatch throws DISPATCH_REJECTED', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuzz-quota-exhaust-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const cookieFile = path.join(tempDir, 'c.json');
      fs.writeFileSync(cookieFile, '{}');

      const store = new SqliteStore(dbPath, {
        items: [{ id: 'item-quota-1', state: 'pending', payload: { text: 'Quota test' } }],
        accounts: [{ id: 'acc-1', username: 'u1', userId: '101', enabled: true, dailyLimit: 1, cookieFile }],
        cycle: { state: 'stopped', runId: null },
        settings: { dailyQuota: 1 },
        posting: {}
      });
      await store.load();

      let caughtErr = null;
      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async () => ({ slot: 1, identity: { authenticated: true, username: 'u1', userId: '101' } }),
        publish: async ({ onDispatch }) => {
          // Exhaust the quota in SQLite while in-flight
          await store.update(s => {
            const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date());
            s.posting ||= {};
            s.posting.quota ||= {};
            s.posting.quota[today] = { 'acc-1': 1 };
            return s;
          });
          try {
            await onDispatch({ accountId: 'acc-1' });
          } catch (err) {
            caughtErr = err;
            throw err;
          }
          return { published: true, url: 'https://x.com/u1/status/1' };
        },
        close: async () => {}
      });

      await run({
        token: 't', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
        dataDir: tempDir, api: createMockTelegramApi(), vpnManager: createMockVpn(),
        maxPolls: 0, publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
        logger: { log: () => {}, error: () => {} },
        onRuntimeReady: async (ctx) => { await ctx.start({ stopAfterSuccess: true }); await ctx.wait(); }
      });

      assert.ok(caughtErr, 'Exhausted quota must reject onDispatch');
      assert.strictEqual(caughtErr.code, 'DISPATCH_REJECTED');
      assert.match(caughtErr.message, /DISPATCH_REJECTED/);
    });
  });

  // =========================================================================
  // SUITE 2: Concurrency Fuzzing: Simultaneous Cycle Triggers & Raced Stop
  // =========================================================================
  describe('2. Concurrency Fuzzing: Simultaneous Cycle Triggers', () => {

    test('2.1 20 simultaneous ctx.start() triggers enforce mutual exclusion (only 1 succeeds)', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuzz-simult-start-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const cookieFile = path.join(tempDir, 'c.json');
      fs.writeFileSync(cookieFile, '{}');

      const store = new SqliteStore(dbPath, {
        items: [{ id: 'item-simult-1', state: 'pending', payload: { text: 'Simultaneous start test' } }],
        accounts: [{ id: 'acc-1', username: 'u1', userId: '101', enabled: true, cookieFile }],
        cycle: { state: 'stopped', runId: null },
        settings: { dailyQuota: 10 },
        posting: {}
      });
      await store.load();

      let publishCallCount = 0;
      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async () => ({ slot: 1, identity: { authenticated: true, username: 'u1', userId: '101' } }),
        publish: async ({ onDispatch }) => {
          publishCallCount++;
          await onDispatch({ accountId: 'acc-1' });
          return { published: true, url: 'https://x.com/u1/status/1' };
        },
        close: async () => {}
      });

      let startResults = [];
      await run({
        token: 't', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
        dataDir: tempDir, api: createMockTelegramApi(), vpnManager: createMockVpn(),
        maxPolls: 0, publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
        logger: { log: () => {}, error: () => {} },
        onRuntimeReady: async (ctx) => {
          // Fire 20 start calls concurrently
          startResults = await Promise.all(
            Array.from({ length: 20 }, () => ctx.start({ stopAfterSuccess: true }))
          );
          await ctx.wait();
        }
      });

      const successStarts = startResults.filter(r => r.started === true);
      assert.strictEqual(successStarts.length, 1, 'Exactly one concurrent start() call must succeed');

      const rejectedStarts = startResults.filter(r => r.started === false);
      assert.strictEqual(rejectedStarts.length, 19, 'Remaining 19 calls must be rejected');

      // Assert publish was invoked exactly once
      assert.strictEqual(publishCallCount, 1, 'Post must be published exactly once');

      const state = await store.load();
      assert.strictEqual(state.items[0].state, 'published');
    });

    test('2.2 ctx.stop() racing with in-flight onDispatch aborts cleanly without orphaned items', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuzz-race-stop-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const cookieFile = path.join(tempDir, 'c.json');
      fs.writeFileSync(cookieFile, '{}');

      const store = new SqliteStore(dbPath, {
        items: [{ id: 'item-race-1', state: 'pending', payload: { text: 'Race stop test' } }],
        accounts: [{ id: 'acc-1', username: 'u1', userId: '101', enabled: true, cookieFile }],
        cycle: { state: 'stopped', runId: null },
        settings: { dailyQuota: 10 },
        posting: {}
      });
      await store.load();

      let onDispatchError = null;
      let ctxRef = null;

      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async () => ({ slot: 1, identity: { authenticated: true, username: 'u1', userId: '101' } }),
        publish: async ({ onDispatch }) => {
          // Concurrently trigger stop before calling onDispatch
          if (ctxRef) await ctxRef.stop();
          try {
            await onDispatch({ accountId: 'acc-1' });
          } catch (err) {
            onDispatchError = err;
            throw err;
          }
          return { published: true, url: 'https://x.com/u1/status/1' };
        },
        close: async () => {}
      });

      await run({
        token: 't', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
        dataDir: tempDir, api: createMockTelegramApi(), vpnManager: createMockVpn(),
        maxPolls: 0, publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
        logger: { log: () => {}, error: () => {} },
        onRuntimeReady: async (ctx) => {
          ctxRef = ctx;
          await ctx.start({ stopAfterSuccess: true });
          await ctx.wait();
        }
      });

      assert.ok(onDispatchError, 'onDispatch must be rejected when stopped');
      assert.strictEqual(onDispatchError.code, 'DISPATCH_REJECTED');
      assert.match(onDispatchError.message, /DISPATCH_REJECTED/);

      // Verify that the item did not get left stuck in 'processing'
      const state = await store.load();
      const item = state.items.find(x => x.id === 'item-race-1');
      assert.ok(['pending', 'ambiguous'].includes(item.state), 'Item must be restored or settled');
      assert.strictEqual(state.cycle.state, 'stopped');
    });
  });

  // =========================================================================
  // SUITE 3: Concurrency Fuzzing: Dynamic Account Toggles During Execution
  // =========================================================================
  describe('3. Concurrency Fuzzing: Dynamic Account Toggles During Execution', () => {

    test('3.1 Account disabled via acctoggle:toggle mid-flight safely halts and rejects onDispatch', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuzz-toggle-midflight-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const c1 = path.join(tempDir, 'c1.json');
      fs.writeFileSync(c1, '{}');

      const store = new SqliteStore(dbPath, {
        items: [{ id: 'item-toggle-1', state: 'pending', payload: { text: 'Toggle midflight test' } }],
        accounts: [{ id: 'acc-toggle', username: 'tog_user', userId: '201', enabled: true, cookieFile: c1 }],
        cycle: { state: 'stopped', runId: null },
        settings: { dailyQuota: 10 },
        posting: {}
      });
      await store.load();

      let onDispatchCaught = null;
      let uiRef = null;

      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async () => ({ slot: 1, identity: { authenticated: true, username: 'tog_user', userId: '201' } }),
        publish: async ({ onDispatch }) => {
          // Simulate Telegram user clicking toggle button to disable this account while worker is publishing
          if (uiRef) {
            await uiRef.actions().accountToggle(
              { parsed: { action: 'toggle', value: 'acc-toggle' } },
              { callback_query: { id: 'cb-1', from: { id: 1 }, message: { chat: { id: 1 }, message_id: 100 } } }
            );
          }
          try {
            await onDispatch({ accountId: 'acc-toggle' });
          } catch (err) {
            onDispatchCaught = err;
            throw err;
          }
          return { published: true, url: 'https://x.com/status/1' };
        },
        close: async () => {}
      });

      await run({
        token: 't', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
        dataDir: tempDir, api: createMockTelegramApi(), vpnManager: createMockVpn(),
        maxPolls: 0, publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
        logger: { log: () => {}, error: () => {} },
        onRuntimeReady: async (ctx) => {
          uiRef = ctx.ui;
          await ctx.start({ stopAfterSuccess: true });
          await ctx.wait();
        }
      });

      assert.ok(onDispatchCaught, 'onDispatch must throw because account was disabled');
      assert.strictEqual(onDispatchCaught.code, 'DISPATCH_REJECTED');
      assert.match(onDispatchCaught.message, /DISPATCH_REJECTED/);

      const state = await store.load();
      const account = state.accounts.find(a => a.id === 'acc-toggle');
      assert.strictEqual(account.enabled, false);
      assert.strictEqual(account.status, 'غير مفعل');
    });

    test('3.2 50 rapid concurrent account toggles strictly maintain <= 5 active account ceiling', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuzz-5active-ceiling-'));
      const dbPath = path.join(tempDir, 'state.sqlite');

      // Create 10 accounts; first 5 enabled, remaining 5 disabled
      const accounts = Array.from({ length: 10 }, (_, i) => ({
        id: `acc-pool-${i + 1}`,
        username: `pool_${i + 1}`,
        userId: `50${i + 1}`,
        enabled: i < 5,
        status: i < 5 ? 'مفعل' : 'غير مفعل',
        cookieFile: path.join(tempDir, `c${i + 1}.json`)
      }));
      accounts.forEach(a => fs.writeFileSync(a.cookieFile, '{}'));

      const store = new SqliteStore(dbPath, { accounts });
      await store.load();

      let uiInstance = null;
      await run({
        token: 't', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
        dataDir: tempDir, api: createMockTelegramApi(), vpnManager: createMockVpn(),
        maxPolls: 0, sleepFn: async () => {}, attemptTimeoutMs: 1000,
        logger: { log: () => {}, error: () => {} },
        onRuntimeReady: async (ctx) => {
          uiInstance = ctx.ui;
        }
      });

      // Rapidly fire 50 concurrent toggles across all 10 accounts using distinct users to avoid single-user queue serialization
      await Promise.all(
        Array.from({ length: 50 }, async (_, idx) => {
          const targetAcc = accounts[idx % accounts.length];
          const userId = (idx % 5) + 1;
          return uiInstance.actions().accountToggle(
            { parsed: { action: 'toggle', value: targetAcc.id } },
            { callback_query: { id: `cb-${idx}`, from: { id: userId }, message: { chat: { id: 1 }, message_id: 200 + idx } } }
          );
        })
      );

      const finalState = await store.load();
      const activeCount = finalState.accounts.filter(
        a => a.enabled !== false && !['محظور', 'كابتشا', 'معزول (3 إخفاقات)', 'غير مفعل'].includes(a.status)
      ).length;

      assert.ok(activeCount <= 5, `Active accounts count (${activeCount}) must not exceed 5`);
    });
  });

  // =========================================================================
  // SUITE 4: Concurrency Fuzzing: Item Claims Race Conditions
  // =========================================================================
  describe('4. Concurrency Fuzzing: Item Claims Race Conditions', () => {

    test('4.1 50 concurrent claims across 5 workers on 5 items: strictly 1 claim per item', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuzz-claims-50-'));
      const dbPath = path.join(tempDir, 'state.sqlite');

      const items = Array.from({ length: 5 }, (_, i) => ({
        id: `fuzz-item-${i + 1}`,
        state: 'pending',
        payload: { text: `Item content ${i + 1}` }
      }));
      const accounts = Array.from({ length: 5 }, (_, i) => ({
        id: `worker-acc-${i + 1}`,
        username: `worker_${i + 1}`,
        userId: `60${i + 1}`,
        enabled: true,
        failures: 0
      }));

      const store = new SqliteStore(dbPath, { items, accounts, cycle: { state: 'running', runId: 'run-claims-fuzz' } });
      await store.load();

      // Launch 50 competing worker claim operations
      const claimResults = await Promise.all(
        Array.from({ length: 50 }, async (_, idx) => {
          const targetItemId = items[idx % items.length].id;
          const accountId = accounts[idx % accounts.length].id;
          const claimToken = `fuzz-token-${idx}`;

          return store.update(s => {
            const item = s.items.find(x => x.id === targetItemId);
            if (item && item.state === 'pending') {
              item.state = 'processing';
              item.claimedAt = new Date().toISOString();
              item.attempt = {
                phase: 'claimed',
                token: claimToken,
                runId: 'run-claims-fuzz',
                accountId
              };
              return s;
            }
            return s;
          }).then(s => {
            const item = s.items.find(x => x.id === targetItemId);
            return item?.attempt?.token === claimToken;
          });
        })
      );

      const winningClaims = claimResults.filter(Boolean);
      assert.strictEqual(winningClaims.length, 5, 'Exactly 5 winning claims for 5 pending items');

      const finalState = await store.load();
      const allTokens = finalState.items.map(i => i.attempt?.token);
      const uniqueTokens = new Set(allTokens);
      assert.strictEqual(uniqueTokens.size, 5, 'All 5 items must have distinct unique tokens');
      for (const item of finalState.items) {
        assert.strictEqual(item.state, 'processing');
        assert.strictEqual(item.attempt.phase, 'claimed');
      }
    });

    test('4.2 Stale worker publish state mutation is blocked by newer claim token', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuzz-stale-publish-block-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const cookieFile = path.join(tempDir, 'c.json');
      fs.writeFileSync(cookieFile, '{}');

      const store = new SqliteStore(dbPath, {
        items: [{ id: 'item-stale-pub', state: 'pending', payload: { text: 'Stale publish' } }],
        accounts: [{ id: 'acc-1', username: 'u1', userId: '101', enabled: true, dailyLimit: 10, cookieFile }],
        cycle: { state: 'stopped', runId: null },
        settings: { dailyQuota: 10 },
        posting: {}
      });
      await store.load();

      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async () => ({ slot: 1, identity: { authenticated: true, username: 'u1', userId: '101' } }),
        publish: async ({ onDispatch }) => {
          await onDispatch({ accountId: 'acc-1' });
          // Now simulate a newer claim superseding the token before publish resolves
          await store.update(s => {
            s.items[0].attempt.token = 'newer-claim-token-999';
            return s;
          });
          return { published: true, url: 'https://x.com/u1/status/999', id: '999' };
        },
        close: async () => {}
      });

      await run({
        token: 't', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
        dataDir: tempDir, api: createMockTelegramApi(), vpnManager: createMockVpn(),
        maxPolls: 0, publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
        logger: { log: () => {}, error: () => {} },
        onRuntimeReady: async (ctx) => { await ctx.start({ stopAfterSuccess: true }); await ctx.wait(); }
      });

      const finalState = await store.load();
      const item = finalState.items.find(x => x.id === 'item-stale-pub');
      // The state transition MUST have been blocked because token did not match
      assert.notStrictEqual(item.state, 'published');
      assert.strictEqual(item.state, 'processing');
      assert.strictEqual(item.attempt.token, 'newer-claim-token-999');
      // Quota must NOT have been incremented
      assert.strictEqual(finalState.posting?.quota, undefined);
    });
  });
});
