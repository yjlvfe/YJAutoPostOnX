'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { recordUnsuccessfulAttempt, getUnsuccessfulAttempts } = require('../src/attemptOutcomes');
const { formatAccountTable } = require('../src/accountTable');

test('failed and ambiguous attempts are separate and a published outcome is not counted', () => {
  const s = {};
  recordUnsuccessfulAttempt(s, { accountId:'a', outcome:'failed', at:'2026-11-03T02:45:00Z' });
  recordUnsuccessfulAttempt(s, { accountId:'a', outcome:'ambiguous', at:'2026-11-03T02:46:00Z' });
  assert.equal(recordUnsuccessfulAttempt(s, { accountId:'a', outcome:'published' }), false);
  assert.deepEqual(getUnsuccessfulAttempts(s,'a','2026-11-03T05:00:00Z'),
    { failed:1, ambiguous:1, total:2 });
});

test('each account owns independent counters', () => {
  const s = {};
  recordUnsuccessfulAttempt(s, { accountId:'one', outcome:'ambiguous', at:'2026-11-03T02:46:00Z' });
  recordUnsuccessfulAttempt(s, { accountId:'two', outcome:'failed', at:'2026-11-03T02:47:00Z' });
  assert.equal(getUnsuccessfulAttempts(s,'one','2026-11-03T02:47:00Z').failed,0);
  assert.equal(getUnsuccessfulAttempts(s,'two','2026-11-03T02:47:00Z').ambiguous,0);
});

test('Riyadh midnight rolls over counters at 21:00 UTC', () => {
  const s = {};
  recordUnsuccessfulAttempt(s, { accountId:'a', outcome:'ambiguous', at:'2026-11-02T20:59:59Z' });
  recordUnsuccessfulAttempt(s, { accountId:'a', outcome:'failed', at:'2026-11-02T21:00:00Z' });
  assert.deepEqual(getUnsuccessfulAttempts(s,'a','2026-11-02T20:59:59Z'),
    { failed:0, ambiguous:1, total:1 });
  assert.deepEqual(getUnsuccessfulAttempts(s,'a','2026-11-02T21:00:00Z'),
    { failed:1, ambiguous:0, total:1 });
});

test('stored statistics retain no more than 14 days', () => {
  const s = {};
  for(let i=0;i<22;i++)
    recordUnsuccessfulAttempt(s,{accountId:'a',outcome:'failed',at:new Date(Date.UTC(2026,9,1+i,12))});
  assert.equal(Object.keys(s.posting.attemptOutcomes).length,14);
});

test('account panel exposes failed and ambiguous attempts, independently of quota', () => {
  const s={settings:{dailyQuota:10},accounts:[{id:'acc1',username:'sample',enabled:true,status:'مفعل',exitIp:'8.8.8.8'}]};
  recordUnsuccessfulAttempt(s,{accountId:'acc1',outcome:'ambiguous',at:'2026-11-03T02:47:00Z'});
  recordUnsuccessfulAttempt(s,{accountId:'acc1',outcome:'failed',at:'2026-11-03T02:48:00Z'});
  const html = formatAccountTable(s,{now:new Date('2026-11-03T03:00:00Z')});
  assert.match(html,/فشل\/غامض/);
  assert.match(html,/1\/1/);
  assert.match(html,/@sample/);
});

test('counter increments only at state transition sites, retaining claim fences', () => {
  const runner=fs.readFileSync(path.join(__dirname,'../src/runner.js'),'utf8');
  assert.equal((runner.match(/recordUnsuccessfulAttempt\(s,/g)||[]).length,6);
  assert.match(runner,/if \(newState !== 'published'\)/);
  assert.match(runner,/i\.attempt\.token !== claim\.token/);
});

test('rotation logging is change-sensitive and preserves selection strategy', () => {
  const runner=fs.readFileSync(path.join(__dirname,'../src/runner.js'),'utf8');
  assert.match(runner,/account_rotation_decision/);
  assert.match(runner,/rotationSignature !== lastRotationSignature/);
  assert.match(runner,/const cursor = state\.telegramUi\?\.run\?\.cursor \|\| 0/);
});

test('panel throttling retains explicit immediate updates on start and stop', () => {
  const ui=fs.readFileSync(path.join(__dirname,'../src/telegramUi.js'),'utf8');
  assert.match(ui,/\}, 3000\);\s*this\.ticker\.unref/);
  assert.match(ui,/inHoursStage \? 60000 : 15000/);
  assert.match(ui,/this\.refreshPanels\(true\)/);
  assert.match(ui,/منشورات غامضة تحتاج مراجعة/);
});

test('rate limit before dispatch is pending, after dispatch is ambiguous', () => {
  const { classifyPublishOutcome } = require('../src/publishOutcome');
  const r = { published: false, rateLimit: true };
  assert.equal(classifyPublishOutcome(r, false), 'pending');
  assert.equal(classifyPublishOutcome(r, true), 'ambiguous');
});

test('unconfirmed outcomes stay quarantined; confirmed publish requires a URL', () => {
  const { classifyPublishOutcome } = require('../src/publishOutcome');
  assert.equal(classifyPublishOutcome({ published: true }, false), 'ambiguous');
  assert.equal(classifyPublishOutcome({ ambiguous: true }, false), 'ambiguous');
  assert.equal(classifyPublishOutcome({ published: true, url: 'https://x.com/a/status/123' }, true), 'published');
  assert.equal(classifyPublishOutcome({ reason: 'tweet_too_long' }, false), 'cancelled');
  assert.equal(classifyPublishOutcome({ reason: 'identity_read_unavailable' }, false), 'pending');
});
