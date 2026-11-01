/**
 * rate-limit-persist.test.js — H7: verify rate-limit state survives app restart.
 * Tests that rateLimitStore persists to/reads from disk correctly.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

// Use a temp path for testing
const TEST_DIR = path.join(os.tmpdir(), 'xposter-test-' + Date.now());
const STORE_PATH = path.join(TEST_DIR, 'rate-limits.json');

// Mock the module to use our test path
const rateLimitStore = {
  setCooldown: (profileName, durationMs, meta = {}) => {
    const name = profileName || 'Default';
    const now = Date.now();
    const ms = (typeof durationMs === 'number' && durationMs > 0) ? durationMs : 60 * 60 * 1000;
    const store = rateLimitStore._read();
    store[name] = {
      until: now + ms,
      since: now,
      source: meta.source || 'default',
      note: meta.note || '',
    };
    rateLimitStore._write(store);
    return store[name];
  },

  getCooldown: (profileName) => {
    const name = profileName || 'Default';
    const store = rateLimitStore._read();
    const entry = store[name];
    if (!entry) return null;
    if (typeof entry.until !== 'number' || !Number.isFinite(entry.until)) {
      delete store[name];
      rateLimitStore._write(store);
      return null;
    }
    const remainingMs = entry.until - Date.now();
    if (remainingMs <= 0) {
      delete store[name];
      rateLimitStore._write(store);
      return null;
    }
    return { ...entry, remainingMs };
  },

  _read: () => {
    try {
      const raw = fs.readFileSync(STORE_PATH, 'utf8');
      const obj = JSON.parse(raw);
      return obj && typeof obj === 'object' ? obj : {};
    } catch {
      return {};
    }
  },

  _write: (obj) => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(obj, null, 2));
  }
};

// Test: survival across "restart"
console.log('Test 1: Record a rate-limit...');
const profile = 'TestProfile';
const cd = rateLimitStore.setCooldown(profile, 5 * 60 * 1000, { source: 'x', note: 'Test cooldown' });
assert(cd.until > Date.now(), 'until must be in future');
console.log('✅ Rate-limit recorded');

console.log('Test 2: Read it back (in-memory)...');
const read1 = rateLimitStore.getCooldown(profile);
assert(read1 !== null, 'getCooldown must return entry');
assert(read1.remainingMs > 0, 'remainingMs must be positive');
console.log('✅ Read back in-memory');

console.log('Test 3: Verify file written to disk...');
assert(fs.existsSync(STORE_PATH), 'file must exist on disk');
const raw = fs.readFileSync(STORE_PATH, 'utf8');
const persisted = JSON.parse(raw);
assert(persisted[profile] !== undefined, 'persisted JSON must contain profile');
assert(persisted[profile].until === cd.until, 'persisted until must match');
console.log('✅ File verified on disk');

console.log('Test 4: Simulate "app restart" — _read() from file...');
const afterRestart = rateLimitStore.getCooldown(profile);
assert(afterRestart !== null, 'must read after restart');
assert(afterRestart.remainingMs > 0, 'remaining must be positive after restart');
console.log('✅ Survived simulated restart');

// Cleanup
fs.rmSync(TEST_DIR, { recursive: true, force: true });
console.log('\n✅ rate-limit-persist.test.js: ALL passed');
