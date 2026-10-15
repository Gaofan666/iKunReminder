from pathlib import Path
import datetime
root=Path.cwd();backup=root/'reports/performance_optimization/backups'/('before-grid-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S'));backup.mkdir()
for n in ['app.js','style.css']:(backup/n).write_bytes((root/n).read_bytes())
p=root/'app.js';s=p.read_bytes().decode('utf-8');nl='\r\n' if '  function render() {\r\n' in s else '\n'
code=(root/'reports/performance_optimization/grid_prototype.js').read_text(encoding='utf-8-sig')
code=code.replace('  this.startedAt = performance.now();','  this.elapsed = 0; this.lastAt = 0;')
code=code.replace('  this.canvas.width = this.cache.width = Math.max(1, Math.round(w));\n  this.canvas.height = this.cache.height = Math.max(1, Math.round(h / 2));', '''  // 柔和的背景最多 1600×800；前景文字、角色的 DPR 不受影响。
  const scale = Math.min(1, 1600 / w, 1600 / h);
  this.canvas.width = this.cache.width = Math.max(1, Math.round(w * scale));
  this.canvas.height = this.cache.height = Math.max(1, Math.round(h / 2 * scale));
  this.sx = this.canvas.width / w; this.sy = this.canvas.height / (h / 2);
  this.cacheCtx.setTransform(this.sx, 0, 0, this.sy, 0, 0);''')
code=code.replace('  ctx.clearRect(0,0,this.canvas.width,this.canvas.height);','  ctx.setTransform(1,0,0,1,0,0);\n  ctx.clearRect(0,0,this.canvas.width,this.canvas.height);')
code=code.replace('  const phase = (((now-this.startedAt)/2600)%1+1)%1*64;', '''  ctx.setTransform(this.sx,0,0,this.sy,0,0);
  if (this.lastAt) this.elapsed += Math.max(0, now - this.lastAt);
  this.lastAt = now;
  const phase = (this.elapsed / 2600 % 1) * 64;''')
intro='''  /* 透视网格：在屏幕下半部投影并缓存纵线，避免对 240vw 的 3D 遮罩表面逐帧合成。
     430px 透视、70 度倾角、64px 周期、2.6 秒速度及淡出沿用原 CSS。
     初始化失败会回退到原 CSS 网格。 */
'''
init='''
  let cachedGrid = null;
  try {
    const host = document.querySelector('.grid-floor');
    if (host) {
      cachedGrid = new CachedGrid(host);
      cachedGrid.frame(performance.now());
      document.body.classList.add('grid-cached');
    }
  } catch (e) {
    if (cachedGrid) cachedGrid.canvas.remove();
    cachedGrid = null;
  }

  let decorAnimations = null;
  let decorLastAt = 0;
  function drawDecor(now) {
    const body = document.body;
    const allPaused = body.classList.contains('ablate-all-motion') || body.classList.contains('ablate-nothing');
    if (cachedGrid && !allPaused && !body.classList.contains('ablate-grid-motion')) {
      try { cachedGrid.frame(now); }
      catch (e) {
        cachedGrid.canvas.remove(); cachedGrid = null;
        body.classList.remove('grid-cached');
      }
    } else if (cachedGrid) { cachedGrid.lastAt = 0; }
    if (!decorAnimations) {
      decorAnimations = [];
      document.querySelectorAll('.aurora,.dot,.logo').forEach(function (node) {
        node.getAnimations().forEach(function (animation) {
          animation.pause();
          decorAnimations.push({ animation: animation, aurora: node.classList.contains('aurora') });
        });
      });
    }
    const dt = decorLastAt ? Math.max(0, now - decorLastAt) : 0;
    decorLastAt = now;
    // 以原动画的 currentTime 推进，保留 CSS 缓动和方向；与角色共用 30fps。
    decorAnimations.forEach(function (entry) {
      if (allPaused || (entry.aurora
        ? body.classList.contains('ablate-aurora-motion')
        : body.classList.contains('ablate-minor-motion'))) return;
      entry.animation.currentTime = (entry.animation.currentTime || 0) + dt;
    });
  }

'''
needle="  const stage = new Kunkun($('#stage'));";assert s.count(needle)==1
insert=intro+'\n'.join('  '+line if line else '' for line in code.splitlines())+'\n'+init
s=s.replace(needle,insert.replace('\n',nl)+needle)
needle='    lastFrameAt = now;'+nl+'    stage.frame(now);';assert s.count(needle)==1;s=s.replace(needle,'    lastFrameAt = now;'+nl+'    drawDecor(now);'+nl+'    stage.frame(now);')
needle='    animRunning = true;'+nl+'    lastFrameAt = 0;';assert s.count(needle)==1;s=s.replace(needle,'    animRunning = true;'+nl+'    decorLastAt = 0;'+nl+'    if (cachedGrid) cachedGrid.lastAt = 0;'+nl+'    lastFrameAt = 0;')
# Replace misleading historical claims beside the unchanged rAF scheduler.
a=s.index('  /* 限帧：rAF 每秒 60 次');b=s.index('  let FRAME_MS',a);s=s[:a]+('  /* 角色和背景统一按 30fps 更新；仍用 rAF 对齐显示器，动画时间按真实经过时间推进。 */'+nl)+s[b:]
a=s.index('    /* ⚠️ 用 setTimeout 自排队');b=s.index('    rafId = requestAnimationFrame(loop);',a);s=s[:a]+s[b:]
p.write_bytes(s.encode('utf-8'))
p=root/'style.css';s=p.read_bytes().decode('utf-8');needle='.aurora{';assert s.count(needle)==1
css='''/* JS 投影缓存初始化成功后接管网格；保留原 CSS 作为回退。 */
body.grid-cached .grid-floor{
  left:0;top:50vh;bottom:0;width:100vw;height:50vh;
  transform:none;-webkit-mask-image:none;mask-image:none;
}
body.grid-cached .grid-floor::before{display:none}
body.grid-cached .grid-floor canvas{display:block;width:100%;height:100%}

'''
s=s.replace(needle,css+needle);p.write_bytes(s.encode('utf-8'))
print('Grid integrated; backup:',backup)
