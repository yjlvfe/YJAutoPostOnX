'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { parseCsv } = require('./csv');
const { parseCookies, detectFormat } = require('./cookieFormat');

const MAX_ACCOUNTS = 5;
const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const MAX_COOKIE_BYTES = 10 * 1024 * 1024;

function normalizeAccountId(value) {
  const id = String(value ?? '').trim();
  if (!ACCOUNT_ID.test(id)) throw new Error('Account id must be 1-64 letters, numbers, dot, dash, or underscore');
  return id;
}

function accountRecord(input = {}) {
  const id = normalizeAccountId(input.id ?? input.account ?? input.name);
  if (input.userId != null && (typeof input.userId !== 'string' || !/^\d+$/.test(input.userId))) throw new Error('userId must be a numeric string');
  const record = {
    id,
    label: String(input.label ?? id).trim().slice(0, 100) || id,
    username: input.username || input.handle ? String(input.username ?? input.handle).replace(/^@/, '').trim().slice(0, 30) || null : null,
    ...(input.userId != null ? { userId: input.userId } : {}),
    enabled: input.enabled !== false,
    cookieFile: input.cookieFile ? String(input.cookieFile) : null,
    ...(input.verifiedAt ? { verifiedAt: String(input.verifiedAt) } : {}),
    ...(input.vpnResource ? { vpnResource: String(input.vpnResource) } : {}),
    quota: input.quota == null || input.quota === '' ? null : positiveInteger(input.quota, 'quota'),
    delayMs: input.delayMs == null || input.delayMs === '' ? null : nonNegativeInteger(input.delayMs, 'delayMs')
  };
  return record;
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${name} must be a positive integer`);
  return number;
}
function nonNegativeInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${name} must be a non-negative integer`);
  return number;
}

class AccountManager {
  constructor(store, { maxAccounts = MAX_ACCOUNTS, beforeMutation, onChange } = {}) {
    if (!store) throw new TypeError('AccountManager requires a store');
    this.store = store;
    this.maxAccounts = maxAccounts;
    this.beforeMutation = typeof beforeMutation === 'function' ? beforeMutation : null;
    this.onChange = typeof onChange === 'function' ? onChange : null;
    this.pending = Promise.resolve();
  }

  _mutate(operation, mutator) {
    const work = this.pending.then(async () => {
      const context = { operation, before: await this.list() };
      // Hooks must not hold the SQLite transaction while draining publishers.
      if (this.beforeMutation) await this.beforeMutation(structuredClone(context));
      const state = await this.store.update(draft => {
        context.before = structuredClone(draft.accounts || []);
        return mutator(draft);
      });
      if (this.onChange) await this.onChange(structuredClone(state.accounts || []), structuredClone(context));
      return state;
    });
    // Resource observers complete before another account mutation can begin.
    this.pending = work.catch(() => {});
    return work;
  }

  async list() {
    const state = await this.store.load();
    return structuredClone(state.accounts || []);
  }

  async add(input, { userKey, confirmationToken } = {}) {
    const record = accountRecord(input);
    return this._mutate('add', state => {
      const confirmation = userKey ? state.telegramUi?.users?.[userKey] : null;
      if (userKey && (!confirmation || confirmation.prompt !== 'cookieConfirm' || confirmation.flowToken !== confirmationToken || confirmation.draft?.id !== record.id)) throw new Error('STALE_CONFIRMATION');
      state.accounts ||= [];
      if (confirmation && state.accounts.some(a => a.username?.toLowerCase() === record.username?.toLowerCase())) throw new Error('Account already exists');
      if (state.accounts.some(item => item.id === record.id)) throw new Error('Account already exists');
      if (state.accounts.length >= this.maxAccounts) throw new Error(`At most ${this.maxAccounts} accounts are supported`);
      state.accounts.push(record);
      if (confirmation) Object.assign(confirmation, { draft: null, prompt: null, flowToken: null });
      return state;
    }).then(state => structuredClone(state.accounts.find(item => item.id === record.id)));
  }

