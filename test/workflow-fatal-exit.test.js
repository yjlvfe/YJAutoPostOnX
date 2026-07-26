'use strict';

/**
 * XP-008 — a fatal exception left the process alive and exiting 0.
 *
 * The old handlers logged an uncaught exception, cleared the run flags and
 * deliberately kept going. A child probe threw a fatal error and the process
 * still exited 0, so nothing supervising the app — a shell, CI, a service
 * manager, the user — could tell the difference between a clean run and a
 * corrupted one. Meanwhile the process still held a SQLite handle, a browser
 * context, and possibly an undecided lease.
 *
 * These tests spawn REAL child processes and assert on their exit codes. That
 * is the only way to prove an exit policy: a handler can be installed correctly
 * and still not exit.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'xposter-fatal-'));
const FATAL_MODULE = path.resolve(__dirname, '../dev/utils/fatal.js');

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
}

/** Run a snippet in a child process and report how it died. */
function runChild(source, label) {
  const file = path.join(SANDBOX, `${label}.js`);
  fs.writeFileSync(file, source, 'utf8');
  const result = spawnSync(process.execPath, [file], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function uncaughtExceptionExitsNonZero() {
  console.log('\n📋 XP-008.1 uncaught exception');
  const logPath = path.join(SANDBOX, 'crash1.log');
  const child = runChild(`
    const { installFatalHandlers } = require(${JSON.stringify(FATAL_MODULE)});
    installFatalHandlers({ logPath: ${JSON.stringify(logPath)} });
    setTimeout(() => { throw new Error('BOOM_UNCAUGHT'); }, 10);
    setTimeout(() => { console.log('STILL_ALIVE'); process.exit(0); }, 3000);
  `, 'uncaught');

  check('the child exits NON-ZERO after a fatal throw', child.status !== 0 && child.status !== null,
    `exit=${child.status}`);
  check('it exits 1 specifically', child.status === 1, `exit=${child.status}`);
  check('the process did not carry on running', !child.stdout.includes('STILL_ALIVE'),
    `stdout=${child.stdout.trim()}`);
  check('the crash was recorded synchronously', fs.existsSync(logPath));
  if (fs.existsSync(logPath)) {
    const record = JSON.parse(fs.readFileSync(logPath, 'utf8').trim().split('\n')[0]);
    check('the record names the fault', record.message.includes('BOOM_UNCAUGHT'), JSON.stringify(record));
    check('the record names the kind', record.kind === 'uncaughtException', record.kind);
  }
}

function unhandledRejectionExitsNonZero() {
  console.log('\n📋 XP-008.2 unhandled rejection');
  const logPath = path.join(SANDBOX, 'crash2.log');
  const child = runChild(`
    const { installFatalHandlers } = require(${JSON.stringify(FATAL_MODULE)});
    installFatalHandlers({ logPath: ${JSON.stringify(logPath)} });
    Promise.reject(new Error('BOOM_REJECTED'));
    setTimeout(() => { console.log('STILL_ALIVE'); process.exit(0); }, 3000);
  `, 'rejection');

  check('an unhandled rejection is fatal too', child.status === 1, `exit=${child.status}`);
  check('the process did not carry on running', !child.stdout.includes('STILL_ALIVE'),
    `stdout=${child.stdout.trim()}`);
  check('the rejection was recorded', fs.existsSync(logPath));
}

function cleanupRunsButCannotBlockTheExit() {
  console.log('\n📋 XP-008.3 cleanup is bounded');
  const child = runChild(`
    const { installFatalHandlers } = require(${JSON.stringify(FATAL_MODULE)});
    installFatalHandlers({
      cleanupTimeoutMs: 300,
      onFatal: async () => {
        console.log('CLEANUP_STARTED');
        // A cleanup that never settles must not prevent the exit.
        await new Promise(() => {});
      },
    });
    setTimeout(() => { throw new Error('BOOM_HANG'); }, 10);
  `, 'hang');

  check('cleanup was attempted', child.stdout.includes('CLEANUP_STARTED'), child.stdout.trim());
  check('a hanging cleanup still exits non-zero', child.status === 1, `exit=${child.status}`);
}

function failClosedBeforeExit() {
  console.log('\n📋 XP-008.4 fail closed immediately');
  const child = runChild(`
    const fatal = require(${JSON.stringify(FATAL_MODULE)});
    fatal.installFatalHandlers({
      cleanupTimeoutMs: 200,
      onFatal: async () => {
        // By the time any cleanup runs, new work must already be refused.
        console.log('IS_FATAL_DURING_CLEANUP=' + fatal.isFatal());
      },
    });
    console.log('IS_FATAL_BEFORE=' + fatal.isFatal());
    setTimeout(() => { throw new Error('BOOM_CLOSED'); }, 10);
  `, 'failclosed');

  check('the process is not "fatal" before the fault',
    child.stdout.includes('IS_FATAL_BEFORE=false'), child.stdout.trim());
  check('it fails closed before cleanup even begins',
    child.stdout.includes('IS_FATAL_DURING_CLEANUP=true'), child.stdout.trim());
  check('and still exits non-zero', child.status === 1, `exit=${child.status}`);
}

function reentrantFaultsDoNotLoop() {
  console.log('\n📋 XP-008.5 a throw inside the handler does not re-enter');
  const child = runChild(`
    const { installFatalHandlers } = require(${JSON.stringify(FATAL_MODULE)});
    let handled = 0;
    installFatalHandlers({
      cleanupTimeoutMs: 200,
      notify: () => { handled++; console.log('NOTIFY=' + handled); throw new Error('notify exploded'); },
    });
    setTimeout(() => { throw new Error('BOOM_REENTRANT'); }, 10);
  `, 'reentrant');

  const notifies = (child.stdout.match(/NOTIFY=/g) || []).length;
  check('the fault handler runs exactly once', notifies === 1, `notifies=${notifies}`);
  check('a throw inside the handler does not prevent the exit', child.status === 1,
    `exit=${child.status}`);
}

(async () => {
  console.log('=== XP-008: fatal faults end the process ===');
  try {
    uncaughtExceptionExitsNonZero();
    unhandledRejectionExitsNonZero();
    cleanupRunsButCannotBlockTheExit();
    failClosedBeforeExit();
    reentrantFaultsDoNotLoop();
  } catch (error) {
    failed++;
    console.error('\n❌ suite threw:', error && error.stack ? error.stack : error);
  }
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(`\n${failed === 0 ? '✅' : '❌'} workflow-fatal-exit: ${passed} passed, ${failed} failed`);
  assert.ok(true);
  process.exit(failed === 0 ? 0 : 1);
})();
