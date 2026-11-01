'use strict';

// durableQueue exposes runMaintenance() — reclaim stale leases, sweep orphaned
// media bytes, prune the idempotency cache — and closeStore(), which checkpoints
// the WAL back into the main .db file.
//
// Both were dead code: nothing in the app ever called either one. That makes the
// api_requests retention trigger inert (the cutoff pruneIdempotency sets is the
// only thing that can ever delete those rows), lets orphaned media files
// accumulate on disk with no reclaim path, and leaves every exit relying on WAL
// recovery instead of a clean close.
//
// Measured cost of never pruning: ~4KB per published post, of which api_requests
// is 2 rows each — roughly 385MB projected at 100k posts.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'dev', 'main.js'), 'utf8');

function maintenanceIsScheduled() {
  assert.ok(
    /durableQueue\.runMaintenance\s*\(/.test(mainSource),
    'main.js must call durableQueue.runMaintenance() — otherwise pruneIdempotency ' +
    'never runs and the api_requests retention trigger can never fire'
  );
  console.log('  ✓ runMaintenance is called from main.js');
}

function maintenanceRunsOnATimer() {
  // A single call at startup would prune once per launch; an app left running
  // for weeks needs a recurring sweep.
  const scheduled = /setInterval\s*\(\s*[^)]*maintenance/i.test(mainSource)
    || /scheduleMaintenance|MAINTENANCE_INTERVAL/i.test(mainSource);
  assert.ok(scheduled, 'maintenance must run on a recurring timer, not only once');
  console.log('  ✓ maintenance runs on a recurring schedule');
}

function storeIsClosedOnQuit() {
  const beforeQuit = mainSource.slice(mainSource.indexOf("app.on('before-quit'"));
  assert.ok(beforeQuit.length > 0, "main.js must register a 'before-quit' handler");
  assert.ok(
    /durableQueue\.closeStore\s*\(/.test(beforeQuit.slice(0, 1200)),
    "before-quit must call durableQueue.closeStore() so the WAL is checkpointed " +
    'back into the main database file on exit'
  );
  console.log('  ✓ closeStore is called on before-quit');
}

function maintenanceFailureCannotCrashTheApp() {
  // It runs on a timer with no caller to catch it: an unhandled rejection in
  // the main process is exactly the failure mode this app has fought before.
  const idx = mainSource.search(/durableQueue\.runMaintenance\s*\(/);
  assert.ok(idx > 0, 'runMaintenance call not found');
  const window = mainSource.slice(Math.max(0, idx - 400), idx + 400);
  assert.ok(
    /catch|\.catch\s*\(/.test(window),
    'the runMaintenance call must be guarded — an unguarded timer rejection ' +
    'takes down the main process'
  );
  console.log('  ✓ maintenance failures are caught');
}

const tests = [
  ['maintenance is called', maintenanceIsScheduled],
  ['maintenance is recurring', maintenanceRunsOnATimer],
  ['store closed on quit', storeIsClosedOnQuit],
  ['maintenance guarded', maintenanceFailureCannotCrashTheApp],
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}: ${error.message}`);
  }
}

if (failed > 0) {
  console.error(`\n✗ durable maintenance wiring: ${failed} failing`);
  process.exit(1);
}
console.log('✅ durable maintenance wiring: maintenance and clean shutdown are wired');
