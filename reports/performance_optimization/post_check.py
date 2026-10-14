from probe import *
import statistics,hashlib
p=Probe(full=True);rows=[]
try:
 for label in ['verified-after-tabs-1','verified-after-tabs-2']:
  for _ in range(4):
   p.js("document.querySelector('[data-tab=settings]').click();true");time.sleep(.1)
   p.js("document.querySelector('[data-tab=home]').click();true");time.sleep(.15)
  states=p.js("document.querySelector('.dot').getAnimations().map(a=>a.playState)")
  assert states==['paused'],states
  gpu=next(m['pid'] for m in p.call()['metrics'] if m['type']=='GPU')
  ps=(OUT.parent/'gpu_sample.ps1').read_text(encoding='utf-8-sig').replace('param([int]$GpuPid,[int]$Samples=6)',f'$GpuPid={gpu};$Samples=6')
  task=subprocess.Popen(['powershell.exe','-NoProfile','-Command',ps],stdout=subprocess.PIPE,stderr=subprocess.PIPE,creationflags=subprocess.CREATE_NO_WINDOW)
  row=p.measure(label,seconds=10,warmup=4)
  data,err=task.communicate(timeout=45);(OUT/(label+'-engine.json')).write_bytes(data)
  values=json.loads(data.decode('utf-8-sig'));values=values if isinstance(values,list) else[values]
  row['gpu3DMedian']=statistics.median(v['UtilizationPercentage'] for v in values);row['dotStates']=states;rows.append(row)
  print('GPU after tabs',label,row['gpu3DMedian'],flush=True)
  assert row['valid'] and row['cpu']<64 and row['gpu3DMedian']<40,row
 p.call('/shot',path=str(OUT.parent/'screenshots/codex-verified-main.png'))
 result={'rows':rows,'hashes':{n:hashlib.sha256((ROOT/n).read_bytes()).hexdigest() for n in ['app.js','style.css','main.js']}}
 (OUT/'codex-verified-summary.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
finally:p.close()
