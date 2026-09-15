/* 气泡窗的预加载脚本：只暴露「收内容」这一个接口 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petBubble', {
  onData: (cb) => ipcRenderer.on('bubble-data', (e, d) => cb(d))
});
