'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function write(rel, content) {
  const full = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

function replaceOnce(source, from, to, label) {
  const first = source.indexOf(from);
  if (first === -1) throw new Error(`Missing replacement anchor: ${label}`);
  if (source.indexOf(from, first + from.length) !== -1) {
    throw new Error(`Non-unique replacement anchor: ${label}`);
  }
  return source.slice(0, first) + to + source.slice(first + from.length);
}

function replaceBetween(source, start, end, replacement, label) {
  const a = source.indexOf(start);
  if (a === -1) throw new Error(`Missing start anchor: ${label}`);
  const b = source.indexOf(end, a + start.length);
  if (b === -1) throw new Error(`Missing end anchor: ${label}`);
  return source.slice(0, a) + replacement + source.slice(b);
}

// ---------------------------------------------------------------------------
// XP-006: terminal rows need an explicit, revision-checked discard transition.
// ---------------------------------------------------------------------------
let workflowStore = read('dev/automation/workflowStore.js');
workflowStore = replaceOnce(
  workflowStore,
  `  listItems({ states = [...ITEM_STATES], limit = 100, after = null, afterUpdatedAtMs = null } = {}) {`,
  `  discardTerminal({ id, expectedRevision, requestId }) {
    const normalizedId = assertNonEmptyString(id, 'id');
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new TypeError('expectedRevision must be a non-negative integer');
    }
    return this._mutate(
      'discardTerminal',
      requestId,
      { id: normalizedId, expectedRevision },
      () => {
        const row = this._getItemRow(normalizedId);
        if (!row) conflict('ITEM_NOT_FOUND', \`Unknown workflow item: \${normalizedId}\`);
        if (row.state !== 'dead') conflict('INVALID_STATE', \`Cannot discard terminal item from \${row.state}\`);
        if (row.revision !== expectedRevision) {
          conflict('REVISION_CONFLICT', 'The item revision no longer matches');
        }
        const now = Date.now();
        const nextRevision = row.revision + 1;
        const update = this.db.prepare(\`
          UPDATE workflow_items
          SET state = 'discarded', discarded_at_ms = ?, reason = 'discarded_dead_by_user',
              error_json = NULL, revision = ?, updated_at_ms = ?
          WHERE id = ? AND state = 'dead' AND revision = ?
        \`).run(now, nextRevision, now, normalizedId, expectedRevision);
        if (update.changes !== 1) conflict('STATE_CONFLICT', 'The dead item changed before it could be discarded');
        this._recordEvent(
          normalizedId,
          'dead_discarded',
          'dead',
          'discarded',
          nextRevision,
          { discardedBy: 'user' },
          now,
        );
        return this._rowToItem(this._getItemRow(normalizedId));
      },
    );
  }

  listItems({ states = [...ITEM_STATES], limit = 100, after = null, afterUpdatedAtMs = null } = {}) {`,
  'workflowStore discardTerminal',
);
write('dev/automation/workflowStore.js', workflowStore);

// ---------------------------------------------------------------------------
// Durable queue: every mutation is {id, expectedRevision, requestId}.
// Text is display-only. Ambiguous rows cannot be generically discarded.
// ---------------------------------------------------------------------------
let dq = read('dev/automation/durableQueue.js');

dq = replaceBetween(
  dq,
  'async function bulkDeleteById(ids) {',
  '// ── Recovery',
  `function mutationRequest(raw, prefix) {
  if (typeof raw === 'string') {
    return { id: raw, expectedRevision: null, requestId: \`${prefix}:legacy:\${raw}\` };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const expectedRevision = Number.isInteger(raw.expectedRevision) && raw.expectedRevision >= 0
    ? raw.expectedRevision
    : null;
  const requestId = typeof raw.requestId === 'string' && raw.requestId.trim()
    ? raw.requestId.trim()
    : \`${prefix}:\${id}:\${expectedRevision ?? 'live'}\`;
  return id ? { id, expectedRevision, requestId } : null;
}

/** Delete queue rows by stable UUID with compare-and-swap revision checks. */
async function bulkDeleteById(requests) {
  const store = await getStore();
  const normalized = (requests || []).map((entry) => mutationRequest(entry, 'bulk-delete-id')).filter(Boolean);
  if (normalized.length === 0) {
    return { deleted: 0, blocked: [], remaining: readAllBacklogItems(store).length };
  }

  const live = new Map(
    readAllItems(store, ['queued', 'deferred', 'leased', 'dispatch_started'])
      .map((item) => [item.id, item]),
  );
  let deleted = 0;
  const blocked = [];

  for (const request of normalized) {
    const item = live.get(request.id);
    if (!item) {
      blocked.push({ id: request.id, reason: 'NOT_FOUND' });
      continue;
    }
    if (request.expectedRevision !== null && request.expectedRevision !== item.revision) {
      blocked.push({
        id: item.id,
        text: textOf(item),
        reason: 'REVISION_CONFLICT',
        expectedRevision: request.expectedRevision,
        actualRevision: item.revision,
      });
      continue;
    }
    if (item.state !== 'queued' && item.state !== 'deferred') {
      blocked.push({ id: item.id, text: textOf(item), reason: \`IN_FLIGHT_\${item.state.toUpperCase()}\` });
      continue;
    }
    try {
      store.discardQueued({
        id: item.id,
        expectedRevision: item.revision,
        requestId: request.requestId,
      });
      deleted += 1;
    } catch (error) {
      blocked.push({ id: item.id, text: textOf(item), reason: error.code || 'CONFLICT' });
    }
  }

  return { deleted, blocked, remaining: readAllBacklogItems(store).length };
}

/** Compatibility only: refuse duplicate text instead of guessing a row. */
async function bulkDeleteByText(texts) {
  const store = await getStore();
  const live = readAllItems(store, ['queued', 'deferred', 'leased', 'dispatch_started']);
  const requests = [];
  const blocked = [];
  for (const text of new Set((texts || []).filter((value) => typeof value === 'string'))) {
    const matches = live.filter((item) => textOf(item) === text);
    if (matches.length === 1) {
      requests.push({
        id: matches[0].id,
        expectedRevision: matches[0].revision,
        requestId: \`bulk-delete-text-compat:\${matches[0].id}:\${matches[0].revision}\`,
      });
    } else if (matches.length > 1) {
      blocked.push({ text, reason: 'AMBIGUOUS_TEXT_ADDRESS', ids: matches.map((item) => item.id) });
    } else {
      blocked.push({ text, reason: 'NOT_FOUND' });
    }
  }
  const result = await bulkDeleteById(requests);
  return { ...result, blocked: [...blocked, ...result.blocked] };
}

// ── Recovery`,
  'durableQueue CAS deletion',
);

