'use strict';

/**
 * fatal.js — what happens after an uncaught exception.
 *
 * The old policy was to log, clear the run flags, tell the UI, and KEEP GOING.
 * The reasoning was that the queue is consumed post-by-post so nothing would be
 * double-posted by staying alive. That reasoning does not hold: an uncaught
 * throw means some invariant already failed somewhere unknown, and the process
 * carries on owning a SQLite handle, a Playwright context and a lease on an
 * item that may or may not have been submitted. A child probe confirmed the
 * process exited 0 after a fatal throw — so a supervisor, a CI run and the user
 * all saw a clean exit from a corrupted process.
 *
 * The policy here:
 *
 *   1. FAIL CLOSED IMMEDIATELY. `isFatal()` flips before anything else, so
 *      every IPC handler and every start path refuses from this moment on.
 *      Nothing new may be claimed, dispatched, or published.
 *   2. LOG SYNCHRONOUSLY. appendFileSync, not a logger that needs the event
 *      loop to survive long enough to flush.
 *   3. CLEAN UP WITH A DEADLINE. Best-effort close of store/contexts, hard
 *      capped — a cleanup that hangs must not stop the exit.
 *   4. EXIT NON-ZERO. Always.
 *
 * Recovery is the durable store's job on next boot: reconcileStartup() resolves
 * whatever was mid-flight. In-memory flags were never a substitute for that.
 *
 * Electron-free on purpose, so the policy can be driven by a child process in
 * the test suite instead of asserted about by reading source text.
 */

const fs = require('fs');
const path = require('path');

let fatal = false;
let fatalInfo = null;

/** True once a fatal fault has been seen. Every entry point should check it. */
function isFatal() { return fatal; }

/** What went wrong, for status reporting on the way down. */
function fatalDetails() { return fatalInfo; }

/** Test-only reset so a suite can exercise the policy more than once. */
function _resetForTests() { fatal = false; fatalInfo = null; }

function serialize(error) {
  if (!error) return { name: 'Unknown', message: 'unknown fault', stack: null };
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack || null };
  }
  return { name: 'NonError', message: String(error), stack: null };
}

/**
 * Write the crash record without depending on the event loop surviving.
 * Never throws — a failure to log must not replace the original fault.
 */
function writeCrashLogSync(logPath, record) {
  if (!logPath) return false;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Install the process-level handlers.
 *
 * @param {function} [opts.onFatal]  async () => void — bounded cleanup
 *                                   (mark the run interrupted, close the store,
 *                                   close browser contexts).
 * @param {function} [opts.notify]   (record) => void — best-effort UI report.
 * @param {string}   [opts.logPath]  crash log, written synchronously.
 * @param {number}   [opts.cleanupTimeoutMs]
 * @param {function} [opts.exit]     injected for tests; defaults to process.exit.
 */
function installFatalHandlers({
  onFatal = null,
  notify = null,
  logPath = null,
  cleanupTimeoutMs = 5000,
  exit = (code) => process.exit(code),
} = {}) {
  const handle = async (kind, error) => {
    // Re-entrancy guard: a throw from inside cleanup must not restart this.
    if (fatal) return;
    fatal = true;
    fatalInfo = { kind, ...serialize(error), at: new Date().toISOString() };

    // 2. Synchronous, dependency-free record first.
    try { console.error(`FATAL (${kind}):`, error); } catch { /* stderr may be gone */ }
    writeCrashLogSync(logPath, fatalInfo);

    // Best-effort UI notice. Never allowed to throw from a fault handler.
    try { if (notify) notify(fatalInfo); } catch { /* ignore */ }

    // 3. Bounded cleanup. A hung close must not prevent the exit.
    if (onFatal) {
      let timer;
      try {
        await Promise.race([
          Promise.resolve().then(() => onFatal(fatalInfo)),
          // NOT unref'd, on purpose. If cleanup hangs and this timer were
          // unref'd, the event loop would drain and node would exit 0 —
          // reintroducing the exact "fatal fault, clean exit code" bug this
          // module exists to remove. The timer must hold the loop open long
          // enough for the deliberate non-zero exit below to run.
          new Promise((resolve) => { timer = setTimeout(resolve, cleanupTimeoutMs); }),
        ]);
      } catch { /* cleanup failures are not worth delaying the exit */ }
      finally { clearTimeout(timer); }
    }

    // 4. Non-zero, always.
    exit(1);
  };

  process.on('uncaughtException', (error) => { void handle('uncaughtException', error); });

  // An unhandled rejection gets the SAME treatment. Node's default is to warn
  // and continue, which leaves exactly the corrupted-but-alive process this
  // module exists to prevent.
  process.on('unhandledRejection', (reason) => { void handle('unhandledRejection', reason); });

  return { isFatal, fatalDetails };
}

module.exports = {
  installFatalHandlers,
  isFatal,
  fatalDetails,
  writeCrashLogSync,
  _resetForTests,
};
