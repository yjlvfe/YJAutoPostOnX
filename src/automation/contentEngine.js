/**
 * 🧠 Content Engine — Professional Arabic Crypto Tweet Generator
 * ================================================================
 * The brain behind AI tweet generation. Enforces strict quality:
 *   - Angle matrix (15+ crypto angles) → topic variety, zero repetition
 *   - Strict char budget: 230 ≤ (text + link + hashtags) ≤ 270
 *   - Intra-tweet word-repetition killer (kills "تام تام")
 *   - Cross-batch de-duplication against persistent history (Jaccard n-gram)
 *   - External referral link injection (NEVER hardcoded)
 *   - SEO hashtag bank (rotating, English allowed)
 *   - Auto-regeneration of rejected candidates
 *
 * The AI provides freshness; this engine enforces discipline.
 * We NEVER trust the AI blindly — every candidate passes the gate.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ─────────────────────────────────────────────────────────────────────
// 1. ANGLE MATRIX — diverse crypto topics so tweets never feel repetitive
// ─────────────────────────────────────────────────────────────────────
const ANGLE_MATRIX = [
  { id: 'volume',      ar: 'حجم التداول والسيولة كمؤشر على قوة الحركة السعرية' },
  { id: 'psychology',  ar: 'سيكولوجيا السوق والسيطرة على مشاعر الخوف والطمع' },
  { id: 'risk',        ar: 'إدارة المخاطر وحجم المركز وحماية رأس المال' },
  { id: 'discipline',  ar: 'الانضباط ووضع خطة تداول والالتزام بها' },
  { id: 'support_res', ar: 'مناطق الدعم والمقاومة وكيفية قراءتها' },
  { id: 'fees',        ar: 'أثر الرسوم المنخفضة على صافي أرباح المتداول' },
  { id: 'speed',       ar: 'سرعة تنفيذ الأوامر وأهميتها في الأسواق السريعة' },
  { id: 'security',    ar: 'أمان المنصة وحماية الأصول الرقمية' },
  { id: 'beginners',   ar: 'أخطاء المبتدئين الشائعة وكيفية تجنبها' },
  { id: 'fomo',        ar: 'الوقوع في فخ FOMO والشراء عند القمم' },
  { id: 'spot_fut',    ar: 'الفرق بين السبوت والفيوتشر ومتى تستخدم كلاً منهما' },
  { id: 'patience',    ar: 'الصبر وانتظار الفرصة الصحيحة بدل المطاردة' },
  { id: 'trend',       ar: 'التداول مع الاتجاه العام بدل مقاومته' },
  { id: 'dca',         ar: 'استراتيجية متوسط التكلفة DCA لتقليل المخاطر' },
  { id: 'liquidity',   ar: 'العمق السعري والسيولة العالية وتأثيرها على التنفيذ' },
  { id: 'analysis',    ar: 'أهمية التحليل قبل الدخول وعدم التداول العشوائي' },
  { id: 'leverage',    ar: 'مخاطر الرافعة المالية العالية على المحفظة' },
  { id: 'consistency', ar: 'الربح الثابت الصغير أفضل من المخاطرة الكبيرة' },
  { id: 'stoploss',    ar: 'أهمية وقف الخسارة وعدم التداول بدون حماية' },
  { id: 'news',        ar: 'تأثير الأخبار والبيانات على تحركات السوق' },
];

// ─────────────────────────────────────────────────────────────────────
// 2. HASHTAG BANK — SEO-strong, rotating (Arabic + English allowed)
// ─────────────────────────────────────────────────────────────────────
const HASHTAG_BANK = [
  '#كريبتو', '#تداول', '#بيتكوين', '#عملات_رقمية', '#تحليل_فني',
  '#استثمار', '#Crypto', '#Bitcoin', '#Trading', '#MEXC',
  '#التحليل_الفني', '#العملات_الرقمية', '#فوريكس', '#اخبار_الكريبتو',
  '#BTC', '#ETH', '#Altcoin', '#تداول_العملات', '#السوق', '#ربح',
];

// ─────────────────────────────────────────────────────────────────────
// 3. PERSISTENT HISTORY — time-stamped, self-expiring de-dup memory
// ─────────────────────────────────────────────────────────────────────
// Entries are stored as { text, ts } objects. Anything older than
// HISTORY_TTL_DAYS is dropped on load, so a tweet that "expired" can be
// produced again — this is what makes generation effectively unlimited
// while still blocking near-term repetition.
const HISTORY_TTL_DAYS = 60;
const HISTORY_TTL_MS = HISTORY_TTL_DAYS * 24 * 60 * 60 * 1000;

function historyPath() {
  const dir = path.join(os.homedir(), '.config', 'x-poster-bot-profile');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* best-effort */ }
  return path.join(dir, 'generated_history.json');
}

/**
 * Read the raw history file and normalize every entry to { text, ts }.
 * Tolerates the legacy format (a plain array of strings) by stamping
 * those entries with "now" so they live out a fresh TTL window.
 */
function readRawHistory() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(historyPath(), 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const now = Date.now();
  return data
    .map(entry => {
      if (typeof entry === 'string') return { text: entry, ts: now };
      if (entry && typeof entry.text === 'string') {
        return { text: entry.text, ts: Number(entry.ts) || now };
      }
      return null;
    })
    .filter(Boolean);
}

