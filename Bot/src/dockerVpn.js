'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { isPublicIp } = require('./publicIp');
const { normalizeAccountId } = require('./accounts');

const exec = promisify(execFile);
const BASE_PORT = 18801;
const MAX_SLOTS = 5;
const MAX_HOST_NORDVPN_CONTAINERS = 7;
const CONTAINER_PREFIX = 'yj_autopost_vpn_';
const DEFAULT_VPN_VERSION = '6.0.2';
const PINNED_VPN_IMAGE = `yj_autopost_vpn_image:${DEFAULT_VPN_VERSION}`;
const VPN_IMAGE = process.env.VPN_IMAGE || PINNED_VPN_IMAGE;
const OWNER = 'yj-autopost';
const CONTRACT = 'independent-v1';
const TOKEN_TARGET = '/run/secrets/nordvpn_token';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Race only the caller's wait; the serialized writer keeps its lock until work settles.
async function abortable(work, signal) {
  signal?.throwIfAborted();
  if (!signal) return work();
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }), cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

/**
 * Deduplicates concurrent in-flight async operations under one shared AbortController.
 * Cancelling an individual caller's signal detaches only that waiter; the underlying
 * controller aborts only when active waiters reach zero.
 */
function joinRefcountedFlight(flights, key, factory, { signal, reuseExisting = true } = {}) {
  signal?.throwIfAborted();
  let flight = reuseExisting ? flights.get(key) : null;
  if (!flight) {
    const controller = new AbortController();
    const entry = { controller, waiters: 0, promise: null };
    entry.promise = Promise.resolve()
      .then(() => factory(controller.signal))
      .finally(() => {
        if (flights.get(key) === entry) flights.delete(key);
      });
    entry.promise.catch(() => {});
    if (reuseExisting || !flights.has(key)) {
      flights.set(key, entry);
    }
    flight = entry;
  }
  flight.waiters++;
  let settled = false;
  let onAbort;
  const detachWaiter = () => {
    if (settled) return;
    settled = true;
    signal?.removeEventListener('abort', onAbort);
    flight.waiters = Math.max(0, flight.waiters - 1);
    if (flight.waiters === 0) {
      if (flights.get(key) === flight) flights.delete(key);
      flight.controller.abort(signal?.reason || new Error('Aborted'));
    }
  };
  return new Promise((resolve, reject) => {
    onAbort = () => {
      const reason = signal.reason;
      detachWaiter();
      reject(reason);
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    flight.promise.then(
      val => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        flight.waiters = Math.max(0, flight.waiters - 1);
        resolve(val);
      },
      err => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        flight.waiters = Math.max(0, flight.waiters - 1);
        reject(err);
      }
    );
  });
}
const EXIT_IP_SERVICES = Object.freeze([
  'https://api.ipify.org',
  'https://icanhazip.com',
  'https://ifconfig.me/ip'
]);

function slotPort(slot) {
  if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_SLOTS) throw new Error('VPN slot out of range 0-4');
  return BASE_PORT + slot;
}
function containerName(slot) { slotPort(slot); return `${CONTAINER_PREFIX}${slot + 1}`; }

function normalizeSlotIndex(slot) {
  if (slot === null || slot === undefined || typeof slot === 'boolean' || (typeof slot === 'string' && !slot.trim())) {
    throw Object.assign(new Error(`VPN slot ${slot} out of range 0-${MAX_SLOTS - 1}`), { code: 'VPN_SLOT_OUT_OF_RANGE', slot });
  }
  const num = Number(slot);
  if (!Number.isInteger(num) || num < 0 || num >= MAX_SLOTS) {
    throw Object.assign(new Error(`VPN slot ${slot} out of range 0-${MAX_SLOTS - 1}`), { code: 'VPN_SLOT_OUT_OF_RANGE', slot });
  }
  return num;
}

function isNordVpnClientContainer(name, image = '') {
  const n = String(name || '').replace(/^\//, '').trim();
  const img = String(image || '').trim();
  if (n.endsWith('-socks') || img.includes('-socks') || n.includes('socks-')) return false;
  if (n === 'cryptovpn-nordvpn' || n === 'yjdownloadvideo-nordvpn-1') return true;
  if (/^yj_autopost_vpn_[1-5]$/.test(n)) return true;
  if (/nordvpn/i.test(n) || /nordvpn/i.test(img) || /^yj_autopost_vpn_/.test(n)) return true;
  return false;
}

function normalizeVpnSlots(rawSlots) {
  if (!rawSlots || typeof rawSlots !== 'object') return {};
  const normalized = {};
  const seenSlots = new Map();
  for (const [rawId, rawSlot] of Object.entries(rawSlots)) {
    let accountId;
    try {
      accountId = normalizeAccountId(rawId);
    } catch {
      throw Object.assign(new Error(`Invalid account id in VPN slots: ${rawId}`), { code: 'VPN_MAPPING_CONFLICT', accountId: rawId });
    }
    const slot = Number(rawSlot);
    if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_SLOTS) {
      throw Object.assign(new Error(`VPN slot ${rawSlot} for account ${accountId} out of range 0-${MAX_SLOTS - 1}`), { code: 'VPN_MAPPING_CONFLICT', accountId, slot: rawSlot });
    }
    if (seenSlots.has(slot)) {
      throw Object.assign(
        new Error(`Duplicate VPN slot ${slot} assigned to both ${seenSlots.get(slot)} and ${accountId}`),
        { code: 'VPN_MAPPING_CONFLICT', slot, accounts: [seenSlots.get(slot), accountId] }
      );
    }
    seenSlots.set(slot, accountId);
    normalized[accountId] = slot;
  }
  return normalized;
}

