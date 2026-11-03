'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isXContentRejection } = require('../src/xFailureClassification');
const { ForensicLogger } = require('../src/forensicLogger');

test('a confirmed GraphQL content error is not an account strike', () => {
  for (const code of [186, 187, '187']) {
    assert.equal(isXContentRejection({
      failure:'ambiguous', xErrorCode:code, xResponseKind:'graphql_errors'
    }), true);
  }
});

test('generic ambiguity, rate limits, bans and timeouts never bypass strike rules', () => {
  for (const input of [
    { failure:'ambiguous', xErrorCode:null, xResponseKind:'graphql_errors' },
    { failure:'ambiguous', xErrorCode:226, xResponseKind:'graphql_errors' },
    { failure:'ambiguous', xErrorCode:187, xResponseKind:'timeout' },
    { failure:'banned', xErrorCode:187, xResponseKind:'graphql_errors' }
  ]) assert.equal(isXContentRejection(input), false, JSON.stringify(input));
});

test('durable queue diagnosis is written within the claim ownership fence', () => {
  const code = fs.readFileSync(path.join(__dirname,'../src/runner.js'),'utf8');
  assert.match(code, /i\.attempt\.token !== claim\.token/);
  assert.match(code, /i\.failureDiagnostic\s*=\s*\{/);
  assert.match(code, /xResponseKind:\s*result\.xResponseKind/);
  assert.match(code, /verificationError:\s*result\.verificationError/);
  assert.match(code, /x_content_rejection_no_strike/);
  assert.match(code, /classifyPublishOutcome\(result, dispatchEntered\)/);
});

test('Python response kind and detailed verifier failure survive DirectX bridge', () => {
  const adapter = fs.readFileSync(path.join(__dirname,'../src/directX.js'),'utf8');
  const bridge = fs.readFileSync(path.join(__dirname,'../python/direct_x_bridge.py'),'utf8');
  assert.match(adapter, /xResponseKind:\s*result\.xResponseKind/);
  assert.match(adapter, /verificationError:\s*result\.verificationError/);
  assert.match(bridge, /x_response_kind\s*=\s*getattr/);
  assert.match(bridge, /verification_error\s*=\s*str\(verification_exc\)/);
});

test('forensic JSONL must redact secrets in X error and nested diagnostics', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yj-graphql-forensic-'));
  try {
    const logger = new ForensicLogger({ dataDir: dir, store: { update: async fn => {
      const state={}; fn(state); return state;
    } } });
    await logger.record({
      eventType:'post_ambiguous', accountId:'test',
      xErrorMessage:'auth_token=SECRET_T1',
      details:{ rawError:'{"cookie":"SECRET_T2"}', reason:'publish_confirmation_missing' }
    });
    const log = fs.readFileSync(path.join(dir,'logs','forensic.jsonl'),'utf8');
    assert.ok(!log.includes('SECRET_T1'));
    assert.ok(!log.includes('SECRET_T2'));
    assert.match(log, /publish_confirmation_missing/);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
