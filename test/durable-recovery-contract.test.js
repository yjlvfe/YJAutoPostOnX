'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = path.join(os.tmpdir(), 'xposter-recovery-contract-' + Date.now());
os.homedir = () => SANDBOX;
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
    const byText = await dq.bulkDeleteByText(['SAME']);
    check('duplicate text is never guessed', byText.deleted === 0 && byText.blocked[0]?.reason === 'AMBIGUOUS_TEXT_ADDRESS', JSON.stringify(byText));
    const selected = store.getItem(duplicate[1].id);
    const byId = await dq.bulkDeleteById([{
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
    const staleDelete = await dq.bulkDeleteById([{
      id: stale.id,
      expectedRevision: stale.revision,
      requestId: 'stale-delete',
    }]);
    check('a stale queue revision is reported, not applied', staleDelete.deleted === 0 && staleDelete.blocked[0]?.reason === 'REVISION_CONFLICT', JSON.stringify(staleDelete));
    session.markTerminal('fixture', new Error('fixture'));
    store.finishRun({ runId: run.id, status: 'closed', requestId: 'stale-finish' });

    const dead = store.getItem(stale.id);
    const staleDead = await dq.discardDead({ id: dead.id, expectedRevision: dead.revision - 1, requestId: 'stale-dead' }).then(() => null, (error) => error);
    check('stale dead revision is rejected', staleDead?.code === 'REVISION_CONFLICT', staleDead?.message);
    const discarded = await dq.discardDead({ id: dead.id, expectedRevision: dead.revision, requestId: 'discard-dead' });
    check('dead discard reaches discarded state', discarded === true && store.getItem(dead.id).state === 'discarded');

    store.enqueue({ items: [{ text: 'MAYBE' }], requestId: 'maybe-fixture' });
    const run2 = store.startRun({ requestId: 'maybe-run' });
    const s2 = new DurableSession({ store, profileId, runId: run2.id, profileName: 'Default' });
    const maybe = s2.claimNext({ leaseMs: 60_000 });
    const boundary = s2.beginDispatch(maybe.text);
    s2.markAmbiguous('fixture');
    store.finishRun({ runId: run2.id, status: 'closed', requestId: 'maybe-finish' });
    const ambiguous = store.getItem(maybe.id);

    const noProof = await dq.confirmPublished({ id: ambiguous.id, expectedRevision: ambiguous.revision, requestId: 'no-proof' }, {}).then(() => null, (error) => error);
    check('confirm published requires proof', noProof?.code === 'PROOF_REQUIRED', noProof?.message);
    const unsafeDiscard = await dq.discardRecovery('Default', 'pending', { id: ambiguous.id, expectedRevision: ambiguous.revision, requestId: 'unsafe' }).then(() => null, (error) => error);
    check('ambiguous evidence cannot be generically discarded', unsafeDiscard?.code === 'UNSAFE_RECOVERY_ACTION', unsafeDiscard?.message);
    const requeued = await dq.confirmNotPublishedAndRequeue(
      { id: ambiguous.id, expectedRevision: ambiguous.revision, requestId: 'confirmed-not-published' },
      { confirmedNotPublished: true, evidence: { checked: true } },
    );
    check('explicit not-published decision requeues exact item', requeued === true && store.getItem(ambiguous.id).state === 'queued');
  } catch (error) {
    failed++;
    console.error(error?.stack || error);
  }
  try { await dq.closeStore(); } catch {}
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
  console.log(`\n${failed === 0 ? '✅' : '❌'} durable-recovery-contract: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
