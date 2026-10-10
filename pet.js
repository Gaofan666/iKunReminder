/* =========================================================================
   桌面宠物窗的渲染脚本
   -------------------------------------------------------------------------
   职责很窄：把角色画出来 + 处理拖动 / 单击 / 右键。
   窗口尺寸、屏幕位置、说话气泡全在主进程那边算（只有它知道屏幕几何），
   这里只负责「这只宠物长什么样、在不在动、有没有被点」。
   ========================================================================= */
(function () {
  'use strict';

  var bridge = window.kunkunPetWindow;
  var PET = window.kunkunPet;
  var canvas = document.getElementById('pet');
  if (!bridge || !PET || !canvas) return;

  /* ---------------------------------------------------------------- 画布 */
  var k = 1;        // 本屏缩放因子（主进程给的权威值）
  var dpr = 1;      // 本屏像素比
  var pet = new PET.Kunkun(canvas);
  pet.plain = true;               // 桌面上只要角色本体：不画地面光圈、环绕粒子、发光

  /* fit 越小角色越大。要让宠物在屏幕上的物理大小恒定，必须满足
       fit = 基准fit × 本屏因子 k × 本屏像素比
     推导：角色物理宽 = 宠窗CSS宽 × 像素比 × 基准fit ÷ fit，
     而宠窗CSS宽 = 物理尺寸 ÷ k（主进程按这个设窗口），
     代入后 k 与像素比正好相抵，剩下的只跟基准 fit 有关。
     基准 fit 的取值：拿像素包络量出来的 —— 220 时角色约占 89×109 物理像素，
     脚底正好落在窗口底边（bottom = 窗口高）。 */
  var BASE_FIT = 220;
  function applyFit() {
    pet.fit = BASE_FIT * k * dpr;
    pet.resize();
  }

  /* ------------------------------------------------------------ 动画循环 */
  var rafId = 0;
  var running = false;
  var FRAME_MS = 1000 / 30;        // 限帧 30fps：桌面常驻，够顺滑又省电
  var lastFrameAt = 0;
  var moodTimer = null;

  function loop(now) {
    if (!running) return;
    rafId = requestAnimationFrame(loop);
    if (now - lastFrameAt < FRAME_MS - 1) return;
    lastFrameAt = now;
    pet.frame(now);
  }

  function start() {
    if (running) return;
    running = true;
    lastFrameAt = 0;
    rafId = requestAnimationFrame(loop);
  }

  function stop() {
    running = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  }

  function setMood(m, ms) {
    pet.setMood(m);
    if (moodTimer) clearTimeout(moodTimer);
    if (ms) moodTimer = setTimeout(function () { pet.setMood('idle'); }, ms);
  }

  /* ---------------------------------------------------------- 命中测试
     桌宠窗整个矩形比小鸡本体大（四周是透明的留白）。主进程默认让鼠标穿透过去，
     这里用画布 alpha 判断鼠标是不是真的压在小鸡身上，只在状态变化时报给主进程 ——
     不然每次 mousemove 都发一条 IPC 太吵。
     注意画布是按物理像素画的（有 DPR 缩放），坐标要换算到画布像素。
     ⚠️ 不能每次 mousemove 都去 getImageData：那是 GPU→CPU 回读，一次鼠标扫过能触发几百次
     （9 个采样点 × 每秒上百个 mousemove），桌宠会明显卡。现在先把画布 alpha 缩成一张
     粗掩码（每 MASK_STEP 像素一格），鼠标移动只是查表；掩码最多每 MASK_REBUILD_MS
     重建一次，而且只在鼠标真的压过来时才建（不压过来就一次都不花）。 */
  var HIT_TOL = 3;                     // 边缘 3px 容差，免得贴着边点不中
  var MASK_STEP = 3;                   // 掩码粒度（画布像素）
  var MASK_REBUILD_MS = 120;           // 掩码最长用这么久（小鸡的动作在换帧，掩码要跟上）
  var hitLast = null, hitDown = false;
  var mask = null, maskW = 0, maskH = 0, maskCw = 0, maskCh = 0, maskAt = 0;
  var HIT_OFFS = [[0, 0], [HIT_TOL, 0], [-HIT_TOL, 0], [0, HIT_TOL], [0, -HIT_TOL],
    [HIT_TOL, HIT_TOL], [-HIT_TOL, -HIT_TOL], [HIT_TOL, -HIT_TOL], [-HIT_TOL, HIT_TOL]];

  /* 重建掩码：一次 getImageData 读整张画布，按 MASK_STEP 采样成 0/1 的粗格子 */
  function buildHitMask() {
    try {
      var w = canvas.width, h = canvas.height;
      if (!w || !h) { mask = null; return false; }
      var img = canvas.getContext('2d').getImageData(0, 0, w, h).data;
      var mw = Math.ceil(w / MASK_STEP), mh = Math.ceil(h / MASK_STEP);
      var m = new Uint8Array(mw * mh);
      for (var gy = 0; gy < mh; gy++) {
        var y0 = gy * MASK_STEP;
        for (var gx = 0; gx < mw; gx++) {
          var x0 = gx * MASK_STEP, solid = 0;
          for (var dy = 0; dy < MASK_STEP && !solid; dy++) {
            var yy = y0 + dy; if (yy >= h) break;
            for (var dx = 0; dx < MASK_STEP; dx++) {
              var xx = x0 + dx; if (xx >= w) break;
              if (img[(yy * w + xx) * 4 + 3] > 12) { solid = 1; break; }   // 有一点点不透明就算命中
            }
          }
          m[gy * mw + gx] = solid;
        }
      }
      mask = m; maskW = mw; maskH = mh; maskCw = w; maskCh = h; maskAt = Date.now();
      return true;
    } catch (e) { mask = null; return false; }
  }

  /* 掩码还能用吗？尺寸变了或过期了就重建（重建本身最多每 MASK_REBUILD_MS 一次） */
  function hitMaskReady() {
    if (!mask || maskCw !== canvas.width || maskCh !== canvas.height) return buildHitMask();
    if (Date.now() - maskAt > MASK_REBUILD_MS) return buildHitMask();
    return true;
  }

  function overPet(clientX, clientY) {
    try {
      var r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      var sx = (clientX - r.left) * canvas.width / r.width;
      var sy = (clientY - r.top) * canvas.height / r.height;
      if (!hitMaskReady()) {
        /* 掩码建不起来（画布还没画好之类）→ 退回逐点回读，别把桌宠变成点不动的 */
        var ctx = canvas.getContext('2d');
        for (var i = 0; i < HIT_OFFS.length; i++) {
          var x = Math.round(sx + HIT_OFFS[i][0]), y = Math.round(sy + HIT_OFFS[i][1]);
          if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) continue;
          if (ctx.getImageData(x, y, 1, 1).data[3] > 12) return true;
        }
        return false;
      }
      for (var j = 0; j < HIT_OFFS.length; j++) {
        var gx2 = Math.floor(Math.round(sx + HIT_OFFS[j][0]) / MASK_STEP);
        var gy2 = Math.floor(Math.round(sy + HIT_OFFS[j][1]) / MASK_STEP);
        if (gx2 < 0 || gy2 < 0 || gx2 >= maskW || gy2 >= maskH) continue;
        if (mask[gy2 * maskW + gx2]) return true;
      }
      return false;
    } catch (e) {
      return true;    // 量不出来时按「可点」处理，别把桌宠变成点不动的
    }
  }

  function reportHit(hit) {
    if (hit === hitLast) return;
    hitLast = hit;
    if (bridge.petHit) bridge.petHit(hit);
  }

  window.addEventListener('mousemove', function (e) {
    if (hitDown) return;              // 按住/拖动期间不切状态，免得把拖动打断
    reportHit(overPet(e.clientX, e.clientY));
  });
  /* ⚠️ hitDown 必须有多条复位路径：只靠 mouseup 的话，鼠标在窗外松开 / 拖动被系统取消
     （pointercancel）就再也收不到 mouseup，命中测试会永久停摆（整块矩形一直可点）。 */
  window.addEventListener('mousedown', function () { hitDown = true; });
  window.addEventListener('mouseup', function (e) {
    hitDown = false;
    reportHit(overPet(e.clientX, e.clientY));
  });
  window.addEventListener('pointercancel', function () { hitDown = false; reportHit(false); });
  window.addEventListener('blur', function () { hitDown = false; reportHit(false); });
  window.addEventListener('mouseleave', function () { if (!hitDown) reportHit(false); });
  reportHit(false);                   // 初始按穿透处理，鼠标压上来自然会打开

  /* ---------------------------------------------------------- 形象 / 音效 */
  PET.setCaptionHandler(function () { });      // 宠物窗没有文字可以提示，静默即可

  function loadSkin(id) {
    if (!id || id === '__default') {
      PET.applySkin({ builtin: true });        // 回默认：走代码手绘
      return;
    }
    bridge.skinLoad(id).then(function (d) { PET.applySkin(d); }).catch(function () { });
  }

  /* ------------------------------------------------------ 主进程推过来的事 */
  bridge.onTalk(function () { setMood('cheer', 1500); });
  bridge.onMood(function (m) { setMood(m || 'idle'); });
  bridge.onSkin(function (id) { loadSkin(id); });
  bridge.onSize(function () { applyFit(); });          // 窗口尺寸变了，重算画布
  bridge.onSound(function (on) { PET.setSoundOn(!!on); });
  bridge.onVisibility(function (v) { if (v) start(); else stop(); });
  bridge.onDisplayInfo(function (info) {
    if (!info) return;
    dpr = Number(info.realPixelRatio) || window.devicePixelRatio || 1;
    k = Number(info.realScale) > 0 ? Number(info.realScale) : 1;
    applyFit();
  });

  /* ------------------------------------------------------------ 拖动 / 单击 */
  var dragging = false, downX = 0, downY = 0, moved = 0;
  var isDrag = false;                          // 这一下是「拖动」而不是「单击」
  var MIN_MOVE = 6;                            // 位移不超过这个值就算「单击」

  document.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    dragging = true;
    moved = 0;
    isDrag = false;
    downX = e.screenX; downY = e.screenY;
    try { document.body.setPointerCapture(e.pointerId); } catch (err) { }
    document.body.classList.add('dragging');
    bridge.dragStart({ x: downX, y: downY });
    e.preventDefault();
  });

  document.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    moved = Math.max(moved, Math.abs(e.screenX - downX) + Math.abs(e.screenY - downY));
    if (moved > MIN_MOVE) {
      if (!isDrag) {
        isDrag = true;
        /* 一动手就算拖动：立刻把气泡收掉（拖动过程中窗口会移动，气泡不跟着走会脱节） */
        bridge.hideTalk();
      }
      bridge.dragMove({ x: e.screenX, y: e.screenY });
    }
  });

  function stopDrag(e) {
    if (!dragging) return;
    dragging = false;
    try { document.body.releasePointerCapture(e.pointerId); } catch (err) { }
    document.body.classList.remove('dragging');
    bridge.dragEnd();
    /* 单击 = 让宠物说句话；再点一下 = 把气泡收掉（由主进程判断当前开没开）。
       拖动（isDrag）什么都不做 —— 气泡在刚动手时就收掉了。 */
    if (!isDrag && moved <= MIN_MOVE) {
      PET.Sound.click();
      bridge.talk();
    }
  }

  document.addEventListener('pointerup', stopDrag);
  document.addEventListener('pointercancel', stopDrag);

  /* 右键 → 原生菜单（换形象 / 换大小 / 显示主界面 / 隐藏 / 退出） */
  document.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    bridge.menu();
  });

  /* ---------------------------------------------------------------- 启动 */
  function init(info) {
    if (info) {
      dpr = Number(info.realPixelRatio) || window.devicePixelRatio || 1;
      k = Number(info.realScale) > 0 ? Number(info.realScale) : 1;
      if (typeof info.sound === 'boolean') PET.setSoundOn(info.sound);
      if (info.skin) loadSkin(info.skin);
    }
    applyFit();
    start();
    bridge.ready();                             // 告诉主进程「我画好了」
  }

  if (bridge.getUiScale) {
    bridge.getUiScale().then(init).catch(function () { init(null); });
  } else {
    init(null);
  }

  window.addEventListener('resize', applyFit);
})();
