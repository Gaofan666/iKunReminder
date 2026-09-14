/* =========================================================================
   电子提醒器 · 喝水休息提醒
   纯前端实现：计时 / 提醒 / 音效 / 语音 / Canvas 角色动画
   所有美术与音乐均由代码实时绘制与合成（原创），无任何外部素材与依赖
   ========================================================================= */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ 常量 */
  const RING_C = 2 * Math.PI * 52;          // 进度环周长
  const SNOOZE_SEC = 5 * 60;                // 稍后提醒 = 5 分钟
  const BAR_TARGET = { water: 8, rest: 6 }; // 每日目标次数

  const META = {
    water: {
      name: '喝水',
      emoji: '💧',
      color: '#00e5ff',
      title: '该喝水啦！',
      desc: '咕嘟咕嘟～ 补充水分，大脑转得更快，皮肤也会谢谢你。',
      done: '我喝了 💧',
      voice: '该喝水啦，快喝一杯水吧',
      caption: '提醒你喝水'
    },
    rest: {
      name: '休息',
      emoji: '🛋️',
      color: '#ff2d95',
      title: '该休息啦！',
      desc: '站起来走两步，看看远处，让眼睛和颈椎放个假。',
      done: '我休息了 🛋️',
      voice: '该休息啦，起来活动一下',
      caption: '提醒你休息'
    }
  };

  const STORE_KEY = { settings: 'kunkun.settings.v1', stats: 'kunkun.stats.v1' };

  /* ------------------------------------------------------------------ 状态 */
  const settings = {
    water: { minutes: 45, enabled: true },
    rest: { minutes: 60, enabled: true },
    sound: true,
    speech: true,
    petSize: 'max'          // 宠物默认大小：max 迷你 / mid 小小 / min 超小
  };
  const PET_SIZE_KEYS = ['max', 'mid', 'min'];

  const rt = {
    running: true,
    alertKind: null,
    timers: {
      water: { remaining: 45 * 60, total: 45 * 60 },
      rest: { remaining: 60 * 60, total: 60 * 60 }
    }
  };

  let stats = { date: '', water: 0, rest: 0 };
  let moodTimer = null;

  /* --------------------------------------------------------------- 小工具 */
  const $ = (s, root) => (root || document).querySelector(s);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  function todayKey() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function fmt(sec) {
    sec = Math.max(0, Math.ceil(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const p = n => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
  }

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
      if (!settings.sound) return;
      this.ensure();
      if (!this.ctx) return;
      const melody = [523.25, 659.25, 783.99, 1046.50, 783.99, 1046.50, 1318.51];
      melody.forEach((f, i) => this.tone(f, i * 0.11, 0.19, 'square', 0.075));
      [130.81, 196.00, 261.63].forEach((f, i) => this.tone(f, i * 0.26, 0.5, 'triangle', 0.06));
    },
    /* 完成：轻快两声 */
    confirm() {
      if (!settings.sound) return;
      this.ensure();
      if (!this.ctx) return;
      [783.99, 1046.50, 1318.51].forEach((f, i) => this.tone(f, i * 0.07, 0.16, 'square', 0.07));
    },
    /* 点击：短促电子音 */
    click() {
      if (!settings.sound) return;
      this.ensure();
      if (!this.ctx) return;
      this.tone(880, 0, 0.06, 'square', 0.045);
      this.tone(1320, 0.05, 0.06, 'square', 0.03);
    }
  };

  /* --------------------------------------------------------------- 语音播报 */
  function speak(text) {
    if (!settings.speech || !('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN';
      u.rate = 1.05;
      u.pitch = 1.15;
      window.speechSynthesis.speak(u);
    } catch (e) { /* 忽略 */ }
  }

  /* =========================================================================
     Canvas：电子提醒器
     ========================================================================= */
  /* 配色照着参考图取 */
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
      el.width = Math.round(w * k);
      el.height = Math.round(h * k);
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
      const s = Math.min(w / this.fit, h / this.fit);

      ctx.save();
      ctx.translate(w / 2, h * 0.94);
      ctx.scale(s, s);

      this.drawGround(ctx, t, mood);
      drawFigure(ctx, t, mood, energy);
      this.drawOrbits(ctx, t, mood);

      ctx.restore();
    }

    drawGround(ctx, t, mood) {
      const pulse = mood === 'idle' ? 1 + Math.sin(t * 1.6) * 0.04 : 1 + Math.sin(t * 8) * 0.12;
      const g = ctx.createRadialGradient(0, 0, 4, 0, 0, 150 * pulse);
      const a = mood === 'idle' ? 0.30 : 0.55;
      g.addColorStop(0, `rgba(0,229,255,${a})`);
      g.addColorStop(0.5, `rgba(138,92,255,${a * 0.45})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(0, 0, 165 * pulse, 34 * pulse, 0, 0, Math.PI * 2);
      ctx.fill();

      // 地面光环虚线
      ctx.save();
      ctx.strokeStyle = 'rgba(0,229,255,.45)';
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
        ctx.fillStyle = i % 2 ? '#ff2d95' : '#00e5ff';
        ctx.shadowColor = ctx.fillStyle;
        ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.arc(x, y, size, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }
    }
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
    ctx.shadowColor = 'rgba(0,229,255,.5)';
    ctx.shadowBlur = mood === 'idle' ? 8 : 16;
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
    const g = ctx.createLinearGradient(0, -70, 0, 66);
    g.addColorStop(0, C.chickL);
    g.addColorStop(0.5, C.chick);
    g.addColorStop(1, C.chickD);
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
    const hg = ctx.createLinearGradient(0, -96, 0, 24);
    hg.addColorStop(0, C.hairL);
    hg.addColorStop(0.55, C.hair);
    hg.addColorStop(1, C.hairD);
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
    ctx.shadowColor = 'rgba(0,229,255,.4)';
    ctx.shadowBlur = 8;
    roundRect(ctx, -16, -9, 32, 14, 7);
    ctx.fill();
    ctx.restore();
  }

  /* =========================================================================
     DOM & 交互
     ========================================================================= */
  const stage = new Kunkun($('#stage'));
  const alertStage = new Kunkun($('#alertStage'), { fit: 300 });

  const el = {
    clock: $('#digitalClock'),
    date: $('#dateLine'),
    caption: $('#stageCaption'),
    overlay: $('#overlay'),
    alertTitle: $('#alertTitle'),
    alertDesc: $('#alertDesc'),
    alertDone: $('#alertDone'),
    alertSnooze: $('#alertSnooze'),
    alertClose: $('#alertClose'),
    floatWords: $('#floatWords'),
    btnToggle: $('#btnToggle'),
    btnResetAll: $('#btnResetAll'),
    btnTest: $('#btnTest'),
    chkSound: $('#chkSound'),
    chkSpeech: $('#chkSpeech'),
    chkNotify: $('#chkNotify'),
    btnPet: $('#btnPet'),
    btnTray: $('#btnTray'),
    tbMin: $('#tbMin'),
    tbTray: $('#tbTray'),
    tbClose: $('#tbClose'),
    petSizeRow: $('#petSizeRow'),
    petSizeSeg: $('#petSizeSeg'),
    panels: { water: $('#panel-water'), rest: $('#panel-rest') }
  };

  /* 桌面版（Electron）才有：抢前台 / 托盘 / 宠物模式 */
  const native = window.kunkunNative || null;
  if (native) document.body.classList.add('desktop');

  /* 把运行状态回传给主进程，用于刷新托盘菜单 */
  function pushState() {
    if (!native || !native.syncState) return;
    native.syncState({ running: rt.running, petMode: document.body.classList.contains('pet') });
  }

  /* 主界面上的「宠物默认大小」选择 */
  function updatePetSizeUI() {
    if (!el.petSizeSeg) return;
    const btns = el.petSizeSeg.querySelectorAll('button');
    for (let i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('on', btns[i].dataset.size === settings.petSize);
    }
  }

  function choosePetSize(name) {
    if (PET_SIZE_KEYS.indexOf(name) < 0) return;
    settings.petSize = name;
    saveSettings();
    updatePetSizeUI();
    Sound.click();
    if (native && native.setPetSize) native.setPetSize(name);
    setCaption(`宠物默认大小已设为 <b>${{ max: '迷你 150×170', mid: '小小 118×134', min: '超小 92×104' }[name]}</b>`);
  }

  /* 切换宠物模式（按钮和主进程菜单都走这里） */
  function setPetMode(on) {    document.body.classList.toggle('pet', on);
    el.btnPet.textContent = on ? '🐣 退出宠物模式' : '🐣 宠物模式';
    el.btnPet.classList.toggle('primary', on);
    stage.fit = on ? 268 : 330;
    setCaption(on ? '宠物模式 · 右键出菜单' : '待机中 · 到点会提醒你');
    pushState();
    setTimeout(() => { fitApp(); stage.resize(); alertStage.resize(); }, 80);
  }

  /* ---------------------------------------------------------- 本地存储 */
  function loadStore() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY.settings) || '{}');
      if (s && typeof s === 'object') {
        ['water', 'rest'].forEach(k => {
          if (s[k]) {
            if (Number.isFinite(+s[k].minutes)) settings[k].minutes = clamp(Math.round(+s[k].minutes), 1, 600);
            if (typeof s[k].enabled === 'boolean') settings[k].enabled = s[k].enabled;
          }
        });
        if (typeof s.sound === 'boolean') settings.sound = s.sound;
        if (typeof s.speech === 'boolean') settings.speech = s.speech;
        if (s.petSize && PET_SIZE_KEYS.indexOf(s.petSize) >= 0) settings.petSize = s.petSize;
      }
    } catch (e) { /* 忽略损坏数据 */ }

    try {
      const st = JSON.parse(localStorage.getItem(STORE_KEY.stats) || '{}');
      if (st && st.date) stats = { date: st.date, water: +st.water || 0, rest: +st.rest || 0 };
    } catch (e) { /* 忽略 */ }

    if (stats.date !== todayKey()) stats = { date: todayKey(), water: 0, rest: 0 };
  }

  function saveSettings() {
    try { localStorage.setItem(STORE_KEY.settings, JSON.stringify(settings)); } catch (e) { }
  }
  function saveStats() {
    try { localStorage.setItem(STORE_KEY.stats, JSON.stringify(stats)); } catch (e) { }
  }

  /* ---------------------------------------------------------- 计时逻辑 */
  function setInterval_(kind, minutes) {
    settings[kind].minutes = clamp(Math.round(minutes) || 1, 1, 600);
    resetTimer(kind);
    saveSettings();
  }

  function resetTimer(kind) {
    const total = settings[kind].minutes * 60;
    rt.timers[kind].total = total;
    rt.timers[kind].remaining = total;
  }

  function resetAll() {
    ['water', 'rest'].forEach(resetTimer);
    render();
  }

  function fire(kind, opts) {
    if (rt.alertKind) return;                    // 已有提醒在进行
    rt.alertKind = kind;
    const meta = META[kind];
    const info = opts || {};

    el.alertTitle.textContent = meta.title;
    el.alertTitle.dataset.text = meta.title;
    el.alertDesc.textContent = info.desc || meta.desc;
    el.alertDone.textContent = info.done || meta.done;
    el.overlay.hidden = false;
    alertStage.setMood('dance');
    alertStage.resize();
    spawnWords();

    stage.setMood('dance');
    setCaption(`<b>${meta.caption}！</b>`);

    Sound.alert();
    speak(info.voice || meta.voice);
    notify(meta.title, info.desc || meta.desc);
    flashTitle(true);
    if (native) native.alert(kind);          // 桌面版：把窗口抢到最前台
    try { el.alertDone.focus(); } catch (e) { }
  }

  function closeAlert() {
    rt.alertKind = null;
    el.overlay.hidden = true;
    el.floatWords.innerHTML = '';
    flashTitle(false);
    if (native) native.dismiss();
    setMood('cheer', 2200);
  }

  function completeAlert() {
    const kind = rt.alertKind;
    if (!kind) return;
    if (stats.date !== todayKey()) stats = { date: todayKey(), water: 0, rest: 0 };
    stats[kind] = (stats[kind] || 0) + 1;
    saveStats();
    resetTimer(kind);
    Sound.confirm();
    closeAlert();
    render();
  }

  function snoozeAlert() {
    const kind = rt.alertKind;
    if (!kind) return;
    rt.timers[kind].remaining = SNOOZE_SEC;
    rt.timers[kind].total = Math.max(rt.timers[kind].total, SNOOZE_SEC);
    closeAlert();
    setCaption(`<b>${META[kind].name}</b>提醒已延后 5 分钟`);
    render();
  }

  function setMood(m, ms) {
    stage.setMood(m);
    if (moodTimer) clearTimeout(moodTimer);
    if (ms) moodTimer = setTimeout(() => { if (!rt.alertKind) stage.setMood('idle'); }, ms);
  }

  function setCaption(html) { el.caption.innerHTML = html; }

  /* ---------------------------------------------------------- 系统通知 */
  function notify(title, body) {
    if (!el.chkNotify.checked) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try { new Notification('电子提醒器 · ' + title, { body: body, tag: 'kunkun-reminder' }); } catch (e) { }
  }

  function askNotify() {
    if (!('Notification' in window)) { el.chkNotify.checked = false; return; }
    if (Notification.permission === 'granted') return;
    if (Notification.permission === 'denied') { el.chkNotify.checked = false; return; }
    Notification.requestPermission().then(p => { el.chkNotify.checked = (p === 'granted'); })
      .catch(() => { el.chkNotify.checked = false; });
  }

  /* ---------------------------------------------------------- 标题闪烁 */
  let flashTimer = null, flashOn = false;
  function flashTitle(on) {
    if (flashTimer) { clearInterval(flashTimer); flashTimer = null; }
    if (!on) { flashOn = false; updateTitle(); return; }
    flashTimer = setInterval(() => {
      flashOn = !flashOn;
      document.title = flashOn ? '🔔 时间到啦！' : '　　';
    }, 650);
  }

  function updateTitle() {
    if (flashTimer || rt.alertKind) return;
    let best = null, bestKind = null;
    ['water', 'rest'].forEach(k => {
      if (!settings[k].enabled) return;
      const r = rt.timers[k].remaining;
      if (best === null || r < best) { best = r; bestKind = k; }
    });
    document.title = bestKind
      ? `${fmt(best)} ${META[bestKind].emoji} 电子提醒器`
      : '电子提醒器 · 喝水休息提醒';
  }

  /* ---------------------------------------------------------- 飘字动画 */
  const WORDS = ['唱', '跳', 'rap', '篮球', '🏀', '💧', '中分', '背带裤', '你干嘛~', '哎哟', '休息', '我打球去了'];
  function spawnWords() {
    el.floatWords.innerHTML = '';
    for (let i = 0; i < 10; i++) {
      const s = document.createElement('span');
      s.textContent = WORDS[Math.floor(Math.random() * WORDS.length)];
      s.style.left = (8 + Math.random() * 84) + '%';
      s.style.animationDelay = (Math.random() * 0.9).toFixed(2) + 's';
      s.style.fontSize = (17 + Math.random() * 16).toFixed(0) + 'px';
      el.floatWords.appendChild(s);
    }
  }

  /* ---------------------------------------------------------- 等比缩放 */
  /* 主界面按 1180 × 842 的设计尺寸排版，窗口多大就整体缩放到多大 */
  const DESIGN_W = 1180, DESIGN_H = 842;

  function fitApp() {
    const app = $('#app');
    if (!app) return;
    if (document.body.classList.contains('pet')) {
      app.style.transform = '';
      app.style.left = '0px';
      app.style.top = '0px';
      stage.resize();
      return;
    }
    const tb = $('#titlebar');
    const tbH = (tb && getComputedStyle(tb).display !== 'none') ? tb.offsetHeight : 0;
    const availW = Math.max(1, window.innerWidth);
    const availH = Math.max(1, window.innerHeight - tbH);
    // 用实际内容高度，避免最后一截被切掉（transform 不影响布局，量出来是稳定的）
    const designH = Math.max(DESIGN_H, app.offsetHeight || 0);
    const s = Math.min(availW / DESIGN_W, availH / designH);
    app.style.top = tbH + 'px';
    app.style.left = Math.max(0, (availW - DESIGN_W * s) / 2) + 'px';
    app.style.transform = 'scale(' + s + ')';
    stage.resize();
    alertStage.resize();
  }

  let fitPending = false;
  function requestFit() {
    if (fitPending) return;
    fitPending = true;
    requestAnimationFrame(() => { fitPending = false; fitApp(); });
  }
  window.addEventListener('resize', requestFit);

  /* ---------------------------------------------------------- 渲染 */
  function render() {
    // 时钟
    const now = new Date();
    const p = n => String(n).padStart(2, '0');
    el.clock.textContent = `${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
    const wk = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][now.getDay()];
    el.date.textContent = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 · ${wk}`;

    ['water', 'rest'].forEach(kind => {
      const panel = el.panels[kind];
      const t = rt.timers[kind];
      const on = settings[kind].enabled;
      panel.classList.toggle('off', !on);
      $('[data-role="countdown"]', panel).textContent = on ? fmt(t.remaining) : '--:--';
      const ratio = t.total > 0 ? clamp(t.remaining / t.total, 0, 1) : 0;
      $('[data-role="ring"]', panel).style.strokeDashoffset = String(RING_C * (1 - ratio));
      const n = stats[kind] || 0;
      $('[data-role="count"]', panel).textContent = String(n);
      const bar = $('[data-role="bar"]', panel);
      bar.style.width = Math.min(100, (n / BAR_TARGET[kind]) * 100) + '%';
    });

    el.btnToggle.textContent = rt.running ? '⏸ 暂停计时' : '▶ 继续计时';
    el.btnToggle.classList.toggle('primary', rt.running);

    if (!rt.alertKind) {
      const idle = !settings.water.enabled && !settings.rest.enabled;
      if (idle) setCaption('两个提醒都关掉了');
      else if (!rt.running) setCaption('<b>计时已暂停</b>');
    }
    updateTitle();
  }

  /* ---------------------------------------------------------- 主循环 */
  let last = Date.now();
  function tick() {
    const now = Date.now();
    let dt = (now - last) / 1000;
    last = now;
    if (dt < 0) dt = 0;
    if (dt > 3600) dt = 3600;

    if (rt.running && !rt.alertKind) {
      for (const kind of ['water', 'rest']) {
        if (!settings[kind].enabled) continue;
        const t = rt.timers[kind];
        t.remaining -= dt;
        if (t.remaining <= 0) {
          t.remaining = 0;
          fire(kind);
          break;
        }
      }
    }
    render();
  }

  function loop(now) {
    stage.frame(now);
    if (!el.overlay.hidden) alertStage.frame(now);
    requestAnimationFrame(loop);
  }

  /* ---------------------------------------------------------- 事件绑定 */
  function bindPanel(kind) {
    const panel = el.panels[kind];

    $('[data-role="enable"]', panel).addEventListener('change', e => {
      settings[kind].enabled = e.target.checked;
      saveSettings();
      Sound.click();
      render();
    });

    $('[data-role="minutes"]', panel).addEventListener('change', e => {
      setInterval_(kind, +e.target.value);
      e.target.value = settings[kind].minutes;
      render();
    });

    $('[data-role="reset"]', panel).addEventListener('click', () => {
      resetTimer(kind);
      Sound.click();
      setCaption(`<b>${META[kind].name}</b>计时已重新开始`);
      render();
    });

    $('[data-role="skip"]', panel).addEventListener('click', () => {
      fire(kind);
    });

    panel.querySelectorAll('.mini').forEach(btn => {
      btn.addEventListener('click', () => {
        const m = +btn.dataset.min;
        setInterval_(kind, m);
        $('[data-role="minutes"]', panel).value = settings[kind].minutes;
        Sound.click();
        setCaption(`<b>${META[kind].name}</b>间隔已设为 ${settings[kind].minutes} 分钟`);
        render();
      });
    });
  }

  function bindAll() {
    bindPanel('water');
    bindPanel('rest');

    el.btnToggle.addEventListener('click', () => {
      rt.running = !rt.running;
      Sound.click();
      setCaption(rt.running ? '计时已继续' : '<b>计时已暂停</b>');
      pushState();
      render();
    });

    el.btnResetAll.addEventListener('click', () => {
      resetAll();
      Sound.click();
      setCaption('全部重置完毕 · 重新开始计时');
    });

    el.btnTest.addEventListener('click', () => {
      const kind = settings.water.enabled ? 'water' : 'rest';
      fire(kind, { desc: '这是一次试听，正式提醒也会这样出现。', done: '知道了', voice: '提醒效果就是这样' });
    });

    /* 宠物模式：缩成只剩动画的悬浮小窗 */
    el.btnPet.addEventListener('click', () => {
      Sound.click();
      const on = !document.body.classList.contains('pet');
      setPetMode(on);
      if (native) native.setPetMode(on);
    });

    /* 自绘标题栏三个按钮 */
    if (el.tbMin) el.tbMin.addEventListener('click', () => { if (native) native.minimize(); });
    if (el.tbTray) el.tbTray.addEventListener('click', () => { if (native) native.hideToTray(); });
    if (el.tbClose) el.tbClose.addEventListener('click', () => { if (native) native.hideToTray(); });

    /* 手动拖窗：普通模式拖标题栏，宠物模式整个窗口都能拖
       （CSS 的 -webkit-app-region 在透明窗口上不生效，所以自己算偏移） */
    if (native && native.dragStart) {
      let dragging = false;
      const isPet = () => document.body.classList.contains('pet');

      document.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;                       // 右键留给菜单
        const t = e.target;
        const onButton = t && t.closest && t.closest('.tb-btn, .btn, .mini, button, input, label');
        const inTitlebar = t && t.closest && t.closest('.titlebar');
        if (!isPet() && (!inTitlebar || onButton)) return; // 普通模式只拖标题栏
        if (isPet() && onButton) return;

        dragging = true;
        try { document.body.setPointerCapture(e.pointerId); } catch (err) { }
        native.dragStart({ x: e.screenX, y: e.screenY });
        e.preventDefault();
      });

      document.addEventListener('pointermove', e => {
        if (!dragging) return;
        native.dragMove({ x: e.screenX, y: e.screenY });
      });

      const stopDrag = e => {
        if (!dragging) return;
        dragging = false;
        try { document.body.releasePointerCapture(e.pointerId); } catch (err) { }
        native.dragEnd();
      };
      document.addEventListener('pointerup', stopDrag);
      document.addEventListener('pointercancel', stopDrag);
    }

    /* 收进系统托盘 */
    if (el.btnTray) {
      el.btnTray.addEventListener('click', () => {
        Sound.click();
        if (native) native.hideToTray();
      });
    }

    /* 宠物模式（以及主界面画布）上右键 → 原生菜单：
       显示主界面 / 收进托盘 / 调整倒计时 / 退出 */
    document.addEventListener('contextmenu', (e) => {
      if (!native || !native.petMenu) return;
      if (!document.body.classList.contains('pet')) return;   // 只在宠物模式拦截
      e.preventDefault();
      native.petMenu();
    });

    /* 主进程发来的指令 */
    if (native && native.onTrayAlert) {
      native.onTrayAlert(kind => { if (META[kind]) fire(kind); });
    }
    if (native && native.onTrayToggle) {
      native.onTrayToggle(() => el.btnToggle.click());
    }
    if (native && native.onPetModeChanged) {
      native.onPetModeChanged(on => { setPetMode(!!on); });
    }
    if (native && native.onSetInterval) {
      native.onSetInterval(d => {
        if (!d || !META[d.kind]) return;
        setInterval_(d.kind, d.minutes);
        const input = $('[data-role="minutes"]', el.panels[d.kind]);
        if (input) input.value = settings[d.kind].minutes;
        Sound.click();
        setCaption(`<b>${META[d.kind].name}</b>间隔已设为 ${settings[d.kind].minutes} 分钟`);
        render();
      });
    }

    /* 主界面：宠物默认大小 */
    if (el.petSizeSeg) {
      el.petSizeSeg.addEventListener('click', e => {
        const b = e.target.closest ? e.target.closest('button[data-size]') : null;
        if (b) choosePetSize(b.dataset.size);
      });
    }
    if (native && native.onPetSizeChanged) {
      native.onPetSizeChanged(name => {
        if (PET_SIZE_KEYS.indexOf(name) < 0) return;
        settings.petSize = name;
        saveSettings();
        updatePetSizeUI();
      });
    }

    el.chkSound.addEventListener('change', e => {
      settings.sound = e.target.checked;
      saveSettings();
      if (settings.sound) Sound.click();
    });

    el.chkSpeech.addEventListener('change', e => {
      settings.speech = e.target.checked;
      saveSettings();
      if (settings.speech) speak('语音播报已开启');
    });

    el.chkNotify.addEventListener('change', e => {
      if (e.target.checked) askNotify();
    });

    el.alertDone.addEventListener('click', completeAlert);
    el.alertSnooze.addEventListener('click', snoozeAlert);
    el.alertClose.addEventListener('click', snoozeAlert);

    el.overlay.addEventListener('click', e => { if (e.target === el.overlay) snoozeAlert(); });

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && rt.alertKind) { snoozeAlert(); return; }
      if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
      const k = e.key.toLowerCase();
      if (e.code === 'Space') {
        e.preventDefault();
        el.btnToggle.click();
      } else if (k === 'w') {
        fire('water');
      } else if (k === 'r') {
        fire('rest');
      }
    });

    // 首次交互解锁音频
    const unlock = () => { Sound.ensure(); document.removeEventListener('pointerdown', unlock); };
    document.addEventListener('pointerdown', unlock);

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) { last = Date.now(); render(); }
    });
  }

  /* ---------------------------------------------------------- 启动 */
  function init() {
    loadStore();
    el.chkSound.checked = settings.sound;
    el.chkSpeech.checked = settings.speech;
    ['water', 'rest'].forEach(kind => {
      const panel = el.panels[kind];
      $('[data-role="enable"]', panel).checked = settings[kind].enabled;
      $('[data-role="minutes"]', panel).value = settings[kind].minutes;
      resetTimer(kind);
    });
    if ('Notification' in window && Notification.permission === 'granted') el.chkNotify.checked = true;
    if (native && el.btnTray) el.btnTray.hidden = false;
    if (native && el.petSizeRow) el.petSizeRow.hidden = false;
    updatePetSizeUI();
    if (native && native.setPetSize) native.setPetSize(settings.petSize);   // 把上次的选择告诉主进程

    bindAll();
    pushState();
    render();
    fitApp();
    setTimeout(fitApp, 60);
    last = Date.now();
    setInterval(tick, 250);
    requestAnimationFrame(loop);

    setCaption('待机中 · 到点会提醒你');
    setTimeout(() => { if (!rt.alertKind) setCaption('待机中 · 到点会提醒你'); }, 10);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
