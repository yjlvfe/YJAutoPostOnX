const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { TelegramUi } = require('../src/telegramUi');

describe('Telegram UI Multi-Chat Panel Resilience and Logging', () => {
  it('updates panels across multiple chats using allSettled even if one fails', async () => {
    const edits = [];
    const mockTransport = {
      editMessageText: async (chatId, messageId, text, extra) => {
        edits.push({ chatId: String(chatId), messageId, text });
        if (String(chatId) === '5535435580') {
          // Simulate transient timeout on second chat
          const err = new Error('Telegram API timeout');
          err.code = 'TELEGRAM_TIMEOUT';
          throw err;
        }
        return { ok: true };
      },
      sendMessage: async () => ({ message_id: 9999 }),
      keyboard: () => ({ inline_keyboard: [] })
    };

    const mockStore = {
      state: {
        cycle: { state: 'running', runId: 'test-run-123' },
        telegramUi: {
          activePanelsByChatId: {
            '528864559': { messageId: 1570, chatId: 528864559, token: 'tok1' },
            '5535435580': { messageId: 1291, chatId: 5535435580, token: 'tok2' }
          },
          dashboards: {
            '528864559': { messageId: 1570, chatId: 528864559, token: 'tok1' },
            '5535435580': { messageId: 1291, chatId: 5535435580, token: 'tok2' }
          }
        }
      },
      load: async function() { return structuredClone(this.state); },
      update: async function(fn) {
        this.state = fn(structuredClone(this.state));
        return structuredClone(this.state);
      }
    };

    const loggedEvents = [];
    const mockLogger = {
      info: msg => { try { loggedEvents.push(JSON.parse(msg)); } catch {} },
      warn: msg => { try { loggedEvents.push(JSON.parse(msg)); } catch {} },
      error: msg => { try { loggedEvents.push(JSON.parse(msg)); } catch {} }
    };

    const ui = new TelegramUi({
      bot: {
        store: mockStore,
        transport: mockTransport,
        logger: mockLogger
      }
    });

    // Run execute refresh panels
    await ui._executeRefreshPanels(true);

    // Both chats were attempted
    assert.strictEqual(edits.length, 2);
    const chats = edits.map(e => e.chatId).sort();
    assert.deepStrictEqual(chats, ['528864559', '5535435580']);

    // Check structured log events
    const attempts = loggedEvents.filter(e => e.event === 'panel_edit_attempt');
    assert.strictEqual(attempts.length, 2);
    const successes = loggedEvents.filter(e => e.event === 'panel_edit_success');
    assert.strictEqual(successes.length, 1);
    assert.strictEqual(successes[0].chatId, '528864559');
    const failures = loggedEvents.filter(e => e.event === 'panel_edit_failed');
    assert.strictEqual(failures.length, 1);
    assert.strictEqual(failures[0].chatId, '5535435580');
    assert.strictEqual(failures[0].errorCode, 'TELEGRAM_TIMEOUT');
  });
});