dq = replaceBetween(
  dq,
  'async function getRecoveryItems(_profileName) {',
  'function recoveryMatch(store, states, identity) {',
  `async function getRecoveryItems(_profileName) {
  const store = await getStore();
  const describe = (item) => ({
    id: item.id,
    revision: item.revision,
    text: textOf(item),
    media: (item.media || []).map((entry) => ({
      ordinal: entry.ordinal,
      sha256: entry.sha256,
      byteSize: entry.byteSize,
      managedPath: entry.managedPath,
    })),
    reason: item.reason,
    profileName: item.lastProfile ? item.lastProfile.name : null,
    attemptedText: item.currentAttempt ? item.currentAttempt.renderedText : null,
    evidence: item.currentAttempt ? item.currentAttempt.evidence : null,
    attemptId: item.currentAttempt ? item.currentAttempt.id : null,
    at: item.updatedAtMs ? new Date(item.updatedAtMs).toISOString() : null,
  });
  const pending = store.listRecovery().map(describe);
  const deadLetters = readAllItems(store, ['dead']).map(describe);
  return { pending, deadLetters };
}

function recoveryMatch(store, states, identity) {`,
  'durableQueue recovery details',
);

dq = replaceBetween(
  dq,
  'function recoveryMatch(store, states, identity) {',
  '// ── Maintenance',
  `function recoveryMatch(store, states, identity) {
  const request = mutationRequest(identity, 'recovery');
  if (!request) return null;
  const item = store.getItem(request.id);
  if (!item || !states.includes(item.state)) return null;
  if (request.expectedRevision !== null && request.expectedRevision !== item.revision) {
    const error = new Error('The recovery item revision no longer matches. Refresh before acting.');
    error.code = 'REVISION_CONFLICT';
    error.expectedRevision = request.expectedRevision;
    error.actualRevision = item.revision;
    throw error;
  }
  return { request, item };
}

function requirePublishedProof(proof) {
  const externalUrl = typeof proof?.externalUrl === 'string' ? proof.externalUrl.trim() : '';
  const externalId = typeof proof?.externalId === 'string' ? proof.externalId.trim() : '';
  if (!externalUrl && !externalId) {
    const error = new Error('A status URL or external post ID is required to confirm publication.');
    error.code = 'PROOF_REQUIRED';
    throw error;
  }
  return { ...proof, externalUrl: externalUrl || null, externalId: externalId || null };
}

async function confirmPublished(identity, proof = {}) {
  const store = await getStore();
  const match = recoveryMatch(store, ['ambiguous'], identity);
  if (!match || !match.item.currentAttemptId) return false;
  const verifiedProof = requirePublishedProof(proof);
  store.markPublished({
    attemptId: match.item.currentAttemptId,
    externalId: verifiedProof.externalId,
    externalUrl: verifiedProof.externalUrl,
    evidence: { confirmed: true, source: 'manual_operator_check', ...verifiedProof },
    requestId: match.request.requestId,
  });
  return true;
}

async function confirmNotPublishedAndRequeue(identity, acknowledgement = {}) {
  const store = await getStore();
  const match = recoveryMatch(store, ['ambiguous'], identity);
  if (!match) return false;
  if (acknowledgement.confirmedNotPublished !== true) {
    const error = new Error('Explicit confirmedNotPublished=true is required.');
    error.code = 'CONFIRMATION_REQUIRED';
    throw error;
  }
  store.resolveRecovery({
    id: match.item.id,
    action: 'requeue',
    confirmedNotPublished: true,
    evidence: acknowledgement.evidence || null,
    requestId: match.request.requestId,
  });
  return true;
}

async function requeueDead(identity) {
  const store = await getStore();
  const match = recoveryMatch(store, ['dead'], identity);
  if (!match) return false;
  store.requeueTerminal({
    id: match.item.id,
    expectedRevision: match.item.revision,
    requestId: match.request.requestId,
  });
  return true;
}

async function discardDead(identity) {
  const store = await getStore();
  const match = recoveryMatch(store, ['dead'], identity);
  if (!match) return false;
  store.discardTerminal({
    id: match.item.id,
    expectedRevision: match.item.revision,
    requestId: match.request.requestId,
  });
  return true;
}

// Compatibility wrappers for older callers. Ambiguous rows may only be resolved
// by an explicit published/not-published decision; they cannot be generically closed.
async function requeueRecovery(_profileName, kind, identity, options = {}) {
  if (kind === 'dead') return requeueDead(identity);
  return confirmNotPublishedAndRequeue(identity, options);
}

async function discardRecovery(_profileName, kind, identity) {
  if (kind !== 'dead') {
    const error = new Error('Ambiguous publishing evidence cannot be discarded. Confirm published or confirm not published.');
    error.code = 'UNSAFE_RECOVERY_ACTION';
    throw error;
  }
  return discardDead(identity);
}

async function confirmRecoveryPublished(identity, proof = {}) {
  return confirmPublished(identity, proof);
}

// ── Maintenance`,
  'durableQueue typed recovery actions',
);

