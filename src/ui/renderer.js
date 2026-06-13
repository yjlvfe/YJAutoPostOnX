// Using window.api exposed via preload instead of direct ipcRenderer
// No Node.js modules loaded in renderer process

// Elements
const btnSelectFolder = document.getElementById('btn-select-folder');
const folderPathDisplay = document.getElementById('output-folder-path');
const btnAddPosts = document.getElementById('btn-add-posts');
const btnManageQueue = document.getElementById('btn-manage-queue');
const btnLogin = document.getElementById('btn-login');
const modeSelect = document.getElementById('mode-select');
const btnMainAction = document.getElementById('btn-main-action');
const queueCountEl = document.getElementById('queue-count');
const liveStatusEl = document.getElementById('live-status');
const countdownEl = document.getElementById('countdown-timer');
const logContainer = document.getElementById('log-container');
const btnClearLogs = document.getElementById('btn-clear-logs');
const csvControls = document.getElementById('csv-controls');

// Settings Fields
const speedInput = document.getElementById('speed');
const maxPostsInput = document.getElementById('maxPosts');

// Modal Elements
const queueModal = document.getElementById('queue-modal');
const btnCloseModal = document.getElementById('btn-close-modal');
const queueTableBody = document.getElementById('queue-table-body');
const selectAllCheckbox = document.getElementById('select-all');
const btnDeleteSelected = document.getElementById('btn-delete-selected');

// Stats Dashboard Elements
const successCountEl = document.getElementById('success-count');
const failedCountEl = document.getElementById('failed-count');

// Profile Elements
const profileSelect = document.getElementById('profile-select');
const btnAddProfile = document.getElementById('btn-add-profile');
const btnRenameProfile = document.getElementById('btn-rename-profile');
const btnDeleteProfile = document.getElementById('btn-delete-profile');
const activeProfileName = document.getElementById('active-profile-name');

let statusListenerCleanup = null;
let countdownInterval = null;
let staticCountdownMessage = '';

// State
let state = {
  outputFolder: '',
  isRunning: false,
  queue: [],
  stats: { success: 0, failed: 0 }
};

// ===== MODE SWITCHING =====
function updateModeUI() {
  const mode = modeSelect.value;
  if (mode === 'csv') {
    csvControls.style.display = 'flex';
    btnMainAction.textContent = '🚀 Start';
  }
}

modeSelect.addEventListener('change', updateModeUI);

// ===== PERSISTENCE LOGIC =====
function applySettings(settings) {
  if (settings.speed) speedInput.value = settings.speed;
  if (settings.maxPosts) maxPostsInput.value = settings.maxPosts;
  if (settings.outputFolder) {
    state.outputFolder = settings.outputFolder;
    folderPathDisplay.textContent = settings.outputFolder;
  }
}

// ===== PROFILE MANAGEMENT =====

async function loadProfiles() {
  const profiles = await window.api.getProfiles();
  profileSelect.innerHTML = '';
  profiles.forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    profileSelect.appendChild(opt);
  });
  return profiles;
}

// ── Profile Modal ────────────────────────────────────────────────────
let profileModalCallback = null;

const profileModal = document.getElementById('profile-modal');
const profileModalTitle = document.getElementById('profile-modal-title');
const profileModalInput = document.getElementById('profile-modal-input');
const profileModalError = document.getElementById('profile-modal-error');
const btnConfirmProfile = document.getElementById('btn-confirm-profile');
const btnCloseProfileModal = document.getElementById('btn-close-profile-modal');

function showProfileModal(title, defaultValue = '', callback) {
  profileModalTitle.textContent = title;
  profileModalInput.value = defaultValue;
  profileModalError.classList.add('hidden');
  profileModalError.textContent = '';
  profileModal.classList.add('active');
  profileModalCallback = callback;
  setTimeout(() => profileModalInput.focus(), 100);
}

function hideProfileModal() {
  profileModal.classList.remove('active');
  profileModalCallback = null;
}

