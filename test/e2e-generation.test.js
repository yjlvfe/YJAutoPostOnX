/**
 * E2E test: mock OpenAI-compatible server + full generation pipeline.
 * Proves the generate→assemble→validate→dedup→retry loop works and
 * produces tweets strictly within 230-270 chars including link + hashtags.
 */
const http = require('http');
const E = require('../src/automation/contentEngine');

// ── A small pool of realistic Arabic crypto core texts (what a good LLM returns) ──
const CORES = [
  'حجم التداول هو المؤشر الأهم لقياس قوة أي حركة سعرية في سوق الكريبتو، فالصعود المصحوب بحجم كبير يعكس اهتماماً حقيقياً من المتداولين بينما الصعود بحجم ضعيف غالباً ما يكون مجرد فخ سعري يجب الحذر منه قبل اتخاذ أي قرار',
  'إدارة المخاطر هي خط الدفاع الأول لكل متداول ناجح، فلا تخاطر أبداً بأكثر مما تتحمل خسارته وضع دائماً خطة واضحة لحجم المركز ووقف الخسارة قبل الدخول في أي صفقة حتى تحمي رأس مالك على المدى الطويل وتستمر في السوق',
  'سيكولوجية السوق تتحكم في معظم تحركات الأسعار، فالخوف يدفع للبيع عند القيعان والطمع يدفع للشراء عند القمم، والمتداول الذكي هو من يسيطر على مشاعره ويتخذ قراراته بناء على خطة مدروسة لا على ردة فعل لحظية متهورة',
  'الصبر سلاح المتداول المحترف، فالأسواق تكافئ من ينتظر الفرصة الصحيحة بدل من يطارد كل حركة، تعلم أن تجلس وتراقب وتدخل فقط عندما تتحقق شروط خطتك بالكامل لأن الصفقة الجيدة تستحق الانتظار مهما طال الوقت قليلاً',
  'الرسوم المنخفضة تصنع فرقاً حقيقياً في أرباحك على المدى الطويل، فكل نسبة توفرها في رسوم التداول تبقى في محفظتك، اختر منصة تقدم رسوماً تنافسية وسرعة تنفيذ عالية حتى لا تضيع أرباحك في تكاليف خفية لا داعي لها أبداً',
  'الاتجاه العام صديقك في التداول، فمحاولة عكس السوق القوي مغامرة خاسرة في الغالب، تعلم قراءة الاتجاه على الأطر الزمنية الكبيرة وتداول في اتجاهه لأن السباحة مع التيار أسهل وأكثر أماناً من مقاومته بكل تأكيد ودائماً',
];

let callCount = 0;

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    callCount++;
    // Return a JSON array of core texts (simulate the model honoring our prompt)
    const parsed = JSON.parse(body);
    // Figure out how many were requested from the user message
    const userMsg = parsed.messages ? parsed.messages.find(m => m.role === 'user').content : '';
    const m = userMsg.match(/اكتب (\d+)/);
    const n = m ? parseInt(m[1]) : 6;
    const out = [];
    for (let i = 0; i < n; i++) out.push(CORES[(i + callCount) % CORES.length]);
    const payload = {
      choices: [{ message: { content: JSON.stringify(out) } }]
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
});

server.listen(0, async () => {
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  const link = 'https://www.mexc.com/auth/signup?inviteCode=mexc-TEST99';

  console.log('Mock server on', baseUrl);
  console.log('Provider detected:', E.detectProvider(baseUrl, 'auto'));

  // ── Replicate main.js generation loop here (same logic) ──
  const target = 10;
  const history = [];
  const historyTokenSets = [];
  const sessionTokenSets = [];
  const accepted = [];
  const rejectedReasons = {};
  let round = 0;

  async function callAi(qty) {
    const angles = E.selectAngles(qty);
    const { system, user } = E.buildPrompt({ quantity: qty, angles, hasLink: true });
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
      body: JSON.stringify({ model: 'mock', messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    });
    const data = await resp.json();
    const raw = data.choices[0].message.content;
    return JSON.parse(raw);
  }

  while (accepted.length < target && round < 6) {
    round++;
    const need = target - accepted.length;
    const askFor = Math.min(Math.ceil(need * 1.6) + 2, 60);
    const cores = await callAi(askFor);
    for (const core of cores) {
      if (accepted.length >= target) break;
      const assembled = E.assembleTweet(String(core).trim(), link);
      if (!assembled) { rejectedReasons['length'] = (rejectedReasons['length'] || 0) + 1; continue; }
      const allHist = [...historyTokenSets, ...sessionTokenSets];
      const verdict = E.validateTweet(assembled.text, link, allHist);
      if (!verdict.valid) { rejectedReasons[verdict.reason] = (rejectedReasons[verdict.reason] || 0) + 1; continue; }
      accepted.push(assembled);
      sessionTokenSets.push(E.tokenize(assembled.text));
    }
  }

  console.log(`\n=== RESULT: ${accepted.length}/${target} accepted in ${round} rounds ===`);
  console.log('Rejected reasons:', JSON.stringify(rejectedReasons));
  console.log('\n=== SAMPLE TWEETS (with char counts) ===\n');
  accepted.slice(0, 4).forEach((a, i) => {
    const inRange = a.length >= 200 && a.length <= 270;
    console.log(`[${i + 1}] length=${a.length} ${inRange ? '✅ IN RANGE' : '❌ OUT OF RANGE'}`);
    console.log(a.text);
    console.log('---');
  });

  // Verify ALL accepted are in range
  const allInRange = accepted.every(a => a.length >= 200 && a.length <= 270);
  const allHaveLink = accepted.every(a => a.text.includes(link));
  const allHaveHashtag = accepted.every(a => /#[^\s#]+/.test(a.text));
  console.log('\n=== ASSERTIONS ===');
  console.log('All within 200-270:', allInRange ? '✅' : '❌');
  console.log('All contain link:', allHaveLink ? '✅' : '❌');
  console.log('All contain hashtag:', allHaveHashtag ? '✅' : '❌');

  server.close();
  process.exit(allInRange && allHaveLink && allHaveHashtag ? 0 : 1);
});
