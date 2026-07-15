/** Screenshot capture: boot real app, snap each main view to PNG. */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

require('../dev/main.js');
const OUT = '/tmp/xposter-shots';
try { fs.mkdirSync(OUT, { recursive: true }); } catch {}

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('did-finish-load', async () => {
    try {
      await new Promise(r => setTimeout(r, 2000));
      win.setSize(1200, 860);
      const views = ['dashboard', 'studio', 'settings', 'queue'];
      for (const v of views) {
        await win.webContents.executeJavaScript(`document.querySelector('[data-view="${v}"]').click();`);
        await new Promise(r => setTimeout(r, 700));
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(OUT, v + '.png'), img.toPNG());
        console.log('saved', v);
      }
    } catch (e) { console.log('ERR', e.message); }
    app.exit(0);
  });
});
setTimeout(() => app.exit(0), 20000);
