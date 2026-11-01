'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadGenerationHarness, response } = require('./helpers/generation-harness');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yj-semantic-gate-'));
const reference = 'وقف الخسارة يحمي رأس المال عند تقلب السوق ويمنع استمرار الخسائر.';
const candidate = 'وقف الخسارة لا يحمي رأس المال عند تقلب السوق ولا يمنع استمرار الخسائر.';
const deepReference = 'ترفع الرافعة المالية مخاطر تصفية حساب المتداول بسرعة عندما يتحرك السعر عكس المركز.';
const deepCandidate = 'المبالغة في الاقتراض لتكبير الصفقة قد تبتلع رصيدك خلال حركة معاكسة؛ خفض الرافعة يقلل تعرضك للتصفية.';
let h; let rounds = 0; let judges = 0; let deepJudges = 0; let mode = 'different';
let output = candidate;
(async () => {
  h = loadGenerationHarness({ rootDir: dir, fetchFixture: async (_url, options) => {
    const req = JSON.parse(options.body);
    if (req.messages[0].content.includes('محكم دلالي')) {
      judges++;
      if (mode === 'unavailable') {
        await h.invoke('cancel-ai-generation');
        return { ok: false, status: 503 };
      }
      if (mode === 'deep') {
        deepJudges++;
        assert.ok(req.messages[1].content.includes(deepReference), 'the historical paraphrase reference must reach the judge');
        await h.invoke('cancel-ai-generation');
        return response('{"duplicate":true}');
      }
      assert.ok(req.messages[1].content.includes(reference), 'actual archived reference must reach the judge');
      return response('{"duplicate":false}');
    }
    if (++rounds > 2) { await h.invoke('cancel-ai-generation'); return response([]); }
    return response([output]);
  } });
  const store = await h.queue.getStore();
  store.indexFtsText(reference);
  const first = await h.generate({ quantity: 1, customPrompt: 'اكتب الرأي كما هو دون إضافة هاشتاق' });
  assert.strictEqual(first.count, 1, 'shared words with opposite claim require semantic judgment, not automatic rejection');
  assert.ok(judges >= 1, 'polarity-changing text must reach a judge');
  await h.invoke('clear-generated-preview');
  // A completed session snapshot is intentionally non-respawnable. Start the
  // second scenario from a fresh persisted session, while retaining the same
  // isolated SQLite corpus so the archived reference remains available.
  const reset = await h.invoke('reset-sessions');
  assert.strictEqual(reset.success, true, 'reset the isolated session snapshot between scenarios');
  mode = 'unavailable'; rounds = 0;
  output = 'دفتر الأوامر يوضح مستويات السيولة المتاحة لتنفيذ الصفقة قبل استخدام وقف الخسارة.';
  // New distinct-but-overlapping text must not be silently certified while judge is down.
  const second = await h.generate({ quantity: 1, customPrompt: 'اكتب الرأي كما هو دون إضافة هاشتاق', existingTexts: [] });
  assert.strictEqual(second.count, 0);
  assert.ok(second.rejectedReasons['تعذر التحقق الدلالي'], 'unavailability must be an explicit diagnostic, not a successful clearance');
  console.log('✅ opposite claims reach semantic judgment; unavailable verification cannot certify an ambiguous draft');

  await h.invoke('clear-generated-preview');
  assert.strictEqual((await h.invoke('reset-sessions')).success, true);
  store.indexFtsText(deepReference);
  const refs = store.searchSimilarTexts(deepCandidate, 30);
  assert.ok(refs.includes(deepReference), 'the older paraphrase must be in the bounded archive retrieval set');
  const { SemanticIndex } = require('../dev/automation/semanticIndex');
  assert.strictEqual(new SemanticIndex().checkCandidate(deepCandidate, deepReference).dup, false,
    'this is not an exact or near-verbatim lexical duplicate');
  mode = 'deep'; rounds = 0; output = deepCandidate;
  const third = await h.generate({ quantity: 1, customPrompt: 'اكتب الرأي كما هو دون إضافة هاشتاق', existingTexts: [] });
  assert.strictEqual(third.count, 0, 'fixture judge must reject the reworded historical same-core claim');
  assert.ok(deepJudges >= 1);
  assert.ok(third.rejectedReasons['مكرر بالمعنى (إعادة صياغة لفكرة موجودة)']);
  assert.strictEqual(store.listGeneratedDrafts().length, 0);
  console.log('✅ historical deep paraphrase reaches fixture judge and is rejected without lexical auto-rejection');
})().finally(async () => { if (h) await h.close(); fs.rmSync(dir, { recursive: true, force: true }); })
.catch(e => { console.error(e); process.exitCode = 1; });
