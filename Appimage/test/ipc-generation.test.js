/**
 * IPC integration test: boots the REAL app (main.js), uses an in-memory
 * OpenAI-compatible transport fixture, then invokes the actual generate-ai-posts
 * IPC handler through window.api (exactly as the UI button does).
 * Proves the wired path without opening any provider or local HTTP socket.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const SANDBOX = path.resolve(os.tmpdir(), `xposter-ipc-generation-${process.pid}-${Date.now()}`);
os.homedir = () => SANDBOX;
// Belt-and-suspenders: os.homedir() itself reads process.env.HOME live, so
// setting this too means isolation doesn't depend solely on every caller
// having picked up the monkey-patched function reference (module-load
// ordering, a require() that ran before this line, etc.).
process.env.HOME = SANDBOX;
process.env.USERPROFILE = SANDBOX;
process.env.XDG_CONFIG_HOME = path.join(SANDBOX, '.config');
process.env.XDG_CACHE_HOME = path.join(SANDBOX, '.cache');
fs.mkdirSync(SANDBOX, { recursive: true });
process.on('exit', () => { try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {} });
const { app, session } = require('electron');
app.setPath('userData', path.join(SANDBOX, 'userData'));

// Realistic Arabic crypto cores a good model would return
const CORES = [
  'حجم التداول هو المؤشر الأهم لقياس قوة أي حركة سعرية في سوق الكريبتو، فالصعود المصحوب بحجم كبير يعكس اهتماماً حقيقياً من المتداولين بينما الصعود بحجم ضعيف غالباً يكون مجرد فخ سعري يستوجب الحذر الشديد قبل القرار',
  'إدارة المخاطر هي خط الدفاع الأول لكل متداول ناجح، فلا تخاطر أبداً بأكثر مما تتحمل خسارته وضع دائماً خطة واضحة لحجم المركز ووقف الخسارة قبل الدخول في أي صفقة حتى تحمي رأس مالك على المدى الطويل وتبقى قوياً',
  'سيكولوجية السوق تتحكم في معظم التحركات، فالخوف يدفع للبيع عند القيعان والطمع يدفع للشراء عند القمم، والمتداول الذكي من يسيطر على مشاعره ويتخذ قراراته وفق خطة مدروسة لا وفق ردة فعل لحظية متهورة تضر بمحفظته كثيراً',
  'الصبر سلاح المتداول المحترف، فالأسواق تكافئ من ينتظر الفرصة الصحيحة بدل من يطارد كل حركة، تعلم أن تجلس وتراقب وتدخل فقط حين تتحقق شروط خطتك بالكامل لأن الصفقة الجيدة دوماً تستحق الانتظار مهما طال الوقت أمامك',
  'الرسوم المنخفضة تصنع فرقاً حقيقياً في أرباحك على المدى الطويل، فكل نسبة توفرها في رسوم التداول تبقى داخل محفظتك، اختر منصة تقدم رسوماً تنافسية وسرعة تنفيذ عالية كي لا تتبخر أرباحك في تكاليف خفية لا فائدة منها',
  'الاتجاه العام صديقك في التداول، فمحاولة عكس السوق القوي مغامرة خاسرة غالباً، تعلم قراءة الاتجاه على الأطر الزمنية الكبيرة وتداول في اتجاهه لأن السباحة مع التيار أسهل وأكثر أماناً من مقاومته العنيدة على الدوام تماماً',
];
// Isolate from prior runs: clear the persistent de-dup history so the
// mock cores aren't rejected as "similar to a previous tweet". The engine's
// cross-batch de-dup is verified separately in e2e-generation.test.js.
(() => {
  try {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const hp = path.join(os.homedir(), '.config', 'x-poster-bot-profile', 'generated_history.json');
    if (fs.existsSync(hp)) fs.unlinkSync(hp);
  } catch { /* best-effort */ }
})();

