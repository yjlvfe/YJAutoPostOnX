'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const {
  AccountManager,
  accountRecord,
  resetAccountFailures,
  incrementAccountFailures,
  MAX_ACCOUNTS,
  MAX_ACTIVE_ACCOUNTS
} = require(path.join(ROOT, 'src/accounts'));
const { SqliteStore } = require(path.join(ROOT, 'src/sqliteStore'));
const { run } = require(path.join(ROOT, 'src/runner'));

describe('Milestone M1: Accounts Schema, Ceilings & Failure Persistence', () => {

  describe('accountRecord Schema & Failures Normalization', () => {
    test('MAX_ACCOUNTS is Infinity and MAX_ACTIVE_ACCOUNTS is 5', () => {
      assert.strictEqual(MAX_ACCOUNTS, Infinity);
      assert.strictEqual(MAX_ACTIVE_ACCOUNTS, 5);
    });

    test('defaults failures to 0 when omitted or empty', () => {
      const r1 = accountRecord({ id: 'acc1' });
      assert.strictEqual(r1.failures, 0);

      const r2 = accountRecord({ id: 'acc2', failures: null });
      assert.strictEqual(r2.failures, 0);

      const r3 = accountRecord({ id: 'acc3', failures: '' });
      assert.strictEqual(r3.failures, 0);
    });

    test('preserves valid non-negative integer failures (0, 1, 2, 3)', () => {
      assert.strictEqual(accountRecord({ id: 'acc1', failures: 0 }).failures, 0);
      assert.strictEqual(accountRecord({ id: 'acc2', failures: 1 }).failures, 1);
      assert.strictEqual(accountRecord({ id: 'acc3', failures: 2 }).failures, 2);
      assert.strictEqual(accountRecord({ id: 'acc4', failures: 3 }).failures, 3);
      assert.strictEqual(accountRecord({ id: 'acc5', failures: '2' }).failures, 2);
    });

    test('rejects negative numbers and non-integers for failures', () => {
      assert.throws(() => accountRecord({ id: 'acc1', failures: -1 }), /must be a non-negative integer/);
      assert.throws(() => accountRecord({ id: 'acc2', failures: 1.5 }), /must be a non-negative integer/);
      assert.throws(() => accountRecord({ id: 'acc3', failures: 'abc' }), /must be a non-negative integer/);
      assert.throws(() => accountRecord({ id: 'acc4', failures: NaN }), /must be a non-negative integer/);
    });

    test('preserves status "معزول (3 إخفاقات)" and marks enabled: false', () => {
      const rec = accountRecord({ id: 'acc-isolated', status: 'معزول (3 إخفاقات)', failures: 3 });
      assert.strictEqual(rec.status, 'معزول (3 إخفاقات)');
      assert.strictEqual(rec.enabled, false);
      assert.strictEqual(rec.failures, 3);
    });
  });

  describe('AccountManager: Capacity Ceilings (Unlimited Stored & Max 5 Active)', () => {
    test('supports storing more than 1000 accounts in SQLite', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-unlimited-acc-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const store = new SqliteStore(dbPath, { accounts: [] });
      await store.load();

      const manager = new AccountManager(store);

      // Create 1005 accounts
      const records = [];
      for (let i = 1; i <= 1005; i++) {
        records.push({
          id: `acc-${i}`,
          username: `user${i}`,
          enabled: i <= 5 // exactly 5 enabled
        });
      }

      const replaced = await manager.replace(records);
      assert.strictEqual(replaced.length, 1005, 'Must allow 1005 stored accounts');

      const active = replaced.filter(a => a.enabled !== false && !['محظور', 'كابتشا', 'معزول (3 إخفاقات)'].includes(a.status));
      assert.strictEqual(active.length, 5, 'Exactly 5 accounts can be active');
    });

    test('add() auto-disables 6th enabled account when 5 are already active', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-active-cap-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const store = new SqliteStore(dbPath, { accounts: [] });
      await store.load();

      const manager = new AccountManager(store);

      for (let i = 1; i <= 5; i++) {
        const acc = await manager.add({ id: `active-${i}`, username: `active${i}`, enabled: true });
        assert.strictEqual(acc.enabled, true, `Account active-${i} should be enabled`);
        assert.strictEqual(acc.status, 'مفعل');
      }

      // 6th account should be auto-disabled
      const acc6 = await manager.add({ id: 'active-6', username: 'active6', enabled: true });
      assert.strictEqual(acc6.enabled, false, '6th account must be disabled');
      assert.strictEqual(acc6.status, 'غير مفعل');
    });

    test('replace() caps active accounts to exactly 5 and disables surplus', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-replace-cap-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const store = new SqliteStore(dbPath, { accounts: [] });
      await store.load();

      const manager = new AccountManager(store);

      // 8 accounts all marked enabled: true
      const records = Array.from({ length: 8 }, (_, i) => ({
        id: `acc-${i + 1}`,
        username: `user${i + 1}`,
        enabled: true
      }));

      const replaced = await manager.replace(records);
      const active = replaced.filter(a => a.enabled === true);
      const inactive = replaced.filter(a => a.enabled === false);

      assert.strictEqual(active.length, 5, 'Must cap active accounts to 5');
      assert.strictEqual(inactive.length, 3, 'Surplus 3 accounts must be disabled');
    });

    test('update() rejects enabling an account when 5 active accounts exist', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-update-cap-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const store = new SqliteStore(dbPath, { accounts: [] });
      await store.load();

      const manager = new AccountManager(store);

      for (let i = 1; i <= 5; i++) {
        await manager.add({ id: `acc-${i}`, username: `user${i}`, enabled: true });
      }
      await manager.add({ id: 'acc-disabled', username: 'user_disabled', enabled: false });

      // Trying to enable the 6th account should throw
      await assert.rejects(
        async () => manager.update('acc-disabled', { enabled: true }),
        /At most 5 active accounts are supported/
      );

      // Disabling one account allows enabling the other
      await manager.update('acc-1', { enabled: false });
      const enabled = await manager.update('acc-disabled', { enabled: true });
      assert.strictEqual(enabled.enabled, true);
      assert.strictEqual(enabled.status, 'مفعل');
    });
  });

  describe('Persistent 3-Failure Counter & Reset Operations', () => {
    test('incrementAccountFailures isolates on 3rd failure and survives reboot', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-failures-persist-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      let store = new SqliteStore(dbPath, {
        accounts: [{ id: 'acc-strike', username: 'striketest', enabled: true, status: 'مفعل', failures: 0 }]
      });
      await store.load();

      // 1st failure
      const res1 = await incrementAccountFailures(store, 'acc-strike');
      assert.strictEqual(res1.failures, 1);
      assert.strictEqual(res1.isolated, false);

      // 2nd failure
      const res2 = await incrementAccountFailures(store, 'acc-strike');
      assert.strictEqual(res2.failures, 2);
      assert.strictEqual(res2.isolated, false);

      // Simulate process reboot by creating a fresh SqliteStore instance
      store = new SqliteStore(dbPath);
      const reloadedState = await store.load();
      const reloadedAcc = reloadedState.accounts.find(a => a.id === 'acc-strike');
      assert.strictEqual(reloadedAcc.failures, 2, 'Failures count must survive reboot');
      assert.strictEqual(reloadedAcc.enabled, true);

      // 3rd failure
      const res3 = await incrementAccountFailures(store, 'acc-strike');
      assert.strictEqual(res3.failures, 3);
      assert.strictEqual(res3.isolated, true);

      const stateAfter3 = await store.load();
      const isolatedAcc = stateAfter3.accounts.find(a => a.id === 'acc-strike');
      assert.strictEqual(isolatedAcc.failures, 3);
      assert.strictEqual(isolatedAcc.enabled, false);
      assert.strictEqual(isolatedAcc.status, 'معزول (3 إخفاقات)');
    });

    test('resetAccountFailures resets failures counter to 0', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-reset-failures-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const store = new SqliteStore(dbPath, {
        accounts: [{ id: 'acc-reset', username: 'resettest', enabled: true, failures: 2 }]
      });
      await store.load();

      await resetAccountFailures(store, 'acc-reset');
      const state = await store.load();
      const acc = state.accounts.find(a => a.id === 'acc-reset');
      assert.strictEqual(acc.failures, 0);
    });
  });

  describe('Runner Natural Cycle & Account Isolation Integration', () => {
    test('transfers post to next account on recoverable failure and isolates on 3rd failure', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-runner-cycle-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const c1 = path.join(tempDir, 'c1.json');
      const c2 = path.join(tempDir, 'c2.json');
      fs.writeFileSync(c1, '{}');
      fs.writeFileSync(c2, '{}');

      const notifications = [];
      const mockApi = {
        getMe: async () => ({ id: 1 }),
        sendMessage: async (arg1, arg2) => {
          const text = typeof arg1 === 'object' && arg1 ? arg1.text : arg2;
          if (text) notifications.push(text);
          return { message_id: 1 };
        },
        sendRichMessage: async (arg1, arg2) => {
          const text = typeof arg1 === 'object' && arg1 ? arg1.text : arg2;
          if (text) notifications.push(text);
          return { message_id: 1 };
        },
        editMessageText: async () => ({ message_id: 1 }),
        deleteMessage: async () => {},
        getUpdates: async () => [],
        sendDocument: async () => ({})
      };

      const store = new SqliteStore(dbPath, {
        items: [{ id: 'item-1', state: 'pending', payload: { text: 'Cycle transfer test' } }],
        accounts: [
          { id: 'acc-1', username: 'failing_user', userId: '101', enabled: true, cookieFile: c1, failures: 2 },
          { id: 'acc-2', username: 'healthy_user', userId: '102', enabled: true, cookieFile: c2, failures: 0 }
        ],
        cycle: { state: 'stopped', runId: null },
        settings: { dailyQuota: 10, delayMinSeconds: 1, delayMaxSeconds: 1 },
        posting: {}
      });
      await store.load();

      let acc1Attempts = 0;
      let acc2Attempts = 0;

      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async ({ account }) => {
          if (account.id === 'acc-1') {
            acc1Attempts++;
            // Account 1 fails with cookie expired (recoverable failure)
            return {
              slot: 1,
              identity: {
                authenticated: false,
                accountFailure: 'cookie_expired',
                reason: 'token is expired'
              }
            };
          } else {
            acc2Attempts++;
            return {
              slot: 2,
              identity: {
                authenticated: true,
                username: 'healthy_user',
                userId: '102'
              }
            };
          }
        },
        publish: async ({ onDispatch }) => {
          await onDispatch({ accountId: 'acc-2' });
          return { published: true, url: 'https://x.com/healthy_user/status/999888' };
        },
        close: async () => {}
      });

      await run({
        token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
        dataDir: tempDir, api: mockApi,
        vpnManager: {
          ensure: async () => ({ exitIp: '1.2.3.4', proxy: 'socks5h://127.0.0.1:18801' }),
          health: async () => ({ healthy: true }),
          rotate: async () => {}
        },
        maxPolls: 0, publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
        logger: { log: () => {}, error: () => {} },
        onRuntimeReady: async (ctx) => {
          await ctx.start({ stopAfterSuccess: true });
          await ctx.wait();
        }
      });

      const finalState = await store.load();
      const item = finalState.items.find(x => x.id === 'item-1');
      assert.strictEqual(item.state, 'published');
      assert.strictEqual(item.url, 'https://x.com/healthy_user/status/999888');

      const acc1 = finalState.accounts.find(a => a.id === 'acc-1');
      const acc2 = finalState.accounts.find(a => a.id === 'acc-2');

      // Account 1 reached 3rd failure and got isolated
      assert.strictEqual(acc1.failures, 3, 'Account 1 failures must increment to 3');
      assert.strictEqual(acc1.enabled, false, 'Account 1 must be disabled after 3 strikes');
      assert.strictEqual(acc1.status, 'معزول (3 إخفاقات)');

      // Account 2 published successfully and reset its failures
      assert.strictEqual(acc2.failures, 0);

      // Verify exactly ONE isolation notification was sent for Account 1
      const isolationAlerts = notifications.filter(n => n.includes('تم عزل الحساب @failing_user') && n.includes('معزول (3 إخفاقات)'));
      assert.strictEqual(isolationAlerts.length, 1, 'Must send exactly 1 isolation alert');
    });

    test('immediately isolates conclusive "banned" account without waiting for 3 strikes', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-runner-banned-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const c1 = path.join(tempDir, 'c1.json');
      const c2 = path.join(tempDir, 'c2.json');
      fs.writeFileSync(c1, '{}');
      fs.writeFileSync(c2, '{}');

      const notifications = [];
      const mockApi = {
        getMe: async () => ({ id: 1 }),
        sendMessage: async (arg1, arg2) => {
          const text = typeof arg1 === 'object' && arg1 ? arg1.text : arg2;
          if (text) notifications.push(text);
          return { message_id: 1 };
        },
        sendRichMessage: async (arg1, arg2) => {
          const text = typeof arg1 === 'object' && arg1 ? arg1.text : arg2;
          if (text) notifications.push(text);
          return { message_id: 1 };
        },
        editMessageText: async () => ({ message_id: 1 }),
        deleteMessage: async () => {},
        getUpdates: async () => [],
        sendDocument: async () => ({})
      };

      const store = new SqliteStore(dbPath, {
        items: [{ id: 'item-ban-1', state: 'pending', payload: { text: 'Banned test' } }],
        accounts: [
          { id: 'acc-ban', username: 'banned_user', userId: '201', enabled: true, cookieFile: c1, failures: 0 },
          { id: 'acc-alt', username: 'alt_user', userId: '202', enabled: true, cookieFile: c2, failures: 0 }
        ],
        cycle: { state: 'stopped', runId: null },
        settings: { dailyQuota: 10, delayMinSeconds: 1, delayMaxSeconds: 1 },
        posting: {}
      });
      await store.load();

      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async ({ account }) => {
          if (account.id === 'acc-ban') {
            return {
              slot: 1,
              identity: {
                authenticated: false,
                accountFailure: 'banned',
                reason: 'auth_account_suspended'
              }
            };
          } else {
            return {
              slot: 2,
              identity: {
                authenticated: true,
                username: 'alt_user',
                userId: '202'
              }
            };
          }
        },
        publish: async ({ onDispatch }) => {
          await onDispatch({ accountId: 'acc-alt' });
          return { published: true, url: 'https://x.com/alt_user/status/777' };
        },
        close: async () => {}
      });

      await run({
        token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
        dataDir: tempDir, api: mockApi,
        vpnManager: {
          ensure: async () => ({ exitIp: '1.2.3.4', proxy: 'socks5h://127.0.0.1:18801' }),
          health: async () => ({ healthy: true }),
          rotate: async () => {}
        },
        maxPolls: 0, publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
        logger: { log: () => {}, error: () => {} },
        onRuntimeReady: async (ctx) => {
          await ctx.start({ stopAfterSuccess: true });
          await ctx.wait();
        }
      });

      const finalState = await store.load();
      const bannedAcc = finalState.accounts.find(a => a.id === 'acc-ban');
      assert.strictEqual(bannedAcc.enabled, false);
      assert.strictEqual(bannedAcc.status, 'محظور', 'Banned account must immediately have status محظور');

      const banAlerts = notifications.filter(n => n.includes('تم عزل الحساب @banned_user') && n.includes('محظور'));
      assert.strictEqual(banAlerts.length, 1);
    });

    test('rate limit sets cooling, preserves failures (0 strikes), and transfers post to next account', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-runner-ratelimit-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const c1 = path.join(tempDir, 'c1.json');
      const c2 = path.join(tempDir, 'c2.json');
      fs.writeFileSync(c1, '{}');
      fs.writeFileSync(c2, '{}');

      const notifications = [];
      const mockApi = {
        getMe: async () => ({ id: 1 }),
        sendMessage: async (arg1, arg2) => {
          const text = typeof arg1 === 'object' && arg1 ? arg1.text : arg2;
          if (text) notifications.push(text);
          return { message_id: 1 };
        },
        sendRichMessage: async (arg1, arg2) => {
          const text = typeof arg1 === 'object' && arg1 ? arg1.text : arg2;
          if (text) notifications.push(text);
          return { message_id: 1 };
        },
        editMessageText: async () => ({ message_id: 1 }),
        deleteMessage: async () => {},
        getUpdates: async () => [],
        sendDocument: async () => ({})
      };

      const store = new SqliteStore(dbPath, {
        items: [{ id: 'item-rl-1', state: 'pending', payload: { text: 'Rate limit test' } }],
        accounts: [
          { id: 'acc-rl', username: 'rl_user', userId: '301', enabled: true, cookieFile: c1, failures: 1 },
          { id: 'acc-other', username: 'other_user', userId: '302', enabled: true, cookieFile: c2, failures: 0 }
        ],
        cycle: { state: 'stopped', runId: null },
        settings: { dailyQuota: 10, delayMinSeconds: 1, delayMaxSeconds: 1 },
        posting: {}
      });
      await store.load();

      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async ({ account }) => ({
          accountId: account.id,
          slot: account.id === 'acc-rl' ? 1 : 2,
          identity: {
            authenticated: true,
            username: account.username,
            userId: account.userId
          }
        }),
        publish: async ({ session, onDispatch }) => {
          if (session.account?.id === 'acc-rl' || session.accountId === 'acc-rl') {
            return {
              status: 'rate_limit',
              published: false,
              posted: false,
              rateLimit: true,
              ambiguous: false,
              retryable: true,
              accountFailure: 'rate_limit',
              retryAfterSeconds: 60,
              reason: 'rate_limit'
            };
          } else {
            await onDispatch({ accountId: 'acc-other' });
            return { published: true, url: 'https://x.com/other_user/status/12345' };
          }
        },
        close: async () => {}
      });

      await run({
        token: 'test', userId: '1', chatId: '1', allowedUserIds: ['1'], allowedChatIds: ['1'],
        dataDir: tempDir, api: mockApi,
        vpnManager: {
          ensure: async () => ({ exitIp: '1.2.3.4', proxy: 'socks5h://127.0.0.1:18801' }),
          health: async () => ({ healthy: true }),
          rotate: async () => {}
        },
        maxPolls: 0, publishAdapterFactory, sleepFn: async () => {}, attemptTimeoutMs: 3000,
        logger: { log: () => {}, error: () => {} },
        onRuntimeReady: async (ctx) => {
          await ctx.start({ stopAfterSuccess: true });
          await ctx.wait();
        }
      });

      const finalState = await store.load();
      const rlAcc = finalState.accounts.find(a => a.id === 'acc-rl');
      const otherAcc = finalState.accounts.find(a => a.id === 'acc-other');
      const item = finalState.items.find(x => x.id === 'item-rl-1');

      // Failures NOT incremented for rate limit
      assert.strictEqual(rlAcc.failures, 1, 'Rate limit must NOT increment failure strikes');
      assert.strictEqual(rlAcc.enabled, true, 'Account must remain enabled (cooled down, not disabled)');

      // Post published via other account
      assert.strictEqual(item.state, 'published');
      assert.strictEqual(item.url, 'https://x.com/other_user/status/12345');
      assert.strictEqual(otherAcc.failures, 0);

      // Verify cooling entry was stored for acc-rl
      assert.ok(finalState.posting?.cooling?.['acc-rl']?.until > Date.now() - 1000);
    });
  });
});
