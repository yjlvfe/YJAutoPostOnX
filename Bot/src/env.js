'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isPublicIp } = require('./publicIp');

class EnvValidationError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = 'EnvValidationError';
    this.code = 'ENV_VALIDATION_FAILED';
    this.errors = errors;
  }
}

function loadLocalEnv(file = path.join(__dirname, '..', '.env.local')) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !m[1].startsWith('#')) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}

function validateEnv(env = config(), options = {}) {
  if (!env || typeof env !== 'object') {
    throw new TypeError('Environment variables must be provided as an object');
  }

  const errors = [];

  // Determine production / daemon mode
  let isProduction;
  if (typeof options.isProduction === 'boolean') {
    isProduction = options.isProduction;
  } else if (typeof options.daemon === 'boolean') {
    isProduction = options.daemon;
  } else if (options.mode) {
    isProduction = options.mode === 'production' || options.mode === 'daemon';
  } else {
    isProduction = Boolean(
      env.NODE_ENV === 'production' ||
      env.DAEMON_MODE === 'true' ||
      env.DAEMON_MODE === '1' ||
      process.env.NODE_ENV === 'production' ||
      process.env.DAEMON_MODE === 'true'
    );
  }

  const requiredKeys = options.requiredKeys || [
    'TELEGRAM_BOT_TOKEN',
    'BOT_OWNER_ID',
    'BOT_OWNER_CHAT_ID',
    'BOT_DATA_DIR'
  ];

  if (isProduction || options.strict) {
    for (const key of requiredKeys) {
      const val = env[key];
      if (val === undefined || val === null || (typeof val === 'string' && val.trim() === '')) {
        errors.push(`Missing required environment variable: ${key}`);
      }
    }
  }

  // Type and format validation for present keys
  if (env.TELEGRAM_BOT_TOKEN !== undefined && env.TELEGRAM_BOT_TOKEN !== null && env.TELEGRAM_BOT_TOKEN !== '') {
    const token = String(env.TELEGRAM_BOT_TOKEN).trim();
    if (!/^\d{6,14}:[A-Za-z0-9_-]{30,60}$/.test(token)) {
      errors.push('Invalid TELEGRAM_BOT_TOKEN format: must match <bot_id>:<secret> (e.g. 123456789:ABCdef...)');
    }
  }

  if (env.BOT_OWNER_ID !== undefined && env.BOT_OWNER_ID !== null && env.BOT_OWNER_ID !== '') {
    const raw = String(env.BOT_OWNER_ID).trim();
    const ids = raw.split(/[,\s]+/).filter(Boolean);
    if (ids.length === 0 || ids.some(id => !/^\d+$/.test(id))) {
      errors.push('Invalid BOT_OWNER_ID format: must be numeric Telegram user ID(s)');
    }
  }

  if (env.BOT_OWNER_CHAT_ID !== undefined && env.BOT_OWNER_CHAT_ID !== null && env.BOT_OWNER_CHAT_ID !== '') {
    const raw = String(env.BOT_OWNER_CHAT_ID).trim();
    const ids = raw.split(/[,\s]+/).filter(Boolean);
    if (ids.length === 0 || ids.some(id => !/^-?\d+$/.test(id))) {
      errors.push('Invalid BOT_OWNER_CHAT_ID format: must be numeric Telegram chat ID(s)');
    }
  }

  if (env.BOT_DATA_DIR !== undefined && env.BOT_DATA_DIR !== null && env.BOT_DATA_DIR !== '') {
    const dir = String(env.BOT_DATA_DIR).trim();
    if (dir.includes('\0')) {
      errors.push('Invalid BOT_DATA_DIR: path contains null bytes');
    }
  }

  const allowedUsers = env.BOT_ALLOWED_USER_IDS || env.BOT_ALLOWED_USERS;
  if (allowedUsers !== undefined && allowedUsers !== null && allowedUsers !== '') {
    const ids = String(allowedUsers).trim().split(/[,\s]+/).filter(Boolean);
    if (ids.some(id => !/^\d+$/.test(id))) {
      errors.push('Invalid BOT_ALLOWED_USER_IDS format: must be comma or space separated numeric IDs');
    }
  }

  if (env.BOT_ALLOWED_CHAT_IDS !== undefined && env.BOT_ALLOWED_CHAT_IDS !== null && env.BOT_ALLOWED_CHAT_IDS !== '') {
    const ids = String(env.BOT_ALLOWED_CHAT_IDS).trim().split(/[,\s]+/).filter(Boolean);
    if (ids.some(id => !/^-?\d+$/.test(id))) {
      errors.push('Invalid BOT_ALLOWED_CHAT_IDS format: must be comma or space separated numeric chat IDs');
    }
  }

  if (env.SERVER_IP !== undefined && env.SERVER_IP !== null && env.SERVER_IP !== '') {
    const ip = String(env.SERVER_IP).trim();
    if (!isPublicIp(ip)) {
      errors.push(`Invalid SERVER_IP: "${ip}" is not a valid public IP address`);
    }
  }

  if (env.NORDVPN_TOKEN !== undefined && env.NORDVPN_TOKEN !== null && env.NORDVPN_TOKEN !== '') {
    const token = String(env.NORDVPN_TOKEN).trim();
    if (!/^[0-9a-fA-F]{64}$/.test(token)) {
      errors.push('Invalid NORDVPN_TOKEN format: must be a 64-character hexadecimal token');
    }
  }

  if (env.NORDVPN_TOKEN_FILE !== undefined && env.NORDVPN_TOKEN_FILE !== null && env.NORDVPN_TOKEN_FILE !== '') {
    const file = String(env.NORDVPN_TOKEN_FILE).trim();
    if (!path.isAbsolute(file) || /[,\n\r]/.test(file)) {
      errors.push('Invalid NORDVPN_TOKEN_FILE: must be an absolute path without commas or newlines');
    }
  }

  if (env.NORDVPN_VERSION !== undefined && env.NORDVPN_VERSION !== null && env.NORDVPN_VERSION !== '') {
    const version = String(env.NORDVPN_VERSION).trim();
    if (!/^\d+(?:\.\d+)*(?:-[a-zA-Z0-9.]+)?$/.test(version)) {
      errors.push(`Invalid NORDVPN_VERSION format: "${version}"`);
    }
  }

  if (env.PORT !== undefined && env.PORT !== null && env.PORT !== '') {
    const p = Number(env.PORT);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      errors.push('Invalid PORT format: must be an integer between 1 and 65535');
    }
  }

  if (errors.length > 0) {
    const message = `Environment validation failed with ${errors.length} error(s):\n  - ${errors.join('\n  - ')}`;
    throw new EnvValidationError(message, errors);
  }

  return env;
}

function config(file, options = {}) {
  const local = loadLocalEnv(file);
  const merged = { ...local, ...process.env };
  if (options.validate) {
    return validateEnv(merged, options);
  }
  return merged;
}

module.exports = { loadLocalEnv, config, validateEnv, EnvValidationError };
