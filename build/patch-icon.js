/* 给打包出来的 exe 换上我们的图标 + 版本信息。
 *
 * 为什么要自己动手：electron-builder 内置的 rcedit 流程依赖 winCodeSign-2.6.0.7z，
 * 那个包里有两个 macOS 符号链接（darwin/10.12/lib/libcrypto.dylib 等），普通
 * Windows 账户没有创建符号链接的权限，解压必然失败（7-Zip exit 2），整条构建就断了。
 * 所以我们在 package.json 里关掉 signAndEditExecutable，改用这个脚本换图标。
 * 不换的话，任务栏和窗口会显示 Electron 的默认图标。
 *
 * 用法（package.json 里的 build 脚本已经串好了）：
 *   electron-builder --win dir  →  node build/patch-icon.js  →  electron-builder --prepackaged
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const appDir = path.join(root, 'dist', 'win-unpacked');
const ico = path.join(__dirname, 'icon.ico');

function findExe() {
  if (!fs.existsSync(appDir)) return null;
  const list = fs.readdirSync(appDir).filter(function (f) {
    return /\.exe$/i.test(f) && !/^uninstall/i.test(f);
  });
  return list.length ? path.join(appDir, list[0]) : null;
}

function search(dir, name, depth) {
  if (depth > 4) return null;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return null; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name === name) return p;
    if (e.isDirectory()) {
      const hit = search(p, name, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

function findRcedit() {
  const vendored = path.join(__dirname, 'tools', 'rcedit-x64.exe');
  if (fs.existsSync(vendored)) return vendored;
  const roots = [
    process.env.ELECTRON_BUILDER_CACHE,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache') : null
  ].filter(Boolean);
  for (const r of roots) {
    if (!fs.existsSync(r)) continue;
    const hit = search(r, 'rcedit-x64.exe', 0);
    if (hit) return hit;
  }
  return null;
}

const exe = findExe();
if (!exe) {
  console.error('[patch-icon] 找不到 dist/win-unpacked 里的 exe，请先跑 electron-builder --win dir');
  process.exit(1);
}
const rcedit = findRcedit();
if (!rcedit) {
  console.error('[patch-icon] 找不到 rcedit-x64.exe');
  process.exit(1);
}
if (!fs.existsSync(ico)) {
  console.error('[patch-icon] 找不到 build/icon.ico');
  process.exit(1);
}

const pkg = require(path.join(root, 'package.json'));

execFileSync(rcedit, [
  exe,
  '--set-icon', ico,
  '--set-version-string', 'ProductName', pkg.build.productName,
  '--set-version-string', 'FileDescription', pkg.description || pkg.build.productName,
  '--set-version-string', 'CompanyName', pkg.author || pkg.build.productName,
  '--set-file-version', pkg.version,
  '--set-product-version', pkg.version
], { stdio: 'inherit' });

console.log('[patch-icon] 已换图标和版本信息: ' + path.basename(exe));
