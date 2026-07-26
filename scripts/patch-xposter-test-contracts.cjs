'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function patch(rel, transform) {
  const file = path.join(root, rel);
  const before = fs.readFileSync(file, 'utf8');
  const after = transform(before);
  if (after === before) throw new Error(`No test-contract change applied to ${rel}`);
  fs.writeFileSync(file, after, 'utf8');
}

patch('test/resilience-v518.test.js', (source) =>
  source.replaceAll(
    '(await durableQueue.getQueue())',
    '(await durableQueue.getQueue()).map(durableQueue.textOf)',
  ),
);

console.log('Updated legacy test assertions to compare canonical queue text.');
