'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { Pool } = require('pg');
const { isClaimable, isProvenPreDispatch, normalizedPostText, protectedTextKeys, MAX_PRE_DISPATCH_RETRIES } = require('./queue');
const { accountCapacity, riyadhDay, estimateProjectedCycle } = require('./quota');
const { evaluateAccountUse } = require('./accounts');
const isTestEnvironment = () => Boolean(
  process.env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT ||
  process.env.npm_lifecycle_event === 'test' || process.env.YJ_TEST_MODE === '1' ||
  [...process.execArgv, ...process.argv].some(arg => typeof arg === 'string' && arg.includes('test'))
);
const pgStorage = require('./pgStorage');
const PG_SCHEMA_SQL = pgStorage.PG_SCHEMA_DDL;
const { readPgPassword: readSecurePgPassword } = pgStorage;


function json(value) {
  const encoded = JSON.stringify(value == null ? null : value);
  if (encoded === undefined) throw new TypeError('Value is not JSON serializable');
  return encoded;
}

function parse(value, fallback = null) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  }
  return value;
}

function textKey(value) {
  return typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase() : '';
}

function clonePostValue(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const out = new Array(value.length);
    for (let i = 0; i < value.length; i++) out[i] = clonePostValue(value[i]);
    return out;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return structuredClone(value);
  const out = {};
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const entry = value[key];
    out[key] = entry !== null && typeof entry === 'object' ? clonePostValue(entry) : entry;
  }
  return out;
}

function computeMinimalPositions(currentItems, postPositions, startNextPosition = 0) {
  const n = currentItems.length;
  const assigned = new Array(n);
  if (n === 0) return { positions: assigned, nextPosition: startNextPosition };

  let nextPos = Math.max(0, Number.isSafeInteger(startNextPosition) ? startNextPosition : 0);
  if (nextPos >= 1_000_000_000) {
    for (let i = 0; i < n; i++) assigned[i] = i;
    return { positions: assigned, nextPosition: n };
  }

  const prevPos = new Array(n);
  const tailsIdx = [];
  const tailsVal = [];
  const parent = new Int32Array(n).fill(-1);

  for (let i = 0; i < n; i++) {
    const id = String(currentItems[i]?.id);
    const p = postPositions.get(id);
    const valid = Number.isSafeInteger(p) && p >= 0 ? p : -1;
    prevPos[i] = valid;
    if (valid < 0) continue;
    let lo = 0;
    let hi = tailsVal.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (tailsVal[mid] < valid) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) parent[i] = tailsIdx[lo - 1];
    if (lo === tailsVal.length) {
      tailsVal.push(valid);
      tailsIdx.push(i);
    } else {
      tailsVal[lo] = valid;
      tailsIdx[lo] = i;
    }
  }

  const isAnchor = new Uint8Array(n);
  if (tailsIdx.length > 0) {
    let cur = tailsIdx[tailsIdx.length - 1];
    while (cur !== -1) {
      isAnchor[cur] = 1;
      cur = parent[cur];
    }
  }

  const anchors = [];
  for (let i = 0; i < n; i++) {
    if (isAnchor[i]) {
      anchors.push(i);
      assigned[i] = prevPos[i];
    }
  }

  let anchorCursor = 0;
  let prevAssigned = -1;
  let i = 0;
  while (i < n) {
    if (isAnchor[i]) {
      if (assigned[i] <= prevAssigned) {
        assigned[i] = prevAssigned + 1;
      }
      prevAssigned = assigned[i];
      if (assigned[i] >= nextPos) nextPos = assigned[i] + 1;
      anchorCursor++;
      i++;
      continue;
    }

    const runStart = i;
    while (i < n && !isAnchor[i]) i++;
    const runEnd = i;
    const count = runEnd - runStart;
    const nextAnchorIdx = anchorCursor < anchors.length ? anchors[anchorCursor] : -1;
    if (nextAnchorIdx === -1) {
      for (let k = runStart; k < runEnd; k++) {
        const candidate = Math.max(prevAssigned + 1, nextPos);
        assigned[k] = candidate;
        prevAssigned = candidate;
        nextPos = candidate + 1;
      }
    } else {
      const gap = prevPos[nextAnchorIdx] - prevAssigned - 1;
      if (gap >= count) {
        const span = prevPos[nextAnchorIdx] - prevAssigned;
        for (let j = 0; j < count; j++) {
          assigned[runStart + j] = prevAssigned + Math.floor(((j + 1) * span) / (count + 1));
        }
        prevAssigned = assigned[runEnd - 1];
        if (prevAssigned >= nextPos) nextPos = prevAssigned + 1;
      } else {
        for (let k = runStart; k < runEnd; k++) {
          prevAssigned += 1;
          assigned[k] = prevAssigned;
        }
        if (prevAssigned >= nextPos) nextPos = prevAssigned + 1;
      }
    }
  }

  return { positions: assigned, nextPosition: nextPos };
}

function riyadhDayUtcBounds(quotaDay) {
  const startMs = Date.parse(`${quotaDay}T00:00:00.000+03:00`);
  if (!Number.isFinite(startMs)) return { utcStart: '1970-01-01T00:00:00.000Z', utcEnd: '1970-01-02T00:00:00.000Z' };
  return {
    utcStart: new Date(startMs).toISOString(),
    utcEnd: new Date(startMs + 86400000).toISOString()
  };
}

