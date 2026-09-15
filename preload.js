/* 预加载脚本：把主进程能力以最小接口暴露给页面
   （contextIsolation 打开，页面拿不到 Node，只拿到这几个函数） */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kunkunNative', {
  isDesktop: true,
  alert: (kind) => ipcRenderer.invoke('alert', kind),
  dismiss: () => ipcRenderer.invoke('dismiss'),
  setPetMode: (on) => ipcRenderer.invoke('pet-mode', !!on),
  petTalk: (need) => ipcRenderer.invoke('pet-talk', need),
  petTalkEnd: () => ipcRenderer.invoke('pet-talk-end'),
  setPetSize: (name) => ipcRenderer.invoke('set-pet-size', name),
  getPetSize: () => ipcRenderer.invoke('get-pet-size'),
  minimize: () => ipcRenderer.invoke('minimize'),
  hideToTray: () => ipcRenderer.invoke('hide'),
  quit: () => ipcRenderer.invoke('quit'),

  /* 宠物模式 / 托盘 右键菜单 */
  petMenu: () => ipcRenderer.invoke('pet-menu'),

  /* 手动拖窗：标题栏和宠物模式都能拖着走 */
  dragStart: (pt) => ipcRenderer.send('drag-start', pt),
  dragMove: (pt) => ipcRenderer.send('drag-move', pt),
  dragEnd: () => ipcRenderer.send('drag-end'),

  /* 主进程 → 页面 */
  onTrayAlert: (cb) => ipcRenderer.on('tray-alert', (e, id) => cb(id)),
  onTrayToggle: (cb) => ipcRenderer.on('tray-toggle', () => cb()),
  onSetInterval: (cb) => ipcRenderer.on('set-interval', (e, d) => cb(d)),
  onPetModeChanged: (cb) => ipcRenderer.on('pet-mode-changed', (e, on) => cb(on)),
  onSetPetSize: (cb) => ipcRenderer.on('pet-size-changed', (e, name) => cb(name)),
  onShowShichen: (cb) => ipcRenderer.on('show-shichen', () => cb()),
  onAddItem: (cb) => ipcRenderer.on('add-item', () => cb()),
  onPower: (cb) => ipcRenderer.on('power', (e, kind) => cb(kind)),

  /* 页面 → 主进程：同步运行状态与提醒列表，用于刷新托盘菜单 */
  syncState: (state) => ipcRenderer.send('state', state)
});
