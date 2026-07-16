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
  queue: [],       // raw queue from backend (shape preserved for start-posting)
  queueView: [],   // display items: { id, index, text, media }
  stats: { success: 0, failed: 0 },
  generated: [],   // last AI batch (array of strings) — cumulative preview
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

// counters (each figure has exactly ONE home — no duplicated chips)
const navQueueBadge = $('nav-queue-badge');
const mQueue = $('m-queue');
const mSuccess = $('m-success');
const mFailed = $('m-failed');
const mSpeed = $('m-speed');
const queueTotalNum = $('queue-total-num');

// ═══════════════════════════════════════════════════════════════════
// VirtualList — مكوّن واحد قابل لإعادة الاستخدام (الطابور + المعاينة)
//   mode 'fixed'   : ارتفاع صف ثابت (جدول الطابور)
//   mode 'dynamic' : ارتفاعات متغيرة تُقاس بعد العرض (تغريدات المعاينة)
// كل عنصر يُعرَّف بـ item.id — التفاعل مربوط بالمعرف لا بالموقع.
// ═══════════════════════════════════════════════════════════════════
function createVirtualList({ container, mode = 'fixed', itemHeight = 48, estimateHeight = 100, overscan = 8, renderItem }) {
  const spacer = document.createElement('div');
  spacer.className = 'vlist-spacer';
  container.appendChild(spacer);

  let items = [];
  let heights = [];
  let offsets = [];
  let total = 0;
  const heightCache = new Map(); // id → measured px (dynamic mode)
  const mounted = new Map();     // id → { el, index }
  let measurePending = false;
  let scrollTicking = false;

  function computeOffsets() {
    offsets = new Array(items.length);
    let top = 0;
    for (let i = 0; i < items.length; i++) {
      offsets[i] = top;
      top += heights[i];
    }
    total = top;
    spacer.style.height = total + 'px';
  }

  function findStart(scrollTop) {
    if (mode === 'fixed') return Math.min(items.length - 1, Math.max(0, Math.floor(scrollTop / itemHeight)));
    let lo = 0, hi = items.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid] <= scrollTop) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }

  function render() {
    if (!items.length) {
      for (const [, m] of mounted) m.el.remove();
      mounted.clear();
      return;
    }
    const st = container.scrollTop;
    const vh = container.clientHeight || 0;
    let start = Math.max(0, findStart(st) - overscan);
    let end;
    if (mode === 'fixed') {
      end = Math.ceil((st + vh) / itemHeight) + overscan;
    } else {
      end = start;
      while (end < items.length - 1 && offsets[end] < st + vh) end++;
      end += overscan;
    }
    end = Math.min(items.length - 1, end);

    // فك العناصر خارج النطاق (أو التي تغيّر عنصرها)
    for (const [id, m] of mounted) {
      const it = items[m.index];
      if (m.index < start || m.index > end || !it || it.id !== id) {
        m.el.remove();
        mounted.delete(id);
      }
    }
    // تركيب النطاق المرئي فقط
    for (let i = start; i <= end; i++) {
      const it = items[i];
      let m = mounted.get(it.id);
      if (!m) {
        const el = renderItem(it);
        el.classList.add('vlist-item');
        spacer.appendChild(el);
        m = { el, index: i };
        mounted.set(it.id, m);
      }
      m.index = i;
      m.el.style.top = offsets[i] + 'px';
    }
    if (mode === 'dynamic') measureSoon();
  }

  // قياس الارتفاعات الفعلية بعد التركيب (وضع dynamic) — يتقارب خلال إطار واحد
  function measureSoon() {
    if (measurePending) return;
    measurePending = true;
    requestAnimationFrame(() => {
      measurePending = false;
      let changed = false;
      for (const [id, m] of mounted) {
        const h = m.el.offsetHeight;
        if (h > 0 && Math.abs((heightCache.get(id) || 0) - h) > 0.5) {
          heightCache.set(id, h);
          changed = true;
        }
      }
      if (changed) {
        for (let i = 0; i < items.length; i++) {
          const c = heightCache.get(items[i].id);
          if (c) heights[i] = c;
        }
        computeOffsets();
        render();
      }
    });
  }

  container.addEventListener('scroll', () => {
    if (scrollTicking) return;
    scrollTicking = true;
    requestAnimationFrame(() => { scrollTicking = false; render(); });
  }, { passive: true });

  return {
    setItems(next) {
      items = next;
      if (!items.length) heightCache.clear();  // لا تسريب بعد «مسح»
      heights = items.map(it => (mode === 'fixed' ? itemHeight : (heightCache.get(it.id) || estimateHeight)));
      computeOffsets();
      render();
    },
    // إلحاق دفعة بنهاية القائمة بتكلفة O(دفعة) — بدون إعادة بناء heights/offsets
    // كاملة. هذا ما يُبقي المعاينة سلسة عند 30k-100k عنصر.
    appendItems(batch) {
      for (const it of batch) {
        items.push(it);
        const h = mode === 'fixed' ? itemHeight : (heightCache.get(it.id) || estimateHeight);
        heights.push(h);
        offsets.push(total);
        total += h;
      }
      spacer.style.height = total + 'px';
      render();
    },
    refresh() { computeOffsets(); render(); },
    forEachMounted(fn) { for (const [, m] of mounted) { const it = items[m.index]; if (it) fn(m.el, it); } },
    isNearBottom() { return container.scrollTop + container.clientHeight >= total - 160; },
    scrollToBottom() { container.scrollTop = total; },
    get mountedCount() { return mounted.size; },
  };
}

