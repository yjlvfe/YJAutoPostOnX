// ═══════════════════════════════════════════════════════════════════
// YJAutoPostOnX — Renderer (UI logic)
// Uses window.api exposed via preload. No Node modules in renderer.
// ═══════════════════════════════════════════════════════════════════

// X.com-aware tweet length: URLs count as 23 chars.
function tweetLength(text) {
  if (!text) return 0;
  const urlRe = /https?:\/\/[^\s]+/g;
  const urls = text.match(urlRe) || [];
  const stripped = text.replace(urlRe, '');
  return [...stripped].length + urls.length * 23;
}

// ─── State ───
let state = {
  outputFolder: '',
  isRunning: false,
  queue: [],
  stats: { success: 0, failed: 0 },
  generated: [],          // last AI batch (array of strings)
};
let countdownInterval = null;

// ─── Element refs ───
const $ = (id) => document.getElementById(id);

const profileSelect = $('profile-select');
const speedInput = $('speed');
const maxPostsInput = $('maxPosts');
const folderPathDisplay = $('output-folder-path');
const liveStatusEl = $('live-status');
const statusPulse = $('status-pulse');
const countdownEl = $('countdown-timer');
const logContainer = $('log-container');
const btnMainAction = $('btn-main-action');

// counters
const successCountEl = $('success-count');
const failedCountEl = $('failed-count');
const queueCountEl = $('queue-count');
const navQueueBadge = $('nav-queue-badge');
const mQueue = $('m-queue');
const mSuccess = $('m-success');
const mSpeed = $('m-speed');

// ── +/- number buttons ──────────────────────────────────────────────────────
document.querySelectorAll('.num-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const targetId = btn.dataset.target;
    const min = parseInt(btn.dataset.min ?? '1');
    const input = $(targetId);
    if (!input) return;
    let val = parseInt(input.value) || 1;
    if (btn.classList.contains('num-up')) val++;
    else val = Math.max(min, val - 1);
    input.value = val;
    input.dispatchEvent(new Event('change'));
  });
});

// ═══════════ NAVIGATION ═══════════
function switchView(view) {
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `view-${view}`));
  if (view === 'queue') renderQueueTable();
}
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});
document.querySelectorAll('[data-jump]').forEach(btn => {
  btn.addEventListener('click', () => switchView(btn.dataset.jump));
});

// ═══════════ LOGGING ═══════════
function addLog(message, type = 'info') {
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  entry.textContent = `[${time}] ${message}`;
  logContainer.appendChild(entry);
  while (logContainer.children.length > 120) logContainer.removeChild(logContainer.firstChild);
  logContainer.scrollTop = logContainer.scrollHeight;
}
$('btn-clear-logs').addEventListener('click', () => {
  logContainer.innerHTML = '';
  addLog('تم مسح السجل', 'info');
});

function setStatus(message, kind) {
  liveStatusEl.textContent = message;
  // ⚡ H6: handle 'idle' / '' (neutral) explicitly — strip busy/err so
  // the pulse dot colours correctly instead of inheriting a stale state.
  if (kind === 'busy') statusPulse.className = 'pulse busy';
  else if (kind === 'err') statusPulse.className = 'pulse err';
  else statusPulse.className = 'pulse';
}

// ═══════════ SETTINGS PERSISTENCE ═══════════
function applySettings(s) {
  if (!s) return;
  // Basic settings (Dashboard)
  if (s.speed) { speedInput.value = s.speed; mSpeed.textContent = s.speed; }
  if (s.maxPosts) maxPostsInput.value = s.maxPosts;
  if (s.outputFolder) {
    state.outputFolder = s.outputFolder;
    folderPathDisplay.textContent = s.outputFolder;
  }
  // AI Studio: Load saved settings (user requested restore)
  if (s.aiBaseUrl) $('ai-base-url').value = s.aiBaseUrl;
  if (s.aiApiKey) $('ai-api-key').value = s.aiApiKey;
  if (s.aiModel) $('ai-model').value = s.aiModel;
  if (s.aiProviderOverride) $('ai-provider-override').value = s.aiProviderOverride;
  if (s.referralLink) $('referral-link').value = s.referralLink;
  if (s.aiQuantity) $('ai-quantity').value = s.aiQuantity;
  if (s.aiSessionCount && $('ai-session-count')) $('ai-session-count').value = s.aiSessionCount;
  if (s.aiPrompt && $('ai-prompt')) $('ai-prompt').value = s.aiPrompt;
  updateProviderTag();
}

function saveBasicSettings() {
  window.api.saveSettings({
    speed: speedInput.value,
    maxPosts: maxPostsInput.value,
    outputFolder: state.outputFolder,
  });
  mSpeed.textContent = speedInput.value;
}
speedInput.addEventListener('change', saveBasicSettings);
maxPostsInput.addEventListener('change', saveBasicSettings);

$('btn-save-ai-settings').addEventListener('click', () => {
  window.api.saveSettings({
    aiBaseUrl: $('ai-base-url').value.trim(),
    aiApiKey: $('ai-api-key').value.trim(),
    aiModel: $('ai-model').value.trim(),
    aiProviderOverride: $('ai-provider-override').value,
  });
  const ok = $('save-ok');
  ok.classList.remove('hidden');
  setTimeout(() => ok.classList.add('hidden'), 2000);
  updateProviderTag();
  addLog('تم حفظ إعدادات الذكاء الاصطناعي', 'success');
});

