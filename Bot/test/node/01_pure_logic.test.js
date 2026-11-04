'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createHermeticWorkspace } = require('../fixtures/hermetic_workspace');
const { riyadhDay, accountCapacity, quotaAdmission } = require('../../src/quota');
const { riyadhDateParts, isDue, nextRiyadhDaily } = require('../../src/scheduling');
const { classifyPublishOutcome } = require('../../src/publishOutcome');
const { isXContentRejection } = require('../../src/xFailureClassification');
const { isKnownTwikitParserFailure } = require('../../src/knownTwikitParserFailure');
const { recordUnsuccessfulAttempt, getUnsuccessfulAttempts } = require('../../src/attemptOutcomes');
const { parseCsv } = require('../../src/csv');
const { parseCookies, detectFormat } = require('../../src/cookieFormat');
const { AccountManager, CookieStore } = require('../../src/accounts');
const { SqliteStore } = require('../../src/sqliteStore');
const { parsePostsFile } = require('../../src/telegramFlows');
const { validateEnv, EnvValidationError } = require('../../src/env');
const { isPublicIp } = require('../../src/publicIp');
const { formatStructuredLog, sanitizeString, sanitizeValue } = require('../../src/structuredLogger');
const { escapeHtml, richTable, clean } = require('../../src/tableUtils');
const { formatAccountTable } = require('../../src/accountTable');

