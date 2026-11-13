'use strict';

/**
 * TransientNotices
 *
 * Durable temporary X-link-notice cleanup scheduler.
 * Enforces single unref timer, single in-flight sweep, bounded retry backoff,
 * safe ID enforcement, and persistent customRootKeys array semantics.
 */

function isSafeChatId(id) {
  if (typeof id === 'number') {
    return Number.isSafeInteger(id) && id !== 0;
  }
  if (typeof id === 'string') {
    return /^-?[1-9]\d*$/.test(id.trim()) && Number.isSafeInteger(Number(id));
  }
  return false;
}

function isSafeMessageId(id) {
  if (typeof id === 'number') {
    return Number.isSafeInteger(id) && id > 0;
  }
  if (typeof id === 'string') {
    return /^[1-9]\d*$/.test(id.trim()) && Number.isSafeInteger(Number(id)) && Number(id) > 0;
  }
  return false;
}

const NOTICE_KEYS = new Set(['kind', 'chatId', 'messageId', 'expiresAt', 'nextAttemptAt', 'attempts']);
function isNotice(entry) {
  return entry && typeof entry === 'object' && !Array.isArray(entry) &&
    entry.kind === 'x-link-notice' && isSafeChatId(entry.chatId) && isSafeMessageId(entry.messageId) &&
    Object.keys(entry).every(key => NOTICE_KEYS.has(key)) &&
    typeof entry.expiresAt === 'number' && Number.isFinite(entry.expiresAt) &&
    typeof entry.nextAttemptAt === 'number' && Number.isFinite(entry.nextAttemptAt) &&
    entry.expiresAt <= entry.nextAttemptAt &&
    (entry.attempts === undefined || (Number.isSafeInteger(entry.attempts) && entry.attempts >= 0));
}
function sameNotice(a, b) {
  return String(a.chatId) === String(b.chatId) && String(a.messageId) === String(b.messageId) &&
    a.expiresAt === b.expiresAt && a.nextAttemptAt === b.nextAttemptAt && a.attempts === b.attempts;
}

class TransientNotices {
  constructor({ store, transport, clock = () => Date.now(), logger } = {}) {
    if (!store || typeof store.load !== 'function' || typeof store.update !== 'function') {
      throw new Error('INVALID_STORE: store must provide load() and update()');
    }
    if (!transport || typeof transport.deleteMessage !== 'function') {
      throw new Error('INVALID_TRANSPORT: transport must provide deleteMessage()');
    }

    this.store = store;
    this.transport = transport;
    this.clock = clock;
    this.logger = logger || null;

    this._timer = null;
    this._timerTargetTime = null;
    this._inFlightSweep = null;
    this._sweepNeedsRerun = false;
    this._closed = false;
    this._chain = Promise.resolve();
    this._storeFailures = 0;
  }

  _logWarn(code, details = {}) {
    try {
      this.logger?.warn?.(code, details);
    } catch {}
  }

  _isMessageNotFound400(error) {
    if (!error) return false;
    const code = error.telegramCode ?? error.statusCode ?? error.code;
    const msg = String(error.description || error.message || '');
    const is400 = code === 400 || code === '400' || /^400\b/.test(String(code));
    return is400 && /message to delete not found/i.test(msg);
  }

  _getRetryAfterSeconds(error) {
    if (!error) return null;
    const val = error.retryAfter ?? error.parameters?.retry_after ?? error.retry_after;
    if (typeof val === 'number' && Number.isFinite(val) && val > 0) return val;
    if (typeof val === 'string' && /^\d+(\.\d+)?$/.test(val.trim())) {
      const num = parseFloat(val);
      if (Number.isFinite(num) && num > 0) return num;
    }
    return null;
  }

  _enqueueMutation(mutator) {
    const run = async () => {
      return await this.store.update(mutator);
    };
    const next = this._chain.then(run, run);
    this._chain = next.catch(() => {});
    return next;
  }

  _armTimer(targetTime) {
    if (this._closed) return;
    const now = this.clock();
    const delay = Math.min(2_147_483_647, Math.max(0, targetTime - now));

    if (this._timer) {
      if (this._timerTargetTime != null && this._timerTargetTime <= targetTime) {
        return;
      }
      clearTimeout(this._timer);
      this._timer = null;
      this._timerTargetTime = null;
    }

    this._timerTargetTime = targetTime;
    this._timer = setTimeout(() => {
      this._timer = null;
      this._timerTargetTime = null;
      this._sweep().catch(() => {});
    }, delay);

    if (typeof this._timer?.unref === 'function') {
      this._timer.unref();
    }
  }

