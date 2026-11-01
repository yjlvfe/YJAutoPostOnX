'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = path.join(os.tmpdir(), 'xposter-id-addressing-' + Date.now());
os.homedir = () => SANDBOX;
process.env.HOME = SANDBOX;
process.env.USERPROFILE = SANDBOX;
process.env.XDG_CONFIG_HOME = path.join(SANDBOX, '.config');
process.env.XDG_CACHE_HOME = path.join(SANDBOX, '.cache');
fs.mkdirSync(path.join(SANDBOX, '.config', 'x-poster-bot-profile'), { recursive: true });

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
}

const durableQueue = require('../dev/automation/durableQueue');
const { DurableSession } = require('../dev/automation/durableSession');

(async () => {
  console.log('=== XP-006: durable ID addressing ===');
  try {
    const store = await durableQueue.getStore();
    const duplicate = store.enqueue({
      items: [{ text: 'SAME TEXT' }, { text: 'SAME TEXT' }],
      requestId: 'duplicate-text-fixture',
    }).items;
    const queue = await durableQueue.getQueueDetailed();
    const same = queue.filter((item) => item.payload.text === 'SAME TEXT');
    check('queue entries expose durable IDs', same.length === 2 && same.every((item) => typeof item.id === 'string'));
    check('duplicate text rows have different IDs', same[0].id !== same[1].id);

    const profileId = await durableQueue.resolveProfileId('Default');
    const fixtureRun = store.startRun({ requestId: 'duplicate-recovery-fixture' });
    const fixtureSession = new DurableSession({ store, profileId, runId: fixtureRun.id, profileName: 'Default' });
    // bulkDeleteByText deliberately deletes ALL matching rows. The shipped
    // single-row text-address guard lives on recovery, not bulk deletion.
    for (const expected of duplicate) {
      const claim = fixtureSession.claimNext();
      check('duplicate recovery fixture claims the intended row', claim && claim.id === expected.id);
      fixtureSession.markTerminal('duplicate_recovery_fixture');
    }
    const byText = await durableQueue.requeueRecovery('Default', 'dead', 'SAME TEXT');
    check('single-row text recovery refuses an ambiguous address', byText === false &&
      duplicate.every((item) => store.getItem(item.id).state === 'dead'), JSON.stringify(byText));
    for (const item of duplicate) {
      const restored = await durableQueue.requeueRecoveryById({
        id: item.id, kind: 'dead', expectedRevision: store.getItem(item.id).revision,
      });
      check('duplicate fixture can be restored by its exact ID', restored.ok === true && restored.id === item.id);
    }
    fixtureSession.close();

    const byId = await durableQueue.bulkDeleteByIds([{
      id: duplicate[0].id,
      expectedRevision: store.getItem(duplicate[0].id).revision,
      requestId: 'delete-first-duplicate-by-id',
    }]);
    check('ID deletion removes exactly the selected row', byId.deleted === 1, JSON.stringify(byId));
    const survivors = durableQueue.readAllItems(store, ['queued']).filter((item) => durableQueue.textOf(item) === 'SAME TEXT');
    check('the other duplicate survives untouched', survivors.length === 1 && survivors[0].id === duplicate[1].id);

    // The bulk text API intentionally addresses every matching row, unlike
    // the guarded single-row recovery wrapper above. Pin both contracts.
    const bulkRows = store.enqueue({
      items: [{ text: 'BULK TEXT' }, { text: 'BULK TEXT' }],
      requestId: 'bulk-text-fixture',
    }).items;
    const bulkText = await durableQueue.bulkDeleteByText(['BULK TEXT']);
    check('bulk text deletion explicitly removes all matching rows',
      bulkText.deleted === 2 && bulkText.blocked.length === 0 &&
      bulkRows.every((item) => store.getItem(item.id).state === 'discarded'), JSON.stringify(bulkText));
    check('bulk text deletion leaves unrelated rows untouched', store.getItem(duplicate[1].id).state === 'queued');

    store.enqueue({ items: [{ text: 'MAYBE LIVE' }], requestId: 'ambiguous-fixture' });
    const run = store.startRun({ requestId: 'id-run' });
    const session = new DurableSession({ store, profileId, runId: run.id, profileName: 'Default' });
    const claim = session.claimNext({ leaseMs: 60_000 });
    // The surviving duplicate is first; retire it so the intended fixture is next.
    if (claim && claim.text === 'SAME TEXT') session.markTerminal('fixture_cleanup', new Error('fixture'));
    const target = session.claimNext({ leaseMs: 60_000 });
    check('ambiguous fixture was claimed', target && target.text === 'MAYBE LIVE', JSON.stringify(target));
    if (target) {
      const boundary = session.beginDispatch('MAYBE LIVE');
      check('fixture crossed the boundary', boundary.ok === true, JSON.stringify(boundary));
      if (boundary.ok) session.markAmbiguous('test');
    }
    session.close();

    const recovery = await durableQueue.getRecoveryItems('Default');
    const pending = recovery.pending.find((item) => item.text === 'MAYBE LIVE');
    check('recovery surface exposes the durable ID', !!pending && typeof pending.id === 'string');
    const confirmed = await durableQueue.confirmRecoveryPublishedById({
      id: pending.id, expectedRevision: pending.revision,
      proof: { externalUrl: 'https://x.test/status/1' },
    });
    check('confirmation by ID succeeds', confirmed.ok === true && confirmed.id === pending.id, JSON.stringify(confirmed));
    check('the exact row is now published', store.getItem(pending.id).state === 'published');
  } catch (error) {
    failed++;
    console.error(error && error.stack ? error.stack : error);
  }
  try { await durableQueue.closeStore(); } catch {}
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
  console.log(`\n${failed === 0 ? '✅' : '❌'} durable-id-addressing: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
