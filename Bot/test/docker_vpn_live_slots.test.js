'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const {
  createDockerRuntime,
  slotPort,
  containerName,
  MAX_SLOTS
} = require('../src/dockerVpn');
const { isPublicIp } = require('../src/publicIp');

const KNOWN_HOST_SERVER_IP = '64.112.42.39';

const IP_SERVICES = [
  'https://api.ipify.org',
  'https://icanhazip.com',
  'https://ifconfig.me/ip'
];

function curlCommand(args, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const proc = spawn('curl', args);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`curl timed out after ${timeoutMs}ms: curl ${args.join(' ')}`));
    }, timeoutMs);

    proc.stdout.on('data', chunk => { stdout += chunk; });
    proc.stderr.on('data', chunk => { stderr += chunk; });
    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`curl exited with code ${code}: ${stderr.trim()}`));
    });
    proc.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function probeSocks5ExitIp(port, retries = 2) {
  for (const service of IP_SERVICES) {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const out = await curlCommand([
          '--noproxy', '',
          '--socks5-hostname', `127.0.0.1:${port}`,
          '--ipv4',
          '--fail',
          '--max-time', '8',
          '--silent',
          service
        ]);
        const ip = out.trim();
        if (isPublicIp(ip)) {
          return ip;
        }
      } catch {
        // Try next attempt or next service
      }
    }
  }
  throw new Error(`Failed to retrieve public IP through SOCKS5 proxy on port ${port}`);
}

async function getDirectHostIp() {
  for (const service of IP_SERVICES) {
    try {
      const out = await curlCommand(['--ipv4', '--fail', '--max-time', '5', '--silent', service]);
      const ip = out.trim();
      if (isPublicIp(ip)) {
        return ip;
      }
    } catch {}
  }
  return KNOWN_HOST_SERVER_IP;
}

describe('Docker VPN 5-Slot Live Infrastructure & Host IP Zero Leak Gate', () => {
  const runtime = createDockerRuntime();

  test('1. All 5 Docker VPN containers (yj_autopost_vpn_1 through 5) are running and healthy', async () => {
    for (let slot = 0; slot < MAX_SLOTS; slot++) {
      const status = await runtime.containerStatus(slot);
      const name = containerName(slot);

      assert.strictEqual(status.exists, true, `Container ${name} must exist`);
      assert.strictEqual(status.running, true, `Container ${name} must be in running state`);
      assert.strictEqual(status.healthy, true, `Container ${name} health status must be healthy`);
      assert.strictEqual(status.healthStatus, 'healthy');
      assert.strictEqual(status.owned, true, `Container ${name} must have owner label io.yj-autopost.owner`);
      assert.strictEqual(status.compatible, true, `Container ${name} image and contract must be compatible`);
    }
  });

  test('2. SOCKS5 proxy on ports 18801-18805 returns valid public IP with zero host IP leak', async () => {
    const hostIp = await getDirectHostIp();
    assert.ok(isPublicIp(hostIp), `Must obtain valid public host IP (got ${hostIp})`);

    const slotResults = [];

    for (let slot = 0; slot < MAX_SLOTS; slot++) {
      const port = slotPort(slot);
      const name = containerName(slot);

      const exitIp = await probeSocks5ExitIp(port);

      assert.ok(exitIp, `Port ${port} (${name}) must return an exit IP`);
      assert.ok(
        isPublicIp(exitIp),
        `Port ${port} exit IP (${exitIp}) must be a valid public non-private IPv4 address`
      );

      // Strict Zero Host IP Leak Check
      assert.notStrictEqual(
        exitIp,
        hostIp,
        `LEAK DETECTED: Port ${port} exit IP matches live host IP ${hostIp}!`
      );
      assert.notStrictEqual(
        exitIp,
        KNOWN_HOST_SERVER_IP,
        `LEAK DETECTED: Port ${port} exit IP matches known host server IP ${KNOWN_HOST_SERVER_IP}!`
      );

      slotResults.push({ slot, port, name, exitIp });
    }

    assert.strictEqual(slotResults.length, 5, 'All 5 slots must return exit IPs');
  });

  test('3. All active 5 slots have pairwise distinct exit IPs', async () => {
    const exitIps = [];

    for (let slot = 0; slot < MAX_SLOTS; slot++) {
      const port = slotPort(slot);
      const exitIp = await probeSocks5ExitIp(port);
      exitIps.push(exitIp);
    }

    const uniqueIps = new Set(exitIps);
    assert.strictEqual(
      uniqueIps.size,
      MAX_SLOTS,
      `All 5 slots must have pairwise distinct exit IPs! Observed: ${exitIps.join(', ')}`
    );
  });

  test('4. dockerVpn runtime healthCheck returns healthy status for all 5 slots', async () => {
    for (let slot = 0; slot < MAX_SLOTS; slot++) {
      const check = await runtime.healthCheck(slot);
      assert.strictEqual(check.healthy, true, `Slot ${slot} healthCheck must be healthy (got: ${JSON.stringify(check)})`);
      assert.ok(isPublicIp(check.exitIp), `Slot ${slot} must return verified exitIp`);
      assert.strictEqual(check.port, slotPort(slot));
      assert.strictEqual(check.name, containerName(slot));
    }
  });

});
