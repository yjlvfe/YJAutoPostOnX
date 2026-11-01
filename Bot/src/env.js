'use strict';
const fs = require('node:fs');
const path = require('node:path');
function loadLocalEnv(file = path.join(__dirname, '..', '.env.local')) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !m[1].startsWith('#')) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}
function config(file) { const local = loadLocalEnv(file); return { ...local, ...process.env }; }
module.exports = { loadLocalEnv, config };
