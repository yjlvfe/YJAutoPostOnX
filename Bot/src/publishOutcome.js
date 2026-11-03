'use strict';

// A started dispatch is an irreversible X boundary. Even a rate-limit-labelled
// result may have reached X; only an affirmative verified URL confirms success.
function classifyPublishOutcome(result, dispatchEntered = false) {
  if (result?.published === true && result.url) return 'published';
  if (dispatchEntered || result?.published || result?.ambiguous) return 'ambiguous';
  if (result?.rateLimit || result?.accountFailure === 'rate_limit') return 'pending';
  if (['text_too_long', 'tweet_too_long'].includes(result?.reason)) return 'cancelled';
  return 'pending';
}

module.exports = { classifyPublishOutcome };
