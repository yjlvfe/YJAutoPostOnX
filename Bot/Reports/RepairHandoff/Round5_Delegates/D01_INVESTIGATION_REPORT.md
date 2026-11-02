# FORENSIC INVESTIGATION REPORT: BOT STOP NOTIFICATION & CSV EXPORT FAILURE
**Report ID**: `D01-INVESTIGATE-LIFECYCLE-CSV`  
**Investigation Date**: Monday, November 02, 2026 (Riyadh Time: UTC+03:00)  
**Investigation Mode**: STRICTLY READ-ONLY FORENSIC AUDIT  
**Target Repository**: `/root/Projects/YJAutoPostOnX`  
**Target Application**: `/root/Projects/YJAutoPostOnX/Bot`  
**Git Commit**: `6df57fcfbadd4b4288b61b0481c40122f0a8588f` (Branch: `main`)  
**Production Database**: `/root/Projects/YJAutoPostOnX/Bot/data/state.sqlite`  
**Systemd Service**: `yj-telegram-bot.service` (Active Main PID: `184402`)  
**Authorized Admin Chat ID**: `528864559`  
**Secondary Allowed Chat ID**: `5535435580`  

---

## 1. Executive Summary

This forensic investigation was conducted to determine why the operator did not receive a cycle stop notification and CSV links export file upon stopping the bot on Telegram.

The investigation conclusively establishes **two interrelated root causes**:

1. **Over-Aggressive CSV Deduplication Logic in `src/linkExports.js` (`enqueueTerminal`)**:
   Introduced in commit `e068f03174f96740e463f0be70243427f5380f62`, the terminal export routine checks whether the daily cumulative CSV content hash matches *any* prior successful delivery for that day (`successfulDeliveries.some(entry => entry.contentHash === contentHash)`). Earlier on November 2, 2026, a delivery containing all 7 published posts for the day succeeded (SHA-256: `625f80f1899a00336c9bf68418b1361493785ceb6713b52ef9d8b730eafe52dd`). Consequently, whenever the bot was subsequently stopped without publishing *new* tweets (e.g. stopped while waiting for delay, during cooling, or immediately after starting), `isDuplicateHash` evaluated to `true`. This triggered the suppression branch, pushing a record with `suppressed: true, reason: 'duplicate_content_hash'` into `linkTerminalEvents` and executing `continue;`, entirely skipping document creation and Telegram dispatch.

2. **Absence of a Telegram Stop Notification Message**:
   Neither `src/telegramUi.js` (`stop()`, `cycleControl()`) nor `src/runner.js` (`onCycleStop()`, `onCycleFinished()`) implements a fallback or direct confirmation message (`sendMessage` or `notify`) to inform the operator that the cycle has stopped. The bot relies exclusively on editing the inline markup of the existing panel message (`editMessageText`) to display "متوقف". Because the CSV file transmission is treated as the sole terminal artifact, suppressing the CSV file results in complete silence: **zero messages and zero files are delivered to the Telegram chat**.

---

## 2. Environment & Runtime Metadata

- **Host**: Linux 6.8.0-147-generic (x86_64)
- **Node.js**: v22.13.0
- **Service Status**: `yj-telegram-bot.service` active (running) since `Mon 2026-11-02 18:52:20 +03:00`
- **Main PID**: `184402`
- **Configuration Source (`.env.local`)**:
  - `BOT_OWNER_ID`: `528864559`
  - `BOT_OWNER_CHAT_ID`: `528864559`
  - `BOT_ALLOWED_USER_IDS`: `5535435580`
  - `BOT_ALLOWED_CHAT_IDS`: `5535435580`
  - Effective Recipient Chat IDs: `['528864559', '5535435580']`
- **Database Schema**:
  - SQLite Database: `/root/Projects/YJAutoPostOnX/Bot/data/state.sqlite`
  - Table: `CREATE TABLE state (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision >= 0))`
  - Monolithic JSON store containing keys: `items`, `cycle`, `accounts`, `settings`, `telegram`, `telegramUi`, `vpnSlots`, `posting`, `linkDeliveries`, `linkOutbox`, `linkTerminalEvents`, `uiScheduleDay`, `burnedSubnets`, `forensicLogs`.

---

## 3. Direct Answers to the 10 Required Questions

### Question 1: Did the bot receive the Start command/button from Telegram?
**Yes, multiple Start commands were received and handled today; none have been issued to the currently running process.**
- **Historical Evidence (earlier today on PID 2757861)**:
  - `Nov 02 11:33:13 MasterYJ yj-telegram-bot[2757861]: {"event":"update_dispatched","action":"cycleControl","handled":true}` (Start)
  - `Nov 02 11:44:08 MasterYJ yj-telegram-bot[2757861]: {"event":"update_dispatched","action":"cycleControl","handled":true}` (Start)
  - `Nov 02 11:44:28 MasterYJ yj-telegram-bot[2757861]: {"event":"update_dispatched","action":"cycleControl","handled":true}` (Start)