// Reset AI settings button
$('btn-reset-ai-settings').addEventListener('click', () => {
  if (!confirm('هل تريد إعادة تعيين جميع إعدادات الذكاء الاصطناعي؟')) return;
  $('ai-base-url').value = '';
  $('ai-api-key').value = '';
  $('ai-model').value = '';
  $('ai-provider-override').value = '';
  if ($('ai-prompt')) $('ai-prompt').value = '';
  window.api.saveSettings({
    aiBaseUrl: '',
    aiApiKey: '',
    aiModel: '',
    aiProviderOverride: '',
    aiPrompt: '',
  });
  updateProviderTag();
  addLog('تم إعادة تعيين إعدادات الذكاء الاصطناعي', 'info');
});

// toggle key visibility
$('btn-toggle-key').addEventListener('click', () => {
  const input = $('ai-api-key');
  input.type = input.type === 'password' ? 'text' : 'password';
});

// provider auto-detect tag (mirror of engine logic — G5: model decides)
function detectProvider(baseUrl, forced, model) {
  if (forced && forced !== 'auto') return forced;
  const fam = detectModelFamily(model);
  if (fam === 'claude') return 'anthropic';
  if (fam === 'gemini') {
    const url = (baseUrl || '').toLowerCase();
    if (url.includes('generativelanguage') && !url.includes('/openai')) return 'gemini';
    return 'openai';
  }
  return 'openai';
}
// model family (mirror of engine logic) — what the user actually picked
function detectModelFamily(model) {
  const m = (model || '').toLowerCase();
  if (!m) return 'unknown';
  if (m.includes('claude')) return 'claude';
  if (m.includes('gemini')) return 'gemini';
  if (m.includes('gpt') || m.includes('o1') || m.includes('o3') || m.includes('o4')) return 'gpt';
  if (m.includes('deepseek')) return 'deepseek';
  if (m.includes('llama') || m.includes('nemotron')) return 'llama';
  if (m.includes('qwen')) return 'qwen';
  if (m.includes('mistral') || m.includes('mixtral')) return 'mistral';
  if (m.includes('grok')) return 'grok';
  return 'other';
}
// OpenCode Go static model map (must match contentEngine.js exactly)
const OPENCODE_GO_ANTHROPIC_MODELS_R = [
  'minimax-m3', 'minimax-m2.7', 'minimax-m2.5',
  'qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-plus',
  // ⚡ H2: models added — must match contentEngine.js exactly
  'glm-5.2',
  'kimi-k2.7',
  'deepseek-v4-pro',
  'mimo-v2.5',
];

// Mirror of contentEngine.detectApiFormat — determines wire format from provider+model
function detectApiFormat(provider, modelId) {
  const m = (modelId || '').toLowerCase();
  if (provider === 'opencode-go') {
    const isAnthropic = OPENCODE_GO_ANTHROPIC_MODELS_R.some(name => m.startsWith(name));
    return isAnthropic ? 'anthropic' : 'openai';
  }
  const fam = detectModelFamily(modelId);
  if (fam === 'claude') return 'anthropic';
  if (fam === 'gemini') return 'gemini';
  return 'openai';
}

function providerLabel(provider, model) {
  if (provider === 'opencode-go') return 'OpenCode Go';
  const fam = detectModelFamily(model);
  const proto = provider === 'anthropic' ? 'Anthropic' : provider === 'gemini' ? 'Gemini' : 'OpenAI';
  if (fam === 'unknown' || fam === 'other') return proto;
  return `${fam} · ${proto}`;
}
function updateProviderTag() {
  const base = $('ai-base-url').value.trim();
  const forced = $('ai-provider-override').value;
  const model = ($('ai-model') && $('ai-model').value.trim()) || '';
  // ⚡ H1: don't bail just because base URL is empty — if the user
  // already typed a model name we can still show its detected provider.
  if (!base && forced === 'auto' && !model) { $('ai-provider-tag').textContent = '—'; return; }
  const p = detectProvider(base, forced, model);

  // Check modelFormats map first (from list-models response), then compute locally
  const modelFormats = window._modelFormats || {};
  let wireFmt = modelFormats[model] || null;
  if (!wireFmt && model) wireFmt = detectApiFormat(p, model);

  let label = providerLabel(p, model);
  if (wireFmt) {
    const fmtTag = wireFmt === 'anthropic' ? 'Anthropic' : wireFmt === 'gemini' ? 'Gemini' : 'OpenAI-Compatible';
    label += ` [${fmtTag}]`;
  }
  $('ai-provider-tag').textContent = label;
}
$('ai-base-url').addEventListener('input', updateProviderTag);
$('ai-provider-override').addEventListener('change', updateProviderTag);
if ($('ai-model')) $('ai-model').addEventListener('input', updateProviderTag);

