'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const { splitRows, parseLine } = require('./csv');
const { parseCookies } = require('./cookieFormat');
const { Queue, hash } = require('./queue');
const { normalizeAccountId } = require('./accounts');
const { formatAccountTable, escapeHtml } = require('./accountTable');
const nonce = () => crypto.randomBytes(10).toString('hex');
const MAX_FILE = 2 * 1024 * 1024;

function decodeFile(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_FILE) throw new Error('حجم الملف يجب أن يكون بين بايت واحد و2 ميجابايت.');
  try { const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); if (text.includes('\0')) throw new Error(); return text; }
  catch { throw new Error('احفظ الملف بترميز UTF-8 ثم أعد إرساله.'); }
}
const HEADER_FIELDS = { text: 'text', post: 'text', tweet: 'text', content: 'text', 'المنشور': 'text', media: 'media', image: 'media', account: 'account' };

function parsePostsFile(text, state = {}, { plainText = false } = {}) {
  const raw = text.replace(/^\uFEFF/, '');
  let lines; let firstRow;
  try {
    lines = plainText ? raw.split(/\r\n|\r|\n/).filter(x => x.trim()) : splitRows(raw).filter(x => x.trim());
    if (!lines.length) throw new Error('EMPTY');
    try { firstRow = parseLine(lines[0]).map(x => x.trim().toLowerCase()); }
    catch { if (!plainText) throw new Error('CSV'); firstRow = []; }
  } catch (error) {
    if (error.message === 'EMPTY') throw new Error('الملف فارغ.');
    throw new Error('بنية الملف غير صحيحة: تحقق من علامات الاقتباس.');
  }
  const isHeader = firstRow.some(h => Object.hasOwn(HEADER_FIELDS, h));
  let fields = ['text'];
  if (isHeader) {
    fields = firstRow.map(h => Object.hasOwn(HEADER_FIELDS, h) ? HEADER_FIELDS[h] : null);
    if (fields.some(h => !h) || new Set(fields).size !== fields.length || !fields.includes('text')) throw new Error('ترويسة غير صحيحة: استخدم Text,Media أو text وaccount اختياري، دون أعمدة مكررة.');
    try { lines = splitRows(raw).filter(x => x.trim()).slice(1); }
    catch { throw new Error('بنية الملف غير صحيحة: تحقق من علامات الاقتباس.'); }
  } else if (!plainText) {
    if (![1, 2].includes(firstRow.length)) throw new Error('أعمدة غير صحيحة: دون ترويسة استخدم Text,Media أو عمود النص فقط.');
    fields = firstRow.length === 2 ? ['text', 'media'] : ['text'];
  }
  if (!lines.length) throw new Error('لا توجد منشورات في الملف.');
  if (lines.length > 5000) throw new Error('الحد الأقصى 5000 منشور.');
  const payloads = [], seen = new Set((state.items || []).filter(x => !['pending', 'cancelled'].includes(x.state)).map(x => hash(x.payload)));
  let duplicates = 0, rejected = 0;
  for (const line of lines) {
    try {
      const values = plainText && !isHeader ? [line.trim()] : parseLine(line).map(x => x.trim());
      if (values.length !== fields.length) throw new Error('INVALID_ROW');
      const row = Object.fromEntries(fields.map((field, i) => [field, values[i]]));
      if (!row.text) throw new Error('EMPTY_TEXT');
      let account;
      if (fields.includes('account')) {
        account = normalizeAccountId(row.account);
        if (!(state.accounts || []).some(a => a.id === account)) throw new Error('UNKNOWN_ACCOUNT');
      }
      const payload = { text: row.text, ...(row.media ? { media: row.media } : {}), ...(account ? { account } : {}) };
      const id = hash(payload);
      if (seen.has(id)) { duplicates++; continue; }
      seen.add(id); payloads.push(payload);
    } catch { rejected++; }
  }
  return { payloads, valid: payloads.length, duplicates, rejected };
}

