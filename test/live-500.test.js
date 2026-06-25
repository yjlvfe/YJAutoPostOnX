/**
 * LIVE 500-tweet generation test — REAL Opus through IYH, full new pipeline.
 *
 * Mirrors src/main.js's generate-ai-posts loop VERBATIM (G1 parallel waves,
 * caching, G3 session-only dedup, G2 cleanliness, live per-round stats) and
 * imports the REAL contentEngine. No mocks, no simulation.
 *
 * Usage:
 *   IYH_KEY=xxx IYH_BASE=https://v1.iyhapi.app IYH_MODEL=claude-opus-4.8 \
 *   TARGET=500 node test/live-500.test.js
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

// Isolate history so the run is clean and the inspiration summary is fresh.
const TMP_HISTORY = path.join(os.tmpdir(), `xposter_live500_history_${Date.now()}.json`);
process.env.XPOSTER_HISTORY_PATH = TMP_HISTORY;

const E = require('../src/automation/contentEngine');

const KEY    = process.env.IYH_KEY;
const BASE   = process.env.IYH_BASE  || 'https://v1.iyhapi.app';
const MODEL  = process.env.IYH_MODEL || 'claude-opus-4.8';
const TARGET = parseInt(process.env.TARGET || '500', 10);
const LINK   = process.env.IYH_LINK || 'https://www.mexc.com/auth/signup?inviteCode=mexc-LIVE01';
if (!KEY) { console.error('IYH_KEY required'); process.exit(2); }

// ── VERBATIM copies of main.js HTTP helpers (kept byte-identical) ────────
function buildAiRequest(provider, { baseUrl, apiKey, model, system, user, maxTokens }) {
  const trimmedBase = (baseUrl || '').replace(/\/+$/, '');
  if (provider === 'anthropic') {
    const base = trimmedBase || 'https://api.anthropic.com';
    let endpoint;
    if (/\/v1\/messages$/.test(base)) endpoint = base;
    else { const root = base.replace(/\/v1$/, ''); endpoint = `${root}/v1/messages`; }
    return { endpoint,
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'Authorization': `Bearer ${apiKey}`, 'anthropic-version': '2023-06-01' },
      body: { model: model || 'claude-3-5-sonnet-20241022', max_tokens: maxTokens || 2000, temperature: 1.0,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: user }] } };
  }
  const base = trimmedBase || 'https://api.openai.com/v1';
  const endpoint = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
  return { endpoint, headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: { model: model || 'gpt-4o-mini', messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: maxTokens || 2000, temperature: 1.0 } };
}
function extractAiText(provider, data) {
  try {
    if (provider === 'anthropic') return (data.content || []).map(c => c.text || '').join('\n');
    return data?.choices?.[0]?.message?.content || '';
  } catch { return ''; }
}
function parseTweetArray(raw) {
  if (!raw) return [];
  let text = raw.trim().replace(/```(?:json)?/gi, '').trim();
  try { const arr = JSON.parse(text); if (Array.isArray(arr)) return arr.filter(x => typeof x === 'string' && x.trim()); } catch {}
  const s = text.indexOf('['), e = text.lastIndexOf(']');
  if (s !== -1 && e !== -1 && e > s) { try { const arr = JSON.parse(text.slice(s, e + 1)); if (Array.isArray(arr)) return arr.filter(x => typeof x === 'string' && x.trim()); } catch {} }
  return text.split('\n').map(l => l.replace(/^[\s\-*\d.)\]]+\s*/, '').replace(/^["'“]|["'”]$/g, '').trim()).filter(l => l.length > 40);
}
function readUsage(prov, data) {
  const u = data?.usage || {};
  if (prov === 'anthropic') return { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0 };
  const cached = u.prompt_tokens_details?.cached_tokens || 0;
  return { input: u.prompt_tokens || 0, output: u.completion_tokens || 0, cacheWrite: 0, cacheRead: cached };
}
async function callAi({ provider, baseUrl, apiKey, model, quantity, angles, inspirationSummary, maxTokens, timeoutMs }) {
  const { system, user } = E.buildPrompt({ quantity, angles: angles || E.selectAngles(quantity), hasLink: true, inspirationSummary: inspirationSummary || '', customSystem: '' });
  const nativeReq = buildAiRequest(provider, { baseUrl, apiKey, model, system, user, maxTokens });
  const openAiReq = buildAiRequest('openai', { baseUrl, apiKey, model, system, user, maxTokens });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs || 120000);
  async function attempt(req, extractAs) {
    const r = await fetch(req.endpoint, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: controller.signal });
    if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(`HTTP ${r.status}: ${t.slice(0, 300)}`); }
    const data = await r.json();
    return { cores: parseTweetArray(extractAiText(extractAs, data)), usage: readUsage(extractAs, data) };
  }
  try {
    return await attempt(nativeReq, provider);
  } catch (nativeErr) {
    if (provider === 'anthropic') { try { return await attempt(openAiReq, 'openai'); } catch { throw new Error(`فشل المزوّد: ${nativeErr.message}`); } }
    throw nativeErr;
  } finally { clearTimeout(timeout); }
}

