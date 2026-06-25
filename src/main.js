const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
app.disableHardwareAcceleration();
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const fs_sync = require('fs');
const { createReadStream } = require('fs');
const csv = require('csv-parser');
const contentEngine = require('./automation/contentEngine');
const { SessionManager } = require('./automation/sessionManager');

// 🔒 Security modules
const { runAudit, printReport } = require('./security/auditor');

// 2. LINUX SURVIVAL & BROWSER ARCHITECTURE (CRITICAL)
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-setuid-sandbox');

let mainWindow;
let loginContext = null;
// Cooperative cancellation flag for AI generation. The renderer sets it via
// the 'cancel-ai-generation' IPC; the generation loop checks it between waves
// and stops early, keeping everything accepted so far.
let aiGenerationCancelled = false;
// Live, user-adjustable parallel-session count. The renderer can change this
// mid-run via 'set-session-count'; SessionManager reads it BETWEEN rounds only
// (golden rule: never mid-round). Default 5 (replaces old CONCURRENCY).
let desiredSessionCount = 5;
const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');
// Persisted session snapshots for cross-restart resume (spec: sessions are
// not reset on app close; they resume with the same numbers).
const SESSIONS_FILE = path.join(app.getPath('userData'), 'generation_sessions.json');

function loadPersistedSessions() {
  try {
    const raw = fs_sync.readFileSync(SESSIONS_FILE, 'utf8');
    const obj = JSON.parse(raw);
    return Array.isArray(obj.sessions) ? obj.sessions : [];
  } catch { return []; }
}

function savePersistedSessions(snapshots) {
  try {
    fs_sync.writeFileSync(SESSIONS_FILE, JSON.stringify({ sessions: snapshots, ts: Date.now() }, null, 0), 'utf8');
  } catch (e) { /* best-effort */ }
}

