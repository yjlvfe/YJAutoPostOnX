'use strict';
// Durable import metadata lives beside the canonical state, never in agent workspaces.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { parseLine, FORMULA_PREFIX } = require('./csv');
const { accountRecord } = require('./accounts');
const { parseCookies } = require('./cookieFormat');
const MAX_CSV_BYTES = 20 * 1024 * 1024;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function parseJson(raw, fallback = null) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || !raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}
function parseRetentionEpoch(value, fallback = 0) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean' || typeof value === 'object') throw new Error('INVALID_RETENTION_EPOCH');
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) throw new Error('INVALID_RETENTION_EPOCH');
    value = Number(trimmed);
  }
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('INVALID_RETENTION_EPOCH');
  return value;
}
const parseCookieUid = value => {
  if (!value) return null;
  let decoded = String(value);
  try { decoded = decodeURIComponent(decoded); } catch {}
  const match = /(?:^|[?;&])u=(\d+)(?:$|[;&])/i.exec(decoded);
  return match ? match[1] : null;
};
const headers = { text:'text', post:'text', tweet:'text', content:'text', 'المنشور':'text', media:'media', image:'media', account:'account' };

async function* records(file) {
  const decoder = new TextDecoder('utf-8', { fatal:true });
  let row = '', mode = 'start', cr = false, first = true, oversized = false;
  for await (const chunk of fs.createReadStream(file, { highWaterMark:65536 })) {
    let text = decoder.decode(chunk, { stream:true });
    if (first) { text = text.replace(/^\uFEFF/, ''); first = false; }
    for (const c of text) {
      if (cr && c === '\n') { cr = false; continue; } cr = false;
      if ((c === '\n' || c === '\r') && mode !== 'quoted') { yield oversized ? '\0OVERSIZED_ROW' : row; row = ''; oversized=false; mode='start'; cr = c === '\r'; }
      else {
        if (!oversized) row += c;
        if(mode==='quoted'){if(c==='"')mode='closed';}
        else if(mode==='closed'){if(c==='"')mode='quoted';else if(c===',')mode='start';else mode='invalid';}
        else if(c===',')mode='start';
        else if(mode==='start')mode=c==='"'?'quoted':'plain';
        // Quotes in unquoted fields are malformed, not multiline delimiters.
      }
      if (row.length > 1024 * 1024) { oversized=true; row=''; }
    }
  }
  decoder.decode();
  if (oversized || row) yield oversized ? '\0OVERSIZED_ROW' : row;
}