// ── +/- number steppers (موحّد) ──
document.querySelectorAll('.stepper-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const input = $(btn.dataset.target);
    if (!input) return;
    const min = parseInt(btn.dataset.min ?? '1', 10);
    const step = parseInt(btn.dataset.step, 10) || 1;
    input.value = Math.max(min, (parseInt(input.value, 10) || min) + step);
    input.dispatchEvent(new Event('change'));
  });
});

// ═══════════ NAVIGATION ═══════════
function switchView(view) {
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `view-${view}`));
  // القوائم الافتراضية تحتاج إعادة حساب عندما تصبح مرئية (clientHeight كان 0)
  if (view === 'queue') queueList.refresh();
  if (view === 'studio') studioList.refresh();
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
  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = new Date().toLocaleTimeString('en-US', { hour12: false });
  entry.appendChild(time);
  entry.appendChild(document.createTextNode(message));
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
  liveStatusEl.title = message;
  // ⚡ H6: handle 'idle' / '' (neutral) explicitly — strip busy/err so
  // the pulse dot colours correctly instead of inheriting a stale state.
  if (kind === 'busy') statusPulse.className = 'pulse busy';
  else if (kind === 'err') statusPulse.className = 'pulse err';
  else statusPulse.className = 'pulse';
}

// ═══════════ SETTINGS PERSISTENCE ═══════════
function applySettings(s) {
  if (!s) return;
  if (s.speed) { speedInput.value = s.speed; mSpeed.textContent = s.speed; }
  if (s.maxPosts) maxPostsInput.value = s.maxPosts;
  if (s.outputFolder) {
    state.outputFolder = s.outputFolder;
    folderPathDisplay.textContent = s.outputFolder;
  }
  if (s.aiProviderSelect) $('ai-provider-select').value = s.aiProviderSelect;
  syncProviderBaseUrl(); // update hidden fields from dropdown
  if (s.aiApiKey) $('ai-api-key').value = s.aiApiKey;
  if (s.aiModel) $('ai-model').value = s.aiModel;
  if (s.referralLink) $('referral-link').value = s.referralLink;
  if (s.aiQuantity) $('ai-quantity').value = s.aiQuantity;
  if (s.aiSessionCount) $('ai-session-count').value = s.aiSessionCount;
  if (s.aiPrompt) $('ai-prompt').value = s.aiPrompt;
  if (s.promptMode === 'custom') $('prompt-mode-custom').checked = true;
  else $('prompt-mode-dynamic').checked = true;
  updatePromptModeVisibility();
  updateProviderTag();
}

// وضع البرومبت: ديناميكي (افتراضي) يخفي الحقل المخصص، مخصص يظهره.
function updatePromptModeVisibility() {
  const isCustom = $('prompt-mode-custom').checked;
  $('custom-prompt-details').classList.toggle('hidden', !isCustom);
  $('dynamic-prompt-hint').classList.toggle('hidden', isCustom);
}
$('prompt-mode-dynamic').addEventListener('change', updatePromptModeVisibility);
$('prompt-mode-custom').addEventListener('change', updatePromptModeVisibility);

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

// ── PROVIDER DROPDOWN → hidden baseUrl + providerOverride sync ──────────
const PROVIDER_URLS = {
  'iamhc':       'https://api.iamhc.cn/v1',
  'iyh':         'https://v1.iyhapi.app/v1',
  'opencode-go': 'https://opencode.ai/zen/go/v1/chat/completions',
};

function syncProviderBaseUrl() {
  const sel = $('ai-provider-select');
  if (!sel) return;
  const key = sel.value || 'iamhc';
  $('ai-base-url').value = PROVIDER_URLS[key] || PROVIDER_URLS['iamhc'];
  // opencode-go needs its own provider override; others use auto-detect
  $('ai-provider-override').value = key === 'opencode-go' ? 'opencode-go' : 'auto';
  updateProviderTag();
}

