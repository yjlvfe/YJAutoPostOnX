'use strict';

/**
 * XP-010 — unbounded growth, no backup, no health gate.
 *
 * Three separate defects lived under one finding, and all three are pinned
 * here against the real WorkflowStore and the real durableQueue startup path:
 *
 *   1. NO BACKUP. Nothing ever copied workflow.sqlite. One bad page lost the
 *      queue, the publish history and the dedup corpus at once, with nothing to
 *      restore from. A backup that is not verified is not a backup either, so
 *      the copy is reopened and quick_check'd before it counts.
 *
 *   2. NO RETENTION. Every published post left its row, its dispatch attempts
 *      and four event rows behind forever — measured at ~7.4 KB and 4 events
 *      per post, roughly 512 MB and 292,000 event rows after two years at 100
 *      posts/day. Retention must drop the audit BULK without dropping the
 *      knowledge: the published text feeds semantic dedup, so archiving it away
 *      would make the app willing to republish everything past the cutoff.
 *
 *   3. NO HEALTH GATE. integrityCheck() existed and nothing consulted it. A
 *      store failing its own check kept granting leases and kept committing
 *      dispatches — the app published from a database it knew was damaged.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = path.join(os.tmpdir(), 'xposter-backup-' + Date.now());
os.homedir = () => SANDBOX;
fs.mkdirSync(path.join(SANDBOX, '.config', 'x-poster-bot-profile'), { recursive: true });

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
}

const { WorkflowStore } = require('../dev/automation/workflowStore');
const storeHealth = require('../dev/automation/storeHealth');

/** A fresh store in its own directory, so scenarios cannot contaminate each other. */
function freshStore(name) {
  const root = path.join(SANDBOX, name);
  fs.mkdirSync(root, { recursive: true });
  const store = new WorkflowStore({ rootDir: root });
  const profile = store.createProfile({ name: 'P', requestId: `p-${name}` });
  const run = store.startRun({ requestId: `r-${name}` });
  return { store, root, profileId: profile.id, runId: run.id };
}

/** Publish one post end to end through the real state machine. */
function publish(ctx, text, i) {
  ctx.store.enqueue({ items: [{ text }], requestId: `e-${i}-${text}` });
  const leased = ctx.store.leaseNext({ profileId: ctx.profileId, runId: ctx.runId, leaseMs: 60_000 });
  const attempt = ctx.store.beginDispatch({
    id: leased.id, leaseToken: leased.leaseToken, renderedText: text, requestId: `b-${i}-${text}`,
  });
  ctx.store.markPublished({
    attemptId: attempt.attemptId,
    externalUrl: `https://x.com/i/web/status/${i}`,
    evidence: {}, requestId: `pub-${i}-${text}`,
  });
  return leased.id;
}

const count = (store, table) => store.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;

// ─────────────────────────────────────────────────────────────────────────────

async function backupIsTakenAndVerified() {
  console.log('\n📋 XP-010.1 a verified backup exists and can actually be opened');
  const ctx = freshStore('backup');
  for (let i = 0; i < 5; i++) publish(ctx, `BACKUP_POST_${i}`, i);

  check('no backup exists before one is taken', ctx.store.lastBackup() === null);

  const result = await ctx.store.backup({ keep: 3 });
  check('the backup reports success', result.ok === true, JSON.stringify(result));
  check('it verified the copy rather than trusting it', result.verified === true);
  check('the file is really on disk and non-empty',
    result.path && fs.existsSync(result.path) && fs.statSync(result.path).size > 0,
    `path=${result.path}`);
  check('a manifest records the hash and item count',
    fs.existsSync(`${result.path}.json`));

  // The real test of a backup: open it independently and read the data back.
  const Database = require('better-sqlite3');
  const copy = new Database(result.path, { readonly: true, fileMustExist: true });
  const quick = copy.pragma('quick_check', { simple: true });
  const texts = copy.prepare(`
    SELECT json_extract(payload_json, '$.text') t FROM workflow_items WHERE state = 'published'
  `).all().map((r) => r.t);
  copy.close();
  check('the restored copy passes quick_check', quick === 'ok', `quick_check=${quick}`);
  check('the restored copy contains the published posts',
    texts.length === 5 && texts.includes('BACKUP_POST_0') && texts.includes('BACKUP_POST_4'),
    JSON.stringify(texts));

  check('the store records when it was last backed up',
    ctx.store.lastBackup() && typeof ctx.store.lastBackup().atMs === 'number');

  // Rotation must bound the backups themselves — otherwise the fix for
  // unbounded growth is a second source of unbounded growth.
  for (let i = 0; i < 5; i++) {
    await ctx.store.backup({ keep: 3, now: Date.now() + (i + 1) * 1000 });
  }
  const kept = fs.readdirSync(path.join(ctx.root, 'backups')).filter((f) => f.endsWith('.sqlite'));
  check('old backups are rotated away', kept.length === 3, `kept=${kept.length}`);

  ctx.store.close();
}

