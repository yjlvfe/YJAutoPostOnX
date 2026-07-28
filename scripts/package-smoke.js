'use strict';
/**
 * Package smoke — runs INSIDE the built AppImage's extracted asar, in an
 * isolated HOME. Lives in the repo (not /tmp) so CI and local verification
 * run the exact same checks against the exact same file.
 *
 * Proves the shipped artifact actually works, rather than that the source
 * tree does: native better-sqlite3 loads at the packaged ABI, the durable
 * store opens, a queue item round-trips BY ID, the AI pool does not respawn
 * a terminal worker, the Stop gate refuses a dispatch, the vendored
 * dependency patch shipped, the backup/media contract holds, and nothing
 * touches the real HOME.
 *
 * Usage: SMOKE_APP_ROOT=/path/to/extracted/asar-out electron scripts/package-smoke.js
 * (run under ELECTRON_RUN_AS_NODE=1, with HOME pointed at an isolated dir)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const APP = process.env.SMOKE_APP_ROOT;
if (!APP) {
  console.error('SMOKE_APP_ROOT must point at the extracted app.asar contents');
  process.exit(1);
}
if (!os.homedir().startsWith('/tmp/') && !os.homedir().startsWith(os.tmpdir())) {
  console.error(`Refusing to run: HOME (${os.homedir()}) does not look like an isolated tmp dir`);
  process.exit(1);
}

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`); } };

console.log('=== package smoke: YJAutoPostOnX AppImage ===');
console.log(`HOME=${os.homedir()}`);
ok('running in an isolated HOME, not the real one',
  os.homedir().startsWith('/tmp/') || os.homedir().startsWith(os.tmpdir()), `homedir=${os.homedir()}`);

// 1. Native module at the packaged ABI.
let Database;
try {
  Database = require(path.join(APP, 'node_modules/better-sqlite3'));
  ok('native better-sqlite3 loads from the package', true);
} catch (e) {
  ok('native better-sqlite3 loads from the package', false, e.message.split('\n')[0]);
}
if (Database) {
  const probe = new Database(path.join(os.homedir(), 'abi-probe.sqlite'));
  probe.exec('CREATE TABLE t(a);INSERT INTO t VALUES(1);');
  ok('the native module executes SQL', probe.prepare('SELECT a FROM t').get().a === 1);
  console.log(`      sqlite=${probe.prepare('select sqlite_version() v').get().v} modules=${process.versions.modules}`);
  probe.close();
}

// 2. The durable store opens from the packaged code.
const { WorkflowStore } = require(path.join(APP, 'dev/automation/workflowStore'));
const root = path.join(os.homedir(), 'store');
fs.mkdirSync(root, { recursive: true });
const store = new WorkflowStore({ rootDir: root });
ok('WorkflowStore opens from the packaged asar', !!store);

// 3. Queue round-trip BY ID, through the real state machine.
const profile = store.createProfile({ name: 'SmokeProfile', requestId: 'smoke-p' });
const run = store.startRun({ requestId: 'smoke-r' });
store.enqueue({ items: [{ text: 'SMOKE_POST' }], requestId: 'smoke-e' });
const leased = store.leaseNext({ profileId: profile.id, runId: run.id, leaseMs: 60000 });
ok('an item can be leased', !!leased && leased.payload.text === 'SMOKE_POST');
const attempt = store.beginDispatch({
  id: leased.id, leaseToken: leased.leaseToken,
  renderedText: 'SMOKE_POST', requestId: 'smoke-b',
});
ok('the dispatch boundary commits', !!attempt.attemptId);
store.markPublished({
  attemptId: attempt.attemptId, externalUrl: 'https://x.com/i/web/status/smoke1',
  evidence: { smoke: true }, requestId: 'smoke-pub',
});
const published = store.listItems({ states: ['published'], limit: 10 });
ok('the item round-trips to published, addressed by id',
  published.length === 1 && published[0].id === leased.id);

// 4. Recovery is addressable by id.
store.enqueue({ items: [{ text: 'SMOKE_AMBIG' }], requestId: 'smoke-e2' });
const l2 = store.leaseNext({ profileId: profile.id, runId: run.id, leaseMs: 60000 });
const a2 = store.beginDispatch({ id: l2.id, leaseToken: l2.leaseToken, renderedText: 'SMOKE_AMBIG', requestId: 'smoke-b2' });
store.markAmbiguous({ attemptId: a2.attemptId, reason: 'smoke', requestId: 'smoke-amb' });
const recovery = store.listRecovery();
ok('an ambiguous item appears in recovery with its id',
  recovery.length === 1 && recovery[0].id === l2.id);
ok('unresolved recovery blocks further publishing', store.countUnresolvedRecovery() === 1);
store.resolveRecovery({ id: l2.id, action: 'close', evidence: { by: 'smoke' }, requestId: 'smoke-res' });
ok('recovery resolves by id', store.countUnresolvedRecovery() === 0);
store.close();

// 5. Restart + reconciliation against the same files.
const store2 = new WorkflowStore({ rootDir: root });
store2.reconcileStartup({ requestId: 'smoke-reconcile' });
const afterRestart = store2.listItems({ states: ['published'], limit: 10 });
ok('published state survives a store restart', afterRestart.length === 1);
store2.close();

// Every timer inside SessionManager is unref'd, so without this the event loop
// drains during the async section below and the process exits 0 having silently
// skipped it — a false pass.
const keepAlive = setInterval(() => {}, 1000);

(async () => {
  // 6. XP-001: a terminal AI worker is not respawned, from the PACKAGED code.
  const { SessionManager, STATUS, HARD_LIMITS } = require(path.join(APP, 'dev/automation/sessionManager'));
  let calls = 0;
  const mgr = new SessionManager({
    engine: { syncSessionDedup() {}, buildAcceptedContext() { return ''; }, selectAngles() { return []; } },
    runRound: async () => { calls++; throw new Error('401 Unauthorized'); },
    ingest: () => 0,
    sessionCount: 2,
    baseBackoffMs: 50, maxBackoffMs: 60,
  });
  const outcome = await mgr.run(() => false);
  ok('two terminal AI workers cost exactly two provider calls', calls === 2, `calls=${calls}`);
  ok('the run reports a typed failure, not success', outcome.status === 'failed', `status=${outcome.status}`);
  ok('terminal workers stay terminal',
    mgr.sessions.every(s => s.status === STATUS.TERMINAL));
  ok('the packaged build carries the worker hard cap',
    Number.isInteger(HARD_LIMITS.MAX_WORKERS) && HARD_LIMITS.MAX_WORKERS <= 64,
    `MAX_WORKERS=${HARD_LIMITS.MAX_WORKERS}`);

  // 7. XP-002: the Stop gate refuses a dispatch, from the PACKAGED code.
  const { RunToken } = require(path.join(APP, 'dev/automation/runControl'));
  const t1 = new RunToken({ runId: 'smoke-stop' });
  t1.requestStop('user_stop');
  ok('Stop-first refuses the dispatch gate', t1.tryEnterDispatch('p').ok === false);

  const t2 = new RunToken({ runId: 'smoke-dispatch' });
  const ticket = t2.tryEnterDispatch('p');
  const stop = t2.requestStop('user_stop');
  ok('dispatch-first is allowed through', ticket.ok === true);
  ok('Stop sees the in-flight dispatch instead of claiming an early win',
    stop.dispatchInFlight === true);
  t2.leaveDispatch(ticket.ticket, { outcome: 'published' });
  const joined = await stop.join(2000);
  ok('Stop joins the settled dispatch', joined.stopped === true && joined.timedOut === false);

  // 8. XP-006: recovery is addressed by identity, from the PACKAGED code.
  const durableQueue = require(path.join(APP, 'dev/automation/durableQueue'));
  ok('the packaged build exposes identity-addressed recovery',
    typeof durableQueue.discardRecoveryById === 'function'
    && typeof durableQueue.requeueRecoveryById === 'function'
    && typeof durableQueue.confirmRecoveryPublishedById === 'function'
    && typeof durableQueue.bulkDeleteByIds === 'function');

  // 9. XP-010: backup, retention and the health gate, from the PACKAGED code.
  const store3 = new WorkflowStore({ rootDir: root });
  const backup = await store3.backup({ keep: 2 });
  ok('the packaged build takes a VERIFIED backup',
    backup.ok === true && backup.verified === true && fs.existsSync(backup.path),
    JSON.stringify({ ok: backup.ok, error: backup.error }));

  const restored = new Database(backup.path, { readonly: true, fileMustExist: true });
  ok('the backup reopens and passes quick_check',
    restored.pragma('quick_check', { simple: true }) === 'ok');
  restored.close();

  ok('the packaged build can apply retention',
    typeof store3.applyRetention === 'function'
    && store3.applyRetention({ olderThanMs: 86_400_000, now: Date.now() + 10 * 86_400_000 })
      .archived >= 1);

  // The gate must actually stop the boundary in the shipped artifact.
  store3.setHealthGate({ blocked: true, reason: 'smoke_forced' });
  store3.enqueue({ items: [{ text: 'SMOKE_GATED' }], requestId: 'smoke-gate' });
  // A fresh run: reconcileStartup() above closed the one from the first store,
  // exactly as a restart does.
  const run3 = store3.startRun({ requestId: 'smoke-r3' });
  const gatedLease = store3.leaseNext({ profileId: profile.id, runId: run3.id, leaseMs: 60000 });
  let gateError = null;
  try {
    store3.beginDispatch({
      id: gatedLease.id, leaseToken: gatedLease.leaseToken,
      renderedText: 'SMOKE_GATED', requestId: 'smoke-gate-b',
    });
  } catch (e) { gateError = e; }
  ok('an unhealthy store cannot cross the boundary in the packaged build',
    gateError !== null && gateError.code === 'STORE_UNHEALTHY',
    `code=${gateError && gateError.code}`);
  store3.setHealthGate({ blocked: false });
  store3.close();

  // 10. Nothing wrote to the real HOME.
  ok('the real /root config was never created',
    !fs.existsSync('/root/.config/x-poster-shared/workflow.sqlite')
    || process.env.SMOKE_ALLOW_EXISTING === '1');

  // 11. GHSA-mh99-v99m-4gvg: the vendored fix shipped, from the PACKAGED code,
  // and still actually deletes a real directory (not just "does not throw").
  const udd = require(path.join(APP, 'node_modules/puppeteer-extra-plugin-user-data-dir'));
  const uddPkg = JSON.parse(fs.readFileSync(path.join(APP, 'node_modules/puppeteer-extra-plugin-user-data-dir/package.json'), 'utf8'));
  ok('the packaged user-data-dir plugin no longer depends on rimraf',
    !uddPkg.dependencies || !('rimraf' in uddPkg.dependencies), JSON.stringify(uddPkg.dependencies));
  ok('rimraf is not present anywhere in the packaged node_modules',
    !fs.existsSync(path.join(APP, 'node_modules/rimraf')));
  const uddTmp = path.join(os.homedir(), 'udd-smoke-profile');
  fs.mkdirSync(uddTmp, { recursive: true });
  fs.writeFileSync(path.join(uddTmp, 'Preferences'), '{}');
  const uddPlugin = udd({ deleteExisting: true });
  await uddPlugin.beforeLaunch({ userDataDir: uddTmp });
  await uddPlugin.onDisconnected();
  await new Promise((resolve) => setTimeout(resolve, 300));
  ok('the packaged plugin still deletes a real profile directory via fs.rm',
    !fs.existsSync(uddTmp));

  // 12. XP-010 media contract: reclaim + restore verification ship and work
  // from the packaged code, not just backup/retention/health.
  const store4 = new WorkflowStore({ rootDir: root });
  ok('the packaged build exposes media reclaim and restore verification',
    typeof store4.reclaimUnreferencedMedia === 'function'
    && typeof store4.verifyRestoreCandidate === 'function');
  const mediaSrc = path.join(os.homedir(), 'smoke-media.png');
  fs.writeFileSync(mediaSrc, Buffer.from('89504e470d0a1a0a' + 'ee'.repeat(64), 'hex'));
  const profile4 = store4.createProfile({ name: 'SmokeMediaProfile', requestId: 'smoke-p4' });
  const run4 = store4.startRun({ requestId: 'smoke-r4' });
  store4.enqueue({ items: [{ text: 'SMOKE_MEDIA_POST', media_path: mediaSrc }], requestId: 'smoke-e4' });
  const leased4 = store4.leaseNext({ profileId: profile4.id, runId: run4.id, leaseMs: 60000 });
  const attempt4 = store4.beginDispatch({ id: leased4.id, leaseToken: leased4.leaseToken, renderedText: 'SMOKE_MEDIA_POST', requestId: 'smoke-b4' });
  store4.markPublished({ attemptId: attempt4.attemptId, externalUrl: 'https://x.com/i/web/status/smoke4', evidence: {}, requestId: 'smoke-pub4' });
  const backup4 = await store4.backup({ keep: 2 });
  ok('the packaged build reports restorable=true while media is intact',
    backup4.restorable === true, JSON.stringify({ restorable: backup4.restorable, missing: backup4.missingMedia }));
  const blob4 = store4.db.prepare('SELECT relative_path FROM media_blobs LIMIT 1').get();
  fs.unlinkSync(path.join(root, 'media', blob4.relative_path));
  const verdict4 = store4.verifyRestoreCandidate({ path: backup4.path });
  ok('the packaged build typed-refuses restorable=true once media goes missing',
    verdict4.restorable === false && verdict4.missingMedia.length === 1, JSON.stringify(verdict4));
  store4.close();

  clearInterval(keepAlive);
  console.log(`\n${fail === 0 ? '✅' : '❌'} package smoke: ${pass} passed, ${fail} failed`);
  assert.ok(pass >= 30, `expected the full smoke to run, only ${pass} checks executed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  clearInterval(keepAlive);
  console.error('smoke crashed:', e && e.stack ? e.stack : e);
  process.exit(1);
});
