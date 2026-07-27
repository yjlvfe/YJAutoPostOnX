'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = path.join(os.tmpdir(), 'xposter-id-addressing-' + Date.now());
os.homedir = () => SANDBOX;
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
    const queue = await durableQueue.getQueue();
    const same = queue.filter((item) => item.text === 'SAME TEXT');
    check('queue entries expose durable IDs', same.length === 2 && same.every((item) => typeof item.id === 'string'));
    check('duplicate text rows have different IDs', same[0].id !== same[1].id);

    const byText = await durableQueue.bulkDeleteByText(['SAME TEXT']);
    check('text deletion refuses an ambiguous address', byText.deleted === 0 && byText.blocked.some((b) => b.reason === 'AMBIGUOUS_TEXT_ADDRESS'), JSON.stringify(byText));

    const byId = await durableQueue.bulkDeleteById([{
      id: duplicate[0].id,
      expectedRevision: duplicate[0].revision,
      requestId: 'delete-first-duplicate-by-id',
    }]);
    check('ID deletion removes exactly the selected row', byId.deleted === 1, JSON.stringify(byId));
    const survivors = durableQueue.readAllItems(store, ['queued']).filter((item) => durableQueue.textOf(item) === 'SAME TEXT');
    check('the other duplicate survives untouched', survivors.length === 1 && survivors[0].id === duplicate[1].id);

    const profileId = await durableQueue.resolveProfileId('Default');
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
    store.finishRun({ runId: run.id, status: 'closed', requestId: 'id-run-finish' });

    const recovery = await durableQueue.getRecoveryItems('Default');
    const pending = recovery.pending.find((item) => item.text === 'MAYBE LIVE');
    check('recovery surface exposes the durable ID', !!pending && typeof pending.id === 'string');
    const confirmed = await durableQueue.confirmRecoveryPublished(pending.id, { externalUrl: 'https://x.test/status/1' });
    check('confirmation by ID succeeds', confirmed === true);
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