class FileImports {
  constructor(flows) { this.flows = flows; this.store = flows.bot.store; this.tasks = new Map(); this.summaryTimers = new Map(); this.batchLanes = new Map(); this.now = () => Date.now(); }
  async tx(fn) { return this.store.importTransaction(fn); }
  async initialize() {
    if(this.initialized)return;
    if(typeof this.store._ensureInitialized === 'function') await this.store._ensureInitialized();
    if(this.store.pool) {
      const {assertImportSchema}=require('./pgImportRepository');
      await assertImportSchema(this.store.pool);
    }
    this.initialized=true;
  }
  async openBatch(db,id){
    let batch=(await db.one("SELECT * FROM account_import_batches WHERE owner=$1 AND status='open' AND collecting=1",[id.key]));
    if(batch && batch.prompt_state==='delivered' && this.now()-batch.touched>=1200 && !(await db.one("SELECT 1 FROM text_upload_inbox WHERE batch=$1 AND status IN ('receiving','retry')",[batch.id]))){
      await db.execute('UPDATE account_import_batches SET collecting=0 WHERE id=$1',[batch.id]);batch=null;
    }
    if(!batch){const token=crypto.randomBytes(12).toString('hex');await db.execute('INSERT INTO account_import_batches(id,owner,chat,"user",touched,collecting) VALUES($1,$2,$3,$4,$5,1) ON CONFLICT DO NOTHING',[token,id.key,String(id.chat),String(id.user),this.now()]);batch=(await db.one('SELECT * FROM account_import_batches WHERE id=$1',[token]));}
    return batch;
  }
  async batchLane(owner,fn){
    const task=(this.batchLanes.get(owner)||Promise.resolve()).catch(()=>{}).then(fn);
    this.batchLanes.set(owner,task);try{return await task;}finally{if(this.batchLanes.get(owner)===task)this.batchLanes.delete(owner);}
  }
  async text(id,doc,consume,{defer=false,receiptId}={}) {
    await this.initialize();
    const receipt=receiptId || doc._importReceipt || digest(id.key+':upload:'+crypto.randomUUID());
    if(!receiptId && doc._autoImport === undefined){
      doc={...doc,_importReceipt:receipt,_autoImport:true};
    }else{
      doc={...doc,_importReceipt:receipt};
    }
    const row=await this.tx(async db=>{
      const existing=(await db.one('SELECT * FROM text_upload_inbox WHERE id=$1',[receipt]));
      if(existing)return existing;
      const batch=await this.openBatch(db,id);
      await db.execute('INSERT INTO text_upload_inbox(id,owner,chat,"user",doc,batch) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',[receipt,id.key,String(id.chat),String(id.user),JSON.stringify(doc),batch.id]);
      await db.execute('UPDATE account_import_batches SET revision=revision+1,touched=$1 WHERE id=$2',[this.now(),batch.id]);
      return (await db.one('SELECT * FROM text_upload_inbox WHERE id=$1',[receipt]));
    });
    if(!['receiving','retry'].includes(row.status))return;
    // Start the receipt independently of both network download and admission.
    // batchLane serializes one sender per owner; no per-file Telegram messages.
    const progress=this.summaryBatch(id,row.batch).catch(()=>{});
    if(defer){this.launch('txt-'+receipt,()=>this.text(id,doc,consume,{receiptId:receipt}));return await progress;}
    // Only the deferred worker waits for acknowledgment, never admission/navigation.
    await progress;
    const active=await this.tx(async db=>{
      const batch=(await db.one('SELECT status FROM account_import_batches WHERE id=$1',[row.batch]));
      if(batch?.status!=='open'){await db.execute("UPDATE text_upload_inbox SET status='cancelled' WHERE id=$1",[receipt]);return false;}
      await db.execute('UPDATE text_upload_inbox SET attempts=attempts+1 WHERE id=$1',[receipt]);return true;
    });
    if(!active)return;
    try {
      if(doc.file_size!=null&&(!Number.isSafeInteger(doc.file_size)||doc.file_size<=0||doc.file_size>require('./accounts').MAX_COOKIE_FILE_BYTES))throw Object.assign(new Error('SIZE'),{code:'COOKIE_FILE_TOO_LARGE'});
      const buffer=await this.flows.downloadDocument(doc);
      if(buffer.length>require('./accounts').MAX_COOKIE_FILE_BYTES)throw Object.assign(new Error('SIZE'),{code:'COOKIE_FILE_TOO_LARGE'});
      const content=new TextDecoder('utf-8',{fatal:true}).decode(buffer);
      await consume(content,doc);
      await this.tx(async db=>await db.execute("UPDATE text_upload_inbox SET status=CASE WHEN (SELECT status FROM account_import_batches WHERE id=batch)='cancelled' THEN 'cancelled' ELSE 'done' END WHERE id=$1",[receipt]));
    }catch(error){
      // Keep transient and interrupted work durable; finite retries never spam the chat.
      // Native SQL/connection failures are not evidence of invalid cookies.
      // Leave the durable receipt resumable and propagate storage failures.
      if(/^[0-9A-Z]{5}$/.test(error.code||'') || error.code==='PG_IMPORT_SCHEMA_MISSING')throw error;
      const retryable=/^(TELEGRAM_|ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND)/.test(error.code||'');
      const attempts=await this.tx(async db=>(await db.one('SELECT attempts FROM text_upload_inbox WHERE id=$1',[receipt])).attempts);
      if(retryable&&attempts<3)await this.tx(async db=>await db.execute("UPDATE text_upload_inbox SET status=CASE WHEN (SELECT status FROM account_import_batches WHERE id=batch)='open' THEN 'retry' ELSE 'cancelled' END WHERE id=$1",[receipt]));
      else {await this.rejectAccount(id,doc,error.code==='COOKIE_FILE_TOO_LARGE'?'حجم يتجاوز 1MiB':retryable?'تعذر التنزيل':'كوكيز غير صالحة');await this.tx(async db=>await db.execute("UPDATE text_upload_inbox SET status=CASE WHEN (SELECT status FROM account_import_batches WHERE id=batch)='open' THEN 'invalid' ELSE 'cancelled' END WHERE id=$1",[receipt]));}
    }finally{
      await this.tx(async db=>await db.execute("UPDATE account_import_batches SET touched=$1 WHERE id=$2 AND status='open'",[this.now(),row.batch]));
      this.scheduleSummary(id);
    }
  }
  identity(row) { return {key:row.owner,chat:row.chat,user:row.user}; }
  async recover() {
    await this.initialize();
    await this.tx(async db=>db.execute("UPDATE account_import_batches SET collecting=0 WHERE status='open'; UPDATE account_import_batches SET prompt_state='ambiguous' WHERE prompt_state='sending'; UPDATE account_import_batches SET result_state='ambiguous' WHERE result_state='sending'"));
    // Only files staged by this implementation have a durable ownership marker.
    // Never adopt or garbage-collect historical/ambiguous imports.
    const cleanup=await this.tx(async db=>(await db.all("SELECT j.* FROM file_import_jobs j JOIN account_import_batches b ON b.id=j.batch AND b.owner=j.owner JOIN text_upload_inbox i ON i.id=(j.doc::jsonb->>'_importReceipt') AND i.owner=j.owner WHERE j.kind='txt' AND j.staging_owned=1 AND j.status IN ('cancelled','failed','invalid','duplicate') AND b.status IN ('done','cancelled') AND j.cookiefile IS NOT NULL",[])));
    for(const row of cleanup){await this.removeStagedCookie(row.cookiefile);await this.tx(async db=>await db.execute('UPDATE file_import_jobs SET staging_owned=0 WHERE id=$1',[row.id]));}
    // Recovery resumes stored receipts only. Fresh uploads after restart always
    // receive a separate collection, never a historical approval's membership.
    const rows=await this.tx(async db=>(await db.all("SELECT * FROM file_import_jobs WHERE kind='csv' AND status IN ('receiving','processing')",[])));
    for(const row of rows){
      const doc=parseJson(row.doc);
      if(!doc||typeof doc!=='object'){await this.tx(async db=>db.execute('UPDATE file_import_jobs SET status=$1,error=$2 WHERE id=$3',['invalid','CORRUPT_METADATA',row.id])).catch(()=>{});continue;}
      this.launch(row.id,()=>this.csv(this.identity(row),doc,row.id));
    }
    const inbox=await this.tx(async db=>(await db.all("SELECT i.* FROM text_upload_inbox i JOIN account_import_batches b ON b.id=i.batch WHERE i.status IN ('receiving','retry') AND b.status='open'",[])));
    for(const entry of inbox){
      const doc=parseJson(entry.doc);
      if(!doc||typeof doc!=='object'){await this.tx(async db=>db.execute("UPDATE text_upload_inbox SET status='cancelled' WHERE id=$1",[entry.id])).catch(()=>{});continue;}
      this.resumeText(entry);
    }
    const batches=await this.tx(async db=>(await db.all("SELECT * FROM account_import_batches WHERE status='open' OR (status='done' AND (retired=0 OR result_state IN ('pending','retry'))) OR (status='cancelled' AND retired=0)",[])));
    // A permanent Telegram rejection is terminal; only explicit operator action
    // may request a new delivery. Recovery must not create a restart retry loop.
    for(const batch of batches){if(batch.status==='open')this.scheduleSummary(this.identity(batch));else await this.batchLane(batch.owner,()=>this.deliverBatch(batch.id)).catch(()=>{});}
  }
  resumeText(entry){const doc=parseJson(entry?.doc);if(!doc||typeof doc!=='object')return Promise.resolve();const id=this.identity(entry);return this.launch('txt-'+entry.id,()=>this.text(id,doc,(content,d)=>this.flows.consumeAccountText(id,content,d),{receiptId:entry.id}));}
  launch(id, fn) {
    if (this.tasks.has(id)) return this.tasks.get(id);
    // A single streaming worker preserves upload order and bounds disk/CPU use.
    const lane=id.startsWith('txt-')?'txtTail':'csvTail';
    const task = (this[lane] || Promise.resolve()).then(fn).catch(() => {}).finally(() => this.tasks.delete(id));
    this[lane] = task;
    this.tasks.set(id,task); return task;
  }
  async idle() {
    // A duplicate upload may enqueue its interrupted original while settling.
    while(this.tasks.size) await Promise.all([...this.tasks.values()]);
  }
  async shutdown() {
    this.stopping = true;
    for (const timer of this.summaryTimers.values()) clearTimeout(timer);
    this.summaryTimers.clear();
    await this.idle();
    await Promise.allSettled([...this.batchLanes.values()]);
  }
  async row(id) { return this.tx(async db => (await db.one('SELECT * FROM file_import_jobs WHERE id=$1',[id]))); }
  async stageCookie(file,insert) {
    try {return await this.tx(async db=>{const inserted=await insert(db);if(inserted)await db.execute("UPDATE file_import_jobs SET staging_owned=1 WHERE cookiefile=$1 AND kind='txt'",[file]);return inserted;});}
    catch(error){await this.removeStagedCookie(file);throw error;}
  }
  async removeStagedCookie(file) {
    if (!file) return;
    const storeDir = path.dirname(this.store?.file || this.store?.dataDir || '/tmp');
    const root = path.resolve(storeDir, 'cookies') + path.sep;
    const resolved = path.resolve(String(file));
    if (!resolved.startsWith(root)) return;
    const accounts = this.store.section ? await this.store.section('accounts') : (typeof this.flows.bot.accounts?.list === 'function' ? await this.flows.bot.accounts.list() : (this.store.accounts || []));
    if (accounts.some(a => a.cookieFile && path.resolve(a.cookieFile) === resolved)) return;
    const inUse = await this.tx(async db => {
      const active = await db.one("SELECT 1 FROM file_import_jobs WHERE cookiefile=$1 AND status IN ('pending','update_pending','done')", [file]);
      return !!active;
    }).catch(() => false);
    if (inUse) return;
    await fsp.unlink(resolved).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  async file(id, doc, limit) {
    const storeDir = path.dirname(this.store?.file || this.store?.dataDir || '/tmp');
    const directory = path.join(storeDir, 'imports');
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    const target = path.join(directory,id+'.upload');
    try { if ((await fsp.stat(target)).size > 0) return target; } catch {}
    if (this.flows.downloadDocumentToFile) await this.flows.downloadDocumentToFile(doc,target,{maxBytes:limit});
    else throw new Error('STREAM_DOWNLOAD_UNAVAILABLE');
    const handle=await fsp.open(target,'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    return target;
  }
  async csvIdentity(id, doc) {
    const retention=typeof this.store.section==='function'?await this.store.section('dailyRetention'):(typeof this.store.load==='function'?(await this.store.load())?.dailyRetention:null);
    const storeEpoch=parseRetentionEpoch(retention?.epoch,0);
    const epoch=parseRetentionEpoch(doc?._retentionEpoch,storeEpoch);
    const next={...doc,_retentionEpoch:epoch};
    const base=id.key+':csv:'+(doc.file_unique_id||doc.file_id);
    return {doc:next,jobId:digest(base+(epoch?':retention:'+epoch:''))};
  }
  async csvReceipt(id, doc, jobId) {
    await this.initialize();
    if(!jobId){const identity=await this.csvIdentity(id,doc);jobId=identity.jobId;doc=identity.doc;}
    let job = await this.row(jobId);
    if (!job) {
      await this.tx(async db => {
        await db.execute("INSERT INTO file_import_jobs(id,owner,kind,status,doc,chat,\"user\") VALUES($1,$2,'csv','receiving',$3,$4,$5) ON CONFLICT(id) DO NOTHING", [
          jobId, id.key, JSON.stringify(doc || {}), String(id.chat), String(id.user)
        ]);
      });
      job = await this.row(jobId);
    }
    let curDoc = {};
    try { curDoc = typeof job?.doc === 'string' ? JSON.parse(job.doc) : (job?.doc || {}); } catch {}
    curDoc = { ...(doc || {}), ...curDoc };
    const prog = curDoc._progress;
    if (prog?.state === 'delivered' && prog.messageId) {
      return { message_id: prog.messageId };
    }
    if (['ambiguous', 'rejected'].includes(prog?.state)) {
      return undefined;
    }
    if (prog?.state === 'sending') return undefined;
    const claimed = await this.tx(async db => {
      const current = await db.one('SELECT doc FROM file_import_jobs WHERE id=$1', [jobId]);
      let d = {};
      try { d = typeof current?.doc === 'string' ? JSON.parse(current.doc) : (current?.doc || {}); } catch {}
      d = { ...(doc || {}), ...d };
      if (d._progress?.state === 'delivered' && d._progress.messageId) {
        return { already: true, progress: d._progress };
      }
      if (['ambiguous', 'rejected'].includes(d._progress?.state)) {
        return { already: true, progress: d._progress };
      }
      if (d._progress?.state === 'sending') {
        return { already: true, progress: d._progress };
      }
      d._progress = { state: 'sending', messageId: d._progress?.messageId || null };
      await db.execute('UPDATE file_import_jobs SET doc=$1 WHERE id=$2', [JSON.stringify(d), jobId]);
      return { already: false, doc: d };
    });
    if (claimed.already) {
      if (claimed.progress?.state === 'delivered' && claimed.progress.messageId) {
        return { message_id: claimed.progress.messageId };
      }
      return undefined;
    }
    let receipt;
    try {
      receipt = await this.flows.notice(id, '⏳ جاري استيراد ملف المنشورات...');
      if (!Number.isSafeInteger(receipt?.message_id) || receipt.message_id <= 0) {
        throw Object.assign(new Error('Unconfirmed CSV receipt'), { ambiguous: true, code: 'TELEGRAM_INVALID_RESPONSE' });
      }
    } catch (error) {
      const definite = !!error.telegramCode && !error.ambiguous;
      const state = definite ? 'rejected' : 'ambiguous';
      await this.tx(async db => {
        const current = await db.one('SELECT doc FROM file_import_jobs WHERE id=$1', [jobId]);
        let d = {};
        try { d = typeof current?.doc === 'string' ? JSON.parse(current.doc) : (current?.doc || {}); } catch {}
        d._progress = { state, messageId: d._progress?.messageId || null };
        await db.execute('UPDATE file_import_jobs SET doc=$1 WHERE id=$2', [JSON.stringify(d), jobId]);
      });
      return undefined;
    }
    await this.tx(async db => {
      const current = await db.one('SELECT doc FROM file_import_jobs WHERE id=$1', [jobId]);
      let d = {};
      try { d = typeof current?.doc === 'string' ? JSON.parse(current.doc) : (current?.doc || {}); } catch {}
      d._progress = { state: 'delivered', messageId: receipt.message_id };
      await db.execute('UPDATE file_import_jobs SET doc=$1 WHERE id=$2', [JSON.stringify(d), jobId]);
    });
    return receipt;
  }
  async csvReport(id, jobId, text) {
    await this.initialize();
    const job = await this.row(jobId);
    if (!job) return undefined;
    let jobDoc = {};
    try { jobDoc = typeof job.doc === 'string' ? JSON.parse(job.doc) : (job.doc || {}); } catch {}
    const messageId = jobDoc._progress?.messageId;
    if (!messageId || jobDoc._progress?.state === 'rejected') return undefined;
    try {
      const res = await this.flows.bot.transport.editMessageText(id.chat, messageId, text, { _background: true });
      return res || { message_id: messageId };
    } catch (error) {
      const unchanged = error.telegramCode === 400 && /message is not modified/i.test(error.message || '');
      if (unchanged) return { message_id: messageId };
      const definite = !!error.telegramCode && !error.ambiguous;
      if (!definite) {
        await this.tx(async db => {
          const current = await db.one('SELECT doc FROM file_import_jobs WHERE id=$1', [jobId]);
          let d = {};
          try { d = typeof current?.doc === 'string' ? JSON.parse(current.doc) : (current?.doc || {}); } catch {}
          if (d._progress) d._progress.state = 'ambiguous';
          await db.execute('UPDATE file_import_jobs SET doc=$1 WHERE id=$2', [JSON.stringify(d), jobId]);
        });
      } else if (error.telegramCode === 400 && /message to edit not found/i.test(error.message || '')) {
        await this.tx(async db => {
          const current = await db.one('SELECT doc FROM file_import_jobs WHERE id=$1', [jobId]);
          let d = {};
          try { d = typeof current?.doc === 'string' ? JSON.parse(current.doc) : (current?.doc || {}); } catch {}
          if (d._progress) d._progress.state = 'rejected';
          await db.execute('UPDATE file_import_jobs SET doc=$1 WHERE id=$2', [JSON.stringify(d), jobId]);
        });
      }
      return undefined;
    }
  }
  async csv(id, doc, suppliedId) {
    await this.initialize();
    const explicitEpoch=parseRetentionEpoch(doc?._retentionEpoch,null);
    const identity=suppliedId?{jobId:suppliedId,doc}:await this.csvIdentity(id,doc);
    const jobId=identity.jobId;doc=identity.doc;
    await this.tx(async db => await db.execute("INSERT INTO file_import_jobs(id,owner,kind,status,doc,chat,\"user\") VALUES($1,$2,'csv','receiving',$3,$4,$5) ON CONFLICT DO NOTHING",[jobId,id.key,JSON.stringify(doc),String(id.chat),String(id.user)]));
    await this.csvReceipt(id, doc, jobId);
    let job = await this.row(jobId);
    if (this.stopping) return job;
    if (['done','duplicate','invalid'].includes(job.status)) {
      await this.csvReport(id, jobId, job.status==='done' ? `هذا الملف مستورد بالفعل: المضافة ${job.added} | المكررة ${job.duplicates} | المرفوضة ${job.rejected}.` : job.status==='duplicate' ? 'هذا الملف مكرر؛ لم تتكرر إضافته.' : 'سبق رفض هذا الملف؛ أرسل نسخة مصححة.').catch(()=>{});
      return job;
    }
    let file=null;
    try {
      file = await this.file(jobId,doc,MAX_CSV_BYTES);
      const sha = crypto.createHash('sha256');let size=0;
      for await (const chunk of fs.createReadStream(file)) {size+=chunk.length;if(size>MAX_CSV_BYTES)throw new Error('FILE_TOO_LARGE');sha.update(chunk);}
      const contentHash = sha.digest('hex');
      const persistedDoc=parseJson(job?.doc);
      let effectiveEpoch=explicitEpoch??parseRetentionEpoch(doc?._retentionEpoch,null);
      if(effectiveEpoch==null){try{effectiveEpoch=parseRetentionEpoch(persistedDoc?._retentionEpoch,0);}catch{effectiveEpoch=0;}}
      const importDigest=effectiveEpoch>0?String(effectiveEpoch)+':'+contentHash:contentHash;
      let other = await this.tx(repo=>repo.claimCsvDigest(id.key,jobId,importDigest,file));
      if (!other && effectiveEpoch>0) {
        other = await this.tx(async db=>db.one("SELECT id FROM file_import_jobs WHERE owner=$1 AND kind='csv' AND id<>$2 AND status IN ('receiving','processing') AND (digest=$3 OR right(digest, length($3)+1)=':'||$3) LIMIT 1",[id.key,jobId,contentHash]));
      }
      if (other) {
        await this.tx(async db=>await db.execute("UPDATE file_import_jobs SET status='duplicate' WHERE id=$1",[jobId]));
        await fsp.unlink(file).catch(()=>{});
        const original=await this.row(other.id);
        const originalDoc=parseJson(original?.doc);
        if(original&&['receiving','processing'].includes(original.status)&&originalDoc&&typeof originalDoc==='object'){
          this.launch(original.id,()=>this.csv(this.identity(original),originalDoc,original.id));
        }
        await this.csvReport(id, jobId, 'هذا الملف مستورد أو قيد الاستيراد بالفعل؛ لم تتكرر إضافته.').catch(()=>{});
        return this.row(jobId);
      }
      job=await this.row(jobId);let fields=parseJson(job.fields);if(!Array.isArray(fields))fields=null;let index=0,batch=[],batchBytes=0;
      let progressAt=job.checkpoint;
      for await (const line of records(file)) {
        if (this.stopping) return this.row(jobId); // Uncommitted rows replay from durable checkpoint.
        if (!line.trim()) continue;
        index++;
        if (!fields) {
          let first;
          try { first=parseLine(line).map(v=>v.trim().toLowerCase()); } catch { throw new Error('INVALID_HEADER'); }
          const hasHeader=first.some(v=>Object.hasOwn(headers,v));
          fields=hasHeader ? first.map(v=>headers[v]):(first.length===2?['text','media']:['text']);
          if (fields.some(v=>!v)||new Set(fields).size!==fields.length||!fields.includes('text')) throw new Error('INVALID_HEADER');
          await this.tx(async db=>await db.execute('UPDATE file_import_jobs SET fields=$1,checkpoint=$2 WHERE id=$3',[JSON.stringify(fields),hasHeader?index:0,jobId]));
          if(hasHeader)continue;
        }
        if(index<=job.checkpoint)continue;
        let payload,error;
        try {
          if(line.includes('\0'))throw new Error(line==='\0OVERSIZED_ROW'?'ROW_TOO_LARGE':'INVALID_CHARACTER');
          const values=parseLine(line);if(values.length!==fields.length)throw new Error('COLUMN_COUNT');
          const row=Object.fromEntries(fields.map((f,i)=>[f,values[i]]));
          if(!row.text.trim())throw new Error('EMPTY_TEXT');
          if(row.media&&FORMULA_PREFIX.test(row.media.trim()))throw new Error('UNSAFE_MEDIA');
          const account=fields.includes('account')?String(row.account??'').trim():'';
          payload={text:row.text,...(row.media?{media:row.media}:{}),...(account?{account}:{})};
        }catch(e){error=['COLUMN_COUNT','EMPTY_TEXT','UNSAFE_MEDIA','ROW_TOO_LARGE','INVALID_CHARACTER'].includes(e.message)?e.message:'MALFORMED_ROW';}
        batch.push({index,payload,error});batchBytes+=Buffer.byteLength(line);
        if(batch.length>=5000 || batchBytes>=2*1024*1024){
          await this.commit(jobId,batch);batch=[];batchBytes=0;await new Promise(r=>setImmediate(r));
          if(index-progressAt>=10000){progressAt=index;await this.csvReport(id, jobId, `جارٍ الاستيراد: ${index-1} صف.`).catch(()=>{});}
        }
      }
      if(!fields)throw new Error('INVALID_HEADER');
      if(batch.length)await this.commit(jobId,batch);
      await this.tx(async db=>await db.execute("UPDATE file_import_jobs SET status='done' WHERE id=$1",[jobId]));
      job=await this.row(jobId);await fsp.unlink(file).catch(()=>{});
      // Notification failure must never reopen a completed import or redownload its file.
      await this.csvReport(id, jobId, `اكتمل الاستيراد: المستلمة ${job.received} | المضافة ${job.added} | المكررة ${job.duplicates} | المرفوضة ${job.rejected}.\nالأسباب: ${job.reasons}\nأُضيفت للطابور فقط؛ لم يبدأ النشر.`).catch(()=>{});
      return job;
    } catch(e) {
      const invalid=['INVALID_HEADER','CSV_RECORD_TOO_LARGE','FILE_TOO_LARGE','ERR_ENCODING_INVALID_ENCODED_DATA'].includes(e?.code||e?.message);
      if(invalid&&file)await fsp.unlink(file).catch(()=>{});
      await this.tx(async db=>await db.execute('UPDATE file_import_jobs SET status=$1,error=$2 WHERE id=$3',[invalid?'invalid':'processing',invalid?'INVALID_FILE':'INTERRUPTED',jobId])).catch(()=>{});
      await this.csvReport(id, jobId, invalid?'الملف غير صالح أو يتجاوز الحد الفعلي 20 ميجابايت؛ الصفوف الملتزمة محفوظة.':'توقف الاستيراد مؤقتاً؛ التقدم محفوظ ويستكمل عند إعادة إرسال الملف أو إعادة التشغيل.').catch(()=>{});
      throw e;
    }
  }
  async commit(jobId,batch) {
    return this.tx(repo=>repo.commitCsv(jobId,batch));
  }
  async resolveImportIdentity(cookieFile, username, uid, accountId) {
    const fallback={status:username?'needs_identity':'needs_username',username:username||null,uid:uid||null};
    if(!this.flows.isolatedVerifier?.verify)return fallback;
    let result;
    try {
      result=await this.flows.isolatedVerifier.verify({id:accountId,cookieFile,username:username||null,...(uid?{userId:uid}:{})},
        {persistResult:false,isDraft:true,signal:AbortSignal.timeout(45000)});
    } catch {return fallback;}
    if(result?.isolated!==true||result?.vpnHealthy!==true||result?.authenticated!==true||
      !/^[A-Za-z0-9_]{1,15}$/.test(result.username||'')||typeof result.userId!=='string'||!/^\d+$/.test(result.userId))return fallback;
    if((username&&username.toLowerCase()!==result.username.toLowerCase())||(uid&&uid!==result.userId))
      return {...fallback,status:'identity_conflict'};
    return {status:'pending',username:result.username,uid:result.userId,proof:JSON.stringify({username:result.username,userId:result.userId,contentHash:digest(await fsp.readFile(cookieFile,'utf8'))})};
  }
  async bindVerifiedIdentity(identity) {
    if(identity.status!=='pending')return identity;
    const accounts=this.store.section?await this.store.section('accounts'):await this.flows.bot.accounts.list();
    const byUid=accounts.filter(a=>String(a.userId)===identity.uid);
    const byName=accounts.filter(a=>a.username?.toLowerCase()===identity.username.toLowerCase());
    const candidates=[...new Map([...byUid,...byName].map(a=>[a.id,a])).values()];
    if(candidates.length>1)return {...identity,status:'identity_conflict'};
    const target=candidates[0];
    if(!target)return identity;
    let expected=target.userId?String(target.userId):null;
    if(!expected)try{expected=parseCookieUid(parseCookies(await fsp.readFile(target.cookieFile,'utf8')).cookies.find(c=>c.name==='twid')?.value);}catch{}
    if(!expected)return {...identity,status:'needs_identity'};
    if(expected!==identity.uid||target.username?.toLowerCase()!==identity.username.toLowerCase())return {...identity,status:'identity_conflict'};
    return {...identity,status:'update_pending',target_id:target.id,previous_cookie:target.cookieFile};
  }
  async account(id,doc,content,usernameHint) {
    await this.initialize();const parsed=parseCookies(content).cookies;
    const auth=parsed.filter(c=>{try{return /(^|\.)x\.com$|(^|\.)twitter\.com$/.test(c.domain||new URL(c.url).hostname);}catch{return false;}});
    if(!['auth_token','ct0'].every(n=>auth.some(c=>c.name===n&&c.value&&(!c.expires||c.expires===-1||c.expires>Date.now()/1000))))throw new Error('INVALID_COOKIES');
    const credential=digest(auth.find(c=>c.name==='auth_token').value);
    const jobId=digest(id.key+':txt:'+(doc._importReceipt || digest(JSON.stringify(auth.map(c=>[c.name,c.value,c.domain||c.url]).sort((a,b)=>a[0].localeCompare(b[0]))))));let job=await this.row(jobId);
    if(job){this.scheduleSummary(id);return job;}
    const inbox=await this.tx(async db=>(await db.one('SELECT batch FROM text_upload_inbox WHERE id=$1 AND owner=$2',[doc._importReceipt,id.key])));
    const batch=await this.tx(async db=>(await db.one("SELECT * FROM account_import_batches WHERE id=$1 AND status='open'",[inbox?.batch||''])));
    if(!batch)return {status:'cancelled'};
    const uid=parseCookieUid(auth.find(c=>c.name==='twid')?.value);
    const accounts=this.store.section ? await this.store.section('accounts') : await this.flows.bot.accounts.list();
    const byUid=uid&&accounts.find(a=>String(a.userId)===uid);
    const byName=usernameHint&&accounts.find(a=>a.username?.toLowerCase()===usernameHint.toLowerCase());
    if(byUid&&byName&&byUid.id!==byName.id)return this.rejectAccount(id,doc,'تعارض هوية',usernameHint,'identity_conflict');
    let existing=byUid||byName;
    if (!existing) for (const a of accounts) {
      // Compare credentials only in memory, never log or persist raw values in import metadata.
      const storeDir = path.dirname(this.store?.file || this.store?.dataDir || '/tmp');
      if (!a.cookieFile || !path.resolve(a.cookieFile).startsWith(storeDir+path.sep)) continue;
      try {const cookies=parseCookies(await fsp.readFile(a.cookieFile,'utf8')).cookies;
        const storedUid=parseCookieUid(cookies.find(c=>c.name==='twid')?.value);
        if((uid&&storedUid===uid)||cookies.some(c=>c.name==='auth_token'&&digest(c.value)===credential)){existing=a;break;}
      }catch{}
    }
    if (existing) {
      let oldUid=null;
      try {oldUid=parseCookieUid(parseCookies(await fsp.readFile(existing.cookieFile,'utf8')).cookies.find(c=>c.name==='twid')?.value);}catch{}
      const expected=existing.userId ? String(existing.userId):oldUid;
      // Fail closed: a filename/username is only a hint, never replacement evidence.
      if(!expected || (uid&&uid!==expected) || (uid&&oldUid&&oldUid!==uid) || (usernameHint&&existing.username&&usernameHint.toLowerCase()!==existing.username.toLowerCase())) {
        return this.rejectAccount(id,doc,'هوية غير مطابقة',existing.username||usernameHint);
      }
      let unchanged=false;
      try { unchanged=digest(await fsp.readFile(existing.cookieFile,'utf8'))===digest(content); } catch {}
      if(unchanged){
        const inserted=await this.tx(async db=>(await db.execute("INSERT INTO file_import_jobs(id,owner,kind,status,doc,chat,\"user\",username,userid,credential,target_id,previous_cookie,batch,content_hash) SELECT $1,$2,'txt','unchanged',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12 WHERE EXISTS(SELECT 1 FROM account_import_batches WHERE id=$13 AND status='open') ON CONFLICT DO NOTHING",[jobId,id.key,JSON.stringify(doc),String(id.chat),String(id.user),existing.username||usernameHint,uid,credential,existing.id,existing.cookieFile,batch.id,digest(content),batch.id])).changes===1);
        if(!inserted)return {status:'cancelled'};
        this.scheduleSummary(id);return this.row(jobId);
      }
      const cookie=await this.flows.bot.cookies.storeContent('update-'+jobId.slice(0,32),content);
      const identity=await this.resolveImportIdentity(cookie.path,existing.username||usernameHint,expected,existing.id);
      const status=identity.status==='pending'?'update_pending':identity.status;
      const inserted=await this.stageCookie(cookie.path,async db=>(await db.execute("INSERT INTO file_import_jobs(id,owner,kind,status,doc,chat,\"user\",username,userid,cookiefile,credential,target_id,previous_cookie,batch,content_hash,identity_proof) SELECT $1,$2,'txt',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15 WHERE EXISTS(SELECT 1 FROM account_import_batches WHERE id=$16 AND status='open') ON CONFLICT DO NOTHING",[jobId,id.key,status,JSON.stringify(doc),String(id.chat),String(id.user),existing.username||usernameHint,identity.uid,cookie.path,credential,existing.id,existing.cookieFile,batch.id,digest(content),identity.proof||null,batch.id])).changes===1);
      if(!inserted){await this.removeStagedCookie(cookie.path);return {status:'cancelled'};}
      this.scheduleSummary(id);return this.row(jobId);
    }
    const accountId='x-'+jobId.slice(0,20);const cookie=await this.flows.bot.cookies.storeContent(accountId,content);
    const identity=await this.bindVerifiedIdentity(await this.resolveImportIdentity(cookie.path,usernameHint,uid,accountId));
    const inserted=await this.stageCookie(cookie.path,async db=>(await db.execute("INSERT INTO file_import_jobs(id,owner,kind,status,doc,chat,\"user\",username,userid,cookiefile,credential,batch,content_hash,identity_proof,target_id,previous_cookie) SELECT $1,$2,'txt',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15 WHERE EXISTS(SELECT 1 FROM account_import_batches WHERE id=$16 AND status='open') ON CONFLICT DO NOTHING",[jobId,id.key,identity.status,JSON.stringify(doc),String(id.chat),String(id.user),identity.username,identity.uid,cookie.path,credential,batch.id,digest(content),identity.proof||null,identity.target_id||null,identity.previous_cookie||null,batch.id])).changes===1);
    if(!inserted){await this.removeStagedCookie(cookie.path);return {status:'cancelled'};}
    this.scheduleSummary(id);return this.row(jobId);
  }
  async rejectAccount(id,doc,reason,username=null,status='invalid'){
    const jobId=digest(id.key+':txt:'+doc._importReceipt);
    return this.tx(async db=>{
      const inbox=(await db.one('SELECT batch FROM text_upload_inbox WHERE id=$1 AND owner=$2',[doc._importReceipt,id.key]));
      if(!inbox)return;
      await db.execute("INSERT INTO file_import_jobs(id,owner,kind,status,doc,chat,\"user\",username,error,batch) SELECT $1,$2,'txt',$3,$4,$5,$6,$7,$8,$9 WHERE EXISTS(SELECT 1 FROM account_import_batches WHERE id=$10 AND status='open') ON CONFLICT DO NOTHING",[jobId,id.key,status,JSON.stringify(doc),String(id.chat),String(id.user),username,reason,inbox.batch,inbox.batch]);
    });
  }
  scheduleSummary(id,delay=1200){
    if(this.stopping)return;
    const due=Date.now()+Math.max(1,delay),existing=this.summaryTimers.get(id.key);
    // Keep the earliest deadline; a continuous upload stream must not postpone
    // every progress edit indefinitely. Finalization still checks touched.
    if(existing&&existing.importDue<=due)return;
    clearTimeout(existing);
    const timer=setTimeout(()=>{this.summaryTimers.delete(id.key);this.summary(id).catch(()=>{});},Math.max(1,delay));
    timer.importDue=due;timer.unref?.();this.summaryTimers.set(id.key,timer);
  }
  async batchRows(db,batch){return (await db.all("SELECT * FROM file_import_jobs WHERE batch=$1 AND kind='txt' ORDER BY seq",[batch]));}
  planRows(rows){
    const conflicts=new Set(),duplicates=new Set();
    const usable=rows.filter(r=>['pending','update_pending','unchanged'].includes(r.status));
    const same=(a,b)=>(a.userid&&a.userid===b.userid)||(a.username&&a.username.toLowerCase()===b.username?.toLowerCase())||(a.credential&&a.credential===b.credential)||(a.target_id&&a.target_id===b.target_id);
    for(let i=0;i<usable.length;i++)for(let j=0;j<i;j++)if(same(usable[i],usable[j])){
      if(!usable[i].content_hash||usable[i].content_hash!==usable[j].content_hash){conflicts.add(usable[i].id);conflicts.add(usable[j].id);}else duplicates.add(usable[i].id);
    }
    return rows.map(row=>({row,reason:conflicts.has(row.id)?'تعارض ملفات':row.status==='needs_username'?'يلزم اسم المستخدم والتحقق':row.status==='needs_identity'?'تعذر التحقق من الهوية':row.status==='identity_conflict'?'تعارض هوية':row.error||null,
      action:conflicts.has(row.id)?'failed':duplicates.has(row.id)?'duplicate':row.status==='pending'?'add':row.status==='update_pending'?'update':row.status==='unchanged'?'unchanged':'failed'}));
  }
  label(row){
    if(/^[A-Za-z0-9_]{1,15}$/.test(row.username||''))return '@'+row.username;
    let doc={};try{doc=JSON.parse(row.doc);}catch{}
    return path.basename(String(doc.file_name||'TXT')).replace(/[\x00-\x1f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,'').slice(0,24)||'TXT';
  }
  batchText(plans,{result=false}={}){
    const groups=new Map();
    for(const p of plans){const key=p.action==='add'?(result?'تمت إضافة حسابات جديدة':'جديدة (غير مفعلة)'):p.action==='update'?(result?'تم تحديث حسابات موجودة':'موجودة (تحديث الكوكيز)'):p.action==='unchanged'?'موجودة (دون تغيير)':p.action==='duplicate'?'مكررة (نسخة واحدة)':`❌ تعذر: ${p.reason||'تعذر الحفظ'}`;
      if(!groups.has(key))groups.set(key,new Set());groups.get(key).add(this.label(p.row));}
    const instructions=plans.filter(p=>['needs_username','needs_identity'].includes(p.row.status)).map(p=>'لا حفظ قبل التحقق. للاستكمال: اسم '+p.row.id.slice(0,12)+' @username');
    const text=[result?'نتائج دفعة الحسابات':'الحسابات المستلمة — دفعة واحدة',...[...groups].map(([k,names])=>`${k}:\n${[...names].join('، ')}`),...instructions].join('\n\n');
    if(text.length<=4000)return text;
    // Telegram cannot contain an unbounded list. Keep complete labels and an
    // explicit overflow count; never strand a durable batch on a size error.
    let compact=result?'نتائج دفعة الحسابات':'الحسابات المستلمة — دفعة واحدة',omitted=0;
    for(const [key,names] of groups){const shown=[];for(const name of names){
      if(compact.length+key.length+shown.join('، ').length+name.length+120<=3900)shown.push(name);else omitted++;
    }if(shown.length)compact+='\n\n'+key+':\n'+shown.join('، ');}
    return compact+'\n\nأسماء إضافية محفوظة في الدفعة: '+omitted+' — العملية تشمل جميع الملفات ('+plans.length+').';
  }
  async summary(id){
    await this.initialize();
    const batches=await this.tx(async db=>{
      const primary=await db.all("SELECT id FROM account_import_batches WHERE owner=$1 AND status='open' AND (collecting=1 OR prompt_signature IS NOT NULL) ORDER BY collecting DESC,seq DESC",[id.key]);
      const prePromptRows=await db.all("SELECT b.id, i.doc FROM account_import_batches b JOIN text_upload_inbox i ON i.batch=b.id AND i.owner=b.owner WHERE b.owner=$1 AND b.status='open' AND b.collecting=0 AND b.prompt_signature IS NULL ORDER BY b.seq DESC",[id.key]);
      const seenIds=new Set(primary.map(b=>b.id));
      const byBatch=new Map();
      for(const r of prePromptRows||[]){
        if(!r?.id||seenIds.has(r.id))continue;
        if(!byBatch.has(r.id))byBatch.set(r.id,[]);
        byBatch.get(r.id).push(r.doc);
      }
      const extra=[];
      for(const [batchId,docs] of byBatch){
        if(docs.length>0&&docs.every(raw=>parseJson(raw)?._autoImport===true))extra.push({id:batchId});
      }
      return [...primary,...extra];
    });
    for(const b of batches)await this.summaryBatch(id,b.id);
    const results=await this.tx(db=>db.all("SELECT id FROM account_import_batches WHERE owner=$1 AND status='done' AND result_state='retry'",[id.key]));
    for(const b of results)await this.batchLane(id.key,()=>this.deliverBatch(b.id));
  }
  async summaryBatch(id,batchId){
    return this.batchLane(id.key,async()=>{
      const snapshot=await this.tx(async db=>{
        const batch=(await db.one("SELECT * FROM account_import_batches WHERE id=$1 AND owner=$2 AND status='open'",[batchId,id.key]));
        if(!batch)return null;
        const waiting=(await db.all("SELECT * FROM text_upload_inbox WHERE batch=$1 AND status IN ('receiving','retry')",[batch.id]));
        return {batch,waiting,rows:await this.batchRows(db,batch.id)};
      });
      if(!snapshot||this.stopping)return;
      const {batch,waiting,rows}=snapshot;
      const initial=!batch.prompt_id&&batch.prompt_attempts===0;
      const delay=1200-(this.now()-batch.touched),final=!initial&&waiting.length===0&&delay<=0;
      if(waiting.length){for(const entry of waiting)this.resumeText(entry);this.scheduleSummary(id,350);}
      else if(!final)this.scheduleSummary(id,Math.max(1,delay));
      if(final&&!rows.length)return;
      if(final){
        const inboxDocs=await this.tx(async db=>await db.all("SELECT doc FROM text_upload_inbox WHERE batch=$1",[batch.id]));
        const isAutoImport=inboxDocs.length>0&&inboxDocs.every(entry=>{
          try{return JSON.parse(entry.doc)._autoImport===true;}catch{return false;}
        });
        if(!isAutoImport){
          await this.tx(async db=>await db.execute("UPDATE account_import_batches SET collecting=0 WHERE id=$1",[batch.id]));
          return;
        }
        const rowsCopy=rows.map(r=>({...r}));
        for(const plan of this.planRows(rowsCopy).filter(p=>p.row.cookiefile&&['add','update','duplicate'].includes(p.action))){
          try{await this.validateStaged(plan.row);}catch(e){plan.row.status='invalid';plan.row.error='ملف مرحلي غير صالح';}
        }
        const plans=this.planRows(rowsCopy);
        const committed=await this.tx(async db=>{
          const currentBatch=(await db.one("SELECT * FROM account_import_batches WHERE id=$1 AND status='open'",[batch.id]));
          if(!currentBatch||currentBatch.revision!==batch.revision)return false;
          const state=await db.header();
          const accounts=state.accounts||[];let changed=false;
          for(const plan of plans){const {row}=plan;
            if(['needs_username','needs_identity'].includes(row.status))continue;
            if(plan.action==='update'){
              const account=accounts.find(a=>a.id===row.target_id);
              if(!account||account.cookieFile!==row.previous_cookie||(account.userId&&String(account.userId)!==row.userid)){plan.action='failed';plan.reason='تعارض أحدث';}
              else {
                account.cookieFile=row.cookiefile;
                delete account.verifiedAt;
                account.checkGeneration=crypto.randomUUID();
                if(state.telegramUi?.accountChecks)delete state.telegramUi.accountChecks[row.target_id];
                changed=true;
              }
            }else if(plan.action==='add'){
              if(accounts.some(a=>a.id==='x-'+row.id.slice(0,20)||(row.userid&&String(a.userId)===row.userid)||a.username?.toLowerCase()===row.username.toLowerCase())){plan.action='failed';plan.reason='الحساب أضيف لاحقاً';}
              else {accounts.push(accountRecord({id:'x-'+row.id.slice(0,20),username:row.username,userId:row.userid||undefined,label:row.username,cookieFile:row.cookiefile,enabled:false}));changed=true;}
            }
            await db.execute('UPDATE file_import_jobs SET status=$1,error=$2 WHERE id=$3',[plan.action==='failed'?'failed':plan.action==='duplicate'?'duplicate':plan.action==='unchanged'?'unchanged':'done',plan.reason||null,row.id]);
          }
          const text=this.batchText(plans,{result:true});
          if(changed)await db.saveHeader(state);
          await db.execute("UPDATE account_import_batches SET status='done',result=$1,result_state='pending',collecting=0,prompt_id=coalesce(prompt_id,$2) WHERE id=$3",[text,batch.prompt_id||null,batch.id]);
          return true;
        });
        if(!committed){this.scheduleSummary(id);return;}
        for(const plan of plans.filter(p=>!['add','update'].includes(p.action)&&!['needs_username','needs_identity'].includes(p.row.status)))await this.removeStagedCookie(plan.row.cookiefile);
        try{await this.deliverBatch(batch.id);}catch(error){error.ambiguous=true;throw error;}
        return;
      }
      // Coalesce discoveries while downloads continue; first receipt never waits.
      if(!final&&batch.prompt_id&&this.now()-(this.progressAt?.get(batch.id)||0)<350){this.scheduleSummary(id,350);return;}
      // Unknown send outcomes cannot be safely replaced with a second message.
      if(batch.prompt_attempts>=3||(!batch.prompt_id&&['sending','ambiguous'].includes(batch.prompt_state)))return;
      const plans=this.planRows(rows);
      const text='📥 جاري تجميع حسابات الكوكيز'+(rows.length?'\n\n'+this.batchText(plans).split('\n\n').slice(1).join('\n\n'):'');
      const reply_markup={inline_keyboard:[]};
      const signature=digest(text+':progress');
      if(batch.prompt_signature===signature&&batch.prompt_state==='delivered')return;
      const prepared=await this.tx(async db=>{
        const b=(await db.one("SELECT * FROM account_import_batches WHERE id=$1 AND status='open' AND revision=$2",[batch.id,batch.revision]));
        if(!b)return false;
        await db.execute("UPDATE account_import_batches SET prompt_token=$1,prompt_revision=$2,displayed=$3,prompt_state=$4,prompt_attempts=prompt_attempts+1 WHERE id=$5",[null,-1,JSON.stringify([]),batch.prompt_id?'editing':'sending',batch.id]);return true;
      });
      if(!prepared){this.scheduleSummary(id);return;}
      let receipt;
      try{
        receipt=batch.prompt_id?await this.flows.bot.transport.editMessageText(id.chat,batch.prompt_id,text,{reply_markup,_background:true}):await this.flows.notice(id,text,{reply_markup});
        if(!Number.isSafeInteger(receipt?.message_id)||receipt.message_id<=0)throw Object.assign(new Error('Unconfirmed confirmation receipt'),{ambiguous:true,code:'TELEGRAM_INVALID_RESPONSE'});
      }catch(error){
        const unchanged=batch.prompt_id&&error.telegramCode===400&&/message is not modified/i.test(error.message||'');
        if(unchanged)receipt={message_id:batch.prompt_id};
        else {
          const definite=!!error.telegramCode&&!error.ambiguous;
          await this.tx(async db=>await db.execute('UPDATE account_import_batches SET prompt_state=$1 WHERE id=$2',[batch.prompt_id?'edit_failed':definite?'rejected':'ambiguous',batch.id]));
          // Retry only a known rejection, respect flood wait, cap persisted attempts.
          if(definite&&(error.telegramCode===429||error.telegramCode>=500)&&batch.prompt_attempts<2)
            this.scheduleSummary(id,Math.max(1200,(Number(error.retryAfter)||0)*1000));
          throw error;
        }
      }
      // Receipt persistence is outside the transport catch: never resend after local save failure.
      await this.tx(async db=>await db.execute("UPDATE account_import_batches SET prompt_id=$1,prompt_state='delivered',prompt_attempts=0,prompt_signature=$2 WHERE id=$3",[receipt.message_id,signature,batch.id]));
      this.progressAt ||= new Map();this.progressAt.set(batch.id,this.now());
      const latest=await this.tx(async db=>(await db.one('SELECT revision FROM account_import_batches WHERE id=$1',[batch.id])));if(latest.revision!==batch.revision)this.scheduleSummary(id);
      return receipt;
    });
  }
  async name(id,text){
    const m=/^اسم\s+([a-f0-9]{12})\s+@?([A-Za-z0-9_]{1,15})$/.exec(text);if(!m)return false;
    await this.initialize();return this.batchLane(id.key,async()=>{
      const row=await this.tx(async db=>(await db.one("SELECT j.* FROM file_import_jobs j JOIN account_import_batches b ON b.id=j.batch WHERE j.owner=$1 AND j.status IN ('needs_username','needs_identity') AND b.status IN ('open','done') AND substr(j.id,1,12)=$2",[id.key,m[1]])));
      if(!row)return true;
      await this.tx(async db=>{const b=(await db.one('SELECT status FROM account_import_batches WHERE id=$1',[row.batch]));if(b?.status==='done'){const next=await this.openBatch(db,id);await db.execute('UPDATE file_import_jobs SET batch=$1 WHERE id=$2',[next.id,row.id]);
        const stagedDoc=parseJson(row.doc)||{};
        await db.execute('UPDATE text_upload_inbox SET batch=$1 WHERE id=$2 AND owner=$3 AND batch=$4',[next.id,stagedDoc._importReceipt,id.key,row.batch]);await db.execute('UPDATE account_import_batches SET revision=revision+1,touched=$1 WHERE id=$2',[this.now(),next.id]);row.batch=next.id;}});
      const identity=await this.bindVerifiedIdentity(await this.resolveImportIdentity(row.cookiefile,m[2],row.userid,row.target_id||'x-'+row.id.slice(0,20)));
      await this.tx(async db=>{
        const changed=(await db.execute("UPDATE file_import_jobs SET username=$1,userid=$2,status=$3,identity_proof=$4,target_id=coalesce($5,target_id),previous_cookie=coalesce($6,previous_cookie),notified=0 WHERE id=$7 AND status IN ('needs_username','needs_identity') AND EXISTS(SELECT 1 FROM account_import_batches WHERE id=$8 AND status='open')",[identity.username,identity.uid,identity.status==='pending'&&row.target_id?'update_pending':identity.status,identity.proof||null,identity.target_id||null,identity.previous_cookie||null,row.id,row.batch])).changes;
        if(changed)await db.execute('UPDATE account_import_batches SET revision=revision+1,touched=$1 WHERE id=$2',[this.now(),row.batch]);
      });this.scheduleSummary(id);return true;
    });
  }
  async reconcilePrompt(db,id,selector,confirmation){
    const [batchId,token]=String(selector||'').split('.');
    if(!Number.isSafeInteger(confirmation?.message_id)||confirmation.message_id<=0)return;
    // The authenticated callback supplies the missing receipt, never fresh approval for later files.
    await db.execute("UPDATE account_import_batches SET prompt_id=$1,prompt_state='delivered',prompt_attempts=0 WHERE id=$2 AND owner=$3 AND status='open' AND prompt_id IS NULL AND prompt_token=$4 AND prompt_state IN ('sending','ambiguous')",[confirmation.message_id,batchId,id.key,token]);
  }
  async selectedBatch(db,id,selector,confirmation,{cancel=false}={}){
    const [batchId,token]=String(selector||'').split('.');
    const batch=(await db.one("SELECT * FROM account_import_batches WHERE id=$1 AND owner=$2 AND status='open'",[batchId,id.key]));
    if(!batch||(!cancel&&batch.prompt_token!==token))return null;
    if(!cancel&&(batch.prompt_revision!==batch.revision||!['delivered','ambiguous'].includes(batch.prompt_state)))return null;
    if(!Number.isSafeInteger(confirmation?.message_id)||confirmation.message_id<=0)return null;
    if(batch.prompt_id&&batch.prompt_id!==confirmation.message_id)return null;
    if(!batch.prompt_id&&batch.prompt_token!==token)return null;
    return batch;
  }
  async cancel(id,selector,confirmation){
    return {processed:false};
  }
  async validateStaged(row){
    const {validateCookieFile}=require('./accounts');const checked=await validateCookieFile(row.cookiefile);
    const c=parseCookies(checked.content).cookies;
    const auth=c.filter(v=>{try{return /(^|\.)x\.com$|(^|\.)twitter\.com$/.test(v.domain||new URL(v.url).hostname);}catch{return false;}});
    if(!['auth_token','ct0'].every(n=>auth.some(v=>v.name===n&&v.value&&(!v.expires||v.expires===-1||v.expires>Date.now()/1000))))throw new Error('INVALID_STAGED_COOKIES');
    const uid=parseCookieUid(auth.find(c=>c.name==='twid')?.value);
    let proof;try{proof=JSON.parse(row.identity_proof||'null');}catch{}
    if(['pending','update_pending'].includes(row.status)&&(!proof||proof.username?.toLowerCase()!==row.username?.toLowerCase()||proof.userId!==row.userid||proof.contentHash!==digest(checked.content)))throw new Error('IDENTITY_UNVERIFIED');
    if((uid&&uid!==row.userid)||digest(auth.find(c=>c.name==='auth_token')?.value||'')!==row.credential||(row.content_hash&&digest(checked.content)!==row.content_hash))throw new Error('STAGED_IDENTITY_CHANGED');
    if(row.status==='update_pending'){
      // Local consistency only; never opens X or claims authenticated identity verification.
      const previous=parseCookies((await validateCookieFile(row.previous_cookie)).content).cookies;
      const previousUid=parseCookieUid(previous.find(c=>c.name==='twid')?.value);
      if(previousUid&&previousUid!==row.userid)throw new Error('STAGED_IDENTITY_CHANGED');
    }
  }
  async confirm(id,selector,confirmation){
    return {processed:false};
  }
  async deliverBatch(batchId){
    let batch=await this.tx(async db=>(await db.one('SELECT * FROM account_import_batches WHERE id=$1',[batchId])));
    if(!batch||!['done','cancelled'].includes(batch.status))return;
    const id=this.identity(batch);
    if(batch.status==='cancelled'){
      if(!batch.retired&&batch.prompt_id){
        let retired=false;
        try{
          await this.flows.bot.transport.editMessageText(id.chat,batch.prompt_id,'أُلغيت دفعة الحسابات؛ لم تتغير الحسابات.',{reply_markup:{inline_keyboard:[]},_background:true});
          retired=true;
        }catch(e){if(e.telegramCode===400)retired=true;}
        if(retired)await this.tx(async db=>await db.execute('UPDATE account_import_batches SET retired=1 WHERE id=$1',[batchId]));
      }
      return;
    }
    if(batch.result_state==='retry' && batch.touched>this.now()){
      this.scheduleSummary(id,batch.touched-this.now());return;
    }
    if(batch.prompt_attempts>=3 || (!batch.prompt_id&&['sending','ambiguous'].includes(batch.prompt_state)))return;
    const claimed=await this.tx(async db=>(await db.execute("UPDATE account_import_batches SET result_state='sending',prompt_attempts=prompt_attempts+1 WHERE id=$1 AND status='done' AND (result_state='pending' OR (result_state='retry' AND touched<=$2) OR (result_state='ambiguous' AND prompt_id IS NOT NULL))",[batchId,this.now()])).changes===1);
    if(!claimed)return;
    let receipt;
    try{
      if(batch.prompt_id){
        receipt=await this.flows.bot.transport.editMessageText(id.chat,batch.prompt_id,batch.result,{reply_markup:{inline_keyboard:[]},_background:true});
        if(!Number.isSafeInteger(receipt?.message_id)||receipt.message_id<=0)receipt={message_id:batch.prompt_id};
      }else{
        receipt=await this.flows.notice(id,batch.result);
        if(!Number.isSafeInteger(receipt?.message_id)||receipt.message_id<=0)throw Object.assign(new Error('Unconfirmed result receipt'),{ambiguous:true,code:'TELEGRAM_INVALID_RESPONSE'});
      }
    }catch(error){
      const unchanged=batch.prompt_id&&error.telegramCode===400&&/message is not modified/i.test(error.message||'');
      if(unchanged){
        receipt={message_id:batch.prompt_id};
      }else{
        const definite=!!error.telegramCode&&!error.ambiguous;
        const retryable=batch.prompt_id && batch.prompt_attempts<2 && (!definite||error.telegramCode===429||error.telegramCode>=500);
        if(retryable){
          const delay=Math.max(1200,(Number(error.retryAfter)||0)*1000);
          await this.tx(db=>db.execute('UPDATE account_import_batches SET result_state=$1,touched=$2 WHERE id=$3',['retry',this.now()+delay,batchId]));
          this.scheduleSummary(id,delay);
        }else await this.tx(async db=>await db.execute('UPDATE account_import_batches SET result_state=$1 WHERE id=$2',[definite?'rejected':'ambiguous',batchId]));
        throw error;
      }
    }
    await this.tx(async db=>await db.execute("UPDATE account_import_batches SET result_state='delivered',result_id=$1,prompt_id=coalesce(prompt_id,$1),retired=1 WHERE id=$2",[receipt.message_id,batchId]));
  }
}
module.exports={FileImports,records,MAX_CSV_BYTES};
