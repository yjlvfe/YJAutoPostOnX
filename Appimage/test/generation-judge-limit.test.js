'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadGenerationHarness, response } = require('./helpers/generation-harness');
const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yj-judge-limit-'));
let h;
let calls = 0; let active = 0; let peak = 0; let judges = 0;
(async () => {
  h = loadGenerationHarness({ rootDir, fetchFixture: async (_url, opts) => {
    const req = JSON.parse(opts.body);
    if (req.messages[0].content.includes('محكم دلالي')) {
      judges++; active++; peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 150));
      active--;
      return response('{invalid}');
    }
    const n = ++calls;
    if (n > 50) { await h.invoke('cancel-ai-generation'); return response([]); }
    // Deliberately opaque distinct fixture vocabulary; tests backpressure,
    // NOT Arabic quality or semantic accuracy.
    return response([`سيولة دفتر الأوامر ${Array.from({length: 12}, (_, i) => `fixture${n}word${i}`).join(' ')}.`]);
  } });
  const store = await h.queue.getStore();
  store.indexFtsText('سيولة دفتر الأوامر تساعد المتداول في معرفة العمق المتاح قبل التنفيذ');
  await h.generate({ quantity: 50, sessionCount: 50 });
  assert.ok(judges >= 20, `must exercise many judge requests, got ${judges}`);
  assert.ok(peak <= 5, `malformed verdicts must not release slots twice: peak=${peak}`);
  assert.strictEqual(active, 0, 'all admitted judges must settle before generation completes');
  console.log(`✅ malformed judge replies preserve concurrency ceiling: ${peak}/5 peak, ${judges} calls`);
})().finally(async () => { if (h) await h.close(); fs.rmSync(rootDir, { recursive: true, force: true }); })
 .catch(e => { console.error(e); process.exitCode = 1; });
