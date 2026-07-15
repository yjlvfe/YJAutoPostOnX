/**
 * semantic-dedup.test.js — meaning-level duplicate rejection (v5.9.0)
 * ====================================================================
 * The complaint this fixes: the system produced the SAME IDEA in different
 * wording, because the old guard only caught near-verbatim bigram overlap
 * inside a 2000-entry recency window.
 *
 * Verifies (v5.12.1 volume-priority thresholds — user request):
 *   1. Genuinely distinct topics — even in the same crypto domain — PASS.
 *   2. CLEAR paraphrases (same idea, mostly reworded) now PASS — the user
 *      explicitly asked to prioritize volume over literal-meaning strictness
 *      ("حتى لو تكرر المعنى بصيغة مختلفة نمشيها"), relying on the dynamic
 *      angle-exclusion system (not this gate) to keep output feeling varied.
 *   3. NEAR-VERBATIM restatements (same sentence structure, a few words
 *      swapped) are STILL rejected — the gate isn't fully disabled.
 *   4. Seeding from queue + preview texts blocks their near-verbatim repeats.
 *   5. NO window: doc #1 still blocks a near-verbatim repeat after 20k docs.
 *   6. Scale: 20k docs indexed + checked at speed (100k-ready).
 */

'use strict';

const { SemanticIndex, conceptStems } = require('../dev/automation/semanticIndex');

let failures = 0;
function check(label, cond) {
  if (cond) console.log(`✅ ${label}`);
  else { console.error(`❌ ${label}`); failures++; }
}

const DISTINCT = [
  'حجم التداول هو المؤشر الأهم لقياس قوة أي حركة سعرية في سوق الكريبتو، فالصعود المصحوب بحجم كبير يعكس اهتماماً حقيقياً من المتداولين بينما الصعود بحجم ضعيف غالباً ما يكون مجرد فخ سعري يجب الحذر منه دائماً',
  'إدارة المخاطر هي خط الدفاع الأول لكل متداول ناجح، فلا تخاطر أبداً بأكثر مما تتحمل خسارته وضع دائماً خطة واضحة لحجم المركز ووقف الخسارة قبل الدخول في أي صفقة حتى تحمي رأس مالك على المدى الطويل وتستمر',
  'سيكولوجية السوق تتحكم في معظم تحركات الأسعار، فالخوف يدفع للبيع عند القيعان والطمع يدفع للشراء عند القمم، والمتداول الذكي هو من يسيطر على مشاعره ويتخذ قراراته بناء على خطة مدروسة لا على ردة فعل متهورة',
  'الرسوم المنخفضة تصنع فرقاً حقيقياً في أرباحك على المدى الطويل، فكل نسبة توفرها في رسوم التداول تبقى في محفظتك، اختر منصة تقدم رسوماً تنافسية وسرعة تنفيذ عالية حتى لا تضيع أرباحك في تكاليف خفية لا داعي لها',
  'وقف الخسارة ليس علامة ضعف بل أداة حماية ذكية، فالمتداول الذي يضع حدوداً واضحة لخسائره يبقى في اللعبة أطول ويحمي محفظته من الانهيار المفاجئ عند تحرك السوق ضده بعنف وبسرعة لا يتوقعها أحد في لحظة واحدة',
  'الرافعة المالية سلاح ذو حدين تضاعف الأرباح والخسائر معاً، فاستخدمها بحذر شديد وبنسب منخفضة إن قررت استخدامها أصلاً لأن المبالغة فيها أسرع طريق لتصفية حسابك بالكامل في حركة سعرية واحدة عكس توقعاتك تماماً',
];

