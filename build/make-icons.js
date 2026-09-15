/* 生成三套图标：
     icon.png       256×256  窗口 / 任务栏
     tray.png        32×32   系统托盘
     build/icon.ico  多尺寸   安装包 / 桌面快捷方式
   头像是用户自己抠出来的（build/avatar.png），这里去白底、裁留白、放大后合成。 */
const { app, BrowserWindow, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
app.on('window-all-closed', () => { });

/* 多尺寸 ICO：每张图都用 PNG 内嵌（Vista+ 支持） */
function buildIco(images) {
  const n = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(n, 4);

  const dir = Buffer.alloc(16 * n);
  let offset = 6 + 16 * n;
  images.forEach((im, i) => {
    const o = i * 16;
    dir.writeUInt8(im.size >= 256 ? 0 : im.size, o);
    dir.writeUInt8(im.size >= 256 ? 0 : im.size, o + 1);
    dir.writeUInt8(0, o + 2);          // 调色板
    dir.writeUInt8(0, o + 3);          // reserved
    dir.writeUInt16LE(1, o + 4);       // planes
    dir.writeUInt16LE(32, o + 6);      // bpp
    dir.writeUInt32LE(im.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += im.png.length;
  });

  return Buffer.concat([header, dir].concat(images.map(im => im.png)));
}

app.whenReady().then(async () => {
  try {
    /* 必须开 transparent，否则 capturePage 抓出来是不透明的，
       头像周围就会带上一块白底 */
    const w = new BrowserWindow({
      width: 256, height: 256, useContentSize: true,
      show: false, frame: false, resizable: false,
      transparent: true, backgroundColor: '#00000000',
      hasShadow: false
    });
    await w.loadFile(path.join(__dirname, 'icon-src.html'));
    await sleep(1600);
    const shot = await w.webContents.capturePage();
    w.destroy();

    const base = shot.resize({ width: 256, height: 256, quality: 'best' });
    fs.writeFileSync(path.join(root, 'icon.png'), base.toPNG());
    console.log('icon.png   256×256');

    const tray = base.resize({ width: 32, height: 32, quality: 'best' });
    fs.writeFileSync(path.join(root, 'tray.png'), tray.toPNG());
    console.log('tray.png    32×32');

    const sizes = [16, 24, 32, 48, 64, 128, 256];
    const imgs = sizes.map(function (s) {
      return { size: s, png: base.resize({ width: s, height: s, quality: 'best' }).toPNG() };
    });
    fs.writeFileSync(path.join(__dirname, 'icon.ico'), buildIco(imgs));
    console.log('build/icon.ico  ' + sizes.join('/'));

    /* 顺手存一张 128 预览，方便肉眼核对 */
    fs.writeFileSync(path.join(__dirname, '_preview.png'),
      base.resize({ width: 128, height: 128, quality: 'best' }).toPNG());
    fs.writeFileSync(path.join(__dirname, '_preview32.png'), tray.toPNG());
  } catch (err) {
    fs.writeFileSync(path.join(__dirname, '_iconerr.txt'), String(err && err.stack || err), 'utf8');
  }
  app.exit(0);
});
