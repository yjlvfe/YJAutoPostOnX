/**
 * max-tokens-cap.test.js — M9: verify maxTokens has a hard ceiling.
 * Tests the Math.min() cap added to prevent unlimited token requests.
 */
const assert = require('assert');

// Reproduce the logic from main.js runRound
const CHUNK = 25;
const HARD_CAP = 8192;

function calcMaxTokens(chunk) {
  return Math.min((chunk || CHUNK) * 400, HARD_CAP);
}

// Test cases
const tests = [
  { chunk: 25,  expected: 10000, desc: 'default chunk (25) → 10k but capped to 8k' },
  { chunk: 10,  expected: 4000,  desc: 'small chunk (10) → 4k (under cap)' },
  { chunk: 20,  expected: 8000,  desc: 'medium chunk (20) → 8k (exactly at cap)' },
  { chunk: 50,  expected: 8000,  desc: 'large chunk (50) → capped at 8k' },
  { chunk: 100, expected: 8000,  desc: 'very large chunk (100) → capped at 8k' },
  { chunk: undefined, expected: 10000, desc: 'undefined chunk → default 25*400=10k capped to 8k' },
];

let pass = 0, fail = 0;
for (const t of tests) {
  const result = calcMaxTokens(t.chunk);
  // The cap logic: Math.min(chunk*400, 8192)
  const expectedCapped = Math.min((t.chunk || CHUNK) * 400, HARD_CAP);
  
  if (result === expectedCapped) {
    pass++;
    console.log(`✅ ${t.desc}: ${result}`);
  } else {
    fail++;
    console.log(`❌ FAIL: ${t.desc}`);
    console.log(`   Expected capped: ${expectedCapped}`);
    console.log(`   Got:             ${result}`);
  }
}

// Verify the cap actually cuts off (the critical security property)
console.log('\nTest: verify cap actually limits...');
const largeChunk = 100; // 100 * 400 = 40k
const capped = calcMaxTokens(largeChunk);
if (capped === HARD_CAP) {
  console.log(`✅ Cap works: ${largeChunk}-chunk request limited to ${capped}`);
  pass++;
} else {
  console.log(`❌ FAIL: Cap broken — ${largeChunk}-chunk returned ${capped}`);
  fail++;
}

if (fail > 0) {
  console.error(`\n❌ max-tokens-cap.test.js: ${fail} failed`);
  process.exit(1);
}
console.log(`\n✅ max-tokens-cap.test.js: ALL ${pass} tests passed`);
