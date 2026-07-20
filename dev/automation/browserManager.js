const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);
const fs = require('fs');
const path = require('path');
const { resolveProfilePath } = require('./profileRegistry');

/**
 * Chromium's Linux sandbox needs its `chrome-sandbox` helper to be a setuid-root
 * binary (mode 4755, owner root) — Electron places it next to the running
 * executable (node_modules/electron/dist in dev, or the app dir once packaged).
 * Without that bit, requesting the sandbox doesn't just make things "less safe":
 * Chromium refuses to launch at all. electron-builder/AppImage packaging does
 * NOT set the setuid bit on its own (it stays 0755, unprivileged), so this must
 * be checked at runtime rather than assumed from "not running as root" — the
 * real-world desktop user this exists to protect is exactly who'd hit a broken
 * launch if we assumed wrong.
 */
function sandboxHelperIsSetuidRoot() {
  if (process.platform !== 'linux') return true; // no SUID helper involved on win/mac
  try {
    const helperPath = path.join(path.dirname(process.execPath), 'chrome-sandbox');
    const st = fs.statSync(helperPath);
    return st.uid === 0 && (st.mode & 0o4000) !== 0;
  } catch (e) {
    return false; // helper missing/unreadable — assume sandbox unusable
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
  const runningAsRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (process.platform === 'linux' && (runningAsRoot || !sandboxHelperIsSetuidRoot())) {
    opts.args.unshift('--no-sandbox', '--disable-setuid-sandbox');
  }

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

module.exports = { launchBrowser, resolveProfilePath, openProfileForLogin };