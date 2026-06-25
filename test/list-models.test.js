/**
 * IPC test for the REAL list-models handler, invoked through window.api
 * exactly as the "🔄 فحص" button does — pointed at the live provider.
 */
const { app } = require('electron');
require('../src/main.js');

const KEY = process.env.IYH_KEY;
const BASE = process.env.IYH_BASE || 'https://v1.iyhapi.app/v1';

let errors = [], done = false;
function finish() {
  if (done) return; done = true;
  if (errors.length === 0) { console.log('✅ LIST-MODELS IPC PASSED'); app.exit(0); }
  else { console.log('❌ FAILED:'); errors.forEach(e => console.log('  - ' + e)); app.exit(1); }
}

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('did-finish-load', async () => {
    try {
      await new Promise(r => setTimeout(r, 1200));
      const result = await win.webContents.executeJavaScript(`
        window.api.listModels({
          baseUrl: ${JSON.stringify(BASE)},
          apiKey: ${JSON.stringify(KEY)},
          providerOverride: 'auto',
        })
      `);
      if (!result.success) { errors.push('handler failed: ' + result.error); return finish(); }
      if (result.provider !== 'openai') errors.push('provider mismatch: ' + result.provider);
      if (!Array.isArray(result.models) || result.models.length === 0) errors.push('no models returned');
      console.log(`   → provider=${result.provider}, ${result.count} models`);
      console.log('   → sample:', result.models.slice(0, 5).join(', '));
    } catch (e) { errors.push('EXEC ERROR: ' + e.message); }
    finish();
  });
});

setTimeout(() => { errors.push('TIMEOUT'); finish(); }, 25000);
