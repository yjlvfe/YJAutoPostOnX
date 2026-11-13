'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { logStructured, sanitizeError, extractErrorCode } = require('./structuredLogger');
const { randomUUID } = crypto;

function dayOf(value) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
}
function canonicalLink(value) {
  try {
    const u=new URL(value);
    if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.port||!['x.com','www.x.com','mobile.x.com','twitter.com','www.twitter.com','mobile.twitter.com'].includes(u.hostname.toLowerCase()))return null;
    const m=/^\/(?:([A-Za-z0-9_]{1,15})\/status|i\/web\/status)\/(\d+)(?:\/(?:photo|video)\/\d+)?\/?$/.exec(u.pathname);
    return m ? {id:m[2],url:'https://x.com/'+(m[1]||'i/web')+'/status/'+m[2]} : null;
  }catch{return null;}
}
function isIsoDay(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(new Date(value + 'T12:00:00+03:00').getTime());
}
function trimLinkDeliveries(deliveries, outbox, maxHistory) {
  if (!Array.isArray(deliveries) || deliveries.length <= maxHistory) return deliveries;
  const outboxById = new Map();
  const outboxRunChats = new Set();
  for (const entry of outbox || []) {
    if (!entry) continue;
    if (entry.outboxId) outboxById.set(entry.outboxId, entry);
    if (entry.runId) outboxRunChats.add(`${entry.runId}:${String(entry.chatId ?? '')}`);
  }
  const isNeeded = record => {
    if (!record) return false;
    if (record.outboxId && outboxById.has(record.outboxId)) {
      const entry = outboxById.get(record.outboxId);
      return record.ok === true || entry.deliveryId === record.deliveryId || entry.status !== 'delivered';
    }
    return record.ok === true && !!record.runId && outboxRunChats.has(`${record.runId}:${String(record.chatId ?? '')}`);
  };
  const cutoff = deliveries.length - maxHistory;
  return deliveries.filter((record, index) => index >= cutoff || isNeeded(record));
}
function csv(rows) {
  const seen=new Set(),urls=[];
  for(const row of rows){const link=canonicalLink(row.url);if(!link||seen.has(link.id))continue;seen.add(link.id);urls.push(link.url);}
  return urls.length ? urls.join('\r\n')+'\r\n' : '';
}
function isPublished(item) {
  return item.state === 'published' && item.id != null && item.url && item.publishedAt && Number.isFinite(new Date(item.publishedAt).getTime());
}
function dailyRows(state, day, through) {
  const seen = new Set();
  const upperBound = through === undefined ? Infinity : new Date(through).getTime();
  return [...(state.items || []),...(state.manualLinks || [])].filter(x =>
    isPublished(x) && dayOf(x.publishedAt) === day && new Date(x.publishedAt).getTime() <= upperBound
  )
    .sort((a, b) => new Date(a.publishedAt) - new Date(b.publishedAt) || String(a.id).localeCompare(String(b.id)))
    .filter(row => {
      // Link exports deduplicate canonical X post IDs, not URL spelling.
      const key = canonicalLink(row.url)?.id || String(row.id);
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
}
function createLinkExports({ store, dataDir, api, chatId, chatIds, dailyChatId, logger = console, clock = () => new Date() }) {
  // Persisted recipients are obligations, never authorization. Revoked recipients
  // stay on disk but cannot be contacted by this instance.
  const destinations = [...new Set([...(chatIds || []), chatId].filter(id => id !== undefined && id !== null).map(String))];
  const dailyTarget = dailyChatId ?? destinations[0];
  const targetDestinations = dailyTarget == null ? [] : destinations.filter(d => d === String(dailyTarget));
  let chain = Promise.resolve();
  const serialize = fn => { const next = chain.then(fn); chain = next.catch(() => {}); return next; };
  const flights = new Map();
  // Coalesce identical drain requests before serialization, rather than queueing
  // another batch for every poll while transport is still in flight.
  function singleFlight(key, fn) {
    if (flights.has(key)) return flights.get(key);
    const flight = serialize(fn);
    flight.finally(() => { flights.delete(key); }).catch(() => {});
    flights.set(key, flight);
    return flight;
  }
  const DRAIN_CONCURRENCY = 4;
  const DRAIN_BATCH_SIZE = 32;

  /**
   * Return today's confirmed links as a read-only CSV descriptor.
   * Shape: { filename: `links_${riyadhDate}.csv`, content: string, empty: boolean }.
   * Content is one canonical URL per CRLF-terminated row, with no header/BOM;
   * `empty` is true exactly when content is empty. Optional `at` accepts a
   * Date, epoch milliseconds, or date string (default: clock()); invalid dates
   * reject with TypeError. Includes Riyadh midnight through `at`, both inclusive.
   * Reads one store snapshot only: no state/filesystem writes or network sends.
   * Uses confirmed items/manualLinks and document outbox snapshots, deduped by
   * canonical post ID in publication-time/record-ID order.
   */
  async function exportToday({ at = clock() } = {}) {
    const end = new Date(at);
    if (!Number.isFinite(end.getTime())) throw new TypeError('exportToday.at must be a valid date');
    const day = dayOf(end);
    const state = await store.load();
    // Retain confirmed post snapshots just as daily reporting does; delivery
    // status is unrelated to whether the post itself was confirmed.
    const content = csv(dailyRows({ ...state, items: [
      ...(state.items || []),
      ...(state.linkOutbox || []).filter(entry => entry.kind === 'document' && entry.day === day).flatMap(entry => entry.rows || [])
    ] }, day, end.getTime()));

    return { filename: `links_${day}.csv`, content, empty: content.length === 0 };
  }

  async function writeDay(day, state) {
    const rows = dailyRows(state, day);
    const filename = `links_${day}.csv`; const content = csv(rows);
    const dir = path.join(dataDir, 'exports'); await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = path.join(dir, `.${filename}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temp, content, { mode: 0o600 }); await fs.rename(temp, path.join(dir, filename));
    } finally { await fs.rm(temp, { force: true }); }
    return { filename, content };
  }

  // Discovery is independent of current run metadata: a crash may have lost the
  // completion hook, or a later run may already have replaced its snapshot.
  async function enqueue(run, { emptyMessage = false } = {}) {
    return store.update(state => {
      state.linkOutbox ||= [];
      const ids = run ? new Set(run.itemIds || []) : null;
      const rows = (state.items || []).filter(item => isPublished(item) && (!ids || ids.has(item.id)));
      for (const destination of destinations) {
        const covered = new Set(state.linkOutbox.filter(entry => entry.kind === 'document' && String(entry.chatId) === destination).flatMap(entry => entry.itemIds || []));
        const groups = new Map();
        for (const row of rows) {
          if (covered.has(row.id)) continue;
          covered.add(row.id);
          // Compatibility: older ledgers without chatId belonged to the first
          // configured destination. Do not extend their coverage to other chats.
          const legacy = (state.linkDeliveries || []).filter(entry => String(entry.chatId ?? destinations[0]) === destination && (entry.itemIds || []).includes(row.id));
          const receipt = legacy.find(entry => entry.ok);
          const uncertain = legacy.find(entry => entry.attempted && !entry.ok);
          const status = receipt ? 'delivered' : uncertain ? 'ambiguous' : 'pending';
          const day = dayOf(row.publishedAt), key = `${day}:${status}`;
          if (!groups.has(key)) groups.set(key, { day, status, rows: [] });
          groups.get(key).rows.push(row);
        }
        for (const group of groups.values()) {
          state.linkOutbox.push({ outboxId: randomUUID(), runId: run?.runId || 'reconciled', day: group.day,
            kind: 'document', chatId: destination, itemIds: group.rows.map(row => row.id),
            rows: structuredClone(group.rows), status: group.status, attempts: 0, createdAt: new Date().toISOString() });
        }
        if (!rows.length && run && emptyMessage) {
          const exists = state.linkOutbox.some(entry => entry.kind === 'empty' && entry.runId === run.runId && String(entry.chatId) === destination);
          if (!exists) {
            const legacy = (state.linkDeliveries || []).filter(entry => entry.runId === run.runId && entry.kind === 'empty' && String(entry.chatId ?? destinations[0]) === destination);
            state.linkOutbox.push({ outboxId: randomUUID(), runId: run.runId, day: 'empty', kind: 'empty', chatId: destination,
              itemIds: [], rows: [], status: legacy.some(entry => entry.ok) ? 'delivered' : legacy.some(entry => entry.attempted) ? 'ambiguous' : 'pending',
              attempts: 0, createdAt: new Date().toISOString() });
          }
        }
      }
      return state;
    });
  }

  const MAX_LINK_HISTORY = 200;

  // A terminal obligation belongs to a session-stop event, not to individual
  // new rows. Even a failed session owes today's previously confirmed history.
  async function enqueueTerminal(run) {
    if (!run?.runId) return { queued: false, suppressed: false, reason: 'missing_run_id' };
    let outcome = { queued: false, suppressed: false, reason: null };
    await store.update(state => {
      outcome = { queued: false, suppressed: false, reason: null };
      const pending = state.telegramUi?.pendingReport;
      const day = dayOf(run.endedAt || (pending?.runId === run.runId && pending.endedAt) || clock());
      state.linkOutbox ||= [];
      state.linkTerminalEvents ||= [];
      // Do not publish a terminal report if its terminal-state commit failed.
      if (['running', 'stopping'].includes(state.cycle?.state) && state.cycle.runId === run.runId) {
        outcome = { queued: false, suppressed: false, reason: 'cycle_still_active' };
        return state;
      }
      if (state.telegramUi?.pendingReport?.runId === run.runId) delete state.telegramUi.pendingReport;
      let queuedAny = false;
      let suppressedAny = false;
      for (const destination of destinations) {
        // Idempotency per (destination, runId): prevent duplicate sends on replay of same runId
        const existingEvent = (state.linkTerminalEvents || []).find(event => event.runId === run.runId && String(event.chatId) === destination);
        const alreadyDelivered = (state.linkDeliveries || []).some(entry =>
          entry.runId === run.runId && String(entry.chatId) === destination && entry.ok
        );
        const alreadyOutbox = (state.linkOutbox || []).some(entry =>
          entry.runId === run.runId && String(entry.chatId) === destination
        );

        if (existingEvent || alreadyDelivered || alreadyOutbox) {
          suppressedAny = true;
          logStructured(logger, {
            level: 'info',
            component: 'link_exports',
            event: 'link_export_terminal_suppressed',
            runId: run.runId,
            chatId: destination,
            day,
            operation: 'enqueueTerminal',
            result: 'suppressed',
            reason: 'duplicate_run_id',
            suppressionReason: 'duplicate_run_id'
          });
          continue;
        }

        const rows = dailyRows({ manualLinks:state.manualLinks, items: [
          ...(state.items || []),
          ...state.linkOutbox.filter(entry => entry.kind === 'document' && entry.day === day).flatMap(entry => entry.rows || [])
        ] }, day);

        if (!rows.length) {
          state.linkTerminalEvents.push({ runId: run.runId, chatId: destination, day, reconciled: true, reason: 'empty_rows' });
          const hasEmptyOutbox = (state.linkOutbox || []).some(entry =>
            entry.runId === run.runId && String(entry.chatId) === destination && entry.kind === 'empty'
          );
          if (!hasEmptyOutbox) {
            queuedAny = true;
            state.linkOutbox.push({
              outboxId: randomUUID(),
              runId: run.runId,
              terminalId: run.runId,
              day,
              kind: 'empty',
              chatId: destination,
              itemIds: [],
              rows: [],
              status: 'pending',
              attempts: 0,
              text: 'لا توجد روابط منشورات مؤكدة لهذا اليوم.',
              createdAt: new Date(clock()).toISOString()
            });
          }
          continue;
        }

        const content = csv(rows);
        const contentHash = crypto.createHash('sha256').update(content).digest('hex');

        queuedAny = true;
        state.linkTerminalEvents.push({ runId: run.runId, chatId: destination, day, reconciled: false, contentHash });
        state.linkOutbox.push({ outboxId: randomUUID(), runId: run.runId, terminalId: run.runId, day,
          kind: 'document', chatId: destination, itemIds: rows.map(row => row.id), rows: structuredClone(rows),
          contentHash, status: 'pending', attempts: 0, createdAt: new Date(clock()).toISOString() });
      }
      if (state.linkTerminalEvents.length > MAX_LINK_HISTORY) {
        state.linkTerminalEvents = state.linkTerminalEvents.slice(-MAX_LINK_HISTORY);
      }
      if (Array.isArray(state.linkDeliveries)) {
        state.linkDeliveries = trimLinkDeliveries(state.linkDeliveries, state.linkOutbox, MAX_LINK_HISTORY);
      }
      if (suppressedAny && !queuedAny) {
        outcome = { queued: false, suppressed: true, reason: 'duplicate_run_id' };
      } else {
        outcome = { queued: queuedAny, suppressed: false, reason: null };
      }
      return state;
    });
    return outcome;
  }

  async function deliver(outboxId, { idleOnly = false } = {}) {
    let entry;
    const deliveryId = randomUUID();
    let contentHash = null;
    await store.update(state => {
      entry = undefined;
      contentHash = null;
      if (idleOnly && ['running', 'stopping'].includes(state.cycle?.state)) return state;
      const current = (state.linkOutbox || []).find(record => record.outboxId === outboxId);
      if (!current || !destinations.includes(String(current.chatId)) || !['pending', 'retry'].includes(current.status)) return state;
      current.status = 'sending'; current.deliveryId = deliveryId; current.attempts += 1;
      current.attemptedAt = new Date().toISOString();
      state.linkDeliveries ||= [];
      // Freeze the complete durable daily total in this attempt, not just
      // the triggering run's new rows. Delivery coverage remains per new item.
      if (current.kind === 'document' && !current.daily) current.rows = dailyRows({ manualLinks:state.manualLinks, items: [
        ...(state.items || []),
        ...(state.linkOutbox || []).filter(record => record.day === current.day && record.kind === 'document').flatMap(record => record.rows || [])
      ] }, current.day);
      contentHash = current.kind === 'document' ? crypto.createHash('sha256').update(csv(current.rows)).digest('hex') : null;
      current.contentHash = contentHash;
      state.linkDeliveries.push({ deliveryId, outboxId, runId: current.runId, day: current.day, kind: current.kind,
        chatId: current.chatId, itemIds: current.itemIds, contentHash, attempted: true, ok: false, attemptedAt: current.attemptedAt });
      state.linkDeliveries = trimLinkDeliveries(state.linkDeliveries, state.linkOutbox, MAX_LINK_HISTORY);
      entry = structuredClone(current);
      return state;
    });
    if (!entry) return;
    // Fast deduplication check: if identical document has already been successfully delivered for this destination & runId
    if (entry.kind === 'document' && contentHash) {
      const state = await store.load();
      const alreadyDelivered = (state.linkDeliveries || []).some(d =>
        d.ok === true && d.kind === 'document' && d.day === entry.day &&
        String(d.chatId) === String(entry.chatId) &&
        (d.runId === entry.runId || d.outboxId === entry.outboxId) &&
        d.deliveryId !== deliveryId
      );
      if (alreadyDelivered) {
        await store.update(s => {
          const cur = (s.linkOutbox || []).find(r => r.outboxId === outboxId);
          const att = (s.linkDeliveries || []).find(r => r.deliveryId === deliveryId);
          if (cur) { cur.status = 'delivered'; cur.deliveredAt = new Date().toISOString(); }
          if (att) { att.ok = true; att.suppressed = true; att.reason = 'duplicate_run_in_deliver'; }
          return s;
        });
        logStructured(logger, {
          level: 'info',
          component: 'link_exports',
          event: 'telegram_document_delivery_suppressed',
          outboxId,
          runId: entry.runId,
          chatId: entry.chatId,
          day: entry.day,
          operation: 'deliver_document',
          result: 'suppressed',
          reason: 'already_delivered_for_run',
          suppressionReason: 'already_delivered_for_run'
        });
        return;
      }
    }
    if (entry.kind === 'empty') {
      const state = await store.load();
      const alreadyDelivered = (state.linkDeliveries || []).some(d =>
        d.ok === true && d.kind === 'empty' &&
        String(d.chatId) === String(entry.chatId) &&
        (d.runId === entry.runId || d.outboxId === entry.outboxId) &&
        d.deliveryId !== deliveryId
      );
      if (alreadyDelivered) {
        await store.update(s => {
          const cur = (s.linkOutbox || []).find(r => r.outboxId === outboxId);
          const att = (s.linkDeliveries || []).find(r => r.deliveryId === deliveryId);
          if (cur) { cur.status = 'delivered'; cur.deliveredAt = new Date().toISOString(); }
          if (att) { att.ok = true; att.suppressed = true; att.reason = 'duplicate_empty_in_deliver'; }
          return s;
        });
        logStructured(logger, {
          level: 'info',
          component: 'link_exports',
          event: 'telegram_empty_delivery_suppressed',
          outboxId,
          runId: entry.runId,
          chatId: entry.chatId,
          day: entry.day,
          operation: 'deliver_empty',
          result: 'suppressed',
          reason: 'duplicate_empty_in_deliver',
          suppressionReason: 'duplicate_empty_in_deliver'
        });
        return;
      }
    }
    // A persisted 'sending' record is fenced forever after a crash. Telegram
    // offers no idempotency key: absence of a receipt is NOT proof of failure.
    let response;
    try {
      response = entry.kind === 'empty'
        ? await api.sendMessage({ chat_id: entry.chatId, text: entry.text || 'لا توجد روابط منشورات مؤكدة لهذا اليوم.' })
        : await api.sendDocument({ chat_id: entry.chatId, filename: `links_${entry.day}.csv`, content: csv(entry.rows) });
      if ((response?.message_id ?? response?.result?.message_id) == null) throw new Error('Telegram delivery receipt missing');
    } catch (error) {
      logStructured(logger, {
        level: 'error',
        component: 'link_exports',
        event: 'link_export_delivery_failed',
        outboxId,
        runId: entry.runId,
        chatId: entry.chatId,
        day: entry.day,
        operation: entry.kind === 'empty' ? 'sendMessage' : 'sendDocument',
        result: 'failed',
        errorCode: extractErrorCode(error),
        sanitizedError: sanitizeError(error),
        retryCount: entry.attempts
      });
      await store.update(state => {
        const current = (state.linkOutbox || []).find(record => record.outboxId === outboxId && record.deliveryId === deliveryId);
        const attempt = (state.linkDeliveries || []).find(record => record.deliveryId === deliveryId);
        // sendMessage reports parsed Telegram rejections without the document
        // transport's ambiguous:false flag. Only its explicit 4xx API contract
        // proves non-delivery; numeric codes alone or uncertain errors do not.
        const definite = error.code === 'TELEGRAM_API_ERROR' && Number.isInteger(error.telegramCode) &&
          error.telegramCode >= 400 && error.telegramCode < 500;
        if (current) { current.status = definite ? 'retry' : 'ambiguous'; current.telegramCode = error.telegramCode || null; }
        if (attempt) { attempt.attempted = !definite; attempt.definiteFailure = definite; attempt.telegramCode = error.telegramCode || null; }
        return state;
      });
      throw error;
    }
    // Keep receipt persistence outside the transport catch: a DB failure must
    // never be mistaken for a definite network rejection and enable a resend.
    const messageId = response.message_id ?? response.result.message_id;
    await store.update(state => {
      const current = (state.linkOutbox || []).find(record => record.outboxId === outboxId && record.deliveryId === deliveryId);
      const attempt = (state.linkDeliveries || []).find(record => record.deliveryId === deliveryId);
      const deliveredAt = new Date().toISOString();
      if (current) { current.status = 'delivered'; current.messageId = messageId; current.deliveredAt = deliveredAt; }
      if (attempt) { attempt.ok = true; attempt.messageId = messageId; attempt.deliveredAt = deliveredAt; if (contentHash) attempt.contentHash = contentHash; }
      const terminalEvent = (state.linkTerminalEvents || []).find(event => event.runId === current?.runId && String(event.chatId) === String(current?.chatId));
      if (terminalEvent) terminalEvent.reconciled = true;
      return state;
    });
    if(entry.daily&&targetDestinations.length>0&&typeof store.pruneConfirmedDaily==='function')await store.pruneConfirmedDaily({today:dayOf(clock()),chatId:targetDestinations[0]});
    logStructured(logger, {
      level: 'info',
      component: 'link_exports',
      event: entry.kind === 'empty' ? 'telegram_empty_notice_sent' : 'telegram_document_sent',
      operation: entry.kind === 'empty' ? 'sendMessage' : 'sendDocument',
      result: 'success',
      ok: true,
      chat_id: entry.chatId,
      message_id: messageId,
      outboxId,
      runId: entry.runId,
      day: entry.day
    });
  }

  function summarize(state) {
    const summary = { pending: 0, retry: 0, delivered: 0, ambiguous: 0, unauthorized: 0 };
    for (const entry of state.linkOutbox || []) {
      if (!destinations.includes(String(entry.chatId))) { summary.unauthorized++; continue; }
      summary[entry.status === 'sending' ? 'ambiguous' : entry.status]++;
    }
    return summary;
  }
  async function drain(options) {
    const lease = randomUUID(); let acquired = !options?.idleOnly;
    if (options?.idleOnly) await store.update(state => {
      acquired = false;
      if (['running', 'stopping'].includes(state.cycle?.state) || state.linkExportLease) return state;
      state.linkExportLease = lease; acquired = true; return state;
    });
    if (!acquired) return summarize(await store.load());
    try {
      const state = await store.load();
      const pending = [];
      for (const entry of state.linkOutbox || []) {
        if ((!options?.dailyOnly || entry.daily) && destinations.includes(String(entry.chatId)) && ['pending', 'retry'].includes(entry.status)) {
          pending.push(entry);
          if (pending.length === DRAIN_BATCH_SIZE) break;
        }
      }
      // Admission stays fenced across asynchronous file preparation and transport.
      for (const day of new Set(pending.filter(entry => entry.kind === 'document').map(entry => entry.day))) await writeDay(day, state);
      const results = new Array(pending.length);
      let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(DRAIN_CONCURRENCY, pending.length) }, async () => {
        while (cursor < pending.length) {
          const index = cursor++;
          try {
            await deliver(pending[index].outboxId, options);
            results[index] = { status: 'fulfilled' };
          } catch (reason) {
            results[index] = { status: 'rejected', reason };
          }
        }
      }));
      for (const res of results) {
        if (res.status === 'rejected') {
          logStructured(logger, {
            level: 'error',
            component: 'link_exports',
            event: 'link_export_drain_item_failed',
            operation: 'drain',
            result: 'failed',
            errorCode: extractErrorCode(res.reason),
            sanitizedError: sanitizeError(res.reason)
          });
        }
      }
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
      return summarize(await store.load());
    } finally {
      if (options?.idleOnly) await store.update(state => { if (state.linkExportLease === lease) delete state.linkExportLease; return state; });
    }
  }
  async function recordManual(text, at = clock()) {
    return recordManualDirect(store, text, at);
  }
  let nextDailyCheck=0;
  async function daily() {
    const now=new Date(clock()).getTime();
    if(now<nextDailyCheck)return;
    if(targetDestinations.length>0&&typeof store.pruneConfirmedDaily==='function')await store.pruneConfirmedDaily({today:dayOf(clock()),chatId:targetDestinations[0]});
    nextDailyCheck=Math.min(now+30000,new Date(dayOf(clock())+'T00:00:00+03:00').getTime()+86400000);
    const today=dayOf(clock());
    const reportState=store.section?await store.section('linkReportState'):(await store.load()).linkReportState;
    if(reportState?.cursor===today){
      const outbox=store.section?await store.section('linkOutbox'):(await store.load()).linkOutbox;
      return Array.isArray(outbox)&&outbox.some(e=>e.daily&&['pending','retry'].includes(e.status))?drain({dailyOnly:true}):undefined;
    }
    if(!targetDestinations.length)return undefined;
    await store.update(state=>{
      state.linkOutbox ||= [];
      const historicalDays=[...(state.items||[]),...(state.manualLinks||[]),...state.linkOutbox.flatMap(e=>e.rows||[])].filter(isPublished).map(x=>dayOf(x.publishedAt)).filter(d=>isIsoDay(d)&&d<today).sort();
      let day=isIsoDay(state.linkReportState?.cursor)?state.linkReportState.cursor:(historicalDays[0]||today);
      // Every overdue day is made durable before cursor advancement.
      while(day<today){
        const rows=dailyRows({...state,items:[...(state.items||[]),...state.linkOutbox.filter(e=>e.day===day).flatMap(e=>e.rows||[])]},day);
        for(const destination of targetDestinations){const runId='daily:'+day;
          if(!state.linkOutbox.some(e=>e.runId===runId&&String(e.chatId)===destination))state.linkOutbox.push({outboxId:randomUUID(),runId,day,daily:true,kind:rows.length?'document':'empty',chatId:destination,itemIds:rows.map(r=>r.id),rows:structuredClone(rows),text:'لا توجد روابط منشورات ليوم '+day+'.',status:'pending',attempts:0,createdAt:new Date(clock()).toISOString()});
        }
        const nextMs=new Date(day+'T12:00:00+03:00').getTime()+86400000;
        if(!Number.isFinite(nextMs))break;
        day=dayOf(nextMs);
      }
      state.linkReportState={cursor:today};return state;
    });
    return drain({dailyOnly:true});
  }
  return {
    recordManual,
    exportToday,
    daily:()=>singleFlight('daily', daily),
    write: item => serialize(async () => writeDay(dayOf(item.publishedAt), await store.load())),
    enqueueTerminal: run => serialize(async () => enqueueTerminal(run)),
    send: (run, { emptyMessage = true, terminal = false } = {}) => serialize(async () => {
      if (terminal) await enqueueTerminal(run); else await enqueue(run, { emptyMessage });
      return drain(terminal ? { idleOnly: true } : undefined);
    }),
    // Retry already-created terminal obligations without discovering live rows.
    flush: () => singleFlight('flush', async () => {
      // Empty retry reconciliation must not parse/clone the entire post queue or
      // acquire/release a writer lease on every getUpdates iteration.
      if (store.section) {
        const outbox = await store.section('linkOutbox');
        const ui = await store.section('telegramUi');
        if (!ui?.pendingReport && !(Array.isArray(outbox) && outbox.some(e=>destinations.includes(String(e.chatId)) && ['pending','retry'].includes(e.status)))) return summarize({linkOutbox:Array.isArray(outbox)?outbox:[]});
      }
      const state = await store.load();
      if (['running', 'stopping'].includes(state.cycle?.state)) return summarize(state);
      if (state.telegramUi?.pendingReport) await enqueueTerminal(state.telegramUi.pendingReport);
      return drain({ idleOnly: true });
    }),
    reconcile: ({ deliver: shouldDeliver = true } = {}) => singleFlight(shouldDeliver ? 'reconcile:deliver' : 'reconcile:discover', async () => {
      const state = await enqueue();
      return shouldDeliver ? drain() : summarize(state);
    })
  };
}

async function recordManualDirect(store, text, at = new Date()) {
  const links = String(text).match(/https?:\/\/[^\s<>]+/gi) || [];
  const parsed = links.map(s => canonicalLink(s.replace(/[),.!؟،]+$/g, ''))).filter(Boolean);
  if (!parsed.length) return null;
  let added = 0;
  await store.update(state => {
    // Transaction retries must not retain counters from an abandoned attempt.
    added = 0;
    state.manualLinks ||= [];
    const outboxRows = (state.linkOutbox || []).flatMap(entry => Array.isArray(entry?.rows) ? entry.rows : []);
    const seen = new Set(
      [...(state.items || []).filter(isPublished), ...state.manualLinks, ...outboxRows]
        .map(r => canonicalLink(r?.url)?.id)
        .filter(Boolean)
    );
    for (const link of parsed) {
      if (seen.has(link.id)) continue;
      seen.add(link.id);
      added++;
      state.manualLinks.push({ id: 'manual:' + dayOf(at) + ':' + link.id, url: link.url, state: 'published', publishedAt: new Date(at).toISOString(), source: 'manual' });
    }
    return state;
  });
  return { added, duplicates: parsed.length - added };
}

module.exports = { createLinkExports, dayOf, csv, canonicalLink, recordManualDirect };
