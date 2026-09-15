/* 生成一批宠物皮肤到 skins/<id>/
   每个皮肤 = skin.json + sheet.png（6 列 × 3 行，单帧 120×140）
     row 0 = idle（4 帧）   row 1 = dance（6 帧）   row 2 = cheer（6 帧）
   画风刻意走"抽象"路线：形体简单、线条粗、表情夸张。
   生成完会自检：帧边界必须干净（内容不许贴到格子边缘，否则会渗进相邻帧）。 */
const { app, BrowserWindow, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const FW = 120, FH = 140, COLS = 6;
const TAU = Math.PI * 2;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
app.on('window-all-closed', () => { });

/* ============================================================ 公共零件 */
function shadow(ctx, y, w) {
  ctx.globalAlpha = 0.15; ctx.fillStyle = '#20303a';
  ctx.beginPath(); ctx.ellipse(0, y, w || 24, 6, 0, 0, TAU); ctx.fill();
  ctx.globalAlpha = 1;
}
function circle(ctx, x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill(); }
function oval(ctx, x, y, rx, ry, rot) {
  ctx.beginPath(); ctx.ellipse(x, y, rx, ry, rot || 0, 0, TAU); ctx.fill();
}
function eye(ctx, x, y, r, iris, look) {
  ctx.fillStyle = '#ffffff'; oval(ctx, x, y, r, r * 1.12, 0);
  ctx.strokeStyle = 'rgba(25,35,45,.22)'; ctx.lineWidth = 1; ctx.stroke();
  ctx.fillStyle = iris || '#22323c';
  circle(ctx, x + (look || 0), y + r * 0.1, r * 0.46);
  ctx.fillStyle = 'rgba(255,255,255,.9)';
  circle(ctx, x + (look || 0) - r * 0.18, y - r * 0.22, r * 0.16);
}
function limb(ctx, x0, y0, x1, y1, w, color) {
  ctx.strokeStyle = color; ctx.lineWidth = w; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
}
/* 三种状态的姿态：待机轻晃、跳舞弹跳、欢呼举手 */
function poseFor(kind, p) {
  const s = Math.sin(p * TAU);
  if (kind === 'idle') return { bob: s * 3, tilt: s * 0.03, squash: 1 + s * 0.03, arm: 0.12, open: 0 };
  if (kind === 'dance') return { bob: -Math.abs(Math.sin(p * TAU)) * 15, tilt: s * 0.17, squash: 1, arm: 0.75, open: 1 };
  return { bob: -7, tilt: 0, squash: 1.05, arm: 1, open: 2 };
}
/* 张嘴笑：open 0=微笑 1=大笑 2=欢呼 */
function mouth(ctx, x, y, w, open, color) {
  ctx.strokeStyle = color || '#8a4a12'; ctx.lineWidth = 2.6; ctx.lineCap = 'round';
  if (!open) { ctx.beginPath(); ctx.arc(x, y, w, 0.12 * Math.PI, 0.88 * Math.PI); ctx.stroke(); return; }
  ctx.fillStyle = '#5d2a20';
  ctx.beginPath();
  ctx.moveTo(x - w, y - w * 0.12);
  ctx.quadraticCurveTo(x, y + w * (open === 2 ? 1.35 : 1.0), x + w, y - w * 0.12);
  ctx.quadraticCurveTo(x, y + w * 0.16, x - w, y - w * 0.12);
  ctx.fill();
  if (open === 2) { ctx.fillStyle = '#ff6b7a'; oval(ctx, x, y + w * 0.55, w * 0.42, w * 0.24, 0); }
}

/* ============================================================ ① 小黄龙 */
function drawDragon(ctx, q, p) {
  const look = Math.sin(p * TAU) * 1.6;
  shadow(ctx, 52, 26);

  /* 尾巴（在身后） */
  ctx.fillStyle = '#f2b52e';
  ctx.beginPath();
  ctx.moveTo(-18, 18); ctx.quadraticCurveTo(-52, 26, -44, 44);
  ctx.quadraticCurveTo(-30, 46, -16, 34); ctx.closePath(); ctx.fill();

  /* 小短腿 */
  ctx.fillStyle = '#f2b52e';
  oval(ctx, -14, 48, 11, 10, 0); oval(ctx, 14, 48, 11, 10, 0);
  ctx.fillStyle = '#e09a1c';
  oval(ctx, -15, 54, 10, 5, 0); oval(ctx, 15, 54, 10, 5, 0);

  /* 圆滚滚的大身子（头身一体，这就是奶龙的形） */
  const g = ctx.createLinearGradient(0, -56, 0, 44);
  g.addColorStop(0, '#ffe066'); g.addColorStop(1, '#f7b52c');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(0, -56);
  ctx.bezierCurveTo(34, -56, 42, -18, 40, 14);
  ctx.bezierCurveTo(38, 42, -38, 42, -40, 14);
  ctx.bezierCurveTo(-42, -18, -34, -56, 0, -56);
  ctx.fill();
  ctx.strokeStyle = 'rgba(190,130,10,.5)'; ctx.lineWidth = 1.6; ctx.stroke();

  /* 浅色肚皮 */
  ctx.fillStyle = 'rgba(255,250,200,.75)';
  oval(ctx, 0, 16, 24, 20, 0);

  /* 头顶两只小角 */
  ctx.fillStyle = '#fff0b8';
  ctx.beginPath(); ctx.moveTo(-20, -50); ctx.quadraticCurveTo(-26, -66, -14, -62); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.moveTo(20, -50); ctx.quadraticCurveTo(26, -66, 14, -62); ctx.closePath(); ctx.fill();

  /* 大眼睛 */
  eye(ctx, -15, -26, 11, '#2e7d52', look);
  eye(ctx, 15, -26, 11, '#2e7d52', look);

  /* 红脸蛋 */
  ctx.fillStyle = 'rgba(255,130,90,.55)';
  oval(ctx, -28, -10, 8, 6, 0); oval(ctx, 28, -10, 8, 6, 0);

  /* 小短嘴 + 牙 */
  ctx.fillStyle = '#f9c22e';
  oval(ctx, 0, -3, 15, 11, 0);
  mouth(ctx, 0, -1, 11, q.open, '#a8610f');
  if (q.open) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(-6, -6, 5, 5); ctx.fillRect(1, -6, 5, 5);
  }
  ctx.fillStyle = '#c98a1a';
  circle(ctx, -4, -6, 1.6); circle(ctx, 4, -6, 1.6);

  /* 小短手 */
  const a = -0.4 - q.arm * 1.9;
  limb(ctx, -34, 8, -34 - Math.cos(a) * 16, 8 + Math.sin(a) * 16, 9, '#f7b52c');
  limb(ctx, 34, 8, 34 + Math.cos(a) * 16, 8 + Math.sin(a) * 16, 9, '#f7b52c');
}