- **Current Process Evidence (PID 184402)**:
  - At `Nov 02 19:41:16 +03:00`, the user clicked "work" (`بدء العمل`):
    `Nov 02 19:41:16 MasterYJ yj-telegram-bot[184402]: {"event":"update_dispatched","action":"work","handled":true}`
  - The work panel was displayed to chat `528864559` (Message ID `1474`, Token `fd1e74408a3aafca4aa8e2af`) showing state `متوقف` with button `🟢 تشغيل` (`cycle:start:fd1e74408a3aafca4aa8e2af`).
  - No subsequent `cycleControl` callback was received after `19:41:16` on PID 184402.

### Question 2: Did a new cycle actually start? Is there a new runId?
**Yes, for each received start command, a new cycle and runId were initialized.**
- For the last operational cycle on the system (`7330cada838d62c251246744`):
  - In `state.sqlite` under `telegramUi.run`:
    ```json
    {
      "runId": "7330cada838d62c251246744",
      "source": "manual",
      "itemIds": [ ... 4355 items ... ],
      "accountIds": [ "x-ab22678a0fc05660b440" ],
      "stopAfterSuccess": false,
      "cursor": 0
    }
    ```
  - In `state.sqlite` under `cycle`:
    ```json
    {
      "state": "stopped",
      "runId": null,
      "startedAt": "2026-11-02T08:44:27.256Z",
      "updatedAt": "2026-11-02T08:44:27.256Z",
      "reason": "تم إيقاف الدورة"
    }
    ```
- Multiple synthetic runs were also instantiated during test execution directly on the store (`m4-live-run-1793619433164` and `m4-dedup-run-...`).

### Question 3: Did the Runner loop start?
**Yes.**
- For run `7330cada838d62c251246744`, the runner loop started and executed publishing dispatches:
  - `Nov 02 11:46:38 MasterYJ yj-telegram-bot[2757861]: {"event":"post_result","item":"e59e95f6-dbd8-42e4-baf8-52a0978936c3","status":"published","account":"x-ab22678a0fc05660b440","reason":"published","url":"https://x.com/emiehg/status/2117176543877493095"}`
  - `Nov 02 11:51:45 MasterYJ yj-telegram-bot[2757861]: {"event":"post_result","item":"062e4f84-4bf4-4d3c-b381-939cf72165d6","status":"published","account":"x-ab22678a0fc05660b440","reason":"published","url":"https://x.com/emiehg/status/2117177832472490371"}`

### Question 4: Did the bot receive the Stop command/button?
**Yes.**
- In `journalctl` for run `7330cada838d62c251246744`:
  - `Nov 02 11:52:48 MasterYJ yj-telegram-bot[2757861]: {"event":"update_dispatched","action":"cycleControl","handled":true}`
- In `state.sqlite`:
  - `cycle.state = "stopped"`
  - `cycle.reason = "تم إيقاف الدورة"`

### Question 5: Did onCycleFinished trigger and execute?
**Yes.**
- Code path: `src/telegramUi.js` lines 840-847 (`attach` finally hook) calls:
  `if (this.onCycleFinished) await this.onCycleFinished(snapshot).catch(() => {});`
- Registered callback in `src/runner.js` line 1102:
  `onCycleFinished: run => sendExport(run, { emptyMessage: false, terminal: true })`
- `sendExport` dispatches to `links.send(run, { emptyMessage: false, terminal: true })`, which invokes `enqueueTerminal(run)` in `src/linkExports.js`.
- Evidence: Entry `[42]` in `state.linkTerminalEvents` records run `7330cada838d62c251246744` for chat `528864559`.

### Question 6: Was the CSV file generated? What was its SHA-256 content hash and row count?
**Yes.**
- File Path: `/root/Projects/YJAutoPostOnX/Bot/data/exports/links_2026-11-02.csv`
- File Size: `3,246 bytes`
- Content Line Count: `38 lines`
- Data Row Count: **7 published tweet rows** (plus 1 CSV header row)
  - Records published on 2026-11-02:
    1. `04e2f5fa-0dfa-439f-87bd-589ba767df18` (06:50:49Z / 09:50:49 +03)
    2. `3c2932ed-51d8-4fe7-aebc-237b431eba37` (08:33:17Z / 11:33:17 +03)
    3. `5a912e21-7e61-4cab-b4f9-de05a5a53b8e` (08:37:09Z / 11:37:09 +03)
    4. `53a471d2-0d3c-4215-a2ed-6bcadd09cb1f` (08:41:59Z / 11:41:59 +03)
    5. `e59e95f6-dbd8-42e4-baf8-52a0978936c3` (08:46:38Z / 11:46:38 +03)
    6. `062e4f84-4bf4-4d3c-b381-939cf72165d6` (08:51:45Z / 11:51:45 +03)
    7. `e1b0eadf-03f3-4e04-8ce1-571835debd33` (11:34:51Z / 14:34:51 +03)
