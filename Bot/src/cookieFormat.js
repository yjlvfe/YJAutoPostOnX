'use strict';

function parseCookies(content) {
  const trimmed = String(content ?? '').trim();
  if (!trimmed) throw new Error('Cookie file is empty');
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    let parsed;
    try { parsed = JSON.parse(trimmed); } catch { throw new Error('Invalid JSON cookie file'); }
    const list = Array.isArray(parsed) ? parsed : parsed?.cookies;
    if (!Array.isArray(list)) throw new Error('JSON cookie file must contain an array');
    const cookies = list.map(normalizeJsonCookie);
    if (cookies.some(cookie => !cookie)) throw new Error('JSON cookie entry is invalid');
    return { cookies, format: 'json' };
  }

  const lines = trimmed.split(/\r?\n/).map(line => line.trimStart()).filter(line => line && (!line.startsWith('#') || line.startsWith('#HttpOnly_')));
  if (!lines.length) throw new Error('Netscape cookie file contains no rows');
  const cookies = lines.map(parseNetscapeCookie);
  if (cookies.some(cookie => !cookie)) throw new Error('Netscape cookie row is invalid');
  return { cookies, format: 'netscape' };
}

function parseNetscapeCookie(line) {
  const fields = String(line).split('\t');
  if (fields.length < 7) throw new Error('Invalid Netscape cookie row');
  let [domain, includeSubdomains, cookiePath, secure, expires, name, ...valueParts] = fields;
  const httpOnly = domain.startsWith('#HttpOnly_');
  if (httpOnly) domain = domain.slice('#HttpOnly_'.length);
  const value = valueParts.join('\t');
  if (!domain || !name) throw new Error('Netscape cookie requires domain and name');
  const cookie = { name, value, httpOnly, domain, path: cookiePath || '/', secure: String(secure).toUpperCase() === 'TRUE' };
  const expiry = Number(expires);
  if (Number.isFinite(expiry) && expiry > 0) cookie.expires = expiry;
  if (String(includeSubdomains).toUpperCase() === 'TRUE' && !cookie.domain.startsWith('.')) cookie.domain = `.${cookie.domain}`;
  return cookie;
}

function normalizeJsonCookie(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string' || typeof raw.value !== 'string') {
    throw new Error('JSON cookie requires string name and value');
  }
  const cookie = { name: raw.name, value: raw.value, path: raw.path || '/', secure: raw.secure === true };
  if (raw.domain) cookie.domain = String(raw.domain);
  else if (raw.url) cookie.url = String(raw.url);
  else throw new Error('JSON cookie requires domain or url');
  if (raw.httpOnly === true) cookie.httpOnly = true;
  if (raw.sameSite && ['Strict', 'Lax', 'None'].includes(raw.sameSite)) cookie.sameSite = raw.sameSite;
  const expiry = Number(raw.expires ?? raw.expirationDate);
  if (Number.isFinite(expiry) && expiry > 0) cookie.expires = expiry;
  return cookie;
}

function detectFormat(content) {
  try { return parseCookies(content).format; } catch { return null; }
}

module.exports = { parseCookies, parseNetscapeCookie, normalizeJsonCookie, detectFormat };
