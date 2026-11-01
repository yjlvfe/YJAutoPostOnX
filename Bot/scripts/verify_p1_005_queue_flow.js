#!/usr/bin/env node
'use strict';
/**
 * Standalone Verification Script for Requirement P1-005:
 * Proves:
 * Non-blocking queue continuation when 2 consecutive items become 'ambiguous'
 * and the 3rd item is processed to 'published' in the same cycle without stalling.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, "..");
const { run } = require(path.join(ROOT, 'src/runner'));
const { SqliteStore } = require(path.join(ROOT, 'src/sqliteStore'));

async function runVerification() {
  console.log('=== P1-005 VERIFICATION: NON-BLOCKING QUEUE FLOW & ANTI-STALL ===\n');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-005-test-'));
  const dbPath = path.join(tempDir, 'state.sqlite');

  const initialStore = {
    items: [
      { id: 'item-drop-1', state: 'pending', payload: { text: 'Item 1: transient network drop' } },
      { id: 'item-drop-2', state: 'pending', payload: { text: 'Item 2: socket reset after dispatch' } },
      { id: 'item-success-3', state: 'pending', payload: { text: 'Item 3: clean successful publication' } }
    ],
    accounts: [
      {
        id: 'acct-primary',
        username: 'news_bot',
        userId: '98765',
        enabled: true,
        cookieFile: path.join(tempDir, 'cookie.json'),
        dailyLimit: 20
      }
    ],
    cycle: { state: 'stopped', runId: null },
    settings: { dailyQuota: 20, delayMinSeconds: 15, delayMaxSeconds: 30 },
    posting: {}
  };

  fs.writeFileSync(path.join(tempDir, 'cookie.json'), JSON.stringify({ auth: 'ok' }));

  const store = new SqliteStore(dbPath, initialStore);
  await store.load();

  // Mock Telegram API
  const api = {
    getMe: async () => ({ id: 1, username: 'test_bot' }),
    sendMessage: async () => ({ message_id: 1 }),
    sendRichMessage: async () => ({ message_id: 1 }),
    editMessageText: async () => ({ message_id: 1 }),
    deleteMessage: async () => {},
    answerCallbackQuery: async () => {},
    getUpdates: async () => [],
    sendDocument: async () => ({ message_id: 1 })
  };

  // Mock VPN
  const vpnManager = {
    ensure: async () => ({ exitIp: '198.51.100.5', proxy: 'socks5h://127.0.0.1:18801' }),
    health: async () => ({ healthy: true, exitIp: '198.51.100.5' })
  };

  let dispatchOrder = [];

  // Mock DirectXAdapter factory
  const publishAdapterFactory = () => {
    return {
      supportsDispatchCallback: true,
      open: async ({ account }) => {
        return {
          slot: 1,
          port: 18801,
          exitIp: '198.51.100.5',
          identity: {
            authenticated: true,
            username: account.username,
            userId: account.userId
          }
        };
      },
      publish: async ({ payload, onDispatch }) => {
        // Acknowledge dispatch entry (crosses the irreversible boundary)
        await onDispatch({ accountId: 'acct-primary' });
        dispatchOrder.push(payload.text);

        if (payload.text.includes('Item 1')) {
          // Simulate post-dispatch timeout / socket closure
          throw Object.assign(new Error('Connection dropped after dispatch fence'), {
            code: 'ECONNRESET'
          });
        }

        if (payload.text.includes('Item 2')) {
          // Simulate ambiguous response from bridge
          return {
            ambiguous: true,
            published: false,
            reason: 'timeline_unconfirmed'
          };
        }

        if (payload.text.includes('Item 3')) {
          // Successful publication
          return {
            published: true,
            url: 'https://x.com/news_bot/status/1852000000000000003',
            id: '1852000000000000003'
          };
        }

        throw new Error('Unexpected payload: ' + JSON.stringify(payload));
      },
      close: async () => {}
    };
  };

  const startTime = Date.now();

  console.log('Starting runner with 3 queued items (Item 1 drop, Item 2 ambiguous, Item 3 success)...');
  await run({
    token: 'test-token',
    userId: '1',
    chatId: '1',
    allowedUserIds: ['1'],
    allowedChatIds: ['1'],
    dataDir: tempDir,
    api,
    vpnManager,
    maxPolls: 0,
    publishAdapterFactory,
    sleepFn: async (ms) => {
      // Fast sleep for delay simulation in test environment
      await new Promise(r => setTimeout(r, Math.min(ms, 20)));
    },
    attemptTimeoutMs: 3000,
    logger: {
      log: () => {},
      error: () => {}
    },
    onRuntimeReady: async (ctx) => {
      // Start queue processing cycle with stopAfterSuccess
      console.log('Runner runtime ready. Starting cycle...');
      await ctx.start({ stopAfterSuccess: true });
      await ctx.wait();
      console.log('Runner cycle completed.');
    }
  });

  const durationMs = Date.now() - startTime;
  console.log(`Cycle finished in ${durationMs}ms\n`);

  // --- Assertions ---
  const finalState = await store.load();
  console.log('--- Final Item States in SQLite ---');
  finalState.items.forEach(i => {
    console.log(`  [${i.id}] state=${i.state}, reason=${i.reason || 'N/A'}, url=${i.url || 'N/A'}`);
  });

  const item1 = finalState.items.find(x => x.id === 'item-drop-1');
  const item2 = finalState.items.find(x => x.id === 'item-drop-2');
  const item3 = finalState.items.find(x => x.id === 'item-success-3');

  // 1. Verify Item 1 was isolated as ambiguous without halting
  assert.strictEqual(item1.state, 'ambiguous', 'Item 1 must be isolated as ambiguous');

  // 2. Verify Item 2 was isolated as ambiguous without halting
  assert.strictEqual(item2.state, 'ambiguous', 'Item 2 must be isolated as ambiguous');

  // 3. Verify Item 3 was published successfully in the same run
  assert.strictEqual(item3.state, 'published', 'Item 3 must be marked published');
  assert.strictEqual(item3.url, 'https://x.com/news_bot/status/1852000000000000003');
  assert.strictEqual(item3.attempt, undefined, 'Item 3 attempt must be cleaned up after publication');

  // 4. Verify Dispatch Order: all 3 were processed in exact sequence
  console.log('\nProcessed dispatches in order:');
  dispatchOrder.forEach((t, idx) => console.log(`  ${idx + 1}. ${t}`));
  assert.strictEqual(dispatchOrder.length, 3, 'All 3 items must be dispatched in sequence');
  assert.ok(dispatchOrder[0].includes('Item 1'), 'First dispatch must be Item 1');
  assert.ok(dispatchOrder[1].includes('Item 2'), 'Second dispatch must be Item 2');
  assert.ok(dispatchOrder[2].includes('Item 3'), 'Third dispatch must be Item 3');

  // 5. Verify Quota: Only the 1 successfully published item counted against quota
  const today = Object.keys(finalState.posting?.quota || {})[0];
  const quotaCount = finalState.posting?.quota?.[today]?.['acct-primary'] || 0;
  console.log(`\nQuota recorded for account: ${quotaCount} (expected: 1)`);
  assert.strictEqual(quotaCount, 1, 'Only Item 3 must consume account quota');

  // 6. Verify Cycle State: stopped cleanly after success
  assert.strictEqual(finalState.cycle.state, 'stopped', 'Cycle state must be stopped after success');

  await store.close();
  fs.rmSync(tempDir, { recursive: true, force: true });

  console.log('\n================================================================');
  console.log('ALL P1-005 CHECKS PASSED: Non-blocking queue anti-stall verified!');
  console.log('================================================================');
}

runVerification().catch(err => {
  console.error('VERIFICATION FAILED:', err);
  process.exit(1);
});
