# Current Task

Complete the user's ordered surgical audit of YJAutoPostOnX before any new architecture, phased master TODO, report consolidation, test replacement, or remediation.

# Completed

* Inventoried the production checkout, remote PR/CI state, live service, aggregate queue and VPN container baseline. Initial production HEAD was `21c44df33b8118f91b48e38753fa1006a50c328c`; production main advanced to `f394756a7550fddb7f16c20b74118b99546c1cf4` after PRs #28 and #29 were merged.
* Created access-restricted off-repo recovery bundle at `/root/YJAutoPostOnX-private-audits/20261104-audit-D8N9YK`: full filesystem archive, Git bundle, SQLite online backups, filesystem inventory and SHA-256 manifest. Verified archive compression, checksums, 64 restored files, Git bundle restoration and both database quick checks.
* Created dedicated worktree and branch `audit/surgical-20261104`; merged current production main into the audit branch after preserving the newer committed source. Production checkout remains on main.
* Saved and checked a second Git bundle, tracked-source archive and online SQLite backups for current source and runtime state under `source-drift-20261104`; restored and compared three changed files and checked database integrity.
* Indexed reports, archives and test-named files; recorded all 53 historical IDs and their sources with claims unverified. Began read-only audit lanes for Telegram/runtime, VPN/session, X transport, persistence and CI/AppImage; coverage remains incomplete.
* Isolated diagnostics reproduced an evidence-reconciliation failure, two X confirmation/incident-propagation edge cases, a CAPTCHA/account activation interleaving, CAPTCHA state loss during CSV replacement, and a stale dispatch admission flag after an SQLite revision retry; real-world occurrence and full production reachability remain unverified.

# Currently Working On

Phase 0 historical ingestion and Phase 1 line-by-line system audit remain incomplete; source changed since initial audit, so changed files and evidence must be revalidated against current main. Raw notes are in the protected off-repo evidence directory; no new architecture or Pxx plan has been created.

# Next Steps

1. Continue reading historical reports and tests; record per-source coverage and classify all 53 historical IDs against independent evidence.
2. Complete runtime module and cross-flow audit, including queue, persistence, transport, VPN, security, CI, AppImage, rollback and raw logs; record explicit uninspected areas.
3. Only after the full audit gate, derive architecture and the phased master TODO, then follow the user's prescribed consolidation, fresh-test and implementation order.

# Blockers / Important Notes

* Service PID predates the production checkout update; its loaded Node code and newly spawned Python code may differ, so deployed SHA is unverified. Service is running while publishing cycle is stopped; avoid publishing or changes to service, queues, accounts, credentials and VPN containers. The 30 ambiguous items and `53d0f458-3144-4e89-a1af-202a8893afc6` require protection.
* Default `npm test` includes a test that can rotate the real VPN slot; do not run the undifferentiated suite on production. A previously reported M11 database warning was not supported by the specific case inspected, which uses a temporary DB; broader safety remains unverified.
* Source paths can create a missing project VPN container or remove an owned container under specific triggers even with the publishing cycle stopped; execution in the current live service is not established. Preserve the explicit device policy.
* Python diagnostics overwrote two existing production checkout Python 3.12 `__pycache__` files; the originals exist in the protected snapshot. No code, database, or service was intentionally changed.
* Official X developer policy was reviewed, but the Automation Rules page returned HTTP 403 and account/API authorization remains unverified; no live X post is authorized by this evidence.
* TERRA alias inference succeeded via 9router; upstream Terra 6.1 identity is not independently verified. A SessionStart hook failed in that probe.
* Historical progress follows unchanged and is not current authority.

---

# work-progress.md - YJAutoPostOnX M11

## Current State / الحالة الراهنة
- Git commit: `8b49f3590fe2c332547b64c57af8603599608b54` (origin/main).
- PR #19 merged successfully.
- Service `yj-telegram-bot.service` is not yet restarted; awaiting test verification and ambiguous post audit.

## Task Overview / نظرة عامة على المهمة
- **M11: Root-Cause Recovery & Real Production Verification**.
- Eliminate unknown failure causes in CreateTweet across Telegram/Scheduler -> Runner -> VPN -> Python Bridge -> Twikit -> X GraphQL -> SQLite.
- Conduct safe read-only audit of ambiguous posts (`scripts/audit_ambiguous_readonly.js`).
- Classify ambiguous items and restore verified unposted items safely to pending.
- Run production verification (5-10 cycles) via approved Telegram admin path.
- Deliver comprehensive evidence report and zip.

## Milestones & Progress / المراحل والإنجاز
- [x] Step 1: Pull origin/main and verify approved commit `8b49f3590fe2c332547b64c57af8603599608b54`.
- [ ] Step 2: Run Python and Node regression test suites with strict timeouts; inspect GitHub CI status.
- [ ] Step 3: Run read-only audit of ambiguous posts (`audit_ambiguous_readonly.js`) and store report (mode 0600).
- [ ] Step 4: Classify all ambiguous items, gather forensic corroboration, execute safe recovery where proven.
- [ ] Step 5: Test and verify production readiness, then start real execution via Telegram admin interface.
- [ ] Step 6: Monitor 5-10 natural rotation cycles, inspect each attempt for raw X diagnostics.
- [ ] Step 7: Update documentation (MASTER_TODO, PROGRESS_HISTORY), create signed evidence zip, deliver final article.

## Stopping Point / نقطة التوقف الحالية
- Ready to execute Step 2 (Python & Node test suites & GitHub CI check).

## Next Steps / الخطوات التالية
- Execute Python tests with direct-x virtualenv.
- Execute Node test suite in `Bot`.
- Check GitHub CI status for latest commit.
