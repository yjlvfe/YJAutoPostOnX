'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  MAX_ACTIVE_ACCOUNTS,
  isCaptchaStatus,
  isBannedStatus,
  isUnverifiedStatus,
  isAccountInactive,
  applyOwnerEnabled
} = require('./accounts');
const { formatAccountTable, escapeHtml } = require('./accountTable');
const { logStructured, sanitizeError, extractErrorCode } = require('./structuredLogger');
const nonce = () => crypto.randomBytes(10).toString('hex');
// Preserve exporter identity hints for automatic account imports; importing
// hints are untrusted until the importer verifies authenticated self identity.
function extractUsernameHint(text) {
  const valid = value => {
    const username = String(value || '').trim().replace(/^@/, '');
    return /^[A-Za-z0-9_]{1,15}$/.test(username) ? username : null;
  };
  const keyName = key => String(key).toLowerCase().replace(/[\s_-]+/g, '');
  const usernameKeys = new Set(['username', 'handle', 'screenname']);
  const findInJson = value => {
    if (Array.isArray(value)) {
      for (const item of value) {
        const username = findInJson(item);
        if (username) return username;
      }
      return null;
    }
    if (!value || typeof value !== 'object') return null;

    // Check recognized metadata keys before descending so direct metadata
    // keeps the same precedence as the former account/user/metadata lookup.
    for (const [key, candidate] of Object.entries(value)) {
      if (usernameKeys.has(keyName(key))) {
        const username = valid(candidate);
        if (username) return username;
      }
    }
    for (const child of Object.values(value)) {
      const username = findInJson(child);
      if (username) return username;
    }
    return null;
  };
  const trimmed = String(text || '').trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const username = findInJson(JSON.parse(trimmed));
      if (username) return username;
    } catch {}
  }
  const match = /(?:^|\n)\s*#\s*(?:username|screen[_ -]?name|handle)\s*[:=]\s*@?([A-Za-z0-9_]{1,15})\s*$/im.exec(trimmed);
  return match ? valid(match[1]) : null;
}

class TelegramFlows {
  constructor(uiOrOptions, options = {}) {
    if (uiOrOptions && uiOrOptions.ui && !uiOrOptions.identity) {
      this.ui = uiOrOptions.ui;
      this._bot = uiOrOptions.bot || uiOrOptions.ui.bot;
      this.downloadDocument = uiOrOptions.downloadDocument;
      this.downloadDocumentToFile = uiOrOptions.downloadDocumentToFile;
      this.isolatedVerifier = uiOrOptions.isolatedVerifier;
    } else {
      this.ui = uiOrOptions;
      this.downloadDocument = options.downloadDocument;
      this.downloadDocumentToFile = options.downloadDocumentToFile;
      this.isolatedVerifier = options.isolatedVerifier;
    }
    this.imports = new (require('./fileImports').FileImports)(this);
  }
  get bot() { return this.ui?.bot || this._bot; }
  async user(id) { if(this.ui.fastNavigation)return this.ui.fastNavigation.user(id.key); return this.bot.store.section ? (await this.bot.store.section('telegramUi')).users?.[id.key] || {} : (await this.bot.store.load()).telegramUi?.users?.[id.key] || {}; }
  async set(id, patch) { if(this.ui.fastNavigation)await this.ui.fastNavigation.flush(); if(this.bot.store.patchUiUser) return this.bot.store.patchUiUser(id.key,{chatId:id.chat,userId:id.user,...patch}); await this.bot.store.update(s => { s.telegramUi ||= {}; s.telegramUi.users ||= {}; s.telegramUi.users[id.key] ||= { chatId: id.chat, userId: id.user }; Object.assign(s.telegramUi.users[id.key], patch); return s; }); }
  async notice(id,text,extra={}) { return this.bot.transport.sendMessage(id.chat,text,{...extra,_background:true}); }
  async say(id, text, page = 'waiting', extra = {}) { return this.bot.transport.sendMessage(id.chat, text, { reply_markup: (typeof this.bot?.transport?.keyboard === 'function' ? this.bot.transport.keyboard(page) : (extra.reply_markup || {})), ...extra }); }
  async cleanup(id) {
    const u = await this.user(id); const draft = u.draft;
    // Migration cleanup for drafts persisted by the removed manual import UI.
    // Never remove credentials or resources of an adopted account.
    const adopted = draft?.id && (this.bot.store.section?await this.bot.store.section('accounts'):await this.bot.accounts.list()).some(a => a.id === draft.id);
    if (draft?.cookieFile && !adopted) {
      await fs.unlink(draft.cookieFile).catch(err => {
        if (err.code !== 'ENOENT') {
          logStructured(this.bot?.logger, {
            level: 'warn',
            component: 'telegram_flows',
            event: 'draft_cookie_unlink_failed',
            operation: 'cleanup',
            result: 'failed',
            errorCode: extractErrorCode(err),
            sanitizedError: sanitizeError(err)
          });
        }
      });
    }
    await this.set(id, { draft: null, flowToken: null, prompt: null, confirmMessage: null, confirmAt: null });
    if (draft?.id && !adopted) await this.isolatedVerifier?.releaseDraft?.(draft.id);
  }
  async accounts(id) {
    await this.cleanup(id);
    return this.ui.openAccountsPanel(id);
  }

