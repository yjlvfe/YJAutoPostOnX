'use strict';

const { createDockerRuntime, VpnSlotManager } = require('../../src/dockerVpn');

const AUTHORIZED_CONTAINERS = [
  'cryptovpn-nordvpn',
  'yjdownloadvideo-nordvpn-1',
  'yj_autopost_vpn_1',
  'yj_autopost_vpn_2',
  'yj_autopost_vpn_3',
  'yj_autopost_vpn_4',
  'yj_autopost_vpn_5'
];

const DEFAULT_SLOT_IPS = [
  '203.0.114.11',
  '203.0.115.12',
  '203.0.116.13',
  '203.0.117.14',
  '203.0.118.15'
];

function createFakeDockerCommand({
  slotStates = {},
  slotIps = DEFAULT_SLOT_IPS,
  rotatedIps = ['203.0.119.21', '203.0.120.22', '203.0.121.23', '203.0.122.24'],
  hostContainers = AUTHORIZED_CONTAINERS,
  existingVolumes = null,
  imageTag = '6.0.2',
  ownerLabel = 'yj-autopost',
  contractLabel = 'independent-v1',
  execError = null,
  directIpifyResponse = '8.8.8.8'
} = {}) {
  const calls = [];
  const dockerRuns = [];
  const dockerRms = [];
  const dockerStarts = [];
  const dockerExecs = [];
  const curlCalls = [];
  let rotateCounter = 0;

  const defaultVolumes = new Set();
  for (let i = 1; i <= 5; i++) {
    defaultVolumes.add(`yj_autopost_vpn_${i}_state`);
    defaultVolumes.add(`yj_autopost_vpn_${i}_auth`);
  }
  const volumes = existingVolumes ? new Set(existingVolumes) : defaultVolumes;

  const command = async (bin, args = [], opts = {}) => {
    calls.push({ bin, args, opts });

    if (bin === 'curl') {
      curlCalls.push(args);
      const socksIdx = args.indexOf('--socks5-hostname');
      if (socksIdx !== -1 && args[socksIdx + 1]) {
        const portStr = args[socksIdx + 1].split(':')[1];
        const slot = Number(portStr) - 18801;
        const state = slotStates[slot] || {};
        if (state.proxyUnreachable) {
          throw Object.assign(new Error('curl: (7) Failed to connect to 127.0.0.1'), { code: 7 });
        }
        const ip = state.exitIp ?? slotIps[slot] ?? '203.0.114.99';
        return { stdout: `${ip}\n`, stderr: '' };
      }
      return { stdout: `${directIpifyResponse}\n`, stderr: '' };
    }

    if (bin === 'docker') {
      const sub = args[0];
      if (sub === 'container' && args[1] === 'inspect') {
        const name = args[2];
        const slotMatch = name.match(/yj_autopost_vpn_(\d+)/);
        const slot = slotMatch ? Number(slotMatch[1]) - 1 : 0;
        const st = slotStates[slot] || {};
        if (st.exists === false) {
          throw new Error(`Error: No such container: ${name}`);
        }
        const info = [{
          Config: {
            Image: st.image || `yj_autopost_vpn_image:${imageTag}`,
            Labels: {
              'io.yj-autopost.owner': st.owner ?? ownerLabel,
              'io.yj-autopost.slot': String(st.slotLabel ?? slot),
              'io.yj-autopost.contract': st.contract ?? contractLabel
            }
          },
          State: {
            Running: st.running !== false,
            Status: st.running === false ? 'exited' : 'running',
            Health: {
              Status: st.healthy === false ? 'unhealthy' : 'healthy'
            }
          },
          Mounts: st.mounts || [
            { Type: 'volume', Name: `${name}_state`, Destination: '/var/lib/nordvpn' },
            { Type: 'volume', Name: `${name}_auth`, Destination: '/root/.config/nordvpn' }
          ]
        }];
        return { stdout: JSON.stringify(info), stderr: '' };
      }

      if ((sub === 'container' && args[1] === 'ls') || sub === 'ps') {
        const filterArg = args.find(a => a.startsWith('name='));
        if (filterArg) {
          const m = filterArg.match(/yj_autopost_vpn_(\d+)/);
          const slot = m ? Number(m[1]) - 1 : 0;
          const st = slotStates[slot] || {};
          if (st.exists === false) return { stdout: '', stderr: '' };
          return { stdout: `yj_autopost_vpn_${slot + 1}\n`, stderr: '' };
        }
        return { stdout: hostContainers.join('\n') + '\n', stderr: '' };
      }

      if (sub === 'volume' && args[1] === 'inspect') {
        const volName = args[2];
        if (!volumes.has(volName)) {
          const err = new Error(`Error: No such volume: ${volName}`);
          err.stderr = `Error: No such volume: ${volName}`;
          throw err;
        }
        return { stdout: JSON.stringify([{ Name: volName }]), stderr: '' };
      }

      if (sub === 'run') {
        dockerRuns.push(args);
        const nameIdx = args.indexOf('--name');
        if (nameIdx !== -1) {
          const name = args[nameIdx + 1];
          const m = name.match(/yj_autopost_vpn_(\d+)/);
          if (m) {
            const slot = Number(m[1]) - 1;
            slotStates[slot] = { ...(slotStates[slot] || {}), exists: true, running: true, healthy: true };
          }
        }
        return { stdout: 'fake_container_id\n', stderr: '' };
      }

      if (sub === 'start') {
        dockerStarts.push(args);
        const name = args[1];
        const m = name.match(/yj_autopost_vpn_(\d+)/);
        if (m) {
          const slot = Number(m[1]) - 1;
          slotStates[slot] = { ...(slotStates[slot] || {}), exists: true, running: true, healthy: true };
        }
        return { stdout: `${name}\n`, stderr: '' };
      }

      if (sub === 'rm') {
        dockerRms.push(args);
        const name = args[args.length - 1];
        const m = name.match(/yj_autopost_vpn_(\d+)/);
        if (m) {
          const slot = Number(m[1]) - 1;
          slotStates[slot] = { ...(slotStates[slot] || {}), exists: false, running: false, healthy: false };
        }
        return { stdout: `${name}\n`, stderr: '' };
      }

      if (sub === 'exec') {
        dockerExecs.push(args);
        if (execError) {
          const err = typeof execError === 'function' ? await execError(args) : execError;
          if (err) throw err;
        }
        const name = args[1];
        const m = name.match(/yj_autopost_vpn_(\d+)/);
        const slot = m ? Number(m[1]) - 1 : 0;
        if (args.includes('connect')) {
          const nextIp = rotatedIps[rotateCounter % rotatedIps.length];
          rotateCounter++;
          slotStates[slot] = { ...(slotStates[slot] || {}), exitIp: nextIp };
          return { stdout: `Connected to United States\n`, stderr: '' };
        }
        if (args.includes('status')) {
          return { stdout: `Status: Connected\nHostname: us9999.nordvpn.com\n`, stderr: '' };
        }
        return { stdout: 'ok\n', stderr: '' };
      }
    }

    return { stdout: '', stderr: '' };
  };

  return {
    command,
    calls,
    dockerRuns,
    dockerRms,
    dockerStarts,
    dockerExecs,
    curlCalls,
    slotStates
  };
}

function createFakeDockerVpn({
  store,
  serverIp = '8.8.8.8',
  ...cmdOptions
} = {}) {
  const spy = createFakeDockerCommand(cmdOptions);
  const runtime = createDockerRuntime({
    command: spy.command,
    wait: async () => {},
    now: () => Date.now(),
    tokenFileValidator: async (f) => f || '/tmp/fake_token',
    serverIp
  });
  const manager = store ? new VpnSlotManager({ store, runtime }) : null;
  return {
    ...spy,
    runtime,
    manager
  };
}

module.exports = {
  AUTHORIZED_CONTAINERS,
  DEFAULT_SLOT_IPS,
  createFakeDockerCommand,
  createFakeDockerVpn
};
