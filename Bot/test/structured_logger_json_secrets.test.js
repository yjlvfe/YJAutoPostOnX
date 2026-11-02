'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { sanitizeString, formatStructuredLog } = require('../src/structuredLogger');

test('JSON string keys with secret values are redacted even inside a log message', () => {
  for (const [key, secret] of [
    ['auth_token', 'CONFIDENTIAL_TOKEN_VALUE'],
    ['cookie', 'SESSION_COOKIE_VALUE'],
    ['password', 'pw123'],
    ['telegram_bot_token', 'DUMMY_TEST_ONLY_123'],
    ['refresh_token', 'REFRESH_SAMPLE_456']
  ]) {
    const value = '{"' + key + '":"' + secret + '","safe":"ok"}';
    const sanitized = sanitizeString(value);
    assert.ok(!sanitized.includes(secret), key + ' was exposed');
    assert.match(sanitized, /\[REDACTED\]/);
    assert.match(sanitized, /"safe":"ok"/);
  }
});
test('standard structured fields cannot smuggle embedded JSON secrets into logs', () => {
  const record = formatStructuredLog({
    event: '{"auth_token":"DUMMY_AAA"}',
    runId: '{"cookie":"DUMMY_BBB"}',
    errorCode: 'password=DUMMY_CCC',
    component: '{"access_token":"DUMMY_DDD"}',
    suppressionReason: '{"password":"DUMMY_EEE"}'
  });
  const log = JSON.stringify(record);
  for (const secret of ['DUMMY_AAA','DUMMY_BBB','DUMMY_CCC','DUMMY_DDD','DUMMY_EEE'])
    assert.ok(!log.includes(secret), secret + ' was exposed');
});
test('nonsecret fields and reason codes survive redaction', () => {
  const record = formatStructuredLog({event:'cycle_stopped',runId:'run12345',errorCode:'ECONNRESET',durationMs:53});
  assert.equal(record.event,'cycle_stopped');
  assert.equal(record.runId,'run12345');
  assert.equal(record.errorCode,'ECONNRESET');
  assert.equal(record.durationMs,53);
});