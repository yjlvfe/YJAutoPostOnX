'use strict';

// A confirmed content-rejection code in a CreateTweet GraphQL error is not
// evidence that the X account itself is broken. The dispatched post remains
// quarantined until authoritative reconciliation, never silently retried.
const CONTENT_CODES = new Set([186, 187, 226]);
const CONTENT_REASONS = new Set(['duplicate_content', 'length_exceeded', 'tweet_tombstone', 'content_moderation']);

function isXContentRejection({ failure, xErrorCode, xResponseKind, rejectionReason } = {}) {
  if (failure === 'banned' || failure === 'captcha') return false;
  if (rejectionReason && CONTENT_REASONS.has(rejectionReason)) return true;
  if (failure && failure !== 'ambiguous') return false;
  if ((!failure || failure === 'ambiguous') && xResponseKind === 'graphql_errors') {
    const n = Number(xErrorCode);
    if (Number.isSafeInteger(n) && CONTENT_CODES.has(n)) return true;
  }
  return false;
}
// Require the bridge's explicit GraphQL rejection and its recognized numeric code.
// Unknown/contradictory evidence remains held even after dispatch.
const DEFINITIVE_CODES = new Set([32, 63, 64, 88, 89, 99, 135, 141, 185, 186, 187, 215, 226, 231, 241, 326, 344, 353, 399]);
function isDefinitiveXRejection(result) {
  const code = Number(result?.xErrorCode);
  return result?.status === 'rejected' && result?.definitiveRejection === true &&
    result?.published === false && result?.ambiguous === false && result?.retryable === false &&
    result?.xResponseKind === 'graphql_errors' && Number.isSafeInteger(code) && DEFINITIVE_CODES.has(code);
}
module.exports = { isXContentRejection, isDefinitiveXRejection };
