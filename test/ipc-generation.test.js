/**
 * IPC integration test: boots the REAL app (main.js), spins up a mock
 * OpenAI-compatible AI server, then invokes the actual generate-ai-posts
 * IPC handler through window.api (exactly as the UI button does).
 * Proves the entire wired path end-to-end.
 */
const http = require('http');
const { app } = require('electron');

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

let calls = 0;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    calls++;
    const parsed = JSON.parse(body);
    const userMsg = (parsed.messages || []).find(m => m.role === 'user');
    const m = userMsg && userMsg.content.match(/اكتب (\d+)/);
    const n = m ? parseInt(m[1]) : 6;
    const out = [];
    for (let i = 0; i < n; i++) out.push(CORES[(i + calls) % CORES.length]);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }] }));
  });
});

require('../dev/main.js');

let errors = [];
let done = false;
function finish() {
  if (done) return; done = true;
  try { server.close(); } catch {}
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
      await new Promise(r => setTimeout(r, 1500));
      const port = server.address().port;
      const baseUrl = `http://127.0.0.1:${port}/v1`;
      const link = 'https://www.mexc.com/auth/signup?inviteCode=mexc-INT01';

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
            referralLink: ${JSON.stringify(link)},
          });
          return { r, progressCount: window.__prog.length };
        })()
      `);

      const r = result.r;
      if (!r.success) { errors.push('handler returned failure: ' + r.error); return finish(); }
      if (r.provider !== 'openai') errors.push('provider mismatch: ' + r.provider);
      if (!Array.isArray(r.posts) || r.posts.length === 0) errors.push('no posts returned');
      if (result.progressCount === 0) errors.push('no progress events received');

      // Validate every returned tweet
      const tweetLength = (t) => {
        const urls = t.match(/https?:\/\/[^\s]+/g) || [];
        return [...t.replace(/https?:\/\/[^\s]+/g, '')].length + urls.length * 23;
      };
      for (const p of r.posts) {
        const len = tweetLength(p);
        if (len < 230 || len > 270) errors.push(`tweet out of range: ${len}`);
        if (!p.includes(link)) errors.push('tweet missing link');
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

server.listen(0, () => {
  // server ready; main.js will create the window
});

setTimeout(() => { errors.push('TIMEOUT'); finish(); }, 25000);
