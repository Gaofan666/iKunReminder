from probe import *
p=Probe(full=True)
try:
 p.js("window._probeStyle=document.head.appendChild(document.createElement('style'))")
 flat='.aurora{will-change:transform}.card{backdrop-filter:none}.scanlines{mix-blend-mode:normal;background:repeating-linear-gradient(180deg,rgba(30,50,100,.003) 0 1px,transparent 1px 3px)}'
 for label,css in [('refine-flat-promote',flat+'.ring-wrap{will-change:transform}'),('refine-flat-no-transition',flat+'.ring-fg{transition:none}'),('refine-candidate',flat+'.ring-fg{transition:none}.ring-wrap{will-change:transform}'),('refine-no-aurora-filter',flat+'.ring-fg{transition:none}.ring-wrap{will-change:transform}.aurora{filter:none}')]:
  p.js('_probeStyle.textContent='+json.dumps(css));p.measure(label,seconds=7)
 p.js("window._origFrame=kunkunPet.Kunkun.prototype.frame;kunkunPet.Kunkun.prototype.frame=function(){}")
 p.measure('refine-no-canvas-drawing',seconds=7)
 p.js('kunkunPet.Kunkun.prototype.frame=_origFrame;_probeStyle.textContent='+json.dumps(flat+'.ring-fg{transition:none}.ring-wrap{will-change:transform}'))
 p.measure('refine-candidate-return',seconds=7)
 p.call('/trace-start');time.sleep(4);p.call('/trace-stop',path=str(OUT/'codex-candidate-trace.json'))
finally:p.close()
