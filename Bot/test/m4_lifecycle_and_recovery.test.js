'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const { TelegramUi } = require(path.join(ROOT, 'src/telegramUi'));
const { SingleInstanceLock, run } = require(path.join(ROOT, 'src/runner'));
const { SqliteStore } = require(path.join(ROOT, 'src/sqliteStore'));
const { formatAccountTable } = require(path.join(ROOT, 'src/accountTable'));
const { quotaAdmission, riyadhDay } = require(path.join(ROOT, 'src/quota'));

function createMockTransport() {
  const sentMessages = [];
  const editedMessages = [];
  const acknowledgedCallbacks = [];
  return {
    sentMessages,
    editedMessages,
    acknowledgedCallbacks,
    sendMessage: async (chat, text, opts) => {
      const msg = { message_id: Math.floor(Math.random() * 10000) + 1, chat, text, opts };
      sentMessages.push(msg);
      return msg;
    },
    editMessageText: async (chat, messageId, text, opts) => {
      const msg = { chat, messageId, text, opts };
      editedMessages.push(msg);
      return msg;
    },
    acknowledgeCallback: async (callbackId, text, alert) => {
      acknowledgedCallbacks.push({ callbackId, text, alert });
    },
    keyboard: () => ({ keyboard: [], resize_keyboard: true })
  };
}

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
    ensure: async () => ({ exitIp: '187.40.234.102', proxy: 'socks5h://127.0.0.1:18801' }),
    health: async () => ({ healthy: true, exitIp: '187.40.234.102' }),
    rotate: async () => {}
  };
}

