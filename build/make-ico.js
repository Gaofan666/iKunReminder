/* 由 icon.png 生成 build/icon.ico（单张 256×256，PNG 内嵌格式，Vista+ 支持）
   用途：安装时用它给快捷方式指定图标 —— 被安装的 exe 本身没有图标资源
   （rcedit 需要 winCodeSign，而那个包在当前权限下解压不了）。 */
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'icon.png');
const out = path.join(__dirname, 'icon.ico');

const png = fs.readFileSync(src);

// ICONDIR
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);   // reserved
header.writeUInt16LE(1, 2);   // type: 1 = icon
header.writeUInt16LE(1, 4);   // 图像数量

// ICONDIRENTRY (16 字节)
const entry = Buffer.alloc(16);
entry.writeUInt8(0, 0);        // 宽 0 表示 256
entry.writeUInt8(0, 1);        // 高 0 表示 256
entry.writeUInt8(0, 2);        // 调色板数
entry.writeUInt8(0, 3);        // reserved
entry.writeUInt16LE(1, 4);     // color planes
entry.writeUInt16LE(32, 6);    // bits per pixel
entry.writeUInt32LE(png.length, 8);   // 数据长度
entry.writeUInt32LE(22, 12);          // 数据偏移 = 6 + 16

fs.writeFileSync(out, Buffer.concat([header, entry, png]));
console.log('已生成 ' + out + '  (' + (6 + 16 + png.length) + ' 字节, 来自 ' + path.basename(src) + ')');