btnConfirmProfile.addEventListener('click', () => {
  const val = profileModalInput.value.trim();
  if (!val) {
    profileModalError.textContent = '❌ Please enter a name';
    profileModalError.classList.remove('hidden');
    return;
  }
  const cb = profileModalCallback;
  hideProfileModal();
  if (cb) cb(val);
});

btnCloseProfileModal.addEventListener('click', hideProfileModal);

profileModal.addEventListener('click', (e) => {
  if (e.target === profileModal) hideProfileModal();
});

profileModalInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnConfirmProfile.click();
  if (e.key === 'Escape') hideProfileModal();
});

// ── Profile Actions ───────────────────────────────────────────────────

btnAddProfile.addEventListener('click', () => {
  showProfileModal('➕ Add New Profile', '', async (name) => {
    const result = await window.api.createProfile(name);
    if (result.success) {
      addLog(`✅ Profile created: ${result.profile.name}`, 'success');
      await loadProfiles();
      profileSelect.value = result.profile.name;
      activeProfileName.textContent = result.profile.name;
    } else {
      addLog(`❌ Failed to create profile: ${result.error}`, 'error');
    }
  });
});

btnDeleteProfile.addEventListener('click', async () => {
  const selected = profileSelect.value;
  if (selected === 'Default') {
    addLog('⚠️ Cannot delete the Default profile', 'warning');
    return;
  }
  if (!confirm(`Are you sure you want to delete profile "${selected}"?`)) return;
  const result = await window.api.deleteProfile(selected);
  if (result.success) {
    addLog(`🗑️ Profile deleted: ${selected}`, 'warning');
    await loadProfiles();
    profileSelect.value = 'Default';
    activeProfileName.textContent = 'Default';
  } else {
    addLog(`❌ Failed to delete profile: ${result.error}`, 'error');
  }
});

btnRenameProfile.addEventListener('click', () => {
  const selected = profileSelect.value;
  if (selected === 'Default') {
    addLog('⚠️ Cannot rename the Default profile', 'warning');
    return;
  }
  showProfileModal(`✏️ Rename "${selected}"`, selected, async (newName) => {
    if (newName === selected) return;
    const result = await window.api.renameProfile(selected, newName);
    if (result.success) {
      addLog(`✏️ Profile renamed: ${selected} → ${result.profile.name}`, 'success');
      await loadProfiles();
      profileSelect.value = result.profile.name;
      activeProfileName.textContent = result.profile.name;
    } else {
      addLog(`❌ Failed to rename: ${result.error}`, 'error');
    }
  });
});

profileSelect.addEventListener('change', () => {
  const selected = profileSelect.value;
  activeProfileName.textContent = selected;
  addLog(`👤 Switched to profile: ${selected}`, 'info');
  // Load queue for the new profile
  loadQueue(selected);
});

document.addEventListener('DOMContentLoaded', async () => {
  const settings = await window.api.getSettings();
  if (settings) {
    applySettings(settings);
    state.outputFolder = settings.outputFolder || '';
  }
  await loadProfiles();
  // Load queue for the active profile
  const currentProfile = profileSelect.value;
  await loadQueue(currentProfile);
  activeProfileName.textContent = currentProfile;
  updateModeUI();
});

async function loadQueue(profile) {
  state.queue = await window.api.getQueue(profile);
  updateQueueUI();
}

function saveAllSettings() {
  window.api.saveSettings({
    speed: speedInput.value,
    maxPosts: maxPostsInput.value,
    outputFolder: state.outputFolder
  });
}

speedInput.addEventListener('change', saveAllSettings);
maxPostsInput.addEventListener('change', saveAllSettings);

// --- HANDLERS ---
btnSelectFolder.addEventListener('click', async () => {
  const folderPath = await window.api.selectFolder();
  if (folderPath) {
    state.outputFolder = folderPath;
    folderPathDisplay.textContent = folderPath;
    addLog('Output folder selected: ' + folderPath, 'info');
    saveAllSettings();
  }
});