dq = replaceOnce(
  dq,
  `  getRecoveryItems,
  requeueRecovery,
  discardRecovery,
  confirmRecoveryPublished,`,
  `  getRecoveryItems,
  confirmPublished,
  confirmNotPublishedAndRequeue,
  requeueDead,
  discardDead,
  requeueRecovery,
  discardRecovery,
  confirmRecoveryPublished,`,
  'durableQueue typed recovery exports',
);
write('dev/automation/durableQueue.js', dq);

// ---------------------------------------------------------------------------
// Main IPC: typed contracts and truth-bearing queue reads.
// ---------------------------------------------------------------------------
let main = read('dev/main.js');
main = replaceOnce(
  main,
  `ipcMain.handle('add-posts', async (event, newPosts, profileName) => {`,
  `ipcMain.handle('get-queue-state', async () => {
  try {
    const [items, counts, integrity, unresolved] = await Promise.all([
      durableQueue.getQueueDetailed(),
      durableQueue.getBacklogCounts(),
      durableQueue.integrityCheck(),
      durableQueue.countUnresolved(),
    ]);
    return { success: true, items, counts, integrity, unresolved };
  } catch (error) {
    return {
      success: false,
      error: error?.message || 'تعذر قراءة مخزن العمل',
      code: error?.code || 'WORKFLOW_READ_FAILED',
      items: [],
      counts: null,
      integrity: error?.health || null,
      unresolved: null,
    };
  }
});

ipcMain.handle('add-posts', async (event, newPosts, profileName) => {`,
  'main queue state IPC',
);

main = replaceBetween(
  main,
  '// Destructive queue/recovery operations are addressed by durable UUID',
  'let automationRunning = false;',
  `// Destructive operations use durable UUID + expected revision + request ID.
ipcMain.handle('bulk-delete', async (_event, mutations) => {
  try {
    if (!Array.isArray(mutations)) throw new Error('mutations must be an array');
    return await durableQueue.bulkDeleteById(mutations);
  } catch (error) {
    return { deleted: 0, blocked: [], error: error?.message || 'unknown error', code: error?.code || null };
  }
});

ipcMain.handle('get-recovery-items', async (_event, profileName) => {
  try { return { success: true, ...(await durableQueue.getRecoveryItems(profileName || 'Default')) }; }
  catch (error) {
    return { success: false, error: error.message, code: error.code || null, pending: [], deadLetters: [] };
  }
});

ipcMain.handle('recovery-confirm-published', async (_event, mutation, proof) => {
  try { return { success: await durableQueue.confirmPublished(mutation, proof || {}) }; }
  catch (error) { return { success: false, error: error.message, code: error.code || null }; }
});

ipcMain.handle('recovery-confirm-not-published', async (_event, mutation, acknowledgement) => {
  try {
    return {
      success: await durableQueue.confirmNotPublishedAndRequeue(mutation, acknowledgement || {}),
    };
  } catch (error) { return { success: false, error: error.message, code: error.code || null }; }
});

ipcMain.handle('recovery-requeue-dead', async (_event, mutation) => {
  try { return { success: await durableQueue.requeueDead(mutation) }; }
  catch (error) { return { success: false, error: error.message, code: error.code || null }; }
});

ipcMain.handle('recovery-discard-dead', async (_event, mutation) => {
  try { return { success: await durableQueue.discardDead(mutation) }; }
  catch (error) { return { success: false, error: error.message, code: error.code || null }; }
});

// Backward-compatible channels fail safely and still require explicit evidence.
ipcMain.handle('requeue-recovery-item', async (_event, profileName, kind, identity, options) => {
  try { return { success: await durableQueue.requeueRecovery(profileName, kind, identity, options || {}) }; }
  catch (error) { return { success: false, error: error.message, code: error.code || null }; }
});
ipcMain.handle('confirm-recovery-published', async (_event, identity, proof) => {
  try { return { success: await durableQueue.confirmRecoveryPublished(identity, proof || {}) }; }
  catch (error) { return { success: false, error: error.message, code: error.code || null }; }
});
ipcMain.handle('discard-recovery-item', async (_event, profileName, kind, identity) => {
  try { return { success: await durableQueue.discardRecovery(profileName, kind, identity) }; }
  catch (error) { return { success: false, error: error.message, code: error.code || null }; }
});

ipcMain.handle('workflow-health', async () => {
  try {
    const [integrity, unresolved, backups, counts] = await Promise.all([
      durableQueue.integrityCheck(),
      durableQueue.countUnresolved(),
      durableQueue.listWorkflowSnapshots(),
      durableQueue.getBacklogCounts(),
    ]);
    return { success: true, integrity, unresolved, backups, counts };
  } catch (error) {
    return { success: false, error: error.message, code: error.code || null, health: error.health || null };
  }
});

ipcMain.handle('create-workflow-backup', async () => {
  try { return { success: true, snapshot: await durableQueue.createWorkflowSnapshot({ force: true }) }; }
  catch (error) { return { success: false, error: error.message, code: error.code || null }; }
});

let automationRunning = false;`,
  'main typed recovery IPC',
);
write('dev/main.js', main);

