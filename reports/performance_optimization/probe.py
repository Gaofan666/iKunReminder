import json, os, pathlib, subprocess, tempfile, time, urllib.request
import psutil
ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / 'reports/performance_optimization/raw'
class Probe:
    def __init__(self, full=False, flags=()):
        self.profile=pathlib.Path(tempfile.mkdtemp(prefix='codex-perf-')); self.port_file=self.profile/'port'
        env=dict(os.environ);env.pop('ELECTRON_RUN_AS_NODE',None)
        self.log=open(self.profile/'electron.log','w',encoding='utf-8')
        args=[str(ROOT/'node_modules/electron/dist/electron.exe'),str(pathlib.Path(__file__).with_suffix('.cjs')),f'--profile={self.profile}',f'--port-file={self.port_file}',*flags]
        if full: args.append('--full')
        self.proc=subprocess.Popen(args,cwd=ROOT,env=env,stdout=self.log,stderr=self.log,creationflags=subprocess.CREATE_NO_WINDOW)
        for _ in range(200):
            if self.port_file.exists():break
            if self.proc.poll() is not None:raise RuntimeError((self.profile/'electron.log').read_text())
            time.sleep(.1)
        self.url='http://127.0.0.1:'+self.port_file.read_text()
    def call(self,route='/',**data):
        req=urllib.request.Request(self.url+route,json.dumps(data).encode(),{'Content-Type':'application/json'})
        return json.load(urllib.request.urlopen(req,timeout=60))
    def js(self,code):return self.call('/eval',code=code)
    def measure(self,label,seconds=8,warmup=2):
        self.call('/activate');time.sleep(warmup);info=self.call();view=self.js("({tab:document.querySelector('.tab-btn.on')?.dataset.tab,dpr:devicePixelRatio,w:innerWidth,h:innerHeight})");processes={}
        for m in info['metrics']:
            try:
                p=psutil.Process(m['pid']);t=p.cpu_times();processes[p.pid]=(p,t.user+t.system,m['type'])
            except psutil.Error:pass
        t0=time.perf_counter();time.sleep(seconds);elapsed=time.perf_counter()-t0
        result={'label':label,'elapsed':elapsed,'bounds':info['bounds'],'visible':info['visible'],'focused':info['focused'],'processes':[]}
        for pid,(p,before,typ) in processes.items():
            try:
                t=p.cpu_times();result['processes'].append({'pid':pid,'type':typ,'cpu':100*(t.user+t.system-before)/elapsed,'rssMB':p.memory_info().rss/2**20})
            except psutil.Error:pass
        end=self.call();viewEnd=self.js("({tab:document.querySelector('.tab-btn.on')?.dataset.tab,dpr:devicePixelRatio,w:innerWidth,h:innerHeight})");result['view']=view;result['viewEnd']=viewEnd;result['visibleEnd']=end['visible'];result['valid']=info['visible'] and end['visible'] and not end['minimized'] and view==viewEnd
        result['cpu']=sum(m['cpu'] for m in result['processes']);result['machineCPU']=result['cpu']/psutil.cpu_count()
        print(json.dumps(result,ensure_ascii=False),flush=True)
        with open(OUT/'codex-probe.jsonl','a',encoding='utf-8') as f:f.write(json.dumps(result,ensure_ascii=False)+'\n')
        return result
    def close(self):
        try:self.call('/quit')
        finally:self.proc.wait(timeout=15);self.log.close()
if __name__=='__main__':
    p=Probe()
    try:
        info=p.call();(OUT/'codex-environment.json').write_text(json.dumps(info,ensure_ascii=False,indent=2),encoding='utf-8')
        p.measure('control-static')
        p.js("document.querySelector('div').style.animationPlayState='running'")
        p.measure('control-animated')
        p.js("document.querySelector('div').style.animationPlayState='paused'")
        p.measure('control-static-return')
    finally:p.close()
