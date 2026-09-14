/* =========================================================================
   电子坤坤提醒器 —— Electron 主进程
   职责：
     · 无边框窗口 + 自绘标题栏；到点把窗口强制拉到前台
     · 系统托盘常驻（关闭/✕ = 收进右下角托盘，不退出）
     · 宠物模式：只剩动画的小窗、悬浮置顶，右键弹原生菜单
   ========================================================================= */
const { app, BrowserWindow, ipcMain, Menu, screen, Tray, nativeImage } = require('electron');
const path = require('path');

let win = null;
let tray = null;
let petMode = false;
let timersRunning = true;
let normalBounds = null;
let quitting = false;
let balloonShown = false;
let wasHidden = false;      // 提醒前窗口是否藏在托盘里
let petBeforeAlert = false; // 提醒前是否在宠物模式

const NORMAL = { width: 1180, height: 880 };

/* 宠物模式只显示坤坤本体，窗口透明无边框；迷你（150×170）是最大档 */
const PET_SIZES = {
  max: { label: '迷你（150 × 170）', w: 150, h: 170 },
  mid: { label: '小小（118 × 134）', w: 118, h: 134 },
  min: { label: '超小（92 × 104）', w: 92, h: 104 }
};
let petSize = 'max';

const INTERVALS = {
  water: [15, 30, 45, 60, 90],
  rest: [20, 40, 60, 90, 120]
};

/* ------------------------------------------------------------ 创建窗口 */
function createWindow() {
  win = new BrowserWindow({
    width: NORMAL.width,
    height: NORMAL.height,
    minWidth: 760,
    minHeight: 560,
    frame: false,                 // 无边框：普通模式用自绘标题栏，宠物模式只剩动画
    transparent: true,            // 宠物模式下窗口背景完全透明，只看得见坤坤
    backgroundColor: '#00000000',
    title: '电子坤坤提醒器',
    icon: path.join(__dirname, 'icon.png'),
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
  win.once('ready-to-show', () => win.show());

  // 点 ✕ = 收进托盘，而不是退出
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    hideToTray();
  });

  win.on('closed', () => { win = null; });
}

/* ------------------------------------------------- 到点：抢到最前面 */
function bringToFront() {
  if (!win) return;

  wasHidden = !win.isVisible() || win.isMinimized();
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();

  // 宠物窗太小，弹层会显示不全 —— 提醒时直接切回大主界面
  petBeforeAlert = petMode;
  if (petMode) {
    applyPetMode(false);
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
  }

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
    let img = nativeImage.createFromPath(path.join(__dirname, 'tray.png'));
    if (img.isEmpty()) img = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
    tray = new Tray(img);
  } catch (err) {
    return;
  }
  tray.setToolTip('电子坤坤 · 喝水休息提醒器');
  tray.on('click', toggleWindow);
  tray.on('double-click', showWindow);
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示坤坤', click: showWindow },
    { label: '宠物模式（只剩动画）', type: 'checkbox', checked: petMode, click: (mi) => applyPetMode(mi.checked) },
    { type: 'separator' },
    { label: '💧 立即提醒喝水', click: () => alertNow('water') },
    { label: '🛋️ 立即提醒休息', click: () => alertNow('rest') },
    { label: timersRunning ? '⏸ 暂停计时' : '▶ 继续计时', click: () => { if (win) win.webContents.send('tray-toggle'); } },
    { type: 'separator' },
    { label: '退出', click: quitApp }
  ]));
}

function alertNow(kind) {
  showWindow();
  if (win) win.webContents.send('tray-alert', kind);
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
  app.quit();
}

