'use strict';
const { isDefinitiveXRejection } = require('./xFailureClassification');

// A started dispatch is an irreversible X boundary. Even a rate-limit-labelled
// result may have reached X; only an affirmative verified URL confirms success.
function classifyPublishOutcome(result, dispatchEntered = false) {
  const entered = typeof dispatchEntered === 'object' && dispatchEntered !== null
    ? Boolean(dispatchEntered.dispatchEntered)
    : Boolean(dispatchEntered || result?.dispatchEntered);
  if (result?.published === true && result.url) return 'published';
  if (entered && isDefinitiveXRejection(result)) return 'failed';
  if (entered || result?.published || result?.ambiguous) return 'ambiguous';
  if (result?.status === 'dry_run') return 'dry_run';
  if (result?.status === 'owner_assisted') return 'owner_assisted';
  if (result?.rateLimit || result?.accountFailure === 'rate_limit') return 'pending';
  if (['text_too_long', 'tweet_too_long', 'rejected_length_exceeded'].includes(result?.reason)) return 'cancelled';
  return 'pending';
}

function buildOwnerAssistedIntent({ item, account } = {}) {
  const text = String(item?.payload?.text || '');
  return {
    status: 'owner_assisted',
    published: false,
    posted: false,
    ambiguous: false,
    itemId: item?.id || null,
    accountId: account?.id || null,
    username: account?.username || null,
    text,
    intentUrl: 'https://x.com/intent/post?text=' + encodeURIComponent(text)
  };
}

module.exports = { classifyPublishOutcome, buildOwnerAssistedIntent };
