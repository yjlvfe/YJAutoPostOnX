/**
 * api-key-leak.test.js — C3: verify no API keys appear in logged URLs.
 * Tests the redactUrl() function logic extracted from main.js.
 */
const assert = require('assert');
const path = require('path');

// Reproduce the redactUrl function from main.js
function redactUrl(url) {
  try {
    const u = new URL(url);
    const sensitive = ['key', 'token', 'api_key', 'apikey', 'secret'];
    for (const p of sensitive) {
      if (u.searchParams.has(p)) u.searchParams.set(p, '[REDACTED]');
    }
    return u.toString();
  } catch (_) {
    return url;
  }
}

// Test cases
const tests = [
  {
    input: 'https://api.example.com/v1?key=sk-1234567890abcdef',
    expected: 'https://api.example.com/v1?key=%5BREDACTED%5D',
    desc: 'redacts ?key= param'
  },
  {
    input: 'https://api.example.com/v1?token=Bearer_abc123', 
    expected: 'https://api.example.com/v1?token=%5BREDACTED%5D',
    desc: 'redacts ?token= param'
  },
  {
    input: 'https://api.example.com/v1?api_key=super_secret',
    expected: 'https://api.example.com/v1?api_key=%5BREDACTED%5D',
    desc: 'redacts ?api_key= param'
  },
  {
    input: 'https://api.example.com/v1?apikey=mykey',
    expected: 'https://api.example.com/v1?apikey=%5BREDACTED%5D', 
    desc: 'redacts ?apikey= param'
  },
  {
    input: 'https://api.example.com/v1?secret=shhh',
    expected: 'https://api.example.com/v1?secret=%5BREDACTED%5D',
    desc: 'redacts ?secret= param'
  },
  {
    input: 'https://api.example.com/v1?key=abc&token=def',
    expected: 'https://api.example.com/v1?key=%5BREDACTED%5D&token=%5BREDACTED%5D',
    desc: 'redacts multiple sensitive params'
  },
  {
    input: 'https://api.example.com/v1?normal=ok&key=hide',
    expected: 'https://api.example.com/v1?normal=ok&key=%5BREDACTED%5D',
    desc: 'preserves normal params, redacts sensitive'
  },
  {
    input: 'https://api.example.com/v1',
    expected: 'https://api.example.com/v1',
    desc: 'unchanged when no sensitive params'
  }
];

let pass = 0, fail = 0;
for (const t of tests) {
  const result = redactUrl(t.input);
  if (result === t.expected) {
    pass++;
    console.log(`✅ ${t.desc}`);
  } else {
    fail++;
    console.log(`❌ FAIL: ${t.desc}`);
    console.log(`   Input:    ${t.input}`);
    console.log(`   Expected: ${t.expected}`);
    console.log(`   Got:      ${result}`);
  }
}

if (fail > 0) {
  console.error(`\n❌ api-key-leak.test.js: ${fail}/${tests.length} failed`);
  process.exit(1);
}
console.log(`\n✅ api-key-leak.test.js: ALL ${pass}/${tests.length} passed`);
