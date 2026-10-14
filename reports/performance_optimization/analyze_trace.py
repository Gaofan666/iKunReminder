import json,collections,pathlib
import sys
p=pathlib.Path(sys.argv[1] if len(sys.argv)>1 else 'reports/performance_optimization/raw/codex-baseline-trace.json')
d=json.loads(p.read_text(encoding='utf-8'));ev=d['traceEvents']; names={};procs={}
for e in ev:
 if e.get('ph')=='M':
  if e['name']=='thread_name':names[(e['pid'],e['tid'])]=e['args']['name']
  if e['name']=='process_name':procs[e['pid']]=e['args']['name']
sumdur=collections.Counter();count=collections.Counter()
for e in ev:
 if e.get('ph')=='X':
  key=(e['pid'],e['tid'],e['name']);sumdur[key]+=e.get('dur',0);count[key]+=1
for (pid,tid,n),v in sumdur.most_common(65):print(procs.get(pid,pid),names.get((pid,tid),tid),n,round(v/1e6,3),count[pid,tid,n])