/* ============================================================ ② 海盗狗 */
function drawDog(ctx, q, p) {
  const look = Math.sin(p * TAU) * 1.6;
  shadow(ctx, 52, 26);

  /* 尾巴 */
  ctx.strokeStyle = '#26262b'; ctx.lineWidth = 11; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(26, 30); ctx.quadraticCurveTo(48, 26, 44, 8 + q.arm * -10); ctx.stroke();

  /* 坐着的身体 */
  ctx.fillStyle = '#f7f4ee';
  ctx.beginPath();
  ctx.moveTo(0, -22);
  ctx.bezierCurveTo(30, -22, 34, 14, 30, 34);
  ctx.bezierCurveTo(26, 50, -26, 50, -30, 34);
  ctx.bezierCurveTo(-34, 14, -30, -22, 0, -22);
  ctx.fill();
  ctx.strokeStyle = 'rgba(120,116,110,.35)'; ctx.lineWidth = 1.6; ctx.stroke();

  /* 前腿 + 后脚 */
  ctx.fillStyle = '#efeae1';
  oval(ctx, -17, 44, 12, 9, 0); oval(ctx, 17, 44, 12, 9, 0);

  /* 肚子上的黑斑 */
  ctx.fillStyle = '#26262b';
  ctx.beginPath();
  ctx.moveTo(2, 2); ctx.bezierCurveTo(26, 6, 24, 34, 6, 38);
  ctx.bezierCurveTo(-8, 34, -8, 8, 2, 2); ctx.fill();

  /* 头（同样要显式设线宽，别继承 limb 的粗线） */
  ctx.fillStyle = '#f7f4ee';
  ctx.beginPath();
  ctx.moveTo(0, -58);
  ctx.bezierCurveTo(24, -58, 28, -40, 26, -26);
  ctx.bezierCurveTo(24, -12, -24, -12, -26, -26);
  ctx.bezierCurveTo(-28, -40, -24, -58, 0, -58);
  ctx.fill();
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = 'rgba(120,116,110,.35)';
  ctx.stroke();

  /* 一只耳朵黑、一只白 */
  ctx.fillStyle = '#26262b';
  oval(ctx, -24, -48, 10, 16, -0.35);
  ctx.fillStyle = '#efeae1';
  oval(ctx, 24, -48, 10, 16, 0.35);

  /* 右眼黑罩 */
  ctx.fillStyle = '#26262b';
  oval(ctx, 11, -40, 13, 12, 0.15);

  /* 眼睛 */
  eye(ctx, -10, -38, 8, '#1d1d22', look);
  eye(ctx, 11, -39, 8, '#1d1d22', look);

  /* 口鼻 */
  ctx.fillStyle = '#ffffff';
  oval(ctx, 0, -22, 13, 10, 0);
  ctx.fillStyle = '#26262b';
  oval(ctx, 0, -26, 5, 4, 0);
  mouth(ctx, 0, -18, 8, q.open, '#3a3a40');
  if (q.open) { ctx.fillStyle = '#ff7b8a'; oval(ctx, 0, -12, 5, 3, 0); }

  /* 抱起来的两只前爪 */
  const a = -0.2 - q.arm * 2.1;
  limb(ctx, -26, -6, -26 - Math.cos(a) * 20, -6 + Math.sin(a) * 20, 10, '#f7f4ee');
  limb(ctx, 26, -6, 26 + Math.cos(a) * 20, -6 + Math.sin(a) * 20, 10, '#f7f4ee');
  ctx.fillStyle = '#26262b';
  circle(ctx, -26 - Math.cos(a) * 20, -6 + Math.sin(a) * 20, 5);
  circle(ctx, 26 + Math.cos(a) * 20, -6 + Math.sin(a) * 20, 5);
}

