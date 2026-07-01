# src/ui/ — Frontend rendering layer

**Generated:** 2026-06-26T19:52:00+03:00
**Scope:** 3 files (1910 lines) — HTML shell, vanilla DOM controller, raw CSS

## OVERVIEW
Arabic RTL single-page Electron renderer. No framework — vanilla `document.getElementById`, `addEventListener`, `innerHTML`. Dark glassmorphism via CSS custom properties.

## FILES

| File | Lines | Role |
|------|-------|------|
| `index.html` | 367 | HTML shell: 4 views (Dashboard, AI Studio, Queue, Settings) + profile modal + sidebar. Google Fonts (Cairo + JetBrains Mono), CSP header, RTL. |
| `renderer.js` | 873 | All UI logic: event binding, AI generation runner, posting control, live preview streaming, queue table, settings form. Module-level `let state`. |
| `styles.css` | 670 | CSS custom property design system (`--sp-*`, `--fs-*`, `--fw-*`, color palette). Dark glassmorphism, responsive sidebar, switch/card/table/tab patterns. |

## WHERE TO LOOK

| Task | Entry Point | Notes |
|------|-------------|-------|
| AI Studio UI | `renderer.js` `runGeneration()` → line 638 | Progress bar, session chips, live preview streaming via `onAiPostAccepted` |
| Dashboard posting | `renderer.js` `startPosting()` → line 110 | Speed/max/folder config, cooldown banner, activity log |
| Queue table | `renderer.js` `loadQueue()` → line 408, `buildTable()` | Select-all, bulk delete, CSV import/export |
| Settings form | `renderer.js` lines 166-250 | Provider config, model fetch, save |
| CSS design tokens | `styles.css` `:root` vars | Dark/light palette, spacing scale, typography scale |
| HTML views | `index.html` `#view-dashboard`, `#view-studio`, `#view-queue`, `#view-settings` | Single-page nav via tab clicks |

## CONVENTIONS

- **Vanilla DOM only**: `getElementById`, `querySelector`, `innerHTML`, `addEventListener`. No React/Vue/Svelte.
- **Module-level `let state`**: single mutable object for all UI state. Set via direct assignment + manual DOM sync.
- **Arabic-first**: `lang="ar" dir="rtl"` in HTML. All strings in Arabic. English only for code identifiers.
- **IPC via `window.api`**: preload bridge. `ipcRenderer.invoke` (request-response) + `ipcRenderer.on` (streaming events).
- **Live streaming UI**: `onAiPostAccepted`, `onAiSessionStatus`, `onAiProgress` update DOM in real-time during generation.
- **Tab navigation**: hide/show views via CSS `display:none` classes. No client-side routing.
- **Profile modal**: overlay div with `display:flex/fixed` centering. Create/rename profiles.
- **No CSS classes for state**: direct `element.style.X` or `element.classList.toggle()` — no state-driven classes.
- **Data attributes**: `data-*` for row identifiers in queue table.

## ANTI-PATTERNS

- **40 `addEventListener` calls, zero `removeEventListener`** — listeners accumulate on re-render. Memory leak in long sessions.
- **10 `innerHTML` assignments** — lines 221, 626 inject user-influenced content (AI output). XSS risk if AI output contains `<script>` tags. Prefer `textContent` or sanitize.
- **renderer.js >800 lines** — monolithic. Should split: queue controller, AI studio controller, settings controller, dashboard controller.
- **No state management** — `let state` is fragile. Mutations don't trigger re-render; manual DOM sync is error-prone.
- **No CSS framework** — 670 lines of raw CSS is hard to maintain. Every new UI requires manual responsive + dark mode handling.
- **styles.css has dead selectors** — some classes reference views/features that no longer exist in HTML. Periodically audit.
- **No error UI for failed IPC calls** — async `window.api.X()` calls in renderer lack consistent error display to user.
