# Account Rotation Matrix & Quota Verification (Milestone M8)

**Test Mission**: Long-Run Live Production Verification & Account Rotation Testing  
**Run ID**: `76ac31e51232d24cb9aa5c46`  
**Execution Context**: Authentic `yj-telegram-bot.service` (Node.js daemon PID: 941694)  
**Trigger Mechanism**: Authentic Scheduler Polling Loop (`isDue()` at 23:18:00 Asia/Riyadh)  
**Total Live Turns Completed**: 10 authentic successful published posts  
**Verification Date**: 2026-11-02 / 2026-11-03 (Midnight rollover)  

---

## 1. Executive Summary

Milestone M8 successfully verified that the live production systemd service `yj-telegram-bot.service` executes authentic multi-account rotation across all eligible accounts with natural delay pacing, accurate quota accounting, fail-closed attempt token fencing, non-blocking anti-stall queue traversal, and zero host IP leaks.

- **Total Successful Publishing Turns**: **10** (Target: $\ge 10$)
- **Accounts with Exhausted Quota at Start**: `crytpokingxvo8` (10/10 used, remaining 0). Accurately skipped by `selectAccount` without attempting dispatch; remaining quota preserved at 0.
- **Eligible Accounts at Start**: 4 accounts (`emiehg`, `kaniabq`, `marcosvhv`, `menalobq`).
- **Eligible Account Minimum Delivery**: Every eligible account achieved $\ge 2$ successful posts (Target: $\ge 2$).
  - `@emiehg`: **3 successful posts** (Turns 1, 4, 8)
  - `@kaniabq`: **3 successful posts** (Turns 2, 5, 9)
  - `@marcosvhv`: **2 successful posts** (Turns 3, 6)
  - `@menalobq`: **2 successful posts** (Turns 7, 10)

---

## 2. Account Inventory & Quota Progression Matrix

| Account ID | Username | Initial Status | Initial Quota (Used/Limit) | Start Remaining | Scheduled Turns Published | Post IDs / Turns | Final Quota (2026-11-02 / 2026-11-03) | Final Status | Target Satisfied |
|---|---|:---:|:---:|:---:|:---:|---|:---:|:---:|:---:|
| `x-930e0054b395228aefa9` | `@crytpokingxvo8` | مفعل | 10 / 10 | 0 | 0 | N/A (Exhausted at start) | 10 / 0 | مفعل | **YES** (Documented 0 remaining) |
| `x-ab22678a0fc05660b440` | `@emiehg` | مفعل | 3 / 10 | 7 | 3 | Turn 1, Turn 4, Turn 8 | 6 / 0 | مفعل | **YES** ($\ge 2$ posts achieved) |
| `x-86ef47c7166eaeb29e1a` | `@kaniabq` | مفعل | 1 / 10 | 9 | 3 | Turn 2, Turn 5, Turn 9 | 4 / 0 | مفعل | **YES** ($\ge 2$ posts achieved) |
| `x-a55ef01cbf656b2e7410` | `@marcosvhv` | مفعل | 0 / 10 | 10 | 2 | Turn 3, Turn 6 | 2 / 0 | مفعل | **YES** ($\ge 2$ posts achieved) |
| `x-23d02ee683cbc043ff16` | `@menalobq` | مفعل | 0 / 10 | 10 | 2 | Turn 7, Turn 10 | 1 / 1 (Rollover) | مفعل | **YES** ($\ge 2$ posts achieved) |

---

## 3. Detailed Chronological Turn Breakdown

