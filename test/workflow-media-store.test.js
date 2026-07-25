'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  WorkflowStore,
  WorkflowValidationError,
} = require('../dev/automation/workflowStore');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xposter-workflow-media-'));
const sourceDir = path.join(root, 'source');
fs.mkdirSync(sourceDir, { recursive: true });
const source = path.join(sourceDir, 'photo.png');
const bytes = Buffer.from('synthetic-media-bytes-for-durability-test');
fs.writeFileSync(source, bytes);
const expectedHash = crypto.createHash('sha256').update(bytes).digest('hex');

let store;
try {
  store = new WorkflowStore({ rootDir: path.join(root, 'state') });

  const first = store.enqueue({
    items: [{
      text: 'post with media',
      media_path: source,
      metadata: { alt: 'synthetic' },
    }],
    requestId: 'media-enqueue-1',
  }).items[0];

  assert.deepStrictEqual(first.payload, {
    text: 'post with media',
    media_path: source,
    metadata: { alt: 'synthetic' },
  });
  assert.strictEqual(first.media.length, 1);
  assert.strictEqual(first.media[0].sha256, expectedHash);
  assert.strictEqual(first.media[0].byteSize, bytes.length);
  assert.strictEqual(first.media[0].status, 'ready');
  assert.ok(first.media[0].managedPath.startsWith(path.join(root, 'state', 'media')));
  assert.deepStrictEqual(fs.readFileSync(first.media[0].managedPath), bytes);

  fs.unlinkSync(source);
  const afterOriginalDeletion = store.getItem(first.id);
  assert.deepStrictEqual(fs.readFileSync(afterOriginalDeletion.media[0].managedPath), bytes,
    'managed media must survive deletion of the original path');

  const duplicateSource = path.join(sourceDir, 'same-content.png');
  fs.writeFileSync(duplicateSource, bytes);
  const second = store.enqueue({
    items: [{ text: 'another post, same blob', media_path: duplicateSource }],
    requestId: 'media-enqueue-2',
  }).items[0];
  assert.strictEqual(second.media[0].sha256, expectedHash);
  assert.strictEqual(second.media[0].managedPath, first.media[0].managedPath,
    'content-addressed media must deduplicate identical bytes');

  const beforeMissing = store.listQueued({ limit: 100 }).length;
  assert.throws(
    () => store.enqueue({
      items: [{ text: 'missing media must not degrade to text-only', media_path: path.join(sourceDir, 'missing.png') }],
      requestId: 'media-enqueue-missing',
    }),
    (error) => {
      assert.ok(error instanceof WorkflowValidationError);
      assert.strictEqual(error.code, 'MEDIA_NOT_FOUND');
      return true;
    },
  );
  assert.strictEqual(store.listQueued({ limit: 100 }).length, beforeMissing,
    'failed media import must not create a queue row');

  assert.strictEqual(store.integrityCheck().ok, true);
  fs.writeFileSync(first.media[0].managedPath, Buffer.from('corrupted-managed-media'));
  const corrupted = store.integrityCheck();
  assert.strictEqual(corrupted.ok, false);
  assert.strictEqual(corrupted.mediaProblems[0].code, 'HASH_OR_SIZE_MISMATCH');
  fs.writeFileSync(first.media[0].managedPath, bytes);
  assert.strictEqual(store.integrityCheck().ok, true);
  console.log('✅ workflow media store: hash, dedup, durability and fail-closed missing media passed');
} finally {
  if (store) store.close();
  fs.rmSync(root, { recursive: true, force: true });
}
