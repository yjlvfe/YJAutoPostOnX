'use strict';
const crypto=require('node:crypto');
const {csv,canonicalLink,dayOf}=require('./linkExports');
const parse=(s,f={})=>{try{return typeof s==='string'?JSON.parse(s):(s||f);}catch{return f;}};
function safeDay(value){try{return value&&Number.isFinite(new Date(value).getTime())?dayOf(value):null;}catch{return null;}}
const isIsoDay=day=>typeof day==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(day)&&safeDay(`${day}T12:00:00+03:00`)===day;

// One durable report and at most batchSize operational posts per transaction.
// The keyset advances over rejected candidates too; permanently drained
// historical reports are recorded so idle 30s ticks avoid operational_state churn.
async function pruneConfirmedDaily(store,{today,chatId,batchSize=500}={}){
  if(!isIsoDay(today))throw new Error('INVALID_TODAY');
  if(chatId==null||!String(chatId).trim()||String(chatId)==='undefined')throw new Error('INVALID_CHAT_ID');
  chatId=String(chatId);
  const limit=Math.max(1,Math.min(Number.isSafeInteger(batchSize)?batchSize:500,500));
  return store.importTransaction(async repo=>{
    const state=parse((await repo.one("SELECT value_json FROM operational_state WHERE key='dailyRetention'"))?.value_json);
    state.epoch=Number.isSafeInteger(state.epoch)&&state.epoch>=0?state.epoch:0;
    state.days=state.days||{};
    state.drained=state.drained&&typeof state.drained==='object'&&!Array.isArray(state.drained)?state.drained:{};
    const drainedIds=Object.keys(state.drained);
    const scan=state.scan||{sequence:-1};
    const report=await repo.one(`SELECT id,sequence_no,source_json,payload_json FROM outbox
      WHERE status='delivered' AND source_json::jsonb->>'kind'='document'
        AND source_json::jsonb->>'daily'='true'
        AND source_json::jsonb->>'chatId'=$1
        AND source_json::jsonb->>'day' < $2
        AND (sequence_no > $3 OR (sequence_no=$3 AND $4::boolean))
        AND NOT (id = ANY($5::text[]))
      ORDER BY sequence_no LIMIT 1`,[chatId,today,String(scan.sequence??-1),scan.position!==undefined,drainedIds]);
    const save=async()=>repo.execute("INSERT INTO operational_state(key,value_json) VALUES('dailyRetention',$1) ON CONFLICT(key) DO UPDATE SET value_json=EXCLUDED.value_json",[JSON.stringify(state)]);
    if(!report){
      if(scan.sequence!==-1||scan.position!==undefined){state.scan={sequence:-1};await save();}
      return {deleted:0,more:false,epoch:state.epoch};
    }
    const sequence=String(report.sequence_no);
    const entry={...parse(report.payload_json),...parse(report.source_json)};
    const advance=async()=>{state.scan={sequence};await save();return {deleted:0,more:true,epoch:state.epoch};};
    if(entry.daily!==true||entry.kind!=='document'||entry.status!=='delivered'||String(entry.chatId)!==chatId||
       !isIsoDay(entry.day)||entry.day>=today||!Array.isArray(entry.rows)||!entry.rows.length||
       !Number.isSafeInteger(Number(entry.messageId))||Number(entry.messageId)<=0)return advance();
    const content=csv(entry.rows),hash=crypto.createHash('sha256').update(content).digest('hex');
    if(!content||hash!==entry.contentHash)return advance();
    const receipt=await repo.one(`SELECT delivery_id FROM link_deliveries WHERE outbox_id=$1 AND ok=1 AND kind='document'
      AND day=$2 AND chat_id=$3 AND run_id=$4 AND content_hash=$5 AND message_id=$6 LIMIT 1`,
      [report.id,entry.day,chatId,entry.runId,hash,entry.messageId]);
    if(!receipt)return advance();
    const ids=[],tweets=new Set();
    for(const row of entry.rows){const link=canonicalLink(row.url);if(!link)continue;if(row.id!=null)ids.push(String(row.id));tweets.add(link.id);}
    const same=String(scan.sequence)===sequence&&scan.position!==undefined;
    const candidates=await repo.all(`SELECT p.id,p.position,p.published_at,p.url,p.tweet_id,
      EXISTS(SELECT 1 FROM outbox o WHERE o.status<>'delivered' AND (
        COALESCE(o.source_json::jsonb->'itemIds','[]'::jsonb) ? p.id OR
        EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(o.source_json::jsonb->'rows','[]'::jsonb)) r
          WHERE r->>'id'=p.id OR r->>'tweetId'=p.tweet_id OR
            substring(r->>'url' from 'status/([0-9]+)')=substring(p.url from 'status/([0-9]+)')))) AS blocked
      FROM posts p WHERE p.state='published' AND p.claimable=0
        AND (p.id=ANY($1::text[]) OR p.tweet_id=ANY($2::text[]))
        AND (p.position>$3 OR (p.position=$3 AND p.id>$4))
        AND NOT EXISTS(SELECT 1 FROM reservations r WHERE r.post_id=p.id)
        AND NOT EXISTS(SELECT 1 FROM ambiguous_fences f WHERE f.content_key IN(p.id,'post:'||p.id,p.text_key,p.content_hash))
        AND NOT EXISTS(SELECT 1 FROM post_attempts a WHERE a.post_id=p.id AND
          (a.completed_at IS NULL OR a.outcome IS NULL OR a.phase NOT IN('completed','recovered_pre_dispatch','recovered_ambiguous')))
      ORDER BY p.position,p.id LIMIT $5 FOR UPDATE OF p`,
      [ids,[...tweets],same?scan.position:-1,same?scan.id:'',limit]);
    const eligible=candidates.filter(p=>!p.blocked&&safeDay(p.published_at)===entry.day&&entry.day<today&&tweets.has(canonicalLink(p.url)?.id));
    const deleted=eligible.length?await repo.all('DELETE FROM posts WHERE id=ANY($1::text[]) RETURNING id',[eligible.map(p=>p.id)]):[];
    if(deleted.length){
      state.epoch++;
      state.days[entry.day]||={deleted:0};state.days[entry.day].deleted+=deleted.length;
      // Native deferred triggers produce tombstones; do not force full rehydrate.
      repo.changed=true;
    }
    if(candidates.length===limit){
      const last=candidates.at(-1);
      state.scan={sequence,position:last.position,id:last.id};
    }else{
      let anyRemaining=false;
      if(ids.length>0||tweets.size>0){
        const rem=await repo.one('SELECT 1 AS hit FROM posts WHERE id = ANY($1::text[]) OR tweet_id = ANY($2::text[]) LIMIT 1',[ids,[...tweets]]);
        anyRemaining=Boolean(rem);
      }
      if(!anyRemaining){
        state.drained[String(report.id)]=entry.day;
        state.scan={sequence:-1};
      }else{
        state.scan={sequence};
      }
    }
    await save();
    return {deleted:deleted.length,more:candidates.length===limit,epoch:state.epoch};
  });
}
module.exports={pruneConfirmedDaily};