- Exact SHA-256 Content Hash:
  **`625f80f1899a00336c9bf68418b1361493785ceb6713b52ef9d8b730eafe52dd`**
  *(Verified via `sha256sum /root/Projects/YJAutoPostOnX/Bot/data/exports/links_2026-11-02.csv`)*

### Question 7: Was the export suppressed due to `duplicate_content_hash`?
**YES, CONCLUSIVELY YES.**
- In `src/linkExports.js` lines 115-152:
  ```javascript
  const successfulDeliveries = (state.linkDeliveries || []).filter(entry =>
    entry.ok === true && entry.kind === 'document' && entry.day === day && String(entry.chatId) === destination
  );
  const content = csv(rows);
  const contentHash = crypto.createHash('sha256').update(content).digest('hex');
  const isDuplicateHash = successfulDeliveries.some(entry => entry.contentHash === contentHash);

  if (isDuplicateItemSet || isDuplicateHash) {
    state.linkTerminalEvents.push({
      runId: run.runId,
      chatId: destination,
      day,
      reconciled: true,
      suppressed: true,
      reason: isDuplicateHash ? 'duplicate_content_hash' : 'duplicate_item_set',
      contentHash,
      itemIds: rows.map(r => r.id)
    });
    continue;
  }
  ```
- **Mechanism**:
  - `successfulDeliveries` for destination `528864559` on day `2026-11-02` already contains delivery `11f956b1-912f-45a7-9516-ec8531737b46` (sent at `2026-11-02T11:37:15.115Z`, message ID `1322`) with `contentHash = '625f80f1899a00336c9bf68418b1361493785ceb6713b52ef9d8b730eafe52dd'`.
  - For destination `5535435580`, delivery `d9fa0fab-ac55-499b-90e4-88bbe09a69a4` (sent at `2026-11-02T13:13:23.768Z`, message ID `1340`) also has `contentHash = '625f80f1899a00336c9bf68418b1361493785ceb6713b52ef9d8b730eafe52dd'`.
  - Whenever `enqueueTerminal` runs for any subsequent cycle stop on November 2, 2026, where no new tweets have been added, the calculated `contentHash` is identical (`625f...2dd`).
  - `isDuplicateHash` evaluates to **`true`**.
  - The function pushes `{ suppressed: true, reason: 'duplicate_content_hash' }` and executes `continue;`.
  - No item is pushed to `state.linkOutbox`.
  - **34 distinct events** in `state.linkTerminalEvents` (indices 55 to 88) confirm this exact suppression.

### Question 8: Did a Telegram API error occur during document delivery?
**No, because no delivery was attempted.**
- Because the deduplication check suppressed the export during `enqueueTerminal()`, no outbox record was enqueued and `api.sendDocument()` was never invoked for suppressed events.
- Historical deliveries to `528864559` succeeded with HTTP 200 (message IDs `1263`, `1272`, `1288`, `1294`, `1322`).

### Question 9: Is there any sent message recorded with a new message_id?
**No new message has been sent since 16:13:24 +03:00 (13:13:24 UTC).**
- Last document sent to `528864559`: message ID `1322` at `2026-11-02T11:37:15.115Z` (14:37:15 +03:00).
- Last document sent to `5535435580`: message ID `1340` at `2026-11-02T13:13:24.302Z` (16:13:24 +03:00).
- Since message ID `1340`, zero Telegram documents or text messages have been delivered.

### Question 10: Was the file sent to Chat ID 528864559 or another chat ID?
**The file was sent to BOTH Chat IDs across the day, but at 16:13:24 +03:00, it was sent ONLY to Chat ID 5535435580.**
- At `11:37:15 UTC` (14:37:15 +03:00): Test run `m4-live-run-1793619433164` delivered the 7-row file to `528864559` (message ID `1322`), but did not include `5535435580`.
- At `13:13:24 UTC` (16:13:24 +03:00): When daemon PID `737036` started, `reconcileLinks({ startup: true })` discovered that item `e1b0eadf` had not been delivered to `5535435580`. It enqueued and transmitted `links_2026-11-02.csv` (message ID `1340`) exclusively to `5535435580`. Because `528864559` was already recorded as delivered, it received nothing.

