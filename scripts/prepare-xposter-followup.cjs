'use strict';

const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'apply-xposter-followup.cjs');
let source = fs.readFileSync(file, 'utf8');

function escapeGeneratedTemplate(marker) {
  const markerAt = source.indexOf(marker);
  if (markerAt === -1) throw new Error(`Missing generated-template marker: ${marker}`);
  const open = source.indexOf('`', markerAt + marker.length);
  const close = source.indexOf('\n`);', open + 1);
  if (open === -1 || close === -1) throw new Error(`Malformed generated-template block: ${marker}`);
  const body = source.slice(open + 1, close).replace(/(?<!\\)`/g, '\\`');
  source = source.slice(0, open + 1) + body + source.slice(close);
}

function removeReplacementByLabel(label) {
  const labelNeedle = `  '${label}',\n);`;
  const labelAt = source.indexOf(labelNeedle);
  if (labelAt === -1) throw new Error(`Missing replacement label: ${label}`);
  const start = source.lastIndexOf('smoke = replaceOnce(', labelAt);
  if (start === -1) throw new Error(`Missing replacement start: ${label}`);
  const end = labelAt + labelNeedle.length;
  source = source.slice(0, start) + source.slice(end).replace(/^\n?/, '\n');
}

function replaceRawBetween(startNeedle, endNeedle, replacement, label) {
  const start = source.indexOf(startNeedle);
  if (start === -1) throw new Error(`Missing raw start: ${label}`);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  if (end === -1) throw new Error(`Missing raw end: ${label}`);
  source = source.slice(0, start) + replacement + source.slice(end);
}

// Two test files are emitted as template literals and contain their own runtime
// template strings. Escape those inner backticks before Node parses the applier.
escapeGeneratedTemplate("write('test/durable-recovery-contract.test.js', ");
escapeGeneratedTemplate("write('test/workflow-report-retention.test.js', ");

// The baseline smoke block changed after the previous repair. The real renderer
// calls getQueueState during boot, while REQUIRED_API pins its exposure.
removeReplacementByLabel('smoke typed queue state');

// Preserve compatibility for an old unique-text caller, but never guess between
// duplicates. New renderer calls remain strict ID + expectedRevision requests.
replaceRawBetween(
  "function recoveryMatch(store, states, identity) {\n  const request = mutationRequest(identity, 'recovery');",
  "\n}\n\nfunction requirePublishedProof(proof) {",
  "function recoveryMatch(store, states, identity) {\n" +
  "  let request = mutationRequest(identity, 'recovery');\n" +
  "  if (typeof identity === 'string') {\n" +
  "    const direct = store.getItem(identity);\n" +
  "    if (direct && states.includes(direct.state)) {\n" +
  "      request = { id: direct.id, expectedRevision: direct.revision, requestId: 'recovery-id:' + direct.id + ':' + direct.revision };\n" +
  "    } else {\n" +
  "      const matches = readAllItems(store, states).filter((item) => textOf(item) === identity);\n" +
  "      if (matches.length > 1) {\n" +
  "        const error = new Error('Recovery text matches more than one durable item; refresh and use its ID.');\n" +
  "        error.code = 'AMBIGUOUS_TEXT_ADDRESS';\n" +
  "        error.ids = matches.map((item) => item.id);\n" +
  "        throw error;\n" +
  "      }\n" +
  "      if (matches.length === 0) return null;\n" +
  "      const item = matches[0];\n" +
  "      request = { id: item.id, expectedRevision: item.revision, requestId: 'recovery-text-compat:' + item.id + ':' + item.revision };\n" +
  "    }\n" +
  "  }\n" +
  "  if (!request) return null;\n" +
  "  if (typeof identity !== 'string' && request.expectedRevision === null) {\n" +
  "    const error = new Error('expectedRevision is required for recovery mutations.');\n" +
  "    error.code = 'REVISION_REQUIRED';\n" +
  "    throw error;\n" +
  "  }\n" +
  "  const item = store.getItem(request.id);\n" +
  "  if (!item || !states.includes(item.state)) return null;\n" +
  "  if (request.expectedRevision !== null && request.expectedRevision !== item.revision) {\n" +
  "    const error = new Error('The recovery item revision no longer matches. Refresh before acting.');\n" +
  "    error.code = 'REVISION_CONFLICT';\n" +
  "    error.expectedRevision = request.expectedRevision;\n" +
  "    error.actualRevision = item.revision;\n" +
  "    throw error;\n" +
  "  }\n" +
  "  return { request, item };",
  'safe legacy recovery compatibility',
);

// One canonical extractor supports both a durable DB row ({payload:{text}})
// and an IPC/display row ({text}) without weakening durable identity.
const dqWriteMarker = "write('dev/automation/durableQueue.js', dq);";
const dqWriteAt = source.indexOf(dqWriteMarker);
if (dqWriteAt === -1) throw new Error('Missing durableQueue write marker');
const textExtractorPatch =
  "dq = replaceOnce(\n" +
  "  dq,\n" +
  "  \"function textOf(item) {\\n  return item && item.payload && typeof item.payload.text === 'string' ? item.payload.text : '';\\n}\",\n" +
  "  \"function textOf(item) {\\n  if (item && item.payload && typeof item.payload.text === 'string') return item.payload.text;\\n  if (item && typeof item.text === 'string') return item.text;\\n  return '';\\n}\",\n" +
  "  'durableQueue display text compatibility',\n" +
  ");\n";
source = source.slice(0, dqWriteAt) + textExtractorPatch + source.slice(dqWriteAt);

// Both repair passes replace a block whose end marker is the declaration itself.
// replaceBetween deliberately preserves the marker, so a replacement that also
// emits it can leave two or three declarations concatenated. Collapse them before
// writing main.js; this is a generated-source invariant, not a runtime workaround.
const mainWriteMarker = "write('dev/main.js', main);";
const mainWriteAt = source.indexOf(mainWriteMarker);
if (mainWriteAt === -1) throw new Error('Missing main.js write marker');
const automationDeclarationCleanup =
  "main = main.replace(/(?:let automationRunning = false;\\s*){2,}/g, 'let automationRunning = false;\\n');\n";
source = source.slice(0, mainWriteAt) + automationDeclarationCleanup + source.slice(mainWriteAt);

// Stable queue IDs intentionally changed getQueue's row shape. Update the old
// behavioural test to compare text through the canonical extractor, not shape.
const finalLog = "console.log('xposter follow-up repair applied successfully.');";
const finalAt = source.lastIndexOf(finalLog);
if (finalAt === -1) throw new Error('Missing follow-up final log anchor');
const testCompatibilityPatch =
  "let deferredRetryTest = read('test/deferred-retry-v512.test.js');\n" +
  "deferredRetryTest = deferredRetryTest.replaceAll(\"(await durableQueue.getQueue()).includes(\", \"(await durableQueue.getQueue()).map(durableQueue.textOf).includes(\");\n" +
  "write('test/deferred-retry-v512.test.js', deferredRetryTest);\n\n";
source = source.slice(0, finalAt) + testCompatibilityPatch + source.slice(finalAt);

// Generated-file interpolations must survive until generated code runs; only
// the helper's own ${label} diagnostics belong to this process.
source = source.replace(/(?<!\\)\$\{(?!label\})/g, '\\${');
fs.writeFileSync(file, source, 'utf8');
console.log('Prepared nested xposter follow-up templates.');
