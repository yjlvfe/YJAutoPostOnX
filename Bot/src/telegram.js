'use strict';

// Reply keyboards are navigation only. Cycle commands belong to a separately
// scoped inline panel, never to /start or a persistent bottom-row button.
const { AsyncLocalStorage } = require('node:async_hooks');
const navigationContext = new AsyncLocalStorage();
const BUTTONS = Object.freeze({ work: 'بدء العمل', accounts: 'إدارة الحسابات', settings: 'الإعدادات' });
// All reply navigation is themed; labels remain unchanged for exact routing.
const MENU_BUTTON_STYLES = Object.freeze({
  [BUTTONS.work]: 'success',
  'الرئيسية': 'success', 'القائمة الرئيسية': 'success',
  'تفعيل': 'success', 'تفعيل الجدولة': 'success',
  'الحسابات': 'primary', 'تفعيل / إلغاء تفعيل': 'primary',
  'تعطيل': 'danger', 'حذف الحساب': 'danger', 'تعطيل الجدولة': 'danger', 'إلغاء تفعيل كل الحسابات': 'danger'
});
const ACTIONS = Object.freeze({
  [BUTTONS.work]: 'work', [BUTTONS.settings]: 'settings', 'تصدير الروابط': 'exportLinks',
  '/start': 'menu', '/menu': 'menu', '/status': 'work', '/report': 'report',
  'الرئيسية': 'menu', 'القائمة الرئيسية': 'menu', 'رجوع': 'back', 'العودة': 'back', 'رجوع للقائمة': 'back', 'إلغاء': 'back',
  'إدارة الحسابات': 'accounts', '/accounts': 'accounts',
  'الحسابات': 'accountsBrowse', '/accounts_list': 'accountsBrowse',
  'تفعيل / إلغاء تفعيل': 'accountToggleMenu', 'تفعيل أو تعطيل': 'accountToggleMenu',
  '/account_toggle_menu': 'accountToggleMenu',
  'الجدولة': 'scheduleMenu', 'التأخير': 'delayMenu', 'الحصص': 'quotaMenu',
  '/account_add': 'accountAdd', '/account_remove': 'accountRemove',
  '/account_username': 'accountUsername', '/account_toggle': 'accountToggle',
  '/accounts_csv': 'accountsCsv', '/cookie': 'cookie', '/cookie_verify': 'cookieVerify',
  '/delay': 'delay', '/quota': 'quota', '/schedule': 'schedule',
  // Retained text can arrive from a client's obsolete reply keyboard. It opens
  // the panel but must never start or stop work implicitly.
  'الحالة': 'work', 'بدء الدورة': 'work', 'إيقاف الدورة': 'work'
});
const PAGES = Object.freeze({
  main: [[BUTTONS.settings, BUTTONS.accounts, BUTTONS.work]],
  settings: [['التأخير', 'الجدولة', 'الحصص'], ['تصدير الروابط'], ['رجوع']],
  input: [['رجوع']],
  accounts: [['الحسابات', 'تفعيل / إلغاء تفعيل', 'رجوع']],
  account: [['تفعيل', 'تعطيل', 'تعديل الاسم'], ['فحص جلسة X', 'فحص VPN وIP', 'حذف الحساب'], ['رجوع']],
  waiting: [['رجوع']], confirm: [['رجوع']],
  schedule: [['تفعيل الجدولة', 'تعطيل الجدولة', 'تحديد الموعد'], ['رجوع']],
  delay: [['الحد الأدنى', 'الحد الأعلى'], ['رجوع']], quota: [['رجوع']]
});

