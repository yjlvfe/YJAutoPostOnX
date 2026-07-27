'use strict';

/**
 * XP-006 — recovery and deletion addressed by TEXT instead of identity.
 *
 * Every mutation the operator can trigger from the recovery panel and the queue
 * screen resolved its target with `.find(item => text === postText)`. Text is
 * not an identity: the durable store keys rows by UUID, two rows can legally
 * carry the same text, and the row the operator clicked is not necessarily the
 * first one that matches.
 *
 * The four failures pinned here are all reachable through production code, with
 * no direct SQL and no synthetic state:
 *
 *   1. A dead letter cannot be deleted at all. `discardRecovery` routes every
 *      kind through `resolveRecovery`, which only accepts `ambiguous`, so the
 *      delete button on a dead letter raises the store's internal English
 *      conflict at the operator and leaves the row forever.
 *
 *   2. Two dead rows may hold the same text — the enqueue dedup spans the
 *      backlog and the unresolved states, but NOT `dead` — and then requeue and
 *      discard hit whichever row `.find` reaches first, while the UI reports
 *      success for the row the operator actually clicked.
 *
 *   3. Requeueing a dead row whose text is already queued puts two identical
 *      rows in the backlog; deleting the one the operator selected then
 *      discards both, and the count returned to the UI is not the count of what
 *      was asked for.
 *
 *   4. `confirmRecoveryPublished` attaches the operator's external URL and
 *      proof to the first matching row. Confirming one post can stamp another
 *      post's durable record as published, with evidence that belongs to a
 *      different tweet.
 *
 * These run against durableQueue — the module the IPC handlers call — not
 * against a copy of its logic.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = path.join(os.tmpdir(), 'xposter-recovery-id-' + Date.now());
os.homedir = () => SANDBOX;
process.env.HOME = SANDBOX; // belt-and-suspenders: see smoke.test.js for why
fs.mkdirSync(path.join(SANDBOX, '.config', 'x-poster-bot-profile'), { recursive: true });

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
}

const durableQueue = require('../dev/automation/durableQueue');
const { DurableSession } = require('../dev/automation/durableSession');

const textOf = (row) => (typeof row === 'string' ? row : row.text);

/** Drive one post from the queue into `dead`, through the real session. */
async function makeDeadLetter(text, reason = 'net_failure') {
  const store = await durableQueue.getStore();
  const profileId = await durableQueue.resolveProfileId('Default');
  const run = store.startRun({ requestId: `r-dead-${text}-${Date.now()}` });
  const session = new DurableSession({ store, profileId, runId: run.id, profileName: 'Default' });
  const claimed = session.claimNext({ leaseMs: 60_000 });
  if (!claimed) throw new Error(`nothing claimable for ${text}`);
  if (claimed.payload.text !== text) throw new Error(`claimed ${claimed.payload.text}, wanted ${text}`);
  session.markTerminal(reason, new Error('permanent failure'));
  store.finishRun({ runId: run.id, status: 'closed', requestId: `f-dead-${Date.now()}` });
  return claimed.id;
}

/** Drive one post across the boundary and leave it ambiguous. */
async function makeAmbiguous(text) {
  const store = await durableQueue.getStore();
  const profileId = await durableQueue.resolveProfileId('Default');
  const run = store.startRun({ requestId: `r-amb-${Date.now()}` });
  const session = new DurableSession({ store, profileId, runId: run.id, profileName: 'Default' });
  const claimed = session.claimNext({ leaseMs: 60_000 });
  if (!claimed || claimed.payload.text !== text) {
    throw new Error(`claimed ${claimed && claimed.payload.text}, wanted ${text}`);
  }
  const begun = session.beginDispatch(text);
  if (!begun.ok) throw new Error(`beginDispatch refused: ${begun.reason}`);
  session.markAmbiguous('toast_never_appeared', new Error('unknown outcome'));
  store.finishRun({ runId: run.id, status: 'closed', requestId: `f-amb-${Date.now()}` });
  return claimed.id;
}

/** Empty the backlog so each scenario measures only its own rows. */
async function clearBacklog() {
  const texts = (await durableQueue.getQueue()).map(textOf).filter(Boolean);
  if (texts.length) await durableQueue.bulkDeleteByText(texts);
}

// ─────────────────────────────────────────────────────────────────────────────

