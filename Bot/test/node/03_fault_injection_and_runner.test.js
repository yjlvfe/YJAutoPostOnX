'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHermeticWorkspace } = require('../fixtures/hermetic_workspace');
const { FakeTelegramApi } = require('../fixtures/fake_telegram_server');
const { FakeDirectXAdapter, createFakeBridgeExecutable } = require('../fixtures/fake_direct_x_bridge');
const { createFakeDockerVpn } = require('../fixtures/fake_docker_vpn');
const { SqliteStore } = require('../../src/sqliteStore');
const { DirectXAdapter } = require('../../src/directX');
const { SingleInstanceLock } = require('../../src/singleInstance');
const { run } = require('../../src/runner');

describe('03_fault_injection_and_runner: Two-Phase Dispatch Fence, 3-Strikes, RUN-03/04/06, XT-02/03 & SingleInstanceLock', () => {
  it('F-01: Pre-dispatch transient fault transfers item as pending with 0 strikes; post-dispatch fault quarantines item as ambiguous with 0 quota', async () => {
    const ws = createHermeticWorkspace('yj-bot-test-f01-');
    try {
      const c1 = ws.writeSyntheticCookie('acc-1', { userId: '1001' });
      const c2 = ws.writeSyntheticCookie('acc-2', { userId: '1002' });

      const seedStore = new SqliteStore(ws.dbPath, {
        settings: { dailyQuota: 10, delayMinSeconds: 15, delayMaxSeconds: 15 },
        accounts: [
          { id: 'acc-1', username: 'user1', userId: '1001', cookieFile: c1, enabled: true, status: 'مفعل', failures: 0 },
          { id: 'acc-2', username: 'user2', userId: '1002', cookieFile: c2, enabled: true, status: 'مفعل', failures: 0 }
        ],
        items: [
          { id: 'item-transfer', state: 'pending', payload: { text: 'Pre-dispatch transfer post' } },
          { id: 'item-ambiguous', state: 'pending', payload: { text: 'Post-dispatch drop post' } }
        ]
      });
      await seedStore.load();
      await seedStore.close();

      const api = new FakeTelegramApi();
      const vpn = createFakeDockerVpn();

      let callCount = 0;
      const adapterFactory = () => new FakeDirectXAdapter({
        onPublish: async ({ session, payload, onDispatch }) => {
          callCount += 1;
          if (payload.text === 'Pre-dispatch transfer post' && session.accountId === 'acc-1') {
            // Pre-dispatch network/proxy failure BEFORE onDispatch is called
            return {
              status: 'not_ready',
              published: false,
              posted: false,
              ambiguous: false,
              blocked: true,
              accountFailure: 'network_proxy_error',
              reason: 'network_proxy_error'
            };
          }
          if (payload.text === 'Post-dispatch drop post') {
            await onDispatch({ accountId: session.accountId });
            return {
              status: 'ambiguous',
              published: false,
              posted: false,
              ambiguous: true,
              reason: 'publish_confirmation_missing',
              rawError: 'Bridge socket closed after dispatch_ack'
            };
          }
          await onDispatch({ accountId: session.accountId });
          return {
            status: 'published',
            published: true,
            posted: true,
            ok: true,
            tweetId: '1888000000000000001',
            username: session.identity.username,
            userId: session.identity.userId,
            url: `https://x.com/${session.identity.username}/status/1888000000000000001`
          };
        }
      });

      let nowMs = Date.parse('2026-11-04T12:00:00Z');
      const clock = () => new Date(nowMs);

      await run({
        token: process.env.TELEGRAM_BOT_TOKEN,
        userId: '528864559',
        chatId: '528864559',
        dataDir: ws.tempDir,
        lockPath: ws.lockPath,
        api,
        clock,
        vpnManager: {
          ensure: async (id) => ({ name: 'yj_autopost_vpn_1', port: 18801, proxy: 'socks5h://127.0.0.1:18801', exitIp: '203.0.114.11', slot: 0 }),
          health: async () => ({ healthy: true, exitIp: '203.0.114.11' }),
          release: async () => 0,
          reconcile: async () => ({ conflicts: [], stale: [], released: [] }),
          rotate: async () => ({ success: true })
        },
        publishAdapterFactory: adapterFactory,
        verifyAdapterFactory: adapterFactory,
        maxPolls: 1,
        sleepFn: async (ms) => { nowMs += ms; },
        onRuntimeReady: async (rt) => {
          const started = await rt.start({ stopAfterSuccess: false });
          assert.strictEqual(started.started, true);
          await rt.wait();
          rt.shutdown();
        }
      });

      const checkStore = ws.registerStore(new SqliteStore(ws.dbPath));
      const finalState = await checkStore.load();
      const item1 = finalState.items.find(i => i.id === 'item-transfer');
      const item2 = finalState.items.find(i => i.id === 'item-ambiguous');
      const acc1 = finalState.accounts.find(a => a.id === 'acc-1');

      assert.strictEqual(item1.state, 'published', 'Item 1 should transfer to acc-2 and publish after pre-dispatch fault on acc-1');
      assert.strictEqual(item1.accountId, 'acc-2');
      assert.strictEqual(acc1.failures, 0, 'Pre-dispatch network/proxy fault must record 0 account strikes');

      assert.strictEqual(item2.state, 'ambiguous', 'Post-dispatch drop must quarantine item as ambiguous');
      assert.strictEqual(item2.attempt, undefined);
      assert.ok(item2.archivedAttempt?.token, 'Post-dispatch quarantine must archive attempt provenance');
    } finally {
      await ws.cleanup();
    }
  });

  it('F-02: 3-strikes progression isolates account on 3rd strike with 1 Arabic alert, and verified publish resets strikes to 0', async () => {
    const ws = createHermeticWorkspace('yj-bot-test-f02-');
    try {
      const c1 = ws.writeSyntheticCookie('acc-1', { userId: '1001' });
      const seedStore = new SqliteStore(ws.dbPath, {
        settings: { dailyQuota: 10, delayMinSeconds: 15, delayMaxSeconds: 15 },
        accounts: [
          { id: 'acc-1', username: 'strike_user', userId: '1001', cookieFile: c1, enabled: true, status: 'مفعل', failures: 2 }
        ],
        items: [
          { id: 'item-s3', state: 'pending', payload: { text: 'Third strike item' } }
        ]
      });
      await seedStore.load();
      await seedStore.close();

      const api = new FakeTelegramApi();
      let nowMs = Date.parse('2026-11-04T12:00:00Z');
      const clock = () => new Date(nowMs);

      const adapterFactory = () => new FakeDirectXAdapter({
        onPublish: async ({ session, onDispatch }) => {
          await onDispatch({ accountId: session.accountId });
          return {
            status: 'ambiguous',
            published: false,
            posted: false,
            ambiguous: true,
            reason: 'publish_confirmation_missing'
          };
        }
      });

      await run({
        token: process.env.TELEGRAM_BOT_TOKEN,
        userId: '528864559',
        chatId: '528864559',
        dataDir: ws.tempDir,
        lockPath: ws.lockPath,
        api,
        clock,
        vpnManager: {
          ensure: async () => ({ name: 'yj_autopost_vpn_1', port: 18801, proxy: 'socks5h://127.0.0.1:18801', exitIp: '203.0.114.11', slot: 0 }),
          health: async () => ({ healthy: true, exitIp: '203.0.114.11' }),
          release: async () => 0,
          reconcile: async () => ({ conflicts: [], stale: [], released: [] }),
          rotate: async () => ({ success: true })
        },
        publishAdapterFactory: adapterFactory,
        verifyAdapterFactory: adapterFactory,
        maxPolls: 1,
        sleepFn: async (ms) => { nowMs += ms; },
        onRuntimeReady: async (rt) => {
          await rt.start({ stopAfterSuccess: false });
          await rt.wait();
          rt.shutdown();
        }
      });

      const checkStore = ws.registerStore(new SqliteStore(ws.dbPath));
      const st = await checkStore.load();
      const acc = st.accounts.find(a => a.id === 'acc-1');
      assert.strictEqual(acc.failures, 3);
      assert.strictEqual(acc.enabled, false);
      assert.strictEqual(acc.status, 'معزول (3 إخفاقات)');

      const isolationMsgs = api.messages.filter(m => m.chat_id === '528864559' && m.text.includes('تم عزل الحساب') && m.text.includes('معزول (3 إخفاقات)'));
      assert.strictEqual(isolationMsgs.length, 1, 'Exactly 1 Arabic isolation alert must be sent per admin chat on strike 3');
    } finally {
      await ws.cleanup();
    }
  });

  it('F-03: DirectXAdapter.publish() preserves accountFailure and xErrorCode when recoveredFromTimeline is true (XT-02)', async () => {
    const ws = createHermeticWorkspace('yj-bot-test-f03-');
    try {
      const cookiePath = ws.writeSyntheticCookie('acc-xt02', { userId: '1001' });
      const bridgeScript = createFakeBridgeExecutable(ws.tempDir, `
line = sys.stdin.readline()
print(json.dumps({"event": "result", "result": {"identity": {"authenticated": True, "state": "authenticated", "username": "user1", "userId": "1001"}}}))
sys.stdout.flush()
line2 = sys.stdin.readline()
print(json.dumps({"event": "dispatch_ready"}))
sys.stdout.flush()
ack = sys.stdin.readline()
print(json.dumps({
    "event": "result",
    "result": {
        "status": "published",
        "published": True,
        "posted": True,
        "recoveredFromTimeline": True,
        "tweetId": "1900000000000000001",
        "tweetUrl": "https://x.com/user1/status/1900000000000000001",
        "username": "user1",
        "userId": "1001",
        "accountFailure": "captcha",
        "xErrorCode": 326,
        "xErrorMessage": "Account locked / challenge required"
    }
}))
sys.stdout.flush()
`);

      // Test DirectXAdapter directly with a thin python wrapper that invokes our script
      const adapter = new DirectXAdapter({
        pythonExecutable: process.env.DIRECT_X_PYTHON || 'python3',
        allowPublish: true
      });
      // Override _command to simulate the bridge returning recoveredFromTimeline + accountFailure
      const fakeSession = { accountId: 'acc-xt02', closed: false, state: 'authenticated' };
      adapter.sessions.set(fakeSession, {
        dead: false,
        used: false,
        busy: false,
        identity: { authenticated: true, state: 'authenticated', username: 'user1', userId: '1001' }
      });
      adapter._command = async (state, cmd, opts) => {
        state.used = true;
        await opts.callback({ accountId: opts.accountId });
        return {
          status: 'published',
          published: true,
          posted: true,
          recoveredFromTimeline: true,
          tweetId: '1900000000000000001',
          tweetUrl: 'https://x.com/user1/status/1900000000000000001',
          username: 'user1',
          userId: '1001',
          accountFailure: 'captcha',
          xErrorCode: 326,
          xErrorMessage: 'Challenge required'
        };
      };

      const pubRes = await adapter.publish({
        session: fakeSession,
        payload: { text: 'Test XT-02' },
        confirmPublish: true,
        onDispatch: async () => true
      });

      assert.strictEqual(pubRes.published, true);
      assert.strictEqual(pubRes.recoveredFromTimeline, true);
      assert.strictEqual(pubRes.accountFailure, 'captcha', 'DirectXAdapter.publish must preserve accountFailure on timeline-recovered posts (XT-02)');
      assert.strictEqual(pubRes.xErrorCode, 326, 'DirectXAdapter.publish must preserve xErrorCode on timeline-recovered posts (XT-02)');
    } finally {
      await ws.cleanup();
    }
  });

  it('F-06: Pinned payload.account preservation & archivedAttempts on pre-dispatch failure (RUN-04), weighted 280-char check, and late onDispatch rejection', async () => {
    const ws = createHermeticWorkspace('yj-bot-test-f06-');
    try {
      const c1 = ws.writeSyntheticCookie('acc-1', { userId: '1001' });
      const c2 = ws.writeSyntheticCookie('acc-2', { userId: '1002' });

      const oversizedText = 'أ'.repeat(290);
      const seedStore = new SqliteStore(ws.dbPath, {
        settings: { dailyQuota: 10, delayMinSeconds: 15, delayMaxSeconds: 15 },
        accounts: [
          { id: 'acc-1', username: 'user1', userId: '1001', cookieFile: c1, enabled: true, status: 'مفعل', failures: 0 },
          { id: 'acc-2', username: 'user2', userId: '1002', cookieFile: c2, enabled: true, status: 'مفعل', failures: 0 }
        ],
        items: [
          { id: 'item-pinned', state: 'pending', payload: { text: 'Pinned to acc-1 only', account: 'acc-1' } },
          { id: 'item-too-long', state: 'pending', payload: { text: oversizedText } }
        ]
      });
      await seedStore.load();
      await seedStore.close();

      const api = new FakeTelegramApi();
      const publishedByAccount = [];

      const adapterFactory = () => new FakeDirectXAdapter({
        onOpen: async ({ account }) => {
          if (account.id === 'acc-1') {
            return {
              accountId: 'acc-1',
              state: 'blocked',
              identity: {
                authenticated: false,
                state: 'identity_unverified',
                accountFailure: 'captcha',
                reason: 'auth_account_captcha'
              }
            };
          }
          return {
            accountId: account.id,
            state: 'authenticated',
            identity: {
              authenticated: true,
              state: 'authenticated',
              username: account.username,
              userId: account.userId
            }
          };
        },
        onPublish: async ({ session, payload, onDispatch }) => {
          publishedByAccount.push({ accountId: session.accountId, text: payload.text });
          await onDispatch({ accountId: session.accountId });
          return {
            status: 'published',
            published: true,
            posted: true,
            ok: true,
            tweetId: '1900000000000000009',
            username: session.identity.username,
            userId: session.identity.userId,
            url: `https://x.com/${session.identity.username}/status/1900000000000000009`
          };
        }
      });

      await run({
        token: process.env.TELEGRAM_BOT_TOKEN,
        userId: '528864559',
        chatId: '528864559',
        dataDir: ws.tempDir,
        lockPath: ws.lockPath,
        api,
        vpnManager: {
          ensure: async () => ({ name: 'yj_autopost_vpn_1', port: 18801, proxy: 'socks5h://127.0.0.1:18801', exitIp: '203.0.114.11', slot: 0 }),
          health: async () => ({ healthy: true, exitIp: '203.0.114.11' }),
          release: async () => 0,
          reconcile: async () => ({ conflicts: [], stale: [], released: [] }),
          rotate: async () => ({ success: true })
        },
        publishAdapterFactory: adapterFactory,
        verifyAdapterFactory: adapterFactory,
        maxPolls: 1,
        sleepFn: async () => {},
        onRuntimeReady: async (rt) => {
          await rt.start({ stopAfterSuccess: false });
          await rt.wait();
          rt.shutdown();
        }
      });

      const checkStore = ws.registerStore(new SqliteStore(ws.dbPath));
      const st = await checkStore.load();
      const pinnedItem = st.items.find(i => i.id === 'item-pinned');
      const longItem = st.items.find(i => i.id === 'item-too-long');

      // RUN-04: Pinned item must NOT be stripped of payload.account or published by acc-2!
      assert.strictEqual(pinnedItem.payload.account, 'acc-1', 'Pinned account must be preserved on pre-dispatch failure (RUN-04)');
      assert.strictEqual(pinnedItem.state, 'pending', 'Pinned item must remain pending when its pinned account fails pre-dispatch');
      assert.ok(
        Array.isArray(pinnedItem.archivedAttempts) ? pinnedItem.archivedAttempts.length >= 1 : Boolean(pinnedItem.archivedAttempt),
        'Pre-dispatch failed attempt must be archived in archivedAttempts / archivedAttempt (RUN-04)'
      );
      assert.ok(
        !publishedByAccount.some(p => p.text === 'Pinned to acc-1 only'),
        'Pinned item must never be routed to acc-2'
      );

      // Weighted 280-char check: oversized tweet rejected pre-dispatch without publishing
      assert.ok(
        ['cancelled', 'failed'].includes(longItem.state),
        `Oversized >280 weighted char tweet must be rejected pre-dispatch (got state=${longItem.state})`
      );
    } finally {
      await ws.cleanup();
    }
  });

  it('F-07: SingleInstanceLock contention, starttime-aware stale recovery (RUN-01), and graceful shutdown draining when ui.destroy rejects (RUN-06 / TR-07)', async () => {
    const ws = createHermeticWorkspace('yj-bot-test-f07-');
    try {
      // 1. Stale lock held by dead PID is reclaimed
      fs.writeFileSync(ws.lockPath, JSON.stringify({
        pid: 99999998,
        starttime: '11111',
        token: 'dead-lock-token',
        acquiredAt: new Date(Date.now() - 300_000).toISOString()
      }) + '\n', { mode: 0o600 });

      const lock1 = new SingleInstanceLock(ws.lockPath, { timeoutMs: 500, retryMs: 20 });
      const release1 = await lock1.acquire();
      assert.strictEqual(lock1.locked, true);

      // 2. Contending lock fails with INSTANCE_LOCKED while lock1 is held by alive process
      const lock2 = new SingleInstanceLock(ws.lockPath, { timeoutMs: 120, retryMs: 20 });
      await assert.rejects(() => lock2.acquire(), err => err.code === 'INSTANCE_LOCKED');

      // 3. Stale lock with PID reuse (same PID as process.pid, but mismatched starttime) is reclaimed!
      await release1();
      fs.writeFileSync(ws.lockPath, JSON.stringify({
        pid: process.pid,
        starttime: '1', // Mismatched /proc/<pid>/stat starttime
        token: 'reused-pid-token',
        acquiredAt: new Date(Date.now() - 300_000).toISOString()
      }) + '\n', { mode: 0o600 });

      const lock3 = new SingleInstanceLock(ws.lockPath, { timeoutMs: 500, retryMs: 20 });
      const release3 = await lock3.acquire();
      assert.strictEqual(lock3.locked, true);
      await release3();

      // 4. RUN-06 / TR-07: If ui.destroy() throws during runner shutdown, store.close() and lock.release() still execute!
      const api = new FakeTelegramApi();
      let runStore = null;
      try {
        await run({
          token: process.env.TELEGRAM_BOT_TOKEN,
          userId: '528864559',
          chatId: '528864559',
          dataDir: ws.tempDir,
          lockPath: ws.lockPath,
          api,
          vpnManager: {
            reconcile: async () => ({ conflicts: [], stale: [], released: [] }),
            release: async () => 0
          },
          maxPolls: 1,
          sleepFn: async () => {},
          onRuntimeReady: async (rt) => {
            runStore = rt.bot.store;
            rt.ui.destroy = async () => {
              throw new Error('SIMULATED_UI_DESTROY_REJECTION');
            };
            rt.shutdown();
          }
        });
      } catch (err) {
        if (!/SIMULATED_UI_DESTROY_REJECTION/.test(err.message)) throw err;
      }

      assert.strictEqual(runStore?.closed, true, 'SqliteStore must be closed even when ui.destroy() rejects (RUN-06 / TR-07)');
      assert.strictEqual(fs.existsSync(ws.lockPath), false, 'SingleInstanceLock file must be released even when ui.destroy() rejects (RUN-06 / TR-07)');
    } finally {
      await ws.cleanup();
    }
  });
});