$('ai-provider-select').addEventListener('change', () => {
  syncProviderBaseUrl();
  fetchedModels = []; // new provider, new models
  hideModelMenu();
  $('ai-model-hint').textContent = 'اضغط «فحص» لجلب موديلات المزوّد المختار.';
});
syncProviderBaseUrl();

// ── قائمة الموديلات المرئية — تُفتح تلقائياً بعد «فحص» وتصفّى أثناء الكتابة ──
let fetchedModels = [];
const modelMenu = $('ai-model-menu');
const modelInput = $('ai-model');

function hideModelMenu() { modelMenu.classList.add('hidden'); }

function showModelMenu(filter = '') {
  if (!fetchedModels.length) { hideModelMenu(); return; }
  const f = filter.trim().toLowerCase();
  const list = f ? fetchedModels.filter(m => m.toLowerCase().includes(f)) : fetchedModels;
  modelMenu.innerHTML = '';
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'model-menu-empty';
    empty.textContent = 'لا يوجد موديل يطابق ما كتبته — امسح الحقل لعرض الكل.';
    modelMenu.appendChild(empty);
  } else {
    const current = modelInput.value.trim();
    for (const m of list.slice(0, 300)) {
      const it = document.createElement('button');
      it.type = 'button';
      it.className = 'model-menu-item' + (m === current ? ' selected' : '');
      it.textContent = m;
      it.addEventListener('click', () => {
        modelInput.value = m;
        window.api.saveSettings({ aiModel: m });
        hideModelMenu();
        $('ai-model-hint').textContent = `✅ اختير الموديل: ${m}`;
        updateProviderTag();
      });
      modelMenu.appendChild(it);
    }
  }
  modelMenu.classList.remove('hidden');
}

modelInput.addEventListener('focus', () => showModelMenu(modelInput.value));
modelInput.addEventListener('input', () => showModelMenu(modelInput.value));
modelInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideModelMenu(); });
document.addEventListener('click', (e) => {
  if (!modelMenu.contains(e.target) && e.target !== modelInput && e.target !== $('btn-fetch-models')) {
    hideModelMenu();
  }
});

$('btn-save-ai-settings').addEventListener('click', () => {
  window.api.saveSettings({
    aiProviderSelect: $('ai-provider-select').value,
    aiApiKey: $('ai-api-key').value.trim(),
    aiModel: $('ai-model').value.trim(),
  });
  const ok = $('save-ok');
  ok.classList.remove('hidden');
  setTimeout(() => ok.classList.add('hidden'), 2000);
  updateProviderTag();
  addLog('تم حفظ إعدادات الذكاء الاصطناعي', 'success');
});

$('btn-reset-ai-settings').addEventListener('click', () => {
  if (!confirm('هل تريد إعادة تعيين جميع إعدادات الذكاء الاصطناعي؟')) return;
  $('ai-provider-select').value = 'iamhc';
  syncProviderBaseUrl();
  $('ai-api-key').value = '';
  $('ai-model').value = '';
  $('ai-prompt').value = '';
  $('prompt-mode-dynamic').checked = true;
  updatePromptModeVisibility();
  window.api.saveSettings({ aiProviderSelect: 'iamhc', aiApiKey: '', aiModel: '', aiPrompt: '', promptMode: 'dynamic' });
  updateProviderTag();
  addLog('تم إعادة تعيين إعدادات الذكاء الاصطناعي', 'info');
});

$('btn-toggle-key').addEventListener('click', () => {
  const input = $('ai-api-key');
  input.type = input.type === 'password' ? 'text' : 'password';
});

// ⚡ H1+H2+L3: provider detection lives ONLY in contentEngine.js (via IPC).
async function updateProviderTag() {
  const base = $('ai-base-url').value.trim();
  const forced = $('ai-provider-override').value;
  const model = $('ai-model').value.trim();

  if (!base && forced === 'auto' && !model) { $('ai-provider-tag').textContent = '—'; return; }

  try {
    const r = await window.api.detectProvider({ baseUrl: base, providerOverride: forced, model });
    if (r && r.provider) {
      const modelFormats = window._modelFormats || {};
      const wireFmt = modelFormats[model] || r.format || null;
      let label = r.label;
      if (wireFmt) {
        const fmtTag = wireFmt === 'anthropic' ? 'Anthropic' : wireFmt === 'gemini' ? 'Gemini' : 'OpenAI-Compatible';
        // لا تكرار: أضف نوع البروتوكول فقط إن لم يكن ضمن التسمية أصلاً
        if (!label.includes(fmtTag)) label += ` · ${fmtTag}`;
      }
      $('ai-provider-tag').textContent = label;
      return;
    }
  } catch { /* best-effort — tag stays — on next input it retries */ }
  $('ai-provider-tag').textContent = '—';
}
$('ai-model').addEventListener('input', updateProviderTag);

