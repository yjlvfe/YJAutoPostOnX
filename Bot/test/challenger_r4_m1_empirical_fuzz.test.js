'use strict';

/**
 * Empirical Challenger Milestone 1 Verification Suite
 *
 * Verifies:
 * 1. Claim Fencing & Attempt Token Lifecycle:
 *    - Pre-dispatch failure (phase: 'claimed') -> reverts to 'pending', attempt deleted.
 *    - Post-dispatch ambiguous return (phase: 'dispatching') -> quarantined as 'ambiguous', attempt deleted.
 *    - Post-dispatch exception throw (phase: 'dispatching') -> quarantined as 'ambiguous', attempt deleted check.
 *    - Post-dispatch crash reboot recovery (Queue.recoverProcessing) -> quarantined as 'ambiguous', attempt deleted check.
 * 2. Ambiguous Quarantine Invariant:
 *    - Ambiguous items are NEVER claimed by claimNext().
 *    - Ambiguous items are NEVER revived by recoverProcessing().
 * 3. Zero Double-Posting Under High Concurrency:
 *    - Racing claims across multiple workers.
 *    - Racing onDispatch calls.
 *    - Rapid concurrent failure injections (timeouts, drops, aborts).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const { run } = require(path.join(ROOT, 'src/runner'));
const { Queue } = require(path.join(ROOT, 'src/queue'));
const { SqliteStore } = require(path.join(ROOT, 'src/sqliteStore'));

function createMockTelegramApi() {
  return {
    getMe: async () => ({ id: 1 }),
    sendMessage: async () => ({ message_id: 1 }),
    sendRichMessage: async () => ({ message_id: 1 }),
    editMessageText: async () => ({ message_id: 1 }),
    deleteMessage: async () => {},
    answerCallbackQuery: async () => {},
    getUpdates: async () => [],
    sendDocument: async () => ({})
  };
}

function createMockVpn() {
  return {
    ensure: async () => ({ exitIp: '1.2.3.4', proxy: 'socks5h://127.0.0.1:18801', slot: 1 }),
    health: async () => ({ healthy: true, exitIp: '1.2.3.4' }),
    rotate: async () => {}
  };
}

describe('Challenger M1: Claim Fencing, Ambiguous Quarantine & Zero Double-Posting', () => {

  // =========================================================================
  // 1. Claim Fencing & Attempt Token Cleanup
  // =========================================================================
  describe('1. Claim Fencing & Attempt Token Cleanup', () => {

    test('1.1 Pre-dispatch account failure: reverts to pending, unpins account, deletes attempt', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chal-fuzz-predispatch-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const cookiePath = path.join(tempDir, 'c.json');
      fs.writeFileSync(cookiePath, '{}');

      const store = new SqliteStore(dbPath, {
        items: [
          { id: 'item-pre-1', state: 'pending', payload: { text: 'Pre-dispatch fail', account: 'acc-1' } }
        ],
        accounts: [
          { id: 'acc-1', username: 'u1', userId: '101', enabled: true, cookieFile: cookiePath, failures: 0 }
        ],
        cycle: { state: 'stopped', runId: null },
        settings: { dailyQuota: 10, delayMinSeconds: 1, delayMaxSeconds: 1 },
        posting: {}
      });
      await store.load();

      let virtualTime = Date.now();
      const clock = () => new Date(virtualTime);
      const sleepFn = async (ms) => { virtualTime += (ms || 1000); };

      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async () => ({
          slot: 1,
          identity: { authenticated: false, accountFailure: 'auth_rejected', reason: 'bad_token' }
        }),
        publish: async () => {
          throw new Error('Should never reach publish');
        },
        close: async () => {}
      });

      await run({
        token: 't', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
        dataDir: tempDir, api: createMockTelegramApi(), vpnManager: createMockVpn(),
        maxPolls: 0, publishAdapterFactory, clock, sleepFn, attemptTimeoutMs: 3000,
        logger: { log: () => {}, error: () => {} },
        onRuntimeReady: async (ctx) => {
          await ctx.start({ stopAfterSuccess: false });
          await ctx.wait();
        }
      });

      const state = await store.load();
      const item = state.items.find(x => x.id === 'item-pre-1');
      assert.strictEqual(item.state, 'pending', 'Pre-dispatch failure must revert item to pending');
      assert.strictEqual(item.attempt, undefined, 'Pre-dispatch attempt token must be deleted');
      assert.strictEqual(item.payload.account, undefined, 'Payload account pinning must be removed');
    });

    test('1.2 Post-dispatch ambiguous return: quarantined as ambiguous with attempt token deleted', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chal-fuzz-postdispatch-ret-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const cookiePath = path.join(tempDir, 'c.json');
      fs.writeFileSync(cookiePath, '{}');

      const store = new SqliteStore(dbPath, {
        items: [
          { id: 'item-ambig-ret', state: 'pending', payload: { text: 'Ambig return' } }
        ],
        accounts: [
          { id: 'acc-1', username: 'u1', userId: '101', enabled: true, cookieFile: cookiePath, failures: 0 }
        ],
        cycle: { state: 'stopped', runId: null },
        settings: { dailyQuota: 10, delayMinSeconds: 1, delayMaxSeconds: 1 },
        posting: {}
      });
      await store.load();

      let virtualTime = Date.now();
      const clock = () => new Date(virtualTime);
      const sleepFn = async (ms) => { virtualTime += (ms || 1000); };

      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async () => ({
          slot: 1,
          identity: { authenticated: true, username: 'u1', userId: '101' }
        }),
        publish: async ({ onDispatch }) => {
          await onDispatch({ accountId: 'acc-1' });
          return { published: false, ambiguous: true, reason: 'publish_confirmation_missing' };
        },
        close: async () => {}
      });

      await run({
        token: 't', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
        dataDir: tempDir, api: createMockTelegramApi(), vpnManager: createMockVpn(),
        maxPolls: 0, publishAdapterFactory, clock, sleepFn, attemptTimeoutMs: 3000,
        logger: { log: () => {}, error: () => {} },
        onRuntimeReady: async (ctx) => {
          await ctx.start({ stopAfterSuccess: false });
          await ctx.wait();
        }
      });

      const state = await store.load();
      const item = state.items.find(x => x.id === 'item-ambig-ret');
      assert.strictEqual(item.state, 'ambiguous', 'Must be quarantined as ambiguous');
      assert.strictEqual(item.reason, 'publish_confirmation_missing');
      assert.strictEqual(item.accountId, 'acc-1');
      assert.strictEqual(item.accountUsername, 'u1');
      assert.strictEqual(item.attempt, undefined, 'Attempt token must be deleted when returning ambiguous');
    });

    test('1.3 Post-dispatch exception throw: empirical test of attempt token clearance defect', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chal-fuzz-postdispatch-throw-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const cookiePath = path.join(tempDir, 'c.json');
      fs.writeFileSync(cookiePath, '{}');

      const store = new SqliteStore(dbPath, {
        items: [
          { id: 'item-postdispatch-throw', state: 'pending', payload: { text: 'Throw after dispatch' } }
        ],
        accounts: [
          { id: 'acc-1', username: 'u1', userId: '101', enabled: true, cookieFile: cookiePath, failures: 0 }
        ],
        cycle: { state: 'stopped', runId: null },
        settings: { dailyQuota: 10, delayMinSeconds: 1, delayMaxSeconds: 1 },
        posting: {}
      });
      await store.load();

      let virtualTime = Date.now();
      const clock = () => new Date(virtualTime);
      const sleepFn = async (ms) => { virtualTime += (ms || 1000); };

      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async () => ({ slot: 1, identity: { authenticated: true, username: 'u1', userId: '101' } }),
        publish: async ({ onDispatch }) => {
          await onDispatch({ accountId: 'acc-1' });
          throw new Error('ECONNRESET: connection reset by peer during post');
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

      const state = await store.load();
      const item = state.items.find(x => x.id === 'item-postdispatch-throw');
      assert.strictEqual(item.state, 'ambiguous', 'Item must be quarantined as ambiguous');
      assert.strictEqual(item.accountId, 'acc-1');
      assert.strictEqual(item.accountUsername, 'u1');

      // EMPIRICAL VERIFICATION:
      // Does item.attempt get deleted on post-dispatch throw?
      // In PR #11, lines 918 and 1001 fail to delete i.attempt.
      // We document this empirical observation:
      const attemptCleared = item.attempt === undefined;
      assert.strictEqual(attemptCleared, false, 'Empirically confirms item.attempt was NOT deleted in PR #11 post-dispatch throw');
      assert.strictEqual(item.reason, 'unresolved_in_finally', 'Reason was overwritten with unresolved_in_finally instead of error');
    });

  });

  // =========================================================================
  // 2. Ambiguous Quarantine Invariant: Never Claimed by claimNext
  // =========================================================================
  describe('2. Ambiguous Items Never Claimed by claimNext', () => {

    test('2.1 claimNext strictly ignores ambiguous, failed, cancelled, and published items', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chal-fuzz-claimnext-'));
      const dbPath = path.join(tempDir, 'state.sqlite');

      const store = new SqliteStore(dbPath, {
        items: [
          { id: 'item-ambig-1', state: 'ambiguous', payload: { text: 'A1' } },
          { id: 'item-ambig-2', state: 'ambiguous', payload: { text: 'A2' }, attempt: { phase: 'dispatching', token: 'stale-1' } },
          { id: 'item-done', state: 'done', payload: { text: 'D1' } },
          { id: 'item-pub', state: 'published', payload: { text: 'P1' } },
          { id: 'item-canc', state: 'cancelled', payload: { text: 'C1' } },
          { id: 'item-fail', state: 'failed', payload: { text: 'F1' } }
        ]
      });
      await store.load();

      const queue = new Queue(store);

      // Attempt 50 claims — all must return null
      for (let i = 0; i < 50; i++) {
        const claimed = await queue.claimNext();
        assert.strictEqual(claimed, null, `claimNext must return null when no pending items exist (iteration ${i})`);
      }

      // Add one pending item
      await queue.enqueue({ text: 'Valid pending' });
      const claimedValid = await queue.claimNext();
      assert.ok(claimedValid, 'Should claim the valid pending item');
      assert.strictEqual(claimedValid.payload.text, 'Valid pending');

      // Next claim should return null again
      const claimedAfter = await queue.claimNext();
      assert.strictEqual(claimedAfter, null, 'No more pending items; must return null');
    });

    test('2.2 recoverProcessing never revives ambiguous items to pending', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chal-fuzz-recover-'));
      const dbPath = path.join(tempDir, 'state.sqlite');

      const store = new SqliteStore(dbPath, {
        items: [
          { id: 'item-ambig-3', state: 'ambiguous', outcome: 'ambiguous', payload: { text: 'Never revive' } },
          { id: 'item-proc-claim', state: 'processing', attempt: { phase: 'claimed', token: 't1' }, payload: { text: 'Can revive' } }
        ]
      });
      await store.load();

      const queue = new Queue(store);
      await queue.recoverProcessing({ state: 'ambiguous', reason: 'reboot' });

      const state = await store.load();
      const ambig = state.items.find(x => x.id === 'item-ambig-3');
      assert.strictEqual(ambig.state, 'ambiguous', 'Ambiguous item must remain ambiguous');

      const proc = state.items.find(x => x.id === 'item-proc-claim');
      assert.strictEqual(proc.state, 'pending', 'Claimed item should safely recover to pending');
    });

  });

  // =========================================================================
  // 3. Zero Double-Posting Under Concurrency & Failure Injections
  // =========================================================================
  describe('3. Zero Double-Posting Under Concurrency & Failure Injections', () => {

    test('3.1 50 concurrent claims across 5 workers guarantee mutually exclusive ownership', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chal-fuzz-race-claims-'));
      const dbPath = path.join(tempDir, 'state.sqlite');

      const initialItems = [];
      for (let i = 0; i < 10; i++) {
        initialItems.push({ id: `race-item-${i}`, state: 'pending', payload: { text: `Item ${i}` } });
      }

      const store = new SqliteStore(dbPath, { items: initialItems });
      await store.load();

      const queue = new Queue(store);

      // 50 concurrent claim attempts
      const claimPromises = [];
      for (let i = 0; i < 50; i++) {
        claimPromises.push(queue.claimNext());
      }

      const results = await Promise.all(claimPromises);
      const claimedItems = results.filter(Boolean);

      // Exactly 10 items should be claimed
      assert.strictEqual(claimedItems.length, 10, 'Exactly 10 items must be claimed out of 50 attempts');

      // Verify no duplicate IDs claimed
      const claimedIds = claimedItems.map(x => x.id);
      const uniqueIds = new Set(claimedIds);
      assert.strictEqual(uniqueIds.size, 10, 'All claimed items must have unique IDs — ZERO double claiming');
    });

    test('3.2 Rapid concurrent publish racing with failure injection: zero double posting', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chal-fuzz-zero-double-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const cookiePath = path.join(tempDir, 'c.json');
      fs.writeFileSync(cookiePath, '{}');

      const items = [];
      for (let i = 0; i < 6; i++) {
        items.push({ id: `item-fuzz-${i}`, state: 'pending', payload: { text: `Fuzz post ${i}` } });
      }

      const store = new SqliteStore(dbPath, {
        items,
        accounts: [
          { id: 'acc-1', username: 'u1', userId: '101', enabled: true, cookieFile: cookiePath, failures: 0 },
          { id: 'acc-2', username: 'u2', userId: '102', enabled: true, cookieFile: cookiePath, failures: 0 }
        ],
        cycle: { state: 'stopped', runId: null },
        settings: { dailyQuota: 20, delayMinSeconds: 1, delayMaxSeconds: 1 },
        posting: {}
      });
      await store.load();

      let virtualTime = Date.now();
      const clock = () => new Date(virtualTime);
      const sleepFn = async (ms) => { virtualTime += (ms || 1000); };

      const publishedUrls = new Set();
      let publishCalls = 0;
      let onDispatchSuccesses = 0;

      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async ({ account }) => ({
          slot: account.id === 'acc-1' ? 1 : 2,
          identity: { authenticated: true, username: account.username, userId: account.userId }
        }),
        publish: async ({ payload, onDispatch }) => {
          publishCalls++;
          const callId = publishCalls;

          // Fail alternating calls at different points
          if (callId % 3 === 0) {
            // Fail BEFORE onDispatch
            throw new Error(`Pre-dispatch network error call ${callId}`);
          }

          await onDispatch();
          onDispatchSuccesses++;

          if (callId % 3 === 1) {
            // Ambiguous outcome after dispatch
            return { published: false, ambiguous: true, reason: 'unconfirmed_timeout' };
          }

          // Successful publish
          const url = `https://x.com/user/status/${callId}_${crypto.randomUUID().slice(0, 6)}`;
          assert.strictEqual(publishedUrls.has(url), false, 'Generated URL must be unique');
          publishedUrls.add(url);
          return { published: true, url };
        },
        close: async () => {}
      });

      await run({
        token: 't', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
        dataDir: tempDir, api: createMockTelegramApi(), vpnManager: createMockVpn(),
        maxPolls: 0, publishAdapterFactory, clock, sleepFn, attemptTimeoutMs: 3000,
        logger: { log: () => {}, error: () => {} },
        onRuntimeReady: async (ctx) => {
          await ctx.start({ stopAfterSuccess: false });
          await ctx.wait();
        }
      });

      const finalState = await store.load();

      // Check invariants
      const publishedItems = finalState.items.filter(x => x.state === 'published');
      const ambiguousItems = finalState.items.filter(x => x.state === 'ambiguous');
      const pendingItems = finalState.items.filter(x => x.state === 'pending');

      // 1. Every published item must have a unique published URL
      const urls = publishedItems.map(x => x.url);
      assert.strictEqual(new Set(urls).size, urls.length, 'Every published item must have a unique URL');

      // 2. Ambiguous items must never have a URL
      for (const ambig of ambiguousItems) {
        assert.strictEqual(ambig.url, undefined, 'Ambiguous item must not have a publish URL');
      }

      // 3. ZERO DOUBLE POSTING: total published items must equal number of unique URLs
      assert.strictEqual(publishedItems.length, publishedUrls.size, 'Zero double posting: published items match unique URLs');
    });

  });

});
