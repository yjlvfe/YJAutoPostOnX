'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { withForensicMutex } = require('./forensicMutex');
const { logStructured, sanitizeError, sanitizeString, sanitizeValue, extractErrorCode } = require('./structuredLogger');

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const BURNED_SUBNET_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const HOST_PROD_DATA_DIR = '/root/Projects/YJAutoPostOnX/Bot/data';

function getProtectedProdDataDirs() {
  const candidates = [
    path.resolve(__dirname, '../data'),
    HOST_PROD_DATA_DIR,
  ];
  if (process.env.BOT_PRODUCTION_DATA_DIR) {
    candidates.push(path.resolve(process.env.BOT_PRODUCTION_DATA_DIR));
  }
  const dirs = new Set();
  for (const dir of candidates) {
    const resolved = path.resolve(dir);
    dirs.add(resolved);
    try {
      if (fs.existsSync(resolved)) {
        dirs.add(fs.realpathSync(resolved));
      }
    } catch {}
  }
  return Array.from(dirs);
}

function getCanonicalProdDataDir() {
  return getProtectedProdDataDirs()[0];
}

function isTestEnvironment() {
  return Boolean(
    process.env.NODE_ENV === 'test' ||
    process.env.NODE_TEST_CONTEXT ||
    process.env.npm_lifecycle_event?.startsWith('test') ||
    process.env.YJ_TEST_MODE === '1' ||
    process.execArgv.some(arg => typeof arg === 'string' && (arg.includes('test') || arg.includes('--test'))) ||
    process.argv.some(arg => typeof arg === 'string' && (arg.includes('test') || arg.includes('--test')))
  );
}

function isTargetingProdForensic(targetPath) {
  if (!targetPath) return false;
  const prodDirs = getProtectedProdDataDirs();
  try {
    const resolved = path.resolve(targetPath);
    const candidates = [resolved];
    if (fs.existsSync(resolved)) {
      try { candidates.push(fs.realpathSync(resolved)); } catch {}
    } else {
      const parent = path.dirname(resolved);
      if (fs.existsSync(parent)) {
        try { candidates.push(path.join(fs.realpathSync(parent), path.basename(resolved))); } catch {}
      }
    }
    for (const cand of candidates) {
      for (const prodDir of prodDirs) {
        if (cand === prodDir || cand.startsWith(prodDir + path.sep)) {
          return true;
        }
      }
    }
    if (fs.existsSync(resolved)) {
      const targetStat = fs.statSync(resolved);
      for (const prodDir of prodDirs) {
        for (const prodTarget of [prodDir, path.join(prodDir, 'logs', 'forensic.jsonl')]) {
          try {
            if (fs.existsSync(prodTarget)) {
              const pStat = fs.statSync(prodTarget);
              if (pStat.dev === targetStat.dev && pStat.ino === targetStat.ino) {
                return true;
              }
            }
          } catch {}
        }
      }
    }
  } catch {}
  return false;
}

function assertForensicMutationAllowed(...targets) {
  if (isTestEnvironment()) {
    for (const target of targets) {
      if (isTargetingProdForensic(target)) {
        const err = new Error('PROD_FORENSIC_MUTATION_FORBIDDEN_IN_TEST: Tests are strictly forbidden from mutating production forensic logs. Use an isolated temporary dataDir.');
        err.code = 'PROD_FORENSIC_MUTATION_FORBIDDEN_IN_TEST';
        throw err;
      }
    }
  }
}

async function fsyncDirectory(dirPath) {
  let dirHandle;
  try {
    dirHandle = await fsp.open(dirPath, 'r');
    await dirHandle.sync();
  } catch {
    // Best-effort directory sync on platforms/filesystems that support it
  } finally {
    if (dirHandle) {
      try { await dirHandle.close(); } catch {}
    }
  }
}

function normalizeSubnet(ip) {
  if (!ip || typeof ip !== 'string') return null;
  const parts = ip.split('/')[0].trim().split('.');
  return parts.length >= 3 ? `${parts[0]}.${parts[1]}.${parts[2]}.0/24` : null;
}

