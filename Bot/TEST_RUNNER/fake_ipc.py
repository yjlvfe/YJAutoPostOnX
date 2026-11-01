#!/usr/bin/env python3
import json,sys,time
cfg=json.load(open(sys.argv[1])); mode=cfg['mode']
def rd():
 line=sys.stdin.readline()
 return json.loads(line) if line else {}
def emit(o): print(json.dumps(o),flush=True)
rd(); emit({'event':'result','result':{'identity':{'state':'authenticated','authenticated':True,'username':'example','userId':'123'}}})
rd()
if mode=='late_ready': time.sleep(.5)
emit({'event':'dispatch_ready'})
ack=rd()
if mode=='late_ready':
 open(cfg['data']+'/dispatch-ack-seen','w').write(json.dumps(ack))
 emit({'event':'result','result':{'status':'ambiguous','ambiguous':True}})
elif mode=='late_response':
 time.sleep(.5);emit({'event':'result','result':{'status':'published','tweetId':'101','username':'example','userId':'123'}})
elif mode=='incomplete': sys.stdout.write('{"event":"result"');sys.stdout.flush();time.sleep(5)
elif mode in ('timeout','signal','late'): time.sleep(5)
else: emit({'event':'result','result':{'status':'published','tweetId':'101','username':'example','userId':'123'}})