async function retentionBoundsGrowthWithoutLosingDedup() {
  console.log('\n📋 XP-010.2 retention bounds growth and keeps the dedup corpus');
  const ctx = freshStore('retention');
  const N = 40;
  for (let i = 0; i < N; i++) publish(ctx, `OLD_POST_${i}`, i);

  const before = {
    items: count(ctx.store, 'workflow_items'),
    events: count(ctx.store, 'workflow_events'),
    attempts: count(ctx.store, 'dispatch_attempts'),
  };
  check('the store accumulated a row and several events per post',
    before.items === N && before.events >= N * 3 && before.attempts === N,
    JSON.stringify(before));

  // Nothing is eligible yet — retention must never touch recent work.
  const noop = ctx.store.applyRetention({ olderThanMs: 90 * 86_400_000 });
  check('recent work is not archived', noop.archived === 0, JSON.stringify(noop));

  // Age the rows by moving the clock forward instead of mutating them.
  const future = Date.now() + 120 * 86_400_000;
  const result = ctx.store.applyRetention({ olderThanMs: 90 * 86_400_000, now: future });

  check('the aged rows are archived', result.archived === N, JSON.stringify(result));
  check('their event bulk is gone', result.eventsDeleted >= before.events,
    `deleted=${result.eventsDeleted} had=${before.events}`);
  check('the live item table shrank', count(ctx.store, 'workflow_items') === 0,
    `items=${count(ctx.store, 'workflow_items')}`);
  check('the live event table shrank', count(ctx.store, 'workflow_events') === 0,
    `events=${count(ctx.store, 'workflow_events')}`);

  // The knowledge survives.
  const archived = ctx.store.listArchivedTexts({ limit: 1000 });
  check('every published text is still readable from the archive',
    archived.length === N && archived.some((a) => a.text === 'OLD_POST_0'),
    `archived=${archived.length}`);
  const withUrl = ctx.store.db
    .prepare(`SELECT COUNT(*) n FROM archived_items WHERE external_url IS NOT NULL`).get().n;
  check('the proof that each post went out is kept', withUrl === N, `withUrl=${withUrl}`);

  // Unfinished work is untouchable at any age.
  ctx.store.enqueue({ items: [{ text: 'STILL_QUEUED' }], requestId: 'e-live' });
  const leased = ctx.store.leaseNext({ profileId: ctx.profileId, runId: ctx.runId, leaseMs: 60_000 });
  ctx.store.beginDispatch({
    id: leased.id, leaseToken: leased.leaseToken, renderedText: 'STILL_QUEUED', requestId: 'b-live',
  });
  ctx.store.markAmbiguous({ attemptId: ctx.store.listRecovery()[0].currentAttemptId, reason: 'unknown', requestId: 'amb-live' });
  const farFuture = Date.now() + 3650 * 86_400_000;
  const second = ctx.store.applyRetention({ olderThanMs: 90 * 86_400_000, now: farFuture });
  check('an unresolved item is never archived, at any age', second.archived === 0,
    JSON.stringify(second));
  check('it is still awaiting a human decision',
    ctx.store.countUnresolvedRecovery() === 1);

  ctx.store.close();
}

