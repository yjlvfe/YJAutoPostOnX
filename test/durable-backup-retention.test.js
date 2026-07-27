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

  // Unfinished work is untouchable at any age — dispatch_started specifically,
  // not just its eventual ambiguous outcome. Age the row directly rather than
  // moving `now`, so this stands alone from the ambiguous case below.
  const farFuture = Date.now() + 3650 * 86_400_000;
  ctx.store.enqueue({ items: [{ text: 'MID_FLIGHT' }], requestId: 'e-mid' });
  const midLease = ctx.store.leaseNext({ profileId: ctx.profileId, runId: ctx.runId, leaseMs: 60_000 });
  const midAttempt = ctx.store.beginDispatch({
    id: midLease.id, leaseToken: midLease.leaseToken, renderedText: 'MID_FLIGHT', requestId: 'b-mid',
  });
  ctx.store.db.prepare(`UPDATE workflow_items SET updated_at_ms = ? WHERE id = ?`)
    .run(Date.now() - 3650 * 86_400_000, midLease.id);
  check('the item really is sitting in dispatch_started, mid-flight',
    ctx.store.db.prepare('SELECT state FROM workflow_items WHERE id = ?').get(midLease.id).state === 'dispatch_started');
  const midFlightAttempt = ctx.store.applyRetention({
    olderThanMs: 90 * 86_400_000, now: farFuture, states: ['dispatch_started', 'published', 'discarded', 'dead'],
  });
  check('a mid-flight dispatch is never archived, even ten years old and explicitly requested',
    midFlightAttempt.archived === 0, JSON.stringify(midFlightAttempt));
  check('it is still exactly where it was — dispatch_started, not silently moved',
    ctx.store.db.prepare('SELECT state FROM workflow_items WHERE id = ?').get(midLease.id).state === 'dispatch_started');

  // Close it out before continuing — an unresolved dispatch blocks every
  // later lease in this store, by design (XP-003).
  ctx.store.markAmbiguous({ attemptId: midAttempt.attemptId, reason: 'test-cleanup', requestId: 'amb-mid' });
  ctx.store.resolveRecovery({ id: midLease.id, action: 'close', evidence: { by: 'test-cleanup' }, requestId: 'res-mid' });

  // Unfinished work is untouchable at any age.
  ctx.store.enqueue({ items: [{ text: 'STILL_QUEUED' }], requestId: 'e-live' });
  const leased = ctx.store.leaseNext({ profileId: ctx.profileId, runId: ctx.runId, leaseMs: 60_000 });
  ctx.store.beginDispatch({
    id: leased.id, leaseToken: leased.leaseToken, renderedText: 'STILL_QUEUED', requestId: 'b-live',
  });
  ctx.store.markAmbiguous({ attemptId: ctx.store.listRecovery()[0].currentAttemptId, reason: 'unknown', requestId: 'amb-live' });
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