class ForensicLogger {
  constructor({ store, dataDir, logFile, maxAgeMs = SEVEN_DAYS_MS, clock = Date.now } = {}) {
    this.store = store || null;
    this.dataDir = dataDir ? path.resolve(dataDir) : null;
    this.maxAgeMs = maxAgeMs;
    this.clock = clock;
    this.logFile = logFile ? path.resolve(logFile) : (dataDir ? path.join(dataDir, 'logs', 'forensic.jsonl') : null);
    if (this.logFile && (!isTestEnvironment() || (!isTargetingProdForensic(this.dataDir) && !isTargetingProdForensic(this.logFile)))) {
      const dir = path.dirname(this.logFile);
      try {
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        }
      } catch {}
    }
  }

  _normalizeEvent(event, now = typeof this.clock === 'function' ? this.clock() : Date.now()) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw new TypeError('INVALID_FORENSIC_EVENT: event must be an object');
    }
    const timestamp = new Date(now).toISOString();
    const exitIp = event.exitIp || null;
    const subnet = event.subnet || normalizeSubnet(exitIp);
    return {
      id: event.id || crypto.randomUUID(),
      timestamp: event.timestamp || timestamp,
      epoch: typeof event.epoch === 'number' ? event.epoch : now,
      eventType: String(event.eventType || 'unknown'),
      accountId: event.accountId ? String(event.accountId) : null,
      username: event.username ? String(event.username) : null,
      slot: Number.isInteger(event.slot) ? event.slot : null,
      port: Number.isInteger(event.port) ? event.port : null,
      containerName: event.containerName || (Number.isInteger(event.slot) ? `yj_autopost_vpn_${event.slot + 1}` : null),
      exitIp,
      subnet,
      httpStatus: typeof event.httpStatus === 'number' ? event.httpStatus : null,
      xErrorCode: typeof event.xErrorCode === 'number' ? event.xErrorCode : null,
      xErrorMessage: event.xErrorMessage ? sanitizeString(String(event.xErrorMessage)).slice(0, 512) : null,
      endpoint: event.endpoint ? sanitizeString(String(event.endpoint)).slice(0, 256) : null,
      rawResponseSnippet: event.rawResponseSnippet ? sanitizeString(String(event.rawResponseSnippet)).slice(0, 1000) : null,
      details: event.details ? sanitizeValue(event.details) : null
    };
  }

  // Synchronous transaction hook. It deliberately performs no I/O and no store update.
  enqueue(state, event) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      throw new TypeError('INVALID_FORENSIC_STATE: state must be an object');
    }
    const now = typeof this.clock === 'function' ? this.clock() : Date.now();
    const record = this._normalizeEvent(event, now);
    const logs = Array.isArray(state.forensicLogs) ? state.forensicLogs : [];
    const pending = Array.isArray(state.pendingForensicOutbox) ? state.pendingForensicOutbox : [];
    if (!logs.some(item => item && item.id === record.id)) logs.push(record);
    if (!pending.some(item => item && item.id === record.id)) pending.push(record);
    const cutoff = now - this.maxAgeMs;
    state.forensicLogs = logs.filter(item => item && typeof item.epoch === 'number' && item.epoch >= cutoff);
    state.pendingForensicOutbox = pending.filter(item => item && item.id);
    return record;
  }

  async record(event) {
    assertForensicMutationAllowed(this.dataDir, this.logFile);
    let record = this._normalizeEvent(event);
    const normalizedEvent = record;
    if (this.store && !this.store.closed) {
      try {
        let durableRecord;
        const updated = await this.store.update(state => {
          durableRecord = this.enqueue(state, normalizedEvent);
          return { state, result: durableRecord };
        });
        record = durableRecord || (updated && updated.result) || record;
      } catch (err) {
        // The SQLite transaction may fail before an outbox row exists. Never
        // report a successful forensic write while losing the evidence: the
        // existing JSONL is the durable fallback and reconcile() can restore
        // the SQLite projection on the next healthy pass.
        if (!this.store?.closed && !/Store is closed/i.test(String(err?.message || ''))) {
          logStructured(null, { level: 'error', component: 'forensic_logger', event: 'forensic_logger_io_error', operation: 'store_update', result: 'failed', errorCode: extractErrorCode(err), sanitizedError: sanitizeError(err), target: 'store' });
        }
        if (this.logFile) {
          try { await this._appendDeduplicated([record]); }
          catch (fallbackErr) {
            logStructured(null, { level: 'error', component: 'forensic_logger', event: 'forensic_logger_io_error', operation: 'file_append_fallback', result: 'failed', errorCode: extractErrorCode(fallbackErr), sanitizedError: sanitizeError(fallbackErr), target: 'file' });
            throw fallbackErr;
          }
        } else {
          throw err;
        }
      }
    }
    if (this.logFile) {
      try {
        if (this.store && !this.store.closed) {
          await this.flushOutbox();
        } else if (!this.store || this.store.closed) {
          await this._appendDeduplicated([record]);
        }
      } catch (err) {
        logStructured(null, { level: 'error', component: 'forensic_logger', event: 'forensic_logger_io_error', operation: 'file_append', result: 'failed', errorCode: extractErrorCode(err), sanitizedError: sanitizeError(err), target: 'file' });
        if (!this.store || this.store.closed) throw err;
      }
    }
    return record;
  }

  async prune(now = typeof this.clock === 'function' ? this.clock() : Date.now()) {
    assertForensicMutationAllowed(this.dataDir, this.logFile);
    const cutoff = now - this.maxAgeMs;
    let prunedCount = 0;

    // Prune in store
    if (this.store && !this.store.closed) {
      try {
        let storePruned = 0;
        await this.store.update(state => {
          storePruned = 0;
          if (!Array.isArray(state.forensicLogs)) return state;
          const before = state.forensicLogs.length;
          state.forensicLogs = state.forensicLogs.filter(e => typeof e.epoch === 'number' && e.epoch >= cutoff);
          storePruned = before - state.forensicLogs.length;
          return state;
        });
        prunedCount += storePruned;
      } catch (err) {
        if (!this.store?.closed && !/Store is closed/i.test(String(err?.message || ''))) {
          logStructured(null, {
            level: 'error',
            component: 'forensic_logger',
            event: 'forensic_logger_io_error',
            operation: 'store_prune',
            result: 'failed',
            errorCode: extractErrorCode(err),
            sanitizedError: sanitizeError(err),
            target: 'store_prune'
          });
        }
      }
    }

    // Prune JSONL file under the same interprocess mutex as append/reconcile.
    if (this.logFile) {
      try {
        await this._withLogLock(async () => {
        const content = await fsp.readFile(this.logFile, 'utf8').catch(err => {
          if (err.code !== 'ENOENT') {
            logStructured(null, {
              level: 'warn',
              component: 'forensic_logger',
              event: 'forensic_log_read_failed',
              operation: 'prune_readFile',
              result: 'failed',
              errorCode: extractErrorCode(err),
              sanitizedError: sanitizeError(err)
            });
            throw err;
          }
          return '';
        });
        if (content) {
          const lines = content.split('\n').filter(Boolean);
          const retained = [];
          for (const line of lines) {
            try {
              const item = JSON.parse(line);
              if (item.epoch && item.epoch >= cutoff) {
                retained.push(line);
              } else {
                prunedCount++;
              }
            } catch (parseErr) {
              prunedCount++;
              logStructured(null, {
                level: 'warn',
                component: 'forensic_logger',
                event: 'corrupt_log_line_skipped',
                operation: 'prune_parse',
                result: 'skipped',
                suppressionReason: 'corrupt_json',
                errorCode: 'JSON_PARSE_ERROR',
                sanitizedError: sanitizeError(parseErr)
              });
            }
          }
          const dir = path.dirname(this.logFile);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
          const tempPath = `${this.logFile}.${crypto.randomUUID()}.tmp`;
          const handle = await fsp.open(tempPath, 'w', 0o600);
          try {
            await handle.write(retained.length ? retained.join('\n') + '\n' : '');
            await handle.sync();
          } finally {
            await handle.close();
          }
          await fsp.rename(tempPath, this.logFile);
          await fsyncDirectory(dir);
        }
        });
      } catch (err) {
        logStructured(null, {
          level: 'error',
          component: 'forensic_logger',
          event: 'forensic_logger_io_error',
          operation: 'file_prune',
          result: 'failed',
          errorCode: extractErrorCode(err),
          sanitizedError: sanitizeError(err),
          target: 'file_prune'
        });
      }
    }

    return { prunedCount, cutoff };
  }

  async pruneBurnedSubnets(now = typeof this.clock === 'function' ? this.clock() : Date.now()) {
    assertForensicMutationAllowed(this.dataDir, this.logFile, this.store?.dataDir);
    if (!this.store || this.store.closed) return { prunedCount: 0 };
    const cutoff = now - BURNED_SUBNET_TTL_MS;
    let prunedCount = 0;
    try {
      await this.store.update(state => {
        if (!Array.isArray(state.burnedSubnets)) return state;
        const before = state.burnedSubnets.length;
        state.burnedSubnets = state.burnedSubnets.filter(entry => {
          // Legacy string entries (no timestamp) → keep forever until manually removed
          if (typeof entry === 'string') return true;
          // New format { subnet, burnedAt } → prune if older than TTL
          return typeof entry.burnedAt === 'number' && entry.burnedAt >= cutoff;
        });
        prunedCount = before - state.burnedSubnets.length;
        return state;
      });
    } catch (err) {
      if (!this.store?.closed && !/Store is closed/i.test(String(err?.message || ''))) {
        logStructured(null, {
          level: 'error',
          component: 'forensic_logger',
          event: 'prune_burned_subnets_failed',
          operation: 'pruneBurnedSubnets',
          result: 'failed',
          errorCode: extractErrorCode(err),
          sanitizedError: sanitizeError(err)
        });
      }
    }
    return { prunedCount, cutoff, ttlDays: 30 };
  }

  async query({ accountId, username, eventType, sinceEpoch, limit = 100 } = {}) {
    let logs = [];
    if (this.store && !this.store.closed) {
      const state = await this.store.load();
      logs = state.forensicLogs || [];
    } else if (this.logFile) {
      const content = await fsp.readFile(this.logFile, 'utf8').catch(err => {
        if (err.code !== 'ENOENT') {
          logStructured(null, {
            level: 'warn',
            component: 'forensic_logger',
            event: 'forensic_log_read_failed',
            operation: 'query_readFile',
            result: 'failed',
            errorCode: extractErrorCode(err),
            sanitizedError: sanitizeError(err)
          });
        }
        return '';
      });
      logs = content.split('\n').filter(Boolean).map(l => {
        try { return JSON.parse(l); } catch (parseErr) {
          logStructured(null, {
            level: 'warn',
            component: 'forensic_logger',
            event: 'corrupt_log_line_skipped',
            operation: 'query_parse',
            result: 'skipped',
            suppressionReason: 'corrupt_json',
            errorCode: 'JSON_PARSE_ERROR',
            sanitizedError: sanitizeError(parseErr)
          });
          return null;
        }
      }).filter(Boolean);
    }

    let filtered = logs;
    if (accountId) filtered = filtered.filter(l => l.accountId === accountId);
    if (username) filtered = filtered.filter(l => l.username === username);
    if (eventType) filtered = filtered.filter(l => l.eventType === eventType);
    if (sinceEpoch) filtered = filtered.filter(l => l.epoch >= sinceEpoch);

    return filtered.slice(-limit);
  }

  async _withLogLock(fn) {
    // Required PG admission and stable kernel fence through every awaited file I/O.
    // A lost PG session must not release the local writer fence; never unlink it.
    const previous=this.logLockTail || Promise.resolve();
    const task=previous.catch(()=>{}).then(()=>withForensicMutex(this.logFile,fn));
    this.logLockTail=task.catch(()=>{});
    return task;
  }

  async reconcile(now = typeof this.clock === 'function' ? this.clock() : Date.now()) {
    assertForensicMutationAllowed(this.dataDir, this.logFile);
    return this._withLogLock(async () => {
      const cutoff = now - this.maxAgeMs;
      const storeLogs = [];
      if (this.store) {
        try {
          const state = await this.store.load();
          if (Array.isArray(state.forensicLogs)) {
            storeLogs.push(...state.forensicLogs);
          }
          if (Array.isArray(state.pendingForensicOutbox)) {
            storeLogs.push(...state.pendingForensicOutbox);
          }
        } catch (err) {
          logStructured(null, {
            level: 'error',
            component: 'forensic_logger',
            event: 'forensic_reconcile_store_error',
            operation: 'reconcile_load_store',
            result: 'failed',
            errorCode: extractErrorCode(err),
            sanitizedError: sanitizeError(err)
          });
          throw err; // Fail closed: never overwrite file or store if store.load() fails
        }
      }

      const fileLogs = [];
      if (this.logFile) {
        try {
          let content = '';
          try {
            content = await fsp.readFile(this.logFile, 'utf8');
          } catch (readErr) {
            if (readErr.code !== 'ENOENT') {
              logStructured(null, {
                level: 'warn',
                component: 'forensic_logger',
                event: 'forensic_log_read_failed',
                operation: 'reconcile_readFile',
                result: 'failed',
                errorCode: extractErrorCode(readErr),
                sanitizedError: sanitizeError(readErr)
              });
              throw readErr; // Fail closed: never overwrite store or file on non-ENOENT read error
            }
          }
          if (content) {
            for (const line of content.split('\n').filter(Boolean)) {
              try { fileLogs.push(JSON.parse(line)); } catch (parseErr) {
                logStructured(null, {
                  level: 'warn',
                  component: 'forensic_logger',
                  event: 'corrupt_log_line_skipped',
                  operation: 'reconcile_parse',
                  result: 'skipped',
                  suppressionReason: 'corrupt_json',
                  errorCode: 'JSON_PARSE_ERROR',
                  sanitizedError: sanitizeError(parseErr)
                });
              }
            }
          }
        } catch (err) {
          logStructured(null, {
            level: 'error',
            component: 'forensic_logger',
            event: 'forensic_reconcile_file_error',
            operation: 'reconcile_load_file',
            result: 'failed',
            errorCode: extractErrorCode(err),
            sanitizedError: sanitizeError(err)
          });
          throw err;
        }
      }

      const map = new Map();
      for (const log of [...storeLogs, ...fileLogs]) {
        if (!log || !log.id) continue;
        if (typeof log.epoch === 'number' && log.epoch < cutoff) continue;
        map.set(log.id, log);
      }

      const reconciled = Array.from(map.values()).sort((a, b) => (a.epoch || 0) - (b.epoch || 0));

      // Phase 1: Durably write to JSONL file with temp file, fsync, atomic rename, and parent dir fsync FIRST
      let updatedFile = false;
      if (this.logFile) {
        try {
          const dir = path.dirname(this.logFile);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
          const content = reconciled.map(r => JSON.stringify(r)).join('\n') + (reconciled.length ? '\n' : '');
          const tempPath = `${this.logFile}.${crypto.randomUUID()}.tmp`;
          const handle = await fsp.open(tempPath, 'w', 0o600);
          try {
            await handle.write(content);
            await handle.sync();
          } finally {
            await handle.close();
          }
          await fsp.rename(tempPath, this.logFile);
          await fsyncDirectory(dir);
          updatedFile = true;
        } catch (err) {
          logStructured(null, {
            level: 'error',
            component: 'forensic_logger',
            event: 'forensic_reconcile_file_write_error',
            operation: 'reconcile_write_file',
            result: 'failed',
            errorCode: extractErrorCode(err),
            sanitizedError: sanitizeError(err)
          });
          throw err; // Fail closed: do NOT acknowledge outbox if file write fails!
        }
      }

      // Phase 2: Acknowledge and clear ONLY the outbox items that were confirmed persisted
      let updatedStore = false;
      if (this.store && !this.store.closed) {
        try {
          const persistedIds = new Set(reconciled.map(r => r.id));
          await this.store.update(state => {
            // Re-read/merge at commit time: reconcile's earlier snapshot may be
            // stale because enqueue intentionally does not participate in the
            // file mutex. Never clobber a concurrently settled producer event.
            const merged = new Map();
            for (const entry of Array.isArray(state.forensicLogs) ? state.forensicLogs : []) {
              if (entry && entry.id) merged.set(entry.id, entry);
            }
            for (const entry of reconciled) {
              if (entry && entry.id) merged.set(entry.id, entry);
            }
            state.forensicLogs = Array.from(merged.values())
              .filter(entry => typeof entry.epoch === 'number' && entry.epoch >= cutoff)
              .sort((a, b) => (a.epoch || 0) - (b.epoch || 0));
            if (Array.isArray(state.pendingForensicOutbox)) {
              // Only acknowledge IDs confirmed in the durable file. Pending
              // events absent from this reconciliation remain retryable.
              state.pendingForensicOutbox = state.pendingForensicOutbox.filter(e => !e || !persistedIds.has(e.id));
            }
            return state;
          });
          updatedStore = true;
        } catch (err) {
          if (!this.store?.closed && !/Store is closed/i.test(String(err?.message || ''))) {
            logStructured(null, {
              level: 'error',
              component: 'forensic_logger',
              event: 'forensic_reconcile_store_write_error',
              operation: 'reconcile_write_store',
              result: 'failed',
              errorCode: extractErrorCode(err),
              sanitizedError: sanitizeError(err)
            });
            throw err;
          }
        }
      }

      return {
        reconciled: true,
        totalEntries: reconciled.length,
        storeEntries: storeLogs.length,
        fileEntries: fileLogs.length,
        updatedStore,
        updatedFile
      };
    });
  }

  async _appendDeduplicated(events) {
    if (!this.logFile || !Array.isArray(events) || events.length === 0) return { newlyAppended: 0 };
    return this._withLogLock(async () => {
      const existingIds = new Set();
      try {
        const content = await fsp.readFile(this.logFile, 'utf8');
        for (const line of content.split('\n').filter(Boolean)) {
          try { const parsed = JSON.parse(line); if (parsed && parsed.id) existingIds.add(parsed.id); } catch {}
        }
      } catch (err) { if (err.code !== 'ENOENT') throw err; }
      const unique = [];
      const seen = new Set(existingIds);
      for (const event of events) {
        if (event && event.id && !seen.has(event.id)) { unique.push(event); seen.add(event.id); }
      }
      if (!unique.length) return { newlyAppended: 0 };
      const dir = path.dirname(this.logFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      let prefix = '';
      try {
        const existing = await fsp.readFile(this.logFile, 'utf8');
        if (existing.length > 0 && !existing.endsWith('\n')) prefix = '\n';
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      const handle = await fsp.open(this.logFile, 'a', 0o600);
      try { await handle.write(prefix + unique.map(e => JSON.stringify(e)).join('\n') + '\n'); await handle.sync(); }
      finally { await handle.close(); }
      return { newlyAppended: unique.length };
    });
  }

  async flushOutbox() {
    assertForensicMutationAllowed(this.dataDir, this.logFile);
    if (!this.store || this.store.closed || !this.logFile) return { flushed: 0, newlyAppended: 0 };
    return this._withLogLock(async () => {
      if (this.store.closed) return { flushed: 0, newlyAppended: 0 };
      let state;
      try {
        state = await this.store.load();
      } catch (err) {
        if (this.store?.closed || /Store is closed/i.test(String(err?.message || ''))) {
          return { flushed: 0, newlyAppended: 0 };
        }
        throw err;
      }
      const pending = state.pendingForensicOutbox || [];
      if (!Array.isArray(pending) || pending.length === 0) return { flushed: 0, newlyAppended: 0 };

      const existingIds = new Set();
      let fileNeedsNewline = false;
      try {
        const content = await fsp.readFile(this.logFile, 'utf8');
        if (content.length > 0 && !content.endsWith('\n')) fileNeedsNewline = true;
        for (const line of content.split('\n').filter(Boolean)) {
          try {
            const parsed = JSON.parse(line);
            if (parsed && parsed.id) existingIds.add(parsed.id);
          } catch {}
        }
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }

      const toAppend = pending.filter(e => e && e.id && !existingIds.has(e.id));
      if (toAppend.length > 0) {
        const dir = path.dirname(this.logFile);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const prefix = fileNeedsNewline ? '\n' : '';
        const lines = prefix + toAppend.map(e => JSON.stringify(e)).join('\n') + '\n';
        const fileHandle = await fsp.open(this.logFile, 'a', 0o600);
        try {
          await fileHandle.write(lines);
          await fileHandle.sync();
        } finally {
          await fileHandle.close();
        }
      }

      if (this.store.closed) return { flushed: 0, newlyAppended: toAppend.length };
      const flushedIds = new Set(pending.filter(e => e?.id).map(e => e.id));
      try {
        await this.store.update(s => {
          s.pendingForensicOutbox = (s.pendingForensicOutbox || []).filter(e => e?.id && !flushedIds.has(e.id));
          return s;
        });
      } catch (err) {
        if (this.store?.closed || /Store is closed/i.test(String(err?.message || ''))) {
          return { flushed: 0, newlyAppended: toAppend.length };
        }
        throw err;
      }

      return { flushed: pending.length, newlyAppended: toAppend.length };
    });
  }
}

module.exports = { ForensicLogger, normalizeSubnet, SEVEN_DAYS_MS, BURNED_SUBNET_TTL_MS, getCanonicalProdDataDir, assertForensicMutationAllowed };
