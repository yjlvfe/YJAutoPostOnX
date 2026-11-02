'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { SqliteStore } = require('../src/sqliteStore');
const { createLinkExports, dayOf, csv } = require('../src/linkExports');
const { TelegramUi } = require('../src/telegramUi');

function createMockTelegramApi() {
  const sentDocuments = [];
  const sentMessages = [];
  return {
    sentDocuments,
    sentMessages,
    sendMessage: async ({ chat_id, text }) => {
      const msg = { chat_id: String(chat_id), text, message_id: 1000 + sentMessages.length + 1 };
      sentMessages.push(msg);
      return msg;
    },
    sendDocument: async ({ chat_id, filename, content }) => {
      const doc = { chat_id: String(chat_id), filename, content, message_id: 2000 + sentDocuments.length + 1 };
      sentDocuments.push(doc);
      return doc;
    },
    editMessageText: async () => ({ message_id: 1 })
  };
}

describe('Milestone M5: Cycle Stop Reporting & Independent Cycle CSV Delivery Suite', () => {

  test('1. Cycle finish with existing today links sends daily CSV even if current run posted 0 new items', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm5-report-test-1-'));
    const dbPath = path.join(tempDir, 'state.sqlite');
    const now = new Date('2026-11-02T10:00:00.000Z');

    const store = new SqliteStore(dbPath, {
      items: [
        { id: 'item-1', state: 'published', url: 'https://x.com/status/1', publishedAt: now.toISOString(), payload: { text: 'Post 1' } },
        { id: 'item-2', state: 'published', url: 'https://x.com/status/2', publishedAt: now.toISOString(), payload: { text: 'Post 2' } }
      ],
      accounts: [{ id: 'acc-1', username: 'testuser', enabled: true }]
    });
    await store.load();

    const api = createMockTelegramApi();
    const links = createLinkExports({
      store,
      dataDir: tempDir,
      api,
      chatId: '528864559',
      clock: () => now
    });

    // Run A (Cycle A): Delivers the 2 posts confirmed today
    const runA = { runId: 'cycle-A', endedAt: now.toISOString(), itemIds: ['item-1', 'item-2'] };
    await links.send(runA, { terminal: true });
    assert.strictEqual(api.sentDocuments.length, 1, 'Cycle A delivered daily CSV');
    assert.strictEqual(api.sentDocuments[0].filename, 'links_2026-11-02.csv');

    // Run B (Cycle B): New independent cycle stopped with ZERO new posts posted by Run B
    const later = new Date('2026-11-02T11:00:00.000Z');
    const runB = { runId: 'cycle-B', endedAt: later.toISOString(), itemIds: [] };
    await links.send(runB, { terminal: true });

    // Under user requirement: Independent cycle B MUST receive today's daily CSV!
    assert.strictEqual(api.sentDocuments.length, 2, 'Cycle B MUST deliver daily CSV even though 0 new items were posted by Cycle B');
    assert.strictEqual(api.sentDocuments[1].filename, 'links_2026-11-02.csv');
    assert.ok(api.sentDocuments[1].content.includes('https://x.com/status/1'));
    assert.ok(api.sentDocuments[1].content.includes('https://x.com/status/2'));

    const state = await store.load();
    const eventB = state.linkTerminalEvents.find(e => e.runId === 'cycle-B');
    assert.ok(eventB, 'Terminal event recorded for cycle-B');
    assert.strictEqual(eventB.suppressed, undefined, 'Cycle B terminal event is NOT suppressed');

    const deliveryB = (state.linkDeliveries || []).find(d => d.runId === 'cycle-B' && d.ok);
    assert.ok(deliveryB, 'Delivery record exists with ok: true for cycle-B');

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('2. Re-executing onCycleFinished for the SAME runId is deduplicated (zero duplicate sends)', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm5-report-test-2-'));
    const dbPath = path.join(tempDir, 'state.sqlite');
    const now = new Date('2026-11-02T10:00:00.000Z');

    const store = new SqliteStore(dbPath, {
      items: [
        { id: 'item-1', state: 'published', url: 'https://x.com/status/1', publishedAt: now.toISOString(), payload: { text: 'Post 1' } }
      ]
    });
    await store.load();

    const api = createMockTelegramApi();
    const logs = [];
    const links = createLinkExports({
      store,
      dataDir: tempDir,
      api,
      chatId: '528864559',
      logger: { log: msg => logs.push(msg), error: () => {} },
      clock: () => now
    });

    const runId = 'cycle-idempotent-1';
    const run = { runId, endedAt: now.toISOString(), itemIds: ['item-1'] };

    // Initial finish
    await links.send(run, { terminal: true });
    assert.strictEqual(api.sentDocuments.length, 1, 'Initial finish delivers 1 CSV');

    // Replay / crash recovery simulation: re-executing finish for the exact same runId
    await links.send(run, { terminal: true });
    await links.send(run, { terminal: true });

    assert.strictEqual(api.sentDocuments.length, 1, 'Replays of same runId produce ZERO additional documents');

    const state = await store.load();
    const replayEvents = state.linkTerminalEvents.filter(e => e.runId === runId && e.suppressed === true);
    assert.strictEqual(replayEvents.length, 2, '2 replay attempts recorded as suppressed');
    assert.strictEqual(replayEvents[0].reason, 'duplicate_run_id');

    const deliveries = (state.linkDeliveries || []).filter(d => d.runId === runId && d.ok === true && !d.suppressed);
    assert.strictEqual(deliveries.length, 1, 'Exactly 1 successful delivery record in store');

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('3. Consecutive independent cycles with different runIds both receive reports', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm5-report-test-3-'));
    const dbPath = path.join(tempDir, 'state.sqlite');
    const now = new Date('2026-11-02T08:00:00.000Z');

    const store = new SqliteStore(dbPath, {
      items: [
        { id: 'item-1', state: 'published', url: 'https://x.com/status/1', publishedAt: now.toISOString(), payload: { text: 'Morning Post' } }
      ]
    });
    await store.load();

    const api = createMockTelegramApi();
    const links = createLinkExports({
      store,
      dataDir: tempDir,
      api,
      chatId: '528864559',
      clock: () => now
    });

    // 3 consecutive independent cycles
    const cycles = ['cycle-morning', 'cycle-midday', 'cycle-evening'];
    for (let i = 0; i < cycles.length; i++) {
      const cycleRun = {
        runId: cycles[i],
        endedAt: new Date(now.getTime() + (i + 1) * 3600 * 1000).toISOString(),
        itemIds: []
      };
      await links.send(cycleRun, { terminal: true });
    }

    assert.strictEqual(api.sentDocuments.length, 3, 'All 3 independent cycles delivered CSV reports');
    for (let i = 0; i < 3; i++) {
      assert.strictEqual(api.sentDocuments[i].chat_id, '528864559');
      assert.strictEqual(api.sentDocuments[i].filename, 'links_2026-11-02.csv');
    }

    const state = await store.load();
    for (const cycleId of cycles) {
      const del = (state.linkDeliveries || []).find(d => d.runId === cycleId && d.ok);
      assert.ok(del, `Delivery confirmed for ${cycleId}`);
    }

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('4. Cycle finish with 0 links sends clear empty notice', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm5-report-test-4-'));
    const dbPath = path.join(tempDir, 'state.sqlite');
    const now = new Date('2026-11-02T12:00:00.000Z');

    // Database with ZERO published items for today
    const store = new SqliteStore(dbPath, {
      items: [
        { id: 'item-old', state: 'published', url: 'https://x.com/status/old', publishedAt: '2026-11-01T12:00:00.000Z', payload: { text: 'Yesterday' } },
        { id: 'item-pending', state: 'pending', payload: { text: 'Pending' } }
      ]
    });
    await store.load();

    const api = createMockTelegramApi();
    const links = createLinkExports({
      store,
      dataDir: tempDir,
      api,
      chatId: '528864559',
      clock: () => now
    });

    const runId = 'cycle-empty-run-1';
    await links.send({ runId, endedAt: now.toISOString(), itemIds: [] }, { terminal: true });

    // Zero documents sent (no empty CSV file created)
    assert.strictEqual(api.sentDocuments.length, 0, 'Zero CSV documents sent when 0 links exist today');

    // Exactly 1 clear text message sent
    assert.strictEqual(api.sentMessages.length, 1, 'Clear empty notice message sent to Telegram');
    assert.strictEqual(api.sentMessages[0].chat_id, '528864559');
    assert.strictEqual(api.sentMessages[0].text, 'لا توجد روابط منشورات مؤكدة لهذا اليوم.');

    // Idempotency: Re-executing for same runId is deduplicated
    await links.send({ runId, endedAt: now.toISOString(), itemIds: [] }, { terminal: true });
    assert.strictEqual(api.sentMessages.length, 1, 'Replay of empty cycle does not re-send notice');

    const state = await store.load();
    const event = state.linkTerminalEvents.find(e => e.runId === runId);
    assert.ok(event);
    assert.strictEqual(event.reason, 'empty_rows');
    assert.strictEqual(event.reconciled, true);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('5. Ambiguous Telegram sends are safely quarantined with attempt tokens intact', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm5-report-test-5-'));
    const dbPath = path.join(tempDir, 'state.sqlite');
    const now = new Date('2026-11-02T10:00:00.000Z');

    const store = new SqliteStore(dbPath, {
      items: [
        { id: 'item-1', state: 'published', url: 'https://x.com/status/1', publishedAt: now.toISOString(), payload: { text: 'Post 1' } }
      ]
    });
    await store.load();

    let attemptsCount = 0;
    const failingApi = {
      sendMessage: async () => ({ message_id: 1 }),
      sendDocument: async () => {
        attemptsCount++;
        const error = new Error('ECONNRESET: socket hang up');
        error.code = 'ECONNRESET';
        // Absence of explicit receipt: uncertain/ambiguous failure
        error.ambiguous = true;
        throw error;
      }
    };

    const links = createLinkExports({
      store,
      dataDir: tempDir,
      api: failingApi,
      chatId: '528864559',
      clock: () => now
    });

    const runId = 'cycle-ambig-transport';
    await assert.rejects(
      async () => links.send({ runId, endedAt: now.toISOString(), itemIds: ['item-1'] }, { terminal: true }),
      /ECONNRESET/
    );

    const state = await store.load();
    const outboxItem = state.linkOutbox.find(o => o.runId === runId);
    assert.ok(outboxItem, 'Outbox item exists');
    assert.strictEqual(outboxItem.status, 'ambiguous', 'Outbox status is quarantined as ambiguous');

    const deliveryRecord = state.linkDeliveries.find(d => d.runId === runId);
    assert.ok(deliveryRecord, 'Delivery record exists');
    assert.strictEqual(deliveryRecord.attempted, true, 'attempted is strictly true');
    assert.strictEqual(deliveryRecord.ok, false, 'ok is false');

    // Flush or reconcile must NOT retry an ambiguous item
    await links.flush();
    assert.strictEqual(attemptsCount, 1, 'Ambiguous item must NEVER be retried');

    const stateAfterFlush = await store.load();
    const outboxItemAfter = stateAfterFlush.linkOutbox.find(o => o.runId === runId);
    assert.strictEqual(outboxItemAfter.status, 'ambiguous', 'Status remains quarantined as ambiguous');

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('6. UI Stop action sends explicit Telegram acknowledgment and triggers lifecycle callbacks', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm5-report-test-6-'));
    const dbPath = path.join(tempDir, 'state.sqlite');

    const store = new SqliteStore(dbPath, {
      cycle: { state: 'running', runId: 'run-ui-stop-1' },
      telegramUi: {
        run: { runId: 'run-ui-stop-1', maxItems: 5 },
        dashboards: { '528864559': { token: 'tok-curr-123', stopToken: 'tok-curr-123' } }
      }
    });
    await store.load();

    const notifications = [];
    let cycleStoppedCalled = false;
    let stoppedSnapshot = null;

    const ui = new TelegramUi({
      bot: { store, transport: { editMessageText: async () => ({}) } },
      notify: async msg => { notifications.push(msg); },
      onCycleStop: snapshot => {
        cycleStoppedCalled = true;
        stoppedSnapshot = snapshot;
      }
    });

    const result = await ui.stop('tok-curr-123', { chat: 528864559, key: '528864559' });
    assert.strictEqual(result.stopped, true, 'Cycle stop is accepted');
    assert.strictEqual(cycleStoppedCalled, true, 'onCycleStop callback was executed');
    assert.strictEqual(stoppedSnapshot?.runId, 'run-ui-stop-1');

    // Notification verification: operator received immediate Arabic acknowledgment
    assert.strictEqual(notifications.length, 1, 'Operator received 1 Telegram notification on stop');
    assert.ok(notifications[0].includes('تم استقبال طلب إيقاف دورة النشر'), 'Notification informs user of stop request');

    const finalState = await store.load();
    assert.strictEqual(finalState.cycle.state, 'stopping', 'Cycle transitioned to stopping');

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

});
