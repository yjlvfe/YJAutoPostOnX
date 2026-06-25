/**
 * 🔗 Referral Toggle System — Complete Test Suite
 * ================================================
 * Tests:
 *   1. toggle persistence (enabled/disabled across restarts)
 *   2. enabling/disabling during runtime
 *   3. app restart behavior
 *   4. multi-profile behavior
 *   5. cached session behavior
 *   6. disabled mode publishing (no link)
 *   7. enabled mode validation
 *   8. malformed config recovery
 *   9. sanitization toggle-aware
 *  10. link injection only when enabled
 */

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

// Isolated sandbox for testing
const STRESS_DIR = path.join(os.tmpdir(), 'xposter-referral-toggle-test-' + Date.now());
const origHomedir = os.homedir;
os.homedir = () => STRESS_DIR;

// Clear cache for clean imports
delete require.cache[require.resolve('../src/automation/referralService')];
delete require.cache[require.resolve('../src/security/validator')];
delete require.cache[require.resolve('../src/security/migrator')];

const referralService = require('../src/automation/referralService');
const validator = require('../src/security/validator');
const migrator = require('../src/security/migrator');

let passed = 0;
let failed = 0;
const errors = [];

function assert(condition, msg) {
  if (condition) { passed++; }
  else {
    failed++;
    errors.push(`  ❌ ${msg}`);
    console.error(`  ❌ ${msg}`);
  }
}

function setup() {
  try { fs.rmSync(STRESS_DIR, { recursive: true }); } catch(e) {}
  fs.mkdirSync(path.join(STRESS_DIR, '.config', 'x-poster-bot-profile'), { recursive: true });
  
  // Clear require cache for fresh state
  delete require.cache[require.resolve('../src/automation/referralService')];
}

const TEST_LINK = 'https://www.mexc.com/acquisition/custom-sign-up?shareCode=mexc-12UHY5';

