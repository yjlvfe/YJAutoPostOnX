/**
 * ⚡ DIAGNOSTIC PIPELINE TEST — Full generation pipeline audit
 *
 * Tests every stage of the AI generation pipeline with controlled inputs,
 * reporting exact failure counts and reasons. Run this first when generation
 * produces 0 accepted posts.
 */
const E = require('../src/automation/contentEngine');
const LINK = 'https://www.mexc.com/auth/signup?inviteCode=mexc-DIAG';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(title) {
  console.log(`\n${'═'.repeat(60)}\n${title}\n${'═'.repeat(60)}`);
}

// ── 1. parseTweetArray — can it handle real LLM outputs? ──
section('1. parseTweetArray — LLM output parsing');

// Simulate parseTweetArray from main.js
function parseTweetArray(raw) {
  if (!raw) return [];
  let text = raw.trim();
  text = text.replace(/```(?:json)?/gi, '').trim();
  try { const arr = JSON.parse(text); if (Array.isArray(arr)) return arr.filter(x => typeof x === 'string' && x.trim().length > 0); } catch {}
  const start = text.indexOf('['), end = text.lastIndexOf(']');
  if (start !== -1 && end !== -1 && end > start) { try { const arr = JSON.parse(text.slice(start, end + 1)); if (Array.isArray(arr)) return arr.filter(x => typeof x === 'string' && x.trim().length > 0); } catch {} }
  return text.split('\n').map(l => l.replace(/^[\s\-*\d.)\]]+\s*/, '').replace(/^[""'“]|[""'”]$/g, '').trim()).filter(l => l.length > 40).filter(l => !/^\d+\s*chars?$/i.test(l));
}

const PARSE_CASES = [
  { name: 'clean JSON array', input: '["نص واحد اثنان ثلاثة"]', expect: 1 },
  { name: 'JSON with markdown fences', input: '```json\n["نص واحد اثنان ثلاثة"]\n```', expect: 1 },
  { name: 'JSON in code block', input: '```\n["نص واحد اثنان ثلاثة"]\n```', expect: 1 },
  { name: 'text with preamble', input: 'Here are your tweets:\n["نص واحد اثنان ثلاثة"]', expect: 1 },
  { name: 'text with suffix', input: '["نص واحد اثنان ثلاثة"]\n\nThese are 1 tweets', expect: 1 },
  { name: 'multiple items', input: '["نص أول", "نص ثاني", "نص ثالث"]', expect: 3 },
  { name: 'empty array', input: '[]', expect: 0 },
  { name: 'null input', input: null, expect: 0 },
  { name: 'empty string', input: '', expect: 0 },
  { name: 'Arabic line-separated', input: '📈 نص طويل بما فيه الكفاية ليكون تغريدة مناسبة للتداول في الكريبتو والأسواق المالية\n🔥 نص آخر طويل بما فيه الكفاية ليكون تغريدة مناسبة عن التداول', expect: 2 },
  { name: 'numbered lines Arabic', input: '1. 📈 نص طويل بما فيه الكفاية ليكون تغريدة مناسبة للتداول في الكريبتو والأسواق المالية\n2. 🔥 نص آخر طويل بما فيه الكفاية', expect: 2 },
  { name: 'model refuses', input: 'I cannot generate this content as it may promote risky financial behavior.', expect: 0 }, // falls through to line split, each line < 40 chars
];

for (const tc of PARSE_CASES) {
  const result = parseTweetArray(tc.input);
  check(tc.name, result.length === tc.expect, `got ${result.length}, expected ${tc.expect}`);
}

// ── 2. cleanCoreText — does it properly clean AI output? ──
section('2. cleanCoreText — AI output cleaning');
check('empty → empty', E.cleanCoreText('') === undefined || E.cleanCoreText('') === null || E.cleanCoreText('') === '');
check('normal text preserved', E.cleanCoreText('📈 نص عادي للتغريدة') === '📈 نص عادي للتغريدة');
check('strips char count', !E.cleanCoreText('📈 نص مع 150 حرف').includes('150 حرف'));
check('strips tweet numbering', E.cleanCoreText('Tweet 1: 📈 نص').startsWith('📈'));
check('strips Arabic numbering', E.cleanCoreText('تغريدة 5: 📈 نص').startsWith('📈'));
check('strips parentheses numbering', E.cleanCoreText('(17-الحجم) 📈 نص').startsWith('📈'));

// ── 3. assembleTweet — does it fit cores into 200-270? ──
section('3. assembleTweet — core→tweet assembly');
const CORES_GOOD = [
  { core: '📈 حجم التداول هو المؤشر الأهم لقياس قوة أي حركة سعرية في سوق الكريبتو، فالصعود المصحوب بحجم كبير يعكس اهتماماً حقيقياً من المتداولين بينما الصعود بحجم ضعيف غالباً ما يكون مجرد فخ سعري يجب الحذر منه دائماً', expect: true },
  { core: 'نص قصير', expect: false },
  { core: 'نص طويل جداً جداً جداً جداً جداً جداً جداً جداً جداً جداً جداً جداً جداً جداً جداً جداً جداً جداً جداً جداً جداً جداً جداً جداً جداً جداً جداً جداً جداً جداً جداً جداً جداً', expect: false },
];

for (const tc of CORES_GOOD) {
  // Need to use the exact contentEngine functions
  const cleaned = E.cleanCoreText(tc.core);
  const result = cleaned ? E.assembleTweet(cleaned, LINK) : null;
  check(`core len=${tc.core.length}: ${tc.expect ? 'should assemble' : 'should NOT assemble'}`, 
        (result !== null) === tc.expect,
        result ? `got len=${result.length}` : 'null');
}

// ── 4. validateTweet — what gets rejected? ──
section('4. validateTweet — rejection reasons');
const assembled = E.assembleTweet(CORES_GOOD[0].core, LINK);
if (assembled) {
  const v = E.validateTweet(assembled.text, LINK);
  check('good tweet passes', v.valid, v.reason || '');
}

// Check the specific issue: "علي" overused
const textWithAliRepeated = '📈 علي عبد الله علي السيد علي الكريبتو علي التداول';
const cleanedAli = E.cleanCoreText(textWithAliRepeated);
const assembledAli = E.assembleTweet(cleanedAli, LINK);
if (assembledAli) {
  const vAli = E.validateTweet(assembledAli.text, LINK);
  check('"علي" x4 passes with maxCount=3 (was failing at 2)', vAli.valid, vAli.reason || '');
}

// Check adjacent repeat still caught
const textAdjRepeat = '📈 تام تام في سوق الكريبتو';
const cleanedAdj = E.cleanCoreText(textAdjRepeat);
const assembledAdj = E.assembleTweet(cleanedAdj, LINK);
if (assembledAdj) {
  const vAdj = E.validateTweet(assembledAdj.text, LINK);
  check('adjacent repeat تام تام still blocked', !vAdj.valid, vAdj.reason || 'should be blocked');
}

// ── 5. tokenize + jaccard (dedup) ──
section('5. isDuplicateInSession — dedup');
const sess = { exactKeys: new Set(), tokenSets: [] };
const text1 = '📈 حجم التداول هو المؤشر الأهم لقياس قوة أي حركة سعرية في سوق الكريبتو';
const text2 = '🔥 إدارة المخاطر هي خط الدفاع الأول لكل متداول ناجح في الأسواق المالية';

// Add text1 to session
const e1 = E.exactKey(text1);
sess.exactKeys.add(e1);
sess.tokenSets.push(E.tokenize(E.bodyOnly(text1)));

// Check text2 is NOT duplicate of text1 (different topic)
const d1 = E.isDuplicateInSession(text2, sess, 0.85);
check('different topics not duplicate', !d1.dup);

// Check text1 IS exact duplicate of itself
const d2 = E.isDuplicateInSession(text1, sess, 0.85);
check('same text is exact duplicate', d2.dup && d2.level === 1);

// ── 6. tweetLength accuracy ──
section('6. tweetLength — X.com character counting');
check('URL counts as 23', E.tweetLength('https://example.com') === 23);
check('text+url correct', E.tweetLength('📈 نص https://example.com') > 20);

// ── 7. History append + load ──
section('7. History persistence');
const testTexts = ['📈 نص اختباري للتخزين'];
E.appendHistory(testTexts);
const recent = E.getRecentBodies(5);
check('appendHistory + getRecentBodies works', Array.isArray(recent) && recent.length > 0);
check('recentBodies contains our text', recent.some(b => b.includes('نص اختباري')));

// ── 8. buildSessionSystem + buildRoundUser ──
section('8. Prompt building');
const sys = E.buildSessionSystem({});
check('system prompt has core length range', sys.includes('170') && sys.includes('210'));
check('system prompt mentions JSON', sys.includes('JSON'));
const user = E.buildRoundUser({ quantity: 5, angles: ['زاوية اختبار'] });
check('user prompt asks for 5', user.includes('5'));
const user20 = E.buildRoundUser({ quantity: 20, angles: Array(20).fill('زاوية') });
check('user prompt asks for 20', user20.includes('20'));

// ── SUMMARY ──
console.log(`\n${'═'.repeat(60)}`);
const total = passed + failed;
const pct = ((passed / total) * 100).toFixed(1);
console.log(`\n📊 DIAGNOSTIC RESULTS: ${passed}/${total} passed (${pct}%)`);
if (failed > 0) {
  console.log(`❌ ${failed} failures detected — see above for details`);
  process.exit(1);
} else {
  console.log('🏆 ALL DIAGNOSTIC CHECKS PASSED');
}