function normalizeNavigationText(text) {
  return String(text || '').replace(/[\uFEFF\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim()
    .replace(/^(?:(?:🚀|📊|➕|📝|⚙️?|🔙|↩️?)\s*)+/u, '')
    .replace(/(?:\s*(?:🚀|📊|➕|📝|⚙️?|🔙|↩️?))+$/u, '').trim();
}
function commandParts(text) {
  const raw = String(text || '').trim();
  if (!raw.startsWith('/')) return null;
  const parts = raw.split(/\s+/);
  const commandToken = parts.shift();
  const command = commandToken.split('@')[0];
  return { command, args: parts, rawArgs: raw.slice(commandToken.length).trim() };
}
function parseCallbackData(data = '') {
  const [namespace, action, ...rest] = String(data).split(':');
  return { namespace, action, value: rest.join(':') || null, data: String(data) };
}
function actionFromUpdate(update = {}) {
  const callback = update.callback_query;
  if (callback) {
    const parsed = parseCallbackData(callback.data);
    return {
      action: parsed.namespace === 'cycle' && ['start', 'stop', 'refresh'].includes(parsed.action)
        ? 'cycleControl'
        : parsed.namespace === 'acctoggle'
        ? 'accountToggle'
        : parsed.namespace === 'accmanage'
        ? 'accountManage'
        : parsed.namespace === 'delay'
        ? 'delayControl'
        : parsed.namespace === 'schedule_btn'
        ? 'scheduleControl'
        : parsed.namespace === 'acc'
        ? 'accountControl'
        : parsed.namespace === 'nav'
        ? 'navControl'
        : parsed.namespace === 'flow'
        ? 'flowControl'
        : 'unknownCallback',
      source: 'callback',
      callback,
      parsed
    };
  }
  const message = update.message || null;
  const text = String(message?.text || message?.caption || '').trim();
  const normalized = normalizeNavigationText(text);
  const command = commandParts(normalized);
  return { action: message?.document ? 'document' : ACTIONS[normalized] || (command && ACTIONS[command.command]) || (text ? 'input' : null), source: 'message', message, command };
}

const { richHtmlToFallback } = require('./tableUtils');

function validateInputRichMessage(rich_message) {
  if (!rich_message || typeof rich_message !== 'object' || Array.isArray(rich_message)) {
    throw Object.assign(new Error('Invalid InputRichMessage: must be an object'), { code: 'TELEGRAM_RICH_INVALID' });
  }
  const keys = ['html', 'markdown', 'blocks'].filter(k => rich_message[k] !== undefined);
  if (keys.length !== 1) {
    throw Object.assign(new Error('InputRichMessage must contain exactly one of html, markdown, blocks'), { code: 'TELEGRAM_RICH_INVALID' });
  }
  const key = keys[0];
  if (key === 'html') {
    if (typeof rich_message.html !== 'string' || rich_message.html.length === 0 || rich_message.html.length > 32768) {
      throw Object.assign(new Error('InputRichMessage.html must be between 1 and 32768 characters'), { code: 'TELEGRAM_RICH_INVALID' });
    }
  } else if (key === 'markdown') {
    if (typeof rich_message.markdown !== 'string' || rich_message.markdown.length === 0 || rich_message.markdown.length > 32768) {
      throw Object.assign(new Error('InputRichMessage.markdown must be between 1 and 32768 characters'), { code: 'TELEGRAM_RICH_INVALID' });
    }
  } else if (key === 'blocks') {
    if (!Array.isArray(rich_message.blocks) || rich_message.blocks.length === 0 || rich_message.blocks.length > 500) {
      throw Object.assign(new Error('InputRichMessage.blocks must contain between 1 and 500 blocks'), { code: 'TELEGRAM_RICH_INVALID' });
    }
  }
}

function isConfirmedUnsupportedRich(error) {
  if (!error || error.ambiguous !== false) return false;
  const msg = String(error.description || error.message || '');
  if (error.telegramCode === 400) {
    return /(?:unknown field|unsupported field).*["']?rich_message["']?/i.test(msg) ||
      /unknown field.*["']?rich_message["']?/i.test(msg);
  }
  if (error.telegramCode === 404) {
    return /(?:unknown|not found).*method.*sendRichMessage|sendRichMessage.*(?:unknown|not found)/i.test(msg);
  }
  return false;
}

class TelegramTransport {
  constructor({ send, sendMessage, sendRichMessage, editMessageText, deleteMessage, answerCallback, answerCallbackQuery, inlineStyles = true } = {}) {
    this.send = send || sendMessage || (async () => { throw new Error('Telegram transport is not configured'); });
    this.sendRich = sendRichMessage || null;
    this._editMessageText = editMessageText || (async () => { throw new Error('Telegram edit transport is not configured'); });
    this._deleteMessage = deleteMessage || (async () => undefined);
    this.answerCallback = answerCallback || answerCallbackQuery || (async () => undefined);
    this.inlineStyles = inlineStyles !== false;
    this._sendRichSupported = true;
    this._richMessageSupported = true;
    this._messageEditQueues = new Map();
  }
  async sendMessage(chatId, text, extra = {}) {
    const navigation = navigationContext.getStore();
    navigation?.onSend?.();
    if ((navigation && !navigation.isCurrent()) || (extra._isCurrent && !extra._isCurrent())) {
      return { superseded: true };
    }

    let rich_message = extra.rich_message;
    if (!rich_message && typeof text === 'string' && /<table(?:\s|>)/i.test(text)) {
      rich_message = { html: text };
    }

    if (rich_message) {
      validateInputRichMessage(rich_message);
      const { text: _t, parse_mode: _pm, entities: _e, rich_message: _rm, ...cleanExtra } = extra;

      const buildFallback = () => {
        if (typeof text === 'string' && text.trim().length > 0 && !/<table(?:\s|>)/i.test(text)) {
          return text;
        }
        if (rich_message.html) {
          return richHtmlToFallback(rich_message.html);
        }
        return rich_message.markdown || '';
      };

      if (this._sendRichSupported && this._richMessageSupported && typeof this.sendRich === 'function') {
        try {
          return await this.sendRich({ chat_id: chatId, rich_message, ...cleanExtra });
        } catch (error) {
          if (!isConfirmedUnsupportedRich(error)) {
            throw error;
          }
          if (error.telegramCode === 404) {
            this._sendRichSupported = false;
          } else {
            this._richMessageSupported = false;
          }
          const nav = navigationContext.getStore();
          if ((nav && !nav.isCurrent()) || (extra._isCurrent && !extra._isCurrent())) {
            return { superseded: true };
          }
          const fallbackText = buildFallback();
          return this.send({ chat_id: chatId, text: fallbackText, parse_mode: 'HTML', ...cleanExtra });
        }
      } else {
        const fallbackText = buildFallback();
        return this.send({ chat_id: chatId, text: fallbackText, parse_mode: 'HTML', ...cleanExtra });
      }
    }

    if (typeof text === 'string' && /<table(?:\s|>)/i.test(text)) {
      const fallbackText = richHtmlToFallback(text);
      return this.send({ chat_id: chatId, text: fallbackText, parse_mode: 'HTML', ...extra });
    }
    return this.send({ chat_id: chatId, text, ...extra });
  }
  async editMessageText(chatId, messageId, text, extra = {}) {
    const msgKey = `${chatId}:${messageId}`;
    if (!this._messageEditQueues) this._messageEditQueues = new Map();
    const previous = this._messageEditQueues.get(msgKey) || Promise.resolve();

    // The ordering tail always settles successfully; only the returned edit
    // operation carries failure to its caller.
    let currentResolve;
    const currentPromise = new Promise(resolve => { currentResolve = resolve; });
    this._messageEditQueues.set(msgKey, currentPromise);

    try {
      await previous.catch(() => {});
      const navigation = navigationContext.getStore();
      navigation?.onSend?.();
      if ((navigation && !navigation.isCurrent()) || (extra._isCurrent && !extra._isCurrent())) {
        return { superseded: true };
      }

      let rich_message = extra.rich_message;
      if (!rich_message && typeof text === 'string' && /<table(?:\s|>)/i.test(text)) {
        rich_message = { html: text };
      }

      let result;
      if (rich_message) {
        validateInputRichMessage(rich_message);
        const { text: _t, parse_mode: _pm, entities: _e, rich_message: _rm, ...cleanExtra } = extra;

        const buildFallback = () => {
          if (typeof text === 'string' && text.trim().length > 0 && !/<table(?:\s|>)/i.test(text)) {
            return text;
          }
          if (rich_message.html) {
            return richHtmlToFallback(rich_message.html);
          }
          return rich_message.markdown || '';
        };

        if (this._richMessageSupported) {
          try {
            result = await this._editMessageText({ chat_id: chatId, message_id: messageId, rich_message, ...cleanExtra });
          } catch (error) {
            if (!isConfirmedUnsupportedRich(error)) {
              throw error;
            }
            this._richMessageSupported = false;
            const nav = navigationContext.getStore();
            if ((nav && !nav.isCurrent()) || (extra._isCurrent && !extra._isCurrent())) {
              return { superseded: true };
            }
            const fallbackText = buildFallback();
            result = await this._editMessageText({ chat_id: chatId, message_id: messageId, text: fallbackText, parse_mode: 'HTML', ...cleanExtra });
          }
        } else {
          const fallbackText = buildFallback();
          result = await this._editMessageText({ chat_id: chatId, message_id: messageId, text: fallbackText, parse_mode: 'HTML', ...cleanExtra });
        }
      } else if (typeof text === 'string' && /<table(?:\s|>)/i.test(text)) {
        const fallbackText = richHtmlToFallback(text);
        result = await this._editMessageText({ chat_id: chatId, message_id: messageId, text: fallbackText, parse_mode: 'HTML', ...extra });
      } else {
        result = await this._editMessageText({ chat_id: chatId, message_id: messageId, text, ...extra });
      }

      return result;
    } finally {
      currentResolve();
      if (this._messageEditQueues.get(msgKey) === currentPromise) {
        this._messageEditQueues.delete(msgKey);
      }
    }
  }
  async waitForMessageEdits(chatId, messageId) {
    // Snapshot the already-tracked tail only. Later edits and other messages
    // are not part of this drain; it never dispatches or retries an operation.
    const tail = this._messageEditQueues?.get(`${chatId}:${messageId}`);
    if (tail) await tail.catch(() => {});
  }
  async deleteMessage(chatId, messageId, { strict = false, ...options } = {}) {
    try { return await this._deleteMessage({ chat_id: chatId, message_id: messageId, ...options }); }
    catch (error) { if (strict) throw error; }
  }
  keyboard(page = 'main', customRows, options = {}) {
    if (customRows) {
      const customStyles = options.styles || {};
      return {
        keyboard: customRows.map(row => row.map(text => ({ text, style: customStyles[text] || MENU_BUTTON_STYLES[text] || 'primary' }))),
        resize_keyboard: true,
        is_persistent: true,
        one_time_keyboard: false
      };
    }
    const rows = PAGES[page] || PAGES.main;
    const normal = page === 'accounts' ? rows.map(row => [...row]) : rows.flatMap(row => {
      const labels = row.filter(text => text !== 'رجوع' && text !== 'الرئيسية');
      return Array.from({ length: Math.ceil(labels.length / 3) }, (_, i) => labels.slice(i * 3, i * 3 + 3));
    });
    const bottomRow = [];
    if (page !== 'accounts' && rows.flat().includes('رجوع')) bottomRow.push('رجوع');
    if (rows.flat().includes('الرئيسية')) bottomRow.push('الرئيسية');
    if (bottomRow.length) normal.push(bottomRow);
    const customStyles = options.styles || {};
    return {
      keyboard: normal.map(row => row.map(text => ({ text, style: customStyles[text] || MENU_BUTTON_STYLES[text] || 'primary' }))),
      resize_keyboard: true,
      is_persistent: true,
      one_time_keyboard: false
    };
  }
  inlineStatusControls({ state = 'stopped', token } = {}) {
    if (!token) return { inline_keyboard: [] };
    const running = state === 'running';
    const text = running ? '🔴 إيقاف' : '🟢 تشغيل';
    const action = running ? 'stop' : 'start';
    const style = running ? 'danger' : 'success';
    return { inline_keyboard: [[{ text, callback_data: `cycle:${action}:${token}`, ...(this.inlineStyles ? { style } : {}) }]] };
  }
  async sendStatus(chatId, status) { return this.send({ chat_id: chatId, text: formatStatus(status), reply_markup: this.inlineStatusControls(status) }); }
  async acknowledgeCallback(callbackQueryId, text, show_alert = false, extra = {}) {
    const bounded = text == null ? undefined : String(text).slice(0, 200);
    return this.answerCallback({
      callback_query_id: callbackQueryId,
      text: bounded,
      ...(show_alert ? { show_alert: true } : {}),
      ...extra
    });
  }
  prepareUpdate(update, { auth, logger, receivedAt = Date.now() } = {}) {
    if (!auth) throw new Error('Authorization gate is required');
    auth.assertUpdateAllowed(update);
    this.updateAdmissions ||= new WeakMap();
    if (this.updateAdmissions.has(update)) return this.updateAdmissions.get(update);
    const admission = {
      receivedAt,
      ackSent: false,
      ackStartedAt: null,
      ackCompletedAt: null,
      ackLatencyMs: null,
      ackDurationMs: null,
      ackPromise: null,
      ackStatus: 'pending',
      ackError: null
    };
    this.updateAdmissions.set(update, admission);
    const callbackId = update.callback_query?.id;
    if (callbackId) {
      admission.ackSent = true;
      admission.ackStartedAt = Date.now();
      admission.ackPromise = Promise.resolve()
        .then(() => this.acknowledgeCallback(callbackId, undefined, false, { _receivedAt: receivedAt }))
        .then(result => {
          admission.ackCompletedAt = Date.now();
          admission.ackLatencyMs = admission.ackCompletedAt - admission.receivedAt;
          admission.ackDurationMs = admission.ackCompletedAt - admission.ackStartedAt;
          admission.ackStatus = 'acknowledged';
          if (logger) {
            try {
              const { logStructured } = require('./structuredLogger');
              logStructured(logger, {
                component: 'telegram_transport',
                event: 'telegram_callback_ack',
                operation: 'answerCallbackQuery',
                result: 'success',
                callbackQueryId: callbackId,
                durationMs: admission.ackLatencyMs,
                ackNetworkMs: admission.ackDurationMs
              });
            } catch {}
          }
          return result;
        })
        .catch(err => {
          admission.ackCompletedAt = Date.now();
          admission.ackLatencyMs = admission.ackCompletedAt - admission.receivedAt;
          admission.ackDurationMs = admission.ackCompletedAt - admission.ackStartedAt;
          admission.ackStatus = 'failed';
          admission.ackError = err;
          if (logger) {
            try {
              const { logStructured, sanitizeError, extractErrorCode } = require('./structuredLogger');
              logStructured(logger, {
                level: 'warn',
                component: 'telegram_transport',
                event: 'telegram_callback_ack_failed',
                operation: 'answerCallbackQuery',
                result: 'failed',
                callbackQueryId: callbackId,
                durationMs: admission.ackLatencyMs,
                errorCode: extractErrorCode(err),
                sanitizedError: sanitizeError(err)
              });
            } catch {}
          }
          return null;
        });
    }
    return admission;
  }
  async dispatchUpdate(update, { auth, actions = {}, deferNavigation = false, logger } = {}) {
    if (!auth) throw new Error('Authorization gate is required');
    auth.assertUpdateAllowed(update);
    const admission = this.prepareUpdate(update, { auth, logger });
    const receivedAt = admission.receivedAt;
    const request = actionFromUpdate(update);
    request.receivedAt = receivedAt;
    request.admission = admission;
    Object.defineProperty(request, 'ackLatencyMs', {
      get: () => admission.ackLatencyMs,
      enumerable: true
    });
    Object.defineProperty(request, 'ackPromise', {
      get: () => admission.ackPromise,
      enumerable: true
    });
    request.updateId = Number.isSafeInteger(update.update_id) ? update.update_id : undefined;
    request.incomingMessageId = Number.isSafeInteger(update.message?.message_id) ? update.message.message_id : undefined;
    if (logger) {
      try {
        require('./structuredLogger').logStructured(logger, {
          component: 'telegram_dispatch', event: 'telegram_update_received', action: request.action,
          updateId: request.updateId, incomingMessageId: request.incomingMessageId, source: request.source,
          messageAgeMs: request.source === 'message' && Number.isFinite(update.message?.date) ? Math.max(0, receivedAt - update.message.date * 1000) : undefined
        });
      } catch {}
    }
    request.deferNavigation = deferNavigation;
    const callbackId = update.callback_query?.id;
    request.acknowledge = async (text, alert = false) => {
      if (!callbackId) return null;
      if (text != null || alert) {
        try {
          return await this.acknowledgeCallback(callbackId, text, alert);
        } catch {
          request.secondaryAckFailed = true;
          return null;
        }
      }
      if (admission.ackPromise) {
        try {
          return await admission.ackPromise;
        } catch {
          return null;
        }
      }
      return null;
    };

    if (!request.action) {
      if (callbackId && !admission.ackSent) request.acknowledge();
      return { handled: false, action: null };
    }
    const handler = actions[request.action];
    if (typeof handler !== 'function') {
      if (callbackId && !admission.ackSent) request.acknowledge();
      return { handled: false, action: request.action, request };
    }
    if (callbackId && request.action === 'navControl') {
      request.acknowledge();
    }
    try {
      const result = await handler(request, update);
      if (callbackId && !admission.ackSent) request.acknowledge();
      return { handled: true, action: request.action, result };
    } catch (error) {
      if (callbackId && !admission.ackSent) request.acknowledge();
      throw error;
    }
  }
}

function formatStatus(status = {}) {
  const labels = { stopped: 'متوقفة', running: 'تعمل', stopping: 'جارٍ الإيقاف', failed: 'تعذّر التشغيل', ready: 'جاهزة', not_ready: 'غير جاهزة' };
  return `حالة الدورة: ${labels[status.cycleState] || 'متوقفة'}\nالحساب التالي: ${status.account || 'غير محدد'}\nالمنشورات المتبقية: ${status.queueLength ?? 0}`;
}
module.exports = { BUTTONS, ACTIONS, PAGES, TelegramTransport, formatStatus, parseCallbackData, actionFromUpdate, commandParts, navigationContext };
