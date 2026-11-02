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

function createMockTelegramApi(notifications = []) {
  return {
    getMe: async () => ({ id: 1 }),
    sendMessage: async (arg1, arg2) => {
      const text = typeof arg1 === 'object' && arg1 ? arg1.text : arg2;
      if (text) notifications.push(text);
      return { message_id: Math.floor(Math.random() * 10000) + 1 };
    },
    sendRichMessage: async (arg1, arg2) => {
      const text = typeof arg1 === 'object' && arg1 ? arg1.text : arg2;
      if (text) notifications.push(text);
      return { message_id: Math.floor(Math.random() * 10000) + 1 };
    },
    editMessageText: async () => ({ message_id: 1 }),
    deleteMessage: async () => {},
    getUpdates: async () => [],
    sendDocument: async () => ({})
  };
}

describe('Challenger M1 Adversarial Suite: Accounts Capacity, Natural Cycles & Strike Tracking', () => {

  // =========================================================================
  // CHALLENGE 1: Mass Account Scaling & 5-Active Ceiling Stress (1,250 Accounts)
  // =========================================================================
  describe('Challenge 1: Mass Account Scaling & 5-Active Ceiling (1,250 Accounts)', () => {

    test('1.1 Store and load 1,250 accounts in SQLite without error or memory exhaustion', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-m1-scale-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const store = new SqliteStore(dbPath, { accounts: [] });
      await store.load();

      const manager = new AccountManager(store);

      // Generate 1,250 accounts; mark the first 50 as enabled
      const records = [];
      for (let i = 1; i <= 1250; i++) {
        records.push({
          id: `acc-scale-${i}`,
          username: `u_scale_${i}`,
          label: `Account ${i}`,
          failures: i % 4, // 0, 1, 2, 3
          enabled: i <= 50
        });
      }

      const t0 = Date.now();
      const replaced = await manager.replace(records);
      const elapsed = Date.now() - t0;

      assert.strictEqual(replaced.length, 1250, 'All 1,250 accounts must be retained in state');
      assert.ok(elapsed < 5000, `Mass replace of 1,250 accounts took ${elapsed}ms (< 5000ms target)`);

      // Verify the 5-active ceiling was strictly enforced by replace()
      const active = replaced.filter(a => a.enabled !== false && !['محظور', 'كابتشا', 'معزول (3 إخفاقات)'].includes(a.status));
      assert.strictEqual(active.length, 5, 'Exactly 5 active accounts permitted; remaining 45 must be disabled');

      const disabled = replaced.filter(a => a.enabled === false);
      assert.strictEqual(disabled.length, 1245, 'All other 1,245 accounts must have enabled === false');

      // Verify durability by opening fresh SqliteStore
      const freshStore = new SqliteStore(dbPath);
      const reloadedState = await freshStore.load();
      assert.strictEqual(reloadedState.accounts.length, 1250);
      const reloadedActive = reloadedState.accounts.filter(a => a.enabled !== false && !['محظور', 'كابتشا', 'معزول (3 إخفاقات)'].includes(a.status));
      assert.strictEqual(reloadedActive.length, 5);
    });

    test('1.2 add() 1,251st account into 1,250 account store auto-disables when 5 active exist', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-m1-add-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const store = new SqliteStore(dbPath, { accounts: [] });
      await store.load();

      const manager = new AccountManager(store);

      // Seed 1,250 accounts with 5 active
      const seed = Array.from({ length: 1250 }, (_, i) => ({
        id: `acc-${i + 1}`,
        username: `user_${i + 1}`,
        enabled: i < 5
      }));
      await manager.replace(seed);

      // Add 1,251st account requesting enabled: true
      const added = await manager.add({
        id: 'acc-1251',
        username: 'user_1251',
        enabled: true
      });

      assert.strictEqual(added.id, 'acc-1251');
      assert.strictEqual(added.enabled, false, '1251st account must be coerced to enabled: false');
      assert.strictEqual(added.status, 'غير مفعل');

      const all = await manager.list();
      assert.strictEqual(all.length, 1251);
      const active = all.filter(a => a.enabled !== false && !['محظور', 'كابتشا', 'معزول (3 إخفاقات)'].includes(a.status));
      assert.strictEqual(active.length, 5);
    });

    test('1.3 update() strictly rejects enabling 6th account and enforces vacancy rule', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-m1-update-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const store = new SqliteStore(dbPath, { accounts: [] });
      await store.load();

      const manager = new AccountManager(store);

      for (let i = 1; i <= 5; i++) {
        await manager.add({ id: `active-${i}`, username: `act_${i}`, enabled: true });
      }
      await manager.add({ id: 'inactive-target', username: 'inact_target', enabled: false });

      // Attempt to enable 6th active account
      await assert.rejects(
        async () => manager.update('inactive-target', { enabled: true }),
        /At most 5 active accounts are supported/
      );

      // Verify inactive-target is STILL disabled
      const stateBefore = await manager.list();
      const targetBefore = stateBefore.find(a => a.id === 'inactive-target');
      assert.strictEqual(targetBefore.enabled, false);

      // Free a slot by disabling active-1
      await manager.update('active-1', { enabled: false });
      const activeAfterDisable = (await manager.list()).filter(a => a.enabled !== false && !['محظور', 'كابتشا', 'معزول (3 إخفاقات)'].includes(a.status));
      assert.strictEqual(activeAfterDisable.length, 4);

      // Now enabling inactive-target must succeed
      const updated = await manager.update('inactive-target', { enabled: true });
      assert.strictEqual(updated.enabled, true);
      assert.strictEqual(updated.status, 'مفعل');

      const activeFinal = (await manager.list()).filter(a => a.enabled !== false && !['محظور', 'كابتشا', 'معزول (3 إخفاقات)'].includes(a.status));
      assert.strictEqual(activeFinal.length, 5);
    });

    test('1.4 Bulk CSV import with 1,200 accounts via replaceFromCsv enforces 5-active ceiling', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-m1-csv-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const store = new SqliteStore(dbPath, { accounts: [] });
      await store.load();

      const manager = new AccountManager(store);

      // Build CSV with 1,200 accounts, first 20 marked enabled=true
      const lines = ['account,label,enabled'];
      for (let i = 1; i <= 1200; i++) {
        lines.push(`csvacc${i},Label ${i},${i <= 20 ? 'true' : 'false'}`);
      }
      const csvData = lines.join('\n');

      const replaced = await manager.replaceFromCsv(csvData);
      assert.strictEqual(replaced.length, 1200);

      const active = replaced.filter(a => a.enabled !== false && !['محظور', 'كابتشا', 'معزول (3 إخفاقات)'].includes(a.status));
      assert.strictEqual(active.length, 5, 'CSV replace must cap active accounts to exactly 5');
    });
  });

  // =========================================================================
  // CHALLENGE 2: Natural 3-Strikes Cycle Progression (No Rapid Inner Retries)
  // =========================================================================
  describe('Challenge 2: Natural 3-Strikes Cycle Progression & Post Transfer', () => {

    test('2.1 Multi-cycle sequential progression: 3 natural cycles, round-robin transfer, strike 3 isolation', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-m1-natural-cycle-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const c1 = path.join(tempDir, 'c1.json');
      const c2 = path.join(tempDir, 'c2.json');
      const c3 = path.join(tempDir, 'c3.json');
      fs.writeFileSync(c1, '{}');
      fs.writeFileSync(c2, '{}');
      fs.writeFileSync(c3, '{}');

      const notifications = [];
      const mockApi = createMockTelegramApi(notifications);

      // We set up accounts:
      // acc-flake: will fail on each attempt with recoverable error
      // acc-hero: healthy account that succeeds
      const store = new SqliteStore(dbPath, {
        items: [
          { id: 'post-cycle-1', state: 'pending', payload: { text: 'Post 1' } }
        ],
        accounts: [
          { id: 'acc-flake', username: 'flaky_user', userId: '801', enabled: true, cookieFile: c1, failures: 0 },
          { id: 'acc-hero', username: 'hero_user', userId: '802', enabled: true, cookieFile: c2, failures: 0 }
        ],
        cycle: { state: 'stopped', runId: null },
        settings: { dailyQuota: 10, delayMinSeconds: 1, delayMaxSeconds: 1 },
        posting: {}
      });
      await store.load();

      const accountAttempts = { 'acc-flake': 0, 'acc-hero': 0 };

      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async ({ account }) => {
          accountAttempts[account.id] = (accountAttempts[account.id] || 0) + 1;
          if (account.id === 'acc-flake') {
            // Fails with recoverable error
            return {
              slot: 1,
              identity: {
                authenticated: false,
                accountFailure: 'cookie_expired',
                reason: 'session token expired'
              }
            };
          } else {
            return {
              slot: 2,
              identity: {
                authenticated: true,
                username: account.username,
                userId: account.userId
              }
            };
          }
        },
        publish: async ({ session, onDispatch }) => {
          await onDispatch({ accountId: 'acc-hero' });
          const url = `https://x.com/${session.identity.username}/status/${Date.now()}`;
          return { published: true, url };
        },
        close: async () => {}
      });

      // --- RUN CYCLE 1 (Processes post-cycle-1) ---
      // acc-flake attempts once, fails (failures -> 1), cooled for this pass,
      // post transfers to acc-hero and publishes.
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

      let state1 = await store.load();
      let flakeAcc = state1.accounts.find(a => a.id === 'acc-flake');
      assert.strictEqual(accountAttempts['acc-flake'], 1, 'In Cycle 1, acc-flake must be attempted exactly ONCE (no rapid retry loop)');
      assert.strictEqual(flakeAcc.failures, 1, 'Strike 1 recorded in SQLite');
      assert.strictEqual(flakeAcc.enabled, true, 'acc-flake is still enabled at Strike 1');
      assert.strictEqual(state1.items.find(i => i.id === 'post-cycle-1').state, 'published');
      assert.strictEqual(state1.items.find(i => i.id === 'post-cycle-1').accountId, 'acc-hero');

      // Simulate bot reboot between cycles to verify failure persistence across restarts
      let rebootedStore = new SqliteStore(dbPath);
      let rebootedState = await rebootedStore.load();
      assert.strictEqual(rebootedState.accounts.find(a => a.id === 'acc-flake').failures, 1, 'Failures counter survived daemon restart');

      // Enqueue post 2 and clear cooling to simulate natural cooldown elapsed
      await store.update(s => {
        s.items.push({ id: 'post-cycle-2', state: 'pending', payload: { text: 'Post 2' } });
        if (s.posting?.cooling) delete s.posting.cooling['acc-flake'];
        return s;
      });

      // --- RUN CYCLE 2 (Processes post-cycle-2) ---
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

      let state2 = await store.load();
      flakeAcc = state2.accounts.find(a => a.id === 'acc-flake');
      assert.strictEqual(accountAttempts['acc-flake'], 2, 'In Cycle 2, acc-flake attempted exactly ONCE more (total 2 attempts)');
      assert.strictEqual(flakeAcc.failures, 2, 'Strike 2 recorded in SQLite');
      assert.strictEqual(flakeAcc.enabled, true, 'acc-flake is still enabled at Strike 2');
      assert.strictEqual(state2.items.find(i => i.id === 'post-cycle-2').state, 'published');
      assert.strictEqual(state2.items.find(i => i.id === 'post-cycle-2').accountId, 'acc-hero');

      // Enqueue post 3 and clear cooling
      await store.update(s => {
        s.items.push({ id: 'post-cycle-3', state: 'pending', payload: { text: 'Post 3' } });
        if (s.posting?.cooling) delete s.posting.cooling['acc-flake'];
        return s;
      });

      // --- RUN CYCLE 3 (Processes post-cycle-3) ---
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

      let state3 = await store.load();
      flakeAcc = state3.accounts.find(a => a.id === 'acc-flake');
      assert.strictEqual(accountAttempts['acc-flake'], 3, 'In Cycle 3, acc-flake reached its 3rd attempt');
      assert.strictEqual(flakeAcc.failures, 3, 'Strike 3 recorded in SQLite');
      assert.strictEqual(flakeAcc.enabled, false, 'acc-flake MUST be isolated (enabled: false) at Strike 3');
      assert.strictEqual(flakeAcc.status, 'معزول (3 إخفاقات)');
      assert.strictEqual(state3.items.find(i => i.id === 'post-cycle-3').state, 'published');
      assert.strictEqual(state3.items.find(i => i.id === 'post-cycle-3').accountId, 'acc-hero');

      // Exactly ONE isolation alert must have been dispatched
      const isolationAlerts = notifications.filter(n => n.includes('تم عزل الحساب @flaky_user') && n.includes('معزول (3 إخفاقات)'));
      assert.strictEqual(isolationAlerts.length, 1, 'Exactly ONE isolation alert dispatched to Telegram');

      // Enqueue post 4
      await store.update(s => {
        s.items.push({ id: 'post-cycle-4', state: 'pending', payload: { text: 'Post 4' } });
        return s;
      });

      // --- RUN CYCLE 4 (Processes post-cycle-4) ---
      // acc-flake is now isolated; runner must NEVER select it!
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

      assert.strictEqual(accountAttempts['acc-flake'], 3, 'acc-flake was NEVER touched in Cycle 4 after isolation');
      let state4 = await store.load();
      assert.strictEqual(state4.items.find(i => i.id === 'post-cycle-4').state, 'published');
      assert.strictEqual(state4.items.find(i => i.id === 'post-cycle-4').accountId, 'acc-hero');
    });

    test('2.2 Pre-dispatch unpins payload.account when account fails, allowing dynamic transfer', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-m1-unpin-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const c1 = path.join(tempDir, 'c1.json');
      const c2 = path.join(tempDir, 'c2.json');
      fs.writeFileSync(c1, '{}');
      fs.writeFileSync(c2, '{}');

      const mockApi = createMockTelegramApi();

      // Item pinned specifically to acc-pinned
      const store = new SqliteStore(dbPath, {
        items: [
          { id: 'post-pinned', state: 'pending', payload: { text: 'Pinned test', account: 'acc-pinned' } }
        ],
        accounts: [
          { id: 'acc-pinned', username: 'pinned_user', userId: '851', enabled: true, cookieFile: c1, failures: 0 },
          { id: 'acc-backup', username: 'backup_user', userId: '852', enabled: true, cookieFile: c2, failures: 0 }
        ],
        cycle: { state: 'stopped', runId: null },
        settings: { dailyQuota: 10, delayMinSeconds: 1, delayMaxSeconds: 1 },
        posting: {}
      });
      await store.load();

      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async ({ account }) => {
          if (account.id === 'acc-pinned') {
            return {
              slot: 1,
              identity: {
                authenticated: false,
                accountFailure: 'auth_rejected',
                reason: 'bad credentials'
              }
            };
          } else {
            return {
              slot: 2,
              identity: {
                authenticated: true,
                username: account.username,
                userId: account.userId
              }
            };
          }
        },
        publish: async ({ session, onDispatch }) => {
          await onDispatch({ accountId: 'acc-backup' });
          return { published: true, url: 'https://x.com/backup_user/status/7890' };
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
      const item = finalState.items.find(i => i.id === 'post-pinned');
      assert.strictEqual(item.state, 'published');
      assert.strictEqual(item.accountId, 'acc-backup');
      assert.strictEqual(item.payload.account, undefined, 'payload.account must be unpinned on failure');

      const pinnedAcc = finalState.accounts.find(a => a.id === 'acc-pinned');
      assert.strictEqual(pinnedAcc.failures, 1);
    });
  });

  // =========================================================================
  // CHALLENGE 3: Strike Resets on Verified Publish Across Reboots
  // =========================================================================
  describe('Challenge 3: Strike Reset on Verified Publish', () => {

    test('3.1 Account with 2 strikes resets to 0 on verified publish and persists across reboot', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-m1-reset-strike-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const c1 = path.join(tempDir, 'c1.json');
      fs.writeFileSync(c1, '{}');

      const mockApi = createMockTelegramApi();

      const store = new SqliteStore(dbPath, {
        items: [
          { id: 'post-reset-1', state: 'pending', payload: { text: 'Reset test' } }
        ],
        accounts: [
          { id: 'acc-reset', username: 'reset_user', userId: '901', enabled: true, cookieFile: c1, failures: 2 }
        ],
        cycle: { state: 'stopped', runId: null },
        settings: { dailyQuota: 10, delayMinSeconds: 1, delayMaxSeconds: 1 },
        posting: {}
      });
      await store.load();

      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async ({ account }) => ({
          slot: 1,
          identity: {
            authenticated: true,
            username: account.username,
            userId: account.userId
          }
        }),
        publish: async ({ onDispatch }) => {
          await onDispatch({ accountId: 'acc-reset' });
          return { published: true, url: 'https://x.com/reset_user/status/555444' };
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

      const state = await store.load();
      const item = state.items.find(i => i.id === 'post-reset-1');
      assert.strictEqual(item.state, 'published');
      assert.strictEqual(item.url, 'https://x.com/reset_user/status/555444');

      const acc = state.accounts.find(a => a.id === 'acc-reset');
      assert.strictEqual(acc.failures, 0, 'Failures must be immediately reset to 0 upon verified publish');

      // Verify quota increment
      const quotaKeys = Object.keys(state.posting?.quota || {});
      assert.ok(quotaKeys.length > 0, 'Quota entry must exist for today');
      const todayQuota = state.posting.quota[quotaKeys[0]];
      assert.strictEqual(todayQuota['acc-reset'], 1, 'Quota must be incremented by exactly 1');

      // Verify reboot durability
      const freshStore = new SqliteStore(dbPath);
      const reloadedState = await freshStore.load();
      const reloadedAcc = reloadedState.accounts.find(a => a.id === 'acc-reset');
      assert.strictEqual(reloadedAcc.failures, 0, 'Failures count of 0 must survive daemon restart');
    });
  });

  // =========================================================================
  // CHALLENGE 4: Post-Dispatch Ambiguous Quarantine (Zero Duplicate Post Risk)
  // =========================================================================
  describe('Challenge 4: Pre-Dispatch Transfer vs Post-Dispatch Ambiguity', () => {

    test('4.1 Post-dispatch network drop quenches as ambiguous without transfer or quota deduction', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-m1-ambiguous-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const c1 = path.join(tempDir, 'c1.json');
      const c2 = path.join(tempDir, 'c2.json');
      fs.writeFileSync(c1, '{}');
      fs.writeFileSync(c2, '{}');

      const notifications = [];
      const mockApi = createMockTelegramApi(notifications);

      const store = new SqliteStore(dbPath, {
        items: [
          { id: 'post-ambig-1', state: 'pending', payload: { text: 'Ambiguous test' } },
          { id: 'post-next-2', state: 'pending', payload: { text: 'Next post' } }
        ],
        accounts: [
          { id: 'acc-ambig', username: 'ambig_user', userId: '701', enabled: true, cookieFile: c1, failures: 0 },
          { id: 'acc-clean', username: 'clean_user', userId: '702', enabled: true, cookieFile: c2, failures: 0 }
        ],
        cycle: { state: 'stopped', runId: null },
        settings: { dailyQuota: 10, delayMinSeconds: 1, delayMaxSeconds: 1 },
        posting: {}
      });
      await store.load();

      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async ({ account }) => ({
          slot: account.id === 'acc-ambig' ? 1 : 2,
          identity: {
            authenticated: true,
            username: account.username,
            userId: account.userId
          }
        }),
        publish: async ({ session, onDispatch }) => {
          if (session.identity.username === 'ambig_user') {
            // Crossed irreversible dispatch boundary
            await onDispatch({ accountId: 'acc-ambig' });
            // Network dropped immediately after socket write
            const err = new Error('ECONNRESET: Socket connection reset by peer');
            err.code = 'ECONNRESET';
            throw err;
          } else {
            await onDispatch({ accountId: 'acc-clean' });
            return { published: true, url: 'https://x.com/clean_user/status/1000' };
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

      const state = await store.load();
      const ambigItem = state.items.find(i => i.id === 'post-ambig-1');
      assert.strictEqual(ambigItem.state, 'ambiguous', 'Post must be isolated as ambiguous when error occurs after dispatch fence');

      // Ambiguous item MUST NOT have quota deducted
      const quotaMap = state.posting?.quota || {};
      for (const day of Object.keys(quotaMap)) {
        assert.strictEqual(quotaMap[day]?.['acc-ambig'] || 0, 0, 'No quota may be deducted for ambiguous post');
      }

      // Next item was published cleanly by clean_user
      const cleanItem = state.items.find(i => i.id === 'post-next-2');
      assert.strictEqual(cleanItem.state, 'published');
      assert.strictEqual(cleanItem.url, 'https://x.com/clean_user/status/1000');
    });
  });

  // =========================================================================
  // CHALLENGE 5: Exhaustion & Cooldown Halting Safety
  // =========================================================================
  describe('Challenge 5: All-Account Failure / Cooldown Halting Safety', () => {

    test('5.1 Halts cleanly with Arabic alert when all active accounts fail', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-m1-halt-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const c1 = path.join(tempDir, 'c1.json');
      fs.writeFileSync(c1, '{}');

      const notifications = [];
      const mockApi = createMockTelegramApi(notifications);

      const store = new SqliteStore(dbPath, {
        items: [
          { id: 'post-unposted-1', state: 'pending', payload: { text: 'Will remain pending' } }
        ],
        accounts: [
          { id: 'acc-failing', username: 'lone_failing', userId: '601', enabled: true, cookieFile: c1, failures: 0 }
        ],
        cycle: { state: 'stopped', runId: null },
        settings: { dailyQuota: 10, delayMinSeconds: 1, delayMaxSeconds: 1 },
        posting: {}
      });
      await store.load();

      const publishAdapterFactory = () => ({
        supportsDispatchCallback: true,
        open: async () => ({
          slot: 1,
          identity: {
            authenticated: false,
            accountFailure: 'network_proxy_error',
            reason: 'proxy tunnel connect failed'
          }
        }),
        publish: async () => {
          throw new Error('Should not reach publish');
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
          await ctx.start({ stopAfterSuccess: false });
          await ctx.wait();
        }
      });

      const state = await store.load();
      // Cycle halted
      assert.strictEqual(state.cycle?.state, 'stopped');

      // Item remains pending and untouched
      const item = state.items.find(i => i.id === 'post-unposted-1');
      assert.strictEqual(item.state, 'pending');

      // Notification sent
      const exhaustedAlerts = notifications.filter(n => n.includes('جميع الحسابات غير مؤهلة أو في فترة انتظار'));
      assert.strictEqual(exhaustedAlerts.length, 1, 'Must notify that all accounts are ineligible or cooling');
    });
  });
});
