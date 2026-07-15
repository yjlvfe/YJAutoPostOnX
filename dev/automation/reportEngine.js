// Standalone ReportEngine for xposter Electron project (v2.5.1)
// Pure Node.js (no external dependencies)
"use strict";

const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

/**
 * ReportEngine
 * - Keeps an in-memory buffer of events, post results and timings
 * - Flushes a JSON report and a human-readable TXT summary at the end of a run
 */
class ReportEngine {
  constructor(reportDir) {
    // default path per requirements — uses user config dir for Linux AppImage compatibility
    this.reportDir = reportDir || path.join(os.homedir(), '.config', 'x-poster-bot-profile', 'reports');

    // run state (reinitialized on startRun)
    this.runId = null;
    this.startTime = null;
    this.endTime = null;

    this.stats = { totalPosts: 0, success: 0, failed: 0, unconfirmed: 0, retried: 0, deadLetter: 0, deferred: 0 };
    this.performance = { postTimes: [] };
    this.failures = [];
    this.timeline = [];

    // ensure directory exists (non-blocking in constructor)
    fs.mkdir(this.reportDir, { recursive: true }).catch(() => {
      // best-effort; actual I/O errors will be reported on flush
    });

    // ⏲️ C6: periodic flush timer — writes a partial report every 30s
    // during a run so events survive a crash/force-quit/power-off.
    this._flushTimer = null;
    this._flushIntervalMs = 30000;
    this._eventCount = 0;
    this._flushEveryNEvents = 10;
  }

  // Start a new run: reset buffers and metadata
  startRun() {
    this.runId = crypto.randomUUID();
    this.startTime = new Date().toISOString();
    this.endTime = null;

    // reset in-memory buffers
    this.stats = { totalPosts: 0, success: 0, failed: 0, unconfirmed: 0, retried: 0, deadLetter: 0, deferred: 0 };
    this.performance = { postTimes: [] };
    this.failures = [];
    this.timeline = [];

    // ⏲️ C6: start periodic flush so accumulated events are persisted
    // mid-run — protects against crash/force-quit losing everything.
    this._eventCount = 0;
    this._startPeriodicFlush();
  }

  // ⏲️ C6: Start the periodic flush timer (called by startRun).
  _startPeriodicFlush() {
    this._stopPeriodicFlush();  // never overlap timers
    this._flushTimer = setInterval(() => {
      this._flushPeriodic().catch(() => { /* best-effort */ });
    }, this._flushIntervalMs);
    // unref so the timer never keeps the process alive on exit
    if (this._flushTimer && typeof this._flushTimer.unref === 'function') {
      this._flushTimer.unref();
    }
  }