async function deadLetterCanBeDeleted() {
  console.log('\n📋 XP-006.1 a dead letter can actually be deleted');
  await clearBacklog();

  await durableQueue.addPosts(['DEAD_DELETE_ME']);
  const deadId = await makeDeadLetter('DEAD_DELETE_ME');

  const before = await durableQueue.getRecoveryItems('Default');
  check('the dead letter is offered to the operator',
    before.deadLetters.some((d) => d.id === deadId),
    `deadLetters=${JSON.stringify(before.deadLetters.map((d) => d.text))}`);

  let thrown = null;
  let result = null;
  try {
    result = await durableQueue.discardRecoveryById({ id: deadId, kind: 'dead' });
  } catch (error) {
    thrown = error;
  }

  check('deleting a dead letter does not raise a store conflict at the operator',
    thrown === null, thrown ? `${thrown.code || ''} ${thrown.message}` : '');
  check('the delete is reported as done', result && result.ok === true,
    `result=${JSON.stringify(result)}`);

  const after = await durableQueue.getRecoveryItems('Default');
  check('the dead letter is really gone from the recovery list',
    !after.deadLetters.some((d) => d.id === deadId),
    `still present=${JSON.stringify(after.deadLetters.map((d) => d.id))}`);

  const store = await durableQueue.getStore();
  const row = store.db.prepare('SELECT state FROM workflow_items WHERE id = ?').get(deadId);
  check('the row moved to a durable tombstone, not deletion',
    row && row.state === 'discarded', `state=${row && row.state}`);
}

async function identicalTextsResolveTheClickedRow() {
  console.log('\n📋 XP-006.2 two dead rows with one text — the clicked row is the one that moves');
  await clearBacklog();

  await durableQueue.addPosts(['SAME_TEXT_XP006']);
  const firstDead = await makeDeadLetter('SAME_TEXT_XP006', 'first_failure');

  // Reachability: the enqueue dedup spans the backlog and the unresolved
  // states, so a text that is only in `dead` is accepted again. This is how two
  // rows with one text arrive in production.
  const readd = await durableQueue.addPosts(['SAME_TEXT_XP006']);
  check('a text that only exists in `dead` can be queued again (reachability)',
    readd.added === 1, `addPosts=${JSON.stringify(readd)}`);
  const secondDead = await makeDeadLetter('SAME_TEXT_XP006', 'second_failure');

  check('two distinct dead rows now carry the same text', firstDead !== secondDead,
    `first=${firstDead} second=${secondDead}`);

  const listed = (await durableQueue.getRecoveryItems('Default')).deadLetters
    .filter((d) => d.text === 'SAME_TEXT_XP006');
  check('both are listed, each with its own id', listed.length === 2,
    `listed=${JSON.stringify(listed.map((d) => d.id))}`);

  // The operator clicks the SECOND row.
  const discard = await durableQueue.discardRecoveryById({ id: secondDead, kind: 'dead' });
  check('discarding the second row reports success', discard && discard.ok === true,
    `discard=${JSON.stringify(discard)}`);

  const store = await durableQueue.getStore();
  const stateOf = (id) => store.db.prepare('SELECT state FROM workflow_items WHERE id = ?').get(id).state;

  check('the row the operator clicked is the one that moved',
    stateOf(secondDead) === 'discarded', `second=${stateOf(secondDead)}`);
  check('the other row with the same text was NOT touched',
    stateOf(firstDead) === 'dead', `first=${stateOf(firstDead)}`);

  // And requeue must be just as precise.
  const requeue = await durableQueue.requeueRecoveryById({ id: firstDead, kind: 'dead' });
  check('requeueing by id reports success', requeue && requeue.ok === true,
    `requeue=${JSON.stringify(requeue)}`);
  check('the requeued row is the one addressed', stateOf(firstDead) === 'queued',
    `first=${stateOf(firstDead)}`);
  check('the discarded row stayed discarded', stateOf(secondDead) === 'discarded',
    `second=${stateOf(secondDead)}`);
}

