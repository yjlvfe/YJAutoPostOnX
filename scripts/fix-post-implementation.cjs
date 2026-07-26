'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const touched = new Set();

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function write(rel, content) {
  fs.writeFileSync(path.join(ROOT, rel), content, 'utf8');
  touched.add(rel);
}

function replaceOnce(rel, source, from, to, label, { required = true } = {}) {
  const first = source.indexOf(from);
  if (first === -1) {
    if (source.includes(to)) return source;
    if (required) throw new Error(`Missing cleanup anchor (${rel}): ${label}`);
    return source;
  }
  if (source.indexOf(from, first + from.length) !== -1) {
    throw new Error(`Non-unique cleanup anchor (${rel}): ${label}`);
  }
  return source.slice(0, first) + to + source.slice(first + from.length);
}

function replaceAllLiteral(source, from, to) {
  return source.split(from).join(to);
}

// Renderer: repair source corruption from repeated generated replacements and
// keep cleanup-only orphaned media from falsely disabling publishing.
{
  const rel = 'dev/ui/renderer.js';
  let source = read(rel);
  source = replaceAllLiteral(
    source,
    'function updateQueueCounters() {function updateQueueCounters() {function updateQueueCounters() {',
    'function updateQueueCounters() {',
  );
  source = replaceAllLiteral(
    source,
    '// import CSV// import CSV// import CSV (two buttons share logic)',
    '// import CSV (two buttons share logic)',
  );
  source = replaceOnce(
    rel,
    source,
    "  const healthy = result.integrity && result.integrity.ok === true;",
    "  const integrity = result.integrity || {};\n" +
      "  const healthy = integrity.quickCheck === 'ok'\n" +
      "    && (!Array.isArray(integrity.foreignKeyViolations) || integrity.foreignKeyViolations.length === 0)\n" +
      "    && (!Array.isArray(integrity.mediaProblems) || integrity.mediaProblems.length === 0)\n" +
      "    && (!Array.isArray(integrity.stateConsistencyViolations) || integrity.stateConsistencyViolations.length === 0);",
    'renderer critical health decision',
  );
  write(rel, source);
}

// Durable queue: preserve strict compare-and-swap semantics for destructive
// operations, report the real backlog size, and make lightweight UI reads avoid
// hashing every media blob on every refresh.
{
  const rel = 'dev/automation/durableQueue.js';
  let source = read(rel);
  source = replaceAllLiteral(
    source,
    '// ── Paginating reads// ── Paginating reads ─────────────────────────────────────────────────────────',
    '// ── Paginating reads ─────────────────────────────────────────────────────────',
  );
  source = replaceAllLiteral(
    source,
    '/**\n * Resolve a profile name/**\n * Resolve a profile name to its stable UUID, creating it if needed.',
    '/**\n * Resolve a profile name to its stable UUID, creating it if needed.',
  );
  source = replaceAllLiteral(
    source,
    '// ── Recovery// ── Recovery// ── Recovery ─────────────────────────────────────────────────────────────────',
    '// ── Recovery ─────────────────────────────────────────────────────────────────',
  );
  source = replaceAllLiteral(
    source,
    '// ── Maintenance// ── Maintenance// ── Maintenance ──────────────────────────────────────────────────────────────',
    '// ── Maintenance ──────────────────────────────────────────────────────────────',
  );
  source = replaceAllLiteral(
    source,
    'total: readAllQueuedItems(store).length',
    'total: readAllBacklogItems(store).length',
  );
  source = replaceOnce(
    rel,
    source,
    "  for (const request of normalized) {\n    const item = live.get(request.id);",
    "  for (const request of normalized) {\n" +
      "    if (request.expectedRevision === null) {\n" +
      "      blocked.push({ id: request.id, reason: 'REVISION_REQUIRED' });\n" +
      "      continue;\n" +
      "    }\n" +
      "    const item = live.get(request.id);",
    'bulk delete requires revision',
  );
  source = replaceOnce(
    rel,
    source,
    "async function integrityCheck() {\n  const store = await getStore();\n  return store.integrityCheck();\n}",
    "async function integrityCheck(options = {}) {\n  const store = await getStore();\n  return store.integrityCheck(options);\n}",
    'integrity check options passthrough',
  );
  write(rel, source);
}

// Main-process queue refresh uses a lightweight integrity read. The irreversible
// start-posting gate still performs the full media verification via assertHealthy().
{
  const rel = 'dev/main.js';
  let source = read(rel);
  source = replaceOnce(
    rel,
    source,
    "    const [items, counts, integrity, unresolved] = await Promise.all([\n" +
      "      durableQueue.getQueueDetailed(),\n" +
      "      durableQueue.getBacklogCounts(),\n" +
      "      durableQueue.integrityCheck(),\n" +
      "      durableQueue.countUnresolved(),\n" +
      "    ]);",
    "    const [items, counts, integrity, unresolved] = await Promise.all([\n" +
      "      durableQueue.getQueueDetailed(),\n" +
      "      durableQueue.getBacklogCounts(),\n" +
      "      durableQueue.integrityCheck({ verifyMedia: false }),\n" +
      "      durableQueue.countUnresolved(),\n" +
      "    ]);",
    'lightweight queue-state health read',
  );
  write(rel, source);
}

// Preload comment cleanup only; API surface remains typed and minimal.
{
  const rel = 'dev/preload.js';
  let source = read(rel);
  source = replaceAllLiteral(
    source,
    '  // Automation control  // Automation control  // Automation control',
    '  // Automation control',
  );
  write(rel, source);
}

for (const rel of touched) {
  execFileSync(process.execPath, ['--check', path.join(ROOT, rel)], { stdio: 'inherit' });
}

console.log(`Post-implementation cleanup completed for ${touched.size} source files.`);
