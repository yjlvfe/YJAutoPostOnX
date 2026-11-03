'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { isKnownTwikitParserFailure } = require('../src/knownTwikitParserFailure');

test('recognizes Python missing urls KeyError and traceback formats', () => {
  for (const rawError of ["'urls'", '"urls"', "KeyError: 'urls'", 'KeyError("urls")']) {
    assert.equal(isKnownTwikitParserFailure({ failure: 'ambiguous', rawError }), true, rawError);
  }
});
test('generic ambiguous outcomes retain the existing three-turn strike policy', () => {
  for (const rawError of [undefined, '', 'ETIMEDOUT', 'publish_confirmation_missing', "KeyError: 'screen_name'", "KeyError: 'urlz'"]) {
    assert.equal(isKnownTwikitParserFailure({ failure: 'ambiguous', rawError }), false, String(rawError));
  }
});
test('confirmed ban, captcha, and ordinary auth failure are never exempted', () => {
  for (const failure of ['banned', 'captcha', 'unauthenticated', null]) {
    assert.equal(isKnownTwikitParserFailure({ failure, rawError: "'urls'" }), false);
  }
});
test('production runner guards its strike and forensic persistence path', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/runner.js'), 'utf8');
  assert.match(source, /const isKnownParserError = isKnownTwikitParserFailure\(\{ failure, rawError \}\)/);
  assert.match(source, /else if \(isKnownParserError(?: \|\| isContentReject)?\) \{[\s\S]{0,280}accountResult\.failures = acc\.failures \|\| 0/);
  assert.match(source, /twikit_profile_parse_error_no_strike/);
  assert.match(source, /rawError: result\.rawError/);
  assert.match(source, /rawError: err\.message/);
  assert.match(source, /acc\.failures = \(acc\.failures \|\| 0\) \+ 1/);
});
