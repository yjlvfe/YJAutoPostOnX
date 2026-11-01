'use strict';

const path = require('node:path');
const { SqliteStore } = require('./sqliteStore');
const { TelegramTransport, BUTTONS, formatStatus } = require('./telegram');
const { AuthorizationGate } = require('./auth');
const { parseCsv } = require('./csv');
const { Queue, CycleState, hash } = require('./queue');
const scheduling = require('./scheduling');
const { projectStatus } = require('./status');
const { AccountManager, CookieStore, accountRecord } = require('./accounts');
const { SettingsManager } = require('./settings');
const { ForensicLogger, normalizeSubnet, SEVEN_DAYS_MS } = require('./forensicLogger');

// Composition only: runner.js owns publishing, account rotation and VPN lifecycle.
// All mutable scheduling/quota configuration is read from the same durable store.
function createBot({ dataDir = process.env.BOT_DATA_DIR || path.join(process.cwd(), 'data'), ...options } = {}) {
  const configuredAccounts = (options.accounts || []).map(account => typeof account === 'string' ? accountRecord({ id: account }) : accountRecord(account));
  const store = options.store || new SqliteStore(path.join(dataDir, 'state.sqlite'), {
    items: [], cycle: { state: 'stopped', runId: null }, accounts: configuredAccounts, settings: options.settings || {},
    burnedSubnets: ['187.40.234.0/24'], forensicLogs: []
  }, { legacyFile: path.join(dataDir, 'state.json') });
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
    forensicLogger
  };
}

module.exports = { createBot, SqliteStore, TelegramTransport, BUTTONS, formatStatus, AuthorizationGate, parseCsv, Queue, CycleState, hash, ...scheduling, projectStatus, ForensicLogger, normalizeSubnet, SEVEN_DAYS_MS, ...require('./accounts'), ...require('./settings') };

if (require.main === module) require('./runner').run().catch(error => { console.error(error.message); process.exitCode = 1; });
