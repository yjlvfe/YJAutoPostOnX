'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadGenerationHarness, response } = require('./helpers/generation-harness');
const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yj-retrieval-failure-'));
let h;
(async () => {
  h = loadGenerationHarness({ rootDir, fetchFixture: async () => response(['احتفظ بعبارة الاسترداد بعيدا عن الأجهزة المتصلة بالشبكة حتى لا يؤدي اختراق الهاتف إلى سرقة مفاتيح المحفظة.']) });
  const store = await h.queue.getStore();
  const prepare = store.db.prepare.bind(store.db);
  store.db.prepare = sql => {
    if (sql.includes('WHERE dedup_fts MATCH')) throw new Error('FIXTURE_ARCHIVE_READ_FAILED');
    return prepare(sql);
  };
  const result = await h.generate({ quantity: 1 });
  assert.strictEqual(result.count || 0, 0, 'archive failure must never certify uniqueness');
  assert.ok(!result.success);
  assert.ok(result.error?.includes('FIXTURE_ARCHIVE_READ_FAILED'), 'infrastructure error must surface, not be counted as a duplicate');
  assert.strictEqual(store.listGeneratedDrafts().length, 0);
  store.db.prepare = prepare;
  console.log('✅ archive lookup failure fails visibly before accepting a draft');
})().finally(async () => { if (h) await h.close(); fs.rmSync(rootDir, { recursive: true, force: true }); })
 .catch(error => { console.error(error); process.exitCode = 1; });
