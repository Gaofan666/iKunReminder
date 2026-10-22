#!/usr/bin/env node
/* 构建后校验：package.json build.files 白名单里的每个文件必须真的在
   dist/win-unpacked/resources/app.asar 里。
   背景：v4.7.6 新增 schol-sources.js 忘了加白名单，开发环境一切正常
   （有源文件），安装版里 require 直接抛 MODULE_NOT_FOUND，整个科研
   模块瘫痪 —— 用户看到的就是关键词空白、保存没反应。这道检查保证
   以后再漏文件时构建直接失败，而不是发出去一个坏安装包。 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const files = (pkg.build && pkg.build.files) || [];
const asar = path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar');

if (!fs.existsSync(asar)) {
  console.error('[check-asar] 找不到 ' + asar + '（先跑 dir 打包那一步）');
  process.exit(1);
}

let asarMod = null;
try { asarMod = require('@electron/asar'); } catch (e) { try { asarMod = require('asar'); } catch (e2) { } }
if (!asarMod || typeof asarMod.listPackage !== 'function') {
  console.error('[check-asar] 找不到 @electron/asar 模块，无法校验');
  process.exit(1);
}

let listing = [];
try {
  listing = asarMod.listPackage(asar);
} catch (e) {
  console.error('[check-asar] asar listPackage 失败：' + e.message);
  process.exit(1);
}
/* listPackage 的路径带前导反斜杠且是平台风格，统一成正斜杠再比 */
const inAsar = new Set(
  listing.map(function (s) { return String(s).replace(/\\/g, '/').replace(/^\//, ''); })
);

const missing = [];
for (const f of files) {
  /* 白名单里可能带目录（assets/music.mp3、skins 等），逐条查 */
  const norm = f.replace(/\\/g, '/');
  if (!inAsar.has(norm)) missing.push(f);
}

if (missing.length) {
  console.error('[check-asar] ❌ 以下白名单文件不在 app.asar 里（build.files 漏了或者没打包进去）：');
  missing.forEach(function (f) { console.error('   - ' + f); });
  process.exit(1);
}
console.log('[check-asar] ✅ 白名单 ' + files.length + ' 个文件全部在 app.asar 里');
