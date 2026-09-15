/* 生成自带宠物皮肤到 skins/<id>/
   每个皮肤 = skin.json + sheet.png（6 列 × 3 行）
     row 0 = idle（4 帧）   row 1 = dance（6 帧）   row 2 = cheer（6 帧）

   每个角色都有自己的专属动作：
     海盗狗  挥砍刀和铁钩        小黄龙  秀腹肌（越秀越大）
     熊猫人  骑自行车            方块海绵  拿网兜抓水母
     粉海星  吹泡泡

   画布尺寸是自动算的：先用大格子量出所有帧的「运动包络」，再反算缩放和
   单帧尺寸 —— 这样既装得下道具，五个形象在屏幕上又一样大。
   生成后逐格自检包围盒，内容贴到格子边缘会直接报出来。 */
const { app, BrowserWindow, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const TAU = Math.PI * 2;
const PROBE = 240;               // 探测格尺寸
const FH = 140;                  // 成品单帧高度（固定）
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
function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
function eye(ctx, x, y, r, iris, look, lid) {
  ctx.fillStyle = '#ffffff'; oval(ctx, x, y, r, r * 1.12, 0);
  ctx.lineWidth = 1.2; ctx.strokeStyle = 'rgba(25,35,45,.25)'; ctx.stroke();
  ctx.fillStyle = iris || '#22323c';
  circle(ctx, x + (look || 0), y + r * 0.08, r * 0.44);
  ctx.fillStyle = 'rgba(255,255,255,.92)';
  circle(ctx, x + (look || 0) - r * 0.18, y - r * 0.26, r * 0.17);
  if (lid) {                                   // 半眯：盖住上半只眼
    ctx.fillStyle = lid;
    ctx.beginPath();
    ctx.ellipse(x, y - r * 0.62, r * 1.05, r * 0.62, 0, Math.PI, TAU);
    ctx.fill();
  }
}
function limb(ctx, x0, y0, x1, y1, w, color) {
  ctx.strokeStyle = color; ctx.lineWidth = w; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
}
function mouthOpen(ctx, x, y, w, h, lip, tongue) {
  ctx.fillStyle = lip || '#5d2a20';
  ctx.beginPath();
  ctx.moveTo(x - w, y);
  ctx.quadraticCurveTo(x, y + h * 1.5, x + w, y);
  ctx.quadraticCurveTo(x, y + h * 0.25, x - w, y);
  ctx.fill();
  if (tongue !== false) {
    ctx.fillStyle = tongue || '#ff6b7a';
    oval(ctx, x, y + h * 0.72, w * 0.46, h * 0.44, 0);
  }
}
function teeth(ctx, x, y, w, h, n) {
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < (n || 2); i++) ctx.fillRect(x + i * (w + 1), y, w, h);
}
/* 三种状态的通用姿态。
   待机刻意画得「稳」：几乎不上下弹，只留极轻微的呼吸；
   动感交给角色手里的道具去挥 —— 整体一直跳会让人看着心烦。 */
function poseFor(kind, p) {
  const s = Math.sin(p * TAU);
  if (kind === 'idle') return { bob: s * 1.5, tilt: s * 0.012, squash: 1 + s * 0.014, arm: 0.34, open: 0, p: p };
  if (kind === 'dance') return { bob: -Math.abs(s) * 11, tilt: s * 0.13, squash: 1, arm: 0.8, open: 1, p: p };
  return { bob: -5, tilt: 0, squash: 1.04, arm: 1, open: 2, p: p };
}