function clearPersistedSessions() {
  try { fs_sync.unlinkSync(SESSIONS_FILE); } catch { /* best-effort */ }
}

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
const rateLimitStore = require('./automation/rateLimitStore');
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
    // Multi-profile mode: when config.profiles (array) is provided, the
    // orchestrator runs each profile, advances on rate limit, skips cooldowns.
    // Single-profile mode (config.profile) still works for backward compat.
    const hasMulti = Array.isArray(config.profiles) && config.profiles.length > 0;
    if (hasMulti) {
      const { results, summary } = await xPoster.startMulti(config, (status) => {
        mainWindow.webContents.send('status-update', status);
      });
      return { success: true, results, summary };
    }
    const res = await xPoster.start(config, (status) => {
      mainWindow.webContents.send('status-update', status);
    });
    return { success: true, result: res };
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
    const safeName = profileName.trim().replace(/[/<>:"\\|?*]/g, '');
    if (!safeName) return { success: false, error: 'اسم البروفايل غير صالح' };
    const profilePath = path.resolve(PROFILES_DIR, safeName);
    if (!profilePath.startsWith(path.resolve(PROFILES_DIR) + path.sep)) {
      return { success: false, error: 'مسار غير مسموح' };
    }
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
    const safeOld = oldName.trim().replace(/[/<>:"\\|?*]/g, '');
    const safeName = newName.trim().replace(/[/<>:"\\|?*]/g, '');
    if (!safeOld || !safeName) return { success: false, error: 'الاسم غير صالح' };
    const profilesBase = path.resolve(PROFILES_DIR) + path.sep;
    const oldPath = path.resolve(PROFILES_DIR, safeOld);
    const newPath = path.resolve(PROFILES_DIR, safeName);
    if (!oldPath.startsWith(profilesBase) || !newPath.startsWith(profilesBase)) {
      return { success: false, error: 'مسار غير مسموح' };
    }
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
      return { success: false, error: `HTTP ${resp.status}: ${t.slice(0, 200)}`, provider };
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
    return { success: true, provider, models, count: models.length };
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'انتهت المهلة أثناء جلب الموديلات.' : err.message;
    return { success: false, error: msg, provider };
  } finally {
    clearTimeout(timeout);
  }
});


function buildAiRequest(provider, { baseUrl, apiKey, model, system, user, messages, maxTokens }) {
  const trimmedBase = (baseUrl || '').replace(/\/+$/, '');

  // Caller passes a `messages` array. Under the stateless-flat design (v4.3.0)
  // this is a single-element array: [{ role:'user', content: thisRoundUser }].
  // The legacy single-`user` path is kept as a fallback for non-session callers.
  // The system block keeps its cache_control hint: harmless on gateways that
  // ignore it (IYH), and a free 90% win the moment a direct provider is used.
  const convo = Array.isArray(messages) && messages.length
    ? messages
    : [{ role: 'user', content: user }];

  if (provider === 'anthropic') {
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
        // Send BOTH auth styles: real Anthropic reads x-api-key, while most
        // gateways that proxy Claude (IYH, etc.) expect Authorization: Bearer.
        // Sending both is harmless and makes the native route work anywhere.
        'x-api-key': apiKey,
        'Authorization': `Bearer ${apiKey}`,
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

  if (provider === 'gemini') {
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
    },
  };
}

/**
 * Extract the raw text reply from a provider response.
 */
function extractAiText(provider, data) {
  try {
    if (provider === 'anthropic') {
      return (data.content || []).map(c => c.text || '').join('\n');
    }
    if (provider === 'gemini') {
      const parts = data?.candidates?.[0]?.content?.parts || [];
      return parts.map(p => p.text || '').join('\n');
    }
    // openai-compatible
    return data?.choices?.[0]?.message?.content || '';
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
 * One round-trip to the AI: returns { cores, usage }.
 *   cores → array of raw core strings (parsed JSON array)
 *   usage → token accounting incl. cache hits (best-effort, provider-shaped)
 * Fallback: if provider is 'anthropic' and native format fails, retry
 * with OpenAI-compatible format (covers IYH and similar gateways).
 *
 * Keeping the system prompt byte-for-byte identical across every call is
 * what lets the provider serve it from cache, so we DON'T fold per-chunk
 * angles into the system block — angles go in the user message only.
 */
async function callAi({ provider, baseUrl, apiKey, model, quantity, angles, inspirationSummary, customSystem, maxTokens, timeoutMs, session, acceptedContext }) {
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

  // STATELESS FLAT (v4.3.0): every round sends ONLY the static system block +
  // this round's single user turn. We do NOT carry a growing message thread.
  //
  // WHY: the growing-thread design existed solely to feed prompt-caching (re-
  // serve the cached prefix each round). Live testing proved IYH strips/ignores
  // cache_control for Claude and reports zero usage for GPT/Gemini — cache hit
  // = 0% on every model. A growing thread with 0% cache is pure cost inflation
  // (round 6 ballooned to ~3,600 input tokens vs ~1,400 flat = +77% waste).
  //
  // Dedup is UNAFFECTED: 0%-duplicate guarantee comes from (a) `acceptedContext`
  // — a compact accepted-titles digest injected into THIS user message, built
  // from session.acceptedBodies (not the thread) — and (b) the shared
  // exactKeys/tokenSets server-side guard. Neither depends on session.messages.
  const messages = [{ role: 'user', content: user }];

  // Build both request variants: native (per provider) + OpenAI fallback.
  const nativeReq = buildAiRequest(provider, { baseUrl, apiKey, model, system, messages, maxTokens });
  const openAiReq = buildAiRequest('openai', { baseUrl, apiKey, model, system, messages, maxTokens });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs || 120000);

  function readUsage(prov, data) {
    // Normalize token usage across the 3 protocols, surfacing cache hits.
    const u = data?.usage || {};
    if (prov === 'anthropic') {
      return {
        input: u.input_tokens || 0,
        output: u.output_tokens || 0,
        cacheWrite: u.cache_creation_input_tokens || 0,
        cacheRead: u.cache_read_input_tokens || 0,
      };
    }
    // openai-compatible (IYH/anmix/etc.) — cached_tokens lives in prompt details
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
      throw new Error(`HTTP ${response.status}: ${errText.slice(0, 300)}`);
    }
    const data = await response.json();
    const rawText = extractAiText(req._providerForExtract || provider, data);
    return { cores: parseTweetArray(rawText), usage: readUsage(req._providerForExtract || provider, data), rawText };
  }

  try {
    // Attach provider hint for response extraction
    nativeReq._providerForExtract = provider;
    openAiReq._providerForExtract = 'openai';
    let result;
    try {
      result = await attempt(nativeReq);
    } catch (nativeErr) {
      // If native Anthropic format fails, retry with OpenAI-compatible format
      if (provider === 'anthropic') {
        try {
          result = await attempt(openAiReq);
        } catch (openAiErr) {
          throw new Error(`فشل المزوّد (${provider} + OpenAI fallback): ${nativeErr.message}`);
        }
      } else {
        throw nativeErr;
      }
    }

    // STATELESS FLAT (v4.3.0): we deliberately do NOT push the user turn or the
    // assistant reply onto session.messages — there is no growing thread. The
    // session still tracks acceptedBodies/exactKeys/tokenSets (updated in
    // ingest()), which is everything dedup + acceptedContext steering need.
    // Keeping session.messages empty means every round sends a flat ~1,400-token
    // prompt instead of a thread that balloons to 3,600+ with 0% cache benefit.
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

// Renderer calls this when the user clicks "إيقاف التوليد". The running
// SessionManager checks the flag between rounds and stops gracefully,
// keeping everything accepted up to that point.
ipcMain.handle('cancel-ai-generation', async () => {
  aiGenerationCancelled = true;
  return { success: true };
});

// Live session-count control (G: رفع/خفض عدد الجلسات يعمل فوراً بدون إعادة
// تشغيل). SessionManager reads desiredSessionCount between rounds only.
ipcMain.handle('set-session-count', async (event, count) => {
  const n = Math.max(1, parseInt(count) || 5);
  desiredSessionCount = n;
  return { success: true, count: n };
});

// Manual session reset (spec: "زر إعادة تعيين الجلسات"). Wipes the persisted
// thread/state so the next run starts Session #1.. fresh.
ipcMain.handle('reset-sessions', async () => {
  clearPersistedSessions();
  return { success: true };
});

ipcMain.handle('generate-ai-posts', async (event, config) => {
  const {
    apiKey,
    baseUrl,
    model,
    providerOverride,   // 'auto' | 'openai' | 'anthropic' | 'gemini'
    quantity,
    referralLink,
    customPrompt,       // optional user-supplied system prompt (G4)
    existingTexts,      // texts already in the queue+preview (G3 dedup scope)
    sessionCount,       // desired parallel persistent sessions (default 5)
  } = config || {};

  // Fresh run → clear any stale cancel request.
  aiGenerationCancelled = false;

  if (!apiKey || !apiKey.trim()) {
    return { success: false, error: 'مفتاح الـ API مطلوب (API Key).' };
  }

  // G1.1: open-ended count, user-defined, NO hardcoded ceiling.
  const target = parseInt(quantity) || 10;
  if (target < 1) return { success: false, error: 'العدد يجب أن يكون 1 على الأقل.' };
  if (sessionCount) desiredSessionCount = Math.max(1, parseInt(sessionCount) || 5);

  const provider = contentEngine.detectProvider(baseUrl, providerOverride, model);
  const label = contentEngine.providerLabel(provider, model);
  const link = (referralLink || '').trim();

  // ── SHARED dedup sources (G3): the live queue + preview. Every session
  // syncs against these at each round start so cross-session duplicates are
  // caught. Cross-session HISTORY is never used to reject (G1.5).
  const sharedQueue = [];     // grows as posts are accepted this run
  const sharedPreview = [];   // seeded from existing queue+preview texts
  if (Array.isArray(existingTexts)) {
    for (const t of existingTexts) {
      if (typeof t === 'string' && t.trim()) sharedPreview.push({ text: t });
    }
  }

  // ── G1.5 INSPIRATION (not a filter): short THEME summary of past sessions.
  const inspirationSummary = contentEngine.buildInspirationSummary(10);

  // The static system block — identical for every session this run, so the
  // provider caches it once and re-serves it from round 2 onward.
  const systemBlock = contentEngine.buildSessionSystem({ customSystem: customPrompt || '' });

  const accepted = [];
  const rejectedReasons = {};
  let rejectedCount = 0;
  let dupCount = 0;

  // ── HARD cross-session dedup guard (0% duplicates, spec acceptance) ──────
  // sync() runs only between rounds, so two sessions in the SAME round both
  // start from the same synced state and could accept an identical core in
  // parallel. ingest() has no `await` in its accept loop, so a SHARED set
  // checked+updated synchronously here is a hard guarantee: whichever session
  // ingests a given core first wins; the other sees it as a duplicate. This
  // is the safety net on top of per-session sync().
  const sharedExactKeys = new Set();
  const sharedTokenSets = [];
  if (Array.isArray(existingTexts)) {
    for (const t of existingTexts) {
      if (typeof t === 'string' && t.trim()) {
        sharedExactKeys.add(contentEngine.exactKey(t));
        sharedTokenSets.push(contentEngine.tokenize(contentEngine.bodyOnly(t)));
      }
    }
  }

  const PER_CALL_TIMEOUT = 120000; // 120s ceiling per round (Opus-class models are slow)
  const CHUNK = 10;                // tweets requested per round per session

  const sendProgress = (msg) => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('ai-progress', msg);
      }
    } catch { /* best-effort */ }
  };

  // Aggregate token totals across all sessions (filled from manager.totals()).
  let lastTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, rounds: 0, cacheHitPct: 0 };

  // Live stats payload (G1.6) attached to every progress event.
  const stats = () => ({
    accepted: accepted.length,
    target,
    rounds: lastTotals.rounds,
    rejected: rejectedCount,
    duplicates: dupCount,
    tokensIn: lastTotals.input + lastTotals.cacheRead + lastTotals.cacheWrite,
    tokensOut: lastTotals.output,
    cacheHitPct: lastTotals.cacheHitPct,
  });

  // Accept-pipeline for one round's worth of raw cores from a given session.
  // Mutates `accepted`, the shared queue, and the session's accepted bodies.
  // Each newly-accepted tweet is emitted IMMEDIATELY to the renderer (G4.1).
  const ingest = (cores, session) => {
    let gained = 0;
    if (!cores) return gained;
    for (const core of cores) {
      if (accepted.length >= target) break;
      if (aiGenerationCancelled) break;
      const cleanedCore = contentEngine.cleanCoreText(String(core || '').trim());
      if (!cleanedCore) { rejectedCount++; rejectedReasons['فارغ بعد التنظيف'] = (rejectedReasons['فارغ بعد التنظيف'] || 0) + 1; continue; }

      const assembled = contentEngine.assembleTweet(cleanedCore, link);
      if (!assembled) {
        rejectedCount++;
        rejectedReasons['تعذّر ضبط الطول (≤270)'] = (rejectedReasons['تعذّر ضبط الطول (≤270)'] || 0) + 1;
        continue;
      }

      // G2 structural + cleanliness gate.
      const verdict = contentEngine.validateTweet(assembled.text, link);
      if (!verdict.valid) {
        rejectedCount++;
        rejectedReasons[verdict.reason] = (rejectedReasons[verdict.reason] || 0) + 1;
        continue;
      }

      // G3 dedup — against THIS session's synced state (queue+preview+others).
      const dup = contentEngine.isDuplicateInSession(assembled.text, session, 0.85);
      if (dup.dup) {
        rejectedCount++;
        dupCount++;
        const reason = dup.level === 1 ? 'مكرر (مطابقة دقيقة)' : 'مكرر (تشابه دلالي >85%)';
        rejectedReasons[reason] = (rejectedReasons[reason] || 0) + 1;
        continue;
      }

      // HARD cross-session guard — synchronous check against the shared set so
      // two sessions in the SAME round can't both accept an identical core.
      const sharedDup = contentEngine.isDuplicateInSession(
        assembled.text,
        { exactKeys: sharedExactKeys, tokenSets: sharedTokenSets },
        0.85,
      );
      if (sharedDup.dup) {
        rejectedCount++;
        dupCount++;
        const reason = sharedDup.level === 1 ? 'مكرر (مطابقة دقيقة)' : 'مكرر (تشابه دلالي >85%)';
        rejectedReasons[reason] = (rejectedReasons[reason] || 0) + 1;
        continue;
      }

      // Accept → push to shared queue immediately so OTHER sessions see it on
      // their next sync(). Also update THIS session's live dedup state + the
      // shared guard so it won't repeat within the same round.
      accepted.push({ text: assembled.text, length: assembled.length });
      sharedQueue.push({ text: assembled.text });
      const eKey = contentEngine.exactKey(assembled.text);
      const bodyToks = contentEngine.tokenize(contentEngine.bodyOnly(assembled.text));
      session.exactKeys.add(eKey);
      session.tokenSets.push(bodyToks);
      session.acceptedBodies.push(contentEngine.bodyOnly(assembled.text));
      sharedExactKeys.add(eKey);
      sharedTokenSets.push(bodyToks);
      gained++;

      // G1.5: persist to cross-session history for FUTURE inspiration only.
      try { contentEngine.appendHistory([assembled.text]); } catch { /* best-effort */ }

      // G4.1: live preview — push this single accepted tweet to the renderer now.
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('ai-post-accepted', {
            text: assembled.text,
            length: assembled.length,
            index: accepted.length,
            target,
            session: session.num,
          });
        }
      } catch { /* best-effort */ }
    }
    return gained;
  };

  // One AI round — stateless flat (v4.3.0): callAi sends a fresh 2-message
  // request each round; no persistent thread, no growing token cost.
  const runRound = async ({ session, angles, acceptedContext }) => {
    const { cores, usage } = await callAi({
      provider, baseUrl, apiKey, model,
      quantity: CHUNK, angles,
      inspirationSummary,
      maxTokens: 2500, timeoutMs: PER_CALL_TIMEOUT,
      session, acceptedContext,
    });
    return { cores, usage };
  };

  // Status emitter for per-session indicators (🟢🟡🔴) + live cache %.
  const onStatus = (sessionsSnapshot, totals) => {
    lastTotals = totals;
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('ai-session-status', {
          sessions: sessionsSnapshot,
          totals,
          accepted: accepted.length,
          target,
        });
      }
    } catch { /* best-effort */ }
    sendProgress({
      type: 'info',
      message: `جلسات نشطة: ${sessionsSnapshot.filter(s => s.status === 'running').length} • مقبول ${accepted.length}/${target} • كاش ${totals.cacheHitPct}%`,
      ...stats(),
    });
  };

  try {
    const manager = new SessionManager({
      engine: contentEngine,
      runRound,
      ingest,
      onStatus,
      isCancelled: () => aiGenerationCancelled,
      getSessionCount: () => desiredSessionCount,
      persist: savePersistedSessions,
      chunk: CHUNK,
      sessionCount: desiredSessionCount,
      system: systemBlock,
      inspirationSummary,
      sharedQueue,
      sharedPreview,
    });

    // Resume persisted sessions if any exist (spec: sessions are not reset on
    // app close). They keep their numbers; the cached prefix re-warms quickly.
    const persisted = loadPersistedSessions();
    if (persisted.length) manager.loadSessions(persisted);

    sendProgress({ type: 'info', message: `انطلاق ${desiredSessionCount} جلسة دائمة متوازية (${label})…`, ...stats() });

    // Run until target met OR cancelled. SessionManager never auto-stops.
    await manager.run(() => accepted.length >= target);

    const totals = manager.totals();
    lastTotals = totals;

    return {
      success: true,
      provider,
      label,
      posts: accepted.map(a => a.text),
      details: accepted,
      count: accepted.length,
      requested: target,
      rounds: totals.rounds,
      waves: totals.rounds,
      sessions: manager.statusSnapshot(),
      sessionCount: desiredSessionCount,
      cancelled: aiGenerationCancelled,
      rejectedCount,
      duplicates: dupCount,
      rejectedReasons,
      usage: {
        input: totals.input,
        output: totals.output,
        cacheRead: totals.cacheRead,
        cacheWrite: totals.cacheWrite,
        calls: totals.calls,
        cacheHitPct: totals.cacheHitPct,
      },
    };
  } catch (error) {
    return { success: false, error: error.message, provider, label };
  } finally {
    aiGenerationCancelled = false;
  }
});
