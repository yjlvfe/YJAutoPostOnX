'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkflowStore } = require('../dev/automation/workflowStore');
const { exactKey } = require('../dev/automation/semanticIndex');

const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yj-exact-dedup-'));
const text = 'إدارة المخاطر تحمي رأس المال عبر تحديد حجم الصفقة ووقف الخسارة قبل الدخول في السوق';
// This is the key currently produced by main.js. WorkflowStore must canonicalize
// it to the same durable SHA-256 key used by enqueue().
const key = exactKey(text);
let first;
let reopened;
try {
  first = new WorkflowStore({ rootDir });
  first.enqueue({
    requestId: 'exact-dedup-persistence-test',
    items: [{ text }],
  });
  first.close();
  first = null;

  reopened = new WorkflowStore({ rootDir });
  assert.strictEqual(
    reopened.reserveExactHash(key, text),
    false,
    'an exact body already persisted in the queue must remain reserved after reopen',
  );
  console.log('✅ exact dedup reservation survives enqueue and reopen');
} finally {
  if (first) first.close();
  if (reopened) reopened.close();
  fs.rmSync(rootDir, { recursive: true, force: true });
}
