'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadGenerationHarness, response } = require('./helpers/generation-harness');
const { WorkflowStore } = require('../dev/automation/workflowStore');
const { exactKey } = require('../dev/automation/semanticIndex');
const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yj-generated-save-'));
let harness;
(async () => {
  harness = loadGenerationHarness({ rootDir, fetchFixture: async () => response([
    'استخدم محفظة باردة للمبالغ طويلة الأجل واحفظ عبارة الاسترداد في مكان آمن منفصل عن الجهاز المتصل بالشبكة.',
  ]) });
  const result = await harness.generate({ quantity: 1 });
  assert.strictEqual(result.count, 1, JSON.stringify(result));
  const store = await harness.queue.getStore();
  const dbPath = store.dbPath;
  await harness.queue.closeStore();
  const reopened = new WorkflowStore({ rootDir: path.dirname(dbPath) });
  try {
    const preview = reopened.listGeneratedDrafts();
    assert.strictEqual(preview.length, 1, 'an acknowledged generation must survive restart with the full body');
    assert.strictEqual(preview[0].text, result.posts[0]);
    assert.strictEqual(reopened.reserveExactHash(exactKey(result.posts[0])), false);
    assert.strictEqual(reopened.searchSimilarTexts(result.posts[0]).includes(result.posts[0]), true);
    // A failing index write cannot persist an exact hash without its body/draft.
    const other = 'أوامر الحد تمنحك تحكما بالسعر لكنها لا تضمن التنفيذ عند تحرك السوق بعيدا عن المستوى المحدد.';
    const key = exactKey(other);
    assert.strictEqual(reopened.reserveExactHash(key, other), true);
    reopened.db.exec("CREATE TRIGGER test_abort_draft BEFORE INSERT ON generated_drafts BEGIN SELECT RAISE(ABORT, 'injected save failure'); END");
    assert.throws(() => reopened.commitExactHash(key, other), /injected save failure/);
    reopened.db.exec('DROP TRIGGER test_abort_draft');
    reopened.unreserveExactHash(key, other);
    assert.strictEqual(reopened.reserveExactHash(key, other), true, 'failed save must not create a permanent phantom duplicate');
    reopened.clearGeneratedDrafts();
    assert.strictEqual(reopened.listGeneratedDrafts().length, 0);
    assert.strictEqual(reopened.reserveExactHash(exactKey(result.posts[0])), false, 'explicit preview clearing must preserve historical dedup');
  } finally { reopened.close(); }
  console.log('✅ generation commits body, preview, exact and FTS atomically; restart restores accepted text');
})().finally(async () => {
  if (harness) await harness.close();
  fs.rmSync(rootDir, { recursive: true, force: true });
}).catch(error => { console.error(error); process.exitCode = 1; });
