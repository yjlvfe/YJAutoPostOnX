const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
app.disableHardwareAcceleration();
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const { createReadStream } = require('fs');
const csv = require('csv-parser');
const contentEngine = require('./automation/contentEngine');
const { SessionManager } = require('./automation/sessionManager');

// 🔒 Security modules
const { runAudit } = require('./security/auditor');
const log = require('./utils/logger');

// 2. LINUX SURVIVAL & BROWSER ARCHITECTURE (CRITICAL)
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-setuid-sandbox');

let mainWindow;
let loginContext = null;
// Cooperative cancellation flag: renderer sets via 'cancel-ai-generation'.
let aiGenerationCancelled = false;
// ⚡ C1+C2: Active AbortController for IMMEDIATE stop — aborts ALL in-flight
// AI fetch requests so the user doesn't wait for the current 120s round.
let activeAbortController = null;
// Desired parallel worker count (default 5, adjustable via 'set-session-count').
// NO upper cap — the user's number is the number that runs; SessionManager
// ramps launches in batches and throttles status/persist so large pools stay smooth.
let desiredWorkerCount = 5;
const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');


function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    resizable: true,
    fullscreenable: true,
    useContentSize: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    title: "YJAutoPostOnX - Automated Posting Tool",
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

  // Backfill config fields for installs that predate the referral toggle
  try {
    require('./security/migrator').migrateConfig();
    require('./automation/referralService').init();
  } catch (e) {
    console.error('Config migration/init skipped:', e?.message);
  }

  // Give legacy un-numbered profile folders their mandatory sequence numbers
  try {
    await migrateUnnumberedProfiles();
  } catch (e) {
    console.error('Profile numbering migration skipped:', e?.message);
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
    if (e instanceof SyntaxError) {
      log.error(`get-settings: config.json تالف (JSON غير صالح) — تم إرجاع إعدادات فارغة. ${e.message}`);
    }
    return {};
  }
});

// ⚡ C1: Converted from ipcMain.on (fire-and-forget) to ipcMain.handle so
// the renderer receives the actual result and can surface write failures.
ipcMain.handle('save-settings', async (event, settings) => {
  // Merge with existing settings
  try {
    const existing = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8'));
    Object.assign(existing, settings);
    await fs.writeFile(CONFIG_FILE, JSON.stringify(existing, null, 2));
    return { success: true };
  } catch (e) {
    await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true }).catch(() => {});
    try {
      await fs.writeFile(CONFIG_FILE, JSON.stringify(settings, null, 2));
      return { success: true };
    } catch (e2) {
      return { success: false, error: e2.message || 'فشل حفظ الإعدادات' };
    }
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

ipcMain.handle('select-save-csv', async () => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: 'queue-export.csv',
    filters: [{ name: 'CSV Files', extensions: ['csv'] }]
  });
  return result.canceled ? null : result.filePath;
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
            // Use X-aware length: URLs count as 23 chars (same logic as add-posts)
            if (contentEngine.tweetLength(post) > 280) {
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

// ═══════════════════════════════════════════════════════════════════
// 🔍 PROVIDER DETECTION — single source of truth (main.js only)
// ═══════════════════════════════════════════════════════════════════
// renderer.js NO LONGER carries a mirror copy of detectProvider /
// detectApiFormat / OPENCODE_GO_ANTHROPIC_MODELS. All provider logic
// lives in contentEngine.js and is exposed through this handler.
ipcMain.handle('detect-provider', async (event, config) => {
  const { baseUrl, providerOverride, model } = config || {};
  const provider = contentEngine.detectProvider(baseUrl || '', providerOverride || 'auto', model || '');
  const { format } = contentEngine.detectApiFormat(provider, model || '');
  const label = contentEngine.providerLabel(provider, model || '');
  return { provider, format, label };
});

// --- AUTOMATION CONTROL ---
const xPoster = require('./automation/xPoster');
const { escCsv } = require('./automation/xPoster');
const queueManager = require('./automation/queueManager');
const { SemanticIndex } = require('./automation/semanticIndex');
const { openProfileForLogin } = require('./automation/browserManager');
const rateLimitStore = require('./automation/rateLimitStore');
// Mandatory profile numbering (#1 = Default, #2, #3, …) + ordered listing
const {
  profileNumber,
  stripLeadingNumber,
  listProfilesOrdered,
  nextProfileNumber,
  migrateUnnumberedProfiles,
} = require('./automation/profileRegistry');

// Session Stats
let sessionStats = { success: 0, failed: 0 };

// Queue IPC handlers
ipcMain.handle('get-queue', async (event, profileName) => {
  // 🔒 C3: try/catch on all IPC handlers — never crash the main process.
  try {
    // Shared queue — profileName ignored, returns full shared queue
    return await queueManager.getQueue();
  } catch (e) {
    console.error('get-queue IPC error:', e?.message || e);
    return [];
  }
});

ipcMain.handle('add-posts', async (event, newPosts, profileName) => {
  // 🔒 C3: try/catch on all IPC handlers — never crash the main process.
  try {
    if (!Array.isArray(newPosts)) {
      return { success: false, error: 'newPosts must be an array', successfullyAdded: 0, skippedLength: 0, skippedDuplicate: 0, newTotal: 0 };
    }
    let skippedLength = 0;
    let totalCount = newPosts.length;

    const sanitizedPosts = [];
    for (const newPost of newPosts) {
      const text = (typeof newPost === 'string' ? newPost : newPost.text || '').trim();
      // Use X.com-aware length (URLs count as 23 chars) instead of raw length,
      // so AI tweets with a long referral link aren't wrongly rejected.
      if (contentEngine.tweetLength(text) > 280) {
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
      success: true,
      successfullyAdded: result.added,
      skippedLength,
      skippedDuplicate: result.skippedDuplicate,
      newTotal: result.total,
    };
  } catch (e) {
    console.error('add-posts IPC error:', e?.message || e);
    return { success: false, error: e?.message || 'unknown error', successfullyAdded: 0, skippedLength: 0, skippedDuplicate: 0, newTotal: 0 };
  }
});

// Deletes by post TEXT, not by row position — a position captured when the UI
// last loaded the list goes stale the moment publishing consumes a post, and
// would delete a different post than the one the user picked.
ipcMain.handle('bulk-delete', async (event, texts, profileName) => {
  // 🔒 C3: try/catch on all IPC handlers — never crash the main process.
  try {
    if (!Array.isArray(texts)) return null;
    return await queueManager.bulkDeleteByText(texts);
  } catch (e) {
    console.error('bulk-delete IPC error:', e?.message || e);
    return null;
  }
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
    // Multi-profile run — starts from the SELECTED profile and continues
    // through the ones AFTER it in numeric order (1- Default, 2- …, 3- …).
    // It never wraps back to earlier profiles: when the LAST profile finishes
    // or hits its rate limit, the run stops.
    let profiles;
    if (Array.isArray(config.profiles) && config.profiles.length > 0) {
      profiles = config.profiles;
    } else {
      const ordered = await listProfilesOrdered();
      const selected = config.profile || 'Default';
      let idx = ordered.indexOf(selected);
      if (idx === -1) idx = 0;
      profiles = ordered.slice(idx);
    }

    const { results, summary } = await xPoster.startMulti(
      { ...config, profiles },
      (status) => { mainWindow.webContents.send('status-update', status); }
    );
    return { success: true, results, summary };
  } catch (error) {
    mainWindow.webContents.send('status-update', { type: 'error', message: error.message });
    return { success: false, error: error.message };
  } finally {
    automationRunning = false;
    global.isRunning = false;
  }
});

// --- RATE LIMIT / COOLDOWN IPC ---

// Return all active per-profile cooldowns (auto-prunes expired).
ipcMain.handle('get-cooldowns', async () => {
  try {
    return { success: true, cooldowns: rateLimitStore.getAllCooldowns() };
  } catch (e) {
    return { success: false, error: e.message, cooldowns: {} };
  }
});

// Return the cooldown for a single profile (or null).
ipcMain.handle('get-cooldown', async (event, profileName) => {
  try {
    return { success: true, cooldown: rateLimitStore.getCooldown(profileName) };
  } catch (e) {
    return { success: false, error: e.message, cooldown: null };
  }
});

// Manually clear a profile's cooldown (user override).
ipcMain.handle('clear-cooldown', async (event, profileName) => {
  try {
    const cleared = rateLimitStore.clearCooldown(profileName);
    return { success: true, cleared };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

/**
 * Report a main-process fault to the UI without ever throwing from inside a
 * fault handler.
 *
 * `mainWindow` is truthy but UNUSABLE once the window has been closed — its
 * webContents is gone, so `.send()` throws. Throwing here means throwing from
 * inside the very handler meant to contain the problem: the uncaughtException
 * handler below would re-enter on its own error. isDestroyed() is the actual
 * liveness check; the truthiness check alone is not.
 */
function reportFaultToUI(message) {
  try {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('status-update', { type: 'error', message });
    }
  } catch (e) {
    console.error('Failed to report fault to UI:', e?.message || e);
  }
}

// Global unhandled rejection handler
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  reportFaultToUI(`Unhandled error: ${reason}`);
});

/**
 * Synchronous twin of the rejection handler above. Without it, ONE uncaught
 * throw anywhere in the main process (a Playwright teardown, an Electron API
 * misuse, a bad write) takes the whole app down instantly — no window, no
 * message, mid-run.
 *
 * It deliberately does not exit. The queue is consumed post-by-post, so
 * anything already published is already out of the queue and nothing is
 * double-posted by staying alive; the user gets to see what happened instead of
 * watching the window vanish. The run flags are cleared because the automation
 * that was in flight is definitively over — leaving them set would strand the
 * UI on "جاري النشر..." and `automationRunning` would refuse every later run
 * with "Automation already running".
 */
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  global.isRunning = false;
  automationRunning = false;
  reportFaultToUI(`خطأ غير متوقع أوقف التشغيل: ${error?.message || error} — الطابور سليم، وكل منشور نُشر فعلاً حُذف منه.`);
});

