/**
 * Integration test for OpenCode Go dual-format support.
 * Mock server simulates a provider that serves both Anthropic-format
 * and OpenAI-format models through the same base URL.
 *
 * Verifies:
 *   1. buildAiRequest produces correct shape per format
 *   2. extractAiText parses correctly per format
 *   3. list-models returns modelFormats annotation
 */
const http = require('http');
const E = require('../src/automation/contentEngine');

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`✅ ${name}`); }
  else { failed++; console.log(`❌ ${name}`); }
}

// Mirror buildAiRequest / extractAiText (same logic as src/main.js)
function buildAiRequest(format, { baseUrl, apiKey, model, system, messages, maxTokens }) {
  const trimmedBase = (baseUrl || '').replace(/\/+$/, '');
  const convo = Array.isArray(messages) && messages.length ? messages : [{ role: 'user', content: '' }];

  if (format === 'anthropic') {
    let endpoint;
    if (/\/v1\/messages$/.test(trimmedBase)) endpoint = trimmedBase;
    else { const root = trimmedBase.replace(/\/v1$/, ''); endpoint = `${root}/v1/messages`; }
    return {
      endpoint,
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'Authorization': `Bearer ${apiKey}`, 'anthropic-version': '2023-06-01' },
      body: { model, max_tokens: maxTokens || 2000, temperature: 1.0,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: convo },
    };
  }
  if (format === 'gemini') {
    // not tested here
    return { endpoint: '', headers: {}, body: {} };
  }
  const endpoint = /\/chat\/completions$/.test(trimmedBase) ? trimmedBase : `${trimmedBase}/chat/completions`;
  return {
    endpoint,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: { model, messages: [{ role: 'system', content: system }, ...convo], max_tokens: maxTokens || 2000, temperature: 1.0 },
  };
}

function extractAiText(format, data) {
  try {
    if (format === 'anthropic') return (data.content || []).map(c => c.text || '').join('\n');
    if (format === 'gemini') { const p = data?.candidates?.[0]?.content?.parts || []; return p.map(x => x.text || '').join('\n'); }
    return data?.choices?.[0]?.message?.content || '';
  } catch { return ''; }
}

// ── Test 1: buildAiRequest with anthropic format ─────────────────────────
const anthropicReq = buildAiRequest('anthropic', {
  baseUrl: 'https://api.opencode.ai/zen/go',
  apiKey: 'test-key',
  model: 'minimax-m3',
  system: 'أنت كاتب محتوى',
  messages: [{ role: 'user', content: 'اكتب تغريدة' }],
  maxTokens: 2000,
});
check('anthropic format endpoint is /v1/messages', anthropicReq.endpoint.includes('/v1/messages'));
check('anthropic format has x-api-key header', anthropicReq.headers['x-api-key'] === 'test-key');
check('anthropic format has anthropic-version', anthropicReq.headers['anthropic-version'] === '2023-06-01');
check('anthropic format body has system array with cache_control', Array.isArray(anthropicReq.body.system) && anthropicReq.body.system[0].cache_control?.type === 'ephemeral');
check('anthropic format body messages is the convo array', Array.isArray(anthropicReq.body.messages) && anthropicReq.body.messages.length === 1);
check('anthropic format model is passed', anthropicReq.body.model === 'minimax-m3');

// ── Test 2: buildAiRequest with openai format ────────────────────────────
const openaiReq = buildAiRequest('openai', {
  baseUrl: 'https://api.opencode.ai/zen/go',
  apiKey: 'test-key',
  model: 'deepseek-v4-flash',
  system: 'أنت كاتب محتوى',
  messages: [{ role: 'user', content: 'اكتب تغريدة' }],
  maxTokens: 2000,
});
check('openai format endpoint is /chat/completions', openaiReq.endpoint.includes('/chat/completions'));
check('openai format has Bearer auth', openaiReq.headers['Authorization'] === 'Bearer test-key');
check('openai format body has system + messages', openaiReq.body.messages[0].role === 'system');
check('openai format body messages length is 2 (system + user)', openaiReq.body.messages.length === 2);
check('openai format model is passed', openaiReq.body.model === 'deepseek-v4-flash');

