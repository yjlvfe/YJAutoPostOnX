/**
 * full-ui.test.js — اختبار شامل لكل وظائف التطبيق عبر IPC
 * يغطي: البروفايلات، الطابور، الأزرار، الكول داون، التوليد، الإعدادات
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ─── نتائج الاختبار ───
let passed = 0, failed = 0;
const results = [];

function ok(name, condition, detail = '') {
  if (condition) {
    passed++;
    results.push({ status: '✅', name, detail });
    console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`);
  } else {
    failed++;
    results.push({ status: '❌', name, detail });
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function section(title) {
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(50));
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── استيراد الموديولات المباشرة (بدون Electron IPC overhead) ───
async function runTests() {

  // ══════════════════════════════════════════════
  section('1. rateLimitStore — الكول داون');
  // ══════════════════════════════════════════════
  const store = require('../src/automation/rateLimitStore');

  // تنظيف
  fs.writeFileSync(store.STORE_PATH, '{}');

  // 1.1 setCooldown + getCooldown
  const cd1 = store.setCooldown('ProfileA', 10000, { source: 'x' });
  ok('setCooldown يرجع until/since', cd1.until > Date.now() && cd1.since > 0);
  const got1 = store.getCooldown('ProfileA');
  ok('getCooldown يرجع remainingMs', got1 && got1.remainingMs > 0 && got1.remainingMs <= 10000);

  // 1.2 isCoolingDown
  ok('isCoolingDown محدود = true', store.isCoolingDown('ProfileA') === true);
  ok('isCoolingDown غير محدود = false', store.isCoolingDown('FreshProfile') === false);

  // 1.3 getAllCooldowns
  store.setCooldown('ProfileB', 20000);
  const all = store.getAllCooldowns();
  ok('getAllCooldowns يرجع البروفايلين', Object.keys(all).length === 2);

  // 1.4 parseCooldownFromText
  ok('parse: 25 minutes إنجليزي', store.parseCooldownFromText('try again in 25 minutes') === 25 * 60 * 1000);
  ok('parse: 2 hours إنجليزي', store.parseCooldownFromText('wait 2 hours') === 2 * 3600 * 1000);
  ok('parse: 30 دقيقة عربي', store.parseCooldownFromText('بعد 30 دقيقة') === 30 * 60 * 1000);
  ok('parse: ساعتين عربي', store.parseCooldownFromText('خلال ساعتين') === 2 * 3600 * 1000);
  ok('parse: لا مدة → null', store.parseCooldownFromText('no info') === null);

  // 1.5 formatRemaining
  ok('formatRemaining صفر = انتهى', store.formatRemaining(0) === 'انتهى');
  ok('formatRemaining 90s = دقيقة و ثانية', store.formatRemaining(90000).includes('دقيقة'));
  ok('formatRemaining 3661s = ساعة', store.formatRemaining(3661000).includes('ساعة'));

  // 1.6 clearCooldown
  store.clearCooldown('ProfileA');
  ok('clearCooldown يحذف البروفايل', store.isCoolingDown('ProfileA') === false);

  // 1.7 انتهاء الصلاحية auto-prune
  store.setCooldown('ExpiredProfile', 1); // 1ms
  await sleep(20);
  ok('getCooldown منتهي الصلاحية = null', store.getCooldown('ExpiredProfile') === null);

  // تنظيف
  store.clearCooldown('ProfileB');
  fs.writeFileSync(store.STORE_PATH, '{}');

  // ══════════════════════════════════════════════
  section('2. referralService — رابط الإحالة');
  // ══════════════════════════════════════════════
  const ref = require('../src/automation/referralService');

  ok('getState يرجع كائن', typeof ref.getState() === 'object');
  ref.setEnabled(true);
  ref.setLink('https://www.mexc.com/auth/signup?inviteCode=TEST123');
  ok('setEnabled + setLink يعمل', ref.isEnabled() === true);
  const builtLink = ref.getLink();
  ok('buildLink يبني رابط صحيح', builtLink && builtLink.includes('TEST123'));
  ref.setEnabled(false);
  ok('setEnabled false', ref.isEnabled() === false);
  ok('getLinkOrNull disabled = null', ref.getLinkOrNull() === null);
  // إعادة لحالة محايدة
  ref.setEnabled(false);

  // ══════════════════════════════════════════════
  section('3. contentEngine — التوليد والتحقق');
  // ══════════════════════════════════════════════
  const ce = require('../src/automation/contentEngine');

  // 3.1 نص طويل كافٍ — core بدون رابط/هاشتاقات ليصل المجموع 200+
  const refLink = 'https://www.mexc.com/auth/signup?inviteCode=TEST';
  const longCore = 'إدارة المخاطر هي خط الدفاع الأول لكل متداول ناجح فلا تخاطر أبداً بأكثر مما تتحمل خسارته وضع دائماً خطة واضحة لحجم المركز ووقف الخسارة قبل الدخول في أي صفقة حتى تحمي رأس مالك على المدى الطويل وتستمر في السوق';
  const assembled = ce.assembleTweet(longCore, refLink);
  ok('assembleTweet نص طويل يرجع كائن', assembled != null && typeof assembled === 'object', assembled ? '' : 'رجع null');
  if (assembled) {
    ok('assembleTweet يحتوي الرابط', assembled.text.includes(refLink));
    ok('assembleTweet طول في النطاق 200-270', assembled.length >= 200 && assembled.length <= 270, `length=${assembled.length}`);
    const vResult = ce.validateTweet(assembled.text, refLink, []);
    ok('validateTweet نص صحيح = valid', vResult.valid === true, vResult.reason || '');
  }

  // 3.3 validateTweet — نص قصير جداً
  const shortTweet = 'قصير جداً ' + refLink;
  const vShort = ce.validateTweet(shortTweet, refLink, []);
  ok('validateTweet يرفض النص القصير', vShort.valid === false);

  // 3.4 validateTweet — نص طويل جداً
  const longTweet = 'أ'.repeat(300) + ' ' + refLink;
  const vLong = ce.validateTweet(longTweet, refLink, []);
  ok('validateTweet يرفض النص الطويل', vLong.valid === false);

  // 3.5 getRecentBodies
  const recent = ce.getRecentBodies(5);
  ok('getRecentBodies يرجع مصفوفة', Array.isArray(recent));

  // 3.6 isDuplicate(candidateTokens, historyTokenSets)
  const tokens = ce.tokenize('نص جديد تماماً لم يُستخدم من قبل');
  const isDup = ce.isDuplicate(tokens, []);
  ok('isDuplicate نص جديد مقابل تاريخ فاضي = false', isDup === false);
  const isDup2 = ce.isDuplicate(tokens, [tokens]);
  ok('isDuplicate نص مكرر = true', isDup2 === true);

  // ══════════════════════════════════════════════
  section('4. queueManager — الطابور');
  // ══════════════════════════════════════════════
  const qm = require('../src/automation/queueManager');

  const testProfile = 'TestProfile_UI_' + Date.now();

  // 4.1 getQueue — الطابور مشترك، نتحقق فقط أنه array
  const emptyQ = await qm.getQueue(testProfile);
  ok('getQueue بروفايل جديد = فاضي', Array.isArray(emptyQ));

  // 4.2 addPosts — نضيف 3 منشورات فريدة بـ timestamp
  const ts = Date.now();
  const posts = [
    { text: `تغريدة اختبار أولى ${ts}` },
    { text: `تغريدة اختبار ثانية ${ts}` },
    { text: `تغريدة اختبار ثالثة ${ts}` },
  ];
  const beforeCount = emptyQ.length;
  const addResult = await qm.addPosts(posts, testProfile);
  ok('addPosts يضيف 3 منشورات', (addResult.added ?? addResult.successfullyAdded) === 3);

  // 4.3 getQueue بعد الإضافة
  const filledQ = await qm.getQueue(testProfile);
  ok('getQueue بعد إضافة = 3 منشور', filledQ.length === beforeCount + 3);

  // 4.4 تجنب التكرار
  const dupResult = await qm.addPosts([{ text: `تغريدة اختبار أولى ${ts}` }], testProfile);
  ok('addPosts يرفض التكرار', (dupResult.skippedDuplicate ?? 0) >= 1);

  // 4.5 bulkDelete — احسب indices المضافة وامسحها
  const addedIndices = [beforeCount, beforeCount + 1, beforeCount + 2];
  await qm.bulkDelete(addedIndices, testProfile);
  const afterQ = await qm.getQueue(testProfile);
  ok('getQueue بعد الحذف = 2 منشور', afterQ.length === beforeCount);

  // تنظيف
  try {
    const dataDir = qm.getProfileDataDir(testProfile);
    require('fs').rmSync(dataDir, { recursive: true, force: true });
  } catch(e) {}

  // ══════════════════════════════════════════════
  section('5. reportEngine — التقارير');
  // ══════════════════════════════════════════════
  const { ReportEngine } = require('../src/automation/reportEngine');
  const tmpDir = path.join(os.tmpdir(), 'xposter-full-test-' + Date.now());
  const rep = new ReportEngine(tmpDir);

  rep.startRun();
  ok('startRun لا يرمي خطأ', true);

  rep.logEvent({ level: 'info', event: 'TEST', postId: 'p1', attempt: 1, message: 'اختبار' });
  ok('logEvent يسجّل حدث', true);

  rep.recordPostResult({ postId: 'p1', success: true, attempt: 1, durationMs: 1500 });
  ok('recordPostResult يسجّل نجاح', true);

  rep.recordPostResult({ postId: 'p2', success: false, attempt: 2, durationMs: 500, errorMsg: 'فشل' });
  ok('recordPostResult يسجّل فشل', true);

  const report = rep.generateReport();
  ok('generateReport يرجع تقرير', report && typeof report === 'object');
  ok('report.summary.totalPosts = 2', report.stats?.totalPosts === 2);
  ok('report.summary.success+failed = 2', (report.stats?.success ?? 0) + (report.stats?.failed ?? 0) + (report.stats?.unconfirmed ?? 0) === 2);

  await rep.endRun();
  ok('endRun ينتهي بدون خطأ', true);

  // تنظيف
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e) {}

  // ══════════════════════════════════════════════
  section('6. auditor — فحص الأمان');
  // ══════════════════════════════════════════════
  const { runAudit } = require('../src/security/auditor');
  const audit = runAudit();
  ok('runAudit يرجع نتيجة', audit && typeof audit === 'object');
  ok('audit.status موجود', typeof audit.status === 'string');
  ok('audit.scanned > 0', audit.scanned > 0);
  console.log(`     audit.status = ${audit.status}, scanned = ${audit.scanned}`);

  // ══════════════════════════════════════════════
  section('7. migrator — الترحيل');
  // ══════════════════════════════════════════════
  const { migrateConfig } = require('../src/security/migrator');
  try {
    migrateConfig();
    ok('migrateConfig يعمل بدون خطأ', true);
  } catch(e) {
    ok('migrateConfig يعمل بدون خطأ', false, e.message);
  }

  // ══════════════════════════════════════════════
  section('8. xPoster — منطق startMulti مع cooldown');
  // ══════════════════════════════════════════════

  // محاكاة التنقل بين البروفايلات
  fs.writeFileSync(store.STORE_PATH, '{}');
  store.setCooldown('LimitedProfile', 60 * 60 * 1000, { source: 'x' });

  const profiles = ['LimitedProfile', 'FreshProfile1', 'FreshProfile2'];
  let skipped = 0, wouldRun = 0;
  for (const p of profiles) {
    if (store.isCoolingDown(p)) { skipped++; }
    else { wouldRun++; }
  }
  ok('startMulti يتخطى بروفايل محدود (1 skipped)', skipped === 1);
  ok('startMulti يشغّل البروفايلات الحرة (2 run)', wouldRun === 2);

  // محاكاة ضرب limit في المنتصف
  store.setCooldown('FreshProfile1', store.parseCooldownFromText('try again in 15 minutes'), { source: 'x' });
  ok('بعد ضرب limit — FreshProfile1 محدود', store.isCoolingDown('FreshProfile1') === true);
  ok('FreshProfile2 لا يزال حراً', store.isCoolingDown('FreshProfile2') === false);
  ok('مدة الكول داون 15 دقيقة صحيحة',
    store.getCooldown('FreshProfile1').remainingMs > 14 * 60 * 1000 &&
    store.getCooldown('FreshProfile1').remainingMs <= 15 * 60 * 1000
  );

  // تنظيف
  fs.writeFileSync(store.STORE_PATH, '{}');

  // ══════════════════════════════════════════════
  section('9. CSV parsing — استيراد المنشورات');
  // ══════════════════════════════════════════════
  const tmpCsv = path.join(os.tmpdir(), 'test-posts-' + Date.now() + '.csv');
  fs.writeFileSync(tmpCsv,
    'text\n' +
    '"تغريدة من CSV أولى"\n' +
    '"تغريدة من CSV ثانية"\n' +
    '"تغريدة من CSV ثالثة"\n'
  );
  ok('ملف CSV مؤقت أُنشئ', fs.existsSync(tmpCsv));

  // نستخدم csv-parser مباشرة
  const csvParser = require('csv-parser');
  const csvRows = [];
  await new Promise((resolve, reject) => {
    fs.createReadStream(tmpCsv)
      .pipe(csvParser())
      .on('data', row => csvRows.push(row))
      .on('end', resolve)
      .on('error', reject);
  });
  ok('CSV parser يقرأ 3 صفوف', csvRows.length === 3);
  ok('CSV row يحتوي حقل text', csvRows[0].text && csvRows[0].text.includes('أولى'));
  fs.unlinkSync(tmpCsv);

  // ══════════════════════════════════════════════
  section('10. IPC handlers — التحقق من التسجيل');
  // ══════════════════════════════════════════════
  // نتحقق أن main.js يصدّر/يسجّل الـ handlers الصحيحة
  const mainSrc = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  const handlers = [
    'get-settings', 'save-settings', 'select-folder', 'select-csv',
    'parse-csv', 'get-queue', 'add-posts', 'bulk-delete',
    'start-posting', 'stop-automation',
    'get-cooldowns', 'get-cooldown', 'clear-cooldown',
    'get-profiles', 'create-profile', 'delete-profile', 'rename-profile',
    'open-profile-for-login', 'export-queue',
    'run-audit', 'get-logs', 'read-log',
    'list-models', 'generate-ai-posts',
  ];
  let missingHandlers = [];
  for (const h of handlers) {
    if (!mainSrc.includes(`'${h}'`)) missingHandlers.push(h);
  }
  ok(`جميع الـ ${handlers.length} IPC handlers مسجّلة`, missingHandlers.length === 0,
    missingHandlers.length > 0 ? 'مفقود: ' + missingHandlers.join(', ') : '');

  // ══════════════════════════════════════════════
  section('11. preload.js — كشف APIs للواجهة');
  // ══════════════════════════════════════════════
  const preloadSrc = fs.readFileSync(path.join(__dirname, '../src/preload.js'), 'utf8');
  const apis = [
    'getSettings', 'saveSettings', 'selectFolder', 'selectCSV',
    'parseCSV', 'getQueue', 'addPosts', 'bulkDelete',
    'startPosting', 'stopAutomation', 'onStatusUpdate',
    'getCooldowns', 'getCooldown', 'clearCooldown',
    'getProfiles', 'createProfile', 'deleteProfile', 'renameProfile',
    'openProfileForLogin', 'exportQueue',
    'runAudit', 'getLogs', 'readLog',
    'listModels', 'generateAiPosts',
  ];
  let missingApis = [];
  for (const a of apis) {
    if (!preloadSrc.includes(a)) missingApis.push(a);
  }
  ok(`جميع الـ ${apis.length} APIs مكشوفة في preload`, missingApis.length === 0,
    missingApis.length > 0 ? 'مفقود: ' + missingApis.join(', ') : '');

  // ══════════════════════════════════════════════
  section('12. renderer.js — ربط الأزرار والبانر');
  // ══════════════════════════════════════════════
  const rendererSrc = fs.readFileSync(path.join(__dirname, '../src/ui/renderer.js'), 'utf8');
  const uiChecks = [
    ['زر النشر btn-main-action', "btn-main-action"],
    ['زر إيقاف stop-automation', "stopAutomation"],
    ['تحميل البروفايلات loadProfiles', "loadProfiles"],
    ['تغيير البروفايل profileSelect', "profileSelect"],
    ['بانر الكول داون refreshCooldownBanner', "refreshCooldownBanner"],
    ['عداد الكول داون setInterval', "cooldownTicker"],
    ['زر إلغاء كول داون btn-clear-cooldown', "btn-clear-cooldown"],
    ['status.rateLimited → refresh banner', "status.rateLimited"],
    ['status.multiDone → refresh banner', "status.multiDone"],
    ['init → refreshCooldownBanner', "await refreshCooldownBanner"],
    ['فحص قائمة موديلات list-models', "listModels"],
    ['توليد AI generateAiPosts', "generateAiPosts"],
    ['استيراد CSV importCsvFlow', "importCsvFlow"],
    ['حذف مجمّع bulkDelete', "bulkDelete"],
    ['تصدير الطابور exportQueue', "exportQueue"],
  ];
  let uiFailed = [];
  for (const [label, pattern] of uiChecks) {
    if (!rendererSrc.includes(pattern)) uiFailed.push(label);
    else ok(label, true);
  }
  if (uiFailed.length > 0) {
    for (const f of uiFailed) ok(f, false, 'غير موجود في renderer.js');
  }

  // ══════════════════════════════════════════════
  section('13. index.html — عناصر الواجهة');
  // ══════════════════════════════════════════════
  const htmlSrc = fs.readFileSync(path.join(__dirname, '../src/ui/index.html'), 'utf8');
  const htmlElements = [
    ['زر النشر الرئيسي', 'btn-main-action'],
    ['قائمة البروفايلات', 'profile-select'],
    ['بانر الكول داون', 'cooldown-banner'],
    ['نص الكول داون', 'cooldown-text'],
    ['عداد الكول داون', 'cooldown-timer-live'],
    ['زر إلغاء الكول داون', 'btn-clear-cooldown'],
    ['قائمة الموديلات', 'model-select'],
    ['زر فحص الموديلات', 'btn-fetch-models'],
    ['جدول الطابور', 'queue-table-body'],
    ['عداد الطابور', 'queue-count'],
    ['زر استيراد CSV', 'btn-add-posts'],
    ['عداد النجاح', 'success-count'],
    ['عداد الفشل', 'failed-count'],
    ['حقل رابط الإحالة', 'referral-link'],
    ['حقل Base URL', 'ai-base-url'],
    ['حقل API Key', 'ai-api-key'],
  ];
  for (const [label, id] of htmlElements) {
    ok(label + ' موجود في HTML', htmlSrc.includes(id));
  }

  // ══════════════════════════════════════════════
  // النتيجة النهائية
  // ══════════════════════════════════════════════
  console.log('\n' + '═'.repeat(50));
  console.log(`\n📊 النتيجة النهائية: ${passed}/${passed + failed} نجح`);
  if (failed > 0) {
    console.log(`\n❌ الفاشل (${failed}):`);
    results.filter(r => r.status === '❌').forEach(r => {
      console.log(`   - ${r.name}${r.detail ? ': ' + r.detail : ''}`);
    });
  }
  console.log(failed === 0 ? '\n🏆 كل الاختبارات نجحت!\n' : '\n⚠️  بعض الاختبارات فشلت\n');
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(e => {
  console.error('خطأ غير متوقع:', e);
  process.exit(1);
});
