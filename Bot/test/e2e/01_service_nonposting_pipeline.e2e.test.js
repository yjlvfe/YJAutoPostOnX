'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHermeticWorkspace, snapshotProductionFiles, verifyProductionSnapshot } = require('../fixtures/hermetic_workspace');
const { FakeTelegramApi } = require('../fixtures/fake_telegram_server');
const { FakeDirectXAdapter } = require('../fixtures/fake_direct_x_bridge');
const { createFakeDockerVpn } = require('../fixtures/fake_docker_vpn');
const { SqliteStore } = require('../../src/sqliteStore');
const { riyadhDay } = require('../../src/quota');
const { run } = require('../../src/runner');

describe('01_service_nonposting_pipeline.e2e: Full Nonposting Service Lifecycle, Multi-Account Rotation & Dual-Chat CSV Export', () => {
  it('E2E-01: Executes startup recovery, /start dashboard, readiness, start notification, 3-account cycle rotation, dual-chat CSV export (528864559 & 5535435580), and clean shutdown', async () => {
    const preProd = snapshotProductionFiles();
    const ws = createHermeticWorkspace('yj-bot-test-e2e01-');
    try {
      const c1 = ws.writeSyntheticCookie('acc-1', { userId: '1001' });
      const c2 = ws.writeSyntheticCookie('acc-2', { userId: '1002' });
      const c3 = ws.writeSyntheticCookie('acc-3', { userId: '1003' });

      const now = new Date('2026-11-04T12:00:00.000Z');
      const todayRiyadh = riyadhDay(now);

      const seedStore = new SqliteStore(ws.dbPath, {
        settings: {
          dailyQuota: 10,
          delayMinSeconds: 15,
          delayMaxSeconds: 15
        },
        accounts: [
          { id: 'acc-1', username: 'alpha_user', userId: '1001', cookieFile: c1, enabled: true, status: 'مفعل', failures: 0 },
          { id: 'acc-2', username: 'beta_user', userId: '1002', cookieFile: c2, enabled: true, status: 'مفعل', failures: 0 },
          { id: 'acc-3', username: 'gamma_user', userId: '1003', cookieFile: c3, enabled: true, status: 'مفعل', failures: 0 }
        ],
        items: [
          {
            id: 'item-claimed-recover',
            state: 'processing',
            payload: { text: 'Recovered pre-dispatch post 1' },
            attempt: { phase: 'claimed', token: 'tok-pre-1', accountId: 'acc-1' }
          },
          {
            id: 'item-dispatching-quarantine',
            state: 'processing',
            payload: { text: 'Interrupted post-dispatch item' },
            attempt: { phase: 'dispatching', token: 'tok-post-1', accountId: 'acc-1' }
          },
          {
            id: 'item-pending-2',
            state: 'pending',
            payload: { text: 'Fresh pending post 2' }
          },
          {
            id: 'item-pending-3',
            state: 'pending',
            payload: { text: 'Fresh pending post 3' }
          }
        ]
      });
      await seedStore.load();
      await seedStore.close();

      const api = new FakeTelegramApi();
      // Push /start command from owner
      api.pushCommand({ chatId: '528864559', userId: '528864559', text: '/start' });

      const dispatchOrder = [];
      let seq = 0;
      const adapterFactory = () => new FakeDirectXAdapter({
        onPublish: async ({ session, payload, onDispatch }) => {
          const ack = await onDispatch({ accountId: session.accountId });
          assert.strictEqual(ack, true, 'onDispatch fence must return true');
          dispatchOrder.push({ accountId: session.accountId, text: payload.text });
          seq += 1;
          const tid = String(1950000000000000000n + BigInt(seq));
          return {
            status: 'published',
            published: true,
            posted: true,
            ok: true,
            tweetId: tid,
            username: session.identity.username,
            userId: session.identity.userId,
            url: `https://x.com/${session.identity.username}/status/${tid}`
          };
        }
      });

      let nowMs = now.getTime();
      const clock = () => new Date(nowMs);

      await run({
        token: process.env.TELEGRAM_BOT_TOKEN,
        userId: '528864559',
        chatId: '528864559',
        allowedUserIds: '528864559,5535435580',
        allowedChatIds: '528864559,5535435580',
        dataDir: ws.tempDir,
        lockPath: ws.lockPath,
        api,
        clock,
        vpnManager: {
          ensure: async (id) => ({
            name: 'yj_autopost_vpn_1',
            port: 18801,
            proxy: 'socks5h://127.0.0.1:18801',
            exitIp: '203.0.114.11',
            slot: 0
          }),
          health: async () => ({ healthy: true, exitIp: '203.0.114.11' }),
          release: async () => 0,
          reconcile: async () => ({ conflicts: [], stale: [], released: [] }),
          rotate: async () => ({ success: true })
        },
        publishAdapterFactory: adapterFactory,
        verifyAdapterFactory: adapterFactory,
        maxPolls: 2,
        sleepFn: async (ms) => { nowMs += ms; },
        onRuntimeReady: async (rt) => {
          // Verify startup crash recovery ran before runtimeReady
          const afterRecovery = await rt.state();
          const recClaimed = afterRecovery.items.find(i => i.id === 'item-claimed-recover');
          const recDisp = afterRecovery.items.find(i => i.id === 'item-dispatching-quarantine');
          assert.strictEqual(recClaimed.state, 'pending', 'Startup recovery must revert claimed item to pending');
          assert.strictEqual(recDisp.state, 'ambiguous', 'Startup recovery must quarantine dispatching item as ambiguous');

          // Start full multi-item cycle
          const started = await rt.start({ stopAfterSuccess: false });
          assert.strictEqual(started.started, true);
          await rt.wait();

          // Calling stop() again after natural completion must not send duplicate CSVs
          await rt.stop();
        }
      });

      const finalStore = ws.registerStore(new SqliteStore(ws.dbPath));
      const finalState = await finalStore.load();

      // 1. All 3 eligible items (item-claimed-recover, item-pending-2, item-pending-3) published across the 3 accounts
      const publishedItems = finalState.items.filter(i => i.state === 'published');
      assert.strictEqual(publishedItems.length, 3);
      assert.deepStrictEqual(
        new Set(dispatchOrder.map(d => d.accountId)),
        new Set(['acc-1', 'acc-2', 'acc-3']),
        'Cycle must rotate across all 3 active accounts'
      );

      // 2. Quarantined post-dispatch item remained ambiguous with 0 quota charged for it
      const quarantined = finalState.items.find(i => i.id === 'item-dispatching-quarantine');
      assert.strictEqual(quarantined.state, 'ambiguous');

      // 3. Riyadh daily quota incremented by 1 per account
      const dayQuota = finalState.posting?.quota?.[todayRiyadh] || {};
      assert.strictEqual(dayQuota['acc-1'], 1);
      assert.strictEqual(dayQuota['acc-2'], 1);
      assert.strictEqual(dayQuota['acc-3'], 1);

      // 4. Start notification was sent
      const startNotices = api.messages.filter(m => m.text.includes('تم استلام طلب تشغيل النشر وبدأت الدورة بالفعل'));
      assert.ok(startNotices.length >= 2, 'Start notification must be delivered to both admin chats');

      // 5. Terminal CSV link export delivered to BOTH admin chats (528864559 and 5535435580) with zero duplicates
      const chat1Docs = api.documents.filter(d => d.chat_id === '528864559');
      const chat2Docs = api.documents.filter(d => d.chat_id === '5535435580');
      assert.strictEqual(chat1Docs.length, 1, 'Admin chat 528864559 must receive exactly 1 terminal CSV export');
      assert.strictEqual(chat2Docs.length, 1, 'Admin chat 5535435580 must receive exactly 1 terminal CSV export');
      assert.ok(chat1Docs[0].content.includes('Recovered pre-dispatch post 1'));
      assert.ok(chat1Docs[0].content.includes('Fresh pending post 2'));
      assert.ok(chat1Docs[0].content.includes('Fresh pending post 3'));

      // 6. Lock file was cleanly removed on shutdown
      assert.strictEqual(fs.existsSync(ws.lockPath), false, 'SingleInstanceLock must be released on shutdown');
      verifyProductionSnapshot(preProd);
    } finally {
      await ws.cleanup();
    }
  });
});
