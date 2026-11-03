'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const REPORTS_DIR = '/root/Projects/YJAutoPostOnX/Bot/Reports/RepairHandoff/Round8_M10';
fs.mkdirSync(REPORTS_DIR, { recursive: true });

const JSONL_PATH = path.join(REPORTS_DIR, 'LIVE_PRODUCTION_5_ROUNDS.jsonl');
const LOGS_PATH = path.join(REPORTS_DIR, 'live_production_service_raw_logs.log');
const DB_PATH = '/root/Projects/YJAutoPostOnX/Bot/data/state.sqlite';

const TARGET_RUN_ID = 'b97fd7d352319b40c21649b5';
const MIN_ROUNDS = 5; // Informational only. A run is verified at terminal CSV receipt, not at an arbitrary number of posts.

console.log(`[Monitor] Starting Live Production 5-Rounds Monitor for Run ID: ${TARGET_RUN_ID}`);

const seenPostIds = new Set();
let runItemIds = null;
let cycleStartAt = null;
let terminalVerified = false;
let monitorStatus = 'INCOMPLETE';
let latestState = null;

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
  const maxMonitorDurationMs = 45 * 60 * 1000; // Bound only the observer; never the production service
  fs.writeFileSync(JSONL_PATH, '', { mode: 0o600 });

  while (Date.now() - startTime < maxMonitorDurationMs) {
    try {
      const state = getDbState();
      const cycleState = state.cycle?.state;
      const currentRunId = state.telegramUi?.run?.runId;
      const scope = state.telegramUi?.run;
      if (!runItemIds && state.cycle?.runId === TARGET_RUN_ID && currentRunId === TARGET_RUN_ID) {
        if (!Array.isArray(scope.itemIds) || !scope.itemIds.length) throw new Error('Missing verified run item IDs');
        runItemIds = new Set(scope.itemIds);
        cycleStartAt = state.cycle.startedAt;
      }
      if (!runItemIds || currentRunId !== TARGET_RUN_ID) {
        console.log('[Monitor] Waiting for exact run ID and durable item scope...');
        await new Promise(r => setTimeout(r, 15000));
        continue;
      }
      latestState = state;

      // Extract published items only from the actual run's item IDs
      const published = (state.items || []).filter(i =>
        runItemIds.has(i.id) &&
        i.state === 'published' &&
        i.publishedAt &&
        i.publishedAt >= cycleStartAt &&
        typeof i.url === 'string' && /^https:\/\/x\.com\/[a-z0-9_]+\/status\/\d+$/i.test(i.url)
      );

      for (let idx = 0; idx < published.length; idx++) {
        const p = published[idx];
        if (!seenPostIds.has(p.id)) {
          seenPostIds.add(p.id);
          const record = {
            turnNumber: seenPostIds.size,
            runId: TARGET_RUN_ID,
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
        const plannedChats = [...new Set((state.linkTerminalEvents || [])
          .filter(e => e.runId === TARGET_RUN_ID && !e.suppressed).map(e => String(e.chatId)))];
        const receipts = (state.linkDeliveries || []).filter(e =>
          e.runId === TARGET_RUN_ID && e.kind === 'document' && e.ok === true &&
          e.suppressed !== true && e.messageId != null);
        terminalVerified = cycleState === 'stopped' && plannedChats.length > 0 &&
          plannedChats.every(chatId => receipts.some(e => String(e.chatId) === chatId));
        console.log(`[Monitor] Cycle state=${cycleState}, posts=${seenPostIds.size}, terminal receipts confirmed=${terminalVerified}`);
        if (terminalVerified) break; // Wait for actual Telegram CSV sendDocument receipts.
      }

      if (eligibleAccounts.length === 0) {
        console.log('[Monitor] Quota exhausted; still waiting for natural stop and terminal CSV receipts.');
      }

      // Never stop evidence capture merely because a numeric turn target was reached.
      // The missing journal tail cannot otherwise corroborate CSV delivery or later ambiguities.

    } catch (err) {
      console.error('[Monitor] Error during sampling:', err.message);
    }

    // Sleep 15 seconds between probes
    await new Promise(r => setTimeout(r, 15000));
  }

  // Dump raw journalctl logs for this run
  try {
    const rawLogs = execFileSync('journalctl', ['-u', 'yj-telegram-bot.service', '--since', '2026-11-03 07:10:00', '--no-pager'], { encoding: 'utf8', timeout: 20000, maxBuffer: 40 * 1024 * 1024 });
    fs.writeFileSync(LOGS_PATH, rawLogs, { mode: 0o600 }); // PRIVATE: sanitize before bundling or Telegram delivery
    const postResultLines = rawLogs.split('\n').filter(line => line.includes('"event":"post_result"'));
    const confirmed = new Map();
    for (const line of postResultLines) {
      try {
        const event = JSON.parse(line.slice(line.indexOf('{')));
        if (event.status === 'published') confirmed.set(event.item, event.url);
      } catch {}
    }
    const records = fs.readFileSync(JSONL_PATH, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    const missing = records.filter(rec => confirmed.get(rec.itemId) !== rec.url).map(rec => rec.itemId);
    if (!missing.length && terminalVerified && records.length >= 1) monitorStatus = 'VERIFIED';
    else console.error('[Monitor] Evidence incomplete:', { missingPostResults: missing.length, terminalVerified });
    fs.writeFileSync(path.join(REPORTS_DIR, 'MONITOR_VERDICT.json'), JSON.stringify({
      runId: TARGET_RUN_ID, status: monitorStatus, observedPublished: records.length,
      journalConfirmed: records.length - missing.length, missingPostResultItemIds: missing,
      terminalVerified, source: 'readonly_observer'
    }, null, 2), { mode: 0o600 });
    console.log(`[Monitor] Dumped ${rawLogs.split('\n').length} raw log lines to ${LOGS_PATH}`);
  } catch (err) {
    console.error('[Monitor] Error dumping raw logs:', err.message);
  }

  console.log(`[Monitor] Status: ${monitorStatus}. Total turns captured: ${seenPostIds.size}`);
  if (monitorStatus !== 'VERIFIED') process.exitCode = 1;
}

monitorLoop().catch(err => { console.error('[Monitor] FATAL:', err.message); process.exitCode = 1; });
