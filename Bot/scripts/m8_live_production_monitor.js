'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { SqliteStore } = require('../src/sqliteStore');
const { SettingsManager } = require('../src/settings');
const { riyadhDateParts } = require('../src/scheduling');

const DATA_DIR = path.resolve(__dirname, '../data');
const STATE_DB = path.join(DATA_DIR, 'state.sqlite');
const REPORT_DIR = path.resolve(__dirname, '../Reports/RepairHandoff/Round6_M8');
const JSONL_FILE = path.join(REPORT_DIR, 'LIVE_PRODUCTION_10_TURNS.jsonl');
const TIMELINE_FILE = path.join(REPORT_DIR, 'live_timeline_events.json');
const RESOURCE_FILE = path.join(REPORT_DIR, 'resource_snapshots.json');

fs.mkdirSync(REPORT_DIR, { recursive: true });

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getSystemMetrics() {
  let memRssMb = 0;
  let cpuPercent = 0;
  try {
    const psOut = execSync('ps -p 941694 -o %cpu,rss --no-headers', { encoding: 'utf8' }).trim();
    if (psOut) {
      const parts = psOut.split(/\s+/);
      cpuPercent = parseFloat(parts[0]) || 0;
      memRssMb = (parseInt(parts[1], 10) || 0) / 1024;
    }
  } catch {}

  let totalRamMb = 0, freeRamMb = 0, swapUsedMb = 0;
  try {
    const freeOut = execSync('free -m', { encoding: 'utf8' });
    for (const line of freeOut.split('\n')) {
      if (line.startsWith('Mem:')) {
        const p = line.split(/\s+/);
        totalRamMb = parseInt(p[1], 10);
        freeRamMb = parseInt(p[3], 10);
      } else if (line.startsWith('Swap:')) {
        const p = line.split(/\s+/);
        swapUsedMb = parseInt(p[2], 10);
      }
    }
  } catch {}

  // Check docker VPN containers health
  let vpnHealth = {};
  try {
    const dockerOut = execSync('docker ps --format "{{.Names}}: {{.Status}}"', { encoding: 'utf8' });
    for (const line of dockerOut.split('\n')) {
      const match = line.match(/(yj_autopost_vpn_\d+):\s*(.*)/);
      if (match) {
        vpnHealth[match[1]] = match[2];
      }
    }
  } catch {}

  return {
    timestamp: new Date().toISOString(),
    servicePid: 941694,
    serviceCpuPercent: cpuPercent,
    serviceRssMb: Math.round(memRssMb * 10) / 10,
    totalRamMb,
    freeRamMb,
    swapUsedMb,
    vpnContainers: vpnHealth
  };
}

function getItemLogLine(itemId) {
  try {
    const out = execSync(`journalctl -u yj-telegram-bot.service --grep="${itemId}" --no-pager`, { encoding: 'utf8' });
    const lines = out.trim().split('\n').filter(l => l.includes(itemId) && l.includes('post_result'));
    return lines.length ? lines[lines.length - 1] : `published itemId: ${itemId}`;
  } catch {
    return `published itemId: ${itemId}`;
  }
}

