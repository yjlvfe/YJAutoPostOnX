'use strict';
/**
 * Strict project-wide session cap guard.
 * Enforces a hard ceiling of at most 5 concurrent DirectX / Twikit / browser
 * sessions across all containers, processes, and accounts.
 */

const MAX_PROJECT_SESSIONS = 5;
const activeSessions = new Map();

function countActiveSessions() {
  // Prune any dead or expired leases (> 120s TTL)
  const now = Date.now();
  for (const [id, lease] of activeSessions.entries()) {
    if (lease.expiresAt && lease.expiresAt < now) {
      activeSessions.delete(id);
    }
  }
  return activeSessions.size;
}

function acquireSession({ accountId, pid, ttlMs = 120_000 } = {}) {
  const currentCount = countActiveSessions();
  if (currentCount >= MAX_PROJECT_SESSIONS) {
    const err = new Error(`MAX_PROJECT_SESSIONS_EXCEEDED: Cannot open DirectX session for account ${accountId || 'unknown'}. Project-wide limit of ${MAX_PROJECT_SESSIONS} concurrent sessions reached (active: ${currentCount}).`);
    err.code = 'MAX_PROJECT_SESSIONS_EXCEEDED';
    err.activeCount = currentCount;
    err.maxLimit = MAX_PROJECT_SESSIONS;
    throw err;
  }

  const leaseId = `${accountId || 'anon'}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  const lease = {
    leaseId,
    accountId: accountId || null,
    pid: pid || null,
    acquiredAt: now,
    expiresAt: now + ttlMs,
    released: false
  };

  activeSessions.set(leaseId, lease);

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    lease.released = true;
    activeSessions.delete(leaseId);
  };

  return { leaseId, release, lease };
}

function getSessionAudit() {
  const currentCount = countActiveSessions();
  const sessions = Array.from(activeSessions.values()).map(s => ({
    leaseId: s.leaseId,
    accountId: s.accountId,
    pid: s.pid,
    ageMs: Date.now() - s.acquiredAt,
    expiresInMs: Math.max(0, s.expiresAt - Date.now())
  }));
  return {
    maxLimit: MAX_PROJECT_SESSIONS,
    activeCount: currentCount,
    availableSlots: Math.max(0, MAX_PROJECT_SESSIONS - currentCount),
    sessions
  };
}

function resetSessionsForTest() {
  activeSessions.clear();
}

module.exports = {
  MAX_PROJECT_SESSIONS,
  acquireSession,
  countActiveSessions,
  getSessionAudit,
  resetSessionsForTest
};
