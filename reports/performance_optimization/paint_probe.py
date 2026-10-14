from probe import *
p=Probe(full=True)
try:
 p.call('/bounds',x=1518,y=110,width=1180,height=840)
 p.js("window._probeStyle=document.head.appendChild(document.createElement('style'))")
 layers=p.call('/layers');(OUT/'codex-layers.json').write_text(json.dumps(layers,ensure_ascii=False,indent=2),encoding='utf-8')
 for label,css in [
 ('paint-baseline',''),
 ('paint-no-transitions','*{transition:none!important}'),
 ('paint-promote-rings','.ring-wrap,#stage{will-change:transform}'),
 ('paint-isolate-decor','.grid-floor,.aurora{isolation:isolate;contain:paint}.scanlines{mix-blend-mode:normal}'),
 ('paint-isolate-all','.ring-wrap,#stage{will-change:transform}.grid-floor,.aurora{isolation:isolate;contain:paint}.scanlines{mix-blend-mode:normal}.card{backdrop-filter:none}'),
 ('paint-baseline-return','')]:
  p.js('_probeStyle.textContent='+json.dumps(css));p.measure(label,seconds=6)
finally:p.close()
