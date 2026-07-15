/**
 * 🔬 OFFLINE DIAGNOSTIC — يحاكي ردود AI حقيقية ويمرّرها عبر pipeline الكاملة
 * هذا يكشف مشاكل الـ validateTweet / assembleTweet بدون حاجة للإنترنت
 */

const contentEngine = require('../dev/automation/contentEngine');

const LINK = 'https://www.mexc.com/register?inviteCode=mexc-YJ';

// ─── محاكاة ردود AI حقيقية — نصوص خام كما يردّها الموديل ────────────────────
const MOCK_AI_CORES = [
  // نصوص طبيعية بحجم صحيح
  '📈 السوق يكافئ الصبر لا العجلة. كل متداول ناجح يعرف أن أفضل الصفقات تأتي لمن ينتظر الفرصة الصحيحة بدلاً من مطاردة كل حركة.',
  '🔥 إدارة المخاطر هي الفرق بين المتداول الناجح والفاشل. لا تضع أكثر من 2% من رأس مالك في صفقة واحدة، هذه القاعدة حمت آلاف المتداولين.',
  '💰 حجم التداول يخبرك بالحقيقة. ارتفاع السعر مع حجم ضعيف يعني فخاً، أما الارتفاع مع حجم قوي فهو حركة حقيقية تستحق الاهتمام.',
  '⭐ أكبر أخطاء المبتدئين هو الدخول بدون خطة. حدد هدفك ووقف خسارتك قبل الضغط على زر الشراء، لأن العقل الخائف لا يفكر بوضوح.',
  '🎯 FOMO أخطر عدو للمتداول. حين يصل الجميع ويحتفلون بالأسعار العالية، يكون المحترف قد دخل مبكراً وهو الآن ينتظر وقت الخروج.',
  '📊 وقف الخسارة ليس اختياراً، بل ضرورة. المتداول الذي يتداول بدون حماية يشبه السائق بدون حزام، يمكن أن تمر مئة رحلة بأمان ثم يأتي الحادث.',
  '🚀 الرافعة المالية سلاح ذو حدين. ارباح ضخمة ممكنة لكن الخسائر أضخم. المبتدئ الذكي يبدأ بدون رافعة حتى يفهم السوق جيداً.',
  '💎 التحليل الفني أداة، وليس سحراً. أفضل المتداولين يجمعون بين التحليل الفني والأخبار وإدارة المخاطر، لأن كل أداة لوحدها غير كافية.',
  '🔥 الانضباط يصنع الفارق الحقيقي في التداول. سواء كنت رابحاً أم خاسراً، التزم بخطتك ولا تدع المشاعر تتحكم في قراراتك المالية.',
  '📈 الفرق بين السبوت والفيوتشر كبير. في السبوت تمتلك العملة فعلاً، أما في الفيوتشر فأنت تتداول العقود. اختر ما يناسب خبرتك ومستوى مخاطرتك.',
  // نص قصير جداً (يجب أن يُرفض أو يُكمَل)
  'تداول ذكي',
  // نص طويل جداً 
  '🔥 السوق الكريبتو يتحرك بسرعة مذهلة والمتداول الناجح هو من يعرف كيف يقرأ الإشارات ويتصرف بحكمة دون أن يتأثر بالعواطف أو بضغط القرارات السريعة التي كثيراً ما تكلف المتداول خسائر فادحة لا يمكن تعويضها في وقت قصير.',
  // نص يحتوي اقتباسات (يجب تنظيفه)
  '"📊 إدارة المخاطر هي حجر الأساس في التداول المحترف. لا تدخل أي صفقة قبل أن تحدد وقف الخسارة وهدف الربح بدقة، فالخطة الواضحة هي فرقك عن المضارب العشوائي."',
  // نص بعدّاد حروف (يجب تنظيفه)
  '🎯 السيولة العالية في السوق تعني تنفيذاً أسرع وفرقاً أقل بين سعر البيع والشراء. اختر دائماً العملات ذات الحجم التداولي الكبير لتضمن دخولاً وخروجاً سلساً. 185 Chars',
  // Tweet 5:
  'Tweet 5: 💰 متوسط التكلفة DCA من أذكى الاستراتيجيات للمستثمر المبتدئ. بدلاً من الشراء بمبلغ واحد عند سعر واحد، وزّع مشترياتك على فترات زمنية لتقليل تأثير تقلبات السوق.',
];

