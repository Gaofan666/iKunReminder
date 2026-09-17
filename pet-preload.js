/* =========================================================================
   桌面宠物窗的预加载脚本：只暴露「这只宠物需要的能力」这一小组接口。
   主窗口那套提醒/统计/待办一概不给 —— 宠物窗只负责画自己、被拖动、报个到。
   ========================================================================= */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kunkunPetWindow', {
  /* 本窗自己所在那块屏的缩放信息（算法见 ui-scale.js） */
  getUiScale: () => ipcRenderer.invoke('pet-win-get-scale'),
  onDisplayInfo: (cb) => ipcRenderer.on('pet-win-display', (e, d) => cb(d)),

  /* 拖动：整窗都能拖，位置由主进程算（和主界面同一套限位逻辑） */
  dragStart: (pt) => ipcRenderer.send('pet-win-drag-start', pt),
  dragMove: (pt) => ipcRenderer.send('pet-win-drag-move', pt),
  dragEnd: () => ipcRenderer.send('pet-win-drag-end'),

  /* 右键 → 原生菜单（换形象 / 换大小 / 显示主界面 / 隐藏宠物 / 退出） */
  menu: () => ipcRenderer.invoke('pet-win-menu'),

  /* 单击宠物 = 说话：内容（时辰 / 下次提醒）由主进程组装；
     再点一次 = 收起气泡；开始拖动 = 收起气泡。都由主进程判断当前状态。 */
  talk: () => ipcRenderer.invoke('pet-win-talk'),
  hideTalk: () => ipcRenderer.send('pet-win-talk-hide'),

  /* 主进程 → 宠物窗 */
  onSkin: (cb) => ipcRenderer.on('pet-win-skin', (e, id) => cb(id)),
  onSize: (cb) => ipcRenderer.on('pet-win-size', (e, name) => cb(name)),
  onMood: (cb) => ipcRenderer.on('pet-win-mood', (e, m) => cb(m)),
  onTalk: (cb) => ipcRenderer.on('pet-win-talk', (e, data) => cb(data)),
  onVisibility: (cb) => ipcRenderer.on('pet-win-visible', (e, v) => cb(v)),
  onSound: (cb) => ipcRenderer.on('pet-win-sound', (e, on) => cb(on)),
  onWake: (cb) => ipcRenderer.on('pet-win-wake', () => cb()),

  /* 宠物窗 → 主进程 */
  skinChanged: (id) => ipcRenderer.send('skin-changed', id),
  skinList: () => ipcRenderer.invoke('skins-list'),
  skinLoad: (id) => ipcRenderer.invoke('skin-load', id),
  ready: () => ipcRenderer.send('pet-win-ready')
});