btnAddPosts.addEventListener('click', async () => {
  if (btnAddPosts.disabled) return;
  btnAddPosts.disabled = true;
  btnAddPosts.textContent = 'Opening & filtering...';

  const filePath = await window.api.selectCSV();
  if (filePath) {
    try {
      addLog('Processing CSV file...', 'info');
      const parseResult = await window.api.parseCSV(filePath);
      const addResult = await window.api.addPosts(parseResult.posts, profileSelect.value);
      await loadQueue(profileSelect.value);
      const logMsg = `Import Stats -> Added: ${parseResult.added} | Skipped (Length): ${parseResult.skippedLength} | Skipped (No Media): ${parseResult.skippedLink} | Skipped (Duplicates): ${addResult.skippedDuplicate}`;
      addLog(logMsg, 'success');
    } catch (err) {
      addLog('Error parsing CSV: ' + err.message, 'error');
    }
  }

  btnAddPosts.disabled = false;
  btnAddPosts.textContent = 'Import CSV';
});

btnManageQueue.addEventListener('click', () => {
  renderQueueTable();
  queueModal.classList.add('active');
});

btnLogin.addEventListener('click', async () => {
  if (btnLogin.disabled) return;
  
  const profileName = profileSelect.value;
  btnLogin.disabled = true;
  btnLogin.textContent = 'Opening...';
  
  try {
    const result = await window.api.openProfileForLogin(profileName);
    if (!result.success) {
      throw new Error(result.error);
    }
    addLog(`Opening browser for login with profile: ${profileName}`, 'info');
  } catch (err) {
    addLog('Login failed: ' + err.message, 'error');
  } finally {
    btnLogin.disabled = false;
    btnLogin.textContent = '👤 Login / Account';
  }
});

btnCloseModal.addEventListener('click', () => {
  queueModal.classList.remove('active');
});

btnClearLogs.addEventListener('click', () => {
  logContainer.innerHTML = '';
  addLog('Logs cleared', 'info');
});

selectAllCheckbox.addEventListener('change', (e) => {
  const checkboxes = queueTableBody.querySelectorAll('input[type="checkbox"]');
  checkboxes.forEach(cb => cb.checked = e.target.checked);
});

btnDeleteSelected.addEventListener('click', async () => {
  const checkboxes = queueTableBody.querySelectorAll('input[type="checkbox"]:checked');
  const indices = Array.from(checkboxes).map(cb => parseInt(cb.dataset.index));
  if (indices.length === 0) return;

  await window.api.bulkDelete(indices, profileSelect.value);
  await loadQueue(profileSelect.value);
  renderQueueTable();
  addLog(`Deleted ${indices.length} posts from queue`, 'warning');
});

/**
 * SINGLE ACTION BUTTON LOGIC
 */
btnMainAction.addEventListener('click', () => {
  if (btnMainAction.disabled) return;

  if (!state.isRunning) {
    // START ACTION
    if (state.queue.length === 0) {
      addLog('⚠️ Queue is empty! Import CSV first', 'error');
      return;
    }
    if (!state.outputFolder) {
      addLog('⚠️ Please select an output folder!', 'error');
      return;
    }

    state.isRunning = true;
    updateActionBtnUI();

    // Build config
    const config = {
      speed: Math.max(1, parseInt(speedInput.value) || 5),
      maxPosts: Math.max(1, parseInt(maxPostsInput.value) || 9999),
      outputFolder: state.outputFolder,
      mode: 'csv',
      profile: profileSelect.value,
      posts: state.queue
    };

    window.api.startPosting(config).then(result => {
      if (!result.success) {
        addLog('Start failed: ' + (result.error || 'Unknown error'), 'error');
        state.isRunning = false;
        updateActionBtnUI();
      }
    }).catch(err => {
      addLog('Operation error: ' + err.message, 'error');
      state.isRunning = false;
      updateActionBtnUI();
    }).finally(() => {
      btnMainAction.disabled = false;
    });
  } else {
    // STOP ACTION
    window.api.stopAutomation();
    addLog('🛑 Sending stop signal...', 'warning');
  }
});

