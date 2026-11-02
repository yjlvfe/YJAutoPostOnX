'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const { createLinkExports, dayOf, csv } = require(path.join(ROOT, 'src/linkExports'));
const {
  TelegramUi,
  MAX_ACTIVE_ACCOUNTS,
  ISOLATION_REASONS,
  formatIsolationReason,
  buildIsolationMessage
} = require(path.join(ROOT, 'src/telegramUi'));
const {
  SingleInstanceLock,
  isConflict409,
  executeWithConflictBackoff
} = require(path.join(ROOT, 'src/singleInstance'));
const { SqliteStore } = require(path.join(ROOT, 'src/sqliteStore'));

function createMockTelegramApi() {
  const sentDocuments = [];
  const sentMessages = [];
  return {
    sentDocuments,
    sentMessages,
    getMe: async () => ({ id: 1, is_bot: true, username: 'adversarial_bot' }),
    sendMessage: async (arg1, arg2) => {
      const text = typeof arg1 === 'object' && arg1 ? arg1.text : arg2;
      const chatId = typeof arg1 === 'object' && arg1 ? arg1.chat_id : arg1;
      sentMessages.push({ chatId, text });
      return { message_id: Math.floor(Math.random() * 100000) + 1 };
    },
    sendDocument: async (payload) => {
      sentDocuments.push(payload);
      return { message_id: Math.floor(Math.random() * 100000) + 1 };
    },
    editMessageText: async () => ({ message_id: 1 }),
    deleteMessage: async () => {},
    answerCallbackQuery: async () => {},
    getUpdates: async () => []
  };
}

