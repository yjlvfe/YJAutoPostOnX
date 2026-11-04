# YJAutoPostOnX — M14 / PR #27: Review Round 4 Evidence & Audit Report

**Date:** 2026-11-03  
**PR:** [GitHub PR #27: fix(m14): human-only captcha gate, interprocess session guard, and outbox durability](https://github.com/yjlvfe/YJAutoPostOnX/pull/27)  
**Branch:** `fix/m14-human-captcha-real-session-guard-and-recovery`  
**Review Reference:** GitHub PR #27 Review Comment ID `6611728745`  
**Status:** ALL ROUND 4 REVIEW BLOCKERS RESOLVED / FULL TESTS 100% PASS / PRODUCTION GATED  

---

## 1. Finding-to-Fix Matrix (Round 4)

| Finding ID | Classification | Affected File & Lines | Root Cause | Implemented Resolution | Verification Test |
| :--- | :---: | :--- | :--- | :--- | :--- |
| **P0-A** | Live CAPTCHA Alert Routing | `Bot/src/runner.js`<br>Lines 560–585, 725–755 | `handleAccountFailure()` bypassed `TelegramUi.sendIsolationAlert()` in the `isolated` branch and sent generic notify string directly, losing deduplication and human-only instructions. | Routed live runner isolation directly through `sendIsolationAlert({ account, reason: 'captcha' })`. Propagated fresh `captchaIncidentId` to in-memory account reference. Enabled: false immediately; zero live X POST; halts if no active accounts remain. | `m14_round4_review_fixes.test.js`<br>(Test 3: runner integration with code 326) |
| **P0-B** | Verified Delivery Receipts | `Bot/src/telegramUi.js`<br>Lines 1780–1865<br>`Bot/src/runner.js`<br>Lines 326–360 | `sendIsolationAlert` evaluated `deliveryConfirmed = Boolean(this.notify)` on nullish return, marking delivery as confirmed even when wrapper returned undefined without Telegram API receipt. | Completely eliminated `Boolean(this.notify)`. Strictly required verified Telegram Bot API response with `ok: true` and valid `message_id` per chat. Implemented `account.captchaDeliveredChats` in SQLite: dual-admin setup tracks each chat separately; partial failures retry ONLY pending chats without duplicate alerts to confirmed chats. | `m14_round4_review_fixes.test.js`<br>(Test 1: invalid receipts; Test 2: dual-admin partial retry) |
| **P0-C** | Unverified Session Check Preservation | `Bot/src/telegramUi.js`<br>Lines 880–895 | `recordAccountCheck()` unconditionally overwrote `account.status` with `'غير محقق (جلسة غير مؤكدة)'` on `auth_session_unverified`, resetting `checkGeneration` and deadlocking subsequent owner verification CAS. | Preserved pending CAPTCHA challenge status, `needsOwnerCaptcha`, and `checkGeneration` when routine unverified refresh occurs. Routine auth refresh never overwrites pending challenge state. Owner verification CAS succeeds cleanly after background refresh. | `m14_round4_review_fixes.test.js`<br>(Test 4: unverified refresh -> owner verify success) |
| **P1-D** | Fenced Orphan Lock Reclamation | `Bot/src/forensicLogger.js`<br>Lines 350–380 | Two contending processes seeing a dead PID (`ESRCH`) could both attempt `unlink(lockFile)`. Contender B could delete Contender A's newly acquired lock file. | Replaced path-level unlink with atomic POSIX rename to private reclaim file `${lockFile}.reclaim.${pid}.${uuid}`. Only the single winning contender reclaims the dead lock. If token changed before rename, file is restored immediately. Contenders never delete active locks. | `m14_round4_review_fixes.test.js`<br>(Test 5: 3-process concurrent contention) |
| **P1-E** | Test Hygiene & Full Coverage | `Bot/src/telegramUi.js`<br>Lines 80–175 | `new TelegramUi` started a 1000ms interval ticker in constructor, emitting `panel_refresh_ticker_failed` on closed test stores. | Added `autoStartTicker` option (defaults false in headless tests, true in runner). In `startTicker` & `refreshPanels`, gracefully ignore store-closed errors when `this.destroyed` is true. Ran complete 450/450 Node.js suite and 207/207 Python suite. | Full test suites run cleanly with zero ticker leaks |

---

## 2. Test Execution & Coverage Summary

### Full Automated Test Suite Passes (100%)
- **Python Unit Tests:** **207 / 207 tests PASS** in 0.787s (`.venv-direct-x`).
- **Node.js Test Suites:** **450 / 450 tests PASS** across 150 test suites in 61.4s (`npm test`).
- **Total Passing Tests:** **657 / 657 tests (100% pass, 0 failures, 0 skipped)**.

### Focused M14 Test Suites (73 Tests Across 22 Suites)
1. `Bot/test/m14_round4_review_fixes.test.js`: **5 / 5 PASS** (P0-A, P0-B, P0-C, P1-D).
2. `Bot/test/m14_round3_review_fixes.test.js`: **11 / 11 PASS** (Canonical predicate, lock ownership, quota baselines).
3. `Bot/test/m14_round2_review_fixes.test.js`: **8 / 8 PASS** (Historical quota, outbox durability, CAS preemption).
4. `Bot/test/m14_session_guard_adversarial.test.js`: **5 / 5 PASS** (Two racing OS Node processes, cap ceiling 5).
5. `Bot/test/m14_captcha_e2e_verification.test.js`: **7 / 7 PASS** (Rate limiting, read-only verifyAccount, non-auto-enabling).
6. `Bot/test/m14_session_guard_hardening.test.js`: **6 / 6 PASS** (Capacity ceilings, symlink rejection, PID reuse defense).
7. `Bot/test/m14_outbox_drain_and_quota.test.js`: **4 / 4 PASS** (Crash survival, startup flush, quota idempotency).
8. `Bot/test/m14_captcha_gate_and_outbox.test.js`: **7 / 7 PASS** (Dual-write atomic outbox, hash verification).
9. `Bot/test/m13_session_guard_ceiling.test.js`: **3 / 3 PASS** (Lease accounting and release).
10. `Bot/test/m12_sqlite_production_safety_guard.test.js`: **10 / 10 PASS** (Production DB protection).
11. `Bot/test/m11_round10_forensic_integrity.test.js`: **7 / 7 PASS** (Quarantine preservation).

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