// 🔄 Fetch available models from the provider (real /models call)
$('btn-fetch-models').addEventListener('click', async () => {
  const btn = $('btn-fetch-models');
  const hint = $('ai-model-hint');
  syncProviderBaseUrl();
  const baseUrl = $('ai-base-url').value.trim();
  const apiKey = $('ai-api-key').value.trim();
  const providerOverride = $('ai-provider-override').value;

  if (!apiKey) { hint.textContent = '⚠️ ضع مفتاح API أولاً.'; return; }

  const original = btn.textContent;
  btn.textContent = '⏳ جاري الفحص...';
  btn.disabled = true;
  hint.textContent = 'جاري جلب الموديلات من المزوّد...';

  try {
    const r = await window.api.listModels({ baseUrl, apiKey, providerOverride });
    if (!r.success) { hint.textContent = `❌ فشل الفحص: ${r.error}`; return; }
    if (!r.models || r.models.length === 0) {
      hint.textContent = `⚠️ المزوّد (${r.provider}) لم يرجع أي موديلات.`;
      return;
    }
    fetchedModels = r.models;
    window._modelFormats = r.modelFormats || {};
    if (!$('ai-model').value.trim() && r.models.length > 0) {
      $('ai-model').value = r.models[0];
      window.api.saveSettings({ aiModel: r.models[0] });
    }
    hint.textContent = `✅ وُجد ${r.count} موديل — اختر من القائمة أو اكتب الاسم.`;
    showModelMenu(); // تفتح فوراً — المستخدم يرى القائمة كاملة بعد الفحص
    updateProviderTag();
  } catch (e) {
    hint.textContent = `❌ خطأ: ${e.message}`;
  } finally {
    btn.textContent = original;
    btn.disabled = false;
  }
});

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
    // Every profile shows its mandatory number; Default is always #1.
    opt.value = name;
    opt.textContent = name === 'Default' ? '1- الحساب الافتراضي (Default)' : name;
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

  const until = r.cooldown.until;
  const srcNote = r.cooldown.source === 'x' ? ' (مدة من تويتر)' : '';
  $('cooldown-text').textContent = `🚫 البروفايل "${profile}" ضرب حد تويتر${srcNote} — ينتهي بعد:`;
  banner.classList.remove('hidden');

  // ⚡ H5: capture the profile at creation time so the deferred refresh
  // only fires if the user is STILL on the same profile.
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

// ═══════════ QUEUE (قائمة افتراضية بارتفاع ثابت — id-based) ═══════════
const qSelection = new Set();  // معرفات العناصر المحددة
let _queueLoadSeq = 0;

function buildQueueRow(item) {
  const row = document.createElement('div');
  row.className = 'qcols qrow' + (qSelection.has(item.id) ? ' selected' : '');

  const cbCell = document.createElement('span');
  cbCell.className = 'q-center';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = qSelection.has(item.id);
  cb.addEventListener('change', () => {
    if (cb.checked) qSelection.add(item.id); else qSelection.delete(item.id);
    row.classList.toggle('selected', cb.checked);
    updateSelectionUI();
  });
  cbCell.appendChild(cb);

  const textCell = document.createElement('span');
  textCell.className = 'q-text';
  textCell.title = item.text.length > 400 ? item.text.slice(0, 400) + '…' : item.text;
  if (item.media) {
    const m = document.createElement('span');
    m.className = 'q-media';
    m.title = item.media;
    m.textContent = '🖼️';
    textCell.appendChild(m);
    textCell.appendChild(document.createTextNode(' '));
  }
  textCell.appendChild(document.createTextNode(item.text));

  const lenCell = document.createElement('span');
  lenCell.className = 'q-len';
  lenCell.textContent = tweetLength(item.text);

  const actionCell = document.createElement('span');
  actionCell.className = 'q-center';
  const del = document.createElement('button');
  del.className = 'btn btn--danger btn--sm';
  del.textContent = 'حذف';
  del.addEventListener('click', () => deleteQueueItem(item.id));
  actionCell.appendChild(del);

  row.append(cbCell, textCell, lenCell, actionCell);
  return row;
}

const queueList = createVirtualList({
  container: $('queue-list'),
  mode: 'fixed',
  itemHeight: 48,  // يطابق ارتفاع .qrow في CSS
  overscan: 10,
  renderItem: buildQueueRow,
});
const queueEmptyNote = document.createElement('div');
queueEmptyNote.className = 'empty-note';
queueEmptyNote.textContent = 'الطابور فارغ — استورد CSV أو ولّد تغريدات من الاستوديو.';
$('queue-list').appendChild(queueEmptyNote);

