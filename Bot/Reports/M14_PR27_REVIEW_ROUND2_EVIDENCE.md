# YJAutoPostOnX — M14 / PR #27: Review Round 2 Evidence & Audit Report

**Date:** 2026-11-03  
**PR:** [GitHub PR #27: fix(m14): human-only captcha gate, interprocess session guard, and outbox durability](https://github.com/yjlvfe/YJAutoPostOnX/pull/27)  
**Branch:** `fix/m14-human-captcha-real-session-guard-and-recovery`  
**Baseline Commit:** `0bee4e2ae12575ddce78e6bc98f6f042f6e58434`  
**Review Reference:** GitHub PR #27 Comment ID `6609922603`  
**Status:** ALL ROUND 2 REVIEW BLOCKERS RESOLVED / TESTS 100% PASS / PRODUCTION GATED  

---

## 1. Finding-to-Fix Matrix

| Finding ID | Classification | Affected File & Lines | Root Cause | Implemented Resolution | Verification Test |
| :--- | :---: | :--- | :--- | :--- | :--- |
| **P0-A** | Quota Regression | `Bot/scripts/settle_item_53d0f458.js`<br>Lines 190–235 | Formula `Math.max(existingPublishedCount + 1, currentHistoricalQuota > 0 ? currentHistoricalQuota + 1 : 1)` incremented 10 -> 11 on re-runs where flag was missing on ambiguous item. | Re-anchored to proven baseline (`existingPublishedCount` on Nov 1). Enforced that if `currentHistoricalQuota >= 10`, it is already credited and strictly NOOP (never 11). If `currentHistoricalQuota < existingPublishedCount`, fails closed with `QUOTA_RECONCILIATION_AMBIGUOUS`. | `m14_round2_review_fixes.test.js`<br>(Tests 1, 2, 3) |
| **P0-B** | Outbox Premature Clear | `Bot/src/forensicLogger.js`<br>Lines 316–450, 452–495 | `reconcile()` cleared `pendingForensicOutbox = []` in SQLite BEFORE writing and renaming JSONL file on disk. No shared file mutex between `reconcile` and `flushOutbox`. | 1. Implemented `_withLogLock` advisory lockfile to serialize log operations.<br>2. Phase 1 writes to JSONL via temp file, executes `fileHandle.sync()`, and atomic rename.<br>3. Phase 2 transactionally clears ONLY confirmed persisted IDs in SQLite.<br>4. On file failure, outbox is preserved. | `m14_round2_review_fixes.test.js`<br>(Tests 4, 5) |
| **P0-C** | Stale CAPTCHA CAS Race | `Bot/src/telegramUi.js`<br>Lines 1508–1600 | Verification captured account state before slow network call, but on return cleared `needsOwnerCaptcha` without checking if a newer incident B occurred or if credentials/generation changed. | Captured baseline security snapshot (`captchaIncidentId`, `checkGeneration`, `cookieFile`, `userId`, `username`). Inside post-verification `store.update`, enforced strict CAS: if ANY identifier or challenge changed, aborted with `staleOrPreempted: true`, left disabled and notified owner. | `m14_round2_review_fixes.test.js`<br>(Test 6) |
| **P1-D** | Session Ceiling & Reset Safety | `Bot/src/sessionGuard.js`<br>Lines 44–88, 385–440 | 1. Silently swallowed non-ENOENT `/proc` errors in `countUntrackedDirectXProcesses`.<br>2. `isPidAlive` assumed dead on unreadable cmdline.<br>3. `resetSessionsForTest` didn't check parent directory symlinks or enforce realpath in `os.tmpdir()`. | 1. Throws `PROCESS_VISIBILITY_UNVERIFIED` on any non-ENOENT `/proc` error.<br>2. `isPidAlive` fails closed (assumes alive) on permission barriers.<br>3. `resetSessionsForTest` inspects every parent directory component with `lstatSync`, rejecting symlinks (`SYMLINK_RESET_FORBIDDEN`), and verifies `realpath` is within `os.tmpdir()`. | `m14_round2_review_fixes.test.js`<br>(Test 7) |
| **P1-E** | Verification Wiring & Alerts | `Bot/src/telegramUi.js`<br>Lines 1620–1628, 1778–1805<br>`Bot/src/accounts.js`<br>Lines 61–65 | 1. `check_session` text implied live session verification.<br>2. `sendIsolationAlert` in-memory deduplication reset across service reboots. | 1. Labeled `check_session` explicitly as local configuration inspection without claiming network login.<br>2. Persisted `account.lastNotifiedCaptchaIncidentId` and `lastCaptchaAlertAt` to SQLite store for durable deduplication across reboots. | `m14_round2_review_fixes.test.js`<br>(Test 8) |

---

## 2. Test Execution & Coverage Summary

### Full Automated Test Suite Passes (100%)
- **Python Suites:** **207 / 207 tests PASS** in 0.745s (`.venv-direct-x`).
- **Node.js Suites:** **434 / 434 tests PASS** across 141 test suites in 61.3s (`npm test`).
- **Total Passing Tests:** **641 / 641 tests (100% pass, 0 failures, 0 skipped)**.

### Focused M14 Test Suites
1. `Bot/test/m14_round2_review_fixes.test.js`: **8 / 8 PASS** (P0-A, P0-B, P0-C, P1-D, P1-E).
2. `Bot/test/m14_session_guard_adversarial.test.js`: **5 / 5 PASS** (Two racing OS Node processes with atomic SQLite transactions and Atomics.wait jitter).
3. `Bot/test/m14_captcha_e2e_verification.test.js`: **7 / 7 PASS** (Rate limiting, read-only verifyAccount, non-auto-enabling).
4. `Bot/test/m14_session_guard_hardening.test.js`: **6 / 6 PASS** (Capacity ceilings, symlink rejection, PID reuse defense).
5. `Bot/test/m14_outbox_drain_and_quota.test.js`: **4 / 4 PASS** (Crash survival, startup flush, quota idempotency).
6. `Bot/test/m14_captcha_gate_and_outbox.test.js`: **7 / 7 PASS** (Dual-write atomic outbox, hash verification).
7. `Bot/test/m13_session_guard_ceiling.test.js`: **3 / 3 PASS** (Lease accounting and release).
8. `Bot/test/m12_sqlite_production_safety_guard.test.js`: **10 / 10 PASS** (Production DB protection).
9. `Bot/test/m11_round10_forensic_integrity.test.js`: **7 / 7 PASS** (Quarantine preservation).

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
