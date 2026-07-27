'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const DEFAULT_WAL_AUTOCHECKPOINT_PAGES = 1_000;
// After this many pre-dispatch failures an item is considered poison and is
// retired to 'dead' instead of cycling through the queue forever.
const DEFAULT_MAX_PRE_DISPATCH_FAILURES = 5;
const ITEM_STATES = new Set([
  'queued',
  'leased',
  'dispatch_started',
  'published',
  'ambiguous',
  'deferred',
  'dead',
  'discarded',
]);

/**
 * States an operator may discard from.
 *
 * All three are pre-boundary: the post was never handed to the transport, so a
 * tombstone here cannot hide something that is live on X. `leased`,
 * `dispatch_started`, `ambiguous` and `published` are deliberately absent —
 * those must be resolved, not deleted.
 */
const DISCARDABLE_STATES = new Set(['queued', 'deferred', 'dead']);

class WorkflowConflictError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'WorkflowConflictError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

class WorkflowValidationError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'WorkflowValidationError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function validation(code, message, details) {
  throw new WorkflowValidationError(code, message, details);
}

function conflict(code, message, details) {
  throw new WorkflowConflictError(code, message, details);
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function canonicalize(value, stack = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('JSON values must contain only finite numbers');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`Unsupported JSON value: ${typeof value}`);
  }
  if (stack.has(value)) throw new TypeError('JSON values must not contain cycles');

  stack.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((entry) => canonicalize(entry, stack));
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('JSON objects must be plain objects');
    }
    result = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = canonicalize(value[key], stack);
    }
  }
  stack.delete(value);
  return result;
}

function canonicalStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function serializeObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
  canonicalStringify(value);
  return JSON.stringify(value);
}

function optionalJson(value) {
  if (value === undefined || value === null) return null;
  return canonicalStringify(value);
}

function parseJson(value) {
  return value === null || value === undefined ? null : JSON.parse(value);
}

