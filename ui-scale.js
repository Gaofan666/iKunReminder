/* =========================================================================
   ui-scale.js —— 界面 DPI 适配因子（独立文件：主进程、页面、Node 测试共用）
   -------------------------------------------------------------------------
   要解决的问题：
     软件按固定设计尺寸排版，而 fitApp() 只按「窗口的 CSS 像素」算缩放，
     完全没看显示器的缩放（DPI）。于是界面在屏幕上的物理大小只由「物理分辨率」
     决定 —— 分辨率越高字越小：
        1K 1920×1080 @100%  → 约 13.0 英寸宽（偏大）
        2K 2560×1440 @100%  → 约 10.4 英寸宽（基准）
        4K 3840×2160 @150%  → 约  7.3 英寸宽（偏小）
        4K 3840×2160 @100%  → 约  5.0 英寸宽（很小）
     而且没有任何窗口跨屏 / DPI 变化的监听，从 2K 屏拖到 4K 屏不会重新适配。

   算法（因子 k）：
     k = 当前显示器的像素比 ÷ 基准显示器的像素比
       = (缩放比例 ÷ 缩放比例_基准)
     · 基准屏 = 用户第一次跑起这个软件时所在的主显示器，之后固定不变；
       所以它对「自己第一次用的那块屏」永远是 1，界面和以前一模一样。
     · 像素比（CSS 像素 → 物理像素）就是 Windows 缩放百分比在 Chromium 里的体现，
       所以 k 只跟系统缩放有关，跟分辨率无关 —— 2K/4K 只要缩放一样，物理大小天然一致。

   契约（主进程与页面必须一致，见 main.js）：
     · 窗口逻辑尺寸(DIP) = 物理设计尺寸 ÷ k
     · 页面内容 scale 也乘 k
     两条合起来：界面在屏幕上的物理大小恒定，换到任何分辨率/缩放的屏都一样大。

   本文件不依赖 Electron / DOM，可直接被 Node require 做单测。
   ========================================================================= */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;   // Node（测试/主进程）
  if (root) root.kunkunUiScale = api;                                        // 浏览器（页面/preload）
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* 设计尺寸按「物理像素」理解：
     1180×849 是启动基准屏（2K@100%）上的物理尺寸，也是初始窗口的逻辑尺寸。
     其中内容真实布局高约 801（主界面），顶部一条（标题栏+标签栏合并）占 46，
     再加 2px 余量。窗口高取「内容 + 顶栏」，尽量贴紧内容底部、不留大片空白。 */
  var DESIGN = {
    winW: 1180, winH: 849,
    contentH: 801,                 // 量出来的内容设计高（app.js 首启会覆盖成实测值）
    titlebar: 48,                  // 顶部一条（标题栏+标签栏）的物理高预算（46 + 2 余量）
    minW: 760, minH: 560,          // 主界面最小尺寸（物理）
    petW: 150, petH: 170,          // 宠物窗最大档（物理）
    petMin: 80,                    // 宠物窗最小尺寸（物理）—— 只在极端缩放下才会碰到
    bubbleW: 340, bubbleH: 176,    // 气泡本体（物理）
    bubblePad: 10                  // 气泡四周留给小尾巴的余量（物理）
  };

  /* 只认这几个 Windows 实际会用的缩放档，避免把 Chromium 的浮点误差
     （1.5000000001 之类）当成一个新档位，导致反复重排。也防止 1.25/1.5 抖动。 */
  var KNOWN_RATIOS = [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3, 3.5, 4, 4.5, 5];

  /* 把任意正数收敛到最近的已知档位；落在两档正中间时并入较大档 */
  function snapRatio(px) {
    var n = Number(px);
    if (!(n > 0) || !isFinite(n)) return null;
    var best = KNOWN_RATIOS[0], bestD = Infinity;
    for (var i = 0; i < KNOWN_RATIOS.length; i++) {
      var d = Math.abs(KNOWN_RATIOS[i] - n);
      if (d < bestD - 1e-9) { bestD = d; best = KNOWN_RATIOS[i]; }
    }
    /* 差得太远（比如非整数缩放 1.4）就当它没匹配上，直接用原值，别乱猜 */
    return bestD <= Math.max(0.06, n * 0.06) ? best : n;
  }

  /* 恒返回 1：主界面/宠物按逻辑像素(DIP)定尺寸，不跟显示器的缩放百分比走。
     为什么废掉原来的「物理像素恒定」，见下面那段长注释。 */
  function computeUiScale() { return 1; }

  /* =======================================================================
     注意：computeUiScale 现在【恒返回 1】—— 主界面和宠物一律按逻辑像素(DIP)
     定尺寸，不再跟着显示器的缩放百分比走。为什么把原来那套「物理像素恒定」
     的方案废掉：

     原方案 k = 当前屏像素比 ÷ 基准屏像素比，窗口逻辑尺寸 = 设计尺寸 ÷ k，
     于是界面在每块屏上的【物理像素数】都一样，看着「物理大小恒定」。
     但它跟用户直觉是反的：Windows 的缩放百分比表达的是「这块屏上多大的 DIP
     看着舒服」—— 像素密度高的屏，用户会把缩放调大。这时坚持物理像素恒定，
     反而让界面在这块屏上显得更小：
        2K@100%（约 109 PPI）→ 1180 物理像素 ≈ 10.8 英寸宽
        4K@150%（约 163 PPI）→ 1180 物理像素 ≈  7.2 英寸宽   ← 明显变小
     实机反馈正是如此：「笔记本接 2K + 4K 双屏，从 2K 拖到 4K 后文字变小」。

     正确做法是跟随系统缩放（Windows 已经按每块屏的 PPI 定义好了 DIP 的含义），
     即 k 恒为 1：窗口在每块屏上都是 1180×849 DIP，看起来一样大。

     顺带还躲开一个 Electron 在 Windows 上的回归（electron#51679）：无边框 +
     可调整大小的窗口，可视窗口比 getBounds() 向外多出一圈（SM_CXSIZEFRAME +
     SM_CXPADDEDBORDER，且这一圈随 DPI 变化）。原来跨屏时我们自己按 k 重算尺寸
     再 setBounds，会把这圈偏移算进去，结果窗口溢出工作区 —— 表现就是
     「拖到另一块屏后界面变成全屏、边缘抓不住、拖不动也缩放不了」。
     k 恒为 1 之后，跨屏不需要我们自己 setBounds，交给系统即可，问题一并消失。
     ======================================================================= */

  /* 内容最终 scale：把设计尺寸铺满当前窗口，装不下就等比缩小，永远不溢出。
       fit = min(可用宽/设计宽, 可用高/设计高, 1)
       scale = fit × k，而 k 恒为 1（见上面那段），所以 scale 就等于 fit。
     窗口被用户拉小时 fit 变小 → 内容跟着整体等比缩小（不重排版）。 */
  function computeContentScale(availW, availH, baseScale, designW, designH) {
    var k = clampScale(baseScale);
    var aw = Math.max(1, Number(availW) || 1);
    var ah = Math.max(1, Number(availH) || 1);
    var dw = Math.max(1, Number(designW) || DESIGN.winW);
    var dh = Math.max(1, Number(designH) || 842);
    var fit = Math.min(aw / dw, ah / dh, 1);
    if (!isFinite(fit) || fit <= 0) fit = 1 / k;
    var s = fit * k;
    if (!isFinite(s) || s <= 0) s = 1;
    /* 地板：极端小窗口下也别缩到看不见（与现有 fitApp 的行为一致，实际不会触发） */
    return Math.max(0.35, Math.min(4, s));
  }

  /* 由 k 推导三扇窗口的「逻辑尺寸」（DIP，Electron 的单位）。
     全部四舍五入到整数，避免 Windows 把 DIP 尺寸取整后与渲染进程反复对不上。
     宠物窗按实际档位尺寸另算，见 petWindowBox()。 */
  function windowBox(scaleFactor) {
    var k = clampScale(scaleFactor);
    return {
      main: {
        width: Math.round(DESIGN.winW / k),
        height: Math.round(DESIGN.winH / k),
        minWidth: Math.round(DESIGN.minW / k),
        minHeight: Math.round(DESIGN.minH / k)
      },
      bubble: {
        width: Math.round(DESIGN.bubbleW / k),
        height: Math.round(DESIGN.bubbleH / k),
        pad: Math.round(DESIGN.bubblePad / k)
      }
    };
  }

  /* 因子范围：Windows 实际用到的缩放档在 100%~400% 之间（像素比 1~4），
     再宽就有把窗口缩到不可用或撑爆屏幕的风险，这里留出安全余量。 */
  function clampScale(k) {
    var n = Number(k);
    if (!(n > 0) || !isFinite(n)) return 1;
    return Math.min(2.5, Math.max(0.5, n));
  }

  /* 宠物窗：物理尺寸恒定 = petW×petH，逻辑尺寸 = ÷k。
     下限取物理 60px（Windows 也允许更小的窗口），不再写死 80 DIP ——
     否则在 200% 缩放下 80 DIP = 160 物理像素，宠物会平白大 6.7%。 */
  function petWindowBox(petW, petH, k) {
    var kk = clampScale(k);
    var floorDip = Math.max(1, Math.round(DESIGN.petMin / kk));
    var w = Math.max(floorDip, Math.round(petW / kk));
    var h = Math.max(floorDip, Math.round(petH / kk));
    return { width: w, height: h };
  }

  /* 主界面：把逻辑尺寸换算成物理尺寸（诊断/测试用，也方便换算回去） */
  function toPhysical(box, k) {
    var kk = clampScale(k);
    return { width: Math.round(box.width * kk), height: Math.round(box.height * kk) };
  }

  /* 安全区夹取：把 w×h 的窗口放进 workArea，并尽量保留原位置 */
  function clampBox(x, y, w, h, workArea) {
    if (!workArea) return { x: Math.round(x), y: Math.round(y), width: w, height: h };
    var maxW = Math.max(1, workArea.width);
    var maxH = Math.max(1, workArea.height);
    var width = Math.min(w, maxW);
    var height = Math.min(h, maxH);
    var maxX = workArea.x + (maxW - width);
    var maxY = workArea.y + (maxH - height);
    return {
      x: Math.round(Math.min(Math.max(x, workArea.x), maxX)),
      y: Math.round(Math.min(Math.max(y, workArea.y), maxY)),
      width: width,
      height: height
    };
  }

  /* 换屏重排：把窗口从 kFrom 的屏挪到 kTo 的屏，两件事一起做：
       1) 物理尺寸保持不变 —— 按 kTo/kFrom 换算逻辑尺寸。直接用当前逻辑尺寸乘比例是对的：
          「逻辑尺寸 × 该屏缩放」就是物理尺寸，换算后物理尺寸守恒，来回拖能回到原样。
          注意不能拿「设计尺寸 ÷ kFrom」当基准再除一次 kTo —— 那是双重缩放（实测会缩到 65%）。
       2) 系统托管的窗口（宠物窗/气泡窗）尺寸由 k 唯一决定：传 sysSize 时按「设计物理尺寸 ÷ kTo」
          取整，避免 Windows 的 DIP 取整让它每换一次屏就大几个像素、来回几十次越变越大。
     mode='topleft' 保持左上角（主界面）／mode='center' 保持中心（宠物窗，随后会校正）。 */
  function rescaleBox(box, kFrom, kTo, workArea, mode, sysSize) {
    var a = clampScale(kFrom), b = clampScale(kTo);
    var w, h;
    if (sysSize) {
      w = Math.round(sysSize.width / b);
      h = Math.round(sysSize.height / b);
    } else {
      /* 逻辑尺寸 × k = 物理尺寸；换到 kTo 屏后要保住物理尺寸 → 乘 a/b（不是 b/a） */
      w = Math.round(box.width * (a / b));
      h = Math.round(box.height * (a / b));
    }
    var x, y;
    if (mode === 'center') {
      x = box.x + (box.width - w) / 2;               // 保持中心
      y = box.y + (box.height - h) / 2;
      /* 桌面上贴边的宠物：按中心换算后可能顶出屏幕，改成保持右下边不动 */
      if (workArea && (x < workArea.x || y < workArea.y ||
        x + w > workArea.x + workArea.width || y + h > workArea.y + workArea.height)) {
        x = box.x + box.width - w;
        y = box.y + box.height - h;
      }
    } else {
      x = box.x;
      y = box.y;
    }
    return clampBox(x, y, w, h, workArea);
  }

  return {
    DESIGN: DESIGN,
    KNOWN_RATIOS: KNOWN_RATIOS,
    snapRatio: snapRatio,
    computeUiScale: computeUiScale,
    computeContentScale: computeContentScale,
    clampScale: clampScale,
    windowBox: windowBox,
    petWindowBox: petWindowBox,
    toPhysical: toPhysical,
    clampBox: clampBox,
    rescaleBox: rescaleBox
  };
});
