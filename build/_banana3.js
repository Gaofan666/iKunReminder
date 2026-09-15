/* 临时：香蕉改矮、改成弯的月牙形、斜靠在椰子树上 */
const fs = require('fs');
const p = 'build/make-skins.js';
let s = fs.readFileSync(p, 'utf8');

const re = /[ \t]*\/\* ---------- 站着的绿香蕉 ---------- \*\/[\s\S]*?ctx\.restore\(\);\r?\n\r?\n[ \t]*\/\* ---------- 手里的蒲扇/;
if (!re.test(s)) { console.error('没找到香蕉身体段'); process.exit(1); }

const NEW = `  /* ---------- 弯香蕉：斜靠在椰子树上 ---------- */
  ctx.save();
  ctx.translate(-8, 4 + breath * 0.6);
  ctx.rotate(-0.26);                    // 往树那边靠
  /* 脚（贴地） */
  [-1, 1].forEach(function (sg) {
    ctx.fillStyle = '#6B9A3A';
    ctx.beginPath(); ctx.ellipse(sg * 11, 34, 9, 5.4, sg * 0.1, 0, TAU); ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = LINE; ctx.stroke();
  });
  /* 蕉身：月牙形，比之前矮一截 */
  const bg = ctx.createLinearGradient(-22, -32, 22, 34);
  bg.addColorStop(0, '#B7E06A'); bg.addColorStop(0.42, '#8CC63F'); bg.addColorStop(1, '#4E8C2A');
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.moveTo(-4, -34);                          // 上端（收尖）
  ctx.bezierCurveTo(-22, -18, -25, 12, -12, 28);// 外弧：向左凸出去
  ctx.bezierCurveTo(-4, 37, 10, 35, 14, 24);    // 底端
  ctx.bezierCurveTo(20, 6, 16, -16, 6, -34);    // 内弧：右侧凹进来
  ctx.closePath(); ctx.fill();
  ctx.lineWidth = 2.6; ctx.strokeStyle = LINE; ctx.stroke();
  /* 棱线（顺着弯度走） */
  ctx.strokeStyle = 'rgba(46,74,30,.38)'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(-2, -30);
  ctx.bezierCurveTo(-18, -14, -20, 12, -8, 28);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(6, -30);
  ctx.bezierCurveTo(18, -14, 15, 10, 4, 26);
  ctx.stroke();
  /* 高光 */
  ctx.fillStyle = 'rgba(255,255,255,.32)';
  ctx.beginPath(); ctx.ellipse(-13, -4, 3.4, 14, 0.22, 0, TAU); ctx.fill();
  /* 果蒂 */
  ctx.fillStyle = '#6B5A2E';
  ctx.beginPath();
  ctx.moveTo(-4, -34); ctx.lineTo(-1, -42); ctx.lineTo(7, -40); ctx.lineTo(5, -33);
  ctx.closePath(); ctx.fill();
  ctx.lineWidth = 2; ctx.strokeStyle = LINE; ctx.stroke();

  /* 惬意的脸 */
  ctx.strokeStyle = '#2E4A1E'; ctx.lineWidth = 2.6; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.arc(-6, -14, 5, 0.12 * Math.PI, 0.88 * Math.PI); ctx.stroke();
  ctx.beginPath(); ctx.arc(8, -13, 5, 0.12 * Math.PI, 0.88 * Math.PI); ctx.stroke();
  ctx.fillStyle = 'rgba(255,140,150,.45)';
  ctx.beginPath(); ctx.ellipse(-14, -6, 5, 3.2, 0, 0, TAU); ctx.fill();
  ctx.beginPath(); ctx.ellipse(15, -5, 5, 3.2, 0, 0, TAU); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-2, -1); ctx.quadraticCurveTo(3, 3 + sip * 2, 9, -1);
  ctx.lineWidth = 2.6; ctx.stroke();

  /* 左臂：搭在树干上 */
  ctx.strokeStyle = '#8CC63F'; ctx.lineWidth = 8; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(-16, 4); ctx.lineTo(-26, -6 + breath * 0.5); ctx.stroke();
  ctx.lineWidth = 2.2; ctx.strokeStyle = LINE; ctx.stroke();
  ctx.fillStyle = '#8CC63F';
  ctx.beginPath(); ctx.arc(-26, -6 + breath * 0.5, 5, 0, TAU); ctx.fill();
  ctx.lineWidth = 2; ctx.strokeStyle = LINE; ctx.stroke();

  /* 右臂举扇子 */
  ctx.strokeStyle = '#8CC63F'; ctx.lineWidth = 8;
  ctx.beginPath(); ctx.moveTo(16, 2); ctx.lineTo(25, -8 + breath); ctx.stroke();
  ctx.lineWidth = 2.2; ctx.strokeStyle = LINE; ctx.stroke();
  ctx.restore();

`;

s = s.replace(re, NEW);
fs.writeFileSync(p, s, 'utf8');
console.log('香蕉已改矮、改弯、斜靠树干');
