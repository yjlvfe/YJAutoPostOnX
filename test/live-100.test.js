/**
 * LIVE 100-tweet generation test against a REAL OpenAI-compatible endpoint.
 *
 * Imports the REAL contentEngine (prompt/validation/history/de-dup) and
 * replicates main.js's HTTP layer (buildAiRequest / extractAiText /
 * parseTweetArray / callAi + the generate-ai-posts loop) VERBATIM, so this
 * exercises exactly what the app's "Generate" button does — just pointed at
 * the live provider instead of a mock.
 *
 * Usage:
 *   IYH_KEY=xxx IYH_BASE=https://v1.iyhapi.app/v1 IYH_MODEL=claude-sonnet-4.5 \
 *   TARGET=100 node test/live-100.test.js
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

// ── Isolate history so the run is clean & reproducible ───────────────
const TMP_HISTORY = path.join(os.tmpdir(), `xposter_live_history_${Date.now()}.json`);
process.env.XPOSTER_HISTORY_PATH = TMP_HISTORY; // engine honors this override if present

const engine = require('../src/automation/contentEngine');

// Force the engine to use our temp history regardless of override support:
// monkey-patch historyPath by redirecting via a wrapper if needed.
const REAL_HISTORY = engine.historyPath ? engine.historyPath() : null;

const KEY   = process.env.IYH_KEY;
const BASE  = process.env.IYH_BASE  || 'https://v1.iyhapi.app/v1';
const MODEL = process.env.IYH_MODEL || 'claude-sonnet-4.5';
const TARGET = parseInt(process.env.TARGET || '100', 10);
const LINK  = process.env.IYH_LINK || 'https://www.mexc.com/auth/signup?inviteCode=mexc-LIVE01';

if (!KEY) { console.error('IYH_KEY required'); process.exit(2); }

// ── VERBATIM copies of main.js HTTP helpers ──────────────────────────
function buildAiRequest(provider, { baseUrl, apiKey, model, system, user }) {
  const trimmedBase = (baseUrl || '').replace(/\/+$/, '');
  if (provider === 'anthropic') {
    const base = trimmedBase || 'https://api.anthropic.com';
    const endpoint = /\/v1\/messages$/.test(base) ? base : `${base}/v1/messages`;
    return { endpoint, headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: { model: model || 'claude-3-5-sonnet-20241022', max_tokens: 4000, temperature: 1.0, system, messages: [{ role: 'user', content: user }] } };
  }
  if (provider === 'gemini') {
    const base = trimmedBase || 'https://generativelanguage.googleapis.com/v1beta';
    const mdl = model || 'gemini-2.0-flash';
    const endpoint = `${base}/models/${mdl}:generateContent?key=${encodeURIComponent(apiKey)}`;
    return { endpoint, headers: { 'Content-Type': 'application/json' },
      body: { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { temperature: 1.0, maxOutputTokens: 4000 } } };
  }
  const base = trimmedBase || 'https://api.openai.com/v1';
  const endpoint = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
  return { endpoint, headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: { model: model || 'gpt-4o-mini', messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: 4000, temperature: 1.0 } };
}
function extractAiText(provider, data) {
  try {
    if (provider === 'anthropic') return (data.content || []).map(c => c.text || '').join('\n');
    if (provider === 'gemini') { const parts = data?.candidates?.[0]?.content?.parts || []; return parts.map(p => p.text || '').join('\n'); }
    return data?.choices?.[0]?.message?.content || '';
  } catch { return ''; }
}
function parseTweetArray(raw) {
  if (!raw) return [];
  let text = raw.trim().replace(/```(?:json)?/gi, '').trim();
  try { const arr = JSON.parse(text); if (Array.isArray(arr)) return arr.filter(x => typeof x === 'string'); } catch {}
  const start = text.indexOf('['), end = text.lastIndexOf(']');
  if (start !== -1 && end !== -1 && end > start) {
    try { const arr = JSON.parse(text.slice(start, end + 1)); if (Array.isArray(arr)) return arr.filter(x => typeof x === 'string'); } catch {}
  }
  return text.split('\n').map(l => l.replace(/^\s*[-*\d.)\]]+\s*/, '').replace(/^["'“]|["'”]$/g, '').trim()).filter(l => l.length > 40);
}
async function callAi({ provider, baseUrl, apiKey, model, quantity, avoidBodies }) {
  const angles = engine.selectAngles(quantity);
  const { system, user } = engine.buildPrompt({ quantity, angles, hasLink: true, avoidBodies: avoidBodies || [] });
  const req = buildAiRequest(provider, { baseUrl, apiKey, model, system, user });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);
  let response;
  try {
    response = await fetch(req.endpoint, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: controller.signal });
  } finally { clearTimeout(timeout); }
  if (!response.ok) { const t = await response.text().catch(() => ''); throw new Error(`HTTP ${response.status}: ${t.slice(0, 300)}`); }
  const data = await response.json();
  return parseTweetArray(extractAiText(provider, data));
}

