'use strict';

const crypto = require('node:crypto');
const { recordUnsuccessfulAttempt } = require('./attemptOutcomes');

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

const hash = value => crypto.createHash('sha256').update(stableStringify(value)).digest('hex');

function uniqueRecordId(ids, requestedId) {
  let id = requestedId;
  while (ids.has(id)) id = crypto.randomUUID();
  return id;
}

function addressableItem(state, id) {
  const matches = (state.items || []).filter(item => item.id === id);
  if (matches.length !== 1 || matches[0].state === 'cancelled') throw new Error('Queue item not found');
  return matches[0];
}

// Moves one item to the absolute end of state.items and mirrors the move in
// telegramUi.run.itemIds. Used for definitive pre-dispatch failures returned to
// pending and for crash-recovered items: they land behind every existing pending
// item. Held (ambiguous) items are ordered separately by orderHeldItemsAtTail().
const isHeldItem = entry => Boolean(entry) && entry.state === 'ambiguous';
const hasOwnerHandoff = item => Boolean(item) && Object.hasOwn(item, 'ownerAssistedPackage');

function moveItemToQueueTail(state, itemOrId) {
  if (!state || !Array.isArray(state.items)) return null;
  const isObj = typeof itemOrId === 'object' && itemOrId !== null;
  const targetId = isObj ? itemOrId.id : itemOrId;
  let idx = isObj ? state.items.indexOf(itemOrId) : -1;
  if (idx === -1 && targetId !== undefined) {
    idx = state.items.findIndex(entry => entry && entry.id === targetId);
  }
  let moved = null;
  if (idx !== -1) {
    [moved] = state.items.splice(idx, 1);
    state.items.push(moved);
  }
  const resolvedId = moved?.id ?? targetId;
  if (
    resolvedId !== undefined &&
    state.telegramUi &&
    state.telegramUi.run &&
    Array.isArray(state.telegramUi.run.itemIds)
  ) {
    const itemIds = state.telegramUi.run.itemIds;
    const runIdx = itemIds.indexOf(resolvedId);
    if (runIdx !== -1) {
      itemIds.splice(runIdx, 1);
      itemIds.push(resolvedId);
    }
  }
  return moved;
}

// Mirrors src/runner.js MAX_PRE_DISPATCH_RETRIES (asserted equal in test 12).
const MAX_PRE_DISPATCH_RETRIES = 3;

// True when ANY durable evidence says the publish call may have reached X.
// Such an item may never go back to the claimable pool automatically.
function hasDispatchEvidence(item) {
  if (!item || typeof item !== 'object') return false;
  if (item.dispatchStartedAt || item.dispatchFence || item.dispatchAck || item.dispatch_ack) return true;
  const attempts = [item.attempt, item.archivedAttempt, ...(Array.isArray(item.archivedAttempts) ? item.archivedAttempts : [])];
  return attempts.some(attempt => attempt && typeof attempt === 'object' &&
    ((attempt.phase && attempt.phase !== 'claimed') || attempt.dispatchStartedAt || attempt.dispatchAck || attempt.dispatch_ack));
}

// Strict proof used by crash recovery: only a plain 'processing' claim whose
// attempt never left phase 'claimed' and has no dispatch evidence may return to
// pending. 'dispatch_started' is never pre-dispatch, whatever attempt.phase says.
function isProvenPreDispatch(item) {
  return Boolean(item) && item.state === 'processing' && item.attempt?.phase === 'claimed' &&
    (!Object.hasOwn(item, 'archivedAttempts') || Array.isArray(item.archivedAttempts)) && !hasDispatchEvidence(item);
}

// Queue-level claim eligibility: pending, never dispatched, retries not exhausted.
// An owner handoff remains fenced even if its package is malformed or claims
// settlement: only the verified settlement path may resolve that uncertainty.
function isClaimable(item) {
  if (!item || item.state !== 'pending') return false;
  if (hasOwnerHandoff(item)) return false;
  if (hasDispatchEvidence(item)) return false;
  if (Object.hasOwn(item, 'archivedAttempts') && !Array.isArray(item.archivedAttempts)) return false;
  if ((item.archivedAttempts || []).some(a => a && a.phase && a.phase !== 'claimed')) return false;
  if ((item.preDispatchRetries || 0) >= MAX_PRE_DISPATCH_RETRIES) return false;
  return true;
}

