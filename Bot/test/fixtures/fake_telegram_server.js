'use strict';

const http = require('node:http');

class FakeTelegramApi {
  constructor({ botId = 123456789, username = 'yj_test_bot' } = {}) {
    this.botId = botId;
    this.username = username;
    this.nextMessageId = 1000;
    this.nextUpdateId = 1;
    this.calls = [];
    this.messages = [];
    this.documents = [];
    this.edits = [];
    this.callbacks = [];
    this.updatesQueue = [];
    this.files = new Map();
    this.faults = new Map();
    this.chatFaults = new Map();
    this.pollHook = null;
  }

  setFault(method, handlerOrList) {
    if (Array.isArray(handlerOrList)) {
      const queue = [...handlerOrList];
      this.faults.set(method, (params) => (queue.length > 0 ? queue.shift()(params) : null));
    } else {
      this.faults.set(method, handlerOrList);
    }
  }

  setChatFault(chatId, handlerOrList) {
    const key = String(chatId);
    if (Array.isArray(handlerOrList)) {
      const queue = [...handlerOrList];
      this.chatFaults.set(key, (method, params) => (queue.length > 0 ? queue.shift()(method, params) : null));
    } else {
      this.chatFaults.set(key, handlerOrList);
    }
  }

  clearFaults() {
    this.faults.clear();
    this.chatFaults.clear();
  }

  registerFile(fileId, content, filePath = `documents/${fileId}.csv`) {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    this.files.set(fileId, { file_id: fileId, file_path: filePath, file_size: buf.length, buffer: buf });
    this.files.set(filePath, { file_id: fileId, file_path: filePath, file_size: buf.length, buffer: buf });
  }

  pushUpdate(update) {
    const id = update.update_id ?? this.nextUpdateId++;
    this.updatesQueue.push({ ...update, update_id: id });
    return id;
  }

