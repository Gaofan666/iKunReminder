from probe import *
p=Probe(full=True)
try:
 p.js("window._probeStyle=document.head.appendChild(document.createElement('style'));window._originalFrame=kunkunPet.Kunkun.prototype.frame;true")
 for label,software,css in [('canvas-gpu',False,''),('canvas-cpu',True,''),('canvas-cpu-smaller-grid',True,'.grid-floor{width:calc(100vw * (1 + 31vh / 430px * .939693))}'),('canvas-gpu-return',False,'')]:
  code="window._useSoftware="+json.dumps(software)+";kunkunPet.Kunkun.prototype.frame=function(t){if(this.ctx.getContextAttributes().willReadFrequently!==_useSoftware){const old=this.canvas;const c=old.cloneNode();old.replaceWith(c);this.canvas=c;this.ctx=c.getContext('2d',{willReadFrequently:_useSoftware});if(this.ro){this.ro.unobserve(old);this.ro.observe(c)}this.w=0;this.resize()}return _originalFrame.call(this,t)};true"
  p.js(code);p.js('_probeStyle.textContent='+json.dumps(css));time.sleep(2)
  gpu=next(m['pid'] for m in p.call()['metrics'] if m['type']=='GPU')
  ps=(OUT.parent/'gpu_sample.ps1').read_text(encoding='utf-8-sig').replace('param([int]$GpuPid,[int]$Samples=6)',f'$GpuPid={gpu};$Samples=4')
  task=subprocess.Popen(['powershell.exe','-NoProfile','-Command',ps],stdout=subprocess.PIPE,stderr=subprocess.PIPE,creationflags=subprocess.CREATE_NO_WINDOW)
  p.measure(label,seconds=7)
  data,err=task.communicate(timeout=45);(OUT/(label+'-engine.json')).write_bytes(data)
finally:p.close()
