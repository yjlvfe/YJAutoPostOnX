'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const SANDBOX = path.join(os.tmpdir(), 'xposter-backup-health-' + Date.now());
os.homedir = () => SANDBOX;
fs.mkdirSync(path.join(SANDBOX, '.config', 'x-poster-bot-profile'), { recursive: true });

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
}

const durableQueue = require('../dev/automation/durableQueue');
const backup = require('../dev/automation/workflowBackup');

(async () => {
  console.log('=== XP-010: workflow backups and health gate ===');
  try {
    const mediaSource = path.join(SANDBOX, 'proof.png');
    fs.writeFileSync(mediaSource, Buffer.from('managed-media-fixture'));
    await durableQueue.addPosts([{ text: 'BACK ME UP', media_path: mediaSource }]);
    const store = await durableQueue.getStore();

    const snapshot = await durableQueue.createWorkflowSnapshot({ now: 1_800_000_000_000, keep: 2 });
    check('a complete snapshot directory was created', snapshot.created === true && fs.existsSync(snapshot.directory));
    const manifest = JSON.parse(fs.readFileSync(path.join(snapshot.directory, 'manifest.json'), 'utf8'));
    check('manifest is marked complete', manifest.complete === true);
    check('database hash and size are recorded', /^[0-9a-f]{64}$/.test(manifest.database.sha256) && manifest.database.byteSize > 0);
    check('managed media is included', manifest.media.length === 1 && fs.existsSync(path.join(snapshot.directory, 'media', manifest.media[0].relativePath)));

    const db = new Database(path.join(snapshot.directory, 'workflow.sqlite'), { readonly: true });
    try {
      check('snapshot database passes quick_check', db.pragma('quick_check', { simple: true }) === 'ok');
      check('snapshot contains the queued row', db.prepare("SELECT COUNT(*) AS n FROM workflow_items WHERE payload_text = 'BACK ME UP'").get().n === 1);
    } finally { db.close(); }

    const skipped = await backup.maybeCreateSnapshot(store, { now: 1_800_000_000_001, intervalMs: 86_400_000 });
    check('interval prevents backup storms', skipped.created === false && skipped.reason === 'interval_not_elapsed');

    const critical = durableQueue.criticalHealthProblems({
      quickCheck: 'ok', foreignKeyViolations: [{ table: 'x' }], mediaProblems: [], stateConsistencyViolations: [],
    });
    check('foreign-key corruption is a startup blocker', critical.includes('foreign_keys'));

    const item = durableQueue.readAllItems(store, ['queued']).find((row) => durableQueue.textOf(row) === 'BACK ME UP');
    fs.unlinkSync(item.media[0].managedPath);
    let rejected = null;
    try { await durableQueue.assertHealthy(); } catch (error) { rejected = error; }
    check('missing managed media fails the runtime health gate', rejected && rejected.code === 'WORKFLOW_HEALTH_FAILED');
  } catch (error) {
    failed++;
    console.error(error && error.stack ? error.stack : error);
  }
  try { await durableQueue.closeStore(); } catch {}
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
  console.log(`\n${failed === 0 ? '✅' : '❌'} workflow-backup-health: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
