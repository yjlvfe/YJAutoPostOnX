'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { logStructured, sanitizeError, sanitizeString, sanitizeValue, extractErrorCode } = require('./structuredLogger');

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const BURNED_SUBNET_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

let PROD_DATA_CANONICAL = null;
function getCanonicalProdDataDir() {
  if (!PROD_DATA_CANONICAL) {
    try {
      const prodDir = path.resolve(__dirname, '../data');
      if (fs.existsSync(prodDir)) {
        PROD_DATA_CANONICAL = fs.realpathSync(prodDir);
      } else {
        PROD_DATA_CANONICAL = prodDir;
      }
    } catch {
      PROD_DATA_CANONICAL = path.resolve(__dirname, '../data');
    }
  }
  return PROD_DATA_CANONICAL;
}

function isTestEnvironment() {
  return Boolean(
    process.env.NODE_ENV === 'test' ||
    process.env.NODE_TEST_CONTEXT ||
    process.env.npm_lifecycle_event === 'test' ||
    process.env.YJ_TEST_MODE === '1' ||
    process.argv.some(arg => typeof arg === 'string' && (arg.includes('test') || arg.includes('--test')))
  );
}

function assertForensicMutationAllowed(dataDir) {
  if (isTestEnvironment() && !process.env.ALLOW_PROD_DB_WRITE_IN_TEST) {
    const prodData = getCanonicalProdDataDir();
    if (dataDir && (dataDir === prodData || dataDir.startsWith(prodData + path.sep))) {
      const err = new Error('PROD_FORENSIC_MUTATION_FORBIDDEN_IN_TEST: Tests are strictly forbidden from mutating production forensic logs. Use an isolated temporary dataDir.');
      err.code = 'PROD_FORENSIC_MUTATION_FORBIDDEN_IN_TEST';
      throw err;
    }
  }
}

function normalizeSubnet(ip) {
  if (!ip || typeof ip !== 'string') return null;
  const parts = ip.split('/')[0].trim().split('.');
  return parts.length >= 3 ? `${parts[0]}.${parts[1]}.${parts[2]}.0/24` : null;
}