// Text fences intentionally ignore account and media: an unresolved or already
// published post must not become eligible merely by changing import metadata.
function normalizedPostText(payload) {
  return typeof payload?.text === 'string' ? payload.text.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase() : '';
}
function protectedTextKeys(itemsOrState, explicitState = null) {
  const state = explicitState || (itemsOrState && Array.isArray(itemsOrState.items) ? itemsOrState : null);
  const items = Array.isArray(itemsOrState) ? itemsOrState : (itemsOrState?.items || []);
  const keys = new Set(items.filter(item => item.state !== 'cancelled' && !isClaimable(item))
    .map(item => normalizedPostText(item.payload)).filter(Boolean));
  // Historical ambiguous items are removed from the operational queue during
  // cleanup, but their content fingerprints remain a permanent no-republish
  // fence. Keep this fence separate from the user-visible item inventory.
  for (const key of state?.ambiguousFences || []) if (typeof key === 'string' && key) keys.add(key);
  return keys;
}
function isClaimableInState(item, state, protectedTexts = protectedTextKeys(state.items || [], state)) {
  return isClaimable(item) && !protectedTexts.has(normalizedPostText(item.payload));
}

// Stable partition: every state==='ambiguous' (held) item goes behind every
// other item, preserving relative order inside both groups. Never changes any
// item's content. Mirrors telegramUi.run.itemIds. Idempotent.
// moves = held items that currently have a non-held item after them (the number
// of held items that must be relocated); a second call returns moves 0.
function orderHeldItemsAtTail(state) {
  const empty = { moves: 0, held: 0, changed: false };
  if (!state || !Array.isArray(state.items)) return empty;
  const items = state.items;
  const isHeld = isHeldItem;
  let lastNonHeld = -1;
  for (let i = items.length - 1; i >= 0; i--) if (!isHeld(items[i])) { lastNonHeld = i; break; }
  let held = 0, moves = 0;
  items.forEach((entry, i) => { if (isHeld(entry)) { held++; if (i < lastNonHeld) moves++; } });
  if (moves > 0) {
    const keep = items.filter(entry => !isHeld(entry));
    const tail = items.filter(isHeld);
    items.splice(0, items.length, ...keep, ...tail);
  }
  const runIds = state.telegramUi?.run?.itemIds;
  let runChanged = false;
  if (Array.isArray(runIds)) {
    const heldIds = new Set(items.filter(isHeld).map(entry => entry.id));
    const keepIds = runIds.filter(id => !heldIds.has(id));
    const tailIds = runIds.filter(id => heldIds.has(id));
    const next = [...keepIds, ...tailIds];
    if (next.some((id, i) => id !== runIds[i])) { runIds.splice(0, runIds.length, ...next); runChanged = true; }
  }
  return { moves, held, changed: moves > 0 || runChanged };
}