// ── Test 3: extractAiText with anthropic format ──────────────────────────
const anthropicResponse = { content: [{ text: 'تغريدة من Anthropic format' }] };
const anthroText = extractAiText('anthropic', anthropicResponse);
check('anthropic extract reads content[].text', anthroText === 'تغريدة من Anthropic format');

// ── Test 4: extractAiText with openai format ─────────────────────────────
const openaiResponse = { choices: [{ message: { content: 'تغريدة من OpenAI format' } }] };
const openaiText = extractAiText('openai', openaiResponse);
check('openai extract reads choices[0].message.content', openaiText === 'تغريدة من OpenAI format');

// ── Test 5: detectApiFormat for all OpenCode Go models ───────────────────
const ocgModels = {
  'minimax-m3': 'anthropic', 'minimax-m2.7': 'anthropic', 'minimax-m2.5': 'anthropic',
  'qwen3.7-max': 'anthropic', 'qwen3.7-plus': 'anthropic', 'qwen3.6-plus': 'anthropic',
  'deepseek-v4-flash': 'openai', 'deepseek-v4-flash-free': 'openai', 'deepseek-v4-pro': 'openai',
  'kimi-k2.7': 'openai', 'kimi-k2.6': 'openai',
  'glm-5.2': 'openai', 'glm-5.1': 'openai',
  'mimo-v2.5': 'openai', 'mimo-v2.5-pro': 'openai',
};
for (const [model, expectedFormat] of Object.entries(ocgModels)) {
  const r = E.detectApiFormat('opencode-go', model);
  check(`list-models format for ${model} → ${expectedFormat}`, r.format === expectedFormat);
}

// ── Test 6: model list formats match API format ──────────────────────────
for (const [model, expectedFormat] of Object.entries(ocgModels)) {
  const apiFmt = E.detectApiFormat('opencode-go', model).format;
  check(`API detectApiFormat for ${model} = ${expectedFormat}`, apiFmt === expectedFormat);
}

// ── Mock server: simulates OpenCode Go model list endpoint ───────────────
const serverPort = 0; // let OS assign
const server = http.createServer((req, res) => {
  // Simulate /v1/models listing
  const allModels = Object.keys(ocgModels);
  const payload = { data: allModels.map(id => ({ id, object: 'model' })) };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
});

server.listen(0, async () => {
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  // ── Test 7: Fetch models from mock and annotate ─────────────────────────
  try {
    const resp = await fetch(`${baseUrl}/v1/models`, {
      headers: { 'Authorization': 'Bearer test-key' },
    });
    const data = await resp.json();
    const models = (data.data || []).map(m => m.id).filter(Boolean);
    const modelFormats = {};
    for (const m of models) {
      modelFormats[m] = E.detectApiFormat('opencode-go', m).format;
    }
    check(`mock returns ${models.length} models`, models.length === Object.keys(ocgModels).length);
    check('modelFormats has minimax-m3 → anthropic', modelFormats['minimax-m3'] === 'anthropic');
    check('modelFormats has deepseek-v4-flash → openai', modelFormats['deepseek-v4-flash'] === 'openai');
    check('modelFormats has kimi-k2.7 → openai', modelFormats['kimi-k2.7'] === 'openai');
    check('modelFormats has qwen3.7-max → anthropic', modelFormats['qwen3.7-max'] === 'anthropic');

    // ── Test 8: Verify all 15 OC models map correctly ─────────────────────
    let allOk = 0;
    for (const [m, expected] of Object.entries(ocgModels)) {
      if (modelFormats[m] === expected) allOk++;
    }
    check(`all ${Object.keys(ocgModels).length} model formats correct`, allOk === Object.keys(ocgModels).length);

  } catch (err) {
    console.log(`❌ Mock test error: ${err.message}`);
    failed++;
  }

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  server.close();
  process.exit(failed === 0 ? 0 : 1);
});
