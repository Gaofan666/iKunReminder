/* =========================================================================
   别感冒提醒器 —— Electron 主进程
   职责：
     · 无边框窗口 + 自绘标题栏；到点把窗口强制拉到前台
     · 系统托盘常驻（关闭/✕ = 收进右下角托盘，不退出）
     · 宠物模式：只剩动画的小窗、悬浮置顶，右键弹原生菜单
     · 屏幕缩放（DPI）适配：窗口逻辑尺寸 = 物理设计尺寸 ÷ k，k 见 ui-scale.js
   ========================================================================= */
const { app, BrowserWindow, ipcMain, Menu, screen, Tray, nativeImage, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
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
    /* --diag-tab=home|todo|settings：自检时切到指定页再截图 */
    m = /^--diag-tab=(home|todo|settings)$/.exec(a);
    if (m) out.tab = m[1];
    /* --diag-wait=<ms>：截图前多等一会儿，用来测异步的东西
       （比如启动 8 秒后才会跑的「自动检查更新」） */
    m = /^--diag-wait=(\d+)$/.exec(a);
    if (m) out.wait = parseInt(m[1], 10);
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
   所以关键节点同时写文件。正常启动（不带 --diag）一概不写。 */
function diagLog(tag, obj) {
  if (!DIAG) return;
  try {
    const line = new Date().toISOString() + ' [' + tag + '] ' + JSON.stringify(obj || {}) + '\n';
    fs.appendFileSync(path.join(__dirname, '.diag', 'trace.log'), line);
  } catch (e) { /* 忽略 */ }
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
  const rpx = (d && d.scaleFactor) || 1;
  const kOld = uiK();
  const kNew = UI.computeUiScale(px, basePixelRatio);
  const rOld = realUiK({ scaleFactor: curPixelRatio });
  const rNew = realUiK(d);
  const changed = !sameScale(px, curPixelRatio) || !sameScale(kOld, kNew);

  if (!force && !changed) { sendDpiInfo(); return; }

  curPixelRatio = px;
  /* 主界面：保持物理尺寸（用户手动拉过的比例也一起保住），左上角不动 */
  if (normalBounds) normalBounds = UI.rescaleBox(normalBounds, kOld, kNew, d.workArea, 'topleft');
  const next = UI.rescaleBox(b, kOld, kNew, d.workArea, 'topleft');
  const min = UI.windowBox(kNew).main;
  win.setMinimumSize(min.minWidth, min.minHeight);
  win.setBounds(next);
  if (!normalBounds) normalBounds = next;
  /* 桌面宠物是独立窗口，跟着它自己所在的那块屏重新适配 */
  applyPetDisplay();
  sendDpiInfo();
}

/* 显示器插拔 / 缩放比例改变（拔掉副屏、在系统设置里改缩放） */
function bindDisplayEvents() {
  try {
    screen.on('display-metrics-changed', function (e, d) {
      if (!win || win.isDestroyed()) return;
      const b = win.getBounds();
      const cur = displayOf(b.x + Math.max(1, b.width) / 2, b.y + 8);
      if (d && cur && d.id !== cur.id) return;     // 别的屏变了，与本窗口无关
      setTimeout(function () { applyDisplay(true); }, 250);
    });
    screen.on('display-removed', function () {
      setTimeout(function () { applyDisplay(true); }, 300);
    });
  } catch (e) { /* 个别平台没有这些事件 */ }
}

/* 主界面默认尺寸 = 物理 1180×880 ÷ k（见 ui-scale.js）。
   以前这里写死 1180×880 —— 那是「逻辑尺寸」，在 4K@200% 下开出来的窗口
   物理上只有 590×440 英寸数，看着就是个小窗；现在按物理尺寸算，走到哪都一样大。 */
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
   不设的话任务栏有时会显示成 Electron 默认图标、也不会正确合并。 */
if (process.platform === 'win32') {
  try { app.setAppUserModelId('com.kunkun.reminder'); } catch (e) { }
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

  win = new BrowserWindow({
    x: saved ? saved.x : undefined,
    y: saved ? saved.y : undefined,
    width: saved ? Math.max(saved.width, box.minWidth) : box.width,
    height: saved ? Math.max(saved.height, box.minHeight) : box.height,
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
            await new Promise(function (r) { setTimeout(r, 1200); });
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
          diagLog('error', { message: String(e && e.message || e) });
          console.log('[DIAG-ERROR] ' + (e && e.message ? e.message : e));
        }
        quitting = true;
        try { app.exit(0); } catch (e) { }
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
    { type: 'separator' },
    { label: '🕰 十二时辰对照表', click: () => { showWindow(); send('show-shichen'); } },
    { label: '＋ 添加提醒事项', click: () => { showWindow(); send('add-item'); } },
    { label: '📝 待办与备忘', click: () => { showWindow(); send('show-todo'); } },
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

function showWindow() {
  if (!win) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function toggleWindow() {
  if (!win) { createWindow(); return; }
  if (win.isVisible() && !win.isMinimized()) win.hide();
  else showWindow();
}

function hideToTray() {
  if (!win) return;
  hideBubble();                 // 气泡是独立小窗，收托盘时要一起收掉
  win.hide();
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

/* 宠物窗/托盘的右键菜单（同一个内容，两处入口） */
function buildPetMenu() {
  if (!petWin || petWin.isDestroyed()) return false;
  const tpl = [
    { label: '显示主界面', click: () => { showWindow(); } },
    { label: '隐藏桌面宠物', click: () => { setPetOn(false); } },
    { type: 'separator' },
    { label: '🕰 十二时辰对照表', click: () => { showWindow(); send('show-shichen'); } },
    { label: '＋ 添加提醒事项', click: () => { showWindow(); send('add-item'); } },
    { label: '📝 打开待办', click: () => { showWindow(); send('show-todo'); } }
  ];
  if (menuItems.length) {
    tpl.push({ type: 'separator' });
    tpl.push({ label: '调整倒计时', submenu: menuItems.map(intervalSubmenu) });
  }
  tpl.push({ type: 'separator' });
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
  Menu.buildFromTemplate(tpl).popup({ window: petWin });
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
   HKCU\Software\Microsoft\Windows\CurrentVersion\Run，不需要管理员权限，
   用户也能在「任务管理器 → 启动」里自己禁掉。
   不加 --hidden 的话开机就会弹出主界面，那是用户明确不要的行为。 */
function autoLaunchEnabled() {
  try {
    if (process.platform !== 'win32') return false;
    return !!app.getLoginItemSettings().openAtLogin;
  } catch (e) { return false; }
}

function setAutoLaunch(on) {
  try {
    if (process.platform !== 'win32') return false;
    const args = ['--hidden'];
    /* 绿色版是 exe 直接跑；开发时用 electron.exe 跑目录，参数要跟着变 */
    const exe = process.execPath;
    app.setLoginItemSettings({
      openAtLogin: !!on,
      path: exe,
      args: app.isPackaged ? args : [path.resolve(__dirname)].concat(args)
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
  bubbleWin.setAlwaysOnTop(true, 'floating');
  bubbleWin.setIgnoreMouseEvents(true);      // 气泡纯展示，鼠标事件穿透过去
  bubbleWin.loadFile(path.join(__dirname, 'bubble.html'));
  bubbleWin.on('closed', () => { bubbleWin = null; });
  return bubbleWin;
}

/* 显示气泡：主进程负责算位置，渲染进程只提供文字内容 */
function showBubble(data) {
  const b = petHome || (win && !win.isDestroyed() ? win.getBounds() : null);
  if (!b) return false;

  const bw = ensureBubbleWin();
  const box = bubbleBox();
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

  const payload = {
    head: (data && data.head) || '',
    mer: (data && data.mer) || '',
    tip: (data && data.tip) || '',
    next: (data && data.next) || '',
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

  bw.showInactive();                          // 不激活、不抢焦点
  talkOpen = true;
  armBubbleTimer();                           // 说一会儿自己收掉，不挡着桌面
  return true;
}

/* 气泡自动收起：显示 6 秒（再点一次 / 开始拖动会提前收掉） */
const BUBBLE_MS = 6000;
let bubbleTimer = null;

function armBubbleTimer() {
  if (bubbleTimer) clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(function () {
    bubbleTimer = null;
    hideBubble();
  }, BUBBLE_MS);
}

function hideBubble() {
  talkOpen = false;
  requestWanted = false;
  if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null; }
  if (bubbleWin && !bubbleWin.isDestroyed() && bubbleWin.isVisible()) bubbleWin.hide();
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

   三个位置都会找（方便用户放）：
     1. 装好后 exe 同级的 skins/          ← 推荐，用户最找得到
     2. 安装目录 resources/skins/          （打包进去的示例）
     3. 开发时的 <项目>/skins/
   皮肤图由主进程读成 data URL 再交给渲染进程，所以不用放宽页面的 CSP。 */
function skinsDirs() {
  const list = [];
  try { list.push(path.join(path.dirname(app.getPath('exe')), 'skins')); } catch (e) { }
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
  const list = [{ id: '__default', name: '篮球男孩', author: '', builtin: true }];
  scanSkins().forEach(function (s) {
    list.push({ id: s.id, name: s.name, author: s.author, builtin: false });
  });
  return list;
});

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

/* ------------------------------------------- 手动拖窗（比 CSS drag 区域可靠，
   透明窗口和宠物小窗上都能用） */
let dragState = null;

/* 把窗口位置钳制在鼠标所在显示器的可用区域内，不让它被拖出屏幕 */
function clampToWorkArea(x, y, w, h, pt) {
  let wa;
  try {
    wa = screen.getDisplayNearestPoint({ x: Math.round(pt.x), y: Math.round(pt.y) }).workArea;
  } catch (err) {
    wa = screen.getPrimaryDisplay().workArea;
  }
  const maxX = wa.x + Math.max(0, wa.width - w);
  const maxY = wa.y + Math.max(0, wa.height - h);
  return {
    x: Math.min(Math.max(x, wa.x), maxX),
    y: Math.min(Math.max(y, wa.y), maxY)
  };
}

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
    b.width, b.height, pt
  );
  win.setBounds({ x: pos.x, y: pos.y, width: b.width, height: b.height });
});

ipcMain.on('drag-end', () => {
  // 松手再钳一次：万一窗口尺寸或屏幕布局变了，也不会停在界外
  if (win && !win.isDestroyed()) {
    const b = win.getBounds();
    const pos = clampToWorkArea(b.x, b.y, b.width, b.height,
      { x: b.x + b.width / 2, y: b.y + b.height / 2 });
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
      powerMonitor.on(ev, function () { send('power', map[ev]); });
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
    const o = JSON.parse(fs.readFileSync(updatePrefFile(), 'utf8'));
    if (o && typeof o.autoCheck === 'boolean') updateAutoCheck = o.autoCheck;
  } catch (e) { /* 首次运行没这个文件，用默认值 */ }
}

function saveUpdatePref() {
  try {
    fs.writeFileSync(updatePrefFile(), JSON.stringify({ autoCheck: updateAutoCheck }, null, 2), 'utf8');
  } catch (e) { }
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
    notes: updateInfo ? notesText(updateInfo.releaseNotes) : ''
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

function checkUpdate(manual) {
  if (!updateSupported) return Promise.resolve(updateSnapshot());
  if (updateState === 'downloading') return Promise.resolve(updateSnapshot());
  updateManual = !!manual;
  updatePercent = 0;
  updateError = '';
  return autoUpdater.checkForUpdates().then(function () {
    return updateSnapshot();
  }).catch(function (err) {
    setUpdateError(err);
    return updateSnapshot();
  });
}

function downloadUpdate() {
  if (!updateSupported || updateState !== 'available') return false;
  updateState = 'downloading';
  updatePercent = 0;
  updateError = '';
  pushUpdate();
  autoUpdater.downloadUpdate().catch(function (err) { setUpdateError(err); });
  return true;
}

function installUpdate() {
  if (!updateSupported || updateState !== 'downloaded') return false;
  quitting = true;                 // 别让 close 处理器把窗口收进托盘
  send('update-installing');
  /* 静默安装，装完自动把新版拉起来 —— 用户已经点过「重启并安装」了，不用再走向导 */
  setImmediate(function () {
    try {
      autoUpdater.quitAndInstall(true, true);
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
  });
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => { /* 有托盘常驻，不退出 */ });
  /* 点任务栏 / 桌面图标重新激活：自启隐藏状态下要能正常叫出来 */
  app.on('activate', () => {
    if (!win) { startHidden = false; createWindow(); } else showWindow();
  });
}
