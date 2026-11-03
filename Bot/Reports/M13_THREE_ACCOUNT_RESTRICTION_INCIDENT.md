# YJAutoPostOnX — M13: Three Account Restriction Incident Forensic Report
**Date:** 2026-11-03  
**Status:** CONTAINED / PUBLISHING HALTED (LIVE_E2E_PENDING)  
**Target Accounts:** `@kaniabq`, `@marcosvhv`, `@menalobq`  
**Classification:** READ-ONLY FORENSIC INVESTIGATION — NO EVASION / NO SPOOFING

---

## 1. Executive Incident Summary
On 2026-11-03, the system owner reported that three X accounts appeared restricted or disabled in the Telegram management interface (`kaniabq`, `marcosvhv`, `menalobq`).
In accordance with strict operational directives, immediate containment was confirmed:
- The automated publishing cycle is strictly **STOPPED** (`cycle.state: "stopped"`).
- **Zero new POST requests** have been or will be submitted to X for testing or publishing.
- The 3 accounts have `enabled: false` and are completely quarantined from dispatch.
- The 2 healthy accounts (`@crytpokingxvo8`, `@emiehg`) remain untouched and idle.

---

## 2. Per-Account Forensic Ledger

| Field | Account 1: `@kaniabq` | Account 2: `@marcosvhv` | Account 3: `@menalobq` |
| :--- | :--- | :--- | :--- |
| **Internal ID** | `x-86ef47c7166eaeb29e1a` | `x-a55ef01cbf656b2e7410` | `x-23d02ee683cbc043ff16` |
| **Numeric User ID** | `2116977848040792064` | `2116982313443581953` | `2116986514341027840` |
| **Assigned SOCKS Port** | `18803` (Container `vpn_3`) | `18804` (Container `vpn_4`) | `18805` (Container `vpn_5`) |
| **Last Verified Exit IP** | `66.179.142.36` | `187.40.234.72` | `66.179.142.23` |
| **VPN Container Health** | Healthy (Up 21 hours) | Healthy (Up 21 hours) | Healthy (Up 21 hours) |
| **Last Successful Tweet** | `2117473703865028772` | `2117474938474946750` | `2117473295519949127` |
| **Last Successful Time (UTC)** | `2026-11-03T04:27:26.753Z` | `2026-11-03T04:32:21.170Z` | `2026-11-03T04:25:49.374Z` |
| **Last Successful Time (Riyadh)** | `2026-11-03 07:27:26 +03` | `2026-11-03 07:32:21 +03` | `2026-11-03 07:25:49 +03` |
| **Today's Published Posts** | 10 / 10 (Quota reached) | 10 / 10 (Quota reached) | 10 / 10 (Quota reached) |
| **Observed Status at 12:58Z** | `authenticated: false` | `authenticated: false` | `authenticated: false` |
| **Suspension Code (64)** | False (Not received) | False (Not received) | False (Not received) |
| **Challenge Code (326)** | False (Not received) | False (Not received) | False (Not received) |
| **Current DB Status** | `status: 'محظور'`, `enabled: false` | `status: 'محظور'`, `enabled: false` | `status: 'محظور'`, `enabled: false` |
| **Failures Strikes Count** | 0 (No 3-strike trigger) | 0 (No 3-strike trigger) | 0 (No 3-strike trigger) |

---

## 3. Root Cause Analysis & Evidence Synthesis

### Finding A: Morning Publishing Was 100% Successful
All three accounts actively published their full daily batch of 10 posts between 04:12Z and 04:32Z (07:12 - 07:32 Riyadh time) without receiving suspension or lock codes from X. Every one of the 30 published tweets exists on X.

### Finding B: Session Check Observation at 12:58Z (15:58 Riyadh)
When the Telegram Bot UI refreshed the accounts panel at `2026-11-03T12:58:48Z - 12:58:50Z`:
1. The SOCKS5 VPN routes were verified healthy (`healthy: true`, public exit IPs returned).
2. The Direct X bridge invoked `user_state()` via Twikit.
3. The responses returned `authenticated: false`, `username: null`, with:
   - `challenge: false`
   - `locked: false`
   - `captcha: false`
   - `suspended: false`
   - `banned: false`
4. **Neither code 64 (suspension) nor code 326 (Arkose challenge) was emitted by X**.
5. The session check failed due to **cookie/session invalidation (`auth_session_unverified`)**, likely caused by session expiration after the morning batch or X web session invalidation.

### Finding C: UI Labeling Artifact (`محظور`)
In `src/telegramUi.js:861`:
```javascript
if (refresh && session && healthy && ip && result.authenticated === true && !failure) {
  account.status = account.enabled === false ? 'غير مفعل' : 'مفعل';
}
```
When an account fails authentication (`result.authenticated === false`), the UI refresh **does not clear** the pre-existing `account.status`. Because the accounts had `status: 'محظور'` stored in `state.accounts` from prior manual or test operations, they appeared as "محظور" in the panel, and the activation handler refused to re-enable them with `"هذا الحساب محظور، لا يمكن تفعيله."`.

---

## 4. Immediate Containment & Preventive Actions
1. **Zero New POST Operations**: The engine remains in `cycleState: "stopped"`.
2. **No Automatic Account Re-enabling**: The 3 accounts remain `enabled: false` until new, authentic cookie credentials are provided and verified.
3. **5-Session Strict Ceiling Enforced**: Implemented `src/sessionGuard.js` guaranteeing that at most 5 concurrent DirectX sessions can ever exist across the entire project.
4. **Legitimate Appeal & Cookie Renewal Procedure**:
   - The owner should inspect the accounts in a standard browser.
   - If X prompted for a phone/email verification or password reset, complete it legitimately through official X flows.
   - Export fresh cookies and import them via the bot's `/start` -> `الإعدادات` -> `الحسابات` flow.
