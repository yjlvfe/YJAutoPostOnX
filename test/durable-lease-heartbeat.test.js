'use strict';

/**
 * XP-011 — the live engine never renewed its lease.
 *
 * DurableSession exposed a `heartbeat()` method. The test driver in
 * test/helpers/dispatchDriver.js called it; xPoster.js — the code that actually
 * publishes — did not. Preparation (human-like typing delays, a media upload, a
 * toast wait) can easily outlast a lease, and when it did the claim silently
 * expired mid-composition: the boundary refused with LEASE_EXPIRED after all
 * the work was done, and worse, a second worker could lease the very item this
 * one was still typing.
 *
 * The renewal is now structural — started by claimNext(), stopped by every
 * terminal transition — so it cannot be forgotten by a caller again.
 *
 * These tests run against a real WorkflowStore with a deliberately short lease
 * so "longer than the lease" takes seconds, not minutes.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkflowStore } = require('../dev/automation/workflowStore');
const { DurableSession } = require('../dev/automation/durableSession');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xposter-heartbeat-'));
let n = 0;
let passed = 0;
let failed = 0;

function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
}

function fresh(label) {
  const dir = path.join(root, `${label}-${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  const store = new WorkflowStore({ rootDir: dir });
  const profile = store.createProfile({ name: `P-${label}`, requestId: `p-${label}` });
  const run = store.startRun({ requestId: `r-${label}` });
  return { store, profileId: profile.id, runId: run.id };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Preparation that outlasts the lease must still reach the boundary. */
async function preparationLongerThanLeaseKeepsTheClaim() {
  console.log('\n📋 XP-011.1 preparation longer than the lease');
  const { store, profileId, runId } = fresh('long-prep');
  try {
    store.enqueue({ items: [{ text: 'LONG_PREP' }], requestId: 'e1' });
    const session = new DurableSession({ store, profileId, runId, profileName: 'P' });

    const LEASE_MS = 3000;
    const claim = session.claimNext({ leaseMs: LEASE_MS });
    assert.ok(claim, 'expected a claim');
    check('a held claim is heartbeating', session.heartbeatActive === true);

    // Compose for twice the lease.
    await sleep(LEASE_MS * 2);

    const dispatch = session.beginDispatch('LONG_PREP');
    check('the boundary is reached even though preparation outlasted the lease',
      dispatch.ok === true, `code=${dispatch.code}`);
    check('the heartbeat stops once the dispatch is committed',
      session.heartbeatActive === false);

    if (dispatch.ok) {
      session.markPublished({ externalUrl: 'https://x.com/i/web/status/hb1' });
    }
  } finally { store.close(); }
}

/** While one worker prepares, nobody else may take the item. */
async function noSecondWorkerCanStealAHeldClaim() {
  console.log('\n📋 XP-011.2 a renewed claim is not stealable');
  const { store, profileId, runId } = fresh('steal');
  try {
    store.enqueue({ items: [{ text: 'HELD' }], requestId: 'e1' });
    const worker1 = new DurableSession({ store, profileId, runId, profileName: 'P' });

    const LEASE_MS = 3000;
    worker1.claimNext({ leaseMs: LEASE_MS });
    await sleep(LEASE_MS * 2);

    // A competing run, exactly as a second profile would.
    const run2 = store.startRun({ requestId: 'r-steal-2' });
    const worker2 = new DurableSession({ store, profileId, runId: run2.id, profileName: 'P' });
    const stolen = worker2.claimNext({ leaseMs: LEASE_MS });

    check('a second worker cannot claim an actively-held item', stolen === null,
      `second worker got: ${stolen && stolen.text}`);

    const dispatch = worker1.beginDispatch('HELD');
    check('the original owner still owns the boundary', dispatch.ok === true, `code=${dispatch.code}`);
    if (dispatch.ok) worker1.markPublished({ externalUrl: 'https://x.com/i/web/status/hb2' });
    worker2._stopHeartbeat();
  } finally { store.close(); }
}

/** Every terminal transition must stop the timer — no leaked intervals. */
async function terminalTransitionsStopTheHeartbeat() {
  console.log('\n📋 XP-011.3 the heartbeat stops on every exit path');
  const { store, profileId, runId } = fresh('stop-paths');
  try {
    store.enqueue({
      items: [{ text: 'T1' }, { text: 'T2' }, { text: 'T3' }],
      requestId: 'e1',
    });
    const session = new DurableSession({ store, profileId, runId, profileName: 'P' });

    session.claimNext({ leaseMs: 60_000 });
    session.release('released');
    check('release() stops the heartbeat', session.heartbeatActive === false);

    session.claimNext({ leaseMs: 60_000 });
    session.markDeferred('transient', null, 60_000);
    check('markDeferred() stops the heartbeat', session.heartbeatActive === false);

    session.claimNext({ leaseMs: 60_000 });
    session.markTerminal('permanent');
    check('markTerminal() stops the heartbeat', session.heartbeatActive === false);
  } finally { store.close(); }
}

/** A renewal that keeps failing must not spin forever. */
async function heartbeatFailureIsBounded() {
  console.log('\n📋 XP-011.4 a failing heartbeat gives up instead of spinning');
  const { store, profileId, runId } = fresh('hb-fail');
  try {
    store.enqueue({ items: [{ text: 'FAILING' }], requestId: 'e1' });
    const session = new DurableSession({ store, profileId, runId, profileName: 'P' });
    session.claimNext({ leaseMs: 3000 });

    let renewCalls = 0;
    const realRenew = store.renewLease.bind(store);
    store.renewLease = () => { renewCalls++; throw new Error('renew exploded'); };

    await sleep(4500);
    store.renewLease = realRenew;

    check('renewal failures stop after the bounded retry budget', renewCalls <= 3,
      `renewCalls=${renewCalls}`);
    check('the heartbeat is no longer running', session.heartbeatActive === false);
    check('the failure is recorded rather than swallowed',
      !!session.lastHeartbeatError, `lastHeartbeatError=${JSON.stringify(session.lastHeartbeatError)}`);
  } finally { store.close(); }
}

(async () => {
  console.log('=== XP-011: lease heartbeat during preparation ===');
  try {
    await preparationLongerThanLeaseKeepsTheClaim();
    await noSecondWorkerCanStealAHeldClaim();
    await terminalTransitionsStopTheHeartbeat();
    await heartbeatFailureIsBounded();
  } catch (error) {
    failed++;
    console.error('\n❌ suite threw:', error && error.stack ? error.stack : error);
  }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(`\n${failed === 0 ? '✅' : '❌'} durable-lease-heartbeat: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
