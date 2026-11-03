'use strict';

// A confirmed content-rejection code in a CreateTweet GraphQL error is not
// evidence that the X account itself is broken. The dispatched post remains
// quarantined until authoritative reconciliation, never silently retried.
const CONTENT_CODES = new Set([186, 187]);
const CONTENT_REASONS = new Set(['duplicate_content', 'length_exceeded', 'tweet_tombstone']);

function isXContentRejection({ failure, xErrorCode, xResponseKind, rejectionReason } = {}) {
  if (failure && failure !== 'ambiguous') return false;
  if (rejectionReason && CONTENT_REASONS.has(rejectionReason)) return true;
  if (failure === 'ambiguous' && xResponseKind === 'graphql_errors') {
    const n = Number(xErrorCode);
    if (Number.isSafeInteger(n) && CONTENT_CODES.has(n)) return true;
  }
  return false;
}
module.exports = { isXContentRejection };
