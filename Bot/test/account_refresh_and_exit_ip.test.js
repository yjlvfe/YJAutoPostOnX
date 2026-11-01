'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createAccountRefresh, confirmed } = require('../src/accountRefresh');
const { formatAccountTable } = require('../src/accountTable');
const { createDockerRuntime, EXIT_IP_SERVICES } = require('../src/dockerVpn');

describe('Accounts Refresh & Exit IP Display Tests', () => {
  describe('accountRefresh: confirmed() logic', () => {
    test('returns true for authenticated account with valid isolated VPN and public IP', () => {
      const result = {
        isolated: true,
        vpnHealthy: true,
        exitIp: '187.40.234.102',
        authenticated: true,
        username: 'valid_user'
      };
      assert.strictEqual(confirmed(result), true);
    });

    test('returns true for unauthenticated account with valid VPN and public IP (no infinite retry)', () => {
      // Prior defect: authenticated: false with accountFailure: undefined threw and looped forever
      const result = {
        isolated: true,
        vpnHealthy: true,
        exitIp: '187.40.234.102',
        authenticated: false,
        accountFailure: undefined,
        state: 'identity_unverified'
      };
      assert.strictEqual(confirmed(result), true);
    });

    test('returns true for account with explicit failure diagnostics (banned, captcha, auth)', () => {
      for (const failure of ['banned', 'captcha', 'auth', 'custom_error']) {
        const result = {
          isolated: true,
          vpnHealthy: true,
          exitIp: '187.40.234.102',
          authenticated: false,
          accountFailure: failure
        };
        assert.strictEqual(confirmed(result), true, `Failed for ${failure}`);
      }
    });

    test('returns true for observation with readDiagnostic (e.g. 429)', () => {
      const result = {
        isolated: true,
        vpnHealthy: true,
        exitIp: '187.40.234.102',
        authenticated: false,
        readDiagnostic: { httpStatus: 429, retryAfterSeconds: 60 }
      };
      assert.strictEqual(confirmed(result), true);
    });

    test('returns false if VPN is not isolated, unhealthy, or IP is not public', () => {
      assert.strictEqual(confirmed(null), false);
      assert.strictEqual(confirmed({ isolated: false, vpnHealthy: true, exitIp: '187.40.234.102' }), false);
      assert.strictEqual(confirmed({ isolated: true, vpnHealthy: false, exitIp: '187.40.234.102' }), false);
      assert.strictEqual(confirmed({ isolated: true, vpnHealthy: true, exitIp: '10.0.0.1' }), false); // private IP
      assert.strictEqual(confirmed({ isolated: true, vpnHealthy: true, exitIp: null }), false);
    });
  });

  describe('accountRefresh: createAccountRefresh execution & lifecycle', () => {
    test('settles cleanly on successful account verification and clears ui.accountRefreshJob', async () => {
      let refreshedPanels = 0;
      let recordedChecks = 0;

      const mockStore = {
        load: async () => ({
          accounts: [
            { id: 'acc1', username: 'user1', enabled: true, checkGeneration: 'g1' }
          ],
          items: []
        }),
        update: async fn => fn({ accounts: [{ id: 'acc1' }] })
      };

      const mockUi = {
        bot: {
          store: mockStore,
          accounts: {
            list: async () => [{ id: 'acc1', username: 'user1', enabled: true, checkGeneration: 'g1' }]
          }
        },
        refreshPanels: async () => { refreshedPanels++; },
        isolatedVerifier: {
          verify: async () => ({
            isolated: true,
            vpnHealthy: true,
            exitIp: '64.112.42.39',
            authenticated: true,
            username: 'user1'
          })
        },
        recordAccountCheck: async (id, result, opts) => {
          recordedChecks++;
          opts?.onApplied?.({ id: 'acc1', username: 'user1', enabled: true, checkGeneration: 'g1' });
          return true;
        },
        accountRefreshJob: null
      };

      const job = createAccountRefresh(mockUi, { retryMs: 10, maxFailures: 2, timeoutMs: 5000 });
      mockUi.accountRefreshJob = job;

      await job.run();

      assert.strictEqual(job.pending.size, 0, 'job.pending must be empty after run');
      assert.strictEqual(mockUi.accountRefreshJob, null, 'ui.accountRefreshJob must be cleared to null');
      assert.strictEqual(recordedChecks, 1, 'recordAccountCheck must be called once');
      assert.ok(refreshedPanels > 0, 'refreshPanels must be called to update UI');
    });

    test('settles cleanly on unauthenticated account observation without infinite retry', async () => {
      let verifyCalls = 0;
      let recordedChecks = 0;

      const mockStore = {
        load: async () => ({
          accounts: [
            { id: 'acc2', username: 'user2', enabled: true, checkGeneration: 'g1' }
          ],
          items: []
        }),
        update: async fn => fn({ accounts: [{ id: 'acc2' }] })
      };

      const mockUi = {
        bot: {
          store: mockStore,
          accounts: {
            list: async () => [{ id: 'acc2', username: 'user2', enabled: true, checkGeneration: 'g1' }]
          }
        },
        refreshPanels: async () => {},
        isolatedVerifier: {
          verify: async () => {
            verifyCalls++;
            return {
              isolated: true,
              vpnHealthy: true,
              exitIp: '64.112.42.39',
              authenticated: false,
              state: 'identity_unverified'
            };
          }
        },
        recordAccountCheck: async (id, result, opts) => {
          recordedChecks++;
          opts?.onApplied?.({ id: 'acc2', username: 'user2', enabled: true, checkGeneration: 'g1' });
          return true;
        },
        accountRefreshJob: null
      };

      const job = createAccountRefresh(mockUi, { retryMs: 10, maxFailures: 2, timeoutMs: 5000 });
      mockUi.accountRefreshJob = job;

      await job.run();

      assert.strictEqual(verifyCalls, 1, 'Unauthenticated result should settle in 1 attempt without re-throwing');
      assert.strictEqual(job.pending.size, 0, 'job.pending must be empty');
      assert.strictEqual(mockUi.accountRefreshJob, null, 'ui.accountRefreshJob must be cleared to null');
      assert.strictEqual(recordedChecks, 1);
    });

    test('terminates cleanly within maxFailures when verification throws repeatedly', async () => {
      let verifyCalls = 0;
      let recordedChecks = 0;

      const mockStore = {
        load: async () => ({
          accounts: [
            { id: 'acc_fail', username: 'broken_user', enabled: true, checkGeneration: 'g1' }
          ],
          items: []
        }),
        update: async fn => fn({ accounts: [{ id: 'acc_fail' }] })
      };

      const mockUi = {
        bot: {
          store: mockStore,
          accounts: {
            list: async () => [{ id: 'acc_fail', username: 'broken_user', enabled: true, checkGeneration: 'g1' }]
          }
        },
        refreshPanels: async () => {},
        isolatedVerifier: {
          verify: async () => {
            verifyCalls++;
            throw new Error('Simulated network/proxy failure');
          }
        },
        recordAccountCheck: async () => {
          recordedChecks++;
          return true;
        },
        accountRefreshJob: null
      };

      const maxFailures = 2;
      const job = createAccountRefresh(mockUi, { retryMs: 10, maxFailures, timeoutMs: 5000 });
      mockUi.accountRefreshJob = job;

      await job.run();

      // Verified bounded retry: exactly maxFailures attempts
      assert.strictEqual(verifyCalls, maxFailures, `Should retry exactly up to maxFailures (${maxFailures})`);
      assert.strictEqual(job.pending.size, 0, 'job.pending must be cleared after reaching maxFailures');
      assert.strictEqual(mockUi.accountRefreshJob, null, 'ui.accountRefreshJob must be cleared to null');
    });
  });

  describe('accountTable: formatAccountTable Exit IP preservation', () => {
    test('preserves account.exitIp when refreshingIds.has(account.id) is true', () => {
      const state = {
        accounts: [
          { id: 'acc1', username: 'user1', enabled: true, status: 'مفعل', exitIp: '187.40.234.102' }
        ],
        telegramUi: {
          accountChecks: {}
        }
      };

      const refreshingIds = new Set(['acc1']);
      const tableHtml = formatAccountTable(state, { refreshingIds });

      assert.ok(tableHtml.includes('187.40.234.102'), 'Exit IP must remain visible during refresh');
      assert.ok(tableHtml.includes('جاري التحديث'), 'Status must show refreshing');
      assert.ok(!tableHtml.includes('>—<'), 'Exit IP must not be replaced with —');
    });

    test('preserves checks.vpn.ip when account.exitIp is not set and refreshingIds has account id', () => {
      const state = {
        accounts: [
          { id: 'acc2', username: 'user2', enabled: true, status: 'مفعل' }
        ],
        telegramUi: {
          accountChecks: {
            acc2: {
              vpn: { ip: '66.179.142.26' }
            }
          }
        }
      };

      const refreshingIds = new Set(['acc2']);
      const tableHtml = formatAccountTable(state, { refreshingIds });

      assert.ok(tableHtml.includes('66.179.142.26'), 'checks.vpn.ip must remain visible during refresh');
      assert.ok(tableHtml.includes('جاري التحديث'));
    });

    test('shows — when no public Exit IP exists at all', () => {
      const state = {
        accounts: [
          { id: 'acc3', username: 'user3', enabled: true, status: 'مفعل', exitIp: null }
        ],
        telegramUi: {
          accountChecks: {}
        }
      };

      const refreshingIds = new Set(['acc3']);
      const tableHtml = formatAccountTable(state, { refreshingIds });

      assert.ok(tableHtml.includes('—'), 'Shows — when no public IP known');
      assert.ok(tableHtml.includes('جاري التحديث'));
    });
  });

  describe('dockerVpn: getExitIp multi-provider fallback', () => {
    test('returns IP on primary provider (api.ipify.org) when successful', async () => {
      const queriedUrls = [];
      const mockCommand = async (cmd, args) => {
        if (cmd === 'curl') {
          const url = args[args.length - 1];
          queriedUrls.push(url);
          return { stdout: '187.40.234.102\n' };
        }
        throw new Error(`Unexpected: ${cmd}`);
      };

      const runtime = createDockerRuntime({ command: mockCommand });
      const ip = await runtime.getExitIp(18801);

      assert.strictEqual(ip, '187.40.234.102');
      assert.strictEqual(queriedUrls.length, 1);
      assert.strictEqual(queriedUrls[0], 'https://api.ipify.org');
    });

    test('falls back to icanhazip.com when api.ipify.org fails', async () => {
      const queriedUrls = [];
      const mockCommand = async (cmd, args) => {
        if (cmd === 'curl') {
          const url = args[args.length - 1];
          queriedUrls.push(url);
          if (url === 'https://api.ipify.org') {
            throw new Error('Connection timed out to ipify');
          }
          if (url === 'https://icanhazip.com') {
            return { stdout: '66.179.142.26\n' };
          }
        }
        throw new Error(`Unexpected: ${cmd}`);
      };

      const runtime = createDockerRuntime({ command: mockCommand });
      const ip = await runtime.getExitIp(18802);

      assert.strictEqual(ip, '66.179.142.26');
      assert.ok(queriedUrls.includes('https://api.ipify.org'), 'Must have tried ipify first');
      assert.ok(queriedUrls.includes('https://icanhazip.com'), 'Must have fallen back to icanhazip');
    });

    test('falls back to ifconfig.me when both ipify and icanhazip fail', async () => {
      const queriedUrls = [];
      const mockCommand = async (cmd, args) => {
        if (cmd === 'curl') {
          const url = args[args.length - 1];
          queriedUrls.push(url);
          if (url === 'https://api.ipify.org' || url === 'https://icanhazip.com') {
            throw new Error('503 Service Unavailable');
          }
          if (url === 'https://ifconfig.me/ip') {
            return { stdout: '187.40.235.79\n' };
          }
        }
        throw new Error(`Unexpected: ${cmd}`);
      };

      const runtime = createDockerRuntime({ command: mockCommand });
      const ip = await runtime.getExitIp(18803);

      assert.strictEqual(ip, '187.40.235.79');
      assert.ok(queriedUrls.includes('https://ifconfig.me/ip'));
    });

    test('returns null when all providers fail', async () => {
      const mockCommand = async (cmd) => {
        if (cmd === 'curl') {
          throw new Error('Network completely down');
        }
        throw new Error(`Unexpected: ${cmd}`);
      };

      const runtime = createDockerRuntime({ command: mockCommand });
      const ip = await runtime.getExitIp(18804);

      assert.strictEqual(ip, null);
    });
  });
});
