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

    this.stats = { totalPosts: 0, success: 0, failed: 0, unconfirmed: 0, retried: 0, deadLetter: 0 };
    this.performance = { postTimes: [] };
    this.failures = [];
    this.timeline = [];

    // ensure directory exists (non-blocking in constructor)
    fs.mkdir(this.reportDir, { recursive: true }).catch(() => {
      // best-effort; actual I/O errors will be reported on flush
    });
  }

  // Start a new run: reset buffers and metadata
  startRun() {
    this.runId = crypto.randomUUID();
    this.startTime = new Date().toISOString();
    this.endTime = null;

    // reset in-memory buffers
    this.stats = { totalPosts: 0, success: 0, failed: 0, unconfirmed: 0, retried: 0, deadLetter: 0 };
    this.performance = { postTimes: [] };
    this.failures = [];
    this.timeline = [];
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
  }

  // Record result for a single post action
  recordPostResult({ postId, text, status, attempts, errorType, lastError }) {
    const validStatus = ['success', 'unconfirmed', 'failed', 'dead_letter'];
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
    }

    // Track failures for later reporting
    if (finalStatus === 'failed' || finalStatus === 'dead_letter') {
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
        deadLetter: this.stats.deadLetter
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
    return this.flushAll();
  }
}

module.exports = { ReportEngine };
