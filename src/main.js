const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
app.disableHardwareAcceleration();
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const fs_sync = require('fs');
const { createReadStream } = require('fs');
const csv = require('csv-parser');

// 🔒 Security modules
const { runAudit, printReport } = require('./security/auditor');

// 2. LINUX SURVIVAL & BROWSER ARCHITECTURE (CRITICAL)
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-setuid-sandbox');

let mainWindow;
let loginContext = null;
const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 800,
    minWidth: 900,
    minHeight: 650,
    resizable: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    title: "X-Poster - أداة النشر التلقائي",
  });

  mainWindow.loadFile(path.join(__dirname, 'ui/index.html'));
}

app.whenReady().then(async () => {
  // Ensure report directory exists at startup
  const REPORT_DIR = path.join(os.homedir(), '.config', 'x-poster-bot-profile', 'reports');
  try {
    await fs.mkdir(REPORT_DIR, { recursive: true });
  } catch (e) {
    // Non-critical
  }

  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  if (loginContext) {
    try { await loginContext.close(); } catch (e) { /* best-effort */ }
    loginContext = null;
  }
});

// --- SETTINGS MANAGER ---
ipcMain.handle('get-settings', async () => {
  try {
    await fs.access(CONFIG_FILE);
    const data = await fs.readFile(CONFIG_FILE, 'utf8');
    const config = JSON.parse(data);
    return config;
  } catch (e) {
    return {};
  }
});

ipcMain.on('save-settings', async (event, settings) => {
  // Merge with existing settings
  try {
    const existing = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8'));
    Object.assign(existing, settings);
    await fs.writeFile(CONFIG_FILE, JSON.stringify(existing, null, 2));
  } catch (e) {
    await fs.writeFile(CONFIG_FILE, JSON.stringify(settings, null, 2));
  }
});

// --- File Dialog Handlers ---
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  return result.filePaths[0];
});

ipcMain.handle('select-csv', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'CSV Files', extensions: ['csv'] }]
  });
  return result.filePaths[0];
});

ipcMain.on('open-folder', (event, folderPath) => {
  if (folderPath) {
    shell.openPath(folderPath);
  }
});

// CSV parsing handler with length & link validation + stats + multi-column media detection
ipcMain.handle('parse-csv', async (event, filePath) => {
  return new Promise((resolve, reject) => {
    const rawPosts = [];
    let totalProcessed = 0;
    let skippedLength = 0;

    createReadStream(filePath)
      .pipe(csv({ headers: false }))
      .on('data', (row) => {
        const vals = Object.values(row);
        let post = vals[0] || '';
        let mediaPath = null;

        // Auto-detect media column: scan columns 1..N for a value that looks like a file path
        for (let ci = 1; ci < vals.length; ci++) {
          const candidate = (vals[ci] || '').trim().replace(/^\"|\"$/g, '');
          if (candidate && candidate.toUpperCase() !== 'N/A') {
            if (candidate.startsWith('/') || candidate.startsWith('~') || candidate.startsWith('./') ||
                /\.(jpg|jpeg|png|gif|mp4|webm|webp|svg|bmp|mov|avi|mkv)$/i.test(candidate)) {
              mediaPath = candidate;
              break;
            }
          }
        }

        if (post) {
          post = post.trim().replace(/^\"|\"$/g, '').replace(/\"\"/g, '"').trim();
          if (post) {
            totalProcessed++;
            if (post.length > 270) {
              skippedLength++;
              return;
            }
            rawPosts.push({ post, mediaPath });
          }
        }
      })
      .on('end', async () => {
        const posts = [];
        let skippedLink = 0;

        async function validateMedia(path) {
          if (!path || path === 'N/A') return null;
          try {
            await fs.access(path);
            return path;
          } catch {
            return null;
          }
        }

        const validationPromises = rawPosts.map(async ({ post, mediaPath }) => {
          if (mediaPath) {
            const validatedMedia = await validateMedia(mediaPath);
            if (!validatedMedia) {
              console.warn(`Media file not found: ${mediaPath}, queuing as text-only`);
              return { text: post, media_path: null, mediaWarning: true };
            }
            return { text: post, media_path: validatedMedia };
          }
          return { text: post, media_path: null };
        });

        const validatedPosts = await Promise.all(validationPromises);
        
        for (const postData of validatedPosts) {
          if (postData.mediaWarning) {
            skippedLink++;
          }
          
          if (postData.media_path) {
            posts.push({ text: postData.text, media_path: postData.media_path });
          } else {
            posts.push(postData.text);
          }
        }

        const added = posts.length;
        resolve({ posts, totalProcessed, added, skippedLength, skippedLink });
      })
      .on('error', (err) => {
        reject(err);
      });
  });
});

// --- AUTOMATION CONTROL ---
const xPoster = require('./automation/xPoster');
const queueManager = require('./automation/queueManager');
const { openProfileForLogin } = require('./automation/browserManager');
const REPORT_DIR = path.join(os.homedir(), '.config', 'x-poster-bot-profile', 'reports');

// Session Stats
let sessionStats = { success: 0, failed: 0 };

// Queue IPC handlers
ipcMain.handle('get-queue', async (event, profileName) => {
  return await queueManager.getQueue(profileName);
});

ipcMain.handle('add-posts', async (event, newPosts, profileName) => {
  let skippedLength = 0;
  let totalCount = newPosts.length;

  const sanitizedPosts = [];
  for (const newPost of newPosts) {
    const text = (typeof newPost === 'string' ? newPost : newPost.text || '').trim();
    if (text.length > 270) {
      skippedLength++;
      continue;
    }
    const media_path = (typeof newPost === 'object' ? newPost.media_path || null : null);
    if (media_path) {
      sanitizedPosts.push({ text, media_path });
    } else {
      sanitizedPosts.push(text);
    }
  }

  const result = await queueManager.addPosts(sanitizedPosts, profileName);
  return {
    successfullyAdded: result.added,
    skippedLength,
    skippedDuplicate: result.skippedDuplicate,
    newTotal: result.total,
  };
});

ipcMain.handle('bulk-delete', async (event, indices, profileName) => {
  return await queueManager.bulkDelete(indices, profileName);
});

let automationRunning = false;

ipcMain.handle('start-posting', async (event, config) => {
  if (automationRunning) {
    mainWindow.webContents.send('status-update', { type: 'warning', message: 'Automation already running' });
    return { success: false, error: 'Automation already running' };
  }

  automationRunning = true;
  global.isRunning = true;
  try {
    await xPoster.start(config, (status) => {
      mainWindow.webContents.send('status-update', status);
    });
    return { success: true };
  } catch (error) {
    mainWindow.webContents.send('status-update', { type: 'error', message: error.message });
    return { success: false, error: error.message };
  } finally {
    automationRunning = false;
    global.isRunning = false;
  }
});

// Global unhandled rejection handler
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  if (mainWindow) {
    mainWindow.webContents.send('status-update', { type: 'error', message: `Unhandled error: ${reason}` });
  }
});