async function staleClickIsRefusedNotMisapplied() {
  console.log('\n📋 XP-006.3 a stale click is refused, and says so');
  await clearBacklog();

  await durableQueue.addPosts(['STALE_CLICK_XP006']);
  const deadId = await makeDeadLetter('STALE_CLICK_XP006');
  const listed = (await durableQueue.getRecoveryItems('Default')).deadLetters
    .find((d) => d.id === deadId);
  check('the recovery row carries the revision the operator saw',
    Number.isInteger(listed.revision), `revision=${listed && listed.revision}`);

  // Another window resolves it first.
  const first = await durableQueue.discardRecoveryById({
    id: deadId, kind: 'dead', expectedRevision: listed.revision,
  });
  check('the first click succeeds', first.ok === true, JSON.stringify(first));

  // The stale window clicks with the revision it still holds.
  const second = await durableQueue.discardRecoveryById({
    id: deadId, kind: 'dead', expectedRevision: listed.revision,
  });
  check('the stale click is refused rather than applied twice', second.ok === false,
    JSON.stringify(second));
  check('the refusal names a cause the UI can explain',
    typeof second.reason === 'string' && second.reason.length > 0,
    `reason=${second.reason}`);

  // A click on a row that no longer exists must not report success.
  const missing = await durableQueue.discardRecoveryById({ id: 'no-such-id', kind: 'dead' });
  check('deleting an unknown id reports failure, not success', missing.ok === false,
    JSON.stringify(missing));
}

async function deletingOneRowDeletesOneRow() {
  console.log('\n📋 XP-006.4 deleting the selected row deletes exactly that row');
  await clearBacklog();

  // Reachable duplicate: a dead row is requeued while the same text is queued.
  await durableQueue.addPosts(['DUP_DELETE_XP006']);
  const deadId = await makeDeadLetter('DUP_DELETE_XP006');
  await durableQueue.addPosts(['DUP_DELETE_XP006']);
  await durableQueue.requeueRecoveryById({ id: deadId, kind: 'dead' });

  const backlog = await durableQueue.getQueueDetailed();
  const dupes = backlog.filter((i) => i.payload.text === 'DUP_DELETE_XP006');
  check('two identical rows are genuinely in the backlog (reachability)',
    dupes.length === 2, `count=${dupes.length}`);

  const target = dupes[1];
  const other = dupes[0];
  const result = await durableQueue.bulkDeleteByIds([
    { id: target.id, expectedRevision: target.revision },
  ]);

  check('exactly one row is reported deleted', result.deleted === 1,
    JSON.stringify({ deleted: result.deleted, blocked: result.blocked }));

  const store = await durableQueue.getStore();
  const stateOf = (id) => store.db.prepare('SELECT state FROM workflow_items WHERE id = ?').get(id).state;
  check('the selected row is discarded', stateOf(target.id) === 'discarded',
    `target=${stateOf(target.id)}`);
  check('the sibling with the same text survived', stateOf(other.id) === 'queued',
    `other=${stateOf(other.id)}`);

  // An id that is past the boundary must be reported blocked, never "deleted".
  await clearBacklog();
  await durableQueue.addPosts(['INFLIGHT_XP006']);
  const inflight = (await durableQueue.getQueueDetailed())
    .find((i) => i.payload.text === 'INFLIGHT_XP006');
  const storeRef = await durableQueue.getStore();
  const profileId = await durableQueue.resolveProfileId('Default');
  const run = storeRef.startRun({ requestId: 'r-inflight' });
  const session = new DurableSession({
    store: storeRef, profileId, runId: run.id, profileName: 'Default',
  });
  session.claimNext({ leaseMs: 60_000 });
  session.beginDispatch('INFLIGHT_XP006');

  const blockedResult = await durableQueue.bulkDeleteByIds([
    { id: inflight.id, expectedRevision: inflight.revision },
  ]);
  check('an item past the dispatch boundary is blocked, not claimed deleted',
    blockedResult.deleted === 0 && blockedResult.blocked.length === 1,
    JSON.stringify(blockedResult));
  check('the block names the state so the UI can be honest',
    /DISPATCH_STARTED|IN_FLIGHT|INVALID_STATE|REVISION/i.test(
      String(blockedResult.blocked[0] && blockedResult.blocked[0].reason)),
    JSON.stringify(blockedResult.blocked));

  session.markAmbiguous('cleanup', new Error('test teardown'));
  storeRef.finishRun({ runId: run.id, status: 'closed', requestId: 'f-inflight' });
}

