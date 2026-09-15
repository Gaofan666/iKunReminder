/* =========================================================================
   电子坤坤提醒器 —— Electron 主进程
   职责：
     · 无边框窗口 + 自绘标题栏；到点把窗口强制拉到前台
     · 系统托盘常驻（关闭/✕ = 收进右下角托盘，不退出）
     · 宠物模式：只剩动画的小窗、悬浮置顶，右键弹原生菜单
   ========================================================================= */
const { app, BrowserWindow, ipcMain, Menu, screen, Tray, nativeImage, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');

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
  win.once('ready-to-show', () => win.show());

  // 点 ✕ = 收进托盘，而不是退出
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    hideToTray();
  });

  win.on('closed', () => { win = null; });

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
    /* 优先用多尺寸 ICO：系统会按 DPI 挑最合适的那一档，比单张 PNG 清楚 */
    let img = nativeImage.createFromPath(iconPath());
    if (img.isEmpty()) img = nativeImage.createFromPath(path.join(__dirname, 'tray.png'));
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
  const tpl = [
    { label: '显示主界面', click: showWindow },
    { label: '宠物模式（只剩动画）', type: 'checkbox', checked: petMode, click: (mi) => applyPetMode(mi.checked) },
    { type: 'separator' },
    { label: '🕰 十二时辰对照表', click: () => { showWindow(); send('show-shichen'); } },
    { label: '＋ 添加提醒事项', click: () => { showWindow(); send('add-item'); } },
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

/* ------------------------------------------------------------ 宠物模式 */
/* 宠物窗的「家」：进入宠物模式时钉死一次，说话结束后每次都回到这里。
   不每次重存的话，Windows 在非 100% 缩放比下会把尺寸取整出 1px 偏差，
   来回说话几十次宠物就会慢慢变大。 */
let petHome = null;
let talkOpen = false;

function applyPetMode(on, silent) {
  if (!win) return false;
  petMode = !!on;
  petHome = null;
  hideBubble();                 // 切模式时把气泡收掉
  const area = screen.getPrimaryDisplay().workAreaSize;

  if (petMode) {
    if (!win.isVisible()) win.show();
    if (!normalBounds) normalBounds = win.getBounds();
    const sz = PET_SIZES[petSize] || PET_SIZES.max;
    win.setAlwaysOnTop(true, 'floating');
    win.setSkipTaskbar(true);            // 宠物模式不进任务栏，只留托盘图标
    win.setMinimumSize(80, 80);          // 宠物窗可以很小
    /* 关掉可缩放：不然鼠标蹭到窗口边缘就能把宠物窗拉大，
       而宠物本身是按比例画的、看不出变化，等点开气泡时窗口会按那个
       被拉大的尺寸铺开，一下子变得特别巨大。大小只该由「宠物大小」菜单决定。 */
    win.setResizable(false);
    win.setBounds({
      x: area.width - sz.w - 28,
      y: area.height - sz.h - 28,
      width: sz.w,
      height: sz.h
    });
    petHome = win.getBounds();           // 记下系统实际给的大小
    ensureBubbleWin();                   // 提前把气泡窗建好，第一次点开才不会有延迟
  } else {
    win.setResizable(true);              // 主界面恢复可缩放
    win.setAlwaysOnTop(false);
    win.setSkipTaskbar(false);           // 主界面恢复正常任务栏图标
    win.setMinimumSize(760, 560);
    if (normalBounds) win.setBounds(normalBounds);
    normalBounds = win.getBounds();
    destroyBubble();                     // 离开宠物模式就把气泡窗连同它的渲染进程一起释放
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
function intervalSubmenu(it) {
  return {
    label: (it.emoji || '') + ' ' + it.name + '（当前 ' + it.minutes + ' 分钟）',
    submenu: QUICK_MINUTES.map(m => ({
      label: m + ' 分钟',
      click: () => send('set-interval', { id: it.id, minutes: m })
    }))
  };
}

let currentSkin = '__default';       // 当前宠物形象，右键菜单要拿它打勾

ipcMain.on('skin-changed', (e, id) => { if (typeof id === 'string') currentSkin = id; });

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
        currentSkin = s.id;
        send('set-skin', s.id);       // 交给渲染进程去真正换
      }
    };
  });
}