/* ============================================================ ① 海盗狗 */
function drawDog(ctx, q, p, kind) {
  const look = Math.sin(p * TAU) * 1.6;
  const swing = Math.sin(p * TAU);
  shadow(ctx, 52, 26);

  /* 尾巴（摇摆幅度跟着动作走） */
  ctx.strokeStyle = '#26262b'; ctx.lineWidth = 11; ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(24, 30);
  ctx.quadraticCurveTo(48, 26, 44 + swing * 6, 8 - q.arm * 12 + swing * 4);
  ctx.stroke();

  /* 坐着的身体 */
  ctx.fillStyle = '#f7f4ee';
  ctx.beginPath();
  ctx.moveTo(0, -22);
  ctx.bezierCurveTo(30, -22, 34, 14, 30, 34);
  ctx.bezierCurveTo(26, 50, -26, 50, -30, 34);
  ctx.bezierCurveTo(-34, 14, -30, -22, 0, -22);
  ctx.fill();
  ctx.lineWidth = 1.6; ctx.strokeStyle = 'rgba(120,116,110,.35)'; ctx.stroke();

  /* 后脚 */
  ctx.fillStyle = '#efeae1';
  oval(ctx, -17, 44, 12, 9, 0); oval(ctx, 17, 44, 12, 9, 0);

  /* 肚子黑斑 */
  ctx.fillStyle = '#26262b';
  ctx.beginPath();
  ctx.moveTo(2, 2); ctx.bezierCurveTo(26, 6, 24, 34, 6, 38);
  ctx.bezierCurveTo(-8, 34, -8, 8, 2, 2); ctx.fill();

  /* ---- 右手：海盗砍刀（待机时也在挥，只是幅度小一点） ---- */
  const sa = -0.15 - q.arm * 1.15 + swing * (kind === 'dance' ? 0.62 : 0.42);
  const hx = 26 + Math.cos(sa) * 22, hy = -6 + Math.sin(sa) * 22;
  limb(ctx, 26, -6, hx, hy, 10, '#f7f4ee');
  ctx.fillStyle = '#26262b'; circle(ctx, hx, hy, 5.4);
  /* 刀：略微弯曲的刀身 + 护手 + 握柄（整体放大，才看得清） */
  ctx.save();
  ctx.translate(hx, hy);
  ctx.rotate(sa * 0.5 - 0.5);
  ctx.scale(1.45, 1.45);
  ctx.fillStyle = '#6b4a2a';                    // 握柄
  rrect(ctx, -3.6, -4, 7.2, 14, 2.6); ctx.fill();
  ctx.fillStyle = '#c9a227';                    // 护手
  rrect(ctx, -9.5, -9, 19, 6, 2.6); ctx.fill();
  ctx.fillStyle = '#d8dde3';                    // 刀身
  ctx.beginPath();
  ctx.moveTo(-5, -9);
  ctx.quadraticCurveTo(-19, -30, -7, -52);
  ctx.quadraticCurveTo(-1, -36, 4, -9);
  ctx.closePath(); ctx.fill();
  ctx.lineWidth = 1.2; ctx.strokeStyle = 'rgba(90,100,115,.75)'; ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,.8)';       // 刃口反光
  ctx.beginPath();
  ctx.moveTo(-4, -11);
  ctx.quadraticCurveTo(-15.5, -30, -7, -48);
  ctx.quadraticCurveTo(-5.5, -30, -1.4, -11);
  ctx.closePath(); ctx.fill();
  ctx.restore();

  /* ---- 左手：铁钩 ---- */
  const ha = -0.2 - q.arm * 1.25 - swing * (kind === 'dance' ? 0.5 : 0.36);
  const ex = -26 - Math.cos(ha) * 22, ey = -6 + Math.sin(ha) * 22;
  limb(ctx, -26, -6, ex, ey, 10, '#f7f4ee');
  ctx.fillStyle = '#26262b'; circle(ctx, ex, ey, 5.4);
  ctx.save();
  ctx.translate(ex, ey);
  ctx.rotate(ha * 0.4 + 0.5);
  ctx.scale(1.4, 1.4);
  ctx.strokeStyle = '#b9c0c8'; ctx.lineWidth = 6; ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(0, 5);
  ctx.lineTo(0, -7);
  ctx.arc(-6.5, -7, 6.5, 0, Math.PI * 1.05, false);   // 钩子的卷曲
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,.65)'; ctx.lineWidth = 1.8;
  ctx.beginPath(); ctx.moveTo(-1.7, 3); ctx.lineTo(-1.7, -7); ctx.stroke();
  ctx.fillStyle = '#8d949c';                          // 手腕铁箍
  rrect(ctx, -7, 2, 14, 8, 2.6); ctx.fill();
  ctx.strokeStyle = '#6d747c'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(-7, 6); ctx.lineTo(7, 6); ctx.stroke();
  ctx.restore();

  /* ---- 头 ---- */
  ctx.fillStyle = '#f7f4ee';
  ctx.beginPath();
  ctx.moveTo(0, -58);
  ctx.bezierCurveTo(24, -58, 28, -40, 26, -26);
  ctx.bezierCurveTo(24, -12, -24, -12, -26, -26);
  ctx.bezierCurveTo(-28, -40, -24, -58, 0, -58);
  ctx.fill();
  ctx.lineWidth = 1.6; ctx.strokeStyle = 'rgba(120,116,110,.35)'; ctx.stroke();

  /* 耳朵：一只黑一只白 */
  ctx.fillStyle = '#26262b';
  oval(ctx, -24, -48, 10, 16, -0.35 + swing * 0.12);
  ctx.fillStyle = '#efeae1';
  oval(ctx, 24, -48, 10, 16, 0.35 - swing * 0.12);

  /* 右眼：海盗眼罩（带带子） */
  ctx.strokeStyle = '#1a1a1f'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(-26, -44); ctx.lineTo(27, -34); ctx.stroke();
  ctx.fillStyle = '#26262b';
  oval(ctx, 11, -39, 13, 12, 0.12);
  ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.ellipse(11, -39, 13, 12, 0.12, 0, TAU); ctx.stroke();

  /* 左眼（完好那只） */
  eye(ctx, -10, -38, 8, '#1d1d22', look);

  /* 口鼻 */
  ctx.fillStyle = '#ffffff'; oval(ctx, 0, -22, 13, 10, 0);
  ctx.fillStyle = '#26262b'; oval(ctx, 0, -26, 5, 4, 0);
  if (q.open) { mouthOpen(ctx, 0, -18, 9, q.open === 2 ? 8 : 5, '#3a3a40'); }
  else {
    ctx.strokeStyle = '#3a3a40'; ctx.lineWidth = 2.4; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(0, -19, 8, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
  }
}