// CLEAR paraphrases of DISTINCT[i] (same idea, mostly reworded, score ~0.44-0.49
// on this corpus). Rejected under v5.11.0's 0.5/0.42; v5.12.1 raises the bar
// again (0.68/0.6) so these now PASS — the user's explicit volume-priority ask.
const CLEAR_PARAPHRASES_NOW_PASS = [
  [1, 'أول خطوط الدفاع للمتداول الناجح هي إدارة المخاطر، لا تجازف بما لا تحتمل فقدانه، وحدد مسبقاً خطة لحجم مركزك ونقطة وقف خسارتك قبل أي صفقة كي يبقى رأس مالك محمياً على المدى البعيد وتواصل طريقك'],
  [4, 'لا تعتبر وقف الخسارة ضعفاً فهو وسيلة حماية ذكية، من يرسم حدوداً صريحة لخسائره يصمد في السوق مدة أطول ويقي محفظته من انهيار مفاجئ حين يتحرك السوق عكسه بقوة وسرعة لا يتوقعها أي أحد في لحظات'],
];

// BORDERLINE rewrites (same general theme, heavily reworded — scored
// 0.33/0.37, already passing since v5.11.0).
const BORDERLINE_NOW_PASS = [
  [0, 'قوة أي حركة في أسعار الكريبتو تُقاس بحجم التداول المصاحب لها، فالارتفاع مع أحجام ضخمة دليل إقبال حقيقي من المتداولين، أما الارتفاع بأحجام هزيلة فغالباً فخ في الأسعار ينبغي الانتباه له والحذر منه باستمرار'],
  [5, 'الرافعة المالية سيف بحدين يضخم الربح والخسارة معاً، تعامل معها بحذر بالغ وبنسب صغيرة إن أصررت على استخدامها، فالإفراط فيها أقصر الطرق لتصفية محفظتك كلها في موجة سعرية واحدة تخالف توقعك تماماً'],
];

// NEAR-VERBATIM restatements of DISTINCT[i] — same sentence structure, only a
// handful of words swapped for close synonyms (score ~1.0). MUST still be
// rejected — proves the gate isn't fully disabled at the looser thresholds.
const NEAR_VERBATIM_STILL_REJECTED = [
  [1, 'إدارة المخاطر هي خط الدفاع الأول لكل متداول ناجح، فلا تخاطر أبداً بأكثر مما تتحمل خسارته وضع دائماً خطة واضحة لحجم مركزك ووقف خسارتك قبل الدخول في أي صفقة حتى تحمي رأس مالك على المدى الطويل وتستمر في مسيرتك'],
];

// Same domain (risk/psychology), genuinely NEW ideas — must PASS.
const NEW_IDEAS = [
  'أخطر عدو للمتداول المبتدئ هو الثقة الزائدة بعد أول ربح، فالنجاح المبكر يدفع لمضاعفة الأحجام دون خبرة كافية، حافظ على نفس الانضباط الذي بدأت به مهما كبرت أرباحك لأن السوق يعاقب الغرور بلا رحمة أبداً',
  'سجل صفقاتك في دفتر يوميات تداول مفصل، اكتب سبب الدخول والخروج ونتيجة كل صفقة، فمراجعة قراراتك السابقة بصدق هي أسرع طريقة لاكتشاف أخطائك المتكررة وتحويل تجاربك إلى خبرة حقيقية تراكمية مع الوقت دائماً',
];

// ── 1+2. Paraphrase rejection without false positives ──────────────────────
const idx = new SemanticIndex();
for (const t of DISTINCT) idx.add(t);

check('exact duplicate rejected (level 1)', idx.check(DISTINCT[0]).level === 1);
check('exact dup with diacritics/hamza variants rejected',
  idx.check(DISTINCT[0].replace(/ا/g, 'أ')).level === 1);

for (const [i, p] of NEAR_VERBATIM_STILL_REJECTED) {
  const r = idx.check(p);
  check(`near-verbatim restatement of #${i} still REJECTED (score=${r.score})`, r.dup === true);
}
for (const [i, p] of CLEAR_PARAPHRASES_NOW_PASS) {
  const r = idx.check(p);
  check(`clear paraphrase of #${i} now PASSES — volume-priority (score=${r.score})`, r.dup === false);
}
for (const [i, p] of BORDERLINE_NOW_PASS) {
  const r = idx.check(p);
  check(`borderline rewrite of #${i} now PASSES — middle-ground (score=${r.score})`, r.dup === false);
}
for (let i = 0; i < NEW_IDEAS.length; i++) {
  const r = idx.check(NEW_IDEAS[i]);
  check(`new idea #${i} PASSES (score=${r.score})`, r.dup === false);
}

