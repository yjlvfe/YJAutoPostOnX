'use strict';
// Real Electron renderer, preload and SQLite; no transport or publishing.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const rootDir = fs.mkdtempSync(path.resolve(os.tmpdir(), 'yj-preview-ui-'));
os.homedir = () => rootDir;
process.env.HOME = rootDir;
global.fetch = async () => { throw new Error('NETWORK_FORBIDDEN'); };
const { app } = require('electron');
app.setPath('userData', path.join(rootDir, 'userData'));
const { WorkflowStore } = require('../dev/automation/workflowStore');
const { exactHash } = require('../dev/automation/semanticIndex');
const sharedDir = path.join(rootDir, '.config', 'x-poster-shared');
require('../dev/automation/workflowMigration').migrateLegacyWorkflow({ rootDir: sharedDir, sharedDir, profileDirs: [] });
const store = new WorkflowStore({ rootDir: sharedDir });
const COUNT = 45000;
const protectedText = 'افصل نسخة عبارة الاسترداد عن هاتفك كي لا تفقد النسختين معا عند ضياع الجهاز.';
store.reserveExactHash(exactHash(protectedText), protectedText);
store.commitExactHash(exactHash(protectedText), protectedText);
store.db.transaction(() => {
  const insert = store.db.prepare('INSERT INTO generated_drafts (sha256, text, created_at_ms) VALUES (?, ?, ?)');
  for (let i = 1; i < COUNT; i++) {
    const text = `نص معاينة معزول لاختبار استعادة الدفعات الافتراضية من القرص دون تشغيل التوليد أو النشر رقم ${i}.`;
    insert.run(exactHash(text), text, Date.now());
  }
})();
store.close();
let done = false;
let timer;
async function finish(error) {
  if (done) return;
  done = true; clearTimeout(timer);
  try { await require('../dev/automation/durableQueue').closeStore(); } catch {}
  fs.rmSync(rootDir, { recursive: true, force: true });
  if (error) console.error(error);
  app.exit(error ? 1 : 0);
}
app.on('browser-window-created', (_event, win) => {
  win.webContents.once('did-finish-load', async () => {
    try {
      const result = await win.webContents.executeJavaScript(`(async () => {
        const deadline = performance.now() + 25000;
        while (state.generated.length !== ${COUNT} && performance.now() < deadline) await new Promise(r => setTimeout(r, 25));
        document.querySelector('[data-view="studio"]').click();
        flushPreview();
        await new Promise(r => setTimeout(r, 100));
        return { count: state.generated.length, cards: document.getElementById('results-list').querySelector('.vlist-spacer').children.length, text: document.getElementById('results-count').textContent };
      })()`);
      assert.strictEqual(result.count, COUNT);
      assert.ok(result.cards > 0 && result.cards < 100, `virtual DOM must stay bounded, got ${result.cards}`);
      await win.webContents.executeJavaScript(`document.getElementById('btn-clear-preview').click()`);
      const cleared = await win.webContents.executeJavaScript(`(async () => {
        const end = performance.now() + 5000;
        while (state.generated.length && performance.now() < end) await new Promise(r => setTimeout(r, 20));
        return { count: state.generated.length, disk: (await window.api.getGeneratedPreview()).length };
      })()`);
      assert.deepStrictEqual(cleared, { count: 0, disk: 0 });
      const reopened = await require('../dev/automation/durableQueue').getStore();
      assert.strictEqual(reopened.reserveExactHash(exactHash(protectedText), protectedText), false, 'clear removes preview, not historical duplicate protection');
      assert.strictEqual(reopened.listQueued().length, 0, 'restoration must not enqueue');
      console.log(JSON.stringify({ preview_rows_restored: result.count, mounted_cards: result.cards, cleared: true, publishing: false }));
      await finish();
    } catch (error) { await finish(error); }
  });
});
require('../dev/main');
timer = setTimeout(() => finish(new Error('Preview renderer did not settle within 35s')), 35000);
