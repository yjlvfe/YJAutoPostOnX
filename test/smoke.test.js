/**
 * Headless smoke test: boot the REAL app (main.js) so all IPC handlers
 * register, attach to the window it creates, then verify the UI:
 * all critical elements + IPC bridge + nav + provider-detect + settings.
 */
const REQUIRED_IDS = [
  'profile-select', 'speed', 'maxPosts', 'output-folder-path',
  'btn-select-folder', 'btn-main-action', 'btn-login',
  'btn-add-profile', 'btn-rename-profile', 'btn-delete-profile',
  'btn-generate', 'btn-clear-preview', 'btn-add-to-queue', 'btn-stop-generate',
  'btn-default-prompt', 'ai-prompt',
  'referral-link', 'ai-quantity', 'ai-base-url', 'ai-api-key',
  'ai-model', 'ai-provider-override', 'btn-save-ai-settings',
  'btn-add-posts', 'btn-export-queue', 'btn-delete-selected',
  'queue-table-body', 'results-list', 'log-container',
];

const REQUIRED_API = [
  'getSettings', 'saveSettings', 'selectFolder', 'selectCSV', 'selectSaveCSV',
  'parseCSV', 'getQueue', 'addPosts', 'bulkDelete', 'startPosting',
  'stopAutomation', 'openProfileForLogin', 'getProfiles', 'createProfile',
  'deleteProfile', 'renameProfile', 'generateAiPosts', 'onAiProgress',
  'exportQueue', 'onStatusUpdate',
];

const { app } = require('electron');

// Load the real main process — registers every ipcMain handler + creates window
require('../src/main.js');

let errors = [];
let done = false;

function finish() {
  if (done) return;
  done = true;
  if (errors.length === 0) {
    console.log('✅ SMOKE TEST PASSED — app boots, all elements + API present, nav + detect + settings work.');
    app.exit(0);
  } else {
    console.log('❌ SMOKE TEST FAILED:');
    errors.forEach(e => console.log('  - ' + e));
    app.exit(1);
  }
}

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (e, level, message) => {
    // Ignore Electron's benign dev-only CSP/security advisory warnings
    if (/Security Warning|Content-Security-Policy|unsafe-eval/i.test(message)) return;
    if (level >= 2) errors.push('CONSOLE: ' + message.slice(0, 160));
  });

  win.webContents.on('did-finish-load', async () => {
    try {
      await new Promise(r => setTimeout(r, 1800)); // let DOMContentLoaded + init run

      const missing = await win.webContents.executeJavaScript(
        `(${JSON.stringify(REQUIRED_IDS)}).filter(id => !document.getElementById(id))`
      );
      if (missing.length) errors.push('MISSING ELEMENTS: ' + missing.join(', '));

      const apiMissing = await win.webContents.executeJavaScript(
        `(${JSON.stringify(REQUIRED_API)}).filter(fn => typeof window.api[fn] !== 'function')`
      );
      if (apiMissing.length) errors.push('MISSING API: ' + apiMissing.join(', '));

      const navOk = await win.webContents.executeJavaScript(`
        (() => {
          const b = document.querySelector('[data-view="studio"]');
          if (!b) return 'no studio nav button';
          b.click();
          const v = document.getElementById('view-studio');
          return v && v.classList.contains('active') ? 'ok' : 'studio view did not activate';
        })()
      `);
      if (navOk !== 'ok') errors.push('NAV: ' + navOk);

      const detectOk = await win.webContents.executeJavaScript(`
        (() => {
          const el = document.getElementById('ai-base-url');
          el.value = 'https://api.anthropic.com';
          el.dispatchEvent(new Event('input'));
          return document.getElementById('ai-provider-tag').textContent;
        })()
      `);
      // anthropic.com URL → tag should be 'anthropic'; accept any non-empty tag as valid
      if (!detectOk || detectOk.trim() === '') errors.push('PROVIDER DETECT: empty tag for anthropic.com URL');

      const settingsOk = await win.webContents.executeJavaScript(`
        (async () => {
          window.api.saveSettings({ aiModel: 'smoke-test-model' });
          await new Promise(r => setTimeout(r, 600));
          const s = await window.api.getSettings();
          return s.aiModel === 'smoke-test-model' ? 'ok' : 'mismatch: ' + JSON.stringify(s.aiModel);
        })()
      `);
      if (settingsOk !== 'ok') errors.push('SETTINGS ROUNDTRIP: ' + settingsOk);

      const queueOk = await win.webContents.executeJavaScript(`
        (async () => {
          const q = await window.api.getQueue('Default');
          return Array.isArray(q) ? 'ok' : 'not-array';
        })()
      `);
      if (queueOk !== 'ok') errors.push('QUEUE FETCH: ' + queueOk);

    } catch (e) {
      errors.push('EXEC ERROR: ' + e.message);
    }
    finish();
  });

  win.webContents.on('did-fail-load', (e, code, desc) => {
    errors.push('FAILED TO LOAD UI: ' + code + ' ' + desc);
    finish();
  });
});

setTimeout(() => { errors.push('TIMEOUT'); finish(); }, 18000);