  async confirm(id, prompt, text, draft) {
    const t = nonce(); await this.set(id, { prompt, draft, flowToken: t, confirmMessage: null, confirmAt: Date.now() });
    const sent = await this.say(id, text, 'confirm', { reply_markup: { inline_keyboard: [[{ text: prompt === 'deleteConfirm' ? 'تأكيد الحذف' : ['disableConfirm', 'disableScheduleConfirm'].includes(prompt) ? 'تأكيد التعطيل' : 'تأكيد الحفظ', callback_data: `flow:confirm:${t}`, style: ['deleteConfirm', 'disableConfirm', 'disableScheduleConfirm'].includes(prompt) ? 'danger' : 'success' }], [{ text: 'رجوع', callback_data: `flow:cancel:${t}`, style: 'primary' }]] } });
    // Telegram API adapters may return either the unwrapped message or the
    // normal Bot API envelope. Persist a known message id only when it is a
    // valid positive integer; a missing receipt fails closed rather than
    // accepting an unbound confirmation callback.
    const messageId = sent?.message_id ?? sent?.result?.message_id;
    await this.set(id, { confirmMessage: Number.isSafeInteger(messageId) && messageId > 0 ? messageId : null });
  }
  async document(_, raw) {
    const id = this.ui.identity(raw); const original = raw.message?.document;
    const receiptKey = raw.update_id != null ? 'update:'+raw.update_id : raw.message?.message_id != null ? 'message:'+raw.message.message_id : crypto.randomUUID();
    const d = original && {...original,_importReceipt:crypto.createHash('sha256').update(id.key+':'+receiptKey).digest('hex')};
    const extension = path.extname(d?.file_name || '').toLowerCase();
    if (extension === '.csv') {
      if (d.file_size != null && (!Number.isSafeInteger(d.file_size) || d.file_size <= 0 || d.file_size > require('./fileImports').MAX_CSV_BYTES)) {
        return this.notice(id, 'حد تنزيل Telegram الحالي 20 ميجابايت.');
      }
      await this.imports.initialize();
      const identity=await this.imports.csvIdentity(id,d);
      Object.assign(d,identity.doc);
      const admission=await this.imports.tx(async db=>{
        const replay=await db.one("SELECT * FROM file_import_jobs WHERE owner=$1 AND kind='csv' AND (doc::jsonb->>'_importReceipt'=$2 OR (doc::jsonb->'_importReceipts') ? $2) ORDER BY seq LIMIT 1",[id.key,d._importReceipt]);
        if(replay)return {jobId:replay.id,replay:true};
        const prior=await db.one('SELECT id FROM file_import_jobs WHERE id=$1',[identity.jobId]);
        await db.execute("INSERT INTO file_import_jobs(id,owner,kind,status,doc,chat,\"user\") VALUES($1,$2,'csv','receiving',$3,$4,$5) ON CONFLICT(id) DO NOTHING",[identity.jobId,id.key,JSON.stringify(d),String(id.chat),String(id.user)]);
        if(prior)await db.execute("UPDATE file_import_jobs SET doc=jsonb_set(doc::jsonb,'{_importReceipts}',COALESCE(doc::jsonb->'_importReceipts','[]'::jsonb)||jsonb_build_array($1::text))::text WHERE id=$2",[d._importReceipt,identity.jobId]);
        return {jobId:identity.jobId,replay:false,existing:!!prior};
      });
      const jobId=admission.jobId;
      if(admission.replay)return this.imports.csvReceipt(id,d,jobId);
      const existing = await this.imports.row(jobId);
      if (existing&&admission.existing) {
        if (['done', 'duplicate', 'invalid'].includes(existing.status)) {
          const msg = existing.status === 'done'
            ? `هذا الملف مستورد بالفعل: المضافة ${existing.added} | المكررة ${existing.duplicates} | المرفوضة ${existing.rejected}.`
            : existing.status === 'duplicate'
            ? 'هذا الملف مكرر؛ لم تتكرر إضافته.'
            : 'سبق رفض هذا الملف؛ أرسل نسخة مصححة.';
          return this.imports.csvReport(id, jobId, msg);
        }
        if (existing.status === 'receiving' || (existing.status === 'processing' && this.imports.tasks?.has(jobId))) {
          return this.imports.csvReport(id, jobId, 'هذا الملف مستورد أو قيد الاستيراد بالفعل؛ لم تتكرر إضافته.');
        }
      }
      // Persist the inbox before acknowledging the Telegram update.
      const receipt = await this.imports.csvReceipt(id, d, jobId);
      this.imports.launch(jobId, () => this.imports.csv(id, d, jobId));
      return receipt;
    }
    const u = await this.user(id);
    if (['.txt','.json'].includes(extension)) {
      const MAX_COOKIE_BYTES = require('./accounts').MAX_COOKIE_FILE_BYTES || 1024 * 1024;
      if (d.file_size != null && (!Number.isSafeInteger(d.file_size) || d.file_size <= 0 || d.file_size > MAX_COOKIE_BYTES)) {
        return this.notice(id, 'ملف الحساب غير صالح أو كبير؛ أرسل Cookies TXT/JSON صالحة بحجم لا يتجاوز 1 ميجابايت.');
      }
      try {
        return await this.imports.text(id,d,(content,doc)=>this.consumeAccountText(id,content,doc),{defer:true});
      } catch (error) {
        if (error?.ambiguous || error?.telegramCode) throw error;
        return this.notice(id, 'ملف الحساب غير صالح أو كبير؛ أرسل Cookies TXT/JSON صالحة بحجم لا يتجاوز 1 ميجابايت.');
      }
    }
    return this.say(id, 'أرسل ملف CSV للمنشورات أو TXT/JSON لحساب X.', u.page || 'main');
  }
  async account(id) {
    const u = await this.user(id);
    const accounts = typeof this.bot?.accounts?.list === 'function' ? await this.bot.accounts.list() : (this.bot?.store?.section ? await this.bot.store.section('accounts') : (await this.bot?.store?.load())?.accounts || []);
    const a = (accounts || []).find(a => a.id === u.accountId);
    if (!a) return this.accounts(id);
    await this.ui.page(id, 'account');
    await this.set(id, { page: 'account', prompt: null });
    const text = `⚙️ <b>إعدادات الحساب:</b> ${escapeHtml(a.label)}\n${a.username ? '@' + escapeHtml(a.username) : 'الهوية غير متحققة'} — <b>${a.enabled ? 'مفعل' : 'معطل'}</b>`;
    return this.say(id, text, 'account', { parse_mode: 'HTML' });
  }
  async consumeAccountText(id, content, doc) {
    return this.imports.account(id, doc, content, extractUsernameHint(content));
  }
  async flowControl(request, raw) {
    const id = this.ui.identity(raw); const p = request.parsed;
    if(['imports','importcancel'].includes(p.action)){
      // Import approvals are retired. Historical buttons cannot mutate any batch.
      return {processed:false};
    }
    const u = await this.user(id);
    if (p.action === 'select') return this.say(id, 'اختيار الحساب بالأزرار لم يعد متاحاً. افتح إدارة الحسابات وأرسل رقم الحساب أو اسم المستخدم.', 'accounts');
    const messageId = raw.callback_query?.message?.message_id;
    if (!u.flowToken || !u.prompt?.endsWith('Confirm') || p.value !== u.flowToken || !u.confirmMessage || messageId !== u.confirmMessage) return this.say(id, 'هذا التأكيد قديم أو تمت معالجته بالفعل.', 'main');
    if (p.action === 'cancel') return this.ui.back(null, raw);
    if (p.action !== 'confirm') return this.say(id, 'هذا الزر غير معروف. اضغط رجوع.');
    return this.input(id, 'تأكيد', { confirmed: true });
  }
  async input(id, text, { confirmed = false, raw = null } = {}) {
    const isXLink = /https?:\/\/(?:x\.com|twitter\.com)\/(?:[A-Za-z0-9_]{1,15}\/status|i\/web\/status)\/\d+/i.test(String(text || ''));
    if (isXLink) {
      const linkExports = this.ui?.links || this.ui?.linkExports || this.bot?.linkExports;
      const at = this.ui.clock();
      let recordResult = null;
      if (typeof linkExports?.recordManual === 'function') {
        recordResult = await linkExports.recordManual(text, at);
      } else {
        const { recordManualDirect } = require('./linkExports');
        recordResult = await recordManualDirect(this.bot.store, text, at);  // shared atomic recorder
      }
      const incomingMsgId = raw?.message?.message_id;
      if (Number.isSafeInteger(incomingMsgId) && incomingMsgId > 0) {
        await this.bot.transport.deleteMessage(id.chat, incomingMsgId, { strict: true }).catch(err => {
          logStructured(this.bot.logger, { level: 'warn', component: 'telegram_flows',
            event: 'incoming_link_delete_failed', code: extractErrorCode(err) });
        });
      }
      const isAdded = Boolean(recordResult?.added > 0);
      const replyNotice = !recordResult ? '❌ لم تتم الإضافة: رابط غير صالح' :
        isAdded ? '✅ تمت الإضافة بنجاح' : '❌ لم تتم الإضافة: الرابط مكرر';
      // This is a plain temporary text notice, never a keyboard carrier.
      const sent = await this.notice(id, replyNotice);
      const sentMsgId = sent?.message_id ?? sent?.result?.message_id;
      if (Number.isSafeInteger(sentMsgId) && sentMsgId > 0) {
        if (this.ui?.transientNotices) {
          await this.ui.transientNotices.track(id.chat, sentMsgId).catch(err => {
            logStructured(this.bot.logger, { level: 'warn', component: 'telegram_flows',
              event: 'transient_notice_track_failed', code: extractErrorCode(err) });
          });
        }
      }
      return { linkAdded: isAdded, duplicates: recordResult?.duplicates || 0 };
    }
    const u = await this.user(id);
    if (text === 'تأكيد' && u.prompt?.endsWith('Confirm') && !confirmed) return this.say(id, 'استخدم زر التأكيد الخاص بهذه العملية أو اضغط رجوع.');
    if (text === 'تأكيد' && u.prompt?.endsWith('Confirm') && (!u.confirmAt || Date.now() - u.confirmAt > 15 * 60 * 1000)) { await this.cleanup(id); return this.say(id, 'انتهت صلاحية التأكيد. ابدأ العملية مجدداً.', 'main'); }
    if (await this.imports.name(id,text)) return true;
    if (text === 'الرئيسية' || text === 'القائمة الرئيسية') {
      await this.cleanup(id);
      return this.ui.menu(null, { message: { from: { id: id.user }, chat: { id: id.chat } } });
    }
    if (text === 'رجوع' || text === 'إلغاء') { await this.cleanup(id); return ['accounts', 'posts', 'main'].includes(u.page) ? this.ui.menu(null, { message: { from: { id: id.user }, chat: { id: id.chat } } }) : this.accounts(id); }
    if (u.page === 'accounts') {
      const accounts = await this.bot.accounts.list();
      const account = /^\d+$/.test(text) ? accounts.find(a => a.id === u.selectionIds?.[Number(text) - 1]) : accounts.find(a => a.username?.toLowerCase() === text.replace(/^@/, '').toLowerCase());
      if (!account) return this.say(id, 'أرسل رقم حساب موجود في الجدول أو @اسم_المستخدم.', 'accounts');
      await this.set(id, { accountId: account.id }); return this.account(id);
    }
    if (u.prompt === 'rename') {
      if (!text || text.length > 100 || text.startsWith('/')) return this.say(id, 'اكتب اسماً من 1 إلى 100 حرف.');
      await this.bot.accounts.update(u.accountId, { label: text }); return this.account(id);
    }
    if (u.prompt === 'disableScheduleConfirm' && text === 'تأكيد') { await this.bot.settings.setSchedule({ enabled: false }); await this.cleanup(id); await this.ui.page(id, 'schedule'); return this.say(id, 'تم تعطيل الجدولة.', 'schedule'); }
    if (u.prompt === 'disableConfirm' && text === 'تأكيد') {
      const drain = this.ui?.drainWorkers || this.ui?.drainAccountWorkers || this.bot?.drainWorkers;
      if (typeof drain === 'function') {
        await drain([u.accountId]).catch(() => {});
      }
      if (typeof this.bot.accounts?.update === 'function') {
        await this.bot.accounts.update(u.accountId, { enabled: false }).catch(() => {});
      }
      await this.bot.store.update(s => {
        const a = (s.accounts || []).find(acc => acc.id === u.accountId);
        if (a) a.enabled = false;
        if (s.vpnSlots && Object.hasOwn(s.vpnSlots, u.accountId)) delete s.vpnSlots[u.accountId];
        return s;
      });
      if (typeof this.bot.vpnManager?.release === 'function') {
        const { trackVpnRelease } = require('./telegramUi');
        const p = Promise.resolve(this.bot.vpnManager.release(u.accountId));
        trackVpnRelease(this.bot.store, u.accountId, p);
        await p;
      }
      await this.cleanup(id); return this.account(id);
    }
    if (u.prompt === 'deleteConfirm' && text === 'تأكيد') {
      const drain = this.ui?.drainWorkers || this.ui?.drainAccountWorkers || this.bot?.drainWorkers;
      if (typeof drain === 'function') {
        await drain([u.accountId]).catch(() => {});
      }
      await this.bot.accounts.remove(u.accountId);
      await this.cleanup(id); return this.accounts(id);
    }
    if (u.page === 'account') {
      const account = (await this.bot.accounts.list()).find(a => a.id === u.accountId); if (!account) return this.accounts(id);
      if (text === 'تعطيل' || (text === 'تفعيل أو تعطيل' && account.enabled)) return this.confirm(id, 'disableConfirm', `تعطيل ${account.label}؟`, { id: account.id });
      if (text === 'تفعيل' || text === 'تفعيل أو تعطيل') {
        const { awaitVpnRelease } = require('./telegramUi');
        await awaitVpnRelease(this.bot?.store, account.id);
        let enableOutcome = { enabled: false, notFound: false, banned: false, captcha: false, unverified: false, limitExceeded: false, restricted: false };
        await this.bot.store.update(s => {
          enableOutcome = { enabled: false, notFound: false, banned: false, captcha: false, unverified: false, limitExceeded: false, restricted: false };
          const target = (s.accounts || []).find(a => a.id === account.id);
          if (!target) { enableOutcome.notFound = true; return s; }
          const activation = applyOwnerEnabled(s, target.id, true);
          if (!activation.applied) {
            if (activation.reason === 'active_account_limit') enableOutcome.limitExceeded = true;
            else if (activation.reason === 'banned') enableOutcome.banned = true;
            else if (activation.reason === 'captcha') enableOutcome.captcha = true;
            else if (activation.reason === 'session_missing') enableOutcome.unverified = true;
            else enableOutcome.restricted = true;
            return s;
          }
          target.failures = 0;
          if (s.posting?.cooling?.[target.id]) delete s.posting.cooling[target.id];
          s.vpnSlots ||= {};
          const allActive = new Set((s.accounts || []).filter(a => a.enabled !== false).map(a => a.id));
          for (const k of Object.keys(s.vpnSlots)) {
            if (!allActive.has(k)) delete s.vpnSlots[k];
          }
          if (!Object.hasOwn(s.vpnSlots, target.id)) {
            const used = new Set(Object.values(s.vpnSlots).filter(v => Number.isInteger(v)));
            const freeSlot = [0, 1, 2, 3, 4].find(i => !used.has(i));
            if (freeSlot != null) s.vpnSlots[target.id] = freeSlot;
          }
          enableOutcome.enabled = true;
          return s;
        });
        if (enableOutcome.notFound) return this.accounts(id);
        if (enableOutcome.banned) return this.say(id, 'هذا الحساب محظور، لا يمكن تفعيله.', 'account');
        if (enableOutcome.captcha) return this.say(id, 'هذا الحساب يتطلب حل التحدي الأمني (كابتشا) يدوياً عبر موقع X أولاً، ثم الضغط على "تم الحل" للتحقق.', 'account');
        if (enableOutcome.unverified) return this.say(id, 'جلسة هذا الحساب غير مؤكدة؛ يرجى فحص الحساب عبر موقع X وتحديث الكوكيز قبل التفعيل.', 'account');
        if (enableOutcome.limitExceeded) return this.say(id, 'تجاوزت الحد للحسابات المفعلة (الحد الأقصى 5).', 'account');
        return this.account(id);
      }
      if (text === 'تعديل الاسم') { await this.ui.page(id, 'account', 'rename'); return this.say(id, 'اكتب الاسم الذي سيظهر في قائمة الحسابات.'); }
      if (text === 'حذف الحساب') return this.confirm(id, 'deleteConfirm', `حذف ${account.label} من قائمة الحسابات؟ ستبقى السجلات التاريخية محفوظة.`, { id: account.id });
      if (text === 'فحص جلسة X' || text === 'فحص VPN وIP') {
        if (!this.isolatedVerifier) return this.say(id, 'تعذر الفحص: بيئة VPN المعزولة للحساب غير مهيأة؛ لم يُستخدم اتصال المضيف.', 'account');
        try {
          const isSession = text === 'فحص جلسة X';
          const r = isSession ? await this.isolatedVerifier.verify(account) : await this.isolatedVerifier.health(account);
          await this.ui.recordAccountCheck(account.id, r, { session: isSession, source: isSession ? 'x-session' : 'vpn-health', expectedAccount: account });
          if (isSession) {
            const isSuspendedOrBanned = r?.suspended === true || r?.banned === true ||
              ['banned', 'suspended', 'suspended_confirmed'].includes(String(r?.accountFailure || '').toLowerCase());
            if (isSuspendedOrBanned) return this.say(id, '⛔ تعليق/حظر مثبت لهذا الحساب على منصة X.', 'account');
            if (r?.captcha === true || r?.challenge === true || r?.accountFailure === 'captcha') return this.say(id, '⚠️ الحساب يتطلب حل تحدي أمني (كابتشا).', 'account');
            return this.say(id, r?.authenticated ? '✅ جلسة X صالحة وموثقة.' : '⚠️ جلسة X غير صالحة؛ يرجى تحديث ملف الكوكيز.', 'account');
          }
          const publicIp = require('./publicIp').isPublicIp(r?.exitIp || r?.ip) ? (r.exitIp || r.ip) : null;
          return this.say(id, r?.isolated && r?.vpnHealthy && publicIp ? `✅ مسار VPN سليم وموثق. IP: ${publicIp}` : '⚠️ فشل التحقق من مسار VPN المعزول.', 'account');
        }
        catch (err) {
          logStructured(this.bot?.logger, {
            level: 'error',
            component: 'telegram_flows',
            event: 'isolated_account_check_failed',
            accountId: account.id,
            operation: text === 'فحص جلسة X' ? 'verify' : 'health',
            result: 'failed',
            errorCode: extractErrorCode(err),
            sanitizedError: sanitizeError(err)
          });
          const isSession = text === 'فحص جلسة X';
          await this.ui.recordAccountCheck(account.id, { transientError: true, lastError: sanitizeError(err) }, { session: isSession, source: isSession ? 'x-session' : 'vpn-health', expectedAccount: account });
          return this.say(id, 'تعذر الفحص. حاول لاحقاً.', 'account');
        }
      }
    }
    if (u.prompt?.endsWith('Confirm')) return this.say(id, 'اختر تأكيد أو اضغط رجوع.', 'confirm');
    return null;
  }
}
module.exports = { TelegramFlows, extractUsernameHint };
