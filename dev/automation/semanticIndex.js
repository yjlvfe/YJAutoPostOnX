/**
 * semanticIndex.js — meaning-level duplicate rejection at 100k+ scale
 * ====================================================================
 * The old guard compared word-BIGRAMS at 0.85 Jaccard inside a recency
 * window: it caught near-verbatim copies only — the model could repeat the
 * SAME IDEA in different wording forever, and anything older than the
 * window was never compared at all.
 *
 * This index rejects duplicates BY MEANING:
 *   - Arabic-aware normalization + light stemming + stopword removal, so
 *     "المتداولون"/"للمتداول" and "وقفُ الخسارة"/"وقف خسارتك" compare equal.
 *   - IDF weighting: rare concept words (رافعة، سيولة، وقف…) carry the
 *     similarity; generic domain filler (تداول، سوق، عملة…) that EVERY
 *     tweet shares is automatically down-weighted as the corpus grows.
 *   - An inverted index (token → posting list) makes every check touch only
 *     documents that actually share meaningful words — NO window, NO decay:
 *     tweet #1 is still compared when tweet #100,000 arrives, at ~constant
 *     cost per check.
 *
 * Layers per check (any hit ⇒ duplicate):
 *   level 1 — exact: identical normalized body.
 *   level 2 — rephrase: IDF-weighted Jaccard ≥ simThreshold.
 *   level 3 — containment: one tweet's weighted vocabulary is ≥
 *             containThreshold inside the other's (subset paraphrase).
 */

'use strict';

// Function words that never carry an idea. Domain words (تداول، سوق…) are
// deliberately NOT listed — IDF demotes them dynamically instead.
const STOPWORDS = new Set([
  // Arabic function words (pre-normalized forms: ا for أ/إ/آ, ه for ة, ي for ى)
  'في', 'من', 'الي', 'علي', 'عن', 'مع', 'هو', 'هي', 'هم', 'هن', 'انت', 'انا', 'نحن',
  'ان', 'انه', 'انها', 'انهم', 'اذا', 'لو', 'لما', 'لن', 'لم', 'لا', 'ما', 'ماذا',
  'هذا', 'هذه', 'ذلك', 'تلك', 'الذي', 'التي', 'الذين', 'حتي', 'ثم', 'او', 'ام', 'بل',
  'قد', 'كل', 'بعض', 'غير', 'بين', 'عند', 'عندما', 'قبل', 'بعد', 'فوق', 'تحت',
  'كان', 'كانت', 'يكون', 'تكون', 'ليس', 'ليست', 'منذ', 'حين', 'كما', 'مثل',
  'اي', 'ايضا', 'فقط', 'كي', 'لكي', 'لان', 'لانه', 'لانها', 'بدون', 'دون', 'حول',
  'نحو', 'لدي', 'لديك', 'عليك', 'عليه', 'عليها', 'فيه', 'فيها', 'منه', 'منها',
  'اليه', 'اليها', 'معه', 'معها', 'الا', 'له', 'لها', 'لهم', 'لك', 'به', 'بها',
  'هنا', 'هناك', 'حيث', 'كيف', 'متي', 'اين', 'لماذا', 'مهما', 'كلما', 'بينما',
  'اما', 'اذ', 'اذن', 'لكن', 'لكنه', 'لكنها', 'فان', 'وان', 'ولا', 'وما', 'ولم',
  'ولن', 'فلا', 'ابدا', 'دائما', 'جدا', 'اكثر', 'اقل', 'اهم', 'يجب', 'يمكن',
  'يمكنك', 'تستطيع', 'يستطيع', 'اصبح', 'صار', 'مازال', 'زال', 'ظل', 'بات',
  // English function words
  'the', 'a', 'an', 'to', 'of', 'in', 'on', 'is', 'are', 'was', 'and', 'or',
  'for', 'with', 'at', 'by', 'it', 'its', 'be', 'as', 'this', 'that', 'you',
  'your', 'not', 'no', 'do', 'if', 'so', 'but', 'we', 'they', 'he', 'she',
]);

