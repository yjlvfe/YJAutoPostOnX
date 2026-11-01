#!/usr/bin/env python3
"""Verify report integrity, safety and create a complete native-attachment ZIP."""
import hashlib,json,os,pathlib,re,sqlite3,subprocess,sys,zipfile
D=pathlib.Path(__file__).resolve().parent.parent;ROOT=pathlib.Path('/root/Projects/YJAutoPostOnX/Bot');EV=D/'EVIDENCE';ZIP=D.parent/(D.name+'.zip')
def sha(b):return hashlib.sha256(b).hexdigest()
def write(p,o):p.write_text(json.dumps(o,indent=2,ensure_ascii=False)+'\n')
r=json.loads((D/'TEST_RESULTS.json').read_text());tests=r['tests'];ids=[t['test_id'] for t in tests];assert len(ids)==len(set(ids)), 'duplicate test ID'
required={'test_id','source_files','actual_execution_path','source_hash','input','expected','actual','assertion_result','post_count','state_before','state_after','evidence_path','limitations'}
counts={s:sum(t['assertion_result']==s for t in tests) for s in ('PASS','FAIL','HARNESS_ERROR','NOT_TESTED')};assert counts==r['counts'];baseline=json.loads((EV/'baseline-source-hashes.json').read_text());matches={k:sha((ROOT/k).read_bytes())==v for k,v in baseline.items()};assert all(matches.values()),'source drift'
for t in tests:
 assert required<=t.keys(),t['test_id'];p=D/t['evidence_path'];assert p.is_dir() and (p/'result.json').is_file(),t['test_id'];assert json.loads((p/'result.json').read_text())==t,t['test_id'];assert any(p.glob('*.stdout')) and any(p.glob('*.stderr')) and any(p.glob('*.exit.json')),t['test_id'];assert all(baseline[k]==v for k,v in t['source_hash'].items()),t['test_id']
isolation=json.loads((EV/'isolation.json').read_text());assert isolation['only_loopback_and_no_routes'] is True and isolation['external_connect']['name']=='ENETUNREACH'
ps=subprocess.check_output(['/bin/ps','-eo','pid,ppid,pgid,args'],text=True);left=[line for line in ps.splitlines() if str(D/'TEST_RUNNER') in line and '/bin/ps' not in line and 'package_verify.py' not in line];assert not left, 'test processes remain'
git=subprocess.run(['git','-C',str(ROOT),'status','--short','--untracked-files=no'],capture_output=True,text=True,timeout=20);(EV/'final-git-status.txt').write_text(git.stdout);assert git.returncode==0
# Inspect every synthetic SQLite state. Never read production DB or account files.
db_count=0
for f in D.rglob('*.sqlite'):
 with sqlite3.connect('file:'+str(f)+'?mode=ro',uri=True) as con:
  value=json.loads(con.execute('select json from state where id=1').fetchone()[0]);assert all(a.get('id')=='acct' for a in value.get('accounts',[])), 'unexpected account in fixture';db_count+=1
# High-signal literal patterns only. Never emit secret values; report paths/kinds.
patterns={'telegram_bot_token':re.compile(rb'(?<![0-9])[0-9]{8,12}:[A-Za-z0-9_-]{30,}'), 'private_key':re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'), 'github_token':re.compile(rb'gh[pousr]_[A-Za-z0-9]{30,}'), 'aws_key':re.compile(rb'AKIA[A-Z0-9]{16}'), 'jwt':re.compile(rb'eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}')}
# Known fixture values are explicitly non-secret. Token-key names alone are not secrets.
violations=[];scanned=0;bytes_scanned=0
for f in sorted(D.rglob('*')):
 if not f.is_file() or f.name=='MANIFEST.json':continue
 data=f.read_bytes();scanned+=1;bytes_scanned+=len(data)
 for kind,pat in patterns.items():
  if pat.search(data):violations.append({'file':str(f.relative_to(D)),'kind':kind})
scan={'files_scanned':scanned,'bytes_scanned':bytes_scanned,'sqlite_fixtures_opened':db_count,'violations':violations,'checks':list(patterns),'synthetic_credential_values':['TEST_AUTH_VALUE','TEST_CSRF_VALUE'],'limitations':'Pattern-based scan, not a guarantee against all secret formats; SQLite fixtures additionally inspected for synthetic account IDs; no live production DB or cookies read.'}
write(EV/'secret-scan.json',scan);assert not violations,'potential secrets detected; inspect paths, do not package'
verification={'case_count':len(tests),'counts':counts,'test_schema_evidence_reconciled':True,'all_scoped_source_hashes_match':all(matches.values()),'source_match_details':matches,'isolation_enforced':True,'test_processes_remaining':len(left),'git_status_exit':git.returncode,'production_mutation_note':'Scoped source hashes only; no whole-host claim; original tracked git state already dirty.','limitations':'See UNRESOLVED.md; unlisted scenarios are not counted as NOT_TESTED test cases.'}
write(EV/'verification.json',verification)
files=[f for f in sorted(D.rglob('*')) if f.is_file() and f.name!='MANIFEST.json']; entries={str(f.relative_to(D)):{'sha256':sha(f.read_bytes()),'size':f.stat().st_size} for f in files};write(D/'MANIFEST.json',{'algorithm':'sha256','self_excluded':'MANIFEST.json cannot hash itself','archive_excluded':'ZIP sits outside report directory','file_count':len(entries),'files':entries})
with zipfile.ZipFile(ZIP,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as z:
 for f in sorted(D.rglob('*')):
  if f.is_file():z.write(f,arcname=str(pathlib.Path(D.name)/f.relative_to(D)))
with zipfile.ZipFile(ZIP) as z:
 assert z.testzip() is None,'CRC failure';names=set(z.namelist());expected={str(pathlib.Path(D.name)/f.relative_to(D)) for f in D.rglob('*') if f.is_file()};assert names==expected,'archive membership mismatch'
 manifest=json.loads(z.read(D.name+'/MANIFEST.json'))
 for name,info in manifest['files'].items():
  data=z.read(D.name+'/'+name);assert sha(data)==info['sha256'] and len(data)==info['size'],name
 for name in names:
  data=z.read(name)
  for kind,pat in patterns.items():assert not pat.search(data), 'secret pattern in '+name+' '+kind
print(json.dumps({'zip':str(ZIP),'zip_sha256':sha(ZIP.read_bytes()),'zip_bytes':ZIP.stat().st_size,'zip_crc':'OK','member_count':len(names),'manifest_entries_verified':len(entries),'case_count':len(tests),'counts':counts,'secret_scan_violations':len(violations),'remaining_test_processes':len(left),'scoped_source_hashes_match':True},indent=2))
