/* =========================================================================
   桌面日历窗的预加载脚本：只给这个窗口需要的一小组能力。
   日历窗不碰磁盘、不碰提醒，只做四件事：报「拖到哪了」、要待办/备忘录数据、
   勾完成（待办和备忘都走主进程回主界面改数据）、点 ＋/⚙ 把主界面叫出来。
   ========================================================================= */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kunkunCalWindow', {
  /* 页面画好了：主进程收到后把缓存里的待办/备忘录和窗口尺寸发过来 */
  ready: () => ipcRenderer.send('cal-ready'),

  /* 拖动（整张卡片都能拖，位置由主进程算，和宠物窗共用限位逻辑） */
  dragStart: (pt) => ipcRenderer.send('cal-win-drag-start', pt),
  dragMove: (pt) => ipcRenderer.send('cal-win-drag-move', pt),
  dragEnd: () => ipcRenderer.send('cal-win-drag-end'),

  /* 右键 → 原生菜单（上一月 / 今天 / 下一月 / 打开主界面 / 隐藏日历） */
  menu: () => ipcRenderer.invoke('cal-win-menu'),

  /* 右上角按钮：🌙/☀ 切主题 / ＋ 新增待办 / ⚙ 打开设置 / ✕ 隐藏日历 */
  toggleTheme: () => ipcRenderer.send('cal-toggle-theme-req'),
  addTodo: () => ipcRenderer.send('cal-add-todo'),
  openSettings: () => ipcRenderer.send('cal-open-settings'),
  hide: () => ipcRenderer.invoke('cal-hide'),

  /* 勾完成：待办和备忘都转给主界面改数据，改完连数据带状态一起推回来 */
  toggleTodo: (id) => ipcRenderer.send('cal-toggle-todo-req', String(id)),
  toggleMemo: (id) => ipcRenderer.send('cal-toggle-memo-req', String(id)),

  /* 当天清单里那两条：✏️ 编辑（打开主界面的修改弹窗）、🗑 删除（日历里已确认过） */
  editTodo: (id) => ipcRenderer.send('cal-edit-todo-req', String(id)),
  deleteTodo: (id) => ipcRenderer.send('cal-delete-todo-req', String(id)),

  /* 左栏 ＋：直接新增一条备忘（文字转给主界面写进同一份数据） */
  addMemo: (text) => ipcRenderer.send('cal-add-memo-req', String(text)),

  /* 主进程 → 日历窗 */
  onTodos: (cb) => ipcRenderer.on('cal-todos', (e, list) => cb(list)),
  onMemos: (cb) => ipcRenderer.on('cal-memos', (e, list) => cb(list)),
  onFit: (cb) => ipcRenderer.on('cal-fit', (e, box) => cb(box)),
  onStyle: (cb) => ipcRenderer.on('cal-style', (e, st) => cb(st)),
  onNav: (cb) => ipcRenderer.on('cal-nav', (e, dir) => cb(dir))
});