ipcMain.on('stop-automation', () => {
  global.isRunning = false;
});

// Login mode handler
ipcMain.handle('open-profile-for-login', async (event, profileName) => {
  if (loginContext) {
    const pages = loginContext.pages();
    if (pages.length > 0) {
      await pages[0].bringToFront();
      return { success: true, reused: true };
    }
    loginContext = null;
  }
  try {
    loginContext = await openProfileForLogin(profileName);
    return { success: true };
  } catch (error) {
    loginContext = null;
    return { success: false, error: error.message };
  }
});

// Profile listing handler
const PROFILES_DIR = path.join(os.homedir(), '.config', 'x-poster-profiles');

ipcMain.handle('get-profiles', async () => {
  try {
    await fs.access(PROFILES_DIR);
    const entries = await fs.readdir(PROFILES_DIR, { withFileTypes: true });
    const profiles = entries
      .filter(e => e.isDirectory())
      .map(e => e.name);
    return profiles.length > 0 ? profiles : ['Default'];
  } catch {
    return ['Default'];
  }
});

// === PROFILE MANAGEMENT IPC HANDLERS ===

ipcMain.handle('create-profile', async (event, profileName) => {
  try {
    if (!profileName || !profileName.trim()) {
      return { success: false, error: 'اسم البروفايل مطلوب' };
    }
    const safeName = profileName.trim().replace(/[/<>:"\\|?*]/g, '');
    if (!safeName) {
      return { success: false, error: 'اسم البروفايل غير صالح' };
    }
    const profilePath = path.join(PROFILES_DIR, safeName);
    try {
      await fs.access(profilePath);
      return { success: false, error: 'البروفايل موجود بالفعل' };
    } catch {
      // Doesn't exist — create it
    }
    await fs.mkdir(profilePath, { recursive: true });
    await fs.writeFile(path.join(profilePath, 'config.json'), JSON.stringify({
      name: safeName,
      createdAt: new Date().toISOString(),
      browserName: 'chrome'
    }, null, 2));
    return { success: true, profile: { name: safeName } };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('delete-profile', async (event, profileName) => {
  try {
    if (!profileName || profileName === 'Default') {
      return { success: false, error: 'لا يمكن حذف البروفايل الافتراضي' };
    }
    const profilePath = path.join(PROFILES_DIR, profileName);
    await fs.rm(profilePath, { recursive: true, force: true });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('rename-profile', async (event, oldName, newName) => {
  try {
    if (!oldName || oldName === 'Default') {
      return { success: false, error: 'لا يمكن تعديل البروفايل الافتراضي' };
    }
    const safeName = newName.trim().replace(/[/<>:"\\|?*]/g, '');
    if (!safeName) return { success: false, error: 'الاسم الجديد غير صالح' };
    const oldPath = path.join(PROFILES_DIR, oldName);
    const newPath = path.join(PROFILES_DIR, safeName);
    await fs.rename(oldPath, newPath);
    return { success: true, profile: { name: safeName } };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Export Queue Handler
ipcMain.handle('export-queue', async (event, exportPath, profileName) => {
  try {
    const queue = await queueManager.getQueue(profileName);
    const csvLines = queue.map(item => {
      const text = typeof item === 'string' ? item : item.text;
      const media = typeof item === 'object' ? item.media_path : '';
      return `"${text.replace(/"/g, '""')}","${media}"`;
    }).join('\n');
    await fs.writeFile(exportPath, `Text,Media\n${csvLines}`);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Run audit
ipcMain.handle('run-audit', async () => {
  const report = runAudit();
  return { success: report.status === 'PASS', report };
});

// Export Logs Handler
const LOG_DIR = path.join(os.homedir(), '.config', 'x-poster-bot-profile');
const LOGS_DIR = path.join(LOG_DIR, 'logs');

ipcMain.handle('get-logs', async () => {
  try {
    await fs.access(LOGS_DIR);
    const entries = await fs.readdir(LOGS_DIR, { withFileTypes: true });
    const logs = entries
      .filter(e => e.isFile() && e.name.endsWith('.log'))
      .map(e => e.name);
    return logs.sort().reverse();
  } catch {
    return [];
  }
});

ipcMain.handle('read-log', async (event, logName) => {
  try {
    const logPath = path.join(LOGS_DIR, logName);
    const content = await fs.readFile(logPath, 'utf8');
    return { success: true, content };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('export-logs-to-csv', async (event, targetPath) => {
  try {
    await fs.access(LOGS_DIR);
    const entries = await fs.readdir(LOGS_DIR, { withFileTypes: true });
    const logFiles = entries.filter(e => e.isFile() && e.name.endsWith('.log'));
    
    let merged = 'Time,Content,Link,Status\n';
    for (const file of logFiles) {
      const logPath = path.join(LOGS_DIR, file.name);
      let content = await fs.readFile(logPath, 'utf8');
      content = content.replace(/^\s*Time.*\n?/gm, '');
      merged += content;
    }
    
    await fs.writeFile(targetPath, merged);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// AI Generation Handler
ipcMain.handle('generate-ai-posts', async (event, config) => {
  const { provider, apiKey, prompt, quantity, baseUrl, model } = config;

  let endpoint = '';
  let body = {};
  const defaultBaseUrl = 'https://api.openai.com/v1';
  const resolvedBaseUrl = baseUrl ? baseUrl.replace(/\/+$/, '') : defaultBaseUrl;
  const resolvedModel = model || 'gpt-4o';
  
  if (provider === 'openai') {
    endpoint = `${resolvedBaseUrl}/chat/completions`;
    body = {
      model: resolvedModel,
      messages: [
        { role: 'system', content: 'You are an expert social media copywriter. Write engaging tweets in Arabic or English. Keep them under 280 characters. Be creative and varied.' },
        { role: 'user', content: `Generate ${quantity} unique tweets about: ${prompt}. Format as JSON array: ["tweet 1", "tweet 2", ...]` }
      ],
      max_tokens: 2000,
      temperature: 0.9,
      n: 1
    };
  } else if (provider === 'anthropic') {
    endpoint = 'https://api.anthropic.com/v1/messages';
    body = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [
        { role: 'user', content: `Generate ${quantity} unique tweets about: ${prompt}. Format as JSON array: ["tweet 1", "tweet 2", ...]. Keep each tweet under 280 characters.` }
      ]
    };
  } else {
    return { success: false, error: 'Invalid provider. Use "openai" or "anthropic".' };
  }

  try {
    const headers = {
      'Content-Type': 'application/json'
    };
    
    if (provider === 'openai') {
      headers['Authorization'] = `Bearer ${apiKey}`;
    } else if (provider === 'anthropic') {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`API error: ${response.status} - ${errText}`);
    }

    const data = await response.json();
    let content = '';

    if (provider === 'openai') {
      content = data.choices[0].message.content;
    } else {
      content = data.content[0].text;
    }

    const posts = JSON.parse(content);
    const validPosts = Array.isArray(posts) ? posts : [content];

    return { success: true, posts: validPosts, count: validPosts.length };
  } catch (error) {
    return { success: false, error: error.message };
  }
});
