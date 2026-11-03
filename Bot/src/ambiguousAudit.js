'use strict';
const { sanitizeString } = require('./structuredLogger');

// Read-only. Absence from timeline or absence of a prior log is not proof of
// nonpublication. Never return an automatically retryable list from this API.
function buildAmbiguousInventory(state, { maxEventsPerItem = 8 } = {}) {
  const items = (state?.items || []).filter(item => item?.state === 'ambiguous');
  const forensic = state?.forensicLogs || [];
  const eventsById = new Map();
  for (const event of forensic) {
    const itemId = event?.details?.itemId;
    if (!itemId) continue;
    const arr = eventsById.get(itemId) || [];
    arr.push(event);
    eventsById.set(itemId, arr);
  }
  return items.map(item => {
    const events = (eventsById.get(item.id) || [])
      .slice(-maxEventsPerItem).map(e => ({
        at: e.timestamp || null,
        type: e.eventType || null,
        code: e.xErrorCode ?? null,
        message: e.xErrorMessage ? sanitizeString(String(e.xErrorMessage)).slice(0, 512) : null
      }));
    const last = item.failureDiagnostic || {};
    return {
      itemId: item.id,
      state: 'ambiguous',
      accountId: item.accountId || null,
      accountUsername: item.accountUsername || null,
      reason: item.reason ? sanitizeString(String(item.reason)).slice(0, 256) : null,
      attemptRecordedAt: last.observedAt || null,
      xResponseKind: last.xResponseKind || null,
      xErrorCode: last.xErrorCode ?? null,
      xErrorMessage: last.xErrorMessage ? sanitizeString(String(last.xErrorMessage)).slice(0, 512) : null,
      verificationError: last.verificationError ? sanitizeString(String(last.verificationError)).slice(0, 512) : null,
      httpStatus: Number.isInteger(last.httpStatus) ? last.httpStatus : null,
      forensicEvents: events,
      evidenceStatus: !Object.keys(last).length && !events.length ? 'HISTORICAL_EVIDENCE_MISSING' :
        'REVIEW_REQUIRED',
      requeueApproved: false
    };
  });
}

module.exports = { buildAmbiguousInventory };