class TelegramFlows {
  constructor(ui, { downloadDocument, isolatedVerifier } = {}) { this.ui = ui; this.downloadDocument = downloadDocument; this.isolatedVerifier = isolatedVerifier; }
  get bot() { return this.ui.bot; }
  async user(id) { return (await this.bot.store.load()).telegramUi?.users?.[id.key] || {}; }
  async set(id, patch) { await this.bot.store.update(s => { s.telegramUi ||= {}; s.telegramUi.users ||= {}; s.telegramUi.users[id.key] ||= { chatId: id.chat, userId: id.user }; Object.assign(s.telegramUi.users[id.key], patch); return s; }); }
  async say(id, text, page = 'waiting', extra = {}) { return this.bot.transport.sendMessage(id.chat, text, { reply_markup: this.bot.transport.keyboard(page), ...extra }); }
  async cleanup(id) {
    const u = await this.user(id); const draft = u.draft;
    // Never remove credentials or resources of an adopted account.
    const adopted = draft?.id && (await this.bot.accounts.list()).some(a => a.id === draft.id);
    if (draft?.cookieFile && !adopted) await fs.unlink(draft.cookieFile).catch(() => {});
    await this.set(id, { draft: null, flowToken: null, prompt: null, confirmMessage: null, confirmAt: null });
    if (draft?.id && !adopted) await this.isolatedVerifier?.releaseDraft?.(draft.id);
  }
  async accounts(id) {
    const accounts = await this.bot.accounts.list();
    await this.cleanup(id);
    await this.ui.page(id, 'accounts');
    await this.set(id, { accountId: null, page: 'accounts', prompt: null, selectionIds: [], selectionMessage: null });
    // Bind selection metadata to the committed snapshot and render immediately without blocking on network checks.
    const state = await this.bot.store.update(s => {
      s.telegramUi.users[id.key].selectionIds = (s.accounts || []).map(a => a.id);
      return s;
    });
    const tableHtml = formatAccountTable(state, { now: this.ui.clock() });

    const rows = [['إضافة', 'تفعيل / إلغاء تفعيل', 'الحسابات'], ['رجوع']];
    return this.say(id, tableHtml, 'accounts', { rich_message: { html: tableHtml }, reply_markup: this.bot.transport.keyboard('accounts', rows) });
  }

