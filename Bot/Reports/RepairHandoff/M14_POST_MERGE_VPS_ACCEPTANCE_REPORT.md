# YJAutoPostOnX — M14 Post-Merge VPS Deployment & Non-Posting Acceptance Report

**Date:** 2026-11-04  
**Deployed Base Commit:** `21c44df33b8118f91b48e38753fa1006a50c328c` (Merge PR #27 into `main`)  
**Deployment Mechanism:** Fast-forward `main` to `origin/main` + controlled systemd restart of `yj-telegram-bot.service`  
**Operational Status:** OPERATIONAL (NON-POSTING MODE) | `cycleState: stopped` | 0 LIVE POSTS  
**Independent Approvals:** Codex Review `PENDING` | Owner Signoff `PENDING`  

---

## 1. Executive Summary & Verification Matrix

| Area | Verified Invariant | Observation / Evidence | Acceptance Status |
| :--- | :--- | :--- | :---: |
| **Git Provenance** | `origin/main` at PR #27 merge commit | HEAD is `21c44df33b8118f91b48e38753fa1006a50c328c`; clean working tree. | **PASS** ✓ |
| **Service Status** | `yj-telegram-bot.service` active | Main PID `2581192`, active (running), memory 248MB, tasks 12. | **PASS** ✓ |
| **Publishing Lock** | Zero publishing or automated cycles | `cycleState: stopped` strictly preserved; 0 live X POST requests. | **PASS** ✓ |
| **Account Safety** | Restricted accounts disabled | `@kaniabq`, `@marcosvhv`, `@menalobq` have `enabled: false`, `status: 'محظور'`. | **PASS** ✓ |
| **Quarantine Pool** | 30 ambiguous items quarantined | All 30 items preserved in `state: 'ambiguous'` with `requeueApproved: false`. | **PASS** ✓ |
| **Item 53d0 Safety** | No production quota settlement | Item `53d0` preserved without `--apply`; historical counters untouched. | **PASS** ✓ |
| **Session Ceiling** | Maximum 5 simultaneous sessions | Active leases in `session_leases.sqlite` = 0; host ceiling enforced. | **PASS** ✓ |
| **Docker VPN Isolation** | 5 project slots; host cap <= 7 | Slots 0 & 1 active (`healthy`); slots 2-4 idle with persistent volumes intact; 0 extra containers. | **PASS** ✓ |
| **Offline Test Harness** | 100% offline test suite pass | 207/207 Python PASS (0.8s); 69/69 targeted M14 tests PASS (1.2s); 453/453 Node tests PASS. | **PASS** ✓ |
| **Rollback Preparedness** | Standalone pre-deploy backup | Stored at `/root/.backup_yj_autopost_m14_postmerge_20261104` with SHA-256 validation. | **PASS** ✓ |

---

## 2. Production Environment Invariants (Before vs. After Deployment)

```
========================================================================================
METRIC / RESOURCE              BEFORE RESTART (PR Head)         AFTER RESTART (Merged Main)
========================================================================================
Branch / Revision              fix/m14... (dc03fc2)             main (21c44df)
Service Active Status          active (PID 3701591)             active (PID 2581192)
cycleState                     stopped                          stopped
Active X Sessions              0                                0
Active Accounts                2 enabled, 3 disabled            2 enabled, 3 disabled
@kaniabq                       enabled: false, status: محظور     enabled: false, status: محظور
@marcosvhv                     enabled: false, status: محظور     enabled: false, status: محظور
@menalobq                      enabled: false, status: محظور     enabled: false, status: محظور
Published Items                155                              155
Ambiguous Items (Quarantined)  30                               30
Item 53d0 Status               ambiguous                        ambiguous
Active Session Leases          0                                0
NordVPN Host Containers Cap    7 total (4 project, 3 external)  7 total (4 project, 3 external)
state.sqlite Integrity         ok                               ok
state.sqlite Size              8,376,320 bytes                  8,376,320 bytes
========================================================================================
```

---

## 3. Automated Test Verification Summary

1. **Python Test Suite (`.venv-direct-x`):**
   - Command: `.venv-direct-x/bin/python3 -m unittest discover -s python -p "test_*.py"`
   - Result: **207 / 207 tests passed (100% PASS)** in `0.807 seconds`.
   - Coverage: `test_m14_captcha_and_session_unverified.py`, `test_bridge_hardening.py`, `test_tweet_rejection_classification.py`.
2. **Targeted M14 Concurrency & CAPTCHA Suites:**
   - Command: `node --test test/m14_round5_direct_code_fixes.test.js ...` (22 suites, 69 tests).
   - Result: **69 / 69 tests passed (100% PASS)** in `1.212 seconds`.
   - Coverage:
     - 5 OS-process SQLite mutex nonoverlap.
     - Per-incident CAPTCHA notification deduplication & dual-admin retry.
     - Background-detected challenge state preservation across unverified probes.
     - Outbox 2-phase commit and crash recovery.
     - Session lease 5-session hard ceiling and orphan process reaping.
3. **Full Project Node Suite (`npm test`):**
   - 151 test suites, 453 tests executed cleanly in isolated environments.

---

## 4. Rollback Readiness & Safety Fencing

- **Backup Location:** `/root/.backup_yj_autopost_m14_postmerge_20261104` (read-only, permissions `0700`).
- **Backed-Up Artifacts:**
  - `state.sqlite.bak` (SQLite `.backup` API, integrity verified `ok`).
  - `session_leases.sqlite.bak`.
  - `state.sqlite.raw`, `state.sqlite-wal.raw`, `state.sqlite-shm.raw`.
  - `yj-telegram-bot.service` unit definition.
  - `git_pre_deploy_head.txt` (recording pre-merge SHA).
- **Rollback Procedure (If Ever Needed):**
  1. `systemctl stop yj-telegram-bot.service`
  2. `git -C /root/Projects/YJAutoPostOnX checkout <pre_deploy_head>`
  3. `cp /root/.backup_yj_autopost_m14_postmerge_20261104/state.sqlite.bak /root/Projects/YJAutoPostOnX/Bot/data/state.sqlite`
  4. `systemctl start yj-telegram-bot.service`

---

## 5. Explicit Non-Posting Statement & Next Owner Decisions

**What Was Verified:**
- Successful post-merge deployment of PR #27 to production service.
- Full offline test suite execution and verification.
- Safe startup of `yj-telegram-bot.service` without auto-starting publisher or scheduler.
- Strict maintenance of all account restrictions, quarantine pools, and session ceilings.

**What Was NOT Performed (Strictly Prohibited):**
- ZERO live X POST publishing requests were executed.
- ZERO production quota mutations or `--apply` runs for item `53d0`.
- ZERO automated CAPTCHA solving or challenge bypasses.

**Decisions Reserved for the Owner:**
1. **Approval of Documentation PR:** Review and merge the post-merge acceptance documentation PR into `main`.
2. **Account Investigation:** Human resolution of challenges for `@kaniabq`, `@marcosvhv`, and `@menalobq` via the official X app/website, followed by bounded read-only verification via the Telegram bot panel.
3. **Quarantined Items Settlement:** Authorizing production settlement (`--apply`) for item `53d0` and review of the remaining 29 ambiguous posts.
4. **Publishing Resumption:** Explicit decision on when to transition `cycleState` from `stopped` to `running`.
