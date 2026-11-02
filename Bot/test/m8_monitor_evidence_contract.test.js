'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Guardrail regression tests for a historical monitor that writes live evidence.
// These are SOURCE CONTRACT tests, not a substitute for a new live production run.
const source = fs.readFileSync(path.join(__dirname, '../scripts/m8_live_production_monitor.js'), 'utf8');
test('monitor must not directly forge a cycle stop or daily scheduler marker', () => {
  assert.doesNotMatch(source, /s\.cycle\.state\s*=\s*['"]stopping['"]/);
  assert.doesNotMatch(source, /s\.uiScheduleDay\s*=/);
  assert.match(source, /WAITING_FOR_AUTHENTIC_STOP/);
});
test('monitor must not invent a per-item quota increment across Riyadh midnight', () => {
  assert.doesNotMatch(source, /quotaAfter\s*=\s*quotaBefore\s*\+\s*1/);
  assert.match(source, /quotaAtObservation/);
  assert.match(source, /Asia\/Riyadh/);
});
test('monitor must not claim success without stopped cycle and document receipt', () => {
  assert.match(source, /endState\.cycle\?\.state\s*===\s*'stopped'/);
  assert.match(source, /deliveryReceipt\?\.messageId/);
  assert.match(source, /throw new Error\('M8 verification INCOMPLETE/);
});
test('monitor must scope published posts to current run and read the service PID', () => {
  assert.match(source, /allowedRunItemIds\.has\(i\.id\)/);
  assert.doesNotMatch(source, /ps -p 941694/);
  assert.match(source, /systemctl show --property=MainPID/);
});
test('monitor must restore original schedule even when the run fails', () => {
  assert.match(source, /finally\s*\{/);
  assert.match(source, /scheduleModified\)\s+await settings\.setSchedule\(origSchedule\)/);
});