// ---------------------------------------------------------------------------
// Preload: expose the typed API only; legacy channels remain main-side only.
// ---------------------------------------------------------------------------
let preload = read('dev/preload.js');
preload = replaceBetween(
  preload,
  '  // Queue operations',
  '  // Automation control',
  `  // Queue operations
  getQueue: (profileName) => ipcRenderer.invoke('get-queue', profileName),
  getQueueState: () => ipcRenderer.invoke('get-queue-state'),
  addPosts: (posts, profileName) => ipcRenderer.invoke('add-posts', posts, profileName),
  bulkDelete: (mutations, profileName) => ipcRenderer.invoke('bulk-delete', mutations, profileName),
  getRecoveryItems: (profileName) => ipcRenderer.invoke('get-recovery-items', profileName),
  confirmRecoveryPublished: (mutation, proof) =>
    ipcRenderer.invoke('recovery-confirm-published', mutation, proof),
  confirmRecoveryNotPublished: (mutation, acknowledgement) =>
    ipcRenderer.invoke('recovery-confirm-not-published', mutation, acknowledgement),
  requeueDeadRecovery: (mutation) => ipcRenderer.invoke('recovery-requeue-dead', mutation),
  discardDeadRecovery: (mutation) => ipcRenderer.invoke('recovery-discard-dead', mutation),
  workflowHealth: () => ipcRenderer.invoke('workflow-health'),
  createWorkflowBackup: () => ipcRenderer.invoke('create-workflow-backup'),

  // Automation control`,
  'preload typed recovery API',
);
write('dev/preload.js', preload);

// ---------------------------------------------------------------------------
// Renderer: durable keys, revision CAS, explicit recovery decisions, visible
// deferred state/countdown, and a visible health/error banner.
// ---------------------------------------------------------------------------
let renderer = read('dev/ui/renderer.js');
renderer = replaceOnce(
  renderer,
  `  textCell.appendChild(document.createTextNode(item.text));`,
  `  textCell.appendChild(document.createTextNode(item.text));
  if (item.state && item.state !== 'queued') {
    const stateBadge = document.createElement('small');
    stateBadge.className = 'q-state';
    const waitSeconds = Math.max(0, Math.ceil((item.waitingMs || 0) / 1000));
    const waitLabel = waitSeconds > 0 ? \` — متاح بعد \${waitSeconds}ث\` : '';
    stateBadge.textContent = \`\${item.state}\${waitLabel}\${item.reason ? \` — \${item.reason}\` : ''}\`;
    textCell.appendChild(document.createElement('br'));
    textCell.appendChild(stateBadge);
  }`,
  'renderer queue state badge',
);

