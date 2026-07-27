'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION = 7;

function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  try {
    for (;;) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (!bytes) break;
      hash.update(buffer.subarray(0, bytes));
      position += bytes;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { sha256: hash.digest('hex'), byteSize: position };
}

function fsyncFile(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function fsyncDir(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch (error) {
    if (!['EINVAL', 'EPERM', 'EISDIR', 'ENOTSUP'].includes(error.code)) throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function backupRoot(rootDir) {
  return path.join(rootDir, 'backups');
}

function readManifest(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    if (!parsed || parsed.complete !== true || typeof parsed.createdAtMs !== 'number') return null;
    return { ...parsed, directory: dir };
  } catch {
    return null;
  }
}

function listSnapshots(rootDir) {
  const root = backupRoot(rootDir);
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.tmp-'))
    .map((entry) => readManifest(path.join(root, entry.name)))
    .filter(Boolean)
    .sort((a, b) => b.createdAtMs - a.createdAtMs);
}

function pruneSnapshots(rootDir, { keep = DEFAULT_RETENTION } = {}) {
  if (!Number.isInteger(keep) || keep < 1) throw new TypeError('keep must be a positive integer');
  const snapshots = listSnapshots(rootDir);
  const removed = [];
  for (const snapshot of snapshots.slice(keep)) {
    fs.rmSync(snapshot.directory, { recursive: true, force: true });
    removed.push(snapshot.directory);
  }
  if (removed.length) fsyncDir(backupRoot(rootDir));
  return { removed, kept: snapshots.slice(0, keep) };
}

function verifyRestoreDrill(dbPath, rootDir) {
  const drillPath = path.join(rootDir, `.restore-drill-${crypto.randomUUID()}.sqlite`);
  try {
    fs.copyFileSync(dbPath, drillPath, fs.constants.COPYFILE_EXCL);
    fsyncFile(drillPath);
    const validation = validateBackupDatabase(drillPath);
    const sourceHash = hashFile(dbPath);
    const drillHash = hashFile(drillPath);
    if (sourceHash.sha256 !== drillHash.sha256 || sourceHash.byteSize !== drillHash.byteSize) {
      const error = new Error('Restore drill copy does not match the snapshot database');
      error.code = 'BACKUP_RESTORE_DRILL_MISMATCH';
      throw error;
    }
    return { ...validation, sha256: drillHash.sha256, byteSize: drillHash.byteSize };
  } finally {
    try { fs.unlinkSync(drillPath); } catch { /* best effort */ }
  }
}

function validateBackupDatabase(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const quickCheck = db.pragma('quick_check', { simple: true });
    const foreignKeyViolations = db.pragma('foreign_key_check');
    const required = new Set(['workflow_items', 'dispatch_attempts', 'profiles', 'workflow_events']);
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
    const missingTables = [...required].filter((name) => !tables.has(name));
    if (quickCheck !== 'ok' || foreignKeyViolations.length || missingTables.length) {
      const error = new Error('Backup database validation failed');
      error.code = 'BACKUP_VALIDATION_FAILED';
      error.details = { quickCheck, foreignKeyViolations, missingTables };
      throw error;
    }
    return { quickCheck, foreignKeyViolations: 0, missingTables: [] };
  } finally {
    db.close();
  }
}

async function createSnapshot(store, { now = Date.now(), keep = DEFAULT_RETENTION } = {}) {
  if (!store || store.closed || !store.db || !store.rootDir) throw new TypeError('open WorkflowStore required');
  const root = backupRoot(store.rootDir);
  fs.mkdirSync(root, { recursive: true });
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const finalDir = path.join(root, stamp);
  const tempDir = path.join(root, `.tmp-${stamp}-${crypto.randomUUID()}`);
  fs.mkdirSync(path.join(tempDir, 'media'), { recursive: true });

  try {
    const dbPath = path.join(tempDir, 'workflow.sqlite');
    await store.db.backup(dbPath);
    fsyncFile(dbPath);
    const databaseValidation = validateBackupDatabase(dbPath);
    const restoreDrill = verifyRestoreDrill(dbPath, tempDir);
    const dbHash = hashFile(dbPath);

    const mediaRows = store.db.prepare("SELECT sha256, relative_path, byte_size FROM media_blobs WHERE status = 'ready' ORDER BY sha256").all();
    const media = [];
    for (const row of mediaRows) {
      const source = path.resolve(store.mediaDir, row.relative_path);
      const mediaRoot = path.resolve(store.mediaDir) + path.sep;
      if (!source.startsWith(mediaRoot)) throw new Error(`Media path escapes root: ${row.relative_path}`);
      const target = path.join(tempDir, 'media', row.relative_path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      fsyncFile(target);
      const actual = hashFile(target);
      if (actual.sha256 !== row.sha256 || actual.byteSize !== row.byte_size) {
        const error = new Error(`Media changed during backup: ${row.relative_path}`);
        error.code = 'BACKUP_MEDIA_MISMATCH';
        throw error;
      }
      media.push({ sha256: row.sha256, relativePath: row.relative_path, byteSize: row.byte_size });
    }

    const manifest = {
      format: 1,
      complete: true,
      createdAtMs: now,
      createdAt: new Date(now).toISOString(),
      database: { file: 'workflow.sqlite', ...dbHash, validation: databaseValidation, restoreDrill },
      media,
    };
    const manifestPath = path.join(tempDir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    fsyncFile(manifestPath);
    fsyncDir(path.join(tempDir, 'media'));
    fsyncDir(tempDir);
    fs.renameSync(tempDir, finalDir);
    fsyncDir(root);
    const retention = pruneSnapshots(store.rootDir, { keep });
    return { created: true, directory: finalDir, manifest, retentionRemoved: retention.removed.length };
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

async function maybeCreateSnapshot(store, { now = Date.now(), intervalMs = DEFAULT_INTERVAL_MS, keep = DEFAULT_RETENTION, force = false } = {}) {
  const latest = listSnapshots(store.rootDir)[0] || null;
  if (!force && latest && now - latest.createdAtMs < intervalMs) {
    return { created: false, reason: 'interval_not_elapsed', latest };
  }
  return createSnapshot(store, { now, keep });
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  DEFAULT_RETENTION,
  backupRoot,
  listSnapshots,
  pruneSnapshots,
  validateBackupDatabase,
  verifyRestoreDrill,
  createSnapshot,
  maybeCreateSnapshot,
  hashFile,
};
