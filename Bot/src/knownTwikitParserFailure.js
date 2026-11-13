'use strict';

// A known Twikit profile decoding failure is a library error, not an X
// account-specific failure. Generic ambiguous publishes retain the existing
// three-natural-turn strike policy. Avoid broad error-text matching.
function isKnownTwikitParserFailure({ failure, rawError } = {}) {
  if (failure !== 'ambiguous' || typeof rawError !== 'string') return false;
  const value = rawError.trim();
  // Python str(KeyError('urls')) yields "'urls'", not "KeyError: 'urls'".
  return /^(?:KeyError\s*:\s*)?['"]urls['"]$/i.test(value) || /^KeyError\(['"]urls['"]\)$/i.test(value);
}

module.exports = { isKnownTwikitParserFailure };