// ─── session وهمية ────────────────────────────────────────────────────────────
const session = {
  num: 1,
  exactKeys: new Set(),
  tokenSets: [],
  acceptedBodies: [],
};
const accepted = [];
const rejectionLog = {};

console.log('🔬 OFFLINE PIPELINE DIAGNOSTIC');
console.log(`MIN_LEN=${contentEngine.MIN_LEN}  MAX_LEN=${contentEngine.MAX_LEN}`);
console.log(`TCO_URL_LENGTH=${contentEngine.TCO_URL_LENGTH}`);
console.log(`LINK="${LINK}" → counts as ${contentEngine.TCO_URL_LENGTH} chars\n`);

// حساب الطول الكلي للرابط مع سطر جديد
const linkCharCost = LINK ? (1 + contentEngine.TCO_URL_LENGTH) : 0; // \n + t.co
console.log(`Link char cost = ${linkCharCost} (newline + t.co)\n`);

console.log('═'.repeat(70));
console.log('TESTING EACH CORE THROUGH FULL PIPELINE:');
console.log('═'.repeat(70));

for (let idx = 0; idx < MOCK_AI_CORES.length; idx++) {
  const rawCore = MOCK_AI_CORES[idx];
  console.log(`\n[${idx+1}] RAW (${rawCore.length}ch): "${rawCore.slice(0, 70)}…"`);

  // Step 1: cleanCoreText
  const cleanedCore = contentEngine.cleanCoreText(String(rawCore).trim());
  console.log(`     CLEANED (${cleanedCore.length}ch): "${cleanedCore.slice(0, 70)}…"`);

  if (!cleanedCore) {
    console.log('     ❌ REJECTED: فارغ بعد التنظيف');
    rejectionLog['فارغ بعد التنظيف'] = (rejectionLog['فارغ بعد التنظيف']||0)+1;
    continue;
  }

  // Step 2: assembleTweet — try each hashtag count manually
  console.log(`     hasEmoji=${contentEngine.hasEmoji(cleanedCore)}`);

  // Simulate assembleTweet step by step
  const linkPart = LINK ? `\n${LINK}` : '';
  const linkLen  = LINK ? (1 + contentEngine.TCO_URL_LENGTH) : 0;
  const coreLen  = contentEngine.tweetLength(cleanedCore);

  for (const hcount of [2, 3, 1, 4]) {
    // We can't call pickHashtags directly without the length — estimate
    const estTagLen = hcount * 12 + 1; // rough estimate per hashtag
    const estTotal  = coreLen + linkLen + estTagLen;
    console.log(`     [hcount=${hcount}] core=${coreLen} + link=${linkLen} + ~tags=${estTagLen} = ~${estTotal} (need ${contentEngine.MIN_LEN}-${contentEngine.MAX_LEN})`);
  }

  const assembled = contentEngine.assembleTweet(cleanedCore, LINK);
  if (!assembled) {
    console.log(`     ❌ ASSEMBLY FAILED: تعذّر ضبط الطول`);
    console.log(`        core tweetLength=${contentEngine.tweetLength(cleanedCore)}, link="${LINK.slice(0,30)}"`);
    rejectionLog['تعذّر ضبط الطول'] = (rejectionLog['تعذّر ضبط الطول']||0)+1;
    continue;
  }

  console.log(`     ASSEMBLED (${assembled.length}ch): "${assembled.text.slice(0, 80)}…"`);

  // Step 3: validateTweet
  const verdict = contentEngine.validateTweet(assembled.text, LINK);
  if (!verdict.valid) {
    console.log(`     ❌ VALIDATE FAIL: ${verdict.reason}`);
    // Extra: show body for quote check
    const body = contentEngine.bodyOnly(assembled.text);
    console.log(`        BODY: "${body.slice(0, 80)}…"`);
    rejectionLog[verdict.reason] = (rejectionLog[verdict.reason]||0)+1;
    continue;
  }

  // Step 4: dedup
  const dup = contentEngine.isDuplicateInSession(assembled.text, session, 0.85);
  if (dup.dup) {
    const reason = dup.level === 1 ? 'مكرر دقيق' : 'مكرر دلالي';
    console.log(`     ❌ DUP [L${dup.level}]: ${reason}`);
    rejectionLog[reason] = (rejectionLog[reason]||0)+1;
    continue;
  }

  // ACCEPT
  accepted.push({ text: assembled.text, length: assembled.length });
  session.exactKeys.add(contentEngine.exactKey(assembled.text));
  session.tokenSets.push(contentEngine.tokenize(contentEngine.bodyOnly(assembled.text)));
  session.acceptedBodies.push(contentEngine.bodyOnly(assembled.text));
  console.log(`     ✅ ACCEPTED (${assembled.length}ch)`);
}

