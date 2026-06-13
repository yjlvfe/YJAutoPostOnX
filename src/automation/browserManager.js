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
  const candidates = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/snap/bin/chrome',
    '/opt/google/chrome/chrome',
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch (e) {}
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
    if (chromePath) opts.executablePath = chromePath;
    opts.channel = 'chrome';
  }

  return opts;
}

async function launchBrowser(profileName) {
  const profilePath = resolveProfilePath(profileName);
  const context = await chromium.launchPersistentContext(profilePath, getLaunchOptions('chrome'));
  return context;
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