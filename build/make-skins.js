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
/* 霸气版熊猫头
   设计思路：把「比中指」和「霸气」合起来 —— 关键在于神态。
   ① 墨镜往下推到鼻梁，露出眼睛，从镜框上方冷冷地俯视你（大佬俯视的经典神态，
      同时也解决了全黑镜片没有表情的问题）
   ② 细烟换成粗雪茄，烟量加大
   ③ 肩膀加宽、身体压低前倾，重心下坠才压得住场
   ④ 手垂在身侧比中指，中指加长、指上套金戒指
   ⑤ 金链子再加粗，金牌加大 */
function drawPanda(ctx, q, p, kind) {
  const LINE = '#111111';
  const glare = Math.sin(p * TAU) * 1.6;         // 眼神缓慢扫动
  const smug = kind === 'cheer' ? 1 : kind === 'dance' ? 0.6 : 0.3;
  const smoke = (p * 2) % 1;
  shadow(ctx, 60, 32);

  /* ---- 腿：粗短，站得很稳 ---- */
  [-1, 1].forEach(function (sg) {
    ctx.beginPath(); ctx.ellipse(sg * 23, 52, 17, 12, 0, 0, TAU);
    ctx.fillStyle = '#111111'; ctx.fill();
    ctx.lineWidth = 3.2; ctx.strokeStyle = LINE; ctx.stroke();
  });

  /* ---- 身体：肩宽腰沉，整个轮廓撑起来 ---- */
  ctx.beginPath();
  ctx.moveTo(0, -14);
  ctx.bezierCurveTo(42, -14, 48, 20, 42, 42);
  ctx.bezierCurveTo(36, 60, -36, 60, -42, 42);
  ctx.bezierCurveTo(-48, 20, -42, -14, 0, -14);
  ctx.closePath();
  ctx.fillStyle = '#FFFFFF'; ctx.fill();
  ctx.lineWidth = 3.6; ctx.strokeStyle = LINE; ctx.stroke();
  /* 黑肚兜 */
  ctx.beginPath(); ctx.ellipse(0, 30, 24, 19, 0, 0, TAU);
  ctx.fillStyle = '#111111'; ctx.fill();
  ctx.lineWidth = 2.8; ctx.strokeStyle = LINE; ctx.stroke();

  /* ---- 大金链子：加粗，珠子更大 ---- */
  const chainY = -4;
  ctx.strokeStyle = '#7A5608'; ctx.lineWidth = 7.5;
  ctx.beginPath();
  ctx.moveTo(-30, chainY - 4);
  ctx.quadraticCurveTo(0, chainY + 26, 30, chainY - 4);
  ctx.stroke();
  for (let i = 0; i <= 14; i++) {
    const t = i / 14;
    const bx = -30 + t * 60;
    const by = chainY - 4 + Math.sin(t * Math.PI) * 30;
    ctx.beginPath(); ctx.arc(bx, by, 4.2, 0, TAU);
    const cg = ctx.createRadialGradient(bx - 1.5, by - 1.6, 0.4, bx, by, 4.6);
    cg.addColorStop(0, '#FFF6C0'); cg.addColorStop(0.45, '#F7C948'); cg.addColorStop(1, '#A87508');
    ctx.fillStyle = cg; ctx.fill();
    ctx.lineWidth = 1.2; ctx.strokeStyle = '#6B4A06'; ctx.stroke();
  }
  /* 金牌：加大 */
  const mx = 0, my = chainY + 30;
  ctx.beginPath();
  ctx.moveTo(mx - 18, my - 13);
  ctx.quadraticCurveTo(mx, my - 21, mx + 18, my - 13);
  ctx.quadraticCurveTo(mx + 15, my + 15, mx, my + 21);
  ctx.quadraticCurveTo(mx - 15, my + 15, mx - 18, my - 13);
  ctx.closePath();
  const mg = ctx.createLinearGradient(mx - 18, my - 18, mx + 18, my + 18);
  mg.addColorStop(0, '#FFF8CC'); mg.addColorStop(0.42, '#F7C948'); mg.addColorStop(1, '#A87508');
  ctx.fillStyle = mg; ctx.fill();
  ctx.lineWidth = 3; ctx.strokeStyle = '#6B4A06'; ctx.stroke();
  ctx.lineWidth = 1.6; ctx.strokeStyle = 'rgba(255,252,220,.9)';
  ctx.beginPath();
  ctx.moveTo(mx - 12, my - 9);
  ctx.quadraticCurveTo(mx, my - 16, mx + 12, my - 9);
  ctx.stroke();
  ctx.fillStyle = '#5A3D04';
  ctx.font = 'bold 21px "Microsoft YaHei",sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('發', mx, my + 3);

  /* ---- 耳朵 ---- */
  [-1, 1].forEach(function (sg) {
    ctx.beginPath(); ctx.arc(sg * 31, -60, 15, 0, TAU);
    ctx.fillStyle = '#111111'; ctx.fill();
    ctx.lineWidth = 3.2; ctx.strokeStyle = LINE; ctx.stroke();
  });

  /* ---- 脸：加大 ---- */
  ctx.beginPath();
  ctx.moveTo(0, -70);
  ctx.bezierCurveTo(34, -70, 40, -46, 38, -26);
  ctx.bezierCurveTo(36, -6, -36, -6, -38, -26);
  ctx.bezierCurveTo(-40, -46, -34, -70, 0, -70);
  ctx.closePath();
  ctx.fillStyle = '#FFFFFF'; ctx.fill();
  ctx.lineWidth = 3.8; ctx.strokeStyle = LINE; ctx.stroke();

  /* ---- 黑眼罩：这是熊猫的招牌，去掉就不像熊猫了 ----
       墨镜直接戴在眼罩上，靠亮镜框和镜面反光把两者分开。 ---- */
  ctx.fillStyle = '#111111';
  ctx.beginPath(); ctx.ellipse(-15, -43, 14, 15, -0.32, 0, TAU); ctx.fill();
  ctx.beginPath(); ctx.ellipse(15, -43, 14, 15, 0.32, 0, TAU); ctx.fill();
  /* 眼罩里留一点眼神，不然整块死黑 */
  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath(); ctx.ellipse(-15, -41, 7.6, 4.6, -0.32, 0, TAU); ctx.fill();
  ctx.beginPath(); ctx.ellipse(15, -41, 7.6, 4.6, 0.32, 0, TAU); ctx.fill();
  ctx.fillStyle = '#111111';
  ctx.beginPath(); ctx.arc(-15 + glare * 0.6, -40 + smug * 0.9, 2.9, 0, TAU); ctx.fill();
  ctx.beginPath(); ctx.arc(15 + glare * 0.6, -40 + smug * 0.9, 2.9, 0, TAU); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,.9)';
  ctx.beginPath(); ctx.arc(-16 + glare * 0.6, -41.2, 1.1, 0, TAU); ctx.fill();
  ctx.beginPath(); ctx.arc(14 + glare * 0.6, -41.2, 1.1, 0, TAU); ctx.fill();

  /* ---- 粗眉：往中间压，凶 ---- */
  ctx.strokeStyle = '#111111'; ctx.lineWidth = 4; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(-29, -58); ctx.lineTo(-6, -53); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(29, -58); ctx.lineTo(6, -53); ctx.stroke();

  /* ---- 墨镜：推到鼻梁下方，露着眼睛 ---- */
  const GY = -42 + smug * 0.8;
  const lens = function (sg) {
    ctx.beginPath();
    ctx.moveTo(sg * 27, GY - 6);
    ctx.quadraticCurveTo(sg * 15, GY - 12, sg * 4, GY - 8);
    ctx.quadraticCurveTo(sg * 3, GY + 5, sg * 14, GY + 10);
    ctx.quadraticCurveTo(sg * 25, GY + 11, sg * 27.5, GY + 1);
    ctx.closePath();
    const lg = ctx.createLinearGradient(sg * 4, GY - 11, sg * 27, GY + 11);
    lg.addColorStop(0, '#44444F'); lg.addColorStop(0.42, '#15151C'); lg.addColorStop(1, '#08080C');
    ctx.fillStyle = lg; ctx.fill();
    ctx.lineWidth = 2.8; ctx.strokeStyle = '#F2F2F8'; ctx.stroke();
    ctx.save(); ctx.clip();
    ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 3.6; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(sg * 6, GY + 12); ctx.lineTo(sg * 21, GY - 12); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,.45)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(sg * 14, GY + 13); ctx.lineTo(sg * 27, GY - 6); ctx.stroke();
    ctx.restore();
  };
  lens(-1); lens(1);
  ctx.fillStyle = '#15151C';
  ctx.beginPath(); ctx.rect(-5, GY - 7, 10, 4); ctx.fill();
  ctx.lineWidth = 2.4; ctx.strokeStyle = '#F2F2F8'; ctx.stroke();
  ctx.strokeStyle = '#F2F2F8'; ctx.lineWidth = 2.8; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(-27, GY - 3); ctx.lineTo(-39, GY - 9); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(27, GY - 3); ctx.lineTo(39, GY - 9); ctx.stroke();
  ctx.strokeStyle = 'rgba(17,17,17,.5)'; ctx.lineWidth = 5;
  ctx.beginPath(); ctx.moveTo(-27, GY + 1); ctx.lineTo(-39, GY - 5); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(27, GY + 1); ctx.lineTo(39, GY - 5); ctx.stroke();

  /* ---- 鼻子 ---- */
  ctx.fillStyle = '#111111';
  ctx.beginPath(); ctx.ellipse(0, -22, 7, 4.8, 0, 0, TAU); ctx.fill();

  /* ---- 嘴：叼着雪茄的那侧被顶住，另一边冷笑上扬 ---- */
  const mOpen = kind === 'cheer' ? 11 : kind === 'dance' ? 6 : 0;
  ctx.strokeStyle = '#111111'; ctx.lineWidth = 3.2; ctx.lineCap = 'round';
  if (mOpen) {
    ctx.beginPath();
    ctx.moveTo(-13, -12);
    ctx.quadraticCurveTo(0, -12 + mOpen * 2.3, 16, -16);
    ctx.quadraticCurveTo(2, -6, -13, -12);
    ctx.closePath();
    ctx.fillStyle = '#3A1A1A'; ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(-6, -14, 5.6, 5.6);
    ctx.fillRect(2, -15, 5.2, 5.2);
  } else {
    /* 冷笑：嘴角往一边翘 */
    ctx.beginPath();
    ctx.moveTo(-13, -11);
    ctx.quadraticCurveTo(1, -6, 16, -14);
    ctx.stroke();
  }

  /* ---- 粗雪茄：比细烟粗一圈，末端斜切 ---- */
  const cigAng = 1.0;
  ctx.save();
  ctx.translate(8, -12);
  ctx.rotate(cigAng);
  ctx.fillStyle = '#6B4A2A';
  ctx.beginPath(); ctx.rect(0, -4.6, 21, 9.2);
  ctx.fill(); ctx.lineWidth = 2.6; ctx.strokeStyle = LINE; ctx.stroke();
  ctx.fillStyle = '#8A6236';
  ctx.beginPath(); ctx.rect(0, -4.6, 21, 3); ctx.fill();
  ctx.fillStyle = '#3A2510';
  ctx.beginPath(); ctx.rect(16, -4.6, 5, 9.2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = 'rgba(255,110,40,' + (0.6 + 0.4 * Math.abs(Math.sin(p * TAU * 3))) + ')';
  ctx.beginPath(); ctx.arc(21, 0, 4.6, 0, TAU); ctx.fill();
  ctx.fillStyle = 'rgba(255,220,120,.9)';
  ctx.beginPath(); ctx.arc(21, 0, 2.2, 0, TAU); ctx.fill();
  ctx.restore();

  /* ---- 手臂：画在身体之上，一只手垂在两侧 ---- */
  const rise = q.arm * 6;
  [-1, 1].forEach(function (sg) {
    const shX = sg * 38, shY = -4;
    const elX = sg * 52, elY = 14 + rise * 0.3;
    const hx = sg * 52, hy = 26 - rise;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    [[shX, shY, elX, elY, 16], [elX, elY, hx, hy, 14]].forEach(function (a) {
      ctx.strokeStyle = LINE; ctx.lineWidth = a[4] + 3;
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(a[2], a[3]); ctx.stroke();
      ctx.strokeStyle = '#111111'; ctx.lineWidth = a[4];
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(a[2], a[3]); ctx.stroke();
    });
    /* 拳头 */
    ctx.beginPath(); ctx.ellipse(hx, hy, 9, 8.5, 0, 0, TAU);
    ctx.fillStyle = '#111111'; ctx.fill();
    ctx.lineWidth = 2.8; ctx.strokeStyle = LINE; ctx.stroke();
    [[-7, -2.5], [7, -2.5]].forEach(function (k) {
      ctx.beginPath(); ctx.arc(hx + k[0], hy + k[1], 4, 0, TAU);
      ctx.fillStyle = '#111111'; ctx.fill();
      ctx.lineWidth = 2.2; ctx.strokeStyle = LINE; ctx.stroke();
    });
    /* 中指：又长又粗还往外撇 —— 太细太短的话缩到桌面上就只剩个小凸起，
       根本看不出在比中指。让中指长度接近拳头直径的两倍。 */
    const out = sg * 5;
    const half = 4.6;
    ctx.beginPath();
    ctx.moveTo(hx - half, hy - 2);
    ctx.lineTo(hx + out - half, hy - 34);
    ctx.quadraticCurveTo(hx + out, hy - 43, hx + out + half, hy - 34);
    ctx.lineTo(hx + half, hy - 2);
    ctx.closePath();
    ctx.fillStyle = '#111111'; ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = LINE; ctx.stroke();
    /* 指节纹路 */
    ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 1.8;
    [10, 18, 26, 33].forEach(function (dy) {
      const k = (hy - dy - (hy - 2)) / (hy - 40 - (hy - 2));
      const cx = hx + out * k;
      ctx.beginPath();
      ctx.moveTo(cx - half + 1, hy - dy);
      ctx.lineTo(cx + half - 1, hy - dy);
      ctx.stroke();
    });
    /* 金戒指：套在中指根部 */
    ctx.beginPath(); ctx.ellipse(hx + sg * 0.4, hy - 6, 6.4, 3, sg * 0.12, 0, TAU);
    const rg = ctx.createLinearGradient(hx - 5, hy + 14, hx + 5, hy + 19);
    rg.addColorStop(0, '#FFF2B0'); rg.addColorStop(0.5, '#F0C43A'); rg.addColorStop(1, '#A87508');
    ctx.fillStyle = rg; ctx.fill();
    ctx.lineWidth = 1.4; ctx.strokeStyle = '#6B4A06'; ctx.stroke();
  });

  /* ---- 雪茄烟：粗烟柱 + 飘散的烟圈 ---- */
  const tipX = 8 + Math.cos(cigAng) * 21, tipY = -12 + Math.sin(cigAng) * 21;
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = '#B9B9B9';
  for (let i = 0; i < 3; i++) {
    const t = (smoke + i * 0.33) % 1;
    ctx.beginPath();
    ctx.arc(tipX + t * 30, tipY - t * 34, 4 + t * 9, 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  for (let i = 0; i < 4; i++) {
    const t = (smoke + i * 0.25) % 1;
    ctx.globalAlpha = (1 - t) * (kind === 'idle' ? 0.7 : 0.4);
    ctx.strokeStyle = '#9A9A9A'; ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.arc(tipX + 4 + t * 30, tipY - 12 - t * 34, 3 + t * 7, 0, TAU);
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
/* 派大星：宽圆身体 + 手举泡泡棒吹泡泡
   表情沿用上一版（紫眼皮、飘忽瞳孔、张嘴吐舌、挂口水）—— 那版表情已经得到认可。
   身体改动：之前画成了窄锥形，实际是「下方宽圆、上方收成圆钝圆顶」的海星体。
   吹泡泡改动：手里举一根泡泡棒，泡泡从棒上的圆环里飘出来，不是凭空从嘴边冒。 */
function drawStar(ctx, q, p, kind) {
  const LINE = '#C4607A';
  const PINK = '#F79FB0';
  const PINK_D = '#EE8AA0';
  const LID = '#9B7BD4';
  const look = Math.sin(p * TAU) * 1.8;
  const blow = kind === 'cheer' ? 1 : kind === 'dance' ? 0.7 : 0.35;
  const derp = Math.sin(p * TAU * 1.5) * (kind === 'idle' ? 1.2 : 2.2);
  shadow(ctx, 60, 30);

  /* ---- 左手：自然垂在身侧 ---- */
  const la = -0.1 - q.arm * 0.5;
  const lx = -30 - Math.cos(la) * 14, ly = 10 + Math.sin(la) * 20;
  ctx.lineCap = 'round';
  ctx.strokeStyle = LINE; ctx.lineWidth = 18;
  ctx.beginPath(); ctx.moveTo(-24, 2); ctx.lineTo(lx, ly); ctx.stroke();
  ctx.strokeStyle = PINK; ctx.lineWidth = 15;
  ctx.beginPath(); ctx.moveTo(-24, 2); ctx.lineTo(lx, ly); ctx.stroke();
  ctx.fillStyle = PINK;
  ctx.beginPath(); ctx.arc(lx, ly, 8.4, 0, TAU); ctx.fill();
  ctx.strokeStyle = LINE; ctx.lineWidth = 2; ctx.stroke();

  /* ---- 两条短腿 + 指甲 ---- */
  [-1, 1].forEach(function (sgn) {
    ctx.fillStyle = PINK_D;
    ctx.beginPath();
    ctx.moveTo(sgn * 17, 28);
    ctx.quadraticCurveTo(sgn * 28, 46, sgn * 15, 54);
    ctx.quadraticCurveTo(sgn * 3, 50, sgn * 5, 32);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = LINE; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = '#F2E7C8';
    ctx.beginPath(); ctx.ellipse(sgn * 17, 51, 3.4, 2.4, sgn * 0.3, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#C9A96A'; ctx.lineWidth = 1; ctx.stroke();
  });

  /* ---- 头身：宽圆的整块海星体（下方宽、上方收成圆钝的圆顶） ---- */
  const g = ctx.createLinearGradient(0, -70, 0, 38);
  g.addColorStop(0, '#FBAEC0'); g.addColorStop(0.45, PINK); g.addColorStop(1, PINK_D);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(0, -70);
  ctx.bezierCurveTo(20, -66, 30, -48, 33, -30);      // 圆钝的头顶
  ctx.bezierCurveTo(38, -12, 41, 8, 37, 24);         // 身体最宽处
  ctx.bezierCurveTo(33, 40, 18, 46, 0, 46);          // 宽圆的下半
  ctx.bezierCurveTo(-18, 46, -33, 40, -37, 24);
  ctx.bezierCurveTo(-41, 8, -38, -12, -33, -30);
  ctx.bezierCurveTo(-30, -48, -20, -66, 0, -70);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = LINE; ctx.lineWidth = 2.4; ctx.stroke();

  /* ---- 绿短裤 ---- */
  ctx.beginPath();
  ctx.moveTo(-31, 22); ctx.quadraticCurveTo(0, 32, 31, 22);
  ctx.lineTo(34, 42); ctx.quadraticCurveTo(0, 50, -34, 42);
  ctx.closePath();
  const sg = ctx.createLinearGradient(0, 22, 0, 46);
  sg.addColorStop(0, '#A8DE5C'); sg.addColorStop(1, '#8CC843');
  ctx.fillStyle = sg; ctx.fill();
  ctx.strokeStyle = '#5E8F2A'; ctx.lineWidth = 2.2; ctx.stroke();
  [[-17, 31], [17, 31], [0, 39]].forEach(function (pt) {
    ctx.fillStyle = '#A97FE0';
    for (let k = 0; k < 5; k++) {
      const a = k / 5 * TAU - Math.PI / 2;
      ctx.beginPath();
      ctx.ellipse(pt[0] + Math.cos(a) * 3.2, pt[1] + Math.sin(a) * 3.2, 2.3, 2.3, 0, 0, TAU);
      ctx.fill();
    }
    ctx.fillStyle = '#F0DFFF';
    ctx.beginPath(); ctx.arc(pt[0], pt[1], 1.6, 0, TAU); ctx.fill();
  });

  /* ---- 浅色肚皮 ---- */
  ctx.fillStyle = 'rgba(255,214,224,.85)';
  ctx.beginPath(); ctx.ellipse(0, 12, 21, 19, 0, 0, TAU); ctx.fill();
  ctx.fillStyle = 'rgba(214,110,138,.5)';
  [[-26, -8], [26, -6], [-20, 24], [21, 25], [-29, -28], [29, -27]].forEach(function (pt) {
    ctx.beginPath(); ctx.ellipse(pt[0], pt[1], 1.9, 2.3, 0, 0, TAU); ctx.fill();
  });

  /* ---- 眼睛：白眼球 + 紫色厚眼皮（派大星的灵魂，保持不变） ---- */
  const eyY = -28, er = 10.5;
  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath(); ctx.ellipse(-11.5, eyY, er, er * 1.05, 0, 0, TAU); ctx.fill();
  ctx.beginPath(); ctx.ellipse(11.5, eyY, er, er * 1.05, 0, 0, TAU); ctx.fill();
  ctx.strokeStyle = LINE; ctx.lineWidth = 1.8;
  ctx.beginPath(); ctx.ellipse(-11.5, eyY, er, er * 1.05, 0, 0, TAU); ctx.stroke();
  ctx.beginPath(); ctx.ellipse(11.5, eyY, er, er * 1.05, 0, 0, TAU); ctx.stroke();
  ctx.fillStyle = '#1D1D22';
  ctx.beginPath(); ctx.arc(-11.5 + look * 1.4, eyY - 2.4 + derp * 0.6, 3.6, 0, TAU); ctx.fill();
  ctx.beginPath(); ctx.arc(11.5 - look * 1.4, eyY - 3.0 - derp * 0.6, 3.6, 0, TAU); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,.9)';
  ctx.beginPath(); ctx.arc(-12.6 + look * 1.4, eyY - 3.6 + derp * 0.6, 1.3, 0, TAU); ctx.fill();
  ctx.beginPath(); ctx.arc(10.4 - look * 1.4, eyY - 4.2 - derp * 0.6, 1.3, 0, TAU); ctx.fill();
  ctx.fillStyle = LID;
  ctx.beginPath(); ctx.ellipse(-11.5, eyY - 4.2, er + 0.6, 6.2, 0, Math.PI, TAU); ctx.fill();
  ctx.beginPath(); ctx.ellipse(11.5, eyY - 4.2, er + 0.6, 6.2, 0, Math.PI, TAU); ctx.fill();
  ctx.strokeStyle = '#7C5EB8'; ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.moveTo(-22, eyY - 4.2); ctx.lineTo(-1, eyY - 4.2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(1, eyY - 4.2); ctx.lineTo(22, eyY - 4.2); ctx.stroke();

  /* ---- 粗眉 ---- */
  ctx.strokeStyle = '#E06A8C'; ctx.lineWidth = 3.4; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(-20, -43 + derp * 0.5); ctx.lineTo(-4, -40 + derp * 0.5); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(20, -43 - derp * 0.5); ctx.lineTo(4, -40 - derp * 0.5); ctx.stroke();

  /* ---- 嘴：嘟起来吹泡泡 ---- */
  const mw = 7 + blow * 2.5, mh = 6 + blow * 4;
  ctx.beginPath();
  ctx.ellipse(0, -10 + derp * 0.4, mw, mh, 0, 0, TAU);
  ctx.fillStyle = '#8E3B52'; ctx.fill();
  ctx.strokeStyle = LINE; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = '#FF7B8A';
  ctx.beginPath(); ctx.ellipse(0, -7.5 + blow * 2 + derp * 0.4, mw * 0.56, mh * 0.42, 0, 0, TAU); ctx.fill();
  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath(); ctx.rect(-4.6, -15 + derp * 0.4, 3.8, 3.4); ctx.fill();
  ctx.beginPath(); ctx.rect(0.9, -15 + derp * 0.4, 3.8, 3.4); ctx.fill();

  /* ---- 口水（呆傻感的点睛之笔） ---- */
  if (kind !== 'cheer') {
    const drool = 4 + (Math.sin(p * TAU * 2) * 0.5 + 0.5) * 6;
    ctx.fillStyle = 'rgba(180,230,255,.85)';
    ctx.beginPath();
    ctx.moveTo(8, -4);
    ctx.quadraticCurveTo(11.5, drool * 0.6 - 2, 8.5, drool - 4);
    ctx.quadraticCurveTo(5.5, drool * 0.6 - 2, 5.5, -4);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.7)';
    ctx.beginPath(); ctx.arc(7.2, drool - 5.4, 1.7, 0, TAU); ctx.fill();
  }

  /* ---- 右手：举着泡泡棒 ---- */
  const ra = -1.35 - q.arm * 0.55;
  const rx = 30 + Math.cos(ra) * 24, ry = -2 + Math.sin(ra) * 24;
  ctx.strokeStyle = LINE; ctx.lineWidth = 18;
  ctx.beginPath(); ctx.moveTo(26, 4); ctx.lineTo(rx, ry); ctx.stroke();
  ctx.strokeStyle = PINK; ctx.lineWidth = 15;
  ctx.beginPath(); ctx.moveTo(26, 4); ctx.lineTo(rx, ry); ctx.stroke();
  ctx.fillStyle = PINK;
  ctx.beginPath(); ctx.arc(rx, ry, 8.4, 0, TAU); ctx.fill();
  ctx.strokeStyle = LINE; ctx.lineWidth = 2; ctx.stroke();

  /* 泡泡棒：小杆 + 圆环（画醒目点，不然会被泡泡糊住看不见） */
  const tipX = rx + 6, tipY = ry - 32;
  ctx.lineCap = 'round';
  ctx.strokeStyle = LINE; ctx.lineWidth = 6.4;
  ctx.beginPath(); ctx.moveTo(rx + 1, ry - 1); ctx.lineTo(tipX, tipY + 9); ctx.stroke();
  ctx.strokeStyle = '#EAF7FF'; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(rx + 1, ry - 1); ctx.lineTo(tipX, tipY + 9); ctx.stroke();
  const ringX = tipX, ringY = tipY;
  ctx.fillStyle = 'rgba(205,238,255,.5)';
  ctx.beginPath(); ctx.arc(ringX, ringY, 10.5, 0, TAU); ctx.fill();
  ctx.strokeStyle = LINE; ctx.lineWidth = 5.4;
  ctx.beginPath(); ctx.arc(ringX, ringY, 10.5, 0, TAU); ctx.stroke();
  ctx.strokeStyle = '#6FBEE4'; ctx.lineWidth = 3.2;
  ctx.beginPath(); ctx.arc(ringX, ringY, 10.5, 0, TAU); ctx.stroke();

  /* ---- 泡泡：从圆环里被吹出来，越飘越大 ---- */
  for (let i = 0; i < 4; i++) {
    const t = (p * 1.8 + i * 0.25) % 1;
    const r = (3.2 + i * 2.1) * (1 + blow * 0.45);
    const bx = ringX + Math.sin(t * 4 + i) * 8 + t * 12;
    const by = ringY - 16 - t * 44;
    const fade = t > 0.8 ? (1 - t) / 0.2 : 1;
    ctx.globalAlpha = Math.min(1, fade * (0.6 + blow * 0.4));
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    ctx.beginPath(); ctx.arc(bx, by, r, 0, TAU); ctx.fill();
    ctx.lineWidth = 1.8;
    ctx.strokeStyle = 'rgba(120,196,240,.95)';
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