// 🔄 Fetch available models from the provider (real /models call)
$('btn-fetch-models').addEventListener('click', async () => {
  const btn = $('btn-fetch-models');
  const hint = $('ai-model-hint');
  const select = $('ai-model-select');
  const baseUrl = $('ai-base-url').value.trim();
  const apiKey = $('ai-api-key').value.trim();
  const providerOverride = $('ai-provider-override').value;

  if (!baseUrl) { hint.textContent = '⚠️ اكتب Base URL أولاً.'; return; }
  if (!apiKey) { hint.textContent = '⚠️ اكتب مفتاح API أولاً.'; return; }

  const original = btn.textContent;
  btn.textContent = '⏳ جاري الفحص...';
  btn.disabled = true;
  hint.textContent = 'جاري جلب الموديلات من المزوّد...';

  try {
    const r = await window.api.listModels({ baseUrl, apiKey, providerOverride });
    if (!r.success) {
      hint.textContent = `❌ فشل الفحص: ${r.error}`;
      select.classList.add('hidden');
      return;
    }
    if (!r.models || r.models.length === 0) {
      hint.textContent = `⚠️ المزوّد (${r.provider}) لم يرجع أي موديلات.`;
      select.classList.add('hidden');
      return;
    }

    // Populate both the dropdown and the datalist (for free typing)
    select.innerHTML = '<option value="">— اختر موديلاً —</option>';
    const datalist = $('ai-model-list');
    datalist.innerHTML = '';
    r.models.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m; opt.textContent = m;
      select.appendChild(opt);
      const dopt = document.createElement('option');
      dopt.value = m;
      datalist.appendChild(dopt);
    });
    select.classList.remove('hidden');
    // Store format annotations for tag display
    window._modelFormats = r.modelFormats || {};
    // Preselect current model if it's in the list
    const current = $('ai-model').value.trim();
    if (current && r.models.includes(current)) select.value = current;
    hint.textContent = `✅ وُجد ${r.count} موديل من المزوّد (${r.provider}). اختر واحداً من القائمة.`;
    updateProviderTag();
  } catch (e) {
    hint.textContent = `❌ خطأ: ${e.message}`;
  } finally {
    btn.textContent = original;
    btn.disabled = false;
  }
});

// When a model is picked from the dropdown, copy it into the model input and update tag
$('ai-model-select').addEventListener('change', (e) => {
  if (e.target.value) {
    $('ai-model').value = e.target.value;
    window.api.saveSettings({ aiModel: e.target.value });
    updateProviderTag();
  }
});

// referral + quantity persist on change
$('referral-link').addEventListener('change', () => {
  window.api.saveSettings({ referralLink: $('referral-link').value.trim() });
});
$('ai-quantity').addEventListener('change', () => {
  window.api.saveSettings({ aiQuantity: $('ai-quantity').value });
});

// ═══════════ FOLDER ═══════════
$('btn-select-folder').addEventListener('click', async () => {
  const p = await window.api.selectFolder();
  if (p) {
    state.outputFolder = p;
    folderPathDisplay.textContent = p;
    addLog('تم اختيار مجلد الإخراج: ' + p, 'info');
    saveBasicSettings();
  }
});

// ═══════════ PROFILES ═══════════
async function loadProfiles() {
  const profiles = await window.api.getProfiles();
  profileSelect.innerHTML = '';
  profiles.forEach(name => {
    const opt = document.createElement('option');
    opt.value = name; opt.textContent = name;
    profileSelect.appendChild(opt);
  });
}

const profileModal = $('profile-modal');
const profileModalTitle = $('profile-modal-title');
const profileModalInput = $('profile-modal-input');
const profileModalError = $('profile-modal-error');
let profileModalCallback = null;

function showProfileModal(title, def, cb) {
  profileModalTitle.textContent = title;
  profileModalInput.value = def || '';
  profileModalError.classList.add('hidden');
  profileModal.classList.add('active');
  profileModalCallback = cb;
  setTimeout(() => profileModalInput.focus(), 100);
}
function hideProfileModal() { profileModal.classList.remove('active'); profileModalCallback = null; }

$('btn-confirm-profile').addEventListener('click', () => {
  const val = profileModalInput.value.trim();
  if (!val) { profileModalError.textContent = '❌ الرجاء إدخال اسم'; profileModalError.classList.remove('hidden'); return; }
  const cb = profileModalCallback; hideProfileModal(); if (cb) cb(val);
});
$('btn-close-profile-modal').addEventListener('click', hideProfileModal);
profileModal.addEventListener('click', e => { if (e.target === profileModal) hideProfileModal(); });
profileModalInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') $('btn-confirm-profile').click();
  if (e.key === 'Escape') hideProfileModal();
});

$('btn-add-profile').addEventListener('click', () => {
  showProfileModal('➕ إضافة بروفايل', '', async (name) => {
    const r = await window.api.createProfile(name);
    if (r.success) { addLog(`✅ تم إنشاء البروفايل: ${r.profile.name}`, 'success'); await loadProfiles(); profileSelect.value = r.profile.name; loadQueue(r.profile.name); }
    else addLog(`❌ فشل الإنشاء: ${r.error}`, 'error');
  });
});
$('btn-delete-profile').addEventListener('click', async () => {
  const sel = profileSelect.value;
  if (sel === 'Default') { addLog('⚠️ لا يمكن حذف البروفايل الافتراضي', 'warning'); return; }
  if (!confirm(`حذف البروفايل "${sel}"؟`)) return;
  const r = await window.api.deleteProfile(sel);
  if (r.success) { addLog(`🗑️ تم حذف البروفايل: ${sel}`, 'warning'); await loadProfiles(); profileSelect.value = 'Default'; loadQueue('Default'); }
  else addLog(`❌ فشل الحذف: ${r.error}`, 'error');
});
$('btn-rename-profile').addEventListener('click', () => {
  const sel = profileSelect.value;
  if (sel === 'Default') { addLog('⚠️ لا يمكن إعادة تسمية الافتراضي', 'warning'); return; }
  showProfileModal(`✏️ إعادة تسمية "${sel}"`, sel, async (newName) => {
    if (newName === sel) return;
    const r = await window.api.renameProfile(sel, newName);
    if (r.success) { addLog(`✏️ ${sel} → ${r.profile.name}`, 'success'); await loadProfiles(); profileSelect.value = r.profile.name; loadQueue(r.profile.name); }
    else addLog(`❌ فشل: ${r.error}`, 'error');
  });
});
profileSelect.addEventListener('change', () => {
  addLog(`👤 تبديل إلى البروفايل: ${profileSelect.value}`, 'info');
  loadQueue(profileSelect.value);
  refreshCooldownBanner();
});

