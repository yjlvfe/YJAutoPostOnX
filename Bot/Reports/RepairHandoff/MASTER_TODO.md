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

- **Milestone M4: Live VPS Operational Verification, Real X Publishing & Delivery (10 Checks)**
  - **Status**: **TESTED_PASS** (Signoff pending user live verification)
  - **Check 1 (Service Alignment & Lock)**: Daemon reloaded and restarted under systemd (PID `2754845`). Lockfile `/root/Projects/YJAutoPostOnX/Bot/data/telegram-runner.lock` cleanly released and re-acquired by PID `2754845`. Zero diff between service unit and repo copy.
  - **Check 2 (Refresh & Exit IPs)**: 60-second bounded refresh logic verified in `accountRefresh.js` and `telegramUi.js`. All 5 Docker VPN containers verified healthy on ports 18801-18805 with pairwise distinct public Exit IPs (`187.40.234.102`, `187.14.50.72`, `187.40.234.180`, `187.40.234.147`, `187.40.235.169`) and zero host IP leak.
  - **Check 3 (Session Health & Diagnostics)**: Cookie files permissioned `0600` (`-rw-------`, root:root) with unexpired 2027 auth tokens. Live authentication verified for `@crytpokingxvo8` (User ID `2112766385252192256`) and `@emiehg` (User ID `2114825043343511553`). 8-class diagnostic taxonomy verified across 126 Python tests.
  - **Check 4 (Continuous Posting Progression)**: Pre-dispatch failure safely unpins item and transfers to next eligible account. Post-dispatch ambiguity quenches into durable quarantine without queue stall or retry.
  - **Check 5 (3-Strikes Counter Persistence)**: Failures distributed across 3 natural cycles in SQLite. 3rd strike isolates account with single notification; successful publish resets failures to 0.
  - **Check 6 (Dynamic Account Switching)**: Account toggling mid-cycle dynamically updates active accounts and reallocates VPN slots without losing items or resetting cycle.
  - **Check 7 (Real Authentic X Publishing & Quota)**: Live service published approved item `04e2f5fa-0dfa-439f-87bd-589ba767df18` via `@crytpokingxvo8` through SOCKS5 proxy `127.0.0.1:18801`. Live URL: `https://x.com/crytpokingxvo8/status/2117147398187479078` (Tweet ID `2117147398187479078`). Verified via 4 angles: HTTP 307->200 from Cloudflare Envoy, author metadata match (`@CrytpoKingxvo8`), OpenGraph snippet match, and SQLite persistence. Daily quota incremented exactly +1 (0 to 1 on `2026-11-02`) and persists across service restart. Cycle stopped immediately after 1 publish without queue drain.
  - **Check 8 (Telegram UI Lifecycle & 409 Prevention)**: SingleInstanceLock enforces 15-second mutual exclusion and eliminates Telegram 409 Conflict.
  - **Check 9 (Governance Updates)**: All 33 findings in Section 3 strictly preserved as `Codex Review Status: PENDING`. Phase P1/P2 final signoffs strictly preserved as `PENDING`.
  - **Check 10 (Git Remote Sync & Delivery)**: All code staged, committed, and pushed to `origin/main`. Evidence ZIP built with automated secret scanning and delivered to admin chats `528864559` and `5535435580`.
  - **Test Evidence**: Master test runner `scripts/run_all_automated_tests.sh`: 369/369 PASS (Tier 1 Python: 133 tests, Tier 2 Node.js: 189 tests, Tier 3 Netns: 42 tests, Tier 4 Docker VPN: 5 tests). Zero failures.

### Governance & Signoff Status
- **Phase P1 Final Signoff**: **PENDING** (Reserved for user live testing)
- **Phase P2 Final Signoff**: **PENDING** (Reserved for user live testing)
- **Codex Review Status**: Strictly **PENDING** across all 33 findings in registry table below.

---

## 2.6. Round 3: Production Recovery with 3-Strikes Isolation, CSV Dedup, and Timeline Verification

### Objective
Achieve full production recovery following post-369 ambiguous results and duplicate CSV incidents. Enforce 3-strikes account failure isolation on natural rotation turns, quarantine ambiguous post outcomes without replay storms, exclude transient network/VPN/proxy errors from failure strikes, protect pre-dispatch claimed items, enforce strict 5-active account ceiling, fix Twikit `None` return handling with timeline verification, implement granular 8-class diagnostics, eliminate CSV duplicate deliveries with content hash deduplication, suppress notification spam with single Arabic isolation alerts, eliminate Telegram 409 collisions, and perform comprehensive live VPS operational verification with zero impact on user programs.

