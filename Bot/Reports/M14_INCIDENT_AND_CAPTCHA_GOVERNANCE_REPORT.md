# YJAutoPostOnX — M14: Account Incident, CAPTCHA Gate & Human Verification Governance Report
**Date:** 2026-11-03  
**Status:** CONTAINED / PUBLISHING STOPPED / `LIVE_E2E_PENDING` / `OWNER_ACTION_REQUIRED`  
**Classification:** READ-ONLY FORENSIC ANALYSIS & HUMAN-VERIFICATION GOVERNANCE

---

## 1. Executive Incident Ledger & Factual Demarcation

An empirical distinction between **confirmed facts** (backed by digital traces) and **unproven hypotheses** for the three accounts (`@kaniabq`, `@marcosvhv`, `@menalobq`):

| Investigation Field | Confirmed Empirical Facts | Unproven Hypotheses / Requires Owner |
| :--- | :--- | :--- |
| **Morning Operations (04:12Z–04:32Z / 07:12–07:32 Riyadh)** | All 30 tweets (10 per account) published successfully; verified on live X URLs; quota was fully consumed. | None. Naming and delivery confirmed. |
| **Afternoon Check (12:58Z / 15:58 Riyadh)** | Twikit `user_state()` returned `authenticated: false`, `username: null`. Codes 64 (suspended) and 326 (locked) were **NOT** emitted. VPN containers and exit IPs were verified healthy. | Exact reason (whether session cookie expired or X web challenge was triggered) is unproven without raw X browser headers. |
| **UI "محظور" Display** | Was a UI state persistence artifact in `telegramUi.js` because `authenticated: false` prevented state refresh, leaving the old label. | The accounts are NOT confirmed permanently suspended by X. |
| **Current Operational Status** | Accounts are disabled (`enabled: false`) with status `OWNER_MANUAL_CHECK_REQUIRED`. Publishing cycle is **STOPPED** (`cycle.state: "stopped"`). Zero POST requests submitted. | Whether the accounts can resume requires the owner inspecting X via the official web/app interface. |

---

## 2. The Fail-Closed Human-Verification Gate

To prevent automated bots from aggravating account health or attempting evasion against X security systems:

1. **Explicit Detection & Durable Persistence:**
   - Explicit CAPTCHA / Arkose challenges (codes 326, 353, 399, 241, bounce locations, verification challenges) are recognized in `direct_x_compat.py` and `direct_x_bridge.py`.
   - Accounts immediately enter `status: 'كابتشا'` with durable metadata `needsOwnerCaptcha: true`, `captchaDetectedAt: timestamp`, `captchaCode: 326`.
   - Dispatch is disabled immediately (`enabled = false`).
2. **Strict Notification Contract:**
   - The owner is alerted via Telegram admin controls **exactly ONCE per incident**.
   - Alert contains the account handle, exact timestamp, and mandatory instruction:  
     `"حل التحقق من X بنفسك عبر الموقع/التطبيق الرسمي ثم اضغط تم الحل"`.
3. **No Automatic Solving or Evasion:**
   - Zero automated CAPTCHA solving.
   - Zero automated cookie regeneration or bypass attempts.
   - Zero VPN rotation or IP hopping on CAPTCHA/ban (preventing evasion flags).
   - In-flight posts during challenge are quarantined as `ambiguous` with `requeueApproved: false`.
4. **"تم الحل" Verification Flow:**
   - Owner clicking `تم الحل (فحص الاعتماد)` is **NOT** accepted as proof alone.
   - Triggers an explicitly owner-initiated, rate-limited (minimum 30 seconds interval) read-only verification.
   - Checks authentication, username, userId, and asserts that `challenge`, `locked`, `captcha`, and `suspended` are all false.
   - If verified, transitions to `status: 'غير مفعل'` (ready to be enabled).
   - **Remains disabled** until the owner explicitly clicks toggle to enable it.
   - Live publishing remains stopped until separate owner authorization.

---

## 3. Ambiguous Items Quarantine Integrity

- **Total Ambiguous Items:** Exactly 30 items.
- **Quarantine Status:** 100% retained in quarantine (`requeueApproved: false`).
- **Item `53d0f458-3144-4e89-a1af-202a8893afc6`:**
  - Full text SHA-256 verified: `6175d09d7a46563c051342f26ec9559a88689ccc3644eee690fdc95fc116133b`.
  - Proven published via Snowflake correlation (`2026-11-01T19:50:59.577Z`).
  - Settle script prepared with atomic CAS, outbox pattern, and duplicate quota prevention.
  - Production execution strictly gated: `BLOCKED_PENDING_OWNER_APPROVAL`.
- **Remaining 29 Items:** Each requires independent evidence review; zero bulk recovery; zero auto-replay.