// ═══════════ COOLDOWN BANNER (rate-limit) ═══════════
let cooldownTicker = null;

function pad2(n) { return String(n).padStart(2, '0'); }
function fmtCooldown(ms) {
  if (ms <= 0) return '00:00';
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${pad2(h)}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
}

async function refreshCooldownBanner() {
  const banner = $('cooldown-banner');
  const profile = profileSelect.value;
  if (cooldownTicker) { clearInterval(cooldownTicker); cooldownTicker = null; }

  let r;
  try { r = await window.api.getCooldown(profile); }
  catch { banner.classList.add('hidden'); return; }

  if (!r.success || !r.cooldown) { banner.classList.add('hidden'); return; }

  let until = r.cooldown.until;
  const srcNote = r.cooldown.source === 'x' ? ' (مدة من تويتر)' : '';
  $('cooldown-text').textContent = `🚫 البروفايل "${profile}" ضرب حد تويتر${srcNote} — ينتهي بعد:`;
  banner.classList.remove('hidden');

  // ⚡ H5: capture the profile at creation time so the deferred
  // refresh only fires if the user is STILL on the same profile —
  // prevents the banner for profile A from refreshing onto profile B.
  const watchedProfile = profile;
  const tick = () => {
    const remaining = until - Date.now();
    if (remaining <= 0) {
      $('cooldown-timer-live').textContent = '00:00';
      $('cooldown-text').textContent = `✅ انتهى الكول داون للبروفايل "${watchedProfile}" — جاهز للنشر.`;
      if (cooldownTicker) { clearInterval(cooldownTicker); cooldownTicker = null; }
      setTimeout(() => {
        if (profileSelect.value === watchedProfile) refreshCooldownBanner();
      }, 3000);
      return;
    }
    $('cooldown-timer-live').textContent = fmtCooldown(remaining);
  };
  tick();
  cooldownTicker = setInterval(tick, 1000);
}

$('btn-clear-cooldown').addEventListener('click', async () => {
  const profile = profileSelect.value;
  if (!confirm(`إلغاء الكول داون للبروفايل "${profile}"؟ (قد يضربه تويتر مجدداً)`)) return;
  await window.api.clearCooldown(profile);
  addLog(`🗑️ أُلغي الكول داون للبروفايل "${profile}"`, 'warning');
  refreshCooldownBanner();
});

// ═══════════ LOGIN ═══════════
$('btn-login').addEventListener('click', async () => {
  const btn = $('btn-login');
  if (btn.disabled) return;
  btn.disabled = true; btn.textContent = 'جاري الفتح...';
  try {
    const r = await window.api.openProfileForLogin(profileSelect.value);
    if (!r.success) throw new Error(r.error);
    addLog(`فتح المتصفح لتسجيل الدخول: ${profileSelect.value}`, 'info');
  } catch (e) { addLog('فشل تسجيل الدخول: ' + e.message, 'error'); }
  finally { btn.disabled = false; btn.textContent = '🔐 تسجيل الدخول إلى X'; }
});

// ═══════════ QUEUE ═══════════
async function loadQueue(profile) {
  state.queue = await window.api.getQueue(profile || profileSelect.value);
  updateQueueCounters();
  if ($('view-queue').classList.contains('active')) renderQueueTable();
}
function updateQueueCounters() {
  const n = state.queue.length;
  queueCountEl.textContent = n;
  navQueueBadge.textContent = n;
  mQueue.textContent = n;
  const tn = $('queue-total-num'); if (tn) tn.textContent = n;
}

function renderQueueTable() {
  const tbody = $('queue-table-body');
  $('select-all').checked = false;
  tbody.innerHTML = '';
  const frag = document.createDocumentFragment();
  state.queue.forEach((post, i) => {
    const text = typeof post === 'string' ? post : (post.text || '');
    const hasMedia = post && typeof post === 'object' && post.media_path;
    const tr = document.createElement('tr');

    const tdCheck = document.createElement('td');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.dataset.index = i;
    tdCheck.appendChild(cb);

    const tdContent = document.createElement('td');
    const span = document.createElement('span');
    span.textContent = text.length > 110 ? text.slice(0, 110) + '…' : text;
    tdContent.appendChild(span);
    if (hasMedia) { const m = document.createElement('span'); m.className = 'media-icon'; m.title = post.media_path; m.textContent = '🖼️'; tdContent.appendChild(m); }

    const tdLen = document.createElement('td');
    tdLen.className = 'q-len';
    tdLen.textContent = tweetLength(text);

    const tdAction = document.createElement('td');
    tdAction.style.textAlign = 'center';
    const del = document.createElement('button');
    del.className = 'btn-danger'; del.style.padding = '6px 12px'; del.style.fontSize = '.72rem';
    del.textContent = 'حذف';
    del.onclick = () => deleteSingle(i);
    tdAction.appendChild(del);

    tr.append(tdCheck, tdContent, tdLen, tdAction);
    frag.appendChild(tr);
  });
  tbody.appendChild(frag);
}