describe('01_pure_logic: Quotas, Rollover, Scheduling, CSV, Cookies, Classifiers, Tables & Secret Redaction', () => {
  it('L-01: riyadhDay & accountCapacity handle Asia/Riyadh midnight rollover (20:59:59Z -> 21:00:00Z) and fail closed on invalid/corrupt quota values (FINDING-029)', () => {
    const beforeMidnight = new Date('2026-11-04T20:59:59.000Z'); // 23:59:59+03:00 on 2026-11-04
    const afterMidnight = new Date('2026-11-04T21:00:00.000Z');  // 00:00:00+03:00 on 2026-11-05
    assert.strictEqual(riyadhDay(beforeMidnight), '2026-11-04');
    assert.strictEqual(riyadhDay(afterMidnight), '2026-11-05');

    // Invalid dates fall back to current date without throwing NaN-date strings
    assert.match(riyadhDay(new Date('invalid')), /^\d{4}-\d{2}-\d{2}$/);
    assert.match(riyadhDay(NaN), /^\d{4}-\d{2}-\d{2}$/);

    const account = { id: 'acc-1', enabled: true, quota: 10 };
    const state = {
      settings: { dailyQuota: 10 },
      posting: {
        quota: {
          '2026-11-04': { 'acc-1': 10 }
        }
      },
      accounts: [account],
      items: [{ id: 'i-1', state: 'pending', payload: { text: 'Hello' } }]
    };

    const capBefore = accountCapacity(state, account, beforeMidnight);
    assert.strictEqual(capBefore.used, 10);
    assert.strictEqual(capBefore.remaining, 0);
    assert.strictEqual(quotaAdmission(state, { now: beforeMidnight }).exhausted, true);

    const capAfter = accountCapacity(state, account, afterMidnight);
    assert.strictEqual(capAfter.used, 0);
    assert.strictEqual(capAfter.remaining, 10);
    assert.strictEqual(quotaAdmission(state, { now: afterMidnight }).exhausted, false);

    // Corrupt/negative/NaN quota fails closed (remaining === 0)
    const corruptState = {
      settings: { dailyQuota: 10 },
      posting: { quota: { '2026-11-04': { 'acc-1': -5 } } }
    };
    assert.strictEqual(accountCapacity(corruptState, account, beforeMidnight).remaining, 0);

    const corruptLimitState = {
      settings: { dailyQuota: -1 },
      posting: { quota: {} }
    };
    assert.strictEqual(accountCapacity(corruptLimitState, account, beforeMidnight).remaining, 0);
  });

  it('L-02: scheduling.js computes riyadhDateParts, isDue, and nextRiyadhDaily accurately in Asia/Riyadh', () => {
    // 06:30:00Z is 09:30:00 in Asia/Riyadh (UTC+3)
    const now = new Date('2026-11-04T06:30:00.000Z');
    const parts = riyadhDateParts(now);
    assert.strictEqual(parts.year, 2026);
    assert.strictEqual(parts.month, 11);
    assert.strictEqual(parts.day, 4);
    assert.strictEqual(parts.hour, 9);
    assert.strictEqual(parts.minute, 30);

    assert.strictEqual(isDue({ hour: 9, minute: 30 }, now), true);
    assert.strictEqual(isDue({ hour: 9, minute: 31 }, now), false);
    assert.strictEqual(isDue({ hour: 10, minute: 30 }, now), false);

    const nextLaterToday = nextRiyadhDaily({ hour: 10, minute: 0 }, now);
    assert.strictEqual(nextLaterToday.toISOString(), '2026-11-04T07:00:00.000Z');

    const nextTomorrow = nextRiyadhDaily({ hour: 9, minute: 0 }, now);
    assert.strictEqual(nextTomorrow.toISOString(), '2026-11-05T06:00:00.000Z');
  });

  it('L-03: classifyPublishOutcome enforces strict post-dispatch ambiguity fence (FINDING-003 / PY-RAW-04 / XT-05)', () => {
    // Confirmed publish with URL
    assert.strictEqual(
      classifyPublishOutcome({ published: true, url: 'https://x.com/u/status/123' }, true),
      'published'
    );
    // Missing URL even if published=true -> ambiguous
    assert.strictEqual(
      classifyPublishOutcome({ published: true, url: '' }, true),
      'ambiguous'
    );
    // Pre-dispatch rate limit or transient failure -> pending
    assert.strictEqual(
      classifyPublishOutcome({ published: false, rateLimit: true, retryable: true }, false),
      'pending'
    );
    assert.strictEqual(
      classifyPublishOutcome({ published: false, reason: 'tweet_too_long' }, false),
      'cancelled'
    );
    // Post-dispatch rate limit or retryable claim MUST be forced to ambiguous
    assert.strictEqual(
      classifyPublishOutcome({ published: false, rateLimit: true, retryable: true, accountFailure: 'rate_limit' }, true),
      'ambiguous'
    );
    assert.strictEqual(
      classifyPublishOutcome({ published: false, ambiguous: false, retryable: true }, true),
      'ambiguous'
    );
  });

  it('L-04: xFailureClassification & knownTwikitParserFailure classify 186/187 and KeyError urls without exempting bans/captchas (FINDING-008)', () => {
    assert.strictEqual(
      isXContentRejection({ failure: 'ambiguous', xErrorCode: 186, xResponseKind: 'graphql_errors' }),
      true
    );
    assert.strictEqual(
      isXContentRejection({ failure: 'ambiguous', xErrorCode: 187, xResponseKind: 'graphql_errors' }),
      true
    );
    assert.strictEqual(
      isXContentRejection({ failure: 'ambiguous', rejectionReason: 'duplicate_content' }),
      true
    );
    // Account restrictions are NEVER content rejections
    assert.strictEqual(
      isXContentRejection({ failure: 'captcha', xErrorCode: 326, xResponseKind: 'graphql_errors' }),
      false
    );
    assert.strictEqual(
      isXContentRejection({ failure: 'banned', xErrorCode: 64, xResponseKind: 'graphql_errors' }),
      false
    );
    assert.strictEqual(
      isXContentRejection({ failure: 'ambiguous', xErrorCode: 326, xResponseKind: 'graphql_errors' }),
      false
    );

    // Known Twikit parser failure
    assert.strictEqual(isKnownTwikitParserFailure({ failure: 'ambiguous', rawError: "'urls'" }), true);
    assert.strictEqual(isKnownTwikitParserFailure({ failure: 'ambiguous', rawError: "KeyError: 'urls'" }), true);
    assert.strictEqual(isKnownTwikitParserFailure({ failure: 'ambiguous', rawError: "KeyError('urls')" }), true);
    assert.strictEqual(isKnownTwikitParserFailure({ failure: 'captcha', rawError: "'urls'" }), false);
    assert.strictEqual(isKnownTwikitParserFailure({ failure: 'ambiguous', rawError: 'TimeoutError' }), false);
  });

  it('L-05: attemptOutcomes records failed and ambiguous per-day counters and prunes entries older than 14 days', () => {
    const state = {};
    const day1 = new Date('2026-10-01T12:00:00Z');
    recordUnsuccessfulAttempt(state, { accountId: 'acc-1', outcome: 'failed', at: day1 });
    recordUnsuccessfulAttempt(state, { accountId: 'acc-1', outcome: 'ambiguous', at: day1 });
    // Published or invalid outcomes do not increment counters
    assert.strictEqual(recordUnsuccessfulAttempt(state, { accountId: 'acc-1', outcome: 'published', at: day1 }), false);

    const stats1 = getUnsuccessfulAttempts(state, 'acc-1', day1);
    assert.deepStrictEqual(stats1, { failed: 1, ambiguous: 1, total: 2 });

    // Advance 20 days to trigger 14-day retention pruning
    for (let d = 2; d <= 20; d++) {
      const dt = new Date(`2026-10-${String(d).padStart(2, '0')}T12:00:00Z`);
      recordUnsuccessfulAttempt(state, { accountId: 'acc-1', outcome: 'failed', at: dt });
    }
    assert.strictEqual(Object.keys(state.posting.attemptOutcomes).length, 14);
    assert.strictEqual(state.posting.attemptOutcomes['2026-10-01'], undefined);
  });

  it('L-06: csv.js, parsePostsFile, cookieFormat.js & CookieStore enforce BOM handling, formula rejection, Empty CSV guard (FINDING-017), and 1 MiB cookie cap (ACC-RAW-02)', async () => {
    const ws = createHermeticWorkspace('yj-bot-test-l06-');
    try {
      // UTF-8 BOM posts CSV from AppImage
      const bomCsv = '\uFEFFText,Media\r\n"Hello X world",""\r\n"Second post",""\r\n';
      const parsedPosts = parsePostsFile(bomCsv, { items: [], accounts: [] });
      assert.strictEqual(parsedPosts.valid, 2);
      assert.strictEqual(parsedPosts.payloads[0].text, 'Hello X world');

      // Formula injection rejected in parseCsv
      assert.throws(
        () => parseCsv('account,text\nacc1,=cmd|\'/c calc\'!A0'),
        /unsafe formula/i
      );

      // Empty accounts CSV rejected with EMPTY_ACCOUNTS_CSV
      const store = ws.registerStore(new SqliteStore(ws.dbPath));
      const mgr = new AccountManager(store);
      await assert.rejects(() => mgr.replaceFromCsv(''), /EMPTY_ACCOUNTS_CSV/);
      await assert.rejects(() => mgr.replaceFromCsv('account,username\n'), /EMPTY_ACCOUNTS_CSV/);

      // Cookie parsing (JSON and Netscape)
      const jsonCookies = JSON.stringify([
        { name: 'auth_token', value: 'tok123', domain: '.x.com' },
        { name: 'ct0', value: 'csrf123', domain: '.x.com' }
      ]);
      assert.strictEqual(detectFormat(jsonCookies), 'json');
      assert.strictEqual(parseCookies(jsonCookies).cookies.length, 2);

      const netscapeCookies = '.x.com\tTRUE\t/\tTRUE\t2147483647\tauth_token\ttok123\n#HttpOnly_.x.com\tTRUE\t/\tTRUE\t2147483647\tct0\tcsrf123\n';
      assert.strictEqual(detectFormat(netscapeCookies), 'netscape');
      assert.strictEqual(parseCookies(netscapeCookies).cookies.length, 2);

      // ACC-RAW-02: 1 MiB (1,048,576 bytes) max cookie size enforced in Node CookieStore
      const cookieStore = new CookieStore(ws.tempDir);
      const oversizedCookie = JSON.stringify([
        { name: 'auth_token', value: 'a'.repeat(1_050_000), domain: '.x.com' },
        { name: 'ct0', value: 'b'.repeat(64), domain: '.x.com' }
      ]);
      await assert.rejects(
        () => cookieStore.storeContent('acc-oversized', oversizedCookie),
        /COOKIE_FILE_TOO_LARGE|size is invalid|content is invalid/i
      );
    } finally {
      await ws.cleanup();
    }
  });

  it('L-07: env.js & publicIp.js validate synthetic production env and reject private/loopback/placeholder values (FINDING-016)', () => {
    assert.strictEqual(isPublicIp('8.8.8.8'), true);
    assert.strictEqual(isPublicIp('1.1.1.1'), true);
    assert.strictEqual(isPublicIp('127.0.0.1'), false);
    assert.strictEqual(isPublicIp('10.0.0.1'), false);
    assert.strictEqual(isPublicIp('192.168.1.1'), false);
    assert.strictEqual(isPublicIp('169.254.169.254'), false);
    assert.strictEqual(isPublicIp('::1'), false);

    const validSyntheticEnv = {
      TELEGRAM_BOT_TOKEN: '123456789:ABCdefGHIjklMNOpqrSTUvwxYZ012345678',
      BOT_OWNER_ID: '528864559',
      BOT_OWNER_CHAT_ID: '528864559',
      BOT_DATA_DIR: '/tmp/yj-synthetic-data',
      SERVER_IP: '8.8.8.8'
    };
    assert.doesNotThrow(() => validateEnv(validSyntheticEnv, { isProduction: true }));

    // Missing required keys in production mode fails closed
    assert.throws(
      () => validateEnv({}, { isProduction: true }),
      err => err instanceof EnvValidationError && err.errors.length >= 4
    );

    // Private IP as SERVER_IP fails closed
    assert.throws(
      () => validateEnv({ ...validSyntheticEnv, SERVER_IP: '127.0.0.1' }, { isProduction: true }),
      /not a valid public IP/i
    );

    // Null byte in BOT_DATA_DIR fails closed
    assert.throws(
      () => validateEnv({ ...validSyntheticEnv, BOT_DATA_DIR: '/tmp/bad\0path' }, { isProduction: true }),
      /null bytes/i
    );
  });

  it('L-08: structuredLogger.js redacts both top-level and nested sensitive keys, tokens, cookies, and embedded JSON secrets (UTIL-RAW-01 & FINDING-028)', () => {
    const record = formatStructuredLog({
      component: 'test_logger',
      event: 'auth_probe',
      runId: 'run-1',
      xErrorCode: 326,
      token: '123456789:ABCdefGHIjklMNOpqrSTUvwxYZ012345678',
      cookie: 'auth_token=supersecret123; ct0=csrfsecret456',
      password: 'my_top_level_password',
      secretKey: 'top_secret_val',
      nested: {
        password: 'nested_password_value',
        auth_token: 'nested_auth_token_val',
        safeField: 'visible_diagnostic'
      },
      sanitizedError: 'Failed with {"auth_token":"embedded_json_secret","ct0":"embedded_ct0"} and Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'
    });

    assert.strictEqual(record.runId, 'run-1');
    assert.strictEqual(record.xErrorCode, 326);
    assert.strictEqual(record.token, '[REDACTED]');
    assert.strictEqual(record.password, '[REDACTED]');
    assert.strictEqual(record.secretKey, '[REDACTED]');
    assert.ok(!String(record.cookie).includes('supersecret123'));
    assert.strictEqual(record.nested.password, '[REDACTED]');
    assert.strictEqual(record.nested.auth_token, '[REDACTED]');
    assert.strictEqual(record.nested.safeField, 'visible_diagnostic');
    assert.ok(!record.sanitizedError.includes('embedded_json_secret'));
    assert.ok(!record.sanitizedError.includes('embedded_ct0'));
    assert.ok(!record.sanitizedError.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'));

    const serialized = JSON.stringify(record);
    assert.ok(!serialized.includes('my_top_level_password'));
    assert.ok(!serialized.includes('top_secret_val'));
    assert.ok(!serialized.includes('nested_password_value'));
  });

  it('L-09: tableUtils.js & accountTable.js escape HTML entities and preserve last known Exit IP during refresh (FINDING-027 & UTIL-RAW-02)', () => {
    assert.strictEqual(escapeHtml('<script>alert("x")&</script>'), '&lt;script&gt;alert("x")&amp;&lt;/script&gt;');
    assert.ok(!clean('bad|pipe\nnewline').includes('|'));
    assert.ok(!clean('bad|pipe\nnewline').includes('\n'));

    const state = {
      settings: { dailyQuota: 10 },
      accounts: [
        {
          id: 'acc-1',
          username: 'safe_user',
          label: '<b>UnsafeLabel</b>',
          enabled: true,
          status: 'مفعل',
          exitIp: '1.1.1.1'
        }
      ],
      telegramUi: {
        accountChecks: {
          'acc-1': { vpn: { ip: '1.1.1.1' } }
        }
      }
    };

    const refreshingHtml = formatAccountTable(state, {
      now: new Date('2026-11-04T12:00:00Z'),
      refreshingIds: new Set(['acc-1'])
    });
    assert.ok(refreshingHtml.includes('1.1.1.1'), 'Should preserve Exit IP while refreshing');
    assert.ok(refreshingHtml.includes('جاري التحديث'), 'Should show refreshing status');
    assert.ok(refreshingHtml.includes('<table bordered compact>'));

    const customTable = richTable(['Col1', 'Col2'], [['<img src=x>', 'a & b']], 'Cap <1>');
    assert.ok(!customTable.includes('<img'));
    assert.ok(customTable.includes('&lt;img src=x&gt;'));
    assert.ok(customTable.includes('a &amp; b'));
  });
});
