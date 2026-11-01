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
- **Unit & Concurrency Tests**: `test_normalize_urls.py` (25/25 PASS), `runner_stale_tokens.test.js` (3/3 PASS), race condition reproduction suite (6/6 checks PASS).
- **Independent Standalone Proofs**: `verify_stale_attempt_tokens.js` (PASS, 3/3 scenarios), `verify_p1_004_dedup.js` (PASS), `verify_p1_005_queue_flow.js` (PASS).

### Phase P1 Core Task Matrix

| ID | Ref Finding | Module | Task Description | Acceptance Criteria | Antigravity Status | Codex Status | Evidence / Verification |
|---|---|---|---|---|:---:|:---:|---|
| **P1-001** | FINDING-001 | `Bot/python/direct_x_bridge.py` | Disambiguate pre-send vs post-send errors in `OnlySocksTransport.handle_async_request`. Prevent secondary transport fallback on non-idempotent POST. | • `A_SUCCESS` PASS (1 POST)<br>• `A_CONNECT_REFUSED` PASS (0 POST)<br>• `A_CURL_FAILOVER` PASS (1 POST)<br>• `A_ACCEPT_DROP` PASS (1 POST, drop propagates without 2nd POST)<br>• `A_DELAY` PASS (1 POST, timeout propagates without 2nd POST)<br>• `A_INCOMPLETE` PASS (1 POST) | **TESTED_PASS** | **PENDING** | Suite A: 6/6 PASS |
| **P1-002** | FINDING-002, FINDING-008 | `Bot/python/direct_x_bridge.py` | Overhaul `verify_timeline`, URL canonicalization & entity expansion (R1), and fail-closed matching: replace 40-char prefix matching with exact normalized comparison; support cursor pagination up to 2 pages; extract authentic author from GraphQL/Twikit without hardcoding; enforce URL path/query case sensitivity (RFC 3986). | • `E_MALFORMED` PASS (1 POST, ambiguous)<br>• `E_PAGE2` PASS (1 POST, strictly published)<br>• `E_PAGE2_EMPTY` PASS (1 POST, strictly ambiguous)<br>• `E_PAGE2_CORRECTED` PASS (1 POST, strictly published)<br>• `E_PREFIX`, `E_PREFIX_DATED`, `E_NODATE`, `E_WRONG_AUTHOR`, `E_LATE_VISIBLE` all PASS<br>• `E_URL_DIFF` PASS (ambiguous)<br>• `E_URL_MATCH` PASS (published)<br>• `E_URL_SHORTENED` PASS (published)<br>• Unit tests: 25/25 PASS | **TESTED_PASS** | **PENDING** | Suite E: 12/12 PASS<br>`test_normalize_urls.py`: 25/25 PASS |
| **P1-003** | FINDING-003, FINDING-009 | `Bot/src/runner.js` | Eliminate `verifiedNotPosted` retry loop; ensure unconfirmed in-flight dispatches remain durable `ambiguous` when `dispatchEntered === true`. Hardened attempt token guard and `s.posting.publishingAt` fencing across all result/catch/finally/abort paths (R2). | • `B_SUCCESS` PASS (1 POST, published, quota 1)<br>• `B_LOST_EMPTY` PASS (1 POST, ambiguous, 0 replays)<br>• `B_RUNNER_REPLAY_ONLY` PASS (1 POST, ambiguous, 0 replays)<br>• `Q_LATE_CALLBACK` PASS (stale callback rejected)<br>• `Q_STALE_SUCCESS_PATH` PASS<br>• `Q_STALE_EXCEPTION_PATH` PASS<br>• Stale token suite: 3/3 PASS<br>• Race reproduction: 6/6 PASS | **TESTED_PASS** | **PENDING** | Suite B: 3/3 PASS<br>Suite C-QUEUE: 3/3 PASS<br>`runner_stale_tokens.test.js`: 3/3 PASS<br>`verify_stale_attempt_tokens.js`: 3/3 PASS |
| **P1-004** | FINDING-011 | `Bot/src/runner.js` & `Bot/src/queue.js` | Enforce atomic attempt token fencing and local idempotency protection: link attempts to queue item identities, SQLite transaction locks, crash-survival, SHA-256 content deduplication (R4). | • `Q_RACE` PASS (5 parallel workers, 1 winner)<br>• `Q_BUSY` PASS (busy writer waits and acquires)<br>• `Q_STALE` PASS (stale generation recovered)<br>• `Q_CRASH_TX` PASS (killed transaction rolled back)<br>• Standalone dedup proof: PASS | **TESTED_PASS** | **PENDING** | Suite C-QUEUE: 4/4 PASS<br>`verify_p1_004_dedup.js`: PASS |
| **P1-005** | FINDING-026 | `Bot/src/runner.js` & `Bot/src/queue.js` | Non-blocking queue traversal: ambiguous items set `skipDelay = true` and do not stall the queue; runner loop continues processing subsequent eligible `pending` items (R4). | • Ambiguous items quarantined without halting cycle<br>• Zero queue stalls observed across all batch and recovery runs<br>• Standalone anti-stall proof: PASS (2 consecutive ambiguous items bypass delay; 3rd published in same cycle) | **TESTED_PASS** | **PENDING** | Suite B/E & Queue tests PASS<br>`verify_p1_005_queue_flow.js`: PASS |