async function deleteSingle(i) {
  // ⚡ H7: capture the profile at call time so a profile switch
  // between the click and the async completion doesn't delete or
  // reload the wrong queue.
  const profile = profileSelect.value;
  await window.api.bulkDelete([i], profile);
  await loadQueue(profile);
  if ($('view-queue').classList.contains('active')) renderQueueTable();
}
$('select-all').addEventListener('change', (e) => {
  $('queue-table-body').querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = e.target.checked);
});
$('btn-delete-selected').addEventListener('click', async () => {
  const idx = Array.from($('queue-table-body').querySelectorAll('input:checked')).map(cb => parseInt(cb.dataset.index));
  if (!idx.length) { addLog('لم تحدد أي منشور', 'warning'); return; }
  await window.api.bulkDelete(idx, profileSelect.value);
  await loadQueue(); renderQueueTable();
  addLog(`🗑️ حُذف ${idx.length} منشور`, 'warning');
});

// import CSV (two buttons share logic)
async function importCsvFlow() {
  const filePath = await window.api.selectCSV();
  if (!filePath) return;
  try {
    addLog('جاري معالجة ملف CSV...', 'info');
    const parsed = await window.api.parseCSV(filePath);
    const add = await window.api.addPosts(parsed.posts, profileSelect.value);
    await loadQueue();
    addLog(`الاستيراد ← أُضيف: ${add.successfullyAdded ?? add.added ?? parsed.added} | تخطّي طول: ${parsed.skippedLength} | مكرر: ${add.skippedDuplicate}`, 'success');
  } catch (e) { addLog('خطأ في قراءة CSV: ' + e.message, 'error'); }
}
$('btn-add-posts').addEventListener('click', importCsvFlow);
$('btn-import-csv-dash').addEventListener('click', () => { switchView('queue'); importCsvFlow(); });

// export queue
$('btn-export-queue').addEventListener('click', async () => {
  if (!state.queue.length) { addLog('الطابور فارغ', 'warning'); return; }
  const p = await window.api.selectSaveCSV();
  if (!p) return;
  const r = await window.api.exportQueue(p, profileSelect.value);
  if (r.success) addLog('💾 تم تصدير الطابور: ' + p, 'success');
  else addLog('فشل التصدير: ' + r.error, 'error');
});

// ═══════════ AI STUDIO ═══════════
const btnGenerate = $('btn-generate');
const resultsList = $('results-list');
const resultsCount = $('results-count');
const resultsActions = $('results-actions');
const aiProgressFill = $('ai-progress-fill');
const aiProgressText = $('ai-progress-text');
const studioWarn = $('studio-warn');

// The DEFAULT prompt shown when the user clicks "📋 الافتراضي". This is a
// display copy for editing — the real default lives in contentEngine and is
// never mutated by what the user types here.
const DEFAULT_PROMPT_TEXT = [
  'أنت كاتب محتوى تسويقي محترف متخصص في أسواق الكريبتو والتداول.',
  'مهمتك كتابة تغريدات عربية فصيحة احترافية تجذب القارئ وتبني الثقة.',
  'قواعد صارمة يجب الالتزام بها حرفياً:',
  '- اكتب نص التغريدة فقط (بدون روابط وبدون هاشتاقات — سأضيفها أنا لاحقاً).',
  '- طول كل نص بين 170 و 210 حرفاً.',
  '- ابدأ كل تغريدة بإيموجي واحد مناسب (🔥📈💰⭐🎯) لجذب الانتباه.',
  '- ممنوع منعاً باتاً تكرار أي كلمة بشكل متجاور (مثل "تام تام").',
  '- ممنوع الحشو والكلمات الفارغة التي لا تضيف معنى.',
  '- كل تغريدة مختلفة تماماً عن الأخرى في الصياغة والزاوية.',
  '- لغة عربية راقية، واثقة، بدون مبالغات كاذبة، بدون وعود ربح مضمون.',
  '- لا تذكر روابط ولا علامات # إطلاقاً داخل النص.',
  '- ممنوع علامات الاقتباس أو كتابة عدد الحروف أو ترقيم التغريدة.',
  '- استخدم إيموجي حقيقية فقط، لا رموز مكسورة.',
  'أعِد الناتج حصراً كمصفوفة JSON من النصوص فقط بدون أي شرح: ["نص","نص",...]',
].join('\n');

// 📋 الافتراضي — fills the textarea with the default prompt for editing.
const btnDefaultPrompt = $('btn-default-prompt');
if (btnDefaultPrompt) {
  btnDefaultPrompt.addEventListener('click', () => {
    const ta = $('ai-prompt');
    if (ta) { ta.value = DEFAULT_PROMPT_TEXT; ta.focus(); }
    addLog('📋 تم تحميل البرومبت الافتراضي في الحقل — عدّله كما تريد.', 'info');
  });
}

// Update the live stats grid from a progress payload.
function updateStats(msg) {
  const grid = $('ai-stats-grid');
  if (grid) grid.classList.remove('hidden');
  const set = (id, v) => { const el = $(id); if (el && v != null) el.textContent = v; };
  set('stat-rounds', msg.rounds);
  set('stat-accepted', msg.accepted);
  set('stat-rejected', msg.rejected);
  set('stat-dups', msg.duplicates);
  set('stat-tin', msg.tokensIn);
  set('stat-tout', msg.tokensOut);
  if (msg.cacheHitPct != null) set('stat-cache', `${msg.cacheHitPct}%`);
}