ipcMain.handle('pet-menu', () => {
  if (!win) return false;
  const tpl = [
    { label: '显示主界面', click: () => { applyPetMode(false); showWindow(); } },
    { label: '收进托盘', click: hideToTray },
    { type: 'separator' },
    { label: '🕰 十二时辰对照表', click: () => { applyPetMode(false); showWindow(); send('show-shichen'); } },
    { label: '＋ 添加提醒事项', click: () => { applyPetMode(false); showWindow(); send('add-item'); } }
  ];

  if (menuItems.length) {
    tpl.push({ type: 'separator' });
    tpl.push({
      label: '调整倒计时',
      submenu: menuItems.map(intervalSubmenu)
    });
  }

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

  Menu.buildFromTemplate(tpl).popup({ window: win });
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

/* ======================================================== 说话气泡
   气泡用「独立的小透明窗」实现，不再和宠物挤在同一个窗口里。

   为什么这么做：以前气泡是塞在宠物窗里的，说话时得把宠物窗移动+放大，
   而「窗口几何」和「网页内容」分属主进程与渲染进程，两者永远有先后差 ——
   那一瞬间就会看到宠物/气泡闪到别的位置。改成独立窗口后，
   宠物窗在整个说话过程中尺寸位置一动不动，这类闪烁从根上就没有了。 */

const BUBBLE_W = 340, BUBBLE_H = 176, BUBBLE_GAP = 10, BUBBLE_PAD = 10;
let bubbleWin = null;

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
   气泡比宠物宽，所以优先「并排」——并排时横向就不相交，纵向怎么放都压不到宠物。 */
function placeBubble(petX, petY, petW, petH, preferSide, wa) {
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

  /* 纵向默认在宠物上方；宠物贴顶时会被夹到屏幕顶部，自动变成「左边 / 右边」 */
  let by = petY - BUBBLE_GAP - BUBBLE_H;
  by = Math.max(limT, Math.min(by, limB - BUBBLE_H));

  /* 并排时横向本来就不相交；万一夹取后压住了宠物，就整块挪到上方或下方 */
  const overlapX = !(bx + BUBBLE_W <= petX || bx >= petX + petW);
  if (overlapX) {
    const above = petY - BUBBLE_GAP - BUBBLE_H;
    const below = petY + petH + BUBBLE_GAP;
    if (above >= limT) by = above;
    else if (below + BUBBLE_H <= limB) by = below;
    else by = Math.max(limT, Math.min(above, limB - BUBBLE_H));
  }

  /* 小尾巴朝哪边：始终指向宠物 */
  const cl = (v, a, b) => Math.max(a, Math.min(b, v));
  let tail, tailPos;
  if (bx >= petX + petW) {
    tail = 'left';
    tailPos = cl(petY + petH / 2 - by, 16, BUBBLE_H - 16);
  } else if (bx + BUBBLE_W <= petX) {
    tail = 'right';
    tailPos = cl(petY + petH / 2 - by, 16, BUBBLE_H - 16);
  } else if (by + BUBBLE_H <= petY) {
    tail = 'bottom';
    tailPos = cl(petX + petW / 2 - bx, 16, BUBBLE_W - 16);
  } else {
    tail = 'top';
    tailPos = cl(petX + petW / 2 - bx, 16, BUBBLE_W - 16);
  }

  return { x: Math.round(bx), y: Math.round(by), tail: tail, tailPos: Math.round(tailPos) };
}

function ensureBubbleWin() {
  if (bubbleWin && !bubbleWin.isDestroyed()) return bubbleWin;
  bubbleWin = new BrowserWindow({
    width: BUBBLE_W + BUBBLE_PAD * 2,
    height: BUBBLE_H + BUBBLE_PAD * 2,
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
  const disp = talkDisplay(b.x + b.width / 2, b.y + b.height / 2);
  const p = placeBubble(b.x, b.y, b.width, b.height,
    data && data.side === 'left' ? 'left' : 'right', disp.workArea);

  bw.setBounds({
    x: p.x - BUBBLE_PAD,
    y: p.y - BUBBLE_PAD,
    width: BUBBLE_W + BUBBLE_PAD * 2,
    height: BUBBLE_H + BUBBLE_PAD * 2
  });

  const payload = {
    head: (data && data.head) || '',
    mer: (data && data.mer) || '',
    tip: (data && data.tip) || '',
    next: (data && data.next) || '',
    tail: p.tail,
    tailPos: p.tailPos
  };
  const push = function () {
    try { bw.webContents.send('bubble-data', payload); } catch (e) { /* 忽略 */ }
  };
  if (bw.webContents.isLoading()) bw.webContents.once('did-finish-load', push);
  else push();

  bw.showInactive();                          // 不激活、不抢焦点
  talkOpen = true;
  return true;
}

function hideBubble() {
  talkOpen = false;
  if (bubbleWin && !bubbleWin.isDestroyed() && bubbleWin.isVisible()) bubbleWin.hide();
}

/* 彻底销毁气泡窗（不只是隐藏）。
   一个隐藏的 BrowserWindow 仍然占着一整个渲染进程（约 50~120MB），
   退出宠物模式后根本用不到它，留着纯属浪费 —— 下次进宠物模式再重建。 */
function destroyBubble() {
  talkOpen = false;
  if (bubbleWin && !bubbleWin.isDestroyed()) {
    try { bubbleWin.destroy(); } catch (e) { /* 忽略 */ }
  }
  bubbleWin = null;
}

/* 渲染进程把文字发过来，主进程只管摆位置和显示 */
ipcMain.handle('pet-talk', (e, data) => {
  if (!win || !petMode) return false;
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

  /* 宠物被拖走了，「家」坐标也要跟着走。
     不更新的话，下次点宠物说话时会按进宠物模式时的旧坐标铺开，
     宠物就会自己跳回桌面右下角。 */
  if (petMode && petHome && win && !win.isDestroyed()) {
    const b = win.getBounds();
    petHome = { x: b.x, y: b.y, width: petHome.width, height: petHome.height };
  }
  dragState = null;
});

ipcMain.on('state', (e, s) => {
  if (!s) return;
  let changed = (timersRunning !== !!s.running) || (petMode !== !!s.petMode);
  timersRunning = !!s.running;
  if (typeof s.petMode === 'boolean' && s.petMode !== petMode) petMode = s.petMode;

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
  app.whenReady().then(() => { createWindow(); buildTray(); bindPowerEvents(); });
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => { /* 有托盘常驻，不退出 */ });
  app.on('activate', () => { if (!win) createWindow(); else showWindow(); });
}
