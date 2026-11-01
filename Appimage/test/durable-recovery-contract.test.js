'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = path.join(os.tmpdir(), 'xposter-recovery-contract-' + Date.now());
os.homedir = () => SANDBOX;
process.env.HOME = SANDBOX;
fs.mkdirSync(path.join(SANDBOX, '.config', 'x-poster-bot-profile'), { recursive: true });

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const dq = require('../dev/automation/durableQueue');
const { DurableSession } = require('../dev/automation/durableSession');

(async () => {
  try {
    const store = await dq.getStore();
    const profileId = await dq.resolveProfileId('Default');

    const duplicate = store.enqueue({
      items: [{ text: 'SAME', media_path: null }, { text: 'SAME', media_path: null }],
      requestId: 'same-fixture',
    }).items;
    // The per-row UI uses IDs; bulkDeleteByText deliberately means ALL rows.
    // Prove that explicit bulk contract on a separate pair without touching SAME.
    store.enqueue({ items: [{ text: 'BULK ALL' }, { text: 'BULK ALL' }], requestId: 'bulk-all' });
    const byText = await dq.bulkDeleteByText(['BULK ALL']);
    check('explicit text bulk action deletes all matching rows', byText.deleted === 2 && byText.blocked.length === 0, JSON.stringify(byText));
    const selected = store.getItem(duplicate[1].id);
    const byId = await dq.bulkDeleteByIds([{
      id: selected.id,
      expectedRevision: selected.revision,
      requestId: 'delete-selected-id',
    }]);
    check('selected duplicate ID alone is deleted', byId.deleted === 1, JSON.stringify(byId));
    check('the first duplicate remains queued', store.getItem(duplicate[0].id).state === 'queued');

    const stale = store.getItem(duplicate[0].id);
    const run = store.startRun({ requestId: 'stale-run' });
    const session = new DurableSession({ store, profileId, runId: run.id, profileName: 'Default' });
    session.claimNext({ leaseMs: 60_000 });
    const staleDelete = await dq.bulkDeleteByIds([{
      id: stale.id,
      expectedRevision: stale.revision,
      requestId: 'stale-delete',
    }]);
    check('an item already leased cannot be deleted by a stale queue click', staleDelete.deleted === 0 && staleDelete.blocked[0]?.reason === 'IN_FLIGHT_LEASED' && store.getItem(stale.id).state === 'leased', JSON.stringify(staleDelete));
    session.release('fixture', { countAsFailure: false });
    const staleQueuedDelete = await dq.bulkDeleteByIds([{ id: stale.id, expectedRevision: stale.revision }]);
    check('a stale revision on a queued row is reported, not applied', staleQueuedDelete.deleted === 0 && staleQueuedDelete.blocked[0]?.reason === 'REVISION_CONFLICT' && store.getItem(stale.id).state === 'queued');
    session.claimNext({ leaseMs: 60_000 });
    session.markTerminal('fixture', new Error('fixture'));
    store.finishRun({ runId: run.id, status: 'closed', requestId: 'stale-finish' });

    const dead = store.getItem(stale.id);
    const staleDead = await dq.discardRecoveryById({ id: dead.id, kind: 'dead', expectedRevision: dead.revision - 1 });
    check('stale dead revision is rejected', staleDead?.code === 'REVISION_CONFLICT', staleDead?.message);
    const discarded = await dq.discardRecoveryById({ id: dead.id, kind: 'dead', expectedRevision: dead.revision });
    check('dead discard reaches discarded state', discarded.ok === true && store.getItem(dead.id).state === 'discarded');

    store.enqueue({ items: [{ text: 'MAYBE' }], requestId: 'maybe-fixture' });
    const run2 = store.startRun({ requestId: 'maybe-run' });
    const s2 = new DurableSession({ store, profileId, runId: run2.id, profileName: 'Default' });
    const maybe = s2.claimNext({ leaseMs: 60_000 });
    const boundary = s2.beginDispatch(maybe.text);
    s2.markAmbiguous('fixture');
    store.finishRun({ runId: run2.id, status: 'closed', requestId: 'maybe-finish' });
    const ambiguous = store.getItem(maybe.id);

    const noProof = await dq.confirmRecoveryPublishedById({ id: ambiguous.id, expectedRevision: ambiguous.revision, proof: {} });
    check('confirm published requires proof', noProof?.code === 'PROOF_REQUIRED', noProof?.message);
    const unsafeRequeue = await dq.requeueRecoveryById({ id: ambiguous.id, kind: 'pending', expectedRevision: ambiguous.revision });
    check('ambiguous evidence cannot be automatically requeued', unsafeRequeue.code === 'CONFIRMATION_REQUIRED' && store.getItem(ambiguous.id).state === 'ambiguous');
    const unsafeDiscard = await dq.discardRecovery('Default', 'pending', { id: ambiguous.id });
    check('generic text wrapper never guesses an object address', unsafeDiscard === false && store.getItem(ambiguous.id).state === 'ambiguous');
    const requeued = await dq.requeueRecoveryById({
      id: ambiguous.id, kind: 'pending', expectedRevision: ambiguous.revision,
      options: { confirmedNotPublished: true, evidence: { checked: true } },
    });
    check('explicit not-published decision requeues exact item', requeued.ok === true && store.getItem(ambiguous.id).state === 'queued');
  } catch (error) {
    failed++;
    console.error(error?.stack || error);
  }
  try { await dq.closeStore(); } catch {}
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
  console.log(`\n${failed === 0 ? '✅' : '❌'} durable-recovery-contract: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