class ForensicLogger {
  constructor({ store, dataDir, maxAgeMs = SEVEN_DAYS_MS, clock = Date.now } = {}) {
    this.store = store || null;
    this.dataDir = dataDir ? path.resolve(dataDir) : null;
    this.maxAgeMs = maxAgeMs;
    this.clock = clock;
    this.logFile = dataDir ? path.join(dataDir, 'logs', 'forensic.jsonl') : null;
    if (this.logFile) {
      const dir = path.dirname(this.logFile);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  async record(event) {
    const now = typeof this.clock === 'function' ? this.clock() : Date.now();
    const timestamp = new Date(now).toISOString();
    const exitIp = event.exitIp || null;
    const subnet = event.subnet || normalizeSubnet(exitIp);

    const record = {
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

    // 1. Persist to store (state.forensicLogs) with auto-prune
    if (this.store) {
      try {
        await this.store.update(state => {
          state.forensicLogs ||= [];
          state.forensicLogs.push(record);
          const cutoff = now - this.maxAgeMs;
          state.forensicLogs = state.forensicLogs.filter(e => typeof e.epoch === 'number' && e.epoch >= cutoff);
          return state;
        });
      } catch (err) {
        logStructured(null, {
          level: 'error',
          component: 'forensic_logger',
          event: 'forensic_logger_io_error',
          operation: 'store_update',
          result: 'failed',
          errorCode: extractErrorCode(err),
          sanitizedError: sanitizeError(err),
          target: 'store'
        });
      }
    }

    // 2. Persist to JSONL file
    if (this.logFile) {
      assertForensicMutationAllowed(this.dataDir);
      try {
        const line = JSON.stringify(record) + '\n';
        await fsp.appendFile(this.logFile, line, { mode: 0o600 });
      } catch (err) {
        logStructured(null, {
          level: 'error',
          component: 'forensic_logger',
          event: 'forensic_logger_io_error',
          operation: 'file_append',
          result: 'failed',
          errorCode: extractErrorCode(err),
          sanitizedError: sanitizeError(err),
          target: 'file'
        });
      }
    }

    return record;
  }

  async prune(now = typeof this.clock === 'function' ? this.clock() : Date.now()) {
    assertForensicMutationAllowed(this.dataDir);
    const cutoff = now - this.maxAgeMs;
    let prunedCount = 0;

    // Prune in store
    if (this.store) {
      try {
        await this.store.update(state => {
          if (!Array.isArray(state.forensicLogs)) return state;
          const before = state.forensicLogs.length;
          state.forensicLogs = state.forensicLogs.filter(e => typeof e.epoch === 'number' && e.epoch >= cutoff);
          prunedCount += (before - state.forensicLogs.length);
          return state;
        });
      } catch (err) {
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

    // Prune JSONL file
    if (this.logFile) {
      try {
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
          await fsp.writeFile(this.logFile, retained.length ? retained.join('\n') + '\n' : '', { mode: 0o600 });
        }
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
    if (!this.store) return { prunedCount: 0 };
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
    return { prunedCount, cutoff, ttlDays: 30 };
  }

  async query({ accountId, username, eventType, sinceEpoch, limit = 100 } = {}) {
    let logs = [];
    if (this.store) {
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

  async reconcile(now = typeof this.clock === 'function' ? this.clock() : Date.now()) {
    assertForensicMutationAllowed(this.dataDir);
    const cutoff = now - this.maxAgeMs;
    const storeLogs = [];
    if (this.store) {
      try {
        const state = await this.store.load();
        if (Array.isArray(state.forensicLogs)) {
          storeLogs.push(...state.forensicLogs);
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
      }
    }

    const fileLogs = [];
    if (this.logFile) {
      try {
        const content = await fsp.readFile(this.logFile, 'utf8').catch(err => {
          if (err.code !== 'ENOENT') {
            logStructured(null, {
              level: 'warn',
              component: 'forensic_logger',
              event: 'forensic_log_read_failed',
              operation: 'reconcile_readFile',
              result: 'failed',
              errorCode: extractErrorCode(err),
              sanitizedError: sanitizeError(err)
            });
          }
          return '';
        });
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
      }
    }

    const map = new Map();
    for (const log of [...storeLogs, ...fileLogs]) {
      if (!log || !log.id) continue;
      if (typeof log.epoch === 'number' && log.epoch < cutoff) continue;
      map.set(log.id, log);
    }

    const reconciled = Array.from(map.values()).sort((a, b) => (a.epoch || 0) - (b.epoch || 0));

    let updatedStore = false;
    if (this.store) {
      try {
        await this.store.update(state => {
          state.forensicLogs = reconciled;
          return state;
        });
        updatedStore = true;
      } catch (err) {
        logStructured(null, {
          level: 'error',
          component: 'forensic_logger',
          event: 'forensic_reconcile_store_write_error',
          operation: 'reconcile_write_store',
          result: 'failed',
          errorCode: extractErrorCode(err),
          sanitizedError: sanitizeError(err)
        });
      }
    }

    let updatedFile = false;
    if (this.logFile) {
      try {
        const content = reconciled.map(r => JSON.stringify(r)).join('\n') + (reconciled.length ? '\n' : '');
        const tempPath = `${this.logFile}.${crypto.randomUUID()}.tmp`;
        await fsp.writeFile(tempPath, content, { mode: 0o600 });
        await fsp.rename(tempPath, this.logFile);
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
  }
}

module.exports = { ForensicLogger, normalizeSubnet, SEVEN_DAYS_MS, BURNED_SUBNET_TTL_MS, getCanonicalProdDataDir, assertForensicMutationAllowed };