renderer = replaceBetween(
  renderer,
  'async function loadQueue(profile) {',
  'function updateQueueCounters() {',
  `let queueRefreshTimer = null;

function workflowHealthBanner() {
  let banner = document.getElementById('workflow-health-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'workflow-health-banner';
    banner.className = 'empty-note hidden';
    const queue = document.getElementById('queue-list');
    queue.parentElement.insertBefore(banner, queue);
  }
  return banner;
}

function mutationFor(item, prefix) {
  return {
    id: item.id,
    expectedRevision: item.revision,
    requestId: \`${prefix}:\${item.id}:\${item.revision}:\${Date.now()}\`,
  };
}

async function loadQueue(profile) {
  const result = await window.api.getQueueState();
  const banner = workflowHealthBanner();
  if (!result || result.success !== true) {
    state.queue = [];
    state.queueView = [];
    queueList.setItems([]);
    queueEmptyNote.classList.remove('hidden');
    banner.classList.remove('hidden');
    banner.textContent = \`❌ تعذر قراءة مخزن العمل: \${result?.error || 'خطأ غير معروف'}\`;
    btnMainAction.disabled = true;
    updateQueueCounters();
    return;
  }

  state.queue = Array.isArray(result.items) ? result.items : [];
  state.queueView = state.queue.map((item) => ({
    id: item.id,
    revision: item.revision,
    text: item.payload?.text || item.text || '',
    media: item.media?.[0]?.managedPath || item.media_path || null,
    state: item.state || 'queued',
    waitingMs: item.waitingMs || 0,
    reason: item.deferReason || item.reason || null,
  }));
  qSelection.clear();
  queueList.setItems(state.queueView);
  queueEmptyNote.classList.toggle('hidden', state.queueView.length > 0);
  updateQueueCounters();
  updateSelectionUI();

  const healthy = result.integrity && result.integrity.ok === true;
  banner.classList.toggle('hidden', healthy && !result.unresolved);
  banner.textContent = !healthy
    ? '⚠️ فحص سلامة مخزن العمل يحتاج مراجعة. النشر متوقف حمايةً للطابور.'
    : result.unresolved
      ? \`⚠️ يوجد \${result.unresolved} منشور غير محسوم. احسمه قبل بدء نشر جديد.\`
      : '';
  btnMainAction.disabled = !healthy || Number(result.unresolved || 0) > 0;

  await loadRecoveryItems(profile || profileSelect.value);
  if (queueRefreshTimer) clearTimeout(queueRefreshTimer);
  if (state.queueView.some((item) => item.state === 'deferred' && item.waitingMs > 0)) {
    queueRefreshTimer = setTimeout(() => loadQueue(profile || profileSelect.value), 30_000);
  }
}

async function loadRecoveryItems(profile) {
  const host = $('recovery-list');
  host.replaceChildren();
  const result = await window.api.getRecoveryItems(profile || profileSelect.value);
  if (!result || result.success !== true) {
    const error = document.createElement('div');
    error.className = 'recovery-empty';
    error.textContent = \`تعذر تحميل الاسترداد: \${result?.error || 'خطأ غير معروف'}\`;
    host.appendChild(error);
    return;
  }
  const items = [
    ...(result.pending || []).map(item => ({ ...item, kind: 'pending', label: 'بانتظار التحقق' })),
    ...(result.deadLetters || []).map(item => ({ ...item, kind: 'dead', label: 'فشل نهائي' })),
  ];
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'recovery-empty';
    empty.textContent = 'لا توجد عناصر معلقة أو محذوفات تحتاج مراجعة.';
    host.appendChild(empty);
    return;
  }

  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'recovery-item';
    row.dataset.itemId = item.id;
    const kind = document.createElement('span');
    kind.className = 'recovery-kind';
    kind.textContent = item.label;
    const text = document.createElement('span');
    text.className = 'recovery-text';
    text.textContent = \`\${item.text || ''}\${item.profileName ? \` — \${item.profileName}\` : ''}\${item.reason ? \` — \${item.reason}\` : ''}\`;
    const actions = document.createElement('span');
    actions.className = 'recovery-actions';
    const mutation = () => mutationFor(item, \`recovery-\${item.kind}\`);

    if (item.kind === 'pending') {
      const published = document.createElement('button');
      published.className = 'btn btn--secondary btn--sm';
      published.textContent = 'تأكيد أنه نُشر';
      published.addEventListener('click', async () => {
        const externalUrl = prompt('ألصق رابط المنشور على X للتوثيق:');
        if (!externalUrl || !externalUrl.trim()) return;
        const response = await window.api.confirmRecoveryPublished(mutation(), {
          externalUrl: externalUrl.trim(),
          checkedAt: new Date().toISOString(),
        });
        addLog(response.success ? '✅ ثُبّت المنشور كمنشور فعلاً' : \`❌ \${response.error || 'تعذر التأكيد'}\`, response.success ? 'success' : 'error');
        await loadQueue(profile);
      });

      const notPublished = document.createElement('button');
      notPublished.className = 'btn btn--secondary btn--sm';
      notPublished.textContent = 'لم يُنشر — أعده';
      notPublished.addEventListener('click', async () => {
        if (!confirm('هل تحققت من X وتأكدت أن المنشور لم يُنشر؟')) return;
        const response = await window.api.confirmRecoveryNotPublished(mutation(), {
          confirmedNotPublished: true,
          evidence: { source: 'renderer_manual_check', checkedAt: new Date().toISOString() },
        });
        addLog(response.success ? '↩️ أُعيد المنشور للطابور' : \`❌ \${response.error || 'تعذرت الاستعادة'}\`, response.success ? 'success' : 'error');
        await loadQueue(profile);
      });
      actions.append(published, notPublished);
    } else {
      const retry = document.createElement('button');
      retry.className = 'btn btn--secondary btn--sm';
      retry.textContent = 'إعادة للطابور';
      retry.addEventListener('click', async () => {
        const response = await window.api.requeueDeadRecovery(mutation());
        addLog(response.success ? '↩️ أُعيد المنشور للطابور' : \`❌ \${response.error || 'تعذرت الاستعادة'}\`, response.success ? 'success' : 'error');
        await loadQueue(profile);
      });
      const discard = document.createElement('button');
      discard.className = 'btn btn--danger btn--sm';
      discard.textContent = 'حذف نهائي';
      discard.addEventListener('click', async () => {
        if (!confirm('حذف عنصر الفشل النهائي؟')) return;
        const response = await window.api.discardDeadRecovery(mutation());
        addLog(response.success ? '🗑️ حُذف عنصر الفشل النهائي' : \`❌ \${response.error || 'تعذر الحذف'}\`, response.success ? 'warning' : 'error');
        await loadQueue(profile);
      });
      actions.append(retry, discard);
    }
    row.append(kind, text, actions);
    host.appendChild(row);
  }
}

function updateQueueCounters() {`,
  'renderer typed queue recovery',
);

