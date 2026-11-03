'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const file = path.join(__dirname, '../scripts/live_production_5_rounds_monitor.js');
const source = fs.readFileSync(file, 'utf8');
const runId = 'b97fd7d352319b40c21649b5';

async function simulate({ journalPosts = 21, missingReceipt = false } = {}) {
  const files = new Map();
  let reads = 0;
  const posts = Array.from({ length: 21 }, (_, i) => ({
    id: 'item-' + i, state: 'published', publishedAt:
      new Date(Date.parse('2026-11-03T04:10:25Z') + (i + 1) * 40000).toISOString(),
    url: 'https://x.com/example/status/' + (1000 + i),
    accountId: 'acc-a', accountUsername: 'example', payload: { text: 'approved' }
  }));
  const snapshot = done => ({
    cycle: { state: done ? 'stopped' : 'running',
      runId: done ? null : runId, startedAt: '2026-11-03T04:10:25Z' },
    telegramUi: { run: { runId, itemIds: posts.map(p => p.id), accountIds: ['acc-a'] } },
    items: posts.slice(0, done ? 21 : 16),
    accounts: [], posting: { quota: {} }, settings: { dailyQuota: 10 },
    linkTerminalEvents: done ? [{ runId, chatId: '111' }, { runId, chatId: '222' }] : [],
    linkDeliveries: done ? [
      { runId, chatId: '111', kind: 'document', ok: true, messageId: 11 },
      ...(!missingReceipt ? [{ runId, chatId: '222', kind: 'document', ok: true, messageId: 12 }] : [])
    ] : []
  });
  const fakeFs = {
    mkdirSync() {},
    writeFileSync(p, data) { files.set(p, String(data)); },
    appendFileSync(p, data) { files.set(p, (files.get(p) || '') + data); },
    readFileSync(p) { return files.get(p) || ''; }
  };
  const fakeDb = class {
    prepare() { return { get() { return { json: JSON.stringify(snapshot(++reads > 1)) }; } }; }
    close() {}
  };
  const journal = posts.slice(0, journalPosts).map(p => JSON.stringify({
    event: 'post_result', status: 'published', item: p.id, url: p.url
  })).join('\n');
  const fakeRequire = name => ({
    fs: fakeFs,
    path: { join: (...p) => p.join('/') },
    child_process: { execFileSync: () => journal },
    'node:sqlite': { DatabaseSync: fakeDb }
  })[name];
  const proc = { exitCode: 0 };
  const context = { require: fakeRequire, process: proc,
    console: { log() {}, error() {} },
    setTimeout: fn => { Promise.resolve().then(fn); return 1; } };
  vm.runInNewContext(source, context, { filename: file, timeout: 1000 });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  const output = [...files].find(([key]) => key.endsWith('MONITOR_VERDICT.json'));
  return { verdict: output ? JSON.parse(output[1]) : null, processExitCode: proc.exitCode, reads };
}

test('monitor does not truncate journal at 16 posts; waits for 21 plus CSV receipts', async () => {
  const { verdict, reads, processExitCode } = await simulate();
  assert.ok(reads >= 2);
  assert.equal(verdict.observedPublished, 21);
  assert.equal(verdict.journalConfirmed, 21);
  assert.equal(verdict.terminalVerified, true);
  assert.equal(verdict.status, 'VERIFIED');
  assert.equal(processExitCode, 0);
});

test('missing final journal proof never reports success', async () => {
  const { verdict, processExitCode } = await simulate({ journalPosts: 16 });
  assert.equal(verdict.status, 'INCOMPLETE');
  assert.equal(verdict.journalConfirmed, 16);
  assert.equal(verdict.missingPostResultItemIds.length, 5);
  assert.equal(processExitCode, 1);
});

test('missing one chat CSV receipt never reports success', async () => {
  const { verdict, processExitCode } = await simulate({ missingReceipt: true });
  assert.equal(verdict.status, 'INCOMPLETE');
  assert.equal(verdict.terminalVerified, false);
  assert.equal(processExitCode, 1);
});

test('monitor scopes published posts to actual run itemIds and cannot mutate cycle', () => {
  assert.match(source, /runItemIds\.has\(i\.id\)/);
  assert.match(source, /terminalVerified/);
  assert.match(source, /missingPostResultItemIds/);
  assert.doesNotMatch(source, /s\.cycle\.state\s*=/);
  assert.doesNotMatch(source, /setSchedule\s*\(/);
  assert.doesNotMatch(source, /ui\.begin\s*\(/);
  assert.match(source, /execFileSync\('journalctl'/);
});
