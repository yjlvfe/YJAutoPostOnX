'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkflowStore } = require('../dev/automation/workflowStore');
const { exactKey } = require('../dev/automation/semanticIndex');
const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yj-reservation-owners-'));
let a; let b;
try {
  const text = 'المحفظة الباردة تحفظ المفاتيح بعيدا عن الاتصال المستمر بالشبكة';
  const key = exactKey(text);
  a = new WorkflowStore({ rootDir });
  assert.strictEqual(a.reserveExactHash(key, text, 'A'), true);
  assert.strictEqual(a.reserveSemanticSig('cold_wallet', text, 'A'), true);
  b = new WorkflowStore({ rootDir });
  assert.strictEqual(b.reserveExactHash(key, text, 'B'), false, 'opening another connection must not erase a live exact reservation');
  assert.strictEqual(b.reserveSemanticSig('cold_wallet', text, 'B'), false, 'opening another connection must not erase a live semantic reservation');
  b.unreserveExactHash(key, text);
  b.unreserveSemanticSig('cold_wallet');
  assert.strictEqual(b.reserveExactHash(key, text), false, 'another owner cannot release our reservation');
  b.close(); b = null;
  assert.strictEqual(a.reserveExactHash(key, text), false, 'closing another owner cannot release our reservation');
  a.unreserveExactHash(key, text);
  assert.strictEqual(a.reserveExactHash(key, text), true, 'own release permits retry');
  // Simulate an interrupted owner's expired lease, not an accepted archive row.
  a.db.prepare('UPDATE dedup_exact_reservations SET created_at_ms = ?').run(Date.now() - 61_000);
  b = new WorkflowStore({ rootDir });
  assert.strictEqual(b.reserveExactHash(key, text), true, 'expired in-flight leases are recoverable without changing accepted history');
  a.unreserveExactHash(key, text);
  assert.strictEqual(b.reserveExactHash(key, text), false, 'an expired old owner cannot release the replacement lease');
  console.log('✅ reservation ownership survives independent opens and stale-owner release');
} finally {
  if (b) b.close();
  if (a) a.close();
  fs.rmSync(rootDir, { recursive: true, force: true });
}
