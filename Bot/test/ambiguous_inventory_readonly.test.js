'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildAmbiguousInventory } = require('../src/ambiguousAudit');

test('ambiguous inventory is non-mutating, bounded and never marks an item safe to retry', () => {
  const state = {
    items: [
      { id:'a', state:'ambiguous', accountId:'acc',
        reason:'publish_confirmation_missing',
        failureDiagnostic:{observedAt:'2026-11-03T04:17:16.211Z', xErrorCode:187,
          xResponseKind:'graphql_errors', xErrorMessage:'Status is a duplicate.'} },
      { id:'b', state:'ambiguous', reason:'legacy_unknown' },
      { id:'c', state:'pending', reason:null }
    ],
    forensicLogs: [{
      eventType:'post_ambiguous', timestamp:'2026-11-03T04:17:16Z',
      details:{itemId:'a'}, xErrorCode:187, xErrorMessage:'auth_token=SECRET_EXAMPLE_TOKEN'
    }]
  };
  const before = JSON.stringify(state);
  const items = buildAmbiguousInventory(state);
  assert.equal(items.length, 2);
  assert.equal(items[0].xErrorCode, 187);
  assert.equal(items[0].requeueApproved, false);
  assert.equal(items[1].evidenceStatus, 'HISTORICAL_EVIDENCE_MISSING');
  assert.ok(!JSON.stringify(items).includes('SECRET_EXAMPLE_TOKEN'));
  assert.equal(JSON.stringify(state), before);
});

test('audit CLI creates no write-capable SQLite connection or queue mutations', () => {
  const cli = fs.readFileSync(path.join(__dirname,'../scripts/audit_ambiguous_readonly.js'),'utf8');
  assert.match(cli, /readOnly:\s*true/);
  assert.match(cli, /SELECT json, revision FROM state/);
  assert.doesNotMatch(cli, /\.update\(|UPDATE state|INSERT INTO|DELETE FROM|\.create_tweet\(/);
});
