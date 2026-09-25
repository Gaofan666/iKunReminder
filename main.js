/* =========================================================================
   别感冒提醒器 —— Electron 主进程
   职责：
     · 无边框窗口 + 自绘标题栏；到点把窗口强制拉到前台
     · 系统托盘常驻（关闭/✕ = 收进右下角托盘，不退出）
     · 宠物模式：只剩动画的小窗、悬浮置顶，右键弹原生菜单
     · 屏幕缩放（DPI）适配：窗口逻辑尺寸 = 物理设计尺寸 ÷ k，k 见 ui-scale.js
   ========================================================================= */
const { app, BrowserWindow, ipcMain, Menu, screen, Tray, nativeImage, powerMonitor, globalShortcut, dialog, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const UI = require('./ui-scale.js');

/* 自动更新（electron-updater）。require 失败不影响软件本体 ——
   退化成「不支持自动更新」，设置页会照实说明，不会崩。 */
let autoUpdater = null;
try { autoUpdater = require('electron-updater').autoUpdater; } catch (e) { autoUpdater = null; }

let win = null;
let tray = null;
let timersRunning = true;
let normalBounds = null;
let quitting = false;
let balloonShown = false;
let wasHidden = false;      // 提醒前主窗口是否藏在托盘里
let startHidden = false;    // 开机自启动拉起时不弹主界面，只留托盘

/* ------------------------------------------------ 屏幕缩放（DPI）适配状态
   k = 当前窗口所在显示器的缩放 ÷ 启动时基准屏的缩放。
   窗口逻辑尺寸一律按 DESIGN(物理) ÷ k 计算，页面内容再乘 k，
   于是界面在屏幕上的物理大小恒定 —— 换分辨率/换缩放都不变。
   基准屏在 app ready 时记录一次，之后不再变（用户的「标准大小」由此固定）。 */
let basePixelRatio = 1;
let curPixelRatio = 1;
let forceDpiPending = false;    // 已发现换屏、等页面那边也反应过来再补一次同步

/* --------------------------------------------------------------- 调试开关
   node_modules\electron\dist\electron.exe . --diag=150 --diag-shot=C:\tmp\x.png
   只为在没有第二块屏的机器上模拟「换到一块 150% 缩放的屏」：
   把计算用的像素比强行当成 150%，跑完存一张截图并退出。
   正常启动（不带参数）这段完全生效不了，一个分支都不会进。
   --diag-avail=WxH 可再模拟那块屏的可用区大小（DIP）。 */
const DIAG = (function () {
  const hit = process.argv.filter(function (a) { return a.indexOf('--diag') === 0; });
  if (!hit.length) return null;
  const out = { ratio: 0, shot: '', win: '', avail: null, wait: 0 };
  hit.forEach(function (a) {
    let m = /^--diag=([\d.]+)$/.exec(a);
    /* 允许两种写法：--diag=150（百分比）和 --diag=1.5（比例） */
    if (m) { const v = parseFloat(m[1]); out.ratio = v > 5 ? v / 100 : v; }
    m = /^--diag-shot=(.+)$/.exec(a);
    if (m) out.shot = m[1];
    m = /^--diag-win=(\d+)x(\d+)$/.exec(a);
    if (m) out.win = { w: parseInt(m[1], 10), h: parseInt(m[2], 10) };
    /* 假装窗口所在那块屏的可用区是这么大（DIP），原点仍用真实屏 */
    m = /^--diag-avail=(\d+)x(\d+)$/.exec(a);
    if (m) out.avail = { w: parseInt(m[1], 10), h: parseInt(m[2], 10) };
    /* --diag-pet：自检时顺手打开桌面宠物，验证它和主界面能同时存在 */
    if (a === '--diag-pet') out.pet = true;
    /* --diag-bubble：点宠物看气泡，验证「今日待办」那一块（有/没有两种） */
    if (a === '--diag-bubble') out.bubble = true;
    /* --diag-arxiv：科研动态端到端自检（真抓一次 arXiv + 界面 + 可点气泡） */
    if (a === '--diag-arxiv') out.arxiv = true;
    /* --diag-arxiv-hold：自检时把程序留着不退出（配合外面用真鼠标点气泡） */
    if (a === '--diag-arxiv-hold') { out.arxiv = true; out.arxivHold = true; }
    /* --diag-petskin=<id>：自检时指定桌面宠物用哪个形象（用来肉眼确认某个皮肤画得对不对） */
    m = /^--diag-petskin=(.+)$/.exec(a);
    if (m) out.petskin = m[1];
    /* --diag-tab=home|todo|settings：自检时切到指定页再截图 */
    m = /^--diag-tab=(home|todo|diary|arxiv|settings)$/.exec(a);
    if (m) out.tab = m[1];
    /* --diag-wait=<ms>：截图前多等一会儿，用来测异步的东西
       （比如启动 8 秒后才会跑的「自动检查更新」） */
    m = /^--diag-wait=(\d+)$/.exec(a);
    if (m) out.wait = parseInt(m[1], 10);
    /* --diag-moyu：自检时连着摸鱼两次，验证「藏 → 恢复」这条链路 */
    if (a === '--diag-moyu') out.moyu = true;
    /* --diag-note：往「软件更新」卡里塞一段长更新说明，验证它能内部滚动、
       不会把下面的「一键摸鱼」顶下去 */
    if (a === '--diag-note') out.note = true;
    /* --diag-update：跑完整更新流程（检查 → 下载 → 等结果），端到端验证用 */
    if (a === '--diag-update') out.update = true;
    /* --diag-eyecare：开→重应用→关，验证色温真的改了、且原始备份不会被覆盖 */
    if (a === '--diag-eyecare') out.eyecare = true;
    /* --diag-tap：打开连击摸鱼 → 注入 3 下 Ctrl → 看是不是真的摸鱼了 → 再关掉 */
    if (a === '--diag-tap') out.tap = true;
    /* --diag-fit：反复改窗口尺寸，验证缩放比只跟当前尺寸有关、不会随历史漂移
       （「拖动窗口后设置页卡片不断缩小」那个 bug） */
    if (a === '--diag-fit') out.fit = true;
    /* --diag-autolaunch：把开机自启的各种调用方式和注册表实况都打出来 */
    if (a === '--diag-autolaunch') out.autolaunch = true;
    /* --diag-eyequit：开护眼 → 正常退出（app.quit）→ 外面看色温有没有还原 */
    if (a === '--diag-eyequit') out.eyequit = true;
    /* --diag-eyequit-keep：同上，但把「退出时还原」关掉 —— 验证退出后【保持】暖色 */
    if (a === '--diag-eyequit-keep') { out.eyequit = true; out.eyeKeep = true; }
    /* --diag-petclamp：把宠物拖到右下极限，验证它能贴到工作区边缘 */
    if (a === '--diag-petclamp') out.petclamp = true;
    /* --diag-cal：桌面日历端到端自检（造一批三档优先级的待办 → 开日历 →
       查网格/颜色/切月/当天清单 → 再用主界面真实弹窗存一条，验证 prio 落盘） */
    if (a === '--diag-cal') out.cal = true;
    /* --diag-music：提醒音乐（音频元素 + 能不能播 + 默认勾选） */
    if (a === '--diag-music') out.music = true;
    /* --diag-alert：弹窗冲突自检（多条待办同时到点 → 合并弹一条 → 逐条看/全部完成） */
    if (a === '--diag-alert') out.alert = true;
    /* --diag-calzoom：桌面日历「放大缩小」+「固定」自检 */
    if (a === '--diag-calzoom') out.calzoom = true;
    /* --diag-diary：日记页端到端自检（写今天 / 点旧日记改 / 删除 / 导出） */
    if (a === '--diag-diary') out.diary = true;
    /* --diag-skins：用户皮肤目录 / 说明文档 / 「被安装程序清掉后能不能自愈」 */
    if (a === '--diag-skins') out.skins = true;
    /* --diag-repeat：重复待办端到端自检（走真实弹窗 + 真实勾完成），
       重点验「每月 31 号碰上 2 月怎么办」这类边界 */
    if (a === '--diag-repeat') out.repeat = true;
    /* --diag-calstart：模拟「上次勾了桌面日历，这次开机」——
       日历不许压在主界面上（用户报过：一开机日历盖住界面、点不动） */
    if (a === '--diag-calstart') out.calstart = true;
    /* --diag-park：把主界面推到屏幕外面，验证「能推出去、但一定留一条边能抓回来」，
       再验证从托盘那条路（showWindow）能把它拉回屏内 */
    if (a === '--diag-park') out.park = true;
    /* --diag-calshadow：把日历窗摆在屏幕正中并停住，好让外面用 GDI 截屏
       看清「窗口四周那圈直角阴影」到底是什么（只排查用，不做判断） */
    if (a === '--diag-calshadow') out.calshadow = true;
  });
  return out;
})();

/* 自检要能在这台机器上跑起来：别的 Electron 进程（比如 DSH 自己）已经拿到了
   单实例锁，正常启动会被立刻劝退。所以自检用一个独立的 userData 目录，
   单实例锁是按 userData 分的，互不影响。 */
if (DIAG) {
  try {
    app.setPath('userData', path.join(app.getPath('temp'), 'kunkun-diag-' + process.pid));
  } catch (e) { /* 设不上就照普通流程走 */ }
}

/* 「当前这台显示器」的像素比：自检时用模拟值，正常运行就是真实值 */
function effScale(d) {
  if (DIAG && DIAG.ratio > 0) return DIAG.ratio;
  return (d && d.scaleFactor) || 1;
}

/* 自检探针：Windows 上 Electron 的 console.log 有时不进管道的 stdout，
   所以关键节点同时写文件。正常启动（不带 --diag）一概不写。
   ⚠️ 打包后 __dirname 在 app.asar 里，写不进去 —— 依次退回「exe 同级目录」
   和 userData，保证打包版也能留下自检日志。 */
let diagDiarySeeded = false;      // 日记自检：种完「以前的日记」要重载一次页面，用它挡住重复种
let diagAlertStage = 0;           // 弹窗自检：要重载两次数据，用它记住「重载后从哪继续」
let diagMusicStage = 0;           // 提醒音乐自检：换成自定义音乐/坏路径/还原各要重载一次
let diagBubbleStage = 0;          // 气泡自检：种待办 → 重载 → 看气泡里有没有今日待办
/* 自检产物的落脚点：和 diagLog 一样，打包后 __dirname 在 app.asar 里写不进去，
   依次退回「exe 同级目录」和 userData，保证打包版的自检也能把文件落下来。 */
function diagFilePath(name) {
  const cands = [path.join(__dirname, '.diag', name)];
  try { cands.push(path.join(path.dirname(app.getPath('exe')), name)); } catch (e) { }
  try { cands.push(path.join(app.getPath('userData'), name)); } catch (e) { }
  for (let i = 0; i < cands.length; i++) {
    try {
      fs.mkdirSync(path.dirname(cands[i]), { recursive: true });
      fs.appendFileSync(cands[i], '');          // 试写一下确认可写（不会清空已有内容）
      return cands[i];
    } catch (e) { /* 换下一个 */ }
  }
  return cands[0];
}

function diagLog(tag, obj) {  if (!DIAG) return;
  const line = new Date().toISOString() + ' [' + tag + '] ' + JSON.stringify(obj || {}) + '\n';
  const cands = [path.join(__dirname, '.diag', 'trace.log')];
  try { cands.push(path.join(path.dirname(app.getPath('exe')), 'trace.log')); } catch (e) { }
  try { cands.push(path.join(app.getPath('userData'), 'trace.log')); } catch (e) { }
  for (let i = 0; i < cands.length; i++) {
    try { fs.appendFileSync(cands[i], line); return; } catch (e) { /* 换下一个 */ }
  }
}

function sameScale(a, b) { return Math.abs((Number(a) || 0) - (Number(b) || 0)) < 0.001; }
function uiK() { return UI.computeUiScale(curPixelRatio, basePixelRatio); }

/* 真实像素比因子：按显示器的真实 scaleFactor 算，不吃 --diag 覆盖。
   宠物窗和气泡窗是「按物理尺寸摆放的独立小窗」，它们的窗口尺寸必须由真实像素比定；
   自检把 k 模拟成别的值时，这两扇窗不该跟着变（页面里的 fit 也用真实值算）。 */
function realUiK(disp) { return UI.computeUiScale((disp && disp.scaleFactor) || 1, basePixelRatio); }

function displayOf(x, y) {
  try {
    const d = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) });
    return DIAG && DIAG.avail ? fakeDisplay(d) : d;
  } catch (e) { return screen.getPrimaryDisplay(); }
}

/* 自检专用：把真实显示器包一层，只把可用区尺寸换成模拟值（原点沿用真实屏） */
function fakeDisplay(d) {
  try {
    const wa = d.workArea;
    return {
      id: d.id,
      scaleFactor: d.scaleFactor,
      bounds: d.bounds,
      workArea: {
        x: wa.x, y: wa.y,
        width: Math.min(DIAG.avail.w, wa.width),
        height: Math.min(DIAG.avail.h, wa.height)
      }
    };
  } catch (e) { return d; }
}
function workAreaOf(x, y) { return displayOf(x, y).workArea; }

/* 调试自检：读页面的真实几何并换算成「出屏物理尺寸」，可选存一张 PNG */
async function runDiagnose() {
  const info = await win.webContents.executeJavaScript(`(function(){
    const app = document.getElementById('app');
    const r = app.getBoundingClientRect();
    const tb = document.getElementById('titlebar');
    const cs = tb ? getComputedStyle(tb) : null;
    const st = document.getElementById('stage');
    const probe = document.createElement('span');
    probe.textContent = 'Hg测';
    probe.style.cssText = 'position:absolute;font-size:14px;visibility:hidden';
    document.body.appendChild(probe);
    const textH = probe.getBoundingClientRect().height;
    probe.remove();
    return {
      k: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 0,
      dpr: window.devicePixelRatio,
      innerW: window.innerWidth, innerH: window.innerHeight,
      availW: Math.max(1, window.innerWidth),
      tbH: tb ? tb.offsetHeight : 0,
      availH: Math.max(1, window.innerHeight - (tb && cs && cs.display !== 'none' ? tb.offsetHeight : 0)),
      appLayoutW: app.offsetWidth, appLayoutH: app.offsetHeight,
      appW: r.width, appH: r.height, transform: app.style.transform,
      tbShown: cs ? cs.display : 'none',
      stageW: st ? st.offsetWidth : 0,
      stageH: st ? st.offsetHeight : 0,
      fontPx: textH,
      /* 真实的「内容物理尺寸」：内容块自身 CSS 尺寸 × 本屏像素比。
         注意不能用 window.innerWidth —— 那是视口宽（窗口逻辑宽 × 像素比），
         再乘像素比会多乘一趟，早期自检就被这个假数据误导过。 */
      contentPhysical: (function () {
        const s = parseFloat((/scale\(([\d.]+)\)/.exec(app.style.transform) || [])[1]) || 1;
        return Math.round(app.offsetWidth * s * window.devicePixelRatio) + 'x' +
          Math.round(app.offsetHeight * s * window.devicePixelRatio);
      })()
    };
  })()`, true);

  const out = {
    diagRatio: DIAG && DIAG.ratio ? DIAG.ratio : null,
    k: info.k, dpr: info.dpr,
    windowDip: info.innerW + 'x' + info.innerH,
    avail: info.availW + 'x' + info.availH,
    appLayout: info.appLayoutW + 'x' + info.appLayoutH,
    /** 核心指标：内容块的出屏物理尺寸。各缩放档下必须一致。 */
    contentPhysical: info.contentPhysical,
    transform: info.transform,
    fontPhysical: +(info.fontPx * info.dpr).toFixed(2),
    titlebar: info.tbShown + '@' + info.tbH,
    stagePhysical: Math.round(info.stageW * info.dpr) + 'x' + Math.round(info.stageH * info.dpr)
  };
  if (DIAG && DIAG.shot) {
    try {
      const img = await win.capturePage();
      fs.writeFileSync(DIAG.shot, img.toPNG());
      out.shot = DIAG.shot;
    } catch (e) { out.shotError = String(e && e.message || e); }
  }
  /* 用「真实鼠标点击 + 真实按键」测输入：JS 强制 focus() 会掩盖点击聚焦的故障 */
  /* 追加到汇总文件，方便一次跑多档缩放后直接对比 */
  try {
    fs.appendFileSync(path.join(__dirname, '.diag', 'summary.jsonl'),
      JSON.stringify(out) + '\n');
  } catch (e) { /* 忽略 */ }
  return out;
}

/* 把 (x,y) 处的显示器信息发给页面：它拿 k 去算内容缩放 */
function sendDpiInfo() {
  if (!win || win.isDestroyed()) return;
  const k = uiK();
  const b = win.getBounds();
  const d = displayOf(b.x + Math.max(1, b.width) / 2, b.y + 8);
  const rk = realUiK(d);
  send('display-info', {
    pixelRatio: curPixelRatio,
    realPixelRatio: (d && d.scaleFactor) || 1,
    basePixelRatio: basePixelRatio,
    scale: k,
    realScale: rk,
    petW: Math.round(UI.DESIGN.petW / rk),
    petH: Math.round(UI.DESIGN.petH / rk)
  });
}

/* 窗口在哪块屏上、尺寸该是多少 —— 换屏和缩放变化都走这里 */
function applyDisplay(force) {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const d = displayOf(b.x + Math.max(1, b.width) / 2, b.y + 8);
  const px = effScale(d);
  const changed = !sameScale(px, curPixelRatio);

  if (!force && !changed) { sendDpiInfo(); return; }

  curPixelRatio = px;

  /* 跨屏 / 改系统缩放时【不】再自己按 k 重算窗口尺寸了。
     窗口就是固定的 1180×849 逻辑像素，系统按每块屏的缩放去渲染即可 ——
     看起来一样大（见 ui-scale.js 里那段长注释）。
     以前这里会 rescaleBox 再 setBounds，正好踩在 Electron 在 Windows 上的回归上
     （electron#51679：无边框可调整大小的窗口，可视窗口比 getBounds() 向外多一圈、
     而且这圈随 DPI 变化），跨屏时会把窗口算得溢出工作区 ——
     表现就是「拖到另一块屏后界面变成全屏、边缘抓不住、拖不动也缩放不了」。
     现在只在窗口真的跑到工作区外面时才把它拉回来，正常跨屏交给系统。 */
  const wa = d.workArea;
  const inset = Math.round(10 * ((d && d.scaleFactor) || 1));
  const maxW = Math.max(1, wa.width - inset);
  const maxH = Math.max(1, wa.height - inset);
  const wantW = Math.min(b.width, maxW);
  const wantH = Math.min(b.height, maxH);
  const wantX = Math.min(Math.max(b.x, wa.x), wa.x + Math.max(0, wa.width - wantW) - inset);
  const wantY = Math.min(Math.max(b.y, wa.y), wa.y + Math.max(0, wa.height - wantH) - inset);
  if (wantW !== b.width || wantH !== b.height || wantX !== b.x || wantY !== b.y) {
    win.setBounds({ x: wantX, y: wantY, width: wantW, height: wantH });
  }

  if (!normalBounds) normalBounds = win.getBounds();
  /* 桌面宠物/桌面日历都是独立窗口，跟着各自所在的那块屏重新适配 */
  applyPetDisplay();
  applyCalDisplay();
  sendDpiInfo();
}

/* 显示器插拔 / 缩放比例改变（拔掉副屏、在系统设置里改缩放） */
function bindDisplayEvents() {
  try {
    screen.on('display-metrics-changed', function (e, d) {
      /* 改分辨率 / 缩放会让驱动把伽马表复位，护眼模式要重新设一遍 */
      eyeCareReapply(1200);
      if (!win || win.isDestroyed()) return;
      const b = win.getBounds();
      const cur = displayOf(b.x + Math.max(1, b.width) / 2, b.y + 8);
      if (d && cur && d.id !== cur.id) return;     // 别的屏变了，与本窗口无关
      setTimeout(function () { applyDisplay(true); }, 250);
    });
    screen.on('display-removed', function () {
      eyeCareReapply(1400);
      setTimeout(function () { applyDisplay(true); }, 300);
    });
    screen.on('display-added', function () {
      /* 新插上的屏也得调暖，不然两块屏色温不一致很难看 */
      eyeCareReapply(1400);
    });
  } catch (e) { /* 个别平台没有这些事件 */ }
}

/* 主界面默认尺寸 = 设计尺寸 1180×849（逻辑像素/DIP）。
   窗口在每块屏上都是这个 DIP 尺寸 —— 跟随系统缩放，看起来一样大。
   （以前这里按 k 换算成「物理尺寸恒定」，实测在 4K 高缩放屏上界面会明显变小，
   详见 ui-scale.js 里那段说明。） */
const NORMAL = { width: UI.DESIGN.winW, height: UI.DESIGN.winH };

/* 桌面宠物：一个「独立的透明小窗」，和主界面同时存在（这是本次的核心改动 ——
   以前宠物模式是把主窗口自己缩小变形，所以两者天生无法共存）。
   窗口物理尺寸按档位固定，逻辑尺寸 = 物理 ÷ 真实像素比（与页面里的 fit 配套）。 */
const PET_SIZES = {
  max: { label: '迷你（150 × 170）', w: 150, h: 170 },
  mid: { label: '小小（118 × 134）', w: 118, h: 134 },
  min: { label: '超小（92 × 104）', w: 92, h: 104 }
};
let petSize = 'max';
let petOn = false;          // 用户是否勾选了「桌面宠物」
let petBooted = false;      // 宠物窗页面是否已经画好（画好之前不显示，避免闪一下）
let petSkin = '__default';  // 当前形象，宠物窗与主界面共用
let currentSkin = '__default';   // 同上（菜单打勾用这个名字，保留两个别名更直观）
let petSoundOn = true;
let petDragState = null;    // 宠物窗拖动基准

/* 宠物窗位置持久化：拖到哪儿，下次启动还在哪儿（借鉴 Blinky / whale-pet 的
   「drag & remember position」）。存在 userData/pet-position.json，位置存 DIP。 */
function petPosFile() {
  try { return path.join(app.getPath('userData'), 'pet-position.json'); }
  catch (e) { return null; }
}

function loadPetPos() {
  const f = petPosFile();
  if (!f) return null;
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (j && typeof j.x === 'number' && typeof j.y === 'number') return { x: j.x, y: j.y };
  } catch (e) { /* 第一次没有/文件坏了，就当没存过 */ }
  return null;
}

function savePetPos(x, y) {
  const f = petPosFile();
  if (!f) return;
  try {
    fs.writeFileSync(f, JSON.stringify({ x: Math.round(x), y: Math.round(y) }), 'utf8');
  } catch (e) { /* 存不上不致命 */ }
}

/* 保存的位置还在不在「某块屏的可用区」里：拔掉显示器 / 改分辨率后，旧坐标可能
   跑到屏幕外，这种情况就回退到默认右下角，别让宠物跑到看不见的地方。 */
function petPosStillOnScreen(p) {
  if (!p) return false;
  const disp = displayOf(p.x, p.y);
  const wa = disp.workArea;
  return p.x >= wa.x && p.y >= wa.y &&
    p.x <= wa.x + wa.width - 40 && p.y <= wa.y + wa.height - 40;
}

/* ---------------------------------------------------- 主窗口状态持久化
   借鉴 electron-window-state（Stretchly / Super Productivity 同款思路）：
   记住用户调整过的窗口大小与位置，下次启动恢复。尺寸存 DIP。
   位置若因拔屏/改分辨率跑到屏幕外，则回退默认尺寸并交给系统居中。 */
function winStateFile() {
  try { return path.join(app.getPath('userData'), 'window-state.json'); }
  catch (e) { return null; }
}

function loadWinState() {
  const f = winStateFile();
  if (!f) return null;
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (j && j.width > 0 && j.height > 0) return j;
  } catch (e) { /* 第一次没有/文件坏了 */ }
  return null;
}

function saveWinState(b) {
  const f = winStateFile();
  if (!f) return;
  try {
    fs.writeFileSync(f, JSON.stringify({
      x: Math.round(b.x), y: Math.round(b.y),
      width: Math.round(b.width), height: Math.round(b.height)
    }), 'utf8');
  } catch (e) { /* 存不上不致命 */ }
}

/* 保存的窗口位置是否还落在某块屏的可用区内（含标题栏能露出来可拖） */
function winStateStillUsable(st) {
  if (!st) return false;
  try {
    const disp = displayOf(st.x + st.width / 2, st.y + 20);
    const wa = disp.workArea;
    return st.x + st.width > wa.x + 60 && st.y > wa.y - 10 && st.y < wa.y + wa.height - 30;
  } catch (e) { return false; }
}

/* resize / move 结束后把窗口状态写盘（节流，避免拖动时疯狂写盘） */
let winStateSaveTimer = null;
function scheduleWinStateSave() {
  if (winStateSaveTimer) clearTimeout(winStateSaveTimer);
  winStateSaveTimer = setTimeout(function () {
    winStateSaveTimer = null;
    if (win && !win.isDestroyed() && !win.isMinimized()) {
      saveWinState(win.getBounds());
    }
  }, 600);
}

/* 提醒事项列表由渲染进程同步过来，菜单按它动态生成 */
let menuItems = [
  { id: 'water', name: '喝水', emoji: '💧', minutes: 45 },
  { id: 'rest', name: '休息', emoji: '🛋️', minutes: 60 }
];

/* 「调整倒计时」里给的快捷档位 */
const QUICK_MINUTES = [15, 30, 45, 60, 90, 120];

/* 图标统一取 resources\icon.ico（多尺寸 ICO）。
   Windows 的任务栏/窗口图标用 ICO 才清晰，PNG 在部分场景会退回默认图标。 */
function iconPath() {
  const packed = path.join(process.resourcesPath || '', 'icon.ico');
  if (app.isPackaged && fs.existsSync(packed)) return packed;
  const dev = path.join(__dirname, 'build', 'icon.ico');
  return fs.existsSync(dev) ? dev : path.join(__dirname, 'icon.png');
}

/* Windows 靠 AppUserModelID 把窗口和快捷方式认成同一个程序；
   不设的话任务栏有时会显示成 Electron 默认图标、也不会正确合并。
   ⚠️ 这个 ID 同时就是「开机自启」在 HKCU\Run 里的值名（Electron 内部用它），
   所以自检要动注册表时得知道它。 */
const APP_AUMID = 'com.kunkun.reminder';
if (process.platform === 'win32') {
  try { app.setAppUserModelId(APP_AUMID); } catch (e) { }
}

/* ------------------------------------------------------------ 创建窗口 */
/* 初始尺寸 = 物理设计尺寸 ÷ 当前屏的 k。这样 4K@200% 下开出来的窗口
   在屏幕上和 2K@100% 一样大，而不是个 590 DIP 的迷你窗口。
   如果用户上次手动调整过大小/位置，恢复那份（屏幕内才用）。 */
function createWindow() {
  const d = screen.getPrimaryDisplay();
  curPixelRatio = effScale(d);
  const box = UI.windowBox(uiK()).main;
  const saved = winStateStillUsable(loadWinState()) ? loadWinState() : null;

  /* 恢复上次的尺寸：原样恢复，不再按设计宽高比纠正 ——
     窗口形状现在是自由的（宽高比不再锁死），用户拉成什么样就记住什么样。 */
  const savedBox = saved
    ? {
      x: saved.x, y: saved.y,
      width: Math.max(saved.width, box.minWidth),
      height: Math.max(saved.height, box.minHeight)
    }
    : null;

  win = new BrowserWindow({
    x: savedBox ? savedBox.x : undefined,
    y: savedBox ? savedBox.y : undefined,
    width: savedBox ? savedBox.width : box.width,
    height: savedBox ? savedBox.height : box.height,
    minWidth: box.minWidth,
    minHeight: box.minHeight,
    frame: false,
    /* 主窗口不再需要透明（那是旧「宠物模式把主窗口变形成宠物」的遗留，
       桌面宠物早就独立成窗了）。透明窗口在部分机器上会导致中文输入法(IME)
       候选框不显示、输入框点不进去等兼容问题，改成不透明即可根除。 */
    transparent: false,
    backgroundColor: '#E9F4FA',
    title: '别感冒提醒器',
    icon: iconPath(),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false
    }
  });

  Menu.setApplicationMenu(null);

  /* 这里以前调了 win.setAspectRatio() 想锁死窗口宽高比，现在撤掉了：
     1) 它在 Windows 上是否生效、以及会不会影响 setBounds（我们拖窗口靠 setBounds），
        无法自动化验证 —— 而「窗口拖不动也缩放不了」正是要修的严重问题之一，
        不能把嫌疑留在里面；
     2) 用户要的「比例固定」其实是「界面整体等比缩放、不变形」，那个由页面里的
        统一 transform scale 保证（缩放比只由窗口尺寸算出来），跟窗口本身的形状无关；
     3) 窗口形状自由之后，用户拖成什么比例，界面都是等比缩放 + 居中，
        依然是「一张图整体缩放」的观感。
     所以这里什么都不用设。 */
  win.loadFile(path.join(__dirname, 'index.html'));
  /* 开机自启动进来时不弹窗，只留托盘（页面照常在后台跑计时与待办调度） */
  win.once('ready-to-show', () => {
    if (startHidden) { win.hide(); return; }
    win.show();
  });

  /* 页面加载好之后把本屏的缩放同步给它（它按这个算内容缩放） */
  win.webContents.on('did-finish-load', () => { sendDpiInfo(); });

  /* 自检：把渲染进程的报错也落进 trace，否则页面里悄悄抛的异常完全看不见 */
  if (DIAG) {
    win.webContents.on('console-message', function (e, level, message, line, source) {
      if (level >= 2) diagLog('renderer-console', { level: level, message: String(message).slice(0, 400), line: line, source: String(source).slice(-60) });
    });
  }

  /* ------------------------------------------------------------- 只跑一次的调试自检
     带 --diag 启动时：等界面画好，读一遍真实几何 + 存一张截图 + 打印出屏物理尺寸，然后退出。
     判据是「出屏物理尺寸」不随模拟的屏幕缩放改变 —— 这正是这次修复要保证的性质。 */
  if (DIAG) {
    win.webContents.on('did-finish-load', function () {
      diagLog('did-finish-load', {});
      setTimeout(async function () {
        try {
          if (DIAG.pet) {
            setPetOn(true);
            await new Promise(function (r) { setTimeout(r, 400); });
            /* 换形象要等宠物窗建好之后再发，否则那条消息没人收 */
            if (DIAG.petskin) setPetSkin(DIAG.petskin);
            await new Promise(function (r) { setTimeout(r, 1400); });
            /* 护眼模式还没开的时候，宠物右键菜单里那一项应该是没勾的 */
            diagLog('pet-menu', { 菜单: petMenuSummary(), 用的形象: currentSkin });
          }
          if (DIAG.tab) {
            await win.webContents.executeJavaScript(
              'document.getElementById("tab' + DIAG.tab.charAt(0).toUpperCase() + DIAG.tab.slice(1) +
              '").click(); true;', true);
            await new Promise(function (r) { setTimeout(r, 500); });
          }
          if (DIAG.win) {
            const cur = win.getBounds();
            win.setBounds({
              x: cur.x, y: cur.y,
              width: Math.max(60, Math.round(DIAG.win.w)),
              height: Math.max(60, Math.round(DIAG.win.h))
            });
            await new Promise(function (r) { setTimeout(r, 700); });
          }
          /* 一键摸鱼：连着切两次，看窗口是不是「藏 → 恢复」 */
          /* 往「软件更新」卡里塞一段长说明，验证它能内部滚动、
             不会把下面的「一键摸鱼」顶下去 */
          if (DIAG.note) {
            await win.webContents.executeJavaScript(
              '(function(){var r=document.getElementById("updNoteRow"),e=document.getElementById("updNote");' +
              'if(!r||!e)return false;var o=[];' +
              'for(var i=1;i<=28;i++){o.push(i+". 这是一行用来测试滚动条的更新说明，故意写长一点，好看出排版和高度对不对。");}' +
              'e.textContent=o.join("\\n");r.hidden=false;return true;})()', true);
            await new Promise(function (r) { setTimeout(r, 400); });
            /* 量一下合并后的设置卡：内容高 > 可视高 才算真的能滚 */
            diagLog('set-card', await win.webContents.executeJavaScript(
              '(function(){var c=document.getElementById("setCard");if(!c)return null;' +
              'return {scrollH:c.scrollHeight, clientH:c.clientHeight, 可滚动:c.scrollHeight>c.clientHeight+4,' +
              'overflowY:getComputedStyle(c).overflowY, pageViewH:getComputedStyle(document.documentElement).getPropertyValue("--page-view-h")};})()',
              true));
            /* 逐个点三个导航项，验证「滚动定位 + 点哪亮哪」。
               顺带在页面里挂一个 40ms 的采样器，把点击后 1.5 秒内高亮项的
               变化序列记下来 —— 高亮闪烁是瞬时的，只看最终状态测不出来，
               序列长度 > 1 就说明中途闪到过别的项。 */
            const navBefore = await win.webContents.executeJavaScript(
              '(function(){var c=document.getElementById("setCard");return c?c.scrollTop:-1;})()', true);
            /* 导航项个数从 DOM 里数，别写死 —— 以后再加分节这里自动跟上 */
            const navCount = await win.webContents.executeJavaScript(
              'document.querySelectorAll("#setNav [data-target]").length', true);
            const secIds = await win.webContents.executeJavaScript(
              '(function(){var a=[];document.querySelectorAll("#setNav [data-target]").forEach(' +
              'function(b){a.push(b.dataset.target);});return a;})()', true);
            const navRuns = [];
            for (let ni = 0; ni < navCount; ni++) {
              await win.webContents.executeJavaScript(
                '(function(){window.__navSeq=[];var t0=Date.now();' +
                'window.__navTimer=setInterval(function(){' +
                'var on=document.querySelector("#setNav .on");' +
                'var v=on?on.textContent.trim():"";var s=window.__navSeq;' +
                'if(s.length===0||s[s.length-1].v!==v)s.push({t:Date.now()-t0,v:v});' +
                'if(Date.now()-t0>1500)clearInterval(window.__navTimer);},40);' +
                'document.querySelectorAll("#setNav [data-target]")[' + ni + '].click();return true;})()', true);
              await new Promise(function (r) { setTimeout(r, 1800); });
              const sampled = await win.webContents.executeJavaScript('window.__navSeq', true);
              const settled = await win.webContents.executeJavaScript(
                '(function(){var c=document.getElementById("setCard");if(!c)return null;' +
                'var cr=c.getBoundingClientRect();var rel={};' +
                JSON.stringify(secIds) + '.forEach(function(id){' +
                'var e=document.getElementById(id);' +
                'rel[id]=e?Math.round((e.getBoundingClientRect().top-cr.top)*10)/10:"NULL";});' +
                'var on=document.querySelector("#setNav .on");' +
                'return {scrollTop:Math.round(c.scrollTop), 最大可滚:c.scrollHeight-c.clientHeight,' +
                'rel:rel, 高亮:on?on.textContent.trim():""};})()', true);
              navRuns.push({
                第几次: ni + 1,
                点的: await win.webContents.executeJavaScript(
                  'document.querySelectorAll("#setNav [data-target]")[' + ni + '].textContent.trim()', true),
                高亮变化序列: sampled,
                变化次数: (sampled || []).length,
                最终: settled
              });
            }
            diagLog('set-nav', { 点击前scrollTop: navBefore, 分节数: navCount, 三次点击: navRuns });
          }
          if (DIAG.moyu) {
            diagLog('moyu-step1-before', { visible: win.isVisible() });
            moyuToggle();
            await new Promise(function (r) { setTimeout(r, 700); });
            diagLog('moyu-step2-hidden', { visible: win.isVisible() });
            moyuToggle();
            await new Promise(function (r) { setTimeout(r, 700); });
            diagLog('moyu-step3-shown', { visible: win.isVisible() });
          }
          /* 宠物贴边自检：把「宠物拖动」那几个真实 IPC 处理函数直接触发一遍，
             往右下拖到极限，看窗口能不能贴到工作区边缘。
             （之前给 clampToWorkArea 加了只有主窗口才需要的「Electron 那圈余量」，
              宠物窗 resizable:false 本身没有那圈，结果被凭空留了条缝、贴不到边。） */
          if (DIAG.petclamp) {
            const wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
            /* 用「抓点 → 目标点」的真实拖法：处理函数算的是 b.x + (pt.x - start.x)，
               抓点取宠物中心，目标点取该屏工作区角内 1dip 处，两个方向都必然撞到限位。 */
            const dragTo = async function (pt) {
              const b0 = petWin.getBounds();
              ipcMain.emit('pet-win-drag-start', {},
                { x: b0.x + Math.floor(b0.width / 2), y: b0.y + Math.floor(b0.height / 2) });
              ipcMain.emit('pet-win-drag-move', {}, pt);
              ipcMain.emit('pet-win-drag-end', {}, {});
              await wait(500);   /* 500 > 跨屏重排的 180ms，等的就是「排完之后」的最终位置 */
              return petWin.getBounds();
            };
            /* DIP 直接换物理，别靠 round 猜：贴没贴边以物理像素为准 */
            const phys = function (r) { return screen.dipToScreenRect(null, r); };
            const edge = function (dipRect, waDip) {
              const p = phys(dipRect), w = phys(waDip);
              return {
                right: (w.x + w.width) - (p.x + p.width),
                bottom: (w.y + w.height) - (p.y + p.height),
                left: p.x - w.x,
                top: p.y - w.y
              };
            };
            setPetOn(true);
            await wait(1400);
            if (!petWin || petWin.isDestroyed()) {
              diagLog('petclamp', { error: 'pet window not created' });
            } else {
              const rows = [];
              const list = screen.getAllDisplays();
              for (let i = 0; i < list.length; i++) {
                const wa = list[i].workArea;
                const tl = await dragTo({ x: wa.x + 1, y: wa.y + 1 });
                const br = await dragTo({ x: wa.x + wa.width - 1, y: wa.y + wa.height - 1 });
                rows.push({
                  disp: list[i].id + '@' + list[i].scaleFactor,
                  work: wa.x + ',' + wa.y + ' ' + wa.width + 'x' + wa.height,
                  petDip: br.width + 'x' + br.height,
                  tl: tl.x + ',' + tl.y,
                  /* 距离工作区四边还有多少物理像素：0=贴齐，正数=留缝，负数=压出去了 */
                  tlEdge: edge(tl, wa),
                  br: br.x + ',' + br.y,
                  brEdge: edge(br, wa),
                  petPhys: JSON.stringify(phys(br))
                });
              }
              /* 直接 setBounds 到左上角，分清「限位算错」还是「系统又挪了」 */
              const pb = petWin.getBounds();
              const wa0 = screen.getDisplayNearestPoint({ x: pb.x, y: pb.y }).workArea;
              petWin.setBounds({ x: wa0.x, y: wa0.y, width: pb.width, height: pb.height });
              await wait(500);
              const direct = petWin.getBounds();
              /* 眼见为实：把宠物停回主屏工作区右下角，截一张右下角实图（物理像素裁剪），
                 人眼确认宠物的脚/手是不是真的顶到桌面边缘了。 */
              const wa1 = list[0].workArea;
              const park = await dragTo({ x: wa1.x + wa1.width - 1, y: wa1.y + wa1.height - 1 });
              try {
                const pr = screen.dipToScreenRect(null, list[0].bounds);
                const srcs = await desktopCapturer.getSources({
                  types: ['screen'],
                  thumbnailSize: { width: pr.width, height: pr.height }
                });
                /* ⚠️ sources 的顺序不是「主屏优先」，必须按 display_id 挑，否则截到别块屏 */
                const src = srcs.find(function (s) {
                  return String(s.display_id) === String(list[0].id);
                }) || srcs[0];
                if (src && src.thumbnail && !src.thumbnail.isEmpty()) {
                  const sz2 = src.thumbnail.getSize();
                  const cw = Math.min(640, sz2.width), ch = Math.min(460, sz2.height);
                  const shot = src.thumbnail.crop({
                    x: Math.max(0, sz2.width - cw), y: Math.max(0, sz2.height - ch),
                    width: cw, height: ch
                  });
                  fs.writeFileSync(path.join(__dirname, '.diag', 'pet-edge.png'), shot.toPNG());
                }
              } catch (e2) { diagLog('petclamp-shot-error', String(e2 && e2.message || e2)); }
              /* 顺带确认主窗口那边没被改坏：它自己是【无边框+可调整大小】，
                 必须继续留着那圈余量（贴到底会被系统那圈顶出工作区）。
                 期望：右下 edge 为正数，约等于 winInsetDip()×本屏缩放。 */
              let mainEdgeNow = null;
              try {
                const mw = win.getBounds();
                const mwa = screen.getDisplayNearestPoint({
                  x: mw.x + mw.width / 2, y: mw.y + mw.height / 2
                }).workArea;
                ipcMain.emit('drag-start', {},
                  { x: mw.x + Math.floor(mw.width / 2), y: mw.y + Math.floor(mw.height / 2) });
                ipcMain.emit('drag-move', {},
                  { x: mwa.x + mwa.width - 1, y: mwa.y + mwa.height - 1 });
                ipcMain.emit('drag-end', {}, {});
                await wait(500);
                mainEdgeNow = edge(win.getBounds(), mwa);
              } catch (e3) { mainEdgeNow = String(e3 && e3.message || e3); }
              diagLog('petclamp', {
                rows: rows,
                directWant: wa0.x + ',' + wa0.y,
                directGot: direct.x + ',' + direct.y,
                directEdge: edge(direct, wa0),
                parkEdge: edge(park, wa1),
                mainEdge: mainEdgeNow,
                mainInset: winInsetDip()
              });
              setPetOn(false);
            }
          }
          /* 桌面日历端到端自检：
             1) 用主界面【真实的】新增待办弹窗塞三条待办（高/中/低各一条，日期不同），
                顺带验证优先级能存进 localStorage；
             2) 开日历窗，查 42 个格子、今天的格子有高亮、三条待办落在对的日期、
                颜色类名分别是 p-high / p-mid / p-low；
             3) 点有事的格子 → 当天清单出来且条数对；
             4) 点「下一月」→ 标题月份变了；
             5) 存一张日历窗截图，人眼确认外观。 */
          /* 日记页自检：写今天 → 点旧日记改 → 删除 → 导出。
             ⚠️ 先往 localStorage 里种两条「以前写的」，再【重载一次】让程序读进去
             （页面只在启动时读一次存储，种完不重载是看不见的）；
             reload 会让 did-finish-load 再触发一次，所以用一个标志位挡住重复种数据。 */
          if (DIAG.diary) {
            const waitD = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
            const dayKey = function (off) {
              const d = new Date();
              d.setDate(d.getDate() + off);
              const p = function (n) { return n < 10 ? '0' + n : String(n); };
              return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
            };
            if (!diagDiarySeeded) {
              diagDiarySeeded = true;
              const seed = {};
              seed[dayKey(-5)] = '五天前：把周报写完，下午开了个会。';
              seed[dayKey(-2)] = '前天：爬山，腿到现在还酸。';
              await win.webContents.executeJavaScript(
                'localStorage.setItem("kunkun.diary.v1", ' + JSON.stringify(JSON.stringify(seed)) + '); true;', true);
              diagLog('diary-0-种两天旧日记', { 种了: Object.keys(seed) });
              win.webContents.reload();
              return;                                  // 本轮到此为止，重载后再接着验
            }

            /* 切到日记页 */
            await win.webContents.executeJavaScript(
              'document.getElementById("tabDiary").click(); true;', true);
            await waitD(700);
            const view = await win.webContents.executeJavaScript(
              '(function(){var items=document.querySelectorAll("#diaryList .diary-item");' +
              'var first=items[0];var second=items[1];' +
              'return {日记页显示了吗:!document.getElementById("pageDiary").hidden,' +
              ' 标签高亮:document.getElementById("tabDiary").classList.contains("on"),' +
              ' 卡片数:items.length,' +
              ' 日期顺序:Array.prototype.map.call(items,function(i){return i.dataset.key;}),' +
              ' 第一张是今天吗:first?first.classList.contains("today"):null,' +
              ' 今天那张是输入框吗:!!(first&&first.querySelector(".diary-edit")),' +
              ' 旧卡片是只读正文吗:!!(second&&second.querySelector(".diary-body")),' +
              ' 旧卡片里有内容吗:second?second.querySelector(".diary-body").textContent.slice(0,12):"",' +
              ' 农历标签:Array.prototype.map.call(document.querySelectorAll(".diary-lunar"),function(s){return s.textContent;}),' +
              ' 滚动位置:document.getElementById("diaryList")?document.getElementById("diaryList").scrollTop:null,' +
              ' 随机古诗句:document.getElementById("diaryQuote")?document.getElementById("diaryQuote").textContent.slice(0,26):"",' +
              ' 卡片上没有导出按钮了吗:document.querySelectorAll(\'#diaryList button[data-role="export-one"]\').length===0,' +
              ' 旧卡片有编辑按钮吗:!!(second&&second.querySelector(\'button[data-role="edit"]\')),' +
              ' 导出按钮在吗:!!document.getElementById("btnDiaryExport")};})()', true);
            diagLog('diary-1-初始视图', view);
            /* 截一张日记页的图（这时候 3 张卡片都有内容，最好看） */
            try {
              await waitD(300);
              const shotD = await win.capturePage();
              fs.writeFileSync(path.join(__dirname, '.diag', 'diary-page.png'), shotD.toPNG());
            } catch (eShot) { diagLog('diary-shot-error', String(eShot && eShot.message || eShot)); }

            /* ① 今天：在输入框里写 → 等防抖（500ms）→ 落盘 */
            await win.webContents.executeJavaScript(
              '(function(){var ta=document.querySelector("#diaryList .diary-item.today .diary-edit");' +
              'if(!ta)return false;ta.value="今天把日记页写完了，挺顺手。";' +
              'ta.dispatchEvent(new Event("input",{bubbles:true}));return true;})()', true);
            await waitD(1000);
            diagLog('diary-2-今天写完自动存', await win.webContents.executeJavaScript(
              '(function(){var raw={};try{raw=JSON.parse(localStorage.getItem("kunkun.diary.v1")||"{}");}catch(e){}' +
              'var keys=Object.keys(raw);' +
              'return {篇数:keys.length,' +
              ' 今天存进去了:keys.some(function(k){return raw[k].indexOf("日记页")>=0;}),' +
              ' 空的不留键:!keys.some(function(k){return !String(raw[k]).trim();})};})()', true));

            /* ② 旧日记：点正文【不该】进编辑，必须点「编辑」按钮；保存/取消都要能走通 */
            const editStep = await win.webContents.executeJavaScript(
              '(function(){var items=document.querySelectorAll("#diaryList .diary-item");' +
              'var old=items[items.length-1];if(!old)return {error:"没有旧日记卡片"};' +
              'var key=old.dataset.key;' +
              'old.querySelector(".diary-body").click();' +
              'var opened=!!document.querySelector(\'#diaryList .diary-item[data-key="\'+key+\'"] .diary-edit\');' +
              'var b=old.querySelector(\'button[data-role="edit"]\');if(!b)return {error:"没有编辑按钮"};' +
              'b.click();' +
              'return {key:key, 点正文就进编辑了吗:opened};})()', true);
            await waitD(600);
            diagLog('diary-3-点编辑按钮才进编辑', {
              点的是: editStep.key,
              点正文不误触: editStep.点正文就进编辑了吗 === false,
              现在变成输入框了吗: await win.webContents.executeJavaScript(
                '(function(){var it=document.querySelector(\'#diaryList .diary-item[data-key="' + editStep.key + '"]\');' +
                'return !!(it&&it.querySelector(".diary-edit")&&it.querySelector(\'button[data-role="save"]\'));})()', true)
            });

            /* ③ 取消：改了但不保存 → 内容必须原样 */
            const cancelStep = await win.webContents.executeJavaScript(
              '(function(){var it=document.querySelector(\'#diaryList .diary-item[data-key="' + editStep.key + '"]\');' +
              'var ta=it.querySelector(".diary-edit");var before=ta.value;' +
              'ta.value="【这段不该被保存】";' +
              'it.querySelector(\'button[data-role="cancel"]\').click();' +
              'var raw={};try{raw=JSON.parse(localStorage.getItem("kunkun.diary.v1")||"{}");}catch(e){}' +
              'return {原文:before.slice(-8), 存的是:raw[' + JSON.stringify(editStep.key) + '].slice(-8)};})()', true);
            await waitD(400);
            diagLog('diary-4-取消不保存', {
              改了点什么: '【这段不该被保存】',
              存储里没被改: cancelStep.存的是 === cancelStep.原文,
              又回到只读了吗: await win.webContents.executeJavaScript(
                '(function(){var it=document.querySelector(\'#diaryList .diary-item[data-key="' + editStep.key + '"]\');' +
                'return !!(it&&it.querySelector(".diary-body")&&!it.querySelector(".diary-edit"));})()', true)
            });

            /* ④ 再进来改并「保存」→ 落到存储里 */
            await win.webContents.executeJavaScript(
              '(function(){var it=document.querySelector(\'#diaryList .diary-item[data-key="' + editStep.key + '"]\');' +
              'it.querySelector(\'button[data-role="edit"]\').click();return true;})()', true);
            await waitD(500);
            await win.webContents.executeJavaScript(
              '(function(){var it=document.querySelector(\'#diaryList .diary-item[data-key="' + editStep.key + '"]\');' +
              'var ta=it.querySelector(".diary-edit");ta.value=ta.value+"【自检补了一句】";' +
              'it.querySelector(\'button[data-role="save"]\').click();return true;})()', true);
            await waitD(500);
            diagLog('diary-5-点保存才落盘', {
              存进去了吗: await win.webContents.executeJavaScript(
                '(function(){var raw={};try{raw=JSON.parse(localStorage.getItem("kunkun.diary.v1")||"{}");}catch(e){}' +
                'return !!raw[' + JSON.stringify(editStep.key) + ']&&raw[' + JSON.stringify(editStep.key) +
                '].indexOf("自检补了一句")>=0;})()', true),
              改完收回只读了吗: await win.webContents.executeJavaScript(
                '(function(){var it=document.querySelector(\'#diaryList .diary-item[data-key="' + editStep.key + '"]\');' +
                'return !!(it&&it.querySelector(".diary-body")&&!it.querySelector(".diary-edit"));})()', true)
            });

            /* ⑤ 导出：先看对话框的范围提示，再只导「今天」这一天，验证范围真的生效 */
            const todayKey = dayKey(0);
            /* 顺手截一张对话框的图 */
            try {
              await win.webContents.executeJavaScript(
                'document.getElementById("btnDiaryExport").click(); true;', true);
              await waitD(500);
              const shotE = await win.capturePage();
              fs.writeFileSync(path.join(__dirname, '.diag', 'diary-export-dialog.png'), shotE.toPNG());
              await win.webContents.executeJavaScript(
                'document.getElementById("deCancel").click(); true;', true);
              await waitD(300);
            } catch (eShot2) { diagLog('diary-shot2-error', String(eShot2 && eShot2.message || eShot2)); }
            const expStep = await win.webContents.executeJavaScript(
              '(function(){document.getElementById("btnDiaryExport").click();' +
              'var ov=document.getElementById("diaryExportOverlay");' +
              'var open=ov?!ov.hidden:null;' +
              'var defFrom=document.getElementById("deFrom").value, defTo=document.getElementById("deTo").value;' +
              'document.getElementById("deFrom").value=' + JSON.stringify(todayKey) + ';' +
              'document.getElementById("deTo").value=' + JSON.stringify(todayKey) + ';' +
              'document.getElementById("deFrom").dispatchEvent(new Event("change",{bubbles:true}));' +
              'var hint=document.getElementById("deHint").textContent;' +
              'document.getElementById("deOk").click();' +
              'return {弹窗开了吗:open, 默认范围:defFrom+"~"+defTo, 只导今天时的提示:hint};})()', true);
            await waitD(900);
            let expTxt = '';
            try { expTxt = fs.readFileSync(diagFilePath('diary-export.txt'), 'utf8'); }
            catch (e) { }
            const expLines = expTxt.split(/\r?\n/);
            diagLog('diary-6-按范围导出', {
              对话框: expStep,
              文件里的标题: expLines[0],
              只含今天: expTxt.indexOf(todayKey) >= 0 &&
                expTxt.indexOf(dayKey(-2)) < 0 && expTxt.indexOf(dayKey(-5)) < 0,
              文件字节: expTxt.length,
              带农历: /农历/.test(expTxt),
              弹窗关掉了吗: await win.webContents.executeJavaScript(
                'document.getElementById("diaryExportOverlay").hidden', true)
            });

            /* ⑦ 今天那张卡片：写之前是输入框；写了内容（重排之后）就该变成「只读 + 编辑」 */
            const todayFlip = await win.webContents.executeJavaScript(
              '(function(){document.getElementById("tabTodo").click();' +
              'document.getElementById("tabDiary").click();' +          /* 切走再切回来，强制重排 */
              'var it=document.querySelector("#diaryList .diary-item.today");' +
              'if(!it)return {error:"没有今天的卡片"};' +
              'return {写完之后还是输入框吗:!!it.querySelector(".diary-edit"),' +
              ' 有编辑按钮吗:!!it.querySelector(\'button[data-role="edit"]\'),' +
              ' 正文在吗:!!it.querySelector(".diary-body")};})()', true);
            await waitD(500);
            /* 点「编辑」应该又能改 */
            const todayEdit = await win.webContents.executeJavaScript(
              '(function(){var it=document.querySelector("#diaryList .diary-item.today");' +
              'var b=it.querySelector(\'button[data-role="edit"]\');if(!b)return {error:"没有编辑按钮"};' +
              'b.click();var it2=document.querySelector("#diaryList .diary-item.today");' +
              'return {点编辑后能改了吗:!!(it2&&it2.querySelector(".diary-edit")),' +
              ' 有保存按钮吗:!!(it2&&it2.querySelector(\'button[data-role="save"]\'))};})()', true);
            await win.webContents.executeJavaScript(
              '(function(){var it=document.querySelector("#diaryList .diary-item.today");' +
              'var b=it.querySelector(\'button[data-role="cancel"]\');if(b)b.click();return true;})()', true);
            await waitD(300);
            diagLog('diary-8-今天的卡片', { 写完重排后: todayFlip, 点编辑: todayEdit });
            /* 截一张「今天已经写过」的图：这时它应该和旧日记一样是只读 + 编辑按钮 */
            try {
              await waitD(300);
              const shotT = await win.capturePage();
              fs.writeFileSync(path.join(__dirname, '.diag', 'diary-page-written.png'), shotT.toPNG());
            } catch (eShot3) { diagLog('diary-shot3-error', String(eShot3 && eShot3.message || eShot3)); }

            /* ⑧ 补写某天：选个以前的日子 → 卡片亮出来能写 → 保存后就变成只读 + 编辑 */
            const backKey = dayKey(-3);
            const backOpen = await win.webContents.executeJavaScript(
              '(function(){document.getElementById("btnDiaryBackfill").click();' +
              'var ov=document.getElementById("diaryBackfillOverlay");' +
              /* ⚠️ 这里别再取反了：直接记「有没有露出来」，自检里踩过双重否定 */
              'var shown=ov?ov.hidden===false:null;' +
              'var d=document.getElementById("dbDate");' +
              'var def=d.value;d.value=' + JSON.stringify(backKey) + ';' +
              'var maxOk=d.max===' + JSON.stringify(dayKey(0)) + ';' +
              'document.getElementById("dbOk").click();' +
              'return {弹窗露出来了吗:shown, 默认补哪天:def, 上限是今天吗:maxOk};})()', true);
            await waitD(600);
            const backWrite = await win.webContents.executeJavaScript(
              '(function(){var it=document.querySelector(\'#diaryList .diary-item[data-key="' + backKey + '"]\');' +
              'if(!it)return {error:"补写的那天没出现卡片"};' +
              'var ta=it.querySelector(".diary-edit");' +
              'var hasSave=!!it.querySelector(\'button[data-role="save"]\');' +
              'if(!ta)return {error:"补写的卡片没有输入框"};' +
              'ta.value="三天前：翻了下旧笔记，顺手整理了一遍。";' +
              'it.querySelector(\'button[data-role="save"]\').click();' +
              'return {能写吗:true, 有保存按钮:hasSave};})()', true);
            await waitD(500);
            diagLog('diary-9-补写某天', {
              补的是: backKey,
              打开弹窗: backOpen,
              写的过程: backWrite,
              存进去了吗: await win.webContents.executeJavaScript(
                '(function(){var raw={};try{raw=JSON.parse(localStorage.getItem("kunkun.diary.v1")||"{}");}catch(e){}' +
                'return !!raw[' + JSON.stringify(backKey) + '];})()', true),
              保存后变只读了吗: await win.webContents.executeJavaScript(
                '(function(){var it=document.querySelector(\'#diaryList .diary-item[data-key="' + backKey + '"]\');' +
                'return !!(it&&it.querySelector(".diary-body")&&it.querySelector(\'button[data-role="edit"]\'));})()', true),
              插在正确位置了吗: await win.webContents.executeJavaScript(
                '(function(){return Array.prototype.map.call(document.querySelectorAll("#diaryList .diary-item"),' +
                'function(i){return i.dataset.key;}).join(" > ");})()', true)
            });
            const allStep = await win.webContents.executeJavaScript(
              '(function(){document.getElementById("btnDiaryExport").click();' +
              'var q=document.querySelector(\'#deQuick button[data-all="1"]\');if(q)q.click();' +
              'return {全部档提示:document.getElementById("deHint").textContent};})()', true);
            await win.webContents.executeJavaScript(
              'document.getElementById("deCancel").click(); true;', true);
            diagLog('diary-7-全部档', allStep);

            /* ⑨ 字号：把日记页各处的实际字号量出来（顺便验设置里「日记文字大小」真能改） */
            const fsProbe = function () {
              return '(function(){var q=function(s){var n=document.querySelector(s);' +
                'return n?getComputedStyle(n).fontSize:null;};' +
                'var p=document.getElementById("pageDiary");' +
                'return {古诗词:q(".diary-quote"), 日期:q(".diary-date"), 周几:q(".diary-wd"),' +
                ' 农历:q(".diary-lunar"), 正文:q(".diary-body"), 输入框:q(".diary-edit"),' +
                ' 卡片按钮:q(".diary-tools button"),' +
                ' 页面字号变量:p?getComputedStyle(p).getPropertyValue("--diary-fs").trim():null};})()';
            };
            await win.webContents.executeJavaScript(
              'document.getElementById("tabDiary").click(); true;', true);
            await waitD(500);
            /* 输入框只在编辑状态才在，先点开今天那张的「编辑」再量 */
            await win.webContents.executeJavaScript(
              '(function(){var b=document.querySelector(\'#diaryList .diary-item.today button[data-role="edit"]\');' +
              'if(b)b.click();return true;})()', true);
            await waitD(400);
            const fsBefore = await win.webContents.executeJavaScript(fsProbe(), true);
            const fsSet = await win.webContents.executeJavaScript(
              '(function(){var p=document.getElementById("dfPlus");' +
              'if(!p)return {error:"日记页上没有字号按钮"};' +
              'for(var i=0;i<12;i++)p.click();' +            /* 一直点到头，看能不能到 24 且停住 */
              'return {点满之后显示:document.getElementById("dfVal").textContent,' +
              ' 到顶了会禁用吗:p.disabled};})()', true);
            await waitD(600);
            const fsAfter = await win.webContents.executeJavaScript(fsProbe(), true);
            const fsSaved = await win.webContents.executeJavaScript(
              '(function(){var raw={};try{raw=JSON.parse(localStorage.getItem("kunkun.settings.v1")||"{}");}catch(e){}' +
              'return raw.diaryFont;})()', true);
            /* 再一路点到最小，看下限也停得住 */
            const fsMinClick = await win.webContents.executeJavaScript(
              '(function(){var m=document.getElementById("dfMinus");' +
              'for(var i=0;i<12;i++)m.click();' +
              'return {点到底显示:document.getElementById("dfVal").textContent,' +
              ' 到底了会禁用吗:m.disabled};})()', true);
            await waitD(500);
            const fsMinSize = await win.webContents.executeJavaScript(fsProbe(), true);
            /* 回到标准档 16，别把自检的状态留给下一次 */
            const fsBackClick = await win.webContents.executeJavaScript(
              '(function(){var p=document.getElementById("dfPlus");' +
              'p.click();p.click();' +                        /* 12 → 14 → 16 */
              'return {现在显示:document.getElementById("dfVal").textContent};})()', true);
            await waitD(400);
            const fsBack = await win.webContents.executeJavaScript(fsProbe(), true);
            diagLog('diary-10-字号', {
              默认: fsBefore,
              连点到最大: { 交互: fsSet, 之后: fsAfter },
              存进设置了吗: fsSaved,
              连点到最小: { 交互: fsMinClick, 之后: fsMinSize },
              回到标准: { 交互: fsBackClick, 之后: fsBack }
            });

            /* 顺手截一张日记页（字号步进器就在右上角） */
            try {
              await waitD(300);
              const shotF = await win.capturePage();
              fs.writeFileSync(path.join(__dirname, '.diag', 'diary-fontbox.png'), shotF.toPNG());
            } catch (eShot4) { diagLog('diary-shot4-error', String(eShot4 && eShot4.message || eShot4)); }

            /* ④ 删除某天（先骗过 window.confirm，自检点不了系统对话框） */
            const delStep = await win.webContents.executeJavaScript(
              '(function(){window.confirm=function(){return true;};' +
              'var items=document.querySelectorAll("#diaryList .diary-item");' +
              'var old=items[items.length-1];if(!old)return {error:"没有旧日记卡片"};' +
              'var key=old.dataset.key;' +
              'var b=old.querySelector(\'button[data-role="del"]\');if(!b)return {error:"没有删除按钮"};' +
              'b.click();return {key:key};})()', true);
            await waitD(700);
            diagLog('diary-5-删除某天', {
              删的是: delStep.key,
              卡片还在吗: await win.webContents.executeJavaScript(
                '(function(){return !!document.querySelector(\'#diaryList .diary-item[data-key="' + delStep.key + '"]\');})()', true),
              存储里还有吗: await win.webContents.executeJavaScript(
                '(function(){var raw={};try{raw=JSON.parse(localStorage.getItem("kunkun.diary.v1")||"{}");}catch(e){}' +
                'return !!raw[' + JSON.stringify(delStep.key) + '];})()', true),
              剩下的篇数: await win.webContents.executeJavaScript(
                '(function(){var raw={};try{raw=JSON.parse(localStorage.getItem("kunkun.diary.v1")||"{}");}catch(e){}' +
                'return Object.keys(raw).length;})()', true)
            });
            await waitD(400);
          }
          /* 用户皮肤自检：目录/说明文档会不会自动备好；被安装程序整目录清掉后能不能自愈。
             ⚠️ 把用户皮肤目录临时指到一个干净的空目录：这才像「装好之后」的布局
             （开发模式下它等于仓库的 skins/，里面全是内置皮肤，造不出「被清空」的场景）。 */
          if (DIAG.skins) {
            const mirror = skinsMirrorDir();
            const tmpDir = path.join(app.getPath('userData'), 'diag-skins');
            const fakeName = '【自检】测试皮肤';
            const cleanup = function () {
              try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { }
              try { fs.rmSync(mirror, { recursive: true, force: true }); } catch (e) { }
              skinsDirOverride = '';
            };
            cleanup();                                     // 干净起步
            skinsDirOverride = tmpDir;
            const dir = userSkinsDir();
            const readme = path.join(dir, 'README.md');
            const fake = path.join(dir, fakeName);

            ensureUserSkins();                             // 正常情况下启动时就会做
            diagLog('skins-1-目录与文档', {
              用户皮肤目录: dir,
              目录自动建好了吗: fs.existsSync(dir),
              说明文档自动写了吗: fs.existsSync(readme)
                ? (fs.readFileSync(readme, 'utf8').length + ' 字节') : '❌ 没有',
              内置皮肤在别处: process.resourcesPath
                ? path.join(process.resourcesPath, 'skins') : '(开发模式：仓库 skins/)'
            });

            /* 造一个「用户自己做的」皮肤：一个子文件夹 + skin.json + 一张图 */
            try {
              fs.mkdirSync(fake, { recursive: true });
              fs.writeFileSync(path.join(fake, 'skin.json'), JSON.stringify({
                name: '自检皮肤', author: 'diag',
                frame: { w: 8, h: 8 },
                animations: { idle: { row: 0, frames: 1, fps: 1 } }
              }), 'utf8');
              fs.writeFileSync(path.join(fake, 'sheet.png'), Buffer.from(
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
                'base64'));
            } catch (e) { diagLog('skins-write-error', String(e && e.message || e)); }

            const scanned = scanSkins().map(function (s) { return s.id; });
            diagLog('skins-2-能不能扫到', {
              用户目录: listUserSkinDirs(),
              用户皮肤认出来了吗: scanned.indexOf(fakeName) >= 0,
              说明文档被误当皮肤了吗: scanned.indexOf('README.md') >= 0
            });

            /* 镜像（正常情况下每次列皮肤都会顺手做一次） */
            const m1 = syncSkinsMirror();
            diagLog('skins-3-镜像到 userData', {
              动作: m1,
              镜像里有皮肤吗: fs.existsSync(path.join(mirror, fakeName, 'skin.json'))
            });

            /* ① 模拟「更新时安装程序把整个安装目录删掉」→ 下次启动应该自愈 */
            fs.rmSync(dir, { recursive: true, force: true });
            const wiped = !fs.existsSync(fake);
            const m2 = syncSkinsMirror();
            diagLog('skins-4-整目录被清掉后自愈', {
              模拟清掉成功: wiped,
              动作: m2,
              皮肤回来了吗: fs.existsSync(path.join(fake, 'skin.json')),
              图片也回来了吗: fs.existsSync(path.join(fake, 'sheet.png')),
              说明文档也回来了吗: fs.existsSync(readme)
            });

            /* ② 用户【故意】删掉皮肤 → 目录还在、里面空了 → 镜像也要跟着清掉，别复活 */
            fs.rmSync(fake, { recursive: true, force: true });
            const dirStillThere = fs.existsSync(dir);
            const m3 = syncSkinsMirror();
            const mirrorStillHas = fs.existsSync(path.join(mirror, fakeName));
            fs.rmSync(dir, { recursive: true, force: true });
            const m4 = syncSkinsMirror();
            diagLog('skins-5-故意删掉的别复活', {
              删完目录还在吗: dirStillThere,
              删完镜像动作: m3,
              镜像里还留着吗: mirrorStillHas,
              再清一次目录的动作: m4,
              复活了吗: fs.existsSync(fake)
            });

            /* ---- 新增：主界面「🔄 刷新」按钮 —— 刚放进去的皮肤不重启也该认出来 ---- */
            try {
              fs.mkdirSync(fake, { recursive: true });
              fs.writeFileSync(path.join(fake, 'skin.json'), JSON.stringify({
                name: '自检刷新皮肤', author: 'diag',
                frame: { w: 8, h: 8 },
                animations: { idle: { row: 0, count: 1, fps: 1 } }
              }), 'utf8');
              fs.writeFileSync(path.join(fake, 'sheet.png'), Buffer.from(
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
                'base64'));
            } catch (e) { diagLog('skins-refresh-write-error', String(e && e.message || e)); }
            const optsBefore = await win.webContents.executeJavaScript(
              '(function(){var s=document.getElementById("skinSel");return s?s.options.length:-1;})()', true);
            const clicked = await win.webContents.executeJavaScript(
              '(function(){var b=document.getElementById("btnSkinRefresh");if(!b)return false;b.click();return true;})()', true);
            await new Promise(function (r) { setTimeout(r, 1000); });
            diagLog('skins-7-刷新按钮', await win.webContents.executeJavaScript(
              '(function(){var s=document.getElementById("skinSel");var cap=document.getElementById("stageCaption");' +
              'var names=[];if(s){for(var i=0;i<s.options.length;i++)names.push(s.options[i].textContent);}' +
              'return {按钮点得到吗:' + !!clicked + ', 点之前有几个:' + optsBefore + ', 点之后有几个:names.length,' +
              ' 新皮肤出现了吗:names.indexOf("自检刷新皮肤")>=0, 下拉框:names,' +
              ' 说明文字:cap?cap.textContent:null};})()', true));

            /* ---- 朋友画的猫：在不在列表里、帧率有没有按我们调慢的值走 ---- */
            const catSkin = scanSkins().filter(function (s) { return s.id === 'cat-scientist'; })[0];
            let catMeta = null;
            try {
              catMeta = catSkin
                ? JSON.parse(fs.readFileSync(path.join(catSkin.dir, 'cat-scientist', 'skin.json'), 'utf8')) : null;
            } catch (e) { /* 读不到就报空 */ }
            diagLog('skins-8-新皮肤(喵星科学家)', {
              列表里找到了吗: !!catSkin,
              名字: catSkin ? catSkin.name : '',
              在哪个目录: catSkin ? catSkin.dir : '',
              单帧尺寸: catMeta ? (catMeta.frame.w + ' x ' + catMeta.frame.h) : '',
              待机fps: catMeta ? catMeta.animations.idle.fps : null,
              跳舞fps: catMeta ? catMeta.animations.dance.fps : null,
              欢呼fps: catMeta ? catMeta.animations.cheer.fps : null,
              精灵图在吗: catSkin && catMeta
                ? fs.existsSync(path.join(catSkin.dir, 'cat-scientist', catMeta.sheet || 'sheet.png')) : false
            });

            cleanup();
            diagLog('skins-6-清理完毕', {
              临时目录: fs.existsSync(tmpDir) ? '❌ 还在' : '✅ 已清掉',
              镜像目录: fs.existsSync(mirror) ? '❌ 还在' : '✅ 已清掉'
            });
          }
          /* ============ 气泡里的「今日待办」（--diag-bubble） ============
             走真实链路：页面收到 pet-talk-request → 回 pet-talk-data → 主进程 showBubble。
             两轮：① 种 4 条今天的待办（1 条已完成）→ 重载 → 看气泡里是不是列出来了、
             气泡有没有长高（只列 3 条 + 「还有 1 条」）；② 清空 → 看那块整个不出现。 */
          if (DIAG.bubble) {
            const bwait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
            const todayAt = function (h, mi) {
              const d = new Date(); d.setHours(h, mi, 0, 0); return d.getTime();
            };
            const seedTodos = function (arr) {
              return '(function(){localStorage.setItem("kunkun.todos.v1",JSON.stringify({memos:[],todos:' +
                JSON.stringify(arr) + '}));return true;})()';
            };
            const bubbleReload = function () {
              diagBubbleStage++;
              win.webContents.reload();
              const stop = new Error('diag-restart');
              stop.diagRestart = true;
              throw stop;
            };
            const askBubble = async function () {
              setPetOn(true);
              await bwait(600);
              requestPetTalk();            // 走真实链路：页面回 pet-talk-data → showBubble
              await bwait(1000);
            };
            const bubbleInfo = async function (tag) {
              const w = bubbleWin;
              if (!w || w.isDestroyed()) return { 气泡窗: '❌ 没建出来' };
              const bounds = w.getBounds();
              const inner = await w.webContents.executeJavaScript(
                '(function(){var g=function(id){return document.getElementById(id);};' +
                'var rows=[];var list=g("todoList");' +
                'if(list){var rs=list.querySelectorAll(".pb-todo-row");' +
                'for(var i=0;i<rs.length;i++)rows.push(rs[i].textContent.replace(/\\s+/g," ").trim());}' +
                'var more=document.querySelector(".pb-todo-more");' +
                'var box=g("bubble-inner");' +
                'return {第一行:g("head").textContent, 待办块收起来了吗:g("todos").hidden,' +
                ' 待办标题:g("todoHead").textContent, 待办行:rows,' +
                ' 还有更多:more?more.textContent:null, 最后一行:g("next").textContent,' +
                ' 内容有没有溢出:box?box.scrollHeight>box.clientHeight+1:null};})()', true);
              let shot = '';
              try {
                const img = await w.capturePage();
                shot = diagFilePath('bubble-' + tag + '.png');
                fs.writeFileSync(shot, img.toPNG());
              } catch (e) { shot = '截图失败: ' + String((e && e.message) || e); }
              return Object.assign({ 气泡窗: bounds.width + ' x ' + bounds.height, 截图: shot }, inner);
            };

            if (diagBubbleStage === 0) {
              await win.webContents.executeJavaScript(seedTodos([
                { id: 'bub1', text: '【自检】上午开会', done: false, at: Date.now(),
                  dueAt: todayAt(9, 30), remindAt: todayAt(9, 30), prio: 'high', notify: true },
                { id: 'bub2', text: '【自检】吃维生素', done: true, at: Date.now(),
                  dueAt: todayAt(12, 0), remindAt: todayAt(12, 0), prio: 'mid', notify: true },
                { id: 'bub3', text: '【自检】下午三点交周报', done: false, at: Date.now(),
                  dueAt: todayAt(15, 0), remindAt: todayAt(15, 0), prio: 'mid', notify: true },
                { id: 'bub4', text: '【自检】晚上遛狗', done: false, at: Date.now(),
                  dueAt: todayAt(20, 0), remindAt: todayAt(20, 0), prio: 'low', notify: true }
              ]), true);
              bubbleReload();
            } else if (diagBubbleStage === 1) {
              await askBubble();
              diagLog('bubble-1-今天有待办', await bubbleInfo('有'));
              await win.webContents.executeJavaScript(seedTodos([]), true);
              bubbleReload();
            } else if (diagBubbleStage === 2) {
              await askBubble();
              diagLog('bubble-2-今天没待办', await bubbleInfo('无'));
            }
          }
          /* ============ 科研动态（--diag-arxiv） ============
             端到端：真去 arXiv 抓一次 → 存库去重 → 宠物气泡推送（可点）→ 界面列表。
             抓的是真网络，所以这一步比较慢（两三秒）。 */
          if (DIAG.arxiv) {
            const aw = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
            const ajs = function (code) { return win.webContents.executeJavaScript(code, true); };
            const shortSt = function (s) {
              if (!s) return null;
              return {
                关键词: s.config.keywords, 字段: s.config.fields,
                模式: s.config.matchAny ? '任一条件' : '全部条件',
                天数: s.config.days, 间隔小时: s.config.intervalH,
                每次上限: s.config.pushCap, 未读: s.unread, 库里共: s.total,
                下次抓取: s.nextAt > 0 ? '已排期' : '没排期'
              };
            };
            diagLog('arxiv-1-服务', { 起来了: !!arxivSvc, 状态: arxivSvc ? shortSt(arxivSvc.state()) : null });
            if (arxivSvc) {
              /* 用真关键词跑：图神经网络（标题+摘要）、最近 7 天、每次最多推 2 篇 */
              arxivSvc.setConfig({
                keywords: ['graph neural network'], fields: ['ti', 'abs'], matchAny: true,
                days: 7, intervalH: 12, pushCap: 2, maxResults: 10, enabled: true
              });
              await aw(400);
              const st1 = arxivSvc.state();
              const ARXIVMOD = require('./arxiv');
              diagLog('arxiv-2-查询串', {
                查询串: st1.query,
                日期过滤对不对: /submittedDate:\[\d{12} TO \d{12}\]/.test(st1.query),
                运算符都大写: !/\b(and|or)\b/.test(st1.query.replace(/"[^"]*"/g, '')),
                没关键词时为空: ARXIVMOD.buildArxivQuery({ keywords: [], fields: ['ti'], matchAny: true, days: 7 }) === ''
              });
              /* 界面先切到科研页，看看「还没抓」时的样子 */
              await ajs('document.getElementById("tabArxiv").click(); true;');
              await aw(600);
              diagLog('arxiv-3-界面初始', await ajs(
                '(function(){var d=window.kunkunArxivUI._debug();return {' +
                ' 挂上了吗:d.inited, 列表条数:d.listCount, 状态行:d.status,' +
                ' 查询串还在界面上吗:!!document.getElementById("axQuery"),' +
                ' 关键词卡片数:document.querySelectorAll("#axChips .ax-chip").length,' +
                ' 字段勾选数:document.querySelectorAll("#axFields input:checked").length,' +
                ' 字段后面还有英文缩写吗:!!document.querySelector("#axFields code"),' +
                ' 提示文字:(document.querySelector("#pageArxiv .arxiv-col:last-child .col-sub")||{}).textContent};})()'));

              /* 开宠物 → 真抓一次（走完整链路：抓取 → 入库 → 去重 → 推送 → 气泡） */
              setPetOn(true);
              await aw(700);
              const r1 = await arxivSvc.runFetch('手动');
              await aw(1200);
              diagLog('arxiv-4-真抓取', {
                ok: r1.ok, 命中总数: r1.total, 这一页: r1.got, 新增: r1.added, 推送: r1.pushed,
                用时秒: Math.round((r1.ms || 0) / 100) / 10, 重试几次: r1.tries, 错误: r1.error || ''
              });
              diagLog('arxiv-5-推送', {
                宠物开着: petOn, 气泡开着: talkOpen,
                气泡窗: (bubbleWin && !bubbleWin.isDestroyed()) ? JSON.stringify(bubbleWin.getBounds()) : '没建出来',
                本次通知: arxivLastNotify
                  ? { 篇数: arxivLastNotify.count, 关键词: arxivLastNotify.keywords,
                      第一篇: (arxivLastNotify.items[0] || {}).title }
                  : null
              });

              if (bubbleWin && !bubbleWin.isDestroyed()) {
                diagLog('arxiv-6-气泡内容', await bubbleWin.webContents.executeJavaScript(
                  '(function(){return {第一行:document.getElementById("head").textContent,' +
                  ' 内容:document.getElementById("tip").textContent,' +
                  ' 最后一行:document.getElementById("next").textContent,' +
                  ' 可点样式:document.body.classList.contains("clickable")};})()', true));
                try {
                  const img = await bubbleWin.capturePage();
                  const f = diagFilePath('arxiv-bubble.png');
                  fs.writeFileSync(f, img.toPNG());
                  diagLog('arxiv-6b-气泡截图', { file: f, size: img.getSize() });
                } catch (e) { diagLog('arxiv-6b-截图失败', { message: String((e && e.message) || e) }); }
                /* 点气泡（真实链路：气泡页面 → 主进程 → 主界面切到科研页） */
                await bubbleWin.webContents.executeJavaScript(
                  'document.dispatchEvent(new MouseEvent("click",{bubbles:true})); true;', true);
                await aw(700);
                diagLog('arxiv-7-点气泡后', await ajs(
                  '(function(){var on=document.querySelector(".tab-btn.on");' +
                  'return {当前标签:on?on.id:null, 气泡还开着:' + (talkOpen ? 'true' : 'false') + '};})()'));
              }

              /* 去重：同样条件再抓一次，应该「0 新增、0 推送」 */
              const r2 = await arxivSvc.runFetch('定时');
              diagLog('arxiv-8-去重', { 新增: r2.added, 推送: r2.pushed, 库里共: arxivSvc.state().total });

              /* 列表界面：条数、标题、按钮、红点 */
              await ajs('document.getElementById("tabArxiv").click(); window.kunkunArxivUI.refresh(); true;');
              await aw(800);
              diagLog('arxiv-9-列表界面', await ajs(
                '(function(){var d=window.kunkunArxivUI._debug();' +
                'var rows=document.querySelectorAll("#arxivList .arxiv-item");' +
                'var first=rows[0];' +
                'var badge=document.getElementById("arxivBadge");' +
                'return {列表条数:d.listCount, DOM条数:rows.length,' +
                ' 第一条标题:first?first.querySelector(".arxiv-title").textContent:null,' +
                ' 第一条按钮数:first?first.querySelectorAll(".arxiv-btns button").length:0,' +
                ' 有摘要吗:first?first.querySelector(".arxiv-abs").textContent.length>30:null,' +
                ' 未读:d.unread, 红点:badge.hidden?"(无)":badge.textContent};})()'));

              /* 0 结果的情况：不能崩、也不能把它当成错误（用「定时」绕开手动抓取的冷却） */
              arxivSvc.setConfig({ keywords: ['zzzqqqxxnotarealterm'] });
              await aw(300);
              const r3 = await arxivSvc.runFetch('定时');
              diagLog('arxiv-10-查不到结果', {
                ok: r3.ok, 命中总数: r3.total, 新增: r3.added, 推送: r3.pushed, 错误: r3.error || ''
              });

              /* 配置持久化：写进去 → 重新开一个连接读回来 */
              try {
                const ARXIVDB = require('./arxiv-db');
                const again = ARXIVDB.openArxivDb(ARXIVDB.arxivDbPath(app.getPath('userData')));
                const back = again.getConfig();
                diagLog('arxiv-11-配置持久化', {
                  重新读出来的关键词: back.keywords, 字段: back.fields,
                  间隔小时: back.intervalH, 上限: back.pushCap, 天数: back.days
                });
                again.close();
              } catch (e) { diagLog('arxiv-11-持久化失败', { message: String((e && e.message) || e) }); }

              /* 宠物没开的时候：没有气泡可弹，要退化成系统托盘气泡，而且不能抛异常 */
              try {
                setPetOn(false);
                await aw(600);
                notifyArxivPapers({
                  count: 1, freshCount: 1, keywords: ['graph neural network'],
                  items: [{ title: '【自检】没开宠物时的兜底通知', pdfUrl: '', absUrl: '' }]
                });
                await aw(500);
                diagLog('arxiv-12-没开宠物时', {
                  气泡开着: talkOpen, 没抛异常: true, 未读: arxivSvc.state().unread
                });
              } catch (e) {
                diagLog('arxiv-12-没开宠物时', { 抛异常了: String((e && e.message) || e) });
              }
              setPetOn(true);
              await aw(500);

              /* 定时调度这条链：改了关键词 → 服务自己排一次抓取（8 秒后）→ 不手动点也该抓。
                 这一步真的会再打一次 arXiv（3 秒限速照样生效）。 */
              const beforeFetchAt = arxivSvc.state().config.lastFetchAt;
              arxivSvc.setConfig({ keywords: ['transformer', 'graph neural network'] });
              await aw(11500);
              const stAfter = arxivSvc.state();
              diagLog('arxiv-13-自动抓取', {
                上次抓取时间往前走了吗: stAfter.config.lastFetchAt > beforeFetchAt,
                最近一次的原因: stAfter.lastResult ? stAfter.lastResult.reason : '',
                这一轮新增: stAfter.lastResult ? stAfter.lastResult.added : null,
                库里共: stAfter.total
              });

              /* 15. 用户报的 bug 复现：自动抓取正在跑的时候点「立即抓取」，
                     宠物弹窗会提示，但科研界面的列表以前不会自己刷新 ——
                     现在要求：不点气泡、不切页，列表自己就得出来。 */
              try {
                await ajs('document.getElementById("tabArxiv").click(); true;');
                await aw(400);
                arxivDb.clearPapers();                       // 先把库清空，列表也刷成空
                await ajs('window.kunkunArxivUI.refresh(); true;');
                await aw(800);
                const emptyNow = await ajs('window.kunkunArxivUI._debug().listCount');
                const autoP = arxivSvc.runFetch('定时');      // 自动那一轮先跑起来
                await aw(250);
                await ajs('document.getElementById("btnArxivFetch").click(); true;');   // 用户同时点按钮
                const seen = [];
                for (let i = 1; i <= 14; i++) {
                  await aw(1000);
                  seen.push(await ajs('(function(){var d=window.kunkunArxivUI._debug();' +
                    'return {' + '秒:' + i + ', 列表:d.listCount, 未读:d.unread};})()'));
                }
                const autoR = await autoP;
                diagLog('arxiv-15-按钮撞上自动抓取', {
                  清空后列表条数: emptyNow,
                  自动那轮: { ok: autoR.ok, 新增: autoR.added, 跳过: autoR.skipped || '' },
                  每秒的列表条数: seen.map(function (x) { return x.秒 + '→' + x.列表; }).join(' '),
                  最后: seen.length ? seen[seen.length - 1] : null,
                  列表自己出来了: !!(seen.length && seen[seen.length - 1].列表 > 0)
                });
              } catch (e) {
                diagLog('arxiv-15-按钮撞上自动抓取', { 抛异常了: String((e && e.message) || e) });
              }

              /* 16. 右列（抓取条件）在真实窗口尺寸下到底装不装得下，还剩多少空间 */
              diagLog('arxiv-16-右列几何', await ajs(
                '(function(){var c=document.querySelector("#pageArxiv .arxiv-col:last-child");' +
                'var foot=document.getElementById("axClearAll");' +
                'var r=c?c.getBoundingClientRect():null; var f=foot?foot.getBoundingClientRect():null;' +
                'var p=document.getElementById("pageArxiv");' +
                'var kids=c?c.children:[]; var last=kids.length?kids[kids.length-1].getBoundingClientRect().bottom:0;' +
                'return {窗口内高:window.innerHeight, 页面可视高:getComputedStyle(document.documentElement).getPropertyValue("--page-view-h").trim(),' +
                ' 右列可视:c?c.clientHeight:0, 右列滚动:c?c.scrollHeight:0, 右列边框高:r?Math.round(r.height):0,' +
                ' 右列要滚动:c?c.scrollHeight>c.clientHeight:null,' +
                ' 右列还剩空间:r?Math.round(r.bottom-Math.max(last, f?f.bottom:0)):0,' +
                ' 清空按钮底: f?Math.round(f.bottom):0, 右列底: r?Math.round(r.bottom):0,' +
                ' 按钮露全了: !!(f&&r)&&f.bottom<=r.bottom+1,' +
                ' 页高:p?p.offsetHeight:0};})()'));

              /* 17. 真实抓回来的论文里，公式还残留多少（用户报过摘要里一堆 $ 和反斜杠） */
              try {
                const rows = arxivDb.listPapers({ limit: 50 }).items;
                const dollar = rows.filter(function (p) { return /\$/.test(p.title + p.summary); }).length;
                const slash = rows.filter(function (p) { return /\\[a-zA-Z]/.test(p.title + p.summary); }).length;
                diagLog('arxiv-17-公式清洗', {
                  看了几条: rows.length,
                  还残留美元号的: dollar,
                  还残留反斜杠命令的: slash,
                  样例标题: rows[0] ? String(rows[0].title).slice(0, 70) : '',
                  样例摘要: rows[0] ? String(rows[0].summary).slice(0, 140) : ''
                });
              } catch (e) { diagLog('arxiv-17-公式清洗', { 抛异常了: String((e && e.message) || e) }); }

              /* 留下一个「可点的气泡」不动，等外面用真鼠标来点（--diag-arxiv-hold） */
              if (DIAG.arxivHold) {
                const items = (arxivLastNotify && arxivLastNotify.items) || [];
                arxivSvc.setConfig({ keywords: ['graph neural network'] });
                notifyArxivPapers({
                  count: Math.max(1, items.length), freshCount: Math.max(1, items.length),
                  keywords: ['graph neural network'], items: items
                });
                await aw(800);
                let info = { 气泡: '没建出来' };
                if (bubbleWin && !bubbleWin.isDestroyed()) {
                  const bb = bubbleWin.getBounds();
                  /* 多屏 / 混合缩放时 DIP→物理像素没法简单乘 scaleFactor（实测点会落到桌面上），
                     所以把 Win32 的窗口句柄给外面，让它用 GetWindowRect 拿真实像素位置去点 */
                  let hwnd = 0;
                  try {
                    const buf = bubbleWin.getNativeWindowHandle();
                    hwnd = buf.readBigUInt64LE ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0);
                  } catch (e) { hwnd = 0; }
                  info = {
                    气泡窗口: bb.width + 'x' + bb.height + ' @ ' + bb.x + ',' + bb.y,
                    可见: bubbleWin.isVisible(),
                    置顶: bubbleWin.isAlwaysOnTop(),
                    句柄: hwnd
                  };
                }
                diagLog('arxiv-hold', info);
              }
            }
          }
          /* 重复待办自检：全部走真实弹窗 + 真实的「点勾完成」，看下一期排到哪天 */
          if (DIAG.repeat) {
            const wait7 = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
            const dayStr = function (ms) {
              const d = new Date(ms);
              const p = function (n) { return n < 10 ? '0' + n : String(n); };
              return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
                ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
            };
            /* 用真实弹窗建一条待办：text / 日期 / 规则（每周星期几、每月按几号或最后一天） */
            const addTodo = async function (text, dateStr, cfg) {
              const js = '(function(){try{' +
                'var g=function(id){return document.getElementById(id);};' +
                'g("btnAddTodo").click();' +
                'g("tdText").value=' + JSON.stringify(text) + ';' +
                'g("tdDate").value=' + JSON.stringify(dateStr) + ';' +
                'g("tdTime").value="09:30";' +
                'var seg=g("tdRepeat");seg.value=' + JSON.stringify(cfg.kind) + ';' +
                'seg.dispatchEvent(new Event("change",{bubbles:true}));' +
                (cfg.days ? ('var wd=g("tdWeekDays");' +
                  /* 先全关：切到「每周」时会自动预选「所选日期是周几」那一天，用例要的是干净数据 */
                  'Array.prototype.forEach.call(wd.querySelectorAll("button[data-dow]"),function(b){' +
                  'if(b.classList.contains("on"))b.click();});' +
                  '[' + cfg.days.join(',') + '].forEach(function(d){' +
                  'var b=wd.querySelector(\'button[data-dow="\'+d+\'"]\');' +
                  'if(b&&!b.classList.contains("on"))b.click();});') : '') +
                (cfg.monthMode === 'last'
                  ? 'var mm=g("tdMonthMode");var lb=mm.querySelector(\'button[data-mode="last"]\');if(lb)lb.click();'
                  : '') +
                (cfg.monthDay ? ('g("tdMonthDay").value="' + cfg.monthDay +
                  '";g("tdMonthDay").dispatchEvent(new Event("change",{bubbles:true}));') : '') +
                'var weekRowShown=!g("tdWeekRow").hidden, monthRowShown=!g("tdMonthRow").hidden;' +
                'var hint=g("tdRepeatHint").textContent;' +
                'g("tdSave").click();' +
                'var raw={};try{raw=JSON.parse(localStorage.getItem("kunkun.todos.v1")||"{}");}catch(e){}' +
                'var t=(raw.todos||[]).filter(function(x){return x.text===' + JSON.stringify(text) + ';})[0];' +
                'return {id:t?t.id:null, dueAt:t?t.dueAt:0, repeat:t?t.repeat:null,' +
                ' 每周行:weekRowShown, 每月行:monthRowShown, 提示:hint};' +
                '}catch(e){return {error:String(e&&e.message||e)};}})()';
              return win.webContents.executeJavaScript(js, true);
            };
            /* 点列表里那条的勾 = 完成这一期 */
            const complete = async function (id) {
              await win.webContents.executeJavaScript(
                '(function(){var row=document.querySelector(\'.todo-item[data-id="' + id + '"]\');' +
                'if(!row)return false;var b=row.querySelector(\'[data-role="done"]\');' +
                'if(!b)return false;b.click();return true;})()', true);
              await wait7(400);
              return win.webContents.executeJavaScript(
                '(function(){var raw={};try{raw=JSON.parse(localStorage.getItem("kunkun.todos.v1")||"{}");}catch(e){}' +
                'var t=(raw.todos||[]).filter(function(x){return x.id===' + JSON.stringify(id) + ';})[0];' +
                'return t?{dueAt:t.dueAt, done:!!t.done, repeat:t.repeat}:null;})()', true);
            };

            const cases = [
              { name: '每天', date: '2027-03-10', cfg: { kind: 'daily' }, want: '2027-03-11' },
              { name: '每周一', date: '2027-03-10', cfg: { kind: 'weekly', days: [1] }, want: '2027-03-15' },
              /* ⚠️ 这两条是这次讨论的核心：31 号碰上只有 28 天的 2 月，一个跳过、一个落到月末 */
              { name: '每月31号', date: '2027-01-31', cfg: { kind: 'monthly', monthDay: 31 }, want: '2027-03-31' },
              { name: '每月最后一天', date: '2027-01-31', cfg: { kind: 'monthly', monthMode: 'last' }, want: '2027-02-28' },
              { name: '每年', date: '2027-03-15', cfg: { kind: 'yearly' }, want: '2028-03-15' },
              { name: '每年2月29', date: '2028-02-29', cfg: { kind: 'yearly' }, want: '2032-02-29' }
            ];
            const rows2 = [];
            for (let i = 0; i < cases.length; i++) {
              const c = cases[i];
              const made = await addTodo('【重复自检】' + c.name, c.date, c.cfg);
              await wait7(300);
              if (!made.id) { rows2.push({ 用例: c.name, 建失败: made }); continue; }
              const after = await complete(made.id);
              const got = after ? dayStr(after.dueAt).slice(0, 10) : '(空)';
              rows2.push({
                用例: c.name,
                建在: c.date,
                规则: JSON.stringify(made.repeat),
                弹窗提示: made.提示,
                行显示: { 每周行: made.每周行, 每月行: made.每月行 },
                下一期: got,
                期望: c.want,
                对不对: got === c.want,
                完成状态清了吗: after ? after.done === false : null
              });
              await wait7(200);
            }
            diagLog('repeat-1-推进规则', rows2.filter(function (r) { return r.用例; }));

            /* 顺手验：重复待办在日历里带 🔁，当天清单里写明规则 */
            const repTodos = await win.webContents.executeJavaScript(
              '(function(){var raw={};try{raw=JSON.parse(localStorage.getItem("kunkun.todos.v1")||"{}");}catch(e){}' +
              'return (raw.todos||[]).filter(function(t){return t.repeat;}).length;})()', true);
            const badges = await win.webContents.executeJavaScript(
              '(function(){var b=document.querySelectorAll("#todoList .rep-badge");' +
              'return {列表标签数:b.length, 第一个:b.length?b[0].textContent:"(无)"};})()', true);
            diagLog('repeat-2-列表标签', { 带重复的待办数: repTodos, 标签: badges });

            /* 清掉自检造的数据，别污染后面的步骤 */
            await win.webContents.executeJavaScript(
              '(function(){var raw={};try{raw=JSON.parse(localStorage.getItem("kunkun.todos.v1")||"{}");}catch(e){}' +
              'raw.todos=(raw.todos||[]).filter(function(t){return String(t.text).indexOf("【重复自检】")!==0;});' +
              'localStorage.setItem("kunkun.todos.v1",JSON.stringify(raw));return true;})()', true);
          }
          /* 开机恢复桌面日历时的 Z 序自检：日历不许压在主界面上、也不许抢焦点 */
          if (DIAG.calstart) {
            const wait6 = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
            diagLog('calstart-1-开之前', {
              主界面可见: win.isVisible(),
              主界面聚焦: win.isFocused(),
              日历: (calWin && !calWin.isDestroyed()) ? '已存在' : '还没建'
            });
            /* 走的正是开机那条路：主界面渲染进程把 calOn 推上来 → setCalOn(true, false) */
            setCalOn(true, false);
            await wait6(2000);
            const order = await windowZOrder();
            const lines = order.split('\n').filter(function (s) { return s.trim(); });
            const idxOf = function (kw) {
              for (let i = 0; i < lines.length; i++) {
                if (lines[i].indexOf(kw) >= 0) return parseInt(lines[i].split('|')[0], 10);
              }
              return -1;
            };
            /* Z 序数字越小越靠上。日历窗的标题来自 cal.html 里的 <title>，
               是 desktop-calendar（不是 BrowserWindow 的 title），用这个认它 */
            const calIdx = idxOf('desktop-calendar');
            const mainIdx = (function () {
              for (let i = 0; i < lines.length; i++) {
                if (lines[i].indexOf('desktop-calendar') >= 0) continue;
                if (lines[i].indexOf('desktop-pet') >= 0) continue;
                return parseInt(lines[i].split('|')[0], 10);
              }
              return -1;
            })();
            diagLog('calstart-2-开之后', {
              Z序清单: lines,
              日历的Z序位: calIdx,
              主界面的Z序位: mainIdx,
              主界面在日历上面: mainIdx >= 0 && calIdx >= 0 && mainIdx < calIdx,
              日历抢焦点了吗: (calWin && !calWin.isDestroyed()) ? calWin.isFocused() : null,
              主界面还聚焦吗: win.isFocused()
            });
          }
          /* 主界面「推到屏幕外」自检：能推出去、必须留一条边、能被叫回来。
             ⚠️ 只上下推、x 方向位移保持 0：这台机器两块屏是左右排的，
             往右推会把窗口推到副屏上（那不算「推出屏幕」），测不出东西。 */
          if (DIAG.park) {
            const wait5 = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
            const wa0 = screen.getPrimaryDisplay().workArea;
            win.setBounds({
              x: Math.round(wa0.x + (wa0.width - 1180) / 2),
              y: Math.round(wa0.y + 60), width: 1180, height: 849
            });
            await wait5(700);
            const b0 = win.getBounds();
            const cx = b0.x + Math.floor(b0.width / 2);
            const phys = function (r) { return screen.dipToScreenRect(null, r); };
            const pushY = async function (targetY) {
              ipcMain.emit('drag-start', {}, { x: cx, y: b0.y + 10 });
              ipcMain.emit('drag-move', {}, { x: cx, y: targetY });
              ipcMain.emit('drag-end', {}, {});
              await wait5(500);
              return win.getBounds();
            };
            /* 往下推：窗口大部分沉到工作区下面 */
            const b1 = await pushY(wa0.y + wa0.height + 5000);
            const p1 = phys(b1), wp = phys(wa0);
            const visBottom = (wp.y + wp.height) - p1.y;
            diagLog('park-1-往下推', {
              归位: b0.x + ',' + b0.y,
              推出去后: b1.x + ',' + b1.y,
              还露在屏里的高: visBottom,
              期望露多少: WIN_EDGE_KEEP,
              留够能抓的边了吗: visBottom >= WIN_EDGE_KEEP - 10,
              确实推出屏了: p1.y > wp.y + 200
            });
            /* 再往上推：只留最上面一条 */
            const b2 = await pushY(wa0.y - 5000);
            const p2 = phys(b2);
            const visTop = (p2.y + p2.height) - wp.y;
            diagLog('park-2-往上推', {
              推出去后: b2.x + ',' + b2.y,
              还露在屏里的高: Math.min(p2.height, visTop),
              留够能抓的边了吗: Math.min(p2.height, visTop) >= WIN_EDGE_KEEP - 10
            });
            /* 托盘 / 菜单那条路叫回来：必须整窗回到屏内 */
            const rescued = rescueWindowIntoView();
            await wait5(400);
            const b3 = win.getBounds();
            diagLog('park-3-叫回来', {
              触发了拉回: rescued,
              拉回后: b3.x + ',' + b3.y,
              完全在屏内: b3.x >= wa0.x && b3.y >= wa0.y &&
                b3.x + b3.width <= wa0.x + wa0.width && b3.y + b3.height <= wa0.y + wa0.height
            });
          }
          /* 只排查阴影用：把日历窗摆在主屏正中停住，再用 GDI 截屏把「窗口四周」
             一起截下来 —— 那圈直角黑影到底是窗口自己的投影还是 CSS 阴影，看一眼就知道。 */
          if (DIAG.calshadow) {
            const wait3 = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
            const d0 = screen.getPrimaryDisplay();
            const wa0 = d0.workArea;
            const box0 = calWindowBox(wa0);
            /* 先垫一块深灰底板：卡片到底多透、外面有没有投影，一下就算得出来
               （底板 RGB 58，如果卡片是 97% 白，卡片区应该接近 249；
                 如果明显偏灰，说明窗口/页面被整体做了透明） */
            let backdrop = null;
            try {
              backdrop = new BrowserWindow({
                x: wa0.x, y: wa0.y, width: wa0.width, height: wa0.height,
                frame: false, backgroundColor: '#3a3a3a', hasShadow: false,
                resizable: false, skipTaskbar: true, focusable: false, show: false,
                webPreferences: { contextIsolation: true, nodeIntegration: false }
              });
              backdrop.loadURL('data:text/html,<body style="margin:0;background:%233a3a3a"></body>');
              backdrop.showInactive();
              await wait3(600);
            } catch (e0) { diagLog('calshadow-backdrop-error', String(e0 && e0.message || e0)); }
            setCalOn(true, true);
            await wait3(1600);
            if (calWin && !calWin.isDestroyed()) {
              calWin.setBounds({
                x: Math.round(wa0.x + (wa0.width - box0.width) / 2),
                y: Math.round(wa0.y + (wa0.height - box0.height) / 2),
                width: box0.width, height: box0.height
              });
              await wait3(1200);
              const b = calWin.getBounds();
              const pr = screen.dipToScreenRect(null, b);
              const m = 60;
              const out = path.join(__dirname, '.diag', 'calshadow.png');
              const ps = [
                'Add-Type -AssemblyName System.Drawing',
                '$w=' + (pr.width + m * 2) + ';$h=' + (pr.height + m * 2),
                '$bmp=New-Object System.Drawing.Bitmap($w,$h)',
                '$g=[System.Drawing.Graphics]::FromImage($bmp)',
                '$g.CopyFromScreen(' + (pr.x - m) + ',' + (pr.y - m) + ',0,0,$bmp.Size)',
                '$bmp.Save("' + out + '",[System.Drawing.Imaging.ImageFormat]::Png)',
                '$g.Dispose();$bmp.Dispose()',
                'Write-Output "CAPTURED"'
              ].join('\n');
              diagLog('calshadow', {
                窗口DIP: b.x + ',' + b.y + ' ' + b.width + 'x' + b.height,
                窗口物理: pr.x + ',' + pr.y + ' ' + pr.width + 'x' + pr.height,
                截图: out,
                hasShadow: (typeof calWin.hasShadow === 'function') ? calWin.hasShadow() : '(无此 API)'
              });
              psRun(ps, function (e, o) {
                diagLog('calshadow-shot', { err: String(e || ''), out: String(o || '').trim() });
              });
              await wait3(2500);
            }
          }
          /* ============ 桌面日历：放大缩小 + 固定（--diag-calzoom） ============
             都走真按钮：点「＋/−」看窗口和网页缩放真的变了没有；
             点「🔒」之后用真实指针事件去拖、去点格子，验证拖不动、也点不开。 */
          /* ============ 弹窗冲突：多条待办同时到点（--diag-alert） ============
             场景就是用户问的：一条弹窗还挂着，别的又到点了。
             这里用真实数据喂进 localStorage：3 条同时到点 → 应该【合并成一条】弹；
             点「逐条看」→ 一条条弹且带「还有 N 条」提示；再验「全部完成」一把勾掉。 */
          /* ============ 提醒音乐（--diag-music） ============
             分阶段跑：换自定义音乐 / 换坏路径 / 还原自带，每一步都要 reload 页面，
             而 reload 会让整个自检重跑一次 —— 用 diagMusicStage 记住从哪继续。 */
          if (DIAG.music) {
            /* 换阶段：第一次 reload 后这一轮就结束（扔哨兵让外层别退出），
               新的一轮自检会从 did-finish-load 重新进来，按 diagMusicStage 接着跑。 */
            const musicReload = function () {
              diagMusicStage++;
              win.webContents.reload();
              const stop = new Error('diag-restart');
              stop.diagRestart = true;
              throw stop;
            };
            const setSrcInStorage = function (p) {
              return '(function(){var raw={};try{raw=JSON.parse(localStorage.getItem("kunkun.settings.v1")||"{}");}catch(e){}' +
                'raw.musicSrc=' + JSON.stringify(p) + ';localStorage.setItem("kunkun.settings.v1",JSON.stringify(raw));return true;})()';
            };
            const audioNow = function (extra) {
              return '(async function(){var a=document.getElementById("alertMusic");' +
                'var out={页面src:a?a.getAttribute("src"):null, 设置里显示:(document.getElementById("musicPath")||{}).textContent};' +
                'if(!a) return out;' + (extra || '') + 'return out;})()';
            };
            /* 等音频把元数据读出来（或报错），最多 3 秒 */
            const waitMeta =
              'await new Promise(function(r){ if(a.readyState>=1) return r();' +
              '  a.addEventListener("loadedmetadata",function(){r();},{once:true});' +
              '  a.addEventListener("error",function(){r();},{once:true}); setTimeout(r,3000); });' +
              'out.就绪状态=a.readyState; out.时长秒=Math.round((a.duration||0)*10)/10;' +
              'out.媒体错误=a.error?a.error.code:null;';
            const tryPlay =
              'try{ await a.play(); await new Promise(function(r){setTimeout(r,700);});' +
              '  out.能播放=!a.paused; out.播了秒数=Math.round(a.currentTime*10)/10; a.pause(); a.currentTime=0;' +
              '}catch(e){ out.能播放=false; out.播放错误=String((e&&e.name)||e); }';

            if (diagMusicStage === 0) {
              diagLog('music-1-音频元素', await win.webContents.executeJavaScript(
                '(function(){var a=document.getElementById("alertMusic");if(!a)return {error:"页面里没有 audio 元素"};' +
                'var c=document.getElementById("chkMusic");' +
                'return {音频地址:a.getAttribute("src"),循环:a.loop,预加载:a.preload,音量:a.volume,' +
                ' 就绪状态:a.readyState,时长秒:Math.round((a.duration||0)*10)/10,' +
                ' 默认勾选:c?c.checked:null, 勾选框文字:(c&&c.parentElement)?c.parentElement.textContent.trim():null,' +
                ' 有选歌按钮:!!document.getElementById("btnPickMusic"), 有恢复按钮:!!document.getElementById("btnResetMusic"),' +
                ' 说明文字:(document.getElementById("musicPath")||{}).textContent};})()', true));
              /* 关键：Electron 没配 autoplayPolicy 时默认允许无用户手势播放。
                 这里真播一下，看 paused 有没有变 false —— 不允许的话提醒时根本放不出声。 */
              diagLog('music-2-能不能播放', await win.webContents.executeJavaScript(
                '(async function(){var a=document.getElementById("alertMusic");' +
                'try{ a.currentTime=0; await a.play(); }catch(e){ return {能播放:false,错误:String((e&&e.name)||e)}; }' +
                'await new Promise(function(r){setTimeout(r,700);});' +
                'var t=a.currentTime, paused=a.paused; a.pause(); a.currentTime=0;' +
                'return {能播放:!paused, 播了秒数:Math.round(t*10)/10};})()', true));
              diagLog('music-3-设置默认值', await win.webContents.executeJavaScript(
                '(function(){var raw={};try{raw=JSON.parse(localStorage.getItem("kunkun.settings.v1")||"{}");}catch(e){}' +
                'return {存着的music:raw.music, 存着的musicSrc:raw.musicSrc, 勾选框:(document.getElementById("chkMusic")||{}).checked};})()', true));

              /* 自定义音乐：真拿一个「路径里有中文和空格」的文件塞进设置，刷新页面看能不能用。
                 这覆盖最可能踩的坑：中文路径 / 空格 / file:// 转义 / CSP 拦不拦。 */
              let tmpMusic = '';
              try {
                tmpMusic = path.join(app.getPath('temp'), 'kun 测试 音乐.mp3');
                fs.copyFileSync(path.join(__dirname, 'assets', 'music.mp3'), tmpMusic);
              } catch (e) {
                diagLog('music-4-自定义音乐', { 跳过: '临时文件准备失败: ' + String((e && e.message) || e) });
              }
              if (tmpMusic) {
                await win.webContents.executeJavaScript(setSrcInStorage(tmpMusic), true);
                await musicReload();
              }
            } else if (diagMusicStage === 1) {
              diagLog('music-4-自定义音乐', await win.webContents.executeJavaScript(
                audioNow(waitMeta + tryPlay), true));
              /* 再验「文件读不出来就退回自带」：路径指向一个不存在的文件 */
              await win.webContents.executeJavaScript(
                setSrcInStorage(path.join(app.getPath('temp'), 'kun-没有这个文件.mp3')), true);
              await musicReload();
            } else if (diagMusicStage === 2) {
              diagLog('music-5-文件不存在时', await win.webContents.executeJavaScript(
                audioNow('await new Promise(function(r){setTimeout(r,2200);});' +
                  'out.就绪状态=a.readyState; out.媒体错误=a.error?a.error.code:null;' +
                  'out.存着的musicSrc=(function(){try{return JSON.parse(localStorage.getItem("kunkun.settings.v1")||"{}").musicSrc;}catch(e){return "读不出";}})();'),
                true));
              await win.webContents.executeJavaScript(setSrcInStorage(''), true);
              await musicReload();
            } else if (diagMusicStage === 3) {
              diagMusicStage = 4;                      // 收尾，别再重载了
              diagLog('music-6-还原自带', await win.webContents.executeJavaScript(
                audioNow(waitMeta), true));
            }
          }
          if (DIAG.alert) {
            const waitA = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
            const appJs = function (code) { return win.webContents.executeJavaScript(code, true); };
            const alertState = function () {
              return appJs('(function(){var o=document.getElementById("overlay");' +
                'var m=document.getElementById("alertMore");var b=document.getElementById("alertOneByOne");' +
                'return {弹窗开着吗:o?!o.hidden:null,' +
                ' 标题:document.getElementById("alertTitle").textContent,' +
                ' 正文:document.getElementById("alertDesc").textContent,' +
                ' 主按钮:document.getElementById("alertDone").textContent,' +
                ' 次按钮:document.getElementById("alertSnooze").textContent,' +
                ' 有逐条看按钮吗:b?!b.hidden:null,' +
                ' 还有几条提示:m&&!m.hidden?m.textContent:null};})()');
            };
            const seed = function (spec) {
              return appJs('(function(){var todos=' + JSON.stringify(spec) + ';' +
                'var ids=todos.map(function(t){return t.id;});' +
                'var cur={};try{cur=JSON.parse(localStorage.getItem("kunkun.todos.v1")||"{}");}catch(e){}' +
                'var list=(cur.todos||[]).filter(function(t){return ids.indexOf(t.id)<0;});' +
                'todos.forEach(function(t){list.push(t);});' +
                'cur.todos=list;cur.memos=cur.memos||[];' +
                'localStorage.setItem("kunkun.todos.v1",JSON.stringify(cur));' +
                'return list.length;})()');
            };
            const clean = function () {
              return appJs('(function(){var cur={};try{cur=JSON.parse(localStorage.getItem("kunkun.todos.v1")||"{}");}catch(e){}' +
                'cur.todos=(cur.todos||[]).filter(function(t){return String(t.id).indexOf("diagalert")<0;});' +
                'localStorage.setItem("kunkun.todos.v1",JSON.stringify(cur));return true;})()');
            };
            const mk = function (id, text, secAgo) {
              return { id: id, text: text, done: false, at: Date.now(),
                dueAt: Date.now() - secAgo * 1000, remindAt: Date.now() - secAgo * 1000, prio: 'mid' };
            };
            const reloadFor = async function () {
              /* ⚠️ reload 会再触发一次 did-finish-load → 整个自检会重跑。
                 所以用阶段位把「重载后从哪继续」记下来（下面 diagAlertStage 分支处理）。 */
              diagAlertStage++;
              win.webContents.reload();
              await new Promise(function (r) { setTimeout(r, 4500); });
            };

            if (diagAlertStage === 0) {
              diagAlertStage = 1;
              await clean();
              await seed([mk('diagalert1', '【自检】待办 1', 12),
                          mk('diagalert2', '【自检】待办 2', 12),
                          mk('diagalert3', '【自检】待办 3', 12)]);
              await reloadFor();                       // 重载后 diagAlertStage = 1 → 下一轮继续
            } else if (diagAlertStage === 1) {
              diagAlertStage = 2;
              await waitA(1200);
              /* ① 三条同时到点 → 应该合并成一条，并带「逐条看」 */
              const merged = await alertState();
              await appJs('document.getElementById("alertOneByOne").click(); true;');
              await waitA(1500);
              /* ② 逐条看 → 一条条弹，且带「还有 N 条」提示 */
              const seqA = await alertState();
              await appJs('document.getElementById("alertDone").click(); true;');
              await waitA(1500);
              const seqB = await alertState();
              diagLog('alert-1-三条同时到点(合并)', merged);
              diagLog('alert-2-逐条看', { 逐条看后第一条: seqA, 处理完再弹一条: seqB });
              /* ③ 「全部完成」：这一批一起勾掉（还在等的那条也一起） */
              const beforeDone = await appJs(
                '(function(){var raw={};try{raw=JSON.parse(localStorage.getItem("kunkun.todos.v1")||"{}");}catch(e){}' +
                'return (raw.todos||[]).filter(function(t){return String(t.id).indexOf("diagalert")===0;})' +
                '.map(function(t){return t.id+":"+(t.done?"已完成":"没完成");});})()');
              await appJs('(function(){var b=document.getElementById("alertSnooze");' +
                'if(b&&!document.getElementById("overlay").hidden)b.click();return true;})()');
              await waitA(600);
              /* 剩下的挂起条目：直接走「合并弹窗 + 全部完成」这条路 */
              const left = await appJs(
                '(function(){var raw={};try{raw=JSON.parse(localStorage.getItem("kunkun.todos.v1")||"{}");}catch(e){}' +
                'var list=(raw.todos||[]).filter(function(t){return String(t.id).indexOf("diagalert")===0&&!t.done;});' +
                'list.forEach(function(t){t.remindAt=Date.now()-1000;});' +
                'localStorage.setItem("kunkun.todos.v1",JSON.stringify(raw));' +
                'return list.length;})()');
              await waitA(2200);
              const merged2 = await alertState();
              await appJs('(function(){var b=document.getElementById("alertDone");' +
                'if(b&&!document.getElementById("overlay").hidden)b.click();return true;})()');
              await waitA(1400);
              const afterDone = await appJs(
                '(function(){var raw={};try{raw=JSON.parse(localStorage.getItem("kunkun.todos.v1")||"{}");}catch(e){}' +
                'return (raw.todos||[]).filter(function(t){return String(t.id).indexOf("diagalert")===0;})' +
                '.map(function(t){return t.id+":"+(t.done?"已完成":"没完成");});})()');
              await clean();
              diagLog('alert-3-全部完成', {
                逐条看之前的状态: beforeDone,
                重新到点的条数: left,
                第二次合并弹窗: merged2,
                全部完成之后: afterDone,
                弹窗还开着吗: (await alertState()).弹窗开着吗
              });
              diagLog('alert-4-清理', { 说明: '自检数据已清掉' });
            }
          }
          if (DIAG.calzoom) {
            const waitZ = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
            const calJs = function (code) { return calWin.webContents.executeJavaScript(code, true); };
            /* 读页面上跟缩放/固定有关的状态 */
            const readState = function () {
              return calJs('(function(){var card=document.getElementById("cal");' +
                'var cs=card?getComputedStyle(card):null;' +
                'return {百分比:document.getElementById("zoomVal")?document.getElementById("zoomVal").textContent:null,' +
                ' 锁定图标:document.getElementById("btnLock")?document.getElementById("btnLock").textContent:null,' +
                ' body锁定:document.body.classList.contains("locked"),' +
                ' 加号禁用:document.getElementById("btnZoomIn")?document.getElementById("btnZoomIn").disabled:null,' +
                ' 减号禁用:document.getElementById("btnZoomOut")?document.getElementById("btnZoomOut").disabled:null,' +
                ' 卡片CSS宽:cs?cs.width:null,卡片CSS高:cs?cs.height:null,' +
                /* ⚠️ --fit 这种带横杠的键名必须加引号，不然整个脚本 SyntaxError */
                ' fit变量:getComputedStyle(document.documentElement).getPropertyValue("--fit").trim(),' +
                ' 面板露出来了吗:(function(){var p=document.getElementById("panel");return p?!p.hidden:null;})()};})()');
            };

            setCalOn(true, true);
            /* ⚠️ 必须等日历窗真的加载完再注入脚本：窗口刚建出来时 executeJavaScript
               会直接抛「Script failed to execute」（自检里踩过这个坑）。 */
            const waitCalReady = async function (limit) {
              const t0 = Date.now();
              while (Date.now() - t0 < limit) {
                if (calWin && !calWin.isDestroyed() && !calWin.webContents.isLoading()) return true;
                await waitZ(200);
              }
              return false;
            };
            const ready = await waitCalReady(15000);
            if (!ready || !calWin || calWin.isDestroyed()) {
              diagLog('calzoom-error', { 说明: '日历窗没起来或一直没加载完', ready: ready });
            } else {
              try {
              const boundsOf = function () { const b = calWin.getBounds(); return b.width + 'x' + b.height; };
              /* 真正生效的缩放（网页缩放系数）由主进程侧读，页面里读不到 */
              const zoomOf = function () {
                try { return Math.round(calWin.webContents.getZoomFactor() * 1000) / 1000; } catch (e) { return null; }
              };
              const b0 = boundsOf();
              const s0 = await readState();

              /* ① 点两次「＋」（100% → 110% → 120%） */
              await calJs('document.getElementById("btnZoomIn").click(); true;');
              await waitZ(700);
              await calJs('document.getElementById("btnZoomIn").click(); true;');
              await waitZ(900);
              const s1 = await readState();
              diagLog('calzoom-1-放大', {
                窗口: b0 + ' → ' + boundsOf(),
                实际缩放: zoomOf(),
                放大前: s0, 放大后: s1,
                窗口跟着变大了吗: b0 !== boundsOf()
              });

              /* ② 一直点到顶：应该停在 150%，加号变灰 */
              for (let i = 0; i < 6; i++) { await calJs('document.getElementById("btnZoomIn").click(); true;'); await waitZ(260); }
              await waitZ(700);
              const sTop = await readState();
              diagLog('calzoom-2-放到最大', { 窗口: boundsOf(), 实际缩放: zoomOf(), 状态: sTop });

              /* ③ 一直点到最小：应该停在 80%，减号变灰 */
              for (let i = 0; i < 10; i++) { await calJs('document.getElementById("btnZoomOut").click(); true;'); await waitZ(260); }
              await waitZ(700);
              const sMin = await readState();
              diagLog('calzoom-3-缩到最小', { 窗口: boundsOf(), 实际缩放: zoomOf(), 状态: sMin });

              /* ④ 回到 100%（两下 ＋），顺便把位置记下来 */
              await calJs('document.getElementById("btnZoomIn").click(); true;');
              await waitZ(400);
              await calJs('document.getElementById("btnZoomIn").click(); true;');
              await waitZ(800);
              const s100 = await readState();
              const b100 = calWin.getBounds();

              /* ⑤ 不锁定时：拖一下应该真的能动（先证明拖动本身是好的） */
              const dragJs = function (pid, dx, dy) {
                return calJs('(function(){var c=document.getElementById("cal");' +
                  'var r=c.getBoundingClientRect();var x=r.left+40,y=r.top+40;' +
                  'function ev(t,px,py){return new PointerEvent(t,{bubbles:true,cancelable:true,button:0,pointerId:' + pid + ',' +
                  'screenX:px,screenY:py,clientX:x,clientY:y});}' +
                  'c.dispatchEvent(ev("pointerdown",x,y));' +
                  'c.dispatchEvent(ev("pointermove",x+' + dx + ',y+' + dy + '));' +
                  'c.dispatchEvent(ev("pointerup",x+' + dx + ',y+' + dy + '));return true;})()');
              };
              await dragJs(11, 90, 70);
              await waitZ(700);
              const bMoved = calWin.getBounds();
              const panelBeforeLock = await calJs(
                '(function(){var p=document.getElementById("panel");return p?!p.hidden:null;})()');

              /* ⑥ 锁定：点 🔒 → 再拖一次（不该动）→ 再点格子（不该开清单） */
              await calJs('document.getElementById("btnLock").click(); true;');
              await waitZ(800);
              const sLock = await readState();
              const bLockPos = { x: calWin.getBounds().x, y: calWin.getBounds().y };
              await dragJs(12, 90, 70);
              await waitZ(700);
              const bAfterLockDrag = { x: calWin.getBounds().x, y: calWin.getBounds().y };
              const clickCell = await calJs('(function(){var c=document.querySelector("#grid .cell");' +
                'if(!c)return {error:"格子里没东西"};' +
                'var r=c.getBoundingClientRect();var x=r.left+8,y=r.top+8;' +
                'function ev(t){return new PointerEvent(t,{bubbles:true,cancelable:true,button:0,pointerId:13,screenX:x,screenY:y,clientX:x,clientY:y});}' +
                'c.dispatchEvent(ev("pointerdown"));c.dispatchEvent(ev("pointerup"));' +
                'return {点的是:c.dataset.key||null};})()');
              await waitZ(600);
              const panelAfterLock = await calJs(
                '(function(){var p=document.getElementById("panel");' +
                'return {面板露出来了吗:p?!p.hidden:null, 选中的那天:(document.querySelector("#grid .cell.sel")||{}).dataset' +
                ' ? document.querySelector("#grid .cell.sel").dataset.key : null};})()');
              diagLog('calzoom-4-固定', {
                解锁时能拖动吗: (bMoved.x !== b100.x || bMoved.y !== b100.y),
                锁之前面板是关着的吗: panelBeforeLock === false,
                锁定状态: sLock,
                锁定后拖动: { 拖之前: bLockPos.x + ',' + bLockPos.y, 拖之后: bAfterLockDrag.x + ',' + bAfterLockDrag.y },
                锁定后没被拖动吗: (bAfterLockDrag.x === bLockPos.x && bAfterLockDrag.y === bLockPos.y),
                锁定后点格子: clickCell,
                锁定后点开清单了吗: panelAfterLock.面板露出来了吗 === true
              });

              /* ⑥b 固定之后，头部那一排按钮（含 ✕）应该全都按不动，只有 🔒 能按 */
              const headBefore = await calJs(
                '(function(){var t=document.getElementById("title");' +
                'var d=document.documentElement.getAttribute("data-theme");' +
                'return {月份:t?t.textContent.trim():null,主题:d};})()');
              /* 挨个去点：翻月 / 今天 / 缩放 / 主题 / ＋ 新增待办 / ⚙ 设置 / ✕ 隐藏 */
              const poke = await calJs('(function(){' +
                'var ids=["btnPrev","btnNext","btnToday","btnZoomIn","btnZoomOut","btnTheme","btnAdd","btnSet","btnHide"];' +
                'var hit=[];ids.forEach(function(id){var b=document.getElementById(id);' +
                'if(!b){hit.push(id+":缺");return;}' +
                'b.click();hit.push(id+":"+(b.disabled?"本来就禁用":"点了"));});' +
                'return hit;})()');
              await waitZ(800);
              const headAfter = await calJs(
                '(function(){var t=document.getElementById("title");' +
                'var d=document.documentElement.getAttribute("data-theme");' +
                'var lb=document.getElementById("btnLock");' +
                'return {月份:t?t.textContent.trim():null,主题:d,' +
                ' 缩放:document.getElementById("zoomVal").textContent,' +
                ' 头按钮灰度:getComputedStyle(document.getElementById("btnSet")).opacity,' +
                ' 锁按钮还是亮的吗:(lb?getComputedStyle(lb).opacity:null)};})()');
              /* 备忘录还能加：点左栏 ＋ → 输入行应该出现 */
              const memoAdd = await calJs('(function(){var b=document.getElementById("btnAddMemo");' +
                'if(!b)return {error:"没有备忘录＋"};b.click();' +
                'var row=document.getElementById("memoNewRow");' +
                'return {输入行露出来了吗:row?!row.hidden:null};})()');
              await waitZ(400);
              diagLog('calzoom-4b-锁住时头部按钮', {
                点的过程: poke,
                锁之前: headBefore, 锁之后: headAfter,
                月份没变: headBefore.月份 === headAfter.月份,
                主题没变: headBefore.主题 === headAfter.主题,
                缩放没变: headAfter.缩放 === '100%',
                头按钮变灰了吗: parseFloat(headAfter.头按钮灰度) < 0.6,
                锁按钮还亮着: parseFloat(headAfter.锁按钮还是亮的吗) > 0.6,
                备忘录还能加吗: memoAdd.输入行露出来了吗 === true
              });
              /* 截一张「锁住之后」的图：头部按钮全灰、🔒 高亮、左栏备忘录还能写 */
              try {
                await waitZ(300);
                fs.writeFileSync(path.join(__dirname, '.diag', 'cal-locked.png'),
                  (await calWin.webContents.capturePage()).toPNG());
              } catch (eShotL) { diagLog('calzoom-shot-lock-error', String(eShotL && eShotL.message || eShotL)); }
              /* 收尾：再点一下左栏 ＋ 把刚展开的输入行收掉（它是开关式的） */
              await calJs('(function(){var b=document.getElementById("btnAddMemo");if(b)b.click();return true;})()');
              await waitZ(300);

              /* ⑦ 解锁：拖动又能动、点格子又能开清单 */
              await calJs('document.getElementById("btnLock").click(); true;');
              await waitZ(800);
              const sUnlock = await readState();
              const bBefore2 = calWin.getBounds();
              await dragJs(14, -70, -50);
              await waitZ(700);
              const bAfter2 = calWin.getBounds();
              const clickCell2 = await calJs('(function(){var c=document.querySelector("#grid .cell");' +
                'var r=c.getBoundingClientRect();var x=r.left+8,y=r.top+8;' +
                'function ev(t){return new PointerEvent(t,{bubbles:true,cancelable:true,button:0,pointerId:15,screenX:x,screenY:y,clientX:x,clientY:y});}' +
                'c.dispatchEvent(ev("pointerdown"));c.dispatchEvent(ev("pointerup"));' +
                'return {点的是:c.dataset.key||null};})()');
              await waitZ(600);
              const panelAfterUnlock = await calJs(
                '(function(){var p=document.getElementById("panel");' +
                'return {面板露出来了吗:p?!p.hidden:null};})()');
              diagLog('calzoom-5-解锁', {
                解锁状态: sUnlock,
                又能拖动了吗: (bAfter2.x !== bBefore2.x || bAfter2.y !== bBefore2.y),
                点格子: clickCell2,
                点开清单了吗: panelAfterUnlock.面板露出来了吗 === true
              });

              /* ⑦b 缩放之后，鼠标事件的 screenX 还准不准？（拖动跟不跟得上光标）
                 用真实输入管线注入事件（sendInputEvent），让页面把收到的
                 screenX / clientX 报回来，再和窗口实际位移对照。 */
              await calJs('document.getElementById("btnZoomIn").click(); true;');
              await waitZ(400);
              await calJs('document.getElementById("btnZoomIn").click(); true;');
              await waitZ(900);
              const zNow = zoomOf();
              await calJs('(function(){window.__pt=null;' +
                'document.addEventListener("pointermove",function(e){' +
                'window.__pt={screenX:e.screenX,screenY:e.screenY,clientX:e.clientX,clientY:e.clientY};},true);' +
                'return true;})()');
              const bBefore3 = calWin.getBounds();
              calWin.webContents.sendInputEvent({ type: 'mouseDown', x: 200, y: 200, button: 'left', clickCount: 1 });
              await waitZ(120);
              calWin.webContents.sendInputEvent({ type: 'mouseMove', x: 400, y: 350, button: 'left' });
              await waitZ(250);
              calWin.webContents.sendInputEvent({ type: 'mouseUp', x: 400, y: 350, button: 'left', clickCount: 1 });
              await waitZ(500);
              const bAfter3 = calWin.getBounds();
              const ptSeen = await calJs('window.__pt');
              diagLog('calzoom-7b-缩放后拖动跟不跟得上', {
                实际缩放: zNow,
                注入的移动: '窗口内 200,200 → 400,350（即 +200,+150）',
                页面收到的事件: ptSeen,
                窗口位置: bBefore3.x + ',' + bBefore3.y + ' → ' + bAfter3.x + ',' + bAfter3.y,
                窗口实际位移: (bAfter3.x - bBefore3.x) + ',' + (bAfter3.y - bBefore3.y)
              });

              /* ⚠️ 贴边测试前先把它挪回主屏：前面几段测试可能已经把窗口拖到副屏去了，
                 那样「距工作区左上角」就是拿副屏的工作区在量，数字毫无意义（自检里真踩过）。
                 所以这里用 let 重新取一次工作区。 */
              let waNow = screen.getDisplayMatching(calWin.getBounds()).workArea;
              let wTL = screen.dipToScreenRect(null, waNow);
              const phys = function (r) { return screen.dipToScreenRect(null, r); };
              const gaps = function () {
                const p = phys(calWin.getBounds()), w = wTL;
                return {
                  左: (p.x - w.x), 上: (p.y - w.y),
                  右: (w.x + w.width) - (p.x + p.width),
                  下: (w.y + w.height) - (p.y + p.height)
                };
              };
              const dragTo = async function (tx, ty) {
                const b = calWin.getBounds();
                const from = { x: b.x + Math.floor(b.width / 2), y: b.y + Math.floor(b.height / 2) };
                ipcMain.emit('cal-win-drag-start', {}, from);
                ipcMain.emit('cal-win-drag-move', {}, { x: tx, y: ty });
                ipcMain.emit('cal-win-drag-end', {}, {});
                await waitZ(500);
              };
              /* 先把窗口挪到主屏中间，再据它重新取一次工作区和物理换算 */
              const pri = screen.getPrimaryDisplay().workArea;
              await dragTo(pri.x + 200, pri.y + 200);
              waNow = screen.getDisplayMatching(calWin.getBounds()).workArea;
              wTL = screen.dipToScreenRect(null, waNow);

              /* ⑦d 真鼠标拖动（SendInput 按住左键）：这是唯一能复现「拖不到屏幕边缘」的路子。
                 先记录页面收到的 screenX/clientX，再对照窗口实际位移。 */
              try {
                await calJs('document.getElementById("btnZoomIn").click(); true;');   // 回到 120%
                await waitZ(400);
                await calJs('document.getElementById("btnZoomIn").click(); true;');
                await waitZ(800);
                /* 把日历先放到屏幕中间偏右下，留出向左上拖的空间 */
                const waD = screen.getDisplayMatching(calWin.getBounds()).workArea;
                const bD = calWin.getBounds();
                ipcMain.emit('cal-win-drag-start', {}, { x: bD.x + 40, y: bD.y + 40 });
                ipcMain.emit('cal-win-drag-move', {},
                  { x: waD.x + 500, y: waD.y + 300 });
                ipcMain.emit('cal-win-drag-end', {}, {});
                await waitZ(500);
                /* ⚠️ 真鼠标会被压在它上面的窗口挡掉（合成事件不会）。
                   自检里主界面是显示着的，所以先把日历提到最前，不然 pointerdown 根本到不了它。 */
                try { calWin.moveTop(); } catch (eTop) { }
                await waitZ(400);
                await calJs('(function(){window.__pts=[];' +
                  'document.addEventListener("pointermove",function(e){' +
                  'window.__pts.push({sx:e.screenX,sy:e.screenY,cx:e.clientX,cy:e.clientY});},true);' +
                  'return true;})()');
                const bPre = calWin.getBounds();
                const gPre = phys(bPre);
                /* 起点：窗口内部靠中间；终点：屏幕左上角外侧（想把窗口顶到角上） */
                const fromX = gPre.x + 300, fromY = gPre.y + 240;
                const toX = gPre.x - 400, toY = gPre.y - 400;
                const cap = require('child_process').execFileSync('powershell.exe', [
                  '-NoProfile', '-ExecutionPolicy', 'Bypass',
                  '-File', path.join(__dirname, '.diag', 'mouse-drag.ps1'),
                  '-x1', String(fromX), '-y1', String(fromY),
                  '-x2', String(Math.max(1, toX)), '-y2', String(Math.max(1, toY))
                ], { encoding: 'utf8' });
                await waitZ(700);
                const bPost = calWin.getBounds();
                const pts = await calJs('window.__pts');
                const first = pts && pts.length ? pts[0] : null;
                const last = pts && pts.length ? pts[pts.length - 1] : null;
                diagLog('calzoom-7d-真鼠标拖动', {
                  脚本: String(cap).trim(),
                  缩放: zoomOf(),
                  鼠标物理移动: (fromX + ',' + fromY) + ' → ' + Math.max(1, toX) + ',' + Math.max(1, toY) +
                    '（即 ' + (Math.max(1, toX) - fromX) + ',' + (Math.max(1, toY) - fromY) + ' 物理像素）',
                  窗口DIP: bPre.x + ',' + bPre.y + ' → ' + bPost.x + ',' + bPost.y,
                  窗口DIP位移: (bPost.x - bPre.x) + ',' + (bPost.y - bPre.y),
                  期望DIP位移: '≈ 鼠标物理位移 / 1.5',
                  页面收到的事件数: pts ? pts.length : 0,
                  第一个事件: first, 最后一个事件: last,
                  页面screenX位移: (first && last) ? ((last.sx - first.sx) + ',' + (last.sy - first.sy)) : null,
                  页面clientX位移: (first && last) ? ((last.cx - first.cx) + ',' + (last.cy - first.cy)) : null,
                  最终距工作区左上角_物理: (function () {
                    const p = phys(bPost);
                    return (p.x - wTL.x) + ',' + (p.y - wTL.y);
                  })()
                });
              } catch (eM) { diagLog('calzoom-7d-error', String(eM && eM.message || eM)); }

                /* 先记下窗口和屏幕，再用「合成 pointerdown（screenX 取真光标位置）
                   + 真实光标移动」的方式拖一把：真实鼠标坐标系 + 不受窗口层级影响。 */
                const bStart = calWin.getBounds();
                const cur0 = screen.getCursorScreenPoint();
                const moveScript = path.join(__dirname, '.diag', 'mouse-move.ps1');
                require('child_process').execFileSync('powershell.exe', [
                  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', moveScript,
                  '-fx', String(bStart.x + 300), '-fy', String(bStart.y + 240),
                  '-x', String(bStart.x + 300), '-y', String(bStart.y + 240), '-steps', '3', '-hold', '60'
                ], { encoding: 'utf8' });
                await waitZ(300);
                const cur1 = screen.getCursorScreenPoint();
                await calJs('(function(){var c=document.getElementById("cal");' +
                  'c.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,cancelable:true,button:0,pointerId:77,' +
                  'screenX:' + cur1.x + ',screenY:' + cur1.y + ',clientX:200,clientY:200}));return true;})()');
                await waitZ(200);
                /* 真光标一路移到屏幕左上角外侧 → 日历本该被顶到工作区左上角 (0,0) */
                require('child_process').execFileSync('powershell.exe', [
                  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', moveScript,
                  '-fx', String(cur1.x), '-fy', String(cur1.y),
                  '-x', '2', '-y', '2', '-steps', '14', '-hold', '45'
                ], { encoding: 'utf8' });
                await waitZ(700);
                await calJs('(function(){var c=document.getElementById("cal");' +
                  'c.dispatchEvent(new PointerEvent("pointerup",{bubbles:true,cancelable:true,button:0,pointerId:77,' +
                  'screenX:2,screenY:2,clientX:2,clientY:2}));return true;})()');
                await waitZ(500);
                const bEnd2 = calWin.getBounds();
                const pts2 = await calJs('window.__pts');
                diagLog('calzoom-7e-真光标驱动的拖动', {
                  缩放: zoomOf(),
                  真光标: cur0.x + ',' + cur0.y + ' → ' + cur1.x + ',' + cur1.y + ' → 2,2（DIP）',
                  窗口DIP: bStart.x + ',' + bStart.y + ' → ' + bEnd2.x + ',' + bEnd2.y,
                  窗口有没有跟着走: (bEnd2.x !== bStart.x || bEnd2.y !== bStart.y),
                  最终距工作区左上角: (function () {
                    const p = phys(bEnd2);
                    return (p.x - wTL.x) + ',' + (p.y - wTL.y) + '（物理像素）';
                  })(),
                  页面收到的移动事件数: pts2 ? pts2.length : 0,
                  最后两个事件: pts2 ? pts2.slice(-2) : null
                });

                /* ⑧ 拖动贴边：先试「左上角」（用户报过贴不到上边界和左边界），
                 再试「右下角」对照，都以物理像素量实际差距。 */
              /* ⚠️ 别盲目点锁：上一步已经解锁了，再点一下反而又锁上，后面拖动全都无效（踩过） */
              if (await calJs('document.body.classList.contains("locked")')) {
                await calJs('document.getElementById("btnLock").click(); true;');
                await waitZ(600);
              }
              await dragTo(waNow.x - 60, waNow.y - 60);          // 想贴左上，故意拖出界
              const gTL = gaps();
              await dragTo(waNow.x + waNow.width + 60, waNow.y + waNow.height + 60);  // 想贴右下
              const gBR = gaps();
              diagLog('calzoom-7-拖到四边', {
                工作区: waNow.x + ',' + waNow.y + ' ' + waNow.width + 'x' + waNow.height,
                贴左上后: gTL, 贴右下后: gBR,
                左边界贴上了吗: Math.abs(gTL.左) <= 2,
                上边界贴上了吗: Math.abs(gTL.上) <= 2,
                右边界贴上了吗: Math.abs(gBR.右) <= 2,
                下边界贴上了吗: Math.abs(gBR.下) <= 2,
                /* ⚠️ 读这几个数前先看「工作区」是不是窗口所在那块屏：
                   双显示器下窗口如果横跨两块屏，getDisplayMatching 可能挑中另一块，
                   这时四个 gap 里会有一两个是负的大数（对着别的工作区量的），别被吓到。 */
                说明: '窗口横跨两块屏时这些数字不可信，看「工作区」和窗口 DIP 对不对得上'
              });
              /* 把日历拖回左上角停住，留给外面用屏摄核对「可见卡片」贴没贴到屏幕角
                 （窗口 bounds 到 0 不代表看得见的卡片也到 0，之前宠物就吃过这个亏） */
              await dragTo(waNow.x - 60, waNow.y - 60);
              await waitZ(600);
              const pTL = phys(calWin.getBounds());
              /* 直接屏摄屏幕左上角：看得见的卡片到底贴没贴到角上 */
              let capMsg = '';
              try {
                capMsg = require('child_process').execFileSync('powershell.exe', [
                  '-NoProfile', '-ExecutionPolicy', 'Bypass',
                  '-File', path.join(__dirname, '.diag', 'cap-region.ps1'),
                  '-x', '0', '-y', '0', '-w', '300', '-h', '300',
                  '-out', path.join(__dirname, '.diag', 'corner.png')
                ], { encoding: 'utf8' });
              } catch (eCap) { capMsg = 'ERR ' + String(eCap && eCap.message || eCap); }
              diagLog('calzoom-7c-停在左上角并屏摄', {
                窗口DIP: JSON.stringify(calWin.getBounds()),
                可见左上角距工作区左上角_物理像素: (pTL.x - wTL.x) + ',' + (pTL.y - wTL.y),
                缩放: zoomOf(),
                屏摄: String(capMsg).trim()
              });
              for (let i = 0; i < 12; i++) {
                const st = await readState();
                if (st.百分比 === '100%') break;
                await calJs('document.getElementById("btnZoom' +
                  (parseInt(st.百分比, 10) > 100 ? 'Out' : 'In') + '").click(); true;');
                await waitZ(320);
              }
              /* 顺手截两张图：放大到 120% 一张、100% 一张（给用户看缩放效果）。
                 先把右侧「当天清单」关掉，不然月历被它盖住。 */
              try {
                await calJs('(function(){var b=document.getElementById("panelClose");if(b)b.click();return true;})()');
                await waitZ(500);
                await calJs('document.getElementById("btnZoomIn").click(); true;');
                await waitZ(450);
                await calJs('document.getElementById("btnZoomIn").click(); true;');
                await waitZ(900);
                fs.writeFileSync(path.join(__dirname, '.diag', 'cal-zoom-120.png'),
                  (await calWin.webContents.capturePage()).toPNG());
                await calJs('document.getElementById("btnZoomOut").click(); true;');
                await waitZ(450);
                await calJs('document.getElementById("btnZoomOut").click(); true;');
                await waitZ(900);
                fs.writeFileSync(path.join(__dirname, '.diag', 'cal-zoom-100.png'),
                  (await calWin.webContents.capturePage()).toPNG());
              } catch (eShot) { diagLog('calzoom-shot-error', String(eShot && eShot.message || eShot)); }
              const sEnd = await readState();
              const bEnd = calWin.getBounds();
              diagLog('calzoom-6-收尾', {
                状态: sEnd, 窗口: boundsOf(), 实际缩放: zoomOf(),
                /* ⚠️ 别要求像素级相等：Windows 会把窗口尺寸吸到奇数像素，
                   同一尺寸走 setBounds 和创建时可能差 2~3px（这里是 941 vs 943） */
                回到一百了吗: sEnd.百分比 === '100%' && Math.abs(bEnd.width - b100.width) <= 4
              });

              /* ⑨ 故意把日历摆到「两块屏的交界」上，验证会被收回一块屏里。
                 现实里用户就碰上过这个（窗口停在主屏右边界 1707，跨屏那半被 Windows 裁掉）。
                 ⚠️ 这里直接用上面那个 pri（主屏可用区），别再声明一次 —— 重名会让主进程启动就崩。 */
              calWin.setBounds({ x: pri.x + pri.width - 40, y: pri.y + 40, width: CAL_BOX.width + 1, height: CAL_BOX.height });
              await waitZ(400);
              const straddle = calWin.getBounds();
              const didSnap = snapCalIntoOneDisplay('自检-故意跨界');
              await waitZ(400);
              const after = calWin.getBounds();
              const waAfter = screen.getDisplayMatching(after).workArea;
              diagLog('calzoom-9-横跨两块屏会被收回', {
                故意摆到: straddle.x + ',' + straddle.y + '（主屏右边界是 ' + (pri.x + pri.width) + '）',
                有没有动手: didSnap,
                收回后: after.x + ',' + after.y,
                所在屏可用区: waAfter.x + ',' + waAfter.y + ' ' + waAfter.width + 'x' + waAfter.height,
                整块都在一块屏里了吗: after.x >= waAfter.x && after.y >= waAfter.y &&
                  after.x + after.width <= waAfter.x + waAfter.width &&
                  after.y + after.height <= waAfter.y + waAfter.height
              });
              } catch (eZ) {
                diagLog('calzoom-error', { message: String(eZ && eZ.message || eZ) });
              }
            }
          }
          if (DIAG.cal) {
            const wait2 = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };            /* 先探一下主界面是否还活着（页面报错时后面的脚本会成片失败，
               先落一条日志，省得对着「Script failed to execute」猜） */
            diagLog('cal-0-start', await win.webContents.executeJavaScript(
              '({有备忘弹窗:!!document.getElementById("memoText"),' +
              ' 有新增备忘按钮:!!document.getElementById("btnAddMemo"),' +
              ' 有新增待办按钮:!!document.getElementById("btnAddTodo"),' +
              ' 有日历勾选:!!document.getElementById("chkDesktopCal")})', true));
            const pad2 = function (n) { return n < 10 ? '0' + n : String(n); };
            const dayStr = function (offset) {
              const d = new Date();
              d.setDate(d.getDate() + offset);
              return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
            };
            /* ⚠️ 三条的时间都放在「还没到」的时候（今天那条用 23:59）：
               造出已经过期的待办会立刻弹到点提醒，而且是一条接一条地弹，
               会把界面盖住、搅乱后面的点击和截图。 */
            const plan = [
              { text: '【自检】最高优先级', date: dayStr(0), time: '23:59', prio: 'high' },
              { text: '【自检】中优先级', date: dayStr(1), time: '14:00', prio: 'mid' },
              { text: '【自检】低优先级', date: dayStr(2), time: '18:30', prio: 'low' }
            ];
            /* 0) 再用真实的「新增备忘」弹窗塞两条备忘录（验证左栏那条链路） */
            const memoAdded = await win.webContents.executeJavaScript(
              '(function(){var out=[];["周三上午9点参加部门会议","购物清单：生日蛋糕、红酒、水果"].forEach(function(t){' +
              '  document.getElementById("btnAddMemo").click();' +
              '  document.getElementById("memoText").value=t;' +
              '  document.getElementById("memoSave").click();' +
              '  out.push(document.getElementById("memoOverlay").hidden);});' +
              'var raw={};try{raw=JSON.parse(localStorage.getItem("kunkun.todos.v1")||"{}");}catch(e){}' +
              'return {每条都关掉了弹窗:out.every(function(h){return h;}),' +
              ' 备忘条数:(raw.memos||[]).length};})()', true);
            diagLog('cal-0-memo', memoAdded);

            /* 1) 全部走真实 UI：点「＋ 新增待办」→ 填表 → 点优先级 → 保存 */
            const added = await win.webContents.executeJavaScript(
              '(function(){var out=[];var plan=' + JSON.stringify(plan) + ';' +
              'plan.forEach(function(p){' +
              '  document.getElementById("btnAddTodo").click();' +
              '  document.getElementById("tdText").value=p.text;' +
              '  document.getElementById("tdDate").value=p.date;' +
              '  document.getElementById("tdTime").value=p.time;' +
              '  var seg=document.getElementById("tdPrio");' +
              '  var btn=seg?seg.querySelector(\'button[data-prio="\'+p.prio+\'"]\'):null;' +
              '  if(btn)btn.click();' +
              '  document.getElementById("tdSave").click();' +
              '  out.push({want:p.prio,overlayOpen:!document.getElementById("todoOverlay").hidden});' +
              '});' +
              'var raw={};try{raw=JSON.parse(localStorage.getItem("kunkun.todos.v1")||"{}");}catch(e){}' +
              'var saved=(raw.todos||[]).filter(function(t){return t.text&&t.text.indexOf("【自检】")===0;})' +
              '  .map(function(t){return {text:t.text,prio:t.prio,dueAt:t.dueAt};});' +
              'return {added:out, saved:saved};})()', true);
            diagLog('cal-1-add', {
              新增: added.added,
              存下来的: added.saved.map(function (t) {
                return t.text + '=' + t.prio + '@' + new Date(t.dueAt).toLocaleString('zh-CN');
              }),
              三条都带优先级: added.saved.length === 3 &&
                added.saved.every(function (t) { return !!t.prio; }),
              优先级各不同: added.saved.map(function (t) { return t.prio; }).sort().join(',') === 'high,low,mid'
            });

            /* 1.5) 顺手截一张主界面：新增待办弹窗里的「优先级 / 重复」那几行。
                  自检造的待办时间可能已经过了点，会【一条接一条】弹到点提醒把主界面盖住，
                  所以先循环把它收干净（点「稍后再说」= 不改完成状态）。 */
            try {
              for (let g2 = 0; g2 < 8; g2++) {
                const hidden = await win.webContents.executeJavaScript(
                  '(function(){var o=document.getElementById("overlay");' +
                  'if(!o||o.hidden)return true;' +
                  'var a=document.getElementById("alertSnooze");if(a)a.click();' +
                  'return document.getElementById("overlay").hidden;})()', true);
                if (hidden) break;
                await wait2(350);
              }
              await win.webContents.executeJavaScript(
                '(function(){document.getElementById("btnAddTodo").click();' +
                'var seg=document.getElementById("tdPrio");' +
                'var b=seg?seg.querySelector(\'button[data-prio="high"]\'):null;if(b)b.click();' +
                /* 让截图里也能看到「重复」那两行 */
                'var r=document.getElementById("tdRepeat");if(r){r.value="monthly";' +
                'r.dispatchEvent(new Event("change",{bubbles:true}));' +
                'var md=document.getElementById("tdMonthDay");if(md){md.value="15";' +
                'md.dispatchEvent(new Event("change",{bubbles:true}));}}' +
                'return true;})()', true);
              await wait2(500);
              const shotMain = await win.capturePage();
              fs.writeFileSync(path.join(__dirname, '.diag', 'cal-modal.png'), shotMain.toPNG());
              await win.webContents.executeJavaScript(
                'document.getElementById("tdCancel").click(); true;', true);
            } catch (e5) { diagLog('cal-modal-shot-error', String(e5 && e5.message || e5)); }

            /* 2) 开日历窗，等它把数据画出来 */
            diagLog('cal-2a', { 开之前: calOn, 窗口在吗: !!(calWin && !calWin.isDestroyed()) });
            setCalOn(true);
            await wait2(1600);
            diagLog('cal-2b', {
              开之后: calOn,
              窗口在吗: !!(calWin && !calWin.isDestroyed()),
              窗口可见: (calWin && !calWin.isDestroyed()) ? calWin.isVisible() : null,
              窗口尺寸: (calWin && !calWin.isDestroyed())
                ? (calWin.getBounds().width + 'x' + calWin.getBounds().height) : ''
            });
            /* 主界面那个勾必须跟着勾上（主进程 → 页面 的回路） */
            let chkNow = null;
            try {
              chkNow = await win.webContents.executeJavaScript(
                'document.getElementById("chkDesktopCal").checked', true);
            } catch (e9) { chkNow = 'ERR: ' + String(e9 && e9.message || e9); }
            diagLog('cal-2-checkbox', { 主界面勾上了: chkNow });
            if (!calWin || calWin.isDestroyed()) {
              diagLog('cal-2-window', { error: '日历窗没起来' });
            } else {
              const box = calWin.getBounds();
              const ui = await calWin.webContents.executeJavaScript(
                '(function(){try{' +
                'var cells=document.querySelectorAll(".cell");' +
                'var bars=document.querySelectorAll(".ev");' +
                'var kinds={};document.querySelectorAll(".ev").forEach(function(b){' +
                '  var k=b.className.replace(/\\s*done/,"").trim();kinds[k]=(kinds[k]||0)+1;});' +
                'var today=document.querySelector(".cell.today");' +
                'var byKey={};document.querySelectorAll(".cell").forEach(function(c){' +
                '  var ev=c.querySelectorAll(".ev");if(ev.length){' +
                '    byKey[c.dataset.key]=Array.prototype.map.call(ev,function(e){' +
                '      return e.className.replace("ev ","").replace(" done","")+":"+e.textContent;});}});' +
                'var bg={};["p-high","p-mid","p-low"].forEach(function(p){' +
                '  var d2=document.createElement("i");d2.className="ev "+p;document.body.appendChild(d2);' +
                '  bg[p]=getComputedStyle(d2).backgroundImage.slice(0,60);d2.remove();});' +
                'var todayCell=document.querySelector(".cell.today");' +
                'return {cells:cells.length, bars:bars.length, kinds:kinds, byKey:byKey, colors:bg,' +
                ' todayKey:today?today.dataset.key:null, title:document.getElementById("title").textContent,' +
                ' 农历:todayCell&&todayCell.querySelector(".lunar")?todayCell.querySelector(".lunar").textContent:"(无)",' +
                ' 农历格子数:document.querySelectorAll(".cell .lunar").length,' +
                ' 备忘条数:document.querySelectorAll(".memo").length,' +
                ' 第一条备忘:document.querySelector(".memo .txt")?document.querySelector(".memo .txt").textContent.slice(0,20):"",' +
                ' 有加号按钮:!!document.getElementById("btnAdd"),' +
                ' 有设置按钮:!!document.getElementById("btnSet"),' +
                ' fit:getComputedStyle(document.documentElement).getPropertyValue("--fit")};' +
                '}catch(e){return {错误:String(e&&e.message||e)};}})()', true);
              diagLog('cal-2-grid', {
                窗口: box.width + 'x' + box.height,
                格子数: ui.cells,
                小条数: ui.bars,
                各类条数: ui.kinds,
                每天的条: ui.byKey,
                今天的格子: ui.todayKey,
                标题: ui.title,
                今天的农历: ui.农历,
                有农历的格子数: ui.农历格子数,
                左栏备忘条数: ui.备忘条数,
                第一条备忘: ui.第一条备忘,
                '＋和⚙按钮都有': ui.有加号按钮 && ui.有设置按钮,
                三档颜色: ui.colors,
                fit: ui.fit,
                今天的格子在: !!ui.todayKey
              });

              /* 3) 点「今天」那一格 → 当天清单 */
              const panel = await calWin.webContents.executeJavaScript(
                '(function(){try{var c=document.querySelector(".cell.today");if(!c)return {error:"没有今天的格子"};' +
                'c.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,button:0,clientX:5,clientY:5,screenX:5,screenY:5,pointerId:1}));' +
                'c.dispatchEvent(new PointerEvent("pointerup",{bubbles:true,button:0,clientX:5,clientY:5,screenX:5,screenY:5,pointerId:1}));' +
                'var p=document.getElementById("panel");' +
                'return {open:!p.hidden, 真的显示出来了:getComputedStyle(p).display!=="none",' +
                ' title:document.getElementById("panelTitle").textContent,' +
                ' rows:document.querySelectorAll("#panelList .pi").length,' +
                ' first:document.querySelector("#panelList .pi .txt")?document.querySelector("#panelList .pi .txt").textContent:""};' +
                '}catch(e){return {错误:String(e&&e.message||e)};}})()',
                true);
              diagLog('cal-3-daypanel', panel);

              /* 3.5) 当天清单里的「✏️ 编辑」：应该打开主界面的修改弹窗，
                     而且带的是这条待办的内容和优先级 */
              const editReq = await calWin.webContents.executeJavaScript(
                '(function(){var b=document.querySelector(\'#panelList button[data-act="edit"]\');' +
                'if(!b)return {error:"清单里没有编辑按钮"};b.click();return {ok:true};})()', true);
              await wait2(700);
              const editor = await win.webContents.executeJavaScript(
                '(function(){var o=document.getElementById("todoOverlay");' +
                'var on=document.querySelector("#tdPrio button.on");' +
                'return {弹窗开着:o?!o.hidden:null,' +
                ' 标题:document.getElementById("tdTitle").textContent,' +
                ' 内容:document.getElementById("tdText").value,' +
                ' 优先级:on?on.dataset.prio:null,' +
                ' 日期:document.getElementById("tdDate").value};})()', true);
              diagLog('cal-3b-edit', { 点了编辑: editReq, 主界面弹窗: editor });
              /* 关掉弹窗，别影响后面的步骤 */
              await win.webContents.executeJavaScript(
                'document.getElementById("tdCancel").click(); true;', true);
              await wait2(300);

              /* 4) 翻月（翻出去再翻回来）+「今天」按钮（用户说其实有用，已加回） */
              const nav = await calWin.webContents.executeJavaScript(
                '(function(){try{var g=function(id){return document.getElementById(id);};' +
                'var th=function(){return g("title").textContent;};' +
                'var t0=th();g("btnNext").click();var t1=th();' +
                'g("btnPrev").click();var t2=th();' +
                'g("btnPrev").click();var t3=th();' +
                /* 键盘也翻月（要派发到 body 上才会冒泡到 document） */
                'document.body.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true}));' +
                'var t4=th();' +
                'g("btnNext").click();var t5=th();' +
                'g("btnToday").click();var t6=th();' +
                'return {当月:t0,下一月:t1,翻回来:t2,再上一月:t3,键盘也翻月:t4,又下一月:t5,点今天回到:t6,' +
                ' 有今天按钮:!!g("btnToday")};' +
                '}catch(e){return {error:String(e&&e.message||e)};}})()', true);
              nav.窗口置顶 = calWin.isAlwaysOnTop();
              diagLog('cal-4-nav', nav);

              /* 4.6) 主题 + 不透明度：设置页里点了要立刻反映到日历窗，日历里点了要回写设置 */
              const styleStep = await win.webContents.executeJavaScript(
                '(function(){var seg=document.getElementById("calThemeSeg");' +
                'var b=seg?seg.querySelector(\'button[data-theme="dark"]\'):null;if(b)b.click();' +
                'var o=document.getElementById("calOpa");' +
                'if(o){o.value="60";o.dispatchEvent(new Event("input",{bubbles:true}));}' +
                'return {点得到深色按钮:!!b, 滑杆值:o?o.value:"(没有滑杆)"};})()', true);
              await wait2(600);
              const styled = await calWin.webContents.executeJavaScript(
                '(function(){var cs=getComputedStyle(document.getElementById("cal"));' +
                'var today=document.querySelector(".cell.today");' +
                'return {主题:document.documentElement.getAttribute("data-theme"),' +
                ' 卡片底色:cs.backgroundImage.slice(0,60),' +
                ' 卡片不透明度:cs.opacity,' +
                ' 不透明度变量:getComputedStyle(document.documentElement).getPropertyValue("--opa").trim(),' +
                ' 正文颜色:getComputedStyle(document.body).color,' +
                /* 带待办的格子、色条都在卡片里 → 会跟着整卡一起淡（用户要的一致性） */
                ' 待办条跟着卡片淡吗:!!(document.querySelector(".cell .ev")||{}).closest && ' +
                '  !!document.querySelector(".cell .ev").closest(".cal"),' +
                /* 深色下「今天」那格不能再变成白板 */
                ' 今天格底色:today?getComputedStyle(today).backgroundColor:"(无)",' +
                ' 今天格字色:today?getComputedStyle(today.querySelector(".d")).color:"(无)",' +
                ' 日历里的主题按钮:document.getElementById("btnTheme").textContent};})()',
                true);
              diagLog('cal-8-style', { 设置页操作: styleStep, 日历窗: styled });

              /* 再从日历窗那个 🌙/☀ 切回浅色，验证「日历 → 设置页」也是通的 */
              await calWin.webContents.executeJavaScript(
                'document.getElementById("btnTheme").click(); true;', true);
              await wait2(600);
              diagLog('cal-9-theme-back', await win.webContents.executeJavaScript(
                '(function(){var seg=document.getElementById("calThemeSeg");' +
                'var on=seg?seg.querySelector("button.on"):null;' +
                'var raw={};try{raw=JSON.parse(localStorage.getItem("kunkun.settings.v1")||"{}");}catch(e){}' +
                'return {设置页高亮:on?on.dataset.theme:null, 存的主题:raw.calTheme,' +
                ' 存的不透明度:raw.calOpacity};})()', true));
              /* 不透明度调回默认，免得影响后面的截图 */
              await win.webContents.executeJavaScript(
                '(function(){var o=document.getElementById("calOpa");' +
                'if(o){o.value="97";o.dispatchEvent(new Event("input",{bubbles:true}));' +
                'o.dispatchEvent(new Event("change",{bubbles:true}));}return true;})()', true);
              await wait2(300);

              /* 4.5) 左栏直接新增备忘：走 ＋ → 输入 → 回车 这条真实路径 */
              const memoNew = await calWin.webContents.executeJavaScript(
                '(function(){var row=document.getElementById("memoNewRow");var before=row.hidden;' +
                'document.getElementById("btnAddMemo").click();var opened=!row.hidden;' +
                'var inp=document.getElementById("memoNew");inp.value="【自检】日历里加的备忘";' +
                'inp.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));' +
                'return {原来藏着:before, 点加号后展开了:opened, 存完输入框清空:inp.value===""};})()', true);
              await wait2(600);
              const memoAfter = await calWin.webContents.executeJavaScript(
                'document.querySelectorAll(".memo").length', true);
              const memoStored = await win.webContents.executeJavaScript(
                '(function(){var raw={};try{raw=JSON.parse(localStorage.getItem("kunkun.todos.v1")||"{}");}catch(e){}' +
                'var m=(raw.memos||[]).filter(function(x){return x.text.indexOf("日历里加的备忘")>=0;})[0];' +
                'return m?{text:m.text,done:!!m.done}:null;})()', true);
              diagLog('cal-4b-addmemo', {
                交互: memoNew,
                日历左栏条数: memoAfter,
                主界面存下来了: memoStored
              });

              /* 5) 截图（先把当天清单面板关掉再截，它是盖在月历上的覆盖层）。
                  离屏窗抓 'paint' 那一帧最稳：可见窗会被 DWM 淡出/旧帧坑。 */
              try {
                const closedNow = await calWin.webContents.executeJavaScript(
                  '(function(){var b=document.getElementById("panelClose");if(b)b.click();' +
                  'return {hidden:document.getElementById("panel").hidden,' +
                  ' 显示着吗:getComputedStyle(document.getElementById("panel")).display!=="none",' +
                  ' cells:document.querySelectorAll(".cell").length,' +
                  ' bars:document.querySelectorAll(".ev").length};})()',
                  true);
                diagLog('cal-5-before-shot', closedNow);
                try { calWin.webContents.invalidate(); } catch (e6) { }
                await wait2(900);
                const img = await calWin.capturePage();
                fs.writeFileSync(path.join(__dirname, '.diag', 'calendar.png'), img.toPNG());
              } catch (e4) { diagLog('cal-shot-error', String(e4 && e4.message || e4)); }

              /* 6) 反向验证：主界面取消勾选 → 日历窗必须隐藏 */
              setCalOn(false);
              await wait2(400);
              diagLog('cal-5-hide', { 关掉后还可见: !!(calWin && !calWin.isDestroyed() && calWin.isVisible()) });

              /* 6.5) 拖动 + 贴边：日历窗也是 resizable:false，不该被留那圈余量；
                    顺便验证拖完会记位置（cal-position.json）。
                    再验「在日历里勾完成」这条最长链路：日历 → 主进程 → 主界面改数据
                    → 存盘 → 推回日历，四个环节都得对上。 */
              setCalOn(true);
              await wait2(600);
              if (calWin && !calWin.isDestroyed()) {
                const wa2 = screen.getDisplayNearestPoint({
                  x: calWin.getBounds().x + 40, y: calWin.getBounds().y + 20
                }).workArea;
                const b0 = calWin.getBounds();
                ipcMain.emit('cal-win-drag-start', {},
                  { x: b0.x + Math.floor(b0.width / 2), y: b0.y + Math.floor(b0.height / 2) });
                ipcMain.emit('cal-win-drag-move', {},
                  { x: wa2.x + wa2.width - 1, y: wa2.y + wa2.height - 1 });
                ipcMain.emit('cal-win-drag-end', {}, {});
                await wait2(500);
                const b1 = calWin.getBounds();
                const pPet = screen.dipToScreenRect(null, b1);
                const pWa = screen.dipToScreenRect(null, wa2);
                diagLog('cal-6-drag', {
                  拖动前: b0.x + ',' + b0.y,
                  拖到右下后: b1.x + ',' + b1.y,
                  右下期望: (wa2.x + wa2.width - b1.width) + ',' + (wa2.y + wa2.height - b1.height),
                  右边缘余量像素: (pWa.x + pWa.width) - (pPet.x + pPet.width),
                  下边缘余量像素: (pWa.y + pWa.height) - (pPet.y + pPet.height),
                  记下位置了吗: !!loadCalPos()
                });

                /* 打开今天的格子，勾掉第一条，看两边数据是否都变了 */
                const tick = await calWin.webContents.executeJavaScript(
                  '(function(){try{' +
                  'var c=document.querySelector(".cell.today");' +
                  'if(!c)return {error:"没有今天的格子（当前显示的是"+document.getElementById("title").textContent+"）"};' +
                  'c.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,button:0,clientX:5,clientY:5,screenX:5,screenY:5,pointerId:2}));' +
                  'c.dispatchEvent(new PointerEvent("pointerup",{bubbles:true,button:0,clientX:5,clientY:5,screenX:5,screenY:5,pointerId:2}));' +
                  'var row=document.querySelector("#panelList .pi");' +
                  'if(!row)return {error:"面板里没有条目"};' +
                  'var id=row.dataset.id;var txt=row.querySelector(".txt").textContent;' +
                  'row.click();return {id:id,text:txt};' +
                  '}catch(e){return {error:String(e&&e.message||e)};}})()', true);
                await wait2(700);
                const after = await calWin.webContents.executeJavaScript(
                  '(function(){var row=document.querySelector("#panelList .pi");' +
                  'return {面板里标成完成:!!(row&&row.classList.contains("done")),' +
                  ' 小条也画成完成:document.querySelectorAll(".ev.done").length};})()', true);
                const stored = await win.webContents.executeJavaScript(
                  '(function(){var raw={};try{raw=JSON.parse(localStorage.getItem("kunkun.todos.v1")||"{}");}catch(e){}' +
                  'var t=(raw.todos||[]).filter(function(x){return x.id===' + JSON.stringify(tick.id) + ';})[0];' +
                  'return t?{text:t.text,done:!!t.done,prio:t.prio}:null;})()', true);
                diagLog('cal-7-toggle-done', {
                  勾的是: tick.text + '（' + tick.id + '）',
                  日历面板: after.面板里标成完成,
                  日历小条已完成数: after.小条也画成完成,
                  主界面存的数据: stored
                });
              }

              /* 7) 设计预览：透明窗的 capturePage 只会拿到旧帧（Electron 的老毛病），
                 所以另开一个【不透明】预览窗、塞一批更密的待办（含一天 5 条 + 已完成的），
                 摆在屏幕中央，再用整屏截图裁出它 —— 看到的就是真实像素。
                 顺带验证「一天超过 3 条」时的 +N 溢出显示。 */
              try {
                const disp0 = screen.getPrimaryDisplay();
                const wa0b = disp0.workArea;
                const pw = CAL_BOX.width, ph = CAL_BOX.height;
                const preview = new BrowserWindow({
                  width: pw, height: ph, show: false,
                  webPreferences: {
                    /* 离屏渲染：不经过 DWM 合成，抓到的就是页面自己画的那一帧
                       （可见窗/透明窗的 capturePage 会拿到旧帧或被合成器淡出） */
                    offscreen: true,
                    preload: path.join(__dirname, 'cal-preload.js'),
                    contextIsolation: true, nodeIntegration: false,
                    backgroundThrottling: false
                  }
                });
                const base0 = new Date();
                const mk = function (off, hh, mm, prio, text, done) {
                  const d = new Date(base0.getFullYear(), base0.getMonth(),
                    base0.getDate() + off, hh, mm, 0, 0);
                  return {
                    id: 'pv' + off + '_' + hh + mm, text: text, done: !!done,
                    dueAt: d.getTime(), prio: prio
                  };
                };                const demo = [
                  mk(0, 9, 30, 'high', '给客户回邮件'),
                  mk(0, 11, 0, 'mid', '交周报'),
                  { id: 'pvr1', text: '交房租', done: false, prio: 'high',
                    dueAt: mk(0, 15, 0, 'high', 'x').dueAt,
                    repeat: { kind: 'monthly', mode: 'day', day: 15 }, repeatText: '每月 15 号' },
                  mk(0, 14, 0, 'mid', '买牛奶'),
                  mk(0, 16, 30, 'low', '整理下载文件夹'),
                  mk(0, 19, 0, 'low', '给绿萝浇水', true),
                  mk(1, 10, 0, 'high', '体检'),
                  mk(2, 15, 0, 'mid', '开组会'),
                  mk(3, 20, 0, 'low', '看电影'),
                  mk(-3, 9, 0, 'mid', '已经过去的事', true),
                  mk(5, 12, 0, 'high', '交房租'),
                  mk(6, 8, 30, 'low', '晨跑'),
                  mk(9, 18, 0, 'mid', '朋友生日'),
                  mk(12, 9, 0, 'high', '季度总结'),
                  mk(17, 20, 30, 'mid', '看球赛')
                ];
                const demoMemos = [
                  { id: 'pm1', text: '周三上午9点参加部门会议', done: false, at: base0.getTime() },
                  { id: 'pm2', text: '周四下午5点前往金融中心参加培训课程', done: false, at: base0.getTime() },
                  { id: 'pm3', text: '购物清单：生日蛋糕、红酒、水果、百事可乐、牛排', done: false, at: base0.getTime() },
                  { id: 'pm4', text: '周日上午10点飞机飞往上海出差', done: false, at: base0.getTime() },
                  { id: 'pm5', text: '已经办完的一件事', done: true, at: base0.getTime() }
                ];
                /* 离屏渲染：抓 'paint' 事件给的那一帧最靠谱
                   （可见窗会被 DWM 淡出/旧帧坑，隐藏窗的合成器又不一定产新帧） */
                let lastFrame = null;
                preview.webContents.on('paint', function (ev, dirty, image) {
                  lastFrame = image;
                });
                preview.loadFile(path.join(__dirname, 'cal.html'));
                await new Promise(function (r) { preview.webContents.once('did-finish-load', r); });
                /* 页面本身是透明底（真窗口靠窗口透明看桌面），预览里垫一层中性灰：
                   ⚠️ 别用近黑 —— 上次垫 #0d1720，结果被误看成「卡片外面有个直角黑框」 */
                preview.webContents.insertCSS('html,body{background:#8d99a3 !important}');
                preview.webContents.setFrameRate(30);
                preview.webContents.send('cal-todos', demo);
                preview.webContents.send('cal-memos', demoMemos);
                preview.webContents.send('cal-fit', { width: pw, height: ph });
                await wait2(1200);
                const shot0 = lastFrame || await preview.capturePage();
                fs.writeFileSync(path.join(__dirname, '.diag', 'calendar-demo.png'), shot0.toPNG());
                diagLog('cal-6-shot', {
                  来源: lastFrame ? 'paint 事件' : 'capturePage',
                  尺寸: shot0.getSize()
                });
                /* 顺手再截一张深色主题的 */
                preview.webContents.send('cal-style', { theme: 'dark', opacity: 97 });
                await wait2(900);
                if (lastFrame) {
                  fs.writeFileSync(path.join(__dirname, '.diag', 'calendar-demo-dark.png'),
                    lastFrame.toPNG());
                }
                /* 再来一张「不透明度调到 45%」的：验证网格和色条一起淡（不再有实心白格） */
                preview.webContents.send('cal-style', { theme: 'light', opacity: 45 });
                await wait2(900);
                if (lastFrame) {
                  fs.writeFileSync(path.join(__dirname, '.diag', 'calendar-demo-fade.png'),
                    lastFrame.toPNG());
                }
                preview.webContents.send('cal-style', { theme: 'light', opacity: 97 });
                await wait2(400);
                /* 最后一张：点开「今天」那一格，截当天清单（带 ✏️ 编辑 / 🗑 删除） */
                await preview.webContents.executeJavaScript(
                  '(function(){var c=document.querySelector(".cell.today");' +
                  'if(!c)return false;' +
                  'c.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,button:0,clientX:5,clientY:5,screenX:5,screenY:5,pointerId:9}));' +
                  'c.dispatchEvent(new PointerEvent("pointerup",{bubbles:true,button:0,clientX:5,clientY:5,screenX:5,screenY:5,pointerId:9}));' +
                  'return true;})()', true);
                await wait2(900);
                if (lastFrame) {
                  fs.writeFileSync(path.join(__dirname, '.diag', 'calendar-demo-panel.png'),
                    lastFrame.toPNG());
                }
                diagLog('cal-6-demo', await preview.webContents.executeJavaScript(
                  '(function(){var c=document.querySelector(".cell.today");' +
                  'return {今天的小条:c?c.querySelectorAll(".ev").length:-1,' +
                  ' 溢出标记:c&&c.querySelector(".more")?c.querySelector(".more").textContent:"(无)",' +
                  ' 已完成的小条:document.querySelectorAll(".ev.done").length,' +
                  ' 全部小条:document.querySelectorAll(".ev").length,' +
                  ' 左栏备忘:document.querySelectorAll(".memo").length,' +
                  ' 已完成的备忘:document.querySelectorAll(".memo.done").length,' +
                  ' 农历示例:(document.querySelector(".cell .lunar")||{}).textContent||"(无)"};})()', true));
                preview.destroy();
              } catch (e7) { diagLog('cal-demo-error', String(e7 && e7.message || e7)); }
              /* 7.5) 当天清单里的「🗑 删除」：先就地问一句，确认后两边都得没 */
              const delBefore = await win.webContents.executeJavaScript(
                '(function(){var raw={};try{raw=JSON.parse(localStorage.getItem("kunkun.todos.v1")||"{}");}catch(e){}' +
                'return (raw.todos||[]).length;})()', true);
              const delStep = await calWin.webContents.executeJavaScript(
                '(function(){var b=document.querySelector(\'#panelList button[data-act="del"]\');' +
                'if(!b)return {error:"清单里没有删除按钮"};b.click();' +
                'var c=document.querySelector(".pi.confirming");' +
                'var txt=c?c.querySelector(".confirm-txt").textContent:null;' +
                'var ok=c?c.querySelector(\'button[data-act="ok"]\'):null;' +
                'if(ok)ok.click();' +
                'return {确认条出来了:!!c, 确认文案:txt};})()', true);
              await wait2(800);
              const delAfter = await win.webContents.executeJavaScript(
                '(function(){var raw={};try{raw=JSON.parse(localStorage.getItem("kunkun.todos.v1")||"{}");}catch(e){}' +
                'return (raw.todos||[]).length;})()', true);
              const delCal = await calWin.webContents.executeJavaScript(
                '(function(){var c=document.querySelector(".cell.today");' +
                'return {今天还剩几条:c?c.querySelectorAll(".ev").length:-1,' +
                ' 面板还剩几行:document.querySelectorAll("#panelList .pi").length};})()', true);
              diagLog('cal-7b-delete', {
                交互: delStep,
                主界面待办数: delBefore + ' → ' + delAfter,
                真的删掉了: delAfter === delBefore - 1,
                日历: delCal
              });
            }
          }
          /* 退出还原自检：开护眼 → 记下色温 → 走正常退出（app.quit）。
             外面在进程结束后再读一次伽马表：回到原值才算通过。 */
          if (DIAG.eyequit) {
            const rampDump = function () {
              return new Promise(function (res) {
                psRun([EYE_WINAPI, 'Write-Output ([KkEye]::Dump())'].join('\n'),
                  function (e, o) { res(String(o || '').replace(/\s+/g, ' ').trim().slice(0, 200)); });
              });
            };
            diagLog('eyequit-1-before', { ramp: await rampDump(), snap: eyeCareSnapshot() });
            diagLog('eyequit-2-on', await eyeCareSet(true, 4500));
            await new Promise(function (r) { setTimeout(r, 900); });
            diagLog('eyequit-3-ramp-warm', { ramp: await rampDump() });
            if (DIAG.eyeKeep) {
              /* 模拟用户在设置页取消了「退出程序时把色温还原」 */
              eyeCareRestorePref = false;
              diagLog('eyequit-keep-mode', { restorePref: eyeCareRestorePref });
            }
          }
          /* 开机自启自检：把各种调用方式和注册表实况都打出来。
             怀疑点：getLoginItemSettings() 不带参数时，Windows 侧会拿「空的 path」
             和注册表里的命令行做字符串比对，于是 open_at_login 恒为 false ——
             Run 键其实写进去了、开机也会自启，但页面读回来是 false 就把勾去掉了。 */
          if (DIAG.autolaunch) {
            const childProcess = require('child_process');
            const regQ = function (key, name) {
              try {
                const r = childProcess.execFileSync('reg.exe',
                  name ? ['query', key, '/v', name] : ['query', key], { encoding: 'utf8' });
                return r.trim().split(/\r?\n/).filter(function (s) { return s.trim(); });
              } catch (e) { return ['(读不到: ' + String((e && e.message) || e).slice(0, 80) + ')']; }
            };
            const RUN = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
            const SA = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';
            /* 自检绝不能改用户机器的状态：先把原先那串命令行原样记下来 */
            const runLines = regQ(RUN, APP_AUMID);
            const rawBefore = (function () {
              const m = /REG_SZ\s+([\s\S]*)$/.exec(runLines.join('\n'));
              return m ? m[1].trim() : '';
            })();

            diagLog('autolaunch-env', {
              execPath: process.execPath,
              appName: app.getName(),
              aumid: APP_AUMID,
              isPackaged: app.isPackaged,
              args: autoLaunchArgs(),
              runValueBefore: rawBefore || '(无)'
            });
            diagLog('autolaunch-calls', {
              不带参数: app.getLoginItemSettings(),
              用同一套参数: autoLaunchRead(),
              当前判定: autoLaunchEnabled()
            });
            /* 真做一遍开启 → 读回 → 关闭 → 读回 */
            const before = autoLaunchEnabled();
            const afterSet = setAutoLaunch(true);
            diagLog('autolaunch-set', { 设置前: before, 设置后: afterSet });
            diagLog('autolaunch-reread', {
              用同一套参数: autoLaunchRead(),
              现在的状态: autoLaunchEnabled()
            });
            const afterOff = setAutoLaunch(false);
            diagLog('autolaunch-off', { 关闭后: afterOff });
            diagLog('autolaunch-verdict', {
              开启后能读回: afterSet === true,
              关闭后能读回: afterOff === false,
              结论: (afterSet === true && afterOff === false) ? 'OK' : 'FAIL'
            });

            /* 恢复原状：直接把原先那串命令行原样写回注册表。
               不能用 setAutoLaunch(before) —— 开发模式下跑的是 electron.exe，
               路径和注册表里那条（已安装版的 exe）对不上，before 会是 false，
               「恢复」反而会把用户真正的自启项删掉。 */
            if (rawBefore) {
              try {
                childProcess.execFileSync('reg.exe',
                  ['add', RUN, '/v', APP_AUMID, '/t', 'REG_SZ', '/d', rawBefore, '/f'],
                  { encoding: 'utf8' });
              } catch (e) { diagLog('autolaunch-restore-fail', { message: String((e && e.message) || e).slice(0, 200) }); }
            } else {
              try {
                childProcess.execFileSync('reg.exe', ['delete', RUN, '/v', APP_AUMID, '/f'], { encoding: 'utf8' });
              } catch (e) { }
            }
            diagLog('autolaunch-restored', { 恢复成: rawBefore || '(无)', 现在注册表: regQ(RUN, APP_AUMID) });
          }
          /* 缩放自检：设置页塞一段长说明让卡片真的很高（不塞的话它本来就能塞进窗口，
             测不出「不断缩小」），然后反复改窗口尺寸。
             判据：同一个窗口尺寸必须永远得到同一个缩放比 —— 旧代码会随历史一路漂小。 */
          if (DIAG.fit) {
            const probeFit = function () {
              return win.webContents.executeJavaScript(
                '(function(){var c=document.getElementById("setCard");var v=document.getElementById("view");' +
                'var m=/scale\\(([0-9.]+)\\)/.exec(v.style.transform||"");' +
                'var s=m?parseFloat(m[1]):0;' +
                'var w=window.innerWidth,h=window.innerHeight;' +
                'var tb=document.getElementById("titlebar");' +
                'var tbh=tb?parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--tb-h"))||0:0;' +
                'var availH=Math.max(1,h-tbh);' +
                /* 期望值：只由当前窗口尺寸决定（设计尺寸 1180×801） */
                'var want=Math.min(w/1180, availH/801, 4);' +
                'return {win:w+"x"+h, scale:+s.toFixed(4), 期望:+want.toFixed(4), ' +
                '偏差:+Math.abs(s-want).toFixed(4), ' +
                '卡片可视高:c?c.clientHeight:0, 卡片内容高:c?c.scrollHeight:0, ' +
                '页面可视高:getComputedStyle(document.documentElement).getPropertyValue("--page-view-h").trim()};})()',
                true);
            };
            /* 先看主界面（没切设置页）的缩放比 */
            await win.webContents.executeJavaScript(
              'document.getElementById("tabHome").click(); true;', true);
            await new Promise(function (r) { setTimeout(r, 700); });
            diagLog('fit-home', await probeFit());

            /* 模拟「跨屏 / 改系统缩放」走一遍 applyDisplay：
               它现在【不该】再改窗口尺寸和位置了（以前按 k 重算尺寸再 setBounds，
               踩在 electron#51679 上会把窗口算得溢出工作区）。 */
            const bBefore = win.getBounds();
            applyDisplay(true);
            await new Promise(function (r) { setTimeout(r, 600); });
            const bAfter = win.getBounds();
            diagLog('fit-applydisplay', {
              改之前: bBefore.width + 'x' + bBefore.height + '@' + bBefore.x + ',' + bBefore.y,
              改之后: bAfter.width + 'x' + bAfter.height + '@' + bAfter.x + ',' + bAfter.y,
              尺寸没变: bBefore.width === bAfter.width && bBefore.height === bAfter.height,
              位置没变: bBefore.x === bAfter.x && bBefore.y === bAfter.y
            });

            /* 切到设置页，并塞长说明让卡片撑高 */
            await win.webContents.executeJavaScript(
              '(function(){var r=document.getElementById("updNoteRow"),e=document.getElementById("updNote");' +
              'if(r&&e){var o=[];for(var i=1;i<=28;i++){o.push(i+". 这是一行用来测试滚动条的更新说明，故意写长一点。");}' +
              'e.textContent=o.join("\\n");r.hidden=false;}' +
              'document.getElementById("tabSettings").click();return true;})()', true);
            await new Promise(function (r) { setTimeout(r, 800); });
            diagLog('fit-settings-before', await probeFit());

            /* 来回改尺寸：同一尺寸重复出现时，缩放比必须一模一样 */
            const b0 = win.getBounds();
            const steps = [[0, 0], [-60, -43], [-120, -86], [-60, -43], [0, 0], [-120, -86], [-60, -43]];
            const rows = [];
            for (let i = 0; i < steps.length; i++) {
              win.setBounds({
                x: b0.x, y: b0.y,
                width: Math.max(200, b0.width + steps[i][0]),
                height: Math.max(160, b0.height + steps[i][1])
              });
              await new Promise(function (r) { setTimeout(r, 600); });
              const p = await probeFit();
              p.第几步 = i + 1;
              p.尺寸变化 = steps[i][0] + ',' + steps[i][1];
              rows.push(p);
            }
            diagLog('fit-steps', rows);

            /* 待办页的填满逻辑跟着改了（--page-min-h 现在也除以 s），
               确认它没有被裁掉：待办页总高必须 ≤ 窗口在设计空间里的高度 */
            await win.webContents.executeJavaScript(
              'document.getElementById("tabTodo").click(); true;', true);
            await new Promise(function (r) { setTimeout(r, 700); });
            diagLog('fit-todo', await win.webContents.executeJavaScript(
              '(function(){var p=document.getElementById("pageTodo");' +
              'var pv=parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--page-view-h"))||0;' +
              'var pm=parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--page-min-h"))||0;' +
              'return {待办页高:p?p.offsetHeight:0, 窗口设计高:pv, minH变量:pm, ' +
              '装得下:(p?p.offsetHeight:0)<=pv+2};})()', true));

            /* 新加的「科研动态」页是同样两列结构，也要确认装得下、右列不溢出 */
            await win.webContents.executeJavaScript(
              'document.getElementById("tabArxiv").click(); true;', true);
            await new Promise(function (r) { setTimeout(r, 800); });
            diagLog('fit-arxiv', await win.webContents.executeJavaScript(
              '(function(){var p=document.getElementById("pageArxiv");' +
              'var pv=parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--page-view-h"))||0;' +
              'var list=document.getElementById("arxivList");' +
              'var cfg=document.querySelector("#pageArxiv .arxiv-col:last-child");' +
              'var m=/scale\\(([0-9.]+)\\)/.exec((document.getElementById("view")||{}).style.transform||"");' +
              'return {科研页高:p?p.offsetHeight:0, 窗口设计高:pv, 装得下:(p?p.offsetHeight:0)<=pv+2,' +
              ' 左列可视高:list?list.clientHeight:0, 右列高:cfg?cfg.offsetHeight:0,' +
              ' 右列滚动高:cfg?cfg.scrollHeight:0, 右列溢出:cfg?cfg.scrollHeight>cfg.clientHeight+2:null,' +
              ' 缩放比:m?parseFloat(m[1]):0};})()', true));
          }
          /* 连击摸鱼自检：真的装钩子 → 注入 3 下 Ctrl → 应该真的摸鱼
             → 还原 → 关掉 → 钩子进程必须被收掉（不能留幽灵进程） */
          if (DIAG.tap) {
            diagLog('tap-1-before', moyuSnapshot());
            moyuOn = true;
            moyuTapOn = true;
            moyuTapKey = 'ctrl';
            saveMoyuPref();
            applyMoyuShortcut();
            await new Promise(function (r) { setTimeout(r, 2600); });
            diagLog('tap-2-ready', moyuSnapshot());

            /* 注入 3 下 Ctrl（模拟用户连击）。注入的键低级钩子照样收得到 */
            const injLines = [
              'Add-Type @"',
              'using System; using System.Runtime.InteropServices;',
              'public class KkInjD {',
              '  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);',
              '  public static void Tap(int vk, int hold) { keybd_event((byte)vk,0,0,IntPtr.Zero); System.Threading.Thread.Sleep(hold); keybd_event((byte)vk,0,2,IntPtr.Zero); }',
              '}',
              '"@',
              'for ($i = 0; $i -lt 3; $i++) { [KkInjD]::Tap(0x11, 60); Start-Sleep -Milliseconds 110 }'
            ].join('\n');
            spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
              '-EncodedCommand', Buffer.from(injLines, 'utf16le').toString('base64')],
              { windowsHide: true, stdio: 'ignore' });
            await new Promise(function (r) { setTimeout(r, 2200); });
            diagLog('tap-3-fired', { running: moyuRunning, active: !!moyuActiveAccel });

            if (moyuRunning) moyuBack();
            await new Promise(function (r) { setTimeout(r, 1600); });
            diagLog('tap-4-restored', { running: moyuRunning });

            /* 用户报的场景：连按两下 → 隔很久 → 再按一下，绝不能摸鱼。
               注入分两次跑，中间在 Node 这边真的等 2.5 秒（远超 500ms 的间隔）。 */
            const injectTaps = function (times) {
              const lines = [
                'Add-Type @"',
                'using System; using System.Runtime.InteropServices;',
                'public class KkInjSeq {',
                '  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);',
                '  public static void Tap(int vk, int hold) { keybd_event((byte)vk,0,0,IntPtr.Zero); System.Threading.Thread.Sleep(hold); keybd_event((byte)vk,0,2,IntPtr.Zero); }',
                '}',
                '"@',
                'for ($i = 0; $i -lt ' + times + '; $i++) { [KkInjSeq]::Tap(0x11, 60); Start-Sleep -Milliseconds 110 }'
              ].join('\n');
              spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                '-EncodedCommand', Buffer.from(lines, 'utf16le').toString('base64')],
                { windowsHide: true, stdio: 'ignore' });
            };
            diagLog('tap-6-前两下', { running: moyuRunning, note: '先按两下' });
            injectTaps(2);
            await new Promise(function (r) { setTimeout(r, 900); });
            diagLog('tap-7-等很久之后第三下', { running: moyuRunning, note: '隔 2.5 秒再按第三下' });
            await new Promise(function (r) { setTimeout(r, 1600); });
            injectTaps(1);
            await new Promise(function (r) { setTimeout(r, 2000); });
            diagLog('tap-8-隔很久按第三下的结果', {
              running: moyuRunning,
              判定: moyuRunning ? '❌ 不该触发却触发了' : '✅ 没触发（正确）'
            });
            if (moyuRunning) moyuBack();
            await new Promise(function (r) { setTimeout(r, 1200); });

            /* 正常连击还得能触发：两下之后隔 350ms（仍在窗口内）再按第三下 */
            injectTaps(2);
            await new Promise(function (r) { setTimeout(r, 380); });
            injectTaps(1);
            await new Promise(function (r) { setTimeout(r, 1800); });
            diagLog('tap-9-正常连击三下', {
              running: moyuRunning,
              判定: moyuRunning ? '✅ 正常触发' : '❌ 该触发却没触发'
            });
            if (moyuRunning) moyuBack();
            await new Promise(function (r) { setTimeout(r, 1200); });

            /* 用户报的那个 bug 的真身：按住不放时 Windows 会连续补发 keydown
               （间隔约 31ms，没有 keyup）。以前每一下都算「一次连击」，
               于是「前两下 + 第三下按久一点」就凑够三下，凭空摸鱼。
               注入器不发 keyup 就复刻了这个自动重复。 */
            const injectHold = function (downs, gapMs) {
              const lines = [
                'Add-Type @"',
                'using System; using System.Runtime.InteropServices;',
                'public class KkInjHold {',
                '  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);',
                '  public static void Hold(int vk, int downs, int gap) {',
                '    keybd_event((byte)vk,0,0,IntPtr.Zero);',
                '    for (int i = 1; i < downs; i++) { System.Threading.Thread.Sleep(gap); keybd_event((byte)vk,0,0,IntPtr.Zero); }',
                '    System.Threading.Thread.Sleep(60); keybd_event((byte)vk,0,2,IntPtr.Zero);',
                '  }',
                '}',
                '"@',
                '[KkInjHold]::Hold(0x11, ' + downs + ', ' + gapMs + ')'
              ].join('\n');
              spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                '-EncodedCommand', Buffer.from(lines, 'utf16le').toString('base64')],
                { windowsHide: true, stdio: 'ignore' });
            };
            diagLog('tap-10-长按前', { running: moyuRunning, note: '不预先按键，直接按住不放（模拟自动重复）' });
            injectHold(4, 40);          // 一次长按里补发 4 个 keydown（真实的自动重复就是这个样子）
            await new Promise(function (r) { setTimeout(r, 2000); });
            diagLog('tap-11-长按的结果', {
              running: moyuRunning,
              判定: moyuRunning ? '❌ 一次长按被算成连击（bug 复现）' : '✅ 一次长按没被算成连击'
            });
            if (moyuRunning) moyuBack();
            await new Promise(function (r) { setTimeout(r, 1200); });

            /* 关掉连击：钩子进程必须被收掉 */
            moyuTapOn = false;
            applyMoyuShortcut();
            await new Promise(function (r) { setTimeout(r, 900); });
            diagLog('tap-5-stopped', { child: !!moyuTapChild, ready: moyuTapReady });
            /* 截图前滚到连击这块，方便看排版 */
            await win.webContents.executeJavaScript(
              '(function(){var e=document.getElementById("chkTap");' +
              'if(!e)return false;e.scrollIntoView({block:"center"});return true;})()', true);
            await new Promise(function (r) { setTimeout(r, 700); });
          }
          /* 护眼模式自检：开 → 重应用（模拟休眠唤醒）→ 关。
             重点看两件事：色温真的改了没有；重应用有没有把「原始色温备份」
             覆盖成已经调暖的那份（覆盖了就再也回不到原始色温了）。 */
          if (DIAG.eyecare) {
            const hashRamp = function () {
              try {
                return crypto.createHash('sha1')
                  .update(fs.readFileSync(eyeCareRampFile(), 'utf8')).digest('hex').slice(0, 10);
              } catch (e) { return ''; }
            };
            /* 直接读一次伽马表 —— 光看状态字段不够，得看屏幕真实的值。
               B64 明显小于 R64 就是还留在暖色上。 */
            const rampNow = function () {
              return new Promise(function (res) {
                psRun([EYE_WINAPI, 'Write-Output ([KkEye]::Dump())'].join('\n'),
                  function (e, o) {
                    res(String(o || '').replace(/\s+/g, ' ').trim().slice(0, 260));
                  });
              });
            };
            diagLog('eye-care-0-ramp-start', { ramp: await rampNow() });
            diagLog('eye-care-1-before', eyeCareSnapshot());
            diagLog('eye-care-2-on', await eyeCareSet(true));
            /* 开了之后宠物右键菜单里那一项要变成勾上的 */
            diagLog('eye-care-2b-pet-menu', { 菜单: petMenuSummary() });
            const h1 = hashRamp();
            await new Promise(function (r) { setTimeout(r, 1200); });
            diagLog('eye-care-3-reapply', await eyeCareApply('on'));
            const h2 = hashRamp();
            diagLog('eye-care-4-snapshot-stable', { before: h1, after: h2, same: !!h1 && h1 === h2 });
            await new Promise(function (r) { setTimeout(r, 1200); });
            /* 拖色温滑杆：改色温也要走同一条路，而且同样不能覆盖原始备份。
               注意 3000K 在本机驱动上会被拒，ApplyWarmBest 会退到 3300 并回报，
               所以这里期望的 kelvin 是「退让之后的值」而不是 3000。 */
            diagLog('eye-care-5-kelvin-3000', await eyeCareSet(true, 3000));
            const h3 = hashRamp();
            diagLog('eye-care-6-kelvin-snapshot-stable', { before: h1, after: h3, same: !!h1 && h1 === h3 });
            diagLog('eye-care-7-kelvin-clamp', {
              要100: (await eyeCareSet(true, 100)).kelvin,       // 先钳到 2700，驱动不接受再退让
              要99999: (await eyeCareSet(true, 99999)).kelvin    // 钳到 6500
            });
            diagLog('eye-care-8-kelvin-back', await eyeCareSet(true, 4500));
            await new Promise(function (r) { setTimeout(r, 1000); });

            /* 模拟「重启程序时上次是开着的」：存盘 → 假装刚启动 → 重新读盘 →
               走一遍启动路径。伽马表是显卡的全局状态，重开程序不会自己恢复，
               全靠这条路径补上。 */
            await eyeCareSet(true, 4200);
            const saved = eyeCareSnapshot();
            eyeCareOn = false;
            loadEyeCarePref();
            const loaded = eyeCareSnapshot();
            diagLog('eye-care-12-restart-load', {
              存盘时: { on: saved.on, kelvin: saved.kelvin },
              读回: { on: loaded.on, kelvin: loaded.kelvin },
              一致: saved.on === loaded.on && saved.kelvin === loaded.kelvin
            });
            initEyeCare();
            await new Promise(function (r) { setTimeout(r, 1600); });
            diagLog('eye-care-13-restart-init', eyeCareSnapshot());

            diagLog('eye-care-9-off', await eyeCareSet(false));
            diagLog('eye-care-9b-ramp-after-off', { ramp: await rampNow() });
            diagLog('eye-care-10-files', {
              pref: fs.existsSync(eyeCarePrefFile()),
              ramp: fs.existsSync(eyeCareRampFile()),
              prefBody: (function () { try { return fs.readFileSync(eyeCarePrefFile(), 'utf8'); } catch (e) { return ''; } })()
            });
            /* 页面的勾 / 滑杆有没有跟着主进程走（关掉之后必须是没勾、滑杆停在 4500） */
            diagLog('eye-care-11-ui', await win.webContents.executeJavaScript(
              '(function(){var c=document.getElementById("chkEyeCare");' +
              'var c2=document.getElementById("chkEyeSet");var k=document.getElementById("eyeK");' +
              'var o=document.getElementById("eyeKOut");var m=document.getElementById("eyeCareMsg");' +
              'var e=document.getElementById("eyeErr");var r=document.getElementById("desktopPetRow");' +
              'return {主界面勾:c?c.checked:null, 设置页勾:c2?c2.checked:null, 禁用:c?c.disabled:null, ' +
              '滑杆:k?k.value:null, 滑杆范围:k?k.min+"-"+k.max:null, 档位文字:o?o.textContent:null, ' +
              '主界面提示:m?m.textContent:"", 提示隐藏:m?m.hidden:null, ' +
              '错误提示:e?e.textContent:"", 错误隐藏:e?e.hidden:null, 整行显示:r?!r.hidden:null};})()', true));
          }
          /* 更新流程自检：点「检查更新」→ 点「下载新版本」→ 等结束 → 校验合并后的整包 */
          if (DIAG.update) {
            const clickBtn = function (id) {
              return win.webContents.executeJavaScript(
                '(function(){var b=document.getElementById("' + id + '");' +
                'if(!b||b.hidden||b.disabled)return false;b.click();return true;})()', true);
            };
            await clickBtn('btnUpdCheck');
            await new Promise(function (r) { setTimeout(r, 5000); });
            diagLog('update-checked', updateSnapshot());
            diagLog('update-download-click', { clicked: await clickBtn('btnUpdDownload') });
            for (let i = 0; i < 60; i++) {
              await new Promise(function (r) { setTimeout(r, 500); });
              if (updateState === 'downloaded' || updateState === 'error') break;
            }
            diagLog('update-final', updateSnapshot());
            const f = updateMergedExe;
            diagLog('update-merged', {
              file: f || '',
              exists: !!(f && fs.existsSync(f)),
              size: (f && fs.existsSync(f)) ? fs.statSync(f).size : 0,
              sha512: (f && fs.existsSync(f))
                ? crypto.createHash('sha512').update(fs.readFileSync(f)).digest('base64') : ''
            });
          }
          const shot = await runDiagnose();
          diagLog('result', shot);
          console.log('[DIAG-RESULT] ' + JSON.stringify(shot));
          /* 额外把桌面宠物窗也截一张，用来肉眼确认宠物渲染正常 */
          if (DIAG.pet && petWin && !petWin.isDestroyed()) {
            try {
              const pimg = await petWin.capturePage();
              const p = DIAG.shot.replace(/\.png$/, '-pet.png');
              fs.writeFileSync(p, pimg.toPNG());
              diagLog('pet-shot', { file: p, size: pimg.getSize() });
            } catch (e) { diagLog('pet-shot-error', { message: String(e && e.message || e) }); }
          }
        } catch (e) {
          /* 自检中途故意重载页面换阶段：这一轮就地结束，等新的一轮接着跑，别退出 */
          if (e && e.diagRestart) return;
          diagLog('error', { message: String(e && e.message || e) });
          console.log('[DIAG-ERROR] ' + (e && e.message ? e.message : e));
        }
        if (DIAG.arxivHold) {
          /* 自检要求「先别退出」：外面要用真鼠标点气泡。
             气泡 15 秒后自己收，所以留 40 秒足够；超时也自己退，别留个孤儿进程。 */
          diagLog('diag-hold', { 说明: '保持运行，等外面点气泡', pid: process.pid });
          setTimeout(function () { try { app.exit(0); } catch (e) { } }, 40000);
          return;
        }
        quitting = true;
        /* --diag-eyequit 要验证「正常退出会不会还原色温」，所以走真正的 app.quit()，
           让 will-quit 跑一遍；其它自检仍然是 app.exit(0) 直接走人。 */
        if (DIAG.eyequit) { try { app.quit(); } catch (e) { } } else { try { app.exit(0); } catch (e) { } }
      }, 1500 + (DIAG.wait || 0));
    });
  }

  /* 跨屏拖动：Windows 下窗口一进到另一块屏，CSS 尺寸就变了。
     这里在拖动停下来之后把窗口逻辑尺寸换成新屏的 k，并把新缩放发给页面。
     拖动过程中不动窗口（不然会把用户的拖动打断）。 */
  let moveTimer = null;
  win.on('move', () => {
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    const d2 = displayOf(b.x + Math.max(1, b.width) / 2, b.y + 8);
    const px = effScale(d2);
    if (sameScale(px, curPixelRatio)) { if (forceDpiPending) sendDpiInfo(); return; }
    forceDpiPending = true;
    if (moveTimer) clearTimeout(moveTimer);
    moveTimer = setTimeout(() => { moveTimer = null; forceDpiPending = false; applyDisplay(true); }, 180);
  });

  // 点 ✕ = 收进托盘，而不是退出
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    hideToTray();
  });

  win.on('closed', () => { win = null; });

  /* 用户调整了窗口大小 / 位置 → 记住（下次启动恢复） */
  win.on('resize', scheduleWinStateSave);
  win.on('move', scheduleWinStateSave);

  /* 显示 / 隐藏要让渲染进程知道：隐藏时它会把动画和 DOM 刷新全停掉。
     之前收进托盘还占着近两个核心，就是因为隐藏时啥都没停。 */
  win.on('show', () => send('win-visible', true));
  win.on('hide', () => send('win-visible', false));
  win.on('minimize', () => send('win-visible', false));
  win.on('restore', () => send('win-visible', true));
}

/* ------------------------------------------------- 到点：抢到最前面 */
function bringToFront() {
  if (!win) return;

  wasHidden = !win.isVisible() || win.isMinimized();
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();

  win.setSkipTaskbar(false);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.show();
  win.moveTop();
  win.focus();
  win.flashFrame(true);

  const area = screen.getPrimaryDisplay().workAreaSize;
  const b = win.getBounds();
  win.setBounds({
    x: Math.round((area.width - Math.min(b.width, area.width)) / 2),
    y: Math.round((area.height - Math.min(b.height, area.height)) / 3),
    width: Math.min(b.width, area.width),
    height: Math.min(b.height, area.height)
  });
}

/* ------------------------------------------------------------ 托盘 */
function buildTray() {
  try {
    /* 优先用多尺寸 ICO：系统会按 DPI 挑最合适的那一档，比单张 PNG 清楚 */
    let img = nativeImage.createFromPath(iconPath());
    if (img.isEmpty()) img = nativeImage.createFromPath(path.join(__dirname, 'tray.png'));
    if (img.isEmpty()) img = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
    tray = new Tray(img);
  } catch (err) {
    return;
  }
  tray.setToolTip('别感冒 · 喝水休息提醒器');
  tray.on('click', toggleWindow);
  tray.on('double-click', showWindow);
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  const tpl = [
    { label: '显示主界面', click: showWindow },
    { label: '桌面宠物（独立小窗，可与主界面同时显示）', type: 'checkbox', checked: petOn, click: (mi) => setPetOn(mi.checked) },
    { label: '桌面日历（桌面挂件：左边备忘录 + 右边月历）', type: 'checkbox', checked: calOn, click: (mi) => setCalOn(mi.checked, true) },
    { type: 'separator' },
    { label: '🕰 十二时辰对照表', click: () => { showWindow(); send('show-shichen'); } },
    { label: '＋ 添加提醒事项', click: () => { showWindow(); send('add-item'); } },
    { label: '📝 待办与备忘', click: () => { showWindow(); send('show-todo'); } },
    { label: '📖 日记', click: () => { showWindow(); send('show-diary'); } },
    { label: '🔬 科研动态（arXiv 论文）', click: () => { showWindow(); send('show-arxiv'); } },
    { label: '⚙ 设置', click: () => { showWindow(); send('show-settings'); } },
    { type: 'separator' }
  ];

  /* 「立即提醒」按用户自己的提醒列表动态生成 */
  if (menuItems.length) {
    menuItems.forEach(it => {
      tpl.push({
        label: '立即提醒：' + (it.emoji || '') + ' ' + it.name,
        click: () => alertNow(it.id)
      });
    });
  } else {
    tpl.push({ label: '（还没有提醒事项）', enabled: false });
  }

  tpl.push({ type: 'separator' });
  tpl.push({
    label: timersRunning ? '⏸ 暂停计时' : '▶ 继续计时',
    click: () => send('tray-toggle')
  });
  tpl.push({ type: 'separator' });
  tpl.push({ label: '退出', click: quitApp });

  tray.setContextMenu(Menu.buildFromTemplate(tpl));
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function alertNow(id) {
  showWindow();
  send('tray-alert', id);
}

/* 用户可以把主界面推到屏幕外面去（暂时不挡东西）。这时候从托盘 / 菜单
   「显示主界面」把它叫出来，得先把它拉回屏内 —— 否则点半天没反应，
   会以为程序坏了。窗口只要不是「完整地在某块屏里」，就整体拉回工作区。 */
function rescueWindowIntoView() {
  if (!win || win.isDestroyed()) return false;
  const b = win.getBounds();
  const d = displayOf(b.x + Math.max(1, b.width) / 2, b.y + Math.max(1, b.height) / 2);
  const wa = d.workArea;
  const fullyInside = b.x >= wa.x && b.y >= wa.y &&
    b.x + b.width <= wa.x + wa.width && b.y + b.height <= wa.y + wa.height;
  if (fullyInside) return false;
  const pos = clampToWorkArea(b.x, b.y, b.width, b.height,
    { x: wa.x + wa.width / 2, y: wa.y + wa.height / 2 }, winInsetDip());
  win.setBounds({ x: pos.x, y: pos.y, width: b.width, height: b.height });
  return true;
}

function showWindow() {
  if (!win) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  rescueWindowIntoView();
  win.show();
  win.focus();
}

function toggleWindow() {
  if (!win) { createWindow(); return; }
  if (win.isVisible() && !win.isMinimized()) win.hide();
  else showWindow();
}

/* silent=true 时不弹「躲进托盘了」的提示气泡 —— 一键摸鱼要的就是低调，
   这时候冒个气泡反而把注意力吸过来 */
function hideToTray(silent) {
  if (!win) return;
  hideBubble();                 // 气泡是独立小窗，收托盘时要一起收掉
  win.hide();
  if (silent) return;
  if (!balloonShown && tray && typeof tray.displayBalloon === 'function') {
    balloonShown = true;
    try {
      tray.displayBalloon({
        title: '坤坤躲到托盘里了',
        content: '到点会自动跳出来提醒你。点托盘图标可以随时叫出来 / 收起。'
      });
    } catch (e) { }
  }
}

function quitApp() {
  quitting = true;
  if (bubbleWin && !bubbleWin.isDestroyed()) {
    try { bubbleWin.destroy(); } catch (e) { }
  }
  app.quit();
}

/* ============================================================ 桌面宠物（独立窗口）
   一个透明的置顶小窗，和主界面【同时存在】：
     · 勾上「桌面宠物」→ 出现在主界面所在那块屏的右下角，之后一直待在桌面上
     · 整窗可拖（限位在屏幕可用区内），右键出原生菜单
     · 点一下会说话（气泡是又一扇独立小窗，见下面 bubble 那段）
     · 尺寸由「物理尺寸 ÷ 真实像素比」决定，页面里 fit 用同一个因子，换屏大小不变 */
let petWin = null;
let petWinFactor = 1;       // 宠物窗上次是按哪个像素比摆的
let petHome = null;         // 宠物窗的「家」：拖动后同步，气泡按它摆位
let talkOpen = false;

/* 宠物该出现在哪：优先跟随主界面所在的屏 */
function petTargetArea() {
  let base = null;
  if (win && !win.isDestroyed()) base = win.getBounds();
  else if (petWin && !petWin.isDestroyed()) base = petWin.getBounds();
  const px = base ? base.x + Math.max(1, base.width) / 2 : 0;
  const py = base ? base.y + 8 : 0;
  const d = displayOf(px, py);
  return { display: d, wa: d.workArea };
}

function createPetWindow() {
  if (petWin && !petWin.isDestroyed()) return petWin;
  const t = petTargetArea();
  const sz = PET_SIZES[petSize] || PET_SIZES.max;
  const k = realUiK(t.display);
  /* 宠物窗用「档案逻辑尺寸」（150×170 DIP，见 petWindowBox）。它是桌面上的摆件：
     窗口的物理大小 = 逻辑尺寸 × 本屏像素比，而页面里 fit 里带着同一个像素比因子，
     两者相抵 —— 最终在屏幕上恒定 150×170 物理像素。 */
  const box = UI.petWindowBox(sz.w, sz.h, 1);
  petWinFactor = k;

  /* 初始位置：优先用上次拖到的地方（还在屏幕内的话），否则默认右下角 */
  const saved = loadPetPos();
  const homePos = petPosStillOnScreen(saved)
    ? { x: saved.x, y: saved.y }
    : { x: t.wa.x + t.wa.width - box.width - 28, y: t.wa.y + t.wa.height - box.height - 28 };

  petWin = new BrowserWindow({
    x: homePos.x,
    y: homePos.y,
    width: box.width,
    height: box.height,
    minWidth: 1, minHeight: 1,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,              // 大小只由「宠物大小」菜单决定
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,             // 不进任务栏，只在托盘留一个图标
    alwaysOnTop: true,
    focusable: true,               // 要能拖、能右键
    show: false,
    title: '桌面宠物',
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'pet-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false
    }
  });
  petWin.setAlwaysOnTop(true, 'floating');
  petWin.loadFile(path.join(__dirname, 'pet.html'));

  /* 宠物被拖到别块屏之后：按那块的缩放重新定尺寸（物理大小不变），
     拖动过程中不动窗口，等停下来再重排。 */
  let moveTimer = null;
  petWin.on('move', () => {
    if (!petWin || petWin.isDestroyed()) return;
    const b = petWin.getBounds();
    const d = displayOf(b.x + Math.max(1, b.width) / 2, b.y + Math.max(1, b.height) / 2);
    if (sameScale(d.scaleFactor, petWinFactor)) {
      petHome = { x: b.x, y: b.y, width: b.width, height: b.height };
      return;
    }
    if (moveTimer) clearTimeout(moveTimer);
    moveTimer = setTimeout(() => { moveTimer = null; layoutPetWin(true); }, 180);
  });

  petWin.on('show', () => { if (petWin) petWin.webContents.send('pet-win-visible', true); });
  petWin.on('hide', () => { if (petWin) petWin.webContents.send('pet-win-visible', false); hideBubble(); });
  petWin.on('closed', () => { petWin = null; petBooted = false; hideBubble(); });
  return petWin;
}

/* 按当前档位与所在屏的缩放摆好宠物窗（尺寸 + 位置都在这里定） */
function layoutPetWin(keepCenter) {
  if (!petWin || petWin.isDestroyed()) return null;
  const b = petWin.getBounds();
  const d = displayOf(b.x + Math.max(1, b.width) / 2, b.y + Math.max(1, b.height) / 2);
  const sz = PET_SIZES[petSize] || PET_SIZES.max;
  const px = (d && d.scaleFactor) || 1;
  const kNew = realUiK(d);
  /* 窗口逻辑尺寸就用档位本身（150×170 DIP）：物理大小是它的 px 倍，
     而页面 fit 里带着同样的 px 因子，最终屏幕上的宠物恒定那么大。 */
  const want = { width: sz.w, height: sz.h };
  const next = UI.rescaleBox(b, petWinFactor, kNew, d.workArea, 'center', want);
  petWinFactor = kNew;
  /* 先放开尺寸限制再设值：Windows 会把 setBounds 夹到 minimumSize 上 */
  petWin.setMinimumSize(1, 1);
  petWin.setBounds(next);
  petHome = { x: next.x, y: next.y, width: next.width, height: next.height };
  if (petWin.webContents && !petWin.webContents.isLoading()) {
    petWin.webContents.send('pet-win-display', petDisplayInfo(d));
    petWin.webContents.send('pet-win-size', petSize);
  }
  return next;
}

/* 宠物窗/气泡窗用的屏幕缩放信息（真实像素比，不吃 --diag 的模拟值） */
function petDisplayInfo(d) {
  return {
    realPixelRatio: (d && d.scaleFactor) || 1,
    realScale: realUiK(d),
    basePixelRatio: basePixelRatio,
    sound: petSoundOn,
    skin: petSkin
  };
}

/* 换屏 / 改系统缩放后调用 */
function applyPetDisplay() {
  if (!petWin || petWin.isDestroyed()) return;
  layoutPetWin(true);
}

/* 桌面日历同理：跟着自己所在的屏重新摆一次 */
function applyCalDisplay() {
  if (!calWin || calWin.isDestroyed()) return;
  layoutCalWin();
}

/* 勾选 / 取消「桌面宠物」 */
function setPetOn(on) {
  petOn = !!on;
  if (petOn) showPet();
  else {
    hideBubble();
    if (petWin && !petWin.isDestroyed()) petWin.hide();
  }
  refreshTrayMenu();
  if (win && !win.isDestroyed()) win.webContents.send('pet-on-changed', petOn);
  return petOn;
}

function showPet() {
  const w = createPetWindow();
  layoutPetWin(false);
  if (petBooted) { w.showInactive(); return; }
  /* 页面还没画好：等它加载完再显示，避免「先闪一个空窗」 */
  w.webContents.once('did-finish-load', function () {
    if (!petOn || !petWin || petWin.isDestroyed()) return;
    petWin.webContents.send('pet-win-sound', petSoundOn);
    petWin.webContents.send('pet-win-skin', petSkin);
    const ph = petHome || petWin.getBounds();
    petWin.webContents.send('pet-win-display', petDisplayInfo(displayOf(ph.x, ph.y)));
  });
}

/* ------------------------------------------------------------ 宠物大小 */
function setPetSize(name) {
  if (!PET_SIZES[name]) return petSize;
  petSize = name;
  if (petOn) layoutPetWin(false);
  refreshTrayMenu();
  if (win && !win.isDestroyed()) win.webContents.send('pet-size-changed', petSize);   // 同步回主界面
  return petSize;
}

/* ------------------------------------------------------------ 宠物形象 */
function setPetSkin(id) {
  if (typeof id !== 'string' || !id) return currentSkin;
  currentSkin = id;
  petSkin = id;
  if (petWin && !petWin.isDestroyed()) petWin.webContents.send('pet-win-skin', id);
  refreshTrayMenu();
  return currentSkin;
}

/* 主界面「宠物形象」下拉框切换 → 主进程统一改桌面宠物（缺这条桌面宠物就不会变） */
ipcMain.on('skin-changed', (e, id) => { setPetSkin(id); });

/* ============================================================== 桌面日历
   桌面上的待办日历挂件：左边备忘录、右边月历，每天格子里按优先级画当天的待办。
   和桌面宠物一样是独立小窗（透明 + 无边框 + 置顶 + 不进任务栏），
   但数据不归主进程算 —— 主界面把待办/备忘录推过来，这里只做缓存 + 转发：
       主界面（localStorage 里才是真数据）→ 'cal-todos'/'cal-memos' → 缓存 → 日历窗
   窗口尺寸固定 940×600 DIP（k≡1，和主界面同一套 DPI 模型）；
   ⚠️ resizable:false —— 限位时【不能】加「无边框+可调整大小」那圈余量，
   否则就会像以前的宠物窗一样贴不到桌面边。 */
/* 设计尺寸。高度从 680 收到 610：用户反馈原来那张卡片太高、太占屏幕。
   压扁之后月历格子变矮，格子里最多画几条也从 3 降到 2（见 cal.js 的 MAX_BARS），
   不然「一行日期 + 3 条待办」会把格子挤爆。 */
const CAL_BOX = { width: 940, height: 610 };
let calOn = false;              // 用户是否勾选了「桌面日历」
let calWin = null;
let calBooted = false;          // 日历页是否已经画好（画好之前不显示，避免闪空窗）
let calTodos = [];              // 主界面推过来的待办快照
let calMemos = [];              // 主界面推过来的备忘录快照
let calStyle = { theme: 'light', opacity: 97, scale: 1, locked: false };   // 主题 + 不透明度 + 缩放 + 固定（主界面设置页持有）
let calHome = null;             // 拖动后的位置（重排都按它算）
let calDragState = null;

/* 查本进程各窗口的真实 Z 序（EnumWindows 就是按 Z 序从上往下列的）。
   用来验证「开机时日历不许压在主界面上」—— Electron 自己看不到 Z 序。 */
function windowZOrder() {
  return new Promise(function (res) {
    const ps = [
      '$ErrorActionPreference = "SilentlyContinue"',
      /* 输出统一转 UTF-8，免得窗口标题里的中文在管道里变乱码 */
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      'Add-Type @"',
      'using System; using System.Text; using System.Runtime.InteropServices;',
      'public class KkZ {',
      '  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);',
      '  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);',
      '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
      '  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);',
      '  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
      '  public delegate bool EnumProc(IntPtr h, IntPtr p);',
      '  public static string Dump(int want) {',
      '    var sb = new StringBuilder(); int i = 0;',
      '    EnumWindows(delegate(IntPtr h, IntPtr p) {',
      '      uint wp; GetWindowThreadProcessId(h, out wp);',
      '      if (wp == (uint)want && IsWindowVisible(h)) {',
      '        int n = GetWindowTextLength(h); var s = new StringBuilder(n + 2);',
      '        GetWindowText(h, s, s.Capacity);',
      '        sb.Append(i).Append(" | ").Append(s.ToString()).Append("\\n");',
      '      }',
      '      i++; return true;',
      '    }, IntPtr.Zero);',
      '    return sb.ToString();',
      '  }',
      '}',
      '"@',
      /* ⚠️ 要传 Electron 自己的 pid：脚本跑在 powershell.exe 里，
         GetCurrentProcess() 拿到的是 PowerShell 的 pid，那样一个窗口都查不到 */
      'Write-Output ([KkZ]::Dump(' + process.pid + '))'
    ].join('\n');
    psRun(ps, function (e, o) { res(String(o || '').trim()); });
  });
}

/* 日历窗位置持久化：拖到哪儿下次还在哪儿（和 pet-position.json 一个路子） */
function calPosFile() {
  try { return path.join(app.getPath('userData'), 'cal-position.json'); }
  catch (e) { return null; }
}
function loadCalPos() {
  const f = calPosFile();
  if (!f) return null;
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (j && typeof j.x === 'number' && typeof j.y === 'number') return { x: j.x, y: j.y };
  } catch (e) { /* 第一次没有 / 文件坏了，就当没存过 */ }
  return null;
}
function saveCalPos(x, y) {
  const f = calPosFile();
  if (!f) return;
  try {
    fs.writeFileSync(f, JSON.stringify({ x: Math.round(x), y: Math.round(y) }), 'utf8');
  } catch (e) { /* 存不上不致命 */ }
}
/* 存的位置还在不在某块屏的可用区里（拔显示器 / 改分辨率后别让它跑到看不见的地方） */
function calPosStillOnScreen(p) {
  if (!p) return false;
  /* ⚠️ 不光要求左上角在屏内，还要求【整块窗都能装进那块屏】：
     日历横跨两块屏时（两块屏缩放比例常常不同、DIP 之间还有空隙），
     Windows 只按其中一块的缩放渲染，另一边就被裁掉一截 —— 用户报过
     「右边和下边显示不全」，查出来窗口正好停在主屏右边界 1707 上。 */
  const wa = displayOf(p.x, p.y).workArea;
  const w = (typeof p.w === 'number') ? p.w : CAL_BOX.width;
  const h = (typeof p.h === 'number') ? p.h : CAL_BOX.height;
  return p.x >= wa.x && p.y >= wa.y &&
    p.x + w <= wa.x + wa.width && p.y + h <= wa.y + wa.height;
}

/* 把日历整个收进「和它重叠最多的那块屏」的可用区（只挪位置，不改尺寸 ——
   尺寸是缩放说了算，这里动它会和 setZoomFactor 打架）。
   拖动结束、恢复旧位置、缩放之后都过一遍，横跨两块屏的情况就不会留下来。
   注意：这【不影响】贴边 —— 收进来之后仍然可以停在 (wa.x, wa.y)，也就是左上角严丝合缝。 */
function snapCalIntoOneDisplay(tag) {
  if (!calWin || calWin.isDestroyed()) return false;
  const b = calWin.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  if (b.width > wa.width || b.height > wa.height) return false;   // 比整块屏还大就不管了
  const x = Math.min(Math.max(b.x, wa.x), wa.x + (wa.width - b.width));
  const y = Math.min(Math.max(b.y, wa.y), wa.y + (wa.height - b.height));
  if (x === b.x && y === b.y) return false;
  calWin.setBounds({ x: x, y: y, width: b.width, height: b.height });
  diagLog('cal-snap-into-display', {
    哪一步: tag || '',
    原来: b.x + ',' + b.y, 收到: x + ',' + y,
    这块屏可用区: wa.x + ',' + wa.y + ' ' + wa.width + 'x' + wa.height
  });
  return true;
}

/* 日历窗该出现在哪：跟着主界面所在的屏走（和宠物同一套判断） */
function calTargetArea() {
  let base = null;
  if (win && !win.isDestroyed()) base = win.getBounds();
  else if (calWin && !calWin.isDestroyed()) base = calWin.getBounds();
  const px = base ? base.x + Math.max(1, base.width) / 2 : 0;
  const py = base ? base.y + 8 : 0;
  const d = displayOf(px, py);
  return { display: d, wa: d.workArea };
}

/* 窗口尺寸：装得下就 940×600，屏幕太小就按可用区缩（页面里有 --fit 跟着缩） */
function calWindowBox(wa) {
  return {
    width: Math.max(320, Math.min(CAL_BOX.width, Math.max(1, wa.width))),
    height: Math.max(260, Math.min(CAL_BOX.height, Math.max(1, wa.height)))
  };
}

function createCalWindow() {
  if (calWin && !calWin.isDestroyed()) return calWin;
  const t = calTargetArea();
  const box = calWindowBox(t.wa);

  /* 初始位置：优先用上次拖到的地方，否则默认右上角（宠物默认在右下，错开）。
     ⚠️ 存下来的位置要连尺寸一起验收：只有「整块装得进某块屏」才用，
     否则宁可按默认位置摆 —— 横跨两块屏的话 Windows 只会按其中一块渲染，另一边被裁掉。 */
  const saved = loadCalPos();
  const homePos = calPosStillOnScreen(saved ? { x: saved.x, y: saved.y, w: box.width, h: box.height } : null)
    ? { x: saved.x, y: saved.y }
    : { x: t.wa.x + t.wa.width - box.width - 28, y: t.wa.y + 28 };

  calWin = new BrowserWindow({
    x: homePos.x,
    y: homePos.y,
    width: box.width,
    height: box.height,
    minWidth: 200, minHeight: 200,
    frame: false,
    transparent: true,              // 圆角卡片之外要真透明
    backgroundColor: '#00000000',
    hasShadow: false,
    /* Win11 会给无边框窗口自己加圆角+投影，那圈投影是【直角】的，
       在卡片圆角外会露出直角痕迹 —— 关掉，圆角完全由 CSS 画 */
    roundedCorners: false,
    resizable: false,               // 大小固定，不跟着用户拉
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,              // 不进任务栏
    /* ⚠️ 故意【不】置顶：它是摆在桌面上的挂件，置顶会把别的软件全挡住，
       点别的窗口就让到后面去，要看它用托盘菜单或主界面那个勾再叫出来。 */
    focusable: true,                // 要能点格子、能拖
    show: false,
    title: '桌面日历',
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'cal-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false
    }
  });
  calWin.loadFile(path.join(__dirname, 'cal.html'));

  /* 拖动过程中随时记下位置（松手时再落盘），跟宠物窗一个逻辑 */
  calWin.on('move', () => {
    if (!calWin || calWin.isDestroyed()) return;
    const b = calWin.getBounds();
    calHome = { x: b.x, y: b.y, width: b.width, height: b.height };
  });
  calWin.on('show', () => { if (calWin) calWin.webContents.send('cal-win-visible', true); });
  calWin.on('closed', () => { calWin = null; calBooted = false; });
  return calWin;
}

/* 按可用区摆好日历窗（位置在界内 + 尺寸适配） */
function layoutCalWin() {
  if (!calWin || calWin.isDestroyed()) return null;
  const b = calWin.getBounds();
  const d = displayOf(b.x + Math.max(1, b.width) / 2, b.y + Math.max(1, b.height) / 2);
  const box = calWindowBox(d.workArea);
  /* 位置保持不动，只把尺寸和越界位置拉回来（resizable:false，所以不加 inset） */
  const pos = clampToWorkArea(b.x, b.y, box.width, box.height,
    { x: b.x + b.width / 2, y: b.y + b.height / 2 });
  calWin.setMinimumSize(1, 1);
  calWin.setBounds({ x: pos.x, y: pos.y, width: box.width, height: box.height });
  calHome = { x: pos.x, y: pos.y, width: box.width, height: box.height };
  sendCalFit();
  return calHome;
}

/* 告诉日历页「窗口实际多大」，页面按它算整体缩放 */
function sendCalFit() {
  if (!calWin || calWin.isDestroyed()) return;
  const b = calWin.getBounds();
  /* ⚠️ 报给页面的必须是【CSS 空间】的尺寸：网页整体缩放了 s 倍之后，
     940×680 的布局正好铺满 940s×680s 的窗口，除以缩放系数 --fit 才等于 1，
     否则缩小到 0.8 倍时会被再缩一次（0.64），卡片平白小一圈。 */
  let z = 1;
  try { z = calWin.webContents.getZoomFactor() || 1; } catch (e) { }
  calWin.webContents.send('cal-fit', {
    width: Math.round(b.width / z),
    height: Math.round(b.height / z)
  });
}

/* 待办数据统一从这里进：主界面推的、自检造的，都走同一条路 */
function applyCalTodos(list) {
  calTodos = Array.isArray(list) ? list.filter(function (t) {
    return t && t.id && t.dueAt;
  }).map(function (t) {
    return {
      id: String(t.id),
      text: String(t.text == null ? '' : t.text).slice(0, 60),
      done: !!t.done,
      dueAt: +t.dueAt || 0,
      prio: (t.prio === 'high' || t.prio === 'low') ? t.prio : 'mid',
      /* 重复规则原样透传给日历页（那边只画「本期」这一条） */
      repeat: t.repeat || null,
      repeatText: String(t.repeatText || '')
    };
  }) : [];
  if (calWin && !calWin.isDestroyed()) calWin.webContents.send('cal-todos', calTodos);
  return calTodos;
}

/* 主题 / 不透明度 / 缩放 / 固定：主界面设置页推过来，这里只做缓存 + 转发
   （日历页面一加载就补发一次）。缩放要动窗口，所以在这里一起算。 */
const CAL_SCALE_STEPS = [0.8, 0.9, 1, 1.1, 1.2, 1.35, 1.5];
function calScaleIndex(s) {
  let i = 0, best = Infinity;
  CAL_SCALE_STEPS.forEach(function (v, k) {
    const d = Math.abs(v - s);
    if (d < best) { best = d; i = k; }
  });
  return i;
}
/* 按缩放把窗口调成「设计尺寸 × 缩放」，并把网页整体缩放同样的倍数：
   这样 CSS 布局仍然是 940×680，内容整体变大变小，窗口正好装得下。
   屏幕装不下就往回收（比如 1.5 倍在 768 高的笔记本上放不下），
   所以推回页面的 scale 是【实际生效】的那个值。 */
function applyCalZoom() {
  if (!calWin || calWin.isDestroyed()) return;
  const want = Math.min(1.5, Math.max(0.8, Number(calStyle.scale) || 1));
  const b = calWin.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  let s = want;
  /* 屏幕装不下就往回收。⚠️ 这里【不能】再套 Math.min(1, …)：
     那等于把上限锁死成 1 倍，放大永远被压回 100%（自检里踩过）。 */
  const fitS = Math.min((wa.width - 8) / CAL_BOX.width, (wa.height - 8) / CAL_BOX.height);
  if (s > fitS) s = Math.max(0.5, fitS);
  const w = Math.round(CAL_BOX.width * s), h = Math.round(CAL_BOX.height * s);
  /* 位置以左上角为锚（用户把日历摆哪儿就以哪儿为准），超出屏幕就往回收 */
  let nx = b.x, ny = b.y;
  if (nx + w > wa.x + wa.width) nx = wa.x + wa.width - w;
  if (ny + h > wa.y + wa.height) ny = wa.y + wa.height - h;
  if (nx < wa.x) nx = wa.x;
  if (ny < wa.y) ny = wa.y;
  try { calWin.webContents.setZoomFactor(s); } catch (e) { }
  calWin.setBounds({ x: nx, y: ny, width: w, height: h });
  /* 再设一次缩放：窗口刚创建/刚加载完时第一次 setZoomFactor 可能没生效，
     那会导致「窗口按缩放变大、但网页没缩放」—— 卡片于是装不下被裁掉一截。
     补一次是幂等的，代价只有一行。 */
  try { calWin.webContents.setZoomFactor(s); } catch (e) { }
  snapCalIntoOneDisplay('缩放');            // 缩放后也可能压在两块屏交界上，收一下
  calStyle.scale = s;                       // 实际生效的（可能比点的那档小）
  calStyle.scaleWant = want;                // 用户点的那一档：页面用它判断 ＋/− 到没到头
  calWin.webContents.send('cal-style', calStyle);
  sendCalFit();
}

function applyCalStyle(st) {
  if (st && typeof st === 'object') {
    const prevScale = calStyle.scale;
    calStyle = {
      theme: st.theme === 'dark' ? 'dark' : 'light',
      opacity: Math.min(100, Math.max(30, Math.round(Number(st.opacity) || 97))),
      scale: Math.min(1.5, Math.max(0.8, Number(st.scale) || 1)),
      scaleWant: Math.min(1.5, Math.max(0.8, Number(st.scale) || 1)),
      locked: !!st.locked
    };
    if (!calWin || calWin.isDestroyed()) return calStyle;
    if (calStyle.scale !== prevScale) { applyCalZoom(); return calStyle; }
    calWin.webContents.send('cal-style', calStyle);
    return calStyle;
  }
  if (calWin && !calWin.isDestroyed()) calWin.webContents.send('cal-style', calStyle);
  return calStyle;
}

/* 备忘录同理（左边那一栏） */
function applyCalMemos(list) {
  calMemos = Array.isArray(list) ? list.filter(function (m) {
    return m && m.id && m.text;
  }).map(function (m) {
    return {
      id: String(m.id),
      text: String(m.text).slice(0, 500),
      done: !!m.done,
      at: +m.at || 0
    };
  }) : [];
  if (calWin && !calWin.isDestroyed()) calWin.webContents.send('cal-memos', calMemos);
  return calMemos;
}

/* 勾选 / 取消「桌面日历」。
   raise=true 表示这次是【用户主动点的】（主界面勾选 / 托盘菜单）：要把窗口提到最前，
   否则它不置顶、可能被别的窗口压着，用户会以为没生效；
   开机恢复（raise=false）就安静地显示，不抢主界面焦点。 */
function setCalOn(on, raise) {
  calOn = !!on;
  if (calOn) showCal(!!raise);
  else if (calWin && !calWin.isDestroyed()) calWin.hide();
  refreshTrayMenu();
  if (win && !win.isDestroyed()) win.webContents.send('cal-on-changed', calOn);
  return calOn;
}

/* 把主界面压回日历上面。
   日历是「桌面挂件」，本来就不该压着主界面；但它是【后创建】的窗口，
   一开机（上次勾着日历）它会排在 Z 序最上面，把主界面盖住、点不动（用户报过）。
   所以凡是「不是用户主动弹出日历」的场合，显示完日历都要把主界面 moveTop 一次。
   moveTop 只改 Z 序、不激活窗口，不会把焦点从别的软件抢过来。 */
function raiseMainAboveCal() {
  if (!win || win.isDestroyed()) return false;
  if (!win.isVisible()) {
    /* 开机那一瞬间的竞态：主界面还没显示出来（它等 ready-to-show），
       日历可能先显示了。那就等主界面一显示就把它压回上面去。 */
    try { win.once('show', function () { raiseMainAboveCal(); }); } catch (e) { }
    return false;
  }
  try { win.moveTop(); return true; } catch (e) { return false; }
}

function showCal(raise) {
  const w = createCalWindow();
  layoutCalWin();
  const doShow = function () {
    if (!calWin || calWin.isDestroyed()) return;
    if (raise) calWin.show();
    else {
      calWin.showInactive();
      raiseMainAboveCal();
    }
  };
  if (calBooted) { doShow(); return; }
  w.webContents.once('did-finish-load', function () {
    if (!calOn || !calWin || calWin.isDestroyed()) return;
    calWin.webContents.send('cal-todos', calTodos);
    calWin.webContents.send('cal-memos', calMemos);
    calWin.webContents.send('cal-style', calStyle);
    sendCalFit();
    doShow();
  });
}

ipcMain.handle('cal-on', (e, on) => setCalOn(on, true));
ipcMain.handle('cal-on-get', () => calOn);
ipcMain.handle('cal-hide', () => setCalOn(false));

/* 主界面推待办/备忘录/主题（每次存盘或改设置都会推一次） */
ipcMain.on('cal-todos', (e, list) => { applyCalTodos(list); });
ipcMain.on('cal-memos', (e, list) => { applyCalMemos(list); });
ipcMain.on('cal-style', (e, st) => { applyCalStyle(st); });

/* 日历页画好了：把缓存的数据和窗口尺寸发过去 */
ipcMain.on('cal-ready', () => {
  calBooted = true;
  if (!calWin || calWin.isDestroyed()) return;
  /* 窗口一就绪就检查一次位置：旧存的坐标、或系统在两次运行之间改了显示器排布，
     都可能让它压在两块屏交界上（那边会被裁掉一截）。 */
  snapCalIntoOneDisplay('窗口就绪');
  /* 再把网页缩放按当前档位重设一次：窗口创建早期那次可能没生效，
     一旦「窗口尺寸按缩放变了、网页没缩放」，940×680 的卡片就装不下、右下被裁。 */
  try { calWin.webContents.setZoomFactor(Math.min(1.5, Math.max(0.8, Number(calStyle.scale) || 1))); } catch (e) { }
  sendCalFit();
  calWin.webContents.send('cal-todos', calTodos);
  calWin.webContents.send('cal-memos', calMemos);
  calWin.webContents.send('cal-style', calStyle);
  sendCalFit();
  if (calOn) {
    /* ⚠️ 这里【不能】用 show()：页面加载完就激活会抢主界面的焦点，
       而且要紧接着把主界面压回上面去（见 raiseMainAboveCal 的注释） */
    calWin.showInactive();
    raiseMainAboveCal();
  }
});

/* 日历窗拖动：和宠物同一套限位（不带主窗口那圈余量） */
ipcMain.on('cal-win-drag-start', (e, pt) => {
  if (!calWin || calWin.isDestroyed() || !pt) return;
  if (calStyle.locked) return;            // 固定状态：谁都别想挪它（页面那边也已经拦了，这里再兜一道）
  calDragState = { x: pt.x, y: pt.y, bounds: calWin.getBounds() };
});

ipcMain.on('cal-win-drag-move', (e, pt) => {
  if (!calWin || calWin.isDestroyed() || !calDragState || !pt) return;
  if (calStyle.locked) return;
  const b = calDragState.bounds;
  const nx = Math.round(b.x + (pt.x - calDragState.x));
  const ny = Math.round(b.y + (pt.y - calDragState.y));
  /* ⚠️ 算哪块屏的可用区，用【窗口自己的中心】，不要用鼠标位置：
     鼠标往右拖到主屏边缘时很自然会越过边界，用鼠标判定就会瞬间切到副屏，
     窗口被吸走 —— 表现就是「右边怎么都贴不上主屏右缘」（用户报过，还验证过
     「关掉拓展屏就正常」）。用窗口中心判定：窗口还在主屏上就按主屏算，能贴死右缘；
     继续拖到窗口中心越过边界，才切到另一块屏。 */
  const pos = clampToWorkArea(nx, ny, b.width, b.height,
    { x: nx + b.width / 2, y: ny + b.height / 2 });
  calWin.setBounds({ x: pos.x, y: pos.y, width: b.width, height: b.height });
});

ipcMain.on('cal-win-drag-end', () => {
  if (!calWin || calWin.isDestroyed()) { calDragState = null; return; }
  const b = calWin.getBounds();
  /* ⚠️ 这里【不】重新回吸：拖动过程中（drag-move）已经按窗口中心夹过位置了，
     松手再来一次只会引入新的抖动 —— 之前用「鼠标位置」在这里回吸，
     结果鼠标越过屏边界松手时窗口被吸到另一块屏上（用户报过两次）。
     现在只按窗口自己所在那块屏兜一道底，正常情况就是个空操作。 */
  const pos = clampToWorkArea(b.x, b.y, b.width, b.height,
    { x: b.x + b.width / 2, y: b.y + b.height / 2 });
  if (pos.x !== b.x || pos.y !== b.y) {
    calWin.setBounds({ x: pos.x, y: pos.y, width: b.width, height: b.height });
  }
  /* 拖完再收一次：万一落在两块屏的交界/空隙上，整块挪进一块屏，免得被裁 */
  snapCalIntoOneDisplay('拖动结束');
  const nb = calWin.getBounds();
  calHome = { x: nb.x, y: nb.y, width: nb.width, height: nb.height };
  saveCalPos(nb.x, nb.y);
  calDragState = null;
});

/* 日历里勾「完成」：转给主界面改数据（真数据在它那儿），改完它会推回来 */
ipcMain.on('cal-toggle-todo-req', (e, id) => {
  if (!id || !win || win.isDestroyed()) return;
  win.webContents.send('cal-toggle-todo', String(id));
});

/* 左栏勾备忘录完成：同上 */
ipcMain.on('cal-toggle-memo-req', (e, id) => {
  if (!id || !win || win.isDestroyed()) return;
  win.webContents.send('cal-toggle-memo', String(id));
});

/* 左栏直接新增一条备忘：转给主界面写进同一份数据，写完照常推回来 */
ipcMain.on('cal-add-memo-req', (e, text) => {
  const t = String(text == null ? '' : text).trim();
  if (!t || !win || win.isDestroyed()) return;
  win.webContents.send('cal-add-memo', t.slice(0, 500));
});

/* 当天清单里点「✏️」：打开主界面的「修改待办」弹窗（真数据在那边） */
ipcMain.on('cal-edit-todo-req', (e, id) => {
  if (!id || !win || win.isDestroyed()) return;
  showWindow();
  win.webContents.send('cal-edit-todo', String(id));
});

/* 当天清单里点「🗑」并确认：让主界面删掉（日历里已经确认过一次，不再弹系统对话框） */
ipcMain.on('cal-delete-todo-req', (e, id) => {
  if (!id || !win || win.isDestroyed()) return;
  win.webContents.send('cal-delete-todo', String(id));
});

/* 日历右上角那个 🌙/☀：真值（settings.calTheme）在主界面，转给它去翻，翻完它会推回来 */
ipcMain.on('cal-toggle-theme-req', () => {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('cal-toggle-theme');
});

/* 放大 / 缩小：转给主界面（缩放值存在它的设置里），顺手把窗口尺寸也调好 */
ipcMain.on('cal-zoom-req', (e, dir) => {
  const cur = calScaleIndex(Math.min(1.5, Math.max(0.8, Number(calStyle.scale) || 1)));
  const next = CAL_SCALE_STEPS[Math.max(0, Math.min(CAL_SCALE_STEPS.length - 1, cur + (dir > 0 ? 1 : -1)))];
  calStyle.scale = next;
  applyCalZoom();                                   // 先让窗口立刻有反应
  if (!win || win.isDestroyed()) return;
  win.webContents.send('cal-zoom', next);           // 再让主界面把它存进设置
});

/* 固定 / 取消固定：和主题一样走主界面存设置，再由它推回来 */
ipcMain.on('cal-toggle-lock-req', () => {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('cal-toggle-lock');
});

/* 右上角「＋」：把主界面叫出来并直接打开「新增待办」弹窗 */
ipcMain.on('cal-add-todo', () => {
  if (!win || win.isDestroyed()) return;
  showWindow();
  win.webContents.send('cal-add-todo');
});

/* 右上角「⚙」：打开主界面的设置页 */
ipcMain.on('cal-open-settings', () => {
  if (!win || win.isDestroyed()) return;
  showWindow();
  send('show-settings');
});

/* 日历窗的右键菜单。和宠物一样拆成模板，方便自检。 */
function calMenuTemplate() {
  return [
    { label: '上一月', click: () => sendCalNav('prev') },
    { label: '回到今天', click: () => sendCalNav('today') },
    { label: '下一月', click: () => sendCalNav('next') },
    { type: 'separator' },
    { label: '打开主界面', click: () => { showWindow(); send('show-todo'); } },
    { label: '隐藏桌面日历', click: () => { setCalOn(false); } }
  ];
}
function sendCalNav(dir) {
  if (calWin && !calWin.isDestroyed()) calWin.webContents.send('cal-nav', dir);
}
/* 右键菜单：固定状态下干脆不弹 —— 菜单里是「上一月 / 今天 / 下一月 / 打开主界面 /
   隐藏日历」这些，个个都在动日历，锁住就该老实待着。（解锁照旧能弹。） */
ipcMain.handle('cal-win-menu', () => {
  if (calStyle.locked) return null;
  return Menu.buildFromTemplate(calMenuTemplate());
});

/* ------------------------------------------------------------ 宠物说话
   气泡内容和「下一次提醒」在主界面那边算（它才有那些数据），所以这里转发一次：
   宠物窗点一下 → 向主界面要文字 → 拿到后显示气泡。
   requestWanted 记着「这一下是想开还是想收」：主界面是异步回来的，
   期间用户可能又点了一下（想收起）或直接拖动，那这次数据就作废，别再弹出来。 */
let requestWanted = false;

function requestPetTalk() {
  if (!win || win.isDestroyed()) return;
  requestWanted = true;
  win.webContents.send('pet-talk-request');
}

ipcMain.on('pet-talk-data', (e, data) => {
  if (!petOn || !requestWanted) return;
  requestWanted = false;
  if (data) showBubble(data);
});

/* -------------------------------------------------- 桌面宠物窗的 IPC */
ipcMain.handle('pet-win-get-scale', () => {
  const ph = petHome || (petWin && !petWin.isDestroyed() ? petWin.getBounds() : null);
  const d = ph ? displayOf(ph.x, ph.y) : screen.getPrimaryDisplay();
  return petDisplayInfo(d);
});

ipcMain.handle('pet-win-menu', () => buildPetMenu());

/* 宠物窗/托盘的右键菜单（同一个内容，两处入口）。
   内容单独拆成 petMenuTemplate()，自检时可以直接检查里面的项 ——
   buildPetMenu() 会真的把菜单弹出来挡住屏幕，没法在自检里调。 */
function petMenuTemplate() {
  const tpl = [
    { label: '显示主界面', click: () => { showWindow(); } },
    { label: '隐藏桌面宠物', click: () => { setPetOn(false); } },
    /* 桌面日历的开关也放一份在这儿：用户在宠物身上右键就能顺手把日历开出来，
       不用专门绕回主界面（托盘菜单里也有同一个） */
    { label: '📅 显示桌面日历', type: 'checkbox', checked: calOn, click: (mi) => { setCalOn(mi.checked, true); } },
    { type: 'separator' },
    { label: '🕰 十二时辰对照表', click: () => { showWindow(); send('show-shichen'); } },
    { label: '＋ 添加提醒事项', click: () => { showWindow(); send('add-item'); } },
    { label: '📝 打开待办', click: () => { showWindow(); send('show-todo'); } },
    { label: '📖 打开日记', click: () => { showWindow(); send('show-diary'); } }
  ];
  if (menuItems.length) {
    tpl.push({ type: 'separator' });
    tpl.push({ label: '调整倒计时', submenu: menuItems.map(intervalSubmenu) });
  }
  tpl.push({ type: 'separator' });
  /* 护眼模式：和「宠物形象 / 宠物大小」归一类，都是随手能改的设置。
     菜单每次右键都重新建，所以直接读 eyeCareOn 就是当前状态。 */
  tpl.push({
    label: '🌙 护眼模式',
    type: 'checkbox',
    checked: eyeCareOn,
    click: (mi) => { eyeCareSet(!!mi.checked); }
  });
  tpl.push({ label: '宠物形象', submenu: skinSubmenu() });
  tpl.push({
    label: '宠物大小',
    submenu: Object.keys(PET_SIZES).map(k => ({
      label: PET_SIZES[k].label,
      type: 'radio',
      checked: petSize === k,
      click: () => setPetSize(k)
    }))
  });
  tpl.push({ type: 'separator' });
  tpl.push({ label: '退出', click: quitApp });
  return tpl;
}

/* 自检用：把菜单摊平成「文字(类型/勾选)」的列表，一眼能看出有没有那一项 */
function petMenuSummary() {
  const out = [];
  petMenuTemplate().forEach(function (it) {
    if (it.type === 'separator') { out.push('---'); return; }
    let s = it.label;
    if (it.type === 'checkbox') s += it.checked ? ' [✓]' : ' [ ]';
    if (it.type === 'radio') s += it.checked ? ' (•)' : ' ( )';
    if (it.submenu) s += ' ▸ ' + it.submenu.map(function (c) { return c.label; }).join(' / ');
    out.push(s);
  });
  return out;
}

function buildPetMenu() {
  if (!petWin || petWin.isDestroyed()) return false;
  Menu.buildFromTemplate(petMenuTemplate()).popup({ window: petWin });
  return true;
}

/* 单击宠物：
     · 气泡没开 → 说话（向主界面要文字然后弹气泡）
     · 气泡开着 → 再点一次就收掉（和用户直觉一致：点一下切换）
   气泡的自动收起计时器统一由 armBubbleTimer() 管。 */
function petTapped() {
  if (talkOpen) { hideBubble(); return 'hide'; }
  if (requestWanted) { requestWanted = false; return 'cancel'; }   // 正在等文字，再点一下=取消
  requestPetTalk();
  return 'talk';
}

ipcMain.handle('pet-win-talk', () => { petTapped(); return true; });

/* 开始拖动时页面会让气泡收起：拖动中窗口在移动，气泡不跟着走会脱节 */
ipcMain.on('pet-win-talk-hide', () => {
  requestWanted = false;
  hideBubble();
});

ipcMain.on('pet-win-ready', () => {
  petBooted = true;
  if (!petOn || !petWin || petWin.isDestroyed()) return;
  petWin.showInactive();
});

/* 宠物窗拖动（和主窗口同一个套路：页面发屏幕坐标，主进程算位置并限位） */
ipcMain.on('pet-win-drag-start', (e, pt) => {
  if (!petWin || petWin.isDestroyed() || !pt) return;
  petDragState = { x: pt.x, y: pt.y, bounds: petWin.getBounds() };
});

ipcMain.on('pet-win-drag-move', (e, pt) => {
  if (!petWin || petWin.isDestroyed() || !petDragState || !pt) return;
  const b = petDragState.bounds;
  const pos = clampToWorkArea(
    Math.round(b.x + (pt.x - petDragState.x)),
    Math.round(b.y + (pt.y - petDragState.y)),
    b.width, b.height, pt
  );
  petWin.setBounds({ x: pos.x, y: pos.y, width: b.width, height: b.height });
});

ipcMain.on('pet-win-drag-end', () => {
  if (!petWin || petWin.isDestroyed()) { petDragState = null; return; }
  const b = petWin.getBounds();
  const pos = clampToWorkArea(b.x, b.y, b.width, b.height,
    { x: b.x + b.width / 2, y: b.y + b.height / 2 });
  if (pos.x !== b.x || pos.y !== b.y) {
    petWin.setBounds({ x: pos.x, y: pos.y, width: b.width, height: b.height });
  }
  const nb = petWin.getBounds();
  /* 「家」跟着走：气泡按它摆位，换屏重排也以它为中心 */
  petHome = { x: nb.x, y: nb.y, width: nb.width, height: nb.height };
  /* 记住位置：下次启动宠物还在这个角落/这条边 */
  savePetPos(nb.x, nb.y);
  petDragState = null;
});

/* --------------------------------------- 宠物模式 / 托盘 右键菜单 */
function intervalSubmenu(it) {
  return {
    label: (it.emoji || '') + ' ' + it.name + '（当前 ' + it.minutes + ' 分钟）',
    submenu: QUICK_MINUTES.map(m => ({
      label: m + ' 分钟',
      click: () => send('set-interval', { id: it.id, minutes: m })
    }))
  };
}

/* 右键菜单里的形象列表：内置的 + skins/ 里的 */
function skinSubmenu() {
  const list = [{ id: '__default', name: '篮球男孩' }].concat(
    scanSkins().map(function (s) { return { id: s.id, name: s.name }; }));
  return list.map(function (s) {
    return {
      label: s.name,
      type: 'radio',
      checked: currentSkin === s.id,
      click: function () {
        /* 主进程统一改：同时通知主界面下拉框和桌面宠物窗 */
        setPetSkin(s.id);
        send('set-skin', s.id);
      }
    };
  });
}

ipcMain.handle('pet-menu', () => {
  /* 桌面宠物已经在自己的窗口里处理右键了（pet-win-menu）。
     这里保留一个兜底：万一从别处调过来，直接把宠物菜单弹出来。 */
  if (!petWin || petWin.isDestroyed()) return false;
  return buildPetMenu();
});

/* ------------------------------------------------------------ IPC */
/* --------------------------------------------------- 屏幕缩放（DPI）IPC */
/* 页面启动时先问一次；之后靠 display-info 事件同步。
   基准缩放以主进程为唯一权威（页面不自己记，避免两边不一致）。 */
ipcMain.handle('get-ui-scale', () => {
  const b = win && !win.isDestroyed() ? win.getBounds() : null;
  const d = b ? displayOf(b.x + Math.max(1, b.width) / 2, b.y + 8) : screen.getPrimaryDisplay();
  const rk = realUiK(d);
  return {
    pixelRatio: curPixelRatio,
    realPixelRatio: (d && d.scaleFactor) || 1,
    basePixelRatio: basePixelRatio,
    scale: uiK(),
    realScale: rk,
    petW: Math.round(UI.DESIGN.petW / rk),
    petH: Math.round(UI.DESIGN.petH / rk)
  };
});

ipcMain.handle('alert', () => { bringToFront(); return true; });

ipcMain.handle('dismiss', () => {
  if (!win) return false;
  win.flashFrame(false);
  win.setAlwaysOnTop(false);

  /* 提醒前躲在托盘里的话，打完卡自己缩回去（桌面宠物是独立窗口，不受影响） */
  if (wasHidden) {
    wasHidden = false;
    setTimeout(() => {
      if (win && !quitting && !win.isDestroyed()) win.hide();
    }, 1600);
  }
  return true;
});

/* 桌面宠物开关（主界面上的勾选框 / 托盘菜单都走这里） */
ipcMain.handle('pet-on', (e, on) => setPetOn(on));
ipcMain.handle('pet-on-get', () => petOn);

/* ------------------------------------------------------ 开机自启动（HKCU Run 键）
   用 Electron 内置的 setLoginItemSettings：Windows 上写的是
   HKCU\Software\Microsoft\Windows\CurrentVersion\Run，值名是 AppUserModelID，
   不需要管理员权限，用户也能在「任务管理器 → 启动」里自己禁掉。
   不加 --hidden 的话开机就会弹出主界面，那是用户明确不要的行为。

   ⚠️ 读回来必须用【和写入时一模一样的 path + args】。
   Electron 在 Windows 上判断 openAtLogin 的做法是：拿传进来的 path+args 拼出
   命令行，再和注册表里的值做【字符串完全比对】。不带参数调用时 path 是空的，
   拼出来的东西永远比不中 —— 实测 openAtLogin 恒为 false。表现就是
   「Run 键明明写进去了、开机真的会自启，但页面上的勾一放开就弹回去」，
   用户怎么点都开不了（联想/华为那两台机器反馈的就是这个现象）。
   所以这里两道保险：
     ① 读的时候带上同一套 path+args；
     ② 再用 launchItems 兜底 —— 它按【可执行文件路径】匹配，不受参数写法影响
        （老版本写过 --startup 这种），而且每一项都带 enabled 字段，
        能正确反映「被任务管理器或电脑管家禁用」的状态。
   只看 scope==='user' 的项：安装包是按用户装的（perMachine:false），
   HKLM 里那种全机器自启项我们管不了，也不该因此显示成「已开启」。 */
function autoLaunchArgs() {
  /* 绿色版是 exe 直接跑；开发时用 electron.exe 跑目录，参数要跟着变 */
  return app.isPackaged ? ['--hidden'] : [path.resolve(__dirname), '--hidden'];
}

function autoLaunchRead() {
  return app.getLoginItemSettings({ path: process.execPath, args: autoLaunchArgs() });
}

function autoLaunchEnabled() {
  try {
    if (process.platform !== 'win32') return false;
    const st = autoLaunchRead();
    if (st.openAtLogin) return true;
    const mine = (st.launchItems || []).filter(function (it) { return it.scope === 'user'; });
    return mine.some(function (it) { return !!it.enabled; });
  } catch (e) { return false; }
}

function setAutoLaunch(on) {
  try {
    if (process.platform !== 'win32') return false;
    app.setLoginItemSettings({
      openAtLogin: !!on,
      /* enabled:true 会让 Electron 顺手【删掉】StartupApproved 里那条「已禁用」记录 ——
         用户在任务管理器 / 电脑管家里禁过之后，只有删掉它开机才会真的自启
         （只写 Run 键是不够的，被禁用的项 Windows 会跳过） */
      enabled: true,
      path: process.execPath,
      args: autoLaunchArgs()
    });
    return autoLaunchEnabled();
  } catch (e) { return false; }
}

ipcMain.handle('get-auto-launch', () => autoLaunchEnabled());
ipcMain.handle('set-auto-launch', (e, on) => setAutoLaunch(!!on));

/* 待办到点：主界面已经弹好提醒弹层，这里只负责把窗口抢到最前面并切到待办页 */
ipcMain.handle('todo-alert', () => {
  bringToFront();
  return true;
});

/* ======================================================== 说话气泡
   气泡用「独立的小透明窗」实现，不再和宠物挤在同一个窗口里。

   为什么这么做：以前气泡是塞在宠物窗里的，说话时得把宠物窗移动+放大，
   而「窗口几何」和「网页内容」分属主进程与渲染进程，两者永远有先后差 ——
   那一瞬间就会看到宠物/气泡闪到别的位置。改成独立窗口后，
   宠物窗在整个说话过程中尺寸位置一动不动，这类闪烁从根上就没有了。 */

/* 气泡窗的几何基准写在 ui-scale.js 的 DESIGN 里（物理尺寸），
   这里只保留 BUBBLE_GAP 的基准值，实际值由 bubbleBox() 按 k 换算。 */
let bubbleWin = null;

/* 气泡的几何：物理尺寸固定，逻辑尺寸 = ÷k。文字是 HTML，放大缩小交给页面做
   （bubble.html 里按 --bubble-scale 对气泡本体做 transform），这样气泡在
   4K@200% 下不会变成一个「物理上两倍大」的巨型气泡。 */
function bubbleBox() {
  const b = win && !win.isDestroyed() ? win.getBounds() : null;
  const d = b ? displayOf(b.x + Math.max(1, b.width) / 2, b.y + 8) : screen.getPrimaryDisplay();
  const k = realUiK(d);            // 气泡和宠物窗一样，按真实像素比定物理尺寸
  return {
    w: UI.DESIGN.bubbleW / k,
    h: UI.DESIGN.bubbleH / k,
    gap: Math.round(12 / k),
    pad: UI.DESIGN.bubblePad / k,
    k: k
  };
}

/* 气泡里「今日待办」那一块要多高（设计单位=物理像素）：
   有 N 条就多出「标题 + N 行」，没有待办返回 0（气泡保持原来的尺寸）。 */
function bubbleTodoExtra(rows, more) {
  const n = Math.max(0, Math.round(rows) || 0);
  if (!n) return 0;
  return UI.DESIGN.bubbleTodoHead + n * UI.DESIGN.bubbleTodoRow +
    (more > 0 ? UI.DESIGN.bubbleTodoRow : 0);
}

/* 气泡要额外长高多少（设计单位）：今天有待办按行数算；科研推送按标题行数算 */
function bubbleExtraUnits(data) {
  const d = data || {};
  if (d.todos && d.todos.items && d.todos.items.length) {
    return bubbleTodoExtra(d.todos.items.length, d.todos.more);
  }
  return Math.max(0, Math.round(Number(d.extraH) || 0));
}

function talkDisplay(px, py) {
  try {
    return screen.getDisplayNearestPoint({ x: Math.round(px), y: Math.round(py) });
  } catch (e) {
    return screen.getPrimaryDisplay();
  }
}

/* 给气泡挑个位置。三条硬性要求：
     1. 完整落在桌面可用区内（宠物贴哪条边都行）
     2. 不和宠物重叠
     3. 默认在宠物「上方」偏一侧（就是左上角 / 右上角），放不下才退成左 / 右
   气泡比宠物宽，所以优先「并排」——并排时横向就不相交，纵向怎么放都压不到宠物。
   box 由 bubbleBox() 给出，尺寸随屏幕缩放变化，所以这里全部按参数算、不写死。 */
function placeBubble(petX, petY, petW, petH, preferSide, wa, box) {
  const BUBBLE_W = box.w, BUBBLE_H = box.h;
  const BUBBLE_GAP = box.gap;                                  // 横向间距（气泡在宠物左/右时用）
  const BUBBLE_GAP_V = Math.max(4, Math.round(box.gap / 2));   // 纵向间距（气泡在宠物上/下时更贴紧）
  const M = 8;
  const limL = wa.x + M, limR = wa.x + wa.width - M;
  const limT = wa.y + M, limB = wa.y + wa.height - M;

  const rightX = petX + petW + BUBBLE_GAP;
  const leftX = petX - BUBBLE_GAP - BUBBLE_W;
  const fitsR = (rightX + BUBBLE_W) <= limR;
  const fitsL = leftX >= limL;
  const preferR = preferSide === 'right';

  let bx;
  if (preferR && fitsR) bx = rightX;
  else if (!preferR && fitsL) bx = leftX;
  else if (fitsL) bx = leftX;
  else if (fitsR) bx = rightX;
  else bx = Math.max(limL, Math.min(rightX, limR - BUBBLE_W));

  /* 纵向默认在宠物上方（用更小的纵向间距，别离宠物那么高）；
     宠物贴顶时会被夹到屏幕顶部，自动变成「左边 / 右边」 */
  let by = petY - BUBBLE_GAP_V - BUBBLE_H;
  by = Math.max(limT, Math.min(by, limB - BUBBLE_H));

  /* 并排时横向本来就不相交；万一夹取后压住了宠物，就整块挪到上方或下方 */
  const overlapX = !(bx + BUBBLE_W <= petX || bx >= petX + petW);
  if (overlapX) {
    const above = petY - BUBBLE_GAP_V - BUBBLE_H;
    const below = petY + petH + BUBBLE_GAP_V;
    if (above >= limT) by = above;
    else if (below + BUBBLE_H <= limB) by = below;
    else by = Math.max(limT, Math.min(above, limB - BUBBLE_H));
  }

  /* 小尾巴朝哪边：始终指向宠物。上下限按气泡实际高度/宽度取，不写死 16 */
  const cl = (v, a, b) => Math.max(a, Math.min(b, v));
  const edge = Math.min(16, BUBBLE_H / 2 - 4, BUBBLE_W / 2 - 4);
  let tail, tailPos;
  if (bx >= petX + petW) {
    tail = 'left';
    tailPos = cl(petY + petH / 2 - by, edge, BUBBLE_H - edge);
  } else if (bx + BUBBLE_W <= petX) {
    tail = 'right';
    tailPos = cl(petY + petH / 2 - by, edge, BUBBLE_H - edge);
  } else if (by + BUBBLE_H <= petY) {
    tail = 'bottom';
    tailPos = cl(petX + petW / 2 - bx, edge, BUBBLE_W - edge);
  } else {
    tail = 'top';
    tailPos = cl(petX + petW / 2 - bx, edge, BUBBLE_W - edge);
  }

  return { x: Math.round(bx), y: Math.round(by), tail: tail, tailPos: Math.round(tailPos) };
}

function ensureBubbleWin() {
  if (bubbleWin && !bubbleWin.isDestroyed()) return bubbleWin;
  const box = bubbleBox();
  bubbleWin = new BrowserWindow({
    width: Math.round(box.w + box.pad * 2),
    height: Math.round(box.h + box.pad * 2),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,          // 不抢焦点，点它也不会打断别处的操作
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'bubble-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  /* ⚠️ 层级要用 'screen-saver'（最高档），不能用 'floating'：
     'floating' 是最低档的置顶，桌面宠物自己就是这一档，别的软件只要有置顶窗口、
     或者它自己被提到前面，气泡就会被压在下面（用户报过「点宠物气泡出现在最底层」）。
     主窗口提醒时用的就是 'screen-saver'，一直稳稳在最上面，气泡跟它对齐。 */
  bubbleWin.setAlwaysOnTop(true, 'screen-saver');
  bubbleWin.setIgnoreMouseEvents(true);      // 默认纯展示，鼠标事件穿透过去（可点的气泡会临时打开）
  bubbleWin.loadFile(path.join(__dirname, 'bubble.html'));
  bubbleWin.on('closed', () => { bubbleWin = null; });
  return bubbleWin;
}

/* 显示气泡：主进程负责算位置，渲染进程只提供文字内容 */
function showBubble(data) {
  const b = petHome || (win && !win.isDestroyed() ? win.getBounds() : null);
  if (!b) return false;

  const bw = ensureBubbleWin();
  const box0 = bubbleBox();
  /* 今天有待办 / 科研推送带标题列表时，气泡要长高一点；都没有就一点不占 */
  const extra = bubbleExtraUnits(data) / box0.k;
  const box = extra > 0
    ? { w: box0.w, h: box0.h + extra, gap: box0.gap, pad: box0.pad, k: box0.k }
    : box0;
  const disp = talkDisplay(b.x + b.width / 2, b.y + b.height / 2);
  const p = placeBubble(b.x, b.y, b.width, b.height,
    data && data.side === 'left' ? 'left' : 'right', disp.workArea, box);

  const winW = Math.round(box.w + box.pad * 2);
  const winH = Math.round(box.h + box.pad * 2);
  bw.setBounds({
    x: Math.round(p.x - box.pad),
    y: Math.round(p.y - box.pad),
    width: winW,
    height: winH
  });

  const td = (data && data.todos && data.todos.items && data.todos.items.length) ? data.todos : null;
  const click = (data && data.click) ? String(data.click) : '';
  const payload = {
    head: (data && data.head) || '',
    mer: (data && data.mer) || '',
    tip: (data && data.tip) || '',
    next: (data && data.next) || '',
    todos: td || null,
    click: click,
    tail: p.tail,
    tailPos: p.tailPos,
    /* 页面按这个把「设计尺寸的气泡本体」放大/缩小到当前物理尺寸 */
    scale: box.k,
    innerW: Math.round(box.w),
    innerH: Math.round(box.h),
    pad: Math.round(box.pad)
  };
  const push = function () {
    try { bw.webContents.send('bubble-data', payload); } catch (e) { /* 忽略 */ }
  };
  if (bw.webContents.isLoading()) bw.webContents.once('did-finish-load', push);
  else push();

  /* 每次显示都重新声明一次置顶 + 抬到最前：
     别的软件（尤其是自己也有置顶窗口的）可能在这中间把层级顶掉，
     只靠创建时设一次不够稳。 */
  try {
    bw.setAlwaysOnTop(true, 'screen-saver');
    /* 可点的气泡临时允许被激活：Windows 上有些情况下（WS_EX_NOACTIVATE）
       鼠标消息不一定送进来，让它可以被点一下更保险 —— 点完立刻就开主界面了 */
    if (click) bw.setFocusable(true);
    bw.showInactive();                          // 不激活、不抢焦点
    bw.moveTop();
    /* 鼠标穿透必须在【显示之后】再声明一次：
       显示这个动作会把窗口样式重新应用一遍，之前设的会失效 —— 可点的气泡就点不到了。 */
    bw.setIgnoreMouseEvents(!click);
  } catch (e) { bw.showInactive(); }
  talkOpen = true;
  armBubbleTimer(click ? BUBBLE_CLICK_MS : 0);  // 说一会儿自己收掉，不挡着桌面
  return true;
}

/* 气泡自动收起：普通说话 6 秒；可点的（科研推送）给 15 秒，够看清标题再点 */
const BUBBLE_MS = 6000;
const BUBBLE_CLICK_MS = 15000;
let bubbleTimer = null;

function armBubbleTimer(ms) {
  if (bubbleTimer) clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(function () {
    bubbleTimer = null;
    hideBubble();
  }, Math.max(1000, Math.round(Number(ms) || BUBBLE_MS)));
}

function hideBubble() {
  talkOpen = false;
  requestWanted = false;
  if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null; }
  if (bubbleWin && !bubbleWin.isDestroyed()) {
    try { bubbleWin.setIgnoreMouseEvents(true); } catch (e) { }   // 收掉就恢复鼠标穿透
    try { bubbleWin.setFocusable(false); } catch (e) { }          // 别留着「可激活」
    if (bubbleWin.isVisible()) bubbleWin.hide();
  }
}

/* 彻底销毁气泡窗（不只是隐藏）。
   一个隐藏的 BrowserWindow 仍然占着一整个渲染进程（约 50~120MB），
   关掉桌面宠物后根本用不到它，留着纯属浪费 —— 再打开时重建。 */
function destroyBubble() {
  talkOpen = false;
  if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null; }
  if (bubbleWin && !bubbleWin.isDestroyed()) {
    try { bubbleWin.destroy(); } catch (e) { /* 忽略 */ }
  }
  bubbleWin = null;
}

/* 主界面把气泡文字发过来，主进程只管摆位置和显示 */
ipcMain.handle('pet-talk', (e, data) => {
  if (!petOn) return false;
  return showBubble(data || {});
});

ipcMain.handle('pet-talk-end', () => {
  hideBubble();
  return true;
});
/* ====================================================== 皮肤（外部接口）
   让用户自己换宠物形象：在 skins/<皮肤名>/ 里放 skin.json + 一张精灵图即可。

   两个地方：
     1. 【用户皮肤】装好后 exe 同级的 skins/   ← 给用户放自己做的，更新时会先备份再放回来
     2. 【内置皮肤】resources/skins/            ← 打包进去的示例，随版本更新
     3. 开发时还有 <项目>/skins/（等同内置）

   ⚠️ 为什么用户皮肤非要专门保护：安装程序在更新时会先把整个安装目录递归删掉
   （electron-builder 的 uninstaller.nsh：RMDir /r $INSTDIR），用户自己塞进去的
   东西会被一起删（朋友反馈过「更新后自定义皮肤没了」）。所以：
     · 安装时由 build/installer.nsh 把 skins 先搬到 %TEMP%、装完再放回来；
     · 程序这边再兜一层：把用户皮肤镜像一份到 userData，万一哪次没保住，下次启动自动补回来。
   皮肤图由主进程读成 data URL 再交给渲染进程，所以不用放宽页面的 CSP。 */

/* 用户皮肤目录：exe 同级（开发时是项目目录），写不进去就退回 userData。
   ⚠️ 自检用 skinsDirOverride 把它指到一个临时目录，好模拟「装好之后的目录布局」——
   开发模式下这个目录就是仓库的 skins/，里面本来就有十几个内置皮肤，
   「整个目录被清空」这种场景在仓库里根本造不出来。 */
let skinsDirOverride = '';
function userSkinsDir() {
  if (skinsDirOverride) return skinsDirOverride;
  try {
    const base = app.isPackaged ? path.dirname(app.getPath('exe')) : __dirname;
    return path.join(base, 'skins');
  } catch (e) { return path.join(app.getPath('userData'), 'skins'); }
}
/* 用户皮肤在 userData 里的镜像（纯兜底，用户看不到） */
function skinsMirrorDir() { return path.join(app.getPath('userData'), 'skins-backup'); }

/* 说明文档：直接搬 skins/README.md（那份是完整文档，仓库里维护）
   —— 程序里只留一小段应急文案，万一打包时漏了文档也不至于让用户对着空文件夹发呆 */
const SKINS_README_FALLBACK = [
  'iKunReminder 自定义宠物皮肤',
  '==========================',
  '',
  '每个皮肤一个子文件夹，里面放：',
  '  skin.json    描述文件',
  '  sheet.png    精灵图（每行一种动作，左到右是帧）',
  '',
  '放好之后回到主界面，在「🎨 宠物形象」旁边点一下「🔄 刷新」就能选到，不用重启软件。',
  '完整说明（skin.json 怎么写、精灵图怎么排、出问题怎么办）见安装目录下',
  'resources\\skins\\README.md。',
  ''
].join('\r\n');

/* 目录和说明文档：启动时保证存在（安装程序建目录，文档由这里补） */
function ensureUserSkins() {
  const dir = userSkinsDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) { return dir; }
  try {
    const doc = path.join(dir, 'README.md');
    /* 老版本写下的说明文档还在教用户「重启软件」→ 换成新的那份（现在有刷新按钮了）。
       只认我们自己那份（开头是那个标题、且不含「刷新」二字），用户自己改过的内容不动。 */
    let stale = false;
    try {
      const old = fs.readFileSync(doc, 'utf8');
      stale = old.indexOf('# 自定义宠物形象（皮肤）') === 0 && old.indexOf('刷新') < 0;
    } catch (e) { /* 读不到就当不存在 */ }
    if (!fs.existsSync(doc) || stale) {
      /* 内置那份完整文档：打包后在 resources/skins/，开发时在项目根目录的 skins/。
         两个候选都找一遍（开发模式下 resources 里没有，只有项目里有）。 */
      const cands = [];
      if (process.resourcesPath) cands.push(path.join(process.resourcesPath, 'skins', 'README.md'));
      cands.push(path.join(__dirname, 'skins', 'README.md'));
      const src = cands.filter(function (c) { return c !== doc && fs.existsSync(c); })[0];
      if (src) fs.copyFileSync(src, doc);
      else if (!fs.existsSync(doc)) fs.writeFileSync(doc, SKINS_README_FALLBACK, 'utf8');
    }
  } catch (e) { /* 说明文档写不进去不致命 */ }
  return dir;
}

/* 用户皮肤目录下的皮肤名单（只看目录） */
function listUserSkinDirs() {
  const dir = userSkinsDir();
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(function (e) { return e.isDirectory(); })
      .map(function (e) { return e.name; })
      .sort();
  } catch (e) { return []; }
}

/* 兜底：把用户皮肤镜像到 userData；万一安装时没保住，下次启动从镜像补回来。
   怎么区分「被安装程序清掉」和「用户自己删了」：
     · 安装程序更新时是整个安装目录一起没的 → 连 skins 目录本身都不存在了；
     · 用户删皮肤只会删里面的子文件夹 → 目录还在（里面还有说明文档）。
   所以只在「目录整个不见了」时才补回来；「目录还在但空了」当作用户主动删的，
   顺手把镜像也清掉，免得以后又给他变回来。
   另外：目录不见时【绝不】清镜像（万一补回来失败，镜像还是最后一份底）。
   只有名单变了才真的复制，别每次启动都写盘。 */
function skinsSignature(names) {
  const dir = userSkinsDir();
  return names.map(function (n) {
    let t = 0;
    try { t = fs.statSync(path.join(dir, n)).mtimeMs; } catch (e) { }
    return n + ':' + Math.round(t);
  }).join('|');
}

function syncSkinsMirror() {
  const dir = userSkinsDir(), mirror = skinsMirrorDir();
  let mirrored = [];
  try {
    mirrored = fs.readdirSync(mirror, { withFileTypes: true })
      .filter(function (e) { return e.isDirectory(); })
      .map(function (e) { return e.name; }).sort();
  } catch (e) { /* 还没有镜像 */ }

  /* ① 整个皮肤目录都不见了（更新时安装目录被清掉的典型特征）→ 从镜像补回来 */
  if (!fs.existsSync(dir)) {
    if (!mirrored.length) return 'unchanged';
    try {
      fs.mkdirSync(dir, { recursive: true });
      mirrored.forEach(function (n) {
        fs.cpSync(path.join(mirror, n), path.join(dir, n),
          { recursive: true, force: false, errorOnExist: false });
      });
      ensureUserSkins();                 // 说明文档也一起补回来
      diagLog('skins-restored', { 从镜像补回: mirrored });
      return 'restored';
    } catch (e) {
      /* 补失败了就把半拉目录清掉，下次启动还能再试（镜像不动） */
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e2) { }
      diagLog('skins-restore-error', { message: String(e && e.message || e) });
      return 'restore-failed';
    }
  }

  const names = listUserSkinDirs();
  /* ② 目录还在但一个皮肤都没有 → 用户自己删光了，镜像跟着清掉（别复活） */
  if (!names.length) {
    if (mirrored.length) {
      try { fs.rmSync(mirror, { recursive: true, force: true }); } catch (e) { }
      return 'mirror-pruned';
    }
    return 'unchanged';
  }
  /* ③ 名单变了（加了 / 删了皮肤）→ 重建镜像 */
  if (skinsSignature(names) !== skinsMirrorSig) {
    try {
      fs.rmSync(mirror, { recursive: true, force: true });
      fs.mkdirSync(mirror, { recursive: true });
      names.forEach(function (n) {
        fs.cpSync(path.join(dir, n), path.join(mirror, n), { recursive: true, force: true });
      });
      skinsMirrorSig = skinsSignature(names);
      return 'mirrored';
    } catch (e) { return 'mirror-failed'; }
  }
  return 'unchanged';
}
let skinsMirrorSig = '';

function skinsDirs() {
  const list = [ensureUserSkins()];
  if (process.resourcesPath) list.push(path.join(process.resourcesPath, 'skins'));
  list.push(path.join(__dirname, 'skins'));
  return list.filter(function (p, i) { return p && list.indexOf(p) === i; });
}

function scanSkins() {
  const found = [];
  const seen = {};
  skinsDirs().forEach(function (dir) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    ents.forEach(function (e) {
      if (!e.isDirectory() || seen[e.name]) return;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, e.name, 'skin.json'), 'utf8'));
        if (!j || !j.frame || !j.animations) return;
        seen[e.name] = true;
        found.push({
          id: e.name,
          name: j.name || e.name,
          author: j.author || '',
          dir: dir
        });
      } catch (err) { /* 坏掉的皮肤直接跳过，别影响启动 */ }
    });
  });
  return found;
}

ipcMain.handle('skins-list', () => {
  /* 每次列皮肤时顺手做一次「镜像 / 需要时从镜像补回来」，用户什么都不用管 */
  syncSkinsMirror();
  const list = [{ id: '__default', name: '篮球男孩', author: '', builtin: true }];
  scanSkins().forEach(function (s) {
    list.push({ id: s.id, name: s.name, author: s.author, builtin: false });
  });
  return list;
});

/* 设置页那个「🎨 打开皮肤文件夹」：保证目录和说明文档在，然后打开它 */
ipcMain.handle('open-skins-dir', () => {
  try {
    const dir = ensureUserSkins();
    require('electron').shell.openPath(dir);
    return dir;
  } catch (e) { return ''; }
});
ipcMain.handle('skins-dir', () => userSkinsDir());

ipcMain.handle('skin-load', (e, id) => {
  if (!id || id === '__default') return { id: '__default', builtin: true };
  const s = scanSkins().filter(function (x) { return x.id === id; })[0];
  if (!s) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(s.dir, id, 'skin.json'), 'utf8'));
    const sheet = meta.sheet || 'sheet.png';
    const p = path.join(s.dir, id, sheet);
    const buf = fs.readFileSync(p);
    return {
      id: s.id,
      builtin: false,
      name: s.name,
      author: s.author,
      meta: meta,
      sheet: 'data:image/png;base64,' + buf.toString('base64')
    };
  } catch (err) {
    return { id: id, error: String(err && err.message || err) };
  }
});

ipcMain.handle('set-pet-size', (e, name) => setPetSize(name));
ipcMain.handle('get-pet-size', () => petSize);
ipcMain.handle('minimize', () => { if (win) win.minimize(); });
ipcMain.handle('hide', () => hideToTray());
ipcMain.handle('show-window', () => { showWindow(); return true; });
ipcMain.handle('quit', () => quitApp());

/* 「打开数据目录」：给用户看一眼程序所在位置（数据本身在 localStorage 里） */
ipcMain.handle('open-data-dir', () => {
  try {
    const p = app.isPackaged ? path.dirname(app.getPath('exe')) : __dirname;
    require('electron').shell.openPath(p);
    return true;
  } catch (e) { return false; }
});

/* 选一段自定义提醒音乐：只把路径交回页面，文件本身不拷贝、不上传。
   用户取消返回空串（页面据此什么都不改）。 */
ipcMain.handle('pick-music', async () => {
  try {
    const r = await dialog.showOpenDialog(win && !win.isDestroyed() ? win : null, {
      title: '选一段提醒时播放的音乐',
      buttonLabel: '就用这首',
      properties: ['openFile'],
      filters: [
        { name: '音乐文件', extensions: ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus', 'webm'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    });
    if (r && !r.canceled && r.filePaths && r.filePaths[0]) return r.filePaths[0];
  } catch (e) {
    diagLog('pick-music-error', { message: String((e && e.message) || e) });
  }
  return '';
});

/* 导出日记：弹一个「另存为」，把页面拼好的纯文本写进去。
   返回存到哪儿了（用户取消就返回空串）。 */
ipcMain.handle('diary-export', async (e, text, suggested) => {
  try {
    /* 自检时别弹系统对话框（自检没法点它）：直接写进 .diag，验证「文本 → 文件」这条链 */
    if (DIAG && DIAG.diary) {
      const p = diagFilePath('diary-export.txt');
      fs.writeFileSync(p, String(text || ''), 'utf8');
      return p;
    }
    const d = await dialog.showSaveDialog(win, {
      title: '导出日记',
      defaultPath: path.join(app.getPath('documents'), String(suggested || '我的日记.txt')),
      filters: [{ name: '文本文件', extensions: ['txt'] }]
    });
    if (d.canceled || !d.filePath) return '';
    fs.writeFileSync(d.filePath, String(text || ''), 'utf8');
    return d.filePath;
  } catch (err) {
    diagLog('diary-export-error', { message: String(err && err.message || err) });
    return '';
  }
});

/* ------------------------------------------- 手动拖窗（比 CSS drag 区域可靠，
   透明窗口和宠物小窗上都能用） */
let dragState = null;

/* 把窗口位置钳制在鼠标所在显示器的可用区域内，不让它被拖出屏幕 */
/* 无边框 + 可调整大小的窗口在 Windows 上会「可视窗口比 getBounds() 向外多一圈」
   （electron#51679：SM_CXSIZEFRAME + SM_CXPADDEDBORDER，左侧/右侧/下方各多一圈，
   上方不多，而且这一圈随 DPI 放大）。所以贴边摆放时要给右下留出这点余量，
   否则可视窗口会顶出工作区、边缘抓不到（用户看到的就是「像全屏、拖不动也缩放不了」）。 */
function winInsetDip() {
  try {
    const b = win && !win.isDestroyed() ? win.getBounds() : null;
    const d = b ? displayOf(b.x + Math.max(1, b.width) / 2, b.y + 8) : null;
    return Math.round(10 * ((d && d.scaleFactor) || 1));
  } catch (e) { return 10; }
}

/* 把窗口位置钳进工作区。
   inset 是「可视窗口比 getBounds() 向外多出的那一圈」（electron#51679），
   ⚠️ 只有【无边框 + 可调整大小】的主窗口才需要留这条余量 ——
   Electron 的实现里那圈只在 has_thick_frame() && IsResizable() 时才加：
       if (window_->has_frame() || !window_->has_thick_frame() || !window_->IsResizable()) return {};
   宠物窗是 resizable:false，本身没有那圈，给它留余量就会「贴不到桌面边」。
   所以 inset 由调用方显式传，主窗口传 winInsetDip()，宠物窗不传（0）。

   keep：允许窗口最多「只留这么多 DIP 露在屏幕里」。
   ⚠️ 这是主窗口才有的：用户要能把界面推到屏幕外面去（暂时不挡东西），
   只留一条边方便再拖回来。0 = 不许越界（宠物/日历还是老规矩，老老实实待在屏内）。 */
function clampToWorkArea(x, y, w, h, pt, inset, keep) {
  let wa;
  try {
    wa = screen.getDisplayNearestPoint({ x: Math.round(pt.x), y: Math.round(pt.y) }).workArea;
  } catch (err) {
    wa = screen.getPrimaryDisplay().workArea;
  }
  const insetDip = Math.max(0, Math.round(Number(inset) || 0));
  const keepDip = Math.max(0, Math.round(Number(keep) || 0));
  /* 允许推到屏幕外的深度（窗口比 keep 大多少，就能把多少推出屏幕） */
  const overX = keepDip > 0 ? Math.max(0, w - keepDip) : 0;
  const overY = keepDip > 0 ? Math.max(0, h - keepDip) : 0;
  /* 窗口比工作区还大时（理论上不该发生，但万一）：别把它钉死在左上角 ——
     那会变成「完全拖不动」，而且右/下边缘在屏幕外也就「缩放不了」。
     这种情况允许在「左上角贴边」到「右下边贴边」之间挪动。 */
  const tooWide = w > wa.width;
  const tooTall = h > wa.height;
  const minX = tooWide ? wa.x - (w - wa.width) : wa.x - overX;
  const minY = tooTall ? wa.y - (h - wa.height) : wa.y - overY;
  const maxX = wa.x + Math.max(0, wa.width - w) - (tooWide ? 0 : insetDip) + overX;
  const maxY = wa.y + Math.max(0, wa.height - h) - (tooTall ? 0 : insetDip) + overY;
  return {
    x: Math.min(Math.max(x, minX), Math.max(minX, maxX)),
    y: Math.min(Math.max(y, minY), Math.max(minY, maxY))
  };
}

/* 主窗口最多能被推到「只留这么多 DIP 露在屏里」。
   取 72：露出来的那一条通常还盖着自绘标题栏（48 DIP），用户能直接抓住再拖回来。 */
const WIN_EDGE_KEEP = 72;

ipcMain.on('drag-start', (e, pt) => {
  if (!win || !pt) return;
  dragState = { x: pt.x, y: pt.y, bounds: win.getBounds() };
});

/* 拖动。注意：渲染进程在按下鼠标时就会先让气泡收掉（pet-talk-end），
   所以拖动过程中窗口一定只有宠物那么大，这里不需要再考虑气泡。 */
ipcMain.on('drag-move', (e, pt) => {
  if (!win || !dragState || !pt) return;
  const b = dragState.bounds;
  const pos = clampToWorkArea(
    Math.round(b.x + (pt.x - dragState.x)),
    Math.round(b.y + (pt.y - dragState.y)),
    b.width, b.height, pt, winInsetDip(), WIN_EDGE_KEEP
  );
  win.setBounds({ x: pos.x, y: pos.y, width: b.width, height: b.height });
});

ipcMain.on('drag-end', () => {
  // 松手再钳一次：万一窗口尺寸或屏幕布局变了，也不会停到「一条边都不剩」的地方
  //（用户可以把界面推出屏幕，但必须留一条能抓住的边）
  if (win && !win.isDestroyed()) {
    const b = win.getBounds();
    const pos = clampToWorkArea(b.x, b.y, b.width, b.height,
      { x: b.x + b.width / 2, y: b.y + b.height / 2 }, winInsetDip(), WIN_EDGE_KEEP);
    if (pos.x !== b.x || pos.y !== b.y) {
      win.setBounds({ x: pos.x, y: pos.y, width: b.width, height: b.height });
    }
  }

  /* 主界面被拖走了：桌面宠物不跟着动（它是独立小窗，有自己的位置），
     所以这里只需把拖动状态清掉。 */
  dragState = null;
});

ipcMain.on('state', (e, s) => {
  if (!s) return;
  let changed = (timersRunning !== !!s.running);
  timersRunning = !!s.running;

  /* 提醒列表变了（用户加/删/改了事项），菜单要重建 */
  if (Array.isArray(s.items)) {
    const next = s.items
      .filter(it => it && it.id && it.name)
      .map(it => ({ id: it.id, name: it.name, emoji: it.emoji || '', minutes: +it.minutes || 30 }));
    if (JSON.stringify(next) !== JSON.stringify(menuItems)) {
      menuItems = next;
      changed = true;
    }
  }
  /* 主界面刚启动时同步过来的桌面宠物开关与形象/大小（主进程才是权威） */
  if (typeof s.petOn === 'boolean' && s.petOn !== petOn) {
    setPetOn(s.petOn);
    changed = true;
  }
  /* 桌面日历经开关同理（这条是主界面同步过来的，不是用户点击，所以不抢焦点） */
  if (typeof s.calOn === 'boolean' && s.calOn !== calOn) {
    setCalOn(s.calOn, false);
    changed = true;
  }
  if (typeof s.petSound === 'boolean' && s.petSound !== petSoundOn) {
    petSoundOn = s.petSound;
    if (petWin && !petWin.isDestroyed()) petWin.webContents.send('pet-win-sound', petSoundOn);
  }
  if (typeof s.skin === 'string' && s.skin && s.skin !== currentSkin) setPetSkin(s.skin);
  if (changed) refreshTrayMenu();
});

/* --------------------------------------------------- 电源事件（睡眠 / 息屏） */
function bindPowerEvents() {
  const map = {
    'suspend': 'suspend',
    'resume': 'resume',
    'lock-screen': 'lock',
    'unlock-screen': 'unlock'
  };
  Object.keys(map).forEach(function (ev) {
    try {
      powerMonitor.on(ev, function () {
        send('power', map[ev]);
        /* 息屏 / 休眠会让驱动把伽马表复位，醒来要重新调暖 */
        if (ev === 'resume' || ev === 'unlock-screen') eyeCareReapply(ev === 'resume' ? 1500 : 700);
      });
    } catch (e) { /* 个别平台不支持就跳过 */ }
  });
}

/* ============================================================ 软件自动更新
   策略：只检查、只提示。点「下载」才开始下，下完再点「重启并安装」。
   所以 autoDownload 和 autoInstallOnAppQuit 都是 false —— 全程不擅自动手。

   注意自动更新只在【打包后】有效：开发模式（electron .）没有 app-update.yml，
   除非项目根目录放了 dev-app-update.yml（那是给本地自测用的）。 */
const UPDATE_FIRST_DELAY = 8 * 1000;          // 启动后 8 秒查第一次
const UPDATE_EVERY = 6 * 60 * 60 * 1000;      // 之后每 6 小时查一次

let updateSupported = false;
let updateState = 'unsupported';  // unsupported|idle|checking|available|downloading|downloaded|none|error
let updateInfo = null;            // { version, releaseNotes, releaseDate }
let updatePercent = 0;
let updateError = '';
let updateAutoCheck = true;
let updateTimer = null;
let updateNextDelay = UPDATE_FIRST_DELAY;
let updateManual = false;         // 这次检查是不是用户手点的（后台查到的才弹托盘气泡）

function updatePrefFile() { return path.join(app.getPath('userData'), 'update-settings.json'); }

function loadUpdatePref() {
  try {
    /* 同 loadMoyuPref：手改过的文件可能带 BOM，先去干净再解析 */
    const o = JSON.parse(fs.readFileSync(updatePrefFile(), 'utf8').replace(/^\uFEFF/, ''));
    if (o && typeof o.autoCheck === 'boolean') updateAutoCheck = o.autoCheck;
    if (o && typeof o.lastSource === 'string') updateLastGood = o.lastSource;
  } catch (e) { /* 首次运行没这个文件，用默认值 */ }
}

function saveUpdatePref() {
  try {
    fs.writeFileSync(updatePrefFile(),
      JSON.stringify({ autoCheck: updateAutoCheck, lastSource: updateLastGood }, null, 2), 'utf8');
  } catch (e) { }
}

/* ============================================================ 更新源（多源 + 自动选路）
   国内直连 GitHub 经常不通，所以备两个源，检查时都探一下、挑能用的：

     · github —— electron-updater 原生跑。好处：能显示 Release 更新说明，
                 而且能走 blockmap 差分（小版本往往只下几 MB）
     · gitee  —— 读仓库里的 update/latest.json（Gitee raw，地址恒定、国内快）。
                 安装包在 Gitee 上超过附件上限（100MB），所以按【分卷】传，
                 由我们下载后合并、再对整包做 sha512 校验。

   选路策略：优先用上次成功的源；否则按探测耗时从快到慢试；失败自动换下一个。 */
const UPDATE_SOURCES = [
  { id: 'github', label: 'GitHub', kind: 'github' },
  {
    id: 'gitee', label: 'Gitee 镜像', kind: 'mirror',
    /* 自测时可以用环境变量把它指到本地假更新源上（见 .diag/ 里的更新自检） */
    manifest: process.env.KUNKUN_UPDATE_MIRROR
      || 'https://gitee.com/gaofan666/iKunReminder/raw/main/update/latest.json'
  }
];
const UPDATE_PROBE_TIMEOUT = 6000;

let updateSourceId = '';          // 这次实际用的源
let updateSourceTried = [];       // 这次探测过的源 + 结果（给界面看）
let updateLastGood = '';          // 上次成功的源（存 userData，下次优先）
let updateMirror = null;          // Gitee 源解析出来的清单
let updateMergedExe = '';         // Gitee 源下载合并后的安装包路径

/* 带超时的取回，返回 { status, text } 或抛错 */
async function httpGetText(url, timeoutMs, wantStream) {
  const ac = new AbortController();
  /* timeoutMs <= 0 表示不限时（大文件下载用），此时绝不能设定时器 ——
     setTimeout(fn, 0) 会立刻触发 abort */
  const t = timeoutMs > 0 ? setTimeout(function () { ac.abort(); }, timeoutMs) : null;
  try {
    const r = await fetch(url, { signal: ac.signal, redirect: 'follow' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return wantStream ? r : { status: r.status, text: await r.text() };
  } finally {
    if (t) clearTimeout(t);
  }
}

/* 探测一个源能不能用：拉个「小文件」量耗时。
   不用 ping —— ICMP 很多网络禁掉，而且只反映延迟、不反映带宽。 */
async function probeSource(src) {
  const started = Date.now();
  try {
    if (src.kind === 'github') {
      await httpGetText('https://api.github.com/repos/Gaofan666/iKunReminder/releases/latest', UPDATE_PROBE_TIMEOUT);
    } else {
      await httpGetText(src.manifest, UPDATE_PROBE_TIMEOUT);
    }
    return { id: src.id, label: src.label, ok: true, ms: Date.now() - started };
  } catch (e) {
    return {
      id: src.id, label: src.label, ok: false, ms: Date.now() - started,
      error: String((e && e.message) || e).slice(0, 120)
    };
  }
}

/* 版本号比较：a > b 返回正数 */
function cmpVersion(a, b) {
  const pa = String(a || '0').split('.').map(Number);
  const pb = String(b || '0').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/* 走 GitHub 官方源（electron-updater 原生） */
async function checkViaGitHub() {
  autoUpdater.setFeedURL({
    provider: 'github', owner: 'Gaofan666', repo: 'iKunReminder'
  });
  await autoUpdater.checkForUpdates();   // 状态由事件回调设置；失败会 reject
}

/* 走 Gitee 镜像源：自己拉清单比对版本 */
async function checkViaMirror(src) {
  const r = await httpGetText(src.manifest, 8000);
  let m = null;
  try { m = JSON.parse(r.text.replace(/^\uFEFF/, '')); } catch (e) { throw new Error('清单格式不对'); }
  if (!m || !m.version) throw new Error('清单里没有 version');

  updateMirror = m;
  if (cmpVersion(m.version, app.getVersion()) > 0) {
    updateInfo = { version: m.version, releaseNotes: m.notes || '', releaseDate: m.releaseDate || '' };
    updateState = 'available';
    updatePercent = 0;
    pushUpdate();
    if (!updateManual && tray && typeof tray.displayBalloon === 'function') {
      try {
        tray.displayBalloon({
          title: '有新版本 v' + m.version,
          content: '打开「设置」页可以下载并安装，不会自动装。'
        });
      } catch (e) { }
    }
  } else {
    updateInfo = null;
    updateState = 'none';
    pushUpdate();
  }
}

/* ---------- Gitee 源：分卷下载 → 合并 → 校验整包 sha512 ---------- */
async function fetchToFile(url, file, baseBytes, totalBytes, onProgress) {
  /* 第三个参数 wantStream=true 必须传：不传的话拿回来的是 {status,text} 而不是 Response，
     r.body 就是 undefined，报 "Cannot read properties of undefined (reading 'getReader')" */
  const r = await httpGetText(url, 0, true);
  const reader = r.body.getReader();
  const fd = fs.openSync(file, 'a');
  let got = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      fs.writeSync(fd, Buffer.from(chunk.value));
      got += chunk.value.length;
      onProgress(baseBytes + got, totalBytes);
    }
  } finally {
    fs.closeSync(fd);
  }
  return got;
}

function sha512Of(file) {
  return new Promise(function (resolve, reject) {
    const h = crypto.createHash('sha512');
    const s = fs.createReadStream(file);
    s.on('data', function (c) { h.update(c); });
    s.on('end', function () { resolve(h.digest('base64')); });
    s.on('error', reject);
  });
}

async function downloadViaMirror() {
  const m = updateMirror;
  if (!m || !Array.isArray(m.parts) || !m.parts.length) throw new Error('清单里没有分卷信息');

  const total = m.parts.reduce(function (a, p) { return a + (p.size || 0); }, 0) || m.size || 1;
  const out = path.join(app.getPath('userData'), 'pending-' + m.version + '.exe');

  /* 每次重新下，避免上次的残缺文件被当成续传基准 */
  try { fs.unlinkSync(out); } catch (e) { }

  let base = 0;
  for (let i = 0; i < m.parts.length; i++) {
    const p = m.parts[i];
    updatePercent = Math.floor(base / total * 100);
    pushUpdate();
    const got = await fetchToFile(p.url, out, base, total, function (done, tot) {
      const pc = Math.floor(done / tot * 100);
      if (pc !== updatePercent) { updatePercent = pc; pushUpdate(); }
    });
    if (p.size && got !== p.size) throw new Error('第 ' + (i + 1) + ' 个分卷大小不对');
    base += got;
  }

  /* 关键：校验【合并后的整包】，光校验分卷不够 —— 断网/磁盘满都可能拼出坏包 */
  updateState = 'downloading';
  const got = await sha512Of(out);
  if (m.sha512 && got !== m.sha512) {
    try { fs.unlinkSync(out); } catch (e) { }
    throw new Error('下载的文件校验不通过（可能没下全），请重试');
  }
  updateMergedExe = out;
  updateState = 'downloaded';
  updatePercent = 100;
  pushUpdate();
}

/* GitHub 的 releaseNotes 可能是字符串，也可能是 [{version, note}] 数组 */
function notesText(notes) {
  if (!notes) return '';
  if (typeof notes === 'string') return notes;
  if (Array.isArray(notes)) return notes.map(function (n) { return (n && n.note) || ''; }).join('\n');
  return '';
}

function updateSnapshot() {
  return {
    state: updateState,
    supported: updateSupported,
    devMode: !app.isPackaged,
    currentVersion: app.getVersion(),
    autoCheck: updateAutoCheck,
    percent: updatePercent,
    error: updateError,
    available: updateInfo ? String(updateInfo.version || '') : '',
    notes: updateInfo ? notesText(updateInfo.releaseNotes) : '',
    /* 用了哪个更新源、探测过哪些（给设置页显示） */
    source: updateSourceId,
    sourceLabel: (UPDATE_SOURCES.filter(function (s) { return s.id === updateSourceId; })[0] || {}).label || '',
    sourceTried: updateSourceTried
  };
}

function pushUpdate() { send('update-status', updateSnapshot()); }

function setUpdateError(err) {
  updateState = 'error';
  updateError = String((err && err.message) || err || '未知错误').slice(0, 300);
  pushUpdate();
}

function initUpdater() {
  if (!autoUpdater) return;   // 没装上 electron-updater：保持 unsupported

  /* 开发模式没放测试配置：查了也是白报错，直接标成不支持 */
  if (!app.isPackaged && !fs.existsSync(path.join(app.getAppPath(), 'dev-app-update.yml'))) {
    updateState = 'unsupported';
    return;
  }

  updateSupported = true;
  updateState = 'idle';

  /* 开发模式下 electron-updater 默认拒绝检查更新（日志是
     "Skip checkForUpdates because application is not packed and dev update config is not forced"），
     必须显式开这个开关才会去读 dev-app-update.yml。
     打包后的版本 app.isPackaged 为真，本来就会查，这个开关对它没有影响。 */
  autoUpdater.forceDevUpdateConfig = true;

  autoUpdater.autoDownload = false;          // 只提示；下载要用户点
  autoUpdater.autoInstallOnAppQuit = false;  // 退出时也不擅自装
  autoUpdater.allowPrerelease = false;       // 不碰预发布版

  autoUpdater.on('checking-for-update', function () {
    updateState = 'checking'; updateError = ''; pushUpdate();
  });

  autoUpdater.on('update-available', function (info) {
    updateInfo = info || null;
    updateState = 'available';
    updatePercent = 0;
    pushUpdate();
    /* 后台自己查到的，就用托盘气泡轻轻提一句，不抢前台、不打断 */
    if (!updateManual && tray && typeof tray.displayBalloon === 'function') {
      try {
        tray.displayBalloon({
          title: '有新版本 v' + String((info && info.version) || ''),
          content: '打开「设置」页可以下载并安装，不会自动装。'
        });
      } catch (e) { }
    }
  });

  autoUpdater.on('update-not-available', function () {
    updateInfo = null;
    updateState = 'none';
    pushUpdate();
  });

  /* 进度事件很密，只在整数百分比变化时才推给页面，别把 IPC 打满 */
  autoUpdater.on('download-progress', function (p) {
    const pc = Math.round((p && p.percent) || 0);
    updateState = 'downloading';
    if (pc !== updatePercent) { updatePercent = pc; pushUpdate(); }
  });

  autoUpdater.on('update-downloaded', function (info) {
    if (info) updateInfo = info;
    updateState = 'downloaded';
    updatePercent = 100;
    pushUpdate();
  });

  autoUpdater.on('error', function (err) { setUpdateError(err); });
}

async function checkUpdate(manual) {
  if (!updateSupported) return updateSnapshot();
  if (updateState === 'downloading') return updateSnapshot();
  updateManual = !!manual;
  updatePercent = 0;
  updateError = '';
  updateState = 'checking';
  updateSourceTried = [];
  updateMirror = null;
  pushUpdate();

  /* 1) 并发探测所有源（各带超时）。上次成功的排最前，其余按耗时从快到慢 ——
        不用每次重新测速，常用源直接命中。 */
  const probes = await Promise.all(UPDATE_SOURCES.map(function (s) { return probeSource(s); }));
  updateSourceTried = probes.map(function (p) {
    return { id: p.id, label: p.label, ok: p.ok, ms: p.ms, error: p.error || '' };
  });
  const usable = probes.filter(function (p) { return p.ok; }).sort(function (a, b) {
    if (a.id === updateLastGood) return -1;
    if (b.id === updateLastGood) return 1;
    return a.ms - b.ms;
  });

  if (!usable.length) {
    updateState = 'error';
    updateError = '两个更新源都连不上（GitHub 和 Gitee 都试过了），检查一下网络';
    pushUpdate();
    return updateSnapshot();
  }

  /* 2) 依次尝试，成功即定；失败就换下一个源 */
  let lastErr = null;
  for (const p of usable) {
    const src = UPDATE_SOURCES.filter(function (s) { return s.id === p.id; })[0];
    try {
      if (src.kind === 'github') await checkViaGitHub();
      else await checkViaMirror(src);
      updateSourceId = p.id;
      updateLastGood = p.id;
      saveUpdatePref();
      diagLog('update-source', { used: p.id, probes: updateSourceTried });
      return updateSnapshot();
    } catch (e) {
      lastErr = e;
      const t = updateSourceTried.filter(function (x) { return x.id === p.id; })[0];
      if (t) { t.ok = false; t.error = String((e && e.message) || e).slice(0, 120); }
      diagLog('update-source-fail', { id: p.id, error: String((e && e.message) || e) });
    }
  }

  updateSourceId = '';
  updateState = 'error';
  updateError = String((lastErr && lastErr.message) || lastErr || '所有更新源都失败了').slice(0, 300);
  pushUpdate();
  return updateSnapshot();
}

function downloadUpdate() {
  if (!updateSupported || updateState !== 'available') return false;
  updateState = 'downloading';
  updatePercent = 0;
  updateError = '';
  pushUpdate();

  const src = UPDATE_SOURCES.filter(function (s) { return s.id === updateSourceId; })[0];
  if (src && src.kind === 'mirror') {
    /* Gitee 源：自己按分卷下 → 合并 → 校验整包 sha512 */
    downloadViaMirror().catch(function (err) { setUpdateError(err); });
  } else {
    /* GitHub 源：electron-updater 原生，能走 blockmap 差分 */
    autoUpdater.downloadUpdate().catch(function (err) { setUpdateError(err); });
  }
  return true;
}

function installUpdate() {
  if (!updateSupported || updateState !== 'downloaded') return false;
  quitting = true;                 // 别让 close 处理器把窗口收进托盘
  send('update-installing');

  const src = UPDATE_SOURCES.filter(function (s) { return s.id === updateSourceId; })[0];
  setImmediate(function () {
    try {
      if (src && src.kind === 'mirror') {
        /* Gitee 源：合并好的安装包已经在自己手里了，按 NSIS 静默升级的规矩直接启动它。
           参数与 electron-updater 的 quitAndInstall 保持一致：
             --updated    告诉安装程序这是升级（保留用户数据、不走向导）
             /S           静默
             --force-run  装完把新版拉起来
           用 detached + stdio:'ignore'：不占管道，父进程退出也不影响它 */
        const child = spawn(updateMergedExe, ['--updated', '/S', '--force-run'], {
          detached: true, stdio: 'ignore'
        });
        child.unref();
        setTimeout(function () { app.quit(); }, 700);
      } else {
        /* GitHub 源：electron-updater 原生（静默安装 + 装完自动拉起） */
        autoUpdater.quitAndInstall(true, true);
      }
    } catch (e) {
      quitting = false;
      setUpdateError(e);
    }
  });
  return true;
}

function scheduleUpdateCheck() {
  clearTimeout(updateTimer);
  if (!updateSupported || !updateAutoCheck) return;
  updateTimer = setTimeout(function () {
    checkUpdate(false);
    updateNextDelay = UPDATE_EVERY;
    scheduleUpdateCheck();
  }, updateNextDelay);
}

ipcMain.handle('update-get-state', () => updateSnapshot());
ipcMain.handle('update-check', () => checkUpdate(true));
ipcMain.handle('update-download', () => downloadUpdate());
ipcMain.handle('update-install', () => installUpdate());
ipcMain.handle('update-set-auto-check', (e, on) => {
  updateAutoCheck = !!on;
  saveUpdatePref();
  if (updateAutoCheck) scheduleUpdateCheck(); else clearTimeout(updateTimer);
  pushUpdate();
  return updateAutoCheck;
});

/* ============================================================ 一键摸鱼（老板键）
   只由全局快捷键触发（设置页里没有按钮）：
     · 按一次 → 把桌面上所有窗口收起来（等于按 Win+D），再自动打开用户指定的
                程序 / 文档：文档会自动最大化，程序只要打开就行。
     · 再按一次 → 把刚才收起来的窗口全部还原，伪装软件留着不动。
   桌面宠物不动（按需求：不藏小鸡）。
   快捷键和伪装目标都存在 userData\moyu.json。 */
const MOYU_DEFAULT_ACCEL = 'Ctrl+Alt+M';

/* 默认值之外再备一排：Ctrl+Alt+M 在不少机器上会被别的软件占掉
   （开发这台就被占了，独立探针实测 ❌）。只要用户没自己改过，
   注册失败就按这个顺序顺位往后试，试到能用为止。 */
const MOYU_FALLBACK_ACCELS = [
  'Ctrl+Shift+M', 'Ctrl+Alt+H', 'Ctrl+Shift+H',
  'Ctrl+Alt+Q', 'Ctrl+Shift+Q', 'Alt+Shift+M', 'Alt+Shift+H',
  'Ctrl+Alt+F9', 'Ctrl+Shift+F9', 'F9', 'F10'
];

/* 这些后缀算「程序」：打开就完事，不去抢最大化。
   其余（doc/docx/pdf/txt…）都当文档，开完再最大化。 */
const MOYU_PROGRAM_EXT = ['exe', 'lnk', 'bat', 'cmd', 'com', 'msc', 'ps1', 'url'];

let moyuOn = true;
let moyuAccel = MOYU_DEFAULT_ACCEL;
let moyuActiveAccel = null;   // 当前真正注册成功的那一个
let moyuError = '';
let moyuResult = '';          // ok | off | empty | taken | invalid
let moyuTarget = '';          // 伪装目标（程序或文档的完整路径）
let moyuRunning = false;      // 是否正处在「摸鱼中」
let moyuCustom = false;       // 快捷键是不是用户自己录的
let moyuAutoPicked = false;   // 这次是不是自动顺位换了一个组合
let moyuGoChild = null;       // 「收起桌面 + 打开目标」那个 PowerShell 进程
let moyuBacking = false;      // 正在还原（等清单落盘 → kill → Restore），期间不接受切换
let moyuGoAt = 0;             // 这次摸鱼的启动时间戳（保险丝用它判断是不是同一次）
let moyuRuntimeError = '';    // 运行期出错（比如 PowerShell 没跑起来），显示给用户

function moyuPrefFile() { return path.join(app.getPath('userData'), 'moyu.json'); }

function loadMoyuPref() {
  try {
    /* 去掉可能存在的 UTF-8 BOM：用记事本手改过这个文件就会带上，
       而 JSON.parse 碰到 BOM 会直接抛错，那样配置就被静默忽略了 */
    const raw = fs.readFileSync(moyuPrefFile(), 'utf8').replace(/^\uFEFF/, '');
    const o = JSON.parse(raw);
    if (o) {
      if (typeof o.on === 'boolean') moyuOn = o.on;
      if (typeof o.accel === 'string' && o.accel) moyuAccel = o.accel;
      if (typeof o.target === 'string') moyuTarget = o.target;
      if (typeof o.custom === 'boolean') moyuCustom = o.custom;
      /* 连击摸鱼 */
      if (typeof o.tapOn === 'boolean') moyuTapOn = o.tapOn;
      if (typeof o.tapKey === 'string' && o.tapKey) {
        for (let i = 0; i < MOYU_TAP_KEYS.length; i++) {
          if (MOYU_TAP_KEYS[i].id === o.tapKey) { moyuTapKey = o.tapKey; break; }
        }
      }
    }
  } catch (e) { /* 首次运行没这个文件，用默认值 */ }
}

function saveMoyuPref() {
  try {
    fs.writeFileSync(moyuPrefFile(),
      JSON.stringify({
        on: moyuOn, accel: moyuAccel, target: moyuTarget, custom: moyuCustom,
        tapOn: moyuTapOn, tapKey: moyuTapKey
      }, null, 2), 'utf8');
  } catch (e) { }
}

function moyuIsDoc(p) {
  const ext = String(p).split('.').pop().toLowerCase();
  return MOYU_PROGRAM_EXT.indexOf(ext) < 0;
}

function moyuSnapshot() {
  return {
    on: moyuOn,
    accel: moyuAccel,
    /* active：这一刻快捷键是否真的挂在系统上了（页面靠它判断成败） */
    active: !!moyuActiveAccel,
    used: moyuActiveAccel || '',
    error: moyuError,
    result: moyuResult,
    defaultAccel: MOYU_DEFAULT_ACCEL,
    custom: moyuCustom,
    autoPicked: moyuAutoPicked,
    target: moyuTarget,
    targetName: moyuTarget ? path.basename(moyuTarget) : '',
    targetIsDoc: !!moyuTarget && moyuIsDoc(moyuTarget),
    running: moyuRunning,
    /* 运行期出错（比如 PowerShell 被拦、桌面没被收起）——要如实报给界面，
       否则用户看到的是「按了没反应」却完全不知道发生了什么 */
    runtimeError: moyuRuntimeError,
    /* 连击摸鱼：tapKeys 是可选键清单（页面用它填下拉框），
       tapReady 表示键盘钩子真的装上了 —— 装不上要如实告诉用户 */
    tapOn: moyuTapOn,
    tapKey: moyuTapKey,
    tapKeyLabel: moyuTapKeyDef().label,
    tapKeys: MOYU_TAP_KEYS.map(function (k) { return { id: k.id, label: k.label }; }),
    tapReady: moyuTapReady,
    tapError: moyuTapError,
    tapGap: MOYU_TAP_GAP,
    tapWindow: MOYU_TAP_WINDOW
  };
}

/* ---------- 用 PowerShell 操作桌面窗口 ----------
   走 -EncodedCommand（base64）而不是临时 .ps1 文件：
   一是省得往磁盘写脚本（杀毒软件对 AppData 里执行脚本很敏感），
   二是彻底绕开引号/换行的转义问题。 */
function psRun(script, done) {
  const b64 = Buffer.from(script, 'utf16le').toString('base64');
  let child = null;
  try {
    child = execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64],
      { windowsHide: true, timeout: 30000 },
      function (err, stdout, stderr) {
        /* 自检时把退出码 / stdout / stderr 都留下来。
           只记 err.message 会被 PowerShell 的 CLIXML 噪音盖住，看不出真正的原因。 */
        if (err) diagLog('moyu-ps-error', {
          message: String((err && err.message) || err).slice(0, 1200),
          code: (err && err.code) || '',
          killed: !!(err && err.killed),
          signal: (err && err.signal) || '',
          stdout: String(stdout || '').slice(0, 3000),
          stderr: String(stderr || '').slice(0, 3000)
        });
        if (typeof done === 'function') done(err, String(stdout || ''));
      });
  } catch (e) {
    /* execFile 自己也可能同步抛（powershell.exe 起不来、被安全软件拦）。
       绝不能让它把调用方带崩：调用方那边还有状态要复位、窗口要放回来。 */
    diagLog('moyu-ps-spawn-error', { message: String((e && e.message) || e) });
    setTimeout(function () { if (typeof done === 'function') done(e, ''); }, 0);
    return null;
  }
  return child;
}

/* 摸鱼时【绝对不碰】的窗口。
   壁纸软件（Wallpaper Engine / Lively 这类）是把壁纸画在挂在 WorkerW / Progman
   下面的窗口里的，一旦被最小化，桌面就只剩纯色背景，而且它自己不一定恢复得回来。
   从两个维度识别：窗口类名（桌面壳层）+ 进程名（壁纸类软件）。 */
const MOYU_SKIP_CLASSES = [
  'Progman', 'WorkerW',                                    // 桌面本体
  'Shell_TrayWnd', 'Shell_SecondaryTrayWnd',               // 任务栏
  'SysListView32', 'SysHeader32',                          // 桌面图标
  'ApplicationManager_DesktopShellWindow',
  'Windows.UI.Core.CoreWindow',
  'XamlExplorerHostIslandWindow', 'Xaml_WindowedPopupClass',
  'TopLevelWindowForOverflowXamlIsland',
  'ForegroundStaging', 'MultitaskingViewFrame',
  'TaskListThumbnailWnd', 'Shell_InputSwitchTopLevelWindow',
  'EdgeUiInputTopWndClass', 'NarratorHelperWindow',
  'Windows.Internal.Shell.TabProxyWindow'
].join(',');

const MOYU_SKIP_PROCS = [
  'wallpaper32', 'wallpaper64', 'wallpaper_engine', 'wallpaperengine', 'ui32', 'ui64',  // Wallpaper Engine
  'lively', 'livelywpf',                    // Lively Wallpaper
  'rainmeter', 'deskscapes', 'dreamscene',  // 其他动态壁纸/桌面小工具
  'dynamicwallpaper', 'wallpaper'
].join(',');

/* 还能自己在 userData\moyu-skip.txt 里补进程名（一行一个，或用逗号分隔），
   免得遇到我没收录的壁纸软件就没辙 */
function moyuSkipProcs() {
  let extra = '';
  try {
    extra = fs.readFileSync(path.join(app.getPath('userData'), 'moyu-skip.txt'), 'utf8')
      .replace(/^\uFEFF/, '');
  } catch (e) { /* 没这个文件很正常 */ }
  const list = extra.split(/[\r\n,]+/)
    .map(function (s) { return s.trim().toLowerCase(); })
    .filter(Boolean);
  return list.length ? (MOYU_SKIP_PROCS + ',' + list.join(',')) : MOYU_SKIP_PROCS;
}

/* 用 EnumWindows 逐个精确最小化，而不是 Shell 的 MinimizeAll()。
   原因：MinimizeAll 是「显示桌面」那套状态，紧接着 Start-Process 打开新窗口时
   会把它顶掉 —— 实测出现「文档打开了、但自己的窗口又弹回来了」。
   自己枚举还顺带能记住到底最小化了哪些窗口，还原时只还原这些。 */
const MOYU_WINAPI = [
  'Add-Type @"',
  'using System;',
  'using System.Collections.Generic;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  'public class KkWin {',
  '  delegate bool EnumProc(IntPtr h, IntPtr l);',
  '  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);',
  '  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);',
  /* IsIconic / ShowWindow 要从 PowerShell 直接调，必须是 public ——
     static extern 默认是 private，漏了 public 会报 "does not contain a method named" */
  '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
  '  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);',
  '  [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, StringBuilder s, int n);',
  '  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
  '  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int idx);',
  '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string win);',
  '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);',
  '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
  '  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);',
  '',
  '  static List<string> SplitCsv(string csv) {',
  '    var l = new List<string>();',
  '    if (csv != null) {',
  '      foreach (var s in csv.Split(new char[] { (char)44 })) {',
  '        var t = s.Trim().ToLower();',
  '        if (t.Length > 0) l.Add(t);',
  '      }',
  '    }',
  '    return l;',
  '  }',
  '',
  /* DWM 隐身（cloaked）：UWP / 桌面壳层留下的「空壳窗口」，IsWindowVisible 仍然
     返回 true、IsIconic 返回 false，但屏幕上根本看不见（实测本机一堆
     ApplicationFrameWindow 空壳就是 cloak=2）。Win10 上这类残留比 Win11 更多
     （关掉的 UWP 应用会留一堆 frame 空壳）。
     不排掉的话两个后果：收桌面时白收一遍，认目标窗口时把空壳当成「新窗口」——
     结果就是「打开了但没最大化」，因为最大化的其实是个看不见的壳。 */
  '  static bool Cloaked(IntPtr h) {',
  '    int v = 0;',
  '    try { DwmGetWindowAttribute(h, 14, out v, 4); } catch {}',
  '    return v != 0;',
  '  }',
  '',
  /* 「真实的应用窗口」：MinimizeAll / VisibleHandles / IconicHandles / PickTarget
     共用同一套判定，Win10 和 Win11 行为一致。 */
  '  static bool RealWindow(IntPtr h, int selfPid, List<string> skipClasses) {',
  '    if (!IsWindowVisible(h)) return false;',
  '    if (Cloaked(h)) return false;',
  '    if ((GetWindowLong(h, -20) & 0x00000080) != 0) return false;',    // WS_EX_TOOLWINDOW
  '    if (selfPid != 0) {',
  '      uint pid; GetWindowThreadProcessId(h, out pid);',
  '      if ((int)pid == selfPid) return false;',                        // 自己的宠物/气泡窗
  '    }',
  '    var cb = new StringBuilder(256); GetClassName(h, cb, 256);',
  '    string cls = cb.ToString();',
  '    if (skipClasses != null && skipClasses.Contains(cls.ToLower())) return false;',
  '    if (GetWindowTextLength(h) > 0) return true;',
  /* UWP 的 ApplicationFrameWindow 标题常常是空的，真正的标题挂在子 CoreWindow
     上。只放行「还有活的 CoreWindow 子窗口」的 frame —— 已经关掉只剩空壳的不算。 */
  '    return cls == "ApplicationFrameWindow" &&',
  '           FindWindowEx(h, IntPtr.Zero, "Windows.UI.Core.CoreWindow", null) != IntPtr.Zero;',
  '  }',
  '',
  '  public static IntPtr[] MinimizeAll(int selfPid, string skipProcs, string skipClasses) {',
  '    var procs = SplitCsv(skipProcs);',
  '    var classes = SplitCsv(skipClasses);',
  '    var list = new List<IntPtr>();',
  '    EnumWindows(delegate(IntPtr h, IntPtr l) {',
  '      if (!RealWindow(h, selfPid, classes)) return true;',
  '      if (IsIconic(h)) return true;',                                  // 本来就最小化的不动
  '      uint pid; GetWindowThreadProcessId(h, out pid);',
  '      string pname = "";',
  '      try { pname = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName.ToLower(); } catch {}',
  '      if (procs.Contains(pname)) return true;',                        // 壁纸类软件，绝不碰
  '      list.Add(h);',
  '      ShowWindow(h, 6);',                                              // SW_MINIMIZE
  '      return true;',
  '    }, IntPtr.Zero);',
  '    return list.ToArray();',
  '  }',
  '',
  /* 收起桌面之前把「已经存在的可见窗口」记下来。
     后面靠它区分「这次新冒出来的窗口」和「本来就开着、被我们最小化的窗口」。 */
  '  public static IntPtr[] VisibleHandles(int selfPid) {',
  '    var list = new List<IntPtr>();',
  '    EnumWindows(delegate(IntPtr h, IntPtr l) {',
  '      if (RealWindow(h, selfPid, null)) list.Add(h);',
  '      return true;',
  '    }, IntPtr.Zero);',
  '    return list.ToArray();',
  '  }',
  '',
  /* 「收起桌面之前本来就是最小化」的窗口。
     它们不会出现在 MinimizeAll 的返回清单里（那个只记我们收起来的），
     但目标程序如果是「本来就在跑、窗口本来就是最小化的」，打开文件时
     它还原的是这个老窗口 —— 这一路也得认出来，否则只认新窗口会漏。 */
  '  public static IntPtr[] IconicHandles(int selfPid) {',
  '    var list = new List<IntPtr>();',
  '    EnumWindows(delegate(IntPtr h, IntPtr l) {',
  '      if (RealWindow(h, selfPid, null) && IsIconic(h)) list.Add(h);',
  '      return true;',
  '    }, IntPtr.Zero);',
  '    return list.ToArray();',
  '  }',
  '',
  /* 进程名（小写，不带扩展名），拿不到返回空串 */
  '  static string ProcName(IntPtr h) {',
  '    uint pid; GetWindowThreadProcessId(h, out pid);',
  '    try { return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName.ToLower(); } catch { return ""; }',
  '  }',
  '',
  /* 文档 → 默认打开它的那个可执行文件名。
     为什么要它：光凭「刚冒出来的窗口」判断不够 —— 实测用户按老板键时，
     顺便自动弹出来的 VPN / ChatGPT 客户端也被当成了目标窗口给最大化了
     （用户看到的就是「按了老板键，VPN 也被打开了」）。
     有了这个白名单，只认「这次要打开的那个程序」的窗口，别的窗口一概不碰。 */
  '  [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)]',
  '  static extern int AssocQueryString(int flags, int str, string assoc, string extra, StringBuilder buf, ref int len);',
  '',
  /* 从「可执行文件路径（可能带参数）」里取出纯路径。
     坑：不能简单地「按第一个空格截断」—— 像
     C:\Program Files\WindowsApps\...\Notepad.exe 这种带空格的路径会被截成
     C:\Program，于是扩展名判断失败、白名单变空、整个进程过滤失效。
     所以只在「确实带参数」时截断：带引号的取引号内，不带引号的找到 .exe/.com 为止。 */
  '  static string ExePathOnly(string s) {',
  '    s = (s == null ? "" : s.Trim());',
  '    if (s.StartsWith("\\"")) {',
  '      int q = s.IndexOf((char)34, 1);',
  '      if (q > 0) return s.Substring(1, q - 1);',
  '      return s.TrimStart(new char[] { (char)34 });',
  '    }',
  '    string low = s.ToLower();',
  '    int ei = low.IndexOf(".exe");',
  '    if (ei >= 0) return s.Substring(0, ei + 4);',
  '    ei = low.IndexOf(".com");',
  '    if (ei >= 0) return s.Substring(0, ei + 4);',
  '    return s;',
  '  }',
  '',
  '  public static string ExpectedProcs(string target) {',
  '    var list = new List<string>();',
  '    string t = (target == null ? "" : target.Trim());',
  '    if (t.Length == 0) return "";',
  '    string ext = System.IO.Path.GetExtension(t).TrimStart(new char[] { (char)46 }).ToLower();',
  '    /* 先问 shell 关联：.pdf / .docx / .txt 这些都能问出可执行文件路径 */',
  '    try {',
  '      var sb = new StringBuilder(1024);',
  '      int n = sb.Capacity;',
  '      if (AssocQueryString(0, 2, t, "open", sb, ref n) == 0) {',
  '        string exe = ExePathOnly(sb.ToString());',
  /* 只认 .exe/.com：.url 的关联会给出 ieframe.dll（实际由 rundll32 打开），
     直接把 dll 名字当进程名会让白名单永远匹配不上。 */
  '        string lext = System.IO.Path.GetExtension(exe).ToLower();',
  '        if (lext == ".exe" || lext == ".com") {',
  '          string nm = System.IO.Path.GetFileNameWithoutExtension(exe).ToLower();',
  '          if (nm.Length > 0) list.Add(nm);',
  '        }',
  '      }',
  '    } catch {}',
  '    /* 可执行文件本身：就算关联查不到，进程名也就是文件名 */',
  '    if (ext == "exe" || ext == "com") {',
  '      string nm2 = System.IO.Path.GetFileNameWithoutExtension(t).ToLower();',
  '      if (nm2.Length > 0 && !list.Contains(nm2)) list.Add(nm2);',
  '    }',
  '    return string.Join(",", list.ToArray());',
  '  }',
  '',
  /* 挑出「这次打开动作真正拉起来的那个窗口」，找不到返回 Zero。
     顺序：
       ① before 之外的新窗口，且进程属于 wantProcs（目标程序开了新窗口）
       ② 刚从最小化恢复、且进程属于 wantProcs 的窗口
          （目标程序本来就在跑，打开文件时还原的是老窗口 —— 记事本这种标签页式的走这条）
       ③ anyNew 时兜底：任何新窗口（关联查不出来 / 判断错了时不至于完全失效）
     刻意【不】做「任何被还原的窗口」这种兜底：VPN / ChatGPT 之类自己弹出来时
     也是「被还原的窗口」，那正是实测踩到的坑。
     另外三个「绝不碰」的约束：
       - 不看「当前前台窗口」：实测目标还没起来时前台可能是别的软件，
         照着前台最大化会把别人的窗口顶到最前面；
       - 跳过自己进程（selfPid）的窗口：桌面宠物窗 / 气泡窗都有标题、
         又不在 VisibleHandles 的 before 清单里（那个按 selfPid 排除了），
         不排掉就会被当成「新窗口」放大到全屏；
       - 跳过 DWM 隐身的空壳窗口（见 Cloaked），否则会去最大化一个看不见的壳。 */
  '  public static IntPtr PickTarget(IntPtr[] before, string wasMinimizedCsv, bool allowRestored, int selfPid, string wantProcs, bool anyNew) {',
  '    var seen = new HashSet<IntPtr>();',
  '    if (before != null) { foreach (var h in before) seen.Add(h); }',
  '    var want = SplitCsv(wantProcs);',
  '    bool anyWanted = want.Count == 0;      // 关联没查出来 → 退回老行为',
  '    IntPtr best = IntPtr.Zero;             // 新窗口 + 进程匹配 + 能最大化',
  '    IntPtr okNew = IntPtr.Zero;            // 新窗口 + 进程匹配',
  '    IntPtr anyNewWin = IntPtr.Zero;        // 任何新窗口（兜底）',
  '    EnumWindows(delegate(IntPtr h, IntPtr l) {',
  '      if (IsIconic(h)) return true;',
  '      if (!RealWindow(h, selfPid, null)) return true;',
  '      if (seen.Contains(h)) return true;',
  '      bool hit = anyWanted || want.Contains(ProcName(h));',
  '      if (anyNewWin == IntPtr.Zero) anyNewWin = h;',
  '      if (!hit) return true;',
  '      if (okNew == IntPtr.Zero) okNew = h;',
  /* 优先挑「能最大化的正常主窗口」：WPS / Office 这类国产办公软件常常先弹一个
     广告小窗或启动页，那种窗口没有 WS_THICKFRAME / WS_MAXIMIZEBOX，
     真被选中就会出现「目标打开了、最大化的却是广告窗」。 */
  '      int st = GetWindowLong(h, -16);',
  '      if ((st & 0x00040000) != 0 || (st & 0x00010000) != 0) {',
  '        if (best == IntPtr.Zero) best = h;',
  '      }',
  '      return true;',
  '    }, IntPtr.Zero);',
  '    if (best != IntPtr.Zero) return best;',
  '    if (okNew != IntPtr.Zero) return okNew;',
  '    if (!allowRestored) return IntPtr.Zero;',
  '    foreach (var s in SplitCsv(wasMinimizedCsv)) {',
  '      long v; if (!long.TryParse(s, out v)) continue;',
  '      IntPtr h = new IntPtr(v);',
  '      if (!IsWindowVisible(h) || IsIconic(h) || Cloaked(h)) continue;',
  '      if (!anyWanted && !want.Contains(ProcName(h))) continue;',
  '      return h;',
  '    }',
  '    /* 兜底只用「新窗口」：被还原的窗口里有太多别人的程序（VPN、聊天软件…），',
  '       放进来就会重现「按老板键把 VPN 也打开了」那个 bug。 */',
  '    if (anyNew && anyNewWin != IntPtr.Zero) return anyNewWin;',
  '    return IntPtr.Zero;',
  '  }',
  '',
  '  public static void Restore(string csv) {',
  '    if (csv == null) return;',
  '    foreach (var s in csv.Split(new char[] { (char)44 })) {',
  '      long v; if (!long.TryParse(s, out v)) continue;',
  '      ShowWindow(new IntPtr(v), 9);',                                 // SW_RESTORE
  '    }',
  '  }',
  '}',
  '"@'
].join('\n');

/* 「窗口句柄清单」存在这里，还原时按它精确恢复 */
function moyuStateFile() { return path.join(app.getPath('userData'), 'moyu-windows.txt'); }
/* 每次摸鱼写一行「想认哪个进程、最后认了哪个窗口」—— 出问题时看这个文件 */
function moyuLogFile() { return path.join(app.getPath('userData'), 'moyu-last.txt'); }

/* 等「收起了哪些窗口」这份清单落盘。
   收桌面那个 PowerShell 是异步的：先编译 C# → 枚举窗口 → 收起来 → 最后才写清单。
   用户按得太快时它可能还没写盘，这时直接 kill 掉清单就缺了 ——
   那些窗口再也还原不回来（桌面卡在全部最小化，只能手动一个个点回来）。
   所以按第二次时先等清单出现；子进程已经退出或超时就不再等。 */
function moyuWaitState(child, cb) {
  let waited = 0;
  const tick = function () {
    let ok = false;
    try { ok = fs.existsSync(moyuStateFile()); } catch (e) { }
    const gone = !child || child.exitCode !== null || child.signalCode !== null;
    if (ok || gone || waited >= 5000) { cb(ok); return; }
    waited += 100;
    setTimeout(tick, 100);
  };
  setTimeout(tick, 100);
}

/* 按一次：收起桌面 → 打开伪装目标（文档再最大化） */
function moyuGo() {
  if (moyuRunning || moyuBacking) return;
  moyuRunning = true;
  moyuRuntimeError = '';       // 新的一次开始，先把上次的运行期错误清掉

  /* 清掉上一次的清单：这样「清单存在」就等于「这一次已经收好了」，
     moyuBack() 靠它判断能不能安全地按住不动。 */
  try { fs.unlinkSync(moyuStateFile()); } catch (e) { }

  /* 自己的主窗口直接藏掉（任务栏图标一起没）——
     用最小化的话任务栏会留一条自己的程序名，摸鱼就露馅了 */
  hideToTray(true);

  const stateFile = moyuStateFile().replace(/'/g, "''");
  const t = moyuTarget.replace(/'/g, "''");          // PowerShell 单引号串里要写成 ''
  const isDoc = moyuTarget ? moyuIsDoc(moyuTarget) : false;
  const logFile = moyuLogFile().replace(/'/g, "''");

  const lines = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    /* 关掉进度流：PowerShell 首次运行会往 stderr 写 CLIXML 进度记录，
       会让 execFile 误判成命令失败（退出码和执行结果其实都是对的）。 */
    "$ProgressPreference = 'SilentlyContinue'",
    MOYU_WINAPI,
    "$target = '" + t + "'",
    /* .lnk 先解析成真实目标：不解析的话既查不出关联、也认不出进程名，
       目标窗口就选不准了 */
    "if ($target -like '*.lnk') {",
    "  try { $sh = New-Object -ComObject WScript.Shell; $rp = $sh.CreateShortcut($target).TargetPath; if ($rp -ne '') { $target = $rp } } catch {}",
    '}',
    /* 这次要打开的到底是哪个程序：文档问 shell 关联（.pdf → wpspdf 之类），
       程序取文件名。下面的窗口挑选只认这些进程 —— 否则 VPN / ChatGPT 之类
       自己弹出来的窗口也会被当成目标给最大化（实测踩到过）。 */
    '$want = [KkWin]::ExpectedProcs($target)',
    /* 先记下此刻已经开着的可见窗口，再收桌面 —— 顺序不能反。
       iconic 那批是「本来就最小化」的：MinimizeAll 不会收它们，
       但目标程序打开文件时可能还原的正是这种老窗口。 */
    '$before = [KkWin]::VisibleHandles(' + process.pid + ')',
    '$iconic = [KkWin]::IconicHandles(' + process.pid + ')',
    /* 排除自己这个进程的窗口（已经用 hideToTray 藏了），
       并且跳过桌面壳层和壁纸类软件 —— 收了它们桌面就空了 */
    '$hs = [KkWin]::MinimizeAll(' + process.pid
      + ", '" + moyuSkipProcs() + "', '" + MOYU_SKIP_CLASSES + "')",
    "$csv = (($hs | ForEach-Object { $_.ToInt64().ToString() }) -join ',')",
    "[System.IO.File]::WriteAllText('" + stateFile + "', $csv)",
    /* 还原判定的候选池 = 我们收起来的 + 本来就是最小化的 */
    '$pool = ((@($hs) + @($iconic)) | ForEach-Object { $_.ToInt64().ToString() }) -join \',\'',
    "if ($target -ne '') { Start-Process -FilePath $target | Out-Null }"
  ];

  if (isDoc) {
    lines.push(
      /* 只认「这次新冒出来的窗口」或「刚被还原的老窗口」，而且进程必须属于 $want。
         绝不碰本来就开着、仍然最小化的窗口；也绝不放宽「被还原的窗口」——
         实测那条路会把用户自己弹出来的 VPN / ChatGPT 当成目标最大化。 */
      '$h = [IntPtr]::Zero',
      'for ($i = 0; $i -lt 40 -and $h -eq [IntPtr]::Zero; $i++) {',
      '  Start-Sleep -Milliseconds 250',
      /* 前 2.5 秒只认新窗口；之后才接受「目标程序把老窗口自己还原了」；
         7.5 秒还没找到就兜底放宽成「任何新窗口」（关联猜错了也不至于完全失效） */
      '  $h = [KkWin]::PickTarget($before, $pool, ($i -ge 10), ' + process.pid + ', $want, ($i -ge 30))',
      '}',
      'if ($h -ne [IntPtr]::Zero) {',
      '  [KkWin]::ShowWindow($h, 3) | Out-Null',                          // SW_MAXIMIZE
      '  [KkWin]::SetForegroundWindow($h) | Out-Null',
      '}',
      /* 记一行结果，出问题时看这个文件就知道「想认谁、最后认了谁」 */
      'try { [System.IO.File]::WriteAllText(\'' + logFile + '\', "want=" + $want + " picked=" + $h.ToInt64()) } catch {}'
    );
  }

  /* 保险丝用的时间戳：6 秒后检查清单有没有落盘 */
  const goAt = Date.now();
  moyuGoAt = goAt;
  try {
    moyuGoChild = psRun(lines.join('\n'));
  } catch (e) {
    diagLog('moyu-go-throw', { message: String((e && e.message) || e) });
  }
  send('moyu-changed', moyuSnapshot());

  /* 保险丝：如果 6 秒内「收起了哪些窗口」这份清单还没落盘，说明那段 PowerShell
     根本没跑起来（被杀毒软件拦了 / powershell.exe 起不来 / execFile 直接抛）。
     这时候绝不能把用户搁在「程序藏了、桌面没动、热键也失灵」的状态里 ——
     把界面放回来、状态复位、并说明原因，保证下次按还能用。 */
  setTimeout(function () {
    if (!moyuRunning || moyuGoAt !== goAt) return;       // 已经切回来了 / 又按了一次
    let ok = false;
    try { ok = fs.existsSync(moyuStateFile()); } catch (e) { }
    if (ok) return;
    diagLog('moyu-go-failsafe', {});
    moyuRunning = false;
    moyuRuntimeError = '摸鱼没跑起来：桌面没被收起（PowerShell 可能被杀毒软件拦住了）';
    moyuResult = 'ps-fail';
    showWindow();
    send('moyu-changed', moyuSnapshot());
  }, 6000);
}

/* 再按一次：把刚才收起来的窗口全部还原，伪装软件留着不动 */
function moyuBack() {
  if (!moyuRunning) return;
  moyuRunning = false;
  moyuBacking = true;                 // 还原在下一次事件循环里完成，期间不接受新的切换

  const child = moyuGoChild;
  moyuGoChild = null;
  const stateFile = moyuStateFile().replace(/'/g, "''");

  showWindow();                       // 自己先回来，别让用户干等
  send('moyu-changed', moyuSnapshot());

  const finish = function () {
    /* 用 try/finally 保住 moyuBacking：这里一旦抛异常又没复位，
       热键就永远没反应了（moyuToggle 开头会直接 return）。 */
    try {
      /* 掐掉那个还在跑的「找窗口最大化」PowerShell。
         否则用户按得太快时，它会在还原之后才去最大化某个窗口，看着莫名其妙。
         注意必须等清单落盘之后再掐，否则被收起的窗口就还原不回来了。 */
      if (child) {
        try { child.kill(); } catch (e) { }
      }
      psRun([
        "$ErrorActionPreference = 'SilentlyContinue'",
        "$ProgressPreference = 'SilentlyContinue'",
        MOYU_WINAPI,
        /* 清单可能还没写出来（比如收桌面那步就失败了），别让 ReadAllText 抛错 */
        "if (Test-Path '" + stateFile + "') { " +
        "[KkWin]::Restore([System.IO.File]::ReadAllText('" + stateFile + "')) }"
      ].join('\n'));
    } catch (e) {
      diagLog('moyu-back-throw', { message: String((e && e.message) || e) });
    } finally {
      moyuBacking = false;
    }
  };

  const gone = !child || child.exitCode !== null || child.signalCode !== null;
  if (gone) finish(); else moyuWaitState(child, finish);
}

function moyuToggle() {
  if (moyuBacking) return;
  if (moyuRunning) moyuBack(); else moyuGo();
}

/* ============================================================ 连击摸鱼
   「同一个键快速连按 3 下」也能触发摸鱼（默认 Ctrl 连按 3 下）。

   为什么不能用 globalShortcut：Electron 的加速键必须是「修饰键 + 一个真键」，
   单独一个 Control 不是合法加速键，注册不了。所以只能自己装一个全局低级键盘钩子
   （WH_KEYBOARD_LL）。

   几个关键决定：
   1) 钩子只观察、不拦截：回调里无论认不认这个键都 CallNextHookEx，
      所以 Ctrl 还是正常的 Ctrl，Ctrl+C 照样能用。
   2) 钩子回调里只做几个整数比较，认不认这个键都 CallNextHookEx，
      所以 Ctrl 还是正常的 Ctrl，Ctrl+C 照样能用。
   3) 检测到连击时「在回调里直接把触发写文件」—— 这一点是实测出来的：
      低级钩子的回调并不会把 GetMessage 唤醒，所以「回调里置个标志、
      等消息循环去落盘」这条常规路子永远等不到（消息循环一直睡着）。
      好在写文件只在真的连击时才发生，不是每次按键都写，所以不影响打字延迟。
   4) 写进文件的是 (uint)TickCount：不能用带符号的 TickCount，
      开机超过 24.9 天后它会变成负数，而主进程那边是按「比上次大」判断的，
      负数会被当成非法值全部丢掉。
   5) 用「文件 + 轮询」把触发传回主进程，不走 stdout：PowerShell 的输出会缓冲，
      而文件轮询最稳，120ms 的延迟对这种连击操作完全无感。
   6) 只观察不记录：代码里只拿 vkCode 跟一个白名单比，不写任何按键内容到任何地方。
   7) 这个功能默认关：全局键盘钩子要拉一个长驻进程，而且杀毒软件对钩子比较敏感，
      必须由用户明确勾选才启用。
*/
const MOYU_TAP_GAP = 500;         // 相邻两下之间最多隔多久（毫秒）
/* 一整串连击的总时长上限：三下必须在这段时间内按完。
   两条一起用才符合直觉：两两不超过 0.5 秒，整串不超过 1 秒。
   （另外长按的自动重复键一律不算 —— 见 MOYU_TAP_WINAPI 里的 _down） */
const MOYU_TAP_WINDOW = 1000;
const MOYU_TAP_POLL = 120;        // 轮询触发文件的间隔
const MOYU_TAP_WATCH = 5000;      // 看门狗间隔：钩子进程死了要能自己起来

/* 可选的「连击键」。故意只开放修饰键 / 功能键 / 锁定键：
   字母数字键如果允许，打字时连按三次同一个字母就会当场把桌面收走。
   值是 vkCode 列表（逗号分隔），左右 Ctrl 这种要分开列。 */
const MOYU_TAP_KEYS = (function () {
  const list = [
    { id: 'ctrl', label: 'Ctrl（左右都算）', vks: '17,162,163' },
    { id: 'lctrl', label: '左 Ctrl', vks: '162' },
    { id: 'rctrl', label: '右 Ctrl', vks: '163' },
    { id: 'alt', label: 'Alt（左右都算）', vks: '18,164,165' },
    { id: 'lalt', label: '左 Alt', vks: '164' },
    { id: 'ralt', label: '右 Alt', vks: '165' },
    { id: 'shift', label: 'Shift（左右都算）', vks: '16,160,161' },
    { id: 'lshift', label: '左 Shift', vks: '160' },
    { id: 'rshift', label: '右 Shift', vks: '161' },
    { id: 'win', label: 'Win 键', vks: '91,92' },
    { id: 'caps', label: 'Caps Lock', vks: '20' },
    { id: 'scroll', label: 'Scroll Lock', vks: '145' },
    { id: 'pause', label: 'Pause', vks: '19' }
  ];
  for (let i = 1; i <= 12; i++) list.push({ id: 'f' + i, label: 'F' + i, vks: String(111 + i) });
  return list;
})();

const MOYU_TAP_WINAPI = [
  'Add-Type @"',
  'using System;',
  'using System.Collections.Generic;',
  'using System.IO;',
  'using System.Runtime.InteropServices;',
  '',
  'public class KkTap {',
  '  delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);',
  '  [DllImport("user32.dll", SetLastError = true)]',
  '  static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);',
  '  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hhk);',
  '  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);',
  '  [DllImport("user32.dll")] static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint min, uint max);',
  '  [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG lpMsg);',
  '  [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG lpMsg);',
  '',
  '  /* 注意 x64 的对齐：message 后面有 4 字节填充，别自己加 lPrivate，',
  '     微软的 winuser.h 里 MSG 在非 Mac 平台并没有那个字段。 */',
  '  [StructLayout(LayoutKind.Sequential)]',
  '  public struct MSG {',
  '    public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam;',
  '    public uint time; public int ptX; public int ptY;',
  '  }',
  '  [StructLayout(LayoutKind.Sequential)]',
  '  public struct KBDLLHOOKSTRUCT {',
  '    public uint vkCode; public uint scanCode; public uint flags; public uint time; public IntPtr extra;',
  '  }',
  '',
  '  const int WH_KEYBOARD_LL = 13;',
  '  const uint WM_KEYDOWN = 0x0100;',
  '  const uint WM_SYSKEYDOWN = 0x0104;',
  '  const uint WM_KEYUP = 0x0101;',
  '  const uint WM_SYSKEYUP = 0x0105;',
  '',
  '  static HookProc _proc;               // 必须留引用，被 GC 掉钩子就失效了',
  '  static HashSet<int> _keys = new HashSet<int>();',
  '  static HashSet<int> _down = new HashSet<int>();   // 现在按着的键（识别长按的自动重复）',
  '  static string _trigger = "";',
  '  static int _gap = 500;            // 相邻两下之间最多隔多久',
  '  static int _window = 1000;        // 一整串连击必须在这么久之内完成',
  '  static int _count = 0;',
  '  static int _lastDown = 0;',
  '  static int _firstDown = 0;        // 这一串的第一下，用来限制整串的总时长',
  '  static bool _otherSince = false;     // 两次连击中间按过别的键 → 这一串不算',
  '',
  '  static IntPtr OnKey(int nCode, IntPtr wParam, IntPtr lParam) {',
  '    if (nCode >= 0) {',
  '      uint m = (uint)wParam;',
  '      if (m == WM_KEYUP || m == WM_SYSKEYUP) {',
  '        /* 松开：把「按着」的状态清掉。必须在最前面处理，所有键都要清。 */',
  '        var ku = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));',
  '        _down.Remove((int)ku.vkCode);',
  '      } else if (m == WM_KEYDOWN || m == WM_SYSKEYDOWN) {',
  '        var kb = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));',
  '        int vk = (int)kb.vkCode;',
  '        int now = Environment.TickCount;',
  '        if (_keys.Contains(vk)) {',
  '          /* 同一个键还按着又来 keydown = 长按产生的自动重复（间隔约 31ms），',
  '             这【不算】新的一下。否则「前两下 + 第三下按住不放」会被算成三下，',
  '             凭空触发摸鱼（用户实测报过）。真漏了 keyup 也有兜底：',
  '             离上一次计数超过 3 秒就当成状态丢了，这一下重新算。 */',
  '          if (_down.Contains(vk)) {',
  '            if (now - _lastDown < 3000) return CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);',
  '            _down.Remove(vk);',
  '          }',
  '          _down.Add(vk);',
  '          /* 两条限制：相邻两下不超过 _gap，整串不超过 _window */',
  '          if (_otherSince || now - _lastDown > _gap || now - _firstDown > _window) _count = 0;',
  '          if (_count == 0) _firstDown = now;',
  '          _otherSince = false;',
  '          _count++;',
  '          _lastDown = now;',
  '          if (_count >= 3) {',
  '            _count = 0;',
  '            _down.Clear();',
  '            /* 必须在这里直接写：实测低级钩子的回调不会唤醒 GetMessage，',
  '               置标志等循环去写是等不到的。只有真连击才写，不影响打字。 */',
  '            try { File.WriteAllText(_trigger, ((uint)Environment.TickCount).ToString()); } catch {}',
  '          }',
  '        } else {',
  '          _otherSince = true;',
  '        }',
  '      }',
  '    }',
  '    return CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);',
  '  }',
  '',
  '  public static void Run(string vks, string trigger, string status, int gapMs, int windowMs) {',
  '    _keys.Clear();',
  '    foreach (var s in vks.Split(new char[] { (char)44 })) {',
  '      int v; if (int.TryParse(s.Trim(), out v)) _keys.Add(v);',
  '    }',
  '    _trigger = trigger;',
  '    _gap = gapMs;',
  '    _window = windowMs > 0 ? windowMs : gapMs * 2;',
  '    _down.Clear();',
  '    _proc = new HookProc(OnKey);',
  '    IntPtr hk = SetWindowsHookEx(WH_KEYBOARD_LL, _proc, IntPtr.Zero, 0);',
  '    if (hk == IntPtr.Zero) {',
  '      try { File.WriteAllText(status, "FAIL " + Marshal.GetLastWin32Error()); } catch {}',
  '      return;',
  '    }',
  '    try { File.WriteAllText(status, "OK"); } catch {}',
  '    /* 这个循环只是把线程留在消息泵里、让钩子一直被系统服务；',
  '       钩子回调由系统在本线程阻塞于 GetMessage 时直接调用。 */',
  '    MSG msg;',
  '    while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) {',
  '      TranslateMessage(ref msg);',
  '      DispatchMessage(ref msg);',
  '    }',
  '    UnhookWindowsHookEx(hk);',
  '  }',
  '}',
  '"@'
].join('\n');

let moyuTapOn = false;
let moyuTapKey = 'ctrl';
let moyuTapChild = null;
let moyuTapPoll = null;
let moyuTapWatch = null;
let moyuTapLast = 0;
let moyuTapReady = false;
let moyuTapError = '';
let moyuTapRestarts = 0;

/* 钩子进程把「连击发生了」写在这里（内容是个递增的 TickCount） */
function moyuTapTriggerFile() { return path.join(app.getPath('userData'), 'moyu-tap.txt'); }
/* 钩子装没装上，钩子进程启动时写一次，用来如实告诉用户为什么没生效 */
function moyuTapStatusFile() { return path.join(app.getPath('userData'), 'moyu-tap-status.txt'); }

function moyuTapKeyDef() {
  for (let i = 0; i < MOYU_TAP_KEYS.length; i++) {
    if (MOYU_TAP_KEYS[i].id === moyuTapKey) return MOYU_TAP_KEYS[i];
  }
  return MOYU_TAP_KEYS[0];
}

function moyuTapStop() {
  if (moyuTapPoll) { clearInterval(moyuTapPoll); moyuTapPoll = null; }
  if (moyuTapWatch) { clearInterval(moyuTapWatch); moyuTapWatch = null; }
  if (moyuTapChild) {
    try { moyuTapChild.kill(); } catch (e) { }
    moyuTapChild = null;
  }
  moyuTapReady = false;
}

/* 轮询触发文件。只认「比上次大」的值：写文件是「截断再写」，
   正好读到半截会得到一个偏小的数，直接忽略，不然一次连击会触发两回（等于没触发）。 */
function moyuTapTick() {
  let txt = '';
  try { txt = fs.readFileSync(moyuTapTriggerFile(), 'utf8'); } catch (e) { return; }
  const n = parseInt(txt, 10);
  if (!isFinite(n) || n <= moyuTapLast) return;
  moyuTapLast = n;
  diagLog('moyu-tap-fired', { seq: n });
  moyuToggle();
}

function moyuTapStart() {
  moyuTapStop();
  moyuTapError = '';
  if (!moyuOn || !moyuTapOn) return;

  const def = moyuTapKeyDef();
  const trig = moyuTapTriggerFile().replace(/'/g, "''");
  const stat = moyuTapStatusFile().replace(/'/g, "''");
  try { fs.unlinkSync(moyuTapTriggerFile()); } catch (e) { }
  try { fs.unlinkSync(moyuTapStatusFile()); } catch (e) { }
  moyuTapLast = 0;

  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$ProgressPreference = 'SilentlyContinue'",
    MOYU_TAP_WINAPI,
    "[KkTap]::Run('" + def.vks + "', '" + trig + "', '" + stat + "', " + MOYU_TAP_GAP + ', ' + MOYU_TAP_WINDOW + ')'
  ].join('\n');
  const b64 = Buffer.from(script, 'utf16le').toString('base64');
  const c = spawn('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64],
    { windowsHide: true, stdio: 'ignore' });
  moyuTapChild = c;
  c.on('exit', function () {
    if (moyuTapChild === c) { moyuTapChild = null; moyuTapReady = false; }
  });

  moyuTapPoll = setInterval(moyuTapTick, MOYU_TAP_POLL);
  moyuTapWatch = setInterval(function () {
    if (!moyuOn || !moyuTapOn || moyuTapChild) return;
    /* 已经反复重启还不成，就别死循环了，如实报错让用户知道 */
    if (moyuTapRestarts >= 5) {
      moyuTapError = '连击功能反复启动失败，可能被杀毒软件拦了';
      moyuTapStop();
      send('moyu-changed', moyuSnapshot());
      return;
    }
    moyuTapRestarts++;
    diagLog('moyu-tap-restart', { n: moyuTapRestarts });
    moyuTapStart();
  }, MOYU_TAP_WATCH);

  /* 稍后读一次状态文件：钩子没装上也可能是被杀毒软件拦了，得让用户看得见 */
  setTimeout(function () {
    if (!moyuTapChild || !moyuTapOn) return;
    let s = '';
    try { s = fs.readFileSync(moyuTapStatusFile(), 'utf8').trim(); } catch (e) { }
    moyuTapReady = (s === 'OK');
    if (moyuTapReady) {
      moyuTapRestarts = 0;
      moyuTapError = '';
    } else {
      moyuTapError = '连击功能没启动：' + (s || '键盘钩子装不上（可能被杀毒软件拦了）');
    }
    send('moyu-changed', moyuSnapshot());
    diagLog('moyu-tap-status', { ready: moyuTapReady, status: s });
  }, 1500);
}

/* 用户改了「连击」相关设置后重新应用 */
function moyuTapApply(on, keyId) {
  if (typeof on === 'boolean') moyuTapOn = on;
  if (typeof keyId === 'string' && keyId) {
    for (let i = 0; i < MOYU_TAP_KEYS.length; i++) {
      if (MOYU_TAP_KEYS[i].id === keyId) { moyuTapKey = keyId; break; }
    }
  }
  saveMoyuPref();
  moyuTapRestarts = 0;
  moyuTapStart();
  return moyuSnapshot();
}

/* 把当前设置应用到系统：先撤掉旧的注册，再注册新的。
   注册失败（被别的软件占用 / 组合键不合法）要说清原因，别静静失败。 */
function applyMoyuShortcut() {
  if (moyuActiveAccel) {
    try { globalShortcut.unregister(moyuActiveAccel); } catch (e) { }
    moyuActiveAccel = null;
  }
  moyuError = '';
  moyuAutoPicked = false;

  /* 摸鱼整个关掉时，连击的键盘钩子也要一起收掉，别留个长驻进程 */
  if (!moyuOn) {
    moyuResult = 'off';
    moyuTapStop();
    return moyuSnapshot();
  }
  /* 连击那块是独立于组合键的：组合键注册失败也不该把它带崩 */
  moyuTapRestarts = 0;
  moyuTapStart();

  if (moyuCustom && !moyuAccel) {
    moyuResult = 'empty';
    moyuError = '还没有设置快捷键';
    return moyuSnapshot();
  }

  /* 用户自己录的：只试那一个，失败了要说清；
     还在用默认值：默认被占了就顺位往后试，别让用户自己去猜哪个能用 */
  let tries;
  if (moyuCustom) {
    tries = [moyuAccel];
  } else {
    tries = [moyuAccel].concat(MOYU_FALLBACK_ACCELS).filter(function (a, i, arr) {
      return a && arr.indexOf(a) === i;
    });
  }

  for (let i = 0; i < tries.length; i++) {
    const a = tries[i];
    let ok = false;
    try {
      ok = globalShortcut.register(a, moyuToggle);
    } catch (e) {
      moyuError = String((e && e.message) || e);
      continue;
    }
    if (ok) {
      moyuActiveAccel = a;
      moyuResult = 'ok';
      if (a !== moyuAccel) { moyuAccel = a; moyuAutoPicked = true; }
      saveMoyuPref();          // 记住实际能用的那个，下次直接用它
      return moyuSnapshot();
    }
  }

  moyuResult = 'taken';
  moyuError = moyuCustom
    ? '这个组合键已经被系统或别的软件占用了，换一个试试'
    : '常用的几个组合键都被占用了，请手动录一个（比如 F8 或 Ctrl+Shift+J）';
  return moyuSnapshot();
}

ipcMain.handle('moyu-get', () => moyuSnapshot());

ipcMain.handle('moyu-set', (e, cfg) => {
  let tapChanged = false;
  if (cfg && typeof cfg === 'object') {
    if (typeof cfg.on === 'boolean') moyuOn = cfg.on;
    if (typeof cfg.accel === 'string') {
      moyuAccel = cfg.accel.trim();
      moyuCustom = !!moyuAccel;      // 用户亲手录的，之后不再自动顺位
    }
    if (typeof cfg.tapOn === 'boolean' && cfg.tapOn !== moyuTapOn) {
      moyuTapOn = cfg.tapOn;
      tapChanged = true;
    }
    if (typeof cfg.tapKey === 'string' && cfg.tapKey) {
      for (let i = 0; i < MOYU_TAP_KEYS.length; i++) {
        if (MOYU_TAP_KEYS[i].id === cfg.tapKey && cfg.tapKey !== moyuTapKey) {
          moyuTapKey = cfg.tapKey;
          tapChanged = true;
          break;
        }
      }
    }
  }
  saveMoyuPref();
  /* 只有连击那块变了才去重启钩子进程；改组合键不该把钩子掐了重来 */
  if (tapChanged && moyuOn) {
    moyuTapRestarts = 0;
    moyuTapStart();
  }
  return applyMoyuShortcut();
});

/* 选一个「伪装目标」：摸鱼时自动打开它 */
ipcMain.handle('moyu-pick', async () => {
  try {
    const r = await dialog.showOpenDialog(win && !win.isDestroyed() ? win : null, {
      title: '选一个程序或文档（摸鱼时自动打开它）',
      buttonLabel: '就用这个',
      properties: ['openFile'],
      filters: [
        {
          name: '程序或文档',
          extensions: ['exe', 'lnk', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
            'pdf', 'txt', 'md', 'rtf', 'csv', 'odt', 'wps', 'et', 'dps']
        },
        { name: '所有文件', extensions: ['*'] }
      ]
    });
    if (r && !r.canceled && r.filePaths && r.filePaths[0]) {
      moyuTarget = r.filePaths[0];
      saveMoyuPref();
    }
  } catch (e) {
    diagLog('moyu-pick-error', { message: String((e && e.message) || e) });
  }
  return moyuSnapshot();
});

ipcMain.handle('moyu-clear-target', () => {
  moyuTarget = '';
  saveMoyuPref();
  return moyuSnapshot();
});

/* 录制快捷键期间先把全局热键摘掉 —— 否则用户按到旧组合，
   会当场触发一次摸鱼（整个桌面被收走），根本没法录 */
ipcMain.handle('moyu-suspend', (e, on) => {
  if (on) {
    if (moyuActiveAccel) {
      try { globalShortcut.unregister(moyuActiveAccel); } catch (err) { }
      moyuActiveAccel = null;
    }
    return moyuSnapshot();
  }
  return applyMoyuShortcut();
});

ipcMain.handle('moyu-reset', () => {
  moyuAccel = MOYU_DEFAULT_ACCEL;
  moyuCustom = false;              // 回到「自动顺位」模式
  saveMoyuPref();
  return applyMoyuShortcut();
});

/* ============================================================ 护眼模式
   把显示器色温调暖（降蓝光）：直接改显卡的伽马表（SetDeviceGammaRamp），
   和 f.lux / 护眼宝 一个原理 —— 是真的把颜色调暖，不是往屏幕上叠一层黄遮罩。

   三个必须处理好的点：
   1) 伽马表是「整块替换」的，所以开启前要先把原始表存下来，关闭时按它还原。
      原始表必须落盘（eye-care-ramp.txt）：休眠 / 改分辨率 / 装显卡驱动都会让
      驱动把伽马表复位，这时候如果临时去读「当前值」，很可能读到的已经是我们
      调暖的那份，把它当原始值存下来就永远回不去真正的原始色温了。
   2) 复位是常态：休眠唤醒、改分辨率、插拔显示器都会复位，所以这几个时机都要
      重新应用一遍，否则用户会发现「睡一觉醒来护眼就失效了」。
   3) 关掉以及退出程序时都要还原：程序都不在了还留个暖屏，用户没法关掉它。
*/
const EYE_KELVIN_DEFAULT = 4500;  // 默认护眼色温（Windows 夜间模式的中间档也在这一带）
const EYE_KELVIN_MIN = 2700;      // 最暖
const EYE_KELVIN_MAX = 6500;      // 基本等于屏幕原色

/* 显示器 + 伽马表。
   设备名（\\.\DISPLAY1 这种）从 EnumDisplayDevices 拿，
   CreateDC 各家驱动接受的形式不太一样，所以依次试三种写法。 */
const EYE_WINAPI = [
  'Add-Type @"',
  'using System;',
  'using System.Collections.Generic;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  'public class KkEye {',
  '  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',
  '  public struct DISPLAY_DEVICE {',
  '    public int cb;',
  '    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;',
  '    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString;',
  '    public int StateFlags;',
  '    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID;',
  '    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey;',
  '  }',
  '  [DllImport("user32.dll", CharSet = CharSet.Unicode)]',
  '  static extern bool EnumDisplayDevices(string dev, uint num, ref DISPLAY_DEVICE d, uint flags);',
  '  [DllImport("gdi32.dll", CharSet = CharSet.Unicode)]',
  '  static extern IntPtr CreateDC(string driver, string device, string output, IntPtr init);',
  '  [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr hdc);',
  '  [DllImport("gdi32.dll")] static extern bool GetDeviceGammaRamp(IntPtr hdc, ushort[] ramp);',
  '  [DllImport("gdi32.dll")] static extern bool SetDeviceGammaRamp(IntPtr hdc, ushort[] ramp);',
  '',
  '  const int ATTACHED_TO_DESKTOP = 0x00000001;',
  '',
  '  /* 连在桌面上的显示器（没接的虚拟显示器要跳过，对它设伽马表没意义） */',
  '  static List<string> Devices() {',
  '    var list = new List<string>();',
  '    for (uint i = 0; i < 16; i++) {',
  '      var d = new DISPLAY_DEVICE();',
  '      d.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE));',
  '      if (!EnumDisplayDevices(null, i, ref d, 0)) break;',
  '      if ((d.StateFlags & ATTACHED_TO_DESKTOP) != 0) list.Add(d.DeviceName);',
  '    }',
  '    return list;',
  '  }',
  '',
  '  public static int DisplayCount() { return Devices().Count; }',
  '',
  '  /* 自检用：列出所有显示适配器以及它们各自的 GPU 名。',
  '     这台机器是「集显 + 独显」混合本（Intel UHD 带内屏、NVIDIA 带外接屏），',
  '     有这个清单就能一眼看出色温到底设到了哪块卡上。 */',
  '  public static string Adapters() {',
  '    var sb = new StringBuilder();',
  '    for (uint i = 0; i < 16; i++) {',
  '      var d = new DISPLAY_DEVICE();',
  '      d.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE));',
  '      if (!EnumDisplayDevices(null, i, ref d, 0)) break;',
  '      sb.Append(d.DeviceName).Append(" | gpu=").Append(d.DeviceString)',
  '        .Append((d.StateFlags & ATTACHED_TO_DESKTOP) != 0 ? " | ATTACHED" : " | -")',
  '        .Append((char)10);',
  '    }',
  '    return sb.ToString();',
  '  }',
  '',
  '  static IntPtr Dc(string name) {',
  '    IntPtr h = CreateDC("DISPLAY", name, null, IntPtr.Zero);',
  '    if (h == IntPtr.Zero) h = CreateDC(name, null, null, IntPtr.Zero);',
  '    if (h == IntPtr.Zero) h = CreateDC(name, name, null, IntPtr.Zero);',
  '    return h;',
  '  }',
  '',
  '  /* 驱动默认那种线性表，读不到当前值 / 备份丢了时拿它兜底 */',
  '  static ushort[] Linear() {',
  '    var r = new ushort[768];',
  '    for (int i = 0; i < 256; i++) {',
  '      ushort v = (ushort)(i * 257);',
  '      r[i] = v; r[256 + i] = v; r[512 + i] = v;',
  '    }',
  '    return r;',
  '  }',
  '',
  '  static ushort ClampU(double v) {',
  '    if (v < 0) v = 0;',
  '    if (v > 65535) v = 65535;',
  '    return (ushort)Math.Round(v);',
  '  }',
  '',
  '  /* 色温(K) → 三通道乘数。用的是 Tanner Helland 那套近似公式，够用且好读 */',
  '  static double[] Multipliers(int kelvin) {',
  '    double t = kelvin / 100.0;',
  '    double r, g, b;',
  '    if (t <= 66) r = 255; else r = 329.698727446 * Math.Pow(t - 60, -0.1332047592);',
  '    if (t <= 66) g = 99.4708025861 * Math.Log(t) - 161.1195681661;',
  '    else g = 288.1221695283 * Math.Pow(t - 60, -0.0755148492);',
  '    if (t >= 66) b = 255;',
  '    else if (t <= 19) b = 0;',
  '    else b = 138.5177312231 * Math.Log(t - 10) - 305.0447927307;',
  '    return new double[] { r / 255.0, g / 255.0, b / 255.0 };',
  '  }',
  '',
  '  static int Apply(ushort[] ramp) {',
  '    int ok = 0;',
  '    foreach (var name in Devices()) {',
  '      IntPtr h = Dc(name);',
  '      if (h == IntPtr.Zero) continue;',
  '      if (SetDeviceGammaRamp(h, ramp)) ok++;',
  '      DeleteDC(h);',
  '    }',
  '    return ok;',
  '  }',
  '',
  '  public static int ApplyWarm(int kelvin) {',
  '    var m = Multipliers(kelvin);',
  '    var ramp = new ushort[768];',
  '    for (int i = 0; i < 256; i++) {',
  '      double v = i * 257.0;',
  '      ramp[i] = ClampU(v * m[0]);',
  '      ramp[256 + i] = ClampU(v * m[1]);',
  '      ramp[512 + i] = ClampU(v * m[2]);',
  '    }',
  '    return Apply(ramp);',
  '  }',
  '',
  '  public static int ApplyLinear() { return Apply(Linear()); }',
  '',
  '  /* 挑一个驱动真的肯接受的色温：从想要的温度往中性方向退，退到能用为止。',
  '     Windows 和各家驱动对伽马表偏离都有限制（本机实测 3200K 以下一律被拒），',
  '     直接失败的话用户拖到滑杆左边只会看到「没生效」，还不如退到能用为止、',
  '     再把实际用的温度如实报回去（页面会把滑杆吸到那个值上）。 */',
  '  public static int ApplyWarmBest(int kelvin, out int used) {',
  '    used = kelvin;',
  '    for (int k = kelvin; k <= 6500; k += 100) {',
  '      int n = ApplyWarm(k);',
  '      if (n > 0) { used = k; return n; }',
  '    }',
  '    return 0;',
  '  }',
  '',
  '  static string Csv(ushort[] a, int off) {',
  '    var sb = new StringBuilder();',
  '    for (int i = 0; i < 256; i++) { if (i > 0) sb.Append((char)44); sb.Append(a[off + i]); }',
  '    return sb.ToString();',
  '  }',
  '',
  '  static void ParseInto(string s, ushort[] into, int off) {',
  '    var parts = s.Split(new char[] { (char)44 });',
  '    for (int i = 0; i < 256 && i < parts.Length; i++) {',
  '      ushort v;',
  '      if (ushort.TryParse(parts[i], out v)) into[off + i] = v;',
  '    }',
  '  }',
  '',
  '  /* 当前伽马表拍成快照：一行一台显示器，「设备名|R|G|B」。',
  '     读不到就退回线性表，免得把没读到的脏数据当成原始值写回去。 */',
  '  public static string Snapshot() {',
  '    var sb = new StringBuilder();',
  '    foreach (var name in Devices()) {',
  '      var ramp = Linear();',
  '      IntPtr h = Dc(name);',
  '      if (h != IntPtr.Zero) {',
  '        var cur = new ushort[768];',
  '        if (GetDeviceGammaRamp(h, cur)) ramp = cur;',
  '        DeleteDC(h);',
  '      }',
  '      sb.Append(name).Append((char)124).Append(Csv(ramp, 0)).Append((char)124)',
  '        .Append(Csv(ramp, 256)).Append((char)124).Append(Csv(ramp, 512)).Append((char)10);',
  '    }',
  '    return sb.ToString();',
  '  }',
  '',
  '  public static int Restore(string text) {',
  '    if (text == null) return 0;',
  '    int ok = 0;',
  '    foreach (var line in text.Split(new char[] { (char)10 })) {',
  '      var t = line.Trim();',
  '      if (t.Length == 0) continue;',
  '      var f = t.Split(new char[] { (char)124 });',
  '      if (f.Length < 4) continue;',
  '      var ramp = new ushort[768];',
  '      ParseInto(f[1], ramp, 0); ParseInto(f[2], ramp, 256); ParseInto(f[3], ramp, 512);',
  '      IntPtr h = Dc(f[0]);',
  '      if (h == IntPtr.Zero) continue;',
  '      if (SetDeviceGammaRamp(h, ramp)) ok++;',
  '      DeleteDC(h);',
  '    }',
  '    return ok;',
  '  }',
  '',
  '  /* 自检用：把每台显示器当前伽马表的关键点打出来，证明色温真的被改了 */',
  '  public static string Dump() {',
  '    var sb = new StringBuilder();',
  '    foreach (var name in Devices()) {',
  '      IntPtr h = Dc(name);',
  '      var cur = new ushort[768];',
  '      bool got = h != IntPtr.Zero && GetDeviceGammaRamp(h, cur);',
  '      if (h != IntPtr.Zero) DeleteDC(h);',
  '      if (!got) { sb.Append(name).Append(": read-fail").Append((char)10); continue; }',
  '      sb.Append(name).Append(": R64=").Append(cur[64])',
  '        .Append(" G64=").Append(cur[256 + 64])',
  '        .Append(" B64=").Append(cur[512 + 64]).Append((char)10);',
  '    }',
  '    return sb.ToString();',
  '  }',
  '}',
  '"@'
].join('\n');

let eyeCareOn = false;
let eyeCareBusy = false;
let eyeCareError = '';
let eyeCareApplied = 0;
let eyeCareKelvin = EYE_KELVIN_DEFAULT;
/* 退出程序时要不要把色温还原（用户可选，默认【还原】）。
   不还原的话，程序退了屏幕还留在暖色上 —— 这是有意的选项（有人就想要一直暖着），
   所以必须让用户自己决定，而不是我们替他选。 */
let eyeCareRestorePref = true;
let eyeCareQuitDone = false;      // 退出还原只做一次（before-quit / will-quit / process.exit 都会试）
let eyeCareQuitPending = false;   // 正在「做完还原再退」，这期间再来的退出请求直接放行

function eyeCarePrefFile() { return path.join(app.getPath('userData'), 'eye-care.json'); }
/* 原始伽马表的备份单独一个文件：程序重启后只有靠它才还原得回真正的原始色温 */
function eyeCareRampFile() { return path.join(app.getPath('userData'), 'eye-care-ramp.txt'); }

/* 色温钳到合法范围并对齐到 100K 一档 —— 滑杆本来就是这个步长，
   这里再钳一次是防手改 json 改出个 99999 来 */
function clampKelvin(v) {
  const n = Math.round((Number(v) || 0) / 100) * 100;
  return Math.max(EYE_KELVIN_MIN, Math.min(EYE_KELVIN_MAX, n));
}

function loadEyeCarePref() {
  try {
    const o = JSON.parse(fs.readFileSync(eyeCarePrefFile(), 'utf8').replace(/^\uFEFF/, ''));
    eyeCareOn = !!o.on;
    if (o.kelvin) eyeCareKelvin = clampKelvin(o.kelvin);
    /* 缺省（老配置文件没有这个字段）= 还原，跟以前的行为一致 */
    eyeCareRestorePref = (typeof o.restoreOnQuit === 'boolean') ? o.restoreOnQuit : true;
  } catch (e) { eyeCareOn = false; }
}
function saveEyeCarePref() {
  try {
    fs.writeFileSync(eyeCarePrefFile(),
      JSON.stringify({ on: eyeCareOn, kelvin: eyeCareKelvin, restoreOnQuit: eyeCareRestorePref }, null, 2), 'utf8');
  } catch (e) { }
}

function eyeCareSnapshot() {
  return {
    on: eyeCareOn, busy: eyeCareBusy, error: eyeCareError, applied: eyeCareApplied,
    kelvin: eyeCareKelvin, min: EYE_KELVIN_MIN, max: EYE_KELVIN_MAX,
    defaultKelvin: EYE_KELVIN_DEFAULT,
    restoreOnQuit: eyeCareRestorePref
  };
}

/* op：on 开启（先存原始表）/ off 关闭（还原并删掉备份）/ reapply 重新应用 /
       restore-keep 还原但保留备份（退出程序时用，下次启动还要按它还原） */
function eyeCareApply(op) {
  const ramp = eyeCareRampFile().replace(/'/g, "''");
  const lines = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$ProgressPreference = 'SilentlyContinue'",
    EYE_WINAPI
  ];
  lines.push('$n = 0');
  lines.push('$used = 0');
  if (op === 'on') {
    /* 只在备份不存在时才拍快照：已经开着时重应用（比如拖了色温滑杆），
       当前表已经是我们调暖的那份，拍下来当「原始值」就再也回不去了 */
    lines.push("if (-not (Test-Path '" + ramp + "')) { [System.IO.File]::WriteAllText('" + ramp + "', [KkEye]::Snapshot()) }");
    lines.push('$n = [KkEye]::ApplyWarmBest(' + eyeCareKelvin + ', [ref]$used)');
  } else if (op === 'off') {
    lines.push("if (Test-Path '" + ramp + "') {");
    lines.push("  $n = [KkEye]::Restore([System.IO.File]::ReadAllText('" + ramp + "'))");
    lines.push("  Remove-Item '" + ramp + "' -Force");
    lines.push('} else { $n = [KkEye]::ApplyLinear() }');
    lines.push('$used = ' + eyeCareKelvin);
  } else if (op === 'restore-keep') {
    lines.push("if (Test-Path '" + ramp + "') { $n = [KkEye]::Restore([System.IO.File]::ReadAllText('" + ramp + "')) } else { $n = [KkEye]::ApplyLinear() }");
    lines.push('$used = ' + eyeCareKelvin);
  } else {
    lines.push('$n = [KkEye]::ApplyWarmBest(' + eyeCareKelvin + ', [ref]$used)');
  }
  lines.push('Write-Output ("EYE applied=" + $n + " total=" + [KkEye]::DisplayCount() + " kelvin=" + $used)');

  return new Promise(function (resolve) {
    psRun(lines.join('\n'), function (err, out) {
      const m = /EYE applied=(\d+) total=(\d+) kelvin=(\d+)/.exec(out || '');
      if (!m) {
        diagLog('eye-care-ps-error', {
          op: op,
          err: String((err && err.message) || '').slice(0, 500),
          out: String(out || '').slice(0, 500)
        });
      }
      resolve({
        applied: m ? parseInt(m[1], 10) : 0,
        total: m ? parseInt(m[2], 10) : 0,
        /* 驱动只肯接受到某个温度为止，这个才是真正生效的值 */
        used: m ? parseInt(m[3], 10) : 0,
        ok: !!m
      });
    });
  });
}

/* 所有「改伽马表」的操作串行化。
   改色温是 spawn 一个 PowerShell 去做的，异步而且不便宜；如果「开」还没跑完
   就来了「关」，两个进程会互相盖 —— 谁后写谁赢，顺序不保证。真出现「关」之后
   才落地一个「开」，屏幕就留在暖色上、而开关显示是关的，用户完全没法理解。
   自检里 initEyeCare() 是不 await 的，最容易踩到这个坑。 */
let eyeCareQueue = Promise.resolve();
function eyeCareSerial(fn) {
  const next = eyeCareQueue.then(fn, fn);
  eyeCareQueue = next.then(function () { }, function () { });
  return next;
}

/* on：要不要开；kelvin：给了就顺手改色温。
   拖滑杆时页面传 kelvin 且视为「要开」—— 拖了就是想看效果，不该拖了没反应。 */
async function eyeCareSet(on, kelvin) {
  on = !!on;
  if (kelvin !== undefined && kelvin !== null) {
    const k = clampKelvin(kelvin);
    if (k !== eyeCareKelvin) {
      eyeCareKelvin = k;
      saveEyeCarePref();
    }
  }
  eyeCareBusy = true;
  return eyeCareSerial(async function () {
    /* 开着的时候一律走 'on'：它会「备份不存在才拍快照」，所以改色温不会覆盖原始备份 */
    const r = await eyeCareApply(on ? 'on' : 'off');
    eyeCareBusy = false;

    if (on) {
      /* 一台都没成功就是没生效（显卡驱动不接受，或者开着 HDR）——
         勾选状态要如实反映现实，不能勾着却什么都没发生 */
      if (r.applied >= 1) {
        eyeCareOn = true; eyeCareApplied = r.applied; eyeCareError = '';
        /* 驱动对伽马表的偏离有限制（本机实测 3200K 以下一律被拒）。
           实际用的是退让之后的温度，就把它记下来，页面滑杆会吸到这个值上 ——
           否则滑杆停在 2700K、屏幕上却是 3300K，对不上。 */
        if (r.used && r.used !== eyeCareKelvin) eyeCareKelvin = r.used;
      } else {
        eyeCareOn = false; eyeCareApplied = 0;
        eyeCareError = r.total > 0
          ? '没生效：显卡驱动不接受色温调节（开了 HDR 也会失效）'
          : '没生效：没找到能调色温的显示器';
      }
    } else {
      eyeCareOn = false; eyeCareApplied = 0; eyeCareError = '';
    }
    saveEyeCarePref();
    send('eye-care-changed', eyeCareSnapshot());
    diagLog('eye-care-set', { want: on, kelvin: eyeCareKelvin, applied: r.applied, total: r.total });
    return eyeCareSnapshot();
  });
}

/* 休眠唤醒 / 改分辨率 / 插拔显示器都会让驱动把伽马表复位，这时要重设一遍 */
let eyeCareReTimer = null;
function eyeCareReapply(delay) {
  if (!eyeCareOn) return;
  if (eyeCareReTimer) clearTimeout(eyeCareReTimer);
  eyeCareReTimer = setTimeout(function () {
    eyeCareReTimer = null;
    eyeCareSerial(function () {
      /* 排到队时再确认一次：排队期间用户可能已经关掉了 */
      if (!eyeCareOn) return null;
      return eyeCareApply('reapply').then(function (r) {
        if (r.applied >= 1) eyeCareApplied = r.applied;
        diagLog('eye-care-reapply', { applied: r.applied, total: r.total });
      });
    });
  }, delay || 900);
}

function initEyeCare() {
  loadEyeCarePref();
  if (!eyeCareOn) return;
  /* 上次是开着的（可能还是强制退出的），重新应用一遍 ——
     伽马表这时候多半已经被系统复位成默认了 */
  eyeCareSerial(function () {
    if (!eyeCareOn) return null;
    return eyeCareApply('on').then(function (r) {
      if (r.applied >= 1) {
        eyeCareApplied = r.applied;
      } else {
        eyeCareOn = false;
        eyeCareError = '上次的护眼模式没能恢复：显卡驱动不接受色温调节';
        saveEyeCarePref();
      }
      send('eye-care-changed', eyeCareSnapshot());
    });
  });
}

/* 退出时的还原：不用 psRun（execFile 会挂 stdout/stderr 管道，拖住退出），
   直接 spawn 一个 detached 的 PowerShell —— Electron 退了它照样把色温还原完 */
function eyeCareRestoreOnQuit() {
  if (eyeCareQuitDone) return;
  eyeCareQuitDone = true;
  try {
    const ramp = eyeCareRampFile().replace(/'/g, "''");
    /* 让子进程把结果写下来：这条路上没法接 stdout（会拖住退出），
       出问题时只有靠这个文件知道它到底跑没跑、结果如何 */
    const logF = path.join(app.getPath('userData'), 'eye-care-quit.txt').replace(/'/g, "''");
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      "$ProgressPreference = 'SilentlyContinue'",
      EYE_WINAPI,
      '$n = -1',
      "if (Test-Path '" + ramp + "') { $n = [KkEye]::Restore([System.IO.File]::ReadAllText('" + ramp + "')) }",
      'else { $n = [KkEye]::ApplyLinear() }',
      "try { [System.IO.File]::WriteAllText('" + logF + "', 'applied=' + $n) } catch {}"
    ].join('\n');
    const b64 = Buffer.from(script, 'utf16le').toString('base64');
    const c = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64],
      { windowsHide: true, detached: true, stdio: 'ignore' });
    c.unref();
    diagLog('eyequit-spawn', { pid: c.pid, rampFile: ramp });
  } catch (e) {
    diagLog('eyequit-spawn-fail', { message: String((e && e.message) || e) });
  }
}

ipcMain.handle('eye-care-get', () => eyeCareSnapshot());
ipcMain.handle('eye-care-set', (e, on) => eyeCareSet(on));
/* 拖色温滑杆：一律按「打开」处理 —— 拖了就是想看效果 */
ipcMain.handle('eye-care-set-kelvin', (e, k) => eyeCareSet(true, k));
/* 「退出程序时是否还原色温」——纯偏好，不影响当前色温 */
ipcMain.handle('eye-care-set-restore-on-quit', (e, on) => {
  eyeCareRestorePref = !!on;
  saveEyeCarePref();
  send('eye-care-changed', eyeCareSnapshot());
  return eyeCareSnapshot();
});

/* ============================================================== 科研动态（arXiv）
   需求里的东西在 Electron 里是这样落地的：
     · 定时调度：主进程里的定时器（启动时若已超过间隔就补抓一次），跟界面完全无关，
       抓取全程异步，不占渲染进程、不卡界面
     · 数据源：只用 arXiv 官方 API（http://export.arxiv.org/api/query）——
       免费、不要密钥；走 Chromium 网络栈（net.fetch），会跟着系统代理
     · 存储：SQLite（Electron 自带 Node 24 的 node:sqlite，不需要编译原生模块），
       库文件在 userData/arxiv.db，以 arXiv ID 为主键天然去重
     · 推送：桌面宠物气泡（可点，点开进科研动态页）+ 托盘气泡（没开宠物时兜底）
       + 标签页上的未读红点
   任何一步出问题都只记日志、标状态，绝不让主界面跟着崩。 */
let arxivDb = null;
let arxivSvc = null;
let arxivLastNotify = null;       // 最近一次推送（自检/气泡复现用）

function arxivPushState() {
  send('arxiv-state', arxivSvc ? arxivSvc.state() : null);
}

function arxivShort(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? (t.slice(0, n - 1) + '…') : t;
}

function initArxiv() {
  try {
    const electron = require('electron');
    const ARXIVDB = require('./arxiv-db');
    const ARXIVSVC = require('./arxiv-service');
    arxivDb = ARXIVDB.openArxivDb(ARXIVDB.arxivDbPath(app.getPath('userData')));
    arxivSvc = ARXIVSVC.createArxivService({
      db: arxivDb,
      fetchImpl: function (url, opt) { return electron.net.fetch(url, opt); },
      notify: notifyArxivPapers,
      broadcast: function () { arxivPushState(); },
      log: function (tag, obj) { diagLog('arxiv-' + tag, obj); }
    });
    diagLog('arxiv-init', { 库: arxivDb.file, 关键词: arxivDb.getConfig().keywords });
    return true;
  } catch (e) {
    arxivDb = null;
    arxivSvc = null;
    diagLog('arxiv-init-fail', { message: String((e && e.message) || e) });
    return false;
  }
}

/* 抓到新论文 → 让宠物说一句（气泡可点），顺手更新红点。
   宠物没开的时候没有气泡可看，就用系统托盘气泡兜底，别让用户白等。 */
function notifyArxivPapers(p) {
  const items = (p && p.items) || [];
  arxivLastNotify = { at: Date.now(), count: items.length, items: items, keywords: (p && p.keywords) || [] };
  const kw = ((p && p.keywords) || []).slice(0, 2).join(' / ') || '你关注的方向';
  const head = '主人，我发现了 ' + items.length + ' 篇关于「' + kw + '」的新论文';
  const lines = items.slice(0, 3).map(function (x, i) {
    return (i + 1) + '. ' + arxivShort(x.title, 42);
  });
  const tip = lines.join('\n') +
    ((p && p.freshCount > items.length)
      ? '\n（一共新增 ' + p.freshCount + ' 篇，先挑最前面的 ' + items.length + ' 篇给你）' : '');

  const payload = {
    head: head,
    mer: 'arXiv · ' + new Date().toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5) + ' 更新',
    tip: tip,
    next: '点一下看详情 / 打开原文 →',
    extraH: UI.DESIGN.bubbleTodoHead + lines.length * UI.DESIGN.bubbleTodoRow,
    click: 'arxiv'
  };
  if (petOn) {
    showBubble(payload);
  } else if (tray) {
    try {
      tray.displayBalloon({
        title: '🔬 有新的科研论文',
        content: head + '\n点托盘图标 → 「🔬 科研动态」看详情'
      });
    } catch (e) { /* 托盘气泡失败不影响主流程 */ }
  }
  arxivPushState();
}

/* 用户点了可点的气泡：把主界面叫出来并切到科研动态页 */
ipcMain.on('bubble-clicked', () => {
  diagLog('arxiv-bubble-clicked', { 来源: '气泡被点了' });
  hideBubble();
  showWindow();
  send('show-arxiv');
});

ipcMain.handle('arxiv-state', () => (arxivSvc ? arxivSvc.state() : null));
ipcMain.handle('arxiv-set-config', (e, patch) => {
  if (!arxivSvc) return null;
  const next = arxivSvc.setConfig(patch || {});
  diagLog('arxiv-config', {
    关键词: next.keywords, 字段: next.fields, 模式: next.matchAny ? '任一' : '全部',
    天数: next.days, 间隔小时: next.intervalH, 每次上限: next.pushCap, 开启: next.enabled
  });
  return next;
});
ipcMain.handle('arxiv-fetch-now', async () => {
  if (!arxivSvc) return { ok: false, error: '科研动态在当前环境不可用' };
  return await arxivSvc.runFetch('手动');
});
ipcMain.handle('arxiv-list', (e, opts) => {
  if (!arxivDb) return { items: [], total: 0, limit: 0, offset: 0 };
  return arxivDb.listPapers(opts || {});
});
ipcMain.handle('arxiv-mark-read', (e, id) => {
  if (!arxivDb) return false;
  const r = arxivDb.markRead(String(id || ''));
  arxivPushState();
  return r;
});
ipcMain.handle('arxiv-mark-all-read', () => {
  if (!arxivDb) return 0;
  const n = arxivDb.markAllRead();
  arxivPushState();
  return n;
});
ipcMain.handle('arxiv-star', (e, id, on) => {
  if (!arxivDb) return false;
  const r = arxivDb.setStar(String(id || ''), !!on);
  arxivPushState();
  return r;
});
ipcMain.handle('arxiv-remove', (e, id) => {
  if (!arxivDb) return false;
  const r = arxivDb.removePaper(String(id || ''));
  arxivPushState();
  return r;
});
ipcMain.handle('arxiv-clear', () => {
  if (!arxivDb) return false;
  arxivDb.clearPapers();
  arxivPushState();
  return true;
});
/* 打开原文 / PDF：只放行 arxiv.org（用户点的是论文，不是任意网址） */
ipcMain.handle('arxiv-open', (e, url) => {
  const u = String(url || '');
  if (!/^https?:\/\/(www\.)?arxiv\.org\//i.test(u)) return false;
  try { require('electron').shell.openExternal(u); return true; } catch (err) { return false; }
});

/* ------------------------------------------------------------ 生命周期 */
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  /* 重复启动 = 又点了一次桌面图标：叫出窗口并报告当前时辰 */
  app.on('second-instance', () => {
    showWindow();
    send('show-shichen');
  });
  app.whenReady().then(() => {
    /* 基准屏的缩放只记一次：之后不管换到哪块屏，界面的物理大小都以它为基准，
       这样经常跨屏拖动的用户看到的界面大小是稳定的。 */
    try {
      const p = screen.getPrimaryDisplay();
      /* 基准屏始终取「真实」的显示器缩放，不吃 --diag 覆盖：
         否则基准屏和当前屏被覆盖成同一个值，k 永远是 1，等于没测。 */
      basePixelRatio = (p.scaleFactor) || 1;
      curPixelRatio = effScale(p);
    } catch (e) { basePixelRatio = 1; curPixelRatio = 1; }

    /* 开机自启动进来的：只留托盘，不弹主界面 */
    startHidden = process.argv.includes('--hidden') || process.argv.includes('--startup');

    createWindow();
    buildTray();
    bindPowerEvents();
    bindDisplayEvents();

    /* 自动更新：读偏好 → 挂事件 → 排第一次检查。
       放在 buildTray 之后，后台查到新版时托盘气泡才有得用。 */
    loadUpdatePref();
    initUpdater();
    scheduleUpdateCheck();

    /* 一键摸鱼：读偏好 → 注册全局快捷键。
       这里必须 try 住：快捷键注册失败绝不能把启动流程带崩。 */
    loadMoyuPref();
    try {
      diagLog('moyu', applyMoyuShortcut());
    } catch (e) {
      moyuError = String((e && e.message) || e);
      moyuResult = 'invalid';
      diagLog('moyu-error', { message: moyuError });
    }

    /* 护眼模式：读偏好 → 上次开着就重新调暖一遍。
       伽马表是显卡驱动的全局状态，程序重启不会自动恢复，得我们主动补上。 */
    try {
      initEyeCare();
    } catch (e) {
      diagLog('eye-care-init-error', { message: String((e && e.message) || e) });
    }

    /* 科研动态：开库 → 排定时 → 该补抓就补抓（等界面起来 15 秒后再动，别和启动抢） */
    try {
      if (initArxiv()) {
        arxivSvc.armTimer();
        arxivSvc.maybeCatchUp();
        arxivPushState();
      }
    } catch (e) {
      diagLog('arxiv-boot-fail', { message: String((e && e.message) || e) });
    }

    /* 全局热键看门狗：Windows 上偶尔会有别的软件把热键抢走、或者系统把它丢掉，
       表现就是「按了老板键一点反应都没有」。每 30 秒确认一次还在，不在就补注册。 */
    setInterval(function () {
      if (!moyuOn || !moyuActiveAccel) return;
      try {
        if (!globalShortcut.isRegistered(moyuActiveAccel)) {
          diagLog('moyu-hotkey-lost', { accel: moyuActiveAccel });
          moyuActiveAccel = null;
          applyMoyuShortcut();
          send('moyu-changed', moyuSnapshot());
        }
      } catch (e) { /* 查询失败就当它还在，下一轮再说 */ }
    }, 30000);
  });
  /* 退出前窗口会被关掉，先记下来；色温的还原也放在这里做（见下） */
  app.on('before-quit', (e) => {
    quitting = true;
    /* 科研动态：停掉定时器、关掉数据库，别留半截写入 */
    try { if (arxivSvc) arxivSvc.dispose(); } catch (err) { }
    try { if (arxivDb) arxivDb.close(); } catch (err) { }
    /* 退出前把色温还原掉 —— 必须【在做完之前不退】。
       原先是在 will-quit 里 spawn 一个 detached 的 PowerShell 去还原，实测没用：
       Electron（Chromium）在 Windows 上用 job object 管子进程，主进程一退，
       连带这个子进程一起被带走 —— 它自己写的日志文件都没生成，屏幕就留在暖色上了。
       所以改成：拦住这次退出 → 等还原真的做完（最多 2.5 秒兜底）→ 再真的退出。
       用户感知就是「点退出后界面多停半秒」，比留个没法关的暖屏好得多。 */
    if (eyeCareQuitPending) return;              // 第二次进来直接放行
    if (!eyeCareOn || !eyeCareRestorePref) return;
    e.preventDefault();
    eyeCareQuitPending = true;
    eyeCareQuitDone = true;                      // will-quit / process.exit 就不用再试了
    const finish = function () { try { app.quit(); } catch (err) { } };
    const t = setTimeout(finish, 2500);          // 兜底：别让用户关不掉程序
    try {
      eyeCareApply('restore-keep').then(function (r) {
        clearTimeout(t);
        diagLog('eyequit-before-quit', { applied: r.applied, total: r.total });
        finish();
      }, function () { clearTimeout(t); finish(); });
    } catch (err) {
      clearTimeout(t);
      finish();
    }
  });
  /* 退出时把全局快捷键摘掉，否则会残留在系统里（下次别的软件可能注册不上） */
  app.on('will-quit', () => {
    diagLog('eyequit-willquit', { eyeCareOn: eyeCareOn, restorePref: eyeCareRestorePref });
    try { globalShortcut.unregisterAll(); } catch (e) { }
    /* 连击那个键盘钩子进程必须收掉：它是长驻的，留着会变成「程序都关了还在
       数你的按键」的幽灵进程，而且钩子还挂在系统里 */
    moyuTapStop();
    /* 正常退出时上面 before-quit 已经还原过了；这里只是兜住绕过 before-quit 的路径 */
    if (eyeCareOn && eyeCareRestorePref) eyeCareRestoreOnQuit();
  });
  app.on('window-all-closed', () => { /* 有托盘常驻，不退出 */ });
  /* app.exit()（自检里就是这么退的）不会触发 will-quit，
     所以在 process 的 exit 上再兜一次：既收掉幽灵钩子进程，也把色温还原。
     这里必须同步做完（exit 阶段不能等异步），好在 spawn 本身是同步启动的，
     子进程是 detached 的，Electron 退了它照样跑完。 */
  process.on('exit', function () {
    if (moyuTapChild) { try { moyuTapChild.kill(); } catch (e) { } }
    if (eyeCareOn && eyeCareRestorePref) eyeCareRestoreOnQuit();
  });
  /* 点任务栏 / 桌面图标重新激活：自启隐藏状态下要能正常叫出来 */
  app.on('activate', () => {
    if (!win) { startHidden = false; createWindow(); } else showWindow();
  });
}
