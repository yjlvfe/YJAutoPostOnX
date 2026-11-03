# YJAutoPostOnX — M14: Interprocess Session Guard & 5-Session Cap Audit
**Date:** 2026-11-03  
**Auditor:** Hermes Agent  
**Standard:** Interprocess Atomic Concurrency & Strict Project-Wide Ceiling

---

## 1. Executive Summary
In Round 12 (M13), the session guard was implemented as an in-memory `Map`, which did not enforce a true project-wide limit across multiple OS Node processes, and purged leases after 120s regardless of process liveness.

In Milestone M14, `Bot/src/sessionGuard.js` was completely re-architected into an **interprocess, crash-safe, fail-closed SQLite transactional lease registry** (`session_leases.sqlite`) with WAL mode, `BEGIN IMMEDIATE` synchronization, process liveness verification via `ESRCH`, heartbeat fencing, and host-level untracked process discovery.

---

## 2. Key Architecture Invariants

| Capability | Previous Implementation | M14 Enterprise Guard |
| :--- | :--- | :--- |
| **Storage Boundary** | Process-local JavaScript `Map` | Interprocess SQLite with WAL & `BEGIN IMMEDIATE` |
| **Cross-Process Protection** | None (2 processes could open 10 sessions) | Strict project-wide cap <= 5 across all Node & Python processes |
| **Lease Reclaim Logic** | Blind TTL purge after 120s | Confirmed process death via `process.kill(pid, 0)` -> `ESRCH` |
| **Long-Lived Children** | Silently dropped while child lived | Preserved indefinitely while owning process or child is alive |
| **Untracked DirectX Detection** | Ignored | Proactively scans `/proc` for untracked `direct_x_bridge.py` |
| **Duplicate Lease Prevention** | Allowed | Enforced via unique constraint on `session_key` |

---

## 3. Empirical Test Results

Validated in `Bot/test/m14_session_guard_adversarial.test.js` (5/5 PASS):
1. **Racing Node Processes:** Two independent OS Node processes spawned concurrently, each attempting to allocate 4 leases. Exactly 5 leases were granted across both processes; 3 attempts were rejected with `MAX_PROJECT_SESSIONS_EXCEEDED`. Total sessions never exceeded 5.
2. **Liveness Preservation:** An active lease aged 200s (> 120s) was verified; because its owning process was alive, the lease was retained cleanly (`countActiveSessions() === 1`).
3. **Crash & Orphan Recovery:** Dead PIDs (simulating killed workers via `SIGKILL`) were reconciled to 0 via `ESRCH` checks upon the next check, freeing slots without manual intervention.
4. **Duplicate Protection:** Reattempting to acquire a lease with the same `sessionKey` was rejected fail-closed with `DUPLICATE_SESSION_LEASE`.
5. **Fail-Closed on Saturation:** The 6th session attempt from any process fails closed before executing child processes or opening network connections.
