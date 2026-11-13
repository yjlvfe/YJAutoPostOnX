'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { accountCapacity, quotaAdmission, estimateCycle, riyadhDay } = require('./quota');
const { DEFAULT_SETTINGS, parseDuration, formatDuration } = require('./settings');
const { riyadhDateParts, scheduleOccurrence, sameOccurrence, matchesScheduleOccurrence } = require('./scheduling');
const { TelegramFlows } = require('./telegramFlows');
const { preTable, richTable, formatAccountTable, getCurrentRunTotals, clean, escapeHtml } = require('./accountTable');
const { isConflict409 } = require('./singleInstance');
const { moveItemToQueueTail, isProvenPreDispatch, isClaimableInState, protectedTextKeys } = require('./queue');
const { logStructured, sanitizeError, extractErrorCode } = require('./structuredLogger');
const {
  isCaptchaStatus,
  isBannedStatus,
  isUnverifiedStatus,
  isAccountInactive,
  evaluateAccountUse,
  applyOwnerEnabled
} = require('./accounts');
const { isPublicIp } = require('./publicIp');

const MAX_ACTIVE_ACCOUNTS = 5;
const MAX_SCHEDULE_PREP_LAG_MS = 30 * 60 * 1000;

function isNotifyResultSuppressed(res) {
  const isDeliveredItem = item => Boolean(item && (item.status
    ? item.status === 'fulfilled' && item.value && (item.value.ok === true || item.value.message_id != null || item.value.result?.message_id != null)
    : (item.ok === true || item.message_id != null || item.result?.message_id != null)));
  return res === null || res === false || (Array.isArray(res) && !res.some(isDeliveredItem));
}

const PENDING_VPN_RELEASES = new WeakMap();
function trackVpnRelease(store, accountId, promise) {
  if (!store || !accountId || !promise || typeof promise.then !== 'function') return promise;
  let map = PENDING_VPN_RELEASES.get(store);
  if (!map) { map = new Map(); PENDING_VPN_RELEASES.set(store, map); }
  map.set(String(accountId), promise);
  promise.finally(() => { if (map.get(String(accountId)) === promise) map.delete(String(accountId)); }).catch(() => {});
  return promise;
}
async function awaitVpnRelease(store, accountId) {
  if (!store || !accountId) return;
  const map = PENDING_VPN_RELEASES.get(store);
  const pending = map?.get(String(accountId));
  if (pending) await pending.catch(() => {});
}

const ISOLATION_REASONS = {
  BANNED: 'محظور قطعي (Permanent Ban)',
  CAPTCHA: 'تحدي أمني / كابتشا (Security Challenge / CAPTCHA)',
  STRIKES_EXCEEDED: 'تجاوز 3 إخفاقات طبيعية (Exceeded 3 qualified strikes)',
  COOKIE_REJECTED: 'رفض جلسة الكوكيز (Session rejected / invalid cookies)'
};

function formatIsolationReason(reason) {
  if (!reason) return ISOLATION_REASONS.STRIKES_EXCEEDED;
  const str = String(reason).toLowerCase().trim();
  if (/banned|محظور|suspended|permanent/i.test(str)) {
    return ISOLATION_REASONS.BANNED;
  }
  if (/captcha|كابتشا|challenge|security/i.test(str)) {
    return ISOLATION_REASONS.CAPTCHA;
  }
  if (/cookie|جلسة|session|auth_rejected|token|كوكيز/i.test(str)) {
    return ISOLATION_REASONS.COOKIE_REJECTED;
  }
  if (/strike|failure|إخفاق|3|three/i.test(str)) {
    return ISOLATION_REASONS.STRIKES_EXCEEDED;
  }
  return reason;
}

function buildIsolationMessage({ username, reason, otherActiveCount = 0 }) {
  const cleanUsername = username ? `@${String(username).replace(/^@/, '')}` : 'الحساب';
  const formattedReason = formatIsolationReason(reason);
  const captchaInstruction = ' (حل التحقق من X بنفسك عبر الموقع/التطبيق الرسمي ثم اضغط تم الحل)';
  const extra = formattedReason === ISOLATION_REASONS.CAPTCHA ? captchaInstruction : '';

  if (reason === 'auth_session_unverified' || String(reason).includes('غير محقق')) {
    if (otherActiveCount > 0) {
      return `⚠️ تنبيه للحساب ${cleanUsername}: جلسة غير مؤكدة / السبب غير محدد (auth_session_unverified). تم إيقاف الحساب، ومواصلة الدورة عبر بقية الحسابات (${otherActiveCount}). يرجى فحص الحساب عبر الموقع الرسمي لـ X.`;
    }
    return `⚠️ تنبيه للحساب ${cleanUsername}: جلسة غير مؤكدة / السبب غير محدد (auth_session_unverified). تم إيقاف الحساب وتوقفت الدورة. يرجى فحص الحساب عبر الموقع الرسمي لـ X.`;
  }

  if (otherActiveCount > 0) {
    return `تم عزل الحساب ${cleanUsername} تلقائياً (السبب: ${formattedReason})${extra} ومواصلة الدورة عبر بقية الحسابات (${otherActiveCount}).`;
  }
  return `تم عزل الحساب ${cleanUsername} تلقائياً (السبب: ${formattedReason})${extra}. لا توجد حسابات مؤهلة متبقية؛ توقفت الدورة.`;
}

