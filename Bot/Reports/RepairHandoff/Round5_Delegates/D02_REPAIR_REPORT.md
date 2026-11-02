# SURGICAL REPAIR REPORT: CYCLE STOP REPORTING & CSV DELIVERY
**Report ID**: `D02-REPAIR-CYCLE-REPORT-DELIVERY`  
**Execution Date**: Monday, November 02, 2026 (Riyadh Time: UTC+03:00)  
**Execution Mode**: SURGICAL CODE REPAIR & REGRESSION VERIFICATION  
**Target Repository**: `/root/Projects/YJAutoPostOnX`  
**Target Application**: `/root/Projects/YJAutoPostOnX/Bot`  
**Git SHA Before**: `6df57fcfbadd4b4288b61b0481c40122f0a8588f`  
**Git SHA After**: `1eb8e91064049722c4cb3a64f4f43e31fb2be454`  
**Production Database**: `/root/Projects/YJAutoPostOnX/Bot/data/state.sqlite`  
**Systemd Service**: `yj-telegram-bot.service` (Active Main PID: `491101`)  
**Authorized Admin Chat ID**: `528864559`  

---

## 1. Executive Summary & Root Cause Resolution

Following the forensic investigation documented in `D01_INVESTIGATION_REPORT.md`, two interrelated root causes were surgically resolved:

1. **Over-Aggressive Intra-Day CSV Content Hash Deduplication (`src/linkExports.js`)**:
   - **Prior Defect**: `enqueueTerminal` checked whether the daily cumulative CSV content hash matched *any* prior delivery on the same 24-hour day (`successfulDeliveries.some(entry => entry.contentHash === contentHash)`). Consequently, any subsequent cycle stop that finished without posting new tweets was silently suppressed with `reason: duplicate_content_hash`, resulting in zero CSV files and zero notifications being sent to the owner.
   - **Surgical Resolution**: Deduplication in `enqueueTerminal` and `deliver` is now strictly scoped to `(chatId, runId)` idempotency. If a new independent cycle (`runId_B !== runId_A`) finishes on the same day, it is never suppressed simply because the daily cumulative CSV hash matches an earlier report; it immediately delivers the daily CSV containing today's confirmed published history. If the exact same cycle finish event is re-executed (`runId_A`), it is safely deduplicated without creating duplicate deliveries.
   - **Zero-Links Empty Notice**: When a cycle finishes on a day with 0 confirmed published links, the bot enqueues and delivers a clear Arabic text notification (`kind: 'empty'`: `لا توجد روابط منشورات مؤكدة لهذا اليوم.`), also protected by per-runId idempotency.

2. **Absence of User-Visible Cycle Stop Notification (`src/telegramUi.js`, `src/runner.js`)**:
   - **Prior Defect**: Clicking "🔴 إيقاف" only edited the dashboard panel inline buttons to "متوقف". If the panel was off-screen or the CSV export was suppressed, the operator received zero confirmation messages in Telegram chat.
   - **Surgical Resolution**: `TelegramUi.prototype.stop()` now immediately dispatches an explicit Arabic acknowledgment message to the owner's chat (`⏹️ تم استقبال طلب إيقاف دورة النشر وجاري إنهاء الدورة وإرسال التقرير...`), preceding the graceful cancellation and settlement of running tasks. Furthermore, `runner.js` flushes the link outbox immediately when `onCycleFinished` settles.

---

## 2. Code Changes Detailed Inventory

### 2.1 `Bot/src/linkExports.js`
- **Scoping to `(chatId, runId)` Idempotency**:
  - Replaced the global intra-day content hash search with per-`runId` checks (`alreadyDelivered`, `alreadyOutbox`, `alreadyEvent`).
  - When a replay of an existing `runId` occurs, it records `{ runId, chatId, day, reconciled: true, suppressed: true, reason: 'duplicate_run_id' }` and skips outbox creation.
  - When an independent cycle (`runId_B`) finishes, it proceeds to generate and enqueue the daily CSV document.
- **Empty Links Handling**:
  - When `!rows.length` (0 confirmed links for the day), it records `empty_rows` and enqueues an outbox entry of `kind: 'empty'` with text `لا توجد روابط منشورات مؤكدة لهذا اليوم.`.
- **Secondary Delivery Deduplication in `deliver()`**:
  - Replaced global intra-day hash matching with per-`runId` delivery matching `(d.runId === entry.runId || d.outboxId === entry.outboxId)`.
  - Added parallel check for `kind: 'empty'` to prevent duplicate text messages on concurrent delivery races.
  - Marked `terminalEvent.reconciled = true` upon successful delivery receipt.

### 2.2 `Bot/src/telegramUi.js`
- **Explicit Stop Acknowledgment**:
  - In `TelegramUi.prototype.stop()`, when a stop request is accepted (`accepted === true`), `this.notify('⏹️ تم استقبال طلب إيقاف دورة النشر وجاري إنهاء الدورة وإرسال التقرير...').catch(() => {})` is dispatched.

### 2.3 `Bot/src/runner.js`
- **Immediate Terminal Outbox Flush**:
  - In `onCycleFinished`, after calling `sendExport(run, { emptyMessage: false, terminal: true })`, `links.flush()` is invoked to guarantee all pending terminal outbox records are drained without delay.

### 2.4 Existing Test Suites Adaptation
- `Bot/test/m3_telegram_and_csv_dedup.test.js`:
  - Updated tests 1.2 and 1.4 to verify per-`runId` replay idempotency (`run-1` replay is suppressed; `run-old` replay is suppressed).
