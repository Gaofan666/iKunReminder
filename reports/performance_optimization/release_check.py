from probe import *
import statistics
p=Probe(full=True)
reference=pathlib.Path((OUT.parent/'reference_path.txt').read_text(encoding='utf-8'))
if (ROOT/'assets/music.mp3').exists():
 (reference/'assets').mkdir(exist_ok=True);(reference/'assets/music.mp3').write_bytes((ROOT/'assets/music.mp3').read_bytes())
rows=[]
try:
 for label,source in [('release-before',reference),('release-after',ROOT),('release-before-return',reference),('release-after-return',ROOT)]:
  p.call('/load',path=str(source/'index.html'));time.sleep(3);p.call('/mute')
  p.js("document.querySelector('[data-tab=home]').click();true");time.sleep(2)
  gpu=next(m['pid'] for m in p.call()['metrics'] if m['type']=='GPU')
  ps=(OUT.parent/'gpu_sample.ps1').read_text(encoding='utf-8-sig').replace('param([int]$GpuPid,[int]$Samples=6)',f'$GpuPid={gpu};$Samples=6')
  task=subprocess.Popen(['powershell.exe','-NoProfile','-Command',ps],stdout=subprocess.PIPE,stderr=subprocess.PIPE,creationflags=subprocess.CREATE_NO_WINDOW)
  result=p.measure(label,seconds=10)
  data,err=task.communicate(timeout=45);(OUT/(label+'-engine.json')).write_bytes(data)
  values=json.loads(data.decode('utf-8-sig'));values=values if isinstance(values,list) else[values]
  result['gpu3DMedian']=statistics.median(v['UtilizationPercentage'] for v in values);rows.append(result)
  print('GPU median',label,result['gpu3DMedian'],flush=True)
  p.call('/shot',path=str(OUT.parent/f'screenshots/{label}.png'))
 (OUT/'codex-release-summary.json').write_text(json.dumps(rows,indent=2),encoding='utf-8')
 assert all(r['valid'] and r['view']['tab']=='home' and r['view']['dpr']==2 for r in rows),'inconsistent window or view'
 for r in rows:
  if '-after' in r['label']:
   assert r['cpu']<64,r
   assert r['gpu3DMedian']<40,r
 p.call('/trace-start');time.sleep(5);p.call('/trace-stop',path=str(OUT/'codex-release-trace.json'))
finally:p.close()
