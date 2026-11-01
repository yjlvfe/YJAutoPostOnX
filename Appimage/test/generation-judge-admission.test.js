'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { WorkflowStore } = require('../dev/automation/workflowStore');

const reference = 'منشور مرجعي عن دفتر الأوامر والسيولة في السوق';
const overlappingQuery = 'فكرة جديدة عن دفتر الأوامر والسيولة';
const unrelatedQuery = 'فكرة مستقلة عن حماية المحفظة من التصيد';
const reportDir = path.join(__dirname, '..', 'reports', 'engineering-20261026', 'delegate-judge');
fs.mkdirSync(reportDir, { recursive: true });
const rootDir = fs.mkdtempSync(path.join(reportDir, 'fixture-'));
let store;
try {
  store = new WorkflowStore({ rootDir });
  store.enqueue({
    items: [{ text: reference }],
    requestId: 'judge-admission-reference',
  });

  const overlappingCandidates = store.searchSimilarTexts(overlappingQuery, 30);
  assert.ok(
    overlappingCandidates.includes(reference),
    'lexically overlapping recent rows remain eligible for semantic judgment',
  );

  const candidates = store.searchSimilarTexts(unrelatedQuery, 30);
  assert.strictEqual(
    candidates.length,
    0,
    `an unrelated query must not admit a recent-only judge candidate: ${JSON.stringify(candidates)}`,
  );

  console.log('✅ recent-only rows are excluded while lexical overlap remains eligible');
} finally {
  if (store) store.close();
  fs.rmSync(rootDir, { recursive: true, force: true });
}