/* ============================================================ ③ 熊猫人 */
function drawPanda(ctx, q, p) {
  const look = Math.sin(p * TAU) * 1.8;
  shadow(ctx, 52, 26);

  /* 腿 */
  ctx.fillStyle = '#26262b';
  oval(ctx, -17, 46, 13, 10, 0); oval(ctx, 17, 46, 13, 10, 0);

  /* 白身子 */
  ctx.fillStyle = '#fbfbfb';
  ctx.beginPath();
  ctx.moveTo(0, -18);
  ctx.bezierCurveTo(30, -18, 36, 16, 31, 36);
  ctx.bezierCurveTo(26, 50, -26, 50, -31, 36);
  ctx.bezierCurveTo(-36, 16, -30, -18, 0, -18);
  ctx.fill();
  ctx.strokeStyle = 'rgba(120,120,125,.3)'; ctx.lineWidth = 1.6; ctx.stroke();

  /* 黑手臂 */
  const a = -0.3 - q.arm * 2.0;
  limb(ctx, -28, -2, -28 - Math.cos(a) * 18, -2 + Math.sin(a) * 18, 12, '#26262b');
  limb(ctx, 28, -2, 28 + Math.cos(a) * 18, -2 + Math.sin(a) * 18, 12, '#26262b');

  /* 头。注意必须显式设 lineWidth —— limb() 为了画粗腿把它设成了 12，
     这里不重设的话，头的描边会变成 12px 粗，糊成一大块灰。 */
  ctx.fillStyle = '#fbfbfb';
  ctx.beginPath();
  ctx.moveTo(0, -60);
  ctx.bezierCurveTo(26, -60, 30, -42, 28, -28);
  ctx.bezierCurveTo(26, -14, -26, -14, -28, -28);
  ctx.bezierCurveTo(-30, -42, -26, -60, 0, -60);
  ctx.fill();
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = 'rgba(120,120,125,.3)';
  ctx.stroke();

  /* 黑耳朵 */
  ctx.fillStyle = '#26262b';
  circle(ctx, -23, -58, 10); circle(ctx, 23, -58, 10);

  /* 黑眼圈（斜着，显得欠） */
  ctx.fillStyle = '#26262b';
  oval(ctx, -12, -38, 11, 13, -0.35);
  oval(ctx, 12, -38, 11, 13, 0.35);

  /* 眼睛：半眯着 = 贱萌 */
  ctx.fillStyle = '#ffffff';
  oval(ctx, -12, -38, 5, 6, -0.35); oval(ctx, 12, -38, 5, 6, 0.35);
  ctx.fillStyle = '#1d1d22';
  circle(ctx, -12 + look, -37, 2.8); circle(ctx, 12 + look, -37, 2.8);

  /* 挑眉 */
  ctx.strokeStyle = '#26262b'; ctx.lineWidth = 2.4; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(-19, -50); ctx.lineTo(-6, -47); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(19, -50); ctx.lineTo(6, -47); ctx.stroke();

  /* 鼻子 + 嘴（歪嘴笑） */
  ctx.fillStyle = '#26262b';
  oval(ctx, 0, -24, 6, 4.4, 0);
  mouth(ctx, 2, -20, 9, q.open, '#3a3a40');
  if (q.open) { ctx.fillStyle = '#ff7b8a'; oval(ctx, 2, -13, 5, 3, 0); }
}