function readPgPassword(secretPath) {
  if (!secretPath || secretPath === pgStorage.DEFAULT_SECRET_PATH) {
    if (process.env.PGPASSWORD) return process.env.PGPASSWORD;
  }
  try { return readSecurePgPassword(secretPath); } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

function validTimeoutMs(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function validWorkMem(value, fallback = '32MB') {
  const s = String(value || '').trim();
  return /^\d+(?:kB|MB|GB|B)?$/i.test(s) ? s : fallback;
}

function validJit(value, fallback = 'off') {
  const s = String(value ?? '').trim().toLowerCase();
  return s === 'off' || s === 'on' ? s : fallback;
}

function resolvePgConfig(overrides = {}) {
  const schema = overrides.schema || process.env.PGSCHEMA || 'public';
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) {
    throw new Error(`Invalid PostgreSQL schema identifier: ${schema}`);
  }
  const database = overrides.database || process.env.PGDATABASE || (isTestEnvironment() ? 'yj_autopost_test' : 'yj_autopost');
  const statementTimeoutMs = validTimeoutMs(overrides.statementTimeoutMs ?? process.env.PG_STATEMENT_TIMEOUT_MS, 15000);
  const lockTimeoutMs = validTimeoutMs(overrides.lockTimeoutMs ?? process.env.PG_LOCK_TIMEOUT_MS, 10000);
  const idleInTxTimeoutMs = validTimeoutMs(overrides.idleInTransactionSessionTimeoutMs ?? process.env.PG_IDLE_IN_TX_TIMEOUT_MS, 30000);
  const workMem = validWorkMem(overrides.workMem || process.env.PG_WORK_MEM, '32MB');
  const jit = validJit(overrides.jit ?? process.env.PG_JIT, 'off');
  const options = overrides.options || (
    `-c search_path=${schema},public -c TimeZone=Asia/Riyadh` +
    ` -c statement_timeout=${statementTimeoutMs}` +
    ` -c lock_timeout=${lockTimeoutMs}` +
    ` -c idle_in_transaction_session_timeout=${idleInTxTimeoutMs}` +
    ` -c work_mem=${workMem}` +
    ` -c jit=${jit}`
  );
  return {
    host: overrides.host || process.env.PGHOST || '127.0.0.1',
    port: Number(overrides.port || process.env.PGPORT || 5432),
    user: overrides.user || process.env.PGUSER || 'yj_bot_app',
    password: overrides.password ?? readPgPassword(overrides.secretPath || process.env.PG_PASSWORD_FILE),
    database,
    schema,
    max: Number(overrides.max || process.env.PGPOOL_MAX || 20),
    idleTimeoutMillis: Number(overrides.idleTimeoutMillis || 30000),
    connectionTimeoutMillis: Number(overrides.connectionTimeoutMillis || 5000),
    options
  };
}

function assertPgMutationAllowed(pgConfig) {
  if (isTestEnvironment() && pgConfig?.database === 'yj_autopost') {
    const err = new Error('PROD_DB_MUTATION_FORBIDDEN_IN_TEST: Tests are strictly forbidden from mutating production PostgreSQL database yj_autopost (public schema).');
    err.code = 'PROD_DB_MUTATION_FORBIDDEN_IN_TEST';
    throw err;
  }
}

function rowToPostItem(row) {
  const base = parse(row.source_json, {}) || {};
  const item = {
    ...base,
    id: String(row.id),
    payload: parse(row.payload_json, base.payload || {}),
    state: row.state || base.state || 'pending'
  };
  if (row.content_hash != null) item.contentHash = row.content_hash;
  if (row.created_at != null) item.createdAt = row.created_at;
  if (row.reason !== undefined && (row.reason != null || Object.hasOwn(base, 'reason'))) item.reason = row.reason;
  if (row.published_at != null) item.publishedAt = row.published_at;
  if (row.url != null) item.url = row.url;
  if (row.tweet_id != null) item.tweetId = String(row.tweet_id);
  if (row.account_id != null) item.accountId = row.account_id;
  if (row.account_username != null) item.accountUsername = row.account_username;
  if (row.claimed_at != null) item.claimedAt = row.claimed_at;
  else delete item.claimedAt;
  if (row.pre_dispatch_retries > 0 || Object.hasOwn(base, 'preDispatchRetries')) {
    item.preDispatchRetries = Number(row.pre_dispatch_retries || 0);
  }
  const jsonFields = [
    ['attempt', 'attempt_json'],
    ['archivedAttempt', 'archived_attempt_json'],
    ['archivedAttempts', 'archived_attempts_json'],
    ['outcome', 'outcome_json'],
    ['result', 'result_json'],
    ['recoveryHistory', 'recovery_history_json'],
    ['failureDiagnostic', 'failure_diagnostic_json'],
    ['ownerAssistedPackage', 'owner_assisted_package_json']
  ];
  for (const [prop, col] of jsonFields) {
    if (row[col] != null) item[prop] = parse(row[col]);
    else delete item[prop];
  }
  return item;
}

function postItemToParams(item, position) {
  const payload = item.payload || {};
  const text = typeof payload.text === 'string' ? payload.text : null;
  return [
    String(item.id),
    Number(position),
    item.contentHash || null,
    text,
    textKey(text),
    json(payload),
    item.state || 'unknown',
    item.createdAt || null,
    item.reason ?? null,
    item.publishedAt || null,
    item.url || null,
    item.tweetId == null ? null : String(item.tweetId),
    item.accountId || null,
    item.accountUsername || null,
    item.claimedAt || null,
    Number.isSafeInteger(item.preDispatchRetries) ? item.preDispatchRetries : 0,
    isClaimable(item) ? 1 : 0,
    item.attempt ? json(item.attempt) : null,
    item.archivedAttempt ? json(item.archivedAttempt) : null,
    Array.isArray(item.archivedAttempts) ? json(item.archivedAttempts) : null,
    item.outcome !== undefined ? json(item.outcome) : null,
    item.result !== undefined ? json(item.result) : null,
    Array.isArray(item.recoveryHistory) ? json(item.recoveryHistory) : null,
    item.failureDiagnostic ? json(item.failureDiagnostic) : null,
    item.ownerAssistedPackage ? json(item.ownerAssistedPackage) : null,
    json(item)
  ];
}

function rowToAccount(row) {
  const base = parse(row.source_json, {}) || {};
  const acc = {
    ...base,
    id: String(row.id),
    enabled: Boolean(row.enabled),
    failures: Number(row.failures || 0)
  };
  if (row.label != null) acc.label = row.label;
  if (row.username != null) acc.username = row.username;
  if (row.user_id != null) acc.userId = String(row.user_id);
  if (row.cookie_file != null) acc.cookieFile = row.cookie_file;
  if (row.verified_at != null) acc.verifiedAt = row.verified_at;
  if (row.vpn_resource != null) acc.vpnResource = row.vpn_resource;
  if (row.quota_json != null) acc.quota = parse(row.quota_json);
  if (row.delay_ms != null) acc.delayMs = Number(row.delay_ms);
  if (row.exit_ip != null) acc.exitIp = row.exit_ip;
  else delete acc.exitIp;
  if (row.status != null) acc.status = row.status;
  if (row.check_generation != null) acc.checkGeneration = row.check_generation;
  return acc;
}

function accountToParams(item, position) {
  return [
    String(item.id),
    Number(position),
    item.label || null,
    item.username || null,
    item.userId == null ? null : String(item.userId),
    item.enabled === false ? 0 : 1,
    item.cookieFile || null,
    item.verifiedAt || null,
    item.vpnResource || null,
    item.quota == null ? null : json(item.quota),
    item.delayMs == null ? null : Number(item.delayMs),
    item.exitIp || null,
    item.status || null,
    item.checkGeneration || null,
    Number.isSafeInteger(item.failures) ? item.failures : 0,
    json(item)
  ];
}

// Registry rows are authoritative; legacy aliases describe dashboards only.
// Never take typed ownership from a generic user/navigation/state snapshot.
function projectUiOwners(ui, legacyRows, typedRows) {
  const registry = {}, dashboards = {};
  for (const row of legacyRows) {
    const owner = parse(row.payload_json, {});
    if (owner && owner.kind !== 'accounts') {
      registry[row.chat_id] = { dashboard: owner };
      dashboards[row.chat_id] = owner;
    }
  }
  for (const row of typedRows) {
    const owner = parse(row.payload_json, {});
    registry[row.chat_id] ||= {};
    registry[row.chat_id][row.kind] = owner;
    if (row.kind === 'dashboard') dashboards[row.chat_id] = owner;
  }
  ui.interfacePanelsByChatId = structuredClone(registry);
  ui.dashboards = structuredClone(dashboards);
  ui.activePanelsByChatId = structuredClone(dashboards);
  for (const user of Object.values(ui.users || {})) {
    delete user.panel;
    delete user.interfacePanelsByChatId;
    delete user.activePanelsByChatId;
    delete user.dashboards;
    if (dashboards[String(user.chatId)]) user.panel = structuredClone(dashboards[String(user.chatId)]);
  }
  return ui;
}

function samePanelTuple(a, b) {
  return Boolean(a && b && a.messageId === b.messageId && a.generation === b.generation);
}

async function saveLegacyUiPanel(client, chatId, panel) {
  if (panel?.generation != null || panel?.kind === 'accounts' || !Number.isSafeInteger(panel?.messageId) || panel.messageId <= 0) return;
  // Never downgrade a canonical owner, including a generation-less owner
  // explicitly admitted via saveUiPanel. Old snapshots do not carry CAS rights.
  await client.query(`INSERT INTO telegram_panels(chat_id, message_id, signature, payload_json, updated_at)
    SELECT $1, $2, $3, $4, $5 WHERE NOT EXISTS (
      SELECT 1 FROM telegram_interface_panels WHERE chat_id = $1 AND kind = 'dashboard'
    ) ON CONFLICT(chat_id) DO UPDATE SET message_id = EXCLUDED.message_id,
      signature = EXCLUDED.signature, payload_json = EXCLUDED.payload_json, updated_at = EXCLUDED.updated_at
    WHERE telegram_panels.payload_json::jsonb->>'generation' IS NULL AND telegram_panels.message_id < EXCLUDED.message_id`,
  [String(chatId), panel.messageId, panel.signature || null, json(panel), new Date().toISOString()]);
}

async function projectCommittedUiOwners(client, ui) {
  const [legacy, typed] = await Promise.all([
    client.query('SELECT chat_id, payload_json FROM telegram_panels'),
    client.query('SELECT chat_id, kind, payload_json FROM telegram_interface_panels')
  ]);
  return projectUiOwners(ui, legacy.rows, typed.rows);
}

class PgStore {
  constructor(fileOrOptions = {}, initial = {}, options = {}) {
    let opts = options;
    let filePath = null;
    if (typeof fileOrOptions === 'string') {
      filePath = path.resolve(fileOrOptions);
    } else if (fileOrOptions && typeof fileOrOptions === 'object') {
      opts = { ...fileOrOptions, ...options };
      filePath = opts.file ? path.resolve(opts.file) : null;
      if (opts.initial) initial = opts.initial;
    }
    this.isPostgres = true;
    const dataDir = opts.dataDir || (filePath ? path.dirname(filePath) : path.join(process.cwd(), 'data'));
    this.dataDir = dataDir;
    this.file = filePath || path.join(dataDir, 'pg-store');
    this.key = this.file;
    this.readOnly = Boolean(opts.readOnly);
    this.initial = structuredClone(initial || {
      items: [],
      cycle: { state: 'stopped', runId: null },
      accounts: [],
      settings: {},
      burnedSubnets: ['187.40.234.0/24'],
      forensicLogs: []
    });
    this.pgConfig = resolvePgConfig(opts.pgConfig || {});
    this.ownsPool = !opts.pool;
    this.pool = opts.pool || new Pool(this.pgConfig);
    if (this.ownsPool && this.pool) {
      this.pool._yjConfig ||= { ...this.pgConfig };
      this.pool.on('error', err => {
        try {
          const { logStructured, sanitizeError } = require('./structuredLogger');
          logStructured(null, {
            level: 'warn',
            component: 'pg_store',
            event: 'pg_idle_client_error',
            operation: 'pool.error',
            result: 'suppressed',
            sanitizedError: sanitizeError(err)
          });
        } catch {}
      });
    }
    this.closed = false;
    this.initialized = false;
    this.initPromise = null;
    this.performanceMetrics = [];
    this.mutationListeners = new Set();
    this.mutationGeneration = 0;
    this.loadSequence = 0;
    this.publishedLoadSequence = 0;
    this._writeQueue = Promise.resolve();
    this._uiQueue = Promise.resolve();
    this._postsById = new Map();
    this._postPositions = new Map();
    this._postOrder = [];
    this._orderedItems = [];
    this._shallowSnapById = new Map();
    this._sourceJsonById = new Map();
    this._postCacheRevision = 0;
    this._postCacheResetRevision = 0;
    this._postCacheHydrated = false;
    this._nextPosition = 0;
    this._cachedRunItemIds = null;
    this._cachedRunIdForItems = null;
    this._snapshotInFlight = new Map();
    this._dashboardHeavyCache = null;

    if (!this.readOnly) {
      const dir = path.dirname(this.file);
      try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      } catch {}
    }
  }

  _serialize(lane, fn) {
    const queueKey = lane === 'ui' ? '_uiQueue' : '_writeQueue';
    const enqueuedAt = performance.now();
    const prev = this[queueKey] || Promise.resolve();
    const run = prev.catch(() => {}).then(() => {
      const queueWaitMs = performance.now() - enqueuedAt;
      return fn({ queueWaitMs });
    });
    this[queueKey] = run.catch(() => {});
    return run;
  }

  _recordPerformance(kind, metrics = {}) {
    const entry = { kind, ...metrics };
    this.performanceMetrics.push(entry);
    if (this.performanceMetrics.length > 128) this.performanceMetrics.shift();
    return entry;
  }

  onMutation(listener) {
    this.mutationListeners.add(listener);
    return () => this.mutationListeners.delete(listener);
  }

  _notifyMutation(state) {
    for (const listener of this.mutationListeners) {
      try { listener(state); } catch {}
    }
  }

  async _ensureInitialized() {
    if (this.closed) throw new Error('Store is closed');
    if (this.initialized) return;
    if (!this.readOnly) {
      assertPgMutationAllowed(this.pgConfig);
    }
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      if (!this.readOnly) {
        assertPgMutationAllowed(this.pgConfig);
      }
      const client = await this.pool.connect();
      let clientErr;
      try {
        if (!this.readOnly) {
          client._yjConfig ||= { ...this.pgConfig };
          if (this.pgConfig.schema && this.pgConfig.schema !== 'public') {
            await client.query(`CREATE SCHEMA IF NOT EXISTS "${this.pgConfig.schema}"`);
            await client.query(`SET search_path TO "${this.pgConfig.schema}", public`);
          }
          await pgStorage.ensurePgSchema(client, { allowProductionMigration: Boolean(this.pgConfig.allowProductionMigration) });
        }
        // Check if cycle_state exists; if empty and not readOnly, seed from this.initial
        const cycleRes = await client.query('SELECT count(*)::int AS n FROM cycle_state');
        const postCountRes = await client.query('SELECT count(*)::int AS n FROM posts');
        if (cycleRes.rows[0].n === 0 && postCountRes.rows[0].n === 0 && !this.readOnly) {
          await client.query('BEGIN');
          try {
            await this._seedInitialState(client, this.initial);
            await client.query('COMMIT');
          } catch (err) {
            await client.query('ROLLBACK');
            throw err;
          }
        }
        await this._hydratePostsCache(client);
        this.initialized = true;
      } catch (err) {
        clientErr = err;
        throw err;
      } finally {
        client.release(clientErr);
        this.initPromise = null;
      }
    })();
    return this.initPromise;
  }

  async _seedInitialState(client, state) {
    const cycle = state.cycle || { state: 'stopped', runId: null };
    await client.query(
      'INSERT INTO cycle_state(id, state, run_id, started_at, updated_at, reason, source_json) VALUES(1, $1, $2, $3, $4, $5, $6) ON CONFLICT(id) DO NOTHING',
      [cycle.state || 'stopped', cycle.runId || null, cycle.startedAt || null, cycle.updatedAt || null, cycle.reason || null, json(cycle)]
    );
    for (const [key, value] of Object.entries(state.settings || {})) {
      await client.query('INSERT INTO settings(key, value_json) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value_json = EXCLUDED.value_json', [key, json(value)]);
    }
    const accounts = state.accounts || [];
    for (let i = 0; i < accounts.length; i++) {
      await client.query(
        `INSERT INTO accounts(id, position, label, username, user_id, enabled, cookie_file, verified_at, vpn_resource, quota_json, delay_ms, exit_ip, status, check_generation, failures, source_json)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT(id) DO NOTHING`,
        accountToParams(accounts[i], i)
      );
    }
    const items = state.items || [];
    for (let i = 0; i < items.length; i += 250) {
      const slice = items.slice(i, i + 250);
      const valuesSql = [];
      const allParams = [];
      let pIdx = 1;
      for (let j = 0; j < slice.length; j++) {
        const params = postItemToParams(slice[j], i + j);
        const placeholders = [];
        for (let k = 0; k < 26; k++) placeholders.push(`$${pIdx++}`);
        valuesSql.push(`(${placeholders.join(',')})`);
        allParams.push(...params);
      }
      await client.query(
        `INSERT INTO posts(id, position, content_hash, text, text_key, payload_json, state, created_at, reason, published_at, url, tweet_id, account_id, account_username, claimed_at, pre_dispatch_retries, claimable, attempt_json, archived_attempt_json, archived_attempts_json, outcome_json, result_json, recovery_history_json, failure_diagnostic_json, owner_assisted_package_json, source_json)
         VALUES ${valuesSql.join(',')} ON CONFLICT(id) DO NOTHING`,
        allParams
      );
    }
    if (items.length >= 100) {
      await client.query('ANALYZE posts');
    }
    const burned = state.burnedSubnets || [];
    for (const [idx, entry] of burned.entries()) {
      const subnet = typeof entry === 'string' ? entry : entry?.subnet;
      if (!subnet) continue;
      await client.query(
        'INSERT INTO burned_subnets(subnet, position, created_at, source_json) VALUES($1, $2, $3, $4) ON CONFLICT(subnet) DO NOTHING',
        [subnet, idx, new Date().toISOString(), json(entry)]
      );
    }
    await client.query(
      'INSERT INTO operational_state(key, value_json) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value_json = EXCLUDED.value_json',
      ['burnedSubnets', json(burned)]
    );
    const ui = structuredClone(state.telegramUi || {});
    await pgStorage.importUiOwners(client, ui);
    for (const [key, user] of Object.entries(ui.users || {})) {
      await client.query(`INSERT INTO telegram_users(user_key, chat_id, user_id, payload_json, updated_at)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_key) DO NOTHING`,
      [key, user.chatId == null ? null : String(user.chatId), user.userId == null ? null : String(user.userId), json(user), new Date().toISOString()]);
    }
    for (const [chatId, owner] of Object.entries(ui.dashboards)) {
      await client.query(`INSERT INTO telegram_panels(chat_id, message_id, signature, payload_json, updated_at)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(chat_id) DO NOTHING`,
      [chatId, owner.messageId, owner.signature || null, json(owner), new Date().toISOString()]);
    }
  }

  _captureItemSnap(item) {
    return {
      contentHash: item.contentHash,
      createdAt: item.createdAt,
      state: item.state,
      reason: item.reason,
      publishedAt: item.publishedAt,
      url: item.url,
      tweetId: item.tweetId,
      accountId: item.accountId,
      accountUsername: item.accountUsername,
      claimedAt: item.claimedAt,
      completedAt: item.completedAt,
      error: item.error,
      requeueApproved: item.requeueApproved,
      preDispatchRetries: item.preDispatchRetries,
      attemptPhase: item.attempt?.phase,
      attemptToken: item.attempt?.token,
      attemptJson: json(item.attempt ?? null),
      archivedAttemptJson: json(item.archivedAttempt ?? null),
      archivedAttemptsJson: json(item.archivedAttempts ?? null),
      outcomeJson: json(item.outcome ?? null),
      resultJson: json(item.result ?? null),
      recoveryHistoryJson: json(item.recoveryHistory ?? null),
      failureDiagnosticJson: json(item.failureDiagnostic ?? null),
      ownerAssistedPackageJson: json(item.ownerAssistedPackage ?? null),
      payloadJson: json(item.payload ?? null),
      keyCount: Object.keys(item).length
    };
  }

  _isItemChanged(item, snap) {
    if (!snap) return true;
    return (
      item.contentHash !== snap.contentHash ||
      item.createdAt !== snap.createdAt ||
      item.state !== snap.state ||
      item.reason !== snap.reason ||
      item.publishedAt !== snap.publishedAt ||
      item.url !== snap.url ||
      item.tweetId !== snap.tweetId ||
      item.accountId !== snap.accountId ||
      item.accountUsername !== snap.accountUsername ||
      item.claimedAt !== snap.claimedAt ||
      item.completedAt !== snap.completedAt ||
      item.error !== snap.error ||
      item.requeueApproved !== snap.requeueApproved ||
      item.preDispatchRetries !== snap.preDispatchRetries ||
      json(item.attempt ?? null) !== snap.attemptJson ||
      item.attempt?.phase !== snap.attemptPhase ||
      item.attempt?.token !== snap.attemptToken ||
      json(item.archivedAttempt ?? null) !== snap.archivedAttemptJson ||
      json(item.archivedAttempts ?? null) !== snap.archivedAttemptsJson ||
      json(item.outcome ?? null) !== snap.outcomeJson ||
      json(item.result ?? null) !== snap.resultJson ||
      json(item.recoveryHistory ?? null) !== snap.recoveryHistoryJson ||
      json(item.failureDiagnostic ?? null) !== snap.failureDiagnosticJson ||
      json(item.ownerAssistedPackage ?? null) !== snap.ownerAssistedPackageJson ||
      json(item.payload ?? null) !== snap.payloadJson ||
      Object.keys(item).length !== snap.keyCount
    );
  }

  _rebuildOrderedItems() {
    this._orderedItems = this._postOrder.map(id => this._postsById.get(id)).filter(Boolean);
  }

  async _hydratePostsCache(client) {
    const res = await client.query('SELECT * FROM posts ORDER BY position ASC, id ASC');
    const clock = await client.query('SELECT revision, reset_revision FROM post_cache_clock WHERE id = 1');
    this._postCacheRevision = Number(clock?.rows?.[0]?.revision || 0);
    this._postCacheResetRevision = Number(clock?.rows?.[0]?.reset_revision || 0);
    this._postsById.clear();
    this._postPositions.clear();
    this._shallowSnapById.clear();
    this._postOrder = [];
    let maxPos = -1;
    for (const row of res.rows) {
      const item = rowToPostItem(row);
      const pos = Number(row.position);
      if (pos > maxPos) maxPos = pos;
      this._postsById.set(item.id, item);
      this._postPositions.set(item.id, pos);
      this._sourceJsonById.set(item.id, row.source_json);
      this._shallowSnapById.set(item.id, this._captureItemSnap(item));
      this._postOrder.push(item.id);
    }
    this._nextPosition = maxPos + 1;
    this._postCacheHydrated = true;
    this._rebuildOrderedItems();
  }

  async _syncPostsCache(client) {
    if (!this._postCacheHydrated) {
      await this._hydratePostsCache(client);
      return;
    }
    let clock;
    try {
      clock = await client.query('SELECT revision, reset_revision FROM post_cache_clock WHERE id = 1');
    } catch {
      await this._hydratePostsCache(client);
      return;
    }
    const currentRev = Number(clock.rows[0]?.revision || 0);
    const resetRev = Number(clock.rows[0]?.reset_revision || 0);
    if (resetRev > this._postCacheResetRevision || currentRev < this._postCacheRevision) {
      await this._hydratePostsCache(client);
      return;
    }
    if (currentRev === this._postCacheRevision) return;

    const changesRes = await client.query(
      `SELECT c.post_id AS cache_post_id, c.deleted, c.revision AS change_revision, p.*
       FROM post_cache_changes c
       LEFT JOIN posts p ON p.id = c.post_id
       WHERE c.revision > $1
       ORDER BY c.revision ASC`,
      [this._postCacheRevision]
    );

    let orderTouched = false;
    let deletedIds = null;
    for (const row of changesRes.rows) {
      const id = String(row.cache_post_id);
      if (row.deleted || row.id == null) {
        const had = this._postPositions.has(id) || this._postsById.has(id);
        this._postsById.delete(id);
        this._postPositions.delete(id);
        this._shallowSnapById.delete(id);
        this._sourceJsonById.delete(id);
        if (had) {
          if (!deletedIds) deletedIds = new Set();
          deletedIds.add(id);
          orderTouched = true;
        }
      } else {
        const item = rowToPostItem(row);
        const pos = Number(row.position);
        const prevPos = this._postPositions.get(item.id);
        this._postsById.set(item.id, item);
        this._postPositions.set(item.id, pos);
        this._sourceJsonById.set(item.id, row.source_json);
        this._shallowSnapById.set(item.id, this._captureItemSnap(item));
        if (prevPos === undefined) {
          this._postOrder.push(item.id);
          orderTouched = true;
        } else if (prevPos !== pos) {
          orderTouched = true;
        }
        if (deletedIds) deletedIds.delete(item.id);
        if (pos >= this._nextPosition) this._nextPosition = pos + 1;
      }
    }
    if (deletedIds && deletedIds.size > 0) {
      if (deletedIds.size === 1) {
        const [onlyId] = deletedIds;
        const idx = this._postOrder.indexOf(onlyId);
        if (idx !== -1) this._postOrder.splice(idx, 1);
      } else {
        this._postOrder = this._postOrder.filter(id => !deletedIds.has(id));
      }
    }
    this._postCacheRevision = currentRev;
    if (orderTouched) {
      this._postOrder.sort((a, b) => {
        const pa = this._postPositions.get(a) ?? 0;
        const pb = this._postPositions.get(b) ?? 0;
        return pa !== pb ? pa - pb : (a < b ? -1 : 1);
      });
    }
    this._rebuildOrderedItems();
  }

  async _readHeaderState(clientOrPool) {
    const res = await clientOrPool.query(`
      SELECT
        (SELECT row_to_json(c) FROM cycle_state c WHERE id = 1) AS cycle_row,
        COALESCE((SELECT json_agg(a ORDER BY a.position ASC, a.id ASC) FROM accounts a), '[]'::json) AS accounts_rows,
        COALESCE((SELECT json_agg(s ORDER BY s.key ASC) FROM settings s), '[]'::json) AS settings_rows,
        COALESCE((SELECT json_agg(q ORDER BY q.day ASC, q.account_id ASC) FROM quota q), '[]'::json) AS quota_rows,
        COALESCE((SELECT json_agg(op) FROM operational_state op), '[]'::json) AS op_rows,
        COALESCE((SELECT json_agg(o ORDER BY o.sequence_no ASC) FROM outbox o), '[]'::json) AS outbox_rows,
        COALESCE((SELECT json_agg(d ORDER BY d.sequence_no ASC, d.delivery_id ASC) FROM link_deliveries d), '[]'::json) AS deliveries_rows,
        COALESCE((SELECT json_agg(t ORDER BY t.sequence_no ASC, t.event_id ASC) FROM link_terminal_events t), '[]'::json) AS terminal_rows,
        COALESCE((SELECT json_agg(m ORDER BY m.position ASC, m.id ASC) FROM manual_links m), '[]'::json) AS manual_rows,
        COALESCE((SELECT json_agg(fo ORDER BY fo.position ASC, fo.id ASC) FROM forensic_outbox fo), '[]'::json) AS forensic_outbox_rows,
        COALESCE((SELECT json_agg(ae ORDER BY ae.position ASC, ae.id ASC) FROM audit_events ae), '[]'::json) AS audit_rows,
        COALESCE((SELECT json_agg(af ORDER BY af.position ASC, af.content_key ASC) FROM ambiguous_fences af), '[]'::json) AS fences_rows,
        COALESCE((SELECT json_agg(ts) FROM telegram_state ts WHERE ts.key <> 'telegramUi'), '[]'::json) AS tg_state_rows,
        COALESCE((SELECT json_agg(tu ORDER BY tu.user_key ASC) FROM telegram_users tu), '[]'::json) AS tg_users_rows,
        COALESCE((SELECT json_agg(tp ORDER BY tp.chat_id ASC) FROM telegram_panels tp), '[]'::json) AS tg_panels_rows,
        COALESCE((SELECT json_agg(ip ORDER BY ip.chat_id, ip.kind) FROM telegram_interface_panels ip), '[]'::json) AS tg_interface_rows,
        COALESCE((SELECT json_agg(ac) FROM account_checks ac), '[]'::json) AS account_checks_rows,
        COALESCE((SELECT json_agg(vs) FROM vpn_slots vs), '[]'::json) AS vpn_slots_rows,
        COALESCE((SELECT json_agg(bs ORDER BY bs.position ASC, bs.subnet ASC) FROM burned_subnets bs), '[]'::json) AS burned_rows
    `);
    const row = res.rows[0] || {};
    const opMap = new Map((row.op_rows || []).map(r => [r.key, parse(r.value_json)]));
    const tgStateMap = new Map((row.tg_state_rows || []).map(r => [r.key, parse(r.value_json)]));
    const cycleRow = row.cycle_row;
    const cycle = cycleRow
      ? { ...(parse(cycleRow.source_json, {}) || {}), state: cycleRow.state, runId: cycleRow.run_id }
      : { state: 'stopped', runId: null };
    if (cycleRow?.started_at) cycle.startedAt = cycleRow.started_at;
    if (cycleRow?.updated_at) cycle.updatedAt = cycleRow.updated_at;
    if (cycleRow?.reason != null) cycle.reason = cycleRow.reason;

    const accounts = (row.accounts_rows || []).map(rowToAccount);
    const settings = Object.fromEntries((row.settings_rows || []).map(r => [r.key, parse(r.value_json)]));

    const quota = {};
    for (const r of row.quota_rows || []) {
      quota[r.day] ||= {};
      quota[r.day][r.account_id] = Number(r.used);
    }
    const posting = { ...(opMap.get('posting') || {}), quota };
    for (const key of ['nextPostAt', 'publishingAt', 'cooling', 'attemptOutcomes']) {
      if (opMap.has(key)) posting[key] = opMap.get(key);
    }

    const vpnSlots = opMap.has('vpnSlots')
      ? opMap.get('vpnSlots')
      : Object.fromEntries((row.vpn_slots_rows || []).map(r => [r.account_id, Number(r.slot_index ?? r.slot)]));

    const burnedSubnets = opMap.has('burnedSubnets')
      ? opMap.get('burnedSubnets')
      : (row.burned_rows || []).map(r => {
          const parsed = parse(r.source_json, null);
          return parsed && parsed.subnet && Object.keys(parsed).length === 2 && Object.hasOwn(parsed, 'position') ? parsed.subnet : (parsed || r.subnet);
        });

    const accountChecks = {};
    const checksRows = row.account_checks_rows || [];
    if (checksRows.length > 0) {
      for (const r of checksRows) {
        accountChecks[r.account_id] = parse(r.source_json, {});
      }
    } else if (opMap.has('accountChecks')) {
      Object.assign(accountChecks, opMap.get('accountChecks') || {});
    }

    const users = {};
    for (const r of row.tg_users_rows || []) {
      users[r.user_key] = parse(r.payload_json, {});
    }
    const panels = {};
    for (const r of row.tg_panels_rows || []) {
      panels[r.chat_id] = parse(r.payload_json, {});
    }
    const baseUi = opMap.get('telegramUi.meta') || {};
    const runMeta = opMap.get('telegramUi.run') ?? baseUi.run ?? null;
    let runObj = runMeta ? { ...runMeta } : undefined;
    if (runObj) {
      if (!Array.isArray(runObj.itemIds)) {
        if (this._cachedRunIdForItems === runObj.runId && Array.isArray(this._cachedRunItemIds)) {
          runObj.itemIds = this._cachedRunItemIds;
        } else {
          const storedIds = opMap.get('telegramUi.run.itemIds');
          if (Array.isArray(storedIds)) {
            this._cachedRunIdForItems = runObj.runId;
            this._cachedRunItemIds = storedIds;
            runObj.itemIds = storedIds;
          }
        }
      } else {
        this._cachedRunIdForItems = runObj.runId;
        this._cachedRunItemIds = runObj.itemIds;
      }
    }

    const telegramUi = {
      ...baseUi,
      users,
      dashboards: structuredClone(panels),
      activePanelsByChatId: structuredClone(panels),
      accountChecks,
      ...(runObj !== undefined ? { run: runObj } : {})
    };
    projectUiOwners(telegramUi, row.tg_panels_rows || [], row.tg_interface_rows || []);
    if (!runObj) delete telegramUi.run;
    if (opMap.has('telegramUi.pendingReport')) {
      telegramUi.pendingReport = opMap.get('telegramUi.pendingReport');
    } else if (!Object.hasOwn(baseUi, 'pendingReport')) {
      delete telegramUi.pendingReport;
    }

    const telegram = {};
    for (const [k, v] of tgStateMap.entries()) {
      telegram[k] = v;
    }
    if (!Object.keys(telegram).length && opMap.has('telegram')) {
      Object.assign(telegram, opMap.get('telegram'));
    }
    if (telegram.offset === undefined) telegram.offset = 0;
    if (!Array.isArray(telegram.processedUpdates)) telegram.processedUpdates = [];

    const linkOutbox = (row.outbox_rows || [])
      .filter(r => r.kind === 'link' || r.kind === 'document' || r.kind === 'empty')
      .map(r => parse(r.source_json || r.payload_json, {}));
    const linkDeliveries = (row.deliveries_rows || []).map(r => parse(r.source_json, {}));
    const linkTerminalEvents = (row.terminal_rows || []).map(r => parse(r.source_json, {}));
    const manualLinks = (row.manual_rows || []).map(r => parse(r.source_json, {}));
    const pendingForensicOutbox = (row.forensic_outbox_rows || []).map(r => parse(r.source_json, {}));
    const forensicLogs = (row.audit_rows || []).map(r => parse(r.payload_json, {}));
    const ambiguousFences = (row.fences_rows || []).map(r => {
      const parsed = parse(r.source_json, null);
      return parsed && typeof parsed.value === 'string' ? parsed.value : r.content_key;
    });

    const state = {
      items: [],
      cycle,
      accounts,
      settings,
      telegram,
      telegramUi,
      vpnSlots,
      posting,
      linkDeliveries,
      linkOutbox,
      linkTerminalEvents,
      burnedSubnets,
      forensicLogs,
      pendingForensicOutbox,
      manualLinks,
      ambiguousFences
    };

    for (const extraKey of ['uiScheduleDay', 'serverIp', 'slotIps', 'linkReportState', 'linkExportLease', 'dailyRetention']) {
      if (opMap.has(extraKey)) state[extraKey] = opMap.get(extraKey);
    }
    const customKeys = opMap.get('customRootKeys');
    if (customKeys && typeof customKeys === 'object') {
      for (const [k, v] of Object.entries(customKeys)) {
        if (!Object.hasOwn(state, k)) state[k] = v;
      }
    }
    return state;
  }

  async load() {
    const startedAt = performance.now();
    await this._ensureInitialized();
    const loadSequence = ++this.loadSequence;
    const mutationGeneration = this.mutationGeneration;
    const client = await this.pool.connect();
    let headerState;
    let sqlSelectMs = 0;
    try {
      const selectStart = performance.now();
      await this._syncPostsCache(client);
      headerState = await this._readHeaderState(client);
      sqlSelectMs = performance.now() - selectStart;
    } finally {
      client.release();
    }
    // Return clonePostValue copy so callers cannot mutate in-memory cache directly
    headerState.items = clonePostValue(this._orderedItems);
    if (mutationGeneration === this.mutationGeneration && loadSequence > this.publishedLoadSequence) {
      this.state = headerState;
      this.publishedLoadSequence = loadSequence;
    }
    const totalMs = performance.now() - startedAt;
    this._recordPerformance('read', {
      totalMs,
      queueWaitMs: 0,
      sqliteBeginMs: 0,
      sqlSelectMs,
      jsonParseMs: 0,
      sqliteCommitMs: 0,
      readerOpenMs: 0,
      ipcAndAssemblyMs: 0
    });
    const nav = require('./telegram').navigationContext.getStore();
    if (nav) {
      nav.databaseMs = (nav.databaseMs || 0) + totalMs;
      nav.databaseCalls = (nav.databaseCalls || 0) + 1;
    }
    return headerState;
  }

  async save(next) {
    assertPgMutationAllowed(this.pgConfig);
    if (this.readOnly) {
      const err = new Error('READ_ONLY_STORE: Cannot call save() on a read-only PgStore');
      err.code = 'READ_ONLY_STORE';
      throw err;
    }
    return this.update(() => clonePostValue(next));
  }

  async update(mutator) {
    assertPgMutationAllowed(this.pgConfig);
    if (this.readOnly) {
      const err = new Error('READ_ONLY_STORE: Cannot call update() on a read-only PgStore');
      err.code = 'READ_ONLY_STORE';
      throw err;
    }
    const requestedAt = performance.now();
    await this._ensureInitialized();
    return this._serialize('write', async ({ queueWaitMs = 0 } = {}) => {
      const client = await this.pool.connect();
      const cacheSnapshot = {
        postsById: new Map(this._postsById),
        postPositions: new Map(this._postPositions),
        postOrder: [...this._postOrder],
        orderedItems: [...this._orderedItems],
        shallowSnapshots: new Map(this._shallowSnapById),
        sourceJson: new Map(this._sourceJsonById),
        nextPosition: this._nextPosition,
        postCacheRevision: this._postCacheRevision,
        postCacheResetRevision: this._postCacheResetRevision
      };
      let beginMs = 0, bodyMs = 0, commitMs = 0, clientErr = null;
      try {
        const t0 = performance.now();
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtext('yj_autopost_store:' || current_schema()))");
        beginMs = performance.now() - t0;

        const bodyStart = performance.now();
        await this._syncPostsCache(client);
        const beforeHeader = await this._readHeaderState(client);
        const draft = clonePostValue(beforeHeader);
        draft.items = clonePostValue(this._orderedItems);

        let rawNext;
        rawNext = mutator(draft);
        if (rawNext && typeof rawNext.then === 'function') {
          throw Object.assign(new Error('PG_STORE_ASYNC_MUTATOR_FORBIDDEN: PostgreSQL transactions may not await mutators'), { code: 'PG_STORE_ASYNC_MUTATOR_FORBIDDEN' });
        }
        const isEnvelope = Boolean(rawNext && typeof rawNext === 'object' && !Array.isArray(rawNext) && Object.hasOwn(rawNext, 'state') && Object.hasOwn(rawNext, 'result') && rawNext !== draft);
        const nextState = isEnvelope ? rawNext.state : (rawNext === undefined ? draft : rawNext);
        const mutatorResult = isEnvelope ? structuredClone(rawNext.result) : undefined;

        const applyCache = await this._persistDiff(client, beforeHeader, nextState);
        bodyMs = performance.now() - bodyStart;

        const commitStart = performance.now();
        await client.query('COMMIT');
        commitMs = performance.now() - commitStart;

        if (typeof applyCache === 'function') applyCache();

        this.mutationGeneration++;
        this._dashboardHeavyCache = null;
        this._recordPerformance('write', {
          totalMs: performance.now() - requestedAt,
          queueWaitMs,
          attempts: 1,
          beginMs,
          bodyMs,
          commitMs
        });

        const { items: _droppedItems, ...nextHeader } = nextState;
        const returned = clonePostValue(nextHeader);
        returned.items = clonePostValue(this._orderedItems);
        this.state = returned;
        this._notifyMutation(returned);

        if (isEnvelope) {
          Object.defineProperty(returned, 'state', {
            value: returned,
            enumerable: false,
            configurable: true,
            writable: true
          });
          Object.defineProperty(returned, 'result', {
            value: structuredClone(mutatorResult),
            enumerable: false,
            configurable: true,
            writable: true
          });
        }
        return returned;
      } catch (err) {
        clientErr = err;
        try { await client.query('ROLLBACK'); } catch {}
        this._postsById = cacheSnapshot.postsById;
        this._postPositions = cacheSnapshot.postPositions;
        this._postOrder = cacheSnapshot.postOrder;
        this._orderedItems = cacheSnapshot.orderedItems;
        this._shallowSnapById = cacheSnapshot.shallowSnapshots;
        this._sourceJsonById = cacheSnapshot.sourceJson;
        this._nextPosition = cacheSnapshot.nextPosition;
        this._postCacheRevision = cacheSnapshot.postCacheRevision;
        this._postCacheResetRevision = cacheSnapshot.postCacheResetRevision;
        throw err;
      } finally {
        client.release(clientErr);
      }
    });
  }

  async _persistDiff(client, before, after) {
    const currentItems = Array.isArray(after.items) ? after.items : [];
    const oldOrder = this._postOrder;
    let orderChanged = currentItems.length !== oldOrder.length;
    if (!orderChanged) {
      for (let i = 0; i < currentItems.length; i++) {
        if (String(currentItems[i]?.id) !== oldOrder[i]) {
          orderChanged = true;
          break;
        }
      }
    }

    const toUpsert = [];
    let removedIds = [];
    let newOrder = oldOrder;
    let nextPosAfterOrder = this._nextPosition;
    if (!orderChanged) {
      // Fast path: 0.8ms shallow snapshot check across plain JS objects
      for (let i = 0; i < currentItems.length; i++) {
        const item = currentItems[i];
        const id = String(item.id);
        const snap = this._shallowSnapById.get(id);
        if (this._isItemChanged(item, snap)) {
          const pos = this._postPositions.get(id) ?? i;
          toUpsert.push({ item, position: pos });
        }
      }
    } else {
      newOrder = currentItems.map(item => String(item.id));
      const newIdSet = new Set(newOrder);
      removedIds = oldOrder.filter(id => !newIdSet.has(id));
      if (removedIds.length > 0) {
        await client.query('DELETE FROM reservations WHERE post_id = ANY($1::text[])', [removedIds]);
        await client.query('DELETE FROM posts WHERE id = ANY($1::text[])', [removedIds]);
      }
      const posPlan = computeMinimalPositions(currentItems, this._postPositions, this._nextPosition);
      nextPosAfterOrder = posPlan.nextPosition;
      for (let idx = 0; idx < currentItems.length; idx++) {
        const item = currentItems[idx];
        const id = String(item.id);
        const snap = this._shallowSnapById.get(id);
        const prevPos = this._postPositions.get(id);
        const assignedPos = posPlan.positions[idx];
        if (this._isItemChanged(item, snap) || prevPos !== assignedPos) {
          toUpsert.push({ item, position: assignedPos });
        }
      }
    }

    for (let i = 0; i < toUpsert.length; i += 250) {
      const slice = toUpsert.slice(i, i + 250);
      const valuesSql = [];
      const allParams = [];
      let pIdx = 1;
      for (const { item, position } of slice) {
        const params = postItemToParams(item, position);
        const placeholders = [];
        for (let k = 0; k < 26; k++) placeholders.push(`$${pIdx++}`);
        valuesSql.push(`(${placeholders.join(',')})`);
        allParams.push(...params);
      }
      await client.query(
        `INSERT INTO posts(
          id, position, content_hash, text, text_key, payload_json, state, created_at,
          reason, published_at, url, tweet_id, account_id, account_username, claimed_at,
          pre_dispatch_retries, claimable, attempt_json, archived_attempt_json,
          archived_attempts_json, outcome_json, result_json, recovery_history_json,
          failure_diagnostic_json, owner_assisted_package_json, source_json
        ) VALUES ${valuesSql.join(',')}
        ON CONFLICT(id) DO UPDATE SET
          position = EXCLUDED.position,
          content_hash = EXCLUDED.content_hash,
          text = EXCLUDED.text,
          text_key = EXCLUDED.text_key,
          payload_json = EXCLUDED.payload_json,
          state = EXCLUDED.state,
          created_at = EXCLUDED.created_at,
          reason = EXCLUDED.reason,
          published_at = EXCLUDED.published_at,
          url = EXCLUDED.url,
          tweet_id = EXCLUDED.tweet_id,
          account_id = EXCLUDED.account_id,
          account_username = EXCLUDED.account_username,
          claimed_at = EXCLUDED.claimed_at,
          pre_dispatch_retries = EXCLUDED.pre_dispatch_retries,
          claimable = EXCLUDED.claimable,
          attempt_json = EXCLUDED.attempt_json,
          archived_attempt_json = EXCLUDED.archived_attempt_json,
          archived_attempts_json = EXCLUDED.archived_attempts_json,
          outcome_json = EXCLUDED.outcome_json,
          result_json = EXCLUDED.result_json,
          recovery_history_json = EXCLUDED.recovery_history_json,
          failure_diagnostic_json = EXCLUDED.failure_diagnostic_json,
          owner_assisted_package_json = EXCLUDED.owner_assisted_package_json,
          source_json = EXCLUDED.source_json`,
        allParams
      );
      for (const { item, position } of slice) {
        if (item.state === 'processing' && item.attempt?.token && item.attempt?.accountId) {
          await client.query(
            `INSERT INTO reservations(post_id, token, run_id, account_id, phase, claimed_at, dispatch_started_at, source_json)
             VALUES($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT(post_id) DO UPDATE SET
               token = EXCLUDED.token,
               run_id = EXCLUDED.run_id,
               account_id = EXCLUDED.account_id,
               phase = EXCLUDED.phase,
               claimed_at = EXCLUDED.claimed_at,
               dispatch_started_at = EXCLUDED.dispatch_started_at,
               source_json = EXCLUDED.source_json`,
            [
              item.id,
              String(item.attempt.token),
              String(item.attempt.runId || after.cycle?.runId || 'run'),
              String(item.attempt.accountId),
              String(item.attempt.phase || 'claimed'),
              String(item.claimedAt || item.attempt.startedAt || new Date().toISOString()),
              item.attempt.phase === 'dispatching' ? (item.attempt.dispatchStartedAt || new Date().toISOString()) : null,
              json(item.attempt)
            ]
          );
          await client.query(
            `INSERT INTO post_attempts(post_id, token, run_id, account_id, phase, started_at, dispatch_started_at, admission_json, source_json)
             VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT(token) DO UPDATE SET
               phase = EXCLUDED.phase,
               dispatch_started_at = COALESCE(EXCLUDED.dispatch_started_at, post_attempts.dispatch_started_at),
               source_json = EXCLUDED.source_json`,
            [
              item.id,
              String(item.attempt.token),
              String(item.attempt.runId || after.cycle?.runId || 'run'),
              String(item.attempt.accountId),
              String(item.attempt.phase || 'claimed'),
              String(item.claimedAt || item.attempt.startedAt || new Date().toISOString()),
              item.attempt.phase === 'dispatching' ? (item.attempt.dispatchStartedAt || new Date().toISOString()) : null,
              json(item.attempt.admission || {}),
              json(item.attempt)
            ]
          );
        } else {
          await client.query('DELETE FROM reservations WHERE post_id = $1', [item.id]);
          // A released pre-dispatch claim is a completed attempt, not an active
          // publisher failure. Preserve its original token; never settle dispatch.
          const archived = item.archivedAttempt;
          if (item.state === 'pending' && !item.attempt && archived?.token &&
              (archived.preDispatchRetry === true || item.preDispatchRetries > 0) &&
              isProvenPreDispatch({ ...item, state: 'processing', attempt: archived })) {
            await client.query(
              `UPDATE post_attempts SET phase = 'completed', outcome = 'pre_dispatch_retry', completed_at = $1
               WHERE post_id = $2 AND token = $3 AND phase = 'claimed' AND dispatch_started_at IS NULL`,
              [archived.settledAt || archived.failedAt || new Date().toISOString(), item.id, String(archived.token)]
            );
          }
          if (['published', 'failed', 'ambiguous'].includes(item.state)) {
            const token = item.attempt?.token || item.archivedAttempt?.token || null;
            const completedAt = item.publishedAt || item.archivedAttempt?.settledAt || item.archivedAttempt?.failedAt || new Date().toISOString();
            if (token) {
              await client.query(
                `UPDATE post_attempts
                 SET phase = 'completed', outcome = $1, completed_at = $2, result_json = $3, failure_diagnostic_json = $4
                 WHERE post_id = $5 AND token = $6`,
                [item.state, completedAt, item.result ? json(item.result) : null, item.failureDiagnostic ? json(item.failureDiagnostic) : null, item.id, token]
              );
            }
            await client.query(
              `INSERT INTO publish_results(
                 post_id, token, account_id, account_username, outcome, published_at, completed_at,
                 url, tweet_id, reason, result_json, failure_diagnostic_json, source_json
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
               ON CONFLICT(post_id) DO UPDATE SET
                 token = COALESCE(EXCLUDED.token, publish_results.token),
                 account_id = COALESCE(EXCLUDED.account_id, publish_results.account_id),
                 account_username = COALESCE(EXCLUDED.account_username, publish_results.account_username),
                 outcome = EXCLUDED.outcome,
                 published_at = EXCLUDED.published_at,
                 completed_at = EXCLUDED.completed_at,
                 url = EXCLUDED.url,
                 tweet_id = EXCLUDED.tweet_id,
                 reason = EXCLUDED.reason,
                 result_json = EXCLUDED.result_json,
                 failure_diagnostic_json = EXCLUDED.failure_diagnostic_json,
                 source_json = EXCLUDED.source_json`,
              [
                item.id,
                token,
                item.accountId || null,
                item.accountUsername || null,
                item.state,
                item.publishedAt || null,
                completedAt,
                item.url || null,
                item.tweetId || null,
                item.reason || null,
                item.result ? json(item.result) : null,
                item.failureDiagnostic ? json(item.failureDiagnostic) : null,
                json(item)
              ]
            );
          }
        }
      }
    }

    const applyCache = () => {
      if (removedIds.length > 0) {
        for (const id of removedIds) {
          this._postsById.delete(id);
          this._postPositions.delete(id);
          this._shallowSnapById.delete(id);
          this._sourceJsonById.delete(id);
        }
      }
      for (const { item, position } of toUpsert) {
        const stored = clonePostValue(item);
        this._postsById.set(stored.id, stored);
        this._postPositions.set(stored.id, position);
        this._shallowSnapById.set(stored.id, this._captureItemSnap(stored));
      }
      if (orderChanged) {
        this._postOrder = newOrder;
        this._nextPosition = nextPosAfterOrder;
      }
      if (orderChanged || toUpsert.length > 0) {
        this._rebuildOrderedItems();
      }
    };

    // 2. Cycle state
    if (json(before.cycle) !== json(after.cycle)) {
      const c = after.cycle || { state: 'stopped', runId: null };
      await client.query(
        `INSERT INTO cycle_state(id, state, run_id, started_at, updated_at, reason, source_json)
         VALUES(1, $1, $2, $3, $4, $5, $6)
         ON CONFLICT(id) DO UPDATE SET
           state = EXCLUDED.state,
           run_id = EXCLUDED.run_id,
           started_at = EXCLUDED.started_at,
           updated_at = EXCLUDED.updated_at,
           reason = EXCLUDED.reason,
           source_json = EXCLUDED.source_json`,
        [c.state || 'stopped', c.runId || null, c.startedAt || null, c.updatedAt || null, c.reason || null, json(c)]
      );
    }

    // 3. Accounts
    if (json(before.accounts) !== json(after.accounts)) {
      const nextAccounts = after.accounts || [];
      const nextIds = nextAccounts.map(a => String(a.id));
      if (nextIds.length > 0) {
        await client.query('DELETE FROM accounts WHERE NOT (id = ANY($1::text[]))', [nextIds]);
      } else {
        await client.query('DELETE FROM accounts');
      }
      for (let i = 0; i < nextAccounts.length; i++) {
        await client.query(
          `INSERT INTO accounts(
            id, position, label, username, user_id, enabled, cookie_file, verified_at,
            vpn_resource, quota_json, delay_ms, exit_ip, status, check_generation, failures, source_json
          ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
          ON CONFLICT(id) DO UPDATE SET
            position = EXCLUDED.position,
            label = EXCLUDED.label,
            username = EXCLUDED.username,
            user_id = EXCLUDED.user_id,
            enabled = EXCLUDED.enabled,
            cookie_file = EXCLUDED.cookie_file,
            verified_at = EXCLUDED.verified_at,
            vpn_resource = EXCLUDED.vpn_resource,
            quota_json = EXCLUDED.quota_json,
            delay_ms = EXCLUDED.delay_ms,
            exit_ip = EXCLUDED.exit_ip,
            status = EXCLUDED.status,
            check_generation = EXCLUDED.check_generation,
            failures = EXCLUDED.failures,
            source_json = EXCLUDED.source_json`,
          accountToParams(nextAccounts[i], i)
        );
      }
    }

    // 4. Settings & Schedules
    if (json(before.settings) !== json(after.settings) || before.uiScheduleDay !== after.uiScheduleDay) {
      const s = after.settings || {};
      await client.query('DELETE FROM settings');
      for (const [k, v] of Object.entries(s)) {
        await client.query('INSERT INTO settings(key, value_json) VALUES($1, $2)', [k, json(v)]);
      }
      const sched = s.schedule || { enabled: false, hour: 9, minute: 0 };
      await client.query(
        `INSERT INTO schedules(id, enabled, hour, minute, timezone, last_triggered_day, updated_at, source_json)
         VALUES('daily', $1, $2, $3, 'Asia/Riyadh', $4, $5, $6)
         ON CONFLICT(id) DO UPDATE SET
           enabled = EXCLUDED.enabled,
           hour = EXCLUDED.hour,
           minute = EXCLUDED.minute,
           last_triggered_day = EXCLUDED.last_triggered_day,
           updated_at = EXCLUDED.updated_at,
           source_json = EXCLUDED.source_json`,
        [sched.enabled ? 1 : 0, Number(sched.hour ?? 9), Number(sched.minute ?? 0), after.uiScheduleDay || null, new Date().toISOString(), json(sched)]
      );
    }

    // 5. Quota & Posting operational state
    if (json(before.posting) !== json(after.posting)) {
      const p = after.posting || {};
      if (json(before.posting?.quota) !== json(p.quota)) {
        await client.query('DELETE FROM quota');
        for (const [day, accountsMap] of Object.entries(p.quota || {})) {
          for (const [accId, used] of Object.entries(accountsMap || {})) {
            await client.query(
              'INSERT INTO quota(day, account_id, used, source_json) VALUES($1, $2, $3, $4)',
              [day, accId, Number.isFinite(used) ? Number(used) : 0, json({ day, accountId: accId, used })]
            );
          }
        }
      }
      for (const key of ['nextPostAt', 'publishingAt', 'cooling', 'attemptOutcomes']) {
        if (Object.hasOwn(p, key)) {
          await client.query(
            'INSERT INTO operational_state(key, value_json) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value_json = EXCLUDED.value_json',
            [key, json(p[key])]
          );
        } else {
          await client.query('DELETE FROM operational_state WHERE key = $1', [key]);
        }
      }
      const { quota: _q, ...postingRest } = p;
      await client.query(
        'INSERT INTO operational_state(key, value_json) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value_json = EXCLUDED.value_json',
        ['posting', json(postingRest)]
      );
    }

    // 6. VPN slots & Burned subnets
    if (json(before.vpnSlots) !== json(after.vpnSlots)) {
      const slots = after.vpnSlots || {};
      await client.query('DELETE FROM vpn_slots');
      for (const [accId, slot] of Object.entries(slots)) {
        if (Number.isInteger(slot)) {
          await client.query(
            'INSERT INTO vpn_slots(account_id, slot_index, updated_at, source_json) VALUES($1, $2, $3, $4)',
            [accId, slot, new Date().toISOString(), json({ accountId: accId, slotIndex: slot })]
          );
        }
      }
      await client.query(
        'INSERT INTO operational_state(key, value_json) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value_json = EXCLUDED.value_json',
        ['vpnSlots', json(slots)]
      );
    }

    if (json(before.burnedSubnets) !== json(after.burnedSubnets)) {
      const burned = after.burnedSubnets || [];
      await client.query('DELETE FROM burned_subnets');
      for (const [idx, entry] of burned.entries()) {
        const subnet = typeof entry === 'string' ? entry : entry?.subnet;
        if (!subnet) continue;
        await client.query(
          'INSERT INTO burned_subnets(subnet, position, created_at, source_json) VALUES($1, $2, $3, $4) ON CONFLICT(subnet) DO UPDATE SET position = EXCLUDED.position, source_json = EXCLUDED.source_json',
          [subnet, idx, new Date().toISOString(), json(entry)]
        );
      }
      await client.query(
        'INSERT INTO operational_state(key, value_json) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value_json = EXCLUDED.value_json',
        ['burnedSubnets', json(burned)]
      );
    }

    // 7. Telegram state & Telegram UI
    if (json(before.telegram) !== json(after.telegram)) {
      const tg = after.telegram || { offset: 0, processedUpdates: [] };
      for (const [k, v] of Object.entries(tg)) {
        await client.query(
          'INSERT INTO telegram_state(key, value_json) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value_json = EXCLUDED.value_json',
          [String(k), json(v)]
        );
      }
    }

    const bUi = before.telegramUi || {};
    const aUi = after.telegramUi ||= {};
    for (const [chatId, owner] of Object.entries(aUi.activePanelsByChatId || aUi.dashboards || {})) {
      await saveLegacyUiPanel(client, chatId, owner);
    }
    // A full-state/header save has no captured owner tuple and cannot authorize
    // ownership, even if it happens to contain a previously current alias.
    await projectCommittedUiOwners(client, aUi);
    if (json(bUi.users) !== json(aUi.users)) {
      const users = aUi.users || {};
      const keys = Object.keys(users);
      if (keys.length > 0) {
        await client.query('DELETE FROM telegram_users WHERE NOT (user_key = ANY($1::text[]))', [keys]);
      } else {
        await client.query('DELETE FROM telegram_users');
      }
      for (const [uKey, val] of Object.entries(users)) {
        await client.query(
          `INSERT INTO telegram_users(user_key, chat_id, user_id, payload_json, updated_at)
           VALUES($1, $2, $3, $4, $5)
           ON CONFLICT(user_key) DO UPDATE SET
             chat_id = EXCLUDED.chat_id,
             user_id = EXCLUDED.user_id,
             payload_json = EXCLUDED.payload_json,
             updated_at = EXCLUDED.updated_at`,
          [uKey, val?.chatId == null ? null : String(val.chatId), val?.userId == null ? null : String(val.userId), json(val), new Date().toISOString()]
        );
      }
    }

    // Typed ownership is persisted only by saveUiPanel (or the explicit
    // offline importer); legacy snapshots have only the monotonic path above.

    if (json(bUi.accountChecks) !== json(aUi.accountChecks)) {
      const checks = aUi.accountChecks || {};
      await client.query('DELETE FROM account_checks');
      for (const [accId, checkObj] of Object.entries(checks)) {
        await client.query(
          `INSERT INTO account_checks(account_id, vpn_json, session_json, last_error, source_json)
           VALUES($1, $2, $3, $4, $5)`,
          [accId, checkObj?.vpn ? json(checkObj.vpn) : null, checkObj?.session ? json(checkObj.session) : null, checkObj?.lastError || null, json(checkObj)]
        );
      }
      await client.query(
        'INSERT INTO operational_state(key, value_json) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value_json = EXCLUDED.value_json',
        ['accountChecks', json(checks)]
      );
    }

    // Store telegramUi.run without rewriting 50k itemIds on every cursor/attemptLedger update
    const bRun = bUi.run ? { ...bUi.run, itemIds: undefined } : null;
    const aRun = aUi.run ? { ...aUi.run, itemIds: undefined } : null;
    if (json(bRun) !== json(aRun) || bUi.run?.runId !== aUi.run?.runId || bUi.run?.itemIds?.length !== aUi.run?.itemIds?.length) {
      if (aUi.run) {
        const { itemIds, ...runWithoutIds } = aUi.run;
        await client.query(
          'INSERT INTO operational_state(key, value_json) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value_json = EXCLUDED.value_json',
          ['telegramUi.run', json(runWithoutIds)]
        );
        if (Array.isArray(itemIds)) {
          if (this._cachedRunIdForItems !== aUi.run.runId || this._cachedRunItemIds?.length !== itemIds.length) {
            await client.query(
              'INSERT INTO operational_state(key, value_json) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value_json = EXCLUDED.value_json',
              ['telegramUi.run.itemIds', json(itemIds)]
            );
          }
          this._cachedRunIdForItems = aUi.run.runId;
          this._cachedRunItemIds = itemIds;
        }
      } else {
        await client.query("DELETE FROM operational_state WHERE key IN ('telegramUi.run', 'telegramUi.run.itemIds')");
        this._cachedRunIdForItems = null;
        this._cachedRunItemIds = null;
      }
    }

    if (json(bUi.pendingReport) !== json(aUi.pendingReport)) {
      if (aUi.pendingReport !== undefined) {
        await client.query(
          'INSERT INTO operational_state(key, value_json) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value_json = EXCLUDED.value_json',
          ['telegramUi.pendingReport', json(aUi.pendingReport)]
        );
      } else {
        await client.query("DELETE FROM operational_state WHERE key = 'telegramUi.pendingReport'");
      }
    }

    // 8. Link Outbox, Deliveries, Terminal Events, Manual Links
    if (json(before.linkOutbox) !== json(after.linkOutbox)) {
      await client.query("DELETE FROM outbox WHERE kind IN ('link', 'document', 'empty')");
      for (const [seq, row] of (after.linkOutbox || []).entries()) {
        const id = String(row.outboxId || row.id || `link:${row.runId}:${row.day}:${row.chatId}:${seq}`);
        await client.query(
          `INSERT INTO outbox(id, sequence_no, dedupe_key, kind, status, payload_json, attempts, next_attempt_at, created_at, delivered_at, source_json)
           VALUES($1, $2, $3, 'link', $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT(id) DO UPDATE SET
             status = EXCLUDED.status,
             payload_json = EXCLUDED.payload_json,
             attempts = EXCLUDED.attempts,
             next_attempt_at = EXCLUDED.next_attempt_at,
             delivered_at = EXCLUDED.delivered_at,
             source_json = EXCLUDED.source_json`,
          [id, seq, id, row.status || 'pending', json(row), Number.isSafeInteger(row.attempts) ? row.attempts : 0, row.nextAttemptAt || null, row.createdAt || new Date().toISOString(), row.deliveredAt || null, json(row)]
        );
      }
    }

    if (json(before.linkDeliveries) !== json(after.linkDeliveries)) {
      await client.query('DELETE FROM link_deliveries');
      for (const [idx, row] of (after.linkDeliveries || []).entries()) {
        const delivId = String(row.deliveryId || `legacy:${idx}:${row.runId}:${row.chatId || ''}:${row.day || ''}`);
        await client.query(
          `INSERT INTO link_deliveries(delivery_id, sequence_no, outbox_id, run_id, day, kind, chat_id, item_ids_json, content_hash, attempted, ok, message_id, attempted_at, delivered_at, source_json)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [delivId, idx, row.outboxId || null, row.runId || null, row.day || null, row.kind || 'document', row.chatId == null ? null : String(row.chatId), json(row.itemIds || []), row.contentHash || null, row.attempted === true ? 1 : 0, row.ok === true ? 1 : 0, row.messageId == null ? null : Number(row.messageId), row.attemptedAt || null, row.deliveredAt || null, json(row)]
        );
      }
    }

    if (json(before.linkTerminalEvents) !== json(after.linkTerminalEvents)) {
      await client.query('DELETE FROM link_terminal_events');
      for (const [seq, row] of (after.linkTerminalEvents || []).entries()) {
        const evId = String(row.eventId || `legacy-terminal:${seq}:${row.runId || ''}:${row.chatId || ''}`);
        await client.query(
          `INSERT INTO link_terminal_events(event_id, sequence_no, run_id, chat_id, day, reconciled, suppressed, reason, content_hash, source_json)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [evId, seq, String(row.runId || ''), String(row.chatId || ''), row.day || null, row.reconciled === true ? 1 : 0, row.suppressed === true ? 1 : 0, row.reason || null, row.contentHash || null, json(row)]
        );
      }
    }

    if (json(before.manualLinks) !== json(after.manualLinks)) {
      await client.query('DELETE FROM manual_links');
      for (const [idx, row] of (after.manualLinks || []).entries()) {
        await client.query(
          'INSERT INTO manual_links(id, position, url, state, published_at, source, source_json) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [String(row.id), idx, String(row.url), row.state || null, row.publishedAt || null, row.source || null, json(row)]
        );
      }
    }

    // 9. Forensic outbox & Audit events & Ambiguous fences
    if (json(before.pendingForensicOutbox) !== json(after.pendingForensicOutbox)) {
      await client.query('DELETE FROM forensic_outbox');
      for (const [idx, row] of (after.pendingForensicOutbox || []).entries()) {
        await client.query(
          'INSERT INTO forensic_outbox(id, position, event_time, event_type, payload_json, source_json) VALUES($1,$2,$3,$4,$5,$6)',
          [String(row.id), idx, row.timestamp || null, row.eventType || null, json(row), json(row)]
        );
      }
    }

    if (json(before.forensicLogs) !== json(after.forensicLogs)) {
      await client.query('DELETE FROM audit_events');
      for (const [idx, row] of (after.forensicLogs || []).entries()) {
        await client.query(
          'INSERT INTO audit_events(id, position, event_time, event_type, post_id, account_id, payload_json) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [String(row.id), idx, row.timestamp || null, row.eventType || null, row.itemId || row.queueItemId || null, row.accountId || null, json(row)]
        );
      }
    }

    if (json(before.ambiguousFences) !== json(after.ambiguousFences)) {
      await client.query('DELETE FROM ambiguous_fences');
      for (const [idx, val] of (after.ambiguousFences || []).entries()) {
        if (typeof val === 'string') {
          await client.query(
            'INSERT INTO ambiguous_fences(content_key, position, created_at, source_json) VALUES($1,$2,$3,$4) ON CONFLICT(content_key) DO NOTHING',
            [textKey(val), idx, new Date().toISOString(), json({ value: val })]
          );
        }
      }
    }

    // 10. Extra root operational keys
    for (const extraKey of ['uiScheduleDay', 'serverIp', 'slotIps', 'linkReportState', 'linkExportLease', 'dailyRetention']) {
      if (json(before[extraKey]) !== json(after[extraKey])) {
        if (after[extraKey] !== undefined) {
          await client.query(
            'INSERT INTO operational_state(key, value_json) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value_json = EXCLUDED.value_json',
            [extraKey, json(after[extraKey])]
          );
        } else {
          await client.query('DELETE FROM operational_state WHERE key = $1', [extraKey]);
        }
      }
    }

    const knownKeys = new Set([
      'items', 'cycle', 'accounts', 'settings', 'telegram', 'telegramUi', 'vpnSlots', 'posting',
      'linkDeliveries', 'linkOutbox', 'linkTerminalEvents', 'burnedSubnets', 'forensicLogs',
      'pendingForensicOutbox', 'manualLinks', 'ambiguousFences', 'uiScheduleDay', 'serverIp',
      'slotIps', 'linkReportState', 'linkExportLease', 'dailyRetention'
    ]);
    const custom = {};
    for (const [k, v] of Object.entries(after)) {
      if (!knownKeys.has(k)) custom[k] = v;
    }
    if (Object.keys(custom).length > 0) {
      await client.query(
        'INSERT INTO operational_state(key, value_json) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value_json = EXCLUDED.value_json',
        ['customRootKeys', json(custom)]
      );
    }
    return applyCache;
  }

  async section(name) {
    const started = performance.now();
    const nav = require('./telegram').navigationContext.getStore();
    if (!['telegramUi', 'settings', 'accounts', 'linkOutbox', 'linkReportState', 'dailyRetention', 'cycle', 'vpnSlots', 'posting', 'items'].includes(name)) {
      throw new Error('INVALID_SECTION');
    }
    await this._ensureInitialized();
    try {
      if (name === 'items') {
        const client = await this.pool.connect();
        try { await this._syncPostsCache(client); } finally { client.release(); }
        return clonePostValue(this._orderedItems);
      }
      if (name === 'settings') {
        const res = await this.pool.query('SELECT key, value_json FROM settings ORDER BY key ASC');
        return Object.fromEntries(res.rows.map(r => [r.key, parse(r.value_json)]));
      }
      if (name === 'accounts') {
        const res = await this.pool.query('SELECT * FROM accounts ORDER BY position ASC, id ASC');
        return res.rows.map(rowToAccount);
      }
      if (name === 'cycle') {
        const res = await this.pool.query('SELECT * FROM cycle_state WHERE id = 1');
        const row = res.rows[0];
        if (!row) return { state: 'stopped', runId: null };
        return { ...(parse(row.source_json, {}) || {}), state: row.state, runId: row.run_id };
      }
      if (name === 'vpnSlots') {
        const opRes = await this.pool.query("SELECT value_json FROM operational_state WHERE key = 'vpnSlots'");
        if (opRes.rows[0]) return parse(opRes.rows[0].value_json, {});
        const res = await this.pool.query('SELECT account_id, slot_index FROM vpn_slots');
        return Object.fromEntries(res.rows.map(r => [r.account_id, Number(r.slot_index)]));
      }
      if (['linkReportState','dailyRetention'].includes(name)) {
        const res = await this.pool.query('SELECT value_json FROM operational_state WHERE key = $1',[name]);
        return res.rows[0] ? parse(res.rows[0].value_json, {}) : {};
      }
      if (name === 'linkOutbox') {
        const res = await this.pool.query("SELECT source_json, payload_json FROM outbox WHERE kind IN ('link', 'document', 'empty') ORDER BY sequence_no ASC");
        return res.rows.map(r => parse(r.source_json || r.payload_json, {}));
      }
      if (name === 'posting') {
        const [quotaRes, opRes] = await Promise.all([
          this.pool.query('SELECT day, account_id, used FROM quota'),
          this.pool.query("SELECT key, value_json FROM operational_state WHERE key IN ('posting', 'nextPostAt', 'publishingAt', 'cooling', 'attemptOutcomes')")
        ]);
        const opMap = new Map(opRes.rows.map(r => [r.key, parse(r.value_json)]));
        const quota = {};
        for (const r of quotaRes.rows) {
          quota[r.day] ||= {};
          quota[r.day][r.account_id] = Number(r.used);
        }
        const posting = { ...(opMap.get('posting') || {}), quota };
        for (const k of ['nextPostAt', 'publishingAt', 'cooling', 'attemptOutcomes']) {
          if (opMap.has(k)) posting[k] = opMap.get(k);
        }
        return posting;
      }
      if (name === 'telegramUi') {
        const [usersRes, panelsRes, typedRes, checksRes, opRes] = await Promise.all([
          this.pool.query('SELECT user_key, payload_json FROM telegram_users'),
          this.pool.query('SELECT chat_id, payload_json FROM telegram_panels'),
          this.pool.query('SELECT chat_id, kind, payload_json FROM telegram_interface_panels'),
          this.pool.query('SELECT account_id, source_json FROM account_checks'),
          this.pool.query("SELECT key, value_json FROM operational_state WHERE key IN ('telegramUi.meta', 'telegramUi.run', 'telegramUi.pendingReport')")
        ]);
        const opMap = new Map(opRes.rows.map(r => [r.key, parse(r.value_json)]));
        const users = Object.fromEntries(usersRes.rows.map(r => [r.user_key, parse(r.payload_json, {})]));
        const accountChecks = Object.fromEntries(checksRes.rows.map(r => [r.account_id, parse(r.source_json, {})]));
        const runMeta = opMap.get('telegramUi.run');
        return projectUiOwners({
          ...(opMap.get('telegramUi.meta') || {}),
          users,
          accountChecks,
          ...(runMeta ? { run: runMeta } : {}),
          ...(opMap.has('telegramUi.pendingReport') ? { pendingReport: opMap.get('telegramUi.pendingReport') } : {})
        }, panelsRes.rows, typedRes.rows);
      }
      return {};
    } finally {
      if (nav) {
        nav.databaseMs = (nav.databaseMs || 0) + performance.now() - started;
        nav.databaseCalls = (nav.databaseCalls || 0) + 1;
      }
    }
  }

  async patchUiUser(key, patch) {
    assertPgMutationAllowed(this.pgConfig);
    if (this.readOnly) throw new Error('READ_ONLY_STORE');
    const started = performance.now();
    const nav = require('./telegram').navigationContext.getStore();
    await this._ensureInitialized();
    return this._serialize('ui', async () => {
      const client = await this.pool.connect();
      let clientErr;
      try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtext('yj_autopost_store:' || current_schema()))");
        const existingRes = await client.query('SELECT payload_json FROM telegram_users WHERE user_key = $1 FOR UPDATE', [String(key)]);
        const current = existingRes.rows[0] ? parse(existingRes.rows[0].payload_json, {}) : {};
        const merged = { ...current, ...patch };
        await projectCommittedUiOwners(client, { users: { merged } });
        await client.query(
          `INSERT INTO telegram_users(user_key, chat_id, user_id, payload_json, updated_at)
           VALUES($1, $2, $3, $4, $5)
           ON CONFLICT(user_key) DO UPDATE SET
             chat_id = EXCLUDED.chat_id,
             user_id = EXCLUDED.user_id,
             payload_json = EXCLUDED.payload_json,
             updated_at = EXCLUDED.updated_at`,
          [String(key), merged.chatId == null ? null : String(merged.chatId), merged.userId == null ? null : String(merged.userId), json(merged), new Date().toISOString()]
        );
        const allUsersRes = await client.query('SELECT user_key, payload_json FROM telegram_users');
        const users = Object.fromEntries(allUsersRes.rows.map(r => [r.user_key, parse(r.payload_json, {})]));
        if (this.navigationUi) {
          for (const [k, p] of this.navigationUi.pending) users[k] = { ...(users[k] || {}), ...p };
          await projectCommittedUiOwners(client, { users });
        }
        await client.query('COMMIT');
        if (this.navigationUi) this.navigationUi.users = users;
      } catch (err) {
        clientErr = err;
        try { await client.query('ROLLBACK'); } catch {}
        throw err;
      } finally {
        client.release(clientErr);
        if (nav) {
          nav.databaseMs = (nav.databaseMs || 0) + performance.now() - started;
          nav.databaseCalls = (nav.databaseCalls || 0) + 1;
        }
      }
    });
  }

  async saveUiPanel(id, panel, isCurrent = () => true, options = {}) {
    assertPgMutationAllowed(this.pgConfig);
    if (this.readOnly) throw new Error('READ_ONLY_STORE');
    const kind = options?.kind || 'dashboard';
    const hasExpected = options && Object.hasOwn(options, 'expected');
    const validMessage = p => Number.isSafeInteger(p?.messageId) && p.messageId > 0;
    if (!['dashboard', 'accounts'].includes(kind) || !validMessage(panel) ||
        (hasExpected && options.expected !== null && !validMessage(options.expected))) return false;
    // Snapshot the request before the queued transaction: callers may reuse the
    // local object while this write waits behind another owner adoption.
    panel = structuredClone(panel);
    const expected = hasExpected ? structuredClone(options.expected) : undefined;
    await this._ensureInitialized();
    return this._serialize('ui', async () => {
      if (!isCurrent()) return false;
      const client = await this.pool.connect();
      let clientErr;
      try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtext('yj_autopost_store:' || current_schema()))");
        if (!isCurrent()) {
          await client.query('ROLLBACK');
          return false;
        }
        const chatKey = String(id.chat);
        const typed = await client.query('SELECT payload_json FROM telegram_interface_panels WHERE chat_id = $1 AND kind = $2 FOR UPDATE', [chatKey, kind]);
        const legacy = !typed.rows.length && kind === 'dashboard'
          ? await client.query('SELECT payload_json FROM telegram_panels WHERE chat_id = $1 FOR UPDATE', [chatKey]) : { rows: [] };
        const candidate = parse((typed.rows[0] || legacy.rows[0])?.payload_json, null);
        // Match the read-side legacy filter: an old accounts-shaped chat row
        // does not represent dashboard ownership and cannot block null CAS.
        const current = !typed.rows.length && candidate?.kind === 'accounts' ? null : candidate;
        const matches = hasExpected ? (expected === null ? !current : samePanelTuple(current, expected))
          : !current || samePanelTuple(current, panel) || panel.messageId > current.messageId;
        if (!matches || !isCurrent()) { await client.query('ROLLBACK'); return false; }
        await client.query(
          `INSERT INTO telegram_interface_panels(chat_id, kind, message_id, generation, payload_json, updated_at)
           VALUES($1, $2, $3, $4, $5, $6)
           ON CONFLICT(chat_id, kind) DO UPDATE SET message_id = EXCLUDED.message_id,
             generation = EXCLUDED.generation, payload_json = EXCLUDED.payload_json, updated_at = EXCLUDED.updated_at`,
          [chatKey, kind, panel.messageId, panel.generation ?? null, json(panel), new Date().toISOString()]
        );
        if (kind !== 'dashboard') {
          if (!isCurrent()) { await client.query('ROLLBACK'); return false; }
          await client.query('COMMIT');
          this.mutationGeneration++;
          this.state = null;
          return true;
        }
        await client.query(
          `INSERT INTO telegram_panels(chat_id, message_id, signature, payload_json, updated_at)
           VALUES($1, $2, $3, $4, $5)
           ON CONFLICT(chat_id) DO UPDATE SET
             message_id = EXCLUDED.message_id,
             signature = EXCLUDED.signature,
             payload_json = EXCLUDED.payload_json,
             updated_at = EXCLUDED.updated_at`,
          [chatKey, panel?.messageId || null, panel?.signature || null, json(panel), new Date().toISOString()]
        );
        const userRes = await client.query('SELECT user_key, payload_json FROM telegram_users WHERE chat_id = $1 OR user_key = $2 FOR UPDATE', [chatKey, String(id.key)]);
        let foundKey = false;
        for (const r of userRes.rows) {
          if (r.user_key === String(id.key)) foundKey = true;
          const u = parse(r.payload_json, {});
          u.panel = { ...panel };
          await client.query('UPDATE telegram_users SET payload_json = $1, updated_at = $2 WHERE user_key = $3', [json(u), new Date().toISOString(), r.user_key]);
        }
        if (!foundKey) {
          const newUser = { chatId: id.chat, userId: id.user, page: 'main', panel: { ...panel } };
          await client.query(
            `INSERT INTO telegram_users(user_key, chat_id, user_id, payload_json, updated_at)
             VALUES($1, $2, $3, $4, $5)
             ON CONFLICT(user_key) DO UPDATE SET payload_json = EXCLUDED.payload_json, updated_at = EXCLUDED.updated_at`,
            [String(id.key), chatKey, String(id.user), json(newUser), new Date().toISOString()]
          );
        }
        if (!isCurrent()) { await client.query('ROLLBACK'); return false; }
        await client.query('COMMIT');
        this.mutationGeneration++;
        this.state = null;
        return true;
      } catch (err) {
        clientErr = err;
        try { await client.query('ROLLBACK'); } catch {}
        throw err;
      } finally {
        client.release(clientErr);
      }
    });
  }

  async flushUiNavigation(saved) {
    assertPgMutationAllowed(this.pgConfig);
    if (this.readOnly) throw new Error('READ_ONLY_STORE');
    await this._ensureInitialized();
    return this._serialize('ui', async () => {
      const client = await this.pool.connect();
      let clientErr;
      try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtext('yj_autopost_store:' || current_schema()))");
        for (const [uKey, patch] of saved?.users || []) {
          const res = await client.query('SELECT payload_json FROM telegram_users WHERE user_key = $1 FOR UPDATE', [String(uKey)]);
          const current = res.rows[0] ? parse(res.rows[0].payload_json, {}) : {};
          const merged = { ...current, ...patch };
          await projectCommittedUiOwners(client, { users: { merged } });
          await client.query(
            `INSERT INTO telegram_users(user_key, chat_id, user_id, payload_json, updated_at)
             VALUES($1, $2, $3, $4, $5)
             ON CONFLICT(user_key) DO UPDATE SET
               chat_id = EXCLUDED.chat_id,
               user_id = EXCLUDED.user_id,
               payload_json = EXCLUDED.payload_json,
               updated_at = EXCLUDED.updated_at`,
            [String(uKey), merged.chatId == null ? null : String(merged.chatId), merged.userId == null ? null : String(merged.userId), json(merged), new Date().toISOString()]
          );
        }
        // Typed owners cannot be authorized by queued navigation patches.
        // Generation-less historical callers retain a monotonic dashboard path.
        for (const [chatId, panel] of saved?.panels || []) await saveLegacyUiPanel(client, chatId, panel);
        // Re-project after legacy adoption too: all durable per-user aliases
        // follow the dashboard, never the order of pending navigation patches.
        const allUsers = await client.query('SELECT user_key, payload_json FROM telegram_users');
        const ui = { users: Object.fromEntries(allUsers.rows.map(r => [r.user_key, parse(r.payload_json, {})])) };
        await projectCommittedUiOwners(client, ui);
        for (const [key, user] of Object.entries(ui.users)) {
          await client.query('UPDATE telegram_users SET payload_json = $1 WHERE user_key = $2', [json(user), key]);
        }
        await client.query('COMMIT');
      } catch (err) {
        clientErr = err;
        try { await client.query('ROLLBACK'); } catch {}
        throw err;
      } finally {
        client.release(clientErr);
      }
    });
  }

  async claimNavigationReceipt(id, owner, action, received = Date.now()) {
    assertPgMutationAllowed(this.pgConfig);
    await this._ensureInitialized();
    const res = await this.pool.query(
      'INSERT INTO telegram_navigation_receipts(id, owner, action, received) VALUES($1, $2, $3, $4) ON CONFLICT(id) DO NOTHING RETURNING id',
      [String(id), String(owner || ''), String(action || ''), Number(received)]
    );
    return res.rowCount === 1;
  }

  async telegramProgress(next) {
    assertPgMutationAllowed(this.pgConfig);
    await this._ensureInitialized();
    const saved = this.navigationUi && (this.navigationUi.pending.size || this.navigationUi.panelPatches.size)
      ? { users: new Map(this.navigationUi.pending), panels: new Map(this.navigationUi.panelPatches) }
      : null;
    if (saved) await this.flushUiNavigation(saved);
    return this._serialize('ui', async () => {
      const client = await this.pool.connect();
      let clientErr;
      try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtext('yj_autopost_store:' || current_schema()))");
        for (const [k, v] of Object.entries(next || {})) {
          await client.query(
            'INSERT INTO telegram_state(key, value_json) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value_json = EXCLUDED.value_json',
            [String(k), json(v)]
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        clientErr = err;
        try { await client.query('ROLLBACK'); } catch {}
        throw err;
      } finally {
        client.release(clientErr);
      }
      if (saved) this.navigationUi?.committed(saved);
      return { changes: 1 };
    });
  }

  async hasInFlightPostForAccount(accountId) {
    await this._ensureInitialized();
    const res = await this.pool.query(
      "SELECT 1 FROM reservations WHERE account_id = $1 UNION ALL SELECT 1 FROM posts WHERE state IN ('processing', 'dispatch_started') AND account_id = $1 LIMIT 1",
      [String(accountId)]
    );
    return res.rowCount > 0;
  }

  async getPostsBatch({ state = 'pending', limit = 50, afterPosition = -1, claimableOnly = false, accountId = null } = {}) {
    await this._ensureInitialized();
    return pgStorage.getPostsBatch(this.pool, { state, limit, afterPosition, claimableOnly, accountId });
  }

  async _refreshSinglePostCache(client, postId) {
    const id = String(postId);
    const res = await client.query('SELECT * FROM posts WHERE id = $1', [id]);
    this._dashboardHeavyCache = null;
    if (!res.rows || res.rows.length === 0) {
      this._postsById.delete(id);
      this._postPositions.delete(id);
      this._shallowSnapById.delete(id);
      this._sourceJsonById.delete(id);
      const idx = this._postOrder.indexOf(id);
      if (idx !== -1) {
        this._postOrder.splice(idx, 1);
        this._rebuildOrderedItems();
      }
      return null;
    }
    const row = res.rows[0];
    const item = rowToPostItem(row);
    const pos = Number(row.position);
    const prevPos = this._postPositions.get(item.id);
    this._postsById.set(item.id, item);
    this._postPositions.set(item.id, pos);
    this._sourceJsonById.set(item.id, row.source_json);
    this._shallowSnapById.set(item.id, this._captureItemSnap(item));
    if (pos >= this._nextPosition) this._nextPosition = pos + 1;
    const existingIdx = this._postOrder.indexOf(item.id);
    if (existingIdx === -1) {
      this._postOrder.push(item.id);
      this._postOrder.sort((a, b) => {
        const pa = this._postPositions.get(a) ?? 0;
        const pb = this._postPositions.get(b) ?? 0;
        return pa !== pb ? pa - pb : (a < b ? -1 : 1);
      });
      this._rebuildOrderedItems();
    } else if (prevPos !== undefined && prevPos !== pos) {
      this._postOrder.sort((a, b) => {
        const pa = this._postPositions.get(a) ?? 0;
        const pb = this._postPositions.get(b) ?? 0;
        return pa !== pb ? pa - pb : (a < b ? -1 : 1);
      });
      this._rebuildOrderedItems();
    } else {
      this._orderedItems[existingIdx] = item;
    }
    return item;
  }

  async claimNext(options = {}) {
    assertPgMutationAllowed(this.pgConfig);
    await this._ensureInitialized();
    return this._serialize('write', async () => {
      const claimed = await pgStorage.claimNext(this.pool, options);
      if (claimed?.id) {
        const client = await this.pool.connect();
        try {
          const item = await this._refreshSinglePostCache(client, claimed.id);
          const idx = this._postOrder.indexOf(claimed.id);
          if (idx !== -1 && item) this._orderedItems[idx] = item;
        } finally {
          client.release();
        }
      }
      return claimed;
    });
  }

  async markDispatching(options = {}) {
    assertPgMutationAllowed(this.pgConfig);
    await this._ensureInitialized();
    return this._serialize('write', async () => {
      const res = await pgStorage.markDispatching(this.pool, options);
      if (options.postId) {
        const client = await this.pool.connect();
        try {
          const item = await this._refreshSinglePostCache(client, options.postId);
          const idx = this._postOrder.indexOf(String(options.postId));
          if (idx !== -1 && item) this._orderedItems[idx] = item;
        } finally {
          client.release();
        }
      }
      return res;
    });
  }

  async completePublish(options = {}) {
    assertPgMutationAllowed(this.pgConfig);
    await this._ensureInitialized();
    return this._serialize('write', async () => {
      const res = await pgStorage.completePublish(this.pool, options);
      if (options.postId) {
        const client = await this.pool.connect();
        try {
          const item = await this._refreshSinglePostCache(client, options.postId);
          const idx = this._postOrder.indexOf(String(options.postId));
          if (idx !== -1 && item) this._orderedItems[idx] = item;
        } finally {
          client.release();
        }
      }
      return res;
    });
  }

  async recoverInterruptedClaims(options = {}) {
    assertPgMutationAllowed(this.pgConfig);
    await this._ensureInitialized();
    return this._serialize('write', async () => {
      const recovered = await pgStorage.recoverInterruptedClaims(this.pool, options);
      const touched = [...(recovered?.preDispatch || []), ...(recovered?.ambiguous || [])];
      if (touched.length > 0) {
        const client = await this.pool.connect();
        try {
          for (const id of touched) {
            const item = await this._refreshSinglePostCache(client, id);
            const idx = this._postOrder.indexOf(String(id));
            if (idx !== -1 && item) this._orderedItems[idx] = item;
          }
        } finally {
          client.release();
        }
      }
      return recovered;
    });
  }

  async getDashboardSnapshot({ day = null, now = new Date().toISOString() } = {}) {
    await this._ensureInitialized();
    const quotaDay = day || riyadhDay(new Date(now));
    const { utcStart, utcEnd } = riyadhDayUtcBounds(quotaDay);

    let inFlight = this._snapshotInFlight.get(quotaDay);
    if (!inFlight) {
      inFlight = (async () => {
        const heavyCache = this._dashboardHeavyCache;
        const candidateKey = heavyCache &&
          heavyCache.localGen === this.mutationGeneration &&
          heavyCache.localRev === this._postCacheRevision
          ? heavyCache.key
          : null;
        // Single MVCC snapshot; when heavy_key matches live post_cache_clock/cycle/fences/reservations,
        // PostgreSQL skips full posts aggregation and 1.93MB itemIds JSON expansion.
        const res = await this.pool.query(`
          WITH cycle_now AS MATERIALIZED (
            SELECT state, run_id, started_at, updated_at, reason FROM cycle_state WHERE id = 1
          ), clock_now AS MATERIALIZED (
            SELECT COALESCE((SELECT revision FROM post_cache_clock WHERE id = 1), 0) AS rev,
                   COALESCE((SELECT reset_revision FROM post_cache_clock WHERE id = 1), 0) AS rrev
          ), res_sig AS MATERIALIZED (
            SELECT
              COUNT(*) FILTER (WHERE phase IN ('claimed', 'dispatching'))::int AS active_count,
              COALESCE(STRING_AGG(post_id || ':' || phase || ':' || run_id, ',' ORDER BY post_id) FILTER (WHERE phase IN ('claimed', 'dispatching')), '') AS active_sig
            FROM reservations
          ), fence_sig AS MATERIALIZED (
            SELECT COUNT(*)::int AS cnt, COALESCE(md5(STRING_AGG(content_key, E'\\n' ORDER BY content_key)), '') AS digest
            FROM ambiguous_fences WHERE content_key <> ''
          ), raw_run AS MATERIALIZED (
            SELECT COALESCE((SELECT value_json::jsonb FROM operational_state WHERE key = 'telegramUi.run'), '{}'::jsonb) AS r
          ), run_scope AS MATERIALIZED (
            SELECT r,
              CASE
                WHEN jsonb_typeof(r->'itemIds') = 'array' THEN true
                WHEN EXISTS (SELECT 1 FROM operational_state WHERE key = 'telegramUi.run.itemIds') THEN true
                ELSE false
              END AS scope_known,
              CASE
                WHEN NOT EXISTS (SELECT 1 FROM cycle_now c WHERE c.state = 'running' AND c.run_id = r->>'runId') THEN NULL::text
                WHEN jsonb_typeof(r->'itemIds') = 'array' THEN 'inline:' || md5((r->'itemIds')::text)
                ELSE 'op:' || COALESCE((SELECT md5(value_json) FROM operational_state WHERE key = 'telegramUi.run.itemIds'), '')
              END AS item_ids_sig
            FROM raw_run
          ), cache_check AS MATERIALIZED (
            SELECT
              key_str AS heavy_key,
              ($2::text IS NOT NULL AND key_str = $2::text) AS heavy_hit
            FROM (
              SELECT (
                'rev' || cl.rev || ':' || cl.rrev || ':' || COALESCE(cy.state, 'stopped') || ':' || COALESCE(cy.run_id, '') || ':' ||
                rs.active_sig || ':' || fs.cnt || ':' || fs.digest || ':' ||
                (SELECT COALESCE(sc.r->>'runId', '') || ':' || CASE WHEN sc.scope_known THEN '1' ELSE '0' END || ':' || COALESCE(sc.item_ids_sig, '') FROM run_scope sc)
              ) AS key_str
              FROM clock_now cl
              CROSS JOIN fence_sig fs
              CROSS JOIN res_sig rs
              LEFT JOIN cycle_now cy ON TRUE
            ) k
          ), posts_stats AS MATERIALIZED (
            SELECT state,
              COUNT(*)::int AS count,
              COUNT(*) FILTER (
                WHERE state = 'pending' AND claimable = 1 AND (
                  text_key = '' OR text_key IS NULL OR (
                    NOT EXISTS (SELECT 1 FROM ambiguous_fences af WHERE af.content_key = p.text_key)
                    AND NOT EXISTS (
                      SELECT 1 FROM posts p2
                      WHERE p2.text_key = p.text_key AND p2.claimable = 0 AND p2.state <> 'cancelled' AND p2.text_key <> ''
                    )
                  )
                )
              )::int AS claimable_non_protected
            FROM posts p
            WHERE NOT (SELECT heavy_hit FROM cache_check)
            GROUP BY state
          ), run_ids AS MATERIALIZED (
            SELECT entry.id, MIN(entry.ord) AS ord
            FROM run_scope s
            CROSS JOIN LATERAL jsonb_array_elements_text(
              CASE
                WHEN NOT (SELECT heavy_hit FROM cache_check)
                  AND EXISTS (SELECT 1 FROM cycle_now c WHERE c.state = 'running' AND c.run_id = s.r->>'runId')
                THEN CASE
                  WHEN jsonb_typeof(s.r->'itemIds') = 'array' THEN s.r->'itemIds'
                  ELSE COALESCE((SELECT value_json::jsonb FROM operational_state WHERE key = 'telegramUi.run.itemIds'), '[]'::jsonb)
                END
                ELSE '[]'::jsonb
              END
            ) WITH ORDINALITY AS entry(id, ord)
            GROUP BY entry.id
          ), run_posts AS MATERIALIZED (
            SELECT ri.ord, p.state, p.claimable, p.pre_dispatch_retries, p.text_key,
              p.payload_json::jsonb->'account' AS binding
            FROM run_ids ri JOIN posts p ON p.id = ri.id
          ), candidates AS MATERIALIZED (
            SELECT ord, text_key, pre_dispatch_retries,
              CASE WHEN binding IS NULL OR binding IN ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '\"\"'::jsonb) THEN NULL
                WHEN jsonb_typeof(binding) = 'string' THEN binding #>> '{}' END AS account,
              binding IS NOT NULL AND binding NOT IN ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '\"\"'::jsonb)
                AND jsonb_typeof(binding) <> 'string' AS invalid_binding
            FROM run_posts rp
            WHERE rp.state = 'pending' AND rp.claimable = 1 AND rp.pre_dispatch_retries < ${MAX_PRE_DISPATCH_RETRIES}
              AND rp.text_key <> ''
              AND NOT EXISTS (SELECT 1 FROM ambiguous_fences af WHERE af.content_key = rp.text_key)
              AND NOT EXISTS (
                SELECT 1 FROM posts p2
                WHERE p2.text_key = rp.text_key AND p2.claimable = 0 AND p2.state <> 'cancelled' AND p2.text_key <> ''
              )
          ), routing_changes AS (
            SELECT *, CASE WHEN lag(ord) OVER w IS NULL OR account IS DISTINCT FROM lag(account) OVER w THEN 1 ELSE 0 END AS changed
            FROM candidates WINDOW w AS (ORDER BY ord)
          ), routing_groups AS (
            SELECT *, SUM(changed) OVER (ORDER BY ord) AS grp FROM routing_changes
          ), routing_blocks AS MATERIALIZED (
            SELECT MIN(ord) AS ord, account, COUNT(*)::int AS count FROM routing_groups GROUP BY grp, account
          ), ledger AS (
            SELECT e FROM raw_run r CROSS JOIN LATERAL jsonb_array_elements(
              CASE WHEN jsonb_typeof(r.r->'attemptLedger') = 'array' THEN r.r->'attemptLedger' ELSE '[]'::jsonb END
            ) e
          )
          SELECT
            (SELECT heavy_hit FROM cache_check) AS heavy_hit,
            (SELECT heavy_key FROM cache_check) AS heavy_key,
            (SELECT row_to_json(c) FROM cycle_now c) AS cycle_row,
            CASE WHEN (SELECT heavy_hit FROM cache_check) THEN '[]'::json ELSE COALESCE((SELECT json_agg(json_build_object('state', state, 'count', count)) FROM posts_stats), '[]'::json) END AS counts_rows,
            CASE WHEN (SELECT heavy_hit FROM cache_check) THEN NULL::int ELSE COALESCE((SELECT SUM(claimable_non_protected)::int FROM posts_stats), 0) END AS claimable_pending,
            (SELECT active_count FROM res_sig) AS active_count,
            COALESCE((SELECT json_agg(s) FROM settings s), '[]'::json) AS settings_rows,
            COALESCE((SELECT json_agg(op) FROM (
              SELECT key, CASE WHEN key = 'posting' THEN (value_json::jsonb - 'attemptOutcomes' - 'quota')::text ELSE value_json END AS value_json
              FROM operational_state WHERE key IN ('vpnSlots', 'accountChecks', 'posting', 'nextPostAt', 'publishingAt', 'cooling')
            ) op), '[]'::json) AS op_rows,
            (SELECT jsonb_build_object('runId', r->'runId', 'accountIds', r->'accountIds', 'cursor', r->'cursor',
              'stopAfterSuccess', r->'stopAfterSuccess') FROM raw_run) AS run_meta,
            CASE WHEN (SELECT heavy_hit FROM cache_check) THEN NULL::jsonb ELSE
              jsonb_build_object(
                'scopeKnown', COALESCE((SELECT scope_known FROM run_scope), false),
                'candidateCount', (SELECT COUNT(*)::int FROM candidates),
                'retryOrderUnknown', EXISTS (SELECT 1 FROM candidates WHERE pre_dispatch_retries > 0),
                'duplicateOrderUnknown', EXISTS (SELECT 1 FROM candidates GROUP BY text_key HAVING COUNT(*) > 1),
                'invalidBinding', EXISTS (SELECT 1 FROM candidates WHERE invalid_binding),
                'unresolvedPublish', EXISTS (SELECT 1 FROM run_posts WHERE state IN ('processing', 'dispatch_started', 'ambiguous'))
                  OR EXISTS (SELECT 1 FROM reservations res, raw_run rr WHERE res.run_id = rr.r->>'runId' AND res.phase IN ('claimed', 'dispatching')),
                'truncated', (SELECT COUNT(*) > 256 FROM routing_blocks),
                'blocks', COALESCE((SELECT jsonb_agg(jsonb_build_object('account', b.account, 'count', b.count) ORDER BY b.ord)
                  FROM (SELECT * FROM routing_blocks ORDER BY ord LIMIT 256) b), '[]'::jsonb)
              )
            END AS eta_projection,
            (SELECT jsonb_build_object(
              'succeeded', COUNT(*) FILTER (WHERE e->>'outcome' IN ('succeeded', 'published')
                AND COALESCE(e->'preDispatchRetry', 'false'::jsonb) IN ('false'::jsonb, 'null'::jsonb, '0'::jsonb, '\"\"'::jsonb)),
              'failed', COUNT(*) FILTER (WHERE e->>'outcome' = 'failed'
                AND COALESCE(e->'preDispatchRetry', 'false'::jsonb) IN ('false'::jsonb, 'null'::jsonb, '0'::jsonb, '\"\"'::jsonb))) FROM ledger) AS run_totals,
            jsonb_build_object(
              'published', COALESCE((
                (SELECT count(*)::int FROM publish_results
                 WHERE outcome = 'published'
                   AND completed_at ~ '^\\d{4}-\\d{2}-\\d{2}T.*Z$'
                   AND completed_at >= $3 AND completed_at < $4)
                +
                (SELECT count(*)::int FROM publish_results
                 WHERE outcome = 'published'
                   AND completed_at !~ '^\\d{4}-\\d{2}-\\d{2}T.*Z$'
                   AND completed_at::timestamptz >= ($1 || ' 00:00:00 Asia/Riyadh')::timestamptz
                   AND completed_at::timestamptz < (($1 || ' 00:00:00 Asia/Riyadh')::timestamptz + INTERVAL '1 day'))
              ), 0),
              'failed', COALESCE((
                (SELECT count(*)::int FROM publish_results
                 WHERE outcome IN ('failed', 'ambiguous')
                   AND completed_at ~ '^\\d{4}-\\d{2}-\\d{2}T.*Z$'
                   AND completed_at >= $3 AND completed_at < $4)
                +
                (SELECT count(*)::int FROM publish_results
                 WHERE outcome IN ('failed', 'ambiguous')
                   AND completed_at !~ '^\\d{4}-\\d{2}-\\d{2}T.*Z$'
                   AND completed_at::timestamptz >= ($1 || ' 00:00:00 Asia/Riyadh')::timestamptz
                   AND completed_at::timestamptz < (($1 || ' 00:00:00 Asia/Riyadh')::timestamptz + INTERVAL '1 day'))
              ), 0),
              'preDispatchRetries', COALESCE((
                SELECT count(*)::int FROM post_attempts
                WHERE (outcome = 'pre_dispatch_retry' OR phase = 'recovered_pre_dispatch')
                  AND dispatch_started_at IS NULL
                  AND (
                    (COALESCE(completed_at, started_at) ~ '^\\d{4}-\\d{2}-\\d{2}T.*Z$'
                     AND COALESCE(completed_at, started_at) >= $3 AND COALESCE(completed_at, started_at) < $4)
                    OR
                    (COALESCE(completed_at, started_at) !~ '^\\d{4}-\\d{2}-\\d{2}T.*Z$'
                     AND COALESCE(completed_at, started_at)::timestamptz >= ($1 || ' 00:00:00 Asia/Riyadh')::timestamptz
                     AND COALESCE(completed_at, started_at)::timestamptz < (($1 || ' 00:00:00 Asia/Riyadh')::timestamptz + INTERVAL '1 day'))
                  )
              ), 0)
            ) AS daily_counters,
            COALESCE((SELECT json_agg(ac) FROM account_checks ac), '[]'::json) AS checks_rows,
            COALESCE((SELECT json_agg(vs) FROM vpn_slots vs), '[]'::json) AS vpn_rows,
            COALESCE((
              SELECT json_agg(acc ORDER BY acc.position ASC, acc.id ASC)
              FROM (
                SELECT a.id, a.position, a.username, a.enabled, a.exit_ip, a.vpn_resource,
                  COALESCE(a.status, a.source_json::jsonb->>'status') AS status, a.failures, a.check_generation, a.cookie_file, a.quota_json,
                  COALESCE(a.user_id, a.source_json::jsonb->>'userId') AS user_id,
                  a.source_json::jsonb->'needsOwnerCaptcha' AS needs_owner_captcha,
                  jsonb_build_object('challenge', a.source_json::jsonb->'challenge', 'locked', a.source_json::jsonb->'locked',
                    'captcha', a.source_json::jsonb->'captcha', 'suspended', a.source_json::jsonb->'suspended',
                    'banned', a.source_json::jsonb->'banned', 'accountFailure', a.source_json::jsonb->'accountFailure') AS restriction_flags,
                  COALESCE(q.used, 0)::int AS quota_used
                FROM accounts a LEFT JOIN quota q ON q.account_id = a.id AND q.day = $1
              ) acc
            ), '[]'::json) AS accounts_rows
        `, [quotaDay, candidateKey, utcStart, utcEnd]);
        const row = res.rows[0] || {};
        const usedHeavyCache = Boolean(
          row.heavy_hit &&
          this._dashboardHeavyCache &&
          this._dashboardHeavyCache.key === row.heavy_key
        );
        const countsRows = usedHeavyCache ? this._dashboardHeavyCache.countsRows : (row.counts_rows || []);
        const claimablePending = usedHeavyCache ? this._dashboardHeavyCache.claimablePending : Number(row.claimable_pending || 0);
        const etaProjection = usedHeavyCache ? this._dashboardHeavyCache.etaProjection : (parse(row.eta_projection, {}) || {});
        if (!usedHeavyCache && row.heavy_key) {
          this._dashboardHeavyCache = {
            key: row.heavy_key,
            localGen: this.mutationGeneration,
            localRev: this._postCacheRevision,
            countsRows,
            claimablePending,
            etaProjection
          };
        }
        return { row, countsRows, claimablePending, etaProjection };
      })().finally(() => {
        if (this._snapshotInFlight.get(quotaDay) === inFlight) {
          this._snapshotInFlight.delete(quotaDay);
        }
      });
      this._snapshotInFlight.set(quotaDay, inFlight);
    }

    const { row, countsRows, claimablePending, etaProjection } = await inFlight;
    const cycleRow = row.cycle_row || { state: 'stopped', run_id: null };
    const cycle = { state: cycleRow.state, runId: cycleRow.run_id, startedAt: cycleRow.started_at,
      updatedAt: cycleRow.updated_at, reason: cycleRow.reason };
    const counts = Object.fromEntries((countsRows || []).map(r => [r.state, Number(r.count)]));
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const active = Number(row.active_count || 0);
    const settings = Object.fromEntries((row.settings_rows || []).map(r => [r.key, parse(r.value_json)]));
    const opMap = new Map((row.op_rows || []).map(r => [r.key, parse(r.value_json)]));
    const accounts = (row.accounts_rows || []).map(accRow => {
      const quotaLimit = parse(accRow.quota_json);
      const cap = accountCapacity(
        { settings, posting: { quota: { [quotaDay]: { [accRow.id]: Number(accRow.quota_used) } } } },
        { id: accRow.id, quota: quotaLimit }, new Date(`${quotaDay}T12:00:00Z`)
      );
      const { quota_json, position, needs_owner_captcha, restriction_flags, ...rest } = accRow;
      return { ...rest, ...(restriction_flags || {}), needsOwnerCaptcha: needs_owner_captcha,
        enabled: Boolean(accRow.enabled), failures: Number(accRow.failures || 0),
        quota_used: Number(accRow.quota_used || 0), quota_limit: quotaLimit, quotaRemaining: cap.remaining };
    });
    const vpnSlots = opMap.has('vpnSlots') ? opMap.get('vpnSlots')
      : Object.fromEntries((row.vpn_rows || []).map(r => [r.account_id, Number(r.slot_index ?? r.slot)]));
    const checksRows = row.checks_rows || [];
    const accountChecks = checksRows.length > 0
      ? Object.fromEntries(checksRows.map(r => [r.account_id, parse(r.source_json, {})])) : (opMap.get('accountChecks') || {});
    const posting = { ...(opMap.get('posting') || {}) };
    for (const k of ['nextPostAt', 'publishingAt', 'cooling']) if (opMap.has(k)) posting[k] = opMap.get(k);
    const runMeta = parse(row.run_meta, {}) || {};
    const runTotals = parse(row.run_totals, { succeeded: 0, failed: 0 });
    const dailyCounters = parse(row.daily_counters, { published: 0, failed: 0, preDispatchRetries: 0 });
    const etaState = { cycle, settings, accounts: accounts.map(a => ({ ...a, userId: a.user_id,
      cookieFile: a.cookie_file, checkGeneration: a.check_generation, quota: a.quota_limit })),
      posting: { ...posting, quota: { [quotaDay]: Object.fromEntries(accounts.map(a => [a.id, a.quota_used])) } },
      telegramUi: { run: runMeta, accountChecks } };
    const policies = new Map(etaState.accounts.map(a => [a.id, evaluateAccountUse(etaState, a, { nowMs: +new Date(now), requireOwnerEnabled: true })]));
    const unavailable = etaState.accounts.find(a => (runMeta.accountIds || []).includes(a.id) && a.enabled && a.quotaRemaining > 0 && !policies.get(a.id).allowed);
    const eligibleAccounts = etaState.accounts.filter(a => (runMeta.accountIds || []).includes(a.id) && policies.get(a.id)?.allowed === true);
    let accountReason = null;
    if (quotaDay !== riyadhDay(now)) {
      accountReason = 'quota_day_mismatch';
    } else if (eligibleAccounts.length === 0 && unavailable) {
      accountReason = 'account_' + policies.get(unavailable.id).reason;
    }
    const eta = estimateProjectedCycle(etaState, etaProjection, { now,
      eligible: a => policies.get(a.id)?.allowed === true,
      accountReason });
    return { cycle, total, counts, claimablePending, active, accounts,
      quota: { day: quotaDay, dailyQuota: settings.dailyQuota }, vpnSlots, accountChecks,
      posting, runTotals, dailyCounters, todayMetrics: dailyCounters, eta, settings, observedAt: new Date(now).toISOString() };
  }

  async pruneConfirmedDaily(options) {
    return require('./pgRetention').pruneConfirmedDaily(this,options);
  }

  // Native async repository transaction. The shared business-state advisory
  // fence remains in A; update() mutators remain synchronous and unchanged.
  async importTransaction(fn, { uiOnly = false, _afterCommit } = {}) {
    assertPgMutationAllowed(this.pgConfig);
    if (this.readOnly) throw new Error('READ_ONLY_STORE');
    await this._ensureInitialized();
    return this._serialize('write', async () => {
      const client = await this.pool.connect();
      const { PgImportRepository } = require('./pgImportRepository');
      const repo = new PgImportRepository(client, this);
      let result, committed = false, clientErr;
      try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtext('yj_autopost_store:' || current_schema()))");
        result = await fn(repo);
        await client.query('COMMIT');
        committed = true;
        for (const apply of repo.afterCommit) apply();
        if (repo.stateChanged) this._postCacheHydrated = false;
        if (repo.changed) {
          this.mutationGeneration++;
          this.state = null;
          this._dashboardHeavyCache = null;
          if (!uiOnly) this._notifyMutation(null);
        }
      } catch (err) {
        clientErr = err;
        if (!committed) try { await client.query('ROLLBACK'); } catch {}
        // Never retain a cache watermark from a rolled back hydration/persist.
        this._postCacheHydrated = false;
        throw err;
      } finally {
        client.release(clientErr);
      }
      return result;
    }).then(async result => {
      // Run outside both the SQL transaction and this store's write lane: a
      // durable follow-up may itself enqueue a canonical write without deadlock.
      await _afterCommit?.(result);
      return result;
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    // Never enqueue shutdown behind a possibly blocked application write.
    if (this.ownsPool && this.pool) {
      try { await this.pool.end(); } catch {}
    }
  }
}

module.exports = {
  PgStore,
  resolvePgConfig,
  assertPgMutationAllowed,
  readPgPassword,
  PG_SCHEMA_SQL,
  rowToPostItem,
  postItemToParams,
  rowToAccount,
  accountToParams
};
