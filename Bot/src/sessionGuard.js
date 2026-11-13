'use strict';
/** PostgreSQL-only, project-wide session admission. No schema changes on open.
 * All producers MUST await acquisition before spawn, bind before using a child,
 * and await release after its private process group has ended.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const identity = require('./processIdentity');
const { getPidStartTime, isPidAlive, isProcessAlive, processStatus, processGroupStatus, readProcStat, hostIdentity, scanProcesses } = identity;
const MAX_PROJECT_SESSIONS = 5;
const HEARTBEAT_INTERVAL_MS = 5000;
// Fixed across every account, pool, schema and process in this database.
const LOCK_KEY = '749321468520011';
const REQUIRED_COLUMNS = ['worker_token', 'lease_state', 'host_identity', 'child_pgid', 'child_sid', 'descendant_identities'];
const LEASE_COLUMNS = 'lease_id,account_id,session_key,node_pid,owner_starttime,child_pid,child_starttime,acquired_at,heartbeat_at,meta,worker_token,lease_state,host_identity,child_pgid,child_sid,descendant_identities';
function error(code, message = code) { return Object.assign(new Error(message), { code }); }
function isTestEnvironment() {
  return Boolean(process.env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT || process.env.YJ_TEST_MODE === '1' || process.env.npm_lifecycle_event === 'test' || process.execArgv.some(x => x.includes('--test')));
}
function isTargetingProdSessionDb(database) { return database === 'yj_autopost'; }
function assertSessionDbMutationAllowed(database, expectedDatabase) {
  if (expectedDatabase && database !== expectedDatabase) throw error('SESSION_DATABASE_MISMATCH');
  if (isTestEnvironment() && (!expectedDatabase || !/^yj_autopost_test_[a-zA-Z0-9_]+$/.test(expectedDatabase) || database !== expectedDatabase)) {
    throw error('PRODUCTION_DB_MUTATION_FORBIDDEN', 'Tests require an explicit isolated yj_autopost_test_* database');
  }
}
function readPassword(file) {
  const resolved = path.resolve(file);
  let cursor = resolved;
  while (cursor !== path.dirname(cursor)) {
    if (fs.lstatSync(cursor).isSymbolicLink()) throw error('PG_PASSWORD_FILE_UNSAFE');
    cursor = path.dirname(cursor);
  }
  const fd = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw error('PG_PASSWORD_FILE_UNSAFE');
    return fs.readFileSync(fd, 'utf8').trim();
  } finally { fs.closeSync(fd); }
}
function getSessionPgConfig(overrides = {}) {
  if (process.env.SESSION_GUARD_DB_PATH || process.env.DIRECT_X_SESSION_DB_PATH) throw error('SQLITE_SESSION_CONFIGURATION_REMOVED');
  const database = overrides.database || process.env.PGDATABASE || (isTestEnvironment() ? null : 'yj_autopost');
  if (!database) throw error('SESSION_TEST_DATABASE_REQUIRED');
  if (isTestEnvironment() && !/^yj_autopost_test_[a-zA-Z0-9_]+$/.test(database)) throw error('PRODUCTION_DB_MUTATION_FORBIDDEN');
  return { host: overrides.host || process.env.PGHOST || '127.0.0.1', port: Number(overrides.port || process.env.PGPORT || 5432),
    user: overrides.user || process.env.PGUSER || 'yj_bot_app', database,
    password: overrides.password ?? process.env.PGPASSWORD ?? readPassword(overrides.secretPath || process.env.PG_PASSWORD_FILE || path.resolve(__dirname, '../data/secrets/pg_password')),
    max: 4, idleTimeoutMillis: 30000, connectionTimeoutMillis: 3000, ...overrides };
}
function makeOptions(options) {
  if (typeof options === 'string') throw error('SQLITE_SESSION_CONFIGURATION_REMOVED', 'Pass PostgreSQL options, not a filesystem path');
  return options || {};
}
async function verifiedClient(pool, expectedDatabase) {
  const client = await pool.connect();
  try {
    const database = (await client.query('SELECT current_database() AS database')).rows[0].database;
    assertSessionDbMutationAllowed(database, expectedDatabase);
    return client;
  } catch (err) { client.release(); throw err; }
}
/** Explicit, transactional migration. Main runs only after all old producers drain.
 * Refuses legacy nonempty rows: they cannot safely be assigned fabricated tokens.
 */
