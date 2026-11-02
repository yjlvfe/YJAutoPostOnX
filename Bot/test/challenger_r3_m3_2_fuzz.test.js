'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const { createLinkExports, dayOf, csv } = require(path.join(ROOT, 'src/linkExports'));
const {
  TelegramUi,
  MAX_ACTIVE_ACCOUNTS,
  ISOLATION_REASONS,
  formatIsolationReason,
  buildIsolationMessage
} = require(path.join(ROOT, 'src/telegramUi'));
const {
  SingleInstanceLock,
  isConflict409,
  executeWithConflictBackoff
} = require(path.join(ROOT, 'src/singleInstance'));
const { SqliteStore } = require(path.join(ROOT, 'src/sqliteStore'));

function createMockTelegramApi() {
  const sentDocuments = [];
  const sentMessages = [];
  return {
    sentDocuments,
    sentMessages,
    getMe: async () => ({ id: 1, is_bot: true, username: 'challenger2_bot' }),
    sendMessage: async (arg1, arg2) => {
      const text = typeof arg1 === 'object' && arg1 ? arg1.text : arg2;
      const chatId = typeof arg1 === 'object' && arg1 ? arg1.chat_id : arg1;
      sentMessages.push({ chatId, text });
      return { message_id: Math.floor(Math.random() * 100000) + 1 };
    },
    sendDocument: async (payload) => {
      sentDocuments.push(payload);
      return { message_id: Math.floor(Math.random() * 100000) + 1 };
    },
    editMessageText: async () => ({ message_id: 1 }),
    deleteMessage: async () => {},
    answerCallbackQuery: async () => {},
    getUpdates: async () => []
  };
}

