from probe import *
p=Probe(full=True)
try:
 p.js("window._probeStyle=document.head.appendChild(document.createElement('style'))")
 for label,css in [('gpu-current',''),('gpu-no-blur','.aurora{filter:none}'),('gpu-no-grid','.grid-floor{visibility:hidden}'),('gpu-no-aurora','.aurora{visibility:hidden}'),('gpu-stepped','.grid-floor::before{animation-timing-function:steps(78)}.aurora{animation-timing-function:steps(420)}.dot{animation-timing-function:steps(48)}'),('gpu-no-decor','.grid-floor,.aurora,.scanlines{visibility:hidden}')]:
  p.js('_probeStyle.textContent='+json.dumps(css));time.sleep(2)
  gpu=next(m['pid'] for m in p.call()['metrics'] if m['type']=='GPU')
  ps=(OUT.parent/'gpu_sample.ps1').read_text(encoding='utf-8-sig').replace('param([int]$GpuPid,[int]$Samples=6)',f'$GpuPid = {gpu}; $Samples = 4')
  task=subprocess.Popen(['powershell.exe','-NoProfile','-Command',ps],stdout=subprocess.PIPE,stderr=subprocess.PIPE,creationflags=subprocess.CREATE_NO_WINDOW)
  p.measure(label,seconds=7)
  data,err=task.communicate(timeout=45);(OUT/(label+'-engine.json')).write_bytes(data)
finally:p.close()