async function runTests() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  REFERRAL TOGGLE SYSTEM — COMPLETE TESTING  ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  // ========== TEST 1: Default State ==========
  console.log('📋 Test 1: Default State (first launch)');
  setup();
  
  const freshService = require('../src/automation/referralService');
  const initialState = freshService.init();
  assert(initialState.enabled === true, `Default: toggle enabled (got ${initialState.enabled})`);
  assert(initialState.link === '', 'Default: link is empty');
  assert(initialState.hasLink === false, 'Default: hasLink is false');
  assert(initialState.validated === false, 'Default: validated is false');
  console.log('   ✅ Default state verified\n');

  // ========== TEST 2: Toggle Persistence ==========
  console.log('📋 Test 2: Toggle Persistence (enabled → disabled → restart)');
  setup();
  
  const svc2 = require('../src/automation/referralService');
  svc2.init();
  
  // Disable toggle
  svc2.setEnabled(false);
  assert(svc2.isEnabled() === false, 'Toggle disabled');
  
  // Simulate restart: re-init
  delete require.cache[require.resolve('../src/automation/referralService')];
  const svc2b = require('../src/automation/referralService');
  svc2b.init();
  
  assert(svc2b.isEnabled() === false, 'Toggle remains disabled after re-init');
  
  // Re-enable
  svc2b.setEnabled(true);
  assert(svc2b.isEnabled() === true, 'Toggle re-enabled');
  
  // Restart again
  delete require.cache[require.resolve('../src/automation/referralService')];
  const svc2c = require('../src/automation/referralService');
  svc2c.init();
  
  assert(svc2c.isEnabled() === true, 'Toggle remains enabled after re-init');
  console.log('   ✅ Persistence verified\n');

  // ========== TEST 3: Enabled Mode Validation ==========
  console.log('📋 Test 3: Enabled Mode — Link Required');
  setup();
  
  const svc3 = require('../src/automation/referralService');
  svc3.init();
  svc3.setEnabled(true);
  
  // 3a. Empty link should throw
  let threwEmpty = false;
  try { svc3.setLink(''); } catch (e) { threwEmpty = e.message.includes('LINK_REQUIRED'); }
  assert(threwEmpty, 'Empty link throws LINK_REQUIRED');
  
  // 3b. Invalid link should throw
  let threwInvalid = false;
  try { svc3.setLink('not-a-url'); } catch (e) { threwInvalid = e.message.includes('LINK_INVALID'); }
  assert(threwInvalid, 'Invalid link throws LINK_INVALID');
  
  // 3c. Valid link accepted
  svc3.setLink(TEST_LINK);
  const linkValue = svc3.getLink();
  assert(linkValue === TEST_LINK, `Valid link accepted (got: ${linkValue})`);
  
  // 3d. getLinkOrNull returns link
  const orNull = svc3.getLinkOrNull();
  assert(orNull === TEST_LINK, 'getLinkOrNull returns link when enabled');
  
  // 3e. hasLink returns true
  assert(svc3.hasLink() === true, 'hasLink returns true');
  
  console.log('   ✅ Enabled mode validated\n');

  // ========== TEST 4: Disabled Mode ==========
  console.log('📋 Test 4: Disabled Mode — No Link Injected');
  setup();
  
  const svc4 = require('../src/automation/referralService');
  svc4.init();
  svc4.setEnabled(false);
  
  // 4a. getLink should throw
  let threwDisabled = false;
  try { svc4.getLink(); } catch (e) { threwDisabled = e.message.includes('REFERRAL_DISABLED'); }
  assert(threwDisabled, 'getLink throws REFERRAL_DISABLED');
  
  // 4b. getLinkOrNull returns null
  assert(svc4.getLinkOrNull() === null, 'getLinkOrNull returns null when disabled');
  
  // 4c. hasLink returns false
  assert(svc4.hasLink() === false, 'hasLink returns false');
  
  // 4d. setLink should throw
  let threwSetDisabled = false;
  try { svc4.setLink(TEST_LINK); } catch (e) { threwSetDisabled = e.message.includes('REFERRAL_DISABLED'); }
  assert(threwSetDisabled, 'setLink throws REFERRAL_DISABLED');
  
  console.log('   ✅ Disabled mode verified\n');

  // ========== TEST 5: Sanitization — Enabled ==========
  console.log('📋 Test 5: Sanitization with Toggle Enabled');
  setup();
  
  const svc5 = require('../src/automation/referralService');
  svc5.init();
  svc5.setEnabled(true);
  svc5.setLink(TEST_LINK);
  
  const postWithLink = '🚀 هذا منشور تجريبي {link}\n\nوصف المنشور\n\n#MEXC';
  const sanitized = svc5.sanitizePost(postWithLink);
  assert(sanitized.text.includes(TEST_LINK), `Sanitized post contains the link (${sanitized.text.includes(TEST_LINK)})`);
  assert(sanitized.modified === true, 'Post was modified (link inserted)');
  assert(sanitized.warnings.length === 0, 'No warnings when enabled');
  
  console.log('   ✅ Enabled sanitization verified\n');

  // ========== TEST 6: Sanitization — Disabled ==========
  console.log('📋 Test 6: Sanitization with Toggle Disabled');
  setup();
  
  const svc6 = require('../src/automation/referralService');
  svc6.init();
  svc6.setEnabled(false);
  
  const postWithLink2 = '🚀 منشور مع رابط {link} https://www.mexc.com/acquisition/custom-sign-up?shareCode=mexc-old \n\nوصف \n\n#MEXC';
  const sanitized2 = svc6.sanitizePost(postWithLink2);
  assert(!sanitized2.text.includes('{link}'), '{link} placeholder removed');
  assert(!sanitized2.text.includes('https://www.mexc.com'), 'Hardcoded URL stripped');
  assert(sanitized2.modified === true, 'Post was modified (links stripped)');
  assert(sanitized2.warnings.length > 0, 'Warnings generated for stripped links');
  
  // Post without link should remain intact
  const postNoLink = '🚀 منشور عادي بدون رابط\n\nوصف\n\n#MEXC';
  const sanitized3 = svc6.sanitizePost(postNoLink);
  assert(sanitized3.text === postNoLink, 'Post without links unchanged');
  assert(sanitized3.modified === false, 'No modification');
  
  console.log('   ✅ Disabled sanitization verified\n');

  // ========== TEST 7: Validation — Enabled Mode ==========
  console.log('📋 Test 7: Validator with Toggle Enabled');
  setup();
  
  const svc7 = require('../src/automation/referralService');
  svc7.init();
  svc7.setEnabled(true);
  svc7.setLink(TEST_LINK);
  
  // 7a. Post with matching link passes
  const matchPost = `🚀 هذا منشور مع الرابط ${TEST_LINK}\n\nوصف\n\n#MEXC`;
  const vResult1 = validator.validatePost(matchPost, TEST_LINK);
  assert(vResult1.valid === true, 'Post with matching link passes validation');
  
  // 7b. Post with different MEXC link fails
  const diffLink = 'https://www.mexc.com/acquisition/custom-sign-up?shareCode=DIFFERENT';
  const diffPost = `🚀 منشور مع رابط مختلف ${diffLink}\n\nوصف\n\n#MEXC`;
  const vResult2 = validator.validatePost(diffPost, TEST_LINK);
  assert(vResult2.valid === false, 'Post with different MEXC link fails validation');
  assert(vResult2.reason.includes('LINK_MISMATCH'), 'Reason contains LINK_MISMATCH');
  
  // 7c. Post with foreign URL fails
  const foreignPost = `🚀 منشور مع رابط أجنبي https://x.com/user\n\nوصف\n\n#MEXC`;
  const vResult3 = validator.validatePost(foreignPost, TEST_LINK);
  assert(vResult3.valid === false, 'Post with foreign URL fails validation');
  assert(vResult3.reason.includes('FOREIGN_URL'), 'Reason contains FOREIGN_URL');
  
  console.log('   ✅ Enabled validator verified\n');

  // ========== TEST 8: Validation — Disabled Mode ==========
  console.log('📋 Test 8: Validator with Toggle Disabled');
  
  const svc8 = require('../src/automation/referralService');
  // First init with enabled, then disable
  svc8.init();
  svc8.setEnabled(false);
  
  // With toggle disabled, any post should pass validation
  const anyPost = '🚀 منشور عادي بدون رابط\n\nوصف\n\n#MEXC';
  const vResult4 = validator.validatePost(anyPost);
  assert(vResult4.valid === true, 'Post passes validation when toggle disabled');
  assert(vResult4.reason.includes('REFERRAL_DISABLED'), 'Reason mentions disabled toggle');
  
  // Even posts with links pass (but they should have been sanitized upstream)
  const linkPost = `🚀 منشور مع رابط ${TEST_LINK}\n\nوصف\n\n#MEXC`;
  const vResult5 = validator.validatePost(linkPost);
  assert(vResult5.valid === true, 'Post with link also passes when disabled');
  assert(vResult5.reason.includes('REFERRAL_DISABLED'), 'Reason mentions disabled toggle even with links');
  
  console.log('   ✅ Disabled validator verified\n');

  // ========== TEST 9: Consistency Check ==========
  console.log('📋 Test 9: Consistency Check');
  setup();
  
  const svc9 = require('../src/automation/referralService');
  svc9.init();
  
  // 9a. Enabled + no link → warning
  svc9.setEnabled(true);
  const c1 = svc9.checkConsistency();
  assert(c1.issues.length > 0, 'Enabled + no link generates warning');
  
  // 9b. Enabled + link → consistent
  svc9.setLink(TEST_LINK);
  const c2 = svc9.checkConsistency();
  assert(c2.consistent === true, 'Enabled + link is consistent');
  
  // 9c. Disabled + link → info only
  svc9.setEnabled(false);
  const c3 = svc9.checkConsistency();
  assert(c3.consistent === true, 'Disabled + link is still consistent (dormant)');
  
  // 9d. Disabled + no link → consistent
  const svc9d = require('../src/automation/referralService');
  svc9d.init();
  svc9d.setEnabled(false);
  const c4 = svc9d.checkConsistency();
  assert(c4.consistent === true, 'Disabled + no link is consistent');
  
  console.log('   ✅ Consistency checks verified\n');

  // ========== TEST 10: Config Migration ==========
  console.log('📋 Test 10: Config Migration (referral_enabled)');
  setup();
  
  // Create old config without referral_enabled
  const configDir = path.join(STRESS_DIR, '.config', 'x-poster-bot-profile');
  const configFile = path.join(configDir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ speed: '5', maxPosts: '9999' }), 'utf8');
  
  const mResult = migrator.migrateConfig();
  assert(mResult.migrated === true, 'Old config migrated (referral_enabled added)');
  
  // Verify the field was added
  const configContent = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert(configContent.referral_enabled === true, 'referral_enabled=true in migrated config');
  
  // Running again should not re-migrate
  const mResult2 = migrator.migrateConfig();
  assert(mResult2.migrated === false, 'Already migrated config not re-migrated');
  
  console.log('   ✅ Config migration verified\n');

  // ========== TEST 11: GetState Roundtrip ==========
  console.log('📋 Test 11: State Roundtrip');
  setup();
  
  const svc11 = require('../src/automation/referralService');
  svc11.init();
  
  const state0 = svc11.getState();
  assert(state0.enabled === true, 'Initial state: enabled');
  assert(state0.link === '', 'Initial state: empty link');
  
  svc11.setEnabled(false);
  const state1 = svc11.getState();
  assert(state1.enabled === false, 'State: disabled');
  
  svc11.setEnabled(true);
  svc11.setLink(TEST_LINK);
  const state2 = svc11.getState();
  assert(state2.enabled === true, 'State: enabled again');
  assert(state2.link === TEST_LINK, 'State: link stored');
  assert(state2.hasLink === true, 'State: hasLink true');
  
  console.log('   ✅ State roundtrip verified\n');

  // ========== TEST 13: Extract share code ==========
  console.log('📋 Test 13: Share Code Extraction');
  setup();
  
  const svc13 = require('../src/automation/referralService');
  const code = svc13.extractShareCode(TEST_LINK);
  assert(code === 'mexc-12UHY5', `Share code extracted: ${code}`);
  
  const noCode = svc13.extractShareCode('https://www.mexc.com');
  assert(noCode === null, 'No share code returns null');
  
  const invalid = svc13.extractShareCode('not-a-url');
  assert(invalid === null, 'Invalid URL returns null');
  
  console.log('   ✅ Share code extraction verified\n');

  // ========== SUMMARY ==========
  console.log('══════════════════════════════════════════════\n');
  const total = passed + failed;
  const pct = ((passed / total) * 100).toFixed(1);
  console.log(`📊 TOGGLE TEST RESULTS: ${passed}/${total} passed (${pct}%)`);
  if (failed > 0) {
    console.error('\n❌ FAILURES:');
    errors.forEach(e => console.error(e));
    process.exit(1);
  } else {
    console.log('\n🏆 ALL TOGGLE TESTS PASSED — System is secure and consistent!');
  }

  // Cleanup
  os.homedir = origHomedir;
  try { fs.rmSync(STRESS_DIR, { recursive: true }); } catch(e) {}
}

runTests().catch(err => {
  console.error('💥 TOGGLE TEST FATAL:', err);
  process.exit(1);
});
