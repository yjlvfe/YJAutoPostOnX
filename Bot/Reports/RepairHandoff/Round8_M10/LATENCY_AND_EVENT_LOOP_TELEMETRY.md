# Telemetry Analysis: Latency, Event Loop & Database Concurrency (M10)

**Measurement Window:** 2026-11-03 07:10:00 – 07:33:00 (Riyadh Time)  
**Run ID:** `b97fd7d352319b40c21649b5`  
**Host Environment:** MasterYJ (Linux 6.8.0-147-generic)

---

## 1. Direct X & Network Publish Latency (`publish_attempt_observation`)

Every publish attempt through the Python bridge and isolated SOCKS5 VPN was recorded with precise timing and text length metrics:

| Metric | Measured Value | Standard Target | Assessment |
| :--- | :---: | :---: | :---: |
| **Minimum Publish Latency** | **570 ms** | < 3,000 ms | Exceptional |
| **Median Publish Latency** | **876 ms** | < 2,500 ms | Exceptional |
| **Mean Publish Latency (Successful)** | **937.3 ms** | < 2,500 ms | Exceptional |
| **Maximum Publish Latency (Successful)** | **1,251 ms** | < 5,000 ms | Optimal |
| **Text Length (Code Points)** | **185 – 197** | $\le 280$ | Perfect Arabic Formatting |
| **Dispatch Fence Verification** | `dispatchEntered: true` | Required | 100% Verified |

---

## 2. Telegram Dual-Chat Panel Update Latency (`panel_edit`)

Control panels were refreshed simultaneously across both authorized admin chats (`528864559` - Owner, `5535435580` - Brother/Admin) using the isolated `Promise.allSettled` pipeline:

| Chat Identifier | Total Edit Attempts | Successful Edits | Mean Latency | Median Latency | Min Latency |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Owner Chat (`528864559`)** | 216 | 215 (99.5%)* | **348.7 ms** | 338 ms | 175 ms |
| **Brother Chat (`5535435580`)** | 216 | 216 (100.0%) | **329.0 ms** | 324 ms | 182 ms |
| **Aggregate Parity** | **432** | **431 (99.8%)** | **338.9 ms** | **331 ms** | **175 ms** |

*\*Note on Transient Telegram Timeout:*  
At `07:32:19`, Telegram API encountered a transient upstream timeout (`TELEGRAM_TIMEOUT` after 30s) on Chat `528864559`. Thanks to the `Promise.allSettled` isolation, this transient error did NOT crash the bot, did NOT interrupt Chat `5535435580`, and did NOT stall the publishing runner. The very next panel edit attempt 1 second later succeeded at 07:32:20 with 231ms latency.

---

## 3. SQLite Database Concurrency & Read Lock Elimination

Following the M10 deployment of deferred read transactions (`BEGIN` instead of `BEGIN IMMEDIATE` for `load()`):

| Concurrency Metric | Measured Value | Threshold Target | Status |
| :--- | :---: | :---: | :---: |
| **`sqlite_slow_read` Events During Run** | **0** | $\le 2$ | **Zero Read Stalls** |
| **Initial Store Load Time (`begin`)** | **240 ms** | < 500 ms | Optimal |
| **Cycle Start State Transition (`persist`)** | **156 ms** | < 300 ms | Optimal |
| **WAL File Concurrency** | Zero conflicts | Zero 409 | Normal |

---

## 4. Lifecycle & Export Delivery Telegram Receipts

| Event | Operation | Chat ID | Telegram Message ID | Delivery Result |
| :--- | :--- | :---: | :---: | :---: |
| **Start Notification** | `sendMessage` | `528864559` (Owner) | **1594** | `ok: true` (delivered) |
| **Start Notification** | `sendMessage` | `5535435580` (Brother) | **1595** | `ok: true` (delivered) |
| **Quota Completion Notification** | `sendMessage` | `5535435580` (Brother) | **1596** | `ok: true` (delivered) |
| **Quota Completion Notification** | `sendMessage` | `528864559` (Owner) | **1597** | `ok: true` (delivered) |
| **Daily CSV Export (`links_2026-11-03.csv`)** | `sendDocument` | `528864559` (Owner) | **1598** | `ok: true` (delivered) |
| **Daily CSV Export (`links_2026-11-03.csv`)** | `sendDocument` | `5535435580` (Brother) | **1599** | `ok: true` (delivered) |

---

## 5. VPS Host Resource Footprint

- **Host RAM:** 5.1 GiB used, 2.8 GiB available out of 7.8 GiB (Completely healthy).
- **Service Memory (RSS):** Stable at 259.8 MB (Peak 454.3 MB, zero leaks).
- **CPU Load:** 1.15, 1.34, 1.48 (Low overhead).
- **Docker VPN Gateways:** 5 / 5 healthy, zero restarts, 0 IP leaks.
- **Unrelated Projects:** `masteryj-9router`, `yjdownloadvideo` stack, and `cryptovpn` unaffected and operating normally.
