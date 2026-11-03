'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('runner passes xErrorCode to handleAccountFailure on ambiguous outcome', () => {
  const runner = fs.readFileSync(path.join(__dirname, '../src/runner.js'), 'utf8');
  assert.match(runner, /xErrorCode:\s*result\.xErrorCode/);
});

test('runner records xErrorCode in forensicLogger when handling account failures', () => {
  const runner = fs.readFileSync(path.join(__dirname, '../src/runner.js'), 'utf8');
  assert.match(runner, /xErrorCode:\s*xErrorCode\s*\?\?\s*null/);
});
