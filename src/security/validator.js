/**
 * ✅ Link Validator — Pre-publish post verification engine
 * ========================================================
 * BEFORE any post is published:
 *   1. Check if referral system is enabled (ReferralService)
 *   2. If DISABLED → flag foreign URLs but ALLOW publish (no referral needed)
 *   3. If ENABLED → verify all URLs match the session referral link
 *   4. Extract ALL URLs from the rendered text
 *   5. Verify every referral URL matches the session link
 *   6. If mismatch → block publish, log full diagnostics
 *   7. Detect: hardcoded URLs, mismatched ref codes, foreign domains
 */

const referralService = require('../automation/referralService');

const URL_RE = /https?:\/\/[^\s\n\r"']+/g;
const MEXC_DOMAIN_RE = /mexc\.com/i;

/**
 * Extract all URLs from post text.
 * @param {string} text
 * @returns {string[]}
 */
function extractUrls(text) {
  if (!text) return [];
  return [...text.matchAll(URL_RE)].map(m => m[0]);
}

/**
 * Normalize a URL for comparison (strip trailing slash, fragment).
 * @param {string} url
 * @returns {string}
 */
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return url.replace(/\/$/, '').replace(/#.*$/, '');
  }
}

/**
 * Validate a single post against the active referral link & toggle state.
 * 
 * @param {string} postText - The fully rendered post text
 * @param {string} [sessionLink] - Optional override link (uses ReferralService if omitted)
 * @returns {{ valid: boolean, reason?: string, detectedUrls: string[], diagnostics: object }}
 */
function validatePost(postText, sessionLink) {
  const detectedUrls = extractUrls(postText);
  const isEnabled = referralService.isEnabled();

  // Case 1: Referral system is DISABLED
  if (!isEnabled) {
    // Allow publish but warn about any detected URLs
    // (they should have been stripped by sanitizePost, but be safe)
    return {
      valid: true,
      hasMexcLink: detectedUrls.some(u => MEXC_DOMAIN_RE.test(u)),
      detectedUrls,
      reason: detectedUrls.length > 0
        ? 'REFERRAL_DISABLED: نظام الإحالة معطل. تم اكتشاف روابط في المنشور (سيتم نشرها بدون رابط إحالة).'
        : 'REFERRAL_DISABLED: نظام الإحالة معطل. يتم النشر بدون رابط إحالة.',
      diagnostics: { detectedUrls, referralEnabled: false }
    };
  }

  // Case 2: Referral system is ENABLED
  const activeLink = sessionLink || referralService.getLinkOrNull();
  
  // If no active link, should not happen (validation upstream), but handle gracefully
  if (!activeLink) {
    return {
      valid: false,
      reason: 'LINK_REQUIRED: نظام الإحالة مفعّل لكن لا يوجد رابط إحالة نشط.',
      detectedUrls,
      diagnostics: { detectedUrls, referralEnabled: true, activeLink: null }
    };
  }

  const normalizedSession = normalizeUrl(activeLink);

  // Check every detected URL
  for (const url of detectedUrls) {
    const normalizedUrl_ = normalizeUrl(url);

    // Check if it's a MEXC link
    if (MEXC_DOMAIN_RE.test(url)) {
      // MEXC link must EXACTLY match the session link (normalized)
      if (normalizedUrl_ !== normalizedSession) {
        return {
          valid: false,
          reason: `LINK_MISMATCH: رابط MEXC في المنشور لا يطابق رابط الإحالة النشط.\n  المنشور: ${url}\n  الجلسة:   ${activeLink}`,
          detectedUrls,
          diagnostics: {
            postUrl: url,
            sessionUrl: activeLink,
            normalizedPost: normalizedUrl_,
            normalizedSession,
          }
        };
      }
    } else {
      // Non-MEXC link detected (x.com, t.co, etc.) — suspicious for MEXC posts
      return {
        valid: false,
        reason: `FOREIGN_URL: تم اكتشاف رابط خارجي غير تابع لـ MEXC في المنشور: ${url}`,
        detectedUrls,
        diagnostics: {
          foreignUrl: url,
          sessionUrl: activeLink,
        }
      };
    }
  }

  // Case 3: No MEXC link found — warn but allow
  const hasMexcLink = detectedUrls.some(u => MEXC_DOMAIN_RE.test(u));

  return {
    valid: true,
    hasMexcLink,
    detectedUrls,
    reason: hasMexcLink ? null : 'WARNING: لا يوجد رابط MEXC في المنشور',
    diagnostics: { detectedUrls, referralEnabled: true, activeLink }
  };
}

/**
 * Validate ALL posts in a queue against the session link.
 * @param {Array} queue - Array of post items (strings or {text} objects)
 * @param {string} [sessionLink] - Optional override
 * @returns {{ passed: Array, failed: Array, diagnostics: Array }}
 */
function validateQueue(queue, sessionLink) {
  const passed = [];
  const failed = [];
  const diagnostics = [];

  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    const text = typeof item === 'string' ? item : (item.text || '');
    const result = validatePost(text, sessionLink);

    if (result.valid) {
      passed.push(item);
    } else {
      failed.push({ index: i, item, reason: result.reason });
    }

    diagnostics.push({
      index: i,
      text: text.slice(0, 100),
      valid: result.valid,
      detectedUrls: result.detectedUrls,
      reason: result.reason,
    });
  }

  return { passed, failed, diagnostics };
}

module.exports = {
  extractUrls,
  normalizeUrl,
  validatePost,
  validateQueue,
  URL_RE,
  MEXC_DOMAIN_RE,
};
