'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadGenerationHarness, response } = require('./helpers/generation-harness');
const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yj-distinct-overlap-'));
const texts = [
  'قبل استخدام المحفظة الرقمية افحص إعدادات الحماية واختر كلمة مرور طويلة وفريدة تمنع تخمين الوصول إلى الحساب.',
  'قبل استخدام المحفظة الرقمية افحص إعدادات الحماية واختبر استعادة النسخة الاحتياطية على جهاز منفصل حتى لا تكتشف تلفها متأخرا.',
];
let h; let calls = 0;
(async () => {
  h = loadGenerationHarness({ rootDir, fetchFixture: async (_url, opts) => {
    const req = JSON.parse(opts.body);
    if (req.messages[0].content.includes('محكم دلالي')) {
      await new Promise(resolve => setTimeout(resolve, 35));
      return response('{"duplicate":false}');
    }
    const n = calls++;
    if (n >= texts.length) {
      // Do not cancel a sibling's still-running verification. Let both
      // meaningful attempts settle before terminating an exhausted fixture.
      await new Promise(resolve => setTimeout(resolve, 250));
      await h.invoke('cancel-ai-generation'); return response([]);
    }
    return response([texts[n]]);
  } });
  const store = await h.queue.getStore();
  store.indexFtsText('أمان المحفظة الرقمية يشمل إدارة كلمات المرور والنسخ الاحتياطية بشكل مستقل.');
  const result = await h.generate({ quantity: 2, sessionCount: 2, customPrompt: 'اكتب الفكرة كاملة دون إضافات' });
  assert.strictEqual(result.count, 2, 'a coarse shared prefix is not proof that two ideas duplicate each other');
  assert.strictEqual(store.listGeneratedDrafts().length, 2);
  console.log('✅ concurrent distinct ideas sharing an opening are not rejected by a coarse reservation');
})().finally(async () => { if (h) await h.close(); fs.rmSync(rootDir, { recursive: true, force: true }); })
 .catch(error => { console.error(error); process.exitCode = 1; });