describe('Challenger M3-2: Empirical Concurrency Fuzzing & Adversarial Stress Suite', () => {

  // =========================================================================
  // SECTION 1: SINGLE INSTANCE LOCK CONCURRENT CONTENTION & DEAD PID RECOVERY
  // =========================================================================
  describe('1. SingleInstanceLock Concurrent Contention & Stale PID Recovery Fuzzing', () => {

    test('1.1 Thundering Herd: 25 concurrent contenders race on a dead PID lock; exactly 1 acquires without leaks or crashes', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'challenger2-thundering-herd-'));
      const lockPath = path.join(tempDir, 'runner.lock');

      // Seed a simulated dead process (PID 999998 does not exist)
      const deadPid = 999998;
      try { process.kill(deadPid, 0); assert.fail('PID 999998 unexpectedly alive'); } catch (e) { assert.strictEqual(e.code, 'ESRCH'); }
      fs.writeFileSync(lockPath, JSON.stringify({
        pid: deadPid,
        token: 'dead-pid-token-111',
        acquiredAt: new Date(Date.now() - 60_000).toISOString()
      }) + '\n');

      // Spawn 25 concurrent lock contenders
      const contenderCount = 25;
      const contenders = Array.from({ length: contenderCount }, (_, i) => {
        return new SingleInstanceLock(lockPath, {
          timeoutMs: 2500,
          retryMs: 15 + (i % 5) * 5
        });
      });

      const acquirePromises = contenders.map(c => c.acquire());
      const results = await Promise.allSettled(acquirePromises);

      const fulfilled = results.filter(r => r.status === 'fulfilled');
      const rejected = results.filter(r => r.status === 'rejected');

      // Verify at least one contender acquired the lock
      assert.ok(fulfilled.length >= 1, `At least 1 contender acquired lock (got ${fulfilled.length})`);

      // Verify strict mutual exclusion: at any exact moment, exactly 1 contender has this.locked === true
      const currentlyLocked = contenders.filter(c => c.locked);
      assert.strictEqual(currentlyLocked.length, 1, `Strict mutual exclusion: exactly 1 holder (got ${currentlyLocked.length})`);

      // Verify disk state
      const lockData = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      assert.strictEqual(lockData.pid, process.pid, 'Lockfile PID is current process');
      assert.strictEqual(lockData.token, currentlyLocked[0].token, 'Lockfile token matches active holder');

      // Verify no orphaned stale lockfiles were left in the directory
      const remainingFiles = fs.readdirSync(tempDir);
      const staleOrphans = remainingFiles.filter(f => f.includes('.stale.'));
      assert.strictEqual(staleOrphans.length, 0, `No orphaned .stale.* files left on disk: ${staleOrphans.join(', ')}`);

      // Release acquired lock
      for (const res of fulfilled) {
        if (typeof res.value === 'function') await res.value();
      }

      // Verify clean release
      assert.strictEqual(fs.existsSync(lockPath), false, 'Lockfile cleanly deleted after release');

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('1.2 Rapid Crash Churn Fuzzing: 10 consecutive rounds of dead PID simulation under multi-contender race', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'challenger2-crash-churn-'));
      const lockPath = path.join(tempDir, 'runner.lock');

      const deadPid = 999997;
      try { process.kill(deadPid, 0); } catch (e) { assert.strictEqual(e.code, 'ESRCH'); }

      const rounds = 10;
      for (let round = 1; round <= rounds; round++) {
        // Write dead PID lockfile
        fs.writeFileSync(lockPath, JSON.stringify({
          pid: deadPid,
          token: `churn-token-round-${round}`,
          acquiredAt: new Date().toISOString()
        }) + '\n');

        // 8 concurrent contenders race with short timeout
        const contenders = Array.from({ length: 8 }, () => new SingleInstanceLock(lockPath, {
          timeoutMs: 100,
          retryMs: 10
        }));

        const results = await Promise.allSettled(contenders.map(c => c.acquire()));
        const winners = results.filter(r => r.status === 'fulfilled');
        assert.ok(winners.length >= 1, `Round ${round}: At least 1 contender won`);

        // Clean release
        for (const w of winners) {
          if (typeof w.value === 'function') await w.value();
        }
      }

      // Verify no stale file leakage across 10 rounds
      const files = fs.readdirSync(tempDir);
      const staleFiles = files.filter(f => f.includes('.stale.'));
      assert.strictEqual(staleFiles.length, 0, 'Zero orphaned stale files across 10 rounds');

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('1.3 Dead PID edge cases: truncated 0-byte, invalid JSON, and non-numeric PID recovery', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'challenger2-edge-lock-'));
      const lockPath = path.join(tempDir, 'runner.lock');

      // Case A: 0-byte lockfile with stale mtime (> staleMs)
      fs.writeFileSync(lockPath, '');
      const pastTime = (Date.now() - 200_000) / 1000;
      fs.utimesSync(lockPath, pastTime, pastTime);

      const lockA = new SingleInstanceLock(lockPath, { staleMs: 100_000, timeoutMs: 500 });
      const releaseA = await lockA.acquire();
      assert.strictEqual(lockA.locked, true, 'Acquired lock after 0-byte stale lockfile');
      await releaseA();

      // Case B: Corrupted/Half-written JSON with stale mtime
      fs.writeFileSync(lockPath, '{"pid": 999999, "token": "incompl');
      fs.utimesSync(lockPath, pastTime, pastTime);

      const lockB = new SingleInstanceLock(lockPath, { staleMs: 100_000, timeoutMs: 500 });
      const releaseB = await lockB.acquire();
      assert.strictEqual(lockB.locked, true, 'Acquired lock after corrupted JSON stale lockfile');
      await releaseB();

      // Case C: Simulated dead process with valid positive integer PID
      const deadPid = 999995;
      try { process.kill(deadPid, 0); } catch (e) { assert.strictEqual(e.code, 'ESRCH'); }
      fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid, token: 'tok-dead-995' }));

      const lockC = new SingleInstanceLock(lockPath, { timeoutMs: 500 });
      const releaseC = await lockC.acquire();
      assert.strictEqual(lockC.locked, true, 'Acquired lock immediately after dead PID via ESRCH');
      await releaseC();

      // Case D: Non-numeric / String PID (e.g. "not_a_number"):
      // Verifies the exact boundary behavior where non-integer PID does not trigger ESRCH dead PID check
      fs.writeFileSync(lockPath, JSON.stringify({ pid: 'not_a_number', token: 'tok-str' }));
      const lockD = new SingleInstanceLock(lockPath, { timeoutMs: 100 });
      await assert.rejects(
        async () => { await lockD.acquire(); },
        err => {
          assert.strictEqual(err.code, 'INSTANCE_LOCKED');
          return true;
        }
      );

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('1.4 Stale recovery token mismatch fence: aborts stale recovery if token was replaced mid-flight', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'challenger2-token-mismatch-'));
      const lockPath = path.join(tempDir, 'runner.lock');

      const deadPid = 999996;
      const initialToken = 'token-original-stale';
      fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid, token: initialToken }));

      const lock = new SingleInstanceLock(lockPath);

      // Hook into fs.rename to simulate another process replacing the lock right after rename
      const origRename = fs.promises.rename;
      let renameIntercepted = false;

      fs.promises.rename = async (oldPath, newPath) => {
        const result = await origRename(oldPath, newPath);
        if (oldPath === lockPath && newPath.includes('.stale.') && !renameIntercepted) {
          renameIntercepted = true;
          // Overwrite the moved stale file with a DIFFERENT token (simulating concurrent overwrite race)
          await fs.promises.writeFile(newPath, JSON.stringify({ pid: deadPid, token: 'token-different-raced' }));
        }
        return result;
      };

      try {
        const recovered = await lock.recoverStale();
        // Since the moved token didn't match initialToken, recoverStale must return false and restore lockfile!
        assert.strictEqual(recovered, false, 'recoverStale must abort when moved token does not match');
        assert.ok(fs.existsSync(lockPath), 'Lockfile must be restored on token mismatch');
      } finally {
        fs.promises.rename = origRename;
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    test('1.5 409 Conflict backoff with jitter boundary & max retry exhaustion', async () => {
      const lock = new SingleInstanceLock('/tmp/test-409.lock', {
        maxConflictRetries: 3,
        initialBackoffMs: 20,
        maxBackoffMs: 100
      });

      const logs = [];
      const sleepTimes = [];
      const mockLogger = { error: msg => logs.push(msg) };
      const mockSleep = async ms => { sleepTimes.push(ms); };

      const conflictErr = new Error('409 Conflict');
      conflictErr.telegramCode = 409;

      // Retry 1:
      const res1 = await lock.handleConflict409({
        error: conflictErr,
        retryCount: 0,
        logger: mockLogger,
        sleepFn: mockSleep
      });
      assert.strictEqual(res1.shouldRetry, true);
      assert.strictEqual(res1.retryCount, 1);
      assert.ok(res1.backoffMs >= 20 && res1.backoffMs <= 25);

      // Retry 2:
      const res2 = await lock.handleConflict409({
        error: conflictErr,
        retryCount: 1,
        logger: mockLogger,
        sleepFn: mockSleep
      });
      assert.strictEqual(res2.shouldRetry, true);
      assert.strictEqual(res2.retryCount, 2);
      assert.ok(res2.backoffMs >= 40 && res2.backoffMs <= 50);

      // Retry 3:
      const res3 = await lock.handleConflict409({
        error: conflictErr,
        retryCount: 2,
        logger: mockLogger,
        sleepFn: mockSleep
      });
      assert.strictEqual(res3.shouldRetry, true);
      assert.strictEqual(res3.retryCount, 3);
      assert.ok(res3.backoffMs >= 80 && res3.backoffMs <= 100);

      // Retry 4 (Exhausted at maxConflictRetries = 3):
      const res4 = await lock.handleConflict409({
        error: conflictErr,
        retryCount: 3,
        logger: mockLogger,
        sleepFn: mockSleep
      });
      assert.strictEqual(res4.shouldRetry, false, 'Retry exhausted at limit');
      assert.ok(logs.some(l => l.includes('telegram_conflict_exhausted')));
    });
  });

  // =========================================================================
  // SECTION 2: DUAL-LAYER CSV DEDUPLICATION & DAILY ROW SHIFTS
  // =========================================================================
  describe('2. Dual-Layer CSV Deduplication & Daily Row Shifts Under Midnight Rollover', () => {

    test('2.1 Midnight Rollover: Day 1 terminal export delivered; Day 2 zero-row cycle suppressed without resending Day 1', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'challenger2-csv-midnight-'));
      const dbPath = path.join(tempDir, 'state.sqlite');

      // Day 1: 2026-11-02 23:50:00 Riyadh (20:50:00 UTC)
      const day1Utc = new Date('2026-11-02T20:50:00.000Z');
      const day1Str = dayOf(day1Utc);
      assert.strictEqual(day1Str, '2026-11-02');

      const items = [
        { id: 'item-d1-1', state: 'published', url: 'https://x.com/status/901', publishedAt: day1Utc.toISOString(), payload: { text: 'Day 1 Post' } }
      ];

      const store = new SqliteStore(dbPath, { items, accounts: [{ id: 'acc-1', username: 'user1', enabled: true }] });
      await store.load();

      const api = createMockTelegramApi();
      const logs = [];
      let currentClock = day1Utc;
      const links = createLinkExports({
        store,
        dataDir: tempDir,
        api,
        chatId: '444555',
        logger: { log: msg => logs.push(msg), error: () => {} },
        clock: () => currentClock
      });

      // 1. Terminal export on Day 1: Delivered
      await links.send({ runId: 'run-day1', endedAt: day1Utc.toISOString(), itemIds: ['item-d1-1'] }, { terminal: true });
      assert.strictEqual(api.sentDocuments.length, 1, 'Day 1 CSV delivered');
      assert.strictEqual(api.sentDocuments[0].filename, 'links_2026-11-02.csv');

      // 2. Advance clock across midnight to Day 2: 2026-11-03 00:15:00 Riyadh (21:15:00 UTC)
      const day2Utc = new Date('2026-11-02T21:15:00.000Z');
      const day2Str = dayOf(day2Utc);
      assert.strictEqual(day2Str, '2026-11-03');
      currentClock = day2Utc;

      // 3. Cycle stops on Day 2 with NO new posts published on Day 2 yet: MUST BE SUPPRESSED (empty_rows)
      await links.send({ runId: 'run-day2-empty', endedAt: day2Utc.toISOString(), itemIds: [] }, { terminal: true });
      assert.strictEqual(api.sentDocuments.length, 1, 'Day 2 empty cycle must NOT send empty CSV or retransmit Day 1');

      const state1 = await store.load();
      const day2EmptyEvent = state1.linkTerminalEvents.find(e => e.runId === 'run-day2-empty');
      assert.ok(day2EmptyEvent);
      assert.strictEqual(day2EmptyEvent.reconciled, true);
      assert.strictEqual(day2EmptyEvent.reason, 'empty_rows');

      // 4. Publish 1 new post on Day 2
      await store.update(s => {
        s.items.push({
          id: 'item-d2-1',
          state: 'published',
          url: 'https://x.com/status/902',
          publishedAt: day2Utc.toISOString(),
          payload: { text: 'Day 2 Post' }
        });
        return s;
      });

      // 5. Cycle stops on Day 2: Delivered for Day 2 only!
      await links.send({ runId: 'run-day2-active', endedAt: day2Utc.toISOString(), itemIds: ['item-d2-1'] }, { terminal: true });
      assert.strictEqual(api.sentDocuments.length, 2, 'Day 2 active cycle delivers Day 2 CSV');
      assert.strictEqual(api.sentDocuments[1].filename, 'links_2026-11-03.csv');
      assert.ok(api.sentDocuments[1].content.includes('https://x.com/status/902'));
      assert.ok(!api.sentDocuments[1].content.includes('https://x.com/status/901'), 'Day 2 CSV must NOT contain Day 1 items');

      // 6. Cycle stops AGAIN on Day 2 with 0 new items: MUST BE SUPPRESSED
      const day2LaterUtc = new Date('2026-11-02T21:30:00.000Z');
      currentClock = day2LaterUtc;
      await links.send({ runId: 'run-day2-dup', endedAt: day2LaterUtc.toISOString(), itemIds: [] }, { terminal: true });
      assert.strictEqual(api.sentDocuments.length, 2, 'Duplicate cycle stop on Day 2 must be suppressed');

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('2.2 Dual-Layer Collision Resistance: Hash deduplication suppresses duplicate CSV even with altered runId/item order', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'challenger2-csv-hash-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const now = new Date('2026-11-02T12:00:00.000Z');
      const day = dayOf(now);

      const items = [
        { id: 'item-b', state: 'published', url: 'https://x.com/status/200', publishedAt: new Date(now.getTime() + 1000).toISOString(), payload: { text: 'B' } },
        { id: 'item-a', state: 'published', url: 'https://x.com/status/100', publishedAt: now.toISOString(), payload: { text: 'A' } }
      ];

      const store = new SqliteStore(dbPath, { items, accounts: [{ id: 'acc-1', username: 'trader1', enabled: true }] });
      await store.load();

      const api = createMockTelegramApi();
      const links = createLinkExports({ store, dataDir: tempDir, api, chatId: '777888', clock: () => now });

      // Run 1: Sends [item-a, item-b] (dailyRows sorts deterministically by publishedAt)
      await links.send({ runId: 'run-order-1', endedAt: now.toISOString(), itemIds: ['item-a', 'item-b'] }, { terminal: true });
      assert.strictEqual(api.sentDocuments.length, 1);

      // Run 2: Triggered with reversed itemIds array: ['item-b', 'item-a']
      // dailyRows deterministic sort ensures identical CSV content and identical SHA-256 hash!
      await links.send({ runId: 'run-order-2', endedAt: now.toISOString(), itemIds: ['item-b', 'item-a'] }, { terminal: true });
      assert.strictEqual(api.sentDocuments.length, 1, 'Suppressed by deterministic row ordering and dual-layer hash match');

      const state = await store.load();
      const run2Event = state.linkTerminalEvents.find(e => e.runId === 'run-order-2');
      assert.strictEqual(run2Event.suppressed, true);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('2.3 Secondary delivery fence in deliver(): duplicate hash delivered in concurrent race is suppressed before Telegram API call', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'challenger2-csv-secondary-fence-'));
      const dbPath = path.join(tempDir, 'state.sqlite');
      const now = new Date('2026-11-02T14:00:00.000Z');
      const day = dayOf(now);

      const rows = [
        { id: 'item-fence-1', state: 'published', url: 'https://x.com/status/300', publishedAt: now.toISOString(), payload: { text: 'Fence test' } }
      ];
      const csvContent = csv(rows);
      const contentHash = crypto.createHash('sha256').update(csvContent).digest('hex');

      // Pre-populate an outbox entry with pending status, AND a successful delivery with identical contentHash
      const outboxId = 'outbox-racing-entry';
      const store = new SqliteStore(dbPath, {
        items: rows,
        linkOutbox: [{
          outboxId,
          runId: 'run-raced',
          day,
          kind: 'document',
          chatId: '999111',
          itemIds: ['item-fence-1'],
          rows,
          contentHash,
          status: 'pending',
          attempts: 0,
          createdAt: now.toISOString()
        }],
        linkDeliveries: [{
          deliveryId: 'del-prior-success',
          outboxId: 'outbox-prior',
          runId: 'run-prior',
          day,
          kind: 'document',
          chatId: '999111',
          itemIds: ['item-fence-1'],
          contentHash,
          attempted: true,
          ok: true,
          attemptedAt: now.toISOString(),
          deliveredAt: now.toISOString(),
          messageId: 88888
        }]
      });
      await store.load();

      const api = createMockTelegramApi();
      const logs = [];
      const links = createLinkExports({
        store,
        dataDir: tempDir,
        api,
        chatId: '999111',
        logger: { log: msg => logs.push(msg), error: () => {} },
        clock: () => now
      });

      // Calling flush() to deliver pending outbox items
      await links.flush();

      // Secondary fence must suppress api.sendDocument call!
      assert.strictEqual(api.sentDocuments.length, 0, 'Zero API calls made; secondary delivery fence caught duplicate hash');

      const state = await store.load();
      const outboxEntry = state.linkOutbox.find(r => r.outboxId === outboxId);
      assert.strictEqual(outboxEntry.status, 'delivered', 'Outbox entry marked delivered');

      const suppressionLog = logs.find(l => l.includes('telegram_document_delivery_suppressed'));
      assert.ok(suppressionLog, 'Logged telegram_document_delivery_suppressed');

      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });

  // =========================================================================
  // SECTION 3: THROTTLED STALL NOTIFICATIONS UNDER OSCILLATING ELIGIBILITY
  // =========================================================================
  describe('3. Throttled Stall Notifications & Strike Progression Under Oscillating Eligibility', () => {

    test('3.1 Oscillating account eligibility: 10 alternating stall/active transitions emit exactly 1 alert per stall cycle', async () => {
      const notifications = [];
      const mockNotify = async msg => { notifications.push(msg); };
      const ui = new TelegramUi({ bot: {}, notify: mockNotify });

      let stallAlertCount = 0;

      // 10 cycles of oscillating eligibility:
      // In each cycle: Stall -> Repeated Stall checks -> Recovery (resetQueueStall) -> Active operation
      for (let cycle = 1; cycle <= 10; cycle++) {
        // Step A: Stall detected on pass 1 of this cycle -> MUST NOTIFY
        const res1 = await ui.sendQueueStallAlert();
        assert.strictEqual(res1.notified, true, `Cycle ${cycle}: Initial stall pass notifies`);
        stallAlertCount++;

        // Step B: Loop continues in stall state for 5 rapid passes -> ALL THROTTLED
        for (let pass = 2; pass <= 6; pass++) {
          const resThrottled = await ui.sendQueueStallAlert();
          assert.strictEqual(resThrottled.notified, false, `Cycle ${cycle} pass ${pass}: Throttled`);
          assert.strictEqual(resThrottled.throttled, true);
        }

        // Verify total notification count is exactly stallAlertCount so far
        assert.strictEqual(
          notifications.filter(n => n.includes('جميع الحسابات غير مؤهلة')).length,
          stallAlertCount,
          `Cycle ${cycle}: Notification count matches stall cycles`
        );

        // Step C: Account recovers / new post processed -> Queue stall state resets
        ui.resetQueueStall();
      }

      assert.strictEqual(stallAlertCount, 10, 'Exactly 10 stall notifications across 10 oscillation cycles');
      assert.strictEqual(
        notifications.filter(n => n.includes('جميع الحسابات غير مؤهلة')).length,
        10,
        'Raw notify received exactly 10 stall alerts without spam'
      );
    });

    test('3.2 Oscillating transient strikes: strikes 1 and 2 reset on success, 0 alerts until 3 consecutive strikes isolate', async () => {
      const notifications = [];
      const mockNotify = async msg => { notifications.push(msg); };
      const ui = new TelegramUi({ bot: {}, notify: mockNotify });

      const account = { id: 'acc-oscillating', username: 'volatile_trader' };

      // Phase 1: Strike 1 -> Suppressed
      const s1 = await ui.notifyStrike({ account, strikeNumber: 1 });
      assert.strictEqual(s1.suppressed, true);
      assert.strictEqual(notifications.length, 0);

      // Phase 2: Success on turn 2 -> Strikes reset back to 0 (internally by runner)
      // Phase 3: Strike 1 again -> Suppressed
      const s2 = await ui.notifyStrike({ account, strikeNumber: 1 });
      assert.strictEqual(s2.suppressed, true);
      assert.strictEqual(notifications.length, 0);

      // Phase 4: Strike 2 -> Suppressed
      const s3 = await ui.notifyStrike({ account, strikeNumber: 2 });
      assert.strictEqual(s3.suppressed, true);
      assert.strictEqual(notifications.length, 0);

      // Phase 5: Strike 3 -> Single clear isolation notification emitted!
      const s4 = await ui.notifyStrike({
        account,
        strikeNumber: 3,
        reason: '3_failures',
        otherActiveCount: 3
      });
      assert.strictEqual(s4.notified, true);
      assert.strictEqual(notifications.length, 1);
      assert.ok(notifications[0].includes('@volatile_trader'));
      assert.ok(notifications[0].includes('السبب: تجاوز 3 إخفاقات طبيعية'));
      assert.ok(notifications[0].includes('ومواصلة الدورة عبر بقية الحسابات (3)'));
    });

    test('3.3 Wrapped ui.notify diagnostic normalization & spam fence under chaotic direct invocation', async () => {
      const notifications = [];
      const mockNotify = async msg => { notifications.push(msg); };
      const ui = new TelegramUi({ bot: {}, notify: mockNotify });

      // 1. Send 15 duplicate queue stall messages directly to ui.notify
      for (let i = 0; i < 15; i++) {
        await ui.notify('جميع الحسابات غير مؤهلة أو في فترة انتظار؛ توقفت الدورة وبقيت المنشورات في الانتظار.');
      }
      assert.strictEqual(notifications.length, 1, 'Only 1 queue stall passed through ui.notify');

      // 2. Send transient strike notifications directly
      await ui.notify('إخفاق مؤقت محاولة 1 من 3');
      await ui.notify('إخفاق مؤقت محاولة 2 من 3');
      await ui.notify('account strike 1 failure');
      await ui.notify('account strike 2 failure');
      assert.strictEqual(notifications.length, 1, 'All transient strikes suppressed by ui.notify');

      // 3. Send unformatted isolation messages -> auto-normalized to Arabic diagnostic classes
      await ui.notify('تم عزل الحساب @victim1 تلقائياً (محظور) ومواصلة الدورة عبر بقية الحسابات (2).');
      assert.strictEqual(notifications.length, 2);
      assert.ok(notifications[1].includes(ISOLATION_REASONS.BANNED), 'Banned normalized');

      await ui.notify('تم عزل الحساب @victim2 تلقائياً (كابتشا) ومواصلة الدورة عبر بقية الحسابات (1).');
      assert.strictEqual(notifications.length, 3);
      assert.ok(notifications[2].includes(ISOLATION_REASONS.CAPTCHA), 'Captcha normalized');

      await ui.notify('تم عزل الحساب @victim3 تلقائياً (جلسة مرفوضة) ومواصلة الدورة عبر بقية الحسابات (0).');
      assert.strictEqual(notifications.length, 4);
      assert.ok(notifications[3].includes(ISOLATION_REASONS.COOKIE_REJECTED), 'Cookie rejected normalized');
    });

    test('3.4 Concurrent UI 409 Conflict burst with retryFn success recovery', async () => {
      const logs = [];
      const ui = new TelegramUi({
        bot: { logger: { error: msg => logs.push(msg) } }
      });

      let callA = 0;
      let callB = 0;

      const retryFnA = async () => {
        callA++;
        if (callA < 3) {
          const err = new Error('Conflict 409');
          err.telegramCode = 409;
          throw err;
        }
        return 'recovered_A';
      };

      const retryFnB = async () => {
        callB++;
        if (callB < 2) {
          const err = new Error('Conflict 409');
          err.telegramCode = 409;
          throw err;
        }
        return 'recovered_B';
      };

      const conflictErr = new Error('Initial Conflict 409');
      conflictErr.telegramCode = 409;

      // Run two 409 recoveries concurrently
      const [resA, resB] = await Promise.all([
        ui.handle409Conflict(conflictErr, { retryFn: retryFnA, maxRetries: 4, initialBackoffMs: 10 }),
        ui.handle409Conflict(conflictErr, { retryFn: retryFnB, maxRetries: 4, initialBackoffMs: 10 })
      ]);

      assert.strictEqual(resA.handled, true);
      assert.strictEqual(resA.result, 'recovered_A');
      assert.strictEqual(resB.handled, true);
      assert.strictEqual(resB.result, 'recovered_B');

      assert.ok(logs.some(l => l.includes('telegram_ui_conflict_detected')));
    });
  });

});
