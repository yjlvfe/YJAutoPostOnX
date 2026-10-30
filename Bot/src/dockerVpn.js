'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');
const { isIP } = require('node:net');
const { normalizeAccountId } = require('./accounts');

const exec = promisify(execFile);
const BASE_PORT = 18801;
const MAX_SLOTS = 5;
const CONTAINER_PREFIX = 'yj_autopost_vpn_';
const VPN_IMAGE = 'yj_autopost_vpn_image:latest';
const OWNER = 'yj-autopost';
const CONTRACT = 'independent-v1';
const TOKEN_TARGET = '/run/secrets/nordvpn_token';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function slotPort(slot) {
  if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_SLOTS) throw new Error('VPN slot out of range 0-4');
  return BASE_PORT + slot;
}
function containerName(slot) { slotPort(slot); return `${CONTAINER_PREFIX}${slot + 1}`; }

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
function createDockerRuntime({ command = exec, wait = sleep, now = Date.now, tokenFileValidator = validateTokenFile } = {}) {
  async function docker(args, timeout = 15_000) {
    try { return await command('docker', args, { timeout, maxBuffer: 1024 * 1024 }); }
    catch { throw new Error(`VPN Docker ${args[0]} failed`); } // Never relay Docker inspect/env or command stderr.
  }
  async function containerStatus(slot) {
    const name = containerName(slot);
    try {
      const { stdout } = await docker(['container', 'inspect', name]);
      const [info] = JSON.parse(stdout);
      const labels = info.Config?.Labels || {};
      return {
        exists: true, running: info.State?.Running === true, status: info.State?.Status,
        healthy: info.State?.Health?.Status === 'healthy', healthStatus: info.State?.Health?.Status || null,
        owned: labels['io.yj-autopost.owner'] === OWNER && labels['io.yj-autopost.slot'] === String(slot),
        compatible: labels['io.yj-autopost.contract'] === CONTRACT && info.Config?.Image === VPN_IMAGE,
        name
      };
    } catch {
      // Distinguish an absent container from an inaccessible daemon before any run/removal.
      const { stdout } = await docker(['container', 'ls', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Names}}']);
      if (stdout.trim()) throw new Error(`Cannot inspect VPN container ${name}`);
      return { exists: false, running: false, healthy: false, name };
    }
  }
  async function getExitIp(port) {
    try {
      const { stdout } = await command('curl', ['--noproxy', '', '--socks5-hostname', `127.0.0.1:${port}`,
        '--ipv4', '--fail', '--max-time', '10', '--silent', 'https://api.ipify.org'], { timeout: 12_000 });
      const ip = stdout.trim(); return isIP(ip) === 4 ? ip : null;
    } catch { return null; }
  }
  async function getServerIp() {
    try {
      const { stdout } = await command('curl', ['--noproxy', '*', '--ipv4', '--fail', '--max-time', '5',
        '--silent', 'https://api.ipify.org'], { timeout: 7_000 });
      const ip = stdout.trim(); return isIP(ip) === 4 ? ip : null;
    } catch { return null; }
  }
  async function healthCheck(slot) {
    const port = slotPort(slot);
    let status;
    try { status = await containerStatus(slot); } catch { return { healthy: false, reason: 'docker_unavailable' }; }
    if (!status.running) return { healthy: false, reason: 'container_not_running', name: status.name };
    if (!status.owned || !status.compatible) return { healthy: false, reason: 'image_migration_required', name: status.name };
    if (!status.healthy) return { healthy: false, reason: 'container_not_healthy', name: status.name };
    const exitIp = await getExitIp(port);
    if (!exitIp) return { healthy: false, reason: 'proxy_unreachable', name: status.name };
    const serverIp = await getServerIp();
    if (!serverIp) return { healthy: false, reason: 'server_ip_unavailable' };
    if (exitIp === serverIp) return { healthy: false, reason: 'ip_leak_detected' };
    return { healthy: true, exitIp, name: status.name, port };
  }
  async function ensureContainer(slot, { tokenFile = process.env.NORDVPN_TOKEN_FILE, token, country = 'United_States', logger = () => {}, readyTimeoutMs = 180_000 } = {}) {
    const name = containerName(slot), port = slotPort(slot);
    const status = await containerStatus(slot);
    if (status.exists && (!status.owned || !status.compatible)) {
      throw new Error(`VPN image migration required for ${name}; operator must replace it explicitly`);
    }
    if (!status.exists) {
      if (token) throw new Error('Inline VPN tokens are not supported; use NORDVPN_TOKEN_FILE');
      const file = await tokenFileValidator(tokenFile);
      if (!/^[A-Za-z][A-Za-z_ -]{0,63}$/.test(country)) throw new Error('Invalid VPN country');
      await docker(['run', '-d', '--name', name, '--restart', 'unless-stopped',
        '--label', `io.yj-autopost.owner=${OWNER}`, '--label', `io.yj-autopost.slot=${slot}`,
        '--label', `io.yj-autopost.contract=${CONTRACT}`, '--cap-add', 'NET_ADMIN',
        '--device', '/dev/net/tun:/dev/net/tun', '--security-opt', 'no-new-privileges:true',
        '--sysctl', 'net.ipv6.conf.all.disable_ipv6=1', '--sysctl', 'net.ipv6.conf.default.disable_ipv6=1',
        '-p', `127.0.0.1:${port}:1080`,
        '--mount', `type=bind,src=${file},dst=${TOKEN_TARGET},readonly`,
        '--mount', `type=volume,src=${name}_state,dst=/var/lib/nordvpn`,
        '--mount', `type=volume,src=${name}_auth,dst=/root/.config/nordvpn`,
        '-e', `NORDVPN_TOKEN_FILE=${TOKEN_TARGET}`, '-e', `VPN_COUNTRY=${country}`, VPN_IMAGE], 30_000);
    } else if (!status.running) {
      // Preserve the container identity, volumes and secret mount on cold recovery.
      await docker(['start', name], 30_000);
    }
    const deadline = now() + readyTimeoutMs;
    do {
      const check = await healthCheck(slot);
      if (check.healthy) {
        logger(`VPN container ${name} ready on port ${port}`);
        return { name, port, proxy: `socks5h://127.0.0.1:${port}`, reused: status.exists, exitIp: check.exitIp };
      }
      if (check.reason === 'container_not_running' || check.reason === 'image_migration_required') {
        throw new Error(`VPN ${name} not ready: ${check.reason}`);
      }
      await wait(2000);
    } while (now() < deadline);
    throw new Error(`VPN ${name} did not become healthy before readiness deadline`);
  }
  async function destroyContainer(slot) {
    const status = await containerStatus(slot);
    if (!status.exists) return { removed: true, absent: true, name: status.name };
    // Even a known name is not proof of ownership. No automatic removal of legacy/unlabelled containers.
    if (!status.owned) throw new Error(`Refusing to remove unowned VPN container ${status.name}`);
    await docker(['rm', '-f', status.name]); // No -v: identity/session volumes intentionally survive.
    return { removed: true, name: status.name };
  }
  return { containerStatus, getExitIp, getServerIp, healthCheck, ensureContainer, destroyContainer,
    testSocksProxy: async port => Boolean(await getExitIp(port)) };
}
const runtime = createDockerRuntime();

