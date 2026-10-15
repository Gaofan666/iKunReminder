from pathlib import Path
import hashlib,json,datetime
root=Path.cwd();dest=root/'reports/performance_optimization/backups'/('codex-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S'));dest.mkdir(parents=True,exist_ok=False)
for name in ['main.js','app.js','style.css']:(dest/name).write_bytes((root/name).read_bytes())
(dest/'manifest.json').write_text(json.dumps({n:hashlib.sha256((dest/n).read_bytes()).hexdigest() for n in ['main.js','app.js','style.css']},indent=2),encoding='utf-8')
def edit(name,old,new):
 p=root/name;s=p.read_bytes().decode('utf-8');assert s.count(old)==1,(name,old[:70],s.count(old));p.write_bytes(s.replace(old,new).encode('utf-8'))
# Preserve CRLF in untouched sections.
s=(root/'style.css').read_bytes().decode('utf-8');nl='\r\n' if '.aurora{\r\n' in s else '\n'
edit('style.css','  filter:blur(10px);', '  filter:blur(10px);'+nl+'  will-change:transform; /* 缓存极光纹理，缩放动画复用合成层 */')
edit('style.css','rgba(30,50,100,.025) 0 1px','rgba(30,50,100,.003) 0 1px')
edit('style.css','  mix-blend-mode:overlay;', '  /* 用浅色透明扫描线保留纹理，避免全屏 overlay 离屏混合。 */'+nl+'  mix-blend-mode:normal;')
edit('style.css','  backdrop-filter:blur(9px);', '  /* 面板已是 94% 不透明；实时模糊会在背景移动时反复采样背后的图层。 */')
edit('style.css','.ring-wrap{position:relative;width:132px;height:132px;flex:none}', '.ring-wrap{position:relative;width:132px;height:132px;flex:none;will-change:transform}')
edit('style.css','  transition:stroke-dashoffset .3s linear;', '  /* 250ms 刷新的进度不能再接 300ms 过渡，否则 SVG 永远在逐帧重绘。 */'+nl+'  transition:none;')
# The existing negation enabled throttling by default, contrary to its comment.
edit('main.js', "backgroundThrottling: !(process.argv.indexOf('--perf-throttle') >= 0),", "backgroundThrottling: process.argv.indexOf('--perf-throttle') >= 0,")
s=(root/'app.js').read_bytes().decode('utf-8');nl='\r\n' if '  function render() {\r\n' in s else '\n'
edit('app.js','  function render() {','  /* 同一秒内的多个 tick 只推进计时，不重复替换相同的文本节点。 */'+nl+'  function setTextIfChanged(node, value) {'+nl+'    if (node.textContent !== value) node.textContent = value;'+nl+'  }'+nl+nl+'  function render() {')
edit('app.js',"    el.clock.textContent = p(now.getHours()) + ':' + p(now.getMinutes()) + ':' + p(now.getSeconds());", "    setTextIfChanged(el.clock, p(now.getHours()) + ':' + p(now.getMinutes()) + ':' + p(now.getSeconds()));")
edit('app.js',"    el.date.textContent = now.getFullYear() + '年' + (now.getMonth() + 1) + '月' + now.getDate() + '日 · ' + wk;", "    setTextIfChanged(el.date, now.getFullYear() + '年' + (now.getMonth() + 1) + '月' + now.getDate() + '日 · ' + wk);")
edit('app.js',"      $('[data-role=\"countdown\"]', art).textContent = it.enabled ? fmt(t.remaining) : '--:--';", "      setTextIfChanged($('[data-role=\"countdown\"]', art), it.enabled ? fmt(t.remaining) : '--:--');")
edit('app.js',"      $('[data-role=\"count\"]', art).textContent = String(n);", "      setTextIfChanged($('[data-role=\"count\"]', art), String(n));")
edit('app.js',"    el.btnToggle.textContent = rt.running ? '⏸ 暂停计时' : '▶ 继续计时';", "    setTextIfChanged(el.btnToggle, rt.running ? '⏸ 暂停计时' : '▶ 继续计时');")
edit('app.js',"  function setCaption(html) { el.caption.innerHTML = html; }", "  function setCaption(html) { if (el.caption.innerHTML !== html) el.caption.innerHTML = html; }")
edit('app.js',"    if (bestKind) {"+nl+"      document.title = fmt(best) + ' ' + (bestKind.emoji || '') + ' 别感冒';"+nl+"    } else {"+nl+"      document.title = '别感冒 · 喝水休息提醒器';"+nl+"    }", "    const title = bestKind"+nl+"      ? fmt(best) + ' ' + (bestKind.emoji || '') + ' 别感冒'"+nl+"      : '别感冒 · 喝水休息提醒器';"+nl+"    if (document.title !== title) document.title = title;")
print('BACKUP',dest)
