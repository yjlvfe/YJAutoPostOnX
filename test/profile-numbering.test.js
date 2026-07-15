/**
 * profile-numbering.test.js
 * =========================
 * Covers the v5.7.0 behaviour:
 *   1. isLimitUrl — the daily-post-limit redirect URL must be treated as a
 *      rate limit, never as a successful post URL.
 *   2. profileRegistry — mandatory numbering, ordering (Default = #1),
 *      next-number allocation, legacy-profile migration.
 *   3. queueManager — cursor rename/remove survive profile rename/delete.
 *   4. "Start from selected profile" slice — no wrap-around to earlier ones.
 *
 * Runs against an ISOLATED HOME so it never touches real user state.
 */

'use strict';

const path = require('path');
const os = require('os');
const fsSync = require('fs');

// Isolate HOME BEFORE requiring any module that resolves ~/.config paths.
const FAKE_HOME = fsSync.mkdtempSync(path.join(os.tmpdir(), 'xposter-numbering-'));
process.env.HOME = FAKE_HOME;

const fs = require('fs').promises;
const { isLimitUrl } = require('../dev/automation/xPoster');
const registry = require('../dev/automation/profileRegistry');
const queueManager = require('../dev/automation/queueManager');
const rateLimitStore = require('../dev/automation/rateLimitStore');

let failures = 0;
function check(label, cond) {
  if (cond) console.log(`✅ ${label}`);
  else { console.error(`❌ ${label}`); failures++; }
}

async function main() {
  // ── 1. Daily-limit URL detection ──────────────────────────────────────────
  check('limit URL (screenshot case) detected',
    isLimitUrl('https://x.com/i/premium_sign_up?referring_page=daily_post_limit'));
  check('bare premium_sign_up detected', isLimitUrl('/i/premium_sign_up'));
  check('real status URL NOT flagged',
    !isLimitUrl('https://x.com/user/status/1234567890123456789'));
  check('null/empty URL NOT flagged', !isLimitUrl(null) && !isLimitUrl(''));

  // ── 2. Numbering + ordering ───────────────────────────────────────────────
  check('Default is always #1', registry.profileNumber('Default') === 1);
  check('numbered name parsed', registry.profileNumber('7- علي') === 7);
  check('un-numbered legacy name → null', registry.profileNumber('محمد') === null);
  check('label extraction strips number', registry.stripLeadingNumber('12-  محمد') === 'محمد');

  const sorted = registry.sortProfilesByNumber(['3- علي', 'Default', '2- محمد', '10- سعد']);
  check('sort: Default first, numeric (not lexicographic) order',
    JSON.stringify(sorted) === JSON.stringify(['Default', '2- محمد', '3- علي', '10- سعد']));

  // ── 3. Ordered listing + next number from disk ────────────────────────────
  const dir = registry.profilesDir();
  await fs.mkdir(path.join(dir, 'Default'), { recursive: true });
  await fs.mkdir(path.join(dir, '2- محمد'), { recursive: true });
  await fs.mkdir(path.join(dir, '3- علي'), { recursive: true });

  const ordered = await registry.listProfilesOrdered();
  check('listProfilesOrdered returns Default, 2-, 3-',
    JSON.stringify(ordered) === JSON.stringify(['Default', '2- محمد', '3- علي']));
  check('nextProfileNumber allocates 4', (await registry.nextProfileNumber()) === 4);

  // "Start from selected" slice — selecting "2- محمد" runs it + everything
  // AFTER it only; the last profile ends the run (no wrap to Default).
  const idx = ordered.indexOf('2- محمد');
  const runList = ordered.slice(idx);
  check('run list starts at the SELECTED profile, no wrap-around',
    JSON.stringify(runList) === JSON.stringify(['2- محمد', '3- علي']));

  // ── 4. Legacy migration carries cursor + cooldown ─────────────────────────
  await fs.mkdir(path.join(dir, 'قديم'), { recursive: true });
  await queueManager.addPosts(['a', 'b', 'c']);
  await queueManager.advancePosition('قديم', 2);
  rateLimitStore.setCooldown('قديم', 60 * 1000);

  await registry.migrateUnnumberedProfiles();
  const after = await registry.listProfilesOrdered();
  check('legacy profile got number 4', after.includes('4- قديم') && !after.includes('قديم'));
  check('queue cursor survived migration',
    (await queueManager.getProfilePosition('4- قديم')) === 2);
  check('cooldown survived migration', rateLimitStore.getCooldown('4- قديم') !== null);
  check('old cooldown key gone', rateLimitStore.getCooldown('قديم') === null);

  // ── 5. Cursor rename/remove helpers ───────────────────────────────────────
  await queueManager.renameProfilePosition('4- قديم', '4- جديد');
  check('renameProfilePosition moved the cursor',
    (await queueManager.getProfilePosition('4- جديد')) === 2 &&
    (await queueManager.getProfilePosition('4- قديم')) === 0);
  await queueManager.removeProfilePosition('4- جديد');
  check('removeProfilePosition dropped the cursor',
    (await queueManager.getProfilePosition('4- جديد')) === 0);

  if (failures) {
    console.error(`\n❌ profile-numbering.test.js: ${failures} FAILED`);
    process.exit(1);
  }
  console.log('\n✅ profile-numbering.test.js: ALL passed');
}

main().catch(e => { console.error('❌ test crashed:', e); process.exit(1); });