function fsyncDirectory(directory) {
  let fd;
  try {
    fd = fs.openSync(directory, 'r');
    fs.fsyncSync(fd);
  } catch (error) {
    if (!['EINVAL', 'EPERM', 'EISDIR', 'ENOTSUP'].includes(error.code)) throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function hashOpenFile(fd) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  let bytesRead;
  do {
    bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position);
    if (bytesRead > 0) {
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } while (bytesRead > 0);
  return { sha256: hash.digest('hex'), byteSize: position };
}

function defaultRootDir() {
  // Resolve HOME at construction time so tests can isolate it before creating a store.
  return path.join(os.homedir(), '.config', 'x-poster-shared');
}

const UUID_CHECK = `
  length(%s) = 36
  AND substr(%s, 9, 1) = '-'
  AND substr(%s, 14, 1) = '-'
  AND substr(%s, 19, 1) = '-'
  AND substr(%s, 24, 1) = '-'
  AND lower(%s) NOT GLOB '*[^0-9a-f-]*'
`;

function uuidCheck(column) {
  return UUID_CHECK.replaceAll('%s', column);
}

function schemaSql() {
  const itemUuid = uuidCheck('id');
  const profileUuid = uuidCheck('id');
  const runUuid = uuidCheck('id');
  const attemptUuid = uuidCheck('id');
  const requestUuid = uuidCheck('id');
  const eventUuid = uuidCheck('id');

  return `
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY CHECK (${profileUuid}),
      name TEXT NOT NULL UNIQUE CHECK (length(trim(name)) > 0),
      status TEXT NOT NULL CHECK (status IN ('active', 'deleted')),
      legacy_path TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      deleted_at_ms INTEGER,
      CHECK ((status = 'active' AND deleted_at_ms IS NULL)
        OR (status = 'deleted' AND deleted_at_ms IS NOT NULL))
    ) STRICT;

    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY CHECK (${runUuid}),
      status TEXT NOT NULL CHECK (status IN ('active', 'closed', 'crashed')),
      started_at_ms INTEGER NOT NULL,
      heartbeat_at_ms INTEGER NOT NULL,
      finished_at_ms INTEGER,
      CHECK ((status = 'active' AND finished_at_ms IS NULL)
        OR (status IN ('closed', 'crashed') AND finished_at_ms IS NOT NULL))
    ) STRICT;

    CREATE TABLE IF NOT EXISTS workflow_counters (
      name TEXT PRIMARY KEY,
      value INTEGER NOT NULL CHECK (value >= 0)
    ) STRICT;
    INSERT OR IGNORE INTO workflow_counters(name, value) VALUES ('queue_seq', 0);

    CREATE TABLE IF NOT EXISTS workflow_items (
      id TEXT PRIMARY KEY CHECK (${itemUuid}),
      state TEXT NOT NULL CHECK (state IN (
        'queued', 'leased', 'dispatch_started', 'published',
        'ambiguous', 'deferred', 'dead', 'discarded'
      )),
      payload_json TEXT NOT NULL
        CHECK (json_valid(payload_json) AND json_type(payload_json, '$') = 'object'),
      payload_sha256 TEXT NOT NULL
        CHECK (length(payload_sha256) = 64 AND lower(payload_sha256) NOT GLOB '*[^0-9a-f]*'),
      payload_text TEXT GENERATED ALWAYS AS (json_extract(payload_json, '$.text')) VIRTUAL,
      queue_seq INTEGER UNIQUE,
      available_at_ms INTEGER,
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      lease_token TEXT,
      lease_owner_run_id TEXT REFERENCES workflow_runs(id),
      lease_profile_id TEXT REFERENCES profiles(id),
      lease_expires_at_ms INTEGER,
      current_attempt_id TEXT REFERENCES dispatch_attempts(id),
      last_profile_id TEXT REFERENCES profiles(id),
      pre_dispatch_failure_count INTEGER NOT NULL DEFAULT 0 CHECK (pre_dispatch_failure_count >= 0),
      -- Queue position held before the current lease, so releasing a claim
      -- (Stop, guard refusal) restores the user's ordering instead of sending
      -- an untouched post to the back of the queue.
      queue_seq_before_lease INTEGER,
      reason TEXT,
      error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
      resolution_json TEXT CHECK (resolution_json IS NULL OR json_valid(resolution_json)),
      reconciliation_closed_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      published_at_ms INTEGER,
      discarded_at_ms INTEGER,
      CHECK (
        (state IN ('queued', 'deferred')
          AND queue_seq IS NOT NULL AND available_at_ms IS NOT NULL
          AND lease_token IS NULL AND lease_owner_run_id IS NULL
          AND lease_profile_id IS NULL AND lease_expires_at_ms IS NULL
          AND current_attempt_id IS NULL)
        OR
        (state = 'leased'
          AND queue_seq IS NULL AND available_at_ms IS NULL
          AND lease_token IS NOT NULL AND lease_owner_run_id IS NOT NULL
          AND lease_profile_id IS NOT NULL AND lease_expires_at_ms IS NOT NULL
          AND current_attempt_id IS NULL)
        OR
        (state IN ('dispatch_started', 'published', 'ambiguous')
          AND queue_seq IS NULL AND available_at_ms IS NULL
          AND lease_token IS NULL AND lease_owner_run_id IS NULL
          AND lease_profile_id IS NULL AND lease_expires_at_ms IS NULL
          AND current_attempt_id IS NOT NULL)
        OR
        (state IN ('dead', 'discarded')
          AND queue_seq IS NULL AND available_at_ms IS NULL
          AND lease_token IS NULL AND lease_owner_run_id IS NULL
          AND lease_profile_id IS NULL AND lease_expires_at_ms IS NULL
          AND current_attempt_id IS NULL)
      ),
      CHECK ((state = 'published' AND published_at_ms IS NOT NULL)
        OR (state <> 'published' AND published_at_ms IS NULL)),
      CHECK ((state = 'discarded' AND discarded_at_ms IS NOT NULL)
        OR (state <> 'discarded' AND discarded_at_ms IS NULL))
    ) STRICT;

    CREATE TABLE IF NOT EXISTS dispatch_attempts (
      id TEXT PRIMARY KEY CHECK (${attemptUuid}),
      item_id TEXT NOT NULL REFERENCES workflow_items(id),
      profile_id TEXT NOT NULL REFERENCES profiles(id),
      run_id TEXT NOT NULL REFERENCES workflow_runs(id),
      attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
      rendered_text TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL
        CHECK (length(payload_sha256) = 64 AND lower(payload_sha256) NOT GLOB '*[^0-9a-f]*'),
      phase TEXT NOT NULL CHECK (phase IN (
        'started', 'ambiguous', 'published', 'confirmed_not_published'
      )),
      external_id TEXT,
      external_url TEXT,
      reason TEXT,
      error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
      evidence_json TEXT CHECK (evidence_json IS NULL OR json_valid(evidence_json)),
      resolution_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      UNIQUE (item_id, attempt_number),
      CHECK ((phase IN ('published', 'confirmed_not_published') AND resolution_at_ms IS NOT NULL)
        OR (phase IN ('started', 'ambiguous') AND resolution_at_ms IS NULL))
    ) STRICT;

    CREATE TABLE IF NOT EXISTS media_blobs (
      sha256 TEXT PRIMARY KEY
        CHECK (length(sha256) = 64 AND lower(sha256) NOT GLOB '*[^0-9a-f]*'),
      relative_path TEXT NOT NULL UNIQUE CHECK (length(trim(relative_path)) > 0),
      byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
      status TEXT NOT NULL CHECK (status IN ('ready', 'missing', 'corrupt')),
      created_at_ms INTEGER NOT NULL,
      verified_at_ms INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS item_media (
      item_id TEXT NOT NULL REFERENCES workflow_items(id),
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      blob_sha256 TEXT NOT NULL REFERENCES media_blobs(sha256),
      original_path TEXT NOT NULL CHECK (length(original_path) > 0),
      PRIMARY KEY (item_id, ordinal)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS item_media_blob_idx ON item_media(blob_sha256);

    CREATE TABLE IF NOT EXISTS api_requests (
      id TEXT PRIMARY KEY CHECK (${requestUuid}),
      request_id TEXT NOT NULL UNIQUE CHECK (length(trim(request_id)) > 0),
      operation TEXT NOT NULL CHECK (length(trim(operation)) > 0),
      payload_sha256 TEXT NOT NULL
        CHECK (length(payload_sha256) = 64 AND lower(payload_sha256) NOT GLOB '*[^0-9a-f]*'),
      response_json TEXT NOT NULL CHECK (json_valid(response_json)),
      created_at_ms INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS workflow_metadata (
      key TEXT PRIMARY KEY CHECK (length(trim(key)) > 0),
      value_json TEXT NOT NULL CHECK (json_valid(value_json)),
      updated_at_ms INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS migration_sources (
      id TEXT PRIMARY KEY CHECK (${requestUuid}),
      logical_name TEXT NOT NULL,
      source_path TEXT NOT NULL,
      byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
      sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
      record_count INTEGER NOT NULL CHECK (record_count >= 0),
      backup_relative_path TEXT NOT NULL,
      imported_at_ms INTEGER NOT NULL,
      UNIQUE(source_path, sha256)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS migration_rows (
      source_id TEXT NOT NULL REFERENCES migration_sources(id),
      source_ordinal INTEGER NOT NULL CHECK (source_ordinal >= 0),
      item_id TEXT REFERENCES workflow_items(id),
      disposition TEXT NOT NULL,
      PRIMARY KEY(source_id, source_ordinal)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS migration_conflicts (
      id TEXT PRIMARY KEY CHECK (${requestUuid}),
      conflict_type TEXT NOT NULL,
      details_json TEXT NOT NULL CHECK (json_valid(details_json)),
      created_at_ms INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS workflow_events (
      id TEXT PRIMARY KEY CHECK (${eventUuid}),
      item_id TEXT NOT NULL REFERENCES workflow_items(id),
      event_type TEXT NOT NULL CHECK (length(trim(event_type)) > 0),
      from_state TEXT CHECK (from_state IS NULL OR from_state IN (
        'queued', 'leased', 'dispatch_started', 'published',
        'ambiguous', 'deferred', 'dead', 'discarded'
      )),
      to_state TEXT NOT NULL CHECK (to_state IN (
        'queued', 'leased', 'dispatch_started', 'published',
        'ambiguous', 'deferred', 'dead', 'discarded'
      )),
      revision INTEGER NOT NULL CHECK (revision >= 0),
      data_json TEXT NOT NULL CHECK (json_valid(data_json)),
      created_at_ms INTEGER NOT NULL
    ) STRICT;

    /*
     * Compact tombstones for work retention has removed from the live tables.
     *
     * Deliberately NOT a copy of workflow_items. Retention exists to drop the
     * audit bulk — events, attempts, resolution blobs — while keeping what the
     * app still needs: the published text (the semantic-dedup corpus reads it,
     * so dropping it would make the app willing to republish everything past
     * the cutoff) and the proof that it went out.
     *
     * No foreign key to workflow_items: the point is that the row is gone.
     */
    CREATE TABLE IF NOT EXISTS archived_items (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL CHECK (state IN ('published', 'discarded', 'dead')),
      text TEXT NOT NULL,
      published_at_ms INTEGER,
      archived_at_ms INTEGER NOT NULL,
      external_url TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS archived_items_scan_idx
      ON archived_items (archived_at_ms, id);

    CREATE INDEX IF NOT EXISTS workflow_items_ready_idx
      ON workflow_items (available_at_ms, queue_seq)
      WHERE state IN ('queued', 'deferred');
    CREATE INDEX IF NOT EXISTS workflow_items_lease_expiry_idx
      ON workflow_items (lease_expires_at_ms)
      WHERE state = 'leased';
    CREATE INDEX IF NOT EXISTS workflow_items_recovery_idx
      ON workflow_items (state, reconciliation_closed_at_ms, updated_at_ms)
      WHERE state IN ('dispatch_started', 'ambiguous');
    CREATE INDEX IF NOT EXISTS workflow_items_last_profile_idx
      ON workflow_items (last_profile_id, state);
    CREATE INDEX IF NOT EXISTS workflow_events_item_idx
      ON workflow_events (item_id, created_at_ms, id);
    CREATE UNIQUE INDEX IF NOT EXISTS dispatch_attempts_unresolved_item_idx
      ON dispatch_attempts (item_id)
      WHERE phase IN ('started', 'ambiguous');
    CREATE UNIQUE INDEX IF NOT EXISTS dispatch_attempts_external_id_idx
      ON dispatch_attempts (external_id)
      WHERE external_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS dispatch_attempts_external_url_idx
      ON dispatch_attempts (external_url)
      WHERE external_url IS NOT NULL;

    CREATE TRIGGER IF NOT EXISTS workflow_items_immutable_identity
    BEFORE UPDATE ON workflow_items
    WHEN NEW.id IS NOT OLD.id
      OR NEW.payload_json IS NOT OLD.payload_json
      OR NEW.payload_sha256 IS NOT OLD.payload_sha256
      OR NEW.created_at_ms IS NOT OLD.created_at_ms
    BEGIN
      SELECT RAISE(ABORT, 'workflow item identity and payload are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS workflow_items_valid_transition
    BEFORE UPDATE OF state ON workflow_items
    WHEN NEW.state <> OLD.state AND NOT (
      (OLD.state = 'queued' AND NEW.state IN ('leased', 'discarded'))
      OR (OLD.state = 'deferred' AND NEW.state IN ('leased', 'dead', 'discarded'))
      OR (OLD.state = 'leased' AND NEW.state IN (
        'queued', 'deferred', 'dead', 'discarded', 'dispatch_started'
      ))
      OR (OLD.state = 'dispatch_started' AND NEW.state IN ('published', 'ambiguous'))
      OR (OLD.state = 'ambiguous' AND NEW.state IN ('queued', 'published'))
      OR (OLD.state = 'dead' AND NEW.state IN ('queued', 'discarded', 'published'))
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid state transition');
    END;

    CREATE TRIGGER IF NOT EXISTS dispatch_attempts_immutable_identity
    BEFORE UPDATE ON dispatch_attempts
    WHEN NEW.id IS NOT OLD.id
      OR NEW.item_id IS NOT OLD.item_id
      OR NEW.profile_id IS NOT OLD.profile_id
      OR NEW.run_id IS NOT OLD.run_id
      OR NEW.attempt_number IS NOT OLD.attempt_number
      OR NEW.rendered_text IS NOT OLD.rendered_text
      OR NEW.payload_sha256 IS NOT OLD.payload_sha256
      OR NEW.created_at_ms IS NOT OLD.created_at_ms
    BEGIN
      SELECT RAISE(ABORT, 'dispatch attempt identity and payload are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS dispatch_attempts_valid_transition
    BEFORE UPDATE OF phase ON dispatch_attempts
    WHEN NEW.phase <> OLD.phase AND NOT (
      (OLD.phase = 'started' AND NEW.phase IN ('ambiguous', 'published'))
      OR (OLD.phase = 'ambiguous' AND NEW.phase IN ('published', 'confirmed_not_published'))
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid dispatch attempt transition');
    END;

    CREATE TRIGGER IF NOT EXISTS workflow_events_append_only_update
    BEFORE UPDATE ON workflow_events
    BEGIN
      SELECT RAISE(ABORT, 'workflow events are append-only');
    END;
    -- Events are append-only, but not eternal — same reasoning, and the same
    -- mechanism, as api_requests below.
    --
    -- The unconditional version of this trigger made retention impossible: the
    -- event log grew at four rows per published post and nothing could ever
    -- remove it, so a two-year install carried ~292,000 rows describing posts
    -- whose items had long since served their purpose. An audit record that
    -- outlives its subject by years is cost, not evidence.
    --
    -- Deletion stays impossible by default: it requires a cutoff written into
    -- workflow_metadata inside the SAME transaction, which applyRetention sets
    -- and clears. Recent events remain untouchable.
    DROP TRIGGER IF EXISTS workflow_events_append_only_delete;
    CREATE TRIGGER IF NOT EXISTS workflow_events_retention_delete
    BEFORE DELETE ON workflow_events
    WHEN OLD.created_at_ms > COALESCE(
      (SELECT CAST(json_extract(value_json, '$.cutoffMs') AS INTEGER)
       FROM workflow_metadata WHERE key = 'workflow_events_prune_cutoff'),
      -1
    )
    BEGIN
      SELECT RAISE(ABORT, 'workflow events are append-only until their retention cutoff');
    END;
    CREATE TRIGGER IF NOT EXISTS api_requests_immutable_update
    BEFORE UPDATE ON api_requests
    BEGIN
      SELECT RAISE(ABORT, 'api request records are immutable');
    END;
    -- Idempotency records are immutable, but not eternal: replay only matters
    -- while the originating operation could still be retried. Deleting an aged
    -- record is safe and is the only defence against unbounded DB growth
    -- (measured at >50% of total size). Recent records stay protected.
    CREATE TRIGGER IF NOT EXISTS api_requests_retention_delete
    BEFORE DELETE ON api_requests
    WHEN OLD.created_at_ms > COALESCE(
      (SELECT CAST(json_extract(value_json, '$.cutoffMs') AS INTEGER)
       FROM workflow_metadata WHERE key = 'api_requests_prune_cutoff'),
      9223372036854775807
    )
    BEGIN
      SELECT RAISE(ABORT, 'api request records are immutable until their retention cutoff');
    END;
    CREATE TRIGGER IF NOT EXISTS media_blobs_immutable_identity
    BEFORE UPDATE ON media_blobs
    WHEN NEW.sha256 IS NOT OLD.sha256
      OR NEW.relative_path IS NOT OLD.relative_path
      OR NEW.byte_size IS NOT OLD.byte_size
      OR NEW.created_at_ms IS NOT OLD.created_at_ms
    BEGIN
      SELECT RAISE(ABORT, 'media blob identity is immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS media_blobs_no_delete
    BEFORE DELETE ON media_blobs
    BEGIN
      SELECT RAISE(ABORT, 'media blobs are durable tombstones');
    END;
    CREATE TRIGGER IF NOT EXISTS item_media_no_update
    BEFORE UPDATE ON item_media
    BEGIN
      SELECT RAISE(ABORT, 'item media links are immutable');
    END;
    -- item_media has no timestamp of its own, so its retention gate is a flag
    -- rather than a cutoff: applyRetention sets it inside its transaction and
    -- clears it before returning. Outside that window the link is immutable, so
    -- nothing can quietly detach a post from the bytes it was published with.
    --
    -- The blob itself is never deleted here — media_blobs remains a durable
    -- tombstone, and sweepOrphanMedia is what reclaims unreferenced bytes.
    DROP TRIGGER IF EXISTS item_media_no_delete;
    CREATE TRIGGER IF NOT EXISTS item_media_retention_delete
    BEFORE DELETE ON item_media
    WHEN COALESCE(
      (SELECT json_extract(value_json, '$.active')
       FROM workflow_metadata WHERE key = 'item_media_prune_gate'),
      0
    ) <> 1
    BEGIN
      SELECT RAISE(ABORT, 'item media links are durable outside a retention pass');
    END;
  `;
}

class WorkflowStore {
  constructor(options = {}) {
    const rootDir = path.resolve(options.rootDir || defaultRootDir());
    const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
    const walAutocheckpointPages = options.walAutocheckpointPages ?? DEFAULT_WAL_AUTOCHECKPOINT_PAGES;
    const maxPreDispatchFailures = options.maxPreDispatchFailures ?? DEFAULT_MAX_PRE_DISPATCH_FAILURES;
    if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
      throw new TypeError('busyTimeoutMs must be a non-negative integer');
    }
    if (!Number.isInteger(walAutocheckpointPages) || walAutocheckpointPages <= 0) {
      throw new TypeError('walAutocheckpointPages must be a positive integer');
    }
    if (!Number.isInteger(maxPreDispatchFailures) || maxPreDispatchFailures <= 0) {
      throw new TypeError('maxPreDispatchFailures must be a positive integer');
    }
    fs.mkdirSync(rootDir, { recursive: true });

    this.rootDir = rootDir;
    this.maxPreDispatchFailures = maxPreDispatchFailures;
    this.mediaDir = path.join(rootDir, 'media');
    this.mediaTempDir = path.join(this.mediaDir, '.tmp');
    fs.mkdirSync(this.mediaTempDir, { recursive: true });
    this.dbPath = path.resolve(options.dbPath || path.join(rootDir, 'workflow.sqlite'));
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.closed = false;
    this.db = new Database(this.dbPath);

    try {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = FULL');
      this.db.pragma('foreign_keys = ON');
      this.db.pragma(`busy_timeout = ${busyTimeoutMs}`);
      this.db.pragma(`wal_autocheckpoint = ${walAutocheckpointPages}`);
      this.db.transaction(() => this.db.exec(schemaSql())).immediate();
    } catch (error) {
      this.db.close();
      this.closed = true;
      throw error;
    }
  }

  _assertOpen() {
    if (this.closed) throw new Error('WorkflowStore is closed');
  }

  _immediate(work) {
    this._assertOpen();
    return this.db.transaction(work).immediate();
  }

  _mutate(operation, requestId, requestPayload, work) {
    const normalizedRequestId = assertNonEmptyString(requestId, 'requestId');
    const payloadHash = sha256(canonicalStringify({ operation, payload: requestPayload }));

    return this._immediate(() => {
      const existing = this.db.prepare(`
        SELECT operation, payload_sha256, response_json
        FROM api_requests
        WHERE request_id = ?
      `).get(normalizedRequestId);

      if (existing) {
        if (existing.operation !== operation || existing.payload_sha256 !== payloadHash) {
          conflict(
            'IDEMPOTENCY_KEY_REUSED',
            `requestId ${normalizedRequestId} was already used with a different payload`,
          );
        }
        return JSON.parse(existing.response_json);
      }

      const response = work();
      const responseJson = canonicalStringify(response);
      this.db.prepare(`
        INSERT INTO api_requests (
          id, request_id, operation, payload_sha256, response_json, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        crypto.randomUUID(),
        normalizedRequestId,
        operation,
        payloadHash,
        responseJson,
        Date.now(),
      );
      return response;
    });
  }

  _getReplay(operation, requestId, requestPayload) {
    this._assertOpen();
    const normalizedRequestId = assertNonEmptyString(requestId, 'requestId');
    const payloadHash = sha256(canonicalStringify({ operation, payload: requestPayload }));
    const existing = this.db.prepare(`
      SELECT operation, payload_sha256, response_json
      FROM api_requests
      WHERE request_id = ?
    `).get(normalizedRequestId);
    if (!existing) return null;
    if (existing.operation !== operation || existing.payload_sha256 !== payloadHash) {
      conflict(
        'IDEMPOTENCY_KEY_REUSED',
        `requestId ${normalizedRequestId} was already used with a different payload`,
      );
    }
    return JSON.parse(existing.response_json);
  }

  _stageMedia(originalPath) {
    if (typeof originalPath !== 'string' || originalPath.trim() === '') {
      validation('INVALID_MEDIA_PATH', 'media_path must be a non-empty string');
    }
    const resolvedSource = path.resolve(originalPath);
    let sourceFd;
    let tempFd;
    const tempPath = path.join(this.mediaTempDir, `${crypto.randomUUID()}.part`);
    try {
      try {
        sourceFd = fs.openSync(resolvedSource, 'r');
      } catch (error) {
        if (error.code === 'ENOENT') {
          validation('MEDIA_NOT_FOUND', `Media file does not exist: ${resolvedSource}`, { path: resolvedSource });
        }
        throw error;
      }
      const sourceStat = fs.fstatSync(sourceFd);
      if (!sourceStat.isFile()) {
        validation('MEDIA_NOT_FILE', `Media path is not a regular file: ${resolvedSource}`, { path: resolvedSource });
      }

      tempFd = fs.openSync(tempPath, 'wx', 0o600);
      const hash = crypto.createHash('sha256');
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let position = 0;
      let bytesRead;
      do {
        bytesRead = fs.readSync(sourceFd, buffer, 0, buffer.length, position);
        if (bytesRead > 0) {
          hash.update(buffer.subarray(0, bytesRead));
          let written = 0;
          while (written < bytesRead) {
            written += fs.writeSync(tempFd, buffer, written, bytesRead - written, position + written);
          }
          position += bytesRead;
        }
      } while (bytesRead > 0);
      fs.fsyncSync(tempFd);
      fs.closeSync(tempFd);
      tempFd = undefined;

      const digest = hash.digest('hex');
      const sourceExtension = path.extname(resolvedSource).toLowerCase();
      const extension = /^\.[a-z0-9]{1,10}$/.test(sourceExtension) ? sourceExtension : '';
      const existingBlob = this.db.prepare(`
        SELECT relative_path, byte_size FROM media_blobs WHERE sha256 = ?
      `).get(digest);
      if (existingBlob && existingBlob.byte_size !== position) {
        validation('MEDIA_CORRUPT', 'Managed media size conflicts with its content hash', {
          sha256: digest,
        });
      }
      const relativePath = existingBlob ? existingBlob.relative_path : `${digest}${extension}`;
      const managedPath = path.join(this.mediaDir, relativePath);

      if (fs.existsSync(managedPath)) {
        const existingFd = fs.openSync(managedPath, 'r');
        try {
          const existing = hashOpenFile(existingFd);
          if (existing.sha256 !== digest || existing.byteSize !== position) {
            validation('MEDIA_CORRUPT', `Managed media hash mismatch: ${managedPath}`, {
              path: managedPath,
              expectedSha256: digest,
            });
          }
        } finally {
          fs.closeSync(existingFd);
        }
        fs.unlinkSync(tempPath);
      } else {
        fs.renameSync(tempPath, managedPath);
        fsyncDirectory(this.mediaDir);
      }

      return {
        sha256: digest,
        byteSize: position,
        relativePath,
        managedPath,
        originalPath: resolvedSource,
        status: 'ready',
      };
    } finally {
      // Cleanup must never replace the in-flight exception. A throw here would
      // surface e.g. an EPERM unlink instead of the real media-corruption error
      // (common on Windows with antivirus/backup software holding the file).
      // Each step is independent so one failure cannot skip the others.
      try { if (sourceFd !== undefined) fs.closeSync(sourceFd); } catch { /* best effort */ }
      try { if (tempFd !== undefined) fs.closeSync(tempFd); } catch { /* best effort */ }
      // A leftover .part file is swept later by sweepOrphanMedia().
      try { fs.unlinkSync(tempPath); } catch { /* best effort */ }
    }
  }

  _mediaForItem(itemId) {
    return this.db.prepare(`
      SELECT im.ordinal, im.original_path, mb.sha256, mb.relative_path,
             mb.byte_size, mb.status
      FROM item_media im
      JOIN media_blobs mb ON mb.sha256 = im.blob_sha256
      WHERE im.item_id = ?
      ORDER BY im.ordinal ASC
    `).all(itemId).map((row) => ({
      ordinal: row.ordinal,
      originalPath: row.original_path,
      sha256: row.sha256,
      byteSize: row.byte_size,
      status: row.status,
      managedPath: path.join(this.mediaDir, row.relative_path),
    }));
  }

  /**
   * Verify every managed blob for an item still matches its recorded size and
   * digest. Used at the dispatch boundary so corrupt/missing media can never be
   * published, and is never misreported as remote ambiguity.
   */
  _assertMediaIntegrity(itemId) {
    for (const entry of this._mediaForItem(itemId)) {
      let stat;
      try {
        stat = fs.statSync(entry.managedPath);
      } catch (error) {
        conflict('MEDIA_INTEGRITY_FAILED', `Managed media is unreadable: ${entry.managedPath}`, {
          itemId,
          ordinal: entry.ordinal,
          reason: error.code === 'ENOENT' ? 'missing' : 'unreadable',
        });
      }
      if (stat.size !== entry.byteSize) {
        conflict('MEDIA_INTEGRITY_FAILED', `Managed media size changed: ${entry.managedPath}`, {
          itemId,
          ordinal: entry.ordinal,
          expectedBytes: entry.byteSize,
          actualBytes: stat.size,
        });
      }
      let fd;
      let actual;
      try {
        fd = fs.openSync(entry.managedPath, 'r');
        actual = hashOpenFile(fd);
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
      if (actual.sha256 !== entry.sha256) {
        conflict('MEDIA_INTEGRITY_FAILED', `Managed media digest changed: ${entry.managedPath}`, {
          itemId,
          ordinal: entry.ordinal,
          expectedSha256: entry.sha256,
          actualSha256: actual.sha256,
        });
      }
    }
  }

  _nextQueueSequence() {
    const row = this.db.prepare(`
      UPDATE workflow_counters
      SET value = value + 1
      WHERE name = 'queue_seq'
      RETURNING value
    `).get();
    if (!row) throw new Error('queue sequence counter is missing');
    return row.value;
  }

  _recordEvent(itemId, eventType, fromState, toState, revision, data = {}, now = Date.now()) {
    if (!ITEM_STATES.has(toState) || (fromState !== null && !ITEM_STATES.has(fromState))) {
      throw new Error('Cannot record an event with an unknown workflow state');
    }
    this.db.prepare(`
      INSERT INTO workflow_events (
        id, item_id, event_type, from_state, to_state, revision, data_json, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      itemId,
      eventType,
      fromState,
      toState,
      revision,
      canonicalStringify(data),
      now,
    );
  }

  _rowToItem(row) {
    if (!row) return null;
    const lastProfile = row.last_profile_id
      ? this.db.prepare(`
        SELECT id, name, status, legacy_path, created_at_ms, updated_at_ms, deleted_at_ms
        FROM profiles WHERE id = ?
      `).get(row.last_profile_id)
      : null;
    return {
      id: row.id,
      state: row.state,
      payload: JSON.parse(row.payload_json),
      payloadSha256: row.payload_sha256,
      text: row.payload_text,
      queueSeq: row.queue_seq,
      availableAtMs: row.available_at_ms,
      revision: row.revision,
      leaseToken: row.lease_token,
      leaseOwnerRunId: row.lease_owner_run_id,
      leaseProfileId: row.lease_profile_id,
      leaseExpiresAtMs: row.lease_expires_at_ms,
      currentAttemptId: row.current_attempt_id,
      lastProfileId: row.last_profile_id,
      lastProfile: lastProfile ? {
        id: lastProfile.id,
        name: lastProfile.name,
        status: lastProfile.status,
        legacyPath: lastProfile.legacy_path,
        createdAtMs: lastProfile.created_at_ms,
        updatedAtMs: lastProfile.updated_at_ms,
        deletedAtMs: lastProfile.deleted_at_ms,
      } : null,
      media: this._mediaForItem(row.id),
      preDispatchFailureCount: row.pre_dispatch_failure_count,
      reason: row.reason,
      error: parseJson(row.error_json),
      resolution: parseJson(row.resolution_json),
      // The exact attempted content and evidence, so an operator reconciling an
      // ambiguous item can see what was actually sent before deciding.
      currentAttempt: row.current_attempt_id ? this._attemptSummary(row.current_attempt_id) : null,
      reconciliationClosedAtMs: row.reconciliation_closed_at_ms,
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
      publishedAtMs: row.published_at_ms,
      discardedAtMs: row.discarded_at_ms,
    };
  }

  /**
   * Immutable record of what was actually attempted: the exact rendered text,
   * who owned it, the phase, and any external identifiers/evidence. Manual
   * reconciliation is unsafe without this.
   */
  _attemptSummary(attemptId) {
    const row = this.db.prepare(`
      SELECT id, item_id, profile_id, run_id, attempt_number, rendered_text,
             phase, external_id, external_url, reason, error_json, evidence_json,
             resolution_at_ms, created_at_ms, updated_at_ms
      FROM dispatch_attempts WHERE id = ?
    `).get(attemptId);
    if (!row) return null;
    return {
      id: row.id,
      itemId: row.item_id,
      profileId: row.profile_id,
      runId: row.run_id,
      attemptNumber: row.attempt_number,
      renderedText: row.rendered_text,
      phase: row.phase,
      externalId: row.external_id,
      externalUrl: row.external_url,
      reason: row.reason,
      error: parseJson(row.error_json),
      evidence: parseJson(row.evidence_json),
      resolutionAtMs: row.resolution_at_ms,
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
    };
  }

  _getItemRow(id) {
    return this.db.prepare('SELECT * FROM workflow_items WHERE id = ?').get(id);
  }

  createProfile({ name, requestId, legacyPath = null }) {
    const normalizedName = assertNonEmptyString(name, 'name');
    if (legacyPath !== null && typeof legacyPath !== 'string') {
      throw new TypeError('legacyPath must be a string or null');
    }

    return this._mutate(
      'createProfile',
      requestId,
      { name: normalizedName, legacyPath },
      () => {
        if (this.db.prepare('SELECT 1 FROM profiles WHERE name = ?').get(normalizedName)) {
          conflict('PROFILE_NAME_EXISTS', `Profile name already exists: ${normalizedName}`);
        }
        const now = Date.now();
        const profile = {
          id: crypto.randomUUID(),
          name: normalizedName,
          status: 'active',
          legacyPath,
          createdAtMs: now,
          updatedAtMs: now,
        };
        this.db.prepare(`
          INSERT INTO profiles (
            id, name, status, legacy_path, created_at_ms, updated_at_ms, deleted_at_ms
          ) VALUES (?, ?, 'active', ?, ?, ?, NULL)
        `).run(profile.id, profile.name, legacyPath, now, now);
        return profile;
      },
    );
  }

  renameProfile({ profileId, newName, requestId }) {
    const normalizedProfileId = assertNonEmptyString(profileId, 'profileId');
    const normalizedName = assertNonEmptyString(newName, 'newName');
    return this._mutate(
      'renameProfile',
      requestId,
      { profileId: normalizedProfileId, newName: normalizedName },
      () => {
        const current = this.db.prepare('SELECT * FROM profiles WHERE id = ?').get(normalizedProfileId);
        if (!current) conflict('PROFILE_NOT_FOUND', `Unknown profile: ${normalizedProfileId}`);
        if (current.status !== 'active') conflict('PROFILE_NOT_ACTIVE', 'Deleted profiles cannot be renamed');
        const duplicate = this.db.prepare('SELECT id FROM profiles WHERE name = ? AND id <> ?')
          .get(normalizedName, normalizedProfileId);
        if (duplicate) conflict('PROFILE_NAME_EXISTS', `Profile name already exists: ${normalizedName}`);
        const now = Date.now();
        this.db.prepare(`UPDATE profiles SET name = ?, updated_at_ms = ? WHERE id = ? AND status = 'active'`)
          .run(normalizedName, now, normalizedProfileId);
        return {
          id: normalizedProfileId,
          name: normalizedName,
          status: 'active',
          legacyPath: current.legacy_path,
          createdAtMs: current.created_at_ms,
          updatedAtMs: now,
          deletedAtMs: null,
        };
      },
    );
  }

  /**
   * Reactivate a soft-deleted profile, keeping its original UUID.
   *
   * Recreating the name under a fresh UUID would orphan every item the old
   * profile owned, so reuse of a deleted name must restore identity instead.
   */
  restoreProfile({ profileId, requestId }) {
    const normalizedProfileId = assertNonEmptyString(profileId, 'profileId');
    return this._mutate(
      'restoreProfile',
      requestId,
      { profileId: normalizedProfileId },
      () => {
        const current = this.db.prepare('SELECT * FROM profiles WHERE id = ?').get(normalizedProfileId);
        if (!current) conflict('PROFILE_NOT_FOUND', `Unknown profile: ${normalizedProfileId}`);
        const now = Date.now();
        if (current.status === 'active') {
          return {
            id: current.id,
            name: current.name,
            status: 'active',
            legacyPath: current.legacy_path,
            createdAtMs: current.created_at_ms,
            updatedAtMs: current.updated_at_ms,
            deletedAtMs: null,
          };
        }
        this.db.prepare(`
          UPDATE profiles SET status = 'active', deleted_at_ms = NULL, updated_at_ms = ?
          WHERE id = ?
        `).run(now, normalizedProfileId);
        return {
          id: current.id,
          name: current.name,
          status: 'active',
          legacyPath: current.legacy_path,
          createdAtMs: current.created_at_ms,
          updatedAtMs: now,
          deletedAtMs: null,
        };
      },
    );
  }

  softDeleteProfile({ profileId, requestId }) {
    const normalizedProfileId = assertNonEmptyString(profileId, 'profileId');
    return this._mutate(
      'softDeleteProfile',
      requestId,
      { profileId: normalizedProfileId },
      () => {
        const current = this.db.prepare('SELECT * FROM profiles WHERE id = ?').get(normalizedProfileId);
        if (!current) conflict('PROFILE_NOT_FOUND', `Unknown profile: ${normalizedProfileId}`);
        if (current.status !== 'active') conflict('INVALID_STATE', 'Profile is already deleted');
        const now = Date.now();
        this.db.prepare(`
          UPDATE profiles
          SET status = 'deleted', deleted_at_ms = ?, updated_at_ms = ?
          WHERE id = ? AND status = 'active'
        `).run(now, now, normalizedProfileId);
        return {
          id: normalizedProfileId,
          name: current.name,
          status: 'deleted',
          legacyPath: current.legacy_path,
          createdAtMs: current.created_at_ms,
          updatedAtMs: now,
          deletedAtMs: now,
        };
      },
    );
  }

  startRun({ requestId }) {
    return this._mutate('startRun', requestId, {}, () => {
      const now = Date.now();
      const run = {
        id: crypto.randomUUID(),
        status: 'active',
        startedAtMs: now,
        heartbeatAtMs: now,
        finishedAtMs: null,
      };
      this.db.prepare(`
        INSERT INTO workflow_runs (
          id, status, started_at_ms, heartbeat_at_ms, finished_at_ms
        ) VALUES (?, 'active', ?, ?, NULL)
      `).run(run.id, now, now);
      return run;
    });
  }

  finishRun({ runId, status = 'closed', requestId }) {
    const normalizedRunId = assertNonEmptyString(runId, 'runId');
    if (!['closed', 'crashed'].includes(status)) throw new TypeError('status must be closed or crashed');
    return this._mutate('finishRun', requestId, { runId: normalizedRunId, status }, () => {
      const run = this.db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(normalizedRunId);
      if (!run) conflict('RUN_NOT_FOUND', `Unknown workflow run: ${normalizedRunId}`);
      if (run.status !== 'active') conflict('INVALID_STATE', `Cannot finish run from ${run.status}`);
      const now = Date.now();
      this.db.prepare(`
        UPDATE workflow_runs
        SET status = ?, heartbeat_at_ms = ?, finished_at_ms = ?
        WHERE id = ? AND status = 'active'
      `).run(status, now, now, normalizedRunId);
      return {
        id: normalizedRunId,
        status,
        startedAtMs: run.started_at_ms,
        heartbeatAtMs: now,
        finishedAtMs: now,
      };
    });
  }

  enqueue({ items, requestId }) {
    if (!Array.isArray(items)) throw new TypeError('items must be an array');
    const prepared = items.map((payload, index) => {
      const payloadJson = serializeObject(payload, `items[${index}]`);
      if (typeof payload.text !== 'string' || payload.text.trim() === '') {
        validation('INVALID_PAYLOAD', `items[${index}].text must be a non-empty string`);
      }
      if (payload.media_path !== undefined
        && payload.media_path !== null
        && typeof payload.media_path !== 'string') {
        validation('INVALID_MEDIA_PATH', `items[${index}].media_path must be a string or null`);
      }
      return {
        payload,
        payloadJson,
        payloadSha256: sha256(canonicalStringify(payload)),
      };
    });
    const requestPayload = { items: prepared.map((entry) => entry.payload) };
    const replay = this._getReplay('enqueue', requestId, requestPayload);
    if (replay) return replay;

    for (const entry of prepared) {
      entry.media = entry.payload.media_path
        ? [this._stageMedia(entry.payload.media_path)]
        : [];
    }

    return this._mutate(
      'enqueue',
      requestId,
      requestPayload,
      () => {
        const inserted = [];
        for (const entry of prepared) {
          const now = Date.now();
          const id = crypto.randomUUID();
          const queueSeq = this._nextQueueSequence();
          this.db.prepare(`
            INSERT INTO workflow_items (
              id, state, payload_json, payload_sha256, queue_seq, available_at_ms,
              revision, lease_token, lease_owner_run_id, lease_profile_id,
              lease_expires_at_ms, current_attempt_id, last_profile_id,
              pre_dispatch_failure_count, reason, error_json, resolution_json,
              reconciliation_closed_at_ms, created_at_ms, updated_at_ms,
              published_at_ms, discarded_at_ms
            ) VALUES (
              ?, 'queued', ?, ?, ?, ?,
              0, NULL, NULL, NULL,
              NULL, NULL, NULL,
              0, NULL, NULL, NULL,
              NULL, ?, ?,
              NULL, NULL
            )
          `).run(id, entry.payloadJson, entry.payloadSha256, queueSeq, now, now, now);

          entry.media.forEach((media, ordinal) => {
            this.db.prepare(`
              INSERT INTO media_blobs (
                sha256, relative_path, byte_size, status, created_at_ms, verified_at_ms
              ) VALUES (?, ?, ?, 'ready', ?, ?)
              ON CONFLICT(sha256) DO UPDATE SET
                status = 'ready',
                verified_at_ms = excluded.verified_at_ms
              WHERE media_blobs.relative_path = excluded.relative_path
                AND media_blobs.byte_size = excluded.byte_size
            `).run(media.sha256, media.relativePath, media.byteSize, now, now);
            const blob = this.db.prepare(`
              SELECT relative_path, byte_size, status FROM media_blobs WHERE sha256 = ?
            `).get(media.sha256);
            if (!blob
              || blob.relative_path !== media.relativePath
              || blob.byte_size !== media.byteSize
              || blob.status !== 'ready') {
              validation('MEDIA_CORRUPT', 'Managed media metadata conflicts with its content hash', {
                sha256: media.sha256,
              });
            }
            this.db.prepare(`
              INSERT INTO item_media (item_id, ordinal, blob_sha256, original_path)
              VALUES (?, ?, ?, ?)
            `).run(id, ordinal, media.sha256, media.originalPath);
          });

          this._recordEvent(id, 'enqueued', null, 'queued', 0, {
            queueSeq,
            media: entry.media.map((media) => ({ sha256: media.sha256, byteSize: media.byteSize })),
          }, now);
          inserted.push(this._rowToItem(this._getItemRow(id)));
        }
        return { items: inserted };
      },
    );
  }

  listQueued({ after = null, limit = 100 } = {}) {
    this._assertOpen();
    const normalizedLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1_000) : 100;
    const afterSequence = after === null
      ? -1
      : (typeof after === 'object' && after !== null ? after.queueSeq : after);
    if (!Number.isInteger(afterSequence)) throw new TypeError('after must be a queue sequence integer or null');

    const rows = this.db.prepare(`
      SELECT *
      FROM workflow_items
      WHERE state IN ('queued', 'deferred')
        AND available_at_ms <= ?
        AND queue_seq > ?
      ORDER BY queue_seq ASC
      LIMIT ?
    `).all(Date.now(), afterSequence, normalizedLimit);
    return rows.map((row) => this._rowToItem(row));
  }

  getItem(id) {
    this._assertOpen();
    return this._rowToItem(this._getItemRow(assertNonEmptyString(id, 'id')));
  }

  /**
   * Count unresolved dispatches across the WHOLE store.
   *
   * Publishing is irreversible, so any item that crossed the dispatch boundary
   * without a confirmed outcome blocks every further automatic dispatch — for
   * every profile and every run. Ownership is global, never per profile.
   */
  countUnresolvedRecovery() {
    this._assertOpen();
    return this.db.prepare(`
      SELECT COUNT(*) AS total
      FROM workflow_items
      WHERE state IN ('dispatch_started', 'ambiguous')
        AND reconciliation_closed_at_ms IS NULL
    `).get().total;
  }

  /**
   * Extend a lease that is still legitimately owned.
   *
   * Preparation (AI generation, media work) can outlast the initial window. The
   * alternative — losing the lease at the boundary — strands the item, and with
   * the global recovery gate a single stranded item wedges the whole queue.
   */
  renewLease({ id, leaseToken, leaseMs = 60_000 }) {
    const normalizedId = assertNonEmptyString(id, 'id');
    const normalizedLeaseToken = assertNonEmptyString(leaseToken, 'leaseToken');
    if (!Number.isInteger(leaseMs) || leaseMs <= 0) {
      throw new TypeError('leaseMs must be a positive integer');
    }

    return this._immediate(() => {
      const row = this._getItemRow(normalizedId);
      if (!row) conflict('ITEM_NOT_FOUND', `Unknown workflow item: ${normalizedId}`);
      if (row.state !== 'leased') conflict('INVALID_STATE', `Cannot renew a lease from ${row.state}`);
      if (row.lease_token !== normalizedLeaseToken) {
        conflict('LEASE_CONFLICT', 'The lease token does not own this item');
      }
      // The owning run must still be alive, otherwise this is a zombie worker.
      const run = this.db.prepare('SELECT status FROM workflow_runs WHERE id = ?')
        .get(row.lease_owner_run_id);
      if (!run || run.status !== 'active') {
        conflict('RUN_NOT_ACTIVE', 'The owning run is no longer active; the lease cannot be renewed');
      }

      const now = Date.now();
      const expiresAt = now + leaseMs;
      const result = this.db.prepare(`
        UPDATE workflow_items
        SET lease_expires_at_ms = ?, updated_at_ms = ?
        WHERE id = ? AND state = 'leased' AND lease_token = ?
      `).run(expiresAt, now, normalizedId, normalizedLeaseToken);
      if (result.changes !== 1) conflict('LEASE_CONFLICT', 'The lease changed before it could be renewed');
      this.db.prepare(`
        UPDATE workflow_runs SET heartbeat_at_ms = ? WHERE id = ? AND status = 'active'
      `).run(now, row.lease_owner_run_id);
      return { id: normalizedId, leaseToken: normalizedLeaseToken, leaseExpiresAtMs: expiresAt };
    });
  }

  /**
   * Return expired pre-dispatch leases to the queue.
   *
   * This is strictly pre-boundary: a 'leased' item never reached the transport,
   * so requeueing it cannot duplicate a post. A grace period protects leases
   * whose renewal is merely running late.
   */
  reclaimExpiredLeases({ requestId, graceMs = 30_000 }) {
    if (!Number.isInteger(graceMs) || graceMs < 0) {
      throw new TypeError('graceMs must be a non-negative integer');
    }
    return this._mutate('reclaimExpiredLeases', requestId, { graceMs }, () => {
      const now = Date.now();
      // An EXPIRED lease is pre-boundary by definition: state='leased' means
      // beginDispatch never committed, so requeueing cannot duplicate a post.
      // Run liveness is therefore irrelevant — the common real case is a live
      // run whose worker died at the boundary or blocked past the window. A
      // grace period keeps a merely-slow renewal from being stolen.
      const rows = this.db.prepare(`
        SELECT * FROM workflow_items
        WHERE state = 'leased'
          AND lease_expires_at_ms IS NOT NULL
          AND lease_expires_at_ms <= ?
        ORDER BY updated_at_ms ASC, id ASC
      `).all(now - graceMs);

      const reclaimedIds = [];
      for (const row of rows) {
        const queueSeq = this._nextQueueSequence();
        const nextRevision = row.revision + 1;
        const result = this.db.prepare(`
          UPDATE workflow_items
          SET state = 'queued', queue_seq = ?, available_at_ms = ?,
              lease_token = NULL, lease_owner_run_id = NULL, lease_profile_id = NULL,
              lease_expires_at_ms = NULL, reason = 'reclaimed_expired_lease',
              revision = ?, updated_at_ms = ?
          WHERE id = ? AND state = 'leased' AND revision = ?
        `).run(queueSeq, now, nextRevision, now, row.id, row.revision);
        if (result.changes !== 1) continue;
        this._recordEvent(
          row.id,
          'expired_lease_reclaimed',
          'leased',
          'queued',
          nextRevision,
          { queueSeq, previousRunId: row.lease_owner_run_id },
          now,
        );
        reclaimedIds.push(row.id);
      }
      return { reclaimedIds };
    });
  }

  leaseNext({ profileId, runId, leaseMs = 60_000, allowUnresolvedRecovery = false }) {
    const normalizedProfileId = assertNonEmptyString(profileId, 'profileId');
    const normalizedRunId = assertNonEmptyString(runId, 'runId');
    if (!Number.isInteger(leaseMs) || leaseMs <= 0) {
      throw new TypeError('leaseMs must be a positive integer');
    }
    if (typeof allowUnresolvedRecovery !== 'boolean') {
      throw new TypeError('allowUnresolvedRecovery must be a boolean');
    }

    return this._immediate(() => {
      const profile = this.db.prepare('SELECT status FROM profiles WHERE id = ?').get(normalizedProfileId);
      if (!profile || profile.status !== 'active') {
        conflict('PROFILE_NOT_ACTIVE', 'The requested profile does not exist or is not active');
      }
      const run = this.db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(normalizedRunId);
      if (!run || run.status !== 'active') {
        conflict('RUN_NOT_ACTIVE', 'The requested workflow run does not exist or is not active');
      }

      // Global recovery gate, inside the same IMMEDIATE transaction as the CAS
      // so a concurrent ambiguity cannot slip in between check and lease.
      //
      // allowUnresolvedRecovery is ONLY for offline bulk import (legacy
      // migration), which reconstructs historical states and never calls a
      // transport. Live dispatch must never set it.
      if (!allowUnresolvedRecovery) {
        const unresolved = this.db.prepare(`
          SELECT id FROM workflow_items
          WHERE state IN ('dispatch_started', 'ambiguous')
            AND reconciliation_closed_at_ms IS NULL
          ORDER BY updated_at_ms ASC
          LIMIT 1
        `).get();
        if (unresolved) {
          conflict(
            'RECOVERY_REQUIRED',
            'An unresolved dispatch must be reconciled before any further publishing',
            { unresolvedItemId: unresolved.id },
          );
        }
      }

      const now = Date.now();
      const row = this.db.prepare(`
        SELECT *
        FROM workflow_items
        WHERE state IN ('queued', 'deferred')
          AND available_at_ms <= ?
        ORDER BY queue_seq ASC
        LIMIT 1
      `).get(now);
      if (!row) return null;

      const leaseToken = crypto.randomUUID();
      const nextRevision = row.revision + 1;
      const result = this.db.prepare(`
        UPDATE workflow_items
        SET state = 'leased',
            queue_seq = NULL,
            queue_seq_before_lease = ?,
            available_at_ms = NULL,
            lease_token = ?,
            lease_owner_run_id = ?,
            lease_profile_id = ?,
            lease_expires_at_ms = ?,
            last_profile_id = ?,
            reason = NULL,
            error_json = NULL,
            resolution_json = NULL,
            reconciliation_closed_at_ms = NULL,
            revision = ?,
            updated_at_ms = ?
        WHERE id = ? AND state = ? AND revision = ?
      `).run(
        row.queue_seq,
        leaseToken,
        normalizedRunId,
        normalizedProfileId,
        now + leaseMs,
        normalizedProfileId,
        nextRevision,
        now,
        row.id,
        row.state,
        row.revision,
      );
      if (result.changes !== 1) conflict('LEASE_CONFLICT', 'The queue item changed before it could be leased');

      this.db.prepare(`
        UPDATE workflow_runs SET heartbeat_at_ms = ? WHERE id = ? AND status = 'active'
      `).run(now, normalizedRunId);
      this._recordEvent(
        row.id,
        'leased',
        row.state,
        'leased',
        nextRevision,
        { leaseToken, profileId: normalizedProfileId, runId: normalizedRunId },
        now,
      );
      return this._rowToItem(this._getItemRow(row.id));
    });
  }

  /**
   * Retire an item that has exhausted its pre-dispatch failure budget.
   *
   * Called after a failure is recorded, inside the same transaction. This is
   * strictly pre-boundary, so retiring can never hide a published post — it
   * only stops a poison item from cycling through the queue forever.
   */
  _retireIfExhausted(itemId, now) {
    const row = this._getItemRow(itemId);
    if (!row) return null;
    if (row.state !== 'queued' && row.state !== 'deferred') return null;
    if (row.pre_dispatch_failure_count < this.maxPreDispatchFailures) return null;

    const nextRevision = row.revision + 1;
    const update = this.db.prepare(`
      UPDATE workflow_items
      SET state = 'dead', queue_seq = NULL, available_at_ms = NULL,
          reason = 'exhausted_pre_dispatch_attempts',
          revision = ?, updated_at_ms = ?
      WHERE id = ? AND state = ? AND revision = ?
    `).run(nextRevision, now, itemId, row.state, row.revision);
    if (update.changes !== 1) return null;

    this._recordEvent(
      itemId,
      'retired_exhausted',
      row.state,
      'dead',
      nextRevision,
      { failureCount: row.pre_dispatch_failure_count, limit: this.maxPreDispatchFailures },
      now,
    );
    return this._rowToItem(this._getItemRow(itemId));
  }

  releasePreDispatch({ id, leaseToken, reason, error = null, countAsFailure = true, requestId }) {
    const normalizedId = assertNonEmptyString(id, 'id');
    const normalizedLeaseToken = assertNonEmptyString(leaseToken, 'leaseToken');
    const normalizedReason = assertNonEmptyString(reason, 'reason');
    if (typeof countAsFailure !== 'boolean') throw new TypeError('countAsFailure must be a boolean');
    return this._mutate(
      'releasePreDispatch',
      requestId,
      {
        id: normalizedId,
        leaseToken: normalizedLeaseToken,
        reason: normalizedReason,
        error,
        countAsFailure,
      },
      () => {
        const row = this._getItemRow(normalizedId);
        if (!row) conflict('ITEM_NOT_FOUND', `Unknown workflow item: ${normalizedId}`);
        if (row.state !== 'leased') conflict('INVALID_STATE', `Cannot release item from ${row.state}`);
        if (row.lease_token !== normalizedLeaseToken) conflict('LEASE_CONFLICT', 'The lease token does not own this item');
        const now = Date.now();
        // An operator action (Stop, guard refusal) must not reorder the user's
        // queue: the post never went out, so it keeps its original position.
        // A genuine pre-dispatch failure goes to the back instead, so a bad
        // post cannot block the head of the queue run after run.
        const queueSeq = countAsFailure ? this._nextQueueSequence() : row.queue_seq_before_lease;
        const effectiveSeq = Number.isInteger(queueSeq) ? queueSeq : this._nextQueueSequence();
        const nextRevision = row.revision + 1;
        const result = this.db.prepare(`
          UPDATE workflow_items
          SET state = 'queued', queue_seq = ?, available_at_ms = ?,
              queue_seq_before_lease = NULL,
              lease_token = NULL, lease_owner_run_id = NULL, lease_profile_id = NULL,
              lease_expires_at_ms = NULL, reason = ?, error_json = ?,
              pre_dispatch_failure_count = pre_dispatch_failure_count + ?,
              revision = ?, updated_at_ms = ?
          WHERE id = ? AND state = 'leased' AND revision = ? AND lease_token = ?
        `).run(
          effectiveSeq,
          now,
          normalizedReason,
          optionalJson(error),
          countAsFailure ? 1 : 0,
          nextRevision,
          now,
          normalizedId,
          row.revision,
          normalizedLeaseToken,
        );
        if (result.changes !== 1) conflict('LEASE_CONFLICT', 'The lease changed before it could be released');
        this._recordEvent(
          normalizedId,
          'released_pre_dispatch',
          'leased',
          'queued',
          nextRevision,
          { queueSeq, reason: normalizedReason, error, countAsFailure },
          now,
        );
        // A failure budget is only meaningful if it is enforced.
        const retired = countAsFailure ? this._retireIfExhausted(normalizedId, now) : null;
        return retired || this._rowToItem(this._getItemRow(normalizedId));
      },
    );
  }

  markDeferred({
    id,
    leaseToken,
    reason,
    error = null,
    availableAtMs = null,
    requestId,
  }) {
    const normalizedId = assertNonEmptyString(id, 'id');
    const normalizedLeaseToken = assertNonEmptyString(leaseToken, 'leaseToken');
    const normalizedReason = assertNonEmptyString(reason, 'reason');
    if (availableAtMs !== null && (!Number.isInteger(availableAtMs) || availableAtMs < 0)) {
      throw new TypeError('availableAtMs must be a non-negative integer or null');
    }
    return this._mutate(
      'markDeferred',
      requestId,
      // Keep the request payload free of wall-clock defaults, otherwise two
      // identical replays hash differently and idempotent retry breaks.
      { id: normalizedId, leaseToken: normalizedLeaseToken, reason: normalizedReason, error, availableAtMs },
      () => {
        const row = this._getItemRow(normalizedId);
        if (!row) conflict('ITEM_NOT_FOUND', `Unknown workflow item: ${normalizedId}`);
        if (row.state !== 'leased') conflict('INVALID_STATE', `Cannot defer item from ${row.state}`);
        if (row.lease_token !== normalizedLeaseToken) conflict('LEASE_CONFLICT', 'The lease token does not own this item');
        const now = Date.now();
        const effectiveAvailableAt = availableAtMs === null ? now : availableAtMs;
        const queueSeq = this._nextQueueSequence();
        const nextRevision = row.revision + 1;
        const result = this.db.prepare(`
          UPDATE workflow_items
          SET state = 'deferred', queue_seq = ?, available_at_ms = ?,
              lease_token = NULL, lease_owner_run_id = NULL, lease_profile_id = NULL,
              lease_expires_at_ms = NULL, reason = ?, error_json = ?,
              pre_dispatch_failure_count = pre_dispatch_failure_count + 1,
              revision = ?, updated_at_ms = ?
          WHERE id = ? AND state = 'leased' AND revision = ? AND lease_token = ?
        `).run(
          queueSeq,
          effectiveAvailableAt,
          normalizedReason,
          optionalJson(error),
          nextRevision,
          now,
          normalizedId,
          row.revision,
          normalizedLeaseToken,
        );
        if (result.changes !== 1) conflict('LEASE_CONFLICT', 'The lease changed before it could be deferred');
        this._recordEvent(
          normalizedId,
          'deferred',
          'leased',
          'deferred',
          nextRevision,
          { queueSeq, availableAtMs: effectiveAvailableAt, reason: normalizedReason, error },
          now,
        );
        const retired = this._retireIfExhausted(normalizedId, now);
        return retired || this._rowToItem(this._getItemRow(normalizedId));
      },
    );
  }

  markTerminal({ id, leaseToken, reason, error = null, requestId }) {
    const normalizedId = assertNonEmptyString(id, 'id');
    const normalizedLeaseToken = assertNonEmptyString(leaseToken, 'leaseToken');
    const normalizedReason = assertNonEmptyString(reason, 'reason');
    return this._mutate(
      'markTerminal',
      requestId,
      { id: normalizedId, leaseToken: normalizedLeaseToken, reason: normalizedReason, error },
      () => {
        const row = this._getItemRow(normalizedId);
        if (!row) conflict('ITEM_NOT_FOUND', `Unknown workflow item: ${normalizedId}`);
        if (row.state !== 'leased') conflict('INVALID_STATE', `Cannot terminate item from ${row.state}`);
        if (row.lease_token !== normalizedLeaseToken) conflict('LEASE_CONFLICT', 'The lease token does not own this item');
        const now = Date.now();
        const nextRevision = row.revision + 1;
        const result = this.db.prepare(`
          UPDATE workflow_items
          SET state = 'dead', lease_token = NULL, lease_owner_run_id = NULL,
              lease_profile_id = NULL, lease_expires_at_ms = NULL,
              reason = ?, error_json = ?, revision = ?, updated_at_ms = ?
          WHERE id = ? AND state = 'leased' AND revision = ? AND lease_token = ?
        `).run(
          normalizedReason,
          optionalJson(error),
          nextRevision,
          now,
          normalizedId,
          row.revision,
          normalizedLeaseToken,
        );
        if (result.changes !== 1) conflict('LEASE_CONFLICT', 'The lease changed before it could become terminal');
        this._recordEvent(
          normalizedId,
          'terminal',
          'leased',
          'dead',
          nextRevision,
          { reason: normalizedReason, error },
          now,
        );
        return this._rowToItem(this._getItemRow(normalizedId));
      },
    );
  }

  beginDispatch({ id, leaseToken, renderedText, requestId, allowUnresolvedRecovery = false }) {
    const normalizedId = assertNonEmptyString(id, 'id');
    const normalizedLeaseToken = assertNonEmptyString(leaseToken, 'leaseToken');
    if (typeof renderedText !== 'string') throw new TypeError('renderedText must be a string');
    if (typeof allowUnresolvedRecovery !== 'boolean') {
      throw new TypeError('allowUnresolvedRecovery must be a boolean');
    }

    return this._mutate(
      'beginDispatch',
      requestId,
      { id: normalizedId, leaseToken: normalizedLeaseToken, renderedText },
      () => {
        const row = this._getItemRow(normalizedId);
        if (!row) conflict('ITEM_NOT_FOUND', `Unknown workflow item: ${normalizedId}`);
        if (row.state !== 'leased') {
          conflict('INVALID_STATE', `Cannot begin dispatch from state ${row.state}`);
        }
        if (row.lease_token !== normalizedLeaseToken) {
          conflict('LEASE_CONFLICT', 'The lease token does not own this item');
        }

        const now = Date.now();
        if (row.lease_expires_at_ms <= now) {
          conflict('LEASE_EXPIRED', 'The lease expired before dispatch could begin');
        }

        // Re-check the GLOBAL recovery gate at the boundary itself.
        //
        // Gating only leaseNext is insufficient: a worker that leased BEFORE an
        // ambiguity appeared is already holding a valid lease and would sail
        // across the irreversible boundary. Excluding this item's own row keeps
        // a legitimate retry of the same item possible.
        const unresolvedOther = allowUnresolvedRecovery ? null : this.db.prepare(`
          SELECT id FROM workflow_items
          WHERE state IN ('dispatch_started', 'ambiguous')
            AND reconciliation_closed_at_ms IS NULL
            AND id <> ?
          ORDER BY updated_at_ms ASC
          LIMIT 1
        `).get(normalizedId);
        if (unresolvedOther) {
          conflict(
            'RECOVERY_REQUIRED',
            'An unresolved dispatch must be reconciled before any further publishing',
            { unresolvedItemId: unresolvedOther.id },
          );
        }

        // The store must be healthy AT the boundary.
        //
        // integrityCheck() hashes every managed media file, so it cannot run per
        // post. It runs at startup and between runs, and latches its verdict
        // here — a single metadata read inside the same transaction. Without
        // this, a store that fails its own integrity check kept handing out
        // leases and kept committing dispatches: the app published from a
        // database it already knew was damaged, and said nothing.
        const gate = this._readHealthGate();
        if (gate.blocked) {
          conflict(
            'STORE_UNHEALTHY',
            `Publishing is blocked: the durable store failed its health check (${gate.reason})`,
            { reason: gate.reason, checkedAtMs: gate.checkedAtMs },
          );
        }

        // The owning run and profile must still be alive AT the boundary. A Stop
        // or profile deletion that wins during preparation must prevent the
        // irreversible action, not merely be ignored.
        const owningRun = this.db.prepare('SELECT status FROM workflow_runs WHERE id = ?')
          .get(row.lease_owner_run_id);
        if (!owningRun || owningRun.status !== 'active') {
          conflict('RUN_NOT_ACTIVE', 'The owning run is no longer active; dispatch is refused');
        }
        const owningProfile = this.db.prepare('SELECT status FROM profiles WHERE id = ?')
          .get(row.lease_profile_id);
        if (!owningProfile || owningProfile.status !== 'active') {
          conflict('PROFILE_NOT_ACTIVE', 'The owning profile is no longer active; dispatch is refused');
        }

        // Managed media must still match the bytes recorded at enqueue time.
        // A locally provable corruption is a pre-boundary failure, never a
        // post-boundary ambiguity, and must never publish wrong bytes.
        this._assertMediaIntegrity(normalizedId);

        const attemptNumber = this.db.prepare(`
          SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next_number
          FROM dispatch_attempts
          WHERE item_id = ?
        `).get(normalizedId).next_number;
        const attemptId = crypto.randomUUID();
        this.db.prepare(`
          INSERT INTO dispatch_attempts (
            id, item_id, profile_id, run_id, attempt_number, rendered_text,
            payload_sha256, phase, external_id, external_url, reason,
            error_json, evidence_json, resolution_at_ms, created_at_ms, updated_at_ms
          ) VALUES (
            ?, ?, ?, ?, ?, ?,
            ?, 'started', NULL, NULL, NULL,
            NULL, NULL, NULL, ?, ?
          )
        `).run(
          attemptId,
          normalizedId,
          row.lease_profile_id,
          row.lease_owner_run_id,
          attemptNumber,
          renderedText,
          row.payload_sha256,
          now,
          now,
        );

        const nextRevision = row.revision + 1;
        const update = this.db.prepare(`
          UPDATE workflow_items
          SET state = 'dispatch_started',
              lease_token = NULL,
              lease_owner_run_id = NULL,
              lease_profile_id = NULL,
              lease_expires_at_ms = NULL,
              current_attempt_id = ?,
              revision = ?,
              updated_at_ms = ?
          WHERE id = ? AND state = 'leased' AND revision = ? AND lease_token = ?
        `).run(attemptId, nextRevision, now, normalizedId, row.revision, normalizedLeaseToken);
        if (update.changes !== 1) {
          conflict('LEASE_CONFLICT', 'The lease changed before dispatch could begin');
        }

        this._recordEvent(
          normalizedId,
          'dispatch_started',
          'leased',
          'dispatch_started',
          nextRevision,
          { attemptId, renderedText },
          now,
        );
        return {
          attemptId,
          id: normalizedId,
          state: 'dispatch_started',
          revision: nextRevision,
        };
      },
    );
  }

  markAmbiguous({ attemptId, reason, error = null, evidence = null, requestId }) {
    const normalizedAttemptId = assertNonEmptyString(attemptId, 'attemptId');
    const normalizedReason = assertNonEmptyString(reason, 'reason');
    const errorJson = optionalJson(error);
    const evidenceJson = optionalJson(evidence);

    return this._mutate(
      'markAmbiguous',
      requestId,
      { attemptId: normalizedAttemptId, reason: normalizedReason, error, evidence },
      () => {
        const attempt = this.db.prepare(`
          SELECT a.*, i.state AS item_state, i.revision AS item_revision,
                 i.current_attempt_id AS item_current_attempt_id
          FROM dispatch_attempts a
          JOIN workflow_items i ON i.id = a.item_id
          WHERE a.id = ?
        `).get(normalizedAttemptId);
        if (!attempt) conflict('ATTEMPT_NOT_FOUND', `Unknown dispatch attempt: ${normalizedAttemptId}`);
        if (attempt.phase !== 'started'
          || attempt.item_state !== 'dispatch_started'
          || attempt.item_current_attempt_id !== normalizedAttemptId) {
          conflict('INVALID_STATE', 'Only the current started dispatch can become ambiguous');
        }

        const now = Date.now();
        this.db.prepare(`
          UPDATE dispatch_attempts
          SET phase = 'ambiguous', reason = ?, error_json = ?, evidence_json = ?, updated_at_ms = ?
          WHERE id = ? AND phase = 'started'
        `).run(normalizedReason, errorJson, evidenceJson, now, normalizedAttemptId);

        const nextRevision = attempt.item_revision + 1;
        const update = this.db.prepare(`
          UPDATE workflow_items
          SET state = 'ambiguous', reason = ?, error_json = ?,
              resolution_json = NULL, reconciliation_closed_at_ms = NULL,
              revision = ?, updated_at_ms = ?
          WHERE id = ? AND state = 'dispatch_started'
            AND revision = ? AND current_attempt_id = ?
        `).run(
          normalizedReason,
          errorJson,
          nextRevision,
          now,
          attempt.item_id,
          attempt.item_revision,
          normalizedAttemptId,
        );
        if (update.changes !== 1) conflict('STATE_CONFLICT', 'The item changed while marking it ambiguous');

        this._recordEvent(
          attempt.item_id,
          'dispatch_ambiguous',
          'dispatch_started',
          'ambiguous',
          nextRevision,
          { attemptId: normalizedAttemptId, reason: normalizedReason, error, evidence },
          now,
        );
        return this._rowToItem(this._getItemRow(attempt.item_id));
      },
    );
  }

  markPublished({ attemptId, externalId = null, externalUrl = null, evidence = null, requestId }) {
    const normalizedAttemptId = assertNonEmptyString(attemptId, 'attemptId');
    if (externalId !== null && typeof externalId !== 'string') throw new TypeError('externalId must be a string or null');
    if (externalUrl !== null && typeof externalUrl !== 'string') throw new TypeError('externalUrl must be a string or null');
    // Defense in depth: publishing is an irreversible tombstone, so the store
    // itself refuses it without authoritative proof — not only the orchestrator.
    // Manual recovery paths call this directly.
    const trimmedId = typeof externalId === 'string' ? externalId.trim() : '';
    const trimmedUrl = typeof externalUrl === 'string' ? externalUrl.trim() : '';
    if (trimmedId.length === 0 && trimmedUrl.length === 0) {
      conflict(
        'PROOF_REQUIRED',
        'Marking an item published requires a non-empty externalId or externalUrl',
      );
    }
    externalId = trimmedId.length > 0 ? trimmedId : null;
    externalUrl = trimmedUrl.length > 0 ? trimmedUrl : null;
    const evidenceJson = optionalJson(evidence);

    return this._mutate(
      'markPublished',
      requestId,
      { attemptId: normalizedAttemptId, externalId, externalUrl, evidence },
      () => {
        const attempt = this.db.prepare(`
          SELECT a.*, i.state AS item_state, i.revision AS item_revision,
                 i.current_attempt_id AS item_current_attempt_id
          FROM dispatch_attempts a
          JOIN workflow_items i ON i.id = a.item_id
          WHERE a.id = ?
        `).get(normalizedAttemptId);
        if (!attempt) conflict('ATTEMPT_NOT_FOUND', `Unknown dispatch attempt: ${normalizedAttemptId}`);
        const validPair = (
          attempt.phase === 'started' && attempt.item_state === 'dispatch_started'
        ) || (
          attempt.phase === 'ambiguous' && attempt.item_state === 'ambiguous'
        );
        if (!validPair || attempt.item_current_attempt_id !== normalizedAttemptId) {
          conflict('INVALID_STATE', 'Only the current started or ambiguous attempt can be published');
        }

        const now = Date.now();
        this.db.prepare(`
          UPDATE dispatch_attempts
          SET phase = 'published', external_id = ?, external_url = ?, evidence_json = ?,
              resolution_at_ms = ?, updated_at_ms = ?
          WHERE id = ? AND phase = ?
        `).run(externalId, externalUrl, evidenceJson, now, now, normalizedAttemptId, attempt.phase);

        const nextRevision = attempt.item_revision + 1;
        const update = this.db.prepare(`
          UPDATE workflow_items
          SET state = 'published', published_at_ms = ?, reason = NULL,
              error_json = NULL, resolution_json = ?,
              reconciliation_closed_at_ms = NULL, revision = ?, updated_at_ms = ?
          WHERE id = ? AND state = ? AND revision = ? AND current_attempt_id = ?
        `).run(
          now,
          canonicalStringify({ externalId, externalUrl, evidence }),
          nextRevision,
          now,
          attempt.item_id,
          attempt.item_state,
          attempt.item_revision,
          normalizedAttemptId,
        );
        if (update.changes !== 1) conflict('STATE_CONFLICT', 'The item changed while marking it published');

        this._recordEvent(
          attempt.item_id,
          'published',
          attempt.item_state,
          'published',
          nextRevision,
          { attemptId: normalizedAttemptId, externalId, externalUrl, evidence },
          now,
        );
        return this._rowToItem(this._getItemRow(attempt.item_id));
      },
    );
  }

  listRecovery({ includeClosed = false } = {}) {
    this._assertOpen();
    const rows = this.db.prepare(`
      SELECT *
      FROM workflow_items
      WHERE state IN ('dispatch_started', 'ambiguous')
        AND (? = 1 OR reconciliation_closed_at_ms IS NULL)
      ORDER BY updated_at_ms ASC, id ASC
    `).all(includeClosed ? 1 : 0);
    return rows.map((row) => this._rowToItem(row));
  }

  /**
   * Resolve one unresolved recovery item.
   *
   * `expectedRevision` is optional but strongly preferred from the UI: the
   * operator decides from a rendered list, and between the render and the click
   * a reconciliation pass or a second window may have moved the row. Passing
   * the revision that was on screen turns "apply to whatever is there now" into
   * "apply to exactly what I reviewed, or refuse".
   */
  resolveRecovery({
    id,
    action,
    confirmedNotPublished = false,
    evidence = null,
    expectedRevision = null,
    requestId,
  }) {
    const normalizedId = assertNonEmptyString(id, 'id');
    const normalizedAction = assertNonEmptyString(action, 'action');
    if (expectedRevision !== null
      && (!Number.isInteger(expectedRevision) || expectedRevision < 0)) {
      throw new TypeError('expectedRevision must be a non-negative integer or null');
    }

    return this._mutate(
      'resolveRecovery',
      requestId,
      { id: normalizedId, action: normalizedAction, confirmedNotPublished, evidence, expectedRevision },
      () => {
        const row = this._getItemRow(normalizedId);
        if (!row) conflict('ITEM_NOT_FOUND', `Unknown workflow item: ${normalizedId}`);
        if (row.state !== 'ambiguous') {
          conflict('INVALID_STATE', `Cannot resolve recovery from state ${row.state}`);
        }
        if (expectedRevision !== null && row.revision !== expectedRevision) {
          conflict('REVISION_CONFLICT', 'The recovery item changed since it was reviewed');
        }

        if (normalizedAction === 'close') {
          const now = Date.now();
          const nextRevision = row.revision + 1;
          const update = this.db.prepare(`
            UPDATE workflow_items
            SET reconciliation_closed_at_ms = ?, resolution_json = ?,
                revision = ?, updated_at_ms = ?
            WHERE id = ? AND state = 'ambiguous' AND revision = ?
          `).run(
            now,
            canonicalStringify({ action: 'close', evidence }),
            nextRevision,
            now,
            normalizedId,
            row.revision,
          );
          if (update.changes !== 1) conflict('STATE_CONFLICT', 'The recovery item changed before review could close');
          this._recordEvent(
            normalizedId,
            'recovery_review_closed',
            'ambiguous',
            'ambiguous',
            nextRevision,
            { evidence },
            now,
          );
          return this._rowToItem(this._getItemRow(normalizedId));
        }

        if (normalizedAction !== 'requeue') {
          conflict('UNSUPPORTED_RECOVERY_ACTION', `Unsupported recovery action: ${normalizedAction}`);
        }
        if (confirmedNotPublished !== true) {
          conflict(
            'CONFIRMATION_REQUIRED',
            'Requeueing an ambiguous item requires confirmedNotPublished=true',
          );
        }

        const attempt = this.db.prepare(`
          SELECT * FROM dispatch_attempts WHERE id = ? AND item_id = ?
        `).get(row.current_attempt_id, normalizedId);
        if (!attempt || attempt.phase !== 'ambiguous') {
          conflict('INVALID_STATE', 'The ambiguous item has no matching unresolved attempt');
        }

        const now = Date.now();
        const queueSeq = this._nextQueueSequence(now);
        this.db.prepare(`
          UPDATE dispatch_attempts
          SET phase = 'confirmed_not_published', evidence_json = ?,
              resolution_at_ms = ?, updated_at_ms = ?
          WHERE id = ? AND phase = 'ambiguous'
        `).run(optionalJson(evidence), now, now, attempt.id);

        const nextRevision = row.revision + 1;
        const update = this.db.prepare(`
          UPDATE workflow_items
          SET state = 'queued', queue_seq = ?, available_at_ms = ?,
              current_attempt_id = NULL, reason = NULL, error_json = NULL,
              resolution_json = ?, reconciliation_closed_at_ms = NULL,
              revision = ?, updated_at_ms = ?
          WHERE id = ? AND state = 'ambiguous' AND revision = ?
            AND current_attempt_id = ?
        `).run(
          queueSeq,
          now,
          canonicalStringify({ action: 'requeue', confirmedNotPublished: true, evidence }),
          nextRevision,
          now,
          normalizedId,
          row.revision,
          attempt.id,
        );
        if (update.changes !== 1) conflict('STATE_CONFLICT', 'The recovery item changed before it could be requeued');

        this._recordEvent(
          normalizedId,
          'recovery_requeued',
          'ambiguous',
          'queued',
          nextRevision,
          { attemptId: attempt.id, queueSeq, confirmedNotPublished: true, evidence },
          now,
        );
        return this._rowToItem(this._getItemRow(normalizedId));
      },
    );
  }

  discardQueued({ id, expectedRevision, requestId }) {
    const normalizedId = assertNonEmptyString(id, 'id');
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new TypeError('expectedRevision must be a non-negative integer');
    }

    return this._mutate(
      'discardQueued',
      requestId,
      { id: normalizedId, expectedRevision },
      () => {
        const row = this._getItemRow(normalizedId);
        if (!row) conflict('ITEM_NOT_FOUND', `Unknown workflow item: ${normalizedId}`);
        // Deferred items are still user-visible backlog; the schema allows
        // deferred -> discarded, so the API must too.
        //
        // `dead` belongs here for the same reason. The schema has always
        // permitted dead -> discarded, but this method refused it, and it is
        // the only discard the store exposes — so the delete button on a dead
        // letter in the recovery panel could never succeed. It routed through
        // resolveRecovery(), which accepts `ambiguous` only, and raised
        // "Cannot resolve recovery from state dead" at the operator every
        // time. A dead letter failed BEFORE the boundary and was never sent,
        // so discarding it cannot lose a published post.
        if (!DISCARDABLE_STATES.has(row.state)) {
          conflict('INVALID_STATE', `Cannot discard an item in state ${row.state}`);
        }
        if (row.revision !== expectedRevision) {
          conflict('REVISION_CONFLICT', 'The queue item revision no longer matches');
        }

        const now = Date.now();
        const nextRevision = row.revision + 1;
        const update = this.db.prepare(`
          UPDATE workflow_items
          SET state = 'discarded', queue_seq = NULL, available_at_ms = NULL,
              reason = 'discarded_by_user', discarded_at_ms = ?,
              revision = ?, updated_at_ms = ?
          WHERE id = ? AND state = ? AND revision = ?
        `).run(now, nextRevision, now, normalizedId, row.state, expectedRevision);
        if (update.changes !== 1) conflict('STATE_CONFLICT', 'The queue item changed before it could be discarded');

        this._recordEvent(
          normalizedId,
          'discarded',
          row.state,
          'discarded',
          nextRevision,
          { expectedRevision },
          now,
        );
        return this._rowToItem(this._getItemRow(normalizedId));
      },
    );
  }

  /**
   * Return a dead-lettered item to the queue.
   *
   * A 'dead' item failed BEFORE the dispatch boundary, so it was never sent and
   * requeueing it cannot duplicate a post. The failure budget is reset so the
   * retry gets a fair chance rather than dying again immediately.
   */
  requeueTerminal({ id, expectedRevision, requestId }) {
    const normalizedId = assertNonEmptyString(id, 'id');
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new TypeError('expectedRevision must be a non-negative integer');
    }
    return this._mutate(
      'requeueTerminal',
      requestId,
      { id: normalizedId, expectedRevision },
      () => {
        const row = this._getItemRow(normalizedId);
        if (!row) conflict('ITEM_NOT_FOUND', `Unknown workflow item: ${normalizedId}`);
        if (row.state !== 'dead') {
          conflict('INVALID_STATE', `Only a dead item can be requeued, got ${row.state}`);
        }
        if (row.revision !== expectedRevision) {
          conflict('REVISION_CONFLICT', 'The item revision no longer matches');
        }

        const now = Date.now();
        const queueSeq = this._nextQueueSequence();
        const nextRevision = row.revision + 1;
        const update = this.db.prepare(`
          UPDATE workflow_items
          SET state = 'queued', queue_seq = ?, available_at_ms = ?,
              reason = 'requeued_from_dead', error_json = NULL,
              pre_dispatch_failure_count = 0,
              revision = ?, updated_at_ms = ?
          WHERE id = ? AND state = 'dead' AND revision = ?
        `).run(queueSeq, now, nextRevision, now, normalizedId, expectedRevision);
        if (update.changes !== 1) conflict('STATE_CONFLICT', 'The item changed before it could be requeued');

        this._recordEvent(
          normalizedId,
          'requeued_from_dead',
          'dead',
          'queued',
          nextRevision,
          { queueSeq },
          now,
        );
        return this._rowToItem(this._getItemRow(normalizedId));
      },
    );
  }

  listItems({ states = [...ITEM_STATES], limit = 100, after = null, afterUpdatedAtMs = null } = {}) {
    this._assertOpen();
    if (!Array.isArray(states) || states.length === 0 || states.some((state) => !ITEM_STATES.has(state))) {
      throw new TypeError('states must be a non-empty array of valid workflow states');
    }
    const normalizedLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 10_000) : 100;
    const placeholders = states.map(() => '?').join(', ');

    // Composite keyset cursor: a bare timestamp cursor silently skips every row
    // that shares the boundary timestamp, which is common for bulk enqueues.
    let cursor = null;
    if (after !== null && after !== undefined) {
      if (typeof after !== 'object' || !Number.isInteger(after.updatedAtMs) || typeof after.id !== 'string') {
        throw new TypeError('after must be { updatedAtMs: integer, id: string }');
      }
      cursor = after;
    } else if (afterUpdatedAtMs !== null) {
      if (!Number.isInteger(afterUpdatedAtMs)) throw new TypeError('afterUpdatedAtMs must be an integer or null');
      cursor = { updatedAtMs: afterUpdatedAtMs, id: '' };
    }

    const rows = cursor === null
      ? this.db.prepare(`
        SELECT * FROM workflow_items
        WHERE state IN (${placeholders})
        ORDER BY updated_at_ms ASC, id ASC
        LIMIT ?
      `).all(...states, normalizedLimit)
      : this.db.prepare(`
        SELECT * FROM workflow_items
        WHERE state IN (${placeholders})
          AND (updated_at_ms > ? OR (updated_at_ms = ? AND id > ?))
        ORDER BY updated_at_ms ASC, id ASC
        LIMIT ?
      `).all(...states, cursor.updatedAtMs, cursor.updatedAtMs, cursor.id, normalizedLimit);
    return rows.map((row) => this._rowToItem(row));
  }

  reconcileStartup({ requestId }) {
    return this._mutate('reconcileStartup', requestId, {}, () => {
      const now = Date.now();
      this.db.prepare(`
        UPDATE workflow_runs
        SET status = 'crashed', finished_at_ms = ?, heartbeat_at_ms = ?
        WHERE status = 'active'
      `).run(now, now);

      const requeuedLeaseIds = [];
      const leasedRows = this.db.prepare(`
        SELECT * FROM workflow_items WHERE state = 'leased' ORDER BY updated_at_ms, id
      `).all();
      for (const row of leasedRows) {
        const queueSeq = this._nextQueueSequence();
        const nextRevision = row.revision + 1;
        this.db.prepare(`
          UPDATE workflow_items
          SET state = 'queued', queue_seq = ?, available_at_ms = ?,
              lease_token = NULL, lease_owner_run_id = NULL, lease_profile_id = NULL,
              lease_expires_at_ms = NULL, reason = 'startup_recovered_pre_dispatch_lease',
              revision = ?, updated_at_ms = ?
          WHERE id = ? AND state = 'leased' AND revision = ?
        `).run(queueSeq, now, nextRevision, now, row.id, row.revision);
        this._recordEvent(
          row.id,
          'startup_lease_requeued',
          'leased',
          'queued',
          nextRevision,
          { queueSeq },
          now,
        );
        requeuedLeaseIds.push(row.id);
      }

      const ambiguousIds = [];
      const quarantinedIds = [];
      const dispatchRows = this.db.prepare(`
        SELECT * FROM workflow_items WHERE state = 'dispatch_started' ORDER BY updated_at_ms, id
      `).all();
      for (const row of dispatchRows) {
        const attempt = this.db.prepare(`
          SELECT * FROM dispatch_attempts WHERE id = ? AND item_id = ? AND phase = 'started'
        `).get(row.current_attempt_id, row.id);

        if (!attempt) {
          // A row whose attempt is missing/desynchronized must NOT abort recovery
          // of every other item — that would make the app unstartable. Quarantine
          // it conservatively as ambiguous: it may have been published, so it is
          // never auto-eligible and always requires a human decision.
          const nextRevision = row.revision + 1;
          const update = this.db.prepare(`
            UPDATE workflow_items
            SET state = 'ambiguous', reason = 'startup_quarantined_inconsistent_attempt',
                error_json = ?, revision = ?, updated_at_ms = ?
            WHERE id = ? AND state = 'dispatch_started' AND revision = ?
          `).run(
            canonicalStringify({
              message: 'dispatch_started item has no matching started attempt',
              currentAttemptId: row.current_attempt_id,
            }),
            nextRevision,
            now,
            row.id,
            row.revision,
          );
          if (update.changes === 1) {
            this._recordEvent(
              row.id,
              'startup_quarantined',
              'dispatch_started',
              'ambiguous',
              nextRevision,
              { currentAttemptId: row.current_attempt_id },
              now,
            );
            quarantinedIds.push(row.id);
          }
          continue;
        }

        this.db.prepare(`
          UPDATE dispatch_attempts
          SET phase = 'ambiguous', reason = 'startup_recovered_after_dispatch_boundary',
              error_json = ?, updated_at_ms = ?
          WHERE id = ? AND phase = 'started'
        `).run(canonicalStringify({ message: 'Previous process ended after dispatch_started' }), now, attempt.id);
        const nextRevision = row.revision + 1;
        this.db.prepare(`
          UPDATE workflow_items
          SET state = 'ambiguous', reason = 'startup_recovered_after_dispatch_boundary',
              error_json = ?, revision = ?, updated_at_ms = ?
          WHERE id = ? AND state = 'dispatch_started' AND revision = ?
            AND current_attempt_id = ?
        `).run(
          canonicalStringify({ message: 'Previous process ended after dispatch_started' }),
          nextRevision,
          now,
          row.id,
          row.revision,
          attempt.id,
        );
        this._recordEvent(
          row.id,
          'startup_dispatch_ambiguous',
          'dispatch_started',
          'ambiguous',
          nextRevision,
          { attemptId: attempt.id },
          now,
        );
        ambiguousIds.push(row.id);
      }
      return { requeuedLeaseIds, ambiguousIds, quarantinedIds };
    });
  }

  /**
   * Delete managed media files that no `media_blobs` row references.
   *
   * _stageMedia() writes and fsyncs the blob BEFORE the enqueue transaction, so
   * a failed transaction (SQLITE_BUSY, crash, I/O error) leaves bytes on disk
   * with nothing pointing at them. Without a sweep these accumulate forever.
   *
   * The grace period is essential: a concurrent enqueue may have just written
   * its blob and not yet committed, and deleting it would corrupt that item.
   */
  sweepOrphanMedia({ graceMs = 3_600_000, now = Date.now() } = {}) {
    this._assertOpen();
    if (!Number.isInteger(graceMs) || graceMs < 0) {
      throw new TypeError('graceMs must be a non-negative integer');
    }
    const { orphanedMediaFiles, orphanedTempFiles } = this._findOrphanMedia();
    const cutoff = now - graceMs;
    const deleted = [];
    let reclaimedBytes = 0;

    for (const orphan of [...orphanedMediaFiles, ...orphanedTempFiles]) {
      if (orphan.modifiedAtMs > cutoff) continue;
      try {
        fs.unlinkSync(orphan.path);
        deleted.push(orphan.path);
        reclaimedBytes += orphan.byteSize;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    if (deleted.length > 0) fsyncDirectory(this.mediaDir);
    return { deleted, reclaimedBytes };
  }

  _findOrphanMedia() {
    const referenced = new Set(
      this.db.prepare('SELECT relative_path FROM media_blobs').all().map((row) => row.relative_path),
    );
    const orphanedMediaFiles = [];
    const orphanedTempFiles = [];

    const scan = (directory, bucket, isTemp) => {
      let entries;
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const fullPath = path.join(directory, entry.name);
        if (!isTemp && referenced.has(entry.name)) continue;
        let stat;
        try {
          stat = fs.statSync(fullPath);
        } catch (error) {
          if (error.code === 'ENOENT') continue;
          throw error;
        }
        bucket.push({ path: fullPath, byteSize: stat.size, modifiedAtMs: stat.mtimeMs });
      }
    };

    scan(this.mediaDir, orphanedMediaFiles, false);
    scan(this.mediaTempDir, orphanedTempFiles, true);
    return { orphanedMediaFiles, orphanedTempFiles };
  }

  /**
   * Delete idempotency records older than the retention window.
   *
   * `api_requests` stores a full copy of every response and was measured at
   * ~53% of total database size (~102MB projected at 10k posts). Replay
   * protection is only meaningful while the originating operation could still
   * be retried, so aged rows are pure overhead.
   *
   * SAFETY: while ANY dispatch is unresolved, that operation is by definition
   * still pending and its replay records must survive — pruning them would let
   * a legitimate retry re-execute instead of replaying. Pruning therefore only
   * runs when nothing is in flight.
   *
   * Durable state, events, and attempts are untouched — only the replay cache.
   */
  pruneIdempotency({ olderThanMs = 7 * 86_400_000, now = Date.now() } = {}) {
    this._assertOpen();
    if (!Number.isInteger(olderThanMs) || olderThanMs < 0) {
      throw new TypeError('olderThanMs must be a non-negative integer');
    }
    const cutoffMs = now - olderThanMs;
    return this._immediate(() => {
      const unresolved = this.db.prepare(`
        SELECT COUNT(*) AS total FROM workflow_items
        WHERE state IN ('dispatch_started', 'ambiguous', 'leased')
          AND (state = 'leased' OR reconciliation_closed_at_ms IS NULL)
      `).get().total;
      if (unresolved > 0) {
        return { deleted: 0, cutoffMs, skippedReason: 'unresolved_operations_in_flight', unresolved };
      }

      // The retention trigger reads this cutoff, so deletion stays impossible
      // for anything newer even if some other code path attempts it.
      this.db.prepare(`
        INSERT INTO workflow_metadata(key, value_json, updated_at_ms)
        VALUES ('api_requests_prune_cutoff', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
                                       updated_at_ms = excluded.updated_at_ms
      `).run(canonicalStringify({ cutoffMs }), now);
      const result = this.db.prepare('DELETE FROM api_requests WHERE created_at_ms <= ?').run(cutoffMs);
      this.db.prepare(`DELETE FROM workflow_metadata WHERE key = 'api_requests_prune_cutoff'`).run();
      return { deleted: result.changes, cutoffMs };
    });
  }

  integrityCheck({ verifyMedia = true } = {}) {
    this._assertOpen();
    const quickCheck = this.db.pragma('quick_check', { simple: true });
    const foreignKeyViolations = this.db.pragma('foreign_key_check');
    const mediaProblems = [];
    if (verifyMedia) {
      const blobs = this.db.prepare(`
        SELECT sha256, relative_path, byte_size, status FROM media_blobs ORDER BY sha256
      `).all();
      for (const blob of blobs) {
        const managedPath = path.resolve(this.mediaDir, blob.relative_path);
        if (!managedPath.startsWith(`${path.resolve(this.mediaDir)}${path.sep}`)) {
          mediaProblems.push({ sha256: blob.sha256, code: 'PATH_ESCAPE' });
          continue;
        }
        let fd;
        try {
          fd = fs.openSync(managedPath, 'r');
          const actual = hashOpenFile(fd);
          if (actual.sha256 !== blob.sha256 || actual.byteSize !== blob.byte_size || blob.status !== 'ready') {
            mediaProblems.push({
              sha256: blob.sha256,
              code: 'HASH_OR_SIZE_MISMATCH',
              actualSha256: actual.sha256,
              actualByteSize: actual.byteSize,
              expectedByteSize: blob.byte_size,
              status: blob.status,
            });
          }
        } catch (error) {
          mediaProblems.push({ sha256: blob.sha256, code: error.code || 'MEDIA_READ_FAILED' });
        } finally {
          if (fd !== undefined) fs.closeSync(fd);
        }
      }
    }
    // Item/attempt split-brain: the per-table triggers validate transitions
    // within each table, but nothing links workflow_items.state to
    // dispatch_attempts.phase. Raw SQL or an older build can desynchronize
    // them, and that stays invisible for months without this check.
    const stateConsistencyViolations = this.db.prepare(`
      SELECT i.id AS itemId, i.state AS itemState, a.id AS attemptId, a.phase AS attemptPhase
      FROM workflow_items i
      JOIN dispatch_attempts a ON a.id = i.current_attempt_id
      WHERE (i.state = 'dispatch_started' AND a.phase <> 'started')
         OR (i.state = 'ambiguous' AND a.phase <> 'ambiguous')
         OR (i.state = 'published' AND a.phase <> 'published')
         OR (a.item_id <> i.id)
      ORDER BY i.id
    `).all();

    // Managed media bytes with no referencing row: pure disk leak.
    const { orphanedMediaFiles, orphanedTempFiles } = this._findOrphanMedia();

    return {
      ok: quickCheck === 'ok'
        && foreignKeyViolations.length === 0
        && mediaProblems.length === 0
        && stateConsistencyViolations.length === 0
        && orphanedMediaFiles.length === 0,
      quickCheck,
      foreignKeyViolations,
      mediaProblems,
      stateConsistencyViolations,
      orphanedMediaFiles,
      orphanedTempFiles,
    };
  }

  // ── Health gate ────────────────────────────────────────────────────────────
  //
  // integrityCheck() hashes every managed media file — far too expensive to run
  // per post. Its verdict is therefore latched in workflow_metadata, and
  // beginDispatch reads that latch inside its own transaction. The expensive
  // check runs at startup and between runs; the boundary pays one row read.
  //
  // The latch is deliberately durable rather than in-memory: a process that
  // crashes right after detecting damage must not come back up believing the
  // store is fine.

  /** @returns {{blocked: boolean, reason: string|null, checkedAtMs: number|null}} */
  _readHealthGate() {
    const row = this.db
      .prepare(`SELECT value_json AS value FROM workflow_metadata WHERE key = 'health_gate'`)
      .get();
    if (!row || !row.value) return { blocked: false, reason: null, checkedAtMs: null };
    try {
      const parsed = JSON.parse(row.value);
      return {
        blocked: parsed.blocked === true,
        reason: parsed.reason || null,
        checkedAtMs: parsed.checkedAtMs || null,
      };
    } catch {
      // An unreadable gate is treated as blocking. Fail closed: the one thing
      // worse than refusing to publish is publishing from a store whose health
      // we cannot establish.
      return { blocked: true, reason: 'HEALTH_GATE_UNREADABLE', checkedAtMs: null };
    }
  }

  /** The current gate, for callers that want to report it. */
  healthGate() {
    this._assertOpen();
    return this._readHealthGate();
  }

  /**
   * Latch a health verdict.
   *
   * `reason` is required when blocking — a gate that cannot say why it is shut
   * is one an operator will simply clear.
   */
  setHealthGate({ blocked, reason = null, details = null, now = Date.now() } = {}) {
    this._assertOpen();
    if (typeof blocked !== 'boolean') throw new TypeError('blocked must be a boolean');
    if (blocked && (typeof reason !== 'string' || !reason.trim())) {
      throw new TypeError('a blocking health gate requires a reason');
    }
    const value = canonicalStringify({
      blocked,
      reason: blocked ? reason : null,
      details,
      checkedAtMs: now,
    });
    this.db.prepare(`
      INSERT INTO workflow_metadata (key, value_json, updated_at_ms)
      VALUES ('health_gate', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at_ms = excluded.updated_at_ms
    `).run(value, now);
    return this._readHealthGate();
  }

  // ── Backup ─────────────────────────────────────────────────────────────────

  /**
   * Take an online backup of the database, verify it, and rotate old copies.
   *
   * Uses SQLite's backup API rather than copying the file: a plain copy of a WAL
   * database while it is open produces a torn snapshot that looks fine until the
   * day it is needed. The copy is then REOPENED and quick_check'd, because an
   * unverified backup is a belief, not a backup.
   *
   * Media is not copied here. The blobs are content-addressed and immutable, and
   * duplicating hundreds of megabytes on every backup would itself become the
   * growth problem this is meant to bound; the manifest records which blobs the
   * snapshot expects so a restore can report exactly what is missing.
   */
  async backup({ dir = null, keep = 5, now = Date.now(), label = null } = {}) {
    this._assertOpen();
    if (!Number.isInteger(keep) || keep < 1) throw new TypeError('keep must be a positive integer');

    const backupDir = dir || path.join(this.rootDir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    const name = `workflow-${stamp}${label ? `-${label}` : ''}.sqlite`;
    const target = path.join(backupDir, name);

    // Fold the WAL back in first so the snapshot is as complete as possible.
    try { this.checkpoint('PASSIVE'); } catch { /* a busy checkpoint is not fatal */ }
    await this.db.backup(target);

    let verified = false;
    let verifyError = null;
    let itemCount = null;
    let Database = null;
    try {
      Database = require('better-sqlite3');
      const copy = new Database(target, { readonly: true, fileMustExist: true });
      try {
        const quick = copy.pragma('quick_check', { simple: true });
        itemCount = copy.prepare('SELECT COUNT(*) n FROM workflow_items').get().n;
        const live = this.db.prepare('SELECT COUNT(*) n FROM workflow_items').get().n;
        // The live count may legitimately have moved on while the backup ran;
        // it must never be SHORT of what the snapshot claims to hold.
        verified = quick === 'ok' && itemCount <= live;
        if (!verified) verifyError = `quick_check=${quick} items=${itemCount} live=${live}`;
      } finally {
        copy.close();
      }
    } catch (error) {
      verified = false;
      verifyError = error.message;
    }

    if (!verified) {
      // A backup that does not verify is worse than none: it invites a restore
      // from a file that cannot be restored. Remove it and report the failure.
      try { fs.rmSync(target, { force: true }); } catch { /* best effort */ }
      return { ok: false, path: null, verified: false, error: verifyError, rotated: [] };
    }

    const stat = fs.statSync(target);
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
    fs.writeFileSync(`${target}.json`, canonicalStringify({
      createdAtMs: now,
      sqliteBytes: stat.size,
      sha256,
      itemCount,
      mediaBlobs: this.db.prepare('SELECT COUNT(*) n FROM media_blobs').get().n,
      schemaVersion: (this.db.prepare(
        `SELECT value_json AS value FROM workflow_metadata WHERE key = 'schema_version'`
      ).get() || {}).value || null,
    }));

    // Rotation, newest-first. Only files this method wrote are ever considered.
    const rotated = [];
    const existing = fs.readdirSync(backupDir)
      .filter((f) => /^workflow-.*\.sqlite$/.test(f))
      .map((f) => ({ f, mtime: fs.statSync(path.join(backupDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const old of existing.slice(keep)) {
      try {
        fs.rmSync(path.join(backupDir, old.f), { force: true });
        fs.rmSync(path.join(backupDir, `${old.f}.json`), { force: true });
        rotated.push(old.f);
      } catch { /* best effort */ }
    }

    this.db.prepare(`
      INSERT INTO workflow_metadata (key, value_json, updated_at_ms)
      VALUES ('last_backup', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at_ms = excluded.updated_at_ms
    `).run(canonicalStringify({ path: target, sha256, bytes: stat.size, atMs: now }), now);

    return { ok: true, path: target, bytes: stat.size, sha256, itemCount, verified: true, rotated };
  }

  /** When the last verified backup was taken, or null. */
  lastBackup() {
    this._assertOpen();
    const row = this.db
      .prepare(`SELECT value_json AS value FROM workflow_metadata WHERE key = 'last_backup'`)
      .get();
    if (!row || !row.value) return null;
    try { return JSON.parse(row.value); } catch { return null; }
  }

  // ── Retention ──────────────────────────────────────────────────────────────

  /**
   * Bound the growth of finished work without losing what the app still needs.
   *
   * Every published post left behind its row, its dispatch attempts and four
   * event rows, forever: measured at ~7.4 KB and 4 events per post, a modest
   * 100 posts/day install reaches roughly half a gigabyte and 292,000 event
   * rows in two years, and every startup reconciliation and every dedup read
   * pays for it.
   *
   * What is dropped is the audit BULK — events, attempt records, resolution
   * blobs. What is kept is the knowledge: the published text, when it went out
   * and its URL move into `archived_items`, so the semantic dedup corpus is
   * unaffected and the operator can still prove a post was published.
   *
   * Only terminal states are eligible, and only past the cutoff. Nothing that
   * still owes an outcome — queued, deferred, leased, dispatch_started,
   * ambiguous — is touched at any age.
   */
  applyRetention({
    olderThanMs = 90 * 86_400_000,
    now = Date.now(),
    limit = 5000,
    states = ['published', 'discarded', 'dead'],
  } = {}) {
    this._assertOpen();
    if (!Number.isInteger(olderThanMs) || olderThanMs < 86_400_000) {
      throw new TypeError('olderThanMs must be at least one day');
    }
    const eligible = states.filter((s) => ['published', 'discarded', 'dead'].includes(s));
    if (eligible.length === 0) throw new TypeError('no eligible retention states');
    const cutoffMs = now - olderThanMs;

    return this.db.transaction(() => {
      const placeholders = eligible.map(() => '?').join(',');
      const rows = this.db.prepare(`
        SELECT id, state, payload_json, published_at_ms, updated_at_ms, current_attempt_id
        FROM workflow_items
        WHERE state IN (${placeholders})
          AND updated_at_ms <= ?
        ORDER BY updated_at_ms ASC
        LIMIT ?
      `).all(...eligible, cutoffMs, limit);

      if (rows.length === 0) {
        return { archived: 0, eventsDeleted: 0, attemptsDeleted: 0, cutoffMs, reclaimedMediaRefs: 0 };
      }

      // workflow_items.current_attempt_id and dispatch_attempts.item_id point at
      // each other, so there is no delete order that satisfies both. Deferring
      // the checks to COMMIT is the standard resolution: by then BOTH rows are
      // gone, so nothing dangles. The pragma resets itself at end of
      // transaction, so it cannot leak into anything else.
      this.db.pragma('defer_foreign_keys = ON');

      // Open the two append-only retention gates for the duration of this
      // transaction only. Both are cleared in the finally below, so a throw
      // cannot leave the audit tables deletable.
      this.db.prepare(`
        INSERT INTO workflow_metadata (key, value_json, updated_at_ms)
        VALUES ('workflow_events_prune_cutoff', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at_ms = excluded.updated_at_ms
      `).run(canonicalStringify({ cutoffMs: now }), now);
      this.db.prepare(`
        INSERT INTO workflow_metadata (key, value_json, updated_at_ms)
        VALUES ('item_media_prune_gate', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at_ms = excluded.updated_at_ms
      `).run(canonicalStringify({ active: 1 }), now);

      try {
        const insertArchive = this.db.prepare(`
          INSERT OR IGNORE INTO archived_items
            (id, state, text, published_at_ms, archived_at_ms, external_url)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        const delEvents = this.db.prepare('DELETE FROM workflow_events WHERE item_id = ?');
        const delAttempts = this.db.prepare('DELETE FROM dispatch_attempts WHERE item_id = ?');
        const delItemMedia = this.db.prepare('DELETE FROM item_media WHERE item_id = ?');
        const delItem = this.db.prepare('DELETE FROM workflow_items WHERE id = ?');
        const lastUrl = this.db.prepare(`
          SELECT external_url FROM dispatch_attempts
          WHERE item_id = ? AND external_url IS NOT NULL
          ORDER BY created_at_ms DESC LIMIT 1
        `);

        let eventsDeleted = 0;
        let attemptsDeleted = 0;
        let reclaimedMediaRefs = 0;
        for (const row of rows) {
          let text = '';
          try { text = (JSON.parse(row.payload_json) || {}).text || ''; } catch { text = ''; }
          const url = (lastUrl.get(row.id) || {}).external_url || null;
          insertArchive.run(row.id, row.state, text, row.published_at_ms, now, url);
          eventsDeleted += delEvents.run(row.id).changes;
          reclaimedMediaRefs += delItemMedia.run(row.id).changes;
          delItem.run(row.id);
          attemptsDeleted += delAttempts.run(row.id).changes;
        }

        return {
          archived: rows.length,
          eventsDeleted,
          attemptsDeleted,
          reclaimedMediaRefs,
          cutoffMs,
        };
      } finally {
        this.db.prepare(`DELETE FROM workflow_metadata WHERE key = 'workflow_events_prune_cutoff'`).run();
        this.db.prepare(`DELETE FROM workflow_metadata WHERE key = 'item_media_prune_gate'`).run();
      }
    })();
  }

  /**
   * Published texts that have been archived out of the live table.
   *
   * The dedup corpus must span these too, or retention would quietly make the
   * app willing to republish everything older than the cutoff.
   */
  listArchivedTexts({ limit = 5000, after = null } = {}) {
    this._assertOpen();
    const rows = after
      ? this.db.prepare(`
          SELECT id, text, archived_at_ms FROM archived_items
          WHERE state = 'published' AND text <> ''
            AND (archived_at_ms > ? OR (archived_at_ms = ? AND id > ?))
          ORDER BY archived_at_ms ASC, id ASC LIMIT ?
        `).all(after.archivedAtMs, after.archivedAtMs, after.id, limit)
      : this.db.prepare(`
          SELECT id, text, archived_at_ms FROM archived_items
          WHERE state = 'published' AND text <> ''
          ORDER BY archived_at_ms ASC, id ASC LIMIT ?
        `).all(limit);
    return rows.map((r) => ({ id: r.id, text: r.text, archivedAtMs: r.archived_at_ms }));
  }

  checkpoint(mode = 'TRUNCATE') {
    this._assertOpen();
    const normalizedMode = assertNonEmptyString(mode, 'mode').toUpperCase();
    if (!['PASSIVE', 'FULL', 'RESTART', 'TRUNCATE'].includes(normalizedMode)) {
      throw new TypeError('Unsupported WAL checkpoint mode');
    }
    return this.db.pragma(`wal_checkpoint(${normalizedMode})`);
  }

  close() {
    if (this.closed) return;
    try {
      this.checkpoint('TRUNCATE');
    } finally {
      this.db.close();
      this.closed = true;
    }
  }
}

module.exports = {
  WorkflowStore,
  WorkflowConflictError,
  WorkflowValidationError,
};