  async update(id, patch) {
    const accountId = normalizeAccountId(id);
    return this._mutate('update', state => {
      const current = (state.accounts || []).find(item => item.id === accountId);
      if (!current) throw new Error('Account not found');
      const next = accountRecord({ ...current, ...patch, id: accountId });
      Object.assign(current, next);
      return state;
    }).then(state => structuredClone(state.accounts.find(item => item.id === accountId)));
  }

  async remove(id) {
    const accountId = normalizeAccountId(id);
    let removed = false;
    await this._mutate('remove', state => {
      const before = state.accounts || [];
      state.accounts = before.filter(item => {
        const keep = item.id !== accountId;
        if (!keep) removed = true;
        return keep;
      });
      if (!removed) throw new Error('Account not found');
      return state;
    });
    return removed;
  }

  /** Replace is atomic: malformed input never removes the current account set. */
  async replace(records) {
    if (!Array.isArray(records) || records.length > this.maxAccounts) {
      throw new Error(`At most ${this.maxAccounts} accounts are supported`);
    }
    const normalized = records.map(accountRecord);
    if (new Set(normalized.map(item => item.id)).size !== normalized.length) throw new Error('Duplicate account id');
    return this._mutate('replace', state => { state.accounts = normalized; return state; })
      .then(state => structuredClone(state.accounts));
  }

  async replaceFromCsv(input) {
    const rows = parseCsv(input, { required: ['account'], rejectFormulas: true });
    return this.replace(rows.map(row => ({
      ...row,
      id: row.account,
      label: row.label || row.account,
      cookieFile: row.cookie_file || row.cookieFile || null,
      quota: row.quota || null,
      delayMs: row.delay_ms || row.delayMs || null,
      enabled: row.enabled !== 'false'
    })));
  }
}

class CookieStore {
  constructor(dataDir) {
    if (!dataDir) throw new TypeError('CookieStore requires a data path');
    this.directory = path.resolve(dataDir, 'cookies');
  }

  async store(accountId, sourceFile) {
    const source = path.resolve(String(sourceFile || ''));
    const validation = await validateCookieFile(source);
    return this._storeValidated(accountId, validation);
  }

  async storeContent(accountId, content) {
    const validation = validateCookieContent(content);
    return this._storeValidated(accountId, validation);
  }

  async _storeValidated(accountId, validation) {
    const id = normalizeAccountId(accountId);
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const directory = await fs.open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const destination = path.join(this.directory, `${id}.cookies`);
    const temp = `${destination}.${randomUUID()}.tmp`;
    try {
      await directory.chmod(0o700);
      let handle, created = false;
      try {
        handle = await fs.open(temp, 'wx', 0o600); created = true;
        await handle.writeFile(validation.content, 'utf8');
        await handle.sync();
        await handle.close(); handle = null;
        await fs.rename(temp, destination); created = false;
        await directory.sync();
      } finally {
        try { if (handle) await handle.close(); }
        finally {
          if (created) await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
        }
      }
      // Return metadata only. Never return or log cookie contents.
      return { path: destination, bytes: Buffer.byteLength(validation.content), format: validation.format };
    } finally { await directory.close(); }
  }
}

async function validateCookieFile(file) {
  let handle;
  try { handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { throw new Error(`Cookie file is not readable: ${error.code || 'error'}`); }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Cookie file must be a regular file');
    if (stat.size === 0 || stat.size > MAX_COOKIE_BYTES) throw new Error('Cookie file size is invalid');
    // One extra byte detects growth without an unbounded readFile allocation.
    const buffer = Buffer.alloc(stat.size + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total !== stat.size || (await handle.stat()).size !== stat.size) throw new Error('Cookie file changed during validation');
    return validateCookieContent(buffer.subarray(0, total).toString('utf8'));
  } finally { await handle.close(); }
}

function validateCookieContent(content) {
  const text = String(content ?? '');
  if (!text.trim() || text.includes('\u0000') || Buffer.byteLength(text, 'utf8') > MAX_COOKIE_BYTES) throw new Error('Cookie file content is invalid');
  const parsed = parseCookies(text);
  if (!parsed.cookies.length) throw new Error('Cookie file contains no usable cookies');
  return { content: text, format: parsed.format };
}

module.exports = { AccountManager, CookieStore, validateCookieFile, detectCookieFormat: detectFormat, normalizeAccountId, accountRecord, MAX_ACCOUNTS };
