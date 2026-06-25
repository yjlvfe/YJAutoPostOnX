/**
 * LIVE session-cache test — proves the NEW persistent-session architecture
 * makes prompt caching actually fire (cache_read > 0 from round 2) against a
 * real provider (IYH / Claude-class).
 *
 * Runs the REAL SessionManager with a thin callAi that mirrors src/main.js:
 * each round appends a user turn onto the SAME thread and sends the full
 * conversation, so the static system prefix is re-served from cache.
 *
 * Usage:
 *   IYH_KEY=$IYH_API_KEY IYH_BASE=https://v1.iyhapi.app IYH_MODEL=claude-opus-4.8 \
 *   TARGET=8 SESSIONS=2 node test/live-session-cache.test.js
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const TMP_HISTORY = path.join(os.tmpdir(), `xposter_sesscache_${Date.now()}.json`);
process.env.XPOSTER_HISTORY_PATH = TMP_HISTORY;

const E = require('../src/automation/contentEngine');
const { SessionManager } = require('../src/automation/sessionManager');

const KEY = process.env.IYH_KEY || process.env.IYH_API_KEY;
const BASE = process.env.IYH_BASE || 'https://v1.iyhapi.app';
const MODEL = process.env.IYH_MODEL || 'claude-opus-4.8';
const TARGET = parseInt(process.env.TARGET || '8', 10);
const SESSIONS = parseInt(process.env.SESSIONS || '2', 10);
const LINK = process.env.IYH_LINK || 'https://www.mexc.com/auth/signup?inviteCode=mexc-SESS01';
const CHUNK = parseInt(process.env.CHUNK || '4', 10);
if (!KEY) { console.error('IYH_KEY / IYH_API_KEY required'); process.exit(2); }

// ── HTTP helpers (mirror src/main.js buildAiRequest / readUsage) ─────────
function buildReq(provider, { system, messages, maxTokens }) {
  const base = BASE.replace(/\/+$/, '');
  if (provider === 'anthropic') {
    let endpoint;
    if (/\/v1\/messages$/.test(base)) endpoint = base;
    else endpoint = `${base.replace(/\/v1$/, '')}/v1/messages`;
    return {
      endpoint,
      headers: { 'Content-Type': 'application/json', 'x-api-key': KEY, 'Authorization': `Bearer ${KEY}`, 'anthropic-version': '2023-06-01' },
      body: { model: MODEL, max_tokens: maxTokens || 2500, temperature: 1.0,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages },
    };
  }
  const endpoint = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
  return {
    endpoint,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KEY}` },
    body: { model: MODEL, messages: [{ role: 'system', content: system }, ...messages], max_tokens: maxTokens || 2500, temperature: 1.0 },
  };
}
function extractText(provider, data) {
  if (provider === 'anthropic') return (data.content || []).map(c => c.text || '').join('\n');
  return data?.choices?.[0]?.message?.content || '';
}
function readUsage(provider, data) {
  const u = data?.usage || {};
  if (provider === 'anthropic') return { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0 };
  const cached = u.prompt_tokens_details?.cached_tokens || 0;
  return { input: u.prompt_tokens || 0, output: u.completion_tokens || 0, cacheWrite: 0, cacheRead: cached };
}
function parseArr(raw) {
  if (!raw) return [];
  let t = raw.trim().replace(/```(?:json)?/gi, '').trim();
  try { const a = JSON.parse(t); if (Array.isArray(a)) return a.filter(x => typeof x === 'string' && x.trim()); } catch {}
  const s = t.indexOf('['), e = t.lastIndexOf(']');
  if (s !== -1 && e > s) { try { const a = JSON.parse(t.slice(s, e + 1)); if (Array.isArray(a)) return a.filter(x => typeof x === 'string' && x.trim()); } catch {} }
  return t.split('\n').map(l => l.replace(/^[\s\-*\d.)\]]+\s*/, '').trim()).filter(l => l.length > 40);
}

const provider = E.detectProvider(BASE, 'auto', MODEL);
const link = LINK;

