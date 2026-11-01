'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { validateEnv, config, EnvValidationError } = require('../src/env');

describe('FINDING-016: Strict Environment Validation', () => {
  const validProductionEnv = {
    TELEGRAM_BOT_TOKEN: '9010112420:AAGCkR94kXRKAM3NRsEQzUa8wAKwf8Yck0k',
    BOT_OWNER_ID: '528864559',
    BOT_OWNER_CHAT_ID: '528864559',
    BOT_DATA_DIR: '/root/Projects/YJAutoPostOnX/Bot/data',
    NODE_ENV: 'production'
  };

  test('passes validation with complete valid production environment', () => {
    const result = validateEnv(validProductionEnv);
    assert.strictEqual(result.TELEGRAM_BOT_TOKEN, validProductionEnv.TELEGRAM_BOT_TOKEN);
    assert.strictEqual(result.BOT_OWNER_ID, '528864559');
    assert.strictEqual(result.BOT_DATA_DIR, '/root/Projects/YJAutoPostOnX/Bot/data');
  });

  test('throws TypeError if env argument is not an object', () => {
    assert.throws(() => validateEnv(null), {
      name: 'TypeError',
      message: /Environment variables must be provided as an object/
    });
    assert.throws(() => validateEnv('string'), {
      name: 'TypeError'
    });
  });

  test('fails loudly in production/daemon mode when required keys are missing', () => {
    try {
      validateEnv({}, { isProduction: true });
      assert.fail('Should have thrown EnvValidationError');
    } catch (err) {
      assert.strictEqual(err.name, 'EnvValidationError');
      assert.strictEqual(err.code, 'ENV_VALIDATION_FAILED');
      assert.strictEqual(err.errors.length, 4);
      assert.ok(err.errors.some(e => e.includes('TELEGRAM_BOT_TOKEN')));
      assert.ok(err.errors.some(e => e.includes('BOT_OWNER_ID')));
      assert.ok(err.errors.some(e => e.includes('BOT_OWNER_CHAT_ID')));
      assert.ok(err.errors.some(e => e.includes('BOT_DATA_DIR')));
    }
  });

  test('fails loudly when mode="daemon" or daemon=true is passed', () => {
    assert.throws(
      () => validateEnv({}, { daemon: true }),
      err => err.name === 'EnvValidationError' && err.code === 'ENV_VALIDATION_FAILED'
    );
    assert.throws(
      () => validateEnv({}, { mode: 'daemon' }),
      err => err.name === 'EnvValidationError' && err.code === 'ENV_VALIDATION_FAILED'
    );
  });

  test('fails loudly when individual required keys are missing in production', () => {
    const withoutDataDir = { ...validProductionEnv };
    delete withoutDataDir.BOT_DATA_DIR;
    assert.throws(
      () => validateEnv(withoutDataDir, { isProduction: true }),
      err => err.errors.some(e => e.includes('BOT_DATA_DIR'))
    );

    const withoutToken = { ...validProductionEnv };
    delete withoutToken.TELEGRAM_BOT_TOKEN;
    assert.throws(
      () => validateEnv(withoutToken, { isProduction: true }),
      err => err.errors.some(e => e.includes('TELEGRAM_BOT_TOKEN'))
    );

    const withoutOwner = { ...validProductionEnv };
    delete withoutOwner.BOT_OWNER_ID;
    assert.throws(
      () => validateEnv(withoutOwner, { isProduction: true }),
      err => err.errors.some(e => e.includes('BOT_OWNER_ID'))
    );

    const withoutChatId = { ...validProductionEnv };
    delete withoutChatId.BOT_OWNER_CHAT_ID;
    assert.throws(
      () => validateEnv(withoutChatId, { isProduction: true }),
      err => err.errors.some(e => e.includes('BOT_OWNER_CHAT_ID'))
    );
  });

  test('validates TELEGRAM_BOT_TOKEN format', () => {
    assert.throws(
      () => validateEnv({ ...validProductionEnv, TELEGRAM_BOT_TOKEN: 'invalid_token' }),
      err => err.errors.some(e => e.includes('Invalid TELEGRAM_BOT_TOKEN format'))
    );
    assert.throws(
      () => validateEnv({ ...validProductionEnv, TELEGRAM_BOT_TOKEN: '12345:short' }),
      err => err.errors.some(e => e.includes('Invalid TELEGRAM_BOT_TOKEN format'))
    );
  });

  test('validates BOT_OWNER_ID and BOT_OWNER_CHAT_ID formats', () => {
    assert.throws(
      () => validateEnv({ ...validProductionEnv, BOT_OWNER_ID: 'not-a-number' }),
      err => err.errors.some(e => e.includes('Invalid BOT_OWNER_ID format'))
    );
    assert.throws(
      () => validateEnv({ ...validProductionEnv, BOT_OWNER_CHAT_ID: 'chat-abc' }),
      err => err.errors.some(e => e.includes('Invalid BOT_OWNER_CHAT_ID format'))
    );

    // Negative chat IDs (Telegram groups/supergroups/channels) are allowed
    const withGroupChatId = validateEnv({
      ...validProductionEnv,
      BOT_OWNER_CHAT_ID: '-1001234567890'
    });
    assert.strictEqual(withGroupChatId.BOT_OWNER_CHAT_ID, '-1001234567890');
  });

  test('validates BOT_DATA_DIR for null bytes', () => {
    assert.throws(
      () => validateEnv({ ...validProductionEnv, BOT_DATA_DIR: '/root/data\0injected' }),
      err => err.errors.some(e => e.includes('Invalid BOT_DATA_DIR'))
    );
  });

  test('validates optional allowed user and chat IDs', () => {
    assert.throws(
      () => validateEnv({ ...validProductionEnv, BOT_ALLOWED_USER_IDS: '12345, not-numeric' }),
      err => err.errors.some(e => e.includes('Invalid BOT_ALLOWED_USER_IDS format'))
    );
    assert.throws(
      () => validateEnv({ ...validProductionEnv, BOT_ALLOWED_CHAT_IDS: '-100123, bad-chat' }),
      err => err.errors.some(e => e.includes('Invalid BOT_ALLOWED_CHAT_IDS format'))
    );

    const validAllowed = validateEnv({
      ...validProductionEnv,
      BOT_ALLOWED_USER_IDS: '5535435580, 12345678',
      BOT_ALLOWED_CHAT_IDS: '-1001234567, 5535435580'
    });
    assert.ok(validAllowed);
  });

  test('validates SERVER_IP to ensure valid public IP address', () => {
    assert.throws(
      () => validateEnv({ ...validProductionEnv, SERVER_IP: '127.0.0.1' }),
      err => err.errors.some(e => e.includes('Invalid SERVER_IP'))
    );
    assert.throws(
      () => validateEnv({ ...validProductionEnv, SERVER_IP: '192.168.1.100' }),
      err => err.errors.some(e => e.includes('Invalid SERVER_IP'))
    );
    assert.throws(
      () => validateEnv({ ...validProductionEnv, SERVER_IP: '999.999.999.999' }),
      err => err.errors.some(e => e.includes('Invalid SERVER_IP'))
    );

    const validIpEnv = validateEnv({ ...validProductionEnv, SERVER_IP: '64.112.42.39' });
    assert.strictEqual(validIpEnv.SERVER_IP, '64.112.42.39');
  });

  test('validates NORDVPN_TOKEN and NORDVPN_TOKEN_FILE', () => {
    assert.throws(
      () => validateEnv({ ...validProductionEnv, NORDVPN_TOKEN: 'too-short' }),
      err => err.errors.some(e => e.includes('Invalid NORDVPN_TOKEN format'))
    );
    assert.throws(
      () => validateEnv({ ...validProductionEnv, NORDVPN_TOKEN_FILE: 'relative/path.txt' }),
      err => err.errors.some(e => e.includes('Invalid NORDVPN_TOKEN_FILE'))
    );

    const validNordEnv = validateEnv({
      ...validProductionEnv,
      NORDVPN_TOKEN: 'e9f2ab7e7d275f41ec58e4af42978dfdea76691f0fc1b77327c32fdaf7dc4ce9',
      NORDVPN_TOKEN_FILE: '/run/secrets/nordvpn_token'
    });
    assert.ok(validNordEnv);
  });

  test('does not enforce required keys in non-production mode when omitted', () => {
    const emptyDevEnv = validateEnv({}, { isProduction: false });
    assert.deepStrictEqual(emptyDevEnv, {});
  });

  test('config(file, { validate: true }) triggers validation', () => {
    const validConfig = config(undefined, { validate: true, isProduction: false });
    assert.ok(validConfig);
  });
});
