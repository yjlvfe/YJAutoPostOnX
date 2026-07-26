'use strict';

const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'apply-xposter-followup.cjs');
let source = fs.readFileSync(file, 'utf8');

function escapeGeneratedTemplate(marker) {
  const markerAt = source.indexOf(marker);
  if (markerAt === -1) throw new Error(`Missing generated-template marker: ${marker}`);
  const open = source.indexOf('`', markerAt + marker.length);
  const close = source.indexOf('\n`);', open + 1);
  if (open === -1 || close === -1) throw new Error(`Malformed generated-template block: ${marker}`);
  const body = source.slice(open + 1, close).replace(/(?<!\\)`/g, '\\`');
  source = source.slice(0, open + 1) + body + source.slice(close);
}

// Two test files are emitted as template literals and contain their own runtime
// template strings. Escape those inner backticks before Node parses the applier.
escapeGeneratedTemplate("write('test/durable-recovery-contract.test.js', ");
escapeGeneratedTemplate("write('test/workflow-report-retention.test.js', ");

// The follow-up applier contains template literals whose output is JavaScript
// source. Interpolations inside generated files must survive until generated
// code runs; only the helper's own ${label} diagnostics belong to this process.
source = source.replace(/(?<!\\)\$\{(?!label\})/g, '\\${');
fs.writeFileSync(file, source, 'utf8');
console.log('Prepared nested xposter follow-up templates.');
