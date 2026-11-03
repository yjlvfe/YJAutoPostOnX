# YJAutoPostOnX — M14 / PR #27: Review Round 3 Evidence & Audit Report

**Date:** 2026-11-03  
**PR:** [GitHub PR #27: fix(m14): human-only captcha gate, interprocess session guard, and outbox durability](https://github.com/yjlvfe/YJAutoPostOnX/pull/27)  
**Branch:** `fix/m14-human-captcha-real-session-guard-and-recovery`  
**Review Reference:** GitHub PR #27 Review Comment ID `6610820542`  
**Status:** ALL ROUND 3 REVIEW BLOCKERS RESOLVED / TESTS 100% PASS / PRODUCTION GATED  

---

## 1. Finding-to-Fix Matrix (Round 3)

| Finding ID | Classification | Affected File & Lines | Root Cause | Implemented Resolution | Verification Test |
| :--- | :---: | :--- | :--- | :--- | :--- |
| **P0-1** | CAPTCHA Action Deadlock | `Bot/src/telegramUi.js`<br>Lines 17–22, 1485–1487, 1576–1578 | `recordAccountCheck` stored `status: 'كابتشا (مطلوب حل يدوي)'` but CAS rejected every status except exactly `'كابتشا'` (`a.status !== 'كابتشا'`), causing verification to deadlock. | Implemented canonical predicate `isCaptchaStatus(status)` covering both `'كابتشا'` and `'كابتشا (مطلوب حل يدوي)'`. Updated CAS to accept both canonical forms while maintaining strict incident ID, cookie, generation, and user matching. Leaves account disabled (`غير مفعل`) and publishing stopped. | `m14_round3_review_fixes.test.js`<br>(Tests 1, 2) |
| **P0-2** | Notification Marked Prematurely | `Bot/src/telegramUi.js`<br>Lines 1778–1840 | `sendIsolationAlert` persisted `lastNotifiedCaptchaIncidentId` in SQLite and memory Set *before* `await this.notify(message)`. Runner uses `allSettled()` so resolved promise does not prove delivery. | Added `inFlightAlerts` mutex. Dispatched notification and inspected actual delivery receipt (`allSettled` fulfilled with `ok === true` or `message_id`). Only persist `lastNotifiedCaptchaIncidentId` to SQLite store after proven API delivery. Suppresses concurrent calls for same incident. | `m14_round3_review_fixes.test.js`<br>(Tests 3, 4) |
| **P1-3** | Lock Stealing & Writers | `Bot/src/forensicLogger.js`<br>Lines 320–378<br>`Bot/scripts/settle_item_53d0f458.js`<br>Lines 39–50 | `_withLogLock` unlinked locks older than 30s without verifying holder process is dead. `finally` deleted replacement locks. Custom flusher bypassed logger lock. | 1. Atomically written ownership payload (`pid`, `token`, `acquiredAt`).<br>2. Reclaim orphaned lock ONLY if `isPidAlive(holderPid)` returns false (`ESRCH`). Never steal from live holder.<br>3. In `finally`, verify token before unlinking.<br>4. Reused `ForensicLogger.prototype.flushOutbox` directly in `settle_item_53d0f458.js`. | `m14_round3_review_fixes.test.js`<br>(Tests 5, 6, 7) |
| **P1-4** | Historical Quota Baseline | `Bot/scripts/settle_item_53d0f458.js`<br>Lines 150–175 | Fallback `baselineCount = currentHistoricalQuota` permitted arbitrary counts (e.g. 8->9 or 11->12) for the fixed Nov-1 target. | Strictly restricted one-off settlement to proven baseline: only 9 -> 10, or verified already-credited 10 (NOOP). Rejects any other quota (e.g. 8, 11) or contradictory count with `QUOTA_RECONCILIATION_AMBIGUOUS`. | `m14_round3_review_fixes.test.js`<br>(Tests 8, 9, 10, 11) |
| **P1-5** | Project-Wide Session Visibility | Read-Only Host & Docker Audit | Prove that all YJAutoPostOnX Node and Python processes share one host lease DB and full PID visibility across namespaces. | Verified via `docker top` and host inspection: Docker containers `yj_autopost_vpn_1..5` are pure network proxies (running only `nordvpnd`, `norduserd`, `microsocks`). All Twikit/DirectX workers run directly on the host using `Bot/.venv-direct-x/bin/python`. The host lease DB `data/session_leases.sqlite` and `/proc` inspect 100% of workers with zero blind spots. | Host & Docker inspect audit; 6th acquire test |

---

## 2. Test Execution & Coverage Summary

### Full Automated Test Suite Passes (100%)
- **Python Unit Tests:** **207 / 207 tests PASS** in 0.805s (`.venv-direct-x`).
- **Node.js Test Suites:** **445 / 445 tests PASS** across 146 test suites in 61.4s (`npm test`).
- **Total Passing Tests:** **652 / 652 tests (100% pass, 0 failures, 0 skipped)**.

### Focused M14 Test Suites (68 Tests Across 18 Suites)
1. `Bot/test/m14_round3_review_fixes.test.js`: **11 / 11 PASS** (P0-1, P0-2, P1-3, P1-4).
2. `Bot/test/m14_round2_review_fixes.test.js`: **8 / 8 PASS** (Historical quota, outbox durability, CAS preemption).
3. `Bot/test/m14_session_guard_adversarial.test.js`: **5 / 5 PASS** (Two racing OS Node processes with atomic SQLite transactions and Atomics.wait jitter).
4. `Bot/test/m14_captcha_e2e_verification.test.js`: **7 / 7 PASS** (Rate limiting, read-only verifyAccount, non-auto-enabling).
5. `Bot/test/m14_session_guard_hardening.test.js`: **6 / 6 PASS** (Capacity ceilings, symlink rejection, PID reuse defense).
6. `Bot/test/m14_outbox_drain_and_quota.test.js`: **4 / 4 PASS** (Crash survival, startup flush, quota idempotency).
7. `Bot/test/m14_captcha_gate_and_outbox.test.js`: **7 / 7 PASS** (Dual-write atomic outbox, hash verification).
8. `Bot/test/m13_session_guard_ceiling.test.js`: **3 / 3 PASS** (Lease accounting and release).
9. `Bot/test/m12_sqlite_production_safety_guard.test.js`: **10 / 10 PASS** (Production DB protection).
10. `Bot/test/m11_round10_forensic_integrity.test.js`: **7 / 7 PASS** (Quarantine preservation).

---

## 3. Production & Host State Audit

- **Production Database (`state.sqlite`):**
  - Path: `/root/Projects/YJAutoPostOnX/Bot/data/state.sqlite`
  - Size: 8,376,320 bytes (exact baseline preserved).
  - Integrity: `PRAGMA integrity_check;` -> `ok`.
  - Zero mutations performed on production database during tests.
- **Ambiguous Quarantine:**
  - Exactly 30 ambiguous items remain quarantined with `requeueApproved: false`.
  - Item `53d0f458-3144-4e89-a1af-202a8893afc6` remains safely quarantined; production settlement requires explicit owner approval (`BLOCKED_PENDING_OWNER_APPROVAL`).
- **NordVPN Containers:**
  - Exactly 5 project containers (`yj_autopost_vpn_1..5`) running healthy on ports 18801–18805.
  - Zero new or 6th containers spawned.
  - Host projects (`MyWalletChecker`, `BinanceChecker`, `YJDownloadVideo`) untouched.
- **Publishing & Accounts Status:**
  - Publishing cycle: `stopped`.
  - Live X POSTs: **0**.
  - Three restricted accounts (`@kaniabq`, `@marcosvhv`, `@menalobq`): `enabled: false`.
- **Session Accounting Proof:**
  - Active DirectX sessions: 0.
  - Leases in registry: 0.
