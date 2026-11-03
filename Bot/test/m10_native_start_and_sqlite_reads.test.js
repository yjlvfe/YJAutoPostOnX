'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { SqliteStore } = require('../src/sqliteStore');
const { TelegramUi } = require('../src/telegramUi');

test('SQLite read uses a deferred transaction and returns independent snapshots', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yj-m10-sqlite-'));
  const db = new SqliteStore(path.join(dir, 'state.sqlite'),
    { counter: 0, items: Array.from({ length: 250 }, (_, i) => ({ id: i, text: 'sample-' + i })) });
  try {
    const seen = [];
    const original = db._transaction.bind(db);
    db._transaction = (fn, opts) => { seen.push(opts || {}); return original(fn, opts); };
    const first = await db.load();
    assert.equal(seen[0].immediate, false, 'load must not reserve writer lock');
    first.items[0].text = 'changed only in caller';
    const second = await db.load();
    assert.equal(second.items[0].text, 'sample-0');
    await db.update(s => { s.counter += 1; return s; });
    const third = await db.load();
    assert.equal(third.counter, 1);
    assert.ok(seen.some(opts => opts.immediate === undefined), 'writes retain BEGIN IMMEDIATE');
  } finally {
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createUiHarness(initial = 'stopped') {
  let state = {
    cycle: { state: initial, runId: null },
    items: [{ id: 'post-1', state: 'pending', payload: { text: 'approved item' } }],
    accounts: [{ id: 'acc-1', username: 'account1', cookieFile: '/tmp/dummy-only', enabled: true }],
    posting: { quota: {} },
    settings: { dailyQuota: 10, delayMinSeconds: 15, delayMaxSeconds: 30 },
    telegramUi: { users: {}, dashboards: {}, activePanelsByChatId: {} }
  };
  const store = {
    load: async () => structuredClone(state),
    update: async mutator => { const draft = structuredClone(state);
      state = (await mutator(draft)) || draft; return structuredClone(state); }
  };
  const notifications = [];
  let complete;
  const job = new Promise(resolve => { complete = resolve; });
  const ui = new TelegramUi({
    bot: { store, transport: {}, logger: { log: () => {}, info: () => {}, error: () => {}, warn: () => {} } },
    launch: () => job,
    notify: async text => { notifications.push(text); return [{ status: 'fulfilled', value: { message_id: 123 } }]; },
    onPanelTask: () => {}
  });
  ui.readiness = async () => ({ reasons: [], ids: ['acc-1'] });
  ui.refreshPanels = async () => {};
  return { ui, notifications, complete };
}

for (const [source, expected] of [
  ['manual', 'المصدر: زر تيليجرام'],
  ['scheduled', 'المصدر: الجدولة'],
  ['control', 'المصدر: التحكم الداخلي']
]) {
  test('accepted ' + source + ' start sends truthful origin + runId receipt', async () => {
    const h = createUiHarness();
    try {
      const result = await h.ui.begin(source);
      assert.equal(result.started, true);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(h.notifications.length, 1);
      assert.match(h.notifications[0], /تم استلام طلب تشغيل النشر/);
      assert.ok(h.notifications[0].includes(expected));
      assert.ok(h.notifications[0].includes(result.runId));
    } finally { h.complete(); await h.ui.job; await h.ui.stopTicker(); }
  });
}

test('rejected start cannot produce false startup notification', async () => {
  const h = createUiHarness('running');
  try {
    const result = await h.ui.begin('manual');
    assert.equal(result.started, false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.notifications.length, 0);
  } finally { h.complete(); await h.ui.stopTicker(); }
});

test('fast panel timing restored; real publish diagnostics are recorded', () => {
  const ui = fs.readFileSync(path.join(__dirname, '../src/telegramUi.js'), 'utf8');
  const runner = fs.readFileSync(path.join(__dirname, '../src/runner.js'), 'utf8');
  assert.match(ui, /\}, 1000\);\s*this\.ticker\.unref/);
  assert.match(ui, /inHoursStage \? 60000 : 5000/);
  assert.match(runner, /event: 'publish_attempt_observation'/);
  assert.match(runner, /textCodePoints:/);
  assert.match(runner, /event: 'notify_send_success'/);
  assert.match(ui, /cycle_start_notification_completed/);
});
