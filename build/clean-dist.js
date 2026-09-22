/* 清理 dist 里旧版本的安装包：只留最新 N 个版本（默认 2），省磁盘。
   跑法：
     node build/clean-dist.js              只看会删什么（不删）
     node build/clean-dist.js --yes        真删
     node build/clean-dist.js --yes 3      保留最新 3 个

   ⚠️ 只认 iKunReminder-setup-vX.Y.Z.exe 和它的 .blockmap，
      绝不碰 win-unpacked（用户拿它测试）、gitee-parts（Gitee 分卷）、latest.yml。
   ⚠️ 删掉的旧安装包在 GitHub Release 上都还有，随时能下回来。 */
const fs = require('fs');
const path = require('path');

const DIST = path.join(__dirname, '..', 'dist');
const argv = process.argv.slice(2);
const DO_IT = argv.includes('--yes');
const keepArg = argv.filter(function (a) { return /^\d+$/.test(a); })[0];
const KEEP = Math.max(1, parseInt(keepArg || '2', 10));

/* v3.2.10 > v3.2.9，不能按字符串比 */
function verKey(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  return m ? (+m[1]) * 1000000 + (+m[2]) * 1000 + (+m[3]) : -1;
}

if (!fs.existsSync(DIST)) { console.log('没有 dist 目录，跳过。'); process.exit(0); }

/* 收集所有版本安装包：{ver -> [文件...]} */
const byVer = {};
fs.readdirSync(DIST).forEach(function (name) {
  const m = /^iKunReminder-setup-v(\d+\.\d+\.\d+)\.exe(\.blockmap)?$/.exec(name);
  if (!m) return;                       // 其它文件一律不碰
  (byVer[m[1]] = byVer[m[1]] || []).push(name);
});

const vers = Object.keys(byVer).sort(function (a, b) { return verKey(b) - verKey(a); });
if (!vers.length) { console.log('dist 里没有版本安装包。'); process.exit(0); }

const keep = vers.slice(0, KEEP);
const drop = vers.slice(KEEP);
console.log('dist 里共 ' + vers.length + ' 个版本，保留最新 ' + KEEP + ' 个：' + keep.map(function (v) { return 'v' + v; }).join('、'));
if (!drop.length) { console.log('没有要删的。'); process.exit(0); }

let freed = 0;
drop.forEach(function (v) {
  byVer[v].forEach(function (name) {
    const p = path.join(DIST, name);
    let size = 0;
    try { size = fs.statSync(p).size; } catch (e) { }
    console.log('  ' + (DO_IT ? '删 ' : '会删 ') + name + '  ' + (size / 1048576).toFixed(1) + ' MB');
    freed += size;
    if (DO_IT) { try { fs.rmSync(p, { force: true }); } catch (e) { console.log('    ⚠️ ' + e.message); } }
  });
});
console.log('----');
console.log((DO_IT ? '已释放 ' : '可释放 ') + (freed / 1048576).toFixed(1) + ' MB' +
  (DO_IT ? '' : '（预览模式，加 --yes 才真删）'));