async function loadQueue(profile) {
  const raw = await window.api.getQueue(profile || profileSelect.value);
  state.queue = Array.isArray(raw) ? raw : [];
  const seq = ++_queueLoadSeq;
  state.queueView = state.queue.map((p, i) => {
    const isObj = p && typeof p === 'object';
    return {
      id: `q${seq}-${i}`,
      index: i,  // موقع العنصر في طابور الباكند وقت التحميل
      text: isObj ? (p.text || '') : String(p ?? ''),
      media: isObj ? (p.media_path || null) : null,
    };
  });
  qSelection.clear(); // معرفات جديدة بعد كل تحميل
  queueList.setItems(state.queueView);
  queueEmptyNote.classList.toggle('hidden', state.queueView.length > 0);
  updateQueueCounters();
  updateSelectionUI();
}

function updateQueueCounters() {
  const n = state.queue.length;
  navQueueBadge.textContent = n;
  mQueue.textContent = n;
  queueTotalNum.textContent = n;
}

function updateSelectionUI() {
  $('selected-count').textContent = qSelection.size;
  const all = $('select-all');
  all.checked = state.queueView.length > 0 && qSelection.size === state.queueView.length;
  all.indeterminate = qSelection.size > 0 && qSelection.size < state.queueView.length;
}

$('select-all').addEventListener('change', (e) => {
  qSelection.clear();
  if (e.target.checked) state.queueView.forEach(v => qSelection.add(v.id));
  queueList.forEachMounted((el, item) => {
    const checked = qSelection.has(item.id);
    const cb = el.querySelector('input[type="checkbox"]');
    if (cb) cb.checked = checked;
    el.classList.toggle('selected', checked);
  });
  updateSelectionUI();
});

async function deleteQueueItem(id) {
  // ⚡ H7: capture the profile at call time so a profile switch mid-await
  // doesn't delete or reload the wrong queue.
  const profile = profileSelect.value;
  const item = state.queueView.find(v => v.id === id);
  if (!item) return;
  await window.api.bulkDelete([item.index], profile);
  await loadQueue(profile);
}

$('btn-delete-selected').addEventListener('click', async () => {
  if (!qSelection.size) { addLog('لم تحدد أي منشور', 'warning'); return; }
  const profile = profileSelect.value;
  const idx = state.queueView.filter(v => qSelection.has(v.id)).map(v => v.index);
  await window.api.bulkDelete(idx, profile);
  await loadQueue(profile);
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
const resultsCount = $('results-count');
const resultsActions = $('results-actions');
const aiProgressFill = $('ai-progress-fill');
const studioWarn = $('studio-warn');

// المعاينة: قائمة افتراضية بارتفاعات متغيرة — id-based
let studioItems = [];              // { id, text }
const generatedSet = new Set();    // dedup سريع O(1) بدل includes O(n)
let _genSeq = 0;

function buildResultItem(item) {
  const el = document.createElement('div');
  el.className = 'result-item';
  const inner = document.createElement('div');
  inner.className = 'result-inner';

  const t = document.createElement('div');
  t.className = 'result-text';
  t.textContent = item.text;

  const meta = document.createElement('div');
  meta.className = 'result-meta';
  const len = document.createElement('span');
  len.className = 'badge badge--success';
  len.textContent = `${tweetLength(item.text)} حرفاً`;
  const copy = document.createElement('button');
  copy.className = 'btn btn--secondary btn--sm';
  copy.textContent = '📋 نسخ';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(item.text);
      copy.textContent = '✅ نُسخ';
      setTimeout(() => { copy.textContent = '📋 نسخ'; }, 1500);
    } catch { addLog('تعذّر النسخ إلى الحافظة', 'warning'); }
  });
  meta.append(len, copy);

  inner.append(t, meta);
  el.appendChild(inner);
  return el;
}

const studioList = createVirtualList({
  container: $('results-list'),
  mode: 'dynamic',
  estimateHeight: 118,
  overscan: 6,
  renderItem: buildResultItem,
});
const studioEmptyNote = document.createElement('div');
studioEmptyNote.className = 'empty-note';
studioEmptyNote.textContent = 'لا توجد نتائج بعد — اضبط الإعدادات واضغط «توليد».';
$('results-list').appendChild(studioEmptyNote);
studioList.setItems(studioItems); // محاذاة المرجع — appendItems يلحق بنفس المصفوفة

const nfmt = new Intl.NumberFormat('en-US');

function updateResultsUI() {
  resultsCount.textContent = `${nfmt.format(studioItems.length)} تغريدة`;
  resultsActions.classList.toggle('hidden', studioItems.length === 0);
  studioEmptyNote.classList.toggle('hidden', studioItems.length > 0);
}

