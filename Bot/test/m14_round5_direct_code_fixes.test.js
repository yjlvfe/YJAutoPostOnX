'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { ForensicLogger } = require('../src/forensicLogger');
const { mutexDbPath } = require('../src/forensicMutex');
const { SqliteStore } = require('../src/sqliteStore');
const { TelegramUi } = require('../src/telegramUi');
const { accountRecord } = require('../src/accounts');

const spawnChecked = (script, logFile) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [script, logFile], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'test' }
  });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data.toString(); });
  child.once('error', reject);
  child.once('close', code => {
    if (code === 0) resolve();
    else reject(new Error(`mutex worker ${child.pid} exited ${code}: ${stderr}`));
  });
});

describe('M14 direct code fixes: separate CAPTCHA incidents and true cross-process forensic mutex', () => {
  it('5 independent Node processes never overlap in their forensic critical sections', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm14-real-lock-'));
    try {
      const log = path.join(dir, 'forensic.jsonl');
      const worker = path.join(dir, 'worker.js');
      const modulePath = require.resolve('../src/forensicLogger');
      await fsp.writeFile(worker, `
        'use strict';
        const fsp = require('node:fs/promises');
        const path = require('node:path');
        const { ForensicLogger } = require(${JSON.stringify(modulePath)});
        (async () => {
          const log = process.argv[2];
          const logger = new ForensicLogger({ dataDir: path.dirname(log), logFile: log });
          await logger._withLogLock(async () => {
            await fsp.appendFile(log, 'BEGIN:' + process.pid + '\\n');
            await new Promise(resolve => setTimeout(resolve, 85));
            await fsp.appendFile(log, 'END:' + process.pid + '\\n');
          });
        })().catch(err => { console.error(err); process.exitCode = 1; });
      `, { mode: 0o600 });

      await Promise.all(Array.from({ length: 5 }, () => spawnChecked(worker, log)));
      const trace = (await fsp.readFile(log, 'utf8')).trim().split('\n');
      assert.equal(trace.length, 10);
      let active = 0;
      const pids = new Set();
      for (const entry of trace) {
        const [kind, pid] = entry.split(':');
        if (kind === 'BEGIN') {
          active += 1;
          pids.add(pid);
          assert.equal(active, 1, 'a second OS process entered the protected critical section');
        } else {
          assert.equal(kind, 'END');
          active -= 1;
          assert.equal(active, 0);
        }
      }
      assert.equal(pids.size, 5, 'five distinct Node processes must execute');
      const db = new DatabaseSync(mutexDbPath(log));
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM forensic_mutex').get().n, 0);
      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a new CAPTCHA incident alerts both chats even when previous incident was delivered', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm14-incident-reset-'));
    const dbPath = path.join(dir, 'state.sqlite');
    const chatA = '528864559';
    const chatB = '5535435580';
    const acc = {
      id: 'new_captcha_test', username: 'new_captcha_test', enabled: false,
      status: 'كابتشا', needsOwnerCaptcha: true, captchaIncidentId: 'incident_B',
      // Deliberately simulate inherited receipts from previous incident A.
      captchaDeliveredIncidentId: 'incident_A',
      captchaDeliveredChats: [chatA, chatB],
      lastNotifiedCaptchaIncidentId: 'incident_A'
    };
    const store = new SqliteStore(dbPath, { accounts: [accountRecord(acc)] });
    const sent = [];
    try {
      await store.load();
      const ui = new TelegramUi({
        bot: { store, auth: { chats: new Set([chatA, chatB]) }, transport: {} },
        autoStartTicker: false,
        notify: async (_message, options) => {
          const chats = options?.targetChatIds || [chatA, chatB];
          sent.push(...chats);
          return chats.map((chatId, i) => ({
            status: 'fulfilled',
            value: { ok: true, message_id: 100 + i, chat_id: chatId }
          }));
        }
      });
      const result = await ui.sendIsolationAlert({ account: acc, reason: 'captcha' });
      assert.ok(result, 'new incident must generate fresh alert');
      assert.deepEqual(sent.sort(), [chatA, chatB].sort());
      const after = await store.load();
      const saved = after.accounts.find(a => a.id === acc.id);
      assert.equal(saved.captchaDeliveredIncidentId, 'incident_B');
      assert.equal(saved.lastNotifiedCaptchaIncidentId, 'incident_B');
      assert.deepEqual(saved.captchaDeliveredChats.sort(), [chatA, chatB].sort());
      await ui.destroy();
    } finally {
      await store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