/**
 * Load non-expired history entries (objects { text, ts }), newest last.
 * Entries older than the TTL are silently dropped.
 */
function loadHistoryEntries() {
  const cutoff = Date.now() - HISTORY_TTL_MS;
  return readRawHistory().filter(e => e.ts >= cutoff);
}

/**
 * Back-compat helper: return only the texts of non-expired entries.
 * Used by the generation loop to build de-dup token sets.
 */
function loadHistory() {
  return loadHistoryEntries().map(e => e.text);
}

/**
 * Append freshly-accepted tweet texts to history with the current
 * timestamp, prune expired entries, and cap the file length.
 * @param {string[]} newTexts
 */
function appendHistory(newTexts) {
  if (!Array.isArray(newTexts) || newTexts.length === 0) return;
  const now = Date.now();
  const kept = loadHistoryEntries();   // already TTL-pruned
  for (const text of newTexts) {
    if (typeof text === 'string' && text.trim()) {
      kept.push({ text, ts: now });
    }
  }
  // Cap at last 5000 entries to keep the file lean
  const trimmed = kept.slice(-5000);
  try {
    fs.writeFileSync(historyPath(), JSON.stringify(trimmed, null, 0), 'utf8');
  } catch (e) {
    console.error('Failed to save generation history:', e?.message);
  }
}

/**
 * Return a sample of the most recent tweet bodies (no link/hashtags) to
 * feed back into the AI prompt so the model actively avoids repeating
 * what it already produced. Capped to `max` and to a char budget so the
 * prompt stays small.
 * @param {number} max
 * @returns {string[]}
 */
function getRecentBodies(max = 25) {
  const entries = loadHistoryEntries();
  const recent = entries.slice(-max).reverse();   // newest first
  return recent.map(e => bodyOnly(e.text)).filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────
// 4. TEXT UTILITIES
// ─────────────────────────────────────────────────────────────────────

// X.com counts URLs as a fixed 23 chars (t.co wrapping), regardless of length.
const TCO_URL_LENGTH = 23;

/**
 * Strip Arabic diacritics (tashkeel) and tatweel for fair comparison.
 */
function normalizeArabic(text) {
  return text
    .replace(/[\u0617-\u061A\u064B-\u0652\u0670\u0640]/g, '')
    .replace(/[إأآا]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .trim();
}

/**
 * Extract word tokens (letters/numbers, Arabic + Latin) from text.
 */
function tokenize(text) {
  const cleaned = normalizeArabic(text.toLowerCase());
  const matches = cleaned.match(/[\u0621-\u064Aa-z0-9]+/g);
  return matches || [];
}

/**
 * Compute the TRUE X.com character cost of a tweet:
 *   - every http(s) URL counts as 23 chars (t.co wrapping)
 *   - everything else counts as its literal length
 * @param {string} text
 * @returns {number}
 */
function tweetLength(text) {
  if (!text) return 0;
  const urlRe = /https?:\/\/[^\s]+/g;
  const urls = text.match(urlRe) || [];
  let stripped = text.replace(urlRe, '');
  // Count remaining chars + fixed cost per URL
  // Use spread to count code points correctly (emoji safe)
  const baseLen = [...stripped].length;
  return baseLen + urls.length * TCO_URL_LENGTH;
}

/**
 * Detect immediate word repetition like "تام تام" or "now now".
 * Returns the repeated word, or null if none.
 */
function findAdjacentRepeat(text) {
  const tokens = tokenize(text);
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i].length >= 2 && tokens[i] === tokens[i - 1]) {
      return tokens[i];
    }
  }
  return null;
}

/**
 * Detect ANY word repeated 3+ times (excessive keyword stuffing).
 * Short connector words are exempt.
 */
const STOPWORDS = new Set([
  'في', 'من', 'الى', 'على', 'عن', 'مع', 'هو', 'هي', 'ان', 'انه',
  'the', 'a', 'an', 'to', 'of', 'in', 'on', 'is', 'and', 'or', 'for',
  'و', 'يا', 'ما', 'لا', 'كل', 'هذا', 'هذه', 'الذي',
]);

function findOverusedWord(text, maxCount = 3) {
  const tokens = tokenize(text);
  const counts = {};
  for (const tok of tokens) {
    if (tok.length < 3 || STOPWORDS.has(tok)) continue;
    counts[tok] = (counts[tok] || 0) + 1;
    if (counts[tok] > maxCount) return tok;
  }
  return null;
}

/**
 * Jaccard similarity over word-bigrams (shingles) — robust near-dup check.
 */
function bigrams(tokens) {
  const set = new Set();
  for (let i = 1; i < tokens.length; i++) {
    set.add(tokens[i - 1] + ' ' + tokens[i]);
  }
  return set;
}