---

## 2. Phase P2: Concurrency, Network Isolation & Bridge Robustness

### Objective
Resolve high-impact concurrency, process lifecycle, environment integrity, and direct-X API defects identified in Phase P2. Guarantee zero multi-instance Telegram polling conflicts (FINDING-004), secure systemd singleton semantics against lock deletion (FINDING-005), enforce live profile and suspension checks (FINDING-007), eliminate Twikit GraphQL entity KeyErrors (FINDING-008), replace naive substring matching with regex boundary detection (FINDING-010), pin curl_cffi in requirements (FINDING-012), prevent host IP leaks (FINDING-015), enforce strict environment validation (FINDING-016), adapt Telegram socket timeouts for long-polling (FINDING-018), protect against stdio buffer overflow (FINDING-020), prevent orphaned Python processes using Linux kernel parent death signals (FINDING-021), and pin VPN image tags (FINDING-031).

### Phase Status: **COMPLETED (100%)**
- **Verification Environment**: Linux isolated network namespace (`unshare -Urn`, loopback only), Python 3.12 / `.venv-direct-x`, Node.js v22.
- **CriticalClosure Acceptance Tests**: 44/44 PASS (100% pass rate, 0 failures, 0 harness errors).
- **Node.js Unit & Concurrency Tests**: 42/42 PASS across 10 test suites (`single_instance_lock`, `telegram_api_timeout`, `env_validation`, `docker_vpn_server_ip`, `p2_concurrency`, `direct_x_cache_verification`, `runner_stale_tokens`).
- **Python Unit Tests**: 84/84 PASS (`test_p2_track2.py`, `test_adversarial_challenge.py`, `test_normalize_urls.py`).
- **Empirical Reproducers**: 7/7 PASS (`test/p2_reproducer_test.py` covering pre-fix and post-fix behavior for FINDING-008 and FINDING-010).

### Phase P2 Core Task Matrix