### Round 3 Task Matrix

| Task / Feature ID | Module / Component | Task Description | Acceptance Criteria | Antigravity Status | Codex Status | Evidence / Verification |
|---|---|---|---|:---:|:---:|---|
| **R3-SURVEY** | Workspace & Logs | Deep log investigation of post-11:30 incidents (items `f75e4f8d`, `bd12d092`, `fa1f2749`); map root causes across Runner, Python, Docker, VPN, and Telegram. | • Root cause traced<br>• Zero assumptions<br>• Formal survey report produced | **TESTED_PASS** | **PENDING** | `explorer_r3_3/report.md` |
| **R3-3STRIKES** | `Bot/src/runner.js`, `Bot/src/accounts.js` | 3-strikes accounting distributed over 3 natural turns; cool on strikes 1 and 2; automatically isolate on strike 3 (`معزول (3 إخفاقات)`); reset to 0 on successful publish. | • Strike 1: cool + skip turn<br>• Strike 2: cool + skip turn<br>• Strike 3: isolate + alert<br>• Success: reset strikes to 0 | **TESTED_PASS** | **PENDING** | `m1_fixes_comprehensive.test.js` (20/20 PASS)<br>`challenger_iter2_concurrency_fuzz.test.js` |
| **R3-AMBIGUOUS** | `Bot/src/runner.js`, `Bot/src/queue.js` | Ambiguous outcomes quench into durable quarantine; persist `accountId` and `accountUsername` in SQLite items; never auto-replay; trigger account strike on natural turn. | • 0 auto-replays<br>• Attribution preserved in DB<br>• Non-blocking queue traversal | **TESTED_PASS** | **PENDING** | `m1_fixes_comprehensive.test.js`<br>`live_vps_m4_operational.test.js` |
| **R3-NETEXCLUDE** | `Bot/src/runner.js` | Exclude transient network/proxy/VPN container errors (`ECONNREFUSED`, `ProxyConnectionError`) from account strike counter. | • Transient proxy errors do not increment account strikes | **TESTED_PASS** | **PENDING** | `m1_fixes_comprehensive.test.js` (Test 2.1 PASS)<br>`live_vps_m4_operational.test.js` |
| **R3-PREDISPATCH** | `Bot/src/queue.js`, `Bot/src/runner.js` | Pre-dispatch post protection: `recoverProcessing` resets unattempted `claimed` items to `pending`; immediate transfer to next eligible account on pre-dispatch fault. | • 0 lost posts on pre-dispatch faults<br>• Item unpinned and transferred | **TESTED_PASS** | **PENDING** | `m1_fixes_comprehensive.test.js` (Test 3.1 & 3.2 PASS) |
| **R3-5ACCOUNT** | `Bot/src/accounts.js`, `Bot/src/telegramUi.js` | Unlimited stored accounts support with strict ceiling of max 5 active accounts; dynamic toggling mid-cycle without losing queue items or quotas. | • Max 5 active accounts enforced<br>• 6th activation rejected<br>• Dynamic slot reassignment | **TESTED_PASS** | **PENDING** | `m1_fixes_comprehensive.test.js` (Test 4.1 PASS)<br>`m3_telegram_and_csv_dedup.test.js` |
| **R3-TWIKIT-NONE** | `Bot/python/direct_x_bridge.py` | Fix `create_tweet` returning `None` by executing live timeline verification (`verify_timeline`) before returning unconfirmed outcome; recover tweet ID if found. | • None response triggers timeline lookup<br>• Verified tweet recovered<br>• Missing tweet fails to ambiguous | **TESTED_PASS** | **PENDING** | `test_m2_timeline_and_diagnostics.py`<br>183 Python tests PASS |
| **R3-8CLASS-DIAG** | `Bot/python/direct_x_compat.py` | Granular 8-class diagnostic classification: `banned`, `captcha`, `cookie_expired`, `auth_rejected`, `rate_limit`, `network_proxy_error`, `ambiguous`, `unknown`. | • Zero misclassifications<br>• Precise diagnostic attribution | **TESTED_PASS** | **PENDING** | `test_m2_timeline_and_diagnostics.py`<br>`test_adversarial_m2_challenger.py` |
| **R3-CSVDEDUP** | `Bot/src/linkExports.js` | Dual-layer CSV export deduplication using SHA-256 content hashing against `linkDeliveries` in SQLite; suppress duplicate CSV on cycle stop when 0 new posts. | • Duplicate CSV suppressed on stop<br>• Fresh CSV sent on new posts<br>• Message ID 1322 delivered | **TESTED_PASS** | **PENDING** | `m3_telegram_and_csv_dedup.test.js` (45/45 PASS)<br>`live_vps_m4_operational.test.js` |
| **R3-ALERTFENCE** | `Bot/src/telegramUi.js` | Single clear Arabic Telegram notification on account isolation (`تم عزل الحساب @... تلقائياً`); suppress retry spam on transient strikes 1 & 2; throttle queue stall alerts. | • Exactly 1 alert on strike 3<br>• 0 spam on strikes 1 and 2<br>• 1 alert on queue stall | **TESTED_PASS** | **PENDING** | `m3_telegram_and_csv_dedup.test.js` (Section 2 PASS) |
| **R3-409RESILIENCE** | `Bot/src/singleInstance.js`, `Bot/src/telegramUi.js` | Resilience against Telegram 409 Conflict: exponential backoff with jitter (`executeWithConflictBackoff`), PID liveness checks, single instance lock mutual exclusion. | • Zero 409 polling storms<br>• Mutual exclusion under concurrency | **TESTED_PASS** | **PENDING** | `m3_telegram_and_csv_dedup.test.js` (Section 4 PASS)<br>`singleInstance.js` |
| **R3-VPS-LIVE** | `Bot/test/live_vps_m4_operational.test.js` | Full live operational verification on VPS: 5 healthy VPN containers (ports 18801-18805), 1 authentic publish to X (`https://x.com/crytpokingxvo8/status/2117218878304801135`), quota -1, CSV 1322. | • 16/16 operational tests PASS<br>• 1 authentic tweet verified live<br>• Riyadh quota -1 persisted | **TESTED_PASS** | **PENDING** | `live_vps_m4_operational.test.js` (16/16 PASS)<br>HTTP/2 307 -> 200 OK on X |
| **R3-CLEANUP** | `RESOURCE_CLEANUP_REPORT.md` | Strict resource safety: 50%–56% RAM baseline preserved; user services (`MexcRadar` PID 1001, `BinanceChecker`, `MyWalletChecker`) & 11 user containers untouched; `/tmp/yj_m4_test` cleaned. | • 0 user services touched<br>• 0 leftover test files<br>• Detailed audit report created | **TESTED_PASS** | **PENDING** | `RESOURCE_CLEANUP_REPORT.md` |

