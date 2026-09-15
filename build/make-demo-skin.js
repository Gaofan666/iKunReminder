/* 生成示例皮肤：skins/demo-bounce/sheet.png
   精灵图布局：3 行 × 6 列，每格 120×140
     row 0 = idle（4 帧）   row 1 = dance（6 帧）   row 2 = cheer（6 帧）
   这个示例本身也当模板用 —— 用户照着画自己的就行。 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'skins', 'demo-bounce');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
app.on('window-all-closed', () => { });

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;background:transparent;overflow:hidden}</style></head>
<body><canvas id="c" width="720" height="420"></canvas>
<script>
var FW = 120, FH = 140, COLS = 6;
var x = document.getElementById('c').getContext('2d');

/* 一个很简单的示例角色：圆身子 + 两只眼睛 + 头顶小天线，够说明格式就行 */
function drawOne(cx, cy, i, kind, n) {
  var p = i / n * Math.PI * 2;
  var bob = 0, squash = 1, tilt = 0, arm = 0;
  if (kind === 'idle') { bob = Math.sin(p) * 3; squash = 1 + Math.sin(p) * 0.03; }
  if (kind === 'dance') { bob = Math.abs(Math.sin(p)) * -14; tilt = Math.sin(p) * 0.18; arm = Math.sin(p) * 0.5; }
  if (kind === 'cheer') { bob = -6; squash = 1.05; arm = 1; }

  x.save();
  x.translate(cx, cy + bob);
  x.rotate(tilt);
  x.scale(0.82, 0.82);      // 整体留出余量：内容贴到格子边缘就会渗进相邻帧

  /* 影子固定在地面高度，不跟着 bob 走 —— 否则跳起来那几帧影子会被顶出格子 */
  x.globalAlpha = 0.18;
  x.fillStyle = '#1b2a33';
  x.beginPath(); x.ellipse(0, 48 - bob, 26, 7, 0, 0, Math.PI * 2); x.fill();
  x.globalAlpha = 1;

  /* 小短腿 */
  x.strokeStyle = '#2b3a44'; x.lineWidth = 7; x.lineCap = 'round';
  x.beginPath(); x.moveTo(-11, 30); x.lineTo(-13, 48); x.stroke();
  x.beginPath(); x.moveTo(11, 30); x.lineTo(13, 48); x.stroke();

  /* 身体 */
  x.save(); x.scale(1 / squash, squash);
  var g = x.createLinearGradient(0, -40, 0, 34);
  g.addColorStop(0, '#ffd86b'); g.addColorStop(1, '#f0a93c');
  x.fillStyle = g;
  x.beginPath(); x.moveTo(0, -40);
  x.bezierCurveTo(30, -40, 36, -6, 30, 16);
  x.bezierCurveTo(24, 36, -24, 36, -30, 16);
  x.bezierCurveTo(-36, -6, -30, -40, 0, -40);
  x.fill();
  x.strokeStyle = '#c8871f'; x.lineWidth = 2; x.stroke();
  x.restore();

  /* 天线。注意别画太高 —— 越出格子上边界就会渗到上一行去，
     在成品里表现为"上一行底部多出一个小红点"。 */
  x.strokeStyle = '#4a7c59'; x.lineWidth = 4;
  x.beginPath(); x.moveTo(0, -40); x.quadraticCurveTo(4, -52, 0, -58); x.stroke();
  x.fillStyle = '#e5484d';
  x.beginPath(); x.arc(0, -60, 5, 0, Math.PI * 2); x.fill();

  /* 眼睛 */
  x.fillStyle = '#fff';
  x.beginPath(); x.ellipse(-12, -8, 11, 12, 0, 0, Math.PI * 2); x.fill();
  x.beginPath(); x.ellipse(12, -8, 11, 12, 0, 0, Math.PI * 2); x.fill();
  x.fillStyle = '#22323c';
  var look = kind === 'cheer' ? 0 : Math.sin(p) * 2;
  x.beginPath(); x.arc(-12 + look, -6, 5, 0, Math.PI * 2); x.fill();
  x.beginPath(); x.arc(12 + look, -6, 5, 0, Math.PI * 2); x.fill();

  /* 嘴 */
  x.strokeStyle = '#b8631f'; x.lineWidth = 3; x.lineCap = 'round';
  x.beginPath();
  if (kind === 'cheer') x.arc(0, 8, 10, 0.1 * Math.PI, 0.9 * Math.PI);
  else x.arc(0, 4, 8, 0.15 * Math.PI, 0.85 * Math.PI);
  x.stroke();

  /* 手臂（跳舞/欢呼时举起来） */
  x.strokeStyle = '#f0a93c'; x.lineWidth = 8; x.lineCap = 'round';
  var a = -0.5 - arm * 1.6;
  x.beginPath(); x.moveTo(-28, 2); x.lineTo(-28 - Math.cos(a) * 20, 2 + Math.sin(a) * 20); x.stroke();
  x.beginPath(); x.moveTo(28, 2); x.lineTo(28 + Math.cos(a) * 20, 2 + Math.sin(a) * 20); x.stroke();

  x.restore();
}

function row(y, kind, n) {
  for (var i = 0; i < n; i++) drawOne(i * FW + FW / 2, y + FH / 2, i, kind, n);
}
x.clearRect(0, 0, 720, 420);
row(0, 'idle', 4);
row(FH, 'dance', 6);
row(FH * 2, 'cheer', 6);
document.title = 'ready';
</script></body></html>`;

app.whenReady().then(async () => {
  try {
    fs.mkdirSync(outDir, { recursive: true });
    /* 必须开透明窗口，否则 capturePage 抓出来是不透明的 ——
       精灵图会带上一块白底，贴到桌面上就是一块白砖。 */
    const w = new BrowserWindow({
      width: 720, height: 420, useContentSize: true, show: false, frame: false,
      transparent: true, backgroundColor: '#00000000', hasShadow: false
    });
    await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML));
    await sleep(1500);
    const shot = await w.webContents.capturePage();
    w.destroy();

    /* 精确缩放到 720×420 再存：这样 720/6=120、420/3=140 都能整除，
       帧和格子严丝合缝。直接存原始截图的话（比如 1.5 倍缩放下的 1082×632），
       行高是 210.67 这种小数，越往下越偏，会串到相邻帧。 */
    const img = shot.resize({ width: 720, height: 420, quality: 'best' });
    fs.writeFileSync(path.join(outDir, 'sheet.png'), img.toPNG());

    const fw = 720 / 6, fh = 420 / 3;

    fs.writeFileSync(path.join(outDir, 'skin.json'), JSON.stringify({
      name: '示例：跳跳球',
      author: '自带模板',
      frame: { w: fw, h: fh },
      fps: 10,
      sheet: 'sheet.png',
      animations: {
        idle: { row: 0, count: 4 },
        dance: { row: 1, count: 6 },
        cheer: { row: 2, count: 6 }
      }
    }, null, 2) + '\n', 'utf8');

    console.log('已生成 skins/demo-bounce/  精灵图 720x420   单帧 ' + fw + 'x' + fh);
  } catch (e) {
    fs.writeFileSync(path.join(__dirname, '_skinerr.txt'), String(e && e.stack || e), 'utf8');
  }
  app.exit(0);
});
