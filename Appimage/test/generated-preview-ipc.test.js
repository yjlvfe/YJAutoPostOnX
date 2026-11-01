'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadGenerationHarness, response } = require('./helpers/generation-harness');
const { SemanticIndex } = require('../dev/automation/semanticIndex');
const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yj-preview-ipc-'));
let h;
let fixtureCalls = 0;
let retrying = false;
(async () => {
  h = loadGenerationHarness({ rootDir, fetchFixture: async () => {
    if (retrying && ++fixtureCalls > 1) { await h.invoke('cancel-ai-generation'); return response([]); }
    return response(['افصل نسخة عبارة الاسترداد عن هاتفك المتصل بالشبكة لتجنب فقدان الأصل والنسخة الاحتياطية في حادث واحد.']);
  } });
  const result = await h.generate({ quantity: 1 });
  assert.strictEqual(result.count, 1);
  const firstPage = await h.invoke('get-generated-preview', { limit: 1 });
  assert.deepStrictEqual(firstPage.map(x => x.text), result.posts);
  assert.deepStrictEqual(await h.invoke('get-generated-preview', { after: firstPage[0].seq }), []);
  const store = await h.queue.getStore();
  assert.strictEqual(store.listQueued().length, 0, 'generation must not auto-enqueue or publish drafts');
  // A new run must use the durable preview even when the caller ships no
  // existingTexts over IPC. A repeated body cannot be accepted again.
  assert.strictEqual((await h.invoke('reset-sessions')).success, true);
  retrying = true;
  const repeated = await h.generate({ quantity: 1 });
  assert.strictEqual(repeated.count, 0, 'durable preview must block an exact repeat without an IPC corpus');
  assert.ok(repeated.duplicates > 0);
  assert.deepStrictEqual((await h.invoke('get-generated-preview')).map(x => x.text), result.posts);
  assert.strictEqual((await h.invoke('clear-generated-preview')).success, true);
  assert.deepStrictEqual(await h.invoke('get-generated-preview'), []);
  // The UI used to send queue bodies before preview bodies. Verify that the
  // replacement reads the durable queue into the active window as well.
  const queuedBody = 'لا تشارك عبارة الاسترداد مع أي شخص واحتفظ بنسخة مستقلة بعيدا عن الأجهزة المتصلة.';
  assert.strictEqual((await h.queue.addPosts([queuedBody])).added, 1);
  assert.strictEqual((await h.invoke('reset-sessions')).success, true);
  const addedTexts = [];
  const add = SemanticIndex.prototype.add;
  SemanticIndex.prototype.add = function(text) { addedTexts.push(text); return add.call(this, text); };
  fixtureCalls = 1;
  try { await h.generate({ quantity: 1 }); } finally { SemanticIndex.prototype.add = add; }
  assert.ok(addedTexts.includes(queuedBody), 'durable queue must be loaded into the bounded active semantic window');
  console.log('✅ paged preview IPC restores drafts without enqueueing; clear is explicit; durable preview and queue participate in dedup');
})().finally(async () => { if (h) await h.close(); fs.rmSync(rootDir, { recursive: true, force: true }); })
  .catch(e => { console.error(e); process.exitCode = 1; });