/* ============================================================ ② 小黄龙 */
/* 抽象版奶龙：粗黑描边 + 平涂高对比 + 呆滞大小眼 + 大张歪嘴 */
function drawDragon(ctx, q, p, kind) {
  const LINE = '#141414';
  const derp = kind === 'cheer' ? 1 : kind === 'dance' ? 0.65 : 0.3;
  const jit = Math.sin(p * TAU * 2) * (kind === 'idle' ? 0.6 : 1.6);
  shadow(ctx, 54, 26);

  /* 尾巴 */
  ctx.beginPath();
  ctx.moveTo(-24, 14); ctx.quadraticCurveTo(-50, 20, -44, 40);
  ctx.quadraticCurveTo(-28, 40, -18, 28); ctx.closePath();
  ctx.fillStyle = '#FFD93B'; ctx.fill();
  ctx.lineWidth = 3; ctx.strokeStyle = LINE; ctx.stroke();

  /* 小短腿 */
  [-1, 1].forEach(function (sg) {
    ctx.beginPath(); ctx.ellipse(sg * 15, 46, 12, 10, 0, 0, TAU);
    ctx.fillStyle = '#FFD93B'; ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = LINE; ctx.stroke();
    ctx.beginPath(); ctx.ellipse(sg * 15, 52, 9, 4, 0, 0, TAU);
    ctx.fillStyle = '#E8B92A'; ctx.fill();
    ctx.lineWidth = 2.4; ctx.strokeStyle = LINE; ctx.stroke();
  });

  /* 头身一体的大圆 */
  ctx.beginPath();
  ctx.moveTo(0, -58);
  ctx.bezierCurveTo(36, -58, 45, -14, 43, 16);
  ctx.bezierCurveTo(41, 44, -41, 44, -43, 16);
  ctx.bezierCurveTo(-45, -14, -36, -58, 0, -58);
  ctx.closePath();
  ctx.fillStyle = '#FFD93B'; ctx.fill();
  ctx.lineWidth = 3.4; ctx.strokeStyle = LINE; ctx.stroke();

  /* 肚皮 */
  ctx.beginPath(); ctx.ellipse(0, 20, 23, 19, 0, 0, TAU);
  ctx.fillStyle = '#FFF6C8'; ctx.fill();
  ctx.lineWidth = 2.6; ctx.strokeStyle = LINE; ctx.stroke();

  /* 犄角 */
  [-1, 1].forEach(function (sg) {
    ctx.beginPath();
    ctx.moveTo(sg * 11, -54);
    ctx.quadraticCurveTo(sg * 19, -72, sg * 27, -57);
    ctx.quadraticCurveTo(sg * 19, -50, sg * 11, -51);
    ctx.closePath();
    ctx.fillStyle = '#FFF6C8'; ctx.fill();
    ctx.lineWidth = 2.8; ctx.strokeStyle = LINE; ctx.stroke();
  });

  /* 呆滞大小眼：左眼大、右眼小，瞳孔各看各的 —— 抽象感的来源 */
  const eL = 14, eR = 10.5;
  ctx.lineWidth = 3.2; ctx.strokeStyle = LINE;
  ctx.beginPath(); ctx.ellipse(-15, -26, eL, eL * 1.05, 0, 0, TAU);
  ctx.fillStyle = '#FFFFFF'; ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.ellipse(16, -23, eR, eR * 1.05, 0, 0, TAU);
  ctx.fillStyle = '#FFFFFF'; ctx.fill(); ctx.stroke();
  ctx.fillStyle = LINE;
  ctx.beginPath(); ctx.arc(-13 + jit, -24 + derp * 2.5, 3.6, 0, TAU); ctx.fill();
  ctx.beginPath(); ctx.arc(15 - jit, -25 - derp * 2.5, 3.0, 0, TAU); ctx.fill();

  /* 大张的歪嘴 */
  const mh = 9 + derp * 13;
  ctx.beginPath();
  ctx.moveTo(-20, -3);
  ctx.quadraticCurveTo(-2, -3 + mh, 21, -8);
  ctx.quadraticCurveTo(2, 5, -20, -3);
  ctx.closePath();
  ctx.fillStyle = '#4A1F1A'; ctx.fill();
  ctx.lineWidth = 3; ctx.strokeStyle = LINE; ctx.stroke();
  ctx.fillStyle = '#FF7B8A';
  ctx.beginPath(); ctx.ellipse(2, 1 + derp * 4, 7, 4, 0, 0, TAU); ctx.fill();
  /* 龅牙 */
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(-9, -5, 6.5, 6.5);
  ctx.fillRect(1, -6, 5.5, 6);
  ctx.lineWidth = 1.6; ctx.strokeStyle = LINE;
  ctx.strokeRect(-9, -5, 6.5, 6.5);
  ctx.strokeRect(1, -6, 5.5, 6);

  /* 小短手（先描粗黑边再填色，得到梗图那种粗描边） */
  const a = -0.3 - q.arm * 2.0;
  [-1, 1].forEach(function (sg) {
    const ex = sg * (41 + Math.cos(a) * 14), ey = 6 + Math.sin(a) * 14;
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(sg * 38, 6); ctx.lineTo(ex, ey);
    ctx.lineWidth = 12; ctx.strokeStyle = LINE; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(sg * 38, 6); ctx.lineTo(ex, ey);
    ctx.lineWidth = 6.5; ctx.strokeStyle = '#FFD93B'; ctx.stroke();
    ctx.beginPath(); ctx.arc(ex, ey, 6.4, 0, TAU);
    ctx.fillStyle = '#FFD93B'; ctx.fill();
    ctx.lineWidth = 2.8; ctx.strokeStyle = LINE; ctx.stroke();
  });
}

/* ============================================================ ③ 熊猫人 */
/* 抽象版熊猫人：直接照「熊猫头」梗图的画法 —— 黑白两色、粗线条、
   白脸膛 + 黑耳朵 + 黑眼罩，里面塞一张手绘的「三分讥笑」脸，还叼根烟。 */