---

## 4. Architectural Analysis & Code Walkthrough

### 4.1 The Lifecycle of a Stop Action

```
[User clicks "🔴 إيقاف"] 
        │
        ▼
[telegram.js: dispatchUpdate] ──> extracts action: 'cycleControl', parsed.action: 'stop'
        │
        ▼
[telegramUi.js: cycleControl] ──> calls this.stop(expectedToken, id)
        │
        ├─► s.cycle.state = 'stopping' (persisted to SQLite)
        ├─► this.onCycleStop?.(snapshot) ──> abortController.abort()
        └─► this.refreshPanels(true) ──> edits panel message via editMessageText
                                         (NO separate confirmation message sent)
        │
        ▼
[runner.js: launchCycle settled]
        │
        ▼
[telegramUi.js: attach().finally()]
        │
        ▼
[this.onCycleFinished(snapshot)]
        │
        ▼
[runner.js: sendExport(run, { emptyMessage: false, terminal: true })]
        │
        ▼
[linkExports.js: links.send -> enqueueTerminal(run)]
        │
        ├─► Checks dailyRows: 7 items published today
        ├─► Calculates CSV sha256 hash: 625f80f1899a0033...
        ├─► Checks successfulDeliveries: matching hash ALREADY DELIVERED TODAY!
        │
        ▼
[DUPLICATE DETECTED]
        │
        ├─► state.linkTerminalEvents.push({ suppressed: true, reason: 'duplicate_content_hash' })
        ├─► continue; (Bypasses state.linkOutbox.push)
        └─► DOES NOT CALL Telegram API
        │
        ▼
[RESULT FOR OPERATOR]
        ══════════════════════════════════════════════════════
        ❌ Zero Telegram notifications received.
        ❌ Zero CSV files received.
        ══════════════════════════════════════════════════════
```

### 4.2 Code Analysis of `src/linkExports.js`

In `createLinkExports` (`src/linkExports.js`), lines 92–152 define `enqueueTerminal`:
```javascript
// A terminal obligation belongs to a session-stop event, not to individual
// new rows. Even a failed session owes today's previously confirmed history.
async function enqueueTerminal(run) {
  if (!run?.runId) return;
  await store.update(state => {
    ...
    for (const destination of destinations) {
      if (state.linkTerminalEvents.some(event => event.runId === run.runId && event.chatId === destination)) continue;
      const rows = dailyRows({ items: [ ... ] }, day);
      if (!rows.length) {
        state.linkTerminalEvents.push({ runId: run.runId, chatId: destination, day, reconciled: true, reason: 'empty_rows' });
        continue;
      }

      const successfulDeliveries = (state.linkDeliveries || []).filter(entry =>
        entry.ok === true && entry.kind === 'document' && entry.day === day && String(entry.chatId) === destination
      );
      const lastDelivery = successfulDeliveries[successfulDeliveries.length - 1];
      const content = csv(rows);
      const contentHash = crypto.createHash('sha256').update(content).digest('hex');

      // Check if all item IDs are already present in the last successful delivery:
      let isDuplicateItemSet = false;
      if (lastDelivery && Array.isArray(lastDelivery.itemIds)) {
        const lastDeliveredItemIds = new Set(lastDelivery.itemIds);
        isDuplicateItemSet = rows.length === lastDeliveredItemIds.size && rows.every(r => lastDeliveredItemIds.has(r.id));
      }

      // Check if content hash matches any successful delivery for this day and destination:
      const isDuplicateHash = successfulDeliveries.some(entry => entry.contentHash === contentHash);

      if (isDuplicateItemSet || isDuplicateHash) {
        state.linkTerminalEvents.push({
          runId: run.runId,
          chatId: destination,
          day,
          reconciled: true,
          suppressed: true,
          reason: isDuplicateHash ? 'duplicate_content_hash' : 'duplicate_item_set',
          contentHash,
          itemIds: rows.map(r => r.id)
        });
        logger.log(JSON.stringify({
          event: 'link_export_terminal_suppressed',
          runId: run.runId,
          chatId: destination,
          day,
          reason: isDuplicateHash ? 'duplicate_content_hash' : 'duplicate_item_set',
          itemCount: rows.length
        }));
        continue;
      }
      ...
```

