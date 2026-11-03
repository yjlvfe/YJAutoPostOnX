'use strict';
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { buildAmbiguousInventory } = require('../src/ambiguousAudit');

// Open an EXISTING state database strictly read-only. This script never
// requeues, deletes, acknowledges, publishes or changes the production state.
function main(argv = process.argv.slice(2)) {
  if (argv.length > 1) throw new Error('Usage: node scripts/audit_ambiguous_readonly.js [existing-state.sqlite]');
  const dbPath = path.resolve(argv[0] || path.join(__dirname, '../data/state.sqlite'));
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare('SELECT json, revision FROM state WHERE id = 1').get();
    if (!row || !row.json) throw new Error('Missing production state record');
    const state = JSON.parse(row.json);
    const inventory = buildAmbiguousInventory(state);
    const payload = {
      auditKind: 'READ_ONLY_AMBIGUOUS_INVENTORY',
      revision: row.revision,
      auditedAt: new Date().toISOString(),
      total: inventory.length,
      autoRequeueAllowed: false,
      items: inventory
    };
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  } finally { db.close(); }
}
if (require.main === module) {
  try { main(); } catch (error) {
    process.stderr.write(JSON.stringify({
      event: 'ambiguous_inventory_failed',
      code: error.code || 'AUDIT_ERROR',
      // Do not print arbitrary raw exception messages from private paths.
      hint: 'Check SQLite path, file permissions, and schema'
    }) + '\n');
    process.exitCode = 1;
  }
}
module.exports = { main };
