from probe import *
p=Probe(full=True)
try:
 p.js((OUT.parent/'grid_prototype.js').read_text(encoding='utf-8-sig')+";window._grid=new CachedGrid(document.querySelector('.grid-floor'));window._style=document.head.appendChild(document.createElement('style'));window._originalFrame=kunkunPet.Kunkun.prototype.frame;document.body.classList.add('grid-cached');true")
 base='.grid-cached .grid-floor{left:0;top:50vh;bottom:0;width:100vw;height:50vh;transform:none;mask-image:none;-webkit-mask-image:none}.grid-cached .grid-floor::before{display:none}.grid-floor canvas{display:block;width:100%;height:100%}'
 p.js('_style.textContent='+json.dumps(base)+";window._decorAnimations=[...document.querySelector('.aurora').getAnimations(),...document.querySelector('.dot').getAnimations()];true")
 for label,manual in [('sync-before',False),('sync-after',True),('sync-before-return',False),('sync-after-return',True)]:
  p.js("document.querySelector('[data-tab=home]').click();window._manual="+json.dumps(manual)+";window._animationBase=performance.now();window._animationPhases=_decorAnimations.map(a=>a.currentTime||0);_decorAnimations.forEach(a=>_manual?a.pause():a.play());kunkunPet.Kunkun.prototype.frame=function(t){_grid.frame(t);if(_manual)_decorAnimations.forEach((a,i)=>a.currentTime=_animationPhases[i]+t-_animationBase);return _originalFrame.call(this,t)};true");time.sleep(2)
  gpu=next(m['pid'] for m in p.call()['metrics'] if m['type']=='GPU')
  ps=(OUT.parent/'gpu_sample.ps1').read_text(encoding='utf-8-sig').replace('param([int]$GpuPid,[int]$Samples=6)',f'$GpuPid={gpu};$Samples=4')
  task=subprocess.Popen(['powershell.exe','-NoProfile','-Command',ps],stdout=subprocess.PIPE,stderr=subprocess.PIPE,creationflags=subprocess.CREATE_NO_WINDOW)
  p.measure(label,seconds=7)
  data,err=task.communicate(timeout=45);(OUT/(label+'-engine.json')).write_bytes(data)
finally:p.close()
