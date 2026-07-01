# TEST AGENTS

**Generated:** 2026-06-26
**Scope:** 15 test files, 4 strategies — unit, mock-server integration, real Electron IPC, live API stress

## OVERVIEW

15 test files across 4 strategies: pure unit, mock-server integration (HTTP mock + contentEngine), real Electron IPC (boots main.js), live API stress (requires `IYH_KEY`). No test framework — manual `passed`/`failed` counters with `process.exit()`.

## TEST RUNNER

`npm test` chains 5 suites via `&&`: `referral-toggle.test.js` (51) → `e2e-generation.test.js` (13) → `reportEngine.test.js` (13) → `session-manager.test.js` (22) → `full-ui.test.js` (87) = 186 tests. Fails fast on first suite failure.

## STRATEGIES

| Strategy | Files | Mechanism |
|----------|-------|-----------|
| **Unit** | `referral-toggle`, `reportEngine` | Pure `require()` + sandbox dirs. `referral-toggle` monkey-patches `os.homedir` to a temp dir for fs isolation. |
| **Mock server** | `e2e-generation`, `session-manager` | `http.createServer` returns realistic Arabic crypto cores. Proves pipeline logic, stateless flat threads, cross-session dedup, persist/resume. No Electron. |
| **Real IPC** | `smoke`, `ipc-generation`, `full-ui`, `full-inspect`, `list-models` | Boots real `main.js` via `require('../src/main.js')`. `smoke`/`full-inspect` verify DOM via `executeJavaScript`. `ipc-generation` routes through `window.api.generateAiPosts`. `list-models` hits live IYH API. |
| **Live API** | `live-100`, `live-1session-50`, `live-500`, `live-session-cache` | REAL provider via `IYH_KEY`. Mirror `main.js` HTTP layer verbatim (buildAiRequest/extractAiText/parseTweetArray/callAi). | 
| **Utilities** | `screenshot`, `screenshot-studio` | Not in `npm test`. Boot app in Xvfb, capture page PNGs. |

## COVERAGE MAP

| src/ module | Tested by |
|-------------|-----------|
| `src/main.js` | smoke, ipc-generation, list-models, full-ui (registry scan), full-inspect |
| `src/preload.js` | full-ui (API surface check) |
| `src/ui/index.html` | smoke, full-ui, full-inspect (DOM presence) |
| `src/ui/renderer.js` | full-ui (event binding scan) |
| `src/automation/contentEngine.js` | e2e-generation, session-manager, full-ui, live-*, ipc-generation |
| `src/automation/sessionManager.js` | session-manager, live-*, live-session-cache |
| `src/automation/referralService.js` | referral-toggle, full-ui |
| `src/automation/rateLimitStore.js` | full-ui |
| `src/automation/queueManager.js` | full-ui |
| `src/automation/reportEngine.js` | reportEngine, full-ui |
| `src/automation/xPoster.js` | full-ui (cooldown skip logic only) |
| `src/security/auditor.js` | full-ui |
| `src/security/validator.js` | referral-toggle |
| `src/security/migrator.js` | referral-toggle, full-ui |

## COVERAGE GAPS

- **`src/automation/browserManager.js`** — no tests at all. Playwright context init, profile login flow, X.com posting selectors all untested.
- **`src/automation/xPoster.js`** — only cooldown skip logic exercised (full-ui §8). `start()` / `startMulti()` / `postToX()` untested.
- **`src/ui/styles.css`** — zero coverage (no visual regression tests).

## HOW TO RUN

```bash
npm test                          # 5 suites, 186 tests
node test/referral-toggle.test.js # standalone unit
IYH_KEY=xxx node test/live-100.test.js  # requires real API key
```
