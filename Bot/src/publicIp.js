'use strict';
const { isIP } = require('node:net');
function isPublicIp(value) {
  if (typeof value !== 'string') return false;
  const version = isIP(value);
  if (version === 4) {
    const [a, b, c] = value.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19)) || value.startsWith('198.51.100.') || value.startsWith('203.0.113.'));
  }
  // Only global unicast; excludes local, multicast, mapped and documentation addresses.
  if (version !== 6 || value.includes('%')) return false;
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const [first, second = '0'] = canonical.split(':').map(part => parseInt(part || '0', 16));
  return first >= 0x2000 && first <= 0x3fff &&
    !(first === 0x2001 && (second < 0x200 || second === 0xdb8)) &&
    first !== 0x2002 && !(first === 0x3fff && second < 0x1000);
}
module.exports = { isPublicIp };
