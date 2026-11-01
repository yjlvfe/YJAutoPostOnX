'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadGenerationHarness, response } = require('./helpers/generation-harness');
const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yj-bulk-add-race-'));
let h;
(async () => {
  h = loadGenerationHarness({ rootDir, fetchFixture: async () => response([]) });
  const store = await h.queue.getStore();
  const batch = Array.from({ length: 1001 }, (_, i) => `ملاحظة مستقلة للتخزين رقم ${i} تشرح الاختبار دون إرسال أي شيء للخارج`);
  const results = await Promise.all([h.queue.addPosts(batch), h.queue.addPosts([batch[1000]])]);
  assert.strictEqual(store.db.prepare('SELECT COUNT(*) n FROM workflow_items WHERE payload_text = ?').get(batch[1000]).n, 1, 'concurrent chunked adds must not insert the same backlog payload twice');
  assert.strictEqual(store.db.prepare('SELECT COUNT(*) n FROM workflow_items').get().n, 1001);
  assert.strictEqual(results.reduce((n, x) => n + x.added, 0), 1001);
  assert.strictEqual(results.reduce((n, x) => n + x.skippedDuplicate, 0), 1);
  console.log('✅ concurrent bulk adds commit 1001 unique rows and report one duplicate');
})().finally(async () => { if (h) await h.close(); fs.rmSync(rootDir, { recursive: true, force: true }); })
 .catch(e => { console.error(e); process.exitCode = 1; });