function updateActionBtnUI() {
  if (state.isRunning) {
    btnMainAction.textContent = '⏹️ Stop';
    btnMainAction.classList.add('running');
    btnMainAction.disabled = false;
  } else {
    btnMainAction.classList.remove('running');
    btnMainAction.textContent = '🚀 Start';
    btnMainAction.disabled = false;
  }
}

function updateQueueUI() {
  queueCountEl.textContent = state.queue.length;
}

function renderQueueTable() {
  selectAllCheckbox.checked = false;
  queueTableBody.innerHTML = '';
  const fragment = document.createDocumentFragment();

  for (let i = 0; i < state.queue.length; i++) {
    const post = state.queue[i];
    const postText = typeof post === 'string' ? post : (post.text || '');
    const hasMedia = post && typeof post === 'object' && post.media_path;
    
    const tr = document.createElement('tr');

    const tdCheck = document.createElement('td');
    tdCheck.className = 'checkbox-cell';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.index = i;
    tdCheck.appendChild(cb);

    const tdContent = document.createElement('td');
    const postSpan = document.createElement('span');
    postSpan.textContent = postText.length > 80 ? postText.substring(0, 80) + '...' : postText;
    tdContent.appendChild(postSpan);
    if (hasMedia) {
      const mediaIcon = document.createElement('span');
      mediaIcon.className = 'media-icon';
      mediaIcon.title = post.media_path;
      mediaIcon.textContent = '🖼️';
      tdContent.appendChild(mediaIcon);
    }

    const tdAction = document.createElement('td');
    tdAction.style.textAlign = 'center';
    const btnDel = document.createElement('button');
    btnDel.className = 'btn-danger';
    btnDel.style.padding = '6px 10px';
    btnDel.style.fontSize = '.7rem';
    btnDel.textContent = 'Delete';
    btnDel.onclick = () => deleteSingle(i);
    tdAction.appendChild(btnDel);

    tr.appendChild(tdCheck);
    tr.appendChild(tdContent);
    tr.appendChild(tdAction);
    fragment.appendChild(tr);
  }
  queueTableBody.appendChild(fragment);
}

async function deleteSingle(index) {
  await window.api.bulkDelete([index], profileSelect.value);
  await loadQueue(profileSelect.value);
  renderQueueTable();
}

// Status updates listener
if (statusListenerCleanup) statusListenerCleanup();
statusListenerCleanup = window.api.onStatusUpdate((status) => {
  if (status.type === 'countdown') {
    countdownEl.classList.remove('hidden');
    let localCountdown = status.countdown;
    countdownEl.textContent = formatTime(localCountdown);

    const isNewCycle = !countdownInterval;
    if (isNewCycle) {
      staticCountdownMessage = status.message;
      liveStatusEl.textContent = staticCountdownMessage;
    }

    if (countdownInterval) {
      clearInterval(countdownInterval);
    }

    countdownInterval = setInterval(() => {
      localCountdown--;
      if (localCountdown >= 0) {
        countdownEl.textContent = formatTime(localCountdown);
      } else {
        clearInterval(countdownInterval);
        countdownInterval = null;
      }
    }, 1000);
  } else {
    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
    staticCountdownMessage = '';
    countdownEl.classList.add('hidden');
    liveStatusEl.textContent = status.message;
    addLog(status.message, status.type);
  }

  if (status.queueCount !== undefined) {
    queueCountEl.textContent = status.queueCount;
  }
  
  if (status.stats) {
    state.stats = status.stats;
    if (successCountEl) successCountEl.textContent = status.stats.success || 0;
    if (failedCountEl) failedCountEl.textContent = status.stats.failed || 0;
  }

  if (status.type === 'error' || status.message === 'Task completed' || status.message === 'Automation stopped by user') {
    state.isRunning = false;
    updateActionBtnUI();
    btnMainAction.disabled = false;
  }
});

function addLog(message, type) {
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  entry.textContent = `[${time}] ${message}`;
  logContainer.appendChild(entry);

  // Limit log entries to prevent memory leak
  while (logContainer.children.length > 100) {
    logContainer.removeChild(logContainer.firstChild);
  }

  logContainer.scrollTop = logContainer.scrollHeight;
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
