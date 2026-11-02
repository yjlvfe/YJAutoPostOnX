'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { randomUUID } = crypto;

function dayOf(value) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
}
function riyadhTimestamp(value) {
  const date = new Date(value);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${String(date.getUTCMilliseconds()).padStart(3, '0')}+03:00`;
}
function csv(rows) {
  const quote = x => '"' + String(x ?? '').replace(/"/g, '""') + '"';
  const safeText = value => /^[\s]*[=+\-@]/.test(String(value ?? '')) ? "'" + value : value;
  return '\uFEFFDate,Account,URL,Text\r\n' + rows.map(x => [riyadhTimestamp(x.publishedAt), x.accountUsername ? '@' + x.accountUsername.replace(/^@/, '') : '', x.url, safeText(x.payload?.text)].map(quote).join(',')).join('\r\n') + '\r\n';
}
function isPublished(item) {
  return item.state === 'published' && item.id != null && item.url && item.publishedAt && Number.isFinite(new Date(item.publishedAt).getTime());
}
function dailyRows(state, day) {
  const seen = new Set();
  return (state.items || []).filter(x => isPublished(x) && dayOf(x.publishedAt) === day)
    .sort((a, b) => new Date(a.publishedAt) - new Date(b.publishedAt) || String(a.id).localeCompare(String(b.id)))
    .filter(row => { if (seen.has(row.url)) return false; seen.add(row.url); return true; });
}
function createLinkExports({ store, dataDir, api, chatId, chatIds, logger = console, clock = () => new Date() }) {
  // Persisted recipients are obligations, never authorization. Revoked recipients
  // stay on disk but cannot be contacted by this instance.
  const destinations = [...new Set([...(chatIds || []), chatId].filter(id => id !== undefined && id !== null).map(String))];
  let chain = Promise.resolve();
  const serialize = fn => { const next = chain.then(fn); chain = next.catch(() => {}); return next; };

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

  // A terminal obligation belongs to a session-stop event, not to individual
  // new rows. Even a failed session owes today's previously confirmed history.
  async function enqueueTerminal(run) {
    if (!run?.runId) return;
    await store.update(state => {
      const pending = state.telegramUi?.pendingReport;
      const day = dayOf(run.endedAt || (pending?.runId === run.runId && pending.endedAt) || clock());
      state.linkOutbox ||= [];
      state.linkTerminalEvents ||= [];
      // Do not publish a terminal report if its terminal-state commit failed.
      if (['running', 'stopping'].includes(state.cycle?.state) && state.cycle.runId === run.runId) return state;
      if (state.telegramUi?.pendingReport?.runId === run.runId) delete state.telegramUi.pendingReport;
      for (const destination of destinations) {
        if (state.linkTerminalEvents.some(event => event.runId === run.runId && event.chatId === destination)) continue;
        const rows = dailyRows({ items: [
          ...(state.items || []),
          ...state.linkOutbox.filter(entry => entry.kind === 'document' && entry.day === day).flatMap(entry => entry.rows || [])
        ] }, day);
        if (!rows.length) {
          state.linkTerminalEvents.push({ runId: run.runId, chatId: destination, day, reconciled: true, reason: 'empty_rows' });
          continue;
        }

        const successfulDeliveries = (state.linkDeliveries || []).filter(entry =>
          entry.ok === true && entry.kind === 'document' && entry.day === day && String(entry.chatId) === destination
        );
        const lastDelivery = successfulDeliveries[successfulDeliveries.length - 1];
        const content = csv(rows);
        const contentHash = crypto.createHash('sha256').update(content).digest('hex');

        // Check if all item IDs are already present in the last successful delivery:
        let isDuplicateItemSet = false;
        if (lastDelivery && Array.isArray(lastDelivery.itemIds)) {
          const lastDeliveredItemIds = new Set(lastDelivery.itemIds);
          isDuplicateItemSet = rows.length === lastDeliveredItemIds.size && rows.every(r => lastDeliveredItemIds.has(r.id));
        }

        // Check if content hash matches any successful delivery for this day and destination:
        const isDuplicateHash = successfulDeliveries.some(entry => entry.contentHash === contentHash);

        if (isDuplicateItemSet || isDuplicateHash) {
          state.linkTerminalEvents.push({
            runId: run.runId,
            chatId: destination,
            day,
            reconciled: true,
            suppressed: true,
            reason: isDuplicateHash ? 'duplicate_content_hash' : 'duplicate_item_set',
            contentHash,
            itemIds: rows.map(r => r.id)
          });
          logger.log(JSON.stringify({
            event: 'link_export_terminal_suppressed',
            runId: run.runId,
            chatId: destination,
            day,
            reason: isDuplicateHash ? 'duplicate_content_hash' : 'duplicate_item_set',
            itemCount: rows.length
          }));
          continue;
        }

        state.linkTerminalEvents.push({ runId: run.runId, chatId: destination, day, reconciled: false, contentHash });
        state.linkOutbox.push({ outboxId: randomUUID(), runId: run.runId, terminalId: run.runId, day,
          kind: 'document', chatId: destination, itemIds: rows.map(row => row.id), rows: structuredClone(rows),
          contentHash, status: 'pending', attempts: 0, createdAt: new Date(clock()).toISOString() });
      }
      return state;
    });
  }

  async function deliver(outboxId, { idleOnly = false } = {}) {
    let entry;
    const deliveryId = randomUUID();
    let contentHash = null;
    await store.update(state => {
      if (idleOnly && ['running', 'stopping'].includes(state.cycle?.state)) return state;
      const current = (state.linkOutbox || []).find(record => record.outboxId === outboxId);
      if (!current || !destinations.includes(String(current.chatId)) || !['pending', 'retry'].includes(current.status)) return state;
      current.status = 'sending'; current.deliveryId = deliveryId; current.attempts += 1;
      current.attemptedAt = new Date().toISOString();
      state.linkDeliveries ||= [];
      // Freeze the complete durable daily total in this attempt, not just
      // the triggering run's new rows. Delivery coverage remains per new item.
      if (current.kind === 'document') current.rows = dailyRows({ items: [
        ...(state.items || []),
        ...(state.linkOutbox || []).filter(record => record.day === current.day && record.kind === 'document').flatMap(record => record.rows || [])
      ] }, current.day);
      contentHash = current.kind === 'document' ? crypto.createHash('sha256').update(csv(current.rows)).digest('hex') : null;
      current.contentHash = contentHash;
      state.linkDeliveries.push({ deliveryId, outboxId, runId: current.runId, day: current.day, kind: current.kind,
        chatId: current.chatId, itemIds: current.itemIds, contentHash, attempted: true, ok: false, attemptedAt: current.attemptedAt });
      entry = structuredClone(current);
      return state;
    });
    if (!entry) return;
    // Fast deduplication check: if identical contentHash has already been successfully delivered for this destination & day
    if (entry.kind === 'document' && contentHash) {
      const state = await store.load();
      const alreadyDelivered = (state.linkDeliveries || []).some(d =>
        d.ok === true && d.kind === 'document' && d.day === entry.day &&
        String(d.chatId) === String(entry.chatId) && d.contentHash === contentHash && d.deliveryId !== deliveryId
      );
      if (alreadyDelivered) {
        await store.update(s => {
          const cur = (s.linkOutbox || []).find(r => r.outboxId === outboxId);
          const att = (s.linkDeliveries || []).find(r => r.deliveryId === deliveryId);
          if (cur) { cur.status = 'delivered'; cur.deliveredAt = new Date().toISOString(); }
          if (att) { att.ok = true; att.suppressed = true; att.reason = 'duplicate_hash_in_deliver'; }
          return s;
        });
        logger.log(JSON.stringify({ event: 'telegram_document_delivery_suppressed', outboxId, chatId: entry.chatId, day: entry.day, reason: 'already_delivered_identical_hash' }));
        return;
      }
    }
    // A persisted 'sending' record is fenced forever after a crash. Telegram
    // offers no idempotency key: absence of a receipt is NOT proof of failure.
    let response;
    try {
      response = entry.kind === 'empty'
        ? await api.sendMessage({ chat_id: entry.chatId, text: 'لا توجد روابط منشورات مؤكدة لإرسالها حالياً.' })
        : await api.sendDocument({ chat_id: entry.chatId, filename: `links_${entry.day}.csv`, content: csv(entry.rows) });
      if ((response?.message_id ?? response?.result?.message_id) == null) throw new Error('Telegram delivery receipt missing');
    } catch (error) {
      await store.update(state => {
        const current = (state.linkOutbox || []).find(record => record.outboxId === outboxId && record.deliveryId === deliveryId);
        const attempt = (state.linkDeliveries || []).find(record => record.deliveryId === deliveryId);
        // sendMessage reports parsed Telegram rejections without the document
        // transport's ambiguous:false flag. Only its explicit 4xx API contract
        // proves non-delivery; numeric codes alone or uncertain errors do not.
        const definite = error.ambiguous === false || (entry.kind === 'empty' && error.ambiguous !== true &&
          error.code === 'TELEGRAM_API_ERROR' && Number.isInteger(error.telegramCode) && error.telegramCode >= 400 && error.telegramCode < 500);
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
      return state;
    });
    logger.log(JSON.stringify({ event: entry.kind === 'empty' ? 'telegram_empty_notice_sent' : 'telegram_document_sent', ok: true, chat_id: entry.chatId, message_id: messageId }));
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
      if (['running', 'stopping'].includes(state.cycle?.state) || state.linkExportLease) return state;
      state.linkExportLease = lease; acquired = true; return state;
    });
    if (!acquired) return summarize(await store.load());
    try {
      const state = await store.load();
      const pending = (state.linkOutbox || []).filter(entry => destinations.includes(String(entry.chatId)) && ['pending', 'retry'].includes(entry.status));
      // Admission stays fenced across asynchronous file preparation and transport.
      for (const day of new Set(pending.filter(entry => entry.kind === 'document').map(entry => entry.day))) await writeDay(day, state);
      const results = await Promise.allSettled(pending.map(entry => deliver(entry.outboxId, options)));
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
      return summarize(await store.load());
    } finally {
      if (options?.idleOnly) await store.update(state => { if (state.linkExportLease === lease) delete state.linkExportLease; return state; });
    }
  }
  return {
    write: item => serialize(async () => writeDay(dayOf(item.publishedAt), await store.load())),
    send: (run, { emptyMessage = true, terminal = false } = {}) => serialize(async () => {
      if (terminal) await enqueueTerminal(run); else await enqueue(run, { emptyMessage });
      return drain(terminal ? { idleOnly: true } : undefined);
    }),
    // Retry already-created terminal obligations without discovering live rows.
    flush: () => serialize(async () => {
      const state = await store.load();
      if (['running', 'stopping'].includes(state.cycle?.state)) return summarize(state);
      if (state.telegramUi?.pendingReport) await enqueueTerminal(state.telegramUi.pendingReport);
      return drain({ idleOnly: true });
    }),
    reconcile: ({ deliver: shouldDeliver = true } = {}) => serialize(async () => {
      const state = await enqueue();
      return shouldDeliver ? drain() : summarize(state);
    })
  };
}
module.exports = { createLinkExports, dayOf, csv };
