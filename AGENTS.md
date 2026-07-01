# PROJECT KNOWLEDGE BASE

**Generated:** 2026-06-26T19:52:00+03:00
**Commit:** b3e35be
**Branch:** main

## OVERVIEW
YJAutoPostOnX v4.4.3 — Electron desktop app for X.com (Twitter) automated posting with AI content generation. Stack: Electron 30 + Playwright + CommonJS. CHUNK=20 with scaled maxTokens (n×250). maxCount=3 for overused word detection.

## STRUCTURE
```
xposter/
├── src/main.js           # Electron main + all IPC handlers (~1180 lines)
├── src/preload.js        # contextBridge exposing window.api
├── src/ui/               # index.html + renderer.js + styles.css
├── src/automation/       # 8 modules: posting, AI, queue, browser, cooldowns, reports
├── src/security/         # 3 modules: audit, validate, migrate
├── test/                 # 15 test files: unit, IPC, E2E, live stress
└── dist/                 # Built AppImages (gitignored)
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| AI generation pipeline | `src/main.js:907-` | `generate-ai-posts` handler + SessionManager orchestration (CHUNK=20, maxTokens=n×250) |
| Posting to X.com | `src/automation/xPoster.js` | Playwright `start()` + `startMulti()` |
| AI content validation | `src/automation/contentEngine.js` | assembly, validation, dedup, prompt building |
| Parallel AI sessions | `src/automation/sessionManager.js` | stateless-flat architecture |
| Shared queue system | `src/automation/queueManager.js` | per-profile position pointers |
| Rate limit handling | `src/automation/rateLimitStore.js` | cooldown tracking + X.com message parsing |
| UI rendering | `src/ui/renderer.js` | all event handlers, AI Studio, queue table |
| Tests | `test/` | run with `npm test` (5 suites) |
| Security audit | `src/security/auditor.js` | hardcoded URL scan |

## CODE MAP

| Symbol | Type | File | Role |
|--------|------|------|------|
| `callAi` | function | main.js:778 | HTTP round-trip to AI provider (OpenAI/Anthropic/Gemini) |
| `buildAiRequest` | function | main.js:625 | Protocol-specific request builder |
| `extractAiText` | function | main.js:719 | Parse provider response |
| `parseTweetArray` | function | main.js:739 | Robust JSON/newline parser for LLM output |
| `runRound` | closure | main.js:1090 | Per-session AI round (wraps callAi + chunk) |
| `ingest` | closure | main.js:1006 | Validate + dedup + accept pipeline |
| `onStatus` | closure | main.js:1103 | UI status emitter for sessions |
| `SessionManager` | class | sessionManager.js:90 | Parallel session orchestrator |
| `GenerationSession` | class | sessionManager.js:35 | Single persistent session |
| `start` / `startMulti` | functions | xPoster.js | Playwright post loop + multi-profile |
| `contentEngine.*` | exports (40+) | contentEngine.js | All text utilities, validation, dedup, prompt builders |
| `assembleTweet` | function | contentEngine.js:300 | Core + link + hashtags within 200-270 char budget |
| `validateTweet` | function | contentEngine.js:420 | G2 structural+cleanliness firewall |
| `isDuplicateInSession` | function | contentEngine.js:498 | G3 dedup (exact + Jaccard 0.85) |
| `buildSessionSystem` | function | contentEngine.js:542 | Static system block (cacheable) |
| `buildRoundUser` | function | contentEngine.js:579 | Per-round user message with avoid-list + inspiration |

## CONVENTIONS

- **CommonJS only** — `require`/`module.exports`. No ES modules.
- **IPC return shape**: `{ success: true, ... }` or `{ success: false, error: "..." }`
- **Error handling**: try/catch returning `{ success: false, error: e.message }`
- **Silent catches**: `catch { /* best-effort */ }` for non-critical cleanup
- **Arabic-first UI**: All user-facing strings in Arabic (RTL). Crypto content focus.
- **Module-level mutable state**: `let` flags for cancellation (`aiGenerationCancelled`) and live config (`desiredSessionCount`)
- **`global.*` flags**: `global.isRunning` and `global.isRateLimited` for interrupting Playwright loops
- **Unicode section headers**: `// ═══════`, `// ──`, `// 🧠` in source code for navigation
- **No linter/formatter**: No eslint, prettier, biome, editorconfig
- **No test framework**: Tests use `node <file>` and manual `passed/failed` counters with `process.exit()`

## ANTI-PATTERNS (THIS PROJECT)

- **NO** TypeScript — 5000+ line JS project with no type checking
- **NO** custom error classes — control flow uses string comparison on `new Error().message`
- **NO** logging library — bare `console.*` calls throughout
- **NO** state management — Redux/Zustand absent; vanilla DOM manipulation
- **NO** CSS framework — raw CSS only
- **AVOID** growing AI message threads — stateless flat architecture (v4.3.0) mandates single user turn per round
- **AVOID** mid-round mutations — session count/sync changes apply ONLY between rounds (golden rule)

## UNIQUE STYLES

- Provider detection by **model name** (G5): claude → Anthropic, gemini → Gemini native, everything else → OpenAI
- **Stateless Flat** generation (v4.3.0): no persistent conversation thread; each round = 2 messages (system + user)
- 0% duplicate guarantee via shared `exactKeys` + `tokenSets` with Jaccard 0.85 threshold
- Tweet assembly tries multiple hashtag counts (2,3,1,4) to fit 200-270 char budget
- History-based inspiration: last 10 themes from previous generations fed as context (never used for rejection)

## COMMANDS

```bash
npm start               # Launch app
npm test                # Run 5 test suites (51 + 13 + 13 + 22 + 87 = 186 tests)
node test/diagnostic-pipeline.test.js  # Pipeline diagnostic (32 checks, not in npm test)
npm run build:linux     # Build AppImage (output: dist/YJAutoPostOnX-*.AppImage)
npm run audit           # Run security auditor
```

## NOTES

- Config stored at `~/.config/x-poster-bot-profile/config.json` (AI keys, referral link, speed)
- Queue at `~/.config/x-poster-shared/queue.json` (shared across all profiles)
- AI history at `~/.config/x-poster-bot-profile/generated_history.json` (60-day TTL, 5000-entry cap)
- Rate limits at `~/.config/x-poster-bot-profile/rate-limits.json`
- Browser profiles at `~/.config/x-poster-profiles/<name>/` (Playwright persistent contexts)
- AppImage requires `--no-sandbox` flag on Linux (already baked into launch args)