### Governance & Signoff Status (Round 3)
- **Phase P1 Final Signoff**: **PENDING** (Reserved for user live testing)
- **Phase P2 Final Signoff**: **PENDING** (Reserved for user live testing)
- **Codex Review Status**: Strictly **PENDING** across all findings and Round 3 tasks.

---

## 2.7. Round 4: Production Hardening, 15 Findings Closure & NordVPN Thrashing Elimination (Milestone M6)

### Objective
Resolve the remaining 15 open findings across Phases P3 and P4, eliminate NordVPN container restart thrashing on transient disconnects, implement optimistic concurrency control (OCC) and sync transactions in `SqliteStore`, reject empty accounts CSV uploads fail-closed, consolidate duplicate table formatting into `tableUtils.js`, harden forensic logger durability, and guarantee zero regression across all test tiers.

### Round 4 Task Matrix

| Task / Feature ID | Module / Component | Task Description | Acceptance Criteria | Antigravity Status | Codex Status | Evidence / Verification |
|---|---|---|---|:---:|:---:|---|
| **R4-NORDVPN** | `Bot/docker/entrypoint.sh`, `sticky-health.sh` | Eliminate NordVPN reconnect thrashing; add resilient country-level fallback when pinned server disconnects; 60s failure backoff. | • 0 container restart loops<br>• 5/5 VPN slots healthy<br>• Restarts=0 | **TESTED_PASS** | **PENDING** | `docker_vpn_live_slots.test.js`<br>Live container uptime verified |
| **R4-SQLITE-OCC** | `Bot/src/sqliteStore.js` | Multi-process optimistic concurrency (`revision` check), reject async functions inside transactions fail-closed, WAL auto-checkpoint. | • OCC retries on revision conflict<br>• Async inside transaction rejected<br>• Node >= 22.5.0 enforced | **TESTED_PASS** | **PENDING** | `p3_p4_findings_verification.test.js` (Test 2 PASS) |
| **R4-EMPTYCSV** | `Bot/src/accounts.js`, `runner.js` | Reject empty or header-only accounts CSV uploads fail-closed (`EMPTY_ACCOUNTS_CSV`); alert operator via Telegram. | • Empty upload rejected<br>• Preserves existing accounts<br>• User-friendly Arabic alert | **TESTED_PASS** | **PENDING** | `p3_p4_findings_verification.test.js` (Test 1 PASS) |
| **R4-FORENSIC** | `Bot/src/forensicLogger.js` | Atomic two-way `reconcile()` between SQLite store and `forensic.jsonl`; tolerate corrupted JSONL lines; log structured stderr on I/O error. | • Atomic deduplication by ID<br>• Corrupt lines ignored<br>• Stderr structured error logged | **TESTED_PASS** | **PENDING** | `p3_p4_findings_verification.test.js` (Test 4 PASS) |
| **R4-TIMEZONE** | `Bot/src/quota.js`, `scheduling.js` | Defensive parsing of dates and timestamps for exact Asia/Riyadh calendar boundaries across all edge cases. | • Robust string/timestamp conversion<br>• Riyadh calendar day preserved | **TESTED_PASS** | **PENDING** | `p3_p4_findings_verification.test.js` (Test 5 PASS) |
| **R4-TABLES** | `Bot/src/tableUtils.js`, `accountTable.js` | Consolidate table formatting into single reusable `tableUtils.js`; eliminate duplicate rendering code. | • Centralized table generator<br>• Clean HTML output with caption | **TESTED_PASS** | **PENDING** | `p3_p4_findings_verification.test.js` (Test 3 PASS) |

