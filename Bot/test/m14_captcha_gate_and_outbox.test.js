'use strict';
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { SqliteStore } = require('../src/sqliteStore');
const { settleItem53d0, flushPendingForensicOutbox, SETTLEMENT_TARGET } = require('../scripts/settle_item_53d0f458');
const { buildIsolationMessage } = require('../src/telegramUi');
const { accountRecord } = require('../src/accounts');

describe('M14: Human-Only CAPTCHA Gate & Transactional Outbox Suite', () => {
  let tempDir;
  let testDbPath;
  let testLogPath;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm14-captcha-outbox-'));
    testDbPath = path.join(tempDir, 'state.sqlite');
    testLogPath = path.join(tempDir, 'forensic.jsonl');
  });

  after(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    if (fs.existsSync(testLogPath)) fs.unlinkSync(testLogPath);
  });

  it('1. buildIsolationMessage formats CAPTCHA alert with owner instruction', () => {
    const msg = buildIsolationMessage({ username: 'testuser', reason: 'captcha', otherActiveCount: 2 });
    assert.ok(msg.includes('السبب: تحدي أمني / كابتشا (Security Challenge / CAPTCHA)'));
    assert.ok(msg.includes('حل التحقق من X بنفسك عبر الموقع/التطبيق الرسمي ثم اضغط تم الحل'));
    assert.ok(msg.includes('ومواصلة الدورة عبر بقية الحسابات (2).'));
  });

  it('2. buildIsolationMessage formats auth_session_unverified as unverified cause uncertain', () => {
    const msg = buildIsolationMessage({ username: 'testuser', reason: 'auth_session_unverified', otherActiveCount: 0 });
    assert.ok(msg.includes('جلسة غير مؤكدة / السبب غير محدد (auth_session_unverified)'));
    assert.ok(msg.includes('يرجى فحص الحساب عبر الموقع الرسمي لـ X'));
  });

  it('3. accountRecord marks captcha and unverified accounts as enabled: false', () => {
    const recCaptcha = accountRecord({ id: 'acc1', status: 'كابتشا', enabled: true });
    assert.strictEqual(recCaptcha.enabled, false);
    assert.strictEqual(recCaptcha.status, 'كابتشا');

    const recUnverified = accountRecord({ id: 'acc2', status: 'غير محقق (جلسة غير مؤكدة)', enabled: true });
    assert.strictEqual(recUnverified.enabled, false);
    assert.strictEqual(recUnverified.status, 'غير محقق (جلسة غير مؤكدة)');
  });

  it('4. settleItem53d0 rejects full 64-character SHA-256 mismatch fail-closed', async () => {
    const initial = {
      items: [
        {
          id: SETTLEMENT_TARGET.id,
          state: 'ambiguous',
          payload: { text: 'Altered text with different sha256', account: SETTLEMENT_TARGET.accountId }
        }
      ]
    };
    const store = new SqliteStore(testDbPath, initial);
    await store.load();
    await store.close();

    await assert.rejects(
      () => settleItem53d0({ dbPath: testDbPath, logFilePath: testLogPath, isApply: true }),
      err => {
        assert.ok(err.message.includes('FULL_SHA256_MISMATCH'));
        return true;
      }
    );
  });

  it('5. settleItem53d0 rejects non-ambiguous item state (strict CAS)', async () => {
    const initial = {
      items: [
        {
          id: SETTLEMENT_TARGET.id,
          state: 'pending',
          payload: { text: SETTLEMENT_TARGET.fullText, account: SETTLEMENT_TARGET.accountId }
        }
      ]
    };
    const store = new SqliteStore(testDbPath, initial);
    await store.load();
    await store.close();

    await assert.rejects(
      () => settleItem53d0({ dbPath: testDbPath, logFilePath: testLogPath, isApply: true }),
      err => {
        assert.ok(err.message.includes('INVALID_ITEM_STATE'));
        return true;
      }
    );
  });

  it('6. settleItem53d0 commits outbox event in same SQLite transaction and flushes cleanly', async () => {
    const initial = {
      items: [
        {
          id: SETTLEMENT_TARGET.id,
          state: 'ambiguous',
          payload: { text: SETTLEMENT_TARGET.fullText, account: SETTLEMENT_TARGET.accountId }
        }
      ],
      posting: { quota: { '2026-11-01': { [SETTLEMENT_TARGET.accountId]: 5 } } }
    };
    const store = new SqliteStore(testDbPath, initial);
    await store.load();
    await store.close();

    const res = await settleItem53d0({ dbPath: testDbPath, logFilePath: testLogPath, isApply: true });
    assert.strictEqual(res.settled, true);

    // Verify item transitioned to published
    const finalStore = new SqliteStore(testDbPath);
    const finalState = await finalStore.load();
    const item = finalState.items.find(i => i.id === SETTLEMENT_TARGET.id);
    assert.strictEqual(item.state, 'published');
    assert.strictEqual(item.url, SETTLEMENT_TARGET.url);
    assert.strictEqual(item.settledQuotaCredited, true);

    // Historical quota incremented by 1 (from 5 to 6)
    assert.strictEqual(finalState.posting.quota['2026-11-01'][SETTLEMENT_TARGET.accountId], 6);

    // Outbox flushed cleanly to targetLog
    assert.ok(fs.existsSync(testLogPath));
    const lines = fs.readFileSync(testLogPath, 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 1);
    const logEntry = JSON.parse(lines[0]);
    assert.strictEqual(logEntry.eventType, 'm14_settle_53d0f458_snowflake_published');
    assert.strictEqual(logEntry.details.fullSha256, SETTLEMENT_TARGET.expectedSha256Full);

    // Outbox in SQLite ACKed and cleared
    assert.strictEqual((finalState.pendingForensicOutbox || []).length, 0);
    await finalStore.close();
  });

  it('7. flushPendingForensicOutbox replays unacknowledged events with deduplication', async () => {
    const event1 = { id: 'evt-1', timestamp: new Date().toISOString(), eventType: 'test_event_1' };
    const event2 = { id: 'evt-2', timestamp: new Date().toISOString(), eventType: 'test_event_2' };

    // Seed log with event1 already present
    fs.writeFileSync(testLogPath, JSON.stringify(event1) + '\n');

    // Store has both event1 and event2 in pendingForensicOutbox
    const initial = { pendingForensicOutbox: [event1, event2] };
    const store = new SqliteStore(testDbPath, initial);
    await store.load();

    const flushRes = await flushPendingForensicOutbox(store, testLogPath);
    assert.strictEqual(flushRes.flushed, 2);
    assert.strictEqual(flushRes.newlyAppended, 1); // event1 was skipped as duplicate

    const lines = fs.readFileSync(testLogPath, 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 2); // evt-1 and evt-2, no duplicate evt-1

    const state = await store.load();
    assert.strictEqual(state.pendingForensicOutbox.length, 0); // Outbox cleared
    await store.close();
  });
});
