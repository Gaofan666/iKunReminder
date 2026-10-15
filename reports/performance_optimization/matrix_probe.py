from probe import *
p=Probe(full=True)
try:
 p.js("window._probeStyle=document.head.appendChild(document.createElement('style'))")
 def test(label,css):
  p.js('_probeStyle.textContent='+json.dumps(css));p.measure(label,seconds=6)
 effects='*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important;filter:none!important;mix-blend-mode:normal!important;mask-image:none!important;-webkit-mask-image:none!important}'
 decor='.grid-floor,.aurora,.scanlines{display:none!important}'
 test('matrix-baseline','')

 test('matrix-bare-canvas',effects+decor)
 test('matrix-view-layer', '#view{will-change:auto!important} .card{backdrop-filter:none!important}')
 test('matrix-no-canvas',effects+decor+'canvas{visibility:hidden!important}')
 test('matrix-only-backdrop','*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}')
 test('matrix-only-mask','*{mask-image:none!important;-webkit-mask-image:none!important}')
 test('matrix-grid-hidden','.grid-floor{display:none!important}')
 test('matrix-baseline-return','')
finally:p.close()