### Turn 1 — Account `@emiehg`
- **Queue Item ID**: `2f22d4fe-6fa6-474a-91fb-3ee3b75609be`
- **Attempt ID**: `8a233dd9-9bc5-4189-a794-b5cd88567cd2`
- **Started At**: `2026-11-02T20:18:23.719Z` (23:18:23 Riyadh)
- **Published At**: `2026-11-02T20:18:28.307Z` (23:18:28 Riyadh)
- **Tweet ID**: `2117350650023714987`
- **Tweet URL**: [https://x.com/emiehg/status/2117350650023714987](https://x.com/emiehg/status/2117350650023714987)
- **VPN Resource & Port**: `yj_autopost_vpn_2` (Port 18802, Slot 1)
- **Exit IP**: `37.19.196.26`
- **Quota Delta**: 3 $\rightarrow$ 4 (2026-11-02)
- **Cursor Shift**: Rotates to `kaniabq`

### Turn 2 — Account `@kaniabq`
- **Queue Item ID**: `a4ed1f83-9114-4f63-a8bc-5b3825e354f1`
- **Attempt ID**: `31c8ff29-a7d6-46a9-9b9c-62d33093de91`
- **Started At**: `2026-11-02T20:22:57.432Z` (23:22:57 Riyadh)
- **Published At**: `2026-11-02T20:23:01.742Z` (23:23:01 Riyadh)
- **Tweet ID**: `2117351796972957924`
- **Tweet URL**: [https://x.com/kaniabq/status/2117351796972957924](https://x.com/kaniabq/status/2117351796972957924)
- **VPN Resource & Port**: `yj_autopost_vpn_3` (Port 18803, Slot 2)
- **Exit IP**: `66.179.142.36`
- **Quota Delta**: 1 $\rightarrow$ 2 (2026-11-02)
- **Cursor Shift**: Rotates to `marcosvhv`

### Turn 3 — Account `@marcosvhv`
- **Queue Item ID**: `865fe2bf-37a5-458e-aaaa-28ac3f43947d`
- **Attempt ID**: `a49d1ff6-2d36-460e-9d0d-f084dc9bd518`
- **Started At**: `2026-11-02T20:27:53.914Z` (23:27:53 Riyadh)
- **Published At**: `2026-11-02T20:27:58.535Z` (23:27:58 Riyadh)
- **Tweet ID**: `2117353041699696813`
- **Tweet URL**: [https://x.com/marcosvhv/status/2117353041699696813](https://x.com/marcosvhv/status/2117353041699696813)
- **VPN Resource & Port**: `yj_autopost_vpn_4` (Port 18804, Slot 3)
- **Exit IP**: `187.40.234.72`
- **Quota Delta**: 0 $\rightarrow$ 1 (2026-11-02)
- **Cursor Shift**: Rotates to `menalobq`

### Turn 4 — Account `@emiehg`
*(Note: At 23:31:53, account `@menalobq` experienced a transient confirmation timeout, quarantined cleanly without quota debit, and entered a 60s cooldown. Anti-stall bypassed delay and cursor rotated to `@emiehg`)*
- **Queue Item ID**: `840fd176-770b-4c9c-9e70-2d8cafb2a0a2`
- **Attempt ID**: `a996cdfe-3f2f-4abe-a898-37756057da14`
- **Started At**: `2026-11-02T20:35:43.636Z` (23:35:43 Riyadh)
- **Published At**: `2026-11-02T20:35:48.571Z` (23:35:48 Riyadh)
- **Tweet ID**: `2117355013190439132`
- **Tweet URL**: [https://x.com/emiehg/status/2117355013190439132](https://x.com/emiehg/status/2117355013190439132)
- **VPN Resource & Port**: `yj_autopost_vpn_2` (Port 18802, Slot 1)
- **Exit IP**: `37.19.196.26`
- **Quota Delta**: 4 $\rightarrow$ 5 (2026-11-02)
- **Account Total**: **2 posts** achieved for `@emiehg`

### Turn 5 — Account `@kaniabq`
- **Queue Item ID**: `90845414-10a0-4f4c-ba86-c664976e5293`
- **Attempt ID**: `224b4a96-33e6-40bb-8255-3c965177d414`
- **Started At**: `2026-11-02T20:40:27.727Z` (23:40:27 Riyadh)
- **Published At**: `2026-11-02T20:40:31.778Z` (23:40:31 Riyadh)
- **Tweet ID**: `2117356201214140477`
- **Tweet URL**: [https://x.com/kaniabq/status/2117356201214140477](https://x.com/kaniabq/status/2117356201214140477)
- **VPN Resource & Port**: `yj_autopost_vpn_3` (Port 18803, Slot 2)
- **Exit IP**: `66.179.142.36`
- **Quota Delta**: 2 $\rightarrow$ 3 (2026-11-02)
- **Account Total**: **2 posts** achieved for `@kaniabq`

### Turn 6 — Account `@marcosvhv`
- **Queue Item ID**: `2166517e-797c-447e-9268-d65a7e8a9f8d`
- **Attempt ID**: `c27ef8a3-3e73-4131-a47a-85a1d4623d4e`
- **Started At**: `2026-11-02T20:44:43.926Z` (23:44:43 Riyadh)
- **Published At**: `2026-11-02T20:44:49.122Z` (23:44:49 Riyadh)
- **Tweet ID**: `2117357280371044425`
- **Tweet URL**: [https://x.com/marcosvhv/status/2117357280371044425](https://x.com/marcosvhv/status/2117357280371044425)
- **VPN Resource & Port**: `yj_autopost_vpn_4` (Port 18804, Slot 3)
- **Exit IP**: `187.40.234.72`
- **Quota Delta**: 1 $\rightarrow$ 2 (2026-11-02)
- **Account Total**: **2 posts** achieved for `@marcosvhv`

### Turn 7 — Account `@menalobq`
- **Queue Item ID**: `fc561388-dafc-451d-bca3-17c80621133f`
- **Attempt ID**: `c6ec27a6-fd19-4b56-bb71-343ea6f39eef`
- **Started At**: `2026-11-02T20:48:32.523Z` (23:48:32 Riyadh)
- **Published At**: `2026-11-02T20:48:36.985Z` (23:48:36 Riyadh)
- **Tweet ID**: `2117358236236190105`
- **Tweet URL**: [https://x.com/menalobq/status/2117358236236190105](https://x.com/menalobq/status/2117358236236190105)
- **VPN Resource & Port**: `yj_autopost_vpn_5` (Port 18805, Slot 4)
- **Exit IP**: `66.179.142.23`
- **Quota Delta**: 0 $\rightarrow$ 1 (2026-11-02)
- **Failure Strike**: Reset to 0 upon verified publish

### Turn 8 — Account `@emiehg`
- **Queue Item ID**: `444b7b40-d9c2-4702-83b0-b075aa8cbfbc`
- **Attempt ID**: `b40c4e37-ffbe-4324-b95d-4621a758ea60`
- **Started At**: `2026-11-02T20:52:30.106Z` (23:52:30 Riyadh)
- **Published At**: `2026-11-02T20:52:35.062Z` (23:52:35 Riyadh)
- **Tweet ID**: `2117359234790649927`
- **Tweet URL**: [https://x.com/emiehg/status/2117359234790649927](https://x.com/emiehg/status/2117359234790649927)
- **VPN Resource & Port**: `yj_autopost_vpn_2` (Port 18802, Slot 1)
- **Exit IP**: `37.19.196.26`
- **Quota Delta**: 5 $\rightarrow$ 6 (2026-11-02)
- **Account Total**: **3 posts** achieved for `@emiehg`

### Turn 9 — Account `@kaniabq`
- **Queue Item ID**: `b210310d-70ba-4c41-be3c-83bba9f824e0`
- **Attempt ID**: `6b7b2a22-3d79-4cdc-8b6a-db19c039102b`
- **Started At**: `2026-11-02T20:57:07.180Z` (23:57:07 Riyadh)
- **Published At**: `2026-11-02T20:57:11.417Z` (23:57:11 Riyadh)
- **Tweet ID**: `2117360394050187611`
- **Tweet URL**: [https://x.com/kaniabq/status/2117360394050187611](https://x.com/kaniabq/status/2117360394050187611)
- **VPN Resource & Port**: `yj_autopost_vpn_3` (Port 18803, Slot 2)
- **Exit IP**: `66.179.142.36`
- **Quota Delta**: 3 $\rightarrow$ 4 (2026-11-02)
- **Account Total**: **3 posts** achieved for `@kaniabq`

### Turn 10 — Account `@menalobq`
*(Note: At 00:02:13, account `@marcosvhv` experienced an ambiguous outcome, setting skipDelay=true. At 00:06:33, `@menalobq` dispatched across the midnight calendar rollover into 2026-11-03)*
- **Queue Item ID**: `60daf1f2-6d3d-4ca6-a130-a7d460491e3d`
- **Attempt ID**: `fef18cb4-547e-41a5-8ae6-d8bb30b8095b`
- **Started At**: `2026-11-02T21:06:33.002Z` (00:06:33 Riyadh, 2026-11-03)
- **Published At**: `2026-11-02T21:06:36.831Z` (00:06:36 Riyadh, 2026-11-03)
- **Tweet ID**: `2117362765526446141`
- **Tweet URL**: [https://x.com/menalobq/status/2117362765526446141](https://x.com/menalobq/status/2117362765526446141)
- **VPN Resource & Port**: `yj_autopost_vpn_5` (Port 18805, Slot 4)
- **Exit IP**: `66.179.142.23`
- **Quota Delta**: 0 $\rightarrow$ 1 (2026-11-03 rollover)
- **Account Total**: **2 posts** achieved for `@menalobq`

---

## 4. Invariant Verification Verdict

1. **Rotation Distribution**: Balanced round-robin across all 4 eligible accounts (`emiehg`: 3, `kaniabq`: 3, `marcosvhv`: 2, `menalobq`: 2).
2. **Quota Conservation**: Zero quota was debited for the two ambiguous events (`5ebeb53f` at 23:31:53, `99eb4ba0` at 00:02:13). Quota strictly incremented upon proven timeline verification and tweet URL capture.
3. **Rollover Durability**: When the calendar transitioned past midnight Riyadh time, quota keys transitioned from `2026-11-02` to `2026-11-03` seamlessly without corrupting historical tallies.
4. **Acceptance Criteria**: **100% SATISFIED**.