/* ============================================================ ④ 海绵宝宝 */
function drawSponge(ctx, q, p) {
  const look = Math.sin(p * TAU) * 1.8;
  shadow(ctx, 54, 24);

  /* 腿 + 鞋 */
  limb(ctx, -11, 26, -11, 44, 4, '#ffd93b');
  limb(ctx, 11, 26, 11, 44, 4, '#ffd93b');
  ctx.fillStyle = '#f2f2f2'; oval(ctx, -11, 38, 4, 8, 0); oval(ctx, 11, 38, 4, 8, 0);
  ctx.fillStyle = '#e5484d'; ctx.fillRect(-14, 36, 7, 2); ctx.fillRect(8, 36, 7, 2);
  ctx.fillStyle = '#1d1d22';
  oval(ctx, -12, 48, 10, 6, 0); oval(ctx, 12, 48, 10, 6, 0);

  /* 白衬衫 + 红领带 + 棕裤子 */
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(-30, 8, 60, 12);
  ctx.strokeStyle = 'rgba(120,120,125,.35)'; ctx.lineWidth = 1.4; ctx.strokeRect(-30, 8, 60, 12);
  ctx.fillStyle = '#8a5a2b';
  ctx.fillRect(-30, 20, 60, 12);
  ctx.strokeRect(-30, 20, 60, 12);
  ctx.fillStyle = '#e5484d';
  ctx.beginPath(); ctx.moveTo(0, 9); ctx.lineTo(-5, 15); ctx.lineTo(0, 20); ctx.lineTo(5, 15); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.moveTo(0, 19); ctx.lineTo(-4, 24); ctx.lineTo(0, 32); ctx.lineTo(4, 24); ctx.closePath(); ctx.fill();

  /* 海绵本体：圆角方块 */
  const g = ctx.createLinearGradient(0, -62, 0, 10);
  g.addColorStop(0, '#ffe95c'); g.addColorStop(1, '#f3ce2a');
  ctx.fillStyle = g;
  const W = 30, TOP = -62, BOT = 10, R = 12;
  ctx.beginPath();
  ctx.moveTo(-W + R, TOP);
  ctx.lineTo(W - R, TOP); ctx.quadraticCurveTo(W, TOP, W, TOP + R);
  ctx.lineTo(W, BOT - R); ctx.quadraticCurveTo(W, BOT, W - R, BOT);
  ctx.lineTo(-W + R, BOT); ctx.quadraticCurveTo(-W, BOT, -W, BOT - R);
  ctx.lineTo(-W, TOP + R); ctx.quadraticCurveTo(-W, TOP, -W + R, TOP);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(190,150,20,.45)'; ctx.lineWidth = 1.6; ctx.stroke();

  /* 海绵孔 */
  ctx.fillStyle = 'rgba(214,175,26,.65)';
  oval(ctx, -20, -46, 5, 4, 0.3); oval(ctx, 22, -30, 4.5, 3.6, -0.2);
  oval(ctx, -22, -14, 4, 3.4, 0); oval(ctx, 18, -52, 4, 3.2, 0.4);
  oval(ctx, 6, -6, 3.4, 2.8, 0); oval(ctx, -8, -34, 3, 2.6, 0);

  /* 大眼睛 */
  ctx.fillStyle = '#ffffff';
  oval(ctx, -13, -38, 11, 12, 0); oval(ctx, 13, -38, 11, 12, 0);
  ctx.strokeStyle = 'rgba(150,120,10,.35)'; ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.ellipse(-13, -38, 11, 12, 0, 0, TAU); ctx.stroke();
  ctx.beginPath(); ctx.ellipse(13, -38, 11, 12, 0, 0, TAU); ctx.stroke();
  ctx.fillStyle = '#3fa9e0';
  circle(ctx, -13 + look, -37, 5.4); circle(ctx, 13 + look, -37, 5.4);
  ctx.fillStyle = '#1d1d22';
  circle(ctx, -13 + look, -37, 2.6); circle(ctx, 13 + look, -37, 2.6);

  /* 睫毛 */
  ctx.strokeStyle = '#1d1d22'; ctx.lineWidth = 1.6;
  [-18, -13, -8].forEach(function (dx) {
    ctx.beginPath(); ctx.moveTo(dx, -50); ctx.lineTo(dx - 1, -55); ctx.stroke();
  });
  [8, 13, 18].forEach(function (dx) {
    ctx.beginPath(); ctx.moveTo(dx, -50); ctx.lineTo(dx + 1, -55); ctx.stroke();
  });

  /* 大嘴 + 两颗门牙 */
  mouth(ctx, 0, -16, 14, q.open || 1, '#a88a1a');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(-6, -22, 5, 7); ctx.fillRect(1, -22, 5, 7);
  ctx.fillStyle = 'rgba(255,120,140,.5)';
  oval(ctx, -24, -18, 7, 5, 0); oval(ctx, 24, -18, 7, 5, 0);

  /* 细胳膊 */
  const a = -0.3 - q.arm * 2.0;
  limb(ctx, -30, -14, -30 - Math.cos(a) * 17, -14 + Math.sin(a) * 17, 4, '#ffd93b');
  limb(ctx, 30, -14, 30 + Math.cos(a) * 17, -14 + Math.sin(a) * 17, 4, '#ffd93b');
}

