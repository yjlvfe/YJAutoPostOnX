'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { createTelegramApi, request } = require(path.join(ROOT, 'src/telegramApi'));

describe('Telegram API Polling Timeout Adaptation (FINDING-018)', () => {
  test('dynamically adapts timeoutMs for getUpdates to exceed server long-poll timeout', async () => {
    let capturedMeta = null;
    const mockRequest = (method, params, meta) => {
      capturedMeta = { method, params, meta };
      return { ok: true, result: [] };
    };

    // Case 1: 50s poll timeout -> timeoutMs should be at least (50 + 15) * 1000 = 65_000 ms
    await request('fake-token', 'getUpdates', { timeout: 50 }, { request: mockRequest });
    assert.strictEqual(capturedMeta.meta.timeoutMs, 65_000);

    // Case 2: 25s poll timeout -> timeoutMs should be (25 + 15) * 1000 = 40_000 ms
    await request('fake-token', 'getUpdates', { timeout: 25 }, { request: mockRequest });
    assert.strictEqual(capturedMeta.meta.timeoutMs, 40_000);

    // Case 3: 0s poll timeout -> Math.max(30_000, 15_000) = 30_000 ms
    await request('fake-token', 'getUpdates', { timeout: 0 }, { request: mockRequest });
    assert.strictEqual(capturedMeta.meta.timeoutMs, 30_000);

    // Case 4: explicit options.timeoutMs higher than formula -> Math.max(80_000, 65_000) = 80_000 ms
    await request('fake-token', 'getUpdates', { timeout: 50 }, { timeoutMs: 80_000, request: mockRequest });
    assert.strictEqual(capturedMeta.meta.timeoutMs, 80_000);

    // Case 5: non-getUpdates method (sendMessage) does not apply poll timeout adaptation
    await request('fake-token', 'sendMessage', { chat_id: 123, text: 'hi', timeout: 50 }, { timeoutMs: 10_000, request: mockRequest });
    assert.strictEqual(capturedMeta.meta.timeoutMs, 10_000);
  });

  test('createTelegramApi delegates getUpdates and passes dynamic timeout through HTTP transfer', async () => {
    // Start a real local HTTP server to verify actual socket timeout setup
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        // Return valid Telegram envelope
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result: [{ update_id: 100 }] }));
      });
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const api = createTelegramApi('test-token', { baseUrl });
      const updates = await api.getUpdates({ timeout: 50 });
      assert.strictEqual(Array.isArray(updates), true);
      assert.strictEqual(updates.length, 1);
      assert.strictEqual(updates[0].update_id, 100);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});
