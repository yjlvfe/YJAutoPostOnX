'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: sleep } = require('node:timers/promises');
const { createAccountRefresh, confirmed } = require('../src/accountRefresh');
const { formatAccountTable } = require('../src/accountTable');
const { createDockerRuntime } = require('../src/dockerVpn');
const { isPublicIp } = require('../src/publicIp');

describe('Empirical Stress Challenge: M1 Accounts Refresh & Exit IP Display', () => {

  describe('Challenge 1: All accounts failing continuously (synthetic faults)', () => {
    test('terminates within maxFailures when all 5 accounts experience repeated VPN_NOT_READY and timeouts', async () => {
      const accountIds = ['acc_vpn_down_1', 'acc_vpn_down_2', 'acc_timeout_3', 'acc_refused_4', 'acc_bad_ip_5'];
      const verifyCounts = Object.fromEntries(accountIds.map(id => [id, 0]));
      const recordedChecks = [];

      const accountsList = accountIds.map((id, idx) => ({
        id,
        username: `user_${idx}`,
        enabled: true,
        checkGeneration: `gen_${id}`
      }));

      const mockStore = {
        load: async () => ({
          accounts: accountsList,
          items: []
        }),
        update: async fn => fn({ accounts: accountsList })
      };

      const mockUi = {
        bot: {
          store: mockStore,
          accounts: {
            list: async () => accountsList
          }
        },
        refreshPanels: async () => {},
        isolatedVerifier: {
          verify: async (account) => {
            verifyCounts[account.id]++;
            if (account.id.includes('bad_ip')) {
              // Returns valid isolation and healthy VPN, but invalid private IP (not public)
              return {
                isolated: true,
                vpnHealthy: true,
                exitIp: '10.200.0.1',
                authenticated: false
              };
            }
            if (account.id.includes('timeout')) {
              throw new Error('ETIMEDOUT: Proxy socket connect timeout');
            }
            throw new Error('VPN_NOT_READY: Wireguard interface wg0 down');
          }
        },
        recordAccountCheck: async (id, result, opts) => {
          recordedChecks.push({ id, result, opts });
          return true;
        },
        accountRefreshJob: null
      };

      const maxFailures = 2;
      const startTime = Date.now();
      const job = createAccountRefresh(mockUi, { retryMs: 5, maxFailures, timeoutMs: 15000 });
      mockUi.accountRefreshJob = job;

      await job.run();
      const durationMs = Date.now() - startTime;

      // 1. Verify all accounts were retried exactly maxFailures times
      for (const id of accountIds) {
        assert.strictEqual(
          verifyCounts[id],
          maxFailures,
          `Account ${id} should have been verified exactly ${maxFailures} times, but was called ${verifyCounts[id]} times`
        );
      }

      // 2. Verify job.pending is cleared
      assert.strictEqual(job.pending.size, 0, 'job.pending must be empty after all lanes terminate');

      // 3. Verify ui.accountRefreshJob is cleared
      assert.strictEqual(mockUi.accountRefreshJob, null, 'ui.accountRefreshJob must be null after job finishes');

      // 4. Verify failure checks were recorded for each account
      assert.strictEqual(recordedChecks.length, accountIds.length, 'Every account must have a recorded failure check');
      for (const check of recordedChecks) {
        assert.strictEqual(check.result.isolated, false);
        assert.strictEqual(check.result.vpnHealthy, false);
        assert.strictEqual(check.result.authenticated, false);
        assert.strictEqual(check.opts.source, 'vpn-health');
      }

      // 5. Verify run terminated rapidly and did not hang or wait for overallTimeout
      assert.ok(durationMs < 5000, `Execution should finish quickly, took ${durationMs}ms`);
    });

    test('terminates cleanly when maxFailures is 1 (immediate failure boundary)', async () => {
      const accountIds = ['acc_single_try_1', 'acc_single_try_2'];
      const verifyCounts = Object.fromEntries(accountIds.map(id => [id, 0]));

      const accountsList = accountIds.map(id => ({ id, enabled: true, checkGeneration: `gen_${id}` }));
      const mockUi = {
        bot: {
          store: { load: async () => ({ accounts: accountsList, items: [] }) },
          accounts: { list: async () => accountsList }
        },
        refreshPanels: async () => {},
        isolatedVerifier: {
          verify: async (account) => {
            verifyCounts[account.id]++;
            throw new Error('Immediate network crash');
          }
        },
        recordAccountCheck: async () => true,
        accountRefreshJob: null
      };

      const job = createAccountRefresh(mockUi, { retryMs: 5, maxFailures: 1, timeoutMs: 5000 });
      mockUi.accountRefreshJob = job;

      await job.run();

      for (const id of accountIds) {
        assert.strictEqual(verifyCounts[id], 1, `Account ${id} should fail on attempt 1 without retrying`);
      }
      assert.strictEqual(job.pending.size, 0);
      assert.strictEqual(mockUi.accountRefreshJob, null);
    });
  });

  describe('Challenge 2: Mixed failure permutations and partial successes', () => {
    test('settles cleanly with 0 pending and null job under heterogeneous account outcomes', async () => {
      let storeState = {
        accounts: [
          { id: 'acc_ok', username: 'good_user', enabled: true, checkGeneration: 'g1' },
          { id: 'acc_unauth', username: 'unauth_user', enabled: true, checkGeneration: 'g1' },
          { id: 'acc_transient_fail', username: 'recovering_user', enabled: true, checkGeneration: 'g1' },
          { id: 'acc_hard_fail', username: 'broken_user', enabled: true, checkGeneration: 'g1' },
          { id: 'acc_rate_limit_429', username: 'limited_user', enabled: true, checkGeneration: 'g1' },
          { id: 'acc_deleted_mid_refresh', username: 'deleted_user', enabled: true, checkGeneration: 'g1' }
        ],
        items: []
      };

      const verifyCalls = Object.fromEntries(storeState.accounts.map(a => [a.id, 0]));
      const appliedChecks = [];

      const mockStore = {
        load: async () => structuredClone(storeState),
        update: async fn => {
          storeState = fn(structuredClone(storeState));
          return storeState;
        }
      };

      const mockUi = {
        bot: {
          store: mockStore,
          accounts: {
            list: async () => structuredClone(storeState.accounts || [])
          }
        },
        refreshPanels: async () => {},
        isolatedVerifier: {
          verify: async (account) => {
            verifyCalls[account.id]++;

            if (account.id === 'acc_ok') {
              return {
                isolated: true,
                vpnHealthy: true,
                exitIp: '185.220.101.5',
                authenticated: true,
                username: 'good_user'
              };
            }

            if (account.id === 'acc_unauth') {
              // Unauthenticated with valid IP and state diagnostic
              return {
                isolated: true,
                vpnHealthy: true,
                exitIp: '185.220.101.6',
                authenticated: false,
                state: 'identity_unverified'
              };
            }

            if (account.id === 'acc_transient_fail') {
              if (verifyCalls[account.id] === 1) {
                // Also simulate deletion of acc_deleted_mid_refresh during this transient failure
                storeState.accounts = storeState.accounts.filter(a => a.id !== 'acc_deleted_mid_refresh');
                throw new Error('Temporary connection reset');
              }
              // 2nd attempt succeeds
              return {
                isolated: true,
                vpnHealthy: true,
                exitIp: '185.220.101.7',
                authenticated: true,
                username: 'recovering_user'
              };
            }

            if (account.id === 'acc_hard_fail') {
              throw new Error('VPN_NOT_READY: slot 4 down');
            }

            if (account.id === 'acc_rate_limit_429') {
              // Rate limited observation: valid VPN and IP, but 429 diagnostic
              return {
                isolated: true,
                vpnHealthy: true,
                exitIp: '185.220.101.8',
                authenticated: false,
                readDiagnostic: { httpStatus: 429, retryAfterSeconds: 60 }
              };
            }

            if (account.id === 'acc_deleted_mid_refresh') {
              return {
                isolated: true,
                vpnHealthy: true,
                exitIp: '185.220.101.9',
                authenticated: true
              };
            }

            throw new Error(`Unexpected account verify call: ${account.id}`);
          }
        },
        recordAccountCheck: async (id, result, opts) => {
          appliedChecks.push({ id, result, opts });
          opts?.onApplied?.({ id, ...result });
          return true;
        },
        accountRefreshJob: null
      };

      const maxFailures = 2;
      const job = createAccountRefresh(mockUi, { retryMs: 5, maxFailures, timeoutMs: 10000 });
      mockUi.accountRefreshJob = job;

      await job.run();

      // Verifications:
      assert.strictEqual(job.pending.size, 0, 'job.pending must be empty');
      assert.strictEqual(mockUi.accountRefreshJob, null, 'ui.accountRefreshJob must be null');

      // Verify call counts:
      assert.strictEqual(verifyCalls['acc_ok'], 1, 'acc_ok settled in 1 call');
      assert.strictEqual(verifyCalls['acc_unauth'], 1, 'acc_unauth settled in 1 call without infinite retry');
      assert.strictEqual(verifyCalls['acc_transient_fail'], 2, 'acc_transient_fail retried once then succeeded');
      assert.strictEqual(verifyCalls['acc_hard_fail'], 2, 'acc_hard_fail retried up to maxFailures');
      assert.strictEqual(verifyCalls['acc_rate_limit_429'], 1, 'acc_rate_limit_429 confirmed on 1st call');
    });

    test('handles recordAccountCheck returning applied=false (concurrency collision) up to maxFailures', async () => {
      let attempts = 0;
      const accountsList = [{ id: 'acc_conflict', enabled: true, checkGeneration: 'g1' }];

      const mockUi = {
        bot: {
          store: { load: async () => ({ accounts: accountsList, items: [] }) },
          accounts: { list: async () => accountsList }
        },
        refreshPanels: async () => {},
        isolatedVerifier: {
          verify: async () => {
            attempts++;
            return {
              isolated: true,
              vpnHealthy: true,
              exitIp: '185.220.101.55',
              authenticated: true
            };
          }
        },
        recordAccountCheck: async () => false, // simulates deferred/superseded update collision
        accountRefreshJob: null
      };

      const maxFailures = 2;
      const job = createAccountRefresh(mockUi, { retryMs: 5, maxFailures, timeoutMs: 5000 });
      mockUi.accountRefreshJob = job;

      await job.run();

      assert.strictEqual(attempts, maxFailures, `Should retry up to maxFailures (${maxFailures}) when applied is false`);
      assert.strictEqual(job.pending.size, 0);
      assert.strictEqual(mockUi.accountRefreshJob, null);
    });
  });

  describe('Challenge 3: External controller.abort() while operations in-flight', () => {
    test('disposes cleanly without unhandled rejections when aborted during active verifications', async () => {
      const unhandledRejections = [];
      const onUnhandled = err => unhandledRejections.push(err);
      process.on('unhandledRejection', onUnhandled);

      try {
        const accountsList = [
          { id: 'acc_abort_1', enabled: true, checkGeneration: 'g1' },
          { id: 'acc_abort_2', enabled: true, checkGeneration: 'g1' },
          { id: 'acc_abort_3', enabled: true, checkGeneration: 'g1' }
        ];

        const mockUi = {
          bot: {
            store: { load: async () => ({ accounts: accountsList, items: [] }) },
            accounts: { list: async () => accountsList }
          },
          refreshPanels: async () => {},
          isolatedVerifier: {
            verify: async (account, opts) => {
              // Simulate in-flight async work that observes the abort signal
              await sleep(100, undefined, { signal: opts?.signal }).catch(err => {
                if (err.name === 'AbortError') return;
                throw err;
              });
              return {
                isolated: true,
                vpnHealthy: true,
                exitIp: '185.220.101.99',
                authenticated: true
              };
            }
          },
          recordAccountCheck: async () => true,
          accountRefreshJob: null
        };

        const job = createAccountRefresh(mockUi, { retryMs: 10, maxFailures: 3, timeoutMs: 10000 });
        mockUi.accountRefreshJob = job;

        const runPromise = job.run();

        // Abort externally while verify is in-flight
        await sleep(25);
        job.controller.abort();

        await runPromise;

        assert.strictEqual(job.pending.size, 0, 'job.pending must be empty after abort');
        assert.strictEqual(mockUi.accountRefreshJob, null, 'ui.accountRefreshJob must be null after abort');
        assert.strictEqual(unhandledRejections.length, 0, 'No unhandled rejections allowed');
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });

    test('disposes cleanly without unhandled rejections when aborted while paused in retry backoff', async () => {
      const unhandledRejections = [];
      const onUnhandled = err => unhandledRejections.push(err);
      process.on('unhandledRejection', onUnhandled);

      try {
        const accountsList = [
          { id: 'acc_backoff_1', enabled: true, checkGeneration: 'g1' }
        ];

        let callCount = 0;
        const mockUi = {
          bot: {
            store: { load: async () => ({ accounts: accountsList, items: [] }) },
            accounts: { list: async () => accountsList }
          },
          refreshPanels: async () => {},
          isolatedVerifier: {
            verify: async () => {
              callCount++;
              // Throw to force lane into retry backoff delay
              throw new Error('Simulated network fault for pause test');
            }
          },
          recordAccountCheck: async () => true,
          accountRefreshJob: null
        };

        // Long retryMs so it remains in pause until abort
        const job = createAccountRefresh(mockUi, { retryMs: 2000, maxFailures: 3, timeoutMs: 10000 });
        mockUi.accountRefreshJob = job;

        const runPromise = job.run();

        // Wait until first attempt fails and lane enters delay
        await sleep(30);
        assert.strictEqual(callCount, 1);

        // Abort during delay
        job.controller.abort();

        await runPromise;

        assert.strictEqual(job.pending.size, 0);
        assert.strictEqual(mockUi.accountRefreshJob, null);
        assert.strictEqual(unhandledRejections.length, 0);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });

    test('overall timeout cleanly terminates hung lanes when verifier is unresponsive', async () => {
      const accountsList = [{ id: 'acc_hang', enabled: true, checkGeneration: 'g1' }];

      const mockUi = {
        bot: {
          store: { load: async () => ({ accounts: accountsList, items: [] }) },
          accounts: { list: async () => accountsList }
        },
        refreshPanels: async () => {},
        isolatedVerifier: {
          verify: async (account, opts) => {
            // Never resolves until aborted
            await sleep(5000, undefined, { signal: opts?.signal }).catch(() => {});
            return { isolated: false, vpnHealthy: false };
          }
        },
        recordAccountCheck: async () => true,
        accountRefreshJob: null
      };

      const startTime = Date.now();
      // Bounded timeout: 80ms
      const job = createAccountRefresh(mockUi, { retryMs: 10, maxFailures: 5, timeoutMs: 80 });
      mockUi.accountRefreshJob = job;

      await job.run();
      const elapsed = Date.now() - startTime;

      assert.ok(elapsed >= 70 && elapsed < 1000, `Should terminate shortly after timeoutMs (elapsed: ${elapsed}ms)`);
      assert.strictEqual(job.pending.size, 0);
      assert.strictEqual(mockUi.accountRefreshJob, null);
    });
  });

  describe('Challenge 4: formatAccountTable Exit IP preservation across all permutations', () => {
    // Valid public IPv4s verified by isPublicIp()
    const publicIp1 = '185.220.101.5';
    const publicIp2 = '66.179.142.26';
    // Private IPv4s
    const privateIp1 = '10.0.0.1';
    const privateIp2 = '192.168.1.1';

    // Verify test fixture IPs with isPublicIp directly
    assert.strictEqual(isPublicIp(publicIp1), true);
    assert.strictEqual(isPublicIp(publicIp2), true);
    assert.strictEqual(isPublicIp(privateIp1), false);
    assert.strictEqual(isPublicIp(privateIp2), false);

    const testPermutations = [
      {
        name: 'Permutation 1: account.exitIp is public, checks.vpn is empty, refreshing=true',
        account: { id: 'a1', username: 'u1', exitIp: publicIp1, enabled: true },
        checks: {},
        refreshing: true,
        expectedIp: publicIp1,
        expectedStatus: 'جاري التحديث'
      },
      {
        name: 'Permutation 2: account.exitIp is null, checks.vpn.ip is public, refreshing=true',
        account: { id: 'a2', username: 'u2', exitIp: null, enabled: true },
        checks: { vpn: { ip: publicIp2 } },
        refreshing: true,
        expectedIp: publicIp2,
        expectedStatus: 'جاري التحديث'
      },
      {
        name: 'Permutation 3: both account.exitIp and checks.vpn.ip are public, refreshing=true (account.exitIp takes priority)',
        account: { id: 'a3', username: 'u3', exitIp: publicIp1, enabled: true },
        checks: { vpn: { ip: publicIp2 } },
        refreshing: true,
        expectedIp: publicIp1,
        expectedStatus: 'جاري التحديث'
      },
      {
        name: 'Permutation 4: account.exitIp is private, checks.vpn.ip is public, refreshing=true (skips private, uses public)',
        account: { id: 'a4', username: 'u4', exitIp: privateIp1, enabled: true },
        checks: { vpn: { ip: publicIp2 } },
        refreshing: true,
        expectedIp: publicIp2,
        expectedStatus: 'جاري التحديث'
      },
      {
        name: 'Permutation 5: account.exitIp is private, checks.vpn.ip is private, refreshing=true (neither public -> shows —)',
        account: { id: 'a5', username: 'u5', exitIp: privateIp1, enabled: true },
        checks: { vpn: { ip: privateIp2 } },
        refreshing: true,
        expectedIp: '—',
        expectedStatus: 'جاري التحديث'
      },
      {
        name: 'Permutation 6: neither is set, refreshing=true -> shows —',
        account: { id: 'a6', username: 'u6', exitIp: null, enabled: true },
        checks: {},
        refreshing: true,
        expectedIp: '—',
        expectedStatus: 'جاري التحديث'
      },
      {
        name: 'Permutation 7: account.exitIp is public, checks.vpn is empty, refreshing=false -> shows IP and regular status',
        account: { id: 'a7', username: 'u7', exitIp: publicIp1, enabled: true },
        checks: {},
        refreshing: false,
        expectedIp: publicIp1,
        expectedStatus: 'مفعل'
      },
      {
        name: 'Permutation 8: account.exitIp is null, checks.vpn.ip is public, refreshing=false -> shows IP and regular status',
        account: { id: 'a8', username: 'u8', exitIp: null, enabled: true },
        checks: { vpn: { ip: publicIp2 } },
        refreshing: false,
        expectedIp: publicIp2,
        expectedStatus: 'مفعل'
      },
      {
        name: 'Permutation 9: account status is كابتشا and refreshing=true -> preserves public IP with جاري التحديث',
        account: { id: 'a9', username: 'u9', exitIp: publicIp1, status: 'كابتشا', enabled: true },
        checks: {},
        refreshing: true,
        expectedIp: publicIp1,
        expectedStatus: 'جاري التحديث'
      },
      {
        name: 'Permutation 10: account status is كابتشا and refreshing=false -> preserves public IP with كابتشا',
        account: { id: 'a10', username: 'u10', exitIp: publicIp1, status: 'كابتشا', enabled: true },
        checks: {},
        refreshing: false,
        expectedIp: publicIp1,
        expectedStatus: 'كابتشا'
      },
      {
        name: 'Permutation 11: account status is محظور (banned) with all=true and refreshing=true',
        account: { id: 'a11', username: 'u11', exitIp: publicIp1, status: 'محظور', enabled: false },
        checks: {},
        refreshing: true,
        expectedIp: publicIp1,
        expectedStatus: 'جاري التحديث',
        all: true
      },
      {
        name: 'Permutation 12: options omitted completely (refreshingIds undefined)',
        account: { id: 'a12', username: 'u12', exitIp: publicIp1, enabled: true },
        checks: {},
        refreshing: undefined,
        expectedIp: publicIp1,
        expectedStatus: 'مفعل',
        omitOpts: true
      }
    ];

    for (const p of testPermutations) {
      test(p.name, () => {
        const state = {
          accounts: [p.account],
          telegramUi: {
            accountChecks: {
              [p.account.id]: p.checks
            }
          }
        };

        const opts = p.omitOpts
          ? undefined
          : {
              refreshingIds: p.refreshing ? new Set([p.account.id]) : new Set(),
              all: Boolean(p.all)
            };

        const html = formatAccountTable(state, opts);

        if (p.expectedIp === '—') {
          assert.ok(html.includes('>—<'), `Must render — when no valid public IP is available. Output:\n${html}`);
        } else {
          assert.ok(html.includes(p.expectedIp), `Must render public IP ${p.expectedIp}. Output:\n${html}`);
          // Ensure it did not get masked with — in the IP cell
          assert.ok(!html.includes(`<td>${p.expectedIp}</td><td>—</td>`));
        }

        assert.ok(html.includes(p.expectedStatus), `Must render status ${p.expectedStatus}. Output:\n${html}`);
      });
    }

    test('multi-account table with mixed refreshing states simultaneously displays each correctly', () => {
      const state = {
        accounts: [
          { id: 'acc_refr_1', username: 'usr1', exitIp: publicIp1, enabled: true },
          { id: 'acc_idle_2', username: 'usr2', exitIp: publicIp2, enabled: true },
          { id: 'acc_noip_3', username: 'usr3', exitIp: null, enabled: true }
        ],
        telegramUi: {
          accountChecks: {
            acc_noip_3: { vpn: { ip: publicIp1 } }
          }
        }
      };

      // acc_refr_1 and acc_noip_3 are refreshing; acc_idle_2 is idle
      const refreshingIds = new Set(['acc_refr_1', 'acc_noip_3']);
      const html = formatAccountTable(state, { refreshingIds });

      // Both public IPs must be present in the table
      assert.ok(html.includes(publicIp1), `Missing IP ${publicIp1}`);
      assert.ok(html.includes(publicIp2), `Missing IP ${publicIp2}`);

      // Two accounts should be marked 'جاري التحديث', one marked 'مفعل'
      const refreshingMatches = (html.match(/<td align="center">جاري التحديث<\/td>/g) || []).length;
      const activeMatches = (html.match(/<td align="center">مفعل<\/td>/g) || []).length;

      assert.strictEqual(refreshingMatches, 2, 'Exactly 2 accounts should show refreshing status');
      assert.strictEqual(activeMatches, 1, 'Exactly 1 account should show active status');
    });
  });
});
