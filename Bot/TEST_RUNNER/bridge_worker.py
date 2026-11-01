#!/usr/bin/env python3
"""Real bridge protocol/session; synthetic X client and loopback-only transport.
Launched via an isolated executable wrapper because DirectXAdapter strips env.
"""
import ast, asyncio, datetime, email.utils, importlib.util, json, pathlib, sys
from types import SimpleNamespace
import httpx
from curl_cffi.requests import AsyncSession

cfg=json.loads(pathlib.Path(sys.argv[1]).read_text())
root=pathlib.Path('/root/Projects/YJAutoPostOnX/Bot')
p=root/'python/direct_x_bridge.py'
spec=importlib.util.spec_from_file_location('direct_x_bridge_test',p)
b=importlib.util.module_from_spec(spec); spec.loader.exec_module(b)
tree=ast.parse(p.read_text()); f=next(x for x in tree.body if isinstance(x,ast.FunctionDef) and x.name=='new_client')
c=next(x for x in f.body if isinstance(x,ast.ClassDef) and x.name=='OnlySocksTransport'); c.name='LocalTransport'
i=next(x for x in c.body if isinstance(x,ast.FunctionDef) and x.name=='__init__')
i.body=ast.parse('self.transport=httpx.AsyncHTTPTransport(retries=0,trust_env=False)\nself._curl_session=AsyncSession(trust_env=False, timeout=0.5)').body
h=next(x for x in c.body if isinstance(x,ast.AsyncFunctionDef) and x.name=='handle_async_request')
g=next(x for x in h.body if isinstance(x,ast.If) and any(isinstance(y,ast.Raise) for y in ast.walk(x)) and 'proxy_destination_denied' in ast.unparse(x))
g.test=ast.parse("request.url.scheme != 'http' or request.url.host != '127.0.0.1' or request.url.port != PORT",mode='eval').body
env={'httpx':httpx,'AsyncSession':AsyncSession,'PORT':cfg['port'],'_orig_http_transport_code':httpx.AsyncHTTPTransport.handle_async_request.__code__}
exec(compile(ast.fix_missing_locations(ast.Module(body=[c],type_ignores=[])),'source_hash_bound_local_transport','exec'),env)
class GQL:
 async def user_tweets(self,uid,count,cursor):
  mode=cfg.get('timeline','empty')
  if mode=='exception': raise RuntimeError('synthetic timeline outage')
  if mode=='malformed': return {'data':{}},None
  entries=[]
  if mode in ('prefix','nodate','wrong_author','late_visible'):
   text=cfg['text']
   if mode=='prefix': text=text[:40]+' DIFFERENT SUFFIX'
   legacy={'id_str':'101','full_text':text,'user_id_str':'999' if mode=='wrong_author' else '123'}
   if mode in ('wrong_author','prefix','late_visible'): legacy['created_at']=email.utils.format_datetime(datetime.datetime.now(datetime.timezone.utc))
   if mode!='late_visible': entries=[{'content':{'itemContent':{'tweet_results':{'result':{'legacy':legacy}}}}}]
  # page2 is deliberately a valid cursor with no item in page 1; verifier never requests it.
  if mode in ('page2', 'page2_empty'):
   if cursor=='page2':
    if mode == 'page2_empty':
     entries = []
    else:
     legacy={'id_str':'101','full_text':cfg['text'],'user_id_str':'123','created_at':email.utils.format_datetime(datetime.datetime.now(datetime.timezone.utc))}
     entries=[{'content':{'itemContent':{'tweet_results':{'result':{'legacy':legacy}}}}}]
   else: entries=[{'entryId':'cursor-bottom','content':{'cursorType':'Bottom','value':'page2'}}]
  elif mode == 'url_diff':
   legacy={'id_str':'101','full_text':cfg['text'].replace('https://example.com/target', 'https://different-url.com/other'),'user_id_str':'123','created_at':email.utils.format_datetime(datetime.datetime.now(datetime.timezone.utc))}
   entries=[{'content':{'itemContent':{'tweet_results':{'result':{'legacy':legacy}}}}}]
  elif mode == 'url_match':
   legacy={'id_str':'101','full_text':cfg['text'],'user_id_str':'123','created_at':email.utils.format_datetime(datetime.datetime.now(datetime.timezone.utc))}
   entries=[{'content':{'itemContent':{'tweet_results':{'result':{'legacy':legacy}}}}}]
  elif mode == 'url_shortened':
   legacy={
       'id_str': '101',
       'full_text': cfg['text'].replace('https://example.com/target', 'https://t.co/mapped123'),
       'user_id_str': '123',
       'created_at': email.utils.format_datetime(datetime.datetime.now(datetime.timezone.utc)),
       'entities': {'urls': [{'url': 'https://t.co/mapped123', 'expanded_url': 'https://example.com/target'}]}
   }
   entries=[{'content':{'itemContent':{'tweet_results':{'result':{'legacy':legacy}}}}}]
  return {'data':{'user':{'result':{'timeline_v2':{'timeline':{'instructions':[{'entries':entries}]}}}}}},None
class Client:
 def __init__(self):
  self.gql=GQL(); self.http=httpx.AsyncClient(transport=env['LocalTransport'](),timeout=0.5,trust_env=False)
  if cfg.get('no_transport_replay'):
   transport=self.http._transport
   class BeforeSendFailure:
    async def request(self,**kwargs): raise RuntimeError('synthetic curl fail before any send')
    async def close(self): pass
   transport._curl_session=BeforeSendFailure()
 def set_cookies(self,cookies,clear_cookies=True): self.cookies=cookies
 def get_cookies(self): return self.cookies
 async def create_tweet(self,text):
  response=await self.http.post('http://127.0.0.1:%s/%s'%(cfg['port'],cfg['case']),json={'text':text})
  response.raise_for_status(); obj=response.json()
  return SimpleNamespace(id=obj['id'], user=SimpleNamespace(id='123',screen_name='example'))
b.new_client=lambda proxy: Client()
old_sleep=asyncio.sleep
async def fast_sleep(n): await old_sleep(0)
asyncio.sleep=fast_sleep
asyncio.run(b.main())
