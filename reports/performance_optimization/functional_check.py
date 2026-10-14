from probe import *
p=Probe(full=True);checks={}
try:
 p.call('/mute');p.js('speechSynthesis.speak=function(){};kunkunPet.setSoundOn(false);true')
 checks['backgroundThrottlingDisabled']=p.call('/preferences')['backgroundThrottling'] is False
 p.js('window._frameCount=0;window._originalFrame=kunkunPet.Kunkun.prototype.frame;kunkunPet.Kunkun.prototype.frame=function(t){_frameCount++;return _originalFrame.call(this,t)};true')
 p.call('/blur')
 a=p.js("({frames:_frameCount,time:document.getAnimations().find(a=>a.animationName==='auroraFloat').currentTime})")
 time.sleep(2)
 b=p.js("({frames:_frameCount,time:document.getAnimations().find(a=>a.animationName==='auroraFloat').currentTime})")
 checks['animationContinuesWithoutFocus']=not p.call()['focused'] and b['frames']-a['frames']>=35 and b['time']-a['time']>1500
 checks['unfocusedFramesIn2s']=b['frames']-a['frames']
 p.js("document.querySelector('#btnToggle').click();true");time.sleep(.5)
 a=p.js("document.querySelector('[data-role=countdown]').textContent");time.sleep(1.4);b=p.js("document.querySelector('[data-role=countdown]').textContent")
 checks['pauseKeepsCountdown']=a==b
 p.js("document.querySelector('#btnToggle').click();true");time.sleep(1.4)
 checks['resumeAdvancesCountdown']=p.js("document.querySelector('[data-role=countdown]').textContent")!=b
 code=(ROOT/'app.js').read_text(encoding='utf-8');code=code[code.index('  function CachedGrid(host)'):code.index('  let cachedGrid = null;')]
 p.js(code+";window._projectionHost=document.createElement('div');_projectionHost.className='grid-floor';_projectionHost.style.visibility='hidden';document.body.appendChild(_projectionHost);window._projection=new CachedGrid(_projectionHost);_projection.resize();true")
 errors=p.js("""(()=>{const plane=document.createElement('div');plane.style.cssText='position:fixed;left:50%;top:auto;bottom:-12vh;width:240vw;height:62vh;transform:translateX(-50%) perspective(430px) rotateX(70deg);transform-origin:50% 50%';document.body.appendChild(plane);const errors=[];for(const [x,y] of [[0,0],[-200,-150],[200,100]]){const mark=document.createElement('i');mark.style.cssText='position:absolute;width:0;height:0;left:'+(_projection.planeWidth/2+x)+'px;top:'+(_projection.planeHeight/2+y)+'px';plane.appendChild(mark);const r=mark.getBoundingClientRect(),q=_projection.point(x,y);errors.push(Math.hypot(r.x-q.x,r.y-(q.y+_projectionHost.getBoundingClientRect().top)));}plane.remove();return errors})()""")
 checks['projectionMatchesCSS']=max(errors)<.15
 checks['maxProjectionErrorPixels']=max(errors)
 checks['cachedGridEnabled']=p.js("document.body.classList.contains('grid-cached') && document.querySelector('.grid-floor canvas').width>0")
 for tab in ['todo','diary','arxiv','settings','home']:
  p.js("document.querySelector('[data-tab="+tab+"]').click();true");time.sleep(.3)
  checks['tab-'+tab]=p.js("document.querySelector('[data-tab="+tab+"]').classList.contains('on')")
  p.call('/shot',path=str(OUT.parent/f'screenshots/codex-{tab}.png'))
 checks['decorControlledAfterTabs']=p.js("[...document.querySelector('.aurora').getAnimations(),...document.querySelector('.dot').getAnimations()].every(a=>a.playState==='paused')")
 p.js("document.querySelector('[data-role=skip]').click();true");time.sleep(.8)
 checks['reminderOpens']=not p.js("document.querySelector('#overlay').hidden")
 p.call('/shot',path=str(OUT.parent/'screenshots/codex-reminder.png'))
 p.js("document.querySelector('#alertDone').click();true");time.sleep(.4)
 checks['reminderCompletes']=p.js("document.querySelector('#overlay').hidden")
 (OUT/'codex-functional-checks.json').write_text(json.dumps(checks,indent=2),encoding='utf-8')
 print(json.dumps(checks),flush=True)
 assert all(v for v in checks.values()),checks
finally:p.close()
