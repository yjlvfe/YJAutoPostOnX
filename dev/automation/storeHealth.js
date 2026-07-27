'use strict';

/**
 * storeHealth.js — the gate between "the durable store is fine" and publishing.
 *
 * Three things were missing and are provided here:
 *
 *   1. A BACKUP. There was none. A single corrupt page in workflow.sqlite lost
 *      the queue, the publish history and the dedup corpus with nothing to
 *      restore from.
 *
 *   2. A RETENTION policy. Every published post left its row, its attempts and
 *      four event rows behind forever — measured at ~7.4 KB and 4 events per
 *      post, which is roughly half a gigabyte and 292,000 event rows after two
 *      years at 100 posts/day.
 *
 *   3. A HEALTH GATE. integrityCheck() existed but nothing consulted it before
 *      publishing. A store that failed its own check kept handing out leases and
 *      kept committing dispatches.
 *
 * The expensive check runs here, at startup and between runs; its verdict is
 * latched in the store so beginDispatch pays one row read at the boundary.
 */

const fs = require('fs');
const path = require('path');
const log = require('../utils/logger');

/** Free space below this on the store's filesystem blocks publishing. */
const MIN_FREE_BYTES = 64 * 1024 * 1024;
/** A WAL this large means checkpoints are not landing; worth saying out loud. */
const WAL_WARN_BYTES = 256 * 1024 * 1024;
/** Back up at most this often; a run every few minutes must not copy the DB. */
const BACKUP_INTERVAL_MS = 12 * 60 * 60 * 1000;
/** Keep three months of finished work in the live tables. */
const RETENTION_MS = 90 * 86_400_000;
/** Verified backups to keep. */
const BACKUP_KEEP = 5;
/** Grace period before an unreferenced media blob's bytes are reclaimed. */
const MEDIA_RECLAIM_GRACE_MS = 3_600_000;

function freeBytes(dir) {
  try {
    // statfsSync is Node 18.15+/20+. Electron 30 ships Node 20.
    const stat = fs.statfsSync(dir);
    return stat.bavail * stat.bsize;
  } catch {
    return null;
  }
}

