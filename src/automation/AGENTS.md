# automation/ — X posting engine, AI generation, queue management

**Generated:** 2026-06-26T18:15:00+03:00

## OVERVIEW
8 modules (2831 lines) implementing X.com posting via Playwright, parallel AI tweet generation with stateless-flat architecture, shared queue with per-profile position pointers, rate-limit cooldown tracking, referral link injection, and run reporting.

## STRUCTURE

| File | Lines | Purpose |
|------|-------|---------|
| `xPoster.js` | 750 | Playwright post loop: start (single profile) + startMulti (orchestrator). Human-emulated typing, 3-strategy confirmation, rate-limit detection, cooldown+dead-letter on failure |
| `contentEngine.js` | 839 | AI content engine: angle matrix (20 crypto topics), hashtag bank (35), assembleTweet (200-270 char budget), validateTweet (G2 structural firewall), isDuplicateInSession (Jaccard 0.85), prompt builders, history persistence |
| `sessionManager.js` | 257 | SessionManager class: parallel GenerationSession pool with stateless-flat rounds (v4.3.0). Golden rule: count changes between rounds only. run() → Promise.all(sessionLoops) |
| `queueManager.js` | 265 | Shared queue.json with per-profile positions.json. Serialization mutex (Promise-chain via withLock). Pending-verification + dead-letters per profile |
| `referralService.js` | 237 | Toggle-aware {link} placeholder manager. sanitizePost strips/holds link, checkConsistency validates state. Config file is single source of truth |
| `reportEngine.js` | 234 | ReportEngine class: in-memory event buffer → endRun flushes JSON+TXT reports. Tracks post timings, failure types, timeline |
| `rateLimitStore.js` | 181 | Persistent cooldown store (rate-limits.json). parseCooldownFromText handles Arabic+English patterns ("بعد 30 دقيقة", "25 minutes"). formatRemaining for Arabic UI |
| `browserManager.js` | 68 | Playwright launch with stealth plugin. launchBrowser (persistent context), openProfileForLogin (navigates x.com), resolveProfilePath |

## WHERE TO LOOK

| Task | Entry point | Key functions |
|------|-------------|---------------|
| Post to X.com | `xPoster.js` | `start(config, onStatus)` → line 145, `startMulti(config, onStatus)` → line 685 |
| Confirm post success | `xPoster.js` | `confirmPostSubmitted(page)` → line 93, `getTweetUrlFromDOM(page)` → line 72 |
| Generate AI tweets | `sessionManager.js` + `contentEngine.js` | `SessionManager.run(getTargetMet)` → line 225, `_runSessionRound(session)` → line 168 |
| Validate + dedup AI output | `contentEngine.js` | `validateTweet(text)` → line 420, `isDuplicateInSession(text, session)` → line 498, `assembleTweet(...)` → line 300 |
| Queue management | `queueManager.js` | `getQueue()`, `getProfileQueue(name)`, `advancePosition(name)`, `addPosts(posts)`, `addDeadLetter(...)` |
| Rate limit handling | `rateLimitStore.js` | `setCooldown(name, ms)`, `getCooldown(name)`, `parseCooldownFromText(text)` → line 130 |
| Referral link control | `referralService.js` | `sanitizePost(text)` → line 155, `getState()`, `isEnabled()` |
| Report generation | `reportEngine.js` | `startRun()` → line 37, `endRun()` → line 228, `generateReport()` → line 109 |

## IMPORT DEPENDENCIES

```
xPoster.js  ──→  browserManager  (launchBrowser)
              ──→  queueManager    (getProfileQueue, advancePosition, addDeadLetter, addToPending)
              ──→  reportEngine    (ReportEngine class)
              ──→  rateLimitStore  (getCooldown, setCooldown, parseCooldownFromText, formatRemaining)

sessionManager.js ──→ contentEngine  (injected via constructor deps: syncSessionDedup,
                     buildAcceptedContext, selectAngles)

No other internal imports between automation modules.
All modules import only Node stdlib (fs, path, os, crypto) or each other as shown above.
xPoster.js + browserManager.js also import Playwright (playwright-extra, puppeteer-extra-plugin-stealth).
```

## CONVENTIONS (automation-specific)

- **Serialization mutex**: queueManager uses a `_queueLock` Promise-chain (`withLock(fn)`) to prevent concurrent writes to queue.json — always wrap queue mutations
- **Stateless flat sessions**: sessionManager never persists a conversation thread. Each round = 2 messages [system, user]. `GenerationSession.toJSON()` discards `messages` — only `acceptedBodies` (last 60) survive
- **IPC return shape**: every function called from Electron IPC returns `{ success, ...data }` or `{ success: false, error }` 
- **Status callbacks**: all long-running functions accept `onStatus({ type, message, ... })` for UI updates. Throttled to every 10s in countdown
- **global.* flags**: `global.isRunning` (stop button), `global.isRateLimited` (per-profile break) control Playwright loops — polled every 500ms
- **Browser context cleanup**: always `context.close()` in `finally` block (xPoster.js:628)
- **Dead-letter on failure**: failed posts always advance position + go to dead-letters (never block the queue)
- **Rate limit exit**: immediate throw `RATE_LIMITED` — no sleep/retry. Orchestrator advances to next profile
- **CommonJS**: all modules use `require`/`module.exports`
- **`_` prefixed privates**: `_read()`, `_write()`, `_sync()`, `_state`, `_queueLock`, `_lastError`, `_reconcileSessionCount()` — internal helpers/state not in public API

## ANTI-PATTERNS

- **contentEngine.js >800 lines** — monolithic. Should split into: angle/hashtag data, text utilities (tokenize, jaccard, normalize), validation rules, prompt builders, and history persistence
- **xPoster.js start() >400 lines** — single function mixing Playwright control flow, error classification, CSV logging, and rate-limit detection. Extract CSV writer, error classifier, and recovery logic
- **Rate limit text parsing in xPoster.js** — the visible-text regex scan (lines 408-414) is duplicated in the rateLimitStore; centralize
- **Error classification branches** (xPoster.js:478-489) — fragile string matching on `.message`. No error classes or error codes
- **Best-effort catches** — `try/catch` swallowing in reportEngine, referralService, countdown, and DOM fallbacks can hide bugs
- **Referral in-memory _state** — `referralService.js` caches state but re-reads config on every access via `_sync()`. Unnecessary IO overhead for hot paths like `isEnabled()` called per-loop-iteration
