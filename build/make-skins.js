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
function drawDragon(ctx, q, p, kind) {
  const look = Math.sin(p * TAU) * 1.6;
  /* 腹肌大小：待机时若隐若现，跳舞/欢呼时越绷越大 */
  const flex = kind === 'idle' ? (0.5 + 0.5 * Math.sin(p * TAU))
    : kind === 'dance' ? (1.1 + 0.35 * Math.abs(Math.sin(p * TAU * 2)))
      : 1.6;
  shadow(ctx, 52, 26);

  /* 尾巴 */
  ctx.fillStyle = '#f2b52e';
  ctx.beginPath();
  ctx.moveTo(-18, 18); ctx.quadraticCurveTo(-52, 26, -44, 44);
  ctx.quadraticCurveTo(-30, 46, -16, 34); ctx.closePath(); ctx.fill();

  /* 小短腿 */
  ctx.fillStyle = '#f2b52e';
  oval(ctx, -14, 48, 11, 10, 0); oval(ctx, 14, 48, 11, 10, 0);
  ctx.fillStyle = '#e09a1c';
  oval(ctx, -15, 54, 10, 5, 0); oval(ctx, 15, 54, 10, 5, 0);

  /* 大身子 */
  const g = ctx.createLinearGradient(0, -56, 0, 44);
  g.addColorStop(0, '#ffe066'); g.addColorStop(1, '#f7b52c');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(0, -56);
  ctx.bezierCurveTo(34, -56, 42, -18, 40, 14);
  ctx.bezierCurveTo(38, 42, -38, 42, -40, 14);
  ctx.bezierCurveTo(-42, -18, -34, -56, 0, -56);
  ctx.fill();
  ctx.lineWidth = 1.6; ctx.strokeStyle = 'rgba(190,130,10,.5)'; ctx.stroke();

  /* 肚皮（绷紧时整体鼓一点） */
  const bellyRy = 22 * (1 + (flex - 1) * 0.13);
  const bellyRx = 26 * (1 + (flex - 1) * 0.07);
  const bellyG = ctx.createLinearGradient(0, 20 - bellyRy, 0, 20 + bellyRy);
  bellyG.addColorStop(0, 'rgba(255,253,225,.96)');
  bellyG.addColorStop(1, 'rgba(252,238,175,.92)');
  ctx.fillStyle = bellyG;
  oval(ctx, 0, 20, bellyRx, bellyRy, 0);
  ctx.lineWidth = 1.2; ctx.strokeStyle = 'rgba(210,170,40,.4)';
  ctx.beginPath(); ctx.ellipse(0, 20, bellyRx, bellyRy, 0, 0, TAU); ctx.stroke();

  /* ---- 腹肌：靠「沟」和「隆起」画，不是贴六个椭圆 ----
     真实腹肌 = 一道竖沟 + 两条横沟把腹直肌分成六块。
     所以先铺隆起，再压沟，最后给每块加高光；绷得越紧对比越强。 */
  const abGrow = 1 + (flex - 1) * 0.55;
  const abW = 7.4 * abGrow, abH = 4.2 * abGrow;
  const rowH = 2 * abH + 2.2;
  const abMid = 22;                       // 腹肌中心（在肚皮中间，不再被嘴压住）
  const abTop = abMid - rowH * 1.5;

  /* 整片隆起 */
  const mg = ctx.createRadialGradient(-3, abTop + rowH * 1.1, 2, 0, abMid, abW * 2.6);
  mg.addColorStop(0, 'rgba(255,255,255,.75)');
  mg.addColorStop(0.6, 'rgba(247,206,92,.5)');
  mg.addColorStop(1, 'rgba(230,180,50,0)');
  ctx.fillStyle = mg;
  oval(ctx, 0, abMid, abW * 2.2, rowH * 1.75, 0);

  /* 沟（对比度给足，否则看不出是肌肉） */
  ctx.lineCap = 'round';
  const gAlpha = Math.min(0.8, 0.45 + flex * 0.22);
  ctx.strokeStyle = 'rgba(163,108,14,' + gAlpha + ')';
  ctx.lineWidth = 1.4 + flex * 0.7;
  ctx.beginPath();
  ctx.moveTo(0, abTop - abH * 0.45);
  ctx.lineTo(0, abTop + rowH * 2 + abH * 0.45);
  ctx.stroke();
  for (let r = 1; r <= 2; r++) {
    const gy = abTop + r * rowH - rowH * 0.5;
    ctx.beginPath();
    ctx.moveTo(-abW * 0.98, gy + 1.9);
    ctx.quadraticCurveTo(0, gy - 1.9, abW * 0.98, gy + 1.9);
    ctx.stroke();
  }
  /* 每块上面的高光，和下面的暗边，做出立体感 */
  for (let r = 0; r < 3; r++) {
    for (let c = -1; c <= 1; c += 2) {
      const ax = c * abW * 0.5, ay = abTop + r * rowH;
      ctx.fillStyle = 'rgba(255,255,255,' + Math.min(0.85, 0.4 + flex * 0.28) + ')';
      oval(ctx, ax - abW * 0.16, ay - abH * 0.26, abW * 0.42, abH * 0.36, c * 0.08);
      ctx.fillStyle = 'rgba(178,124,20,' + Math.min(0.4, 0.14 + flex * 0.14) + ')';
      oval(ctx, ax + abW * 0.1, ay + abH * 0.34, abW * 0.4, abH * 0.2, c * 0.06);
    }
  }
  /* 绷到最大时，两侧再压两道外轮廓 */
  if (flex > 1.1) {
    ctx.strokeStyle = 'rgba(170,116,16,' + Math.min(0.62, (flex - 1.1) * 1.1) + ')';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(-abW * 1.16, abTop - abH * 0.15);
    ctx.quadraticCurveTo(-abW * 1.3, abMid, -abW * 0.92, abTop + rowH * 2.85);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(abW * 1.16, abTop - abH * 0.15);
    ctx.quadraticCurveTo(abW * 1.3, abMid, abW * 0.92, abTop + rowH * 2.85);
    ctx.stroke();
  }

  /* 头顶小角 */
  ctx.fillStyle = '#fff0b8';
  ctx.beginPath(); ctx.moveTo(-20, -50); ctx.quadraticCurveTo(-26, -66, -14, -62); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.moveTo(20, -50); ctx.quadraticCurveTo(26, -66, 14, -62); ctx.closePath(); ctx.fill();

  /* 眼睛 */
  eye(ctx, -15, -26, 11, '#2e7d52', look);
  eye(ctx, 15, -26, 11, '#2e7d52', look);

  /* 红脸蛋 */
  ctx.fillStyle = 'rgba(255,130,90,.5)';
  oval(ctx, -29, -10, 8, 6, 0); oval(ctx, 29, -10, 8, 6, 0);

  /* 嘴（上移到脸下半部，别压到腹肌） */
  ctx.fillStyle = '#f9c22e'; oval(ctx, 0, -12, 15, 10, 0);
  if (q.open) mouthOpen(ctx, 0, -10, 11, q.open === 2 ? 8 : 5, '#a8610f');
  else {
    ctx.strokeStyle = '#a8610f'; ctx.lineWidth = 2.6; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(0, -11, 10, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
  }
  if (q.open) teeth(ctx, -6, -15, 5, 5, 2);
  ctx.fillStyle = '#c98a1a'; circle(ctx, -4, -15, 1.6); circle(ctx, 4, -15, 1.6);

  /* ---- 手臂 + 二头肌：二头肌和手臂同色，才连成一条胳膊而不是浮在旁边的球 ---- */
  const a = -0.35 - q.arm * 1.1 + Math.sin(p * TAU) * (kind === 'dance' ? 0.45 : 0.3);
  const bulge = 5.5 + flex * 3.6;
  [-1, 1].forEach(function (sgn) {
    /* 肩点要落在身体轮廓外（身体半宽约 40），否则胳膊只剩个圆点露出来 */
    const sx = sgn * 39, sy = 8;
    const mx = sgn * (39 + Math.cos(a) * 9), my = sy + Math.sin(a) * 9;      // 肘
    const ex = sgn * (39 + Math.cos(a) * 19), ey = sy + Math.sin(a) * 19;    // 手
    limb(ctx, sx, sy, mx, my, 10, '#f7b52c');                               // 上臂
    ctx.fillStyle = '#f7b52c';
    circle(ctx, (sx + mx) / 2, (sy + my) / 2 - 1.5, bulge * 0.66);          // 二头肌
    ctx.fillStyle = 'rgba(255,255,255,.45)';                                // 肌肉高光
    circle(ctx, (sx + mx) / 2 - sgn * 2.5, (sy + my) / 2 - bulge * 0.42, bulge * 0.28);
    limb(ctx, mx, my, ex, ey, 8, '#f7b52c');                                // 前臂
    ctx.fillStyle = '#f7b52c'; circle(ctx, ex, ey, 5.6);                    // 手
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(190,130,10,.35)';
    ctx.beginPath(); ctx.arc(ex, ey, 5.6, 0, TAU); ctx.stroke();
  });
}

/* ============================================================ ③ 熊猫人 */
function drawPanda(ctx, q, p, kind) {
  const look = Math.sin(p * TAU) * 1.5;
  const pedal = p * TAU * (kind === 'idle' ? 1 : kind === 'dance' ? 3.2 : 1.6);
  const wheel = pedal * 1.1;
  shadow(ctx, 56, 34);

  /* ---- 自行车（先画，人在上面） ---- */
  const wheelR = 15, wx = 30, wy = 40;
  /* 车轮 */
  [-1, 1].forEach(function (sgn) {
    const cx = sgn * wx;
    ctx.strokeStyle = '#2b2b31'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(cx, wy, wheelR, 0, TAU); ctx.stroke();
    ctx.strokeStyle = '#aeb6bf'; ctx.lineWidth = 1.2;
    for (let i = 0; i < 6; i++) {
      const a = wheel + i * Math.PI / 3;
      ctx.beginPath();
      ctx.moveTo(cx, wy);
      ctx.lineTo(cx + Math.cos(a) * (wheelR - 2), wy + Math.sin(a) * (wheelR - 2));
      ctx.stroke();
    }
    ctx.fillStyle = '#8d949c'; circle(ctx, cx, wy, 2.4);
  });
  /* 车架 */
  ctx.strokeStyle = '#d9534f'; ctx.lineWidth = 3.4; ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-wx, wy); ctx.lineTo(-4, wy - 20); ctx.lineTo(18, wy - 20);
  ctx.moveTo(18, wy - 20); ctx.lineTo(wx, wy);
  ctx.moveTo(-4, wy - 20); ctx.lineTo(-14, wy); ctx.lineTo(-wx, wy);
  ctx.stroke();
  /* 车把 & 座垫 */
  ctx.strokeStyle = '#8d949c'; ctx.lineWidth = 2.6;
  ctx.beginPath(); ctx.moveTo(18, wy - 20); ctx.lineTo(22, wy - 30); ctx.lineTo(30, wy - 32); ctx.stroke();
  ctx.fillStyle = '#2b2b31';
  rrect(ctx, -12, wy - 27, 16, 5, 2.4); ctx.fill();

  /* ---- 熊猫 ---- */
  const hipY = wy - 24;
  const legLift = Math.sin(pedal) * 5, legLift2 = Math.sin(pedal + Math.PI) * 5;

  /* 腿（蹬车） */
  ctx.strokeStyle = '#26262b'; ctx.lineWidth = 8; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(-6, hipY + 8); ctx.lineTo(-8, hipY + 16 + legLift); ctx.lineTo(-4 + Math.sin(pedal) * 8, wy - 4 + legLift); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(6, hipY + 8); ctx.lineTo(8, hipY + 16 + legLift2); ctx.lineTo(-4 + Math.sin(pedal + Math.PI) * 8, wy - 4 + legLift2); ctx.stroke();
  /* 脚踏 */
  ctx.fillStyle = '#3a3a42';
  oval(ctx, -4 + Math.sin(pedal) * 8, wy - 4 + legLift, 5, 2.4, 0);
  oval(ctx, -4 + Math.sin(pedal + Math.PI) * 8, wy - 4 + legLift2, 5, 2.4, 0);

  /* 白身子 */
  ctx.fillStyle = '#fbfbfb';
  ctx.beginPath();
  ctx.moveTo(0, hipY - 22);
  ctx.bezierCurveTo(26, hipY - 22, 30, hipY, 26, hipY + 12);
  ctx.bezierCurveTo(22, hipY + 22, -22, hipY + 22, -26, hipY + 12);
  ctx.bezierCurveTo(-30, hipY, -26, hipY - 22, 0, hipY - 22);
  ctx.fill();
  ctx.lineWidth = 1.6; ctx.strokeStyle = 'rgba(120,120,125,.3)'; ctx.stroke();

  /* 手臂 → 握车把；欢呼时举一只手 */
  ctx.strokeStyle = '#26262b'; ctx.lineWidth = 7; ctx.lineCap = 'round';
  if (kind === 'cheer') {
    ctx.beginPath(); ctx.moveTo(-16, hipY - 6); ctx.lineTo(-30, hipY - 22); ctx.lineTo(-34, hipY - 44); ctx.stroke();
    ctx.fillStyle = '#26262b'; circle(ctx, -34, hipY - 46, 5);
  } else {
    ctx.beginPath(); ctx.moveTo(-16, hipY - 6); ctx.lineTo(-6, hipY - 14); ctx.lineTo(30, wy - 32); ctx.stroke();
  }
  ctx.beginPath(); ctx.moveTo(16, hipY - 6); ctx.lineTo(24, hipY - 14); ctx.lineTo(30, wy - 32); ctx.stroke();
  ctx.fillStyle = '#26262b'; circle(ctx, 30, wy - 33, 4.6);

  /* 头 */
  const hy = hipY - 60;
  ctx.fillStyle = '#fbfbfb';
  ctx.beginPath();
  ctx.moveTo(0, hy);
  ctx.bezierCurveTo(26, hy, 30, hy + 18, 28, hy + 32);
  ctx.bezierCurveTo(26, hy + 46, -26, hy + 46, -28, hy + 32);
  ctx.bezierCurveTo(-30, hy + 18, -26, hy, 0, hy);
  ctx.fill();
  ctx.lineWidth = 1.6; ctx.strokeStyle = 'rgba(120,120,125,.3)'; ctx.stroke();

  /* 耳朵 */
  ctx.fillStyle = '#26262b';
  circle(ctx, -23, hy + 2, 10); circle(ctx, 23, hy + 2, 10);

  /* 黑眼圈（斜的 = 欠） */
  ctx.fillStyle = '#26262b';
  oval(ctx, -12, hy + 22, 11, 13, -0.35);
  oval(ctx, 12, hy + 22, 11, 13, 0.35);
  /* 半眯的眼睛 */
  ctx.fillStyle = '#ffffff';
  oval(ctx, -12, hy + 22, 5, 6, -0.35); oval(ctx, 12, hy + 22, 5, 6, 0.35);
  ctx.fillStyle = '#1d1d22';
  circle(ctx, -12 + look, hy + 23, 2.8); circle(ctx, 12 + look, hy + 23, 2.8);
  /* 挑眉 */
  ctx.strokeStyle = '#26262b'; ctx.lineWidth = 2.4; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(-19, hy + 10); ctx.lineTo(-6, hy + 13); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(19, hy + 10); ctx.lineTo(6, hy + 13); ctx.stroke();

  /* 鼻子 + 歪嘴 */
  ctx.fillStyle = '#26262b'; oval(ctx, 0, hy + 36, 6, 4.4, 0);
  if (q.open) mouthOpen(ctx, 2, hy + 40, 9, q.open === 2 ? 7 : 4.5, '#3a3a40');
  else {
    ctx.strokeStyle = '#3a3a40'; ctx.lineWidth = 2.2; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(2, hy + 39, 7, 0.15 * Math.PI, 0.9 * Math.PI); ctx.stroke();
  }
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
function drawStar(ctx, q, p, kind) {
  const look = Math.sin(p * TAU) * 1.6;
  const blow = kind === 'cheer' ? 1 : kind === 'dance' ? 0.7 : 0.35;
  shadow(ctx, 58, 26);

  /* 小短腿（海星下面两个角） */
  ctx.fillStyle = '#f2748c';
  ctx.beginPath();
  ctx.moveTo(-16, 26); ctx.quadraticCurveTo(-24, 46, -12, 52);
  ctx.quadraticCurveTo(-2, 48, -4, 30); ctx.closePath(); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(16, 26); ctx.quadraticCurveTo(24, 46, 12, 52);
  ctx.quadraticCurveTo(2, 48, 4, 30); ctx.closePath(); ctx.fill();

  /* 两条粗手臂 */
  const aa = -0.3 - q.arm * 1.9;
  [-1, 1].forEach(function (sgn) {
    const ex = sgn * (26 + Math.cos(aa) * 22), ey = 4 + Math.sin(aa) * 22;
    ctx.strokeStyle = '#f2748c'; ctx.lineWidth = 16; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(sgn * 22, 4); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.strokeStyle = 'rgba(200,90,115,.35)'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(sgn * 22, 4); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.fillStyle = '#f2748c'; circle(ctx, ex, ey, 8.6);
  });

  /* ---- 身体：上尖下圆的海星形，不是五角星 ---- */
  const g = ctx.createLinearGradient(0, -66, 0, 40);
  g.addColorStop(0, '#ffa8bb'); g.addColorStop(0.55, '#fa8ea6'); g.addColorStop(1, '#ef7090');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(0, -66);                                        // 头顶尖
  ctx.bezierCurveTo(16, -60, 23, -46, 25, -32);              // 右侧（加宽）
  ctx.bezierCurveTo(28, -20, 34, -12, 34, 2);
  ctx.bezierCurveTo(34, 22, 22, 36, 0, 36);                  // 右下半圆
  ctx.bezierCurveTo(-22, 36, -34, 22, -34, 2);
  ctx.bezierCurveTo(-34, -12, -28, -20, -25, -32);
  ctx.bezierCurveTo(-23, -46, -16, -60, 0, -66);
  ctx.fill();
  ctx.lineWidth = 1.8; ctx.strokeStyle = 'rgba(200,90,115,.6)'; ctx.stroke();

  /* 肚子上的浅色 */
  ctx.fillStyle = 'rgba(255,205,216,.75)';
  oval(ctx, 0, 8, 18, 18, 0);
  /* 身上的小点（海星特有的那种） */
  ctx.fillStyle = 'rgba(214,110,138,.55)';
  oval(ctx, -20, -6, 2, 2.4, 0); oval(ctx, 21, -4, 2, 2.4, 0);
  oval(ctx, -14, 22, 1.8, 2.2, 0); oval(ctx, 15, 23, 1.8, 2.2, 0);

  /* 绿短裤 + 紫花 */
  ctx.fillStyle = '#9ed94f';
  ctx.beginPath();
  ctx.moveTo(-24, 18); ctx.quadraticCurveTo(0, 26, 24, 18);
  ctx.lineTo(27, 36); ctx.quadraticCurveTo(0, 44, -27, 36);
  ctx.closePath(); ctx.fill();
  ctx.lineWidth = 1.6; ctx.strokeStyle = 'rgba(110,160,40,.55)'; ctx.stroke();
  [[-13, 28], [13, 28], [0, 35]].forEach(function (pt) {
    ctx.fillStyle = '#a97fe0';
    circle(ctx, pt[0], pt[1], 3.4);
    ctx.fillStyle = '#e0c8ff';
    circle(ctx, pt[0], pt[1], 1.3);
  });

  /* ---- 脸 ---- */
  /* 眼白 + 厚眼皮（派大星标志性的半睁眼） */
  ctx.fillStyle = '#ffffff';
  oval(ctx, -12, -24, 10, 11, 0); oval(ctx, 12, -24, 10, 11, 0);
  ctx.lineWidth = 1.4; ctx.strokeStyle = 'rgba(180,80,105,.55)';
  ctx.beginPath(); ctx.ellipse(-12, -24, 10, 11, 0, 0, TAU); ctx.stroke();
  ctx.beginPath(); ctx.ellipse(12, -24, 10, 11, 0, 0, TAU); ctx.stroke();
  ctx.fillStyle = '#1d1d22';
  circle(ctx, -12 + look, -22, 4.4); circle(ctx, 12 + look, -22, 4.4);
  ctx.fillStyle = 'rgba(255,255,255,.9)';
  circle(ctx, -13.4 + look, -24, 1.5); circle(ctx, 10.6 + look, -24, 1.5);
  /* 眉毛 */
  ctx.strokeStyle = '#c25f78'; ctx.lineWidth = 2.6; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(-20, -38); ctx.lineTo(-5, -35); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(20, -38); ctx.lineTo(5, -35); ctx.stroke();

  /* 嘴：张开大笑、鼓着腮帮子吹泡泡 */
  const puff = 1 + blow * 0.45;
  ctx.fillStyle = '#b8546d';
  oval(ctx, 0, -6, 11 * puff, 8.6 * puff, 0);          // 唇
  ctx.fillStyle = '#6f2937';
  oval(ctx, 0, -5, 8.6 * puff, 6.6 * puff, 0);         // 口腔
  ctx.fillStyle = '#ff7b8a';
  oval(ctx, 0, -1.2, 5.4 * puff, 3.6 * puff, 0);       // 舌头
  ctx.fillStyle = 'rgba(255,255,255,.92)';             // 上排牙
  rrect(ctx, -5.4, -10, 4.6, 3.4, 1); ctx.fill();
  rrect(ctx, 0.8, -10, 4.6, 3.4, 1); ctx.fill();

  /* ---- 泡泡：从嘴里飘出来，越吹越大 ---- */
  for (let i = 0; i < 4; i++) {
    const t = (p * 2.2 + i * 0.25) % 1;
    const r = (3.6 + i * 2.0) * (1 + blow * 0.5);
    const bx = 14 + t * 28 + i * 3;
    const by = -16 - t * 48;
    const fade = t > 0.78 ? (1 - t) / 0.22 : 1;
    ctx.globalAlpha = Math.min(1, fade * (0.6 + blow * 0.4));
    ctx.fillStyle = 'rgba(255,255,255,.5)';
    circle(ctx, bx, by, r);
    ctx.lineWidth = 1.8;
    ctx.strokeStyle = 'rgba(146,206,246,.95)';
    ctx.beginPath(); ctx.arc(bx, by, r, 0, TAU); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,.95)';
    circle(ctx, bx - r * 0.36, by - r * 0.36, r * 0.24);
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
