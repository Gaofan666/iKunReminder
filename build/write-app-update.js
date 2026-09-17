/* 生成 dist/win-unpacked/resources/app-update.yml
 * —— electron-updater 就是靠这个文件知道「去哪查新版本」的。
 *
 * 为什么要自己写：
 *   electron-builder 只在 afterPack 钩子里写它，而且要求当时的打包目标里有 nsis
 *   （见 app-builder-lib/out/publish/PublishManager.js 的 isSuitableWindowsTarget()，
 *    它只认 nsis / nsis-*）。而我们的构建是两步走：
 *      ① electron-builder --win dir            目标是 dir，不写
 *      ② node build/patch-icon.js              换图标
 *      ③ electron-builder --win nsis --prepackaged
 *         --prepackaged 完全跳过打包阶段，afterPack 根本不执行
 *   结果就是 app-update.yml 永远不生成 —— 打出来的版本找不到更新源，自动更新直接失效。
 *
 * 字段跟 electron-builder 自己写的保持一致（getAppUpdatePublishConfiguration()）：
 *   provider / owner / repo 来自 package.json 的 build.publish；
 *   updaterCacheDirName 用 electron-builder 的 AppInfo 现算
 *   （= package.json 的 name 小写 + "-updater"）。
 *   ⚠️ 这个值必须和 NSIS 安装器里烘进去的 APP_PACKAGE_STORE_FILE 一模一样，
 *      差分更新才对得上，所以不手写死、从 electron-builder 源码要。
 *
 * 用法（package.json 的 build 脚本已经串好了）：
 *   electron-builder --win dir → patch-icon.js → write-app-update.js → electron-builder --prepackaged
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const pub = (pkg.build && pkg.build.publish) || null;

if (!pub || !pub.provider) {
  console.error('[app-update] package.json 里没配 build.publish，跳过（自动更新会不可用）');
  process.exit(0);
}

/* updaterCacheDirName：优先找 electron-builder 现算，拿不到就用等价兜底 */
let cacheDir = String(pkg.name || pkg.build.productName || 'app').toLowerCase() + '-updater';
try {
  const { AppInfo } = require('app-builder-lib/out/appInfo');
  const ai = new AppInfo({ metadata: pkg, config: pkg.build || {} }, null);
  if (ai.updaterCacheDirName) cacheDir = ai.updaterCacheDirName;
} catch (e) {
  console.warn('[app-update] 取 AppInfo 失败（' + e.message + '），用兜底值 ' + cacheDir);
}

const lines = ['provider: ' + pub.provider];
if (pub.owner) lines.push('owner: ' + pub.owner);
if (pub.repo) lines.push('repo: ' + pub.repo);
if (pub.channel) lines.push('channel: ' + pub.channel);
if (pub.private === true) lines.push('private: true');
lines.push('updaterCacheDirName: ' + cacheDir);

const outDir = path.join(root, 'dist', 'win-unpacked', 'resources');
if (!fs.existsSync(path.join(root, 'dist', 'win-unpacked'))) {
  console.error('[app-update] 找不到 dist/win-unpacked，请先跑 electron-builder --win dir');
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'app-update.yml');
fs.writeFileSync(out, lines.join('\n') + '\n', 'utf8');

console.log('[app-update] 已写入 ' + path.relative(root, out) + '：');
lines.forEach(function (l) { console.log('             ' + l); });
