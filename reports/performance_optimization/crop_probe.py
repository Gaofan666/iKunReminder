from probe import *
p=Probe(full=True)
try:
 p.js((OUT.parent/'grid_prototype.js').read_text(encoding='utf-8-sig')+";window._grid=new CachedGrid(document.querySelector('.grid-floor'));window._style=document.head.appendChild(document.createElement('style'));window._originalFrame=kunkunPet.Kunkun.prototype.frame;kunkunPet.Kunkun.prototype.frame=function(t){_grid.frame(t);return _originalFrame.call(this,t)};document.body.classList.add('grid-cached');true")
 base='.grid-cached .grid-floor{left:0;top:50vh;bottom:0;width:100vw;height:50vh;transform:none;mask-image:none;-webkit-mask-image:none}.grid-cached .grid-floor::before{display:none}.grid-floor canvas{display:block;width:100%;height:100%}'
 crop='.aurora{height:calc(21vh + 240px);transform-origin:50% 35vh;background:radial-gradient(520px 300px at 18% 21vh,rgba(111,181,107,.18),transparent 70%),radial-gradient(560px 320px at 82% 15.4vh,rgba(74,155,212,.18),transparent 70%)}@keyframes auroraFloat{from{transform:translate3d(-2%,0,0) scale(1)}to{transform:translate3d(3%,2.1vh,0) scale(1.08)}}'
 for label,css in [('crop-before',base),('crop-after',base+crop),('crop-before-return',base),('crop-after-return',base+crop)]:
  p.js("document.querySelector('[data-tab=home]').click();_style.textContent="+json.dumps(css));time.sleep(2)
  gpu=next(m['pid'] for m in p.call()['metrics'] if m['type']=='GPU')
  ps=(OUT.parent/'gpu_sample.ps1').read_text(encoding='utf-8-sig').replace('param([int]$GpuPid,[int]$Samples=6)',f'$GpuPid={gpu};$Samples=4')
  task=subprocess.Popen(['powershell.exe','-NoProfile','-Command',ps],stdout=subprocess.PIPE,stderr=subprocess.PIPE,creationflags=subprocess.CREATE_NO_WINDOW)
  p.measure(label,seconds=7)
  data,err=task.communicate(timeout=45);(OUT/(label+'-engine.json')).write_bytes(data)
finally:p.close()