function isCompatibleVpnImage(img) {
  if (typeof img !== 'string') return false;
  const trimmed = img.trim();
  if (!trimmed || trimmed.endsWith(':latest')) return false;
  return trimmed === PINNED_VPN_IMAGE;
}

async function validateTokenFile(file) {
  if (!file || !path.isAbsolute(file) || /[,\n\r]/.test(file)) {
    throw new Error('Set NORDVPN_TOKEN_FILE to an absolute, private token file path');
  }
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
      ![0, process.getuid?.()].includes(stat.uid) || stat.size < 1 || stat.size > 4096) {
    throw new Error('VPN token file must be a private regular file (0600 or 0400), owned by the service user or root');
  }
  return file;
}

/** Dependency injection keeps tests away from the real Docker daemon and credentials. */
function createDockerRuntime({
  command = exec,
  wait = sleep,
  now = Date.now,
  tokenFileValidator = validateTokenFile,
  serverIp: initialServerIp = null,
  networkInterfaces = () => os.networkInterfaces(),
  allowContainerCreate: defaultAllowContainerCreate = false,
  healthCacheTtlMs = 10_000,
  unhealthyCacheTtlMs = 3_000,
  teardownWaitMs = (process.env.NODE_ENV === 'test' || process.env.YJ_TEST_MODE === '1') ? 0 : 30000
} = {}) {
  let cachedServerIp = (initialServerIp && isPublicIp(String(initialServerIp).trim()))
    ? String(initialServerIp).trim()
    : null;
  const healthCache = new Map();
  const healthFlights = new Map();
  function invalidateHealthCache(slot) {
    if (slot == null) {
      healthCache.clear();
      healthFlights.clear();
      return;
    }
    healthCache.delete(slot);
    healthFlights.delete(slot);
  }

  async function execCommand(args, timeout = 15_000, { signal } = {}) {
    signal?.throwIfAborted();
    try {
      const result = await command('docker', args, { timeout, maxBuffer: 1024 * 1024, signal });
      signal?.throwIfAborted();
      return result;
    } catch (err) {
      signal?.throwIfAborted();
      const combined = `${err?.message || ''} ${err?.stderr || ''} ${err?.stdout || ''}`;
      if (/Too many connection attempts/i.test(combined)) {
        throw Object.assign(
          new Error(`VPN Docker ${args[0]} failed: Too many connection attempts`),
          { code: 'VPN_PROVIDER_RATE_LIMIT', providerError: 'RATE_LIMIT' }
        );
      }
      if (/Session Limit Reached|maximum number of devices|device limit/i.test(combined)) {
        throw Object.assign(
          new Error(`VPN Docker ${args[0]} failed: Session Limit Reached`),
          { code: 'VPN_PROVIDER_SESSION_LIMIT', providerError: 'SESSION_LIMIT' }
        );
      }
      throw new Error(`VPN Docker ${args[0]} failed`); // Never relay Docker inspect/env or raw command stderr.
    }
  }
  const docker = execCommand;

  async function containerStatus(slot, { signal } = {}) {
    const name = containerName(slot);
    signal?.throwIfAborted();
    try {
      const { stdout } = await docker(['container', 'inspect', name], 15_000, { signal });
      const [info] = JSON.parse(stdout);
      const labels = info.Config?.Labels || {};
      const img = info.Config?.Image || '';
      const imageCompatible = isCompatibleVpnImage(img);
      return {
        exists: true, running: info.State?.Running === true, status: info.State?.Status,
        healthy: info.State?.Health?.Status === 'healthy', healthStatus: info.State?.Health?.Status || null,
        owned: labels['io.yj-autopost.owner'] === OWNER && labels['io.yj-autopost.slot'] === String(slot),
        compatible: labels['io.yj-autopost.contract'] === CONTRACT && imageCompatible,
        name
      };
    } catch {
      signal?.throwIfAborted();
      // Distinguish an absent container from an inaccessible daemon before any run/removal.
      const { stdout } = await docker(['container', 'ls', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Names}}'], 15_000, { signal });
      if (stdout.trim()) throw new Error(`Cannot inspect VPN container ${name}`);
      return { exists: false, running: false, healthy: false, name };
    }
  }
  async function getExitIp(port, { signal } = {}) {
    if (!Number.isInteger(port) || port < BASE_PORT || port >= BASE_PORT + MAX_SLOTS) throw new Error('VPN proxy port out of range');
    signal?.throwIfAborted();
    for (const serviceUrl of EXIT_IP_SERVICES) {
      for (let attempt = 0; attempt < 2; attempt++) {
        signal?.throwIfAborted();
        try {
          const { stdout } = await command('curl', ['--noproxy', '', '--socks5-hostname', `127.0.0.1:${port}`,
            '--ipv4', '--fail', '--max-time', '10', '--silent', serviceUrl], { timeout: 12_000, signal });
          signal?.throwIfAborted();
          const ip = stdout.trim();
          if (isPublicIp(ip)) return ip;
        } catch {
          signal?.throwIfAborted();
          if (attempt === 0) await abortable(() => wait(500), signal);
        }
      }
    }
    return null;
  }
  async function getServerIp() {
    if (cachedServerIp) return cachedServerIp;

    // 1. Check configured process.env.SERVER_IP || process.env.HOST_DIRECT_IP or config()
    let configuredIp = (process.env.SERVER_IP || process.env.HOST_DIRECT_IP || '').trim();
    if (!configuredIp) {
      try {
        const { config } = require('./env');
        const envConf = config();
        if (envConf) {
          if (typeof envConf.SERVER_IP === 'string') {
            configuredIp = envConf.SERVER_IP.trim();
          } else if (typeof envConf.HOST_DIRECT_IP === 'string') {
            configuredIp = envConf.HOST_DIRECT_IP.trim();
          }
        }
      } catch {}
    }
    if (configuredIp && isPublicIp(configuredIp)) {
      cachedServerIp = configuredIp;
      return cachedServerIp;
    }

    // 2. Check local network interfaces for a public IPv4 address (no outbound curl fallback)
    try {
      const interfaces = networkInterfaces();
      for (const iface of Object.values(interfaces || {})) {
        for (const net of iface || []) {
          if ((net.family === 'IPv4' || net.family === 4) && !net.internal && isPublicIp(net.address)) {
            cachedServerIp = net.address;
            return cachedServerIp;
          }
        }
      }
    } catch {}

    return null;
  }
  async function _runHealthCheckUncached(slot, { signal } = {}) {
    const port = slotPort(slot);
    signal?.throwIfAborted();
    let status;
    try { status = await containerStatus(slot, { signal }); } catch { signal?.throwIfAborted(); return { healthy: false, reason: 'docker_unavailable' }; }
    if (!status.running) return { healthy: false, reason: 'container_not_running', name: status.name };
    if (!status.owned || !status.compatible) return { healthy: false, reason: 'image_migration_required', name: status.name };
    if (!status.healthy) return { healthy: false, reason: 'container_not_healthy', name: status.name };
    const exitIp = await getExitIp(port, { signal });
    signal?.throwIfAborted();
    if (!exitIp) return { healthy: false, reason: 'proxy_unreachable', name: status.name };
    const serverIp = await getServerIp();
    signal?.throwIfAborted();
    if (!serverIp) return { healthy: false, reason: 'server_ip_unavailable' };
    if (exitIp === serverIp) return { healthy: false, reason: 'ip_leak_detected' };
    return { healthy: true, exitIp, name: status.name, port };
  }
  async function healthCheck(slot, { signal, force = false } = {}) {
    slotPort(slot);
    signal?.throwIfAborted();
    if (!force) {
      const cached = healthCache.get(slot);
      if (cached && now() < cached.expiresAt) {
        return { ...cached.result };
      }
    }
    const result = await joinRefcountedFlight(
      healthFlights,
      slot,
      async sharedSignal => {
        const res = await _runHealthCheckUncached(slot, { signal: sharedSignal });
        const ttl = res.healthy ? healthCacheTtlMs : unhealthyCacheTtlMs;
        if (ttl > 0) {
          healthCache.set(slot, { result: { ...res }, expiresAt: now() + ttl });
        }
        return res;
      },
      { signal, reuseExisting: !force }
    );
    return { ...result };
  }
  async function verifyPersistentVolumesExist(name) {
    for (const volumeName of [`${name}_state`, `${name}_auth`]) {
      try {
        const { stdout } = await docker(['volume', 'inspect', volumeName]);
        const parsed = JSON.parse(stdout || '[]');
        if (!Array.isArray(parsed) || parsed.length === 0) {
          throw new Error('Volume missing');
        }
      } catch {
        throw Object.assign(
          new Error(`Persistent NordVPN volume ${volumeName} does not exist; refusing container creation to protect 7-container device limit`),
          { code: 'VPN_VOLUME_MISSING', volumeName }
        );
      }
    }
    return true;
  }
  async function verifyHostContainerCap(name = null, { signal } = {}) {
    signal?.throwIfAborted();
    const { stdout } = await docker(['ps', '-a', '--format', '{{.Names}}\t{{.Image}}'], 15_000, { signal });
    signal?.throwIfAborted();
    const lines = String(stdout || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const nordContainers = lines.filter(line => {
      const [cName, cImg] = line.split('\t');
      return isNordVpnClientContainer(cName, cImg);
    });
    const targetName = name ? String(name).replace(/^\//, '') : null;
    const alreadyPresent = targetName && nordContainers.some(l => l.split('\t')[0].replace(/^\//, '') === targetName);
    const effectiveCount = alreadyPresent ? nordContainers.length : nordContainers.length + (targetName ? 1 : 0);

    if (nordContainers.length > MAX_HOST_NORDVPN_CONTAINERS || effectiveCount > MAX_HOST_NORDVPN_CONTAINERS) {
      throw Object.assign(
        new Error(`Host-wide NordVPN container cap (${nordContainers.length}/${MAX_HOST_NORDVPN_CONTAINERS}) exceeded${name ? `; refusing to create ${name}` : ''}`),
        { code: 'VPN_CONTAINER_CAP_EXCEEDED', count: nordContainers.length, max: MAX_HOST_NORDVPN_CONTAINERS }
      );
    }
    return { count: nordContainers.length, max: MAX_HOST_NORDVPN_CONTAINERS };
  }
  async function checkHostCapCompliance({ signal } = {}) {
    signal?.throwIfAborted();
    const { stdout } = await docker(['ps', '-a', '--format', '{{.Names}}\t{{.Image}}\t{{.Status}}'], 15_000, { signal });
    signal?.throwIfAborted();
    const lines = String(stdout || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const clients = [];
    const helpers = [];
    for (const line of lines) {
      const [cName, cImg, cStatus] = line.split('\t');
      if (isNordVpnClientContainer(cName, cImg)) {
        clients.push({ name: cName, image: cImg, status: cStatus });
      } else if (/socks/i.test(cName) || /socks/i.test(cImg)) {
        helpers.push({ name: cName, image: cImg, status: cStatus });
      }
    }
    return {
      compliant: clients.length <= MAX_HOST_NORDVPN_CONTAINERS,
      clientCount: clients.length,
      maxAllowed: MAX_HOST_NORDVPN_CONTAINERS,
      clients,
      helpers
    };
  }
  async function reconnectContainer(slot, { country = 'United_States', signal } = {}) {
    slotPort(slot);
    const name = containerName(slot);
    const port = slotPort(slot);
    signal?.throwIfAborted();
    invalidateHealthCache(slot);
    const status = await containerStatus(slot, { signal });
    signal?.throwIfAborted();
    if (!status.exists) {
      throw Object.assign(new Error(`VPN container ${name} does not exist`), { code: 'VPN_CONTAINER_NOT_FOUND', name, slot });
    }
    if (!status.running) {
      await verifyPersistentVolumesExist(name);
      await verifyHostContainerCap(name, { signal });
      await docker(['start', name], 30_000, { signal });
    } else {
      // In-place reconnect via WireGuard tunnel; zero device registration
      try {
        await docker(['exec', name, 'nordvpn', 'connect', country], 25_000, { signal });
      } catch (err) {
        if (/Too many connection attempts/i.test(err?.message || '')) {
          throw Object.assign(err, { code: 'VPN_PROVIDER_RATE_LIMIT' });
        }
        throw err;
      }
    }
    invalidateHealthCache(slot);
    signal?.throwIfAborted();
    const check = await healthCheck(slot, { signal, force: true });
    return {
      slot,
      name,
      port,
      proxy: `socks5h://127.0.0.1:${port}`,
      healthy: Boolean(check.healthy),
      exitIp: check.exitIp || null,
      reason: check.reason || null
    };
  }
  async function ensureContainer(slot, {
    tokenFile = process.env.NORDVPN_TOKEN_FILE,
    token,
    country = 'United_States',
    logger = () => {},
    readyTimeoutMs = 180_000,
    allowContainerCreate = defaultAllowContainerCreate,
    signal
  } = {}) {
    signal?.throwIfAborted();
    const name = containerName(slot), port = slotPort(slot);
    const status = await containerStatus(slot, { signal });
    signal?.throwIfAborted();
    if (status.exists && (!status.owned || !status.compatible)) {
      throw new Error(`VPN image migration required for ${name}; operator must replace it explicitly`);
    }
    if (!status.exists) {
      // Legacy allow flags cannot authorize a new NordVPN fingerprint. Only an
      // operator can replace a missing slot after account-dashboard cleanup.
      throw Object.assign(new Error(`VPN container ${name} is missing; automatic creation is forbidden`), { code: 'VPN_CONTAINER_CREATE_FORBIDDEN' });
    } else if (!status.running) {
      // Host cap and persistent volume verification before starting
      await verifyPersistentVolumesExist(name);
      await verifyHostContainerCap(name, { signal });
      // Preserve the container identity, volumes and secret mount on cold recovery.
      await docker(['start', name], 30_000, { signal });
      invalidateHealthCache(slot);
    }
    const deadline = now() + readyTimeoutMs;
    let attempt = 0;
    do {
      signal?.throwIfAborted();
      const check = await healthCheck(slot, { signal, force: attempt > 0 });
      attempt++;
      signal?.throwIfAborted();
      if (check.healthy) {
        logger(`VPN container ${name} ready on port ${port}`);
        return { name, port, proxy: `socks5h://127.0.0.1:${port}`, reused: status.exists, exitIp: check.exitIp };
      }
      if (check.reason === 'container_not_running' || check.reason === 'image_migration_required') {
        throw new Error(`VPN ${name} not ready: ${check.reason}`);
      }
      await abortable(() => wait(2000), signal);
    } while (now() < deadline);
    throw new Error(`VPN ${name} did not become healthy before readiness deadline`);
  }
  async function destroyContainer(slot, options = {}) {
    invalidateHealthCache(slot);
    const status = await containerStatus(slot);
    if (!status.exists) return { removed: true, absent: true, name: status.name };
    // Even a known name is not proof of ownership. No automatic removal of legacy/unlabelled containers.
    if (!status.owned) throw new Error(`Refusing to remove unowned VPN container ${status.name}`);
    const waitMs = options.teardownWaitMs !== undefined
      ? options.teardownWaitMs
      : (this && typeof this.teardownWaitMs === 'number' ? this.teardownWaitMs : teardownWaitMs);
    if (status.running) {
      await docker(['exec', status.name, 'nordvpn', 'disconnect'], 15_000).catch(() => {});
      if (waitMs > 0) {
        await wait(waitMs);
        if (wait !== sleep && waitMs <= 500) {
          await new Promise(r => setTimeout(r, waitMs));
        }
      }
    }
    await docker(['rm', '-f', status.name]); // No -v: identity/session volumes intentionally survive.
    invalidateHealthCache(slot);
    return { removed: true, name: status.name };
  }
  function normalizeSubnet(ip) {
    if (!ip || typeof ip !== 'string') return null;
    const parts = ip.split('/')[0].trim().split('.');
    return parts.length >= 3 ? `${parts[0]}.${parts[1]}.${parts[2]}` : null;
  }
  async function rotateContainerIp(slot, {
    blacklistedSubnets = [],
    activeSubnets = [],
    preferredCities = ['New_York', 'Los_Angeles', 'Chicago', 'Dallas', 'Miami', 'Atlanta', 'Seattle', 'Denver', 'Phoenix', 'Ashburn'],
    maxAttempts = 4,
    previousIp = null,
    logger = () => {}
  } = {}) {
    const name = containerName(slot);
    const port = slotPort(slot);
    const status = await containerStatus(slot);
    if (!status.exists || !status.running) {
      return { success: false, reason: 'container_not_running', name, slot, port };
    }
    const blacklisted = new Set(blacklistedSubnets.map(normalizeSubnet).filter(Boolean));
    const active = new Set(activeSubnets.map(normalizeSubnet).filter(Boolean));
    let lastError = null;
    let newExitIp = null;
    let newSubnet = null;
    let providerRateLimited = false;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      invalidateHealthCache(slot);
      const city = preferredCities[attempt % preferredCities.length];
      logger(`Rotating IP for slot ${slot} (${name}) to ${city} (attempt ${attempt + 1}/${maxAttempts})...`);
      try {
        await docker(['exec', name, 'nordvpn', 'connect', city], 25_000);
        invalidateHealthCache(slot);
        await wait(2000);
        newExitIp = await getExitIp(port);
        if (!newExitIp) {
          lastError = 'proxy_unreachable_after_connect';
          continue;
        }
        newSubnet = normalizeSubnet(newExitIp);
        if (previousIp && newExitIp === previousIp) {
          lastError = 'ip_unchanged';
          continue;
        }
        if (blacklisted.has(newSubnet)) {
          lastError = `subnet_blacklisted:${newSubnet}`;
          continue;
        }
        if (active.has(newSubnet)) {
          lastError = `subnet_clustered:${newSubnet}`;
          continue;
        }
        try {
          const { stdout: serverOut } = await docker(['exec', name, 'nordvpn', 'status']);
          const match = serverOut.match(/^Hostname:[ \t]*([^\r\n]+)[ \t]*$/im);
          const hostname = match?.[1]?.trim();
          if (hostname && hostname.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+nordvpn\.com$/i.test(hostname)) {
            await docker(['exec', name, 'sh', '-c', `printf '%s\\n' "${hostname}" > /var/lib/nordvpn/yj-server`]);
          }
        } catch {}

        return {
          success: true,
          slot,
          name,
          port,
          exitIp: newExitIp,
          subnet: `${newSubnet}.0/24`,
          city,
          attempt: attempt + 1
        };
      } catch (err) {
        lastError = err.message || 'docker_exec_failed';
        if (
          err.code === 'VPN_PROVIDER_RATE_LIMIT' ||
          err.code === 'VPN_PROVIDER_SESSION_LIMIT' ||
          (typeof lastError === 'string' && (lastError.includes('Too many connection attempts') || lastError.includes('Session Limit Reached')))
        ) {
          providerRateLimited = true;
          logger(`Rate limit detected from VPN provider (${lastError}); halting rotation early`);
          break;
        }
        await wait(1000);
      }
    }
    if (!providerRateLimited) {
      try {
        const exitCheck = await getExitIp(port);
        if (!exitCheck) {
          await docker(['exec', name, 'nordvpn', 'connect', 'United_States'], 25_000).catch(() => {});
        }
      } catch {}
    }

    return {
      success: false,
      reason: lastError || 'rotation_exhausted',
      slot,
      name,
      port,
      exitIp: newExitIp,
      subnet: newSubnet ? `${newSubnet}.0/24` : null
    };
  }
  return {
    execCommand,
    containerStatus,
    getExitIp,
    getServerIp,
    healthCheck,
    invalidateHealthCache,
    ensureContainer,
    destroyContainer,
    rotateContainerIp,
    normalizeSubnet,
    isCompatibleVpnImage,
    testSocksProxy: async port => Boolean(await getExitIp(port)),
    verifyPersistentVolumesExist,
    verifyHostContainerCap,
    checkHostCapCompliance,
    reconnectContainer,
    setServerIp: ip => { cachedServerIp = (ip && isPublicIp(String(ip).trim())) ? String(ip).trim() : null; },
    getCachedServerIp: () => cachedServerIp,
    clearCachedServerIp: () => { cachedServerIp = null; }
  };
}
const runtime = createDockerRuntime();

/** All operations through one manager serialize allocation/removal so a slot is not reused mid-release. */
class VpnSlotManager {
  constructor({
    store,
    logger = () => {},
    runtime: suppliedRuntime = runtime,
    allowContainerCreate = false,
    teardownWaitMs = (process.env.NODE_ENV === 'test' || process.env.YJ_TEST_MODE === '1') ? 0 : 30000
  } = {}) {
    if (!store) throw new Error('VpnSlotManager requires a store');
    this.store = store;
    this.logger = logger;
    this.runtime = suppliedRuntime;
    this.allowContainerCreate = allowContainerCreate === true;
    this.teardownWaitMs = teardownWaitMs;
    this.pending = Promise.resolve();
    this.readers = new Set();
    this.routeFlights = new Map();
  }
  _holdReader(slot, accountId) {
    let resolve;
    const held = new Promise(r => { resolve = r; });
    held.slot = slot;
    held.accountId = accountId;
    this.readers.add(held);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.readers.delete(held);
      resolve();
    };
  }
  async _waitSlotReaders(slot) {
    const slotReaders = [...this.readers].filter(r => r.slot === slot);
    await Promise.all(slotReaders);
  }
  _admit(fn) {
    const work = this.pending.then(fn);
    this.pending = work.catch(() => {});
    return work;
  }
  _exclusive(fn) {
    return this._admit(async () => {
      await Promise.all([...this.readers]);
      return fn();
    });
  }
  drainReaders(slot = null) {
    if (slot != null) {
      slotPort(slot);
      return this._waitSlotReaders(slot);
    }
    return Promise.all([...this.readers]);
  }
  async destroyContainer(slot, options = {}) {
    slotPort(slot);
    await this._waitSlotReaders(slot);
    return this.runtime.destroyContainer(slot, { teardownWaitMs: this.teardownWaitMs, ...options });
  }
  async acquireReadRoute(accountId, { signal, allowFallback = false } = {}) {
    signal?.throwIfAborted();
    const id = normalizeAccountId(accountId);
    const wait = async work => {
      signal?.throwIfAborted();
      let abort;
      const cancelled = new Promise((_, reject) => { abort = () => reject(signal.reason); signal?.addEventListener('abort', abort, { once: true }); });
      try { return await Promise.race([work, cancelled]); }
      finally { signal?.removeEventListener('abort', abort); }
    };
    let release, slot;
    const admitted = this._admit(async () => {
      signal?.throwIfAborted();
      const slots = await this._slots();
      slot = Object.hasOwn(slots, id) ? slots[id] : null;
      if (slot == null) {
        if (!allowFallback) throw Object.assign(new Error('VPN route absent'), { code: 'VPN_NOT_READY' });
        const used = new Set(Object.values(slots));
        const freeSlot = Array.from({ length: MAX_SLOTS }, (_, i) => i).find(i => !used.has(i));
        slot = freeSlot != null ? freeSlot : 0;
      }
      release = this._holdReader(slot, id);
    });
    try {
      await wait(admitted);
      let health = await wait(Promise.resolve().then(() => { signal?.throwIfAborted(); return this.runtime.healthCheck(slot, { signal }); }));
      if (!health.healthy && allowFallback) {
        for (let s = 0; s < MAX_SLOTS; s++) {
          if (s === slot) continue;
          try {
            const altHealth = await wait(Promise.resolve().then(() => { signal?.throwIfAborted(); return this.runtime.healthCheck(s, { signal }); }));
            if (altHealth.healthy) {
              release?.();
              slot = s;
              release = this._holdReader(slot, id);
              health = altHealth;
              break;
            }
          } catch {}
        }
      }
      if (!health.healthy) throw Object.assign(new Error('VPN route not ready'), { code: 'VPN_NOT_READY' });
      return { ...health, slot, proxy: `socks5h://127.0.0.1:${slotPort(slot)}`, release };
    } catch (error) { release?.(); throw error; }
  }
  async _rawSlots() {
    let rawSlots = null;
    if (typeof this.store.readVpnSlots === 'function') {
      try { rawSlots = await this.store.readVpnSlots(); } catch {}
    } else if (this.store.pool?.query) {
      try {
        const res = await this.store.pool.query('SELECT account_id, slot_index FROM vpn_slots ORDER BY slot_index');
        if (res?.rows && res.rows.length > 0) {
          rawSlots = Object.fromEntries(res.rows.map(r => [r.account_id, Number(r.slot_index)]));
        }
      } catch {}
    }
    if (!rawSlots) {
      const state = await this.store.load();
      rawSlots = state?.vpnSlots || {};
    }
    return rawSlots && typeof rawSlots === 'object' ? rawSlots : {};
  }
  async _slots() { return normalizeVpnSlots(await this._rawSlots()); }
  async _allocate(accountId, { signal } = {}) {
    signal?.throwIfAborted();
    const id = normalizeAccountId(accountId);
    let slot;
    await this.store.update(state => {
      signal?.throwIfAborted();
      slot = null;
      state.vpnSlots ||= {};
      const normalizedSlots = {};
      const usedSlots = new Map();
      for (const [key, val] of Object.entries(state.vpnSlots)) {
        const normKey = normalizeAccountId(key);
        const normVal = normalizeSlotIndex(val);
        if (usedSlots.has(normVal)) {
          throw Object.assign(new Error('Duplicate VPN slots require reconciliation'), { code: 'VPN_MAPPING_CONFLICT' });
        }
        usedSlots.set(normVal, normKey);
        normalizedSlots[normKey] = normVal;
      }
      state.vpnSlots = normalizedSlots;
      if (Object.hasOwn(state.vpnSlots, id)) { slot = state.vpnSlots[id]; return state; }
      const used = new Set(Object.values(state.vpnSlots));
      slot = Array.from({ length: MAX_SLOTS }, (_, i) => i).find(i => !used.has(i));
      if (slot == null) {
        throw Object.assign(
          new Error('All five VPN slots are allocated; reconcile removed accounts first'),
          { code: 'VPN_SLOTS_EXHAUSTED' }
        );
      }
      state.vpnSlots[id] = slot;
      return state;
    });
    return slot;
  }
  allocate(accountId, options = {}) { return this._admit(() => this._allocate(accountId, options)); }
  async _release(accountId, { destroyContainer: shouldDestroy = false } = {}) {
    const id = normalizeAccountId(accountId);
    const raw = await this._rawSlots();
    const slot = Object.hasOwn(raw, id) ? Number(raw[id]) : null;
    if (slot == null) return null;
    normalizeSlotIndex(slot);
    await this._waitSlotReaders(slot);
    // Static 5-slot containers are persistent infrastructure: never run `docker rm -f`
    // during normal slot unbind or startup reconciliation unless explicitly requested.
    if (shouldDestroy === true && !Object.entries(raw).some(([other, value]) => other !== id && Number(value) === slot)) {
      const result = await this.runtime.destroyContainer(slot, { teardownWaitMs: this.teardownWaitMs });
      if (!result.removed) throw new Error('Failed to remove VPN container; reservation retained');
    }
    await this.store.update(state => {
      if (state.vpnSlots) delete state.vpnSlots[id];
      return state;
    });
    this.logger(`Released VPN slot ${slot}`);
    return slot;
  }
  release(accountId, options = {}) { return this._admit(() => this._release(accountId, options)); }
  /** Defaults to a read-only plan. Apply explicitly at startup/account-set replacement. */
  reconcile({ accountIds, dryRun = true } = {}) {
    return this._admit(async () => {
      const state = await this.store.load();
      const inventory = accountIds ?? (state.accounts || [])
        .filter(account => account?.enabled === true)
        .map(account => account.id);
      const active = new Set(inventory.map(normalizeAccountId));
      if (accountIds == null) {
        // Reconcile only the explicitly enabled account inventory by default.
        for (const accountId of [...active]) {
          const account = (state.accounts || []).find(item => item?.id === accountId);
          if (!account || account.enabled !== true) active.delete(accountId);
        }
      }
      const rawSlots = await this._rawSlots();
      const stale = [], conflicts = [], released = [];
      const seen = new Map();
      for (const [accountId, slot] of Object.entries(rawSlots)) {
        let normId;
        try {
          normId = normalizeAccountId(accountId);
        } catch {
          conflicts.push({ accountId, slot, reason: 'invalid_account_id' });
          continue;
        }
        if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_SLOTS) {
          conflicts.push({ accountId: normId, slot, reason: 'invalid_slot' });
        } else if (active.has(normId)) {
          if (seen.has(slot)) {
            conflicts.push({ accountId: normId, slot, conflictingAccount: seen.get(slot), reason: 'duplicate_active_slot' });
          } else {
            seen.set(slot, normId);
          }
        } else {
          stale.push({ accountId: normId, slot });
        }
      }
      if (!dryRun && conflicts.length) {
        throw Object.assign(new Error('Unsafe VPN mappings require operator repair'), { code: 'VPN_MAPPING_CONFLICT', conflicts });
      }
      if (!dryRun) {
        for (const entry of stale) {
          await this._release(entry.accountId, { destroyContainer: false });
          released.push(entry);
        }
        const currentSlots = await this._slots().catch(() => ({}));
        const used = new Set(Object.values(currentSlots));
        for (const accountId of active) {
          if (!Object.hasOwn(currentSlots, accountId) && used.size < MAX_SLOTS) {
            const freeSlot = Array.from({ length: MAX_SLOTS }, (_, i) => i).find(i => !used.has(i));
            if (freeSlot != null) {
              await this._allocate(accountId);
              used.add(freeSlot);
            }
          }
        }
      }
      return { dryRun, stale, conflicts, released };
    });
  }
  async validateRoute(accountId, { signal } = {}) {
    signal?.throwIfAborted();
    const id = normalizeAccountId(accountId);
    const slots = await this._slots();
    if (!Object.hasOwn(slots, id)) {
      return { valid: false, reason: 'no_slot_allocated', accountId: id, slot: null };
    }
    const slot = slots[id];
    slotPort(slot);
    const health = await this.runtime.healthCheck(slot, { signal });
    return {
      valid: Boolean(health.healthy),
      accountId: id,
      slot,
      port: slotPort(slot),
      proxy: `socks5h://127.0.0.1:${slotPort(slot)}`,
      ...health
    };
  }
  async validateRoutes({ accountIds, signal } = {}) {
    signal?.throwIfAborted();
    const slots = await this._slots();
    const targetIds = accountIds ? accountIds.map(normalizeAccountId) : Object.keys(slots);
    const results = {};
    let allValid = true;
    for (const id of targetIds) {
      signal?.throwIfAborted();
      const res = await this.validateRoute(id, { signal });
      results[id] = res;
      if (!res.valid) allValid = false;
    }
    return { valid: allValid, routes: results };
  }
  async reconnectSlot(slot, options = {}) {
    slotPort(slot);
    options.signal?.throwIfAborted();
    await abortable(() => this._waitSlotReaders(slot), options.signal);
    options.signal?.throwIfAborted();
    return this.runtime.reconnectContainer(slot, options);
  }
  async reconnectAccount(accountId, options = {}) {
    const id = normalizeAccountId(accountId);
    const slot = await this.getSlot(id);
    if (slot == null) {
      throw Object.assign(new Error(`No VPN slot allocated for account ${id}`), { code: 'VPN_NOT_READY' });
    }
    return this.reconnectSlot(slot, options);
  }
  async getSlot(accountId) {
    const slots = await this._slots();
    const slot = Object.hasOwn(slots, accountId) ? slots[accountId] : null;
    if (slot != null) slotPort(slot);
    return slot;
  }
  async getPort(accountId) { const slot = await this.getSlot(accountId); return slot == null ? null : slotPort(slot); }
  async getProxy(accountId) { const port = await this.getPort(accountId); return port == null ? null : `socks5h://127.0.0.1:${port}`; }
  async _ensure(accountId, options = {}) {
    options.signal?.throwIfAborted();
    const id = normalizeAccountId(accountId);
    let slot;
    let releaseTempReader = null;
    await abortable(() => this._admit(async () => {
      options.signal?.throwIfAborted();
      const state = await this.store.load();
      const account = (state.accounts || []).find(item => item?.id === id);
      const draft = Object.values(state.telegramUi?.users || {}).some(user => user?.draft?.id === id);
      if (!account || account.enabled !== true || account.draft === true || draft) {
        throw Object.assign(new Error('VPN dedicated route requires an enabled account'), { code: 'VPN_ACCOUNT_DISABLED' });
      }
      slot = await this._allocate(id, options);
      releaseTempReader = this._holdReader(slot, id);
    }), options.signal).catch(err => {
      releaseTempReader?.();
      throw err;
    });
    try {
      options.signal?.throwIfAborted();
      const allowContainerCreate = options.allowContainerCreate !== undefined
        ? options.allowContainerCreate === true
        : this.allowContainerCreate === true;
      const result = await this.runtime.ensureContainer(slot, { ...options, allowContainerCreate, logger: this.logger });
      options.signal?.throwIfAborted();
      return { ...result, slot };
    } finally {
      releaseTempReader?.();
    }
  }
  ensure(accountId, options = {}) {
    options.signal?.throwIfAborted();
    return abortable(async () => {
      await Promise.resolve();
      options.signal?.throwIfAborted();
      return this._ensure(accountId, options);
    }, options.signal);
  }
  acquireRoute(accountId, options = {}) {
    options.signal?.throwIfAborted();
    const id = normalizeAccountId(accountId);
    return (async () => {
      const outcome = await joinRefcountedFlight(
        this.routeFlights,
        id,
        async sharedSignal => {
          const flightOptions = { ...options, signal: sharedSignal };
          const result = await this._ensure(id, flightOptions);
          sharedSignal.throwIfAborted();
          let health = await this.runtime.healthCheck(result.slot, { signal: sharedSignal });
          sharedSignal.throwIfAborted();
          if (!health?.healthy && health?.reason === 'proxy_unreachable') {
            try {
              await abortable(() => this._waitSlotReaders(result.slot), sharedSignal);
              sharedSignal.throwIfAborted();
              this.logger(`Transient SOCKS/TCP disconnect on slot ${result.slot}; attempting in-place tunnel refresh...`);
              const rec = await this.runtime.reconnectContainer(result.slot, { signal: sharedSignal });
              if (rec.healthy) {
                health = rec;
              }
            } catch (err) {
              if (sharedSignal.aborted) throw err;
            }
          }
          if (!health?.healthy) throw Object.assign(new Error('VPN route not ready'), { code: 'VPN_NOT_READY' });
          return { ...result, ...health, healthy: true, slot: result.slot };
        },
        { signal: options.signal }
      );
      options.signal?.throwIfAborted();
      return {
        ...outcome,
        proxy: `socks5h://127.0.0.1:${slotPort(outcome.slot)}`,
        release: this._holdReader(outcome.slot, id)
      };
    })();
  }
  /** Serialize Main's existing account policy mutation with mapping writers. */
  withMappingMutation(mutator) {
    if (typeof mutator !== 'function') throw new TypeError('withMappingMutation requires a function');
    return this._admit(() => this.store.update(mutator));
  }
  async health(accountId) {
    const slot = await this.getSlot(accountId);
    if (slot == null) return { healthy: false, reason: 'no_slot_allocated' };
    const check = await this.runtime.healthCheck(slot);
    return { ...check, slot };
  }
  async _rotate(slot, { previousIp, ...options } = {}) {
    slotPort(slot);
    const state = await this.store.load();
    const blacklistedSubnets = (state.burnedSubnets || []).map(e => typeof e === 'string' ? e : e.subnet);
    const activeSubnets = [];
    for (let s = 0; s < MAX_SLOTS; s++) {
      if (s !== slot) {
        try {
          const ip = await this.runtime.getExitIp(slotPort(s));
          if (ip) activeSubnets.push(ip);
        } catch {}
      }
    }
    const currentIp = previousIp || (await this.runtime.getExitIp(slotPort(slot)));
    const result = await this.runtime.rotateContainerIp(slot, {
      blacklistedSubnets,
      activeSubnets,
      previousIp: currentIp,
      logger: this.logger,
      ...options
    });
    return result;
  }
  async rotateSlot(slot, options = {}) {
    slotPort(slot);
    await this._waitSlotReaders(slot);
    return this._rotate(slot, options);
  }
  async rotateAccount(accountId, options = {}) {
    const slot = await this.getSlot(accountId);
    if (slot == null) return { success: false, reason: 'no_slot_allocated' };
    return this.rotateSlot(slot, options);
  }
  async rotate(accountIdOrSlot, options = {}) {
    if (Number.isInteger(accountIdOrSlot)) {
      return this.rotateSlot(accountIdOrSlot, options);
    }
    return this.rotateAccount(accountIdOrSlot, options);
  }
}
module.exports = {
  VpnSlotManager,
  DockerVpnManager: VpnSlotManager,
  createDockerRuntime,
  validateTokenFile,
  isCompatibleVpnImage,
  ...runtime,
  slotPort,
  containerName,
  BASE_PORT,
  MAX_SLOTS,
  MAX_HOST_NORDVPN_CONTAINERS,
  CONTAINER_PREFIX,
  VPN_IMAGE,
  PINNED_VPN_IMAGE,
  DEFAULT_VPN_VERSION,
  NORDVPN_VERSION: DEFAULT_VPN_VERSION,
  EXIT_IP_SERVICES,
  normalizeSlotIndex,
  normalizeVpnSlots,
  isNordVpnClientContainer,
  verifyPersistentVolumesExist: runtime.verifyPersistentVolumesExist,
  verifyHostContainerCap: runtime.verifyHostContainerCap,
  checkHostCapCompliance: runtime.checkHostCapCompliance,
  reconnectContainer: runtime.reconnectContainer
};