// ── شريط التقدّم: نسبة مئوية + كسر «أُنجز / الهدف» ──
const genCounter = { accepted: 0, target: 0 };
function updateGenProgress() {
  if (!genCounter.target) {
    $('gen-pct').textContent = '0%';
    $('gen-frac').textContent = 'جاهز للتوليد';
    aiProgressFill.style.width = '0%';
    return;
  }
  const pct = Math.min(100, (genCounter.accepted / genCounter.target) * 100);
  $('gen-pct').textContent = (pct > 0 && pct < 10 ? pct.toFixed(1) : Math.round(pct)) + '%';
  $('gen-frac').textContent = `${nfmt.format(genCounter.accepted)} / ${nfmt.format(genCounter.target)}`;
  aiProgressFill.style.width = pct + '%';
}

// ── دفعات المعاينة الحية ──
// التغريدات تصل من المحرك واحدة-واحدة (قد تكون مئات في الثانية مع 10 جلسات).
// تحديث DOM لكل واحدة = تجميد. نجمعها ونفرغها دفعة واحدة كل FLUSH_MS.
const FLUSH_MS = 200;
let pendingPreview = [];
let flushTimer = null;

function flushPreview() {
  flushTimer = null;
  if (!pendingPreview.length) return;
  const batch = pendingPreview;
  pendingPreview = [];
  const stick = studioList.isNearBottom();
  studioList.appendItems(batch); // O(دفعة) — studioItems نفس المرجع
  if (stick) studioList.scrollToBottom();
  updateResultsUI();
  updateGenProgress();
}

function appendResult(text) {
  if (generatedSet.has(text)) return;
  generatedSet.add(text);
  state.generated.push(text);
  pendingPreview.push({ id: `g${++_genSeq}`, text });
  if (!flushTimer) flushTimer = setTimeout(flushPreview, FLUSH_MS);
}

function clearResults() {
  pendingPreview = [];
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  state.generated = [];
  generatedSet.clear();
  studioItems = [];
  studioList.setItems(studioItems);
  updateResultsUI();
}

// Live preview: every accepted tweet is queued; the flush timer renders it.
window.api.onAiPostAccepted((post) => {
  if (!post || !post.text) return;
  if (post.target) {
    genCounter.target = post.target;
    if (post.index > genCounter.accepted) genCounter.accepted = post.index;
  }
  appendResult(post.text);
});

// The DEFAULT prompt shown when the user clicks "📋 الافتراضي". Display copy
// for editing — the real default lives in contentEngine and never mutates.
const DEFAULT_PROMPT_TEXT = [
  'أنت خبير محتوى X (تويتر) متخصص في أسواق الكريبتو والتداول، تكتب بالعربية الفصحى بأسلوب صانع محتوى مؤثر يوقف القارئ عن التمرير.',
  'مهمتك: تغريدات تقدم قيمة حقيقية تُبنى بها الثقة، وتشجع بلطف على التداول عبر منصة MEXC.',
  'قواعد صارمة يجب الالتزام بها حرفياً:',
  '- اكتب نص التغريدة فقط (بدون روابط وبدون هاشتاقات — سأضيفها أنا لاحقاً).',
  '- طول كل نص بين 190 و 225 حرفاً — استغل المساحة كاملة: فكرة غنية مكتملة، لا جملاً مبتورة.',
  '- ابدأ بإيموجي واحد مناسب ثم «خطّاف» قوي في أول كلمات: سؤال مثير، رقم لافت، خطأ شائع، أو حقيقة مخالفة للمتوقع.',
  '- نوّع أنماط التغريدات إلزامياً: نصيحة عملية قابلة للتطبيق فوراً، تحذير من خطأ يقع فيه المبتدئون، معلومة عن السوق، سؤال تفاعلي يحفز الردود، قاعدة من قواعد إدارة المخاطر، مقارنة توضح فكرة، درس مستفاد من موقف تداول.',
  '- كل تغريدة تعطي القارئ فائدة ملموسة يخرج بها حتى لو لم يضغط أي رابط.',
  '- اختم بدعوة لطيفة مرتبطة بمضمون التغريدة نحو التجربة عبر MEXC — بصيغة مختلفة كل مرة وبدون إلحاح.',
  '- ممنوع منعاً باتاً تكرار أي كلمة بشكل متجاور (مثل "تام تام").',
  '- ممنوع الحشو والعبارات المستهلكة المكررة (مثل "لا تفوت الفرصة") والكلمات الفارغة.',
  '- كل تغريدة مختلفة تماماً عن الأخرى في الصياغة والزاوية والنمط.',
  '- لغة عربية راقية، واثقة، بدون مبالغات كاذبة، بدون وعود ربح مضمون.',
  '- لا تذكر روابط ولا علامات # إطلاقاً داخل النص.',
  '- ممنوع علامات الاقتباس أو كتابة عدد الحروف أو ترقيم التغريدة.',
  '- استخدم إيموجي حقيقية فقط، لا رموز مكسورة — ويجوز إيموجي إضافي داخل النص إن خدم المعنى.',
  'أعِد الناتج حصراً كمصفوفة JSON من النصوص فقط بدون أي شرح: ["نص","نص",...]',
].join('\n');

