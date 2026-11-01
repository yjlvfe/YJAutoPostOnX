'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const { DirectXAdapter } = require(path.join(ROOT, 'src/directX'));

describe('FINDING-007: DirectXAdapter Cache and Account State Verification', () => {
  test('open() blocks session and sets accountFailure=banned when bridge reports banned/suspended', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-directx-banned-'));
    const cookieFile = path.join(tempDir, 'cookie.json');
    fs.writeFileSync(cookieFile, JSON.stringify([
      { name: 'auth_token', value: 'token123', domain: '.x.com' },
      { name: 'ct0', value: 'ct0123', domain: '.x.com' },
      { name: 'twid', value: 'u=123456789', domain: '.x.com' }
    ]));

    // Custom synthetic python peer that returns accountFailure: 'banned' on open
    const mockPython = path.join(tempDir, 'mock_bridge.sh');
    fs.writeFileSync(mockPython, `#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *"\\\"op\\\":\\\"open\\\""*)
      echo '{"event":"result","result":{"status":"not_ready","published":false,"posted":false,"ambiguous":false,"blocked":true,"reason":"auth_session_unverified","accountFailure":"banned"}}'
      ;;
  esac
done
`, { mode: 0o755 });

    const adapter = new DirectXAdapter({
      pythonExecutable: mockPython,
      openTimeoutMs: 5000
    });

    const session = await adapter.open({
      account: {
        id: 'acct-1',
        username: 'suspended_user',
        userId: '123456789',
        cookieFile
      },
      proxy: 'socks5h://127.0.0.1:18801'
    });

    assert.strictEqual(session.state, 'blocked', 'Session state must be blocked when account is banned');
    assert.strictEqual(session.identity.authenticated, false, 'Authenticated must be false');
    assert.strictEqual(session.identity.accountFailure, 'banned', 'Account failure must be banned');
  });

  test('open() succeeds and declares authenticated when live API verification succeeds', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-directx-auth-'));
    const cookieFile = path.join(tempDir, 'cookie.json');
    fs.writeFileSync(cookieFile, JSON.stringify([
      { name: 'auth_token', value: 'token123', domain: '.x.com' },
      { name: 'ct0', value: 'ct0123', domain: '.x.com' },
      { name: 'twid', value: 'u=987654321', domain: '.x.com' }
    ]));

    // Custom synthetic python peer that returns verified identity on open
    const mockPython = path.join(tempDir, 'mock_bridge_ok.sh');
    fs.writeFileSync(mockPython, `#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *"\\\"op\\\":\\\"open\\\""*)
      echo '{"event":"result","result":{"identity":{"state":"authenticated","authenticated":true,"username":"active_user","userId":"987654321"}}}'
      ;;
  esac
done
`, { mode: 0o755 });

    const adapter = new DirectXAdapter({
      pythonExecutable: mockPython,
      openTimeoutMs: 5000
    });

    const session = await adapter.open({
      account: {
        id: 'acct-2',
        username: 'active_user',
        userId: '987654321',
        cookieFile
      },
      proxy: 'socks5h://127.0.0.1:18801'
    });

    assert.strictEqual(session.state, 'authenticated', 'Session state must be authenticated');
    assert.strictEqual(session.identity.authenticated, true, 'Authenticated must be true');
    assert.strictEqual(session.identity.username, 'active_user');
    assert.strictEqual(session.identity.userId, '987654321');
    await adapter.close({ session });
  });
});
