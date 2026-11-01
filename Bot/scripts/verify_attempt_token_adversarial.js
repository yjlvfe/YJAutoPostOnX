#!/usr/bin/env node
'use strict';
/**
 * Adversarial Stress Harness for Attempt Token Fencing & State Safety in runner.js
 * Specifically challenges:
 * 1. Line 694 (Permanent account failure result path):
 *    - Stale callback mutation rejection while newer attempt token is registered (claimed or dispatching)
 *    - Dispatched item transition to 'ambiguous' without reverting to 'pending'
 * 2. Finally block (Lines 878-892):
 *    - Stale callback mutation rejection while newer attempt token is registered
 *    - Dispatched item transition to 'ambiguous' upon unhandled crash, never reverting to 'pending'
 *    - Unresolved in finally fallback when catch block is bypassed/aborted
 * 3. Catch block (Lines 798-808):
 *    - Stale token isolation during account failure exceptions
 *    - Dispatched item transition to 'ambiguous', never reverting to 'pending'
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const { run } = require(path.join(ROOT, 'src/runner'));
const { SqliteStore } = require(path.join(ROOT, 'src/sqliteStore'));

function createMockApi() {
  return {
    getMe: async () => ({ id: 1, username: 'challenger_bot' }),
    sendMessage: async () => ({ message_id: 1 }),
    sendRichMessage: async () => ({ message_id: 1 }),
    editMessageText: async () => ({ message_id: 1 }),
    deleteMessage: async () => {},
    answerCallbackQuery: async () => {},
    getUpdates: async () => [],
    sendDocument: async () => ({ message_id: 1 })
  };
}

function createMockVpn() {
  return {
    ensure: async () => ({ exitIp: '198.51.100.99', proxy: 'socks5h://127.0.0.1:18801' }),
    health: async () => ({ healthy: true, exitIp: '198.51.100.99' }),
    rotate: async () => {}
  };
}

async function runAdversarialChallenges() {
  console.log('================================================================');
  console.log('ADVERSARIAL CHALLENGE: RUNNER LINE 694 & FINALLY BLOCK FENCING');
  console.log('================================================================\n');

  // ==========================================================================
  // CHALLENGE 1: Line 694 Stale Callback Mutation Protection
  // ==========================================================================
  console.log('--- CHALLENGE 1A: Line 694 Stale Callback vs Newer Claimed Token ---');
  {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-694-claimed-'));
    const dbPath = path.join(tempDir, 'state.sqlite');
    const cookiePath = path.join(tempDir, 'c.json');
    fs.writeFileSync(cookiePath, '{}');

    const store = new SqliteStore(dbPath, {
      items: [{ id: 'item-adv-1', state: 'pending', payload: { text: 'Challenge 1A payload' } }],
      accounts: [
        { id: 'acct-1', username: 'adv_user1', userId: '101', enabled: true, dailyLimit: 10, cookieFile: cookiePath },
        { id: 'acct-2', username: 'adv_user2', userId: '102', enabled: true, dailyLimit: 10, cookieFile: cookiePath }
      ],
      cycle: { state: 'stopped', runId: null },
      settings: { dailyQuota: 10 },
      posting: {}
    });
    await store.load();

    const publishAdapterFactory = () => ({
      supportsDispatchCallback: true,
      open: async () => ({ slot: 1, identity: { authenticated: true, username: 'adv_user1', userId: '101' } }),
      publish: async () => {
        // Simulate a newer attempt taking over the item in SQLite while the old worker is pending
        await store.update(s => {
          s.items[0].attempt.token = 'NEW-TOKEN-CHALLENGE-1A';
          s.items[0].attempt.phase = 'claimed';
          s.posting.publishingAt = 999999999;
          return s;
        });

        // Old worker returns permanent account failure (banned)
        return { blocked: true, accountFailure: 'banned', reason: 'Account suspended permanently' };
      },
      close: async () => {}
    });

    await run({
      token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
      dataDir: tempDir, api: createMockApi(), vpnManager: createMockVpn(), maxPolls: 0,
      publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
      logger: { log: () => {}, error: () => {} },
      onRuntimeReady: async (ctx) => { await ctx.start({ stopAfterSuccess: true }); await ctx.wait(); }
    });

    const state = await store.load();
    const item = state.items.find(x => x.id === 'item-adv-1');

    // Fencing Assertions:
    assert.strictEqual(item.state, 'processing', 'Item MUST remain processing; stale callback must not revert to pending');
    assert.strictEqual(item.attempt?.token, 'NEW-TOKEN-CHALLENGE-1A', 'New attempt token must remain intact');
    assert.strictEqual(item.attempt?.phase, 'claimed', 'New attempt phase must remain claimed');
    assert.strictEqual(state.posting?.publishingAt, 999999999, 'publishingAt must NOT be cleared by stale callback');
    console.log('✓ PASS 1A: Stale permanent failure at line 694 did not mutate newer claimed token or clear publishingAt.\n');
  }

  console.log('--- CHALLENGE 1B: Line 694 Stale Callback vs Newer Dispatching Token ---');
  {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-694-dispatching-'));
    const dbPath = path.join(tempDir, 'state.sqlite');
    const cookiePath = path.join(tempDir, 'c.json');
    fs.writeFileSync(cookiePath, '{}');

    const store = new SqliteStore(dbPath, {
      items: [{ id: 'item-adv-1b', state: 'pending', payload: { text: 'Challenge 1B payload' } }],
      accounts: [
        { id: 'acct-1', username: 'adv_user1', userId: '101', enabled: true, dailyLimit: 10, cookieFile: cookiePath },
        { id: 'acct-2', username: 'adv_user2', userId: '102', enabled: true, dailyLimit: 10, cookieFile: cookiePath }
      ],
      cycle: { state: 'stopped', runId: null },
      settings: { dailyQuota: 10 },
      posting: {}
    });
    await store.load();

    const publishAdapterFactory = () => ({
      supportsDispatchCallback: true,
      open: async () => ({ slot: 1, identity: { authenticated: true, username: 'adv_user1', userId: '101' } }),
      publish: async () => {
        // Newer worker has already moved phase to 'dispatching' with a fresh token
        await store.update(s => {
          s.items[0].attempt.token = 'NEW-DISPATCHING-TOKEN-1B';
          s.items[0].attempt.phase = 'dispatching';
          s.posting.publishingAt = 888888888;
          return s;
        });

        // Stale worker returns captcha
        return { blocked: true, accountFailure: 'captcha', reason: 'Arkose captcha required' };
      },
      close: async () => {}
    });

    await run({
      token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
      dataDir: tempDir, api: createMockApi(), vpnManager: createMockVpn(), maxPolls: 0,
      publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
      logger: { log: () => {}, error: () => {} },
      onRuntimeReady: async (ctx) => { await ctx.start({ stopAfterSuccess: true }); await ctx.wait(); }
    });

    const state = await store.load();
    const item = state.items.find(x => x.id === 'item-adv-1b');

    // Fencing Assertions:
    assert.strictEqual(item.state, 'processing', 'Dispatching item MUST remain processing; stale callback must not alter state');
    assert.strictEqual(item.attempt?.token, 'NEW-DISPATCHING-TOKEN-1B', 'New dispatching token must remain intact');
    assert.strictEqual(item.attempt?.phase, 'dispatching', 'New attempt phase must remain dispatching');
    assert.strictEqual(state.posting?.publishingAt, 888888888, 'publishingAt must NOT be cleared');
    console.log('✓ PASS 1B: Stale permanent failure at line 694 did not mutate newer dispatching token.\n');
  }

  console.log('--- CHALLENGE 1C: Line 694 Dispatched Item Transitions to Ambiguous (Never Pending) ---');
  {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-694-dispatched-ambiguous-'));
    const dbPath = path.join(tempDir, 'state.sqlite');
    const cookiePath = path.join(tempDir, 'c.json');
    fs.writeFileSync(cookiePath, '{}');

    const store = new SqliteStore(dbPath, {
      items: [{ id: 'item-adv-1c', state: 'pending', payload: { text: 'Challenge 1C payload' } }],
      accounts: [
        { id: 'acct-1', username: 'adv_user1', userId: '101', enabled: true, dailyLimit: 10, cookieFile: cookiePath },
        { id: 'acct-2', username: 'adv_user2', userId: '102', enabled: true, dailyLimit: 10, cookieFile: cookiePath }
      ],
      cycle: { state: 'stopped', runId: null },
      settings: { dailyQuota: 10 },
      posting: {}
    });
    await store.load();

    const publishAdapterFactory = () => ({
      supportsDispatchCallback: true,
      open: async () => ({ slot: 1, identity: { authenticated: true, username: 'adv_user1', userId: '101' } }),
      publish: async ({ onDispatch }) => {
        // Enters dispatch
        await onDispatch({ accountId: 'acct-1' });

        // Then hits permanent failure
        return { blocked: true, accountFailure: 'banned', reason: 'Account suspended after dispatch' };
      },
      close: async () => {}
    });

    await run({
      token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
      dataDir: tempDir, api: createMockApi(), vpnManager: createMockVpn(), maxPolls: 0,
      publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
      logger: { log: () => {}, error: () => {} },
      onRuntimeReady: async (ctx) => { await ctx.start({ stopAfterSuccess: true }); await ctx.wait(); }
    });

    const state = await store.load();
    const item = state.items.find(x => x.id === 'item-adv-1c');

    // Fencing Assertions:
    assert.strictEqual(item.state, 'ambiguous', 'Dispatched item MUST be marked ambiguous, NEVER reverted to pending');
    assert.notStrictEqual(item.state, 'pending', 'Dispatched item MUST NEVER be pending');
    assert.strictEqual(state.posting?.publishingAt, null, 'publishingAt cleared because valid token finished');
    console.log('✓ PASS 1C: Dispatched item entering permanent failure safely mapped to ambiguous.\n');
  }

  // ==========================================================================
  // CHALLENGE 2: Finally Block Fencing (Lines 878-892)
  // ==========================================================================
  console.log('--- CHALLENGE 2A: Finally Block Stale Callback vs Newer Token ---');
  {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-finally-stale-'));
    const dbPath = path.join(tempDir, 'state.sqlite');
    const cookiePath = path.join(tempDir, 'c.json');
    fs.writeFileSync(cookiePath, '{}');

    const store = new SqliteStore(dbPath, {
      items: [{ id: 'item-adv-2a', state: 'pending', payload: { text: 'Challenge 2A payload' } }],
      accounts: [{ id: 'acct-1', username: 'adv_user1', userId: '101', enabled: true, dailyLimit: 10, cookieFile: cookiePath }],
      cycle: { state: 'stopped', runId: null },
      settings: { dailyQuota: 10 },
      posting: {}
    });
    await store.load();

    const publishAdapterFactory = () => ({
      supportsDispatchCallback: true,
      open: async () => ({ slot: 1, identity: { authenticated: true, username: 'adv_user1', userId: '101' } }),
      publish: async () => {
        // While old worker is running, newer token is assigned in SQLite
        await store.update(s => {
          s.items[0].attempt.token = 'NEW-FINALLY-TOKEN-2A';
          s.items[0].attempt.phase = 'claimed';
          s.posting.publishingAt = 777777777;
          return s;
        });

        // Old worker throws error, triggering finally block
        throw Object.assign(new Error('Old worker aborted'), { code: 'ATTEMPT_ABORTED' });
      },
      close: async () => {}
    });

    await run({
      token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
      dataDir: tempDir, api: createMockApi(), vpnManager: createMockVpn(), maxPolls: 0,
      publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
      logger: { log: () => {}, error: () => {} },
      onRuntimeReady: async (ctx) => { await ctx.start({ stopAfterSuccess: true }); await ctx.wait(); }
    });

    const state = await store.load();
    const item = state.items.find(x => x.id === 'item-adv-2a');

    // Fencing Assertions:
    assert.strictEqual(item.state, 'processing', 'Item MUST remain processing; finally block must not revert stale attempt');
    assert.strictEqual(item.attempt?.token, 'NEW-FINALLY-TOKEN-2A', 'Newer token in store must be preserved');
    assert.strictEqual(item.attempt?.phase, 'claimed', 'Newer phase must be preserved');
    assert.strictEqual(state.posting?.publishingAt, 777777777, 'publishingAt must NOT be cleared by stale finally block');
    console.log('✓ PASS 2A: Finally block fenced against stale callback mutation.\n');
  }

  console.log('--- CHALLENGE 2B: Dispatched Item with Post-Dispatch Error (Never Pending) ---');
  {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-finally-crash-'));
    const dbPath = path.join(tempDir, 'state.sqlite');
    const cookiePath = path.join(tempDir, 'c.json');
    fs.writeFileSync(cookiePath, '{}');

    const store = new SqliteStore(dbPath, {
      items: [{ id: 'item-adv-2b', state: 'pending', payload: { text: 'Challenge 2B payload' } }],
      accounts: [{ id: 'acct-1', username: 'adv_user1', userId: '101', enabled: true, dailyLimit: 10, cookieFile: cookiePath }],
      cycle: { state: 'stopped', runId: null },
      settings: { dailyQuota: 10 },
      posting: {}
    });
    await store.load();

    const publishAdapterFactory = () => ({
      supportsDispatchCallback: true,
      open: async () => ({ slot: 1, identity: { authenticated: true, username: 'adv_user1', userId: '101' } }),
      publish: async ({ onDispatch }) => {
        await onDispatch({ accountId: 'acct-1' });

        // Uncaught exception after dispatch
        throw new TypeError('Catastrophic runtime type error after dispatch');
      },
      close: async () => {}
    });

    await run({
      token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
      dataDir: tempDir, api: createMockApi(), vpnManager: createMockVpn(), maxPolls: 0,
      publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
      logger: { log: () => {}, error: () => {} },
      onRuntimeReady: async (ctx) => { await ctx.start({ stopAfterSuccess: true }); await ctx.wait(); }
    });

    const state = await store.load();
    const item = state.items.find(x => x.id === 'item-adv-2b');

    // Fencing Assertions:
    assert.strictEqual(item.state, 'ambiguous', 'Dispatched item MUST be marked ambiguous');
    assert.notStrictEqual(item.state, 'pending', 'Dispatched item MUST NEVER revert to pending');
    assert.strictEqual(state.posting?.publishingAt, null, 'publishingAt cleared on valid token conclusion');
    console.log('✓ PASS 2B: Dispatched item with post-dispatch error safely transitioned to ambiguous, never pending.\n');
  }

  console.log('--- CHALLENGE 2C: Finally Block Fallback When Catch Is Bypassed ---');
  {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-finally-fallback-'));
    const dbPath = path.join(tempDir, 'state.sqlite');
    const cookiePath = path.join(tempDir, 'c.json');
    fs.writeFileSync(cookiePath, '{}');

    let catchBypassed = false;
    const store = new SqliteStore(dbPath, {
      items: [{ id: 'item-adv-2c', state: 'pending', payload: { text: 'Challenge 2C payload' } }],
      accounts: [{ id: 'acct-1', username: 'adv_user1', userId: '101', enabled: true, dailyLimit: 10, cookieFile: cookiePath }],
      cycle: { state: 'stopped', runId: null },
      settings: { dailyQuota: 10 },
      posting: {}
    });
    await store.load();

    let publishAttemptThrew = false;
    let failCatchStore = true;

    const publishAdapterFactory = () => ({
      supportsDispatchCallback: true,
      open: async () => ({ slot: 1, identity: { authenticated: true, username: 'adv_user1', userId: '101' } }),
      publish: async ({ onDispatch }) => {
        await onDispatch({ accountId: 'acct-1' });
        publishAttemptThrew = true;
        throw new Error('Error triggering catch block');
      },
      close: async () => {}
    });

    await run({
      token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
      dataDir: tempDir, api: createMockApi(), vpnManager: createMockVpn(), maxPolls: 0,
      publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
      logger: { log: () => {}, error: () => {} },
      onRuntimeReady: async (ctx) => {
        const originalBotUpdate = ctx.bot.store.update.bind(ctx.bot.store);
        ctx.bot.store.update = async (fn) => {
          return originalBotUpdate(s => {
            const i = s.items?.find(x => x.id === 'item-adv-2c');
            if (publishAttemptThrew && failCatchStore && i?.state === 'processing' && i.attempt?.phase === 'dispatching') {
              failCatchStore = false; // only throw once during catch
              catchBypassed = true;
              throw new Error('Simulated database transient failure inside catch block');
            }
            return fn(s);
          });
        };
        await ctx.start({ stopAfterSuccess: true });
        await ctx.wait();
      }
    });

    const state = await store.load();
    const item = state.items.find(x => x.id === 'item-adv-2c');
    console.log('CHALLENGE 2C ITEM:', JSON.stringify(item));
    assert.strictEqual(catchBypassed, true, 'Catch block store update must have been bypassed');
    assert.strictEqual(item.state, 'ambiguous', 'Finally block must recover and transition item to ambiguous');
    assert.strictEqual(item.reason, 'unresolved_in_finally', 'Finally block must record unresolved_in_finally');
    assert.strictEqual(state.posting?.publishingAt, null, 'publishingAt must be cleared on valid token conclusion');
    console.log('✓ PASS 2C: Finally block successfully resolved bypassed catch to ambiguous with unresolved_in_finally.\n');
  }

  // ==========================================================================
  // CHALLENGE 3: Catch Block Fencing (Lines 798-808)
  // ==========================================================================
  console.log('--- CHALLENGE 3A: Catch Block Stale Callback vs Newer Token ---');
  {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-catch-stale-'));
    const dbPath = path.join(tempDir, 'state.sqlite');
    const cookiePath = path.join(tempDir, 'c.json');
    fs.writeFileSync(cookiePath, '{}');

    const store = new SqliteStore(dbPath, {
      items: [{ id: 'item-adv-3a', state: 'pending', payload: { text: 'Challenge 3A payload' } }],
      accounts: [{ id: 'acct-1', username: 'adv_user1', userId: '101', enabled: true, dailyLimit: 10, cookieFile: cookiePath }],
      cycle: { state: 'stopped', runId: null },
      settings: { dailyQuota: 10 },
      posting: {}
    });
    await store.load();

    const publishAdapterFactory = () => ({
      supportsDispatchCallback: true,
      open: async () => ({ slot: 1, identity: { authenticated: true, username: 'adv_user1', userId: '101' } }),
      publish: async () => {
        // While old worker is running, newer token is assigned in SQLite
        await store.update(s => {
          s.items[0].attempt.token = 'NEW-CATCH-TOKEN-3A';
          s.items[0].attempt.phase = 'claimed';
          s.posting.publishingAt = 666666666;
          return s;
        });

        // Throws error with accountFailure banned
        const err = new Error('Banned in catch');
        err.accountFailure = 'banned';
        throw err;
      },
      close: async () => {}
    });

    await run({
      token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
      dataDir: tempDir, api: createMockApi(), vpnManager: createMockVpn(), maxPolls: 0,
      publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
      logger: { log: () => {}, error: () => {} },
      onRuntimeReady: async (ctx) => { await ctx.start({ stopAfterSuccess: true }); await ctx.wait(); }
    });

    const state = await store.load();
    const item = state.items.find(x => x.id === 'item-adv-3a');

    // Fencing Assertions:
    assert.strictEqual(item.state, 'processing', 'Item MUST remain processing; catch block must not revert stale attempt');
    assert.strictEqual(item.attempt?.token, 'NEW-CATCH-TOKEN-3A', 'Newer token in store must be preserved');
    assert.strictEqual(state.posting?.publishingAt, 666666666, 'publishingAt must NOT be cleared by stale catch block');
    console.log('✓ PASS 3A: Catch block fenced against stale callback mutation.\n');
  }

  console.log('--- CHALLENGE 3B: Catch Block Dispatched Error Maps to Ambiguous (Never Pending) ---');
  {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-catch-dispatched-'));
    const dbPath = path.join(tempDir, 'state.sqlite');
    const cookiePath = path.join(tempDir, 'c.json');
    fs.writeFileSync(cookiePath, '{}');

    const store = new SqliteStore(dbPath, {
      items: [{ id: 'item-adv-3b', state: 'pending', payload: { text: 'Challenge 3B payload' } }],
      accounts: [{ id: 'acct-1', username: 'adv_user1', userId: '101', enabled: true, dailyLimit: 10, cookieFile: cookiePath }],
      cycle: { state: 'stopped', runId: null },
      settings: { dailyQuota: 10 },
      posting: {}
    });
    await store.load();

    const publishAdapterFactory = () => ({
      supportsDispatchCallback: true,
      open: async () => ({ slot: 1, identity: { authenticated: true, username: 'adv_user1', userId: '101' } }),
      publish: async ({ onDispatch }) => {
        await onDispatch({ accountId: 'acct-1' });

        const err = new Error('Dispatched account failure');
        err.accountFailure = 'captcha';
        throw err;
      },
      close: async () => {}
    });

    await run({
      token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
      dataDir: tempDir, api: createMockApi(), vpnManager: createMockVpn(), maxPolls: 0,
      publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
      logger: { log: () => {}, error: () => {} },
      onRuntimeReady: async (ctx) => { await ctx.start({ stopAfterSuccess: true }); await ctx.wait(); }
    });

    const state = await store.load();
    const item = state.items.find(x => x.id === 'item-adv-3b');

    // Fencing Assertions:
    assert.strictEqual(item.state, 'ambiguous', 'Dispatched item encountering error in catch MUST transition to ambiguous');
    assert.notStrictEqual(item.state, 'pending', 'Dispatched item MUST NEVER revert to pending');
    assert.strictEqual(state.posting?.publishingAt, null, 'publishingAt cleared on valid token conclusion');
    console.log('✓ PASS 3B: Dispatched item encountering error in catch cleanly transitioned to ambiguous.\n');
  }

  console.log('================================================================');
  console.log('ALL ADVERSARIAL CHALLENGES PASSED EMPIRICALLY:');
  console.log('- Line 694 fenced against stale callbacks and protects dispatching items');
  console.log('- Finally block fenced against stale callbacks and protects dispatching items');
  console.log('- Catch block fenced against stale callbacks and protects dispatching items');
  console.log('- Invariant verified: NO item crossing dispatching ever reverts to pending');
  console.log('================================================================');
}

runAdversarialChallenges().catch(err => {
  console.error('ADVERSARIAL CHALLENGE FAILED:', err);
  process.exit(1);
});
