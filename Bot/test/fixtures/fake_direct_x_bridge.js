'use strict';

const fs = require('node:fs');
const path = require('node:path');

class FakeDirectXAdapter {
  constructor({
    allowPublish = true,
    onOpen,
    onPublish,
    onVerifyAccount,
    supportsDispatchCallback = true
  } = {}) {
    this.allowPublish = allowPublish;
    this.onOpen = onOpen;
    this.onPublish = onPublish;
    this.onVerifyAccount = onVerifyAccount;
    this.supportsDispatchCallback = supportsDispatchCallback;
    this.openedSessions = [];
    this.publishedCalls = [];
    this.closedSessions = [];
  }

  async open({ account, accountRecord, proxy, signal } = {}) {
    if (signal?.aborted) {
      throw Object.assign(new Error('Open cancelled'), { code: 'DIRECT_X_STOPPED' });
    }
    const selected = accountRecord || account;
    if (this.onOpen) {
      const custom = await this.onOpen({ account: selected, proxy, signal });
      this.openedSessions.push(custom);
      return custom;
    }
    const session = {
      accountId: String(selected.id),
      proxy,
      exitIp: '198.51.100.10',
      closed: false,
      state: 'authenticated',
      identity: {
        authenticated: true,
        state: 'authenticated',
        username: String(selected.username || selected.id).replace(/^@/, '').toLowerCase(),
        userId: String(selected.userId || '100001')
      }
    };
    this.openedSessions.push(session);
    return session;
  }

  async verifyAccount({ account, proxy, signal } = {}) {
    if (this.onVerifyAccount) {
      return this.onVerifyAccount({ account, proxy, signal });
    }
    return {
      verified: true,
      authenticated: true,
      username: String(account.username || account.id).replace(/^@/, '').toLowerCase(),
      userId: String(account.userId || '100001'),
      challenge: false,
      locked: false,
      captcha: false,
      suspended: false,
      accountFailure: null,
      reason: null
    };
  }

  async publish({ session, payload = {}, confirmPublish = false, signal, onDispatch } = {}) {
    this.publishedCalls.push({ session, payload, confirmPublish });
    if (this.onPublish) {
      return this.onPublish({ session, payload, confirmPublish, signal, onDispatch });
    }
    if (typeof onDispatch === 'function') {
      const ack = await onDispatch({ accountId: session.accountId });
      if (ack !== true) {
        return {
          status: 'ambiguous',
          published: false,
          posted: false,
          ambiguous: true,
          reason: 'dispatch_not_acknowledged'
        };
      }
    }
    const tweetId = String(1800000000000000000n + BigInt(this.publishedCalls.length));
    const username = session.identity?.username || 'testuser';
    return {
      status: 'published',
      published: true,
      posted: true,
      ok: true,
      tweetId,
      username,
      userId: session.identity?.userId || '100001',
      url: `https://x.com/${username}/status/${tweetId}`
    };
  }

  async close({ session } = {}) {
    if (session) {
      session.closed = true;
      this.closedSessions.push(session);
    }
  }
}

function createFakeBridgeExecutable(tempDir, scriptBody, name = 'fake_bridge.py') {
  const scriptPath = path.join(tempDir, name);
  const content = `#!/usr/bin/env python3\nimport sys, json, os, time, signal\n${scriptBody}\n`;
  fs.writeFileSync(scriptPath, content, { mode: 0o700 });
  fs.chmodSync(scriptPath, 0o700);
  return scriptPath;
}

module.exports = {
  FakeDirectXAdapter,
  createFakeBridgeExecutable
};
