/** 
 * 🔍 Startup Auditor — Validate template health & security
 * ==========================================================
 * Checks:
 *   - Template structure (id, name, category, template)
 *   - {link} placeholder presence
 *   - #MEXC hashtag presence
 *   - All spintax brackets are balanced
 *   - Valid post length range (200-270 chars after expansion)
 *   - Hardcoded URLs in source files
 *   - Cache/counter files for stale data
 *   - Session persistence files
 *   - Config/env files
 * Generates a detailed report.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { extractUrls, URL_RE } = require('../security/validator');
const referralService = require('../automation/referralService');

const CACHE_DIR = path.join(os.homedir(), '.config', 'x-poster-bot-profile', 'mexc-counters');
const SESSION_DIR = path.join(os.homedir(), '.config', 'x-poster-profiles');

/**
 * Check spintax brackets are balanced (same number of { and }).
 */
function spintaxBalanced(text) {
  let opens = 0, closes = 0;
  for (const ch of text) {
    if (ch === '{') opens++;
    if (ch === '}') closes++;
  }
  return opens === closes;
}

/**
 * Validate a single template object.
 * @param {object} tmpl
 * @param {number} index
 * @returns {string[]} Array of issue strings (empty = healthy)
 */
function validateTemplate(tmpl, index) {
  const issues = [];

  // Structure checks
  if (tmpl.id === undefined || tmpl.id === null) issues.push(`🔸 T${index}: id مفقود`);
  if (!tmpl.name) issues.push(`🔸 T${tmpl.id ?? index}: الاسم مفقود`);
  if (!tmpl.category) issues.push(`🔸 T${tmpl.id ?? index}: التصنيف مفقود`);
  if (!tmpl.template) {
    issues.push(`🔸 T${tmpl.id ?? index}: القالب فارغ`);
    return issues;
  }

  // Spintax balance
  if (!spintaxBalanced(tmpl.template)) {
    issues.push(`🔸 T${tmpl.id ?? index}: أقواس spintax غير متوازنة`);
  }

  // {link} placeholder
  if (!tmpl.template.includes('{link}')) {
    issues.push(`🔸 T${tmpl.id ?? index}: لا يحتوي على {link}`);
  }

  // #MEXC hashtag
  if (!tmpl.template.includes('#MEXC')) {
    issues.push(`🔸 T${tmpl.id ?? index}: لا يحتوي على #MEXC`);
  }

  // Length estimation — replace {link} with ~50 chars, check rough length
  const withLink = tmpl.template.replace('{link}', 'https://www.mexc.com/acquisition/custom-sign-up?shareCode=MOCK');
  // Remove spintax — pick first option in each
  const simple = withLink.replace(/\{[^}]+\}/g, (m) => {
    const inner = m.slice(1, -1);
    return inner.split('|')[0] || '';
  });
  if (simple.length < 200) issues.push(`🔸 T${tmpl.id ?? index}: أقصر من 200 حرف (~${simple.length})`);
  if (simple.length > 270) issues.push(`🔸 T${tmpl.id ?? index}: أطول من 270 حرف (~${simple.length})`);

  return issues;
}

/**
 * Validate all templates and return health report.
 * @returns {{ healthy: number, unhealthy: number, issues: string[], templateCount: number, stats: object }}
 */
function validateTemplates() {
  let templates;
  try {
    templates = require('../automation/mexcTemplates');
    if (!Array.isArray(templates)) {
      return { healthy: 0, unhealthy: 0, issues: ['❌ mexcTemplates.js لا يصدر مصفوفة'], templateCount: 0, stats: {} };
    }
  } catch (e) {
    return { healthy: 0, unhealthy: 0, issues: [`❌ فشل تحميل القوالب: ${e.message}`], templateCount: 0, stats: {} };
  }

  const allIssues = [];
  let healthy = 0, unhealthy = 0;

  for (let i = 0; i < templates.length; i++) {
    const issues = validateTemplate(templates[i], i);
    if (issues.length === 0) {
      healthy++;
    } else {
      unhealthy++;
      allIssues.push(...issues);
    }
  }

  return {
    healthy,
    unhealthy,
    issues: allIssues,
    templateCount: templates.length,
    stats: {
      categories: [...new Set(templates.filter(t => t.category).map(t => t.category))].length,
    },
  };
}

/**
 * Scan a text file for URLs.
 */
function scanFileForUrls(filePath) {
  const result = { file: filePath, urls: [], hasHardcodedLink: false, issues: [] };
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const urls = extractUrls(content);

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
 * Scan a directory recursively for files containing URLs.
 */
function scanDirectory(dirPath, pattern = '.js') {
  const results = [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        results.push(...scanDirectory(fullPath, pattern));
      } else if (entry.isFile() && entry.name.endsWith(pattern)) {
        results.push(scanFileForUrls(fullPath));
      }
    }
  } catch (e) {
    // Directory doesn't exist — skip silently
  }
  return results;
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
  // 1. Template Health Check (NEW)
  // ════════════════════════════════════════
  const tpl = validateTemplates();
  report.info.push(`📦 القوالب: ${tpl.templateCount} قالب (${tpl.healthy} سليم، ${tpl.unhealthy}有问题)`);
  if (tpl.stats.categories) report.info.push(`🏷️ التصنيفات: ${tpl.stats.categories}`);

  if (tpl.issues.length > 0) {
    report.critical.push(...tpl.issues);
    report.status = 'FAIL';
  }

  // ════════════════════════════════════════
  // 2. Hardcoded URL scan in source files
  // ════════════════════════════════════════
  const AUTO_DIR = path.join(__dirname, '..', 'automation');
  const sourceFiles = [
    'xPoster.js', 'queueManager.js', 'spintaxEngine.js',
    'linkService.js', 'referralService.js', 'reportEngine.js',
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

module.exports = { runAudit, printReport, scanFileForUrls, validateTemplates };
