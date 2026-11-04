# YJAutoPostOnX — Single Living Consolidated Engineering & Forensic Reference (`Old reports.md`)

- **Canonical Repository Path:** `/root/Projects/YJAutoPostOnX` (Production Checkout)
- **Surgical Audit & Consolidation Worktree:** `/root/Projects/YJAutoPostOnX-surgical-audit` (`audit/surgical-20261104`)
- **Off-Repo Cryptographic Backup & Audit Vault:** `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/`
- **Authoritative Source-of-Truth Git SHAs:**
  - **Initial Audited Baseline (`main` post-PR #27):** `21c44df33b8118f91b48e38753fa1006a50c328c`
  - **PR #29 Merge Commit (`fix/m14-python-rate-limit-mock-isolation`, Head `c23a75062699c070b85d63f75fc3cc50f3702656`):** `08bc6a004672ebe80d0a28a32287d9c975f7197e`
  - **PR #28 Merge Commit / Current `main` (`docs/m14-post-merge-vps-acceptance`, Head `a5caa87f74e94b40f5479c22fe819fe3720fdd67`):** `f394756a7550fddb7f16c20b74118b99546c1cf4`
  - **Surgical Audit Worktree Pre-Consolidation Checkpoint:** `fdd8340` (merged with `main` `f394756a7550fddb7f16c20b74118b99546c1cf4`)
- **Runtime Model / Provider Audit Note:** Executed under multi-agent forensic governance combining **`Codex CLI TERRA via 9router`** (independent adversarial code/test/architecture audit lanes) and **`Hermes Main/Delegates`** (`D1`–`D4`, `W1` orchestration, static line-by-line inspection, isolated synthetic reproduction probes, and report consolidation).
- **Post-Phase 3 Directory Invariant:** This file (`Bot/Reports/Old reports.md`) is the **sole** file retained inside `Bot/Reports/` (`find Bot/Reports -mindepth 1` returns ONLY `Bot/Reports/Old reports.md`). All 117 superseded files in `Bot/Reports/*` (`72` Markdown reports, `24` non-Markdown JSON/JSONL/log/patch/txt files, `21` `.zip`/`.tar.gz` archives) and the repo-root duplicate files (`MASTER_TODO.md`, `PROGRESS_HISTORY.md`, `RESOURCE_CLEANUP_REPORT.md`, `ARCHIVES/LIVE_OPERATIONAL_VERIFICATION.zip`, `ARCHIVES/ROUND3_EVIDENCE.zip`) are cryptographically backed up in `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/` and consolidated herein.

---

## Table of Contents
1. [Section 1: Project Definition, Product Behavior, Source-of-Truth SHAs, Runtime Audit Note, Architectural Map & 69-File + 8-Flow Coverage Index](#section-1-project-definition-product-behavior-source-of-truth-shas-runtime-audit-note-architectural-map--69-file--8-flow-coverage-index)
2. [Section 2: Complete Historical Chronology (M1–M14, Rounds 1–14, PRs #1–#29) & Inventory of All 72 Markdown Reports, 24 Non-Markdown Files, and 21 Archives](#section-2-complete-historical-chronology-m1m14-rounds-114-prs-129--inventory-of-all-72-markdown-reports-24-non-markdown-files-and-21-archives)
3. [Section 3: Complete Original 53-Item Mapping (`33 FINDING-001..033` + `20 ADD-P1-01..ADD-P6-04`) & Legacy `P1`–`P6` References with Current Classifications](#section-3-complete-original-53-item-mapping-33-finding-001033--20-add-p1-01add-p6-04--legacy-p1p6-references-with-current-classifications)
4. [Section 4: Complete Phase 1 Root-Cause Register (All 59 Raw Findings) & 30 Quarantined Ambiguous Items Ledger (Including Fenced `53d0f458-3144-4e89-a1af-202a8893afc6`)](#section-4-complete-phase-1-root-cause-register-all-59-raw-findings--30-quarantined-ambiguous-items-ledger-including-fenced-53d0f458-3144-4e89-a1af-202a8893afc6)
5. [Section 5: Post-Audit Live Master TODO (`P01`–`P08` Engineering Phases & Tasks `P01-T01`..`P08-T01`) & Bidirectional Traceability Matrix](#section-5-post-audit-live-master-todo-p01p08-engineering-phases--tasks-p01-t01p08-t01--bidirectional-traceability-matrix)
6. [Section 6: Post-Audit Engineering Architecture & Implementation Design (Component Boundaries, State Machines, CAS Invariants, CAPTCHA Invariant, Hard Limits & `ADR-001..010`)](#section-6-post-audit-engineering-architecture--implementation-design-component-boundaries-state-machines-cas-invariants-captcha-invariant-hard-limits--adr-001010)
7. [Section 7: Fresh Test Matrix (`Bot/test/`), CI/Electron Repair Specification, Deletion & Retention Manifest Summary & Rollback Instructions](#section-7-fresh-test-matrix-bottest-cielectron-repair-specification-deletion--retention-manifest-summary--rollback-instructions)
8. [Section 8: Append-Only Work Log, Checkpoint/Resume Instructions, Latest Next Actions & Evidence-Delivery Receipts](#section-8-append-only-work-log-checkpointresume-instructions-latest-next-actions--evidence-delivery-receipts)


---

# Section 1: Project Definition, Product Behavior, Source-of-Truth SHAs, Runtime Audit Note, Architectural Map & 69-File + 8-Flow Coverage Index

## 1.1 Project Definition & Dual-Product Behavior

`YJAutoPostOnX` is a monorepo hosting two strictly decoupled software products that share zero runtime processes, zero code imports, and zero SQLite databases, communicating solely through user-mediated UTF-8 CSV file exports (`Text,Media[,Account]`):

1. **Product 1 — `Appimage/` (Standalone Electron + Playwright Desktop Studio, v5.21.0):**
   - **Purpose:** Desktop GUI application (`Appimage/dev/main.js`) for AI-assisted content generation (`contentEngine.js`), semantic deduplication (`semanticIndex.js`), referral code injection (`referralService.js`), browser-profile management (`browserManager.js`, `sessionManager.js`), and export of curated post batches to UTF-8 BOM CSV files.
   - **Storage:** Uses `better-sqlite3` storing local desktop state under `~/.config/x-poster-shared/workflow.sqlite` and `~/.config/x-poster-bot-profile/`.
   - **Audit Boundary:** Out of scope for `Bot/` runtime modifications except at the CSV export handoff contract and the shared GitHub Actions release verification workflows (`.github/workflows/verify-xposter.yml`, `.github/workflows/apply-remaining-repair.yml`, `Appimage/scripts/verify-release.sh`, and `Appimage/dev/main.js` headless Xvfb GPU/SIGTERM teardown).

2. **Product 2 — `Bot/` (Headless VPS Telegram Publishing Daemon, v0.1.0):**
   - **Purpose:** 24/7 systemd service (`yj-telegram-bot.service`) managed via an Arabic Telegram operator UI (`Bot/src/telegramUi.js`, `Bot/src/telegram.js`) restricted to authorized owner/admin user IDs and chat IDs (`528864559`, `5535435580`).
   - **Core Behavior:**
     - Ingests accounts (`accounts.csv` + per-account `0600` JSON/Netscape cookies in `Bot/data/cookies/`) and post queues (`posts.csv` with SHA-256 payload deduplication).
     - Enforces a hard ceiling of **5 active X accounts** (`MAX_ACTIVE_ACCOUNTS = 5`), **5 concurrent DirectX sessions host-wide** (`Bot/src/sessionGuard.js` backed by `Bot/data/session_leases.sqlite` + `/proc` inspection), and **5 dedicated NordVPN Docker SOCKS5h proxy slots** (`yj_autopost_vpn_1..5` on `127.0.0.1:18801..18805`, within the strict **7-container host-wide NordVPN ceiling** alongside `cryptovpn-nordvpn` on `1085` and `yjdownloadvideo-nordvpn-1` on `1080`).
     - Publishes queued items in round-robin rotation across eligible active accounts via a short-lived, isolated Python subprocess (`Bot/python/direct_x_bridge.py` + `Bot/python/direct_x_compat.py` running in `/root/Projects/YJAutoPostOnX/Bot/.venv-direct-x/bin/python` with `curl_cffi==0.17.0` and `twikit==2.3.3`) using a two-phase `dispatch_ready` $\to$ `onDispatch` (SQLite `phase: 'dispatching'`) $\to$ `dispatch_ack` handshake.
     - Enforces `Asia/Riyadh` (`UTC+03:00`) daily per-account publishing quotas (`10` posts/account/day default), quarantines any unconfirmed post-dispatch attempt into `state: 'ambiguous'` (never auto-requeued), isolates accounts on 3 transient failure strikes (`معزول (3 إخفاقات)`) or immediately on 1st-turn CAPTCHA (`326/353/399/241`, manual-only recovery via `accmanage:verify_captcha`) or suspension (`63/64/141`, `محظور`), and delivers deduplicated daily CSV link exports (`links_YYYY-MM-DD.csv`) to both operator chats upon cycle completion.

---

## 1.2 Source-of-Truth Git SHAs & Repository Drift Chronology

| Checkpoint / Reference | Commit SHA | Branch / PR | Timestamp & Verification Summary |
|---|---|---|---|
| **Initial Audited Baseline** | `21c44df33b8118f91b48e38753fa1006a50c328c` | `main` (Merge PR #27) | Baseline at start of surgical audit (`project-files.tar.zst` & `repository.bundle` captured at this commit). |
| **PR #29 Merge Commit** | `08bc6a004672ebe80d0a28a32287d9c975f7197e` | Merge PR #29 (`fix/m14-python-rate-limit-mock-isolation`, Head `c23a75062699c070b85d63f75fc3cc50f3702656`) | Merged `2026-11-04 15:24:43 +03`. Guarded `client_error` with `isinstance(..., BaseException)` and bounded `429` regex in `Bot/python/direct_x_bridge.py`. Note: PR #29 head CI run `41782092988` (`job/126416216292`) failed in `verify-release.sh` due to Xvfb `SIGTERM` GPU/zygote race (`exit 5`). |
| **PR #28 Merge Commit (Current `main`)** | `f394756a7550fddb7f16c20b74118b99546c1cf4` | Merge PR #28 (`docs/m14-post-merge-vps-acceptance`, Head `a5caa87f74e94b40f5479c22fe819fe3720fdd67`) | Merged `2026-11-04 15:25:24 +03`. Descends directly from `21c44df` (`git merge-base 21c44df f394756 == 21c44df`). Added 3 M14 post-merge/reconciliation Markdown reports, 2 JSON delivery manifests, and 2 evidence sender scripts (`tracked-source.tar.zst` captured at this commit). |
| **Surgical Audit Worktree** | `fdd8340` (merged with `f394756a7550fddb7f16c20b74118b99546c1cf4`) | `audit/surgical-20261104` | `/root/Projects/YJAutoPostOnX-surgical-audit` worktree containing current `main` (`f394756`) where Phase 3 report consolidation is staged. |

---

## 1.3 Runtime Model / Provider Audit Note

- **Audit Execution Architecture:**
  - **`Codex CLI TERRA via 9router`:** Used for independent adversarial code analysis, historical claim re-evaluation, and architectural critique.
  - **`Hermes Main/Delegates` (`GeminiFlash` / multi-delegate lanes `D1`–`D4`, `W1`):** Executed full 69-file static line-by-line source inspection, 8 cross-module execution flow traces, bounded offline synthetic reproduction probes (`cas-mechanism-probe.cjs`, `worktree-db-guard-probe.cjs`, `telegram-synthetic-race`, `csv-restrictions-synthetic`, `x-synthetic-timeline`, `x-synthetic-propagation`, and isolated Xvfb AppImage `SIGTERM` reproduction), cryptographic backup generation, and Phase 3 consolidation.
  - **Strict Read-Only Production Invariant:** Throughout Phase 0, Phase 1, Phase 2, and Phase 3, zero live X requests, zero live Telegram Bot API calls, zero Docker container mutations, zero systemd service restarts, and zero writes to `/root/Projects/YJAutoPostOnX/Bot/data/state.sqlite` or `session_leases.sqlite` were performed. Live `yj-telegram-bot.service` (`PID 2581192`, started `2026-11-04 06:32:25 +03`, `cycle.state = stopped`) remained completely undisturbed.

---

## 1.4 Current Architectural Map & Execution Flows

### 1.4.1 High-Level Runtime Topology (`f394756`)

```
+---------------------------------------------------------------------------------------------------+
|                                   Host VPS (Linux 6.8.0-147-generic)                              |
|                                                                                                   |
|  +---------------------------------------------------------------------------------------------+  |
|  | systemd: yj-telegram-bot.service (PID 2581192) -> Bot/src/index.js -> Bot/src/runner.js     |  |
|  |   - SingleInstanceLock: Bot/data/telegram-runner.lock (inline in runner.js + singleInstance)|  |
|  |   - Telegram Poller & UI: telegram.js / telegramApi.js / telegramUi.js / telegramFlows.js   |  |
|  |   - Durable State Store: SqliteStore (Bot/data/state.sqlite, WAL, single-row JSON id=1)     |  |
|  |   - Forensic Audit Log: ForensicLogger + ForensicMutex -> Bot/data/logs/forensic.jsonl      |  |
|  |   - Link Export Outbox: LinkExportManager -> Bot/data/exports/links_YYYY-MM-DD.csv          |  |
|  +-------------------+-----------------------------------------------------+-------------------+  |
|                      |                                                     |                      |
|                      | 1. Acquire Lease (max 5)                            | 2. Ensure Slot 1..5  |
|                      v                                                     v                      |
|  +-------------------------------------------+     +-------------------------------------------+  |
|  | SessionGuard (Bot/src/sessionGuard.js)    |     | VpnSlotManager (Bot/src/dockerVpn.js)     |  |
|  |  - Bot/data/session_leases.sqlite         |     |  - Slots: yj_autopost_vpn_1..5            |  |
|  |  - /proc/<pid>/cmdline scan               |     |  - Ports: 127.0.0.1:18801..18805          |  |
|  |  - Spawns: .venv-direct-x/bin/python -I   |     |  - Volumes: yj_autopost_vpn_N_state/_auth |  |
|  |    Bot/python/direct_x_bridge.py          |---->|  - SOCKS5h Egress -> X GraphQL Endpoints  |  |
|  +-------------------------------------------+     +-------------------------------------------+  |
|                                                                                                   |
|  Host-Wide NordVPN Cap (7 Containers Total):                                                      |
|   [1] cryptovpn-nordvpn (1085)  [2] yjdownloadvideo-nordvpn-1 (1080)  [3..7] yj_autopost_vpn_1..5 |
+---------------------------------------------------------------------------------------------------+
```

### 1.4.2 Current Execution Flows (As Implemented in `f394756` vs Discovered Seams)
1. **Startup & Crash Recovery (`index.js` $\to$ `runner.js` $\to$ `queue.js` $\to$ `forensicLogger.js`):**
   - Validates environment (`env.js`), acquires singleton lock, opens `state.sqlite`, runs `queue.recoverProcessing()` (reverting `processing/claimed` to `pending` and quarantining `processing/dispatching` to `ambiguous`), flushes `pendingForensicOutbox`, reconciles VPN slots (`VPN-RAW-02` seam), and restores UI panels/cycle state.
2. **Operator Command & Callback Dispatch (`telegram.js` $\to$ `auth.js` $\to$ `runner.js` / `telegramUi.js`):**
   - Polls `getUpdates` with dynamic socket timeout (`pollTimeoutMs + 15000`), enforces dual `allowedUserIds` + `allowedChatIds` allowlists, serializes per-chat/user callbacks, and routes commands (`TR-01` seam where `...ui.actions()` overwrites `/account_toggle` text command).
3. **Publishing Cycle & Two-Phase Dispatch Handshake (`runner.js` $\to$ `directX.js` $\to$ `direct_x_bridge.py`):**
   - Selects eligible active account with remaining `Asia/Riyadh` daily quota (`quota.js`), claims next pending item (`claimCycleItem` — `RUN-02` closure seam), verifies VPN slot health, acquires session lease (`sessionGuard.js`), opens Python bridge, checks identity (`PY-RAW-01` `use_cache` seam), emits `dispatch_ready`, runs `onDispatch` SQLite CAS update (`PERSIST-OBS-04` closure seam), sends `dispatch_ack`, executes `create_tweet` (`PY-RAW-02` fallback seam), runs `verify_timeline` on drop/missing ID (`XT-01` 30m window seam, `XT-02` dropped `accountFailure` seam), classifies outcome via `publishOutcome.js`, and commits token-fenced settlement (`published` +1 quota vs `ambiguous` 0 quota).

---

## 1.5 Full 69-File + 8-Flow Phase 1 Surgical Audit Coverage Index

# Phase 1 Surgical Audit Coverage Index (Complete)

- **Repository Worktree Audited:** `/root/Projects/YJAutoPostOnX-surgical-audit` (at commit `fdd8340`, merged with `main` `f394756a7550fddb7f16c20b74118b99546c1cf4`)
- **Audit Workspace:** `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/`
- **Completion Status:** All 69 Bot runtime/operational files (`35 Bot/src/*`, `3 Bot/python/*`, `21 Bot/scripts/*`, `7 Bot/docker/*`, `3 Bot/systemd/*`) and all 8 cross-module flows are `INSPECTED` line-by-line (100% static source coverage + bounded offline synthetic probes). Out-of-scope `Appimage/` desktop internals and live external X/Telegram/Docker mutation endpoints are explicitly documented under `NOT_INSPECTED` with exact governance and safety reasons.

---

## 1. Bot Runtime and Operational Files (69 / 69 `INSPECTED`)

| # | Path | Status | Lines | Bytes | SHA-256 Prefix | Inspected Spans & Evidence Pointers |
|---:|---|---|---:|---:|---|---|
| 1 | `Bot/src/accountRefresh.js` | `INSPECTED` | 122 | 5,730 | `4e5b354a21412ced` | Lines `1–122` (`audit-utilities-security.md`, `UTIL-RAW-04`) |
| 2 | `Bot/src/accountTable.js` | `INSPECTED` | 37 | 2,624 | `b97f0a9ada8b54d6` | Lines `1–37` (`audit-utilities-security.md`, `UTIL-RAW-02`, `findings-current-017-033.md` `FINDING-027`) |
| 3 | `Bot/src/accounts.js` | `INSPECTED` | 365 | 17,664 | `78560a6dfc97a3c6` | Lines `1–365` (`audit-accounts-entrypoints.md` `ACC-RAW-01..04`, `audit-csv-restrictions-review.md`, `audit-telegram-runtime.md`) |
| 4 | `Bot/src/ambiguousAudit.js` | `INSPECTED` | 46 | 1,989 | `fa0631fb9aa54135` | Lines `1–46` (`audit-persistence.md` `PERSIST-OBS-02`, `phase1-audit-completion-gate.md`) |
| 5 | `Bot/src/attemptOutcomes.js` | `INSPECTED` | 29 | 1,532 | `17c92c04cf78b130` | Lines `1–29` (`add-current-assessment.md` `ADD-P1-03`, `phase1-audit-completion-gate.md`) |
| 6 | `Bot/src/auth.js` | `INSPECTED` | 34 | 1,190 | `4d4ec0306115c3ee` | Lines `1–34` (`audit-telegram-runtime.md`, `audit-utilities-security.md`) |
| 7 | `Bot/src/cookieFormat.js` | `INSPECTED` | 57 | 2,935 | `4e9f387b06dd07c8` | Lines `1–57` (`audit-utilities-security.md`, `audit-accounts-entrypoints.md`) |
| 8 | `Bot/src/csv.js` | `INSPECTED` | 54 | 2,600 | `8c786f03a8b0bb3e` | Lines `1–54` (`audit-utilities-security.md`, `audit-csv-restrictions-review.md`) |
| 9 | `Bot/src/directX.js` | `INSPECTED` | 374 | 18,938 | `54811c18949df6fe` | Lines `1–374` (`audit-x-transport.md` `XT-02`, `audit-vpn-sessions.md`, `audit-recovery-flow.md`) |
| 10 | `Bot/src/dockerVpn.js` | `INSPECTED` | 462 | 21,545 | `5e7c9f4d94f6c5e6` | Lines `1–462` (`audit-vpn-sessions.md` `VPN-RAW-01..04`, `findings-current-001-016.md` `FINDING-015`, `findings-current-017-033.md` `FINDING-031`) |
| 11 | `Bot/src/env.js` | `INSPECTED` | 193 | 7,163 | `e9bdb71645298e2d` | Lines `1–193` (`audit-utilities-security.md`, `findings-current-001-016.md` `FINDING-016`) |
| 12 | `Bot/src/forensicLogger.js` | `INSPECTED` | 526 | 19,148 | `9504df1512ddf5a5` | Lines `1–526` (`audit-persistence.md` `PERSIST-OBS-01`, `PERSIST-OBS-03`, `audit-recovery-flow.md`, `findings-current-017-033.md` `FINDING-028`, `FINDING-030`) |
| 13 | `Bot/src/forensicMutex.js` | `INSPECTED` | 149 | 5,302 | `678ef9aa0de19a21` | Lines `1–149` (`audit-persistence.md`) |
| 14 | `Bot/src/index.js` | `INSPECTED` | 44 | 2,521 | `9f1c3b2c1d165fa1` | Lines `1–44` (`audit-telegram-runtime.md`, `audit-runner-full.md`, `audit-utilities-security.md`) |
| 15 | `Bot/src/knownTwikitParserFailure.js` | `INSPECTED` | 13 | 642 | `7195adc4986c8cd3` | Lines `1–13` (`audit-utilities-security.md`) |
| 16 | `Bot/src/linkExports.js` | `INSPECTED` | 397 | 20,859 | `f6ba8443c8e18256` | Lines `1–397` (`audit-utilities-security.md` `UTIL-RAW-03`, `audit-recovery-flow.md`, `add-current-assessment.md` `ADD-P2-03`) |
| 17 | `Bot/src/publicIp.js` | `INSPECTED` | 21 | 1,148 | `3ce367287a198076` | Lines `1–21` (`audit-utilities-security.md`) |
| 18 | `Bot/src/publishOutcome.js` | `INSPECTED` | 13 | 638 | `8f2d45ecccc3e1e3` | Lines `1–13` (`audit-x-transport.md`, `audit-python-bridge.md` `PY-RAW-04`, `findings-current-001-016.md` `FINDING-003`) |
| 19 | `Bot/src/queue.js` | `INSPECTED` | 126 | 6,407 | `668e52e29a5f5924` | Lines `1–126` (`audit-persistence.md` `PERSIST-OBS-02`, `audit-x-transport.md` `XT-04`, `audit-recovery-flow.md`) |
| 20 | `Bot/src/quota.js` | `INSPECTED` | 39 | 2,648 | `8588e8fb9e71933f` | Lines `1–39` (`audit-telegram-runtime.md`, `audit-recovery-flow.md`, `findings-current-017-033.md` `FINDING-029`) |
| 21 | `Bot/src/runner.js` | `INSPECTED` | 1,671 | 93,743 | `cdb52dcac1a5eaf3` | Lines `1–1671` (`audit-runner-full.md` `RUN-01..06`, `audit-cas-review.md` `PERSIST-OBS-04`, `audit-telegram-runtime.md` `TR-01..03`, `TR-07`, `audit-routing.md`) |
| 22 | `Bot/src/scheduling.js` | `INSPECTED` | 19 | 1,067 | `0027c931fd18b493` | Lines `1–19` (`audit-telegram-runtime.md` `TR-02`, `findings-current-017-033.md` `FINDING-022`) |
| 23 | `Bot/src/sessionGuard.js` | `INSPECTED` | 472 | 15,059 | `6f9055496ae4c907` | Lines `1–472` (`audit-vpn-sessions.md` `SESSION-RAW-01..03`) |
| 24 | `Bot/src/settings.js` | `INSPECTED` | 99 | 5,498 | `041f7cccc7bc8802` | Lines `1–99` (`audit-utilities-security.md`, `audit-telegram-runtime.md`) |
| 25 | `Bot/src/singleInstance.js` | `INSPECTED` | 266 | 9,390 | `1ff634de52172a77` | Lines `1–266` (`audit-accounts-entrypoints.md` `ENTRY-RAW-01`, `audit-telegram-runtime.md`, `audit-runner-full.md` `RUN-01`) |
| 26 | `Bot/src/sqliteStore.js` | `INSPECTED` | 280 | 11,135 | `5d051f592e0734cc` | Lines `1–280` (`audit-persistence.md` `PERSIST-OBS-04..05`, `audit-cas-review.md`, `findings-current-001-016.md` `FINDING-006`, `findings-current-017-033.md` `FINDING-023..025`) |
| 27 | `Bot/src/status.js` | `INSPECTED` | 57 | 2,442 | `bdf7d74c616e757c` | Lines `1–57` (`audit-utilities-security.md`) |
| 28 | `Bot/src/structuredLogger.js` | `INSPECTED` | 207 | 7,486 | `1490ca8c995288d0` | Lines `1–207` (`audit-utilities-security.md` `UTIL-RAW-01`) |
| 29 | `Bot/src/tableUtils.js` | `INSPECTED` | 29 | 1,093 | `407aebb8cfff24e4` | Lines `1–29` (`audit-utilities-security.md` `UTIL-RAW-02`, `findings-current-017-033.md` `FINDING-027`) |
| 30 | `Bot/src/telegram.js` | `INSPECTED` | 176 | 10,557 | `be24f91c3fe26939` | Lines `1–176` (`audit-telegram-runtime.md` `TR-01`, `audit-utilities-security.md`, `audit-csv-restrictions-review.md`) |
| 31 | `Bot/src/telegramApi.js` | `INSPECTED` | 250 | 12,450 | `6df7611642ed4c8e` | Lines `1–250` (`audit-accounts-entrypoints.md` `ENTRY-RAW-02`, `audit-telegram-runtime.md` `TR-03`, `findings-current-017-033.md` `FINDING-018`) |
| 32 | `Bot/src/telegramFlows.js` | `INSPECTED` | 302 | 23,606 | `9cc978c2b21db9b7` | Lines `1–302` (`audit-telegram-full.md`, `audit-telegram-runtime.md`, `audit-routing.md`, `audit-appimage-boundary.md`) |
| 33 | `Bot/src/telegramUi.js` | `INSPECTED` | 2,002 | 113,743 | `9a0c255c504dac86` | Lines `1–2002` (`audit-telegram-full.md` `UI-01..04`, `audit-telegram-runtime.md` `TR-01`, `TR-03..07`, `audit-recovery-flow.md`) |
| 34 | `Bot/src/watchdog.js` | `INSPECTED` | 33 | 2,156 | `dcab869974484361` | Lines `1–33` (`audit-utilities-security.md`, `audit-telegram-runtime.md` `TR-07`) |
| 35 | `Bot/src/xFailureClassification.js` | `INSPECTED` | 18 | 845 | `da140e7fa589b820` | Lines `1–18` (`audit-utilities-security.md`, `add-current-assessment.md` `ADD-P4-03`) |
| 36 | `Bot/python/README.md` | `INSPECTED` | 142 | 8,277 | `90d467cb4cec8925` | Lines `1–142` (`phase1-audit-completion-gate.md`, `audit-python-bridge.md`) |
| 37 | `Bot/python/direct_x_bridge.py` | `INSPECTED` | 1,264 | 60,717 | `c23f14f5aa061252` | Lines `1–1264` (`audit-python-bridge.md` `PY-RAW-01..04`, `PY-RAW-06..07`, `audit-x-transport.md` `XT-01..02`, `XT-05`, `drift-x-revalidation.md`) |
| 38 | `Bot/python/direct_x_compat.py` | `INSPECTED` | 562 | 24,352 | `e5bc6631a3667cd3` | Lines `1–562` (`audit-python-bridge.md` `PY-RAW-05`, `audit-x-transport.md`, `audit-dependencies.md`, `findings-current-001-016.md` `FINDING-008`, `FINDING-010`, `FINDING-012`) |
| 39 | `Bot/scripts/apply_m11_ambiguous_recovery.js` | `INSPECTED` | 116 | 3,860 | `48610d5d0b1479b7` | Lines `1–116` (`audit-scripts-deploy.md`, `phase1-audit-completion-gate.md`) |
| 40 | `Bot/scripts/audit_ambiguous_readonly.js` | `INSPECTED` | 39 | 1,632 | `42ebb22a0cbd575d` | Lines `1–39` (`audit-scripts-deploy.md`, `phase1-audit-completion-gate.md`) |
| 41 | `Bot/scripts/check_timelines_readonly.py` | `INSPECTED` | 166 | 7,474 | `dc27d89c49d6f00a` | Lines `1–166` (`audit-scripts-deploy.md`, `phase1-audit-completion-gate.md`) |
| 42 | `Bot/scripts/configure_m4_single_publish.js` | `INSPECTED` | 64 | 2,017 | `02eaf48fe34ce15b` | Lines `1–64` (`audit-scripts-deploy.md`, `audit-cas-review.md`) |
| 43 | `Bot/scripts/live_production_5_rounds_monitor.js` | `INSPECTED` | 155 | 7,120 | `4c6f5a6109015d02` | Lines `1–155` (`audit-scripts-deploy.md`, `add-current-assessment.md` `ADD-P6-02`) |
| 44 | `Bot/scripts/m8_live_production_monitor.js` | `INSPECTED` | 414 | 17,421 | `3b46eff468b9b37f` | Lines `1–414` (`audit-scripts-deploy.md`, `add-current-assessment.md` `ADD-P6-02`) |
| 45 | `Bot/scripts/package_live_operational_verification.py` | `INSPECTED` | 162 | 7,259 | `592b6a668d8eb51a` | Lines `1–162` (`audit-scripts-deploy.md`, `phase1-audit-completion-gate.md`) |
| 46 | `Bot/scripts/package_phase_p1.py` | `INSPECTED` | 97 | 3,852 | `7b92d29ea980eade` | Lines `1–97` (`audit-scripts-deploy.md`, `phase1-audit-completion-gate.md`) |
| 47 | `Bot/scripts/revert_false_recovery_m11.js` | `INSPECTED` | 235 | 9,529 | `5ee8fb82891af957` | Lines `1–235` (`audit-scripts-deploy.md`, `audit-persistence.md` `PERSIST-OBS-03`) |
| 48 | `Bot/scripts/run_all_automated_tests.sh` | `INSPECTED` | 189 | 7,624 | `98da4a881b75bca4` | Lines `1–189` (`audit-ci-appimage.md` `CI-01`, `CI-06`, `audit-scripts-deploy.md`) |
| 49 | `Bot/scripts/send_m14_final_acceptance_evidence.py` | `INSPECTED` | 170 | 7,065 | `76a8b1f84d2e1f3c` | Lines `1–170` (`audit-scripts-deploy.md`, `phase1-audit-completion-gate.md`) |
| 50 | `Bot/scripts/send_m14_postmerge_evidence.py` | `INSPECTED` | 189 | 7,705 | `1185621dc866208a` | Lines `1–189` (`source-drift-ci.md`, `audit-source-drift.md`) |
| 51 | `Bot/scripts/send_m14_python_reconciliation_evidence.py` | `INSPECTED` | 215 | 9,394 | `c0b81aaa98bd02a0` | Lines `1–215` (`source-drift-ci.md`, `audit-source-drift.md`) |
| 52 | `Bot/scripts/send_m14_round2_evidence.py` | `INSPECTED` | 94 | 3,626 | `f937480707ade629` | Lines `1–94` (`audit-scripts-deploy.md`, `phase1-audit-completion-gate.md`) |
| 53 | `Bot/scripts/send_m14_round3_evidence.py` | `INSPECTED` | 94 | 3,704 | `c30c698cc896ce05` | Lines `1–94` (`audit-scripts-deploy.md`, `phase1-audit-completion-gate.md`) |
| 54 | `Bot/scripts/send_m14_round4_evidence.py` | `INSPECTED` | 112 | 4,539 | `a583a9d6891f22ce` | Lines `1–112` (`audit-scripts-deploy.md`, `phase1-audit-completion-gate.md`) |
| 55 | `Bot/scripts/settle_item_53d0f458.js` | `INSPECTED` | 245 | 10,628 | `8f6974bdf23eb235` | Lines `1–245` (`audit-scripts-deploy.md`, `audit-persistence.md` `PERSIST-OBS-03`) |
| 56 | `Bot/scripts/verify_attempt_token_adversarial.js` | `INSPECTED` | 500 | 23,901 | `ef81efde009b8237` | Lines `1–500` (`audit-scripts-deploy.md`, `phase1-audit-completion-gate.md`) |
| 57 | `Bot/scripts/verify_p1_004_dedup.js` | `INSPECTED` | 149 | 6,639 | `20ecbbb12f60df28` | Lines `1–149` (`audit-scripts-deploy.md`, `phase1-audit-completion-gate.md`) |
| 58 | `Bot/scripts/verify_p1_005_queue_flow.js` | `INSPECTED` | 207 | 7,527 | `9105e506bb8194ce` | Lines `1–207` (`audit-scripts-deploy.md`, `phase1-audit-completion-gate.md`) |
| 59 | `Bot/scripts/verify_stale_attempt_tokens.js` | `INSPECTED` | 195 | 10,157 | `796a4a9e4cd4dbff` | Lines `1–195` (`audit-scripts-deploy.md`, `phase1-audit-completion-gate.md`) |
| 60 | `Bot/docker/Dockerfile.vpn` | `INSPECTED` | 26 | 1,595 | `76c46587f7fe0196` | Lines `1–26` (`audit-vpn-sessions.md`, `findings-current-017-033.md` `FINDING-031`) |
| 61 | `Bot/docker/README.md` | `INSPECTED` | 52 | 7,582 | `527df0422ac7e614` | Lines `1–52` (`audit-vpn-sessions.md`, `phase1-audit-completion-gate.md`) |
| 62 | `Bot/docker/check-pin.sh` | `INSPECTED` | 10 | 453 | `c9fe8e3364e366c8` | Lines `1–10` (`audit-vpn-sessions.md`) |
| 63 | `Bot/docker/entrypoint.sh` | `INSPECTED` | 151 | 7,164 | `e937ea247a7721b5` | Lines `1–151` (`audit-vpn-sessions.md` `VPN-RAW-01`) |
| 64 | `Bot/docker/health-dispatch.sh` | `INSPECTED` | 11 | 496 | `faec91793c3e3320` | Lines `1–11` (`audit-vpn-sessions.md`) |
| 65 | `Bot/docker/healthcheck.sh` | `INSPECTED` | 37 | 1,942 | `2f8b348f6c38a478` | Lines `1–37` (`audit-vpn-sessions.md`) |
| 66 | `Bot/docker/sticky-health.sh` | `INSPECTED` | 47 | 2,004 | `7f1c3e99db48a48b` | Lines `1–47` (`audit-vpn-sessions.md`) |
| 67 | `Bot/systemd/telegram-bot-launcher.sh` | `INSPECTED` | 39 | 1,453 | `ae94754ddd34ab92` | Lines `1–39` (`audit-ci-appimage.md`, `audit-scripts-deploy.md`) |
| 68 | `Bot/systemd/yj-telegram-bot.service` | `INSPECTED` | 32 | 1,014 | `014ee3c60378bd4d` | Lines `1–32` (`audit-ci-appimage.md`, `audit-scripts-deploy.md`, `findings-current-001-016.md` `FINDING-005`) |
| 69 | `Bot/systemd/yj-telegram-bot.user.service` | `INSPECTED` | 29 | 1,034 | `d31ca5c2725d0a3f` | Lines `1–29` (`phase1-audit-completion-gate.md`) |

---

## 2. Cross-Module Execution & Governance Flows (8 / 8 `INSPECTED`)

| # | Cross-Module Flow | Status | Inspected Modules & Boundary Seams | Evidence Pointers & Discovered Issues |
|---:|---|---|---|---|
| 1 | **Telegram, scheduler, account controls** | `INSPECTED` | `index.js` (`1–44`), `auth.js` (`1–34`), `telegram.js` (`1–176`), `telegramApi.js` (`1–250`), `telegramUi.js` (`1–2002`), `telegramFlows.js` (`1–302`), `runner.js` (`1368–1662`), `accounts.js` (`1–365`), `scheduling.js` (`1–19`), `settings.js` (`1–99`), `tableUtils.js` (`1–29`), `accountTable.js` (`1–37`), `accountRefresh.js` (`1–122`) | `audit-telegram-full.md`, `audit-telegram-runtime.md`, `audit-accounts-entrypoints.md`, `audit-csv-restrictions-review.md` (`TR-01..07`, `UI-01..04`, `ACC-RAW-01..04`, `ENTRY-RAW-01..02`, `UTIL-RAW-02`, `UTIL-RAW-04`) |
| 2 | **Claim, dispatch, confirmation, quota, outbox** | `INSPECTED` | `runner.js` (`142–163`, `505–1366`), `queue.js` (`1–126`), `sqliteStore.js` (`1–280`), `directX.js` (`1–374`), `direct_x_bridge.py` (`1–1264`), `direct_x_compat.py` (`1–562`), `publishOutcome.js` (`1–13`), `quota.js` (`1–39`), `attemptOutcomes.js` (`1–29`), `forensicLogger.js` (`1–526`), `forensicMutex.js` (`1–149`), `linkExports.js` (`1–397`), `ambiguousAudit.js` (`1–46`) | `audit-cas-review.md`, `audit-persistence.md`, `audit-runner-full.md`, `audit-python-bridge.md`, `audit-x-transport.md`, `audit-recovery-flow.md`, `audit-routing.md`, `drift-x-revalidation.md` (`PERSIST-OBS-01..05`, `RUN-02..05`, `PY-RAW-01..07`, `XT-01..05`, `UTIL-RAW-03`) |
| 3 | **CAPTCHA and incident delivery** | `INSPECTED` | `direct_x_compat.py` (`134–291`), `direct_x_bridge.py` (`879–1185`), `directX.js` (`201–340`), `runner.js` (`392–454`, `535–805`, `973–980`), `telegramUi.js` (`851–928`, `1113–1655`, `1801–1945`), `accounts.js` (`21–74`, `150–235`, `322–351`) | `audit-telegram-full.md`, `audit-telegram-runtime.md`, `audit-x-transport.md`, `audit-csv-restrictions-review.md` (`UI-02`, `UI-03`, `TR-03`, `TR-04`, `TR-06`, `XT-02`, `XT-03`, `ACC-RAW-01`, `ACC-RAW-04`, `RUN-03`) |
| 4 | **VPN lifecycle and session ceiling** | `INSPECTED` | `dockerVpn.js` (`1–462`), `sessionGuard.js` (`1–472`), `directX.js` (`30–145`, `335–368`), `runner.js` (`279–398`, `456–503`, `687–705`, `840–948`), `telegramUi.js` (`1120–1255`, `1446–1495`, `1666–1671`), `Bot/docker/*` (all 7 files) | `audit-vpn-sessions.md`, `audit-telegram-runtime.md`, `audit-telegram-full.md` (`VPN-RAW-01..04`, `SESSION-RAW-01..03`, `TR-05`, `UI-01`) |
| 5 | **AppImage integration, CI, deploy and rollback** | `INSPECTED` | `.github/workflows/verify-xposter.yml` (`1–65`), `.github/workflows/apply-remaining-repair.yml` (`1–186`), `Appimage/scripts/verify-release.sh` (`1–122`), `Bot/package.json`, `Bot/scripts/*` (all 21 files), `Bot/systemd/*` (all 3 files), selected `Appimage/dev/*` boundary files | `audit-ci-appimage.md`, `audit-appimage-boundary.md`, `audit-scripts-deploy.md`, `source-drift-ci.md`, `audit-source-drift.md` (`CI-01..08`) |
| 6 | **Live service logs and resource endurance** | `INSPECTED` | `yj-telegram-bot.service` runtime journal (`181` records over 24h), archived raw logs (`Round7_PostMerge`, `Round8_M10`), `systemctl show`, `/proc/2581192`, `docker stats`/`docker ps -a`, `state.sqlite` (`mode=ro`), `session_leases.sqlite` (`mode=ro`) | `audit-logs-resources.md`, `drift-runtime.md`, `audit-cas-review.md`, `audit-dependencies.md` |
| 7 | **Security, credentials, policy and dependency supply chain** | `INSPECTED` | `env.js` (`1–193`), `auth.js` (`1–34`), `accounts.js` (`248–319`), `structuredLogger.js` (`1–207`), `sqliteStore.js` (`25–75`), `Bot/package.json`, `Bot/requirements-direct-x.txt`, `.venv-direct-x` (`21` packages), official X Developer Policy endpoints | `audit-utilities-security.md`, `audit-accounts-entrypoints.md`, `audit-dependencies.md`, `official-policy-evidence.md`, `audit-persistence.md` (`UTIL-RAW-01`, `ACC-RAW-02..03`, `ENTRY-RAW-02`, `PERSIST-OBS-05`) |
| 8 | **All historical report claims, archives and legacy tests** | `INSPECTED` | `33 FINDING-001..033` claims, `20 ADD-P1..P6` claims, `112` report/archive artifacts (`72` Markdown, `19` JSON/JSONL/log/patch/txt, `21` ZIP/tar.gz archives streamed & CRC-checked), `58` Node tests (`Bot/test/*.test.js`), `14` Python tests, `7` `Bot/TEST_RUNNER/*` files | `findings-claims.md`, `findings-current-001-016.md`, `findings-current-017-033.md`, `add-claims.md`, `add-current-assessment.md`, `historical-read.md`, `history-coverage.md`, `historical-nonmarkdown.md`, `archive-evidence-index.md`, `audit-legacy-test-safety.md`, `audit-legacy-python-tests.md`, `audit-legacy-node-batch-01..07` |

---

## 3. Explicit `NOT_INSPECTED` Inventory & Out-of-Scope Boundaries

| Category / Surface | Specific Uninspected Items | Exact Reason for `NOT_INSPECTED` / Non-Execution |
|---|---|---|
| **Out-of-Scope `Appimage/` Desktop Internals** | `Appimage/dev/preload.js` (beyond IPC search), `Appimage/dev/renderer/*`, `Appimage/dev/templates/*`, `Appimage/dev/security/auditor.js`, `Appimage/dev/utils/fatal.js`, `Appimage/dev/automation/durableQueue.js`, `Appimage/dev/automation/referralService.js`, `Appimage/dev/automation/reportEngine.js`, `Appimage/dev/automation/semanticIndex.js`, `Appimage/dev/automation/sessionManager.js`, `Appimage/dev/automation/workflowMigration.js`, remaining lines of `Appimage/dev/automation/workflowStore.js` (~3,500 lines; only lines `158, 625` read), remaining lines of `Appimage/dev/automation/xPoster.js` (~1,348 lines; only lines `1–90, 450–465` read), remaining lines of `Appimage/dev/automation/contentEngine.js` (only lines `481–500, 596` read), and line-by-line body execution of `Appimage/test/*.test.js` (94 files hashed and lexically scanned in `history-coverage.md`). *(Note: `browserManager.js`, `migrator.js`, `validator.js`, `logger.js`, `atomicJson.js`, `profileRegistry.js`, `profileLifecycle.js`, `dispatchBoundary.js`, `runControl.js`, `rateLimitStore.js`, `durableSession.js`, `storeHealth.js`, and boundary spans of `main.js`/`workflowBackup.js` were inspected in `audit-appimage-boundary.md`.)* | `Appimage/` is a standalone Electron/Playwright desktop application with its own SQLite store (`~/.config/x-poster-shared/workflow.sqlite`) and no runtime code or database shared with the `Bot/` daemon. Per task scope, `Appimage/` internals outside the CSV/backup/CI boundary are out of scope for the `Bot/` surgical audit and protected from Bot cleanup. |
| **Live External X (Twitter) Endpoints & Account Standing** | Live GraphQL `CreateTweet` dispatches, live `user_tweets` timeline fetches, live `v11.user_state` / `v11.settings` / `get_user_by_id` probes against `x.com` / `api.x.com`, and live X account suspension/challenge state for the 5 configured accounts. | **Strict Read-Only & Policy Mandate:** Live publishing, account probes, and non-compliant website scripting against X are strictly prohibited during the audit. Furthermore, `https://help.x.com/en/rules-and-policies/x-automation` and `platform-manipulation` returned `HTTP 403` to this host (`official-policy-evidence.md`), leaving live website-scripting compliance unverified. |
| **Live Telegram Bot API Mutations & Poll Loop** | Live `getUpdates` polling, `sendMessage`, `sendRichMessage`, `editMessageText`, `sendDocument`, and live operator callback interactions against `api.telegram.org`. | **Strict Read-Only Mandate:** Calling `getUpdates` against the active production bot token would cause a `409 Conflict` against the live daemon (`PID 2581192`), and sending synthetic messages/documents would pollute production operator chats (`528864559`, `5535435580`). |
| **Live Docker VPN Container Mutations & NordVPN Dashboard** | Live `docker run`, `docker rm -f`, `docker restart`, `nordvpn login`, `nordvpn connect`, `nordvpn disconnect`, live IP rotation (`rotateContainerIp`), and remote NordVPN account dashboard device-fingerprint inventory. | **Strict 7-Container Host Cap & Read-Only Mandate:** Spawning, restarting, or rotating containers is strictly forbidden to prevent new device fingerprints (`/var/lib/nordvpn/data/install.dat` / `moose.db`) from exhausting the 10-device NordVPN ceiling or disrupting active tunnels. |
| **Live Systemd Daemon Control & Production SQLite Writes** | `systemctl restart/stop/start yj-telegram-bot.service`, live mutations to `/root/Projects/YJAutoPostOnX/Bot/data/state.sqlite` or `session_leases.sqlite`, and live settlement/requeue of the 30 quarantined ambiguous items (including `53d0f458-3144-4e89-a1af-202a8893afc6`). | **Strict Read-Only Mandate:** Production state, running systemd services, and the 30 quarantined ambiguous items are strictly read-only until owner sign-off and Phase 2 remediation gates are satisfied. |



---

# Section 2: Complete Historical Chronology (M1–M14, Rounds 1–14, PRs #1–#29) & Inventory of All 72 Markdown Reports, 24 Non-Markdown Files, and 21 Archives

> **Forensic Verification & Provenance Notice:** Every historical claim, test count, live tweet URL, and Telegram delivery receipt reported across Milestones `M1`–`M14` and `Rounds 1`–`14` is preserved below for full historical traceability. Claims that rely on author-reported test logs, unextracted/uncorroborated live runs, or mechanisms refuted by Phase 1 source inspection are explicitly tagged **`[CLAIMED-UNVERIFIED]`** or **`[CONTRADICTED BY PHASE 1 AUDIT]`**.

## 2.1 Chronology of Incidents, Milestones (`M1`–`M14`), Rounds (`1`–`14`), and Pull Requests (`PR #1`–`#29`)

### 2.1.1 Pull Request Ledger (`PR #1` through `PR #29`)

| PR / Merge | Merge / Head SHA | Date (2026) | Scope & Historical Claim Summary | Phase 1 Forensic Audit Tag |
|---|---|---|---|---|
| **PR #1** | `540a0d2` | Jul 26 | One-shot remaining-audit repair script (`Appimage`/xposter workflow). | `HISTORICAL-APPIMAGE` (`Out of Bot scope`) |
| **PR #2** | `a597257` | Jul 26 | Guarded xposter audit completion pass (`Appimage`). | `HISTORICAL-APPIMAGE` (`Out of Bot scope`) |
| **PR #3** | `e42387b` | Jul 26 | Verify xposter completion through pull request & preserve failure diagnostics (`Appimage`). | `HISTORICAL-APPIMAGE` (`Out of Bot scope`) |
| **PR #4–#5** | `7c6743c`..`35beb75` | Jul 26–27 | Intermediate xposter CI/AppImage integration gates (superseded by PR #6). | `HISTORICAL-APPIMAGE` (`Out of Bot scope`) |
| **PR #6** | `811017f` | Jul 27 | Final integration of xposter audit repairs onto `main` (`v5.20.0`–`v5.21.0`, `0014db6`). | `HISTORICAL-APPIMAGE` (`Out of Bot scope`) |
| **PR #7** | `b66c082`..`79b752e` | Oct 31–Nov 01 | Initial Telegram UI table styling and Phase P1 publishing fence commits (`18ef16e`, `2c06586`, `076f800`). | **`[CONTRADICTED BY PHASE 1 AUDIT]`** (`UTIL-RAW-02` table mismatch; `PY-RAW-02` `'before send'` fallback) |
| **PR #8** | `19b9870` (`1c4b19a`) | Nov 01 | Repository structure reorganization separating `Appimage/` and `Bot/` directories. | **`[VERIFIED]`** (Directory split verified; `CI-02` workflow gap introduced here) |
| **PR #9** | `78c8719` (`9542917`) | Nov 01 | Update GitHub Actions workflow working directories and cache paths to `Appimage/`. | **`[CONTRADICTED BY PHASE 1 AUDIT]`** (`CI-02`: excluded `Bot/` from all GitHub Actions CI runs) |
| **PR #10** | `8c8d075` (`49aece0`) | Nov 01 | Sync sanitized architectural (`00_START_HERE.md`..`10_UNRESOLVED_AND_SOURCES.md`) and Phase P1 handoff reports. | **`[CLAIMED-UNVERIFIED]`** (Contains 33 `FINDING` baseline; see Section 3) |
| **PR #11–#12** | `35531b1`..`6df57fc` | Nov 01–02 | Phase P2, Phase P3/M1–M5 live operational verification, Round 3 (`M1`–`M5`), and Round 4 (`M6`) commits on `main`, plus GitHub Issue #12 master tracking issue. | **`[CLAIMED-UNVERIFIED]` / `[CONTRADICTED]`** (Introduced `PERSIST-OBS-04` async-outside-tx CAS bug in `7b7c1fb` and `CI-01` live destructive tests in `Bot/test/`) |
| **PR #13** | `3e8323e` | Nov 02 | Prevent M8 monitoring script from falsifying production evidence (`Round 6 / M8`). | **`[CLAIMED-UNVERIFIED]`** (Monitor scripts still dump unredacted `journalctl` in `live_production_5_rounds_monitor.js`) |
| **PR #14** | `1168a7a` | Nov 02 | Redact JSON-embedded secrets from structured logs (`structuredLogger.js`). | **`[CONTRADICTED BY PHASE 1 AUDIT]`** (`UTIL-RAW-01`: top-level `extra` keys bypass `SENSITIVE_KEY_PATTERN`) |
| **PR #15** | `4942a25` (`0f1b4cd`..`c9dff45`) | Nov 03 | Do not strike accounts for confirmed Twikit `KeyError: 'urls'` profile parser failure (`knownTwikitParserFailure.js`, `Round 7`). | **`[VERIFIED]`** (Narrow parser-failure strike exemption verified in `knownTwikitParserFailure.js`) |
| **PR #16** | `b7528ae` | Nov 03 | Milestone M9: Show failed/ambiguous daily attempts (`attemptOutcomes.js`), rate-limit fencing, reduce panel load. | **`[CLAIMED-UNVERIFIED]`** (`attemptOutcomes.js` verified in source; post-dispatch rate-limit in Python bridge still returns `ambiguous: False` in `PY-RAW-04` / `XT-05`) |
| **PR #17** | `447ffa0` | Nov 03 | Milestone M10: Native start receipt, SQLite read lock reduction (`BEGIN` deferred for `load()`), evidence timing (`Round 8`). | **`[CONTRADICTED BY PHASE 1 AUDIT]`** (`PERSIST-OBS-04` CAS retry stale closure flag remains open) |
| **PR #18** | `028aab5` (`fbd7d2d`..`cc337f6`) | Nov 03 | Milestone M10 Extension: Observe actual run until terminal CSV receipts and corroborate post results. | **`[CLAIMED-UNVERIFIED]`** (`ADD-P6-02`: no live monitor run executed during read-only audit) |
| **PR #19** | `8b49f35` (`cf47fcf`) | Nov 03 | Milestone M11: Preserve upstream X rejection causes (`186`/`187` content rejections excluded from account strikes) and audit ambiguous items safely. | **`[VERIFIED]`** (`xFailureClassification.js` verified; `ADD-P5-01` pre-dispatch weighted char check still missing) |
| **PR #20** | `3f44eaf` | Nov 03 | Append 20 missing `ADD-P1-01..ADD-P6-04` tasks and sign-off gates to `MASTER_TODO.md`. | **`[VERIFIED]`** (All 20 `ADD` IDs indexed and evaluated in Section 3) |
| **PR #21** | `7e1453b` | Nov 03 | Milestone M11 (Round 9): Preserve full GraphQL error causality and audit 30 ambiguous items baseline. | **`[CONTRADICTED BY PHASE 1 AUDIT]`** (`XT-02`: `DirectXAdapter.publish()` drops `accountFailure` on `recoveredFromTimeline`) |
| **PR #22** | `20f3483` | Nov 03 | Sync Round 9 M11 findings, revert 4 false recoveries (`revert_false_recovery_m11.js`), update P1–P6 register. | **`[CLAIMED-UNVERIFIED]`** (30 ambiguous items confirmed in SQLite; `PERSIST-OBS-02` `Queue.requeue` unguarded) |
| **PR #23** | `0be50e5` | Nov 03 | Round 10 / M11: Harden recovery migration scripts, verify `53d0f458` Snowflake timestamp (`2116981347772498219`), reconcile ambiguous provenance. | **`[CLAIMED-UNVERIFIED]`** (`53d0f458` remains `ambiguous` in production DB pending owner approval; `XT-01` runtime bridge still lacks Snowflake lower-bound check!) |
| **PR #24** | `3d33bc6` | Nov 03 | Annotate all 20 `P1`–`P6` `ADD` tasks with Round 10 status and acceptance gates. | **`[CLAIMED-UNVERIFIED]`** (Self-reported status annotations evaluated in Section 3) |
| **PR #25** | `e8a367b` | Nov 03 | Round 11 / M12: Enforce SQLite test isolation guards, granular X rejections, and 30-item ambiguous forensic ledger (`m12_ambiguous_30_forensic_ledger.json`). | **`[CONTRADICTED BY PHASE 1 AUDIT]`** (`PERSIST-OBS-05`: `sqliteStore.js` path guard bypassed from secondary git worktrees) |
| **PR #26** | `4b34898` | Nov 03 | Round 12 / M13: Contain 3-account restriction incident (`@kaniabq`, `@marcosvhv`, `@menalobq`), introduce `sessionGuard.js` 5-session ceiling, harden `settle_item_53d0f458.js`. | **`[CONTRADICTED BY PHASE 1 AUDIT]`** (`SESSION-RAW-01..03`: `bindChildProcess` swallows SQLite errors, no `starttime` check; `ACC-RAW-01`: CSV import wipes restrictions) |
| **PR #27** | `21c44df` (`d55bdfd`..`dc03fc2`) | Nov 03–04 | Round 13 & Round 14 / M14: Human-only CAPTCHA state machine (`needsOwnerCaptcha`, `verify_captcha`), cross-process `sessionGuard.js`, `ForensicMutex`, per-incident dual-chat receipts (Review Rounds 1–4). | **`[CONTRADICTED BY PHASE 1 AUDIT]`** (`TR-06`: concurrent `accountToggle` overwrites `needsOwnerCaptcha`; `UI-02`: `accmanage:disable` overwrites status and deadlocks `verify_captcha`) |
| **PR #28** | `f394756` (`fcd9491`..`a5caa87`) | Nov 04 | M14 Post-Merge VPS Deployment & Non-Posting Acceptance docs, delivery manifests, and Python/Docker evidence reconciliation. | **`[CLAIMED-UNVERIFIED]`** (Contains internal test-count discrepancy `207/207` vs 1 failure and `453/453` vs `444 pass / 7 fail / 2 skip`) |
| **PR #29** | `08bc6a0` (`4841ee1`..`c23a750`) | Nov 04 | Guard `client_error` with `isinstance(client_error, BaseException)` and bound `429` regex in `direct_x_bridge.py`. | **`[PARTIALLY VERIFIED / CI FAILED]`** (`PY-RAW-07`: `429` still matches numeric IDs `429` in unstructured strings; PR #29 head CI job `126416216292` failed with `boot exit code: 5`) |

---

### 2.1.2 Chronology of Historical Incidents & Rounds (`Round 1`–`14` / `M1`–`M14`)

1. **Pre-Audit Baseline & Telegram `409 Conflict` Incident (2026-10-28 – 2026-11-01):**
   - **Incident:** Production logs recorded 564 Telegram `409 Conflict: terminated by other getUpdates request` errors (`05_TELEGRAM_AND_SERVICES.md`), caused by `/etc/systemd/system/yj-telegram-bot.service` executing `ExecStartPre=/bin/rm -f .../telegram-runner.lock` (`FINDING-005`) while an instance was already running, combined with a 30s socket timeout against a 50s `getUpdates` poll (`FINDING-018`).
   - **Publishing Replay & Ambiguity Incidents:** Between `2026-11-01` and `2026-11-03`, 30 queue items entered `state: 'ambiguous'` across 5 accounts (`@emiehg`, `@crytpokingxvo8`, `@kaniabq`, `@marcosvhv`, `@menalobq`). `10_UNRESOLVED_AND_SOURCES.md` explicitly admits that while duplicate-replay mechanisms (`FINDING-001`, `FINDING-002`, `FINDING-003`) were reproduced in isolated mocks, historical production duplicate tweets were not conclusively proven from raw logs **`[CLAIMED-UNVERIFIED]`**.
2. **Round 1 — Phase P1 Publishing Safety Fence (`2026-11-01`, `PHASE_P1/`):**
   - Addressed `P1-001` (`FINDING-001`), `P1-002` (`FINDING-002`), `P1-003` (`FINDING-003`/`009`), `P1-004` (`FINDING-011`), `P1-005` (`FINDING-026`).
   - **Audit Finding:** Preliminary run reported `24 PASS / 14 FAIL` vs `25 PASS / 13 FAIL` (due to `Q_CRASH_TX` worker exit before `SIGKILL`), later expanded to `44/44 PASS` in `TEST_RUNNER/run_suite.py`. However, Phase 1 source inspection proved `PY-RAW-02` (`'before send'` substring fallback on `POST`) and `XT-01` (30-minute `is_recent_tweet` window without `dispatch_started_at` lower bound) remained open **`[CONTRADICTED BY PHASE 1 AUDIT]`**.
3. **Round 2 — Phase P2 Concurrency, Environment & Twikit Compatibility (`2026-11-01`, `PHASE_P2/`):**
   - Addressed `FINDING-004`, `005`, `007`, `008`, `010`, `012`, `015`, `016`, `018`, `020`, `021`, `031`.
   - **Audit Finding:** `FINDING-005`, `008`, `016`, `018`, `020` verified in code, but `FINDING-007` (`PY-RAW-01`: `use_cache` still skips `v11.user_state()`), `FINDING-015` (`dockerVpn.js:138–146` still calls unproxied `curl https://api.ipify.org`), `FINDING-021` (`PY-RAW-06`: `prctl` errors ignored), and `FINDING-031` (`isCompatibleVpnImage` still accepts `:latest`) remained open **`[CONTRADICTED BY PHASE 1 AUDIT]`**.
4. **Round 3 — Phase P3 / Milestones `M1`–`M5` Live VPS Operational Runs (`2026-11-01` – `2026-11-02`):**
   - Fixed `.venv-direct-x/bin/python` resolution in `directX.js` (`M1`), removed `rm -f` from systemd unit (`M2`), and reported live X tweets (`2116972202335830066`, `2116996420637196576`, `2117218878304801135`) and Telegram CSV deliveries (`M3`–`M5`) **`[CLAIMED-UNVERIFIED]`**.
   - **Audit Hazard Introduced:** Created `Bot/test/live_vps_m4_operational.test.js` and `docker_vpn_live_slots.test.js` inside `Bot/test/*.test.js` (`CI-01`), causing `npm test` to copy live `state.sqlite`, rotate live NordVPN containers, and send real Telegram messages!
5. **Round 4 — Milestone `M6` P3/P4 Closure & OCC (`2026-11-02`, `Round4_Final/`):**
   - Commit `7b7c1fb` modified `Bot/src/sqliteStore.js` to avoid holding transactions across async yields (`FINDING-025`) by moving `await mutator(draft)` **outside** `BEGIN IMMEDIATE` and retrying on `REVISION_CONFLICT` (`FINDING-024`).
   - **Audit Finding:** Moving `mutator(draft)` outside `BEGIN IMMEDIATE` directly introduced the critical **`PERSIST-OBS-04` / `RUN-02` CAS retry stale-closure bug** **`[CONTRADICTED BY PHASE 1 AUDIT]`**.
6. **Round 5 — Milestone `M7` Delegate Investigation & Per-RunId CSV Deduplication (`2026-11-02`, `Round5_Delegates/`):**
   - Delegates `D01`–`D04` scoped terminal CSV export deduplication to `runId` (`1eb8e91`).
   - **Audit Finding:** `linkExports.js:112–123` (`UTIL-RAW-03`) pushes a new suppressed event object into `state.linkTerminalEvents` on every duplicate call without bound **`[CONTRADICTED BY PHASE 1 AUDIT]`**.
7. **Round 6 & Round 7 — Milestone `M8` Long-Run Production & Post-Merge Verification (`2026-11-02` – `2026-11-03`, `Round6_M8/`, `Round7_PostMerge/`):**
   - Standardized `structuredLogger.js` (`a27eff6`, PR #14) and exempted Twikit `KeyError: 'urls'` from account strikes (PR #15). Claimed 10-turn and post-merge live runs **`[CLAIMED-UNVERIFIED]`**.
   - **Audit Finding:** `structuredLogger.js:102–105` (`UTIL-RAW-01`) failed to check `SENSITIVE_KEY_PATTERN` on top-level `extra` keys **`[CONTRADICTED BY PHASE 1 AUDIT]`**.
8. **Round 8 — Milestones `M9` & `M10` Multi-Round Endurance & Deferred SQLite Reads (`2026-11-03`, `Round8_M10/`, PRs #16–#18):**
   - Added `attemptOutcomes.js` (`M9`), changed `SqliteStore.load()` to `BEGIN` deferred (`M10`), and claimed 5-round / 50-post live run **`[CLAIMED-UNVERIFIED]`**.
9. **Round 9 & Round 10 — Milestone `M11` False Recovery Reversion, `ADD-P1..P6` Register & `53d0f458` Snowflake Audit (`2026-11-03`, PRs #19–#24):**
   - Reverted 4 items (`47da5e8a`, `10afc79e`, `3719dfde`, `53d0f458`) that an earlier script (`apply_m11_ambiguous_recovery.js`) had mutated without full provenance (`revert_false_recovery_m11.js`), restoring all 30 items to `state: 'ambiguous'`. Identified candidate tweet `2116981347772498219` for item `53d0f458-3144-4e89-a1af-202a8893afc6` via Snowflake timestamp decoding.
10. **Round 11 — Milestone `M12` SQLite Test Isolation & Granular Rejections (`2026-11-03`, PR #25):**
    - Added `assertMutationAllowed()` to `sqliteStore.js` and `forensicLogger.js`.
    - **Audit Finding:** `resolveProductionDbPath()` (`PERSIST-OBS-05`) used `__dirname`-relative resolution, failing to protect `/root/Projects/YJAutoPostOnX/Bot/data/state.sqlite` when invoked from another git worktree **`[CONTRADICTED BY PHASE 1 AUDIT]`**.
11. **Round 12 — Milestone `M13` Three-Account Restriction Incident & 5-Session Ceiling (`2026-11-03`, PR #26):**
    - **Incident:** On `2026-11-03 12:58Z`, accounts `@kaniabq`, `@marcosvhv`, and `@menalobq` failed session checks and were marked disabled (`محظور`). M13 isolated those 3 accounts and introduced `Bot/src/sessionGuard.js` (`session_leases.sqlite`).
12. **Round 13 & Round 14 — Milestone `M14` Human-Only CAPTCHA Gate, Transactional Outbox & Post-Merge Reconciliation (`2026-11-03` – `2026-11-04`, PRs #27–#29):**
    - Implemented `needsOwnerCaptcha` state machine, `ForensicMutex`, per-chat alert receipts (`PR #27` merged at `21c44df`), post-merge deployment (`PID 2581192`), and Python mock-429 isolation fix (`PR #29` `08bc6a0`, `PR #28` `f394756`).
    - **Audit Finding:** Uncovered 59 raw findings in `f394756` (Section 4), including `TR-06` (concurrent toggle race bypassing `needsOwnerCaptcha`), `ACC-RAW-01` (CSV import wiping `needsOwnerCaptcha`/`محظور`), `UI-02` (disable button deadlocking `verify_captcha`), `VPN-RAW-01..04` (7-container cap and `docker rm -f` hazards), and `CI-01..08` (including PR #29's Xvfb GPU crash `job/126416216292`).

---

## 2.2 Complete Inventory of All 72 Historical Markdown Reports (`Bot/Reports/*.md`)

All 72 historical Markdown reports retired from `Bot/Reports/` are cataloged below with their exact byte size, full SHA-256 digest, and off-repo backup location in `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/`:

| # | Historical Markdown Report Path | Git Status | Bytes | Full SHA-256 | Off-Repo Backup Archive Pointer | Audit Claim Tag |
|---:|---|---|---:|---|---|---|
| 1 | `Bot/Reports/00_START_HERE.md` | `tracked` | 10,732 | `c2c1666c4323b4ab783e1c8947529fcf64be8bd81ca45d75526daae66385d611` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/00_START_HERE.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/00_START_HERE.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 2 | `Bot/Reports/01_ARCHITECTURE.md` | `tracked` | 18,256 | `ff1b48d0588745e30e3271f7275072ef710fd93e4fe7a057b9c4867977dbce8a` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/01_ARCHITECTURE.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/01_ARCHITECTURE.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 3 | `Bot/Reports/02_PUBLISHING.md` | `tracked` | 14,420 | `2b6ab5331524651158b2e9aa0ac767e2062a6c889146d8b37dfd019cf53dc672` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/02_PUBLISHING.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/02_PUBLISHING.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 4 | `Bot/Reports/03_QUEUE_AND_DATABASE.md` | `tracked` | 12,783 | `d9f3df8c2077c282a7950d42d966e854c1b59769c2382e619ae1051f0e5aca4f` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/03_QUEUE_AND_DATABASE.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/03_QUEUE_AND_DATABASE.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 5 | `Bot/Reports/04_ACCOUNTS_AND_NETWORK.md` | `tracked` | 9,484 | `aa396dfa1dbc7b9b18e527aee14292298bc5e2b56babceda04ca43c6f3984bc0` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/04_ACCOUNTS_AND_NETWORK.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/04_ACCOUNTS_AND_NETWORK.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 6 | `Bot/Reports/05_TELEGRAM_AND_SERVICES.md` | `tracked` | 9,121 | `dba66bdacc955540aea40ff244a6b86964909b687851b79a58a78013e6cd7094` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/05_TELEGRAM_AND_SERVICES.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/05_TELEGRAM_AND_SERVICES.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 7 | `Bot/Reports/06_PERFORMANCE_AND_SECURITY.md` | `tracked` | 8,700 | `6435896bc592dd52609371f3d9a1f9eb0b398662d9119d8d231fa9c193f4b5fc` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/06_PERFORMANCE_AND_SECURITY.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/06_PERFORMANCE_AND_SECURITY.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 8 | `Bot/Reports/07_ALL_FINDINGS.md` | `tracked` | 29,191 | `4e1d9f53bb56612a46bdde7b0a120cebea037aafaf146cff24010ded065da513` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/07_ALL_FINDINGS.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/07_ALL_FINDINGS.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 9 | `Bot/Reports/08_EVIDENCE_AND_TEST_CONCLUSIONS.md` | `tracked` | 12,714 | `3bfef3bfb00ee27a2b1b65e7394614113f216f774bf154711867569b26bde973` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/08_EVIDENCE_AND_TEST_CONCLUSIONS.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/08_EVIDENCE_AND_TEST_CONCLUSIONS.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 10 | `Bot/Reports/09_REPAIR_ROADMAP.md` | `tracked` | 13,410 | `991bbc1c56482c68cbc675dfa30a76d90f7c95359bb98147a6501c6bb2f64ee0` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/09_REPAIR_ROADMAP.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/09_REPAIR_ROADMAP.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 11 | `Bot/Reports/10_UNRESOLVED_AND_SOURCES.md` | `tracked` | 8,109 | `68c738a4c4d1183cd6f75cc41d3b92e2a322bb575edf43bd8fc62ff4e0331dda` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/10_UNRESOLVED_AND_SOURCES.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/10_UNRESOLVED_AND_SOURCES.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 12 | `Bot/Reports/M13_EXECUTION_REPORT.md` | `tracked` | 8,541 | `5ec32700f4dab4dc9da1cd5af29004977be12df49fc5edee26b3bab3f79b1ab6` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/M13_EXECUTION_REPORT.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/M13_EXECUTION_REPORT.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 13 | `Bot/Reports/M13_SESSION_CAP_AUDIT.md` | `tracked` | 3,226 | `be577039130544d7a3cb7d75f785b19bf3f78ab498970a98b88d18316fc81a60` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/M13_SESSION_CAP_AUDIT.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/M13_SESSION_CAP_AUDIT.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 14 | `Bot/Reports/M13_SQLITE_SAFETY_AUDIT.md` | `tracked` | 3,095 | `ee9550559a8eff8519109eec59288e1ed637ef6312e89f2de784d94742cc9e06` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/M13_SQLITE_SAFETY_AUDIT.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/M13_SQLITE_SAFETY_AUDIT.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 15 | `Bot/Reports/M13_THREE_ACCOUNT_RESTRICTION_INCIDENT.md` | `tracked` | 5,234 | `8eb93d61ea0fb6cf4f0815e6092dfd5745e736ac5af10c34236b74f7b737ecc4` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/M13_THREE_ACCOUNT_RESTRICTION_INCIDENT.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/M13_THREE_ACCOUNT_RESTRICTION_INCIDENT.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 16 | `Bot/Reports/M14_INCIDENT_AND_CAPTCHA_GOVERNANCE_REPORT.md` | `tracked` | 4,303 | `f99d390c97ca782a5c4ddefd35795580d2772cb3215a44b37c1c94bb0df2421e` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/M14_INCIDENT_AND_CAPTCHA_GOVERNANCE_REPORT.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/M14_INCIDENT_AND_CAPTCHA_GOVERNANCE_REPORT.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 17 | `Bot/Reports/M14_OUTBOX_AND_SQLITE_SAFETY_REPORT.md` | `tracked` | 3,207 | `9da25634b5b9c06d08dabe7b5b473972160733bbfe70d5fa4d72847a645c2116` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/M14_OUTBOX_AND_SQLITE_SAFETY_REPORT.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/M14_OUTBOX_AND_SQLITE_SAFETY_REPORT.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 18 | `Bot/Reports/M14_PR27_REVIEW_FIXES_AUDIT.md` | `tracked` | 6,466 | `94d6c385e340bf728b49f9b503ce1e62771809b1a049669f20576373c14e81e8` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/M14_PR27_REVIEW_FIXES_AUDIT.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/M14_PR27_REVIEW_FIXES_AUDIT.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 19 | `Bot/Reports/M14_PR27_REVIEW_ROUND2_EVIDENCE.md` | `tracked` | 6,320 | `ba05f9cf2067bbdb8012b4c0f607561b5587374fb1bb2eac805e9b8cf15e433a` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/M14_PR27_REVIEW_ROUND2_EVIDENCE.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/M14_PR27_REVIEW_ROUND2_EVIDENCE.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 20 | `Bot/Reports/M14_PR27_REVIEW_ROUND3_EVIDENCE.md` | `tracked` | 6,511 | `5a0575dee4d5c2a61bf138aafa712cd8222ea1ba993ded3f92754cfadf48c90c` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/M14_PR27_REVIEW_ROUND3_EVIDENCE.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/M14_PR27_REVIEW_ROUND3_EVIDENCE.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 21 | `Bot/Reports/M14_PR27_REVIEW_ROUND4_EVIDENCE.md` | `tracked` | 6,630 | `0bf408bcf461261f9dc1b31f3aaf1846cbeb62932c79c83f6203a5879034fd7e` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/M14_PR27_REVIEW_ROUND4_EVIDENCE.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/M14_PR27_REVIEW_ROUND4_EVIDENCE.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 22 | `Bot/Reports/M14_SESSION_GUARD_CROSS_PROCESS_AUDIT.md` | `tracked` | 2,678 | `76a443b0965d2a431f5ec8d03b201f6d5a862d5105ca3bfb413e9b806dec0a58` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/M14_SESSION_GUARD_CROSS_PROCESS_AUDIT.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/M14_SESSION_GUARD_CROSS_PROCESS_AUDIT.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 23 | `Bot/Reports/PHASE_P1/GIT_COMMITS.md` | `tracked` | 4,817 | `e65db87fe3f78ec2ba63bd73c85d34f01c9c33e100bd6931f112b86653e7b0d4` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/PHASE_P1/GIT_COMMITS.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/PHASE_P1/GIT_COMMITS.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 24 | `Bot/Reports/PHASE_P1/REPORT.md` | `tracked` | 10,549 | `872785c5e6f953a9d624fca74d70925c492f1661d28578e5769a9c211f18042d` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/PHASE_P1/REPORT.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/PHASE_P1/REPORT.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 25 | `Bot/Reports/PHASE_P1/TEST_RESULTS.md` | `tracked` | 7,754 | `8577f4333d15aae876eca41f0cc27c759451b16cdaaca2aa0312f5471a3be163` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/PHASE_P1/TEST_RESULTS.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/PHASE_P1/TEST_RESULTS.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 26 | `Bot/Reports/RepairHandoff/GITHUB_ACTIONS_FIX/ACTIONS_FIX_REPORT_20261101.md` | `tracked` | 1,630 | `82cb8da9d8ba8645bb3103dea180c2edcdff0b06d4e01e69f1987bca1c8592b3` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/GITHUB_ACTIONS_FIX/ACTIONS_FIX_REPORT_20261101.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/GITHUB_ACTIONS_FIX/ACTIONS_FIX_REPORT_20261101.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 27 | `Bot/Reports/RepairHandoff/GITHUB_SYNC/FULL_SYNC_FINAL_20261101.md` | `tracked` | 1,998 | `8f7d7baf6b4a64f0c4be363ce8b8c67d7e1fd58fc46a20aa50a8ca41504fd1c1` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/GITHUB_SYNC/FULL_SYNC_FINAL_20261101.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/GITHUB_SYNC/FULL_SYNC_FINAL_20261101.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 28 | `Bot/Reports/RepairHandoff/GITHUB_SYNC/SYNC_REPORT_20261101.md` | `tracked` | 2,508 | `34e37bc31525ee593db0b34bf573fc930555072d3c4be3363d79808079b7e7ed` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/GITHUB_SYNC/SYNC_REPORT_20261101.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/GITHUB_SYNC/SYNC_REPORT_20261101.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 29 | `Bot/Reports/RepairHandoff/M14_FINAL_VPS_ACCEPTANCE_REPORT.md` | `tracked` | 8,127 | `7b4f47f255f0f416e1e577f31dcc9ea50cf79bfec4019522885493f1c4532030` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/M14_FINAL_VPS_ACCEPTANCE_REPORT.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/M14_FINAL_VPS_ACCEPTANCE_REPORT.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 30 | `Bot/Reports/RepairHandoff/M14_POST_MERGE_VPS_ACCEPTANCE_REPORT.md` | `tracked` | 11,569 | `3f861394c3090ba4e51de210cd1b3a99849cf9184fcd6ff09b311de853add46a` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/M14_POST_MERGE_VPS_ACCEPTANCE_REPORT.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 31 | `Bot/Reports/RepairHandoff/MASTER_TODO.md` | `tracked` | 58,507 | `56060b3622978f6bb11885741bfece58b55b8d5f9a1f6da32214e0d5eeab76bc` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/MASTER_TODO.md) [baseline 21c44df in /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst]` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 32 | `Bot/Reports/RepairHandoff/P1_P6_ORIGINAL_PLAN_GAP_REGISTER_2026-11-03.md` | `tracked` | 15,069 | `83dba9c4eda814108e89b6c1dbd1693cd0ad4ebc9c6307acbe99b52f6fa38672` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/P1_P6_ORIGINAL_PLAN_GAP_REGISTER_2026-11-03.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/P1_P6_ORIGINAL_PLAN_GAP_REGISTER_2026-11-03.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 33 | `Bot/Reports/RepairHandoff/PHASE_P1/GIT_COMMITS.md` | `tracked` | 5,348 | `7abe83502de072ff491c3c78636a0069ab9d3f73d78185219e1746afb9e6505b` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/PHASE_P1/GIT_COMMITS.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/PHASE_P1/GIT_COMMITS.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 34 | `Bot/Reports/RepairHandoff/PHASE_P1/REPORT.md` | `tracked` | 20,454 | `5bd14aa6e94d395b08c48d2c0a61a42488aea147777cc5042f351c985f7532eb` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/PHASE_P1/REPORT.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/PHASE_P1/REPORT.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 35 | `Bot/Reports/RepairHandoff/PHASE_P1/TEST_RESULTS.md` | `tracked` | 13,171 | `86b3639d5c23a39dab5f410bc708b1c6069e19fb1ff1419adaf5b7185daf57f7` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/PHASE_P1/TEST_RESULTS.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/PHASE_P1/TEST_RESULTS.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 36 | `Bot/Reports/RepairHandoff/PHASE_P2/TEST_RESULTS.md` | `tracked` | 5,175 | `aeffb4d57d7801c697cb5afd7c38658e730d809d76658f325f508730418e5ec6` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/PHASE_P2/TEST_RESULTS.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/PHASE_P2/TEST_RESULTS.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 37 | `Bot/Reports/RepairHandoff/PROGRESS_HISTORY.md` | `tracked` | 123,244 | `e3e6d3933745b922fd14037cd587ba993b8f8590711cd0b3c7e4901f0b0034a8` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/PROGRESS_HISTORY.md) [baseline 21c44df in /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst]` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 38 | `Bot/Reports/RepairHandoff/RESOURCE_CLEANUP_REPORT.md` | `tracked` | 9,258 | `6eb97609eece217cb823f7c60df031149ae98dd7b62d5a122f2dea3f7a422bff` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/RESOURCE_CLEANUP_REPORT.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/RESOURCE_CLEANUP_REPORT.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 39 | `Bot/Reports/RepairHandoff/Round14_M14_PostMerge_VPS_Acceptance_Delivery_Manifest.md` | `tracked` | 854 | `47f13faa4f69aa8917a7e926e6b39795869e1e8e4dbb4f266c5cd884a338cd9a` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/Round14_M14_PostMerge_VPS_Acceptance_Delivery_Manifest.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 40 | `Bot/Reports/RepairHandoff/Round14_M14_Python_Reconciliation_Delivery_Manifest.md` | `tracked` | 1,163 | `0ccdbdc6fc54fadc6dbaae5cf3f406767b18938d9ecf1865a098b8ab260865ca` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/Round14_M14_Python_Reconciliation_Delivery_Manifest.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 41 | `Bot/Reports/RepairHandoff/Round4_Final/FINDINGS_REVALIDATION.md` | `tracked` | 11,314 | `498fa42fd7c46547d29ffd51fe8a5b1169a736e50aaeb490b2821d89eea3c79a` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/Round4_Final/FINDINGS_REVALIDATION.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/Round4_Final/FINDINGS_REVALIDATION.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 42 | `Bot/Reports/RepairHandoff/Round4_Final/GITHUB_DELIVERY_STATUS.md` | `tracked` | 3,084 | `419c5f2a6aeeb403497fffc6b0a5cffd094504da930d0be1e71dc239c9ed9104` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/Round4_Final/GITHUB_DELIVERY_STATUS.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/Round4_Final/GITHUB_DELIVERY_STATUS.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 43 | `Bot/Reports/RepairHandoff/Round4_Final/LIVE_PRODUCTION_EVIDENCE.md` | `tracked` | 4,073 | `a473c6563a081d1cf223a058c6887553198387d229154c6e7b9e24c49200d041` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/Round4_Final/LIVE_PRODUCTION_EVIDENCE.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/Round4_Final/LIVE_PRODUCTION_EVIDENCE.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 44 | `Bot/Reports/RepairHandoff/Round4_Final/NEXT_SESSION_HANDOFF.md` | `tracked` | 5,336 | `8b74e8d8fc78fe533d82426de1b886af54a3e46de4fab4a5ac09b2f1c711de0a` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/Round4_Final/NEXT_SESSION_HANDOFF.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/Round4_Final/NEXT_SESSION_HANDOFF.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 45 | `Bot/Reports/RepairHandoff/Round4_Final/RECOVERY_AND_GIT_AUDIT.md` | `tracked` | 3,531 | `866731bdc3e61bc04d9adc2b3069a56c6d2db0f88136816e46c3ca43bbcb8099` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/Round4_Final/RECOVERY_AND_GIT_AUDIT.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/Round4_Final/RECOVERY_AND_GIT_AUDIT.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 46 | `Bot/Reports/RepairHandoff/Round4_Final/RESOURCE_BASELINE_AND_CLEANUP.md` | `tracked` | 2,218 | `dbd8673cf44de7c12ccd2a71f5d1115d440d860960a1a9cb65db36943199ca4a` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/Round4_Final/RESOURCE_BASELINE_AND_CLEANUP.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/Round4_Final/RESOURCE_BASELINE_AND_CLEANUP.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 47 | `Bot/Reports/RepairHandoff/Round4_Final/TEST_EXECUTION_EVIDENCE.md` | `tracked` | 6,518 | `968dc0a34ae7dbb266cc6211e5abf175ebd263740f0a7e2a73603e8d8c241550` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/Round4_Final/TEST_EXECUTION_EVIDENCE.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/Round4_Final/TEST_EXECUTION_EVIDENCE.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 48 | `Bot/Reports/RepairHandoff/Round4_Final/VPN_ROOT_CAUSE_AND_RECOVERY.md` | `tracked` | 4,650 | `2bde3b3f94ae18a0785beb864d79483449517c79242af42730b15a6c11a0ec3e` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/Round4_Final/VPN_ROOT_CAUSE_AND_RECOVERY.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/Round4_Final/VPN_ROOT_CAUSE_AND_RECOVERY.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 49 | `Bot/Reports/RepairHandoff/Round5_Delegates/D01_INVESTIGATION_REPORT.md` | `tracked` | 21,075 | `44d4803933b102bf4a4bd3b5fce5c202e40c974acb8c531a8e605c449b674dc5` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/Round5_Delegates/D01_INVESTIGATION_REPORT.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/Round5_Delegates/D01_INVESTIGATION_REPORT.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 50 | `Bot/Reports/RepairHandoff/Round5_Delegates/D02_REPAIR_REPORT.md` | `tracked` | 9,902 | `83c0940bc18af81ec4673f7c36c88cb89148bff72d8e8fcc719458f2f79db59b` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/Round5_Delegates/D02_REPAIR_REPORT.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/Round5_Delegates/D02_REPAIR_REPORT.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 51 | `Bot/Reports/RepairHandoff/Round5_Delegates/D03_VERIFICATION_REPORT.md` | `tracked` | 19,115 | `aca1466ef4519715745efab9d9758de4ce41f0ce3ca1393bcb5f0c96232ff0b5` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/Round5_Delegates/D03_VERIFICATION_REPORT.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/Round5_Delegates/D03_VERIFICATION_REPORT.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 52 | `Bot/Reports/RepairHandoff/Round5_Delegates/D04_QUALITY_AND_HANDOFF_REVIEW.md` | `tracked` | 14,634 | `454e887fe6d4a6c96a91f09b0b912223895b033f3558df4511fe339ff1340e03` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/Round5_Delegates/D04_QUALITY_AND_HANDOFF_REVIEW.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/Round5_Delegates/D04_QUALITY_AND_HANDOFF_REVIEW.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 53 | `Bot/Reports/RepairHandoff/Round6_M8/ACCOUNT_ROTATION_MATRIX.md` | `tracked` | 10,152 | `494f9bd3dadf747304447e6dcde1046783d0c7ae7da39da60cf1f78869c086d8` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/Round6_M8/ACCOUNT_ROTATION_MATRIX.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/Round6_M8/ACCOUNT_ROTATION_MATRIX.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 54 | `Bot/Reports/RepairHandoff/Round6_M8/D05_SILENT_FAILURE_AUDIT_REPORT.md` | `tracked` | 22,666 | `307732798bfb5ef166418c6434a9b954903adc08a135f8b8e3467e1fc785663c` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/Round6_M8/D05_SILENT_FAILURE_AUDIT_REPORT.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/Round6_M8/D05_SILENT_FAILURE_AUDIT_REPORT.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 55 | `Bot/Reports/RepairHandoff/Round6_M8/FINAL_PRODUCTION_VERDICT.md` | `tracked` | 6,426 | `e361110534311e1ffd2d7c9983d400ddf768ee12be05c6756efdbcf91259462b` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/Round6_M8/FINAL_PRODUCTION_VERDICT.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/Round6_M8/FINAL_PRODUCTION_VERDICT.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 56 | `Bot/Reports/RepairHandoff/Round6_M8/LIVE_RUNTIME_TIMELINE.md` | `tracked` | 7,911 | `b3a293985f8c7e1ff47a371bf10eedfccf22f0bc8a63cc5b8ace31ec8c1b17c1` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/Round6_M8/LIVE_RUNTIME_TIMELINE.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/Round6_M8/LIVE_RUNTIME_TIMELINE.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 57 | `Bot/Reports/RepairHandoff/Round6_M8/SILENT_FAILURE_AUDIT.md` | `tracked` | 4,860 | `345f433ef94dd014c2a60e74f24c50195d40ad01a24f75d81c920e8cbc23acf9` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/Round6_M8/SILENT_FAILURE_AUDIT.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/Round6_M8/SILENT_FAILURE_AUDIT.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 58 | `Bot/Reports/RepairHandoff/Round6_M8/TELEGRAM_CSV_DELIVERY.md` | `tracked` | 4,581 | `07cf356af20062e61bd5cab5ec9a53f7950c03e911ebe245d53651ed3ca5529d` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/Round6_M8/TELEGRAM_CSV_DELIVERY.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/Round6_M8/TELEGRAM_CSV_DELIVERY.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 59 | `Bot/Reports/RepairHandoff/Round6_M8/TEST_EXECUTION_RESULTS.md` | `tracked` | 3,268 | `1d6d14e1226c2eecb939cab49de7cc31640c2fd3bf901db63523cdb2470f6d41` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/Round6_M8/TEST_EXECUTION_RESULTS.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/Round6_M8/TEST_EXECUTION_RESULTS.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 60 | `Bot/Reports/RepairHandoff/Round6_M8/VPN_AND_RESOURCE_MONITORING.md` | `tracked` | 3,493 | `e905b6a7ed3ed3388fa5cbb8c5f9155bd1ae6ce94b6b476bfba60a05a0a6da63` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/Round6_M8/VPN_AND_RESOURCE_MONITORING.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/Round6_M8/VPN_AND_RESOURCE_MONITORING.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 61 | `Bot/Reports/RepairHandoff/Round7_PostMerge/ACCOUNT_ROTATION_AND_PANEL_VERIFICATION.md` | `tracked` | 5,888 | `69563ff7b2008503c497881250711d5b22e69e96e741871113f237f461c26619` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/Round7_PostMerge/ACCOUNT_ROTATION_AND_PANEL_VERIFICATION.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/Round7_PostMerge/ACCOUNT_ROTATION_AND_PANEL_VERIFICATION.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 62 | `Bot/Reports/RepairHandoff/Round8_M10/ACCOUNT_ROTATION_MATRIX.md` | `tracked` | 5,248 | `25c3170235b6494d9e3be29dc45d9fa54b63f45987cb50f69ae2c4ee17fbdee0` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/Round8_M10/ACCOUNT_ROTATION_MATRIX.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/Round8_M10/ACCOUNT_ROTATION_MATRIX.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 63 | `Bot/Reports/RepairHandoff/Round8_M10/LATENCY_AND_EVENT_LOOP_TELEMETRY.md` | `tracked` | 4,025 | `388f715332086b9e8a963b03a8d20c085f9f04b909c43a113df96c1292d9b159` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/Round8_M10/LATENCY_AND_EVENT_LOOP_TELEMETRY.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/Round8_M10/LATENCY_AND_EVENT_LOOP_TELEMETRY.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 64 | `Bot/Reports/RepairHandoff/STRUCTURE_REORGANIZATION/BEFORE_AFTER_TREE.md` | `tracked` | 359 | `d3b211a3591d25b2af72060ed0cc1cfec485935875a602592771d68dfda1afe4` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/STRUCTURE_REORGANIZATION/BEFORE_AFTER_TREE.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/STRUCTURE_REORGANIZATION/BEFORE_AFTER_TREE.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 65 | `Bot/Reports/RepairHandoff/STRUCTURE_REORGANIZATION/BLOCKERS.md` | `tracked` | 86 | `148d9212eb0631cd5be471692239ef788eb2f8bcfadffc59c925f87cf074e68b` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/STRUCTURE_REORGANIZATION/BLOCKERS.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/STRUCTURE_REORGANIZATION/BLOCKERS.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 66 | `Bot/Reports/RepairHandoff/STRUCTURE_REORGANIZATION/FILE_MIGRATION_MAP.md` | `tracked` | 754 | `cfc00dbdacc59d5e0038025ba2a02624371fdedec4766ed9921d113ecd75cd15` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/STRUCTURE_REORGANIZATION/FILE_MIGRATION_MAP.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/STRUCTURE_REORGANIZATION/FILE_MIGRATION_MAP.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 67 | `Bot/Reports/RepairHandoff/STRUCTURE_REORGANIZATION/FINAL_VERIFICATION.md` | `tracked` | 141 | `62481c494eac8c33fef49d723d8a945e823e287b91dc1d30b6f19ab8eb873d6b` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/STRUCTURE_REORGANIZATION/FINAL_VERIFICATION.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/STRUCTURE_REORGANIZATION/FINAL_VERIFICATION.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 68 | `Bot/Reports/RepairHandoff/STRUCTURE_REORGANIZATION/GIT_CHANGES.md` | `tracked` | 151 | `1a97fb512d949ba26bbb73ca7b70cc372c3930f83595940e1584b81b4f22e4f4` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/STRUCTURE_REORGANIZATION/GIT_CHANGES.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/STRUCTURE_REORGANIZATION/GIT_CHANGES.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 69 | `Bot/Reports/RepairHandoff/STRUCTURE_REORGANIZATION/PATH_REFERENCE_CHANGES.md` | `tracked` | 401 | `2f5b923f49658870d65fb3444a3fc5746d2a47964e05b53a37a0bb8bd07f478b` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/STRUCTURE_REORGANIZATION/PATH_REFERENCE_CHANGES.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/STRUCTURE_REORGANIZATION/PATH_REFERENCE_CHANGES.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 70 | `Bot/Reports/RepairHandoff/STRUCTURE_REORGANIZATION/REPORT.md` | `tracked` | 953 | `b86f85f74c86a10ff19058ea1b9e9420f1b9bccec6f334fd21a06269c8265ef6` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/STRUCTURE_REORGANIZATION/REPORT.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/STRUCTURE_REORGANIZATION/REPORT.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 71 | `Bot/Reports/RepairHandoff/STRUCTURE_REORGANIZATION/ROLLBACK_PLAN.md` | `tracked` | 106 | `2f0f55d493aaba2c93eb08b76b52f5eec46dfcddc12b7f9ff131141102bf5ae6` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/STRUCTURE_REORGANIZATION/ROLLBACK_PLAN.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/STRUCTURE_REORGANIZATION/ROLLBACK_PLAN.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |
| 72 | `Bot/Reports/RepairHandoff/STRUCTURE_REORGANIZATION/TEST_RESULTS.md` | `tracked` | 230 | `d379793f37e793090a951e7837d7db3b78674710349e63e5ce5766a900a2dc8c` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/STRUCTURE_REORGANIZATION/TEST_RESULTS.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/STRUCTURE_REORGANIZATION/TEST_RESULTS.md)` | `CLAIMED-UNVERIFIED` (except narrow code items verified in Section 3) |

---

## 2.3 Complete Inventory of All 24 Historical Non-Markdown Files (`Bot/Reports/*`)

All 24 historical JSON, JSONL, log, patch, and text files retired from `Bot/Reports/` are cataloged below with their exact byte size, full SHA-256 digest, and off-repo backup pointer:

| # | Historical Non-Markdown File Path | Git Status | Bytes | Full SHA-256 | Off-Repo Backup Archive Pointer | Audit Claim Tag |
|---:|---|---|---:|---|---|---|
| 1 | `Bot/Reports/M13_AMBIGUOUS_30_STATUS.json` | `tracked` | 30,501 | `25a6343a0acdae0dc90545a1c734e61e89110b58a7f673c4114600904a5b498d` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/M13_AMBIGUOUS_30_STATUS.json) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/M13_AMBIGUOUS_30_STATUS.json)` | `CLAIMED-UNVERIFIED` (Historical raw artifact; not live proof) |
| 2 | `Bot/Reports/M13_THREE_ACCOUNT_TIMELINE_REDACTED.json` | `tracked` | 2,926 | `164ec03d6c857f386ce355c64752f32df512e054bf328654d11d6109a23b5e51` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/M13_THREE_ACCOUNT_TIMELINE_REDACTED.json) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/M13_THREE_ACCOUNT_TIMELINE_REDACTED.json)` | `CLAIMED-UNVERIFIED` (Historical raw artifact; not live proof) |
| 3 | `Bot/Reports/M14_AMBIGUOUS_30_STATUS.json` | `tracked` | 30,594 | `27314f92a707222c8b3a7dcb76490315005c2430e6e6932e86ee543a620b37a6` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/M14_AMBIGUOUS_30_STATUS.json) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/M14_AMBIGUOUS_30_STATUS.json)` | `CLAIMED-UNVERIFIED` (Historical raw artifact; not live proof) |
| 4 | `Bot/Reports/RepairHandoff/P1_P6_ORIGINAL_PLAN_GAP_REGISTER_2026-11-03.json` | `tracked` | 17,201 | `2280ddb08abf8494eba86ec5c1cfcf3ca76eff9b6d4b73319819507e53997ad4` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/P1_P6_ORIGINAL_PLAN_GAP_REGISTER_2026-11-03.json) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/P1_P6_ORIGINAL_PLAN_GAP_REGISTER_2026-11-03.json)` | `CLAIMED-UNVERIFIED` (Historical raw artifact; not live proof) |
| 5 | `Bot/Reports/RepairHandoff/PHASE_P1/TEST_RESULTS.json` | `tracked` | 77,008 | `b019673d37f14d6fdf805f8db48e50e6283c8d0f373e3043583fe8786078bed7` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/PHASE_P1/TEST_RESULTS.json) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/PHASE_P1/TEST_RESULTS.json)` | `CLAIMED-UNVERIFIED` (Historical raw artifact; not live proof) |
| 6 | `Bot/Reports/RepairHandoff/PHASE_P1/phase_p1_fixes.patch` | `tracked` | 543,613 | `1d25ae55dc1c27cc958d499f2a531962672a37713deda423d953ba2ab6a51abf` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/PHASE_P1/phase_p1_fixes.patch) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/PHASE_P1/phase_p1_fixes.patch)` | `CLAIMED-UNVERIFIED` (Historical raw artifact; not live proof) |
| 7 | `Bot/Reports/RepairHandoff/PHASE_P1/phase_p1_round4.patch` | `tracked` | 47,927 | `fb46d9dd9214948d5c5ef12996fce360ae91911e19407a841b5b82202e3f135d` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/PHASE_P1/phase_p1_round4.patch) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/PHASE_P1/phase_p1_round4.patch)` | `CLAIMED-UNVERIFIED` (Historical raw artifact; not live proof) |
| 8 | `Bot/Reports/RepairHandoff/PHASE_P2/phase_p2_fixes.patch` | `tracked` | 66,527 | `914eb178f5a3ffe5873506ab2dd486448b9e71c6a76074a6c819b9dc62c4781e` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/PHASE_P2/phase_p2_fixes.patch) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/PHASE_P2/phase_p2_fixes.patch)` | `CLAIMED-UNVERIFIED` (Historical raw artifact; not live proof) |
| 9 | `Bot/Reports/RepairHandoff/Round14_M14_PR27_Final_VPS_Acceptance_Delivery_Manifest.json` | `tracked` | 5,017 | `0782ba35f3b3641fb61f9f9ccac49fab8e81a4229d784712f9702e7c56cfde32` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/Round14_M14_PR27_Final_VPS_Acceptance_Delivery_Manifest.json) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/Round14_M14_PR27_Final_VPS_Acceptance_Delivery_Manifest.json)` | `CLAIMED-UNVERIFIED` (Historical raw artifact; not live proof) |
| 10 | `Bot/Reports/RepairHandoff/Round14_M14_PostMerge_VPS_Acceptance_Delivery_Manifest.json` | `tracked` | 5,399 | `457f110b5f3e0fc395072ebd3c53fb7b21e9205e284b7b1d4c710b465adc97e5` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/Round14_M14_PostMerge_VPS_Acceptance_Delivery_Manifest.json)` | `CLAIMED-UNVERIFIED` (Historical raw artifact; not live proof) |
| 11 | `Bot/Reports/RepairHandoff/Round14_M14_Python_Reconciliation_Delivery_Manifest.json` | `tracked` | 5,854 | `afbd0b5e004ff7aad54c398ccf1ebcd344950ad36e40c86bd9c24afc8564c09f` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/Round14_M14_Python_Reconciliation_Delivery_Manifest.json)` | `CLAIMED-UNVERIFIED` (Historical raw artifact; not live proof) |
| 12 | `Bot/Reports/RepairHandoff/Round6_M8/LIVE_PRODUCTION_10_TURNS.jsonl` | `tracked` | 8,157 | `e6c255925927542937ab64e3fcbb2e88c1c539a3196169d48d5361b68352d280` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/Round6_M8/LIVE_PRODUCTION_10_TURNS.jsonl) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/Round6_M8/LIVE_PRODUCTION_10_TURNS.jsonl)` | `CLAIMED-UNVERIFIED` (Historical raw artifact; not live proof) |
| 13 | `Bot/Reports/RepairHandoff/Round6_M8/live_timeline_events.json` | `tracked` | 4,926 | `8dbb8bc83b8910637a8617fea7417b87e30602e03a404aa9fa25207292fc61e9` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/Round6_M8/live_timeline_events.json) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/Round6_M8/live_timeline_events.json)` | `CLAIMED-UNVERIFIED` (Historical raw artifact; not live proof) |
| 14 | `Bot/Reports/RepairHandoff/Round6_M8/resource_snapshots.json` | `tracked` | 58,042 | `10cb29b59a092cfd76aab78afd1234f2dada61a958164b3d33776d67c4a73796` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/Round6_M8/resource_snapshots.json) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/Round6_M8/resource_snapshots.json)` | `CLAIMED-UNVERIFIED` (Historical raw artifact; not live proof) |
| 15 | `Bot/Reports/RepairHandoff/Round7_PostMerge/LIVE_REAL_TELEGRAM_RUN_EVIDENCE.jsonl` | `tracked` | 7,485 | `d738b62ca2fadfa3cbe42e0d78e2ebf334465cbcd4eaadc61618895b4088e719` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/Round7_PostMerge/LIVE_REAL_TELEGRAM_RUN_EVIDENCE.jsonl) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/Round7_PostMerge/LIVE_REAL_TELEGRAM_RUN_EVIDENCE.jsonl)` | `CLAIMED-UNVERIFIED` (Historical raw artifact; not live proof) |
| 16 | `Bot/Reports/RepairHandoff/Round7_PostMerge/real_telegram_run_raw_logs.log` | `untracked_gitignored` | 440,544 | `1228a36b7622a260be2180f82d7d71c324b522c3400734111c53846890489c98` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/Round7_PostMerge/real_telegram_run_raw_logs.log)` | `CLAIMED-UNVERIFIED` (Historical raw artifact; not live proof) |
| 17 | `Bot/Reports/RepairHandoff/Round8_M10/LIVE_PRODUCTION_5_ROUNDS.jsonl` | `tracked` | 6,876 | `be3dace95d88c2d510cd85093365914035b10df23231cc2a3b5b02c459a41baa` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/Round8_M10/LIVE_PRODUCTION_5_ROUNDS.jsonl) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/Round8_M10/LIVE_PRODUCTION_5_ROUNDS.jsonl)` | `CLAIMED-UNVERIFIED` (Historical raw artifact; not live proof) |
| 18 | `Bot/Reports/RepairHandoff/Round8_M10/LIVE_PRODUCTION_FULL_RUN.jsonl` | `tracked` | 9,019 | `648c5e4a91a08a5ce1a0062b92f83d314da1c4dcb631f67b4eb2a659497566f7` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/Round8_M10/LIVE_PRODUCTION_FULL_RUN.jsonl) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/Round8_M10/LIVE_PRODUCTION_FULL_RUN.jsonl)` | `CLAIMED-UNVERIFIED` (Historical raw artifact; not live proof) |
| 19 | `Bot/Reports/RepairHandoff/Round8_M10/live_production_service_raw_logs.log` | `untracked_gitignored` | 517,819 | `1ba29865a23ed6cf025b0fa2448c2b7123c784d448791a7d261eb77f42071713` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/Round8_M10/live_production_service_raw_logs.log)` | `CLAIMED-UNVERIFIED` (Historical raw artifact; not live proof) |
| 20 | `Bot/Reports/RepairHandoff/STRUCTURE_REORGANIZATION/PRE_MIGRATION_FILELIST.txt` | `tracked` | 2,674,095 | `6515a799454f6665b3d829c8609a827d889c18c7ccd9d7d7030593ed620ce49e` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/STRUCTURE_REORGANIZATION/PRE_MIGRATION_FILELIST.txt) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/STRUCTURE_REORGANIZATION/PRE_MIGRATION_FILELIST.txt)` | `CLAIMED-UNVERIFIED` (Historical raw artifact; not live proof) |
| 21 | `Bot/Reports/RepairHandoff/STRUCTURE_REORGANIZATION/PRE_MIGRATION_MANIFEST.txt` | `tracked` | 3,175,951 | `4ef1409209d41b9c367d392feb05bd2ffb69e200d48ef00d0566e62bf61e4fc6` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/STRUCTURE_REORGANIZATION/PRE_MIGRATION_MANIFEST.txt) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/STRUCTURE_REORGANIZATION/PRE_MIGRATION_MANIFEST.txt)` | `CLAIMED-UNVERIFIED` (Historical raw artifact; not live proof) |
| 22 | `Bot/Reports/audit_ambiguous_m11.json` | `tracked` | 24,304 | `2491f310983a8a144210c04717c7bd2ca42a34a846f722da42de4bf6a0cbe52e` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/audit_ambiguous_m11.json) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/audit_ambiguous_m11.json)` | `CLAIMED-UNVERIFIED` (Historical raw artifact; not live proof) |
| 23 | `Bot/Reports/m12_ambiguous_30_forensic_ledger.json` | `tracked` | 28,932 | `7dca07595acdc4cbe4369bb643b6ebf5426a0f74c1c06ea9c23ce29992502690` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/m12_ambiguous_30_forensic_ledger.json) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/m12_ambiguous_30_forensic_ledger.json)` | `CLAIMED-UNVERIFIED` (Historical raw artifact; not live proof) |
| 24 | `Bot/Reports/timeline_audit_results.json` | `tracked` | 1,776 | `e4fbb1307665d2fd6c2c30cf1728869f85ac9546da184d54f8f95bf7f82b775f` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/timeline_audit_results.json) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/timeline_audit_results.json)` | `CLAIMED-UNVERIFIED` (Historical raw artifact; not live proof) |

---

## 2.4 Complete Inventory of All 21 Historical Archives (`Bot/Reports/**/*.zip` & `.tar.gz`)

All 21 compressed archives (18 `.zip`, 3 `.tar.gz`) retired from `Bot/Reports/` were streamed in memory, SHA-256 hashed, and ZIP-CRC verified during Phase 0 (`archive-evidence-index.md`) and are backed up in `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst` (and `tracked-source.tar.zst` for tracked archives):

| # | Historical Archive Path (`Bot/Reports/`) | Git Status | Compressed Bytes | Full SHA-256 | Off-Repo Backup Archive Pointer | Audit Claim Tag |
|---:|---|---|---:|---|---|---|
| 1 | `Bot/Reports/RepairHandoff/ARCHIVES/FULL_SYNC_FINAL_20261101.tar.gz` | `tracked` | 2,769 | `362cb95a376ef43a4f9046e6779c2de82546b7d1993883225b865fefd533f58b` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/ARCHIVES/FULL_SYNC_FINAL_20261101.tar.gz) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/ARCHIVES/FULL_SYNC_FINAL_20261101.tar.gz)` | `CLAIMED-UNVERIFIED` (Streamed & CRC-checked in memory; payload claims unverified) |
| 2 | `Bot/Reports/RepairHandoff/ARCHIVES/GITHUB_ACTIONS_FIX.tar.gz` | `tracked` | 1,086 | `a8751f7362b4d60c4401476a39a5713c26d414706cf48c033e0040c35879d55d` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/ARCHIVES/GITHUB_ACTIONS_FIX.tar.gz) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/ARCHIVES/GITHUB_ACTIONS_FIX.tar.gz)` | `CLAIMED-UNVERIFIED` (Streamed & CRC-checked in memory; payload claims unverified) |
| 3 | `Bot/Reports/RepairHandoff/ARCHIVES/GITHUB_SYNC_20261101.tar.gz` | `tracked` | 1,401 | `e0c44c7b014c7427514a21264e0cb80743a8ec234472fa0d47ddadb42d408130` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/ARCHIVES/GITHUB_SYNC_20261101.tar.gz) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/ARCHIVES/GITHUB_SYNC_20261101.tar.gz)` | `CLAIMED-UNVERIFIED` (Streamed & CRC-checked in memory; payload claims unverified) |
| 4 | `Bot/Reports/RepairHandoff/ARCHIVES/LIVE_OPERATIONAL_VERIFICATION.zip` | `tracked` | 126,814 | `b48b454e9d561e9004c50274aadb8c1408335a0472753bad40a1d324a0a6d948` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/ARCHIVES/LIVE_OPERATIONAL_VERIFICATION.zip) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/ARCHIVES/LIVE_OPERATIONAL_VERIFICATION.zip)` | `CLAIMED-UNVERIFIED` (Streamed & CRC-checked in memory; payload claims unverified) |
| 5 | `Bot/Reports/RepairHandoff/ARCHIVES/PHASE_P1.zip` | `tracked` | 200,372 | `68352606edc1a8e94ad162c41f51a0a2d867a3a29a1ec6dc9dc78438788348f4` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/ARCHIVES/PHASE_P1.zip) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/ARCHIVES/PHASE_P1.zip)` | `CLAIMED-UNVERIFIED` (Streamed & CRC-checked in memory; payload claims unverified) |
| 6 | `Bot/Reports/RepairHandoff/ARCHIVES/PHASE_P1_ROUND4.zip` | `tracked` | 246,270 | `08d69450d8bfcd4133d91f1e05780b1408d0dc57417fbcae367336bda5d68fd0` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/ARCHIVES/PHASE_P1_ROUND4.zip) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/ARCHIVES/PHASE_P1_ROUND4.zip)` | `CLAIMED-UNVERIFIED` (Streamed & CRC-checked in memory; payload claims unverified) |
| 7 | `Bot/Reports/RepairHandoff/ARCHIVES/PHASE_P2.zip` | `tracked` | 113,489 | `a20b99dc24bbd080d08015426ccf6666e1d214a76d120380659c78aeb52d51da` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/ARCHIVES/PHASE_P2.zip) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/ARCHIVES/PHASE_P2.zip)` | `CLAIMED-UNVERIFIED` (Streamed & CRC-checked in memory; payload claims unverified) |
| 8 | `Bot/Reports/RepairHandoff/ARCHIVES/ROUND3_EVIDENCE.zip` | `tracked` | 221,155 | `2f19b1b9f9da657dd19fdd0b928e4cc367d2565edf33425c8dc6556f078ba755` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/ARCHIVES/ROUND3_EVIDENCE.zip) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/ARCHIVES/ROUND3_EVIDENCE.zip)` | `CLAIMED-UNVERIFIED` (Streamed & CRC-checked in memory; payload claims unverified) |
| 9 | `Bot/Reports/RepairHandoff/ARCHIVES/ROUND4_EVIDENCE.zip` | `tracked` | 90,244 | `f30e989cfd05b608095485a4b39d91320953ddfe29ba45ce5d98605218393fb7` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/ARCHIVES/ROUND4_EVIDENCE.zip) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/ARCHIVES/ROUND4_EVIDENCE.zip)` | `CLAIMED-UNVERIFIED` (Streamed & CRC-checked in memory; payload claims unverified) |
| 10 | `Bot/Reports/RepairHandoff/ARCHIVES/STRUCTURE_REORGANIZATION.zip` | `tracked` | 1,334,697 | `88e4c63b662b375ce2f8f389f0d670066b5b74946f6991a6977a0e9f2177d65a` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/Reports/RepairHandoff/ARCHIVES/STRUCTURE_REORGANIZATION.zip) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/ARCHIVES/STRUCTURE_REORGANIZATION.zip)` | `CLAIMED-UNVERIFIED` (Streamed & CRC-checked in memory; payload claims unverified) |
| 11 | `Bot/Reports/RepairHandoff/Round12_M13_Evidence.zip` | `untracked_gitignored` | 96,626 | `dac042240898441fb3c2d4eb72a15ae9c3e11068aec86e3a0014134f8fb0c66f` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/Round12_M13_Evidence.zip)` | `CLAIMED-UNVERIFIED` (Streamed & CRC-checked in memory; payload claims unverified) |
| 12 | `Bot/Reports/RepairHandoff/Round13_M14_Evidence.zip` | `untracked_gitignored` | 92,192 | `b7d6602e0eac92b348afdd07c7814d311f688d123a9af3c29773de0456f06d27` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/Round13_M14_Evidence.zip)` | `CLAIMED-UNVERIFIED` (Streamed & CRC-checked in memory; payload claims unverified) |
| 13 | `Bot/Reports/RepairHandoff/YJAutoPostOnX_PostMerge_M8_Rotation_And_Panel_Fixes.zip` | `untracked_gitignored` | 77,128 | `fa6df431e6af003d3d56e6085fa04d76ffe2b1d6fe96db0b46d4f0ccfcf6a516` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/YJAutoPostOnX_PostMerge_M8_Rotation_And_Panel_Fixes.zip)` | `CLAIMED-UNVERIFIED` (Streamed & CRC-checked in memory; payload claims unverified) |
| 14 | `Bot/Reports/RepairHandoff/YJAutoPostOnX_Round10_M11_Forensic_Integrity_Evidence.zip` | `untracked_gitignored` | 65,196 | `29e56128a1599c7d6bee16d1223d153ee80a10185e5babeae12456648b4ab531` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/YJAutoPostOnX_Round10_M11_Forensic_Integrity_Evidence.zip)` | `CLAIMED-UNVERIFIED` (Streamed & CRC-checked in memory; payload claims unverified) |
| 15 | `Bot/Reports/RepairHandoff/YJAutoPostOnX_Round11_M12_Forensic_Recovery_And_Safety_Evidence.zip` | `untracked_gitignored` | 81,485 | `d08556bbc5c49cacb76c1ec2fdfc81c793e0738cee0f12162617dbc85209786f` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/YJAutoPostOnX_Round11_M12_Forensic_Recovery_And_Safety_Evidence.zip)` | `CLAIMED-UNVERIFIED` (Streamed & CRC-checked in memory; payload claims unverified) |
| 16 | `Bot/Reports/RepairHandoff/YJAutoPostOnX_Round5_Delegates_Evidence.zip` | `untracked_gitignored` | 63,558 | `44be7d356eb1e102b8911f5e5b185269b763c3ab50646b0f699a638973205969` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/YJAutoPostOnX_Round5_Delegates_Evidence.zip)` | `CLAIMED-UNVERIFIED` (Streamed & CRC-checked in memory; payload claims unverified) |
| 17 | `Bot/Reports/RepairHandoff/YJAutoPostOnX_Round6_M8_Final_Evidence.zip` | `untracked_gitignored` | 72,197 | `fe273d68e420c3166bef24680db835cf538e95985b084ac00f40c337e84de0ae` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/YJAutoPostOnX_Round6_M8_Final_Evidence.zip)` | `CLAIMED-UNVERIFIED` (Streamed & CRC-checked in memory; payload claims unverified) |
| 18 | `Bot/Reports/RepairHandoff/YJAutoPostOnX_Round7_Real_Telegram_Run_Evidence.zip` | `untracked_gitignored` | 90,865 | `8c09667a2fa631b1380899d1f141dbe49d35ef1f4c70ecc195fb04e78d783c96` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/YJAutoPostOnX_Round7_Real_Telegram_Run_Evidence.zip)` | `CLAIMED-UNVERIFIED` (Streamed & CRC-checked in memory; payload claims unverified) |
| 19 | `Bot/Reports/RepairHandoff/YJAutoPostOnX_Round8_M10_Complete_Journal_And_Audit_Evidence.zip` | `untracked_gitignored` | 55,566 | `7d6a42021eb47bc6decabdb1934ed872360cdae2039a98a6b28c68adb821659c` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/YJAutoPostOnX_Round8_M10_Complete_Journal_And_Audit_Evidence.zip)` | `CLAIMED-UNVERIFIED` (Streamed & CRC-checked in memory; payload claims unverified) |
| 20 | `Bot/Reports/RepairHandoff/YJAutoPostOnX_Round8_M10_Live_Production_Evidence.zip` | `untracked_gitignored` | 52,379 | `42471074739df02fbd20874edeb13c7bf2105af735c11674e9fac4e2adc43b54` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/YJAutoPostOnX_Round8_M10_Live_Production_Evidence.zip)` | `CLAIMED-UNVERIFIED` (Streamed & CRC-checked in memory; payload claims unverified) |
| 21 | `Bot/Reports/RepairHandoff/YJAutoPostOnX_Round9_M11_RootCause_And_TODO_Sync_Evidence.zip` | `untracked_gitignored` | 59,794 | `a5177bd15b3423c2917f605d70f5069e4a41f6efd4fdfd152c31f1e2d225cacc` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/Reports/RepairHandoff/YJAutoPostOnX_Round9_M11_RootCause_And_TODO_Sync_Evidence.zip)` | `CLAIMED-UNVERIFIED` (Streamed & CRC-checked in memory; payload claims unverified) |

### 2.4.1 Streamed Archive Member & Payload Summary (`archive-evidence-index.md`)

# Historical archive metadata index — 2026-11-04

Read-only metadata enumeration; no extraction or delivery. Member names treated as untrusted and not printed. Raw contents, secrets, uniqueness of requirements, cryptographic authenticity and restoration are NOT inspected. Hashes fingerprint current archive bytes, not prior provenance.

## RepairHandoff/ARCHIVES/FULL_SYNC_FINAL_20261101.tar.gz

- SHA-256: `362cb95a376ef43a4f9046e6779c2de82546b7d1993883225b865fefd533f58b`; compressed bytes: 2769; entries: 5; regular/non-directory entries: 3; declared uncompressed bytes: 6136.
- Name-based categories (not verified contents): {'log_or_jsonl': 0, 'test_or_fixture': 0, 'report_or_plan': 2, 'nested_archive': 0}; absolute/traversal-looking paths: 0; link entries: 0.
- Integrity/content/secret scan and unique-requirement reconciliation: NOT_INSPECTED.

## RepairHandoff/ARCHIVES/GITHUB_ACTIONS_FIX.tar.gz

- SHA-256: `a8751f7362b4d60c4401476a39a5713c26d414706cf48c033e0040c35879d55d`; compressed bytes: 1086; entries: 2; regular/non-directory entries: 1; declared uncompressed bytes: 1630.
- Name-based categories (not verified contents): {'log_or_jsonl': 0, 'test_or_fixture': 0, 'report_or_plan': 1, 'nested_archive': 0}; absolute/traversal-looking paths: 0; link entries: 0.
- Integrity/content/secret scan and unique-requirement reconciliation: NOT_INSPECTED.

## RepairHandoff/ARCHIVES/GITHUB_SYNC_20261101.tar.gz

- SHA-256: `e0c44c7b014c7427514a21264e0cb80743a8ec234472fa0d47ddadb42d408130`; compressed bytes: 1401; entries: 2; regular/non-directory entries: 1; declared uncompressed bytes: 2508.
- Name-based categories (not verified contents): {'log_or_jsonl': 0, 'test_or_fixture': 0, 'report_or_plan': 1, 'nested_archive': 0}; absolute/traversal-looking paths: 0; link entries: 0.
- Integrity/content/secret scan and unique-requirement reconciliation: NOT_INSPECTED.

## RepairHandoff/ARCHIVES/LIVE_OPERATIONAL_VERIFICATION.zip

- SHA-256: `b48b454e9d561e9004c50274aadb8c1408335a0472753bad40a1d324a0a6d948`; compressed bytes: 126814; entries: 24; regular/non-directory entries: 24; declared uncompressed bytes: 408650.
- Name-based categories (not verified contents): {'log_or_jsonl': 1, 'test_or_fixture': 9, 'report_or_plan': 9, 'nested_archive': 0}; absolute/traversal-looking paths: 0; link entries: 0.
- Integrity/content/secret scan and unique-requirement reconciliation: NOT_INSPECTED.

## RepairHandoff/ARCHIVES/PHASE_P1.zip

- SHA-256: `68352606edc1a8e94ad162c41f51a0a2d867a3a29a1ec6dc9dc78438788348f4`; compressed bytes: 200372; entries: 24; regular/non-directory entries: 24; declared uncompressed bytes: 905913.
- Name-based categories (not verified contents): {'log_or_jsonl': 0, 'test_or_fixture': 9, 'report_or_plan': 6, 'nested_archive': 0}; absolute/traversal-looking paths: 0; link entries: 0.
- Integrity/content/secret scan and unique-requirement reconciliation: NOT_INSPECTED.

## RepairHandoff/ARCHIVES/PHASE_P1_ROUND4.zip

- SHA-256: `08d69450d8bfcd4133d91f1e05780b1408d0dc57417fbcae367336bda5d68fd0`; compressed bytes: 246270; entries: 27; regular/non-directory entries: 27; declared uncompressed bytes: 1167093.
- Name-based categories (not verified contents): {'log_or_jsonl': 0, 'test_or_fixture': 13, 'report_or_plan': 8, 'nested_archive': 0}; absolute/traversal-looking paths: 0; link entries: 0.
- Integrity/content/secret scan and unique-requirement reconciliation: NOT_INSPECTED.

## RepairHandoff/ARCHIVES/PHASE_P2.zip

- SHA-256: `a20b99dc24bbd080d08015426ccf6666e1d214a76d120380659c78aeb52d51da`; compressed bytes: 113489; entries: 23; regular/non-directory entries: 23; declared uncompressed bytes: 382399.
- Name-based categories (not verified contents): {'log_or_jsonl': 0, 'test_or_fixture': 9, 'report_or_plan': 4, 'nested_archive': 0}; absolute/traversal-looking paths: 0; link entries: 0.
- Integrity/content/secret scan and unique-requirement reconciliation: NOT_INSPECTED.

## RepairHandoff/ARCHIVES/ROUND3_EVIDENCE.zip

- SHA-256: `2f19b1b9f9da657dd19fdd0b928e4cc367d2565edf33425c8dc6556f078ba755`; compressed bytes: 221155; entries: 31; regular/non-directory entries: 31; declared uncompressed bytes: 776535.
- Name-based categories (not verified contents): {'log_or_jsonl': 0, 'test_or_fixture': 9, 'report_or_plan': 7, 'nested_archive': 0}; absolute/traversal-looking paths: 0; link entries: 0.
- Integrity/content/secret scan and unique-requirement reconciliation: NOT_INSPECTED.

## RepairHandoff/ARCHIVES/ROUND4_EVIDENCE.zip

- SHA-256: `f30e989cfd05b608095485a4b39d91320953ddfe29ba45ce5d98605218393fb7`; compressed bytes: 90244; entries: 13; regular/non-directory entries: 13; declared uncompressed bytes: 283974.
- Name-based categories (not verified contents): {'log_or_jsonl': 0, 'test_or_fixture': 1, 'report_or_plan': 4, 'nested_archive': 0}; absolute/traversal-looking paths: 0; link entries: 0.
- Integrity/content/secret scan and unique-requirement reconciliation: NOT_INSPECTED.

## RepairHandoff/ARCHIVES/STRUCTURE_REORGANIZATION.zip

- SHA-256: `88e4c63b662b375ce2f8f389f0d670066b5b74946f6991a6977a0e9f2177d65a`; compressed bytes: 1334697; entries: 11; regular/non-directory entries: 11; declared uncompressed bytes: 5853227.
- Name-based categories (not verified contents): {'log_or_jsonl': 0, 'test_or_fixture': 1, 'report_or_plan': 2, 'nested_archive': 0}; absolute/traversal-looking paths: 0; link entries: 0.
- Integrity/content/secret scan and unique-requirement reconciliation: NOT_INSPECTED.

## RepairHandoff/Round12_M13_Evidence.zip

- SHA-256: `dac042240898441fb3c2d4eb72a15ae9c3e11068aec86e3a0014134f8fb0c66f`; compressed bytes: 96626; entries: 16; regular/non-directory entries: 16; declared uncompressed bytes: 298191.
- Name-based categories (not verified contents): {'log_or_jsonl': 0, 'test_or_fixture': 0, 'report_or_plan': 5, 'nested_archive': 0}; absolute/traversal-looking paths: 0; link entries: 0.
- Integrity/content/secret scan and unique-requirement reconciliation: NOT_INSPECTED.

## RepairHandoff/Round13_M14_Evidence.zip

- SHA-256: `b7d6602e0eac92b348afdd07c7814d311f688d123a9af3c29773de0456f06d27`; compressed bytes: 92192; entries: 14; regular/non-directory entries: 14; declared uncompressed bytes: 270982.
- Name-based categories (not verified contents): {'log_or_jsonl': 0, 'test_or_fixture': 1, 'report_or_plan': 6, 'nested_archive': 0}; absolute/traversal-looking paths: 0; link entries: 0.
- Integrity/content/secret scan and unique-requirement reconciliation: NOT_INSPECTED.

## RepairHandoff/YJAutoPostOnX_PostMerge_M8_Rotation_And_Panel_Fixes.zip

- SHA-256: `fa6df431e6af003d3d56e6085fa04d76ffe2b1d6fe96db0b46d4f0ccfcf6a516`; compressed bytes: 77128; entries: 7; regular/non-directory entries: 7; declared uncompressed bytes: 288624.
- Name-based categories (not verified contents): {'log_or_jsonl': 0, 'test_or_fixture': 1, 'report_or_plan': 1, 'nested_archive': 0}; absolute/traversal-looking paths: 0; link entries: 0.
- Integrity/content/secret scan and unique-requirement reconciliation: NOT_INSPECTED.

## RepairHandoff/YJAutoPostOnX_Round10_M11_Forensic_Integrity_Evidence.zip

- SHA-256: `29e56128a1599c7d6bee16d1223d153ee80a10185e5babeae12456648b4ab531`; compressed bytes: 65196; entries: 10; regular/non-directory entries: 10; declared uncompressed bytes: 200828.
- Name-based categories (not verified contents): {'log_or_jsonl': 0, 'test_or_fixture': 0, 'report_or_plan': 4, 'nested_archive': 0}; absolute/traversal-looking paths: 0; link entries: 0.
- Integrity/content/secret scan and unique-requirement reconciliation: NOT_INSPECTED.

## RepairHandoff/YJAutoPostOnX_Round11_M12_Forensic_Recovery_And_Safety_Evidence.zip

- SHA-256: `d08556bbc5c49cacb76c1ec2fdfc81c793e0738cee0f12162617dbc85209786f`; compressed bytes: 81485; entries: 13; regular/non-directory entries: 13; declared uncompressed bytes: 262965.
- Name-based categories (not verified contents): {'log_or_jsonl': 0, 'test_or_fixture': 1, 'report_or_plan': 4, 'nested_archive': 0}; absolute/traversal-looking paths: 0; link entries: 0.
- Integrity/content/secret scan and unique-requirement reconciliation: NOT_INSPECTED.

## RepairHandoff/YJAutoPostOnX_Round5_Delegates_Evidence.zip

- SHA-256: `44be7d356eb1e102b8911f5e5b185269b763c3ab50646b0f699a638973205969`; compressed bytes: 63558; entries: 6; regular/non-directory entries: 6; declared uncompressed bytes: 171173.
- Name-based categories (not verified contents): {'log_or_jsonl': 0, 'test_or_fixture': 0, 'report_or_plan': 5, 'nested_archive': 0}; absolute/traversal-looking paths: 0; link entries: 0.
- Integrity/content/secret scan and unique-requirement reconciliation: NOT_INSPECTED.

## RepairHandoff/YJAutoPostOnX_Round6_M8_Final_Evidence.zip

- SHA-256: `fe273d68e420c3166bef24680db835cf538e95985b084ac00f40c337e84de0ae`; compressed bytes: 72197; entries: 15; regular/non-directory entries: 15; declared uncompressed bytes: 255999.
- Name-based categories (not verified contents): {'log_or_jsonl': 1, 'test_or_fixture': 1, 'report_or_plan': 3, 'nested_archive': 0}; absolute/traversal-looking paths: 0; link entries: 0.
- Integrity/content/secret scan and unique-requirement reconciliation: NOT_INSPECTED.

## RepairHandoff/YJAutoPostOnX_Round7_Real_Telegram_Run_Evidence.zip

- SHA-256: `8c09667a2fa631b1380899d1f141dbe49d35ef1f4c70ecc195fb04e78d783c96`; compressed bytes: 90865; entries: 8; regular/non-directory entries: 8; declared uncompressed bytes: 724234.
- Name-based categories (not verified contents): {'log_or_jsonl': 2, 'test_or_fixture': 0, 'report_or_plan': 1, 'nested_archive': 0}; absolute/traversal-looking paths: 0; link entries: 0.
- Integrity/content/secret scan and unique-requirement reconciliation: NOT_INSPECTED.

## RepairHandoff/YJAutoPostOnX_Round8_M10_Complete_Journal_And_Audit_Evidence.zip

- SHA-256: `7d6a42021eb47bc6decabdb1934ed872360cdae2039a98a6b28c68adb821659c`; compressed bytes: 55566; entries: 7; regular/non-directory entries: 7; declared uncompressed bytes: 623108.
- Name-based categories (not verified contents): {'log_or_jsonl': 2, 'test_or_fixture': 1, 'report_or_plan': 1, 'nested_archive': 0}; absolute/traversal-looking paths: 0; link entries: 0.
- Integrity/content/secret scan and unique-requirement reconciliation: NOT_INSPECTED.

## RepairHandoff/YJAutoPostOnX_Round8_M10_Live_Production_Evidence.zip

- SHA-256: `42471074739df02fbd20874edeb13c7bf2105af735c11674e9fac4e2adc43b54`; compressed bytes: 52379; entries: 6; regular/non-directory entries: 6; declared uncompressed bytes: 535561.
- Name-based categories (not verified contents): {'log_or_jsonl': 2, 'test_or_fixture': 0, 'report_or_plan': 1, 'nested_archive': 0}; absolute/traversal-looking paths: 0; link entries: 0.
- Integrity/content/secret scan and unique-requirement reconciliation: NOT_INSPECTED.

## RepairHandoff/YJAutoPostOnX_Round9_M11_RootCause_And_TODO_Sync_Evidence.zip

- SHA-256: `a5177bd15b3423c2917f605d70f5069e4a41f6efd4fdfd152c31f1e2d225cacc`; compressed bytes: 59794; entries: 8; regular/non-directory entries: 8; declared uncompressed bytes: 185423.
- Name-based categories (not verified contents): {'log_or_jsonl': 0, 'test_or_fixture': 0, 'report_or_plan': 4, 'nested_archive': 0}; absolute/traversal-looking paths: 0; link entries: 0.
- Integrity/content/secret scan and unique-requirement reconciliation: NOT_INSPECTED.

## Exceptions and limits

21 archives enumerated (18 ZIP, 3 tar.gz). Classification is based on names only; a count of zero does not prove absence of evidence or sensitive data. Archive entries may contain secrets or private records. No archive member was extracted, CRC-tested, decrypted, restored, independently traced to original reports, or read for unique requirements. Nested archives remain entirely uninspected. Do not delete original artifacts or assume this index is a validated backup.

## Streaming decompression and payload classification

Each regular member was streamed without extraction or output, SHA-256 hashed in memory, and ZIP CRC checked by Python zipfile on complete reads. No secrets or personal records were printed. Classification uses filenames, not semantic verification. Archive member paths were not used to write files.

- `RepairHandoff/ARCHIVES/FULL_SYNC_FINAL_20261101.tar.gz`: streamed 3 regular members, 6136 bytes; distinct payload hashes 3, candidate report/manifest hashes 2, log/journal hashes 0, filename risk labels none identified; errors 0.
- `RepairHandoff/ARCHIVES/GITHUB_ACTIONS_FIX.tar.gz`: streamed 1 regular members, 1630 bytes; distinct payload hashes 1, candidate report/manifest hashes 1, log/journal hashes 0, filename risk labels none identified; errors 0.
- `RepairHandoff/ARCHIVES/GITHUB_SYNC_20261101.tar.gz`: streamed 1 regular members, 2508 bytes; distinct payload hashes 1, candidate report/manifest hashes 1, log/journal hashes 0, filename risk labels none identified; errors 0.
- `RepairHandoff/ARCHIVES/LIVE_OPERATIONAL_VERIFICATION.zip`: streamed 24 regular members, 408650 bytes; distinct payload hashes 22, candidate report/manifest hashes 7, log/journal hashes 1, filename risk labels docker, recovery, sqlite, vpn; errors 0.
- `RepairHandoff/ARCHIVES/PHASE_P1.zip`: streamed 24 regular members, 905913 bytes; distinct payload hashes 24, candidate report/manifest hashes 5, log/journal hashes 0, filename risk labels none identified; errors 0.
- `RepairHandoff/ARCHIVES/PHASE_P1_ROUND4.zip`: streamed 27 regular members, 1167093 bytes; distinct payload hashes 26, candidate report/manifest hashes 6, log/journal hashes 0, filename risk labels none identified; errors 0.
- `RepairHandoff/ARCHIVES/PHASE_P2.zip`: streamed 23 regular members, 382399 bytes; distinct payload hashes 23, candidate report/manifest hashes 3, log/journal hashes 0, filename risk labels docker, telegram, vpn; errors 0.
- `RepairHandoff/ARCHIVES/ROUND3_EVIDENCE.zip`: streamed 31 regular members, 776535 bytes; distinct payload hashes 28, candidate report/manifest hashes 4, log/journal hashes 0, filename risk labels telegram; errors 0.
- `RepairHandoff/ARCHIVES/ROUND4_EVIDENCE.zip`: streamed 13 regular members, 283974 bytes; distinct payload hashes 13, candidate report/manifest hashes 4, log/journal hashes 0, filename risk labels recovery, vpn; errors 0.
- `RepairHandoff/ARCHIVES/STRUCTURE_REORGANIZATION.zip`: streamed 11 regular members, 5853227 bytes; distinct payload hashes 11, candidate report/manifest hashes 2, log/journal hashes 0, filename risk labels none identified; errors 0.
- `RepairHandoff/Round12_M13_Evidence.zip`: streamed 16 regular members, 298191 bytes; distinct payload hashes 16, candidate report/manifest hashes 5, log/journal hashes 0, filename risk labels ambiguous, recovery, session, sqlite; errors 0.
- `RepairHandoff/Round13_M14_Evidence.zip`: streamed 14 regular members, 270982 bytes; distinct payload hashes 14, candidate report/manifest hashes 6, log/journal hashes 0, filename risk labels ambiguous, captcha, outbox, recovery, session, sqlite; errors 0.
- `RepairHandoff/YJAutoPostOnX_PostMerge_M8_Rotation_And_Panel_Fixes.zip`: streamed 7 regular members, 288624 bytes; distinct payload hashes 7, candidate report/manifest hashes 1, log/journal hashes 0, filename risk labels telegram; errors 0.
- `RepairHandoff/YJAutoPostOnX_Round10_M11_Forensic_Integrity_Evidence.zip`: streamed 10 regular members, 200828 bytes; distinct payload hashes 10, candidate report/manifest hashes 4, log/journal hashes 0, filename risk labels ambiguous, recovery; errors 0.
- `RepairHandoff/YJAutoPostOnX_Round11_M12_Forensic_Recovery_And_Safety_Evidence.zip`: streamed 13 regular members, 262965 bytes; distinct payload hashes 13, candidate report/manifest hashes 4, log/journal hashes 0, filename risk labels ambiguous, recovery, sqlite; errors 0.
- `RepairHandoff/YJAutoPostOnX_Round5_Delegates_Evidence.zip`: streamed 6 regular members, 171173 bytes; distinct payload hashes 6, candidate report/manifest hashes 5, log/journal hashes 0, filename risk labels none identified; errors 0.
- `RepairHandoff/YJAutoPostOnX_Round6_M8_Final_Evidence.zip`: streamed 15 regular members, 255999 bytes; distinct payload hashes 15, candidate report/manifest hashes 3, log/journal hashes 1, filename risk labels telegram, vpn; errors 0.
- `RepairHandoff/YJAutoPostOnX_Round7_Real_Telegram_Run_Evidence.zip`: streamed 8 regular members, 724234 bytes; distinct payload hashes 8, candidate report/manifest hashes 1, log/journal hashes 2, filename risk labels telegram; errors 0.
- `RepairHandoff/YJAutoPostOnX_Round8_M10_Complete_Journal_And_Audit_Evidence.zip`: streamed 7 regular members, 623108 bytes; distinct payload hashes 7, candidate report/manifest hashes 1, log/journal hashes 2, filename risk labels latency; errors 0.
- `RepairHandoff/YJAutoPostOnX_Round8_M10_Live_Production_Evidence.zip`: streamed 6 regular members, 535561 bytes; distinct payload hashes 6, candidate report/manifest hashes 1, log/journal hashes 2, filename risk labels latency; errors 0.
- `RepairHandoff/YJAutoPostOnX_Round9_M11_RootCause_And_TODO_Sync_Evidence.zip`: streamed 8 regular members, 185423 bytes; distinct payload hashes 8, candidate report/manifest hashes 4, log/journal hashes 0, filename risk labels ambiguous, recovery; errors 0.

Payload hashes were used only to count duplicate bytes within each archive; they do not prove a report is unique across the project or that its claims/requirements were transferred. Filenames can understate content. No semantic review, redaction, nested archive recursion, malware analysis, file permissions restoration, or restore drill was performed. Streaming success proves decompression/ZIP CRC for members read, not authenticity or safety.


---

## 2.5 Repo-Root Duplicate Files & Stray Artifacts Retired in Phase 3

| # | Repo-Root Duplicate / Stray File Path | Git Status | Bytes | Full SHA-256 | Off-Repo Backup Archive Pointer | Verified Restore Command |
|---:|---|---|---:|---|---|---|
| 1 | `MASTER_TODO.md` | `tracked` | 30,439 | `02203ea7adc78526081392bd2dce7c06876ff0af25ec449e397596db046344a8` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: MASTER_TODO.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/MASTER_TODO.md)` | `tar --zstd -xf /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst -C /root/Projects/YJAutoPostOnX 'MASTER_TODO.md' && echo '02203ea7adc78526081392bd2dce7c06876ff0af25ec449e397596db046344a8  /root/Projects/YJAutoPostOnX/MASTER_TODO.md' | sha256sum -c -` |
| 2 | `PROGRESS_HISTORY.md` | `tracked` | 62,550 | `f740fbbab5d4f756005940aa133dcba3dc064cb4caacf47efc8ab698c26de378` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: PROGRESS_HISTORY.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/PROGRESS_HISTORY.md)` | `tar --zstd -xf /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst -C /root/Projects/YJAutoPostOnX 'PROGRESS_HISTORY.md' && echo 'f740fbbab5d4f756005940aa133dcba3dc064cb4caacf47efc8ab698c26de378  /root/Projects/YJAutoPostOnX/PROGRESS_HISTORY.md' | sha256sum -c -` |
| 3 | `RESOURCE_CLEANUP_REPORT.md` | `tracked` | 9,258 | `6eb97609eece217cb823f7c60df031149ae98dd7b62d5a122f2dea3f7a422bff` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: RESOURCE_CLEANUP_REPORT.md) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/RESOURCE_CLEANUP_REPORT.md)` | `tar --zstd -xf /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst -C /root/Projects/YJAutoPostOnX 'RESOURCE_CLEANUP_REPORT.md' && echo '6eb97609eece217cb823f7c60df031149ae98dd7b62d5a122f2dea3f7a422bff  /root/Projects/YJAutoPostOnX/RESOURCE_CLEANUP_REPORT.md' | sha256sum -c -` |
| 4 | `PROJECT.md` | `untracked_gitignored` | 10,706 | `b693b4116e5f0d5900b1a4a88e93b661bc934f16ec5f68a8ddb117831ef29fee` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/PROJECT.md)` | `tar --zstd -xf /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst --strip-components=1 -C /root/Projects/YJAutoPostOnX 'YJAutoPostOnX/PROJECT.md' && echo 'b693b4116e5f0d5900b1a4a88e93b661bc934f16ec5f68a8ddb117831ef29fee  /root/Projects/YJAutoPostOnX/PROJECT.md' | sha256sum -c -` |
| 5 | `ARCHIVES/LIVE_OPERATIONAL_VERIFICATION.zip` | `tracked` | 126,814 | `b48b454e9d561e9004c50274aadb8c1408335a0472753bad40a1d324a0a6d948` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: ARCHIVES/LIVE_OPERATIONAL_VERIFICATION.zip) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/ARCHIVES/LIVE_OPERATIONAL_VERIFICATION.zip)` | `tar --zstd -xf /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst -C /root/Projects/YJAutoPostOnX 'ARCHIVES/LIVE_OPERATIONAL_VERIFICATION.zip' && echo 'b48b454e9d561e9004c50274aadb8c1408335a0472753bad40a1d324a0a6d948  /root/Projects/YJAutoPostOnX/ARCHIVES/LIVE_OPERATIONAL_VERIFICATION.zip' | sha256sum -c -` |
| 6 | `ARCHIVES/ROUND3_EVIDENCE.zip` | `tracked` | 221,155 | `2f19b1b9f9da657dd19fdd0b928e4cc367d2565edf33425c8dc6556f078ba755` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: ARCHIVES/ROUND3_EVIDENCE.zip) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/ARCHIVES/ROUND3_EVIDENCE.zip)` | `tar --zstd -xf /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst -C /root/Projects/YJAutoPostOnX 'ARCHIVES/ROUND3_EVIDENCE.zip' && echo '2f19b1b9f9da657dd19fdd0b928e4cc367d2565edf33425c8dc6556f078ba755  /root/Projects/YJAutoPostOnX/ARCHIVES/ROUND3_EVIDENCE.zip' | sha256sum -c -` |
| 7 | `Bot/state.sqlite` | `untracked_gitignored` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/state.sqlite)` | `tar --zstd -xf /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst --strip-components=1 -C /root/Projects/YJAutoPostOnX 'YJAutoPostOnX/Bot/state.sqlite' && echo 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  /root/Projects/YJAutoPostOnX/Bot/state.sqlite' | sha256sum -c -` |


---

# Section 3: Complete Original 53-Item Mapping (`33 FINDING-001..033` + `20 ADD-P1-01..ADD-P6-04`) & Legacy `P1`–`P6` References with Current Classifications

## 3.1 Legacy `P1`–`P6` Numbering & Terminology Crosswalk

Across the 72 historical reports (`09_REPAIR_ROADMAP.md`, `MASTER_TODO.md`, `P1_P6_ORIGINAL_PLAN_GAP_REGISTER_2026-11-03.md`), two overlapping `P1`–`P6` numbering schemes were used historically. Both are reconciled below and mapped into the unified post-audit **`P01`–`P08`** engineering phases (Section 5):

| Legacy Phase Label | Historical `MASTER_TODO.md` Scope (`P1`–`P4` Severity/Wave) | Historical `P1_P6_ORIGINAL_PLAN_GAP_REGISTER` Scope (`ADD-P1`..`ADD-P6`) | Post-Audit Unified Phase Mapping (`P01`–`P08`) |
|---|---|---|---|
| **Legacy `P1`** | Publishing Safety Fence (`FINDING-001`, `002`, `003`, `009`, `011`, `026`) | Ambiguous Quarantine, Post-Dispatch Fencing & Attempt Counting (`ADD-P1-01`..`ADD-P1-04`) | **`P01`** (`P01-T01`, `P01-T04`), **`P02`** (`P02-T02`..`P02-T05`), **`P08`** (`P08-T01`) |
| **Legacy `P2`** | Concurrency, Telegram 409, Identity, Env & Docker (`FINDING-004`, `005`, `007`, `008`, `010`, `012`, `015`, `016`, `018`, `020`, `021`, `031`) | Dual-Chat Panel Sync, Latency Telemetry & CSV Export Receipts (`ADD-P2-01`..`ADD-P2-03`) | **`P01`** (`P01-T05`), **`P02`** (`P02-T01`, `P02-T06`), **`P04`** (`P04-T01`..`P04-T03`), **`P05`** (`P05-T01`, `P05-T02`) |
| **Legacy `P3`** | SQLite OCC, Sync Tx, Alerts, Scheduler, Cookies & Tables (`FINDING-006`, `014`, `017`, `019`, `022`, `023`, `024`, `025`, `027`) | Non-Blocking SQLite Reads, Failure Diagnostics & Multi-Round Endurance (`ADD-P3-01`..`ADD-P3-03`) | **`P01`** (`P01-T01`..`P01-T03`), **`P02`** (`P02-T05`), **`P03`** (`P03-T01`..`P03-T04`), **`P05`** (`P05-T01`, `P05-T02`) |
| **Legacy `P4`** | Forensic Logging, Riyadh Quota & AppImage Content Engine (`FINDING-013`, `028`, `029`, `030`, `032`, `033`) | Twikit `urls` Patch, GraphQL Error Propagation, `186`/`187` Strike Exemption & 5-VPN Stability (`ADD-P4-01`..`ADD-P4-04`) | **`P01`** (`P01-T03`, `P01-T05`), **`P02`** (`P02-T04`..`P02-T06`), **`P04`** (`P04-T01`, `P04-T02`), **`P07`** (`P07-T01`) |
| **Legacy `P5`** | Content Engine Optimization (`09_REPAIR_ROADMAP.md`) | Pre-Dispatch Length (`186`) & Duplicate (`187`) Prevention (`ADD-P5-01`, `ADD-P5-02`) | **`P02`** (`P02-T03`, `P02-T05`) |
| **Legacy `P6`** | Final Sign-Off & Governance | Forensic Log Sanitization, Full-Run Monitoring, Independent Audit & Issue #12 Sync (`ADD-P6-01`..`ADD-P6-04`) | **`P01`** (`P01-T02`, `P01-T03`, `P01-T05`), **`P06`** (`P06-T01`), **`P07`** (`P07-T01`), **`P08`** (`P08-T01`) |

---

## Part 2: Complete 53-Item Historical Classification Table (`33 FINDING` + `20 ADD`)

**Classification Taxonomy:**
- **`VERIFIED`**: The specific narrow code mechanism or static structure claimed exists in the current `f394756` checkout and was verified by direct line-by-line source inspection (and/or isolated synthetic probe) without contradicting defects. *(Note: where live operational endurance remains unrun under the read-only mandate, the narrow code verification is explicitly scoped.)*
- **`CONTRADICTED`**: The historical claim of a universal fix, zero-replay guarantee, or complete safety invariant is directly refuted by a concrete code defect or synthetic counterexample discovered in Phase 1.
- **`CLAIMED-UNVERIFIED`**: Historical reports claimed `TESTED_PASS` or `LIVE_EVIDENCE_REPORTED`, but either (a) the acceptance criteria require live X/Telegram/endurance execution or external owner/Codex sign-off not independently proven in this read-only audit, or (b) partial guards exist alongside unverified runtime paths.
- **`SUPERSEDED`**: A specific historical version/configuration claim was replaced by a newer state in `f394756`.

### 2.1 Historical `FINDING-001` through `FINDING-033` (33 Items)

| Historical ID | Original Claim Summary (`07_ALL_FINDINGS.md` / `MASTER_TODO.md`) | Historical Claimed Status | Phase 1 Audit Classification | Current Code & Forensic Evidence (`f394756`) |
|---|---|---|---|---|
| `FINDING-001` | Python transport fallback on `POST` (`curl_cffi` -> `httpx`) causing duplicate tweets | `TESTED_PASS` | **`CONTRADICTED`** | `Bot/python/direct_x_bridge.py:384–422` (`PY-RAW-02`) allows `httpx` fallback on `POST` if exception text contains unstructured substring `'before send'` or `'before any send'`, which does not prove zero bytes were sent over the socket. |
| `FINDING-002` | False `'verifiedNotPosted'` due to 2s timeline window & 40-char prefix matching | `TESTED_PASS` | **`CONTRADICTED`** | While prefix matching was replaced by full normalized text (`direct_x_bridge.py:195–225`), `is_recent_tweet()` (`:229–265`) accepts any matching same-author tweet created within the prior 30 minutes (`1800s`) without comparing tweet timestamp/Snowflake ID against `dispatch_started_at` (`XT-01`, proven via `x-synthetic-timeline.txt`). |
| `FINDING-003` | Runner `ambiguous`-to-`pending` loop causing replay storm | `TESTED_PASS` | **`CONTRADICTED`** | While `publishOutcome.js:5–10` quarantines post-dispatch failures when `dispatchEntered` is true, `SqliteStore.update()`'s CAS retry closure defect (`PERSIST-OBS-04`, `sqliteStore.js:237–262`, `runner.js:949–968`) can return `dispatchReady = true` and send `dispatch_ack` while SQLite retains `phase: 'claimed'`, which startup `recoverProcessing` (`queue.js:92–107`) reverts to `pending` after a crash. Furthermore, `Queue.requeue()` (`queue.js:19–22, 91`, `PERSIST-OBS-02` / `XT-04`) lacks a state guard blocking `ambiguous -> pending`. |
| `FINDING-004` | Telegram `409 Conflict` multi-instance polling | `TESTED_PASS` | **`CLAIMED-UNVERIFIED`** | `runner.js:25–131, 268–269` acquires a path-scoped lock and `:1603–1616` aborts after 3 consecutive `409` responses, and 24h journal scan showed `telegram_409: 0` (`audit-logs-resources.md`). However, two duplicate `SingleInstanceLock` classes exist (`RUN-01` / `ENTRY-RAW-01`), both tracked systemd units (`yj-telegram-bot.service` and `yj-telegram-bot.user.service`) exist on disk, and `runner.js:1624–1626` (`RUN-06` / `TR-07`) can skip lock release if early shutdown throws. |
| `FINDING-005` | Unconditional lock removal (`rm -f`) in systemd unit defeating singleton | `TESTED_PASS` | **`VERIFIED`** | Inspected `Bot/systemd/yj-telegram-bot.service:1–32`, `Bot/systemd/yj-telegram-bot.user.service:1–29`, and `Bot/systemd/telegram-bot-launcher.sh:1–39` (`audit-ci-appimage.md`): none contain unconditional lock file deletion in `ExecStartPre`/`ExecStopPost`. |
| `FINDING-006` | Single-row JSON write amplification in SQLite (`state.sqlite`) | `TESTED_PASS` | **`CLAIMED-UNVERIFIED`** | `Bot/src/sqliteStore.js:125–127` sets `PRAGMA journal_mode = WAL`, `synchronous = NORMAL`, and `wal_autocheckpoint = 1000`, but the single-row monolithic JSON blob architecture (`SELECT/UPDATE state WHERE id = 1`, `:166, 226–250`) remains unchanged, and `linkExports.js:112–123` (`UTIL-RAW-03`) appends unbounded suppressed terminal events into that JSON row. |
| `FINDING-007` | Bypassing account suspension check via `use_cache` cached numeric userId | `TESTED_PASS` | **`CONTRADICTED`** | `Bot/python/direct_x_bridge.py:516–547` (`PY-RAW-01`) still implements the `use_cache` fast-path (enabled by `directX.js:126` whenever `effectiveUserId` exists and `verifyNetwork` is `false`, as in `runner.js:904–905`), returning `authenticated: True` from cached expected fields and optional public `get_user_by_id` while completely skipping `v11.user_state()` and `v11.settings()`. Additionally, `PY-RAW-03` (`:586–590`) swallows non-`ValueError` exceptions from `get_user_by_id`. |
| `FINDING-008` | GraphQL `KeyError: 'urls'` in Twikit `User` entity parsing | `TESTED_PASS` | **`VERIFIED`** | `Bot/python/direct_x_compat.py:85–130, 332–340` normalizes missing `description.urls` / `url.urls` entities in GraphQL payload trees and patches `twikit.user.User.__init__` (note `PY-RAW-05` doc mismatch on global patching, and `knownTwikitParserFailure.js:1–13` defense-in-depth classifier). |
| `FINDING-009` | Late callback token race overwriting newer attempts in `runner.js` | `TESTED_PASS` | **`CONTRADICTED`** | While `runner.js:1005–1017` checks `attempt.token === claim.token` inside the mutator, `SqliteStore.update()`'s CAS retry closure defect (`PERSIST-OBS-04`, `RUN-02`, `audit-cas-review.md`) allows outer flags (`dispatchReady`, `result.claimed`, `transitioned` at `runner.js:1006`) set during a conflicted pass 1 to survive into pass 2 even when pass 2 rejects the stale token! |
| `FINDING-010` | Naive substring matching causing false-positive account lock/ban | `TESTED_PASS` | **`CLAIMED-UNVERIFIED`** | `Bot/python/direct_x_compat.py:39–42, 185–205` uses structured error codes (`326, 353, 399, 241` for CAPTCHA; `64, 63, 141` for suspended) and anchored regexes, but `direct_x_compat.py:472–480` retains substring matching on user lookup errors and `runner.js:432–437` / `telegramUi.js:895–905` (`RUN-03`) disables accounts as unverified on generic `isolatedVerifier.verify` exceptions. |
| `FINDING-011` | Lack of upstream idempotency keys / local idempotency protection | `TESTED_PASS` | **`CONTRADICTED`** | Local payload SHA-256 deduplication exists in `Bot/src/queue.js:35–43, 64–72` and pre-dispatch fencing exists in `runner.js:949–968`, but X GraphQL `CreateTweet` (`direct_x_compat.py:501–524`) carries no upstream idempotency key and local exactly-once dispatch fencing is undermined by `PERSIST-OBS-04` (CAS retry stale `dispatchReady`), `PY-RAW-02` (unstructured `'before send'` POST fallback), and `RUN-04` (deleting `payload.account` pin alters payload hash). |
| `FINDING-012` | `curl_cffi` missing from `Bot/requirements-direct-x.txt` | `TESTED_PASS` | **`SUPERSEDED` / `VERIFIED`** | Historical `MASTER_TODO.md:51` claim of `curl_cffi==0.16.3` is **`SUPERSEDED`** by `Bot/requirements-direct-x.txt:5` and `Bot/python/direct_x_compat.py:554`, which pin and runtime-verify `curl_cffi==0.17.0` (matching installed `.venv-direct-x` metadata, `audit-dependencies.md` — narrow pin **`VERIFIED`**). |
| `FINDING-013` | Content engine main-thread blocking during semantic check (`Appimage/dev/automation/contentEngine.js`) | `TESTED_PASS` | **`CLAIMED-UNVERIFIED`** | `Appimage/` desktop content generation (`contentEngine.js` / `semanticIndex.js`) is a separate desktop product (`audit-appimage-boundary.md`) and was not runtime-profiled for 60 FPS UI responsiveness during this read-only Bot audit. |
| `FINDING-014` | Plaintext cookies storage in `Bot/data/cookies/` | `TESTED_PASS` | **`CLAIMED-UNVERIFIED`** | `Bot/src/accounts.js:265–319` (`CookieStore`) and `Bot/python/direct_x_bridge.py:308–321` enforce `0700` directory mode, `0600` file mode, and `O_NOFOLLOW` on final file open, but cookies remain stored in **plaintext** on disk (not encrypted at rest), and `ACC-RAW-02` (10 MiB vs 1 MiB cap mismatch) and `ACC-RAW-03` (pathname-based temp/rename vs dirfd) remain open. |
| `FINDING-015` | Server IP leak via `ipify` (`--noproxy '*'`) in `Bot/src/dockerVpn.js` | `TESTED_PASS` | **`CONTRADICTED`** | `Bot/src/dockerVpn.js:95–155` (`getServerIp`) removed `--noproxy '*'`, but if `SERVER_IP` env and public interface IPv4 lookup fail, lines `138–146` still execute a direct host `curl -4 -s --max-time 5 https://api.ipify.org` (and `icanhazip.com` / `ifconfig.me/ip`) without a proxy, disclosing the host IP to external services when the fallback triggers (`audit-vpn-sessions.md`). |
| `FINDING-016` | Missing strict environment variable validation on startup (`Bot/src/env.js`) | `TESTED_PASS` | **`VERIFIED`** | `Bot/src/env.js:39–169` and `Bot/src/index.js:40–43` implement `validateEnv()` and `assertValidEnv()` checking token format, numeric IDs, positive timeouts, SOCKS5h URLs, and production required keys (`audit-utilities-security.md`). |
| `FINDING-017` | Destructive `/accounts_csv` overwrite on empty upload | `TESTED_PASS` | **`CONTRADICTED`** | While `Bot/src/accounts.js:215–226` rejects empty or header-only CSV uploads (`EMPTY_ACCOUNTS_CSV`), `replaceFromCsv()` (`:189–235`) destructively overwrites existing account security state (`needsOwnerCaptcha`, `captchaIncidentId`, `'كابتشا'`, `'محظور'`) when replacing accounts with matching IDs (`ACC-RAW-01`, proven in `audit-csv-restrictions-review.md`). |
| `FINDING-018` | Telegram polling socket timeout mismatch (`socket timeout <= server timeout`) | `TESTED_PASS` | **`VERIFIED`** | `Bot/src/telegramApi.js:118–127` computes `getUpdates` HTTP socket deadline as `Math.max(defaultTimeoutMs, pollTimeoutMs + 15_000)`, ensuring a minimum +15s safety margin over the server long-poll timeout. |
| `FINDING-019` | Quadruple alert storm on single ambiguous / isolation event | `TESTED_PASS` | **`CLAIMED-UNVERIFIED`** | `Bot/src/telegramUi.js:1801–1945` (`sendIsolationAlert`) implements in-memory `inFlightIncidentChats` plus per-incident, per-chat SQLite receipt tracking (`captchaAlertReceiptsByChat`), and `watchdog.js:1–33` alerts on state transition only. However, a crash window exists between `api.sendMessage` succeeding and `store.update` persisting the receipt (`audit-telegram-runtime.md`). |
| `FINDING-020` | Subprocess stdio buffer overflow on large Python output (`Bot/src/directX.js`) | `TESTED_PASS` | **`VERIFIED`** | `Bot/src/directX.js:109–119` drains complete newline-delimited JSON messages before checking the `1 MiB` (`MAX_STDOUT_BYTES`) residual buffer cap, and `Bot/python/direct_x_bridge.py:1203–1207` enforces a `1 MiB` (`MAX_STDIN_LINE_BYTES`) read cap. |
| `FINDING-021` | Orphaned Python subprocesses on parent `SIGKILL` | `TESTED_PASS` | **`CONTRADICTED`** | `Bot/python/direct_x_bridge.py:116–132` (`PY-RAW-06`) calls `prctl(PR_SET_PDEATHSIG, SIGKILL)` but silently ignores exceptions and non-zero return codes (`except Exception: pass`), and `Bot/src/sessionGuard.js:261–277` (`SESSION-RAW-02`) silently swallows SQLite errors when binding `child_pid`, allowing orphaned processes if `prctl` or `bindChildProcess` fails. |
| `FINDING-022` | Missing error boundaries on timers in `scheduling.js` / `runner.js` | `TESTED_PASS` | **`CONTRADICTED`** | While `runner.js:1430–1452` wraps the scheduler check in `try/catch`, `runner.js:1435–1445` (`TR-02`) commits `uiScheduleDay = day` *before* awaiting `ui.startScheduled()`, permanently losing that day's scheduled run if `startScheduled()` fails readiness or throws. |
| `FINDING-023` | Dependency on experimental `node:sqlite` module | `TESTED_PASS` | **`VERIFIED`** | `Bot/package.json:6–8` declares `"engines": { "node": ">=22.5.0" }` and `Bot/src/sqliteStore.js:4–16` enforces a fail-fast Node version and `node:sqlite` `DatabaseSync` availability guard at module load. |
| `FINDING-024` | Unchecked revision increment without Optimistic Concurrency Control (OCC) in `sqliteStore.js` | `TESTED_PASS` | **`CONTRADICTED`** | While `Bot/src/sqliteStore.js:226, 250` uses `UPDATE state SET json = ?, revision = revision + 1 WHERE id = 1 AND revision = ?`, `SqliteStore.update()` (`:237–262`) runs `await mutator(draft)` outside `BEGIN IMMEDIATE` and re-runs the mutator on `REVISION_CONFLICT` without resetting caller closure state (`PERSIST-OBS-04`, `RUN-02`, proven in `audit-cas-review.md`). |
| `FINDING-025` | SQLite transaction held across async yield in `sqliteStore.js` | `TESTED_PASS` | **`CONTRADICTED`** | `Bot/src/sqliteStore.js:137–143` guards `_runInTransaction` against async callbacks (`TRANSACTION_ASYNC_YIELD`), **but** the way `SqliteStore.update()` avoided async yields inside the transaction was by moving `await mutator(draft)` *outside* `BEGIN IMMEDIATE` (`:237–247`), directly introducing the `PERSIST-OBS-04` CAS retry stale-closure vulnerability! |
| `FINDING-026` | Ambiguous queue blocking (stalled items halting cycle) | `TESTED_PASS` | **`VERIFIED`** | `Bot/src/runner.js:505–534, 1094–1127` and `Bot/src/queue.js:92–107` quarantine `ambiguous` items in place and continue traversing remaining `pending` items in the cycle without blocking queue progression (`verify_p1_005_queue_flow.js` source inspected). |
| `FINDING-027` | Duplicate table formatting logic across 3 files | `TESTED_PASS` | **`CONTRADICTED`** | While table helpers were consolidated into `Bot/src/tableUtils.js:9–26` and imported by `Bot/src/accountTable.js:6`, `tableUtils.js` emits HTML `<table>` tags (`preTable` calls `richTable`) and `accountTable.js` renders 6 columns instead of the 5-column `<pre><code>` Unicode box-drawing table contract in `Bot/AGENTS.md` (`UTIL-RAW-02`). |
| `FINDING-028` | Silent I/O failures in `forensicLogger.js` | `TESTED_PASS` | **`CONTRADICTED`** | While `Bot/src/forensicLogger.js:117–141, 169–173` emits structured error logs on `record()` I/O failure, `ForensicLogger.reconcile()` (`:334–372`, `PERSIST-OBS-01`) silently catches `store.load()` and file read errors and overwrites the store/file with partial or empty records, and `structuredLogger.js:102–105` (`UTIL-RAW-01`) fails to redact top-level secret keys. |
| `FINDING-029` | Timezone sensitivity in quota calculation (`Bot/src/quota.js`) | `TESTED_PASS` | **`VERIFIED`** | `Bot/src/quota.js:3–19` normalizes dates using `Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' })`, defensively falls back to `new Date()` on invalid `Date` input, and fails closed (`0` remaining capacity) on malformed quota numbers. |
| `FINDING-030` | Missing reconciliation between `forensic.jsonl` and SQLite (`forensicLogger.js`) | `TESTED_PASS` | **`CONTRADICTED`** | `ForensicLogger.reconcile()` (`Bot/src/forensicLogger.js:329–475`) exists in source, but is never called in production runtime (`audit-persistence.md`) and contains a destructive data-loss bug (`PERSIST-OBS-01`) that wipes `state.forensicLogs` if `store.load()` fails during `reconcile()`. |
| `FINDING-031` | Unpinned Docker VPN container image tag (`:latest`) | `TESTED_PASS` | **`CONTRADICTED`** | `Bot/docker/Dockerfile.vpn:5` and `Bot/src/dockerVpn.js:15–16` set default `NORDVPN_VERSION=6.0.2` and `yj_autopost_vpn_image:6.0.2`, **but** `Bot/src/dockerVpn.js:62–64` (`isCompatibleVpnImage`) explicitly accepts `:latest` (`image === \`${VPN_IMAGE_REPO}:latest\``) as compatible without digest verification. |
| `FINDING-032` | Token budget truncation in content engine output (`Appimage/dev/main.js`) | `TESTED_PASS` | **`CLAIMED-UNVERIFIED`** | `Appimage/dev/main.js:2160` sets a dynamic token cap up to `4096` (`findings-current-017-033.md`), but `Appimage/` is out of Bot scope and live LLM generation across providers was not executed. |
| `FINDING-033` | Missing punctuation and sentence boundary validation (`Appimage/dev/automation/contentEngine.js`) | `TESTED_PASS` | **`CLAIMED-UNVERIFIED`** | `Appimage/dev/automation/contentEngine.js:481–500, 596` and `Appimage/dev/main.js:1258, 1332` define incomplete-ending checks (`findings-current-017-033.md`), but `Appimage/` is out of Bot scope and end-to-end generation was not executed. |

### 2.2 Historical `ADD-P1` through `ADD-P6` Gap Register Items (20 Items)

| Historical ID | Original Requirement Summary (`P1_P6_ORIGINAL_PLAN_GAP_REGISTER_2026-11-03.md`) | Historical Claimed Status | Phase 1 Audit Classification | Current Code & Forensic Evidence (`f394756`) |
|---|---|---|---|---|
| `ADD-P1-01` | Inventory all 30 ambiguous posts, classify fate of each `itemId` without bulk requeue, revert 4 false recoveries | `AUDITED_QUARANTINED` / `PASS` | **`CLAIMED-UNVERIFIED`** | Read-only SQLite check (`drift-runtime.md`) and JSON ledgers (`M13_AMBIGUOUS_30_STATUS.json`, `M14_AMBIGUOUS_30_STATUS.json`, `historical-nonmarkdown.md`) confirm 30 items remain in `state: 'ambiguous'` with `requeueApproved: false` (including `53d0f458-3144-4e89-a1af-202a8893afc6`). However, `Queue.requeue()` (`PERSIST-OBS-02` / `XT-04`) still lacks a code-level guard blocking `ambiguous -> pending`, and `53d0f458` settlement remains unapplied pending owner approval. |
| `ADD-P1-02` | Distinguish confirmed GraphQL rejection from unresolved post-dispatch outcome without duplicate `POST` | `MERGED_PR21` / `PASS` | **`CONTRADICTED`** | While `publishOutcome.js:5–10` quarantines unconfirmed post-dispatch results when `dispatchEntered` is true, `PERSIST-OBS-04` (CAS retry stale `dispatchReady`), `PY-RAW-02` (unstructured `'before send'` POST fallback), and `PY-RAW-04` / `XT-05` (bridge returning `ambiguous: False, retryable: True` after dispatch on timeline 429/proxy error) contradict universal zero-replay safety. |
| `ADD-P1-03` | Measure all publish attempts (`published + failed + ambiguous`) per cycle and account without double counting | `MERGED` / `LIVE_EVIDENCE_PARTIAL` | **`CLAIMED-UNVERIFIED`** | `Bot/src/attemptOutcomes.js:1–29` and `Bot/src/runner.js:649, 654, 1021–1053, 1176–1186` record per-day `failed` and `ambiguous` attempt counters alongside `quota` successes, and `accountTable.js:27–34` renders them. Full multi-turn live accuracy across crashes remains unverified (`LIVE_EVIDENCE_PARTIAL`). |
| `ADD-P1-04` | Extended verification of post-dispatch `rate_limit` fence and late publish confirmations | `MERGED` / `LOCAL_REGRESSION_PASS_VPS_PENDING` | **`CONTRADICTED`** | `Bot/python/direct_x_bridge.py:229–265, 646–825` (`XT-01`) lacks a `dispatch_started_at` lower bound in `is_recent_tweet()`, accepting identical same-author tweets up to 30 minutes *older* than the current dispatch attempt, and `XT-02` (`directX.js:285–292`) drops `accountFailure` on `recoveredFromTimeline` results. |
| `ADD-P2-01` | Synchronize dual Telegram panels and notify start/stop source (`manual` vs `scheduled`) truthfully | `MERGED` / `LIVE_EVIDENCE_REPORTED` | **`CLAIMED-UNVERIFIED`** | `Bot/src/telegramUi.js:936–950, 1005–1025, 1750–1769` and `Bot/src/runner.js:1432–1445` implement dual-chat start/stop notifications with `runId` and `source`, but `TR-02` (scheduler commits `uiScheduleDay` before `startScheduled()`) and `TR-03` (`notify` logs success without verifying `message_id`) remain open, and no live Telegram messages were sent during this read-only audit. |
| `ADD-P2-02` | Measure latency across Telegram / Event Loop / SQLite / Direct X without altering default ticker pace | `MERGED` / `LIVE_EVIDENCE_PARTIAL` | **`CLAIMED-UNVERIFIED`** | Historical telemetry exists in `Round8_M10/LATENCY_AND_EVENT_LOOP_TELEMETRY.md`, and point-in-time service metrics were sampled (`audit-logs-resources.md`), but live multi-turn latency profiling under active publishing was not executed in this read-only audit. |
| `ADD-P2-03` | Confirm natural and manual stop and dual-chat CSV delivery with verified receipts | `MERGED` / `LIVE_EVIDENCE_REPORTED` | **`CLAIMED-UNVERIFIED`** | `Bot/src/linkExports.js:182–320` persists per-chat `sending` fences and requires integer `message_id` receipts (`linkDeliveries`), but `UTIL-RAW-03` (`linkExports.js:112–123`) appends unbounded duplicate terminal suppression records, and live dual-chat CSV delivery was not executed during this read-only audit. |
| `ADD-P3-01` | Read SQLite without blocking writer (`BEGIN` deferred for reads, `BEGIN IMMEDIATE` for writes) and measure contention | `MERGED` / `LIVE_EVIDENCE_REPORTED` | **`CONTRADICTED`** | While `Bot/src/sqliteStore.js:135, 187–193, 247` uses `BEGIN` for `load()` and `BEGIN IMMEDIATE` for `update()`, moving `await mutator(draft)` outside `BEGIN IMMEDIATE` (`:237–247`) introduced `PERSIST-OBS-04` / `RUN-02` (CAS retry stale closure variables), and `PERSIST-OBS-05` (`:25–75`) leaves the production DB unguarded when tests run from a secondary git worktree. |
| `ADD-P3-02` | Persistent `failureDiagnostic` per item and attempt history preservation across strike resets | `PARTIAL_MERGED` / `VPS_E2E_PENDING` | **`CLAIMED-UNVERIFIED`** | `Bot/src/runner.js:1021–1033, 1176–1186` writes `item.failureDiagnostic`, and `revert_false_recovery_m11.js:106–108` / `settle_item_53d0f458.js:116–118` copy `item.attempt` to `item.archivedAttempt`. However, `runner.js:643–651` (`RUN-04`) deletes `item.attempt` and `item.payload.account` on pre-dispatch account failure without archiving prior attempt history on the item. |
| `ADD-P3-03` | Long-run endurance testing across multiple rounds and service restarts without second bot instance | `PARTIAL_LIVE_EVIDENCE` / `FURTHER_ENDURANCE_PENDING` | **`CLAIMED-UNVERIFIED`** | Point-in-time snapshot (`audit-logs-resources.md`, `drift-runtime.md`) shows `PID 2581192` running with `NRestarts=0` since `06:32:25 +03`, but the 24h systemd journal revealed 5 historical `exit-code` (`status=143`) and 3 mount-namespace `status=226/NAMESPACE` startup failures on `2026-11-03` (`audit-logs-resources.md:44–50`), and long-run endurance remains unverified. |
| `ADD-P4-01` | Prevent Twikit `KeyError: 'urls'` in `CreateTweet` and timeline reads for empty-bio accounts | `MERGED` / `LIVE_EVIDENCE_REPORTED` | **`VERIFIED`** | `Bot/python/direct_x_compat.py:85–130, 332–340` normalizes missing `urls` arrays in user entity dicts and patches `User.__init__` (`FINDING-008`). |
| `ADD-P4-02` | Propagate X GraphQL/HTTP error codes and messages from Python to Node and SQLite without leaking secrets in logs | `MERGED_PR21` / `PASS` | **`CONTRADICTED`** | Error codes/messages are attached in `direct_x_compat.py:292–317`, **but**: (1) `XT-02` (`directX.js:285–292`) drops `accountFailure` when `recoveredFromTimeline` is true; (2) `UTIL-RAW-01` (`structuredLogger.js:102–105`) fails to redact top-level sensitive keys in structured logs; and (3) `PY-RAW-07` (`direct_x_bridge.py:929–1188`) emits raw truncated exception strings into forensic details. |
| `ADD-P4-03` | Exclude content rejections (`186` length / `187` duplicate) from 3-strike account failure counter | `MERGED_PR19` / `CI_GREEN_VPS_E2E_PENDING` | **`VERIFIED`** | `Bot/src/xFailureClassification.js:3–16` classifies `186`/`187` and `duplicate_content`/`length_exceeded` as content rejections (`isContentRejectionFailure`), and `Bot/src/runner.js:550–551` skips account strike increments for content rejections. |
| `ADD-P4-04` | Stability of 5 VPN containers, zero IP leak, and safe rotation during long runs | `IMPLEMENTED_HISTORICALLY` / `LIVE_EVIDENCE_REPORTED` | **`CONTRADICTED`** | Only 2 of 5 project VPN containers (`yj_autopost_vpn_1`, `yj_autopost_vpn_2`) are currently running (`drift-runtime.md`), and source inspection uncovered `VPN-RAW-01` (auto-creation via `docker run` without host-cap or existing-volume fingerprint check), `VPN-RAW-02` (`docker rm -f` without `nordvpn disconnect` and startup `reconcileResources` destroying containers of disabled accounts), `VPN-RAW-03` (swallowed rate-limit error in `rotateContainerIp`), `TR-05` (`telegramUi.js` deleting ` state.vpnSlots` before calling `vpnManager.release`), and `FINDING-015` (direct host `ipify` fallback in `getServerIp`). |
| `ADD-P5-01` | Link X error `186` (length exceeded) to UTF-16/codepoint length and prevent before dispatch | `DIAGNOSTICS_MERGED` / `ROOT_CAUSE_ACCEPTANCE_PENDING` | **`CLAIMED-UNVERIFIED`** | `direct_x_compat.py:220–269` and `xFailureClassification.js:3–16` classify `186` post-dispatch rejections, and `telegramFlows.js:1–65` parses queue imports, but weighted X character counting (URL = 23 chars, CJK/emoji = 2 chars) is not enforced as a pre-dispatch gate in `Bot/src/queue.js` or `Bot/src/runner.js`. |
| `ADD-P5-02` | Link X error `187` (duplicate content) to original content/queue and prevent duplicate publishing | `DIAGNOSTICS_MERGED` / `ROOT_CAUSE_ACCEPTANCE_PENDING` | **`CONTRADICTED`** | While `Bot/src/queue.js:35–43, 64–72` deduplicates local non-cancelled queue items by `SHA-256(JSON.stringify(payload))`, `RUN-04` (`runner.js:647`) mutates `payload.account` on pre-dispatch failure (changing the payload structure after enqueue), and `XT-01` (`direct_x_bridge.py:229–265`) misattributes pre-existing identical timeline posts within 30 minutes as newly published. |
| `ADD-P6-01` | Sanitize forensic logs and archive/reconcile before 7-day retention limit without leaking cookies/tokens | `MERGED` / `CI_GREEN_REDACTION_VPS_AUDIT_PENDING` | **`CONTRADICTED`** | Refuted by `PERSIST-OBS-01` (`ForensicLogger.reconcile()` wipes logs on `store.load()` error), `PERSIST-OBS-03` (`record()` bypasses `pendingForensicOutbox`), `PERSIST-OBS-05` (worktree path guard bypass), and `UTIL-RAW-01` (`structuredLogger.js` top-level secret key redaction bypass). |
| `ADD-P6-02` | Monitor production run until natural/manual stop and dual-chat CSV receipts (not just first 16 posts) | `MERGED_PR18` / `AGENT_REPORTED_COMPLETE_LOGS` | **`CLAIMED-UNVERIFIED`** | `Bot/scripts/live_production_5_rounds_monitor.js:98–108` and `Bot/scripts/m8_live_production_monitor.js:365–404` wait for `cycle.state === 'stopped'` and `linkDeliveries` receipts, but `live_production_5_rounds_monitor.js:127–128` dumps unredacted `journalctl` output to disk (`audit-scripts-deploy.md`) and no live monitor run was executed during this read-only audit. |
| `ADD-P6-03` | Independent review of all 33 `FINDING` + 20 `ADD` items and owner sign-off of phases P1–P6 | `OPEN` / `NOT_RUN` | **`CLAIMED-UNVERIFIED`** | This Phase 1 Surgical Audit Completion Gate completes the independent technical audit of all 33 `FINDING` and 20 `ADD` items (identifying the remaining code defects consolidated in Part 1); final closure requires executing the Phase 2 `P01..P08` remediation plan and obtaining owner sign-off. |
| `ADD-P6-04` | Reconcile historical P1–P6 roadmap with GitHub phases / M1–M14 rounds and update Issue #12 | `OPEN` / `NOT_RUN` | **`CLAIMED-UNVERIFIED`** | All 53 historical IDs (`33 FINDING` + `20 ADD`) and 59 Phase 1 raw findings are now mapped in this gate and cross-referenced into the unified `P01..P08` Master TODO in `phase2-architecture-and-pxx-todo.md`; live GitHub Issue #12 update remains gated until owner approval. |

---


---

# Section 4: Complete Phase 1 Root-Cause Register (All 59 Raw Findings) & 30 Quarantined Ambiguous Items Ledger (Including Fenced `53d0f458-3144-4e89-a1af-202a8893afc6`)

## Part 1: Complete Raw Findings Register (59 Discovered Issues)

### 1.1 Persistence, Queue & CAS Mutator (`PERSIST-OBS-01..05`)

| Issue ID | File : Line | Severity | Reachability | Root Cause | Proof / Audit Evidence |
|---|---|---|---|---|---|
| `PERSIST-OBS-01` | `Bot/src/forensicLogger.js:334–372, 402–475` | High | Public API (`ForensicLogger.reconcile()`); called in legacy tests (`p3_p4_findings_verification.test.js`), no current production runtime caller established | `ForensicLogger.reconcile()` catches `store.load()` errors (`:334–353`) and `forensic.jsonl` read errors (`:359–372`), defaulting to empty arrays `[]`, then proceeds to overwrite `state.forensicLogs` and rewrite `forensic.jsonl` (`:442–475`), returning `reconciled: true` and wiping existing records if the read side transiently failed. Also lacks directory `fsync` after `rename` (`:418–427`). | **Empirical offline proof (`audit-persistence.md`):** Invoked `ForensicLogger.reconcile` against an isolated `mkdtemp` directory with injected `store.load()` failure and 1 existing record; `update()` succeeded, wiping record count `1 -> 0` with `updatedFile: true, updatedStore: true, reconciled: true`. |
| `PERSIST-OBS-02` | `Bot/src/queue.js:19–22, 91`; `Bot/src/ambiguousAudit.js:41` | Medium | Exported `Queue.requeue(id)` method; no active caller in `Bot/src` or `Bot/scripts` (unreachable in normal cycle unless invoked by future code/script) | `Queue.requeue(id)` checks only `ADDRESSABLE_STATES` (`pending`, `processing`, `failed`, `published`, `ambiguous`) and transitions any non-cancelled item—including `ambiguous`—directly to `pending` without a state guard rejecting `ambiguous` items. `ambiguousAudit.js:41` sets `requeueApproved: false` only in reporting output. | **Source trace (`audit-persistence.md`):** `Bot/src/queue.js:19–22` includes `'ambiguous'` in `ADDRESSABLE_STATES` and line `91` sets `item.state = 'pending'` unconditionally if found. |
| `PERSIST-OBS-03` | `Bot/src/forensicLogger.js:107–151, 485–517`; `Bot/scripts/settle_item_53d0f458.js:197–200`; `Bot/scripts/revert_false_recovery_m11.js:158–178` | Medium | Reachable on every runtime `forensicLogger.record()` call (`runner.js:737, 1075, 1094`) | Two divergent forensic persistence paths exist: recovery/settlement scripts write atomically to both `state.forensicLogs` and `state.pendingForensicOutbox` inside `store.update()`, whereas runtime `forensicLogger.record()` updates `state.forensicLogs` and separately appends to `forensic.jsonl` without inserting into `pendingForensicOutbox`. If the `forensic.jsonl` append fails or crashes after SQLite commit, `flushOutbox()` on startup will not replay the missing JSONL record. | **Source trace (`audit-persistence.md`, `audit-recovery-flow.md`):** `forensicLogger.js:107–151` catches store/file errors independently and never populates `state.pendingForensicOutbox`. |
| `PERSIST-OBS-04` | `Bot/src/sqliteStore.js:237–262`; `Bot/src/runner.js:949–968`; `Bot/src/directX.js:315–325`; `Bot/python/direct_x_bridge.py:845–851` | Critical (High confidence in mechanism; conditional on external/concurrent revision conflict) | Reachable if a concurrent connection/process (e.g., `configure_m4_single_publish.js` or second process) commits to `state.sqlite` during the microtask window between `SqliteStore.update()`'s `load()` and `BEGIN IMMEDIATE` | `SqliteStore.update()` evaluates and awaits `mutator(draft)` *outside* the `BEGIN IMMEDIATE` transaction (`:237–247`) and retries the same closure on `REVISION_CONFLICT` (`:248–262`). Callers (`runner.js:949–968` `dispatchReady`, `runner.js:142–163` `result.claimed`, `runner.js:1006–1009` `transitioned`, `queue.js:55, 79–87` `added`) declare outer `let` booleans/counters before `store.update()` and set them to `true` on pass 1 without resetting them at the start of each mutator invocation. If pass 1 sets `dispatchReady = true` and hits a CAS revision conflict because the account was disabled or claim superseded, pass 2 returns early with `phase: 'claimed'`, commits the no-op state, and returns `dispatchReady === true` to `DirectXAdapter`, which sends `dispatch_ack` and triggers an external `create_tweet` while SQLite still shows `phase: 'claimed'` (which `recoverProcessing` reverts to `pending` on crash). | **Empirical offline proof (`audit-cas-review.md`, `cas-mechanism-probe.cjs`, `cas-mechanism-output.txt`):** Executed against isolated `mkdtemp` SQLite with a competing `DatabaseSync` connection committing `enabled=false` after pass 1: output confirmed `passes=2, dispatchReady=true, durableEnabled=false, durablePhase=claimed`. |
| `PERSIST-OBS-05` | `Bot/src/sqliteStore.js:25–40, 58–75` | High | Reachable whenever tests or scripts run from a secondary git worktree (e.g. `/root/Projects/YJAutoPostOnX-surgical-audit`) with `NODE_ENV=test` targeting the live `/root/Projects/YJAutoPostOnX/Bot/data/state.sqlite` path | `resolveProductionDbPath()` resolves `../data/state.sqlite` relative to `__dirname` (`sqliteStore.js:26`) rather than guarding the canonical host production path (`/root/Projects/YJAutoPostOnX/Bot/data/state.sqlite`). When loaded from a separate git worktree, `assertMutationAllowed()` only protects the worktree's own `Bot/data/state.sqlite` and fails to block test mutations against the live production database path. | **Empirical offline proof (`audit-persistence.md`, `worktree-db-guard-probe.cjs`, `worktree-db-guard-output.txt`):** Guard-only probe from the surgical audit worktree with `NODE_ENV=test` passed the live production DB path `/root/Projects/YJAutoPostOnX/Bot/data/state.sqlite` into `assertMutationAllowed()` without throwing. |

### 1.2 Runner & Lifecycle (`RUN-01..06`)

| Issue ID | File : Line | Severity | Reachability | Root Cause | Proof / Audit Evidence |
|---|---|---|---|---|---|
| `RUN-01` | `Bot/src/runner.js:25–131, 268–269`; `Bot/src/singleInstance.js:23–260` | Medium | Active runtime startup (`runner.js:268`) and test suite imports (`single_instance_lock*.test.js`) | Duplicate/divergent `SingleInstanceLock` implementations: `runner.js:25–131` defines its own inline `SingleInstanceLock` class used by `run()`, while `Bot/src/singleInstance.js` exports a separate implementation with additional conflict helpers. Unit tests that import `src/singleInstance.js` do not exercise the inline class actually used by `runner.js`. | **Source trace (`audit-runner-full.md`, `audit-accounts-entrypoints.md` `ENTRY-RAW-01`):** `runner.js:25` declares `class SingleInstanceLock` locally and instantiates it at `:268`, never importing `./singleInstance`. |
| `RUN-02` | `Bot/src/runner.js:142–163` | High | Reachable during `claimCycleItem()` under concurrent SQLite revision conflict | Same outer-closure mutation antipattern as `PERSIST-OBS-04`: `claimCycleItem()` declares `const result = { claimed: false, ... }` outside `store.update(s => ...)` (`:143`) and mutates `result.claimed = true` inside the mutator (`:159`). If pass 1 succeeds in draft but conflicts on CAS revision and pass 2 hits an early return (`!item || item.state !== 'pending'` at `:149`), `result.claimed` remains `true` from pass 1 even though the claim was not committed in pass 2. | **Source trace (`audit-runner-full.md`, `audit-cas-review.md`):** `runner.js:143–163` never resets `result` fields at the top of the `store.update` callback. |
| `RUN-03` | `Bot/src/runner.js:432–437`; `Bot/src/telegramUi.js:895–905` | Medium | Reachable when `isolatedVerifier.verify()` encounters an unhandled exception or transient VPN/bridge timeout with `persistResult !== false` | In `isolatedVerifier.verify()`, the `catch (error)` block (`runner.js:432–437`) calls `ui.recordAccountCheck(account.id, { authenticated: false, error: error.message })` without setting `accountFailure`. In `telegramUi.js:895–905`, when `check.authenticated === false` and `!failure` and `!account.needsOwnerCaptcha`, it sets `account.enabled = false` and `account.status = 'غير متحقق (يتطلب فحص الجلسة)'`, disabling a healthy account on a transient proxy/bridge timeout. | **Source trace (`audit-runner-full.md`):** `runner.js:432–437` passes `{ authenticated: false }` on any caught error; `telegramUi.js:895–905` unconditionally sets `account.enabled = false`. |
| `RUN-04` | `Bot/src/runner.js:643–651, 809–815, 1343–1351` | Medium | Reachable when an item imported with an explicit `payload.account` pin encounters a pre-dispatch account failure (`handleAccountFailure`) | When a pre-dispatch account failure occurs on a claimed item, `handleAccountFailure` (`runner.js:643–651`) reverts the item to `pending` and executes `if (i.payload?.account === accountId) delete i.payload.account;`. Deleting the durable `payload.account` pin converts an owner-pinned post into an unpinned shared post that `selectAccount()` (`:183–197`) can subsequently route to a different X account on the next cycle pass, altering its SHA-256 payload hash as well. | **Source trace (`audit-runner-full.md`, `audit-routing.md`):** `runner.js:647` mutates durable `i.payload.account` inside `store.update()`. |
| `RUN-05` | `Bot/src/runner.js:737–750, 1075–1083, 1094–1108, 1629–1659` | Low / Medium | Reachable if process shuts down immediately after an item settlement or account isolation while async `forensicLogger.record()` is in flight | `runner.js` invokes `bot.forensicLogger.record(...)` as a detached promise (`Promise.resolve(...).catch(...)`) without awaiting it or registering it in `ui.pendingTasks` / shutdown drain (`:1629–1659`). If `store.close()` runs in `finally` before the detached `record()` promise settles, the forensic record write fails with closed-store error. | **Source trace (`audit-runner-full.md`):** Lines `737`, `1075`, `1094` fire-and-forget `forensicLogger.record()` without task tracking; `:1640–1659` drains only `panelTasks` and `exportTasks` before `bot.store.close()`. |
| `RUN-06` | `Bot/src/runner.js:1624–1662` | Medium | Reachable on runner exit/shutdown if `watchdog.close()` or `ui.destroy()` rejects | In `run()`'s outer `finally` block (`:1623–1662`), `await watchdog.close()` (`:1625`) and `await ui.destroy()` (`:1626`) are executed *outside* and *before* the inner `try { ... } finally { await bot.store.close(); await instanceLock.release(); }` block (`:1629–1661`). If either `watchdog.close()` or `ui.destroy()` throws/rejects, execution jumps out of the outer `finally` without closing `SqliteStore` or releasing `instanceLock`. (Tracked together with `TR-07`.) | **Source trace (`audit-runner-full.md`, `audit-telegram-runtime.md`):** `runner.js:1625–1626` are unguarded `await` statements preceding the inner `try/finally` at `:1629`. |

### 1.3 Telegram Runtime, Polling, Scheduler & Concurrency (`TR-01..07`)

| Issue ID | File : Line | Severity | Reachability | Root Cause | Proof / Audit Evidence |
|---|---|---|---|---|---|
| `TR-01` | `Bot/src/telegram.js:23, 85–89`; `Bot/src/runner.js:1485–1489, 1581`; `Bot/src/telegramUi.js:180, 1113, 1272–1273` | Medium (Deterministic functional bug) | Reachable whenever an authorized operator sends the `/account_toggle <id>` text command in Telegram | `telegram.js:23` maps `/account_toggle` to action key `'accountToggle'`. `runner.js:1485–1489` defines a text-command handler for `accountToggle`, but `runner.js:1581` spreads `...ui.actions()` *after* it in the same object literal. `telegramUi.js:180` also defines `accountToggle` (expecting callback query `parsed.action`), which overwrites `runner.js`'s text command handler. When `/account_toggle` arrives as a text command, `parsed` is undefined (`telegram.js:85–89`), so `telegramUi.js:1272–1273` silently returns `{ text: '' }` (no-op). | **Source trace (`audit-telegram-runtime.md`):** Object literal key collision in `runner.js:1485` vs `:1581` (`...ui.actions()`). |
| `TR-02` | `Bot/src/runner.js:1435–1445`; `Bot/src/scheduling.js:10–11`; `Bot/src/telegramUi.js:936–1000` | Medium | Reachable when the daily scheduled run triggers at the exact minute (`isDue`), commits `uiScheduleDay = day`, and then `ui.startScheduled()` fails readiness or crashes before starting | `runner.js:1435–1445` commits `s.posting.uiScheduleDay = day` in SQLite *before* calling `await ui.startScheduled()`. Because `isDue()` (`scheduling.js:10–11`) requires `lastRunDay !== day` and exact `hour/minute` match, if `ui.startScheduled()` returns `started: false` (e.g., transient VPN readiness check failure) or the process crashes before `begin()`, that day's scheduled run is permanently marked consumed and will not retry. | **Source trace (`audit-telegram-runtime.md`):** `runner.js:1436–1442` mutates `uiScheduleDay = day` prior to `await ui.startScheduled()` at `:1445`. |
| `TR-03` | `Bot/src/runner.js:326–366`; `Bot/src/telegramUi.js:1010–1019`; `Bot/src/telegramApi.js:25–47` | Low / Medium | Reachable if Telegram API or a custom transport returns `{ ok: true, result: {} }` without a valid `message_id` on `sendMessage` | `telegramApi.js:25–47` checks `body.ok === true` and `typeof body.result === 'object'`, but does not enforce `Number.isInteger(body.result.message_id)` for message sends (unlike CAPTCHA alert receipt tracking in `telegramUi.js:1875–1901` and CSV export in `linkExports.js:285`). Consequently, `runner.js:343` logs `notify_send_success` with `messageId: res?.message_id ?? null` and `telegramUi.js:1011` counts the notification as delivered even if `message_id` is absent. | **Source trace (`audit-telegram-runtime.md`):** Compare `runner.js:340–348` and `telegramUi.js:1010–1019` with `telegramUi.js:1878` (`Number.isInteger(msgId) && msgId > 0`). |
| `TR-04` | `Bot/src/accounts.js:47–50, 150–169`; `Bot/src/telegramFlows.js:264–273` | Medium | Reachable via legacy text account flow (`telegramFlows.js:264–273`) if an account's status changes to `محظور` or `غير متحقق` between `load()` and `accounts.update()` | `telegramFlows.js:264–273` reads `account.status === 'محظور'` in a non-transactional `load()` before calling `accounts.update(id, { enabled: true })`. Inside `accounts.update()` (`accounts.js:150–169`), if `patch.enabled === true` and `patch.status === undefined`, it sets `status = 'نشط'` unconditionally. While `accountRecord()` (`:47–50`) forces `enabled = false` if `needsOwnerCaptcha` is true, it does *not* force `enabled = false` when the prior status was `'محظور'` (banned) or `'غير متحقق'` if overwritten to `'نشط'` by `patch.enabled`. | **Source trace (`audit-telegram-runtime.md`):** `accounts.js:156` sets `status: patch.status !== undefined ? patch.status : (enabled ? 'نشط' : 'غير نشط')` without checking existing `current.status === 'محظور'`. |
| `TR-05` | `Bot/src/telegramUi.js:1120–1145, 1197–1209, 1483–1495`; `Bot/src/dockerVpn.js:363–380` | High | Reachable whenever an operator disables an account or clicks "Disable All" in the Telegram UI (`accountToggle`, `accountManage` disable, `accounts:disable_all`) | In `telegramUi.js` (`:1128`, `:1201`, `:1487`), the `store.update()` transaction deletes `s.vpnSlots[id]` (or clears `s.vpnSlots = {}`) *before* invoking `await this.vpnManager.release(id)` (`:1141`, `:1207`, `:1493`). However, `VpnSlotManager._release(accountId)` (`dockerVpn.js:363–366`) looks up `const slot = state.vpnSlots?.[key]; if (slot === undefined) return { released: false, slot: null };`. Because the UI already deleted the mapping from `state.vpnSlots`, `vpnManager.release()` always sees `slot === undefined` and returns early without stopping/releasing the container! | **Source trace (`audit-telegram-runtime.md`):** `telegramUi.js:1201` executes `if (s.vpnSlots) delete s.vpnSlots[id];` before `:1207` `await this.vpnManager.release(id)`, which reads `state.vpnSlots[id]` at `dockerVpn.js:364`. |
| `TR-06` | `Bot/src/telegramUi.js:1159–1248, 1392–1426`; `Bot/src/runner.js:142–152, 183–190, 955–962` | High | Reachable when an operator clicks enable on an account (`accountToggle` or `accountManage`) concurrently with the runner isolating that account for CAPTCHA/ban | `TelegramUi.accountToggle` (`:1161–1227`) and `accountManage` (`:1392–1410`) check `isCaptchaStatus`, `'محظور'`, `'غير متحقق'`, and the 5-active-account cap using an initial `store.load()` snapshot *outside* the subsequent `store.update()` transaction (`:1229–1248` / `:1412–1426`). Inside `store.update()`, the mutator unconditionally sets `target.enabled = true; target.status = 'نشط';` without re-checking whether a concurrent runner transaction isolated the account with `needsOwnerCaptcha = true` / `'محظور'` or whether another enable crossed the 5-account cap. Even worse, if `needsOwnerCaptcha` was set by the runner, the UI overwrite leaves `enabled: true, status: 'نشط', needsOwnerCaptcha: true`, and `runner.selectAccount` (`:183–190`), `claimCycleItem` (`:142–152`), and `onDispatch` (`:955–962`) do not check `needsOwnerCaptcha`! | **Empirical offline proof (`audit-telegram-runtime.md`, `telegram-synthetic-race.txt`):** Executed actual `TelegramUi.accountToggle` with a CAPTCHA isolation injected between `load()` and `update()`: output confirmed `toggled: true, enabled: true, status: 'نشط', needsOwnerCaptcha: true, captchaIncidentId: 'inc-1'`. |
| `TR-07` | `Bot/src/runner.js:1624–1662` | Medium | Reachable on daemon shutdown if `watchdog.close()` or `ui.destroy()` throws before lock/store cleanup | Identical boundary to `RUN-06`: `runner.js:1625–1626` awaits `watchdog.close()` and `ui.destroy()` before entering the inner `try/finally` that drains tasks, closes `SqliteStore`, and releases `SingleInstanceLock`. | **Source trace (`audit-telegram-runtime.md`):** `runner.js:1624–1662`. |

### 1.4 Telegram UI State & Rendering (`UI-01..04`)

| Issue ID | File : Line | Severity | Reachability | Root Cause | Proof / Audit Evidence |
|---|---|---|---|---|---|
| `UI-01` | `Bot/src/telegramUi.js:1666–1671` | Medium | Reachable when operator clicks `accmanage:check_vpn:<id>` button in the Telegram Account Management panel | The `check_vpn` branch in `TelegramUi.accountManage` (`:1666–1671`) never calls `vpnManager.health()` or `isolatedVerifier.health()`. Instead, it reads the cached `account.exitIp` from SQLite (defaulting to `'سليم'` if absent) and replies `🌐 حالة VPN للحساب: المنفذ نشط (IP: ...)` even if the account does not exist or its VPN container is stopped/unhealthy. | **Source trace (`audit-telegram-full.md`):** `telegramUi.js:1666–1671` performs only `const s = await this.bot.store.load();` and formats a static success string without touching `vpnManager`. |
| `UI-02` | `Bot/src/telegramUi.js:1120–1127, 1462–1475, 1602–1613` | Medium | Reachable when an operator clicks `accmanage:disable:<id>` (or `accounts:disable_all`) on an account that has `needsOwnerCaptcha: true` | In `accountManage` (`:1462–1475`), the `disable` action unconditionally sets `target.status = 'غير نشط'` while leaving `target.needsOwnerCaptcha = true` and `target.captchaIncidentId` intact. However, `verify_captcha` (`:1602–1613`) requires *both* `acc.needsOwnerCaptcha && isCaptchaStatus(acc.status)` in its CAS check (`:1603`). Once `target.status` is overwritten to `'غير نشط'`, `isCaptchaStatus('غير نشط')` returns `false`, permanently deadlocking the owner's `verify_captcha` button with `reason: 'state_changed'`! Similarly, `accounts:disable_all` (`:1122`) checks `a.status !== 'كابتشا'` instead of `!isCaptchaStatus(a.status) && !a.needsOwnerCaptcha`, overwriting long-form CAPTCHA statuses (`'كابتشا - يتطلب حل يدوي'`) to `'غير نشط'`. | **Source trace (`audit-telegram-full.md`):** Compare `telegramUi.js:1466` (`target.status = 'غير نشط'`) and `:1122` (`a.status !== 'كابتشا'`) against `:1603` (`if (!acc || !acc.needsOwnerCaptcha || !isCaptchaStatus(acc.status))`). |
| `UI-03` | `Bot/src/telegramUi.js:880–885, 1309–1321` | Low | Reachable when viewing account details (`accountDetailText`) for an account isolated by `recordAccountCheck` with long-form CAPTCHA status | `recordAccountCheck` (`:880–885`) sets `account.status = 'كابتشا - يتطلب حل يدوي'`, whereas `accountDetailText` (`:1309–1311`) checks only exact `account.status === 'كابتشا'` (instead of `isCaptchaStatus(account.status)` or `account.needsOwnerCaptcha`), falling through to render `🔴 معطل` instead of `🟠 محجوب بـ CAPTCHA`. | **Source trace (`audit-telegram-full.md`):** `telegramUi.js:1310` uses `account.status === 'كابتشا'` while `:1324` (`accountDetailKeyboard`) uses `isCaptchaStatus(account.status) || Boolean(account.needsOwnerCaptcha)`. |
| `UI-04` | `Bot/src/telegramUi.js:1314–1318, 1383–1386` | Low / Medium | Reachable when viewing account details (`accountDetailText`) if `account.label` contains HTML metacharacters (`<`, `>`, `&`) | `accountDetailText` (`:1314–1318`) interpolates `account.label` directly into an HTML message (`parse_mode: 'HTML'` at `:1383–1386`) without calling `escapeHtml(account.label)`, whereas `account.username`, `exitIp`, and `lastError` are escaped with `escapeHtml()`. | **Source trace (`audit-telegram-full.md`):** `telegramUi.js:1316` writes `const label = account.label ? \` (${account.label})\` : '';` without `escapeHtml`. |

### 1.5 Python Direct-X Bridge & Compatibility (`PY-RAW-01..07`)

| Issue ID | File : Line | Severity | Reachability | Root Cause | Proof / Audit Evidence |
|---|---|---|---|---|---|
| `PY-RAW-01` | `Bot/python/direct_x_bridge.py:516–547, 830–833`; `Bot/src/directX.js:123–128`; `Bot/src/runner.js:904–905` | High | Active on every normal publishing turn when `account.userId` is cached (`verifyNetwork` is `false` in `runner.js:904–905`) | When `use_cache=True` (`directX.js:126` sets `useCache = Boolean(!verifyNetwork && effectiveUserId)`) and the cookie `twid` matches `expected_id`, `DirectSession.identity()` (`direct_x_bridge.py:516–547`) skips `v11.user_state()` and `v11.settings()` completely, optionally calling public `get_user_by_id` and returning `authenticated: True` from cached expected fields. Public profile lookup does not verify that the cookie session itself is still valid or free of account lock/CAPTCHA before pre-dispatch admission. (Directly contradicts historical `FINDING-007` closure claim.) | **Source trace (`audit-python-bridge.md` `PY-RAW-01`):** `direct_x_bridge.py:530–547` returns early before line `549` (`self.client.v11.user_state()`). |
| `PY-RAW-02` | `Bot/python/direct_x_bridge.py:384–422` | High | Reachable when `curl_cffi` raises an exception during a non-idempotent `POST` (`CreateTweet`) in `_request_with_transport_fallback` | `_is_definitely_pre_send_error(exc)` (`:384–405`) permits `httpx` fallback replay on a `POST` request if either `curl_code in _PRE_SEND_CURL_CODES` OR unstructured exception message text contains `'before send'` or `'before any send'`. Matching arbitrary substring text in an exception message is not a cryptographic or kernel-level proof that zero HTTP payload bytes left the socket, risking a duplicate `POST` if an upstream error message contains those words. (Contradicts universal `FINDING-001` guarantee.) | **Source trace (`audit-python-bridge.md` `PY-RAW-02`, `findings-current-001-016.md` `FINDING-001`):** `direct_x_bridge.py:404` checks `return 'before send' in msg or 'before any send' in msg`. |
| `PY-RAW-03` | `Bot/python/direct_x_bridge.py:575–590, 605–634` | Medium | Reachable during non-cached `identity()` when `v11.settings()` lacks `screen_name`, `expected_id` matches cookie `twid`, and `get_user_by_id()` throws an upstream restriction error | In `DirectSession.identity()` (`:575–590`), when falling back to `get_user_by_id(uid)`, `actual = expected_handle` is pre-populated (`:577`) before calling `await self.client.get_user_by_id(uid)`. The `except Exception:` block (`:586–590`) re-raises `ValueError` (identity mismatch) but silently swallows all other exceptions—including Twikit/GraphQL exceptions carrying `account_failure` (`captcha` / `banned`)—allowing execution to proceed to `:605–634` and return `authenticated: True`. | **Source trace (`audit-python-bridge.md` `PY-RAW-03`):** `direct_x_bridge.py:586–590` `except Exception as exc: if isinstance(exc, ValueError): raise`. |
| `PY-RAW-04` | `Bot/python/direct_x_bridge.py:879–1006, 1049–1066, 1112–1145`; `Bot/src/publishOutcome.js:5–10` | Low / Medium (Mitigated in runner by `publishOutcome.js`, exposed to direct bridge callers/tests) | Reachable in `DirectSession.publish()` when `create_tweet` fails or returns incomplete data and the subsequent timeline verification encounters a `429` or proxy error | Several post-dispatch branches in `direct_x_bridge.py` (`:920–965`, `:1112–1145`) return `ambiguous: False, retryable: True` (e.g. `status: 'rate_limit'` or `'network_proxy_error'`) *after* `dispatch_ack` was received and `create_tweet` was called. While `Bot/src/publishOutcome.js:5–8` overrides this in `runner.js` whenever `dispatchEntered === true` (forcing `ambiguous: true`), the Python bridge's own return payload violates its documented post-dispatch ambiguity contract. | **Source trace (`audit-python-bridge.md` `PY-RAW-04`):** `direct_x_bridge.py:1118–1128` returns `'ambiguous': False, 'retryable': True` after `create_tweet` exception when timeline read hits rate limit. |
| `PY-RAW-05` | `Bot/python/direct_x_compat.py:1–5, 319–320, 332–340` | Low | Executed on every `new_client()` initialization in Python bridge | `direct_x_compat.py:1–5, 319–320` documents that it uses an isolated subclass with "no global monkey-patching", but lines `332–340` globally mutate `twikit.user.User.__init__` and set `_yj_safe_urls_patched = True` on the imported `User` class across the Python interpreter process. | **Source trace (`audit-python-bridge.md` `PY-RAW-05`):** `direct_x_compat.py:332–340` overwrites `User.__init__ = _safe_user_init`. |
| `PY-RAW-06` | `Bot/python/direct_x_bridge.py:116–132` | Low / Medium | Executed at Python bridge startup (`_set_parent_death_signal()`) | `_set_parent_death_signal()` calls `libc.prctl(PR_SET_PDEATHSIG, signal.SIGKILL)` and checks `os.getppid() == 1` only if `res == 0`, while catching and silently ignoring all exceptions and non-zero `prctl` return codes (`:131–132`). If `ctypes` or `prctl` fails, the bridge continues running without parent-death protection and without logging a warning. (Contradicts unconditional `FINDING-021` claim.) | **Source trace (`audit-python-bridge.md` `PY-RAW-06`):** `direct_x_bridge.py:131–132` `except Exception: pass`. |
| `PY-RAW-07` | `Bot/python/direct_x_bridge.py:85–113, 929, 945, 959, 985, 998, 1005, 1064, 1126, 1143, 1170, 1188`; `Bot/src/runner.js:1105–1108` | Medium | Reachable on bridge exceptions and rate-limit checks | Even after `f394756` narrowed `'429'` matching to `\b429\b` (`direct_x_bridge.py:109`), `is_rate_limit_exception` still inspects unstructured exception strings for `\b429\b` (which can match a tweet ID, user ID, port, or byte count of `429`), and the bridge emits raw `str(exc)[:500]` in `xErrorMessage` / `verificationError` across stdout IPC (`:929–1188`), which `runner.js:1105–1108` forwards into `forensicLogger.record()` details without structured logger key-level redaction. | **Source trace (`audit-python-bridge.md` `PY-RAW-07`, `drift-x-revalidation.md`):** `direct_x_bridge.py:109` (`re.search(r'\b429\b', msg)`) and `:1126, 1170` (`str(exc)[:500]`). |

### 1.6 X Transport, Timeline Verification & Failure Propagation (`XT-01..05`)

| Issue ID | File : Line | Severity | Reachability | Root Cause | Proof / Audit Evidence |
|---|---|---|---|---|---|
| `XT-01` | `Bot/python/direct_x_bridge.py:229–265, 646–825` | High | Reachable whenever `create_tweet` returns an incomplete/error response after dispatch and `verify_timeline()` scans the account's recent tweets | `is_recent_tweet(tweet, max_age_seconds=1800)` (`:229–265`) only checks that a tweet's timestamp is within the last 30 minutes (`-60 <= age <= 1800`); it never compares the tweet's creation timestamp (or Snowflake ID timestamp `(int(tweet_id) >> 22) + 1288834974657`) against `dispatch_started_at`! Consequently, if an identical text post was published by the same account up to 30 minutes *before* the current attempt, `verify_timeline()` falsely matches the older tweet and marks the failed new attempt `published: True` with the old URL. (Contradicts `FINDING-002` and `ADD-P5-02`.) | **Empirical offline proof (`audit-x-transport.md`, `x-synthetic-timeline.txt`):** Exercised `verify_timeline` with `FakeClient` returning a same-author matching tweet timestamped 20 minutes *before* simulated dispatch: returned `published: True, found: True, reason: 'timeline_check'`. |
| `XT-02` | `Bot/python/direct_x_bridge.py:1071–1113`; `Bot/src/directX.js:285–292`; `Bot/src/runner.js:977–980` | High | Reachable when `create_tweet` throws an exception carrying `accountFailure` (e.g., `captcha` or `banned`) and `verify_timeline` subsequently finds a matching tweet (`recoveredFromTimeline: True`) | When `create_tweet` raises an exception with `accountFailure` (`captcha`/`banned`) but `verify_timeline` recovers a matching tweet (`direct_x_bridge.py:1071–1113`), Python returns `{ published: True, recoveredFromTimeline: True, accountFailure: acct_failure, ... }`. However, in `Bot/src/directX.js:285–292`, when `result.published && result.url` is true, `DirectXAdapter.publish()` reconstructs the return object as `{ published: true, id: result.id, url: result.url, ... }` and **drops** `accountFailure`! As a result, `runner.js:977–978` (`if (result?.accountFailure)`) never sees the CAPTCHA/ban signal and fails to isolate the account. | **Empirical offline proof (`audit-x-transport.md`, `x-synthetic-propagation.txt`):** Stubbed bridge response `{ published: true, url: '...', recoveredFromTimeline: true, accountFailure: 'captcha' }` through `DirectXAdapter.publish()`: returned object omitted `accountFailure`. |
| `XT-03` | `Bot/src/telegramUi.js:859–865`; `Bot/src/runner.js:977–980` | Medium | Reachable when `runner.js:978` calls `ui.recordAccountCheck(account.id, ..., { expectedAccount: account })` after an operator concurrently edited the account's label/cookie/generation during in-flight dispatch | `TelegramUi.recordAccountCheck()` (`:859–865`) checks `sameAccountExpectation(account, options.expectedAccount)` (which compares `checkGeneration`, `cookieFile`, `enabled`, `username`, and `userId`). If any of those fields changed while the attempt was in flight, `recordAccountCheck` returns `{ applied: false, reason: 'stale_observation' }` even when `check.accountFailure === 'captcha'` or `'banned'` for the same X `userId`/`cookieFile`, and `runner.js:978` ignores the `{ applied: false }` return value. | **Source trace (`audit-x-transport.md`):** `telegramUi.js:859–865` aborts before `:867` (`const failure = check.accountFailure`) on any `sameAccountExpectation` mismatch. |
| `XT-04` | `Bot/src/queue.js:19–22, 91` | Medium | Exported `Queue.requeue(id)` method (same underlying code defect as `PERSIST-OBS-02` viewed from X transport quarantine boundary) | `Queue.requeue(id)` lacks a state guard preventing `ambiguous` items from being transitioned back to `pending`. | **Source trace (`audit-x-transport.md` `XT-04`, `audit-persistence.md` `PERSIST-OBS-02`):** `Bot/src/queue.js:19–22, 91`. |
| `XT-05` | `Bot/python/direct_x_bridge.py:1112–1129`; `Bot/src/publishOutcome.js:5–10` | Low / Medium | Reachable when `create_tweet` fails after dispatch ACK and timeline verification encounters HTTP `429` | Same boundary as `PY-RAW-04`: `direct_x_bridge.py:1112–1129` returns `ambiguous: False, rateLimit: True, retryable: True` after dispatch when timeline verification hits a rate limit. Although `publishOutcome.js:5–7` overrides this to `ambiguous: true` in `runner.js` when `dispatchEntered` is true, any direct caller of `DirectXAdapter.publish()` (or a `PERSIST-OBS-04` / `dispatchEntered` tracking fault) receives a non-ambiguous retryable status after an outbound `POST`. | **Source trace (`audit-x-transport.md` `XT-05`, `audit-python-bridge.md` `PY-RAW-04`):** `direct_x_bridge.py:1112–1129` vs `publishOutcome.js:5–7`. |

### 1.7 Docker VPN Lifecycle & Session Ceiling (`VPN-RAW-01..04`, `SESSION-RAW-01..03`)

| Issue ID | File : Line | Severity | Reachability | Root Cause | Proof / Audit Evidence |
|---|---|---|---|---|---|
| `VPN-RAW-01` | `Bot/src/dockerVpn.js:158–180, 409–413`; `Bot/docker/entrypoint.sh:89–97`; `Bot/src/runner.js:417, 480, 877` | Critical (Policy & 7-Container Host Cap Violation Risk) | Reachable via `vpnSlots.ensure()` on `/cookie_verify`, account onboarding, start readiness check, or publishing turn if a project slot container (`yj_autopost_vpn_1..5`) is missing | `ensureContainer()` (`dockerVpn.js:158–177`) inspects `yj_autopost_vpn_N`; if the container does not exist, it automatically executes `docker run -d ... -v yj_autopost_vpn_N_state:/var/lib/nordvpn -v yj_autopost_vpn_N_auth:/root/.config/nordvpn` without checking: (1) the host-wide 7-container NordVPN ceiling, or (2) that the named volumes already exist on disk with a valid `install.dat` / `moose.db` device fingerprint. If a volume is missing, Docker auto-creates an empty volume and `entrypoint.sh:89–97` runs `nordvpn login --token`, minting a new device fingerprint and risking exhaustion of the 10-device NordVPN account limit. | **Source trace (`audit-vpn-sessions.md` `VPN-RAW-01`):** `dockerVpn.js:158–177` runs `docker run` when `inspectContainer` returns null, without `docker volume inspect` or host-wide NordVPN container counting. |
| `VPN-RAW-02` | `Bot/src/dockerVpn.js:196–202, 363–398`; `Bot/src/runner.js:289, 313–315, 369–398` | High (Policy Violation Risk) | Reachable on daemon startup (`reconcileResources` at `runner.js:313–315` when an account is disabled/removed) and on account deletion (`runner.js:289`) | `destroyContainer()` (`dockerVpn.js:196–202`) executes `docker rm -f yj_autopost_vpn_N` without first running `nordvpn disconnect` or waiting for tunnel teardown, and `reconcileResources()` on startup (`runner.js:313–315, 369–388`) treats any `disabled` account's VPN slot mapping as stale (`enabled !== false` filter at `:371`) and calls `reconcile({ dryRun: false })` -> `_release()` -> `destroyContainer()`, destroying stopped or running project containers for disabled accounts and setting up future `docker run` recreations. | **Source trace (`audit-vpn-sessions.md` `VPN-RAW-02`):** `runner.js:371` filters `filter(a => a.enabled !== false)` and passes that subset to `vpnSlots.reconcile({ accountIds: activeIds, dryRun: false })` (`:381`), which calls `_release` -> `destroyContainer` (`docker rm -f` at `dockerVpn.js:201`). |
| `VPN-RAW-03` | `Bot/src/dockerVpn.js:51–54, 229–277` | Medium | Reachable whenever `rotateContainerIp()` (`dockerVpn.js:209–295`) encounters a NordVPN rate-limit or session-limit error from `docker exec ... nordvpn connect` | `execCommand()` (`dockerVpn.js:51–54`) catches all subprocess errors and throws `new Error(\`VPN Docker ${args[0] || 'command'} failed\`)`, discarding `stderr`/`stdout`. However, `rotateContainerIp()` (`:263–269`) checks `const errMsg = String(err.message || ''); if (/Too many connection attempts|Session Limit Reached/i.test(errMsg)) break;`. Because `execCommand` stripped the provider error text, the early-break guard is dead code (`errMsg` is always `"VPN Docker exec failed"`), causing the loop to hammer `nordvpn connect` across all 4 retry attempts plus fallback! | **Source trace (`audit-vpn-sessions.md` `VPN-RAW-03`):** `dockerVpn.js:53` overwrites `err.message` to `'VPN Docker exec failed'`, making the regex at `:264` unreachable. |
| `VPN-RAW-04` | `Bot/src/dockerVpn.js:209–295`; `Bot/src/runner.js:687, 705`; `Bot/src/telegramUi.js:1255, 1446` | Medium (Policy / Governance Gate) | Reachable when an account is enabled in Telegram UI (`telegramUi.js:1255, 1446`) or hits 3 failure strikes (`runner.js:687, 705`) | Enabling an account or hitting 3 strikes automatically calls `vpnManager.rotate(id)`, which executes `nordvpn connect <Country> <City>` inside the slot container to change its exit IP. Under X Developer Policy ("You may not exceed or circumvent rate limits, or any other limitations or restrictions") and the NordVPN stability rules, automatic IP rotation on account strikes or enable actions must be gated or disabled unless explicitly requested by the operator for tunnel maintenance. | **Source trace (`audit-vpn-sessions.md` `VPN-RAW-04`, `official-policy-evidence.md`):** `runner.js:687, 705` and `telegramUi.js:1255, 1446`. |
| `SESSION-RAW-01` | `Bot/src/sessionGuard.js:17–25, 60–96, 99–127, 200–257` | Medium | Active on every `DirectXAdapter.open()` (`directX.js:71–100`) | `sessionGuard.js` enforces the 5-session cap via a SQLite lease table (`Bot/data/session_leases.sqlite` or `DIRECT_X_SESSION_DB_PATH` override) plus a `/proc/*/cmdline` scan matching only `direct_x_bridge.py` or `direct_x_compat.py`. If another process overrides `DIRECT_X_SESSION_DB_PATH` (as several legacy tests do without namespace isolation) or runs in a separate PID namespace or uses `Appimage/` Playwright browsers, the guard does not see those sessions. | **Source trace (`audit-vpn-sessions.md` `SESSION-RAW-01`):** `sessionGuard.js:19–25` (`resolveDefaultDbPath`) and `:60–96` (`scanHostBridgeProcesses`). |
| `SESSION-RAW-02` | `Bot/src/sessionGuard.js:141–165, 261–277` | Medium | Reachable if `bindChildProcess()` (`:261–269`) encounters a transient SQLite `SQLITE_BUSY` error when recording `child_pid` after spawning Python | `bindChildProcess()` and `heartbeat()` (`:261–277`) wrap their `UPDATE session_leases SET child_pid = ...` in `try { ... } catch {}` and silently ignore SQLite errors. If `bindChildProcess` fails to persist `child_pid` and the parent Node process subsequently crashes while the Python child remains alive, `reconcileOrphans()` (`:141–165`) sees `ownerAlive === false` and `childAlive === false` (`row.child_pid` is null) and deletes the lease row while the orphaned Python bridge is still running. | **Source trace (`audit-vpn-sessions.md` `SESSION-RAW-02`):** `sessionGuard.js:268` (`catch {}`) combined with `:149–158` (`const childAlive = row.child_pid ? isProcessAlive(...) : false; if (!ownerAlive && !childAlive) deleteStmt.run(...)`). |
| `SESSION-RAW-03` | `Bot/src/sessionGuard.js:28–57, 141–156` | Low | Reachable on PID wraparound if a dead bridge/owner PID is reused by another `node` or `python` process | `isProcessAlive(pid, expectedKind)` in `sessionGuard.js:28–57` checks `process.kill(pid, 0)` and matches `/proc/${pid}/cmdline` against `/node/i` or `/python|direct_x/i`, without recording or comparing the Linux `/proc/${pid}/stat` field 22 `starttime` (unlike `forensicMutex.js:19–40`, which properly checks `starttime`). | **Source trace (`audit-vpn-sessions.md` `SESSION-RAW-03`):** Compare `sessionGuard.js:28–57` (no `starttime` check) with `forensicMutex.js:19–40` (`readProcStartTime`). |

### 1.8 Utilities, Security, Accounts & Entrypoints (`UTIL-RAW-01..04`, `ACC-RAW-01..04`, `ENTRY-RAW-01..02`)

| Issue ID | File : Line | Severity | Reachability | Root Cause | Proof / Audit Evidence |
|---|---|---|---|---|---|
| `UTIL-RAW-01` | `Bot/src/structuredLogger.js:34–50, 102–105` | High | Reachable on every `emitStructuredLog` / `formatStructuredLog` call across the entire Bot (`runner.js`, `telegramApi.js`, `telegramUi.js`, `forensicLogger.js`) whenever a sensitive key (`token`, `cookie`, `auth_token`, `ct0`, `password`, `secret`, `authorization`) is passed as a top-level property of `extra` | In `formatStructuredLog(event, extra)` (`structuredLogger.js:102–105`), the loop over top-level `extra` entries calls `payload[key] = sanitizeValue(val);` **without** checking `SENSITIVE_KEY_PATTERN.test(key)`! By contrast, nested objects inside `sanitizeValue()` (`:41–48`) check `if (SENSITIVE_KEY_PATTERN.test(k)) out[k] = '[REDACTED]';`. Thus, any secret passed at the top level of `extra` (e.g., `{ token: 'my-secret' }`) bypasses key-based redaction unless its value happens to match one of the narrow value regexes! (Contradicts `FINDING-028` and `ADD-P4-02` / `ADD-P6-01` universal redaction claims.) | **Empirical offline proof (`audit-utilities-security.md` `UTIL-RAW-01`):** Direct offline probe `formatStructuredLog('test', { token: 'custom_secret_marker_123', details: { token: 'custom_secret_marker_123' } })` emitted `token: "custom_secret_marker_123"` in clear text at top level while redacting `details.token: "[REDACTED]"`. |
| `UTIL-RAW-02` | `Bot/src/tableUtils.js:9–26`; `Bot/src/accountTable.js:27–34`; `Bot/src/telegramUi.js:650–684` | Low / Medium | Active on every dashboard and `/accounts` table render | `tableUtils.js:9–26` emits HTML `<table><tr><th>...` tags and aliases `preTable = richTable`, and `accountTable.js:27–34` renders 6 columns (`الحساب`, `الحالة`, `اليوم`, `المتبقي`, `إخفاق/غموض اليوم`, `آخر خطأ`), diverging from historical `Bot/AGENTS.md` instructions specifying 5 columns inside `<pre><code>` Unicode box-drawing tables. (`telegram.js:101–105` routes `rich_message` payloads to `sendRichMessage`). | **Source trace (`audit-utilities-security.md` `UTIL-RAW-02`, `findings-current-017-033.md` `FINDING-027`):** `tableUtils.js:24` (`function preTable(headers, rows) { return richTable(headers, rows); }`). |
| `UTIL-RAW-03` | `Bot/src/linkExports.js:97–138` | Low / Medium | Reachable whenever `enqueueTerminal()` is called repeatedly for an already-recorded `runId` (e.g., repeated stop callbacks or cycle completion checks) | When `enqueueTerminal()` sees an existing terminal event, delivery receipt, or outbox entry for `runId` (`:109–125`), instead of returning idempotently without mutating state, it appends a new `{ runId, suppressed: true, reason: 'duplicate_terminal_export', ... }` object to `state.linkTerminalEvents` on every invocation (`:112–123`) without pruning or bounding the array size, causing unbounded JSON state growth on repeated calls. | **Source trace (`audit-utilities-security.md` `UTIL-RAW-03`):** `linkExports.js:112–123` pushes to `state.linkTerminalEvents` inside the duplicate-suppression branch and has no retention cap on `linkTerminalEvents`. |
| `UTIL-RAW-04` | `Bot/src/accountRefresh.js:71–89, 93–117` | Low | Reachable during dashboard account refresh (`startAccountRefresh`) if `store.load()` or `recordAccountCheck` fails | `accountRefresh.js` swallows `store.load()` exceptions in its polling loop (`:98`) until the 60s timeout expires, and in `refreshOne` (`:78–89`) catches verifier errors and calls `recordAccountCheck(..., { authenticated: false })` while ignoring storage failures and marking the refresh revision completed. | **Source trace (`audit-utilities-security.md` `UTIL-RAW-04`):** `accountRefresh.js:78–89, 98`. |
| `ACC-RAW-01` | `Bot/src/accounts.js:189–235`; `Bot/src/runner.js:1496–1505` | High (CAPTCHA Manual-Only Invariant Bypass) | Reachable when an authorized operator uploads `/accounts_csv` containing an existing account ID that is currently isolated for CAPTCHA or ban | `AccountManager.replaceFromCsv()` (`accounts.js:215–235`) constructs fresh account objects from the CSV rows (defaulting `enabled: row.enabled !== 'false'`) and calls `this.replace(records)` (`:189–212`). `replace()` overwrites `state.accounts` with the newly normalized records **without merging or preserving** `needsOwnerCaptcha`, `captchaIncidentId`, `status` (`'كابتشا'` / `'محظور'`), or `enabled: false` from existing accounts with the same `id` (or `username`/`userId`)! Thus, re-importing an accounts CSV silently wipes active CAPTCHA quarantine flags and re-enables challenged accounts without manual CAPTCHA resolution. | **Empirical offline proof (`audit-accounts-entrypoints.md` `ACC-RAW-01`, `audit-csv-restrictions-review.md`, `csv-restrictions-synthetic.txt`):** In-memory `AccountManager.replaceFromCsv()` on a disabled challenged account (`needsOwnerCaptcha: true, captchaIncidentId: 'inc-1', status: 'كابتشا'`) with a CSV row for the same ID resulted in `enabled: true, status: 'نشط', needsOwnerCaptcha: false, captchaIncidentId: null`. |
| `ACC-RAW-02` | `Bot/src/accounts.js:13, 293–319`; `Bot/python/direct_x_bridge.py:266–269, 308–315`; `Bot/src/runner.js:1375–1378` | Low / Medium | Reachable if a cookie file between `1 MiB` and `10 MiB` is written via `CookieStore.write()` (`accounts.js`) or `2 MiB` via Telegram document upload (`runner.js:1376`) | Cookie size contract mismatch across layers: `accounts.js:13` sets `MAX_COOKIE_FILE_BYTES = 10 * 1024 * 1024` (10 MiB) and `runner.js:1376` allows 2 MiB document downloads, whereas `direct_x_bridge.py:266` enforces `MAX_COOKIE_BYTES = 1024 * 1024` (1 MiB). A cookie file between 1 MiB and 2 MiB passes Node onboarding validation and is stored on disk, but fails closed in Python when opening a session. | **Source trace (`audit-accounts-entrypoints.md` `ACC-RAW-02`):** `accounts.js:13` (`10 * 1024 * 1024`) vs `direct_x_bridge.py:266` (`1024 * 1024`). |
| `ACC-RAW-03` | `Bot/src/accounts.js:265–289, 293–311` | Low | Local filesystem path handling in `CookieStore.write()` and `validateCookieFile()` | `CookieStore.write()` opens the cookie directory with `O_NOFOLLOW | O_DIRECTORY` (`:268`), and `validateCookieFile()` opens the final file with `O_NOFOLLOW` (`:301`), but temp file creation and `fs.renameSync(tmp, target)` use pathname strings rather than `openat`/`renameat` relative to the directory file descriptor, and do not verify ancestor directory symlinks. | **Source trace (`audit-accounts-entrypoints.md` `ACC-RAW-03`):** `accounts.js:265–311`. |
| `ACC-RAW-04` | `Bot/src/accounts.js:47–50, 150–169` | Medium | Reachable via `AccountManager.update()` when enabling an account whose `status` is `'محظور'` or `'غير متحقق'` or whose `needsOwnerCaptcha` flag was lost by `replace()` | `accountRecord()` (`:47–50`) enforces `enabled = false` only when `needsOwnerCaptcha` is true or `isCaptchaStatus(rawStatus)` matches; it does not block `AccountManager.update(id, { enabled: true })` (`:150–169`) from overwriting `status: 'محظور'` (banned) to `'نشط'`, nor does it protect challenged accounts if `replace()` stripped `needsOwnerCaptcha`. | **Source trace (`audit-accounts-entrypoints.md` `ACC-RAW-04`, `TR-04`):** `accounts.js:47–50, 150–169`. |
| `ENTRY-RAW-01` | `Bot/src/runner.js:25–131, 268–269`; `Bot/src/singleInstance.js:23–260` | Medium | Active runtime startup vs unit test imports | Duplicate `SingleInstanceLock` classes in `runner.js` and `singleInstance.js` (same architectural defect as `RUN-01`). | **Source trace (`audit-accounts-entrypoints.md` `ENTRY-RAW-01`):** `runner.js:25–131` vs `singleInstance.js:23–140`. |
| `ENTRY-RAW-02` | `Bot/src/telegramApi.js:8–47, 52–90, 118–129` | Low / Medium | Reachable on every `TelegramApi` JSON request (`transfer()`) and API error response | In `telegramApi.js`, `downloadFile()` enforces a `maxBytes = 2 * 1024 * 1024` stream limit (`:199–238`), but `transfer()` (`:52–90`, used for all JSON Bot API calls including `getUpdates`) accumulates `chunks.push(chunk)` in memory with **no `maxBytes` cap** until socket timeout. Additionally, `apiError()` (`:8–23`) embeds raw upstream `body.description` into `error.message` and structured logs, relying only on regex redaction. | **Source trace (`audit-accounts-entrypoints.md` `ENTRY-RAW-02`):** `telegramApi.js:65` (`res.on('data', chunk => chunks.push(chunk))`) has no byte-size guard. |

### 1.9 CI, AppImage Boundary & Legacy Test Harness (`CI-01..08`)

| Issue ID | File : Line | Severity | Reachability | Root Cause | Proof / Audit Evidence |
|---|---|---|---|---|---|
| `CI-01` | `Bot/package.json:10`; `Bot/scripts/run_all_automated_tests.sh:82`; `Bot/test/live_vps_m4_operational.test.js:41–44, 75–81, 121–136, 380–400`; `Bot/test/docker_vpn_live_slots.test.js:16–109`; `Bot/test/m2_concurrency_challenge.test.js:15–80`; `Bot/test/challenger_m3_adversarial.test.js:63–95`; `Bot/test/challenger_m4_m5_adversarial.test.js:50–69`; `Bot/test/m4_lifecycle_and_recovery.test.js:219–294` | Critical (Production & VPN Safety Hazard) | Triggered immediately if any developer or CI job runs `npm test` inside `Bot/` or executes `Bot/scripts/run_all_automated_tests.sh` | `Bot/package.json` defines `"test": "node --test test/*.test.js"`, which matches all 58 test files in `Bot/test/`, including live operational tests that: (1) copy production `Bot/data/state.sqlite` without WAL consistency (`copyFileSync` at `live_vps_m4_operational.test.js:75–81`), (2) call real `rotateContainerIp` on live `yj_autopost_vpn_1` (`:121–136`), (3) send real Telegram documents using `.env.local` credentials (`:380–400`), (4) attack the live production `SingleInstanceLock` (`m2_concurrency_challenge.test.js:15–80`), and (5) run live external `curl` and `docker` commands (`docker_vpn_live_slots.test.js`, `challenger_m3_adversarial.test.js`, `challenger_m4_m5_adversarial.test.js`, `m4_lifecycle_and_recovery.test.js`). Furthermore, `Bot/TEST_RUNNER/run_suite.py:6, 38–44, 187` mutates historical evidence directories even if network-namespace preflight fails. | **Source trace (`audit-ci-appimage.md` `CI-01`, `audit-legacy-test-safety.md`):** Verified line-by-line across `Bot/package.json`, `run_all_automated_tests.sh`, and all 58 `Bot/test/*.test.js` files (`audit-legacy-node-batch-01..07`). |
| `CI-02` | `.github/workflows/verify-xposter.yml:1–65`; `.github/workflows/apply-remaining-repair.yml:1–186` | High | Every GitHub Actions push and pull_request workflow run | Both GitHub Actions workflows set `working-directory: Appimage` and run **only** `Appimage/` desktop tests and packaging jobs. **Zero** `Bot/` unit tests, Python bridge tests, or `Bot/` linting checks are executed by GitHub Actions CI! Historical claims that "GitHub CI 5/5 PASS proves Bot fixes" are completely false because CI never ran a single `Bot/` test. | **Source & CI log proof (`audit-ci-appimage.md` `CI-02`, `source-drift-ci.md`):** Both `.github/workflows/*.yml` exclusively target `Appimage`. |
| `CI-03` | `Appimage/scripts/verify-release.sh:28–41`; `.github/workflows/verify-xposter.yml:55–65` | Medium | Triggered whenever `verify-release.sh` fails during the `verify-xposter.yml` GitHub Actions job (such as PR #29 run `41782092988`) | `verify-release.sh:28–41` creates `VERIFY_HOME="$(mktemp -d /tmp/xposter-verify-home-XXXXXX)"`, writes `boot.log` inside `$VERIFY_HOME`, and registers `trap cleanup EXIT ERR` which executes `rm -rf "$VERIFY_HOME"` before the script exits! Consequently, when the subsequent GitHub Actions step (`verify-xposter.yml:55–65`, `if: failure()`) tries to upload `/tmp/xposter-verify-home-*/boot.log`, the directory has already been deleted by the trap. | **Source & CI log proof (`audit-ci-appimage.md` `CI-03`):** `verify-release.sh:31–41` deletes `$VERIFY_HOME` on `EXIT/ERR` before `actions/upload-artifact@v4` runs at `verify-xposter.yml:55–65`. |
| `CI-04` | `Appimage/scripts/verify-release.sh:111–117` | Medium | Executed at the end of every `Appimage/scripts/verify-release.sh` run | Lines `111–117` print `"Checking that real user data directories were not modified..."` and iterate over `$REAL_HOME/.config/x-poster*`, printing `"Existing path will be checked: $p"`, but **perform zero comparisons, stat checks, or assertions**! | **Source trace (`audit-ci-appimage.md` `CI-04`):** `verify-release.sh:111–117` contains only `echo` inside the `for` loop. |
| `CI-05` | `.github/workflows/apply-remaining-repair.yml:162–180` | Medium | Executed in the `audit-and-security` job of `apply-remaining-repair.yml` | Lines `162–180` run `npm audit --omit=dev --json > /tmp/npm-audit.json || true`, then parse `const v = (audit.metadata && audit.metadata.vulnerabilities) || {}; const high = v.high || 0; const critical = v.critical || 0;`. If `npm audit` returns an error JSON object (e.g., registry 5xx, network failure, or lockfile error) that lacks `metadata.vulnerabilities`, `high` and `critical` silently default to `0` and the security audit gate passes! | **Source trace (`audit-ci-appimage.md` `CI-05`):** `apply-remaining-repair.yml:166–170` fails open when `audit.metadata?.vulnerabilities` is undefined. |
| `CI-06` | `Bot/scripts/run_all_automated_tests.sh:54–56, 65–67, 82–84, 96–108, 184` | Medium | Executed when running `Bot/scripts/run_all_automated_tests.sh` | When `grep` fails to extract a test count from stdout (or when `unshare`/`TEST_RUNNER` is missing at `:106–108`), `run_all_automated_tests.sh` falls back to hardcoded fabricated numbers (`${PY_COUNT1:-126}`, `${PY_COUNT2:-7}`, `${PASSED_COUNT:-181}`, `${NETNS_COUNT:-42}`), skips missing Tier 3 without incrementing `TOTAL_FAILED`, and prints `"100% Reliability"` at `:184`. | **Source trace (`audit-ci-appimage.md` `CI-06`):** `run_all_automated_tests.sh:56, 67, 84, 100, 107, 184`. |
| `CI-07` | `Appimage/scripts/verify-release.sh:94–108`; `.github/workflows/verify-xposter.yml:40–54` | Medium | Executed during AppImage extracted windowed boot verification in `verify-release.sh` and `apply-remaining-repair.yml` |1) `verify-release.sh:94–108` runs `timeout 45s xvfb-run -a ./squashfs-root/xposter` and accepts `BOOT_EXIT -eq 0` alongside `124`/`137` (`if [ "$BOOT_EXIT" -ne 0 ] && [ "$BOOT_EXIT" -ne 124 ] && [ "$BOOT_EXIT" -ne 137 ]`), meaning an immediate crash/exit with code `0` after 1 second passes the "45-second endurance boot" check. 2) On GitHub Actions Ubuntu runners under Xvfb, Chromium GPU/zygote launch intermittently fails with `GPU launch error_code=1002` / `FATAL:gpu_data_manager_impl_private.cc:415 GPU process isn't usable` (`BOOT_EXIT=5`), as observed in PR #29 run `41782092988`, because `--no-sandbox --disable-gpu` flags are not passed to the extracted AppImage binary during headless Xvfb verification. | **Source & CI log proof (`audit-ci-appimage.md` `CI-07`, `source-drift-ci.md`):** `verify-release.sh:94–108` and GitHub Actions run `41782092988` job `126416216292`. |
| `CI-08` | `.github/workflows/apply-remaining-repair.yml:185` | Low | Executed on artifact upload in `apply-remaining-repair.yml` | Line `185` hardcodes the uploaded artifact name as `name: YJAutoPostOnX-5.20.0-AppImage`, which is stale relative to `Appimage/package.json` version `5.21.0`. | **Source trace (`audit-ci-appimage.md` `CI-08`):** `apply-remaining-repair.yml:185`. |

---

---

## Part 2: Complete Ledger of All 30 Quarantined `ambiguous` Queue Items (`state.sqlite`)

- **Source of Truth:** `/root/Projects/YJAutoPostOnX/Bot/data/state.sqlite` (verified read-only in `drift-runtime.md` and backed up in `state.sqlite.online-backup`, SHA-256 `930ef0ed9419644e2463d656dbf262cecf8722638d88e9b34376087ff59f18df`) and `Bot/Reports/M14_AMBIGUOUS_30_STATUS.json` (`27314f92a707222c8b3a7dcb76490315005c2430e6e6932e86ee543a620b37a6`).
- **Mandatory Quarantine Invariant:**
  - All **30** items below are in `state === 'ambiguous'` with `requeueApproved: false`.
  - **29 of 30** items have `evidenceStatus: 'REVIEW_REQUIRED'` and `decision: 'QUARANTINE_RETAINED_REVIEW_REQUIRED'`.
  - **1 of 30** items (`53d0f458-3144-4e89-a1af-202a8893afc6`, Index #9) has `evidenceStatus: 'EVIDENCE_COMPLETE'` and `decision: 'PROVEN_PUBLISHED_SETTLEMENT_DESIGNED'`, and remains fenced in `state: 'ambiguous'` until explicit owner sign-off (`ALLOW_PROD_53D0_SETTLEMENT=1`).
  - Zero items may ever be bulk-requeued to `pending` (`P01-T04` adds a hard code-level throw `AMBIGUOUS_REQUEUE_FORBIDDEN` in `Bot/src/queue.js`).

| # | Item UUID | Account ID & Handle | Attempt Timestamp (UTC) | `dispatchEntered` (Recorded) | Text SHA-256 Prefix | Forensic Events | Evidence Status | Quarantine Decision | `requeueApproved` |
|---:|---|---|---|---|---|---|---|---|---|
| 1 | `47da5e8a-9c24-45ed-ae64-4d3c163a8b9a` | `x-ab22678a0fc05660b440` (`@emiehg`) | `2026-11-01T02:52:19.402Z` | `false` | `db98f325c936affa` | `post_ambiguous` | `REVIEW_REQUIRED` | `QUARANTINE_RETAINED_REVIEW_REQUIRED` | `false` |
| 2 | `8b9481aa-4723-4b0b-bfc4-b7fdff6730e3` | `x-930e0054b395228aefa9` (`@crytpokingxvo8`) | `2026-11-01T16:15:11.989Z` | `false` | `ac14607e03970958` | `post_ambiguous` | `REVIEW_REQUIRED` | `QUARANTINE_RETAINED_REVIEW_REQUIRED` | `false` |
| 3 | `10afc79e-7634-4149-acd1-90277ff53b1e` | `x-ab22678a0fc05660b440` (`@emiehg`) | `2026-11-01T07:13:20.854Z` | `false` | `4bc480b3813a784a` | `post_ambiguous` | `REVIEW_REQUIRED` | `QUARANTINE_RETAINED_REVIEW_REQUIRED` | `false` |
| 4 | `3719dfde-c7b6-446f-a8ba-211f48b92ec2` | `x-2aa7928dd26217e0939c` (`@okasanbq`) | `2026-11-01T07:13:53.375Z` | `true` | `744368ec42f3fd4f` | `post_error,post_ambiguous` | `REVIEW_REQUIRED` | `QUARANTINE_RETAINED_REVIEW_REQUIRED` | `false` |
| 5 | `c1eecbd3-704d-43ba-8306-93a1a15b4350` | `x-ab22678a0fc05660b440` (`@emiehg`) | `2026-11-01T16:15:26.237Z` | `true` | `ae2167b03b659cf9` | `post_error,post_ambiguous` | `REVIEW_REQUIRED` | `QUARANTINE_RETAINED_REVIEW_REQUIRED` | `false` |
| 6 | `a589288f-19af-4cbb-bc24-90a07940c394` | `x-2aa7928dd26217e0939c` (`@okasanbq`) | `2026-11-01T19:42:33.830Z` | `false` | `c2106653529d99ac` | `post_ambiguous` | `REVIEW_REQUIRED` | `QUARANTINE_RETAINED_REVIEW_REQUIRED` | `false` |
| 7 | `5ffd64c2-713c-4768-976d-d8d0b0a1673e` | `x-930e0054b395228aefa9` (`@crytpokingxvo8`) | `2026-11-01T19:50:31.251Z` | `false` | `5626438000c57641` | `post_ambiguous` | `REVIEW_REQUIRED` | `QUARANTINE_RETAINED_REVIEW_REQUIRED` | `false` |
| 8 | `5e5f91ab-2841-4848-a035-4c1c8a8df197` | `x-ab22678a0fc05660b440` (`@emiehg`) | `2026-11-01T19:50:43.266Z` | `false` | `75210865e9acb46a` | `post_ambiguous` | `REVIEW_REQUIRED` | `QUARANTINE_RETAINED_REVIEW_REQUIRED` | `false` |
| 9 | `53d0f458-3144-4e89-a1af-202a8893afc6` | `x-930e0054b395228aefa9` (`@crytpokingxvo8`) | `2026-11-01T19:50:53.963Z` | `true` | `6175d09d7a46563c` | `post_error,post_ambiguous` | `EVIDENCE_COMPLETE` | `PROVEN_PUBLISHED_SETTLEMENT_DESIGNED` | `false` |
| 10 | `34ed9685-4513-4ff8-afb6-f98e45204f9d` | `x-ab22678a0fc05660b440` (`@emiehg`) | `2026-11-01T19:55:04.144Z` | `false` | `2cda42cbbaaf7f6d` | `post_ambiguous` | `REVIEW_REQUIRED` | `QUARANTINE_RETAINED_REVIEW_REQUIRED` | `false` |
| 11 | `f75e4f8d-c5ed-44b0-8aa9-77af63be85dc` | `x-ab22678a0fc05660b440` (`@emiehg`) | `2026-11-02T08:36:52.898Z` | `false` | `fa0e91e907323c48` | `post_ambiguous` | `REVIEW_REQUIRED` | `QUARANTINE_RETAINED_REVIEW_REQUIRED` | `false` |
| 12 | `bd12d092-4480-4b9f-a41d-0324ec77b317` | `x-ab22678a0fc05660b440` (`@emiehg`) | `2026-11-02T08:41:41.624Z` | `false` | `81e53979699d7285` | `post_ambiguous` | `REVIEW_REQUIRED` | `QUARANTINE_RETAINED_REVIEW_REQUIRED` | `false` |
| 13 | `fa1f2749-8496-4d20-b6e4-d6fad4a5de0b` | `x-ab22678a0fc05660b440` (`@emiehg`) | `2026-11-02T08:51:35.461Z` | `false` | `5a25677ebb327cda` | `post_ambiguous` | `REVIEW_REQUIRED` | `QUARANTINE_RETAINED_REVIEW_REQUIRED` | `false` |
| 14 | `f3a3ff40-eda0-4d8f-9df4-3fd1c024ee23` | `x-ab22678a0fc05660b440` (`@emiehg`) | `2026-11-02T19:10:10.342Z` | `false` | `163766bc8b80feab` | `post_ambiguous,account_failure_strike` | `REVIEW_REQUIRED` | `QUARANTINE_RETAINED_REVIEW_REQUIRED` | `false` |
| 15 | `d0f523a4-46fb-47f4-b28a-77253c16ec12` | `x-930e0054b395228aefa9` (`@crytpokingxvo8`) | `2026-11-02T19:13:33.005Z` | `false` | `1769e581fdc5bc14` | `post_ambiguous,account_failure_strike` | `REVIEW_REQUIRED` | `QUARANTINE_RETAINED_REVIEW_REQUIRED` | `false` |
| 16 | `37e2e293-35b8-4d78-aed9-d0e79ea1a1ff` | `x-ab22678a0fc05660b440` (`@emiehg`) | `2026-11-02T19:17:58.498Z` | `false` | `33ddc5d68f37e20d` | `post_ambiguous,account_failure_strike` | `REVIEW_REQUIRED` | `QUARANTINE_RETAINED_REVIEW_REQUIRED` | `false` |
| 17 | `9680f8c1-d108-4658-9a53-fa6be6c54593` | `x-ab22678a0fc05660b440` (`@emiehg`) | `2026-11-02T19:25:28.282Z` | `false` | `76edb86a55bf3c92` | `post_ambiguous,account_isolated_3_failures` | `REVIEW_REQUIRED` | `QUARANTINE_RETAINED_REVIEW_REQUIRED` | `false` |
| 18 | `5ebeb53f-db97-4c81-b34c-069d4406d18a` | `x-23d02ee683cbc043ff16` (`@menalobq`) | `2026-11-02T20:31:43.692Z` | `false` | `bfe91671fc0369e5` | `post_ambiguous,account_failure_strike` | `REVIEW_REQUIRED` | `QUARANTINE_RETAINED_REVIEW_REQUIRED` | `false` |
| 19 | `99eb4ba0-86b1-47e1-94e8-08682453c749` | `x-a55ef01cbf656b2e7410` (`@marcosvhv`) | `2026-11-02T21:02:02.671Z` | `false` | `8913778e98fcc804` | `post_ambiguous,account_failure_strike` | `REVIEW_REQUIRED` | `QUARANTINE_RETAINED_REVIEW_REQUIRED` | `false` |
| 20 | `5b443dce-b8b6-47e1-923a-54a3624bb409` | `x-ab22678a0fc05660b440` (`@emiehg`) | `2026-11-02T21:37:21.161Z` | `false` | `7d054165ced13a87` | `post_ambiguous,account_failure_strike` | `REVIEW_REQUIRED` | `QUARANTINE_RETAINED_REVIEW_REQUIRED` | `false` |
| 21 | `99f420e4-9e24-4767-aa84-5351f10ba075` | `x-a55ef01cbf656b2e7410` (`@marcosvhv`) | `2026-11-02T21:39:31.158Z` | `false` | `6ca35382cae135b2` | `post_ambiguous,account_failure_strike` | `REVIEW_REQUIRED` | `QUARANTINE_RETAINED_REVIEW_REQUIRED` | `false` |
| 22 | `364f38bc-0ea7-4118-be5d-c6142b694d58` | `x-ab22678a0fc05660b440` (`@emiehg`) | `2026-11-02T21:41:50.250Z` | `false` | `8dea9e0f48b86a10` | `post_ambiguous,account_failure_strike` | `REVIEW_REQUIRED` | `QUARANTINE_RETAINED_REVIEW_REQUIRED` | `false` |
| 23 | `087d29f1-050f-4bb5-ab93-23054827e56b` | `x-930e0054b395228aefa9` (`@crytpokingxvo8`) | `2026-11-03T02:43:43.502Z` | `false` | `f4528129906a42f9` | `post_ambiguous,account_failure_strike` | `REVIEW_REQUIRED` | `QUARANTINE_RETAINED_REVIEW_REQUIRED` | `false` |
| 24 | `427391bc-8bdc-4063-ad05-3afd12bc3348` | `x-a55ef01cbf656b2e7410` (`@marcosvhv`) | `2026-11-03T02:45:23.959Z` | `false` | `065360eb5bc5e55e` | `post_ambiguous,account_failure_strike` | `REVIEW_REQUIRED` | `QUARANTINE_RETAINED_REVIEW_REQUIRED` | `false` |
| 25 | `afccd027-df63-4036-a40b-3bae30677a23` | `x-86ef47c7166eaeb29e1a` (`@kaniabq`) | `2026-11-03T02:49:50.148Z` | `false` | `77a36ae181760eaa` | `post_ambiguous,account_failure_strike` | `REVIEW_REQUIRED` | `QUARANTINE_RETAINED_REVIEW_REQUIRED` | `false` |
| 26 | `ae4a1631-0d1e-4081-b4c8-5ba12b318ed4` | `x-a55ef01cbf656b2e7410` (`@marcosvhv`) | `2026-11-03T02:56:52.537Z` | `false` | `6600f74da9f72910` | `post_ambiguous,account_failure_strike` | `REVIEW_REQUIRED` | `QUARANTINE_RETAINED_REVIEW_REQUIRED` | `false` |
| 27 | `3a982de7-76b0-450f-a712-e10861b26dda` | `x-ab22678a0fc05660b440` (`@emiehg`) | `2026-11-03T03:02:24.194Z` | `false` | `894a404d1d7bd5c2` | `post_ambiguous,account_failure_strike` | `REVIEW_REQUIRED` | `QUARANTINE_RETAINED_REVIEW_REQUIRED` | `false` |
| 28 | `4d9df18c-075e-4e25-97c5-8b524ee5624f` | `x-ab22678a0fc05660b440` (`@emiehg`) | `2026-11-03T04:17:05.726Z` | `false` | `123acd7fb0f399ec` | `post_ambiguous,account_failure_strike` | `REVIEW_REQUIRED` | `QUARANTINE_RETAINED_REVIEW_REQUIRED` | `false` |
| 29 | `6bd6d6cf-f275-4ac2-9042-a0886d958c41` | `x-86ef47c7166eaeb29e1a` (`@kaniabq`) | `2026-11-03T04:18:08.401Z` | `false` | `3c293d05d45c5a24` | `post_ambiguous,account_failure_strike` | `REVIEW_REQUIRED` | `QUARANTINE_RETAINED_REVIEW_REQUIRED` | `false` |
| 30 | `5f375ded-885f-4a75-8d16-f1d90ede5917` | `x-ab22678a0fc05660b440` (`@emiehg`) | `2026-11-03T04:26:28.474Z` | `false` | `01daa5c37e9ecec4` | `post_ambiguous,account_failure_strike` | `REVIEW_REQUIRED` | `QUARANTINE_RETAINED_REVIEW_REQUIRED` | `false` |

---

## Part 3: Fenced Item `53d0f458-3144-4e89-a1af-202a8893afc6` Forensic Provenance & Settlement Contract

- **Item ID:** `53d0f458-3144-4e89-a1af-202a8893afc6` (Queue Index #9 among the 30 quarantined ambiguous items)
- **Assigned Account:** `@crytpokingxvo8` (`accountId: x-930e0054b395228aefa9`)
- **Attempt Timestamp:** `2026-11-01T19:50:53.963Z` (`dispatchEntered: true`)
- **Full 64-Character Payload Text SHA-256:** `6175d09d7a46563c051342f26ec9559a88689ccc3644eee690fdc95fc116133b` (Prefix: `6175d09d7a46563c`)
- **Corroborated Live X Tweet:**
  - **Candidate URL:** `https://x.com/crytpokingxvo8/status/2116981347772498219`
  - **Tweet Snowflake ID:** `2116981347772498219`
  - **Snowflake Decoded Creation Timestamp:** `2026-11-01T19:50:59.577Z` (`+5.614s` after `attemptTimestamp`, matching `@crytpokingxvo8` author ID and exact 64-character SHA-256 text digest)
- **Current Production State:** `state: 'ambiguous'` (strictly untouched in production `/root/Projects/YJAutoPostOnX/Bot/data/state.sqlite`)
- **Guarded Settlement Utility (`Bot/scripts/settle_item_53d0f458.js`):**
  - Retained permanently as a Category E/F forensic utility (`SHA-256: 8f6974bdf23eb2359b3b7f4cb2909e4b5b8ce569c75faf6467b29805fd0171d6`).
  - Defaults to read-only `--dry-run`.
  - Enforces Compare-And-Set (CAS) verification of `id === '53d0f458-3144-4e89-a1af-202a8893afc6'`, `state === 'ambiguous'`, `accountId === 'x-930e0054b395228aefa9'`, and full 64-char SHA-256 `6175d09d7a46563c051342f26ec9559a88689ccc3644eee690fdc95fc116133b`.
  - Reconciles `2026-11-01` Riyadh quota strictly from baseline `9 -> 10` (or idempotent no-op if already `10`, failing closed with `QUOTA_RECONCILIATION_AMBIGUOUS` on any other value), archives `item.attempt` to `item.archivedAttempt`, and writes a transactional forensic event into `state.pendingForensicOutbox`.
  - **Execution Gate:** Must NEVER be run with `--apply` against production `state.sqlite` until explicit owner sign-off (`P08-T01`, `ADD-P1-01`).


---

# Section 5: Post-Audit Live Master TODO (`P01`–`P08` Engineering Phases & Tasks `P01-T01`..`P08-T01`) & Bidirectional Traceability Matrix

## 5.1 Master Task Summary & Priority/Status Matrix

| Phase | Task ID | Priority | Status | Dependencies | Target Files | Raw Findings Covered | Historical IDs Covered |
|---|---|---|---|---|---|---|---|
| **`P01`** | **`P01-T01`** | **P0 (Critical)** | `TESTED_PASS` | None | `Bot/src/sqliteStore.js`, `Bot/src/runner.js`, `Bot/src/queue.js` | `PERSIST-OBS-04`, `RUN-02` | `FINDING-003`, `FINDING-006`, `FINDING-009`, `FINDING-023`, `FINDING-024`, `FINDING-025`, `ADD-P1-02`, `ADD-P3-01` |
| **`P01`** | **`P01-T02`** | **P0 (High)** | `TESTED_PASS` | `P01-T01` | `Bot/src/sqliteStore.js`, `Bot/src/forensicLogger.js`, `Bot/src/sessionGuard.js` | `PERSIST-OBS-05` | `ADD-P3-01`, `ADD-P6-01` |
| **`P01`** | **`P01-T03`** | **P1 (High)** | `TESTED_PASS` | `P01-T01` | `Bot/src/forensicLogger.js`, `Bot/src/runner.js` | `PERSIST-OBS-01`, `PERSIST-OBS-03`, `RUN-05` | `FINDING-028`, `FINDING-030`, `ADD-P3-02`, `ADD-P6-01` |
| **`P01`** | **`P01-T04`** | **P1 (Medium)** | `TESTED_PASS` | `P01-T01` | `Bot/src/queue.js` | `PERSIST-OBS-02`, `XT-04` | `FINDING-003`, `ADD-P1-01` |
| **`P01`** | **`P01-T05`** | **P1 (High)** | `TESTED_PASS` | `P01-T01` | `Bot/src/structuredLogger.js`, `Bot/src/linkExports.js` | `UTIL-RAW-01`, `UTIL-RAW-03` | `FINDING-006`, `FINDING-028`, `ADD-P2-03`, `ADD-P4-02`, `ADD-P6-01` |
| **`P02`** | **`P02-T01`** | **P0 (High)** | `TESTED_PASS` | `P01` | `Bot/python/direct_x_bridge.py`, `Bot/src/directX.js` | `PY-RAW-01`, `PY-RAW-03` | `FINDING-007`, `FINDING-010` |
| **`P02`** | **`P02-T02`** | **P0 (High)** | `TESTED_PASS` | `P01` | `Bot/python/direct_x_bridge.py`, `Bot/src/publishOutcome.js` | `PY-RAW-02`, `PY-RAW-04`, `XT-05` | `FINDING-001`, `FINDING-003`, `FINDING-011`, `ADD-P1-02`, `ADD-P1-04` |
| **`P02`** | **`P02-T03`** | **P0 (High)** | `TESTED_PASS` | `P01` | `Bot/python/direct_x_bridge.py` | `XT-01` | `FINDING-002`, `FINDING-011`, `ADD-P1-04`, `ADD-P5-02` |
| **`P02`** | **`P02-T04`** | **P0 (High)** | `TESTED_PASS` | `P01` | `Bot/src/directX.js`, `Bot/src/runner.js`, `Bot/src/telegramUi.js` | `XT-02`, `XT-03` | `FINDING-010`, `ADD-P1-04`, `ADD-P4-02` |
| **`P02`** | **`P02-T05`** | **P1 (Medium)** | `TESTED_PASS` | `P01` | `Bot/src/runner.js`, `Bot/src/queue.js` | `RUN-04` | `FINDING-011`, `FINDING-026`, `ADD-P1-03`, `ADD-P3-02`, `ADD-P4-03`, `ADD-P5-01`, `ADD-P5-02` |
| **`P02`** | **`P02-T06`** | **P1 (Medium)** | `TESTED_PASS` | `P01` | `Bot/python/direct_x_bridge.py`, `Bot/python/direct_x_compat.py`, `Bot/python/README.md` | `PY-RAW-05`, `PY-RAW-06`, `PY-RAW-07` | `FINDING-008`, `FINDING-012`, `FINDING-020`, `FINDING-021`, `ADD-P4-01`, `ADD-P4-02` |
| **`P03`** | **`P03-T01`** | **P0 (High)** | `TESTED_PASS` | `P01`, `P02` | `Bot/src/accounts.js`, `Bot/src/telegramUi.js`, `Bot/src/telegramFlows.js`, `Bot/src/runner.js` | `TR-04`, `TR-06`, `ACC-RAW-04` | `FINDING-019` |
| **`P03`** | **`P03-T02`** | **P1 (Medium)** | `TESTED_PASS` | `P03-T01` | `Bot/src/telegramUi.js` | `UI-02`, `UI-03` | `FINDING-019` |
| **`P03`** | **`P03-T03`** | **P0 (High)** | `TESTED_PASS` | `P03-T01` | `Bot/src/accounts.js`, `Bot/src/runner.js`, `Bot/src/telegramUi.js` | `ACC-RAW-01`, `RUN-03` | `FINDING-010`, `FINDING-017` |
| **`P03`** | **`P03-T04`** | **P2 (Low/Med)** | `TESTED_PASS` | `P03-T01` | `Bot/src/accounts.js`, `Bot/src/runner.js`, `Bot/src/telegramFlows.js` | `ACC-RAW-02`, `ACC-RAW-03` | `FINDING-014` |
| **`P04`** | **`P04-T01`** | **P0 (Critical)** | `TESTED_PASS` | `P01`, `P03` | `Bot/src/dockerVpn.js`, `Bot/src/runner.js`, `Bot/src/telegramUi.js` | `VPN-RAW-01`, `VPN-RAW-02`, `TR-05` | `FINDING-031`, `ADD-P4-04` |
| **`P04`** | **`P04-T02`** | **P1 (Medium)** | `TESTED_PASS` | `P04-T01` | `Bot/src/dockerVpn.js`, `Bot/src/runner.js`, `Bot/src/telegramUi.js` | `VPN-RAW-03`, `VPN-RAW-04`, `UI-01` | `FINDING-015`, `ADD-P4-04` |
| **`P04`** | **`P04-T03`** | **P1 (Medium)** | `TESTED_PASS` | `P01` | `Bot/src/sessionGuard.js`, `Bot/src/directX.js` | `SESSION-RAW-01`, `SESSION-RAW-02`, `SESSION-RAW-03` | `FINDING-021`, `ADD-P3-03` |
| **`P05`** | **`P05-T01`** | **P1 (Medium)** | `TESTED_PASS` | `P01`, `P03`, `P04` | `Bot/src/singleInstance.js`, `Bot/src/runner.js`, `Bot/systemd/yj-telegram-bot.user.service` | `RUN-01`, `ENTRY-RAW-01`, `RUN-06`, `TR-07` | `FINDING-004`, `FINDING-005`, `ADD-P3-03` |
| **`P05`** | **`P05-T02`** | **P1 (Medium)** | `TESTED_PASS` | `P05-T01` | `Bot/src/runner.js`, `Bot/src/telegramUi.js`, `Bot/src/telegramApi.js`, `Bot/src/tableUtils.js`, `Bot/src/accountTable.js`, `Bot/src/accountRefresh.js` | `TR-01`, `TR-02`, `TR-03`, `ENTRY-RAW-02`, `UI-04`, `UTIL-RAW-02`, `UTIL-RAW-04` | `FINDING-016`, `FINDING-018`, `FINDING-022`, `FINDING-027`, `FINDING-029`, `ADD-P2-01`, `ADD-P2-02`, `ADD-P2-03` |
| **`P06`** | **`P06-T01`** | **P0 (Critical)** | `TESTED_PASS` | `P01`–`P05` | `Bot/package.json`, `Bot/test/*`, `Bot/scripts/*`, `Bot/TEST_RUNNER/*` | `CI-01`, `CI-06` | `FINDING-005`, `FINDING-016`, `FINDING-020`, `FINDING-026`, `FINDING-029`, `ADD-P1-03`, `ADD-P4-03`, `ADD-P6-03` |
| **`P07`** | **`P07-T01`** | **P0 (High)** | `TESTED_PASS` | `P06` | `.github/workflows/verify-xposter.yml`, `.github/workflows/apply-remaining-repair.yml`, `Appimage/scripts/verify-release.sh`, `Appimage/dev/main.js` | `CI-02`, `CI-03`, `CI-04`, `CI-05`, `CI-07`, `CI-08` | `FINDING-012`, `FINDING-013`, `FINDING-023`, `FINDING-032`, `FINDING-033`, `ADD-P6-03` |
| **`P08`** | **`P08-T01`** | **P1 (Gov)** | `TESTED_PASS (Nonposting Verified; Live X BLOCKED by Policy; 53d0 PENDING_APPROVAL)` | `P01`–`P07` | `Bot/Reports/Old reports.md`, `Bot/scripts/*`, `Bot/systemd/yj-telegram-bot.service` | All 59 Raw Findings | `ADD-P1-01`, `ADD-P2-02`, `ADD-P3-03`, `ADD-P6-02`, `ADD-P6-03`, `ADD-P6-04` |

---

# Part 2: Dependency-Ordered Post-Audit Master TODO (`P01`–`P08`)

## Phase Execution Dependency Graph

```
[P01: SQLite, CAS, Outbox & Redaction Foundation]
       |
       +-------------------+-------------------+
       |                                       |
       v                                       v
[P02: Python Bridge, X Transport        [P03: CAPTCHA Manual-Only Invariant,
      & Dispatch Fencing]                     Account Guards & Cookie Bounds]
       |                                       |
       +-------------------+-------------------+
                           |
                           v
            [P04: NordVPN 7-Container Cap,
                  Slot Lifecycle & Session Guard]
                           |
                           v
            [P05: Telegram Runtime, Routing,
                  Scheduler & Shutdown Cleanup]
                           |
                           v
            [P06: Legacy Test Tree Migration &
                  Offline Regression Verification]
                           |
                           v
            [P07: GitHub Actions CI & AppImage
                  Release Gate Repair]
                           |
                           v
            [P08: Report Consolidation, Quarantine
                  Governance & Operational Sign-Off]
```

---

## `P01` — SQLite Transactional Integrity, CAS Retry-Safe Mutators, Outbox Durability & Secret-Safe Logging

**Dependencies:** None (Foundational persistence & logging layer; must be completed first).

| Task ID | Phase 1 Raw Findings | Historical Cross-Refs | Impacted Files | Root-Cause Evidence & Required Engineering Changes | Acceptance Criteria |
|---|---|---|---|---|---|
| **`P01-T01`** | `PERSIST-OBS-04`, `RUN-02` | `FINDING-003`, `FINDING-006`, `FINDING-009`, `FINDING-023`, `FINDING-024`, `FINDING-025`, `ADD-P3-01` | `Bot/src/sqliteStore.js`, `Bot/src/runner.js`, `Bot/src/queue.js` | **Root Cause:** `SqliteStore.update()` (`sqliteStore.js:237–262`) runs `await mutator(draft)` outside `BEGIN IMMEDIATE` and re-runs the mutator on `REVISION_CONFLICT` while callers (`runner.js:143–163` `claimCycleItem`, `runner.js:949–968` `onDispatch`, `runner.js:1005–1055` settlement, `queue.js:55, 79–87`) set outer `let` flags (`dispatchReady`, `result.claimed`, `transitioned`, `added`) without resetting them on retry.<br>**Fix:** (1) In `SqliteStore.update()`, execute synchronous mutators directly inside `BEGIN IMMEDIATE` (reading the latest `SELECT json, revision FROM state WHERE id = 1` after acquiring the immediate write lock) and allow `mutator(draft)` to return `{ state, result }` or reset caller state at the start of every attempt. (2) In `runner.js` (`claimCycleItem`, `onDispatch`, post-publish settlement, `handleAccountFailure`, `catch`/`finally`) and `queue.js` (`enqueue`, `replacePending`), reset all outer outcome flags/counters at the very first line inside the `store.update(s => { ... })` callback. | 1. Running `cas-mechanism-probe` with a competing connection committing `enabled=false` produces `dispatchReady === false` and `durablePhase === 'claimed'`.<br>2. Async mutators still throw `TRANSACTION_ASYNC_YIELD`.<br>3. `load()` continues using `BEGIN` (deferred) and `update()` uses `BEGIN IMMEDIATE`. |
| **`P01-T02`** | `PERSIST-OBS-05` | `ADD-P3-01`, `ADD-P6-01` | `Bot/src/sqliteStore.js`, `Bot/src/forensicLogger.js`, `Bot/src/sessionGuard.js` | **Root Cause:** `resolveProductionDbPath()` (`sqliteStore.js:25–40`) only resolves `../data/state.sqlite` relative to `__dirname`, failing to block test mutations from secondary git worktrees targeting `/root/Projects/YJAutoPostOnX/Bot/data/state.sqlite`.<br>**Fix:** Guard both `path.resolve(__dirname, '../data/...')` AND canonical `/root/Projects/YJAutoPostOnX/Bot/data/...` (plus `BOT_PRODUCTION_DATA_DIR` if set), comparing both normalized paths and `fs.statSync` `dev:ino` identifiers across `sqliteStore.js`, `forensicLogger.js`, and `sessionGuard.js`. |Guard probe invoked from `/root/Projects/YJAutoPostOnX-surgical-audit` with `NODE_ENV=test` targeting `/root/Projects/YJAutoPostOnX/Bot/data/state.sqlite` throws `PRODUCTION_DB_MUTATION_FORBIDDEN`. |
| **`P01-T03`** | `PERSIST-OBS-01`, `PERSIST-OBS-03`, `RUN-05` | `FINDING-028`, `FINDING-030`, `ADD-P3-02`, `ADD-P6-01` | `Bot/src/forensicLogger.js`, `Bot/src/runner.js` | **Root Cause:** (1) `ForensicLogger.reconcile()` (`forensicLogger.js:334–372`) catches `store.load()` and JSONL read errors, defaults to `[]`, and overwrites `state.forensicLogs` and `forensic.jsonl` (`1 -> 0` data wipe). (2) `ForensicLogger.record()` (`:107–151`) bypasses `state.pendingForensicOutbox`. (3) `runner.js:737, 1075, 1094` fires `forensicLogger.record()` without tracking promises for shutdown drain.<br>**Fix:** (1) Make `reconcile()` fail closed (rethrow on `store.load()` error or non-`ENOENT` file read error without modifying store or file) and add parent directory `fsync` after `rename` in `reconcile()` and `prune()`. (2) Have `record()` insert the event into both `state.forensicLogs` and `state.pendingForensicOutbox` inside `store.update()`, then flush via `flushOutbox()`. (3) Track all `forensicLogger.record()` promises in `runner.js` and await them in `finally` before `bot.store.close()`. | 1. Injected `store.load()` or `fs.readFile` error in `reconcile()` throws without altering existing SQLite or JSONL records.<br>2. Simulated crash between `record()` SQLite commit and JSONL append is replayed on next `flushOutbox()`.<br>3. Shutdown drains in-flight forensic writes before closing `SqliteStore`. |
| **`P01-T04`** | `PERSIST-OBS-02`, `XT-04` | `FINDING-003`, `ADD-P1-01` | `Bot/src/queue.js` | **Root Cause:** `Queue.requeue(id)` (`queue.js:19–22, 91`) transitions any non-cancelled item—including `ambiguous`—to `pending`.<br>**Fix:** Remove `'ambiguous'` and `'published'` from `Queue.requeue` allowed source states and throw an explicit `AMBIGUOUS_REQUEUE_FORBIDDEN` error if `item.state === 'ambiguous'` (or `published`). | Calling `queue.requeue(id)` on an `ambiguous` or `published` item throws `AMBIGUOUS_REQUEUE_FORBIDDEN` and leaves `item.state` unchanged in SQLite. |
| **`P01-T05`** | `UTIL-RAW-01`, `UTIL-RAW-03` | `FINDING-006`, `FINDING-028`, `ADD-P2-03`, `ADD-P4-02`, `ADD-P6-01` | `Bot/src/structuredLogger.js`, `Bot/src/linkExports.js` | **Root Cause:** (1) `formatStructuredLog()` (`structuredLogger.js:102–105`) calls `sanitizeValue(val)` on top-level `extra` properties without checking `SENSITIVE_KEY_PATTERN.test(key)`. (2) `linkExports.js:112–123` (`enqueueTerminal`) appends a new suppressed record to `state.linkTerminalEvents` on every duplicate call without bound.<br>**Fix:** (1) Check `SENSITIVE_KEY_PATTERN.test(key)` on top-level `extra` keys in `formatStructuredLog()` and redact values to `'[REDACTED]'`. (2) In `linkExports.js:109–125`, if a suppressed or active terminal event already exists for `runId`, return `{ queued: false, suppressed: true }` idempotently without pushing duplicate entries, and cap `state.linkTerminalEvents` and `state.linkDeliveries` to the most recent 200 entries. | 1. `formatStructuredLog('evt', { token: 'abc', cookie: 'xyz' })` redacts both top-level `token` and `cookie` to `'[REDACTED]'`.<br>2. Calling `enqueueTerminal` 20 times for the same `runId` appends at most 1 suppressed record. |

---

## `P02` — Dispatch Fencing, Python Bridge Hardening, Snowflake Timeline Attribution & Restriction Propagation

**Dependencies:** `P01` (`P01-T01`, `P01-T04`, `P01-T05`).

| Task ID | Phase 1 Raw Findings | Historical Cross-Refs | Impacted Files | Root-Cause Evidence & Required Engineering Changes | Acceptance Criteria |
|---|---|---|---|---|---|
| **`P02-T01`** | `PY-RAW-01`, `PY-RAW-03` | `FINDING-007`, `FINDING-010` | `Bot/python/direct_x_bridge.py`, `Bot/src/directX.js` | **Root Cause:** (1) `DirectSession.identity()` (`direct_x_bridge.py:516–547`) skips `v11.user_state()` and `v11.settings()` when `use_cache=True` (`directX.js:126`), returning `authenticated: True` from cached `userId` and optional public `get_user_by_id`. (2) Lines `575–590` swallow non-`ValueError` exceptions (including `account_failure`) from `get_user_by_id` after pre-setting `actual = expected_handle`.<br>**Fix:** (1) Always execute authenticated `v11.user_state()` (or `v11.settings()`) to verify live session validity and check for account suspension/lock even when `use_cache` is passed (use cached `userId` only to avoid redundant public profile resolution after authenticated session state is confirmed). (2) In `:586–590`, re-raise any exception carrying `account_failure` or classification of `captcha`/`banned`/`auth_expired`, and never set `actual = expected_handle` before `get_user_by_id` succeeds. | 1. Suspended or locked accounts with cached `userId` fail `identity()` before dispatch.<br>2. Upstream `get_user_by_id` exceptions carrying `account_failure` propagate to the caller and are never swallowed as `authenticated: True`. |
| **`P02-T02`** | `PY-RAW-02`, `PY-RAW-04`, `XT-05` | `FINDING-001`, `FINDING-003`, `FINDING-011`, `ADD-P1-02`, `ADD-P1-04` | `Bot/python/direct_x_bridge.py`, `Bot/src/publishOutcome.js` | **Root Cause:** (1) `_is_definitely_pre_send_error()` (`direct_x_bridge.py:384–405`) allows `curl_cffi -> httpx` fallback on `POST` if exception text contains `'before send'`. (2) Post-dispatch exception branches in `direct_x_bridge.py:920–965, 1112–1145` return `ambiguous: False, retryable: True` on timeline `429` or proxy error.<br>**Fix:** (1) In `_request_with_transport_fallback()` (`:408–422`), completely forbid `httpx` fallback for non-idempotent methods (`method.upper() not in ('GET', 'HEAD', 'OPTIONS')` -> never fallback on `POST`). (2) In `DirectSession.publish()`, once `dispatch_ack` has been received (`dispatched = True`), force every non-confirmed return payload in `direct_x_bridge.py` to set `'ambiguous': True, 'retryable': False`, aligning the Python bridge contract with `Bot/src/publishOutcome.js`. | 1. Any `curl_cffi` error on `POST` raises immediately without invoking `httpx` fallback (0 duplicate POSTs).<br>2. Any post-dispatch `429` or proxy error during timeline check returns `ambiguous: True, retryable: False` from both Python bridge and Node `publishOutcome.js`. |
| **`P02-T03`** | `XT-01` | `FINDING-002`, `FINDING-011`, `ADD-P1-04`, `ADD-P5-02` | `Bot/python/direct_x_bridge.py` | **Root Cause:** `is_recent_tweet()` (`direct_x_bridge.py:229–265`) and `verify_timeline()` (`:646–825`) accept any matching same-author tweet created within the prior 30 minutes (`1800s`) without checking whether the tweet was created *before* the current dispatch attempt.<br>**Fix:** Record `dispatch_started_epoch = time.time()` immediately before sending `dispatch_ready` / calling `create_tweet`. In `verify_timeline()` and `is_recent_tweet()`, compute the tweet's timestamp both from `created_at` and from the X Snowflake ID (`snowflake_ts = ((int(tid) >> 22) + 1288834974657) / 1000.0`) and require `tweet_ts >= dispatch_started_epoch - 2.0` (with 2-second clock-skew tolerance) and `tweet_ts <= now + 60`. Reject any candidate tweet whose Snowflake or `created_at` timestamp precedes `dispatch_started_epoch - 2.0`. | Synthetic timeline probe with a matching same-author tweet timestamped 20 minutes (or 10 seconds) *before* `dispatch_started_epoch` returns `found: False, published: False, ambiguous: True`. |
| **`P02-T04`** | `XT-02`, `XT-03` | `ADD-P4-02`, `FINDING-010` | `Bot/src/directX.js`, `Bot/src/runner.js`, `Bot/src/telegramUi.js` | **Root Cause:** (1) `DirectXAdapter.publish()` (`directX.js:285–292`) drops `accountFailure`, `xErrorCode`, and `xErrorMessage` when reconstructing a `published: true` (`recoveredFromTimeline: true`) response. (2) `TelegramUi.recordAccountCheck()` (`telegramUi.js:859–865`) drops `captcha`/`banned` signals if `sameAccountExpectation` mismatches on `checkGeneration` or `enabled`.<br>**Fix:** (1) Preserve `accountFailure: result.accountFailure || null`, `xErrorCode: result.xErrorCode ?? null`, and `xErrorMessage: result.xErrorMessage || null` on the returned object in `directX.js:285–292`. (2) In `telegramUi.js:859–865`, when `check.accountFailure === 'captcha' || check.accountFailure === 'banned'`, apply the restriction as long as the account still exists and shares the same `cookieFile` / `userId`, even if `checkGeneration` or `enabled` changed concurrently. | 1. Bridge result `{ published: true, url: '...', recoveredFromTimeline: true, accountFailure: 'captcha' }` propagates `accountFailure: 'captcha'` through `DirectXAdapter.publish()` and isolates the account in `runner.js`.<br>2. Concurrent `checkGeneration` bump does not drop a `captcha` or `banned` isolation signal. |
| **`P02-T05`** | `RUN-04` | `FINDING-011`, `FINDING-026`, `ADD-P1-03`, `ADD-P3-02`, `ADD-P4-03`, `ADD-P5-01`, `ADD-P5-02` | `Bot/src/runner.js`, `Bot/src/queue.js` | **Root Cause:** (1) `handleAccountFailure` (`runner.js:647`) deletes `i.payload.account` when reverting a pre-dispatch failed item to `pending`, silently unpinning owner-assigned accounts and altering the item's payload hash. (2) Pre-dispatch failure deletes `i.attempt` without archiving it to `i.archivedAttempts`. (3) Weighted 280-char X length validation is not checked pre-dispatch.<br>**Fix:** (1) Preserve `i.payload.account` on pre-dispatch failure; instead, if the pinned account becomes unavailable/isolated, keep the item `pending` with its pin intact and skip it in `selectAccount` for the remainder of the cycle (or halt if no other items are runnable). (2) Archive failed pre-dispatch attempt metadata into bounded `i.archivedAttempts` (`max 10`) before `delete i.attempt`. (3) Add pre-dispatch X weighted length validation ($\le 280$ weighted chars, URLs = 23 chars) so oversized items fail cleanly before opening a bridge session. | 1. Pre-dispatch failure on a pinned item (`payload.account: 'acct-1'`) preserves `payload.account === 'acct-1'` and never routes the item to `'acct-2'`.<br>2. Prior attempt diagnostics remain inspectable in `archivedAttempts`.<br>3. Tweet text exceeding 280 weighted chars is rejected pre-dispatch without consuming a bridge session or account strike. |
| **`P02-T06`** | `PY-RAW-05`, `PY-RAW-06`, `PY-RAW-07` | `FINDING-008`, `FINDING-012`, `FINDING-020`, `FINDING-021`, `ADD-P4-01`, `ADD-P4-02` | `Bot/python/direct_x_bridge.py`, `Bot/python/direct_x_compat.py`, `Bot/python/README.md` | **Root Cause:** (1) `direct_x_compat.py:1–5, 319–340` claims no global monkey-patching while patching `twikit.user.User.__init__`. (2) `_set_parent_death_signal()` (`direct_x_bridge.py:116–132`) silently ignores `prctl` errors and non-zero return codes. (3) `is_rate_limit_exception` (`:85–113`) matches `\b429\b` anywhere in arbitrary exception text and emits unsanitized `str(exc)[:500]` across IPC.<br>**Fix:** (1) Update `direct_x_compat.py` docstrings/comments to accurately document the idempotent `User.__init__` normalization wrapper. (2) In `_set_parent_death_signal()`, check `os.getppid() == 1` unconditionally on Linux and emit a structured diagnostic warning if `prctl(PR_SET_PDEATHSIG)` returns non-zero or raises. (3) Restrict `is_rate_limit_exception` string matching to HTTP status / rate-limit context (`status[=:\s]+429|http\s+429|code\s+88|code\s+185|rate\s*limit|too\s+many\s+requests`) so an incidental `429` in a tweet/user ID never triggers a false rate-limit classification, and scrub cookie/token patterns in Python before emitting `xErrorMessage`. | 1. An exception message containing `user_id=429` or `tweet_id=429` is not misclassified as `rate_limit`.<br>2. `_set_parent_death_signal()` exits immediately if `os.getppid() == 1` even if `prctl` fails.<br>3. Python bridge redacts `auth_token`/`ct0`/`Bearer` strings before formatting IPC JSON. |

---

## `P03` — CAPTCHA Manual-Only Invariant, Account Security Guards & Cookie Boundary Hardening

**Dependencies:** `P01` (`P01-T01`), `P02` (`P02-T04`).

| Task ID | Phase 1 Raw Findings | Historical Cross-Refs | Impacted Files | Root-Cause Evidence & Required Engineering Changes | Acceptance Criteria |
|---|---|---|---|---|---|
| **`P03-T01`** | `TR-04`, `TR-06`, `ACC-RAW-04` | `FINDING-019` | `Bot/src/accounts.js`, `Bot/src/telegramUi.js`, `Bot/src/telegramFlows.js`, `Bot/src/runner.js` | **Root Cause:** (1) `TelegramUi.accountToggle` (`telegramUi.js:1159–1248`) and `accountManage` (`:1392–1426`) check `isCaptchaStatus`, `'محظور'`, `'غير متحقق'`, and the 5-account ceiling in `store.load()` outside `store.update()`, then unconditionally set `enabled = true, status = 'نشط'` inside `store.update()`, overwriting concurrent CAPTCHA/ban isolations. (2) `accounts.update()` (`accounts.js:150–169`) and `accountRecord()` (`:47–50`) do not prevent `enabled: true` from overwriting `status: 'محظور'` or `'غير متحقق'`. (3) `runner.selectAccount` (`:183–190`), `claimCycleItem` (`:142–152`), and `onDispatch` (`:955–962`) do not check `!account.needsOwnerCaptcha`.<br>**Fix:** (1) Enforce `!target.needsOwnerCaptcha && !isCaptchaStatus(target.status) && target.status !== 'محظور' && target.status !== 'غير متحقق (يتطلب فحص الجلسة)'` and `activeCount < MAX_ACTIVE_ACCOUNTS` *inside* the `store.update()` mutator in `telegramUi.js`, `accounts.js`, and `telegramFlows.js`. (2) Add `!account.needsOwnerCaptcha && !isCaptchaStatus(account.status) && account.status !== 'محظور'` guards to `runner.selectAccount`, `claimCycleItem`, and `onDispatch`. | 1. Re-running the `telegram-synthetic-race` probe (injecting CAPTCHA isolation between `load()` and `update()` in `accountToggle` and `accountManage`) rejects the enable action and preserves `enabled: false, status: 'كابتشا - يتطلب حل يدوي', needsOwnerCaptcha: true`.<br>2. Runner never selects, claims, or dispatches on an account with `needsOwnerCaptcha: true` regardless of `status` string. |
| **`P03-T02`** | `UI-02`, `UI-03` | `FINDING-019` | `Bot/src/telegramUi.js` | **Root Cause:** (1) `accmanage:disable` (`telegramUi.js:1462–1475`) sets `target.status = 'غير نشط'` while keeping `needsOwnerCaptcha = true`, which causes `accmanage:verify_captcha` (`:1603`, checking `acc.needsOwnerCaptcha && isCaptchaStatus(acc.status)`) to deadlock with `state_changed`! Similarly, `accounts:disable_all` (`:1122`) checks only `a.status !== 'كابتشا'`, overwriting `'كابتشا - يتطلب حل يدوي'`. (2) `accountDetailText` (`:1310`) checks only `account.status === 'كابتشا'` instead of `isCaptchaStatus(account.status) || account.needsOwnerCaptcha`.<br>**Fix:** (1) In `accmanage:disable` (`:1462–1475`) and `accounts:disable_all` (`:1120–1127`), preserve `target.status` (or set canonical `'كابتشا - يتطلب حل يدوي'`) whenever `target.needsOwnerCaptcha || isCaptchaStatus(target.status) || target.status === 'محظور'` is true. (2) In `accmanage:verify_captcha` (`:1603`), accept `acc.needsOwnerCaptcha || isCaptchaStatus(acc.status)` so an account with `needsOwnerCaptcha: true` is never deadlocked by a status label variant. (3) In `accountDetailText` (`:1310`), use `isCaptchaStatus(account.status) || Boolean(account.needsOwnerCaptcha)`. | 1. Clicking Disable or Disable All on a CAPTCHA-isolated account preserves its CAPTCHA status and allows subsequent `verify_captcha` completion.<br>2. Account detail panel displays `🟠 محجوب بـ CAPTCHA` for all CAPTCHA status variants. |
| **`P03-T03`** | `ACC-RAW-01`, `RUN-03` | `FINDING-010`, `FINDING-017` | `Bot/src/accounts.js`, `Bot/src/runner.js`, `Bot/src/telegramUi.js` | **Root Cause:** (1) `AccountManager.replaceFromCsv()` / `replace()` (`accounts.js:189–235`) replaces `state.accounts` with fresh records from CSV without preserving `needsOwnerCaptcha`, `captchaIncidentId`, `'كابتشا - يتطلب حل يدوي'`, or `'محظور'` for existing accounts matching by `id`, `username`, or `userId`. (2) `isolatedVerifier.verify` catch block (`runner.js:432–437`) records `{ authenticated: false }` on transient VPN/timeout errors, causing `telegramUi.js:895–905` to disable healthy accounts as unverified.<br>**Fix:** (1) In `AccountManager.replace()`, match incoming records against existing `state.accounts` by `id`, normalized `username`, and `userId`; if the existing account has `needsOwnerCaptcha`, `isCaptchaStatus(status)`, or `status === 'محظور'`, preserve those restriction fields and force `enabled: false`. (2) In `runner.js:432–437` and `telegramUi.js:895–905`, distinguish transient transport/VPN/timeout errors (`check.transientError = true`) from definitive session auth rejection so transient network timeouts only update `lastError` without disabling the account as unverified. | 1. Re-running `csv-restrictions-synthetic` probe (`replaceFromCsv` with same ID or username as a challenged/banned account) preserves `enabled: false, needsOwnerCaptcha: true, status: 'كابتشا - يتطلب حل يدوي'`.<br>2. Transient VPN/bridge timeout in `isolatedVerifier.verify` records `lastError` without setting `enabled = false`. |
| **`P03-T04`** | `ACC-RAW-02`, `ACC-RAW-03` | `FINDING-014` | `Bot/src/accounts.js`, `Bot/src/runner.js`, `Bot/src/telegramFlows.js` | **Root Cause:** (1) `accounts.js:13` allows `10 MiB` cookie files and `runner.js:1376` allows `2 MiB` uploads, whereas `direct_x_bridge.py:266` caps cookies at `1 MiB` (`1024 * 1024` bytes). (2) `CookieStore` (`accounts.js:265–311`) does not check ancestor path components for symlinks.<br>**Fix:** (1) Unify `MAX_COOKIE_FILE_BYTES = 1024 * 1024` (`1 MiB`) across `accounts.js`, `telegramFlows.js`, and `direct_x_bridge.py`. (2) Verify `fs.realpathSync(dir) === path.resolve(dir)` on `CookieStore` initialization and write operations so no ancestor component of `Bot/data/cookies` is a symlink. | 1. Cookie uploads $> 1\text{ MiB}$ are rejected immediately at Node ingestion with `COOKIE_FILE_TOO_LARGE`.<br>2. Symlinked ancestor directory under `cookies` is rejected fail-closed. |

---

## `P04` — NordVPN 7-Container Cap, Slot Lifecycle Safety & 5-Session Guard Hardening

**Dependencies:** `P01` (`P01-T01`, `P01-T02`), `P03` (`P03-T01`).

| Task ID | Phase 1 Raw Findings | Historical Cross-Refs | Impacted Files | Root-Cause Evidence & Required Engineering Changes | Acceptance Criteria |
|---|---|---|---|---|---|
| **`P04-T01`** | `VPN-RAW-01`, `VPN-RAW-02`, `TR-05` | `FINDING-031`, `ADD-P4-04` | `Bot/src/dockerVpn.js`, `Bot/src/runner.js`, `Bot/src/telegramUi.js` | **Root Cause:** (1) `ensureContainer()` (`dockerVpn.js:158–180`) runs `docker run` when a slot container is missing without verifying that persistent volumes (`yj_autopost_vpn_N_state`, `_auth`) already exist or checking the 7-container host-wide NordVPN ceiling. (2) `destroyContainer()` (`:196–202`) runs `docker rm -f` without `nordvpn disconnect`, and startup `reconcileResources()` (`runner.js:313–315, 369–388`) destroys containers of disabled accounts. (3) `telegramUi.js:1128, 1201, 1487` deletes `s.vpnSlots[id]` before calling `vpnManager.release(id)`, causing `_release()` (`dockerVpn.js:364`) to return `slot: null`. (4) `isCompatibleVpnImage` (`dockerVpn.js:62–64`) accepts `:latest`.<br>**Fix:** (1) Forbid automatic `docker run` in `ensureContainer()` unless `allowContainerCreate === true` is explicitly configured AND `docker volume inspect` confirms both `yj_autopost_vpn_N_state` and `yj_autopost_vpn_N_auth` pre-exist AND host-wide NordVPN container count $< 7$; otherwise fail closed if a slot container is missing. (2) Remove `docker rm -f` from normal `release()` / `reconcileResources()`; releasing an account slot only unbinds `state.vpnSlots[accountId]` (after reading the slot inside `vpnManager.release(id)`), leaving the 5 static slot containers intact. (3) Fix `telegramUi.js` to invoke `await this.vpnManager.release(id)` without pre-deleting `s.vpnSlots[id]`. (4) Require exact pinned tag `yj_autopost_vpn_image:6.0.2` in `isCompatibleVpnImage`. | 1. Disabling an account or running startup `reconcileResources()` unbinds the slot cleanly and never executes `docker rm -f`.<br>2. Missing container or missing named volume fails closed without spawning a new container or running `nordvpn login`.<br>3. `telegramUi.js` disable calls `vpnManager.release(id)` while the slot mapping is still readable. |
| **`P04-T02`** | `VPN-RAW-03`, `VPN-RAW-04`, `UI-01` | `FINDING-015`, `ADD-P4-04` | `Bot/src/dockerVpn.js`, `Bot/src/runner.js`, `Bot/src/telegramUi.js` | **Root Cause:** (1) `execCommand()` (`dockerVpn.js:51–54`) strips `stderr`/`stdout` and throws generic `'VPN Docker exec failed'`, making the `Too many connection attempts|Session Limit Reached` check in `rotateContainerIp()` (`:264`) dead code. (2) `runner.js:687, 705` and `telegramUi.js:1255, 1446` automatically trigger IP rotation on account strikes/enable. (3) `getServerIp()` (`dockerVpn.js:138–146`) falls back to direct host `curl https://api.ipify.org`. (4) `accmanage:check_vpn` (`telegramUi.js:1666–1671`) returns cached `exitIp` without checking live VPN health.<br>**Fix:** (1) Preserve sanitized provider error classifications (`RATE_LIMIT` / `SESSION_LIMIT`) in `execCommand()` so `rotateContainerIp()` aborts immediately on first provider rate-limit response. (2) Remove automatic `vpnManager.rotate()` from account enable (`telegramUi.js:1255, 1446`) and 3-strike isolation (`runner.js:687, 705`), restricting IP rotation to explicit operator maintenance commands. (3) In `getServerIp()`, rely strictly on configured `SERVER_IP` or local public network interface inspection (`os.networkInterfaces()`), failing closed if neither is available instead of making direct unproxied outbound HTTP calls. (4) Wire `accmanage:check_vpn` (`telegramUi.js:1666–1671`) to `await this.vpnManager.health(id)` (or `isolatedVerifier.health(account)`), reporting actual container health and live tunnel exit IP. | 1. Simulated `Too many connection attempts` from `docker exec` aborts `rotateContainerIp()` on attempt 1.<br>2. `getServerIp()` makes zero outbound `curl` requests when `SERVER_IP` and public interfaces are absent (fails closed).<br>3. `accmanage:check_vpn` calls `vpnManager.health` and reports unhealthy when slot is down. |
| **`P04-T03`** | `SESSION-RAW-01`, `SESSION-RAW-02`, `SESSION-RAW-03` | `ADD-P3-03` | `Bot/src/sessionGuard.js`, `Bot/src/directX.js` | **Root Cause:** (1) `bindChildProcess()` and `heartbeat()` (`sessionGuard.js:261–277`) swallow SQLite errors (`catch {}`), leaving `child_pid: null` if `UPDATE` fails. (2) `isProcessAlive()` (`:28–57`) does not verify `/proc/<pid>/stat` field 22 `starttime`. (3) `DIRECT_X_SESSION_DB_PATH` can be overridden without checking if the target account is a production account.<br>**Fix:** (1) Make `bindChildProcess()` retry on `SQLITE_BUSY` and throw on failure; in `DirectXAdapter.open()` (`directX.js:90–100`), if `bindChildProcess()` throws, immediately kill the spawned Python process and release the lease. (2) Record `owner_starttime` and `child_starttime` from `/proc/<pid>/stat` field 22 in `session_leases` and verify `starttime` in `isProcessAlive()` and `reconcileOrphans()`. | 1. Injected SQLite failure in `bindChildProcess()` kills the spawned child process and releases the lease.<br>2. Stale lease row whose PID was reused by a newer process with a different `/proc/<pid>/stat` `starttime` is accurately detected and reclaimed. |

---

## `P05` — Telegram Runtime, Command Routing, Scheduler Atomicity, Singleton Unification & Graceful Shutdown

**Dependencies:** `P01`, `P03`, `P04`.

| Task ID | Phase 1 Raw Findings | Historical Cross-Refs | Impacted Files | Root-Cause Evidence & Required Engineering Changes | Acceptance Criteria |
|---|---|---|---|---|---|
| **`P05-T01`** | `RUN-01`, `ENTRY-RAW-01`, `RUN-06`, `TR-07` | `FINDING-004`, `FINDING-005`, `ADD-P3-03` | `Bot/src/singleInstance.js`, `Bot/src/runner.js`, `Bot/systemd/yj-telegram-bot.user.service` | **Root Cause:** (1) `runner.js:25–131` defines an inline `SingleInstanceLock` duplicating `Bot/src/singleInstance.js`. (2) `runner.js:1624–1662` awaits `watchdog.close()` and `ui.destroy()` *outside* the inner `try/finally` that closes `SqliteStore` and releases `instanceLock`. (3) Tracked `Bot/systemd/yj-telegram-bot.user.service` has `[Install] WantedBy=default.target`, creating risk of user-scope vs system-scope unit conflict if enabled.<br>**Fix:** (1) Delete the duplicate inline `SingleInstanceLock` from `runner.js:25–131` and import `SingleInstanceLock` from `./singleInstance` (enhanced with `/proc/<pid>/stat` `starttime` verification). (2) Move `await watchdog.close()` and `await ui.destroy()` *inside* the `try` block (each wrapped in `try/catch` with structured error logging) so `finally` *always* drains forensic/UI tasks, closes `bot.store`, and releases `instanceLock`. (3) Add `Conflicts=yj-telegram-bot.service` / manual-only guard comment to `yj-telegram-bot.user.service`. | 1. `runner.js` imports and uses `src/singleInstance.js` exclusively.<br>2. Simulated rejection in `watchdog.close()` or `ui.destroy()` still executes `bot.store.close()` and `instanceLock.release()`. |
| **`P05-T02`** | `TR-01`, `TR-02`, `TR-03`, `ENTRY-RAW-02`, `UI-04`, `UTIL-RAW-02`, `UTIL-RAW-04` | `FINDING-016`, `FINDING-018`, `FINDING-022`, `FINDING-027`, `FINDING-029`, `ADD-P2-01`, `ADD-P2-02`, `ADD-P2-03` | `Bot/src/runner.js`, `Bot/src/telegramUi.js`, `Bot/src/telegramApi.js`, `Bot/src/tableUtils.js`, `Bot/src/accountTable.js`, `Bot/src/accountRefresh.js` | **Root Cause:** (1) `runner.js:1581` (`...ui.actions()`) overwrites `runner.js:1485` text command `accountToggle` (`TR-01`). (2) `runner.js:1435–1445` commits `uiScheduleDay = day` before `await ui.startScheduled()` succeeds (`TR-02`). (3) `runner.js:340–348` and `telegramUi.js:1010–1019` count notifications as delivered without checking `Number.isInteger(res?.message_id)` (`TR-03`). (4) `telegramApi.js:52–90` (`transfer()`) lacks a `maxBytes` cap (`ENTRY-RAW-02`). (5) `telegramUi.js:1316` (`accountDetailText`) does not `escapeHtml(account.label)` (`UI-04`). (6) `tableUtils.js` / `accountTable.js` diverge from `Bot/AGENTS.md` table spec (`UTIL-RAW-02`). (7) `accountRefresh.js:78–98` swallows storage errors (`UTIL-RAW-04`).<br>**Fix:** (1) In `TelegramUi.accountToggle`, if `update.action === 'accountToggle'` has no `update.parsed` callback payload, delegate to text argument parsing (`update.args` / `update.text`) so `/account_toggle <id>` works identically to the button callback. (2) In `runner.js:1435–1445`, call `const started = await ui.startScheduled();` *first* (which atomically checks and sets `uiScheduleDay = day` inside `begin()`'s admission transaction only when readiness passes). (3) Require `Number.isInteger(res?.message_id) && res.message_id > 0` before logging `notify_send_success` or counting delivered notifications. (4) Add `maxBytes = 4 * 1024 * 1024` response stream guard to `telegramApi.js` `transfer()`. (5) Escape `escapeHtml(account.label)` in `telegramUi.js:1316`. (6) Align `tableUtils.js`, `accountTable.js`, and `Bot/AGENTS.md` documentation. (7) Emit structured warning logs on storage errors in `accountRefresh.js`. | 1. Sending `/account_toggle <id>` text command toggles the target account cleanly.<br>2. If `ui.startScheduled()` fails readiness at the scheduled minute, `uiScheduleDay` is not marked consumed.<br>3. `account.label` containing `<script>&` renders safely with `parse_mode: 'HTML'`.<br>4. Oversized HTTP response $> 4\text{ MiB}$ in `telegramApi.transfer()` aborts cleanly with `TELEGRAM_RESPONSE_TOO_LARGE`. |

---

## `P06` — Legacy Test Tree Migration, Offline/Live Separation & Destructive Test Neutralization

**Dependencies:** `P01`, `P02`, `P03`, `P04`, `P05`.

| Task ID | Phase 1 Raw Findings | Historical Cross-Refs | Impacted Files | Root-Cause Evidence & Required Engineering Changes | Acceptance Criteria |
|---|---|---|---|---|---|
| **`P06-T01`** | `CI-01`, `CI-06` | `ADD-P6-03` | `Bot/package.json`, `Bot/scripts/run_all_automated_tests.sh`, `Bot/test/live_vps_m4_operational.test.js`, `Bot/test/docker_vpn_live_slots.test.js`, `Bot/test/m2_concurrency_challenge.test.js`, `Bot/test/challenger_m3_adversarial.test.js`, `Bot/test/challenger_m4_m5_adversarial.test.js`, `Bot/test/m4_lifecycle_and_recovery.test.js`, `Bot/test/env_validation.test.js`, `Bot/TEST_RUNNER/run_suite.py` | **Root Cause:** (1) `Bot/package.json` `"test": "node --test test/*.test.js"` runs live operational tests that copy production `state.sqlite`, call `rotateContainerIp` on live `yj_autopost_vpn_1`, send real Telegram messages, attack the live `SingleInstanceLock`, and run external `curl` probes (`CI-01`). (2) `Bot/test/env_validation.test.js` contains credential-shaped literals (`audit-legacy-node-batch-03.md`). (3) `Bot/TEST_RUNNER/run_suite.py:6, 38–44, 187` mutates historical evidence directories even when netns preflight fails. (4) `Bot/scripts/run_all_automated_tests.sh` fabricates pass counts (`${PASSED_COUNT:-181}`) on grep failure and runs live Tier 4 probes (`CI-06`).<br>**Fix:** (1) Move live VPS/Docker/network tests (`live_vps_m4_operational.test.js`, `docker_vpn_live_slots.test.js`, and live-probing blocks of `m2_concurrency_challenge.test.js`, `challenger_m3_adversarial.test.js`, `challenger_m4_m5_adversarial.test.js`, `m4_lifecycle_and_recovery.test.js`) into `Bot/test-live/` guarded by an explicit `if (process.env.ALLOW_LIVE_VPS_TESTS !== '1')` skip/abort guard, and replace their offline counterparts in `Bot/test/` with 100% isolated `mkdtemp` + mock transport tests. (2) Scrub any credential-shaped literals in `Bot/test/env_validation.test.js` with clearly synthetic test fixtures (`123456789:AAH_SYNTHETIC_TEST_FIXTURE_TOKEN_000`). (3) Fix `Bot/TEST_RUNNER/run_suite.py` to write exclusively to a fresh `tempfile.mkdtemp()` scratch directory and perform the `unshare -Urn` loopback-only preflight *before* any file write. (4) Fix `Bot/scripts/run_all_automated_tests.sh` to remove hardcoded count fallbacks, fail closed on missing test counts, and run only offline tiers by default (`--live` flag required for Tier 4). (5) Add missing `store.close()` and `fs.rmSync(tempDir, { recursive: true, force: true })` cleanup to all 58 Node tests and 14 Python tests (`PYTHONDONTWRITEBYTECODE=1`). | 1. Running `npm test` in `Bot/` executes 100% offline inside `unshare -Urn` (zero external network packets, zero Docker commands, zero touches to `Bot/data/state.sqlite` or `session_leases.sqlite`, zero leftover `/tmp` directories).<br>2. All 58 Node test suites, 14 Python test suites (with `-B`), and `TEST_RUNNER/run_suite.py` pass with new regression tests covering every `P01`–`P05` fix. |

---

## `P07` — GitHub Actions CI & AppImage Release Gate Repair

**Dependencies:** `P06`.

| Task ID | Phase 1 Raw Findings | Historical Cross-Refs | Impacted Files | Root-Cause Evidence & Required Engineering Changes | Acceptance Criteria |
|---|---|---|---|---|---|
| **`P07-T01`** | `CI-02`, `CI-03`, `CI-04`, `CI-05`, `CI-07`, `CI-08` | `FINDING-013`, `FINDING-032`, `FINDING-033` | `.github/workflows/verify-xposter.yml`, `.github/workflows/apply-remaining-repair.yml`, `Appimage/scripts/verify-release.sh` | **Root Cause:** (1) Neither GitHub workflow executes `Bot/` Node or Python tests (`CI-02`). (2) `verify-release.sh:28–41` deletes `$VERIFY_HOME/boot.log` in its `EXIT/ERR` trap before `verify-xposter.yml:55–65` uploads failure artifacts (`CI-03`). (3) `verify-release.sh:111–117` prints that real user data directories will be checked but performs zero assertions (`CI-04`). (4) `apply-remaining-repair.yml:162–180` defaults missing `audit.metadata.vulnerabilities` to `0` (`CI-05`). (5) `verify-release.sh:94–108` accepts `BOOT_EXIT -eq 0` (immediate exit) on a 45s timeout run and lacks `--no-sandbox --disable-gpu` flags for headless Xvfb, causing intermittent GPU zygote `exit 5` failures (`CI-07`). (6) `apply-remaining-repair.yml:185` hardcodes stale `YJAutoPostOnX-5.20.0-AppImage` (`CI-08`).<br>**Fix:** (1) Add a dedicated `bot-verification` job to `.github/workflows/verify-xposter.yml` and `apply-remaining-repair.yml` that sets up Node >=22.5 and Python 3.14, installs `Bot/requirements-direct-x.txt`, and runs `Bot/` Python (`python3 -B -m unittest`) and Node (`npm test`) suites. (2) In `verify-release.sh`, copy `$VERIFY_HOME/boot.log` to `/tmp/xposter-last-boot.log` *before* removing `$VERIFY_HOME` in `cleanup()`, and update `verify-xposter.yml` to upload `/tmp/xposter-last-boot.log`. (3) Snapshot pre-run hashes/mtimes of `$REAL_HOME/.config/x-poster*` before `verify-release.sh` runs and assert byte-for-byte equality at lines `111–117`. (4) In `apply-remaining-repair.yml:162–180`, fail closed (`process.exit(1)`) if `!audit.metadata || !audit.metadata.vulnerabilities`. (5) In `verify-release.sh:94–108`, pass `--no-sandbox --disable-gpu` under headless `xvfb-run` and require `BOOT_EXIT` to be `124` or `137` (proving the process stayed alive for the full 45s timeout) plus verifiable readiness log markers. (6) Read dynamic version from `Appimage/package.json` for artifact naming (`CI-08`). | 1. Both GitHub Actions workflows execute and pass `Bot/` Node + Python tests and `Appimage/` tests.<br>2. Forced boot failure preserves `/tmp/xposter-last-boot.log` for artifact upload.<br>3. Early exit (`BOOT_EXIT=0` at 1s) or missing `npm audit` metadata fails the CI gate. |

---

## `P08` — Historical Report Consolidation, Quarantine Settlement Governance & Operational Verification

**Dependencies:** `P01`, `P02`, `P03`, `P04`, `P05`, `P06`, `P07`.

| Task ID | Phase 1 Raw Findings | Historical Cross-Refs | Impacted Files | Root-Cause Evidence & Required Engineering Changes | Acceptance Criteria |
|---|---|---|---|---|---|
| **`P08-T01`** | All 59 Raw Findings | `ADD-P1-01`, `ADD-P3-03`, `ADD-P6-02`, `ADD-P6-03`, `ADD-P6-04` | `Bot/Reports/*`, `Bot/scripts/*`, `Bot/systemd/yj-telegram-bot.service` | **Root Cause & Governance Requirements:** (1) `Bot/Reports/` contains 112 fragmented historical files/archives with unverified or contradicted `TESTED_PASS` claims (`history-coverage.md`), and `Bot/scripts/` contains 21 mixed operational/recovery/evidence scripts (`audit-scripts-deploy.md`), including `configure_m4_single_publish.js` (which mutates production `state.sqlite` directly without CLI guards) and `live_production_5_rounds_monitor.js` (which writes unredacted `journalctl` logs to disk). (2) Item `53d0f458-3144-4e89-a1af-202a8893afc6` and the 29 other `ambiguous` items remain quarantined in `state.sqlite`.<br>**Fix:** (1) Add fail-closed CLI guards (`--apply` + explicit confirmation env var) to `configure_m4_single_publish.js` and add `structuredLogger.sanitizeString` redaction before writing journal logs in `live_production_5_rounds_monitor.js`. (2) Archive superseded historical `Bot/Reports/RepairHandoff/*` artifacts into a single checksummed, secret-scanned historical archive outside the active reference path and update `Bot/Reports/` master index and GitHub Issue #12 (`ADD-P6-04`) with the verified `P01`–`P08` evidence matrix. (3) Keep all 30 `ambiguous` items strictly quarantined (`requeueApproved: false`); execute `settle_item_53d0f458.js --apply` on production **only** if and when explicit owner sign-off (`ALLOW_PROD_53D0_SETTLEMENT=1`) is granted (`ADD-P1-01`). (4) Perform a controlled, backup-verified systemd reload/restart and read-only health verification (`ADD-P3-03`, `ADD-P6-02`, `ADD-P6-03`) only after owner sign-off. | 1. All 21 scripts in `Bot/scripts/` are either read-only by default (`--dry-run`) or fail-closed behind explicit `--apply` + production env guards.<br>2. Verified pre-deployment backup of `Bot/data/state.sqlite` (+ WAL/SHM) and `Bot/data/cookies/` created and hash-verified.<br>3. All 59 Phase 1 raw findings and 53 historical items are closed with reproducible test evidence and independent reviewer + owner sign-off. |

---

# Part 3: Complete Bidirectional Traceability Matrix (59 Raw Findings + 53 Historical IDs $\to$ `P01`–`P08`)

## 3.1 Phase 1 Raw Findings (59 / 59 Mapped)

| Raw Finding ID | Assigned Phase & Task | Target File(s) |
|---|---|---|
| `PERSIST-OBS-01` | `P01-T03` | `Bot/src/forensicLogger.js` |
| `PERSIST-OBS-02` | `P01-T04` | `Bot/src/queue.js` |
| `PERSIST-OBS-03` | `P01-T03` | `Bot/src/forensicLogger.js` |
| `PERSIST-OBS-04` | `P01-T01` | `Bot/src/sqliteStore.js`, `Bot/src/runner.js` |
| `PERSIST-OBS-05` | `P01-T02` | `Bot/src/sqliteStore.js`, `Bot/src/forensicLogger.js`, `Bot/src/sessionGuard.js` |
| `RUN-01` | `P05-T01` | `Bot/src/runner.js`, `Bot/src/singleInstance.js` |
| `RUN-02` | `P01-T01` | `Bot/src/runner.js`, `Bot/src/sqliteStore.js` |
| `RUN-03` | `P03-T03` | `Bot/src/runner.js`, `Bot/src/telegramUi.js` |
| `RUN-04` | `P02-T05` | `Bot/src/runner.js` |
| `RUN-05` | `P01-T03` | `Bot/src/runner.js`, `Bot/src/forensicLogger.js` |
| `RUN-06` | `P05-T01` | `Bot/src/runner.js` |
| `TR-01` | `P05-T02` | `Bot/src/runner.js`, `Bot/src/telegramUi.js` |
| `TR-02` | `P05-T02` | `Bot/src/runner.js`, `Bot/src/telegramUi.js` |
| `TR-03` | `P05-T02` | `Bot/src/runner.js`, `Bot/src/telegramUi.js`, `Bot/src/telegramApi.js` |
| `TR-04` | `P03-T01` | `Bot/src/accounts.js`, `Bot/src/telegramFlows.js` |
| `TR-05` | `P04-T01` | `Bot/src/telegramUi.js`, `Bot/src/dockerVpn.js` |
| `TR-06` | `P03-T01` | `Bot/src/telegramUi.js`, `Bot/src/runner.js` |
| `TR-07` | `P05-T01` | `Bot/src/runner.js` |
| `UI-01` | `P04-T02` | `Bot/src/telegramUi.js` |
| `UI-02` | `P03-T02` | `Bot/src/telegramUi.js` |
| `UI-03` | `P03-T02` | `Bot/src/telegramUi.js` |
| `UI-04` | `P05-T02` | `Bot/src/telegramUi.js` |
| `PY-RAW-01` | `P02-T01` | `Bot/python/direct_x_bridge.py`, `Bot/src/directX.js` |
| `PY-RAW-02` | `P02-T02` | `Bot/python/direct_x_bridge.py` |
| `PY-RAW-03` | `P02-T01` | `Bot/python/direct_x_bridge.py` |
| `PY-RAW-04` | `P02-T02` | `Bot/python/direct_x_bridge.py`, `Bot/src/publishOutcome.js` |
| `PY-RAW-05` | `P02-T06` | `Bot/python/direct_x_compat.py` |
| `PY-RAW-06` | `P02-T06` | `Bot/python/direct_x_bridge.py` |
| `PY-RAW-07` | `P02-T06` | `Bot/python/direct_x_bridge.py`, `Bot/src/runner.js` |
| `XT-01` | `P02-T03` | `Bot/python/direct_x_bridge.py` |
| `XT-02` | `P02-T04` | `Bot/src/directX.js`, `Bot/src/runner.js` |
| `XT-03` | `P02-T04` | `Bot/src/telegramUi.js`, `Bot/src/runner.js` |
| `XT-04` | `P01-T04` | `Bot/src/queue.js` |
| `XT-05` | `P02-T02` | `Bot/python/direct_x_bridge.py`, `Bot/src/publishOutcome.js` |
| `VPN-RAW-01` | `P04-T01` | `Bot/src/dockerVpn.js` |
| `VPN-RAW-02` | `P04-T01` | `Bot/src/dockerVpn.js`, `Bot/src/runner.js` |
| `VPN-RAW-03` | `P04-T02` | `Bot/src/dockerVpn.js` |
| `VPN-RAW-04` | `P04-T02` | `Bot/src/dockerVpn.js`, `Bot/src/runner.js`, `Bot/src/telegramUi.js` |
| `SESSION-RAW-01` | `P04-T03` | `Bot/src/sessionGuard.js` |
| `SESSION-RAW-02` | `P04-T03` | `Bot/src/sessionGuard.js`, `Bot/src/directX.js` |
| `SESSION-RAW-03` | `P04-T03` | `Bot/src/sessionGuard.js` |
| `UTIL-RAW-01` | `P01-T05` | `Bot/src/structuredLogger.js` |
| `UTIL-RAW-02` | `P05-T02` | `Bot/src/tableUtils.js`, `Bot/src/accountTable.js` |
| `UTIL-RAW-03` | `P01-T05` | `Bot/src/linkExports.js` |
| `UTIL-RAW-04` | `P05-T02` | `Bot/src/accountRefresh.js` |
| `ACC-RAW-01` | `P03-T03` | `Bot/src/accounts.js` |
| `ACC-RAW-02` | `P03-T04` | `Bot/src/accounts.js`, `Bot/src/runner.js`, `Bot/src/telegramFlows.js` |
| `ACC-RAW-03` | `P03-T04` | `Bot/src/accounts.js` |
| `ACC-RAW-04` | `P03-T01` | `Bot/src/accounts.js` |
| `ENTRY-RAW-01` | `P05-T01` | `Bot/src/runner.js`, `Bot/src/singleInstance.js` |
| `ENTRY-RAW-02` | `P05-T02` | `Bot/src/telegramApi.js` |
| `CI-01` | `P06-T01` | `Bot/package.json`, `Bot/test/*`, `Bot/scripts/run_all_automated_tests.sh` |
| `CI-02` | `P07-T01` | `.github/workflows/verify-xposter.yml`, `.github/workflows/apply-remaining-repair.yml` |
| `CI-03` | `P07-T01` | `Appimage/scripts/verify-release.sh`, `.github/workflows/verify-xposter.yml` |
| `CI-04` | `P07-T01` | `Appimage/scripts/verify-release.sh` |
| `CI-05` | `P07-T01` | `.github/workflows/apply-remaining-repair.yml` |
| `CI-06` | `P06-T01` | `Bot/scripts/run_all_automated_tests.sh` |
| `CI-07` | `P07-T01` | `Appimage/scripts/verify-release.sh` |
| `CI-08` | `P07-T01` | `.github/workflows/apply-remaining-repair.yml` |

## 3.2 Historical 53 IDs (`33 FINDING` + `20 ADD` Mapped)

| Historical ID | Phase 1 Status | Assigned Phase & Task |
|---|---|---|
| `FINDING-001` | `CONTRADICTED` | `P02-T02` (`PY-RAW-02`) |
| `FINDING-002` | `CONTRADICTED` | `P02-T03` (`XT-01`) |
| `FINDING-003` | `CONTRADICTED` | `P01-T01`, `P01-T04`, `P02-T02` (`PERSIST-OBS-02`, `PERSIST-OBS-04`, `XT-04`) |
| `FINDING-004` | `CLAIMED-UNVERIFIED` | `P05-T01` (`RUN-01`, `ENTRY-RAW-01`, `RUN-06`, `TR-07`) |
| `FINDING-005` | `VERIFIED` | `P05-T01` (Regression test lock preservation in `P06-T01`) |
| `FINDING-006` | `CLAIMED-UNVERIFIED` | `P01-T01`, `P01-T05` (`UTIL-RAW-03`) |
| `FINDING-007` | `CONTRADICTED` | `P02-T01` (`PY-RAW-01`, `PY-RAW-03`) |
| `FINDING-008` | `VERIFIED` | `P02-T06` (`PY-RAW-05`) |
| `FINDING-009` | `CONTRADICTED` | `P01-T01` (`PERSIST-OBS-04`, `RUN-02`) |
| `FINDING-010` | `CLAIMED-UNVERIFIED` | `P02-T01`, `P02-T04`, `P03-T03` (`RUN-03`, `PY-RAW-03`, `XT-02`) |
| `FINDING-011` | `CONTRADICTED` | `P01-T01`, `P02-T02`, `P02-T05` (`PERSIST-OBS-04`, `PY-RAW-02`, `RUN-04`) |
| `FINDING-012` | `SUPERSEDED` / `VERIFIED` | `P02-T06`, `P07-T01` (`requirements-direct-x.txt` CI pin check) |
| `FINDING-013` | `CLAIMED-UNVERIFIED` | `P07-T01` (`Appimage` CI suite verification) |
| `FINDING-014` | `CLAIMED-UNVERIFIED` | `P03-T04` (`ACC-RAW-02`, `ACC-RAW-03`) |
| `FINDING-015` | `CONTRADICTED` | `P04-T02` (`dockerVpn.js` `getServerIp` direct curl removal) |
| `FINDING-016` | `VERIFIED` | `P05-T02`, `P06-T01` (`env_validation.test.js` secret scrub & offline test) |
| `FINDING-017` | `CONTRADICTED` | `P03-T03` (`ACC-RAW-01`) |
| `FINDING-018` | `VERIFIED` | `P05-T02` (`ENTRY-RAW-02`) |
| `FINDING-019` | `CLAIMED-UNVERIFIED` | `P03-T01`, `P03-T02` (`TR-06`, `UI-02`, `UI-03`) |
| `FINDING-020` | `VERIFIED` | `P02-T06`, `P06-T01` (`test_bridge_hardening.py` regression) |
| `FINDING-021` | `CONTRADICTED` | `P02-T06`, `P04-T03` (`PY-RAW-06`, `SESSION-RAW-02`) |
| `FINDING-022` | `CONTRADICTED` | `P05-T02` (`TR-02`) |
| `FINDING-023` | `VERIFIED` | `P01-T01`, `P07-T01` (`node:sqlite` CI guard) |
| `FINDING-024` | `CONTRADICTED` | `P01-T01` (`PERSIST-OBS-04`, `RUN-02`) |
| `FINDING-025` | `CONTRADICTED` | `P01-T01` (`PERSIST-OBS-04`, `RUN-02`) |
| `FINDING-026` | `VERIFIED` | `P02-T05`, `P06-T01` (`verify_p1_005_queue_flow.js` regression) |
| `FINDING-027` | `CONTRADICTED` | `P05-T02` (`UTIL-RAW-02`) |
| `FINDING-028` | `CONTRADICTED` | `P01-T03`, `P01-T05` (`PERSIST-OBS-01`, `UTIL-RAW-01`) |
| `FINDING-029` | `VERIFIED` | `P05-T02`, `P06-T01` (`quota.js` regression) |
| `FINDING-030` | `CONTRADICTED` | `P01-T03` (`PERSIST-OBS-01`, `PERSIST-OBS-03`) |
| `FINDING-031` | `CONTRADICTED` | `P04-T01` (`dockerVpn.js` exact `6.0.2` tag check) |
| `FINDING-032` | `CLAIMED-UNVERIFIED` | `P07-T01` (`Appimage` CI suite verification) |
| `FINDING-033` | `CLAIMED-UNVERIFIED` | `P07-T01` (`Appimage` CI suite verification) |
| `ADD-P1-01` | `CLAIMED-UNVERIFIED` | `P01-T04`, `P08-T01` (`PERSIST-OBS-02`, `XT-04`, `53d0f458` governance) |
| `ADD-P1-02` | `CONTRADICTED` | `P01-T01`, `P02-T02` (`PERSIST-OBS-04`, `PY-RAW-02`, `PY-RAW-04`, `XT-05`) |
| `ADD-P1-03` | `CLAIMED-UNVERIFIED` | `P02-T05`, `P06-T01` (`attemptOutcomes.js` regression) |
| `ADD-P1-04` | `CONTRADICTED` | `P02-T02`, `P02-T03`, `P02-T04` (`XT-01`, `XT-02`, `XT-05`) |
| `ADD-P2-01` | `CLAIMED-UNVERIFIED` | `P05-T02` (`TR-02`, `TR-03`) |
| `ADD-P2-02` | `CLAIMED-UNVERIFIED` | `P05-T02`, `P08-T01` (Telemetry & operational verification) |
| `ADD-P2-03` | `CLAIMED-UNVERIFIED` | `P01-T05`, `P05-T02` (`UTIL-RAW-03`, `TR-03`) |
| `ADD-P3-01` | `CONTRADICTED` | `P01-T01`, `P01-T02` (`PERSIST-OBS-04`, `PERSIST-OBS-05`, `RUN-02`) |
| `ADD-P3-02` | `CLAIMED-UNVERIFIED` | `P01-T03`, `P02-T05` (`RUN-04`, `RUN-05`) |
| `ADD-P3-03` | `CLAIMED-UNVERIFIED` | `P04-T03`, `P05-T01`, `P08-T01` (`SESSION-RAW-01..03`, `RUN-06`, `TR-07`) |
| `ADD-P4-01` | `VERIFIED` | `P02-T06` (`PY-RAW-05`) |
| `ADD-P4-02` | `CONTRADICTED` | `P01-T05`, `P02-T04`, `P02-T06` (`UTIL-RAW-01`, `XT-02`, `PY-RAW-07`) |
| `ADD-P4-03` | `VERIFIED` | `P02-T05`, `P06-T01` (`xFailureClassification.js` regression) |
| `ADD-P4-04` | `CONTRADICTED` | `P04-T01`, `P04-T02` (`VPN-RAW-01..04`, `TR-05`, `UI-01`) |
| `ADD-P5-01` | `CLAIMED-UNVERIFIED` | `P02-T05` (Pre-dispatch weighted 280-char validation) |
| `ADD-P5-02` | `CONTRADICTED` | `P02-T03`, `P02-T05` (`XT-01`, `RUN-04`) |
| `ADD-P6-01` | `CONTRADICTED` | `P01-T02`, `P01-T03`, `P01-T05` (`PERSIST-OBS-01`, `PERSIST-OBS-03`, `PERSIST-OBS-05`, `UTIL-RAW-01`) |
| `ADD-P6-02` | `CLAIMED-UNVERIFIED` | `P08-T01` (`live_production_5_rounds_monitor.js` log sanitization & receipts) |
| `ADD-P6-03` | `CLAIMED-UNVERIFIED` | `P06-T01`, `P07-T01`, `P08-T01` (Independent verification & owner sign-off) |
| `ADD-P6-04` | `CLAIMED-UNVERIFIED` | `P08-T01` (Master TODO & Issue #12 reconciliation) |


---

# Section 6: Post-Audit Engineering Architecture & Implementation Design (Component Boundaries, State Machines, CAS Invariants, CAPTCHA Invariant, Hard Limits & `ADR-001..010`)

# Part 1: Post-Audit Engineering Architecture

## 1.1 System Overview & Product Boundary Isolation

The repository contains two distinct products that must remain strictly decoupled at runtime, storage, and test-runner levels:

```
+-----------------------------------------------------------------------------------+
|                          YJAutoPostOnX Repository Root                            |
+-----------------------------------------+-----------------------------------------+
|        Product 1: Appimage/ (Desktop)   |         Product 2: Bot/ (VPS Daemon)    |
|  - Runtime: Electron + Playwright       |  - Runtime: Node.js >=22.5 + Python 3.14|
|  - Entry: Appimage/dev/main.js          |  - Entry: Bot/src/index.js -> runner.js |
|  - Store: ~/.config/x-poster-shared/    |  - Store: Bot/data/state.sqlite &       |
|           workflow.sqlite               |           Bot/data/session_leases.sqlite|
|  - Transport: Browser automation        |  - Transport: Browserless DirectX IPC   |
|  - CI: verify-xposter.yml (Appimage)    |    over 5 NordVPN SOCKS5h containers    |
+--------------------+--------------------+--------------------+--------------------+
                     |                                         ^
                     +--- User-Mediated UTF-8 CSV Handoff -----+
                          Header: Text,Media[,Account]
```

### Boundary Invariants
1. **Zero Shared Runtime State:** `Bot/` never imports from `Appimage/`, and `Appimage/` never reads or writes `Bot/data/state.sqlite`.
2. **CSV Handoff Contract:** `Appimage/dev/main.js:963–973` exports UTF-8 BOM `Text,Media` CSVs; `Bot/src/telegramFlows.js:1–65` strips BOM, validates headers (`Text,Media[,Account]`), enforces size/row bounds (`2 MiB`, `5,000` rows), rejects formula injection (`=`, `+`, `-`, `@`), and deduplicates payloads by canonical SHA-256 hash.

---

## 1.2 Component Boundaries & Module Ownership (`Bot/`)

| Subsystem | Owned Files | Architectural Responsibility & Boundary Contract |
|---|---|---|
| **Entrypoint & Singleton Lock** | `Bot/src/index.js`, `Bot/src/singleInstance.js`, `Bot/systemd/yj-telegram-bot.service`, `Bot/systemd/telegram-bot-launcher.sh` | Validate environment (`env.js`), acquire the single canonical `SingleInstanceLock` (`singleInstance.js`—eliminating the duplicate inline class in `runner.js:25–131`), verify PID + `/proc/<pid>/stat` `starttime` ownership token, and launch `runner.run()`. |
| **Durable Persistence & Outbox** | `Bot/src/sqliteStore.js`, `Bot/src/forensicLogger.js`, `Bot/src/forensicMutex.js` | Manage `Bot/data/state.sqlite` (`WAL`, `synchronous=NORMAL`, `busy_timeout=5000`), enforce multi-worktree production DB mutation guards by canonical realpath and `dev:ino`, execute atomic compare-and-set (`revision`) transactions with pure retry-safe mutator outputs, and coordinate dual-write forensic outbox flushing to `Bot/data/logs/forensic.jsonl` under `ForensicMutex`. |
| **Queue, Quota & Attempt Accounting** | `Bot/src/queue.js`, `Bot/src/quota.js`, `Bot/src/attemptOutcomes.js`, `Bot/src/publishOutcome.js`, `Bot/src/ambiguousAudit.js` | Enforce queue item state transitions, SHA-256 payload deduplication, `Asia/Riyadh` daily quota capacity (`dailyQuota = 10` default), per-day `failed`/`ambiguous` attempt counters, and strict quarantine of `ambiguous` items (`Queue.requeue` explicitly forbidden on `ambiguous` items). |
| **Publishing Orchestrator** | `Bot/src/runner.js`, `Bot/src/scheduling.js`, `Bot/src/watchdog.js`, `Bot/src/xFailureClassification.js`, `Bot/src/knownTwikitParserFailure.js` | Coordinate cycle execution, account selection (preserving owner `payload.account` pins), pre-dispatch claim fencing, VPN health check, `DirectXAdapter` session lifecycle, durable `onDispatch` phase commit, post-dispatch outcome settlement, 3-strike transient cooling, immediate 1st-turn CAPTCHA/ban isolation, scheduler trigger, and ordered graceful shutdown. |
| **Telegram Transport, Auth & UI** | `Bot/src/auth.js`, `Bot/src/telegram.js`, `Bot/src/telegramApi.js`, `Bot/src/telegramUi.js`, `Bot/src/telegramFlows.js`, `Bot/src/tableUtils.js`, `Bot/src/accountTable.js`, `Bot/src/linkExports.js`, `Bot/src/accountRefresh.js` | Enforce strict `allowedUserIds` AND `allowedChatIds` allowlists before action dispatch, bound HTTP response payloads (`maxBytes`), serialize UI actions per `chatId:userId`, render escaped HTML / `<pre><code>` Unicode tables, enforce in-transaction account enable/CAPTCHA CAS guards, and deliver dual-admin CSV link exports with verified `message_id` receipts. |
| **Account & Cookie Store** | `Bot/src/accounts.js`, `Bot/src/cookieFormat.js` | Normalize account records, enforce the 5-active-account cap and `1 MiB` cookie size cap matching Python, write `0600` cookie files inside `0700` `Bot/data/cookies/` with `O_NOFOLLOW` + `fsync`, and preserve `needsOwnerCaptcha` / `captchaIncidentId` / `'محظور'` flags across all `update()` and `replaceFromCsv()` operations. |
| **Direct-X IPC Adapter & Python Bridge** | `Bot/src/directX.js`, `Bot/src/sessionGuard.js`, `Bot/python/direct_x_bridge.py`, `Bot/python/direct_x_compat.py`, `Bot/requirements-direct-x.txt` | Enforce the host-wide 5-session ceiling (`session_leases.sqlite` + `/proc` scan), spawn isolated `python -I` subprocesses with verified `PR_SET_PDEATHSIG`, validate live account state (`v11.user_state`), enforce one-shot `dispatch_ready` -> `dispatch_ack` handshake, execute a single `CreateTweet` call without POST transport fallback, verify timeline recovery using Snowflake timestamp $\ge \text{dispatch\_started\_at}$, and propagate structured `accountFailure` / GraphQL error codes back to Node. |
| **Docker VPN Slot Manager** | `Bot/src/dockerVpn.js`, `Bot/src/publicIp.js`, `Bot/docker/*` | Manage fixed slots `yj_autopost_vpn_1..5` (`127.0.0.1:18801..18805`), enforce the host-wide 7-container NordVPN ceiling and mandatory persistent volume (`_state`, `_auth`) reuse, forbid automatic `docker rm -f` on disable/startup reconciliation, verify SOCKS5h tunnel egress vs non-leaking host IP, and surface provider rate-limit errors. |

---

## 1.3 End-to-End Execution Flows

### Flow A: Startup, Singleton Acquisition & Crash Recovery
1. `index.js` loads `.env.local` + `process.env` via `env.js`, validates required keys and formats (`assertValidEnv`), and invokes `runner.run()`.
2. `runner.run()` acquires `SingleInstanceLock` (`Bot/data/bot.lock`), verifying any existing lock holder via `kill(pid, 0)` and `/proc/<pid>/stat` `starttime` before atomic temp-file + `rename` reclamation.
3. `SqliteStore` initializes `Bot/data/state.sqlite` (`WAL`, `synchronous=NORMAL`, `busy_timeout=5000`).
4. `queue.recoverProcessing()` runs in an immediate transaction before polling starts:
   - Items in `state === 'processing'` with `attempt.phase === 'claimed'` (never reached `onDispatch`) transition back to `pending` with `attempt` archived to `archivedAttempt`.
   - Items in `state === 'processing'` with `attempt.phase === 'dispatching'` (or legacy `dispatch_started`) transition to `ambiguous` (`reason: 'startup_crash_recovery'`), preventing any post-crash replay of an in-flight `POST`.
5. `forensicLogger.flushOutbox()` replays any uncommitted `state.pendingForensicOutbox` records to `forensic.jsonl` under `ForensicMutex` and prunes records older than 7 days (`SEVEN_DAYS_MS`).
6. `ui.restore()` transitions any interrupted `linkOutbox` `sending` entries to `ambiguous` (`reason: 'restart_during_send'`) and resumes a previously `running` cycle only if pending items and active quota capacity remain.

### Flow B: Single-Turn Publishing & Two-Phase Dispatch Handshake
```
Runner (Node.js)                 SqliteStore (WAL)          DirectXAdapter (Node)       direct_x_bridge.py (Python)
      |                                 |                            |                              |
      | 1. claimCycleItem(itemId,acct)  |                            |                              |
      |-------------------------------->| BEGIN IMMEDIATE            |                              |
      |                                 | state='processing'         |                              |
      |                                 | phase='claimed', token=T1  |                              |
      |<--------------------------------| COMMIT (returns pure res)  |                              |
      |                                 |                            |                              |
      | 2. vpnSlots.ensure(accountId) -> verifies healthy SOCKS5h 127.0.0.1:1880N (no new device)   |
      |                                 |                            |                              |
      | 3. adapter.open({account,proxy})|                            | 4. sessionGuard.acquireLease |
      |------------------------------------------------------------->|    spawn python -I           |
      |                                 |                            |----------------------------->|
      |                                 |                            |    verify v11.user_state()   |
      |<-------------------------------------------------------------|<-----------------------------|
      |                                 |                            |                              |
      | 5. adapter.publish({onDispatch})|                            | 6. cmd: publish              |
      |------------------------------------------------------------->|----------------------------->|
      |                                 |                            |    re-verify identity        |
      |                                 |                            |<--- event: dispatch_ready ---|
      |                                 |<-- 7. onDispatch() --------|                              |
      |   set dispatchEntered = true    |    BEGIN IMMEDIATE         |                              |
      |                                 |    verify cycle='running', |                              |
      |                                 |    token==T1, enabled,     |                              |
      |                                 |    !needsOwnerCaptcha,     |                              |
      |                                 |    phase='claimed'         |                              |
      |                                 |    set phase='dispatching' |                              |
      |                                 |    COMMIT -> returns true  |                              |
      |                                 |--------------------------->| 8. write: dispatch_ack       |
      |                                 |                            |----------------------------->|
      |                                 |                            |    9. Single CreateTweet POST|
      |                                 |                            |       (NO fallback on POST)  |
      |                                 |                            |   10. Verify author/Snowflake|
      |<-------------------------------------------------------------|<-- 11. result (+acctFailure)-|
      | 12. Record accountFailure (even if recoveredFromTimeline)    |                              |
      | 13. classifyPublishOutcome (any non-success after dispatchEntered => ambiguous)             |
      | 14. Token-fenced settlement + quota increment + pendingForensicOutbox in 1 transaction      |
```

---

## 1.4 Formal State Machines

### 1.4.1 Queue Item State Machine (`Bot/src/queue.js`, `Bot/src/runner.js`)

```
                  +-------------------+
   enqueue / CSV  |                   |  cancelPending()
 ---------------> |      pending      | -----------------> [ cancelled ]
                  |                   |
                  +---------+---------+
                            |
                            | claimCycleItem() [token=T, phase='claimed']
                            | (reverts to 'pending' ONLY if pre-dispatch failure
                            |  while phase === 'claimed' and !dispatchEntered,
                            |  preserving i.payload.account pin)
                            v
                  +-------------------+
                  |    processing     |
                  |  (phase: claimed) |
                  +---------+---------+
                            |
                            | onDispatch() [token=T, phase='dispatching']
                            | === IRREVERSIBLE DISPATCH FENCE ===
                            v
                  +-------------------+
                  |    processing     |
                  | (phase:dispatching|
                  +----+---------+----+
                       |         |
    confirmed URL &    |         | ANY unconfirmed outcome, timeout, HTTP 429,
    matching author/   |         | network drop, crash recovery, or exception
    Snowflake >= start |         | after dispatchEntered / phase='dispatching'
                       v         v
             [ published ]     [ ambiguous (QUARANTINED) ]
                                 (NEVER auto-requeued; Queue.requeue() throws
                                  AMBIGUOUS_REQUEUE_FORBIDDEN)
```

### 1.4.2 Account Lifecycle & Restriction State Machine (`Bot/src/accounts.js`, `Bot/src/telegramUi.js`)

| Account Status (`account.status`) | `enabled` | `needsOwnerCaptcha` | Eligible for Selection? | Permitted Transitions |
|---|---|---|---|---|
| `'نشط'` (Active) | `true` | `false` | **Yes** (if active count $\le 5$ and quota $< \text{dailyQuota}$) | $\to$ `'غير نشط'` (operator disable)<br>$\to$ `'معزول (3 إخفاقات)'` (3 transient strikes)<br>$\to$ `'كابتشا - يتطلب حل يدوي'` (codes `326/353/399/241`)<br>$\to$ `'محظور'` (codes `63/64/141`) |
| `'غير نشط'` (Inactive) | `false` | `false` | No | $\to$ `'نشط'` (operator enable inside CAS transaction checking active count $< 5$ and no restriction flags) |
| `'غير متحقق (يتطلب فحص الجلسة)'` | `false` | `false` | No | $\to$ `'غير نشط'` (after successful `/cookie_verify` or `check_session`) |
| `'معزول (3 إخفاقات)'` (Isolated) | `false` | `false` | No | $\to$ `'غير نشط'` / `'نشط'` (operator manual reset/enable) |
| `'كابتشا - يتطلب حل يدوي'` (`isCaptchaStatus`) | `false` (Forced) | `true` (Forced) | **Strictly Forbidden** | **Manual-Only:** Operator resolves challenge in browser $\to$ clicks `accmanage:verify_captcha:<id>` $\to$ live `isolatedVerifier.verify` succeeds $\to$ transitions to `'غير نشط'` (`enabled: false, needsOwnerCaptcha: false`). Operator must then explicitly click Enable. **Never overwritten by `disable`, `disable_all`, or `/accounts_csv`.** |
| `'محظور'` (Banned/Suspended) | `false` (Forced) | `false` | **Strictly Forbidden** | Permanent quarantine unless replaced with new verified credentials via explicit owner action. **Never overwritten by `accounts.update({enabled: true})` or `/accounts_csv`.** |

---

## 1.5 SQLite Transactional Invariants & CAS Retry-Safe Mutator Contract

### Root Cause of `PERSIST-OBS-04` and `RUN-02`
In `Bot/src/sqliteStore.js:237–262`, `SqliteStore.update(mutator)` previously loaded state, ran `const next = await mutator(draft)` *outside* `BEGIN IMMEDIATE`, and then attempted `UPDATE state SET json = ?, revision = revision + 1 WHERE id = 1 AND revision = ?`. When a concurrent writer incremented `revision`, `SqliteStore.update()` caught `REVISION_CONFLICT` and re-invoked `mutator(draft)` in a retry loop. Because callers (`runner.js:143`, `runner.js:953`, `runner.js:1006`, `queue.js:55`) mutated outer `let` variables (`dispatchReady = true`, `result.claimed = true`, `transitioned = true`) during Pass 1 and did not reset them when Pass 2 took an early-return guard branch, the stale outer variable from Pass 1 survived and returned a false positive (`dispatchReady === true` despite SQLite committing Pass 2's `phase: 'claimed'`).

### Post-Audit Transactional & CAS Contract
1. **Synchronous Mutators Run Inside `BEGIN IMMEDIATE`:**
   All state mutators in `Bot/src/*` are synchronous state transformations. `SqliteStore.update(mutator)` acquires `BEGIN IMMEDIATE` *first*, reads `SELECT json, revision FROM state WHERE id = 1` inside the write lock, executes `mutator(draft)` synchronously (rejecting any returned Promise/thenable with `TRANSACTION_ASYNC_YIELD`), and writes `UPDATE state SET json = ?, revision = revision + 1 WHERE id = 1 AND revision = ?` before `COMMIT`. Because `BEGIN IMMEDIATE` serializes SQLite writers at the engine level before `SELECT`, no second connection can interleave between read and write!
2. **Pure Per-Pass Return Value Contract (`{ state, result }`):**
   Even if a retry occurs (e.g., `SQLITE_BUSY` retry), `SqliteStore.update(mutator)` supports returning a tuple or attaching per-pass result metadata, AND every caller (`claimCycleItem`, `onDispatch`, post-publish settlement, `Queue.enqueue`, `Queue.replacePending`) MUST reset its local outcome variables at the **first line inside the `mutator(s)` callback** (e.g., `dispatchReady = false;` at the top of `store.update(s => { dispatchReady = false; ... })`).
3. **Canonical + Inode Production Database Guard (`PERSIST-OBS-05`):**
   `SqliteStore` and `SessionGuard` must block test mutations (`NODE_ENV === 'test'` or `process.execArgv.includes('--test')`) against *both* `path.resolve(__dirname, '../data/state.sqlite')` AND the fixed host production root `/root/Projects/YJAutoPostOnX/Bot/data/state.sqlite` (comparing both normalized paths and `fs.statSync` `dev`/`ino` pairs so symlinks and secondary git worktrees cannot bypass the guard).

---

## 1.6 CAPTCHA Manual-Only Invariant

1. **Detection & Immediate Quarantine:** Any X error code in `{326, 353, 399, 241}` or challenge status sets `account.enabled = false`, `account.needsOwnerCaptcha = true`, `account.status = 'كابتشا - يتطلب حل يدوي'`, and assigns a deterministic or UUID `captchaIncidentId`.
2. **Unconditional Propagation Across Timeline Recovery (`XT-02`):** `DirectXAdapter.publish()` (`directX.js:285–292`) MUST preserve `accountFailure`, `xErrorCode`, and `xErrorMessage` on the returned object even when `result.published && result.recoveredFromTimeline` is true so `runner.js:977` always isolates the challenged account.
3. **Security Signal Resilience Against Generation Drift (`XT-03`):** In `TelegramUi.recordAccountCheck()` (`telegramUi.js:859–865`), if `check.accountFailure` is `'captcha'` or `'banned'` and the `cookieFile` / `userId` still match the account, the security isolation MUST be applied even if `checkGeneration` or `enabled` drifted during the in-flight attempt.
4. **In-Transaction Enable & Selection Guards (`TR-04`, `TR-06`, `ACC-RAW-04`):**
   - `accountRecord()` (`accounts.js:47–50`) forces `enabled = false` whenever `needsOwnerCaptcha === true`, `isCaptchaStatus(status)`, or `status === 'محظور'`.
   - `TelegramUi.accountToggle` and `accountManage` re-verify `!target.needsOwnerCaptcha && !isCaptchaStatus(target.status) && target.status !== 'محظور'` and `activeCount < 5` *inside* the `store.update()` transaction.
   - `runner.selectAccount`, `claimCycleItem`, and `onDispatch` explicitly check `!account.needsOwnerCaptcha && !isCaptchaStatus(account.status) && account.status !== 'محظور'`.
5. **No Status Overwrite on Disable or CSV Import (`UI-02`, `ACC-RAW-01`):**
   - `accmanage:disable` and `accounts:disable_all` keep `target.status = 'كابتشا - يتطلب حل يدوي'` whenever `target.needsOwnerCaptcha || isCaptchaStatus(target.status)` is true.
   - `AccountManager.replaceFromCsv()` merges existing security fields (`needsOwnerCaptcha`, `captchaIncidentId`, `'كابتشا - يتطلب حل يدوي'`, `'محظور'`, `enabled: false`) for any account matching by `id`, `username`, or `userId`.

---

## 1.7 5-Session & 7-Container Hard Limits

1. **Host-Wide 7-Container NordVPN Cap:**
   Only 7 NordVPN containers are authorized on the host (`cryptovpn-nordvpn`, `yjdownloadvideo-nordvpn-1`, and `yj_autopost_vpn_1..5`).
2. **Zero Ephemeral Container / Volume Spawns (`VPN-RAW-01`):**
   `dockerVpn.js` (`ensureContainer`) must verify before any `docker run`:
   - Both named volumes (`yj_autopost_vpn_N_state` and `yj_autopost_vpn_N_auth`) already exist via `docker volume inspect` (preventing empty-volume creation and fresh `nordvpn login` device registration).
   - Total existing NordVPN containers on the host (`docker ps -a`) do not exceed 7.
3. **Non-Destructive Slot Release & Startup Reconciliation (`VPN-RAW-02`, `TR-05`):**
   - Disabling an account or running startup `reconcileResources` MUST NOT run `docker rm -f` on `yj_autopost_vpn_1..5`. Fixed slots `1..5` are persistent infrastructure; releasing a mapping unassigns the account or stops the container gracefully without destroying the container or its device identity.
   - In `telegramUi.js` (`:1128`, `:1201`, `:1487`), `vpnManager.release(id)` is invoked *before* deleting `s.vpnSlots[id]` (or `vpnManager.release` owns the `s.vpnSlots` cleanup transactionally).
4. **5-Session Host-Wide Ceiling (`SESSION-RAW-01..03`):**
   - `sessionGuard.js` locks the canonical `/root/Projects/YJAutoPostOnX/Bot/data/session_leases.sqlite` (unless explicitly running inside an isolated test fixture with a mock bridge), verifies `/proc/<pid>/stat` field 22 `starttime` alongside `cmdline` for both `owner_pid` and `child_pid`, and fails closed (killing the spawned child and releasing the lease) if `bindChildProcess()` fails to update SQLite.

---

## 1.8 Outbox Durability & Secret-Safe Forensic Logging

1. **Single Atomic Outbox Write Path (`PERSIST-OBS-03`, `RUN-05`):**
   `ForensicLogger.record()` writes every new event into both `state.forensicLogs` and `state.pendingForensicOutbox` inside the `SqliteStore.update()` transaction, then flushes `pendingForensicOutbox` to `forensic.jsonl` under `ForensicMutex` (with file `fsync` before removing flushed IDs from `pendingForensicOutbox`). `runner.js` registers all in-flight forensic promises in a tracked `Set` drained during shutdown (`finally` block) before `store.close()`.
2. **Fail-Closed `ForensicLogger.reconcile()` (`PERSIST-OBS-01`):**
   If `store.load()` throws or `forensic.jsonl` fails to read (for any reason other than `ENOENT`), `reconcile()` throws immediately without modifying `state.sqlite` or `forensic.jsonl`. Temp file writes in `reconcile()` and `prune()` use `fsync(fd)` + `rename` + parent directory `fsync`.
3. **Top-Level Key Redaction (`UTIL-RAW-01`):**
   `formatStructuredLog(event, extra)` in `Bot/src/structuredLogger.js:102–105` checks `SENSITIVE_KEY_PATTERN.test(key)` on every top-level key of `extra` before calling `sanitizeValue(val)`, redacting matching keys to `'[REDACTED]'`.

---

## 1.9 X Policy Compliance Gate

Per `official-policy-evidence.md`, X Developer Policy prohibits spam, platform manipulation, and rate-limit circumvention, and requires write actions to comply with X Automation Rules (which returned `HTTP 403` from `help.x.com` during the audit). Therefore:
1. **No Live Unapproved Website-Scripting Tests:** All automated tests in `P01`–`P07` must run 100% offline using isolated local loopback/mock harnesses (`unshare -Urn` network namespace or in-memory stubs).
2. **No Transport Fallback Replay on POST (`PY-RAW-02`):** `direct_x_bridge.py` must never replay a failed `POST` (`CreateTweet`) onto a secondary HTTP library (`httpx`) based on unstructured exception message substrings.
3. **No Automatic Evasion Rotation (`VPN-RAW-04`):** `runner.js` and `telegramUi.js` must not automatically rotate NordVPN city/IP on account strikes or enable actions to evade X rate limits or enforcement.
4. **Snowflake Timestamp Attribution (`XT-01`):** `verify_timeline()` in `direct_x_bridge.py` extracts the exact UTC creation timestamp from the X Snowflake `tweet_id` (`((int(tweet_id) >> 22) + 1288834974657) / 1000.0`) and requires `tweet_timestamp >= dispatch_started_at - 2.0` in addition to exact normalized text and author ID match.
5. **Pre-Dispatch Weighted Character Validation (`ADD-P5-01`):** Validate X weighted tweet length ($\le 280$ weighted characters, counting URLs as 23 characters) before dispatch so oversized items fail cleanly without hitting upstream `186`.

---

## 1.10 Architecture Decision Records (ADRs) Mapped to Code Evidence

| ADR ID | Decision Title | Architectural Rule | Primary Code Evidence |
|---|---|---|---|
| **ADR-001** | In-Transaction Synchronous Mutators & Pure Per-Pass CAS Outputs | Execute `mutator(draft)` inside `BEGIN IMMEDIATE` and reset/return per-pass outcome values so CAS retries never leak stale closure flags. | `Bot/src/sqliteStore.js:135–149, 237–262`; `Bot/src/runner.js:142–163, 949–968, 1005–1055` (`PERSIST-OBS-04`, `RUN-02`) |
| **ADR-002** | Irreversible Post-Dispatch Ambiguity Quarantine | Any item that enters `onDispatch` (`phase: 'dispatching'` or `dispatchEntered === true`) and does not receive a confirmed `published` receipt is quarantined as `ambiguous`; `Queue.requeue()` rejects `ambiguous` items. | `Bot/src/publishOutcome.js:5–10`; `Bot/src/queue.js:19–22, 91–107`; `Bot/src/runner.js:949–980, 1094–1230` (`PERSIST-OBS-02`, `XT-04`) |
| **ADR-003** | Snowflake-Bounded Timeline Recovery & Zero POST Transport Fallback | Disable `curl_cffi -> httpx` fallback for non-idempotent `POST` requests and require Snowflake tweet creation time $\ge \text{dispatch\_started\_at} - 2\text{s}$ during timeline recovery. | `Bot/python/direct_x_bridge.py:229–265, 384–422, 646–825` (`PY-RAW-02`, `XT-01`) |
| **ADR-004** | Authenticated Pre-Dispatch Session Verification (No Blind `use_cache`) | Every publishing session must verify live session validity (`v11.user_state`) rather than returning `authenticated: True` solely from cached `userId` + public profile lookup. | `Bot/python/direct_x_bridge.py:516–590`; `Bot/src/directX.js:123–128` (`PY-RAW-01`, `PY-RAW-03`) |
| **ADR-005** | Manual-Only CAPTCHA Governance Across UI, Runner, and CSV Imports | Enforce `!needsOwnerCaptcha && !isCaptchaStatus(status) && status !== 'محظور'` inside all SQLite write transactions (`accountToggle`, `accountManage`, `accounts.update`, `replaceFromCsv`, `runner.selectAccount`/`claimCycleItem`/`onDispatch`) and propagate `accountFailure` on timeline-recovered posts. | `Bot/src/accounts.js:47–50, 150–235`; `Bot/src/telegramUi.js:859–928, 1120–1613`; `Bot/src/directX.js:285–292` (`ACC-RAW-01`, `TR-04`, `TR-06`, `UI-02`, `XT-02`, `XT-03`) |
| **ADR-006** | Static 5-Slot VPN Preservation & Host-Wide 7-Container Ceiling | Never run `docker rm -f` on `yj_autopost_vpn_1..5` during account disable or startup reconciliation; require pre-existing `_state`/`_auth` volumes and $\le 7$ host NordVPN containers before any `docker run`. | `Bot/src/dockerVpn.js:51–54, 95–202, 229–277, 363–413`; `Bot/src/telegramUi.js:1120–1145, 1197–1209, 1483–1495` (`VPN-RAW-01..04`, `TR-05`) |
| **ADR-007** | Starttime-Fenced Singleton & 5-Session Lease Registry | Unify `SingleInstanceLock` into `src/singleInstance.js` and fence both singleton locks and `session_leases.sqlite` PIDs using `/proc/<pid>/stat` field 22 `starttime` with fail-closed `bindChildProcess`. | `Bot/src/singleInstance.js:23–260`; `Bot/src/runner.js:25–131, 268–269`; `Bot/src/sessionGuard.js:28–57, 261–277` (`RUN-01`, `ENTRY-RAW-01`, `SESSION-RAW-01..03`) |
| **ADR-008** | Unified Transactional Forensic Outbox & Key-Aware Secret Redaction | Route all `forensicLogger.record()` calls through `state.pendingForensicOutbox`, abort `reconcile()` on read errors, and enforce `SENSITIVE_KEY_PATTERN` on top-level `extra` keys in `structuredLogger.js`. | `Bot/src/forensicLogger.js:107–151, 334–475`; `Bot/src/structuredLogger.js:34–50, 102–105` (`PERSIST-OBS-01`, `PERSIST-OBS-03`, `UTIL-RAW-01`) |
| **ADR-009** | Strict Offline Unit Test Default (`npm test`) vs Gated Live Ops Scripts | `Bot/package.json` `npm test` must execute only deterministic, 100% offline unit/integration tests using isolated `mkdtemp` stores; live VPS/VPN/Telegram probes move to an explicit opt-in directory (`Bot/test-live/`) requiring `ALLOW_LIVE_VPS_TESTS=1`. | `Bot/package.json:10`; `Bot/scripts/run_all_automated_tests.sh`; `Bot/test/*` (`CI-01`, `CI-06`) |
| **ADR-010** | Dual-Product CI Coverage (`Bot` + `Appimage`) & Truthful Release Gates | GitHub Actions must run `Bot/` Node + Python offline test suites alongside `Appimage/` checks, preserve `boot.log` on failure before `trap` cleanup, assert `BOOT_EXIT` is `124`/`137` (45s survival), and fail closed on `npm audit` metadata absence. | `.github/workflows/verify-xposter.yml`; `.github/workflows/apply-remaining-repair.yml`; `Appimage/scripts/verify-release.sh` (`CI-02..05`, `CI-07..08`) |

---


---

# Section 7: Fresh Test Matrix (`Bot/test/`), CI/Electron Repair Specification, Deletion & Retention Manifest Summary & Rollback Instructions

## 7.1 Fresh Test Suite Specification & Matrix (`Bot/test/`)

# Phase 4 Fresh Test Suite Specification (`Bot/test/`)

- **Target Repository**: `/root/Projects/YJAutoPostOnX` (and surgical audit worktree `/root/Projects/YJAutoPostOnX-surgical-audit`)
- **Target Test Root**: `/root/Projects/YJAutoPostOnX/Bot/test/` (sole test directory across the entire `Bot/` project)
- **Unified Entrypoint**: `Bot/test/run_all.js` (invoked via `npm test` in `Bot/package.json`)
- **Prerequisite Gate**: All 96 legacy test/runner/script files (`58` in `Bot/test/*.test.js`, `1` in `Bot/test/p2_reproducer_test.py`, `13` in `Bot/python/test_*.py`, `7` in `Bot/TEST_RUNNER/*`, `17` in `Bot/scripts/*`) and `32` associated `.pyc` files listed in `phase3-deletion-manifest.json` are retired in Phase 4 so that ONLY the fresh test tree specified below exists under `Bot/test/`.

---

## 1. Non-Negotiable Safety, Isolation & Execution Invariants

Every test file and helper under `Bot/test/` MUST enforce the following invariants:

1. **Zero Production State Touch (`Bot/data/*` Immutability Gate)**:
   - No test may open, mutate, `chmod`, or unlink any file inside `/root/Projects/YJAutoPostOnX/Bot/data/` or `/root/Projects/YJAutoPostOnX-surgical-audit/Bot/data/`.
   - `Bot/test/run_all.js` records the pre-run and post-run `size`, `mtime_ns`, and `SHA-256` of `/root/Projects/YJAutoPostOnX/Bot/data/state.sqlite`, `state.sqlite-wal`, `session_leases.sqlite`, `telegram-runner.lock`, and `vpn.lock`, failing the test run immediately if any byte or timestamp changes when the live daemon is stopped, or if any test process opens a handle to `Bot/data/*`.
   - Every test suite creates its own hermetic temporary directory via `fs.mkdtempSync(path.join(os.tmpdir(), 'yj-bot-test-'))` (or `tempfile.TemporaryDirectory(prefix='yj-bot-py-')` in Python) and cleans it up unconditionally in `after()` / `tearDown()` / `finally`.

2. **Zero External Network & Zero Live Posting**:
   - No test may connect to `api.telegram.org`, `x.com`, `api.x.com`, `twitter.com`, `api.ipify.org`, `icanhazip.com`, `ifconfig.me`, or any non-loopback IP address.
   - `Bot/test/fixtures/hermetic_workspace.js` installs a global `http.request` / `https.request` / `fetch` interceptor in Node tests and blocks non-`127.0.0.1` sockets fail-closed (`ERR_EXTERNAL_NETWORK_FORBIDDEN_IN_TEST`).
   - All Telegram interactions use `Bot/test/fixtures/fake_telegram_server.js` bound to `127.0.0.1:0` (ephemeral loopback port) or injected in-memory transport doubles.
   - All X/Twikit interactions use `Bot/test/fixtures/fake_direct_x_bridge.js` or `Bot/test/fixtures/fake_twikit_client.py` with zero real cookie files and zero real X network calls.

3. **Zero Docker / NordVPN Container Mutations (Strict 7-Container Host Cap)**:
   - No test may execute real `docker run`, `docker rm`, `docker start`, `docker restart`, or `docker exec ... nordvpn ...` commands.
   - `dockerVpn.js` is always tested with an injected deterministic `execFile` / command-runner spy (`Bot/test/fixtures/fake_docker_vpn.js`), guaranteeing zero contact with the 7 authorized host NordVPN containers (`cryptovpn-nordvpn`, `yjdownloadvideo-nordvpn-1`, `yj_autopost_vpn_1..5`).

4. **Zero Bytecode Pollution & Bounded Execution**:
   - `Bot/test/run_all.js` sets `PYTHONDONTWRITEBYTECODE=1`, `NODE_ENV=test`, and `YJ_TEST_MODE=1`, and invokes Python with `-B` (`/root/Projects/YJAutoPostOnX/Bot/.venv-direct-x/bin/python -B -m unittest ...`).
   - Every Node test runner invocation uses `--test-concurrency=2` and `--test-timeout=30000`, wrapped in an outer process timeout (`45s` per suite, `180s` total run).
   - Python unit tests patch `asyncio.sleep` with `AsyncMock` so retry/backoff logic executes in milliseconds without real-time delays.

---

## 2. Target Directory & File Architecture (`Bot/test/`)

```text
Bot/test/
├── run_all.js                                              # Unified test runner, preflight/postflight DB hash verifier & JSON/TAP summary
├── fixtures/
│   ├── hermetic_workspace.js                               # mkdtemp sandbox, env isolation, outbound network blocker, prod DB hash guard
│   ├── fake_telegram_server.js                             # Ephemeral 127.0.0.1 HTTP server & transport double for Telegram Bot API
│   ├── fake_direct_x_bridge.js                             # Deterministic Node-side child bridge simulator & IPC fault injector
│   ├── fake_docker_vpn.js                                  # Command-runner spy/stub for dockerVpn.js & VpnSlotManager (7-container policy)
│   └── fake_twikit_client.py                               # Spec-locked Python Twikit/curl_cffi mock client (_last_error=None, _last_response=None)
├── node/
│   ├── 01_pure_logic.test.js                               # Pure domain logic, classifiers, quota, scheduling, CSV, cookies, env, tables, logger (9 tests)
│   ├── 02_durable_sqlite_and_outbox.test.js                # SqliteStore, CAS retry closure reset, ForensicLogger/Outbox, Queue, 53d0 settlement (6 tests)
│   ├── 03_fault_injection_and_runner.test.js               # Runner claim/dispatch fencing, pre/post-dispatch faults, 3-strikes, singleton lock (7 tests)
│   ├── 04_captcha_and_restrictions.test.js                 # CAPTCHA state machine, manual verify CAS, toggle/CSV race guards, dual-chat receipts (5 tests)
│   ├── 05_sessions_and_vpn_limits.test.js                  # 5-session host ceiling, 7-container NordVPN guard, slot release order, IP leak gate (5 tests)
│   └── 06_telegram_ui_and_scheduler.test.js                # /account_toggle command vs callback, scheduler day commit, CSV dedup, UI flows (3 tests)
├── python/
│   ├── test_01_classifiers_and_compat.py                   # X numeric error classifiers, word-bounded 429, MagicMock safety, URL normalization (4 tests)
│   ├── test_02_identity_and_transport.py                   # verify_identity cache bypass fix, user_state/settings checks, User patch isolation (4 tests)
│   └── test_03_publish_and_timeline.py                     # Pre-send vs post-send fallback gate, timeline dispatch_started_at lower bound, SOCKS (3 tests)
└── e2e/
    ├── 01_service_nonposting_pipeline.e2e.test.js          # Full nonposting cycle: startup recovery -> readiness -> rotation -> CSV export -> shutdown (1 test)
    └── 02_adversarial_crash_and_captcha_isolation.e2e.test.js # Mid-dispatch CAS conflict + crash recovery, CAPTCHA E2E isolation, 3-strikes halt (1 test)
```

---

## 3. Detailed Specification of Unified Runner & Fixtures

### 3.1 `Bot/test/run_all.js`
- **Role**: Single authoritative test entrypoint (`"test": "node test/run_all.js"` in `Bot/package.json`), replacing `Bot/scripts/run_all_automated_tests.sh` and `Bot/TEST_RUNNER/run_suite.py`.
- **Execution Pipeline**:
  1. **Preflight Safety Check**:
     - Verifies `NODE_ENV=test`, `YJ_TEST_MODE=1`, `PYTHONDONTWRITEBYTECODE=1`.
     - Records cryptographic baseline (`size`, `sha256`) of `/root/Projects/YJAutoPostOnX/Bot/data/state.sqlite` and `session_leases.sqlite` (opened read-only or stat-only) and verifies no test files exist outside `Bot/test/`.
  2. **Stage 1 — Node Unit & Integration Suites (`Bot/test/node/*.test.js`)**:
     - Runs `node --test --test-concurrency=2 --test-timeout=30000 Bot/test/node/*.test.js` with a hard 90-second stage timeout.
     - Parses actual test runner exit code and tap/spec counts (never falling back to fabricated static pass numbers; fixes `audit-ci-appimage.md` Finding #6).
  3. **Stage 2 — Python Bridge Suites (`Bot/test/python/test_*.py`)**:
     - Resolves `/root/Projects/YJAutoPostOnX/Bot/.venv-direct-x/bin/python` (failing closed if the venv interpreter is missing rather than silently skipping).
     - Runs `<venv_python> -B -m unittest discover -s Bot/test/python -p "test_*.py" -v` with `PYTHONDONTWRITEBYTECODE=1` and a hard 60-second stage timeout.
  4. **Stage 3 — Nonposting Service E2E Suites (`Bot/test/e2e/*.e2e.test.js`)**:
     - Runs `node --test --test-concurrency=1 --test-timeout=45000 Bot/test/e2e/*.e2e.test.js` with a hard 90-second stage timeout.
  5. **Postflight Verification**:
     - Re-verifies `/root/Projects/YJAutoPostOnX/Bot/data/state.sqlite` and `session_leases.sqlite` invariants.
     - Verifies zero `.pyc` files were created in `Bot/python/__pycache__` or `Bot/test/` during the run.
     - Emits a deterministic JSON & console summary with exact pass/fail/cancelled counts and exits non-zero on any failure, timeout, or skipped stage.

### 3.2 `Bot/test/fixtures/hermetic_workspace.js`
- `createHermeticWorkspace(prefix = 'yj-test-')`:
  - Creates `tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))` with `0o700` permissions.
  - Creates subdirectories `cookies/`, `logs/`, `exports/`, `secrets/` inside `tempDir`.
  - Initializes an isolated `dbPath = path.join(tempDir, 'state.sqlite')` and `leaseDbPath = path.join(tempDir, 'session_leases.sqlite')`.
  - Sets scoped environment overrides (`BOT_DATA_DIR: tempDir`, `SESSION_GUARD_DB_PATH: leaseDbPath`, `SERVER_IP: '203.0.113.10'`) and restores `process.env` in `cleanup()`.
  - Provides `writeSyntheticCookie(accountId, overrides)` writing a valid 0o600 JSON cookie file (`auth_token`, `ct0`, `twid`) inside `tempDir/cookies/`.
  - Provides `cleanup()` which closes any registered `SqliteStore` / `ForensicLogger` instances, releases any test session leases, and executes `fs.rmSync(tempDir, { recursive: true, force: true })`.

### 3.3 `Bot/test/fixtures/fake_telegram_server.js`
- Provides both an in-process `FakeTelegramApi` and a real loopback `http.createServer` bound to `127.0.0.1:0` for HTTP-level tests (`telegramApi.js`).
- Tracks every request (`method`, `chat_id`, `text`, `parse_mode`, `reply_markup`, `document`, `message_id`) per destination chat.
- Supports programmable fault modes per chat or per method:
  - `409 Conflict` (transient N times vs persistent).
  - `429 Too Many Requests` with `parameters.retry_after`.
  - `400 Bad Request: can't parse entities` (triggers plain-text fallback in `telegramApi.js`).
  - Partial dual-chat failure (e.g., `chat 1` succeeds with `{ ok: true, result: { message_id: 101 } }`, `chat 2` fails with `502 Bad Gateway` or returns malformed `{ ok: true, result: {} }` missing `message_id`).
  - Long-poll delay simulation for `getUpdates` timeout adaptation tests (`FINDING-018`).

### 3.4 `Bot/test/fixtures/fake_direct_x_bridge.js` & `Bot/test/fixtures/fake_twikit_client.py`
- `fake_direct_x_bridge.js`:
  - Spawns either a fast Node/Python loopback child script or intercepts `DirectXAdapter` session lifecycle to test framing (`1 MiB` line limit), `dispatch_ready` -> `onDispatch` -> `dispatch_ack` handshake, child crash (`SIGKILL`) mid-dispatch, and parent-death cleanup.
- `fake_twikit_client.py`:
  - Provides `SpecLockedMockClient` where `_last_response = None`, `_last_error = None` are explicitly initialized (`mock-testing-safety`), preventing `MagicMock` auto-attribute truthiness bugs.
  - Supports programmable `user_state`, `settings`, `get_user_by_id`, `create_tweet`, and `get_user_tweets` responses, including synthetic tweets with configurable `created_at` timestamps relative to `dispatch_started_at`.

### 3.5 `Bot/test/fixtures/fake_docker_vpn.js`
- Intercepts all CLI calls in `dockerVpn.js` (`docker inspect`, `docker ps -a`, `docker run`, `docker rm -f`, `docker exec`, `curl`).
- Simulates the 7 host NordVPN containers (`cryptovpn-nordvpn`, `yjdownloadvideo-nordvpn-1`, `yj_autopost_vpn_1..5`) with configurable container count, volume mounts (`yj_autopost_vpn_N_state`, `yj_autopost_vpn_N_auth`), image tags (`6.0.2` vs `latest`), SOCKS5 exit IPs (`198.51.100.1..5`), and NordVPN CLI outputs (`Too many connection attempts`, `Session Limit Reached`).

---

## 4. Domain-by-Domain Test Specifications & Audit Finding Regressions

### Domain 1: Pure Logic, Classifiers, Formatting & Secret Sanitization
**File**: `Bot/test/node/01_pure_logic_and_classifiers.test.js`

| Test ID | Target Module | Positive Cases | Negative / Adversarial Cases & Audit Finding Regressions |
|---|---|---|---|
| `L-01` | `src/quota.js` | `riyadhDay` & `riyadhDateParts` compute exact `Asia/Riyadh` (`UTC+03:00`) date across `20:59:59Z` -> `21:00:00Z` midnight rollover; `remainingQuota` & `hasQuota` respect per-account daily cap (10). | **Regression `FINDING-029`**: Invalid Date (`NaN`, `"invalid"`, `null`), negative/NaN stored quota values fail closed (`hasQuota === false`, `remaining === 0`). |
| `L-02` | `src/scheduling.js` | `isDue` returns `true` at exact configured `hour:minute` in `Asia/Riyadh` when `lastRunDay !== today`. | Returns `false` when `scheduleEnabled === false`, minute differs, or `lastRunDay === today`. |
| `L-03` | `src/publishOutcome.js` | Pre-dispatch `rateLimit: true` or `retryable: true` (`dispatchEntered: false`) classifies as `retryable`, `ambiguous: false`. | **Regression `FINDING-003` / `PY-RAW-04` / `XT-05`**: Whenever `dispatchEntered === true` and `published !== true` (or URL missing), `classifyPublishOutcome` ALWAYS returns `ambiguous: true, retryable: false`, even if bridge payload claims `rateLimit: true` or `retryable: true`. |
| `L-04` | `src/xFailureClassification.js` & `src/knownTwikitParserFailure.js` | GraphQL codes `186` (tweet too long) and `187` (duplicate tweet) classify as content rejection (`isXContentRejection === true`, 0 account strikes); `KeyError: 'urls'` classifies as known parser failure (`FINDING-008`). | Confirmed `banned` (`64`/`63`/`141`), `captcha` (`326`/`353`/`399`/`241`), `auth_expired` (`32`/`89`), and generic post-dispatch ambiguity are NEVER exempted as content rejections or parser failures. |
| `L-05` | `src/attemptOutcomes.js` | Records per-account, per-Riyadh-day `failed` and `ambiguous` counters independently of `published` quota; prunes records older than 14 days. | Published outcomes never increment failure/ambiguity counters; invalid inputs do not corrupt state. |
| `L-06` | `src/csv.js` & `src/cookieFormat.js` | Parses valid `accounts_csv` and `posts_csv` (including UTF-8 BOM from AppImage exports); parses JSON & Netscape cookies with required `auth_token` and `ct0`. | Rejects empty/header-only CSV (`EMPTY_ACCOUNTS_CSV`, `FINDING-017`); rejects CSV formula injection prefixes (`=`, `+`, `-`, `@`, `\t`, `\r`); **Regression `ACC-RAW-02`**: Enforces unified `1 MiB` (`1,048,576` bytes) max cookie size in Node to match Python bridge limit (rejecting `1.1 MiB` files before storage). |
| `L-07` | `src/env.js` & `src/publicIp.js` | Validates complete synthetic production environment; `isPublicIp` accepts global IPv4/IPv6. | **Regression `FINDING-016`**: Fails closed in `production`/`daemon` mode when any required key (`TELEGRAM_BOT_TOKEN`, `BOT_OWNER_ID`, `BOT_OWNER_CHAT_ID`, `SERVER_IP`) is missing or malformed; rejects private/loopback/reserved IPs (`127.0.0.1`, `10.0.0.1`, `169.254.1.1`, `::1`) as `SERVER_IP`; rejects null bytes in paths. Zero real credentials in test source. |
| `L-08` | `src/structuredLogger.js` | Emits closed-schema JSON logs; preserves non-secret diagnostic codes (`reason`, `xErrorCode`, `runId`). | **Regression `UTIL-RAW-01` & `FINDING-028`**: `formatStructuredLog({ token: 'secret123', cookie: 'ct0=abc', nested: { password: 'pw' } })` redacts **both** top-level sensitive keys (`token`, `cookie`, `authorization`, `password`, `secret`) AND nested keys, plus embedded JSON strings (`structured_logger_json_secrets`) and Bearer/Bot token regexes. |
| `L-09` | `src/tableUtils.js` & `src/accountTable.js` | Renders deterministic account status tables with Exit IP preservation during refresh (`refreshingIds`). | **Regression `FINDING-027` & `UTIL-RAW-02`**: Verifies HTML escaping of untrusted usernames/diagnostics (`<script>`, `&`) and verifies exact column alignment contract. |

---

### Domain 2: Durable SQLite State, CAS Closure Reset, Transactional Outbox & Guards
**File**: `Bot/test/node/02_sqlite_cas_outbox_and_guards.test.js`

| Test ID | Target Module | Positive Cases | Negative / Adversarial Cases & Audit Finding Regressions |
|---|---|---|---|
| `S-01` | `src/sqliteStore.js` | `load()` executes inside `BEGIN DEFERRED` returning independent cloned snapshots; `update()` executes synchronous `BEGIN IMMEDIATE` with `revision` increment. | **Regression `FINDING-025`**: Returning a Promise inside `transaction()` or `update()` mutator immediately throws `TRANSACTION_ASYNC_YIELD` and rolls back cleanly. |
| `S-02` | `src/sqliteStore.js` & `src/runner.js` | Optimistic concurrency retry succeeds when a second connection commits a non-conflicting change between `load()` and `BEGIN IMMEDIATE` (`FINDING-024`). | **Regression `PERSIST-OBS-04` / `FINDING-003` / `FINDING-009` / `RUN-02` (Critical CAS Closure Bug)**: Force a competing SQLite connection to set `account.enabled = false` (or supersede `attempt.token`) between the first mutator pass and `BEGIN IMMEDIATE`. Prove that on the retry pass, closure flags (`dispatchReady`, `claimed`, `transitioned`) are reset to `false` at the start of the mutator, returning `dispatchReady === false` and keeping durable phase `claimed` with ZERO `dispatch_ack`! |
| `S-03` | `src/sqliteStore.js` & `src/forensicLogger.js` | Read-only inspection (`{ readOnly: true }`) succeeds without mutating directory permissions (`0o700`) or WAL files. | **Regression `PERSIST-OBS-05` & `FINDING-012`**: Calling `save()`, `update()`, `prune()`, or `reconcile()` in test mode targeting EITHER `__dirname/../data/state.sqlite` OR canonical `/root/Projects/YJAutoPostOnX/Bot/data/state.sqlite` (even when invoked from a separate git worktree!) throws `PROD_DB_MUTATION_FORBIDDEN_IN_TEST` / `PROD_FORENSIC_MUTATION_FORBIDDEN_IN_TEST`. |
| `S-04` | `src/forensicLogger.js` & `src/forensicMutex.js` | Transactional outbox: committing an audit event into `state.pendingForensicOutbox` inside `store.update()` followed by `flushOutbox()` appends to `forensic.jsonl` (`0o600`), deduplicates by `event.id`, and clears `pendingForensicOutbox`. | **Regression `PERSIST-OBS-01` & `FINDING-030`**: Inject `store.load()` failure or `fs.readFile` failure during `ForensicLogger.reconcile()`; prove `reconcile()` aborts fail-closed without wiping existing `state.forensicLogs` or `forensic.jsonl`. Inject `writeFile` failure during `reconcile()`/`flushOutbox()`; prove `pendingForensicOutbox` is NOT cleared. Test 5 concurrent child processes contending on `ForensicMutex` and dead-PID orphan lock reclamation. |
| `S-05` | `src/queue.js` | `claimNext()` claims exactly 1 pending item per worker with unique `attempt.token`; `recoverProcessing()` resets pre-dispatch `processing/claimed` items to `pending` and archives attempt metadata to `item.archivedAttempt`. | **Regression `PERSIST-OBS-02` / `XT-04`**: `Queue.requeue(id)` throws `AMBIGUOUS_REQUEUE_FORBIDDEN` if called on an item with `state === 'ambiguous'`. `claimNext()` and `recoverProcessing()` never transition `ambiguous`, `published`, `failed`, or `cancelled` items to `pending`. `processing/dispatch_started` items transition strictly to `ambiguous` on startup recovery. |
| `S-06` | `scripts/settle_item_53d0f458.js` | On an isolated temp DB with a synthetic `ambiguous` 53d0 record and matching full 64-char SHA-256, atomically transitions to `published`, archives attempt, writes `pendingForensicOutbox`, and increments Nov 1 quota `9 -> 10`. | Rejects 1-char altered SHA-256 (`FULL_SHA256_MISMATCH`); rejects non-ambiguous state; idempotent when quota is already `10` (never `11`); fails closed with `QUOTA_RECONCILIATION_AMBIGUOUS` when baseline is `< 9` or `> 10`; blocks execution on production DB path without explicit approval env flag. |

---

### Domain 3: Fault Injection, Runner Dispatch Fencing, 3-Strikes & Process Lifecycle
**File**: `Bot/test/node/03_fault_injection_and_runner_fencing.test.js`

| Test ID | Target Module | Positive Cases | Negative / Adversarial Cases & Audit Finding Regressions |
|---|---|---|---|
| `F-01` | `src/runner.js` | Pre-dispatch transient network/proxy/VPN faults (`ECONNREFUSED`, `VPN_TRANSIENT_UNAVAILABLE`, pre-send timeout) leave item `pending`, record `0` account strikes, and transfer to next eligible account. | Post-dispatch network drop, child bridge `SIGKILL`, or timeout after `onDispatch` (`dispatchEntered = true`) quarantines item as `ambiguous`, deducts `0` quota, deletes active `attempt` (archiving provenance), and NEVER retries the item. |
| `F-02` | `src/runner.js` | 3-strikes progression: recoverable account failures increment `failures` (`1 -> 2` with cooling backoff, `0` Telegram alerts; `3` isolates account as `معزول (3 إخفاقات)`, `enabled: false`, and emits **exactly 1** Arabic isolation notification). Verified publish resets `failures` to `0`. | Confirmed `banned` or `captcha` isolates immediately on strike 1 without waiting for 3 strikes. HTTP `429` before dispatch applies rate-limit cooldown without incrementing or resetting strikes. |
| `F-03` | `src/directX.js` & `src/runner.js` | `DirectXAdapter.publish()` returns verified URL and `runner.js` settles `published` + increments quota under matching `attempt.token`. | **Regression `XT-02` (`accountFailure` Lost on Recovered Publish)**: When Python bridge returns `{ published: true, recoveredFromTimeline: true, url: '...', accountFailure: 'captcha', xErrorCode: 326 }`, `DirectXAdapter` preserves `accountFailure` and `xErrorCode` on the returned object, and `runner.js` both settles the published item AND immediately isolates the account for CAPTCHA! |
| `F-04` | `src/runner.js` & `src/telegramUi.js` | `recordAccountCheck` persists health & identity updates when `checkGeneration` matches. | **Regression `XT-03` (Stale Generation vs Security Restriction)**: If a critical restriction (`accountFailure: 'captcha'` or `'banned'`) is reported from an active dispatch attempt, concurrent non-security metadata updates cannot cause the restriction signal to be silently discarded. |
| `F-05` | `src/runner.js` | `isolatedVerifier.verify` updates account status on authoritative bridge response. | **Regression `RUN-03` (Transient Verifier Error)**: When `isolatedVerifier.verify` throws a transient VPN/socket timeout (`VPN_TRANSIENT_UNAVAILABLE` / `ETIMEDOUT`), it does NOT overwrite a healthy active account's status to disabled `غير متحقق` (`unverified`). |
| `F-06` | `src/runner.js` | **Regression `RUN-04` (Explicit Account Binding on Pre-Dispatch Failure)**: Tests explicit behavior for items with owner-pinned `payload.account` vs unpinned shared queue items when a pre-dispatch failure occurs, verifying payload hash integrity and routing rules. | Late `onDispatch` or late `publish` resolution with a superseded `attempt.token`, stopped `runId`, disabled account, or exhausted quota (`10/10`) is rejected with `DISPATCH_REJECTED` and zero state/quota mutation. |
| `F-07` | `src/runner.js` & `src/singleInstance.js` | **Regression `RUN-01` & `ENTRY-RAW-01`**: Both `src/singleInstance.js` and `runner.js` (unified on the same single-instance lock class) enforce mutual exclusion across 10 concurrent contenders, wait up to `timeoutMs` for clean release, and recover stale locks held by dead PIDs (`ESRCH`) or corrupt 0-byte lockfiles using atomic temp-write + rename + token verification. | **Regression `RUN-06` / `TR-07` (Shutdown Cleanup Guarantee)**: Inject a rejection into `watchdog.close()` and `ui.destroy()` during `runner.js` shutdown; prove that the outer `try/finally` still drains pending tasks, closes `SqliteStore`, and releases `SingleInstanceLock`! |

---

### Domain 4: CAPTCHA Manual-Only Gate, Account Restrictions & Dual-Chat Receipts
**File**: `Bot/test/node/04_captcha_manual_only_and_dual_chat_receipts.test.js`

| Test ID | Target Module | Positive Cases | Negative / Adversarial Cases & Audit Finding Regressions |
|---|---|---|---|
| `C-01` | `src/accounts.js` & `src/telegramUi.js` | Codes `326`, `353`, `399`, `241` isolate account with `enabled: false`, `needsOwnerCaptcha: true`, `status: 'كابتشا (مطلوب حل يدوي)'`, and durable `captchaIncidentId`. | Periodic background refresh (`recordAccountCheck`) or `auth_session_unverified` check NEVER clears `needsOwnerCaptcha`, never overwrites `captchaIncidentId`, and never enables the account. |
| `C-02` | `src/telegramUi.js` | Owner clicking `accmanage:verify_captcha` invokes live read-only identity verification (`verifyNetwork: true`); on success, clears `needsOwnerCaptcha`, sets `status: 'غير مفعل'`, and keeps `enabled: false` (manual owner enable required afterward). | Simultaneous double-tap on `accmanage:verify_captcha` is blocked by atomic rate-limiting CAS; if a new CAPTCHA incident `Event B` is injected while `Event A` verification is in-flight, `Event A` completion rejects stale CAS and preserves `Event B` (`needsOwnerCaptcha: true`). Username/userId mismatch during verification fails closed. |
| `C-03` | `src/telegramUi.js`, `src/telegramFlows.js` & `src/accounts.js` | Enabling an unrestricted `'غير مفعل'` account succeeds when active count `< 5`. | **Regression `TR-06` & `TR-04` (Concurrent Toggle/Enable Race)**: Simulate `accountToggle` or `accountManage` or `telegramFlows` loading state when account is `'غير مفعل'`, then inject a runner CAPTCHA isolation (`needsOwnerCaptcha = true`) or a 5th active account BEFORE the handler's `store.update()` runs. Prove the transactional guard inside `store.update()` rejects enabling the challenged/6th account (`toggled: false`, `enabled: false`, `needsOwnerCaptcha: true`)! |
| `C-04` | `src/accounts.js` (`replaceFromCsv`) | `replaceFromCsv` imports up to 1,250 accounts, auto-disabling surplus beyond 5 active accounts. | **Regression `ACC-RAW-01` (CSV Import Restriction Bypass)**: When an existing account in SQLite has `needsOwnerCaptcha: true` (or `status === 'محظور'` / `banned`) and `/accounts_csv` (`replaceFromCsv`) imports a row with the same account ID or `@username` and `enabled=true`, `replaceFromCsv` MUST preserve `needsOwnerCaptcha: true`, `captchaIncidentId`, and `enabled: false` instead of wiping the security restriction! |
| `C-05` | `src/telegramUi.js` & `src/runner.js` | `sendIsolationAlert` sends alert to both configured chats (`ownerChatId` and secondary admin chat) and records per-chat delivery receipts `{ chatId, messageId, deliveredAt }` under `captchaIncidentId`. | **Regression `TR-03` & Dual-Chat Partial Retry**: Rejects `undefined`, `null`, `true`, or `{ ok: true, result: {} }` lacking an integer `message_id`. When Chat 1 succeeds (`message_id: 501`) and Chat 2 fails (`502`), incident is NOT marked complete; subsequent retry sends ONLY to Chat 2 (`0` duplicate sends to Chat 1). When a second distinct CAPTCHA incident occurs later (`incident_2`), both chats are alerted fresh. |

---

### Domain 5: 5-Session Host-Wide Guard & 7-Container NordVPN Limits
**File**: `Bot/test/node/05_session_and_vpn_host_limits.test.js`

| Test ID | Target Module | Positive Cases | Negative / Adversarial Cases & Audit Finding Regressions |
|---|---|---|---|
| `V-01` | `src/sessionGuard.js` | Permits up to `5` concurrent session leases (`slot 0..4`); `releaseSessionLease` is idempotent. | 6th concurrent lease attempt across independent OS Node worker processes fails closed with `MAX_PROJECT_SESSIONS_EXCEEDED`; duplicate `session_key` is rejected; dead-PID (`ESRCH`) and recycled non-Node/non-Python PID leases are reconciled and reclaimed. |
| `V-02` | `src/sessionGuard.js` | `resetSessionsForTest` succeeds only on a non-symlinked path inside `os.tmpdir()`. | Throws `CUSTOM_PATH_REQUIRED`, `PROD_PATH_RESET_FORBIDDEN`, `TEMP_DIR_REQUIRED`, and `SYMLINK_RESET_FORBIDDEN`. **Regression `SESSION-RAW-01` & `SESSION-RAW-02`**: `/proc` scan errors and `bindChildPid` SQLite errors are surfaced rather than silently swallowed. |
| `V-03` | `src/dockerVpn.js` | Inspects and uses existing healthy owned slots `yj_autopost_vpn_1..5` (`ports 18801..18805`) with pinned image `6.0.2`. | **Regression `VPN-RAW-01` (Strict 7-Container Host Cap & Volume Fingerprint Guard)**: If a project slot container is missing, `ensureContainer` checks total host NordVPN containers (`docker ps -a`) and existing persistent volumes (`yj_autopost_vpn_N_state`, `yj_autopost_vpn_N_auth`); refuses to run `docker run` (`NORDVPN_HOST_CAP_EXCEEDED` / `NORDVPN_FINGERPRINT_VOLUME_MISSING`) if spawning would exceed 7 containers or create an unauthenticated ephemeral device fingerprint! |
| `V-04` | `src/dockerVpn.js` & `src/telegramUi.js` | Disabling an account unassigns its logical slot mapping in SQLite so another active account can use one of the 5 persistent slots. | **Regression `VPN-RAW-02` & `TR-05`**: (1) `telegramUi.js` (`accountToggle`, `accountManage` disable, disable-all) calls `vpnSlots.release(accountId)` BEFORE deleting `s.vpnSlots[accountId]` (or passes the prior slot explicitly); (2) `VpnSlotManager.release` unmaps the slot without executing destructive `docker rm -f` on persistent containers `yj_autopost_vpn_1..5` unless explicit operator container-replacement mode (with `nordvpn disconnect` pre-cleanup) is invoked. |
| `V-05` | `src/dockerVpn.js` | `rotateContainerIp` rotates city/exit IP on existing container when authorized and verifies new public IP != `serverIp`. | **Regression `VPN-RAW-03`**: Command wrapper preserves stderr/stdout on non-zero exit so `rotateContainerIp` immediately detects `Too many connection attempts` / `Session Limit Reached` and aborts rotation on attempt 1 instead of retrying 4 times. **Regression `FINDING-015`**: `getExitIp` never invokes `curl --noproxy "*"` or direct unproxied fallback; `healthCheck` fails closed on `exitIp === serverIp`. |

---

### Domain 6: Telegram UI, Commands, Flows, CSV Export Deduplication & Scheduler
**File**: `Bot/test/node/06_telegram_ui_flows_and_scheduler.test.js`

| Test ID | Target Module | Positive Cases | Negative / Adversarial Cases & Audit Finding Regressions |
|---|---|---|---|
| `U-01` | `src/runner.js` & `src/telegramUi.js` | Both `/account_toggle <id>` text command and `acctoggle:toggle:<id>` inline callback toggle an eligible account and update panels. | **Regression `TR-01` (`/account_toggle` Command Overwrite)**: Prove that spreading `ui.actions()` in `runner.js:1581` does NOT overwrite the `/account_toggle` text command handler with a callback-only no-op; invoking `/account_toggle acc-1` via text message dispatches to the command handler and toggles `acc-1` (subject to the same transactional CAPTCHA/ban/5-active guards as `C-03`). |
| `U-02` | `src/runner.js` & `src/scheduling.js` | When `isDue` matches in `Asia/Riyadh` and `ui.startScheduled()` succeeds, `uiScheduleDay` is persisted as today and cycle starts with origin `'schedule'`. | **Regression `TR-02` (Lost Schedule Window)**: If `ui.startScheduled()` returns `{ started: false }` (e.g. transient readiness check failure) or throws before cycle admission commits, `uiScheduleDay` is NOT prematurely marked completed (or allows bounded retry within the scheduled minute). |
| `U-03` | `src/linkExports.js` | Terminal CSV export (`links_YYYY-MM-DD.csv`) is enqueued and delivered to all configured chats via `sendDocument` with `message_id` receipts; SHA-256 content hash deduplicates identical exports across stop cycles. | **Regression `UTIL-RAW-03` (Unbounded Suppressed Terminal Events)**: Calling `enqueueTerminal` 15 consecutive times when 0 new items were published suppresses duplicate Telegram sends AND does NOT append 15 duplicate suppressed event objects to SQLite state. |
| `U-04` | `src/accountRefresh.js` | `startAccountRefresh` verifies accounts concurrently with abort support, preserves last known `exitIp` while refreshing, and clears `accountRefreshJob` on completion. | **Regression `UTIL-RAW-04`**: When `store.update` fails during `accountRefresh`, the storage error is logged via `structuredLogger` and surfaced cleanly without hanging the refresh loop. |
| `U-05` | `src/telegramApi.js` & `src/accounts.js` | `getUpdates` dynamically adapts socket timeout to `max(timeoutMs, (pollTimeoutSec + 15) * 1000)` (`FINDING-018`); `CookieStore` writes `0o600` temp file + `fsync` + atomic rename + dir `fsync` with `O_NOFOLLOW`. | **Regression `ENTRY-RAW-02` & `ACC-RAW-03`**: `telegramApi.js` enforces a bounded response byte limit (`maxBytes`) on JSON API responses to prevent unbounded memory accumulation on malformed upstream streams; `CookieStore` rejects symlinked target files and parent directories. |

---

### Domain 7: Python DirectX Bridge — Classifiers, Identity, Transport & Timeline Attribution
**Files**:
- `Bot/test/python/test_01_bridge_classifiers_and_urls.py`
- `Bot/test/python/test_02_identity_and_session_verification.py`
- `Bot/test/python/test_03_transport_and_timeline_attribution.py`

| Test ID | Target File / Function | Positive Cases | Negative / Adversarial Cases & Audit Finding Regressions |
|---|---|---|---|
| `P-01` | `test_01_bridge_classifiers_and_urls.py` (`direct_x_compat.py` & `direct_x_bridge.py`) | Authoritative numeric X error classification: `326`/`353`/`399`/`241` -> `captcha`; `64`/`63`/`141` -> `banned`; `32`/`89`/`215` -> `auth_expired`; `186` -> `tweet_too_long` (non-strike); `187` -> `duplicate_tweet` (non-strike); `88`/HTTP `429` -> `rate_limit`. | **Regression `PY-RAW-07` & `mock-testing-safety`**: (1) `is_rate_limit_exception` uses word-bounded `\b429\b` so snowflake IDs, timestamps, or `MagicMock` memory addresses (`id='140239429123'`) containing `429` never trigger false rate-limit classification; (2) `_last_create_tweet_error` and `_last_error` checks enforce `isinstance(err, BaseException)` so unconfigured `MagicMock` attributes are ignored; (3) **Regression `FINDING-010`**: removes loose substring ban fallbacks in `direct_x_compat.py:472-480`. |
| `P-02` | `test_01_bridge_classifiers_and_urls.py` (`normalize_urls` & `User` patch) | Normalizes missing `entities.description.urls` and `entities.url.urls` in nested GraphQL payloads (`FINDING-008`); canonicalizes `t.co` expanded URLs for timeline text matching; validates `curl_cffi==0.17.0` pin (`FINDING-012`). | **Regression `PY-RAW-05`**: Verifies `direct_x_compat.py` `User` normalization behavior and documents/guards process-level scope. |
| `P-03` | `test_02_identity_and_session_verification.py` (`verify_identity`) | Authenticated `v11.user_state` / `v11.settings` + matching `userId` and `@username` returns `authenticated: True`. | **Regression `PY-RAW-01` / `FINDING-007` (Cached Fast-Path Bypass)**: When `use_cache=True`, a public `get_user_by_id` lookup alone MUST NOT bypass authenticated session checks or mask a revoked/locked/CAPTCHA session; if authenticated state check fails with `326` or `64` or `89`, `verify_identity` fails closed with the exact `account_failure`! **Regression `PY-RAW-03`**: In the fallback branch (`bridge.py:575-590`), exceptions carrying `account_failure` (`banned`, `captcha`, `auth_expired`) are never swallowed as `authenticated: True`. |
| `P-04` | `test_03_transport_and_timeline_attribution.py` (`DirectXTransport`) | Routes all requests exclusively through loopback SOCKS5 `socks5h://127.0.0.1:18801..18805`; strips auth headers on `twimg.com` CDN requests; blocks non-allowlisted hosts (`ERR_HOST_NOT_ALLOWED`). | **Regression `PY-RAW-02` / `FINDING-001` (Non-Idempotent POST Fallback)**: On `POST` (`CreateTweet`), `httpx` fallback is strictly forbidden based on unstructured exception text (`"before send"`); fallback is only permitted on idempotent `GET` requests or strictly verified pre-connect socket errors before any TLS/HTTP payload write. |
| `P-05` | `test_03_transport_and_timeline_attribution.py` (`verify_timeline` & `publish`) | When `CreateTweet` drops after dispatch and `verify_timeline` finds a matching same-author tweet with `created_at >= dispatch_started_at - 5s`, returns `published: True, recoveredFromTimeline: True` with tweet URL. | **Regression `XT-01` / `FINDING-002` (Old Tweet Misattribution)**: Inject a same-author tweet with identical normalized text timestamped **20 minutes before** `dispatch_started_at` (within the old 1800s window, but `< dispatch_started_at - 5s`). Prove `verify_timeline` **REJECTS** the older tweet and returns `found: False, ambiguous: True` so an earlier post is never misattributed to a failed new dispatch! |
| `P-06` | `test_03_transport_and_timeline_attribution.py` (`publish` & IPC protocol) | Enforces `1 MiB` stdin frame limit (`FINDING-020`), `O_NOFOLLOW` cookie file check (`<= 1 MiB`), and two-phase `dispatch_ready` -> `dispatch_ack` handshake. | **Regression `PY-RAW-04` & `XT-02`**: If `CreateTweet` raises a `captcha` (`326`) exception and `verify_timeline` recovers a published tweet, `account_failure: 'captcha'` and `x_error_code: 326` are preserved in the response; if `verify_timeline` does not find a post-dispatch tweet, returns `ambiguous: True` and truncates/sanitizes any raw exception text (`PY-RAW-07`). |

---

### Domain 8: Nonposting Service End-to-End Pipeline (`Bot/test/e2e/`)
**Files**:
- `Bot/test/e2e/01_nonposting_service_lifecycle.e2e.test.js`
- `Bot/test/e2e/02_adversarial_crash_and_isolation.e2e.test.js`

| Test ID | Suite | End-to-End Scenario & Verification Gates |
|---|---|---|
| `E2E-01` | `01_nonposting_service_lifecycle.e2e.test.js` | **Full Nonposting Service Lifecycle**: Initializes `runner.js` in a hermetic workspace with `fake_telegram_server`, `fake_docker_vpn` (5 healthy slots), `fake_direct_x_bridge` (nonposting loopback bridge), 3 active accounts + 2 pending queue items (`1` pre-dispatch `processing/claimed` and `1` `processing/dispatch_started` seeded to test startup recovery). Verifies: (1) Startup `recoverProcessing()` converts `claimed -> pending` and `dispatch_started -> ambiguous` (0 quota); (2) Authorized owner `/start` renders dashboard panel to both configured chats; (3) Clicking `🟢 تشغيل` runs `readiness`, starts cycle, rotates across accounts, executes `onDispatch` -> `dispatch_ack` -> simulated publish, increments Riyadh daily quota by `1` per published post; (4) Natural cycle finish enqueues and delivers terminal CSV (`sendDocument`) to both chats with verified `message_id` receipts; (5) Duplicate stop cycle sends `0` duplicate CSVs; (6) Graceful `stop()` releases `SingleInstanceLock` and closes `SqliteStore` cleanly. |
| `E2E-02` | `02_adversarial_crash_and_isolation.e2e.test.js` | **Adversarial CAS Conflict, Crash Recovery & CAPTCHA E2E Gate**: (1) Simulates competing SQLite revision mutation during `onDispatch` (`PERSIST-OBS-04`), proving `dispatch_ack` is aborted and item is not double-posted across simulated restart; (2) Simulates bridge returning X code `326` (CAPTCHA) on Account 1 -> Account 1 is immediately disabled with `needsOwnerCaptcha: true`, dual-chat isolation alert is delivered (with partial Chat 2 failure + automatic Chat 2 retry), concurrent `acctoggle` callback attempting to re-enable Account 1 is blocked inside transaction (`TR-06`), owner `accmanage:verify_captcha` clears flag while keeping `enabled: false`, and only a subsequent explicit owner enable re-activates Account 1; (3) Simulates 3 consecutive ambiguous turns on Account 2 -> isolates on strike 3 with 1 Arabic alert and halts cycle cleanly when no eligible accounts remain; (4) Post-test cryptographic check confirms `/root/Projects/YJAutoPostOnX/Bot/data/state.sqlite` and `session_leases.sqlite` are 100% untouched. |

---

## 5. Complete Traceability Matrix: Audit Findings -> Fresh Test IDs

| Finding ID | Summary of Defect / Risk | Fresh Test ID(s) |
|---|---|---|
| `FINDING-001` / `PY-RAW-02` | Non-idempotent `POST` fallback on unstructured `"before send"` text | `P-04` |
| `FINDING-002` / `XT-01` | `verify_timeline` accepts pre-existing same-author tweet posted up to 30m *before* dispatch | `P-05` |
| `FINDING-003` / `FINDING-009` / `FINDING-024` / `PERSIST-OBS-04` / `RUN-02` | `SqliteStore.update` retry retains stale `dispatchReady=true` / `claimed=true` closure flag after conflicting revision | `S-02`, `E2E-02` |
| `FINDING-004` / `FINDING-005` / `RUN-01` / `ENTRY-RAW-01` | Dual `SingleInstanceLock` implementations & concurrent stale lock recovery | `F-07`, `E2E-01` |
| `FINDING-006` / `FINDING-023` / `FINDING-025` | Single-row SQLite WAL concurrency, `BEGIN DEFERRED` reads, `TRANSACTION_ASYNC_YIELD` | `S-01`, `S-02` |
| `FINDING-007` / `PY-RAW-01` / `PY-RAW-03` | Cached identity fast-path bypasses `user_state`/`settings`; fallback swallows `account_failure` | `P-03` |
| `FINDING-008` / `PY-RAW-05` | Twikit `KeyError: 'urls'` normalization & `User.__init__` patch scope | `L-04`, `P-02` |
| `FINDING-010` | Loose substring ban classification fallback in `direct_x_compat.py:472-480` | `P-01` |
| `FINDING-011` / `FINDING-026` / `PY-RAW-04` / `XT-05` | Post-dispatch rate-limit/error ambiguity fencing & queue traversal | `L-03`, `F-01`, `P-06` |
| `FINDING-012` | `curl_cffi==0.17.0` pin & venv interpreter verification | `P-02`, `run_all.js` |
| `FINDING-014` / `ACC-RAW-02` / `ACC-RAW-03` | Cookie `0o600` `O_NOFOLLOW` storage & Node (`10 MiB`) vs Python (`1 MiB`) size mismatch | `L-06`, `U-05`, `P-06` |
| `FINDING-015` / `FINDING-031` | `dockerVpn.js` server IP leak gate, no `--noproxy "*"`, image tag `6.0.2` pinning | `V-05` |
| `FINDING-016` | Strict production/daemon environment validation without credential literals in tests | `L-07` |
| `FINDING-017` / `ACC-RAW-01` / `ACC-RAW-04` | Empty CSV rejection & `replaceFromCsv` preserving `needsOwnerCaptcha` / `banned` restrictions | `L-06`, `C-04` |
| `FINDING-018` / `ENTRY-RAW-02` | `telegramApi.js` dynamic `getUpdates` timeout adaptation & bounded JSON response stream | `U-05` |
| `FINDING-019` / `TR-03` | Incident-scoped dual-chat isolation alerts requiring integer `message_id` receipts & partial retry | `C-05`, `E2E-02` |
| `FINDING-020` / `FINDING-021` / `PY-RAW-06` | `1 MiB` IPC framing bound & Linux parent-death signal (`PR_SET_PDEATHSIG`) handling | `P-06` |
| `FINDING-022` / `TR-02` | Scheduler timer error boundary & `uiScheduleDay` commit ordering after `startScheduled()` | `L-02`, `U-02` |
| `FINDING-027` / `UTIL-RAW-02` | Table formatting (`tableUtils.js` / `accountTable.js`) & HTML escaping | `L-09` |
| `FINDING-028` / `UTIL-RAW-01` / `PY-RAW-07` | Top-level & nested secret redaction in `structuredLogger.js` and IPC error sanitization | `L-08`, `P-06` |
| `FINDING-029` | `Asia/Riyadh` midnight rollover & fail-closed invalid Date handling in `quota.js` | `L-01` |
| `FINDING-030` / `PERSIST-OBS-01` / `PERSIST-OBS-03` | `ForensicLogger.reconcile()` fail-closed on read error, atomic temp+fsync, outbox drain | `S-04` |
| `PERSIST-OBS-02` / `XT-04` | `Queue.requeue()` forbidding transition of `ambiguous` items to `pending` | `S-05` |
| `PERSIST-OBS-05` | Worktree-aware production DB & forensic mutation guard (`PROD_DB_MUTATION_FORBIDDEN_IN_TEST`) | `S-03` |
| `XT-02` | `DirectXAdapter.publish()` preserving `accountFailure` on `recoveredFromTimeline` result | `F-03` |
| `XT-03` | `recordAccountCheck` preserving critical security restriction signals (`captcha`/`banned`) | `F-04` |
| `TR-01` | `/account_toggle` text command overwritten by `ui.actions()` callback spread in `runner.js` | `U-01` |
| `TR-04` / `TR-06` | Concurrent `accountToggle` / `accountManage` / `telegramFlows` enable race against CAPTCHA/5-active cap | `C-03`, `E2E-02` |
| `TR-05` / `VPN-RAW-02` | `telegramUi.js` clearing `s.vpnSlots` before `vpnSlots.release()` & avoiding `docker rm -f` on persistent slots | `V-04` |
| `TR-07` / `RUN-06` | `runner.js` shutdown `try/finally` guaranteeing `store.close()` and `lock.release()` if `ui.destroy()` rejects | `F-07` |
| `VPN-RAW-01` | Enforcing 7-container host NordVPN cap & existing fingerprint volume check before `docker run` | `V-03` |
| `VPN-RAW-03` | Preserving NordVPN CLI stderr in `dockerVpn.js` to halt rotation on `Too many connection attempts` | `V-05` |
| `SESSION-RAW-01` / `SESSION-RAW-02` / `SESSION-RAW-03` | 5-session host-wide guard, `/proc` scan & `bindChildPid` error surfacing, PID reuse resistance | `V-01`, `V-02` |
| `UTIL-RAW-03` | Deduplicating suppressed terminal events in `linkExports.js` without unbounded state growth | `U-03` |
| `UTIL-RAW-04` | Surfacing `store.update` failures during `accountRefresh.js` | `U-04` |
| `RUN-03` | `isolatedVerifier.verify` not disabling healthy accounts as `unverified` on transient network/VPN errors | `F-05` |
| `RUN-04` | Explicit `payload.account` pin handling on pre-dispatch failure | `F-06` |


---

## 7.2 CI, Electron/Xvfb Windowed Boot & Build/Deploy Repair Specification (`CI-01`–`CI-08` & PR #29 Fix)

# Phase 2 Specification: CI, Electron/Xvfb Windowed Boot & Build/Deploy Hardening

- **Date**: 2026-11-04
- **Delegate**: D3 (CI, Electron/Xvfb, and Build/Deploy Specification)
- **Inspected Repository Worktree (Read-Only)**: `/root/Projects/YJAutoPostOnX-surgical-audit`
- **Inspected Files**:
  - `.github/workflows/verify-xposter.yml` (lines 1–65)
  - `.github/workflows/apply-remaining-repair.yml` (lines 1–187)
  - `Appimage/scripts/verify-release.sh` (lines 1–122)
  - `Appimage/dev/main.js` (lines 1–2326)
  - `Appimage/package.json` (lines 1–71)
  - `Bot/package.json` (lines 1–13)
  - `Bot/scripts/run_all_automated_tests.sh` (lines 1–189)
  - `Bot/test/live_vps_m4_operational.test.js` (lines 1–575)
  - `Bot/test/docker_vpn_live_slots.test.js` (lines 1–188)

---

## 1. Forensic Root-Cause Diagnosis: PR #29 Release Workflow Failure (`job/126416216292`)

### 1.1 Observed Failure Evidence (GitHub Actions Run `41782092988`, Job `126416216292`, Head `c23a75062699c070b85d63f75fc3cc50f3702656`)

In `.github/workflows/verify-xposter.yml`, the job `verify` (`ubuntu-24.04`) executed `bash scripts/verify-release.sh`:
1. `git diff --check`, `npm ci`, Electron ABI checks, `npm test` (80/80 files), `npm run test:electron` (4/4 Xvfb suites), `npm run audit`, `npm audit --omit=dev --audit-level=high`, `npm run build:linux`, `extract AppImage`, `unpack asar`, and `package smoke` (31/31 checks) **all passed** (`05:56:08Z` – `06:00:50.750Z`).
2. At `06:00:50.7601551Z`, `verify-release.sh:101` launched the extracted AppImage windowed boot step:
   ```bash
   APPDIR='$EXTRACT_DIR/squashfs-root' xvfb-run -a timeout 45 '$EXTRACT_DIR/squashfs-root/AppRun' --no-sandbox > '$ISOLATED_HOME/boot.log' 2>&1
   ```
3. Inside `boot.log`, the Electron main process (`PID 4186`) booted at `06:00:51.176Z`, initialized the durable SQLite store (`Durable store warnings: no_backup_yet` at `06:00:51.245Z`), and **remained alive without crashing for the entire 45-second timeout window** until `06:01:35.794Z`:
   ```text
   2026-11-04T06:00:50.7601551Z ── windowed boot (45s, isolated HOME, must not crash before the timeout) ──
   2026-11-04T06:02:59.3604008Z boot exit code: 5 (124/137 = ran the full 45s without crashing, which is success here)
   [4186:1104/060051.176969:ERROR:dbus/bus.cc:405] Failed to connect to the bus: ...
   Durable store warnings: no_backup_yet
   [4186:1104/060135.794334:ERROR:content/common/zygote/zygote_communication_linux.cc:291] Failed to send GetTerminationStatus message to zygote
   [4186:1104/060135.796952:ERROR:content/common/zygote/zygote_communication_linux.cc:291] Failed to send GetTerminationStatus message to zygote
   [4186:1104/060135.798678:ERROR:content/browser/gpu/gpu_process_host.cc:992] GPU process launch failed: error_code=1002
   [4186:1104/060135.800447:ERROR:content/browser/gpu/gpu_process_host.cc:992] GPU process launch failed: error_code=1002
   [4186:1104/060135.801426:ERROR:content/browser/network_service_instance_impl.cc:703] Network service crashed or was terminated, restarting service.
   [4186:1104/060135.807304:ERROR:content/browser/gpu/gpu_process_host.cc:992] GPU process launch failed: error_code=1002
   [4186:1104/060135.807323:FATAL:content/browser/gpu/gpu_data_manager_impl_private.cc:418] GPU process isn't usable. Goodbye.
   timeout: the monitored command dumped core
   xvfb-run: error: problem while cleaning up temporary directory
   ```
4. At job teardown (`06:03:15.872Z`), the GitHub Actions runner reported:
   `Terminate orphan process: pid (4182) (Xvfb)`

### 1.2 Exact Causal Chain (3-Part Compound Root Cause)

1. **Part A — Process-Group `SIGTERM` Race Between Electron Main Process and Chromium Child `gpu-process` / `zygote` (`Appimage/dev/main.js:2, 116–133`)**:
   - `Appimage/dev/main.js:2` calls `app.disableHardwareAcceleration()`, which configures Chromium to run in software GPU mode (`SwiftShader` / software compositor) inside an out-of-process `--type=gpu-process` spawned via `--type=zygote`. Because hardware acceleration is already disabled, software mode sits at the very bottom of Chromium's `GpuMode` fallback list in `GpuDataManagerImplPrivate::FallBackToNextGpuMode()`.
   - At `t = 45.034s` (`06:00:50.760Z` → `06:01:35.794Z`), GNU `timeout 45` expired and sent `SIGTERM` to its **entire child process group** (`kill(-pgid, SIGTERM)`), hitting the Electron browser process (`PID 4186`), the `zygote` process, the `gpu-process`, and the `network_service` utility process simultaneously.
   - The `zygote`, `gpu-process`, and `network_service` child processes died immediately on `SIGTERM`.
   - Meanwhile, the Electron browser process (`PID 4186`) caught `SIGTERM` and remained alive in its event loop while running its asynchronous `before-quit` handler (`Appimage/dev/main.js:116–133`, `await durableQueue.closeStore()`).
   - During that 13ms teardown window (`06:01:35.794334` → `06:01:35.807323`), Chromium's `GpuProcessHost` detected the dead `gpu-process` socket on the C++ IO/UI thread and attempted 3 times to query termination status from and respawn the GPU process via the already-terminated `zygote` (`Failed to send GetTerminationStatus message to zygote`, `GPU process launch failed: error_code=1002` × 3).
   - After 3 failed GPU process launch attempts in software mode, `GpuDataManagerImplPrivate::FallBackToNextGpuMode()` (`content/browser/gpu/gpu_data_manager_impl_private.cc:418`) had no remaining fallback mode and called `LOG(FATAL) << "GPU process isn't usable. Goodbye."`.

2. **Part B — Chromium `LOG(FATAL)` `SIGTRAP` Core Dump Stall (`06:01:35.807Z` → `06:02:59.360Z`)**:
   - In Chromium, `LOG(FATAL)` executes `ImmediateCrash()` (`__builtin_trap()`), raising `SIGTRAP` (signal 5) and dumping core (`timeout: the monitored command dumped core`).
   - Because `verify-release.sh` did not set `ulimit -c 0`, the 218 MB Electron binary core dump was piped through Ubuntu 24.04's `apport` crash handler for **83.5 seconds** (`06:01:35.807Z` → `06:02:59.360Z`).

3. **Part C — `/usr/bin/xvfb-run` `clean_up()` Race Returning Exit Code `5` and Orphaning `Xvfb` (`verify-release.sh:33, 101`)**:
   - Even when a timed-out command dumps core on `SIGTRAP` during `SIGTERM` handling, GNU `timeout` itself still exits with `124`.
   - However, `verify-release.sh:101` placed `xvfb-run -a` **outside** `timeout 45` without `-f <authfile>`, while `verify-release.sh:33` exported `TMPDIR="$HOME/tmp"`.
   - When `xvfb-run` is invoked without `-f`, `/usr/bin/xvfb-run:148` creates `XVFB_RUN_TMPDIR="$(mktemp -d -t xvfb-run.XXXXXX)"` under `$TMPDIR`.
   - In `/usr/bin/xvfb-run:80–93`, the `EXIT` trap `clean_up()` executes `rm -r "$XVFB_RUN_TMPDIR"` (line 85, without `-f`) **before** `kill "$XVFBPID"` (line 91):
     ```sh
     if [ -n "$XVFB_RUN_TMPDIR" ]; then
         if ! rm -r "$XVFB_RUN_TMPDIR"; then
             error "problem while cleaning up temporary directory"
             exit 5
         fi
     fi
     if [ -n "$XVFBPID" ]; then
         kill "$XVFBPID" >>"$ERRORFILE" 2>&1
     fi
     ```
   - When `rm -r "$XVFB_RUN_TMPDIR"` failed (`xvfb-run: error: problem while cleaning up temporary directory`), `/usr/bin/xvfb-run` exited with **`5`** (overriding `timeout`'s exit code `124`) and aborted `clean_up()` before line 91 (`kill "$XVFBPID"`), leaving `Xvfb` (`PID 4182`) running as an orphan process.

### 1.3 Empirical Reproduction & Fix Verification

Tested in isolated `/root/.hermes/cache/scratch` against the built `YJAutoPostOnX-5.21.0.AppImage` and `Appimage/dev/main.js`:
- Running `xvfb-run -a timeout 6s AppRun --no-sandbox` reproduced the exact `Failed to send GetTerminationStatus message to zygote`, `GPU process launch failed: error_code=1002`, and `FATAL:content/browser/gpu/gpu_data_manager_impl_private.cc:418] GPU process isn't usable. Goodbye.` (`SIGTRAP`) at the 6-second `SIGTERM` boundary.
- Adding `app.commandLine.appendSwitch('in-process-gpu');` and `app.commandLine.appendSwitch('disable-gpu');` alongside `app.disableHardwareAcceleration();` in `Appimage/dev/main.js` keeps software GPU compositing inside the main browser process so there is **no external `gpu-process` child to crash or respawn via `zygote` on process-group `SIGTERM`**.
- Adding `process.once('SIGTERM', shutdownOnSignal)` / `process.once('SIGINT', shutdownOnSignal)` inside `app.whenReady()` in `Appimage/dev/main.js` folds the SQLite WAL cleanly (`durableQueue.closeStore()`) on `SIGTERM`.
- Passing `-f "$ISOLATED_HOME/.Xauthority"` to `xvfb-run` and setting `ulimit -c 0` in `verify-release.sh` bypasses `XVFB_RUN_TMPDIR` in `/usr/bin/xvfb-run` (eliminating `exit 5` and orphaned `Xvfb`) and prevents core-dump stalls.

---

## 2. Root-Cause Diagnosis of All 8 CI & Packaging Defects (`CI-01` – `CI-08`)

| ID | File(s) & Lines | Exact Root Cause | Impact |
|---|---|---|---|
| **CI-01** | `Bot/package.json:8`<br>`Bot/scripts/run_all_automated_tests.sh:82`<br>`Bot/test/live_vps_m4_operational.test.js:79–81,121–154,315–340,380–416` | `Bot/package.json` defines `"test": "node --test test/*.test.js"`. The wildcard includes `Bot/test/live_vps_m4_operational.test.js` (which copies production `Bot/data/state.sqlite` without WAL safety, calls `runtime.rotateContainerIp(0, ...)` on live production NordVPN container `yj_autopost_vpn_1`, probes live X URLs over SOCKS5, and initializes a live Telegram API client) as well as 7 other files/sub-suites that probe live Docker VPN slots (`18801–18805`) or production locks/files (`docker_vpn_live_slots.test.js`, `m2_concurrency_challenge.test.js`, `challenger_m3_adversarial.test.js`, `challenger_m4_m5_adversarial.test.js`, `m4_lifecycle_and_recovery.test.js`, `m3_quota_and_fencing_challenge.test.js`, `m11_round10_forensic_integrity.test.js`). | Running `npm test` in `Bot/` mutates active production VPN routing on the VPS and fails on clean CI runners lacking live Docker VPN containers and production `state.sqlite`. |
| **CI-02** | `.github/workflows/verify-xposter.yml:24–26`<br>`.github/workflows/apply-remaining-repair.yml:20–22,48–50,76–78,105–107` | Every job in both GitHub Actions workflows sets `defaults.run.working-directory: Appimage`. Neither workflow sets up Python or executes any `Bot/` Node.js (`Bot/test/*.test.js`) or Python (`Bot/python/test_*.py`, `Bot/test/p2_reproducer_test.py`) test suites. | PRs modifying `Bot/` (including PR #28 and PR #29) receive green CI checks without executing a single `Bot` test. |
| **CI-03** | `Appimage/scripts/verify-release.sh:28,37–41,101`<br>`.github/workflows/verify-xposter.yml:55–65` | `verify-release.sh` writes `boot.log` to `$ISOLATED_HOME/boot.log` (`/tmp/xposter-verify-home-XXXXXX/boot.log`) and registers `trap 'cleanup; fail' ERR` and `trap cleanup EXIT`, where `cleanup()` executes `rm -rf "$ISOLATED_HOME"`. When `verify-release.sh` fails, `cleanup()` deletes `/tmp/xposter-verify-home-*/boot.log` before the script exits, so the subsequent `Upload failure logs` step in `verify-xposter.yml:63` never finds `boot.log` (verified in `job/126416216292`: only the 705-byte `builder-debug.yml` was uploaded). | Full `boot.log` failure artifact is deleted before GitHub Actions can upload it. |
| **CI-04** | `Appimage/scripts/verify-release.sh:28–29,111–117` | `verify-release.sh:111–117` hardcodes `/root/.config/x-poster-*` instead of capturing the caller's pre-isolation `$HOME`, and inside the loop only executes `echo "checking $d for anything newer than this run..."` without any `find -newer`, hash/mtime snapshot comparison, or `exit 1`. | The step is a no-op `echo` that exits `0` even if real user data under `~/.config/x-poster-*` was created or modified during the verification run. |
| **CI-05** | `.github/workflows/apply-remaining-repair.yml:162,173–181` | Line 162 runs `npm audit --omit=dev --json > audit-prod.json || true`. Lines 175–180 parse `audit-prod.json` and evaluate `const counts = audit.metadata?.vulnerabilities || {}; const high = Number(counts.high || 0); const critical = Number(counts.critical || 0);`. If `npm audit` returns an error JSON payload (e.g. registry outage, HTTP 5xx, lockfile error) lacking `metadata.vulnerabilities`, `high` and `critical` silently default to `0` and the gate exits `0`. | Registry/audit errors silently pass the production dependency vulnerability gate as `high=0, critical=0`. |
| **CI-06** | `Bot/scripts/run_all_automated_tests.sh:35–43,55–56,66–67,83–84,96–108,184` | Lines 56, 67, 84, and 100 pass `${PY_COUNT1:-126}`, `${PY_COUNT2:-7}`, `${PASSED_COUNT:-181}`, and `${NETNS_COUNT:-42}` to `pass_check`. Under `set -euo pipefail`, if `grep` fails to match, the command substitution aborts abnormally; if `grep` is bypassed or yields empty, the script fabricates hardcoded pass counts (`126`, `7`, `181`, `42`). Lines 96–108 silently skip Tier 3 (`TEST_RUNNER/run_suite.py`) without failing when `unshare` or `TEST_RUNNER` is missing, then line 184 claims `100% Reliability`. | Fabricates test counts when output parsing fails and overstates coverage/reliability when suites are skipped. |
| **CI-07** | `Appimage/scripts/verify-release.sh:94–109`<br>`.github/workflows/apply-remaining-repair.yml:145–151` | `verify-release.sh:105` checks `if [ "$code" -ne 124 ] && [ "$code" -ne 137 ] && [ "$code" -ne 0 ]; then` (and `apply-remaining-repair.yml:148` checks `if [ "$CODE" -ne 0 ] && [ "$CODE" -ne 124 ]; then`). Accepting exit code `0` means if the AppImage exits `0` immediately on launch (e.g. single-instance lock quit at `main.js:44`, or `AppRun` exiting `0` on missing dependency), the gate passes without staying alive for the required 45s/30s window. Additionally, `verify-release.sh` never asserts that `$ISOLATED_HOME/.config/x-poster-shared/workflow.sqlite` was created or that `boot.log` contains no fatal/uncaught errors. | Premature clean exit (`0`) or main-process load exception that stays idle until `SIGTERM` can falsely pass the windowed boot gate. |
| **CI-08** | `.github/workflows/apply-remaining-repair.yml:182–187`<br>`Appimage/package.json:3` | `apply-remaining-repair.yml:185` hardcodes `name: YJAutoPostOnX-5.20.0-AppImage` while `Appimage/package.json:3` is `"version": "5.21.0"`. | Uploaded CI artifact is mislabeled `5.20.0` despite packaging version `5.21.0`. |

---

## 3. Exact Before/After Code Diffs to Apply in Phase 5

### 3.1 `Appimage/dev/main.js` (Fix PR #29 Headless Xvfb GPU/Zygote Crash & `SIGTERM` WAL Shutdown)

```diff
--- a/Appimage/dev/main.js
+++ b/Appimage/dev/main.js
@@ -1,5 +1,7 @@
 const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require('electron');
 app.disableHardwareAcceleration();
+app.commandLine.appendSwitch('in-process-gpu');
+app.commandLine.appendSwitch('disable-gpu');
 const path = require('path');
 const fs = require('fs').promises;
 const os = require('os');
@@ -107,6 +109,15 @@ app.whenReady().then(async () => {
   // Durable-store housekeeping. Started after the window so it never delays the
   // first paint; the first sweep is a further minute out.
   scheduleMaintenance();
+
+  const shutdownOnSignal = () => {
+    if (maintenanceTimer) { clearInterval(maintenanceTimer); maintenanceTimer = null; }
+    try { void durableQueue.closeStore(); } catch { /* best-effort */ }
+    app.quit();
+  };
+  process.once('SIGTERM', shutdownOnSignal);
+  process.once('SIGINT', shutdownOnSignal);
 });
 
 app.on('window-all-closed', () => {
```

---

### 3.2 `Appimage/scripts/verify-release.sh` (Fix PR #29 Xvfb/Timeout Handling, CI-03, CI-04, CI-07)

```diff
--- a/Appimage/scripts/verify-release.sh
+++ b/Appimage/scripts/verify-release.sh
@@ -25,6 +25,29 @@ run_step() {
 }
 
 # ── Isolation (brief §4): every test/probe/smoke/boot uses its own HOME. ──
+REAL_HOME="${HOME:-/root}"
+REAL_USER_DIRS=(
+  "$REAL_HOME/.config/x-poster-bot-profile"
+  "$REAL_HOME/.config/x-poster-profiles"
+  "$REAL_HOME/.config/x-poster-shared"
+)
+snapshot_real_user_dirs() {
+  for d in "${REAL_USER_DIRS[@]}"; do
+    if [ -e "$d" ]; then
+      echo "EXISTS:$d"
+      find "$d" -printf '%P\t%s\t%T@\n' 2>/dev/null | sort
+    else
+      echo "ABSENT:$d"
+    fi
+  done
+}
+
 ISOLATED_HOME="$(mktemp -d -t xposter-verify-home-XXXXXX)"
+RUN_START_MARKER="$ISOLATED_HOME/.run-start"
+touch "$RUN_START_MARKER"
+PRE_RUN_SNAPSHOT="$ISOLATED_HOME/.real-user-dirs.before"
+snapshot_real_user_dirs > "$PRE_RUN_SNAPSHOT"
+
 export HOME="$ISOLATED_HOME"
 export XDG_CONFIG_HOME="$HOME/.config"
 export XDG_CACHE_HOME="$HOME/.cache"
@@ -35,6 +58,10 @@ mkdir -p "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$TMPDIR"
 echo "Isolated HOME for this verification run: $HOME"
 
 cleanup() {
+  if [ -f "$ISOLATED_HOME/boot.log" ]; then
+    mkdir -p "$REPO_ROOT/dist"
+    cp -f "$ISOLATED_HOME/boot.log" "$REPO_ROOT/dist/boot.log" 2>/dev/null || true
+  fi
   rm -rf "$ISOLATED_HOME" "${EXTRACT_DIR:-}" 2>/dev/null || true
 }
 trap 'cleanup; fail' ERR
@@ -93,28 +120,56 @@ run_step "package smoke (inside the built AppImage)" \
 
 run_step "windowed boot (45s, isolated HOME, must not crash before the timeout)" bash -c "
   set +e
+  ulimit -c 0
   # AppRun's own \\\$APPDIR auto-detection walks up looking for a path
   # component matching \\\$1 (here --no-sandbox), which never exists, so it
   # unwinds to an empty string and then tries to exec /yjautopostonx. Setting
   # APPDIR explicitly (exactly what the real AppImage type-2 runtime does
   # before invoking AppRun) is what makes this a faithful boot test.
-  APPDIR='$EXTRACT_DIR/squashfs-root' xvfb-run -a timeout 45 '$EXTRACT_DIR/squashfs-root/AppRun' --no-sandbox > '$ISOLATED_HOME/boot.log' 2>&1
+  APPDIR='$EXTRACT_DIR/squashfs-root' xvfb-run -a -f '$ISOLATED_HOME/.Xauthority' \
+    timeout --signal=TERM --kill-after=10s 45s \
+    '$EXTRACT_DIR/squashfs-root/AppRun' --no-sandbox --disable-gpu > '$ISOLATED_HOME/boot.log' 2>&1
   code=\$?
-  echo \"boot exit code: \$code (124/137 = ran the full 45s without crashing, which is success here)\"
+  cp -f '$ISOLATED_HOME/boot.log' '$REPO_ROOT/dist/boot.log' 2>/dev/null || true
+  echo \"boot exit code: \$code (124/137 = ran the full 45s without crashing; 0 = premature exit, rejected)\"
   tail -40 \"$ISOLATED_HOME/boot.log\" || true
-  if [ \"\$code\" -ne 124 ] && [ \"\$code\" -ne 137 ] && [ \"\$code\" -ne 0 ]; then
-    echo 'boot exited early with an unexpected code' >&2
+  if [ \"\$code\" -ne 124 ] && [ \"\$code\" -ne 137 ]; then
+    echo \"boot exited early or unexpectedly with code \$code (expected 124 or 137 after full 45s soak)\" >&2
+    exit 1
+  fi
+  if [ ! -s '$ISOLATED_HOME/.config/x-poster-shared/workflow.sqlite' ]; then
+    echo 'boot did not initialize isolated workflow.sqlite' >&2
+    exit 1
+  fi
+  if [ ! -d '$ISOLATED_HOME/.config/x-poster-bot-profile/reports' ]; then
+    echo 'boot did not reach app.whenReady() report directory initialization' >&2
+    exit 1
+  fi
+  if [ -e '$ISOLATED_HOME/.config/YJAutoPostOnX/logs/fatal.log' ]; then
+    echo 'fatal.log was written during windowed boot' >&2
+    cat '$ISOLATED_HOME/.config/YJAutoPostOnX/logs/fatal.log' >&2 || true
+    exit 1
+  fi
+  if grep -E 'App threw an error during load|Uncaught Exception:|FATAL:' '$ISOLATED_HOME/boot.log' >/dev/null 2>&1; then
+    echo 'boot.log contains fatal/uncaught error output' >&2
     exit 1
   fi
 "
 
-run_step "real user data untouched (~/.config/x-poster-*)" bash -c '
-  for d in "/root/.config/x-poster-bot-profile" "/root/.config/x-poster-profiles" "/root/.config/x-poster-shared"; do
+run_step "real user data untouched (~/.config/x-poster-*)" bash -c "
+  POST_RUN_SNAPSHOT='$ISOLATED_HOME/.real-user-dirs.after'
+  $(declare -f snapshot_real_user_dirs)
+  REAL_USER_DIRS=('${REAL_USER_DIRS[0]}' '${REAL_USER_DIRS[1]}' '${REAL_USER_DIRS[2]}')
+  snapshot_real_user_dirs > \"\$POST_RUN_SNAPSHOT\"
+  for d in \"\${REAL_USER_DIRS[@]}\"; do
     if [ -e \"\$d\" ]; then
-      echo \"checking \$d for anything newer than this run...\"
+      newer=\"\$(find \"\$d\" -newer '$RUN_START_MARKER' -print -quit 2>/dev/null || true)\"
+      if [ -n \"\$newer\" ]; then
+        echo \"real user data modified under \$d: \$newer\" >&2
+        exit 1
+      fi
     fi
   done
-'
+  if ! diff -u '$PRE_RUN_SNAPSHOT' \"\$POST_RUN_SNAPSHOT\"; then
+    echo 'real user data snapshot changed during verification run' >&2
+    exit 1
+  fi
+"
```

---

### 3.3 `.github/workflows/verify-xposter.yml` (Fix CI-02 & CI-03)

```diff
--- a/.github/workflows/verify-xposter.yml
+++ b/.github/workflows/verify-xposter.yml
@@ -17,6 +17,37 @@ env:
   IYH_KEY: ""
 
 jobs:
+  bot-tests:
+    name: Bot unit & integration tests (Node + Python)
+    runs-on: ubuntu-24.04
+    timeout-minutes: 20
+    defaults:
+      run:
+        working-directory: Bot
+    steps:
+      - name: Check out
+        uses: actions/checkout@v4
+
+      - name: Set up Node (matches Bot/package.json engines)
+        uses: actions/setup-node@v4
+        with:
+          node-version: "22"
+
+      - name: Set up Python
+        uses: actions/setup-python@v5
+        with:
+          python-version: "3.12"
+
+      - name: Install Bot Python dependencies
+        run: |
+          python -m pip install --upgrade pip
+          python -m pip install -r requirements-direct-x.txt
+
+      - name: Run Bot Python unit & reproducer suites
+        run: npm run test:python
+
+      - name: Run Bot offline Node test suites
+        run: npm run test:node
+
   verify:
     name: npm ci / test / test:electron / audit / build / package smoke
     runs-on: ubuntu-24.04
@@ -60,6 +91,6 @@ jobs:
           path: |
             Appimage/dist/builder-*.yml
             Appimage/dist/builder-effective-config.yaml
-            /tmp/xposter-verify-home-*/boot.log
-          if-no-files-found: ignore
+            Appimage/dist/boot.log
+          if-no-files-found: warn
           retention-days: 14
```

---

### 3.4 `.github/workflows/apply-remaining-repair.yml` (Fix CI-02, CI-05, CI-07, CI-08)

```diff
--- a/.github/workflows/apply-remaining-repair.yml
+++ b/.github/workflows/apply-remaining-repair.yml
@@ -14,6 +14,35 @@ concurrency:
   cancel-in-progress: true
 
 jobs:
+  bot-tests:
+    runs-on: ubuntu-latest
+    timeout-minutes: 20
+    defaults:
+      run:
+        working-directory: Bot
+    steps:
+      - uses: actions/checkout@v4
+      - uses: actions/setup-node@v4
+        with:
+          node-version: 22
+      - uses: actions/setup-python@v5
+        with:
+          python-version: "3.12"
+      - name: Install Bot Python dependencies
+        run: |
+          python -m pip install --upgrade pip
+          python -m pip install -r requirements-direct-x.txt
+      - name: Run Bot Python tests
+        run: npm run test:python
+      - name: Run Bot offline Node tests
+        run: npm run test:node
+
   baseline-tests:
     runs-on: ubuntu-latest
     timeout-minutes: 25
@@ -99,7 +128,7 @@ jobs:
           if-no-files-found: error
 
   package-appimage:
-    needs: [baseline-tests, workflow-tests, electron-tests]
+    needs: [bot-tests, baseline-tests, workflow-tests, electron-tests]
     runs-on: ubuntu-latest
     timeout-minutes: 25
     defaults:
@@ -135,6 +164,7 @@ jobs:
         shell: bash
         run: |
           set -euo pipefail
+          ulimit -c 0
           APPIMAGE="$(find dist -maxdepth 1 -type f -name '*.AppImage' -print -quit)"
           test -n "$APPIMAGE"
           chmod +x "$APPIMAGE"
           ISO_HOME="$(mktemp -d)"
@@ -142,13 +172,15 @@ jobs:
           export XDG_CONFIG_HOME="$HOME/.config"
           export XDG_CACHE_HOME="$HOME/.cache"
           export XDG_DATA_HOME="$HOME/.local/share"
+          export TMPDIR="$HOME/tmp"
           export APPIMAGE_EXTRACT_AND_RUN=1
-          mkdir -p "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME"
+          mkdir -p "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$TMPDIR"
           set +e
-          timeout --signal=TERM --kill-after=10s 30s xvfb-run -a "$APPIMAGE" --no-sandbox 2>&1 | tee appimage-boot.log
+          xvfb-run -a -f "$HOME/.Xauthority" timeout --signal=TERM --kill-after=10s 30s "$APPIMAGE" --no-sandbox --disable-gpu 2>&1 | tee appimage-boot.log
           CODE=${PIPESTATUS[0]}
           set -e
-          if [ "$CODE" -ne 0 ] && [ "$CODE" -ne 124 ]; then
+          if [ "$CODE" -ne 124 ] && [ "$CODE" -ne 137 ]; then
+            echo "Unexpected AppImage boot exit code: $CODE (expected 124 or 137 after 30s soak)" >&2
             exit "$CODE"
           fi
-          test -f "$HOME/.config/x-poster-shared/workflow.sqlite"
+          test -s "$HOME/.config/x-poster-shared/workflow.sqlite"
       - name: Upload AppImage boot failure log
@@ -173,15 +205,27 @@ jobs:
           node <<'NODE'
           const fs = require('fs');
           const audit = JSON.parse(fs.readFileSync('audit-prod.json', 'utf8'));
-          const counts = audit.metadata?.vulnerabilities || {};
-          const high = Number(counts.high || 0);
-          const critical = Number(counts.critical || 0);
+          if (audit.error) {
+            console.error('npm audit returned an error payload:', JSON.stringify(audit.error));
+            process.exit(1);
+          }
+          const counts = audit.metadata && audit.metadata.vulnerabilities;
+          if (!counts || typeof counts !== 'object' || !Number.isInteger(counts.high) || !Number.isInteger(counts.critical)) {
+            console.error('npm audit output is missing valid metadata.vulnerabilities counts:', JSON.stringify(audit.metadata || null));
+            process.exit(1);
+          }
+          const { high, critical } = counts;
           console.log(`production audit: high=${high}, critical=${critical}`);
           if (high > 0 || critical > 0) process.exit(1);
           NODE
+      - name: Read package version
+        id: pkg_meta
+        shell: bash
+        run: |
+          echo "version=$(node -p "require('./package.json').version")" >> "$GITHUB_OUTPUT"
       - name: Upload verified AppImage
         uses: actions/upload-artifact@v4
         with:
-          name: YJAutoPostOnX-5.20.0-AppImage
+          name: YJAutoPostOnX-${{ steps.pkg_meta.outputs.version }}-AppImage
           path: Appimage/dist/*.AppImage
           if-no-files-found: error
```

---

### 3.5 `Bot/package.json` & Live VPS Test Guards (Fix CI-01 & CI-02)

#### 3.5.1 `Bot/package.json`

```diff
--- a/Bot/package.json
+++ b/Bot/package.json
@@ -5,7 +5,10 @@
   "description": "Isolated offline foundation for the YJ Auto Post X Telegram bot",
   "type": "commonjs",
   "scripts": {
-    "test": "node --test test/*.test.js"
+    "test": "npm run test:node && npm run test:python",
+    "test:node": "NODE_ENV=test node -e \"const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');const LIVE_ONLY=new Set(['live_vps_m4_operational.test.js','docker_vpn_live_slots.test.js','m2_concurrency_challenge.test.js','challenger_m3_adversarial.test.js','challenger_m4_m5_adversarial.test.js','m4_lifecycle_and_recovery.test.js','m3_quota_and_fencing_challenge.test.js','m11_round10_forensic_integrity.test.js']);const files=fs.readdirSync('test').filter(f=>f.endsWith('.test.js')&&!LIVE_ONLY.has(f)).sort().map(f=>path.join('test',f));if(!files.length)process.exit(1);const r=spawnSync(process.execPath,['--test',...files],{stdio:'inherit',env:{...process.env,NODE_ENV:'test',RUN_LIVE_VPS_TESTS:'0'}});process.exit(r.status??1);\"",
+    "test:python": "PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=python:test python3 -B -m unittest discover -s python -p 'test_*.py' && PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=python:test python3 -B -m unittest discover -s test -p '*test*.py'",
+    "test:live": "RUN_LIVE_VPS_TESTS=1 node --test test/live_vps_m4_operational.test.js test/docker_vpn_live_slots.test.js"
   },
   "engines": {
     "node": ">=22"
```

#### 3.5.2 Explicit Opt-In Guard in `Bot/test/live_vps_m4_operational.test.js` & `Bot/test/docker_vpn_live_slots.test.js`

To prevent accidental live VPN slot rotation or production SQLite access even if `node --test test/*.test.js` is invoked directly outside `npm test`:

```diff
--- a/Bot/test/live_vps_m4_operational.test.js
+++ b/Bot/test/live_vps_m4_operational.test.js
@@ -68,7 +68,9 @@ function curlCommand(args, timeoutMs = 15000) {
   });
 }
 
-describe('Milestone M4: VPS Live Operational Testing & Safe Validation', () => {
+const LIVE_VPS_ENABLED = process.env.RUN_LIVE_VPS_TESTS === '1';
+
+describe('Milestone M4: VPS Live Operational Testing & Safe Validation', { skip: !LIVE_VPS_ENABLED ? 'Live VPS operational test requires RUN_LIVE_VPS_TESTS=1' : false }, () => {
   const runtime = createDockerRuntime();
   let testTempDir = null;
```

```diff
--- a/Bot/test/docker_vpn_live_slots.test.js
+++ b/Bot/test/docker_vpn_live_slots.test.js
@@ -81,7 +81,9 @@ async function getDirectHostIp() {
   return KNOWN_HOST_SERVER_IP;
 }
 
-describe('Docker VPN 5-Slot Live Infrastructure & Host IP Zero Leak Gate', () => {
+const LIVE_VPS_ENABLED = process.env.RUN_LIVE_VPS_TESTS === '1';
+
+describe('Docker VPN 5-Slot Live Infrastructure & Host IP Zero Leak Gate', { skip: !LIVE_VPS_ENABLED ? 'Live Docker VPN slot test requires RUN_LIVE_VPS_TESTS=1' : false }, () => {
   const runtime = createDockerRuntime();
```

---

### 3.6 `Bot/scripts/run_all_automated_tests.sh` (Fix CI-01 & CI-06)

```diff
--- a/Bot/scripts/run_all_automated_tests.sh
+++ b/Bot/scripts/run_all_automated_tests.sh
@@ -9,10 +9,11 @@
 # ==============================================================================
 set -euo pipefail
 
-ROOT_DIR="/root/Projects/YJAutoPostOnX"
-BOT_DIR="${ROOT_DIR}/Bot"
-NODE_BIN="/usr/local/bin/node"
-PYTHON_BIN="${BOT_DIR}/.venv-direct-x/bin/python"
+BOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
+ROOT_DIR="$(cd "${BOT_DIR}/.." && pwd)"
+NODE_BIN="$(command -v node)"
+PYTHON_BIN="${BOT_DIR}/.venv-direct-x/bin/python"
+[ -x "${PYTHON_BIN}" ] || PYTHON_BIN="$(command -v python3)"
+RUN_LIVE_VPS_TESTS="${RUN_LIVE_VPS_TESTS:-0}"
 
 TIMESTAMP="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
 echo "=============================================================================="
@@ -35,11 +36,15 @@ fail_check() {
 
 pass_check() {
   local suite_name="$1"
-  local raw_count="${2:-0}"
+  local raw_count="${2:-}"
   local count
-  count="$(echo "${raw_count}" | grep -oE '[0-9]+' | head -1 || echo "0")"
-  count="${count:-0}"
+  count="$(printf '%s\n' "${raw_count}" | grep -oE '[0-9]+' | head -1 || true)"
+  if [ -z "${count}" ] || [ "${count}" -le 0 ]; then
+    fail_check "${suite_name}" "(missing or zero parsed test count from runner output)"
+    return
+  fi
   echo "✅ [PASSED] ${suite_name} (${count} tests)"
   TOTAL_PASSED=$((TOTAL_PASSED + count))
 }
@@ -51,9 +56,9 @@ cd "${BOT_DIR}"
 
 # 1.1 Python Discover in python/
 PY_OUT1=$(mktemp)
-if timeout 60s env PYTHONPATH=python:test "${PYTHON_BIN}" -m unittest discover -s python -p 'test_*.py' > "${PY_OUT1}" 2>&1; then
-  PY_COUNT1=$(grep -oE 'Ran [0-9]+ tests' "${PY_OUT1}" | awk '{print $2}')
-  pass_check "Python Suite (Bot/python/test_*.py)" "${PY_COUNT1:-126}"
+if timeout 60s env PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=python:test "${PYTHON_BIN}" -B -m unittest discover -s python -p 'test_*.py' > "${PY_OUT1}" 2>&1; then
+  PY_COUNT1=$(grep -oE 'Ran [0-9]+ tests' "${PY_OUT1}" | awk '{print $2}' || true)
+  pass_check "Python Suite (Bot/python/test_*.py)" "${PY_COUNT1}"
 else
   cat "${PY_OUT1}"
   fail_check "Python Suite (Bot/python/test_*.py)"
@@ -62,9 +67,9 @@ rm -f "${PY_OUT1}"
 
 # 1.2 Python Discover in test/ (p2_reproducer_test.py)
 PY_OUT2=$(mktemp)
-if timeout 30s env PYTHONPATH=python:test "${PYTHON_BIN}" -m unittest discover -s test -p '*test*.py' > "${PY_OUT2}" 2>&1; then
-  PY_COUNT2=$(grep -oE 'Ran [0-9]+ tests' "${PY_OUT2}" | awk '{print $2}')
-  pass_check "Python Reproducer Suite (Bot/test/*test*.py)" "${PY_COUNT2:-7}"
+if timeout 30s env PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=python:test "${PYTHON_BIN}" -B -m unittest discover -s test -p '*test*.py' > "${PY_OUT2}" 2>&1; then
+  PY_COUNT2=$(grep -oE 'Ran [0-9]+ tests' "${PY_OUT2}" | awk '{print $2}' || true)
+  pass_check "Python Reproducer Suite (Bot/test/*test*.py)" "${PY_COUNT2}"
 else
   cat "${PY_OUT2}"
   fail_check "Python Reproducer Suite (Bot/test/*test*.py)"
@@ -79,9 +84,9 @@ cd "${BOT_DIR}"
 
 NODE_OUT=$(mktemp)
-if timeout 180s ${NODE_BIN} --test test/*.test.js > "${NODE_OUT}" 2>&1; then
-  PASSED_COUNT=$(grep -oE 'ℹ pass [0-9]+' "${NODE_OUT}" | tail -1 | awk '{print $NF}')
-  pass_check "Node.js Test Suites (test/*.test.js)" "${PASSED_COUNT:-181}"
+if timeout 180s npm run test:node > "${NODE_OUT}" 2>&1; then
+  PASSED_COUNT=$(grep -oE 'ℹ pass [0-9]+' "${NODE_OUT}" | tail -1 | awk '{print $NF}' || true)
+  pass_check "Node.js Offline Test Suites (npm run test:node)" "${PASSED_COUNT}"
 else
   cat "${NODE_OUT}"
   fail_check "Node.js Test Suites (npm run test:node)"
@@ -91,20 +96,24 @@ rm -f "${NODE_OUT}"
 # ------------------------------------------------------------------------------
 # TIER 3: Isolated Network Namespace Forensic Suite
 # ------------------------------------------------------------------------------
-echo ""
-echo ">>> [TIER 3] Executing Isolated Network Namespace Test Suite (unshare -n)..."
-if command -v unshare >/dev/null 2>&1 && [ -f "${BOT_DIR}/TEST_RUNNER/run_suite.py" ]; then
-  NETNS_OUT=$(mktemp)
-  if timeout 60s unshare -n sh -c "ip link set lo up && ${PYTHON_BIN} ${BOT_DIR}/TEST_RUNNER/run_suite.py" > "${NETNS_OUT}" 2>&1; then
-    NETNS_COUNT=$(grep -oE '"PASS": [0-9]+' "${NETNS_OUT}" | awk '{print $NF}')
-    pass_check "Forensic Netns Suite (TEST_RUNNER/run_suite.py)" "${NETNS_COUNT:-42}"
+if [ "${RUN_LIVE_VPS_TESTS}" = "1" ]; then
+  echo ""
+  echo ">>> [TIER 3] Executing Isolated Network Namespace Test Suite (unshare -n)..."
+  if command -v unshare >/dev/null 2>&1 && [ -f "${BOT_DIR}/TEST_RUNNER/run_suite.py" ]; then
+    NETNS_OUT=$(mktemp)
+    if timeout 60s unshare -n sh -c "ip link set lo up && ${PYTHON_BIN} ${BOT_DIR}/TEST_RUNNER/run_suite.py" > "${NETNS_OUT}" 2>&1; then
+      NETNS_COUNT=$(grep -oE '"PASS": [0-9]+' "${NETNS_OUT}" | awk '{print $NF}' || true)
+      pass_check "Forensic Netns Suite (TEST_RUNNER/run_suite.py)" "${NETNS_COUNT}"
+    else
+      cat "${NETNS_OUT}"
+      fail_check "Forensic Netns Suite"
+    fi
+    rm -f "${NETNS_OUT}"
   else
-    cat "${NETNS_OUT}"
-    fail_check "Forensic Netns Suite"
+    fail_check "Forensic Netns Suite (missing unshare or TEST_RUNNER/run_suite.py)"
   fi
-  rm -f "${NETNS_OUT}"
 else
-  echo "⚠️ Skipping Tier 3: unshare command or TEST_RUNNER missing"
+  echo "ℹ️ Tier 3 (TEST_RUNNER/run_suite.py) not executed (set RUN_LIVE_VPS_TESTS=1 to include)"
 fi
 
 # ------------------------------------------------------------------------------
 # TIER 4: Live Docker VPN 5-Slot Health & Zero Host IP Leak Check
 # ------------------------------------------------------------------------------
-echo ""
-echo ">>> [TIER 4] Verifying Live Docker VPN Containers & Exit IPs (Slots 1-5)..."
+if [ "${RUN_LIVE_VPS_TESTS}" = "1" ]; then
+  echo ""
+  echo ">>> [TIER 4] Verifying Live Docker VPN Containers & Exit IPs (Slots 1-5)..."
@@ -165,6 +174,9 @@ else
   echo "  ❌ Docker VPN validation failed: ${#EXIT_IPS[@]}/5 online, ${UNIQUE_COUNT} distinct exit IPs"
   fail_check "Docker VPN 5-Slot Live Health & Zero Host IP Leak Gate"
 fi
+else
+  echo "ℹ️ Tier 4 (Live Docker VPN 5-Slot Gate) not executed (set RUN_LIVE_VPS_TESTS=1 to include)"
+fi
 
 # ------------------------------------------------------------------------------
 # SUMMARY & EXIT CODE
@@ -181,7 +193,7 @@ echo "==========================================================================
 
 if [ "${TOTAL_FAILED}" -eq 0 ]; then
-  echo "🏆 ALL CHECKS PASSED: Milestone M3 Verification Complete with 100% Reliability."
+  echo "✅ ALL EXECUTED CHECKS PASSED (${TOTAL_PASSED} tests, 0 failures)."
   exit 0
 else
   echo "💥 TEST SUITE FAILED with ${TOTAL_FAILED} failure(s)."
```

---

## 4. Local Xvfb & Headless Verification Commands for Phase 5

All verification commands below run in isolated temporary `HOME`/`TMPDIR` under `/root/.hermes/cache/scratch` and must **never** spawn any new Docker/NordVPN container or touch `/root/.config/x-poster-*` or `/root/Projects/YJAutoPostOnX/Bot/data/state.sqlite`.

### 4.1 Verify `Bot/` Offline Python & Node Suites (`CI-01`, `CI-02`, `CI-06`)

```bash
# 1. Verify Python unit & reproducer suites without writing .pyc files
cd /root/Projects/YJAutoPostOnX-surgical-audit/Bot
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=python:test python3 -B -m unittest discover -s python -p 'test_*.py' -v
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=python:test python3 -B -m unittest discover -s test -p '*test*.py' -v

# 2. Verify offline Node test suites (confirming live_vps_m4_operational.test.js and docker_vpn_live_slots.test.js are skipped/excluded)
NODE_ENV=test npm run test:node

# 3. Verify direct invocation of live_vps_m4_operational.test.js skips safely without RUN_LIVE_VPS_TESTS=1
NODE_ENV=test node --test test/live_vps_m4_operational.test.js test/docker_vpn_live_slots.test.js
```

### 4.2 Verify `Appimage/` Headless Xvfb Suites & Windowed Boot Gate (`PR #29`, `CI-03`, `CI-04`, `CI-07`)

```bash
# 1. Run Electron Node-mode baseline & workflow suites
cd /root/Projects/YJAutoPostOnX-surgical-audit/Appimage
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron test/run-all.js

# 2. Run Electron Xvfb UI/IPC integration suites in isolated scratch HOME
SCRATCH_VERIFY="$(mktemp -d -p /root/.hermes/cache/scratch xposter-xvfb-verify-XXXXXX)"
(
  ulimit -c 0
  export HOME="$SCRATCH_VERIFY"
  export XDG_CONFIG_HOME="$HOME/.config"
  export XDG_CACHE_HOME="$HOME/.cache"
  export XDG_DATA_HOME="$HOME/.local/share"
  export TMPDIR="$HOME/tmp"
  mkdir -p "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$TMPDIR"
  xvfb-run -a -f "$HOME/.Xauthority" ./node_modules/.bin/electron --no-sandbox test/smoke.test.js
  xvfb-run -a -f "$HOME/.Xauthority" ./node_modules/.bin/electron --no-sandbox test/ipc-generation.test.js
  xvfb-run -a -f "$HOME/.Xauthority" ./node_modules/.bin/electron --no-sandbox test/full-ui.test.js
  xvfb-run -a -f "$HOME/.Xauthority" ./node_modules/.bin/electron --no-sandbox test/generated-preview-ui.test.js
)
rm -rf "$SCRATCH_VERIFY"

# 3. Run the full release verification gate (builds AppImage, runs package-smoke, 45s Xvfb windowed boot, and real-HOME untouched diff)
cd /root/Projects/YJAutoPostOnX-surgical-audit/Appimage
bash scripts/verify-release.sh
test -f dist/boot.log
! grep -E 'GPU process launch failed|GPU process isn.t usable|Failed to send GetTerminationStatus|App threw an error|Uncaught Exception:|FATAL:' dist/boot.log
```

### 4.3 Verify Fail-Closed `npm audit` Parser (`CI-05`)

```bash
# Confirm malformed/missing-metadata audit JSON exits non-zero (1) rather than defaulting to 0
node -e '
  const assert = require("node:assert/strict");
  const { spawnSync } = require("node:child_process");
  const checkScript = `
    const audit = JSON.parse(process.env.AUDIT_PAYLOAD);
    if (audit.error) process.exit(1);
    const counts = audit.metadata && audit.metadata.vulnerabilities;
    if (!counts || typeof counts !== "object" || !Number.isInteger(counts.high) || !Number.isInteger(counts.critical)) process.exit(1);
    if (counts.high > 0 || counts.critical > 0) process.exit(1);
  `;
  for (const bad of ["{}", "{\"error\":{\"code\":\"ENOAUDIT\"}}", "{\"metadata\":{}}"]) {
    const r = spawnSync(process.execPath, ["-e", checkScript], { env: { ...process.env, AUDIT_PAYLOAD: bad } });
    assert.strictEqual(r.status, 1, `Expected exit 1 for payload ${bad}`);
  }
  const ok = spawnSync(process.execPath, ["-e", checkScript], {
    env: { ...process.env, AUDIT_PAYLOAD: "{\"metadata\":{\"vulnerabilities\":{\"high\":0,\"critical\":0}}}" }
  });
  assert.strictEqual(ok.status, 0);
  console.log("CI-05 fail-closed audit parser verified.");
'
```


---

## 7.3 Cryptographically Verified Deletion & Retention Manifest Summary

### 7.3.1 Off-Repo Cryptographic Backup Vault (`/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/`)

All retired and retained files are backed up and verified (`sha256sum -c SHA256SUMS` = `OK`) in `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/`:

| # | Backup Artifact Path | Bytes | Full SHA-256 Digest | Scope & Verification Status |
|---:|---|---:|---|---|
| 1 | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst` | 30,275,905 | `6eefa29940fefd568ad67224651e6ca0112b0cb5daf99d6ad5f6f2ac3ef2b92e` | Complete filesystem archive at baseline `21c44df` (including untracked/gitignored files, `.pyc`, and `Bot/data/*`). Verified `OK`. |
| 2 | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst` | 3,841,922 | `78d67190498a1cf2008bb14aaacced941209c7226d212d704c637378b6ed9dd0` | All 405 git-tracked files at current `main` HEAD `f394756a7550fddb7f16c20b74118b99546c1cf4` (post-PR #28/#29). Verified `OK`. |
| 3 | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/repository.bundle` | 24,522,069 | `37f05e2191d7124012c6d600ddb884e38eba14fc7aea2f621aa3a7668af8e09f` | Full Git repository bundle at baseline `21c44df`. Verified `OK`. |
| 4 | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/repository.bundle` | 24,539,886 | `2efb74b2bc43fd3120aeec8271e3c24f8747ad5323855a83f3bc68f1f91b42f4` | Full Git repository bundle at current `main` `f394756`. Verified `OK`. |
| 5 | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/state.sqlite.online-backup` | 8,663,040 | `930ef0ed9419644e2463d656dbf262cecf8722638d88e9b34376087ff59f18df` | Consistent online SQLite backup (`sqlite3 .backup`) of production `Bot/data/state.sqlite`. Verified `OK`. |
| 6 | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/session_leases.sqlite.online-backup` | 16,384 | `846287c946459399be82f15d96b141afc4e1350bea091845fd4dc37e4a844fe1` | Consistent online SQLite backup (`sqlite3 .backup`) of production `Bot/data/session_leases.sqlite`. Verified `OK`. |
| 7 | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/filesystem-inventory.jsonl` | 1,073,955 | `60bc88a2e9809be17df60623bb1ec02e3ab28b922fd18bf712e98c1c36f503ea` | Per-file SHA-256 and stat inventory of the entire repository tree. Verified `OK`. |

### 7.3.2 Summary Accounting of All 220 Primary Deletion Candidates + 32 `.pyc` Files

- **Phase 3 Retirements (124 files):**
  - `Bot/Reports/*`: **117 files** (`72` Markdown reports in Section 2.2, `24` non-Markdown files in Section 2.3, `21` archives in Section 2.4) + **13 subdirectories** (`Bot/Reports/PHASE_P1`, `Bot/Reports/RepairHandoff/*`, `Bot/Reports/RepairHandoff`), replaced by `Bot/Reports/Old reports.md`.
  - Repo-root duplicates & stray files: **7 files** (`MASTER_TODO.md`, `PROGRESS_HISTORY.md`, `RESOURCE_CLEANUP_REPORT.md`, `ARCHIVES/LIVE_OPERATIONAL_VERIFICATION.zip`, `ARCHIVES/ROUND3_EVIDENCE.zip` + empty `ARCHIVES/` directory in Phase 3 worktree; plus untracked/gitignored `PROJECT.md` and 0-byte `Bot/state.sqlite` documented in Section 2.5).
- **Phase 4 Retirements (96 legacy test/runner/script files + 32 `.pyc` files):**
  - `58` legacy Node test files (`Bot/test/*.test.js`), `1` legacy Python test in `Bot/test/p2_reproducer_test.py`, `13` legacy Python tests in `Bot/python/test_*.py`, `7` files in `Bot/TEST_RUNNER/*`, `17` obsolete scripts in `Bot/scripts/*`, and `32` untracked `.pyc` files in `Bot/python/__pycache__/` and `Bot/TEST_RUNNER/__pycache__/`, to be replaced in Phase 4 by the fresh hermetic `Bot/test/` tree (Section 7.1).

| # | Phase 4 Retirement Path (`Bot/test/`, `Bot/python/`, `Bot/TEST_RUNNER/`, `Bot/scripts/`) | Subgroup | Git Status | Bytes | Full SHA-256 | Off-Repo Backup Archive Pointer |
|---:|---|---|---|---:|---|---|
| 1 | `Bot/test/account_refresh_and_exit_ip.test.js` | `legacy_node_tests_58` | `tracked` | 12,957 | `c59ce9568f244d49da2a9a4ea4572a773265e44542f7ed66999933fe40cb79e5` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/account_refresh_and_exit_ip.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/account_refresh_and_exit_ip.test.js)` |
| 2 | `Bot/test/accounts.test.js` | `legacy_node_tests_58` | `tracked` | 21,736 | `9a785237753bee59974bf94b74dda7288fc644e94f308c776361648cdf8e84d1` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/accounts.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/accounts.test.js)` |
| 3 | `Bot/test/adversarial_fuzz_3strikes_rotation.test.js` | `legacy_node_tests_58` | `tracked` | 35,922 | `ccced741081806d706a3ade45d031869758f638bc3eef22df71216c14e3c689c` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/adversarial_fuzz_3strikes_rotation.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/adversarial_fuzz_3strikes_rotation.test.js)` |
| 4 | `Bot/test/adversarial_m1_challenger.test.js` | `legacy_node_tests_58` | `tracked` | 15,002 | `629096082b7735c7f26d74e6a9cb7c6eba1c4dff1a2eb648022bfaebb0cf3184` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/adversarial_m1_challenger.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/adversarial_m1_challenger.test.js)` |
| 5 | `Bot/test/adversarial_m2_challenger.test.js` | `legacy_node_tests_58` | `tracked` | 18,607 | `fcb945966dbaa477c57486456fc14495956291ff3da1160f5b25b4ce6a026acc` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/adversarial_m2_challenger.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/adversarial_m2_challenger.test.js)` |
| 6 | `Bot/test/ambiguous_inventory_readonly.test.js` | `legacy_node_tests_58` | `tracked` | 1,734 | `ae933b4b1d4ee4a1f1d165f43c490c080cedef663a4ce145f32e18368950d09b` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/ambiguous_inventory_readonly.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/ambiguous_inventory_readonly.test.js)` |
| 7 | `Bot/test/attempt_outcomes_ui.test.js` | `legacy_node_tests_58` | `tracked` | 4,785 | `0d5ce9a2cd81a8ba0749f3bf7fff1a151183e61f6ef732bc91252471ef4638bf` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/attempt_outcomes_ui.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/attempt_outcomes_ui.test.js)` |
| 8 | `Bot/test/challenger_iter2_concurrency_fuzz.test.js` | `legacy_node_tests_58` | `tracked` | 34,138 | `096a827560c2ef4babe00e239f6d5b92e470c414c67d742e8cbd61635032c448` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/challenger_iter2_concurrency_fuzz.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/challenger_iter2_concurrency_fuzz.test.js)` |
| 9 | `Bot/test/challenger_m1_adversarial.test.js` | `legacy_node_tests_58` | `tracked` | 30,863 | `89e6a310eefeae35147e82742f853ebcb675199890586f2728cb3840d63bd5f4` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/challenger_m1_adversarial.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/challenger_m1_adversarial.test.js)` |
| 10 | `Bot/test/challenger_m1_adversarial_deep.test.js` | `legacy_node_tests_58` | `tracked` | 33,401 | `32b9aa587427df13139e73fde57c66322187a592eaa50e3f18796f9d237a98fe` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/challenger_m1_adversarial_deep.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/challenger_m1_adversarial_deep.test.js)` |
| 11 | `Bot/test/challenger_m2_adversarial.test.js` | `legacy_node_tests_58` | `tracked` | 33,917 | `651aa2b601989f5fcc90a9617173a2c7fa6648b2eb9bb23e56d476287cea657b` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/challenger_m2_adversarial.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/challenger_m2_adversarial.test.js)` |
| 12 | `Bot/test/challenger_m3_adversarial.test.js` | `legacy_node_tests_58` | `tracked` | 36,343 | `33264cdbee80fa51f48a5caa1dde4af3a9530872116b9ccd851818c8bb003474` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/challenger_m3_adversarial.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/challenger_m3_adversarial.test.js)` |
| 13 | `Bot/test/challenger_m4_m5_adversarial.test.js` | `legacy_node_tests_58` | `tracked` | 13,912 | `fb7348539ed9f2d1a2e96cf7e03c0379e384bd81475a9032d3edd7bf22b68da1` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/challenger_m4_m5_adversarial.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/challenger_m4_m5_adversarial.test.js)` |
| 14 | `Bot/test/challenger_r3_m3_2_fuzz.test.js` | `legacy_node_tests_58` | `tracked` | 28,625 | `2d63c9e1eba61f5e0aa1ae048c124e94e4f0ea5c3e5bb1699f05ef8250d02cfe` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/challenger_r3_m3_2_fuzz.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/challenger_r3_m3_2_fuzz.test.js)` |
| 15 | `Bot/test/challenger_r3_m3_adversarial_verification.test.js` | `legacy_node_tests_58` | `tracked` | 28,680 | `c5effd921ea0499945b2b256fff13f924d0617057326e9ca99b99c00eccfdf40` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/challenger_r3_m3_adversarial_verification.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/challenger_r3_m3_adversarial_verification.test.js)` |
| 16 | `Bot/test/challenger_r4_m1_2_empirical.test.js` | `legacy_node_tests_58` | `tracked` | 26,841 | `820d5789d2b2d0edb1a08c8923c79c299670e32a98bee97fda4ecca1035ebf20` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/challenger_r4_m1_2_empirical.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/challenger_r4_m1_2_empirical.test.js)` |
| 17 | `Bot/test/challenger_r4_m1_empirical_fuzz.test.js` | `legacy_node_tests_58` | `tracked` | 18,427 | `5491b877a0b510da3ab98796d6a35a574565e106f6e9be2fb40c47ac6b5d5c22` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/challenger_r4_m1_empirical_fuzz.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/challenger_r4_m1_empirical_fuzz.test.js)` |
| 18 | `Bot/test/direct_x_cache_verification.test.js` | `legacy_node_tests_58` | `tracked` | 3,683 | `95e7af2fbdefdaad31b65e9f77b693441ddb8cfe15fd5a15b0e4f7471cb51020` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/direct_x_cache_verification.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/direct_x_cache_verification.test.js)` |
| 19 | `Bot/test/docker_vpn_live_slots.test.js` | `legacy_node_tests_58` | `tracked` | 6,300 | `dcb57d26de37477fdbb5428bbaef485dd983fc1c1f8518de56cdda2c47c7602d` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/docker_vpn_live_slots.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/docker_vpn_live_slots.test.js)` |
| 20 | `Bot/test/docker_vpn_server_ip.test.js` | `legacy_node_tests_58` | `tracked` | 9,594 | `a29e68b993302e826229075ea1ae5e19835656acbea61a378f22fd9075a7516c` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/docker_vpn_server_ip.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/docker_vpn_server_ip.test.js)` |
| 21 | `Bot/test/empirical_stress_challenge.test.js` | `legacy_node_tests_58` | `tracked` | 24,076 | `c666d43e874a84c7523136376f004fbc2343bd637ddde34f00b4d173bb6fac6a` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/empirical_stress_challenge.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/empirical_stress_challenge.test.js)` |
| 22 | `Bot/test/env_validation.test.js` | `legacy_node_tests_58` | `tracked` | 7,370 | `3171e6ada8ed84602bee6830f17a46698cc7d57defd693d554dc8489ecf16d8c` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/env_validation.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/env_validation.test.js)` |
| 23 | `Bot/test/known_twikit_parser_failure.test.js` | `legacy_node_tests_58` | `tracked` | 1,779 | `0a9343c3768ddfcb58bfabd0671d8ae63f8cb6614dc488191473fca289416905` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/known_twikit_parser_failure.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/known_twikit_parser_failure.test.js)` |
| 24 | `Bot/test/live_vps_m4_operational.test.js` | `legacy_node_tests_58` | `tracked` | 27,067 | `bd86d40afc30634172ce161c413332f5ece8562c6868b00fce00092243cb4467` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/live_vps_m4_operational.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/live_vps_m4_operational.test.js)` |
| 25 | `Bot/test/m10_evidence_monitor_completion.test.js` | `legacy_node_tests_58` | `tracked` | 4,551 | `0c9d154ca46ad4b4c8011dfed00c7dbb53c01ab41b47bb0a6712bffc564329b8` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/m10_evidence_monitor_completion.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/m10_evidence_monitor_completion.test.js)` |
| 26 | `Bot/test/m10_native_start_and_sqlite_reads.test.js` | `legacy_node_tests_58` | `tracked` | 4,584 | `ea9885251559abab0085647f959638ecfd08a88b0e1ed670ce0b76dda16180b8` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/m10_native_start_and_sqlite_reads.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/m10_native_start_and_sqlite_reads.test.js)` |
| 27 | `Bot/test/m11_graphql_error_root_cause.test.js` | `legacy_node_tests_58` | `tracked` | 1,406 | `f44cb1aad9eb353fc5750188d9f6a0cfbfd7053d08af097daf3f6721eb27c1cb` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/m11_graphql_error_root_cause.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/m11_graphql_error_root_cause.test.js)` |
| 28 | `Bot/test/m11_round10_forensic_integrity.test.js` | `legacy_node_tests_58` | `tracked` | 7,751 | `22ce093450af513d052530ce9d5024f5d0d63081041a2f1dda71754c53a6c485` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/m11_round10_forensic_integrity.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/m11_round10_forensic_integrity.test.js)` |
| 29 | `Bot/test/m12_sqlite_production_safety_guard.test.js` | `legacy_node_tests_58` | `tracked` | 13,632 | `50af6e0fcdb89eb1bf5251ee2b92e83d9085f44f722264bfb963cc6b0e164c3e` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/m12_sqlite_production_safety_guard.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/m12_sqlite_production_safety_guard.test.js)` |
| 30 | `Bot/test/m13_session_guard_ceiling.test.js` | `legacy_node_tests_58` | `tracked` | 2,834 | `4624aab8b9db461a5cc694d97af1b06979141112811163550db10a998ce08043` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/m13_session_guard_ceiling.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/m13_session_guard_ceiling.test.js)` |
| 31 | `Bot/test/m14_captcha_e2e_verification.test.js` | `legacy_node_tests_58` | `tracked` | 11,341 | `a9f3f1f3be412b3e0af89f37299add64dcb7c7b03b975220b3d5fb7b4f6f5006` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/m14_captcha_e2e_verification.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/m14_captcha_e2e_verification.test.js)` |
| 32 | `Bot/test/m14_captcha_gate_and_outbox.test.js` | `legacy_node_tests_58` | `tracked` | 7,043 | `ac3c3411e13559096b99952c5d16e472dd3a9f739718030933a1d692cf4c4402` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/m14_captcha_gate_and_outbox.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/m14_captcha_gate_and_outbox.test.js)` |
| 33 | `Bot/test/m14_outbox_drain_and_quota.test.js` | `legacy_node_tests_58` | `tracked` | 5,969 | `a951f8f05ca80afb4a18fdaf98841e77cae91967e1c26e0b59dc8c6ec0ec30be` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/m14_outbox_drain_and_quota.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/m14_outbox_drain_and_quota.test.js)` |
| 34 | `Bot/test/m14_round2_review_fixes.test.js` | `legacy_node_tests_58` | `tracked` | 14,586 | `0c3f51e1dc726bd8839c3f16847b603f180e848ce15f02e947501fa72b1f2d44` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/m14_round2_review_fixes.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/m14_round2_review_fixes.test.js)` |
| 35 | `Bot/test/m14_round3_review_fixes.test.js` | `legacy_node_tests_58` | `tracked` | 16,527 | `15c1d846fe6b8ba15bcc1e45814e90782d7ed9f39a5866ed8f394a1de9f4f84e` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/m14_round3_review_fixes.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/m14_round3_review_fixes.test.js)` |
| 36 | `Bot/test/m14_round4_review_fixes.test.js` | `legacy_node_tests_58` | `tracked` | 16,718 | `c3b22a75343d35bf23e15b42383572a18f2133d2e16d28516db7bd70612ba594` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/m14_round4_review_fixes.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/m14_round4_review_fixes.test.js)` |
| 37 | `Bot/test/m14_round5_direct_code_fixes.test.js` | `legacy_node_tests_58` | `tracked` | 7,867 | `4061052ebf7938a5342ea9aee8076ce472fa906253047d5bcade3c3a72fddd77` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/m14_round5_direct_code_fixes.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/m14_round5_direct_code_fixes.test.js)` |
| 38 | `Bot/test/m14_session_guard_adversarial.test.js` | `legacy_node_tests_58` | `tracked` | 6,547 | `6f737f8c534191fb59ea3d19ed5374289371ddc73c3bd3ed3a032a15d2a9dce2` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/m14_session_guard_adversarial.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/m14_session_guard_adversarial.test.js)` |
| 39 | `Bot/test/m14_session_guard_hardening.test.js` | `legacy_node_tests_58` | `tracked` | 4,064 | `1c191052ba3d1bea6045e0630fcfbec7e426a589644f16b1dadbe16233a85bda` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/m14_session_guard_hardening.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/m14_session_guard_hardening.test.js)` |
| 40 | `Bot/test/m1_fixes_comprehensive.test.js` | `legacy_node_tests_58` | `tracked` | 19,163 | `c86ed669ee1340655ca35dbe1f0bcfc6ec5d99feb04e0f2e95aa006b5b520a2b` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/m1_fixes_comprehensive.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/m1_fixes_comprehensive.test.js)` |
| 41 | `Bot/test/m2_concurrency_challenge.test.js` | `legacy_node_tests_58` | `tracked` | 10,345 | `27177e2e2b30e81da02697db9fc48e76c634f5ad884a060b348b8c4a2eb2a171` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/m2_concurrency_challenge.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/m2_concurrency_challenge.test.js)` |
| 42 | `Bot/test/m3_edge_case_hardening.test.js` | `legacy_node_tests_58` | `tracked` | 22,973 | `8e218a2dfe204df2549ea5d2aa432e326ab7ba441d48ffaa4a47d1bbd1ef4e97` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/m3_edge_case_hardening.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/m3_edge_case_hardening.test.js)` |
| 43 | `Bot/test/m3_quota_and_fencing_challenge.test.js` | `legacy_node_tests_58` | `tracked` | 30,889 | `ff6f44f7a6ed2567a2e72392f616cb8cd0a3cc09d5ce6693aaa173806f02276f` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/m3_quota_and_fencing_challenge.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/m3_quota_and_fencing_challenge.test.js)` |
| 44 | `Bot/test/m3_telegram_and_csv_dedup.test.js` | `legacy_node_tests_58` | `tracked` | 32,405 | `d05fba0c2dbd98bfdc8dc654f373125aa34a16a05dbff54364b11c12eb5d52d8` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/m3_telegram_and_csv_dedup.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/m3_telegram_and_csv_dedup.test.js)` |
| 45 | `Bot/test/m4_lifecycle_and_recovery.test.js` | `legacy_node_tests_58` | `tracked` | 19,069 | `a8c762817cf6a39d0cb1ab453e2cd99d3df5bb3e9ce02b1cb2d23118d564e73d` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/m4_lifecycle_and_recovery.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/m4_lifecycle_and_recovery.test.js)` |
| 46 | `Bot/test/m5_cycle_report_delivery.test.js` | `legacy_node_tests_58` | `tracked` | 13,490 | `3b31e5d4fa97199a3a4c82d5d42f41e07a6a51aca2ba5b3c068a8675e822788f` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/m5_cycle_report_delivery.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/m5_cycle_report_delivery.test.js)` |
| 47 | `Bot/test/m8_monitor_evidence_contract.test.js` | `legacy_node_tests_58` | `tracked` | 1,731 | `c49ca9e59ce25292fddf490ac70ab3eb7ad580108bed5e577e9975612cdbb785` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/m8_monitor_evidence_contract.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/m8_monitor_evidence_contract.test.js)` |
| 48 | `Bot/test/m8_silent_failures_elimination.test.js` | `legacy_node_tests_58` | `tracked` | 21,301 | `b00531e171df138036e80861d8d9fb4b8f731ad38b7ca85823a4dc8691212807` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/m8_silent_failures_elimination.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/m8_silent_failures_elimination.test.js)` |
| 49 | `Bot/test/p2_concurrency.test.js` | `legacy_node_tests_58` | `tracked` | 16,016 | `3a3b9f9246f4cbaafead68291d360f00f04bc55c802b305b284f224124360a8b` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/p2_concurrency.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/p2_concurrency.test.js)` |
| 50 | `Bot/test/p3_p4_findings_verification.test.js` | `legacy_node_tests_58` | `tracked` | 8,851 | `85134de0f409f667ec80ebad4ebe672ff799c037c40a1a421dd7027cadbde1bb` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/p3_p4_findings_verification.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/p3_p4_findings_verification.test.js)` |
| 51 | `Bot/test/runner_stale_tokens.test.js` | `legacy_node_tests_58` | `tracked` | 7,650 | `71e2f9c63c159cfb3559244b64d74d253eafcabd82860d19d56e3c640b9d2fba` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/runner_stale_tokens.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/runner_stale_tokens.test.js)` |
| 52 | `Bot/test/single_instance_lock.test.js` | `legacy_node_tests_58` | `tracked` | 10,765 | `e0b1bfe3ebc00eedb97a5134136b682be76f91cf978c91cf73401dcbf4597a08` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/single_instance_lock.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/single_instance_lock.test.js)` |
| 53 | `Bot/test/single_instance_lock_adversarial_challenge.test.js` | `legacy_node_tests_58` | `tracked` | 13,694 | `b4b71c0af2f325136c419dafde180b00f997a0b1419cf6921130c77f1efb9249` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/single_instance_lock_adversarial_challenge.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/single_instance_lock_adversarial_challenge.test.js)` |
| 54 | `Bot/test/structured_logger_json_secrets.test.js` | `legacy_node_tests_58` | `tracked` | 1,696 | `8cad8419a9cb2583b52b7ea60b46ae170578a02456102254a2c45cb3ba4483da` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/structured_logger_json_secrets.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/structured_logger_json_secrets.test.js)` |
| 55 | `Bot/test/telegram_api_timeout.test.js` | `legacy_node_tests_58` | `tracked` | 3,014 | `ec60632a123d939e5b73d62002d238d24d7b70959d5381415e0bdcf7bc797096` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/telegram_api_timeout.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/telegram_api_timeout.test.js)` |
| 56 | `Bot/test/telegram_panel_and_compat_user_fix.test.js` | `legacy_node_tests_58` | `tracked` | 2,952 | `765c50aa28373992ec3faf5f219bb1d25488045d25797d421298ad53ed00c75d` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/telegram_panel_and_compat_user_fix.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/telegram_panel_and_compat_user_fix.test.js)` |
| 57 | `Bot/test/x_error_code_preservation.test.js` | `legacy_node_tests_58` | `tracked` | 646 | `fde1cb2fbce056f9ef504d9e9c445780b0baafa0d66119717608dbfb95c2d6b4` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/x_error_code_preservation.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/x_error_code_preservation.test.js)` |
| 58 | `Bot/test/x_failure_diagnostics.test.js` | `legacy_node_tests_58` | `tracked` | 3,008 | `913a9e6684f0c4eb402d10f3a14a23453bd71a48e4158fb1e9538cb61c2e8e2e` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/x_failure_diagnostics.test.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/x_failure_diagnostics.test.js)` |
| 59 | `Bot/test/p2_reproducer_test.py` | `legacy_bot_test_py_1` | `tracked` | 19,755 | `82db8dcae31595d851d7b38a9c2bb523ce3f207c66b9d82813659338d91117dc` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/test/p2_reproducer_test.py) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/test/p2_reproducer_test.py)` |
| 60 | `Bot/python/test_adversarial_challenge.py` | `legacy_python_tests_13` | `tracked` | 23,430 | `1be9ca8d9ece97c8548397fde8319831492c6751611ed43f195984e21edf4158` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/python/test_adversarial_challenge.py) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/python/test_adversarial_challenge.py)` |
| 61 | `Bot/python/test_adversarial_m1_challenger.py` | `legacy_python_tests_13` | `tracked` | 15,374 | `1bbd723b5a22dd7ef5d33cb8349151d7847704e9cc3c91b111cb23c87fbf7d9a` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/python/test_adversarial_m1_challenger.py) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/python/test_adversarial_m1_challenger.py)` |
| 62 | `Bot/python/test_adversarial_m2_challenger.py` | `legacy_python_tests_13` | `tracked` | 23,643 | `1eb99b0255b3ea004c003d694a1734abca4d8bf14c47df18bfc06ae20815469d` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/python/test_adversarial_m2_challenger.py) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/python/test_adversarial_m2_challenger.py)` |
| 63 | `Bot/python/test_bridge_hardening.py` | `legacy_python_tests_13` | `tracked` | 23,058 | `c2374a0a233a074d6f17766cc2baf25ef9a11149320c2e3a365ec00da6b84b96` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/python/test_bridge_hardening.py) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/python/test_bridge_hardening.py)` |
| 64 | `Bot/python/test_challenger_r3_m2_gen2.py` | `legacy_python_tests_13` | `tracked` | 18,310 | `5b743a4962a5881a035d1d678ea00a74b1b010018e4b7bfb6b2fc87d219ee76d` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/python/test_challenger_r3_m2_gen2.py) [baseline 21c44df in /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst]` |
| 65 | `Bot/python/test_compat_api_failure_details.py` | `legacy_python_tests_13` | `tracked` | 2,334 | `c00858e47506348ba91c947b96c3cb40496102808e4980f5f13fac4299c2d3be` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/python/test_compat_api_failure_details.py) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/python/test_compat_api_failure_details.py)` |
| 66 | `Bot/python/test_compat_user_patch.py` | `legacy_python_tests_13` | `tracked` | 3,706 | `ef349bce67a3f58693a02c660e4dd11ff24dd6904efbb5f6baead78ed05dbb13` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/python/test_compat_user_patch.py) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/python/test_compat_user_patch.py)` |
| 67 | `Bot/python/test_graphql_diagnostics_propagation.py` | `legacy_python_tests_13` | `tracked` | 2,451 | `2a97db4d668a462d039e00c74d93873b5182bc482d9d68e451082f2c0939ab50` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/python/test_graphql_diagnostics_propagation.py) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/python/test_graphql_diagnostics_propagation.py)` |
| 68 | `Bot/python/test_m14_captcha_and_session_unverified.py` | `legacy_python_tests_13` | `tracked` | 2,068 | `26fc062360b9c3c0cdcee90e42c874f3c20e06b6c85a7cf302d76f934d4a8416` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/python/test_m14_captcha_and_session_unverified.py) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/python/test_m14_captcha_and_session_unverified.py)` |
| 69 | `Bot/python/test_m2_timeline_and_diagnostics.py` | `legacy_python_tests_13` | `tracked` | 17,810 | `6c6a86a4cbebab1c92d5ee9f5e52dfc8e3e4442b61afcfa505de2e3dd2ad0bd7` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/python/test_m2_timeline_and_diagnostics.py) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/python/test_m2_timeline_and_diagnostics.py)` |
| 70 | `Bot/python/test_normalize_urls.py` | `legacy_python_tests_13` | `tracked` | 46,060 | `1381fe5be9eedfb0cf4903326dbb001d4c1bbba05826ac206866830db43b6e48` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/python/test_normalize_urls.py) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/python/test_normalize_urls.py)` |
| 71 | `Bot/python/test_p2_track2.py` | `legacy_python_tests_13` | `tracked` | 11,314 | `6172e8df9b4480e74898a0f677fe83629211b385cee67ccee42687df0723b624` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/python/test_p2_track2.py) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/python/test_p2_track2.py)` |
| 72 | `Bot/python/test_tweet_rejection_classification.py` | `legacy_python_tests_13` | `tracked` | 3,147 | `af9161b67f3edd5535604ad5f313ebee9b7b23d50e3f8e2415d2cc02da1c9947` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/python/test_tweet_rejection_classification.py) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/python/test_tweet_rejection_classification.py)` |
| 73 | `Bot/TEST_RUNNER/TEST_RESULTS.json` | `legacy_test_runner_7` | `tracked` | 77,008 | `b019673d37f14d6fdf805f8db48e50e6283c8d0f373e3043583fe8786078bed7` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/TEST_RUNNER/TEST_RESULTS.json) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/TEST_RUNNER/TEST_RESULTS.json)` |
| 74 | `Bot/TEST_RUNNER/bridge_worker.py` | `legacy_test_runner_7` | `tracked` | 5,248 | `b87773fd81b117163c4e4f6a220a0128568b8c6fc13fb9ab833f2cacb2ccb49a` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/TEST_RUNNER/bridge_worker.py) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/TEST_RUNNER/bridge_worker.py)` |
| 75 | `Bot/TEST_RUNNER/fake_ipc.py` | `legacy_test_runner_7` | `tracked` | 1,024 | `e734af63e038c668a7f8c6b304d804d819431d3bcb5436845d567152abf1f4b6` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/TEST_RUNNER/fake_ipc.py) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/TEST_RUNNER/fake_ipc.py)` |
| 76 | `Bot/TEST_RUNNER/node_worker.js` | `legacy_test_runner_7` | `tracked` | 7,283 | `932d55119c711dad5e145ae20ef7246bea9cfdb55780445cf13163dc0da13084` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/TEST_RUNNER/node_worker.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/TEST_RUNNER/node_worker.js)` |
| 77 | `Bot/TEST_RUNNER/package_verify.py` | `legacy_test_runner_7` | `tracked` | 5,880 | `1e70a96272dfcf79f93576a9d9b2bc103c9829928946b3cb8cde9d6138f6ab1b` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/TEST_RUNNER/package_verify.py) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/TEST_RUNNER/package_verify.py)` |
| 78 | `Bot/TEST_RUNNER/run_suite.py` | `legacy_test_runner_7` | `tracked` | 24,423 | `e7bb70928a38d35fdb6d603df4993bc6489f440dd122f2736a1151dfde30e327` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/TEST_RUNNER/run_suite.py) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/TEST_RUNNER/run_suite.py)` |
| 79 | `Bot/TEST_RUNNER/transport_worker.py` | `legacy_test_runner_7` | `tracked` | 2,290 | `77400bfa71248cfb14af972bf4cd3c7178e60031c4ca05deff13a9ea909fc7f8` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/TEST_RUNNER/transport_worker.py) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/TEST_RUNNER/transport_worker.py)` |
| 80 | `Bot/scripts/apply_m11_ambiguous_recovery.js` | `obsolete_scripts_17` | `tracked` | 3,860 | `48610d5d0b1479b73f956c918dafb06106d7936d4081c3d28a3381af72a162d5` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/scripts/apply_m11_ambiguous_recovery.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/scripts/apply_m11_ambiguous_recovery.js)` |
| 81 | `Bot/scripts/configure_m4_single_publish.js` | `obsolete_scripts_17` | `tracked` | 2,017 | `02eaf48fe34ce15bb4cbb52eb15c17289604a462ea0875bc0f29d2b47fb05fdb` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/scripts/configure_m4_single_publish.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/scripts/configure_m4_single_publish.js)` |
| 82 | `Bot/scripts/live_production_5_rounds_monitor.js` | `obsolete_scripts_17` | `tracked` | 7,120 | `4c6f5a6109015d02eb198b0c5368567842890cfcb6af684881e61641007668f8` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/scripts/live_production_5_rounds_monitor.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/scripts/live_production_5_rounds_monitor.js)` |
| 83 | `Bot/scripts/m8_live_production_monitor.js` | `obsolete_scripts_17` | `tracked` | 17,421 | `3b46eff468b9b37f233178b78bf9f63a01a3e2a3585c9045d07ef1b38051532c` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/scripts/m8_live_production_monitor.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/scripts/m8_live_production_monitor.js)` |
| 84 | `Bot/scripts/package_live_operational_verification.py` | `obsolete_scripts_17` | `tracked` | 7,259 | `592b6a668d8eb51a7666a456eaad43469c74c78125e60d64170011015a7df1c8` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/scripts/package_live_operational_verification.py) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/scripts/package_live_operational_verification.py)` |
| 85 | `Bot/scripts/package_phase_p1.py` | `obsolete_scripts_17` | `tracked` | 3,852 | `7b92d29ea980eade28182f7674f6b38052488ca7898357bb766e008f7d28982e` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/scripts/package_phase_p1.py) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/scripts/package_phase_p1.py)` |
| 86 | `Bot/scripts/run_all_automated_tests.sh` | `obsolete_scripts_17` | `tracked` | 7,624 | `98da4a881b75bca462bbee9ac859a8ca7d8835dd56d6b850b7317abf138cdde9` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/scripts/run_all_automated_tests.sh) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/scripts/run_all_automated_tests.sh)` |
| 87 | `Bot/scripts/send_m14_final_acceptance_evidence.py` | `obsolete_scripts_17` | `tracked` | 7,065 | `76a8b1f84d2e1f3cb38017f81df1735394eb55515c27d6dba1d35e57499deb29` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/scripts/send_m14_final_acceptance_evidence.py) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/scripts/send_m14_final_acceptance_evidence.py)` |
| 88 | `Bot/scripts/send_m14_postmerge_evidence.py` | `obsolete_scripts_17` | `tracked` | 7,705 | `1185621dc866208afb724666215b7ac87e6a636ad43d281fedd1c8997338dae4` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/scripts/send_m14_postmerge_evidence.py)` |
| 89 | `Bot/scripts/send_m14_python_reconciliation_evidence.py` | `obsolete_scripts_17` | `tracked` | 9,394 | `c0b81aaa98bd02a046cd496c17e1ba2787010a208a01158c61a078570fc35a29` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/scripts/send_m14_python_reconciliation_evidence.py)` |
| 90 | `Bot/scripts/send_m14_round2_evidence.py` | `obsolete_scripts_17` | `tracked` | 3,626 | `f937480707ade62993ed77b613960947c004e848e8a0818babac3c76e48512bf` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/scripts/send_m14_round2_evidence.py) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/scripts/send_m14_round2_evidence.py)` |
| 91 | `Bot/scripts/send_m14_round3_evidence.py` | `obsolete_scripts_17` | `tracked` | 3,704 | `c30c698cc896ce057f3a4fa45d22b7da2c9cac69367e7cfb9ccca6a2ffe78001` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/scripts/send_m14_round3_evidence.py) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/scripts/send_m14_round3_evidence.py)` |
| 92 | `Bot/scripts/send_m14_round4_evidence.py` | `obsolete_scripts_17` | `tracked` | 4,539 | `a583a9d6891f22cea373e1c5a899dab9fd5a4a8bad07f827c6f1ada4a522a349` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/scripts/send_m14_round4_evidence.py) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/scripts/send_m14_round4_evidence.py)` |
| 93 | `Bot/scripts/verify_attempt_token_adversarial.js` | `obsolete_scripts_17` | `tracked` | 23,901 | `ef81efde009b8237c8de368c9be52a5aea3066c4bb9d698c1ff437adf8d4d7ed` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/scripts/verify_attempt_token_adversarial.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/scripts/verify_attempt_token_adversarial.js)` |
| 94 | `Bot/scripts/verify_p1_004_dedup.js` | `obsolete_scripts_17` | `tracked` | 6,639 | `20ecbbb12f60df28ab00ca4a0fc36451f1051f9bbad0457abe288ae1d60d261e` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/scripts/verify_p1_004_dedup.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/scripts/verify_p1_004_dedup.js)` |
| 95 | `Bot/scripts/verify_p1_005_queue_flow.js` | `obsolete_scripts_17` | `tracked` | 7,527 | `9105e506bb8194ce70d80635a02e294ae2d0501edce8d0acf9130b8c2f917bd7` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/scripts/verify_p1_005_queue_flow.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/scripts/verify_p1_005_queue_flow.js)` |
| 96 | `Bot/scripts/verify_stale_attempt_tokens.js` | `obsolete_scripts_17` | `tracked` | 10,157 | `796a4a9e4cd4dbffe5ae014e5580e860d2278eb2d25fcf17a813ac528ebf24bf` | `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst (member: Bot/scripts/verify_stale_attempt_tokens.js) AND /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst (member: YJAutoPostOnX/Bot/scripts/verify_stale_attempt_tokens.js)` |

---

## 7.4 Deterministic Rollback & File Restoration Instructions

### 7.4.1 Restore Any Tracked File (at `f394756`) from `tracked-source.tar.zst`
```bash
# Example: Restore a specific tracked report, test, or script into a target directory
TARGET_REPO="/root/Projects/YJAutoPostOnX-surgical-audit"
REL_PATH="Bot/Reports/00_START_HERE.md"
EXPECTED_SHA="c2c1666c4323b4ab783e1c8947529fcf64be8bd81ca45d75526daae66385d611"

tar --zstd -xf /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/tracked-source.tar.zst \
  -C "$TARGET_REPO" "$REL_PATH"
echo "$EXPECTED_SHA  $TARGET_REPO/$REL_PATH" | sha256sum -c -
```

### 7.4.2 Restore Any Untracked / Gitignored File (at `21c44df`) from `project-files.tar.zst`
```bash
# Example: Restore a gitignored archive or raw log from project-files.tar.zst
TARGET_REPO="/root/Projects/YJAutoPostOnX-surgical-audit"
REL_PATH="Bot/Reports/RepairHandoff/Round13_M14_Evidence.zip"
EXPECTED_SHA="b7d6602e0eac92b348afdd07c7814d311f688d123a9af3c29773de0456f06d27"

tar --zstd -xf /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/project-files.tar.zst \
  --strip-components=1 -C "$TARGET_REPO" "YJAutoPostOnX/$REL_PATH"
echo "$EXPECTED_SHA  $TARGET_REPO/$REL_PATH" | sha256sum -c -
```

### 7.4.3 Full Git Repository Rollback from `repository.bundle`
```bash
# Verify bundle integrity and reset a worktree to exact commit f394756a7550fddb7f16c20b74118b99546c1cf4
echo "2efb74b2bc43fd3120aeec8271e3c24f8747ad5323855a83f3bc68f1f91b42f4  /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/repository.bundle" | sha256sum -c -
git -C /root/Projects/YJAutoPostOnX-surgical-audit fetch /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/source-drift-20261104/repository.bundle
git -C /root/Projects/YJAutoPostOnX-surgical-audit checkout -f f394756a7550fddb7f16c20b74118b99546c1cf4
```

### 7.4.4 Emergency Production SQLite Database Rollback (Owner-Authorized Only)
> **WARNING:** Never overwrite `/root/Projects/YJAutoPostOnX/Bot/data/state.sqlite` while `yj-telegram-bot.service` is running or without explicit owner authorization.
```bash
# 1. Verify online backup SHA-256 and SQLite integrity
echo "930ef0ed9419644e2463d656dbf262cecf8722638d88e9b34376087ff59f18df  /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/state.sqlite.online-backup" | sha256sum -c -
sqlite3 /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/state.sqlite.online-backup "PRAGMA integrity_check;"

# 2. Only when owner-authorized and service is stopped:
# systemctl stop yj-telegram-bot.service
# rm -f /root/Projects/YJAutoPostOnX/Bot/data/state.sqlite-wal /root/Projects/YJAutoPostOnX/Bot/data/state.sqlite-shm
# cp -a /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/state.sqlite.online-backup /root/Projects/YJAutoPostOnX/Bot/data/state.sqlite
```


---

# Section 8: Append-Only Work Log, Checkpoint/Resume Instructions, Latest Next Actions & Evidence-Delivery Receipts

## 8.1 Append-Only Surgical Audit & Consolidation Work Log

| Timestamp (UTC) | Phase / Lane | Actor / Model | Completed Work & Verified Artifacts |
|---|---|---|---|
| `2026-11-04T12:00:00Z` | **Phase 0: Backups & Historical Ingestion** | `Hermes Main + Codex CLI TERRA via 9router` | Created `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/` vault; captured `project-files.tar.zst`, `repository.bundle`, `state.sqlite.online-backup`, `session_leases.sqlite.online-backup`, and `filesystem-inventory.jsonl` at baseline `21c44df33b8118f91b48e38753fa1006a50c328c`; detected and captured source drift to `f394756a7550fddb7f16c20b74118b99546c1cf4` (PR #29 `08bc6a0` + PR #28 `f394756`) in `source-drift-20261104/tracked-source.tar.zst`; ingested all 72 Markdown reports (`historical-read.md`), 24 non-Markdown files (`historical-nonmarkdown.md`), and 21 archives (`archive-evidence-index.md`). |
| `2026-11-04T16:30:00Z` | **Phase 1: Surgical Code & Flow Audit** | `Hermes Main + Delegates + Codex CLI TERRA` | Inspected 69/69 Bot runtime/operational files line-by-line and 8/8 cross-module flows (`coverage-index.md`); ran isolated synthetic probes proving `PERSIST-OBS-04` (CAS retry stale closure), `PERSIST-OBS-05` (worktree DB guard bypass), `TR-06` (concurrent toggle vs CAPTCHA race), `ACC-RAW-01` (CSV import wiping CAPTCHA/ban), `XT-01` (timeline 30m window misattributing old tweets), `XT-02` (`DirectXAdapter` dropping `accountFailure` on timeline recovery), and `UTIL-RAW-01` (top-level key secret redaction bypass); consolidated all 59 raw findings and classified all 53 historical IDs (`phase1-audit-completion-gate.md`). |
| `2026-11-04T19:30:00Z` | **Phase 2: Architecture, Master TODO, CI/Electron & Test Specs** | `Delegates D1, D2, D3, D4` | Authored post-audit architecture, state machines, `ADR-001..010`, and dependency-ordered Master TODO `P01`–`P08` (`phase2-architecture-and-pxx-todo.md`); diagnosed PR #29 CI failure (`job/126416216292` Xvfb `SIGTERM` GPU/zygote race) and `CI-01..08` with empirical reproduction (`phase2-ci-electron-spec.md`); produced cryptographically verified 220-file deletion & retention manifest (`phase3-deletion-manifest.md` / `.json`); designed hermetic fresh test suite `Bot/test/` (`phase4-fresh-test-spec.md`). |
| `2026-11-04T20:05:00Z` | **Phase 3: Report Consolidation & Cleanup (`P08-T01` Part 1)** | `Delegate W1 (Hermes Subagent)` | Verified backup integrity (`sha256sum -c SHA256SUMS` = `OK`); created `/root/Projects/YJAutoPostOnX-surgical-audit/Bot/Reports/Old reports.md` containing all 8 required sections; programmatically verified 100% presence of `FINDING-001..033`, `ADD-P1-01..ADD-P6-04`, all 59 raw finding IDs, and all `P01`–`P08` tasks; retired all other files/subdirectories under `Bot/Reports/` and repo-root duplicates (`MASTER_TODO.md`, `PROGRESS_HISTORY.md`, `RESOURCE_CLEANUP_REPORT.md`, `ARCHIVES/*.zip`, `ARCHIVES/`) in `/root/Projects/YJAutoPostOnX-surgical-audit/`; asserted `find Bot/Reports -mindepth 1` returns ONLY `Bot/Reports/Old reports.md`. |
| `2026-11-04T21:40:00Z` | **Phase 4 & 5: Clean Test Rebuild (`P06`) & Surgical Remediation (`P01`–`P05`, `P07`)** | `Delegates W2, W3, W4 + Hermes Main` | Implemented all `P01`–`P07` code, Python bridge, VPN/session, Telegram UI, and CI/AppImage fixes (`f73b904`, `81bd130`); retired 96 legacy test/runner/script files and built the hermetic 17-file `Bot/test/` suite (`df17172`, `48/48 PASS`: Stage 1 Node `35/35`, Stage 2 Python `11/11`, Stage 3 E2E `2/2`, `productionDbUntouched: true`, `leakedTempDirs: 0`); consolidated `Bot/Reports/Old reports.md` (`01c50e1`) and opened PR #30 (`https://github.com/yjlvfe/YJAutoPostOnX/pull/30`). |
| `2026-11-04T21:58:00Z` | **Phase 6: Independent Review, CI Verification & Nonposting VPS Steady-State** | `Delegates V1, V2, V3 + Hermes Main` | Verified PR #29 Electron/Xvfb `SIGTERM` GPU teardown race is 100% resolved in GitHub Actions Run `41890532909` Job `126786413779` (`boot exit code: 124`, `0` occurrences of `GPU process isn't usable`, `package-smoke 31/31 PASS`, `baseline-tests`, `workflow-tests`, `electron-tests` all `PASS`); identified and fixed `REV-01` (`PermissionError` when non-root GitHub runner stats `/root/Projects/.../.venv-direct-x` in `Bot/test/python/test_01..03_*.py`) and `REV-02` (`Old reports.md` Section 7/8 sync); executed 3-interval (`t=0s, 30s, 60s`) nonposting steady-state observation on `yj-telegram-bot.service` (`active/running`, `MainPID=2581192`, `NRestarts=0`, `0` active leases, `4` NordVPN containers + `1` SOCKS sidecar `<= 7` cap, `30` quarantined ambiguous items with `requeueApproved: false`, `53d0f458` fenced). |

---

## 8.2 Checkpoint / Resume Instructions for Subsequent Phases & Agents

1. **Before Any Worktree or Code Action:**
   - Verify backup vault integrity:
     ```bash
     sha256sum -c /root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK/SHA256SUMS
     ```
   - Verify production database and service are untouched:
     ```bash
     systemctl status yj-telegram-bot.service --no-pager
     stat -c '%n %s %Y' /root/Projects/YJAutoPostOnX/Bot/data/state.sqlite /root/Projects/YJAutoPostOnX/Bot/data/session_leases.sqlite
     ```
   - Verify NordVPN 7-container host cap (`docker ps -a --format '{{.Names}}	{{.Status}}' | grep -i vpn`): never spawn an 8th container or temporary test container.
2. **Single Living Reference Rule:**
   - Do **not** recreate fragmented report files in `Bot/Reports/` or at the repository root (`MASTER_TODO.md`, `PROGRESS_HISTORY.md`, `RESOURCE_CLEANUP_REPORT.md`).
   - Append all new phase completion records, test execution results, and verified delivery receipts directly to **Section 8** (and update task statuses in **Section 5**) of `/root/Projects/YJAutoPostOnX-surgical-audit/Bot/Reports/Old reports.md`.

---

## 8.3 Latest Next Actions & Explicit Remaining Exclusions (`P08`)

1. **Completed Engineering Phases (`P01`–`P07` — `TESTED_PASS`):**
   - All `P01`–`P07` code fixes, hermetic `Bot/test/` suite (`48/48 PASS`: 35 Node, 11 Python, 2 E2E), report consolidation (`Bot/Reports/Old reports.md`), and CI/AppImage Xvfb GPU teardown repairs are implemented and verified.
2. **Remaining Owner-Gated / External Policy Items (`P08`):**
   - **`GATE-LIVE-X-PUBLISH` (`BLOCKED` — X Developer Policy / Automation Rules Compliance):** Live X publishing via `Twikit` (`2.3.3`) scraped web-session cookies (`auth_token`/`ct0`) and reverse-engineered GraphQL (`CreateTweet`) violates X Developer Policy / Automation Rules prohibiting non-API website automation. Zero live X test posts were executed during this engagement (`cycle.state: stopped`). Compliant migration to official X API v2 (`POST /2/tweets` with OAuth 2.0 / OAuth 1.0a user context) is required before enabling live X posting.
   - **`ITEM-53D0-SETTLEMENT` (`PENDING_APPROVAL` — Owner Authorization Gate):** Queue item `53d0f458-3144-4e89-a1af-202a8893afc6` (`tweetId: 2049987886359699848`, `@Roshnisa2002`) remains quarantined in `state = 'ambiguous'` in production `Bot/data/state.sqlite`. Dry-run verified (`READY_FOR_OWNER_APPROVAL`); live `--apply` requires explicit owner authorization (`YJ_APPROVE_PROD_SETTLEMENT_53D0=1`).
   - **`BANNED-ACCOUNTS-3` (`BLOCKED` — External X Account Standing):** Accounts `@kaniabq`, `@marcosvhv`, and `@menalobq` remain `enabled: false, status: 'banned'` (`lastErrorCode: 64`) and cannot be automated unless X lifts the suspensions and fresh owner cookies are uploaded.

---

## 8.4 Evidence-Delivery Receipts Ledger

### 8.4.1 Historical Reported Telegram Delivery Receipts (Tagged `[CLAIMED-UNVERIFIED]`)

> **Audit Caveat:** The receipts below were recorded in historical Round 3–14 reports and JSON manifests (`Round14_M14_*_Delivery_Manifest.json`). They document historical transmissions of prior archives to chats `528864559` and `5535435580` and do **not** represent delivery of the current surgical audit or post-audit remediation package.

| Historical Round / Milestone | Archive / Artifact Filename | Reported SHA-256 | Recipient Chat `528864559` (`message_id`) | Recipient Chat `5535435580` (`message_id`) | Audit Verification Status |
|---|---|---|---|---|---|
| **Phase P3 / Live Post CSV (`2026-11-01`)** | `links_2026-11-01.csv` | — | `1127` | `1128` | `[CLAIMED-UNVERIFIED]` (Historical narrative in `PROGRESS_HISTORY.md`) |
| **Milestone M4 CSV Delivery (`2026-11-02`)** | `links_2026-11-02.csv` | `625f80f1899a00336c9bf68418b1361493785ceb6713b52ef9d8b730eafe52dd` | `1322` | — | `[CLAIMED-UNVERIFIED]` (Historical narrative in `PROGRESS_HISTORY.md`) |
| **Round 14 — PR #27 Final VPS Acceptance (`2026-11-03T20:03:30Z`)** | `Round14_M14_PR27_Final_VPS_Acceptance_Evidence.zip` (225,017 B) | `e16cc43e65b408a2e26dd2e67b7ce239fb0ed51d2c1b37c1e71789745726da43` | `1638` | `1639` | `[CLAIMED-UNVERIFIED]` (From `Round14_M14_PR27_Final_VPS_Acceptance_Delivery_Manifest.json`) |
| **Round 14 — Post-Merge VPS Acceptance (`2026-11-04T03:38:16Z`)** | `Round14_M14_PostMerge_VPS_Acceptance_Evidence.zip` (99,071 B) | `c989b450ffafdc4b28b303b24f6dfeff49c64686be7e628e31779ef00f862571` | `1642` | `1643` | `[CLAIMED-UNVERIFIED]` (From `Round14_M14_PostMerge_VPS_Acceptance_Delivery_Manifest.json`) |
| **Round 14 — Python Reconciliation (`2026-11-04T05:31:18Z`)** | `Round14_M14_Python_Reconciliation_Evidence.zip` (145,298 B) | `69047369c3e03db6ef225f3c4104a22c6754db000a3bf1f7c867f423f826e440` | `1646` | `1647` | `[CLAIMED-UNVERIFIED]` (From `Round14_M14_Python_Reconciliation_Delivery_Manifest.json`) |

### 8.4.2 Post-Audit Evidence-Delivery Receipts (Current Engagement)

| Delivery Event | Artifact / Commit | SHA-256 | Chat ID & `message_id` Receipt | Status |
|---|---|---|---|---|
| **Surgical Audit & Phase 3 Consolidation (`2026-11-04`)** | `Bot/Reports/Old reports.md` | *Computed upon final commit* | `NONE (Read-Only Mandate: Zero Telegram API mutations executed during Phase 0–3)` | `HELD_FOR_FINAL_PHASE_DELIVERY` |
