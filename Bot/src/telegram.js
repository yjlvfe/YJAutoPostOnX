'use strict';

// Reply keyboards are navigation only. Cycle commands belong to a separately
// scoped inline panel, never to /start or a persistent bottom-row button.
const BUTTONS = Object.freeze({ work: 'بدء العمل', posts: 'إضافة منشورات', settings: 'الإعدادات' });
// All reply navigation is themed; labels remain unchanged for exact routing.
const MENU_BUTTON_STYLES = Object.freeze({
  [BUTTONS.work]: 'success', [BUTTONS.posts]: 'success',
  'إضافة حساب': 'success', 'تفعيل': 'success', 'تفعيل الجدولة': 'success',
  'تعطيل': 'danger', 'حذف الحساب': 'danger', 'تعطيل الجدولة': 'danger'
});
const ACTIONS = Object.freeze({
  [BUTTONS.work]: 'work', [BUTTONS.posts]: 'posts', [BUTTONS.settings]: 'settings',
  '/start': 'menu', '/menu': 'menu', '/status': 'work', '/report': 'report',
  'القائمة الرئيسية': 'menu', 'رجوع': 'back', 'العودة': 'back', 'رجوع للقائمة': 'back', 'إلغاء': 'back',
  'إدارة الحسابات': 'accounts', '/accounts': 'accounts',
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
  main: [[BUTTONS.work, BUTTONS.posts, BUTTONS.settings]],
  settings: [['إدارة الحسابات', 'الجدولة', 'التأخير'], ['الحصص', 'رجوع']],
  input: [['رجوع']],
  accounts: [['إضافة حساب', 'رجوع']],
  account: [['تفعيل', 'تعطيل', 'تعديل الاسم'], ['فحص جلسة X', 'فحص VPN وIP', 'حذف الحساب'], ['رجوع']],
  waiting: [['رجوع']], confirm: [['رجوع']],
  schedule: [['تفعيل الجدولة', 'تعطيل الجدولة', 'تحديد الموعد'], ['رجوع']],
  delay: [['الحد الأدنى', 'الحد الأعلى'], ['رجوع']], quota: [['رجوع']], posts: [['رجوع']]
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
    return { action: parsed.namespace === 'cycle' && ['start', 'stop', 'refresh'].includes(parsed.action) ? 'cycleControl' : parsed.namespace === 'acc' ? 'accountControl' : parsed.namespace === 'nav' ? 'navControl' : parsed.namespace === 'flow' ? 'flowControl' : 'unknownCallback', source: 'callback', callback, parsed };
  }
  const message = update.message || null;
  const text = String(message?.text || message?.caption || '').trim();
  const normalized = normalizeNavigationText(text);
  const command = commandParts(normalized);
  return { action: ACTIONS[normalized] || (command && ACTIONS[command.command]) || (message?.document ? 'document' : text && !command ? 'input' : command ? 'input' : null), source: 'message', message, command };
}

class TelegramTransport {
  constructor({ send, sendMessage, sendRichMessage, editMessageText, answerCallback, answerCallbackQuery, inlineStyles = true } = {}) {
    this.send = send || sendMessage || (async () => { throw new Error('Telegram transport is not configured'); });
    this.sendRich = sendRichMessage || (async () => { throw new Error('Telegram rich transport is not configured'); });
    this._editMessageText = editMessageText || (async () => { throw new Error('Telegram edit transport is not configured'); });
    this.answerCallback = answerCallback || answerCallbackQuery || (async () => undefined);
    this.inlineStyles = inlineStyles !== false;
  }
  async sendMessage(chatId, text, extra = {}) {
    if (extra.rich_message) return this.sendRich({ chat_id: chatId, ...extra });
    if (typeof text === 'string' && text.includes('<table')) {
      const { parse_mode, ...rest } = extra;
      return this.sendRich({ chat_id: chatId, rich_message: { html: text }, ...rest });
    }
    return this.send({ chat_id: chatId, text, ...extra });
  }
  async editMessageText(chatId, messageId, text, extra = {}) {
    if (extra.rich_message) return this._editMessageText({ chat_id: chatId, message_id: messageId, ...extra });
    if (typeof text === 'string' && text.includes('<table')) {
      const { parse_mode, ...rest } = extra;
      return this._editMessageText({ chat_id: chatId, message_id: messageId, rich_message: { html: text }, ...rest });
    }
    return this._editMessageText({ chat_id: chatId, message_id: messageId, text, ...extra });
  }
  keyboard(page = 'main', customRows) {
    const rows = customRows || PAGES[page] || PAGES.main;
    const normal = rows.flatMap(row => {
      const labels = row.filter(text => text !== 'رجوع');
      return Array.from({ length: Math.ceil(labels.length / 3) }, (_, i) => labels.slice(i * 3, i * 3 + 3));
    });
    if (rows.flat().includes('رجوع')) normal.push(['رجوع']);
    // Keep the existing rows and labels; the current theme includes Back and
    // dynamically generated account buttons, not just the top-level menu.
    return {
      keyboard: normal.map(row => row.map(text => ({ text, style: MENU_BUTTON_STYLES[text] || 'primary' }))),
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
  async acknowledgeCallback(callbackQueryId, text, show_alert = false) {
    const bounded = text == null ? undefined : String(text).slice(0, 200);
    return this.answerCallback({ callback_query_id: callbackQueryId, text: bounded, ...(show_alert ? { show_alert: true } : {}) });
  }
  async dispatchUpdate(update, { auth, actions = {} } = {}) {
    if (!auth) throw new Error('Authorization gate is required');
    auth.assertUpdateAllowed(update);
    const request = actionFromUpdate(update);
    if (!request.action) return { handled: false, action: null };
    const callbackId = update.callback_query?.id;
    const priorityStop = request.action === 'cycleControl' && request.parsed?.action === 'stop';
    const startControl = request.action === 'cycleControl' && request.parsed?.action === 'start';
    let acknowledgement;
    request.acknowledge = (text, alert = false) => acknowledgement ||= this.acknowledgeCallback(callbackId, text, alert);
    // Cancellation must not depend on the lifetime of Telegram's callback ID.
    // Authorization above and the handler's panel token/message checks remain.
    if (callbackId && priorityStop) Promise.resolve().then(() => request.acknowledge()).catch(() => {});
    else if (callbackId && !startControl) await request.acknowledge();
    const handler = actions[request.action];
    if (typeof handler !== 'function') return { handled: false, action: request.action, request };
    return { handled: true, action: request.action, result: await handler(request, update) };
  }
}

function formatStatus(status = {}) {
  const labels = { stopped: 'متوقفة', running: 'تعمل', stopping: 'جارٍ الإيقاف', failed: 'تعذّر التشغيل', ready: 'جاهزة', not_ready: 'غير جاهزة' };
  return `حالة الدورة: ${labels[status.cycleState] || 'متوقفة'}\nالحساب التالي: ${status.account || 'غير محدد'}\nالمنشورات المتبقية: ${status.queueLength ?? 0}`;
}
module.exports = { BUTTONS, ACTIONS, PAGES, TelegramTransport, formatStatus, parseCallbackData, actionFromUpdate, commandParts };
