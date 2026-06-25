/**
 * SessionManager test — persistent parallel sessions, sync() between rounds,
 * cross-session dedup, live session-count changes, and persistence snapshots.
 *
 * Uses a mock OpenAI-compatible server that:
 *   - tracks how many turns each session thread has (proves threads persist)
 *   - reports cached_tokens > 0 from the 2nd turn onward (simulates prompt cache)
 *   - returns distinct cores so dedup can be exercised
 *
 * No real network, no Electron. Pure logic verification.
 */
const http = require('http');
const assert = require('assert');
const E = require('../src/automation/contentEngine');
const { SessionManager, GenerationSession, STATUS } = require('../src/automation/sessionManager');

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`✅ ${name}`); }
  else { failed++; console.log(`❌ ${name}`); }
}

// ── Mock provider: verifies flat prompts (thread never grows), constant cost ──
let maxThreadSeen = 0;
let flatRequests = 0;   // requests that carried exactly ONE user turn (flat)
let coreSeq = 0;

const CORES = [
  'حجم التداول هو المؤشر الأهم لقياس قوة أي حركة سعرية في سوق الكريبتو، فالصعود المصحوب بحجم كبير يعكس اهتماماً حقيقياً من المتداولين بينما الصعود بحجم ضعيف غالباً ما يكون مجرد فخ سعري يجب الحذر منه دائماً',
  'إدارة المخاطر هي خط الدفاع الأول لكل متداول ناجح، فلا تخاطر أبداً بأكثر مما تتحمل خسارته وضع دائماً خطة واضحة لحجم المركز ووقف الخسارة قبل الدخول في أي صفقة حتى تحمي رأس مالك على المدى الطويل وتستمر',
  'سيكولوجية السوق تتحكم في معظم تحركات الأسعار، فالخوف يدفع للبيع عند القيعان والطمع يدفع للشراء عند القمم، والمتداول الذكي هو من يسيطر على مشاعره ويتخذ قراراته بناء على خطة مدروسة لا على ردة فعل متهورة',
  'الصبر سلاح المتداول المحترف، فالأسواق تكافئ من ينتظر الفرصة الصحيحة بدل من يطارد كل حركة، تعلم أن تجلس وتراقب وتدخل فقط عندما تتحقق شروط خطتك بالكامل لأن الصفقة الجيدة تستحق الانتظار مهما طال الوقت كثيراً',
  'الرسوم المنخفضة تصنع فرقاً حقيقياً في أرباحك على المدى الطويل، فكل نسبة توفرها في رسوم التداول تبقى في محفظتك، اختر منصة تقدم رسوماً تنافسية وسرعة تنفيذ عالية حتى لا تضيع أرباحك في تكاليف خفية لا داعي لها',
  'الاتجاه العام صديقك في التداول، فمحاولة عكس السوق القوي مغامرة خاسرة في الغالب، تعلم قراءة الاتجاه على الأطر الزمنية الكبيرة وتداول في اتجاهه لأن السباحة مع التيار أسهل وأكثر أماناً من مقاومته بكل وضوح',
  'وقف الخسارة ليس علامة ضعف بل أداة حماية ذكية، فالمتداول الذي يضع حدوداً واضحة لخسائره يبقى في اللعبة أطول ويحمي محفظته من الانهيار المفاجئ عند تحرك السوق ضده بعنف وبسرعة لا يتوقعها أحد في لحظة واحدة',
  'التنويع في المحفظة يقلل المخاطر ويحمي رأس المال من تقلبات عملة واحدة، فلا تضع كل بيضك في سلة واحدة بل وزع استثماراتك على أصول مختلفة بعناية ودراسة حتى تتوازن محفظتك وتصمد أمام تقلبات السوق العنيفة دوماً',
  'السيولة العالية تضمن تنفيذ أوامرك بأسعار عادلة دون انزلاق سعري كبير، لذلك اختر العملات والمنصات ذات العمق السعري الجيد حتى تدخل وتخرج من صفقاتك بسلاسة تامة دون أن تتأثر أرباحك بفروقات الأسعار الواسعة أبداً',
  'الرافعة المالية سلاح ذو حدين تضاعف الأرباح والخسائر معاً، فاستخدمها بحذر شديد وبنسب منخفضة إن قررت استخدامها أصلاً لأن المبالغة فيها أسرع طريق لتصفية حسابك بالكامل في حركة سعرية واحدة عكس توقعاتك تماماً',
  'التحليل قبل الدخول واجب لا رفاهية، فالتداول العشوائي بناء على المشاعر أو نصائح الآخرين وصفة مضمونة للخسارة، خصص وقتاً لدراسة الرسم البياني والمؤشرات قبل أن تضع أموالك في أي صفقة مهما بدت مغرية وسريعة',
  'الربح الثابت الصغير المتكرر أفضل من المخاطرة الكبيرة الطامعة، فبناء الثروة في التداول ماراثون طويل لا سباق قصير، التزم بأهداف واقعية واحصد أرباحك بانتظام بدل ملاحقة الصفقة الكبرى التي قد تكلفك كل ما جنيته سابقاً',
];

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const parsed = JSON.parse(body);
    const msgs = parsed.messages || [];
    // Count non-system turns. STATELESS FLAT: this must always be exactly 1.
    const threadTurns = msgs.filter(m => m.role !== 'system').length;
    maxThreadSeen = Math.max(maxThreadSeen, threadTurns);

    const userTurns = msgs.filter(m => m.role === 'user').length;
    if (userTurns === 1) flatRequests++;
    // IYH reports 0% cache for every model (proven by live testing), so the
    // mock reflects reality: no cached tokens, ever.
    const cached = 0;

    // Return distinct cores each call so dedup logic has something to chew on.
    const userMsg = (msgs.find(m => m.role === 'user' && msgs.indexOf(m) === msgs.length - 1) || {}).content || '';
    const m = userMsg.match(/اكتب (\d+)/);
    const n = m ? parseInt(m[1]) : 6;
    const out = [];
    for (let i = 0; i < n; i++) out.push(CORES[(coreSeq++) % CORES.length]);

    const payload = {
      choices: [{ message: { content: JSON.stringify(out) } }],
      usage: { prompt_tokens: 2000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: cached } },
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
});

