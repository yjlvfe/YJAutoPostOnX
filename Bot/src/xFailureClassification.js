'use strict';

// A confirmed content-rejection code in a CreateTweet GraphQL error is not
// evidence that the X account itself is broken. The dispatched post remains
// quarantined until authoritative reconciliation, never silently retried.
const CONTENT_CODES = new Set([186, 187]);
function isXContentRejection({ failure, xErrorCode, xResponseKind } = {}) {
  if (failure !== 'ambiguous' || xResponseKind !== 'graphql_errors') return false;
  if (!(typeof xErrorCode === 'number' || typeof xErrorCode === 'string')) return false;
  const n = Number(xErrorCode);
  return Number.isSafeInteger(n) && CONTENT_CODES.has(n);
}
module.exports = { isXContentRejection };