class Queue {
  constructor(store) { this.store = store; }
  async enqueue(items) {
    const list = Array.isArray(items) ? items : [items];
    return this.store.update(state => {
      state.items ||= [];
      // Cancelled payloads remain admissible, but their record IDs remain
      // retained history and can never be assigned to a new row.
      const retainedIds = new Set(state.items.map(item => item.id));
      const ids = new Set();
      const payloadHashes = new Set();
      const protectedTexts = protectedTextKeys(state.items, state);
      for (const item of state.items) if (item.state !== 'cancelled') {
        ids.add(item.id);
        payloadHashes.add(hash(item.payload));
      }
      for (const payload of list) {
        const contentHash = hash(payload);
        const requestedId = payload.id || contentHash;
        if (ids.has(requestedId) || payloadHashes.has(contentHash) || protectedTexts.has(normalizedPostText(payload))) continue;
        const id = uniqueRecordId(retainedIds, requestedId);
        state.items.push({ id, payload, state: 'pending', createdAt: new Date().toISOString() });
        retainedIds.add(id);
        ids.add(id);
        ids.add(requestedId);
        payloadHashes.add(contentHash);
      }
      return state;
    }).then(state => state.items.filter(item => item.state === 'pending'));
  }
  async replacePending(payloads, { userKey, confirmationToken, queueFingerprint } = {}) {
    let added = 0;
    await this.store.update(s => {
      added = 0;
      if (['running', 'stopping'].includes(s.cycle?.state) || (s.items || []).some(x => ['processing', 'dispatch_started'].includes(x.state))) throw new Error('QUEUE_BUSY');
      if (queueFingerprint && hash((s.items || []).filter(x => x.state === 'pending').map(x => x.id).sort()) !== queueFingerprint) throw new Error('QUEUE_CHANGED');
      if (userKey) {
        const u = s.telegramUi?.users?.[userKey];
        if (!u || u.flowToken !== confirmationToken || u.prompt !== 'csvConfirm') throw new Error('STALE_CONFIRMATION');
        u.prompt = null; u.draft = null; u.flowToken = null; u.page = 'main';
      }
      // Preserve all fenced pending records, including dispatch evidence and
      // exhausted retries, so replacement cannot turn uncertainty into a retry.
      for (const x of s.items || []) if (isClaimable(x)) { x.state = 'cancelled'; x.reason = 'queue_replaced'; }
      s.items ||= [];
      // Index after cancellation so old pending payloads can be imported again.
      const payloadHashes = new Set();
      const protectedTexts = protectedTextKeys(s.items, s);
      for (const item of s.items) if (item.state !== 'cancelled') payloadHashes.add(hash(item.payload));
      for (const payload of payloads) {
        const id = hash(payload);
        if (payloadHashes.has(id) || protectedTexts.has(normalizedPostText(payload))) continue;
        s.items.push({ id: crypto.randomUUID(), contentHash: id, payload, state: 'pending', createdAt: new Date().toISOString() }); added++;
        payloadHashes.add(id);
      }
      return s;
    });
    return added;
  }
  async claimNext(predicate = () => true) {
    let claimedId = null;
    const state = await this.store.update(next => {
      claimedId = null;
      next.items ||= [];
      const protectedTexts = protectedTextKeys(next.items, next);
      const item = next.items.find(entry => isClaimableInState(entry, next, protectedTexts) && predicate(entry));
      if (item) { addressableItem(next, item.id); item.state = 'processing'; item.claimedAt = new Date().toISOString(); item.attempt = { phase: 'claimed', claimedAt: item.claimedAt, token: crypto.randomUUID() }; claimedId = item.id; }
      return next;
    });
    return claimedId ? state.items.find(item => item.id === claimedId) : null;
  }
  async complete(id, result = {}) { return this.store.update(state => { const item = addressableItem(state, id); item.state = 'done'; item.result = result; item.completedAt = new Date().toISOString(); return state; }); }
  async fail(id, error) { return this.store.update(state => { const item = addressableItem(state, id); item.state = 'failed'; item.error = String(error?.message || error); return state; }); }
  async requeue(id, result = {}) {
    return this.store.update(state => {
      const item = addressableItem(state, id);
      if (hasOwnerHandoff(item)) {
        const err = new Error(`OWNER_ASSISTED_REQUEUE_FORBIDDEN: Cannot requeue item ${id} with an owner handoff`);
        err.code = 'OWNER_ASSISTED_REQUEUE_FORBIDDEN';
        throw err;
      }
      if (['ambiguous', 'published', 'done', 'dispatch_started'].includes(item.state) || hasDispatchEvidence(item) || (item.state === 'processing' && !isProvenPreDispatch(item))) {
        const err = new Error(`AMBIGUOUS_REQUEUE_FORBIDDEN: Cannot requeue item ${id} from state '${item.state}'`);
        err.code = 'AMBIGUOUS_REQUEUE_FORBIDDEN';
        throw err;
      }
      item.state = 'pending';
      item.result = result;
      delete item.attempt;
      delete item.claimedAt;
      item.preDispatchRetries = (item.preDispatchRetries || 0) + 1;
      moveItemToQueueTail(state, item);
      return state;
    });
  }
  async recoverProcessing({ state = 'ambiguous', reason = 'restart' } = {}) {
    const targetOutcome = state === 'pending' ? 'ambiguous' : state;
    return this.store.update(current => {
      let transitioned = false;
      for (const item of [...(current.items || [])]) {
        if (item.state === 'processing' || item.state === 'dispatch_started') {
          const attempt = item.attempt;
          const accountId = attempt?.accountId || item.accountId;
          const attemptToken = attempt?.token;
          const runId = attempt?.runId || current.telegramUi?.run?.runId || current.cycle?.runId;
          const preDispatch = isProvenPreDispatch(item);
          if (attempt) {
            const archived = { ...structuredClone(attempt), failedAt: new Date().toISOString(), outcomeState: preDispatch ? 'failed' : targetOutcome,
              ...(preDispatch ? { preDispatchRetry: true } : {}) };
            item.archivedAttempt = archived;
            item.archivedAttempts = [...(Array.isArray(item.archivedAttempts) ? item.archivedAttempts : []), archived].slice(-10);
          }
          if (preDispatch) {
            item.state = 'pending';
            delete item.attempt;
            delete item.claimedAt;
            recordUnsuccessfulAttempt(current, {
              accountId,
              outcome: 'failed',
              runId,
              itemId: item.id,
              attemptToken,
              at: new Date(),
              preDispatchRetry: true
            });
            moveItemToQueueTail(current, item);
          } else {
            item.state = targetOutcome;
            item.outcome = targetOutcome;
            item.reason = reason;
            item.result = { ...(item.result || {}), reason };
            if (accountId) item.accountId ||= accountId;
            if (attemptToken) item.result.attemptToken ||= attemptToken;
            item.completedAt = new Date().toISOString();
            delete item.attempt;
            delete item.claimedAt;
            recordUnsuccessfulAttempt(current, {
              accountId,
              outcome: targetOutcome,
              runId,
              itemId: item.id,
              attemptToken,
              at: new Date()
            });
          }
          transitioned = true;
        }
      }
      if (transitioned) {
        orderHeldItemsAtTail(current);
        if (current.posting) current.posting.publishingAt = null;
      }
      return current;
    });
  }
  // By default retain the historical inventory view. Claimable-only callers
  // must use the same protected-text fence as atomic claims so UI counts do not
  // advertise owner handoffs or dispatch-evidenced rows as runnable work.
  async pending({ claimableOnly = false } = {}) {
    const state = this.store.section ? { items: await this.store.section('items') } : await this.store.load();
    if (!claimableOnly) return (state.items || []).filter(x => x.state === 'pending');
    const protectedTexts = protectedTextKeys(state.items || [], state);
    return (state.items || []).filter(x => isClaimableInState(x, state, protectedTexts));
  }
  async outcomes() { const state = this.store.section ? { items: await this.store.section('items') } : await this.store.load(); return (state.items || []).filter(x => ['published', 'ambiguous', 'failed'].includes(x.state)); }
}

class CycleState {
  constructor(store) { this.store = store; }
  async get() { const state = await this.store.load(); return state.cycle || { state: 'stopped', runId: null }; }
  async set(next) { return this.store.update(state => { state.cycle = { ...(state.cycle || {}), ...next, updatedAt: new Date().toISOString() }; return state; }).then(s => s.cycle); }
  async start(runId = crypto.randomUUID()) { return this.set({ state: 'running', runId }); }
  async stop() { return this.set({ state: 'stopped', runId: null }); }
}

module.exports = { Queue, CycleState, hash, stableStringify, moveItemToQueueTail, orderHeldItemsAtTail, hasDispatchEvidence, isProvenPreDispatch, isClaimable, isClaimableInState, normalizedPostText, protectedTextKeys, MAX_PRE_DISPATCH_RETRIES };