/* ------------------------------------------------------------ 宠物模式 */
function applyPetMode(on, silent) {
  if (!win) return false;
  petMode = !!on;
  const area = screen.getPrimaryDisplay().workAreaSize;

  if (petMode) {
    if (!win.isVisible()) win.show();
    if (!normalBounds) normalBounds = win.getBounds();
    const sz = PET_SIZES[petSize] || PET_SIZES.max;
    win.setAlwaysOnTop(true, 'floating');
    win.setSkipTaskbar(true);            // 宠物模式不进任务栏，只留托盘图标
    win.setMinimumSize(80, 80);          // 宠物窗可以很小
    win.setBounds({
      x: area.width - sz.w - 28,
      y: area.height - sz.h - 28,
      width: sz.w,
      height: sz.h
    });
  } else {
    win.setAlwaysOnTop(false);
    win.setSkipTaskbar(false);           // 主界面恢复正常任务栏图标
    win.setMinimumSize(760, 560);
    if (normalBounds) win.setBounds(normalBounds);
    normalBounds = win.getBounds();
  }
  refreshTrayMenu();
  if (!silent && win) win.webContents.send('pet-mode-changed', petMode);
  return petMode;
}

/* ------------------------------------------------------------ 宠物大小 */
function setPetSize(name) {
  if (!PET_SIZES[name]) return petSize;
  petSize = name;
  if (petMode) applyPetMode(true, true);      // 正在宠物模式就立刻换尺寸
  refreshTrayMenu();
  if (win) win.webContents.send('pet-size-changed', petSize);   // 同步回主界面
  return petSize;
}

/* --------------------------------------- 宠物模式 / 托盘 右键菜单 */
function intervalSubmenu(kind, title) {
  return {
    label: title,
    submenu: INTERVALS[kind].map(m => ({
      label: m + ' 分钟',
      click: () => { if (win) win.webContents.send('set-interval', { kind, minutes: m }); }
    }))
  };
}

ipcMain.handle('pet-menu', () => {
  if (!win) return false;
  Menu.buildFromTemplate([
    { label: '显示主界面', click: () => { applyPetMode(false); showWindow(); } },
    { label: '收进托盘', click: hideToTray },
    { type: 'separator' },
    {
      label: '调整倒计时',
      submenu: [
        intervalSubmenu('water', '💧 喝水间隔'),
        intervalSubmenu('rest', '🛋️ 休息间隔')
      ]
    },
    {
      label: '宠物大小',
      submenu: Object.keys(PET_SIZES).map(k => ({
        label: PET_SIZES[k].label,
        type: 'radio',
        checked: petSize === k,
        click: () => setPetSize(k)
      }))
    },
    { type: 'separator' },
    { label: '退出坤坤', click: quitApp }
  ]).popup({ window: win });
  return true;
});

/* ------------------------------------------------------------ IPC */
ipcMain.handle('alert', () => { bringToFront(); return true; });

ipcMain.handle('dismiss', () => {
  if (!win) return false;
  win.flashFrame(false);
  if (!petMode) win.setAlwaysOnTop(false);

  // 提醒前躲在托盘里的话，打完卡自己缩回去
  if (wasHidden && !petMode) {
    wasHidden = false;
    setTimeout(() => {
      if (win && !quitting && !win.isDestroyed() && !petMode) win.hide();
    }, 1600);
  }
  // 提醒前在宠物模式的话，打完卡再变回小宠物
  if (petBeforeAlert) {
    petBeforeAlert = false;
    setTimeout(() => {
      if (win && !quitting && !win.isDestroyed() && !petMode) applyPetMode(true);
    }, 1800);
  }
  return true;
});

ipcMain.handle('pet-mode', (e, on) => applyPetMode(on, false));
ipcMain.handle('set-pet-size', (e, name) => setPetSize(name));
ipcMain.handle('get-pet-size', () => petSize);
ipcMain.handle('minimize', () => { if (win) win.minimize(); });
ipcMain.handle('hide', () => hideToTray());
ipcMain.handle('quit', () => quitApp());

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
  dragState = null;
});

ipcMain.on('state', (e, s) => {
  if (!s) return;
  const changed = (timersRunning !== !!s.running) || (petMode !== !!s.petMode);
  timersRunning = !!s.running;
  if (typeof s.petMode === 'boolean' && s.petMode !== petMode) petMode = s.petMode;
  if (changed) refreshTrayMenu();
});

/* ------------------------------------------------------------ 生命周期 */
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(() => { createWindow(); buildTray(); });
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => { /* 有托盘常驻，不退出 */ });
  app.on('activate', () => { if (!win) createWindow(); else showWindow(); });
}
