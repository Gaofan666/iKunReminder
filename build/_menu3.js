/* 临时：补上 app.js 的两处（上一版正则没匹配上） */
const fs = require('fs');
const log = [];
function patch(file, re, to, tag) {
  let s = fs.readFileSync(file, 'utf8');
  if (!re.test(s)) {
    if (s.includes(tag)) { log.push('  跳过（已应用）: ' + tag); return; }
    console.error('没找到: ' + file + ' -> ' + tag); process.exit(1);
  }
  fs.writeFileSync(file, s.replace(re, to), 'utf8');
  log.push('  已改: ' + tag);
}

/* 1) 主界面换形象时，同步给主进程（右键菜单才能打对勾） */
patch('app.js',
  /([ \t]*)loadSkin\(settings\.skin\);(\r?\n)([ \t]*\}\);)/,
  `$1loadSkin(settings.skin);$2$1if (native && native.skinChanged) native.skinChanged(settings.skin);$2$3`,
  'native.skinChanged(settings.skin)');

/* 2) 监听右键菜单发来的换形象指令 */
patch('app.js',
  /([ \t]*)(if \(native && native\.onWinVisible\) native\.onWinVisible\(applyVisibility\);)/,
  `$1$2$1/* 宠物模式右键菜单里换形象 */$1if (native && native.onSetSkin) {$1  native.onSetSkin(function (id) {$1    settings.skin = id || '__default';$1    saveSettings();$1    if (el.skinSel) el.skinSel.value = settings.skin;$1    loadSkin(settings.skin);$1  });$1}`,
  'native.onSetSkin');

console.log(log.join('\n'));