/* ============================================================ ⑤ 派大星 */
function drawStar(ctx, q, p) {
  const look = Math.sin(p * TAU) * 1.8;
  shadow(ctx, 56, 24);

  /* 海星本体：五个角 */
  const g = ctx.createLinearGradient(0, -64, 0, 46);
  g.addColorStop(0, '#ff9db0'); g.addColorStop(1, '#f2748c');
  ctx.fillStyle = g;
  ctx.beginPath();
  const pts = [
    [0, -64], [16, -34], [48, -34], [24, -12], [34, 22],
    [0, 6], [-34, 22], [-24, -12], [-48, -34], [-16, -34]
  ];
  pts.forEach(function (pt, i) { i ? ctx.lineTo(pt[0], pt[1]) : ctx.moveTo(pt[0], pt[1]); });
  ctx.closePath();
  ctx.lineJoin = 'round';
  ctx.fill();
  ctx.strokeStyle = 'rgba(190,70,95,.5)'; ctx.lineWidth = 2; ctx.stroke();

  /* 浅色斑点 */
  ctx.fillStyle = 'rgba(255,190,205,.75)';
  oval(ctx, -26, 34, 4, 3, 0); oval(ctx, 26, 34, 4, 3, 0);
  oval(ctx, -40, -36, 3.4, 2.6, 0); oval(ctx, 40, -36, 3.4, 2.6, 0);
  oval(ctx, 0, -56, 3.4, 2.6, 0);

  /* 绿短裤 */
  ctx.fillStyle = '#9ed94f';
  ctx.beginPath();
  ctx.moveTo(-22, 6); ctx.quadraticCurveTo(0, 14, 22, 6);
  ctx.lineTo(26, 30); ctx.quadraticCurveTo(0, 38, -26, 30);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(110,160,40,.5)'; ctx.lineWidth = 1.6; ctx.stroke();
  ctx.fillStyle = '#a97fe0';
  circle(ctx, -12, 20, 4.4); circle(ctx, 12, 20, 4.4); circle(ctx, 0, 28, 3.4);

  /* 眼睛 */
  eye(ctx, -13, -26, 11, '#1d1d22', look);
  eye(ctx, 13, -26, 11, '#1d1d22', look);

  /* 眉毛 */
  ctx.strokeStyle = '#8f3a4e'; ctx.lineWidth = 2.6; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(-21, -40); ctx.lineTo(-6, -37); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(21, -40); ctx.lineTo(6, -37); ctx.stroke();

  /* 大嘴（几乎总是咧着） */
  mouth(ctx, 0, -8, 13, q.open || 1, '#8f3a4e');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(-6, -14, 5, 7); ctx.fillRect(1, -14, 5, 7);
}