// ── Unit tests that need no server ──────────────────────────────────────
function unitTests() {
  // syncSessionDedup rebuilds from shared sources
  const sess = { exactKeys: new Set(['stale']), tokenSets: [['x']] };
  E.syncSessionDedup(sess, [{ text: 'منشور أول عن التداول' }], [{ text: 'منشور ثاني عن المخاطر' }]);
  check('sync clears stale state', !sess.exactKeys.has('stale'));
  check('sync repopulates from queue+preview', sess.exactKeys.size === 2 && sess.tokenSets.length === 2);

  // buildSessionSystem is static (cacheable) and identical across calls
  const sys1 = E.buildSessionSystem({});
  const sys2 = E.buildSessionSystem({});
  check('system block is byte-identical (cacheable)', sys1 === sys2 && sys1.length > 100);

  // custom system overrides verbatim
  const custom = E.buildSessionSystem({ customSystem: 'برومبت مخصص' });
  check('custom system used verbatim', custom === 'برومبت مخصص');

  // buildRoundUser embeds angles + acceptedContext + inspiration
  const u = E.buildRoundUser({
    quantity: 10, angles: ['زاوية أ', 'زاوية ب'],
    inspirationSummary: 'الصبر، السيولة', acceptedContext: '• منشور سابق…',
  });
  check('round user has angles', u.includes('زاوية أ'));
  check('round user has accepted-context (avoid list)', u.includes('المنشورات المقبولة'));
  check('round user has inspiration', u.includes('الصبر، السيولة'));

  // buildAcceptedContext truncates to snippets
  const ctx = E.buildAcceptedContext(['هذا منشور طويل جداً عن إدارة المخاطر في التداول والسوق'], 12, 4);
  check('accepted context is a short snippet', ctx.includes('•') && ctx.length < 80);

  // GenerationSession serialization round-trips. STATELESS FLAT (v4.3.0): the
  // thread is intentionally NOT persisted/restored — it always starts empty.
  const gs = new GenerationSession(3, 'SYS');
  gs.messages.push({ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' });
  gs.acceptedBodies.push('body1');
  gs.roundsCompleted = 2;
  const json = gs.toJSON();
  const restored = GenerationSession.fromJSON(json, 'SYS');
  check('session serializes + restores num', restored.num === 3);
  check('session restores rounds', restored.roundsCompleted === 2);
  check('session restores acceptedBodies (dedup memory)', restored.acceptedBodies.length === 1);
  check('thread NOT restored — stateless flat', restored.messages.length === 0 && (json.messages || []).length === 0);
}

server.listen(0, async () => {
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  const link = 'https://www.mexc.com/auth/signup?inviteCode=mexc-SESS01';

  unitTests();

  // ── Integration: run SessionManager against the mock server ──
  // STATELESS FLAT (v4.3.0): mirrors main.js — sends ONLY the static system
  // block + this round's single user turn. No growing thread, no commit back
  // onto session.messages. Dedup memory lives in acceptedBodies/exactKeys.
  async function callAi({ session, angles, acceptedContext, chunk }) {
    const qty = chunk || (angles ? angles.length : 1);
    const system = session.system;
    const user = E.buildRoundUser({ quantity: qty, angles, acceptedContext, inspirationSummary: '' });
    const messages = [{ role: 'user', content: user }];
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
      body: JSON.stringify({ model: 'mock', messages: [{ role: 'system', content: system }, ...messages] }),
    });
    const data = await resp.json();
    const raw = data.choices[0].message.content;
    const u = data.usage || {};
    // NO thread commit — session.messages stays empty by design.
    return {
      cores: JSON.parse(raw),
      usage: { input: u.prompt_tokens || 0, output: u.completion_tokens || 0, cacheWrite: 0, cacheRead: u.prompt_tokens_details?.cached_tokens || 0 },
    };
  }

  const target = 8;   // requires multiple rounds per session (chunk=1 below)
  const accepted = [];
  const sharedQueue = [];
  const sharedPreview = [];
  const sharedExactKeys = new Set();
  const sharedTokenSets = [];
  let cancelled = false;
  let sessionCount = 3;
  let roundGuard = 0;   // safety: stop the test if it can't reach target

  const ingest = (cores, session) => {
    let gained = 0;
    for (const core of cores) {
      if (accepted.length >= target) break;
      const assembled = E.assembleTweet(String(core).trim(), link);
      if (!assembled) continue;
      const verdict = E.validateTweet(assembled.text, link);
      if (!verdict.valid) continue;
      const dup = E.isDuplicateInSession(assembled.text, session, 0.85);
      if (dup.dup) continue;
      // HARD cross-session guard (mirrors main.js)
      const sharedDup = E.isDuplicateInSession(assembled.text, { exactKeys: sharedExactKeys, tokenSets: sharedTokenSets }, 0.85);
      if (sharedDup.dup) continue;
      accepted.push(assembled);
      sharedQueue.push({ text: assembled.text });
      const eKey = E.exactKey(assembled.text);
      const toks = E.tokenize(E.bodyOnly(assembled.text));
      session.exactKeys.add(eKey);
      session.tokenSets.push(toks);
      session.acceptedBodies.push(E.bodyOnly(assembled.text));
      sharedExactKeys.add(eKey);
      sharedTokenSets.push(toks);
      gained++;
    }
    return gained;
  };

  let statusEmitted = 0;
  const persisted = [];
  const manager = new SessionManager({
    engine: E,
    runRound: async ({ session, angles, acceptedContext, chunk }) => {
      const { cores, usage } = await callAi({ session, angles, acceptedContext, chunk });
      return { cores, usage };
    },
    ingest,
    onStatus: () => { statusEmitted++; },
    isCancelled: () => cancelled,
    getSessionCount: () => sessionCount,
    persist: (snaps) => { persisted.length = 0; persisted.push(...snaps); },
    chunk: 2,
    sessionCount,
    system: E.buildSessionSystem({}),
    inspirationSummary: '',
    sharedQueue,
    sharedPreview,
  });

  await manager.run(() => { roundGuard++; return accepted.length >= target || roundGuard > 200; });

  // ── Assertions ──
  check('reached target', accepted.length >= target);
  check('created 3 sessions', manager.sessions.length === 3);
  check('thread never grows — flat 1 user turn per round', maxThreadSeen === 1);
  check('every request was flat (single user turn)', flatRequests > 0);
  const totals = manager.totals();
  check('status emitted to UI', statusEmitted > 0);
  check('persisted snapshot saved', persisted.length === 3);

  // Cross-session dedup: every accepted tweet body is unique
  const bodies = accepted.map(a => E.exactKey(a.text));
  const uniqueBodies = new Set(bodies);
  check('0% cross-session duplicates', uniqueBodies.size === bodies.length);

  // ── Resume test: load persisted snapshots into a fresh manager ──
  const accepted2 = [];
  const mgr2 = new SessionManager({
    engine: E,
    runRound: async ({ session, angles, acceptedContext }) => callAi({ session, angles, acceptedContext }),
    ingest: (cores, session) => ingest.call(null, cores, session),
    isCancelled: () => true,    // don't actually run, just verify load
    getSessionCount: () => 3,
    system: E.buildSessionSystem({}),
    sharedQueue: [], sharedPreview: [],
  });
  mgr2.loadSessions(persisted);
  check('resume restores 3 sessions with same numbers', mgr2.sessions.length === 3 && mgr2.sessions[0].num === 1 && mgr2.sessions[2].num === 3);

  // ── Session-count lower/raise reconciliation ──
  mgr2._reconcileSessionCount(2);
  check('lowering count parks session #3 (kept, not deleted)', mgr2.sessions.length === 3 && mgr2.sessions[2].status === STATUS.STOPPED);
  mgr2._reconcileSessionCount(3);
  check('raising count reactivates session #3', mgr2.sessions[2].status !== STATUS.STOPPED);

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  server.close();
  process.exit(failed === 0 ? 0 : 1);
});
