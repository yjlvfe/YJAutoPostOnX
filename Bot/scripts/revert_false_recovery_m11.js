'use strict';
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
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
    accountId: 'x-930e0054b395228aefa9',
    accountUsername: 'crytpokingxvo8',
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

const ENRICH_13_ITEMS = [
  { itemId: '47da5e8a-9c24-45ed-ae64-4d3c163a8b9a', accountId: 'x-ab22678a0fc05660b440', accountUsername: 'emiehg' },
  { itemId: '8b9481aa-4723-4b0b-bfc4-b7fdff6730e3', accountId: 'x-930e0054b395228aefa9', accountUsername: 'crytpokingxvo8' },
  { itemId: '10afc79e-7634-4149-acd1-90277ff53b1e', accountId: 'x-ab22678a0fc05660b440', accountUsername: 'emiehg' },
  { itemId: '3719dfde-c7b6-446f-a8ba-211f48b92ec2', accountId: 'x-2aa7928dd26217e0939c', accountUsername: 'okasanbq' },
  { itemId: 'c1eecbd3-704d-43ba-8306-93a1a15b4350', accountId: 'x-ab22678a0fc05660b440', accountUsername: 'emiehg' },
  { itemId: 'a589288f-19af-4cbb-bc24-90a07940c394', accountId: 'x-2aa7928dd26217e0939c', accountUsername: 'okasanbq' },
  { itemId: '5ffd64c2-713c-4768-976d-d8d0b0a1673e', accountId: 'x-930e0054b395228aefa9', accountUsername: 'crytpokingxvo8' },
  { itemId: '5e5f91ab-2841-4848-a035-4c1c8a8df197', accountId: 'x-ab22678a0fc05660b440', accountUsername: 'emiehg' },
  { itemId: '53d0f458-3144-4e89-a1af-202a8893afc6', accountId: 'x-930e0054b395228aefa9', accountUsername: 'crytpokingxvo8' },
  { itemId: '34ed9685-4513-4ff8-afb6-f98e45204f9d', accountId: 'x-ab22678a0fc05660b440', accountUsername: 'emiehg' },
  { itemId: 'f75e4f8d-c5ed-44b0-8aa9-77af63be85dc', accountId: 'x-ab22678a0fc05660b440', accountUsername: 'emiehg' },
  { itemId: 'bd12d092-4480-4b9f-a41d-0324ec77b317', accountId: 'x-ab22678a0fc05660b440', accountUsername: 'emiehg' },
  { itemId: 'fa1f2749-8496-4d20-b6e4-d6fad4a5de0b', accountId: 'x-ab22678a0fc05660b440', accountUsername: 'emiehg' }
];

