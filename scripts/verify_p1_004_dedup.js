#!/usr/bin/env node
'use strict';
/**
 * Standalone Verification Script for Requirement P1-004:
 * Proves:
 * 1. SHA-256 content deduplication in Queue.enqueue() and Queue.replacePending()
 * 2. Strict concurrency fencing preventing double-claims on the same pending item
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '../Bot');
const { Queue } = require(path.join(ROOT, 'src/queue'));
const { SqliteStore } = require(path.join(ROOT, 'src/sqliteStore'));
const { accountCapacity } = require(path.join(ROOT, 'src/quota'));

// Helper to extract claimCycleItem from runner.js for genuine isolated concurrency test
function extractClaimFn() {
  const source = fs.readFileSync(path.join(ROOT, 'src/runner.js'), 'utf8');
  const start = source.indexOf('async function claimCycleItem(');
  const end = source.indexOf('\nasync function stopCycleForQuota(', start);
  if (start < 0 || end < 0) throw new Error('Could not extract claimCycleItem from runner.js');
  const scope = { crypto, accountCapacity };
  vm.createContext(scope);
  vm.runInContext(source.slice(start, end) + '\nthis.claim = claimCycleItem;', scope);
  return scope.claim;
}

async function runVerification() {
  console.log('=== P1-004 VERIFICATION: CONTENT DEDUPLICATION & CONCURRENT CLAIMS ===\n');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-004-test-'));
  const dbPath = path.join(tempDir, 'state.sqlite');

  const initialStore = {
    items: [],
    accounts: [
      { id: 'acct-1', username: 'tester', userId: '12345', enabled: true, dailyLimit: 10 }
    ],
    cycle: { state: 'stopped', runId: null },
    settings: { dailyQuota: 10 },
    posting: {}
  };

  const store = new SqliteStore(dbPath, initialStore);
  await store.load();
  const queue = new Queue(store);

  // --- PART 1: SHA-256 Content Deduplication in Queue.enqueue ---
  console.log('--- Step 1: Queue.enqueue SHA-256 Deduplication ---');
  const payloads = [
    { text: 'First post: updates from team', category: 'news' },
    { category: 'news', text: 'First post: updates from team' }, // Duplicate (keys reordered)
    { text: 'Second post: special announcement', urgency: 'high' },
    { urgency: 'high', text: 'Second post: special announcement' }, // Duplicate (keys reordered)
    { text: 'Third post: distinct content', category: 'blog' }
  ];

  const pendingAfterEnqueue = await queue.enqueue(payloads);
  console.log(`Submitted: ${payloads.length} payloads`);
  console.log(`Admitted distinct pending items: ${pendingAfterEnqueue.length}`);
  assert.strictEqual(pendingAfterEnqueue.length, 3, 'Queue.enqueue must admit exactly 3 distinct items');

  const state1 = await store.load();
  assert.strictEqual(state1.items.length, 3, 'Database must hold exactly 3 items after deduplication');
  console.log('✓ Enqueue deduplication passed: 2 duplicate payloads rejected by SHA-256 hash.\n');

  // --- PART 2: Queue.replacePending Deduplication ---
  console.log('--- Step 2: Queue.replacePending SHA-256 Deduplication ---');
  const replaceBatch = [
    { text: 'Batch item A', priority: 1 },
    { text: 'Batch item B', priority: 2 },
    { text: 'Batch item A', priority: 1 }, // Duplicate of A
    { text: 'Batch item C', priority: 3 }
  ];

  const addedCount = await queue.replacePending(replaceBatch);
  console.log(`Submitted to replacePending: ${replaceBatch.length} payloads`);
  console.log(`Reported added: ${addedCount}`);
  assert.strictEqual(addedCount, 3, 'replacePending must report exactly 3 items added');

  const state2 = await store.load();
  const activePending = state2.items.filter(x => x.state === 'pending');
  console.log(`Active pending in database: ${activePending.length}`);
  assert.strictEqual(activePending.length, 3, 'Database must hold exactly 3 active pending items');
  console.log('✓ replacePending deduplication passed.\n');

  // --- PART 3: Concurrent Claim Prevention ---
  console.log('--- Step 3: Concurrent Claim Prevention (Atomic Transaction Fencing) ---');
  // Reset store to a single pending item and running cycle
  await store.update(s => {
    s.items = [
      { id: 'shared-item-1', state: 'pending', payload: { text: 'Claim contention test payload' } }
    ];
    s.cycle = { state: 'running', runId: 'run-alpha' };
    return s;
  });

  const claimCycleItem = extractClaimFn();

  // Launch 5 simultaneous asynchronous claim attempts on the single pending item
  console.log('Launching 5 concurrent claim attempts on 1 pending item...');
  const workers = Array.from({ length: 5 }, (_, idx) => {
    return claimCycleItem({
      store,
      itemId: 'shared-item-1',
      accountId: 'acct-1',
      runId: 'run-alpha'
    }).then(res => ({ workerId: idx + 1, ...res }));
  });

  const claimResults = await Promise.all(workers);
  console.log('Claim outcomes:');
  claimResults.forEach(r => {
    console.log(`  Worker ${r.workerId}: claimed=${r.claimed}, reason=${r.reason || 'N/A'}, token=${r.token || 'none'}`);
  });

  const winners = claimResults.filter(r => r.claimed === true);
  const losers = claimResults.filter(r => r.claimed === false);

  assert.strictEqual(winners.length, 1, 'Exactly one concurrent worker must acquire the claim');
  assert.strictEqual(losers.length, 4, 'Remaining 4 concurrent workers must be denied');
  assert.ok(winners[0].token, 'Winning claim must have a valid attempt token');

  // Verify database integrity
  const finalState = await store.load();
  const dbItem = finalState.items.find(x => x.id === 'shared-item-1');
  assert.strictEqual(dbItem.state, 'processing', 'Item in SQLite must be in processing state');
  assert.strictEqual(dbItem.attempt.token, winners[0].token, 'Item token in SQLite must match winning token');
  assert.strictEqual(dbItem.attempt.phase, 'claimed', 'Item attempt phase must be claimed');
  assert.strictEqual(finalState.posting?.publishingAt, dbItem.claimedAt, 'publishingAt must match claim timestamp');

  await store.close();
  fs.rmSync(tempDir, { recursive: true, force: true });

  console.log('\n✓ Concurrent claim fencing passed: No double claims occurred.');
  console.log('\n================================================================');
  console.log('ALL P1-004 CHECKS PASSED: Local deduplication and claim safety verified!');
  console.log('================================================================');
}

runVerification().catch(err => {
  console.error('VERIFICATION FAILED:', err);
  process.exit(1);
});