renderer = replaceBetween(
  renderer,
  'async function deleteQueueItem(id) {',
  '// import CSV',
  `async function deleteQueueItem(id) {
  const profile = profileSelect.value;
  const item = state.queueView.find((entry) => entry.id === id);
  if (!item) return;
  const result = await window.api.bulkDelete([mutationFor(item, 'delete-one')], profile);
  const blocked = Array.isArray(result?.blocked) ? result.blocked : [];
  addLog(
    result?.deleted === 1 ? '🗑️ حُذف المنشور' : \`تعذر حذف المنشور: \${blocked[0]?.reason || result?.error || 'غير معروف'}\`,
    result?.deleted === 1 ? 'success' : 'warning',
  );
  await loadQueue(profile);
}

$('btn-delete-selected').addEventListener('click', async () => {
  if (!qSelection.size) { addLog('لم تحدد أي منشور', 'warning'); return; }
  const profile = profileSelect.value;
  const mutations = state.queueView
    .filter((item) => qSelection.has(item.id))
    .map((item) => mutationFor(item, 'delete-selected'));
  const result = await window.api.bulkDelete(mutations, profile);
  const deleted = Number.isInteger(result?.deleted) ? result.deleted : 0;
  const blocked = Array.isArray(result?.blocked) ? result.blocked.length : 0;
  addLog(
    \`🗑️ حُذف \${deleted} منشور\${blocked ? \`، وتعذر حذف \${blocked}\` : ''}\`,
    blocked ? 'warning' : 'success',
  );
  await loadQueue(profile);
});

// import CSV`,
  'renderer CAS deletes',
);
write('dev/ui/renderer.js', renderer);

// ---------------------------------------------------------------------------
// Backup: perform an actual staging restore drill on every snapshot before it is
// committed into rotation. Only media with present, verified bytes is copied.
// ---------------------------------------------------------------------------
let backup = read('dev/automation/workflowBackup.js');
backup = replaceOnce(
  backup,
  `function validateBackupDatabase(dbPath) {`,
  `function verifyRestoreDrill(dbPath, rootDir) {
  const drillPath = path.join(rootDir, \`.restore-drill-\${crypto.randomUUID()}.sqlite\`);
  try {
    fs.copyFileSync(dbPath, drillPath, fs.constants.COPYFILE_EXCL);
    fsyncFile(drillPath);
    const validation = validateBackupDatabase(drillPath);
    const sourceHash = hashFile(dbPath);
    const drillHash = hashFile(drillPath);
    if (sourceHash.sha256 !== drillHash.sha256 || sourceHash.byteSize !== drillHash.byteSize) {
      const error = new Error('Restore drill copy does not match the snapshot database');
      error.code = 'BACKUP_RESTORE_DRILL_MISMATCH';
      throw error;
    }
    return { ...validation, sha256: drillHash.sha256, byteSize: drillHash.byteSize };
  } finally {
    try { fs.unlinkSync(drillPath); } catch { /* best effort */ }
  }
}

function validateBackupDatabase(dbPath) {`,
  'backup restore drill helper',
);
backup = replaceOnce(
  backup,
  `    const databaseValidation = validateBackupDatabase(dbPath);
    const dbHash = hashFile(dbPath);`,
  `    const databaseValidation = validateBackupDatabase(dbPath);
    const restoreDrill = verifyRestoreDrill(dbPath, tempDir);
    const dbHash = hashFile(dbPath);`,
  'backup restore drill execution',
);
backup = replaceOnce(
  backup,
  `    const mediaRows = store.db.prepare('SELECT sha256, relative_path, byte_size FROM media_blobs ORDER BY sha256').all();`,
  `    const mediaRows = store.db.prepare("SELECT sha256, relative_path, byte_size FROM media_blobs WHERE status = 'ready' ORDER BY sha256").all();`,
  'backup ready media only',
);
backup = replaceOnce(
  backup,
  `      database: { file: 'workflow.sqlite', ...dbHash, validation: databaseValidation },`,
  `      database: { file: 'workflow.sqlite', ...dbHash, validation: databaseValidation, restoreDrill },`,
  'backup manifest restore drill',
);
backup = replaceOnce(
  backup,
  `  validateBackupDatabase,
  createSnapshot,`,
  `  validateBackupDatabase,
  verifyRestoreDrill,
  createSnapshot,`,
  'backup restore drill export',
);
write('dev/automation/workflowBackup.js', backup);

