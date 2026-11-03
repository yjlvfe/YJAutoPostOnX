'use strict';
// FATAL SAFETY GUARD: This migration is permanently disabled.
// The recovery attempted here was audited in M11 Round 9 and proven to contain false recoveries
// due to author and historical date mismatches. All items were reverted via revert_false_recovery_m11.js.
if (require.main === module) {
  console.error('CRITICAL: apply_m11_ambiguous_recovery.js is PERMANENTLY DISABLED to protect production state.');
  console.error('Historical items were audited in M11 and returned to ambiguous quarantine.');
  process.exit(1);
}

const path = require('node:path');
const fs = require('node:fs');
const { SqliteStore } = require('../src/sqliteStore');

const CONFIRMED_PUBLISHED = [
  {
    itemId: '3a982de7-76b0-450f-a712-e10861b26dda',
    tweetId: '2114831811599556964',
    url: 'https://x.com/emiehg/status/2114831811599556964',
    account: 'emiehg',
    accountId: 'x-ab22678a0fc05660b440',
    publishedAt: '2026-10-26T21:29:30.000Z'
  },
  {
    itemId: '4d9df18c-075e-4e25-97c5-8b524ee5624f',
    tweetId: '2116085589598482612',
    url: 'https://x.com/emiehg/status/2116085589598482612',
    account: 'emiehg',
    accountId: 'x-ab22678a0fc05660b440',
    publishedAt: '2026-10-30T08:31:34.000Z'
  },
  {
    itemId: '6bd6d6cf-f275-4ac2-9042-a0886d958c41',
    tweetId: '2116086313573400734',
    url: 'https://x.com/emiehg/status/2116086313573400734',
    account: 'emiehg',
    accountId: 'x-ab22678a0fc05660b440',
    publishedAt: '2026-10-30T08:34:26.000Z'
  },
  {
    itemId: '53d0f458-3144-4e89-a1af-202a8893afc6',
    tweetId: '2116981347772498219',
    url: 'https://x.com/crytpokingxvo8/status/2116981347772498219',
    account: 'crytpokingxvo8',
    accountId: 'x-930e0054b395228aefa9',
    publishedAt: '2026-11-01T19:50:59.000Z'
  }
];

async function main() {
  const dbPath = path.resolve(__dirname, '../data/state.sqlite');
  console.log('Opening SqliteStore at:', dbPath);
  const store = new SqliteStore(dbPath);
  
  let recoveredCount = 0;
  let remainingAmbiguous = 0;
  let totalPublished = 0;

  await store.update(state => {
    state.items ||= [];
    state.forensicLogs ||= [];
    
    const byId = new Map(CONFIRMED_PUBLISHED.map(c => [c.itemId, c]));

    for (const item of state.items) {
      if (byId.has(item.id)) {
        const conf = byId.get(item.id);
        if (item.state === 'ambiguous') {
          console.log(`Reconciling item ${item.id} -> published (${conf.url})`);
          item.state = 'published';
          item.url = conf.url;
          item.tweetId = conf.tweetId;
          item.accountUsername = conf.account;
          item.accountId = conf.accountId;
          item.publishedAt = conf.publishedAt;
          item.recoveredFromTimeline = true;
          item.reason = null;
          delete item.attempt;
          delete item.failureDiagnostic;
          recoveredCount++;
        }
      }
    }

    remainingAmbiguous = state.items.filter(i => i.state === 'ambiguous').length;
    totalPublished = state.items.filter(i => i.state === 'published').length;

    state.forensicLogs.push({
      timestamp: new Date().toISOString(),
      eventType: 'm11_ambiguous_timeline_reconciliation',
      details: {
        recoveredCount,
        remainingAmbiguous,
        totalPublished,
        items: CONFIRMED_PUBLISHED.map(c => ({ itemId: c.itemId, url: c.url, account: c.account }))
      }
    });

    return state;
  });

  console.log('Recovery completed atomically:');
  console.log(`  Recovered confirmed published items: ${recoveredCount}`);
  console.log(`  Remaining ambiguous items: ${remainingAmbiguous}`);
  console.log(`  Total published items: ${totalPublished}`);
  store.close();
}

if (require.main === module) {
  main().catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}

module.exports = { main, CONFIRMED_PUBLISHED };
