'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

const PROD_DATA_DIRS = [
  '/root/Projects/YJAutoPostOnX/Bot/data',
  path.resolve(__dirname, '../../data')
];

const PROTECTED_PROD_FILES = [
  'state.sqlite',
  'state.sqlite-wal',
  'session_leases.sqlite',
  'telegram-runner.lock',
  'vpn.lock',
  'bot.lock'
];

const LOOPBACK_HOSTS = new Set([
  '127.0.0.1',
  'localhost',
  '::1',
  '[::1]',
  '0.0.0.0'
]);

function isLoopbackHost(host) {
  if (!host) return true;
  const cleaned = String(host).trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (LOOPBACK_HOSTS.has(cleaned)) return true;
  if (cleaned.startsWith('127.')) return true;
  return false;
}

let networkGuardInstalled = false;

function installExternalNetworkBlocker() {
  if (networkGuardInstalled) return;
  networkGuardInstalled = true;

  const checkTarget = (input, options) => {
    let host = null;
    if (typeof input === 'string') {
      try {
        const u = new URL(input);
        host = u.hostname;
      } catch {
        host = '127.0.0.1';
      }
    } else if (input instanceof URL) {
      host = input.hostname;
    } else if (input && typeof input === 'object') {
      host = input.hostname || input.host || (options && (options.hostname || options.host));
    }
    if (host && host.includes(':')) {
      host = host.split(':')[0];
    }
    if (host && !isLoopbackHost(host)) {
      const err = new Error(`ERR_EXTERNAL_NETWORK_FORBIDDEN_IN_TEST: Outbound connection to non-loopback host '${host}' is strictly forbidden in hermetic tests.`);
      err.code = 'ERR_EXTERNAL_NETWORK_FORBIDDEN_IN_TEST';
      throw err;
    }
  };

  const origHttpRequest = http.request;
  const origHttpGet = http.get;
  const origHttpsRequest = https.request;
  const origHttpsGet = https.get;

  http.request = function (input, options, cb) {
    checkTarget(input, options);
    return origHttpRequest.call(this, input, options, cb);
  };
  http.get = function (input, options, cb) {
    checkTarget(input, options);
    return origHttpGet.call(this, input, options, cb);
  };
  https.request = function (input, options, cb) {
    checkTarget(input, options);
    return origHttpsRequest.call(this, input, options, cb);
  };
  https.get = function (input, options, cb) {
    checkTarget(input, options);
    return origHttpsGet.call(this, input, options, cb);
  };

  const origSocketConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const first = args[0];
    if (first && typeof first === 'object' && !Array.isArray(first)) {
      const host = first.host || first.hostname;
      if (host && !isLoopbackHost(host)) {
        const err = new Error(`ERR_EXTERNAL_NETWORK_FORBIDDEN_IN_TEST: Socket connect to '${host}' is forbidden in hermetic tests.`);
        err.code = 'ERR_EXTERNAL_NETWORK_FORBIDDEN_IN_TEST';
        throw err;
      }
    } else if (typeof args[0] === 'number' && typeof args[1] === 'string') {
      const host = args[1];
      if (!isLoopbackHost(host)) {
        const err = new Error(`ERR_EXTERNAL_NETWORK_FORBIDDEN_IN_TEST: Socket connect to '${host}' is forbidden in hermetic tests.`);
        err.code = 'ERR_EXTERNAL_NETWORK_FORBIDDEN_IN_TEST';
        throw err;
      }
    }
    return origSocketConnect.apply(this, args);
  };

  if (typeof globalThis.fetch === 'function') {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async function (input, init) {
      const urlStr = typeof input === 'string' ? input : (input?.url || String(input));
      checkTarget(urlStr);
      return origFetch.call(this, input, init);
    };
  }
}

