const { contextBridge, ipcRenderer } = require('electron');

/**
 * Resolved BEFORE the renderer's own scripts run, so the sidebar paints the
 * version with the rest of the shell rather than popping in a frame later.
 * sendSync is the point: an async invoke() would resolve after first paint.
 *
 * This exists because the app previously showed its version NOWHERE — with
 * several builds sharing a download folder, "which version am I actually
 * running?" was unanswerable from the app itself, and an old build looked
 * exactly like a fixed one.
 */
const appVersion = ipcRenderer.sendSync('get-app-version');

contextBridge.exposeInMainWorld('appInfo', { version: appVersion });

// Expose protected APIs to renderer
contextBridge.exposeInMainWorld('api', {
  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  // File dialogs
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  selectCSV: () => ipcRenderer.invoke('select-csv'),
  selectSaveCSV: () => ipcRenderer.invoke('select-save-csv'),

  // CSV parsing
  parseCSV: (filePath) => ipcRenderer.invoke('parse-csv', filePath),

  // System
  openFolder: (folderPath) => ipcRenderer.send('open-folder', folderPath),

  // Queue operations
  getQueue: (profileName) => ipcRenderer.invoke('get-queue', profileName),
  // The queue screen's view: durable id + revision per row, plus the state and
  // countdown that explain why a row is not going out. See main's
  // 'get-queue-view'.
  getQueueView: () => ipcRenderer.invoke('get-queue-view'),
  addPosts: (posts, profileName) => ipcRenderer.invoke('add-posts', posts, profileName),
  // Takes [{ id, expectedRevision }] — the durable identity of each row the
  // renderer drew. Not an index (stale the moment publishing consumes a post)
  // and not a text (two rows may share one, so deleting "the post that says X"
  // removed both when one was selected). See durableQueue.bulkDeleteByIds.
  bulkDelete: (descriptors) => ipcRenderer.invoke('bulk-delete', descriptors),
  getRecoveryItems: (profileName) => ipcRenderer.invoke('get-recovery-items', profileName),
  // All three take { id, kind, expectedRevision } for the same reason: the
  // operator's click must name the row they were looking at, and `revision`
  // makes a click on a stale list refuse instead of applying to whatever the
  // row has become.
  //
  // `options.confirmedNotPublished` is REQUIRED to requeue a 'pending' item:
  // it crossed the irreversible boundary, so requeueing it without the user
  // verifying on X would publish it twice.
  requeueRecoveryItem: (target, options) =>
    ipcRenderer.invoke('requeue-recovery-item', target, options),
  confirmRecoveryPublished: (target, proof) =>
    ipcRenderer.invoke('confirm-recovery-published', target, proof),
  discardRecoveryItem: (target) => ipcRenderer.invoke('discard-recovery-item', target),
  workflowHealth: (options) => ipcRenderer.invoke('workflow-health', options),
  workflowBackup: () => ipcRenderer.invoke('workflow-backup'),

  // Automation control
  startPosting: (config) => ipcRenderer.invoke('start-posting', config),
  stopAutomation: () => ipcRenderer.send('stop-automation'),
  openProfileForLogin: (profileName) => ipcRenderer.invoke('open-profile-for-login', profileName),
  getProfiles: () => ipcRenderer.invoke('get-profiles'),
  createProfile: (name) => ipcRenderer.invoke('create-profile', name),
  deleteProfile: (name) => ipcRenderer.invoke('delete-profile', name),
  renameProfile: (oldName, newName) => ipcRenderer.invoke('rename-profile', oldName, newName),

  // 🧠 AI Content Generation
  listModels: (config) => ipcRenderer.invoke('list-models', config),
  generateAiPosts: (config) => ipcRenderer.invoke('generate-ai-posts', config),
  cancelAiGeneration: () => ipcRenderer.invoke('cancel-ai-generation'),
  // 🔍 Provider detection — single source of truth in main.js (no renderer mirror)
  detectProvider: (config) => ipcRenderer.invoke('detect-provider', config),
  // 🔄 Persistent parallel sessions
  setSessionCount: (count) => ipcRenderer.invoke('set-session-count', count),
  resetSessions: () => ipcRenderer.invoke('reset-sessions'),
  onAiProgress: (callback) => {
    const listener = (event, msg) => callback(msg);
    ipcRenderer.on('ai-progress', listener);
    return () => ipcRenderer.removeListener('ai-progress', listener);
  },
  // Live: fires once per accepted tweet so the preview fills in as it goes.
  onAiPostAccepted: (callback) => {
    const listener = (event, post) => callback(post);
    ipcRenderer.on('ai-post-accepted', listener);
    return () => ipcRenderer.removeListener('ai-post-accepted', listener);
  },
  // Live: per-session status (🟢🟡🔴) + aggregate cache % between rounds.
  onAiSessionStatus: (callback) => {
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on('ai-session-status', listener);
    return () => ipcRenderer.removeListener('ai-session-status', listener);
  },
  
  // Export features
  exportQueue: (filePath, profileName) => ipcRenderer.invoke('export-queue', filePath, profileName),
  getLogs: () => ipcRenderer.invoke('get-logs'),
  readLog: (logName) => ipcRenderer.invoke('read-log', logName),
  // `exportLogsToCsv` was removed. It invoked 'export-logs-to-csv', for which no
  // handler has ever been registered, so every call could only reject with
  // "No handler registered". A bridge entry that cannot succeed is not a
  // feature waiting to be wired up — it is a surface that lies about what the
  // app can do, and the next reader has to prove the negative to find out.

  // Security
  runAudit: () => ipcRenderer.invoke('run-audit'),

  // ⏳ Rate-limit cooldowns
  getCooldowns: () => ipcRenderer.invoke('get-cooldowns'),
  getCooldown: (profileName) => ipcRenderer.invoke('get-cooldown', profileName),
  clearCooldown: (profileName) => ipcRenderer.invoke('clear-cooldown', profileName),

  // Status updates (listener)
  onStatusUpdate: (callback) => {
    const listener = (event, status) => callback(status);
    ipcRenderer.on('status-update', listener);
    return () => ipcRenderer.removeListener('status-update', listener);
  },
});