| ID | Ref Finding | Module | Task Description | Acceptance Criteria | Antigravity Status | Codex Status | Evidence / Verification |
|---|---|---|---|---|:---:|:---:|---|
| **P2-001** | FINDING-004, FINDING-005 | `Bot/src/runner.js`, `systemd` | Enforce active PID liveness checks in `SingleInstanceLock.recoverStale()`; remove unconditional `rm -f` lock removals from systemd service file; terminate immediately with `TELEGRAM_CONFLICT` on HTTP 409. | • Multi-instance collision rejected<br>• `rm -f` does not allow second process when PID alive<br>• 409 Conflict stops retry storm | **TESTED_PASS** | **PENDING** | `single_instance_lock.test.js`: 5/5 PASS<br>`p2_concurrency.test.js`: 4/4 PASS |
| **P2-002** | FINDING-007 | `Bot/src/directX.js`, `Bot/python/direct_x_bridge.py` | Enforce live profile verification in `_identity_once` even with `use_cache`; require `identity.authenticated === true` and `!accountFailure` in `validIdentity`. | • Suspended/banned accounts blocked immediately<br>• Cache does not bypass live suspension check | **TESTED_PASS** | **PENDING** | `direct_x_cache_verification.test.js`: 2/2 PASS<br>`test_p2_track2.py`: PASS |
| **P2-003** | FINDING-008 | `Bot/python/direct_x_compat.py`, `direct_x_bridge.py` | Defensively normalize GraphQL user payloads in `_compat_user_data`: ensure `entities['description']['urls']` and `entities['url']['urls']` exist as lists even when missing or `None`. | • `KeyError: 'urls'` eliminated<br>• `AttributeError: 'NoneType'` eliminated<br>• Full GraphQL user payloads parsed | **TESTED_PASS** | **PENDING** | `test_p2_track2.py`: PASS<br>`p2_reproducer_test.py`: 4/4 PASS |
| **P2-004** | FINDING-010 | `Bot/python/direct_x_compat.py` | Replace naive substring matching (`'suspended' in combined`) with token-boundary regex `_BANNED_PATTERN` and strict X numeric error codes (`64, 63, 141`). | • "unsuspended" not falsely banned<br>• Tweet text with "banned" not falsely banned<br>• True suspensions classified | **TESTED_PASS** | **PENDING** | `test_p2_track2.py`: PASS<br>`p2_reproducer_test.py`: 3/3 PASS |
| **P2-005** | FINDING-012 | `Bot/requirements-direct-x.txt`, `direct_x_compat.py` | Pin `curl_cffi==0.16.3` in requirements and runtime version verification to ensure Chrome TLS/JA3 impersonation. | • `curl_cffi` importable<br>• Version matches runtime check | **TESTED_PASS** | **PENDING** | `test_p2_track2.py`: 2/2 PASS |
| **P2-006** | FINDING-015 | `Bot/src/dockerVpn.js` | Remove `--noproxy '*'` from ipify fallback; prioritize local interface lookup and `process.env.SERVER_IP`; cache IP in memory to eliminate IP leak. | • No host IP leak via curl<br>• Memory caching prevents duplicate requests | **TESTED_PASS** | **PENDING** | `docker_vpn_server_ip.test.js`: 6/6 PASS |
| **P2-007** | FINDING-016 | `Bot/src/env.js` | Implement `validateEnv()` with `EnvValidationError`: enforce required keys in production/daemon mode; validate regex patterns on tokens, IDs, paths. | • Production fails loudly on missing keys<br>• Token and IP formats validated | **TESTED_PASS** | **PENDING** | `env_validation.test.js`: 13/13 PASS |
| **P2-008** | FINDING-018 | `Bot/src/telegramApi.js` | Dynamically calculate socket read deadline: `Math.max(timeoutMs, (params.timeout + 15) * 1000)` so socket timeout strictly exceeds server long poll. | • Socket read timeout >= server poll + 15s<br>• Premature `TELEGRAM_TIMEOUT` eliminated | **TESTED_PASS** | **PENDING** | `telegram_api_timeout.test.js`: 2/2 PASS<br>`p2_concurrency.test.js`: 3/3 PASS |
| **P2-009** | FINDING-020, FINDING-021 | `Bot/src/directX.js`, `direct_x_bridge.py` | Drain stdio buffer line-by-line before 1MB checks; set Linux kernel `prctl(PR_SET_PDEATHSIG, SIGTERM)` on child start; maintain process registry with graceful SIGTERM/SIGKILL escalation. | • Stdio buffer does not overflow on large JSON<br>• Parent SIGKILL terminates child immediately<br>• Zero orphaned Python processes | **TESTED_PASS** | **PENDING** | CriticalClosure IPC suites PASS<br>Empirical child reaper verified |
| **P2-010** | FINDING-031 | `Bot/docker/Dockerfile.vpn`, `dockerVpn.js` | Pin `ARG NORDVPN_VERSION="6.0.2"` and default `VPN_IMAGE` to `yj_autopost_vpn_image:6.0.2` with backward compatibility for `:latest`. | • Image tags explicitly pinned<br>• Backward compatibility preserved | **TESTED_PASS** | **PENDING** | `docker_vpn_server_ip.test.js`: 4/4 PASS |

