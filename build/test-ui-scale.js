/* =========================================================================
   test-ui-scale.js —— DPI 适配算法的验证脚本（Node 直接跑，不依赖 Electron）
   -------------------------------------------------------------------------
   跑法：  node build/test-ui-scale.js
   目的：不启动应用就能核对「界面尺寸在多屏/多缩放下的行为」。

   现役模型（见 ui-scale.js 里那段长注释）：k ≡ 1 —— 主界面和宠物一律按逻辑
   像素(DIP)定尺寸，跟着系统缩放走，而不是追求「物理像素恒定」（那套已废掉，
   它会让高 DPI 屏上的界面反而变小）。

   所以脚本按真实链路建模：
     显示器像素比 → k≡1 → 窗口逻辑尺寸(DIP) → 页面 scale → 出屏物理尺寸
   其中「出屏物理尺寸 = CSS 内容尺寸 × 该屏像素比」，这是唯一真实的物理量。

   判据（不通过就退出码 1）：
     1. k 恒为 1：窗口逻辑尺寸不随 DPI 变化（屏幕装不下时才按可用区收缩）
     2. 窗口逻辑尺寸永远放得进该屏可用区
     3. 内容 scale 永不放大（s ≤ 1）且内容不溢出窗口
     4. 跨屏重排只做可用区限位，尺寸不变
     5. 宠物窗逻辑尺寸恒为 150×170 DIP，角色出屏物理尺寸恒为 150 物理像素
   ========================================================================= */
'use strict';

const U = require('../ui-scale.js');

const DESIGN = U.DESIGN;
const CONTENT_H = DESIGN.contentH;      // 内容设计高
const TITLEBAR = 38;                    // 标题栏布局高（DIP，k≡1 所以不随屏变）
const WORK_H_RATIO = 0.955;             // 粗略扣掉任务栏，仅用于本轮建模
const PET_BASE_FIT = 220;               // pet.js 里的 BASE_FIT：越小角色越大

/* 屏幕矩阵：物理分辨率 + Windows 缩放 + 对角线。
   dpr 取「该屏在 Windows 里的像素比」，Chromium 的 devicePixelRatio 就是它。 */
const SCREENS = [
  { name: '1K 1920x1080', w: 1920, h: 1080, dpr: 1.00, inch: 24 },
  { name: '1K 1920x1080', w: 1920, h: 1080, dpr: 1.25, inch: 24 },
  { name: '1K 1920x1080', w: 1920, h: 1080, dpr: 1.50, inch: 15.6 },
  { name: '2K 2560x1440', w: 2560, h: 1440, dpr: 1.00, inch: 27 },   // ← 应用基准屏
  { name: '2K 2560x1440', w: 2560, h: 1440, dpr: 1.25, inch: 27 },
  { name: '2K 2560x1600', w: 2560, h: 1600, dpr: 1.50, inch: 16 },   // ← 本机主屏
  { name: '2K 2048x1152', w: 2048, h: 1152, dpr: 1.00, inch: 24 },   // ← 本机副屏
  { name: '4K 3840x2160', w: 3840, h: 2160, dpr: 1.00, inch: 27 },   // 用户报的极端情况
  { name: '4K 3840x2160', w: 3840, h: 2160, dpr: 1.50, inch: 27 },
  { name: '4K 3840x2160', w: 3840, h: 2160, dpr: 2.00, inch: 27 },
  { name: '4K 3840x2160', w: 3840, h: 2160, dpr: 2.00, inch: 15.6 },
  { name: '5K 5120x2880', w: 5120, h: 2880, dpr: 2.00, inch: 27 }
];

/* 基准屏 = 应用第一次跑起来时所在的主显示器。k 恒为 1 之后，基准是谁都不影响结果。 */
const BASE = SCREENS.find(s => s.name === '2K 2560x1440' && s.dpr === 1.00);
const BASE_DPR = BASE.dpr;

function workAreaOf(scr) {
  return {
    x: 0, y: 0,
    width: Math.round(scr.w / scr.dpr),
    height: Math.round(scr.h / scr.dpr * WORK_H_RATIO)
  };
}

