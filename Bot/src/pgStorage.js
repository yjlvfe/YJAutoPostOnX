'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool, types } = require('pg');

const SCHEMA_VERSION = 3;
const DEFAULT_SECRET_PATH = path.resolve(__dirname, '../data/secrets/pg_password');
const { isClaimable, isProvenPreDispatch, MAX_PRE_DISPATCH_RETRIES } = require('./queue');
const { accountCapacity, riyadhDay } = require('./quota');

const { evaluateAccountUse } = require('./accounts');
if (typeof evaluateAccountUse !== 'function') throw new Error('CANONICAL_ACCOUNT_POLICY_UNAVAILABLE');

// Parse PostgreSQL INT8 (BIGINT, OID 20) into JS Number when within safe integer bounds
// so COUNT(*), sequence_no, touched, received, etc. match node:sqlite numeric types.
types.setTypeParser(20, val => {
  if (val === null || val === undefined) return null;
  const num = Number(val);
  return Number.isSafeInteger(num) ? num : val;
});

const AUXILIARY_TABLES = Object.freeze([
  'telegram_navigation_receipts',
  'file_import_jobs',
  'account_import_batches',
  'account_import_groups',
  'text_upload_inbox',
  'import_seen',
  'import_protected',
  'protected_state_checks'
]);

function claimable(item) {
  return isClaimable(item) ? 1 : 0;
}

function json(value) {
  const encoded = JSON.stringify(value == null ? null : value);
  if (encoded === undefined) throw new TypeError('Value is not JSON serializable');
  return encoded;
}

function parse(value, fallback = null) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function textKey(value) {
  return typeof value === 'string'
    ? value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase()
    : '';
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, stableValue(value[key])])
    );
  }
  return value;
}

function validIdentifier(name, label = 'identifier') {
  if (typeof name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new TypeError(`Invalid SQL ${label}: ${String(name)}`);
  }
  return name;
}

function isTestEnvironment() {
  return Boolean(
    process.env?.NODE_ENV === 'test' ||
    process.env?.NODE_TEST_CONTEXT ||
    process.env?.npm_lifecycle_event === 'test' ||
    process.env?.YJ_TEST_MODE === '1' ||
    process.execArgv?.some(arg => typeof arg === 'string' && (arg === '--test' || arg.startsWith('--test='))) ||
    (process.argv?.[1] && typeof process.argv[1] === 'string' && process.argv[1].endsWith('.test.js'))
  );
}

function assertNoSymlinkedPath(targetPath) {
  const resolved = path.resolve(String(targetPath || ''));
  const parts = resolved.split(path.sep);
  let current = path.sep;
  for (const part of parts) {
    if (!part) continue;
    current = path.join(current, part);
    if (fs.existsSync(current)) {
      let stat;
      try {
        stat = fs.lstatSync(current);
      } catch (err) {
        if (err.code === 'ENOENT') continue;
        throw err;
      }
      if (stat.isSymbolicLink()) {
        throw Object.assign(
          new Error(`PG_PASSWORD_FILE_UNSAFE: Path component is a symbolic link: ${current}`),
          { code: 'PG_PASSWORD_FILE_UNSAFE' }
        );
      }
    }
  }
  if (fs.existsSync(resolved)) {
    let real;
    try { real = fs.realpathSync(resolved); } catch (err) {
      if (err.code === 'ENOENT') return resolved;
      throw err;
    }
    if (real !== resolved) {
      throw Object.assign(
        new Error(`PG_PASSWORD_FILE_UNSAFE: Canonical realpath mismatch for ${resolved}`),
        { code: 'PG_PASSWORD_FILE_UNSAFE' }
      );
    }
  }
  return resolved;
}

function readPgPassword(secretPath = DEFAULT_SECRET_PATH) {
  if (!secretPath || secretPath === DEFAULT_SECRET_PATH) {
    if (process.env.PGPASSWORD) return process.env.PGPASSWORD.trim();
  }
  const candidate = secretPath || process.env.PG_PASSWORD_FILE || DEFAULT_SECRET_PATH;
  const resolved = assertNoSymlinkedPath(candidate);
  if (!fs.existsSync(resolved)) {
    const err = new Error(`PG_PASSWORD_FILE_NOT_FOUND: Password secret file not found: ${resolved}`);
    err.code = 'ENOENT';
    throw err;
  }
  let handle;
  try {
    handle = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    if (err.code === 'ELOOP' || err.code === 'EMLINK') {
      throw Object.assign(new Error('PG_PASSWORD_FILE_UNSAFE: Symlink detected'), { code: 'PG_PASSWORD_FILE_UNSAFE' });
    }
    throw err;
  }
  try {
    const stat = fs.fstatSync(handle);
    if (!stat.isFile()) {
      throw Object.assign(new Error('PG_PASSWORD_FILE_UNSAFE: Password secret is not a regular file'), { code: 'PG_PASSWORD_FILE_UNSAFE' });
    }
    if (stat.nlink !== 1) {
      throw Object.assign(new Error('PG_PASSWORD_FILE_UNSAFE: Multiple hard links detected on password file'), { code: 'PG_PASSWORD_FILE_UNSAFE' });
    }
    if ((stat.mode & 0o077) !== 0) {
      throw Object.assign(new Error('PG_PASSWORD_FILE_UNSAFE: Password file permissions must be private (no group/other access)'), { code: 'PG_PASSWORD_FILE_UNSAFE' });
    }
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (currentUid !== null) {
      if (currentUid === 0 && stat.uid !== 0) {
        throw Object.assign(new Error('PG_PASSWORD_FILE_UNSAFE: Password file must be owned by root when running as root'), { code: 'PG_PASSWORD_FILE_UNSAFE' });
      } else if (currentUid !== 0 && stat.uid !== currentUid) {
        throw Object.assign(new Error('PG_PASSWORD_FILE_UNSAFE: Password file owner mismatch'), { code: 'PG_PASSWORD_FILE_UNSAFE' });
      }
    }
    const buffer = Buffer.alloc(stat.size);
    fs.readSync(handle, buffer, 0, stat.size, 0);
    return buffer.toString('utf8').trim();
  } finally {
    try { fs.closeSync(handle); } catch {}
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

function riyadhDayUtcBounds(quotaDay) {
  const startMs = Date.parse(`${quotaDay}T00:00:00.000+03:00`);
  if (!Number.isFinite(startMs)) return { utcStart: '1970-01-01T00:00:00.000Z', utcEnd: '1970-01-02T00:00:00.000Z' };
  return {
    utcStart: new Date(startMs).toISOString(),
    utcEnd: new Date(startMs + 86400000).toISOString()
  };
}

function getPgConfig(overrides = {}) {
  const host = overrides.host || process.env.PGHOST || '127.0.0.1';
  const port = Number(overrides.port || process.env.PGPORT || 5432);
  const user = overrides.user || process.env.PGUSER || 'yj_bot_app';
  const database = overrides.database || process.env.PGDATABASE || 'yj_autopost';
  const password = overrides.password != null
    ? String(overrides.password)
    : readPgPassword(overrides.secretPath || DEFAULT_SECRET_PATH);
  const max = Number(overrides.max || process.env.PGPOOL_MAX || 20);
  const idleTimeoutMillis = overrides.idleTimeoutMillis ?? 30000;
  const connectionTimeoutMillis = overrides.connectionTimeoutMillis ?? 5000;
  const schema = validIdentifier(overrides.schema || process.env.PGSCHEMA || 'public', 'schema');
  const allowProductionMigration = overrides.allowProductionMigration === true;
  const statementTimeoutMs = validTimeoutMs(overrides.statementTimeoutMs ?? process.env.PG_STATEMENT_TIMEOUT_MS, 15000);
  const lockTimeoutMs = validTimeoutMs(overrides.lockTimeoutMs ?? process.env.PG_LOCK_TIMEOUT_MS, 10000);
  const idleInTxTimeoutMs = validTimeoutMs(overrides.idleInTransactionSessionTimeoutMs ?? process.env.PG_IDLE_IN_TX_TIMEOUT_MS, 30000);
  const workMem = validWorkMem(overrides.workMem || process.env.PG_WORK_MEM, '32MB');
  const jit = validJit(overrides.jit ?? process.env.PG_JIT, 'off');
  const searchPath = schema !== 'public' ? `${schema},public` : 'public';
  const options = overrides.options || (
    `-c search_path=${searchPath} -c TimeZone=Asia/Riyadh` +
    ` -c statement_timeout=${statementTimeoutMs}` +
    ` -c lock_timeout=${lockTimeoutMs}` +
    ` -c idle_in_transaction_session_timeout=${idleInTxTimeoutMs}` +
    ` -c work_mem=${workMem}` +
    ` -c jit=${jit}`
  );

  return {
    ...overrides,
    host,
    port,
    user,
    database,
    password,
    max,
    idleTimeoutMillis,
    connectionTimeoutMillis,
    schema,
    allowProductionMigration,
    options
  };
}

function assertPgMutationAllowed(config = {}, { migration = false } = {}) {
  const cfg = config && config.database ? config : getPgConfig(config);
  if (cfg.database !== 'yj_autopost') return;
  if (cfg.allowProductionMigration === true) return;
  if (migration) {
    throw Object.assign(new Error('PG_PRODUCTION_MIGRATION_REQUIRES_OPT_IN: Migration requires allowProductionMigration: true'), {
      code: 'PG_PRODUCTION_MIGRATION_REQUIRES_OPT_IN'
    });
  }
  if (isTestEnvironment()) {
    throw Object.assign(new Error('REFUSING_PRODUCTION_PG_MUTATION_IN_TEST: yj_autopost is forbidden in tests'), {
      code: 'REFUSING_PRODUCTION_PG_MUTATION_IN_TEST'
    });
  }
}

function createPool(configOverrides = {}) {
  const cfg = getPgConfig(configOverrides);
  const pool = new Pool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    database: cfg.database,
    password: cfg.password,
    max: cfg.max,
    idleTimeoutMillis: cfg.idleTimeoutMillis,
    connectionTimeoutMillis: cfg.connectionTimeoutMillis,
    options: cfg.options
  });
  pool._yjConfig = cfg;
  pool.on('connect', client => {
    client._yjConfig = cfg;
  });
  pool.on('error', err => {
    try {
      const { logStructured, sanitizeError } = require('./structuredLogger');
      logStructured(null, {
        level: 'warn',
        component: 'pg_pool',
        event: 'pg_idle_client_error',
        operation: 'pool.error',
        result: 'suppressed',
        sanitizedError: sanitizeError(err)
      });
    } catch {}
  });
  return pool;
}

function isPool(poolOrClient) {
  return Boolean(
    poolOrClient &&
    typeof poolOrClient.connect === 'function' &&
    typeof poolOrClient.release !== 'function' &&
    ('totalCount' in poolOrClient || poolOrClient.constructor?.name?.includes('Pool'))
  );
}

async function withClient(poolOrClient, fn) {
  if (!poolOrClient || typeof poolOrClient.query !== 'function') {
    throw new TypeError('A pg Pool or Client instance is required');
  }
  if (!isPool(poolOrClient)) {
    return await fn(poolOrClient);
  }
  const client = await poolOrClient.connect();
  client._yjConfig = poolOrClient._yjConfig || client._yjConfig;
  let clientErr;
  try {
    if (client._yjConfig?.schema && client._yjConfig.schema !== 'public' && !client._searchPathSet) {
      const schema = validIdentifier(client._yjConfig.schema, 'schema');
      await client.query(`SET search_path TO "${schema}", public`);
      client._searchPathSet = true;
    }
    return await fn(client);
  } catch (err) {
    clientErr = err;
    throw err;
  } finally {
    client.release(clientErr);
  }
}

