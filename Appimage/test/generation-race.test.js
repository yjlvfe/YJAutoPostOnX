'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadGenerationHarness, response } = require('./helpers/generation-harness');
const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yj-generation-race-'));
const a = 'قبل دخول الصفقة حدد حجم المركز ووقف الخسارة لحماية رأس المال ولا تغير الخطة أثناء التقلبات المفاجئة';
const b = 'لحماية رأس المال حدد وقف الخسارة وحجم المركز قبل دخول الصفقة ولا تغير الخطة أثناء التقلبات المفاجئة';
let harness;
let calls = 0;
let judges = 0;
const waiters = [];
(async () => {
  harness = loadGenerationHarness({ rootDir, fetchFixture: async (_url, options) => {
    const req = JSON.parse(options.body);
    if (req.messages[0].content.includes('محكم دلالي')) {
      judges++;
      // Force BOTH sessions past their initial check before either can commit.
      if (judges <= 2) await new Promise(resolve => {
        waiters.push(resolve);
        if (waiters.length === 2) waiters.splice(0).forEach(r => r());
      });
      // The first checks see only unrelated archive evidence. Once one body
      // commits, the second must be judged against that new same-idea body.
      return response(JSON.stringify({ duplicate: req.messages[1].content.includes('1. ' + a.slice(0, 200)) || req.messages[1].content.includes('1. ' + b.slice(0, 200)) }));
    }
    calls++;
    if (calls > 2) {
      await harness.invoke('cancel-ai-generation');
      return response([]);
    }
    return response([calls === 1 ? a : b]);
  } });
  const store = await harness.queue.getStore();
  store.indexFtsText('دراسة حركة العملات تشرح التقلبات في الأسواق ولا تقدم توصية استثمارية مباشرة');
  const result = await harness.generate({ quantity: 2, sessionCount: 2 });
  assert.strictEqual(judges, 3, 'both initial judgments and one post-await admission recheck must run');
  assert.strictEqual(result.count, 1, 'only one semantic paraphrase may commit after concurrent judge responses');
  console.log('✅ actual generation handler rejects the concurrent paraphrase at final commit');
})().finally(async () => {
  if (harness) await harness.close();
  fs.rmSync(rootDir, { recursive: true, force: true });
}).catch(error => { console.error(error); process.exitCode = 1; });
