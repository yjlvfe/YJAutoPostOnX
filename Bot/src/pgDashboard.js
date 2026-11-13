'use strict';

const { createPool, getDashboardSnapshot } = require('./pgStorage');
const { DashboardDeliveryLoop } = require('./normalizedDashboard');

class PgDashboardReader {
  constructor(poolOrConfig = {}, { clock = () => Date.now(), timeoutMs = 900 } = {}) {
    if (poolOrConfig && typeof poolOrConfig.query === 'function') {
      this.pool = poolOrConfig;
      this.ownsPool = false;
    } else {
      this.pool = createPool(poolOrConfig || {});
      this.ownsPool = true;
    }
    this.clock = clock;
    this.timeoutMs = timeoutMs;
    this.closed = false;
    this.pending = new Set();
  }

  _cancelBackend(pid) {
    if (!Number.isInteger(pid) || pid <= 0 || !this.pool || typeof this.pool.query !== 'function') {
      return Promise.resolve();
    }
    return this.pool.query('SELECT pg_cancel_backend($1)', [pid]).catch(() => {});
  }

  read(day = null) {
    if (this.closed) {
      return Promise.reject(
        Object.assign(new Error('PG_DASHBOARD_READER_CLOSED'), { code: 'PG_DASHBOARD_READER_CLOSED' })
      );
    }
    const nowIso = new Date(this.clock()).toISOString();
    let timer = null;
    const entry = { reject: null, timer: null, pid: null, aborted: false };

    const timeoutPromise = new Promise((_, reject) => {
      entry.reject = reject;
      timer = setTimeout(() => {
        entry.aborted = true;
        this.pending.delete(entry);
        if (entry.pid) this._cancelBackend(entry.pid);
        reject(Object.assign(new Error('PG_DASHBOARD_READ_TIMEOUT'), { code: 'PG_DASHBOARD_READ_TIMEOUT' }));
      }, this.timeoutMs);
      timer.unref?.();
      entry.timer = timer;
    });

    this.pending.add(entry);
    const snapshotPromise = getDashboardSnapshot(this.pool, {
      day,
      now: nowIso,
      statementTimeoutMs: this.timeoutMs,
      onBackendPid: pid => {
        entry.pid = pid;
        if (entry.aborted) {
          this._cancelBackend(pid);
        }
      }
    }).finally(() => {
      if (timer) clearTimeout(timer);
      this.pending.delete(entry);
    });

    return Promise.race([snapshotPromise, timeoutPromise]);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const cancelPromises = [];
    for (const entry of this.pending) {
      entry.aborted = true;
      if (entry.timer) clearTimeout(entry.timer);
      if (entry.pid) cancelPromises.push(this._cancelBackend(entry.pid));
      if (entry.reject) {
        entry.reject(Object.assign(new Error('PG_DASHBOARD_READER_CLOSED'), { code: 'PG_DASHBOARD_READER_CLOSED' }));
      }
    }
    this.pending.clear();
    if (cancelPromises.length > 0) {
      await Promise.allSettled(cancelPromises);
    }
    if (this.ownsPool && this.pool && typeof this.pool.end === 'function') {
      await this.pool.end();
    }
  }
}

module.exports = {
  PgDashboardReader,
  NormalizedDashboardReader: PgDashboardReader,
  DashboardDeliveryLoop
};
