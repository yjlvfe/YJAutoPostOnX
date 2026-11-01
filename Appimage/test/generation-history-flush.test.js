'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yj-history-flush-'));
os.homedir = () => rootDir;
process.env.HOME = rootDir;
const atomic = require('../dev/utils/atomicJson');
const write = atomic.atomicWriteJson;
let release;
let started;
const held = new Promise(resolve => { release = resolve; });
const entered = new Promise(resolve => { started = resolve; });
let writes = 0;
atomic.atomicWriteJson = async (...args) => {
  if (++writes === 1) { started(); await held; }
  return write(...args);
};
const E = require('../dev/automation/contentEngine');
(async () => {
  E.appendHistory(['قبل انتهاء الكتابة الأولى']);
  await entered;
  E.appendHistory(['أثناء تعليق الكتابة الأولى']);
  release();
  assert.strictEqual(typeof E.flushHistory, 'function', 'shutdown must have an awaitable history drain');
  await E.flushHistory();
  const disk = JSON.parse(fs.readFileSync(E.historyPath(), 'utf8'));
  assert.deepStrictEqual(disk.map(row => row.text), ['قبل انتهاء الكتابة الأولى', 'أثناء تعليق الكتابة الأولى']);
  delete require.cache[require.resolve('../dev/automation/contentEngine')];
  const reopened = require('../dev/automation/contentEngine');
  assert.deepStrictEqual(reopened.loadHistory(), disk.map(row => row.text));
  console.log('✅ overlapping history appends drain the latest cache and survive module reopen');
})().finally(() => { atomic.atomicWriteJson = write; fs.rmSync(rootDir, { recursive: true, force: true }); })
  .catch(error => { console.error(error); process.exitCode = 1; });