async function healthGateBlocksTheBoundary() {
  console.log('\n📋 XP-010.3 an unhealthy store cannot cross the dispatch boundary');
  const ctx = freshStore('health');

  // A post with media, published, so its managed blob is durably referenced.
  const src = path.join(SANDBOX, 'health-pic.png');
  fs.writeFileSync(src, Buffer.from('89504e470d0a1a0a' + '00'.repeat(64), 'hex'));
  ctx.store.enqueue({ items: [{ text: 'WITH_MEDIA', media_path: src }], requestId: 'e-m' });
  const lm = ctx.store.leaseNext({ profileId: ctx.profileId, runId: ctx.runId, leaseMs: 60_000 });
  const am = ctx.store.beginDispatch({
    id: lm.id, leaseToken: lm.leaseToken, renderedText: 'WITH_MEDIA', requestId: 'b-m',
  });
  ctx.store.markPublished({ attemptId: am.attemptId, externalUrl: 'https://x.com/i/web/status/m', evidence: {}, requestId: 'p-m' });

  const healthy = storeHealth.evaluate(ctx.store);
  check('a clean store evaluates healthy', healthy.ok === true, JSON.stringify(healthy.blocking));
  check('and the gate it latches is open', ctx.store.healthGate().blocked === false);

  // Bit rot on managed media: the bytes no longer match what was recorded.
  const blob = ctx.store.db.prepare('SELECT relative_path FROM media_blobs LIMIT 1').get();
  fs.writeFileSync(path.join(ctx.root, 'media', blob.relative_path), 'CORRUPTED');

  const sick = storeHealth.evaluate(ctx.store);
  check('the damage is detected', sick.ok === false, JSON.stringify(sick.blocking));
  check('the gate is latched shut with a reason',
    ctx.store.healthGate().blocked === true && !!ctx.store.healthGate().reason,
    JSON.stringify(ctx.store.healthGate()));

  // The boundary itself must refuse — for an UNRELATED post with no media.
  ctx.store.enqueue({ items: [{ text: 'AFTER_CORRUPTION' }], requestId: 'e-after' });
  const leased = ctx.store.leaseNext({ profileId: ctx.profileId, runId: ctx.runId, leaseMs: 60_000 });
  check('a lease can still be taken (reading is not the irreversible part)', !!leased);

  let error = null;
  try {
    ctx.store.beginDispatch({
      id: leased.id, leaseToken: leased.leaseToken,
      renderedText: 'AFTER_CORRUPTION', requestId: 'b-after',
    });
  } catch (e) { error = e; }

  check('beginDispatch REFUSES on an unhealthy store', error !== null,
    'the irreversible boundary was crossed anyway');
  check('the refusal is typed so the caller can explain it',
    error && error.code === 'STORE_UNHEALTHY', `code=${error && error.code}`);
  const state = ctx.store.db.prepare('SELECT state FROM workflow_items WHERE id = ?').get(leased.id).state;
  check('the item did not enter dispatch_started', state !== 'dispatch_started', `state=${state}`);

  // The gate is durable: a crash must not reopen it.
  ctx.store.close();
  const reopened = new WorkflowStore({ rootDir: ctx.root });
  check('the gate survives a restart', reopened.healthGate().blocked === true,
    JSON.stringify(reopened.healthGate()));

  // Repair the media, re-evaluate, and the gate opens again.
  fs.writeFileSync(path.join(ctx.root, 'media', blob.relative_path),
    Buffer.from('89504e470d0a1a0a' + '00'.repeat(64), 'hex'));
  const repaired = storeHealth.evaluate(reopened);
  check('repairing the damage reopens the gate', repaired.ok === true,
    JSON.stringify(repaired.blocking));
  reopened.close();
}