// Render per-session status chips (🟢 يعمل | 🟡 انتظار | 🔴 متوقفة | ✅ منتهية).
const SESSION_DOT = { running: '🟢', waiting: '🟡', idle: '🟡', stopped: '🔴', done: '✅' };
function updateSessionStatus(payload) {
  const row = $('ai-sessions-row');
  const summary = $('ai-sessions-summary');
  const summaryText = $('sessions-summary-text');
  const banner = $('ai-error-banner');
  if (!row || !payload || !Array.isArray(payload.sessions)) return;
  row.classList.remove('hidden');
  if (summary) summary.classList.remove('hidden');
  row.innerHTML = '';
  const errors = [];
  // 📊 M2: aggregate counts for the summary line
  let active = 0, idle = 0, errored = 0, done = 0;
  for (const s of payload.sessions) {
    const chip = document.createElement('span');
    const hasError = !!s.lastError;
    chip.style.cssText = hasError
      ? 'padding:3px 8px;border-radius:10px;background:rgba(239,68,68,0.2);border:1px solid rgba(239,68,68,0.4);'
      : 'padding:3px 8px;border-radius:10px;background:rgba(255,255,255,0.06);';
    const dot = SESSION_DOT[s.status] || '🟡';
    chip.textContent = `${dot} #${s.num} · ${s.rounds}ج · ${s.accepted}✅`;
    chip.title = `Session #${s.num} — ${s.status} — ${s.cacheRead || 0} كاش`;
    if (hasError) {
      chip.title += `\n❌ ${s.lastError}`;
      errors.push(`#${s.num}: ${s.lastError}`);
      errored++;
    } else if (s.status === 'running') {
      active++;
    } else if (s.status === 'done') {
      done++;
    } else {
      idle++;  // waiting / idle / stopped
    }
    row.appendChild(chip);
  }
  // 📊 M2: update the summary line — 🟢 active · 🟡 idle · 🔴 errored · ✅ done
  if (summaryText) {
    summaryText.textContent = `🟢 ${active} نشطة · 🟡 ${idle} خامل · 🔴 ${errored} خطأ · ✅ ${done} منتهية`;
  }
  // Show/hide error banner
  if (banner) {
    if (errors.length > 0) {
      banner.classList.remove('hidden');
      banner.innerHTML = '⚠️ <strong>أخطاء الجلسات:</strong><br>' + errors.join('<br>');
    } else {
      banner.classList.add('hidden');
    }
  }
}

// progress listener
window.api.onAiProgress((msg) => {
  if (msg.target) {
    const pct = Math.min(100, Math.round((msg.accepted / msg.target) * 100));
    aiProgressFill.style.width = pct + '%';
  }
  aiProgressText.textContent = msg.message;
  updateStats(msg);
  addLog('🧠 ' + msg.message, msg.type || 'info');
});

// Build a single result-item DOM node (shared by full + incremental render).
function makeResultItem(text) {
  const item = document.createElement('div');
  item.className = 'result-item';
  const t = document.createElement('div');
  t.className = 'result-text'; t.textContent = text;
  const meta = document.createElement('div');
  meta.className = 'result-meta';
  const len = document.createElement('span');
  len.className = 'result-len'; len.textContent = `${tweetLength(text)} حرف`;
  meta.appendChild(len);
  item.append(t, meta);
  return item;
}

// Append ONE freshly-accepted tweet to the live preview as it arrives.
function appendResult(text) {
  const empty = resultsList.querySelector('.results-empty');
  if (empty) resultsList.innerHTML = '';
  resultsList.appendChild(makeResultItem(text));
  // ⚡ H3: keep state.generated in sync — appendResult is the single
  // source of truth for the preview, so the push lives here, not at
  // every call site. Prevents drift if called from elsewhere.
  if (!Array.isArray(state.generated)) state.generated = [];
  if (!state.generated.includes(text)) state.generated.push(text);
  const n = resultsList.querySelectorAll('.result-item').length;
  resultsCount.textContent = `${n} تغريدة`;
  resultsActions.classList.remove('hidden');
}

// Live preview: every tweet the engine accepts shows up immediately.
window.api.onAiPostAccepted((post) => {
  // ⚡ H3: push is now handled inside appendResult for single-source-of-truth.
  if (post && post.text) appendResult(post.text);
});

// Live per-session status (🟢🟡🔴) + cache % between rounds.
window.api.onAiSessionStatus((payload) => {
  updateSessionStatus(payload);
  if (payload && payload.totals && payload.totals.cacheHitPct != null) {
    const el = $('stat-cache'); if (el) el.textContent = `${payload.totals.cacheHitPct}%`;
  }
});

function renderResults(posts) {
  resultsList.innerHTML = '';
  if (!posts.length) {
    resultsList.innerHTML = '<div class="results-empty">لا توجد نتائج بعد. اضبط الإعدادات واضغط "توليد".</div>';
    resultsActions.classList.add('hidden');
    resultsCount.textContent = '0 تغريدة';
    return;
  }
  const frag = document.createDocumentFragment();
  posts.forEach(text => frag.appendChild(makeResultItem(text)));
  resultsList.appendChild(frag);
  resultsCount.textContent = `${posts.length} تغريدة`;
  resultsActions.classList.remove('hidden');
}

