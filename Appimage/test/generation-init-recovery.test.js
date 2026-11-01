'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadGenerationHarness, response } = require('./helpers/generation-harness');
const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yj-init-recovery-'));
let h;
(async () => {
  h = loadGenerationHarness({ rootDir, fetchFixture: async () => response(['لا تضع النسخة الورقية من عبارة الاسترداد بجوار الهاتف حتى لا تفقد النسختين في حادث واحد.']) });
  const store = await h.queue.getStore();
  const sync = store.syncDedupIndex;
  store.syncDedupIndex = () => { throw new Error('FIXTURE_INDEX_UNAVAILABLE'); };
  const first = await h.generate({ quantity: 1 }).catch(error => ({ error: error.message }));
  assert.ok(first.error.includes('FIXTURE_INDEX_UNAVAILABLE'), 'failure must be reported, not bypassed');
  store.syncDedupIndex = sync;
  const second = await h.generate({ quantity: 1 });
  assert.strictEqual(second.count, 1, 'initialization failure must release the generation-active gate for retry');
  console.log('✅ failed index initialization reports an error and a subsequent generation can run');
})().finally(async () => { if (h) await h.close(); fs.rmSync(rootDir, { recursive: true, force: true }); })
  .catch(error => { console.error(error); process.exitCode = 1; });
