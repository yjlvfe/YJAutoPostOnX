'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHermeticWorkspace } = require('../fixtures/hermetic_workspace');
const { createFakeDockerVpn, AUTHORIZED_CONTAINERS } = require('../fixtures/fake_docker_vpn');
const { FakeTelegramApi } = require('../fixtures/fake_telegram_server');
const { SqliteStore } = require('../../src/sqliteStore');
const {
  SessionGuardRegistry,
  acquireSession,
  resetSessionsForTest,
  MAX_PROJECT_SESSIONS
} = require('../../src/sessionGuard');
const { DirectXAdapter } = require('../../src/directX');
const { createBot } = require('../../src/index');
const { TelegramUi } = require('../../src/telegramUi');

describe('05_sessions_and_vpn_limits: 5-Session Ceiling, SESSION-RAW-02/03, 7-Container NordVPN Cap, VPN-RAW-01..04 & FINDING-015/031', () => {
  it('V-01: Enforces 5-session host-wide SQLite lease ceiling, rejects 6th session and duplicate session_key, and reclaims dead/PID-reused leases (SESSION-RAW-03)', async () => {
    const ws = createHermeticWorkspace('yj-bot-test-v01-');
    try {
      const reg = new SessionGuardRegistry(ws.leaseDbPath);
      try {
        const leases = [];
        for (let i = 1; i <= MAX_PROJECT_SESSIONS; i++) {
          leases.push(reg.acquire({ accountId: `acc-${i}`, sessionKey: `key-${i}` }));
        }
        assert.strictEqual(leases.length, 5);

        // Duplicate session_key rejected
        assert.throws(
          () => reg.acquire({ accountId: 'acc-1', sessionKey: 'key-1' }),
          err => err.code === 'DUPLICATE_SESSION_LEASE'
        );

        // 6th concurrent session rejected with MAX_PROJECT_SESSIONS_EXCEEDED
        assert.throws(
          () => reg.acquire({ accountId: 'acc-6', sessionKey: 'key-6' }),
          err => err.code === 'MAX_PROJECT_SESSIONS_EXCEEDED'
        );

        // Release 1 lease -> 6th succeeds
        assert.strictEqual(reg.release(leases[0].leaseId), true);
        // Idempotent second release
        assert.strictEqual(reg.release(leases[0].leaseId), false);

        const sixth = reg.acquire({ accountId: 'acc-6', sessionKey: 'key-6' });
        assert.ok(sixth.leaseId);
        reg.release(sixth.leaseId);

        // SESSION-RAW-03: Inject a lease row with alive process.pid but mismatched starttime (simulating PID reuse)
        reg.release(leases[1].leaseId);
        const cols = reg.db.prepare("PRAGMA table_info(session_leases)").all().map(c => c.name);
        if (cols.includes('node_starttime') || cols.includes('owner_starttime')) {
          const colName = cols.includes('node_starttime') ? 'node_starttime' : 'owner_starttime';
          reg.db.prepare(`UPDATE session_leases SET ${colName} = '1' WHERE lease_id = ?`).run(leases[2].leaseId);
          const reconciled = reg.reconcileOrphans();
          assert.ok(reconciled.purged >= 1, 'Lease with mismatched /proc/<pid>/stat starttime must be reclaimed');
        }

        for (const l of leases) reg.release(l.leaseId);
      } finally {
        reg.close();
      }
    } finally {
      await ws.cleanup();
    }
  });

  it('V-02: resetSessionsForTest guards against production/non-temp/symlink paths, and bindChild failure kills child & releases lease (SESSION-RAW-02)', async () => {
    const ws = createHermeticWorkspace('yj-bot-test-v02-');
    try {
      // Missing custom path
      assert.throws(
        () => resetSessionsForTest(''),
        err => /CUSTOM_PATH_REQUIRED/.test(err.code || err.message)
      );

      // Production path forbidden
      assert.throws(
        () => resetSessionsForTest(path.resolve(__dirname, '../../data/session_leases.sqlite')),
        err => /PROD_PATH_RESET_FORBIDDEN/.test(err.code || err.message)
      );
      assert.throws(
        () => resetSessionsForTest('/root/Projects/YJAutoPostOnX/Bot/data/session_leases.sqlite'),
        err => /PROD_PATH_RESET_FORBIDDEN|TEMP_DIR_REQUIRED/.test(err.code || err.message)
      );

      // Non-temp path forbidden
      assert.throws(
        () => resetSessionsForTest('/var/log/fake_leases.sqlite'),
        err => /TEMP_DIR_REQUIRED/.test(err.code || err.message)
      );

      // Symlink inside tempDir forbidden
      const targetDb = path.join(ws.tempDir, 'real_leases.sqlite');
      fs.writeFileSync(targetDb, '', { mode: 0o600 });
      const symlinkDb = path.join(ws.tempDir, 'symlink_leases.sqlite');
      fs.symlinkSync(targetDb, symlinkDb);
      assert.throws(
        () => resetSessionsForTest(symlinkDb),
        err => /SYMLINK_RESET_FORBIDDEN/.test(err.code || err.message)
      );

      // Valid temp path succeeds
      assert.doesNotThrow(() => resetSessionsForTest(ws.leaseDbPath));

      // SESSION-RAW-02: If bindChild throws during DirectXAdapter.open, spawned child is killed and lease is released
      const cookieFile = ws.writeSyntheticCookie('acc-bind-fail', { userId: '1001' });
      const reg = new SessionGuardRegistry(ws.leaseDbPath);
      reg.close();

      // Trigger 0 changes on UPDATE child_pid so bindChildProcess immediately throws LEASE_NOT_FOUND
      // without triggering 100 SQLite busy retries, testing SESSION-RAW-02 child kill + lease release
      const triggerDb = new (require('node:sqlite').DatabaseSync)(ws.leaseDbPath);
      triggerDb.exec(`
        CREATE TRIGGER ignore_child_pid_update
        BEFORE UPDATE OF child_pid ON session_leases
        BEGIN
          SELECT RAISE(IGNORE);
        END;
      `);
      triggerDb.close();

      const adapter = new DirectXAdapter({
        pythonExecutable: process.env.DIRECT_X_PYTHON || 'python3',
        openTimeoutMs: 5000
      });

      await assert.rejects(
        () => adapter.open({
          account: { id: 'acc-bind-fail', username: 'user1', userId: '1001', cookieFile },
          proxy: 'socks5h://127.0.0.1:18801'
        }),
        err => /LEASE_NOT_FOUND/.test(err.code || err.message)
      );

      const postBindReg = new SessionGuardRegistry(ws.leaseDbPath);
      try {
        assert.strictEqual(postBindReg.countActive(), 0, 'SESSION-RAW-02: Lease must be released and child killed when bindChild fails');
      } finally {
        postBindReg.close();
      }
    } finally {
      await ws.cleanup();
    }
  });

  it('V-03: Enforces 7-container NordVPN cap, persistent volume check (VPN-RAW-01), and exact 6.0.2 image tag check (FINDING-031)', async () => {
    const ws = createHermeticWorkspace('yj-bot-test-v03-');
    try {
      const store = ws.registerStore(new SqliteStore(ws.dbPath));

      // 1. FINDING-031: Container with :latest tag must be rejected as incompatible
      const vpnLatest = createFakeDockerVpn({
        store,
        slotStates: { 0: { exists: true, running: true, healthy: true, image: 'yj_autopost_vpn_image:latest' } }
      });
      const statusLatest = await vpnLatest.runtime.containerStatus(0);
      assert.strictEqual(statusLatest.compatible, false, 'FINDING-031: :latest image tag must be rejected; only 6.0.2 is compatible');

      const vpnPinned = createFakeDockerVpn({
        store,
        slotStates: { 0: { exists: true, running: true, healthy: true, image: 'yj_autopost_vpn_image:6.0.2' } }
      });
      const statusPinned = await vpnPinned.runtime.containerStatus(0);
      assert.strictEqual(statusPinned.compatible, true);

      // 2. VPN-RAW-01: Missing slot container fails closed without running docker run when 7 containers already exist or volumes missing
      const vpnMissingSlot = createFakeDockerVpn({
        store,
        slotStates: { 0: { exists: false } },
        hostContainers: AUTHORIZED_CONTAINERS, // 7 containers already present
        existingVolumes: [] // Missing persistent volumes
      });

      await assert.rejects(
        () => vpnMissingSlot.runtime.ensureContainer(0, { tokenFile: ws.tokenFile, readyTimeoutMs: 100 }),
        err => /NORDVPN|container|volume|cap|missing|disabled/i.test(err.message)
      );
      assert.strictEqual(vpnMissingSlot.dockerRuns.length, 0, 'VPN-RAW-01: Must NEVER execute docker run when 7-container cap or volume check fails');
    } finally {
      await ws.cleanup();
    }
  });

  it('V-04: Disabling account unbinds VPN slot without docker rm -f (VPN-RAW-02 & TR-05), and enabling/strikes never auto-rotate VPN (VPN-RAW-04)', async () => {
    const ws = createHermeticWorkspace('yj-bot-test-v04-');
    try {
      const api = new FakeTelegramApi();
      const bot = createBot({
        dataDir: ws.tempDir,
        auth: { allowedUserIds: ['528864559'], allowedChatIds: ['528864559'] },
        telegram: {
          send: p => api.sendMessage(p),
          sendRichMessage: p => api.sendRichMessage(p),
          editMessageText: p => api.editMessageText(p),
          deleteMessage: p => api.deleteMessage(p),
          answerCallback: p => api.answerCallbackQuery(p)
        }
      });
      ws.registerStore(bot.store);

      const vpn = createFakeDockerVpn({ store: bot.store });
      let rotateCalls = 0;
      const origRotate = vpn.manager.rotate.bind(vpn.manager);
      vpn.manager.rotate = async (...args) => {
        rotateCalls += 1;
        return origRotate(...args);
      };
      bot.vpnManager = vpn.manager;

      const c1 = ws.writeSyntheticCookie('acc-1', { userId: '1001' });
      await bot.store.update(s => {
        s.accounts = [{ id: 'acc-1', username: 'user1', userId: '1001', cookieFile: c1, enabled: true, status: 'مفعل' }];
        s.vpnSlots = { 'acc-1': 0 };
        return s;
      });

      const ui = new TelegramUi({
        bot,
        launch: async () => {},
        clock: () => new Date('2026-11-04T12:00:00Z'),
        notify: async () => []
      });

      const rawCb = {
        callback_query: {
          id: 'cb-v04',
          from: { id: 528864559 },
          message: { message_id: 20, chat: { id: 528864559 } }
        }
      };

      // Disable account via accountToggle -> must release slot in SQLite WITHOUT calling docker rm -f!
      await ui.accountToggle({ parsed: { action: 'toggle', value: 'acc-1' } }, rawCb);
      const stAfterDisable = await bot.store.load();
      assert.strictEqual(stAfterDisable.vpnSlots?.['acc-1'], undefined, 'TR-05: Slot mapping must be unassigned on disable');
      assert.strictEqual(vpn.dockerRms.length, 0, 'VPN-RAW-02: Disabling an account must NEVER run docker rm -f on persistent slot containers');

      // Re-enable account -> VPN-RAW-04: must NOT auto-rotate VPN IP!
      await ui.accountToggle({ parsed: { action: 'toggle', value: 'acc-1' } }, rawCb);
      assert.strictEqual(rotateCalls, 0, 'VPN-RAW-04: Enabling an account must NOT trigger automatic VPN IP rotation');
    } finally {
      await ws.cleanup();
    }
  });

  it('V-05: rotateContainerIp aborts on attempt 1 on provider rate limit (VPN-RAW-03), getServerIp makes zero direct curl calls (FINDING-015), and healthCheck blocks exitIp === serverIp', async () => {
    const ws = createHermeticWorkspace('yj-bot-test-v05-');
    try {
      const store = ws.registerStore(new SqliteStore(ws.dbPath));

      // 1. VPN-RAW-03: Provider rate limit "Too many connection attempts" aborts on attempt 1
      let connectAttempts = 0;
      const vpnRateLimited = createFakeDockerVpn({
        store,
        execError: async (args) => {
          if (args.includes('connect')) {
            connectAttempts += 1;
            const err = new Error('Command failed: docker exec');
            err.stderr = 'Too many connection attempts. Please wait a few minutes.';
            throw err;
          }
          return null;
        }
      });

      const rotRes = await vpnRateLimited.runtime.rotateContainerIp(0, { maxAttempts: 4 });
      assert.strictEqual(rotRes.success, false);
      assert.strictEqual(connectAttempts, 1, 'VPN-RAW-03: rotateContainerIp must abort on attempt 1 when NordVPN reports Too many connection attempts');

      // 2. FINDING-015: getServerIp makes zero direct curl calls when SERVER_IP is absent and os.networkInterfaces has no public IP
      const savedServerIp = process.env.SERVER_IP;
      const savedHostIp = process.env.HOST_DIRECT_IP;
      delete process.env.SERVER_IP;
      delete process.env.HOST_DIRECT_IP;
      const origIfaces = os.networkInterfaces;
      os.networkInterfaces = () => ({
        lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
        eth0: [{ family: 'IPv4', internal: false, address: '10.0.0.5' }]
      });
      try {
        const vpnNoServerIp = createFakeDockerVpn({ store, serverIp: null });
        vpnNoServerIp.runtime.clearCachedServerIp();
        const resolvedIp = await vpnNoServerIp.runtime.getServerIp();
        assert.strictEqual(resolvedIp, null, 'FINDING-015: getServerIp must fail closed (null) when no configured or interface public IP exists');
        const directCurls = vpnNoServerIp.curlCalls.filter(args => !args.includes('--socks5-hostname'));
        assert.strictEqual(directCurls.length, 0, 'FINDING-015: getServerIp must NEVER invoke direct unproxied curl');
      } finally {
        os.networkInterfaces = origIfaces;
        if (savedServerIp !== undefined) process.env.SERVER_IP = savedServerIp;
        if (savedHostIp !== undefined) process.env.HOST_DIRECT_IP = savedHostIp;
      }

      // 3. IP leak gate: exitIp === serverIp fails healthCheck with ip_leak_detected
      const vpnLeak = createFakeDockerVpn({
        store,
        serverIp: '8.8.8.8',
        slotIps: ['8.8.8.8']
      });
      const leakCheck = await vpnLeak.runtime.healthCheck(0);
      assert.strictEqual(leakCheck.healthy, false);
      assert.strictEqual(leakCheck.reason, 'ip_leak_detected');
    } finally {
      await ws.cleanup();
    }
  });
});
