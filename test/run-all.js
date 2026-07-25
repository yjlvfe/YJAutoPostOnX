'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TEST_DIR = __dirname;
const BASELINE_TESTS = [
  'referral-toggle.test.js',
  'e2e-generation.test.js',
  'reportEngine.test.js',
  'session-manager.test.js',
  'api-key-leak.test.js',
  'rate-limit-persist.test.js',
  'max-tokens-cap.test.js',
  'security-logs.test.js',
  'profile-numbering.test.js',
  'semantic-dedup.test.js',
  'publish-decoupling.test.js',
  'publish-fixes-v511.test.js',
  'dynamic-prompt-v512.test.js',
  'deferred-retry-v512.test.js',
  'auditor-comments.test.js',
  'queue-consume.test.js',
  'resilience-v518.test.js',
  'stop-during-toast-wait.test.js',
  'detect-format.test.js',
  'opencode-go-format.test.js',
  'diagnostic-pipeline.test.js',
  'verify-edge-cases.test.js',
];

const workflowTests = fs.readdirSync(TEST_DIR)
  .filter((name) => name.startsWith('workflow-') && name.endsWith('.test.js'))
  .sort();
const scope = process.env.XPOSTER_TEST_SCOPE || 'all';
const tests = scope === 'baseline'
  ? BASELINE_TESTS
  : scope === 'workflow'
    ? workflowTests
    : [...BASELINE_TESTS, ...workflowTests];

if (!['all', 'baseline', 'workflow'].includes(scope)) {
  throw new Error(`Unknown XPOSTER_TEST_SCOPE: ${scope}`);
}

let passed = 0;
for (const name of tests) {
  const absolute = path.join(TEST_DIR, name);
  process.stdout.write(`\n=== ${name} ===\n`);
  const result = spawnSync(process.execPath, [absolute], {
    cwd: path.resolve(TEST_DIR, '..'),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(`Failed to start ${name}:`, result.error);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`${name} failed with exit code ${result.status}`);
    process.exit(result.status || 1);
  }
  passed += 1;
}

console.log(`\nALL ${passed} NODE-STYLE TEST FILES PASSED UNDER ELECTRON`);