function drawPanda(ctx, q, p, kind) {
  const LINE = '#111111';
  const look = Math.sin(p * TAU) * 2.4;
  const smug = kind === 'cheer' ? 1 : kind === 'dance' ? 0.6 : 0.3;
  const smoke = (p * 2) % 1;                       // 吐烟的节奏
  shadow(ctx, 56, 24);

  /* 黑腿 */
  [-1, 1].forEach(function (sg) {
    ctx.beginPath(); ctx.ellipse(sg * 18, 46, 14, 10, 0, 0, TAU);
    ctx.fillStyle = '#111111'; ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = LINE; ctx.stroke();
  });

  /* 白身子 + 黑肚子 */
  ctx.beginPath();
  ctx.moveTo(0, -20);
  ctx.bezierCurveTo(32, -20, 38, 14, 33, 36);
  ctx.bezierCurveTo(28, 52, -28, 52, -33, 36);
  ctx.bezierCurveTo(-38, 14, -32, -20, 0, -20);
  ctx.closePath();
  ctx.fillStyle = '#FFFFFF'; ctx.fill();
  ctx.lineWidth = 3.2; ctx.strokeStyle = LINE; ctx.stroke();
  ctx.beginPath(); ctx.ellipse(0, 20, 19, 16, 0, 0, TAU);
  ctx.fillStyle = '#111111'; ctx.fill();
  ctx.lineWidth = 2.6; ctx.strokeStyle = LINE; ctx.stroke();

  /* 黑手臂 */
  const a = -0.3 - q.arm * 2.0;
  [-1, 1].forEach(function (sg) {
    const ex = sg * (30 + Math.cos(a) * 17), ey = 0 + Math.sin(a) * 17;
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(sg * 28, 0); ctx.lineTo(ex, ey);
    ctx.lineWidth = 13; ctx.strokeStyle = '#111111'; ctx.stroke();
    ctx.beginPath(); ctx.arc(ex, ey, 7, 0, TAU);
    ctx.fillStyle = '#111111'; ctx.fill();
    ctx.lineWidth = 2.6; ctx.strokeStyle = LINE; ctx.stroke();
  });

  /* 大黑耳朵（先在头后面画） */
  [-1, 1].forEach(function (sg) {
    ctx.beginPath(); ctx.arc(sg * 25, -56, 12, 0, TAU);
    ctx.fillStyle = '#111111'; ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = LINE; ctx.stroke();
  });

  /* 白脸膛 */
  ctx.beginPath();
  ctx.moveTo(0, -62);
  ctx.bezierCurveTo(28, -62, 33, -42, 31, -26);
  ctx.bezierCurveTo(29, -10, -29, -10, -31, -26);
  ctx.bezierCurveTo(-33, -42, -28, -62, 0, -62);
  ctx.closePath();
  ctx.fillStyle = '#FFFFFF'; ctx.fill();
  ctx.lineWidth = 3.4; ctx.strokeStyle = LINE; ctx.stroke();

  /* 黑眼罩（斜着，就是熊猫头那两个黑块） */
  ctx.fillStyle = '#111111';
  ctx.beginPath(); ctx.ellipse(-13, -38, 12, 14, -0.34, 0, TAU); ctx.fill();
  ctx.beginPath(); ctx.ellipse(13, -38, 12, 14, 0.34, 0, TAU); ctx.fill();

  /* 懒散半眯的眼睛：眼白压成一条缝，眼神往下斜 */
  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath(); ctx.ellipse(-13, -37, 7.5, 5, -0.34, 0, TAU); ctx.fill();
  ctx.beginPath(); ctx.ellipse(13, -37, 7.5, 5, 0.34, 0, TAU); ctx.fill();
  ctx.fillStyle = '#111111';
  ctx.beginPath(); ctx.arc(-13 + look * 0.6, -36.5 + smug * 1.6, 2.6, 0, TAU); ctx.fill();
  ctx.beginPath(); ctx.arc(13 + look * 0.6, -36.5 + smug * 1.6, 2.6, 0, TAU); ctx.fill();
  /* 上眼皮（盖住上半边 = 不屑） */
  ctx.fillStyle = '#111111';
  ctx.beginPath(); ctx.ellipse(-13, -42, 8.6, 4.4, -0.34, 0, TAU); ctx.fill();
  ctx.beginPath(); ctx.ellipse(13, -42, 8.6, 4.4, 0.34, 0, TAU); ctx.fill();

  /* 粗斜眉 */
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#111111'; ctx.lineWidth = 3.4;
  ctx.beginPath(); ctx.moveTo(-23, -50); ctx.lineTo(-6, -46); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(23, -50); ctx.lineTo(6, -46); ctx.stroke();

  /* 鼻子 */
  ctx.fillStyle = '#111111';
  ctx.beginPath(); ctx.ellipse(0, -25, 6, 4.2, 0, 0, TAU); ctx.fill();

  /* 歪嘴：一边嘴角翘起来，就是那个「三分讥笑」 */
  const mOpen = kind === 'cheer' ? 9 : kind === 'dance' ? 5 : 0;
  ctx.strokeStyle = '#111111'; ctx.lineWidth = 3; ctx.lineCap = 'round';
  if (mOpen) {
    ctx.beginPath();
    ctx.moveTo(-11, -18);
    ctx.quadraticCurveTo(0, -18 + mOpen * 2.2, 14, -21);
    ctx.quadraticCurveTo(2, -13, -11, -18);
    ctx.closePath();
    ctx.fillStyle = '#3A1A1A'; ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(-5, -19.5, 5, 5);
    ctx.fillRect(2, -20.5, 4.6, 4.6);
  } else {
    ctx.beginPath();
    ctx.moveTo(-11, -17);
    ctx.quadraticCurveTo(1, -13, 14, -20);
    ctx.stroke();
  }

  /* 叼着的烟 */
  ctx.strokeStyle = LINE; ctx.lineWidth = 2.4; ctx.lineCap = 'round';
  ctx.fillStyle = '#F5F0E6';
  ctx.save();
  ctx.translate(16, -19);
  ctx.rotate(-0.34);
  ctx.beginPath(); ctx.rect(0, -2, 15, 4);
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#E2574C';
  ctx.beginPath(); ctx.rect(12, -2, 3.5, 4); ctx.fill(); ctx.stroke();
  ctx.restore();
  /* 烟圈（待机时更明显） */
  for (let i = 0; i < 3; i++) {
    const t = (smoke + i * 0.33) % 1;
    ctx.globalAlpha = (1 - t) * (kind === 'idle' ? 0.85 : 0.5);
    ctx.strokeStyle = '#8A8A8A'; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(30 + t * 12, -24 - t * 26, 3 + t * 5, 0, TAU);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/* ============================================================ ④ 方块海绵 */
function drawSponge(ctx, q, p, kind) {
  const look = Math.sin(p * TAU) * 1.8;
  /* 水母在附近飘，甩网时被罩住 */
  const caught = kind === 'cheer';
  const swing = Math.sin(p * TAU);
  shadow(ctx, 54, 24);

  /* 腿 + 鞋 */
  limb(ctx, -11, 26, -11, 44, 4, '#ffd93b');
  limb(ctx, 11, 26, 11, 44, 4, '#ffd93b');
  ctx.fillStyle = '#f2f2f2'; oval(ctx, -11, 38, 4, 8, 0); oval(ctx, 11, 38, 4, 8, 0);
  ctx.fillStyle = '#e5484d'; ctx.fillRect(-14, 36, 7, 2); ctx.fillRect(8, 36, 7, 2);
  ctx.fillStyle = '#1d1d22';
  oval(ctx, -12, 48, 10, 6, 0); oval(ctx, 12, 48, 10, 6, 0);

  /* 衬衫 + 领带 + 裤子 */
  ctx.fillStyle = '#ffffff'; ctx.fillRect(-30, 8, 60, 12);
  ctx.lineWidth = 1.4; ctx.strokeStyle = 'rgba(120,120,125,.35)'; ctx.strokeRect(-30, 8, 60, 12);
  ctx.fillStyle = '#8a5a2b'; ctx.fillRect(-30, 20, 60, 12); ctx.strokeRect(-30, 20, 60, 12);
  ctx.fillStyle = '#e5484d';
  ctx.beginPath(); ctx.moveTo(0, 9); ctx.lineTo(-5, 15); ctx.lineTo(0, 20); ctx.lineTo(5, 15); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.moveTo(0, 19); ctx.lineTo(-4, 24); ctx.lineTo(0, 32); ctx.lineTo(4, 24); ctx.closePath(); ctx.fill();

  /* ---- 网兜：待机时也在轻轻晃，像在找水母 ---- */
  const na = -0.55 - q.arm * 1.05 + swing * (kind === 'dance' ? 0.55 : 0.4);
  const nx = 30 + Math.cos(na) * 26, ny = -12 + Math.sin(na) * 26;
  limb(ctx, 30, -12, nx, ny, 3.6, '#b98b52');
  const hoopX = nx + Math.cos(na) * 12, hoopY = ny + Math.sin(na) * 12;
  /* 网圈（放大一点才认得出是网兜） */
  ctx.strokeStyle = '#c9a227'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.ellipse(hoopX, hoopY, 14, 11.5, na, 0, TAU); ctx.stroke();
  /* 网面 */
  ctx.strokeStyle = 'rgba(245,248,252,.95)'; ctx.lineWidth = 1.1;
  for (let i = -2; i <= 2; i++) {
    ctx.beginPath();
    ctx.moveTo(hoopX + Math.cos(na + Math.PI / 2) * i * 5.6, hoopY + Math.sin(na + Math.PI / 2) * i * 5.6);
    ctx.lineTo(hoopX + Math.cos(na - Math.PI / 2) * i * 5.6, hoopY + Math.sin(na - Math.PI / 2) * i * 5.6);
    ctx.stroke();
  }
  for (let i = -1; i <= 1; i++) {
    ctx.beginPath();
    ctx.moveTo(hoopX + Math.cos(na) * i * 6, hoopY + Math.sin(na) * i * 6);
    ctx.lineTo(hoopX - Math.cos(na) * (11 + i), hoopY - Math.sin(na) * (11 + i));
    ctx.stroke();
  }

  /* ---- 水母：粉色伞盖 + 触手，甩到就罩进网里 ---- */
  const jx = caught ? hoopX : hoopX - 5 - swing * 4;
  const jy = caught ? hoopY + 3 : hoopY - 34 + Math.sin(p * TAU * 2) * 6;
  ctx.globalAlpha = caught ? 1 : 0.88;
  const jg = ctx.createRadialGradient(jx - 4, jy - 8, 2, jx, jy, 15);
  jg.addColorStop(0, '#ffd6e6'); jg.addColorStop(0.6, '#ff9ec4'); jg.addColorStop(1, '#ef6ba4');
  ctx.fillStyle = jg;
  ctx.beginPath();
  ctx.moveTo(jx - 13, jy + 5);
  ctx.quadraticCurveTo(jx - 15, jy - 13, jx, jy - 13);
  ctx.quadraticCurveTo(jx + 15, jy - 13, jx + 13, jy + 5);
  ctx.quadraticCurveTo(jx, jy + 11, jx - 13, jy + 5);
  ctx.fill();
  ctx.lineWidth = 1.2; ctx.strokeStyle = 'rgba(200,90,140,.75)'; ctx.stroke();
  /* 伞盖上的斑点 */
  ctx.fillStyle = 'rgba(255,255,255,.65)';
  oval(ctx, jx - 5, jy - 6, 2.4, 1.8, 0); oval(ctx, jx + 5, jy - 5, 2.2, 1.7, 0);
  oval(ctx, jx, jy - 9, 1.8, 1.4, 0);
  /* 触手 */
  ctx.strokeStyle = 'rgba(255,150,190,.95)'; ctx.lineWidth = 1.8; ctx.lineCap = 'round';
  for (let i = 0; i < 5; i++) {
    const tx = jx - 9 + i * 4.5;
    ctx.beginPath();
    ctx.moveTo(tx, jy + 6);
    ctx.quadraticCurveTo(tx + Math.sin(p * TAU * 2 + i) * 4, jy + 15, tx + Math.sin(p * TAU * 2 + i) * 2, jy + 23);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  /* ---- 海绵本体 ---- */
  const W = 30, TOP = -62, BOT = 10, R = 12;
  const g = ctx.createLinearGradient(0, TOP, 0, BOT);
  g.addColorStop(0, '#ffe95c'); g.addColorStop(1, '#f3ce2a');
  ctx.fillStyle = g;
  rrect(ctx, -W, TOP, W * 2, BOT - TOP, R); ctx.fill();
  ctx.lineWidth = 1.6; ctx.strokeStyle = 'rgba(190,150,20,.45)'; ctx.stroke();

  /* 海绵孔 */
  ctx.fillStyle = 'rgba(214,175,26,.6)';
  oval(ctx, -20, -46, 5, 4, 0.3); oval(ctx, 22, -30, 4.5, 3.6, -0.2);
  oval(ctx, -22, -14, 4, 3.4, 0); oval(ctx, 18, -52, 4, 3.2, 0.4);
  oval(ctx, 6, -6, 3.4, 2.8, 0); oval(ctx, -8, -34, 3, 2.6, 0);

  /* 眼睛 */
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
  ctx.strokeStyle = '#1d1d22'; ctx.lineWidth = 1.6; ctx.lineCap = 'round';
  [-18, -13, -8].forEach(function (dx) { ctx.beginPath(); ctx.moveTo(dx, -50); ctx.lineTo(dx - 1, -55); ctx.stroke(); });
  [8, 13, 18].forEach(function (dx) { ctx.beginPath(); ctx.moveTo(dx, -50); ctx.lineTo(dx + 1, -55); ctx.stroke(); });

  /* 嘴 */
  mouthOpen(ctx, 0, -18, 13, 9, '#5d2a20');
  teeth(ctx, -6, -22, 5, 7, 2);
  ctx.fillStyle = 'rgba(255,120,140,.45)';
  oval(ctx, -25, -18, 7, 5, 0); oval(ctx, 25, -18, 7, 5, 0);

  /* 左臂（不拿网的那只） */
  limb(ctx, -30, -14, -30 - Math.cos(na) * 16, -14 + Math.sin(na) * 16, 4, '#ffd93b');
}

/* ============================================================ ⑤ 粉海星 */
/* 呆傻版派大星
   关键特征（来自萌娘百科）：粉红海星、光膀子穿绿短裤、
   「眼皮是紫色的」、没有鼻子、两脚各一只指甲。
   表情走呆傻路线：紫眼皮压住一半眼睛、瞳孔往上飘、嘴巴松弛张开、流口水。 */
function drawStar(ctx, q, p, kind) {
  const LINE = '#C4607A';          // 描边用比体色深一点的粉
  const PINK = '#F79FB0';
  const PINK_D = '#EE8AA0';
  const PINK_L = '#FDD3DC';
  const LID = '#9B7BD4';           // 紫色眼皮
  const look = Math.sin(p * TAU) * 1.8;
  const blow = kind === 'cheer' ? 1 : kind === 'dance' ? 0.7 : 0.35;
  /* 发呆抖动：小幅度、慢，显得更呆 */
  const derp = Math.sin(p * TAU * 1.5) * (kind === 'idle' ? 1.2 : 2.2);
  shadow(ctx, 58, 27);

  /* ---- 两条粗手臂：圆头圆脑垂在两边 ---- */
  const aa = -0.25 - q.arm * 1.9;
  [-1, 1].forEach(function (sgn) {
    const ex = sgn * (27 + Math.cos(aa) * 20), ey = 4 + Math.sin(aa) * 20;
    ctx.lineCap = 'round';
    ctx.strokeStyle = PINK; ctx.lineWidth = 17;
    ctx.beginPath(); ctx.moveTo(sgn * 20, 2); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.strokeStyle = LINE; ctx.lineWidth = 18.5;   // 先描深的再压浅的，做出轮廓
    ctx.globalAlpha = 0.9;
    ctx.beginPath(); ctx.moveTo(sgn * 20, 2); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = PINK; ctx.lineWidth = 15;
    ctx.beginPath(); ctx.moveTo(sgn * 20, 2); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.fillStyle = PINK;
    ctx.beginPath(); ctx.arc(ex, ey, 8.6, 0, TAU); ctx.fill();
    ctx.strokeStyle = LINE; ctx.lineWidth = 2; ctx.stroke();
  });

  /* ---- 两条短腿 + 各一只脚指甲 ---- */
  [-1, 1].forEach(function (sgn) {
    ctx.fillStyle = PINK_D;
    ctx.beginPath();
    ctx.moveTo(sgn * 15, 24);
    ctx.quadraticCurveTo(sgn * 26, 44, sgn * 13, 52);
    ctx.quadraticCurveTo(sgn * 2, 48, sgn * 4, 28);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = LINE; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = '#F2E7C8';                       // 指甲
    ctx.beginPath(); ctx.ellipse(sgn * 15, 49, 3.4, 2.4, sgn * 0.3, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#C9A96A'; ctx.lineWidth = 1; ctx.stroke();
  });

  /* ---- 头身：上尖下圆的整块海星体 ---- */
  const g = ctx.createLinearGradient(0, -68, 0, 34);
  g.addColorStop(0, '#FBAEC0'); g.addColorStop(0.5, PINK); g.addColorStop(1, PINK_D);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(0, -68);
  ctx.bezierCurveTo(13, -62, 20, -48, 22, -34);
  ctx.bezierCurveTo(25, -22, 32, -14, 32, 0);
  ctx.bezierCurveTo(32, 20, 21, 34, 0, 34);
  ctx.bezierCurveTo(-21, 34, -32, 20, -32, 0);
  ctx.bezierCurveTo(-32, -14, -25, -22, -22, -34);
  ctx.bezierCurveTo(-20, -48, -13, -62, 0, -68);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = LINE; ctx.lineWidth = 2.4; ctx.stroke();

  /* ---- 绿短裤（在身体之前画下半截，贴合胯部） ---- */
  ctx.beginPath();
  ctx.moveTo(-26, 16); ctx.quadraticCurveTo(0, 25, 26, 16);
  ctx.lineTo(29, 34); ctx.quadraticCurveTo(0, 42, -29, 34);
  ctx.closePath();
  const sg = ctx.createLinearGradient(0, 16, 0, 38);
  sg.addColorStop(0, '#A8DE5C'); sg.addColorStop(1, '#8CC843');
  ctx.fillStyle = sg; ctx.fill();
  ctx.strokeStyle = '#5E8F2A'; ctx.lineWidth = 2.2; ctx.stroke();
  /* 紫花 */
  [[-14, 27], [14, 27], [0, 34]].forEach(function (pt) {
    ctx.fillStyle = '#A97FE0';
    for (let k = 0; k < 5; k++) {
      const a = k / 5 * TAU - Math.PI / 2;
      ctx.beginPath();
      ctx.ellipse(pt[0] + Math.cos(a) * 3.1, pt[1] + Math.sin(a) * 3.1, 2.2, 2.2, 0, 0, TAU);
      ctx.fill();
    }
    ctx.fillStyle = '#F0DFFF';
    ctx.beginPath(); ctx.arc(pt[0], pt[1], 1.5, 0, TAU); ctx.fill();
  });

  /* ---- 浅色肚皮 ---- */
  ctx.fillStyle = 'rgba(255,214,224,.85)';
  ctx.beginPath(); ctx.ellipse(0, 6, 17, 17, 0, 0, TAU); ctx.fill();
  /* 身上的小点（海星的质感，鼻子的位置没有） */
  ctx.fillStyle = 'rgba(214,110,138,.5)';
  [[-21, -8], [21, -6], [-15, 20], [16, 21], [-24, -26], [24, -25]].forEach(function (pt) {
    ctx.beginPath(); ctx.ellipse(pt[0], pt[1], 1.9, 2.3, 0, 0, TAU); ctx.fill();
  });

  /* ---- 眼睛：白眼球 + 紫色厚眼皮压住上半边（这是派大星的灵魂） ---- */
  const eyY = -26, er = 10.5;
  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath(); ctx.ellipse(-11.5, eyY, er, er * 1.05, 0, 0, TAU); ctx.fill();
  ctx.beginPath(); ctx.ellipse(11.5, eyY, er, er * 1.05, 0, 0, TAU); ctx.fill();
  ctx.strokeStyle = LINE; ctx.lineWidth = 1.8;
  ctx.beginPath(); ctx.ellipse(-11.5, eyY, er, er * 1.05, 0, 0, TAU); ctx.stroke();
  ctx.beginPath(); ctx.ellipse(11.5, eyY, er, er * 1.05, 0, 0, TAU); ctx.stroke();
  /* 瞳孔：往上飘、还各看各的 */
  ctx.fillStyle = '#1D1D22';
  ctx.beginPath(); ctx.arc(-11.5 + look * 1.4, eyY - 2.4 + derp * 0.6, 3.6, 0, TAU); ctx.fill();
  ctx.beginPath(); ctx.arc(11.5 - look * 1.4, eyY - 3.0 - derp * 0.6, 3.6, 0, TAU); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,.9)';
  ctx.beginPath(); ctx.arc(-12.6 + look * 1.4, eyY - 3.6 + derp * 0.6, 1.3, 0, TAU); ctx.fill();
  ctx.beginPath(); ctx.arc(10.4 - look * 1.4, eyY - 4.2 - derp * 0.6, 1.3, 0, TAU); ctx.fill();
  /* 紫色眼皮 */
  ctx.fillStyle = LID;
  ctx.beginPath(); ctx.ellipse(-11.5, eyY - 4.2, er + 0.6, 6.2, 0, Math.PI, TAU); ctx.fill();
  ctx.beginPath(); ctx.ellipse(11.5, eyY - 4.2, er + 0.6, 6.2, 0, Math.PI, TAU); ctx.fill();
  ctx.strokeStyle = '#7C5EB8'; ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.moveTo(-22, eyY - 4.2); ctx.lineTo(-1, eyY - 4.2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(1, eyY - 4.2); ctx.lineTo(22, eyY - 4.2); ctx.stroke();

  /* ---- 粗眉（粉的，压得很低 = 呆） ---- */
  ctx.strokeStyle = '#E06A8C'; ctx.lineWidth = 3.4; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(-20, -41 + derp * 0.5); ctx.lineTo(-4, -38 + derp * 0.5); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(20, -41 - derp * 0.5); ctx.lineTo(4, -38 - derp * 0.5); ctx.stroke();

  /* ---- 嘴：松弛张开、舌头吐出来 ---- */
  const mw = 11 + blow * 3, mh = 6 + blow * 5;
  ctx.beginPath();
  ctx.ellipse(0, -8 + derp * 0.4, mw, mh, 0, 0, TAU);
  ctx.fillStyle = '#8E3B52'; ctx.fill();
  ctx.strokeStyle = LINE; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = '#FF7B8A';
  ctx.beginPath(); ctx.ellipse(0, -5.5 + blow * 2.5 + derp * 0.4, mw * 0.6, mh * 0.46, 0, 0, TAU); ctx.fill();
  ctx.fillStyle = '#FFFFFF';                       // 两颗上门牙
  ctx.beginPath(); ctx.rect(-5.4, -13 + derp * 0.4, 4.4, 3.6); ctx.fill();
  ctx.beginPath(); ctx.rect(1, -13 + derp * 0.4, 4.4, 3.6); ctx.fill();

  /* ---- 口水（呆傻感的点睛之笔） ---- */
  if (kind !== 'cheer') {
    const drool = 4 + (Math.sin(p * TAU * 2) * 0.5 + 0.5) * 6;
    ctx.fillStyle = 'rgba(180,230,255,.85)';
    ctx.beginPath();
    ctx.moveTo(9, -2);
    ctx.quadraticCurveTo(12.5, drool * 0.6, 9.5, drool);
    ctx.quadraticCurveTo(6.5, drool * 0.6, 6.5, -2);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.7)';
    ctx.beginPath(); ctx.arc(8.2, drool - 1.4, 1.7, 0, TAU); ctx.fill();
  }

  /* ---- 泡泡（抓水母 / 吹泡泡是他的爱好） ---- */
  for (let i = 0; i < 4; i++) {
    const t = (p * 2.2 + i * 0.25) % 1;
    const r = (3.6 + i * 2.0) * (1 + blow * 0.5);
    const bx = 16 + t * 26 + i * 3;
    const by = -20 - t * 44;
    const fade = t > 0.78 ? (1 - t) / 0.22 : 1;
    ctx.globalAlpha = Math.min(1, fade * (0.55 + blow * 0.45));
    ctx.fillStyle = 'rgba(255,255,255,.5)';
    ctx.beginPath(); ctx.arc(bx, by, r, 0, TAU); ctx.fill();
    ctx.lineWidth = 1.7;
    ctx.strokeStyle = 'rgba(146,206,246,.95)';
    ctx.beginPath(); ctx.arc(bx, by, r, 0, TAU); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,.95)';
    ctx.beginPath(); ctx.arc(bx - r * 0.36, by - r * 0.36, r * 0.24, 0, TAU); ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/* ============================================================ 出图 */
const SKINS = [
  { id: 'dog', name: '海盗狗', author: '自带', draw: drawDog },
  { id: 'dragon', name: '小黄龙', author: '自带', draw: drawDragon },
  { id: 'panda', name: '熊猫人', author: '自带', draw: drawPanda },
  { id: 'sponge', name: '方块海绵', author: '自带', draw: drawSponge },
  { id: 'star', name: '粉海星', author: '自带', draw: drawStar }
];

function pageJS() {
  return `var TAU=Math.PI*2;
${shadow}${circle}${oval}${rrect}${eye}${limb}${mouthOpen}${teeth}${poseFor}
${drawDog}${drawDragon}${drawPanda}${drawSponge}${drawStar}
var DRAWS={dog:drawDog,dragon:drawDragon,panda:drawPanda,sponge:drawSponge,star:drawStar};
window.CELLW=${PROBE}; window.CELLH=${PROBE};
window.SCALE=0.8; window.OFFX=0; window.OFFY=0;
window.render=function(id){
  var fn=DRAWS[id];
  var cw=window.CELLW, ch=window.CELLH;
  var W=cw*6, H=ch*3;
  var c=document.getElementById('c');
  if(c.width!==W||c.height!==H){c.width=W;c.height=H;}
  var x=c.getContext('2d');
  x.clearRect(0,0,W,H);
  var rows=[['idle',4],['dance',6],['cheer',6]];
  for(var r=0;r<3;r++){
    var kind=rows[r][0], n=rows[r][1];
    for(var i=0;i<n;i++){
      var q=poseFor(kind,i/n);
      x.save();
      x.translate(i*cw+cw/2+window.OFFX, r*ch+ch/2+window.OFFY+q.bob);
      x.rotate(q.tilt);
      x.scale(1/q.squash,q.squash);
      x.scale(window.SCALE,window.SCALE);
      fn(x,q,i/n,kind);
      x.restore();
    }
  }
  document.title='ready';
};`;
}

app.whenReady().then(async () => {
  const log = [];
  try {
    /* 探测：大格子 + 透明窗口，方便量包围盒 */
    const w = new BrowserWindow({
      width: PROBE * 6, height: PROBE * 3, useContentSize: true, show: false, frame: false,
      transparent: true, backgroundColor: '#00000000', hasShadow: false
    });
    await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      '<!DOCTYPE html><html><head><meta charset="utf-8">' +
      '<style>html,body{margin:0;background:transparent;overflow:hidden}</style></head>' +
      '<body><canvas id="c"></canvas><script>' + pageJS() + '</script></body></html>'));
    await sleep(900);

    for (const s of SKINS) {
      /* ---- 第一遍：在等大的格子里量出「运动包络」 ---- */
      await w.webContents.executeJavaScript(
        "window.CELLW=" + PROBE + ";window.CELLH=" + PROBE +
        ";window.SCALE=0.8;window.OFFX=0;window.OFFY=0;window.render('" + s.id + "')");
      await sleep(240);
      const probeShot = await w.webContents.capturePage();
      /* 截图带屏幕缩放，先归一化回 CSS 像素再量，否则坐标全错位 */
      const probe = probeShot.resize({ width: PROBE * 6, height: PROBE * 3, quality: 'best' });
      const pb = probe.toBitmap(), ps = probe.getSize();
      const PA = (xx, yy) => pb[(yy * ps.width + xx) * 4 + 3];
      let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 6; c++) {
          for (let yy = 0; yy < PROBE; yy++) {
            for (let xx = 0; xx < PROBE; xx++) {
              if (PA(c * PROBE + xx, r * PROBE + yy) > 8) {
                const dx = xx - PROBE / 2, dy = yy - PROBE / 2;
                if (dx < minX) minX = dx; if (dx > maxX) maxX = dx;
                if (dy < minY) minY = dy; if (dy > maxY) maxY = dy;
              }
            }
          }
        }
      }
      if (maxX < minX) { minX = -40; maxX = 40; minY = -50; maxY = 50; }
      const envW = maxX - minX, envH = maxY - minY;

      /* ---- 反算成品尺寸：高度固定 140、内容占 94%；宽度按内容比例给 ---- */
      const base = 0.8;
      const scale = Math.min(1.0, base * (FH * 0.94) / envH);
      const k = scale / base;
      const fw = Math.max(72, Math.ceil(envW * k + 22));
      const offX = -((minX + maxX) / 2) * k;
      const offY = -((minY + maxY) / 2) * k;

      /* ---- 第二遍：按成品尺寸重画（列宽 fw、行高 FH，两者不同） ---- */
      await w.webContents.executeJavaScript(
        "window.CELLW=" + fw + ";window.CELLH=" + FH +
        ";window.SCALE=" + scale.toFixed(4) + ";window.OFFX=" + offX.toFixed(2) +
        ";window.OFFY=" + offY.toFixed(2) + ";window.render('" + s.id + "')");
      await sleep(260);
      const shot = await w.webContents.capturePage();
      /* 截图带屏幕缩放（比如 1.5 倍），要先按比例换算裁切区域再缩回来 */
      const shotSize = shot.getSize();
      const dpi = shotSize.width / (PROBE * 6);
      const img = shot.crop({
        x: 0, y: 0,
        width: Math.round(fw * 6 * dpi),
        height: Math.round(FH * 3 * dpi)
      }).resize({ width: fw * 6, height: FH * 3, quality: 'best' });

      const dir = path.join(root, 'skins', s.id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'sheet.png'), img.toPNG());
      fs.writeFileSync(path.join(dir, 'skin.json'), JSON.stringify({
        name: s.name, author: s.author,
        frame: { w: fw, h: FH }, fps: 10, sheet: 'sheet.png',
        animations: {
          /* 待机放慢：帧率太高会一直在抖，看久了很烦 */
          idle: { row: 0, count: 4, fps: 3.5 },
          dance: { row: 1, count: 6, fps: 12 },
          cheer: { row: 2, count: 6, fps: 10 }
        }
      }, null, 2) + '\n', 'utf8');

      /* ---- 自检 ---- */
      const im = nativeImage.createFromPath(path.join(dir, 'sheet.png'));
      const b = im.toBitmap(), sz = im.getSize();
      const A = (xx, yy) => b[(yy * sz.width + xx) * 4 + 3];
      const detail = [];
      let dirty = 0;
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 6; c++) {
          let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
          for (let yy = 0; yy < FH; yy++) {
            for (let xx = 0; xx < fw; xx++) {
              if (A(c * fw + xx, r * FH + yy) > 8) {
                if (xx < x0) x0 = xx; if (xx > x1) x1 = xx;
                if (yy < y0) y0 = yy; if (yy > y1) y1 = yy;
              }
            }
          }
          if (x1 < 0) continue;
          if (x0 < 2 || y0 < 2 || x1 > fw - 3 || y1 > FH - 3) {
            dirty++;
            detail.push('      r' + r + 'c' + c + ' x' + x0 + '..' + x1 + ' y' + y0 + '..' + y1 +
              (x0 < 2 ? ' ←越界' : '') + (x1 > fw - 3 ? ' →越界' : '') +
              (y0 < 2 ? ' ↑越界' : '') + (y1 > FH - 3 ? ' ↓越界' : ''));
          }
        }
      }
      log.push(s.id.padEnd(7) + ' ' + s.name.padEnd(5) + ' 单帧 ' + fw + 'x' + FH +
        '  精灵图 ' + (fw * 6) + 'x' + (FH * 3) + '  边界' + (dirty ? '✘' : '✔'));
      if (detail.length) log.push(detail.slice(0, 5).join('\n'));
    }
    w.destroy();
  } catch (e) {
    log.push('出错: ' + (e && e.stack || e));
  }
  fs.writeFileSync(path.join(__dirname, '_skinlog.txt'), log.join('\n'), 'utf8');
  app.exit(0);
});
