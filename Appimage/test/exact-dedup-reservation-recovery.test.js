'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkflowStore } = require('../dev/automation/workflowStore');
const { exactKey } = require('../dev/automation/semanticIndex');

const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yj-exact-reservation-'));
const text = 'خطة إدارة رأس المال تحدد حجم الصفقة ووقف الخسارة قبل اتخاذ قرار التداول';
const key = exactKey(text);
let store;
try {
  store = new WorkflowStore({ rootDir });
  assert.strictEqual(store.reserveExactHash(key, text), true, 'a new candidate can be reserved');
  store.close();
  store = null;

  // An in-flight reservation is not proof of acceptance. A restart must not
  // turn an interrupted candidate into a permanent duplicate.
  store = new WorkflowStore({ rootDir });
  assert.strictEqual(
    store.reserveExactHash(key, text),
    true,
    'an interrupted in-flight exact reservation is recoverable after restart',
  );
  assert.strictEqual(
    store.commitExactHash(key, text),
    true,
    'the accepted candidate becomes a durable exact entry only at commit',
  );
  assert.strictEqual(
    store.reserveExactHash(key, text),
    false,
    'a committed exact entry remains blocked in the same process',
  );
  store.close();
  store = null;

  store = new WorkflowStore({ rootDir });
  assert.strictEqual(
    store.reserveExactHash(key, text),
    false,
    'a committed exact entry remains blocked after reopen',
  );
  console.log('✅ exact reservations recover after restart and commits remain durable');
} finally {
  if (store) store.close();
  fs.rmSync(rootDir, { recursive: true, force: true });
}
