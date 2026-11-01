# YJAutoPostOnX — Master Roadmap & Task Tracker (33 Findings)

## Project Overview
YJAutoPostOnX is an automated publishing engine designed for high-reliability posting to X (formerly Twitter) using Direct API integration via SOCKS5 proxy, with Telegram bot administration, local SQLite queueing, and multi-tier fail-safe fencing.

---

## 1. Phase P1: Core Publishing Safety Fence & Concurrency Stabilization

### Objective
Eliminate duplicate post transmission across all failure modes (socket drops, timeout delays, process restarts, timeline propagation lags), enforce exact timeline verification, fence uncertain dispatch outcomes in durable `ambiguous` state, prevent queue stall, and guarantee zero-duplicate single-shot semantics across crashes.

### Phase Status: **COMPLETED (100%)**
- **Verification Environment**: Linux isolated network namespace (`unshare -Urn`, loopback only), mock X GraphQL server, synthetic SQLite databases.
- **CriticalClosure Acceptance Tests**: 44/44 PASS (38/38 base + 6 new negative/companion tests, 100% pass rate, 0 failures, 0 harness errors, verified repeatable).
- **Unit & Concurrency Tests**: `test_normalize_urls.py` (14/14 PASS), race condition reproduction suite (6/6 checks PASS).
- **Independent Standalone Proofs**: `verify_p1_004_dedup.js` (PASS), `verify_p1_005_queue_flow.js` (PASS).

### Phase P1 Core Task Matrix

| ID | Ref Finding | Module | Task Description | Acceptance Criteria | Antigravity Status | Codex Status | Evidence / Verification |
|---|---|---|---|---|:---:|:---:|---|
| **P1-001** | FINDING-001 | `Bot/python/direct_x_bridge.py` | Disambiguate pre-send vs post-send errors in `OnlySocksTransport.handle_async_request`. Prevent secondary transport fallback on non-idempotent POST. | • `A_SUCCESS` PASS (1 POST)<br>• `A_CONNECT_REFUSED` PASS (0 POST)<br>• `A_CURL_FAILOVER` PASS (1 POST)<br>• `A_ACCEPT_DROP` PASS (1 POST, drop propagates without 2nd POST)<br>• `A_DELAY` PASS (1 POST, timeout propagates without 2nd POST)<br>• `A_INCOMPLETE` PASS (1 POST) | **TESTED_PASS** | **PENDING** | Suite A: 6/6 PASS |
| **P1-002** | FINDING-002, FINDING-008 | `Bot/python/direct_x_bridge.py` | Overhaul `verify_timeline`, URL canonicalization & entity expansion (R1), and fail-closed matching: replace 40-char prefix matching with exact normalized comparison; support cursor pagination up to 2 pages; ingest GraphQL/Twikit entities; capture authentic timeline recovery in `publish()`. | • `E_MALFORMED` PASS (1 POST, ambiguous)<br>• `E_PAGE2` PASS (1 POST, strictly published)<br>• `E_PAGE2_EMPTY` PASS (1 POST, strictly ambiguous)<br>• `E_PAGE2_CORRECTED` PASS (1 POST, strictly published)<br>• `E_PREFIX`, `E_PREFIX_DATED`, `E_NODATE`, `E_WRONG_AUTHOR`, `E_LATE_VISIBLE` all PASS<br>• `E_URL_DIFF` PASS (ambiguous)<br>• `E_URL_MATCH` PASS (published)<br>• `E_URL_SHORTENED` PASS (published)<br>• Unit tests: 14/14 PASS | **TESTED_PASS** | **PENDING** | Suite E: 12/12 PASS<br>`test_normalize_urls.py`: 14/14 PASS |
| **P1-003** | FINDING-003, FINDING-009 | `Bot/src/runner.js` | Eliminate `verifiedNotPosted` retry loop; ensure unconfirmed in-flight dispatches remain durable `ambiguous` when `dispatchEntered === true`. Hardened attempt token guard and `s.posting.publishingAt` fencing in result/catch/finally/abort paths (R2). | • `B_SUCCESS` PASS (1 POST, published, quota 1)<br>• `B_LOST_EMPTY` PASS (1 POST, ambiguous, 0 replays)<br>• `B_RUNNER_REPLAY_ONLY` PASS (1 POST, ambiguous, 0 replays)<br>• `Q_LATE_CALLBACK` PASS (stale callback rejected)<br>• `Q_STALE_SUCCESS_PATH` PASS<br>• `Q_STALE_EXCEPTION_PATH` PASS<br>• Race reproduction: 6/6 PASS | **TESTED_PASS** | **PENDING** | Suite B: 3/3 PASS<br>Suite C-QUEUE: 3/3 PASS<br>`test_reproduction.js`: 6/6 PASS |
| **P1-004** | FINDING-011 | `Bot/src/runner.js` & `Bot/src/queue.js` | Enforce atomic attempt token fencing and local idempotency protection: link attempts to queue item identities, SQLite transaction locks, crash-survival, SHA-256 content deduplication (R4). | • `Q_RACE` PASS (5 parallel workers, 1 winner)<br>• `Q_BUSY` PASS (busy writer waits and acquires)<br>• `Q_STALE` PASS (stale generation recovered)<br>• `Q_CRASH_TX` PASS (killed transaction rolled back)<br>• Standalone dedup proof: PASS | **TESTED_PASS** | **PENDING** | Suite C-QUEUE: 4/4 PASS<br>`verify_p1_004_dedup.js`: PASS |
| **P1-005** | FINDING-026 | `Bot/src/runner.js` & `Bot/src/queue.js` | Non-blocking queue traversal: ambiguous items set `skipDelay = true` and do not stall the queue; runner loop continues processing subsequent eligible `pending` items (R4). | • Ambiguous items quarantined without halting cycle<br>• Zero queue stalls observed across all batch and recovery runs<br>• Standalone anti-stall proof: PASS (2 consecutive ambiguous items bypass delay; 3rd published in same cycle) | **TESTED_PASS** | **PENDING** | Suite B/E & Queue tests PASS<br>`verify_p1_005_queue_flow.js`: PASS |

