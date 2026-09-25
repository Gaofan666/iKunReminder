/* 预加载脚本：把主进程能力以最小接口暴露给页面
   （contextIsolation 打开，页面拿不到 Node，只拿到这几个函数） */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kunkunNative', {
  isDesktop: true,
  alert: (kind) => ipcRenderer.invoke('alert', kind),
  dismiss: () => ipcRenderer.invoke('dismiss'),

  /* 桌面宠物：一个独立小窗，可以和主界面同时显示 */
  setPetOn: (on) => ipcRenderer.invoke('pet-on', !!on),
  getPetOn: () => ipcRenderer.invoke('pet-on-get'),
  setPetSize: (name) => ipcRenderer.invoke('set-pet-size', name),
  getPetSize: () => ipcRenderer.invoke('get-pet-size'),

  /* 桌面日历：另一个独立小窗（透明月历挂件：左备忘录 + 右月历）。
     待办/备忘录的真数据在页面这边，所以是页面把清单推给主进程，
     主进程缓存后转发给日历窗；日历窗里勾「完成」再顺着同一条链路回来改数据。 */
  setCalOn: (on) => ipcRenderer.invoke('cal-on', !!on),
  getCalOn: () => ipcRenderer.invoke('cal-on-get'),
  calTodos: (list) => ipcRenderer.send('cal-todos', list),
  calMemos: (list) => ipcRenderer.send('cal-memos', list),
  /* 主题 + 卡片不透明度（设置页里调，主进程转发给日历窗） */
  calStyle: (st) => ipcRenderer.send('cal-style', st),
  onCalOnChanged: (cb) => ipcRenderer.on('cal-on-changed', (e, on) => cb(on)),
  onCalToggleTodo: (cb) => ipcRenderer.on('cal-toggle-todo', (e, id) => cb(id)),
  onCalToggleMemo: (cb) => ipcRenderer.on('cal-toggle-memo', (e, id) => cb(id)),
  onCalAddMemo: (cb) => ipcRenderer.on('cal-add-memo', (e, text) => cb(text)),
  /* 日历当天清单里的 ✏️ 编辑 / 🗑 删除 */
  onCalEditTodo: (cb) => ipcRenderer.on('cal-edit-todo', (e, id) => cb(id)),
  onCalDeleteTodo: (cb) => ipcRenderer.on('cal-delete-todo', (e, id) => cb(id)),
  onCalToggleTheme: (cb) => ipcRenderer.on('cal-toggle-theme', () => cb()),
  onCalZoom: (cb) => ipcRenderer.on('cal-zoom', (e, scale) => cb(scale)),
  onCalToggleLock: (cb) => ipcRenderer.on('cal-toggle-lock', () => cb()),
  onCalAddTodo: (cb) => ipcRenderer.on('cal-add-todo', () => cb()),
  /* 宠物点了说话 → 主进程来要文字，页面用 petTalkData 回过去 */
  onPetTalkRequest: (cb) => ipcRenderer.on('pet-talk-request', () => cb()),
  petTalkData: (data) => ipcRenderer.send('pet-talk-data', data),
  petTalk: (need) => ipcRenderer.invoke('pet-talk', need),
  petTalkEnd: () => ipcRenderer.invoke('pet-talk-end'),

  /* 开机自启动（写 HKCU 的 Run 键） */
  getAutoLaunch: () => ipcRenderer.invoke('get-auto-launch'),
  setAutoLaunch: (on) => ipcRenderer.invoke('set-auto-launch', !!on),

  /* 护眼模式：把显示器色温调暖（改显卡伽马表）。状态由主进程持有，
     页面只负责读出来画勾、点了之后告诉主进程去调。 */
  eyeCareGet: () => ipcRenderer.invoke('eye-care-get'),
  eyeCareSet: (on) => ipcRenderer.invoke('eye-care-set', !!on),
  /* 拖色温滑杆：主进程那边一律按「打开」处理（拖了就是想看效果） */
  eyeCareSetKelvin: (k) => ipcRenderer.invoke('eye-care-set-kelvin', Number(k)),
  /* 「退出程序时是否把色温还原」——纯偏好，不动当前色温 */
  eyeCareSetRestoreOnQuit: (on) => ipcRenderer.invoke('eye-care-set-restore-on-quit', !!on),
  onEyeCareChanged: (cb) => ipcRenderer.on('eye-care-changed', (e, s) => cb(s)),

  /* 软件更新：只检查、只提示。下载和安装都必须由用户点，
     主进程侧 autoDownload / autoInstallOnAppQuit 都是关的。 */
  updateGetState: () => ipcRenderer.invoke('update-get-state'),
  updateCheck: () => ipcRenderer.invoke('update-check'),
  updateDownload: () => ipcRenderer.invoke('update-download'),
  updateInstall: () => ipcRenderer.invoke('update-install'),
  updateSetAutoCheck: (on) => ipcRenderer.invoke('update-set-auto-check', !!on),
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (e, s) => cb(s)),
  onUpdateInstalling: (cb) => ipcRenderer.on('update-installing', () => cb()),

  /* 一键摸鱼（老板键）：全局快捷键按一下 → 主窗口收进托盘，再按一下恢复。
     桌面宠物不受影响，提醒也照常。快捷键由用户自己在设置页录。 */
  /* 一键摸鱼（老板键）：只由全局快捷键触发，没有按钮。
     按一次 → 收起桌面所有窗口 + 自动打开指定的程序/文档；再按一次 → 全部还原。 */
  moyuGet: () => ipcRenderer.invoke('moyu-get'),
  moyuSet: (cfg) => ipcRenderer.invoke('moyu-set', cfg),
  moyuReset: () => ipcRenderer.invoke('moyu-reset'),
  moyuSuspend: (on) => ipcRenderer.invoke('moyu-suspend', !!on),
  moyuPick: () => ipcRenderer.invoke('moyu-pick'),
  moyuClearTarget: () => ipcRenderer.invoke('moyu-clear-target'),
  onMoyuChanged: (cb) => ipcRenderer.on('moyu-changed', (e, s) => cb(s)),

  minimize: () => ipcRenderer.invoke('minimize'),
  hideToTray: () => ipcRenderer.invoke('hide'),
  showWindow: () => ipcRenderer.invoke('show-window'),
  openDataDir: () => ipcRenderer.invoke('open-data-dir'),
  /* 选自定义提醒音乐：只回一个路径，取消=空串 */
  pickMusic: () => ipcRenderer.invoke('pick-music'),
  /* 日记导出：文本由页面拼好，主进程弹「另存为」写文件，返回路径（取消=空串） */
  diaryExport: (text, suggested) => ipcRenderer.invoke('diary-export', String(text || ''), suggested),
  quit: () => ipcRenderer.invoke('quit'),

  /* 手动拖窗（主界面标题栏） */
  dragStart: (pt) => ipcRenderer.send('drag-start', pt),
  dragMove: (pt) => ipcRenderer.send('drag-move', pt),
  dragEnd: () => ipcRenderer.send('drag-end'),

  /* 主进程 → 页面 */
  onTrayAlert: (cb) => ipcRenderer.on('tray-alert', (e, id) => cb(id)),
  onTrayToggle: (cb) => ipcRenderer.on('tray-toggle', () => cb()),
  onSetInterval: (cb) => ipcRenderer.on('set-interval', (e, d) => cb(d)),
  onPetOnChanged: (cb) => ipcRenderer.on('pet-on-changed', (e, on) => cb(on)),
  onSetPetSize: (cb) => ipcRenderer.on('pet-size-changed', (e, name) => cb(name)),
  onShowShichen: (cb) => ipcRenderer.on('show-shichen', () => cb()),
  onAddItem: (cb) => ipcRenderer.on('add-item', () => cb()),
  onShowTodo: (cb) => ipcRenderer.on('show-todo', () => cb()),
  onShowDiary: (cb) => ipcRenderer.on('show-diary', () => cb()),
  onShowSettings: (cb) => ipcRenderer.on('show-settings', () => cb()),
  onPower: (cb) => ipcRenderer.on('power', (e, kind) => cb(kind)),
  onWinVisible: (cb) => ipcRenderer.on('win-visible', (e, vis) => cb(vis)),

  /* 皮肤：列出可选皮肤 / 载入某个皮肤的精灵图（主进程读文件，页面不碰磁盘） */
  onSetSkin: (cb) => ipcRenderer.on('set-skin', (e, id) => cb(id)),
  skinChanged: (id) => ipcRenderer.send('skin-changed', id),
  skinsList: () => ipcRenderer.invoke('skins-list'),
  skinLoad: (id) => ipcRenderer.invoke('skin-load', id),
  /* 用户皮肤文件夹：拿到路径 / 直接打开它（目录和说明文档会自动建好） */
  skinsDir: () => ipcRenderer.invoke('skins-dir'),
  openSkinsDir: () => ipcRenderer.invoke('open-skins-dir'),

  /* 屏幕缩放（DPI）：启动时取一次，之后由主进程在换屏/改缩放时推送。
     窗口逻辑尺寸由主进程负责，页面只拿 scale 去算内容缩放，两边不会打架。 */
  getUiScale: () => ipcRenderer.invoke('get-ui-scale'),
  onDisplayInfo: (cb) => ipcRenderer.on('display-info', (e, d) => cb(d)),

  /* 页面 → 主进程：同步运行状态与提醒列表，用于刷新托盘菜单 */
  syncState: (state) => ipcRenderer.send('state', state),

  /* ---------------------------------------------------------- 科研动态（arXiv）
     抓取、解析、存库全在主进程；页面只拿状态、列表，点按钮触发抓取。 */
  arxivState: () => ipcRenderer.invoke('arxiv-state'),
  arxivSetConfig: (patch) => ipcRenderer.invoke('arxiv-set-config', patch || {}),
  arxivFetchNow: () => ipcRenderer.invoke('arxiv-fetch-now'),
  arxivList: (opts) => ipcRenderer.invoke('arxiv-list', opts || {}),
  arxivMarkRead: (id) => ipcRenderer.invoke('arxiv-mark-read', String(id || '')),
  arxivMarkAllRead: () => ipcRenderer.invoke('arxiv-mark-all-read'),
  arxivStar: (id, on) => ipcRenderer.invoke('arxiv-star', String(id || ''), !!on),
  arxivScore: (id, n) => ipcRenderer.invoke('arxiv-score', String(id || ''), Number(n) || 0),
  arxivRemove: (id) => ipcRenderer.invoke('arxiv-remove', String(id || '')),
  /* 评论：读 / 写 / 改 / 删 */
  arxivComments: (id) => ipcRenderer.invoke('arxiv-comments', String(id || '')),
  arxivCommentAdd: (id, text) => ipcRenderer.invoke('arxiv-comment-add', String(id || ''), String(text || '')),
  arxivCommentUpdate: (cid, text) => ipcRenderer.invoke('arxiv-comment-update', cid, String(text || '')),
  arxivCommentDelete: (cid) => ipcRenderer.invoke('arxiv-comment-delete', cid),
  arxivClear: () => ipcRenderer.invoke('arxiv-clear'),
  arxivHiddenCount: () => ipcRenderer.invoke('arxiv-hidden-count'),
  arxivHiddenClear: () => ipcRenderer.invoke('arxiv-hidden-clear'),
  arxivOpen: (url) => ipcRenderer.invoke('arxiv-open', String(url || '')),
  onArxivState: (cb) => ipcRenderer.on('arxiv-state', (e, s) => cb(s)),
  onShowArxiv: (cb) => ipcRenderer.on('show-arxiv', () => cb())
});
