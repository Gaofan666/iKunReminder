/* =========================================================================
   test-ui-scale.js —— DPI 适配算法的验证脚本（Node 直接跑，不依赖 Electron）
   -------------------------------------------------------------------------
   跑法：  node build/test-ui-scale.js
   目的：不启动应用就能核对「界面物理大小是否恒定」。
        脚本按真实链路建模：
          显示器像素比 → k → 窗口逻辑尺寸(DIP) → 页面 scale → 出屏物理尺寸
        其中「出屏物理尺寸 = CSS 内容尺寸 × 该屏像素比」，这是唯一真实的物理量。

   判据（不通过就退出码 1）：
     1. 各分辨率 × 各缩放下，界面出屏物理宽度一致（误差 ≤ 2.5%）
     2. 窗口逻辑尺寸永远放得进该屏可用区，且 k ≥ 1
     3. 跨屏重排/换回，物理尺寸守恒且可逆（用户手动拉过窗口也一样）
     4. 宠物窗的物理尺寸恒为 150×170
   ========================================================================= */
'use strict';

const U = require('../ui-scale.js');

const DESIGN = U.DESIGN;
const CONTENT_H = DESIGN.contentH;      // 内容设计高（实测 862）
const TITLEBAR = 38;                    // 标题栏布局高（DIP，随 k 缩放）
const WORK_H_RATIO = 0.955;             // 粗略扣掉任务栏，仅用于本轮建模
const WIDTH_TOL = 0.025;                // 宽度容差：只剩 DIP 整数取整

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

/* 基准屏 = 应用第一次跑起来时所在的主显示器。这里取 2K@100%（用户现役环境）。
   注意：不管选哪块屏当基准，只要各屏与它「像素比一致」，结果都一样。 */
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
function simulate(scr, baseDpr) {
  const k = U.computeUiScale(scr.dpr, baseDpr);
  const wa = workAreaOf(scr);

  /* 主进程：窗口逻辑尺寸(DIP) = 物理设计尺寸 ÷ k */
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
  const physText = 14 * s * scr.dpr;                       // 14px 正文的物理高度
  const petBox = U.petWindowBox(DESIGN.petW, DESIGN.petH, k);
  const petPhysW = Math.round(petBox.width * scr.dpr);

  return {
    k, tbH, boxW: fitted.width, boxH: fitted.height, scale: s,
    physW, physH, physText, petPhysW,
    fitsW: fitted.width <= wa.width, fitsH: fitted.height <= wa.height,
    pctOfScreen: (physW / scr.w * 100),
    heightBound: availH / (CONTENT_H * k) < availW / (DESIGN.winW * k)
  };
}

const base = simulate(BASE, BASE_DPR);

console.log('='.repeat(112));
console.log('界面 DPI 适配验证 —— 基准屏 ' + BASE.name + ' @' + (BASE.dpr * 100) + '%（像素比 ' + BASE_DPR + '）');
console.log('基准屏出屏物理尺寸：' + base.physW + ' × ' + base.physH + ' 物理像素（内容块）');
console.log('='.repeat(112));
console.log(
  pad('屏幕', 16) + pad('像素比', 8) + pad('k', 7) + pad('窗口(DIP)', 12) +
  pad('页面scale', 10) + pad('内容物理', 12) + pad('占屏宽', 8) +
  pad('14px正文物理', 13) + pad('宠物物理宽', 11) + '结论'
);
console.log('-'.repeat(112));

let fails = 0;
for (const scr of SCREENS) {
  const r = simulate(scr, BASE_DPR);
  const devW = Math.abs(r.physW - base.physW) / base.physW;
  const okDev = devW <= WIDTH_TOL;
  const okK = r.k >= 1 - 1e-9;
  const okFit = r.fitsW && r.fitsH;
  if (!okDev || !okK || !okFit) fails++;
  const verdict = (!okDev ? '物理偏差 ' + (devW * 100).toFixed(1) + '% ' : '') +
    (!okK ? 'k<1 ' : '') + (!okFit ? '窗口超出可用区 ' : '') +
    (okDev && okK && okFit ? (r.heightBound ? 'OK（高度受屏幕限制）' : 'OK') : '<<< FAIL');

  console.log(
    pad(scr.name, 16) + pad(scr.dpr.toFixed(2), 8) + pad(r.k.toFixed(3), 7) +
    pad(r.boxW + '×' + r.boxH, 12) + pad(r.scale.toFixed(3), 10) +
    pad(r.physW + '×' + r.physH, 12) + pad(r.pctOfScreen.toFixed(0) + '%', 8) +
    pad(r.physText.toFixed(1) + 'px', 13) + pad(r.petPhysW + 'px', 11) + verdict
  );
}