### Governance & Signoff Status (Round 4)
- **Phase P1 Final Signoff**: **PENDING** (Reserved for user live testing)
- **Phase P2 Final Signoff**: **PENDING** (Reserved for user live testing)
- **Codex Review Status**: Strictly **PENDING** across all findings and Round 4 tasks.

---

## 2.8. Round 5: Real Telegram Stop Lifecycle & Per-RunId CSV Delivery Repair (Milestone M7)

### Objective
Resolve the operational defect where stopping the bot from Telegram suppressed the cumulative daily links CSV export with `reason: duplicate_content_hash` and failed to send an explicit stop acknowledgment to the operator. Scope export deduplication strictly to `(chatId, runId)` idempotency, deliver daily CSV on independent cycle stop even when 0 new items were posted in that cycle, send clear Arabic notice when 0 links exist today, acknowledge stop requests immediately in Telegram chat, flush link outbox immediately upon cycle finish, and maintain 100% safety invariants across quotas and ambiguous items.

### Round 5 Task Matrix

| Task / Feature ID | Module / Component | Task Description | Acceptance Criteria | Antigravity Status | Codex Status | Evidence / Verification |
|---|---|---|---|:---:|:---:|---|
| **R5-CSV-RUNID** | `Bot/src/linkExports.js` | Scope terminal CSV export deduplication to `(chatId, runId)` idempotency (`alreadyDelivered`, `alreadyOutbox`, `existingEvent`). Independent cycles (`runId_B !== runId_A`) on same day reliably deliver daily CSV. | • Cycle B delivers daily CSV even if 0 new items posted<br>• Replays of same runId safely suppressed (`duplicate_run_id`)<br>• Dual-layer protection in `deliver()` | **TESTED_PASS** | **PENDING** | `m5_cycle_report_delivery.test.js` (Tests 1, 2, 3 PASS) |
| **R5-EMPTY-NOTICE** | `Bot/src/linkExports.js` | When a cycle finishes on a day with 0 confirmed published links, enqueue and deliver clear Arabic notice: `لا توجد روابط منشورات مؤكدة لهذا اليوم.` protected by per-runId idempotency. | • 0 CSV files sent<br>• Exactly 1 clear Arabic text notice sent<br>• Replay of empty cycle suppressed | **TESTED_PASS** | **PENDING** | `m5_cycle_report_delivery.test.js` (Test 4 PASS) |
| **R5-STOP-NOTIFY** | `Bot/src/telegramUi.js` | In `stop()`, when stop request is accepted (`accepted === true`), immediately dispatch explicit Arabic acknowledgment message to chat prior to cancellation. | • Immediate Telegram chat confirmation<br>• Rapid duplicate clicks rejected (`stopped: false`, 0 duplicate alerts) | **TESTED_PASS** | **PENDING** | `m5_cycle_report_delivery.test.js` (Test 6 PASS) |
| **R5-OUTBOX-FLUSH** | `Bot/src/runner.js` | In `onCycleFinished`, immediately invoke `links.flush()` to drain terminal outbox obligations without waiting for periodic polling. | • Terminal export drained instantly<br>• Zero outbox lag on cycle stop | **TESTED_PASS** | **PENDING** | `m5_cycle_report_delivery.test.js` (Tests 1, 3 PASS) |
| **R5-SAFETY-GATES** | `Bot/src/linkExports.js`, `runner.js` | Maintain 100% isolation of quota values (untouched by report delivery or stop events); preserve ambiguous post quarantine; quarantine ambiguous Telegram sends. | • Quota debited strictly on published posts<br>• Ambiguous items excluded from CSV<br>• Failed sends quarantined | **TESTED_PASS** | **PENDING** | `m5_cycle_report_delivery.test.js` (Test 5 PASS)<br>Production DB inspection |
| **R5-VERIFICATION** | Full Test Suite & VPS Health | Execute all test suites across Node.js and Python; verify live systemd service (PID 491101), 5/5 Docker VPNs, and zero host IP leak. | • 321 Node.js tests PASS (0 fail)<br>• 183 Python tests PASS (0 fail)<br>• 7 reproducer tests PASS (0 fail)<br>• 5/5 VPNs healthy, 0 host leak | **TESTED_PASS** | **PENDING** | `npm test`<br>`unittest discover`<br>`p2_reproducer_test.py` |

