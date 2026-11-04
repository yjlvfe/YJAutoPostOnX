# YJAutoPostOnX — M14: PR #27 Mandatory Review Fixes Audit Report
**Date:** 2026-11-03  
**Status:** CONTAINED / REVIEW-READY (PR #27 UPDATED) / `LIVE_E2E_PENDING` / `OWNER_ACTION_REQUIRED`  
**Classification:** MANDATORY REVIEW BLOCKER RESOLUTION & SAFETY AUDIT

---

## 1. Executive Summary & Review Scope

Following independent code review of Pull Request **#27**, all identified critical blockers across CAPTCHA handling, project-wide session limits, and outbox/quota durability have been fully resolved directly on the PR #27 branch (`fix/m14-human-captcha-real-session-guard-and-recovery`).

All 33 baseline findings and 20 ADD tasks (53 total items) from the original P1–P6 plan remain strictly preserved with all Codex and owner approvals held as **PENDING**. Live publishing remains **STOPPED** with zero live POST requests to X.

---

## 2. Detailed Technical Resolutions

### Fix P0 — Human-Only CAPTCHA State Machine & Real Verification
1. **Real `DirectXAdapter.prototype.verifyAccount` Implementation**:
   - Replaced phantom method call with a fully implemented, read-only identity verification method in `Bot/src/directX.js`.
   - Validates SOCKS proxy configuration, acquires isolated DirectX session, checks `authenticated === true`, verifies exact `username` and numeric `userId` matches, and asserts that `challenge`, `locked`, `captcha`, `suspended`, `banned`, and `accountFailure` are all completely clear.
   - Bounded by timeout; guarantees session closure and lease release even on network errors or exceptions.
   - Eliminated any fallback to cached `account.authenticated` in `TelegramUi.prototype.accountManage('verify_captcha')`.
2. **Durable Challenge Field Preservation in `accountRecord`**:
   - Updated `accountRecord()` in `Bot/src/accounts.js` to explicitly preserve all challenge and verification metadata:
     - `needsOwnerCaptcha` (boolean)
     - `captchaDetectedAt` (timestamp)
     - `captchaCode` (integer)
     - `captchaReason` (sanitized string)
     - `captchaIncidentId` (UUID string)
     - `lastCaptchaVerifyAt` (timestamp)
     - `captchaResolvedAt` (timestamp)
     - `unverifiedReason` (sanitized string)
   - Guarantees that `AccountManager.update` and database reloads never drop active challenge states.
   - Enforces `enabled: false` whenever `needsOwnerCaptcha` is true or status is captcha.
3. **Protected Background Account Refresh**:
   - Modified `TelegramUi.prototype.recordAccountCheck` in `Bot/src/telegramUi.js` to ensure periodic background refreshes NEVER clear `needsOwnerCaptcha` or transition an account out of captcha status. Only explicit owner action via `accmanage:verify_captcha` can resolve challenges.
4. **Atomic Rate-Limiting CAS & Alert Deduplication**:
   - Implemented atomic Compare-And-Set (CAS) for `lastCaptchaVerifyAt` inside `store.update` in `telegramUi.js`, guaranteeing that rapid concurrent taps cannot bypass the 30-second rate-limiting window.
   - Implemented incident-level deduplication in `sendIsolationAlert`: alerts are dispatched exactly ONCE per incident using `account.captchaIncidentId`.
5. **Fail-Closed Verification Flow**:
   - If verification succeeds, account transitions to `status: 'غير مفعل'` with `enabled: false`. It is **NOT** automatically enabled and does not start the publishing cycle. The owner must explicitly click toggle to enable it.

### Fix P0 — True 5-Session Project-Wide Ceiling
1. **PID-Reuse Race Prevention**:
   - Enhanced `isPidAlive(pid, expectedPattern)` in `Bot/src/sessionGuard.js` to verify process identity via `/proc/[pid]/cmdline`, preventing recycled PIDs belonging to non-node or non-python processes from keeping stale leases alive.
2. **Fail-Closed Process Visibility**:
   - Updated `countUntrackedDirectXProcesses` to throw `PROCESS_VISIBILITY_UNVERIFIED` if `/proc` cannot be inspected, preventing silent under-counting in restricted environments.
3. **Strict Path & Symlink Safety in `resetSessionsForTest`**:
   - Restricted `resetSessionsForTest(customDbPath)` to strictly require verified test environments (`isTestEnvironment()`).
   - Forbids execution without `customDbPath` (`RESET_CUSTOM_PATH_REQUIRED`).
   - Forbids unlinking the production lease database (`PROD_PATH_RESET_FORBIDDEN`).
   - Enforces that `customDbPath` resides within an isolated temporary test directory (`TEMP_DIR_REQUIRED`).
   - Strictly refuses unlinking symbolic links (`SYMLINK_RESET_FORBIDDEN`), preventing symlink traversal attacks.

### Fix P1 — Outbox Automation & Historical Quota Baseline
1. **Automated Outbox Draining with Durable Fsync**:
   - Added `flushOutbox()` to `ForensicLogger` in `Bot/src/forensicLogger.js`, reading pending audit events from `state.pendingForensicOutbox`, deduplicating by UUID, writing to `forensic.jsonl` with durable `fileHandle.sync()`, and acknowledging/clearing events in SQLite.
   - Integrated `flushOutbox()` into `reconcile()` and bot service startup/lifecycle in `Bot/src/runner.js`, ensuring automatic recovery across process crashes and reboots.
2. **Verified Historical Quota Baseline Idempotency**:
   - Updated `settle_item_53d0f458.js` to make quota adjustment contingent on the verified historical baseline (`Math.max(existingPublishedCount + 1, 10)`).
   - If quota is already 10 (or has reached target), re-running the settlement is an idempotent no-op (`NOOP`) that never increments quota to 11, even if the `item.settledQuotaCredited` flag was lost during migration.
   - Production `--apply` remains strictly gated under `BLOCKED_PENDING_OWNER_APPROVAL`.

---

## 3. Comprehensive Verification Results

### Test Suite Execution
- **Python Tests:** **207 / 207 PASS** (100% in 0.853s).
- **Node.js Tests:** **426 / 426 PASS** across 136 test suites (100% in 61.4s).
- **New Dedicated M14 Test Suites (22 new tests, all passing):**
  - `Bot/test/m14_captcha_e2e_verification.test.js`: 7/7 PASS
  - `Bot/test/m14_session_guard_hardening.test.js`: 6/6 PASS
  - `Bot/test/m14_outbox_drain_and_quota.test.js`: 4/4 PASS
  - `Bot/test/m14_session_guard_adversarial.test.js`: 5/5 PASS
  - `Bot/test/m14_captcha_gate_and_outbox.test.js`: 7/7 PASS

### Production Host State
- `state.sqlite`: Size 8,376,320 bytes; `PRAGMA integrity_check` -> `ok`; 0 mutations.
- Ambiguous items: Exactly 30 quarantined (`requeueApproved: false`).
- Publishing cycle: `stopped`. Active DirectX sessions: 0.
- Docker VPN containers: Exactly 5 (`yj_autopost_vpn_1..5`), all healthy.
