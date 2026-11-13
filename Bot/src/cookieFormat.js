'use strict';

function parseExpiry(value) {
  if (value == null || value === '') return undefined;
  const expiry = Number(value);
  if (!Number.isFinite(expiry)) throw new Error('Cookie expiry is invalid');
  return expiry === 0 || expiry === -1 ? undefined : expiry;
}

function validateAuthCookieScope(cookies) {
  const host = cookie => String(cookie.domain || new URL(cookie.url).hostname).replace(/^\.+/, '').toLowerCase();
  for (const name of ['auth_token', 'ct0']) {
    const matching = cookies.filter(cookie => cookie.name === name);
    const hasApex = matching.some(cookie => ['x.com', 'twitter.com'].includes(host(cookie)) && cookie.value &&
      (cookie.expires === undefined || cookie.expires > Date.now() / 1000));
    if (!hasApex && matching.some(cookie => /\.(?:x|twitter)\.com$/.test(host(cookie)))) {
      throw new Error('Authentication cookie scope is unsupported');
    }
  }
}

function parseCookies(content) {
  const trimmed = String(content ?? '').trim();
  if (!trimmed) throw new Error('Cookie file is empty');
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    let parsed;
    try { parsed = JSON.parse(trimmed); } catch { throw new Error('Invalid JSON cookie file'); }
    const list = Array.isArray(parsed) ? parsed : (Object.hasOwn(parsed, 'cookies') ? parsed.cookies : parsed);
    // The bridge also accepts simple name/value dictionaries with an implicit
    // x.com domain; recognize that same representation during import.
    const entries = Array.isArray(list) ? list : (list && typeof list === 'object'
      ? Object.entries(list).map(([name, value]) => ({ name, value, domain: '.x.com' })) : null);
    if (!entries) throw new Error('JSON cookie file must contain an array or dictionary');
    const cookies = entries.map(normalizeJsonCookie);
    if (cookies.some(cookie => !cookie)) throw new Error('JSON cookie entry is invalid');
    validateAuthCookieScope(cookies);
    return { cookies, format: 'json' };
  }

  const lines = trimmed.split(/\r?\n/).map(line => line.trimStart()).filter(line => line && (!line.startsWith('#') || line.startsWith('#HttpOnly_')));
  if (!lines.length) throw new Error('Netscape cookie file contains no rows');
  const cookies = lines.map(parseNetscapeCookie);
  if (cookies.some(cookie => !cookie)) throw new Error('Netscape cookie row is invalid');
  validateAuthCookieScope(cookies);
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
  const expiry = parseExpiry(expires);
  if (expiry !== undefined) cookie.expires = expiry;
  if (String(includeSubdomains).toUpperCase() === 'TRUE' && !cookie.domain.startsWith('.')) cookie.domain = `.${cookie.domain}`;
  return cookie;
}

function normalizeJsonCookie(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string' || typeof raw.value !== 'string') {
    throw new Error('JSON cookie requires string name and value');
  }
  const cookie = { name: raw.name, value: raw.value, path: raw.path || '/', secure: raw.secure === true };
  if (Object.hasOwn(raw, 'url')) {
    let url;
    try { url = new URL(raw.url); } catch { throw new Error('Cookie URL is invalid'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) throw new Error('Cookie URL is invalid');
    if (raw.domain) {
      const domain = String(raw.domain).replace(/^\.+/, '').toLowerCase();
      const host = url.hostname.toLowerCase();
      if (host !== domain && !host.endsWith(`.${domain}`)) throw new Error('Cookie domain and URL do not match');
    }
  }
  if (raw.domain) cookie.domain = String(raw.domain);
  else if (raw.url) cookie.url = String(raw.url);
  else throw new Error('JSON cookie requires domain or url');
  if (raw.httpOnly === true) cookie.httpOnly = true;
  if (raw.sameSite && ['Strict', 'Lax', 'None'].includes(raw.sameSite)) cookie.sameSite = raw.sameSite;
  const expiry = parseExpiry(raw.expirationDate ?? raw.expires);
  if (expiry !== undefined) cookie.expires = expiry;
  return cookie;
}

function detectFormat(content) {
  try { return parseCookies(content).format; } catch { return null; }
}

module.exports = { parseCookies, parseNetscapeCookie, normalizeJsonCookie, detectFormat };