---

## 2.5. Live Production Verification (VPS Host) — Milestones M1 to M5

### Objective
Verify that all P1 and P2 repairs operate seamlessly on the live VPS production host (`MasterYJ`), resolve operational UI refresh hangs, align the systemd service, verify strict quota consumption and persistence, execute authentic live publishing on X with end-to-end evidence delivery, prove bot lifecycle and recovery under adverse conditions, and synchronize governance documentation.

### Milestones Breakdown & Verification Status: **COMPLETED (100%)**

- **Milestone M1: Accounts Refresh & Exit IP Display (R1)**
  - **Status**: **TESTED_PASS** (Signoff pending user live verification)
  - **Diagnosis & Fix**: Addressed system python PEP 668 version mismatch and unhandled retry loops in `accountRefresh.js`. Pinned `DIRECT_X_PYTHON` to `.venv-direct-x` in systemd service and `.env.local`.
  - **Operational Results**: Exit IPs resolved cleanly in Telegram UI table (`187.40.234.102` for `@crytpokingxvo8`, `187.14.50.72` for `@emiehg`). Buttons transition cleanly from "⏳ جاري التحديث" back to "🔄 تحديث".
  - **Test Evidence**: `test/account_refresh_and_exit_ip.test.js` (14/14 PASS), `test/empirical_stress_challenge.test.js` (8/8 PASS).

- **Milestone M2: VPS Service Lifecycle & Process Concurrency Hardening (R2)**
  - **Status**: **TESTED_PASS** (Signoff pending user live verification)
  - **Diagnosis & Fix**: Removed destructive `rm -f /root/Projects/YJAutoPostOnX/Bot/data/telegram-runner.lock` from systemd service file. Hardened `SingleInstanceLock.recoverStale()` with active PID liveness checks and immediate HTTP 409 Conflict exit.
  - **Operational Results**: Service restarted cleanly under systemd. Preserved SQLite database, accounts, queue items (4,363 pending, 82 published), and quotas. Tested against 10 parallel worker attacks with zero lock displacement.
  - **Test Evidence**: `test/m2_concurrency_challenge.test.js` (5/5 PASS), `test/single_instance_lock.test.js` (5/5 PASS), `test/p2_concurrency.test.js` (4/4 PASS).

- **Milestone M3: Authentic Live Publishing on X & Strict Quota Enforcement (R3)**
  - **Status**: **TESTED_PASS** (Signoff pending user live verification)
  - **Execution**: Published approved pending queue item `0166519a-2794-47e9-94f8-59a392681339` on account `@emiehg` via SOCKS5 proxy slot 18802 (`yj_autopost_vpn_2`, Exit IP `187.14.50.72`).
  - **Live URL**: `https://x.com/emiehg/status/2116996420637196576` (Rest ID: `2116996420637196576`)
  - **Reachability**: HTTP 307 -> 200 OK via curl, OpenGraph metadata matching, visible on public timeline.
  - **Quota Enforcement**: `@emiehg` quota incremented from 5 to 6 (+1 exactly). `@crytpokingxvo8` remained at 9. Quota persisted across service restarts without double-deduction.
  - **Test Evidence**: `test/m3_quota_and_fencing_challenge.test.js` (11/11 PASS).

- **Milestone M4: Bot Lifecycle Testing & UI Controls (R4)**
  - **Status**: **TESTED_PASS** (Signoff pending user live verification)
  - **Verification**: Start/Stop cycle transitions (`running` <-> `stopped`), UI controls rendering ("🟢 تشغيل" / "🔴 إيقاف", "🔄 تحديث" / "⏳ جاري التحديث"), race condition prevention on duplicate starts, stop token verification, and Docker VPN health across ports 18801 and 18802.
  - **Test Evidence**: `test/m4_lifecycle_and_recovery.test.js` (Subtask 1: 5/5 PASS).

