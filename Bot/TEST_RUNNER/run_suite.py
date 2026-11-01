#!/usr/bin/env python3
"""Bounded, local-only publishing forensic suite. Run only under fresh netns."""
import contextlib, datetime, errno, hashlib, http.server, json, os, pathlib, signal, socket, sqlite3, subprocess, sys, threading, time, traceback

HERE=pathlib.Path(__file__).resolve().parent
OUT=HERE.parent; EV=(OUT/'EVIDENCE') if (OUT/'EVIDENCE').exists() else pathlib.Path('/root/YJAutoPostOnX_ReportArchive/raw_sources/Bot_Reports/FinalEvidence/CriticalClosure-20261101-073430/EVIDENCE'); OUT=EV.parent; ROOT=pathlib.Path('/root/Projects/YJAutoPostOnX/Bot')
PY=str(ROOT/'.venv-direct-x/bin/python'); NODE='/usr/local/bin/node'; TEXT='Synthetic shared text for testing only 1234567890 long suffix actual'
HASH=json.loads((EV/'baseline-source-hashes.json').read_text()); SELECT=set(sys.argv[1:]); RESULTS=[]; RECORDS=[]; MODES={}; LOCK=threading.Lock()
ENV={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','HOME':str(EV),'PYTHONDONTWRITEBYTECODE':'1','NO_COLOR':'1'}
def emit(s):print(s,flush=True)
def write(p,obj):p.write_text(json.dumps(obj,indent=2,ensure_ascii=False)+'\n')
def checksum(files):return {x:HASH[x] for x in files}
def latest_json(stdout):
 for line in reversed(stdout.splitlines()):
  try:return json.loads(line)
  except (ValueError,TypeError):pass
 return None
class Handler(http.server.BaseHTTPRequestHandler):
 def do_POST(self):
  key=self.path.strip('/');body=self.rfile.read(int(self.headers.get('content-length','0')))
  with LOCK:RECORDS.append({'case':key,'bytes':len(body),'at':time.time()});mode=MODES.get(key,'ok')
  try:
   if mode in ('drop','hold'):
    if mode=='hold':time.sleep(3)
    self.connection.shutdown(socket.SHUT_RDWR);self.connection.close();return
   if mode=='delay':time.sleep(1.3)
   self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(b'{"id":"101"}' if mode!='incomplete' else b'{"id":')
  except (BrokenPipeError,ConnectionResetError,OSError):pass
 def log_message(self,*args):pass
class Server(http.server.ThreadingHTTPServer): daemon_threads=True;allow_reuse_address=True
def count(case):
 with LOCK:return sum(x['case']==case for x in RECORDS)
def stop_group(p, sig=signal.SIGKILL):
 try:os.killpg(p.pid,sig)
 except ProcessLookupError:pass
 try:p.wait(timeout=3)
 except subprocess.TimeoutExpired:pass
def cfgdir(tid,server,mode='ok',timeline='empty',action='runner',fake=False,**kw):
 d=EV/tid;d.mkdir(parents=True,exist_ok=True);dat=d/'data';dat.mkdir(exist_ok=True)
 for _f in list(dat.glob('state.sqlite*'))+[d/'release',dat/'dispatch-ack-seen']: _f.unlink(missing_ok=True)
 cookie=d/'synthetic-session.json';cookie.write_text(json.dumps({'auth_token':'TEST_AUTH_VALUE','ct0':'TEST_CSRF_VALUE','twid':'u=123'}));os.chmod(cookie,0o600)
 text=TEXT+(' https://example.com/target' if 'url' in timeline else '')
 config={'case':tid,'port':server.server_port,'mode':mode,'timeline':timeline,'text':text,'data':str(dat),'cookie':str(cookie),'action':action,'initialize':True,'start':True,**kw};write(d/'config.json',config)
 wrapper=d/'interpreter';entry=HERE/('fake_ipc.py' if fake else 'bridge_worker.py');wrapper.write_text('#!/bin/sh\nexec '+PY+' -B '+str(entry)+' '+str(d/'config.json')+'\n');os.chmod(wrapper,0o700);config['wrapper']=str(wrapper);write(d/'config.json',config);MODES[tid]=mode;return d,config
def launch(d,cfg):
 write(d/'config.json',cfg);return subprocess.Popen([NODE,str(HERE/'node_worker.js'),str(d/'config.json')],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True,cwd=str(d),env=ENV)
def complete(p,timeout=15):
 try:o,e=p.communicate(timeout=timeout);return {'stdout':o,'stderr':e,'exit_code':p.returncode,'timed_out':False}
 except subprocess.TimeoutExpired:
  stop_group(p);o,e=p.communicate();return {'stdout':o,'stderr':e,'exit_code':p.returncode,'timed_out':True}
def save_exec(d,label,x):
 (d/(label+'.stdout')).write_text(x['stdout']);(d/(label+'.stderr')).write_text(x['stderr']);write(d/(label+'.exit.json'),{'exit_code':x['exit_code'],'timed_out':x.get('timed_out',False),'command':x.get('command')})
def snapshot(d):
 p=d/'data/state.sqlite'
 if not p.exists():return None
 with sqlite3.connect('file:'+str(p)+'?mode=ro',uri=True,timeout=1) as c:
  s=json.loads(c.execute('select json from state where id=1').fetchone()[0]);i=s['items'][0];return {'itemState':i.get('state'),'phase':i.get('attempt',{}).get('phase'),'quota':s.get('posting',{}).get('quota',{}),'cycle':s.get('cycle',{}).get('state'),'reason':i.get('reason')}
def run_worker(d,cfg,label='worker',timeout=15):
 p=launch(d,cfg);x=complete(p,timeout);x['command']=['node','TEST_RUNNER/node_worker.js',str(d/'config.json')];save_exec(d,label,x);return x
def result(tid,axis,files,path,input,expected,actual,ok,posts=None,before=None,after=None,limitations='',status=None):
 r={'test_id':tid,'suite':axis,'source_files':files,'actual_execution_path':path,'source_hash':checksum(files),'input':input,'expected':expected,'actual':actual,'assertion_result':status or ('PASS' if ok else 'FAIL'),'post_count':posts,'state_before':before,'state_after':after,'evidence_path':str((EV/tid).relative_to(OUT)),'limitations':limitations};RESULTS.append(r);write(EV/tid/'result.json',r);emit(tid+' '+r['assertion_result']+' '+str(posts));return r
def unexpected(tid,axis,exc):
 d=EV/tid;d.mkdir(parents=True,exist_ok=True);(d/'harness-error.txt').write_text(traceback.format_exc());result(tid,axis,[], 'none — harness exception',{},'test executes',{'exception':str(exc)},False,status='HARNESS_ERROR',limitations='Test did not reach its asserted target.')
def run_case(tid,axis,fn):
 if SELECT and tid not in SELECT:return
 try:fn()
 except Exception as e:unexpected(tid,axis,e)
def transport(tid,server,mode,curlfail=False):
 d,cfg=cfgdir(tid,server,mode,curlfail=curlfail,unreachable=(mode=='unreachable'))
 if mode=='unreachable':
  s=socket.socket();s.bind(('127.0.0.1',0));cfg['target_port']=s.getsockname()[1];s.close();write(d/'config.json',cfg)
 cmd=[PY,'-B',str(HERE/'transport_worker.py'),str(d/'config.json')]
 p=subprocess.Popen(cmd,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True,cwd=str(d),env=ENV);x=complete(p,5);x['command']=cmd;save_exec(d,'transport',x);actual=latest_json(x['stdout']);n=count(tid);reach=x['exit_code']==0 and actual is not None;expected=0 if mode=='unreachable' else 1
 if mode=='unreachable':pass
 ok=reach and n==expected and (mode!='unreachable' or actual.get('outcome')=='exception')
 result(tid,'A',['python/direct_x_bridge.py'],'AST-extracted OnlySocksTransport.handle_async_request → real curl_cffi/httpx → loopback server',{'mode':mode,'curl_failure_before_send':curlfail},f'HTTP POST server count={expected}',{'transport':actual,'worker_exit':x['exit_code']},ok,n,limitations='Source-derived AST: constructor and destination guard adapted to loopback; no Runner. When curl failure injected it precedes send.')
def runner_case(tid,server,mode='ok',timeline='empty'):
 d,cfg=cfgdir(tid,server,mode,timeline,no_transport_replay=(tid=='B_RUNNER_REPLAY_ONLY'));x=run_worker(d,cfg,timeout=8);n=count(tid);actual=latest_json(x['stdout']);state=snapshot(d);progress='"event":"START"' in x['stdout'].replace(' ',''); reached='"event":"FINISHED"' in x['stdout'].replace(' ','');expected_states=('published',) if (mode=='ok' or timeline in ('page2','url_match','url_shortened')) else ('ambiguous',);ok=(x['exit_code']==0 and reached and state is not None and n==1 and state['itemState'] in expected_states) if (n>0 or reached) else None
 lim='Not live X/Twikit: synthetic SDK create_tweet/timeline and cached identity; transport AST constructor+destination adapted. Delays accelerated.'
 if cfg.get('no_transport_replay'):lim+=' curl raises before send; one HTTP POST per Runner attempt, isolating Runner replay.'
 result(tid,'B/E',['src/runner.js','src/directX.js','src/sqliteStore.js','src/telegramUi.js','python/direct_x_bridge.py'],'real run/launchCycle → DirectXAdapter → spawned Python real bridge.main/DirectSession.publish → extracted adapted OnlySocksTransport → localhost; mocked X SDK, identity fixture, Telegram, VPN',{'mode':mode,'timeline':timeline,'no_transport_replay':cfg.get('no_transport_replay')},'one server POST, success persisted or uncertain result fenced ambiguous',{'worker_exit':x['exit_code'],'timed_out':x['timed_out'],'final_marker':actual,'start_seen':progress,'finish_seen':reached},ok,n,{'itemState':'pending'},state,limitations=lim,status='HARNESS_ERROR' if ok is None else None)
def crash(tid,server,where):
 mode='hold' if where=='post' else 'ok';d,cfg=cfgdir(tid,server,mode,breakpoint=where);p=launch(d,cfg);out=d/'crash.stdout';err=d/'crash.stderr'
 # Drain pipes in background while observing markers, without dropping output.
 lines=[];errors=[]
 def drain(stream,arr):
  for line in stream:arr.append(line)
 t=threading.Thread(target=drain,args=(p.stdout,lines),daemon=True);e=threading.Thread(target=drain,args=(p.stderr,errors),daemon=True);t.start();e.start();deadline=time.monotonic()+10;marker={'claimed':'CLAIM_BEFORE_SEND','response':'RESPONSE_BEFORE_SQLITE','persisted':'PERSISTED_AND_QUOTA'}.get(where)
 while time.monotonic()<deadline and p.poll() is None:
  if (count(tid)>0 if where=='post' else any(marker in l for l in lines)):break
  time.sleep(.02)
 reached=(count(tid)>0 if where=='post' else any(marker in l for l in lines));pre=snapshot(d);posts_before=count(tid)
 if p.poll() is None:p.kill()
 p.wait(timeout=3);time.sleep(.25)
 # Child may survive the killed Node process; list only processes in this test PGID.
 ps=subprocess.run(['/bin/ps','-eo','pid,ppid,pgid,args'],capture_output=True,text=True,env=ENV,timeout=2).stdout;orphans=[l for l in ps.splitlines() if len(l.split(None,3))>=4 and l.split(None,3)[2]==str(p.pid)]
 stop_group(p);t.join(2);e.join(2);out.write_text(''.join(lines));err.write_text(''.join(errors));write(d/'crash.exit.json',{'exit_code':p.returncode,'breakpoint_reached':reached,'test_group_members_after_parent_killed':orphans});
 cfg.update(action='runner',initialize=False,start=False,breakpoint=None);MODES[tid]='ok';rx=run_worker(d,cfg,'restart',timeout=10);post=snapshot(d);n=count(tid);logs=rx['stdout'];ready=next((json.loads(l) for l in logs.splitlines() if '"event":"READY"' in l.replace(' ','')),None)
 expected_state='published' if where in ('claimed','persisted') else 'ambiguous';expected_posts=1
 ok=reached and p.returncode==-signal.SIGKILL and rx['exit_code']==0 and post and post['itemState']==expected_state and n==expected_posts
 result(tid,'C',['src/runner.js','src/directX.js','src/telegramUi.js','src/sqliteStore.js','python/direct_x_bridge.py'],'real Runner/adapter/bridge until breakpoint, SIGKILL Node test worker, reap group; restart actual Runner with actual TelegramUi.restore and auto-resume on synthetic SQLite',{'breakpoint':where},f'after real restart {expected_state}, total server POST {expected_posts}',{'reached':reached,'kill_exit':p.returncode,'restart_exit':rx['exit_code'],'restart_ready':ready,'posts_before_restart':posts_before,'orphans_before_cleanup':orphans},ok,n,pre,post,limitations='Post-crash orphan is deliberately killed before restart to avoid a live synthetic child. response hook pauses adapter return after real response. Claim hook pauses before open. Resume uses actual Runner lifecycle.')
def ipc_case(tid,server,mode,**kw):
 d,cfg=cfgdir(tid,server,fake=True,action='ipc',mode=mode,**kw);x=run_worker(d,cfg,timeout=5);a=latest_json(x['stdout']);expected_published=mode=='success';ok=x['exit_code']==0 and isinstance(a,dict) and not a.get('childAliveAfterClose') and a.get('callbackCount')==1 and ((a.get('result',{}).get('published') is True) if expected_published else (a.get('result',{}).get('ambiguous') is True))
 result(tid,'D',['src/directX.js'],'real DirectXAdapter → synthetic spawned Python JSON-lines protocol child',{'mode':mode,**kw},'acknowledged success published, missing/late/signal ambiguous and child reaped',a,ok,0,limitations='Protocol peer is synthetic; real DirectXAdapter only. No Runner or real X.')
def late_ipc(tid,server,mode):
 d,cfg=cfgdir(tid,server,fake=True,action='ipc',mode=mode);x=run_worker(d,cfg,timeout=5);a=latest_json(x['stdout']);callback_expected=0 if mode=='late_ready' else 1
 ok=x['exit_code']==0 and isinstance(a,dict) and not a.get('childAliveAfterClose') and a.get('callbackCount')==callback_expected and not (d/'data/dispatch-ack-seen').exists() and (a.get('result',{}).get('ambiguous') is True if callback_expected else a.get('result',{}).get('published') is False)
 result(tid,'D',['src/directX.js'],'actual DirectXAdapter with real spawned synthetic JSON-lines protocol peer',{'mode':mode},'timeout kills peer; delayed event cannot yield acknowledged dispatch or late published result',a,ok,0,limitations='No HTTP or Runner. For late_ready, callback never ran so pre-dispatch retryable result is expected; this only tests DirectXAdapter child lifetime.')
def late_runner(tid,server):
 d,cfg=cfgdir(tid,server,breakpoint='late_callback',release=str(EV/tid/'release'));p=launch(d,cfg);lines=[];errors=[]
 def drain(stream,arr):
  for line in stream:arr.append(line)
 t=threading.Thread(target=drain,args=(p.stdout,lines),daemon=True);e=threading.Thread(target=drain,args=(p.stderr,errors),daemon=True);t.start();e.start();deadline=time.monotonic()+6
 while time.monotonic()<deadline and p.poll() is None and not any('OLD_CALLBACK_WAITING' in l for l in lines):time.sleep(.01)
 reached=any('OLD_CALLBACK_WAITING' in l for l in lines);before=snapshot(d)
 # Fault injection: fake the state a new owner would reserve, but no second
 # Runner is launched. The real old Runner callback must reject the stale token.
 if reached:
  with sqlite3.connect(d/'data/state.sqlite') as db:
   db.execute('BEGIN IMMEDIATE');state=json.loads(db.execute('select json from state where id=1').fetchone()[0]);state['items'][0]['attempt']['token']='synthetic-new-token';db.execute('update state set json=?,revision=revision+1 where id=1',(json.dumps(state),));db.commit()
  pathlib.Path(cfg['release']).write_text('release')
 try:p.wait(timeout=7)
 except subprocess.TimeoutExpired:stop_group(p)
 t.join(2);e.join(2);out=''.join(lines);err=''.join(errors);(d/'worker.stdout').write_text(out);(d/'worker.stderr').write_text(err);write(d/'worker.exit.json',{'exit_code':p.returncode,'reached':reached});after=snapshot(d);n=count(tid)
 with sqlite3.connect('file:'+str(d/'data/state.sqlite')+'?mode=ro',uri=True) as db:token_after=json.loads(db.execute('select json from state where id=1').fetchone()[0])['items'][0].get('attempt',{}).get('token')
 ok=reached and n==0 and after and after['itemState']=='processing' and token_after=='synthetic-new-token' and not after['quota']
 result(tid,'C-QUEUE',['src/runner.js','src/directX.js','src/sqliteStore.js','python/direct_x_bridge.py'],'actual Runner closure onDispatch and DirectXAdapter; delayed callback released after synthetic SQLite token replacement',{'scenario':'stale token late callback'},'no old POST and newer processing token/state must remain unchanged',{'reached':reached,'exit_code':p.returncode,'new_token_after':token_after},ok,n,before,after,limitations='Competing owner token is injected directly into test SQLite; no second actual process claims it. Exercise real old Runner callback, not complete restart race.')
def stale_attempt_runner(tid,server,scenario):
 bp='stale_result' if scenario=='result' else 'stale_exception'
 marker_str='STALE_RESULT_WAITING' if scenario=='result' else 'STALE_EXCEPTION_WAITING'
 d,cfg=cfgdir(tid,server,breakpoint=bp,release=str(EV/tid/'release'));p=launch(d,cfg);lines=[];errors=[]
 def drain(stream,arr):
  for line in stream:arr.append(line)
 t=threading.Thread(target=drain,args=(p.stdout,lines),daemon=True);e=threading.Thread(target=drain,args=(p.stderr,errors),daemon=True);t.start();e.start();deadline=time.monotonic()+6
 while time.monotonic()<deadline and p.poll() is None and not any(marker_str in l for l in lines):time.sleep(.01)
 reached=any(marker_str in l for l in lines);before=snapshot(d)
 if reached:
  with sqlite3.connect(d/'data/state.sqlite') as db:
   db.execute('BEGIN IMMEDIATE');state=json.loads(db.execute('select json from state where id=1').fetchone()[0])
   state['items'][0]['attempt']['token']='newer-token'
   state['posting']=state.get('posting') or {}
   state['posting']['publishingAt']='2026-11-01T15:00:00.000Z'
   db.execute('update state set json=?,revision=revision+1 where id=1',(json.dumps(state),));db.commit()
  pathlib.Path(cfg['release']).write_text('release')
 try:p.wait(timeout=7)
 except subprocess.TimeoutExpired:stop_group(p)
 t.join(2);e.join(2);after=snapshot(d);n=count(tid)
 with sqlite3.connect('file:'+str(d/'data/state.sqlite')+'?mode=ro',uri=True) as db:
  row=json.loads(db.execute('select json from state where id=1').fetchone()[0])
  token_after=row['items'][0].get('attempt',{}).get('token')
  pub_at=row.get('posting',{}).get('publishingAt')
 ok=reached and after and after['itemState']=='processing' and token_after=='newer-token' and pub_at=='2026-11-01T15:00:00.000Z' and not after['quota']
 result(tid,'C-QUEUE',['src/runner.js','src/directX.js','src/sqliteStore.js'],'Runner attempt token fencing across stale result/exception path',{'scenario':scenario},'newer attempt token, processing state and publishingAt must remain intact',{'reached':reached,'exit_code':p.returncode,'token_after':token_after,'publishingAt':pub_at},ok,n,before,after)
def concurrency(tid,server,kind):
 d,cfg=cfgdir(tid,server,action='init',claimFixture=True);x=run_worker(d,cfg,'init');assert x['exit_code']==0,x['stderr'];cfg['action']='claim';before=snapshot(d)
 if kind=='race':
  ps=[launch(d,cfg) for _ in range(5)];xs=[complete(p,8) for p in ps]
  for i,z in enumerate(xs):save_exec(d,'claim'+str(i),z)
  values=[latest_json(z['stdout']) for z in xs];after=snapshot(d);wins=sum(bool(v and v.get('claimed')) for v in values);ok=all(z['exit_code']==0 for z in xs) and wins==1;actual={'workers':values,'wins':wins,'exit_codes':[z['exit_code'] for z in xs]}
 elif kind=='busy':
  with sqlite3.connect(d/'data/state.sqlite',timeout=1) as lock:
   lock.execute('BEGIN IMMEDIATE');p=launch(d,cfg);time.sleep(.3);blocked=p.poll() is None;lock.rollback();z=complete(p,8)
  save_exec(d,'claim',z);after=snapshot(d);actual={'blocked_during_lock':blocked,'worker':latest_json(z['stdout']),'exit_code':z['exit_code']};ok=blocked and z['exit_code']==0 and actual['worker'].get('claimed') is True
 elif kind=='stale':
  cfg['action']='staleClaim';z=run_worker(d,cfg,'stale');actual=latest_json(z['stdout']);after=snapshot(d);ok=z['exit_code']==0 and actual and actual.get('first') is True and actual.get('recovered') is True and actual.get('second') is True and actual.get('distinctTokens') is True
 elif kind=='crash':
  cfg['action']='crashTransaction';p=launch(d,cfg);buf=[]
  def drain():
   for line in p.stdout:buf.append(line)
  th=threading.Thread(target=drain,daemon=True);th.start();deadline=time.monotonic()+5
  while time.monotonic()<deadline and p.poll() is None and not any('UNCOMMITTED_MUTATION' in l for l in buf):time.sleep(.02)
  reached=any('UNCOMMITTED_MUTATION' in l for l in buf)
  if p.poll() is None:p.kill()
  p.wait();stop_group(p);th.join(1);(d/'transaction.stdout').write_text(''.join(buf));(d/'transaction.stderr').write_text(p.stderr.read());write(d/'transaction.exit.json',{'exit_code':p.returncode});cfg['action']='claim';z=run_worker(d,cfg,'claim');after=snapshot(d);actual={'uncommitted_point_reached':reached,'killed':p.returncode,'claim':latest_json(z['stdout'])};ok=reached and p.returncode==-signal.SIGKILL and actual['claim'].get('claimed') is True
 else:raise ValueError(kind)
 result(tid,'C-QUEUE',['src/runner.js','src/sqliteStore.js','src/quota.js'],'verbatim extracted claimCycleItem + actual SqliteStore; separate Node processes with synthetic SQLite',{'kind':kind},'single claim; busy waits; killed transaction rolls back without quota loss',actual,ok,0,before,after,limitations='claimCycleItem extracted verbatim in VM; crash point is transaction mutator, not claimCycleItem instruction-level; no Runner dispatch.')

def main():
 # Fail closed before any target execution: fresh netns must have only loopback,
 # no default route and external IP connect must fail ENETUNREACH.
 links=subprocess.check_output(['/usr/sbin/ip','-o','link','show'],text=True);routes=subprocess.check_output(['/usr/sbin/ip','route','show'],text=True)
 s=socket.socket();s.settimeout(.3)
 try:s.connect(('198.51.100.1',443));external='UNEXPECTED_CONNECTED'
 except OSError as e:external={'errno':e.errno,'name':errno.errorcode.get(e.errno)}
 finally:s.close()
 safe=(' lo:' in links and len(links.strip().splitlines())==1 and routes.strip()=='' and isinstance(external,dict) and external['errno']==errno.ENETUNREACH)
 write(EV/'isolation.json',{'links':links,'routes':routes,'external_connect':external,'only_loopback_and_no_routes':safe,'scope':'Linux network namespace inherited by all Node/Python child processes'});
 if not safe:raise RuntimeError('network isolation preflight failed closed')
 server=Server(('127.0.0.1',0),Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
 try:
  for tid,mode,fail in [('A_SUCCESS','ok',False),('A_CONNECT_REFUSED','unreachable',False),('A_CURL_FAILOVER','ok',True),('A_ACCEPT_DROP','drop',False),('A_DELAY','delay',False),('A_INCOMPLETE','incomplete',False)]:run_case(tid,'A',lambda tid=tid,mode=mode,fail=fail:transport(tid,server,mode,fail))
  for tid,mode,timeline in [('B_SUCCESS','ok','empty'),('B_LOST_EMPTY','drop','empty'),('B_RUNNER_REPLAY_ONLY','drop','empty'),('E_MALFORMED','drop','malformed'),('E_PAGE2','drop','page2'),('E_PAGE2_EMPTY','drop','page2_empty'),('E_PAGE2_CORRECTED','drop','page2'),('E_PREFIX','drop','prefix'),('E_PREFIX_DATED','drop','prefix'),('E_NODATE','drop','nodate'),('E_WRONG_AUTHOR','drop','wrong_author'),('E_LATE_VISIBLE','drop','late_visible'),('E_URL_DIFF','drop','url_diff'),('E_URL_MATCH','drop','url_match'),('E_URL_SHORTENED','drop','url_shortened')]:run_case(tid,'B/E',lambda tid=tid,mode=mode,timeline=timeline:runner_case(tid,server,mode,timeline))
  for tid,where in [('C_BEFORE_POST','claimed'),('C_ACCEPTED','post'),('C_RESPONSE','response'),('C_PERSISTED','persisted'),('R_BEFORE_POST','claimed'),('R_ACCEPTED','post'),('R_RESPONSE','response'),('R_PERSISTED','persisted')]:run_case(tid,'C',lambda tid=tid,where=where:crash(tid,server,where))
  for tid,kind in [('Q_RACE','race'),('Q_BUSY','busy'),('Q_STALE','stale'),('Q_CRASH_TX','crash')]:run_case(tid,'C-QUEUE',lambda tid=tid,kind=kind:concurrency(tid,server,kind))
  for tid,mode,extra in [('IPC_OK','success',{}),('IPC_INCOMPLETE','incomplete',{}),('IPC_TIMEOUT','timeout',{}),('IPC_SIGTERM','signal',{'signal':'SIGTERM'}),('IPC_SIGKILL','signal',{'signal':'SIGKILL'}),('IPC_LATE_CALLBACK','late',{'delayCallback':True})]:run_case(tid,'D',lambda tid=tid,mode=mode,extra=extra:ipc_case(tid,server,mode,**extra))
  for tid,mode in [('IPC_LATE_RESULT','late_response'),('IPC_LATE_READY','late_ready')]:run_case(tid,'D',lambda tid=tid,mode=mode:late_ipc(tid,server,mode))
  run_case('Q_LATE_CALLBACK','C-QUEUE',lambda:late_runner('Q_LATE_CALLBACK',server))
  run_case('Q_STALE_SUCCESS_PATH','C-QUEUE',lambda:stale_attempt_runner('Q_STALE_SUCCESS_PATH',server,'result'))
  run_case('Q_STALE_EXCEPTION_PATH','C-QUEUE',lambda:stale_attempt_runner('Q_STALE_EXCEPTION_PATH',server,'exception'))
 finally:
  server.shutdown();server.server_close();thread.join(3)
 if SELECT:
  prior=OUT/'TEST_RESULTS.json'; existing=json.loads(prior.read_text()) if prior.exists() else {'tests':[]}; replaced={r['test_id'] for r in RESULTS}; RESULTS[:]=[r for r in existing['tests'] if r['test_id'] not in replaced]+RESULTS
  records=EV/'http-server-records.json'; old=json.loads(records.read_text()) if records.exists() else []; RECORDS[:]=[r for r in old if r['case'] not in SELECT]+RECORDS
 write(EV/'http-server-records.json',RECORDS)
 summary={'created_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'isolation':'private network namespace loopback-only','tests':RESULTS,'counts':{s:sum(r['assertion_result']==s for r in RESULTS) for s in ['PASS','FAIL','HARNESS_ERROR','NOT_TESTED']}}
 write(OUT/'TEST_RESULTS.json',summary);emit(json.dumps(summary['counts']))
if __name__=='__main__':main()