describe('Milestone M4 & M5: Lifecycle, Telegram CSV, Recovery & Governance Suite', () => {

  // =========================================================================
  // SUBTASK 1: Bot Lifecycle Testing (Start/Stop) & UI Buttons (R4)
  // =========================================================================
  describe('Subtask 1: Bot Lifecycle (Start/Stop) & UI Buttons', () => {

    test('1.1 UI Controls rendering: "🟢 تشغيل" when stopped, "🔴 إيقاف" when running', () => {
      const transport = createMockTransport();
      const ui = new TelegramUi({
        bot: { transport, store: { load: async () => ({}) }, accounts: { list: async () => [] } }
      });

      const stoppedControls = ui.controls('stopped', 'token-123');
      assert.strictEqual(stoppedControls.inline_keyboard.length, 1);
      assert.strictEqual(stoppedControls.inline_keyboard[0][0].text, '🟢 تشغيل');
      assert.strictEqual(stoppedControls.inline_keyboard[0][0].callback_data, 'cycle:start:token-123');
      assert.strictEqual(stoppedControls.inline_keyboard[0][1].text, '🔄 تحديث');
      assert.strictEqual(stoppedControls.inline_keyboard[0][1].callback_data, 'cycle:refresh:token-123');

      const runningControls = ui.controls('running', 'token-456');
      assert.strictEqual(runningControls.inline_keyboard.length, 1);
      assert.strictEqual(runningControls.inline_keyboard[0][0].text, '🔴 إيقاف');
      assert.strictEqual(runningControls.inline_keyboard[0][0].callback_data, 'cycle:stop:token-456');
      assert.strictEqual(runningControls.inline_keyboard[0][1].text, '🔄 تحديث');

      const stoppingControls = ui.controls('stopping', 'token-789');
      assert.strictEqual(stoppingControls.inline_keyboard[0][0].text, '🔴 إيقاف');
    });

    test('1.2 State transition: cycle start and stop transitions with token fencing', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm4-lifecycle-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const store = new SqliteStore(dbPath, {
        cycle: { state: 'stopped', runId: null },
        telegramUi: {
          users: { 'admin-1': { panel: { token: 'token-cycle-1', stopToken: 'token-stop-1' } } }
        }
      });
      await store.load();

      const transport = createMockTransport();
      let cycleStoppedEventCalled = false;
      const ui = new TelegramUi({
        bot: { transport, store, accounts: { list: async () => [] } },
        onCycleStop: () => { cycleStoppedEventCalled = true; }
      });

      // Stop while already stopped returns stopped: false
      const stopResult1 = await ui.stop('token-stop-1', { key: 'admin-1', chat: 528864559 });
      assert.strictEqual(stopResult1.stopped, false, 'Stopping an already stopped cycle must return false');

      // Set to running
      await store.update(s => {
        s.cycle.state = 'running';
        s.telegramUi.run = { runId: 'run-test-1', maxItems: 1 };
        return s;
      });

      // Stop with wrong token is rejected
      const stopResultWrongToken = await ui.stop('token-wrong', { key: 'admin-1', chat: 528864559 });
      assert.strictEqual(stopResultWrongToken.stopped, false, 'Mismatched stop token must be rejected');

      // Stop with valid token succeeds
      const stopResultValid = await ui.stop('token-stop-1', { key: 'admin-1', chat: 528864559 });
      assert.strictEqual(stopResultValid.stopped, true, 'Valid stop token transitions state to stopping');
      assert.strictEqual(cycleStoppedEventCalled, true, 'onCycleStop callback must be invoked');

      const finalState = await store.load();
      assert.strictEqual(finalState.cycle.state, 'stopping');
    });

    test('1.3 Race condition prevention: Duplicate start requests while running are rejected safely', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm4-race-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const store = new SqliteStore(dbPath, {
        cycle: { state: 'running', runId: 'active-run' },
        telegramUi: {
          dashboards: { '528864559': { token: 'tok-active', stopToken: 'tok-active-stop' } }
        }
      });
      await store.load();

      const transport = createMockTransport();
      const ui = new TelegramUi({
        bot: { transport, store, accounts: { list: async () => [] } }
      });

      let ackCalled = false;
      const req = {
        action: 'cycleControl',
        parsed: { action: 'start', value: 'tok-active' },
        acknowledge: async () => { ackCalled = true; }
      };

      const result = await ui.cycleControl(req, {
        callback_query: { id: 'cb-1', from: { id: 528864559 }, message: { chat: { id: 528864559 }, message_id: 10 } }
      });

      assert.strictEqual(result.started, false);
      assert.strictEqual(result.running, true);
      assert.strictEqual(ackCalled, true);
    });

    test('1.4 Account refresh lifecycle: "⏳ جاري التحديث" -> verification -> "🔄 تحديث" and Exit IP display', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm4-refresh-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const store = new SqliteStore(dbPath, {
        accounts: [
          { id: 'acc-1', username: 'crytpokingxvo8', enabled: true, exitIp: '187.40.234.102' },
          { id: 'acc-2', username: 'emiehg', enabled: true, exitIp: '187.14.50.72' }
        ],
        telegramUi: {
          accountChecks: {}
        }
      });
      await store.load();

      const transport = createMockTransport();
      const ui = new TelegramUi({
        bot: { transport, store, accounts: { list: async () => [] } }
      });

      // Before refresh: controls show "🔄 تحديث"
      assert.strictEqual(ui.controls('stopped', 'tok').inline_keyboard[0][1].text, '🔄 تحديث');

      // Table formatting shows both Exit IPs
      const stateBefore = await store.load();
      const tableBefore = formatAccountTable(stateBefore, { now: new Date() });
      assert.ok(tableBefore.includes('187.40.234.102'), 'Must show IP for crytpokingxvo8');
      assert.ok(tableBefore.includes('187.14.50.72'), 'Must show IP for emiehg');
      assert.ok(tableBefore.includes('@crytpokingxvo8'));
      assert.ok(tableBefore.includes('@emiehg'));

      // Simulate refresh job in-flight
      const mockJob = {
        pending: new Set(['acc-1']),
        controller: new AbortController()
      };
      ui.accountRefreshJob = mockJob;

      // Controls now show "⏳ جاري التحديث"
      assert.strictEqual(ui.controls('stopped', 'tok').inline_keyboard[0][1].text, '⏳ جاري التحديث');

      // Table during refresh shows "جاري التحديث" for acc-1 while retaining Exit IP
      const tableDuring = formatAccountTable(stateBefore, { now: new Date(), refreshingIds: mockJob.pending });
      assert.ok(tableDuring.includes('جاري التحديث'), 'Status shows جاري التحديث while in-flight');
      assert.ok(tableDuring.includes('187.40.234.102'), 'Exit IP is retained during refresh');

      // Completion: clear job
      ui.accountRefreshJob = null;
      assert.strictEqual(ui.controls('stopped', 'tok').inline_keyboard[0][1].text, '🔄 تحديث');
    });

    test('1.5 Docker VPN health: SOCKS5 exit IPs match expected public IPs', async () => {
      const checkPort = (port) => new Promise((resolve) => {
        const curl = spawn('curl', ['-sS', '-m', '10', '--socks5', `127.0.0.1:${port}`, 'https://api.ipify.org']);
        let data = '';
        curl.stdout.on('data', chunk => { data += chunk; });
        curl.on('close', code => {
          resolve({ code, ip: data.trim() });
        });
      });

      const [res1, res2] = await Promise.all([checkPort(18801), checkPort(18802)]);
      assert.strictEqual(res1.code, 0, 'Port 18801 must respond cleanly');
      assert.strictEqual(res2.code, 0, 'Port 18802 must respond cleanly');
      assert.strictEqual(res1.ip, '187.40.234.102', 'Port 18801 must return 187.40.234.102');
      assert.strictEqual(res2.ip, '187.14.50.72', 'Port 18802 must return 187.14.50.72');
    });
  });

  // =========================================================================
  // SUBTASK 2: Telegram Notifications & CSV Generation (R4)
  // =========================================================================
  describe('Subtask 2: Telegram Notifications & CSV Generation', () => {

    test('2.1 Verify links_2026-11-01.csv contains all 15 authentic published records', () => {
      const csvPath = path.join(ROOT, 'data/exports/links_2026-11-01.csv');
      assert.ok(fs.existsSync(csvPath), 'links_2026-11-01.csv must exist');

      let content = fs.readFileSync(csvPath, 'utf8');
      // Strip UTF-8 BOM if present
      if (content.charCodeAt(0) === 0xFEFF) {
        content = content.slice(1);
      }
      assert.ok(content.startsWith('Date,Account,URL,Text'), 'Header must match Date,Account,URL,Text');

      // Parse CSV records using csv parser
      const { splitRows, parseLine } = require(path.join(ROOT, 'src/csv'));
      const allRows = splitRows(content).map(parseLine).filter(r => r.some(Boolean));
      const headers = allRows[0];
      assert.deepStrictEqual(headers, ['Date', 'Account', 'URL', 'Text'], 'Headers must match Date,Account,URL,Text');
      const dataRows = allRows.slice(1);
      assert.strictEqual(dataRows.length, 15, 'CSV must contain exactly 15 records');

      const records = dataRows.map(cols => Object.fromEntries(headers.map((h, i) => [h, cols[i]])));

      const crytpokingRecords = records.filter(r => r.Account === '@crytpokingxvo8');
      const emiehgRecords = records.filter(r => r.Account === '@emiehg');

      assert.strictEqual(crytpokingRecords.length, 9, '@crytpokingxvo8 must have 9 records');
      assert.strictEqual(emiehgRecords.length, 6, '@emiehg must have 6 records');

      for (const record of records) {
        assert.ok(record.Date && !isNaN(Date.parse(record.Date)), 'Date must be valid ISO timestamp');
        assert.ok(record.URL && record.URL.startsWith('https://x.com/'), 'URL must be a valid X link');
        assert.ok(record.Text && record.Text.length > 10, 'Text must be non-empty valid content');
        assert.ok(['@crytpokingxvo8', '@emiehg'].includes(record.Account), 'Account must be valid handle');
      }

      // Check last published item (from M3)
      const last = records[14];
      assert.strictEqual(last.Account, '@emiehg');
      assert.strictEqual(last.URL, 'https://x.com/emiehg/status/2116996420637196576');
      assert.ok(last.Date.startsWith('2026-11-01T23:50:53'));
    });

    test('2.2 Journalctl evidence: proves document delivery to admin chats 528864559 and 5535435580', async () => {
      const getLogs = () => new Promise((resolve, reject) => {
        const proc = spawn('journalctl', ['-u', 'yj-telegram-bot.service', '--no-pager', '-n', '500']);
        let out = '';
        proc.stdout.on('data', chunk => { out += chunk; });
        proc.on('close', code => {
          if (code === 0) resolve(out);
          else reject(new Error(`journalctl failed with code ${code}`));
        });
      });

      const logs = await getLogs();
      const docSentMatches = [...logs.matchAll(/telegram_document_sent.*?chat_id":"(\d+)".*?message_id":(\d+)/g)];
      assert.ok(docSentMatches.length >= 2, 'Must have at least 2 document sent events');

      const deliveredChats = new Set(docSentMatches.map(m => m[1]));
      assert.ok(deliveredChats.has('528864559'), 'Chat 528864559 must receive documents');
      assert.ok(deliveredChats.has('5535435580'), 'Chat 5535435580 must receive documents');

      // Verify the M3 document delivery messages 1245 and 1246
      assert.ok(logs.includes('"chat_id":"528864559","message_id":1245'), 'Message 1245 sent to 528864559');
      assert.ok(logs.includes('"chat_id":"5535435580","message_id":1246'), 'Message 1246 sent to 5535435580');
    });
  });

  // =========================================================================
  // SUBTASK 3: Failure & Recovery Validation (R5)
  // =========================================================================
  describe('Subtask 3: Failure & Recovery Validation', () => {

    test('3.1 Network timeout / dropped connection: transitions to ambiguous, sets skipDelay, leaves quota intact', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm4-timeout-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const cookiePath = path.join(tempDir, 'cookie.json');
      fs.writeFileSync(cookiePath, '{}');

      const store = new SqliteStore(dbPath, {
        items: [
          { id: 'item-timeout-1', state: 'pending', payload: { text: 'Timeout test item 1' } }
        ],
        accounts: [{ id: 'acct-timeout-1', username: 'crytpokingxvo8', userId: '101', enabled: true, cookieFile: cookiePath }],
        cycle: { state: 'stopped', runId: null },
        settings: { dailyQuota: 10, delayMinSeconds: 1, delayMaxSeconds: 1 },
        posting: { quota: { '2026-11-01': { 'acct-timeout-1': 5 } } }
      });
      await store.load();

      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async () => ({ slot: 1, identity: { authenticated: true, username: 'crytpokingxvo8', userId: '101' } }),
        publish: async ({ onDispatch }) => {
          await onDispatch({ accountId: 'acct-timeout-1' });
          // Simulate network timeout after dispatch entry
          return { published: false, ambiguous: true, reason: 'publish_confirmation_missing' };
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

      const stateAfter = await store.load();
      const item1 = stateAfter.items.find(x => x.id === 'item-timeout-1');
      assert.strictEqual(item1.state, 'ambiguous', 'Dropped connection must transition item to ambiguous');
      assert.strictEqual(item1.reason, 'publish_confirmation_missing');

      // Verify ZERO quota deduction
      const today = riyadhDay();
      assert.strictEqual(stateAfter.posting?.quota?.[today]?.['acct-timeout-1'] || 0, 0, 'Zero quota deducted for ambiguous');
    });

    test('3.2 Quota exhaustion boundary test: accounts at quota limit are never dispatched', async () => {
      const state = {
        items: [
          { id: 'item-1', state: 'pending', payload: { text: 'Valid test post text' } }
        ],
        accounts: [
          { id: 'acc-exhausted', username: 'crytpokingxvo8', enabled: true, quota: 10 }
        ],
        settings: { dailyQuota: 10 },
        posting: {
          quota: {
            '2026-11-01': { 'acc-exhausted': 10 }
          }
        }
      };

      const now = new Date('2026-11-01T12:00:00Z');
      const admission = quotaAdmission(state, { accounts: state.accounts, now });
      assert.strictEqual(admission.exhausted, true, 'Quota admission must declare exhausted=true');
      assert.ok(admission.message.includes('الكوتا اليومية للحسابات ممتلئة'), 'Message must indicate daily quota exhausted');
    });

    test('3.3 SingleInstanceLock concurrency collision test: rejects concurrent process', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm4-lock-'));
      const lockPath = path.join(tempDir, 'test.lock');

      const lock1 = new SingleInstanceLock(lockPath, { timeoutMs: 1000 });
      await lock1.acquire();

      const lock2 = new SingleInstanceLock(lockPath, { timeoutMs: 500 });
      let caught = null;
      try {
        await lock2.acquire();
      } catch (err) {
        caught = err;
      }

      assert.ok(caught, 'Second lock acquire must throw');
      assert.strictEqual(caught.code, 'INSTANCE_LOCKED');
      assert.strictEqual(caught.pid, process.pid);

      await lock1.release();
      assert.strictEqual(fs.existsSync(lockPath), false, 'Lockfile removed on release');
    });
  });
});
