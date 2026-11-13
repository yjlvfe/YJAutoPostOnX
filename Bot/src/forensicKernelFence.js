'use strict';
// Supplemental local filesystem fence, never a lease/admission database.
// flock attaches to the shared open-file-description: the short helper exits,
// but this Node process keeps the same descriptor locked through awaited I/O.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
function failure(code) { return Object.assign(new Error(code), {code}); }
function canonicalPath(target) {
  const resolved = path.resolve(target);
  const missing = [];
  let cursor = resolved;
  while (true) {
    try { return path.join(fs.realpathSync(cursor), ...missing); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missing.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}
async function acquireKernelFence(identity, deadline) {
  if (process.platform !== 'linux') throw failure('FORENSIC_KERNEL_FENCE_UNAVAILABLE');
  identity = canonicalPath(identity);
  const test = process.env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT || process.env.YJ_TEST_MODE === '1' || process.env.npm_lifecycle_event?.startsWith('test') || [...process.execArgv, ...process.argv].some(a => typeof a === 'string' && (a.includes('--test') || a.endsWith('.test.js') || path.basename(a).endsWith('.test.mjs')));
  if (test) {
    for (let root of [path.resolve(__dirname,'../data'),'/root/Projects/YJAutoPostOnX/Bot/data',process.env.BOT_PRODUCTION_DATA_DIR].filter(Boolean)) {
      root = canonicalPath(root);
      if(identity===root||identity.startsWith(root+path.sep))throw failure('PROD_FORENSIC_MUTATION_FORBIDDEN_IN_TEST');
    }
  }
  const file = identity + '.writer.lock';
  fs.mkdirSync(path.dirname(file), {recursive:true,mode:0o700});
  const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
  let keep = false;
  try {
    const stat=fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink!==1 || (stat.mode&0o077) || stat.uid!==process.getuid()) throw failure('FORENSIC_KERNEL_FENCE_UNSAFE');
    const ms = deadline-performance.now();
    if (ms<=0) throw failure('FORENSIC_LOG_LOCK_TIMEOUT');
    await new Promise((resolve,reject)=>{
      let child, timer, timedOut=false, spawnError;
      try { child=spawn('/usr/bin/flock',['--exclusive','--timeout',String(Math.max(0.001,ms/1000)),'3'],{stdio:['ignore','ignore','ignore',fd]}); }
      catch { return reject(failure('FORENSIC_KERNEL_FENCE_UNAVAILABLE')); }
      child.once('error',error=>{spawnError=error;});
      child.once('close',(code)=>{
        clearTimeout(timer);
        if(spawnError)reject(failure('FORENSIC_KERNEL_FENCE_UNAVAILABLE'));
        else if(timedOut||code===1||performance.now()>=deadline)reject(failure('FORENSIC_LOG_LOCK_TIMEOUT'));
        else if(code!==0)reject(failure('FORENSIC_KERNEL_FENCE_UNAVAILABLE'));
        else resolve();
      });
      // Reap the helper before closing our shared descriptor on timeout.
      timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},Math.max(1,ms));
    });
    // Never unlink/replace the lock inode: JSONL replacement does not affect it.
    const current=fs.lstatSync(file);
    if(current.isSymbolicLink()||current.dev!==stat.dev||current.ino!==stat.ino||current.nlink!==1)throw failure('FORENSIC_KERNEL_FENCE_UNSAFE');
    keep=true;
    let released=false;
    return ()=>{if(!released){released=true;fs.closeSync(fd);}};
  } finally {if(!keep)fs.closeSync(fd);}
}
module.exports={acquireKernelFence};