- **Milestone M5: Telegram Notifications, Failure/Recovery, Docs, Git Sync & Evidence Delivery (R4, R5, R6)**
  - **Status**: **TESTED_PASS** (Signoff pending user live verification)
  - **Telegram Notifications & CSV**: Verified `/root/Projects/YJAutoPostOnX/Bot/data/exports/links_2026-11-01.csv` contains all 15 authentic records with correct headers. Confirmed delivery to admin chats `528864559` (message 1245) and `5535435580` (message 1246) via journalctl.
  - **Failure & Recovery**: Verified network timeout transitions to `ambiguous` with quarantine and zero quota deduction; verified quota exhaustion refusal; verified `SingleInstanceLock` mutual exclusion.
  - **Documentation & Git Sync**: `MASTER_TODO.md` updated with Codex status `PENDING` across all 33 findings. `PROGRESS_HISTORY.md` appended. Evidence ZIP archive assembled and verified (`unzip -t`). Code committed and pushed to remote `origin/main`.
  - **Test Evidence**: `test/m4_lifecycle_and_recovery.test.js` (Subtasks 2 & 3: 5/5 PASS). Total test suite: 104/104 PASS.

### Governance & Signoff Status
- **Phase P1 Final Signoff**: **PENDING** (Reserved for user live testing)
- **Phase P2 Final Signoff**: **PENDING** (Reserved for user live testing)
- **Codex Review Status**: Strictly **PENDING** across all 33 findings in registry table below.

---

## 3. Comprehensive Master Finding Registry (All 33 Findings)

