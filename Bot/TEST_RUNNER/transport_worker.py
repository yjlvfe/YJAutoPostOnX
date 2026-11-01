import ast,asyncio,json,pathlib,sys
import httpx
from curl_cffi.requests import AsyncSession
cfg=json.loads(pathlib.Path(sys.argv[1]).read_text());root=pathlib.Path('/root/Projects/YJAutoPostOnX/Bot');source=(root/'python/direct_x_bridge.py').read_text();tree=ast.parse(source);f=next(x for x in tree.body if isinstance(x,ast.FunctionDef) and x.name=='new_client');c=next(x for x in f.body if isinstance(x,ast.ClassDef) and x.name=='OnlySocksTransport');c.name='LocalTransport';i=next(x for x in c.body if isinstance(x,ast.FunctionDef) and x.name=='__init__');i.body=ast.parse('self.transport=httpx.AsyncHTTPTransport(retries=0,trust_env=False)\nself._curl_session=AsyncSession(trust_env=False,timeout=0.3)').body;h=next(x for x in c.body if isinstance(x,ast.AsyncFunctionDef) and x.name=='handle_async_request');g=next(x for x in h.body if isinstance(x,ast.If) and any(isinstance(y,ast.Raise) for y in ast.walk(x)) and 'proxy_destination_denied' in ast.unparse(x));g.test=ast.parse("request.url.scheme != 'http' or request.url.host != '127.0.0.1' or request.url.port != PORT",mode='eval').body;env={'httpx':httpx,'AsyncSession':AsyncSession,'PORT':cfg['port'],'_orig_http_transport_code':httpx.AsyncHTTPTransport.handle_async_request.__code__};exec(compile(ast.fix_missing_locations(ast.Module(body=[c],type_ignores=[])),'source_hash_bound_transport','exec'),env)
class FailCurl:
 async def request(self,**kwargs):raise RuntimeError('synthetic curl failure before send')
 async def close(self):pass
async def main():
 t=env['LocalTransport']()
 if cfg.get('curlfail'):
  await t._curl_session.close();t._curl_session=FailCurl()
 if cfg.get('unreachable'):
  for name in ('transport','_curl_session'):
   obj=getattr(t,name,None)
   if obj is not None: await obj.aclose() if hasattr(obj,'aclose') else await obj.close()
  env['PORT']=cfg['target_port'];t=env['LocalTransport']()
 try:
  async with httpx.AsyncClient(transport=t,timeout=.3,trust_env=False) as c:
   r=await c.post('http://127.0.0.1:%d/%s'%(cfg.get('target_port',cfg['port']),cfg['case']),content=b'synthetic'); print(json.dumps({'outcome':'response','status':r.status_code,'body':r.text}))
 except Exception as e: print(json.dumps({'outcome':'exception','type':type(e).__name__,'message':str(e)[:150]}))
asyncio.run(main())
