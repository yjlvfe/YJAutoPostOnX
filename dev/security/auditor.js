/** 
 * 🔍 Startup Auditor — security & integrity scan
 * ==========================================================
 * Checks:
 *   - Hardcoded referral/URLs in source files (must stay external)
 *   - Cache/counter files for stale data
 *   - Session persistence files
 *   - Referral toggle consistency
 * Generates a detailed report.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { extractUrls } = require('../security/validator');
const referralService = require('../automation/referralService');

const CACHE_DIR = path.join(os.homedir(), '.config', 'x-poster-bot-profile', 'mexc-counters');
const SESSION_DIR = path.join(os.homedir(), '.config', 'x-poster-profiles');

/**
 * Strip JS comments so only URLs that are actually REACHABLE AT RUNTIME are
 * audited. The filter below always claimed to skip comments but never did, so
 * documenting a URL in a comment (e.g. the daily-post-limit upsell page that
 * isLimitUrl() detects) raised a permanent 🔴 CRITICAL that could not be
 * cleared without deleting the explanation — training the reader to ignore the
 * audit. A URL in a comment cannot end up in a post; a URL in a string can, and
 * those are still scanned.
 *
 * `//` inside a URL is NOT a comment: the [^:] guard keeps `https://…` intact,
 * so a real hardcoded link on a line with a trailing comment is still caught.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Scan a text file for URLs.
 */
function scanFileForUrls(filePath) {
  const result = { file: filePath, urls: [], hasHardcodedLink: false, issues: [] };
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const urls = extractUrls(stripComments(content));

    // Filter out code patterns, comments, and known safe patterns
    const hardcoded = urls.filter(u => {
      if (u.includes('{link}')) return false;
      if (u.includes('PLACEHOLDER')) return false;
      if (u.includes('DEFAULT_LINK')) return false;
      if (u.startsWith('http://localhost')) return false;
      if (u.startsWith('http://127.0.0.1')) return false;
      // Skip template literals with interpolation (code variables, not hardcoded)
      if (u.includes('${')) return false;
      // Skip x.com used in page navigation (not a post link)
      if (u === 'https://x.com' || u === 'https://x.com/home') return false;
      // Skip fallback/default MEXC link used for stats computation (not in posts)
      if (u.includes('shareCode=mexc-stats')) return false;
      return true;
    });

    result.urls = hardcoded;
    result.hasHardcodedLink = hardcoded.length > 0;

    if (result.hasHardcodedLink) {
      result.issues = hardcoded.map(u => `⚠️  رابط ثابت مكتشف: ${u}`);
    }
  } catch (e) {
    result.issues = [`❌ فشل قراءة الملف: ${e.message}`];
  }
  return result;
}

/**
 * Run a full audit — template validation + security scan.
 * @returns {{ timestamp: string, critical: Array, warnings: Array, info: Array, scanned: number, status: 'PASS'|'FAIL'|'WARN' }}
 */