---

## 2. Comprehensive Master Finding Registry (All 33 Findings)

| Finding ID | Severity | Phase | Finding Title / Description | Affected Module | Antigravity Status | Codex Status |
|---|:---:|:---:|---|---|:---:|:---:|
| **FINDING-001** | **P0** | **P1** | Python Transport Fallback on POST causing duplicate tweets | `Bot/python/direct_x_bridge.py` | **TESTED_PASS** | **PENDING** |
| **FINDING-002** | **P0** | **P1** | False 'verifiedNotPosted' due to 2s timeline window & 40-char prefix | `Bot/python/direct_x_bridge.py` | **TESTED_PASS** | **PENDING** |
| **FINDING-003** | **P0** | **P1** | Runner Ambiguous-to-Pending Loop causing replay storm | `Bot/src/runner.js` | **TESTED_PASS** | **PENDING** |
| **FINDING-004** | **P0** | **P2** | Telegram 409 Conflict Multi-Instance Polling | `Bot/src/telegram.js`, `systemd` | **TODO** | **PENDING** |
| **FINDING-005** | **P0** | **P2** | Unconditional Lock Removal in systemd Defeating Singleton | `systemd/yj-telegram-bot.service` | **TODO** | **PENDING** |
| **FINDING-006** | **P1** | **P3** | Single-Row JSON Write Amplification in SQLite | `Bot/src/sqliteStore.js` | **TODO** | **PENDING** |
| **FINDING-007** | **P1** | **P2** | Bypassing Account Suspension Check via `use_cache` | `Bot/src/accounts.js` | **TODO** | **PENDING** |
| **FINDING-008** | **P1** | **P2** | GraphQL KeyError due to Missing `urls` Field in Twikit | `Bot/python/direct_x_bridge.py` | **TODO** | **PENDING** |
| **FINDING-009** | **P1** | **P1** | Late Callback Token Race Overwriting Newer Attempts | `Bot/src/runner.js` | **TESTED_PASS** | **PENDING** |
| **FINDING-010** | **P1** | **P2** | Naive Substring Matching Causing False Account Lock | `Bot/src/accounts.js` | **TODO** | **PENDING** |
| **FINDING-011** | **P1** | **P1** | Lack of Upstream Idempotency Keys (Local Idempotency Protection) | `Bot/src/runner.js`, `Bot/src/queue.js` | **TESTED_PASS** | **PENDING** |
| **FINDING-012** | **P1** | **P2** | `curl_cffi` Missing from Requirements File | `Bot/requirements-direct-x.txt` | **TODO** | **PENDING** |
| **FINDING-013** | **P1** | **P4** | Content Engine Main-Thread Blocking during Semantic Check | `dev/automation/contentEngine.js` | **TODO** | **PENDING** |
| **FINDING-014** | **P2** | **P3** | Plaintext Cookies Storage | `Bot/data/cookies/` | **TODO** | **PENDING** |
| **FINDING-015** | **P2** | **P2** | Server IP Leak via ipify (--noproxy '*') | `Bot/src/dockerVpn.js` | **TODO** | **PENDING** |
| **FINDING-016** | **P2** | **P2** | Missing Strict Environment Variable Validation on Startup | `Bot/src/env.js` | **TODO** | **PENDING** |
| **FINDING-017** | **P2** | **P3** | Destructive /accounts_csv Overwrite on Empty Upload | `Bot/src/runner.js`, `Bot/src/telegramUi.js` | **TODO** | **PENDING** |
| **FINDING-018** | **P2** | **P2** | Telegram Polling Timeout Mismatch (Socket < Server) | `Bot/src/telegramApi.js` | **TODO** | **PENDING** |
| **FINDING-019** | **P2** | **P4** | Quadruple Alert Storm on Single Ambiguous Event | `Bot/src/telegram.js`, `Bot/src/watchdog.js` | **TODO** | **PENDING** |
| **FINDING-020** | **P2** | **P2** | Subprocess Stdio Buffer Overflow on Large Python Output | `Bot/src/directX.js` | **TODO** | **PENDING** |
| **FINDING-021** | **P2** | **P2** | Orphaned Python Subprocesses on Parent SIGKILL | `Bot/src/directX.js` | **TODO** | **PENDING** |
| **FINDING-022** | **P2** | **P3** | Missing Error Boundaries on Timers in scheduling.js | `Bot/src/scheduling.js` | **TODO** | **PENDING** |
| **FINDING-023** | **P2** | **P3** | Dependency on Experimental `node:sqlite` Module | `Bot/package.json` | **TODO** | **PENDING** |
| **FINDING-024** | **P2** | **P3** | Unchecked Revision Increment without Optimistic Concurrency | `Bot/src/sqliteStore.js` | **TODO** | **PENDING** |
| **FINDING-025** | **P2** | **P3** | SQLite Transaction Held Across Async Yield | `Bot/src/sqliteStore.js` | **TODO** | **PENDING** |
| **FINDING-026** | **P2** | **P1** | Ambiguous Queue Blocking (Stalled Items Halting Cycle) | `Bot/src/queue.js`, `Bot/src/runner.js` | **TESTED_PASS** | **PENDING** |
| **FINDING-027** | **P3** | **P4** | Duplicate Table Formatting Logic in 3 Separate Files | `Bot/src/tableUtils.js`, `Bot/src/accountTable.js` | **TODO** | **PENDING** |
| **FINDING-028** | **P3** | **P4** | Silent I/O Failures in forensicLogger.js | `Bot/src/forensicLogger.js` | **TODO** | **PENDING** |
| **FINDING-029** | **P3** | **P3** | Timezone Sensitivity in Quota Calculation | `Bot/src/quota.js` | **TODO** | **PENDING** |
| **FINDING-030** | **P3** | **P4** | Missing Reconciliation between forensic.jsonl and SQLite | `Bot/src/forensicLogger.js` | **TODO** | **PENDING** |
| **FINDING-031** | **P3** | **P2** | Unpinned Docker VPN Container Image Tag (:latest) | `Bot/docker/Dockerfile.vpn` | **TODO** | **PENDING** |
| **FINDING-032** | **P2** | **P4** | Token Budget Truncation in Content Engine Output | `dev/automation/contentEngine.js` | **TODO** | **PENDING** |
| **FINDING-033** | **P2** | **P4** | Missing Punctuation and Sentence Boundary Validation | `dev/automation/contentEngine.js` | **TODO** | **PENDING** |

---

## 3. Status Definitions

### Antigravity Lifecycle States:
- `TODO`: Pending implementation in scheduled phase.
- `IN_PROGRESS`: Actively undergoing development.
- `CODE_CHANGED`: Code changes applied, pending test verification.
- `TESTED_PASS`: Passed all isolated empirical test suites and regression checks.
- `TESTED_FAIL`: Failed acceptance test; under remediation.
- `BLOCKED`: Blocked by external production dependency or authorization requirement.

### Codex Lifecycle States:
- `PENDING`: Initial state for all findings; awaiting Codex review.
- `UNDER_REVIEW`: Codex currently analyzing diff and test logs.
- `APPROVED`: Codex approved the implementation.
- `NEEDS_FIX`: Codex identified defects requiring revision.
- `VERIFIED`: Final end-to-end verification completed and certified.