  _clearTimer() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
      this._timerTargetTime = null;
    }
  }

  async _rescheduleTimerFromStore(existingNotices) {
    if (this._closed) {
      this._clearTimer();
      return;
    }
    let notices = existingNotices;
    if (!notices) {
      const state = await this.store.load();
      notices = Array.isArray(state?.transientNotices) ? state.transientNotices : [];
    }
    const xNotices = notices.filter(isNotice);
    if (xNotices.length === 0) {
      this._clearTimer();
      return;
    }
    const earliest = xNotices.reduce((min, entry) => Math.min(min, entry.nextAttemptAt), Infinity);
    if (Number.isFinite(earliest)) {
      this._armTimer(earliest);
    } else {
      this._clearTimer();
    }
  }

  async track(chatId, messageId) {
    if (this._closed) {
      throw new Error('TRANSIENT_NOTICES_CLOSED: cannot track notice after close()');
    }
    if (arguments.length !== 2) {
      throw new Error('INVALID_ARGUMENTS: track expects exactly (chatId, messageId)');
    }
    if (!isSafeChatId(chatId) || !isSafeMessageId(messageId)) {
      throw new Error('INVALID_SAFE_ID: exact safe integer chatId and messageId required, no keyboard/panels allowed');
    }

    const now = this.clock();
    const expiresAt = now + 3000;
    const nextAttemptAt = expiresAt;
    const entry = {
      kind: 'x-link-notice',
      chatId,
      messageId,
      expiresAt,
      nextAttemptAt
    };

    await this._enqueueMutation(draft => {
      if (!Array.isArray(draft.transientNotices)) {
        draft.transientNotices = [];
      }
      const existing = draft.transientNotices.find(
        e => isNotice(e) && String(e.chatId) === String(chatId) && String(e.messageId) === String(messageId)
      );
      if (existing) {
        existing.expiresAt = expiresAt;
        existing.nextAttemptAt = nextAttemptAt;
      } else {
        draft.transientNotices.push(entry);
      }
      return draft;
    });

    this._armTimer(expiresAt);
  }

  async recover() {
    if (this._closed) throw new Error('TRANSIENT_NOTICES_CLOSED');
    try {
      await this._rescheduleTimerFromStore();
    } catch (error) {
      this._retryStoreFailure(error);
    }
  }

  _retryStoreFailure(error) {
    this._storeFailures = Math.min(7, this._storeFailures + 1);
    this._logWarn('transient_notices_store_retry', { code: 'STORE_UNAVAILABLE' });
    this._armTimer(this.clock() + Math.min(60_000, 1000 * 2 ** (this._storeFailures - 1)));
  }

  async _sweep() {
    if (this._closed) return;
    if (this._inFlightSweep) {
      this._sweepNeedsRerun = true;
      return this._inFlightSweep;
    }

    const sweepPromise = (async () => {
      try {
        await this._performSweep();
        this._storeFailures = 0;
      } catch (err) {
        this._retryStoreFailure(err);
      } finally {
        this._inFlightSweep = null;
        if (this._sweepNeedsRerun && !this._closed) {
          this._sweepNeedsRerun = false;
          try { await this._rescheduleTimerFromStore(); } catch (err) { this._retryStoreFailure(err); }
        }
      }
    })();

    this._inFlightSweep = sweepPromise;
    return sweepPromise;
  }

  async _performSweep() {
    if (this._closed) return;
    const state = await this.store.load();
    const notices = Array.isArray(state?.transientNotices) ? state.transientNotices : [];
    const now = this.clock();

    const due = [];
    for (const entry of notices) {
      if (isNotice(entry)) {
        const targetTime = Number(entry.nextAttemptAt ?? entry.expiresAt);
        if (Number.isFinite(targetTime) && targetTime <= now) {
          due.push(entry);
        }
      }
    }

    if (due.length === 0) {
      await this._rescheduleTimerFromStore(notices);
      return;
    }

    const batch = due.slice(0, 25);
    const retired = [];
    const retries = [];

    for (const entry of batch) {
      if (this._closed) break;
      try {
        await this.transport.deleteMessage(entry.chatId, entry.messageId, { strict: true });
        retired.push(entry);
      } catch (error) {
        if (this._isMessageNotFound400(error)) {
          retired.push(entry);
        } else {
          const safeCode = String(
            error?.code ||
            error?.telegramCode ||
            error?.statusCode ||
            (error?.name ? error.name : 'ERR_DELETE_FAILED')
          );
          this._logWarn('transient_notice_delete_failed', { code: safeCode });

          const retryAfterSec = this._getRetryAfterSeconds(error);
          const attempts = (Number.isSafeInteger(entry.attempts) ? entry.attempts : 0) + 1;
          let backoffMs;
          if (retryAfterSec != null && Number(retryAfterSec) > 0) {
            backoffMs = Math.max(1000, Math.round(Number(retryAfterSec) * 1000));
          } else {
            backoffMs = Math.min(60_000, 1000 * Math.pow(2, attempts - 1));
          }
          const nextAttemptAt = this.clock() + backoffMs;
          retries.push({ original: entry, attempts, nextAttemptAt });
        }
      }
    }

    await this._enqueueMutation(draft => {
      if (!Array.isArray(draft.transientNotices)) {
        draft.transientNotices = [];
        return draft;
      }
      const nextNotices = [];
      for (const entry of draft.transientNotices) {
        if (!isNotice(entry)) {
          nextNotices.push(entry);
          continue;
        }
        const isRetired = retired.some(
          r => sameNotice(r, entry)
        );
        if (isRetired) {
          continue;
        }
        const retryInfo = retries.find(
          r => sameNotice(r.original, entry)
        );
        if (retryInfo) {
          entry.attempts = retryInfo.attempts;
          entry.nextAttemptAt = retryInfo.nextAttemptAt;
          nextNotices.push(entry);
          continue;
        }
        nextNotices.push(entry);
      }
      draft.transientNotices = nextNotices;
      return draft;
    });

    await this._rescheduleTimerFromStore();
  }

  async close() {
    this._closed = true;
    this._clearTimer();
    if (this._inFlightSweep) {
      try {
        await this._inFlightSweep;
      } catch {}
    }
    try {
      await this._chain;
    } catch {}
  }
}

module.exports = { TransientNotices };
