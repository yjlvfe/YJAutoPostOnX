'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { accountCapacity, quotaAdmission } = require('./quota');
const { DEFAULT_SETTINGS, parseDuration, formatDuration } = require('./settings');
const { TelegramFlows } = require('./telegramFlows');
const { preTable, richTable, accountStatus } = require('./accountTable');

const formatHms = seconds => {
  if (!Number.isFinite(seconds)) return '-';
  const n = Math.max(0, Math.ceil(seconds));
  return `${String(Math.floor(n / 3600)).padStart(2, '0')}:${String(Math.floor((n % 3600) / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
};
const durationText = seconds => formatHms(seconds);
const token = () => crypto.randomBytes(12).toString('hex');
const cycleRunning = state => ['running', 'stopping'].includes(state?.cycle?.state);
const validText = value => typeof value === 'string' && value.trim() && true;
const eligible = account => account.enabled !== false && typeof account.username === 'string' && account.username.trim() && typeof account.cookieFile === 'string' && account.cookieFile.trim();
const validSettings = settings => Number.isSafeInteger(settings.delayMs) && settings.delayMs >= 0 && (settings.dailyQuota == null || (Number.isSafeInteger(settings.dailyQuota) && settings.dailyQuota > 0));

class TelegramUi {
  constructor({ bot, runtimeReady = async () => ({ ready: false, reasons: ['مكونات النشر الفعلي غير جاهزة'] }), launch, clock = () => new Date(), inlineStyles = true, downloadDocument, isolatedVerifier, onCycleFinished, onCycleStop, onPanelTask, notify }) {
    this.bot = bot; this.runtimeReady = runtimeReady; this.launch = launch; this.clock = clock; this.inlineStyles = inlineStyles;
    this.onPanelTask = typeof onPanelTask === 'function' ? onPanelTask : null;
    this.notify = notify; this.onCycleFinished = onCycleFinished; this.onCycleStop = onCycleStop; this.job = null; this.panelLocks = new Map(); this.actionLocks = new Map(); this.refreshTask = null;
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
    for (const name of ['menu', 'work', 'settings', 'accounts', 'scheduleMenu', 'delayMenu', 'quotaMenu', 'posts', 'back', 'input', 'cycleControl', 'document', 'flowControl', 'accountControl', 'unknownCallback', 'navControl']) {
      a[name] = (request, raw) => {
        const key = this.identity(raw).key;
        const priorityStop = name === 'cycleControl' && request.parsed?.action === 'stop';
        const previous = priorityStop ? Promise.resolve() : this.actionLocks.get(key) || Promise.resolve();
        const task = previous.catch(() => {}).then(() => this[name](request, raw)).catch(async error => {
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

  async scheduleMenu(_, raw) { return this.show(this.identity(raw), 'schedule', 'وقت الجدولة بتوقيت مكة. لتغييره اختر تحديد الموعد.'); }
  async delayMenu(_, raw) {
    const s = await this.bot.settings.get();
    return this.show(this.identity(raw), 'delay', `التأخير: ${formatDuration(s.delayMinSeconds)} إلى ${formatDuration(s.delayMaxSeconds)}. اختر الحد لتعديله. الحد المطلق 60:00. تخضع الإرسالات لضابط أمان مستقل لا يقل عن 15 ثانية.`);
  }
  async quotaMenu(_, raw) { return this.show(this.identity(raw), 'quota', 'أرسل الحصة اليومية لكل حساب، رقماً صحيحاً أكبر من صفر.', 'quota'); }
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
    if (u.page === 'delay' && u.prompt) return this.delayMenu(_, raw);
    if (u.page === 'schedule' && u.prompt) return this.scheduleMenu(_, raw);
    if (['accounts', 'schedule', 'delay', 'quota'].includes(u.page)) {
      return this.settings(_, raw);
    }
    return this.menu(_, raw);
  }
  async input(_, raw) {
    const id = this.identity(raw); const text = String(raw.message?.text || raw.message?.caption || '').trim();
    const u = await this.flows.user(id);
    if ((text === 'رجوع' || text === 'إلغاء') && ['delay', 'quota', 'schedule', 'posts', 'cookies'].includes(u.page)) { await this.flows.cleanup(id); return ['posts', 'cookies'].includes(u.page) ? this.menu(_, raw) : u.page === 'delay' ? this.delayMenu(_, raw) : u.page === 'schedule' ? this.scheduleMenu(_, raw) : this.settings(_, raw); }
    const flow = await this.flows.input(id, text); if (flow !== null) return flow;
    try {
      if (u.page === 'delay' && ['الحد الأدنى', 'الحد الأعلى'].includes(text)) return this.show(id, 'delay', 'أدخل المدة بصيغة دقائق:ثوانٍ مثل 0:4 أو 1:59؛ الحد 60:00.', text === 'الحد الأدنى' ? 'delayMin' : 'delayMax');
      if (u.prompt === 'delayMin' || u.prompt === 'delayMax') {
        const seconds = parseDuration(text); const s = await this.bot.settings.get();
        await this.bot.settings.setDelayRange({ minSeconds: u.prompt === 'delayMin' ? seconds : s.delayMinSeconds, maxSeconds: u.prompt === 'delayMax' ? seconds : s.delayMaxSeconds });
        return this.delayMenu(_, raw);
      }
      if (u.prompt === 'quota') {
        if (!/^\d+$/.test(text) || !Number.isSafeInteger(+text) || +text < 1) throw new Error('أدخل حصة صحيحة أكبر من صفر، مثل 10.');
        await this.bot.settings.setQuota(+text); return this.show(id, 'quota', 'تم حفظ الحصة اليومية.', 'quota');
      }
      if (u.page === 'schedule') {
        if (text === 'تحديد الموعد') return this.show(id, 'schedule', 'أدخل موعد مكة بصيغة 09:30.', 'schedule');
        if (text === 'تعطيل الجدولة') return this.flows.confirm(id, 'disableScheduleConfirm', 'تأكيد تعطيل الجدولة؟', {});
        if (text === 'تفعيل الجدولة') { await this.bot.settings.setSchedule({ enabled: text === 'تفعيل الجدولة' }); return this.show(id, 'schedule', 'تم حفظ حالة الجدولة؛ التشغيل مشروط بالجاهزية.'); }
        if (u.prompt === 'schedule') { const m = /^(\d{1,2}):(\d{2})$/.exec(text); if (!m || +m[1] > 23 || +m[2] > 59) throw new Error('أدخل موعداً صحيحاً مثل 09:30.'); await this.bot.settings.setSchedule({ enabled: true, hour: +m[1], minute: +m[2] }); return this.show(id, 'schedule', 'تم حفظ الموعد بتوقيت مكة.'); }
      }
      return this.bot.transport.sendMessage(id.chat, 'اختر من الأزرار الحالية أو اضغط رجوع.', { reply_markup: this.bot.transport.keyboard(u.page || 'main') });
    } catch (error) {
      const message = /[\u0600-\u06ff]/.test(error.message || '') ? error.message : 'قيمة غير صحيحة: استخدم دقائق:ثوانٍ حتى 60:00، والثواني 0–59، والحد الأعلى لا يقل عن الأدنى. مثال 0:4.';
      return this.bot.transport.sendMessage(id.chat, message, { reply_markup: this.bot.transport.keyboard('waiting') });
    }
  }
  async restore() {
    let snapshot; let stopping = false;
    await this.bot.store.update(s => {
      s.telegramUi ||= {}; s.telegramUi.dashboards ||= {};
      for (const u of Object.values(s.telegramUi.users || {})) {
        if (u.panel?.messageId != null && u.chatId != null) {
          const key = String(u.chatId); const old = s.telegramUi.dashboards[key];
          if (!old || Number(u.panel.messageId) > Number(old.messageId)) s.telegramUi.dashboards[key] = { ...u.panel, chatId: u.chatId };
        }
        if (u.prompt === 'cookieConfirm') { u.prompt = 'cookies'; u.flowToken = null; }
      }
      for (const [key, dashboard] of Object.entries(s.telegramUi.dashboards)) {
        dashboard.token = token(); dashboard.signature = null;
        for (const u of Object.values(s.telegramUi.users || {})) if (String(u.chatId) === key) u.panel = { ...dashboard };
      }
      for (const item of s.items || []) if (item.state === 'processing' || item.state === 'dispatch_started') {
        if (item.state === 'processing' && item.attempt?.phase === 'claimed') { item.state = 'pending'; delete item.attempt; }
        else item.state = 'ambiguous';
      }
      if (['running', 'stopping'].includes(s.cycle?.state)) {
        const run = s.telegramUi.run;
        const valid = run && typeof run.runId === 'string' && run.runId && run.runId === s.cycle.runId && Array.isArray(run.itemIds) && run.itemIds.length && Array.isArray(run.accountIds) && run.accountIds.length && run.itemIds.every(id => (s.items || []).some(x => x.id === id)) && run.accountIds.every(id => (s.accounts || []).some(x => x.id === id));
        const unsafe = (s.items || []).some(x => x.state === 'ambiguous');
        stopping = s.cycle.state === 'stopping';
        if (valid && !unsafe && !stopping) snapshot = structuredClone(run);
        else { if (valid && stopping) snapshot = structuredClone(run); s.cycle = { ...s.cycle, state: 'stopped', runId: null, reason: unsafe ? 'توجد محاولة غير محسومة' : 'توقفت الدورة بعد إعادة التشغيل' }; }
      }
      return s;
    });
    if (stopping && snapshot) { if (this.onCycleFinished) await this.onCycleFinished(snapshot); return {}; }
    if (snapshot) {
      const state = await this.bot.store.load();
      const hasPending = (state.items || []).some(x => snapshot.itemIds.includes(x.id) && x.state === 'pending');
      const quotaAvailable = snapshot.accountIds.some(id => { const account = (state.accounts || []).find(a => a.id === id); return account && accountCapacity(state, account, this.clock()).remaining > 0; });
      if (hasPending && quotaAvailable) {
        const ready = await this.readiness(state);
        if (ready.reasons.length) { await this.bot.store.update(s => { if (s.cycle?.runId === snapshot.runId) s.cycle = { ...s.cycle, state: 'stopped', runId: null, reason: ready.reasons.join('، ') }; return s; }); return {}; }
      }
      return { resume: snapshot };
    }
    return {};
  }
  async stopTicker() { if (this.ticker) { clearInterval(this.ticker); this.ticker = null; } if (this.refreshTask) await this.refreshTask.catch(() => {}); await Promise.allSettled([...this.panelLocks.values()]); }
  async destroy() { await this.stopTicker(); }
  controls(state, t) {
    const running = ['running', 'stopping'].includes(state);
    return { inline_keyboard: [[{ text: running ? '🔴 إيقاف' : '🟢 تشغيل', callback_data: `cycle:${running ? 'stop' : 'start'}:${t}`, ...(this.inlineStyles ? { style: running ? 'danger' : 'success' } : {}) }]] };
  }
  async readiness(state) {
    const reasons = [];
    const accounts = (state.accounts || []).filter(eligible);
    const accessible = [];
    for (const a of accounts) { try { await fs.access(a.cookieFile); accessible.push(a); } catch {} }
    if (!accessible.length) reasons.push('لا يوجد حساب مفعل باسم مستخدم وملف جلسة قابل للقراءة');
    if ((state.items || []).some(x => ['processing', 'ambiguous', 'dispatch_started'].includes(x.state))) reasons.push('توجد محاولة سابقة قيد التنفيذ أو غير محسومة');
    const pinned = (state.items || []).filter(x => x.state === 'pending' && x.payload?.account);
    if (pinned.some(x => !accessible.some(a => a.id === x.payload.account))) reasons.push('يوجد منشور مرتبط بحساب غير مؤهل');
    if (!(state.items || []).some(x => x.state === 'pending' && validText(x.payload?.text))) reasons.push('لا توجد منشورات صالحة في الانتظار');
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
    const active = (state.accounts || []).filter(a => eligible(a) && accountStatus(a, accountCapacity(state, a, this.clock()), state.telegramUi?.accountChecks?.[a.id], this.clock()) === 'فعال').length;
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
    const status = running ? `قيد التشغيل (منذ ${elapsed} ثانية)` : state.cycle?.reason === 'daily_quota_exhausted' ? 'متوقف — الكوتا اليومية ممتلئة' : 'متوقف';
    const delay = Math.max(15, ((settings.delayMinSeconds ?? 15) + (settings.delayMaxSeconds ?? 30)) / 2);
    const wait = Number.isFinite(next) ? Math.max(0, (next - new Date(this.clock()).getTime()) / 1000) : 0;
    const estimate = running ? durationText(remaining ? wait + Math.max(0, remaining - 1) * delay : 0) : '-';
    const publishing = running && state.posting?.publishingAt ? new Date(state.posting.publishingAt).getTime() : NaN;
    const nextLine = Number.isFinite(publishing) ? `جاري النشر الآن... (${Math.max(0, Math.floor((new Date(this.clock()).getTime() - publishing) / 1000))} ث)` : countdown;
    const queueTotal = items.filter(x => x.state === 'pending').length;

    return richTable(['البند', 'القيمة'], [
      ['حالة العمل', status],
      ['المنشورات في الطابور', String(queueTotal)],
      ['المنشورات الناجحة', String(published)],
      ['الحسابات الفعالة', `${active}/5`],
      ['المنشور التالي بعد', nextLine],
      ['الوقت المقدر للانتهاء', estimate]
    ], 'لوحة التحكم والتشغيل');
  }
  async panel(id, force = false, fresh = false) {
    const lockKey = String(id.chat);
    const previous = this.panelLocks.get(lockKey) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      let s = await this.bot.store.load(); let u = s.telegramUi?.users?.[id.key]; if (!u) return;
      const current = s.telegramUi?.dashboards?.[lockKey] || u.panel;
      const t = current?.token || token(); const text = await this.render(s);
      const extra = { rich_message: { html: text }, reply_markup: this.controls(s.cycle?.state, t) };
      const signature = JSON.stringify({ text, markup: extra.reply_markup });
      if (!force && current?.signature === signature) return;
      if (!fresh && current?.messageId) {
        try {
          await this.bot.transport.editMessageText(id.chat, current.messageId, text, extra);
          await this.bot.store.update(next => { const dashboard = next.telegramUi.dashboards?.[lockKey]; if (dashboard?.messageId === current.messageId) dashboard.signature = signature; for (const entry of Object.values(next.telegramUi.users || {})) if (String(entry.chatId) === lockKey && entry.panel?.messageId === current.messageId) entry.panel.signature = signature; return next; });
          return;
        }
        catch (error) {
          if (/message is not modified/i.test(error.message || '')) {
            await this.bot.store.update(next => { const dashboard = next.telegramUi.dashboards?.[lockKey]; if (dashboard?.messageId === current.messageId) dashboard.signature = signature; for (const entry of Object.values(next.telegramUi.users || {})) if (String(entry.chatId) === lockKey && entry.panel?.messageId === current.messageId) entry.panel.signature = signature; return next; });
            return;
          }
          if (!(error.telegramCode === 400 && /message to edit not found|message can't be edited/i.test(error.message || ''))) throw error;
        }
      }
      const sent = await this.bot.transport.sendMessage(id.chat, text, extra); const messageId = sent?.message_id;
      if (messageId == null) throw new Error('Telegram panel message id missing');
      await this.bot.store.update(next => {
        const entry = next.telegramUi.users[id.key];
        const panel = { messageId, token: t, signature };
        for (const user of Object.values(next.telegramUi.users || {})) {
          if (String(user.chatId) === String(id.chat)) user.panel = { ...panel };
        }
        entry.panel = panel;
        next.telegramUi.dashboards ||= {};
        next.telegramUi.dashboards[String(id.chat)] = { ...panel, chatId: id.chat };
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
  async settings(_, raw) { const id = this.identity(raw); await this.flows.cleanup(id); return this.show(id, 'settings', 'الإعدادات'); }
  async accounts(_, raw) { const id = this.identity(raw); await this.flows.cleanup(id); return this.flows.accounts(id); }
  refreshPanels(force = false) {
    if (this.refreshTask) return this.refreshTask;
    const task = (async () => {
      const s = await this.bot.store.load();
      const seen = new Set(); const tasks = [];
      for (const [key, u] of Object.entries(s.telegramUi?.users || {})) {
        if (u.panel && !seen.has(String(u.chatId))) { seen.add(String(u.chatId)); tasks.push(this.panel({ key, chat: u.chatId, user: u.userId }, force)); }
      }
      await Promise.all(tasks);
    })();
    // A single canonical promise is shared by callers and the lifecycle observer.
    const tracked = task.finally(() => { if (this.refreshTask === tracked) this.refreshTask = null; });
    this.refreshTask = tracked;
    this.onPanelTask?.(tracked);
    return tracked;
  }
  async recordAccountCheck(accountId, result = {}, { session = false, source = 'isolated-verifier' } = {}) {
    if (!['isolated-verifier', 'vpn-slot-manager'].includes(source)) throw new TypeError('Unknown account check source');
    const checkedAt = new Date(this.clock()).toISOString();
    const isolated = result.isolated === true;
    const healthy = isolated && result.vpnHealthy === true;
    const rawIp = result.exitIp || result.ip;
    const ip = healthy && require('node:net').isIP(rawIp || '') ? rawIp : null;
    await this.bot.store.update(s => {
      s.telegramUi ||= {}; s.telegramUi.accountChecks ||= {};
      const checks = s.telegramUi.accountChecks[accountId] ||= {};
      checks.vpn = { checkedAt, source, isolated, healthy, ip };
      if (session) checks.session = { checkedAt, source, isolated, authenticated: isolated && result.authenticated === true, username: /^[A-Za-z0-9_]{1,15}$/.test(result.username || '') ? result.username : null,
        ...Object.fromEntries(['challenge', 'locked', 'captcha', 'suspended', 'banned'].map(flag => [flag, isolated && result[flag] === true])) };
      return s;
    });
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
      if (['running', 'stopping'].includes(s.cycle?.state) || this.job) return s;
      if (id && s.telegramUi?.users?.[id.key]?.panel?.token !== suppliedToken) return s;
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
      for (const [chatId, dashboard] of Object.entries(s.telegramUi.dashboards)) {
        const nextToken = token(); dashboard.token = nextToken;
        for (const u of Object.values(s.telegramUi.users || {})) if (String(u.chatId) === chatId && u.panel) u.panel.token = nextToken;
      }
      for (const u of Object.values(s.telegramUi.users || {})) if (u.panel && !s.telegramUi.dashboards[String(u.chatId)]) u.panel.token = token();
      snapshot = structuredClone(s.telegramUi.run); started = true; return s;
    });
    if (blockedQuota) return this.rejectQuota(blockedQuota, id);
    if (!started) return { started: false, reasons: ['الدورة جارية أو الزر قديم أو تغيرت البيانات'] };
    this.attach(snapshot);
    await this.refreshPanels(true); return { started: true, runId };
  }
  attach(snapshot) {
    if (this.job) return false;
    const runId = snapshot.runId;
    const task = Promise.resolve().then(() => this.launch(snapshot)).then(async () => {
      await this.bot.store.update(s => { if (s.cycle?.runId === runId) s.cycle = { ...s.cycle, state: 'stopped', runId: null, reason: s.cycle.state === 'stopping' ? 'تم إيقاف الدورة' : s.cycle.reason || 'انتهت الدورة' }; return s; });
    }, async () => {
      await this.bot.store.update(s => { if (s.cycle?.runId === runId) s.cycle = { ...s.cycle, state: 'error', runId: null, reason: 'تعذر إكمال الدورة' }; return s; });
    }).finally(async () => { if (this.onCycleFinished) await this.onCycleFinished(snapshot).catch(() => {}); if (this.job === task) this.job = null; await this.refreshPanels(true).catch(() => {}); });
    this.job = task; return true;
  }
  async resume(snapshot) {
    const state = await this.bot.store.load();
    if (!snapshot?.runId || state.cycle?.state !== 'running' || state.cycle.runId !== snapshot.runId || state.telegramUi?.run?.runId !== snapshot.runId || (state.items || []).some(x => ['ambiguous', 'processing', 'dispatch_started'].includes(x.state))) return { started: false };
    const started = this.attach(structuredClone(state.telegramUi.run));
    return { started, runId: snapshot.runId };
  }
  async startScheduled() { return this.begin('scheduled'); }
  async accountControl(_, raw) {
    // Old unscoped inventory callbacks cannot navigate or mutate accounts.
    return this.unknownCallback(null, raw);
  }

  async cycleControl(request, raw) {
    const id = this.identity(raw); const parsed = request.parsed || {}; const state = await this.bot.store.load(); const panel = state.telegramUi?.users?.[id.key]?.panel;
    const latest = state.telegramUi?.dashboards?.[String(id.chat)] || panel;
    const acknowledge = (text, alert = false) => request.acknowledge ? request.acknowledge(text, alert) : raw.callback_query?.id ? this.bot.transport.acknowledgeCallback(raw.callback_query.id, text, alert) : Promise.resolve();
    if (!panel || !latest || panel.token !== parsed.value || latest.token !== parsed.value || latest.messageId !== raw.callback_query?.message?.message_id) {
      if (parsed.action === 'start') await acknowledge();
      await this.bot.transport.sendMessage(id.chat, 'هذا الزر قديم. افتح بدء العمل لعرض التحكم الحالي.', { reply_markup: this.bot.transport.keyboard('main') });
      return { stale: true };
    }
    if (parsed.action === 'refresh') return this.panel(id, true);
    if (parsed.action === 'start' && cycleRunning(state)) { await acknowledge(); return { started: false, running: true }; }
    if (parsed.action === 'start') {
      const ready = await this.readiness(state);
      if (ready.quota?.exhausted) { await acknowledge(); return this.rejectQuota(ready.quota, id); }
      if (ready.reasons.length) { await acknowledge('لا يمكن البدء: يرجى إضافة حساب واحد على الأقل ورفع ملف المنشورات أولاً\n' + ready.reasons.join('، '), true); return { started: false }; }
      await acknowledge(); return this.begin('manual', id, parsed.value);
    }
    if (parsed.action === 'stop') { await this.stop(parsed.value, id); await this.refreshPanels(true); return; }
  }
  async stop(expectedToken, id) {
    let accepted = false; let snapshot;
    await this.bot.store.update(s => { if (id && s.telegramUi?.users?.[id.key]?.panel?.token !== expectedToken) return s; if (s.cycle?.state === 'running') { s.cycle.state = 'stopping'; snapshot = structuredClone(s.telegramUi.run); accepted = true; } return s; });
    if (!id) await this.stopTicker();
    if (!accepted) return { stopped: false };
    // Signal cancellation synchronously; never wait for an in-flight browser job.
    this.onCycleStop?.(snapshot);
    this.refreshPanels(true).catch(() => {});
    return { stopped: true };
  }
}
module.exports = { TelegramUi };