async function backupManifestIsHonestAboutMediaAndRestorability() {
  console.log('\n📋 XP-010.6 the backup manifest states what media it needs, and is honest about restorability');
  const ctx = freshStore('manifest-media');
  const src = path.join(SANDBOX, 'manifest-pic.png');
  fs.writeFileSync(src, Buffer.from('89504e470d0a1a0a' + 'aa'.repeat(64), 'hex'));
  ctx.store.enqueue({ items: [{ text: 'HAS_MEDIA', media_path: src }], requestId: 'e-mm1' });
  const leased = ctx.store.leaseNext({ profileId: ctx.profileId, runId: ctx.runId, leaseMs: 60_000 });
  const attempt = ctx.store.beginDispatch({
    id: leased.id, leaseToken: leased.leaseToken, renderedText: 'HAS_MEDIA', requestId: 'b-mm1',
  });
  ctx.store.markPublished({ attemptId: attempt.attemptId, externalUrl: 'https://x.com/i/web/status/mm1', evidence: {}, requestId: 'p-mm1' });

  const goodBackup = await ctx.store.backup({ keep: 3 });
  check('a backup whose media is intact declares itself restorable',
    goodBackup.restorable === true, JSON.stringify(goodBackup));
  check('and lists no missing or mismatched media', goodBackup.missingMedia.length === 0
    && goodBackup.mismatchedMedia.length === 0, JSON.stringify(goodBackup));

  const manifest = JSON.parse(fs.readFileSync(`${goodBackup.path}.json`, 'utf8'));
  check('the manifest states how many media blobs a full restore requires',
    manifest.mediaRequired === 1, JSON.stringify(manifest));
  check('the manifest itself carries the restorable verdict, not just the live return value',
    manifest.restorable === true, JSON.stringify(manifest));

  // Now delete the underlying blob file behind the store's back (simulating
  // disk loss unrelated to any workflow-level action) and take a second backup.
  const blob = ctx.store.db.prepare(`SELECT relative_path FROM media_blobs LIMIT 1`).get();
  fs.unlinkSync(path.join(ctx.root, 'media', blob.relative_path));

  const badBackup = await ctx.store.backup({ keep: 3, now: Date.now() + 1000 });
  check('a backup cannot declare restorable=true when required media is gone',
    badBackup.ok === true && badBackup.restorable === false, JSON.stringify(badBackup));
  check('it names exactly which blob is missing, typed, not just a boolean',
    badBackup.missingMedia.length === 1 && badBackup.missingMedia[0].sha256 === blob0Sha(ctx, blob),
    JSON.stringify(badBackup.missingMedia));

  const badManifest = JSON.parse(fs.readFileSync(`${badBackup.path}.json`, 'utf8'));
  check('the manifest on disk agrees — it never overclaims restorability',
    badManifest.restorable === false && badManifest.missingMedia.length === 1,
    JSON.stringify(badManifest));

  ctx.store.close();
}
function blob0Sha(ctx, blob) {
  return ctx.store.db.prepare(`SELECT sha256 FROM media_blobs WHERE relative_path = ?`).get(blob.relative_path).sha256;
}

async function restoreStagingTypedRefusesOnHashMismatch() {
  console.log('\n📋 XP-010.7 restore verification catches a media file that changed, not just one that vanished');
  const ctx = freshStore('restore-mismatch');
  const src = path.join(SANDBOX, 'mismatch-pic.png');
  fs.writeFileSync(src, Buffer.from('89504e470d0a1a0a' + 'bb'.repeat(64), 'hex'));
  ctx.store.enqueue({ items: [{ text: 'MISMATCH_MEDIA', media_path: src }], requestId: 'e-mis' });
  const leased = ctx.store.leaseNext({ profileId: ctx.profileId, runId: ctx.runId, leaseMs: 60_000 });
  const attempt = ctx.store.beginDispatch({
    id: leased.id, leaseToken: leased.leaseToken, renderedText: 'MISMATCH_MEDIA', requestId: 'b-mis',
  });
  ctx.store.markPublished({ attemptId: attempt.attemptId, externalUrl: 'https://x.com/i/web/status/mis', evidence: {}, requestId: 'p-mis' });
  const backup = await ctx.store.backup({ keep: 3 });
  check('backup taken while media is intact is restorable', backup.restorable === true, JSON.stringify(backup));

  // Bit rot: the file on disk no longer matches what the backup's DB recorded.
  const blob = ctx.store.db.prepare(`SELECT relative_path FROM media_blobs LIMIT 1`).get();
  fs.writeFileSync(path.join(ctx.root, 'media', blob.relative_path), 'CORRUPTED_BYTES');

  const verdict = ctx.store.verifyRestoreCandidate({ path: backup.path });
  check('verifyRestoreCandidate refuses restorable=true on a hash mismatch',
    verdict.restorable === false, JSON.stringify(verdict));
  check('it reports the mismatch as typed data, not a bare boolean',
    verdict.mismatchedMedia.length === 1, JSON.stringify(verdict.mismatchedMedia));
  check('quick_check on the backup file itself still passes — this is a media problem, not a DB problem',
    verdict.quickCheck === 'ok');

  // A restore-drill against a totally empty staging media directory must also
  // typed-refuse rather than silently proceeding as if nothing were missing.
  const emptyStagingDir = path.join(SANDBOX, 'empty-staging-media');
  fs.mkdirSync(emptyStagingDir, { recursive: true });
  const stagingVerdict = ctx.store.verifyRestoreCandidate({ path: backup.path, mediaDir: emptyStagingDir });
  check('restoring into a staging dir with no media at all is typed-refused, not assumed fine',
    stagingVerdict.restorable === false && stagingVerdict.missingMedia.length === 1,
    JSON.stringify(stagingVerdict));

  ctx.store.close();
}

