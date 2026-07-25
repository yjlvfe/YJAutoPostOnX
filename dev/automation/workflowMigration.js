'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { WorkflowStore } = require('./workflowStore');

const MIGRATION_VERSION = 1;
const FINAL_DB_NAME = 'workflow.sqlite';

class LegacyMigrationError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'LegacyMigrationError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, details) {
  throw new LegacyMigrationError(code, message, details);
}

function hashBytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function hashFile(filePath) {
  return hashBytes(fs.readFileSync(filePath));
}

function deterministicUuid(value) {
  const hex = hashBytes(Buffer.from(value));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
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

function atomicWriteBytes(filePath, bytes) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${crypto.randomUUID()}`;
  let fd;
  try {
    fd = fs.openSync(tempPath, 'wx', 0o600);
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
      if (written <= 0) throw new Error(`Unable to write migration backup: ${tempPath}`);
      offset += written;
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempPath, filePath);
    fsyncDirectory(path.dirname(filePath));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(tempPath); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function normalizeArray(value, label) {
  if (!Array.isArray(value)) fail('LEGACY_SOURCE_INVALID', `${label} must contain a JSON array`);
  return value;
}

function normalizeObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('LEGACY_SOURCE_INVALID', `${label} must contain a JSON object`);
  }
  return value;
}

function sourceDescriptor({ logicalName, filePath, kind, profileName = null }) {
  if (!fs.existsSync(filePath)) return null;
  const bytes = fs.readFileSync(filePath);
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    fail('LEGACY_SOURCE_INVALID', `Invalid JSON in ${filePath}`, {
      filePath,
      backupExists: fs.existsSync(`${filePath}.bak`),
      parseError: error.message,
    });
  }
  const data = kind === 'posting'
    ? normalizeObject(parsed, logicalName)
    : normalizeArray(parsed, logicalName);
  const records = kind === 'posting'
    ? Object.entries(data).map(([name, value], ordinal) => ({ ordinal, profileName: name, value }))
    : data.map((value, ordinal) => ({ ordinal, profileName, value }));
  const resolvedPath = path.resolve(filePath);
  const digest = hashBytes(bytes);
  let auxiliaryBak = null;
  const bakPath = `${resolvedPath}.bak`;
  if (fs.existsSync(bakPath)) {
    const bakBytes = fs.readFileSync(bakPath);
    auxiliaryBak = {
      sourcePath: bakPath,
      bytes: bakBytes,
      byteSize: bakBytes.length,
      sha256: hashBytes(bakBytes),
    };
  }
  return {
    id: deterministicUuid(`${logicalName}\u0000${resolvedPath}\u0000${digest}`),
    logicalName,
    filePath: resolvedPath,
    kind,
    profileName,
    bytes,
    sha256: digest,
    byteSize: bytes.length,
    auxiliaryBak,
    records,
  };
}

function extractPayload(value, { payloadIncomplete = false, source }) {
  let payload;
  if (typeof value === 'string') payload = { text: value, media_path: null };
  else if (value && typeof value === 'object' && !Array.isArray(value)) payload = { ...value };
  else fail('LEGACY_RECORD_INVALID', `Legacy record in ${source} has no object/string payload`);
  if (typeof payload.text !== 'string' || payload.text.trim() === '') {
    fail('LEGACY_RECORD_INVALID', `Legacy record in ${source} has no non-empty text`);
  }
  if (payloadIncomplete) payload.payload_incomplete = true;
  return payload;
}

function textOf(value, source) {
  return extractPayload(value, { source }).text;
}

function safeName(value) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'source';
}

function collectSources(sharedDir, profileDirs) {
  const candidates = [
    { logicalName: 'shared.queue', filePath: path.join(sharedDir, 'queue.json'), kind: 'queue' },
    { logicalName: 'shared.published', filePath: path.join(sharedDir, 'published.json'), kind: 'published' },
    { logicalName: 'shared.posting', filePath: path.join(sharedDir, 'posting-state.json'), kind: 'posting' },
  ];
  for (const profile of profileDirs) {
    if (!profile || typeof profile.name !== 'string' || typeof profile.dir !== 'string') {
      fail('INVALID_MIGRATION_ARGUMENT', 'profileDirs entries require name and dir strings');
    }
    candidates.push(
      {
        logicalName: `profile.${profile.name}.pending`,
        filePath: path.join(profile.dir, 'pending-verification.json'),
        kind: 'pending',
        profileName: profile.name,
      },
      {
        logicalName: `profile.${profile.name}.dead`,
        filePath: path.join(profile.dir, 'dead-letters.json'),
        kind: 'dead',
        profileName: profile.name,
      },
      {
        logicalName: `profile.${profile.name}.deferred`,
        filePath: path.join(profile.dir, 'deferred-posts.json'),
        kind: 'deferred',
        profileName: profile.name,
      },
    );
  }
  return candidates.map(sourceDescriptor).filter(Boolean);
}

function createBackup(rootDir, sources) {
  const fingerprintInput = sources
    .map((source) => `${source.logicalName}\u0000${source.filePath}\u0000${source.sha256}\u0000${source.byteSize}\u0000${source.auxiliaryBak ? source.auxiliaryBak.sha256 : ''}`)
    .sort()
    .join('\n');
  const fingerprint = hashBytes(Buffer.from(fingerprintInput));
  const backupName = `legacy-backup-v${MIGRATION_VERSION}-${fingerprint.slice(0, 24)}`;
  const backupDir = path.join(rootDir, backupName);
  const manifestSources = sources.map((source) => {
    const fileName = `${safeName(source.logicalName)}-${source.sha256.slice(0, 16)}.json`;
    const bakFileName = source.auxiliaryBak
      ? `${safeName(source.logicalName)}-${source.auxiliaryBak.sha256.slice(0, 16)}.legacy.bak`
      : null;
    return {
      id: source.id,
      logicalName: source.logicalName,
      sourcePath: source.filePath,
      byteSize: source.byteSize,
      sha256: source.sha256,
      recordCount: source.records.length,
      backupRelativePath: path.join(backupName, fileName),
      fileName,
      auxiliaryBak: source.auxiliaryBak ? {
        sourcePath: source.auxiliaryBak.sourcePath,
        byteSize: source.auxiliaryBak.byteSize,
        sha256: source.auxiliaryBak.sha256,
        backupRelativePath: path.join(backupName, bakFileName),
        fileName: bakFileName,
      } : null,
    };
  });

  if (fs.existsSync(backupDir)) {
    let existing;
    try {
      existing = JSON.parse(fs.readFileSync(path.join(backupDir, 'manifest.json'), 'utf8'));
    } catch (error) {
      fail('LEGACY_BACKUP_CONFLICT', `Existing migration backup manifest is unreadable: ${backupDir}`, {
        error: error.message,
      });
    }
    if (existing.fingerprint !== fingerprint || existing.migrationVersion !== MIGRATION_VERSION) {
      fail('LEGACY_BACKUP_CONFLICT', `Existing migration backup does not match source fingerprint: ${backupDir}`);
    }
    for (const source of manifestSources) {
      const destination = path.join(backupDir, source.fileName);
      if (!fs.existsSync(destination) || hashFile(destination) !== source.sha256) {
        fail('LEGACY_BACKUP_CONFLICT', `Existing migration backup file failed verification: ${destination}`);
      }
      if (source.auxiliaryBak) {
        const bakDestination = path.join(backupDir, source.auxiliaryBak.fileName);
        if (!fs.existsSync(bakDestination)
          || hashFile(bakDestination) !== source.auxiliaryBak.sha256) {
          fail('LEGACY_BACKUP_CONFLICT', `Existing auxiliary .bak failed verification: ${bakDestination}`);
        }
      }
    }
    return { backupDir, backupName, manifestSources };
  }

  const tempBackupDir = path.join(rootDir, `${backupName}.tmp-${crypto.randomUUID()}`);
  try {
    fs.mkdirSync(tempBackupDir, { recursive: false });
    for (const source of sources) {
      const manifest = manifestSources.find((entry) => entry.id === source.id);
      atomicWriteBytes(path.join(tempBackupDir, manifest.fileName), source.bytes);
      if (source.auxiliaryBak) {
        atomicWriteBytes(
          path.join(tempBackupDir, manifest.auxiliaryBak.fileName),
          source.auxiliaryBak.bytes,
        );
      }
    }
    const manifest = {
      migrationVersion: MIGRATION_VERSION,
      fingerprint,
      createdAt: new Date().toISOString(),
      sources: manifestSources.map(({ fileName, ...entry }) => entry),
    };
    atomicWriteBytes(
      path.join(tempBackupDir, 'manifest.json'),
      Buffer.from(JSON.stringify(manifest, null, 2)),
    );
    fsyncDirectory(tempBackupDir);
    fs.renameSync(tempBackupDir, backupDir);
    fsyncDirectory(rootDir);
  } finally {
    fs.rmSync(tempBackupDir, { recursive: true, force: true });
  }
  return { backupDir, backupName, manifestSources };
}

function buildCandidates(sources) {
  const queueSource = sources.find((source) => source.kind === 'queue');
  const queueCandidates = queueSource
    ? queueSource.records.map((record) => ({
      payload: extractPayload(record.value, { source: queueSource.logicalName }),
      state: 'queued',
      profileName: null,
      reason: 'legacy_queue',
      queueOrdinal: record.ordinal,
      sourceRefs: [{ sourceId: queueSource.id, ordinal: record.ordinal, disposition: 'queue' }],
      assigned: false,
    }))
    : [];
  const conflicts = [];
  const standalone = [];
  const byText = new Map();
  queueCandidates.forEach((candidate, index) => {
    const text = candidate.payload.text;
    if (!byText.has(text)) byText.set(text, []);
    byText.get(text).push(index);
  });

  const sideSources = sources
    .filter((source) => source.kind !== 'queue')
    .sort((a, b) => {
      const priority = { published: 0, posting: 1, pending: 1, dead: 2, deferred: 3 };
      return priority[a.kind] - priority[b.kind];
    });
  const stateFor = {
    published: 'published',
    posting: 'ambiguous',
    pending: 'ambiguous',
    dead: 'dead',
    deferred: 'deferred',
  };

  for (const source of sideSources) {
    for (const record of source.records) {
      const raw = source.kind === 'posting' ? record.value : record.value;
      const text = textOf(raw, source.logicalName);
      const possible = (byText.get(text) || []).filter((index) => !queueCandidates[index].assigned);
      const profileName = record.profileName || source.profileName || null;
      const desiredState = stateFor[source.kind];
      const sourceRef = {
        sourceId: source.id,
        ordinal: record.ordinal,
        disposition: source.kind,
      };

      if (possible.length === 1) {
        const candidate = queueCandidates[possible[0]];
        candidate.assigned = true;
        candidate.state = desiredState;
        candidate.profileName = profileName;
        candidate.reason = `legacy_${source.kind}`;
        candidate.sourceRefs.push(sourceRef);
        continue;
      }

      if (possible.length > 1) {
        const conflict = {
          type: 'AMBIGUOUS_TEXT_MATCH',
          text,
          source: source.logicalName,
          ordinal: record.ordinal,
          queueOrdinals: possible,
        };
        conflicts.push(conflict);
        for (const index of possible) {
          const candidate = queueCandidates[index];
          candidate.assigned = true;
          candidate.state = source.kind === 'published' ? 'published' : 'ambiguous';
          candidate.profileName = profileName;
          candidate.reason = 'legacy_ambiguous_text_conflict';
          candidate.sourceRefs.push({ ...sourceRef, disposition: 'conflict' });
        }
        continue;
      }

      const canCarryFullPayload = source.kind === 'published';
      const standaloneState = source.kind === 'deferred' && !canCarryFullPayload
        ? 'ambiguous'
        : desiredState;
      standalone.push({
        payload: extractPayload(raw, {
          source: source.logicalName,
          payloadIncomplete: !canCarryFullPayload,
        }),
        state: standaloneState,
        profileName,
        reason: `legacy_${source.kind}_without_queue_payload`,
        queueOrdinal: null,
        sourceRefs: [sourceRef],
        assigned: true,
      });
    }
  }

  return {
    candidates: [...queueCandidates, ...standalone],
    conflicts,
  };
}

function createProfiles(store, names) {
  const profileIds = new Map();
  let index = 0;
  for (const name of names) {
    if (profileIds.has(name)) continue;
    const profile = store.createProfile({
      name,
      legacyPath: null,
      requestId: `migration-profile:${index}:${hashBytes(Buffer.from(name))}`,
    });
    profileIds.set(name, profile.id);
    index += 1;
  }
  return profileIds;
}

function importCandidate({ store, candidate, profileId, runId, index }) {
  const payload = { ...candidate.payload };
  if (payload.media_path && !fs.existsSync(path.resolve(payload.media_path))) {
    payload.legacy_media_path = payload.media_path;
    payload.media_path = null;
    payload.payload_incomplete = true;
    if (candidate.state !== 'published') {
      candidate.state = 'ambiguous';
      candidate.reason = 'legacy_media_missing';
    }
  }

  const item = store.enqueue({
    items: [payload],
    requestId: `migration-enqueue:${index}`,
  }).items[0];
  if (candidate.state === 'queued') return item;

  // Offline bulk import: reconstructs historical states and never dispatches,
  // so the live global recovery gate does not apply here.
  const lease = store.leaseNext({ profileId, runId, leaseMs: 300_000, allowUnresolvedRecovery: true });
  if (!lease || lease.id !== item.id) {
    fail('MIGRATION_INVARIANT_FAILED', 'Migration could not lease the expected isolated item', {
      expectedId: item.id,
      leasedId: lease && lease.id,
    });
  }
  if (candidate.state === 'deferred') {
    return store.markDeferred({
      id: item.id,
      leaseToken: lease.leaseToken,
      reason: candidate.reason,
      error: { legacy: true },
      availableAtMs: Number.MAX_SAFE_INTEGER,
      requestId: `migration-deferred:${index}`,
    });
  }
  if (candidate.state === 'dead') {
    return store.markTerminal({
      id: item.id,
      leaseToken: lease.leaseToken,
      reason: candidate.reason,
      error: { legacy: true },
      requestId: `migration-dead:${index}`,
    });
  }

  const attempt = store.beginDispatch({
    id: item.id,
    leaseToken: lease.leaseToken,
    renderedText: payload.text,
    requestId: `migration-dispatch:${index}`,
  });
  if (candidate.state === 'published') {
    return store.markPublished({
      attemptId: attempt.attemptId,
      evidence: { source: 'legacy_migration', reason: candidate.reason },
      requestId: `migration-published:${index}`,
    });
  }
  return store.markAmbiguous({
    attemptId: attempt.attemptId,
    reason: candidate.reason,
    evidence: { source: 'legacy_migration' },
    requestId: `migration-ambiguous:${index}`,
  });
}

function verifySourcesUnchanged(sources) {
  const changed = [];
  for (const source of sources) {
    if (!fs.existsSync(source.filePath)) {
      changed.push({ path: source.filePath, reason: 'missing' });
      continue;
    }
    const current = hashFile(source.filePath);
    if (current !== source.sha256) changed.push({ path: source.filePath, expected: source.sha256, actual: current });
    if (source.auxiliaryBak) {
      if (!fs.existsSync(source.auxiliaryBak.sourcePath)) {
        changed.push({ path: source.auxiliaryBak.sourcePath, reason: 'missing_auxiliary_bak' });
      } else {
        const currentBak = hashFile(source.auxiliaryBak.sourcePath);
        if (currentBak !== source.auxiliaryBak.sha256) {
          changed.push({
            path: source.auxiliaryBak.sourcePath,
            expected: source.auxiliaryBak.sha256,
            actual: currentBak,
          });
        }
      }
    }
  }
  if (changed.length > 0) {
    fail('LEGACY_SOURCE_CHANGED', 'Legacy sources changed while migration was in progress', { changed });
  }
}

function promoteMedia(stageRoot, rootDir) {
  const stageMedia = path.join(stageRoot, 'media');
  const finalMedia = path.join(rootDir, 'media');
  fs.mkdirSync(finalMedia, { recursive: true });
  if (!fs.existsSync(stageMedia)) return;
  for (const entry of fs.readdirSync(stageMedia, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const source = path.join(stageMedia, entry.name);
    const destination = path.join(finalMedia, entry.name);
    if (fs.existsSync(destination)) {
      if (hashFile(source) !== hashFile(destination)) {
        fail('MANAGED_MEDIA_CONFLICT', `Managed media conflict during migration: ${entry.name}`);
      }
      fs.unlinkSync(source);
    } else {
      fs.renameSync(source, destination);
    }
  }
  fsyncDirectory(finalMedia);
}

function readCompletedMigration(finalDbPath, rootDir) {
  const store = new WorkflowStore({ rootDir, dbPath: finalDbPath });
  try {
    const row = store.db.prepare(`
      SELECT value_json FROM workflow_metadata WHERE key = 'legacy_import_complete'
    `).get();
    if (!row) fail('FINAL_DB_NOT_MIGRATED', 'Existing workflow.sqlite has no completed legacy migration marker');
    const conflicts = store.db.prepare(`SELECT details_json FROM migration_conflicts ORDER BY created_at_ms, id`)
      .all().map((entry) => JSON.parse(entry.details_json));
    return { alreadyComplete: true, marker: JSON.parse(row.value_json), conflicts };
  } finally {
    store.close();
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function acquireMigrationLock(lockPath) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      fs.fsyncSync(fd);
      return fd;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner = null;
      try { owner = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch {}
      if (owner && processIsAlive(owner.pid)) {
        fail('MIGRATION_LOCKED', 'Another legacy migration is already running', { owner });
      }
      const stalePath = `${lockPath}.stale-${Date.now()}-${crypto.randomUUID()}`;
      try {
        fs.renameSync(lockPath, stalePath);
        fsyncDirectory(path.dirname(lockPath));
      } catch (renameError) {
        if (renameError.code !== 'ENOENT') throw renameError;
      }
    }
  }
  fail('MIGRATION_LOCKED', 'Could not acquire the legacy migration lock after stale-lock recovery');
}

function migrateLegacyWorkflow({
  rootDir,
  sharedDir,
  profileDirs = [],
  faultInjector = () => {},
}) {
  if (typeof rootDir !== 'string' || typeof sharedDir !== 'string') {
    fail('INVALID_MIGRATION_ARGUMENT', 'rootDir and sharedDir are required strings');
  }
  if (!Array.isArray(profileDirs) || typeof faultInjector !== 'function') {
    fail('INVALID_MIGRATION_ARGUMENT', 'profileDirs must be an array and faultInjector a function');
  }

  const resolvedRoot = path.resolve(rootDir);
  const resolvedShared = path.resolve(sharedDir);
  fs.mkdirSync(resolvedRoot, { recursive: true });
  const finalDbPath = path.join(resolvedRoot, FINAL_DB_NAME);
  if (fs.existsSync(finalDbPath)) return readCompletedMigration(finalDbPath, resolvedRoot);

  const lockPath = path.join(resolvedRoot, 'legacy-migration.lock');
  let lockFd;
  let stageRoot;
  let store;
  try {
    lockFd = acquireMigrationLock(lockPath);

    if (fs.existsSync(finalDbPath)) return readCompletedMigration(finalDbPath, resolvedRoot);

    // Stale stages are never authoritative. Quarantine by deletion before starting
    // a new stage; immutable backups remain under their separate directories.
    for (const entry of fs.readdirSync(resolvedRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('workflow-stage-')) {
        fs.rmSync(path.join(resolvedRoot, entry.name), { recursive: true, force: true });
      }
    }

    const sources = collectSources(resolvedShared, profileDirs);
    const backup = createBackup(resolvedRoot, sources);
    faultInjector('after_backup');

    const built = buildCandidates(sources);
    stageRoot = path.join(resolvedRoot, `workflow-stage-${crypto.randomUUID()}`);
    fs.mkdirSync(stageRoot, { recursive: true });
    const stageDbPath = path.join(stageRoot, FINAL_DB_NAME);
    store = new WorkflowStore({ rootDir: stageRoot, dbPath: stageDbPath });

    const migrationProfileName = '__Legacy Migration__';
    const profileNames = new Set([migrationProfileName]);
    for (const profile of profileDirs) profileNames.add(profile.name);
    for (const source of sources.filter((entry) => entry.kind === 'posting')) {
      for (const record of source.records) profileNames.add(record.profileName);
    }
    const profileIds = createProfiles(store, profileNames);
    const run = store.startRun({ requestId: 'migration-run' });

    // Non-queued states go first so leaseNext can only claim the item just inserted.
    const ordered = [...built.candidates].sort((a, b) => {
      if (a.state === 'queued' && b.state !== 'queued') return 1;
      if (a.state !== 'queued' && b.state === 'queued') return -1;
      return 0;
    });
    const itemForRef = new Map();
    ordered.forEach((candidate, index) => {
      const profileId = profileIds.get(candidate.profileName) || profileIds.get(migrationProfileName);
      const imported = importCandidate({ store, candidate, profileId, runId: run.id, index });
      candidate.itemId = imported.id;
      for (const ref of candidate.sourceRefs) {
        const key = `${ref.sourceId}:${ref.ordinal}`;
        if (!itemForRef.has(key)) itemForRef.set(key, { itemId: imported.id, disposition: ref.disposition });
      }
    });
    const eligibleCandidates = built.candidates
      .filter((candidate) => ['queued', 'deferred'].includes(candidate.state))
      .sort((a, b) => {
        const aOrder = Number.isInteger(a.queueOrdinal) ? a.queueOrdinal : Number.MAX_SAFE_INTEGER;
        const bOrder = Number.isInteger(b.queueOrdinal) ? b.queueOrdinal : Number.MAX_SAFE_INTEGER;
        return aOrder - bOrder;
      });
    store._immediate(() => {
      eligibleCandidates.forEach((candidate, index) => {
        store.db.prepare(`UPDATE workflow_items SET queue_seq = ? WHERE id = ?`)
          .run(-(index + 1), candidate.itemId);
      });
      const availableNow = Date.now();
      eligibleCandidates.forEach((candidate, index) => {
        store.db.prepare(`
          UPDATE workflow_items
          SET queue_seq = ?, available_at_ms = CASE
            WHEN state = 'deferred' THEN ? ELSE available_at_ms END
          WHERE id = ?
        `).run(index + 1, availableNow, candidate.itemId);
      });
      store.db.prepare(`UPDATE workflow_counters SET value = ? WHERE name = 'queue_seq'`)
        .run(eligibleCandidates.length);
    });
    store.finishRun({ runId: run.id, status: 'closed', requestId: 'migration-run-finished' });

    const now = Date.now();
    store._immediate(() => {
      for (const source of sources) {
        const manifest = backup.manifestSources.find((entry) => entry.id === source.id);
        store.db.prepare(`
          INSERT INTO migration_sources (
            id, logical_name, source_path, byte_size, sha256,
            record_count, backup_relative_path, imported_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          source.id,
          source.logicalName,
          source.filePath,
          source.byteSize,
          source.sha256,
          source.records.length,
          manifest.backupRelativePath,
          now,
        );
        for (const record of source.records) {
          const mapping = itemForRef.get(`${source.id}:${record.ordinal}`);
          store.db.prepare(`
            INSERT INTO migration_rows (source_id, source_ordinal, item_id, disposition)
            VALUES (?, ?, ?, ?)
          `).run(source.id, record.ordinal, mapping ? mapping.itemId : null, mapping ? mapping.disposition : 'conflict');
        }
      }
      for (const details of built.conflicts) {
        store.db.prepare(`
          INSERT INTO migration_conflicts (id, conflict_type, details_json, created_at_ms)
          VALUES (?, ?, ?, ?)
        `).run(crypto.randomUUID(), details.type, JSON.stringify(details), now);
      }
      const marker = {
        version: MIGRATION_VERSION,
        completedAtMs: now,
        sourceCount: sources.length,
        recordCount: sources.reduce((sum, source) => sum + source.records.length, 0),
        itemCount: built.candidates.length,
        conflictCount: built.conflicts.length,
        backupName: backup.backupName,
      };
      store.db.prepare(`
        INSERT INTO workflow_metadata(key, value_json, updated_at_ms)
        VALUES ('legacy_import_complete', ?, ?)
      `).run(JSON.stringify(marker), now);
    });

    const integrity = store.integrityCheck();
    if (!integrity.ok) fail('MIGRATION_INTEGRITY_FAILED', 'Stage database failed integrity checks', integrity);
    store.close();
    store = null;
    faultInjector('after_stage_commit');

    faultInjector('before_source_recheck');
    verifySourcesUnchanged(sources);
    promoteMedia(stageRoot, resolvedRoot);
    faultInjector('after_media_promotion');
    verifySourcesUnchanged(sources);

    if (fs.existsSync(finalDbPath)) fail('FINAL_DB_APPEARED', 'workflow.sqlite appeared before promotion');
    fs.renameSync(stageDbPath, finalDbPath);
    fsyncDirectory(resolvedRoot);
    faultInjector('after_db_promotion');

    const verified = readCompletedMigration(finalDbPath, resolvedRoot);
    const finalStore = new WorkflowStore({ rootDir: resolvedRoot, dbPath: finalDbPath });
    try {
      const finalIntegrity = finalStore.integrityCheck();
      if (!finalIntegrity.ok) fail('MIGRATION_INTEGRITY_FAILED', 'Promoted database failed integrity checks', finalIntegrity);
    } finally {
      finalStore.close();
    }
    fs.rmSync(stageRoot, { recursive: true, force: true });
    stageRoot = null;
    return { ...verified, alreadyComplete: false };
  } catch (error) {
    if (store) {
      try { store.close(); } catch {}
      store = null;
    }
    if (stageRoot) fs.rmSync(stageRoot, { recursive: true, force: true });
    throw error;
  } finally {
    if (lockFd !== undefined) {
      fs.closeSync(lockFd);
      try { fs.unlinkSync(lockPath); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
}

module.exports = {
  LegacyMigrationError,
  migrateLegacyWorkflow,
};