function isLiveDaemonRunningOnDir(dir) {
  try {
    const lockFile = path.join(dir, 'telegram-runner.lock');
    if (!fs.existsSync(lockFile)) return false;
    const parsed = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    const pid = Number(parsed?.pid);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function snapshotProductionFiles() {
  const snapshot = {};
  for (const dir of PROD_DATA_DIRS) {
    const liveDaemonActive = isLiveDaemonRunningOnDir(dir);
    for (const name of PROTECTED_PROD_FILES) {
      const fullPath = path.join(dir, name);
      try {
        if (fs.existsSync(fullPath)) {
          const stat = fs.statSync(fullPath, { bigint: true });
          const buf = fs.readFileSync(fullPath);
          const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
          snapshot[fullPath] = {
            exists: true,
            size: Number(stat.size),
            mtimeNs: stat.mtimeNs.toString(),
            sha256,
            liveDaemonActive
          };
        } else {
          snapshot[fullPath] = { exists: false, liveDaemonActive };
        }
      } catch (err) {
        snapshot[fullPath] = { exists: false, liveDaemonActive, error: err.code || err.message };
      }
    }
  }
  return snapshot;
}

function verifyProductionSnapshot(beforeSnapshot) {
  const afterSnapshot = snapshotProductionFiles();
  const diffs = [];
  for (const [filePath, before] of Object.entries(beforeSnapshot)) {
    const after = afterSnapshot[filePath];
    const baseName = path.basename(filePath);
    // Per phase4-fresh-test-spec.md §1.1: if the live systemd daemon is stopped,
    // any byte or timestamp change in /root/Projects/YJAutoPostOnX/Bot/data/ fails immediately.
    // When the live daemon is actively polling Telegram on /root/Projects/YJAutoPostOnX/Bot/data,
    // its own offset/refresh writes update state.sqlite(-wal) while lock & lease files and worktree data stay untouched.
    if ((before.liveDaemonActive || after?.liveDaemonActive) && (baseName === 'state.sqlite' || baseName === 'state.sqlite-wal')) {
      continue;
    }
    if (before.exists !== after?.exists) {
      diffs.push(`${filePath}: existence changed (${before.exists} -> ${after?.exists})`);
      continue;
    }
    if (before.exists && after?.exists) {
      if (before.sha256 !== after.sha256 || before.size !== after.size) {
        diffs.push(`${filePath}: mutated (size ${before.size}->${after.size}, sha256 ${before.sha256.slice(0, 12)}->${after.sha256.slice(0, 12)})`);
      }
    }
  }
  if (diffs.length > 0) {
    const err = new Error(`PROD_STATE_MUTATED_IN_TEST:\n  ${diffs.join('\n  ')}`);
    err.code = 'PROD_STATE_MUTATED_IN_TEST';
    throw err;
  }
  return true;
}

function createHermeticWorkspace(prefix = 'yj-bot-test-') {
  installExternalNetworkBlocker();

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(tempDir, 0o700);

  const cookiesDir = path.join(tempDir, 'cookies');
  const logsDir = path.join(tempDir, 'logs');
  const exportsDir = path.join(tempDir, 'exports');
  const secretsDir = path.join(tempDir, 'secrets');

  for (const d of [cookiesDir, logsDir, exportsDir, secretsDir]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    fs.chmodSync(d, 0o700);
  }

  const tokenFile = path.join(secretsDir, 'nordvpn_token');
  fs.writeFileSync(tokenFile, 'a'.repeat(64) + '\n', { mode: 0o600 });
  fs.chmodSync(tokenFile, 0o600);

  const dbPath = path.join(tempDir, 'state.sqlite');
  const leaseDbPath = path.join(tempDir, 'session_leases.sqlite');
  const logFile = path.join(logsDir, 'forensic.jsonl');
  const lockPath = path.join(tempDir, 'telegram-runner.lock');

  const savedEnv = { ...process.env };
  const envOverrides = {
    NODE_ENV: 'test',
    YJ_TEST_MODE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    BOT_DATA_DIR: tempDir,
    SESSION_GUARD_DB_PATH: leaseDbPath,
    DIRECT_X_SESSION_DB_PATH: leaseDbPath,
    SERVER_IP: '8.8.8.8',
    NORDVPN_TOKEN_FILE: tokenFile,
    TELEGRAM_BOT_TOKEN: '123456789:ABCdefGHIjklMNOpqrSTUvwxYZ012345678',
    BOT_OWNER_ID: '528864559',
    BOT_OWNER_CHAT_ID: '528864559',
    BOT_ALLOWED_USER_IDS: '528864559,5535435580',
    BOT_ALLOWED_CHAT_IDS: '528864559,5535435580'
  };
  Object.assign(process.env, envOverrides);

  const registeredStores = new Set();

  function registerStore(store) {
    if (store) registeredStores.add(store);
    return store;
  }

  function writeSyntheticCookie(accountId, {
    authToken = 'synthetic_auth_token_' + accountId,
    ct0 = 'synthetic_ct0_' + accountId,
    userId = '100001',
    domain = '.x.com',
    extraCookies = []
  } = {}) {
    const file = path.join(cookiesDir, `${accountId}.cookies`);
    const payload = [
      { name: 'auth_token', value: authToken, domain, path: '/', secure: true, httpOnly: true },
      { name: 'ct0', value: ct0, domain, path: '/', secure: true },
      { name: 'twid', value: `u=${userId}`, domain, path: '/', secure: true },
      ...extraCookies
    ];
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return file;
  }

  async function cleanup() {
    await new Promise(resolve => setTimeout(resolve, 40));
    for (const store of registeredStores) {
      try {
        await store.close?.();
      } catch {}
    }
    registeredStores.clear();

    try {
      const { resetSessionsForTest } = require('../../src/sessionGuard');
      resetSessionsForTest(leaseDbPath);
    } catch {}

    for (const k of Object.keys(process.env)) {
      if (!(k in savedEnv)) {
        delete process.env[k];
      }
    }
    Object.assign(process.env, savedEnv);

    await new Promise(resolve => setTimeout(resolve, 20));
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (fs.existsSync(tempDir)) {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
        if (!fs.existsSync(tempDir)) break;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }

  return {
    tempDir,
    cookiesDir,
    logsDir,
    exportsDir,
    secretsDir,
    tokenFile,
    dbPath,
    leaseDbPath,
    logFile,
    lockPath,
    registerStore,
    writeSyntheticCookie,
    cleanup
  };
}

installExternalNetworkBlocker();

module.exports = {
  createHermeticWorkspace,
  installExternalNetworkBlocker,
  snapshotProductionFiles,
  verifyProductionSnapshot,
  isLoopbackHost
};