  async cookies(id) {
    const max = this.bot.accounts?.maxAccounts ?? 1000;
    if ((await this.bot.accounts.list()).length >= max) return this.say(id, `الحد الأقصى ${max} حسابات. احذف حساباً أولاً.`, 'accounts');
    await this.cleanup(id); await this.ui.page(id, 'cookies', 'cookies');
    return this.say(id, 'أرسل ملف Cookies الخاص بحساب X بصيغة TXT أو JSON');
  }
  async posts(id) { await this.cleanup(id); await this.ui.page(id, 'posts', 'csv'); return this.say(id, 'أرسل CSV بترميز UTF-8 بأعمدة Text,Media أو دون ترويسة، أو TXT بسطر لكل منشور. الحساب غير مطلوب للمنشورات المشتركة. الحد 2 ميجابايت و5000 منشور.', 'posts'); }
  async confirm(id, prompt, text, draft) {
    const t = nonce(); await this.set(id, { prompt, draft, flowToken: t, confirmAt: Date.now() });
    const sent = await this.say(id, text, 'confirm', { reply_markup: { inline_keyboard: [[{ text: prompt === 'deleteConfirm' ? 'تأكيد الحذف' : ['disableConfirm', 'disableScheduleConfirm'].includes(prompt) ? 'تأكيد التعطيل' : prompt === 'cookieConfirm' ? 'تأكيد الإضافة' : 'تأكيد الحفظ', callback_data: `flow:confirm:${t}`, style: ['deleteConfirm', 'disableConfirm', 'disableScheduleConfirm'].includes(prompt) ? 'danger' : 'success' }], [{ text: 'رجوع', callback_data: `flow:cancel:${t}`, style: 'primary' }]] } });
    await this.set(id, { confirmMessage: sent.message_id });
  }
  async document(_, raw) {
    const id = this.ui.identity(raw); const u = await this.user(id); const d = raw.message?.document;
    if (!['cookies', 'csv'].includes(u.prompt)) return this.say(id, 'اختر إضافة حساب أو إضافة منشورات أولاً.', u.page || 'main');
    try {
      const ext = path.extname(d?.file_name || '').toLowerCase();
      if (!(u.prompt === 'csv' ? ['.csv', '.txt'] : ['.json', '.txt']).includes(ext)) throw new Error(u.prompt === 'csv' ? 'أرسل ملفاً بامتداد CSV أو TXT.' : 'أرسل ملف TXT أو JSON.');
      if (d.file_size != null && (!Number.isSafeInteger(d.file_size) || d.file_size <= 0 || d.file_size > MAX_FILE)) throw new Error('الحد الأقصى لحجم الملف 2 ميجابايت.');
      if (!this.downloadDocument) throw new Error('استقبال الملفات غير متاح الآن. حاول لاحقاً.');
      const content = decodeFile(await this.downloadDocument(d));
      if (u.prompt === 'csv') {
        const snapshot = await this.bot.store.load();
        const preview = { ...parsePostsFile(content, snapshot, { plainText: ext === '.txt' }), queueFingerprint: hash((snapshot.items || []).filter(x => x.state === 'pending').map(x => x.id).sort()) };
        if (!preview.valid) throw new Error(`لا منشورات صالحة. مكرر: ${preview.duplicates}، مرفوض: ${preview.rejected}.`);
        return this.confirm(id, 'csvConfirm', `صالح: ${preview.valid} | مكرر: ${preview.duplicates} | مرفوض: ${preview.rejected}\n${(await this.bot.queue.pending()).length ? 'تأكيد استبدال الطابور السابق؟' : 'تأكيد تجهيز المنشورات؟'} لن تُحذف السجلات السابقة أو المحاولات غير المحسومة.`, preview);
      }
      let parsed; try { parsed = parseCookies(content).cookies; } catch { throw new Error('صيغة Cookies غير صحيحة. صدّر ملف TXT أو JSON من جلسة X ثم أعد المحاولة.'); }
      const auth = parsed.filter(c => /(^|\.)x\.com$|(^|\.)twitter\.com$/.test(c.domain || new URL(c.url || 'https://invalid').hostname));
      if (!['auth_token', 'ct0'].every(n => auth.some(c => c.name === n && c.value && (!c.expires || c.expires === -1 || c.expires > Date.now() / 1000)))) throw new Error('الملف لا يحتوي رموز مصادقة X المطلوبة أو انتهت صلاحيتها.');
      await this.cleanup(id);
      const accountId = `x-${nonce()}`; const cookie = await this.bot.cookies.storeContent(accountId, content);
      await this.set(id, { draft: { id: accountId, cookieFile: cookie.path }, prompt: 'cookies' });
      return this.verifyDraft(id);
    } catch (error) {
      if (error?.telegramCode || error?.ambiguous || /^(TELEGRAM_|ECONN|EPIPE|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)/.test(error?.code || '')) throw error;
      return this.say(id, error.message && /[\u0600-\u06ff]/.test(error.message) ? error.message : 'تعذر التحقق من الملف. أعد المحاولة أو اضغط رجوع.'); }
  }
  async verifyDraft(id, expectedUsername) {
    const u = await this.user(id); const draft = u.draft;
    // Only an integration which actually owns a verified isolated browser/VPN
    // may perform this operation. Never launch Chromium on the host as fallback.
    if (!this.isolatedVerifier) return this.say(id, 'تم فحص صيغة الملف فقط. تعذر فحص جلسة X: بيئة VPN المعزولة للحساب غير مهيأة. لم تتم إضافة الحساب. يمكنك إعادة المحاولة أو اضغط رجوع.');
    let result;
    try { result = await this.isolatedVerifier.verify({ ...draft, username: expectedUsername }, { discoverIdentity: !expectedUsername }); }
    catch (error) { console.error(JSON.stringify({ event: 'isolated_verification_failed', code: error.code || error.name || 'UNKNOWN' })); await this.set(id, { prompt: 'username', draft: { ...draft, verificationPending: true } }); return this.say(id, 'تم قبول الكوكيز بنجاح. أرسل اسم المستخدم (Username) لهذا الحساب:'); }
    // Drafts are not durable accounts: do not create checks before confirmation.
    if (result?.isolated !== true || result?.vpnHealthy !== true) return this.say(id, 'لم يثبت عزل VPN؛ أُوقفت الإضافة لحماية الجلسة.');
    if (result.state === 'identity_unverified') {
      if (result.authenticated) {
        // Session is valid but username could not be extracted — let user name it
        await this.set(id, { prompt: 'username' });
        return this.say(id, 'الجلسة صالحة لكن تعذر استخراج اسم المستخدم تلقائياً. أدخل اسم مستخدم X الخاص بهذا الحساب (بدون @):');
      }
      await this.set(id, { prompt: 'username' });
      return this.say(id, 'تعذر استخراج اسم المستخدم. أدخل اسم مستخدم X للتحقق من مطابقته للجلسة.');
    }
    if (!result.authenticated || !/^[A-Za-z0-9_]{1,15}$/.test(result.username || '') || (expectedUsername && expectedUsername.toLowerCase() !== result.username.toLowerCase())) return this.say(id, 'جلسة X غير صالحة أو لا تطابق اسم المستخدم. أعد إرسال Cookies أو اضغط رجوع.');
    return this.confirm(id, 'cookieConfirm', `تم التحقق من الجلسة: @${result.username}\nتأكيد إضافة الحساب؟`, { ...draft, username: result.username, label: result.username, ...(typeof result.userId === 'string' && /^\d+$/.test(result.userId) ? { userId: result.userId } : {}), ...(require('./publicIp').isPublicIp(result.exitIp || result.ip) ? { exitIp: result.exitIp || result.ip } : {}), verifiedAt: new Date().toISOString(), vpnResource: result.resourceId || null });
  }
  async account(id) {
    const u = await this.user(id);
    const a = (await this.bot.accounts.list()).find(a => a.id === u.accountId);
    if (!a) return this.accounts(id);
    await this.ui.page(id, 'account');
    await this.set(id, { page: 'account', prompt: null });
    const text = `⚙️ <b>إعدادات الحساب:</b> ${escapeHtml(a.label)}\n${a.username ? '@' + escapeHtml(a.username) : 'الهوية غير متحققة'} — <b>${a.enabled ? 'مفعل' : 'معطل'}</b>`;
    return this.say(id, text, 'account', { parse_mode: 'HTML' });
  }
  async flowControl(request, raw) {
    const id = this.ui.identity(raw); const u = await this.user(id); const p = request.parsed;
    if (p.action === 'select') return this.say(id, 'اختيار الحساب بالأزرار لم يعد متاحاً. افتح إدارة الحسابات وأرسل رقم الحساب أو اسم المستخدم.', 'accounts');
    if (!u.flowToken || !u.confirmMessage || !u.prompt?.endsWith('Confirm') || p.value !== u.flowToken || raw.callback_query.message.message_id !== u.confirmMessage) return this.say(id, 'هذا التأكيد قديم أو تمت معالجته بالفعل.', 'main');
    if (p.action === 'cancel') return this.ui.back(null, raw);
    if (p.action !== 'confirm') return this.say(id, 'هذا الزر غير معروف. اضغط رجوع.');
    return this.input(id, 'تأكيد', { confirmed: true });
  }
  async input(id, text, { confirmed = false } = {}) {
    const u = await this.user(id);
    if (text === 'تأكيد' && u.prompt?.endsWith('Confirm') && !confirmed) return this.say(id, 'استخدم زر التأكيد الخاص بهذه العملية أو اضغط رجوع.');
    if (text === 'تأكيد' && u.prompt?.endsWith('Confirm') && (!u.confirmAt || Date.now() - u.confirmAt > 15 * 60 * 1000)) { await this.cleanup(id); return this.say(id, 'انتهت صلاحية التأكيد. ابدأ العملية مجدداً.', 'main'); }
    if (text === 'رجوع' || text === 'إلغاء') { await this.cleanup(id); return ['posts', 'main'].includes(u.page) ? this.ui.menu(null, { message: { from: { id: id.user }, chat: { id: id.chat } } }) : this.accounts(id); }
    if (u.page === 'accounts' && (text === 'إضافة' || text === 'إضافة حساب')) return this.cookies(id);
    if (u.page === 'accounts') {
      const accounts = await this.bot.accounts.list();
      const account = /^\d+$/.test(text) ? accounts.find(a => a.id === u.selectionIds?.[Number(text) - 1]) : accounts.find(a => a.username?.toLowerCase() === text.replace(/^@/, '').toLowerCase());
      if (!account) return this.say(id, 'أرسل رقم حساب موجود في الجدول أو @اسم_المستخدم.', 'accounts');
      await this.set(id, { accountId: account.id }); return this.account(id);
    }
    if (u.prompt === 'csvConfirm' && text === 'تأكيد') {
      try {
        // Validate pins inside the same transaction as replacement: accounts may
        // have been removed since preview. Never strip an obsolete pin.
        const queue = new Queue({ update: mutate => this.bot.store.update(s => {
          for (const payload of u.draft.payloads) if (Object.hasOwn(payload, 'account')) {
            const account = normalizeAccountId(payload.account);
            if (account !== payload.account || !(s.accounts || []).some(a => a.id === account)) throw new Error('UNKNOWN_ACCOUNT');
          }
          return mutate(s);
        }) });
        const count = await queue.replacePending(u.draft.payloads, { userKey: id.key, confirmationToken: u.flowToken, queueFingerprint: u.draft.queueFingerprint });
        return this.say(id, `أصبحت ${count} منشورات جاهزة. لم يبدأ النشر.`, 'main');
      }
      catch { return this.say(id, 'تعذر الاستبدال: الدورة نشطة أو تغير التأكيد. أوقف الدورة ثم أعد الاستيراد.', 'confirm'); }
    }
    if (u.prompt === 'cookieConfirm' && text === 'تأكيد') {
      await this.bot.accounts.add({ ...u.draft, enabled: true }, { userKey: id.key, confirmationToken: u.flowToken });
      return this.accounts(id);
    }
    if (u.prompt === 'username') {
      let username = text.trim().replace(/^@/, '');
      if (/^https:\/\//i.test(username)) {
        try { const url = new URL(username); username = !url.username && !url.password && !url.port && ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname) && /^\/[A-Za-z0-9_]{1,15}\/?$/.test(url.pathname) ? url.pathname.replace(/^\/|\/$/g, '') : ''; } catch { username = ''; }
      }
      if (!/^[A-Za-z0-9_]{1,15}$/.test(username)) return this.say(id, 'أدخل اسم مستخدم صحيحاً أو رابط حساب X.');
      return this.verifyDraft(id, username);
    }
    if (u.prompt === 'rename') {
      if (!text || text.length > 100 || text.startsWith('/')) return this.say(id, 'اكتب اسماً من 1 إلى 100 حرف.');
      await this.bot.accounts.update(u.accountId, { label: text }); return this.account(id);
    }
    if (u.prompt === 'disableScheduleConfirm' && text === 'تأكيد') { await this.bot.settings.setSchedule({ enabled: false }); await this.cleanup(id); await this.ui.page(id, 'schedule'); return this.say(id, 'تم تعطيل الجدولة.', 'schedule'); }
    if (u.prompt === 'disableConfirm' && text === 'تأكيد') { await this.bot.accounts.update(u.accountId, { enabled: false }); await this.cleanup(id); return this.account(id); }
    if (u.prompt === 'deleteConfirm' && text === 'تأكيد') {
      await this.bot.accounts.remove(u.accountId);
      await this.cleanup(id); return this.accounts(id);
    }
    if (u.page === 'account') {
      const account = (await this.bot.accounts.list()).find(a => a.id === u.accountId); if (!account) return this.accounts(id);
      if (text === 'تعطيل' || (text === 'تفعيل أو تعطيل' && account.enabled)) return this.confirm(id, 'disableConfirm', `تعطيل ${account.label}؟`, { id: account.id });
      if (text === 'تفعيل' || text === 'تفعيل أو تعطيل') {
        const isBanned = account.status === 'محظور' || ['suspended', 'banned'].includes(String(account.status || '').toLowerCase());
        if (isBanned) {
          return this.say(id, 'هذا الحساب محظور، لا يمكن تفعيله.', 'account');
        }
        await this.bot.accounts.update(account.id, { enabled: true, status: 'مفعل' });
        return this.account(id);
      }
      if (text === 'تعديل الاسم') { await this.ui.page(id, 'account', 'rename'); return this.say(id, 'اكتب الاسم الذي سيظهر في قائمة الحسابات.'); }
      if (text === 'حذف الحساب') return this.confirm(id, 'deleteConfirm', `حذف ${account.label} من قائمة الحسابات؟ ستبقى السجلات التاريخية محفوظة.`, { id: account.id });
      if (text === 'فحص جلسة X' || text === 'فحص VPN وIP') {
        if (!this.isolatedVerifier) return this.say(id, 'تعذر الفحص: بيئة VPN المعزولة للحساب غير مهيأة؛ لم يُستخدم اتصال المضيف.', 'account');
        try { const r = text === 'فحص جلسة X' ? await this.isolatedVerifier.verify(account) : await this.isolatedVerifier.health(account); await this.ui.recordAccountCheck(account.id, r, { session: text === 'فحص جلسة X', expectedAccount: account }); return this.say(id, r?.isolated && r?.vpnHealthy ? (text === 'فحص جلسة X' ? r.authenticated ? 'جلسة X صالحة.' : 'جلسة X غير صالحة.' : `VPN سليم. IP: ${require('./publicIp').isPublicIp(r.exitIp || r.ip) ? (r.exitIp || r.ip) : 'غير متاح'}`) : 'فشل التحقق من الشبكة المعزولة.', 'account'); }
        catch { await this.ui.recordAccountCheck(account.id, {}, { session: text === 'فحص جلسة X', expectedAccount: account }); return this.say(id, 'تعذر الفحص. حاول لاحقاً.', 'account'); }
      }
    }
    if (u.prompt === 'cookies' && text === 'إعادة المحاولة' && u.draft) return this.verifyDraft(id);
    if (['cookies', 'csv'].includes(u.prompt)) return this.say(id, 'الملف مطلوب كمرفق؛ أرسله أو اضغط رجوع.');
    if (u.prompt?.endsWith('Confirm')) return this.say(id, 'اختر تأكيد أو اضغط رجوع.', 'confirm');
    return null;
  }
}
module.exports = { TelegramFlows, parsePostsFile, decodeFile, MAX_FILE };