- `Bot/test/challenger_r3_m3_adversarial_verification.test.js`:
  - Updated test 1.1 to verify 15 rapid consecutive replays of the same `runId` (`run-init`) produce exactly 1 CSV and 15 suppressed records.
  - Updated test 1.2 to verify destination-specific asymmetric delivery for `run-old`.
  - Updated test 1.3 to verify cycle replays are suppressed while distinct cycles deliver.
- `Bot/test/challenger_r3_m3_2_fuzz.test.js`:
  - Updated tests 2.1, 2.2, and 2.3 to assert per-`runId` replay idempotency and concurrent race suppression.
- `Bot/test/live_vps_m4_operational.test.js`:
  - Updated test 4.2 to verify replay of an already-delivered runId to `ownerChatId` suppresses duplicate CSV generation.
- `Bot/test/challenger_r4_m1_2_empirical.test.js`:
  - Filtered out terminal cycle report notifications (`لا توجد روابط منشورات مؤكدة`) from item-level strike and ambiguity alert counts, maintaining exact PR #11 alert suppression assertions.

### 2.5 New Dedicated Regression Test Suite
- `Bot/test/m5_cycle_report_delivery.test.js` (6 tests):
  1. `1. Cycle finish with existing today links sends daily CSV even if current run posted 0 new items`: Verified that cycle B delivers the daily CSV containing existing confirmed links.
  2. `2. Re-executing onCycleFinished for the SAME runId is deduplicated (zero duplicate sends)`: Verified that repeating cycle finish for the same `runId` produces exactly 0 extra documents and logs suppression.
  3. `3. Consecutive independent cycles with different runIds both receive reports`: Verified that 3 consecutive independent cycles on the same day each receive their report.
  4. `4. Cycle finish with 0 links sends clear empty notice`: Verified that when 0 links exist today, a clear text notice (`kind: 'empty'`) is sent to Telegram, and replays are deduplicated.
  5. `5. Ambiguous Telegram sends are safely quarantined with attempt tokens intact`: Verified that transport exceptions without explicit receipts mark outbox as `ambiguous`, retain `attempted: true`, and never retry on subsequent flushes.
  6. `6. UI Stop action sends explicit Telegram acknowledgment and triggers lifecycle callbacks`: Verified that clicking stop dispatches Arabic acknowledgment to chat and executes `onCycleStop`.

---

## 3. Test Execution & Evidence

### Test Commands Executed
```bash
# 1. Dedicated M5 regression suite
node --test test/m5_cycle_report_delivery.test.js

# 2. Live VPS operational test
node --test test/live_vps_m4_operational.test.js

# 3. Docker VPN live infrastructure check
node --test test/docker_vpn_live_slots.test.js

# 4. Full project test suite
npm test
```

### Full Test Execution Results
```
ℹ tests 321
ℹ suites 120
ℹ pass 321
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 61300.870209
```

- **Exit Code**: `0`
- **Pass Rate**: `100.0%` (321 / 321 tests passing)
- **Zero regressions across all existing M1, M2, M3, M4, and M5 adversarial suites**.

---

## 4. Live Production Environment & Service State

- **Systemd Daemon**: `yj-telegram-bot.service`
  - Active State: `active (running)`
  - Active Main PID: `491101`
  - Node.js Runtime: `/usr/local/bin/node src/index.js`
  - Startup Events Logged:
    - `{"event":"telegram_ready","bot_id":9010112420,"username":"YJAutoPostaiBot"}`
    - `{"event":"watchdog_ready","action":"alert_only","timeoutMs":180000}`
- **Docker VPN Infrastructure**:
  - `yj_autopost_vpn_1`: Healthy (Port 18801)
  - `yj_autopost_vpn_2`: Healthy (Port 18802)
  - `yj_autopost_vpn_3`: Healthy (Port 18803)
  - `yj_autopost_vpn_4`: Healthy (Port 18804)
  - `yj_autopost_vpn_5`: Healthy (Port 18805)
- **Database Durability**:
  - Path: `/root/Projects/YJAutoPostOnX/Bot/data/state.sqlite`
  - Monolithic single-table state verified intact under WAL mode.
- **Safety Invariant Maintained**:
  - Zero live tweets published to X during repair or testing.

---

## 5. Verification Checklist

| Requirement | Implementation Verification | Status |
|---|---|---|
| Independent cycle delivers CSV even if 0 new items | `m5_cycle_report_delivery.test.js` Test 1 | ✅ VERIFIED |
| Re-executing same runId is deduplicated | `m5_cycle_report_delivery.test.js` Test 2 | ✅ VERIFIED |
| Consecutive independent cycles all receive reports | `m5_cycle_report_delivery.test.js` Test 3 | ✅ VERIFIED |
| Zero links today sends clear empty notification | `m5_cycle_report_delivery.test.js` Test 4 | ✅ VERIFIED |
| Ambiguous Telegram sends safely quarantined | `m5_cycle_report_delivery.test.js` Test 5 | ✅ VERIFIED |
| UI Stop sends explicit chat acknowledgment | `m5_cycle_report_delivery.test.js` Test 6 | ✅ VERIFIED |
| All existing tests continue to pass | `npm test` (321 passed, 0 failed) | ✅ VERIFIED |
| Systemd service running with new code | `yj-telegram-bot.service` PID 491101 active | ✅ VERIFIED |