  pushCommand({ chatId = '528864559', userId = '528864559', text = '/start', document = null } = {}) {
    return this.pushUpdate({
      message: {
        message_id: ++this.nextMessageId,
        from: { id: Number(userId), is_bot: false, first_name: 'Owner' },
        chat: { id: Number(chatId), type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text,
        ...(document ? { document } : {})
      }
    });
  }

  pushCallback({ chatId = '528864559', userId = '528864559', messageId = 1001, data = '', callbackId } = {}) {
    return this.pushUpdate({
      callback_query: {
        id: callbackId || `cb_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        from: { id: Number(userId), is_bot: false, first_name: 'Owner' },
        message: {
          message_id: messageId,
          chat: { id: Number(chatId), type: 'private' }
        },
        data
      }
    });
  }

  async _checkFaults(method, params = {}) {
    const chatId = params?.chat_id != null ? String(params.chat_id) : null;
    if (chatId && this.chatFaults.has(chatId)) {
      const fn = this.chatFaults.get(chatId);
      const outcome = await fn(method, params);
      if (outcome !== null && outcome !== undefined) return outcome;
    }
    if (this.faults.has(method)) {
      const fn = this.faults.get(method);
      const outcome = await fn(params);
      if (outcome !== null && outcome !== undefined) return outcome;
    }
    return undefined;
  }

  async getMe() {
    this.calls.push({ method: 'getMe', params: {} });
    const fault = await this._checkFaults('getMe', {});
    if (fault !== undefined) return fault;
    return { id: this.botId, is_bot: true, first_name: 'YJ Test Bot', username: this.username };
  }

  async getUpdates(params = {}) {
    this.calls.push({ method: 'getUpdates', params });
    const fault = await this._checkFaults('getUpdates', params);
    if (fault !== undefined) return fault;
    if (this.pollHook) {
      await this.pollHook(params, this);
    }
    const offset = Number.isInteger(params.offset) ? params.offset : 0;
    const eligible = this.updatesQueue.filter(u => u.update_id >= offset);
    this.updatesQueue = this.updatesQueue.filter(u => u.update_id >= offset);
    const batch = eligible.splice(0, 50);
    this.updatesQueue = this.updatesQueue.filter(u => !batch.some(b => b.update_id === u.update_id));
    return batch;
  }

  async sendMessage(params = {}) {
    this.calls.push({ method: 'sendMessage', params });
    const fault = await this._checkFaults('sendMessage', params);
    if (fault !== undefined) return fault;
    const messageId = ++this.nextMessageId;
    const record = {
      message_id: messageId,
      chat: { id: params.chat_id },
      chat_id: String(params.chat_id),
      text: params.text || '',
      parse_mode: params.parse_mode || null,
      reply_markup: params.reply_markup || null,
      rich_message: params.rich_message || null,
      ok: true
    };
    this.messages.push(record);
    return record;
  }

  async sendRichMessage(params = {}) {
    this.calls.push({ method: 'sendRichMessage', params });
    const fault = await this._checkFaults('sendRichMessage', params);
    if (fault !== undefined) return fault;
    const messageId = ++this.nextMessageId;
    const record = {
      message_id: messageId,
      chat: { id: params.chat_id },
      chat_id: String(params.chat_id),
      text: params.text || params.rich_message?.html || '',
      reply_markup: params.reply_markup || null,
      rich_message: params.rich_message || null,
      ok: true
    };
    this.messages.push(record);
    return record;
  }

  async editMessageText(params = {}) {
    this.calls.push({ method: 'editMessageText', params });
    const fault = await this._checkFaults('editMessageText', params);
    if (fault !== undefined) return fault;
    const record = {
      message_id: params.message_id || ++this.nextMessageId,
      chat: { id: params.chat_id },
      chat_id: String(params.chat_id),
      text: params.text || '',
      parse_mode: params.parse_mode || null,
      reply_markup: params.reply_markup || null,
      ok: true
    };
    this.edits.push(record);
    return record;
  }

  async deleteMessage(params = {}) {
    this.calls.push({ method: 'deleteMessage', params });
    const fault = await this._checkFaults('deleteMessage', params);
    if (fault !== undefined) return fault;
    return true;
  }

  async answerCallbackQuery(params = {}) {
    this.calls.push({ method: 'answerCallbackQuery', params });
    const fault = await this._checkFaults('answerCallbackQuery', params);
    if (fault !== undefined) return fault;
    this.callbacks.push(params);
    return true;
  }

  async sendDocument(params = {}) {
    this.calls.push({ method: 'sendDocument', params });
    const fault = await this._checkFaults('sendDocument', params);
    if (fault !== undefined) return fault;
    const messageId = ++this.nextMessageId;
    const record = {
      message_id: messageId,
      chat: { id: params.chat_id },
      chat_id: String(params.chat_id),
      filename: params.filename,
      content: typeof params.content === 'string' ? params.content : Buffer.from(params.content || '').toString('utf8'),
      ok: true
    };
    this.documents.push(record);
    return record;
  }

  async getFile(params = {}) {
    this.calls.push({ method: 'getFile', params });
    const fault = await this._checkFaults('getFile', params);
    if (fault !== undefined) return fault;
    const entry = this.files.get(params.file_id);
    if (!entry) {
      throw Object.assign(new Error('Telegram file not found'), { code: 'TELEGRAM_API_ERROR', telegramCode: 400 });
    }
    return { file_id: entry.file_id, file_path: entry.file_path, file_size: entry.file_size };
  }

  async downloadFile(filePath, { maxBytes = 2 * 1024 * 1024 } = {}) {
    this.calls.push({ method: 'downloadFile', params: { filePath, maxBytes } });
    const entry = this.files.get(filePath);
    if (!entry) {
      throw Object.assign(new Error('Telegram file download failed'), { code: 'TELEGRAM_FILE_ERROR', statusCode: 404 });
    }
    if (entry.buffer.length > maxBytes) {
      throw Object.assign(new Error('الملف أكبر من الحجم المسموح.'), { code: 'FILE_TOO_LARGE' });
    }
    return entry.buffer;
  }
}

async function startFakeTelegramHttpServer() {
  const requests = [];
  const routeHandlers = new Map();
  let nextMsgId = 2000;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      const rawBody = Buffer.concat(chunks);
      const urlObj = new URL(req.url, 'http://127.0.0.1');
      const parts = urlObj.pathname.split('/').filter(Boolean);
      const isFile = parts[0] === 'file';
      const method = isFile ? `file:${parts.slice(2).join('/')}` : parts[parts.length - 1];
      let parsedBody = null;
      if (!isFile && req.headers['content-type']?.includes('application/json')) {
        try { parsedBody = JSON.parse(rawBody.toString('utf8')); } catch {}
      }
      const reqRecord = { method, url: req.url, headers: req.headers, rawBody, body: parsedBody };
      requests.push(reqRecord);

      if (routeHandlers.has(method)) {
        const handler = routeHandlers.get(method);
        const custom = await handler(reqRecord, res);
        if (custom === true) return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        result: {
          message_id: ++nextMsgId,
          chat: { id: parsedBody?.chat_id || 528864559 }
        }
      }));
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    server,
    baseUrl,
    requests,
    onMethod(method, fn) {
      routeHandlers.set(method, fn);
    },
    async close() {
      await new Promise(resolve => server.close(() => resolve()));
    }
  };
}

module.exports = {
  FakeTelegramApi,
  startFakeTelegramHttpServer
};
