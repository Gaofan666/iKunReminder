import sys
sys.path.insert(0,'reports/performance_optimization')
from probe import *
p=Probe(full=True);rows=[]
try:
 code=(ROOT/'app.js').read_text(encoding='utf-8');code=code[code.index('  function CachedGrid(host)'):code.index('  let cachedGrid = null;')]
 p.js(code+";window._projectionHost=document.createElement('div');_projectionHost.className='grid-floor';_projectionHost.style.visibility='hidden';document.body.appendChild(_projectionHost);window._projection=new CachedGrid(_projectionHost);true")
 for box in [dict(x=130,y=10,width=900,height=650),dict(x=130,y=10,width=760,height=560),dict(x=1518,y=110,width=1180,height=840)]:
  p.call('/bounds',**box);time.sleep(.7);p.call('/bounds',**box);time.sleep(.8)
  row=p.js("""(()=>{_projection.resize();const plane=document.createElement('div');plane.style.cssText='position:fixed;left:50%;top:auto;bottom:-12vh;width:240vw;height:62vh;transform:translateX(-50%) perspective(430px) rotateX(70deg);transform-origin:50% 50%';document.body.appendChild(plane);const errors=[];for(const[x,y]of [[0,0],[-200,-100],[200,100]]){const mark=document.createElement('i');mark.style.cssText='position:absolute;width:0;height:0;left:'+(_projection.planeWidth/2+x)+'px;top:'+(_projection.planeHeight/2+y)+'px';plane.appendChild(mark);const r=mark.getBoundingClientRect(),q=_projection.point(x,y);errors.push(Math.hypot(r.x-q.x,r.y-q.y-_projectionHost.getBoundingClientRect().top))}plane.remove();const c=document.querySelector('.grid-floor canvas');return{viewport:[innerWidth,innerHeight],dpr:devicePixelRatio,maxError:Math.max(...errors),canvas:[c.width,c.height],cached:document.body.classList.contains('grid-cached')}})()""")
  rows.append(row);assert row['maxError']<.15 and row['cached'] and row['canvas'][0]<=1600 and row['canvas'][1]<=800,row
 print(json.dumps(rows),flush=True);(OUT/'codex-resize-checks.json').write_text(json.dumps(rows,indent=2),encoding='utf-8')
finally:p.close()
