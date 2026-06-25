const { contextBridge, ipcRenderer } = require('electron');

// Expose protected APIs to renderer
contextBridge.exposeInMainWorld('api', {
  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.send('save-settings', settings),

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
  addPosts: (posts, profileName) => ipcRenderer.invoke('add-posts', posts, profileName),
  bulkDelete: (indices, profileName) => ipcRenderer.invoke('bulk-delete', indices, profileName),

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
  exportLogsToCsv: (targetPath) => ipcRenderer.invoke('export-logs-to-csv', targetPath),

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
