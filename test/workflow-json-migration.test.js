'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkflowStore } = require('../dev/automation/workflowStore');
const { migrateLegacyWorkflow } = require('../dev/automation/workflowMigration');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function sha(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xposter-workflow-migration-'));
const legacyShared = path.join(root, 'legacy-shared');
const legacyProfile = path.join(root, 'legacy-profile-other');
const stateRoot = path.join(root, 'new-state');
const mediaPath = path.join(root, 'legacy-media', 'image.png');
fs.mkdirSync(path.dirname(mediaPath), { recursive: true });
fs.writeFileSync(mediaPath, Buffer.from('legacy-media-content'));

const sources = {
  queue: path.join(legacyShared, 'queue.json'),
  published: path.join(legacyShared, 'published.json'),
  posting: path.join(legacyShared, 'posting-state.json'),
  pending: path.join(legacyProfile, 'pending-verification.json'),
  dead: path.join(legacyProfile, 'dead-letters.json'),
  deferred: path.join(legacyProfile, 'deferred-posts.json'),
};

writeJson(sources.queue, [
  { text: 'queued media', media_path: mediaPath, metadata: { origin: 'legacy' } },
  'ambiguous shared',
  'dead item',
  'deferred item',
]);
writeJson(`${sources.queue}.bak`, ['older queue backup retained for forensic recovery']);
writeJson(sources.published, [{ text: 'published one', publishedAt: '2026-01-01T00:00:00.000Z' }]);
writeJson(sources.posting, {
  '2- Other': { text: 'ambiguous shared', startedAt: '2026-01-02T00:00:00.000Z' },
});
writeJson(sources.pending, [{ text: 'pending orphan', reason: 'legacy_pending' }]);
writeJson(sources.dead, [{ text: 'dead item', reason: 'legacy_dead' }]);
writeJson(sources.deferred, [
  { text: 'deferred item', attempts: 2, lastError: 'network' },
  { text: 'deferred orphan', attempts: 1, lastError: 'network' },
]);

const beforeHashes = Object.fromEntries(Object.entries(sources).map(([key, value]) => [key, sha(value)]));
const queueBakHash = sha(`${sources.queue}.bak`);

let store;
try {
  const migration = migrateLegacyWorkflow({
    rootDir: stateRoot,
    sharedDir: legacyShared,
    profileDirs: [{ name: '2- Other', dir: legacyProfile }],
  });
  assert.strictEqual(migration.alreadyComplete, false);
  assert.strictEqual(migration.conflicts.length, 0);
  assert.ok(fs.existsSync(path.join(stateRoot, 'workflow.sqlite')));
  assert.ok(!fs.existsSync(path.join(stateRoot, 'workflow.sqlite-wal')));
  assert.ok(!fs.existsSync(path.join(stateRoot, 'workflow.sqlite-shm')));

  const afterHashes = Object.fromEntries(Object.entries(sources).map(([key, value]) => [key, sha(value)]));
  assert.deepStrictEqual(afterHashes, beforeHashes, 'migration must not rewrite legacy sources');
  assert.strictEqual(sha(`${sources.queue}.bak`), queueBakHash, 'migration must not rewrite legacy .bak');

  store = new WorkflowStore({ rootDir: stateRoot });
  const marker = JSON.parse(store.db.prepare(`
    SELECT value_json FROM workflow_metadata WHERE key = 'legacy_import_complete'
  `).get().value_json);
  const manifest = JSON.parse(fs.readFileSync(
    path.join(stateRoot, marker.backupName, 'manifest.json'),
    'utf8',
  ));
  const queueManifest = manifest.sources.find((source) => source.logicalName === 'shared.queue');
  assert.ok(queueManifest.auxiliaryBak, 'legacy .bak must be recorded in the immutable manifest');
  assert.ok(fs.existsSync(path.join(stateRoot, queueManifest.auxiliaryBak.backupRelativePath)));
  assert.strictEqual(
    sha(path.join(stateRoot, queueManifest.auxiliaryBak.backupRelativePath)),
    queueBakHash,
  );
  const all = store.listItems({
    states: ['queued', 'ambiguous', 'dead', 'deferred', 'published'],
    limit: 100,
  });
  assert.strictEqual(all.length, 7);

  const byText = new Map(all.map((item) => [item.payload.text, item]));
  assert.strictEqual(byText.get('queued media').state, 'queued');
  assert.strictEqual(byText.get('queued media').media[0].status, 'ready');
  assert.deepStrictEqual(fs.readFileSync(byText.get('queued media').media[0].managedPath),
    Buffer.from('legacy-media-content'));
  assert.strictEqual(byText.get('ambiguous shared').state, 'ambiguous');
  assert.strictEqual(byText.get('dead item').state, 'dead');
  assert.strictEqual(byText.get('deferred item').state, 'deferred');
  assert.strictEqual(byText.get('published one').state, 'published');
  assert.strictEqual(byText.get('pending orphan').state, 'ambiguous');
  assert.strictEqual(byText.get('pending orphan').payload.payload_incomplete, true);
  assert.strictEqual(byText.get('deferred orphan').state, 'ambiguous',
    'a deferred record without its queue payload must never become auto-eligible');
  assert.strictEqual(byText.get('deferred orphan').payload.payload_incomplete, true);
  assert.deepStrictEqual(
    store.listQueued({ limit: 100 }).map((item) => item.payload.text),
    ['queued media', 'deferred item'],
    'eligible queue/deferred rows must preserve their original queue ordinal',
  );

  const idsBefore = all.map((item) => item.id).sort();
  store.close();
  store = null;

  const replay = migrateLegacyWorkflow({
    rootDir: stateRoot,
    sharedDir: legacyShared,
    profileDirs: [{ name: '2- Other', dir: legacyProfile }],
  });
  assert.strictEqual(replay.alreadyComplete, true);

  store = new WorkflowStore({ rootDir: stateRoot });
  const idsAfter = store.listItems({
    states: ['queued', 'ambiguous', 'dead', 'deferred', 'published'],
    limit: 100,
  }).map((item) => item.id).sort();
  assert.deepStrictEqual(idsAfter, idsBefore, 'rerun must preserve UUIDs and row count');
  assert.strictEqual(store.integrityCheck().ok, true);

  console.log('✅ workflow JSON migration: precedence, payload/media, source immutability and rerun passed');
} finally {
  if (store) store.close();
  fs.rmSync(root, { recursive: true, force: true });
}
