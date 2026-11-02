# Telegram CSV Delivery & Stop Lifecycle Verification (Milestone M8)

**Test Mission**: Long-Run Live Production Verification & Account Rotation Testing  
**Run ID**: `76ac31e51232d24cb9aa5c46`  
**Daemon Process**: `yj-telegram-bot.service` (Node.js PID: 941694)  
**Authorized Operator Chat ID**: `528864559`  
**Secondary Authorized Chat ID**: `5535435580`  
**Delivery Status**: `CONFIRMED_DELIVERED`  

---

## 1. Lifecycle Progression Sequence

The stop transition and post-cycle CSV export executed the full planned six-phase lifecycle contract:

```
[1] STOP_ACCEPTED
    cycle.state set to "stopping"
    snapshot captured in memory and state.sqlite
    Original schedule restored (enabled: false)
       │
       ▼
[2] RUNNER_FINISHED
    Runner completes post-publishing delay loop
    Fails closed against incoming item dispatches
    Cycle loops exit cleanly
       │
       ▼
[3] ON_CYCLE_FINISHED
    TelegramUi attach.finally triggers onCycleFinished(snapshot)
    links.send(run, { emptyMessage: false, terminal: true }) invoked
       │
       ▼
[4] CSV_GENERATED
    Day computed from Riyadh timezone (2026-11-03)
    Published rows for day extracted and formatted into RFC-4180 CSV
    Content Hash calculated: 80953beb14b01ca2427a93fd59540868bc5e00456f3238c7bcc33bd8db980948
       │
       ▼
[5] CSV_SEND_STARTED
    linkOutbox record created with status: "sending"
    Multipart document dispatched to Telegram Bot API endpoint
       │
       ▼
[6] TELEGRAM_RESPONSE_RECEIVED & CONFIRMED
    HTTP 200 OK received with telegram message_id (1538 / 1537)
    linkDeliveries and linkOutbox updated to status: "delivered"
    Structured log emitted: telegram_document_sent
```

---

## 2. Delivery Receipt Audit

### Primary Admin Destination (`528864559`)

```json
{
  "deliveryId": "5c63ae98-e3fb-48be-9975-8bcf46e7df40",
  "outboxId": "e395a8e4-07ae-4e2a-bbb5-fb3cd7f3de63",
  "runId": "76ac31e51232d24cb9aa5c46",
  "day": "2026-11-03",
  "kind": "document",
  "chatId": "528864559",
  "itemIds": [
    "60daf1f2-6d3d-4ca6-a130-a7d460491e3d"
  ],
  "contentHash": "80953beb14b01ca2427a93fd59540868bc5e00456f3238c7bcc33bd8db980948",
  "attempted": true,
  "ok": true,
  "attemptedAt": "2026-11-02T21:10:56.036Z",
  "messageId": 1538,
  "deliveredAt": "2026-11-02T21:10:57.193Z"
}
```

### Secondary Admin Destination (`5535435580`)

```json
{
  "deliveryId": "30e9d8cc-9c44-4b88-8232-0a897fa71fa9",
  "outboxId": "716b217d-188b-4481-9c1c-7d9e28105834",
  "runId": "76ac31e51232d24cb9aa5c46",
  "day": "2026-11-03",
  "kind": "document",
  "chatId": "5535435580",
  "itemIds": [
    "60daf1f2-6d3d-4ca6-a130-a7d460491e3d"
  ],
  "contentHash": "80953beb14b01ca2427a93fd59540868bc5e00456f3238c7bcc33bd8db980948",
  "attempted": true,
  "ok": true,
  "attemptedAt": "2026-11-02T21:10:56.202Z",
  "messageId": 1537,
  "deliveredAt": "2026-11-02T21:10:57.034Z"
}
```

---

## 3. Syslog Proof of Delivery

From `journalctl -u yj-telegram-bot.service`:
```
Nov 03 00:10:57 MasterYJ yj-telegram-bot[941694]: {"timestamp":"2026-11-02T21:10:57.136Z","level":"info","component":"link_exports","event":"telegram_document_sent","runId":"76ac31e51232d24cb9aa5c46","accountId":null,"queueItemId":null,"attemptId":null,"operation":"sendDocument","result":"success","durationMs":null,"errorCode":null,"sanitizedError":null,"retryCount":null,"suppressionReason":null,"ok":true,"chat_id":"5535435580","message_id":1537,"outboxId":"716b217d-188b-4481-9c1c-7d9e28105834","day":"2026-11-03"}
Nov 03 00:10:57 MasterYJ yj-telegram-bot[941694]: {"timestamp":"2026-11-02T21:10:57.313Z","level":"info","component":"link_exports","event":"telegram_document_sent","runId":"76ac31e51232d24cb9aa5c46","accountId":null,"queueItemId":null,"attemptId":null,"operation":"sendDocument","result":"success","durationMs":null,"errorCode":null,"sanitizedError":null,"retryCount":null,"suppressionReason":null,"ok":true,"chat_id":"528864559","message_id":1538,"outboxId":"e395a8e4-07ae-4e2a-bbb5-fb3cd7f3de63","day":"2026-11-03"}
```

---

## 4. Delivery Integrity Checks

1. **Idempotency**: Scoped strictly to `(chatId, runId)`. Replay attempts will be cleanly suppressed by `alreadyDelivered` checks.
2. **Quota Isolation**: The CSV delivery operation is 100% isolated from posting quotas and account balances.
3. **Ambiguity Exclusion**: Ambiguous items (`5ebeb53f`, `99eb4ba0`) were strictly omitted from the delivered CSV file.
4. **Receipt Confirmation**: Exact Telegram API `message_id`s (`1538` and `1537`) captured and persisted in SQLite.
5. **Verdict**: **100% PASS**.
