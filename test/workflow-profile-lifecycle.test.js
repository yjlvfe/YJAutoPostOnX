'use strict';

/**
 * XP-004 — rename/delete detached a profile's identity and did not stop it
 * publishing.
 *
 * The IPC handlers renamed a directory and migrated a cooldown. They never
 * touched the durable store, and `resolveProfileId()` maps name → row, so:
 *
 *   - after a rename the next run minted a NEW uuid and left the old row
 *     active: two live identities for one profile, and every published/recovery
 *     record still pointing at the abandoned one;
 *   - after a delete the durable profile stayed `active`, so `beginDispatch`
 *     happily returned ok — a deleted profile could still publish.
 *
 * These drive dev/automation/profileLifecycle.js, which is the code the IPC
 * handlers call — not a reimplementation of it.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = path.join(os.tmpdir(), 'xposter-profile-life-' + Date.now());
os.homedir = () => SANDBOX;
fs.mkdirSync(path.join(SANDBOX, '.config', 'x-poster-bot-profile'), { recursive: true });
fs.mkdirSync(path.join(SANDBOX, '.config', 'x-poster-profiles', '2- alpha'), { recursive: true });
fs.mkdirSync(path.join(SANDBOX, '.config', 'x-poster-profiles', '3- beta'), { recursive: true });

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
}

const durableQueue = require('../dev/automation/durableQueue');
const profileLifecycle = require('../dev/automation/profileLifecycle');
const { DurableSession } = require('../dev/automation/durableSession');

const profilesDir = path.join(SANDBOX, '.config', 'x-poster-profiles');

async function activeRows() {
  const store = await durableQueue.getStore();
  return store.db.prepare("SELECT id, name, status FROM profiles WHERE status = 'active'").all();
}

// ── XP-004.1 — rename keeps the UUID ────────────────────────────────────────
async function renameKeepsTheUuid() {
  console.log('\n📋 XP-004.1 rename preserves identity');

  const before = await durableQueue.resolveProfileId('2- alpha');
  const activeBefore = (await activeRows()).length;

  const res = await profileLifecycle.renameProfile('2- alpha', 'alpha-renamed');
  check('rename succeeds', res.success === true, JSON.stringify(res));
  check('the new name keeps the sequence number',
    res.profile && res.profile.name === '2- alpha-renamed', JSON.stringify(res.profile));

  const after = await durableQueue.resolveProfileId('2- alpha-renamed');
  check('the UUID is unchanged across the rename', after === before,
    `before=${before} after=${after}`);

  const rows = await activeRows();
  check('renaming did not create a second active profile', rows.length === activeBefore,
    `active=${JSON.stringify(rows.map(r => r.name))}`);
  check('no active row still carries the old name',
    !rows.some(r => r.name === '2- alpha'), JSON.stringify(rows.map(r => r.name)));

  check('the directory moved with it',
    fs.existsSync(path.join(profilesDir, '2- alpha-renamed'))
    && !fs.existsSync(path.join(profilesDir, '2- alpha')));
}

// ── XP-004.2 — history stays attached to the renamed profile ────────────────
async function historyFollowsTheRename() {
  console.log('\n📋 XP-004.2 published history survives a rename');

  const store = await durableQueue.getStore();
  const profileId = await durableQueue.resolveProfileId('3- beta');
  await durableQueue.addPosts(['BETA_POST']);

  const run = store.startRun({ requestId: 'r-beta' });
  const session = new DurableSession({ store, profileId, runId: run.id, profileName: '3- beta' });
  session.claimNext({ leaseMs: 60_000 });
  const dispatch = session.beginDispatch('BETA_POST');
  check('the item dispatched before the rename', dispatch.ok === true, `code=${dispatch.code}`);
  session.markPublished({ externalUrl: 'https://x.com/i/web/status/beta1' });
  store.finishRun({ runId: run.id, status: 'closed', requestId: 'f-beta' });

  const res = await profileLifecycle.renameProfile('3- beta', 'beta-renamed');
  check('rename succeeds', res.success === true, JSON.stringify(res));

  const publishedRows = store.db
    .prepare("SELECT profile_id FROM dispatch_attempts WHERE rendered_text = 'BETA_POST'")
    .all();
  check('the published attempt still points at the same profile UUID',
    publishedRows.length > 0 && publishedRows.every(r => r.profile_id === profileId),
    `rows=${JSON.stringify(publishedRows)} expected=${profileId}`);

  const resolvedAfter = await durableQueue.resolveProfileId('3- beta-renamed');
  check('the renamed profile resolves to that same UUID', resolvedAfter === profileId,
    `resolved=${resolvedAfter} expected=${profileId}`);
}

// ── XP-004.3 — a deleted profile cannot publish ─────────────────────────────
async function deletedProfileCannotPublish() {
  console.log('\n📋 XP-004.3 delete stops publishing');

  fs.mkdirSync(path.join(profilesDir, '4- gamma'), { recursive: true });
  const store = await durableQueue.getStore();
  const profileId = await durableQueue.resolveProfileId('4- gamma');
  await durableQueue.addPosts(['GAMMA_POST']);

  // Claim BEFORE the delete, exactly as a live run would be holding it.
  const run = store.startRun({ requestId: 'r-gamma' });
  const session = new DurableSession({ store, profileId, runId: run.id, profileName: '4- gamma' });
  const claim = session.claimNext({ leaseMs: 60_000 });
  check('the run holds a claim', !!claim);

  const res = await profileLifecycle.deleteProfile('4- gamma');
  check('delete succeeds', res.success === true, JSON.stringify(res));
  check('the durable profile was retired, not just the directory',
    res.durablyDeleted === true, JSON.stringify(res));

  const row = store.db.prepare('SELECT status FROM profiles WHERE id = ?').get(profileId);
  check('the durable profile is no longer active', row && row.status === 'deleted',
    `status=${row && row.status}`);

  // THE POINT: the boundary must refuse.
  const dispatch = session.beginDispatch('GAMMA_POST');
  check('beginDispatch refuses for a deleted profile', dispatch.ok === false,
    `dispatch=${JSON.stringify(dispatch && dispatch.code)}`);
  check('it refuses with PROFILE_NOT_ACTIVE specifically',
    dispatch.code === 'PROFILE_NOT_ACTIVE', `code=${dispatch.code}`);

  check('the directory is gone', !fs.existsSync(path.join(profilesDir, '4- gamma')));
}

// ── XP-004.4 — delete preserves published evidence ──────────────────────────
async function deleteKeepsPublishedEvidence() {
  console.log('\n📋 XP-004.4 delete never erases published evidence');
  const store = await durableQueue.getStore();
  const rows = store.db
    .prepare("SELECT COUNT(*) AS n FROM dispatch_attempts WHERE rendered_text = 'BETA_POST'")
    .get();
  check('the earlier published attempt is still on record', rows.n > 0, `n=${rows.n}`);
}

// ── XP-004.5 — hostile names ────────────────────────────────────────────────
async function hostileNamesAreRejected() {
  console.log('\n📋 XP-004.5 duplicate / case / traversal names');

  fs.mkdirSync(path.join(profilesDir, '5- delta'), { recursive: true });
  fs.mkdirSync(path.join(profilesDir, '6- epsilon'), { recursive: true });
  await durableQueue.resolveProfileId('5- delta');
  await durableQueue.resolveProfileId('6- epsilon');

  const dup = await profileLifecycle.renameProfile('6- epsilon', 'delta');
  check('a duplicate label is refused', dup.success === false && dup.code === 'NAME_EXISTS',
    JSON.stringify(dup));

  const caseDup = await profileLifecycle.renameProfile('6- epsilon', 'DELTA');
  check('a case-only duplicate is refused too',
    caseDup.success === false && caseDup.code === 'NAME_EXISTS', JSON.stringify(caseDup));

  const traversal = await profileLifecycle.renameProfile('6- epsilon', '../../escape');
  check('path traversal cannot escape the profiles directory',
    traversal.success === false
    || !String(traversal.profile && traversal.profile.name).includes('..'),
    JSON.stringify(traversal));
  check('nothing was created outside the profiles directory',
    !fs.existsSync(path.join(SANDBOX, '.config', 'escape'))
    && !fs.existsSync(path.join(SANDBOX, 'escape')));

  const empty = await profileLifecycle.renameProfile('6- epsilon', '   ');
  check('an empty label is refused', empty.success === false && empty.code === 'INVALID_NAME',
    JSON.stringify(empty));

  const def = await profileLifecycle.deleteProfile('Default');
  check('the default profile cannot be deleted', def.success === false, JSON.stringify(def));
}

(async () => {
  console.log('=== XP-004: profile identity across rename/delete ===');
  try {
    await renameKeepsTheUuid();
    await historyFollowsTheRename();
    await deletedProfileCannotPublish();
    await deleteKeepsPublishedEvidence();
    await hostileNamesAreRejected();
  } catch (error) {
    failed++;
    console.error('\n❌ suite threw:', error && error.stack ? error.stack : error);
  }
  try { await durableQueue.closeStore(); } catch { /* best effort */ }
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(`\n${failed === 0 ? '✅' : '❌'} workflow-profile-lifecycle: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