async function sharedMediaSurvivesSingleRowRetention() {
  console.log('\n📋 XP-010.8 media shared by two posts is not deleted when only one is retained');
  const ctx = freshStore('shared-media');
  const src = path.join(SANDBOX, 'shared-pic.png');
  fs.writeFileSync(src, Buffer.from('89504e470d0a1a0a' + 'cc'.repeat(64), 'hex'));

  // Two DIFFERENT items, deliberately reusing the exact same file content —
  // _stageMedia dedups by hash, so both end up pointing at ONE media_blobs row.
  ctx.store.enqueue({ items: [{ text: 'SHARED_OLD', media_path: src }], requestId: 'e-sh1' });
  const l1 = ctx.store.leaseNext({ profileId: ctx.profileId, runId: ctx.runId, leaseMs: 60_000 });
  const a1 = ctx.store.beginDispatch({ id: l1.id, leaseToken: l1.leaseToken, renderedText: 'SHARED_OLD', requestId: 'b-sh1' });
  ctx.store.markPublished({ attemptId: a1.attemptId, externalUrl: 'https://x.com/i/web/status/sh1', evidence: {}, requestId: 'p-sh1' });

  ctx.store.enqueue({ items: [{ text: 'SHARED_NEW', media_path: src }], requestId: 'e-sh2' });
  const l2 = ctx.store.leaseNext({ profileId: ctx.profileId, runId: ctx.runId, leaseMs: 60_000 });
  const a2 = ctx.store.beginDispatch({ id: l2.id, leaseToken: l2.leaseToken, renderedText: 'SHARED_NEW', requestId: 'b-sh2' });
  ctx.store.markPublished({ attemptId: a2.attemptId, externalUrl: 'https://x.com/i/web/status/sh2', evidence: {}, requestId: 'p-sh2' });

  const blob = ctx.store.db.prepare('SELECT sha256, relative_path FROM media_blobs').get();
  check('both posts really do share one blob row (deduped by content hash)',
    ctx.store.db.prepare('SELECT COUNT(*) n FROM media_blobs').get().n === 1);
  check('two item_media links point at it', ctx.store.db.prepare(
    'SELECT COUNT(*) n FROM item_media WHERE blob_sha256 = ?').get(blob.sha256).n === 2);

  // Retire only the OLD post: backdate ITS updated_at_ms below the cutoff,
  // rather than moving retention's `now` into the future — SHARED_NEW's own
  // updated_at_ms is real "now" and must not be swept up by a wall-clock jump.
  const realNow = Date.now();
  ctx.store.db.prepare(`UPDATE workflow_items SET updated_at_ms = ? WHERE id = ?`).run(realNow - 200 * 86_400_000, l1.id);
  const result = ctx.store.applyRetention({ olderThanMs: 90 * 86_400_000, now: realNow });
  check('exactly the old, shared-media post was archived', result.archived === 1, JSON.stringify(result));

  check('the blob row is untouched — one reference remains', ctx.store.db.prepare(
    'SELECT COUNT(*) n FROM media_blobs WHERE sha256 = ?').get(blob.sha256).n === 1);
  check('the blob is still status=ready (still owed to the still-live post)', ctx.store.db.prepare(
    'SELECT status FROM media_blobs WHERE sha256 = ?').get(blob.sha256).status === 'ready');
  check('the file itself is still on disk, byte for byte',
    fs.existsSync(path.join(ctx.root, 'media', blob.relative_path)));

  // Reclaim must not touch it either — SHARED_NEW's link still exists.
  const reclaim = ctx.store.reclaimUnreferencedMedia({ graceMs: 0, now: realNow });
  check('reclaim does not reclaim media that is still referenced by the live post',
    reclaim.reclaimed.length === 0, JSON.stringify(reclaim));
  check('the file survives the reclaim pass too',
    fs.existsSync(path.join(ctx.root, 'media', blob.relative_path)));

  ctx.store.close();
}

