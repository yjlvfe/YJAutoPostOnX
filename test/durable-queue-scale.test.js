'use strict';

// The durableQueue adapter is what the whole app sees of the store. Every read
// it exposes is a single un-paginated call, and WorkflowStore.listQueued hard-
// clamps `limit` to 1000 — so past a thousand queued posts the adapter silently
// stops seeing the rest of the queue.
//
// That truncation is not cosmetic. The same read feeds:
//   * the queue the UI renders and counts,
//   * the duplicate check inside addPosts,
//   * the semantic-dedup corpus main.js builds before AI generation.
// A duplicate that lives past position 1000 is therefore invisible to all three,
// and the app happily queues and publishes the same tweet twice.
//
// getPublishedTexts in the same file already paginates with a cursor, which is
// the shape every one of these reads needs.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkflowStore } = require('../dev/automation/workflowStore');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xposter-queue-scale-'));

function freshStore(name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return new WorkflowStore({ rootDir: dir });
}

/** Enqueue `count` distinct posts in batches the store will accept. */
function seedQueue(store, count, prefix = 'post') {
  const BATCH = 200;
  for (let start = 0; start < count; start += BATCH) {
    const items = [];
    for (let i = start; i < Math.min(start + BATCH, count); i++) {
      items.push({ text: `${prefix} ${i}` });
    }
    store.enqueue({ items, requestId: `seed:${prefix}:${start}` });
  }
}

/** Reads every queued item by paging on queue_seq — the contract the adapter
 *  must satisfy, expressed independently of the adapter itself. */
function readAllQueued(store) {
  const all = [];
  let after = null;
  for (;;) {
    const page = store.listQueued({ limit: 1000, after });
    if (page.length === 0) break;
    all.push(...page);
    after = { queueSeq: page[page.length - 1].queueSeq };
  }
  return all;
}

function listQueuedIsHardCappedAtOneThousand() {
  const store = freshStore('cap');
  try {
    seedQueue(store, 1500);

    // A single call cannot see past 1000 no matter what limit is asked for.
    assert.strictEqual(store.listQueued({ limit: 5000 }).length, 1000,
      'listQueued must clamp to 1000 — this is the cap the adapter has to page around');

    // Paging on queue_seq does reach every item.
    assert.strictEqual(readAllQueued(store).length, 1500,
      'paging with `after` must reach the whole queue');

    console.log('  ✓ listQueued clamps at 1000; cursor paging reaches all 1500');
  } finally {
    store.close();
  }
}

function adapterSeesTheWholeQueue() {
  const store = freshStore('adapter-queue');
  try {
    seedQueue(store, 1500);

    const { readAllQueuedItems } = require('../dev/automation/durableQueue');
    assert.strictEqual(typeof readAllQueuedItems, 'function',
      'durableQueue must expose a paginating queue read');

    const items = readAllQueuedItems(store);
    assert.strictEqual(items.length, 1500,
      `adapter read must return every queued item, got ${items.length}`);

    const texts = new Set(items.map((i) => i.payload.text));
    assert.ok(texts.has('post 0'), 'first item must be present');
    assert.ok(texts.has('post 1499'), 'last item must be present — this is what truncation loses');

    console.log('  ✓ adapter read returns all 1500 queued items');
  } finally {
    store.close();
  }
}

function duplicatesPastOneThousandAreRejected() {
  const store = freshStore('dedupe');
  try {
    seedQueue(store, 1200);

    const { collectQueuedTexts } = require('../dev/automation/durableQueue');
    assert.strictEqual(typeof collectQueuedTexts, 'function',
      'durableQueue must expose the full queued-text set used for de-duplication');

    const known = collectQueuedTexts(store);
    assert.strictEqual(known.size, 1200, `dedup set must cover the whole queue, got ${known.size}`);

    // "post 1150" sits well past the 1000-row window. Before paging, addPosts
    // would not find it and would queue a second copy of a tweet already
    // waiting to go out.
    assert.ok(known.has('post 1150'),
      'a duplicate beyond position 1000 must still be detected');

    console.log('  ✓ dedup set covers all 1200 texts, including those past 1000');
  } finally {
    store.close();
  }
}

function deleteReachesItemsPastOneThousand() {
  const store = freshStore('delete');
  try {
    seedQueue(store, 1300);

    const { readAllItems } = require('../dev/automation/durableQueue');
    assert.strictEqual(typeof readAllItems, 'function',
      'durableQueue must expose a paginating item read for delete/recovery paths');

    const deletable = readAllItems(store, ['queued', 'deferred', 'leased', 'dispatch_started']);
    assert.strictEqual(deletable.length, 1300,
      `delete scan must see every candidate, got ${deletable.length}`);

    // A delete request for a post past the window used to report deleted:0 with
    // an empty `blocked` list — indistinguishable from "there was nothing there".
    const target = deletable.find((i) => i.payload.text === 'post 1250');
    assert.ok(target, 'item past position 1000 must be reachable by the delete scan');

    console.log('  ✓ delete scan reaches all 1300 items');
  } finally {
    store.close();
  }
}

const tests = [
  ['listQueued cap', listQueuedIsHardCappedAtOneThousand],
  ['adapter sees whole queue', adapterSeesTheWholeQueue],
  ['dedup past 1000', duplicatesPastOneThousandAreRejected],
  ['delete past 1000', deleteReachesItemsPastOneThousand],
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}: ${error.message}`);
  }
}

try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }

if (failed > 0) {
  console.error(`\n✗ durable queue scale: ${failed} failing`);
  process.exit(1);
}
console.log('✅ durable queue scale: adapter reads cover the whole queue');
