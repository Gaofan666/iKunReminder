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