async function runGeneration() {
  const apiKey = $('ai-api-key').value.trim();
  const baseUrl = $('ai-base-url').value.trim();
  const model = $('ai-model').value.trim();
  const providerOverride = $('ai-provider-override').value;
  const referralLink = $('referral-link').value.trim();
  const quantity = parseInt($('ai-quantity').value) || 20;
  const sessionCount = parseInt(($('ai-session-count') && $('ai-session-count').value) || '5') || 5;
  const customPrompt = ($('ai-prompt') && $('ai-prompt').value.trim()) || '';

  studioWarn.textContent = '';
  if (!apiKey) { studioWarn.textContent = '⚠️ ضع مفتاح API في الإعدادات أولاً.'; switchView('settings'); return; }

  // persist link + quantity + custom prompt + session count
  window.api.saveSettings({ referralLink, aiQuantity: String(quantity), aiPrompt: customPrompt, aiSessionCount: String(sessionCount) });

  // G4.1: the preview is CUMULATIVE — it is NOT cleared between runs. New
  // tweets accumulate on top of what's already there until the user clicks
  // "🧹 مسح المعاينة". state.generated already holds the existing preview.
  if (!Array.isArray(state.generated)) state.generated = [];

  // G3 FIX: dedup scope = ONLY the current queue (what will actually be posted).
  // We intentionally EXCLUDE state.generated (the visual preview) from existingTexts
  // because: (a) the preview can accumulate hundreds of old tweets across many runs,
  // causing the Jaccard 85% gate to falsely reject all new candidates that share
  // the same narrow Arabic crypto vocabulary; (b) the preview is a display buffer,
  // not a committed-posts list — only the queue matters for true duplicate avoidance.
  // Using only queueTexts keeps the dedup scope tight and generation always works.
  const queueTexts = (state.queue || []).map(q => q.content || q.text || q).filter(Boolean);
  const existingTexts = [...queueTexts];

  btnGenerate.disabled = true;
  btnGenerate.classList.add('hidden');
  const btnStop = $('btn-stop-generate');
  if (btnStop) { btnStop.classList.remove('hidden'); btnStop.disabled = false; btnStop.textContent = '⏹️ إيقاف التوليد (احتفظ بالمقبول)'; }
  aiProgressFill.style.width = '0%';
  aiProgressText.textContent = 'بدء التوليد...';
  setStatus('جاري توليد التغريدات بالذكاء الاصطناعي...', 'busy');
  $('ai-provider-tag').textContent = providerLabel(detectProvider(baseUrl, providerOverride, model), model);

  try {
    const r = await window.api.generateAiPosts({ apiKey, baseUrl, model, providerOverride, quantity, referralLink, customPrompt, existingTexts, sessionCount });
    if (!r.success) {
      studioWarn.textContent = '❌ ' + r.error;
      addLog('فشل التوليد: ' + r.error, 'error');
      setStatus('فشل التوليد', 'err');
      return;
    }
    // Tweets already streamed into the preview live via onAiPostAccepted,
    // which pushes each into state.generated. Don't overwrite — they're synced.
    aiProgressFill.style.width = '100%';
    const doneWord = r.cancelled ? 'تم الإيقاف' : 'اكتمل';
    aiProgressText.textContent = `${doneWord}: ${r.count}/${r.requested} في ${r.rounds || r.waves} جولة`;
    const u = r.usage || {};
    const cacheNote = (u.cacheHitPct != null && u.cacheHitPct > 0)
      ? ` • كاش: ${u.cacheHitPct}% (موفّر) • ${u.calls || 0} طلب`
      : ` • ${u.calls || 0} طلب`;
    addLog(`✨ ولّد ${r.count} تغريدة (${r.label || r.provider})${cacheNote}`, 'success');
    if (u.input != null) {
      addLog(`🎟️ توكنات: إدخال ${u.input} • إخراج ${u.output} • كاش ${u.cacheRead || 0}`, 'info');
    }
    if (r.cancelled) {
      studioWarn.textContent = `⏹️ أوقفت التوليد — احتُفظ بـ ${r.count} تغريدة مقبولة في المعاينة.`;
    }
    if (r.rejectedCount) {
      const reasons = Object.entries(r.rejectedReasons || {}).map(([k, v]) => `${k}: ${v}`).join(' • ');
      addLog(`ℹ️ مرفوض: ${r.rejectedCount} (مكرر: ${r.duplicates || 0}) ← ${reasons || 'لا شيء'}`, 'info');
    }
    setStatus(r.cancelled ? 'تم الإيقاف' : 'اكتمل التوليد', '');
  } catch (e) {
    studioWarn.textContent = '❌ ' + e.message;
    addLog('خطأ غير متوقع: ' + e.message, 'error');
    setStatus('خطأ', 'err');
  } finally {
    btnGenerate.disabled = false;
    btnGenerate.classList.remove('hidden');
    btnGenerate.textContent = '✨ توليد التغريدات';
    const btnStop2 = $('btn-stop-generate');
    if (btnStop2) btnStop2.classList.add('hidden');
  }
}
btnGenerate.addEventListener('click', runGeneration);

// 🔄 Live session-count change — applies between rounds (no restart needed).
const sessionCountInput = $('ai-session-count');
if (sessionCountInput) {
  sessionCountInput.addEventListener('change', async () => {
    const n = Math.max(1, parseInt(sessionCountInput.value) || 5);
    sessionCountInput.value = n;
    try { await window.api.setSessionCount(n); } catch { /* best-effort */ }
    window.api.saveSettings({ aiSessionCount: String(n) });
    addLog(`🔄 عدد الجلسات المتوازية = ${n} (يُطبَّق بين الجولات).`, 'info');
  });
}