// ── Mirror of the generate-ai-posts loop ────────────────────────────────
(async () => {
  const provider = E.detectProvider(BASE, 'auto', MODEL);
  const label = E.providerLabel(provider, MODEL);
  const link = LINK;
  const target = TARGET;

  const session = { exactKeys: new Set(), tokenSets: [] };
  const inspirationSummary = E.buildInspirationSummary(10);

  const accepted = [];
  const rejectedReasons = {};
  let roundsCompleted = 0, rejectedCount = 0, dupCount = 0;
  const usageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };

  const CHUNK = 10, CONCURRENCY = 5, PER_CALL_TIMEOUT = 120000;

  const ingest = (cores) => {
    let gained = 0;
    if (!cores) return gained;
    for (const core of cores) {
      if (accepted.length >= target) break;
      const cleanedCore = E.cleanCoreText(String(core || '').trim());
      if (!cleanedCore) { rejectedCount++; rejectedReasons['فارغ بعد التنظيف'] = (rejectedReasons['فارغ بعد التنظيف'] || 0) + 1; continue; }
      const assembled = E.assembleTweet(cleanedCore, link);
      if (!assembled) { rejectedCount++; rejectedReasons['تعذّر ضبط الطول (≤270)'] = (rejectedReasons['تعذّر ضبط الطول (≤270)'] || 0) + 1; continue; }
      const verdict = E.validateTweet(assembled.text, link);
      if (!verdict.valid) { rejectedCount++; rejectedReasons[verdict.reason] = (rejectedReasons[verdict.reason] || 0) + 1; continue; }
      const dup = E.isDuplicateInSession(assembled.text, session, 0.85);
      if (dup.dup) { rejectedCount++; dupCount++; const reason = dup.level === 1 ? 'مكرر (مطابقة دقيقة)' : 'مكرر (تشابه دلالي >85%)'; rejectedReasons[reason] = (rejectedReasons[reason] || 0) + 1; continue; }
      accepted.push({ text: assembled.text, length: assembled.length });
      session.exactKeys.add(E.exactKey(assembled.text));
      session.tokenSets.push(E.tokenize(assembled.text));
      try { E.appendHistory([assembled.text]); } catch {}
      gained++;
    }
    return gained;
  };

  const runChunk = async () => {
    try {
      const angles = E.selectAngles(CHUNK);
      const { cores, usage } = await callAi({ provider, baseUrl: BASE, apiKey: KEY, model: MODEL, quantity: CHUNK, angles, inspirationSummary, maxTokens: 2500, timeoutMs: PER_CALL_TIMEOUT });
      return { ok: true, cores, usage };
    } catch (err) { return { ok: false, error: err.message }; }
  };

  const t0 = Date.now();
  console.log(`PROVIDER=${provider} LABEL=${label} MODEL=${MODEL} TARGET=${target}`);
  console.log('round | requested | gained | rejected | dups | in_tok | out_tok | cacheRead | accTotal');

  let wave = 0, consecutiveApiFailures = 0;
  const perRound = [];

  // Cache-warming first chunk (native anthropic only).
  if (provider === 'anthropic') {
    const beforeRej = rejectedCount, beforeDup = dupCount, beforeAcc = accepted.length;
    const u0 = { ...usageTotals };
    const warm = await runChunk();
    if (warm.ok) {
      if (warm.usage) { usageTotals.input += warm.usage.input; usageTotals.output += warm.usage.output; usageTotals.cacheRead += warm.usage.cacheRead; usageTotals.cacheWrite += warm.usage.cacheWrite; usageTotals.calls++; }
      roundsCompleted++;
      ingest(warm.cores);
      const row = { round: 'warm', requested: CHUNK, gained: accepted.length - beforeAcc, rejected: rejectedCount - beforeRej, dups: dupCount - beforeDup, inTok: usageTotals.input - u0.input + (usageTotals.cacheRead - u0.cacheRead) + (usageTotals.cacheWrite - u0.cacheWrite), outTok: usageTotals.output - u0.output, cacheRead: usageTotals.cacheRead - u0.cacheRead, accTotal: accepted.length };
      perRound.push(row);
      console.log(`warm  | ${row.requested} | ${row.gained} | ${row.rejected} | ${row.dups} | ${row.inTok} | ${row.outTok} | ${row.cacheRead} | ${row.accTotal}`);
    } else if (accepted.length === 0) { console.error('WARMUP FAILED:', warm.error); process.exit(1); }
  }

  while (accepted.length < target) {
    wave++;
    const beforeAcc = accepted.length, beforeRej = rejectedCount, beforeDup = dupCount;
    const u0 = { ...usageTotals };
    const remaining = target - accepted.length;
    const chunksNeeded = Math.min(CONCURRENCY, Math.max(1, Math.ceil((remaining * 1.5) / CHUNK)));
    const results = await Promise.all(Array.from({ length: chunksNeeded }, () => runChunk()));
    let anyOk = false;
    for (const r of results) {
      if (r.ok) { anyOk = true; if (r.usage) { usageTotals.input += r.usage.input; usageTotals.output += r.usage.output; usageTotals.cacheRead += r.usage.cacheRead; usageTotals.cacheWrite += r.usage.cacheWrite; usageTotals.calls++; } ingest(r.cores); }
    }
    roundsCompleted++;
    if (!anyOk) {
      consecutiveApiFailures++;
      const firstErr = results.find(r => !r.ok)?.error || 'unknown';
      console.error(`  wave ${wave} ALL-FAIL: ${firstErr}`);
      if (consecutiveApiFailures >= 3 && accepted.length === 0) { console.error('ABORT: 3 consecutive failures, nothing accepted'); process.exit(1); }
    } else consecutiveApiFailures = 0;
    const row = { round: wave, requested: chunksNeeded * CHUNK, gained: accepted.length - beforeAcc, rejected: rejectedCount - beforeRej, dups: dupCount - beforeDup, inTok: (usageTotals.input - u0.input) + (usageTotals.cacheRead - u0.cacheRead) + (usageTotals.cacheWrite - u0.cacheWrite), outTok: usageTotals.output - u0.output, cacheRead: usageTotals.cacheRead - u0.cacheRead, accTotal: accepted.length };
    perRound.push(row);
    console.log(`${String(wave).padStart(5)} | ${row.requested} | ${row.gained} | ${row.rejected} | ${row.dups} | ${row.inTok} | ${row.outTok} | ${row.cacheRead} | ${row.accTotal}`);
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const totalIn = usageTotals.input + usageTotals.cacheRead + usageTotals.cacheWrite;
  const totalGenerated = accepted.length + rejectedCount;
  const rejPct = totalGenerated > 0 ? (rejectedCount / totalGenerated) * 100 : 0;
  const cacheHitPct = totalIn > 0 ? (usageTotals.cacheRead / totalIn) * 100 : 0;

  console.log('\n================ SUMMARY ================');
  console.log(`accepted        : ${accepted.length}/${target}`);
  console.log(`rounds          : ${roundsCompleted}`);
  console.log(`api calls       : ${usageTotals.calls}`);
  console.log(`rejected total  : ${rejectedCount}  (${rejPct.toFixed(2)}% of ${totalGenerated} generated)`);
  console.log(`  duplicates    : ${dupCount}`);
  console.log(`avg accepted/rnd: ${(accepted.length / roundsCompleted).toFixed(2)}`);
  console.log(`tokens IN       : ${totalIn}  (prompt ${usageTotals.input}, cacheRead ${usageTotals.cacheRead}, cacheWrite ${usageTotals.cacheWrite})`);
  console.log(`tokens OUT      : ${usageTotals.output}`);
  console.log(`tokens TOTAL    : ${totalIn + usageTotals.output}`);
  console.log(`cache hit %     : ${cacheHitPct.toFixed(1)}%`);
  console.log(`elapsed         : ${secs}s`);
  console.log('rejection reasons:');
  for (const [k, v] of Object.entries(rejectedReasons).sort((a, b) => b[1] - a[1])) console.log(`  - ${k}: ${v}`);
  // length distribution sanity
  const overLimit = accepted.filter(a => a.length > 270).length;
  const noEmoji = accepted.filter(a => !E.hasEmoji(a.text)).length;
  console.log(`integrity       : over270=${overLimit}, missingEmoji=${noEmoji}`);
  console.log('=========================================');

  // ── CSV export (G: importable by the app — header Text,Media) ──────────
  const CSV_OUT = process.env.CSV_OUT;
  if (CSV_OUT) {
    const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
    const lines = ['Text,Media'];
    for (const a of accepted) lines.push(`${esc(a.text)},""`);
    fs.writeFileSync(CSV_OUT, lines.join('\n') + '\n', 'utf8');
    console.log(`CSV written: ${CSV_OUT} (${accepted.length} rows)`);
  }

  try { fs.unlinkSync(TMP_HISTORY); } catch {}
  process.exit(0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