$('btn-default-prompt').addEventListener('click', () => {
  const ta = $('ai-prompt');
  ta.value = DEFAULT_PROMPT_TEXT;
  ta.focus();
  addLog('📋 تم تحميل البرومبت الافتراضي في الحقل — عدّله كما تريد.', 'info');
});

// حالة الجلسات: صامتة تماماً إلا عند وجود أخطاء (بانر أحمر واحد).
// كل التفاصيل الأخرى مكانها سجل النشاط في لوحة التحكم.
function updateSessionStatus(payload) {
  const banner = $('ai-error-banner');
  if (!payload || !Array.isArray(payload.sessions)) return;
  const errors = [];
  for (const s of payload.sessions) {
    if (s.lastError) errors.push(`#${s.num}: ${s.lastError}`);
  }
  if (errors.length > 0) {
    // With large pools, show the first 5 errors only — a banner with
    // hundreds of entries freezes the layout and helps no one.
    const shown = errors.slice(0, 5);
    const extra = errors.length - shown.length;
    banner.textContent = '⚠️ أخطاء الجلسات: ' + shown.join(' | ')
      + (extra > 0 ? ` | +${extra} جلسات أخرى فيها أخطاء` : '');
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

// progress listener — الأرقام تذهب للبار، الرسائل النصية تذهب للسجل فقط.
window.api.onAiProgress((msg) => {
  if (msg.target) {
    genCounter.target = msg.target;
    if (msg.accepted != null) genCounter.accepted = msg.accepted;
    updateGenProgress();
  }
  addLog('🧠 ' + msg.message, msg.type || 'info');
});

// Live per-session status counts between rounds.
window.api.onAiSessionStatus((payload) => {
  updateSessionStatus(payload);
});

async function runGeneration() {
  syncProviderBaseUrl(); // ensure hidden fields reflect current dropdown
  const apiKey = $('ai-api-key').value.trim();
  const baseUrl = $('ai-base-url').value.trim();
  const model = $('ai-model').value.trim();
  const providerOverride = $('ai-provider-override').value;
  const referralLink = $('referral-link').value.trim();
  const quantity = parseInt($('ai-quantity').value, 10) || 20;
  const sessionCount = parseInt($('ai-session-count').value, 10) || 5;
  const customPrompt = $('ai-prompt').value.trim();
  const promptMode = $('prompt-mode-custom').checked ? 'custom' : 'dynamic';

  studioWarn.textContent = '';
  if (!apiKey) { studioWarn.textContent = '⚠️ ضع مفتاح API في الإعدادات أولاً.'; switchView('settings'); return; }

  window.api.saveSettings({ referralLink, aiQuantity: String(quantity), aiPrompt: customPrompt, aiSessionCount: String(sessionCount), promptMode });

  // G4.1: the preview is CUMULATIVE — it is NOT cleared between runs. New
  // tweets accumulate until the user clicks "🧹 مسح". state.generated
  // already holds the existing preview.

  // Dedup scope = queue + preview. The preview is included on purpose:
  // tweets sitting there are one click away from the queue, so a new
  // candidate repeating their meaning IS a duplicate. The old bigram gate
  // couldn't include the preview without false rejections; the IDF-weighted
  // semantic index in the main process handles shared domain vocabulary, so
  // both sources are now safe to compare against.
  const queueTexts = state.queue.map(q => (q && typeof q === 'object' ? q.text : q)).filter(Boolean);
  const previewTexts = (state.generated || []).map(g => (g && typeof g === 'object' ? g.text : g)).filter(Boolean);
  const existingTexts = [...queueTexts, ...previewTexts];

  btnGenerate.disabled = true;
  btnGenerate.classList.add('hidden');
  const btnStop = $('btn-stop-generate');
  btnStop.classList.remove('hidden');
  btnStop.disabled = false;
  btnStop.textContent = '⏹️ إيقاف التوليد (احتفظ بالمقبول)';
  genCounter.accepted = 0;
  genCounter.target = quantity;
  updateGenProgress();
  $('ai-status-box').classList.add('running');
  setStatus('جاري توليد التغريدات بالذكاء الاصطناعي...', 'busy');
  $('ai-provider-tag').textContent = '—';
  window.api.detectProvider({ baseUrl, providerOverride, model }).then(r => {
    if (r && r.label) $('ai-provider-tag').textContent = r.label;
  }).catch(() => {});

  try {
    const r = await window.api.generateAiPosts({ apiKey, baseUrl, model, providerOverride, quantity, referralLink, customPrompt, existingTexts, sessionCount, promptMode });
    if (!r.success) {
      studioWarn.textContent = '❌ ' + r.error;
      addLog('فشل التوليد: ' + r.error, 'error');
      setStatus('فشل التوليد', 'err');
      return;
    }
    // Tweets already streamed into the preview live via onAiPostAccepted.
    updateGenProgress();
    const doneWord = r.cancelled ? 'تم الإيقاف' : 'اكتمل';
    addLog(`${doneWord}: ${r.count}/${r.requested} في ${r.rounds || r.waves} جولة`, 'info');
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
    $('btn-stop-generate').classList.add('hidden');
    $('ai-status-box').classList.remove('running');
  }
}
btnGenerate.addEventListener('click', runGeneration);

// 🔄 Live session-count change — applies between rounds (no restart needed).
$('ai-session-count').addEventListener('change', async () => {
  const input = $('ai-session-count');
  const n = Math.max(1, parseInt(input.value, 10) || 5);
  input.value = n;
  try { await window.api.setSessionCount(n); } catch { /* best-effort */ }
  window.api.saveSettings({ aiSessionCount: String(n) });
  addLog(`🔄 عدد الجلسات المتوازية = ${n} — بلا حد أقصى، ويُطبَّق مباشرة أثناء التشغيل (الجلسات الجديدة تنطلق تدريجياً).`, 'info');
});

// 🗑️ إعادة تعيين الجلسات — wipes persisted sessions; next run starts fresh.
// Also clears the accumulated preview so the next generation starts with a
// clean dedup scope.
$('btn-reset-sessions').addEventListener('click', async () => {
  try { await window.api.resetSessions(); } catch { /* best-effort */ }
  $('ai-error-banner').classList.add('hidden');
  genCounter.accepted = 0;
  genCounter.target = 0;
  updateGenProgress();
  clearResults();
  addLog('🗑️ أُعيد تعيين الجلسات والمعاينة — التوليد القادم يبدأ من Session #1 بنطاق dedup نظيف.', 'info');
});

// 🧹 مسح المعاينة — clears the cumulative preview ONLY on explicit user action.
$('btn-clear-preview').addEventListener('click', () => {
  clearResults();
  addLog('🧹 مُسحت المعاينة.', 'info');
});

// Stop button: ask the engine to stop; it keeps everything accepted so far.
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
      speed: Math.max(1, parseInt(speedInput.value, 10) || 5),
      maxPosts: Math.max(1, parseInt(maxPostsInput.value, 10) || 9999),
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
    // ⚡ H4: ALWAYS clear the previous interval before creating a new one.
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
    navQueueBadge.textContent = status.queueCount;
    mQueue.textContent = status.queueCount;
    queueTotalNum.textContent = status.queueCount;
    // A published post is deleted from the queue the moment it goes out, so
    // refresh the list as the count drops while the user is watching it —
    // otherwise it would sit there showing already-published posts until the
    // run ended. Only while the queue view is actually visible: this is an IPC
    // round-trip plus a list rebuild, and it fires at most once per post.
    if (state.isRunning && $('view-queue').classList.contains('active')) loadQueue();
  }
  if (status.stats) {
    state.stats = status.stats;
    mSuccess.textContent = status.stats.success || 0;
    mFailed.textContent = status.stats.failed || 0;
  }
  // Rate limit hit → refresh cooldown banner immediately
  if (status.rateLimited) refreshCooldownBanner();

  // ⚡ FIX: 'Task completed' fires once PER PROFILE (a single account finishing
  // its own queue slice), and type==='error' fires on ordinary per-profile
  // events like a rate limit — neither means the multi-account BATCH is done.
  // Using them here used to flip the UI back to idle (re-enabling "بدء النشر")
  // while the backend was still working through the remaining accounts.
  // Only multiDone (sent once, after the whole profiles loop finishes) or an
  // explicit user-stop message are real end-of-run signals.
  if (status.multiDone || status.message === 'Automation stopped by user') {
    state.isRunning = false;
    updateActionBtn();
    loadQueue();          // posts were consumed
    refreshCooldownBanner();
  }
});

// ═══════════ RESIZE (debounced — يعيد حساب القوائم الافتراضية فقط) ═══════════
let _resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => {
    queueList.refresh();
    studioList.refresh();
  }, 250);
});

// ═══════════ INIT ═══════════
document.addEventListener('DOMContentLoaded', async () => {
  const settings = await window.api.getSettings();
  applySettings(settings);
  await loadProfiles();
  await loadQueue(profileSelect.value);
  updateProviderTag();
  updateResultsUI();
  await refreshCooldownBanner();
  setStatus('النظام جاهز', '');
  addLog('تم تشغيل النظام بنجاح', 'success');
});
