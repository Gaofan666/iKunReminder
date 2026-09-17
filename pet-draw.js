/* =========================================================================
   pet-draw.js —— 角色绘制 + 皮肤系统 + 音效合成（主界面与桌面宠物窗共用的唯一一份）
   -------------------------------------------------------------------------
   为什么单独成文件：主界面「全息舞台」上有一只角色，桌面宠物窗里还有一只，
   必须是同一套绘制代码（否则改一处另一处不同步）。所以 Canvas 绘制、皮肤精灵图、
   8-bit 音效合成全放这里，两个页面各自 new 一个 Kunkun 即可。

   使用方：
     · app.js —— 主界面舞台 + 提醒弹层里的角色（带地面光圈、环绕粒子）
     · pet.js —— 桌面宠物窗（plain = true，只要角色本体，其余全透明）

   依赖：无。Kunkun 只认画布尺寸与一个 fit 系数（越小角色越大），
   屏幕缩放适配由使用方算好 fit 传进来（见 ui-scale.js）。
   ========================================================================= */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.kunkunPet = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* 模块内共享的可变状态 */
  var P = {
    /* 皮肤：两个窗口各持一份，互不影响 */
    skin: { id: '__default', img: null, meta: null, ready: false },
    /* 皮肤加载成功/失败时的提示回调：主界面写进说明文字，宠物窗没有文字就传空函数 */
    onCaption: function () { },
    /* 音效开关，由使用方的设置同步进来 */
    soundOn: true
  };
  function setCaption(html) { try { P.onCaption(html); } catch (e) { } }
  var clamp = function (v, a, b) { return Math.min(b, Math.max(a, v)); };

  /* ===================== 画布小工具 ===================== */
  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function segment(ctx, x1, y1, x2, y2, w, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  /* 两段式手臂 IK：从肩(sx,sy)伸向目标(tx,ty)
     肘部有两个解，这里取"更靠下"的那个，手臂看起来自然下垂而不是横向外翻 */
  function ikArm(ctx, sx, sy, tx, ty, upper, lower, w, color, color2) {
    let dx = tx - sx, dy = ty - sy;
    let dist = Math.hypot(dx, dy) || 0.001;
    const maxD = (upper + lower) * 0.97;
    if (dist > maxD) { const k = maxD / dist; dx *= k; dy *= k; dist = maxD; }
    const base = Math.atan2(dy, dx);
    const cosA = clamp((upper * upper + dist * dist - lower * lower) / (2 * upper * dist), -1, 1);
    const da = Math.acos(cosA);
    const c1 = base - da, c2 = base + da;
    const a1 = (sy + Math.sin(c1) * upper) >= (sy + Math.sin(c2) * upper) ? c1 : c2;
    const ex = sx + Math.cos(a1) * upper;
    const ey = sy + Math.sin(a1) * upper;
    const hx = sx + dx, hy = sy + dy;
    segment(ctx, sx, sy, ex, ey, w, color);
    segment(ctx, ex, ey, hx, hy, w * 0.9, color2 || color);
    ctx.fillStyle = color2 || color;
    ctx.beginPath(); ctx.arc(hx, hy, w * 0.55, 0, Math.PI * 2); ctx.fill();
    return { x: hx, y: hy, ex, ey };
  }


  /* ===================== 音效器 ===================== */
  /* --------------------------------------------------------------- 音效器 */
  const Sound = {
    ctx: null,
    ensure() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) this.ctx = new AC();
      }
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    },
    tone(freq, at, dur, type, vol) {
      const ctx = this.ctx;
      if (!ctx) return;
      const t0 = ctx.currentTime + at;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = type || 'square';
      osc.frequency.setValueAtTime(freq, t0);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol || 0.09, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.03);
    },
    /* 提醒：原创 8-bit 上行小旋律 */
    alert() {
      if (!P.soundOn) return;
      this.ensure();
      if (!this.ctx) return;
      const melody = [523.25, 659.25, 783.99, 1046.50, 783.99, 1046.50, 1318.51];
      melody.forEach((f, i) => this.tone(f, i * 0.11, 0.19, 'square', 0.075));
      [130.81, 196.00, 261.63].forEach((f, i) => this.tone(f, i * 0.26, 0.5, 'triangle', 0.06));
    },
    /* 完成：轻快两声 */
    confirm() {
      if (!P.soundOn) return;
      this.ensure();
      if (!this.ctx) return;
      [783.99, 1046.50, 1318.51].forEach((f, i) => this.tone(f, i * 0.07, 0.16, 'square', 0.07));
    },
    /* 点击：短促电子音 */
    click() {
      if (!P.soundOn) return;
      this.ensure();
      if (!this.ctx) return;
      this.tone(880, 0, 0.06, 'square', 0.045);
      this.tone(1320, 0.05, 0.06, 'square', 0.03);
    }
  };


  /* ===================== Kunkun 类与色板 ===================== */
  const C = {
    chick: '#ffd84a',    // 小鸡黄
    chickL: '#ffe98d',
    chickD: '#e6b722',
    hair: '#c2c6ce',     // 银灰中分头发
    hairD: '#959ba7',
    hairL: '#e4e8ef',
    bill: '#ff9a3c',     // 鸭嘴橙
    billD: '#c2640f',
    blush: '#ef4530',    // 红脸蛋
    ink: '#241f1b',      // 描边
    hoodie: '#17171d',   // 黑卫衣
    hoodieD: '#2b2b35',
    strap: '#b7beb2',    // 浅灰绿背带
    pants: '#d9dbd5',    // 浅灰背带裤
    pantsD: '#c0c3bc',
    shoe: '#191920',     // 黑鞋
    ball: '#f0801a',
    ballD: '#a8451a'
  };

  class Kunkun {
    constructor(canvas, opts) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.mood = 'idle';
      this.moodAt = performance.now();
      this.fit = (opts && opts.fit) || 330;   // 数值越小，角色在画布里越大
      this.w = 1; this.h = 1;
      this.resize();
      if (window.ResizeObserver) {
        this.ro = new ResizeObserver(() => this.resize());
        this.ro.observe(canvas);
      } else {
        window.addEventListener('resize', () => this.resize());
      }
    }

    resize() {
      const el = this.canvas;
      const w = el.offsetWidth, h = el.offsetHeight;   // 布局尺寸（不含外层 transform）
      if (!w || !h) return;
      // 外层 #app 是等比缩放的，按最终显示尺寸分配像素，缩放后才不会发虚
      const r = el.getBoundingClientRect();
      const vis = r.width ? clamp(r.width / w, 0.05, 4) : 1;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const k = dpr * vis;
      const nw = Math.round(w * k);
      const nh = Math.round(h * k);
      /* 给 canvas 赋 width/height 会立刻清空画布，所以尺寸没变时绝不能碰，
         否则会出现「有一帧是空的」——点宠物时闪一下就是这么来的 */
      if (el.width === nw && el.height === nh && this.w === w && this.h === h) return;
      el.width = nw;
      el.height = nh;
      this.ctx.setTransform(k, 0, 0, k, 0, 0);
      this.w = w;
      this.h = h;
    }

    setMood(m) {
      if (this.mood !== m) { this.mood = m; this.moodAt = performance.now(); }
    }

    frame(now) {
      const ctx = this.ctx;
      const w = this.w, h = this.h;
      if (!w || !h) return;
      ctx.clearRect(0, 0, w, h);

      const t = now / 1000;
      const mood = this.mood;
      const energy = mood === 'dance' ? 1 : mood === 'cheer' ? 0.9 : 0.3;
      /* 手绘角色用统一的 fit；皮肤要按帧的实际宽高比算，
         否则宽幅皮肤（树 + 躺椅那种）横向会超出画布被裁掉。 */
      let s = Math.min(w / this.fit, h / this.fit);
      if (P.skin.ready && P.skin.meta) {
        const fh2 = P.skin.meta.frame.h;
        const drawW = P.skin.meta.frame.w * (310 / fh2);   // 帧在本地坐标下的宽度
        s = Math.min(w / Math.max(this.fit, drawW), h / this.fit);
      }

      ctx.save();
      /* 主界面：放在画布 94% 高度处（底部留一点，视觉上居中）。
         宠物模式：直接贴住窗口底边 —— 但不能用画布底边，
         因为生成的精灵图在格子底部还留了 5px 余量，
         要按「宠物真实边界」往上退这 5px，脚才能真的踩到桌面底边。 */
      let baseY = h * 0.94;
      if (this.plain) {
        const bg = P.skin.meta && P.skin.meta.bottomGap != null ? P.skin.meta.bottomGap : 0;
        const gapPx = P.skin.ready ? bg * (310 / P.skin.meta.frame.h) * s : 0;
        baseY = h + gapPx;   // 内容底边在原点【上方】gapPx 处，所以原点要放到画布下方 gapPx，脚才落在底边
      }
      ctx.translate(w / 2, baseY);
      ctx.scale(s, s);

      /* plain = 宠物模式：桌面上只要角色本身，不要地面光圈和环绕粒子 */
      PLAIN = !!this.plain;

      /* 选了自定义皮肤就用皮肤精灵图；没选或还没加载好就走代码手绘 */
      if (!drawSkin(ctx, t, mood)) {
        if (!this.plain) this.drawGround(ctx, t, mood);
        drawFigure(ctx, t, mood, energy);
        if (!this.plain) this.drawOrbits(ctx, t, mood);
      }

      ctx.restore();
    }

    drawGround(ctx, t, mood) {
      const pulse = mood === 'idle' ? 1 + Math.sin(t * 1.6) * 0.04 : 1 + Math.sin(t * 8) * 0.12;
      const g = ctx.createRadialGradient(0, 0, 4, 0, 0, 150 * pulse);
      const a = mood === 'idle' ? 0.30 : 0.55;
      g.addColorStop(0, `rgba(62,154,168,${a})`);
      g.addColorStop(0.5, `rgba(138,92,255,${a * 0.45})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(0, 0, 165 * pulse, 34 * pulse, 0, 0, Math.PI * 2);
      ctx.fill();

      // 地面光环虚线
      ctx.save();
      ctx.strokeStyle = 'rgba(62,154,168,.45)';
      ctx.lineWidth = 1.4;
      ctx.setLineDash([10, 12]);
      ctx.lineDashOffset = -t * 34;
      ctx.beginPath();
      ctx.ellipse(0, 0, 118, 24, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    drawOrbits(ctx, t, mood) {
      if (mood === 'idle') return;
      const n = 7;
      for (let i = 0; i < n; i++) {
        const a = t * 1.6 + (i / n) * Math.PI * 2;
        const rx = 150, ry = 30;
        const x = Math.cos(a) * rx;
        const y = -160 + Math.sin(a * 1.3) * 72 + Math.sin(a) * ry;
        const size = 2 + (i % 3);
        ctx.fillStyle = i % 2 ? '#6FB56B' : '#4A9BD4';
        ctx.shadowColor = ctx.fillStyle;
        ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.arc(x, y, size, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }
    }
  }


  /* ===================== 皮肤系统 ===================== */
  /* ------------------------------------------------------------ 皮肤系统
     用户可以自己换宠物形象：在 exe 同级的 skins/<名字>/ 里放 skin.json + 一张精灵图。
     这里只负责把主进程读来的图按 mood 切帧画出来。 */
  

  function skinAnimFor(mood) {
    const m = P.skin.meta;
    if (!m || !m.animations) return null;
    return m.animations[mood] || m.animations.idle || null;
  }

  /* 返回 true 表示这一帧由皮肤画掉了；false 表示该走代码手绘 */
  function drawSkin(ctx, t, mood) {
    if (!P.skin.ready || !P.skin.img || !P.skin.meta) return false;
    const m = P.skin.meta;
    const a = skinAnimFor(mood);
    if (!a || !m.frame) return false;
    const fw = m.frame.w, fh = m.frame.h;
    const count = Math.max(1, a.count || 1);
    /* 每种状态可以有自己的帧率：待机慢一点才不烦，跳舞/欢呼才需要快 */
    const fps = a.fps || m.fps || 10;
    const idx = Math.floor(t * fps) % count;
    const row = a.row || 0;
    /* 与手绘角色对齐：底边落在原点、横向居中，整体高度约 278 个本地单位 */
    /* 帧高映射成多少本地单位。调大 = 宠物在界面上更大。
     之前缩小下边界的做法是让内容下移，视觉上宠物反而往下跑了；
     正确做法是把它整体放大，下边界的占比自然就小了。 */
    const k = 310 / fh;
    const dw = fw * k, dh = fh * k;
    try {
      ctx.drawImage(P.skin.img, idx * fw, row * fh, fw, fh, -dw / 2, -dh, dw, dh);
    } catch (e) { return false; }
    return true;
  }

  function applySkin(data) {
    if (!data || data.builtin || data.error) {
      P.skin.id = '__default';
      P.skin.img = null;
      P.skin.meta = null;
      P.skin.ready = false;
      if (data && data.error) setCaption('皮肤加载失败，已用回默认形象：' + data.error);
      return;
    }
    const img = new Image();
    img.onload = function () {
      P.skin.id = data.id;
      P.skin.img = img;
      P.skin.meta = data.meta;
      P.skin.ready = true;
      /* 换形象成功不弹提示（只更新画面，别去改主界面的说明文字）；
         只有失败时才提示，见下面两个分支 */
    };
    img.onerror = function () {
      setCaption('皮肤图片读不出来，已用回默认形象');
    };
    img.src = data.sheet;
  }



  /* --------------------------------------------------------------- 绘制开关 */
  /* 宠物模式（plain）下：不画地面光圈、不画环绕粒子，角色也不加发光。
     桌面上只要角色本体，其余全部透明。 */

  /* ===================== 角色绘制 ===================== */
  let PLAIN = false;

  /* 渐变缓存：脸和头发那几个渐变每帧重建，但坐标和颜色根本不变，
     重建纯属浪费（每个 CanvasGradient 都要重新分配 + 上传给合成器）。
     按 canvas 上下文分组缓存，画出来的东西一模一样。 */
  const gradCache = new WeakMap();
  function linGrad(ctx, x0, y0, x1, y1, stops) {
    let m = gradCache.get(ctx);
    if (!m) { m = new Map(); gradCache.set(ctx, m); }
    const key = x0 + ',' + y0 + ',' + x1 + ',' + y1 + '|' + stops.map(function (s) {
      return s[0] + ':' + s[1];
    }).join(';');
    let g = m.get(key);
    if (!g) {
      g = ctx.createLinearGradient(x0, y0, x1, y1);
      stops.forEach(function (s) { g.addColorStop(s[0], s[1]); });
      m.set(key, g);
    }
    return g;
  }

  /* 绘制角色（本地坐标：脚底为原点，向上为负 y）
     造型照着参考图来：黄色小鸡 + 银灰中分乱发 + 半眯大眼 + 橙鸭嘴 + 红脸蛋
     + 黑卫衣（拉链 + 浅色背带）+ 浅灰背带裤 + 黑鞋，篮球拿在画面左手边 */
  function drawFigure(ctx, t, mood, energy) {
    const beat = t * (2.0 + energy * 2.6);
    const swing = Math.sin(beat);
    const hop = Math.max(0, Math.sin(beat * 2)) * 13 * energy;

    /* 挤压拉伸 + 呼吸：腾空拉长、落地压扁，静息时轻微呼吸 */
    const stretch = 1 + Math.cos(beat * 2) * 0.055 * energy;
    const breath = 1 + Math.sin(t * 1.7) * 0.012;

    ctx.save();
    ctx.translate(0, -hop);
    ctx.scale(breath / stretch, breath * stretch);

    /* --- 骨架定位：头大身子小，越夸张越对味 --- */
    const hipX = Math.sin(beat) * 6 * energy;
    const hipY = -46;
    const lean = Math.sin(beat * 0.5) * 0.15 * energy;
    const torsoLen = 32;
    const shX = hipX + Math.sin(lean) * torsoLen;
    const shY = hipY - Math.cos(lean) * torsoLen;

    const px = Math.cos(lean), py = Math.sin(lean);   // 躯干右方向单位向量
    const bShX = shX - px * 24, bShY = shY - py * 24; // 持球手（画面左）
    const fShX = shX + px * 24, fShY = shY + py * 24; // 另一只手（画面右）

    /* 头发比身体晚半拍，做出跟随甩动 */
    const lag = Math.sin(beat - 0.5) * 0.09 * energy;
    const lag2 = Math.sin(beat - 0.95) * 0.14 * energy;

    const headX = shX + Math.sin(lean) * 72;
    const headY = shY - Math.cos(lean) * 72 + Math.sin(beat * 2) * 2.6 * energy;

    /* --- 篮球位置（画面左手边） --- */
    let ballX, ballY, handY;
    const cheer = (mood === 'cheer');
    if (mood === 'dance') {
      const ph = (Math.sin(beat * 1.5) + 1) / 2;      // 0..1 运球节拍
      handY = -68 - ph * 26;                         // 手随节拍上下推球
      ballX = bShX - 38;
      ballY = handY + 24 + (1 - ph) * (1 - ph) * 46; // 球落到地面再弹回手里
    } else if (cheer) {
      ballX = bShX - 46;                             // 欢呼时球在身边弹跳，双手举起
      ballY = -22 - Math.abs(Math.sin(beat * 2)) * 36;
      handY = ballY - 22;
    } else {
      ballX = bShX - 36; ballY = hipY - 8 + Math.sin(beat) * 2;
      handY = ballY - 22;
    }
    ballX = clamp(ballX, -190, 190);

    /* --- 画面右侧的手臂（后层） --- */
    ctx.save();
    ctx.globalAlpha = 0.96;
    if (cheer) {
      wingArm(ctx, fShX, fShY, Math.PI / 2 - 0.42 - 2.05, Math.PI / 2 - 0.42 - 2.4);
    } else {
      const wave = (0.5 + 0.5 * swing);
      const a1 = Math.PI / 2 - 0.22 - wave * (mood === 'idle' ? 0.08 : 1.18);
      wingArm(ctx, fShX, fShY, a1, a1 - 0.16 - wave * 0.3);
    }
    ctx.restore();

    /* --- 腿 --- */
    const liftL = Math.max(0, swing) * energy;
    const liftR = Math.max(0, -swing) * energy;
    drawLeg(ctx, hipX - 12, hipY, liftL);
    drawLeg(ctx, hipX + 12, hipY, liftR);

    /* --- 躯干：小小的黑卫衣（拉链 + 浅色背带） --- */
    ctx.save();
    ctx.translate(hipX, hipY);
    ctx.rotate(lean);
    ctx.shadowColor = 'rgba(62,154,168,.5)';
    ctx.shadowBlur = PLAIN ? 0 : (mood === 'idle' ? 8 : 16);
    ctx.fillStyle = C.hoodie;
    roundRect(ctx, -27, -38, 54, 42, 16);
    ctx.fill();
    ctx.shadowBlur = 0;
    // 兜帽领口
    ctx.fillStyle = C.hoodieD;
    roundRect(ctx, -17, -40, 34, 12, 6);
    ctx.fill();
    // 拉链
    ctx.strokeStyle = 'rgba(198,204,214,.55)';
    ctx.lineWidth = 1.8;
    ctx.beginPath(); ctx.moveTo(0, -30); ctx.lineTo(0, 0); ctx.stroke();
    ctx.fillStyle = '#cdd3da';
    roundRect(ctx, -2.8, -21, 5.6, 10, 3);
    ctx.fill();
    // 背带 V 字
    ctx.strokeStyle = C.strap;
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-19, -31); ctx.lineTo(-6, -4);
    ctx.moveTo(19, -31); ctx.lineTo(6, -4);
    ctx.stroke();
    ctx.restore();

    /* --- 持球手（画面左侧，前层） --- */
    if (cheer) {
      wingArm(ctx, bShX, bShY, Math.PI / 2 + 0.42 + 2.05, Math.PI / 2 + 0.42 + 2.4);
    } else {
      ikArm(ctx, bShX, bShY, ballX, handY, 24, 22, 17, C.hoodie, C.chick);
    }

    /* --- 头 --- */
    ctx.save();
    ctx.translate(headX, headY);
    ctx.rotate(lean * 1.4 + Math.sin(beat) * 0.05 * energy + lag);
    drawChickHead(ctx, t, mood, swing, energy, lag2);
    ctx.restore();

    /* --- 篮球 --- */
    ctx.save();
    ctx.translate(ballX, ballY);
    ctx.rotate(t * 2.2 * (0.4 + energy));
    ctx.shadowColor = 'rgba(255,139,31,.85)';
    ctx.shadowBlur = 14;
    ctx.fillStyle = C.ball;
    ctx.beginPath(); ctx.arc(0, 0, 21, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = C.ballD;
    ctx.lineWidth = 2.2;
    ctx.beginPath(); ctx.arc(0, 0, 21, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-21, 0); ctx.lineTo(21, 0); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, -21); ctx.lineTo(0, 21); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(0, 0, 9.5, 21, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();

    ctx.restore();   // 收掉最外层的挤压拉伸变换

    return { headX, headY, hipX, hipY };
  }

  /* 手臂：上臂黑卫衣袖，手是小鸡黄 */
  function wingArm(ctx, sx, sy, a1, a2) {
    const ex = sx + Math.cos(a1) * 24, ey = sy + Math.sin(a1) * 24;
    segment(ctx, sx, sy, ex, ey, 17, C.hoodie);
    segment(ctx, ex, ey, ex + Math.cos(a2) * 22, ey + Math.sin(a2) * 22, 15, C.hoodie);
    ctx.fillStyle = C.chick;
    ctx.beginPath();
    ctx.arc(ex + Math.cos(a2) * 22, ey + Math.sin(a2) * 22, 10, 0, Math.PI * 2);
    ctx.fill();
  }

  /* 鸡头：故意画得歪一点、糊涂一点 —— 头是歪的，眼睛一大一小，眼珠各看各的 */
  function drawChickHead(ctx, t, mood, swing, energy, lag2) {
    const TILT = -0.06;                                // 脑袋天生歪一点

    // ---- 脸：不对称的歪蛋 ----
    const g = linGrad(ctx, 0, -70, 0, 66, [[0, C.chickL], [0.5, C.chick], [1, C.chickD]]);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-70, -8);
    ctx.bezierCurveTo(-78, -58, -28, -72, 10, -67);
    ctx.bezierCurveTo(54, -62, 84, -36, 77, 6);
    ctx.bezierCurveTo(70, 48, 30, 70, -12, 63);
    ctx.bezierCurveTo(-54, 56, -64, 32, -70, -8);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(170,115,0,.28)';
    ctx.lineWidth = 2.4;
    ctx.stroke();

    // ---- 银灰中分乱发：又大又乱，一撮一撮 ----
    ctx.save();
    ctx.rotate(lag2);
    const hg = linGrad(ctx, 0, -96, 0, 24, [[0, C.hairL], [0.55, C.hair], [1, C.hairD]]);
    ctx.fillStyle = hg;
    ctx.beginPath();
    ctx.moveTo(-92, 18);
    ctx.quadraticCurveTo(-112, -30, -84, -56);
    ctx.quadraticCurveTo(-80, -78, -58, -66);
    ctx.quadraticCurveTo(-50, -94, -26, -76);
    ctx.quadraticCurveTo(-12, -100, 12, -78);
    ctx.quadraticCurveTo(30, -96, 48, -72);
    ctx.quadraticCurveTo(70, -84, 76, -58);
    ctx.quadraticCurveTo(104, -34, 90, 18);
    // 刘海内缘：两侧压到脸颊，中间劈出中分
    ctx.bezierCurveTo(84, 34, 66, 16, 48, -2);
    ctx.bezierCurveTo(32, -18, 16, -30, 5, -37);
    ctx.quadraticCurveTo(0, -40, -5, -37);
    ctx.bezierCurveTo(-20, -28, -34, -18, -48, -2);
    ctx.bezierCurveTo(-66, 16, -86, 34, -92, 18);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(88,94,108,.45)';
    ctx.lineWidth = 1.8;
    ctx.stroke();
    // 中分缝
    ctx.strokeStyle = 'rgba(110,116,130,.8)';
    ctx.lineWidth = 2.6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, -40);
    ctx.quadraticCurveTo(4, -60, 6, -80);
    ctx.stroke();
    // 发丝纹路
    ctx.strokeStyle = 'rgba(146,152,166,.45)';
    ctx.lineWidth = 2;
    const strands = [
      [-70, -50, -80, -22], [-48, -58, -56, -28], [-22, -66, -28, -40],
      [10, -70, 14, -44], [36, -60, 44, -32], [64, -50, 74, -22]
    ];
    for (let i = 0; i < strands.length; i++) {
      const s = strands[i];
      ctx.beginPath();
      ctx.moveTo(s[0], s[1]);
      ctx.quadraticCurveTo((s[0] + s[2]) / 2 + 5, (s[1] + s[3]) / 2, s[2], s[3]);
      ctx.stroke();
    }
    ctx.restore();

    // ---- 一大一小、各看各的近视眼 ----
    ctx.save();
    ctx.rotate(TILT);
    const cycle = t % 4.6;
    const blink = cycle > 4.32 && cycle < 4.46;
    const happy = (mood === 'cheer');
    // [中心x, 中心y, 半径, 眼珠偏移x, 眼珠偏移y, 眼皮厚薄]
    const eyes = [
      [-26, 2, 25, 5, 7, 0.95],
      [25, 6, 19, -4, -5, 0.55]
    ];
    for (let i = 0; i < eyes.length; i++) {
      const e = eyes[i];
      const ex = e[0], ey = e[1], ER = e[2];
      if (blink || happy) {
        ctx.strokeStyle = C.ink;
        ctx.lineWidth = 5;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.arc(ex, ey + 6, ER * 0.7, Math.PI * 1.08, Math.PI * 1.92);
        ctx.stroke();
        continue;
      }
      // 眼白
      ctx.fillStyle = '#fffdf3';
      ctx.beginPath(); ctx.arc(ex, ey, ER, 0, Math.PI * 2); ctx.fill();
      ctx.save();
      ctx.beginPath(); ctx.arc(ex, ey, ER, 0, Math.PI * 2); ctx.clip();
      // 眼珠：小、乱瞟
      ctx.fillStyle = '#2b2620';
      ctx.beginPath(); ctx.arc(ex + e[3], ey + e[4], ER * 0.30, 0, Math.PI * 2); ctx.fill();
      // 很厚的上眼皮，压出那股没睡醒的拽劲
      ctx.fillStyle = '#3a3a44';
      ctx.beginPath();
      ctx.ellipse(ex, ey - ER * (1 + e[5] * 0.35), ER * 1.25, ER * (0.6 + e[5] * 0.4), 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      // 描边
      ctx.strokeStyle = C.ink;
      ctx.lineWidth = 3.4;
      ctx.beginPath(); ctx.arc(ex, ey, ER, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();

    // ---- 大小不一的红脸蛋 ----
    ctx.fillStyle = 'rgba(239,69,48,.88)';
    ctx.beginPath(); ctx.ellipse(-52, 30, 15, 12, -0.2, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(48, 34, 12, 10, 0.2, 0, Math.PI * 2); ctx.fill();

    // ---- 歪嘴鸭嘴 ----
    const open = mood !== 'idle';
    ctx.save();
    ctx.translate(4, 46);
    ctx.rotate(TILT + 0.05);
    ctx.fillStyle = C.bill;
    ctx.beginPath(); ctx.ellipse(0, 0, 30, 17 + (open ? 3 : 0), 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = C.billD;
    ctx.lineWidth = 3.2;
    ctx.stroke();
    if (open) {
      ctx.fillStyle = '#8d3a0d';
      ctx.beginPath();
      ctx.ellipse(0, 3, 17, 10 + Math.abs(swing) * 4 + energy * 2, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = C.billD;
    ctx.lineWidth = 3.2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-20, -5);
    ctx.quadraticCurveTo(0, open ? 16 : 11, 20, -4);
    ctx.stroke();
    ctx.restore();
  }

  function drawLeg(ctx, hx, hy, lift) {
    const thighA = Math.PI / 2 - lift * 0.6;
    const shinA = Math.PI / 2 + lift * 1.0;
    const kx = hx + Math.cos(thighA) * 24;
    const ky = hy + Math.sin(thighA) * 24;
    const fx = kx + Math.cos(shinA) * 22;
    const fy = ky + Math.sin(shinA) * 22;
    segment(ctx, hx, hy, kx, ky, 24, C.pants);      // 浅灰背带裤
    segment(ctx, kx, ky, fx, fy, 21, C.pantsD);
    // 黑鞋（憨一点）
    ctx.save();
    ctx.translate(fx, fy);
    ctx.fillStyle = C.shoe;
    ctx.shadowColor = 'rgba(62,154,168,.4)';
    ctx.shadowBlur = PLAIN ? 0 : 8;
    roundRect(ctx, -16, -9, 32, 14, 7);
    ctx.fill();
    ctx.restore();
  }


  return {
    Kunkun: Kunkun,
    Sound: Sound,
    skin: P.skin,
    /* app.js 原有的调用点直接复用这些小工具 */
    clamp: clamp,
    roundRect: roundRect,
    segment: segment,
    ikArm: ikArm,
    drawFigure: drawFigure,
    drawLeg: drawLeg,
    drawChickHead: drawChickHead,
    linGrad: linGrad,
    /* 配置 */
    setCaptionHandler: function (fn) { P.onCaption = typeof fn === 'function' ? fn : function () { }; },
    setSoundOn: function (on) { P.soundOn = !!on; },
    /* 皮肤：这里只负责「把主进程读来的精灵图挂上」，
       取列表 / 载入需要主进程桥，放在 skin-picker.js */
    applySkin: applySkin
  };
});
