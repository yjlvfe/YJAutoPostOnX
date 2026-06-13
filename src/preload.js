const { contextBridge, ipcRenderer } = require('electron');

// Expose protected APIs to renderer
contextBridge.exposeInMainWorld('api', {
  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.send('save-settings', settings),

  // File dialogs
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  selectCSV: () => ipcRenderer.invoke('select-csv'),

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
  generateAiPosts: (config) => ipcRenderer.invoke('generate-ai-posts', config),
  
  // Export features
  exportQueue: (filePath) => ipcRenderer.invoke('export-queue', filePath),
  getLogs: () => ipcRenderer.invoke('get-logs'),
  readLog: (logName) => ipcRenderer.invoke('read-log', logName),
  exportLogsToCsv: (targetPath) => ipcRenderer.invoke('export-logs-to-csv', targetPath),

  // Security
  runAudit: () => ipcRenderer.invoke('run-audit'),

  // Status updates (listener)
  onStatusUpdate: (callback) => {
    const listener = (event, status) => callback(status);
    ipcRenderer.on('status-update', listener);
    return () => ipcRenderer.removeListener('status-update', listener);
  },
});
