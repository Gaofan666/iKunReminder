from probe import *
backup=sorted((OUT.parent/'backups').glob('codex-*'))[-1]
old=(backup/'style.css').read_text(encoding='utf-8');new=(ROOT/'style.css').read_text(encoding='utf-8')
p=Probe(full=True)
try:
 p.js("document.querySelector('link[rel=stylesheet]').disabled=true;window._qaStyle=document.head.appendChild(document.createElement('style'));true")
 for label,css in [('final-before',old),('final-after',new),('final-before-return',old),('final-after-return',new)]:
  p.js('_qaStyle.textContent='+json.dumps(css));time.sleep(3)
  gpu=next(m['pid'] for m in p.call()['metrics'] if m['type']=='GPU')
  pscode=(OUT.parent/'gpu_sample.ps1').read_text(encoding='utf-8-sig').replace('param([int]$GpuPid,[int]$Samples=6)',f'$GpuPid = {gpu}; $Samples = 6')
  task=subprocess.Popen(['powershell.exe','-NoProfile','-Command',pscode],stdout=subprocess.PIPE,stderr=subprocess.PIPE,creationflags=subprocess.CREATE_NO_WINDOW)
  p.measure(label,seconds=10)
  data,err=task.communicate(timeout=45)
  (OUT/(label+'-gpu-engine.json')).write_bytes(data)
  if err: (OUT/(label+'-gpu-error.txt')).write_bytes(err);print('GPU sampling error saved',flush=True)
 # Freeze dynamic content at identical values for visual comparison only.
 p.js("document.querySelector('#btnToggle').click();window._origFrame=kunkunPet.Kunkun.prototype.frame;kunkunPet.Kunkun.prototype.frame=function(){return _origFrame.call(this,2000)};true")
 for label,css in [('before',old),('after',new)]:
  p.js('_qaStyle.textContent='+json.dumps(css));time.sleep(.4)
  p.js("document.getAnimations().forEach(a=>{a.pause();a.currentTime=2000});document.querySelectorAll('[data-role=ring]').forEach(e=>e.style.strokeDashoffset='25');document.querySelector('#tbClock').style.visibility='hidden';true")
  time.sleep(.2);p.call('/shot',path=str(OUT.parent/f'screenshots/codex-fixed-{label}.png'))
 p.js("_qaStyle.textContent="+json.dumps(new)+";kunkunPet.Kunkun.prototype.frame=_origFrame;document.getAnimations().forEach(a=>a.play());document.querySelector('#btnToggle').click();true")
 p.call('/trace-start');time.sleep(5);p.call('/trace-stop',path=str(OUT/'codex-final-trace.json'))
finally:p.close()
