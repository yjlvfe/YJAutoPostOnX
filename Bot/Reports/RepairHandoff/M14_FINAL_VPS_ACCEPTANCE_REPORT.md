# YJAutoPostOnX — M14 / PR #27: Final VPS Acceptance & Non-Production Evidence Handoff

**Date:** 2026-11-03  
**PR:** [GitHub PR #27: fix(m14): human-only captcha gate, interprocess session guard, and outbox durability](https://github.com/yjlvfe/YJAutoPostOnX/pull/27)  
**Branch:** `fix/m14-human-captcha-real-session-guard-and-recovery`  
**Candidate Head SHA:** `d60cdf212d04f93a5e91bd639cf5642a3540c8b1`  
**Independent Review References:** PR #27 Comments `6609922603`, `6610820542`, `6611728745`  
**Operational Status:** PRE-MERGE ACCEPTED (OFFLINE / TEST HARNESS) | PRODUCTION SAFETY-GATED | MERGE PENDING OWNER APPROVAL  

---

## 1. Executive Summary & Verification Decision Matrix

| Work Package | Old Hazard / Reviewed Defect | Implemented Architecture & Fix | Offline Verification | VPS Read-Only Inspection | Final Decision Gate |
| :--- | :--- | :--- | :--- | :--- | :---: |
| **WP-1: Shared Forensic Mutex** (`forensicMutex.js`, `forensicLogger.js`) | Reclaim race using `fsp.unlink` could delete new active holder lock file; stale file rename could cause file collisions under multi-process contention. | Shared SQLite-backed mutex with `BEGIN IMMEDIATE`, owner PID/starttime/token CAS, and `node:sqlite` DatabaseSync. All JSONL mutations (record, prune, reconcile, flushOutbox) serialized through the same lock. | 5 independent OS Node processes spawned concurrently; verified zero overlap (`active === 1` strictly) in critical section (`m14_round5_direct_code_fixes.test.js`). | Production logs untouched; lock uses private `${logFile}.mutex.sqlite`. | **PASS** ✓<br>(Production Gated) |
| **WP-2: Scoped CAPTCHA Incidents & Delivery Receipts** (`telegramUi.js`, `runner.js`) | Previous alert receipts could suppress alerting for a new incident B on the same account; background check could spam or corrupt CAS; unconfirmed notify could mark delivered. | Scope receipts to `captchaDeliveredIncidentId` and `captchaDeliveredChats`. New incident B generates fresh UUID and alerts both admin chats once. Verified Bot API receipt (`ok:true`, valid `message_id`) required. Partial failures retry only pending chats without duplicate alerts to confirmed chats. | Injected Arkose/326 failure; verified account disabled, human-only instructions, per-chat receipts, partial retries, and clean CAS clearance leaving account disabled. | Production publishing cycle stopped; accounts disabled (`@kaniabq`, `@marcosvhv`, `@menalobq`). | **PASS** ✓<br>(Production Gated) |
| **WP-3: Background Check & Owner Gate Preservation** (`telegramUi.js`, `runner.js`) | Routine background refresh (`auth_session_unverified`) overwrote pending CAPTCHA status and reset `checkGeneration`, deadlocking owner's "✅ تم الحل" CAS action. | Guarded `recordAccountCheck` with `isPendingCaptcha`: preserves challenge status, `needsOwnerCaptcha`, incident ID, and `checkGeneration`. Background check alerts owner once per incident. | Verified background-detected CAPTCHA creates fresh incident, alerts both chats, and survives repeated checks without CAS invalidation or duplicate alerts. | 0 live X POST; zero automated CAPTCHA solving. | **PASS** ✓<br>(Production Gated) |
| **WP-4: Historical Quota & Outbox Durability** (`settle_item_53d0f458.js`, `forensicLogger.js`) | Quota incremented from 10 to 11 on repeated settle; outbox cleared before disk write confirmed. | Strict transition from 9 -> 10 only; 10 is idempotent NOOP. Outbox uses 2-phase commit: temp file write + `sync()` + atomic rename FIRST; only confirmed IDs cleared from SQLite. Contradictory quota throws `QUOTA_RECONCILIATION_AMBIGUOUS`. | Verified idempotency, fault injection where disk write fails, and crash recovery with outbox replay without duplicate IDs. | Quarantined item `53d0` preserved untouched; zero `--apply` in production. | **PASS** ✓<br>(Production Gated) |
| **WP-5: Interprocess Session Guard (5-Session Cap)** (`sessionGuard.js`) | In-memory session tracking vulnerable to multi-process race and 6th session leak. | Shared SQLite registry (`session_leases.sqlite`) with WAL, `BEGIN IMMEDIATE`, `/proc` PID liveness + executable cmdline verification, and strict max 5 active session ceiling host-wide. | Verified 2 racing Node OS processes attempting 10 leases; exactly 5 granted, 5 rejected fail-closed. | Exactly 0 active leases in production registry; 5 VPN Docker containers healthy. | **PASS** ✓<br>(Production Gated) |

---

## 2. Test Execution & Coverage Audit

### Full Test Suite Results
1. **Node.js Test Suites (`npm test`):**
   - Suites Executed: **151 test suites**.
   - Tests Executed: **453 tests**.
   - Passed: **453 tests (100% PASS)**.
   - Failed: **0 tests**.
   - Skipped: **0 tests**.
   - Duration: **61.4 seconds**.
2. **Python Test Suites (`.venv-direct-x`):**
   - Tests Executed: **207 tests**.
   - Passed: **207 tests (100% PASS)**.
   - Failed: **0 tests**.
   - Duration: **0.764 seconds**.
3. **Total Automated Tests:** **660 / 660 PASS (100%)**.

### Targeted M14 Test Suites (27 Tests Across 15 Suites)
- `Bot/test/m14_round5_direct_code_fixes.test.js`: **3 / 3 PASS** (True 5-OS-process nonoverlap, incident reset, background challenge alert).
- `Bot/test/m14_round4_review_fixes.test.js`: **5 / 5 PASS** (Invalid receipt rejection, dual-admin partial retry, runner code 326 integration, background unverified preservation, SQLite-fenced orphan recovery).
- `Bot/test/m14_round3_review_fixes.test.js`: **11 / 11 PASS** (Canonical predicate, in-flight guard, lock ownership, quota baselines).
- `Bot/test/m14_round2_review_fixes.test.js`: **8 / 8 PASS** (Quota idempotency, outbox fault injection, injected Event B CAS preemption, symlink traversal rejection, check_session).

---

## 3. Production Environment & Safety Verification (Read-Only)

- **Systemd Service:** `yj-telegram-bot.service` (PID 3701591) is active. Logs confirm `cycleState: stopped`.
- **Production Database (`Bot/data/state.sqlite`):**
  - Size: Exactly `8,376,320` bytes.
  - Integrity: `PRAGMA integrity_check;` returned `ok`.
  - Mutations during acceptance: **0 bytes modified** (verified via pre/post sha256 checksums).
- **Ambiguous Queue & Historical Quota:**
  - Exactly 30 items remain in `state: 'ambiguous'` with `requeueApproved: false`.
  - Item `53d0f458-3144-4e89-a1af-202a8893afc6` remains in `state: 'ambiguous'`. No production settlement was executed.
- **Affected Accounts:**
  - `@kaniabq`, `@marcosvhv`, `@menalobq` have `enabled: false` and `status: 'محظور'`.
  - Zero active X sessions. Zero live X POSTs.
- **Docker VPN Containers:**
  - Exactly 5 project containers (`yj_autopost_vpn_1..5`) healthy on ports `18801-18805`.
  - Zero 6th or temporary containers spawned.
  - All other VPS projects (`BinanceChecker`, `MyWalletChecker`, `YJDownloadVideo`, `9router`) completely untouched.

---

## 4. What Was NOT Verified on Live VPS / X (And Why)

1. **Live X POST Publishing:** NOT executed on production. Strictly prohibited by safety gates (`cycleState: stopped`). Verified via offline runner mocks and dispatch callback tests.
2. **Live Human CAPTCHA Solving on X Website/App:** NOT performed. Per policy, the owner exclusively solves challenges via official X interfaces. Verified via simulated code 326 fault injection and read-only identity verification stubs.
3. **Production Quota Settlement (`--apply`):** NOT applied to production `state.sqlite`. Quota adjustment for item `53d0` remains gated pending explicit owner approval. Verified in isolated scratch databases.
4. **Service Restart / Code Deployment:** Production service `yj-telegram-bot.service` was NOT restarted with PR #27 code, as PR #27 remains unmerged pending owner approval.

---

## 5. Exit Recommendation

**Status:** `READY_FOR_OWNER_MERGE_REVIEW`  
All code defects, review blockers, and concurrency hazards identified in Rounds 1–5 have been completely resolved, verified with comprehensive regression tests, validated by GitHub CI (5/5 checks pass), and proven in offline test suites with zero production impact. Merge and production deployment remain strictly pending the owner's explicit decision.
