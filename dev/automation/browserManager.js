const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);
const path = require('path');
const os = require('os');
const fs = require('fs');

function resolveProfilePath(profileName) {
  const name = profileName || 'Default';
  return path.join(os.homedir(), '.config', 'x-poster-profiles', name);
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
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled'
    ],
  };

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