/* =========================================================================
   别感冒提醒器 —— Electron 主进程
   职责：
     · 无边框窗口 + 自绘标题栏；到点把窗口强制拉到前台
     · 系统托盘常驻（关闭/✕ = 收进右下角托盘，不退出）
     · 宠物模式：只剩动画的小窗、悬浮置顶，右键弹原生菜单
     · 屏幕缩放（DPI）适配：窗口逻辑尺寸 = 物理设计尺寸 ÷ k，k 见 ui-scale.js
   ========================================================================= */
const { app, BrowserWindow, ipcMain, Menu, screen, Tray, nativeImage, powerMonitor, globalShortcut, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
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
    /* --diag-tab=home|todo|settings：自检时切到指定页再截图 */
    m = /^--diag-tab=(home|todo|settings)$/.exec(a);
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
            const navRuns = [];
            for (let ni = 0; ni < 3; ni++) {
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
                '["secBasic","secUpdate","secMoyu"].forEach(function(id){' +
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
            diagLog('set-nav', { 点击前scrollTop: navBefore, 三次点击: navRuns });
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
        const { spawn } = require('child_process');
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
    }
  } catch (e) { /* 首次运行没这个文件，用默认值 */ }
}

function saveMoyuPref() {
  try {
    fs.writeFileSync(moyuPrefFile(),
      JSON.stringify({ on: moyuOn, accel: moyuAccel, target: moyuTarget, custom: moyuCustom }, null, 2), 'utf8');
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
    running: moyuRunning
  };
}

/* ---------- 用 PowerShell 操作桌面窗口 ----------
   走 -EncodedCommand（base64）而不是临时 .ps1 文件：
   一是省得往磁盘写脚本（杀毒软件对 AppData 里执行脚本很敏感），
   二是彻底绕开引号/换行的转义问题。 */
function psRun(script, done) {
  const b64 = Buffer.from(script, 'utf16le').toString('base64');
  return execFile('powershell.exe',
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
      if (typeof done === 'function') done(err);
    });
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
  /* 挑出「这次打开动作真正拉起来的那个窗口」，找不到返回 Zero。
     顺序：① before 之外的可见新窗口（目标程序本来没开 / 开了新窗口）
           ② 现在自己从最小化状态恢复了的窗口（目标程序已在跑，打开文件时
              还原的是老窗口 —— Win11 记事本这种标签页式的就走这条）
     三个「绝不碰」的约束：
       - 不看「当前前台窗口」：实测目标还没起来时前台可能是别的软件
         （比如 Outlook 弹出来提醒），照着前台最大化会把别人的窗口顶到最前面；
       - 跳过自己进程（selfPid）的窗口：桌面宠物窗 / 气泡窗都有标题、
         又不在 VisibleHandles 的 before 清单里（那个按 selfPid 排除了），
         不排掉就会被当成「新窗口」放大到全屏；
       - 跳过 DWM 隐身的空壳窗口（见 Cloaked），否则会去最大化一个看不见的壳。 */
  '  public static IntPtr PickTarget(IntPtr[] before, string wasMinimizedCsv, bool allowRestored, int selfPid) {',
  '    var seen = new HashSet<IntPtr>();',
  '    if (before != null) { foreach (var h in before) seen.Add(h); }',
  '    IntPtr best = IntPtr.Zero;',
  '    IntPtr any = IntPtr.Zero;',
  '    EnumWindows(delegate(IntPtr h, IntPtr l) {',
  '      if (IsIconic(h)) return true;',
  '      if (!RealWindow(h, selfPid, null)) return true;',
  '      if (seen.Contains(h)) return true;',
  '      if (any == IntPtr.Zero) any = h;',
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
  '    if (any != IntPtr.Zero) return any;',
  '    if (!allowRestored) return IntPtr.Zero;',
  '    foreach (var s in SplitCsv(wasMinimizedCsv)) {',
  '      long v; if (!long.TryParse(s, out v)) continue;',
  '      IntPtr h = new IntPtr(v);',
  '      if (IsWindowVisible(h) && !IsIconic(h) && !Cloaked(h)) return h;',
  '    }',
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

  /* 清掉上一次的清单：这样「清单存在」就等于「这一次已经收好了」，
     moyuBack() 靠它判断能不能安全地按住不动。 */
  try { fs.unlinkSync(moyuStateFile()); } catch (e) { }

  /* 自己的主窗口直接藏掉（任务栏图标一起没）——
     用最小化的话任务栏会留一条自己的程序名，摸鱼就露馅了 */
  hideToTray(true);

  const stateFile = moyuStateFile().replace(/'/g, "''");
  const t = moyuTarget.replace(/'/g, "''");          // PowerShell 单引号串里要写成 ''
  const isDoc = moyuTarget ? moyuIsDoc(moyuTarget) : false;

  const lines = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    /* 关掉进度流：PowerShell 首次运行会往 stderr 写 CLIXML 进度记录，
       会让 execFile 误判成命令失败（退出码和执行结果其实都是对的）。 */
    "$ProgressPreference = 'SilentlyContinue'",
    MOYU_WINAPI,
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
    "$target = '" + t + "'",
    "if ($target -ne '') { Start-Process -FilePath $target | Out-Null }"
  ];

  if (isDoc) {
    lines.push(
      /* 只认「这次新冒出来的窗口」或「刚被还原的老窗口」，
         绝不碰本来就开着、仍然最小化的窗口 —— 挨个去看当前前台窗口是错的：
         目标还没起来时前台可能是别的软件（实测把 Outlook 顶到最前面最大化了）。 */
      '$h = [IntPtr]::Zero',
      'for ($i = 0; $i -lt 40 -and $h -eq [IntPtr]::Zero; $i++) {',
      '  Start-Sleep -Milliseconds 250',
      /* 前 2.5 秒只认新窗口；之后才接受「目标程序把老窗口自己还原了」这种情形 */
      '  $h = [KkWin]::PickTarget($before, $pool, ($i -ge 10), ' + process.pid + ')',
      '}',
      'if ($h -ne [IntPtr]::Zero) {',
      '  [KkWin]::ShowWindow($h, 3) | Out-Null',                          // SW_MAXIMIZE
      '  [KkWin]::SetForegroundWindow($h) | Out-Null',
      '}'
    );
  }

  moyuGoChild = psRun(lines.join('\n'));
  send('moyu-changed', moyuSnapshot());
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
    moyuBacking = false;
  };

  const gone = !child || child.exitCode !== null || child.signalCode !== null;
  if (gone) finish(); else moyuWaitState(child, finish);
}

function moyuToggle() {
  if (moyuBacking) return;
  if (moyuRunning) moyuBack(); else moyuGo();
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

  if (!moyuOn) { moyuResult = 'off'; return moyuSnapshot(); }
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
  if (cfg && typeof cfg === 'object') {
    if (typeof cfg.on === 'boolean') moyuOn = cfg.on;
    if (typeof cfg.accel === 'string') {
      moyuAccel = cfg.accel.trim();
      moyuCustom = !!moyuAccel;      // 用户亲手录的，之后不再自动顺位
    }
  }
  saveMoyuPref();
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
  });
  app.on('before-quit', () => { quitting = true; });
  /* 退出时把全局快捷键摘掉，否则会残留在系统里（下次别的软件可能注册不上） */
  app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch (e) { } });
  app.on('window-all-closed', () => { /* 有托盘常驻，不退出 */ });
  /* 点任务栏 / 桌面图标重新激活：自启隐藏状态下要能正常叫出来 */
  app.on('activate', () => {
    if (!win) { startHidden = false; createWindow(); } else showWindow();
  });
}
