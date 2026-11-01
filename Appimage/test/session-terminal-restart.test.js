'use strict';

const assert = require('assert');
const { SessionManager, GenerationSession, STATUS } = require('../dev/automation/sessionManager');

function makeSession(status) {
  const session = new GenerationSession(50, 'SYS');
  session.status = status;
  if (status === STATUS.TERMINAL) {
    session._terminal = true;
    session._terminalReason = 'provider_rejected_credentials';
    session._lastError = '401 unauthorized';
    session._consecutiveFailures = 5;
    session._noProgressRounds = 10;
  }
  return session;
}

const terminal = makeSession(STATUS.TERMINAL);
const snapshot = terminal.toJSON();

assert.strictEqual(snapshot.status, STATUS.TERMINAL, 'terminal status is persisted');
assert.strictEqual(snapshot.terminalReason, 'provider_rejected_credentials', 'terminal reason is persisted');
assert.strictEqual(snapshot.lastError, '401 unauthorized', 'last error is persisted');
assert.strictEqual(snapshot.consecutiveFailures, 5, 'consecutive failure count is persisted');
assert.strictEqual(snapshot.noProgressRounds, 10, 'no-progress count is persisted');

const restored = GenerationSession.fromJSON(snapshot, 'SYS');
assert.strictEqual(restored.status, STATUS.TERMINAL, 'terminal status survives restart');
assert.strictEqual(restored._terminal, true, 'terminal marker survives restart');
assert.strictEqual(restored._terminalReason, 'provider_rejected_credentials', 'terminal reason survives restart');
assert.strictEqual(restored._lastError, '401 unauthorized', 'last error survives restart');
assert.strictEqual(restored._consecutiveFailures, 5, 'consecutive failure count survives restart');
assert.strictEqual(restored._noProgressRounds, 10, 'no-progress count survives restart');
assert.notStrictEqual(restored.status, STATUS.WAITING, 'a terminal session is not revived as waiting');

const resumed = new SessionManager({ sessionCount: 1 });
resumed.loadSessions([snapshot]);
resumed._reconcileSessionCount(1);
assert.strictEqual(resumed.sessions[0].status, STATUS.TERMINAL, 'reconciliation does not revive terminal sessions');
assert.strictEqual(resumed.resetTerminalSessions(), 1, 'explicit reset revives terminal sessions');
assert.strictEqual(resumed.sessions[0].status, STATUS.WAITING, 'reset returns terminal session to waiting');

for (const status of [STATUS.STOPPED, STATUS.DONE, STATUS.CANCELLED]) {
  const roundTripped = GenerationSession.fromJSON(makeSession(status).toJSON(), 'SYS');
  assert.strictEqual(roundTripped.status, status, `${status} status survives restart`);
}

const stoppedManager = new SessionManager({ sessionCount: 1 });
stoppedManager.loadSessions([
  makeSession(STATUS.WAITING).toJSON(),
  makeSession(STATUS.STOPPED).toJSON(),
]);
stoppedManager._reconcileSessionCount(1);
assert.strictEqual(stoppedManager.sessions[1].status, STATUS.STOPPED, 'stopped remains parked when out of scope');
stoppedManager._reconcileSessionCount(2);
assert.strictEqual(stoppedManager.sessions[1].status, STATUS.WAITING, 'stopped remains reversible when count rises');

for (const status of [STATUS.TERMINAL, STATUS.DONE, STATUS.CANCELLED]) {
  const nonRespawnable = makeSession(status);
  nonRespawnable.num = 2;
  const scopedManager = new SessionManager({ sessionCount: 1 });
  scopedManager.loadSessions([makeSession(STATUS.WAITING).toJSON(), nonRespawnable.toJSON()]);
  scopedManager._reconcileSessionCount(1);
  assert.strictEqual(
    scopedManager.sessions[1].status,
    status,
    `${status} is not parked as stopped by count reduction`,
  );
  scopedManager._reconcileSessionCount(2);
  assert.strictEqual(
    scopedManager.sessions[1].status,
    status,
    `${status} is not revived by count increase`,
  );
}

console.log('✅ session-terminal-restart: terminal lifecycle state survives serialization and reconciliation');
