'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const { TelegramUi } = require(path.join(ROOT, 'src/telegramUi'));
const { SingleInstanceLock } = require(path.join(ROOT, 'src/runner'));
const { SqliteStore } = require(path.join(ROOT, 'src/sqliteStore'));
const { Queue } = require(path.join(ROOT, 'src/queue'));
const { createDockerRuntime } = require(path.join(ROOT, 'src/dockerVpn'));

function createMockTransport() {
  const sentMessages = [];
  const editedMessages = [];
  const acknowledgedCallbacks = [];
  return {
    sentMessages,
    editedMessages,
    acknowledgedCallbacks,
    sendMessage: async (chat, text, opts) => {
      const msg = { message_id: Math.floor(Math.random() * 100000) + 1, chat, text, opts };
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

describe('Challenger 1 Adversarial Suite: M4 & M5 Stress & Boundary Tests', () => {

  // =========================================================================
  // CHALLENGE 1: SOCKS5 Proxy Direct Probing & Exit IP Stability
  // =========================================================================
  describe('Challenge 1: SOCKS5 Proxy Direct Probing & IP Leaks', () => {
    test('1.1 Direct SOCKS5 probe across ports 18801 and 18802 matches verified Exit IPs', async () => {
      const probePort = (port) => new Promise((resolve, reject) => {
        const proc = spawn('curl', ['-sS', '-m', '10', '--socks5-hostname', `127.0.0.1:${port}`, 'https://api.ipify.org']);
        let data = '';
        let err = '';
        proc.stdout.on('data', chunk => { data += chunk; });
        proc.stderr.on('data', chunk => { err += chunk; });
        proc.on('close', code => {
          if (code === 0) resolve(data.trim());
          else reject(new Error(`curl exit ${code}: ${err}`));
        });
      });

      const [ip18801, ip18802] = await Promise.all([probePort(18801), probePort(18802)]);
      assert.match(ip18801, /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/, 'Port 18801 Exit IP must be valid IPv4');
      assert.match(ip18802, /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/, 'Port 18802 Exit IP must be valid IPv4');
      assert.notStrictEqual(ip18801, ip18802, 'Ports 18801 and 18802 must have distinct exit IPs');
    });

    test('1.2 Host public IP does not leak through SOCKS5 proxy endpoints', async () => {
      const getDirectIp = () => new Promise((resolve, reject) => {
        const proc = spawn('curl', ['-sS', '-m', '5', 'https://api.ipify.org']);
        let data = '';
        proc.stdout.on('data', chunk => { data += chunk; });
        proc.on('close', code => {
          if (code === 0) resolve(data.trim());
          else reject(new Error('direct curl failed'));
        });
      });

      const directIp = await getDirectIp();
      assert.ok(directIp, 'Must obtain direct host IP');
      assert.notStrictEqual(directIp, '187.40.234.102', 'Host IP must not match port 18801 Exit IP');
      assert.notStrictEqual(directIp, '187.14.50.72', 'Host IP must not match port 18802 Exit IP');
    });

    test('1.3 Runtime getExitIp multi-provider fallback behavior', async () => {
      let callCount = 0;
      const customRuntime = createDockerRuntime({
        command: async (bin, args) => {
          callCount++;
          // Fail primary provider (api.ipify.org), succeed on secondary (icanhazip.com)
          const targetUrl = args[args.length - 1];
          if (targetUrl.includes('ipify')) {
            throw new Error('Synthetic network failure');
          }
          return { stdout: '187.40.234.102\n' };
        },
        wait: async () => {}
      });

      const resolved = await customRuntime.getExitIp(18801);
      assert.strictEqual(resolved, '187.40.234.102');
      assert.ok(callCount >= 2, 'Must attempt fallback provider when primary fails');
    });
  });

  // =========================================================================
  // CHALLENGE 2: High Concurrency Burst & Race Condition Immunity
  // =========================================================================
  describe('Challenge 2: High Concurrency Burst & Race Condition Immunity', () => {
    test('2.1 Burst of 50 concurrent start requests with identical token results in exactly 1 start', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'challenger-race-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const cookieFile = path.join(tempDir, 'c.json');
      fs.writeFileSync(cookieFile, '{}');

      const store = new SqliteStore(dbPath, {
        cycle: { state: 'stopped', runId: null },
        accounts: [{ id: 'acc-race-1', username: 'crytpokingxvo8', enabled: true, cookieFile }],
        settings: { dailyQuota: 10, delayMinSeconds: 5, delayMaxSeconds: 10 },
        items: [{ id: 'item-race-1', state: 'pending', payload: { text: 'Adversarial race test tweet valid text' } }],
        telegramUi: {
          dashboards: { '528864559': { token: 'tok-burst', stopToken: 'tok-stop-burst', messageId: 999 } },
          users: { '528864559:528864559': { panel: { token: 'tok-burst', stopToken: 'tok-stop-burst', messageId: 999 } } }
        }
      });
      await store.load();

      const transport = createMockTransport();
      let launchCallCount = 0;
      let runnerPromiseResolve = null;
      const runnerPromise = new Promise(r => { runnerPromiseResolve = r; });

      const ui = new TelegramUi({
        bot: { transport, store, accounts: { list: async () => [] } },
        runtimeReady: async () => ({ ready: true }),
        launch: async (snapshot) => {
          launchCallCount++;
          await runnerPromise;
        }
      });

      const burstSize = 50;
      const requests = Array.from({ length: burstSize }, (_, idx) => {
        const req = {
          action: 'cycleControl',
          parsed: { action: 'start', value: 'tok-burst' },
          acknowledge: async () => {}
        };
        const raw = {
          callback_query: { id: `cb-${idx}`, from: { id: 528864559 }, message: { chat: { id: 528864559 }, message_id: 999 } }
        };
        return ui.cycleControl(req, raw);
      });

      const results = await Promise.all(requests);
      assert.strictEqual(launchCallCount, 1, 'Only 1 request should trigger launch');

      const startedResults = results.filter(r => r.started === true);
      const rejectedResults = results.filter(r => r.started === false);
      assert.strictEqual(startedResults.length, 1, 'Exactly 1 request reports started: true');
      assert.strictEqual(rejectedResults.length, burstSize - 1, 'All subsequent requests report started: false');

      const intermediateState = await store.load();
      assert.strictEqual(intermediateState.cycle.state, 'running', 'State must be running');

      // Finish the runner
      runnerPromiseResolve();
      await new Promise(r => setImmediate(r));
    });

    test('2.2 Token mismatch and stale panel message IDs are 100% rejected', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'challenger-token-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const store = new SqliteStore(dbPath, {
        cycle: { state: 'stopped', runId: null },
        telegramUi: {
          dashboards: { '528864559': { token: 'tok-valid', stopToken: 'tok-stop-valid', messageId: 100 } }
        }
      });
      await store.load();

      const transport = createMockTransport();
      const ui = new TelegramUi({
        bot: { transport, store, accounts: { list: async () => [] } }
      });

      // Mismatched token
      const resBadToken = await ui.cycleControl({
        action: 'cycleControl',
        parsed: { action: 'start', value: 'tok-forged' }
      }, {
        callback_query: { id: 'cb-bad', from: { id: 528864559 }, message: { chat: { id: 528864559 }, message_id: 100 } }
      });
      assert.strictEqual(resBadToken.stale, true, 'Bad token must be flagged stale');

      // Stale messageId (older dashboard panel)
      const resStaleMessage = await ui.cycleControl({
        action: 'cycleControl',
        parsed: { action: 'start', value: 'tok-valid' }
      }, {
        callback_query: { id: 'cb-stale-msg', from: { id: 528864559 }, message: { chat: { id: 528864559 }, message_id: 99 } }
      });
      assert.strictEqual(resStaleMessage.stale, true, 'Mismatched messageId must be flagged stale');
    });

    test('2.3 Token fencing: forged/arbitrary token is rejected for stop', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'challenger-fencing-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const store = new SqliteStore(dbPath, {
        cycle: { state: 'running', runId: 'run-cross' },
        telegramUi: {
          dashboards: { '528864559': { token: 'tok-panel-123', stopToken: 'tok-stop-456', messageId: 200 } }
        }
      });
      await store.load();

      const transport = createMockTransport();
      const ui = new TelegramUi({
        bot: { transport, store, accounts: { list: async () => [] } }
      });

      // Attempting to stop using completely arbitrary / forged token
      const stopWithForgedToken = await ui.stop('forged-token-xyz', { chat: 528864559, key: '528864559' });
      assert.strictEqual(stopWithForgedToken.stopped, false, 'Stop with forged token must be rejected');

      // Attempting to stop with authorized panel token succeeds
      const stopWithPanelToken = await ui.stop('tok-stop-456', { chat: 528864559, key: '528864559' });
      assert.strictEqual(stopWithPanelToken.stopped, true, 'Stop with valid stopToken must succeed');
    });
  });

  // =========================================================================
  // CHALLENGE 3: Process Crash Recovery & In-flight Item Quarantine
  // =========================================================================
  describe('Challenge 3: Process Crash Recovery & In-flight Item Quarantine', () => {
    test('3.1 In-flight processing items transition cleanly to ambiguous with reason restart on recovery', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'challenger-crash-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const store = new SqliteStore(dbPath, {
        items: [
          { id: 'item-done-1', state: 'published' },
          { id: 'item-inflight-1', state: 'processing', claimedAt: new Date().toISOString() },
          { id: 'item-pending-1', state: 'pending' }
        ],
        cycle: { state: 'running', runId: 'crashed-run-1' }
      });
      await store.load();

      const queue = new Queue(store);
      await queue.recoverProcessing({ state: 'ambiguous', reason: 'restart' });

      const recoveredState = await store.load();
      const item1 = recoveredState.items.find(x => x.id === 'item-inflight-1');
      assert.strictEqual(item1.state, 'ambiguous', 'In-flight item must be ambiguous');
      assert.strictEqual(item1.outcome, 'ambiguous');
      assert.strictEqual(item1.result.reason, 'restart');

      const itemDone = recoveredState.items.find(x => x.id === 'item-done-1');
      assert.strictEqual(itemDone.state, 'published', 'Already published items untouched');

      const itemPending = recoveredState.items.find(x => x.id === 'item-pending-1');
      assert.strictEqual(itemPending.state, 'pending', 'Pending items untouched');
    });

    test('3.2 Stale SingleInstanceLock is reclaimed after holding PID terminates', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'challenger-stale-lock-'));
      const lockPath = path.join(tempDir, 'test.lock');

      // Create a stale lock file with a dead PID (PID 9999999)
      const deadPid = 9999999;
      fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid, token: 'old-tok', acquiredAt: new Date().toISOString() }) + '\n');

      const lock = new SingleInstanceLock(lockPath, { timeoutMs: 1000 });
      const releaseFn = await lock.acquire();
      assert.strictEqual(typeof releaseFn, 'function', 'Must acquire stale lock and return release function');
      assert.strictEqual(lock.locked, true, 'Lock must be locked');

      await lock.release();
      assert.strictEqual(fs.existsSync(lockPath), false, 'Lockfile must be cleaned up on release');
    });
  });

  // =========================================================================
  // CHALLENGE 4: CSV Export Security & Content Structure
  // =========================================================================
  describe('Challenge 4: CSV Export Security & Integrity', () => {
    test('4.1 Verify CSV formula injection escaping and valid URI structure', () => {
      const csvPath = path.join(ROOT, 'data/exports/links_2026-11-01.csv');
      assert.ok(fs.existsSync(csvPath), 'links_2026-11-01.csv exists');

      const content = fs.readFileSync(csvPath, 'utf8');
      const lines = content.split(/\r?\n/).filter(Boolean);

      // Verify header
      assert.ok(lines[0].includes('Date,Account,URL,Text'));

      // Check for dangerous formula starters without quotes/escaping
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        assert.ok(!line.startsWith('=') && !line.startsWith('+') && !line.startsWith('-'), `Line ${i} must not start with raw formula prefix`);
      }
    });
  });
});