async function onlyFullyUnreferencedMediaIsReclaimed() {
  console.log('\n📋 XP-010.9 media is only cleaned up once every reference to it is gone');
  const ctx = freshStore('reclaim');
  const src = path.join(SANDBOX, 'reclaim-pic.png');
  fs.writeFileSync(src, Buffer.from('89504e470d0a1a0a' + 'dd'.repeat(64), 'hex'));
  ctx.store.enqueue({ items: [{ text: 'RECLAIM_ME', media_path: src }], requestId: 'e-rec' });
  const leased = ctx.store.leaseNext({ profileId: ctx.profileId, runId: ctx.runId, leaseMs: 60_000 });
  const attempt = ctx.store.beginDispatch({
    id: leased.id, leaseToken: leased.leaseToken, renderedText: 'RECLAIM_ME', requestId: 'b-rec',
  });
  ctx.store.markPublished({ attemptId: attempt.attemptId, externalUrl: 'https://x.com/i/web/status/rec', evidence: {}, requestId: 'p-rec' });

  const blob = ctx.store.db.prepare('SELECT sha256, relative_path, byte_size FROM media_blobs LIMIT 1').get();
  const managedPath = path.join(ctx.root, 'media', blob.relative_path);
  check('the blob starts out ready with bytes on disk',
    ctx.store.db.prepare('SELECT status FROM media_blobs WHERE sha256 = ?').get(blob.sha256).status === 'ready'
    && fs.existsSync(managedPath));

  // Age the ITEM past the retention cutoff (backdate its row, not the clock),
  // so reclaim's own 1-hour grace period can be tested on its own terms
  // afterward, against a `now` that stays close to the blob's real
  // verified_at_ms rather than jumping 120 days ahead of it.
  const realNow = Date.now();
  ctx.store.db.prepare(`UPDATE workflow_items SET updated_at_ms = ? WHERE id = ?`).run(realNow - 100 * 86_400_000, leased.id);
  const soon = ctx.store.applyRetention({ olderThanMs: 90 * 86_400_000, now: realNow });
  check('retention archived the only post referencing this media', soon.archived === 1, JSON.stringify(soon));

  // Within the grace window, even a fully unreferenced blob must not be touched.
  const tooSoon = ctx.store.reclaimUnreferencedMedia({ graceMs: 3_600_000, now: realNow + 30 * 60 * 1000 });
  check('reclaim respects its own grace period even with zero references',
    tooSoon.reclaimed.length === 0, JSON.stringify(tooSoon));
  check('the file is still there during the grace window', fs.existsSync(managedPath));

  // Past the grace period, with zero item_media references, it is reclaimed.
  const pastGrace = realNow + 2 * 3_600_000;
  const reclaim = ctx.store.reclaimUnreferencedMedia({ graceMs: 3_600_000, now: pastGrace });
  check('the fully-dereferenced blob is reclaimed once past the grace window',
    reclaim.reclaimed.includes(blob.sha256), JSON.stringify(reclaim));
  check('its bytes are actually gone from disk', !fs.existsSync(managedPath));
  check('its row survives as a tombstone, not deleted (the schema forbids deleting media_blobs)',
    ctx.store.db.prepare('SELECT status FROM media_blobs WHERE sha256 = ?').get(blob.sha256).status === 'missing');

  // A now-reclaimed blob must not make the health gate refuse publishing.
  const healthy = storeHealth.evaluate(ctx.store, { now: pastGrace });
  check('a reclaimed (not corrupt) blob does not trip the health gate',
    healthy.ok === true, JSON.stringify(healthy.blocking));

  // Staging the exact same content again must revive it — not leave it stuck
  // 'missing' with a file that silently reappeared underneath the DB's back.
  const revived = ctx.store.enqueue({ items: [{ text: 'RECLAIM_ME_AGAIN', media_path: src }], requestId: 'e-rec2' });
  check('re-staging identical content revives the blob to ready',
    ctx.store.db.prepare('SELECT status FROM media_blobs WHERE sha256 = ?').get(blob.sha256).status === 'ready');
  check('and the bytes are really back on disk at the same content-addressed path',
    fs.existsSync(managedPath));
  check('the enqueue call itself succeeded rather than silently failing', Array.isArray(revived.items));

  ctx.store.close();
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
    await backupManifestIsHonestAboutMediaAndRestorability();
    await restoreStagingTypedRefusesOnHashMismatch();
    await sharedMediaSurvivesSingleRowRetention();
    await onlyFullyUnreferencedMediaIsReclaimed();
  } catch (error) {
    failed++;
    console.error('\n💥 scenario crashed:', error && error.stack ? error.stack : error);
  }

  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(`\n${failed === 0 ? '✅' : '❌'} XP-010: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
