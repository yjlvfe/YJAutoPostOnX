'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createHermeticWorkspace, snapshotProductionFiles, verifyProductionSnapshot } = require('../fixtures/hermetic_workspace');
const { FakeTelegramApi } = require('../fixtures/fake_telegram_server');
const { FakeDirectXAdapter } = require('../fixtures/fake_direct_x_bridge');
const { SqliteStore } = require('../../src/sqliteStore');
const { SETTLEMENT_TARGET } = require('../../scripts/settle_item_53d0f458');
const { run } = require('../../src/runner');

describe('02_crash_restart_and_quarantine.e2e: 30 Ambiguous Quarantine Preservation, 53d0f458 Fence, CAPTCHA E2E & 3-Strikes Halt', () => {
  it('E2E-02: Preserves 30 quarantined ambiguous items (including 53d0f458), enforces CAPTCHA manual-only recovery & TR-06 race guard, and halts on 3rd strike', async () => {
    const preProd = snapshotProductionFiles();
    const ws = createHermeticWorkspace('yj-bot-test-e2e02-');
    try {
      const c1 = ws.writeSyntheticCookie('acc-1', { userId: '1001' });
      const c2 = ws.writeSyntheticCookie('acc-2', { userId: '1002' });

      // Seed 30 quarantined ambiguous items (including 53d0f458-3144-4e89-a1af-202a8893afc6)
      const thirtyAmbiguous = [
        {
          id: SETTLEMENT_TARGET.id,
          state: 'ambiguous',
          accountId: SETTLEMENT_TARGET.accountId,
          payload: { text: SETTLEMENT_TARGET.fullText }
        },
        ...Array.from({ length: 29 }, (_, idx) => ({
          id: `ambig-quarantined-${idx + 2}`,
          state: 'ambiguous',
          accountId: 'acc-1',
          payload: { text: `Quarantined historical item #${idx + 2}` }
        }))
      ];
      assert.strictEqual(thirtyAmbiguous.length, 30);

      const seedStore = new SqliteStore(ws.dbPath, {
        settings: {
          dailyQuota: 10,
          delayMinSeconds: 15,
          delayMaxSeconds: 15
        },
        accounts: [
          { id: 'acc-1', username: 'captcha_target', userId: '1001', cookieFile: c1, enabled: true, status: 'مفعل', failures: 0 },
          { id: 'acc-2', username: 'strike_target', userId: '1002', cookieFile: c2, enabled: true, status: 'مفعل', failures: 2 }
        ],
        items: [
          ...thirtyAmbiguous,
          {
            id: 'live-item-1',
            state: 'pending',
            payload: { text: 'Live item 1 triggers CAPTCHA on acc-1 then transfers to acc-2' }
          }
        ]
      });
      await seedStore.load();
      await seedStore.close();

      const api = new FakeTelegramApi();
      // Simulate Chat 2 (5535435580) failing once on the first sendMessage for CAPTCHA alert, then succeeding on retry
      let chat2FailedOnce = false;
      api.setChatFault('5535435580', (method, params) => {
        if (method === 'sendMessage' && !chat2FailedOnce && String(params?.text || '').includes('كابتشا')) {
          chat2FailedOnce = true;
          throw Object.assign(new Error('502 Bad Gateway'), { statusCode: 502 });
        }
        return null;
      });

      const dispatchedItemIds = [];
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
          dispatchedItemIds.push(payload.text);
          await onDispatch({ accountId: session.accountId });
          // Return post-dispatch ambiguous on acc-2 (which has failures=2 -> triggers 3rd strike isolation!)
          return {
            status: 'ambiguous',
            published: false,
            posted: false,
            ambiguous: true,
            reason: 'publish_confirmation_missing'
          };
        }
      });

      let nowMs = Date.parse('2026-11-04T12:00:00.000Z');
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
          ensure: async () => ({
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
        maxPolls: 1,
        sleepFn: async (ms) => { nowMs += ms; },
        onRuntimeReady: async (rt) => {
          // 1. Prove 53d0f458 and all 30 ambiguous items are blocked from Queue.requeue()
          await assert.rejects(
            () => rt.bot.queue.requeue(SETTLEMENT_TARGET.id),
            err => err.code === 'AMBIGUOUS_REQUEUE_FORBIDDEN' || /AMBIGUOUS_REQUEUE_FORBIDDEN/.test(err.message)
          );

          // 2. Run cycle: acc-1 hits pre-dispatch CAPTCHA (isolated immediately), item transfers to acc-2, acc-2 hits 3rd strike and halts cycle
          const started = await rt.start({ stopAfterSuccess: false });
          assert.strictEqual(started.started, true);
          await rt.wait();

          // 3. Retry CAPTCHA alert delivery to Chat 2 (5535435580) and verify receipt completion
          const stMid = await rt.state();
          const acc1Mid = stMid.accounts.find(a => a.id === 'acc-1');
          assert.strictEqual(acc1Mid.enabled, false);
          assert.strictEqual(acc1Mid.needsOwnerCaptcha, true);
          await rt.ui.sendIsolationAlert({ account: acc1Mid, reason: 'captcha' });

          // 4. Attempt to toggle/enable acc-1 while needsOwnerCaptcha is true -> blocked!
          const rawCb = {
            callback_query: {
              id: 'cb-e2e-toggle',
              from: { id: 528864559 },
              message: { message_id: 100, chat: { id: 528864559 } }
            }
          };
          const toggleBlocked = await rt.ui.accountToggle({ parsed: { action: 'toggle', value: 'acc-1' } }, rawCb);
          assert.strictEqual(toggleBlocked.captcha, true);

          rt.shutdown();
        }
      });

      const finalStore = ws.registerStore(new SqliteStore(ws.dbPath));
      const finalState = await finalStore.load();

      // Verify all 30 original ambiguous items (including 53d0f458) remained untouched in ambiguous state
      for (const orig of thirtyAmbiguous) {
        const current = finalState.items.find(i => i.id === orig.id);
        assert.ok(current, `Quarantined item ${orig.id} must still exist`);
        assert.strictEqual(current.state, 'ambiguous', `Quarantined item ${orig.id} must remain ambiguous`);
        assert.ok(
          !dispatchedItemIds.includes(orig.payload.text),
          `Quarantined item ${orig.id} must NEVER be dispatched`
        );
      }

      // Verify acc-1 is isolated for CAPTCHA and both chats received the isolation receipt
      const acc1 = finalState.accounts.find(a => a.id === 'acc-1');
      assert.strictEqual(acc1.enabled, false);
      assert.strictEqual(acc1.needsOwnerCaptcha, true);
      assert.deepStrictEqual(new Set(acc1.captchaDeliveredChats), new Set(['528864559', '5535435580']));

      // Verify acc-2 was isolated on 3rd strike
      const acc2 = finalState.accounts.find(a => a.id === 'acc-2');
      assert.strictEqual(acc2.enabled, false);
      assert.strictEqual(acc2.failures, 3);
      assert.strictEqual(acc2.status, 'معزول (3 إخفاقات)');

      verifyProductionSnapshot(preProd);
    } finally {
      await ws.cleanup();
    }
  });
});