// 🗑️ إعادة تعيين الجلسات — wipes persisted sessions; next run starts fresh.
// FIX: also clears the accumulated preview (state.generated) so the next
// generation run starts with a clean dedup scope and cannot be blocked by
// old preview tweets that share the same Arabic crypto vocabulary.
const btnResetSessions = $('btn-reset-sessions');
if (btnResetSessions) {
  btnResetSessions.addEventListener('click', async () => {
    try { await window.api.resetSessions(); } catch { /* best-effort */ }
    // Clear the session status chips
    const row = $('ai-sessions-row'); if (row) { row.innerHTML = ''; row.classList.add('hidden'); }
    // Clear the cumulative preview so old results don't pollute the next dedup scope
    state.generated = [];
    renderResults([]);
    // Reset progress bar + text
    if (aiProgressFill) aiProgressFill.style.width = '0%';
    if (aiProgressText) aiProgressText.textContent = 'جاهز للتوليد.';
    addLog('🗑️ أُعيد تعيين الجلسات والمعاينة — التوليد القادم يبدأ من Session #1 بنطاق dedup نظيف.', 'info');
  });
}
// 🧹 مسح المعاينة — clears the cumulative preview ONLY on explicit user action.
$('btn-clear-preview').addEventListener('click', () => {
  state.generated = [];
  renderResults([]);
  addLog('🧹 مُسحت المعاينة.', 'info');
});
// Stop button: ask the engine to stop after the current wave; it returns
// everything accepted so far (already saved to history + shown in preview).
$('btn-stop-generate').addEventListener('click', async () => {
  const btnStop = $('btn-stop-generate');
  btnStop.disabled = true;
  btnStop.textContent = '⏹️ يوقف فوراً…';
  try { await window.api.cancelAiGeneration(); } catch { /* best-effort */ }
  addLog('⏹️ طلب الإيقاف الفوري — سيُقطع الطلب الجارية خلال أقل من 500ms.', 'warning');
});

$('btn-add-to-queue').addEventListener('click', async () => {
  if (!state.generated.length) return;
  const r = await window.api.addPosts(state.generated, profileSelect.value);
  await loadQueue();
  addLog(`➕ أُضيف ${r.successfullyAdded ?? r.added} تغريدة للطابور (مكرر: ${r.skippedDuplicate})`, 'success');
  switchView('queue');
});

// ═══════════ POSTING CONTROL ═══════════
function updateActionBtn() {
  if (state.isRunning) {
    btnMainAction.textContent = '⏹️ إيقاف';
    btnMainAction.classList.add('running');
  } else {
    btnMainAction.classList.remove('running');
    btnMainAction.textContent = '🚀 بدء النشر';
  }
  btnMainAction.disabled = false;
}

btnMainAction.addEventListener('click', () => {
  if (btnMainAction.disabled) return;
  if (!state.isRunning) {
    if (!state.queue.length) { addLog('⚠️ الطابور فارغ! استورد أو ولّد تغريدات أولاً', 'error'); return; }
    if (!state.outputFolder) { addLog('⚠️ اختر مجلد الإخراج أولاً!', 'error'); return; }
    state.isRunning = true;
    updateActionBtn();
    setStatus('جاري النشر...', 'busy');
    const config = {
      speed: Math.max(1, parseInt(speedInput.value) || 5),
      maxPosts: Math.max(1, parseInt(maxPostsInput.value) || 9999),
      outputFolder: state.outputFolder,
      mode: 'csv',
      profile: profileSelect.value,
      posts: state.queue,
    };
    window.api.startPosting(config).then(r => {
      if (!r.success) { addLog('فشل البدء: ' + (r.error || 'خطأ غير معروف'), 'error'); state.isRunning = false; updateActionBtn(); }
    }).catch(e => { addLog('خطأ: ' + e.message, 'error'); state.isRunning = false; updateActionBtn(); });
  } else {
    window.api.stopAutomation();
    addLog('🛑 إرسال إشارة الإيقاف...', 'warning');
  }
});

function formatTime(s) {
  const m = Math.floor(s / 60), sec = s % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

// status updates from posting engine
window.api.onStatusUpdate((status) => {
  if (status.type === 'countdown') {
    countdownEl.classList.remove('hidden');
    let c = status.countdown;
    countdownEl.textContent = formatTime(c);
    // ⚡ H4: ALWAYS clear the previous interval before creating a new
    // one — without this, overlapping countdown messages leak timers.
    if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
    countdownInterval = setInterval(() => {
      c--; if (c >= 0) countdownEl.textContent = formatTime(c);
      else { clearInterval(countdownInterval); countdownInterval = null; }
    }, 1000);
    setStatus(status.message, 'busy');
  } else {
    if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
    countdownEl.classList.add('hidden');
    setStatus(status.message, status.type === 'error' ? 'err' : status.type === 'success' ? '' : 'busy');
    addLog(status.message, status.type);
  }

  if (status.queueCount !== undefined) {
    queueCountEl.textContent = status.queueCount;
    navQueueBadge.textContent = status.queueCount;
    mQueue.textContent = status.queueCount;
  }
  if (status.stats) {
    state.stats = status.stats;
    successCountEl.textContent = status.stats.success || 0;
    failedCountEl.textContent = status.stats.failed || 0;
    mSuccess.textContent = status.stats.success || 0;
  }
  // Rate limit hit → refresh cooldown banner immediately
  if (status.rateLimited) {
    refreshCooldownBanner();
  }

  if (status.type === 'error' || status.message === 'Task completed' || status.message === 'Automation stopped by user' || status.multiDone) {
    state.isRunning = false;
    updateActionBtn();
    // refresh queue (posts were consumed)
    loadQueue();
    refreshCooldownBanner();
  }
});

// ═══════════ INIT ═══════════
document.addEventListener('DOMContentLoaded', async () => {
  const settings = await window.api.getSettings();
  applySettings(settings);
  await loadProfiles();
  await loadQueue(profileSelect.value);
  updateProviderTag();
  // Check if the current profile is already under cooldown on startup
  await refreshCooldownBanner();
  setStatus('النظام جاهز', '');
  addLog('تم تشغيل النظام بنجاح', 'success');
});
