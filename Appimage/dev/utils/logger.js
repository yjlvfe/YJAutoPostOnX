/**
 * Simple debug logger — gated by DEBUG=1 env var.
 * All diagnostic console.logs go through log.debug() so production
 * builds (DEBUG unset) stay silent.
 */
const isDebug = process.env.DEBUG === '1' || process.env.DEBUG === 'true';

function debug(...args) {
  if (isDebug) console.log(...args);
}

function error(...args) {
  console.error(...args);
}

function info(...args) {
  console.log(...args);
}

module.exports = { debug, error, info };