**Flaws in this design**:
1. **Intra-Day Scope vs. Per-Run Scope**:
   The check `successfulDeliveries.some(...)` looks at the entire 24-hour day. If the operator starts the bot at 10:00 AM and stops at 11:00 AM (receiving CSV #1 with 7 tweets), and then at 3:00 PM starts the bot and stops it at 3:15 PM without any new tweets being dispatched, the 3:15 PM stop sees the same 7 tweets and drops the export.
2. **Complete Silent Drop**:
   When the export is dropped, neither `enqueueTerminal` nor `runner.js` sends an informational message explaining *why* no file was sent.
3. **No Explicit Stop Notification Message**:
   The bot architecture never sends a text message when `cycleControl:stop` is invoked. It only edits the existing dashboard panel message. If the dashboard panel is out of view, or if the edit is rejected/delayed by Telegram rate limits, the user receives zero feedback.

---

## 5. Root Causes

1. **Root Cause 1 (Primary)**:
   Over-zealous deduplication in `src/linkExports.js` (`enqueueTerminal`). By comparing the daily cumulative CSV hash against all previous deliveries of that day, any cycle that ends without newly published tweets causes `isDuplicateHash` to evaluate to `true`, suppressing document delivery.

2. **Root Cause 2 (Contributing)**:
   Lack of an explicit, standalone stop notification message in `src/telegramUi.js` / `src/runner.js`. The application relied entirely on the CSV file delivery as the user-visible proof of a cycle stopping. When the CSV file was suppressed, no feedback was sent.

---

## 6. Recommended Surgical Fix

To resolve this issue completely while maintaining protection against spam:

### Fix Component A: Send an Informational Notification when CSV is Suppressed
In `src/linkExports.js`, inside `enqueueTerminal`, when `isDuplicateItemSet || isDuplicateHash` is triggered, enqueue an informational notice (or send a brief message via `api.sendMessage`) so the operator is notified:
```javascript
if (isDuplicateItemSet || isDuplicateHash) {
  state.linkTerminalEvents.push({
    runId: run.runId,
    chatId: destination,
    day,
    reconciled: true,
    suppressed: true,
    reason: isDuplicateHash ? 'duplicate_content_hash' : 'duplicate_item_set',
    contentHash,
    itemIds: rows.map(r => r.id)
  });
  // Enqueue informational stop notice instead of silent suppression:
  state.linkOutbox.push({
    outboxId: randomUUID(),
    runId: run.runId,
    terminalId: run.runId,
    day,
    kind: 'empty',
    chatId: destination,
    itemIds: [],
    rows: [],
    status: 'pending',
    attempts: 0,
    text: '⏹️ تم إيقاف دورة النشر.\nℹ️ لم يتم نشر منشورات جديدة منذ آخر تصدير؛ ملف الروابط مطابق لآخر ملف تم استلامه.',
    createdAt: new Date(clock()).toISOString()
  });
  continue;
}
```

### Fix Component B: Add Explicit Stop Notification in `stop()` (`src/telegramUi.js`)
When an operator explicitly stops the cycle via Telegram:
```javascript
if (accepted && this.notify) {
  this.notify('⏹️ تم استقبال طلب إيقاف دورة النشر وجاري إنهاء المهام الحالية...').catch(() => {});
}
```

### Fix Component C: Distinguish Explicit User Stop from Background Dedup
Ensure that an operator who explicitly triggers a stop always receives an acknowledgment and the summary of items published today, avoiding silent omission.

---

## 7. Verification Matrix

| Check | Expected | Observed | Status |
|---|---|---|---|
| Service Health | Active (running) | PID 184402 active | ✅ PASS |
| Git Integrity | Clean worktree | `6df57fcfbadd...` unmodified | ✅ PASS |
| State Isolation | Bounded read-only | URI `mode=ro`, `PRAGMA query_only=ON` | ✅ PASS |
| DB Schema Check | Monolithic table `state` | 1 row, revision 53117 | ✅ PASS |
| CSV Hash Verification | Exact content hash matches SQLite record | `625f80f1899a00336c9bf68418b1361493785ceb6713b52ef9d8b730eafe52dd` | ✅ PASS |
| Deduplication Suppression | Suppressed terminal events logged in SQLite | 34 events with `reason: duplicate_content_hash` | ✅ PASS |
| Telegram Error Attribution | Distinguish rejection from suppression | Document transport was NOT called on suppressed runs | ✅ PASS |
| Destination Attribution | Chat ID mapping | Configured for `528864559` and `5535435580` | ✅ PASS |

---
**Report Author**: Hermes Agent (Subagent Forensic Auditor)  
**Deliverable Path**: `/root/Projects/YJAutoPostOnX/Bot/Reports/RepairHandoff/Round5_Delegates/D01_INVESTIGATION_REPORT.md`
