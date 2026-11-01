'use strict';

const https = require('node:https');
const http = require('node:http');
const { URL } = require('node:url');

function parseTelegramEnvelope(data, method, response) {
  const invalid = () => ({ error: Object.assign(new Error('Telegram API returned invalid response'), {
    code: 'TELEGRAM_INVALID_RESPONSE', ambiguous: true, statusCode: response.statusCode
  }) });
  let parsed;
  try { parsed = JSON.parse(data); } catch (_) { return invalid(); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.ok !== 'boolean'
    || (parsed.ok === true && (!Object.prototype.hasOwnProperty.call(parsed, 'result') || parsed.result === null))) return invalid();
  if (parsed.ok === false) {
    const description = typeof parsed.description === 'string' ? parsed.description : '';
    const error = Object.assign(new Error(`Telegram API ${method} failed${description ? `: ${description}` : ''}`), {
      code: 'TELEGRAM_API_ERROR', statusCode: response.statusCode, telegramCode: parsed.error_code, description, ambiguous: false
    });
    if (parsed.parameters?.retry_after !== undefined) error.retryAfter = parsed.parameters.retry_after;
    console.error(JSON.stringify({ event: 'telegram_api_rejected', method, error_code: parsed.error_code, description }));
    return { error };
  }
  return { result: parsed.result };
}

// One lifecycle owns the complete-request deadline, settlement and stream
// cleanup for ordinary API writes, multipart writes and binary downloads.
function transfer(url, { method = 'POST', body, headers, timeoutMs = 30_000, maxBytes, decode, file = false }) {
  const client = url.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    let response, deadline, settled = false, bytes = 0;
    const chunks = [];
    const uncertain = (message, code) => Object.assign(new Error(message), {
      code, ambiguous: true, ...(response ? { statusCode: response.statusCode } : {})
    });
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      req.removeListener('timeout', onTimeout);
      req.setTimeout?.(0);
      response?.removeListener('data', onData);
      response?.removeListener('end', onEnd);
      response?.removeListener('aborted', onAborted);
      chunks.length = 0;
      // Keep error guards until close: Node may emit error after aborted/destroy.
      if (error) reject(error); else resolve(result);
    };
    const fail = error => {
      if (settled) return;
      finish(error);
      response?.destroy?.();
      req.destroy();
    };
    const onTimeout = () => fail(uncertain(file ? 'Telegram file download timeout' : 'Telegram API timeout', 'TELEGRAM_TIMEOUT'));
    const onRequestError = () => fail(uncertain(file ? 'Telegram file download failed' : 'Telegram API transport failed', file ? 'TELEGRAM_FILE_ERROR' : 'TELEGRAM_TRANSPORT_ERROR'));
    const onAborted = () => fail(uncertain(file ? 'Telegram file transfer aborted' : 'Telegram API response aborted', file ? 'TELEGRAM_FILE_ERROR' : 'TELEGRAM_INVALID_RESPONSE'));
    const onResponseError = () => fail(uncertain(file ? 'Telegram file transfer failed' : 'Telegram API response failed', file ? 'TELEGRAM_FILE_ERROR' : 'TELEGRAM_INVALID_RESPONSE'));
    const onData = chunk => {
      if (settled) return;
      bytes += chunk.length;
      if (maxBytes !== undefined && bytes > maxBytes) {
        return fail(Object.assign(new Error('الملف أكبر من الحجم المسموح.'), { code: 'FILE_TOO_LARGE' }));
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      const { error, result } = decode(Buffer.concat(chunks), response);
      finish(error, result);
    };
    const req = client.request({
      hostname: url.hostname, port: url.port || undefined, path: `${url.pathname}${url.search}`,
      method, headers, timeout: timeoutMs
    }, res => {
      response = res;
      res.on('data', onData);
      res.on('end', onEnd);
      res.on('aborted', onAborted);
      res.on('error', onResponseError);
      res.once('close', () => {
        if (!settled) onAborted();
        res.removeListener('error', onResponseError);
      });
    });
    req.on('timeout', onTimeout);
    req.on('error', onRequestError);
    req.once('close', () => req.removeListener('error', onRequestError));
    // Socket timeouts reset on each chunk; bound the complete response as well.
    if (timeoutMs > 0) deadline = setTimeout(onTimeout, timeoutMs);
    req.end(body);
  });
}

function request(token, method, params = {}, options = {}) {
  if (!token) return Promise.reject(Object.assign(new Error('TELEGRAM_BOT_TOKEN is required'), { code: 'CONFIG_ERROR' }));
  if (typeof options.request === 'function') return Promise.resolve(options.request(method, params));
  const url = new URL(`/bot${encodeURIComponent(token)}/${method}`, options.baseUrl || 'https://api.telegram.org');
  const body = JSON.stringify(params);
  return transfer(url, {
    body, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, timeoutMs: options.timeoutMs,
    decode: (data, response) => parseTelegramEnvelope(data.toString('utf8'), method, response)
  });
}

