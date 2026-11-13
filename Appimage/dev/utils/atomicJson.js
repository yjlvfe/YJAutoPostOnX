'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

class CorruptJsonError extends Error {
  constructor(filePath, cause) {
    super(`ملف JSON تالف: ${filePath}${cause?.message ? ` — ${cause.message}` : ''}`);
    this.name = 'CorruptJsonError';
    this.filePath = filePath;
    this.cause = cause;
  }
}

function cloneDefault(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

async function readJson(filePath, defaultValue) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return cloneDefault(defaultValue);
    if (err instanceof SyntaxError) {
      const backupPath = `${filePath}.bak`;
      try {
        return JSON.parse(await fsp.readFile(backupPath, 'utf8'));
      } catch {
        throw new CorruptJsonError(filePath, err);
      }
    }
    throw err;
  }
}

function readJsonSync(filePath, defaultValue) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return cloneDefault(defaultValue);
    if (err instanceof SyntaxError) {
      try {
        return JSON.parse(fs.readFileSync(`${filePath}.bak`, 'utf8'));
      } catch {
        throw new CorruptJsonError(filePath, err);
      }
    }
    throw err;
  }
}

async function atomicWriteJson(filePath, value, options = {}) {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const backupPath = `${filePath}.bak`;
  const payload = JSON.stringify(value, null, options.compact ? 0 : 2);
  let handle;
  try {
    handle = await fsp.open(tempPath, 'w', options.mode ?? 0o600);
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;

    try {
      const current = await fsp.readFile(filePath, 'utf8');
      JSON.parse(current);
      await fsp.writeFile(backupPath, current, { mode: options.mode ?? 0o600 });
    } catch (err) {
      if (err?.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
    }

    await fsp.rename(tempPath, filePath);
    const dirHandle = await fsp.open(dir, 'r').catch(() => null);
    if (dirHandle) {
      await dirHandle.sync().catch(() => {});
      await dirHandle.close().catch(() => {});
    }
  } catch (err) {
    if (handle) await handle.close().catch(() => {});
    await fsp.unlink(tempPath).catch(() => {});
    throw err;
  }
}

function atomicWriteJsonSync(filePath, value, options = {}) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const backupPath = `${filePath}.bak`;
  const payload = JSON.stringify(value, null, options.compact ? 0 : 2);
  let fd;
  try {
    fd = fs.openSync(tempPath, 'w', options.mode ?? 0o600);
    fs.writeFileSync(fd, payload, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;

    try {
      const current = fs.readFileSync(filePath, 'utf8');
      JSON.parse(current);
      fs.writeFileSync(backupPath, current, { mode: options.mode ?? 0o600 });
    } catch (err) {
      if (err?.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
    }

    fs.renameSync(tempPath, filePath);
  } catch (err) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(tempPath); } catch {}
    throw err;
  }
}

module.exports = {
  CorruptJsonError,
  readJson,
  readJsonSync,
  atomicWriteJson,
  atomicWriteJsonSync,
};