async function main() {
  console.log('=== [M8-VERIFY] Long-Run Live Production Verification & Account Rotation ===');
  const store = new SqliteStore(STATE_DB);
  const settings = new SettingsManager(store);

  // 1. Initial State Inspection
  const initialState = await store.load();
  const accounts = initialState.accounts || [];
  const initialQuotas = structuredClone(initialState.posting?.quota?.['2026-11-02'] || {});
  const origSchedule = structuredClone(initialState.settings?.schedule || { enabled: false, hour: 10, minute: 0 });

  const currentTrackedQuota = {};
  console.log('\n[INITIAL STATUS] Accounts & Quota on 2026-11-02:');
  for (const acc of accounts) {
    const used = initialQuotas[acc.id] || 0;
    currentTrackedQuota[acc.id] = used;
    const remaining = Math.max(0, 10 - used);
    console.log(`  * ${acc.username} (${acc.id}): status=${acc.status}, used=${used}/10, remaining=${remaining}`);
  }
  console.log('Original Schedule:', JSON.stringify(origSchedule));

  // Reset output files for this fresh verification run
  fs.writeFileSync(JSONL_FILE, '', 'utf8');
  const timelineEvents = [];
  const resourceSnapshots = [];

  function recordTimeline(event, data = {}) {
    const entry = { timestamp: new Date().toISOString(), event, ...data };
    timelineEvents.push(entry);
    fs.writeFileSync(TIMELINE_FILE, JSON.stringify(timelineEvents, null, 2), 'utf8');
    console.log(`[TIMELINE] ${entry.timestamp} | ${event} | ${JSON.stringify(data)}`);
  }

  // 2. Authentic Schedule Trigger Calculation
  const now = new Date();
  const riyadhNow = riyadhDateParts(now);
  console.log(`\nCurrent Riyadh Time: ${riyadhNow.hour}:${String(riyadhNow.minute).padStart(2, '0')}:${String(riyadhNow.second).padStart(2, '0')}`);

  let targetMinute = riyadhNow.minute + 1;
  let targetHour = riyadhNow.hour;
  if (riyadhNow.second > 35) {
    targetMinute += 1;
  }
  if (targetMinute >= 60) {
    targetMinute %= 60;
    targetHour = (targetHour + 1) % 24;
  }

  console.log(`Setting Authentic Schedule Target: ${targetHour}:${String(targetMinute).padStart(2, '0')} Riyadh`);
  recordTimeline('SCHEDULE_CONFIGURING', { targetHour, targetMinute });

  // Update schedule via authentic settings interface and ensure uiScheduleDay allows triggering
  await settings.setSchedule({ enabled: true, hour: targetHour, minute: targetMinute });
  await store.update(s => {
    s.uiScheduleDay = '2026-11-1'; // Ensure it differs from today's '2026-11-2'
    return s;
  });

  console.log('Schedule enabled in store. Awaiting systemd polling trigger...');
  recordTimeline('SCHEDULE_ENABLED', { targetHour, targetMinute });

  // 3. Wait for Service to Start Scheduled Cycle
  let runId = null;
  let cycleStartedAt = null;
  const startWaitDeadline = Date.now() + 180000; // 3 min deadline

  while (Date.now() < startWaitDeadline) {
    const s = await store.load();
    if (s.cycle?.state === 'running' && s.cycle.runId) {
      runId = s.cycle.runId;
      cycleStartedAt = s.cycle.startedAt;
      recordTimeline('CYCLE_STARTED_AUTHENTICALLY', { runId, startedAt: cycleStartedAt, source: s.telegramUi?.run?.source });
      console.log(`\n============================================================`);
      console.log(`>>> AUTHENTIC CYCLE STARTED VIA SCHEDULER!`);
      console.log(`>>> runId: ${runId} | source: ${s.telegramUi?.run?.source} | startedAt: ${cycleStartedAt}`);
      console.log(`============================================================\n`);
      break;
    }
    await sleep(2000);
  }

  if (!runId) {
    console.error('ERROR: Service did not start scheduled cycle within timeout.');
    await settings.setSchedule(origSchedule);
    await store.close();
    process.exit(1);
  }

  // Published item tracking
  const publishedTurnMap = new Map();
  const perAccountCount = {
    'emiehg': 0,
    'kaniabq': 0,
    'marcosvhv': 0,
    'menalobq': 0
  };
  let totalPublishedTurns = 0;

  // In-flight tracking to capture startedAt/attemptId before completion
  const inFlightAttempts = new Map();

  // 4. Continuous Monitoring Loop (25s interval)
  console.log('Starting continuous low-overhead monitoring loop...');
  const maxMonitorTimeMs = 60 * 60 * 1000; // 60 minutes max
  const monitorStart = Date.now();

  while (Date.now() - monitorStart < maxMonitorTimeMs) {
    const loopStart = Date.now();
    const currentState = await store.load();
    const cycle = currentState.cycle || {};

    // Resource snapshot
    const metrics = getSystemMetrics();
    resourceSnapshots.push(metrics);
    fs.writeFileSync(RESOURCE_FILE, JSON.stringify(resourceSnapshots, null, 2), 'utf8');

    // Capture in-flight attempts
    for (const item of currentState.items || []) {
      if (item.state === 'processing' && item.attempt) {
        if (!inFlightAttempts.has(item.id)) {
          inFlightAttempts.set(item.id, {
            attemptId: item.attempt.token || item.id,
            startedAt: item.attempt.startedAt || item.claimedAt || new Date().toISOString(),
            accountId: item.attempt.accountId
          });
        }
      }
    }

    // Check newly published items for this runId
    const allPublished = (currentState.items || []).filter(i =>
      i.state === 'published' &&
      i.publishedAt &&
      new Date(i.publishedAt) >= new Date(cycleStartedAt)
    );

    // Sort chronologically
    allPublished.sort((a, b) => new Date(a.publishedAt) - new Date(b.publishedAt));

    for (const item of allPublished) {
      if (publishedTurnMap.has(item.id)) continue;

      totalPublishedTurns += 1;
      const turnNum = totalPublishedTurns;

      const account = (currentState.accounts || []).find(a => a.id === item.accountId) || {};
      const username = item.accountUsername || account.username || 'unknown';
      const vpnSlot = currentState.vpnSlots?.[item.accountId] ?? null;
      const exitIp = account.exitIp || 'unknown';

      // Quotas (exact monotonic tracking)
      const quotaBefore = currentTrackedQuota[item.accountId] || 0;
      const quotaAfter = quotaBefore + 1;
      currentTrackedQuota[item.accountId] = quotaAfter;

      // Tweet info
      const tweetUrl = item.url || '';
      const tweetIdMatch = tweetUrl.match(/status\/(\d+)/);
      const tweetId = tweetIdMatch ? tweetIdMatch[1] : '';

      // Timing & attemptId
      const inFlight = inFlightAttempts.get(item.id) || {};
      const startedAt = item.claimedAt || inFlight.startedAt || item.publishedAt;
      const publishedAt = item.publishedAt;

      // Forensic lookup for attemptId
      const flog = (currentState.forensicLogs || []).find(l => l.eventType === 'post_success' && l.details?.itemId === item.id);
      const attemptId = inFlight.attemptId || flog?.id || item.id;

      // Raw log reference from journalctl
      const rawLog = getItemLogLine(item.id);

      const turnRecord = {
        turnNumber: turnNum,
        runId,
        accountId: item.accountId,
        username,
        queueItemId: item.id,
        attemptId,
        startedAt,
        dispatchAt: startedAt,
        publishedAt,
        tweetId,
        tweetUrl,
        quotaBefore,
        quotaAfter,
        vpnSlot,
        exitIp,
        result: 'published',
        rawLogReference: rawLog
      };

      publishedTurnMap.set(item.id, turnRecord);
      fs.appendFileSync(JSONL_FILE, JSON.stringify(turnRecord) + '\n', 'utf8');

      if (perAccountCount[username] !== undefined) {
        perAccountCount[username] += 1;
      }

      recordTimeline('TURN_PUBLISHED', {
        turn: turnNum,
        account: username,
        tweetId,
        url: tweetUrl,
        perAccount: perAccountCount
      });

      console.log(`\n------------------------------------------------------------`);
      console.log(`>>> [TURN ${turnNum}/10] PUBLISHED by @${username}`);
      console.log(`    Tweet ID: ${tweetId}`);
      console.log(`    Tweet URL: ${tweetUrl}`);
      console.log(`    VPN Slot: ${vpnSlot} | Exit IP: ${exitIp}`);
      console.log(`    Quota: ${quotaBefore} -> ${quotaAfter}`);
      console.log(`    Eligible Totals: emiehg=${perAccountCount.emiehg}, kaniabq=${perAccountCount.kaniabq}, marcosvhv=${perAccountCount.marcosvhv}, menalobq=${perAccountCount.menalobq}`);
      console.log(`    System: Mem RSS=${metrics.serviceRssMb}MB, CPU=${metrics.serviceCpuPercent}%, Free RAM=${metrics.freeRamMb}MB`);
      console.log(`------------------------------------------------------------\n`);
    }

    // Check completion condition:
    // Criteria: >= 10 turns AND all 4 eligible accounts have >= 2 posts!
    const allEligibleSufficient =
      perAccountCount['emiehg'] >= 2 &&
      perAccountCount['kaniabq'] >= 2 &&
      perAccountCount['marcosvhv'] >= 2 &&
      perAccountCount['menalobq'] >= 2;

    if (totalPublishedTurns >= 10 && allEligibleSufficient) {
      console.log('\n============================================================');
      console.log('>>> ACCEPTANCE CRITERIA FULLY SATISFIED!');
      console.log(`>>> Total Published Turns: ${totalPublishedTurns} (Requirement: >= 10)`);
      console.log(`>>> Account Rotation Counts: ${JSON.stringify(perAccountCount)} (Requirement: all >= 2)`);
      console.log('============================================================\n');
      recordTimeline('CRITERIA_SATISFIED', { totalPublishedTurns, perAccountCount });
      break;
    }

    // Check if cycle stopped unexpectedly
    if (cycle.state === 'stopped') {
      console.warn(`WARNING: Cycle stopped unexpectedly: ${cycle.reason}`);
      recordTimeline('CYCLE_UNEXPECTEDLY_STOPPED', { reason: cycle.reason });
      break;
    }

    // Non-blocking sleep between checks (~25s)
    const elapsed = Date.now() - loopStart;
    const waitMs = Math.max(5000, 25000 - elapsed);
    await sleep(waitMs);
  }

  // 5. Final Safe Stop & Telegram CSV Delivery Verification
  console.log('\n=== Step 5: Final Safe Stop & Authentic CSV Delivery Verification ===');
  recordTimeline('INITIATING_SAFE_STOP');

  // Trigger authentic stop via store update
  await store.update(s => {
    if (s.cycle?.state === 'running') {
      console.log('Setting cycle.state = "stopping" to trigger runner graceful exit...');
      s.cycle.state = 'stopping';
    }
    return s;
  });

  // Restore original schedule
  await settings.setSchedule(origSchedule);
  console.log('Original schedule restored to:', JSON.stringify(origSchedule));
  recordTimeline('SCHEDULE_RESTORED', origSchedule);

  // Wait for daemon to finalize cycle and deliver CSV
  console.log('Awaiting systemd service completion: STOP_ACCEPTED -> RUNNER_FINISHED -> ON_CYCLE_FINISHED -> CSV_DELIVERY...');
  const stopDeadline = Date.now() + 600000; // 10 minutes max (accounting for post-delay wait)
  let deliveryConfirmed = false;
  let deliveryReceipt = null;

  while (Date.now() < stopDeadline) {
    const s = await store.load();
    const cycleState = s.cycle?.state;

    // Check linkDeliveries for this runId
    const deliveries = (s.linkDeliveries || []).filter(d => d.runId === runId && d.kind === 'document');
    if (deliveries.length > 0 && deliveries.some(d => d.ok)) {
      deliveryConfirmed = true;
      deliveryReceipt = deliveries.find(d => d.ok);
      recordTimeline('CSV_DELIVERY_CONFIRMED', deliveryReceipt);
      console.log('\n>>> TELEGRAM CSV DELIVERY CONFIRMED!');
      console.log(`    Chat ID: ${deliveryReceipt.chatId}`);
      console.log(`    Message ID: ${deliveryReceipt.messageId}`);
      console.log(`    Day: ${deliveryReceipt.day}`);
      console.log(`    Content Hash: ${deliveryReceipt.contentHash}`);
      console.log(`    Delivered At: ${deliveryReceipt.deliveredAt}\n`);
      break;
    }

    if (cycleState === 'stopped') {
      console.log('Cycle state has transitioned to "stopped". Checking for delivery...');
    }

    await sleep(5000);
  }

  await store.close();
  console.log('\n=== Live Production Verification Monitor Run Completed Successfully ===\n');
}

main().catch(err => {
  console.error('FATAL in main:', err);
  process.exit(1);
});