| Finding ID | Severity | Phase | Finding Title / Description | Affected Module | Antigravity Status | Codex Status |
|---|:---:|:---:|---|---|:---:|:---:|
| **FINDING-001** | **P0** | **P1** | Python Transport Fallback on POST causing duplicate tweets | `Bot/python/direct_x_bridge.py` | **TESTED_PASS** | **PENDING** |
| **FINDING-002** | **P0** | **P1** | False 'verifiedNotPosted' due to 2s timeline window & 40-char prefix | `Bot/python/direct_x_bridge.py` | **TESTED_PASS** | **PENDING** |
| **FINDING-003** | **P0** | **P1** | Runner Ambiguous-to-Pending Loop causing replay storm | `Bot/src/runner.js` | **TESTED_PASS** | **PENDING** |
| **FINDING-004** | **P0** | **P2** | Telegram 409 Conflict Multi-Instance Polling | `Bot/src/telegram.js`, `systemd` | **TESTED_PASS** | **PENDING** |
| **FINDING-005** | **P0** | **P2** | Unconditional Lock Removal in systemd Defeating Singleton | `systemd/yj-telegram-bot.service` | **TESTED_PASS** | **PENDING** |
| **FINDING-006** | **P1** | **P3** | Single-Row JSON Write Amplification in SQLite | `Bot/src/sqliteStore.js` | **TODO** | **PENDING** |
| **FINDING-007** | **P1** | **P2** | Bypassing Account Suspension Check via `use_cache` | `Bot/src/accounts.js` | **TESTED_PASS** | **PENDING** |
| **FINDING-008** | **P1** | **P2** | GraphQL KeyError due to Missing `urls` Field in Twikit | `Bot/python/direct_x_bridge.py` | **TESTED_PASS** | **PENDING** |
| **FINDING-009** | **P1** | **P1** | Late Callback Token Race Overwriting Newer Attempts | `Bot/src/runner.js` | **TESTED_PASS** | **PENDING** |
| **FINDING-010** | **P1** | **P2** | Naive Substring Matching Causing False Account Lock | `Bot/src/accounts.js` | **TESTED_PASS** | **PENDING** |
| **FINDING-011** | **P1** | **P1** | Lack of Upstream Idempotency Keys (Local Idempotency Protection) | `Bot/src/runner.js`, `Bot/src/queue.js` | **TESTED_PASS** | **PENDING** |
| **FINDING-012** | **P1** | **P2** | `curl_cffi` Missing from Requirements File | `Bot/requirements-direct-x.txt` | **TESTED_PASS** | **PENDING** |
| **FINDING-013** | **P1** | **P4** | Content Engine Main-Thread Blocking during Semantic Check | `dev/automation/contentEngine.js` | **TODO** | **PENDING** |
| **FINDING-014** | **P2** | **P3** | Plaintext Cookies Storage | `Bot/data/cookies/` | **TODO** | **PENDING** |
| **FINDING-015** | **P2** | **P2** | Server IP Leak via ipify (--noproxy '*') | `Bot/src/dockerVpn.js` | **TESTED_PASS** | **PENDING** |
| **FINDING-016** | **P2** | **P2** | Missing Strict Environment Variable Validation on Startup | `Bot/src/env.js` | **TESTED_PASS** | **PENDING** |
| **FINDING-017** | **P2** | **P3** | Destructive /accounts_csv Overwrite on Empty Upload | `Bot/src/runner.js`, `Bot/src/telegramUi.js` | **TODO** | **PENDING** |
| **FINDING-018** | **P2** | **P2** | Telegram Polling Timeout Mismatch (Socket < Server) | `Bot/src/telegramApi.js` | **TESTED_PASS** | **PENDING** |
| **FINDING-019** | **P2** | **P4** | Quadruple Alert Storm on Single Ambiguous Event | `Bot/src/telegram.js`, `Bot/src/watchdog.js` | **TODO** | **PENDING** |
| **FINDING-020** | **P2** | **P2** | Subprocess Stdio Buffer Overflow on Large Python Output | `Bot/src/directX.js` | **TESTED_PASS** | **PENDING** |
| **FINDING-021** | **P2** | **P2** | Orphaned Python Subprocesses on Parent SIGKILL | `Bot/src/directX.js` | **TESTED_PASS** | **PENDING** |
| **FINDING-022** | **P2** | **P3** | Missing Error Boundaries on Timers in scheduling.js | `Bot/src/scheduling.js` | **TODO** | **PENDING** |
| **FINDING-023** | **P2** | **P3** | Dependency on Experimental `node:sqlite` Module | `Bot/package.json` | **TODO** | **PENDING** |
| **FINDING-024** | **P2** | **P3** | Unchecked Revision Increment without Optimistic Concurrency | `Bot/src/sqliteStore.js` | **TODO** | **PENDING** |
| **FINDING-025** | **P2** | **P3** | SQLite Transaction Held Across Async Yield | `Bot/src/sqliteStore.js` | **TODO** | **PENDING** |
| **FINDING-026** | **P2** | **P1** | Ambiguous Queue Blocking (Stalled Items Halting Cycle) | `Bot/src/queue.js`, `Bot/src/runner.js` | **TESTED_PASS** | **PENDING** |
| **FINDING-027** | **P3** | **P4** | Duplicate Table Formatting Logic in 3 Separate Files | `Bot/src/tableUtils.js`, `Bot/src/accountTable.js` | **TODO** | **PENDING** |
| **FINDING-028** | **P3** | **P4** | Silent I/O Failures in forensicLogger.js | `Bot/src/forensicLogger.js` | **TODO** | **PENDING** |
| **FINDING-029** | **P3** | **P3** | Timezone Sensitivity in Quota Calculation | `Bot/src/quota.js` | **TODO** | **PENDING** |
| **FINDING-030** | **P3** | **P4** | Missing Reconciliation between forensic.jsonl and SQLite | `Bot/src/forensicLogger.js` | **TODO** | **PENDING** |
| **FINDING-031** | **P3** | **P2** | Unpinned Docker VPN Container Image Tag (:latest) | `Bot/docker/Dockerfile.vpn` | **TESTED_PASS** | **PENDING** |
| **FINDING-032** | **P2** | **P4** | Token Budget Truncation in Content Engine Output | `dev/automation/contentEngine.js` | **TODO** | **PENDING** |
| **FINDING-033** | **P2** | **P4** | Missing Punctuation and Sentence Boundary Validation | `dev/automation/contentEngine.js` | **TODO** | **PENDING** |

---

## 4. Status Definitions

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