/* ============================================================ 出图 */
const SKINS = [
  { id: 'dragon', name: '小黄龙', author: '自带', draw: drawDragon },
  { id: 'dog', name: '海盗狗', author: '自带', draw: drawDog },
  { id: 'panda', name: '熊猫人', author: '自带', draw: drawPanda },
  { id: 'sponge', name: '方块海绵', author: '自带', draw: drawSponge },
  { id: 'star', name: '粉海星', author: '自带', draw: drawStar }
];

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;background:transparent;overflow:hidden}</style></head>
<body><canvas id="c" width="720" height="420"></canvas>
<script>
var FW=${FW}, FH=${FH};
var x=document.getElementById('c').getContext('2d');
var TAU=Math.PI*2;
${shadow.toString()}
${circle.toString()}
${oval.toString()}
${eye.toString()}
${limb.toString()}
${poseFor.toString()}
${mouth.toString()}
${drawDragon.toString()}
${drawDog.toString()}
${drawPanda.toString()}
${drawSponge.toString()}
${drawStar.toString()}
var DRAWS = { dragon: drawDragon, dog: drawDog, panda: drawPanda, sponge: drawSponge, star: drawStar };
window.SCALE = 0.8; window.OFFX = 0; window.OFFY = 0;
window.render = function (id) {
  var fn = DRAWS[id];
  x.clearRect(0, 0, 720, 420);
  var rows = [['idle', 4], ['dance', 6], ['cheer', 6]];
  for (var r = 0; r < 3; r++) {
    var kind = rows[r][0], n = rows[r][1];
    for (var i = 0; i < n; i++) {
      var q = poseFor(kind, i / n);
      x.save();
      x.translate(i * FW + FW / 2 + window.OFFX, r * FH + FH / 2 + window.OFFY + q.bob);
      x.rotate(q.tilt);
      x.scale(1 / q.squash, q.squash);
      x.scale(window.SCALE, window.SCALE);
      fn(x, q, i / n);
      x.restore();
    }
  }
  document.title = 'ready';
};
</script></body></html>`;

app.whenReady().then(async () => {
  const log = [];
  try {
    const w = new BrowserWindow({
      width: 720, height: 420, useContentSize: true, show: false, frame: false,
      transparent: true, backgroundColor: '#00000000', hasShadow: false
    });
    await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML));
    await sleep(1200);

    for (const s of SKINS) {
      const dir = path.join(root, 'skins', s.id);
      fs.mkdirSync(dir, { recursive: true });

      /* ---- 第一遍：按基准缩放画一次，量出所有帧的「运动包络」 ---- */
      await w.webContents.executeJavaScript(
        "window.SCALE=0.8;window.OFFX=0;window.OFFY=0;window.render('" + s.id + "')");
      await sleep(200);
      const probe = (await w.webContents.capturePage()).resize({ width: 720, height: 420, quality: 'best' });
      fs.writeFileSync(path.join(dir, '_probe.png'), probe.toPNG());
      const pb = probe.toBitmap(), ps = probe.getSize();
      const PA = (xx, yy) => pb[(yy * ps.width + xx) * 4 + 3];
      let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < COLS; c++) {
          for (let yy = 0; yy < FH; yy++) {
            for (let xx = 0; xx < FW; xx++) {
              if (PA(c * FW + xx, r * FH + yy) > 8) {
                const dx = xx - FW / 2, dy = yy - FH / 2;
                if (dx < minX) minX = dx; if (dx > maxX) maxX = dx;
                if (dy < minY) minY = dy; if (dy > maxY) maxY = dy;
              }
            }
          }
        }
      }
      if (maxX < minX) { minX = -30; maxX = 30; minY = -40; maxY = 40; }
      const envW = maxX - minX, envH = maxY - minY;

      /* ---- 算出「刚好塞进格子还留余量」的缩放，并把包络居中 ---- */
      const base = 0.8;
      const fit = Math.min(112 / envW, 132 / envH);
      const scale = Math.min(1.0, base * fit);
      const k = scale / base;
      const offX = -((minX + maxX) / 2) * k;
      const offY = -((minY + maxY) / 2) * k;

      /* ---- 第二遍：用最终缩放重画 ---- */
      await w.webContents.executeJavaScript(
        'window.SCALE=' + scale.toFixed(4) + ';window.OFFX=' + offX.toFixed(2) +
        ';window.OFFY=' + offY.toFixed(2) + ";window.render('" + s.id + "')");
      await sleep(220);
      const shot = await w.webContents.capturePage();
      const img = shot.resize({ width: 720, height: 420, quality: 'best' });
      fs.writeFileSync(path.join(dir, 'sheet.png'), img.toPNG());
      try { fs.unlinkSync(path.join(dir, '_probe.png')); } catch (e) { }
      fs.writeFileSync(path.join(dir, 'skin.json'), JSON.stringify({
        name: s.name, author: s.author,
        frame: { w: 120, h: 140 }, fps: 10, sheet: 'sheet.png',
        animations: { idle: { row: 0, count: 4 }, dance: { row: 1, count: 6 }, cheer: { row: 2, count: 6 } }
      }, null, 2) + '\n', 'utf8');

      /* 自检：帧边界必须干净，并逐格报告内容包围盒（越界时能直接看出是谁） */
      const im = nativeImage.createFromPath(path.join(dir, 'sheet.png'));
      const b = im.toBitmap(), sz = im.getSize();
      const A = (xx, yy) => b[(yy * sz.width + xx) * 4 + 3];
      const detail = [];
      let dirty = 0;
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 6; c++) {
          let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
          for (let yy = 0; yy < 140; yy++) {
            for (let xx = 0; xx < 120; xx++) {
              if (A(c * 120 + xx, r * 140 + yy) > 8) {
                if (xx < x0) x0 = xx; if (xx > x1) x1 = xx;
                if (yy < y0) y0 = yy; if (yy > y1) y1 = yy;
              }
            }
          }
          if (x1 < 0) continue;
          const bad = x0 < 2 || y0 < 2 || x1 > 117 || y1 > 137;
          if (bad) {
            dirty++;
            detail.push('      r' + r + 'c' + c + ' 内容 x' + x0 + '..' + x1 + ' y' + y0 + '..' + y1 +
              (x0 < 2 ? ' ←左边越界' : '') + (x1 > 117 ? ' →右边越界' : '') +
              (y0 < 2 ? ' ↑上边越界' : '') + (y1 > 137 ? ' ↓下边越界' : ''));
          }
        }
      }
      log.push(s.id.padEnd(8) + ' ' + s.name.padEnd(6) + ' 生成完毕   边界' + (dirty ? ('✘ ' + dirty + ' 格越界') : '✔ 干净'));
      if (detail.length) log.push(detail.slice(0, 6).join('\n'));
    }
    w.destroy();

    /* 拼一张总览图，方便一眼看完五个 */
    const cw = new BrowserWindow({ width: 720, height: 200, useContentSize: true, show: false, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false });
    const overview = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:transparent}canvas{display:block}</style></head><body><canvas id="o" width="720" height="200"></canvas><script>' +
      'var x=document.getElementById("o").getContext("2d");var imgs=[];var ids=' + JSON.stringify(SKINS.map(s => s.id)) + ';' +
      'ids.forEach(function(id,i){var im=new Image();im.onload=function(){x.drawImage(im,0,0,120,140,i*144+6,30,120,140);if(i===ids.length-1)document.title="ready";};im.src="../skins/"+id+"/sheet.png";});' +
      '</script></body></html>';
    await cw.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(overview.replace('../skins/', 'file:///' + root.replace(/\\/g, '/') + '/skins/')));
    await sleep(1600);
    fs.writeFileSync(path.join(root, '_overview.png'), (await cw.webContents.capturePage()).toPNG());
    cw.destroy();
    log.push('总览图 _overview.png');
  } catch (e) {
    log.push('出错: ' + (e && e.stack || e));
  }
  fs.writeFileSync(path.join(__dirname, '_skinlog.txt'), log.join('\n'), 'utf8');
  app.exit(0);
});
