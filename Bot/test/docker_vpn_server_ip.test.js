'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const {
  createDockerRuntime,
  VPN_IMAGE,
  DEFAULT_VPN_VERSION,
  NORDVPN_VERSION
} = require('../src/dockerVpn');

describe('FINDING-015 & FINDING-031: Docker VPN Server IP & Image Tag Pinning', () => {
  const originalServerIp = process.env.SERVER_IP;

  afterEach(() => {
    if (originalServerIp !== undefined) {
      process.env.SERVER_IP = originalServerIp;
    } else {
      delete process.env.SERVER_IP;
    }
  });

  describe('FINDING-031: Image Tag & Version Pinning', () => {
    test('pins DEFAULT_VPN_VERSION and NORDVPN_VERSION to 6.0.2', () => {
      assert.strictEqual(DEFAULT_VPN_VERSION, '6.0.2');
      assert.strictEqual(NORDVPN_VERSION, '6.0.2');
    });

    test('pins VPN_IMAGE tag to 6.0.2 by default', () => {
      assert.strictEqual(VPN_IMAGE, 'yj_autopost_vpn_image:6.0.2');
    });

    test('containerStatus recognizes yj_autopost_vpn_image:6.0.2 as compatible', async () => {
      const mockCommand = async (cmd, args) => {
        if (cmd === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
          return {
            stdout: JSON.stringify([{
              Config: {
                Image: 'yj_autopost_vpn_image:6.0.2',
                Labels: {
                  'io.yj-autopost.owner': 'yj-autopost',
                  'io.yj-autopost.slot': '0',
                  'io.yj-autopost.contract': 'independent-v1'
                }
              },
              State: { Running: true, Status: 'running', Health: { Status: 'healthy' } }
            }])
          };
        }
        throw new Error(`Unhandled command: ${cmd} ${args.join(' ')}`);
      };

      const runtime = createDockerRuntime({ command: mockCommand });
      const status = await runtime.containerStatus(0);
      assert.strictEqual(status.exists, true);
      assert.strictEqual(status.running, true);
      assert.strictEqual(status.compatible, true);
      assert.strictEqual(status.owned, true);
    });

    test('containerStatus backward compatibility with existing latest tag', async () => {
      const mockCommand = async (cmd, args) => {
        if (cmd === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
          return {
            stdout: JSON.stringify([{
              Config: {
                Image: 'yj_autopost_vpn_image:latest',
                Labels: {
                  'io.yj-autopost.owner': 'yj-autopost',
                  'io.yj-autopost.slot': '0',
                  'io.yj-autopost.contract': 'independent-v1'
                }
              },
              State: { Running: true, Status: 'running', Health: { Status: 'healthy' } }
            }])
          };
        }
        throw new Error(`Unhandled command: ${cmd} ${args.join(' ')}`);
      };

      const runtime = createDockerRuntime({ command: mockCommand });
      const status = await runtime.containerStatus(0);
      assert.strictEqual(status.compatible, true);
    });
  });

  describe('FINDING-015: Server IP Resolution and Memory Caching', () => {
    test('supports explicit serverIp option without making external requests', async () => {
      let commandInvoked = false;
      const mockCommand = async () => {
        commandInvoked = true;
        throw new Error('Should not be called');
      };

      const runtime = createDockerRuntime({
        command: mockCommand,
        serverIp: '8.8.8.8'
      });

      const resolved = await runtime.getServerIp();
      assert.strictEqual(resolved, '8.8.8.8');
      assert.strictEqual(commandInvoked, false);
      assert.strictEqual(runtime.getCachedServerIp(), '8.8.8.8');
    });

    test('supports configured process.env.SERVER_IP', async () => {
      process.env.SERVER_IP = '8.8.4.4';
      let commandInvoked = false;
      const mockCommand = async () => {
        commandInvoked = true;
        throw new Error('Should not be called');
      };

      const runtime = createDockerRuntime({ command: mockCommand });
      const resolved = await runtime.getServerIp();
      assert.strictEqual(resolved, '8.8.4.4');
      assert.strictEqual(commandInvoked, false);
      assert.strictEqual(runtime.getCachedServerIp(), '8.8.4.4');
    });

    test('eliminates --noproxy "*" from curl fallback and caches result in memory', async () => {
      delete process.env.SERVER_IP;
      let curlCalls = 0;
      let recordedArgs = null;

      const mockCommand = async (cmd, args) => {
        if (cmd === 'curl') {
          curlCalls++;
          recordedArgs = args;
          return { stdout: '93.184.216.34\n' };
        }
        throw new Error(`Unexpected command: ${cmd}`);
      };

      const runtime = createDockerRuntime({
        command: mockCommand,
        serverIp: null
      });

      // Override getCachedServerIp and setServerIp to simulate non-interface fallback
      runtime.clearCachedServerIp();

      // Temporarily override os.networkInterfaces to return only internal/private addresses
      const os = require('node:os');
      const originalInterfaces = os.networkInterfaces;
      os.networkInterfaces = () => ({
        eth0: [{ family: 'IPv4', internal: false, address: '10.0.0.5' }],
        lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }]
      });

      try {
        // First call: executes curl fallback
        const ip1 = await runtime.getServerIp();
        assert.strictEqual(ip1, '93.184.216.34');
        assert.strictEqual(curlCalls, 1);

        // Verify that --noproxy '*' was eliminated!
        assert.ok(recordedArgs, 'Curl should have been executed');
        assert.strictEqual(recordedArgs.includes('--noproxy'), false, 'Must eliminate --noproxy flag');
        assert.strictEqual(recordedArgs.includes('*'), false, 'Must eliminate wildcard noproxy target');
        assert.ok(recordedArgs.includes('https://api.ipify.org'));

        // Second call: must return cached IP without invoking curl again
        const ip2 = await runtime.getServerIp();
        assert.strictEqual(ip2, '93.184.216.34');
        assert.strictEqual(curlCalls, 1, 'Subsequent call must use in-memory cache, not repeated external calls');
      } finally {
        os.networkInterfaces = originalInterfaces;
      }
    });

    test('falls back safely returning null if curl fails without crashing', async () => {
      delete process.env.SERVER_IP;
      const failingCommand = async () => {
        throw new Error('Network unreachable');
      };

      const runtime = createDockerRuntime({
        command: failingCommand,
        serverIp: null
      });
      runtime.clearCachedServerIp();

      const os = require('node:os');
      const originalInterfaces = os.networkInterfaces;
      os.networkInterfaces = () => ({
        lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }]
      });

      try {
        const ip = await runtime.getServerIp();
        assert.strictEqual(ip, null);
      } finally {
        os.networkInterfaces = originalInterfaces;
      }
    });

    test('detects ip leak in healthCheck when exitIp matches serverIp', async () => {
      const mockCommand = async (cmd, args) => {
        if (cmd === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
          return {
            stdout: JSON.stringify([{
              Config: {
                Image: 'yj_autopost_vpn_image:6.0.2',
                Labels: {
                  'io.yj-autopost.owner': 'yj-autopost',
                  'io.yj-autopost.slot': '0',
                  'io.yj-autopost.contract': 'independent-v1'
                }
              },
              State: { Running: true, Status: 'running', Health: { Status: 'healthy' } }
            }])
          };
        }
        if (cmd === 'curl') {
          // getExitIp returns 8.8.8.8
          return { stdout: '8.8.8.8\n' };
        }
        throw new Error(`Unexpected: ${cmd}`);
      };

      // Server IP is also configured as 8.8.8.8 -> leak!
      const runtime = createDockerRuntime({
        command: mockCommand,
        serverIp: '8.8.8.8'
      });

      const check = await runtime.healthCheck(0);
      assert.strictEqual(check.healthy, false);
      assert.strictEqual(check.reason, 'ip_leak_detected');
    });

    test('passes healthCheck when exitIp differs from serverIp', async () => {
      const mockCommand = async (cmd, args) => {
        if (cmd === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
          return {
            stdout: JSON.stringify([{
              Config: {
                Image: 'yj_autopost_vpn_image:6.0.2',
                Labels: {
                  'io.yj-autopost.owner': 'yj-autopost',
                  'io.yj-autopost.slot': '0',
                  'io.yj-autopost.contract': 'independent-v1'
                }
              },
              State: { Running: true, Status: 'running', Health: { Status: 'healthy' } }
            }])
          };
        }
        if (cmd === 'curl') {
          // getExitIp returns VPN exit IP 198.18.0.1 -> wait, public IP!
          // 93.184.216.34 (public)
          return { stdout: '93.184.216.34\n' };
        }
        throw new Error(`Unexpected: ${cmd}`);
      };

      const runtime = createDockerRuntime({
        command: mockCommand,
        serverIp: '8.8.8.8' // different from exit IP 93.184.216.34
      });

      const check = await runtime.healthCheck(0);
      assert.strictEqual(check.healthy, true);
      assert.strictEqual(check.exitIp, '93.184.216.34');
    });
  });
});