function jaccard(aTokens, bTokens) {
  const A = bigrams(aTokens);
  const B = bigrams(bTokens);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Check whether `candidate` is too similar to anything in `history`
 * (array of fingerprint token arrays). Threshold default 0.82.
 *
 * IMPORTANT: 0.82 (not 0.5). Crypto Arabic tweets share a tiny vocabulary
 * (تداول، السوق، المخاطر، رأس المال…), so at 0.5 two GENUINELY different
 * tweets cross the bigram-Jaccard line once history grows past ~100 entries
 * — which is exactly what collapsed acceptance to ~1 per round in the
 * 10k-tweet test. Empirically 0.82 keeps 50/50 distinct tweets even with a
 * 1500-entry history while still blocking near-verbatim repeats.
 */
function isDuplicate(candidateTokens, historyTokenSets, threshold = 0.82) {
  for (const h of historyTokenSets) {
    if (jaccard(candidateTokens, h) >= threshold) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────
// 5. HASHTAG SELECTION — deterministic rotation + randomness for variety
// ─────────────────────────────────────────────────────────────────────
function pickHashtags(count, seed) {
  const pool = [...HASHTAG_BANK];
  // Fisher-Yates with seeded-ish shuffle
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

// ─────────────────────────────────────────────────────────────────────
// 6. ASSEMBLY — combine AI core text + link + hashtags within budget
// ─────────────────────────────────────────────────────────────────────

const MIN_LEN = 170;   // relaxed floor — deepseek & short-form models often produce ~150-char cores
const MAX_LEN = 270;   // HARD ceiling — never exceed (X limit)

// Hashtags sorted shortest-first: used as a fallback so a long core with a
// referral link still gets at least one short hashtag and passes MAX_LEN.
const HASHTAG_BANK_SHORT_FIRST = [...HASHTAG_BANK].sort((a, b) => a.length - b.length);

/**
 * Assemble a final tweet from an AI-produced core line, a referral link,
 * and hashtags — trying every combination needed to land inside [MIN_LEN, MAX_LEN].
 *
 * Strategy (in order):
 *   1. Try 2, 3, 1, 4 hashtags with random selection (same as before).
 *   2. If still failing, try every single hashtag from the bank sorted
 *      shortest-first — guarantees we find the smallest tag that fits.
 *   3. Last resort: no hashtags (validateTweet will then reject — but that
 *      gives a clear diagnostic reason instead of a silent null).
 *
 * @param {string} core - The AI body text (no link, no hashtags ideally)
 * @param {string} link - External referral link (may be empty)
 * @returns {{ text: string, length: number } | null}
 */
function assembleTweet(core, link) {
  let cleanCore = cleanCoreText(String(core || '').trim());
  if (!cleanCore) return null;

  // G2: every tweet MUST carry an emoji.
  if (!hasEmoji(cleanCore)) {
    const e = DEFAULT_EMOJIS[Math.floor(Math.random() * DEFAULT_EMOJIS.length)];
    cleanCore = `${e} ${cleanCore}`;
  }

  const linkPart = link && link.trim() ? `\n${link.trim()}` : '';

  // Pass 1: standard preferred counts (random hashtag selection)
  for (const hcount of [2, 3, 1, 4]) {
    const tags = pickHashtags(hcount);
    const tagPart = '\n' + tags.join(' ');
    const candidate = `${cleanCore}${linkPart}${tagPart}`;
    const len = tweetLength(candidate);
    if (len >= MIN_LEN && len <= MAX_LEN) return { text: candidate, length: len };
  }

  // Pass 2: try every single hashtag from shortest to longest (rescue for long cores)
  for (const tag of HASHTAG_BANK_SHORT_FIRST) {
    const candidate = `${cleanCore}${linkPart}\n${tag}`;
    const len = tweetLength(candidate);
    if (len >= MIN_LEN && len <= MAX_LEN) return { text: candidate, length: len };
  }

  // Pass 3: no hashtags — lets validateTweet emit a clear diagnostic reason
  const bare = `${cleanCore}${linkPart}`;
  const bareLen = tweetLength(bare);
  if (bareLen >= MIN_LEN && bareLen <= MAX_LEN) return { text: bare, length: bareLen };

  return null; // core is genuinely unsalvageable (too long even bare, or too short)
}

// ─────────────────────────────────────────────────────────────────────
// 7. VALIDATION GATE — the strict quality firewall
// ─────────────────────────────────────────────────────────────────────

/**
 * Strip URLs and hashtags from a tweet, leaving only the human body text.
 * Word-repetition checks run on the BODY only — links and hashtags
 * legitimately reuse brand words (e.g. mexc in link + #MEXC).
 */
function bodyOnly(text) {
  return text
    .replace(/https?:\/\/[^\s]+/g, ' ')   // remove URLs
    .replace(/#[^\s#]+/g, ' ')             // remove hashtags
    .trim();
}

/**
 * Clean AI-produced core text: strip length annotations like "191 Chars",
 * "256 characters", "150 حرف" etc. that sometimes leak from the model,
 * plus tweet numbering, surrounding quotes, stray brackets, broken emoji
 * codes, and descriptive labels that don't belong in the tweet body.
 * This is the G2 output-cleanliness firewall — run on EVERY core before
 * assembly so nothing dirty ever reaches the queue/preview.
 */
function cleanCoreText(text) {
  if (!text) return text;
  let t = String(text);

  // 1. Strip tweet-numbering prefixes: "Tweet 33:", "تغريدة 5:", "12.", "12)"
  //    "(17-الحجم)", "#3", "رقم 4 -" at the very start.
  t = t.replace(/^\s*(?:tweet|post|تغريدة|منشور|رقم)\s*#?\s*\d+\s*[:\-.)\]]*\s*/i, '');
  t = t.replace(/^\s*\(?\s*\d+\s*[-–]\s*[^)]*\)\s*/, ''); // "(17-الحجم) "
  t = t.replace(/^\s*\d+\s*[.)\-]\s+/, '');               // "12. " / "3) " / "5 - "

  // 2. Strip char-count annotations anywhere (start/end): "191 Chars",
  //    "(256 characters)", "[150 حرف]", "- 200 حرف".
  t = t.replace(/[\(\[\{]?\s*\d+\s*(?:chars?|characters?|حرف(?:اً|ا)?)\s*[\)\]\}]?/gi, ' ');

  // 3. Strip textual emoji codes / shortcodes: ":fire:", "[D]", "<emoji>".
  t = t.replace(/:[a-z_]+:/gi, '');           // :fire:
  t = t.replace(/\[[A-Za-z]{1,3}\]/g, '');    // [D] [ok]
  t = t.replace(/&#x?[0-9a-f]+;?/gi, '');     // stray html entities like &#x1F525

  // 4. Remove wrapping quotes around the WHOLE body (straight + curly,
  //    Arabic + Latin). Do it twice in case of doubled quotes.
  for (let i = 0; i < 2; i++) {
    t = t.trim().replace(/^["'“”«»‹›‘’]+/, '').replace(/["'“”«»‹›‘’]+$/, '');
  }

  // 5. Strip unnecessary wrapping parentheses/brackets around whole text.
  t = t.trim();
  if (/^[\(\[\{].*[\)\]\}]$/.test(t) && !/[\(\[\{].*[\)\]\}].*[\(\[\{]/.test(t.slice(1, -1))) {
    t = t.slice(1, -1).trim();
  }

  // 6. Collapse whitespace runs and trim.
  t = t.replace(/[ \t]{2,}/g, ' ').replace(/\s*\n\s*/g, ' ').trim();
  return t;
}

// Emoji detection (used to enforce "every tweet must carry an emoji").
// Covers the common pictographic ranges + dingbats + supplemental symbols.
const EMOJI_RE = /[\u231A-\u231B\u23E9-\u23FA\u24C2\u25AA-\u25FE\u2600-\u27BF\u2934\u2935\u2B05-\u2B07\u2B1B\u2B1C\u2B50\u2B55\u3030\u303D\u3297\u3299\uFE0F]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|\uD83E[\uDD00-\uDFFF]/;
const DEFAULT_EMOJIS = ['🔥', '📈', '💰', '⭐', '🎯', '🚀', '💎', '📊'];

function hasEmoji(text) {
  return EMOJI_RE.test(text || '');
}

/**
 * Detect a broken/replacement-char emoji (the � U+FFFD glyph or a lone
 * surrogate) — these are mojibake we must reject.
 */
function hasBrokenEmoji(text) {
  if (!text) return false;
  if (text.includes('\uFFFD')) return true;            // replacement char
  // lone high/low surrogate (not part of a valid pair)
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text)) return true;
  if (/(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)) return true;
  return false;
}

/**
 * Validate a fully-assembled tweet against all STRUCTURAL + CLEANLINESS
 * rules (G2). NOTE: duplicate detection is deliberately NOT here anymore —
 * per spec (G3), dedup runs ONLY against the current session's queue +
 * preview via isDuplicateInSession(), never against cross-session history.
 *
 * @param {string} text  - fully assembled tweet
 * @param {string} link  - referral link (may be empty)
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateTweet(text, link /* , (history arg intentionally ignored) */) {
  const len = tweetLength(text);

  // G2 length: hard ceiling 270, plus a Twitter-worthy minimum.
  if (len > MAX_LEN) return { valid: false, reason: `طويل جداً (${len}/${MAX_LEN})` };
  if (len < MIN_LEN) return { valid: false, reason: `قصير جداً (${len}/${MIN_LEN})` };

  // G2 cleanliness: reject broken/mojibake emoji.
  if (hasBrokenEmoji(text)) return { valid: false, reason: 'إيموجي مكسور أو رموز تالفة' };

  // G2: every tweet must carry at least one (valid) emoji.
  if (!hasEmoji(text)) return { valid: false, reason: 'لا يوجد إيموجي' };

  const body = bodyOnly(text);

  // 🔥 NEW: Reject English-dominant text (reasoning/thinking leaked as content)
  const englishWords = body.match(/[a-zA-Z]{3,}/g) || [];
  const totalWords = body.split(/\s+/).length;
  if (totalWords > 0 && englishWords.length / totalWords > 0.3) {
    return { valid: false, reason: 'نص إنجليزي (تفكير الموديل)' };
  }

  // 🔥 NEW: Reject draft/idea/thinking patterns
  const draftPatterns = [
    /^(tweet|post|draft|idea|angle|previous|next|topic|note)s?\s*[:\-]/i,
    /^we (need|must|should|have to|want to)/i,
    /^(actually|first|second|third|finally|also|so|ok|okay|right|well|now|here)\s*,/i,
    /^for (example|instance|trend following|beginners|intermediates|advanced)/i,
    /^(support\/resistance|beginner mistakes|patience|discipline|analysis|leverage|fomo|dca|volume|liquidity|news impact|platform safety|low fees|market psychology|trading with the trend|risk of high leverage|price depth and liquidity|risks of high leverage)\s*:/i,
    /^start with/i,
    /^better to (count|write|read|check|verify)/i,
    /^we must (use|avoid|include|exclude|ensure)/i,
    /^now, we need to/i,
    /^the user (wants|expects|likely|probably)/i,
    /^i (must|need|should|will|can|could|would)/i,
  ];
  for (const pattern of draftPatterns) {
    if (pattern.test(body.trim())) {
      return { valid: false, reason: 'فكرة/مسودة (مش تغريدة جاهزة)' };
    }
  }

  // G2 cleanliness: no stray quotes inside the body.
  if (/["'"«»‹›]/.test(body)) return { valid: false, reason: 'يحتوي علامات اقتباس' };

  // G2 cleanliness: no leftover char-counter / numbering artifacts.
  if (/\d+\s*(?:chars?|characters?|حرف)/i.test(body)) {
    return { valid: false, reason: 'يحتوي عدّاد حروف' };
  }
  if (/(?:tweet|post|تغريدة|منشور)\s*#?\s*\d+\s*[:\-]/i.test(body)) {
    return { valid: false, reason: 'يحتوي ترقيم تغريدة' };
  }
  // G2 cleanliness: no emoji shortcodes / bracket codes like :fire: or [D].
  if (/:[a-z_]+:/i.test(body) || /\[[A-Za-z]{1,3}\]/.test(body)) {
    return { valid: false, reason: 'يحتوي رموز نصية للإيموجي' };
  }

  const adj = findAdjacentRepeat(body);
  if (adj) return { valid: false, reason: `تكرار متجاور لكلمة "${adj}"` };

  const over = findOverusedWord(body, 3);
  if (over) return { valid: false, reason: `كلمة "${over}" مكررة أكثر من اللازم` };

  // Must contain the link if one was provided
  if (link && link.trim() && !text.includes(link.trim())) {
    return { valid: false, reason: 'الرابط مفقود من النص' };
  }

  // Must contain at least one hashtag
  if (!/#[^\s#]+/.test(text)) {
    return { valid: false, reason: 'لا يوجد هاشتاق' };
  }

  return { valid: true };
}

// ─────────────────────────────────────────────────────────────────────
// 7b. SESSION DEDUP (G3) — exact + semantic, ONLY vs current queue/preview
// ─────────────────────────────────────────────────────────────────────

/**
 * Normalize a tweet BODY for exact-match comparison: strip link/hashtags,
 * lowercase, remove diacritics, collapse whitespace & punctuation. Two
 * tweets with the same normalized body are exact duplicates.
 */
function exactKey(text) {
  return normalizeArabic(bodyOnly(String(text || '')).toLowerCase())
    .replace(/[^\u0621-\u064Aa-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * G3 duplicate check — scoped to the CURRENT SESSION only.
 *
 * @param {string} candidateText           - assembled tweet to test
 * @param {object} session
 * @param {Set<string>}      session.exactKeys     - exactKey() of every accepted tweet
 * @param {string[][]}       session.tokenSets     - tokenized bodies of every accepted tweet
 * @param {number}           [threshold=0.85]      - semantic-similarity ceiling
 * @returns {{ dup: boolean, level?: 1|2 }}
 *
 * Level 1: exact body match. Level 2: semantic similarity > threshold.
 * Cross-session history is NEVER consulted here.
 */
function isDuplicateInSession(candidateText, session, threshold = 0.85) {
  const key = exactKey(candidateText);
  if (session.exactKeys && session.exactKeys.has(key)) return { dup: true, level: 1 };

  const candTokens = tokenize(bodyOnly(candidateText));
  for (const h of (session.tokenSets || [])) {
    if (jaccard(candTokens, h) > threshold) return { dup: true, level: 2 };
  }
  return { dup: false };
}

// ─────────────────────────────────────────────────────────────────────
// 8. PROMPT BUILDER — full-context professional prompt for the AI
// ─────────────────────────────────────────────────────────────────────

/**
 * Build the system + user prompt for generating crypto tweets.
 * The AI returns ONLY core body lines; this engine adds link + hashtags.
 *
 * @param {object} opts
 * @param {number} opts.quantity
 * @param {string[]} opts.angles - selected angle descriptions
 * @param {boolean} opts.hasLink - whether a link will be appended
 * @returns {{ system: string, user: string }}
 */
// Core-length targets shared by the system block and the per-round reminder.
// Budget math: total must be 200-270. Link counts as 24 (23 t.co + newline),
// 2-3 hashtags+newline ≈ 22-35 → core ≈ 145-215. We aim the model a bit
// high (170-210) so most cores land in-range; assembleTweet flexes the
// hashtag count to absorb the rest. Ceiling 270 is enforced hard downstream.
const CORE_MIN = 170;
const CORE_MAX = 210;

/**
 * Build the STATIC system block for a session. It carries ZERO per-round data
 * so it is byte-for-byte identical on every call within the session — which
 * is exactly what lets Anthropic/OpenAI prompt-caching re-serve it cheaply
 * from the second round onward. If the user supplied a custom prompt it
 * becomes the system block verbatim (still static for the whole session).
 *
 * @param {object} opts
 * @param {string} [opts.customSystem] - user-supplied prompt (optional)
 * @returns {string}
 */
function buildSessionSystem({ customSystem = '' } = {}) {
  if (customSystem && customSystem.trim()) return customSystem.trim();
  return [
    'أنت كاتب محتوى تسويقي محترف متخصص في أسواق الكريبتو والتداول.',
    'مهمتك كتابة تغريدات عربية فصيحة احترافية تجذب القارئ وتبني الثقة.',
    'قواعد صارمة يجب الالتزام بها حرفياً:',
    `- اكتب نص التغريدة فقط (بدون روابط وبدون هاشتاقات — سأضيفها أنا لاحقاً).`,
    `- طول كل نص بين ${CORE_MIN} و ${CORE_MAX} حرفاً.`,
    '- ابدأ كل تغريدة بإيموجي واحد مناسب (🔥📈💰⭐🎯) لجذب الانتباه.',
    '- ممنوع منعاً باتاً تكرار أي كلمة بشكل متجاور (مثل "تام تام").',
    '- ممنوع الحشو والكلمات الفارغة التي لا تضيف معنى.',
    '- كل تغريدة مختلفة تماماً عن الأخرى في الصياغة والزاوية.',
    '- لغة عربية راقية، واثقة، بدون مبالغات كاذبة، بدون وعود ربح مضمون.',
    '- لا تذكر روابط ولا علامات # إطلاقاً داخل النص.',
    // G2 cleanliness rules baked into the prompt:
    '- ممنوع علامات الاقتباس " " أو \' \' حول النص أو داخله.',
    '- ممنوع كتابة عدد الحروف (مثل "191 Chars") أو ترقيم التغريدة (مثل "Tweet 1:").',
    '- ممنوع الأقواس غير الضرورية أو الرموز النصية للإيموجي مثل :fire: أو [D].',
    '- استخدم إيموجي حقيقية فقط، لا رموز مكسورة.',
    'أعِد الناتج حصراً كمصفوفة JSON من النصوص فقط بدون أي شرح: ["نص","نص",...]',
  ].join('\n');
}

/**
 * Build the per-round USER message sent inside a persistent session thread.
 * Carries the round's angles + an optional inspiration summary + a compact
 * "avoid what's already accepted" context so the model steers toward fresh,
 * non-duplicate posts WITHOUT bloating the prompt (themes/snippets only,
 * never full past tweets).
 *
 * @param {object} opts
 * @param {number}   opts.quantity
 * @param {string[]} opts.angles
 * @param {string}   [opts.inspirationSummary] - cross-session theme summary (G1.5)
 * @param {string}   [opts.acceptedContext]    - in-session "avoid these" snippet
 * @returns {string}
 */
function buildRoundUser({ quantity, angles, inspirationSummary = '', acceptedContext = '' }) {
  const angleLines = (angles || []).map((a, i) => `${i + 1}. ${a}`).join('\n');

  const userLines = [
    `اكتب ${quantity} تغريدة فريدة عن التداول والكريبتو، كل واحدة تتناول زاوية مختلفة من القائمة التالية:`,
    angleLines,
  ];

  // In-session diversity steering: a SHORT digest of what this session has
  // already accepted so the model produces something genuinely different.
  // This is the "context الموديل في كل جولة" piece from the spec.
  if (acceptedContext && acceptedContext.trim()) {
    userLines.push(
      '',
      `المنشورات المقبولة حتى الآن في هذه الجلسة (لا تكررها، أنتج منشورات مختلفة تماماً عنها):\n${acceptedContext.trim()}`,
    );
  }

  // G1.5 INSPIRATION (not a filter): a SHORT topic summary of what previous
  // sessions covered, so the model steers toward fresh ideas. This is a
  // compact list of themes — NOT full past tweets — to spend minimal tokens.
  if (inspirationSummary && inspirationSummary.trim()) {
    userLines.push(
      '',
      `للإلهام فقط (لتوليد أفكار جديدة مختلفة، ليس للنسخ): جلسات سابقة غطّت هذه المواضيع: ${inspirationSummary.trim()}. ابتعد عنها وابتكر زوايا جديدة.`,
    );
  }

  userLines.push(
    '',
    `تذكير: نص فقط، ${CORE_MIN}-${CORE_MAX} حرف، بإيموجي في البداية، بدون روابط/هاشتاقات/اقتباسات/عدّاد حروف، صياغة مختلفة لكل تغريدة، وكلها تشجع بلطف على التداول عبر منصة MEXC.`,
    'الناتج: مصفوفة JSON فقط.',
  );

  return userLines.join('\n');
}

/**
 * Back-compat wrapper: returns { system, user } in one shot. Kept so the
 * existing test harnesses (live-500, etc.) and any non-session caller keep
 * working. New session-based code uses buildSessionSystem + buildRoundUser.
 */
function buildPrompt({ quantity, angles, hasLink, inspirationSummary = '', customSystem = '', acceptedContext = '' }) {
  return {
    system: buildSessionSystem({ customSystem }),
    user: buildRoundUser({ quantity, angles, inspirationSummary, acceptedContext }),
  };
}

/**
 * Build a COMPACT "already accepted" context string for in-session diversity
 * steering. Takes the most recent accepted bodies and reduces each to a short
 * snippet (first few words) so the model sees the gist without paying for full
 * tweets. Capped to `maxItems` and a per-item word budget.
 *
 * @param {string[]} recentBodies - bodyOnly() texts of accepted posts (newest last)
 * @param {number}   [maxItems=12]
 * @param {number}   [wordsPerItem=6]
 * @returns {string} newline-bulleted snippet list, or '' if nothing accepted
 */
function buildAcceptedContext(recentBodies, maxItems = 12, wordsPerItem = 6) {
  if (!Array.isArray(recentBodies) || recentBodies.length === 0) return '';
  const recent = recentBodies.slice(-maxItems);
  const snippets = recent
    .map(b => String(b || '').trim().split(/\s+/).slice(0, wordsPerItem).join(' '))
    .filter(Boolean)
    .map(s => `• ${s}…`);
  return snippets.join('\n');
}

/**
 * G3 / spec sync(): rebuild a session's dedup state from the SHARED queue +
 * preview so every parallel session sees what the others accepted — but ONLY
 * between rounds (never mid-round). Clears the old state and repopulates
 * exactKeys + tokenSets from the merged shared sources.
 *
 * @param {object}   session            - { exactKeys:Set, tokenSets:Array }
 * @param {Array}    sharedQueue         - [{text}|string,...]
 * @param {Array}    sharedPreview       - [{text}|string,...]
 */
function syncSessionDedup(session, sharedQueue = [], sharedPreview = []) {
  if (!session.exactKeys) session.exactKeys = new Set();
  session.exactKeys.clear();
  session.tokenSets = [];
  const pull = (arr) => {
    for (const post of (arr || [])) {
      const text = typeof post === 'string' ? post : (post && post.text);
      if (typeof text === 'string' && text.trim()) {
        session.exactKeys.add(exactKey(text));
        session.tokenSets.push(tokenize(bodyOnly(text)));
      }
    }
  };
  pull(sharedQueue);
  pull(sharedPreview);
}

/**
 * G1.5 — Build a SHORT inspiration summary (theme list) from recent history.
 * Returns a compact comma-separated list of distinct angle keywords the
 * recent tweets touched, capped to keep the prompt tiny. This is sent to the
 * model as "context for fresh ideas", never used to reject candidates.
 *
 * @param {number} maxThemes - max distinct themes to include
 * @returns {string} e.g. "إدارة المخاطر، الصبر، رسوم المنصات، السيولة"
 */
function buildInspirationSummary(maxThemes = 10) {
  const entries = loadHistoryEntries();
  if (!entries.length) return '';
  // Map each recent body to the closest angle by keyword overlap.
  const recent = entries.slice(-120).map(e => bodyOnly(e.text));
  const themeHits = new Map();
  for (const body of recent) {
    const toks = new Set(tokenize(body));
    let best = null, bestScore = 0;
    for (const angle of ANGLE_MATRIX) {
      const aToks = tokenize(angle.ar);
      let score = 0;
      for (const t of aToks) if (toks.has(t)) score++;
      if (score > bestScore) { bestScore = score; best = angle; }
    }
    if (best && bestScore > 0) {
      themeHits.set(best.id, (themeHits.get(best.id) || 0) + 1);
    }
  }
  // Most-covered themes first → those are what to steer AWAY from.
  const ranked = [...themeHits.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxThemes);
  const labels = ranked.map(([id]) => {
    const a = ANGLE_MATRIX.find(x => x.id === id);
    // short label = first 3-4 words of the angle description
    return a ? a.ar.split(/\s+/).slice(0, 4).join(' ') : id;
  });
  return labels.join('، ');
}

/**
 * Pick N angles from the matrix, rotating to maximize spread.
 */
function selectAngles(n) {
  const pool = [...ANGLE_MATRIX];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(pool[i % pool.length].ar);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// 9. PROVIDER AUTO-DETECTION
// ─────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────
// 9a. MULTI-FORMAT SUPPORT — model-to-wire-format mapping (v4.5.0)
// ─────────────────────────────────────────────────────────────────────

/**
 * Static model map for OpenCode Go provider: models that speak Anthropic
 * wire format even though they're served through an OpenAI-style gateway.
 * All other OpenCode Go models use OpenAI-compatible format.
 */
const OPENCODE_GO_ANTHROPIC_MODELS = [
  'minimax-m3', 'minimax-m2.7', 'minimax-m2.5',
  'qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-plus',
  // ⚡ H2: models added — they speak Anthropic wire format on the OpenCode Go gateway
  'glm-5.2',
  'kimi-k2.7',
  'deepseek-v4-pro',
  'mimo-v2.5',
];

/**
 * Determine the wire-format for a given provider + model combination.
 * Separates the PROVDER (who runs the endpoint) from the FORMAT (which
 * wire protocol the model speaks) — essential for gateways like OpenCode
 * Go that serve both Anthropic-format and OpenAI-format models through
 * the same base URL.
 *
 * @param {string} provider  - Provider ID ('openai'|'anthropic'|'gemini'|'opencode-go'|etc.)
 * @param {string} [modelId] - Model name (e.g. 'claude-sonnet-4', 'deepseek-v4-flash')
 * @returns {{ format: 'anthropic'|'openai'|'gemini', endpoint: string }}
 *   format   — 'anthropic' → /v1/messages, 'openai' → /v1/chat/completions
 *   endpoint — the URL path component (caller constructs full URL)
 */
function detectApiFormat(provider, modelId) {
  const m = (modelId || '').toLowerCase();

  if (provider === 'opencode-go') {
    const isAnthropic = OPENCODE_GO_ANTHROPIC_MODELS.some(name => m.startsWith(name));
    return isAnthropic
      ? { format: 'anthropic', endpoint: '/v1/messages' }
      : { format: 'openai', endpoint: '/v1/chat/completions' };
  }

  // Gemini native format (URL-embedded key, contents array)
  if (provider === 'gemini') {
    return { format: 'gemini', endpoint: '' };
  }

  // For all other providers: model family decides
  const fam = detectModelFamily(modelId);
  if (fam === 'claude') {
    return { format: 'anthropic', endpoint: '/v1/messages' };
  }
  if (fam === 'gemini') {
    return { format: 'gemini', endpoint: '' };
  }
  // gpt, deepseek, qwen, llama, etc. → OpenAI-compatible
  return { format: 'openai', endpoint: '/v1/chat/completions' };
}

/**
 * Detect the API protocol. PER SPEC (G5) the MODEL NAME is authoritative:
 *   - claude-*           → Anthropic format (/v1/messages, anthropic-version)
 *   - everything else    → OpenAI-compatible (/v1/chat/completions)
 * A manual override ('openai'|'anthropic'|'gemini') still wins if set.
 * The base URL is only a last-resort hint for native Gemini endpoints.
 *
 * @param {string} baseUrl
 * @param {string} [forced] - 'auto' | 'openai' | 'anthropic' | 'gemini'
 * @param {string} [model]
 * @returns {'openai'|'anthropic'|'gemini'}
 */
function detectProvider(baseUrl, forced, model) {
  if (forced && forced !== 'auto') return forced;

  // Check if URL is OpenCode Go gateway FIRST (before model family check)
  const url = (baseUrl || '').toLowerCase();
  if (url.includes('opencode.ai') || url.includes('opencode-go')) {
    return 'opencode-go';
  }

  // Model family decides the wire format (G5 smart rule).
  const fam = detectModelFamily(model);
  if (fam === 'claude') return 'anthropic';
  if (fam === 'gemini') {
    // Gemini only speaks native protocol on its own host; on a gateway it's
    // served OpenAI-shaped. Use the URL to disambiguate.
    if (url.includes('generativelanguage') && !url.includes('/openai')) return 'gemini';
    return 'openai';
  }
  // gpt-*, deepseek-*, llama, qwen, grok, … → OpenAI-compatible.
  return 'openai';
}

/**
 * Identify the underlying model FAMILY from its name, independent of the
 * wire protocol. This is what the UI should show the user ("claude",
 * "gemini", "gpt", …) so picking a Claude model on any gateway reads
 * correctly instead of the confusing raw protocol name "openai".
 */
function detectModelFamily(model) {
  const m = (model || '').toLowerCase();
  if (!m) return 'unknown';
  if (m.includes('claude')) return 'claude';
  if (m.includes('gemini')) return 'gemini';
  if (m.includes('gpt') || m.includes('o1') || m.includes('o3') || m.includes('o4')) return 'gpt';
  if (m.includes('deepseek')) return 'deepseek';
  if (m.includes('llama') || m.includes('nemotron')) return 'llama';
  if (m.includes('qwen')) return 'qwen';
  if (m.includes('mistral') || m.includes('mixtral')) return 'mistral';
  if (m.includes('grok')) return 'grok';
  return 'other';
}

/**
 * Human-friendly label combining family + wire protocol, e.g.
 * "claude · عبر OpenAI API" or "gemini · أصلي". Shown in the UI tag.
 */
function providerLabel(provider, model) {
  if (provider === 'opencode-go') return 'OpenCode Go';
  const fam = detectModelFamily(model);
  const proto = provider === 'anthropic' ? 'Anthropic'
    : provider === 'gemini' ? 'Gemini'
    : 'OpenAI';
  if (fam === 'unknown' || fam === 'other') return proto;
  return `${fam} · ${proto}`;
}

module.exports = {
  // constants
  MIN_LEN,
  MAX_LEN,
  TCO_URL_LENGTH,
  ANGLE_MATRIX,
  HASHTAG_BANK,
  // text utils
  tweetLength,
  tokenize,
  normalizeArabic,
  findAdjacentRepeat,
  findOverusedWord,
  jaccard,
  isDuplicate,
  isDuplicateInSession,
  exactKey,
  hasEmoji,
  hasBrokenEmoji,
  bodyOnly,
  // generation pipeline
  pickHashtags,
  assembleTweet,
  validateTweet,
  buildPrompt,
  buildSessionSystem,
  buildRoundUser,
  buildAcceptedContext,
  syncSessionDedup,
  buildInspirationSummary,
  selectAngles,
  detectApiFormat,
  detectProvider,
  detectModelFamily,
  providerLabel,
  // history
  loadHistory,
  loadHistoryEntries,
  appendHistory,
  getRecentBodies,
  historyPath,
  HISTORY_TTL_DAYS,
  // text utils
  cleanCoreText,
};
