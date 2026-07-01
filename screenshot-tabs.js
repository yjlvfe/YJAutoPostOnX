const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      preload: path.join(__dirname, 'src/preload.js')
    }
  });

  win.loadFile('src/ui/index.html');
  
  await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
  await sleep(2000);

  const tabs = ['dashboard', 'studio', 'queue', 'settings'];

  for (const tab of tabs) {
    try {
      const result = await win.webContents.executeJavaScript(`
        (function() {
          let btn = document.querySelector('[data-view="${tab}"]');
          if (btn) { btn.click(); return 'clicked:' + btn.textContent.trim(); }
          return 'notfound';
        })()
      `);
      console.log('Tab', tab, '->', result);
    } catch(e) {
      console.log('Tab', tab, 'error:', e.message);
    }

    await sleep(1500);

    try {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(`/tmp/tab-${tab}.png`, img.toPNG());
      console.log('Saved /tmp/tab-' + tab + '.png (' + img.toPNG().length + ' bytes)');
    } catch(e) {
      console.log('Capture error for', tab, ':', e.message);
    }
  }

  console.log('DONE');
  app.quit();
});

app.on('window-all-closed', () => app.quit());
