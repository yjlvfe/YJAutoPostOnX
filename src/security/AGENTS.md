# SECURITY — AGENTS.md

**Generated:** 2026-06-26T18:20:00+03:00

## OVERVIEW
Security audit, pre-publish validation, and config migration for the X posting pipeline.

## STRUCTURE

| File | Purpose |
|------|---------|
| `auditor.js` | Startup security scan — detects hardcoded URLs in source, validates cache files and session profiles, checks referral toggle consistency |
| `validator.js` | Pre-publish post validation — extracts all URLs from rendered text, verifies every referral link matches the active session link |
| `migrator.js` | Idempotent config backfill — adds `referral_enabled` / `referral_link` fields to configs that predate the referral feature |

## FLOW

```
migrator.migrateConfig()  ──►  (called once at startup, adds referral_enabled: true)
                                     │
auditor.runAudit()         ──►  reads source files via scanFileForUrls(),
                                     delegates URL extraction to validator.extractUrls(),
                                     checks referralService.getState() for toggle consistency
                                     │
validator.validatePost()   ──►  calls referralService.isEnabled() / getLinkOrNull(),
                                     normalizes all extracted URLs, blocks on LINK_MISMATCH or FOREIGN_URL
```

All three modules share the `referralService` dependency from `src/automation/referralService`. The `auditor` also imports `validator` for URL extraction but operates at startup only; `validator` runs per-post during publishing.

## CONVENTIONS

- **IPC-shaped returns**: Every exported function returns `{ success: true, data }` or `{ success: false, error }` matching the main.js handler shape. Where the root convention uses `{ success }`, security uses richer shapes — `{ valid, reason, detectedUrls, diagnostics }` (validator) or `{ migrated, added, reason }` (migrator) — but always includes a boolean success-like field.
- **Arabic-first**: All user-facing strings in Arabic (RTL). Internal keys in English.
- **Idempotent**: `migrateConfig()` is safe to call repeatedly — returns `{ migrated: false, reason: 'ALREADY_MIGRATED' }` on subsequent calls.
- **No throw**: All errors caught and returned in result objects. Callers check the status field.