  // ⏲️ C6: Stop the periodic flush timer (called by endRun).
  _stopPeriodicFlush() {
    if (this._flushTimer) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }
  }

  // ⏲️ C6: Write a partial mid-run report (best-effort, non-fatal).
  async _flushPeriodic() {
    if (this.stats.totalPosts === 0 && this.timeline.length === 0) return;
    const reportJson = this.generateReport();
    const partialId = (this.runId || 'unknown').slice(0, 8);
    const jsonPath = path.join(this.reportDir, `run-partial-${partialId}.json`);
    try {
      await fs.writeFile(jsonPath, JSON.stringify(reportJson, null, 2), 'utf8');
    } catch {
      // best-effort — never crash the run over a partial flush
    }
  }

  // Log an event to the in-memory timeline
  logEvent({ level, event, postId, attempt, message }) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      event,
      postId,
      attempt: typeof attempt === 'number' ? attempt : 0,
      details: message || ''
    };
    this.timeline.push(entry);

    // track retries on certain events
    // Only track retries on explicit RETRY events (not final POST_FAIL which is a terminal event)
    if (typeof event === 'string' && event.includes('RETRY') && !event.includes('POST_FAIL')) {
      this.stats.retried = (this.stats.retried || 0) + 1;
    }

    // ⏲️ C6: count-based flush — every N events, persist a partial report.
    this._eventCount = (this._eventCount || 0) + 1;
    if (this._eventCount >= this._flushEveryNEvents && this._flushTimer) {
      this._eventCount = 0;
      this._flushPeriodic().catch(() => { /* best-effort */ });
    }
  }

  // Record result for a single post action
  recordPostResult({ postId, text, status, attempts, errorType, lastError }) {
    const validStatus = ['success', 'unconfirmed', 'failed', 'dead_letter', 'deferred'];
    const finalStatus = validStatus.includes(status) ? status : 'unconfirmed';
    this.stats.totalPosts = (this.stats.totalPosts || 0) + 1;

    switch (finalStatus) {
      case 'success':
        this.stats.success = (this.stats.success || 0) + 1;
        break;
      case 'unconfirmed':
        this.stats.unconfirmed = (this.stats.unconfirmed || 0) + 1;
        break;
      case 'failed':
        this.stats.failed = (this.stats.failed || 0) + 1;
        break;
      case 'dead_letter':
        this.stats.deadLetter = (this.stats.deadLetter || 0) + 1;
        break;
      case 'deferred':
        this.stats.deferred = (this.stats.deferred || 0) + 1;
        break;
    }

    // Track failures for later reporting (deferred included — it's still a
    // diagnostic-worthy event, just not a permanent one; distinguished from
    // 'failed'/'dead_letter' by finalStatus in the record itself).
    if (finalStatus === 'failed' || finalStatus === 'dead_letter' || finalStatus === 'deferred') {
      const et = ['network', 'selector', 'platform'].includes(errorType) ? errorType : 'unknown';
      this.failures.push({
        postId,
        text,
        attempts,
        errorType: et,
        lastError: (lastError != null) ? lastError : '',
        finalStatus
      });
    }
  }

  // Record how long a post attempt took (ms)
  recordPostTime(durationMs) {
    this.performance.postTimes.push(durationMs);
  }

  // Generate a structured JSON report
  generateReport() {
    const durationSeconds = (() => {
      if (this.startTime && this.endTime) {
        const s = new Date(this.endTime).getTime() - new Date(this.startTime).getTime();
        return Math.max(0, Math.floor(s / 1000));
      }
      return 0;
    })();

    return {
      runId: this.runId,
      startTime: this.startTime,
      endTime: this.endTime,
      durationSeconds,
      "stats": {
        totalPosts: this.stats.totalPosts,
        success: this.stats.success,
        failed: this.stats.failed,
        unconfirmed: this.stats.unconfirmed,
        retried: this.stats.retried,
        deadLetter: this.stats.deadLetter,
        deferred: this.stats.deferred
      },
      performance: {
        avgPostTimeMs: this.performance.postTimes.length > 0
          ? Math.round(this.performance.postTimes.reduce((a, b) => a + b, 0) / this.performance.postTimes.length)
          : 0,
        maxPostTimeMs: this.performance.postTimes.length > 0 ? Math.max(...this.performance.postTimes) : 0,
        minPostTimeMs: this.performance.postTimes.length > 0 ? Math.min(...this.performance.postTimes) : 0
      },
      failures: this.failures,
      timeline: this.timeline
    };
  }

  // Generate a human-readable TXT report from the JSON report
  generateTextReport(reportJson) {
    const formatDuration = (seconds) => {
      if (seconds <= 0) return '0s';
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const secs = seconds % 60;
      if (hours > 0) {
        return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
      }
      if (minutes > 0) {
        return secs > 0 ? `${minutes}m ${secs}s` : `${minutes}m`;
      }
      return `${secs}s`;
    };

    const total = reportJson.stats.totalPosts;
    const success = reportJson.stats.success;
    const failed = reportJson.stats.failed;
    const unconfirmed = reportJson.stats.unconfirmed;
    const retried = reportJson.stats.retried;
    const deadLetter = reportJson.stats.deadLetter;
    const deferred = reportJson.stats.deferred || 0;
    const durationForm = formatDuration(reportJson.durationSeconds);
    // Top failures by errorType
    const counts = {};
    reportJson.failures.forEach(f => {
      const k = f.errorType || 'unknown';
      counts[k] = (counts[k] || 0) + 1;
    });
    const topList = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([etype, count]) => `- ${etype}: ${count}`);

    // Prettify numbers
    const lines = [];
    lines.push('=== XPOSTER RUN REPORT ===');
    lines.push(`Run ID: ${reportJson.runId}`);
    lines.push(`Duration: ${durationForm}`);
    lines.push('');
    lines.push(`Total: ${total}`);
    lines.push(`Success: ${success}`);
    lines.push(`Failed: ${failed}`);
    lines.push(`Unconfirmed: ${unconfirmed}`);
    lines.push(`Retries: ${retried}`);
    lines.push(`Dead-Letter: ${deadLetter}`);
    lines.push(`Deferred (retry next run): ${deferred}`);
    const rate = total > 0 ? ((success / total) * 100).toFixed(2) : '0.00';
    lines.push(`Success Rate: ${rate}%`);
    lines.push('');
    lines.push('Top Failures:');
    if (topList.length > 0) {
      lines.push(...topList);
    } else {
      lines.push('- none');
    }
    lines.push('');
    lines.push('Performance:');
    lines.push(`- Avg: ${reportJson.performance.avgPostTimeMs}ms`);
    lines.push(`- Max: ${reportJson.performance.maxPostTimeMs}ms`);
    lines.push(`- Min: ${reportJson.performance.minPostTimeMs}ms`);
    return lines.join('\n');
  }

  // Persist both JSON and TXT reports safely
  async flushAll() {
    const reportJson = this.generateReport();
    const textReport = this.generateTextReport(reportJson);

    const filenameBase = `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const jsonPath = path.join(this.reportDir, `${filenameBase}.json`);
    const txtPath = path.join(this.reportDir, `${filenameBase}.txt`);

    try {
      await fs.writeFile(jsonPath, JSON.stringify(reportJson, null, 2), 'utf8');
    } catch (err) {
      console.error('ReportEngine flush error (JSON):', err);
      return { success: false, error: err && err.message ? err.message : 'unknown' };
    }

    try {
      await fs.writeFile(txtPath, textReport, 'utf8');
      return { jsonPath, txtPath, success: true };
    } catch (err) {
      console.error('ReportEngine flush error (TXT):', err);
      return { jsonPath, txtPath: null, success: true };
    }
  }

  async endRun() {
    this.endTime = new Date().toISOString();
    // ⏲️ C6: stop the periodic timer + do one final partial flush
    // (then the full report is written by flushAll below).
    this._stopPeriodicFlush();
    await this._flushPeriodic().catch(() => { /* best-effort */ });
    const result = await this.flushAll();
    // 🔒 FIX: delete the partial file for this runId after the final report
    // is written successfully — prevents accumulation of stale partial files.
    if (result && result.success) {
      const partialId = (this.runId || 'unknown').slice(0, 8);
      const partialPath = path.join(this.reportDir, `run-partial-${partialId}.json`);
      try { await fs.unlink(partialPath); } catch { /* file may not exist — ignore */ }
    }
    return result;
  }
}

module.exports = { ReportEngine };
