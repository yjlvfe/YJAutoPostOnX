#!/usr/bin/env node
'use strict';
/**
 * Standalone Verification Script for Stale Attempt Token Fencing in runner.js:
 * Proves:
 * 1. onDispatch fence rejects stale attempt tokens with DISPATCH_REJECTED and halts dispatch.
 * 2. Post-publish state transition rejects stale attempt tokens and prevents publication/quota corruption.
 * 3. Worker error-handling rollback ignores stale attempt tokens, protecting newer active claims.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const { run } = require(path.join(ROOT, 'src/runner'));
const { SqliteStore } = require(path.join(ROOT, 'src/sqliteStore'));

async function runStaleTokenVerification() {
  console.log('=== VERIFICATION: STALE ATTEMPT TOKEN FENCING IN RUNNER.JS ===\n');

  // --------------------------------------------------------------------------
  // Scenario 1: Stale Token Rejection at onDispatch Fence
  // --------------------------------------------------------------------------
  console.log('--- Step 1: Pre-Dispatch Fence Rejection (DISPATCH_REJECTED) ---');
  {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-dispatch-test-'));
    const dbPath = path.join(tempDir, 'state.sqlite');
    const store = new SqliteStore(dbPath, {
      items: [{ id: 'item-stale-1', state: 'pending', payload: { text: 'Dispatch fence test' } }],
      accounts: [{ id: 'acct-1', username: 'testuser', userId: '123', enabled: true, dailyLimit: 10, cookieFile: path.join(tempDir, 'c.json') }],
      cycle: { state: 'stopped', runId: null },
      settings: { dailyQuota: 10 },
      posting: {}
    });
    await store.load();
    fs.writeFileSync(path.join(tempDir, 'c.json'), '{}');

    let dispatchRejectedCaught = false;

    const publishAdapterFactory = () => ({
      supportsDispatchCallback: true,
      open: async () => ({ slot: 1, identity: { authenticated: true, username: 'testuser', userId: '123' } }),
      publish: async ({ onDispatch }) => {
        // Invalidate attempt token prior to onDispatch invocation (simulating a stale attempt)
        await store.update(s => {
          s.items[0].attempt.token = 'superseded-token-111';
          return s;
        });

        try {
          await onDispatch({ accountId: 'acct-1' });
        } catch (err) {
          if (err.code === 'DISPATCH_REJECTED') {
            dispatchRejectedCaught = true;
          }
          throw err;
        }
        return { published: true, url: 'https://x.com/testuser/status/1' };
      },
      close: async () => {}
    });

    await run({
      token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
      dataDir: tempDir,
      api: { getMe: async () => ({ id: 1 }), sendMessage: async () => ({}), sendRichMessage: async () => ({}), editMessageText: async () => ({}), deleteMessage: async () => {}, answerCallbackQuery: async () => {}, getUpdates: async () => [], sendDocument: async () => ({}) },
      vpnManager: { ensure: async () => ({ exitIp: '1.2.3.4', proxy: 'socks5h://127.0.0.1:1080' }), health: async () => ({ healthy: true }) },
      maxPolls: 0, publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
      logger: { log: () => {}, error: () => {} },
      onRuntimeReady: async (ctx) => { await ctx.start({ stopAfterSuccess: true }); await ctx.wait(); }
    });

    const finalState = await store.load();
    const item = finalState.items.find(x => x.id === 'item-stale-1');
    assert.strictEqual(dispatchRejectedCaught, true, 'onDispatch must throw DISPATCH_REJECTED for stale token');
    assert.strictEqual(item.attempt?.phase, 'claimed', 'Phase must NOT advance to dispatching on stale token');
    assert.strictEqual(item.attempt?.token, 'superseded-token-111', 'Superseded token must remain intact in store');
    console.log('✓ PASS: Stale attempt token blocked at pre-dispatch boundary.\n');
  }

  // --------------------------------------------------------------------------
  // Scenario 2: Stale Token Rejection at Post-Publish State Transition
  // --------------------------------------------------------------------------
  console.log('--- Step 2: Post-Publish State Transition Fencing ---');
  {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-publish-test-'));
    const dbPath = path.join(tempDir, 'state.sqlite');
    const store = new SqliteStore(dbPath, {
      items: [{ id: 'item-stale-2', state: 'pending', payload: { text: 'Post-publish fence test' } }],
      accounts: [{ id: 'acct-1', username: 'testuser', userId: '123', enabled: true, dailyLimit: 10, cookieFile: path.join(tempDir, 'c.json') }],
      cycle: { state: 'stopped', runId: null },
      settings: { dailyQuota: 10 },
      posting: {}
    });
    await store.load();
    fs.writeFileSync(path.join(tempDir, 'c.json'), '{}');

    const publishAdapterFactory = () => ({
      supportsDispatchCallback: true,
      open: async () => ({ slot: 1, identity: { authenticated: true, username: 'testuser', userId: '123' } }),
      publish: async ({ onDispatch }) => {
        // Successful onDispatch handshake
        await onDispatch({ accountId: 'acct-1' });

        // While network publish is in-flight, token is rotated in SQLite by timeout or external claim
        await store.update(s => {
          s.items[0].attempt.token = 'superseded-token-222';
          return s;
        });

        // Stale worker finishes and returns publication result
        return { published: true, url: 'https://x.com/testuser/status/2', id: '2' };
      },
      close: async () => {}
    });

    await run({
      token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
      dataDir: tempDir,
      api: { getMe: async () => ({ id: 1 }), sendMessage: async () => ({}), sendRichMessage: async () => ({}), editMessageText: async () => ({}), deleteMessage: async () => {}, answerCallbackQuery: async () => {}, getUpdates: async () => [], sendDocument: async () => ({}) },
      vpnManager: { ensure: async () => ({ exitIp: '1.2.3.4', proxy: 'socks5h://127.0.0.1:1080' }), health: async () => ({ healthy: true }) },
      maxPolls: 0, publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
      logger: { log: () => {}, error: () => {} },
      onRuntimeReady: async (ctx) => { await ctx.start({ stopAfterSuccess: true }); await ctx.wait(); }
    });

    const finalState = await store.load();
    const item = finalState.items.find(x => x.id === 'item-stale-2');
    assert.strictEqual(item.state, 'processing', 'Item must NOT transition to published when token is stale');
    assert.strictEqual(item.url, undefined, 'URL must not be recorded from stale worker');
    assert.strictEqual(item.attempt?.token, 'superseded-token-222', 'Superseded token must not be erased');
    assert.strictEqual(finalState.posting?.quota, undefined, 'Quota must NOT be incremented by stale commit');
    console.log('✓ PASS: Post-publish state transition safely guarded against stale token.\n');
  }

  // --------------------------------------------------------------------------
  // Scenario 3: Stale Worker Error Cleanup Fencing
  // --------------------------------------------------------------------------
  console.log('--- Step 3: Stale Worker Exception Rollback Fencing ---');
  {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-cleanup-test-'));
    const dbPath = path.join(tempDir, 'state.sqlite');
    const store = new SqliteStore(dbPath, {
      items: [{ id: 'item-stale-3', state: 'pending', payload: { text: 'Error cleanup fence test' } }],
      accounts: [{ id: 'acct-1', username: 'testuser', userId: '123', enabled: true, dailyLimit: 10, cookieFile: path.join(tempDir, 'c.json') }],
      cycle: { state: 'stopped', runId: null },
      settings: { dailyQuota: 10 },
      posting: {}
    });
    await store.load();
    fs.writeFileSync(path.join(tempDir, 'c.json'), '{}');

    const publishAdapterFactory = () => ({
      supportsDispatchCallback: true,
      open: async () => ({ slot: 1, identity: { authenticated: true, username: 'testuser', userId: '123' } }),
      publish: async ({ onDispatch }) => {
        await onDispatch({ accountId: 'acct-1' });

        // Token rotated in database to simulate claim by new worker
        await store.update(s => {
          s.items[0].attempt.token = 'superseded-token-333';
          return s;
        });

        // Worker fails with network error
        throw Object.assign(new Error('Simulated socket drop'), { code: 'ECONNRESET' });
      },
      close: async () => {}
    });

    await run({
      token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
      dataDir: tempDir,
      api: { getMe: async () => ({ id: 1 }), sendMessage: async () => ({}), sendRichMessage: async () => ({}), editMessageText: async () => ({}), deleteMessage: async () => {}, answerCallbackQuery: async () => {}, getUpdates: async () => [], sendDocument: async () => ({}) },
      vpnManager: { ensure: async () => ({ exitIp: '1.2.3.4', proxy: 'socks5h://127.0.0.1:1080' }), health: async () => ({ healthy: true }) },
      maxPolls: 0, publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
      logger: { log: () => {}, error: () => {} },
      onRuntimeReady: async (ctx) => { await ctx.start({ stopAfterSuccess: true }); await ctx.wait(); }
    });

    const finalState = await store.load();
    const item = finalState.items.find(x => x.id === 'item-stale-3');
    assert.strictEqual(item.state, 'processing', 'Stale failure must NOT mutate item state to ambiguous or pending');
    assert.strictEqual(item.attempt?.token, 'superseded-token-333', 'Active claim token must be preserved');
    console.log('✓ PASS: Stale worker error handler blocked from corrupting active attempt.\n');
  }

  console.log('=== ALL 3 STALE ATTEMPT TOKEN SCENARIOS COMPLETED SUCCESSFULLY ===');
}

runStaleTokenVerification().catch(err => {
  console.error('VERIFICATION FAILED:', err);
  process.exit(1);
});