/* 按真实链路算一台屏幕上的结果 */
function simulate(scr) {
  const k = U.computeUiScale(scr.dpr, BASE_DPR);
  const wa = workAreaOf(scr);

  /* 主进程：窗口逻辑尺寸(DIP) = 设计尺寸 ÷ k；k≡1 所以永远是设计尺寸，
     只有可用区比它还小时才被 clampBox 收缩 */
  const box = U.windowBox(k).main;
  const fitted = U.clampBox(0, 0, box.width, box.height, wa);

  /* 渲染进程：内容 scale = min(可用/设计, 1) × k；标题栏布局高按 1/k（下限 20 DIP） */
  const tbH = Math.max(20, Math.round(TITLEBAR / k));
  const availW = Math.max(1, fitted.width);
  const availH = Math.max(1, fitted.height - tbH);
  const s = U.computeContentScale(availW, availH, k, DESIGN.winW * k, CONTENT_H * k);

  /* 真实物理量：内容 CSS 尺寸 = 设计尺寸 × s，物理 = × 该屏像素比 */
  const physW = Math.round(DESIGN.winW * s * scr.dpr);
  const physH = Math.round(CONTENT_H * s * scr.dpr);
  const petBox = U.petWindowBox(DESIGN.petW, DESIGN.petH, k);
  /* 宠物角色出屏物理宽：pet.js 里 pet.fit = BASE_FIT × k × dpr，fit 越小角色越大 */
  const charPhys = petBox.width * (PET_BASE_FIT / (PET_BASE_FIT * k * scr.dpr)) * scr.dpr;

  const canHoldW = wa.width >= DESIGN.winW;
  const canHoldH = wa.height >= DESIGN.winH;
  return {
    k, tbH, boxW: fitted.width, boxH: fitted.height, scale: s,
    physW, physH, petBox, charPhys,
    fitsW: fitted.width <= wa.width, fitsH: fitted.height <= wa.height,
    canHold: canHoldW && canHoldH,
    /* 内容永远不溢出窗口（0.35 地板兜底的极端小窗口除外） */
    contFits: (Math.abs(s - 0.35) < 1e-9) ||
      (DESIGN.winW * s <= availW + 1 && CONTENT_H * s <= availH + 1),
    pctOfScreen: (physW / scr.w * 100)
  };
}

const base = simulate(BASE);

console.log('='.repeat(118));
console.log('界面 DPI 适配验证 —— 基准屏 ' + BASE.name + ' @' + (BASE.dpr * 100) + '%（k 恒为 1，按 DIP 定尺寸）');
console.log('基准屏出屏物理尺寸：' + base.physW + ' × ' + base.physH + ' 物理像素（内容块），窗口 ' +
  base.boxW + '×' + base.boxH + ' DIP');
console.log('='.repeat(118));
console.log(
  pad('屏幕', 16) + pad('像素比', 8) + pad('k', 7) + pad('窗口(DIP)', 12) +
  pad('页面scale', 10) + pad('内容物理', 12) + pad('占屏宽', 8) +
  pad('宠物角色物理', 14) + '结论'
);
console.log('-'.repeat(118));

let fails = 0;
for (const scr of SCREENS) {
  const r = simulate(scr);
  const okK = Math.abs(r.k - 1) < 1e-9;
  const okFit = r.fitsW && r.fitsH;
  const okScale = r.scale <= 1 + 1e-9 && r.contFits;
  /* 屏幕装得下时，窗口逻辑尺寸必须正好是设计尺寸（不随 DPI 变） */
  const okDip = !r.canHold || (r.boxW === DESIGN.winW && r.boxH === DESIGN.winH);
  if (!okK || !okFit || !okScale || !okDip) fails++;
  const verdict =
    (!okK ? 'k≠1 ' : '') +
    (!okFit ? '窗口超出可用区 ' : '') +
    (!okScale ? '内容放大/溢出 ' : '') +
    (!okDip ? '窗口DIP≠设计尺寸 ' : '') +
    (okK && okFit && okScale && okDip ? 'OK' : '<<< FAIL');

  console.log(
    pad(scr.name, 16) + pad(scr.dpr.toFixed(2), 8) + pad(r.k.toFixed(3), 7) +
    pad(r.boxW + '×' + r.boxH, 12) + pad(r.scale.toFixed(3), 10) +
    pad(r.physW + '×' + r.physH, 12) + pad(r.pctOfScreen.toFixed(0) + '%', 8) +
    pad(r.charPhys.toFixed(0) + 'px', 14) + verdict
  );
}

