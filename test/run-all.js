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
  'dependency-audit-closure.test.js',
];

// Durable-workflow tests are discovered, not listed, so a new gate can never be
// silently left out of the suite. Both prefixes belong to the same slice.
const workflowTests = fs.readdirSync(TEST_DIR)
  .filter((name) => (name.startsWith('workflow-') || name.startsWith('durable-'))
    && name.endsWith('.test.js'))
  .sort();

/**
 * Test files this runner deliberately does NOT run, and why.
 *
 * An orphan test file is worse than no test file: it reads as coverage while
 * never executing. list-models.test.js needs a live, paid provider key and makes
 * a real network call, so it can never join the default suite — it is opt-in via
 * `npm run test:live`. Being on this list is a decision; being absent from every
 * list is an accident, and workflow-suite-coverage.test.js fails on that.
 */
const OPT_IN_TESTS = {
  'list-models.test.js': 'live paid provider + real network; run with npm run test:live',
};
function run() {
  const scope = process.env.XPOSTER_TEST_SCOPE || 'all';
  if (!['all', 'baseline', 'workflow'].includes(scope)) {
    throw new Error(`Unknown XPOSTER_TEST_SCOPE: ${scope}`);
  }
  const tests = scope === 'baseline'
    ? BASELINE_TESTS
    : scope === 'workflow'
      ? workflowTests
      : [...BASELINE_TESTS, ...workflowTests];

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
}

// Exported so the coverage guard reads the real lists rather than a copy of
// them — a copy drifts, and a drifted copy is how a test stops running.
// Requiring this file must NOT run the suite, or the guard would recurse.
module.exports = { BASELINE_TESTS, workflowTests, OPT_IN_TESTS };

if (require.main === module) run();