async function withTransaction(poolOrClient, fn, { readOnly = false, exclusive = false } = {}) {
  return await withClient(poolOrClient, async client => {
    if (client._inYjTx) {
      return await fn(client);
    }
    await client.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
    client._inYjTx = true;
    try {
      // Full-state PgStore updates take the exclusive form of this exact key.
      // Row-level helpers share the fence so independent SKIP LOCKED claims
      // remain concurrent, while a stale full-state writer cannot race them.
      if (!readOnly) await client.query(exclusive
        ? "SELECT pg_advisory_xact_lock(hashtext('yj_autopost_store:' || current_schema()))"
        : "SELECT pg_advisory_xact_lock_shared(hashtext('yj_autopost_store:' || current_schema()))");
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {}
      throw error;
    } finally {
      client._inYjTx = false;
    }
  });
}

const PG_SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS meta(
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS posts(
    id TEXT PRIMARY KEY,
    position INTEGER NOT NULL,
    content_hash TEXT,
    text TEXT,
    text_key TEXT,
    payload_json TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at TEXT,
    reason TEXT,
    published_at TEXT,
    url TEXT,
    tweet_id TEXT,
    account_id TEXT,
    account_username TEXT,
    claimed_at TEXT,
    pre_dispatch_retries INTEGER NOT NULL DEFAULT 0,
    claimable INTEGER NOT NULL DEFAULT 0,
    attempt_json TEXT,
    archived_attempt_json TEXT,
    archived_attempts_json TEXT,
    outcome_json TEXT,
    result_json TEXT,
    recovery_history_json TEXT,
    failure_diagnostic_json TEXT,
    owner_assisted_package_json TEXT,
    source_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS posts_claimable_position ON posts(claimable, state, position, id);
  CREATE INDEX IF NOT EXISTS posts_state_position ON posts(state, position, id);
  CREATE INDEX IF NOT EXISTS posts_state_account ON posts(state, account_id, position);
  CREATE INDEX IF NOT EXISTS posts_content_hash ON posts(content_hash);
  CREATE INDEX IF NOT EXISTS posts_text_key_state_position ON posts(text_key, state, position);
  CREATE INDEX IF NOT EXISTS posts_protected_text_key ON posts(text_key) WHERE claimable = 0 AND state <> 'cancelled' AND text_key <> '';
  CREATE INDEX IF NOT EXISTS posts_claimable_pending_text_key ON posts(text_key) WHERE claimable = 1 AND state = 'pending';
  CREATE INDEX IF NOT EXISTS posts_tweet_id ON posts(tweet_id);
  CREATE INDEX IF NOT EXISTS posts_position_id ON posts(position, id);
  CREATE INDEX IF NOT EXISTS posts_in_flight ON posts(id) WHERE state IN ('processing', 'dispatch_started');

  CREATE TABLE IF NOT EXISTS accounts(
    id TEXT PRIMARY KEY,
    position INTEGER NOT NULL,
    label TEXT,
    username TEXT,
    user_id TEXT,
    enabled INTEGER NOT NULL,
    cookie_file TEXT,
    verified_at TEXT,
    vpn_resource TEXT,
    quota_json TEXT,
    delay_ms DOUBLE PRECISION,
    exit_ip TEXT,
    status TEXT,
    check_generation TEXT,
    failures INTEGER NOT NULL DEFAULT 0,
    source_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS accounts_enabled_position ON accounts(enabled, position);

  CREATE TABLE IF NOT EXISTS quota(
    day TEXT NOT NULL,
    account_id TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    source_json TEXT,
    PRIMARY KEY(day, account_id)
  );
  CREATE INDEX IF NOT EXISTS quota_account_day ON quota(account_id, day);

  CREATE TABLE IF NOT EXISTS schedules(
    id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    hour INTEGER NOT NULL DEFAULT 0,
    minute INTEGER NOT NULL DEFAULT 0,
    timezone TEXT NOT NULL DEFAULT 'Asia/Riyadh',
    last_triggered_day TEXT,
    updated_at TEXT,
    source_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS cycle_state(
    id INTEGER PRIMARY KEY CHECK(id=1),
    state TEXT NOT NULL,
    run_id TEXT,
    started_at TEXT,
    updated_at TEXT,
    reason TEXT,
    source_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings(
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS reservations(
    post_id TEXT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    run_id TEXT NOT NULL,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    phase TEXT NOT NULL,
    claimed_at TEXT NOT NULL,
    dispatch_started_at TEXT,
    source_json TEXT
  );
  CREATE INDEX IF NOT EXISTS reservations_account_phase ON reservations(account_id, phase);
  CREATE INDEX IF NOT EXISTS reservations_phase_run ON reservations(phase, run_id);

  CREATE TABLE IF NOT EXISTS post_attempts(
    id BIGSERIAL PRIMARY KEY,
    post_id TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    run_id TEXT,
    account_id TEXT,
    phase TEXT NOT NULL,
    outcome TEXT,
    started_at TEXT,
    dispatch_started_at TEXT,
    completed_at TEXT,
    admission_json TEXT,
    failure_diagnostic_json TEXT,
    result_json TEXT,
    source_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS post_attempts_post ON post_attempts(post_id, id);
  CREATE INDEX IF NOT EXISTS post_attempts_account ON post_attempts(account_id, id);
  CREATE INDEX IF NOT EXISTS post_attempts_retry_lookup ON post_attempts(outcome, dispatch_started_at, completed_at, started_at);
  CREATE INDEX IF NOT EXISTS post_attempts_daily_retry ON post_attempts(completed_at, started_at) WHERE (outcome = 'pre_dispatch_retry' OR phase = 'recovered_pre_dispatch') AND dispatch_started_at IS NULL;

  CREATE TABLE IF NOT EXISTS publish_results(
    post_id TEXT PRIMARY KEY,
    token TEXT,
    account_id TEXT,
    account_username TEXT,
    outcome TEXT NOT NULL,
    published_at TEXT,
    completed_at TEXT NOT NULL,
    url TEXT,
    tweet_id TEXT,
    reason TEXT,
    result_json TEXT,
    failure_diagnostic_json TEXT,
    source_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS publish_results_account_outcome ON publish_results(account_id, outcome);
  CREATE INDEX IF NOT EXISTS publish_results_outcome_completed ON publish_results(outcome, completed_at);
  CREATE INDEX IF NOT EXISTS publish_results_non_utc ON publish_results(outcome, completed_at) WHERE completed_at !~ '^\\d{4}-\\d{2}-\\d{2}T.*Z$';

  CREATE TABLE IF NOT EXISTS attempt_outcomes(
    day TEXT NOT NULL,
    account_id TEXT NOT NULL,
    failed INTEGER NOT NULL DEFAULT 0,
    ambiguous INTEGER NOT NULL DEFAULT 0,
    published INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT,
    source_json TEXT NOT NULL,
    PRIMARY KEY(day, account_id)
  );

  CREATE TABLE IF NOT EXISTS session_leases(
    lease_id TEXT PRIMARY KEY,
    worker_token TEXT NOT NULL,
    account_id TEXT,
    session_key TEXT UNIQUE,
    node_pid INTEGER NOT NULL,
    owner_starttime TEXT,
    host_identity TEXT NOT NULL,
    child_pid INTEGER,
    child_starttime TEXT,
    child_pgid INTEGER,
    child_sid INTEGER,
    descendant_identities JSONB NOT NULL DEFAULT '[]'::jsonb,
    lease_state TEXT NOT NULL,
    acquired_at BIGINT NOT NULL,
    heartbeat_at BIGINT NOT NULL,
    meta TEXT
  );
  DO $session_leases$
  DECLARE
    missing_cols INTEGER;
    row_count BIGINT;
  BEGIN
    SELECT count(*) INTO missing_cols
    FROM unnest(ARRAY['worker_token','lease_state','host_identity','child_pgid','child_sid','descendant_identities']) AS col
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'session_leases' AND column_name = col
    );
    IF missing_cols > 0 THEN
      PERFORM pg_advisory_xact_lock(749321468520011::bigint);
      LOCK TABLE session_leases IN ACCESS EXCLUSIVE MODE;
      EXECUTE 'SELECT count(*) FROM session_leases' INTO row_count;
      IF row_count > 0 THEN
        RAISE EXCEPTION 'SESSION_SCHEMA_DRAIN_REQUIRED' USING ERRCODE = 'P0001';
      END IF;
      ALTER TABLE session_leases ADD COLUMN IF NOT EXISTS worker_token TEXT;
      ALTER TABLE session_leases ADD COLUMN IF NOT EXISTS lease_state TEXT;
      ALTER TABLE session_leases ADD COLUMN IF NOT EXISTS host_identity TEXT;
      ALTER TABLE session_leases ADD COLUMN IF NOT EXISTS child_pgid INTEGER;
      ALTER TABLE session_leases ADD COLUMN IF NOT EXISTS child_sid INTEGER;
      ALTER TABLE session_leases ADD COLUMN IF NOT EXISTS descendant_identities JSONB NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE session_leases ALTER COLUMN worker_token SET NOT NULL;
      ALTER TABLE session_leases ALTER COLUMN lease_state SET NOT NULL;
      ALTER TABLE session_leases ALTER COLUMN host_identity SET NOT NULL;
    END IF;
  END $session_leases$;
  CREATE UNIQUE INDEX IF NOT EXISTS session_leases_account_unique
    ON session_leases(account_id) WHERE account_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS session_leases_worker_token_unique
    ON session_leases(worker_token);
  CREATE UNIQUE INDEX IF NOT EXISTS session_leases_session_key_unique
    ON session_leases(session_key);
  CREATE UNIQUE INDEX IF NOT EXISTS session_leases_child_identity_unique
    ON session_leases(host_identity,child_pid,child_starttime) WHERE child_pid IS NOT NULL;

  CREATE TABLE IF NOT EXISTS vpn_slots(
    account_id TEXT PRIMARY KEY,
    slot_index INTEGER NOT NULL,
    exit_ip TEXT,
    updated_at TEXT,
    source_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS vpn_slots_slot_index ON vpn_slots(slot_index);

  CREATE TABLE IF NOT EXISTS burned_subnets(
    subnet TEXT PRIMARY KEY,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT,
    source_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS account_checks(
    account_id TEXT PRIMARY KEY,
    vpn_json TEXT,
    session_json TEXT,
    last_error TEXT,
    updated_at TEXT,
    source_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS idempotency_fences(
    fence_key TEXT PRIMARY KEY,
    fence_type TEXT NOT NULL,
    post_id TEXT,
    created_at TEXT NOT NULL,
    source_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idempotency_fences_post ON idempotency_fences(post_id);

  CREATE TABLE IF NOT EXISTS ambiguous_fences(
    content_key TEXT PRIMARY KEY,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    source_json TEXT
  );
  CREATE INDEX IF NOT EXISTS ambiguous_fences_position ON ambiguous_fences(position, content_key);

  CREATE TABLE IF NOT EXISTS outbox(
    id TEXT PRIMARY KEY,
    sequence_no BIGINT NOT NULL UNIQUE,
    dedupe_key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    created_at TEXT NOT NULL,
    delivered_at TEXT,
    source_json TEXT
  );
  CREATE INDEX IF NOT EXISTS outbox_sequence ON outbox(sequence_no);
  CREATE INDEX IF NOT EXISTS outbox_delivery ON outbox(status, next_attempt_at, created_at);

  CREATE TABLE IF NOT EXISTS link_deliveries(
    delivery_id TEXT PRIMARY KEY,
    sequence_no INTEGER NOT NULL DEFAULT 0,
    outbox_id TEXT,
    run_id TEXT,
    day TEXT,
    kind TEXT,
    chat_id TEXT,
    item_ids_json TEXT NOT NULL,
    content_hash TEXT,
    attempted INTEGER NOT NULL DEFAULT 0,
    ok INTEGER NOT NULL DEFAULT 0,
    message_id BIGINT,
    attempted_at TEXT,
    delivered_at TEXT,
    source_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS link_deliveries_lookup ON link_deliveries(day, chat_id, run_id, ok);
  CREATE INDEX IF NOT EXISTS link_deliveries_sequence ON link_deliveries(sequence_no, delivery_id);

  CREATE TABLE IF NOT EXISTS link_terminal_events(
    event_id TEXT PRIMARY KEY,
    sequence_no INTEGER NOT NULL,
    run_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    day TEXT,
    reconciled INTEGER NOT NULL DEFAULT 0,
    suppressed INTEGER NOT NULL DEFAULT 0,
    reason TEXT,
    content_hash TEXT,
    source_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS link_terminal_identity ON link_terminal_events(run_id, chat_id, sequence_no);

  CREATE TABLE IF NOT EXISTS manual_links(
    id TEXT PRIMARY KEY,
    position INTEGER NOT NULL DEFAULT 0,
    url TEXT NOT NULL,
    state TEXT,
    published_at TEXT,
    source TEXT,
    source_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS forensic_outbox(
    id TEXT PRIMARY KEY,
    position INTEGER NOT NULL DEFAULT 0,
    event_time TEXT,
    event_type TEXT,
    payload_json TEXT NOT NULL,
    source_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS forensic_outbox_time ON forensic_outbox(event_time, id);

  CREATE TABLE IF NOT EXISTS audit_events(
    id TEXT PRIMARY KEY,
    position INTEGER NOT NULL DEFAULT 0,
    event_time TEXT,
    event_type TEXT,
    post_id TEXT,
    account_id TEXT,
    payload_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS audit_events_time ON audit_events(event_time, id);

  CREATE TABLE IF NOT EXISTS operational_state(
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS telegram_state(
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS telegram_updates(
    update_id BIGINT PRIMARY KEY,
    received_at TEXT NOT NULL,
    processed_at TEXT,
    action TEXT,
    status TEXT NOT NULL,
    payload_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS telegram_updates_status_time ON telegram_updates(status, received_at);

  CREATE TABLE IF NOT EXISTS telegram_users(
    user_key TEXT PRIMARY KEY,
    chat_id TEXT,
    user_id TEXT,
    payload_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS telegram_panels(
    chat_id TEXT PRIMARY KEY,
    message_id BIGINT,
    signature TEXT,
    payload_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Independent interface ownership. Existing chat-only rows remain a
  -- dashboard fallback until an explicit typed adoption supersedes them.
  CREATE TABLE IF NOT EXISTS telegram_interface_panels(
    chat_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('dashboard', 'accounts')),
    message_id BIGINT NOT NULL,
    generation TEXT,
    payload_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(chat_id, kind)
  );

  CREATE TABLE IF NOT EXISTS telegram_navigation_receipts(
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    action TEXT NOT NULL,
    received BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS admin_events(
    id TEXT PRIMARY KEY,
    event_time TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS file_import_jobs(
    seq BIGSERIAL,
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    doc TEXT NOT NULL,
    chat TEXT NOT NULL,
    "user" TEXT NOT NULL,
    file TEXT,
    digest TEXT,
    checkpoint INTEGER NOT NULL DEFAULT 0,
    fields TEXT,
    received INTEGER NOT NULL DEFAULT 0,
    added INTEGER NOT NULL DEFAULT 0,
    duplicates INTEGER NOT NULL DEFAULT 0,
    rejected INTEGER NOT NULL DEFAULT 0,
    reasons TEXT NOT NULL DEFAULT '{}',
    username TEXT,
    userid TEXT,
    cookiefile TEXT,
    credential TEXT,
    notified INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    target_id TEXT,
    previous_cookie TEXT,
    batch TEXT,
    content_hash TEXT,
    identity_proof TEXT,
    staging_owned INTEGER NOT NULL DEFAULT 0,
    UNIQUE(owner, kind, digest)
  );

  CREATE TABLE IF NOT EXISTS account_import_batches(
    seq BIGSERIAL,
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    chat TEXT NOT NULL,
    "user" TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    revision INTEGER NOT NULL DEFAULT 0,
    touched BIGINT NOT NULL,
    prompt_id BIGINT,
    prompt_revision INTEGER NOT NULL DEFAULT -1,
    prompt_token TEXT,
    prompt_state TEXT NOT NULL DEFAULT 'pending',
    displayed TEXT NOT NULL DEFAULT '[]',
    result TEXT,
    result_state TEXT NOT NULL DEFAULT 'pending',
    result_id BIGINT,
    retired INTEGER NOT NULL DEFAULT 0,
    prompt_attempts INTEGER NOT NULL DEFAULT 0,
    collecting INTEGER NOT NULL DEFAULT 0,
    prompt_signature TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS account_import_collecting_owner
    ON account_import_batches(owner) WHERE status='open' AND collecting=1;

  CREATE TABLE IF NOT EXISTS account_import_groups(
    seq BIGSERIAL,
    token TEXT NOT NULL,
    job TEXT NOT NULL,
    PRIMARY KEY(token, job)
  );

  CREATE TABLE IF NOT EXISTS text_upload_inbox(
    seq BIGSERIAL,
    id TEXT PRIMARY KEY,
    owner TEXT,
    chat TEXT,
    "user" TEXT,
    doc TEXT,
    status TEXT NOT NULL DEFAULT 'receiving',
    batch TEXT,
    attempts INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS import_seen(
    h TEXT PRIMARY KEY,
    t TEXT
  );

  CREATE TABLE IF NOT EXISTS import_protected(
    t TEXT PRIMARY KEY
  );

  CREATE TABLE IF NOT EXISTS protected_state_checks(
    seq BIGSERIAL,
    id TEXT PRIMARY KEY,
    captured_at TEXT NOT NULL,
    before_json TEXT NOT NULL,
    after_json TEXT,
    changed_json TEXT
  );

  CREATE TABLE IF NOT EXISTS metrics(
    id BIGSERIAL PRIMARY KEY,
    observed_at TEXT NOT NULL,
    kind TEXT NOT NULL,
    value DOUBLE PRECISION,
    payload_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS metrics_kind_time ON metrics(kind, observed_at);

  CREATE TABLE IF NOT EXISTS diagnostics(
    id TEXT PRIMARY KEY,
    observed_at TEXT NOT NULL,
    level TEXT,
    component TEXT,
    event TEXT,
    payload_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS diagnostics_time ON diagnostics(observed_at, id);

  -- Latest committed change per post, including tombstones. The clock is a
  -- transactional row (not a sequence): revisions cannot commit out of order.
  CREATE TABLE IF NOT EXISTS post_cache_clock(
    id INTEGER PRIMARY KEY CHECK(id = 1),
    revision BIGINT NOT NULL DEFAULT 0,
    reset_revision BIGINT NOT NULL DEFAULT 0
  );
  INSERT INTO post_cache_clock(id) VALUES(1) ON CONFLICT(id) DO NOTHING;
  CREATE TABLE IF NOT EXISTS post_cache_changes(
    post_id TEXT PRIMARY KEY,
    revision BIGINT NOT NULL,
    deleted BOOLEAN NOT NULL DEFAULT FALSE
  );
  CREATE INDEX IF NOT EXISTS post_cache_changes_revision ON post_cache_changes(revision);

  CREATE OR REPLACE FUNCTION record_post_cache_change() RETURNS trigger
  LANGUAGE plpgsql SET search_path FROM CURRENT AS $cache$
  DECLARE
    next_revision BIGINT;
    tx_id TEXT := pg_catalog.pg_current_xact_id()::text;
  BEGIN
    -- Coalesce post_cache_clock updates to once per transaction (still serialized
    -- by the row lock on id=1 at COMMIT) so bulk SQL/save mutations do not build
    -- O(N^2) uncommitted dead-tuple chains on the 1-row clock table.
    IF pg_catalog.current_setting('yj.post_cache_tx', true) IS DISTINCT FROM tx_id THEN
      UPDATE post_cache_clock SET revision = revision + 1 WHERE id = 1
        RETURNING revision INTO next_revision;
      PERFORM pg_catalog.set_config('yj.post_cache_tx', tx_id, true);
      PERFORM pg_catalog.set_config('yj.post_cache_rev', next_revision::text, true);
    ELSE
      next_revision := pg_catalog.current_setting('yj.post_cache_rev', true)::bigint;
    END IF;
    IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND OLD.id <> NEW.id) THEN
      INSERT INTO post_cache_changes(post_id, revision, deleted)
        VALUES(OLD.id, next_revision, TRUE)
        ON CONFLICT(post_id) DO UPDATE SET revision = EXCLUDED.revision, deleted = EXCLUDED.deleted;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      INSERT INTO post_cache_changes(post_id, revision, deleted)
        VALUES(NEW.id, next_revision, FALSE)
        ON CONFLICT(post_id) DO UPDATE SET revision = EXCLUDED.revision, deleted = EXCLUDED.deleted;
    END IF;
    RETURN NULL;
  END $cache$;

  CREATE OR REPLACE FUNCTION reset_post_cache() RETURNS trigger
  LANGUAGE plpgsql SET search_path FROM CURRENT AS $cache$
  BEGIN
    UPDATE post_cache_clock SET revision = revision + 1, reset_revision = revision + 1 WHERE id = 1;
    DELETE FROM post_cache_changes;
    PERFORM pg_catalog.set_config('yj.post_cache_tx', '', true);
    RETURN NULL;
  END $cache$;

  DO $cache$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'posts'::regclass AND tgname = 'post_cache_change') THEN
      -- Deferral avoids holding the shared clock lock throughout account/quota
      -- admission and independent SKIP LOCKED work. Only commit is ordered.
      CREATE CONSTRAINT TRIGGER post_cache_change AFTER INSERT OR UPDATE OR DELETE ON posts
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION record_post_cache_change();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'posts'::regclass AND tgname = 'post_cache_reset') THEN
      CREATE TRIGGER post_cache_reset AFTER TRUNCATE ON posts
        FOR EACH STATEMENT EXECUTE FUNCTION reset_post_cache();
    END IF;
  END $cache$;
`;

async function ensurePgSchema(poolOrClient, { allowProductionMigration = false } = {}) {
  if (poolOrClient?._yjConfig) {
    assertPgMutationAllowed({ ...poolOrClient._yjConfig, allowProductionMigration }, { migration: false });
  } else {
    assertPgMutationAllowed({
      database: poolOrClient?.options?.database || poolOrClient?.database || process.env.PGDATABASE || 'yj_autopost',
      schema: process.env.PGSCHEMA || 'public',
      allowProductionMigration
    }, { migration: false });
  }
  return await withClient(poolOrClient, async client => {
    const schema = client._yjConfig?.schema || poolOrClient?._yjConfig?.schema || 'public';
    const lockKey = `yj_autopost_ensure_schema:${schema}`;
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
    try {
      if (schema && schema !== 'public') {
        const safeSchema = validIdentifier(schema, 'schema');
        await client.query(`CREATE SCHEMA IF NOT EXISTS "${safeSchema}"`);
        await client.query(`SET search_path TO "${safeSchema}", public`);
        client._searchPathSet = true;
      }
      try {
        await client.query(PG_SCHEMA_DDL);
      } catch (err) {
        if (String(err?.message || '').includes('SESSION_SCHEMA_DRAIN_REQUIRED')) {
          err.code = 'SESSION_SCHEMA_DRAIN_REQUIRED';
        }
        throw err;
      }
      await upsertMeta(client, 'schema', SCHEMA_VERSION);
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => {});
    }
  });
}

async function upsertMeta(client, key, value) {
  await client.query(
    'INSERT INTO meta(key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value',
    [String(key), String(value)]
  );
}

async function upsertOperationalState(client, key, value) {
  await client.query(
    'INSERT INTO operational_state(key, value_json) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value_json = EXCLUDED.value_json',
    [String(key), json(value)]
  );
}

async function operationalValue(client, key, fallback = {}) {
  const res = await client.query('SELECT value_json FROM operational_state WHERE key = $1', [String(key)]);
  if (!res.rows.length) return fallback;
  return parse(res.rows[0].value_json, fallback);
}

async function batchInsert(client, table, columns, rows, { batchSize = 1000, onConflict = '' } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const colList = columns.map(c => (c === 'user' ? '"user"' : c)).join(', ');
  const colCount = columns.length;
  let inserted = 0;

  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const chunk = rows.slice(offset, offset + batchSize);
    const values = [];
    const placeholders = [];
    let paramIndex = 1;
    for (const row of chunk) {
      const rowPlaceholders = [];
      for (let c = 0; c < colCount; c++) {
        rowPlaceholders.push(`$${paramIndex++}`);
        values.push(row[c] === undefined ? null : row[c]);
      }
      placeholders.push(`(${rowPlaceholders.join(', ')})`);
    }
    const sql = `INSERT INTO ${table} (${colList}) VALUES ${placeholders.join(', ')}${onConflict ? ' ' + onConflict : ''}`;
    const res = await client.query(sql, values);
    inserted += res.rowCount || 0;
  }
  return inserted;
}

async function migrateStateObjectToPg(
  state,
  revision,
  sourceDigest,
  poolOrClient,
  auxiliary = {},
  { truncateFirst = false, allowProductionMigration = false } = {}
) {
  if (poolOrClient?._yjConfig) {
    assertPgMutationAllowed({ ...poolOrClient._yjConfig, allowProductionMigration }, { migration: true });
  } else {
    assertPgMutationAllowed({
      database: process.env.PGDATABASE || 'yj_autopost',
      schema: process.env.PGSCHEMA || 'public',
      allowProductionMigration
    }, { migration: true });
  }
  const auxiliaryRows = auxiliary || {};
  const nowIso = new Date().toISOString();

  await ensurePgSchema(poolOrClient, { allowProductionMigration });

  const migrationSummary = await withTransaction(poolOrClient, async client => {
    if (!truncateFirst) {
      const occupied = await client.query(`SELECT EXISTS (
        SELECT 1 FROM posts LIMIT 1
      ) AS nonempty`);
      if (occupied.rows[0]?.nonempty) {
        throw Object.assign(new Error('PG_MIGRATION_TARGET_NOT_EMPTY'), { code: 'PG_MIGRATION_TARGET_NOT_EMPTY' });
      }
    }
    if (truncateFirst) {
      await client.query(`
        TRUNCATE TABLE
          reservations,
          post_attempts,
          publish_results,
          attempt_outcomes,
          session_leases,
          posts,
          accounts,
          quota,
          schedules,
          cycle_state,
          settings,
          vpn_slots,
          burned_subnets,
          account_checks,
          idempotency_fences,
          ambiguous_fences,
          outbox,
          link_deliveries,
          link_terminal_events,
          manual_links,
          forensic_outbox,
          audit_events,
          operational_state,
          telegram_state,
          telegram_updates,
          telegram_users,
          telegram_panels,
          telegram_interface_panels,
          telegram_navigation_receipts,
          admin_events,
          file_import_jobs,
          account_import_batches,
          account_import_groups,
          text_upload_inbox,
          import_seen,
          import_protected,
          protected_state_checks,
          metrics,
          diagnostics,
          meta
        RESTART IDENTITY CASCADE
      `);
    }

    const encodedState = json(state);
    await upsertMeta(client, 'schema', SCHEMA_VERSION);
    await upsertMeta(client, 'source_revision', revision);
    await upsertMeta(client, 'source_digest', sourceDigest);
    await upsertMeta(client, 'source_bytes', Buffer.byteLength(encodedState));
    await upsertMeta(client, 'authority', 'postgresql_primary');
    await upsertMeta(client, 'activation', 'active');
    await upsertMeta(client, 'created_at', nowIso);
    await upsertMeta(client, 'ambiguous_fence_count', (state.ambiguousFences || []).length);
    await upsertMeta(client, 'ambiguous_fence_digest', sha256(json((state.ambiguousFences || []).map(textKey))));
    await upsertMeta(client, 'ambiguous_fence_original_digest', sha256(json(state.ambiguousFences || [])));
    await upsertMeta(
      client,
      'legacy_projection_digest',
      sha256(
        json({
          posting: state.posting || {},
          vpnSlots: state.vpnSlots || {},
          linkDeliveries: state.linkDeliveries || [],
          linkTerminalEvents: state.linkTerminalEvents || [],
          manualLinks: state.manualLinks || [],
          pendingForensicOutbox: state.pendingForensicOutbox || []
        })
      )
    );

    // 1. Batch-insert posts (1000 rows per batch)
    const postRows = (state.items || []).map((item, position) => [
      String(item.id),
      position,
      item.contentHash || null,
      typeof item.payload?.text === 'string' ? item.payload.text : null,
      textKey(item.payload?.text),
      json(item.payload || {}),
      item.state || 'unknown',
      item.createdAt || null,
      item.reason || null,
      item.publishedAt || null,
      item.url || null,
      item.tweetId == null ? null : String(item.tweetId),
      item.accountId || null,
      item.accountUsername || null,
      item.claimedAt || null,
      Number.isSafeInteger(item.preDispatchRetries) ? item.preDispatchRetries : 0,
      claimable(item),
      item.attempt ? json(item.attempt) : null,
      item.archivedAttempt ? json(item.archivedAttempt) : null,
      Array.isArray(item.archivedAttempts) ? json(item.archivedAttempts) : null,
      item.outcome ? json(item.outcome) : null,
      item.result ? json(item.result) : null,
      Array.isArray(item.recoveryHistory) ? json(item.recoveryHistory) : null,
      item.failureDiagnostic ? json(item.failureDiagnostic) : null,
      item.ownerAssistedPackage ? json(item.ownerAssistedPackage) : null,
      json(item)
    ]);

    await batchInsert(
      client,
      'posts',
      [
        'id', 'position', 'content_hash', 'text', 'text_key', 'payload_json', 'state', 'created_at',
        'reason', 'published_at', 'url', 'tweet_id', 'account_id', 'account_username', 'claimed_at',
        'pre_dispatch_retries', 'claimable', 'attempt_json', 'archived_attempt_json', 'archived_attempts_json',
        'outcome_json', 'result_json', 'recovery_history_json', 'failure_diagnostic_json',
        'owner_assisted_package_json', 'source_json'
      ],
      postRows,
      { batchSize: 1000 }
    );

    // Populate publish_results for terminal posts
    const publishResultRows = (state.items || [])
      .filter(item => ['published', 'failed', 'ambiguous'].includes(item.state))
      .map(item => [
        String(item.id),
        item.attempt?.token || item.archivedAttempt?.token || null,
        item.accountId || null,
        item.accountUsername || null,
        item.state,
        item.publishedAt || null,
        item.publishedAt || item.createdAt || nowIso,
        item.url || null,
        item.tweetId == null ? null : String(item.tweetId),
        item.reason || null,
        item.result ? json(item.result) : null,
        item.failureDiagnostic ? json(item.failureDiagnostic) : null,
        json(item)
      ]);
    await batchInsert(
      client,
      'publish_results',
      [
        'post_id', 'token', 'account_id', 'account_username', 'outcome', 'published_at',
        'completed_at', 'url', 'tweet_id', 'reason', 'result_json', 'failure_diagnostic_json', 'source_json'
      ],
      publishResultRows,
      { batchSize: 1000, onConflict: 'ON CONFLICT(post_id) DO NOTHING' }
    );

    // 2. Accounts
    const accountRows = (state.accounts || []).map((item, position) => [
      String(item.id),
      position,
      item.label || null,
      item.username || null,
      item.userId || null,
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
    ]);
    await batchInsert(
      client,
      'accounts',
      [
        'id', 'position', 'label', 'username', 'user_id', 'enabled', 'cookie_file', 'verified_at',
        'vpn_resource', 'quota_json', 'delay_ms', 'exit_ip', 'status', 'check_generation', 'failures', 'source_json'
      ],
      accountRows,
      { batchSize: 500 }
    );

    // 3. Quota
    const quotaRows = [];
    for (const [day, accounts] of Object.entries(state.posting?.quota || {})) {
      for (const [accountId, used] of Object.entries(accounts || {})) {
        const numericUsed = Number.isFinite(used) ? used : 0;
        quotaRows.push([String(day), String(accountId), numericUsed, json({ day, accountId, used })]);
      }
    }
    await batchInsert(client, 'quota', ['day', 'account_id', 'used', 'source_json'], quotaRows, { batchSize: 500 });

    // 4. Schedules
    if (state.settings?.schedule && typeof state.settings.schedule === 'object') {
      const s = state.settings.schedule;
      await client.query(
        `INSERT INTO schedules(id, enabled, hour, minute, timezone, last_triggered_day, updated_at, source_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT(id) DO UPDATE SET
           enabled = EXCLUDED.enabled,
           hour = EXCLUDED.hour,
           minute = EXCLUDED.minute,
           timezone = EXCLUDED.timezone,
           last_triggered_day = EXCLUDED.last_triggered_day,
           updated_at = EXCLUDED.updated_at,
           source_json = EXCLUDED.source_json`,
        [
          'daily',
          s.enabled ? 1 : 0,
          Number.isInteger(s.hour) ? s.hour : 0,
          Number.isInteger(s.minute) ? s.minute : 0,
          s.timezone || 'Asia/Riyadh',
          s.lastTriggeredDay || null,
          s.updatedAt || null,
          json(s)
        ]
      );
    }

    // 5. Cycle state
    const cycle = state.cycle || { state: 'stopped', runId: null };
    await client.query(
      `INSERT INTO cycle_state(id, state, run_id, started_at, updated_at, reason, source_json)
       VALUES (1, $1, $2, $3, $4, $5, $6)
       ON CONFLICT(id) DO UPDATE SET
         state = EXCLUDED.state,
         run_id = EXCLUDED.run_id,
         started_at = EXCLUDED.started_at,
         updated_at = EXCLUDED.updated_at,
         reason = EXCLUDED.reason,
         source_json = EXCLUDED.source_json`,
      [
        cycle.state || 'stopped',
        cycle.runId || null,
        cycle.startedAt || null,
        cycle.updatedAt || null,
        cycle.reason || null,
        json(cycle)
      ]
    );

    // 6. Settings
    const settingRows = Object.entries(state.settings || {}).map(([key, value]) => [String(key), json(value)]);
    await batchInsert(client, 'settings', ['key', 'value_json'], settingRows, { batchSize: 200 });

    // 7. VPN slots, burned subnets, account checks, attempt outcomes
    const vpnRows = Object.entries(state.vpnSlots || {}).map(([accountId, slotIndex]) => {
      const exitIp = state.slotIps?.[slotIndex] || state.slotIps?.[String(slotIndex)] || null;
      return [
        String(accountId),
        Number(slotIndex),
        exitIp,
        nowIso,
        json({ accountId, slotIndex: Number(slotIndex), exitIp })
      ];
    });
    await batchInsert(
      client,
      'vpn_slots',
      ['account_id', 'slot_index', 'exit_ip', 'updated_at', 'source_json'],
      vpnRows,
      { batchSize: 200, onConflict: 'ON CONFLICT(account_id) DO UPDATE SET slot_index = EXCLUDED.slot_index, exit_ip = EXCLUDED.exit_ip, source_json = EXCLUDED.source_json' }
    );

    const subnetRows = (state.burnedSubnets || []).map((subnet, position) => [
      String(subnet),
      position,
      nowIso,
      json({ subnet: String(subnet), position })
    ]);
    await batchInsert(
      client,
      'burned_subnets',
      ['subnet', 'position', 'created_at', 'source_json'],
      subnetRows,
      { batchSize: 200, onConflict: 'ON CONFLICT(subnet) DO NOTHING' }
    );

    const checkRows = Object.entries(state.telegramUi?.accountChecks || {}).map(([accountId, checkObj]) => [
      String(accountId),
      checkObj?.vpn ? json(checkObj.vpn) : null,
      checkObj?.session ? json(checkObj.session) : null,
      checkObj?.lastError || null,
      checkObj?.session?.checkedAt || checkObj?.vpn?.checkedAt || nowIso,
      json(checkObj || {})
    ]);
    await batchInsert(
      client,
      'account_checks',
      ['account_id', 'vpn_json', 'session_json', 'last_error', 'updated_at', 'source_json'],
      checkRows,
      { batchSize: 200 }
    );

    const outcomeRows = [];
    for (const [day, accountsObj] of Object.entries(state.posting?.attemptOutcomes || {})) {
      for (const [accountId, outcomeObj] of Object.entries(accountsObj || {})) {
        outcomeRows.push([
          String(day),
          String(accountId),
          Number(outcomeObj?.failed || 0),
          Number(outcomeObj?.ambiguous || 0),
          Number(outcomeObj?.published || 0),
          nowIso,
          json(outcomeObj || {})
        ]);
      }
    }
    await batchInsert(
      client,
      'attempt_outcomes',
      ['day', 'account_id', 'failed', 'ambiguous', 'published', 'updated_at', 'source_json'],
      outcomeRows,
      { batchSize: 500 }
    );

    // 8. Operational state
    for (const key of ['nextPostAt', 'publishingAt', 'cooling', 'attemptOutcomes']) {
      if (Object.hasOwn(state.posting || {}, key)) {
        await upsertOperationalState(client, key, state.posting[key]);
      }
    }
    await upsertOperationalState(client, 'accountChecks', state.telegramUi?.accountChecks || {});
    for (const key of ['vpnSlots', 'burnedSubnets', 'slotIps', 'serverIp', 'uiScheduleDay', 'linkReportState']) {
      if (Object.hasOwn(state, key)) {
        await upsertOperationalState(client, key, state[key]);
      }
    }

    // 9. Ambiguous fences (preserving position and raw value in source_json)
    for (const [position, value] of (state.ambiguousFences || []).entries()) {
      if (typeof value === 'string') {
        const key = textKey(value) || `fence:${position}`;
        await client.query(
          `INSERT INTO ambiguous_fences(content_key, position, created_at, source_json)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT(content_key) DO UPDATE SET
             position = EXCLUDED.position,
             source_json = EXCLUDED.source_json`,
          [key, position, nowIso, json({ value, position })]
        );
      }
    }

    // 10. Outbox (preserving sequence_no 0..N-1)
    const outboxRows = (state.linkOutbox || []).map((row, sequence) => {
      const id = String(row.outboxId || row.id || `link:${row.runId}:${row.day}:${row.chatId}`);
      return [
        id,
        sequence,
        id,
        'link',
        row.status || 'pending',
        json(row),
        Number.isSafeInteger(row.attempts) ? row.attempts : 0,
        row.nextAttemptAt || null,
        row.createdAt || nowIso,
        row.deliveredAt || null,
        json(row)
      ];
    });
    await batchInsert(
      client,
      'outbox',
      [
        'id', 'sequence_no', 'dedupe_key', 'kind', 'status', 'payload_json',
        'attempts', 'next_attempt_at', 'created_at', 'delivered_at', 'source_json'
      ],
      outboxRows,
      { batchSize: 500 }
    );

    // 11. Link deliveries (preserving sequence_no)
    const deliveryRows = (state.linkDeliveries || []).map((row, index) => [
      String(
        row.deliveryId ||
          `legacy:${index}:${row.runId}:${row.chatId || ''}:${row.day || ''}:${row.attemptedAt || row.deliveredAt || ''}`
      ),
      index,
      row.outboxId || null,
      row.runId || null,
      row.day || null,
      row.kind || 'document',
      row.chatId == null ? null : String(row.chatId),
      json(row.itemIds || []),
      row.contentHash || null,
      row.attempted === true ? 1 : 0,
      row.ok === true ? 1 : 0,
      row.messageId == null ? null : Number(row.messageId),
      row.attemptedAt || null,
      row.deliveredAt || null,
      json(row)
    ]);
    await batchInsert(
      client,
      'link_deliveries',
      [
        'delivery_id', 'sequence_no', 'outbox_id', 'run_id', 'day', 'kind', 'chat_id',
        'item_ids_json', 'content_hash', 'attempted', 'ok', 'message_id', 'attempted_at', 'delivered_at', 'source_json'
      ],
      deliveryRows,
      { batchSize: 500 }
    );

    // 12. Link terminal events
    const terminalRows = (state.linkTerminalEvents || []).map((row, sequence) => [
      String(row.eventId || `legacy-terminal:${sequence}:${row.runId || ''}:${row.chatId || ''}`),
      sequence,
      String(row.runId || ''),
      String(row.chatId || ''),
      row.day || null,
      row.reconciled === true ? 1 : 0,
      row.suppressed === true ? 1 : 0,
      row.reason || null,
      row.contentHash || null,
      json(row)
    ]);
    await batchInsert(
      client,
      'link_terminal_events',
      ['event_id', 'sequence_no', 'run_id', 'chat_id', 'day', 'reconciled', 'suppressed', 'reason', 'content_hash', 'source_json'],
      terminalRows,
      { batchSize: 500 }
    );

    // 13. Manual links
    const manualRows = (state.manualLinks || []).map((row, position) => [
      String(row.id),
      position,
      String(row.url),
      row.state || null,
      row.publishedAt || null,
      row.source || null,
      json(row)
    ]);
    await batchInsert(
      client,
      'manual_links',
      ['id', 'position', 'url', 'state', 'published_at', 'source', 'source_json'],
      manualRows,
      { batchSize: 500 }
    );

    // 14. Forensic outbox
    const forensicOutboxRows = (state.pendingForensicOutbox || []).map((row, position) => [
      String(row.id),
      position,
      row.timestamp || null,
      row.eventType || null,
      json(row),
      json(row)
    ]);
    await batchInsert(
      client,
      'forensic_outbox',
      ['id', 'position', 'event_time', 'event_type', 'payload_json', 'source_json'],
      forensicOutboxRows,
      { batchSize: 500 }
    );

    // 15. Audit events & diagnostics
    const auditRows = (state.forensicLogs || []).map((row, position) => [
      String(row.id),
      position,
      row.timestamp || null,
      row.eventType || null,
      row.itemId || row.queueItemId || null,
      row.accountId || null,
      json(row)
    ]);
    await batchInsert(
      client,
      'audit_events',
      ['id', 'position', 'event_time', 'event_type', 'post_id', 'account_id', 'payload_json'],
      auditRows,
      { batchSize: 500 }
    );

    const diagnosticRows = (state.forensicLogs || []).map(row => [
      String(row.id),
      row.timestamp || nowIso,
      row.level || null,
      row.component || null,
      row.eventType || null,
      json(row)
    ]);
    await batchInsert(
      client,
      'diagnostics',
      ['id', 'observed_at', 'level', 'component', 'event', 'payload_json'],
      diagnosticRows,
      { batchSize: 500 }
    );

    // 16. Telegram state, updates, users, panels
    if (state.telegram && typeof state.telegram === 'object') {
      for (const [key, value] of Object.entries(state.telegram)) {
        await upsertMeta(client, `telegram.${key}`, json(value));
        await client.query(
          'INSERT INTO telegram_state(key, value_json) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value_json = EXCLUDED.value_json',
          [String(key), json(value)]
        );
      }
      if (Array.isArray(state.telegram.processedUpdates)) {
        const updateRows = state.telegram.processedUpdates
          .filter(u => Number.isSafeInteger(Number(u)))
          .map(u => [Number(u), nowIso, nowIso, 'migrated', 'processed', json({ updateId: Number(u) })]);
        await batchInsert(
          client,
          'telegram_updates',
          ['update_id', 'received_at', 'processed_at', 'action', 'status', 'payload_json'],
          updateRows,
          { batchSize: 500, onConflict: 'ON CONFLICT(update_id) DO NOTHING' }
        );
      }
    }

    const ui = structuredClone(state.telegramUi || {});
    await importUiOwners(client, ui);
    await client.query(
      'INSERT INTO telegram_state(key, value_json) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value_json = EXCLUDED.value_json',
      ['telegramUi', json(ui)]
    );

    const userRows = Object.entries(ui.users || {}).map(([key, value]) => [
      String(key),
      value?.chatId == null ? null : String(value.chatId),
      value?.userId == null ? null : String(value.userId),
      json(value || {}),
      value?.updatedAt ? new Date(value.updatedAt).toISOString() : nowIso
    ]);
    await batchInsert(
      client,
      'telegram_users',
      ['user_key', 'chat_id', 'user_id', 'payload_json', 'updated_at'],
      userRows,
      { batchSize: 500, onConflict: 'ON CONFLICT(user_key) DO NOTHING' }
    );

    const panelRows = Object.entries(ui.activePanelsByChatId || ui.dashboards || {}).map(([chatId, value]) => [
      String(chatId),
      value?.messageId == null ? null : Number(value.messageId),
      value?.signature || null,
      json(value || {}),
      value?.updatedAt ? new Date(value.updatedAt).toISOString() : nowIso
    ]);
    await batchInsert(
      client,
      'telegram_panels',
      ['chat_id', 'message_id', 'signature', 'payload_json', 'updated_at'],
      panelRows,
      { batchSize: 500, onConflict: 'ON CONFLICT(chat_id) DO NOTHING' }
    );

    // 17. All 8 auxiliary tables (preserving raw secrets credential & previous_cookie)
    const navReceiptRows = [
      ...(state.telegramNavigationReceipts || []),
      ...(auxiliaryRows.telegram_navigation_receipts || [])
    ].map(row => [
      String(row.id),
      String(row.owner || ''),
      String(row.action || ''),
      Number(row.received || 0)
    ]);
    await batchInsert(
      client,
      'telegram_navigation_receipts',
      ['id', 'owner', 'action', 'received'],
      navReceiptRows,
      { batchSize: 1000, onConflict: 'ON CONFLICT(id) DO NOTHING' }
    );

    const importJobRows = (auxiliaryRows.file_import_jobs || []).map(row => [
      row.id,
      row.owner,
      row.kind,
      row.status,
      row.doc,
      row.chat,
      row.user,
      row.file,
      row.digest,
      row.checkpoint ?? 0,
      row.fields,
      row.received ?? 0,
      row.added ?? 0,
      row.duplicates ?? 0,
      row.rejected ?? 0,
      row.reasons ?? '{}',
      row.username,
      row.userid,
      row.cookiefile,
      row.credential,
      row.notified ?? 0,
      row.error,
      row.target_id,
      row.previous_cookie,
      row.batch,
      row.content_hash,
      row.identity_proof,
      row.staging_owned ?? 0
    ]);
    await batchInsert(
      client,
      'file_import_jobs',
      [
        'id', 'owner', 'kind', 'status', 'doc', 'chat', 'user', 'file', 'digest', 'checkpoint',
        'fields', 'received', 'added', 'duplicates', 'rejected', 'reasons', 'username', 'userid',
        'cookiefile', 'credential', 'notified', 'error', 'target_id', 'previous_cookie', 'batch',
        'content_hash', 'identity_proof', 'staging_owned'
      ],
      importJobRows,
      { batchSize: 500 }
    );

    const importBatchRows = (auxiliaryRows.account_import_batches || []).map(row => [
      row.id,
      row.owner,
      row.chat,
      row.user,
      row.status ?? 'open',
      row.revision ?? 0,
      row.touched,
      row.prompt_id,
      row.prompt_revision ?? -1,
      row.prompt_token,
      row.prompt_state ?? 'pending',
      row.displayed ?? '[]',
      row.result,
      row.result_state ?? 'pending',
      row.result_id,
      row.retired ?? 0,
      row.prompt_attempts ?? 0,
      row.collecting ?? 0,
      row.prompt_signature
    ]);
    await batchInsert(
      client,
      'account_import_batches',
      [
        'id', 'owner', 'chat', 'user', 'status', 'revision', 'touched', 'prompt_id',
        'prompt_revision', 'prompt_token', 'prompt_state', 'displayed', 'result',
        'result_state', 'result_id', 'retired', 'prompt_attempts', 'collecting', 'prompt_signature'
      ],
      importBatchRows,
      { batchSize: 500 }
    );

    const importGroupRows = (auxiliaryRows.account_import_groups || []).map(row => [
      row.token,
      row.job
    ]);
    await batchInsert(
      client,
      'account_import_groups',
      ['token', 'job'],
      importGroupRows,
      { batchSize: 500, onConflict: 'ON CONFLICT(token, job) DO NOTHING' }
    );

    const uploadInboxRows = (auxiliaryRows.text_upload_inbox || []).map(row => [
      row.id,
      row.owner,
      row.chat,
      row.user,
      row.doc,
      row.status ?? 'receiving',
      row.batch,
      row.attempts ?? 0
    ]);
    await batchInsert(
      client,
      'text_upload_inbox',
      ['id', 'owner', 'chat', 'user', 'doc', 'status', 'batch', 'attempts'],
      uploadInboxRows,
      { batchSize: 500 }
    );

    const importSeenRows = (auxiliaryRows.import_seen || []).map(row => [row.h, row.t]);
    await batchInsert(
      client,
      'import_seen',
      ['h', 't'],
      importSeenRows,
      { batchSize: 2000, onConflict: 'ON CONFLICT(h) DO NOTHING' }
    );

    const importProtectedRows = (auxiliaryRows.import_protected || []).map(row => [row.t]);
    await batchInsert(
      client,
      'import_protected',
      ['t'],
      importProtectedRows,
      { batchSize: 1000, onConflict: 'ON CONFLICT(t) DO NOTHING' }
    );

    const protectedChecksRows = (auxiliaryRows.protected_state_checks || []).map(row => [
      row.id,
      row.captured_at,
      row.before_json,
      row.after_json,
      row.changed_json
    ]);
    await batchInsert(
      client,
      'protected_state_checks',
      ['id', 'captured_at', 'before_json', 'after_json', 'changed_json'],
      protectedChecksRows,
      { batchSize: 200 }
    );

    return {
      sourceRevision: revision,
      sourceDigest,
      postsCount: postRows.length,
      accountsCount: accountRows.length,
      fencesCount: (state.ambiguousFences || []).length,
      outboxCount: outboxRows.length
    };
  }, { exclusive: true });

  if (migrationSummary.postsCount >= 500 && !poolOrClient?._inYjTx) {
    try {
      await withClient(poolOrClient, async client => {
        await client.query('VACUUM ANALYZE posts, accounts, quota, reservations');
        await client.query('SELECT state, claimable, COUNT(*)::int AS count FROM posts GROUP BY state, claimable');
      });
    } catch {}
  }

  return migrationSummary;
}

// Explicit initial/offline import only. Unlike compatibility state saves this
// may seed ownership, but never replace an existing canonical tuple.
async function importUiOwners(client, ui) {
  const registry = structuredClone(ui.interfacePanelsByChatId || {});
  for (const [chat, owner] of Object.entries(ui.activePanelsByChatId || ui.dashboards || {})) {
    if (owner?.kind === 'accounts') continue;
    registry[chat] ||= {};
    registry[chat].dashboard ||= owner;
  }
  for (const [chat, families] of Object.entries(registry)) {
    for (const kind of ['dashboard', 'accounts']) {
      const owner = families?.[kind];
      if (!Number.isSafeInteger(owner?.messageId) || owner.messageId <= 0) continue;
      await client.query(`INSERT INTO telegram_interface_panels(chat_id, kind, message_id, generation, payload_json, updated_at)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(chat_id,kind) DO NOTHING`,
      [chat, kind, owner.messageId, owner.generation ?? null, json(owner), new Date().toISOString()]);
    }
  }
  const rows = (await client.query('SELECT chat_id, kind, payload_json FROM telegram_interface_panels')).rows;
  ui.interfacePanelsByChatId = {};
  ui.dashboards = {};
  ui.activePanelsByChatId = {};
  for (const row of rows) {
    const owner = parse(row.payload_json, {});
    ui.interfacePanelsByChatId[row.chat_id] ||= {};
    ui.interfacePanelsByChatId[row.chat_id][row.kind] = owner;
    if (row.kind === 'dashboard') {
      ui.dashboards[row.chat_id] = owner;
      ui.activePanelsByChatId[row.chat_id] = owner;
    }
  }
  for (const user of Object.values(ui.users || {})) {
    delete user.panel;
    if (ui.dashboards[String(user.chatId)]) user.panel = structuredClone(ui.dashboards[String(user.chatId)]);
  }
}

async function readSettings(client) {
  const res = await client.query('SELECT key, value_json FROM settings');
  return Object.fromEntries(res.rows.map(row => [row.key, parse(row.value_json)]));
}

async function readAccountChecks(client) {
  const opChecks = await operationalValue(client, 'accountChecks', null);
  const res = await client.query(
    'SELECT account_id, vpn_json, session_json, last_error, source_json FROM account_checks'
  );
  if (!res.rows.length) {
    return opChecks && typeof opChecks === 'object' ? opChecks : {};
  }
  const tableChecks = {};
  for (const row of res.rows) {
    const base = parse(row.source_json, {}) || {};
    if (row.vpn_json != null) base.vpn = parse(row.vpn_json, base.vpn);
    if (row.session_json != null) base.session = parse(row.session_json, base.session);
    if (row.last_error !== undefined && row.last_error !== null) base.lastError = row.last_error;
    tableChecks[row.account_id] = base;
  }
  return { ...(opChecks && typeof opChecks === 'object' ? opChecks : {}), ...tableChecks };
}

async function readVpnSlots(client) {
  const opSlots = await operationalValue(client, 'vpnSlots', null);
  const res = await client.query('SELECT account_id, slot_index FROM vpn_slots');
  if (!res.rows.length) {
    return opSlots && typeof opSlots === 'object' ? opSlots : {};
  }
  const tableSlots = Object.fromEntries(res.rows.map(r => [r.account_id, Number(r.slot_index)]));
  return { ...(opSlots && typeof opSlots === 'object' ? opSlots : {}), ...tableSlots };
}

async function getPostsBatch(
  poolOrClient,
  { state = 'pending', limit = 50, afterPosition = -1, claimableOnly = false, accountId = null } = {}
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new RangeError('BATCH_LIMIT_MUST_BE_1_TO_50');
  }
  return await withClient(poolOrClient, async client => {
    const params = [state, afterPosition];
    const where = ['state = $1', 'position > $2'];
    if (claimableOnly) {
      where.push('claimable = 1');
    }
    if (accountId != null) {
      params.push(String(accountId));
      where.push(`account_id = $${params.length}`);
    }
    params.push(limit);
    const sql = `
      SELECT id, position, content_hash, text, text_key, payload_json, state, created_at,
             reason, published_at, url, tweet_id, account_id, account_username,
             claimed_at, pre_dispatch_retries, claimable, attempt_json, result_json
      FROM posts
      WHERE ${where.join(' AND ')}
      ORDER BY position ASC, id ASC
      LIMIT $${params.length}
    `;
    const res = await client.query(sql, params);
    return res.rows.map(row => ({
      ...row,
      position: Number(row.position),
      pre_dispatch_retries: Number(row.pre_dispatch_retries),
      claimable: Number(row.claimable),
      payload: parse(row.payload_json, {}),
      attempt: parse(row.attempt_json),
      result: parse(row.result_json)
    }));
  });
}

async function getDashboardSnapshot(
  poolOrClient,
  { day = null, now = new Date().toISOString(), statementTimeoutMs = null, onBackendPid = null } = {}
) {
  return await withTransaction(
    poolOrClient,
    async client => {
      if ((Number.isFinite(statementTimeoutMs) && statementTimeoutMs > 0) || typeof onBackendPid === 'function') {
        const useTimeout = Number.isFinite(statementTimeoutMs) && statementTimeoutMs > 0;
        const pidRes = await client.query(
          useTimeout
            ? "SELECT set_config('statement_timeout', $1, true), pg_backend_pid() AS pid"
            : 'SELECT pg_backend_pid() AS pid',
          useTimeout ? [String(Math.max(1, Math.trunc(statementTimeoutMs)))] : []
        );
        const pid = Number(pidRes?.rows?.[0]?.pid);
        if (typeof onBackendPid === 'function' && Number.isInteger(pid) && pid > 0) {
          onBackendPid(pid);
        }
      }
      const cycleRes = await client.query(
        'SELECT state, run_id, started_at, updated_at, reason FROM cycle_state WHERE id = 1'
      );
      const cycle = cycleRes.rows[0] || { state: 'stopped', run_id: null };

      const countsRes = await client.query(
        'SELECT state, claimable, COUNT(*)::int AS count FROM posts GROUP BY state, claimable'
      );
      const counts = {};
      let total = 0;
      let claimablePending = 0;
      for (const row of countsRes.rows) {
        const cnt = Number(row.count || 0);
        counts[row.state] = (counts[row.state] || 0) + cnt;
        total += cnt;
        if (row.state === 'pending' && Number(row.claimable) === 1) {
          claimablePending += cnt;
        }
      }

      const activeRes = await client.query(
        "SELECT COUNT(*)::int AS count FROM reservations WHERE phase IN ('claimed', 'dispatching')"
      );
      const active = Number(activeRes.rows[0]?.count || 0);

      const settings = await readSettings(client);
      const quotaDay = day || riyadhDay(new Date(now));

      const accountsRes = await client.query(
        `SELECT a.id, a.username, a.enabled, a.exit_ip, a.vpn_resource, a.status, a.failures,
                a.check_generation, a.cookie_file, a.quota_json, COALESCE(q.used, 0)::int AS quota_used
         FROM accounts a
         LEFT JOIN quota q ON q.account_id = a.id AND q.day = $1
         ORDER BY a.position, a.id`,
        [quotaDay]
      );
      const accounts = accountsRes.rows.map(row => {
        const quota = parse(row.quota_json);
        const quotaUsed = Number(row.quota_used || 0);
        const capacity = accountCapacity(
          { settings, posting: { quota: { [quotaDay]: { [row.id]: quotaUsed } } } },
          { id: row.id, quota },
          new Date(`${quotaDay}T12:00:00Z`)
        );
        const { quota_json, ...account } = row;
        return {
          ...account,
          enabled: Boolean(row.enabled),
          failures: Number(row.failures || 0),
          quota_used: quotaUsed,
          quota_limit: quota,
          quotaRemaining: capacity.remaining
        };
      });

      const vpnSlots = await readVpnSlots(client);
      const accountChecks = await readAccountChecks(client);

      const { utcStart, utcEnd } = riyadhDayUtcBounds(quotaDay);
      const dailyMetricsRes = await client.query(
        `SELECT
           COALESCE((
             (SELECT count(*)::int FROM publish_results
              WHERE outcome = 'published'
                AND completed_at ~ '^\\d{4}-\\d{2}-\\d{2}T.*Z$'
                AND completed_at >= $2 AND completed_at < $3)
             +
             (SELECT count(*)::int FROM publish_results
              WHERE outcome = 'published'
                AND completed_at !~ '^\\d{4}-\\d{2}-\\d{2}T.*Z$'
                AND completed_at::timestamptz >= ($1 || ' 00:00:00 Asia/Riyadh')::timestamptz
                AND completed_at::timestamptz < (($1 || ' 00:00:00 Asia/Riyadh')::timestamptz + INTERVAL '1 day'))
           ), 0) AS today_success,
           COALESCE((
             (SELECT count(*)::int FROM publish_results
              WHERE outcome IN ('failed', 'ambiguous')
                AND completed_at ~ '^\\d{4}-\\d{2}-\\d{2}T.*Z$'
                AND completed_at >= $2 AND completed_at < $3)
             +
             (SELECT count(*)::int FROM publish_results
              WHERE outcome IN ('failed', 'ambiguous')
                AND completed_at !~ '^\\d{4}-\\d{2}-\\d{2}T.*Z$'
                AND completed_at::timestamptz >= ($1 || ' 00:00:00 Asia/Riyadh')::timestamptz
                AND completed_at::timestamptz < (($1 || ' 00:00:00 Asia/Riyadh')::timestamptz + INTERVAL '1 day'))
           ), 0) AS today_failed_dispatch,
           COALESCE((
             SELECT count(*)::int FROM post_attempts
             WHERE (outcome = 'pre_dispatch_retry' OR phase = 'recovered_pre_dispatch')
               AND dispatch_started_at IS NULL
               AND (
                 (COALESCE(completed_at, started_at) ~ '^\\d{4}-\\d{2}-\\d{2}T.*Z$'
                  AND COALESCE(completed_at, started_at) >= $2 AND COALESCE(completed_at, started_at) < $3)
                 OR
                 (COALESCE(completed_at, started_at) !~ '^\\d{4}-\\d{2}-\\d{2}T.*Z$'
                  AND COALESCE(completed_at, started_at)::timestamptz >= ($1 || ' 00:00:00 Asia/Riyadh')::timestamptz
                  AND COALESCE(completed_at, started_at)::timestamptz < (($1 || ' 00:00:00 Asia/Riyadh')::timestamptz + INTERVAL '1 day'))
               )
           ), 0) AS today_predispatch_retries`,
        [quotaDay, utcStart, utcEnd]
      );
      const dailyCounters = {
        published: Number(dailyMetricsRes.rows[0]?.today_success || 0),
        failed: Number(dailyMetricsRes.rows[0]?.today_failed_dispatch || 0),
        preDispatchRetries: Number(dailyMetricsRes.rows[0]?.today_predispatch_retries || 0)
      };

      return {
        cycle: {
          state: cycle.state,
          runId: cycle.run_id,
          startedAt: cycle.started_at,
          updatedAt: cycle.updated_at,
          reason: cycle.reason
        },
        total,
        counts,
        claimablePending,
        active,
        accounts,
        quota: { day: quotaDay, dailyQuota: settings.dailyQuota },
        vpnSlots,
        accountChecks,
        dailyCounters,
        todayMetrics: dailyCounters,
        observedAt: new Date(now).toISOString()
      };
    },
    { readOnly: true }
  );
}

function postRecord(row) {
  const item = {
    ...parse(row.source_json, {}),
    id: row.id,
    state: row.state,
    payload: parse(row.payload_json, {}),
    preDispatchRetries: Number(row.pre_dispatch_retries || 0)
  };
  const jsonMappings = {
    attempt: 'attempt_json',
    archivedAttempt: 'archived_attempt_json',
    archivedAttempts: 'archived_attempts_json',
    ownerAssistedPackage: 'owner_assisted_package_json'
  };
  for (const [key, column] of Object.entries(jsonMappings)) {
    if (row[column] != null) item[key] = parse(row[column]);
    else delete item[key];
  }
  return item;
}

async function claimNext(
  poolOrClient,
  { runId, accountId, token, now = new Date().toISOString(), contentKey = null, postId = null } = {}
) {
  if (!runId || !accountId || !token) {
    throw new TypeError('runId, accountId and token are required');
  }
  return await withTransaction(poolOrClient, async client => {
    const cycleRes = await client.query('SELECT state, run_id FROM cycle_state WHERE id = 1');
    const cycle = cycleRes.rows[0];
    if (cycle?.state !== 'running' || cycle.run_id !== runId) return null;

    // Lock the account row FOR UPDATE to serialize quota + reservation admission per account
    const accountRes = await client.query('SELECT * FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
    const row = accountRes.rows[0];
    if (!row || !row.enabled) return null;

    const account = {
      ...parse(row.source_json, {}),
      id: row.id,
      enabled: Boolean(row.enabled),
      status: row.status,
      cookieFile: row.cookie_file,
      checkGeneration: row.check_generation,
      username: row.username,
      userId: row.user_id,
      failures: Number(row.failures || 0),
      quota: parse(row.quota_json)
    };

    const settings = await readSettings(client);
    const accountChecks = await readAccountChecks(client);
    const state = { settings, telegramUi: { accountChecks } };
    if (
      !evaluateAccountUse(state, account, { nowMs: Date.parse(now), requireOwnerEnabled: true }).allowed ||
      account.failures >= 3
    ) {
      return null;
    }

    const day = riyadhDay(new Date(now));
    const usedRes = await client.query(
      'SELECT used FROM quota WHERE day = $1 AND account_id = $2',
      [day, accountId]
    );
    const used = Number(usedRes.rows[0]?.used || 0);

    const reservedRes = await client.query(
      'SELECT COUNT(*)::int AS n FROM reservations WHERE account_id = $1',
      [accountId]
    );
    const reserved = Number(reservedRes.rows[0]?.n || 0);

    const capacity = accountCapacity(
      { settings, posting: { quota: { [day]: { [accountId]: used } } } },
      account,
      new Date(now)
    );
    if (capacity.remaining <= reserved) return null;

    const postParams = postId != null ? [String(postId), accountId] : [accountId];
    const acctParam = postId != null ? '$2' : '$1';
    const postRes = await client.query(
      `SELECT p.*
       FROM posts p
       WHERE p.claimable = 1
         AND p.state = 'pending'
         ${postId != null ? 'AND p.id = $1' : ''}
         AND (
           (p.payload_json::jsonb->>'account') IS NULL
           OR (p.payload_json::jsonb->>'account') = ''
           OR (p.payload_json::jsonb->>'account') = ${acctParam}
         )
         AND NOT EXISTS (
           SELECT 1 FROM ambiguous_fences f
           WHERE f.content_key = COALESCE(NULLIF(p.text_key, ''), p.content_hash, 'post:' || p.id)
         )
         AND NOT EXISTS (
           SELECT 1 FROM posts protected
           WHERE protected.text_key = p.text_key
             AND p.text_key <> ''
             AND protected.text_key <> ''
             AND protected.state <> 'cancelled'
             AND protected.claimable = 0
         )
       ORDER BY p.position, p.id
       FOR UPDATE OF p SKIP LOCKED
       LIMIT 1`,
      postParams
    );
    const post = postRes.rows[0];
    if (!post || !isClaimable(postRecord(post))) return null;
    if (contentKey && post.text !== contentKey) return null;

    const payloadObj = parse(post.payload_json, {});
    const attempt = {
      phase: 'claimed',
      token,
      runId,
      accountId,
      startedAt: now,
      admission: {
        checkGeneration: account.checkGeneration,
        username: account.username,
        userId: account.userId,
        cookieFile: account.cookieFile,
        payloadDigest: sha256(json(stableValue(payloadObj)))
      }
    };

    const changed = await client.query(
      "UPDATE posts SET state = 'processing', claimable = 0, claimed_at = $1, attempt_json = $2 WHERE id = $3 AND state = 'pending'",
      [now, json(attempt), post.id]
    );
    if (changed.rowCount !== 1) return null;

    await client.query(
      'INSERT INTO reservations(post_id, token, run_id, account_id, phase, claimed_at, source_json) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [post.id, token, runId, accountId, 'claimed', now, json(attempt)]
    );

    await client.query(
      `INSERT INTO post_attempts(post_id, token, run_id, account_id, phase, started_at, admission_json, source_json)
       VALUES ($1, $2, $3, $4, 'claimed', $5, $6, $7)
       ON CONFLICT(token) DO UPDATE SET
         phase = EXCLUDED.phase,
         started_at = EXCLUDED.started_at,
         admission_json = EXCLUDED.admission_json,
         source_json = EXCLUDED.source_json`,
      [post.id, token, runId, accountId, now, json(attempt.admission), json(attempt)]
    );

    return {
      id: post.id,
      position: Number(post.position),
      payload: payloadObj,
      state: 'processing',
      attempt
    };
  });
}

async function markDispatching(
  poolOrClient,
  { postId, token, accountId, now = new Date().toISOString() } = {}
) {
  if (!postId || !token || !accountId) {
    throw new TypeError('postId, token and accountId are required');
  }
  return await withTransaction(poolOrClient, async client => {
    const resReservation = await client.query(
      'SELECT * FROM reservations WHERE post_id = $1 AND token = $2 AND account_id = $3 FOR UPDATE',
      [postId, token, accountId]
    );
    const reservation = resReservation.rows[0];
    if (!reservation) {
      throw Object.assign(new Error('CLAIM_TOKEN_MISMATCH'), { code: 'CLAIM_TOKEN_MISMATCH' });
    }

    const resPost = await client.query('SELECT * FROM posts WHERE id = $1 FOR UPDATE', [postId]);
    const post = resPost.rows[0];
    if (!post || post.state !== 'processing') {
      throw Object.assign(new Error('POST_NOT_PROCESSING'), { code: 'POST_NOT_PROCESSING' });
    }

    const previous = parse(post.attempt_json, {});
    const bound = parse(reservation.source_json, {})?.admission;
    const cycleRes = await client.query('SELECT state, run_id FROM cycle_state WHERE id = 1');
    const cycle = cycleRes.rows[0];

    const accountRes = await client.query('SELECT * FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
    const row = accountRes.rows[0];
    const account = row && {
      ...parse(row.source_json, {}),
      id: row.id,
      enabled: Boolean(row.enabled),
      status: row.status,
      cookieFile: row.cookie_file,
      checkGeneration: row.check_generation,
      username: row.username,
      userId: row.user_id,
      failures: Number(row.failures || 0),
      quota: parse(row.quota_json)
    };

    const settings = await readSettings(client);
    const accountChecks = await readAccountChecks(client);
    const state = { settings, telegramUi: { accountChecks } };
    const day = riyadhDay(new Date(now));
    const usedRes = await client.query(
      'SELECT used FROM quota WHERE day = $1 AND account_id = $2',
      [day, accountId]
    );
    const used = Number(usedRes.rows[0]?.used || 0);
    const remaining = account
      ? accountCapacity(
          { settings, posting: { quota: { [day]: { [accountId]: used } } } },
          account,
          new Date(now)
        ).remaining
      : 0;

    if (
      reservation.phase !== 'claimed' ||
      reservation.dispatch_started_at ||
      previous.phase !== 'claimed' ||
      previous.token !== token ||
      previous.accountId !== accountId ||
      previous.runId !== reservation.run_id ||
      cycle?.state !== 'running' ||
      cycle.run_id !== reservation.run_id ||
      !account ||
      !bound ||
      !evaluateAccountUse(state, account, { nowMs: Date.parse(now), requireOwnerEnabled: true }).allowed ||
      account.failures >= 3 ||
      remaining <= 0 ||
      ['checkGeneration', 'username', 'userId', 'cookieFile'].some(key => bound[key] !== account[key]) ||
      bound.payloadDigest !== sha256(json(stableValue(parse(post.payload_json)))) ||
      !isProvenPreDispatch(postRecord(post))
    ) {
      throw Object.assign(new Error('DISPATCH_REJECTED'), { code: 'DISPATCH_REJECTED' });
    }

    const attempt = { ...previous, phase: 'dispatching', dispatchStartedAt: now };
    await client.query(
      "UPDATE posts SET attempt_json = $1 WHERE id = $2 AND state = 'processing'",
      [json(attempt), postId]
    );
    await client.query(
      "UPDATE reservations SET phase = 'dispatching', dispatch_started_at = $1, source_json = $2 WHERE post_id = $3 AND token = $4",
      [now, json(attempt), postId, token]
    );
    await client.query(
      "UPDATE post_attempts SET phase = 'dispatching', dispatch_started_at = $1, source_json = $2 WHERE post_id = $3 AND token = $4",
      [now, json(attempt), postId, token]
    );

    return { postId, phase: 'dispatching', token };
  });
}

function completionSignature({ postId, token, accountId, outcome, url, tweetId, result, day, outbox }) {
  return json(
    stableValue({
      postId,
      token,
      accountId,
      outcome,
      url: url ?? null,
      tweetId: tweetId == null ? null : String(tweetId),
      result: result ?? null,
      day: day || null,
      outbox: outbox
        ? {
            id: outbox.id ?? null,
            dedupeKey: outbox.dedupeKey ?? null,
            kind: outbox.kind ?? null,
            payload: outbox.payload ?? null
          }
        : null
    })
  );
}

async function completePublish(
  poolOrClient,
  {
    postId,
    token,
    accountId,
    outcome = 'published',
    now = new Date().toISOString(),
    url = null,
    tweetId = null,
    result = null,
    day = riyadhDay(new Date(now)),
    outbox = null,
    failureDiagnostic = null
  } = {}
) {
  if (!postId || !token || !accountId) {
    throw new TypeError('postId, token and accountId are required');
  }
  const signature = completionSignature({ postId, token, accountId, outcome, url, tweetId, result, day, outbox });
  const fenceKey = `complete:${postId}:${token}`;

  return await withTransaction(poolOrClient, async client => {
    const existingFenceRes = await client.query(
      "SELECT source_json FROM idempotency_fences WHERE fence_key = $1 AND fence_type = 'publication_completion' FOR UPDATE",
      [fenceKey]
    );
    if (existingFenceRes.rows.length) {
      const record = parse(existingFenceRes.rows[0].source_json, null);
      if (!record || record.signature !== signature) {
        throw Object.assign(new Error('IDEMPOTENCY_CONFLICT'), { code: 'IDEMPOTENCY_CONFLICT' });
      }
      return record.returnValue;
    }

    const resReservation = await client.query(
      'SELECT * FROM reservations WHERE post_id = $1 AND token = $2 FOR UPDATE',
      [postId, token]
    );
    const reservation = resReservation.rows[0];
    if (!reservation || reservation.account_id !== accountId) {
      throw Object.assign(new Error('CLAIM_TOKEN_MISMATCH'), { code: 'CLAIM_TOKEN_MISMATCH' });
    }

    const resAccount = await client.query(
      'SELECT id, username FROM accounts WHERE id = $1',
      [accountId]
    );
    const account = resAccount.rows[0];
    if (!account) {
      throw Object.assign(new Error('ACCOUNT_NOT_FOUND'), { code: 'ACCOUNT_NOT_FOUND' });
    }

    const resPost = await client.query('SELECT * FROM posts WHERE id = $1 FOR UPDATE', [postId]);
    const post = resPost.rows[0];
    if (!post || post.state !== 'processing') {
      throw Object.assign(new Error('POST_NOT_PROCESSING'), { code: 'POST_NOT_PROCESSING' });
    }

    const nextState = outcome === 'published' ? 'published' : outcome === 'ambiguous' ? 'ambiguous' : 'failed';
    const nextResult = result == null ? null : json(result);
    const nextDiagnostic = failureDiagnostic == null ? post.failure_diagnostic_json : json(failureDiagnostic);
    const nextReason = outcome === 'published' ? null : outcome;
    const tweetIdStr = tweetId == null ? null : String(tweetId);
    const publishedAt = outcome === 'published' ? now : null;

    const changed = await client.query(
      `UPDATE posts
       SET state = $1,
           claimable = 0,
           published_at = $2,
           url = $3,
           tweet_id = $4,
           account_id = $5,
           account_username = $6,
           archived_attempt_json = COALESCE(attempt_json, archived_attempt_json),
           attempt_json = NULL,
           claimed_at = NULL,
           result_json = $7,
           reason = $8,
           failure_diagnostic_json = $9
       WHERE id = $10 AND state = 'processing'`,
      [
        nextState,
        publishedAt,
        url,
        tweetIdStr,
        accountId,
        account.username || null,
        nextResult,
        nextReason,
        nextDiagnostic,
        postId
      ]
    );
    if (changed.rowCount !== 1) {
      throw new Error('POST_UPDATE_CONFLICT');
    }

    await client.query('DELETE FROM reservations WHERE post_id = $1 AND token = $2', [postId, token]);

    await client.query(
      `UPDATE post_attempts
       SET phase = 'completed',
           outcome = $1,
           completed_at = $2,
           result_json = $3,
           failure_diagnostic_json = $4
       WHERE post_id = $5 AND token = $6`,
      [nextState, now, nextResult, nextDiagnostic, postId, token]
    );

    await client.query(
      `INSERT INTO publish_results(
         post_id, token, account_id, account_username, outcome, published_at, completed_at,
         url, tweet_id, reason, result_json, failure_diagnostic_json, source_json
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT(post_id) DO UPDATE SET
         token = EXCLUDED.token,
         account_id = EXCLUDED.account_id,
         account_username = EXCLUDED.account_username,
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
        postId,
        token,
        accountId,
        account.username || null,
        nextState,
        publishedAt,
        now,
        url,
        tweetIdStr,
        nextReason,
        nextResult,
        nextDiagnostic,
        json({ postId, token, accountId, outcome: nextState, publishedAt, url, tweetId: tweetIdStr, result })
      ]
    );

    await client.query(
      `INSERT INTO attempt_outcomes(day, account_id, failed, ambiguous, published, updated_at, source_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT(day, account_id) DO UPDATE SET
         failed = attempt_outcomes.failed + EXCLUDED.failed,
         ambiguous = attempt_outcomes.ambiguous + EXCLUDED.ambiguous,
         published = attempt_outcomes.published + EXCLUDED.published,
         updated_at = EXCLUDED.updated_at`,
      [
        day,
        accountId,
        nextState === 'failed' ? 1 : 0,
        nextState === 'ambiguous' ? 1 : 0,
        nextState === 'published' ? 1 : 0,
        now,
        json({ day, accountId, outcome: nextState })
      ]
    );

    if (outcome === 'published') {
      await client.query(
        `INSERT INTO quota(day, account_id, used, source_json)
         VALUES ($1, $2, 1, $3)
         ON CONFLICT(day, account_id) DO UPDATE SET used = quota.used + 1`,
        [day, accountId, json({ day, accountId, used: 1 })]
      );
    }

    if (outcome === 'ambiguous') {
      const fence = post.text_key || post.content_hash || `post:${postId}`;
      await client.query(
        `INSERT INTO ambiguous_fences(content_key, position, created_at, source_json)
         VALUES ($1, COALESCE((SELECT MAX(position) + 1 FROM ambiguous_fences), 0), $2, $3)
         ON CONFLICT(content_key) DO NOTHING`,
        [fence, now, json({ postId, token, reason: 'ambiguous_completion', createdAt: now })]
      );
    }

    if (outbox) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('yj_outbox_seq:' || current_schema()))");
      const id = String(outbox.id || `post:${postId}:${nextState}`);
      const dedupe = String(outbox.dedupeKey || id);
      const payload = json(outbox.payload || { postId, outcome: nextState });
      const kind = outbox.kind || 'publication';
      const existingRes = await client.query(
        'SELECT id, dedupe_key, kind, payload_json FROM outbox WHERE id = $1 OR dedupe_key = $2',
        [id, dedupe]
      );
      const existing = existingRes.rows;
      if (
        existing.length &&
        (existing.length !== 1 ||
          existing[0].id !== id ||
          existing[0].dedupe_key !== dedupe ||
          existing[0].kind !== kind ||
          json(stableValue(parse(existing[0].payload_json))) !== json(stableValue(parse(payload))))
      ) {
        throw Object.assign(new Error('OUTBOX_IDEMPOTENCY_CONFLICT'), { code: 'OUTBOX_IDEMPOTENCY_CONFLICT' });
      }
      if (!existing.length) {
        const seqRes = await client.query(
          'SELECT (COALESCE(MAX(sequence_no), -1) + 1)::bigint AS next_sequence FROM outbox'
        );
        const sequence = Number(seqRes.rows[0].next_sequence);
        await client.query(
          `INSERT INTO outbox(id, sequence_no, dedupe_key, kind, status, payload_json, created_at, source_json)
           VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7)`,
          [id, sequence, dedupe, kind, payload, now, json(outbox)]
        );
      }
    }

    const returnValue = { postId, state: nextState, quotaIncremented: outcome === 'published' };
    await client.query(
      `INSERT INTO idempotency_fences(fence_key, fence_type, post_id, created_at, source_json)
       VALUES ($1, 'publication_completion', $2, $3, $4)`,
      [fenceKey, postId, now, json({ signature, returnValue })]
    );

    return returnValue;
  });
}

async function recoverInterruptedClaims(
  poolOrClient,
  { now = new Date().toISOString(), reason = 'crash_recovery' } = {}
) {
  return await withTransaction(poolOrClient, async client => {
    const res = await client.query(`
      WITH target_posts AS (
        SELECT id FROM posts WHERE state IN ('processing', 'dispatch_started')
        UNION
        SELECT post_id AS id FROM reservations WHERE post_id IS NOT NULL
      )
      SELECT p.*,
             r.post_id AS r_post_id,
             r.token AS r_token,
             r.phase AS r_phase,
             r.dispatch_started_at AS r_dispatch_started_at,
             r.claimed_at AS r_claimed_at
      FROM target_posts tp
      JOIN posts p ON p.id = tp.id
      LEFT JOIN reservations r ON r.post_id = p.id
      ORDER BY COALESCE(r.claimed_at, p.claimed_at, ''), p.position, p.id
      FOR UPDATE OF p
    `);
    const recovered = { preDispatch: [], ambiguous: [] };

    for (const row of res.rows) {
      if (row.state !== 'processing' && row.state !== 'dispatch_started') {
        if (row.r_post_id != null) {
          await client.query(
            'DELETE FROM reservations WHERE post_id = $1 AND token = $2',
            [row.r_post_id, row.r_token]
          );
        }
        continue;
      }

      const attempt = parse(row.attempt_json, {}) || {};
      const attemptToken = row.r_token || attempt.token || null;
      const hasDispatchEvidence =
        row.state !== 'processing' ||
        !isProvenPreDispatch(postRecord(row)) ||
        (row.r_post_id != null && (row.r_phase !== 'claimed' || Boolean(row.r_dispatch_started_at)));

      if (!hasDispatchEvidence) {
        await client.query(
          `UPDATE posts
           SET state = 'pending',
               claimable = CASE WHEN pre_dispatch_retries + 1 < $1 THEN 1 ELSE 0 END,
               claimed_at = NULL,
               archived_attempt_json = COALESCE(attempt_json, archived_attempt_json),
               attempt_json = NULL,
               pre_dispatch_retries = pre_dispatch_retries + 1,
               reason = $2
           WHERE id = $3 AND state = 'processing'`,
          [MAX_PRE_DISPATCH_RETRIES, reason, row.id]
        );
        if (row.r_post_id != null) {
          await client.query(
            'DELETE FROM reservations WHERE post_id = $1 AND token = $2',
            [row.r_post_id, row.r_token]
          );
        }
        if (attemptToken) {
          await client.query(
            "UPDATE post_attempts SET phase = 'recovered_pre_dispatch', outcome = 'pending', completed_at = $1 WHERE post_id = $2 AND token = $3",
            [now, row.id, attemptToken]
          );
        }
        recovered.preDispatch.push(row.id);
        continue;
      }

      const fence = textKey(row.text) || row.content_hash || `post:${row.id}`;
      await client.query(
        `INSERT INTO ambiguous_fences(content_key, position, created_at, source_json)
         VALUES ($1, COALESCE((SELECT MAX(position) + 1 FROM ambiguous_fences), 0), $2, $3)
         ON CONFLICT(content_key) DO NOTHING`,
        [fence, now, json({ postId: row.id, token: attemptToken, reason, recoveredAt: now })]
      );
      await client.query(
        `UPDATE posts
         SET state = 'ambiguous',
             claimable = 0,
             claimed_at = NULL,
             archived_attempt_json = COALESCE(attempt_json, archived_attempt_json),
             attempt_json = NULL,
             reason = $1,
             result_json = $2
         WHERE id = $3 AND state IN ('processing', 'dispatch_started')`,
        [reason, json({ reason, attemptToken, recoveredAt: now }), row.id]
      );
      if (row.r_post_id != null) {
        await client.query(
          'DELETE FROM reservations WHERE post_id = $1 AND token = $2',
          [row.r_post_id, row.r_token]
        );
      }
      if (attemptToken) {
        await client.query(
          "UPDATE post_attempts SET phase = 'recovered_ambiguous', outcome = 'ambiguous', completed_at = $1 WHERE post_id = $2 AND token = $3",
          [now, row.id, attemptToken]
        );
      }
      recovered.ambiguous.push(row.id);
    }

    return recovered;
  });
}

module.exports = {
  SCHEMA_VERSION,
  PG_SCHEMA_DDL,
  AUXILIARY_TABLES,
  DEFAULT_SECRET_PATH,
  readPgPassword,
  getPgConfig,
  createPool,
  isTestEnvironment,
  assertPgMutationAllowed,
  withClient,
  withTransaction,
  ensurePgSchema,
  migrateStateObjectToPg,
  importUiOwners,
  getPostsBatch,
  getDashboardSnapshot,
  claimNext,
  markDispatching,
  completePublish,
  recoverInterruptedClaims,
  batchInsert,
  parse,
  json,
  sha256,
  textKey,
  stableValue
};
