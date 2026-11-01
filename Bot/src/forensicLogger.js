'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const BURNED_SUBNET_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function normalizeSubnet(ip) {
  if (!ip || typeof ip !== 'string') return null;
  const parts = ip.split('/')[0].trim().split('.');
  return parts.length >= 3 ? `${parts[0]}.${parts[1]}.${parts[2]}.0/24` : null;
}

class ForensicLogger {
  constructor({ store, dataDir, maxAgeMs = SEVEN_DAYS_MS, clock = Date.now } = {}) {
    this.store = store || null;
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
      xErrorMessage: event.xErrorMessage ? String(event.xErrorMessage) : null,
      endpoint: event.endpoint ? String(event.endpoint) : null,
      rawResponseSnippet: event.rawResponseSnippet ? String(event.rawResponseSnippet).slice(0, 1000) : null,
      details: event.details || null
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
      } catch {}
    }

    // 2. Persist to JSONL file
    if (this.logFile) {
      try {
        const line = JSON.stringify(record) + '\n';
        await fsp.appendFile(this.logFile, line, { mode: 0o600 });
      } catch {}
    }

    return record;
  }

  async prune(now = typeof this.clock === 'function' ? this.clock() : Date.now()) {
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
      } catch {}
    }

    // Prune JSONL file
    if (this.logFile) {
      try {
        const content = await fsp.readFile(this.logFile, 'utf8').catch(() => '');
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
            } catch {}
          }
          await fsp.writeFile(this.logFile, retained.length ? retained.join('\n') + '\n' : '', { mode: 0o600 });
        }
      } catch {}
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
    } catch {}
    return { prunedCount, cutoff, ttlDays: 30 };
  }

  async query({ accountId, username, eventType, sinceEpoch, limit = 100 } = {}) {
    let logs = [];
    if (this.store) {
      const state = await this.store.load();
      logs = state.forensicLogs || [];
    } else if (this.logFile) {
      const content = await fsp.readFile(this.logFile, 'utf8').catch(() => '');
      logs = content.split('\n').filter(Boolean).map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
    }

    let filtered = logs;
    if (accountId) filtered = filtered.filter(l => l.accountId === accountId);
    if (username) filtered = filtered.filter(l => l.username === username);
    if (eventType) filtered = filtered.filter(l => l.eventType === eventType);
    if (sinceEpoch) filtered = filtered.filter(l => l.epoch >= sinceEpoch);

    return filtered.slice(-limit);
  }
}

module.exports = { ForensicLogger, normalizeSubnet, SEVEN_DAYS_MS, BURNED_SUBNET_TTL_MS };
