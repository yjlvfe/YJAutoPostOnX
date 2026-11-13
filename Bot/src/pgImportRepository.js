'use strict';
// Native async PostgreSQL repository. No schema creation on normal import paths.
const crypto = require('node:crypto');
const { hash, normalizedPostText, isClaimable } = require('./queue');

function normalizeRow(row) {
  if (!row) return undefined;
  // PostgreSQL int8 intentionally arrives as strings; UI receipt comparisons and
  // persisted touched deadlines use safe JavaScript integers, not string identity.
  for (const key of ['seq','touched','prompt_id','result_id','received']) {
    if (typeof row[key] === 'string' && /^-?\d+$/.test(row[key])) {
      const n = Number(row[key]);
      if (!Number.isSafeInteger(n)) throw new RangeError('UNSAFE_IMPORT_INTEGER');
      row[key] = n;
    }
  }
  return row;
}
class PgImportRepository {
  constructor(client, store) { this.client=client; this.store=store; this.changed=false; this.stateChanged=false; this.afterCommit=[]; }
  async one(sql, params=[]) { return normalizeRow((await this.client.query(sql,params)).rows[0]); }
  async all(sql, params=[]) { return (await this.client.query(sql,params)).rows.map(normalizeRow); }
  async execute(sql, params=[]) {
    const result=await this.client.query(sql,params);
    const changes=Array.isArray(result)?result.reduce((n,r)=>n+(r.rowCount||0),0):(result.rowCount||0);
    if(changes)this.changed=true;
    return {changes};
  }
  async header() {
    if(!this.beforeHeader) {
      await this.store._syncPostsCache(this.client);
      this.beforeHeader=await this.store._readHeaderState(this.client);
    }
    return structuredClone(this.beforeHeader);
  }
  async saveHeader(next) {
    await this.header();
    // A is deliberately still serialized with the canonical compatibility writer.
    // Header-only mutations must never replace or delete the operational queue.
    const apply=await this.store._persistDiff(this.client,this.beforeHeader,{...next,items:structuredClone(this.store._orderedItems)});
    if(apply)this.afterCommit.push(apply);
    this.changed=true;this.stateChanged=true;
  }
  async appendPosts(items) {
    if(!items.length)return;
    const {postItemToParams}=require('./pgStore');
    let position=Number((await this.one('SELECT COALESCE(MAX(position),-1) AS position FROM posts')).position)+1;
    for(let offset=0;offset<items.length;offset+=250) {
      const params=[],values=[];
      for(const item of items.slice(offset,offset+250)) {
        const row=postItemToParams(item,position++);
        values.push('('+row.map(value=>{params.push(value);return '$'+params.length;}).join(',')+')');
      }
      await this.execute(`INSERT INTO posts(id,position,content_hash,text,text_key,payload_json,state,created_at,reason,published_at,url,tweet_id,account_id,account_username,claimed_at,pre_dispatch_retries,claimable,attempt_json,archived_attempt_json,archived_attempts_json,outcome_json,result_json,recovery_history_json,failure_diagnostic_json,owner_assisted_package_json,source_json) VALUES ${values.join(',')}`,params);
    }
    this.stateChanged=true;
  }
  async claimCsvDigest(owner,jobId,digest,file) {
    const other=await this.one("SELECT id FROM file_import_jobs WHERE owner=$1 AND kind='csv' AND digest=$2 AND id<>$3",[owner,digest,jobId]);
    if(other)return other;
    await this.execute("UPDATE file_import_jobs SET file=$1,digest=$2,status='processing' WHERE id=$3",[file,digest,jobId]);
    return undefined;
  }
  async commitCsv(jobId,batch) {
    const job=await this.one('SELECT * FROM file_import_jobs WHERE id=$1 FOR UPDATE',[jobId]);
    if(!job)throw new Error('IMPORT_JOB_MISSING');
    const accounts=new Set((await this.all('SELECT id FROM accounts')).map(row=>row.id));
    // Derive from committed authoritative rows every transaction, never from a
    // process-local revision or an append-only seen table that survives deletion.
    const candidateEntries=[];
    const hashSet=new Set(),textKeySet=new Set();
    let checkpointCheck=job.checkpoint;
    for(const entry of batch) {
      if(entry.index<=job.checkpoint)continue;
      if(!Number.isSafeInteger(entry.index)||entry.index<=checkpointCheck)throw new Error('IMPORT_ROW_ORDER');
      checkpointCheck=entry.index;
      const p=entry.payload;
      if(p&&Object.hasOwn(p,'account')&&!accounts.has(p.account))continue;
      if(entry.error)continue;
      const h=hash(p),t=normalizedPostText(p);
      hashSet.add(h);
      textKeySet.add(t);
      candidateEntries.push({index:entry.index,h,t});
    }
    const hashes=Array.from(hashSet),textKeys=Array.from(textKeySet);
    const seen=new Set(),protectedTexts=new Set();
    if(candidateEntries.length) {
      const {rowToPostItem}=require('./pgStore');
      const matched=await this.all(
        `SELECT id,content_hash,text,text_key,payload_json,state,pre_dispatch_retries,claimable,
                attempt_json,archived_attempt_json,archived_attempts_json,outcome_json,result_json,
                recovery_history_json,failure_diagnostic_json,owner_assisted_package_json,source_json
         FROM posts
         WHERE state<>'cancelled' AND (content_hash = ANY($1::text[]) OR text_key = ANY($2::text[]))`,
        [hashes,textKeys]
      );
      for(const row of matched) {
        const item=rowToPostItem(row),payload=item.payload;
        seen.add(hash(payload));
        if(!isClaimable(item))protectedTexts.add(normalizedPostText(payload));
      }
      if(textKeys.length) {
        for(const row of await this.all('SELECT content_key FROM ambiguous_fences WHERE content_key = ANY($1::text[])',[textKeys])) {
          protectedTexts.add(row.content_key);
        }
      }
    }
    const reasons=JSON.parse(job.reasons);let added=0,duplicates=0,rejected=0,checkpoint=job.checkpoint;
    const rows=[];
    for(const entry of batch) {
      if(entry.index<=job.checkpoint)continue;
      if(!Number.isSafeInteger(entry.index)||entry.index<=checkpoint)throw new Error('IMPORT_ROW_ORDER');
      checkpoint=entry.index;
      const p=entry.payload;let error=entry.error;
      if(p&&Object.hasOwn(p,'account')&&!accounts.has(p.account))error='UNKNOWN_ACCOUNT';
      if(error){rejected++;reasons[error]=(reasons[error]||0)+1;continue;}
      const h=hash(p),text=normalizedPostText(p);
      if(seen.has(h)||protectedTexts.has(text)){duplicates++;continue;}
      seen.add(h);rows.push({id:crypto.randomUUID(),contentHash:h,payload:p,state:'pending',createdAt:new Date().toISOString()});added++;
    }
    await this.appendPosts(rows);
    await this.execute('UPDATE file_import_jobs SET checkpoint=$1,received=received+$2,added=added+$3,duplicates=duplicates+$4,rejected=rejected+$5,reasons=$6 WHERE id=$7',[checkpoint,added+duplicates+rejected,added,duplicates,rejected,JSON.stringify(reasons),jobId]);
    return {checkpoint,added,duplicates,rejected};
  }
}
// Existing canonical PG_SCHEMA_DDL already owns every required table. Schema
// installation is an explicit owner operation, never FileImports.initialize().
// Export the exact required relation contract for startup/installer integration.
const REQUIRED_IMPORT_TABLES=Object.freeze(['file_import_jobs','account_import_batches','text_upload_inbox','telegram_navigation_receipts']);
async function assertImportSchema(client) {
  for(const table of REQUIRED_IMPORT_TABLES) {
    const result=await client.query('SELECT to_regclass($1) AS name',[table]);
    if(!result.rows[0].name)throw Object.assign(new Error('PG_IMPORT_SCHEMA_MISSING: '+table),{code:'PG_IMPORT_SCHEMA_MISSING'});
  }
}
module.exports={PgImportRepository,assertImportSchema,REQUIRED_IMPORT_TABLES};