async function installSessionGuardSchema(options = {}) {
  options = makeOptions(options);
  const ownPool = !options.pool;
  const pool = options.pool || new Pool(getSessionPgConfig(options.pgConfig));
  let client;
  try {
    client = await verifiedClient(pool, options.expectedDatabase);
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='2000ms'");
    await client.query("SET LOCAL statement_timeout='5000ms'");
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [LOCK_KEY]);
    const columns = (await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='session_leases'")).rows.map(x => x.column_name);
    if (columns.length && REQUIRED_COLUMNS.some(x => !columns.includes(x))) {
      await client.query('LOCK TABLE public.session_leases IN ACCESS EXCLUSIVE MODE');
      if (Number((await client.query('SELECT count(*) AS count FROM public.session_leases')).rows[0].count)) throw error('SESSION_SCHEMA_DRAIN_REQUIRED');
    }
    await client.query(`CREATE TABLE IF NOT EXISTS public.session_leases (
      lease_id TEXT PRIMARY KEY, account_id TEXT, session_key TEXT UNIQUE,
      node_pid INTEGER NOT NULL, owner_starttime TEXT, child_pid INTEGER, child_starttime TEXT,
      acquired_at BIGINT NOT NULL, heartbeat_at BIGINT NOT NULL, meta TEXT);
      ALTER TABLE public.session_leases ADD COLUMN IF NOT EXISTS worker_token TEXT;
      ALTER TABLE public.session_leases ADD COLUMN IF NOT EXISTS lease_state TEXT;
      ALTER TABLE public.session_leases ADD COLUMN IF NOT EXISTS host_identity TEXT;
      ALTER TABLE public.session_leases ADD COLUMN IF NOT EXISTS child_pgid INTEGER;
      ALTER TABLE public.session_leases ADD COLUMN IF NOT EXISTS child_sid INTEGER;
      ALTER TABLE public.session_leases ADD COLUMN IF NOT EXISTS descendant_identities JSONB NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE public.session_leases ALTER COLUMN worker_token SET NOT NULL;
      ALTER TABLE public.session_leases ALTER COLUMN lease_state SET NOT NULL;
      ALTER TABLE public.session_leases ALTER COLUMN host_identity SET NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS session_leases_account_unique ON public.session_leases(account_id) WHERE account_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS session_leases_worker_token_unique ON public.session_leases(worker_token);
      CREATE UNIQUE INDEX IF NOT EXISTS session_leases_session_key_unique ON public.session_leases(session_key);
      CREATE UNIQUE INDEX IF NOT EXISTS session_leases_child_identity_unique ON public.session_leases(host_identity,child_pid,child_starttime) WHERE child_pid IS NOT NULL;
    `);
    await client.query('COMMIT');
    return { installed: true, schema: 'public', table: 'session_leases' };
  } catch (err) { if (client) { try { await client.query('ROLLBACK'); } catch {} } throw err; }
  finally { if (client) client.release(); if (ownPool) await pool.end(); }
}
function childStatus(row, processes, host) {
  if (!row.child_pid) return row.lease_state === 'spawning' ? 'unknown' : 'dead';
  if (row.host_identity !== host || !row.child_starttime || !row.child_pgid || !row.child_sid) return 'unknown';
  const status = processStatus(row.child_pid, row.child_starttime);
  if (status === 'alive' || status === 'unknown') return status;
  // A dead/recycled leader is not proof that its group/session ended.
  if (processes.some(p => p.pgid === row.child_pgid || p.sid === row.child_sid)) return 'alive';
  for (const descendant of row.descendant_identities || []) {
    if (!['dead', 'reused'].includes(processStatus(descendant.pid, descendant.starttime))) return 'alive';
  }
  // A child can fork after /proc enumeration and exit before its stat is read.
  // Prove the bound private group absent at the release/reconciliation boundary;
  // EPERM, other uncertainty and zombie-only groups must retain the lease.
  return processGroupStatus(row.child_pgid);
}
function descendantIdentities(row, processes) {
  const known = new Map((row.descendant_identities || []).map(x => [`${x.pid}:${x.starttime}`, x]));
  const parents = new Set([row.child_pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of processes) {
      if (p.pid === row.child_pid) continue;
      if (parents.has(p.ppid) || p.pgid === row.child_pgid || p.sid === row.child_sid) {
        known.set(`${p.pid}:${p.starttime}`, { pid: p.pid, starttime: p.starttime });
        if (!parents.has(p.pid)) { parents.add(p.pid); changed = true; }
      }
    }
  }
  return [...known.values()];
}
class SessionGuardRegistry {
  constructor(options = {}) {
    options = makeOptions(options);
    this.expectedDatabase = options.expectedDatabase;
    this.pool = options.pool || new Pool(getSessionPgConfig(options.pgConfig));
    this.ownsPool = !options.pool;
    this.localTokens = new Map();
    this.closed = false;
    this.schemaVerified = false;
  }
  async close() {
    this.closed = true;
    // Close is not a lease release and never erases live reservations.
    if (this.ownsPool) await this.pool.end();
  }
  async _transaction(fn) {
    if (this.closed) throw error('SESSION_REGISTRY_CLOSED');
    const client = await verifiedClient(this.pool, this.expectedDatabase);
    let broken = false;
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout='2000ms'");
      await client.query("SET LOCAL statement_timeout='5000ms'");
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [LOCK_KEY]);
      // Explicit public qualification avoids a second registry via search_path.
      if (!this.schemaVerified) {
        const columns = (await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='session_leases'")).rows.map(x => x.column_name);
        if (REQUIRED_COLUMNS.some(x => !columns.includes(x))) throw error('SESSION_SCHEMA_MIGRATION_REQUIRED');
        this.schemaVerified = true;
      }
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { broken = true; }
      if (['42703', '42P01'].includes(err.code)) {
        this.schemaVerified = false;
        throw error('SESSION_SCHEMA_MIGRATION_REQUIRED');
      }
      if (['55P03', '57014'].includes(err.code)) throw error('SESSION_REGISTRY_BUSY');
      if (err.code === '23505') throw error('DUPLICATE_SESSION_LEASE');
      throw err;
    } finally { client.release(broken); }
  }
  async _rows(client) { return (await client.query(`SELECT ${LEASE_COLUMNS} FROM public.session_leases ORDER BY acquired_at,lease_id FOR UPDATE`)).rows; }
  async _leaseRow(client, leaseId) { return (await client.query(`SELECT ${LEASE_COLUMNS} FROM public.session_leases WHERE lease_id=$1 FOR UPDATE`, [leaseId])).rows[0]; }
  async _reconcile(client, rows, processes, host) {
    let purged = 0;
    const retained = [];
    const untracked = processes.some(p => p.directX && !rows.some(r => r.child_pid === p.pid && r.child_starttime === p.starttime && r.host_identity === host));
    for (const row of rows) {
      const owner = row.host_identity === host ? processStatus(row.node_pid, row.owner_starttime) : 'unknown';
      if (['dead', 'reused'].includes(owner) && childStatus(row, processes, host) === 'dead' && !(untracked && !row.child_pid)) {
        purged += (await client.query('DELETE FROM public.session_leases WHERE lease_id=$1 AND worker_token=$2', [row.lease_id, row.worker_token])).rowCount;
      } else retained.push(row);
    }
    return { rows: retained, purged };
  }
  _snapshot(rows, processes, host) {
    const tracked = new Set(rows.filter(r => r.host_identity === host && !['dead', 'reused'].includes(processStatus(r.child_pid, r.child_starttime))).map(r => r.child_pid));
    const untracked = processes.filter(p => p.directX && !tracked.has(p.pid)).length;
    return { untracked, total: rows.length + untracked };
  }
  async acquire({ accountId, sessionKey, childPid, ownerStartTime, childStartTime, meta } = {}) {
    if (accountId != null && (typeof accountId !== 'string' && typeof accountId !== 'number')) throw error('INVALID_ACCOUNT_ID');
    accountId = accountId == null ? null : String(accountId);
    if (accountId === '') throw error('INVALID_ACCOUNT_ID');
    if (sessionKey != null && (typeof sessionKey !== 'string' || !sessionKey)) throw error('INVALID_SESSION_KEY');
    const key = sessionKey || (accountId == null ? `anonymous_${crypto.randomUUID()}` : `account_${accountId}`);
    const start = getPidStartTime(process.pid), host = hostIdentity();
    if (!host || !start || (ownerStartTime != null && String(ownerStartTime) !== start)) throw error('PROCESS_IDENTITY_UNVERIFIED');
    // Deliberately reject child-on-acquire: admission must COMMIT before spawn.
    if (childPid != null || childStartTime != null) throw error('SESSION_BIND_AFTER_ACQUIRE_REQUIRED');
    const info = { leaseId: crypto.randomUUID(), workerToken: crypto.randomUUID(), sessionKey: key, accountId, ownerStartTime: start, childStartTime: null, acquiredAt: Date.now() };
    // Metadata may contain cookies/tokens: never persist or expose it.
    void meta;
    await this._transaction(async client => {
      const processes = scanProcesses();
      const { rows } = await this._reconcile(client, await this._rows(client), processes, host);
      if (rows.some(r => (accountId != null && r.account_id === accountId) || r.session_key === key)) throw error('DUPLICATE_SESSION_LEASE');
      const { total } = this._snapshot(rows, processes, host);
      if (total >= MAX_PROJECT_SESSIONS) throw Object.assign(error('MAX_PROJECT_SESSIONS_EXCEEDED'), { activeCount: total, maxLimit: MAX_PROJECT_SESSIONS });
      await client.query(`INSERT INTO public.session_leases(lease_id,worker_token,account_id,session_key,node_pid,owner_starttime,host_identity,lease_state,acquired_at,heartbeat_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,'reserved',$8,$8)`, [info.leaseId, info.workerToken, accountId, key, process.pid, start, host, info.acquiredAt]);
    });
    this.localTokens.set(info.leaseId, info.workerToken);
    return info;
  }
  _owns(row, token) {
    return Boolean(row && token && row.worker_token === token && row.node_pid === process.pid && row.host_identity === hostIdentity() && row.owner_starttime && row.owner_starttime === getPidStartTime(process.pid));
  }
  async prepareChildSpawn(leaseId, workerToken = this.localTokens.get(leaseId)) {
    return this._transaction(async client => {
      const row = await this._leaseRow(client, leaseId);
      if (!this._owns(row, workerToken)) throw error('LEASE_NOT_FOUND');
      if (row.lease_state !== 'reserved' || row.child_pid) throw error('SESSION_SPAWN_ALREADY_PREPARED');
      await client.query("UPDATE public.session_leases SET lease_state='spawning',heartbeat_at=$1 WHERE lease_id=$2 AND worker_token=$3", [Date.now(), leaseId, workerToken]);
      return true;
    });
  }
  // Caller certification: invoke only when spawn() never returned a PID. Never
  // call after a binding timeout/error; that outcome must retain its reservation.
  async cancelChildSpawn(leaseId, workerToken = this.localTokens.get(leaseId)) {
    return this._transaction(async client => {
      const row = await this._leaseRow(client, leaseId);
      if (!this._owns(row, workerToken) || row.child_pid || row.lease_state !== 'spawning') return false;
      await client.query("UPDATE public.session_leases SET lease_state='reserved' WHERE lease_id=$1 AND worker_token=$2", [leaseId, workerToken]);
      return true;
    });
  }
  async bindChildProcess(leaseId, childPid, childStartTime = undefined, workerToken = this.localTokens.get(leaseId)) {
    if (!Number.isSafeInteger(childPid) || childPid <= 0 || childPid === process.pid) throw error('INVALID_CHILD_PID');
    return this._transaction(async client => {
      const row = await this._leaseRow(client, leaseId);
      if (!this._owns(row, workerToken)) throw error('LEASE_NOT_FOUND');
      const processes = scanProcesses();
      if (childStartTime != null && String(childStartTime) !== getPidStartTime(childPid)) throw error('PROCESS_IDENTITY_UNVERIFIED');
      if (row.child_pid && childStatus(row, processes, hostIdentity()) !== 'dead') {
        if (row.child_pid === childPid && row.child_starttime === getPidStartTime(childPid)) return true;
        throw error('SESSION_CHILD_ALREADY_BOUND');
      }
      // One lease authorizes exactly one spawn. A new child requires a new
      // committed lease/spawn intent, even when the old child is proven dead.
      if (row.child_pid) throw error('SESSION_CHILD_ALREADY_BOUND');
      if (row.lease_state !== 'spawning') throw error('SESSION_SPAWN_NOT_PREPARED');
      const stat = readProcStat(childPid);
      if (!stat.starttime || ['Z', 'X', 'x'].includes(stat.state) || (childStartTime != null && String(childStartTime) !== stat.starttime)) throw error('PROCESS_IDENTITY_UNVERIFIED');
      // DirectX uses detached:true. Require a new group AND session with direct
      // parentage so unrelated/recycled processes cannot become a child receipt.
      if (stat.ppid !== process.pid || stat.pgid !== childPid || stat.sid !== childPid) throw error('SESSION_PRIVATE_CHILD_REQUIRED');
      const next = { ...row, child_pid: childPid, child_starttime: stat.starttime, child_pgid: stat.pgid, child_sid: stat.sid, descendant_identities: [] };
      await client.query(`UPDATE public.session_leases SET child_pid=$1,child_starttime=$2,child_pgid=$3,child_sid=$4,descendant_identities=$5::jsonb,lease_state='bound',heartbeat_at=$6
        WHERE lease_id=$7 AND worker_token=$8`, [childPid, stat.starttime, stat.pgid, stat.sid, JSON.stringify(descendantIdentities(next, processes)), Date.now(), leaseId, workerToken]);
      return true;
    });
  }
  async updateChildPid(...args) { return this.bindChildProcess(...args); }
  async heartbeat(leaseId, workerToken = this.localTokens.get(leaseId)) {
    if (!leaseId) return false;
    return this._transaction(async client => {
      const row = await this._leaseRow(client, leaseId);
      if (!this._owns(row, workerToken)) return false;
      return (await client.query('UPDATE public.session_leases SET heartbeat_at=$1 WHERE lease_id=$2 AND worker_token=$3', [Date.now(), leaseId, workerToken])).rowCount > 0;
    });
  }
  async release(leaseId, workerToken = this.localTokens.get(leaseId)) {
    if (!leaseId) return false;
    const released = await this._transaction(async client => {
      const row = await this._leaseRow(client, leaseId);
      if (!this._owns(row, workerToken)) return false;
      let processes;
      try { processes = scanProcesses(); } catch (err) { if (err.code === 'PROCESS_VISIBILITY_UNVERIFIED') return false; throw err; }
      if (childStatus(row, processes, hostIdentity()) !== 'dead') return false;
      return (await client.query('DELETE FROM public.session_leases WHERE lease_id=$1 AND worker_token=$2', [leaseId, workerToken])).rowCount > 0;
    });
    if (released) this.localTokens.delete(leaseId);
    return released;
  }
  async reconcileOrphans() {
    return this._transaction(async client => {
      const processes = scanProcesses(), host = hostIdentity();
      const { rows, purged } = await this._reconcile(client, await this._rows(client), processes, host);
      return { purged, trackedChildPids: new Set(rows.filter(r => r.child_pid && r.host_identity === host && childStatus(r, processes, host) !== 'dead').map(r => r.child_pid)) };
    });
  }
  async getAudit() {
    return this._transaction(async client => {
      const processes = scanProcesses(), host = hostIdentity();
      const { rows } = await this._reconcile(client, await this._rows(client), processes, host);
      const { untracked, total } = this._snapshot(rows, processes, host);
      return { maxLimit: MAX_PROJECT_SESSIONS, activeCount: total, dbLeaseCount: rows.length, untrackedProcessCount: untracked,
        availableSlots: Math.max(0, MAX_PROJECT_SESSIONS - total), leases: rows.map(r => ({
          leaseId: r.lease_id, accountId: r.account_id, sessionKey: r.session_key, nodePid: r.node_pid, ownerStartTime: r.owner_starttime,
          childPid: r.child_pid, childStartTime: r.child_starttime, state: r.lease_state,
          nodeAlive: r.host_identity !== host || !['dead', 'reused'].includes(processStatus(r.node_pid, r.owner_starttime)),
          childAlive: r.child_pid ? childStatus(r, processes, host) !== 'dead' : null,
          ageMs: Math.max(0, Date.now() - Number(r.acquired_at)), heartbeatAgeMs: Math.max(0, Date.now() - Number(r.heartbeat_at)) })) };
    });
  }
  async countActive() { return (await this.getAudit()).activeCount; }
}
let defaultRegistry;
function getRegistry() { return defaultRegistry || (defaultRegistry = new SessionGuardRegistry()); }
async function acquireSession(options = {}) {
  const reg = options.registry || getRegistry();
  const info = await reg.acquire(options);
  let released = false, timer, heartbeatInFlight = false;
  const heartbeat = async () => released ? false : reg.heartbeat(info.leaseId, info.workerToken);
  timer = setInterval(async () => {
    if (released || heartbeatInFlight) return;
    heartbeatInFlight = true;
    try { await heartbeat(); } catch { /* Retain lease on failure; never infer death from heartbeat age. */ }
    finally { heartbeatInFlight = false; }
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  const release = async () => {
    if (released) return false;
    if (!await reg.release(info.leaseId, info.workerToken)) return false;
    released = true; clearInterval(timer); return true;
  };
  const bindChildProcess = async (pid, starttime) => {
    if (released) throw error('SESSION_LEASE_RELEASED');
    await reg.bindChildProcess(info.leaseId, pid, starttime, info.workerToken);
    info.childPid = pid; info.childStartTime = getPidStartTime(pid);
    return true;
  };
  const prepareChildSpawn = async () => {
    if (released) throw error('SESSION_LEASE_RELEASED');
    return reg.prepareChildSpawn(info.leaseId, info.workerToken);
  };
  const cancelChildSpawn = async () => released ? false : reg.cancelChildSpawn(info.leaseId, info.workerToken);
  return { leaseId: info.leaseId, sessionKey: info.sessionKey, accountId: info.accountId, lease: info, release, heartbeat,
    prepareChildSpawn, cancelChildSpawn, bindChild: bindChildProcess, bindChildProcess };
}
async function countActiveSessions(options = {}) { return (options.registry || getRegistry()).countActive(); }
async function getSessionAudit(options = {}) { return (options.registry || getRegistry()).getAudit(); }
// Retained name, deliberately no destructive reset/unlink behavior.
async function resetSessionsForTest(options) {
  if (!isTestEnvironment()) throw error('RESET_FORBIDDEN_OUTSIDE_TEST');
  options = makeOptions(options);
  if (!options.expectedDatabase || !options.pool) throw error('SESSION_TEST_DATABASE_REQUIRED');
  const registry = new SessionGuardRegistry(options);
  await registry.reconcileOrphans();
  if (await registry.countActive()) throw error('SESSION_RESET_LIVE_LEASES_FORBIDDEN');
  if (defaultRegistry) await defaultRegistry.close();
  defaultRegistry = registry;
  return true;
}
module.exports = { MAX_PROJECT_SESSIONS, SessionGuardRegistry, acquireSession, countActiveSessions, getSessionAudit, resetSessionsForTest,
  getPidStartTime, isPidAlive, isProcessAlive, isTargetingProdSessionDb, assertSessionDbMutationAllowed, getSessionPgConfig, installSessionGuardSchema };
