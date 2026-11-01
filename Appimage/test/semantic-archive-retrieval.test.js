'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkflowStore } = require('../dev/automation/workflowStore');
const { SemanticIndex } = require('../dev/automation/semanticIndex');

const REF = 'إدارة المخاطر هي خط الدفاع الأول لكل متداول ناجح، فلا تخاطر أبداً بأكثر مما تتحمل خسارته وضع دائماً خطة واضحة لحجم المركز ووقف الخسارة قبل الدخول في أي صفقة حتى تحمي رأس مالك على المدى الطويل وتستمر في مسيرتك';
const CANDIDATE = 'إدارة المخاطر هي خط الدفاع الأول لكل متداول ناجح، فلا تجازف أبداً بأكثر مما يمكنك تحمل خسارته، وضع خطة واضحة لحجم المركز ووقف الخسارة قبل فتح الصفقة لتحمي رأس مالك على المدى الطويل وتواصل مسيرتك';

const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yj-fts-retrieval-'));
let store;
try {
  store = new WorkflowStore({ rootDir });

  // These rows share generic domain vocabulary but not the candidate's idea.
  // They intentionally occupy the first 40 insertion slots so an unordered
  // LIMIT 30 query can hide the older semantic reference below them.
  for (let i = 0; i < 40; i += 1) {
    store.indexFtsText(`تداول عام ورقم ${i} عن السوق والسعر والربح والخسارة`);
  }
  store.indexFtsText(REF);

  const retrieved = store.searchSimilarTexts(CANDIDATE, 30);
  assert(
    retrieved.includes(REF),
    'FTS retrieval must return the most relevant archived reference within the bounded candidate set',
  );

  const semantic = new SemanticIndex();
  const verdict = semantic.checkCandidate(CANDIDATE, REF);
  assert.strictEqual(verdict.dup, true, 'the archived reference is a semantic duplicate');

  console.log('✅ semantic archive retrieval keeps the relevant historical candidate');
} finally {
  if (store) store.close();
  fs.rmSync(rootDir, { recursive: true, force: true });
}
