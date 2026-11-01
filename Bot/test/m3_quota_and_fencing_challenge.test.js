'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const { run } = require(path.join(ROOT, 'src/runner'));
const { SqliteStore } = require(path.join(ROOT, 'src/sqliteStore'));
const { accountCapacity, quotaAdmission, riyadhDay } = require(path.join(ROOT, 'src/quota'));

function createMockApi() {
  const sentMessages = [];
  return {
    sentMessages,
    getMe: async () => ({ id: 1, is_bot: true }),
    sendMessage: async (chat, text) => { sentMessages.push({ chat, text }); return { message_id: 1 }; },
    sendRichMessage: async (chat, text) => { sentMessages.push({ chat, text }); return { message_id: 1 }; },
    editMessageText: async () => ({ message_id: 1 }),
    deleteMessage: async () => {},
    answerCallbackQuery: async () => {},
    getUpdates: async () => [],
    sendDocument: async () => ({ message_id: 1 })
  };
}

function createMockVpn() {
  return {
    ensure: async () => ({ exitIp: '185.220.101.5', proxy: 'socks5h://127.0.0.1:18801' }),
    health: async () => ({ healthy: true, exitIp: '185.220.101.5' }),
    rotate: async () => {}
  };
}

describe('M3 Empirical Challenge: Quota Deduction, Ambiguity Quarantine & Token Fencing', () => {

  // =========================================================================
  // OBJECTIVE 1: Ambiguous Items Quarantined Without Quota Deduction
  // =========================================================================
  describe('Objective 1: Ambiguity Quarantine & Zero Quota Deduction', () => {

    test('1.1 Adapter returning ambiguous result is quarantined without quota deduction and never re-attempted', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-test-ambig-1-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const cookiePath = path.join(tempDir, 'cookie.json');
      fs.writeFileSync(cookiePath, '{}');

      const store = new SqliteStore(dbPath, {
        items: [
          { id: 'item-ambig-1', state: 'pending', payload: { text: 'Ambiguous test post' } },
          { id: 'item-pending-2', state: 'pending', payload: { text: 'Pending post 2' } }
        ],
        accounts: [{ id: 'acct-1', username: 'testuser', userId: '1001', enabled: true, cookieFile: cookiePath }],
        cycle: { state: 'stopped', runId: null },
        settings: { dailyQuota: 10 },
        posting: {}
      });
      await store.load();

      let adapterCallCount = 0;
      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async () => ({ slot: 1, identity: { authenticated: true, username: 'testuser', userId: '1001' } }),
        publish: async ({ onDispatch }) => {
          adapterCallCount++;
          await onDispatch({ accountId: 'acct-1' });
          if (adapterCallCount === 1) {
            // First item returns ambiguous
            return { published: false, ambiguous: true, reason: 'publish_confirmation_missing' };
          }
          // Second item succeeds
          return { published: true, url: 'https://x.com/testuser/status/222', id: '222' };
        },
        close: async () => {}
      });

      const api = createMockApi();
      await run({
        token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
        dataDir: tempDir, api, vpnManager: createMockVpn(),
        maxPolls: 0, publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
        logger: { log: () => {}, error: () => {} },
        onRuntimeReady: async (ctx) => {
          await ctx.start({ stopAfterSuccess: false });
          await ctx.wait();
        }
      });

      const state = await store.load();
      const item1 = state.items.find(x => x.id === 'item-ambig-1');
      const item2 = state.items.find(x => x.id === 'item-pending-2');
      const today = riyadhDay();

      // Item 1 must be quarantined in 'ambiguous' state
      assert.strictEqual(item1.state, 'ambiguous', 'Item 1 must be quarantined as ambiguous');
      assert.strictEqual(item1.reason, 'publish_confirmation_missing');
      assert.strictEqual(item1.url, undefined, 'Ambiguous item must not have url');
      assert.strictEqual(item1.publishedAt, undefined, 'Ambiguous item must not have publishedAt');

      // Item 2 succeeded
      assert.strictEqual(item2.state, 'published');
      assert.strictEqual(item2.url, 'https://x.com/testuser/status/222');

      // Quota must be exactly 1 (for item 2 only, NEVER deducted for item 1)
      assert.strictEqual(state.posting?.quota?.[today]?.['acct-1'], 1, 'Quota must be deducted exactly once for item 2');

      // Now trigger another cycle start to prove ambiguous item is NOT retried
      adapterCallCount = 0;
      await run({
        token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
        dataDir: tempDir, api, vpnManager: createMockVpn(),
        maxPolls: 0, publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
        logger: { log: () => {}, error: () => {} },
        onRuntimeReady: async (ctx) => {
          await ctx.start({ stopAfterSuccess: false });
          await ctx.wait();
        }
      });

      // No pending items left, adapter must not have been called
      assert.strictEqual(adapterCallCount, 0, 'Ambiguous item must NEVER be retried');
      const state2 = await store.load();
      assert.strictEqual(state2.items.find(x => x.id === 'item-ambig-1').state, 'ambiguous');
      assert.strictEqual(state2.posting?.quota?.[today]?.['acct-1'], 1, 'Quota must remain 1');
    });

    test('1.2 Network drop after dispatchEntered quarantines item as ambiguous without quota deduction', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-test-ambig-drop-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const cookiePath = path.join(tempDir, 'cookie.json');
      fs.writeFileSync(cookiePath, '{}');

      const store = new SqliteStore(dbPath, {
        items: [{ id: 'item-drop-1', state: 'pending', payload: { text: 'Network drop post' } }],
        accounts: [{ id: 'acct-1', username: 'testuser', userId: '1001', enabled: true, cookieFile: cookiePath }],
        cycle: { state: 'stopped', runId: null },
        settings: { dailyQuota: 10 },
        posting: {}
      });
      await store.load();

      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async () => ({ slot: 1, identity: { authenticated: true, username: 'testuser', userId: '1001' } }),
        publish: async ({ onDispatch }) => {
          await onDispatch({ accountId: 'acct-1' });
          // Network connection abruptly dropped after dispatch
          const err = new Error('ECONNRESET: socket hang up');
          err.code = 'ECONNRESET';
          throw err;
        },
        close: async () => {}
      });

      const api = createMockApi();
      await run({
        token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
        dataDir: tempDir, api, vpnManager: createMockVpn(),
        maxPolls: 0, publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
        logger: { log: () => {}, error: () => {} },
        onRuntimeReady: async (ctx) => {
          await ctx.start({ stopAfterSuccess: true });
          await ctx.wait();
        }
      });

      const state = await store.load();
      const item = state.items.find(x => x.id === 'item-drop-1');
      const today = riyadhDay();

      // State must be ambiguous because dispatch entered before drop
      assert.strictEqual(item.state, 'ambiguous', 'Must quarantine as ambiguous when drop occurs after dispatchEntered');
      // Quota must NOT be incremented
      assert.strictEqual(state.posting?.quota?.[today]?.['acct-1'], undefined, 'No quota deducted for ambiguous item');
    });

    test('1.3 Published true without URL is quarantined as ambiguous without quota deduction', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-test-ambig-nourl-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const cookiePath = path.join(tempDir, 'cookie.json');
      fs.writeFileSync(cookiePath, '{}');

      const store = new SqliteStore(dbPath, {
        items: [{ id: 'item-nourl-1', state: 'pending', payload: { text: 'No URL post' } }],
        accounts: [{ id: 'acct-1', username: 'testuser', userId: '1001', enabled: true, cookieFile: cookiePath }],
        cycle: { state: 'stopped', runId: null },
        settings: { dailyQuota: 10 },
        posting: {}
      });
      await store.load();

      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async () => ({ slot: 1, identity: { authenticated: true, username: 'testuser', userId: '1001' } }),
        publish: async ({ onDispatch }) => {
          await onDispatch({ accountId: 'acct-1' });
          return { published: true, url: null, id: '12345' }; // Missing URL
        },
        close: async () => {}
      });

      const api = createMockApi();
      await run({
        token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
        dataDir: tempDir, api, vpnManager: createMockVpn(),
        maxPolls: 0, publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
        logger: { log: () => {}, error: () => {} },
        onRuntimeReady: async (ctx) => {
          await ctx.start({ stopAfterSuccess: true });
          await ctx.wait();
        }
      });

      const state = await store.load();
      const item = state.items.find(x => x.id === 'item-nourl-1');
      const today = riyadhDay();

      assert.strictEqual(item.state, 'ambiguous', 'Missing URL must result in ambiguous state');
      assert.strictEqual(state.posting?.quota?.[today]?.['acct-1'], undefined, 'No quota deducted');
    });
  });

  // =========================================================================
  // OBJECTIVE 2: Quota Boundary Stress-Test (Quota >= 10 refuses dispatch)
  // =========================================================================
  describe('Objective 2: Quota Boundary Enforcement (>= 10 Refuses Dispatch)', () => {

    test('2.1 Account with quota at 10/10 refuses start and refuses dispatch', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-test-quota-at-10-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const cookiePath = path.join(tempDir, 'cookie.json');
      fs.writeFileSync(cookiePath, '{}');
      const today = riyadhDay();

      const store = new SqliteStore(dbPath, {
        items: [{ id: 'item-quota-1', state: 'pending', payload: { text: 'Exhausted post' } }],
        accounts: [{ id: 'acct-1', username: 'testuser', userId: '1001', enabled: true, cookieFile: cookiePath }],
        cycle: { state: 'stopped', runId: null },
        settings: { dailyQuota: 10 },
        posting: {
          quota: {
            [today]: { 'acct-1': 10 }
          }
        }
      });
      await store.load();

      let adapterCalled = false;
      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async () => { adapterCalled = true; return {}; },
        publish: async () => { adapterCalled = true; return {}; },
        close: async () => {}
      });

      const api = createMockApi();
      await run({
        token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
        dataDir: tempDir, api, vpnManager: createMockVpn(),
        maxPolls: 0, publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
        logger: { log: () => {}, error: () => {} },
        onRuntimeReady: async (ctx) => {
          const res = await ctx.start();
          assert.strictEqual(res.started, false, 'Cycle must not start when quota is exhausted');
          await ctx.wait();
        }
      });

      assert.strictEqual(adapterCalled, false, 'Adapter must NEVER be opened or called');
      const state = await store.load();
      assert.strictEqual(state.items.find(x => x.id === 'item-quota-1').state, 'pending');
      assert.strictEqual(state.posting.quota[today]['acct-1'], 10, 'Quota must remain strictly 10');

      // Also verify capacity and quotaAdmission report exhausted
      const cap = accountCapacity(state, state.accounts[0]);
      assert.strictEqual(cap.remaining, 0, 'Capacity remaining must be 0');
      const adm = quotaAdmission(state);
      assert.strictEqual(adm.exhausted, true, 'Admission must be exhausted');
      assert.strictEqual(adm.reason, 'daily_quota_exhausted');
    });

    test('2.2 Account starting at 9/10 publishes 1 post to reach 10, then halts and refuses further items', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-test-quota-9to10-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const cookiePath = path.join(tempDir, 'cookie.json');
      fs.writeFileSync(cookiePath, '{}');
      const today = riyadhDay();

      const store = new SqliteStore(dbPath, {
        items: [
          { id: 'item-post-9', state: 'pending', payload: { text: 'Post 10 (allowed)' } },
          { id: 'item-post-10', state: 'pending', payload: { text: 'Post 11 (must be refused)' } }
        ],
        accounts: [{ id: 'acct-1', username: 'testuser', userId: '1001', enabled: true, cookieFile: cookiePath }],
        cycle: { state: 'stopped', runId: null },
        settings: { dailyQuota: 10, delayMinSeconds: 0, delayMaxSeconds: 0 },
        posting: {
          quota: {
            [today]: { 'acct-1': 9 }
          }
        }
      });
      await store.load();

      let publishedCount = 0;
      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async () => ({ slot: 1, identity: { authenticated: true, username: 'testuser', userId: '1001' } }),
        publish: async ({ onDispatch }) => {
          publishedCount++;
          await onDispatch({ accountId: 'acct-1' });
          return { published: true, url: `https://x.com/testuser/status/${publishedCount}`, id: `${publishedCount}` };
        },
        close: async () => {}
      });

      const api = createMockApi();
      await run({
        token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
        dataDir: tempDir, api, vpnManager: createMockVpn(),
        maxPolls: 0, publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
        logger: { log: () => {}, error: () => {} },
        onRuntimeReady: async (ctx) => {
          await ctx.start({ stopAfterSuccess: false });
          await ctx.wait();
        }
      });

      const state = await store.load();
      const item9 = state.items.find(x => x.id === 'item-post-9');
      const item10 = state.items.find(x => x.id === 'item-post-10');

      assert.strictEqual(publishedCount, 1, 'Only exactly 1 post could be published');
      assert.strictEqual(item9.state, 'published');
      assert.strictEqual(item10.state, 'pending', 'Second post must remain pending');
      assert.strictEqual(state.posting.quota[today]['acct-1'], 10, 'Quota must be exactly 10 and not exceed it');
      assert.strictEqual(state.cycle.state, 'stopped', 'Cycle must stop when quota is exhausted');
      assert.strictEqual(state.cycle.reason, 'daily_quota_exhausted');
    });

    test('2.3 Dispatch fence rejects onDispatch if quota hits 10 between claim and dispatch', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-test-quota-race-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const cookiePath = path.join(tempDir, 'cookie.json');
      fs.writeFileSync(cookiePath, '{}');
      const today = riyadhDay();

      const store = new SqliteStore(dbPath, {
        items: [{ id: 'item-race-1', state: 'pending', payload: { text: 'Race condition post' } }],
        accounts: [{ id: 'acct-1', username: 'testuser', userId: '1001', enabled: true, cookieFile: cookiePath }],
        cycle: { state: 'stopped', runId: null },
        settings: { dailyQuota: 10 },
        posting: {
          quota: {
            [today]: { 'acct-1': 9 } // Quota is 9 during claim
          }
        }
      });
      await store.load();

      let fenceError = null;
      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async () => ({ slot: 1, identity: { authenticated: true, username: 'testuser', userId: '1001' } }),
        publish: async ({ onDispatch }) => {
          // Concurrently exhaust quota in store before calling onDispatch
          await store.update(s => {
            s.posting.quota[today]['acct-1'] = 10;
            return s;
          });

          try {
            await onDispatch({ accountId: 'acct-1' });
          } catch (err) {
            fenceError = err;
            throw err;
          }
          return { published: true, url: 'https://x.com/testuser/status/race' };
        },
        close: async () => {}
      });

      const api = createMockApi();
      await run({
        token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
        dataDir: tempDir, api, vpnManager: createMockVpn(),
        maxPolls: 0, publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
        logger: { log: () => {}, error: () => {} },
        onRuntimeReady: async (ctx) => {
          await ctx.start({ stopAfterSuccess: true });
          await ctx.wait();
        }
      });

      assert.ok(fenceError, 'onDispatch must throw an error');
      assert.strictEqual(fenceError.code, 'DISPATCH_REJECTED', 'Must reject dispatch due to exhausted quota at fence');

      const state = await store.load();
      const item = state.items.find(x => x.id === 'item-race-1');
      assert.strictEqual(item.url, undefined, 'Must not be published');
      assert.strictEqual(state.posting.quota[today]['acct-1'], 10, 'Quota must stay 10 and not increase');
    });

    test('2.4 Multi-account quota routing: skips exhausted account (10/10) and only dispatches to eligible account', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-test-quota-multi-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const cookiePath1 = path.join(tempDir, 'cookie1.json');
      const cookiePath2 = path.join(tempDir, 'cookie2.json');
      fs.writeFileSync(cookiePath1, '{}');
      fs.writeFileSync(cookiePath2, '{}');
      const today = riyadhDay();

      const store = new SqliteStore(dbPath, {
        items: [
          { id: 'item-m-1', state: 'pending', payload: { text: 'Post 1' } },
          { id: 'item-m-2', state: 'pending', payload: { text: 'Post 2' } }
        ],
        accounts: [
          { id: 'acct-exhausted', username: 'fulluser', userId: '1001', enabled: true, cookieFile: cookiePath1 },
          { id: 'acct-available', username: 'availuser', userId: '1002', enabled: true, cookieFile: cookiePath2 }
        ],
        cycle: { state: 'stopped', runId: null },
        settings: { dailyQuota: 10, delayMinSeconds: 0, delayMaxSeconds: 0 },
        posting: {
          quota: {
            [today]: {
              'acct-exhausted': 10,
              'acct-available': 9
            }
          }
        }
      });
      await store.load();

      const usedAccounts = [];
      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async ({ account }) => ({ slot: 1, identity: { authenticated: true, username: account.username, userId: account.userId } }),
        publish: async ({ session, onDispatch }) => {
          usedAccounts.push(session.identity.username);
          await onDispatch({ accountId: session.identity.username === 'fulluser' ? 'acct-exhausted' : 'acct-available' });
          return { published: true, url: `https://x.com/${session.identity.username}/status/100`, id: '100' };
        },
        close: async () => {}
      });

      const api = createMockApi();
      await run({
        token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
        dataDir: tempDir, api, vpnManager: createMockVpn(),
        maxPolls: 0, publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
        logger: { log: () => {}, error: () => {} },
        onRuntimeReady: async (ctx) => {
          await ctx.start({ stopAfterSuccess: false });
          await ctx.wait();
        }
      });

      const state = await store.load();
      // Only acct-available should have been used, and only once (from 9 -> 10)
      assert.deepStrictEqual(usedAccounts, ['availuser'], 'Exhausted account fulluser must NEVER be dispatched to');
      assert.strictEqual(state.posting.quota[today]['acct-exhausted'], 10);
      assert.strictEqual(state.posting.quota[today]['acct-available'], 10);
      assert.strictEqual(state.items.find(x => x.id === 'item-m-1').state, 'published');
      assert.strictEqual(state.items.find(x => x.id === 'item-m-2').state, 'pending');
      assert.strictEqual(state.cycle.reason, 'daily_quota_exhausted');
    });
  });

  // =========================================================================
  // OBJECTIVE 3: Attempt Token Fencing on Late Callbacks
  // =========================================================================
  describe('Objective 3: Attempt Token Fencing on Late Callbacks', () => {

    test('3.1 Late onDispatch call after attempt token superseded is rejected with DISPATCH_REJECTED', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-test-token-dispatch-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const cookiePath = path.join(tempDir, 'cookie.json');
      fs.writeFileSync(cookiePath, '{}');

      const store = new SqliteStore(dbPath, {
        items: [{ id: 'item-f-1', state: 'pending', payload: { text: 'Fence token test' } }],
        accounts: [{ id: 'acct-1', username: 'testuser', userId: '1001', enabled: true, cookieFile: cookiePath }],
        cycle: { state: 'stopped', runId: null },
        settings: { dailyQuota: 10 },
        posting: {}
      });
      await store.load();

      let caughtError = null;
      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async () => ({ slot: 1, identity: { authenticated: true, username: 'testuser', userId: '1001' } }),
        publish: async ({ onDispatch }) => {
          // Token is replaced in store before callback
          await store.update(s => {
            s.items[0].attempt.token = 'superseding-token-uuid-12345';
            return s;
          });
          try {
            await onDispatch({ accountId: 'acct-1' });
          } catch (err) {
            caughtError = err;
            throw err;
          }
          return { published: true, url: 'https://x.com/testuser/status/1' };
        },
        close: async () => {}
      });

      const api = createMockApi();
      await run({
        token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
        dataDir: tempDir, api, vpnManager: createMockVpn(),
        maxPolls: 0, publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
        logger: { log: () => {}, error: () => {} },
        onRuntimeReady: async (ctx) => {
          await ctx.start({ stopAfterSuccess: true });
          await ctx.wait();
        }
      });

      assert.ok(caughtError);
      assert.strictEqual(caughtError.code, 'DISPATCH_REJECTED');

      const state = await store.load();
      const item = state.items.find(x => x.id === 'item-f-1');
      assert.strictEqual(item.attempt.token, 'superseding-token-uuid-12345');
      assert.strictEqual(item.attempt.phase, 'claimed');
    });

    test('3.2 Late publish resolution after token superseded is ignored without transitioning state or deducting quota', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-test-token-pub-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const cookiePath = path.join(tempDir, 'cookie.json');
      fs.writeFileSync(cookiePath, '{}');
      const today = riyadhDay();

      const store = new SqliteStore(dbPath, {
        items: [{ id: 'item-late-pub', state: 'pending', payload: { text: 'Late publish test' } }],
        accounts: [{ id: 'acct-1', username: 'testuser', userId: '1001', enabled: true, cookieFile: cookiePath }],
        cycle: { state: 'stopped', runId: null },
        settings: { dailyQuota: 10 },
        posting: {}
      });
      await store.load();

      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async () => ({ slot: 1, identity: { authenticated: true, username: 'testuser', userId: '1001' } }),
        publish: async ({ onDispatch }) => {
          await onDispatch({ accountId: 'acct-1' });
          // Now dispatch succeeded, but before publish returns, token is superseded
          await store.update(s => {
            s.items[0].attempt.token = 'newer-claim-token-999';
            return s;
          });
          return { published: true, url: 'https://x.com/testuser/status/late-resolution', id: 'late-id' };
        },
        close: async () => {}
      });

      const api = createMockApi();
      await run({
        token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
        dataDir: tempDir, api, vpnManager: createMockVpn(),
        maxPolls: 0, publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
        logger: { log: () => {}, error: () => {} },
        onRuntimeReady: async (ctx) => {
          await ctx.start({ stopAfterSuccess: true });
          await ctx.wait();
        }
      });

      const state = await store.load();
      const item = state.items.find(x => x.id === 'item-late-pub');
      // The state transition must NOT have happened because token didn't match claim
      assert.strictEqual(item.url, undefined, 'Late post URL must NOT be saved');
      assert.strictEqual(item.attempt.token, 'newer-claim-token-999', 'Newer token preserved');
      assert.strictEqual(state.posting?.quota?.[today], undefined, 'Quota must NOT be incremented for late result');
    });

    test('3.3 Cross-cycle token fence: late callback from stopped cycle cannot dispatch in new cycle', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-test-token-crossrun-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const cookiePath = path.join(tempDir, 'cookie.json');
      fs.writeFileSync(cookiePath, '{}');

      const store = new SqliteStore(dbPath, {
        items: [{ id: 'item-cross-1', state: 'pending', payload: { text: 'Cross cycle post' } }],
        accounts: [{ id: 'acct-1', username: 'testuser', userId: '1001', enabled: true, cookieFile: cookiePath }],
        cycle: { state: 'stopped', runId: null },
        settings: { dailyQuota: 10 },
        posting: {}
      });
      await store.load();

      let caughtFenceError = null;
      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async () => ({ slot: 1, identity: { authenticated: true, username: 'testuser', userId: '1001' } }),
        publish: async ({ onDispatch }) => {
          // Stop cycle and change runId in store before onDispatch
          await store.update(s => {
            s.cycle.runId = 'new-different-run-id';
            return s;
          });
          try {
            await onDispatch({ accountId: 'acct-1' });
          } catch (err) {
            caughtFenceError = err;
            throw err;
          }
          return { published: true, url: 'https://x.com/testuser/status/1' };
        },
        close: async () => {}
      });

      const api = createMockApi();
      await run({
        token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
        dataDir: tempDir, api, vpnManager: createMockVpn(),
        maxPolls: 0, publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
        logger: { log: () => {}, error: () => {} },
        onRuntimeReady: async (ctx) => {
          await ctx.start({ stopAfterSuccess: true });
          await ctx.wait();
        }
      });

      assert.ok(caughtFenceError);
      assert.strictEqual(caughtFenceError.code, 'DISPATCH_REJECTED', 'Cross-cycle runId change must reject dispatch');
    });
  });

  // =========================================================================
  // OBJECTIVE 4: Production Database State Audit
  // =========================================================================
  describe('Objective 4: Production Database Integrity Audit', () => {

    test('4.1 Production state.sqlite: ambiguous items have 0 quota deductions and quota strictly matches published items', async () => {
      const prodDbPath = path.resolve(ROOT, 'data/state.sqlite');
      assert.ok(fs.existsSync(prodDbPath), 'Production database must exist');

      const store = new SqliteStore(prodDbPath);
      const state = await store.load();

      // Audit ambiguous items
      const ambiguousItems = (state.items || []).filter(i => i.state === 'ambiguous');
      assert.ok(ambiguousItems.length >= 1, 'There are real ambiguous items in production');

      for (const item of ambiguousItems) {
        assert.strictEqual(item.url, undefined, `Ambiguous item ${item.id} must not have a url`);
        assert.strictEqual(item.publishedAt, undefined, `Ambiguous item ${item.id} must not have publishedAt`);
      }

      // Audit today's quota (2026-11-01)
      const today = riyadhDay();
      const quotaToday = state.posting?.quota?.[today] || {};
      const publishedToday = (state.items || []).filter(i => i.state === 'published' && i.publishedAt && i.publishedAt.startsWith(today));

      const countByAccount = {};
      for (const item of publishedToday) {
        countByAccount[item.accountId] = (countByAccount[item.accountId] || 0) + 1;
      }

      for (const [accountId, count] of Object.entries(countByAccount)) {
        assert.strictEqual(
          quotaToday[accountId],
          count,
          `Account ${accountId} quota in state (${quotaToday[accountId]}) must match published items (${count})`
        );
      }

      // Check daily quota limit of 10
      const limit = state.settings?.dailyQuota || 10;
      for (const [accountId, used] of Object.entries(quotaToday)) {
        assert.ok(used <= limit, `Account ${accountId} quota used (${used}) must not exceed limit (${limit})`);
      }
    });
  });
});
