'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadGenerationHarness, response } = require('./helpers/generation-harness');
const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yj-bounded-archive-'));
let h;
(async () => {
  h = loadGenerationHarness({ rootDir, fetchFixture: async () => response(['انسخ عبارة الاسترداد على ورقة واحفظها بعيدا عن الأجهزة المتصلة بالشبكة لتقليل خطر الاختراق الإلكتروني.']) });
  await h.queue.getStore();
  let fullReads = 0;
  h.queue.getPublishedTexts = () => { fullReads++; throw new Error('FULL_ARCHIVE_MATERIALIZATION'); };
  h.queue.getQueue = () => { fullReads++; throw new Error('FULL_QUEUE_MATERIALIZATION'); };
  const result = await h.generate({ quantity: 1 });
  assert.strictEqual(result.count, 1);
  assert.strictEqual(fullReads, 0, 'generation must not request entire archive/queue arrays');
  const store = await h.queue.getStore();
  assert.ok(store.searchSimilarTexts(result.posts[0]).includes(result.posts[0]));
  console.log('✅ generation initializes through bounded disk backfill, not full-archive text arrays');
})().finally(async () => { if (h) await h.close(); fs.rmSync(rootDir, { recursive: true, force: true }); })
 .catch(e => { console.error(e); process.exitCode = 1; });
