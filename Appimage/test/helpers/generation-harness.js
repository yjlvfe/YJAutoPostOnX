'use strict';

// The actual main.js IPC handler + SessionManager + durableQueue + native SQLite.
// Only Electron's window shell and the external provider transport are replaced.
// No HTTP server, paid key, browser publisher or live HOME is accessible here.
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

function loadGenerationHarness({ rootDir, fetchFixture }) {
  fs.mkdirSync(rootDir, { recursive: true });
  const oldHome = os.homedir;
  const oldEnvHome = process.env.HOME;
  const oldFetch = global.fetch;
  const watchdog = setTimeout(() => {
    console.error('Generation integration did not settle within 30s');
    process.exit(1);
  }, 30_000);
  os.homedir = () => rootDir;
  process.env.HOME = rootDir;
  const handlers = new Map();
  const events = [];
  const appEvents = new Map();
  const electron = {
    app: {
      disableHardwareAcceleration() {},
      getPath: () => path.join(rootDir, 'userData'),
      requestSingleInstanceLock: () => true,
      commandLine: { appendSwitch() {} },
      on: (name, fn) => appEvents.set(name, fn),
      // Do not launch a real window or startup migrators in this node-style test.
      whenReady: () => ({ then() {} }),
      quit() {},
    },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), on() {} },
    BrowserWindow: class {},
    safeStorage: { isEncryptionAvailable: () => false },
    dialog: {}, shell: {},
  };
  const originalLoad = Module._load;
  Module._load = function guardedLoad(name, parent, isMain) {
    if (name === 'electron') return electron;
    if (parent && parent.filename.endsWith(`${path.sep}main.js`) && name === './automation/xPoster') {
      return new Proxy({ escCsv: s => '"' + String(s).replace(/"/g, '""') + '"' }, {
        get: (target, key) => target[key] || (() => { throw new Error('PUBLISHING_FORBIDDEN_IN_TEST'); }),
      });
    }
    return originalLoad.call(this, name, parent, isMain);
  };
  global.fetch = async (url, options) => {
    if (!String(url).startsWith('https://fixture.invalid/')) throw new Error('EXTERNAL_NETWORK_FORBIDDEN');
    return fetchFixture(url, options);
  };
  try {
    require('../../dev/main');
  } finally {
    Module._load = originalLoad;
  }
  const queue = require('../../dev/automation/durableQueue');
  return {
    events,
    queue,
    invoke: (name, ...args) => {
      if (!handlers.has(name)) throw new Error(`Missing IPC handler: ${name}`);
      return handlers.get(name)({ sender: { send: (ch, data) => events.push({ ch, data }) } }, ...args);
    },
    generate: config => handlers.get('generate-ai-posts')({}, {
      baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-not-a-credential',
      model: 'fixture-model', quantity: 1, sessionCount: 1, ...config,
    }),
    async close() {
      clearTimeout(watchdog);
      await queue.closeStore();
      global.fetch = oldFetch;
      os.homedir = oldHome;
      if (oldEnvHome === undefined) delete process.env.HOME; else process.env.HOME = oldEnvHome;
    },
  };
}

function response(content) {
  return {
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) }, finish_reason: 'stop' }] }),
  };
}
module.exports = { loadGenerationHarness, response };
