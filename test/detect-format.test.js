/**
 * Multi-format detection unit tests.
 * Tests detectApiFormat and classifyHttpError logic.
 */
const E = require('../dev/automation/contentEngine');

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`✅ ${name}`); }
  else { failed++; console.log(`❌ ${name}`); }
}

// ── detectApiFormat: OpenCode Go anthropic models ────────────────────
const opencodeGoAnthropic = [
  'minimax-m3', 'minimax-m2.7', 'minimax-m2.5',
  'qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-plus',
  'deepseek-v4-pro', 'kimi-k2.7', 'glm-5.2', 'mimo-v2.5', 'mimo-v2.5-pro',
];
for (const m of opencodeGoAnthropic) {
  const r = E.detectApiFormat('opencode-go', m);
  check(`opencode-go + ${m} → anthropic`, r.format === 'anthropic' && r.endpoint === '/v1/messages');
}

// ── detectApiFormat: OpenCode Go openai models ───────────────────────
const opencodeGoOpenAi = [
  'deepseek-v4-flash', 'deepseek-v4-flash-free',
  'kimi-k2.6', 'glm-5.1',
];
for (const m of opencodeGoOpenAi) {
  const r = E.detectApiFormat('opencode-go', m);
  check(`opencode-go + ${m} → openai`, r.format === 'openai' && r.endpoint === '/v1/chat/completions');
}

// ── detectApiFormat: openai provider ──────────────────────────────────
check('openai + claude-sonnet → anthropic', E.detectApiFormat('openai', 'claude-sonnet-4').format === 'anthropic');
check('openai + gpt-4o → openai', E.detectApiFormat('openai', 'gpt-4o').format === 'openai');
check('openai + deepseek-v3 → openai', E.detectApiFormat('openai', 'deepseek-v3').format === 'openai');
check('openai + gemini-2.0-flash → gemini', E.detectApiFormat('openai', 'gemini-2.0-flash').format === 'gemini');

// ── detectApiFormat: anthropic provider ───────────────────────────────
check('anthropic + claude-3-haiku → anthropic', E.detectApiFormat('anthropic', 'claude-3-haiku').format === 'anthropic');

// ── detectApiFormat: gemini provider ──────────────────────────────────
check('gemini + gemini-2.0-flash → gemini', E.detectApiFormat('gemini', 'gemini-2.0-flash').format === 'gemini');

// ── detectApiFormat: edge cases ───────────────────────────────────────
check('null model → openai', E.detectApiFormat('openai', null).format === 'openai');
check('undefined model → openai', E.detectApiFormat('openai', undefined).format === 'openai');
check('empty model → openai', E.detectApiFormat('openai', '').format === 'openai');
check('unknown provider → openai', E.detectApiFormat('some-unknown-provider', 'some-model').format === 'openai');

// ── classifyHttpError (duplicated here since it's in main.js) ────────
// mirror of the function from dev/main.js
function classifyHttpError(status) {
  if (status === 401) return 'مفتاح API غير صحيح';
  if (status === 404) return 'الـ endpoint غير موجود — تحقق من Base URL';
  if (status === 429) return 'تجاوزت الحد المسموح — انتظر قليلاً';
  if (status >= 500 && status < 600) return 'خطأ في السيرفر — حاول مجدداً';
  return 'تعذّر الاتصال — تحقق من الإنترنت';
}

check('401 → مفتاح API غير صحيح', classifyHttpError(401) === 'مفتاح API غير صحيح');
check('404 → endpoint غير موجود', classifyHttpError(404) === 'الـ endpoint غير موجود — تحقق من Base URL');
check('429 → تجاوزت الحد', classifyHttpError(429) === 'تجاوزت الحد المسموح — انتظر قليلاً');
check('500 → خطأ سيرفر', classifyHttpError(500) === 'خطأ في السيرفر — حاول مجدداً');
check('503 → خطأ سيرفر', classifyHttpError(503) === 'خطأ في السيرفر — حاول مجدداً');
check('403 → تعذر الاتصال', classifyHttpError(403) === 'تعذّر الاتصال — تحقق من الإنترنت');
check('0 → تعذر الاتصال', classifyHttpError(0) === 'تعذّر الاتصال — تحقق من الإنترنت');
check('null → تعذر الاتصال', classifyHttpError(null) === 'تعذّر الاتصال — تحقق من الإنترنت');

// ── Summary ──────────────────────────────────────────────────────────
console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
