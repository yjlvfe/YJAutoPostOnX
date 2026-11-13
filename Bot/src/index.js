'use strict';

const path = require('node:path');

const { PgStore } = require('./pgStore');
const { TelegramTransport, BUTTONS, formatStatus } = require('./telegram');
const { AuthorizationGate } = require('./auth');
const { parseCsv } = require('./csv');
const { Queue, CycleState, hash } = require('./queue');
const scheduling = require('./scheduling');
const { projectStatus } = require('./status');
const { AccountManager, CookieStore, accountRecord } = require('./accounts');
const { SettingsManager } = require('./settings');
const { ForensicLogger, normalizeSubnet, SEVEN_DAYS_MS } = require('./forensicLogger');
const { sanitizeError } = require('./structuredLogger');

// Composition only: runner.js owns publishing, account rotation and VPN lifecycle.
// All mutable scheduling/quota configuration is read from the same durable store.
function createBot({ dataDir = process.env.BOT_DATA_DIR || path.join(process.cwd(), 'data'), ...options } = {}) {
  const configuredAccounts = (options.accounts || []).map(account => typeof account === 'string' ? accountRecord({ id: account }) : accountRecord(account));
  const initialState = {
    items: [], cycle: { state: 'stopped', runId: null }, accounts: configuredAccounts, settings: options.settings || {},
    burnedSubnets: ['187.40.234.0/24'], forensicLogs: []
  };
  const backend = options.storageBackend || process.env.STORAGE_BACKEND || 'postgres';
  if (backend !== 'postgres') throw Object.assign(new Error('PostgreSQL is the only operational backend'), { code: 'POSTGRES_ONLY_BACKEND_REQUIRED' });
  if (options.store && options.store.isPostgres !== true) throw Object.assign(new Error('Injected store must be PostgreSQL-backed'), { code: 'POSTGRES_ONLY_STORE_REQUIRED' });
  const store = options.store || new PgStore({ dataDir, initial: initialState, pool: options.pgPool, pgConfig: options.pgConfig, readOnly: options.readOnly });
  const auth = options.auth || { allowedUserIds: ['__bot_unconfigured__'], allowedChatIds: ['__bot_unconfigured__'] };
  const forensicLogger = options.forensicLogger || new ForensicLogger({ store, dataDir, clock: options.clock });
  return {
    store,
    queue: new Queue(store),
    cycle: new CycleState(store),
    accounts: new AccountManager(store, options.accountLifecycle),
    settings: new SettingsManager(store),
    cookies: new CookieStore(dataDir),
    transport: new TelegramTransport(options.telegram),
    auth: new AuthorizationGate(auth),
    forensicLogger,
    prepareCycle: options.prepareCycle || options.prepareWorkers || null,
    prepareWorkers: options.prepareWorkers || options.prepareCycle || null,
    drainWorkers: options.drainWorkers || null
  };
}

module.exports = { createBot, PgStore, TelegramTransport, BUTTONS, formatStatus, AuthorizationGate, parseCsv, Queue, CycleState, hash, ...scheduling, projectStatus, ForensicLogger, normalizeSubnet, SEVEN_DAYS_MS, ...require('./accounts'), ...require('./settings') };

if (require.main === module) {
  const { assertValidEnv, config } = require('./env');
  assertValidEnv(config(), { isProduction: process.env.NODE_ENV === 'production' });
  require('./runner').run().catch(error => { console.error(sanitizeError(error) || 'Runner startup failed'); process.exitCode = 1; });
}