const formatDurationAdaptive = seconds => {
  if (!Number.isFinite(seconds)) return '-';
  const n = Math.max(0, Math.ceil(seconds));
  if (n < 3600) {
    const mins = Math.floor(n / 60);
    const secs = n % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  const hours = Math.floor(n / 3600);
  const mins = Math.floor((n % 3600) / 60);
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
};
const formatElapsedHms = seconds => {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00:00';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
};
const riyadhClockFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Riyadh', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});
function formatRiyadhClock(ms) {
  if (!Number.isFinite(ms) || !Number.isFinite(new Date(ms).getTime())) return '-';
  return riyadhClockFormatter.format(new Date(ms));
}
const durationText = seconds => formatDurationAdaptive(seconds);
const token = () => crypto.randomBytes(12).toString('hex');
const cycleRunning = state => ['running', 'stopping'].includes(state?.cycle?.state);
const validText = value => typeof value === 'string' && value.trim() && true;
const eligible = account =>
  Boolean(account) &&
  account.enabled !== false &&
  !account.needsOwnerCaptcha &&
  !isCaptchaStatus(account.status) &&
  !isBannedStatus(account.status) &&
  account.status !== 'معزول (3 إخفاقات)' &&
  typeof account.cookieFile === 'string' &&
  account.cookieFile.trim();
const validSettings = settings => Number.isSafeInteger(settings.delayMs) && settings.delayMs >= 0 && (settings.dailyQuota == null || (Number.isSafeInteger(settings.dailyQuota) && settings.dailyQuota > 0));

class TelegramUi {
  constructor({ bot, vpnManager, runtimeReady = async () => ({ ready: false, reasons: ['مكونات النشر الفعلي غير جاهزة'] }), launch, clock = () => new Date(), inlineStyles = true, downloadDocument, downloadDocumentToFile, isolatedVerifier, onCycleFinished, onCycleStop, onPanelTask, notify, accountRefreshRetryMs = 2000, autoStartTicker = true, exportTodayLinks, normalizedDashboardReader = null, normalizedDashboardIntervalMs = 1000, panelTransientRetryBaseMs = 2000, panelTransientRetryMaxAttempts = 5, prepareCycle = null, drainWorkers = null, workerPool = null, ...rest }) {
    this.exportTodayLinks = exportTodayLinks;
    this.bot = bot; this.vpnManager = vpnManager || null; this.runtimeReady = runtimeReady; this.launch = launch; this.clock = clock; this.inlineStyles = inlineStyles;
    this.isolatedVerifier = isolatedVerifier;
    this.accountRefreshJob = null; this.accountRefreshRetryMs = accountRefreshRetryMs; this.destroyed = false;
    this.prepareCycle = prepareCycle || rest.prepareWorkers || null;
    this.drainWorkers = drainWorkers || null;
    this.workerPool = workerPool || rest.workerPool || null;
    this.controlFlights = new Map();
    this.controlTasks = new Set();
    this.controlTaskGeneration = 0;
    this.stopGeneration = 0;
    this.pendingStartAbortController = null;
    this.pendingStartAbortControllers = new Set();
    this.activeStartFlight = null;
    this.isPreparing = false;
    this.preparingGeneration = 0;
    this.normalizedDashboardReader = normalizedDashboardReader;
    this.normalizedDashboardIntervalMs = normalizedDashboardIntervalMs;
    this.normalizedDashboardLoop = null;
    this.normalizedPanelSnapshot = null;
    this.normalizedPanelSignature = null;
    this.panelBlockedUntil = new Map();
    this.panelLastEdit = new Map();
    this.pendingPanelDeliveries = new Set();
    this.panelRetryTimers = new Map();
    this.panelTransientRetryBaseMs = Number.isFinite(panelTransientRetryBaseMs) ? panelTransientRetryBaseMs : 2000;
    this.panelTransientRetryMaxAttempts = Number.isInteger(panelTransientRetryMaxAttempts) && panelTransientRetryMaxAttempts >= 0 ? panelTransientRetryMaxAttempts : 5;
    this.panelTransientRetryCounts = new Map();
    this.transitionalBubbles = new Map();
    this.onPanelTask = typeof onPanelTask === 'function' ? onPanelTask : null;
    this.stallAlertSent = false;
    this.rawNotify = notify;
    this.notify = async (text, options) => {
      if (!this.rawNotify) return null;
      if (typeof text === 'string') {
        if (text.includes('جميع الحسابات غير مؤهلة أو في فترة انتظار')) {
          if (this.stallAlertSent) {
            logStructured(this.bot?.logger, {
              level: 'info',
              component: 'telegram_ui',
              event: 'notification_suppressed',
              operation: 'notify',
              result: 'suppressed',
              suppressionReason: 'stall_alert_already_sent'
            });
            return null;
          }
          const out = await this.rawNotify(text, options);
          if (!isNotifyResultSuppressed(out)) this.stallAlertSent = true;
          return out;
        }
        if (/إخفاق مؤقت|محاولة (1|2) من 3|strike [12]\b/i.test(text)) {
          logStructured(this.bot?.logger, {
            level: 'info',
            component: 'telegram_ui',
            event: 'notification_suppressed',
            operation: 'notify',
            result: 'suppressed',
            suppressionReason: 'transient_strike_suppressed'
          });
          return null;
        }
        if (text.includes('تم عزل الحساب') && !text.includes('(السبب:')) {
          text = text
            .replace(/\(كابتشا\)/g, `(السبب: ${ISOLATION_REASONS.CAPTCHA})`)
            .replace(/\(محظور\)/g, `(السبب: ${ISOLATION_REASONS.BANNED})`)
            .replace(/\(معزول \(3 إخفاقات\)\)/g, `(السبب: ${ISOLATION_REASONS.STRIKES_EXCEEDED})`)
            .replace(/\(جلسة مرفوضة\)/g, `(السبب: ${ISOLATION_REASONS.COOKIE_REJECTED})`);
        }
      }
      return this.rawNotify(text, options);
    };
    this.onCycleFinished = onCycleFinished; this.onCycleStop = onCycleStop; this.job = null; this.activeRun = null; this.panelLocks = new Map(); this.actionLocks = new Map(); this.refreshTask = null;
    this.flows = new TelegramFlows(this, { downloadDocument, downloadDocumentToFile, isolatedVerifier });
    const { TransientNotices } = require('./transientNotices');
    if (this.bot?.store?.load && this.bot?.store?.update && this.bot?.transport?.deleteMessage) {
      this.transientNotices = new TransientNotices({
        store: this.bot.store, transport: this.bot.transport,
        clock: () => new Date(this.clock()).getTime(), logger: this.bot.logger
      });
    }
    if (autoStartTicker) this.startTicker();
  }
  async initializeFastNavigation() {
    const state=await this.bot.store.load();
    const {FastNavigation}=require('./fastNavigation');
    this.fastNavigation=new FastNavigation(this,state);
    this.bot.store.navigationUi=this.fastNavigation;
    this.fastNavigation.unsubscribe=this.bot.store.onMutation?.(s=>this.fastNavigation.observe(s));
    this.staticMenus={main:{text:'القائمة الرئيسية',reply_markup:this.bot.transport.keyboard('main')}};
    this.settingsMenus=[false,true].map(enabled=>({text:'الإعدادات',reply_markup:this.bot.transport.keyboard('settings',null,{styles:{'الجدولة':enabled?'success':'danger'}})}));
    this.accountsMenu=this.bot.transport.keyboard('accounts',[['الحسابات','تفعيل / إلغاء تفعيل','رجوع']]);
    await this.fastNavigation.build(state);
    this.evaluateDashboardPolling();
  }
  isDashboardActive() {
    const snapshotState = this.fastNavigation?.snapshot?.cycle?.state;
    const isPosting = ['running', 'stopping'].includes(snapshotState);
    const isChecking = Boolean(this.accountRefreshJob || (this.accountCheckTasks && this.accountCheckTasks.size > 0));
    const isPreparing = Boolean(this.isPreparing);
    return isPosting || isChecking || isPreparing;
  }
  evaluateDashboardPolling() {
    if (this.isDashboardActive()) {
      this.startNormalizedDashboardLoop();
    } else {
      if (this.normalizedDashboardLoop) {
        this.stopNormalizedDashboardLoop().catch(() => {});
      } else {
        this.normalizedDashboardLoop = null;
      }
    }
  }
  startNormalizedDashboardLoop() {
    if (!this.normalizedDashboardReader || this.normalizedDashboardLoop || this.destroyed) return;
    const { DashboardDeliveryLoop } = require('./normalizedDashboard');
    this.normalizedDashboardLoop = new DashboardDeliveryLoop({
      reader: { read: () => this.readDashboardSnapshot() },
      intervalMs: this.normalizedDashboardIntervalMs || 1000,
      ui: this
    });
    this.normalizedDashboardLoop.start();
  }
  async stopNormalizedDashboardLoop() {
    if (!this.normalizedDashboardLoop) return;
    const loop = this.normalizedDashboardLoop;
    this.normalizedDashboardLoop = null;
    await loop.stop().catch(() => {});
  }
  async _finishAbortedPreparing(prepGen, panel = null) {
    if (prepGen == null || this.preparingGeneration !== prepGen) return;
    this.isPreparing = false;
    this.evaluateDashboardPolling();
    if (this.destroyed) return;
    const refreshTask = (this.normalizedDashboardReader ? this.readFreshDashboard().catch(() => {}) : Promise.resolve())
      .then(() => {
        if (!this.destroyed) return this.refreshPanels(true).catch(() => {});
      });
    if (panel?.deferNavigation) {
      this.trackNavigationDelivery?.(refreshTask);
      return;
    }
    await refreshTask;
  }
  async readFreshDashboard() {
    if (this.normalizedDashboardReader) {
      const snapshot = await this.normalizedDashboardReader.read();
      if (snapshot) {
        await this.applyNormalizedDashboardSnapshot(snapshot, { fromLoop: true });
        return snapshot;
      }
    }
    const state = await this.bot.store.load();
    if (this.fastNavigation) {
      await this.fastNavigation.build(state);
    }
    return state;
  }
  readDashboardSnapshot() {
    if (this.dashboardReadTask) return this.dashboardReadTask;
    const uiSourceGeneration = this.fastNavigation?.generation || 0;
    const uiReadSequence = (this.dashboardReadSequence || 0) + 1;
    this.dashboardReadSequence = uiReadSequence;
    const started = performance.now();
    const work = Promise.resolve().then(() => this.normalizedDashboardReader.read()).then(snapshot => {
      logStructured(this.bot?.logger, { component: 'telegram_ui', event: 'dashboard_snapshot_timing',
        durationMs: Math.round(performance.now() - started), operation: 'dashboard.read', result: 'confirmed',
        details: { sequence: uiReadSequence, intervalMs: this.normalizedDashboardIntervalMs || 1000 } });
      return { ...snapshot, uiSourceGeneration, uiReadSequence };
    }).finally(() => { if (this.dashboardReadTask === work) this.dashboardReadTask = null; });
    this.dashboardReadTask = work;
    return work;
  }
  async applyNormalizedDashboardSnapshot(snapshot, options = {}) {
    if (this.destroyed || !snapshot || !this.fastNavigation) return;
    const fromLoop = Boolean(
      options?.fromLoop ||
      options?.polling ||
      options?.isTick ||
      options?.tick ||
      options?.deliver === false ||
      (options?.generation != null && options?.forceDelivery !== true)
    );
    const nav = this.fastNavigation;
    if (snapshot.uiSourceGeneration != null && snapshot.uiSourceGeneration !== nav.generation) {
      if (nav.dirty && !nav.closed && !this.destroyed) {
        nav.scheduleCoalescedRefresh?.();
      }
      return;
    }
    if (snapshot.uiReadSequence != null && snapshot.uiReadSequence <= (this.appliedDashboardSequence || 0)) return;
    if (snapshot.uiReadSequence != null) this.appliedDashboardSequence = snapshot.uiReadSequence;
    // Fence full builds started before this committed small projection.
    nav.projectionVersion = (nav.projectionVersion || 0) + 1;
    nav.dirty = false;
    nav._supersededRefreshCount = 0;
    nav.eventBuild = false;
    nav.validUntil = Date.now() + (this.normalizedDashboardIntervalMs || 1000);
    const signature = JSON.stringify({
      cycle: snapshot.cycle,
      counts: snapshot.counts,
      claimablePending: snapshot.claimablePending,
      active: snapshot.active,
      accounts: snapshot.accounts,
      quota: snapshot.quota,
      vpnSlots: snapshot.vpnSlots,
      accountChecks: snapshot.accountChecks,
      posting: snapshot.posting,
      runTotals: snapshot.runTotals,
      eta: snapshot.eta,
      dailyCounters: snapshot.dailyCounters || snapshot.daily_counters || null,
      settings: snapshot.settings ? {
        delayMinSeconds: snapshot.settings.delayMinSeconds,
        delayMaxSeconds: snapshot.settings.delayMaxSeconds,
        dailyQuota: snapshot.settings.dailyQuota
      } : null,
      preparing: Boolean(this.isPreparing),
      activeCheckCount: this.accountCheckTasks?.size || 0,
      refreshingIds: [...(this.accountRefreshJob?.pending || [])]
    });
    this.normalizedPanelSnapshot = snapshot;
    this.fastNavigation.snapshot = { ...(this.fastNavigation.snapshot || {}), cycle: snapshot.cycle };
    const running = ['running', 'stopping'].includes(snapshot.cycle?.state);
    if (!this.isDashboardActive() && this.normalizedDashboardLoop) {
      this.stopNormalizedDashboardLoop().catch(() => {});
    }
    if (signature === this.normalizedPanelSignature) {
      // A projection is not a delivery receipt. Revisit undelivered/429-blocked
      // panels; panel() suppresses identical received text and honors retry_after.
      if (!fromLoop) {
        await this.refreshPanels(true);
      } else if (this.isDashboardActive() || this.hasPendingPanelDelivery()) {
        await this.refreshPanels(false);
      }
      return;
    }
    const state = this.normalizedProjectionState(snapshot);
    const nextAtMs = Date.parse(snapshot.posting?.nextPostAt || '');
    const publishingAtMs = Date.parse(snapshot.posting?.publishingAt || '');
    const eta = snapshot.eta || { seconds: null, nextAt: Number.isFinite(nextAtMs) ? nextAtMs : null,
      finishAt: null, reason: running ? 'projection_unavailable' : 'not_running' };
    const dailyCounters = snapshot.dailyCounters || snapshot.daily_counters || {};
    const panelView = {
      eta,
      running,
      preparing: Boolean(this.isPreparing),
      startedAt: Date.parse(snapshot.cycle?.startedAt || ''),
      publishingAt: publishingAtMs,
      active: state.accounts.filter(a => eligible(a) && (a.failures || 0) < 3).length,
      stoppedStatus: 'متوقف',
      queueTotal: Number(snapshot.claimablePending ?? snapshot.counts?.pending ?? 0),
      succeeded: Number(dailyCounters.published ?? snapshot.runTotals?.succeeded ?? 0),
      failed: Number(dailyCounters.failed ?? snapshot.runTotals?.failed ?? 0),
      todaySuccess: Number(dailyCounters.published ?? snapshot.runTotals?.succeeded ?? 0),
      todayFailed: Number(dailyCounters.failed ?? snapshot.runTotals?.failed ?? 0),
      todayPreDispatchRetries: Number(dailyCounters.preDispatchRetries ?? 0),
      mode: 'rich',
      accounts: formatAccountTable(state, { now: this.clock(), refreshingIds: this.accountRefreshJob?.pending, mode: 'rich' })
    };
    this.normalizedPanelSnapshot = snapshot;
    this.normalizedPanelSignature = signature;
    this.fastNavigation.panelView = panelView;
    this.fastNavigation.html = this.renderPanelView(panelView);
    this.fastNavigation.snapshot = { ...(this.fastNavigation.snapshot || {}), cycle: snapshot.cycle };
    this.fastNavigation.accountsHtml = formatAccountTable(state, { now: this.clock(), all: true, refreshingIds: this.accountRefreshJob?.pending, mode: 'rich' });
    this.fastNavigation.accountIds = state.accounts.map(account => account.id);
    this.fastNavigation.validUntil = Date.now() + (this.normalizedDashboardIntervalMs || 1000);
    this.syncPanelClock();
    if (options.polling === true) {
      // A projection update is accepted even when Telegram delivery is still
      // pending or rejected. panel() records the retry gate; callers must not
      // mistake a failed edit for a failed database projection.
      await this.refreshPanels(!this.isDashboardActive()).catch(error => this._logWarn('panel_refresh_after_projection_failed', 'applyNormalizedDashboardSnapshot', error));
    } else if (!fromLoop) {
      // Explicit projection/event paths retain their forced delivery semantics.
      await this.refreshPanels(true).catch(error => this._logWarn('panel_refresh_after_projection_failed', 'applyNormalizedDashboardSnapshot', error));
    }
  }
  normalizedProjectionState(snapshot) {
    const quota = {};
    for (const account of snapshot.accounts || []) {
      quota[snapshot.quota?.day || ''] ||= {};
      quota[snapshot.quota?.day || ''][account.id] = Number(account.quota_used || 0);
    }
    const accounts = (snapshot.accounts || []).map((account, index) => ({
      id: account.id, username: account.username, enabled: account.enabled, status: account.status,
      failures: account.failures, checkGeneration: account.check_generation,
      userId: account.user_id ?? account.userId,
      needsOwnerCaptcha: account.needs_owner_captcha === true || account.needsOwnerCaptcha === true,
      cookieFile: account.cookie_file, quota: account.quota_limit ?? null
    }));
    // Only persisted, account-bound observations may supply display evidence.
    // A sampling timestamp or list position is not proof of a route or session.
    const vpnSlots = structuredClone(snapshot.vpnSlots || {});
    const accountChecks = structuredClone(snapshot.accountChecks || {});
    return { accounts, settings: { dailyQuota: snapshot.settings?.dailyQuota ?? snapshot.quota?.dailyQuota }, posting: { quota }, vpnSlots, telegramUi: { accountChecks } };
  }
  async fastNavigate(name,request,raw) {
    const nav=this.fastNavigation,id=this.identity(raw);
    // Telegram updates use committed small projections; local callers retain the
    // in-memory path used by isolated render tests and non-Telegram helpers.
    if (Number.isSafeInteger(request?.updateId)) {
      const ownerRevision=nav.ownerRevision || 0;
      const [settings,telegramUi]=await Promise.all([this.bot.store.section('settings'),this.bot.store.section('telegramUi')]);
      nav.mergeUi({settings,telegramUi},ownerRevision);
    }
    const u=nav.user(id.key);
    // Legacy credential drafts retain their established cleanup lifecycle.
    if(u.draft){await nav.flush();return this[name](request,raw);}
    if(name==='back') {
      if(u.page==='account'){await nav.flush();return this.back(request,raw);}
      name=u.page==='accounts'?'menu':u.page==='delay'&&u.prompt?'delayMenu':u.page==='schedule'&&u.prompt?'scheduleMenu':'menu';
    }
    if(name==='navControl'){if(request.parsed?.action!=='main'||request.parsed?.value!=='back')return this.unknownCallback(request,raw);name='menu';}
    const page={menu:'main',work:'main',settings:'settings',accounts:'accounts',delayMenu:'delay',scheduleMenu:'schedule',quotaMenu:'quota'}[name];
    if(!page){
      if(['accountsBrowse','accountToggleMenu'].includes(name)){
        nav.patch(id,{page:'accounts',prompt:null,promptMessageId:null,draft:null,flowToken:null,confirmMessage:null,confirmAt:null});
      }else if(u.prompt!=null||u.promptMessageId!=null||u.draft!=null||u.flowToken!=null||u.confirmMessage!=null||u.confirmAt!=null){
        nav.patch(id,{prompt:null,promptMessageId:null,draft:null,flowToken:null,confirmMessage:null,confirmAt:null});
      }
      return this[name](request,raw);
    }
    nav.patch(id,{page,prompt:name==='quotaMenu'?'quota':null,promptMessageId:null,draft:null,flowToken:null,confirmMessage:null,confirmAt:null});
    if(name==='accounts')return this.openAccountsPanel(id);
    if(name==='work') return this.openWorkPanel(id,request);
    if(['delayMenu','scheduleMenu','quotaMenu'].includes(name)) {
      const s=nav.settings;
      let sent;
      if(name==='scheduleMenu')sent=await this.bot.transport.sendMessage(id.chat,this.scheduleText(s),{parse_mode:'HTML',reply_markup:this.scheduleKeyboard(s.schedule?.enabled),_navigation:true});
      else if(name==='delayMenu')sent=await this.bot.transport.sendMessage(id.chat,`⏱️ <b>إعدادات التأخير الزمني بين المنشورات:</b>\n\n• <b>الحد الأدنى:</b> ${Number.isSafeInteger(s.delayMinSeconds)?formatDuration(s.delayMinSeconds):'لا يوجد'}\n• <b>الحد الأعلى:</b> ${Number.isSafeInteger(s.delayMaxSeconds)?formatDuration(s.delayMaxSeconds):'لا يوجد'}\n\nاختر الحد لتعديل توقيته:`,{parse_mode:'HTML',reply_markup:{inline_keyboard:[[{text:'أدنى',callback_data:'delay:set_min:prompt',...(this.inlineStyles?{style:'primary'}:{})},{text:'أعلى',callback_data:'delay:set_max:prompt',...(this.inlineStyles?{style:'danger'}:{})}]]},_navigation:true});
      else sent=await this.bot.transport.sendMessage(id.chat,`📊 <b>إعدادات الحصة اليومية:</b>\n\nالحصة الحالية: <b>${s.dailyQuota?`${s.dailyQuota} منشور`:'غير محددة'}</b> لكل حساب.\n\nأرسل الحصة اليومية الجديدة رقماً صحيحاً أكبر من صفر (مثال: 10)، أو اضغط أي زر في القائمة للإلغاء:`,{parse_mode:'HTML',reply_markup:this.settingsMenus[s.schedule?.enabled?1:0].reply_markup,_navigation:true});
      this._retireTransitionalBubble(id.chat, sent);
      return sent;
    }
    const payload=name==='settings'?this.settingsMenus[nav.settings.schedule?.enabled?1:0]:this.staticMenus[page];
    // ReplyKeyboardMarkup cannot be changed by editMessageText: one send is necessary.
    const sent=await this.bot.transport.sendMessage(id.chat,payload.text,{reply_markup:payload.reply_markup,_navigation:true});
    this._retireTransitionalBubble(id.chat, sent);
    return sent;
  }
  // Panel ownership is independent of page/input navigation. History is immutable.
  panelEpoch(chat, kind = 'dashboard') { return this.panelEpochs?.get(`${chat}:${kind}`) || 0; }
  nextPanelEpoch(chat, kind = 'dashboard') {
    this.panelEpochs ||= new Map();
    const epoch = this.panelEpoch(chat, kind) + 1;
    this.panelEpochs.set(`${chat}:${kind}`, epoch);
    return epoch;
  }
  currentPanel(chat, kind = 'dashboard', root) {
    const registry = root ? root.interfacePanelsByChatId : this.fastNavigation?.interfacePanelsByChatId;
    if (registry?.[String(chat)] && Object.hasOwn(registry[String(chat)], kind)) return registry[String(chat)][kind];
    if (!root && this.interfacePanelOwners?.has(`${chat}:${kind}`)) return this.interfacePanelOwners.get(`${chat}:${kind}`);
    // Legacy aliases describe dashboards only; they never authorize accounts.
    return kind === 'dashboard' ? (root ? root.activePanelsByChatId?.[String(chat)] || root.dashboards?.[String(chat)] : this.fastNavigation?.panels?.[String(chat)] || this.panelOwners?.get(String(chat))) : null;
  }
  samePanel(a, b) { return !a && !b || Boolean(a && b && a.messageId === b.messageId && a.generation === b.generation); }
  ownsPanel(chat, panel, _epoch, kind = panel?.kind || 'dashboard') {
    const current = this.currentPanel(chat, kind);
    return !this.destroyed && Boolean(panel?.messageId) && !panel.retired && !current?.retired && this.samePanel(current, panel);
  }
  canEditPanel(chat, panel, kind = panel?.kind || 'dashboard') {
    return this.ownsPanel(chat, panel, undefined, kind) && !this.panelHandovers?.has(`${chat}:${kind}`);
  }
  async savePanel(id, panel, isCurrent = () => true, options = {}) {
    const kind = options.kind || panel.kind || 'dashboard';
    const validMessage = value => Number.isSafeInteger(value?.messageId) && value.messageId > 0;
    if (!['dashboard', 'accounts'].includes(kind) || !validMessage(panel)) return false;
    const expected = structuredClone(Object.hasOwn(options, 'expected') ? options.expected : this.currentPanel(id.chat, kind) || null);
    if (expected !== null && !validMessage(expected)) return false;
    panel = structuredClone(panel);
    const opts = { kind, expected };
    let saved = false;
    const apply = state => {
      const root = state.telegramUi ||= {};
      if (!isCurrent() || !this.samePanel(this.currentPanel(id.chat, kind, root), expected)) return false;
      root.interfacePanelsByChatId ||= {};
      root.interfacePanelsByChatId[String(id.chat)] ||= {};
      root.interfacePanelsByChatId[String(id.chat)][kind] = { ...panel };
      if (kind === 'dashboard') {
        root.users ||= {}; root.dashboards ||= {}; root.activePanelsByChatId ||= {};
        root.users[id.key] ||= { chatId: id.chat, userId: id.user, page: 'main' };
        for (const u of Object.values(root.users)) if (String(u.chatId) === String(id.chat)) u.panel = { ...panel };
        root.activePanelsByChatId[String(id.chat)] = { ...panel };
        root.dashboards[String(id.chat)] = { ...panel };
      }
      return true;
    };
    if (typeof this.bot.store.saveUiPanel === 'function') saved = await this.bot.store.saveUiPanel(id, panel, isCurrent, opts);
    else if (this.bot.store.importTransaction) await this.bot.store.importTransaction(async repo => {
      const state = await repo.header();
      if (!apply(state) || !isCurrent()) return;
      await repo.saveHeader(state); saved = true;
    }, { uiOnly: true });
    else await this.bot.store.update(state => { saved = apply(state); return state; });
    if (!saved) return false;
    this.interfacePanelOwners ||= new Map(); this.interfacePanelOwners.set(`${id.chat}:${kind}`, panel);
    const nav = this.fastNavigation;
    if (nav) { nav.ownerRevision = (nav.ownerRevision || 0) + 1; nav.interfacePanelsByChatId[String(id.chat)] ||= {}; nav.interfacePanelsByChatId[String(id.chat)][kind] = panel; }
    if (kind === 'dashboard') {
      this.panelOwners ||= new Map(); this.panelOwners.set(String(id.chat), panel);
      if (nav) {
        nav.panels[String(id.chat)] = panel; nav.panelPatches.delete(String(id.chat));
        for (const [key, u] of Object.entries(nav.users)) if (String(u.chatId) === String(id.chat)) {
          nav.users[key] = { ...u, panel };
          // Navigation patches must never become panel writers.
          if (nav.pending.has(key)) { const { panel: _panel, ...patch } = nav.pending.get(key); nav.pending.set(key, patch); }
        }
      }
    }
    return true;
  }
  async publishPanel(id, kind, render) {
    this.panelOpenLocks ||= new Map(); this.panelHandovers ||= new Set();
    const navigation = require('./telegram').navigationContext.getStore();
    const navVersion = navigation?.version;
    const isNavCurrent = () => !navigation || (navigation.isCurrent() && (navVersion == null || this.navigationVersion?.get(navigation.key) === navVersion));
    const key = `${id.chat}:${kind}`, previous = this.panelOpenLocks.get(key) || Promise.resolve();
    const task = previous.catch(() => {}).then(() => require('./telegram').navigationContext.run(null, async () => {
      if (this.destroyed || !isNavCurrent()) return { superseded: true };
      if (!this.fastNavigation) {
        const observed = this.currentPanel(id.chat, kind);
        const root = this.bot.store.section ? await this.bot.store.section('telegramUi') : (await this.bot.store.load()).telegramUi;
        if (this.samePanel(this.currentPanel(id.chat, kind), observed)) {
          this.interfacePanelOwners ||= new Map(); this.interfacePanelOwners.set(key, this.currentPanel(id.chat, kind, root) || null);
        }
      }
      if (this.destroyed || !isNavCurrent()) return { superseded: true };
      const current = this.currentPanel(id.chat, kind) || null;
      this.panelHandovers.add(key);
      try {
        // Pause *before* draining, closing the gap between drain and adoption.
        if (current?.messageId) await this.bot.transport.waitForMessageEdits?.(id.chat, current.messageId);
        if (this.destroyed || !isNavCurrent()) return { superseded: true };
        const generation = token(), epoch = this.nextPanelEpoch(id.chat, kind);
        const { text, extra = {}, view, accountIds } = await render(generation);
        if (this.destroyed || !isNavCurrent()) return { superseded: true };
        navigation?.onSend?.();
        const sent = await this.bot.transport.sendMessage(id.chat, text, { ...extra, _navigation: true, _isCurrent: () => !this.destroyed && isNavCurrent() && this.samePanel(this.currentPanel(id.chat, kind), current) });
        if (sent?.superseded) return sent;
        const messageId = sent?.message_id ?? sent?.result?.message_id;
        if (!Number.isSafeInteger(messageId) || messageId <= 0) throw Object.assign(new Error('Telegram panel receipt missing'), { ambiguous: true, code: 'TELEGRAM_INVALID_RESPONSE' });
        const panel = { messageId, token: generation, generation, epoch, kind, view, accountIds, chatId: id.chat, userId: id.user, signature: JSON.stringify({ text, markup: extra.reply_markup }), updatedAt: Date.now() };
        const saved = await this.savePanel(id, panel, () => !this.destroyed && isNavCurrent() && this.samePanel(this.currentPanel(id.chat, kind), current), { kind, expected: current });
        return saved ? sent : { ...sent, superseded: true };
      } finally { this.panelHandovers.delete(key); }
    }));
    this.panelOpenLocks.set(key, task);
    try { return await task; } finally { if (this.panelOpenLocks.get(key) === task) this.panelOpenLocks.delete(key); }
  }
  async ensurePanelRender(kind) {
    const nav = this.fastNavigation;
    if (nav) {
      const cached = kind === 'dashboard' ? nav.html : nav.accountsHtml;
      if (!cached) await nav.refresh();
      if (!(kind === 'dashboard' ? nav.html : nav.accountsHtml)) throw new Error('Committed panel projection unavailable');
      // A dirty committed render remains a table, never a placeholder.
      if (nav.dirty || nav.validUntil <= Date.now()) nav.refresh();
      return;
    }
    if (this.normalizedDashboardReader) {
      const snapshot = await this.readDashboardSnapshot();
      return this.normalizedProjectionState(snapshot);
    }
    if (typeof this.bot.store.getDashboardSnapshot === 'function') {
      return this.normalizedProjectionState(await this.bot.store.getDashboardSnapshot({ now: new Date(this.clock()).toISOString() }));
    }
    return this.bot.store.load();
  }
  async openWorkPanel(id) {
    return this.publishPanel(id, 'dashboard', async generation => {
      const state = await this.ensurePanelRender('dashboard'), nav = this.fastNavigation;
      const text = nav ? (nav.panelView ? this.renderPanelView({ ...nav.panelView, preparing: Boolean(this.isPreparing) }) : nav.html) : await this.render(state);
      const cycleState = nav?.snapshot?.cycle?.state || state?.cycle?.state;
      this.evaluateDashboardPolling();
      const effectiveState = this.isPreparing && !['running', 'stopping'].includes(cycleState) ? 'preparing' : (cycleState || 'stopped');
      return { text, view: 'table', extra: { rich_message: { html: text }, reply_markup: this.controls(effectiveState, generation) } };
    });
  }
  async openAccountsPanel(id) {
    return this.publishPanel(id, 'accounts', async () => {
      const state = await this.ensurePanelRender('accounts'), nav = this.fastNavigation;
      const text = nav?.accountsHtml || formatAccountTable(state, { now: this.clock(), all: true, mode: 'rich' });
      const patch = { page: 'accounts', accountId: null, selectionIds: nav?.accountIds || (state.accounts || []).map(a => a.id), selectionMessage: null };
      if (nav) nav.patch(id, patch); else await this.flows.set(id, patch);
      return { text, view: 'table', extra: { rich_message: { html: text }, reply_markup: this.accountsMenu || this.bot.transport.keyboard('accounts', [['الحسابات', 'تفعيل / إلغاء تفعيل', 'رجوع']]) } };
    });
  }
  trackNavigationDelivery(task){if(!task)return;this.deliveryTasks ||=new Set();this.deliveryTasks.add(task);task.catch(e=>this._logWarn('navigation_refresh_delivery_failed','cache',e)).finally(()=>this.deliveryTasks.delete(task));}
  trackControlTask(task) {
    if (!task || typeof task.then !== 'function') return task;
    this.controlTasks ||= new Set();
    const tracked = Promise.resolve(task).finally(() => {
      this.controlTasks?.delete(tracked);
    });
    this.controlTasks.add(tracked);
    return tracked;
  }
  hasPendingPanelDelivery() {
    return Boolean(this.pendingPanelDeliveries?.size);
  }
  clearPanelRetryTimer(key) {
    if (!this.panelRetryTimers) return;
    const chatKey = String(key);
    const timer = this.panelRetryTimers.get(chatKey);
    if (timer) {
      clearTimeout(timer);
      this.panelRetryTimers.delete(chatKey);
    }
  }
  schedulePanelRetry(id, key, delayMs) {
    const chatKey = String(key);
    if (this.destroyed) return;
    this.panelRetryTimers ||= new Map();
    this.clearPanelRetryTimer(chatKey);
    const retryDelay = Math.max(1, Math.ceil(Number(delayMs) || 0) + 2);
    const retryId = id ? { ...id } : { key: `${chatKey}:${chatKey}`, chat: chatKey, user: chatKey };
    const timer = setTimeout(() => {
      if (this.panelRetryTimers?.get(chatKey) === timer) {
        this.panelRetryTimers.delete(chatKey);
      }
      if (this.destroyed || !this.pendingPanelDeliveries?.has(chatKey)) return;
      const remaining = (this.panelBlockedUntil?.get(chatKey) || 0) - Date.now();
      if (remaining > 0) {
        this.schedulePanelRetry(retryId, chatKey, remaining);
        return;
      }
      const retryTask = this.panel(retryId, true).catch(err => {
        if (err?.telegramCode !== 429) {
          this._logWarn('panel_retry_delivery_failed', 'panelRetry', err);
        }
      });
      this.trackNavigationDelivery(retryTask);
    }, retryDelay);
    timer.unref?.();
    this.panelRetryTimers.set(chatKey, timer);
  }
  async _acknowledgeWithNotice(id, request, raw, text, alert = false, { allowNotice = true } = {}) {
    const callbackId = raw?.callback_query?.id;
    let res;
    if (request?.acknowledge) {
      res = await request.acknowledge(text, alert);
    } else if (callbackId && this.bot?.transport?.acknowledgeCallback) {
      try {
        res = await this.bot.transport.acknowledgeCallback(callbackId, text, alert);
      } catch {
        res = null;
      }
    }
    if (allowNotice && res === null && text && alert && !this.destroyed && id?.chat != null && (request?.admission?.ackSent || request?.secondaryAckFailed)) {
      const noticeText = text.startsWith('⚠️') || text.startsWith('✅') ? text : `⚠️ ${text}`;
      const sent = this.flows?.notice
        ? await this.flows.notice(id, noticeText).catch(() => null)
        : await this.bot?.transport?.sendMessage?.(id.chat, noticeText, { _background: true }).catch(() => null);
      const sentMsgId = sent?.message_id ?? sent?.result?.message_id;
      if (Number.isSafeInteger(sentMsgId) && sentMsgId > 0 && this.transientNotices) {
        await this.transientNotices.track(id.chat, sentMsgId).catch(() => {});
      }
    }
    return res;
  }
  async _clearPromptState(id) {
    if (this.fastNavigation) {
      const u = this.fastNavigation.user(id.key);
      if (u?.prompt != null || u?.promptMessageId != null || u?.draft != null || u?.flowToken != null || u?.confirmMessage != null || u?.confirmAt != null) {
        this.fastNavigation.patch(id, { prompt: null, promptMessageId: null, draft: null, flowToken: null, confirmMessage: null, confirmAt: null });
      }
      return;
    }
    if (this.flows?.user && this.flows?.set) {
      const u = await this.flows.user(id);
      if (u?.prompt != null || u?.promptMessageId != null || u?.draft != null || u?.flowToken != null || u?.confirmMessage != null || u?.confirmAt != null) {
        await this.flows.set(id, { prompt: null, promptMessageId: null, draft: null, flowToken: null, confirmMessage: null, confirmAt: null });
      }
    }
  }
  _logWarn(event, operation, err, extra = {}) {
    logStructured(this.bot?.logger, {
      level: 'warn',
      component: 'telegram_ui',
      event,
      operation,
      result: 'suppressed',
      errorCode: extractErrorCode(err),
      sanitizedError: sanitizeError(err),
      ...extra
    });
  }
  _logError(event, operation, err, extra = {}) {
    logStructured(this.bot?.logger, {
      level: 'error',
      component: 'telegram_ui',
      event,
      operation,
      result: 'failed',
      errorCode: extractErrorCode(err),
      sanitizedError: sanitizeError(err),
      ...extra
    });
  }
  startTicker() {
    // The clock is useful only while publishing; stopped panels are event-driven.
    this.tickerEnabled = true;
    this.syncPanelClock();
  }
  syncPanelClock() {
    const running = ['running','stopping'].includes(this.fastNavigation?.snapshot?.cycle?.state);
    if (!running || !this.tickerEnabled || this.destroyed || this.normalizedDashboardReader) {
      if (this.ticker) clearInterval(this.ticker);
      this.ticker = null;
      return;
    }
    if (this.ticker) return;
    this.ticker = setInterval(() => {
      if (this.destroyed) {
        if (this.ticker) { clearInterval(this.ticker); this.ticker = null; }
        return;
      }
      this.refreshPanels().catch(error => {
        if (this.destroyed || /store is closed/i.test(error?.message || '')) return;
        logStructured(this.bot?.logger, {
          level: 'error',
          component: 'telegram_ui',
          event: 'panel_refresh_ticker_failed',
          operation: 'refreshPanels',
          result: 'failed',
          errorCode: extractErrorCode(error),
          sanitizedError: sanitizeError(error)
        });
      });
    }, 1000);
    this.ticker.unref?.();
  }
  // Request admission is separate from bounded read-only network work. Mutation
  // and confirmation actions retain their existing serial transaction lane.
  beginAccountObservation() {
    this.observationOrder = Math.max(Date.now(), (this.observationOrder || 0) + 1);
    return this.observationOrder;
  }
  enqueueAccountCheck(request, raw) {
    this.accountCheckTasks ||= new Map();
    this.accountCheckQueue ||= [];
    const key = `${this.identity(raw).chat}:${raw.callback_query?.message?.message_id}:${request.parsed.action}:${request.parsed.value}`;
    if (this.accountCheckTasks.has(key)) return { admitted:true, alreadyRunning:true };
    if(this.accountCheckTasks.size>=20){this.trackNavigationDelivery(this.bot.transport.sendMessage(this.identity(raw).chat,'الفحوص مشغولة حالياً؛ حاول مجدداً بعد اكتمال الفحوص الحالية.',{_background:true}));return {admitted:false,busy:true};}
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    timeout.unref?.();
    let settle;
    const task = new Promise(resolve => { settle=resolve; });
    this.accountCheckTasks.set(key, { task, controller });
    this.evaluateDashboardPolling();
    const run = async () => {
      try {
        if (controller.signal.aborted || this.destroyed) return;
        await this.accountManage({ ...request, checkSignal: controller.signal }, raw);
      } catch (error) {
        this._logError('account_check_task_failed', 'background', error);
      } finally {
        clearTimeout(timeout);
        this.accountCheckTasks.delete(key);
        this.evaluateDashboardPolling();
        if (!this.destroyed) {
          const finishRefresh = (this.normalizedDashboardReader
            ? this.readFreshDashboard().catch(() => {})
            : Promise.resolve()
          ).then(() => this.refreshPanels(true).catch(() => {}));
          this.trackNavigationDelivery(finishRefresh);
        }
        settle();
      }
    };
    this.accountCheckQueue.push(run);
    this.pumpAccountChecks();
    return { admitted:true, checking:request.parsed.action };
  }
  pumpAccountChecks() {
    while ((this.accountChecksActive || 0) < 5 && this.accountCheckQueue?.length) {
      const run=this.accountCheckQueue.shift();
      this.accountChecksActive=(this.accountChecksActive || 0)+1;
      void require('./telegram').navigationContext.run(null,run).finally(() => {
        this.accountChecksActive--;this.pumpAccountChecks();
      });
    }
  }
  actions(extraActions = {}) {
    const a = {};
    const uiNames = ['menu', 'work', 'settings', 'accounts', 'scheduleMenu', 'delayMenu', 'quotaMenu', 'exportLinks', 'back', 'input', 'cycleControl', 'document', 'flowControl', 'accountControl', 'unknownCallback', 'navControl', 'accountToggleMenu', 'accountToggle', 'accountsBrowse', 'accountManage', 'delayControl', 'scheduleControl'];
    for (const name of new Set([...uiNames, ...Object.keys(extraActions)])) {
      // Existing UI handlers retain precedence over legacy runner handlers.
      const invoke = uiNames.includes(name) ? (request, raw) => this[name](request, raw) : extraActions[name];
      if (typeof invoke !== 'function') continue;
      a[name] = async (request={}, raw) => {
        if (request && typeof request === 'object' && request.entryStopGeneration == null) {
          request.entryStopGeneration = this.stopGeneration || 0;
        }
        const identity=this.identity(raw),key=identity.key;
        const knownCommands = ['menu','work','settings','accounts','scheduleMenu','delayMenu','quotaMenu','back','exportLinks','accountsBrowse','accountToggleMenu','accountAdd','accountRemove','accountUsername','accountToggle','accountsCsv','cookie','cookieVerify','delay','quota','schedule','report','status'];
        const deleteIncomingCommand = request.source === 'message' && !raw.message?.document && Number.isSafeInteger(request.incomingMessageId) && name !== 'document' &&
          (knownCommands.includes(name) || Boolean(request.command));
        const retireIncomingCommand = () => {
          if (!deleteIncomingCommand) return;
          this.bot.transport.deleteMessage(identity.chat, request.incomingMessageId, { strict: true }).catch(err => {
            this._logWarn('incoming_command_delete_failed', 'deleteMessage', err);
          });
        };
        const backgroundCheck=name==='accountManage'&&['check_session','check_vpn'].includes(request.parsed?.action)&&request.deferNavigation;
        if(backgroundCheck) {
          if(Number.isSafeInteger(request.updateId)) {
            const claimed = typeof this.bot.store.claimNavigationReceipt === 'function'
              ? await this.bot.store.claimNavigationReceipt('u:'+request.updateId, key, 'account-check', Date.now())
              : await this.bot.store.importTransaction(async repo=>
                (await repo.execute('INSERT INTO telegram_navigation_receipts(id,owner,action,received) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING',['u:'+request.updateId,key,'account-check',Date.now()])).changes===1,
              {uiOnly:true});
            if(!claimed)return {replayed:true};
          }
          const admitted = this.enqueueAccountCheck(request,raw);
          retireIncomingCommand();
          return admitted;
        }
        // Freeze request-time day/cutoff before any per-user queue wait.
        if (name === 'exportLinks') request.exportAt = new Date(this.clock());
        // Receipt claims precede UI side effects; a crash/unknown send is never replayed.
        const receipt=Number.isSafeInteger(request.updateId)?'u:'+request.updateId:null;
        if(receipt&&['menu','work','settings','accounts','back','scheduleMenu','delayMenu','quotaMenu','navControl','exportLinks','accountsBrowse','accountToggleMenu'].includes(name)){
          const claimed = typeof this.bot.store.claimNavigationReceipt === 'function'
            ? await this.bot.store.claimNavigationReceipt(receipt, key, name, Date.now())
            : await this.bot.store.importTransaction(async repo=>
                (await repo.execute('INSERT INTO telegram_navigation_receipts(id,owner,action,received) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING',[receipt,key,name,Date.now()])).changes===1,
              {uiOnly:true});
          if(!claimed)return {replayed:true};
        }
        const navigation=['menu','work','settings','accounts','scheduleMenu','delayMenu','quotaMenu','back','navControl','accountsBrowse','accountToggleMenu'].includes(name)||(name==='accountManage'&&['select','list'].includes(request.parsed?.action));
        const explicitNavigation=navigation&&Number.isSafeInteger(request.updateId),chatKey=String(identity.chat);
        this.explicitNavigationLocks ||=new Map();
        this.navigationVersion ||= new Map();
        let version=navigation&&!explicitNavigation ? (this.navigationVersion.get(key)||0)+1 : null;
        if(version!=null)this.navigationVersion.set(key,version);
        let releasePreparation;
        const prepared=new Promise(resolve=>{releasePreparation=()=>resolve({deliveryPending:true});});
        const trackedNavigation=['menu','work','settings','accounts','scheduleMenu','delayMenu','quotaMenu','accountsBrowse','accountToggleMenu'].includes(name)||(name==='accountManage'&&['select','list'].includes(request.parsed?.action));
        this.navigationTasks ||= new Map();
        const navKey=key+':'+name;
        const enqueued=Date.now();let acquired,completion,completionError;
        const priorityStop = name === 'cycleControl' && request.parsed?.action === 'stop';
        const actionPrevious=this.actionLocks.get(key)||Promise.resolve();
        // Distinct authorized Telegram requests each deserve a real receipt.
        // Serialize their full delivery per chat; don't coalesce them as timers.
        const previous = priorityStop ? Promise.resolve() : explicitNavigation
          ? Promise.allSettled([actionPrevious,this.explicitNavigationLocks.get(chatKey)||Promise.resolve()]) : actionPrevious;
        const task = previous.catch(() => {}).then(async () => {acquired=Date.now();
          if(explicitNavigation){version=(this.navigationVersion.get(key)||0)+1;this.navigationVersion.set(key,version);}
          if(navigation)logStructured(this.bot.logger,{component:'telegram_ui',event:'telegram_action_started',action:name,
            updateId:request.updateId,incomingMessageId:request.incomingMessageId,navigationVersion:version,queueWaitMs:acquired-enqueued});
          if(!navigation)await this.fastNavigation?.flush();
          if(navigation && this.navigationVersion.get(key)!==version)return {superseded:true};
          const useFastNav=this.fastNavigation&&(['menu','work','settings','back','navControl','delayMenu','scheduleMenu','quotaMenu','accounts','accountsBrowse','accountToggleMenu'].includes(name)||(name==='accountManage'&&['select','list'].includes(request.parsed?.action)));
          return require('./telegram').navigationContext.run(navigation?{key,version,action:name,updateId:request.updateId,incomingMessageId:request.incomingMessageId,isCurrent:()=>this.navigationVersion.get(key)===version,onSend:releasePreparation,receivedAt:request.receivedAt||enqueued,handlerQueueMs:acquired-enqueued}:null,()=>useFastNav?this.fastNavigate(name,request,raw):invoke(request,raw));
        }).catch(async error => {
          // Keep runner-only command error/retry semantics with its existing owner.
          if (!uiNames.includes(name)) throw error;
          if(navigation&&this.navigationVersion.get(key)!==version)return {superseded:true};
          if (isConflict409(error)) {
            this.bot.logger?.error?.(JSON.stringify({ event: 'telegram_ui_conflict_409', action: name, message: sanitizeError(error) }));
            return;
          }
          if (error?.ambiguous || error?.telegramCode || ['TELEGRAM_TIMEOUT', 'TELEGRAM_INVALID_RESPONSE', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN'].includes(error?.code)) throw error;
          const importing=name==='document'||(name==='flowControl'&&['imports','importcancel'].includes(request.parsed?.action));
          return this.bot.transport.sendMessage(this.identity(raw).chat, 'تعذر تنفيذ الإجراء. لم يبدأ النشر. حاول مجدداً أو اضغط رجوع.', importing||navigation||name==='exportLinks' ? {} : { reply_markup: this.bot.transport.keyboard('waiting') });
        });
        if (priorityStop) return task.finally(retireIncomingCommand);
        const lockTask=navigation&&request.deferNavigation?Promise.race([task,prepared]):task;
        this.actionLocks.set(key, lockTask);
        const tracked=task.then(async result=>{
          completion=result;
          return result;
        },error=>{completionError=error;throw error;}).finally(() => {
          retireIncomingCommand();
          releasePreparation?.();
          if (this.actionLocks.get(key) === lockTask) this.actionLocks.delete(key);
          if(this.navigationTasks.get(navKey)===tracked)this.navigationTasks.delete(navKey);
          if(this.explicitNavigationLocks.get(chatKey)===tracked)this.explicitNavigationLocks.delete(chatKey);
          if(navigation||Date.now()-(this.lastLatencyLog||0)>30000){
            this.lastLatencyLog=Date.now();
            const responseMessageId=completion?.message_id??completion?.result?.message_id;
            logStructured(this.bot.logger,{component:'telegram_ui',event:'telegram_action_latency',action:name,
              updateId:request.updateId,incomingMessageId:request.incomingMessageId,navigationVersion:version,
              outcome:completionError?'failed':completion?.superseded?'superseded':completion?.unchanged?'unchanged':responseMessageId!=null?'delivered':'completed',
              errorCode:completionError?.code,responseMessageId,
              receivedToCompletionMs:Date.now()-(request.receivedAt||enqueued),queueWaitMs:(acquired||Date.now())-enqueued,handlerMs:Date.now()-(acquired||Date.now())});
          }
        });
        if(explicitNavigation)this.explicitNavigationLocks.set(chatKey,tracked);
        if(trackedNavigation)this.navigationTasks.set(navKey,tracked);
        if(navigation&&request.deferNavigation){
          this.deliveryTasks ||= new Set();this.deliveryTasks.add(tracked);
          tracked.catch(error=>this._logWarn('navigation_delivery_failed','navigation',error)).finally(()=>this.deliveryTasks.delete(tracked));
          // Admission is only reported after the handler has crossed the actual
          // transport boundary. A rejected handler before send must remain a
          // definitive failure, never be masked by the preparation race.
          return lockTask.then(res => ({ admitted: true, ...(res?.deliveryPending ? { deliveryPending: true } : {}) }));
        }
        return tracked;
      };
    }
    return a;
  }
  identity(raw) {
    const m = raw.callback_query?.message || raw.message;
    const chat = m?.chat?.id; const user = raw.callback_query?.from?.id ?? raw.message?.from?.id;
    if (chat == null || user == null) throw new Error('Missing Telegram identity');
    return { chat, user, key: `${chat}:${user}` };
  }
  async page(id, page, prompt = null) {
    await this.flows.set(id,{page,prompt});
  }
  _retireTransitionalBubble(chatId, sent) {
    const sentMessageId = sent?.message_id ?? sent?.result?.message_id;
    if (!Number.isSafeInteger(sentMessageId) || sentMessageId <= 0) return;
    const key = String(chatId);
    const prev = this.transitionalBubbles.get(key);
    // A successful API send does not prove Android has adopted a replacement
    // ReplyKeyboardMarkup. Preserve prior carriers until visual acceptance.
    // Track the latest carrier only; never delete a keyboard-bearing message here.
    this.transitionalBubbles.set(key, {
      messageId: sentMessageId,
      generation: (prev?.generation || 0) + 1,
      timestamp: Date.now()
    });
  }
  async show(id, page, text, prompt = null) {
    await this.page(id, page, prompt);
    const sent = await this.bot.transport.sendMessage(id.chat, text, { reply_markup: this.bot.transport.keyboard(prompt ? 'input' : page) });
    this._retireTransitionalBubble(id.chat, sent);
    return sent;
  }
  async menu(_, raw) { const id = this.identity(raw); await this.flows.cleanup(id); return this.show(id, 'main', 'القائمة الرئيسية'); }
  async document(request, raw) { return this.flows.document(request, raw); }
  async flowControl(request, raw) { return this.flows.flowControl(request, raw); }
  async unknownCallback(_, raw) { return this.bot.transport.sendMessage(this.identity(raw).chat, 'هذا الزر قديم. اختر من القائمة الحالية.'); }
  async navControl(request, raw) {
    if (request.parsed.action === 'main' && request.parsed.value === 'back') return this.menu(null, raw);
    return this.unknownCallback(null, raw);
  }

  scheduleKeyboard(isEnabled) {
    return {
      inline_keyboard: [
        [
          isEnabled
            ? { text: 'تعطيل الجدولة', callback_data: 'schedule_btn:toggle:disable', ...(this.inlineStyles ? { style: 'danger' } : {}) }
            : { text: 'تفعيل الجدولة', callback_data: 'schedule_btn:toggle:enable', ...(this.inlineStyles ? { style: 'success' } : {}) },
          { text: 'تحديد الموعد', callback_data: 'schedule_btn:set_time:prompt', ...(this.inlineStyles ? { style: 'primary' } : {}) }
        ]
      ]
    };
  }

  scheduleText(s) {
    const isEnabled = s.schedule?.enabled === true;
    const hour = s.schedule?.hour ?? 9;
    const minute = s.schedule?.minute ?? 0;
    const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    const statusStr = isEnabled ? '🟢 مفعلة' : '🔴 معطلة';
    return `📅 <b>إعدادات الجدولة اليومية:</b>\n\n` +
      `• <b>الموعد الحالي:</b> ${timeStr} (بتوقيت مكة)\n` +
      `• <b>الحالة:</b> ${statusStr}\n\n` +
      `اختر الإجراء المطلوب:`;
  }

  async scheduleMenu(_, raw) {
    const id = this.identity(raw);
    await this.flows.cleanup(id);
    await this.flows.set(id, { page: 'schedule', prompt: null, promptMessageId: null });
    const s = await this.bot.settings.get();
    const text = this.scheduleText(s);
    const markup = this.scheduleKeyboard(s.schedule?.enabled === true);
    return this.bot.transport.sendMessage(id.chat, text, { parse_mode: 'HTML', reply_markup: markup });
  }

  async scheduleControl(request, raw) {
    const id = this.identity(raw);
    const parsed = request.parsed || {};
    const messageId = raw.callback_query?.message?.message_id;
    const callbackId = raw.callback_query?.id;
    const acknowledge = (text, alert = false) => request.acknowledge ? request.acknowledge(text, alert) : callbackId ? this.bot.transport.acknowledgeCallback(callbackId, text, alert) : Promise.resolve();

    if (parsed.action === 'toggle') {
      const enable = parsed.value === 'enable';
      await this.bot.settings.setSchedule({ enabled: enable });
      const s = await this.bot.settings.get();
      if (messageId) {
        await this.bot.transport.editMessageText(id.chat, messageId, this.scheduleText(s), { parse_mode: 'HTML', reply_markup: this.scheduleKeyboard(s.schedule?.enabled === true) }).catch(err => this._logWarn('telegram_ui_edit_message_suppressed', 'scheduleControl.toggle', err));
      }
      await acknowledge(enable ? 'تم تفعيل الجدولة' : 'تم تعطيل الجدولة');
      return { scheduleToggled: enable };
    }

    if (parsed.action === 'set_time') {
      await this.flows.set(id, { prompt: 'schedule', promptMessageId: messageId, page: 'schedule' });
      if (messageId) {
        await this.bot.transport.editMessageText(id.chat, messageId, 'أدخل موعد النشر اليومي بتوقيت مكة بصيغة 24 ساعة (مثال: 09:30 أو 21:00):', { reply_markup: { inline_keyboard: [] } }).catch(err => this._logWarn('telegram_ui_edit_message_suppressed', 'scheduleControl.set_time', err));
      }
      await acknowledge();
      return { prompt: 'schedule' };
    }

    await acknowledge();
    return {};
  }

  async delayMenu(_, raw) {
    const id = this.identity(raw);
    await this.flows.cleanup(id);
    await this.flows.set(id, { page: 'delay', prompt: null, promptMessageId: null });
    const s = await this.bot.settings.get();
    const minStr = Number.isSafeInteger(s.delayMinSeconds) ? formatDuration(s.delayMinSeconds) : 'لا يوجد';
    const maxStr = Number.isSafeInteger(s.delayMaxSeconds) ? formatDuration(s.delayMaxSeconds) : 'لا يوجد';
    const text = `⏱️ <b>إعدادات التأخير الزمني بين المنشورات:</b>\n\n` +
      `• <b>الحد الأدنى:</b> ${minStr}\n` +
      `• <b>الحد الأعلى:</b> ${maxStr}\n\n` +
      `اختر الحد لتعديل توقيته:`;
    const markup = {
      inline_keyboard: [[
        { text: 'أدنى', callback_data: 'delay:set_min:prompt', ...(this.inlineStyles ? { style: 'primary' } : {}) },
        { text: 'أعلى', callback_data: 'delay:set_max:prompt', ...(this.inlineStyles ? { style: 'danger' } : {}) }
      ]]
    };
    return this.bot.transport.sendMessage(id.chat, text, { parse_mode: 'HTML', reply_markup: markup });
  }

  async delayControl(request, raw) {
    const id = this.identity(raw);
    const parsed = request.parsed || {};
    const messageId = raw.callback_query?.message?.message_id;
    const callbackId = raw.callback_query?.id;
    const acknowledge = (text, alert = false) => request.acknowledge ? request.acknowledge(text, alert) : callbackId ? this.bot.transport.acknowledgeCallback(callbackId, text, alert) : Promise.resolve();

    if (parsed.action === 'set_min') {
      await this.flows.set(id, { prompt: 'delayMin', promptMessageId: messageId, page: 'delay' });
      if (messageId) {
        await this.bot.transport.editMessageText(id.chat, messageId, 'أدخل الحد الأدنى للمدة بصيغة دقائق:ثوانٍ (مثال: 0:45 أو 1:30) حتى 60:00:', { reply_markup: { inline_keyboard: [] } }).catch(err => this._logWarn('telegram_ui_edit_message_suppressed', 'delayControl.set_min', err));
      }
      await acknowledge();
      return { prompt: 'delayMin' };
    }

    if (parsed.action === 'set_max') {
      await this.flows.set(id, { prompt: 'delayMax', promptMessageId: messageId, page: 'delay' });
      if (messageId) {
        await this.bot.transport.editMessageText(id.chat, messageId, 'أدخل الحد الأعلى للمدة بصيغة دقائق:ثوانٍ (مثال: 2:00 أو 3:30) حتى 60:00:', { reply_markup: { inline_keyboard: [] } }).catch(err => this._logWarn('telegram_ui_edit_message_suppressed', 'delayControl.set_max', err));
      }
      await acknowledge();
      return { prompt: 'delayMax' };
    }

    await acknowledge();
    return {};
  }

  async getSettingsKeyboard() {
    const s = this.bot.store.section ? await this.bot.store.section('settings') : await this.bot.settings.get();
    const isScheduleEnabled = s.schedule?.enabled === true;
    const scheduleStyle = isScheduleEnabled ? 'success' : 'danger';
    return this.bot.transport.keyboard('settings', null, {
      styles: {
        'الجدولة': scheduleStyle
      }
    });
  }

  async quotaMenu(_, raw) {
    const id = this.identity(raw);
    await this.flows.cleanup(id);
    await this.flows.set(id, { page: 'quota', prompt: 'quota' });
    const s = await this.bot.settings.get();
    const quotaStr = s.dailyQuota ? `${s.dailyQuota} منشور` : 'غير محددة';
    const text = `📊 <b>إعدادات الحصة اليومية:</b>\n\n` +
      `الحصة الحالية: <b>${quotaStr}</b> لكل حساب.\n\n` +
      `أرسل الحصة اليومية الجديدة رقماً صحيحاً أكبر من صفر (مثال: 10)، أو اضغط أي زر في القائمة للإلغاء:`;
    const keyboardObj = await this.getSettingsKeyboard();
    return this.bot.transport.sendMessage(id.chat, text, { parse_mode: 'HTML', reply_markup: keyboardObj });
  }

  async back(_, raw) {
    const id = this.identity(raw);
    const u = await this.flows.user(id);
    await this.flows.cleanup(id);
    if (u.page === 'account' && u.prompt) {
      return this.flows.account(id);
    }
    if (u.page === 'account') {
      await this.flows.set(id, { accountId: null, page: 'accounts', prompt: null });
      return this.flows.accounts(id);
    }
    if (u.page === 'delay' && u.prompt) {
      await this.flows.set(id, { prompt: null, promptMessageId: null, page: 'delay' });
      return this.delayMenu(_, raw);
    }
    if (u.page === 'schedule' && u.prompt) {
      await this.flows.set(id, { prompt: null, promptMessageId: null, page: 'schedule' });
      return this.scheduleMenu(_, raw);
    }
    if (u.page === 'accounts') return this.menu(_, raw);
    return this.menu(_, raw);
  }

  async input(_, raw) {
    const id = this.identity(raw);
    const text = String(raw.message?.text || raw.message?.caption || '').trim();
    const cleanText = text.replace(/[\uFEFF\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
      .replace(/^(?:(?:🚀|📊|➕|📝|⚙️?|🔙|↩️?)\s*)+/u, '')
      .replace(/(?:\s*(?:🚀|📊|➕|📝|⚙️?|🔙|↩️?))+$/u, '').trim();
    // X status links use the dedicated atomic input path and temporary notice.
    if(this.links && !/https?:\/\/(?:x\.com|twitter\.com)\/(?:[A-Za-z0-9_]{1,15}\/status|i\/web\/status)\/\d+/i.test(text)){const result=await this.links.recordManual(text);if(result)return this.flows.notice(id,`حُفظت ${result.added} روابط في سجل اليوم؛ مكررة ${result.duplicates}. دون نشر أو خصم كوتا.`);}
    const u = await this.flows.user(id);

    const menuButtons = ['بدء العمل', 'الإعدادات', 'إدارة الحسابات', 'التأخير', 'الجدولة', 'الحصص', 'رجوع', 'إلغاء', 'الرئيسية', 'تفعيل / إلغاء تفعيل', 'الحسابات'];
    if (menuButtons.includes(cleanText) && u.prompt) {
      await this.flows.set(id, { prompt: null, promptMessageId: null });
      if (cleanText === 'الرئيسية' || cleanText === 'القائمة الرئيسية') {
        return this.menu(_, raw);
      }
      if (cleanText === 'رجوع' || cleanText === 'إلغاء') {
        return this.back(_, raw);
      }
    }

    if ((cleanText === 'رجوع' || cleanText === 'إلغاء') && ['delay', 'quota', 'schedule'].includes(u.page)) {
      await this.flows.cleanup(id);
      return ['delay', 'quota', 'schedule'].includes(u.page) ? this.menu(_, raw) : this.settings(_, raw);
    }

    const flow = await this.flows.input(id, text, { raw });
    if (flow !== null) return flow;

    try {
      if (['الحد الأدنى', 'أدنى'].includes(cleanText)) {
        await this.flows.set(id, { prompt: 'delayMin', page: 'delay' });
        return this.bot.transport.sendMessage(id.chat, 'أدخل الحد الأدنى للمدة بصيغة دقائق:ثوانٍ مثل 0:45 أو 1:30 (الحد الأقصى 60:00):', { reply_markup: this.bot.transport.keyboard('input') });
      }
      if (['الحد الأعلى', 'أعلى'].includes(cleanText)) {
        await this.flows.set(id, { prompt: 'delayMax', page: 'delay' });
        return this.bot.transport.sendMessage(id.chat, 'أدخل الحد الأعلى للمدة بصيغة دقائق:ثوانٍ مثل 2:00 أو 3:30 (الحد الأقصى 60:00):', { reply_markup: this.bot.transport.keyboard('input') });
      }
      if (u.prompt === 'delayMinPrompt' || u.prompt === 'delayMin') {
        const seconds = parseDuration(text);
        const s = await this.bot.settings.get();
        if (Number.isSafeInteger(s.delayMaxSeconds) && seconds > s.delayMaxSeconds) {
          throw new Error(`الحد الأدنى (${formatDuration(seconds)}) لا يمكن أن يتجاوز الحد الأعلى (${formatDuration(s.delayMaxSeconds)}).`);
        }
        await this.bot.settings.setDelayRange({ minSeconds: seconds, maxSeconds: s.delayMaxSeconds ?? seconds });
        if (u.promptMessageId) {
          await this.bot.transport.deleteMessage(id.chat, u.promptMessageId).catch(err => this._logWarn('telegram_ui_delete_message_suppressed', 'input.delayMin', err));
        }
        await this.flows.set(id, { prompt: null, promptMessageId: null, page: 'delay' });
        return this.bot.transport.sendMessage(id.chat, `✅ تم وضع الحد الأدنى: ${formatDuration(seconds)}`);
      }
      if (u.prompt === 'delayMaxPrompt' || u.prompt === 'delayMax') {
        const seconds = parseDuration(text);
        const s = await this.bot.settings.get();
        if (Number.isSafeInteger(s.delayMinSeconds) && seconds < s.delayMinSeconds) {
          throw new Error(`الحد الأعلى (${formatDuration(seconds)}) لا يمكن أن يقل عن الحد الأدنى (${formatDuration(s.delayMinSeconds)}).`);
        }
        await this.bot.settings.setDelayRange({ minSeconds: s.delayMinSeconds ?? Math.min(15, seconds), maxSeconds: seconds });
        if (u.promptMessageId) {
          await this.bot.transport.deleteMessage(id.chat, u.promptMessageId).catch(err => this._logWarn('telegram_ui_delete_message_suppressed', 'input.delayMax', err));
        }
        await this.flows.set(id, { prompt: null, promptMessageId: null, page: 'delay' });
        return this.bot.transport.sendMessage(id.chat, `✅ تم وضع الحد الأعلى: ${formatDuration(seconds)}`);
      }
      if (u.prompt === 'quotaPrompt' || u.prompt === 'quota') {
        if (!/^\d+$/.test(text) || !Number.isSafeInteger(+text) || +text < 1) {
          throw new Error('أدخل حصة صحيحة أكبر من صفر، مثل 10.');
        }
        await this.bot.settings.setQuota(+text);
        await this.flows.set(id, { prompt: null, page: 'quota' });
        return this.bot.transport.sendMessage(id.chat, `✅ تم حفظ الحصة اليومية: ${+text} منشور لكل حساب.`);
      }
      if (text === 'تحديد الموعد') {
        await this.flows.set(id, { prompt: 'schedule', page: 'schedule' });
        return this.bot.transport.sendMessage(id.chat, 'أدخل موعد مكة بصيغة 24 ساعة (مثال: 09:30 أو 21:00):');
      }
      if (text === 'تعطيل الجدولة') {
        await this.bot.settings.setSchedule({ enabled: false });
        await this.flows.set(id, { prompt: null, page: 'schedule' });
        return this.bot.transport.sendMessage(id.chat, '✅ تم تعطيل الجدولة.');
      }
      if (text === 'تفعيل الجدولة') {
        await this.bot.settings.setSchedule({ enabled: true });
        await this.flows.set(id, { prompt: null, page: 'schedule' });
        return this.bot.transport.sendMessage(id.chat, '✅ تم تفعيل الجدولة بتوقيت مكة.');
      }
      if (u.prompt === 'scheduleTimePrompt' || u.prompt === 'schedule') {
        const m = /^(\d{1,2}):(\d{2})$/.exec(text);
        if (!m || +m[1] > 23 || +m[2] > 59) throw new Error('أدخل موعداً صحيحاً بصيغة 24 ساعة مثل 09:30.');
        await this.bot.settings.setSchedule({ enabled: true, hour: +m[1], minute: +m[2] });
        if (u.promptMessageId) {
          await this.bot.transport.deleteMessage(id.chat, u.promptMessageId).catch(err => this._logWarn('telegram_ui_delete_message_suppressed', 'input.schedule', err));
        }
        await this.flows.set(id, { prompt: null, promptMessageId: null, page: 'schedule' });
        const timeStr = `${String(+m[1]).padStart(2, '0')}:${String(+m[2]).padStart(2, '0')}`;
        return this.bot.transport.sendMessage(id.chat, `✅ تم تحديد موعد الجدولة: ${timeStr} بتوقيت مكة (الحالة: 🟢 مفعلة)`);
      }
      return this.bot.transport.sendMessage(id.chat, 'اختر من الأزرار الحالية أو اضغط رجوع.', { reply_markup: this.bot.transport.keyboard(u.page || 'main') });
    } catch (error) {
      const message = /[\u0600-\u06ff]/.test(error.message || '') ? error.message : 'قيمة غير صحيحة: استخدم دقائق:ثوانٍ حتى 60:00، والثواني 0–59، والحد الأعلى لا يقل عن الأدنى. مثال 0:4.';
      return this.bot.transport.sendMessage(id.chat, message, { reply_markup: this.bot.transport.keyboard('waiting') });
    }
  }
  async restore() {
    await this.transientNotices?.recover();
    let snapshot; let stopping = false; let pendingReport;
    await this.bot.store.update(s => {
      snapshot = undefined;
      stopping = false;
      pendingReport = null;
      s.telegramUi ||= {}; s.telegramUi.dashboards ||= {}; s.telegramUi.activePanelsByChatId ||= {};
      // A prior process cannot still own an outbound request. Keep its uncertain
      // delivery fenced, but do not mistake it for an active transport forever.
      delete s.linkExportLease;
      for (const entry of s.linkOutbox || []) if (entry.status === 'sending') entry.status = 'ambiguous';
      const accountIds = new Set((s.accounts || []).map(account => account.id));
      for (const id of Object.keys(s.telegramUi.accountChecks || {})) {
        if (!accountIds.has(id)) delete s.telegramUi.accountChecks[id];
        else if (s.telegramUi.accountChecks[id]?.vpn && !require('./publicIp').isPublicIp(s.telegramUi.accountChecks[id].vpn.ip)) s.telegramUi.accountChecks[id].vpn.ip = null;
      }
      for (const account of s.accounts || []) if (!require('./publicIp').isPublicIp(account.exitIp)) delete account.exitIp;
      for (const u of Object.values(s.telegramUi.users || {})) {
        if (u.panel?.messageId != null && u.chatId != null) {
          const key = String(u.chatId); const old = s.telegramUi.dashboards[key] || s.telegramUi.activePanelsByChatId[key];
          if (!old) {
            const rec = { ...u.panel, chatId: u.chatId };
            s.telegramUi.dashboards[key] = rec;
            s.telegramUi.activePanelsByChatId[key] = rec;
          }
        }
        // Retired upload screens cannot resume or commit an old confirmation.
        // Keep draft resources for ownership-aware cleanup on next navigation.
        if (['cookies','csv','username','cookieConfirm','csvConfirm'].includes(u.prompt)) {
          u.prompt = null; u.flowToken = null; u.confirmMessage = null; u.confirmAt = null;
        }
        if (['cookies','posts'].includes(u.page)) u.page = 'main';
      }
      for (const [key, dashboard] of Object.entries(s.telegramUi.dashboards)) {
        dashboard.token = token(); dashboard.generation=token();dashboard.signature = null;
        s.telegramUi.activePanelsByChatId[key] = { ...(s.telegramUi.activePanelsByChatId[key] || {}), ...dashboard };
        for (const u of Object.values(s.telegramUi.users || {})) if (String(u.chatId) === key) u.panel = { ...dashboard };
      }
      for (const item of [...(s.items || [])]) if (item.state === 'processing' || item.state === 'dispatch_started') {
        if (isProvenPreDispatch(item)) { item.state = 'pending'; delete item.attempt; moveItemToQueueTail(s, item); }
        else item.state = 'ambiguous';
      }
      if (['running', 'stopping'].includes(s.cycle?.state)) {
        const run = s.telegramUi.run;
        const valid = run && typeof run.runId === 'string' && run.runId && run.runId === s.cycle.runId && Array.isArray(run.itemIds) && run.itemIds.length && Array.isArray(run.accountIds) && run.accountIds.length && run.itemIds.every(id => (s.items || []).some(x => x.id === id)) && run.accountIds.every(id => (s.accounts || []).some(x => x.id === id));
        const unsafe = (s.items || []).some(x => ['processing', 'dispatch_started'].includes(x.state));
        stopping = s.cycle.state === 'stopping';
        if (valid && !unsafe && !stopping) snapshot = structuredClone(run);
        else {
          if (valid && stopping) snapshot = structuredClone(run);
          if (run?.runId) s.telegramUi.pendingReport = { ...structuredClone(run), endedAt: run.endedAt || new Date(this.clock()).toISOString() };
          s.cycle = { ...s.cycle, state: 'stopped', runId: null, reason: unsafe ? 'توجد محاولة غير محسومة' : 'توقفت الدورة بعد إعادة التشغيل' };
        }
      }
      pendingReport = structuredClone(s.telegramUi.pendingReport || null);
      return s;
    });
    if (pendingReport && this.onCycleFinished) await this.onCycleFinished(pendingReport);
    if (stopping && snapshot) {
      if (this.onCycleFinished && pendingReport?.runId !== snapshot.runId) await this.onCycleFinished(snapshot);
      return {};
    }
    if (snapshot) {
      const state = await this.bot.store.load();
      const protectedTexts = protectedTextKeys(state.items || []);
      const hasPending = (state.items || []).some(x => snapshot.itemIds.includes(x.id) && isClaimableInState(x, state, protectedTexts));
      const quotaAvailable = snapshot.accountIds.some(id => { const account = (state.accounts || []).find(a => a.id === id); return account && accountCapacity(state, account, this.clock()).remaining > 0; });
      if (hasPending && quotaAvailable) {
        const ready = await this.readiness(state, { itemIds: snapshot.itemIds, accountIds: snapshot.accountIds });
        if (ready.reasons.length) {
          await this.bot.store.update(s => {
            if (s.cycle?.runId === snapshot.runId) { s.telegramUi.pendingReport = { ...structuredClone(snapshot), endedAt: snapshot.endedAt || new Date(this.clock()).toISOString() }; s.cycle = { ...s.cycle, state: 'stopped', runId: null, reason: ready.reasons.join('، ') }; }
            return s;
          });
          if (this.onCycleFinished) await this.onCycleFinished(snapshot);
          return {};
        }
      }
      return { resume: snapshot };
    }
    return {};
  }
  async stopTicker() { this.tickerEnabled=false; if (this.ticker) { clearInterval(this.ticker); this.ticker = null; } if (this.refreshTask) await this.refreshTask.catch(err => this._logWarn('refresh_task_drain_failed', 'stopTicker', err)); await Promise.allSettled([...this.panelLocks.values()]); }
  async destroy() {
    this.destroyed = true;
    this.isPreparing = false;
    this.preparingGeneration = (this.preparingGeneration || 0) + 1;
    if (this.panelRetryTimers) {
      for (const timer of this.panelRetryTimers.values()) clearTimeout(timer);
      this.panelRetryTimers.clear();
    }
    this.pendingPanelDeliveries?.clear();
    this.panelTransientRetryCounts?.clear();
    for (const job of this.accountCheckTasks?.values() || []) job.controller.abort();
    await Promise.allSettled([...this.accountCheckTasks?.values() || []].map(job => job.task));
    this.cancelPendingStarts();
    await this.fastNavigation?.close();
    await this.stopNormalizedDashboardLoop();
    await this.normalizedDashboardReader?.close?.();
    const job = this.accountRefreshJob; job?.controller.abort();
    await job?.task;
    if (this.controlTasks?.size) {
      await Promise.allSettled([...this.controlTasks]);
    }
    if (this.deliveryTasks?.size) {
      await Promise.allSettled([...this.deliveryTasks]);
    }
    await this.transientNotices?.close();
    await this.stopTicker();
  }
  startAccountRefresh(opts = {}) {
    if (this.destroyed || !this.isolatedVerifier?.verify) return;
    if (this.accountRefreshJob) { this.accountRefreshJob.nudge(); return this.accountRefreshJob; }
    const job = require('./accountRefresh').createAccountRefresh(this, { retryMs: this.accountRefreshRetryMs, ...opts });
    this.accountRefreshJob = job;
    this.evaluateDashboardPolling();
    job.task = job.run().catch(err => this._logError('account_refresh_job_failed', 'startAccountRefresh', err)).finally(async () => {
      if (this.accountRefreshJob === job) this.accountRefreshJob = null;
      this.evaluateDashboardPolling();
      if (!this.destroyed) {
        await this.readFreshDashboard().catch(() => {});
        await this.refreshPanels(true).catch(() => {});
      }
    });
    return job;
  }
  controls(state, t) {
    const active = ['running', 'stopping'].includes(state) || Boolean(this.isPreparing);
    return {
      inline_keyboard: [[
        { text: active ? '🔴 إيقاف' : '🟢 تشغيل', callback_data: `cycle:${active ? 'stop' : 'start'}:${t}`, ...(this.inlineStyles ? { style: active ? 'danger' : 'success' } : {}) },
        { text: this.accountRefreshJob ? '⏳ جاري التحديث' : '🔄 تحديث', callback_data: `cycle:refresh:${t}`, ...(this.inlineStyles ? { style: 'primary' } : {}) }
      ]]
    };
  }
  async readiness(state, scope = {}) {
    if (scope.signal?.aborted) return { reasons: ['تم إلغاء فحص الجاهزية'], ids: [] };
    const reasons = [];
    const accountIds = scope.accountIds ? new Set(scope.accountIds) : null;
    const itemIds = scope.itemIds ? new Set(scope.itemIds) : null;
    const accounts = (state.accounts || []).filter(a => (!accountIds || accountIds.has(a.id)) && eligible(a));
    const accessible = [];
    for (const a of accounts) {
      if (scope.signal?.aborted) return { reasons: ['تم إلغاء فحص الجاهزية'], ids: [], aborted: true };
      try {
        await fs.access(a.cookieFile);
        accessible.push(a);
      } catch (err) {
        this._logWarn('cookie_file_inaccessible', 'readiness', err, { accountId: a.id });
      }
    }
    if (!accessible.length) reasons.push('لا يوجد حساب مفعل باسم مستخدم وملف جلسة قابل للقراءة');
    const activeAccounts = (state.accounts || []).filter(a => a.enabled !== false && !['محظور', 'كابتشا', 'معزول (3 إخفاقات)', 'غير مفعل'].includes(a.status));
    if (activeAccounts.length > MAX_ACTIVE_ACCOUNTS) reasons.push('الحد الأقصى للحسابات المفعلة في نفس الوقت هو 5 حسابات');
    if (cycleRunning(state) && (state.items || []).some(x => ['processing', 'dispatch_started'].includes(x.state))) reasons.push('توجد محاولة سابقة قيد التنفيذ');
    const protectedTexts = protectedTextKeys(state.items || []);
    const pending = (state.items || []).filter(x => (!itemIds || itemIds.has(x.id)) && isClaimableInState(x, state, protectedTexts) && validText(x.payload?.text));
    const pinned = pending.filter(x => x.payload?.account);
    if (pinned.some(x => !accessible.some(a => a.id === x.payload.account))) reasons.push('يوجد منشور مرتبط بحساب غير مؤهل');
    if (!pending.length) reasons.push('لا توجد منشورات صالحة في الانتظار');
    const explicitMin = state.settings?.delayMinSeconds;
    const explicitMax = state.settings?.delayMaxSeconds;
    if ((explicitMin != null && explicitMax == null) || (explicitMin == null && explicitMax != null) || explicitMin === null || explicitMax === null) {
      reasons.push('يجب تحديد الحد الأدنى والحد الأعلى للتأخير قبل بدء العمل');
    }
    const settings = { ...DEFAULT_SETTINGS, ...(state.settings || {}) };
    if (!validSettings(settings)) reasons.push('التأخير أو الحصة غير صالحين');
    if (typeof this.launch !== 'function') reasons.push('مشغل الدورة غير متاح');
    const quota = quotaAdmission(state, { accounts: accessible, items: pending, now: this.clock() });
    if (quota.exhausted) return { reasons: [...reasons, quota.message], ids: accessible.map(a => a.id), quota };
    if (!pending.length) return { reasons, ids: accessible.map(a => a.id) };
    let ids = accessible.map(a => a.id);
    if (reasons.length) return { reasons, ids };
    try {
      const vpnMgr = this.vpnManager || this.bot?.vpnManager;
      if (typeof vpnMgr?.reconcile === 'function') {
        const activeIds = (state.accounts || []).filter(a => a.enabled !== false).map(a => a.id);
        await vpnMgr.reconcile({ accountIds: activeIds, dryRun: false, signal: scope.signal }).catch(() => {});
      }
      if (scope.signal?.aborted) return { reasons: ['تم إلغاء فحص الجاهزية'], ids: [], aborted: true };
      const r = await this.runtimeReady({ ...scope, accountIds: ids, signal: scope.signal }, { state });
      if (Array.isArray(r?.ids)) ids = ids.filter(id => r.ids.includes(id));
      if (!ids.length) reasons.push('لا يوجد حساب جاهز عبر اتصال VPN معزول'); if (r?.ready !== true) reasons.push(...(Array.isArray(r?.reasons) && r.reasons.length ? r.reasons.filter(x => typeof x === 'string' && /[\u0600-\u06ff]/.test(x)) : ['مكونات النشر الفعلي غير جاهزة'])); if (r?.ready !== true && !reasons.length) reasons.push('مكونات النشر الفعلي غير جاهزة'); }
    catch (err) {
      this._logError('runtime_readiness_check_failed', 'readiness', err);
      reasons.push('تعذر التحقق من جاهزية التشغيل');
    }
    return { reasons, ids };
  }
  async countVisibleQueue(items,state,protectedTexts) {
    let count=0;
    for(let i=0;i<items.length;i++) {
      if(isClaimableInState(items[i],state,protectedTexts))count++;
      if(i%2048===2047)await new Promise(resolve=>setImmediate(resolve));
    }
    return count;
  }
  async render(state, {onView}={}) {
    const renderStarted=performance.now();
    const now=this.clock(),items=state.items||[],running=cycleRunning(state);
    const protectedTexts=protectedTextKeys(items),totals=getCurrentRunTotals(state);
    const eta=running?estimateCycle(state,{now,eligible}):{seconds:null,nextAt:null,finishAt:null};
    const view={eta,running,preparing:Boolean(this.isPreparing),startedAt:Date.parse(state.cycle?.startedAt||''),publishingAt:Date.parse(state.posting?.publishingAt||''),
      active:(state.accounts||[]).filter(a=>eligible(a)&&(a.failures||0)<3).length,
      stoppedStatus:'متوقف',
      queueTotal:await this.countVisibleQueue(items,state,protectedTexts),
      succeeded:totals.succeeded,failed:totals.failed,
      mode:'rich',
      accounts:formatAccountTable(state,{now,refreshingIds:this.accountRefreshJob?.pending,mode:'rich'})};
    onView?.(view);
    logStructured(this.bot.logger,{component:'telegram_ui',event:'telegram_render_timing',durationMs:Math.round(performance.now()-renderStarted),itemCount:items.length});
    return this.renderPanelView(view);
  }
  renderPanelView(view) {
    const now=+new Date(this.clock()),{eta,running}=view;
    const isPreparingView=Boolean(view.preparing && !running);
    const elapsed=Number.isFinite(view.startedAt)?Math.max(0,(now-view.startedAt)/1000):0;
    const status=running
      ? `يعمل منذ (${formatElapsedHms(elapsed)})`
      : isPreparingView
        ? 'جاري تجهيز الحسابات'
        : 'متوقف';
    const countdown=running&&eta?.nextAt>=now?durationText((eta.nextAt-now)/1000):'غير متاح';
    const nextLine=running&&Number.isFinite(view.publishingAt)?`جاري النشر الآن... (${Math.max(0,Math.floor((now-view.publishingAt)/1000))} ث)`:countdown;
    const hasValidBounds = !eta?.bounds || (
      Number.isFinite(eta.bounds.minSeconds) &&
      Number.isFinite(eta.bounds.maxSeconds) &&
      eta.bounds.minSeconds <= eta.bounds.maxSeconds &&
      (!Number.isFinite(eta.bounds.finishAtMax) || riyadhDay(eta.bounds.finishAtMax) === riyadhDay(now))
    );
    const reliable = Boolean(
      running &&
      eta &&
      !eta.reason &&
      Number.isFinite(eta.seconds) &&
      eta.seconds != null &&
      Number.isFinite(eta.finishAt) &&
      eta.finishAt >= now &&
      (!Number.isFinite(eta.nextAt) || eta.nextAt >= now) &&
      riyadhDay(eta.finishAt) === riyadhDay(now) &&
      hasValidBounds
    );
    const finish = reliable ? formatRiyadhClock(eta.finishAt) : '--';
    const rows = [
      [status,'حالة العمل'],
      [String(view.queueTotal),'المنشورات في الطابور']
    ];
    if (view.todayPreDispatchRetries !== undefined || view.todaySuccess !== undefined) {
      rows.push(
        [String(view.todaySuccess ?? view.succeeded ?? 0),'نجاح اليوم'],
        [String(view.todayFailed ?? view.failed ?? 0),'فشل إرسال مؤكد اليوم'],
        [String(view.todayPreDispatchRetries ?? 0),'محاولات قبل الإرسال/إعادة المحاولة اليوم']
      );
    } else {
      rows.push(
        [String(view.failed),'المحاولات الفاشلة'],
        [String(view.succeeded),'المنشورات الناجحة']
      );
    }
    rows.push(
      [`${view.active}/5`,'الحسابات الفعالة'],
      [nextLine,'المنشور التالي بعد'],
      [finish,'الوقت المتوقع للانتهاء']
    );
    const table = view?.mode === 'rich'
      ? richTable(['القيمة','البند'], rows, 'لوحة التحكم والتشغيل')
      : preTable(['القيمة','البند'], rows, 'لوحة التحكم والتشغيل');
    return [table,view.accounts].join('\n\n');
  }

  async panel(id, force = false, fresh = false) {
    if(fresh)return this.openWorkPanel(id);
    const key=String(id.chat), observed=this.currentPanel(id.chat);
    const root=this.fastNavigation?null:(!force && this.normalizedDashboardReader)?null:(this.bot.store.section?await this.bot.store.section('telegramUi'):(await this.bot.store.load()).telegramUi);
    const nowCurrent=this.currentPanel(id.chat);
    const current=this.currentPanel(id.chat,'dashboard',root || (this.fastNavigation ? undefined : {}));
    const sameOwner=(a,b)=>this.samePanel(a,b)&&(a?.token??null)===(b?.token??null);
    if(observed&&!sameOwner(nowCurrent,observed))return;
    if(!this.fastNavigation){
      if(observed&&!sameOwner(nowCurrent,current))return;
      if(!observed&&nowCurrent&&!sameOwner(nowCurrent,current))return;
      if(current&&!nowCurrent){this.interfacePanelOwners ||=new Map();this.interfacePanelOwners.set(`${id.chat}:dashboard`,current);}
    }
    if(!current?.messageId){this.pendingPanelDeliveries?.delete(key);this.clearPanelRetryTimer(key);this.panelTransientRetryCounts?.delete(key);return;}
    const owns=()=>this.canEditPanel(id.chat,current);
    const operation=(this.panelLocks.get(key)||Promise.resolve()).catch(()=>{}).then(()=>require('./telegram').navigationContext.run(null,async()=>{
      const now=Date.now(),nav=this.fastNavigation;
      const blockedUntil=this.panelBlockedUntil.get(key)||0;
      if(blockedUntil>now){
        if(force||this.pendingPanelDeliveries?.has(key)){
          this.pendingPanelDeliveries ||= new Set();
          this.pendingPanelDeliveries.add(key);
          if(!this.panelRetryTimers?.has(key))this.schedulePanelRetry(id,key,blockedUntil-now);
        }
        return;
      }
      const minEditIntervalMs = Number.isFinite(this.normalizedDashboardIntervalMs) ? Math.min(950, Math.max(0, this.normalizedDashboardIntervalMs - 50)) : 950;
      if(!force&&now-(this.panelLastEdit.get(key)||0)<minEditIntervalMs)return;
      const isActive = this.isDashboardActive();
      if(!force && !isActive && !this.pendingPanelDeliveries?.has(key) && nav && Object.values(nav.users).some(u=>String(u.chatId)===key&&u.page!=='main'))return;
      if(!owns()){this.pendingPanelDeliveries?.delete(key);this.clearPanelRetryTimer(key);this.panelTransientRetryCounts?.delete(key);return;}
      if(!force && this.normalizedDashboardReader && (!nav?.panelView || !(nav?.snapshot?.cycle || this.normalizedPanelSnapshot?.cycle))) return;
      if(nav?.dirty){if(force){this.pendingPanelDeliveries ||= new Set();this.pendingPanelDeliveries.add(key);}nav.refresh();return;}
      let text;
      if (nav?.panelView) {
        const view = { ...nav.panelView, preparing: Boolean(this.isPreparing) };
        if (this.normalizedPanelSnapshot) {
          // Refresh's accepted target set is local UI state, not a DB mutation.
          // Overlay it immediately; don't wait for the next changed SQL signature.
          const projection = this.normalizedProjectionState(this.normalizedPanelSnapshot);
          view.accounts = formatAccountTable(projection, { now: this.clock(), refreshingIds: this.accountRefreshJob?.pending, mode: 'rich' });
        } else if (nav.lastObservedState) {
          view.accounts = formatAccountTable(nav.lastObservedState, { now: this.clock(), refreshingIds: this.accountRefreshJob?.pending, mode: 'rich' });
        }
        text = this.renderPanelView(view);
      } else {
        text = await this.render(await this.bot.store.load());
      }
      const state = nav?.snapshot?.cycle || (nav?.panelView ? (this.normalizedPanelSnapshot?.cycle || { state: nav.panelView.running ? 'running' : 'stopped' }) : (await this.bot.store.load()).cycle);
      const effectiveState = this.isPreparing && !['running', 'stopping'].includes(state?.state) ? 'preparing' : (state?.state || 'stopped');
      const markup=this.controls(effectiveState,current.token),signature=JSON.stringify({text,markup});
      if(this.currentPanel(id.chat)?.signature===signature){this.pendingPanelDeliveries?.delete(key);this.clearPanelRetryTimer(key);this.panelTransientRetryCounts?.delete(key);return;}
      try{
        const sent=await this.bot.transport.editMessageText(id.chat,current.messageId,text,{rich_message:{html:text},reply_markup:markup,_background:true,_controlPriority:true,_isCurrent:owns});
        if(sent?.superseded || !owns()){this.pendingPanelDeliveries?.delete(key);this.clearPanelRetryTimer(key);this.panelTransientRetryCounts?.delete(key);return;}
        this.pendingPanelDeliveries?.delete(key);
        this.clearPanelRetryTimer(key);
        this.panelTransientRetryCounts?.delete(key);
        this.panelLastEdit.set(key,now);
        await this.savePanel(id,{...current,signature,updatedAt:now},owns,{kind:'dashboard',expected:current});
      }catch(error){
        if(!owns()){this.pendingPanelDeliveries?.delete(key);this.clearPanelRetryTimer(key);this.panelTransientRetryCounts?.delete(key);return;}
        if(error.telegramCode===429){
          this.panelTransientRetryCounts?.delete(key);
          const retryMs=Math.max(1,(Number(error.retryAfter)||30)*1000);
          this.panelBlockedUntil.set(key,Date.now()+retryMs);
          this.pendingPanelDeliveries ||= new Set();
          this.pendingPanelDeliveries.add(key);
          this.schedulePanelRetry(id,key,retryMs);
        }else if(error.telegramCode===400&&/message to edit not found|message can't be edited/i.test(error.description||error.message)){
          this.pendingPanelDeliveries?.delete(key);
          this.clearPanelRetryTimer(key);
          this.panelTransientRetryCounts?.delete(key);
          return;
        }else if(Number.isFinite(error.telegramCode)&&error.telegramCode>=400&&error.telegramCode<500&&error.telegramCode!==408){
          this.pendingPanelDeliveries?.delete(key);
          this.clearPanelRetryTimer(key);
          this.panelTransientRetryCounts?.delete(key);
        }else{
          const attempts=(this.panelTransientRetryCounts?.get(key)||0)+1;
          const maxAttempts=this.panelTransientRetryMaxAttempts??5;
          if(attempts<=maxAttempts&&!this.destroyed){
            this.panelTransientRetryCounts ||= new Map();
            this.panelTransientRetryCounts.set(key,attempts);
            const baseMs=Number.isFinite(this.panelTransientRetryBaseMs)?this.panelTransientRetryBaseMs:2000;
            const retryMs=Math.min(30000,Math.max(1,baseMs*(2**(attempts-1))));
            this.pendingPanelDeliveries ||= new Set();
            this.pendingPanelDeliveries.add(key);
            this.schedulePanelRetry(id,key,retryMs);
          }else{
            this.pendingPanelDeliveries?.delete(key);
            this.clearPanelRetryTimer(key);
            this.panelTransientRetryCounts?.delete(key);
          }
        }
        throw error;
      }
    }));
    this.panelLocks.set(key,operation);try{return await operation;}finally{if(this.panelLocks.get(key)===operation)this.panelLocks.delete(key);}
  }
  async work(request, raw) {
    const id = this.identity(raw); await this.flows.cleanup(id); await this.page(id, 'main');
    return this.openWorkPanel(id,request||{});
  }
  async exportLinks(request, raw) {
    const id=this.identity(raw);
    await this._clearPromptState(id);
    if (!this.exportTodayLinks) return this.flows.notice(id,'تصدير الروابط غير متاح الآن. حاول لاحقاً.');
    return this.exportTodayLinks({chatId:id.chat,at:request?.exportAt ?? this.clock()});
  }
  async settings(_, raw) {
    const id = this.identity(raw);
    await this.flows.cleanup(id);
    await this.page(id, 'settings', null);
    const keyboardObj = await this.getSettingsKeyboard();
    const sent = await this.bot.transport.sendMessage(id.chat, 'الإعدادات', { reply_markup: keyboardObj });
    this._retireTransitionalBubble(id.chat, sent);
    return sent;
  }
  async accounts(_, raw) { const id = this.identity(raw); await this.flows.cleanup(id); return this.flows.accounts(id); }
  refreshPanels(force = false) {
    if (this.destroyed) return Promise.resolve();
    if (!force && this.fastNavigation && !this.isDashboardActive() && !this.hasPendingPanelDelivery()) return Promise.resolve();
    if (force) this.pendingForcedRefresh = true;
    if (this.refreshTask) return this.refreshTask;
    const execute = async () => {
      do {
        const isForced = this.pendingForcedRefresh;
        this.pendingForcedRefresh = false;
        await this._executeRefreshPanels(isForced);
      } while (this.pendingForcedRefresh);
    };
    const tracked = execute().finally(() => { if (this.refreshTask === tracked) this.refreshTask = null; });
    this.refreshTask = tracked;
    this.onPanelTask?.(tracked);
    return tracked;
  }
  async _executeRefreshPanels(force = false) {
    const s = this.fastNavigation ? {telegramUi:{users:this.fastNavigation.users,activePanelsByChatId:this.fastNavigation.panels}} : this.bot.store.section ? {telegramUi:await this.bot.store.section('telegramUi')} : await this.bot.store.load();
    const seen = new Set(); const tasks = [];
    const activePanels = s.telegramUi?.activePanelsByChatId || {};
    const dashboards = s.telegramUi?.dashboards || {};
    const users = s.telegramUi?.users || {};
    const isAllowed = id => {
      if (!this.bot?.auth) return false;
      if (this.bot.auth.chats?.has('__bot_unconfigured__')) return false;
      const chat = id.chat != null ? id.chat : id.chatId;
      if (this.bot.auth.isChatAllowed && !this.bot.auth.isChatAllowed(chat)) return false;
      const user = id.user != null ? id.user : id.userId;
      if (user != null && this.bot.auth.isAllowed && !this.bot.auth.isAllowed({ userId: user, chatId: chat })) return false;
      return true;
    };

    for (const [chatId, p] of Object.entries(activePanels)) {
      const realChat = p?.chatId != null ? p.chatId : chatId;
      const key = String(realChat);
      if (p?.messageId != null && !seen.has(key)) {
        const realUser = p?.userId != null ? p.userId : realChat;
        const identity = { key: `${realChat}:${realUser}`, chat: realChat, user: realUser };
        if (isAllowed(identity)) {
          seen.add(key);
          tasks.push(this.panel(identity, force));
        }
      }
    }
    for (const [chatId, p] of Object.entries(dashboards)) {
      const realChat = p?.chatId != null ? p.chatId : chatId;
      const key = String(realChat);
      if (p?.messageId != null && !seen.has(key)) {
        const realUser = p?.userId != null ? p.userId : realChat;
        const identity = { key: `${realChat}:${realUser}`, chat: realChat, user: realUser };
        if (isAllowed(identity)) {
          seen.add(key);
          tasks.push(this.panel(identity, force));
        }
      }
    }
    for (const [key, u] of Object.entries(users)) {
      const realChat = u?.chatId != null ? u.chatId : key.split(':')[0];
      const chatKey = String(realChat);
      if (u?.panel?.messageId != null && !seen.has(chatKey)) {
        const identity = { key, chat: u.chatId, user: u.userId };
        if (isAllowed(identity)) {
          seen.add(chatKey);
          tasks.push(this.panel(identity, force));
        }
      }
    }
    if (force) {
      await Promise.all(tasks);
    } else {
      const outcomes = await Promise.allSettled(tasks);
      for (const o of outcomes) {
        if (o.status === 'rejected') {
          this._logWarn('panel_refresh_task_rejected', 'refreshPanels', o.reason);
        }
      }
    }
  }
  async _preflightActivation(accountId) {
    const accounts = this.bot.store.section ? await this.bot.store.section('accounts') : (await this.bot.store.load()).accounts || [];
    const telegramUi = this.bot.store.section ? await this.bot.store.section('telegramUi') : (await this.bot.store.load()).telegramUi;
    const state = { accounts, telegramUi };
    const account = (state.accounts || []).find(a => a.id === accountId);
    if (!account) return { allowed: false, reason: 'account_not_found' };
    let policy = evaluateAccountUse(state, account, { requireOwnerEnabled: false });
    if (policy.allowed) return policy;
    if (['banned', 'captcha', 'account_restricted'].includes(policy.reason)) return policy;
    // Per Rule 5 in AGENTS.md:
    // Any account with enabled !== false and a valid cookie file is allowed immediately.
    if (account.cookieFile && !isBannedStatus(account.status) && !isCaptchaStatus(account.status) && !account.needsOwnerCaptcha) {
      return { allowed: true, reason: null };
    }
    return policy;
  }

  async recordAccountCheck(accountId, result = {}, { session = false, source = 'x-session', expectedAccount, refresh = false, signal, onApplied, isCurrent = () => true } = {}) {
    if (!['x-session', 'vpn-health'].includes(source)) throw new TypeError('Unknown account check source');
    const checkedAt = new Date(this.clock()).toISOString();
    const observationOrder = Number.isFinite(result.observationOrder) ? result.observationOrder : this.beginAccountObservation();
    const isolated = result.isolated === true;
    const healthy = isolated && result.vpnHealthy === true;
    const rawIp = result.exitIp || result.ip;
    const ip = healthy && require('./publicIp').isPublicIp(rawIp) ? rawIp : null;
    const structuredFailure = String(result.accountFailure || result.state || '').trim().toLowerCase();
    const confirmedSuspension = result.suspended === true || result.banned === true || ['suspended_confirmed', 'suspended', 'banned'].includes(structuredFailure);
    const confirmedChallenge = result.captcha === true || result.challenge === true || result.locked === true || ['challenge_required', 'captcha', 'locked'].includes(structuredFailure);
    const failure = confirmedSuspension ? 'banned' : confirmedChallenge ? 'captcha' : result.accountFailure || null;
    const isSecurityIsolation = failure === 'captcha' || failure === 'banned';
    const isTransientError = result.transientError === true || (!failure && result.retryable === true && result.reason === 'identity_read_unavailable');
    const effectiveSession = session || isSecurityIsolation || isTransientError || Object.hasOwn(result, 'authenticated');
    let applied = false;
    try { await this.bot.store.update(s => {
      applied = false;
      const account = s.accounts?.find(a => a.id === accountId);
      if (!account || signal?.aborted || !isCurrent(s)) return s;
      // Refresh must not invalidate a live claim/dispatch. Re-observe after it
      // settles; the publisher retains its own mandatory restriction gate.
      if (refresh && !isSecurityIsolation && (s.items || []).some(i => ['processing', 'dispatch_started'].includes(i.state) && (i.attempt?.accountId === accountId || i.accountId === accountId))) return s;
      if (expectedAccount) {
        if (refresh && ['checkGeneration', 'cookieFile', 'enabled', 'username', 'userId'].some(key => account[key] !== expectedAccount[key])) return s;
        if (isSecurityIsolation) {
          // Authoritative restrictions still require the captured credential
          // generation; a late check may not restrict replacement credentials.
          const cookieMismatch = expectedAccount.cookieFile != null && account.cookieFile != null && account.cookieFile !== expectedAccount.cookieFile;
          const userIdMismatch = expectedAccount.userId != null && account.userId != null && String(account.userId) !== String(expectedAccount.userId);
          const usernameMismatch = expectedAccount.username != null && account.username != null && String(account.username).toLowerCase() !== String(expectedAccount.username).toLowerCase();
          if (cookieMismatch || userIdMismatch || usernameMismatch || account.checkGeneration !== expectedAccount.checkGeneration) return s;
        } else if (['checkGeneration', 'cookieFile', 'enabled', 'username', 'userId'].some(key => account[key] !== expectedAccount[key])) {
          return s;
        }
      }
      s.telegramUi ||= {}; s.telegramUi.accountChecks ||= {};
      const previousChecks=s.telegramUi.accountChecks[accountId];
      if(observationOrder < Math.max(previousChecks?.session?.observationOrder || 0, previousChecks?.vpn?.observationOrder || 0))return s;
      if(!isSecurityIsolation && Number.isInteger(result.slot) && s.vpnSlots?.[accountId] != null && s.vpnSlots[accountId] !== result.slot)return s;
      applied = true;
      if (!Object.hasOwn(s.telegramUi.accountChecks, accountId)) Object.defineProperty(s.telegramUi.accountChecks, accountId, { value: {}, enumerable: true, configurable: true, writable: true });
      const checks = s.telegramUi.accountChecks[accountId];
      const vpnEvidence = ['isolated', 'vpnHealthy', 'exitIp', 'ip'].some(key => Object.hasOwn(result, key));
      const effectiveSlot = Number.isInteger(result.slot) ? result.slot : (Number.isInteger(s.vpnSlots?.[accountId]) ? s.vpnSlots[accountId] : null);
      if (vpnEvidence) {
        const old=checks.vpn;
        const validBound=healthy&&ip&&Number.isInteger(effectiveSlot)&&(s.vpnSlots?.[accountId]===effectiveSlot || s.vpnSlots?.[accountId] == null);
        const lastSuccess=validBound ? {checkedAt,source,isolated:true,healthy:true,ip,slot:effectiveSlot,checkGeneration:account.checkGeneration || null,observationOrder}
          : old?.lastSuccess || (old?.healthy&&old?.isolated&&require('./publicIp').isPublicIp(old.ip)&&Number.isInteger(old.slot)?{...old}:null);
        // A partial/session failure describes this attempt only, never relabels
        // the retained IP with a new slot or a new observation timestamp.
        checks.vpn={checkedAt,source,isolated,healthy:validBound,ip:validBound?ip:null,
          slot:Number.isInteger(effectiveSlot)?effectiveSlot:null,checkGeneration:account.checkGeneration || null,
          observationOrder,lastSuccess};
      }
      else if (checks.vpn && !require('./publicIp').isPublicIp(checks.vpn.ip)) checks.vpn.ip = null;
      if (ip) {
        account.exitIp = ip;
        if (Number.isInteger(effectiveSlot) && effectiveSlot >= 0 && effectiveSlot < 5) {
          s.telegramUi ||= {};
          s.telegramUi.slotIps ||= {};
          s.telegramUi.slotIps[effectiveSlot] = ip;
        }
      }
      if (isTransientError) {
        const errMsg = String(result.lastError || result.error || result.reason || 'transient_error');
        account.lastError = errMsg;
        account.lastErrorAt = checkedAt;
        checks.lastError = errMsg;
      }
      if (effectiveSession && source === 'x-session') {
        if (failure === 'banned') {
          account.enabled = false;
          account.status = 'محظور';
          delete account.needsOwnerCaptcha;
          delete account.captchaIncidentId;
          delete account.captchaDeliveredIncidentId;
          account.captchaDeliveredChats = [];
          account.checkGeneration = crypto.randomUUID();
          if (checks.vpn) checks.vpn.checkGeneration = account.checkGeneration;
          if (checks.session) checks.session.checkGeneration = account.checkGeneration;
        } else if (failure === 'captcha') {
          if (isBannedStatus(account.status)) {
            account.enabled = false;
            account.status = 'محظور';
          } else {
            // Scope receipt history to the newly detected incident, not this account.
            // Repeated checks of the same pending incident must not break owner CAS.
            const alreadyPending = account.needsOwnerCaptcha && account.captchaIncidentId && isCaptchaStatus(account.status);
            account.enabled = false;
            account.status = 'كابتشا (مطلوب حل يدوي)';
            account.needsOwnerCaptcha = true;
            if (!alreadyPending) {
              account.captchaDetectedAt = Date.now();
              account.captchaIncidentId = crypto.randomUUID();
              account.captchaDeliveredIncidentId = account.captchaIncidentId;
              account.captchaDeliveredChats = [];
              delete account.lastNotifiedCaptchaIncidentId;
              account.checkGeneration = crypto.randomUUID();
            }
          }
        } else if (!isTransientError && (['auth_session_unverified','cookie_expired','auth_rejected','auth','unknown'].includes(failure) || (result.authenticated !== true && !failure))) {
          // Unverified session / cause uncertain: DO NOT default to 'محظور'!
          // Only preserve existing 'محظور' if it was already marked as such by an authoritative check.
          // ALSO preserve existing pending owner CAPTCHA workflow! A periodic unverified check
          // must never overwrite pending challenge status, incident metadata, or checkGeneration.
          const isPendingCaptcha = Boolean(account.needsOwnerCaptcha) || isCaptchaStatus(account.status);
          if (!isBannedStatus(account.status) && !isPendingCaptcha) {
            // Hold eligibility via status, not the owner's enable preference.
            account.unverifiedReason = failure || result.reason || 'auth_session_unverified';
            account.status = 'غير محقق (جلسة غير مؤكدة)';
            account.checkGeneration = crypto.randomUUID();
          }
        } else if (!isTransientError && result.authenticated === true && !failure) {
          delete account.lastError;
          delete account.lastErrorAt;
        }
      }
      if (effectiveSession && healthy && ip && result.authenticated === true && !failure && !isTransientError) {
        if (!account.needsOwnerCaptcha && !isCaptchaStatus(account.status) && !isBannedStatus(account.status)) {
          account.status = account.enabled === false ? 'غير مفعل' : 'مفعل';
          delete account.unverifiedReason;
          if (!account.username && /^[A-Za-z0-9_]{1,15}$/.test(result.username || '')) account.username = result.username;
          if (!account.userId && result.userId != null && /^\d+$/.test(String(result.userId))) account.userId = String(result.userId);
        }
      }
      onApplied?.(structuredClone(account));
      if (effectiveSession && !isTransientError) checks.session = {
        checkedAt, source, isolated, healthy, observationOrder,
        authenticated: isolated && result.authenticated === true,
        username: /^[A-Za-z0-9_]{1,15}$/.test(result.username || '') ? result.username : null,
        userId: result.userId != null ? String(result.userId) : null,
        cookieFile: account.cookieFile || null,
        checkGeneration: account.checkGeneration || null,
        state: result.state || null,
        accountFailure: result.accountFailure || null,
        reason: result.reason || null,
        ...Object.fromEntries(['challenge', 'locked', 'captcha', 'suspended', 'banned'].map(flag => [flag, isolated && result[flag] === true]))
      };
      return s;
    }); } catch { throw Object.assign(new Error('Account check persistence failed'), { code: 'ACCOUNT_CHECK_PERSIST_FAILED' }); }
    if (applied && effectiveSession && source === 'x-session' && (result.accountFailure === 'captcha' || result.captcha === true)) {
      // Background checks are also responsible for alerting the owner. Repeated
      // checks reuse the incident ID and per-chat delivered receipt state.
      const fresh = await this.bot.store.load();
      const challenged = fresh.accounts?.find(a => a.id === accountId);
      if (challenged?.needsOwnerCaptcha) {
        await this.sendIsolationAlert({ account: challenged, reason: 'captcha' })
          .catch(err => this._logError('captcha_alert_failed', 'recordAccountCheck', err, { accountId }));
      }
    }
    return applied;
  }
  async rejectQuota(quota, id) {
    return { started: false, reasons: [quota.message], reason: quota.reason };
  }
  async begin(source, id, suppliedToken, { maxItems, stopAfterSuccess = false, occurrence, taskId, taskGeneration, entryStopGeneration: initialStopGeneration, preparingGeneration: initialPrepGen, panel: expectedPanel } = {}) {
    const startGeneration = this.startGeneration || 0;
    const taskGen = taskGeneration ?? (this.controlTaskGeneration || 0);
    const entryStopGeneration = initialStopGeneration ?? (this.stopGeneration || 0);
    if (this.destroyed || entryStopGeneration !== (this.stopGeneration || 0) || (initialPrepGen != null && initialPrepGen !== (this.preparingGeneration || 0))) {
      return { started: false, cancelled: true };
    }
    const activeStart = this.activeStartFlight;
    if (activeStart && !activeStart.controller.signal.aborted && activeStart.startGeneration === startGeneration && activeStart.stopGeneration === entryStopGeneration && !this.job) {
      return activeStart.promise;
    }
    this.startTicker();
    const beginStartedAt = Date.now();
    const scheduledPrepStartedMs = new Date(this.clock()).getTime();
    const abortController = new AbortController();
    this.pendingStartAbortController = abortController;
    this.pendingStartAbortControllers ||= new Set();
    this.pendingStartAbortControllers.add(abortController);
    const signal = abortController.signal;
    const activeFlight = { source, promise: null, controller: abortController, startGeneration, stopGeneration: entryStopGeneration, settled: false };
    this.activeStartFlight = activeFlight;

    const isCancelled = () => Boolean(
      this.destroyed ||
      (expectedPanel && !this.ownsPanel(id.chat, expectedPanel)) ||
      signal.aborted ||
      startGeneration !== (this.startGeneration || 0) ||
      taskGen !== (this.controlTaskGeneration || 0) ||
      entryStopGeneration !== (this.stopGeneration || 0) ||
      (initialPrepGen != null && initialPrepGen !== (this.preparingGeneration || 0))
    );

    let prepGen = null;
    const runBegin = async () => {
    try {
      if (isCancelled()) return { started: false, cancelled: true };
      prepGen = initialPrepGen != null ? initialPrepGen : ++this.preparingGeneration;
      this.isPreparing = true;
      this.evaluateDashboardPolling();
      // Join refresh cleanup before opening any publisher session. Never race away
      // a verifier that still owns the account's single session lease.
      const refresh = this.accountRefreshJob;
      if (refresh) {
        try {
          if (refresh.cancel) await refresh.cancel();
          else { refresh.controller.abort(); await refresh.task; }
        } catch (error) {
          this._logError('account_refresh_cancel_failed', 'begin', error);
          return { started: false, reasons: ['تعذر إنهاء فحص الحسابات بأمان'] };
        }
      }
      if (isCancelled()) return { started: false, cancelled: true };
      const before = await this.bot.store.load();
      const dbLoadedAt = Date.now();
      const expectedOccurrence = source === 'scheduled' ? occurrence || scheduleOccurrence(before.settings, this.clock()) : null;
      if (source === 'scheduled' && expectedOccurrence && (!matchesScheduleOccurrence(before.settings, expectedOccurrence) || before.uiScheduleDay === expectedOccurrence.day)) {
        return { started: false };
      }
      // A durable completion report is an outstanding delivery obligation for every
      // start path. Never clear it as a side effect of admitting a new cycle.
      if (before.telegramUi?.pendingReport) return { started: false, reasons: ['يوجد تقرير سابق معلّق للتسليم'] };
      if (source === 'scheduled' && !expectedOccurrence) return { started: false };
      if (isCancelled()) return { started: false, cancelled: true };
      if (!this.normalizedDashboardReader && initialPrepGen == null) {
        this.trackNavigationDelivery(
          this.refreshPanels(true).catch(err => this._logWarn('panel_refresh_failed', 'begin.preparing', err))
        );
      }
      const ready = await this.readiness(before, { signal });
      if (isCancelled()) return { started: false, cancelled: true };
      const accountRevisions = new Map((before.accounts || []).map(account => [account.id,
        JSON.stringify(['cookieFile', 'enabled', 'needsOwnerCaptcha', 'checkGeneration'].map(key => account[key]))]));
      logStructured(this.bot?.logger, {
        level: 'info', component: 'telegram_ui', event: 'cycle_start_readiness_checked',
        operation: 'begin.readiness', result: ready.reasons.length ? 'blocked' : 'eligible',
        durationMs: Date.now() - dbLoadedAt,
        details: { source, initialStoreLoadMs: dbLoadedAt - beginStartedAt,
          eligibleAccounts: ready.ids?.length || 0, reasonCount: ready.reasons.length }
      });
      if (ready.quota?.exhausted) return this.rejectQuota(ready.quota, id);
      if (ready.reasons.length) { return { started: false, reasons: ready.reasons }; }

      const runId = token();
      let started = false; let snapshot; let snapshotCycle; let blockedQuota; let committedPanels;
      const persistenceStartedAt = Date.now();

      // Step 1: Worker pool preparation outside store.update
      let preparation = null;
      const preparer = typeof this.runtimeReady?.prepareCycle === 'function'
        ? this.runtimeReady.prepareCycle
        : (typeof this.prepareCycle === 'function' ? this.prepareCycle : null);
      if (typeof preparer === 'function') {
        try {
          if (isCancelled()) throw Object.assign(new Error('START_CANCELLED'), { code: 'START_CANCELLED' });
          preparation = await preparer({ state: before, snapshot: before, accountIds: ready.ids, vpnSlots: before.vpnSlots, runId, signal });
        } catch (err) {
          if (isCancelled() || err.code === 'START_CANCELLED') {
            return { started: false, cancelled: true };
          }
          this._logError('worker_preparation_exception', 'begin', err);
          preparation = { ready: false, reasons: ['تعذر تجهيز عمال النشر: ' + (err.message || 'خطأ غير متوقع')] };
        }
        if (isCancelled()) {
          if (typeof preparation?.discard === 'function') {
            await preparation.discard('interrupted').catch(() => {});
          }
          return { started: false, cancelled: true };
        }
        if (!preparation || preparation.ready === false) {
          if (typeof preparation?.discard === 'function') {
            await preparation.discard('preparation_failed').catch(() => {});
          }
          const reasons = preparation?.reasons?.length ? preparation.reasons : ['مكونات عمال النشر غير جاهزة'];
          return { started: false, reasons };
        }
        if (preparation.receipt?.workers) {
          const preparedAccountIds = new Set(preparation.receipt.workers.map(w => w.accountId));
          const missing = ready.ids.filter(id => !preparedAccountIds.has(id));
          if (missing.length > 0) {
            if (typeof preparation.discard === 'function') {
              await preparation.discard('partial_worker_preparation_forbidden').catch(() => {});
            }
            const reasons = [`فشل تجهيز العامل للحسابات: ${missing.join('، ')}`];
            return { started: false, reasons };
          }
        }
      } else if (ready.receipt || ready.prepareCycle) {
        preparation = ready;
      }

      await this.bot.store.update(s => {
        started = false;
        snapshot = undefined;
        snapshotCycle = undefined;
        blockedQuota = undefined;
        committedPanels = undefined;
        if (this.destroyed || isCancelled() || startGeneration !== (this.startGeneration || 0)) return s;
        const prepLagMs = new Date(this.clock()).getTime() - scheduledPrepStartedMs;
        if (source === 'scheduled' && (!matchesScheduleOccurrence(s.settings, expectedOccurrence) || !Number.isFinite(prepLagMs) || prepLagMs > MAX_SCHEDULE_PREP_LAG_MS || s.uiScheduleDay === expectedOccurrence.day || s.telegramUi?.pendingReport)) return s;
      if (['running', 'stopping'].includes(s.cycle?.state) || this.job || s.linkExportLease || s.telegramUi?.pendingReport || (s.linkOutbox || []).some(entry => entry && entry.status === 'sending')) return s;
      if (id) {
        const p = this.currentPanel(id.chat, 'dashboard', s.telegramUi);
        if (!p || (expectedPanel && !this.samePanel(p, expectedPanel)) || p.token !== suppliedToken) return s;
      }
      // Settle any stale in-flight items from an interrupted prior cycle
      for (const item of [...(s.items || [])]) {
        if (item.state === 'processing' || item.state === 'dispatch_started') {
          if (isProvenPreDispatch(item)) { item.state = 'pending'; delete item.attempt; moveItemToQueueTail(s, item); }
          else { item.state = 'ambiguous'; }
        }
      }
      const settings = { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
      const accounts = (s.accounts || []).filter(a => eligible(a) && ready.ids.includes(a.id) &&
        accountRevisions.get(a.id) === JSON.stringify(['cookieFile', 'enabled', 'needsOwnerCaptcha', 'checkGeneration'].map(key => a[key])));
      // Refuse partial stale prechecks rather than silently changing the run's
      // ready set after credentials, owner choices or restrictions changed.
      if (accounts.length !== ready.ids.length) return s;

      // Step 2 (Sync CAS): Validate worker receipt, account revisions and slot bindings
      if (preparation && preparation.receipt) {
        if (preparation.ready !== true) return s;
        const receiptWorkers = preparation.receipt.workers || [];
        if (accounts.length !== receiptWorkers.length) return s;
        const accountsById = new Map(accounts.map(a => [a.id, a]));
        for (const worker of receiptWorkers) {
          const a = accountsById.get(worker.accountId);
          if (!a) return s;
          if (worker.accountRevision && worker.accountRevision !== accountRevisions.get(worker.accountId)) return s;
          if (worker.slot != null && s.vpnSlots && s.vpnSlots[worker.accountId] != null && s.vpnSlots[worker.accountId] !== worker.slot) return s;
        }
      }

      const protectedTexts = protectedTextKeys(s.items || []);
      const pending = (s.items || []).filter(x => isClaimableInState(x, s, protectedTexts) && validText(x.payload?.text));
      const items = Number.isSafeInteger(maxItems) && maxItems > 0 ? pending.slice(0, maxItems) : pending;
      if (!accounts.length || !items.length || !validSettings(settings)) return s;
      const quota = quotaAdmission(s, { accounts, items, now: this.clock() });
      if (quota.exhausted) { blockedQuota = quota; return s; }
      if (source === 'scheduled') {
        s.uiScheduleDay = expectedOccurrence.day;
      }
      s.cycle = { state: 'running', runId, startedAt: new Date(this.clock()).toISOString(), updatedAt: new Date(this.clock()).toISOString() };
      s.telegramUi ||= {}; s.telegramUi.run = {
        runId,
        source,
        startedAt: new Date(this.clock()).toISOString(),
        itemIds: items.map(x => x.id),
        accountIds: accounts.map(x => x.id),
        attemptLedger: [],
        stopAfterSuccess,
        receipt: preparation?.receipt || null
      };
      s.telegramUi.dashboards ||= {};
      s.telegramUi.activePanelsByChatId ||= {};
      // Interface tokens live with their confirmed message generation. Starting a
      // run is not a panel replacement; controlTaskGeneration fences operations.
      // Generic business snapshots have no CAS authority over typed UI owners.
      snapshot = structuredClone(s.telegramUi.run);
      snapshotCycle = structuredClone(s.cycle);
      committedPanels = structuredClone(s.telegramUi.activePanelsByChatId || {});
      started = true; return s;
    });
    logStructured(this.bot?.logger, {
      level: 'info', component: 'telegram_ui', event: 'cycle_start_state_transition',
      runId: started ? runId : null, operation: 'begin.persist',
      result: started ? 'accepted' : 'rejected',
      durationMs: Date.now() - persistenceStartedAt,
      details: { source }
    });

    // Step 3 (Post-CAS Branch):
    if (started) {
      if (typeof preparation?.commit === 'function') {
        try {
          preparation.commit(runId);
        } catch (err) {
          this._logError('preparation_commit_failed', 'begin', err);
        }
      }
      if (this.fastNavigation && committedPanels) {
        for (const [chatId, ap] of Object.entries(committedPanels)) {
          this.fastNavigation.panels[String(chatId)] = { ...ap };
          this.fastNavigation.interfacePanelsByChatId[String(chatId)] ||= {};
          this.fastNavigation.interfacePanelsByChatId[String(chatId)].dashboard = { ...ap };
          this.fastNavigation.ownerRevision = (this.fastNavigation.ownerRevision || 0) + 1;
          this.interfacePanelOwners?.set(`${chatId}:dashboard`, { ...ap });
          this.fastNavigation.panelPatches.delete(String(chatId));
          this.panelOwners?.set(String(chatId), { ...ap });
        }
      }
      if (this.fastNavigation) {
        this.fastNavigation.snapshot = {
          ...(this.fastNavigation.snapshot || {}),
          cycle: snapshotCycle || { state: 'running', runId }
        };
        if (this.fastNavigation.panelView) {
          this.fastNavigation.panelView = {
            ...this.fastNavigation.panelView,
            running: true,
            preparing: false,
            startedAt: Date.parse(snapshotCycle?.startedAt || '') || Date.now()
          };
        }
      }
      if (this.normalizedPanelSnapshot) {
        this.normalizedPanelSnapshot = {
          ...this.normalizedPanelSnapshot,
          cycle: snapshotCycle || { state: 'running', runId }
        };
      }
      if (prepGen != null && this.preparingGeneration === prepGen) {
        this.isPreparing = false;
      }
      this.resetQueueStall();
      this.evaluateDashboardPolling();
      this.attach(snapshot, preparation);
      logStructured(this.bot?.logger,{component:'telegram_ui',event:'cycle_started',
        runId,operation:'begin',result:'accepted',details:{source}});
      const panelStartedAt = Date.now();
      const panelTask=this.refreshPanels(true).catch(err => this._logWarn('panel_refresh_after_begin_failed', 'begin', err));
      this.onPanelTask?.(panelTask);
      logStructured(this.bot?.logger, {
        level: 'info', component: 'telegram_ui', event: 'cycle_start_panel_refresh_timing',
        runId, operation: 'begin.refreshPanels', result: 'enqueued',
        durationMs: Date.now() - panelStartedAt,
        details: { source }
      });
      return { started: true, runId };
    } else {
      if (typeof preparation?.discard === 'function') {
        try {
          await preparation.discard(isCancelled() ? 'cancelled' : 'cas_failed');
        } catch (err) {
          this._logError('preparation_discard_failed', 'begin', err);
        }
      }
      await this._finishAbortedPreparing(prepGen, { deferNavigation: Boolean(expectedPanel?.deferNavigation || initialPrepGen != null) });
      if (blockedQuota) return this.rejectQuota(blockedQuota, id);
      return { started: false, cancelled: isCancelled(), reasons: isCancelled() ? ['تم إلغاء الدورة'] : ['الدورة جارية أو الزر قديم أو تغيرت البيانات'] };
    }
  } finally {
    activeFlight.settled = true;
    this.pendingStartAbortControllers?.delete(abortController);
    if (this.pendingStartAbortController === abortController) {
      this.pendingStartAbortController = null;
    }
    if (this.activeStartFlight === activeFlight) {
      this.activeStartFlight = null;
    }
    if (prepGen != null && this.preparingGeneration === prepGen && this.isPreparing) {
      await this._finishAbortedPreparing(prepGen, { deferNavigation: Boolean(expectedPanel?.deferNavigation || initialPrepGen != null) });
    }
  }
  };
  activeFlight.promise = runBegin();
  if (activeFlight.settled && this.activeStartFlight === activeFlight) this.activeStartFlight = null;
  return activeFlight.promise;
}
  attach(snapshot, preparation = null) {
    if (this.job) return false;
    const runId = snapshot.runId;
    this.activeRun = snapshot;
    const task = Promise.resolve().then(() => this.launch(snapshot, { preparation })).then(async () => {
      await this.bot.store.update(s => {
        s.telegramUi ||= {};
        snapshot.endedAt ||= s.telegramUi.pendingReport?.runId === runId ? s.telegramUi.pendingReport.endedAt : new Date(this.clock()).toISOString();
        s.telegramUi.pendingReport = structuredClone(snapshot);
        if (s.cycle?.runId === runId) s.cycle = { ...s.cycle, state: 'stopped', runId: null, reason: s.cycle.state === 'stopping' ? 'تم إيقاف الدورة' : s.cycle.reason || 'انتهت الدورة' };
        return s;
      });
    }, async () => {
      await this.bot.store.update(s => {
        s.telegramUi ||= {};
        snapshot.endedAt ||= s.telegramUi.pendingReport?.runId === runId ? s.telegramUi.pendingReport.endedAt : new Date(this.clock()).toISOString();
        s.telegramUi.pendingReport = structuredClone(snapshot);
        if (s.cycle?.runId === runId) s.cycle = { ...s.cycle, state: 'error', runId: null, reason: 'تعذر إكمال الدورة' };
        return s;
      });
    }).finally(async () => {
      if (this.onCycleFinished) await this.onCycleFinished(snapshot).catch(err => this._logError('cycle_finished_callback_failed', 'attach', err, { runId: snapshot?.runId }));
      if (this.job === task) {
        this.job = null;
        this.activeRun = null;
      }
      if (this.fastNavigation?.snapshot?.cycle?.runId === runId && this.fastNavigation.snapshot.cycle.state !== 'stopped') {
        this.fastNavigation.snapshot = {
          ...this.fastNavigation.snapshot,
          cycle: { ...this.fastNavigation.snapshot.cycle, state: 'stopped', runId: null }
        };
      }
      if (this.normalizedDashboardReader && !this.destroyed) {
        await this.readFreshDashboard().catch(() => {});
      }
      this.evaluateDashboardPolling();
      await this.refreshPanels(true).catch(err => this._logWarn('panel_refresh_after_cycle_failed', 'attach', err, { runId: snapshot?.runId }));
    });
    this.job = task; return true;
  }
  async resume(snapshot) {
    const state = await this.bot.store.load();
    if (!snapshot?.runId || state.cycle?.state !== 'running' || state.cycle.runId !== snapshot.runId || state.telegramUi?.run?.runId !== snapshot.runId || (state.items || []).some(x => ['processing', 'dispatch_started'].includes(x.state))) return { started: false };
    this.startNormalizedDashboardLoop();
    const started = this.attach(structuredClone(state.telegramUi.run));
    return { started, runId: snapshot.runId };
  }
  async startScheduled(occurrence) { return this.begin('scheduled', undefined, undefined, { occurrence }); }
  cancelPendingStarts() {
    this.startGeneration = (this.startGeneration || 0) + 1;
    this.controlTaskGeneration = (this.controlTaskGeneration || 0) + 1;
    this.stopGeneration = (this.stopGeneration || 0) + 1;
    this.preparingGeneration = (this.preparingGeneration || 0) + 1;
    this.isPreparing = false;
    this.activeStartFlight = null;
    if (this.pendingStartAbortControllers?.size) {
      for (const ctrl of this.pendingStartAbortControllers) {
        this.wasPendingStartAborted = true;
        try { ctrl.abort(); } catch {}
      }
      this.pendingStartAbortControllers.clear();
    }
    if (this.pendingStartAbortController) {
      this.wasPendingStartAborted = true;
      try { this.pendingStartAbortController.abort(); } catch {}
      this.pendingStartAbortController = null;
    }
    if (this.workerPool && typeof this.workerPool.fenceAdmission === 'function') {
      try { this.workerPool.fenceAdmission(); } catch {}
    }
    this.evaluateDashboardPolling();
  }
  accountCallback(namespace, action, accountId, owner) {
    const index = accountId === 'all' ? 'all' : (owner?.accountIds || []).indexOf(accountId);
    return `${namespace}:${action}:${owner?.generation || 'unbound'}:${index}`;
  }
  async openAccountsView(id, view, accounts, render) {
    return this.publishPanel(id, 'accounts', generation => ({ ...render(generation), view, accountIds: accounts.map(a => a.id) }));
  }
  async callbackPanel(id, request, raw, kind) {
    const observed = this.currentPanel(id.chat, kind);
    const root = this.bot.store.section ? await this.bot.store.section('telegramUi') : (await this.bot.store.load()).telegramUi;
    const nowCurrent = this.currentPanel(id.chat, kind);
    const current = this.currentPanel(id.chat, kind, root);
    const sameOwner = (a, b) => this.samePanel(a, b) && (a?.token ?? null) === (b?.token ?? null);
    if (observed && (!sameOwner(nowCurrent, observed) || !sameOwner(nowCurrent, current))) return null;
    if (!observed && nowCurrent && !sameOwner(nowCurrent, current)) return null;
    if (current && !nowCurrent && !this.fastNavigation) {
      this.interfacePanelOwners ||= new Map();
      this.interfacePanelOwners.set(`${id.chat}:${kind}`, current);
    }
    const messageId = raw.callback_query?.message?.message_id;
    if (!current || current.retired || current.messageId !== messageId || !this.ownsPanel(id.chat, current)) return null;
    if (kind === 'dashboard') {
      if (typeof request.parsed?.value !== 'string' || !request.parsed.value) return null;
      if (current.token !== request.parsed.value && !(request.parsed?.action === 'stop' && current.stopToken === request.parsed.value)) return null;
    } else {
      const [generation, index, ...extra] = String(request.parsed?.value || '').split(':');
      if (extra.length || generation !== current.generation) return null;
      const value = index === 'all' ? 'all' : /^(0|[1-9][0-9]*)$/.test(index || '') ? current.accountIds?.[Number(index)] : null;
      if (value == null) return null;
      request.parsed = { ...request.parsed, value };
    }
    return { ...current };
  }
  async stalePanel(request, raw, label = 'الحسابات') {
    const text = `هذا الزر قديم. افتح ${label} لعرض التحكم الحالي.`;
    let id = null;
    try { id = this.identity(raw); } catch {}
    await this._acknowledgeWithNotice(id, request, raw, text, true);
    return { stale: true };
  }
  editOwnedPanel(id, owner, text, extra = {}) {
    return require('./telegram').navigationContext.run(null, () => this.bot.transport.editMessageText(id.chat, owner.messageId, text, { ...extra, _isCurrent: () => this.canEditPanel(id.chat, owner) }));
  }
  async accountControl(_, raw) {
    // Old unscoped inventory callbacks cannot navigate or mutate accounts.
    return this.unknownCallback(null, raw);
  }

  accountToggleKeyboard(accounts = [], owner) {
    const inline_keyboard = [];
    for (let i = 0; i < accounts.length; i += 2) {
      const pair = accounts.slice(i, i + 2);
      const row = pair.map(a => {
        const isBanned = isBannedStatus(a.status);
        const isCaptcha = isCaptchaStatus(a.status) || Boolean(a.needsOwnerCaptcha);
        const isEnabled = a.enabled !== false && !isBanned && !isCaptcha && !isAccountInactive(a.status);
        const name = a.username ? `@${clean(a.username)}` : a.label || a.id;
        const text = name;
        const style = isBanned ? 'danger' : isEnabled ? 'success' : 'primary';
        return {
          text,
          callback_data: this.accountCallback('acctoggle', 'toggle', a.id, owner),
          ...(this.inlineStyles ? { style } : {})
        };
      });
      inline_keyboard.push(row);
    }
    inline_keyboard.push([
      {
        text: 'إلغاء تفعيل كل الحسابات',
        callback_data: this.accountCallback('acctoggle', 'all_disable', 'all', owner),
        ...(this.inlineStyles ? { style: 'danger' } : {})
      }
    ]);
    return { inline_keyboard };
  }

  async accountToggleMenu(_, raw) {
    const id = this.identity(raw);
    await this._clearPromptState(id);
    const accounts = this.bot.store.section ? await this.bot.store.section('accounts') : (await this.bot.store.load()).accounts || [];
    const text = 'اختر الحسابات التي تريد تفعيلها (الحد الأقصى 5):';
    return this.openAccountsView(id, 'toggle', accounts, generation => ({ text, extra: { reply_markup: this.accountToggleKeyboard(accounts, { generation, accountIds: accounts.map(a => a.id) }) } }));
  }

  async accountToggle(request = {}, raw = request) {
    let id;
    try {
      id = this.identity(raw || request);
    } catch {
      const fallbackChat = raw?.message?.chat?.id ?? raw?.chat?.id ?? request?.chatId ?? request?.chat ?? 0;
      const fallbackUser = raw?.message?.from?.id ?? raw?.from?.id ?? request?.userId ?? request?.user ?? fallbackChat;
      id = { chat: fallbackChat, user: fallbackUser, key: `${fallbackChat}:${fallbackUser}` };
    }
    const owner = raw?.callback_query ? await this.callbackPanel(id, request, raw, 'accounts') : null;
    if (raw?.callback_query && !owner) return this.stalePanel(request, raw);
    const owns = state => !owner || (this.ownsPanel(id.chat, owner) && (!state || this.samePanel(this.currentPanel(id.chat, 'accounts', state.telegramUi), owner)));
    let parsed = request?.parsed ? { ...request.parsed } : {};
    let explicitMode = null;

    if (!parsed.action) {
      let args = [];
      if (Array.isArray(request?.command?.args)) {
        args = request.command.args;
      } else if (Array.isArray(request?.args)) {
        args = request.args;
      } else if (Array.isArray(raw?.args)) {
        args = raw.args;
      } else {
        const rawText = String(request?.text ?? raw?.message?.text ?? raw?.text ?? '').trim();
        if (rawText) {
          const tokens = rawText.split(/\s+/).filter(Boolean);
          if (tokens[0] && tokens[0].startsWith('/account_toggle')) tokens.shift();
          args = tokens;
        }
      }
      const targetArg = args[0] ? String(args[0]).trim() : '';
      const modeArg = args[1] ? String(args[1]).trim().toLowerCase() : null;
      if (targetArg === 'all_disable' || (targetArg === 'all' && modeArg === 'off')) {
        parsed = { action: 'all_disable', value: 'all' };
      } else if (targetArg) {
        parsed = { action: 'toggle', value: targetArg };
        if (modeArg && ['on', 'off', 'enable', 'disable'].includes(modeArg)) {
          explicitMode = ['on', 'enable'].includes(modeArg) ? 'enable' : 'disable';
        } else if (modeArg) {
          if (this.bot?.transport?.sendMessage && id.chat) {
            await this.bot.transport.sendMessage(id.chat, 'استخدم /account_toggle account-id on أو off.');
          }
          return { invalidArgs: true };
        }
      } else if (request?.source === 'message' || request?.command || request?.text || raw?.message?.text) {
        if (this.bot?.transport?.sendMessage && id.chat) {
          await this.bot.transport.sendMessage(id.chat, 'استخدم /account_toggle account-id on أو off.');
        }
        return { invalidArgs: true };
      }
    }

    const callbackId = raw?.callback_query?.id;
    const messageId = raw?.callback_query?.message?.message_id;
    const isCommandInvocation = !callbackId && !messageId && Boolean(request?.command || request?.args || request?.text || raw?.message?.text);
    const acknowledge = async (text, alert = false) => {
      if (!request?.acknowledge && !callbackId && isCommandInvocation && text && this.bot?.transport?.sendMessage && id.chat) {
        return this.bot.transport.sendMessage(id.chat, text);
      }
      return this._acknowledgeWithNotice(id, request, raw, text, alert);
    };
    const vpnMgr = this.vpnManager || this.bot?.vpnManager;
    const updateOwned = mutator => this.bot.store.update(s => owns(s) ? mutator(s) : s);
    const mappingUpdate = mutator => typeof vpnMgr?.withMappingMutation === 'function'
      ? vpnMgr.withMappingMutation(s => owns(s) ? mutator(s) : s)
      : updateOwned(mutator);

    if (parsed.action === 'all_disable' || parsed.action === 'disable_all') {
      let releaseIds = [];
      const drain = this.drainWorkers || this.bot?.drainWorkers;
      if (typeof drain === 'function') {
        const accountsToDrain = (this.bot.store.section ? await this.bot.store.section('accounts') : (await this.bot.store.load()).accounts || []).map(a => a.id);
        if (!owns()) return { stale: true };
        await drain(accountsToDrain).catch(err => this._logError('drain_workers_failed', 'accountToggle.all_disable', err));
      }
      await mappingUpdate(s => {
        releaseIds = [];
        for (const a of s.accounts || []) {
          a.enabled = false;
          if (a.needsOwnerCaptcha || isCaptchaStatus(a.status)) {
            if (!isCaptchaStatus(a.status)) {
              a.status = 'كابتشا (مطلوب حل يدوي)';
            }
          } else if (isBannedStatus(a.status)) {
            a.status = 'محظور';
          } else if (isUnverifiedStatus(a.status)) {
            // Keep the session-verification restriction visible while disabling.
            a.enabled = false;
          } else {
            a.status = 'غير مفعل';
          }
          releaseIds.push(a.id);
        }
        if (s.cycle?.state === 'running' && s.telegramUi?.run && Array.isArray(s.telegramUi.run.accountIds)) {
          s.telegramUi.run.accountIds = [];
          s.telegramUi.run.cursor = 0;
        }
        if (s.vpnSlots) {
          s.vpnSlots = {};
        }
        return s;
      });
      if (!owns()) return { stale: true };
      if (this.activeRun && Array.isArray(this.activeRun.accountIds)) {
        this.activeRun.accountIds.length = 0;
        this.activeRun.cursor = 0;
      }
      if (typeof vpnMgr?.release === 'function') {
        const releasePromises = releaseIds.map(accId => {
          const p = Promise.resolve(vpnMgr.release(accId));
          trackVpnRelease(this.bot?.store, accId, p);
          return p.catch(err => this._logError('vpn_release_failed', 'accountToggle.all_disable', err));
        });
        await Promise.allSettled(releasePromises);
      }
      Promise.resolve(this.bot?.forensicLogger?.record({
        eventType: 'manual_toggle',
        details: { action: 'all_disable' }
      })).catch(err => this._logError('forensic_record_failed', 'accountToggle.all_disable', err));
      const updatedAccounts = this.bot.store.section ? await this.bot.store.section('accounts') : (await this.bot.store.load()).accounts || [];
      const markup = this.accountToggleKeyboard(updatedAccounts, owner);
      this.refreshPanels(true).catch(() => {});
      const ackPromise = acknowledge('تم إلغاء تفعيل جميع الحسابات', true);
      const editPromise = messageId
        ? this.editOwnedPanel(id, owner, 'اختر الحسابات التي تريد تفعيلها (الحد الأقصى 5):', { reply_markup: markup }).catch(err => this._logWarn('telegram_ui_edit_message_suppressed', 'accountToggle.all_disable', err))
        : Promise.resolve();
      await Promise.all([ackPromise, editPromise]);
      return { allDisabled: true };
    }

    if (parsed.action === 'toggle' && parsed.value) {
      const targetId = parsed.value;
      const accounts = this.bot.store.section ? await this.bot.store.section('accounts') : (await this.bot.store.load()).accounts || [];
      const account = accounts.find(a => a.id === targetId);
      if (!account) {
        await acknowledge('الحساب غير موجود', true);
        return { notFound: true };
      }

      const isCurrentlyActive = account.enabled !== false && !isAccountInactive(account.status) && !account.needsOwnerCaptcha;
      const shouldDisable = explicitMode ? explicitMode === 'disable' : isCurrentlyActive;

      if (shouldDisable) {
        const drain = this.drainWorkers || this.bot?.drainWorkers;
        if (typeof drain === 'function') {
          if (!owns()) return { stale: true };
        await drain([targetId]).catch(err => this._logError('drain_workers_failed', 'accountToggle.disable', err));
        }
        await mappingUpdate(s => {
          const a = (s.accounts || []).find(acc => acc.id === targetId);
          if (a) {
            a.enabled = false;
            if (a.needsOwnerCaptcha || isCaptchaStatus(a.status)) {
              if (!isCaptchaStatus(a.status)) {
                a.status = 'كابتشا (مطلوب حل يدوي)';
              }
            } else if (isBannedStatus(a.status)) {
              a.status = 'محظور';
            } else if (isUnverifiedStatus(a.status)) {
              // Keep the session-verification restriction visible while disabling.
              a.enabled = false;
            } else {
              a.status = 'غير مفعل';
            }
          }
          if (s.cycle?.state === 'running' && s.telegramUi?.run && Array.isArray(s.telegramUi.run.accountIds)) {
            s.telegramUi.run.accountIds = s.telegramUi.run.accountIds.filter(id => id !== targetId);
            if (s.telegramUi.run.accountIds.length === 0 || (typeof s.telegramUi.run.cursor === 'number' && s.telegramUi.run.cursor >= s.telegramUi.run.accountIds.length)) {
              s.telegramUi.run.cursor = 0;
            }
          }
          if (s.vpnSlots && Object.hasOwn(s.vpnSlots, targetId)) {
            delete s.vpnSlots[targetId];
          }
          return s;
        });
        if (!owns()) return { stale: true };
        if (this.activeRun && Array.isArray(this.activeRun.accountIds)) {
          const idx = this.activeRun.accountIds.indexOf(targetId);
          if (idx !== -1) this.activeRun.accountIds.splice(idx, 1);
          if (typeof this.activeRun.cursor === 'number' && this.activeRun.cursor >= this.activeRun.accountIds.length) {
            this.activeRun.cursor = 0;
          }
        }
        if (typeof vpnMgr?.release === 'function') {
          const p = Promise.resolve(vpnMgr.release(targetId));
          trackVpnRelease(this.bot?.store, targetId, p);
          await p.catch(err =>
            this._logError('vpn_release_failed', 'accountToggle.disable', err, { accountId: targetId })
          );
        }
        Promise.resolve(this.bot?.forensicLogger?.record({
          eventType: 'manual_toggle',
          accountId: targetId,
          username: account.username,
          details: { action: 'disable' }
        })).catch(err => this._logError('forensic_record_failed', 'accountToggle.disable', err, { accountId: targetId }));
        const updatedAccounts = this.bot.store.section ? await this.bot.store.section('accounts') : (await this.bot.store.load()).accounts || [];
        const markup = this.accountToggleKeyboard(Array.isArray(updatedAccounts) ? updatedAccounts : [], owner);
        this.refreshPanels(true).catch(() => {});
        const msg = isCommandInvocation ? 'تم تعطيل الحساب.' : `تم تعطيل الحساب @${account.username || account.label}`;
        const ackPromise = acknowledge(msg);
        const editPromise = messageId
          ? this.editOwnedPanel(id, owner, 'اختر الحسابات التي تريد تفعيلها (الحد الأقصى 5):', { reply_markup: markup }).catch(err => this._logWarn('telegram_ui_edit_message_suppressed', 'accountToggle.disable', err))
          : Promise.resolve();
        await Promise.all([ackPromise, editPromise]);
        return { toggled: false };
      } else {
        await awaitVpnRelease(this.bot?.store, targetId);
        if (!owns()) return { stale: true };
          const activation = await this._preflightActivation(targetId);
        if (!activation.allowed) {
          const text = activation.reason === 'banned' ? 'هذا الحساب محظور، لا يمكن تفعيله.'
            : activation.reason === 'captcha' || activation.reason === 'account_restricted' ? 'هذا الحساب يتطلب تدخلاً بشرياً؛ لا يمكن تفعيله.'
            : 'لا توجد نتيجة تحقق حديثة وموثوقة؛ لم يُفعّل الحساب.';
          await acknowledge(text, true);
          return { toggled: false, denied: activation.reason };
        }
        let outcome = {
          toggled: false,
          notFound: false,
          banned: false,
          captcha: false,
          unverified: false,
          limitExceeded: false
        };
        await mappingUpdate(s => {
          outcome = {
            toggled: false,
            notFound: false,
            banned: false,
            captcha: false,
            unverified: false,
            limitExceeded: false
          };
          const target = (s.accounts || []).find(acc => acc.id === targetId);
          if (!target) {
            outcome.notFound = true;
            return s;
          }
          const activation = applyOwnerEnabled(s, targetId, true);
          if (!activation.applied) {
            if (activation.reason === 'active_account_limit') outcome.limitExceeded = true;
            else if (activation.reason === 'banned') outcome.banned = true;
            else if (activation.reason === 'captcha') outcome.captcha = true;
            else if (activation.reason === 'session_missing') outcome.unverified = true;
            else outcome.unverified = true;
            return s;
          }
          target.failures = 0;
          if (s.posting?.cooling?.[targetId]) {
            delete s.posting.cooling[targetId];
          }
          if (s.cycle?.state === 'running' && s.telegramUi?.run && Array.isArray(s.telegramUi.run.accountIds)) {
            if (!s.telegramUi.run.accountIds.includes(targetId)) {
              s.telegramUi.run.accountIds.push(targetId);
            }
          }
          s.vpnSlots ||= {};
          const otherActiveIds = new Set(
            (s.accounts || []).filter(a => a.id !== targetId && a.enabled !== false && !isAccountInactive(a.status)).map(a => a.id)
          );
          delete s.vpnSlots[targetId];
          for (const mappedId of Object.keys(s.vpnSlots)) {
            if (!otherActiveIds.has(mappedId)) {
              delete s.vpnSlots[mappedId];
            }
          }
          const usedSlots = new Set(Object.values(s.vpnSlots));
          const freeSlot = [0, 1, 2, 3, 4].find(slot => !usedSlots.has(slot));
          if (freeSlot != null) {
            s.vpnSlots[targetId] = freeSlot;
          }
          outcome.toggled = true;
          return s;
        });

        if (outcome.notFound) {
          await acknowledge('الحساب غير موجود', true);
          return { notFound: true };
        }
        if (outcome.banned) {
          await acknowledge('هذا الحساب محظور، لا يمكن تفعيله.', true);
          return { banned: true };
        }
        if (outcome.captcha) {
          await acknowledge('هذا الحساب يتطلب حل التحدي الأمني (كابتشا) يدوياً عبر موقع X أولاً، ثم الضغط على "تم الحل" للتحقق.', true);
          return { captcha: true };
        }
        if (outcome.unverified) {
          await acknowledge('جلسة هذا الحساب غير مؤكدة؛ يرجى فحص الحساب عبر موقع X وتحديث الكوكيز قبل التفعيل.', true);
          return { unverified: true };
        }
        if (outcome.limitExceeded) {
          await acknowledge('تجاوزت الحد للحسابات المفعلة (الحد الأقصى 5)', true);
          return { limitExceeded: true };
        }

        if (this.activeRun && Array.isArray(this.activeRun.accountIds)) {
          if (!this.activeRun.accountIds.includes(targetId)) {
            this.activeRun.accountIds.push(targetId);
          }
        }
        Promise.resolve(this.bot?.forensicLogger?.record({
          eventType: 'manual_toggle',
          accountId: targetId,
          username: account.username,
          details: { action: 'enable' }
        })).catch(err => this._logError('forensic_record_failed', 'accountToggle.enable', err, { accountId: targetId }));
        const updatedAccounts = this.bot.store.section ? await this.bot.store.section('accounts') : (await this.bot.store.load()).accounts || [];
        const markup = this.accountToggleKeyboard(Array.isArray(updatedAccounts) ? updatedAccounts : [], owner);
        this.refreshPanels(true).catch(() => {});
        const msg = isCommandInvocation ? 'تم تفعيل الحساب.' : `تم تفعيل الحساب @${account.username || account.label}`;
        const ackPromise = acknowledge(msg);
        const editPromise = messageId
          ? this.editOwnedPanel(id, owner, 'اختر الحسابات التي تريد تفعيلها (الحد الأقصى 5):', { reply_markup: markup }).catch(err => this._logWarn('telegram_ui_edit_message_suppressed', 'accountToggle.enable', err))
          : Promise.resolve();
        await Promise.all([ackPromise, editPromise]);
        return { toggled: true };
      }
    }

    await acknowledge();
    return {};
  }

  accountBrowseKeyboard(accounts = [], owner) {
    const inline_keyboard = [];
    for (let i = 0; i < accounts.length; i += 2) {
      const pair = accounts.slice(i, i + 2);
      const row = pair.map(a => {
        const name = a.username ? `@${clean(a.username)}` : a.label || a.id;
        const isBanned = isBannedStatus(a.status);
        const isCaptcha = isCaptchaStatus(a.status) || Boolean(a.needsOwnerCaptcha);
        const isEnabled = a.enabled !== false && !isBanned && !isCaptcha && !isAccountInactive(a.status);
        const style = isBanned ? 'danger' : isEnabled ? 'success' : 'primary';
        return {
          text: name,
          callback_data: this.accountCallback('accmanage', 'select', a.id, owner),
          ...(this.inlineStyles ? { style } : {})
        };
      });
      inline_keyboard.push(row);
    }
    return { inline_keyboard };
  }

  async accountsBrowse(_, raw) {
    const id = this.identity(raw);
    await this._clearPromptState(id);
    const accounts = this.bot.store.section ? await this.bot.store.section('accounts') : (await this.bot.store.load()).accounts || [];
    const text = accounts.length ? 'اختر الحساب لعرض إعداداته:' : 'لا توجد حسابات مسجلة في النظام حتى الآن. أرسل ملف Cookies بصيغة TXT/JSON لإضافة الحساب بعد التأكيد.';
    return this.openAccountsView(id, 'browse', accounts, generation => ({ text, extra: { reply_markup: this.accountBrowseKeyboard(accounts, { generation, accountIds: accounts.map(a => a.id) }) } }));
  }

  accountDetailText(account) {
    const isBanned = isBannedStatus(account.status);
    const isCaptcha = isCaptchaStatus(account.status) || Boolean(account.needsOwnerCaptcha);
    const isEnabled = account.enabled !== false && !isBanned && !isCaptcha && !isAccountInactive(account.status);
    const statusLabel = isBanned
      ? `🚫 ${escapeHtml(account.status)}`
      : isCaptcha
      ? `🟠 محجوب بـ CAPTCHA (⚠️ كابتشا)`
      : isEnabled
      ? '🟢 مفعل'
      : '🔴 غير مفعل';
    const rawName = account.username ? `@${clean(account.username)}` : account.label || account.id;
    const name = escapeHtml(rawName);
    const safeLabel = escapeHtml(account.label || rawName);
    return `⚙️ <b>لوحة إعدادات وخيارات الحساب:</b> ${name}\n\n` +
      `• <b>الحالة:</b> ${statusLabel}\n` +
      `• <b>اسم الحساب:</b> ${safeLabel}\n` +
      `• <b>المعرف الرقمي:</b> ${escapeHtml(account.userId || 'غير متوفر')}\n` +
      `• <b>عنوان IP الخروج:</b> ${escapeHtml(account.exitIp || 'غير متوفر')}\n` +
      `• <b>الكوتا اليومية:</b> ${account.quota ? `${escapeHtml(account.quota)} منشور` : 'افتراضي (حسب النظام)'}\n\n` +
      `اختر الإجراء المطلوب تنفيذه:`;
  }

  accountDetailKeyboard(account, owner) {
    const isBanned = isBannedStatus(account.status);
    const isCaptcha = isCaptchaStatus(account.status) || Boolean(account.needsOwnerCaptcha);
    const isEnabled = account.enabled !== false && !isBanned && !isCaptcha && !isUnverifiedStatus(account.status) && !isAccountInactive(account.status);

    const toggleButton = isEnabled
      ? { text: 'تعطيل', callback_data: this.accountCallback('accmanage', 'disable', account.id, owner), ...(this.inlineStyles ? { style: 'danger' } : {}) }
      : { text: 'تفعيل', callback_data: this.accountCallback('accmanage', 'enable', account.id, owner), ...(this.inlineStyles ? { style: 'success' } : {}) };

    const firstRow = isCaptcha
      ? [
          { text: '✅ تم الحل (فحص الاعتماد)', callback_data: this.accountCallback('accmanage', 'verify_captcha', account.id, owner), ...(this.inlineStyles ? { style: 'success' } : {}) },
          { text: 'حذف الحساب', callback_data: this.accountCallback('accmanage', 'delete_prompt', account.id, owner), ...(this.inlineStyles ? { style: 'danger' } : {}) }
        ]
      : [
          toggleButton,
          { text: 'حذف الحساب', callback_data: this.accountCallback('accmanage', 'delete_prompt', account.id, owner), ...(this.inlineStyles ? { style: 'danger' } : {}) }
        ];

    const inline_keyboard = [
      firstRow,
      [
        { text: 'فحص جلسة X', callback_data: this.accountCallback('accmanage', 'check_session', account.id, owner), ...(this.inlineStyles ? { style: 'primary' } : {}) },
        { text: 'فحص VPN وIP', callback_data: this.accountCallback('accmanage', 'check_vpn', account.id, owner), ...(this.inlineStyles ? { style: 'primary' } : {}) }
      ],
      [
        { text: 'رجوع', callback_data: this.accountCallback('accmanage', 'list', 'all', owner), ...(this.inlineStyles ? { style: 'primary' } : {}) }
      ]
    ];
    return { inline_keyboard };
  }

  async accountManage(request, raw) {
    const id = this.identity(raw);
    const owner = await this.callbackPanel(id, request, raw, 'accounts');
    if (!owner) return this.stalePanel(request, raw);
    const owns = state => this.ownsPanel(id.chat, owner) && (!state || this.samePanel(this.currentPanel(id.chat, 'accounts', state.telegramUi), owner));
    const parsed = request.parsed || {};
    const callbackId = raw.callback_query?.id;
    const messageId = raw.callback_query?.message?.message_id;
    const acknowledge = (text, alert = false) => this._acknowledgeWithNotice(id, request, raw, text, alert);
    const vpnMgr = this.vpnManager || this.bot?.vpnManager;
    const updateOwned = mutator => this.bot.store.update(s => owns(s) ? mutator(s) : s);
    const mappingUpdate = mutator => typeof vpnMgr?.withMappingMutation === 'function'
      ? vpnMgr.withMappingMutation(s => owns(s) ? mutator(s) : s)
      : updateOwned(mutator);
    const sendCheckResult = text => !owns() || this.destroyed ? Promise.resolve() : this.bot.transport.sendMessage(id.chat, text,{_background:true}).catch(err => {
      this._logWarn('account_check_result_delivery_failed', 'accountManage', err, { accountId: parsed.value });
    });
    if (parsed.action === 'list') {
      const accounts = this.bot.store.section ? await this.bot.store.section('accounts') : (await this.bot.store.load()).accounts || [];
      const text = accounts.length ? 'اختر الحساب لعرض إعداداته:' : 'لا توجد حسابات مسجلة في النظام.';
      const markup = this.accountBrowseKeyboard(accounts, owner);
      const ackPromise = acknowledge();
      const editPromise = messageId
        ? this.editOwnedPanel(id, owner, text, { reply_markup: markup }).catch(err => this._logWarn('telegram_ui_edit_message_suppressed', 'accountManage.list', err))
        : Promise.resolve();
      await Promise.all([ackPromise, editPromise]);
      return { view: 'list' };
    }

    if (parsed.action === 'select' && parsed.value) {
      const targetId = parsed.value;
      const accounts = this.bot.store.section ? await this.bot.store.section('accounts') : (await this.bot.store.load()).accounts || [];
      const account = accounts.find(a => a.id === targetId);
      if (!account) {
        await acknowledge('الحساب غير موجود', true);
        return { notFound: true };
      }
      const text = this.accountDetailText(account);
      const markup = this.accountDetailKeyboard(account, owner);
      const ackPromise = acknowledge();
      const editPromise = messageId
        ? this.editOwnedPanel(id, owner, text, { parse_mode: 'HTML', reply_markup: markup }).catch(err => this._logWarn('telegram_ui_edit_message_suppressed', 'accountManage.select', err))
        : Promise.resolve();
      await Promise.all([ackPromise, editPromise]);
      return { view: 'detail', accountId: targetId };
    }

    if (parsed.action === 'enable' && parsed.value) {
      const targetId = parsed.value;
      if (!owns()) return { stale: true };
          const activation = await this._preflightActivation(targetId);
      if (!activation.allowed) {
        const text = activation.reason === 'banned' ? 'هذا الحساب محظور، لا يمكن تفعيله.'
          : activation.reason === 'captcha' || activation.reason === 'account_restricted' ? 'هذا الحساب يتطلب تدخلاً بشرياً؛ لا يمكن تفعيله.'
          : 'لا توجد نتيجة تحقق حديثة وموثوقة؛ لم يُفعّل الحساب.';
        await acknowledge(text, true);
        return { enabled: false, denied: activation.reason };
      }
      await awaitVpnRelease(this.bot?.store, targetId);
      const accounts = this.bot.store.section ? await this.bot.store.section('accounts') : (await this.bot.store.load()).accounts || [];
      const account = (accounts || []).find(a => a.id === targetId);
      if (!account) {
        await acknowledge('الحساب غير موجود', true);
        return { notFound: true };
      }

      let outcome = {
        enabled: false,
        notFound: false,
        banned: false,
        captcha: false,
        unverified: false,
        limitExceeded: false
      };
      await mappingUpdate(s => {
        outcome = {
          enabled: false,
          notFound: false,
          banned: false,
          captcha: false,
          unverified: false,
          limitExceeded: false
        };
        const target = (s.accounts || []).find(acc => acc.id === targetId);
        if (!target) {
          outcome.notFound = true;
          return s;
        }
        const activation = applyOwnerEnabled(s, targetId, true);
        if (!activation.applied) {
          if (activation.reason === 'active_account_limit') outcome.limitExceeded = true;
          else if (activation.reason === 'banned') outcome.banned = true;
          else if (activation.reason === 'captcha') outcome.captcha = true;
          else if (activation.reason === 'session_missing') outcome.unverified = true;
          else outcome.unverified = true;
          return s;
        }
        target.failures = 0;
        if (s.posting?.cooling?.[targetId]) {
          delete s.posting.cooling[targetId];
        }
        if (s.cycle?.state === 'running' && s.telegramUi?.run && Array.isArray(s.telegramUi.run.accountIds)) {
          if (!s.telegramUi.run.accountIds.includes(targetId)) {
            s.telegramUi.run.accountIds.push(targetId);
          }
        }
        s.vpnSlots ||= {};
        const otherActiveIds = new Set(
          (s.accounts || []).filter(a => a.id !== targetId && a.enabled !== false && !isAccountInactive(a.status)).map(a => a.id)
        );
        delete s.vpnSlots[targetId];
        for (const mappedId of Object.keys(s.vpnSlots)) {
          if (!otherActiveIds.has(mappedId)) {
            delete s.vpnSlots[mappedId];
          }
        }
        const usedSlots = new Set(Object.values(s.vpnSlots));
        const freeSlot = [0, 1, 2, 3, 4].find(slot => !usedSlots.has(slot));
        if (freeSlot != null) {
          s.vpnSlots[targetId] = freeSlot;
        }
        outcome.enabled = true;
        return s;
      });

      if (outcome.notFound) {
        await acknowledge('الحساب غير موجود', true);
        return { notFound: true };
      }
      if (outcome.banned) {
        await acknowledge('هذا الحساب محظور، لا يمكن تفعيله.', true);
        return { banned: true };
      }
      if (outcome.captcha) {
        await acknowledge('هذا الحساب يتطلب حل التحدي الأمني (كابتشا) يدوياً عبر موقع X أولاً، ثم الضغط على "تم الحل" للتحقق.', true);
        return { captcha: true };
      }
      if (outcome.unverified) {
        await acknowledge('جلسة هذا الحساب غير مؤكدة؛ يرجى فحص الحساب عبر موقع X وتحديث الكوكيز قبل التفعيل.', true);
        return { unverified: true };
      }
      if (outcome.limitExceeded) {
        await acknowledge('تجاوزت الحد للحسابات المفعلة (الحد الأقصى 5)', true);
        return { limitExceeded: true };
      }

      if (this.activeRun && Array.isArray(this.activeRun.accountIds)) {
        if (!this.activeRun.accountIds.includes(targetId)) {
          this.activeRun.accountIds.push(targetId);
        }
      }
      Promise.resolve(this.bot?.forensicLogger?.record({
        eventType: 'manual_toggle',
        accountId: targetId,
        username: account.username,
        details: { action: 'enable' }
      })).catch(err => this._logError('forensic_record_failed', 'accountManage.enable', err, { accountId: targetId }));
      this.refreshPanels(true).catch(() => {});
      const updatedAccounts = this.bot.store.section ? await this.bot.store.section('accounts') : (await this.bot.store.load()).accounts || [];
      const updatedAcc = (updatedAccounts || []).find(a => a.id === targetId);
      const ackPromise = acknowledge(`تم تفعيل الحساب @${account.username || account.label}`);
      const editPromise = (messageId && updatedAcc)
        ? this.editOwnedPanel(id, owner, this.accountDetailText(updatedAcc), { parse_mode: 'HTML', reply_markup: this.accountDetailKeyboard(updatedAcc, owner) })
        : Promise.resolve();
      await Promise.all([ackPromise, editPromise]);
      return { enabled: true };
    }

    if (parsed.action === 'disable' && parsed.value) {
      const targetId = parsed.value;
      const accounts = this.bot.store.section ? await this.bot.store.section('accounts') : (await this.bot.store.load()).accounts || [];
      const account = (accounts || []).find(a => a.id === targetId);
      if (!account) {
        await acknowledge('الحساب غير موجود', true);
        return { notFound: true };
      }
      const drain = this.drainWorkers || this.bot?.drainWorkers;
      if (typeof drain === 'function') {
        if (!owns()) return { stale: true };
        await drain([targetId]).catch(err => this._logError('drain_workers_failed', 'accountManage.disable', err));
      }
      const vpnMgr = this.vpnManager || this.bot?.vpnManager;
      await updateOwned(s => {
        const a = (s.accounts || []).find(acc => acc.id === targetId);
        if (a) {
          a.enabled = false;
          if (a.needsOwnerCaptcha || isCaptchaStatus(a.status)) {
            if (!isCaptchaStatus(a.status)) {
              a.status = 'كابتشا (مطلوب حل يدوي)';
            }
          } else if (isBannedStatus(a.status)) {
            a.status = 'محظور';
          } else {
            a.status = 'غير مفعل';
          }
        }
        if (s.cycle?.state === 'running' && s.telegramUi?.run && Array.isArray(s.telegramUi.run.accountIds)) {
          s.telegramUi.run.accountIds = s.telegramUi.run.accountIds.filter(id => id !== targetId);
          if (s.telegramUi.run.accountIds.length === 0 || (typeof s.telegramUi.run.cursor === 'number' && s.telegramUi.run.cursor >= s.telegramUi.run.accountIds.length)) {
            s.telegramUi.run.cursor = 0;
          }
        }
        if (s.vpnSlots && Object.hasOwn(s.vpnSlots, targetId)) {
          delete s.vpnSlots[targetId];
        }
        return s;
      });
      if (this.activeRun && Array.isArray(this.activeRun.accountIds)) {
        const idx = this.activeRun.accountIds.indexOf(targetId);
        if (idx !== -1) this.activeRun.accountIds.splice(idx, 1);
        if (typeof this.activeRun.cursor === 'number' && this.activeRun.cursor >= this.activeRun.accountIds.length) {
          this.activeRun.cursor = 0;
        }
      }
      if (!owns()) return { stale: true };
      if (typeof vpnMgr?.release === 'function') {
        const p = Promise.resolve(vpnMgr.release(targetId));
        trackVpnRelease(this.bot?.store, targetId, p);
        await p.catch(err =>
          this._logError('vpn_release_failed', 'accountManage.disable', err, { accountId: targetId })
        );
      }
      Promise.resolve(this.bot?.forensicLogger?.record({
        eventType: 'manual_toggle',
        accountId: targetId,
        username: account.username,
        details: { action: 'disable' }
      })).catch(err => this._logError('forensic_record_failed', 'accountManage.disable', err, { accountId: targetId }));
      this.refreshPanels(true).catch(() => {});
      const updatedAccounts = this.bot.store.section ? await this.bot.store.section('accounts') : (await this.bot.store.load()).accounts || [];
      const updatedAcc = (updatedAccounts || []).find(a => a.id === targetId);
      const ackPromise = acknowledge(`تم تعطيل الحساب @${account.username || account.label}`);
      const editPromise = (messageId && updatedAcc)
        ? this.editOwnedPanel(id, owner, this.accountDetailText(updatedAcc), { parse_mode: 'HTML', reply_markup: this.accountDetailKeyboard(updatedAcc, owner) })
        : Promise.resolve();
      await Promise.all([ackPromise, editPromise]);
      return { disabled: true };
    }

    if (parsed.action === 'verify_captcha' && parsed.value) {
      const targetId = parsed.value;
      const accounts = this.bot.store.section ? await this.bot.store.section('accounts') : (await this.bot.store.load()).accounts || [];
      const account = (accounts || []).find(a => a.id === targetId);
      if (!account) {
        await acknowledge('الحساب غير موجود', true);
        return { notFound: true };
      }

      // Atomic Rate limiting CAS within store.update: strictly at least 30 seconds between attempts
      let rateLimited = false;
      let remainingSec = 0;
      await updateOwned(s => {
        rateLimited = false;
        remainingSec = 0;
        const a = (s.accounts || []).find(acc => acc.id === targetId);
        if (!a) return s;
        const now = Date.now();
        if (a.lastCaptchaVerifyAt && (now - a.lastCaptchaVerifyAt) < 30_000) {
          rateLimited = true;
          remainingSec = Math.ceil((30_000 - (now - a.lastCaptchaVerifyAt)) / 1000);
          return s;
        }
        a.lastCaptchaVerifyAt = now;
        return s;
      });

      if (rateLimited) {
        await acknowledge(`يرجى الانتظار ${remainingSec} ثانية قبل إعادة التحقق.`, true);
        return { rateLimited: true };
      }

      // Capture baseline security snapshot for post-verification CAS
      const capturedIncidentId = account.captchaIncidentId;
      const capturedCheckGen = account.checkGeneration;
      const capturedCookieFile = account.cookieFile;
      const capturedUserId = account.userId ? String(account.userId) : null;
      const capturedUsername = account.username;

      await acknowledge('جاري فحص حالة الاعتماد لدى X (قراءة فقط)...');

      let verificationSuccess = false;
      let checkError = null;
      let verResult = null;

      try {
        if (this.isolatedVerifier && typeof this.isolatedVerifier.verify === 'function') {
          if (!owns()) return { stale: true };
          verResult = await this.isolatedVerifier.verify(account, { persistResult: false });
        } else if (this.bot.directXAdapter && typeof this.bot.directXAdapter.verifyAccount === 'function') {
          let proxy = account.proxy;
          let route;
          try {
            if (!proxy && this.bot.vpnManager?.acquireReadRoute) {
              route = await this.bot.vpnManager.acquireReadRoute(account.id);
              proxy = route.proxy;
            }
            if (!owns()) return { stale: true };
            verResult = await this.bot.directXAdapter.verifyAccount({ account, proxy });
          } finally {
            try { route?.release?.(); } catch {}
          }
        } else {
          // If neither verifier is available, we MUST NOT fall back to cached authenticated state!
          checkError = 'verifier_unavailable';
        }
      } catch (err) {
        checkError = err.message || 'verification_exception';
      }

      if (!owns()) return { stale: true };
      if (verResult) {
        const isAuth = verResult.authenticated === true;
        const expectedUser = (account.username || account.handle || '').replace(/^@/, '').toLowerCase();
        const actualUser = (verResult.username || '').replace(/^@/, '').toLowerCase();
        const usernameMatch = !expectedUser || (actualUser && actualUser === expectedUser);
        const expectedUserId = account.userId ? String(account.userId) : null;
        const actualUserId = verResult.userId ? String(verResult.userId) : null;
        const userIdMatch = !expectedUserId || (actualUserId && actualUserId === expectedUserId);
        const flagsClear = !verResult.challenge && !verResult.locked && !verResult.captcha &&
                           !verResult.suspended && !verResult.banned && !verResult.accountFailure;

        if (isAuth && usernameMatch && userIdMatch && flagsClear) {
          verificationSuccess = true;
        } else {
          checkError = verResult.accountFailure || verResult.reason || (!usernameMatch || !userIdMatch ? 'identity_mismatch' : 'challenge_still_active');
        }
      }

      if (verificationSuccess) {
        let staleOrPreempted = false;
        let preemptReason = null;

        await updateOwned(s => {
          staleOrPreempted = false;
          preemptReason = null;
          const a = (s.accounts || []).find(acc => acc.id === targetId);
          if (!a) {
            staleOrPreempted = true;
            preemptReason = 'account_not_found';
            return s;
          }

          // Strict Compare-And-Set: verify that NO security challenge, incident, credential, or generation changed!
          // Accept either needsOwnerCaptcha || isCaptchaStatus(a.status) so status label variants never deadlock verification.
          const incidentChanged = a.captchaIncidentId !== capturedIncidentId;
          const genChanged = a.checkGeneration !== capturedCheckGen;
          const cookieChanged = a.cookieFile !== capturedCookieFile;
          const currentUserId = a.userId ? String(a.userId) : null;
          const userChanged = currentUserId !== capturedUserId || a.username !== capturedUsername;
          const challengeClearedOrChanged = !a.needsOwnerCaptcha && !isCaptchaStatus(a.status);

          if (incidentChanged || genChanged || cookieChanged || userChanged || challengeClearedOrChanged) {
            staleOrPreempted = true;
            preemptReason = incidentChanged ? 'newer_incident_occurred' : (cookieChanged ? 'cookie_file_modified' : 'state_or_identity_changed');
            return s;
          }

          a.status = 'غير مفعل';
          a.enabled = false;
          a.needsOwnerCaptcha = false;
          a.captchaResolvedAt = Date.now();
          delete a.captchaIncidentId;
          delete a.captchaCode;
          delete a.captchaReason;
          // Per-chat receipts are scoped to ONE security incident and must not
          // suppress a later CAPTCHA on the same X account.
          delete a.captchaDeliveredChats;
          delete a.captchaDeliveredIncidentId;
          delete a.lastNotifiedCaptchaIncidentId;
          a.checkGeneration = crypto.randomUUID();
          return s;
        });

        if (staleOrPreempted) {
          await this.bot.transport.sendMessage(id.chat, `⚠️ تم إلغاء نتيجة التحقق للحساب @${account.username || account.label} لأن حادثاً أمنياً جديداً أو تعديلاً في بيانات الحساب قد طرأ أثناء الفحص (${preemptReason}). يرجى مراجعة حالة الحساب.`);
          return { verified: false, stale: true, reason: preemptReason };
        }

        if (this.notifiedCaptchaIncidents) {
          for (const key of this.notifiedCaptchaIncidents) {
            if (key.startsWith(`${targetId}_`)) this.notifiedCaptchaIncidents.delete(key);
          }
        }
        const updatedAccounts = this.bot.store.section ? await this.bot.store.section('accounts') : (await this.bot.store.load()).accounts || [];
        const updatedAcc = (updatedAccounts || []).find(a => a.id === targetId);
        if (messageId && updatedAcc) {
          const text = this.accountDetailText(updatedAcc);
          const markup = this.accountDetailKeyboard(updatedAcc, owner);
          await this.editOwnedPanel(id, owner, text, { parse_mode: 'HTML', reply_markup: markup }).catch(() => {});
        }
        await this.bot.transport.sendMessage(id.chat, `✅ نجح التحقق من حل الكابتشا للحساب @${account.username || account.label}!\n\nتم ضبط حالة الحساب إلى «غير مفعل». يمكنك الآن الضغط على «تفعيل» لتفعيله يدوياً عند الرغبة.`);
        return { verified: true, status: 'غير مفعل' };
      } else {
        await this.bot.transport.sendMessage(id.chat, `⚠️ لم يكتمل حل التحقق للحساب @${account.username || account.label} بعد.\n\nلا يزال الحساب مقيداً أو يطلب التحقق من X (${checkError || 'challenge_pending'}). يرجى التأكد من حل الكابتشا عبر الموقع الرسمي لـ X ثم إعادة المحاولة.`);
        return { verified: false, error: checkError };
      }
    }

    if (parsed.action === 'check_session' && parsed.value) {
      const targetId = parsed.value;
      const accounts = this.bot.store.section ? await this.bot.store.section('accounts') : (await this.bot.store.load()).accounts || [];
      const account = accounts.find(a => a.id === targetId);
      if (!account) {
        await acknowledge('الحساب غير موجود', true);
        return { notFound: true };
      }
      // A session check is an isolated, read-only verifier operation. Local
      // enabled/cookie flags are never evidence of authentication.
      await acknowledge('جاري فحص الجلسة عبر المسار المعزول (قراءة فقط)...');
      const captured = structuredClone(account);
      const observationOrder=this.beginAccountObservation();
      let result;
      let error;
      try {
        if (typeof this.isolatedVerifier?.verify !== 'function') {
          error = Object.assign(new Error('Session verifier unavailable'), { code: 'VERIFIER_UNAVAILABLE' });
        } else {
          if (!owns()) return { stale: true };
          result = await this.isolatedVerifier.verify(captured, { persistResult: false, signal:request.checkSignal });
        }
      } catch (err) {
        error = err;
      }
      if (!owns()) return { stale: true };
      if(request.checkSignal?.aborted){await sendCheckResult('⚠️ انتهت مهلة فحص الجلسة؛ النتيجة غير مؤكدة ولم يُغيّر التفعيل.');return {checked:'session',uncertain:true,reason:'timeout'};}
      if (error) {
        const code = error.code || 'verification_error';
        await this.recordAccountCheck(targetId, {
          isolated: false, vpnHealthy: false, authenticated: false,
          transientError: true, lastError: code, reason: code, observationOrder
        }, { session: true, source: 'x-session', isCurrent: owns, expectedAccount: captured }).catch(() => {});
        await sendCheckResult(`⚠️ تعذر التحقق من الجلسة (${code}). الحالة غير مؤكدة؛ لم يُغيّر التفعيل.`);
        return { checked: 'session', verified: false, uncertain: true, reason: code };
      }
      const isolated = result?.isolated === true;
      const healthy = isolated && result?.vpnHealthy === true;
      const auth = result?.authenticated === true;
      const accountFailure = result?.accountFailure || result?.state || result?.reason || null;
      const security = result?.suspended === true || result?.banned === true || result?.captcha === true || result?.challenge === true || result?.locked === true;
      const applied=await this.recordAccountCheck(targetId, { ...result, isolated, vpnHealthy: healthy, authenticated: auth, observationOrder }, {
        session: true, source: 'x-session', isCurrent: owns, expectedAccount: captured, signal:request.checkSignal
      });
      if(!applied)return {checked:'session',superseded:true};
      const checkedAt = new Date(this.clock()).toISOString();
      const isSuspendedOrBanned = result?.suspended === true || result?.banned === true ||
        ['banned', 'suspended', 'suspended_confirmed'].includes(String(accountFailure || '').toLowerCase()) ||
        ['banned', 'suspended', 'suspended_confirmed'].includes(String(result?.accountFailure || '').toLowerCase());
      if (isSuspendedOrBanned) {
        await sendCheckResult(`⛔ تعليق/حظر مثبت للحساب @${account.username || account.label}. المصدر: فحص X المعزول، ${checkedAt}.`);
        if (messageId) {
          const freshAccounts = this.bot.store.section ? await this.bot.store.section('accounts') : (await this.bot.store.load()).accounts || [];
          const updated = freshAccounts.find(a => a.id === targetId);
          if (updated) {
            await this.editOwnedPanel(id, owner, this.accountDetailText(updated), {
              parse_mode: 'HTML',
              reply_markup: this.accountDetailKeyboard(updated, owner)
            }).catch(() => {});
          }
        }
        return { checked: 'session', verified: false, status: 'suspended_confirmed', checkedAt };
      }
      if (result?.captcha === true || result?.challenge === true || result?.locked === true || accountFailure === 'challenge_required' || accountFailure === 'captcha') {
        await sendCheckResult(`⚠️ الحساب يتطلب تدخلاً بشرياً أو تحدياً أمنياً (كابتشا). المصدر: فحص X المعزول، ${checkedAt}.`);
        if (messageId) {
          const freshAccounts = this.bot.store.section ? await this.bot.store.section('accounts') : (await this.bot.store.load()).accounts || [];
          const updated = freshAccounts.find(a => a.id === targetId);
          if (updated) {
            await this.editOwnedPanel(id, owner, this.accountDetailText(updated), {
              parse_mode: 'HTML',
              reply_markup: this.accountDetailKeyboard(updated, owner)
            }).catch(() => {});
          }
        }
        return { checked: 'session', verified: false, status: 'challenge_required', checkedAt };
      }
      if (auth && healthy && !security && result?.username && result?.userId != null) {
        await sendCheckResult(`✅ الجلسة موثقة وسليمة للحساب @${account.username || account.label}. المصدر: فحص X المعزول، ${checkedAt}.`);
        if (messageId) {
          const freshAccounts = this.bot.store.section ? await this.bot.store.section('accounts') : (await this.bot.store.load()).accounts || [];
          const updated = freshAccounts.find(a => a.id === targetId);
          if (updated) {
            await this.editOwnedPanel(id, owner, this.accountDetailText(updated), {
              parse_mode: 'HTML',
              reply_markup: this.accountDetailKeyboard(updated, owner)
            }).catch(() => {});
          }
        }
        return { checked: 'session', verified: true, status: 'authenticated', checkedAt };
      }
      await sendCheckResult(`⚠️ لم تثبت صلاحية الجلسة (${accountFailure || 'unverified'}). يرجى تحديث ملف الكوكيز. المصدر: فحص X المعزول، ${checkedAt}. لم يُعتبر الحساب سليماً.`);
      if (messageId) {
        const freshAccounts = this.bot.store.section ? await this.bot.store.section('accounts') : (await this.bot.store.load()).accounts || [];
        const updated = freshAccounts.find(a => a.id === targetId);
        if (updated) {
          await this.editOwnedPanel(id, owner, this.accountDetailText(updated), {
            parse_mode: 'HTML',
            reply_markup: this.accountDetailKeyboard(updated, owner)
          }).catch(() => {});
        }
      }
      return { checked: 'session', verified: false, status: accountFailure || 'unverified', checkedAt };
    }

    if (parsed.action === 'check_vpn' && parsed.value) {
      const targetId = parsed.value;
      const accounts = this.bot.store.section ? await this.bot.store.section('accounts') : (await this.bot.store.load()).accounts || [];
      const account = accounts.find(a => a.id === targetId);
      if (!account) {
        await acknowledge('الحساب غير موجود', true);
        return { notFound: true };
      }
      const vpnMgr = this.vpnManager || this.bot?.vpnManager;
      if (typeof vpnMgr?.acquireReadRoute !== 'function') {
        await sendCheckResult('⚠️ مدير VPN المعزول غير متاح؛ لم يُستخدم اتصال مباشر.');
        return { checked: 'vpn', healthy: false, reason: 'vpn_manager_unavailable' };
      }
      await acknowledge('جاري فحص مسار VPN المخصص (قراءة فقط)...');
      const observationOrder=this.beginAccountObservation();
      let route;
      try {
        const stateSlots = this.bot.store.section ? await this.bot.store.section('vpnSlots') : (await this.bot.store.load()).vpnSlots || {};
        const hasDedicated = Boolean(stateSlots?.[targetId] != null);
        if (!owns()) return { stale: true };
          route = await vpnMgr.acquireReadRoute(targetId, { allowFallback: !hasDedicated, signal:request.checkSignal });
        if (!owns()) return { stale: true };
      if(request.checkSignal?.aborted){await sendCheckResult('⚠️ انتهت مهلة فحص VPN؛ لم تثبت نتيجة حديثة.');return {checked:'vpn',uncertain:true,reason:'timeout'};}
        const healthy = route?.healthy === true;
        const exitIp = isPublicIp(route?.exitIp || route?.ip) ? (route.exitIp || route.ip) : null;
        const slot = Number.isInteger(route?.slot) ? route.slot : null;
        const applied=await this.recordAccountCheck(targetId, { isolated: healthy && Boolean(exitIp), vpnHealthy: healthy && Boolean(exitIp), exitIp, slot, observationOrder }, { source: 'vpn-health', isCurrent: owns, expectedAccount: account, signal:request.checkSignal });
        if(!applied)return {checked:'vpn',superseded:true};
        if (!healthy || !exitIp || slot == null) {
          const reason = route?.reason || 'vpn_route_not_ready';
          await sendCheckResult(`⚠️ مسار VPN غير جاهز (${reason})؛ لم يُستخدم اتصال مباشر.`);
          return { checked: 'vpn', healthy: false, reason, slot };
        }
        await sendCheckResult(`✅ مسار VPN سليم وموثق. المنفذ: ${slot}; Exit IP: ${exitIp}.`);
        if (messageId) {
          const freshAccounts = this.bot.store.section ? await this.bot.store.section('accounts') : (await this.bot.store.load()).accounts || [];
          const updated = freshAccounts.find(a => a.id === targetId);
          if (updated) {
            await this.editOwnedPanel(id, owner, this.accountDetailText(updated), {
              parse_mode: 'HTML',
              reply_markup: this.accountDetailKeyboard(updated, owner)
            }).catch(() => {});
          }
        }
        return { checked: 'vpn', healthy: true, exitIp, slot };
      } catch (err) {
        if (!owns()) return { stale: true };
        const reason = err?.code || 'vpn_check_failed';
        await this.recordAccountCheck(targetId, { isolated: false, vpnHealthy: false, slot: route?.slot ?? null, transientError: true, reason, observationOrder }, { source: 'vpn-health', isCurrent: owns, expectedAccount: account }).catch(() => {});
        await sendCheckResult(`⚠️ تعذر فحص مسار VPN (${reason})؛ لم يُستخدم اتصال مباشر.`);
        return { checked: 'vpn', healthy: false, reason };
      } finally {
        try { route?.release?.(); } catch {}
      }
    }

    if (parsed.action === 'delete_prompt' && parsed.value) {
      const targetId = parsed.value;
      const accounts = this.bot.store.section ? await this.bot.store.section('accounts') : (await this.bot.store.load()).accounts || [];
      const account = (accounts || []).find(a => a.id === targetId);
      if (!account) {
        await acknowledge('الحساب غير موجود', true);
        return { notFound: true };
      }
      const name = escapeHtml(account.username ? `@${clean(account.username)}` : account.label || account.id);
      const text = `⚠️ <b>هل أنت متأكد من حذف الحساب ${name}؟</b>\n\nسيتم إزالة الحساب وملف الكوكيز الخاص به نهائياً من النظام.`;
      const markup = {
        inline_keyboard: [
          [{ text: '⚠️ تأكيد الحذف نهائياً', callback_data: this.accountCallback('accmanage', 'delete_confirm', account.id, owner), ...(this.inlineStyles ? { style: 'danger' } : {}) }],
          [{ text: '↩️ إلغاء والعودة', callback_data: this.accountCallback('accmanage', 'select', account.id, owner) }]
        ]
      };
      if (messageId) {
        await this.editOwnedPanel(id, owner, text, { parse_mode: 'HTML', reply_markup: markup }).catch(err => this._logWarn('telegram_ui_edit_message_suppressed', 'accountManage.delete_prompt', err));
      }
      await acknowledge();
      return { prompt: 'delete' };
    }

    if (parsed.action === 'delete_confirm' && parsed.value) {
      const targetId = parsed.value;
      const vpnMgr = this.vpnManager || this.bot?.vpnManager;
      if (this.activeRun && Array.isArray(this.activeRun.accountIds)) {
        const idx = this.activeRun.accountIds.indexOf(targetId);
        if (idx !== -1) this.activeRun.accountIds.splice(idx, 1);
        if (typeof this.activeRun.cursor === 'number' && this.activeRun.cursor >= this.activeRun.accountIds.length) {
          this.activeRun.cursor = 0;
        }
      }
      if (typeof vpnMgr?.release === 'function') {
        vpnMgr.release(targetId).catch(err =>
          this._logError('vpn_release_failed', 'accountManage.delete_confirm', err, { accountId: targetId })
        );
      }
      Promise.resolve(this.bot?.forensicLogger?.record({
        eventType: 'manual_toggle',
        accountId: targetId,
        details: { action: 'delete' }
      })).catch(err => this._logError('forensic_record_failed', 'accountManage.delete_confirm', err, { accountId: targetId }));
      if (this.bot.accounts?.remove) {
        if (!owns()) return { stale: true };
          await this.bot.accounts.remove(targetId);
      } else {
        await updateOwned(s => {
          s.accounts = (s.accounts || []).filter(a => a.id !== targetId);
          return s;
        });
      }
      await updateOwned(s => {
        if (s.cycle?.state === 'running' && s.telegramUi?.run && Array.isArray(s.telegramUi.run.accountIds)) {
          s.telegramUi.run.accountIds = s.telegramUi.run.accountIds.filter(id => id !== targetId);
          if (s.telegramUi.run.accountIds.length === 0 || (typeof s.telegramUi.run.cursor === 'number' && s.telegramUi.run.cursor >= s.telegramUi.run.accountIds.length)) {
            s.telegramUi.run.cursor = 0;
          }
        }
        if (s.vpnSlots && Object.hasOwn(s.vpnSlots, targetId)) {
          delete s.vpnSlots[targetId];
        }
        if (s.telegramUi?.users) {
          for (const u of Object.values(s.telegramUi.users)) {
            if (String(u?.chatId) === String(id.chat)) {
              u.selectionIds = null;
              if (u.accountId === targetId) u.accountId = null;
            }
          }
        }
        return s;
      });
      if (this.fastNavigation) {
        for (const [key, u] of Object.entries(this.fastNavigation.users || {})) {
          if (String(u?.chatId) === String(id.chat)) {
            this.fastNavigation.users[key] = { ...u, selectionIds: null, ...(u.accountId === targetId ? { accountId: null } : {}) };
          }
        }
        for (const [key, patch] of this.fastNavigation.pending || []) {
          if (String(patch?.chatId) === String(id.chat)) {
            this.fastNavigation.pending.set(key, { ...patch, selectionIds: null, ...(patch.accountId === targetId ? { accountId: null } : {}) });
          }
        }
      }
      this.refreshPanels(true).catch(() => {});
      const accounts = this.bot.store.section ? await this.bot.store.section('accounts') : (await this.bot.store.load()).accounts || [];
      const text = accounts.length ? 'اختر الحساب لعرض إعداداته:' : 'لا توجد حسابات مسجلة في النظام.';
      const markup = this.accountBrowseKeyboard(accounts, owner);
      const ackPromise = acknowledge('تم حذف الحساب بنجاح', true);
      const editPromise = messageId
        ? this.editOwnedPanel(id, owner, text, { reply_markup: markup }).catch(err => this._logWarn('telegram_ui_edit_message_suppressed', 'accountManage.delete_confirm', err))
        : Promise.resolve();
      await Promise.all([ackPromise, editPromise]);
      return { deleted: targetId };
    }

    await acknowledge();
    return {};
  }

  async cycleControl(request, raw) {
    const entryStopGeneration = request?.entryStopGeneration ?? (this.stopGeneration || 0);
    const deferNav = request?.deferNavigation === true;
    const id = this.identity(raw); const parsed = request.parsed || {};
    const latest = await this.callbackPanel(id, request, raw, 'dashboard');
    if (!latest) return this.stalePanel(request, raw, 'بدء العمل');
    const owns = () => this.ownsPanel(id.chat, latest);
    const acknowledge = (text, alert = false, opts = {}) => this._acknowledgeWithNotice(id, request, raw, text, alert, opts);
    if (parsed.action === 'start' && entryStopGeneration !== (this.stopGeneration || 0)) {
      acknowledge('تم إلغاء بدء الدورة.', false).catch(() => {});
      return { started: false, cancelled: true };
    }

    // Single-Flight & Task Generation CAS
    this.controlFlights ||= new Map();
    const flightKey = `${id.chat}:${parsed.action}`;
    const activeFlight = this.controlFlights.get(flightKey);
    if (activeFlight && (parsed.action !== 'start' || activeFlight._stopGeneration === (this.stopGeneration || 0))) {
      if (parsed.action === 'stop') acknowledge('جاري الإيقاف...', true, { allowNotice: false }).catch(() => {});
      else if (parsed.action === 'refresh') acknowledge('جاري التحديث...', false).catch(() => {});
      else acknowledge('جاري التجهيز...', false).catch(() => {});
      if (deferNav && parsed.action === 'start') return { admitted: true, preparing: true };
      if (deferNav && parsed.action === 'refresh') return { admitted: true, refreshing: Boolean(this.accountRefreshJob) };
      return activeFlight;
    }

    if (parsed.action === 'refresh') {
      acknowledge('جاري التحديث...', false).catch(() => {});
      if (deferNav) {
        const snapshotAccounts = this.normalizedPanelSnapshot ? this.normalizedProjectionState(this.normalizedPanelSnapshot).accounts : null;
        const memAccounts = this.fastNavigation?.lastObservedState?.accounts || snapshotAccounts || null;
        const preSeededIds = memAccounts
          ? memAccounts.filter(a => a && a.enabled !== false && a.cookieFile).map(a => a.id)
          : undefined;
        const job = this.startAccountRefresh(preSeededIds ? { preSeededIds } : {});
        this.evaluateDashboardPolling();
        const refreshDelivery = Promise.resolve()
          .then(() => this.readFreshDashboard().catch(() => {}))
          .then(() => this.refreshPanels(true).catch(err => this._logWarn('panel_refresh_failed', 'cycleControl.refresh', err)))
          .finally(() => {
            if (this.controlFlights.get(flightKey) === refreshDelivery) {
              this.controlFlights.delete(flightKey);
            }
          });
        refreshDelivery._stopGeneration = entryStopGeneration;
        this.controlFlights.set(flightKey, refreshDelivery);
        this.trackControlTask(refreshDelivery);
        this.trackNavigationDelivery(refreshDelivery);
        if (job?.task) this.trackControlTask(job.task);
        return { admitted: true, refreshing: Boolean(job) };
      }
      const flightPromise = (async () => {
        const snapshotAccounts = this.normalizedPanelSnapshot ? this.normalizedProjectionState(this.normalizedPanelSnapshot).accounts : null;
        const accounts = (this.fastNavigation?.lastObservedState?.accounts || snapshotAccounts || (await this.bot.store.section?.('accounts')) || (await this.bot.store.load()).accounts || []).filter(a => a && a.enabled !== false && a.cookieFile);
        if (!owns()) return { stale: true };
        const preSeededIds = accounts.map(a => a.id);
        const job = this.startAccountRefresh({ preSeededIds });
        this.evaluateDashboardPolling();
        await this.readFreshDashboard().catch(() => {});
        await this.refreshPanels(true).catch(err => this._logWarn('panel_refresh_failed', 'cycleControl.refresh', err));
        return { refreshing: Boolean(job), accountRefresh: Boolean(job), seeded: true };
      })().finally(() => {
        if (this.controlFlights.get(flightKey) === flightPromise) {
          this.controlFlights.delete(flightKey);
        }
      });
      flightPromise._stopGeneration = entryStopGeneration;
      this.controlFlights.set(flightKey, flightPromise);
      return flightPromise;
    }

    if (parsed.action === 'start') {
      if (entryStopGeneration !== (this.stopGeneration || 0)) {
        acknowledge('تم إلغاء بدء الدورة.', false).catch(() => {});
        return { started: false, cancelled: true };
      }
      if (!owns()) return { stale: true };
      const existingStart = this.activeStartFlight;
      if (existingStart && !existingStart.controller.signal.aborted && existingStart.startGeneration === (this.startGeneration || 0) && existingStart.stopGeneration === entryStopGeneration && !this.job) {
        acknowledge('جاري التجهيز...', false).catch(() => {});
        const attachedFlight = existingStart.promise.finally(() => {
          if (this.controlFlights.get(flightKey) === attachedFlight) {
            this.controlFlights.delete(flightKey);
          }
        });
        attachedFlight._stopGeneration = entryStopGeneration;
        this.controlFlights.set(flightKey, attachedFlight);
        if (deferNav) {
          this.trackControlTask(attachedFlight);
          return { admitted: true, preparing: true };
        }
        return attachedFlight;
      }
      const taskId = crypto.randomUUID();
      const taskGeneration = ++this.controlTaskGeneration;
      const prepGen = ++this.preparingGeneration;
      this.isPreparing = true;
      this.evaluateDashboardPolling();

      acknowledge('جاري التجهيز...', false).catch(() => {});
      this.trackNavigationDelivery(
        this.refreshPanels(true).catch(err => this._logWarn('panel_refresh_failed', 'cycleControl.start_preparing', err))
      );

      const executeStart = async () => {
        try {
          if (taskGeneration !== this.controlTaskGeneration || entryStopGeneration !== (this.stopGeneration || 0) || prepGen !== this.preparingGeneration) {
            return { started: false, cancelled: true };
          }
          if (!owns()) return { stale: true };
          const res = typeof this.runnerStart === 'function'
            ? await this.runnerStart({ source: 'manual', id, value: parsed.value, taskId, taskGeneration, callbackPanel: latest, entryStopGeneration, preparingGeneration: prepGen })
            : await this.begin('manual', id, parsed.value, { taskId, taskGeneration, entryStopGeneration, preparingGeneration: prepGen, panel: latest });
          if (!res?.started) {
            if (!res?.cancelled) {
              const errorMsg = res?.reasons?.length ? res.reasons.join('، ') : 'تعذر بدء الدورة. يرجى مراجعة إعدادات الحسابات والمنشورات.';
              const noticeTask = this.bot.transport.sendMessage(id.chat, `⚠️ لا يمكن بدء دورة النشر:\n• ${errorMsg}`, {
                reply_markup: this.bot.transport.keyboard('main')
              }).catch(() => {});
              if (deferNav) this.trackControlTask(noticeTask);
              else await noticeTask;
            }
          }
          return res;
        } finally {
          const ownedPrep = this.preparingGeneration === prepGen;
          if (ownedPrep) {
            this.isPreparing = false;
          }
          this.evaluateDashboardPolling();
          if (!this.destroyed && (ownedPrep || (entryStopGeneration === (this.stopGeneration || 0) && taskGeneration === this.controlTaskGeneration))) {
            if (deferNav) {
              const finalRefresh = Promise.resolve()
                .then(() => this.readFreshDashboard().catch(() => {}))
                .then(() => this.refreshPanels(true).catch(err => this._logWarn('panel_refresh_failed', 'cycleControl.start', err)));
              this.trackControlTask(finalRefresh);
              this.trackNavigationDelivery(finalRefresh);
            } else {
              await this.readFreshDashboard().catch(() => {});
              await this.refreshPanels(true).catch(err => this._logWarn('panel_refresh_failed', 'cycleControl.start', err));
            }
          }
        }
      };

      const flightPromise = executeStart().finally(() => {
        if (this.controlFlights.get(flightKey) === flightPromise) {
          this.controlFlights.delete(flightKey);
        }
      });
      flightPromise._stopGeneration = entryStopGeneration;
      this.controlFlights.set(flightKey, flightPromise);
      if (deferNav) {
        this.trackControlTask(flightPromise);
        return { admitted: true, preparing: true };
      }
      return flightPromise;
    }

    if (parsed.action === 'stop') {
      if (!owns()) return { stale: true };
      const flightPromise = (async () => {
        const wasPendingStart = Boolean(this.controlFlights?.has(`${id.chat}:start`) || this.pendingStartAbortController || this.isPreparing || this.wasPendingStartAborted);
        this.controlFlights?.delete(`${id.chat}:start`);
        // Priority Stop: abort pending starts immediately and fence worker admission
        this.controlTaskGeneration = (this.controlTaskGeneration || 0) + 1;
        this.cancelPendingStarts();
        this.pendingStartAbortController?.abort();
        this.workerPool?.fenceAdmission();
        this.onCycleStop?.();

        acknowledge('جاري الإيقاف...', true, { allowNotice: false }).catch(() => {});
        const stopPromise = owns() ? this.stop(parsed.value, id, latest, { wasPendingStart, deferRefresh: deferNav }) : Promise.resolve({ stale: true });
        const res = await stopPromise;
        if (res && (res.stopped !== undefined || res.stale)) return res;
        return { stopped: true, pendingStartAborted: wasPendingStart };
      })().finally(() => {
        if (this.controlFlights.get(flightKey) === flightPromise) {
          this.controlFlights.delete(flightKey);
        }
      });
      flightPromise._stopGeneration = entryStopGeneration;
      this.controlFlights.set(flightKey, flightPromise);
      return flightPromise;
    }
  }
  async stop(expectedToken, id, expectedPanel, options = {}) {
    if (id) {
      const root = this.bot.store.section ? await this.bot.store.section('telegramUi') : (await this.bot.store.load()).telegramUi;
      const current = this.currentPanel(id.chat, 'dashboard', root);
      if (!current || (expectedPanel && !this.samePanel(current, expectedPanel)) || (current.token !== expectedToken && current.stopToken !== expectedToken)) return { stale: true };
      expectedPanel ||= { ...current };
    }
    const chatKey = id?.chat != null ? String(id.chat) : '';
    const hasFlight = chatKey ? this.controlFlights?.has(`${chatKey}:start`) : Array.from(this.controlFlights?.keys() || []).some(k => k.endsWith(':start'));
    const wasPendingStart = Boolean(options?.wasPendingStart || hasFlight || this.pendingStartAbortController || this.isPreparing || this.wasPendingStartAborted);
    this.wasPendingStartAborted = false;
    this.controlTaskGeneration = (this.controlTaskGeneration || 0) + 1;
    this.cancelPendingStarts();
    this.pendingStartAbortController?.abort();
    this.workerPool?.fenceAdmission();
    this.onCycleStop?.();
    let accepted = false; let snapshot; let committedCycle;
    await this.bot.store.update(s => {
      accepted = false;
      snapshot = undefined;
      committedCycle = undefined;
      if (id) {
        const p = this.currentPanel(id.chat, 'dashboard', s.telegramUi);
        if (!this.samePanel(p, expectedPanel) || (p?.token !== expectedToken && p?.stopToken !== expectedToken)) return s;
      }
      this.cancelPendingStarts();
      if (s.cycle?.state === 'running') {
        s.cycle.state = 'stopping';
        committedCycle = structuredClone(s.cycle);
        snapshot = structuredClone(s.telegramUi.run);
        accepted = true;
      }
      return s;
    });
    if (this.fastNavigation && committedCycle) {
      this.fastNavigation.snapshot = { ...(this.fastNavigation.snapshot || {}), cycle: committedCycle };
    }
    if (this.normalizedPanelSnapshot && committedCycle) {
      this.normalizedPanelSnapshot = { ...this.normalizedPanelSnapshot, cycle: committedCycle };
    }
    // Cancellation precedes panel teardown; Telegram I/O cannot hold dispatch.
    if (accepted || wasPendingStart) {
      this.onCycleStop?.(snapshot);
    }
    if (!id) {
      if (this.ticker) { clearInterval(this.ticker); this.ticker = null; }
      this.stopTicker().catch(err => this._logError('stop_ticker_failed', 'stop', err));
    }
    if (options?.deferRefresh) {
      const loopStop = this.stopNormalizedDashboardLoop().catch(() => {});
      this.trackControlTask(loopStop);
      const stopRefresh = this.refreshPanels(true).catch(err => this._logWarn('panel_refresh_failed', 'stop', err));
      this.trackControlTask(stopRefresh);
      this.trackNavigationDelivery(stopRefresh);
    } else {
      await this.stopNormalizedDashboardLoop().catch(() => {});
      await this.refreshPanels(true).catch(err => this._logWarn('panel_refresh_failed', 'stop', err));
    }
    if (!accepted && !wasPendingStart) return { stopped: false };
    return { stopped: true, pendingStartAborted: wasPendingStart };
  }

  async sendIsolationAlert({ account, reason, failures = 3, otherActiveCount = 0 }) {
    if (!account) return null;
    const username = account.username || account.label || account.id;
    let diagnosticReason = reason;
    if (account.status === 'محظور' || String(reason).includes('banned')) {
      diagnosticReason = ISOLATION_REASONS.BANNED;
    } else if (account.status === 'كابتشا' || String(reason).includes('captcha') || account.needsOwnerCaptcha) {
      diagnosticReason = ISOLATION_REASONS.CAPTCHA;
    } else if (String(reason).includes('cookie') || String(reason).includes('session')) {
      diagnosticReason = ISOLATION_REASONS.COOKIE_REJECTED;
    } else if (failures >= 3 || account.status === 'معزول (3 إخفاقات)') {
      diagnosticReason = ISOLATION_REASONS.STRIKES_EXCEEDED;
    }

    let incidentId = null;
    const configuredChats = Array.from(this.bot?.auth?.chats || []).map(String);
    let prevDelivered = new Set();
    let pendingChats = configuredChats.length > 0 ? [...configuredChats] : null;

    if (diagnosticReason === ISOLATION_REASONS.CAPTCHA) {
      incidentId = account.captchaIncidentId || `${account.id || username}_${account.captchaDetectedAt || 'current'}`;
      this.notifiedCaptchaIncidents ||= new Set();
      this.inFlightAlerts ||= new Set();

      // Suppress if already successfully notified to all chats or currently in-flight
      if (this.notifiedCaptchaIncidents.has(incidentId) || account.lastNotifiedCaptchaIncidentId === incidentId) {
        return null;
      }
      if (this.inFlightAlerts.has(incidentId)) {
        return null;
      }

      // Inspect the CURRENT persisted incident, not a stale account object passed by the runner.
      const latest = await this.bot?.store?.load?.();
      // Another callback may have acquired the incident while this awaited SQLite.
      // Recheck before claiming it; the check and add below have no await between them.
      if (this.inFlightAlerts.has(incidentId)) return null;
      const live = latest?.accounts?.find(a => a.id === account.id);
      if (live && live.captchaIncidentId !== incidentId) return null;
      // Never use deliveries from incident A to suppress a new incident B.
      if (live?.captchaDeliveredIncidentId === incidentId && Array.isArray(live.captchaDeliveredChats)) {
        prevDelivered = new Set(live.captchaDeliveredChats.map(String));
      } else if (!live && account.captchaDeliveredIncidentId === incidentId && Array.isArray(account.captchaDeliveredChats)) {
        prevDelivered = new Set(account.captchaDeliveredChats.map(String));
      }
      if (configuredChats.length > 0) {
        pendingChats = configuredChats.filter(c => !prevDelivered.has(c));
        if (pendingChats.length === 0) {
          this.notifiedCaptchaIncidents.add(incidentId);
          return null;
        }
      }

      this.inFlightAlerts.add(incidentId);
    }

    const message = buildIsolationMessage({ username, reason: diagnosticReason, otherActiveCount });
    // Keep incident in-flight until its confirmed receipts are durably stored.
    try {
    let notifyResult = null;
    let notifyError = null;

    try {
      if (this.notify) {
        notifyResult = await this.notify(message, pendingChats ? { targetChatIds: pendingChats } : undefined);
      }
    } catch (err) {
      notifyError = err;
    }

    if (notifyError) {
      return null;
    }

    // Verify actual delivery success before marking state delivered!
    // Require verified Telegram Bot API response with ok:true and valid message_id per chat.
    const confirmedChatIds = [];
    if (Array.isArray(notifyResult)) {
      for (let i = 0; i < notifyResult.length; i++) {
        const item = notifyResult[i];
        if (item && item.status === 'fulfilled') {
          const val = item.value;
          const hasReceipt = val && typeof val === 'object' && (val.ok === true || val.message_id != null || val.result?.message_id != null);
          const messageId = val?.message_id ?? val?.result?.message_id;
          if (hasReceipt && (typeof messageId === 'number' || typeof messageId === 'string')) {
            const chatId = String(val.chat_id || val.result?.chat?.id || item.chat_id || (pendingChats && pendingChats[i]) || `chat_${i}`);
            confirmedChatIds.push(chatId);
          }
        }
      }
    } else if (notifyResult && typeof notifyResult === 'object') {
      const hasReceipt = (notifyResult.ok === true || notifyResult.message_id != null || notifyResult.result?.message_id != null);
      const messageId = notifyResult.message_id ?? notifyResult.result?.message_id;
      if (hasReceipt && (typeof messageId === 'number' || typeof messageId === 'string')) {
        const chatId = String(notifyResult.chat_id || notifyResult.result?.chat?.id || (pendingChats && pendingChats[0]) || 'default');
        confirmedChatIds.push(chatId);
      }
    }

    if (confirmedChatIds.length === 0) {
      return null; // Delivery was not acknowledged by Telegram API; do not mark as sent to allow retry
    }

    if (diagnosticReason === ISOLATION_REASONS.CAPTCHA && incidentId) {
      const newDelivered = Array.from(new Set([...prevDelivered, ...confirmedChatIds]));
      const allComplete = configuredChats.length > 0
        ? configuredChats.every(c => newDelivered.includes(c))
        : true;

      if (this.bot?.store?.update) {
        try {
          await this.bot.store.update(s => {
            const a = (s.accounts || []).find(acc => acc.id === account.id);
            // A newer security incident may have arrived while Telegram was responding.
            if (a && a.captchaIncidentId === incidentId) {
              const previous = a.captchaDeliveredIncidentId === incidentId && Array.isArray(a.captchaDeliveredChats)
                ? a.captchaDeliveredChats.map(String) : [];
              a.captchaDeliveredIncidentId = incidentId;
              a.captchaDeliveredChats = Array.from(new Set([...previous, ...confirmedChatIds]));
              a.lastCaptchaAlertAt = Date.now();
              // Production supplies the authorized chat list. A supplied one-chat
              // verifier in isolated tests may have no auth configuration.
              if ((configuredChats.length === 0 && a.captchaDeliveredChats.length > 0) ||
                  (configuredChats.length > 0 && configuredChats.every(c => a.captchaDeliveredChats.includes(c)))) {
                a.lastNotifiedCaptchaIncidentId = incidentId;
              }
            }
            return s;
          });
        } catch {}
      }

      // Check persisted state before caching completion: do not silence incident B.
      const after = await this.bot?.store?.load?.();
      const current = after?.accounts?.find(a => a.id === account.id);
      if ((current?.captchaIncidentId === incidentId && current.lastNotifiedCaptchaIncidentId === incidentId) ||
          (!current && configuredChats.length === 0 && allComplete)) {
        this.notifiedCaptchaIncidents.add(incidentId);
      }
    }

    return message;
    } finally {
      if (incidentId) this.inFlightAlerts?.delete(incidentId);
    }
  }

  shouldNotifyStrike(strikeNumber) {
    return Number.isInteger(strikeNumber) && strikeNumber >= 3;
  }

  async notifyStrike({ account, strikeNumber, reason, otherActiveCount = 0 }) {
    if (!this.shouldNotifyStrike(strikeNumber)) {
      return { notified: false, suppressed: true, strikeNumber };
    }
    const message = await this.sendIsolationAlert({
      account,
      reason: reason || ISOLATION_REASONS.STRIKES_EXCEEDED,
      failures: strikeNumber,
      otherActiveCount
    });
    if (!message) {
      return { notified: false, suppressed: true, strikeNumber };
    }
    return { notified: true, message, strikeNumber };
  }

  async sendQueueStallAlert() {
    if (this.stallAlertSent) {
      return { notified: false, throttled: true };
    }
    const alertText = 'جميع الحسابات غير مؤهلة أو في فترة انتظار؛ توقفت الدورة وبقيت المنشورات في الانتظار.';
    if (!this.notify) {
      return { notified: false, suppressed: true, text: alertText };
    }
    const result = await this.notify(alertText);
    if (isNotifyResultSuppressed(result)) {
      return { notified: false, suppressed: true, text: alertText };
    }
    return { notified: true, text: alertText };
  }

  resetQueueStall() {
    this.stallAlertSent = false;
  }

  async handle409Conflict(error, { retryFn, maxRetries = 3, initialBackoffMs = 1000, sleepFn = (ms => new Promise(res => setTimeout(res, ms))) } = {}) {
    if (!isConflict409(error)) throw error;
    this.bot.logger?.error?.(JSON.stringify({ event: 'telegram_ui_conflict_detected', message: sanitizeError(error) }));
    if (typeof retryFn !== 'function') return { handled: true, retried: false };
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const backoff = initialBackoffMs * Math.pow(2, attempt - 1);
      await sleepFn(backoff);
      try {
        const result = await retryFn();
        return { handled: true, retried: true, attempts: attempt, result };
      } catch (retryErr) {
        if (!isConflict409(retryErr) || attempt === maxRetries) throw retryErr;
      }
    }
  }
}
module.exports = {
  TelegramUi,
  formatRiyadhClock,
  MAX_ACTIVE_ACCOUNTS,
  ISOLATION_REASONS,
  isCaptchaStatus,
  formatIsolationReason,
  buildIsolationMessage,
  trackVpnRelease,
  awaitVpnRelease
};