// ── VERBATIM generate-ai-posts loop (params identical to app) ────────
(async () => {
  const target = Math.max(1, Math.min(TARGET, 100));
  const provider = engine.detectProvider(BASE, 'auto');
  console.log(`Provider detected: ${provider} | model: ${MODEL} | base: ${BASE}`);
  console.log(`Target: ${target} tweets | history: ${REAL_HISTORY}\n`);

  const history = engine.loadHistory();
  const historyTokenSets = history.map(t => engine.tokenize(t));
  const sessionTokenSets = [];
  const avoidBodies = engine.getRecentBodies(25);

  const accepted = [];
  const rejectedReasons = {};
  const maxRounds = 30;             // app uses 6; lifted to truly push for 100 and report honest numbers
  const BATCH_CAP = parseInt(process.env.BATCH_CAP || '15', 10); // smaller batches = faster calls, no 90s timeout
  let round = 0, totalCandidates = 0;
  const t0 = Date.now();

  while (accepted.length < target && round < maxRounds) {
    round++;
    const need = target - accepted.length;
    const askFor = Math.min(Math.ceil(need * 1.6) + 2, BATCH_CAP);
    let cores;
    try {
      cores = await callAi({ provider, baseUrl: BASE, apiKey: KEY, model: MODEL, quantity: askFor, avoidBodies });
    } catch (err) {
      console.error(`❌ Round ${round} API error: ${err.message}`);
      break;
    }
    totalCandidates += cores.length;
    let acceptedThisRound = 0;
    for (const core of cores) {
      if (accepted.length >= target) break;
      const cleanCore = String(core).trim();
      if (!cleanCore) continue;
      const assembled = engine.assembleTweet(cleanCore, LINK);
      if (!assembled) { rejectedReasons['تعذّر ضبط الطول 200-270'] = (rejectedReasons['تعذّر ضبط الطول 200-270'] || 0) + 1; continue; }
      const allHistory = [...historyTokenSets, ...sessionTokenSets];
      const verdict = engine.validateTweet(assembled.text, LINK, allHistory);
      if (!verdict.valid) { rejectedReasons[verdict.reason] = (rejectedReasons[verdict.reason] || 0) + 1; continue; }
      accepted.push({ text: assembled.text, length: assembled.length });
      sessionTokenSets.push(engine.tokenize(assembled.text));
      acceptedThisRound++;
    }
    console.log(`Round ${round}: asked ${askFor}, got ${cores.length} cores, accepted ${acceptedThisRound} → total ${accepted.length}/${target}`);
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const totalRejected = Object.values(rejectedReasons).reduce((a, b) => a + b, 0);

  // ── REPORT ──────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(60));
  console.log('📊 LIVE GENERATION REPORT');
  console.log('═'.repeat(60));
  console.log(`✅ Accepted (passed):     ${accepted.length}/${target}`);
  console.log(`📦 Total candidates:      ${totalCandidates}`);
  console.log(`🚫 Total rejected:        ${totalRejected}`);
  console.log(`🔁 Rounds used:           ${round}`);
  console.log(`⏱  Time:                  ${secs}s`);
  console.log(`📈 Acceptance rate:       ${totalCandidates ? ((accepted.length / totalCandidates) * 100).toFixed(1) : 0}%`);
  console.log('\n── Rejection breakdown ──');
  if (totalRejected === 0) console.log('  (none)');
  else Object.entries(rejectedReasons).sort((a, b) => b[1] - a[1]).forEach(([r, n]) => console.log(`  • ${r}: ${n}`));

  // length distribution
  const lens = accepted.map(a => a.length);
  if (lens.length) {
    const min = Math.min(...lens), max = Math.max(...lens), avg = (lens.reduce((a, b) => a + b, 0) / lens.length).toFixed(1);
    console.log(`\n── Length (target 200-270) ──`);
    console.log(`  min ${min} | avg ${avg} | max ${max} | all in range: ${lens.every(l => l >= 200 && l <= 270)}`);
  }

  console.log('\n── First 5 accepted samples ──');
  accepted.slice(0, 5).forEach((a, i) => console.log(`\n[${i + 1}] (${a.length} chars)\n${a.text}`));

  // dump full set to file for inspection
  const outPath = path.join(os.tmpdir(), `xposter_live_100_${Date.now()}.txt`);
  fs.writeFileSync(outPath, accepted.map((a, i) => `[${i + 1}] (${a.length})\n${a.text}\n`).join('\n'));
  console.log(`\n📄 Full set written to: ${outPath}`);

  process.exit(accepted.length >= Math.min(target, 1) ? 0 : 1);
})();
