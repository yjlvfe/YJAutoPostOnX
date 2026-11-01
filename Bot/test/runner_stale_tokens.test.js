'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const { run } = require(path.join(ROOT, 'src/runner'));
const { SqliteStore } = require(path.join(ROOT, 'src/sqliteStore'));

describe('Runner Stale Attempt Token Fencing', () => {
  test('rejects stale attempt token at onDispatch fence with DISPATCH_REJECTED', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-stale-dispatch-'));
    const dbPath = path.join(tempDir, 'state.sqlite');
    const store = new SqliteStore(dbPath, {
      items: [{ id: 'item-1', state: 'pending', payload: { text: 'Dispatch fence' } }],
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
        await store.update(s => {
          s.items[0].attempt.token = 'superseded-token-111';
          return s;
        });
        try {
          await onDispatch({ accountId: 'acct-1' });
        } catch (err) {
          if (err.code === 'DISPATCH_REJECTED') dispatchRejectedCaught = true;
          throw err;
        }
        return { published: true, url: 'https://x.com/status/1' };
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
    const item = finalState.items.find(x => x.id === 'item-1');
    assert.strictEqual(dispatchRejectedCaught, true);
    assert.strictEqual(item.attempt?.phase, 'claimed');
    assert.strictEqual(item.attempt?.token, 'superseded-token-111');
  });

  test('blocks state transition and quota increment when attempt token is stale after publish', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-stale-publish-'));
    const dbPath = path.join(tempDir, 'state.sqlite');
    const store = new SqliteStore(dbPath, {
      items: [{ id: 'item-2', state: 'pending', payload: { text: 'Publish fence' } }],
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
        await store.update(s => {
          s.items[0].attempt.token = 'superseded-token-222';
          return s;
        });
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
    const item = finalState.items.find(x => x.id === 'item-2');
    assert.strictEqual(item.state, 'processing');
    assert.strictEqual(item.url, undefined);
    assert.strictEqual(item.attempt?.token, 'superseded-token-222');
    assert.strictEqual(finalState.posting?.quota, undefined);
  });

  test('blocks stale worker error cleanup from rolling back or wiping newer claim', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-stale-cleanup-'));
    const dbPath = path.join(tempDir, 'state.sqlite');
    const store = new SqliteStore(dbPath, {
      items: [{ id: 'item-3', state: 'pending', payload: { text: 'Cleanup fence' } }],
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
        await store.update(s => {
          s.items[0].attempt.token = 'superseded-token-333';
          return s;
        });
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
    const item = finalState.items.find(x => x.id === 'item-3');
    assert.strictEqual(item.state, 'processing');
    assert.strictEqual(item.attempt?.token, 'superseded-token-333');
  });
});