// Every distinct topic must not collide with the others (leave-one-out).
let falsePositives = 0;
for (let i = 0; i < DISTINCT.length; i++) {
  const probe = new SemanticIndex();
  for (let j = 0; j < DISTINCT.length; j++) if (j !== i) probe.add(DISTINCT[j]);
  if (probe.check(DISTINCT[i]).dup) falsePositives++;
}
check('0 false positives across distinct topics', falsePositives === 0);

// ── 3. Queue + preview seeding ──────────────────────────────────────────────
const seeded = new SemanticIndex();
seeded.add(DISTINCT[1]);                    // as if sitting in the QUEUE
seeded.add(DISTINCT[4] + '\nhttps://mexc.com/x #Crypto');  // as if in PREVIEW (with link+tag)
check('near-verbatim repeat of a QUEUE post rejected', seeded.check(NEAR_VERBATIM_STILL_REJECTED[0][1]).dup === true);
const nearVerbatimOf4 = 'وقف الخسارة ليس علامة ضعف بل أداة حماية ذكية، فالمتداول الذي يضع حدوداً واضحة لخسائره يبقى في اللعبة أطول ويحمي محفظته من انهيار مفاجئ عند تحرك السوق ضده بعنف وبسرعة لا يتوقعها أحد في لحظة واحدة أبداً';
check('near-verbatim repeat of a PREVIEW post rejected (link/hashtags ignored)',
  seeded.check(nearVerbatimOf4).dup === true);

// ── 4+5. Scale: 20k docs, NO window ────────────────────────────────────────
const big = new SemanticIndex();
big.add(DISTINCT[0]);   // doc #1 — will be 20k docs deep by the end
const t0 = Date.now();
for (let i = 0; i < 20000; i++) {
  // Synthetic distinct docs: unique concept vocabulary per doc.
  big.add(`استراتيجية رقم ${i} تعتمد على مؤشر${i} وقاعدة${i} خاصة بأصل${i} ونمط${i} زمني${i} مع اشارة${i} وفلتر${i} لحساب${i} وهدف${i}`);
}
const indexMs = Date.now() - t0;

const t1 = Date.now();
// A NEAR-VERBATIM restatement of doc #1 (same structure, few words swapped).
const nearVerbatimOfDoc1 =
  'حجم التداول هو المؤشر الأهم لقياس قوة أي حركة سعرية في سوق الكريبتو، فالصعود المصحوب بحجم كبير يعكس اهتماماً حقيقياً من المتداولين بينما الصعود بحجم ضعيف غالباً ما يكون مجرد فخ سعري يجب الحذر منه أبداً';
const oldCaught = big.check(nearVerbatimOfDoc1);
let checks = 0;
for (let i = 0; i < 500; i++) { big.check(NEW_IDEAS[i % 2] + ' زاوية ' + i); checks++; }
const checkMs = Date.now() - t1;

check(`indexed 20k docs fast (${indexMs}ms < 15s)`, indexMs < 15000);
check('NO window: doc #1 near-verbatim repeat still caught 20k docs later', oldCaught.dup === true);
check(`500 checks against 20k docs fast (${checkMs}ms < 5s)`, checkMs < 5000);
check('index size correct', big.size === 20001);

// Stems sanity — variants of one concept converge.
const s1 = [...conceptStems('وقف الخسارة يحمي رأس المال')];
const s2 = [...conceptStems('وقفُ خسارتك يحمي رأسَ مالك')];
check('stem variants converge (خساره/خسارتك، مال/مالك)',
  s2.filter(s => s1.includes(s)).length >= 4);

if (failures) {
  console.error(`\n❌ semantic-dedup.test.js: ${failures} FAILED`);
  process.exit(1);
}
console.log('\n✅ semantic-dedup.test.js: ALL passed');