async function confirmationLandsOnTheConfirmedRow() {
  console.log('\n📋 XP-006.5 published-confirmation proof lands on the confirmed row');

  // Resolve whatever the previous scenario left unresolved.
  for (const item of (await durableQueue.getRecoveryItems('Default')).pending) {
    await durableQueue.discardRecoveryById({ id: item.id, kind: 'pending' });
  }
  await clearBacklog();

  // Two rows, same text. Only one may be unresolved at a time — the recovery
  // gate sees to that — so the collision is built the way production builds it:
  // one row is ambiguous, the other is its identical twin sitting in `dead`.
  await durableQueue.addPosts(['CONFIRM_XP006']);
  const deadTwin = await makeDeadLetter('CONFIRM_XP006');
  await durableQueue.addPosts(['CONFIRM_XP006']);
  const ambiguousId = await makeAmbiguous('CONFIRM_XP006');

  const pending = (await durableQueue.getRecoveryItems('Default')).pending;
  check('the ambiguous row is the one awaiting confirmation',
    pending.length === 1 && pending[0].id === ambiguousId,
    `pending=${JSON.stringify(pending.map((p) => p.id))}`);

  const confirmed = await durableQueue.confirmRecoveryPublishedById({
    id: ambiguousId,
    proof: { externalUrl: 'https://x.com/i/web/status/1234567890' },
  });
  check('the confirmation reports success', confirmed.ok === true, JSON.stringify(confirmed));

  const store = await durableQueue.getStore();
  const stateOf = (id) => store.db.prepare('SELECT state FROM workflow_items WHERE id = ?').get(id).state;
  check('the confirmed row is the one that became published',
    stateOf(ambiguousId) === 'published', `ambiguous=${stateOf(ambiguousId)}`);
  check('its identical twin was not stamped published',
    stateOf(deadTwin) === 'dead', `twin=${stateOf(deadTwin)}`);

  const attempt = store.db.prepare(`
    SELECT external_url FROM dispatch_attempts WHERE item_id = ? ORDER BY created_at_ms DESC LIMIT 1
  `).get(ambiguousId);
  check('the operator proof is attached to the confirmed row',
    attempt && attempt.external_url === 'https://x.com/i/web/status/1234567890',
    `url=${attempt && attempt.external_url}`);

  const twinAttempt = store.db.prepare(
    'SELECT COUNT(*) n FROM dispatch_attempts WHERE item_id = ? AND external_url IS NOT NULL'
  ).get(deadTwin);
  check('no proof leaked onto the twin', twinAttempt.n === 0, `n=${twinAttempt.n}`);

  check('the recovery gate is clear again',
    (await durableQueue.countUnresolved()) === 0);
}

async function ipcContractCarriesIdentity() {
  console.log('\n📋 XP-006.6 the IPC contract carries identity end to end');

  const preload = fs.readFileSync(path.join(__dirname, '..', 'dev', 'preload.js'), 'utf8');
  // Not a source-string proof of behaviour — a shape check on the bridge, which
  // has no other observable surface from a node test: the renderer can only
  // send what preload accepts.
  const bridge = preload.match(/discardRecoveryItem:\s*\(([^)]*)\)/);
  check('preload.discardRecoveryItem takes a descriptor, not (profile, kind, text)',
    bridge && !/text/.test(bridge[1]), `signature=(${bridge && bridge[1]})`);

  const listed = (await durableQueue.getRecoveryItems('Default'));
  const everyRow = [...listed.pending, ...listed.deadLetters];
  check('every recovery row the UI receives carries an id and a revision',
    everyRow.every((r) => typeof r.id === 'string' && Number.isInteger(r.revision)),
    JSON.stringify(everyRow.map((r) => ({ id: r.id, revision: r.revision }))));

  const backlog = await durableQueue.getQueueDetailed();
  check('every backlog row the UI receives carries an id and a revision',
    backlog.every((r) => typeof r.id === 'string' && Number.isInteger(r.revision)),
    JSON.stringify(backlog.map((r) => ({ id: r.id, revision: r.revision }))));
}

(async () => {
  console.log('🧪 XP-006 — recovery and deletion addressed by identity');
  console.log(`   sandbox HOME: ${SANDBOX}`);
  try {
    await deadLetterCanBeDeleted();
    await identicalTextsResolveTheClickedRow();
    await staleClickIsRefusedNotMisapplied();
    await deletingOneRowDeletesOneRow();
    await confirmationLandsOnTheConfirmedRow();
    await ipcContractCarriesIdentity();
  } catch (error) {
    failed++;
    console.error('\n💥 scenario crashed:', error && error.stack ? error.stack : error);
  }

  await durableQueue.closeStore();
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* best effort */ }

  console.log(`\n${failed === 0 ? '✅' : '❌'} XP-006: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
