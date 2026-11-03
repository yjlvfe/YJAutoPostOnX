'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { SqliteStore } = require('../src/sqliteStore');

const REVERT_ITEMS = [
  {
    id: '3a982de7-76b0-450f-a712-e10861b26dda',
    reason: 'publish_confirmation_missing',
    accountId: 'x-ab22678a0fc05660b440',
    accountUsername: 'emiehg',
    claimedAt: '2026-11-03T03:02:24.194Z',
    revertReason: 'historical_date_mismatch_oct26_vs_nov3_attempt'
  },
  {
    id: '4d9df18c-075e-4e25-97c5-8b524ee5624f',
    reason: 'publish_confirmation_missing',
    accountId: 'x-ab22678a0fc05660b440',
    accountUsername: 'emiehg',
    claimedAt: '2026-11-03T04:17:05.726Z',
    revertReason: 'historical_date_mismatch_oct30_vs_nov3_attempt'
  },
  {
    id: '6bd6d6cf-f275-4ac2-9042-a0886d958c41',
    reason: 'publish_confirmation_missing',
    accountId: 'x-86ef47c7166eaeb29e1a',
    accountUsername: 'kaniabq',
    claimedAt: '2026-11-03T04:18:08.401Z',
    revertReason: 'author_and_date_mismatch_kaniabq_attempt_vs_emiehg_oct30_tweet'
  },
  {
    id: '53d0f458-3144-4e89-a1af-202a8893afc6',
    reason: 'unresolved_in_finally',
    accountId: undefined,
    accountUsername: undefined,
    claimedAt: '2026-11-01T19:50:53.963Z',
    attempt: {
      phase: 'dispatching',
      token: '8818b5b7-f8a1-4395-8414-4da9c0a26c06',
      runId: 'b359f1952ba311c990ba4fe5',
      accountId: 'x-930e0054b395228aefa9',
      startedAt: '2026-11-01T19:50:53.963Z'
    },
    revertReason: 'quarantine_preservation_for_unresolved_in_finally_baseline'
  }
];

async function main() {
  const dbPath = path.resolve(__dirname, '../data/state.sqlite');
  console.log('Reverting false recoveries in SqliteStore at:', dbPath);
  const store = new SqliteStore(dbPath);

  let revertedCount = 0;
  let remainingAmbiguous = 0;
  let totalPublished = 0;

  await store.update(state => {
    state.items ||= [];
    state.forensicLogs ||= [];

    const byId = new Map(REVERT_ITEMS.map(r => [r.id, r]));

    for (const item of state.items) {
      if (byId.has(item.id)) {
        const rev = byId.get(item.id);
        console.log(`Reverting item ${item.id} -> ambiguous (${rev.revertReason})`);
        item.state = 'ambiguous';
        item.reason = rev.reason;
        item.claimedAt = rev.claimedAt;
        if (rev.accountId) item.accountId = rev.accountId; else delete item.accountId;
        if (rev.accountUsername) item.accountUsername = rev.accountUsername; else delete item.accountUsername;
        if (rev.attempt) item.attempt = rev.attempt; else delete item.attempt;
        delete item.url;
        delete item.tweetId;
        delete item.publishedAt;
        delete item.recoveredFromTimeline;
        delete item.failureDiagnostic;
        revertedCount++;
      }
    }

    remainingAmbiguous = state.items.filter(i => i.state === 'ambiguous').length;
    totalPublished = state.items.filter(i => i.state === 'published').length;

    state.forensicLogs.push({
      timestamp: new Date().toISOString(),
      eventType: 'm11_revert_false_recovery',
      details: {
        revertedCount,
        remainingAmbiguous,
        totalPublished,
        items: REVERT_ITEMS.map(r => ({ itemId: r.id, revertReason: r.revertReason }))
      }
    });

    return state;
  });

  store.close();
  console.log(`Reversion completed: ${revertedCount} items returned to ambiguous quarantine.`);
  console.log(`Remaining ambiguous: ${remainingAmbiguous} (expected 30).`);
  console.log(`Total published: ${totalPublished} (expected 155).`);

  // Clean links_2026-11-01.csv
  const csvPath = path.resolve(__dirname, '../data/exports/links_2026-11-01.csv');
  if (fs.existsSync(csvPath)) {
    const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
    // Remove the row for 53d0f458 if present
    const filtered = lines.filter(line => !line.includes('2116981347772498219'));
    fs.writeFileSync(csvPath, filtered.join('\n') + '\n', 'utf8');
    console.log(`Cleaned ${csvPath}: ${lines.length} -> ${filtered.length} lines.`);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('Reversion failed:', err);
    process.exit(1);
  });
}

module.exports = { main, REVERT_ITEMS };