/* ---- 换屏重排（主窗口，保留用户手动拉过的尺寸） ------------------------------------ */
console.log('');
console.log('='.repeat(108));
console.log('跨屏重排：主窗口 1180×880(DIP@基准屏) 拖到各屏后，逻辑尺寸应贴合目标屏的 k');
console.log('='.repeat(108));
for (const scr of SCREENS) {
  if (scr === BASE) continue;
  const kTo = U.computeUiScale(scr.dpr, BASE_DPR);
  const from = { x: 100, y: 100, width: DESIGN.winW, height: DESIGN.winH };
  const wa = workAreaOf(scr);
  const moved = U.rescaleBox(from, 1, kTo, wa, 'topleft');
  const want = U.windowBox(kTo).main;
  const okW = Math.abs(moved.width - want.width) <= 1;
  const okH = Math.abs(moved.height - want.height) <= 1;
  const inside = moved.x >= wa.x && moved.y >= wa.y &&
    moved.x + moved.width <= wa.x + wa.width && moved.y + moved.height <= wa.y + wa.height;
  if (!okW || !okH || !inside) fails++;
  console.log(
    pad(scr.name + ' @' + (scr.dpr * 100).toFixed(0) + '%', 24) +
    pad('k=' + kTo.toFixed(3), 12) +
    pad('重排后 ' + moved.width + '×' + moved.height, 20) +
    pad('期望 ' + want.width + '×' + want.height, 18) +
    (okW && okH && inside ? 'OK' : '<<< FAIL')
  );
}

/* ---- 用户手动拉过窗口：物理尺寸守恒且可逆 ------------------------------------------ */
console.log('');
const wa2 = { x: 0, y: 0, width: 1920, height: 1200 };
const manual = { x: 200, y: 150, width: 1400, height: 900 };        // 用户在基准屏拉到 1400×900
const toBig = U.rescaleBox(manual, 1, 2, wa2, 'topleft');
const back = U.rescaleBox(toBig, 2, 1, wa2, 'topleft');
const okManual = Math.abs(toBig.width * 2 - manual.width * 1) <= 2 &&
  back.width === manual.width && back.height === manual.height &&
  back.x === manual.x && back.y === manual.y;
if (!okManual) fails++;
console.log('手动拉过的窗口 1400×900(像素比1) → 拖到像素比2 的屏：' + toBig.width + '×' + toBig.height +
  ' DIP（物理 ' + toBig.width * 2 + '，原 ' + manual.width + '）→ 拖回：' + back.width + '×' + back.height +
  (okManual ? '  OK 物理守恒且可逆' : '  <<< FAIL'));

/* ---- 宠物窗：物理尺寸恒为 150×170 ------------------------------------------------ */
console.log('');
console.log('='.repeat(108));
console.log('宠物窗：窗口物理尺寸应恒为 ' + DESIGN.petW + '×' + DESIGN.petH);
console.log('='.repeat(108));
for (const scr of SCREENS) {
  const k = U.computeUiScale(scr.dpr, BASE_DPR);
  const box = U.petWindowBox(DESIGN.petW, DESIGN.petH, k);
  const physReal = Math.round(box.width * scr.dpr);
  const dev = Math.abs(physReal - DESIGN.petW) / DESIGN.petW;
  if (dev > 0.03) fails++;
  console.log(
    pad(scr.name + ' @' + (scr.dpr * 100).toFixed(0) + '%', 24) + pad('k=' + k.toFixed(3), 12) +
    pad('窗口 ' + box.width + '×' + box.height + ' DIP', 22) + pad('物理 ' + physReal + 'px', 14) +
    (dev <= 0.03 ? 'OK' : '<<< FAIL 偏差 ' + (dev * 100).toFixed(1) + '%')
  );
}

console.log('');
console.log('='.repeat(108));
console.log(fails === 0 ? '全部通过 ✅' : ('有 ' + fails + ' 项未通过 ❌'));
console.log('='.repeat(108));
process.exit(fails === 0 ? 0 : 1);

function pad(s, n) {
  s = String(s);
  while (s.length < n) s += ' ';
  return s;
}
