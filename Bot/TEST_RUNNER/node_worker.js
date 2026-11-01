'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const ROOT='/root/Projects/YJAutoPostOnX/Bot';
const {run}=require(ROOT+'/src/runner');
const {SqliteStore}=require(ROOT+'/src/sqliteStore');
const {TelegramUi}=require(ROOT+'/src/telegramUi');
const {DirectXAdapter}=require(ROOT+'/src/directX');
const {accountCapacity}=require(ROOT+'/src/quota');
const cfg=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
function marker(x){console.log(JSON.stringify(x));}
const api={getMe:async()=>({id:1,username:'fixture'}),sendMessage:async()=>({message_id:1}),sendRichMessage:async()=>({message_id:1}),editMessageText:async()=>({message_id:1}),deleteMessage:async()=>{},answerCallbackQuery:async()=>{},getUpdates:async()=>[],sendDocument:async()=>({message_id:1})};
const vpn={ensure:async()=>({exitIp:'8.8.8.8',proxy:'socks5h://127.0.0.1:18801'}),health:async()=>({healthy:true,exitIp:'8.8.8.8'})};
function fixture(){return {items:[{id:'test-item',state:'pending',payload:{text:cfg.text}}],accounts:[{id:'acct',username:'example',userId:'123',enabled:true,cookieFile:cfg.cookie,dailyLimit:10}],cycle:{state:'stopped',runId:null},settings:{dailyQuota:10},posting:{},telegramUi:{users:{},accountChecks:{}}};}
async function init(){let initial=fixture();if(cfg.claimFixture){initial.cycle={state:'running',runId:'run'};initial.telegramUi.run={runId:'run',accountIds:['acct'],itemIds:['test-item']};}const s=new SqliteStore(path.join(cfg.data,'state.sqlite'),initial);await s.load();await s.close();}
function selected(s){let i=s.items?.[0];return {itemState:i?.state,phase:i?.attempt?.phase||null,quota:s.posting?.quota||{},cycle:s.cycle?.state,runId:s.cycle?.runId||null,reason:i?.reason||null};}
async function runner(){
 if(cfg.initialize) await init();
 let adapterCount=0;
 await run({token:'fixture',userId:'1',chatId:'1',allowedUserIds:[],allowedChatIds:[],dataDir:cfg.data,api,vpnManager:vpn,maxPolls:0,
  publishAdapterFactory:()=>{adapterCount++;let a=new DirectXAdapter({pythonExecutable:cfg.wrapper,allowPublish:true,openTimeoutMs:3000,publishTimeoutMs:3000});if(cfg.breakpoint==='claimed'){a.open=async()=>{marker({event:'CLAIM_BEFORE_SEND'});return new Promise(()=>{});};}if(cfg.breakpoint==='response'){let publish=a.publish.bind(a);a.publish=async options=>{let result=await publish(options);marker({event:'RESPONSE_BEFORE_SQLITE',result});await new Promise(()=>{});return result;};}if(cfg.breakpoint==='late_callback'){let publish=a.publish.bind(a);a.publish=async options=>{let callback=options.onDispatch;options.onDispatch=async (...args)=>{marker({event:'OLD_CALLBACK_WAITING'});while(!fs.existsSync(cfg.release)) await new Promise(r=>setTimeout(r,10));return callback(...args);};return publish(options);};}if(cfg.breakpoint==='stale_result'){let publish=a.publish.bind(a);a.publish=async options=>{await options.onDispatch?.();marker({event:'STALE_RESULT_WAITING'});while(!fs.existsSync(cfg.release)) await new Promise(r=>setTimeout(r,10));return {published:true,url:'https://x.com/stale/status/999'};};}if(cfg.breakpoint==='stale_exception'){let publish=a.publish.bind(a);a.publish=async options=>{marker({event:'STALE_EXCEPTION_WAITING'});while(!fs.existsSync(cfg.release)) await new Promise(r=>setTimeout(r,10));throw Object.assign(new Error('Synthetic transient failure'),{code:'VPN_TRANSIENT_UNAVAILABLE'});};}return a;},
  sleepFn:async()=>new Promise(r=>setTimeout(r,10)),attemptTimeoutMs:5000,logger:{log:x=>marker({event:'log',value:x}),error:x=>marker({event:'error',value:x})},
  onPostPersisted:async()=>{marker({event:'PERSISTED_AND_QUOTA'});if(cfg.breakpoint==='persisted')await new Promise(()=>{});},
  onRuntimeReady:async ctx=>{
   marker({event:'READY',state:selected(await ctx.state())});
   if(cfg.start){let result=await ctx.start({stopAfterSuccess:true});marker({event:'START',result});}
   await ctx.wait();marker({event:'FINISHED',state:selected(await ctx.state()),adapterCount});
  }
 });
}
async function restore(){let s=new SqliteStore(path.join(cfg.data,'state.sqlite'),{});let before=selected(await s.load());let ui=new TelegramUi({bot:{store:s},launch:async()=>{},runtimeReady:async()=>({ready:true,reasons:[]})});let r=await ui.restore();let after=selected(await s.load());await ui.destroy();await s.close();marker({before,after,resume:!!r.resume});}
function extractedClaim(){let source=fs.readFileSync(ROOT+'/src/runner.js','utf8');let start=source.indexOf('async function claimCycleItem('),end=source.indexOf('\nasync function stopCycleForQuota(',start);if(start<0||end<0)throw Error('boundaries');let scope={crypto,accountCapacity};vm.createContext(scope);vm.runInContext(source.slice(start,end)+'\nthis.claim=claimCycleItem',scope);return scope.claim;}
async function claim(){let store=new SqliteStore(path.join(cfg.data,'state.sqlite'),{});try{let result=await extractedClaim()({store,itemId:'test-item',accountId:'acct',runId:'run'});marker({claimed:result.claimed,reason:result.reason});}finally{await store.close()}}
async function crashTransaction(){let store=new SqliteStore(path.join(cfg.data,'state.sqlite'),{});await store.update(async s=>{s.items[0].state='processing';let keepalive=setInterval(()=>{},1000);marker({event:'UNCOMMITTED_MUTATION'});await new Promise(()=>{});clearInterval(keepalive);return s;});}
async function staleClaim(){let store=new SqliteStore(path.join(cfg.data,'state.sqlite'),{});try{let old=await extractedClaim()({store,itemId:'test-item',accountId:'acct',runId:'run'});let ui=new TelegramUi({bot:{store},launch:async()=>{},runtimeReady:async()=>({ready:true,reasons:[]})});let restored=await ui.restore();await ui.destroy();let next=await extractedClaim()({store,itemId:'test-item',accountId:'acct',runId:'run'});let state=await store.load();marker({first:old.claimed,recovered:!!restored.resume,second:next.claimed,distinctTokens:old.token!==next.token,phase:state.items[0].attempt?.phase});}finally{await store.close()}}
async function ipc(){
 let a=new DirectXAdapter({pythonExecutable:cfg.wrapper,allowPublish:true,openTimeoutMs:2000,publishTimeoutMs:cfg.timeout||250});let session=await a.open({account:{id:'acct',username:'example',userId:'123',cookieFile:cfg.cookie},proxy:'socks5h://127.0.0.1:18801'});
 let child=a.sessions.get(session).child,pid=child.pid,signalSent=null,cb=0;
 let result=await a.publish({session,payload:{text:cfg.text},confirmPublish:true,onDispatch:async()=>{cb++;if(cfg.signal){setTimeout(()=>{signalSent=cfg.signal;child.kill(cfg.signal)},30)}if(cfg.delayCallback)await new Promise(r=>setTimeout(r,500));return true;}});
 await a.close({session});let alive=true;try{process.kill(pid,0)}catch{alive=false};marker({result,callbackCount:cb,childPid:pid,signalSent,childAliveAfterClose:alive,exitCode:child.exitCode,signalCode:child.signalCode});
}
(async()=>{if(cfg.action==='runner')await runner();else if(cfg.action==='restore')await restore();else if(cfg.action==='claim')await claim();else if(cfg.action==='crashTransaction')await crashTransaction();else if(cfg.action==='staleClaim')await staleClaim();else if(cfg.action==='ipc')await ipc();else if(cfg.action==='init')await init();else throw Error('unknown action')})().catch(e=>{console.error(String(e.stack||e));process.exitCode=1});