### Governance & Signoff Status (Round 5)
- **Phase P1 Final Signoff**: **PENDING** (Reserved for user live testing)
- **Phase P2 Final Signoff**: **PENDING** (Reserved for user live testing)
- **Codex Review Status**: Strictly **PENDING** across all findings and Round 5 tasks.

---

## 3. Comprehensive Master Finding Registry (All 33 Findings)

| Finding ID | Severity | Phase | Finding Title / Description | Affected Module | Antigravity Status | Codex Status |
|---|:---:|:---:|---|---|:---:|:---:|
| **FINDING-001** | **P0** | **P1** | Python Transport Fallback on POST causing duplicate tweets | `Bot/python/direct_x_bridge.py` | **TESTED_PASS** | **PENDING** |
| **FINDING-002** | **P0** | **P1** | False 'verifiedNotPosted' due to 2s timeline window & 40-char prefix | `Bot/python/direct_x_bridge.py` | **TESTED_PASS** | **PENDING** |
| **FINDING-003** | **P0** | **P1** | Runner Ambiguous-to-Pending Loop causing replay storm | `Bot/src/runner.js` | **TESTED_PASS** | **PENDING** |
| **FINDING-004** | **P0** | **P2** | Telegram 409 Conflict Multi-Instance Polling | `Bot/src/telegram.js`, `systemd` | **TESTED_PASS** | **PENDING** |
| **FINDING-005** | **P0** | **P2** | Unconditional Lock Removal in systemd Defeating Singleton | `systemd/yj-telegram-bot.service` | **TESTED_PASS** | **PENDING** |
| **FINDING-006** | **P1** | **P3** | Single-Row JSON Write Amplification in SQLite | `Bot/src/sqliteStore.js` | **TESTED_PASS** | **PENDING** |
| **FINDING-007** | **P1** | **P2** | Bypassing Account Suspension Check via `use_cache` | `Bot/src/accounts.js` | **TESTED_PASS** | **PENDING** |
| **FINDING-008** | **P1** | **P2** | GraphQL KeyError due to Missing `urls` Field in Twikit | `Bot/python/direct_x_bridge.py` | **TESTED_PASS** | **PENDING** |
| **FINDING-009** | **P1** | **P1** | Late Callback Token Race Overwriting Newer Attempts | `Bot/src/runner.js` | **TESTED_PASS** | **PENDING** |
| **FINDING-010** | **P1** | **P2** | Naive Substring Matching Causing False Account Lock | `Bot/src/accounts.js` | **TESTED_PASS** | **PENDING** |
| **FINDING-011** | **P1** | **P1** | Lack of Upstream Idempotency Keys (Local Idempotency Protection) | `Bot/src/runner.js`, `Bot/src/queue.js` | **TESTED_PASS** | **PENDING** |
| **FINDING-012** | **P1** | **P2** | `curl_cffi` Missing from Requirements File | `Bot/requirements-direct-x.txt` | **TESTED_PASS** | **PENDING** |
| **FINDING-013** | **P1** | **P4** | Content Engine Main-Thread Blocking during Semantic Check | `dev/automation/contentEngine.js` | **TESTED_PASS** | **PENDING** |
| **FINDING-014** | **P2** | **P3** | Plaintext Cookies Storage | `Bot/data/cookies/` | **TESTED_PASS** | **PENDING** |
| **FINDING-015** | **P2** | **P2** | Server IP Leak via ipify (--noproxy '*') | `Bot/src/dockerVpn.js` | **TESTED_PASS** | **PENDING** |
| **FINDING-016** | **P2** | **P2** | Missing Strict Environment Variable Validation on Startup | `Bot/src/env.js` | **TESTED_PASS** | **PENDING** |
| **FINDING-017** | **P2** | **P3** | Destructive /accounts_csv Overwrite on Empty Upload | `Bot/src/runner.js`, `Bot/src/telegramUi.js` | **TESTED_PASS** | **PENDING** |
| **FINDING-018** | **P2** | **P2** | Telegram Polling Timeout Mismatch (Socket < Server) | `Bot/src/telegramApi.js` | **TESTED_PASS** | **PENDING** |
| **FINDING-019** | **P2** | **P4** | Quadruple Alert Storm on Single Ambiguous Event | `Bot/src/telegram.js`, `Bot/src/watchdog.js` | **TESTED_PASS** | **PENDING** |
| **FINDING-020** | **P2** | **P2** | Subprocess Stdio Buffer Overflow on Large Python Output | `Bot/src/directX.js` | **TESTED_PASS** | **PENDING** |
| **FINDING-021** | **P2** | **P2** | Orphaned Python Subprocesses on Parent SIGKILL | `Bot/src/directX.js` | **TESTED_PASS** | **PENDING** |
| **FINDING-022** | **P2** | **P3** | Missing Error Boundaries on Timers in scheduling.js | `Bot/src/scheduling.js` | **TESTED_PASS** | **PENDING** |
| **FINDING-023** | **P2** | **P3** | Dependency on Experimental `node:sqlite` Module | `Bot/package.json` | **TESTED_PASS** | **PENDING** |
| **FINDING-024** | **P2** | **P3** | Unchecked Revision Increment without Optimistic Concurrency | `Bot/src/sqliteStore.js` | **TESTED_PASS** | **PENDING** |
| **FINDING-025** | **P2** | **P3** | SQLite Transaction Held Across Async Yield | `Bot/src/sqliteStore.js` | **TESTED_PASS** | **PENDING** |
| **FINDING-026** | **P2** | **P1** | Ambiguous Queue Blocking (Stalled Items Halting Cycle) | `Bot/src/queue.js`, `Bot/src/runner.js` | **TESTED_PASS** | **PENDING** |
| **FINDING-027** | **P3** | **P4** | Duplicate Table Formatting Logic in 3 Separate Files | `Bot/src/tableUtils.js`, `Bot/src/accountTable.js` | **TESTED_PASS** | **PENDING** |
| **FINDING-028** | **P3** | **P4** | Silent I/O Failures in forensicLogger.js | `Bot/src/forensicLogger.js` | **TESTED_PASS** | **PENDING** |
| **FINDING-029** | **P3** | **P3** | Timezone Sensitivity in Quota Calculation | `Bot/src/quota.js` | **TESTED_PASS** | **PENDING** |
| **FINDING-030** | **P3** | **P4** | Missing Reconciliation between forensic.jsonl and SQLite | `Bot/src/forensicLogger.js` | **TESTED_PASS** | **PENDING** |
| **FINDING-031** | **P3** | **P2** | Unpinned Docker VPN Container Image Tag (:latest) | `Bot/docker/Dockerfile.vpn` | **TESTED_PASS** | **PENDING** |
| **FINDING-032** | **P2** | **P4** | Token Budget Truncation in Content Engine Output | `dev/automation/contentEngine.js` | **TESTED_PASS** | **PENDING** |
| **FINDING-033** | **P2** | **P4** | Missing Punctuation and Sentence Boundary Validation | `dev/automation/contentEngine.js` | **TESTED_PASS** | **PENDING** |

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
