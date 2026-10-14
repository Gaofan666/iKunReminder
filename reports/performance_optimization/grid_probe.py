from probe import *
p=Probe(full=True)
try:
 js=(OUT.parent/'grid_prototype.js').read_text(encoding='utf-8-sig')
 p.js(js+";window._grid=new CachedGrid(document.querySelector('.grid-floor'));window._style=document.head.appendChild(document.createElement('style'));window._originalFrame=kunkunPet.Kunkun.prototype.frame;true")
 css='.grid-cached .grid-floor{left:0;top:50vh;bottom:0;width:100vw;height:50vh;transform:none;mask-image:none;-webkit-mask-image:none}.grid-cached .grid-floor::before{display:none}.grid-floor canvas{display:block;width:100%;height:100%}'
 p.js('_style.textContent='+json.dumps(css))
 for label,cached in [('grid-budget-before',False),('grid-budget-after',True),('grid-budget-before-return',False),('grid-budget-after-return',True)]:
  p.js('document.body.classList.toggle("grid-cached",'+json.dumps(cached)+');kunkunPet.Kunkun.prototype.frame=function(t){'+('_grid.frame(t);' if cached else '')+'return _originalFrame.call(this,t)};true');time.sleep(2)
  gpu=next(m['pid'] for m in p.call()['metrics'] if m['type']=='GPU')
  ps=(OUT.parent/'gpu_sample.ps1').read_text(encoding='utf-8-sig').replace('param([int]$GpuPid,[int]$Samples=6)',f'$GpuPid={gpu};$Samples=4')
  task=subprocess.Popen(['powershell.exe','-NoProfile','-Command',ps],stdout=subprocess.PIPE,stderr=subprocess.PIPE,creationflags=subprocess.CREATE_NO_WINDOW)
  p.measure(label,seconds=7)
  data,err=task.communicate(timeout=45);(OUT/(label+'-engine.json')).write_bytes(data)
 p.call('/shot',path=str(OUT.parent/'screenshots/codex-grid-prototype.png'))
finally:p.close()
