# YJAutoPostOnX — M13: Project Session Cap & Device Guard Audit Report
**Date:** 2026-11-03  
**Auditor:** Hermes Agent  
**Enforcement Level:** STRICT ABSOLUTE CEILING (5 Sessions / 5 Containers / 5 Accounts)

---

## 1. The Three Independent Project Ceilings

To prevent account-wide device saturation or proxy collision on NordVPN and X, three independent limits are strictly governed and enforced:

| Dimension | Configured Ceiling | Current Host State | Verification Mechanism | Status |
| :--- | :---: | :---: | :--- | :---: |
| **1. Concurrent DirectX / X Sessions** | **5 Max** | **0 Active** | Atomic reservation via `sessionGuard.js` | **PASS** |
| **2. Docker VPN Containers** | **5 Max** | **5 Exactly** (`vpn_1..5`) | Host-wide 7-container cap (`nordvpn-device-limit-guard`) | **PASS** |
| **3. Active Enabled Accounts** | **5 Max** | **2 Enabled** (`crytpokingxvo8`, `emiehg`) | `AccountManager.maxActiveAccounts = 5` | **PASS** |

---

## 2. Docker VPN Container Inventory

```bash
docker ps -a --filter "name=yj_autopost_vpn" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
```

| Container Name | Slot | Mapped SOCKS Port | Dedicated State Volume | Status | Exit IP |
| :--- | :---: | :---: | :--- | :--- | :--- |
| `yj_autopost_vpn_1` | 0 | `127.0.0.1:18801` | `yj_autopost_vpn_1_state` | Up 18 hours (healthy) | `187.13.210.126` |
| `yj_autopost_vpn_2` | 1 | `127.0.0.1:18802` | `yj_autopost_vpn_2_state` | Up 21 hours (healthy) | `37.19.196.28` |
| `yj_autopost_vpn_3` | 2 | `127.0.0.1:18803` | `yj_autopost_vpn_3_state` | Up 21 hours (healthy) | `66.179.142.36` |
| `yj_autopost_vpn_4` | 3 | `127.0.0.1:18804` | `yj_autopost_vpn_4_state` | Up 21 hours (healthy) | `187.40.234.72` |
| `yj_autopost_vpn_5` | 4 | `127.0.0.1:18805` | `yj_autopost_vpn_5_state` | Up 21 hours (healthy) | `66.179.142.23` |

**Verification Result:** Exactly 5 VPN containers exist. Zero extraneous containers created. Persistent state volumes mounted cleanly preserving NordVPN device IDs.

---

## 3. Session Cap Runtime Guard (`src/sessionGuard.js`)

In Round 12 (M13), a dedicated fail-closed concurrency guard was introduced into `DirectXAdapter.open()`:
1. **Atomic Check-and-Reserve**: Before spawning any Python DirectX bridge process, `acquireSession({ accountId })` evaluates `countActiveSessions()`.
2. **Strict 6th-Session Rejection**: If 5 sessions are active, it throws `MAX_PROJECT_SESSIONS_EXCEEDED` immediately.
3. **Automatic Teardown Binding**: The lease is bound to child process exit, `close()`, and has a safety TTL (120 seconds) to prevent leaked reservations if an unhandled crash occurs.
4. **Offline Test Suite**: Validated in `Bot/test/m13_session_guard_ceiling.test.js` (3/3 PASS).

---

## 4. Pre / Post Test Host Audit

- **Connections on Ports 18801–18805:**
  - Before test run: 0 connections
  - During test run: Bounded within isolated temporary adapters
  - After test run: 0 connections (verified via `ss -tnp | grep -E "1880[1-5]"`)
- **Direct X / Python / Browser Orphan Processes:**
  - Zero orphan python processes found (`ps aux | grep -iE "direct_x|twikit"` -> 0 results).
- **RAM / Swap Stability:**
  - Total Memory: 7.9 GB (2.5 GB available).
  - Swap: 10.2 GB (7.5 GB free).
