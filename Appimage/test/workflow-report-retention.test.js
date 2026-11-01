'use strict';

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
  else { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
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
  console.log(`\n${failed === 0 ? '✅' : '❌'} workflow-report-retention: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