/** All operations through one manager serialize allocation/removal so a slot is not reused mid-release. */
class VpnSlotManager {
  constructor({ store, logger = () => {}, runtime: suppliedRuntime = runtime } = {}) {
    if (!store) throw new Error('VpnSlotManager requires a store');
    this.store = store; this.logger = logger; this.runtime = suppliedRuntime; this.pending = Promise.resolve();
  }
  _exclusive(fn) { const work = this.pending.then(fn); this.pending = work.catch(() => {}); return work; }
  async _slots() { return (await this.store.load()).vpnSlots || {}; }
  async _allocate(accountId) {
    const id = normalizeAccountId(accountId);
    let slot;
    await this.store.update(state => {
      state.vpnSlots ||= {};
      const entries = Object.entries(state.vpnSlots);
      for (const [, value] of entries) slotPort(value);
      if (new Set(entries.map(([, value]) => value)).size !== entries.length) throw new Error('Duplicate VPN slots require reconciliation');
      if (Object.hasOwn(state.vpnSlots, id)) { slot = state.vpnSlots[id]; return state; }
      const used = new Set(Object.values(state.vpnSlots));
      slot = Array.from({ length: MAX_SLOTS }, (_, i) => i).find(i => !used.has(i));
      if (slot == null) throw new Error('All five VPN slots are allocated; reconcile removed accounts first');
      Object.defineProperty(state.vpnSlots, id, { value: slot, enumerable: true, configurable: true, writable: true });
      return state;
    });
    return slot;
  }
  allocate(accountId) { return this._exclusive(() => this._allocate(accountId)); }
  async _release(accountId) {
    const id = normalizeAccountId(accountId), slots = await this._slots();
    const slot = Object.hasOwn(slots, id) ? slots[id] : null;
    if (slot == null) return null;
    slotPort(slot);
    // Shared stale mapping: remove only the mapping, never the other account's container.
    if (!Object.entries(slots).some(([other, value]) => other !== id && value === slot)) {
      const result = await this.runtime.destroyContainer(slot);
      if (!result.removed) throw new Error('Failed to remove VPN container; reservation retained');
    }
    await this.store.update(state => {
      if (state.vpnSlots?.[id] === slot) delete state.vpnSlots[id];
      return state;
    });
    this.logger(`Released VPN slot ${slot}`);
    return slot;
  }
  release(accountId) { return this._exclusive(() => this._release(accountId)); }
  /** Defaults to a read-only plan. Apply explicitly at startup/account-set replacement. */
  reconcile({ accountIds, dryRun = true } = {}) {
    return this._exclusive(async () => {
      const state = await this.store.load();
      const active = new Set((accountIds ?? (state.accounts || []).map(a => a.id)).map(normalizeAccountId));
      const slots = state.vpnSlots || {}, stale = [], conflicts = [], released = [];
      const seen = new Set();
      for (const [accountId, slot] of Object.entries(slots)) {
        if (!active.has(accountId)) stale.push({ accountId, slot });
        if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_SLOTS) conflicts.push({ accountId, reason: 'invalid_slot' });
        else if (active.has(accountId)) {
          if (seen.has(slot)) conflicts.push({ accountId, reason: 'duplicate_active_slot' });
          seen.add(slot);
        }
      }
      if (!dryRun && conflicts.length) throw new Error('Unsafe VPN mappings require operator repair');
      if (!dryRun) for (const entry of stale) { await this._release(entry.accountId); released.push(entry); }
      return { dryRun, stale, conflicts, released };
    });
  }
  async getSlot(accountId) {
    const slots = await this._slots();
    const slot = Object.hasOwn(slots, accountId) ? slots[accountId] : null;
    if (slot != null) slotPort(slot);
    return slot;
  }
  async getPort(accountId) { const slot = await this.getSlot(accountId); return slot == null ? null : slotPort(slot); }
  async getProxy(accountId) { const port = await this.getPort(accountId); return port == null ? null : `socks5h://127.0.0.1:${port}`; }
  ensure(accountId, options = {}) {
    return this._exclusive(async () => {
      const slot = await this._allocate(accountId);
      const result = await this.runtime.ensureContainer(slot, { ...options, logger: this.logger });
      return { ...result, slot };
    });
  }
  async health(accountId) {
    const slot = await this.getSlot(accountId);
    return slot == null ? { healthy: false, reason: 'no_slot_allocated' } : this.runtime.healthCheck(slot);
  }
}
module.exports = { VpnSlotManager, createDockerRuntime, validateTokenFile, ...runtime,
  slotPort, containerName, BASE_PORT, MAX_SLOTS, CONTAINER_PREFIX, VPN_IMAGE };
