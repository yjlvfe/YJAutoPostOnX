'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkflowStore } = require('../dev/automation/workflowStore');
const {
  LegacyMigrationError,
  migrateLegacyWorkflow,
} = require('../dev/automation/workflowMigration');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function sha(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function finalDbExists(rootDir) {
  return fs.existsSync(path.join(rootDir, 'workflow.sqlite'));
}

function crashAfterStageCommit() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xposter-migrate-crash-'));
  try {
    const sharedDir = path.join(root, 'legacy');
    const stateDir = path.join(root, 'state');
    const queuePath = path.join(sharedDir, 'queue.json');
    writeJson(queuePath, ['survives migration crash']);
    const before = sha(queuePath);

    assert.throws(
      () => migrateLegacyWorkflow({
        rootDir: stateDir,
        sharedDir,
        profileDirs: [],
        faultInjector(point) {
          if (point === 'after_stage_commit') throw new Error('INJECTED_AFTER_STAGE_COMMIT');
        },
      }),
      /INJECTED_AFTER_STAGE_COMMIT/,
    );
    assert.strictEqual(finalDbExists(stateDir), false, 'stage crash must not expose a final DB');
    assert.strictEqual(sha(queuePath), before, 'stage crash must not change the legacy source');
    const backupsAfterCrash = fs.readdirSync(stateDir)
      .filter((name) => name.startsWith('legacy-backup-v'));
    assert.strictEqual(backupsAfterCrash.length, 1);

    migrateLegacyWorkflow({ rootDir: stateDir, sharedDir, profileDirs: [] });
    const backupsAfterRetry = fs.readdirSync(stateDir)
      .filter((name) => name.startsWith('legacy-backup-v'));
    assert.deepStrictEqual(backupsAfterRetry, backupsAfterCrash,
      'retrying the same immutable source snapshot must reuse its verified backup');
    const store = new WorkflowStore({ rootDir: stateDir });
    try {
      const rows = store.listItems({ states: ['queued'], limit: 100 });
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].payload.text, 'survives migration crash');
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function rejectConcurrentSourceChange() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xposter-migrate-source-change-'));
  try {
    const sharedDir = path.join(root, 'legacy');
    const stateDir = path.join(root, 'state');
    const queuePath = path.join(sharedDir, 'queue.json');
    writeJson(queuePath, ['original']);

    assert.throws(
      () => migrateLegacyWorkflow({
        rootDir: stateDir,
        sharedDir,
        profileDirs: [],
        faultInjector(point) {
          if (point === 'before_source_recheck') writeJson(queuePath, ['changed concurrently']);
        },
      }),
      (error) => {
        assert.ok(error instanceof LegacyMigrationError);
        assert.strictEqual(error.code, 'LEGACY_SOURCE_CHANGED');
        return true;
      },
    );
    assert.strictEqual(finalDbExists(stateDir), false,
      'a changed source must abort promotion instead of publishing a stale snapshot');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function rejectCorruptPrimaryEvenWithBak() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xposter-migrate-corrupt-primary-'));
  try {
    const sharedDir = path.join(root, 'legacy');
    const stateDir = path.join(root, 'state');
    fs.mkdirSync(sharedDir, { recursive: true });
    const queuePath = path.join(sharedDir, 'queue.json');
    fs.writeFileSync(queuePath, '{not valid JSON');
    writeJson(`${queuePath}.bak`, ['must not be silently resurrected']);

    assert.throws(
      () => migrateLegacyWorkflow({ rootDir: stateDir, sharedDir, profileDirs: [] }),
      (error) => {
        assert.ok(error instanceof LegacyMigrationError);
        assert.strictEqual(error.code, 'LEGACY_SOURCE_INVALID');
        return true;
      },
    );
    assert.strictEqual(finalDbExists(stateDir), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function recoverPromotionBoundary(point, finalExpectedAfterFault) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `xposter-migrate-${point}-`));
  try {
    const sharedDir = path.join(root, 'legacy');
    const stateDir = path.join(root, 'state');
    writeJson(path.join(sharedDir, 'queue.json'), [`item-${point}`]);
    assert.throws(
      () => migrateLegacyWorkflow({
        rootDir: stateDir,
        sharedDir,
        profileDirs: [],
        faultInjector(current) {
          if (current === point) throw new Error(`INJECTED_${point}`);
        },
      }),
      new RegExp(`INJECTED_${point}`),
    );
    assert.strictEqual(finalDbExists(stateDir), finalExpectedAfterFault);
    const recovered = migrateLegacyWorkflow({ rootDir: stateDir, sharedDir, profileDirs: [] });
    assert.strictEqual(recovered.alreadyComplete, finalExpectedAfterFault,
      'after DB promotion, restart must reuse final; before DB promotion it must rebuild');
    const store = new WorkflowStore({ rootDir: stateDir });
    try {
      const rows = store.listItems({ states: ['queued'], limit: 100 });
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].payload.text, `item-${point}`);
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function recoverStaleLockButRespectLiveLock() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xposter-migrate-lock-'));
  try {
    const sharedDir = path.join(root, 'legacy');
    const stateDir = path.join(root, 'state');
    fs.mkdirSync(sharedDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    const lockPath = path.join(stateDir, 'legacy-migration.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 99999999, startedAt: 'stale' }));
    const migrated = migrateLegacyWorkflow({ rootDir: stateDir, sharedDir, profileDirs: [] });
    assert.strictEqual(migrated.alreadyComplete, false, 'a dead PID lock must not block restart forever');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  const liveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xposter-migrate-live-lock-'));
  try {
    const sharedDir = path.join(liveRoot, 'legacy');
    const stateDir = path.join(liveRoot, 'state');
    fs.mkdirSync(sharedDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'legacy-migration.lock'),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
    assert.throws(
      () => migrateLegacyWorkflow({ rootDir: stateDir, sharedDir, profileDirs: [] }),
      (error) => error instanceof LegacyMigrationError && error.code === 'MIGRATION_LOCKED',
    );
    assert.strictEqual(fs.existsSync(path.join(stateDir, 'legacy-migration.lock')), true,
      'a rejected contender must not delete the live owner lock');
  } finally {
    fs.rmSync(liveRoot, { recursive: true, force: true });
  }
}

crashAfterStageCommit();
rejectConcurrentSourceChange();
rejectCorruptPrimaryEvenWithBak();
recoverPromotionBoundary('after_media_promotion', false);
recoverPromotionBoundary('after_db_promotion', true);
recoverStaleLockButRespectLiveLock();
console.log('✅ workflow migration faults: stage/source/media/DB promotion, corrupt primary and lock recovery passed');
