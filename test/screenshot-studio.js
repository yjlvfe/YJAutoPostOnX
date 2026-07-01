const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280, height: 800, show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../src/preload.js'),
    }
  });

  // load the app HTML directly
  await win.loadFile(path.join(__dirname, '../src/ui/index.html'));
  await new Promise(r => setTimeout(r, 2000));

  // click studio tab
  await win.webContents.executeJavaScript(`
    const btn = document.querySelector('[data-view="studio"]');
    if (btn) btn.click();
  `);
  await new Promise(r => setTimeout(r, 600));

  try {
    const img = await win.webContents.capturePage();
    fs.writeFileSync('/tmp/studio-preview.png', img.toPNG());
    console.log('✅ screenshot saved');
    app.exit(0);
  } catch(e) {
    console.log('❌ capturePage failed: ' + e.message);
    app.exit(1);
  }
});

setTimeout(() => { console.log('TIMEOUT'); app.exit(1); }, 20000);