async function callAi({ session, angles, acceptedContext }) {
  const system = session.system;
  const user = E.buildRoundUser({ quantity: CHUNK, angles, acceptedContext, inspirationSummary: '' });
  const messages = [...session.messages, { role: 'user', content: user }];
  const req = buildReq(provider, { system, messages, maxTokens: 2500 });
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), 120000);
  try {
    const r = await fetch(req.endpoint, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: controller.signal });
    if (!r.ok) { const tx = await r.text().catch(() => ''); throw new Error(`HTTP ${r.status}: ${tx.slice(0, 200)}`); }
    const data = await r.json();
    const raw = extractText(provider, data);
    // commit onto persistent thread
    session.messages.push({ role: 'user', content: user });
    session.messages.push({ role: 'assistant', content: raw });
    if (session.messages.length > 16) session.messages = session.messages.slice(-16);
    return { cores: parseArr(raw), usage: readUsage(provider, data) };
  } finally { clearTimeout(to); }
}

(async () => {
  console.log(`PROVIDER=${provider} MODEL=${MODEL} TARGET=${TARGET} SESSIONS=${SESSIONS} CHUNK=${CHUNK}`);
  const accepted = [];
  const sharedQueue = [], sharedPreview = [];
  const sharedExactKeys = new Set(), sharedTokenSets = [];
  let roundGuard = 0;

  const ingest = (cores, session) => {
    let gained = 0;
    for (const core of (cores || [])) {
      if (accepted.length >= TARGET) break;
      const c = E.cleanCoreText(String(core || '').trim());
      if (!c) continue;
      const a = E.assembleTweet(c, link);
      if (!a) continue;
      if (!E.validateTweet(a.text, link).valid) continue;
      if (E.isDuplicateInSession(a.text, session, 0.85).dup) continue;
      if (E.isDuplicateInSession(a.text, { exactKeys: sharedExactKeys, tokenSets: sharedTokenSets }, 0.85).dup) continue;
      accepted.push(a);
      sharedQueue.push({ text: a.text });
      const k = E.exactKey(a.text), tk = E.tokenize(E.bodyOnly(a.text));
      session.exactKeys.add(k); session.tokenSets.push(tk); session.acceptedBodies.push(E.bodyOnly(a.text));
      sharedExactKeys.add(k); sharedTokenSets.push(tk);
      gained++;
    }
    return gained;
  };

  const mgr = new SessionManager({
    engine: E,
    runRound: async ({ session, angles, acceptedContext }) => callAi({ session, angles, acceptedContext }),
    ingest,
    onStatus: (snap, totals) => {
      console.log(`  status: ${snap.map(s => `#${s.num}:${s.status}(${s.rounds}r,${s.accepted}✅)`).join(' ')} | cache ${totals.cacheHitPct}%`);
    },
    isCancelled: () => false,
    getSessionCount: () => SESSIONS,
    persist: () => {},
    chunk: CHUNK,
    sessionCount: SESSIONS,
    system: E.buildSessionSystem({}),
    inspirationSummary: '',
    sharedQueue, sharedPreview,
  });

  const t0 = Date.now();
  await mgr.run(() => { roundGuard++; return accepted.length >= TARGET || roundGuard > 5000; });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  const totals = mgr.totals();
  console.log('\n================ SUMMARY ================');
  console.log(`accepted     : ${accepted.length}/${TARGET}`);
  console.log(`rounds       : ${totals.rounds}`);
  console.log(`api calls    : ${totals.calls}`);
  console.log(`tokens IN    : ${totals.input + totals.cacheRead + totals.cacheWrite} (prompt ${totals.input}, cacheRead ${totals.cacheRead}, cacheWrite ${totals.cacheWrite})`);
  console.log(`tokens OUT   : ${totals.output}`);
  console.log(`CACHE HIT %  : ${totals.cacheHitPct}%`);
  console.log(`elapsed      : ${secs}s`);
  const bodies = accepted.map(a => E.exactKey(a.text));
  console.log(`unique posts : ${new Set(bodies).size}/${bodies.length} (0 dup = ${new Set(bodies).size === bodies.length})`);
  console.log('=========================================');

  // ACCEPTANCE: cache_read must be > 0 once threads have a 2nd round.
  const ok = totals.cacheRead > 0 && new Set(bodies).size === bodies.length;
  console.log(ok ? '\n✅ ACCEPTANCE MET: cache_read > 0 AND 0% duplicates' : '\n❌ ACCEPTANCE FAILED');
  try { fs.unlinkSync(TMP_HISTORY); } catch {}
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