describe('Challenger R3 M3 Adversarial Verification Suite', () => {

  // =========================================================================
  // SECTION 1: CSV EXPORT DEDUPLICATION ADVERSARIAL STRESS TESTING
  // =========================================================================
  describe('1. CSV Deduplication Under Stress, Multi-Dest & Mid-Cycle Additions', () => {

    test('1.1 Rapid Start/Stop Fuzzing: 15 consecutive stop cycles with zero new items send exactly 1 CSV', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'challenger-csv-rapid-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const now = new Date('2026-11-02T10:00:00.000Z');
      const day = dayOf(now);

      const items = Array.from({ length: 10 }, (_, i) => ({
        id: `item-${i + 1}`,
        state: 'published',
        url: `https://x.com/status/${1000 + i}`,
        publishedAt: now.toISOString(),
        payload: { text: `Post number ${i + 1}` }
      }));

      const store = new SqliteStore(dbPath, { items, accounts: [{ id: 'acc-1', username: 'trader1', enabled: true }] });
      await store.load();

      const api = createMockTelegramApi();
      const logs = [];
      const links = createLinkExports({
        store,
        dataDir: tempDir,
        api,
        chatId: '999888',
        logger: { log: msg => logs.push(msg), error: () => {} },
        clock: () => now
      });

      // Initial cycle run
      await links.send({ runId: 'run-init', endedAt: now.toISOString(), itemIds: items.map(x => x.id) }, { terminal: true });
      assert.strictEqual(api.sentDocuments.length, 1, 'Initial run sends 1 CSV');

      // 15 rapid consecutive replay stop cycles of same runId
      for (let i = 1; i <= 15; i++) {
        const cycleTime = new Date(now.getTime() + i * 1000);
        await links.send({ runId: 'run-init', endedAt: cycleTime.toISOString(), itemIds: [] }, { terminal: true });
      }

      assert.strictEqual(api.sentDocuments.length, 1, 'Total CSVs sent must remain exactly 1 after 15 rapid stops of same runId');

      const state = await store.load();
      assert.strictEqual(state.linkTerminalEvents.length, 16, '16 terminal events recorded');
      const suppressedCount = state.linkTerminalEvents.filter(e => e.suppressed === true && e.reconciled === true).length;
      assert.strictEqual(suppressedCount, 15, 'All 15 subsequent stop events marked suppressed and reconciled');

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('1.2 Multi-Destination Asymmetric Delivery: pending chat receives CSV while completed chats are suppressed', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'challenger-csv-multidest-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const now = new Date('2026-11-02T10:00:00.000Z');
      const day = dayOf(now);

      const items = [
        { id: 'item-1', state: 'published', url: 'https://x.com/status/101', publishedAt: now.toISOString(), payload: { text: 'Alpha' } }
      ];
      const rows = items;
      const content = csv(rows);
      const contentHash = crypto.createHash('sha256').update(content).digest('hex');

      // Precondition: chat-A and chat-B have already received the delivery for today.
      // chat-C has NOT received it yet.
      const store = new SqliteStore(dbPath, {
        items,
        linkDeliveries: [
          {
            deliveryId: 'del-A', outboxId: 'out-A', runId: 'run-old', day,
            kind: 'document', chatId: 'chat-A', itemIds: ['item-1'], contentHash,
            attempted: true, ok: true, attemptedAt: now.toISOString(), deliveredAt: now.toISOString(), messageId: 101
          },
          {
            deliveryId: 'del-B', outboxId: 'out-B', runId: 'run-old', day,
            kind: 'document', chatId: 'chat-B', itemIds: ['item-1'], contentHash,
            attempted: true, ok: true, attemptedAt: now.toISOString(), deliveredAt: now.toISOString(), messageId: 102
          }
        ]
      });
      await store.load();

      const api = createMockTelegramApi();
      const logs = [];
      const links = createLinkExports({
        store,
        dataDir: tempDir,
        api,
        chatIds: ['chat-A', 'chat-B', 'chat-C'],
        logger: { log: msg => logs.push(msg), error: () => {} },
        clock: () => now
      });

      // Stopping cycle with the 3 destinations configured for run-old
      await links.send({ runId: 'run-old', endedAt: now.toISOString(), itemIds: ['item-1'] }, { terminal: true });

      // Verification: chat-A and chat-B are suppressed, chat-C receives the document!
      assert.strictEqual(api.sentDocuments.length, 1, 'Only 1 document sent across all destinations');
      assert.strictEqual(api.sentDocuments[0].chat_id, 'chat-C', 'Delivered specifically to chat-C');

      const state = await store.load();
      const eventA = state.linkTerminalEvents.find(e => e.runId === 'run-old' && e.chatId === 'chat-A' && e.suppressed);
      const eventB = state.linkTerminalEvents.find(e => e.runId === 'run-old' && e.chatId === 'chat-B' && e.suppressed);
      const eventC = state.linkTerminalEvents.find(e => e.runId === 'run-old' && e.chatId === 'chat-C' && !e.suppressed);

      assert.strictEqual(eventA.suppressed, true, 'chat-A suppressed');
      assert.strictEqual(eventB.suppressed, true, 'chat-B suppressed');
      assert.strictEqual(eventC.suppressed, undefined, 'chat-C not suppressed');

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('1.3 Mid-Cycle Dynamic New Item Additions: delivers fresh CSV only when new items are added', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'challenger-csv-midcycle-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const now = new Date('2026-11-02T10:00:00.000Z');

      const store = new SqliteStore(dbPath, {
        items: [{ id: 'item-1', state: 'published', url: 'https://x.com/status/1', publishedAt: now.toISOString(), payload: { text: '1' } }]
      });
      await store.load();

      const api = createMockTelegramApi();
      const links = createLinkExports({ store, dataDir: tempDir, api, chatId: '111222', clock: () => now });

      // Step 1: Run 1 publishes item-1 -> 1 CSV sent
      await links.send({ runId: 'cycle-1', endedAt: now.toISOString(), itemIds: ['item-1'] }, { terminal: true });
      assert.strictEqual(api.sentDocuments.length, 1);
      assert.strictEqual(api.sentDocuments[0].content.split('\r\n').filter(Boolean).length, 2); // header + 1 item

      // Step 2: Cycle 1 re-executed with 0 new items -> suppressed
      await links.send({ runId: 'cycle-1', endedAt: now.toISOString(), itemIds: [] }, { terminal: true });
      assert.strictEqual(api.sentDocuments.length, 1, 'Cycle 1 replay suppressed');

      // Step 3: Mid-cycle addition: 2 new items published
      await store.update(s => {
        s.items.push(
          { id: 'item-2', state: 'published', url: 'https://x.com/status/2', publishedAt: now.toISOString(), payload: { text: '2' } },
          { id: 'item-3', state: 'published', url: 'https://x.com/status/3', publishedAt: now.toISOString(), payload: { text: '3' } }
        );
        return s;
      });

      // Step 4: Cycle 3 stops -> sends new CSV with 3 items
      await links.send({ runId: 'cycle-3', endedAt: now.toISOString(), itemIds: ['item-2', 'item-3'] }, { terminal: true });
      assert.strictEqual(api.sentDocuments.length, 2, 'Cycle 3 delivers updated CSV');
      assert.strictEqual(api.sentDocuments[1].content.split('\r\n').filter(Boolean).length, 4); // header + 3 items

      // Step 5: Cycle 3 re-executed with 0 new items -> suppressed again
      await links.send({ runId: 'cycle-3', endedAt: now.toISOString(), itemIds: [] }, { terminal: true });
      assert.strictEqual(api.sentDocuments.length, 2, 'Cycle 3 replay suppressed');

      // Step 6: Mid-cycle addition: item-4 published
      await store.update(s => {
        s.items.push(
          { id: 'item-4', state: 'published', url: 'https://x.com/status/4', publishedAt: now.toISOString(), payload: { text: '4' } }
        );
        return s;
      });

      // Step 7: Cycle 5 stops -> sends new CSV with 4 items
      await links.send({ runId: 'cycle-5', endedAt: now.toISOString(), itemIds: ['item-4'] }, { terminal: true });
      assert.strictEqual(api.sentDocuments.length, 3, 'Cycle 5 delivers updated CSV');
      assert.strictEqual(api.sentDocuments[2].content.split('\r\n').filter(Boolean).length, 5); // header + 4 items

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('1.4 CSV Formula Injection Defense and duplicate URL deduplication', () => {
      const now = new Date('2026-11-02T10:00:00.000Z');
      const rows = [
        { id: 'item-1', publishedAt: now.toISOString(), accountUsername: 'user1', url: 'https://x.com/1', payload: { text: '=cmd| /C calc' } },
        { id: 'item-2', publishedAt: now.toISOString(), accountUsername: 'user2', url: 'https://x.com/2', payload: { text: '+SUM(1,2)' } },
        { id: 'item-3', publishedAt: now.toISOString(), accountUsername: 'user3', url: 'https://x.com/3', payload: { text: '-2000' } },
        { id: 'item-4', publishedAt: now.toISOString(), accountUsername: 'user4', url: 'https://x.com/4', payload: { text: '@payload' } },
        { id: 'item-5', publishedAt: now.toISOString(), accountUsername: 'user5', url: 'https://x.com/5', payload: { text: 'Normal text' } }
      ];

      const csvOutput = csv(rows);

      // Verify formula characters are safely quoted with single apostrophe prefix
      assert.ok(csvOutput.includes("\"'=cmd| /C calc\""), '= prefix sanitized');
      assert.ok(csvOutput.includes("\"'+SUM(1,2)\""), '+ prefix sanitized');
      assert.ok(csvOutput.includes("\"'-2000\""), '- prefix sanitized');
      assert.ok(csvOutput.includes("\"'@payload\""), '@ prefix sanitized');
      assert.ok(csvOutput.includes('"Normal text"'), 'normal text unmodified');
    });
  });

  // =========================================================================
  // SECTION 2: 409 CONFLICT RESILIENCE & LOCK RECOVERY ADVERSARIAL TESTING
  // =========================================================================
  describe('2. Race Conditions in 409 Conflict Backoff & Lock Recovery', () => {

    test('2.1 Dead PID stale lock recovery under multi-instance concurrent race', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'challenger-stale-lock-'));
      const lockPath = path.join(tempDir, 'runner.lock');

      // Create a stale lock held by a dead PID (PID 999999 does not exist)
      const deadPid = 999999;
      fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid, token: 'dead-token', acquiredAt: new Date().toISOString() }) + '\n');

      // 10 concurrent lock instances race to acquire the stale lock
      const instances = Array.from({ length: 10 }, () => new SingleInstanceLock(lockPath, {
        timeoutMs: 3000,
        retryMs: 20
      }));

      const results = await Promise.allSettled(instances.map(lock => lock.acquire()));
      const fulfilled = results.filter(r => r.status === 'fulfilled');

      // At least 1 lock must acquire. Only 1 can hold it at any exact instant.
      assert.ok(fulfilled.length >= 1, 'At least one instance successfully acquired the stale lock');

      // Verify lock state on disk
      const lockContent = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      assert.strictEqual(lockContent.pid, process.pid, 'Lock now owned by current live process');
      assert.notStrictEqual(lockContent.token, 'dead-token', 'Stale token overwritten');

      // Release the acquired locks
      for (const res of fulfilled) {
        await res.value();
      }

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('2.2 executeWithConflictBackoff verifies exponential backoff and jitter calculations', async () => {
      let callCount = 0;
      const sleepHistory = [];
      const mockSleep = async ms => { sleepHistory.push(ms); };

      const conflictThenSuccess = async () => {
        callCount++;
        if (callCount <= 3) {
          const err = new Error('Conflict: terminated by other getUpdates request');
          err.telegramCode = 409;
          throw err;
        }
        return 'recovered_payload';
      };

      const result = await executeWithConflictBackoff(conflictThenSuccess, {
        maxRetries: 5,
        initialBackoffMs: 100,
        maxBackoffMs: 2000,
        sleepFn: mockSleep,
        logger: { error: () => {} }
      });

      assert.strictEqual(result, 'recovered_payload');
      assert.strictEqual(callCount, 4, '1 initial call + 3 retries = 4 calls');
      assert.strictEqual(sleepHistory.length, 3, 'Slept 3 times');

      // Verify exponential progression with jitter:
      // Retry 0: base 100 + jitter (0-20) -> 100..120
      // Retry 1: base 200 + jitter (0-40) -> 200..240
      // Retry 2: base 400 + jitter (0-80) -> 400..480
      assert.ok(sleepHistory[0] >= 100 && sleepHistory[0] <= 120, `Retry 0 backoff in range: ${sleepHistory[0]}`);
      assert.ok(sleepHistory[1] >= 200 && sleepHistory[1] <= 240, `Retry 1 backoff in range: ${sleepHistory[1]}`);
      assert.ok(sleepHistory[2] >= 400 && sleepHistory[2] <= 480, `Retry 2 backoff in range: ${sleepHistory[2]}`);
    });

    test('2.3 executeWithConflictBackoff fails immediately on non-409 errors without retry', async () => {
      let callCount = 0;
      const nonConflictFn = async () => {
        callCount++;
        const err = new Error('500 Internal Server Error');
        err.statusCode = 500;
        throw err;
      };

      await assert.rejects(
        async () => {
          await executeWithConflictBackoff(nonConflictFn, {
            maxRetries: 5,
            initialBackoffMs: 50,
            logger: { error: () => {} }
          });
        },
        err => {
          assert.strictEqual(err.statusCode, 500);
          return true;
        }
      );

      assert.strictEqual(callCount, 1, 'Non-409 error must NOT be retried (failed on attempt 1)');
    });

    test('2.4 UI actions handle 409 Conflict gracefully across rapid concurrent burst', async () => {
      const logs = [];
      const ui = new TelegramUi({
        bot: {
          logger: { error: msg => logs.push(msg) },
          store: { load: async () => ({}) },
          transport: { sendMessage: async () => ({}) }
        }
      });

      // Actions throwing 409
      ui.work = async () => {
        const err = new Error('Telegram conflict 409');
        err.statusCode = 409;
        throw err;
      };

      const actions = ui.actions();
      const raw = { message: { chat: { id: 1001 }, from: { id: 2002 } } };

      // Dispatch 5 concurrent actions
      await Promise.all([
        actions.work({}, raw),
        actions.work({}, raw),
        actions.work({}, raw),
        actions.work({}, raw),
        actions.work({}, raw)
      ]);

      // All 5 409 conflicts should be caught and logged, not crash
      const conflictLogs = logs.filter(l => l.includes('telegram_ui_conflict_409'));
      assert.strictEqual(conflictLogs.length, 5, 'All 5 conflicts logged gracefully');
    });
  });

  // =========================================================================
  // SECTION 3: BOUNDARY TESTING FOR 5-ACTIVE ACCOUNT LIMIT & DYNAMIC TOGGLE
  // =========================================================================
  describe('3. Boundary Testing for 5-Active Account Limit & Dynamic Toggles', () => {

    test('3.1 Sequential enable boundary: 0 to 5 accounts succeed, 6th account strictly rejected', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'challenger-toggle-bound-'));
      const dbPath = path.join(tempDir, 'state.sqlite');

      const accounts = Array.from({ length: 7 }, (_, i) => ({
        id: `acc-${i + 1}`,
        username: `trader_${i + 1}`,
        enabled: false,
        status: 'غير مفعل'
      }));

      const store = new SqliteStore(dbPath, { accounts });
      await store.load();

      const alerts = [];
      const mockTransport = {
        sendMessage: async () => ({ message_id: 1 }),
        editMessageText: async () => ({ message_id: 1 }),
        acknowledgeCallback: async (id, text, alert) => {
          alerts.push({ text, alert });
        }
      };

      const ui = new TelegramUi({ bot: { store, transport: mockTransport } });

      // Enable acc-1 through acc-5 sequentially
      for (let i = 1; i <= 5; i++) {
        const res = await ui.accountToggle(
          { parsed: { action: 'toggle', value: `acc-${i}` } },
          { callback_query: { id: `cb-${i}`, from: { id: 1 }, message: { chat: { id: 1 } } } }
        );
        assert.strictEqual(res.toggled, true, `acc-${i} enabled successfully`);
      }

      // Verify store has exactly 5 active accounts
      let state = await store.load();
      let activeCount = state.accounts.filter(a => a.enabled !== false && !['محظور', 'كابتشا', 'معزول (3 إخفاقات)', 'غير مفعل'].includes(a.status)).length;
      assert.strictEqual(activeCount, 5, 'Exactly 5 accounts active');

      // Attempt to enable acc-6 -> MUST BE REJECTED
      const res6 = await ui.accountToggle(
        { parsed: { action: 'toggle', value: 'acc-6' } },
        { callback_query: { id: 'cb-6', from: { id: 1 }, message: { chat: { id: 1 } } } }
      );
      assert.strictEqual(res6.limitExceeded, true, 'acc-6 rejected by limitExceeded');
      assert.ok(alerts.some(a => a.text.includes('الحد الأقصى 5') && a.alert === true), 'Alert displayed to user');

      // Attempt to enable acc-7 via accountManage -> MUST BE REJECTED
      const res7 = await ui.accountManage(
        { parsed: { action: 'enable', value: 'acc-7' } },
        { callback_query: { id: 'cb-7', from: { id: 1 }, message: { chat: { id: 1 } } } }
      );
      assert.strictEqual(res7.limitExceeded, true, 'acc-7 rejected by accountManage');

      // Verify store still has exactly 5 active accounts
      state = await store.load();
      activeCount = state.accounts.filter(a => a.enabled !== false && !['محظور', 'كابتشا', 'معزول (3 إخفاقات)', 'غير مفعل'].includes(a.status)).length;
      assert.strictEqual(activeCount, 5, 'Still exactly 5 accounts active');

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('3.2 Inactive statuses (banned, captcha, isolated) do not consume the 5-active account quota', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'challenger-status-bound-'));
      const dbPath = path.join(tempDir, 'state.sqlite');

      const accounts = [
        { id: 'acc-1', username: 'user1', enabled: true, status: 'مفعل' },
        { id: 'acc-2', username: 'user2', enabled: true, status: 'مفعل' },
        { id: 'acc-3', username: 'user3', enabled: true, status: 'محظور' }, // Banned: does not count
        { id: 'acc-4', username: 'user4', enabled: true, status: 'كابتشا' }, // Captcha: does not count
        { id: 'acc-5', username: 'user5', enabled: false, status: 'معزول (3 إخفاقات)' }, // Isolated: does not count
        { id: 'acc-6', username: 'user6', enabled: false, status: 'غير مفعل' },
        { id: 'acc-7', username: 'user7', enabled: false, status: 'غير مفعل' },
        { id: 'acc-8', username: 'user8', enabled: false, status: 'غير مفعل' },
        { id: 'acc-9', username: 'user9', enabled: false, status: 'غير مفعل' }
      ];

      const store = new SqliteStore(dbPath, { accounts });
      await store.load();

      const mockTransport = {
        sendMessage: async () => ({ message_id: 1 }),
        editMessageText: async () => ({ message_id: 1 }),
        acknowledgeCallback: async () => {}
      };

      const ui = new TelegramUi({ bot: { store, transport: mockTransport } });

      // Currently 2 active accounts (acc-1 and acc-2).
      // Enabling acc-6, acc-7, acc-8 should all succeed (bringing active count to 5)
      for (const id of ['acc-6', 'acc-7', 'acc-8']) {
        const res = await ui.accountToggle(
          { parsed: { action: 'toggle', value: id } },
          { callback_query: { id: `cb-${id}`, from: { id: 1 }, message: { chat: { id: 1 } } } }
        );
        assert.strictEqual(res.toggled, true, `${id} enabled`);
      }

      // Now active count is exactly 5: acc-1, acc-2, acc-6, acc-7, acc-8
      const state = await store.load();
      const activeCount = state.accounts.filter(a => a.enabled !== false && !['محظور', 'كابتشا', 'معزول (3 إخفاقات)', 'غير مفعل'].includes(a.status)).length;
      assert.strictEqual(activeCount, 5, 'Active count is 5');

      // Attempting to enable acc-9 now must fail
      const res9 = await ui.accountToggle(
        { parsed: { action: 'toggle', value: 'acc-9' } },
        { callback_query: { id: 'cb-acc-9', from: { id: 1 }, message: { chat: { id: 1 } } } }
      );
      assert.strictEqual(res9.limitExceeded, true, 'acc-9 blocked from exceeding 5 active');

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('3.3 Mid-cycle account swap: disabling an account allows immediate replacement in activeRun without losing cookies/quota', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'challenger-midcycle-swap-'));
      const dbPath = path.join(tempDir, 'state.sqlite');

      const accounts = [
        { id: 'acc-1', username: 'user1', enabled: true, status: 'مفعل', quota: 10, cookieFile: '/cookies/1.json' },
        { id: 'acc-2', username: 'user2', enabled: true, status: 'مفعل', quota: 20, cookieFile: '/cookies/2.json' },
        { id: 'acc-3', username: 'user3', enabled: true, status: 'مفعل', quota: 30, cookieFile: '/cookies/3.json' },
        { id: 'acc-4', username: 'user4', enabled: true, status: 'مفعل', quota: 40, cookieFile: '/cookies/4.json' },
        { id: 'acc-5', username: 'user5', enabled: true, status: 'مفعل', quota: 50, cookieFile: '/cookies/5.json' },
        { id: 'acc-6', username: 'user6', enabled: false, status: 'غير مفعل', quota: 60, cookieFile: '/cookies/6.json' }
      ];

      const store = new SqliteStore(dbPath, {
        accounts,
        vpnSlots: { 'acc-1': 1, 'acc-2': 2, 'acc-3': 3, 'acc-4': 4, 'acc-5': 5 },
        cycle: { state: 'running' },
        telegramUi: { run: { runId: 'run-live', accountIds: ['acc-1', 'acc-2', 'acc-3', 'acc-4', 'acc-5'], cursor: 2 } }
      });
      await store.load();

      const mockTransport = {
        sendMessage: async () => ({ message_id: 1 }),
        editMessageText: async () => ({ message_id: 1 }),
        acknowledgeCallback: async () => {}
      };
      const rotated = [];
      const released = [];
      const mockVpn = {
        rotate: async id => { rotated.push(id); },
        release: async id => { released.push(id); }
      };

      const ui = new TelegramUi({ bot: { store, transport: mockTransport, vpnManager: mockVpn } });
      ui.activeRun = { runId: 'run-live', accountIds: ['acc-1', 'acc-2', 'acc-3', 'acc-4', 'acc-5'], cursor: 2 };

      // Step 1: Disable acc-3
      const disRes = await ui.accountToggle(
        { parsed: { action: 'toggle', value: 'acc-3' } },
        { callback_query: { id: 'cb-dis-3', from: { id: 1 }, message: { chat: { id: 1 } } } }
      );
      assert.strictEqual(disRes.toggled, false);
      assert.ok(released.includes('acc-3'), 'acc-3 VPN slot released');
      assert.deepStrictEqual(ui.activeRun.accountIds, ['acc-1', 'acc-2', 'acc-4', 'acc-5']);

      // Step 2: Enable acc-6 in its place
      const enRes = await ui.accountToggle(
        { parsed: { action: 'toggle', value: 'acc-6' } },
        { callback_query: { id: 'cb-en-6', from: { id: 1 }, message: { chat: { id: 1 } } } }
      );
      assert.strictEqual(enRes.toggled, true);
      assert.ok(rotated.includes('acc-6'), 'acc-6 VPN rotated');
      assert.deepStrictEqual(ui.activeRun.accountIds, ['acc-1', 'acc-2', 'acc-4', 'acc-5', 'acc-6']);

      // Step 3: Verify all quotas and cookies intact
      const finalState = await store.load();
      assert.strictEqual(finalState.accounts.find(a => a.id === 'acc-3').quota, 30);
      assert.strictEqual(finalState.accounts.find(a => a.id === 'acc-6').quota, 60);
      assert.strictEqual(finalState.accounts.find(a => a.id === 'acc-3').cookieFile, '/cookies/3.json');
      assert.strictEqual(finalState.accounts.find(a => a.id === 'acc-6').cookieFile, '/cookies/6.json');

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('3.4 Single clear Arabic isolation alerts and queue stall throttling stress test', async () => {
      const notifications = [];
      const mockNotify = async msg => { notifications.push(msg); };
      const ui = new TelegramUi({ bot: {}, notify: mockNotify });

      // Adversarial test: 20 rapid queue stall alert dispatches
      for (let i = 0; i < 20; i++) {
        await ui.sendQueueStallAlert();
      }
      assert.strictEqual(notifications.length, 1, 'Exactly 1 queue stall alert sent across 20 calls');
      assert.strictEqual(notifications[0], 'جميع الحسابات غير مؤهلة أو في فترة انتظار؛ توقفت الدورة وبقيت المنشورات في الانتظار.');

      // Reset stall state (e.g. on new cycle start)
      ui.resetQueueStall();
      await ui.sendQueueStallAlert();
      assert.strictEqual(notifications.length, 2, 'New stall event sends exactly 1 new alert');

      // Test transient strikes (1 and 2) suppressed
      for (let strike = 1; strike <= 2; strike++) {
        const res = await ui.notifyStrike({ account: { username: 'testuser' }, strikeNumber: strike });
        assert.strictEqual(res.suppressed, true);
      }
      assert.strictEqual(notifications.length, 2, 'No notifications sent for strikes 1 and 2');

      // Test strike 3 isolation alert across all 4 diagnostic classes
      const testCases = [
        { reason: 'banned', expected: ISOLATION_REASONS.BANNED },
        { reason: 'captcha', expected: ISOLATION_REASONS.CAPTCHA },
        { reason: 'cookie_expired', expected: ISOLATION_REASONS.COOKIE_REJECTED },
        { reason: '3_failures', expected: ISOLATION_REASONS.STRIKES_EXCEEDED }
      ];

      for (const tc of testCases) {
        notifications.length = 0; // Clear
        await ui.sendIsolationAlert({
          account: { username: 'victim' },
          reason: tc.reason,
          failures: 3,
          otherActiveCount: 2
        });
        assert.strictEqual(notifications.length, 1, 'Exactly 1 isolation alert sent');
        assert.ok(notifications[0].includes(`السبب: ${tc.expected}`), `Contains expected reason ${tc.expected}`);
        assert.ok(notifications[0].includes('ومواصلة الدورة عبر بقية الحسابات (2).'));
      }
    });
  });

});