console.log('\n' + '═'.repeat(70));
console.log('📊 PIPELINE SUMMARY:');
console.log(`   Input cores:  ${MOCK_AI_CORES.length}`);
console.log(`   Accepted:     ${accepted.length}`);
console.log(`   Rejected:     ${MOCK_AI_CORES.length - accepted.length}`);
console.log('   Rejection breakdown:', JSON.stringify(rejectionLog, null, 2));

// ─── اختبار assembleTweet مع قصير جداً ─────────────────────────────────────
console.log('\n' + '═'.repeat(70));
console.log('🔧 ASSEMBLY LENGTH RANGE TEST (no link vs with link):');

const testCore = '📈 السوق يكافئ الصبر لا العجلة';
const assembled_nolink = contentEngine.assembleTweet(testCore, '');
const assembled_link   = contentEngine.assembleTweet(testCore, LINK);
console.log(`Core (${contentEngine.tweetLength(testCore)}ch): "${testCore}"`);
console.log(`  No link → ${assembled_nolink ? assembled_nolink.length + 'ch ✅' : 'FAIL ❌'}`);
console.log(`  With link → ${assembled_link ? assembled_link.length + 'ch ✅' : 'FAIL ❌'}`);

// ─── اختبار validateTweet على نص يحتوي رابط ──────────────────────────────────
console.log('\n' + '═'.repeat(70));
console.log('🔧 VALIDATE TEST — checking link requirement logic:');

if (accepted.length > 0) {
  const sampleText = accepted[0].text;
  const hasLink    = sampleText.includes(LINK);
  console.log(`  Sample tweet contains link: ${hasLink}`);
  console.log(`  LINK used: "${LINK}"`);
  const v = contentEngine.validateTweet(sampleText, LINK);
  console.log(`  Validation result: ${JSON.stringify(v)}`);
}

// ─── اختبار الـ link validation rule بشكل منفصل ────────────────────────────
console.log('\n' + '═'.repeat(70));
console.log('🔧 LINK RULE ISOLATION TEST:');
const dummyTweet = '📈 هذا منشور اختبار للتحقق من قاعدة الرابط في التغريدة المولّدة\n#كريبتو #تداول';
const rWithLink    = contentEngine.validateTweet(dummyTweet, LINK);
const rWithoutLink = contentEngine.validateTweet(dummyTweet, '');
console.log(`  LINK provided, tweet lacks link → ${JSON.stringify(rWithLink)}`);
console.log(`  No link required, tweet fine   → ${JSON.stringify(rWithoutLink)}`);