ipcMain.on('stop-automation', () => {
  global.isRunning = false;
});

// Synchronous on purpose: the preload bridge resolves this before the
// renderer's first script runs, so the sidebar can paint the version with the
// rest of the shell instead of popping in a frame later. One small string, once
// per window — app.getVersion() is an in-memory read, not a round-trip to disk.
ipcMain.on('get-app-version', (event) => {
  try {
    event.returnValue = app.getVersion();
  } catch (e) {
    // The UI must still boot if this ever fails; the label just stays empty.
    console.error('get-app-version failed:', e?.message || e);
    event.returnValue = null;
  }
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
    return await listProfilesOrdered();
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
    // The user supplies only a LABEL — the sequence number is mandatory and
    // added by the system. Strip any number the user typed to avoid "3- 3- علي".
    const label = stripLeadingNumber(profileName.trim()).replace(/[/<>:"\\|?*]/g, '').trim();
    if (!label) {
      return { success: false, error: 'اسم البروفايل غير صالح' };
    }
    const existing = await listProfilesOrdered();
    if (existing.some(n => stripLeadingNumber(n) === label || n === label)) {
      return { success: false, error: 'يوجد بروفايل بنفس الاسم بالفعل' };
    }
    const num = await nextProfileNumber();
    const safeName = `${num}- ${label}`;
    const profilePath = path.join(PROFILES_DIR, safeName);
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
    // 🔒 FIX: also strip dots to prevent "../../etc" traversal after slash removal
    const safeName = profileName.trim().replace(/[/<>:"\\|?*.]/g, '');
    if (!safeName) return { success: false, error: 'اسم البروفايل غير صالح' };
    const profilePath = path.resolve(PROFILES_DIR, safeName);
    if (!profilePath.startsWith(path.resolve(PROFILES_DIR) + path.sep)) {
      return { success: false, error: 'مسار غير مسموح' };
    }
    await fs.rm(profilePath, { recursive: true, force: true });
    // Clean up the orphaned cooldown entry for the deleted profile. There is no
    // queue cursor to clean up any more — the shared queue is consumed as it's
    // published, so it holds no per-profile state.
    try { rateLimitStore.clearCooldown(safeName); } catch { /* best-effort */ }
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
    // 🔒 FIX: also strip dots to prevent "../../etc" traversal after slash removal
    const safeOld = oldName.trim().replace(/[/<>:"\\|?*.]/g, '');
    // Renaming changes only the LABEL — the profile keeps its sequence number.
    const label = stripLeadingNumber(newName || '').replace(/[/<>:"\\|?*.]/g, '').trim();
    if (!safeOld || !label) return { success: false, error: 'الاسم غير صالح' };
    const keepNum = profileNumber(safeOld) ?? await nextProfileNumber();
    const safeName = `${keepNum}- ${label}`;
    const profilesBase = path.resolve(PROFILES_DIR) + path.sep;
    const oldPath = path.resolve(PROFILES_DIR, safeOld);
    const newPath = path.resolve(PROFILES_DIR, safeName);
    if (!oldPath.startsWith(profilesBase) || !newPath.startsWith(profilesBase)) {
      return { success: false, error: 'مسار غير مسموح' };
    }
    if (safeName !== safeOld) {
      const existing = await listProfilesOrdered();
      if (existing.some(n => n !== safeOld && stripLeadingNumber(n) === label)) {
        return { success: false, error: 'يوجد بروفايل بنفس الاسم بالفعل' };
      }
      await fs.rename(oldPath, newPath);
      // ⚡ FIX (hidden bug): the rate-limit cooldown is keyed by profile name —
      // without migrating it, a renamed profile lost its cooldown. (The queue
      // cursor this used to migrate no longer exists — the shared queue is
      // consumed as it's published and keeps no per-profile state.)
      try { rateLimitStore.renameProfile(safeOld, safeName); } catch { /* best-effort */ }
    }
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
      const media = typeof item === 'object' ? (item.media_path || '') : '';
      return `${escCsv(text)},${escCsv(media)}`;
    }).join('\n');
    await fs.writeFile(exportPath, `Text,Media\n${csvLines}`);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Run audit
ipcMain.handle('run-audit', async () => {
  // 🔒 C3: try/catch on all IPC handlers — never crash the main process.
  try {
    const report = runAudit();
    return { success: report.status === 'PASS', report };
  } catch (e) {
    console.error('run-audit IPC error:', e?.message || e);
    return { success: false, error: e?.message || 'unknown error' };
  }
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
    const safeName = path.basename(logName);
    const logPath = path.resolve(LOGS_DIR, safeName);
    if (!logPath.startsWith(path.resolve(LOGS_DIR) + path.sep)) {
      return { success: false, error: 'مسار غير مسموح' };
    }
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

    const allLines = [];
    for (const file of logFiles) {
      const logPath = path.join(LOGS_DIR, file.name);
      const content = await fs.readFile(logPath, 'utf8');
      for (const line of content.split('\n')) {
        // skip header lines and blank lines
        if (!line.trim() || /^\s*Time[,\s]/i.test(line)) continue;
        // each log line is already CSV — re-escape each field to prevent injection
        const fields = line.split(',');
        allLines.push(fields.map(f => escCsv(f.replace(/^"|"$/g, '').replace(/""/g, '"'))).join(','));
      }
    }

    await fs.writeFile(targetPath, `Time,Content,Link,Status\n${allLines.join('\n')}`);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ═══════════════════════════════════════════════════════════════════
// 🧠 AI CONTENT GENERATION — professional engine with strict validation
// ═══════════════════════════════════════════════════════════════════

/**
 * Fetch the list of available models from the provider so the user can
 * pick from a dropdown instead of typing model names by hand.
 * Supports OpenAI-compatible (/models), Anthropic (/v1/models) and
 * Gemini (/models?key=) shapes.
 */
ipcMain.handle('list-models', async (event, config) => {
  const { apiKey, baseUrl, providerOverride } = config || {};
  if (!apiKey || !apiKey.trim()) {
    return { success: false, error: 'مفتاح الـ API مطلوب لجلب الموديلات.' };
  }
  if (!baseUrl || !baseUrl.trim()) {
    return { success: false, error: 'Base URL مطلوب لجلب الموديلات.' };
  }

  const provider = contentEngine.detectProvider(baseUrl, providerOverride);
  const trimmedBase = baseUrl.trim().replace(/\/+$/, '');

  let endpoint, headers;
  if (provider === 'anthropic') {
    endpoint = /\/v1\/models$/.test(trimmedBase)
      ? trimmedBase
      : `${trimmedBase.replace(/\/v1\/messages$/, '')}/v1/models`;
    headers = { 'x-api-key': apiKey.trim(), 'anthropic-version': '2023-06-01' };
  } else if (provider === 'gemini') {
    endpoint = `${trimmedBase}/models?key=${encodeURIComponent(apiKey.trim())}`;
    headers = {};
  } else if (provider === 'opencode-go') {
    // OpenCode Go always uses OpenAI-compatible /v1/models for listing
    // (the endpoint lists ALL models regardless of their wire format)
    endpoint = /\/models$/.test(trimmedBase) ? trimmedBase : `${trimmedBase}/models`;
    headers = { 'Authorization': `Bearer ${apiKey.trim()}` };
  } else {
    // OpenAI-compatible
    endpoint = /\/models$/.test(trimmedBase) ? trimmedBase : `${trimmedBase}/models`;
    headers = { 'Authorization': `Bearer ${apiKey.trim()}` };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const resp = await fetch(endpoint, { method: 'GET', headers, signal: controller.signal });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      const errMsg = (status => {
        if (status === 401) return 'مفتاح API غير صحيح';
        if (status === 404) return 'الـ endpoint غير موجود — تحقق من Base URL';
        if (status === 429) return 'تجاوزت الحد المسموح — انتظر قليلاً';
        if (status >= 500 && status < 600) return 'خطأ في السيرفر — حاول مجدداً';
        return 'تعذّر الاتصال — تحقق من الإنترنت';
      })(resp.status);
      return { success: false, error: `${errMsg} (HTTP ${resp.status}: ${t.slice(0, 200)})`, provider };
    }
    const data = await resp.json();

    // Normalize the various response shapes into a flat list of model ids
    let models = [];
    if (Array.isArray(data?.data)) {
      models = data.data.map(m => m.id || m.name).filter(Boolean);          // OpenAI
    } else if (Array.isArray(data?.models)) {
      models = data.models.map(m => (m.name || '').replace(/^models\//, '') || m.id).filter(Boolean); // Gemini
    } else if (Array.isArray(data)) {
      models = data.map(m => m.id || m.name).filter(Boolean);               // Anthropic-ish
    }

    models = [...new Set(models)].sort();
    // Annotate each model with its wire format (for format tag in UI)
    const modelFormats = {};
    for (const m of models) {
      modelFormats[m] = contentEngine.detectApiFormat(provider, m).format;
    }
    return { success: true, provider, models, count: models.length, modelFormats };
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'انتهت المهلة أثناء جلب الموديلات.' : err.message;
    return { success: false, error: msg, provider };
  } finally {
    clearTimeout(timeout);
  }
});


function buildAiRequest(format, { baseUrl, apiKey, model, system, user, messages, maxTokens }) {
  const trimmedBase = (baseUrl || '').replace(/\/+$/, '');

  const convo = Array.isArray(messages) && messages.length
    ? messages
    : [{ role: 'user', content: user }];

  if (format === 'anthropic') {
    const base = trimmedBase || 'https://api.anthropic.com';
    // Build the messages endpoint without doubling path segments. Gateways
    // like IYH expose the base as ".../v1" → naive append gives the broken
    // ".../v1/v1/messages". Strip a trailing /v1 (or existing /v1/messages)
    // before appending the canonical path.
    let endpoint;
    if (/\/v1\/messages$/.test(base)) {
      endpoint = base;
    } else {
      const root = base.replace(/\/v1$/, '');
      endpoint = `${root}/v1/messages`;
    }
    return {
      endpoint,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: {
        model: model || 'claude-3-5-sonnet-20241022',
        max_tokens: maxTokens || 2000,
        temperature: 1.0,
        // Mark the system block as cacheable: Anthropic stores it after the
        // first call and re-serves it cheaply on every subsequent request
        // within the 5-min TTL — so the persistent thread pays the big static
        // prompt only once and reads it from cache every round after.
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: convo,
      },
    };
  }

  if (format === 'gemini') {
    const base = trimmedBase || 'https://generativelanguage.googleapis.com/v1beta';
    const mdl = model || 'gemini-2.0-flash';
    const endpoint = `${base}/models/${mdl}:generateContent?key=${encodeURIComponent(apiKey)}`;
    // Map the OpenAI-style thread to Gemini's contents[] (user|model roles).
    const contents = convo.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content || '') }],
    }));
    return {
      endpoint,
      headers: { 'Content-Type': 'application/json' },
      body: {
        systemInstruction: { parts: [{ text: system }] },
        contents,
        generationConfig: { temperature: 1.0, maxOutputTokens: maxTokens || 2000 },
      },
    };
  }

  // Default: OpenAI-compatible (covers OpenAI, Gemini openai-shim, gateways)
  const base = trimmedBase || 'https://api.openai.com/v1';
  const endpoint = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
  return {
    endpoint,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: {
      model: model || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: system },
        ...convo,
      ],
      max_tokens: maxTokens || 2000,
      temperature: 1.0,
      // Prevent empty responses on some proxy providers (edge case safety).
    },
  };
}

/**
 * Extract the raw text reply from a provider response.
 */
function extractAiText(format, data) {
  try {
    if (format === 'anthropic') {
      return (data.content || []).map(c => c.text || '').join('\n');
    }
    if (format === 'gemini') {
      const parts = data?.candidates?.[0]?.content?.parts || [];
      return parts.map(p => p.text || '').join('\n');
    }
    // OpenAI format
    const message = data?.choices?.[0]?.message;
    const content = message?.content || '';
    // DO NOT read reasoning_content — it's the model's thinking, not the actual output
    return content;
  } catch {
    return '';
  }
}

/**
 * Robustly parse a JSON array of strings out of an LLM reply that may be
 * wrapped in markdown fences or prose.
 */
function parseTweetArray(raw) {
  if (!raw) return [];
  let text = raw.trim();
  // Strip markdown code fences
  text = text.replace(/```(?:json)?/gi, '').trim();
  // Try direct parse first
  try {
    const arr = JSON.parse(text);
    if (Array.isArray(arr)) return arr.filter(x => typeof x === 'string' && x.trim().length > 0);
  } catch { /* fall through */ }
  // Find the first [...] block
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start !== -1 && end !== -1 && end > start) {
    const slice = text.slice(start, end + 1);
    try {
      const arr = JSON.parse(slice);
      if (Array.isArray(arr)) return arr.filter(x => typeof x === 'string' && x.trim().length > 0);
    } catch { /* fall through */ }
  }
  // Last resort: split by newlines, strip bullets/quotes
  return text
    .split('\n')
    .map(l => l.replace(/^[\s\-*\d.)\]]+\s*/, '').replace(/^[""'“]|[""'”]$/g, '').trim())
    .filter(l => l.length > 40 && !/^\d+\s*(char|characters|حرف|chars?)\s*$/i.test(l))
    .filter(l => !/^\d+\s*chars?$/i.test(l));
}

/**
 * One round-trip to the AI: returns { cores, usage, rawText }.
 *   cores   → array of raw core strings (parsed JSON array)
 *   usage   → token accounting incl. cache hits (best-effort, provider-shaped)
 *   rawText → raw assistant reply (for session thread commit)
 *
 * GROWING THREAD (v4.4.0): when a `session` with a `messages` array is
 * provided, the FULL conversation thread is sent each round so the provider
 * can serve the static system prefix from prompt cache. After each successful
 * response the user turn + assistant reply are committed onto the session's
 * `messages` array (capped at 16 entries). This replaces the stateless-flat
 * architecture (v4.3.0) — testing proved Anthropic prompt caching saves
 * 40-60% on input tokens from round 2 onward when the thread grows.
 *
 * Backward-compatible: callers without a session object still work in
 * stateless-flat mode (single user turn, no commit).
 *
 * Fallback: if provider is 'anthropic' and native format fails, retry
 * with OpenAI-compatible format (covers IYH and similar gateways).
 *
 * The system prompt stays byte-for-byte identical across every call so
 * the provider serves it from cache. Per-chunk angles live in the user
 * message only.
 */
async function callAi({ provider, baseUrl, apiKey, model, quantity, angles, inspirationSummary, customSystem, maxTokens, timeoutMs, session, acceptedContext, externalSignal }) {
  // MULTI-FORMAT (v4.5.0): detect wire format from provider + model so
  // gateways like OpenCode Go serve the right protocol per model.
  const { format } = contentEngine.detectApiFormat(provider, model);

  // System block is static for the whole session (cached prefix). Build it
  // from the session if present, else fresh (back-compat one-shot path).
  const system = (session && session.system)
    ? session.system
    : contentEngine.buildSessionSystem({ customSystem: customSystem || '' });

  // This round's user turn (angles + in-session avoid-list + inspiration).
  const user = contentEngine.buildRoundUser({
    quantity,
    angles: angles || contentEngine.selectAngles(quantity),
    inspirationSummary: inspirationSummary || '',
    acceptedContext: acceptedContext || '',
  });

  // GROWING THREAD (v4.4.0): send the FULL conversation so the provider can
  // serve the cached prefix. Start with existing session messages (if any),
  // append this round's user turn. No session = stateless flat (back-compat).
  const thread = (session && Array.isArray(session.messages) && session.messages.length > 0)
    ? session.messages
    : [];
  const messages = [...thread, { role: 'user', content: user }];

  // Build both request variants: native (detected format) + OpenAI fallback.
  const nativeReq = buildAiRequest(format, { baseUrl, apiKey, model, system, messages, maxTokens });
  const openAiReq = buildAiRequest('openai', { baseUrl, apiKey, model, system, messages, maxTokens });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs || 120000);

  // ⚡ C2: Link the external (cancellation) signal so user-initiated stop
  // aborts the in-flight fetch IMMEDIATELY instead of waiting for timeout.
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }
  }

  function readUsage(format, data) {
    const u = data?.usage || {};
    if (format === 'anthropic') {
      return {
        input: u.input_tokens || 0,
        output: u.output_tokens || 0,
        cacheWrite: u.cache_creation_input_tokens || 0,
        cacheRead: u.cache_read_input_tokens || 0,
      };
    }
    if (format === 'gemini') {
      const um = data?.usageMetadata || {};
      return {
        input: um.promptTokenCount || 0,
        output: um.candidatesTokenCount || 0,
        cacheWrite: 0,
        cacheRead: um.cachedContentTokenCount || 0,
      };
    }
    const cached = u.prompt_tokens_details?.cached_tokens || 0;
    return {
      input: u.prompt_tokens || 0,
      output: u.completion_tokens || 0,
      cacheWrite: 0,
      cacheRead: cached,
    };
  }

  async function attempt(req) {
    const response = await fetch(req.endpoint, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      const errMsg = (status => {
        if (status === 401) return 'مفتاح API غير صحيح';
        if (status === 404) return 'الـ endpoint غير موجود — تحقق من Base URL';
        if (status === 429) return 'تجاوزت الحد المسموح — انتظر قليلاً';
        if (status >= 500 && status < 600) return 'خطأ في السيرفر — حاول مجدداً';
        return 'تعذّر الاتصال — تحقق من الإنترنت';
      })(response.status);
      const err = new Error(`${errMsg} (HTTP ${response.status}: ${errText.slice(0, 200)})`);
      err.statusCode = response.status;
      throw err;
    }
    const data = await response.json();
    
    // DEBUG: Log raw response structure
    log.debug(`🔬 Raw response keys: ${JSON.stringify(Object.keys(data || {}))}`);
    if (data?.choices?.[0]) {
      log.debug(`🔬 choices[0] keys: ${JSON.stringify(Object.keys(data.choices[0]))}`);
      log.debug(`🔬 message keys: ${JSON.stringify(Object.keys(data.choices[0].message || {}))}`);
      log.debug(`🔬 content type: ${typeof data.choices[0].message?.content}`);
      log.debug(`🔬 content length: ${data.choices[0].message?.content?.length || 0}`);
      if (data.choices[0].message?.finish_reason) {
        log.debug(`🔬 finish_reason: ${data.choices[0].message?.finish_reason}`);
      }
    }
    
    const rawText = extractAiText(req._formatForExtract || format, data);
    const cores = parseTweetArray(rawText);
    
    log.debug(`📝 AI Response (first 500 chars): ${rawText.substring(0, 500)}`);
    log.debug(`🔍 Parsed cores: ${cores.length} items`);
    if (cores.length === 0 && rawText.length === 0) {
      log.debug(`⚠️  extractAiText returned EMPTY! Raw data sample: ${JSON.stringify(data).substring(0, 500)}`);
    }
    if (cores.length === 0 && rawText.length > 0) {
      log.debug(`⚠️  Parse failed! Raw text sample: ${rawText.substring(0, 200)}`);
    }
    
    return { cores, usage: readUsage(req._formatForExtract || format, data), rawText };
  }

  // Retry wrapper: only retries on 429/5xx/network errors. Max 3 attempts.
  // 401/404/403 are NOT retried (won't fix themselves).
  const MAX_RETRIES = 3;
  async function attemptWithRetry(req) {
    // Redact sensitive query params from logged URL
    function redactUrl(url) {
      try {
        const u = new URL(url);
        const sensitive = ['key', 'token', 'api_key', 'apikey', 'secret'];
        for (const p of sensitive) {
          if (u.searchParams.has(p)) u.searchParams.set(p, '[REDACTED]');
        }
        return u.toString();
      } catch (_) {
        return url;
      }
    }
    log.debug(`🌐 AI Request: ${redactUrl(req.endpoint)} | Model: ${req.body.model} | Format: ${req._formatForExtract || format}`);

    for (let i = 0; i <= MAX_RETRIES; i++) {
      try {
        return await attempt(req);
      } catch (err) {
        const status = err.statusCode;
        const isRetryable = (status === 429 || (status >= 500 && status < 600)) ||
          (err.name === 'AbortError' && i < MAX_RETRIES) ||
          (!status && err.name !== 'AbortError'); // network error (no status code)

        // Never retry AbortError from user cancellation (only from timeout)
        if (err.name === 'AbortError' && aiGenerationCancelled) throw err;

        if (isRetryable && i < MAX_RETRIES) {
          const delay = Math.min(1000 * Math.pow(2, i), 10000);
          const reason = status ? `HTTP ${status}` : (err.name === 'AbortError' ? 'timeout' : 'network error');
          log.debug(`⏳ Retry ${i + 1}/${MAX_RETRIES} in ${delay}ms (${reason}) — ${req.body.model}`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
  }

  try {
    // Attach format hint for response extraction
    nativeReq._formatForExtract = format;
    openAiReq._formatForExtract = 'openai';
    let result;
    try {
      result = await attemptWithRetry(nativeReq);
    } catch (nativeErr) {
      // If native Anthropic format fails, retry with OpenAI-compatible format
      if (format === 'anthropic') {
        try {
          result = await attemptWithRetry(openAiReq);
        } catch (openAiErr) {
          throw new Error(`فشل المزوّد (${provider} + OpenAI fallback): ${nativeErr.message}`);
        }
      } else {
        throw nativeErr;
      }
    }

    // 🧵 C9: GROWING THREAD — commit user turn + assistant reply onto the
    // session's persistent thread so the next round re-serves the cached
    // prefix.  Capped at 16 messages (= 8 rounds × 2 messages) to bound
    // input cost on providers where cache is 0%.  Older turns are dropped
    // so the thread never grows unbounded.
    if (session && Array.isArray(session.messages)) {
      session.messages.push({ role: 'user', content: user });
      session.messages.push({ role: 'assistant', content: result.rawText });
      if (session.messages.length > 16) session.messages = session.messages.slice(-16);
    }
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Generation control IPCs ───────────────────────────────────────────────

// Stop generation: workers check this flag between rounds.
ipcMain.handle('cancel-ai-generation', async () => {
  aiGenerationCancelled = true;
  // ⚡ C1: IMMEDIATE stop — abort all in-flight AI fetches (< 500ms).
  // The AbortError propagates through attempt → callAi → runRound → session
  // and the session loop exits on the next isCancelled() check.
  if (activeAbortController) {
    try { activeAbortController.abort(); } catch { /* best-effort */ }
  }
  return { success: true };
});

// Adjust parallel worker count (applied at next round start).
ipcMain.handle('set-session-count', async (event, count) => {
  const n = Math.max(1, parseInt(count, 10) || 5);
  desiredWorkerCount = n;
  return { success: true, count: n };
});

// Reset: clear cancel flag + ack (no persisted state in new system).
ipcMain.handle('reset-sessions', async () => {
  aiGenerationCancelled = false;
  return { success: true };
});

// ═══════════════════════════════════════════════════════════════════
// 🧠 AI GENERATION — SessionManager (parallel persistent sessions)
// ═══════════════════════════════════════════════════════════════════
//
// Uses SessionManager with GenerationSession pool. Each session has a
// persistent thread (growing, capped at 16 messages) so Anthropic prompt
// caching re-serves the system prefix from round 2 onward. sync() runs
// at each round start to rebuild per-session dedup from the shared queue.
// Cross-session hard guard (sharedExactKeys) prevents intra-round races.

const SHARED_SESSION_FILE = path.join(os.homedir(), '.config', 'x-poster-shared', 'sessions.json');

ipcMain.handle('generate-ai-posts', async (event, config) => {
  const {
    apiKey, baseUrl, model, providerOverride,
    quantity, referralLink, customPrompt, existingTexts, sessionCount,
    // v5.12.0: 'custom' (user's own text, byte-identical to pre-v5.12 behavior)
    // or 'dynamic' (system-built prompt + live burned-angle exclusion).
    // Undefined (old renderer/tests) preserves the exact old implicit binary.
    promptMode,
  } = config || {};

  aiGenerationCancelled = false;
  // ⚡ Fresh AbortController for this generation run — linked to every
  // fetch so cancel-ai-generation can abort all of them instantly.
  activeAbortController = new AbortController();

  // 🟢 Validation: check ALL required fields BEFORE starting any session
  if (!apiKey || !apiKey.trim()) {
    return { success: false, error: 'مفتاح الـ API مطلوب.' };
  }
  if (!baseUrl || !baseUrl.trim()) {
    return { success: false, error: 'Base URL مطلوب — أدخل رابط الـ API في الإعدادات.' };
  }
  if (!model || !model.trim()) {
    return { success: false, error: 'اسم الموديل مطلوب — أدخل اسم الموديل في الإعدادات.' };
  }

  const target   = Math.max(1, parseInt(quantity, 10) || 20);
  const nWorkers = Math.max(1, parseInt(sessionCount, 10) || desiredWorkerCount);
  if (sessionCount) desiredWorkerCount = nWorkers;

  const provider = contentEngine.detectProvider(baseUrl, providerOverride, model);
  const label    = contentEngine.providerLabel(provider, model);
  const link     = (referralLink || '').trim();

  const CHUNK   = 25;    // tweets requested per AI call
  const TIMEOUT = 120000; // 120 s per call (user-approved compromise)

  const isDynamicPrompt = promptMode === 'dynamic';
  // 'let' — the dynamic-mode recompute below (getBurnedIds) reassigns this
  // mid-run so later rounds see fresh exclusion, not round-1's snapshot.
  let inspirationSummary = contentEngine.buildInspirationSummary(10).summaryText;
  const systemBlock = contentEngine.buildSessionSystem({
    customSystem: isDynamicPrompt ? '' : (customPrompt || ''),
  });

  // ── Shared state (shared across all sessions via hard guard) ──────────
  const accepted        = [];
  const rejectedReasons = {};
  let   rejectedCount   = 0;
  let   dupCount        = 0;

  // 🧠 Semantic dedup index — rejects same-MEANING rewrites, not just
  // near-verbatim copies, against the ENTIRE corpus (no recency window):
  // everything ALREADY PUBLISHED + the live queue on disk + the renderer's
  // texts (queue + preview) + every acceptance of this run. IDF weighting keeps
  // shared domain vocabulary (تداول، سوق…) from causing false rejections at any
  // corpus size.
  const semIndex = new SemanticIndex();
  try {
    // Published posts are DELETED from the queue the moment they go out, so the
    // queue alone is no longer the full history — without this archive the
    // corpus would shrink as posts publish and the studio could regenerate a
    // tweet already on X. This is what keeps "no time window" literally true.
    for (const t of await queueManager.getPublishedTexts()) semIndex.add(t);
  } catch { /* archive unreadable — dedup still covers the queue below */ }
  try {
    const diskQueue = await queueManager.getQueue();
    for (const item of (Array.isArray(diskQueue) ? diskQueue : [])) {
      const t = item && typeof item === 'object' ? item.text : item;
      if (typeof t === 'string' && t.trim()) semIndex.add(t);
    }
  } catch { /* queue unreadable — fall back to renderer-provided texts */ }
  for (const t of (Array.isArray(existingTexts) ? existingTexts : [])) {
    if (typeof t === 'string' && t.trim()) semIndex.add(t);
  }

  // Shared queue + preview (cross-session dedup sources — sync() rebuilds from these)
  const sharedQueue = [];
  const sharedPreview = [];

  // 🧠 v5.12.0 DYNAMIC PROMPT MODE — live burned-angle exclusion.
  // Recomputed at most once per 60s, from a call INSIDE the getter itself
  // (not inside runRound): sessionManager.js calls this synchronously right
  // before selectAngles() each round, so the very same round that triggers a
  // recompute already gets the fresh exclusion set, and `inspirationSummary`
  // (read by every subsequent round via runRound → callAi → buildRoundUser)
  // is reassigned in the same synchronous tick — no stale-closure gap.
  // Only active in dynamic mode; custom-prompt-mode runs get the no-op
  // default from SessionManager (empty Set every round, zero overhead).
  let burnedIds = new Set();
  let lastBurnedRecalcAt = 0;
  const getBurnedIds = () => {
    if (!isDynamicPrompt) return burnedIds; // always empty — no-op path
    const now = Date.now();
    if (now - lastBurnedRecalcAt < 60000) return burnedIds;
    lastBurnedRecalcAt = now;
    // Capped recent slice only — sharedQueue is append-only and can reach
    // tens of thousands of entries in long runs (see syncSessionDedup's
    // incremental-cursor comment above for why an unbounded rescan here
    // would reintroduce the same class of freeze at scale).
    const liveTexts = sharedQueue.slice(-150).map(x => x.text);
    const result = contentEngine.buildInspirationSummary(12, liveTexts);
    burnedIds = result.burnedIds;
    inspirationSummary = result.summaryText;
    return burnedIds;
  };

  // ── Emit helpers ──────────────────────────────────────────────────────────
  const emit = (ch, payload) => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, payload);
    } catch { /* best-effort */ }
  };

  const liveStats = () => ({
    accepted: accepted.length, target,
    rounds: 0, rejected: rejectedCount, duplicates: dupCount,
    tokensIn: 0, tokensOut: 0, cacheHitPct: 0,
  });

  const sendProgress = (type, message, rounds = 0, cacheHitPct = 0) =>
    emit('ai-progress', { type, message, ...liveStats(), rounds, cacheHitPct });

  // ── Ingest: validates + deduplicates one batch ─────────────────────────────
  // Has TWO dedup layers:
  //   1. Per-session: checks against session.exactKeys/tokenSets (built by sync())
  //   2. Cross-session hard guard: checks against sharedExactKeys/tokenSets
  //      (prevents race where 2 sessions accept the same post in the same round)
  const ingest = (cores, session) => {
    if (!Array.isArray(cores)) {
      log.debug(`⚠️  Ingest: cores is not an array: ${typeof cores}`);
      return 0;
    }
    
    // DEBUG: Log ingest call
    log.debug(`📥 Ingest called with ${cores.length} cores`);
    if (cores.length === 0) {
      log.debug(`⚠️  Ingest: EMPTY cores array!`);
    }
    
    let gained = 0;
    const batchAccepted = [];  // history is written ONCE per batch, not per tweet
    for (const core of cores) {
      if (accepted.length >= target || aiGenerationCancelled) break;

      // 1. Clean AI output artifacts
      const cleaned = contentEngine.cleanCoreText(String(core || '').trim());
      if (!cleaned) {
        rejectedCount++;
        rejectedReasons['فارغ بعد التنظيف'] = (rejectedReasons['فارغ بعد التنظيف'] || 0) + 1;
        log.debug(`❌ Ingest: فارغ بعد التنظيف`);
        continue;
      }

      // 2. Assemble: core + link + hashtags → fits [MIN_LEN, MAX_LEN]
      const assembled = contentEngine.assembleTweet(cleaned, link);
      if (!assembled) {
        rejectedCount++;
        const cLen = contentEngine.tweetLength(cleaned);
        const key  = `طول لا يصلح للتجميع (core=${cLen}ch)`;
        rejectedReasons[key] = (rejectedReasons[key] || 0) + 1;
        log.debug(`❌ Ingest: ${key}`);
        continue;
      }

      // 3. Quality + cleanliness gate
      const verdict = contentEngine.validateTweet(assembled.text, link);
      if (!verdict.valid) {
        rejectedCount++;
        rejectedReasons[verdict.reason] = (rejectedReasons[verdict.reason] || 0) + 1;
        log.debug(`❌ Ingest: ${verdict.reason}`);
        continue;
      }

      // 4. Semantic hard guard — one global check against EVERYTHING:
      //    queue + preview + every acceptance of this run, exact AND
      //    same-meaning-different-wording, unbounded by any window.
      const sem = semIndex.check(assembled.text);
      if (sem.dup) {
        rejectedCount++; dupCount++;
        const r = sem.level === 1 ? 'مكرر (مطابقة حرفية)'
          : sem.level === 2 ? 'مكرر بالمعنى (إعادة صياغة لفكرة موجودة)'
          : 'مكرر بالمعنى (نفس الفكرة بكلمات أخرى)';
        rejectedReasons[r] = (rejectedReasons[r] || 0) + 1;
        log.debug(`❌ Ingest: ${r} (score=${sem.score})`);
        continue;
      }
      // ✅ ACCEPT
      accepted.push({ text: assembled.text, length: assembled.length });

      // Per-session context (avoid-list for the next round's prompt).
      // Only the last 60 are ever used (context + persist) — cap the live
      // array; acceptedCount keeps the true total for the UI snapshot.
      session.acceptedBodies.push(contentEngine.bodyOnly(assembled.text));
      if (session.acceptedBodies.length > 120) {
        session.acceptedBodies.splice(0, session.acceptedBodies.length - 60);
      }
      session.acceptedCount = (session.acceptedCount || 0) + 1;

      // Update the global semantic index — this acceptance immediately
      // blocks every future same-meaning candidate from ANY session.
      semIndex.add(assembled.text);
      sharedQueue.push({ text: assembled.text });
      batchAccepted.push(assembled.text);

      emit('ai-post-accepted', {
        text: assembled.text, length: assembled.length,
        index: accepted.length, target,
      });
      gained++;
    }
    if (batchAccepted.length) {
      try { contentEngine.appendHistory(batchAccepted); } catch { /* best-effort */ }
    }
    return gained;
  };

  // ── RunRound: wraps callAi for SessionManager ─────────────────────────────
  const runRound = async ({ session, angles, acceptedContext, inspirationSummary: _, chunk }) => {
    try {
      const result = await callAi({
        provider, baseUrl, apiKey, model,
        quantity: chunk || CHUNK, angles,
        inspirationSummary,
        customSystem: customPrompt,
        maxTokens: Math.min((chunk || CHUNK) * 400, 8192),  // cap at 8k
        timeoutMs: TIMEOUT,
        session,  // GenerationSession with growing messages
        acceptedContext,
        externalSignal: activeAbortController ? activeAbortController.signal : null,  // ⚡ C1: immediate stop
      });
      
      // DEBUG: Log runRound result
      log.debug(`🎯 RunRound result: ${result.cores?.length || 0} cores, usage: ${JSON.stringify(result.usage || {})}`);
    
      return { cores: result.cores || [], usage: result.usage || {} };
    } catch (err) {
      // ⚡ C1: Graceful exit when user cancels — AbortError is expected, not a bug.
      if (err.name === 'AbortError' && aiGenerationCancelled) {
        log.debug('⏹️ RunRound aborted by user cancellation — returning empty.');
        return { cores: [], usage: {} };
      }
      // Provide better error message for common issues
      if (err.message === 'provider is not defined') {
        throw new Error(`خطأ في إعدادات المزود — تأكد من صحة Base URL والموديل`);
      }
      log.error(`❌ RunRound error: ${err.message}`);
      throw err;
    }
  };

  // ── OnStatus: forward to UI ───────────────────────────────────────────────
  const onStatus = (snapshots, totals) => {
    // Emit per-session status for the AI Studio UI (pills only — one source of truth)
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('ai-session-status', { sessions: snapshots, totals });
      }
    } catch { /* best-effort */ }
  };

  // ── Persistence callback — saves session snapshots for prompt cache continuity ──
  const SHARED_SESSION_FILE = path.join(os.homedir(), '.config', 'x-poster-shared', 'sessions.json');
  const persist = async (sessionSnapshots) => {
    try {
      await fs.mkdir(path.dirname(SHARED_SESSION_FILE), { recursive: true });
      // Atomic write (tmp + rename): a crash mid-write can never leave a
      // half-written sessions.json. Compact JSON — with large pools the
      // pretty-printed snapshot grows to many MB for no benefit.
      const tmp = SHARED_SESSION_FILE + '.tmp';
      await fs.writeFile(tmp, JSON.stringify(sessionSnapshots), 'utf8');
      await fs.rename(tmp, SHARED_SESSION_FILE);
    } catch { /* best-effort — never crash the run over a persist failure */ }
  };

  // Load sessions from last run for prompt cache continuity
  let loadedSessions = [];
  try {
    const raw = await fs.readFile(SHARED_SESSION_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) loadedSessions = parsed;
  } catch { /* no saved sessions — start fresh */ }

  // ── Create + run SessionManager ───────────────────────────────────────────
  const manager = new SessionManager({
    engine: contentEngine,
    runRound,
    ingest,
    onStatus,
    isCancelled: () => aiGenerationCancelled,
    getSessionCount: () => desiredWorkerCount,
    getBurnedIds,
    persist,
    chunk: CHUNK,
    sessionCount: nWorkers,
    system: systemBlock,
    inspirationSummary,
    sharedQueue,
    sharedPreview,
  });

  if (Array.isArray(loadedSessions) && loadedSessions.length > 0) {
    manager.loadSessions(loadedSessions);
  }

  try {
    sendProgress('info',
      `🚀 بدء التوليد: ${nWorkers} جلسة متوازية · هدف ${target} تغريدة (${label})`
    );

    await manager.run(() => accepted.length >= target);

    const totals = manager.totals();
    const finalBreakdown = Object.entries(rejectedReasons)
      .map(([k, v]) => `${k}:${v}`).join(' | ') || 'لا شيء';
    sendProgress(
      accepted.length >= target ? 'success' : 'info',
      `اكتمل: ${accepted.length}/${target} مقبول · ${rejectedCount} مرفوض [${finalBreakdown}]`,
      totals.rounds, totals.cacheHitPct
    );

    return {
      success: true, provider, label,
      posts:   accepted.map(a => a.text),
      details: accepted,
      count:   accepted.length,
      requested: target,
      rounds: totals.rounds,
      waves:  totals.rounds,
      cancelled: aiGenerationCancelled,
      rejectedCount,
      duplicates: dupCount,
      rejectedReasons,
      usage: totals,
    };
  } catch (error) {
    return { success: false, error: error.message, provider, label };
  } finally {
    aiGenerationCancelled = false;
    activeAbortController = null;
  }
});