/* ---- 换屏重排（主窗口）：k≡1，跨屏不改尺寸，只做可用区限位 ------------------------- */
console.log('');
console.log('='.repeat(118));
console.log('跨屏重排：k≡1，窗口逻辑尺寸不随屏变化；只有可用区装不下时才被收缩');
console.log('='.repeat(118));
for (const scr of SCREENS) {
  const kTo = U.computeUiScale(scr.dpr, BASE_DPR);
  const from = { x: 100, y: 100, width: DESIGN.winW, height: DESIGN.winH };
  const wa = workAreaOf(scr);
  const moved = U.rescaleBox(from, 1, kTo, wa, 'topleft');
  const wantW = Math.min(DESIGN.winW, wa.width);
  const wantH = Math.min(DESIGN.winH, wa.height);
  const okW = moved.width === wantW;
  const okH = moved.height === wantH;
  const inside = moved.x >= wa.x && moved.y >= wa.y &&
    moved.x + moved.width <= wa.x + wa.width && moved.y + moved.height <= wa.y + wa.height;
  if (!okW || !okH || !inside) fails++;
  console.log(
    pad(scr.name + ' @' + (scr.dpr * 100).toFixed(0) + '%', 24) +
    pad('k=' + kTo.toFixed(3), 12) +
    pad('重排后 ' + moved.width + '×' + moved.height, 20) +
    pad('期望 ' + wantW + '×' + wantH, 18) +
    (okW && okH && inside ? 'OK' : '<<< FAIL')
  );
}

/* ---- rescaleBox 的物理守恒：宠物窗跨屏重排仍在用这条路径 ---------------------------- */
console.log('');
const wa2 = { x: 0, y: 0, width: 1920, height: 1200 };
const manual = { x: 200, y: 150, width: 1400, height: 900 };        // 一块屏上的 1400×900
const toBig = U.rescaleBox(manual, 1, 2, wa2, 'topleft');
const back = U.rescaleBox(toBig, 2, 1, wa2, 'topleft');
const okManual = Math.abs(toBig.width * 2 - manual.width * 1) <= 2 &&
  back.width === manual.width && back.height === manual.height &&
  back.x === manual.x && back.y === manual.y;
if (!okManual) fails++;
console.log('rescaleBox 物理守恒：1400×900(因子1) → 换到因子2 的屏：' + toBig.width + '×' + toBig.height +
  ' DIP（物理 ' + toBig.width * 2 + '，原 ' + manual.width + '）→ 换回：' + back.width + '×' + back.height +
  (okManual ? '  OK 物理守恒且可逆' : '  <<< FAIL'));

/* ---- 宠物窗：逻辑尺寸恒为 150×170 DIP，角色出屏物理恒定 150 物理像素 --------------- */
console.log('');
console.log('='.repeat(118));
console.log('宠物窗：逻辑尺寸应恒为 ' + DESIGN.petW + '×' + DESIGN.petH + ' DIP；' +
  '角色出屏物理宽应恒为 ' + DESIGN.petW + ' 物理像素（pet.js 的 fit 里 k×dpr 正好抵消）');
console.log('='.repeat(118));
for (const scr of SCREENS) {
  const k = U.computeUiScale(scr.dpr, BASE_DPR);
  const box = U.petWindowBox(DESIGN.petW, DESIGN.petH, k);
  const charPhys = box.width * (PET_BASE_FIT / (PET_BASE_FIT * k * scr.dpr)) * scr.dpr;
  const okBox = box.width === DESIGN.petW && box.height === DESIGN.petH;
  const dev = Math.abs(charPhys - DESIGN.petW) / DESIGN.petW;
  if (!okBox || dev > 0.03) fails++;
  console.log(
    pad(scr.name + ' @' + (scr.dpr * 100).toFixed(0) + '%', 24) + pad('k=' + k.toFixed(3), 12) +
    pad('窗口 ' + box.width + '×' + box.height + ' DIP', 22) +
    pad('角色 ' + charPhys.toFixed(0) + 'px', 16) +
    (okBox && dev <= 0.03 ? 'OK' : '<<< FAIL' +
      (!okBox ? ' 窗口≠设计尺寸' : ' 角色偏差 ' + (dev * 100).toFixed(1) + '%'))
  );
}

console.log('');
console.log('='.repeat(118));
console.log(fails === 0 ? '全部通过 ✅' : ('有 ' + fails + ' 项未通过 ❌'));
console.log('='.repeat(118));
process.exit(fails === 0 ? 0 : 1);

function pad(s, n) {
  s = String(s);
  while (s.length < n) s += ' ';
  return s;
}
