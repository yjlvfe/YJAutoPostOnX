'use strict';

const crypto = require('node:crypto');

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
      for (const item of state.items) if (item.state !== 'cancelled') {
        ids.add(item.id);
        payloadHashes.add(hash(item.payload));
      }
      for (const payload of list) {
        const contentHash = hash(payload);
        const requestedId = payload.id || contentHash;
        if (ids.has(requestedId) || payloadHashes.has(contentHash)) continue;
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
      if (['running', 'stopping'].includes(s.cycle?.state) || (s.items || []).some(x => ['processing', 'dispatch_started'].includes(x.state))) throw new Error('QUEUE_BUSY');
      if (queueFingerprint && hash((s.items || []).filter(x => x.state === 'pending').map(x => x.id).sort()) !== queueFingerprint) throw new Error('QUEUE_CHANGED');
      if (userKey) {
        const u = s.telegramUi?.users?.[userKey];
        if (!u || u.flowToken !== confirmationToken || u.prompt !== 'csvConfirm') throw new Error('STALE_CONFIRMATION');
        u.prompt = null; u.draft = null; u.flowToken = null; u.page = 'main';
      }
      for (const x of s.items || []) if (x.state === 'pending') { x.state = 'cancelled'; x.reason = 'queue_replaced'; }
      s.items ||= [];
      // Index after cancellation so old pending payloads can be imported again.
      const payloadHashes = new Set();
      for (const item of s.items) if (item.state !== 'cancelled') payloadHashes.add(hash(item.payload));
      for (const payload of payloads) {
        const id = hash(payload);
        if (payloadHashes.has(id)) continue;
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
      next.items ||= [];
      const item = next.items.find(entry => entry.state === 'pending' && predicate(entry));
      if (item) { addressableItem(next, item.id); item.state = 'processing'; item.claimedAt = new Date().toISOString(); claimedId = item.id; }
      return next;
    });
    return claimedId ? state.items.find(item => item.id === claimedId) : null;
  }
  async complete(id, result = {}) { return this.store.update(state => { const item = addressableItem(state, id); item.state = 'done'; item.result = result; item.completedAt = new Date().toISOString(); return state; }); }
  async fail(id, error) { return this.store.update(state => { const item = addressableItem(state, id); item.state = 'failed'; item.error = String(error?.message || error); return state; }); }
  async requeue(id, result = {}) { return this.store.update(state => { const item = addressableItem(state, id); item.state = 'pending'; item.result = result; delete item.claimedAt; return state; }); }
  async recoverProcessing({ state = 'ambiguous', reason = 'restart' } = {}) {
    return this.store.update(current => {
      for (const item of current.items || []) {
        if (item.state === 'processing' || item.state === 'dispatch_started') {
          if (item.attempt?.phase === 'claimed') {
            item.state = 'pending';
            delete item.attempt;
            delete item.claimedAt;
          } else {
            item.state = state;
            item.outcome = state;
            item.reason = reason;
            item.result = { ...(item.result || {}), reason };
            if (item.attempt?.accountId) item.accountId ||= item.attempt.accountId;
            if (item.attempt?.token) item.result.attemptToken ||= item.attempt.token;
            item.completedAt = new Date().toISOString();
          }
        }
      }
      return current;
    });
  }
  async pending() { const state = await this.store.load(); return (state.items || []).filter(x => x.state === 'pending'); }
  async outcomes() { const state = await this.store.load(); return (state.items || []).filter(x => ['published', 'ambiguous', 'failed'].includes(x.state)); }
}

class CycleState {
  constructor(store) { this.store = store; }
  async get() { const state = await this.store.load(); return state.cycle || { state: 'stopped', runId: null }; }
  async set(next) { return this.store.update(state => { state.cycle = { ...(state.cycle || {}), ...next, updatedAt: new Date().toISOString() }; return state; }).then(s => s.cycle); }
  async start(runId = crypto.randomUUID()) { return this.set({ state: 'running', runId }); }
  async stop() { return this.set({ state: 'stopped', runId: null }); }
}

module.exports = { Queue, CycleState, hash, stableStringify };