function createTelegramApi(token, options = {}) {
  if (!token) throw Object.assign(new Error('TELEGRAM_BOT_TOKEN is required'), { code: 'CONFIG_ERROR' });
  let stylesSupported = options.inlineStyles !== false;
  const queues = new Map(); const nextSend = new Map();
  const wait = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const limitedRequest = async (method, params) => {
    for (let attempt = 0; ; attempt++) {
      try { return await request(token, method, params, options); }
      catch (error) {
        if (error.telegramCode !== 429 || !Number.isFinite(error.retryAfter) || error.retryAfter < 0 || error.retryAfter > 60 || attempt >= 2) throw error;
        await wait(Math.max(1, error.retryAfter) * 1000);
      }
    }
  };
  const perform = async (method, params) => {
    const keyboardTypes = ['inline_keyboard', 'keyboard'];
    const styled = keyboardTypes.some(type => params?.reply_markup?.[type]?.some(row => row.some(button => button?.style)));
    const withoutStyles = () => {
      const reply_markup = { ...params.reply_markup };
      for (const type of keyboardTypes) {
        if (!Array.isArray(reply_markup[type])) continue;
        reply_markup[type] = reply_markup[type].map(row => row.map(button => {
          if (!button || typeof button !== 'object') return button;
          const { style, ...plain } = button;
          // Reply labels are exact routing keys; only legacy inline labels
          // need visible glyphs when the API rejects optional button tinting.
          if (type === 'inline_keyboard') plain.text = ({ 'تشغيل': '🟢 تشغيل', 'إيقاف': '🔴 إيقاف', 'تحديث الحالة': '🔄 تحديث الحالة' })[plain.text] || plain.text;
          return plain;
        }));
      }
      return { ...params, reply_markup };
    };
    const payload = styled && !stylesSupported ? withoutStyles() : params;
    try { return await limitedRequest(method, payload); }
    catch (error) {
      // Retry only a definite schema rejection of styling, never a timeout or
      // a generic 400: the first send may otherwise already have landed.
      if (styled && stylesSupported && error.telegramCode === 400 && /style|BUTTON_STYLE|unknown field.*style/i.test(error.message)) {
        stylesSupported = false;
        return limitedRequest(method, withoutStyles());
      }
      throw error;
    }
  };
  const call = (method, params) => {
    // Pace real Telegram chat writes, but keep callback acknowledgements fast.
    if (options.request || options.baseUrl || !['sendMessage', 'sendRichMessage', 'editMessageText'].includes(method)) return perform(method, params);
    const key = String(params.chat_id); const previous = queues.get(key) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const delay = Math.max(0, (nextSend.get(key) || 0) - Date.now());
      if (delay) await wait(delay);
      nextSend.set(key, Date.now() + 1100);
      return perform(method, params);
    });
    queues.set(key, operation);
    return operation.finally(() => { if (queues.get(key) === operation) queues.delete(key); });
  };
  return {
    sendDocument: async ({ chat_id, filename, content }) => {
      const boundary = 'yj-' + require('node:crypto').randomBytes(12).toString('hex');
      const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chat_id}\r\n--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\nContent-Type: text/csv\r\n\r\n`), Buffer.from(content), Buffer.from(`\r\n--${boundary}--\r\n`)]);
      const url = new URL(`/bot${encodeURIComponent(token)}/sendDocument`, options.baseUrl || 'https://api.telegram.org');
      // Never replay multipart sends: a lost response can follow acceptance.
      return transfer(url, {
        body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': body.length }, timeoutMs: options.timeoutMs,
        decode: (data, response) => parseTelegramEnvelope(data.toString('utf8'), 'sendDocument', response)
      });
    },
    getMe: () => call('getMe', {}),
    getUpdates: params => call('getUpdates', params),
    sendRichMessage: params => call('sendRichMessage', params),
    sendMessage: params => {
      if (params.rich_message) return call('sendRichMessage', params);
      return call('sendMessage', params);
    },
    editMessageText: params => call('editMessageText', params),
    deleteMessage: params => call('deleteMessage', params),
    answerCallbackQuery: params => call('answerCallbackQuery', params),
    getFile: params => call('getFile', params),
    downloadFile: async (filePath, { maxBytes = 2 * 1024 * 1024 } = {}) => {
      if (!/^[A-Za-z0-9_./-]+$/.test(String(filePath)) || String(filePath).split('/').includes('..')) throw new Error('Invalid Telegram file path');
      const fileUrl = new URL(`/file/bot${encodeURIComponent(token)}/${String(filePath).replace(/^\/+/, '')}`, options.baseUrl || 'https://api.telegram.org');
      return transfer(fileUrl, {
        method: 'GET', timeoutMs: options.timeoutMs, maxBytes, file: true,
        decode: (data, response) => response.statusCode === 200 ? { result: data } : {
          error: Object.assign(new Error('Telegram file download failed'), {
            code: 'TELEGRAM_FILE_ERROR', statusCode: response.statusCode, ambiguous: false
          })
        }
      });
    }
  };
}

module.exports = { createTelegramApi, request };