/** Strip diacritics/tatweel and unify letter variants (same as contentEngine). */
function normalizeArabic(text) {
  return String(text || '')
    .replace(/[ؗ-ًؚ-ْٰـ]/g, '')
    .replace(/[إأآا]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .trim();
}

/** Remove URLs and hashtags — meaning lives in the body text only. */
function bodyOnly(text) {
  return String(text || '')
    .replace(/https?:\/\/[^\s]+/g, ' ')
    .replace(/#[^\s#]+/g, ' ')
    .trim();
}

/**
 * Conservative Arabic light stemmer — strips definite articles, common
 * attached conjunction+article prefixes, and frequent suffixes, so surface
 * variants of the same concept word land on one stem. Deliberately shallow:
 * over-stemming merges DIFFERENT concepts, which is worse than missing a
 * variant.
 */
function stem(w) {
  if (w.length >= 5) {
    for (const p of ['وال', 'بال', 'فال', 'كال', 'لل']) {
      if (w.startsWith(p)) { w = w.slice(p.length); break; }
    }
  }
  if (w.length >= 4 && w.startsWith('ال')) w = w.slice(2);
  if (w.length >= 5) {
    for (const s of ['ات', 'ون', 'ين', 'ها', 'هم', 'كم', 'نا', 'ته', 'تك']) {
      if (w.endsWith(s)) { w = w.slice(0, -s.length); break; }
    }
  }
  // Feminine/possessive single-char tail: خساره/خسارتك → خسار، مالك → مال.
  // Applied consistently on BOTH sides, so variants of one concept converge.
  if (w.length >= 4 && (w.endsWith('ه') || w.endsWith('ك'))) w = w.slice(0, -1);
  return w;
}

/** Unique concept stems of a tweet body (stopwords removed, stemmed). */
function conceptStems(text) {
  const cleaned = normalizeArabic(bodyOnly(text).toLowerCase());
  const words = cleaned.match(/[ء-يa-z0-9]+/g) || [];
  const out = new Set();
  for (const w of words) {
    if (w.length < 2 || STOPWORDS.has(w)) continue;
    const s = stem(w);
    if (s.length >= 2 && !STOPWORDS.has(s)) out.add(s);
  }
  return out;
}

// Ultra-common crypto/trading stems (post-stem() forms). EVERY tweet in this
// domain uses them, so sharing them says nothing about sharing an IDEA. They
// get a pseudo document-frequency prior so they are down-weighted from the
// very first document — live IDF alone needs ~50 docs to learn this.
const DOMAIN_COMMON = new Set([
  'تداول', 'متداول', 'سوق', 'اسواق', 'كريبتو', 'عمل', 'عملات', 'سعر', 'اسعار',
  'سعري', 'ربح', 'ارباح', 'خسار', 'خسائر', 'صفق', 'محفظ', 'استثمار', 'مال',
  'راس', 'حساب', 'منص', 'مخاطر', 'خطر', 'تحليل', 'مؤشر', 'اتجاه', 'شراء',
  'بيع', 'دخول', 'خروج', 'هدف', 'حجم', 'حرك', 'قرار', 'خط', 'استراتيجي',
  'نجاح', 'ناجح', 'فرص', 'مبتدئ', 'محترف', 'قاعد', 'تعلم', 'مدي', 'طويل',
  'قصير', 'وقت', 'يوم', 'خبر', 'مستثمر', 'منصه', 'مركز', 'امر', 'اوامر',
]);

/** Normalized exact-match key for a tweet body. */
function exactKey(text) {
  return normalizeArabic(bodyOnly(text).toLowerCase())
    .replace(/[^ء-يa-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

class SemanticIndex {
  /**
   * @param {object} [opts]
   * @param {number} [opts.simThreshold]     IDF-weighted Jaccard ⇒ rephrase dup
   * @param {number} [opts.containThreshold] weighted containment ⇒ subset dup
   * @param {number} [opts.maxEval]          max candidate docs scored per check
   */
  constructor(opts = {}) {
    // Calibrated on paraphrase/distinct corpora at N=6 and N=20k (stable
    // across scale): genuinely different topics max-score ≤0.13, worst-case
    // same-idea rewrites (every non-concept word replaced) score ≥0.31, and
    // typical model self-repeats score far higher.
    //
    // MIDDLE-GROUND (v5.11.0, user request): the original 0.35/0.28 rejected
    // ~83% of AI output as same-meaning once the corpus passed a few thousand
    // posts ("صارم لدرجة الجنون"). Raised so that only CLEAR rephrases are
    // rejected: same theme with different specifics (numbers, scenarios,
    // named concepts) now passes; blatant restatements (which score well
    // above 0.5) and exact matches (level 1) are still always rejected.
    //
    // VOLUME-PRIORITY (v5.12.1, user request): at 14k+ corpus scale the
    // 0.5/0.42 gate was still rejecting the vast majority of candidates —
    // the user explicitly asked for maximum throughput, accepting that a
    // rephrased repeat of an existing idea should pass ("حتى لو تكرر المعنى
    // بصيغة مختلفة نمشيها"), relying on the dynamic-prompt angle-exclusion
    // system (contentEngine's ANGLE_MATRIX + burned-id tracking) rather than
    // this gate to keep output feeling varied. Raised again so even a CLEAR
    // paraphrase (measured score ~0.44 on the calibration corpus) now passes;
    // only near-verbatim restatements and exact matches (level 1, always
    // rejected regardless of threshold) are blocked.
    this.simThreshold = opts.simThreshold ?? 0.68;
    this.containThreshold = opts.containThreshold ?? 0.6;
    this.maxEval = opts.maxEval ?? 200;
    this.tokenIds = new Map();  // stem -> int id
    this.df = [];               // id -> document frequency
    this.isCommon = [];         // id -> stem is in DOMAIN_COMMON
    this.postings = [];         // id -> number[] (doc ids containing the stem)
    this.docs = [];             // doc id -> Int32Array of stem ids
    this.exact = new Set();     // exactKey() of every indexed doc
  }

  get size() { return this.docs.length; }

  _idsOf(text, createMissing) {
    const stems = conceptStems(text);
    const ids = [];
    for (const s of stems) {
      let id = this.tokenIds.get(s);
      if (id === undefined) {
        if (!createMissing) continue;   // unseen stem can't match anything
        id = this.df.length;
        this.tokenIds.set(s, id);
        this.df.push(0);
        this.postings.push([]);
        this.isCommon.push(DOMAIN_COMMON.has(s));
      }
      ids.push(id);
    }
    return ids;
  }

  _idfRaw(df, common) {
    // Smoothed IDF over the current corpus — recomputed live so weights
    // keep adapting as the corpus grows. Known domain filler carries a
    // pseudo-frequency prior so it is demoted even in a tiny corpus.
    const prior = common ? Math.max(4, this.docs.length * 0.15) : 0;
    return Math.log(1 + (this.docs.length + 1) / (1 + df + prior));
  }

  _idf(id) {
    return this._idfRaw(this.df[id], this.isCommon[id]);
  }

  /** Index a tweet. Safe to call with anything — empty texts are ignored. */
  add(text) {
    const key = exactKey(text);
    if (!key) return false;
    this.exact.add(key);
    const ids = this._idsOf(text, true);
    if (ids.length === 0) return false;
    const docId = this.docs.length;
    this.docs.push(Int32Array.from(ids));
    for (const id of ids) {
      this.df[id]++;
      this.postings[id].push(docId);
    }
    return true;
  }

  /**
   * Duplicate check against EVERYTHING ever indexed (no window).
   * @returns {{dup: boolean, level?: 1|2|3, score?: number}}
   *   level 1 exact · level 2 rephrase (weighted Jaccard) · level 3 containment
   */
  check(text) {
    const key = exactKey(text);
    if (!key) return { dup: false };
    if (this.exact.has(key)) return { dup: true, level: 1, score: 1 };

    const stems = conceptStems(text);
    if (stems.size === 0) return { dup: false };

    const N = this.docs.length;
    if (N === 0) return { dup: false };
    // Stems present in a large share of the corpus retrieve half the index
    // and carry almost no meaning — exclude them from BOTH sides of the
    // similarity consistently.
    const dfCap = Math.max(50, Math.ceil(N * 0.12));

    const weights = new Map();       // known id -> idf (retrieval + numerator)
    let candW = 0;
    for (const s of stems) {
      const id = this.tokenIds.get(s);
      if (id === undefined) {
        // Never indexed ⇒ can't match any doc, but it IS part of what this
        // candidate says — it must count in the candidate's total weight.
        // Dropping it collapses the denominator and turns 2-3 shared filler
        // words into a bogus high containment score. Weighted as a RARE
        // indexed stem (df=1), not df=0 — the df=0 premium would instead
        // over-inflate the denominator and mask true paraphrases.
        candW += this._idfRaw(1, DOMAIN_COMMON.has(s));
        continue;
      }
      if (this.df[id] > dfCap) continue;
      const w = this._idf(id);
      weights.set(id, w);
      candW += w;
    }
    if (candW === 0 || weights.size === 0) return { dup: false };

    // Retrieval: accumulate shared IDF weight per doc via posting lists.
    const shared = new Map();        // docId -> Σ idf of shared stems
    for (const [id, w] of weights) {
      const list = this.postings[id];
      for (let i = 0; i < list.length; i++) {
        shared.set(list[i], (shared.get(list[i]) || 0) + w);
      }
    }
    if (shared.size === 0) return { dup: false };

    // Score the strongest candidates only (top maxEval by shared weight).
    let entries = [...shared.entries()];
    if (entries.length > this.maxEval) {
      entries.sort((a, b) => b[1] - a[1]);
      entries = entries.slice(0, this.maxEval);
    }
    let best = 0;
    for (const [docId, sharedW] of entries) {
      // Doc weight under the SAME df-cap filter, with live IDF.
      const docIds = this.docs[docId];
      let docW = 0;
      for (let i = 0; i < docIds.length; i++) {
        if (this.df[docIds[i]] > dfCap) continue;
        docW += this._idf(docIds[i]);
      }
      if (docW === 0) continue;
      const jac = sharedW / (candW + docW - sharedW);
      // Coverage in BOTH directions: "the candidate restates this doc"
      // (docCov) or "this doc already covers the candidate" (candCov).
      const contain = Math.max(sharedW / docW, sharedW / candW);
      if (jac >= this.simThreshold) {
        return { dup: true, level: 2, score: Math.round(jac * 100) / 100 };
      }
      if (contain >= this.containThreshold) {
        return { dup: true, level: 3, score: Math.round(contain * 100) / 100 };
      }
      if (jac > best) best = jac;
      if (contain > best) best = contain;
    }
    return { dup: false, score: Math.round(best * 100) / 100 };
  }
}

module.exports = { SemanticIndex, conceptStems, stem, exactKey: exactKey, STOPWORDS };
