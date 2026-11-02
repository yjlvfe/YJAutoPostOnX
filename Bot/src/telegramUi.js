'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { accountCapacity, quotaAdmission } = require('./quota');
const { DEFAULT_SETTINGS, parseDuration, formatDuration } = require('./settings');
const { TelegramFlows } = require('./telegramFlows');
const { richTable, accountStatus, formatAccountTable, clean } = require('./accountTable');
const { isConflict409 } = require('./singleInstance');

const MAX_ACTIVE_ACCOUNTS = 5;

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
  if (otherActiveCount > 0) {
    return `تم عزل الحساب ${cleanUsername} تلقائياً (السبب: ${formattedReason}) ومواصلة الدورة عبر بقية الحسابات (${otherActiveCount}).`;
  }
  return `تم عزل الحساب ${cleanUsername} تلقائياً (السبب: ${formattedReason}). لا توجد حسابات مؤهلة متبقية؛ توقفت الدورة.`;
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
const durationText = seconds => formatDurationAdaptive(seconds);
const token = () => crypto.randomBytes(12).toString('hex');
const cycleRunning = state => ['running', 'stopping'].includes(state?.cycle?.state);
const validText = value => typeof value === 'string' && value.trim() && true;
const eligible = account => account.enabled !== false && typeof account.username === 'string' && account.username.trim() && typeof account.cookieFile === 'string' && account.cookieFile.trim();
const validSettings = settings => Number.isSafeInteger(settings.delayMs) && settings.delayMs >= 0 && (settings.dailyQuota == null || (Number.isSafeInteger(settings.dailyQuota) && settings.dailyQuota > 0));

