'use strict';
// Browserless, process-isolated X adapter. See python/README.md for the durable
// dispatch contract. Neither credentials nor remote exception bodies are logged.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { acquireSession } = require('./sessionGuard');

const activeProcesses = new Set();
function cleanupActiveProcesses() {
  for (const child of activeProcesses) {
    try { if (!child.killed && child.exitCode === null) child.kill('SIGKILL'); } catch {}
  }
  activeProcesses.clear();
}
if (!global._directXCleanupHook) {
  global._directXCleanupHook = true;
  process.once('exit', cleanupActiveProcesses);
  process.once('SIGINT', () => { cleanupActiveProcesses(); process.exit(130); });
  process.once('SIGTERM', () => { cleanupActiveProcesses(); process.exit(143); });
}

function extractTwidUserId(cookieFile) {
  try {
    const raw = fs.readFileSync(cookieFile, 'utf8');
    const m = raw.match(/["']?twid["']?\s*[:=]\s*["']?(?:u%3D|u=)(\d+)["']?/);
    return m ? m[1] : null;
  } catch { return null; }
}

function validateProxy(proxy) {
  if (typeof proxy !== 'string' || !/^socks5h:\/\/(127\.0\.0\.1|localhost):1880[1-5]$/.test(proxy)) {
    const error = new Error('An explicit per-account localhost SOCKS5h proxy is required');
    error.code = 'DIRECT_X_PROXY_REQUIRED';
    throw error;
  }
  return proxy;
}
const unsent = reason => ({ status: 'not_ready', published: false, posted: false, ambiguous: false, blocked: true, reason });
const ambiguous = reason => ({ status: 'ambiguous', published: false, posted: false, ambiguous: true, reason });
const handle = value => typeof value === 'string' && /^@?[A-Za-z0-9_]{1,15}$/.test(value) ? value.replace(/^@/, '').toLowerCase() : null;
const expected = account => handle(account?.username || account?.handle || account?.expectedUsername || account?.identity);
const numericId = value => typeof value === 'string' && /^\d+$/.test(value);
const validIdentity = identity => identity?.authenticated === true && identity?.state === 'authenticated' && !identity?.accountFailure && handle(identity.username) && numericId(identity.userId);
const readDiagnostic = value => ({
  phase: ['user_state', 'settings', 'profile'].includes(value?.phase) ? value.phase : 'bridge',
  httpStatus: Number.isInteger(value?.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599 ? value.httpStatus : null,
  ...(Number.isFinite(value?.retryAfterSeconds) && value.retryAfterSeconds >= 0 ? { retryAfterSeconds: Math.min(900, Math.max(60, value.retryAfterSeconds)) } : {})
});


function defaultPythonExecutable() {
  if (process.env.DIRECT_X_PYTHON) return process.env.DIRECT_X_PYTHON;
  const venvPython = path.resolve(__dirname, '../.venv-direct-x/bin/python');
  if (fs.existsSync(venvPython)) return venvPython;
  return 'python3';
}


class DirectXAdapter {
  constructor({ pythonExecutable = defaultPythonExecutable(), allowPublish = false,
    openTimeoutMs = 30_000, publishTimeoutMs = 45_000, onDispatch } = {}) {
    this.pythonExecutable = pythonExecutable;
    this.allowPublish = allowPublish === true;
    this.openTimeoutMs = checkedTimeout(openTimeoutMs);
    this.publishTimeoutMs = checkedTimeout(publishTimeoutMs);
    this.onDispatch = onDispatch;
    this.sessions = new WeakMap();
  }

  async open({ account, accountRecord, proxy, signal } = {}) {
    validateProxy(proxy);
    const selected = accountRecord || account;
    if (!selected || typeof selected !== 'object' || !selected.id || !(selected.cookieFile || selected.cookiePath)) {
      throw Object.assign(new Error('Account id and cookie file are required'), { code: 'DIRECT_X_ACCOUNT_REQUIRED' });
    }
    const configured = selected.username || selected.handle || selected.expectedUsername || selected.identity;
    if ((configured && !handle(configured)) || (selected.userId != null && (typeof selected.userId !== 'string' || !/^\d+$/.test(selected.userId)))) {
      throw Object.assign(new Error('Configured account identity is invalid'), { code: 'DIRECT_X_AUTH_IDENTITY_INVALID' });
    }
    if (signal?.aborted) throw Object.assign(new Error('Open cancelled'), { code: 'DIRECT_X_STOPPED' });
    const lease = acquireSession({ accountId: selected.id });
    const session = { accountId: String(selected.id), identity: null, closed: false, state: 'opening' };
    let child;
    try {
      // Env is intentionally allowlisted: proxy and Python import injection variables
      // from the parent must not affect the isolated interpreter or transport.
      child = spawn(this.pythonExecutable, ['-I', '-u', path.resolve(__dirname, '../python/direct_x_bridge.py')], {
        stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C.UTF-8' },
      });
      lease.pid = child.pid;
    } catch (spawnError) {
      lease.release();
      throw spawnError;
    }
    activeProcesses.add(child);
    child.once('exit', () => {
      activeProcesses.delete(child);
      lease.release();
    });
    const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', () => { if (!child.pid) resolve(); }); });
    const state = { child, exited, buffer: '', pending: null, dead: false, used: false, busy: false, identity: null, lease };
    this.sessions.set(session, state);
    child.stderr.on('data', () => {}); // Never forward Python traces / HTTP bodies.
    child.stdin.on('error', () => this._failed(state));
    child.on('error', () => this._failed(state));
    child.on('exit', () => this._failed(state));
    child.stdout.on('data', chunk => {
      state.buffer += chunk.toString('utf8');
      let index;
      while ((index = state.buffer.indexOf('\n')) >= 0) {
        const line = state.buffer.slice(0, index);
        state.buffer = state.buffer.slice(index + 1);
        const trimmed = line.trim();
        if (!trimmed) continue;
        try { this._message(state, JSON.parse(trimmed)); } catch { this._failed(state); }
      }
      if (state.buffer.length > 1_048_576) return this._failed(state);
    });
    try {
      const resolvedCookie = path.resolve(String(selected.cookieFile || selected.cookiePath));
      const effectiveUserId = selected.userId || extractTwidUserId(resolvedCookie);
      const result = await this._command(state, { op: 'open', account: {
        id: String(selected.id), username: expected(selected), userId: effectiveUserId,
        cookieFile: resolvedCookie,
        use_cache: Boolean(effectiveUserId && !selected.verifyNetwork),
      }, proxy }, { timeout: this.openTimeoutMs, signal });
      const identity = result.identity;
      const isAccountFailed = Boolean(result.accountFailure || identity?.accountFailure || identity?.state === 'suspended' || identity?.state === 'blocked');
      if (!isAccountFailed && validIdentity(identity) && (!expected(selected) || expected(selected) === handle(identity.username)) &&
          (!selected.userId || selected.userId === identity.userId)) {
        state.identity = Object.freeze({ ...identity, username: handle(identity.username) });
        session.identity = { ...state.identity };
        session.state = 'authenticated';
      } else {
        session.identity = { state: 'identity_unverified', authenticated: false, accountFailure: result.accountFailure || identity?.accountFailure, reason: result.reason || identity?.reason || (isAccountFailed ? 'account_suspended_or_failed' : 'identity_unverified'), readDiagnostic: readDiagnostic(result.readDiagnostic), retryable: result.retryable === true && result.reason === 'identity_read_unavailable' && !result.accountFailure && !identity?.accountFailure };
        session.state = 'blocked';
        await this.close({ session });
      }
      return session;
    } catch {
      await this.close({ session });
      throw Object.assign(new Error('Direct X session could not be verified'), { code: signal?.aborted ? 'DIRECT_X_STOPPED' : 'DIRECT_X_IDENTITY_READ_UNAVAILABLE' });
    }
  }

  async publish({ session, payload = {}, confirmPublish = false, signal, onDispatch } = {}) {
    const state = this.sessions.get(session);
    if (state?.used) return ambiguous('dispatch_already_attempted');
    if (!state || state.dead || session.closed || !validIdentity(state.identity)) return unsent('auth_session_unverified');
    if (state.busy) return unsent('auth_session_busy');
    if (signal?.aborted) return unsent('stopped');
    const text = payload.text ?? payload.content ?? payload.body;
    if (typeof text !== 'string' || !text.trim()) return unsent('invalid_text');
    if (Object.keys(payload).some(key => !['text', 'content', 'body'].includes(key))) return unsent('unsupported_payload');
    if (!(this.allowPublish && confirmPublish === true)) return { status: 'dry_run', ready: true, published: false, posted: false };
    const callback = onDispatch || this.onDispatch;
    if (typeof callback !== 'function') return unsent('durable_dispatch_callback_required');
    state.busy = true;
    try {
      const result = await this._command(state, { op: 'publish', text }, {
        timeout: this.publishTimeoutMs, signal, callback, accountId: session.accountId,
      });
      if (result.status !== 'published') {
        if (result.verifiedNotPosted === true || result.verified_not_posted === true) {
          return {
            status: 'not_ready',
            published: false,
            posted: false,
            ambiguous: false,
            blocked: false,
            retryable: true,
            verifiedNotPosted: true,
            reason: result.reason || 'publish_not_posted_on_timeline',
            rawError: result.rawError,
            xErrorCode: result.xErrorCode,
            xErrorMessage: result.xErrorMessage,
            xResponseKind: result.xResponseKind,
            verificationError: result.verificationError,
            httpStatus: result.httpStatus
          };
        }
        if (result.rateLimit === true || result.status === 'rate_limit') {
          return {
            status: 'rate_limit',
            published: false,
            posted: false,
            rateLimit: true,
            ambiguous: false,
            retryable: true,
            accountFailure: 'rate_limit',
            retryAfterSeconds: result.retryAfterSeconds || 60,
            reason: result.reason || 'rate_limit',
            rawError: result.rawError,
            xErrorCode: result.xErrorCode,
            xErrorMessage: result.xErrorMessage,
            xResponseKind: result.xResponseKind,
            verificationError: result.verificationError,
            httpStatus: result.httpStatus,
          };
        }
        if (state.used || result.ambiguous) {
          return {
            ...ambiguous(result.reason || 'publish_unverified'),
            accountFailure: result.accountFailure,
            rawError: result.rawError,
            xErrorCode: result.xErrorCode,
            fetchError: result.fetchError,
            xResponseKind: result.xResponseKind,
            xErrorMessage: result.xErrorMessage,
            httpStatus: result.httpStatus,
            verificationError: result.verificationError
          };
        }
        return {
          ...unsent(result.reason || (result.rateLimit ? 'rate_limit' : 'auth_pre_dispatch_failed')),
          accountFailure: result.accountFailure || (result.rateLimit ? 'rate_limit' : undefined),
          rawError: result.rawError,
          xErrorCode: result.xErrorCode,
          fetchError: result.fetchError,
          xResponseKind: result.xResponseKind,
          xErrorMessage: result.xErrorMessage,
          httpStatus: result.httpStatus,
          verificationError: result.verificationError,
          rateLimit: Boolean(result.rateLimit),
          retryAfterSeconds: result.retryAfterSeconds,
          readDiagnostic: readDiagnostic(result.readDiagnostic),
          retryable: result.retryable === true && result.reason === 'identity_read_unavailable' && !result.accountFailure
        };
      }
      if (!state.used || !numericId(result.tweetId) || result.userId !== state.identity.userId || handle(result.username) !== state.identity.username) {
        return ambiguous('publish_author_or_id_unverified');
      }
      return { status: 'published', published: true, posted: true, tweetId: result.tweetId,
        username: state.identity.username, userId: state.identity.userId,
        url: result.tweetUrl || `https://x.com/${state.identity.username}/status/${result.tweetId}`,
        recoveredFromTimeline: result.recoveredFromTimeline === true || result.recovered_from_timeline === true,
        ok: true };
    } catch (err) {
      return state.used ? { ...ambiguous('publish_confirmation_missing'), rawError: err?.message } : signal?.aborted ? unsent('stopped') : { ...unsent('identity_read_unavailable'), retryable: true, rawError: err?.message };
    } finally { state.busy = false; }
  }

  _command(state, command, { timeout, signal, callback, accountId }) {
    if (state.dead || state.pending) return Promise.reject(new Error('Bridge unavailable'));
    return new Promise((resolve, reject) => {
      const stop = () => this._failed(state);
      const pending = { resolve: value => { cleanup(); resolve(value); }, reject: () => { cleanup(); reject(new Error('Bridge unavailable')); }, callback, accountId, dispatch: false, acknowledged: false };
      const timer = setTimeout(stop, timeout);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); if (state.pending === pending) state.pending = null; };
      state.pending = pending;
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) return stop();
      state.child.stdin.write(JSON.stringify(command) + '\n');
    });
  }

  _message(state, message) {
    const pending = state.pending;
    if (!pending || state.dead) return this._failed(state);
    if (message.event === 'dispatch_ready') {
      if (pending.dispatch || !pending.callback) return this._failed(state);
      pending.dispatch = true;
      // Fence before invoking the durable write: rejected writes can have committed.
      state.used = true;
      Promise.resolve().then(() => pending.callback({ accountId: pending.accountId })).then(ack => {
        if (state.pending !== pending || state.dead) return;
        if (ack !== true) return this._failed(state);
        pending.acknowledged = true;
        state.child.stdin.write('{"op":"dispatch_ack"}\n');
      }, () => this._failed(state));
    } else if (message.event === 'result') {
      const result = message.result || {};
      if (result.status === 'published' && !pending.acknowledged) {
        pending.resolve({ ...result, status: 'ambiguous', published: false, posted: false,
          ambiguous: true, reason: 'dispatch_ack_missing' });
      } else pending.resolve(result);
    } else this._failed(state);
  }

  _failed(state) {
    if (state.dead) return;
    state.dead = true;
    state.buffer = '';
    try { state.child.stdout?.destroy(); } catch {}
    try { state.child.stderr?.destroy(); } catch {}
    try { state.child.stdin?.destroy(); } catch {}
    try { if (!state.child.killed && state.child.exitCode === null) state.child.kill('SIGKILL'); } catch {}
    state.pending?.reject();
  }

  async close({ session } = {}) {
    if (!session) return;
    session.closed = true;
    const state = this.sessions.get(session);
    if (state) {
      if (!state.dead) {
        state.dead = true;
        state.pending?.reject();
        try {
          state.child.stdin.end();
          state.child.kill('SIGTERM');
        } catch {}
        const forceTimer = setTimeout(() => {
          try { if (!state.child.killed && state.child.exitCode === null) state.child.kill('SIGKILL'); } catch {}
        }, 500);
        await state.exited;
        clearTimeout(forceTimer);
      } else {
        await state.exited;
      }
      state.lease?.release();
    }
  }
}
function checkedTimeout(value) {
  if (!Number.isFinite(value) || value < 1 || value > 300_000) throw new TypeError('Invalid direct X timeout');
  return value;
}
module.exports = { DirectXAdapter, validateProxy };