async function runReversion({ dbPath, logFilePath, isApply } = {}) {
  const targetDb = dbPath || path.resolve(__dirname, '../data/state.sqlite');
  const targetLog = logFilePath || path.resolve(__dirname, '../data/logs/forensic.jsonl');

  console.log(`=== REVERT & FORENSIC AUDIT SCRIPT (Mode: ${isApply ? 'APPLY' : 'DRY-RUN'}) ===`);
  console.log('Target database:', targetDb);

  if (!isApply) {
    console.log('NOTICE: Running in DRY-RUN mode. Pass --apply to execute changes atomically.');
  }

  const store = new SqliteStore(targetDb);
  let revertedCount = 0;
  let alreadyQuarantinedCount = 0;
  let enrichedCount = 0;
  let remainingAmbiguous = 0;
  let totalPublished = 0;

  const nowEpoch = Date.now();
  const nowIso = new Date(nowEpoch).toISOString();

  let revertEvent = null;
  let enrichEvent = null;

  if (isApply) {
    await store.update(state => {
      state.items ||= [];
      state.forensicLogs ||= [];

      const byId = new Map(REVERT_ITEMS.map(r => [r.id, r]));
      const enrichById = new Map(ENRICH_13_ITEMS.map(e => [e.itemId, e]));

      for (const item of state.items) {
        if (byId.has(item.id)) {
          const rev = byId.get(item.id);
          if (item.state === 'ambiguous' && !item.url && !item.tweetId && !item.publishedAt) {
            alreadyQuarantinedCount++;
          } else {
            console.log(`Reverting item ${item.id} -> ambiguous (${rev.revertReason})`);
            // Archive prior attempt before state reset
            if (item.attempt) {
              item.archivedAttempt = structuredClone(item.attempt);
            }
            item.state = 'ambiguous';
            item.reason = rev.reason;
            item.claimedAt = rev.claimedAt;
            if (rev.accountId) item.accountId = rev.accountId;
            if (rev.accountUsername) item.accountUsername = rev.accountUsername;
            if (rev.attempt) item.attempt = rev.attempt;
            delete item.url;
            delete item.tweetId;
            delete item.publishedAt;
            delete item.recoveredFromTimeline;
            delete item.failureDiagnostic;
            revertedCount++;
          }
        }

        // Enrich 13 items with authentic provenance from forensic.jsonl
        if (enrichById.has(item.id) && item.state === 'ambiguous') {
          const enrich = enrichById.get(item.id);
          if (!item.accountId || !item.accountUsername) {
            item.accountId = enrich.accountId;
            item.accountUsername = enrich.accountUsername;
            enrichedCount++;
          }
        }
      }

      remainingAmbiguous = state.items.filter(i => i.state === 'ambiguous').length;
      totalPublished = state.items.filter(i => i.state === 'published').length;

      // DO NOT record new events if no item changed state or was enriched!
      if (revertedCount === 0 && enrichedCount === 0) {
        console.log('No state mutations occurred. Zero events recorded to preserve clean audit ledger.');
        return state;
      }

      if (revertedCount > 0) {
        revertEvent = {
          id: randomUUID(),
          timestamp: nowIso,
          epoch: nowEpoch,
          eventType: 'm11_revert_false_recovery',
          details: {
            revertedCount,
            alreadyQuarantinedCount,
            remainingAmbiguous,
            totalPublished,
            items: REVERT_ITEMS.map(r => ({ itemId: r.id, revertReason: r.revertReason }))
          }
        };
        state.forensicLogs.push(revertEvent);
      }

      if (enrichedCount > 0) {
        enrichEvent = {
          id: randomUUID(),
          timestamp: nowIso,
          epoch: nowEpoch,
          eventType: 'm11_audit_13_ambiguous_accounts',
          details: {
            enrichedCount,
            remainingAmbiguous,
            items: ENRICH_13_ITEMS
          }
        };
        state.forensicLogs.push(enrichEvent);
      }

      return state;
    });

    await store.close();

    // Append to JSONL log file only if events were actually generated
    const newEvents = [revertEvent, enrichEvent].filter(Boolean);
    if (newEvents.length > 0) {
      try {
        const lines = newEvents.map(e => JSON.stringify(e)).join('\n') + '\n';
        await fsp.appendFile(targetLog, lines, { mode: 0o600 });
        console.log(`Persisted ${newEvents.length} audit event(s) to ${targetLog}`);
      } catch (err) {
        console.error(`Warning: Failed to append to ${targetLog}:`, err.message);
      }
    }

    console.log(`\nReversion summary: ${revertedCount} reverted, ${alreadyQuarantinedCount} already in quarantine.`);
    console.log(`Enrichment summary: ${enrichedCount} ambiguous items enriched.`);
    console.log(`Final Counts: ambiguous=${remainingAmbiguous}, published=${totalPublished}.`);
  } else {
    // Dry run inspection
    const state = await store.load();
    const byId = new Map(REVERT_ITEMS.map(r => [r.id, r]));
    const enrichById = new Map(ENRICH_13_ITEMS.map(e => [e.itemId, e]));

    for (const item of (state.items || [])) {
      if (byId.has(item.id)) {
        if (item.state === 'ambiguous' && !item.url) alreadyQuarantinedCount++;
        else revertedCount++;
      }
      if (enrichById.has(item.id) && item.state === 'ambiguous') {
        if (!item.accountId || !item.accountUsername) enrichedCount++;
      }
    }
    remainingAmbiguous = (state.items || []).filter(i => i.state === 'ambiguous').length;
    totalPublished = (state.items || []).filter(i => i.state === 'published').length;
    await store.close();

    console.log(`\n[DRY RUN] Would revert: ${revertedCount}, already quarantined: ${alreadyQuarantinedCount}.`);
    console.log(`[DRY RUN] Would enrich: ${enrichedCount} ambiguous items.`);
    console.log(`[DRY RUN] Current counts: ambiguous=${remainingAmbiguous}, published=${totalPublished}.`);
  }

  return { revertedCount, alreadyQuarantinedCount, enrichedCount, remainingAmbiguous, totalPublished };
}

async function main() {
  const isApply = process.argv.includes('--apply');
  await runReversion({ isApply });
}

if (require.main === module) {
  main().catch(err => {
    console.error('Operation failed:', err);
    process.exit(1);
  });
}

module.exports = { main, runReversion, REVERT_ITEMS, ENRICH_13_ITEMS };