class TelegramUi {
  constructor({ bot, runtimeReady = async () => ({ ready: false, reasons: ['مكونات النشر الفعلي غير جاهزة'] }), launch, clock = () => new Date(), inlineStyles = true, downloadDocument, isolatedVerifier, onCycleFinished, onCycleStop, onPanelTask, notify, accountRefreshRetryMs = 2000 }) {
    this.bot = bot; this.runtimeReady = runtimeReady; this.launch = launch; this.clock = clock; this.inlineStyles = inlineStyles;
    this.isolatedVerifier = isolatedVerifier;
    this.accountRefreshJob = null; this.accountRefreshRetryMs = accountRefreshRetryMs; this.destroyed = false;
    this.panelBlockedUntil = new Map(); this.panelLastEdit = new Map();
    this.onPanelTask = typeof onPanelTask === 'function' ? onPanelTask : null;
    this.stallAlertSent = false;
    this.rawNotify = notify;
    this.notify = async (text) => {
      if (!this.rawNotify) return;
      if (typeof text === 'string') {
        if (text.includes('جميع الحسابات غير مؤهلة أو في فترة انتظار')) {
          if (this.stallAlertSent) return;
          this.stallAlertSent = true;
        }
        if (/إخفاق مؤقت|محاولة (1|2) من 3|strike [12]\b/i.test(text)) {
          return;
        }
        if (text.includes('تم عزل الحساب') && !text.includes('(السبب:')) {
          text = text
            .replace(/\(كابتشا\)/g, `(السبب: ${ISOLATION_REASONS.CAPTCHA})`)
            .replace(/\(محظور\)/g, `(السبب: ${ISOLATION_REASONS.BANNED})`)
            .replace(/\(معزول \(3 إخفاقات\)\)/g, `(السبب: ${ISOLATION_REASONS.STRIKES_EXCEEDED})`)
            .replace(/\(جلسة مرفوضة\)/g, `(السبب: ${ISOLATION_REASONS.COOKIE_REJECTED})`);
        }
      }
      return this.rawNotify(text);
    };
    this.onCycleFinished = onCycleFinished; this.onCycleStop = onCycleStop; this.job = null; this.activeRun = null; this.panelLocks = new Map(); this.actionLocks = new Map(); this.refreshTask = null;
    this.flows = new TelegramFlows(this, { downloadDocument, isolatedVerifier });
    this.startTicker();
  }
  startTicker() {
    if (this.ticker) return;
    this.ticker = setInterval(() => { this.refreshPanels().catch(() => {}); }, 1000);
    this.ticker.unref?.();
  }
  actions() {
    const a = {};
    for (const name of ['menu', 'work', 'settings', 'accounts', 'scheduleMenu', 'delayMenu', 'quotaMenu', 'posts', 'back', 'input', 'cycleControl', 'document', 'flowControl', 'accountControl', 'unknownCallback', 'navControl', 'accountToggleMenu', 'accountToggle', 'accountsBrowse', 'accountManage', 'delayControl', 'scheduleControl']) {
      a[name] = (request, raw) => {
        const key = this.identity(raw).key;
        const priorityStop = name === 'cycleControl' && request.parsed?.action === 'stop';
        const previous = priorityStop ? Promise.resolve() : this.actionLocks.get(key) || Promise.resolve();
        const task = previous.catch(() => {}).then(() => this[name](request, raw)).catch(async error => {
          if (isConflict409(error)) {
            this.bot.logger?.error?.(JSON.stringify({ event: 'telegram_ui_conflict_409', action: name, message: error.message }));
            return;
          }
          if (error?.ambiguous || error?.telegramCode || ['TELEGRAM_TIMEOUT', 'TELEGRAM_INVALID_RESPONSE', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN'].includes(error?.code)) throw error;
          return this.bot.transport.sendMessage(this.identity(raw).chat, 'تعذر تنفيذ الإجراء. لم يبدأ النشر. حاول مجدداً أو اضغط رجوع.', { reply_markup: this.bot.transport.keyboard('waiting') });
        });
        if (priorityStop) return task;
        this.actionLocks.set(key, task);
        return task.finally(() => { if (this.actionLocks.get(key) === task) this.actionLocks.delete(key); });
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
    await this.bot.store.update(s => { s.telegramUi ||= {}; s.telegramUi.users ||= {}; const u = s.telegramUi.users[id.key] ||= {}; u.chatId = id.chat; u.userId = id.user; u.page = page; u.prompt = prompt; return s; });
  }
  async show(id, page, text, prompt = null) {
    await this.page(id, page, prompt);
    return this.bot.transport.sendMessage(id.chat, text, { reply_markup: this.bot.transport.keyboard(prompt ? 'input' : page) });
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
        await this.bot.transport.editMessageText(id.chat, messageId, this.scheduleText(s), { parse_mode: 'HTML', reply_markup: this.scheduleKeyboard(s.schedule?.enabled === true) }).catch(() => {});
      }
      await acknowledge(enable ? 'تم تفعيل الجدولة' : 'تم تعطيل الجدولة');
      return { scheduleToggled: enable };
    }

    if (parsed.action === 'set_time') {
      await this.flows.set(id, { prompt: 'schedule', promptMessageId: messageId, page: 'schedule' });
      if (messageId) {
        await this.bot.transport.editMessageText(id.chat, messageId, 'أدخل موعد النشر اليومي بتوقيت مكة بصيغة 24 ساعة (مثال: 09:30 أو 21:00):', { reply_markup: { inline_keyboard: [] } }).catch(() => {});
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
        await this.bot.transport.editMessageText(id.chat, messageId, 'أدخل الحد الأدنى للمدة بصيغة دقائق:ثوانٍ (مثال: 0:45 أو 1:30) حتى 60:00:', { reply_markup: { inline_keyboard: [] } }).catch(() => {});
      }
      await acknowledge();
      return { prompt: 'delayMin' };
    }

    if (parsed.action === 'set_max') {
      await this.flows.set(id, { prompt: 'delayMax', promptMessageId: messageId, page: 'delay' });
      if (messageId) {
        await this.bot.transport.editMessageText(id.chat, messageId, 'أدخل الحد الأعلى للمدة بصيغة دقائق:ثوانٍ (مثال: 2:00 أو 3:30) حتى 60:00:', { reply_markup: { inline_keyboard: [] } }).catch(() => {});
      }
      await acknowledge();
      return { prompt: 'delayMax' };
    }

    await acknowledge();
    return {};
  }

  async getSettingsKeyboard() {
    const s = await this.bot.settings.get();
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
    if (u.page === 'cookies') {
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
    if (['accounts'].includes(u.page)) {
      return this.settings(_, raw);
    }
    return this.menu(_, raw);
  }

  async input(_, raw) {
    const id = this.identity(raw);
    const text = String(raw.message?.text || raw.message?.caption || '').trim();
    const cleanText = text.replace(/[\uFEFF\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
      .replace(/^(?:(?:🚀|📊|➕|📝|⚙️?|🔙|↩️?)\s*)+/u, '')
      .replace(/(?:\s*(?:🚀|📊|➕|📝|⚙️?|🔙|↩️?))+$/u, '').trim();
    const u = await this.flows.user(id);

    const menuButtons = ['بدء العمل', 'إضافة منشورات', 'الإعدادات', 'إدارة الحسابات', 'التأخير', 'الجدولة', 'الحصص', 'رجوع', 'إلغاء', 'إضافة', 'تفعيل / إلغاء تفعيل', 'الحسابات'];
    if (menuButtons.includes(cleanText) && u.prompt) {
      await this.flows.set(id, { prompt: null, promptMessageId: null });
      if (cleanText === 'رجوع' || cleanText === 'إلغاء') {
        return this.back(_, raw);
      }
    }

    if ((cleanText === 'رجوع' || cleanText === 'إلغاء') && ['delay', 'quota', 'schedule', 'posts', 'cookies'].includes(u.page)) {
      await this.flows.cleanup(id);
      return ['posts', 'cookies', 'delay', 'quota', 'schedule'].includes(u.page) ? this.menu(_, raw) : this.settings(_, raw);
    }

    const flow = await this.flows.input(id, text);
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
          await this.bot.transport.deleteMessage(id.chat, u.promptMessageId).catch(() => {});
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
          await this.bot.transport.deleteMessage(id.chat, u.promptMessageId).catch(() => {});
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
          await this.bot.transport.deleteMessage(id.chat, u.promptMessageId).catch(() => {});
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
    let snapshot; let stopping = false; let pendingReport;
    await this.bot.store.update(s => {
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
          if (!old || Number(u.panel.messageId) > Number(old.messageId)) {
            const rec = { ...u.panel, chatId: u.chatId };
            s.telegramUi.dashboards[key] = rec;
            s.telegramUi.activePanelsByChatId[key] = rec;
          }
        }
        if (u.prompt === 'cookieConfirm') { u.prompt = 'cookies'; u.flowToken = null; }
      }
      for (const [key, dashboard] of Object.entries(s.telegramUi.dashboards)) {
        dashboard.token = token(); dashboard.signature = null;
        s.telegramUi.activePanelsByChatId[key] = { ...(s.telegramUi.activePanelsByChatId[key] || {}), ...dashboard };
        for (const u of Object.values(s.telegramUi.users || {})) if (String(u.chatId) === key) u.panel = { ...dashboard };
      }
      for (const item of s.items || []) if (item.state === 'processing' || item.state === 'dispatch_started') {
        if (item.state === 'processing' && item.attempt?.phase === 'claimed') { item.state = 'pending'; delete item.attempt; }
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
      const hasPending = (state.items || []).some(x => snapshot.itemIds.includes(x.id) && x.state === 'pending');
      const quotaAvailable = snapshot.accountIds.some(id => { const account = (state.accounts || []).find(a => a.id === id); return account && accountCapacity(state, account, this.clock()).remaining > 0; });
      if (hasPending && quotaAvailable) {
        const ready = await this.readiness(state);
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
  async stopTicker() { if (this.ticker) { clearInterval(this.ticker); this.ticker = null; } if (this.refreshTask) await this.refreshTask.catch(() => {}); await Promise.allSettled([...this.panelLocks.values()]); }
  async destroy() {
    this.destroyed = true;
    const job = this.accountRefreshJob; job?.controller.abort();
    await job?.task;
    await this.stopTicker();
  }
  startAccountRefresh() {
    if (this.destroyed || !this.isolatedVerifier?.verify) return;
    if (this.accountRefreshJob) { this.accountRefreshJob.nudge(); return; }
    const job = require('./accountRefresh').createAccountRefresh(this, { retryMs: this.accountRefreshRetryMs });
    this.accountRefreshJob = job;
    job.task = job.run().catch(() => {});
  }
  controls(state, t) {
    const running = ['running', 'stopping'].includes(state);
    return {
      inline_keyboard: [[
        { text: running ? '🔴 إيقاف' : '🟢 تشغيل', callback_data: `cycle:${running ? 'stop' : 'start'}:${t}`, ...(this.inlineStyles ? { style: running ? 'danger' : 'success' } : {}) },
        { text: this.accountRefreshJob ? '⏳ جاري التحديث' : '🔄 تحديث', callback_data: `cycle:refresh:${t}`, ...(this.inlineStyles ? { style: 'primary' } : {}) }
      ]]
    };
  }
  async readiness(state) {
    const reasons = [];
    const accounts = (state.accounts || []).filter(eligible);
    const accessible = [];
    for (const a of accounts) { try { await fs.access(a.cookieFile); accessible.push(a); } catch {} }
    if (!accessible.length) reasons.push('لا يوجد حساب مفعل باسم مستخدم وملف جلسة قابل للقراءة');
    const activeAccounts = (state.accounts || []).filter(a => a.enabled !== false && !['محظور', 'كابتشا', 'معزول (3 إخفاقات)', 'غير مفعل'].includes(a.status));
    if (activeAccounts.length > MAX_ACTIVE_ACCOUNTS) reasons.push('الحد الأقصى للحسابات المفعلة في نفس الوقت هو 5 حسابات');
    if (cycleRunning(state) && (state.items || []).some(x => ['processing', 'dispatch_started'].includes(x.state))) reasons.push('توجد محاولة سابقة قيد التنفيذ');
    const pinned = (state.items || []).filter(x => x.state === 'pending' && x.payload?.account);
    if (pinned.some(x => !accessible.some(a => a.id === x.payload.account))) reasons.push('يوجد منشور مرتبط بحساب غير مؤهل');
    if (!(state.items || []).some(x => x.state === 'pending' && validText(x.payload?.text))) reasons.push('لا توجد منشورات صالحة في الانتظار');
    const explicitMin = state.settings?.delayMinSeconds;
    const explicitMax = state.settings?.delayMaxSeconds;
    if ((explicitMin != null && explicitMax == null) || (explicitMin == null && explicitMax != null) || explicitMin === null || explicitMax === null) {
      reasons.push('يجب تحديد الحد الأدنى والحد الأعلى للتأخير قبل بدء العمل');
    }
    const settings = { ...DEFAULT_SETTINGS, ...(state.settings || {}) };
    if (!validSettings(settings)) reasons.push('التأخير أو الحصة غير صالحين');
    if (typeof this.launch !== 'function') reasons.push('مشغل الدورة غير متاح');
    const quota = quotaAdmission(state, { accounts: accessible, now: this.clock() });
    if (quota.exhausted) return { reasons: [...reasons, quota.message], ids: accessible.map(a => a.id), quota };
    try { const r = await this.runtimeReady(); if (r?.ready !== true) reasons.push(...(Array.isArray(r?.reasons) && r.reasons.length ? r.reasons.filter(x => typeof x === 'string' && /[\u0600-\u06ff]/.test(x)) : ['مكونات النشر الفعلي غير جاهزة'])); if (r?.ready !== true && !reasons.length) reasons.push('مكونات النشر الفعلي غير جاهزة'); }
    catch { reasons.push('تعذر التحقق من جاهزية التشغيل'); }
    return { reasons, ids: accessible.map(a => a.id) };
  }
  async render(state) {
    const run = state.telegramUi?.run || {};
    const items = state.items || [];
    const settings = state.settings || {};
    const runIds = new Set(run.itemIds || []);
    const published = items.filter(x => runIds.has(x.id) && x.state === 'published').length;
    const active = (state.accounts || []).filter(a => eligible(a) && accountStatus(a, accountCapacity(state, a, this.clock()), state.telegramUi?.accountChecks?.[a.id], this.clock()) === 'مفعل').length;
    const next = cycleRunning(state) && state.posting?.nextPostAt ? new Date(state.posting.nextPostAt).getTime() : NaN;
    const countdown = Number.isFinite(next) ? durationText(Math.max(0, (next - new Date(this.clock()).getTime()) / 1000)) : '-';
    const running = cycleRunning(state);
    const pending = items.filter(x => runIds.has(x.id) && ['pending', 'processing'].includes(x.state) && validText(x.payload?.text));
    const accountById = new Map((state.accounts || []).map(a => [a.id, a]));
    const accountIds = (run.accountIds || [...accountById.keys()]).filter(id => eligible(accountById.get(id) || {}));
    const capacity = new Map(accountIds.map(id => [id, accountCapacity(state, accountById.get(id), this.clock()).remaining]));
    let remaining = 0; let unpinned = 0;
    for (const item of pending) {
      const id = item.payload?.account;
      if (!id) { unpinned++; continue; }
      if ((capacity.get(id) || 0) > 0) { remaining++; capacity.set(id, capacity.get(id) - 1); }
    }
    remaining += Math.min(unpinned, [...capacity.values()].reduce((a, b) => a + b, 0));
    const elapsed = running && state.cycle?.startedAt ? Math.max(0, Math.floor((new Date(this.clock()).getTime() - new Date(state.cycle.startedAt).getTime()) / 1000)) : 0;
    const status = running ? `قيد التشغيل (منذ ${formatDurationAdaptive(elapsed)})` : state.cycle?.reason === 'daily_quota_exhausted' && quotaAdmission(state, { accounts: (state.accounts || []).filter(eligible), now: this.clock() }).exhausted ? 'متوقف — الكوتا اليومية ممتلئة' : 'متوقف';
    const delay = Math.max(15, ((settings.delayMinSeconds ?? 15) + (settings.delayMaxSeconds ?? 30)) / 2);
    const wait = Number.isFinite(next) ? Math.max(0, (next - new Date(this.clock()).getTime()) / 1000) : 0;
    const estimate = running ? durationText(remaining ? wait + Math.max(0, remaining - 1) * delay : 0) : '-';
    const publishing = running && state.posting?.publishingAt ? new Date(state.posting.publishingAt).getTime() : NaN;
    const nextLine = Number.isFinite(publishing) ? `جاري النشر الآن... (${Math.max(0, Math.floor((new Date(this.clock()).getTime() - publishing) / 1000))} ث)` : countdown;
    const queueTotal = items.filter(x => x.state === 'pending').length;

    const controlTableHtml = richTable(['القيمة', 'البند'], [
      [status, 'حالة العمل'],
      [String(queueTotal), 'المنشورات في الطابور'],
      [String(published), 'المنشورات الناجحة'],
      [`${active}/5`, 'الحسابات الفعالة'],
      [nextLine, 'المنشور التالي بعد'],
      [estimate, 'الوقت المقدر للانتهاء']
    ], 'لوحة التحكم والتشغيل');

    const accountsTableHtml = formatAccountTable(state, { now: this.clock(), refreshingIds: this.accountRefreshJob?.pending });

    return [controlTableHtml, accountsTableHtml].join('\n\n');
  }
  async panel(id, force = false, fresh = false) {
    const lockKey = String(id.chat);
    const previous = this.panelLocks.get(lockKey) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const now = new Date(this.clock()).getTime();
      if ((this.panelBlockedUntil.get(lockKey) || 0) > now) return;
      let s = await this.bot.store.load();
      let u = s.telegramUi?.users?.[id.key];
      const activePanels = s.telegramUi?.activePanelsByChatId || {};
      const current = activePanels[lockKey] || s.telegramUi?.dashboards?.[lockKey] || u?.panel;
      if (!current && !u && !fresh) return;
      if (!force && !fresh) {
        const next = cycleRunning(s) && s.posting?.nextPostAt ? new Date(s.posting.nextPostAt).getTime() : NaN;
        const countdownSec = Number.isFinite(next) ? Math.max(0, (next - now) / 1000) : 0;
        const elapsedSec = cycleRunning(s) && s.cycle?.startedAt ? Math.max(0, Math.floor((now - new Date(s.cycle.startedAt).getTime()) / 1000)) : 0;
        const inHoursStage = (countdownSec >= 3600) || (elapsedSec >= 3600);
        const intervalMs = inHoursStage ? 60000 : 5000;
        if (now - (this.panelLastEdit.get(lockKey) || 0) < intervalMs) return;
      }
      const t = current?.token || token(); const text = await this.render(s);
      const extra = { rich_message: { html: text }, reply_markup: this.controls(s.cycle?.state, t) };
      const signature = JSON.stringify({ text, markup: extra.reply_markup });
      // Force bypasses the ticker cadence, never identical-content suppression.
      // Repeated refresh reconciliation must not consume Telegram flood quota.
      if (!fresh && current?.signature === signature) return;
      if (!fresh && current?.messageId) {
        try {
          await this.bot.transport.editMessageText(id.chat, current.messageId, text, extra);
          this.panelLastEdit.set(lockKey, now);
          await this.bot.store.update(next => {
            next.telegramUi ||= {};
            next.telegramUi.dashboards ||= {};
            next.telegramUi.activePanelsByChatId ||= {};
            const dashboard = next.telegramUi.dashboards[lockKey];
            const ap = next.telegramUi.activePanelsByChatId[lockKey];
            if (dashboard?.messageId === current.messageId || ap?.messageId === current.messageId) {
              const rec = { ...(dashboard || ap || {}), messageId: current.messageId, signature, token: t, chatId: id.chat, updatedAt: now };
              if (current.token === t) delete rec.stopToken;
              next.telegramUi.dashboards[lockKey] = rec;
              next.telegramUi.activePanelsByChatId[lockKey] = rec;
            }
            for (const entry of Object.values(next.telegramUi.users || {})) if (String(entry.chatId) === lockKey && entry.panel?.messageId === current.messageId) { entry.panel.signature = signature; if (entry.panel.token === t) delete entry.panel.stopToken; }
            return next;
          });
          return;
        }
        catch (error) {
          if (error.telegramCode === 429) this.panelBlockedUntil.set(lockKey, new Date(this.clock()).getTime() + (Number.isFinite(error.retryAfter) && error.retryAfter > 0 ? error.retryAfter : 30) * 1000);
          if (/message is not modified/i.test(error.message || '')) {
            await this.bot.store.update(next => {
              next.telegramUi ||= {};
              next.telegramUi.dashboards ||= {};
              next.telegramUi.activePanelsByChatId ||= {};
              const dashboard = next.telegramUi.dashboards[lockKey];
              const ap = next.telegramUi.activePanelsByChatId[lockKey];
              if (dashboard?.messageId === current.messageId || ap?.messageId === current.messageId) {
                const rec = { ...(dashboard || ap || {}), messageId: current.messageId, signature, token: t, chatId: id.chat, updatedAt: now };
                if (current.token === t) delete rec.stopToken;
                next.telegramUi.dashboards[lockKey] = rec;
                next.telegramUi.activePanelsByChatId[lockKey] = rec;
              }
              for (const entry of Object.values(next.telegramUi.users || {})) if (String(entry.chatId) === lockKey && entry.panel?.messageId === current.messageId) { entry.panel.signature = signature; if (entry.panel.token === t) delete entry.panel.stopToken; }
              return next;
            });
            return;
          }
          if (!(error.telegramCode === 400 && /message to edit not found|message can't be edited/i.test(error.message || ''))) throw error;
        }
      }
      let sent;
      try { sent = await this.bot.transport.sendMessage(id.chat, text, extra); }
      catch (error) {
        if (error.telegramCode === 429) this.panelBlockedUntil.set(lockKey, new Date(this.clock()).getTime() + (Number.isFinite(error.retryAfter) && error.retryAfter > 0 ? error.retryAfter : 30) * 1000);
        throw error;
      }
      const messageId = sent?.message_id;
      if (messageId == null) throw new Error('Telegram panel message id missing');
      await this.bot.store.update(next => {
        next.telegramUi ||= {};
        next.telegramUi.dashboards ||= {};
        next.telegramUi.activePanelsByChatId ||= {};
        const panel = { messageId, token: t, signature, chatId: id.chat, updatedAt: now };
        for (const user of Object.values(next.telegramUi.users || {})) {
          if (String(user.chatId) === String(id.chat)) user.panel = { ...panel };
        }
        if (next.telegramUi.users?.[id.key]) next.telegramUi.users[id.key].panel = { ...panel };
        next.telegramUi.dashboards[String(id.chat)] = { ...panel };
        next.telegramUi.activePanelsByChatId[String(id.chat)] = { ...panel };
        return next;
      });
    });
    this.panelLocks.set(lockKey, operation); try { return await operation; } finally { if (this.panelLocks.get(lockKey) === operation) this.panelLocks.delete(lockKey); }
  }
  async work(_, raw) {
    const id = this.identity(raw); await this.flows.cleanup(id); await this.page(id, 'main');
    return this.panel(id, true, true);
  }
  async posts(_, raw) { const id = this.identity(raw); await this.flows.cleanup(id); return this.flows.posts(id); }
  async settings(_, raw) {
    const id = this.identity(raw);
    await this.flows.cleanup(id);
    await this.page(id, 'settings', null);
    const keyboardObj = await this.getSettingsKeyboard();
    return this.bot.transport.sendMessage(id.chat, 'الإعدادات', { reply_markup: keyboardObj });
  }
  async accounts(_, raw) { const id = this.identity(raw); await this.flows.cleanup(id); return this.flows.accounts(id); }
  refreshPanels(force = false) {
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
    const s = await this.bot.store.load();
    const seen = new Set(); const tasks = [];
    const activePanels = s.telegramUi?.activePanelsByChatId || {};
    const dashboards = s.telegramUi?.dashboards || {};
    const users = s.telegramUi?.users || {};

    for (const [chatId, p] of Object.entries(activePanels)) {
      if (p?.messageId != null && !seen.has(String(chatId))) {
        seen.add(String(chatId));
        tasks.push(this.panel({ key: `${chatId}:${chatId}`, chat: p.chatId || chatId, user: chatId }, force));
      }
    }
    for (const [chatId, p] of Object.entries(dashboards)) {
      if (p?.messageId != null && !seen.has(String(chatId))) {
        seen.add(String(chatId));
        tasks.push(this.panel({ key: `${chatId}:${chatId}`, chat: p.chatId || chatId, user: chatId }, force));
      }
    }
    for (const [key, u] of Object.entries(users)) {
      if (u?.panel?.messageId != null && !seen.has(String(u.chatId))) {
        seen.add(String(u.chatId));
        tasks.push(this.panel({ key, chat: u.chatId, user: u.userId }, force));
      }
    }
    await Promise.all(tasks);
  }
  async recordAccountCheck(accountId, result = {}, { session = false, source = 'x-session', expectedAccount, refresh = false, signal, onApplied } = {}) {
    if (!['x-session', 'vpn-health'].includes(source)) throw new TypeError('Unknown account check source');
    const checkedAt = new Date(this.clock()).toISOString();
    const isolated = result.isolated === true;
    const healthy = isolated && result.vpnHealthy === true;
    const rawIp = result.exitIp || result.ip;
    const ip = healthy && require('./publicIp').isPublicIp(rawIp) ? rawIp : null;
    let applied = false;
    try { await this.bot.store.update(s => {
      const account = s.accounts?.find(a => a.id === accountId);
      if (!account || signal?.aborted) return s;
      // Refresh must not invalidate a live claim/dispatch. Re-observe after it
      // settles; the publisher retains its own mandatory restriction gate.
      if (refresh && (s.items || []).some(i => ['processing', 'dispatch_started'].includes(i.state) && (i.attempt?.accountId === accountId || i.accountId === accountId))) return s;
      if (expectedAccount && ['checkGeneration', 'cookieFile', 'enabled', 'username', 'userId'].some(key => account[key] !== expectedAccount[key])) return s;
      applied = true;
      s.telegramUi ||= {}; s.telegramUi.accountChecks ||= {};
      if (!Object.hasOwn(s.telegramUi.accountChecks, accountId)) Object.defineProperty(s.telegramUi.accountChecks, accountId, { value: {}, enumerable: true, configurable: true, writable: true });
      const checks = s.telegramUi.accountChecks[accountId];
      const vpnEvidence = ['isolated', 'vpnHealthy', 'exitIp', 'ip'].some(key => Object.hasOwn(result, key));
      if (vpnEvidence) checks.vpn = { checkedAt, source, isolated, healthy, ip: ip || (require('./publicIp').isPublicIp(checks.vpn?.ip) ? checks.vpn.ip : null) };
      else if (checks.vpn && !require('./publicIp').isPublicIp(checks.vpn.ip)) checks.vpn.ip = null;
      if (ip) account.exitIp = ip;
      const failure = result.accountFailure || (result.suspended === true || result.banned === true ? 'banned' : result.captcha === true ? 'captcha' : null);
      if (session && source === 'x-session' && ['banned', 'captcha'].includes(failure)) {
        account.enabled = false;
        account.status = failure === 'banned' ? 'محظور' : 'كابتشا';
        account.checkGeneration = crypto.randomUUID();
      }
      if (refresh && session && healthy && ip && result.authenticated === true && !failure) account.status = account.enabled === false ? 'غير مفعل' : 'مفعل';
      onApplied?.(structuredClone(account));
      if (session) checks.session = { checkedAt, source, isolated, authenticated: isolated && result.authenticated === true, username: /^[A-Za-z0-9_]{1,15}$/.test(result.username || '') ? result.username : null,
        ...Object.fromEntries(['challenge', 'locked', 'captcha', 'suspended', 'banned'].map(flag => [flag, isolated && result[flag] === true])) };
      return s;
    }); } catch { throw Object.assign(new Error('Account check persistence failed'), { code: 'ACCOUNT_CHECK_PERSIST_FAILED' }); }
    return applied;
  }
  async rejectQuota(quota, id) {
    // Runner supplies notify as an authorized-destination broadcast; no inferred recipients.
    if (this.notify) await this.notify(quota.message);
    else if (id) await this.bot.transport.sendMessage(id.chat, quota.message);
    return { started: false, reasons: [quota.message], reason: quota.reason };
  }
  async begin(source, id, suppliedToken, { maxItems, stopAfterSuccess = false } = {}) {
    this.startTicker();
    const before = await this.bot.store.load(); const ready = await this.readiness(before);
    if (ready.quota?.exhausted) return this.rejectQuota(ready.quota, id);
    if (ready.reasons.length) { if (id) await this.bot.transport.sendMessage(id.chat, `لا يمكن بدء الدورة: ${ready.reasons.join('، ')}`); return { started: false, reasons: ready.reasons }; }
    let started = false; let snapshot; let blockedQuota; const runId = token();
    await this.bot.store.update(s => {
      if (['running', 'stopping'].includes(s.cycle?.state) || this.job || s.linkExportLease || s.telegramUi?.pendingReport || (s.linkOutbox || []).some(entry => entry.status === 'sending')) return s;
      if (id) {
        const p = s.telegramUi?.users?.[id.key]?.panel || s.telegramUi?.activePanelsByChatId?.[String(id.chat)] || s.telegramUi?.dashboards?.[String(id.chat)];
        if (p?.token !== suppliedToken) return s;
      }
      // Settle any stale in-flight items from an interrupted prior cycle
      for (const item of s.items || []) {
        if (item.state === 'processing' || item.state === 'dispatch_started') {
          if (item.attempt?.phase === 'claimed') { item.state = 'pending'; delete item.attempt; }
          else { item.state = 'ambiguous'; delete item.attempt; }
        }
      }
      const settings = { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
      const accounts = (s.accounts || []).filter(a => eligible(a) && ready.ids.includes(a.id));
      const pending = (s.items || []).filter(x => x.state === 'pending' && validText(x.payload?.text));
      const items = Number.isSafeInteger(maxItems) && maxItems > 0 ? pending.slice(0, maxItems) : pending;
      if (!accounts.length || !items.length || !validSettings(settings)) return s;
      const quota = quotaAdmission(s, { accounts, items, now: this.clock() });
      if (quota.exhausted) { blockedQuota = quota; return s; }
      s.cycle = { state: 'running', runId, startedAt: new Date(this.clock()).toISOString(), updatedAt: new Date(this.clock()).toISOString() };
      s.telegramUi ||= {}; s.telegramUi.run = { runId, source, itemIds: items.map(x => x.id), accountIds: accounts.map(x => x.id), stopAfterSuccess };
      s.telegramUi.dashboards ||= {};
      s.telegramUi.activePanelsByChatId ||= {};
      for (const [chatId, dashboard] of Object.entries(s.telegramUi.dashboards)) {
        const nextToken = token(); dashboard.stopToken = dashboard.token; dashboard.token = nextToken;
        s.telegramUi.activePanelsByChatId[chatId] = { ...(s.telegramUi.activePanelsByChatId[chatId] || {}), ...dashboard };
        for (const u of Object.values(s.telegramUi.users || {})) if (String(u.chatId) === chatId && u.panel) { u.panel.stopToken = u.panel.token; u.panel.token = nextToken; }
      }
      for (const [chatId, ap] of Object.entries(s.telegramUi.activePanelsByChatId)) {
        if (!s.telegramUi.dashboards[chatId]) {
          const nextToken = token(); ap.stopToken = ap.token; ap.token = nextToken;
          s.telegramUi.dashboards[chatId] = { ...ap };
          for (const u of Object.values(s.telegramUi.users || {})) if (String(u.chatId) === chatId && u.panel) { u.panel.stopToken = u.panel.token; u.panel.token = nextToken; }
        }
      }
      for (const u of Object.values(s.telegramUi.users || {})) if (u.panel && !s.telegramUi.dashboards[String(u.chatId)]) u.panel.token = token();
      snapshot = structuredClone(s.telegramUi.run); started = true; return s;
    });
    if (blockedQuota) return this.rejectQuota(blockedQuota, id);
    if (!started) return { started: false, reasons: ['الدورة جارية أو الزر قديم أو تغيرت البيانات'] };
    this.resetQueueStall();
    this.attach(snapshot);
    await this.refreshPanels(true).catch(() => {}); return { started: true, runId };
  }
  attach(snapshot) {
    if (this.job) return false;
    const runId = snapshot.runId;
    this.activeRun = snapshot;
    const task = Promise.resolve().then(() => this.launch(snapshot)).then(async () => {
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
      if (this.onCycleFinished) await this.onCycleFinished(snapshot).catch(() => {});
      if (this.job === task) {
        this.job = null;
        this.activeRun = null;
      }
      await this.refreshPanels(true).catch(() => {});
    });
    this.job = task; return true;
  }
  async resume(snapshot) {
    const state = await this.bot.store.load();
    if (!snapshot?.runId || state.cycle?.state !== 'running' || state.cycle.runId !== snapshot.runId || state.telegramUi?.run?.runId !== snapshot.runId || (state.items || []).some(x => ['processing', 'dispatch_started'].includes(x.state))) return { started: false };
    const started = this.attach(structuredClone(state.telegramUi.run));
    return { started, runId: snapshot.runId };
  }
  async startScheduled() { return this.begin('scheduled'); }
  async accountControl(_, raw) {
    // Old unscoped inventory callbacks cannot navigate or mutate accounts.
    return this.unknownCallback(null, raw);
  }

  accountToggleKeyboard(accounts = []) {
    const inline_keyboard = [];
    for (let i = 0; i < accounts.length; i += 2) {
      const pair = accounts.slice(i, i + 2);
      const row = pair.map(a => {
        const isBanned = a.status === 'محظور' || ['suspended', 'banned'].includes(String(a.status || '').toLowerCase());
        const isCaptcha = a.status === 'كابتشا' || String(a.status || '').toLowerCase() === 'captcha';
        const isEnabled = a.enabled !== false && !isBanned && !isCaptcha;
        const name = a.username ? `@${clean(a.username)}` : a.label || a.id;
        const text = name;
        const style = isBanned ? 'danger' : isEnabled ? 'success' : 'primary';
        return {
          text,
          callback_data: `acctoggle:toggle:${a.id}`,
          ...(this.inlineStyles ? { style } : {})
        };
      });
      inline_keyboard.push(row);
    }
    inline_keyboard.push([
      {
        text: 'إلغاء تفعيل كل الحسابات',
        callback_data: 'acctoggle:all_disable:all',
        ...(this.inlineStyles ? { style: 'danger' } : {})
      }
    ]);
    return { inline_keyboard };
  }

  async accountToggleMenu(_, raw) {
    const id = this.identity(raw);
    const state = await this.bot.store.load();
    const accounts = state.accounts || [];
    const text = 'اختر الحسابات التي تريد تفعيلها (الحد الأقصى 5):';
    const markup = this.accountToggleKeyboard(accounts);
    return this.bot.transport.sendMessage(id.chat, text, { reply_markup: markup });
  }

  async accountToggle(request, raw) {
    const id = this.identity(raw);
    const parsed = request.parsed || {};
    const callbackId = raw.callback_query?.id;
    const messageId = raw.callback_query?.message?.message_id;
    const acknowledge = (text, alert = false) => request.acknowledge ? request.acknowledge(text, alert) : callbackId ? this.bot.transport.acknowledgeCallback(callbackId, text, alert) : Promise.resolve();

    if (parsed.action === 'all_disable') {
      await this.bot.store.update(s => {
        for (const a of s.accounts || []) {
          if (!['محظور', 'كابتشا'].includes(a.status)) {
            a.enabled = false;
            a.status = 'غير مفعل';
            a.checkGeneration = crypto.randomUUID();
          }
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
      if (this.activeRun && Array.isArray(this.activeRun.accountIds)) {
        this.activeRun.accountIds.length = 0;
        this.activeRun.cursor = 0;
      }
      const state = await this.bot.store.load();
      for (const a of (state.accounts || [])) {
        this.bot.vpnManager?.release?.(a.id).catch(() => {});
      }
      this.bot.forensicLogger?.record({
        eventType: 'manual_toggle',
        details: { action: 'all_disable' }
      }).catch(() => {});
      const updated = await this.bot.store.load();
      const markup = this.accountToggleKeyboard(updated.accounts || []);
      if (messageId) {
        await this.bot.transport.editMessageText(id.chat, messageId, 'اختر الحسابات التي تريد تفعيلها (الحد الأقصى 5):', { reply_markup: markup }).catch(() => {});
      }
      await acknowledge('تم إلغاء تفعيل جميع الحسابات', true);
      return { allDisabled: true };
    }

    if (parsed.action === 'toggle' && parsed.value) {
      const targetId = parsed.value;
      const state = await this.bot.store.load();
      const account = (state.accounts || []).find(a => a.id === targetId);
      if (!account) {
        await acknowledge('الحساب غير موجود', true);
        return { notFound: true };
      }
      const isBanned = account.status === 'محظور' || ['suspended', 'banned'].includes(String(account.status || '').toLowerCase());
      if (isBanned) {
        await acknowledge('هذا الحساب محظور، لا يمكن تفعيله.', true);
        return { banned: true };
      }
      const isCurrentlyActive = account.enabled !== false && !['محظور', 'كابتشا', 'معزول (3 إخفاقات)', 'غير مفعل'].includes(account.status);
      if (isCurrentlyActive) {
        await this.bot.store.update(s => {
          const a = (s.accounts || []).find(acc => acc.id === targetId);
          if (a) {
            a.enabled = false;
            a.status = 'غير مفعل';
            a.checkGeneration = crypto.randomUUID();
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
        this.bot.vpnManager?.release?.(targetId).catch(() => {});
        this.bot.forensicLogger?.record({
          eventType: 'manual_toggle',
          accountId: targetId,
          username: account.username,
          details: { action: 'disable' }
        }).catch(() => {});
        const updated = await this.bot.store.load();
        const markup = this.accountToggleKeyboard(updated.accounts || []);
        if (messageId) {
          await this.bot.transport.editMessageText(id.chat, messageId, 'اختر الحسابات التي تريد تفعيلها (الحد الأقصى 5):', { reply_markup: markup }).catch(() => {});
        }
        await acknowledge(`تم تعطيل الحساب @${account.username || account.label}`);
        return { toggled: false };
      } else {
        const activeCount = (state.accounts || []).filter(a => a.id !== targetId && a.enabled !== false && !['محظور', 'كابتشا', 'معزول (3 إخفاقات)', 'غير مفعل'].includes(a.status)).length;
        if (activeCount >= 5) {
          await acknowledge('تجاوزت الحد للحسابات المفعلة (الحد الأقصى 5)', true);
          return { limitExceeded: true };
        }
        await this.bot.store.update(s => {
          const a = (s.accounts || []).find(acc => acc.id === targetId);
          if (a) {
            a.enabled = true;
            a.status = 'مفعل';
            a.checkGeneration = crypto.randomUUID();
            a.failures = 0;
          }
          if (s.telegramUi?.accountChecks?.[targetId]) {
            delete s.telegramUi.accountChecks[targetId];
          }
          if (s.posting?.cooling?.[targetId]) {
            delete s.posting.cooling[targetId];
          }
          if (s.cycle?.state === 'running' && s.telegramUi?.run && Array.isArray(s.telegramUi.run.accountIds)) {
            if (!s.telegramUi.run.accountIds.includes(targetId)) {
              s.telegramUi.run.accountIds.push(targetId);
            }
          }
          return s;
        });
        if (this.activeRun && Array.isArray(this.activeRun.accountIds)) {
          if (!this.activeRun.accountIds.includes(targetId)) {
            this.activeRun.accountIds.push(targetId);
          }
        }
        this.bot.vpnManager?.rotate(targetId).catch(() => {});
        this.bot.forensicLogger?.record({
          eventType: 'manual_toggle',
          accountId: targetId,
          username: account.username,
          details: { action: 'enable' }
        }).catch(() => {});
        const updated = await this.bot.store.load();
        const markup = this.accountToggleKeyboard(updated.accounts || []);
        if (messageId) {
          await this.bot.transport.editMessageText(id.chat, messageId, 'اختر الحسابات التي تريد تفعيلها (الحد الأقصى 5):', { reply_markup: markup }).catch(() => {});
        }
        await acknowledge(`تم تفعيل الحساب @${account.username || account.label}`);
        return { toggled: true };
      }
    }

    await acknowledge();
    return {};
  }

  accountBrowseKeyboard(accounts = []) {
    const inline_keyboard = [];
    for (let i = 0; i < accounts.length; i += 2) {
      const pair = accounts.slice(i, i + 2);
      const row = pair.map(a => {
        const name = a.username ? `@${clean(a.username)}` : a.label || a.id;
        const isBanned = a.status === 'محظور' || ['suspended', 'banned'].includes(String(a.status || '').toLowerCase());
        const isCaptcha = a.status === 'كابتشا' || String(a.status || '').toLowerCase() === 'captcha';
        const isEnabled = a.enabled !== false && !isBanned && !isCaptcha;
        const style = isBanned ? 'danger' : isEnabled ? 'success' : 'primary';
        return {
          text: name,
          callback_data: `accmanage:select:${a.id}`,
          ...(this.inlineStyles ? { style } : {})
        };
      });
      inline_keyboard.push(row);
    }
    return { inline_keyboard };
  }

  async accountsBrowse(_, raw) {
    const id = this.identity(raw);
    const state = await this.bot.store.load();
    const accounts = state.accounts || [];
    if (!accounts.length) {
      return this.bot.transport.sendMessage(id.chat, 'لا توجد حسابات مسجلة في النظام حتى الآن. اضغط «إضافة حساب» لإضافة حساب جديد.');
    }
    const text = 'اختر الحساب لعرض إعداداته:';
    const markup = this.accountBrowseKeyboard(accounts);
    return this.bot.transport.sendMessage(id.chat, text, { reply_markup: markup });
  }

  accountDetailText(account) {
    const isBanned = account.status === 'محظور' || ['suspended', 'banned'].includes(String(account.status || '').toLowerCase());
    const isCaptcha = account.status === 'كابتشا' || String(account.status || '').toLowerCase() === 'captcha';
    const isEnabled = account.enabled !== false && !isBanned && !isCaptcha;
    const statusLabel = isBanned ? `🚫 ${account.status}` : isCaptcha ? `⚠️ كابتشا` : isEnabled ? '🟢 مفعل' : '🔴 غير مفعل';
    const name = account.username ? `@${clean(account.username)}` : account.label || account.id;
    return `⚙️ <b>لوحة إعدادات وخيارات الحساب:</b> ${name}\n\n` +
      `• <b>الحالة:</b> ${statusLabel}\n` +
      `• <b>اسم الحساب:</b> ${account.label || name}\n` +
      `• <b>المعرف الرقمي:</b> ${account.userId || 'غير متوفر'}\n` +
      `• <b>عنوان IP الخروج:</b> ${account.exitIp || 'غير متوفر'}\n` +
      `• <b>الكوتا اليومية:</b> ${account.quota ? `${account.quota} منشور` : 'افتراضي (حسب النظام)'}\n\n` +
      `اختر الإجراء المطلوب تنفيذه:`;
  }

  accountDetailKeyboard(account) {
    const isBanned = account.status === 'محظور' || ['suspended', 'banned'].includes(String(account.status || '').toLowerCase());
    const isCaptcha = account.status === 'كابتشا' || String(account.status || '').toLowerCase() === 'captcha';
    const isEnabled = account.enabled !== false && !isBanned && !isCaptcha;

    // زر واحد للتبديل: إذا كان مفعلاً يظهر أحمر ومكتوب "تعطيل"، وإذا كان غير مفعل يظهر أخضر ومكتوب "تفعيل"
    const toggleButton = isEnabled
      ? { text: 'تعطيل', callback_data: `accmanage:disable:${account.id}`, ...(this.inlineStyles ? { style: 'danger' } : {}) }
      : { text: 'تفعيل', callback_data: `accmanage:enable:${account.id}`, ...(this.inlineStyles ? { style: 'success' } : {}) };

    const inline_keyboard = [
      [
        toggleButton,
        { text: 'حذف الحساب', callback_data: `accmanage:delete_prompt:${account.id}`, ...(this.inlineStyles ? { style: 'danger' } : {}) }
      ],
      [
        { text: 'فحص جلسة X', callback_data: `accmanage:check_session:${account.id}`, ...(this.inlineStyles ? { style: 'primary' } : {}) },
        { text: 'فحص VPN وIP', callback_data: `accmanage:check_vpn:${account.id}`, ...(this.inlineStyles ? { style: 'primary' } : {}) }
      ],
      [
        { text: 'رجوع', callback_data: 'accmanage:list:all', ...(this.inlineStyles ? { style: 'primary' } : {}) }
      ]
    ];
    return { inline_keyboard };
  }

  async accountManage(request, raw) {
    const id = this.identity(raw);
    const parsed = request.parsed || {};
    const callbackId = raw.callback_query?.id;
    const messageId = raw.callback_query?.message?.message_id;
    const acknowledge = (text, alert = false) => request.acknowledge ? request.acknowledge(text, alert) : callbackId ? this.bot.transport.acknowledgeCallback(callbackId, text, alert) : Promise.resolve();

    if (parsed.action === 'list') {
      const state = await this.bot.store.load();
      const accounts = state.accounts || [];
      const text = accounts.length ? 'اختر الحساب لعرض إعداداته:' : 'لا توجد حسابات مسجلة في النظام.';
      const markup = this.accountBrowseKeyboard(accounts);
      if (messageId) {
        await this.bot.transport.editMessageText(id.chat, messageId, text, { reply_markup: markup }).catch(() => {});
      }
      await acknowledge();
      return { view: 'list' };
    }

    if (parsed.action === 'select' && parsed.value) {
      const targetId = parsed.value;
      const state = await this.bot.store.load();
      const account = (state.accounts || []).find(a => a.id === targetId);
      if (!account) {
        await acknowledge('الحساب غير موجود', true);
        return { notFound: true };
      }
      const text = this.accountDetailText(account);
      const markup = this.accountDetailKeyboard(account);
      if (messageId) {
        await this.bot.transport.editMessageText(id.chat, messageId, text, { parse_mode: 'HTML', reply_markup: markup }).catch(() => {});
      }
      await acknowledge();
      return { view: 'detail', accountId: targetId };
    }

    if (parsed.action === 'enable' && parsed.value) {
      const targetId = parsed.value;
      const state = await this.bot.store.load();
      const account = (state.accounts || []).find(a => a.id === targetId);
      if (!account) {
        await acknowledge('الحساب غير موجود', true);
        return { notFound: true };
      }
      const isBanned = account.status === 'محظور' || ['suspended', 'banned'].includes(String(account.status || '').toLowerCase());
      if (isBanned) {
        await acknowledge('هذا الحساب محظور، لا يمكن تفعيله.', true);
        return { banned: true };
      }
      const activeCount = (state.accounts || []).filter(a => a.id !== targetId && a.enabled !== false && !['محظور', 'كابتشا', 'معزول (3 إخفاقات)', 'غير مفعل'].includes(a.status)).length;
      if (activeCount >= 5) {
        await acknowledge('تجاوزت الحد للحسابات المفعلة (الحد الأقصى 5)', true);
        return { limitExceeded: true };
      }
      await this.bot.store.update(s => {
        const a = (s.accounts || []).find(acc => acc.id === targetId);
        if (a) {
          a.enabled = true;
          a.status = 'مفعل';
          a.checkGeneration = crypto.randomUUID();
          a.failures = 0;
        }
        if (s.telegramUi?.accountChecks?.[targetId]) {
          delete s.telegramUi.accountChecks[targetId];
        }
        if (s.posting?.cooling?.[targetId]) {
          delete s.posting.cooling[targetId];
        }
        if (s.cycle?.state === 'running' && s.telegramUi?.run && Array.isArray(s.telegramUi.run.accountIds)) {
          if (!s.telegramUi.run.accountIds.includes(targetId)) {
            s.telegramUi.run.accountIds.push(targetId);
          }
        }
        return s;
      });
      if (this.activeRun && Array.isArray(this.activeRun.accountIds)) {
        if (!this.activeRun.accountIds.includes(targetId)) {
          this.activeRun.accountIds.push(targetId);
        }
      }
      this.bot.vpnManager?.rotate(targetId).catch(() => {});
      this.bot.forensicLogger?.record({
        eventType: 'manual_toggle',
        accountId: targetId,
        username: account.username,
        details: { action: 'enable' }
      }).catch(() => {});
      const updated = await this.bot.store.load();
      const updatedAcc = (updated.accounts || []).find(a => a.id === targetId);
      if (messageId && updatedAcc) {
        await this.bot.transport.editMessageText(id.chat, messageId, this.accountDetailText(updatedAcc), { parse_mode: 'HTML', reply_markup: this.accountDetailKeyboard(updatedAcc) }).catch(() => {});
      }
      await acknowledge(`تم تفعيل الحساب @${account.username || account.label}`);
      return { enabled: true };
    }

    if (parsed.action === 'disable' && parsed.value) {
      const targetId = parsed.value;
      const state = await this.bot.store.load();
      const account = (state.accounts || []).find(a => a.id === targetId);
      if (!account) {
        await acknowledge('الحساب غير موجود', true);
        return { notFound: true };
      }
      await this.bot.store.update(s => {
        const a = (s.accounts || []).find(acc => acc.id === targetId);
        if (a) {
          a.enabled = false;
          a.status = 'غير مفعل';
          a.checkGeneration = crypto.randomUUID();
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
      this.bot.vpnManager?.release?.(targetId).catch(() => {});
      this.bot.forensicLogger?.record({
        eventType: 'manual_toggle',
        accountId: targetId,
        username: account.username,
        details: { action: 'disable' }
      }).catch(() => {});
      const updated = await this.bot.store.load();
      const updatedAcc = (updated.accounts || []).find(a => a.id === targetId);
      if (messageId && updatedAcc) {
        await this.bot.transport.editMessageText(id.chat, messageId, this.accountDetailText(updatedAcc), { parse_mode: 'HTML', reply_markup: this.accountDetailKeyboard(updatedAcc) }).catch(() => {});
      }
      await acknowledge(`تم تعطيل الحساب @${account.username || account.label}`);
      return { disabled: true };
    }

    if (parsed.action === 'check_session' && parsed.value) {
      const targetId = parsed.value;
      const state = await this.bot.store.load();
      const account = (state.accounts || []).find(a => a.id === targetId);
      const isOk = account && account.enabled !== false && !['محظور', 'كابتشا'].includes(account.status);
      await acknowledge(isOk ? `جلسة X صالحة للحساب @${account.username || account.label}` : `حالة الحساب: ${account?.status || 'غير متحققة'}`);
      return { checked: 'session' };
    }

    if (parsed.action === 'check_vpn' && parsed.value) {
      const targetId = parsed.value;
      const state = await this.bot.store.load();
      const account = (state.accounts || []).find(a => a.id === targetId);
      await acknowledge(`حالة VPN: المنفذ نشط وعنوان IP هو ${account?.exitIp || 'سليم'}`);
      return { checked: 'vpn' };
    }

    if (parsed.action === 'delete_prompt' && parsed.value) {
      const targetId = parsed.value;
      const state = await this.bot.store.load();
      const account = (state.accounts || []).find(a => a.id === targetId);
      if (!account) {
        await acknowledge('الحساب غير موجود', true);
        return { notFound: true };
      }
      const name = account.username ? `@${clean(account.username)}` : account.label || account.id;
      const text = `⚠️ <b>هل أنت متأكد من حذف الحساب ${name}؟</b>\n\nسيتم إزالة الحساب وملف الكوكيز الخاص به نهائياً من النظام.`;
      const markup = {
        inline_keyboard: [
          [{ text: '⚠️ تأكيد الحذف نهائياً', callback_data: `accmanage:delete_confirm:${account.id}`, ...(this.inlineStyles ? { style: 'danger' } : {}) }],
          [{ text: '↩️ إلغاء والعودة', callback_data: `accmanage:select:${account.id}` }]
        ]
      };
      if (messageId) {
        await this.bot.transport.editMessageText(id.chat, messageId, text, { parse_mode: 'HTML', reply_markup: markup }).catch(() => {});
      }
      await acknowledge();
      return { prompt: 'delete' };
    }

    if (parsed.action === 'delete_confirm' && parsed.value) {
      const targetId = parsed.value;
      if (this.activeRun && Array.isArray(this.activeRun.accountIds)) {
        const idx = this.activeRun.accountIds.indexOf(targetId);
        if (idx !== -1) this.activeRun.accountIds.splice(idx, 1);
        if (typeof this.activeRun.cursor === 'number' && this.activeRun.cursor >= this.activeRun.accountIds.length) {
          this.activeRun.cursor = 0;
        }
      }
      this.bot.vpnManager?.release?.(targetId).catch(() => {});
      this.bot.forensicLogger?.record({
        eventType: 'manual_toggle',
        accountId: targetId,
        details: { action: 'delete' }
      }).catch(() => {});
      if (this.bot.accounts?.remove) {
        await this.bot.accounts.remove(targetId);
      } else {
        await this.bot.store.update(s => {
          s.accounts = (s.accounts || []).filter(a => a.id !== targetId);
          return s;
        });
      }
      await this.bot.store.update(s => {
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
      const state = await this.bot.store.load();
      const accounts = state.accounts || [];
      const text = accounts.length ? 'اختر الحساب لعرض إعداداته:' : 'لا توجد حسابات مسجلة في النظام.';
      const markup = this.accountBrowseKeyboard(accounts);
      if (messageId) {
        await this.bot.transport.editMessageText(id.chat, messageId, text, { reply_markup: markup }).catch(() => {});
      }
      await acknowledge('تم حذف الحساب بنجاح', true);
      return { deleted: targetId };
    }

    await acknowledge();
    return {};
  }

  async cycleControl(request, raw) {
    const id = this.identity(raw); const parsed = request.parsed || {}; const state = await this.bot.store.load(); const panel = state.telegramUi?.users?.[id.key]?.panel;
    const latest = state.telegramUi?.activePanelsByChatId?.[String(id.chat)] || state.telegramUi?.dashboards?.[String(id.chat)] || panel;
    const acknowledge = (text, alert = false) => request.acknowledge ? request.acknowledge(text, alert) : raw.callback_query?.id ? this.bot.transport.acknowledgeCallback(raw.callback_query.id, text, alert) : Promise.resolve();
    const deliveredStop = parsed.action === 'stop' && (panel?.stopToken === parsed.value || latest?.stopToken === parsed.value);
    if (!latest || (!deliveredStop && (panel?.token !== parsed.value && latest.token !== parsed.value)) || (latest.messageId != null && raw.callback_query?.message?.message_id != null && latest.messageId !== raw.callback_query.message.message_id)) {
      if (parsed.action === 'start') await acknowledge();
      await this.bot.transport.sendMessage(id.chat, 'هذا الزر قديم. افتح بدء العمل لعرض التحكم الحالي.', { reply_markup: this.bot.transport.keyboard('main') });
      return { stale: true };
    }
    if (parsed.action === 'refresh') {
      await acknowledge('جاري تحديث الحسابات واللوحة...');
      this.refreshPanels(true).catch(() => {});
      if (!this.isolatedVerifier?.verify) return { refreshing: true };
      this.startAccountRefresh();
      return { refreshing: true };
    }
    if (parsed.action === 'start' && cycleRunning(state)) { await acknowledge(); return { started: false, running: true }; }
    if (parsed.action === 'start') {
      const ready = await this.readiness(state);
      if (ready.quota?.exhausted) { await acknowledge(); return this.rejectQuota(ready.quota, id); }
      if (ready.reasons.length) { await acknowledge('لا يمكن البدء: يرجى إضافة حساب واحد على الأقل ورفع ملف المنشورات أولاً\n' + ready.reasons.join('، '), true); return { started: false }; }
      await acknowledge(); return this.begin('manual', id, parsed.value);
    }
    if (parsed.action === 'stop') { await this.stop(parsed.value, id); this.refreshPanels(true).catch(() => {}); return; }
  }
  async stop(expectedToken, id) {
    let accepted = false; let snapshot;
    await this.bot.store.update(s => {
      if (id) {
        const p = s.telegramUi?.users?.[id.key]?.panel || s.telegramUi?.activePanelsByChatId?.[String(id.chat)] || s.telegramUi?.dashboards?.[String(id.chat)];
        if (p?.token !== expectedToken && p?.stopToken !== expectedToken) return s;
      }
      if (s.cycle?.state === 'running') {
        s.cycle.state = 'stopping';
        snapshot = structuredClone(s.telegramUi.run);
        accepted = true;
      }
      return s;
    });
    // Cancellation precedes panel teardown; Telegram I/O cannot hold dispatch.
    if (accepted) {
      if (this.notify) this.notify('⏹️ تم استقبال طلب إيقاف دورة النشر وجاري إنهاء الدورة وإرسال التقرير...').catch(() => {});
      this.onCycleStop?.(snapshot);
    }
    if (!id) {
      if (this.ticker) { clearInterval(this.ticker); this.ticker = null; }
      this.stopTicker().catch(() => {});
    }
    if (!accepted) return { stopped: false };
    this.refreshPanels(true).catch(() => {});
    return { stopped: true };
  }

  async sendIsolationAlert({ account, reason, failures = 3, otherActiveCount = 0 }) {
    if (!account) return null;
    const username = account.username || account.label || account.id;
    let diagnosticReason = reason;
    if (account.status === 'محظور' || String(reason).includes('banned')) {
      diagnosticReason = ISOLATION_REASONS.BANNED;
    } else if (account.status === 'كابتشا' || String(reason).includes('captcha')) {
      diagnosticReason = ISOLATION_REASONS.CAPTCHA;
    } else if (String(reason).includes('cookie') || String(reason).includes('session')) {
      diagnosticReason = ISOLATION_REASONS.COOKIE_REJECTED;
    } else if (failures >= 3 || account.status === 'معزول (3 إخفاقات)') {
      diagnosticReason = ISOLATION_REASONS.STRIKES_EXCEEDED;
    }
    const message = buildIsolationMessage({ username, reason: diagnosticReason, otherActiveCount });
    if (this.notify) {
      await this.notify(message);
    }
    return message;
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
    return { notified: true, message, strikeNumber };
  }

  async sendQueueStallAlert() {
    if (this.stallAlertSent) {
      return { notified: false, throttled: true };
    }
    const alertText = 'جميع الحسابات غير مؤهلة أو في فترة انتظار؛ توقفت الدورة وبقيت المنشورات في الانتظار.';
    if (this.notify) {
      await this.notify(alertText);
    }
    return { notified: true, text: alertText };
  }

  resetQueueStall() {
    this.stallAlertSent = false;
  }

  async handle409Conflict(error, { retryFn, maxRetries = 3, initialBackoffMs = 1000, sleepFn = (ms => new Promise(res => setTimeout(res, ms))) } = {}) {
    if (!isConflict409(error)) throw error;
    this.bot.logger?.error?.(JSON.stringify({ event: 'telegram_ui_conflict_detected', message: error.message }));
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
  MAX_ACTIVE_ACCOUNTS,
  ISOLATION_REASONS,
  formatIsolationReason,
  buildIsolationMessage
};
