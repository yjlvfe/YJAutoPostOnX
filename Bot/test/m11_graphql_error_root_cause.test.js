'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('runner post_result logs all required diagnosis fields upon failure', () => {
  const runnerSrc = fs.readFileSync(path.join(__dirname, '../src/runner.js'), 'utf8');
  assert.match(runnerSrc, /event:\s*'post_result'/);
  assert.match(runnerSrc, /runId:\s*run\.runId/);
  assert.match(runnerSrc, /item:\s*item\.id/);
  assert.match(runnerSrc, /dispatchEntered:\s*Boolean\(dispatchEntered\)/);
  assert.match(runnerSrc, /durationMs:\s*Date\.now\(\)\s*-\s*publishStartedAt/);
  assert.match(runnerSrc, /xErrorCode:\s*result\.xErrorCode/);
  assert.match(runnerSrc, /xResponseKind:\s*result\.xResponseKind/);
  assert.match(runnerSrc, /xErrorMessage:\s*result\.xErrorMessage/);
  assert.match(runnerSrc, /httpStatus:\s*Number\.isInteger\(result\.httpStatus\)/);
  assert.match(runnerSrc, /verificationError:\s*result\.verificationError/);
});

test('bridge extracts detailed response kinds and tombstone errors when create_tweet returns none', () => {
  const bridgeSrc = fs.readFileSync(path.join(__dirname, '../python/direct_x_bridge.py'), 'utf8');
  assert.match(bridgeSrc, /_last_create_tweet_response/);
  assert.match(bridgeSrc, /tweet_result_\{typename\.lower\(\)\}/);
  assert.match(bridgeSrc, /xResponseKind.*=.*x_resp_kind/);
});
