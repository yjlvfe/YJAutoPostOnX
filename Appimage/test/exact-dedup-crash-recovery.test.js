'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');
const { once } = require('events');
const { WorkflowStore } = require('../dev/automation/workflowStore');
const { exactKey } = require('../dev/automation/semanticIndex');
const pending = 'لا تحتفظ بعبارة الاسترداد داخل صورة على هاتف متصل بالشبكة حتى لا تنتقل إلى نسخة سحابية غير آمنة.';
const committed = 'اختبر استعادة النسخة الاحتياطية على جهاز منفصل قبل الاعتماد عليها حتى لا تكتشف نقص الكلمات بعد ضياع المحفظة.';

if (process.argv[2] === '--child') {
  const store = new WorkflowStore({ rootDir: process.argv[3] });
  const text = process.argv[4] === 'commit' ? committed : pending;
  assert.strictEqual(store.reserveExactHash(exactKey(text), text), true);
  if (process.argv[4] === 'commit') assert.strictEqual(store.commitExactHash(exactKey(text), text), true);
  process.send('ready');
  setInterval(() => {}, 1000);
} else {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yj-crash-recovery-'));
  const children = new Set();
  let store;
  async function crashAt(mode) {
    const child = fork(__filename, ['--child', rootDir, mode], {
      execPath: process.execPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    children.add(child);
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    try {
      await Promise.race([
        once(child, 'message').then(([message]) => assert.strictEqual(message, 'ready')),
        once(child, 'exit').then(() => { throw new Error('child exited before durable boundary'); }),
      ]);
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      const [code, signal] = await exited;
      assert.strictEqual(code, null);
      assert.strictEqual(signal, 'SIGKILL');
    } finally { clearTimeout(timer); children.delete(child); }
  }
  (async () => {
    await crashAt('reserve');
    store = new WorkflowStore({ rootDir });
    assert.strictEqual(store.reserveExactHash(exactKey(pending), pending), false, 'unexpired dead lease is not stolen');
    const now = Date.now;
    try {
      Date.now = () => now() + 60001;
      assert.strictEqual(store.reserveExactHash(exactKey(pending), pending), true, 'expired lease is recoverable after process crash');
      assert.strictEqual(store.commitExactHash(exactKey(pending), pending), true);
    } finally { Date.now = now; }
    store.close(); store = null;
    await crashAt('commit');
    store = new WorkflowStore({ rootDir });
    assert.deepStrictEqual(new Set(store.listGeneratedDrafts().map(row => row.text)), new Set([pending, committed]));
    assert.strictEqual(store.reserveExactHash(exactKey(committed), committed), false);
    assert.ok(store.searchSimilarTexts(committed).includes(committed));
    assert.strictEqual(store.db.pragma('quick_check', { simple: true }), 'ok');
    console.log('✅ SIGKILL recovery preserves committed body/FTS and reclaims an expired pending lease');
  })().finally(() => {
    for (const child of children) child.kill('SIGKILL');
    if (store) store.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  }).catch(error => { console.error(error); process.exitCode = 1; });
}
