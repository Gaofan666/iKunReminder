from probe import *
p=Probe(full=True)
try:
 p.js("window._probeStyle=document.head.appendChild(document.createElement('style'))")
 cached='.aurora{will-change:transform}'
 flat=cached+'.card{backdrop-filter:none}.scanlines{mix-blend-mode:normal}'
 rings=flat+'.ring-fg{transition:none}.ring-wrap{will-change:transform}'
 for label,css in [('cache-baseline',''),('cache-aurora',cached),('cache-flat',flat),('cache-flat-rings',rings),('cache-all',rings+'.grid-floor{mask-image:none;-webkit-mask-image:none}'),('cache-baseline-return','')]:
  p.js('_probeStyle.textContent='+json.dumps(css));p.measure(label,seconds=7)
finally:p.close()
