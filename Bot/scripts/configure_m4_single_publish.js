'use strict';

const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const path = require('node:path');

const dbPath = path.resolve(__dirname, '../data/state.sqlite');
const db = new DatabaseSync(dbPath);

const row = db.prepare('SELECT revision, json FROM state WHERE id = 1').get();
const state = JSON.parse(row.json);

const targetItemId = '04e2f5fa-0dfa-439f-87bd-589ba767df18';
const targetAccountId = 'x-930e0054b395228aefa9';

const item = (state.items || []).find(i => i.id === targetItemId);
if (!item) {
  throw new Error(`Target item ${targetItemId} not found in state.sqlite`);
}
if (item.state !== 'pending') {
  throw new Error(`Target item ${targetItemId} is not in pending state (current: ${item.state})`);
}

const account = (state.accounts || []).find(a => a.id === targetAccountId);
if (!account) {
  throw new Error(`Target account ${targetAccountId} not found in state.sqlite`);
}
if (account.enabled === false) {
  throw new Error(`Target account ${targetAccountId} is not enabled`);
}

// Pin item to account
item.payload = item.payload || {};
item.payload.account = targetAccountId;

// Configure bounded run for exactly 1 item
const runId = crypto.randomUUID();
state.telegramUi = state.telegramUi || {};
state.telegramUi.run = {
  runId,
  source: 'manual',
  itemIds: [targetItemId],
  accountIds: [targetAccountId],
  maxItems: 1,
  stopAfterSuccess: true,
  cursor: 0
};

state.cycle = {
  state: 'running',
  runId,
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  reason: null
};

// Clear nextPostAt so there is zero sleep delay before publication
state.posting = state.posting || {};
state.posting.nextPostAt = null;

db.prepare('UPDATE state SET json = ?, revision = revision + 1 WHERE id = 1').run(JSON.stringify(state));
console.log('Successfully configured bounded single-item publish in state.sqlite:');
console.log({ runId, targetItemId, targetAccountId, state: 'running', stopAfterSuccess: true });
db.close();
