/* 气泡窗的预加载脚本：收内容 + （可点时）把点击回报给主进程。
   「科研动态」的推送气泡是可点的，普通的说话气泡不接鼠标事件（穿透过去）。 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petBubble', {
  onData: (cb) => ipcRenderer.on('bubble-data', (e, d) => cb(d)),
  clicked: () => ipcRenderer.send('bubble-clicked')
});