function sizeOf(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

/**
 * Run the expensive checks and latch the verdict.
 *
 * Blocking conditions are only those where continuing could produce a wrong or
 * unrecoverable outcome:
 *   - the database fails quick_check or has foreign-key violations;
 *   - items and their attempts disagree about state (split brain);
 *   - managed media no longer matches the bytes recorded at enqueue;
 *   - the filesystem has too little room to commit a transaction.
 *
 * Orphaned media files and a large WAL are reported as warnings: they are disk
 * hygiene, not a reason to refuse an irreversible action that is otherwise
 * correct. Refusing on those would train the operator to clear the gate.
 */
function evaluate(store, { now = Date.now(), verifyMedia = true } = {}) {
  const integrity = store.integrityCheck({ verifyMedia });
  const dbPath = path.join(store.rootDir, 'workflow.sqlite');
  const free = freeBytes(store.rootDir);
  const walBytes = sizeOf(`${dbPath}-wal`);

  const blocking = [];
  const warnings = [];

  if (integrity.quickCheck !== 'ok') blocking.push(`quick_check=${integrity.quickCheck}`);
  if (integrity.foreignKeyViolations.length > 0) {
    blocking.push(`foreign_key_violations=${integrity.foreignKeyViolations.length}`);
  }
  if (integrity.stateConsistencyViolations.length > 0) {
    blocking.push(`item/attempt split-brain=${integrity.stateConsistencyViolations.length}`);
  }
  if (integrity.mediaProblems.length > 0) {
    blocking.push(`corrupt_media=${integrity.mediaProblems.length}`);
  }
  if (free !== null && free < MIN_FREE_BYTES) {
    blocking.push(`free_disk=${Math.round(free / 1048576)}MB`);
  }

  if (integrity.orphanedMediaFiles.length > 0) {
    warnings.push(`orphan_media_files=${integrity.orphanedMediaFiles.length}`);
  }
  if (walBytes > WAL_WARN_BYTES) warnings.push(`wal=${Math.round(walBytes / 1048576)}MB`);
  const lastBackup = store.lastBackup();
  if (!lastBackup) warnings.push('no_backup_yet');
  else if (now - lastBackup.atMs > 7 * 86_400_000) warnings.push('backup_older_than_7d');

  const blocked = blocking.length > 0;
  store.setHealthGate({
    blocked,
    reason: blocked ? blocking.join('; ') : null,
    details: { blocking, warnings, dbBytes: sizeOf(dbPath), walBytes, freeBytes: free },
    now,
  });

  return {
    ok: !blocked,
    blocked,
    blocking,
    warnings,
    dbBytes: sizeOf(dbPath),
    walBytes,
    freeBytes: free,
    lastBackupAtMs: lastBackup ? lastBackup.atMs : null,
    integrity,
  };
}

/**
 * Startup housekeeping: check health, back up if due, apply retention.
 *
 * Ordering matters. Health is established first, so a damaged database is never
 * backed up over the last good copy. Retention runs only after a verified
 * backup exists, so the rows it removes are recoverable.
 */
async function runStartupMaintenance(store, {
  now = Date.now(),
  backupIntervalMs = BACKUP_INTERVAL_MS,
  retentionMs = RETENTION_MS,
  keep = BACKUP_KEEP,
  mediaReclaimGraceMs = MEDIA_RECLAIM_GRACE_MS,
  force = false,
} = {}) {
  const health = evaluate(store, { now });
  const result = { health, backup: null, retention: null, mediaReclaim: null, skipped: [] };

  if (health.blocked) {
    // Do not overwrite the newest good backup with a damaged snapshot, and do
    // not delete anything under retention: the rows we would drop may be the
    // only remaining evidence of what happened.
    result.skipped.push('backup:store_unhealthy', 'retention:store_unhealthy', 'media_reclaim:store_unhealthy');
    log.error(`Durable store health gate is CLOSED: ${health.blocking.join('; ')}`);
    return result;
  }

  const last = store.lastBackup();
  const due = force || !last || (now - last.atMs) >= backupIntervalMs;
  if (!due) {
    result.skipped.push('backup:not_due');
  } else {
    try {
      result.backup = await store.backup({ keep, now });
      if (!result.backup.ok) log.error(`Workflow backup failed verification: ${result.backup.error}`);
    } catch (error) {
      result.backup = { ok: false, error: error.message };
      log.error(`Workflow backup failed: ${error.message}`);
    }
  }

  // Retention only ever runs behind a verified backup — this run's or an
  // earlier one's. Without that, pruning is just deletion.
  const haveBackup = (result.backup && result.backup.ok) || !!store.lastBackup();
  if (!haveBackup) {
    result.skipped.push('retention:no_verified_backup', 'media_reclaim:no_verified_backup');
  } else {
    try {
      result.retention = store.applyRetention({ olderThanMs: retentionMs, now });
    } catch (error) {
      result.retention = { error: error.message };
      log.error(`Workflow retention failed: ${error.message}`);
    }

    // Reclaim runs after retention, which is what actually drops the last
    // item_media reference to a blob. Same backup-gated caution applies.
    try {
      result.mediaReclaim = store.reclaimUnreferencedMedia({ graceMs: mediaReclaimGraceMs, now });
    } catch (error) {
      result.mediaReclaim = { error: error.message };
      log.error(`Workflow media reclaim failed: ${error.message}`);
    }
  }

  return result;
}

/**
 * Re-check health before a run starts.
 *
 * Cheaper than the startup pass by default: media hashing is skipped, because
 * beginDispatch verifies the media of the specific item it is about to send
 * anyway. Structural damage and a full disk are what must be caught here.
 */
function gateBeforeRun(store, { now = Date.now(), verifyMedia = false } = {}) {
  const health = evaluate(store, { now, verifyMedia });
  return {
    allowed: !health.blocked,
    reason: health.blocked ? health.blocking.join('; ') : null,
    warnings: health.warnings,
    health,
  };
}

module.exports = {
  evaluate,
  gateBeforeRun,
  runStartupMaintenance,
  MIN_FREE_BYTES,
  MEDIA_RECLAIM_GRACE_MS,
  BACKUP_INTERVAL_MS,
  RETENTION_MS,
  BACKUP_KEEP,
};