// ---------------------------------------------------------------------------
// Reports: bounded retention. Final reports are preserved for 30 days / 60 runs;
// unresolved evidence remains in the durable SQLite store and is never pruned.
// ---------------------------------------------------------------------------
let report = read('dev/automation/reportEngine.js');
report = replaceOnce(
  report,
  `const { atomicWriteJson } = require('../utils/atomicJson');`,
  `const { atomicWriteJson } = require('../utils/atomicJson');

const DEFAULT_REPORT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_REPORT_MAX_RUNS = 60;`,
  'report retention constants',
);
report = replaceOnce(
  report,
  `  // Persist both JSON and TXT reports safely
  async flushAll() {`,
  `  static async pruneReportDirectory(reportDir, {
    now = Date.now(),
    maxAgeMs = DEFAULT_REPORT_MAX_AGE_MS,
    maxRuns = DEFAULT_REPORT_MAX_RUNS,
  } = {}) {
    if (!Number.isInteger(maxAgeMs) || maxAgeMs < 0) throw new TypeError('maxAgeMs must be non-negative');
    if (!Number.isInteger(maxRuns) || maxRuns < 1) throw new TypeError('maxRuns must be positive');
    let names = [];
    try { names = await fs.readdir(reportDir); } catch (error) {
      if (error.code === 'ENOENT') return { removed: [], kept: [] };
      throw error;
    }
    const files = [];
    for (const name of names) {
      if (!/^run-(?:partial-)?/.test(name) || !/\.(?:json|txt)$/.test(name)) continue;
      const fullPath = path.join(reportDir, name);
      try {
        const stat = await fs.stat(fullPath);
        if (stat.isFile()) files.push({ name, fullPath, mtimeMs: stat.mtimeMs });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
    const runKeys = [];
    const seen = new Set();
    for (const file of files) {
      const key = file.name.replace(/\.(json|txt)$/, '');
      if (!seen.has(key)) { seen.add(key); runKeys.push(key); }
    }
    const keepKeys = new Set(runKeys.slice(0, maxRuns));
    const cutoff = now - maxAgeMs;
    const removed = [];
    for (const file of files) {
      const key = file.name.replace(/\.(json|txt)$/, '');
      if (file.mtimeMs >= cutoff && keepKeys.has(key)) continue;
      try { await fs.unlink(file.fullPath); removed.push(file.fullPath); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    return { removed, kept: files.filter((file) => !removed.includes(file.fullPath)).map((file) => file.fullPath) };
  }

  // Persist both JSON and TXT reports safely
  async flushAll() {`,
  'report retention method',
);
report = replaceOnce(
  report,
  `      await fs.writeFile(txtPath, textReport, 'utf8');
      return { jsonPath, txtPath, success: true };`,
  `      await fs.writeFile(txtPath, textReport, 'utf8');
      const retention = await ReportEngine.pruneReportDirectory(this.reportDir).catch((error) => ({
        removed: [],
        error: error?.message || String(error),
      }));
      return { jsonPath, txtPath, success: true, retention };`,
  'report retention after flush',
);
report = replaceOnce(
  report,
  `module.exports = { ReportEngine };`,
  `module.exports = { ReportEngine, DEFAULT_REPORT_MAX_AGE_MS, DEFAULT_REPORT_MAX_RUNS };`,
  'report retention exports',
);
write('dev/automation/reportEngine.js', report);

// ---------------------------------------------------------------------------
// Regression tests: duplicate text, stale revisions, dead discard, proof gate,
// restore drill, report retention, and exposed renderer APIs.
// ---------------------------------------------------------------------------
write('test/durable-recovery-contract.test.js', `'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = path.join(os.tmpdir(), 'xposter-recovery-contract-' + Date.now());
os.homedir = () => SANDBOX;
fs.mkdirSync(path.join(SANDBOX, '.config', 'x-poster-bot-profile'), { recursive: true });

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? '\\n      ' + detail : '')); }
}

const dq = require('../dev/automation/durableQueue');
const { DurableSession } = require('../dev/automation/durableSession');

(async () => {
  try {
    const store = await dq.getStore();
    const profileId = await dq.resolveProfileId('Default');

    const duplicate = store.enqueue({
      items: [{ text: 'SAME', media_path: null }, { text: 'SAME', media_path: null }],
      requestId: 'same-fixture',
    }).items;
    const byText = await dq.bulkDeleteByText(['SAME']);
    check('duplicate text is never guessed', byText.deleted === 0 && byText.blocked[0]?.reason === 'AMBIGUOUS_TEXT_ADDRESS', JSON.stringify(byText));
    const selected = store.getItem(duplicate[1].id);
    const byId = await dq.bulkDeleteById([{
      id: selected.id,
      expectedRevision: selected.revision,
      requestId: 'delete-selected-id',
    }]);
    check('selected duplicate ID alone is deleted', byId.deleted === 1, JSON.stringify(byId));
    check('the first duplicate remains queued', store.getItem(duplicate[0].id).state === 'queued');

    const stale = store.getItem(duplicate[0].id);
    const run = store.startRun({ requestId: 'stale-run' });
    const session = new DurableSession({ store, profileId, runId: run.id, profileName: 'Default' });
    session.claimNext({ leaseMs: 60_000 });
    const staleDelete = await dq.bulkDeleteById([{
      id: stale.id,
      expectedRevision: stale.revision,
      requestId: 'stale-delete',
    }]);
    check('a stale queue revision is reported, not applied', staleDelete.deleted === 0 && staleDelete.blocked[0]?.reason === 'REVISION_CONFLICT', JSON.stringify(staleDelete));
    session.markTerminal('fixture', new Error('fixture'));
    store.finishRun({ runId: run.id, status: 'closed', requestId: 'stale-finish' });

    const dead = store.getItem(stale.id);
    const staleDead = await dq.discardDead({ id: dead.id, expectedRevision: dead.revision - 1, requestId: 'stale-dead' }).then(() => null, (error) => error);
    check('stale dead revision is rejected', staleDead?.code === 'REVISION_CONFLICT', staleDead?.message);
    const discarded = await dq.discardDead({ id: dead.id, expectedRevision: dead.revision, requestId: 'discard-dead' });
    check('dead discard reaches discarded state', discarded === true && store.getItem(dead.id).state === 'discarded');

    store.enqueue({ items: [{ text: 'MAYBE' }], requestId: 'maybe-fixture' });
    const run2 = store.startRun({ requestId: 'maybe-run' });
    const s2 = new DurableSession({ store, profileId, runId: run2.id, profileName: 'Default' });
    const maybe = s2.claimNext({ leaseMs: 60_000 });
    const boundary = s2.beginDispatch(maybe.text);
    s2.markAmbiguous('fixture');
    store.finishRun({ runId: run2.id, status: 'closed', requestId: 'maybe-finish' });
    const ambiguous = store.getItem(maybe.id);

    const noProof = await dq.confirmPublished({ id: ambiguous.id, expectedRevision: ambiguous.revision, requestId: 'no-proof' }, {}).then(() => null, (error) => error);
    check('confirm published requires proof', noProof?.code === 'PROOF_REQUIRED', noProof?.message);
    const unsafeDiscard = await dq.discardRecovery('Default', 'pending', { id: ambiguous.id, expectedRevision: ambiguous.revision, requestId: 'unsafe' }).then(() => null, (error) => error);
    check('ambiguous evidence cannot be generically discarded', unsafeDiscard?.code === 'UNSAFE_RECOVERY_ACTION', unsafeDiscard?.message);
    const requeued = await dq.confirmNotPublishedAndRequeue(
      { id: ambiguous.id, expectedRevision: ambiguous.revision, requestId: 'confirmed-not-published' },
      { confirmedNotPublished: true, evidence: { checked: true } },
    );
    check('explicit not-published decision requeues exact item', requeued === true && store.getItem(ambiguous.id).state === 'queued');
  } catch (error) {
    failed++;
    console.error(error?.stack || error);
  }
  try { await dq.closeStore(); } catch {}
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
  console.log(`\\n${failed === 0 ? '✅' : '❌'} durable-recovery-contract: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
`);

write('test/workflow-report-retention.test.js', `'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { ReportEngine } = require('../dev/automation/reportEngine');

const root = path.join(os.tmpdir(), 'xposter-report-retention-' + Date.now());
let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? '\\n      ' + detail : '')); }
}