async function startupMaintenanceOrdersItsStepsSafely() {
  console.log('\n📋 XP-010.4 startup maintenance refuses to act on a damaged store');
  const ctx = freshStore('maintenance');
  for (let i = 0; i < 3; i++) publish(ctx, `MAINT_${i}`, i);

  const good = await storeHealth.runStartupMaintenance(ctx.store, { force: true });
  check('a healthy store gets a backup', good.backup && good.backup.ok === true,
    JSON.stringify(good.backup));
  check('and retention runs behind it', good.retention && typeof good.retention.archived === 'number',
    JSON.stringify(good.retention));

  const backupsAfterGood = fs.readdirSync(path.join(ctx.root, 'backups'))
    .filter((f) => f.endsWith('.sqlite')).length;

  // Damage it, then run maintenance again.
  const src = path.join(SANDBOX, 'maint-pic.png');
  fs.writeFileSync(src, Buffer.from('89504e470d0a1a0a' + '11'.repeat(64), 'hex'));
  ctx.store.enqueue({ items: [{ text: 'MEDIA_POST', media_path: src }], requestId: 'e-mm' });
  const blob = ctx.store.db.prepare('SELECT relative_path FROM media_blobs ORDER BY rowid DESC LIMIT 1').get();
  fs.writeFileSync(path.join(ctx.root, 'media', blob.relative_path), 'ROT');

  const bad = await storeHealth.runStartupMaintenance(ctx.store, { force: true });
  check('a damaged store is not backed up over the last good copy',
    bad.backup === null && bad.skipped.includes('backup:store_unhealthy'),
    JSON.stringify(bad.skipped));
  check('and retention does not delete evidence from it',
    bad.retention === null && bad.skipped.includes('retention:store_unhealthy'),
    JSON.stringify(bad.skipped));
  const backupsAfterBad = fs.readdirSync(path.join(ctx.root, 'backups'))
    .filter((f) => f.endsWith('.sqlite')).length;
  check('the good backup is still there, untouched',
    backupsAfterBad === backupsAfterGood, `${backupsAfterBad} vs ${backupsAfterGood}`);

  ctx.store.close();
}

async function dedupCorpusSpansTheArchive() {
  console.log('\n📋 XP-010.5 retention does not make the app republish old posts');

  // Through the live adapter, which is what the AI dedup actually reads.
  const durableQueue = require('../dev/automation/durableQueue');
  const store = await durableQueue.getStore();
  const profileId = await durableQueue.resolveProfileId('Default');
  const run = store.startRun({ requestId: 'r-dedup' });

  await durableQueue.addPosts(['ARCHIVE_ME_XP010']);
  const leased = store.leaseNext({ profileId, runId: run.id, leaseMs: 60_000 });
  const attempt = store.beginDispatch({
    id: leased.id, leaseToken: leased.leaseToken,
    renderedText: 'ARCHIVE_ME_XP010', requestId: 'b-dedup',
  });
  store.markPublished({
    attemptId: attempt.attemptId, externalUrl: 'https://x.com/i/web/status/dedup',
    evidence: {}, requestId: 'p-dedup',
  });
  store.finishRun({ runId: run.id, status: 'closed', requestId: 'f-dedup' });

  check('the published text is in the dedup corpus before retention',
    (await durableQueue.getPublishedTexts()).includes('ARCHIVE_ME_XP010'));

  const archived = store.applyRetention({
    olderThanMs: 86_400_000, now: Date.now() + 10 * 86_400_000,
  });
  check('retention archived it out of the live table', archived.archived >= 1,
    JSON.stringify(archived));
  check('the live table no longer holds it',
    store.listItems({ states: ['published'], limit: 100 })
      .every((i) => (i.payload.text || '') !== 'ARCHIVE_ME_XP010'));

  check('but the dedup corpus still contains it — it will not be generated again',
    (await durableQueue.getPublishedTexts()).includes('ARCHIVE_ME_XP010'));

  await durableQueue.closeStore();
}

(async () => {
  console.log('🧪 XP-010 — backup, retention and the health gate');
  console.log(`   sandbox HOME: ${SANDBOX}`);
  try {
    await backupIsTakenAndVerified();
    await retentionBoundsGrowthWithoutLosingDedup();
    await healthGateBlocksTheBoundary();
    await startupMaintenanceOrdersItsStepsSafely();
    await dedupCorpusSpansTheArchive();
  } catch (error) {
    failed++;
    console.error('\n💥 scenario crashed:', error && error.stack ? error.stack : error);
  }

  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(`\n${failed === 0 ? '✅' : '❌'} XP-010: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
