'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function isConflict409(error) {
  if (!error) return false;
  return Boolean(
    error.telegramCode === 409 ||
    error.statusCode === 409 ||
    error.code === 409 ||
    error.code === 'TELEGRAM_CONFLICT' ||
    /conflict.*terminated by other getUpdates/i.test(error.message || '') ||
    /409.*conflict/i.test(error.message || '') ||
    (typeof error.message === 'string' && /conflict/i.test(error.message) && /telegram/i.test(error.message))
  );
}

class SingleInstanceLock {
  constructor(lockPath, {
    timeoutMs = 15_000,
    retryMs = 50,
    staleMs = 120_000,
    maxConflictRetries = 5,
    initialBackoffMs = 1000,
    maxBackoffMs = 30_000
  } = {}) {
    this.lockPath = path.resolve(lockPath);
    this.timeoutMs = timeoutMs;
    this.retryMs = retryMs;
    this.staleMs = staleMs;
    this.maxConflictRetries = maxConflictRetries;
    this.initialBackoffMs = initialBackoffMs;
    this.maxBackoffMs = maxBackoffMs;
    this.token = null;
    this.lastHolderPid = null;
    this.conflictCount = 0;
  }

  get locked() {
    return Boolean(this.token);
  }

  async acquire() {
    await fs.mkdir(path.dirname(this.lockPath), { recursive: true });
    const deadline = Date.now() + this.timeoutMs;
    const token = crypto.randomUUID();
    while (true) {
      try {
        const handle = await fs.open(this.lockPath, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, token, acquiredAt: new Date().toISOString() }) + '\n');
        await handle.close();
        this.token = token;
        return async () => this.release(token);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (await this.recoverStale()) continue;
        if (Date.now() >= deadline) {
          let holderPid = this.lastHolderPid;
          try {
            const current = JSON.parse(await fs.readFile(this.lockPath, 'utf8'));
            if (Number.isInteger(current?.pid) && current.pid > 0) holderPid = current.pid;
          } catch {}
          const msg = holderPid
            ? `Telegram runner lock is held by PID ${holderPid}: ${this.lockPath}`
            : `Telegram runner lock is held: ${this.lockPath}`;
          const locked = new Error(msg);
          locked.code = 'INSTANCE_LOCKED';
          if (holderPid) locked.pid = holderPid;
          throw locked;
        }
        await sleep(Math.min(this.retryMs, Math.max(1, deadline - Date.now())));
      }
    }
  }

  async recoverStale() {
    let stat;
    try { stat = await fs.stat(this.lockPath); } catch (error) { return error.code === 'ENOENT'; }
    let record;
    try { record = JSON.parse(await fs.readFile(this.lockPath, 'utf8')); } catch (_) { record = null; }
    let dead = false;
    if (Number.isInteger(record?.pid) && record.pid > 0) {
      try { process.kill(record.pid, 0); } catch (error) { dead = error.code === 'ESRCH'; }
      // A long-lived polling service is not stale just because its lock is old.
      if (!dead) {
        this.lastHolderPid = record.pid;
        return false;
      }
    }
    if (!(dead || (!record && Date.now() - stat.mtimeMs >= this.staleMs))) return false;
    // Atomic recovery: rename to an isolated stale path first to eliminate race conditions
    const stalePath = `${this.lockPath}.stale.${crypto.randomUUID()}`;
    try {
      await fs.rename(this.lockPath, stalePath);
    } catch (error) {
      return error.code === 'ENOENT';
    }
    try {
      if (record?.token) {
        try {
          const moved = JSON.parse(await fs.readFile(stalePath, 'utf8'));
          if (moved.token !== record.token) {
            await fs.rename(stalePath, this.lockPath).catch(() => {});
            return false;
          }
        } catch {}
      }
      await fs.unlink(stalePath);
      return true;
    } catch (error) {
      return error.code === 'ENOENT';
    }
  }

  async release(token = this.token) {
    if (!token || token !== this.token) return false;
    this.token = null;
    try {
      const record = JSON.parse(await fs.readFile(this.lockPath, 'utf8'));
      if (record.token !== token) return false;
      await fs.unlink(this.lockPath);
      return true;
    } catch (error) {
      return error.code === 'ENOENT';
    }
  }

  /**
   * Exponential backoff and recovery for Telegram HTTP 409 Conflict.
   */
  async handleConflict409({
    error,
    retryCount = 0,
    logger = console,
    sleepFn = sleep
  } = {}) {
    if (!isConflict409(error)) {
      return { shouldRetry: false, error };
    }

    if (retryCount >= this.maxConflictRetries) {
      logger.error?.(JSON.stringify({
        event: 'telegram_conflict_exhausted',
        code: 'TELEGRAM_CONFLICT_LIMIT',
        retries: retryCount,
        maxRetries: this.maxConflictRetries,
        message: error.message
      }));
      return { shouldRetry: false, error };
    }

    // Exponential backoff with jitter: initialBackoff * 2^retry + jitter
    const rawBackoff = Math.min(this.maxBackoffMs, this.initialBackoffMs * Math.pow(2, retryCount));
    const jitter = Math.floor(Math.random() * (rawBackoff * 0.2));
    const backoffMs = rawBackoff + jitter;

    logger.error?.(JSON.stringify({
      event: 'telegram_conflict_transient',
      code: 'TELEGRAM_CONFLICT_RETRY',
      message: error.message,
      retry: retryCount + 1,
      maxRetries: this.maxConflictRetries,
      backoffMs
    }));

    // Check if the conflicting instance has died or released its lock
    await this.recoverStale().catch(() => {});

    await sleepFn(backoffMs);

    return {
      shouldRetry: true,
      backoffMs,
      retryCount: retryCount + 1
    };
  }

  /**
   * Executes an async operation with automatic 409 conflict resilience and exponential backoff.
   */
  async executeWithConflictBackoff(fn, {
    maxRetries = this.maxConflictRetries,
    initialBackoffMs = this.initialBackoffMs,
    maxBackoffMs = this.maxBackoffMs,
    logger = console,
    sleepFn = sleep
  } = {}) {
    let retryCount = 0;
    while (true) {
      try {
        return await fn();
      } catch (error) {
        if (!isConflict409(error)) throw error;
        if (retryCount >= maxRetries) {
          const conflictErr = Object.assign(
            new Error(`Telegram conflict: persistent 409 error after ${retryCount} retries (${error.message})`),
            { code: 'TELEGRAM_CONFLICT', cause: error, telegramCode: 409, statusCode: 409 }
          );
          throw conflictErr;
        }

        const rawBackoff = Math.min(maxBackoffMs, initialBackoffMs * Math.pow(2, retryCount));
        const jitter = Math.floor(Math.random() * (rawBackoff * 0.2));
        const backoffMs = rawBackoff + jitter;

        logger.error?.(JSON.stringify({
          event: 'telegram_conflict_transient',
          code: 'TELEGRAM_CONFLICT_RETRY',
          message: error.message,
          retry: retryCount + 1,
          maxRetries,
          backoffMs
        }));

        await this.recoverStale().catch(() => {});
        await sleepFn(backoffMs);
        retryCount += 1;
      }
    }
  }
}

async function executeWithConflictBackoff(fn, options = {}) {
  const dummyLock = new SingleInstanceLock('/tmp/dummy.lock', options);
  return dummyLock.executeWithConflictBackoff(fn, options);
}

module.exports = {
  SingleInstanceLock,
  isConflict409,
  executeWithConflictBackoff
};
