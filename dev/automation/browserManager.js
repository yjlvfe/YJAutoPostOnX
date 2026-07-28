const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);
const fs = require('fs');
const path = require('path');
const { resolveProfilePath } = require('./profileRegistry');

/**
 * Chromium's Linux sandbox needs its `chrome-sandbox` helper to be a setuid-root
 * binary (mode 4755, owner root), sitting next to the browser executable.
 * Without that bit, requesting the sandbox doesn't just make things "less safe":
 * Chromium refuses to launch at all.
 *
 * The helper must be looked up next to the browser we are ABOUT TO LAUNCH.
 *
 * This used to inspect `path.dirname(process.execPath)` — Electron's own
 * chrome-sandbox — and then apply the verdict to a completely different
 * process. Playwright launches either system Chrome (/usr/bin/google-chrome) or
 * its bundled Chromium under ~/.cache/ms-playwright/chromium-NNNN/chrome-linux64,
 * each shipping its own helper with independent permissions. Measured here:
 * Electron's helper is 0755 non-setuid while Playwright's bundled Chromium has
 * no helper at all. Reading one to decide for the other is wrong in both
 * directions — it can leave the sandbox on when the target cannot start (the
 * run dies at browser launch), or silently disable it when the target was fine.
 */
function sandboxHelperIsSetuidRoot(executablePath) {
  if (process.platform !== 'linux') return true; // no SUID helper involved on win/mac
  if (!executablePath) return false;             // unknown target — assume unusable
  try {
    const helperPath = path.join(path.dirname(executablePath), 'chrome-sandbox');
    const st = fs.statSync(helperPath);
    return st.uid === 0 && (st.mode & 0o4000) !== 0;
  } catch (e) {
    return false; // helper missing/unreadable — assume sandbox unusable
  }
}

/**
 * The browser binary Playwright will actually start.
 *
 * `executablePath` when we pinned one, otherwise Playwright's own bundled
 * Chromium. Resolving this is what makes the sandbox check meaningful; if we
 * cannot resolve it we return null and the caller fails safe.
 */
function resolveBrowserExecutable(explicitPath) {
  if (explicitPath) return explicitPath;
  try {
    // playwright-extra proxies executablePath() through to playwright itself.
    const resolved = chromium.executablePath();
    return resolved || null;
  } catch (e) {
    return null;
  }
}

function detectChromePath() {
  // ⚡ C8: expanded candidates — Linux + macOS + Windows so the bundled
  // Chromium fallback only triggers when NO system Chrome is available.
  const candidates = [
    // Linux
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/snap/bin/chrome',
    '/opt/google/chrome/chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    // Windows (common paths)
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch (e) { /* best-effort */ }
  }
  return null;
}

function getLaunchOptions(browserName) {
  const opts = {
    headless: false,
    viewport: { width: 1280, height: 800 },
    colorScheme: 'light',
    args: [
      '--disable-blink-features=AutomationControlled'
    ],
  };
  // Pick the executable FIRST. The sandbox decision depends on which binary
  // launches, so it cannot be made before that binary is known.
  if (browserName === 'chrome') {
    const chromePath = detectChromePath();
    if (chromePath) {
      // ⚡ C8: system Chrome found — use it explicitly.
      opts.executablePath = chromePath;
      opts.channel = 'chrome';
    }
    // ⚡ C8: if NO system Chrome is found we intentionally do NOT set
    // channel='chrome' — Playwright will fall back to its bundled
    // Chromium instead of crashing with a "channel not found" error.
  }

  const runningAsRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const targetExecutable = resolveBrowserExecutable(opts.executablePath);
  if (process.platform === 'linux' && (runningAsRoot || !sandboxHelperIsSetuidRoot(targetExecutable))) {
    opts.args.unshift('--no-sandbox', '--disable-setuid-sandbox');
  }

  return opts;
}

async function launchBrowser(profileName) {
  const profilePath = resolveProfilePath(profileName);
  try {
    const context = await chromium.launchPersistentContext(profilePath, getLaunchOptions('chrome'));
    return context;
  } catch (err) {
    // ⚡ C8: friendly error instead of a raw Playwright stack trace.
    const msg = err && err.message ? err.message : String(err);
    if (msg.includes('channel') || msg.includes('executablePath') || msg.includes('browserType')) {
      throw new Error('فشل تشغيل المتصفح: لا يوجد Chrome ولا Chromium متاح. ثبّت Chrome أو تأكد من وجود Chromium مع Playwright. التفاصيل: ' + msg);
    }
    throw new Error('فشل تشغيل المتصفح: ' + msg);
  }
}

async function openProfileForLogin(profileName) {
  const profilePath = resolveProfilePath(profileName);
  const context = await chromium.launchPersistentContext(profilePath, getLaunchOptions('chrome'));
  try {
    const pages = context.pages();
    const page = pages.length > 0 ? pages[0] : await context.newPage();
    await page.goto('https://x.com');
    await page.bringToFront();
    return context;
  } catch (err) {
    try { await context.close(); } catch (e) { /* best-effort */ }
    throw err;
  }
}

module.exports = {
  launchBrowser,
  resolveProfilePath,
  openProfileForLogin,
  // Exported so the sandbox decision is testable. It was not, which is how it
  // went on inspecting the wrong binary: nothing could observe the verdict
  // without actually launching a browser.
  getLaunchOptions,
  sandboxHelperIsSetuidRoot,
  resolveBrowserExecutable,
  detectChromePath,
};