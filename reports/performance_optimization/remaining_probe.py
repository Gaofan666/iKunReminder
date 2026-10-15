from probe import *
p=Probe(full=True)
try:
 css='.aurora{will-change:transform}.card{backdrop-filter:none}.scanlines{mix-blend-mode:normal;background:repeating-linear-gradient(180deg,rgba(30,50,100,.003) 0 1px,transparent 1px 3px)}.ring-fg{transition:none}.ring-wrap{will-change:transform}'
 p.js("window._probeStyle=document.head.appendChild(document.createElement('style'));_probeStyle.textContent="+json.dumps(css))
 p.measure('remaining-candidate',seconds=8)
 p.js("window._origFrame=kunkunPet.Kunkun.prototype.frame;kunkunPet.Kunkun.prototype.frame=function(){};true")
 p.measure('remaining-no-canvas',seconds=8)
 p.js('kunkunPet.Kunkun.prototype.frame=_origFrame;true')
 p.js("window._origText=Object.getOwnPropertyDescriptor(Node.prototype,'textContent');Object.defineProperty(Node.prototype,'textContent',{..._origText,set(value){if(_origText.get.call(this)!==String(value))_origText.set.call(this,value)}});true")
 p.measure('remaining-guard-text',seconds=8)
 p.call('/trace-start');time.sleep(4);p.call('/trace-stop',path=str(OUT/'codex-candidate-trace.json'))
finally:p.close()
