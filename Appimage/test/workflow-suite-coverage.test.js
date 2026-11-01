'use strict';

/**
 * XP-013 — a test file that nothing runs.
 *
 * `list-models.test.js` sat in test/ and was executed by no script at all. It
 * read as coverage, contributed none, and nobody could tell without diffing the
 * directory against the runner by hand. It is also the one file that MUST NOT
 * join the default suite — it needs a live paid provider key and makes a real
 * network call — so the answer was never "add it to the list".
 *
 * The structural fix is this guard: every *.test.js must be accounted for by
 * exactly one of
 *   - the baseline list in run-all.js,
 *   - run-all.js's workflow-/durable- auto-discovery,
 *   - the npm scripts that run Electron-hosted tests,
 *   - or an explicit opt-in entry that states why it is excluded.
 *
 * A new test file that matches none of these fails here, at the moment it is
 * added, instead of being quietly ignored for a year.
 *
 * It reads run-all.js's own exports rather than restating them, because a
 * second copy of the list is exactly the thing that drifts.
 */

const fs = require('fs');
const path = require('path');

const TEST_DIR = __dirname;
const REPO = path.join(__dirname, '..');

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
}

const runner = require('./run-all.js');

function everyTestFileIsAccountedFor() {
  console.log('\n📋 XP-013.1 every test file is run by something, or says why not');

  check('run-all.js exposes its lists instead of hiding them',
    Array.isArray(runner.BASELINE_TESTS)
    && Array.isArray(runner.workflowTests)
    && runner.OPT_IN_TESTS && typeof runner.OPT_IN_TESTS === 'object');

  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const scriptText = Object.values(pkg.scripts).join(' ');
  const inScripts = new Set(
    [...scriptText.matchAll(/test\/([\w.-]+\.test\.js)/g)].map((m) => m[1]),
  );

  const onDisk = fs.readdirSync(TEST_DIR)
    .filter((f) => f.endsWith('.test.js'))
    .sort();

  const covered = new Set([
    ...runner.BASELINE_TESTS,
    ...runner.workflowTests,
    ...inScripts,
    ...Object.keys(runner.OPT_IN_TESTS),
  ]);

  const orphans = onDisk.filter((f) => !covered.has(f));
  check('no test file is executed by nothing', orphans.length === 0,
    `orphans=${JSON.stringify(orphans)}`);

  // The reverse direction: a list must not name a file that no longer exists,
  // which is how a suite silently shrinks after a rename.
  const missing = [...runner.BASELINE_TESTS, ...Object.keys(runner.OPT_IN_TESTS)]
    .filter((f) => !onDisk.includes(f));
  check('no list names a test file that has been deleted or renamed',
    missing.length === 0, `missing=${JSON.stringify(missing)}`);

  check('this guard is itself part of the auto-discovered suite',
    runner.workflowTests.includes('workflow-suite-coverage.test.js'));

  // Every opt-in exclusion must carry a reason. "Excluded" without a why is
  // indistinguishable from "forgotten".
  const unexplained = Object.entries(runner.OPT_IN_TESTS)
    .filter(([, reason]) => typeof reason !== 'string' || reason.trim().length < 10);
  check('every deliberate exclusion states its reason', unexplained.length === 0,
    JSON.stringify(unexplained));

  console.log(`      accounted for: ${onDisk.length} files `
    + `(${runner.BASELINE_TESTS.length} baseline, ${runner.workflowTests.length} discovered, `
    + `${inScripts.size} via npm scripts, ${Object.keys(runner.OPT_IN_TESTS).length} opt-in)`);
}

function optInTestsCannotReachTheNetworkByDefault() {
  console.log('\n📋 XP-013.2 the opt-in test stays opt-in');

  // list-models.test.js talks to a live paid provider. Requiring an explicit
  // key is what keeps `npm test` from ever spending money or leaving the
  // machine; the guard is that it SKIPS rather than fails when the key is absent.
  const source = fs.readFileSync(path.join(TEST_DIR, 'list-models.test.js'), 'utf8');
  check('it refuses to run without an explicit key in the environment',
    /process\.env\.IYH_KEY/.test(source) && /SKIP/.test(source));
  check('and it is not in the default suite',
    !runner.BASELINE_TESTS.includes('list-models.test.js')
    && !runner.workflowTests.includes('list-models.test.js'));

  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  check('there is a named script for running it deliberately',
    typeof pkg.scripts['test:live'] === 'string'
    && pkg.scripts['test:live'].includes('list-models'),
    JSON.stringify(pkg.scripts['test:live']));
}

function theBridgeExposesNothingItCannotDo() {
  console.log('\n📋 XP-013.3 the preload bridge exposes no channel without a handler');

  const preload = fs.readFileSync(path.join(REPO, 'dev', 'preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(REPO, 'dev', 'main.js'), 'utf8');

  const invoked = [...preload.matchAll(/ipcRenderer\.(invoke|send)\(\s*'([^']+)'/g)]
    .map((m) => ({ kind: m[1], channel: m[2] }));
  check('the bridge exposes channels at all', invoked.length > 0);

  const handled = new Set([
    ...[...main.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)].map((m) => m[1]),
    ...[...main.matchAll(/ipcMain\.on\(\s*'([^']+)'/g)].map((m) => m[1]),
  ]);

  // `exportLogsToCsv` invoked 'export-logs-to-csv', which no handler has ever
  // registered — every call could only reject with "No handler registered".
  const dangling = invoked.filter((i) => !handled.has(i.channel));
  check('every channel the renderer can call has a handler in main',
    dangling.length === 0,
    `dangling=${JSON.stringify(dangling.map((d) => d.channel))}`);
}

(async () => {
  console.log('🧪 XP-013 — suite coverage and bridge honesty');
  try {
    everyTestFileIsAccountedFor();
    optInTestsCannotReachTheNetworkByDefault();
    theBridgeExposesNothingItCannotDo();
  } catch (error) {
    failed++;
    console.error('\n💥 scenario crashed:', error && error.stack ? error.stack : error);
  }
  console.log(`\n${failed === 0 ? '✅' : '❌'} XP-013 coverage: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
