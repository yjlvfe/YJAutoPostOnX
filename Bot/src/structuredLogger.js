'use strict';

/**
 * Structured, Secret-Safe Logger for YJAutoPostOnX Bot.
 * 
 * Provides:
 * 1. Strict closed-schema standard fields:
 *    timestamp, level, component, event, runId, accountId, queueItemId,
 *    attemptId, operation, result, durationMs, errorCode, sanitizedError,
 *    retryCount, suppressionReason.
 * 2. Automatic secret scrubbing (Telegram tokens, cookies, auth headers, passwords).
 * 3. Resilient fallback to process.stderr.write without throwing or infinite loops.
 */

function sanitizeString(str) {
  if (typeof str !== 'string') return '';
  let sanitized = str;
  // 1. Redact Telegram bot tokens
  sanitized = sanitized.replace(/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, '[REDACTED]');
  // 2. Redact Bearer tokens
  sanitized = sanitized.replace(/Bearer\s+[A-Za-z0-9_\-\.]{16,}/gi, 'Bearer [REDACTED]');
  // 3. Redact sensitive key-value pairs
  sanitized = sanitized.replace(/(auth_token|ct0|twid|kdt|password|secret|api[_-]?key|access[_-]?token)([\s:=]+)([^\s,;&"']+)/gi, '$1$2[REDACTED]');
  // 4. Redact JSON-style quoted secret fields embedded INSIDE log messages.
  // The key may be a token/cookie/password field even when serialized as text.
  // This runs before JSON.stringify(record), so the input quotes are not escaped.
  sanitized = sanitized.replace(/(["'])([A-Za-z0-9_-]*(?:token|cookie|password|secret|api[_-]?key|ct0|twid|kdt)[A-Za-z0-9_-]*)\1\s*:\s*(["'])(?:\\.|[^\\])*?\3/gi,
    (_match, quote, key, valueQuote) => quote + key + quote + ':' + valueQuote + '[REDACTED]' + valueQuote);
  // 5. Redact basic auth credentials in URLs
  sanitized = sanitized.replace(/https?:\/\/[^:]+:[^@]+@/g, 'https://[REDACTED]@');
  return sanitized;
}

function sanitizeValue(value, depth = 0) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return sanitizeString(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (depth > 3) return '[DEPTH_EXCEEDED]';
  if (Array.isArray(value)) {
    return value.map(item => sanitizeValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    const cleaned = {};
    for (const [k, v] of Object.entries(value)) {
      if (/token|cookie|password|secret|auth|key/i.test(k) && typeof v === 'string') {
        cleaned[k] = '[REDACTED]';
      } else {
        cleaned[k] = sanitizeValue(v, depth + 1);
      }
    }
    return cleaned;
  }
  return String(value);
}

function sanitizeError(err) {
  if (!err) return null;
  const rawMsg = err.message || (typeof err === 'string' ? err : String(err));
  return sanitizeString(rawMsg);
}

function extractErrorCode(err) {
  if (!err) return null;
  if (typeof err === 'object') {
    return err.code || err.errorCode || err.statusCode || (err.name !== 'Error' ? err.name : null);
  }
  return null;
}

function formatStructuredLog(input = {}) {
  const now = input.timestamp || new Date().toISOString();
  const errorObj = input.error || null;
  const sanitizedErr = input.sanitizedError ?? (errorObj ? sanitizeError(errorObj) : null);
  const errCode = input.errorCode ?? (errorObj ? extractErrorCode(errorObj) : null);

  const record = {
    timestamp: sanitizeString(String(now)),
    level: sanitizeString(String(input.level || 'info')),
    component: input.component ? sanitizeString(String(input.component)) : 'system',
    event: input.event ? sanitizeString(String(input.event)) : 'unknown',
    runId: input.runId != null ? sanitizeString(String(input.runId)) : null,
    accountId: input.accountId != null ? sanitizeString(String(input.accountId)) : null,
    queueItemId: input.queueItemId != null ? sanitizeString(String(input.queueItemId)) : null,
    attemptId: input.attemptId != null ? sanitizeString(String(input.attemptId)) : null,
    operation: input.operation != null ? sanitizeString(String(input.operation)) : null,
    result: input.result != null ? sanitizeString(String(input.result)) : null,
    durationMs: typeof input.durationMs === 'number' && Number.isFinite(input.durationMs) ? input.durationMs : null,
    errorCode: errCode != null ? sanitizeString(String(errCode)) : null,
    sanitizedError: sanitizedErr != null ? sanitizeString(String(sanitizedErr)) : null,
    retryCount: typeof input.retryCount === 'number' && Number.isFinite(input.retryCount) ? input.retryCount : null,
    suppressionReason: input.suppressionReason != null ? sanitizeString(String(input.suppressionReason)) : null
  };

  // Merge extra fields safely (sanitizing strings and objects)
  const standardKeys = new Set([
    'timestamp', 'level', 'component', 'event', 'runId', 'accountId',
    'queueItemId', 'attemptId', 'operation', 'result', 'durationMs',
    'errorCode', 'sanitizedError', 'retryCount', 'suppressionReason', 'error'
  ]);

  for (const [key, val] of Object.entries(input)) {
    if (!standardKeys.has(key)) {
      record[key] = sanitizeValue(val);
    }
  }

  return record;
}

function safeWriteStderr(jsonStr) {
  try {
    process.stderr.write(jsonStr + '\n');
  } catch (_) {
    // Ultimate boundary: never crash if stderr is closed or broken
  }
}

function logStructured(logger, input) {
  const record = formatStructuredLog(input);
  let json;
  try {
    json = JSON.stringify(record);
  } catch (err) {
    json = JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'error',
      component: 'structured_logger',
      event: 'serialization_failed',
      errorCode: 'JSON_ERROR',
      sanitizedError: sanitizeString(err.message)
    });
  }

  if (!logger) {
    safeWriteStderr(json);
    return record;
  }

  try {
    if (record.level === 'error' && typeof logger.error === 'function') {
      logger.error(json);
      return record;
    }
    if (record.level === 'warn' && typeof logger.warn === 'function') {
      logger.warn(json);
      return record;
    }
    if (typeof logger.log === 'function') {
      logger.log(json);
      return record;
    }
    if (typeof logger.info === 'function') {
      logger.info(json);
      return record;
    }
    if (typeof logger === 'function') {
      logger(json);
      return record;
    }
    safeWriteStderr(json);
  } catch (_) {
    // Resilience rule: fallback safely to process.stderr.write without loops
    safeWriteStderr(json);
  }

  return record;
}

function createStructuredLogger(component, { logger = console, defaultContext = {} } = {}) {
  return {
    component,
    log(event, data = {}) {
      return logStructured(logger, { ...defaultContext, ...data, component, event, level: data.level || 'info' });
    },
    info(event, data = {}) {
      return logStructured(logger, { ...defaultContext, ...data, component, event, level: 'info' });
    },
    warn(event, data = {}) {
      return logStructured(logger, { ...defaultContext, ...data, component, event, level: 'warn' });
    },
    error(event, data = {}) {
      return logStructured(logger, { ...defaultContext, ...data, component, event, level: 'error' });
    },
    suppress(event, suppressionReason, data = {}) {
      return logStructured(logger, {
        ...defaultContext,
        ...data,
        component,
        event,
        level: data.level || 'info',
        result: data.result || 'suppressed',
        suppressionReason
      });
    }
  };
}

module.exports = {
  sanitizeString,
  sanitizeError,
  sanitizeValue,
  extractErrorCode,
  formatStructuredLog,
  logStructured,
  createStructuredLogger
};
