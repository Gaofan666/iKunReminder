/* 临时：宠物模式右键菜单里加「宠物形象」子菜单，可以直接换形象 */
const fs = require('fs');
let n = 0;
function patch(file, from, to) {
  let s = fs.readFileSync(file, 'utf8');
  if (!s.includes(from)) { console.error('没找到: ' + file + '\n  -> ' + from.slice(0, 70)); process.exit(1); }
  fs.writeFileSync(file, s.split(from).join(to), 'utf8');
  n++;
}

/* ============ main.js ============ */
/* 记录当前形象（渲染进程会同步过来） */
patch('main.js',
  "ipcMain.handle('pet-menu', () => {",
  `let currentSkin = '__default';       // 当前宠物形象，右键菜单要拿它打勾

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

ipcMain.handle('pet-menu', () => {`);

/* 菜单里插入「宠物形象」 */
patch('main.js',
  `  tpl.push({
    label: '宠物大小',`,
  `  tpl.push({ label: '宠物形象', submenu: skinSubmenu() });
  tpl.push({
    label: '宠物大小',`);

/* ============ preload.js ============ */
patch('preload.js',
  "  skinsList: () => ipcRenderer.invoke('skins-list'),",
  `  onSetSkin: (cb) => ipcRenderer.on('set-skin', (e, id) => cb(id)),
  skinChanged: (id) => ipcRenderer.send('skin-changed', id),
  skinsList: () => ipcRenderer.invoke('skins-list'),`);

/* ============ app.js ============ */
/* 主界面切换形象时同步给主进程，右键菜单才能打对勾 */
patch('app.js',
  `        settings.skin = el.skinSel.value || '__default';
        saveSettings();
        Sound.click();
        loadSkin(settings.skin);`,
  `        settings.skin = el.skinSel.value || '__default';
        saveSettings();
        Sound.click();
        loadSkin(settings.skin);
        if (native && native.skinChanged) native.skinChanged(settings.skin);`);

/* 监听右键菜单发来的换形象指令 */
patch('app.js',
  "    if (native && native.onWinVisible) native.onWinVisible(applyVisibility);",
  `    if (native && native.onWinVisible) native.onWinVisible(applyVisibility);
    /* 宠物模式右键菜单里换形象 */
    if (native && native.onSetSkin) {
      native.onSetSkin(function (id) {
        settings.skin = id || '__default';
        saveSettings();
        if (el.skinSel) el.skinSel.value = settings.skin;
        loadSkin(settings.skin);
      });
    }`);

fs.writeFileSync('build/_skinlog.txt', 'ok', 'utf8');
console.log('已改 ' + n + ' 处，涉及 main.js / preload.js / app.js');
