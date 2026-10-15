from probe import *
p=Probe(full=True)
failures=[]
try:
 result=p.measure('regression-budget',seconds=8)
 if not result['valid']:failures.append('window hidden: invalid measurement')
 elif result['cpu']>=80:failures.append(f"visible idle CPU {result['cpu']:.1f}% single-core exceeds 80% budget")
 p.js("document.querySelector('#btnToggle').click();true")
 time.sleep(.6)
 count=p.js("new Promise(resolve=>{let count=0;const o=new MutationObserver(ms=>count+=ms.length);document.querySelectorAll('[data-role=countdown]').forEach(e=>o.observe(e,{childList:true,characterData:true,subtree:true}));setTimeout(()=>{o.disconnect();resolve(count)},750)})")
 print('paused countdown mutations:',count,flush=True)
 if count:failures.append(f'paused countdown was rewritten {count} times without a value change')
 print('FAILURES',json.dumps(failures),flush=True)
 if failures:raise SystemExit(1)
finally:p.close()
