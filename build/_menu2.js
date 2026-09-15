/* 临时（幂等版）：给宠物右键菜单加「宠物形象」子菜单。
   上一版因为文件是 CRLF 换行、多行字符串用 LF 匹配而失败。 */
const fs = require('fs');
const log = [];
function patch(file, re, to, tag) {
  let s = fs.readFileSync(file, 'utf8');
  if (!re.test(s)) {
    if (s.includes(tag)) { log.push('  跳过（已应用）: ' + tag); return; }
    console.error('没找到: ' + file + ' -> ' + tag);
    process.exit(1);
  }
  fs.writeFileSync(file, s.replace(re, to), 'utf8');
  log.push('  已改: ' + tag);
}

/* ---- main.js：当前形象 + 子菜单函数 ---- */
patch('main.js',
  /ipcMain\.handle\('pet-menu', \(\) => \{/,
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

ipcMain.handle('pet-menu', () => {`,
  "let currentSkin = '__default';");

/* ---- main.js：在「宠物大小」之前插入子菜单 ---- */
patch('main.js',
  /(\r?\n)([ \t]*)tpl\.push\(\{\r?\n[ \t]*label: '宠物大小',/,
  `$1$2tpl.push({ label: '宠物形象', submenu: skinSubmenu() });$1$2tpl.push({$1$2  label: '宠物大小',`,
  "label: '宠物形象'");

/* ---- preload.js ---- */
patch('preload.js',
  /([ \t]*)skinsList: \(\) => ipcRenderer\.invoke\('skins-list'\),/,
  `$1onSetSkin: (cb) => ipcRenderer.on('set-skin', (e, id) => cb(id)),$1skinChanged: (id) => ipcRenderer.send('skin-changed', id),$1skinsList: () => ipcRenderer.invoke('skins-list'),`,
  "onSetSkin");

/* ---- app.js：主界面换形象时同步给主进程 ---- */
patch('app.js',
  /([ \t]*)loadSkin\(settings\.skin\);(\r?\n)([ \t]*)\}\r?\n([ \t]*)\}\r?\n\r?\n([ \t]*)el\.alertDone/,
  `$1loadSkin(settings.skin);$2$1if (native && native.skinChanged) native.skinChanged(settings.skin);$2$3}$2$4}$2$2$5el.alertDone`,
  "native.skinChanged(settings.skin)");

/* ---- app.js：监听菜单发来的换形象 ---- */
patch('app.js',
  /([ \t]*)if \(native && native\.onWinVisible\) native\.onWinVisible\(applyVisibility\);/,
  `$1if (native && native.onWinVisible) native.onWinVisible(applyVisibility);$1/* 宠物模式右键菜单里换形象 */$1if (native && native.onSetSkin) {$1  native.onSetSkin(function (id) {$1    settings.skin = id || '__default';$1    saveSettings();$1    if (el.skinSel) el.skinSel.value = settings.skin;$1    loadSkin(settings.skin);$1  });$1}`,
  "native.onSetSkin");

console.log(log.join('\n'));