(async () => {
  try {
    await fsp.mkdir(root, { recursive: true });
    const old = Date.now() - 90 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 5; i++) {
      const name = `run-${i}`;
      for (const ext of ['json', 'txt']) {
        const file = path.join(root, `${name}.${ext}`);
        await fsp.writeFile(file, 'x');
        const time = new Date(i < 3 ? old : Date.now());
        await fsp.utimes(file, time, time);
      }
    }
    const result = await ReportEngine.pruneReportDirectory(root, { maxAgeMs: 30 * 24 * 60 * 60 * 1000, maxRuns: 2 });
    check('old report pairs are removed', result.removed.length === 6, JSON.stringify(result));
    const remaining = await fsp.readdir(root);
    check('newest two run pairs remain', remaining.length === 4 && remaining.every((name) => /run-[34]/.test(name)), JSON.stringify(remaining));
  } catch (error) {
    failed++;
    console.error(error?.stack || error);
  }
  try { await fsp.rm(root, { recursive: true, force: true }); } catch {}
  console.log(`\\n${failed === 0 ? '✅' : '❌'} workflow-report-retention: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
`);

let smoke = read('test/smoke.test.js');
smoke = replaceOnce(
  smoke,
  `  'parseCSV', 'getQueue', 'addPosts', 'bulkDelete', 'startPosting',`,
  `  'parseCSV', 'getQueue', 'getQueueState', 'addPosts', 'bulkDelete', 'startPosting',`,
  'smoke queue state API',
);
smoke = replaceOnce(
  smoke,
  `  'exportQueue', 'onStatusUpdate', 'getRecoveryItems', 'requeueRecoveryItem', 'discardRecoveryItem',`,
  `  'exportQueue', 'onStatusUpdate', 'getRecoveryItems', 'confirmRecoveryPublished',
  'confirmRecoveryNotPublished', 'requeueDeadRecovery', 'discardDeadRecovery',
  'workflowHealth', 'createWorkflowBackup',`,
  'smoke recovery APIs',
);
smoke = replaceOnce(
  smoke,
  `       const queueOk = await win.webContents.executeJavaScript(\`
         (async () => {
           const q = await window.api.getQueue('Default');
           return Array.isArray(q) ? 'ok' : 'not-array';
         })()
       \`);
       if (queueOk !== 'ok') errors.push('QUEUE FETCH: ' + queueOk);`,
  `       const queueOk = await win.webContents.executeJavaScript(\`
         (async () => {
           const q = await window.api.getQueueState();
           return q && q.success === true && Array.isArray(q.items) ? 'ok' : JSON.stringify(q);
         })()
       \`);
       if (queueOk !== 'ok') errors.push('QUEUE STATE FETCH: ' + queueOk);`,
  'smoke typed queue state',
);
write('test/smoke.test.js', smoke);

console.log('xposter follow-up repair applied successfully.');