const LINK = 'https://www.mexc.com/auth/signup?inviteCode=mexc-INT01';
const LEGACY_LINK = 'https://referral.invalid/legacy-not-appended';
const CUSTOM_PROMPT = `اكتب منشورات عربية مكتملة مع هاشتاق #تداول ثم الرابط ${LINK}. أعد مصفوفة JSON فقط.`;
let calls = 0;
let nextCore = 0;
const generationRequests = [];
global.fetch = async (url, options) => {
  if (!String(url).startsWith('https://fixture.invalid/')) throw new Error('NETWORK_FORBIDDEN');
  calls++;
  const parsed = JSON.parse(options.body);
  const messages = parsed.messages || [];
  const isJudge = messages.some(m => m.role === 'system' && String(m.content).includes('محكم دلالي'));
  let content;
  if (isJudge) {
    content = JSON.stringify({ duplicate: false, matched_index: null, reason: 'distinct fixture topics' });
  } else {
    generationRequests.push(parsed);
    const userMsg = messages.filter(m => m.role === 'user').at(-1);
    const m = userMsg && userMsg.content.match(/اكتب (\d+)/);
    const n = m ? parseInt(m[1]) : 6;
    const out = [];
    for (let i = 0; i < n; i++) {
      const core = CORES[nextCore++ % CORES.length];
      out.push(`${core} #تداول\n${LINK}`);
    }
    content = JSON.stringify(out);
  }
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
};

require('../dev/main.js');

let errors = [];
let done = false;
function finish() {
  if (done) return; done = true;
  if (errors.length === 0) {
    console.log('✅ IPC INTEGRATION PASSED — generate-ai-posts produced valid tweets through the real handler.');
    app.exit(0);
  } else {
    console.log('❌ IPC INTEGRATION FAILED:');
    errors.forEach(e => console.log('  - ' + e));
    app.exit(1);
  }
}

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('did-finish-load', async () => {
    try {
      const baseUrl = 'https://fixture.invalid/v1';
      const link = LINK;

      const result = await win.webContents.executeJavaScript(`
        (async () => {
          // attach a progress collector
          window.__prog = [];
          window.api.onAiProgress(m => window.__prog.push(m.message));
          const r = await window.api.generateAiPosts({
            apiKey: 'test-key',
            baseUrl: ${JSON.stringify(baseUrl)},
            model: 'mock-model',
            providerOverride: 'auto',
            quantity: 5,
            sessionCount: 1,
            promptMode: 'custom',
            customPrompt: ${JSON.stringify(CUSTOM_PROMPT)},
            referralLink: ${JSON.stringify(LEGACY_LINK)},
          });
          return { r, progressCount: window.__prog.length };
        })()
      `);

      const r = result.r;
      if (!r.success) { errors.push('handler returned failure: ' + r.error); return finish(); }
      if (r.provider !== 'openai') errors.push('provider mismatch: ' + r.provider);
      if (!Array.isArray(r.posts) || r.posts.length !== 5) errors.push('expected exactly 5 posts');
      if (!generationRequests.length || generationRequests.some(request =>
        !request.messages.some(m => m.role === 'system' && m.content === CUSTOM_PROMPT))) {
        errors.push('custom prompt did not reach the provider unchanged');
      }
      if (generationRequests.some(request => JSON.stringify(request.messages).includes(LEGACY_LINK))) {
        errors.push('legacy referralLink leaked into the provider prompt');
      }
      if (result.progressCount === 0) errors.push('no progress events received');

      // Validate every returned tweet
      const tweetLength = (t) => {
        const urls = t.match(/https?:\/\/[^\s]+/g) || [];
        return [...t.replace(/https?:\/\/[^\s]+/g, '')].length + urls.length * 23;
      };
      for (const p of r.posts) {
        const len = tweetLength(p);
        if (len < 230 || len > 270) errors.push(`tweet out of range: ${len}`);
        if (!p.includes(link)) errors.push('tweet missing custom-prompt-owned link');
        if (p.includes(LEGACY_LINK)) errors.push('legacy referralLink was automatically appended');
        if (!CORES.some(core => p === `${core} #تداول\n${LINK}`)) errors.push('custom output was rewritten');
        if (!/#[^\s#]+/.test(p)) errors.push('tweet missing hashtag');
      }

      console.log(`   → handler returned ${r.posts.length} tweets, ${result.progressCount} progress events`);
      if (r.posts[0]) {
        console.log('   → sample (' + tweetLength(r.posts[0]) + ' chars):');
        console.log('     ' + r.posts[0].replace(/\n/g, ' | '));
      }
    } catch (e) {
      errors.push('EXEC ERROR: ' + e.message);
    }
    finish();
  });
});

app.whenReady().then(() => {
  // Renderer assets may only be local; the main-process fixture is in memory.
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !/^(file:|data:)/.test(details.url) });
  });
});

setTimeout(() => { errors.push(`TIMEOUT (provider calls=${calls}, generation requests=${generationRequests.length})`); finish(); }, 35000);
