'use strict';

/**
 * XP-005 — a deferred post vanished from the queue and could be added twice.
 *
 * `listQueued` returns only rows that are claimable RIGHT NOW. Both the
 * operator's queue view and the enqueue dedup read that, so a post whose
 * network attempt failed and was deferred for an hour showed up nowhere:
 * the queue screen said empty, recovery said empty, and re-adding the same
 * text was accepted. The durable backlog then held two rows for one post, and
 * both eventually published.
 *
 * The split these tests pin:
 *   - the BACKLOG (queued + deferred + leased) is what the operator sees;
 *   - READY-NOW (queued) is what the publisher may claim;
 *   - dedup spans everything that still owes an outcome, including the
 *     unresolved states awaiting a human.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = path.join(os.tmpdir(), 'xposter-backlog-' + Date.now());
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

const textsOf = (rows) => rows.map((r) => (typeof r === 'string' ? r : r.text));

async function deferredStaysVisibleAndBlocksDuplicates() {
  console.log('\n📋 XP-005.1 a deferred post is visible and not re-addable');

  const store = await durableQueue.getStore();
  const profileId = await durableQueue.resolveProfileId('Default');
  await durableQueue.addPosts(['DEFER_ME', 'STAYS_READY']);

  // Defer the head for an hour, exactly as a network failure does.
  const run = store.startRun({ requestId: 'r-defer' });
  const session = new DurableSession({ store, profileId, runId: run.id, profileName: 'Default' });
  session.claimNext({ leaseMs: 60_000 });
  session.markDeferred('network_failure', new Error('net::ERR'), 60 * 60_000);
  store.finishRun({ runId: run.id, status: 'closed', requestId: 'f-defer' });

  const backlog = textsOf(await durableQueue.getQueue());
  const ready = textsOf((await durableQueue.getReadyNow()).map(durableQueue.toLegacyEntry));

  check('the deferred post is still visible in the backlog', backlog.includes('DEFER_ME'),
    `backlog=${JSON.stringify(backlog)}`);
  check('it is NOT offered as ready to publish', !ready.includes('DEFER_ME'),
    `ready=${JSON.stringify(ready)}`);
  check('the still-ready post is in both views',
    backlog.includes('STAYS_READY') && ready.includes('STAYS_READY'));
  check('the queue never reports empty while work is outstanding', backlog.length >= 2,
    `backlog=${JSON.stringify(backlog)}`);

  // THE BUG: this used to be accepted and produce a second row.
  const again = await durableQueue.addPosts(['DEFER_ME']);
  check('re-adding a deferred post is rejected as a duplicate',
    again.added === 0 && again.skippedDuplicate === 1, JSON.stringify(again));

  const rows = durableQueue.readAllItems(store, ['queued', 'deferred'])
    .filter((i) => durableQueue.textOf(i) === 'DEFER_ME');
  check('exactly one durable row exists for that text', rows.length === 1, `rows=${rows.length}`);
  check('the deferred row records its failure count',
    rows[0] && typeof rows[0].preDispatchFailureCount === 'number',
    `preDispatchFailureCount=${rows[0] && rows[0].preDispatchFailureCount}`);
}

async function backlogCountsSeparateReadyFromWaiting() {
  console.log('\n📋 XP-005.2 counts distinguish ready from waiting');
  const counts = await durableQueue.getBacklogCounts();
  check('counts expose deferred separately', counts.deferred >= 1, JSON.stringify(counts));
  check('backlog total exceeds ready-now while something waits',
    counts.backlog > counts.readyNow, JSON.stringify(counts));
  check('ready-now equals the queued count', counts.readyNow === counts.queued, JSON.stringify(counts));
}

async function detailedViewExplainsTheWait() {
  console.log('\n📋 XP-005.3 the UI can explain WHY a post is not going out');
  const detailed = await durableQueue.getQueueDetailed();
  const deferred = detailed.find((i) => durableQueue.textOf(i) === 'DEFER_ME');
  check('the deferred item is present in the detailed view', !!deferred);
  if (deferred) {
    check('it carries the state', deferred.state === 'deferred', `state=${deferred.state}`);
    check('it carries a not-before timestamp', typeof deferred.notBeforeMs === 'number',
      `notBeforeMs=${deferred.notBeforeMs}`);
    check('it carries a positive countdown', deferred.waitingMs > 0, `waitingMs=${deferred.waitingMs}`);
    check('it carries the reason it was deferred', !!deferred.deferReason,
      `deferReason=${deferred.deferReason}`);
  }
}

async function deleteAndExportOperateOnBacklog() {
  console.log('\n📋 XP-005.4 delete/export reach a deferred post');
  const before = textsOf(await durableQueue.getQueue());
  check('the deferred post is in the export/delete surface', before.includes('DEFER_ME'));

  const res = await durableQueue.bulkDeleteByText(['DEFER_ME']);
  check('deleting a deferred post actually deletes it', res.deleted === 1, JSON.stringify(res));

  const after = textsOf(await durableQueue.getQueue());
  check('it is gone from the backlog', !after.includes('DEFER_ME'), JSON.stringify(after));

  // And once gone, the text may legitimately be added again.
  const readd = await durableQueue.addPosts(['DEFER_ME']);
  check('after deletion the text is addable again', readd.added === 1, JSON.stringify(readd));
}

async function unresolvedWorkAlsoBlocksDuplicates() {
  console.log('\n📋 XP-005.5 an unresolved dispatch blocks a duplicate add');
  const store = await durableQueue.getStore();
  const profileId = await durableQueue.resolveProfileId('Default');

  // Empty the backlog first: releasing a claim returns the item to the HEAD,
  // so "claim until we reach the one we want" would spin forever.
  const leftovers = textsOf(await durableQueue.getQueue());
  if (leftovers.length) await durableQueue.bulkDeleteByText(leftovers);
  await durableQueue.addPosts(['MAYBE_LIVE']);

  // Drive it past the boundary and leave it ambiguous — the state where the
  // post may already be on X and re-adding it is the worst possible action.
  const run = store.startRun({ requestId: 'r-amb' });
  const session = new DurableSession({ store, profileId, runId: run.id, profileName: 'Default' });
  const claim = session.claimNext({ leaseMs: 60_000 });
  check('the post is claimable to begin with', !!claim && claim.text === 'MAYBE_LIVE',
    `claim=${claim && claim.text}`);
  if (claim) {
    const dispatch = session.beginDispatch('MAYBE_LIVE');
    check('it reached the boundary', dispatch.ok === true, `code=${dispatch.code}`);
    if (dispatch.ok) session.markAmbiguous('test_ambiguous');
  }
  store.finishRun({ runId: run.id, status: 'closed', requestId: 'f-amb' });

  const dup = await durableQueue.addPosts(['MAYBE_LIVE']);
  check('re-adding a post that may already be live is rejected',
    dup.added === 0 && dup.skippedDuplicate === 1, JSON.stringify(dup));
}

(async () => {
  console.log('=== XP-005: deferred backlog visibility and dedup ===');
  try {
    await deferredStaysVisibleAndBlocksDuplicates();
    await backlogCountsSeparateReadyFromWaiting();
    await detailedViewExplainsTheWait();
    await deleteAndExportOperateOnBacklog();
    await unresolvedWorkAlsoBlocksDuplicates();
  } catch (error) {
    failed++;
    console.error('\n❌ suite threw:', error && error.stack ? error.stack : error);
  }
  try { await durableQueue.closeStore(); } catch { /* best effort */ }
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(`\n${failed === 0 ? '✅' : '❌'} durable-backlog-visibility: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
