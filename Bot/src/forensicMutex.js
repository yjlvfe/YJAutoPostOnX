'use strict';

// PostgreSQL admission plus a supplemental local kernel file fence.
// Neither TTL nor a lost PG session can admit overlapping file callbacks. No SQLite.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { AsyncLocalStorage } = require('node:async_hooks');
const { Pool } = require('pg');
const { acquireKernelFence } = require('./forensicKernelFence');

const LOCK_WAIT_MS = 10_000;
const contexts = new AsyncLocalStorage();
let defaultPool;

function failure(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

// Retained public diagnostic export; PostgreSQL, not PID visibility, owns locks.
function processStartTicks(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const end = stat.lastIndexOf(')');
    return end < 0 ? null : stat.slice(end + 2).trim().split(/\s+/)[19] || null;
  } catch { return null; }
}

function canonicalLogPath(logFile) {
  const resolved = path.resolve(logFile);
  // Resolve the file symlink too when it exists. For a missing file/directory,
  // resolve the nearest existing ancestor without creating anything.
  let ancestor = resolved;
  const missing = [];
  while (true) {
    try { return path.join(fs.realpathSync(ancestor), ...missing); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

// Compatibility diagnostic only. No caller in the application uses this export;
// the old sidecar name remains available but is NEVER opened/created/deleted.
function mutexDbPath(logFile) { return `${canonicalLogPath(logFile)}.mutex.sqlite`; }

function advisoryKey(logFile) {
  const hash = crypto.createHash('sha256').update('yj:forensic-log:v1\0').update(canonicalLogPath(logFile)).digest();
  return [hash.readInt32BE(0), hash.readInt32BE(4)];
}

function isTestEnvironment() {
  return Boolean(process.env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT ||
    process.env.YJ_TEST_MODE === '1' || process.env.npm_lifecycle_event?.startsWith('test') ||
    process.execArgv.some(arg => arg.startsWith('--test')));
}

function readPassword(secretFile) {
  if (process.env.PGPASSWORD && !secretFile) return process.env.PGPASSWORD.trim();
  const file = path.resolve(secretFile || process.env.PG_PASSWORD_FILE || path.join(__dirname, '../data/secrets/pg_password'));
  // Match the private local password-file pattern without importing pgStorage
  // (which currently imports the legacy offline SQLite adapter).
  let part = path.parse(file).root;
  for (const segment of file.slice(part.length).split(path.sep)) {
    part = path.join(part, segment);
    if (fs.lstatSync(part).isSymbolicLink()) throw failure('PG_PASSWORD_FILE_UNSAFE', 'symlink in password path');
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
      throw failure('PG_PASSWORD_FILE_UNSAFE', 'password file must be private and owned by this user');
    }
    return fs.readFileSync(fd, 'utf8').trim();
  } finally { fs.closeSync(fd); }
}

function getDefaultPool() {
  // Tests must opt into an explicit pool/config, never an ambient production DB.
  if (isTestEnvironment()) throw failure('FORENSIC_PG_TEST_CONFIG_REQUIRED', 'inject an isolated PostgreSQL pool or pgConfig');
  if (!defaultPool) {
    defaultPool = new Pool(resolveConfig());
    defaultPool.on('error', () => {}); // checked-out sessions have their own handler
  }
  return defaultPool;
}

function resolveConfig(config = {}) {
  return {
    ...config,
    host: config.host || process.env.PGHOST || '127.0.0.1',
    port: Number(config.port || process.env.PGPORT || 5432),
    database: config.database || process.env.PGDATABASE || 'yj_autopost',
    user: config.user || process.env.PGUSER || 'yj_bot_app',
    password: config.password ?? readPassword(config.secretPath),
    max: config.max ?? 8,
    connectionTimeoutMillis: config.connectionTimeoutMillis ?? 5000,
    idleTimeoutMillis: config.idleTimeoutMillis ?? 1000,
    allowExitOnIdle: true,
    application_name: config.application_name || 'yj_forensic_mutex'
  };
}

function remaining(deadline) { return Math.max(0, deadline - performance.now()); }
function bounded(promise, deadline) {
  const ms = remaining(deadline);
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(failure('FORENSIC_LOG_LOCK_TIMEOUT', 'PostgreSQL mutex deadline exceeded')), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

async function checkout(pool, deadline) {
  let expired = false;
  const pending = Promise.resolve().then(() => pool.connect()).then(client => {
    // Pool acquisition can resolve after our deadline. Never leak that client.
    if (expired) { client.release(true); return null; }
    return client;
  });
  try { return await bounded(pending, deadline); }
  catch (error) { expired = true; throw error; }
}

async function withForensicMutex(logFile, fn, { timeoutMs = LOCK_WAIT_MS, pool, pgConfig } = {}) {
  if (typeof fn !== 'function') throw new TypeError('forensic mutex requires a callback');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new TypeError('invalid mutex timeout');
  // No file means no shared file resource, preserving the existing async API.
  if (!logFile) return await fn();
  const identity = canonicalLogPath(logFile);
  const parents = contexts.getStore() || [];
  if (parents.some(owner => owner.active && owner.identity === identity)) {
    throw failure('FORENSIC_LOG_LOCK_REENTRANT', 'same-log nested ownership is not supported');
  }
  if (pool && pgConfig) throw new TypeError('supply pool or pgConfig, not both');
  if (isTestEnvironment() && pgConfig && (!pgConfig.database || pgConfig.database === 'yj_autopost')) {
    throw failure('FORENSIC_PG_TEST_CONFIG_REQUIRED', 'explicit nonproduction database required');
  }
  let ownedPool;
  if (!pool && pgConfig) {
    ownedPool = new Pool(resolveConfig(pgConfig));
    ownedPool.on('error', () => {});
    pool = ownedPool;
  }
  pool ||= getDefaultPool();
  const deadline = performance.now() + timeoutMs;
  const key = advisoryKey(identity);
  let client;
  let held = false;
  let releaseKernel;
  let lost = false;
  const owner = { identity, active: true };
  const onLost = () => { lost = true; };
  try {
    client = await checkout(pool, deadline);
    client.on('error', onLost);
    client.on('end', onLost);
    while (remaining(deadline) > 0) {
      const result = await bounded(client.query('SELECT pg_try_advisory_lock($1::int, $2::int) AS held', key), deadline);
      if (result.rows[0]?.held === true) { held = true; break; }
      await new Promise(resolve => setTimeout(resolve, Math.min(20, remaining(deadline))));
    }
    if (!held || remaining(deadline) <= 0) throw failure('FORENSIC_LOG_LOCK_TIMEOUT', 'active owner or expired acquire deadline; log write deferred');
    releaseKernel = await acquireKernelFence(identity, deadline);
    if (lost) throw failure('FORENSIC_LOG_LOCK_LOST', 'PostgreSQL session ended before callback');
    const result = await contexts.run([...parents, owner], fn);
    if (lost) throw failure('FORENSIC_LOG_LOCK_LOST', 'PostgreSQL session ended during callback; completion is uncertain');
    return result;
  } finally {
    owner.active = false;
    // Callback and every awaited file syscall have settled; only now drop the local fence.
    releaseKernel?.();
    if (client) {
      try {
        if (held && !lost) {
          const result = await bounded(client.query('SELECT pg_advisory_unlock($1::int, $2::int) AS released', key), performance.now() + Math.min(timeoutMs, 1000));
          if (result.rows[0]?.released !== true) lost = true;
        }
      } catch { /* Destruction below is the only recovery; never retry on a new session. */ }
      finally {
        // Always DESTROY rather than recycle: even a timed-out query can finish
        // late and acquire a lock, so no uncertain session may enter the pool.
        client.release(true);
        client.removeListener('error', onLost);
        client.removeListener('end', onLost);
      }
    }
    if (ownedPool) {
      const ending = ownedPool.end();
      // A timed-out connect may still be pending; its late checkout handler
      // destroys the client. Awaiting pool.end() here would undo our deadline.
      if (client) await ending;
      else void ending.catch(() => {});
    }
  }
}

module.exports = { withForensicMutex, mutexDbPath, processStartTicks, canonicalLogPath, advisoryKey };
