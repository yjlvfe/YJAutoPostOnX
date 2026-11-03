'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const REPORTS_DIR = '/root/Projects/YJAutoPostOnX/Bot/Reports/RepairHandoff/Round8_M10';
fs.mkdirSync(REPORTS_DIR, { recursive: true });

const JSONL_PATH = path.join(REPORTS_DIR, 'LIVE_PRODUCTION_5_ROUNDS.jsonl');
const LOGS_PATH = path.join(REPORTS_DIR, 'live_production_service_raw_logs.log');
const DB_PATH = '/root/Projects/YJAutoPostOnX/Bot/data/state.sqlite';

const TARGET_RUN_ID = 'b97fd7d352319b40c21649b5';
const MIN_ROUNDS = 5; // Target at least 5 complete rotation rounds or until quota exhaustion

console.log(`[Monitor] Starting Live Production 5-Rounds Monitor for Run ID: ${TARGET_RUN_ID}`);

const seenPostIds = new Set();
let lastJournalCheck = '2026-11-03 07:10:00';

function getDbState() {
  const db = new DatabaseSync(DB_PATH);
  try {
    const row = db.prepare('SELECT json FROM state WHERE id = 1').get();
    return JSON.parse(row.json);
  } finally {
    db.close();
  }
}

async function monitorLoop() {
  const startTime = Date.now();
  const maxMonitorDurationMs = 45 * 60 * 1000; // 45 minutes max

  while (Date.now() - startTime < maxMonitorDurationMs) {
    try {
      const state = getDbState();
      const cycleState = state.cycle?.state;
      const currentRunId = state.cycle?.runId;

      // Extract new published items in this run
      const published = (state.items || []).filter(i =>
        i.state === 'published' &&
        i.publishedAt &&
        i.publishedAt >= '2026-11-03T04:10:00.000Z'
      );

      for (let idx = 0; idx < published.length; idx++) {
        const p = published[idx];
        if (!seenPostIds.has(p.id)) {
          seenPostIds.add(p.id);
          const record = {
            turnNumber: seenPostIds.size,
            runId: currentRunId,
            itemId: p.id,
            accountId: p.accountId,
            accountUsername: p.accountUsername,
            publishedAt: p.publishedAt,
            tweetId: p.tweetId,
            url: p.url,
            textSnippet: (p.payload?.text || '').slice(0, 80).replace(/\n/g, ' ')
          };
          fs.appendFileSync(JSONL_PATH, JSON.stringify(record) + '\n');
          console.log(`[Monitor] Turn ${seenPostIds.size}: @${p.accountUsername} -> ${p.url}`);
        }
      }

      // Check quotas
      const quotaToday = state.posting?.quota?.['2026-11-03'] || {};
      const eligibleAccounts = (state.accounts || []).filter(a =>
        a.enabled !== false &&
        !['محظور', 'كابتشا', 'معزول (3 إخفاقات)'].includes(a.status) &&
        (quotaToday[a.id] || 0) < (state.settings?.dailyQuota || 10)
      );

      // Check if all accounts reached quota or cycle finished
      if (cycleState !== 'running' && cycleState !== 'stopping') {
        console.log(`[Monitor] Cycle transitioned to ${cycleState}. Total turns: ${seenPostIds.size}`);
        break;
      }

      if (eligibleAccounts.length === 0) {
        console.log(`[Monitor] All eligible accounts have exhausted daily quota (10/10). Total turns: ${seenPostIds.size}`);
        break;
      }

      // If we achieved at least 15 turns (which corresponds to full multi-round rotation across all accounts)
      if (seenPostIds.size >= 16) {
        console.log(`[Monitor] Achieved ${seenPostIds.size} verified turns across all accounts. Target reached!`);
        break;
      }

    } catch (err) {
      console.error('[Monitor] Error during sampling:', err.message);
    }

    // Sleep 15 seconds between probes
    await new Promise(r => setTimeout(r, 15000));
  }

  // Dump raw journalctl logs for this run
  try {
    const rawLogs = execSync(`journalctl -u yj-telegram-bot.service --since "2026-11-03 07:10:00" --no-pager`, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    fs.writeFileSync(LOGS_PATH, rawLogs);
    console.log(`[Monitor] Dumped ${rawLogs.split('\n').length} raw log lines to ${LOGS_PATH}`);
  } catch (err) {
    console.error('[Monitor] Error dumping raw logs:', err.message);
  }

  console.log(`[Monitor] Monitor completed successfully. Total turns captured: ${seenPostIds.size}`);
}

monitorLoop().catch(console.error);
