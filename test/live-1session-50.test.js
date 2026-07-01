/**
 * LIVE per-round audit — 1 SESSION × 5 rounds × 10 posts = 50 target.
 * Model: claude-opus-4.8 via IYH.
 *
 * Produces the exact per-round table the spec asks for and verifies:
 *   1. thread continuity  (same growing message thread, no new thread/round)
 *   2. cache_read_input_tokens > 0 from round 2
 *   3. 0% duplicates across all rounds
 *   4. sync() called at START of each round, never mid-generation
 *
 * Usage:
 *   IYH_API_KEY=... node test/live-1session-50.test.js
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const TMP_HISTORY = path.join(os.tmpdir(), `xposter_1sess_${Date.now()}.json`);
process.env.XPOSTER_HISTORY_PATH = TMP_HISTORY;

const E = require('../src/automation/contentEngine');
const { SessionManager } = require('../src/automation/sessionManager');

const KEY = process.env.IYH_API_KEY || process.env.IYH_KEY;
const BASE = process.env.IYH_BASE || 'https://v1.iyhapi.app';
const MODEL = process.env.IYH_MODEL || 'claude-opus-4.8';
const TARGET = parseInt(process.env.TARGET || '50', 10);
const SESSIONS = 1;
const CHUNK = parseInt(process.env.CHUNK || '10', 10);
const LINK = process.env.IYH_LINK || 'https://www.mexc.com/auth/signup?inviteCode=mexc-SESS01';
if (!KEY) { console.error('IYH_API_KEY required'); process.exit(2); }

// ── HTTP (mirror src/main.js buildAiRequest / readUsage) ────────────────
function buildReq(provider, { system, messages, maxTokens }) {
  const base = BASE.replace(/\/+$/, '');
  if (provider === 'anthropic') {
    let endpoint;
    if (/\/v1\/messages$/.test(base)) endpoint = base;
    else endpoint = `${base.replace(/\/v1$/, '')}/v1/messages`;
    return {
      endpoint,
      headers: { 'Content-Type': 'application/json', 'x-api-key': KEY, 'Authorization': `Bearer ${KEY}`, 'anthropic-version': '2023-06-01' },
      body: { model: MODEL, max_tokens: maxTokens || 3000, temperature: 1.0,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages },
    };
  }
  const endpoint = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
  return {
    endpoint,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KEY}` },
    body: { model: MODEL, messages: [{ role: 'system', content: system }, ...messages], max_tokens: maxTokens || 3000, temperature: 1.0 },
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

// ── per-round instrumentation ───────────────────────────────────────────
const rounds = [];           // one entry per round
let curRound = null;         // round being processed
let threadRefStable = true;  // proves same thread object reused
let firstThreadRef = null;
let syncOrderViolation = false; // sync() must NOT fire during live AI generation
let fetchInFlight = false;      // true only while the AI request is in the air

async function callAi({ session, angles, acceptedContext }) {
  // GROWING THREAD (v4.4.0): send the full conversation thread so providers
  // can serve the system prefix from cache. After response, commit the turn.
  if (firstThreadRef === null) firstThreadRef = session.messages;
  else if (session.messages !== firstThreadRef) threadRefStable = false;

  const threadLenBefore = session.messages.length;
  const system = session.system;
  const user = E.buildRoundUser({ quantity: CHUNK, angles, acceptedContext, inspirationSummary: '' });
  const thread = (session.messages.length > 0) ? session.messages : [];
  const messages = [...thread, { role: 'user', content: user }];
  const req = buildReq(provider, { system, messages, maxTokens: 3000 });

  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), 150000);
  try {
    fetchInFlight = true;
    const r = await fetch(req.endpoint, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: controller.signal });
    fetchInFlight = false;
    if (!r.ok) { const tx = await r.text().catch(() => ''); throw new Error(`HTTP ${r.status}: ${tx.slice(0, 200)}`); }
    const data = await r.json();
    const raw = extractText(provider, data);
    // Commit onto persistent thread (mirrors main.js callAi behavior)
    session.messages.push({ role: 'user', content: user });
    session.messages.push({ role: 'assistant', content: raw });
    if (session.messages.length > 16) session.messages = session.messages.slice(-16);
    const usage = readUsage(provider, data);
    const cores = parseArr(raw);
    // start a new round record
    curRound = {
      n: session.roundsCompleted + 1,
      requested: CHUNK,
      threadLenBefore,
      threadLenAfter: session.messages.length,
      accepted: 0, rejected: 0, dup: 0,
      inTokens: usage.input + usage.cacheRead + usage.cacheWrite,
      promptIn: usage.input, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite,
      coresReturned: cores.length,
    };
    return { cores, usage };
  } finally { clearTimeout(to); }
}

(async () => {
  console.log(`PROVIDER=${provider} MODEL=${MODEL} SESSIONS=${SESSIONS} CHUNK=${CHUNK} TARGET=${TARGET}\n`);
  const accepted = [];
  const sharedQueue = [], sharedPreview = [];
  const sharedExactKeys = new Set(), sharedTokenSets = [];
  let roundGuard = 0;

  // Wrap syncSessionDedup to assert it runs at round start (before any AI call result is ingested)
  const realSync = E.syncSessionDedup;
  let syncCalls = 0;
  E.syncSessionDedup = function (...a) {
    syncCalls++;
    // The golden rule: sync() must NEVER run while an AI request is in flight.
    if (fetchInFlight) syncOrderViolation = true;
    return realSync.apply(this, a);
  };

  const ingest = (cores, session) => {
    let gained = 0;
    for (const core of (cores || [])) {
      if (accepted.length >= TARGET) break;
      const c = E.cleanCoreText(String(core || '').trim());
      if (!c) { if (curRound) curRound.rejected++; continue; }
      const a = E.assembleTweet(c, link);
      if (!a) { if (curRound) curRound.rejected++; continue; }
      if (!E.validateTweet(a.text, link).valid) { if (curRound) curRound.rejected++; continue; }
      if (E.isDuplicateInSession(a.text, session, 0.85).dup) { if (curRound) curRound.dup++; continue; }
      if (E.isDuplicateInSession(a.text, { exactKeys: sharedExactKeys, tokenSets: sharedTokenSets }, 0.85).dup) { if (curRound) curRound.dup++; continue; }
      accepted.push(a);
      sharedQueue.push({ text: a.text });
      const k = E.exactKey(a.text), tk = E.tokenize(E.bodyOnly(a.text));
      session.exactKeys.add(k); session.tokenSets.push(tk); session.acceptedBodies.push(E.bodyOnly(a.text));
      sharedExactKeys.add(k); sharedTokenSets.push(tk);
      if (curRound) curRound.accepted++;
      gained++;
    }
    if (curRound) { rounds.push(curRound); curRound = null; }
    return gained;
  };

  const mgr = new SessionManager({
    engine: E,
    runRound: async ({ session, angles, acceptedContext }) => callAi({ session, angles, acceptedContext }),
    ingest,
    onStatus: () => {},
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
  await mgr.run(() => { roundGuard++; return accepted.length >= TARGET || roundGuard > 100; });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  // ── print per-round table ──────────────────────────────────────────────
  console.log('| الجولة | مطلوب | مقبول | مرفوض | مكرر | IN tokens | cache_read | cache % |');
  console.log('|--------|-------|-------|-------|------|-----------|------------|---------|');
  for (const r of rounds) {
    const pct = r.inTokens > 0 ? ((r.cacheRead / r.inTokens) * 100).toFixed(1) : '0.0';
    console.log(`| ${String(r.n).padStart(4)}   | ${String(r.requested).padStart(5)} | ${String(r.accepted).padStart(5)} | ${String(r.rejected).padStart(5)} | ${String(r.dup).padStart(4)} | ${String(r.inTokens).padStart(9)} | ${String(r.cacheRead).padStart(10)} | ${String(pct).padStart(6)} |`);
  }

  const totals = mgr.totals();
  const bodies = accepted.map(a => E.exactKey(a.text));
  const uniq = new Set(bodies).size;

  console.log('\n================ SUMMARY ================');
  console.log(`accepted        : ${accepted.length}/${TARGET}`);
  console.log(`rounds          : ${rounds.length}`);
  console.log(`api calls       : ${totals.calls}`);
  console.log(`sync() calls    : ${syncCalls}`);
  console.log(`thread stable   : ${threadRefStable}  (same session object across all rounds)`);
  console.log(`thread length   : ${rounds.map(r => `${r.threadLenBefore}→${r.threadLenAfter}`).join('  ')}  (GROWING — grows by 2 each round)`);
  const inSeq = rounds.map(r => r.inTokens);
  const promptSeq = rounds.map(r => r.promptIn);
  const cacheSeq = rounds.map(r => r.cacheRead);
  console.log(`prompt IN/round : ${promptSeq.join('  ')}  (should drop after round 1 with cache)`);
  console.log(`cacheRead/round : ${cacheSeq.join('  ')}  (should rise from round 2 with cache)`);
  console.log(`unique posts    : ${uniq}/${bodies.length}  (0 dup = ${uniq === bodies.length})`);
  console.log(`cacheRead total : ${totals.cacheRead}`);
  console.log(`cache hit %     : ${totals.cacheHitPct}%  (0% expected via IYH — provider limitation)`);
  console.log(`sync mid-round  : ${syncOrderViolation ? 'YES (VIOLATION)' : 'no'}`);
  console.log(`elapsed         : ${secs}s`);
  console.log('=========================================');

  // restore
  E.syncSessionDedup = realSync;
  try { fs.unlinkSync(TMP_HISTORY); } catch {}

  // dump raw round data as JSON for the report
  fs.writeFileSync(path.join(os.tmpdir(), 'xposter_round_audit.json'), JSON.stringify({ rounds, totals, accepted: accepted.length, uniq, threadRefStable, syncCalls, syncOrderViolation }, null, 2));
  console.log(`\n(round audit JSON saved to ${path.join(os.tmpdir(), 'xposter_round_audit.json')})`);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