function runAudit() {
  const report = {
    timestamp: new Date().toISOString(),
    scanned: 0,
    critical: [],
    warnings: [],
    info: [],
    status: 'PASS',
  };

  // ════════════════════════════════════════
  // 1. Generation mode (AI engine — no static templates)
  // ════════════════════════════════════════
  report.info.push('🧠 وضع التوليد: ذكاء اصطناعي (لا يعتمد على قوالب ثابتة)');

  // ════════════════════════════════════════
  // 2. Hardcoded URL scan in source files
  // ════════════════════════════════════════
  const AUTO_DIR = path.join(__dirname, '..', 'automation');
  const sourceFiles = [
    'xPoster.js', 'queueManager.js', 'contentEngine.js',
    'referralService.js', 'reportEngine.js',
  ].map(f => path.join(AUTO_DIR, f));

  for (const filePath of sourceFiles) {
    try {
      if (fs.existsSync(filePath)) {
        report.scanned++;
        const r = scanFileForUrls(filePath);
        if (r.hasHardcodedLink) {
          report.critical.push(...r.issues);
          report.status = 'FAIL';
        }
      }
    } catch (e) {
      report.warnings.push(`⚠️ فشل مسح ${path.basename(filePath)}: ${e.message}`);
    }
  }

  // ════════════════════════════════════════
  // 3. Check cache/counter files
  // ════════════════════════════════════════
  try {
    if (fs.existsSync(CACHE_DIR)) {
      const cntFiles = fs.readdirSync(CACHE_DIR);
      report.info.push(`📊 ملفات العداد: ${cntFiles.length} ملف`);
      // Validate counter values
      for (const f of cntFiles) {
        const fp = path.join(CACHE_DIR, f);
        try {
          const val = parseInt(fs.readFileSync(fp, 'utf8').trim(), 10);
          if (isNaN(val)) report.warnings.push(`⚠️ ملف عداد تالف: ${f}`);
        } catch (e) {
          report.warnings.push(`⚠️ فشل قراءة عداد: ${f}`);
        }
      }
    }
  } catch (e) {
    report.warnings.push(`⚠️ فشل فحص ذاكرة التخزين المؤقت: ${e.message}`);
  }

  // ════════════════════════════════════════
  // 4. Check session profiles
  // ════════════════════════════════════════
  try {
    if (fs.existsSync(SESSION_DIR)) {
      const profiles = fs.readdirSync(SESSION_DIR);
      report.info.push(`👤 بروفايلات المتصفح: ${profiles.length}`);
      for (const profile of profiles) {
        const configFile = path.join(SESSION_DIR, profile, 'config.json');
        if (fs.existsSync(configFile)) {
          report.scanned++;
          const r = scanFileForUrls(configFile);
          if (r.hasHardcodedLink) {
            report.critical.push(...r.issues);
            report.status = 'FAIL';
          }
        }
      }
    }
  } catch (e) {
    report.warnings.push(`⚠️ فشل فحص البروفايلات: ${e.message}`);
  }

  // ════════════════════════════════════════
  // 5. Referral toggle consistency
  // ════════════════════════════════════════
  try {
    const refState = referralService.getState();
    report.info.push(`🔗 نظام الإحالة: ${refState.enabled ? 'مُفعّل' : 'معطّل'}`);
    if (refState.enabled && !refState.link) {
      report.warnings.push('⚠️ نظام الإحالة مفعّل لكن لا يوجد رابط إحالة مخزّن');
    }
    if (!refState.enabled && refState.link) {
      report.info.push('ℹ️ نظام الإحالة معطل ولكن يوجد رابط مخزّن (غير نشط)');
    }
  } catch (e) {
    report.warnings.push(`⚠️ فشل فحص نظام الإحالة: ${e.message}`);
  }

  report.info.push(`📁 تم مسح ${report.scanned} ملف`);

  if (report.critical.length === 0 && report.status === 'PASS') {
    report.info.push('✅ الفحص كامل: لا توجد مشاكل');
  }

  return report;
}

/**
 * Print the audit report to console.
 */
function printReport(report) {
  console.log('\n═══════════════════════════════════════════');
  console.log('  🔍 تقرير فحص النظام');
  console.log(`  ${report.timestamp}`);
  console.log('═══════════════════════════════════════════');

  if (report.critical.length > 0) {
    console.log(`\n🔴 حرج (${report.critical.length}):`);
    report.critical.forEach(i => console.log(`  ${i}`));
  }

  if (report.warnings.length > 0) {
    console.log(`\n🟡 تحذيرات (${report.warnings.length}):`);
    report.warnings.forEach(i => console.log(`  ${i}`));
  }

  if (report.info.length > 0) {
    console.log(`\n🔵 معلومات:`);
    report.info.forEach(i => console.log(`  ${i}`));
  }

  console.log(`\n📊 الحالة: ${report.status === 'PASS' ? '✅ سليم' : report.status === 'FAIL' ? '🔴 يحتاج إصلاح' : '🟡 تحذيرات'}`);
  console.log('═══════════════════════════════════════════\n');
}

module.exports = { runAudit, printReport, scanFileForUrls };
