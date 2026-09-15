/* =========================================================================
   电子坤坤 · 喝水休息提醒器
   纯前端实现：计时 / 提醒 / 音效 / 语音 / Canvas 电子坤坤动画
   所有美术与音乐均由代码实时绘制与合成（原创），无任何外部素材与依赖
   ========================================================================= */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ 常量 */
  const RING_C = 2 * Math.PI * 52;          // 进度环周长
  const SNOOZE_SEC = 5 * 60;                // 稍后提醒 = 5 分钟
  const STORE_KEY = { settings: 'kunkun.settings.v1', stats: 'kunkun.stats.v1' };

  /* 提醒事项的候选配色（夏日：晴空蓝 / 草绿 / 阳光黄 / 湖水青 …） */
  const PALETTE = ['#4A9BD4', '#6FB56B', '#E8B843', '#3E9AA8', '#7FA8D9', '#8FBF6A', '#D9A15F', '#5FB3A8'];

  /* 新建提醒时可选的图标 */
  const EMOJI_PICK = ['💧', '🛋️', '💊', '🏃', '🧘', '👀', '🍎', '☕', '🚶', '🧴', '🦷', '🐣'];

  /* 内置的两条提醒（用户还能自己加） */
  function defaultItems() {
    return [
      {
        id: 'water', name: '喝水', emoji: '💧', minutes: 45, enabled: true,
        color: PALETTE[0], goal: 8,
        title: '该喝水啦！',
        desc: '咕嘟咕嘟～ 补充水分，大脑转得更快，皮肤也会谢谢你。',
        done: '我喝了 💧',
        voice: '该喝水啦，快喝一杯水吧'
      },
      {
        id: 'rest', name: '休息', emoji: '🛋️', minutes: 60, enabled: true,
        color: PALETTE[1], goal: 6,
        title: '该休息啦！',
        desc: '站起来走两步，看看远处，让眼睛和颈椎放个假。',
        done: '我休息了 🛋️',
        voice: '该休息啦，起来活动一下'
      }
    ];
  }

  /* 十二时辰 · 子午流注：每个时辰哪条经络当令、这段时间该怎么照顾自己 */
  const SHICHEN = [
    { name: '子时', from: 23, to: 1,  label: '23:00 - 01:00', meridian: '胆经',   tag: '睡觉', tip: '该睡了。胆经当令，熬夜最耗胆气，尽量 23 点前躺下。' },
    { name: '丑时', from: 1,  to: 3,  label: '01:00 - 03:00', meridian: '肝经',   tag: '睡觉', tip: '深睡养肝。肝在这时候解毒藏血，别熬夜、别喝酒。' },
    { name: '寅时', from: 3,  to: 5,  label: '03:00 - 05:00', meridian: '肺经',   tag: '睡觉', tip: '熟睡时段。肺经当令，保持睡眠，别起身活动。' },
    { name: '卯时', from: 5,  to: 7,  label: '05:00 - 07:00', meridian: '大肠经', tag: '喝水', tip: '起床先喝一杯温水，帮肠道动起来，顺便养成排便习惯。' },
    { name: '辰时', from: 7,  to: 9,  label: '07:00 - 09:00', meridian: '胃经',   tag: '早餐', tip: '该吃早饭了。胃经当令，吃点温热的，别空着肚子出门。' },
    { name: '巳时', from: 9,  to: 11, label: '09:00 - 11:00', meridian: '脾经',   tag: '锻炼', tip: '一天里精力最好的时候。适合专注干活，每小时起来动一动。' },
    { name: '午时', from: 11, to: 13, label: '11:00 - 13:00', meridian: '心经',   tag: '午休', tip: '吃午饭，饭后小睡 15～30 分钟，养心安神。' },
    { name: '未时', from: 13, to: 15, label: '13:00 - 15:00', meridian: '小肠经', tag: '喝水', tip: '小肠经当令，多喝水帮助吸收营养，别一直坐着。' },
    { name: '申时', from: 15, to: 17, label: '15:00 - 17:00', meridian: '膀胱经', tag: '喝水', tip: '补水黄金期。多喝水、多走动，犯困就起来拉伸一下。' },
    { name: '酉时', from: 17, to: 19, label: '17:00 - 19:00', meridian: '肾经',   tag: '喝水', tip: '肾经当令。适量喝水、别憋尿，晚饭别吃太咸。' },
    { name: '戌时', from: 19, to: 21, label: '19:00 - 21:00', meridian: '心包经', tag: '散步', tip: '散散步、听听音乐放松一下，别做剧烈运动，也别再喝咖啡。' },
    { name: '亥时', from: 21, to: 23, label: '21:00 - 23:00', meridian: '三焦经', tag: '睡觉', tip: '准备睡觉：少喝水免得夜里起夜，放下手机，泡个脚。' }
  ];

  /* ------------------------------------------------------------ 今日黄历
     日柱用儒略日推算：干支序 = (JDN + 49) % 60
     已用真实黄历反查校验：2000-01-01 → 己卯年 丙子月 戊午日（破日）
     以及 2026-09-15 → 丙午年 丁酉月 壬辰日，本程序算出的结果完全一致。 */
  const GAN = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];
  const ZHI = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];

  /* 建除十二神及其传统宜忌 */
  const JIANCHU = [
    { name: '建', yi: '出行 · 上任 · 祈福 · 求嗣', ji: '动土 · 开仓 · 掘井' },
    { name: '除', yi: '扫舍 · 疗病 · 除服 · 祭祀', ji: '出行 · 赴任 · 求财' },
    { name: '满', yi: '祈福 · 结亲 · 开市 · 立契', ji: '服药 · 栽种 · 上任' },
    { name: '平', yi: '修整 · 涂泥 · 平治道涂', ji: '祈福 · 求嗣 · 开市' },
    { name: '定', yi: '嫁娶 · 开市 · 立契 · 入学', ji: '诉讼 · 出行 · 搬迁' },
    { name: '执', yi: '嫁娶 · 祈福 · 立约 · 捕捉', ji: '开市 · 出财 · 搬家' },
    { name: '破', yi: '破屋 · 求医 · 治病除灾', ji: '嫁娶 · 开市 · 动土' },
    { name: '危', yi: '祭祀 · 安床 · 祈福', ji: '登高 · 行船 · 远行' },
    { name: '成', yi: '嫁娶 · 开市 · 入学 · 立约', ji: '诉讼 · 破土' },
    { name: '收', yi: '收纳 · 进财 · 纳畜', ji: '开仓 · 出行 · 安葬' },
    { name: '开', yi: '祈福 · 开市 · 入学 · 动土', ji: '安葬 · 破土' },
    { name: '闭', yi: '筑堤 · 修造 · 安葬', ji: '开市 · 出行 · 求医' }
  ];

  /* 十二个「节」的近似交节日期（用于定月支，误差 ±1 天） */
  const JIE = [
    { m: 1, d: 6, zhi: 1, name: '小寒' },
    { m: 2, d: 4, zhi: 2, name: '立春' },
    { m: 3, d: 6, zhi: 3, name: '惊蛰' },
    { m: 4, d: 5, zhi: 4, name: '清明' },
    { m: 5, d: 6, zhi: 5, name: '立夏' },
    { m: 6, d: 6, zhi: 6, name: '芒种' },
    { m: 7, d: 7, zhi: 7, name: '小暑' },
    { m: 8, d: 8, zhi: 8, name: '立秋' },
    { m: 9, d: 8, zhi: 9, name: '白露' },
    { m: 10, d: 8, zhi: 10, name: '寒露' },
    { m: 11, d: 7, zhi: 11, name: '立冬' },
    { m: 12, d: 7, zhi: 0, name: '大雪' }
  ];

  /* 五虎遁：甲己起丙寅，乙庚起戊寅，丙辛起庚寅，丁壬起壬寅，戊癸起甲寅 */
  const MONTH_START_GAN = [2, 4, 6, 8, 0];

  function jdnOf(y, m, d) {
    const a = Math.floor((14 - m) / 12);
    const yy = y + 4800 - a;
    const mm = m + 12 * a - 3;
    return d + Math.floor((153 * mm + 2) / 5) + 365 * yy +
      Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045;
  }

  function ganzhiName(idx) {
    const i = ((idx % 60) + 60) % 60;
    return GAN[i % 10] + ZHI[i % 12];
  }

  function almanacOf(date) {
    const d = date || new Date();
    const y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();

    /* 年柱：立春（约 2/4）前算上一年 */
    const yBase = (m < 2 || (m === 2 && day < 4)) ? y - 1 : y;
    const yearIdx = (((yBase - 4) % 60) + 60) % 60;

    /* 月支：找最近一个已过的节 */
    let zhi = 0, jieName = '大雪';
    for (let i = JIE.length - 1; i >= 0; i--) {
      if (m > JIE[i].m || (m === JIE[i].m && day >= JIE[i].d)) {
        zhi = JIE[i].zhi; jieName = JIE[i].name; break;
      }
    }
    const yearGan = yearIdx % 10;
    const monthGan = (MONTH_START_GAN[yearGan % 5] + (((zhi - 2) % 12) + 12) % 12) % 10;
    /* 天干月干 + 地支 zhi 在六十甲子里的序号 */
    let monthIdx = 0;
    for (let i = 0; i < 60; i++) {
      if (i % 10 === monthGan && i % 12 === zhi) { monthIdx = i; break; }
    }

    /* 日柱 */
    const dayIdx = ((jdnOf(y, m, day) + 49) % 60 + 60) % 60;

    /* 建除：月建上起建 —— 日支与月支相同者为「建」 */
    const jc = (((dayIdx % 12) - zhi) % 12 + 12) % 12;

    return {
      year: ganzhiName(yearIdx),
      month: ganzhiName(monthIdx),
      day: ganzhiName(dayIdx),
      zhi: zhi,
      jie: jieName,
      jc: JIANCHU[jc],
      dateText: y + '年' + m + '月' + day + '日'
    };
  }

  /* ------------------------------------------------------------------ 状态 */
  const settings = {
    items: defaultItems(),     // 提醒事项列表（用户可增删改）
    sound: true,
    speech: true,
    petSize: 'max',            // 宠物默认大小：max 迷你 / mid 小小 / min 超小
    skin: '__default',         // 宠物形象：__default = 代码手绘，其余为 skins/ 里的皮肤
  };
  const PET_SIZE_KEYS = ['max', 'mid', 'min'];

  const rt = {
    running: true,
    alertId: null,             // 正在弹提醒的那条事项 id
    sleeping: false,           // 电脑睡眠 / 息屏时自动暂停计时
    timers: {}                 // id -> { remaining, total }
  };

  let stats = { date: '', counts: {} };
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
     Canvas：电子坤坤
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
      const s = Math.min(w / this.fit, h / this.fit);

      ctx.save();
      ctx.translate(w / 2, h * 0.94);
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

  /* ------------------------------------------------------------ 皮肤系统
     用户可以自己换宠物形象：在 exe 同级的 skins/<名字>/ 里放 skin.json + 一张精灵图。
     这里只负责把主进程读来的图按 mood 切帧画出来。 */
  const skinState = { id: '__default', img: null, meta: null, ready: false };

  function skinAnimFor(mood) {
    const m = skinState.meta;
    if (!m || !m.animations) return null;
    return m.animations[mood] || m.animations.idle || null;
  }

  /* 返回 true 表示这一帧由皮肤画掉了；false 表示该走代码手绘 */
  function drawSkin(ctx, t, mood) {
    if (!skinState.ready || !skinState.img || !skinState.meta) return false;
    const m = skinState.meta;
    const a = skinAnimFor(mood);
    if (!a || !m.frame) return false;
    const fw = m.frame.w, fh = m.frame.h;
    const count = Math.max(1, a.count || 1);
    /* 每种状态可以有自己的帧率：待机慢一点才不烦，跳舞/欢呼才需要快 */
    const fps = a.fps || m.fps || 10;
    const idx = Math.floor(t * fps) % count;
    const row = a.row || 0;
    /* 与手绘角色对齐：底边落在原点、横向居中，整体高度约 278 个本地单位 */
    const k = 278 / fh;
    const dw = fw * k, dh = fh * k;
    try {
      ctx.drawImage(skinState.img, idx * fw, row * fh, fw, fh, -dw / 2, -dh, dw, dh);
    } catch (e) { return false; }
    return true;
  }

  function applySkin(data) {
    if (!data || data.builtin || data.error) {
      skinState.id = '__default';
      skinState.img = null;
      skinState.meta = null;
      skinState.ready = false;
      if (data && data.error) setCaption('皮肤加载失败，已用回默认形象：' + data.error);
      return;
    }
    const img = new Image();
    img.onload = function () {
      skinState.id = data.id;
      skinState.img = img;
      skinState.meta = data.meta;
      skinState.ready = true;
      setCaption('已换上新形象：<b>' + (data.name || data.id) + '</b>');
    };
    img.onerror = function () {
      setCaption('皮肤图片读不出来，已用回默认形象');
    };
    img.src = data.sheet;
  }

  function loadSkin(id) {
    if (!native || !native.skinLoad) return;
    native.skinLoad(id).then(function (d) {
      applySkin(d);
    }).catch(function () { });
  }

  function fillSkinPicker() {
    if (!native || !native.skinsList || !el.skinSel) return;
    native.skinsList().then(function (list) {
      el.skinSel.innerHTML = '';
      (list || []).forEach(function (s) {
        const o = document.createElement('option');
        o.value = s.id;
        o.textContent = s.name;                 // 只显示名字，不带作者后缀
        el.skinSel.appendChild(o);
      });
      /* 存的皮肤没了就退回默认 */
      const ids = (list || []).map(function (s) { return s.id; });
      if (ids.indexOf(settings.skin) < 0) settings.skin = '__default';
      el.skinSel.value = settings.skin;
    }).catch(function () { });
  }

  /* --------------------------------------------------------------- 绘制开关 */
  /* 宠物模式（plain）下：不画地面光圈、不画环绕粒子，角色也不加发光。
     桌面上只要角色本体，其余全部透明。 */
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
    btnPet: $('#btnPet'),
    btnTray: $('#btnTray'),
    btnAddItem: $('#btnAddItem'),
    panelList: $('#panelList'),
    alGz: $('#alGz'),
    alYi: $('#alYi'),
    alJi: $('#alJi'),
    tbMin: $('#tbMin'),
    tbTray: $('#tbTray'),
    tbClose: $('#tbClose'),
    petSizeRow: $('#petSizeRow'),
    petSizeSeg: $('#petSizeSeg'),
    skinRow: $('#skinRow'),
    skinSel: $('#skinSel'),
    chkSound: $('#chkSound'),
    chkSpeech: $('#chkSpeech'),
    chkNotify: $('#chkNotify'),
    scOverlay: $('#shichenOverlay'),
    scNow: $('#scNow'),
    scNowSub: $('#scNowSub'),
    scTip: $('#scTip'),
    scList: $('#scList'),
    scClose: $('#scClose'),
    itemOverlay: $('#itemOverlay'),
    itTitle: $('#itTitle'),
    itName: $('#itName'),
    itEmoji: $('#itEmoji'),
    itMinutes: $('#itMinutes'),
    itSave: $('#itSave'),
    itCancel: $('#itCancel'),
    itClose: $('#itClose')
  };

  /* 桌面版（Electron）才有：抢前台 / 托盘 / 宠物模式 / 电源事件 */
  const native = window.kunkunNative || null;
  if (native) document.body.classList.add('desktop');

  /* ============================================================ 提醒事项模型 */
  function itemById(id) {
    for (let i = 0; i < settings.items.length; i++) {
      if (settings.items[i].id === id) return settings.items[i];
    }
    return null;
  }
  function itemIndex(id) {
    for (let i = 0; i < settings.items.length; i++) {
      if (settings.items[i].id === id) return i;
    }
    return -1;
  }
  function newId() {
    return 'it' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  function normalizeItem(it) {
    const name = String(it.name || '提醒').slice(0, 12);
    return {
      id: String(it.id),
      name: name,
      emoji: it.emoji || '⏰',
      minutes: clamp(Math.round(+it.minutes) || 30, 1, 600),
      enabled: it.enabled !== false,
      color: it.color || PALETTE[0],
      goal: clamp(Math.round(+it.goal) || 8, 1, 99),
      title: it.title || ('该' + name + '啦！'),
      desc: it.desc || ('到点啦，' + name + '的时间到了。'),
      done: it.done || '我完成了',
      voice: it.voice || ('该' + name + '了')
    };
  }
  function makeItem(name, emoji, minutes) {
    return normalizeItem({
      id: newId(),
      name: name,
      emoji: emoji,
      minutes: minutes,
      enabled: true,
      color: PALETTE[settings.items.length % PALETTE.length],
      goal: 8
    });
  }

  /* 把最新的提醒列表同步给主进程（托盘菜单 / 宠物右键菜单要用） */
  function pushState() {
    if (!native || !native.syncState) return;
    native.syncState({
      running: rt.running,
      petMode: document.body.classList.contains('pet'),
      items: settings.items.map(function (it) {
        return { id: it.id, name: it.name, emoji: it.emoji, minutes: it.minutes };
      })
    });
  }

  /* ---------------------------------------------------------- 宠物模式 */
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
    /* 主进程那边改完窗口尺寸之后，重新量一次宠物本体大小 */
    setTimeout(syncPetBox, 260);
    const txt = { max: '迷你 150×170', mid: '小小 118×134', min: '超小 92×104' }[name];
    setCaption('宠物默认大小已设为 <b>' + txt + '</b>');
  }

  function setPetMode(on, fromMain) {
    if (!on) endTalk();                    // 退出宠物模式时把气泡收掉
    document.body.classList.toggle('pet', on);
    el.btnPet.textContent = on ? '🐣 退出宠物模式' : '🐣 宠物模式';
    el.btnPet.classList.toggle('primary', on);
    stage.fit = on ? 268 : 330;
    stage.plain = on;                      // 宠物模式：去掉地面光圈、环绕粒子、角色发光
    if (on) setCaption('宠物模式 · 点我一下，我告诉你现在是什么时辰');
    else setCaption('待机中 · 到点会提醒你');
    pushState();

    const settle = function () {
      if (!fromMain && native && native.setPetMode) native.setPetMode(on);
      fitApp();
      syncPetBox();
      stage.resize();
      alertStage.resize();
    };

    /* 进宠物模式：先把「只剩小鸡」这一版画出来，再让窗口缩成宠物大小。
       反过来的话，窗口缩小那一帧会拿主界面去裁切，看起来就是主界面向
       宠物那块矩形缩了一下、闪一下。 */
    if (on) afterPaint(settle);
    else setTimeout(settle, 80);
  }

  /* ---------------------------------------------------------- 本地存储 */
  function loadStore() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY.settings) || '{}');
      if (s && typeof s === 'object') {
        if (Array.isArray(s.items) && s.items.length) {
          settings.items = s.items
            .filter(function (it) { return it && it.id && it.name; })
            .map(normalizeItem);
        } else if (s.water || s.rest) {
          /* 老版本只有「喝水 / 休息」两条，平滑迁移过来 */
          const items = defaultItems();
          if (s.water) {
            items[0].minutes = clamp(Math.round(+s.water.minutes) || 45, 1, 600);
            items[0].enabled = s.water.enabled !== false;
          }
          if (s.rest) {
            items[1].minutes = clamp(Math.round(+s.rest.minutes) || 60, 1, 600);
            items[1].enabled = s.rest.enabled !== false;
          }
          settings.items = items;
        }
        if (typeof s.sound === 'boolean') settings.sound = s.sound;
        if (typeof s.speech === 'boolean') settings.speech = s.speech;
        if (s.petSize && PET_SIZE_KEYS.indexOf(s.petSize) >= 0) settings.petSize = s.petSize;
        if (typeof s.skin === 'string' && s.skin) settings.skin = s.skin;
      }
    } catch (e) { /* 忽略损坏数据 */ }
    if (!settings.items.length) settings.items = defaultItems();

    /* 事项颜色一律按调色板顺序派生（软件没有自定义颜色的功能）。
       这样换配色方案以后，老用户 localStorage 里的旧颜色也能立刻跟上，
       不需要版本号，也不会出现「版本号已是最新但颜色还是旧的」这种死角。 */
    settings.items.forEach(function (it, i) {
      it.color = PALETTE[i % PALETTE.length];
    });

    try {
      const st = JSON.parse(localStorage.getItem(STORE_KEY.stats) || '{}');
      if (st && st.date) {
        if (st.counts && typeof st.counts === 'object') {
          stats = { date: st.date, counts: st.counts };
        } else {
          /* 老版统计：{ water, rest } */
          stats = { date: st.date, counts: { water: +st.water || 0, rest: +st.rest || 0 } };
        }
      }
    } catch (e) { /* 忽略 */ }

    if (stats.date !== todayKey()) stats = { date: todayKey(), counts: {} };
  }

  function saveSettings() {
    try { localStorage.setItem(STORE_KEY.settings, JSON.stringify(settings)); } catch (e) { }
  }
  function saveStats() {
    try { localStorage.setItem(STORE_KEY.stats, JSON.stringify(stats)); } catch (e) { }
  }

  /* ---------------------------------------------------------- 计时逻辑 */
  function ensureTimer(it) {
    const total = it.minutes * 60;
    const t = rt.timers[it.id];
    if (!t) rt.timers[it.id] = { remaining: total, total: total };
    else if (t.total !== total) {
      t.total = total;
      t.remaining = Math.min(t.remaining, total);
    }
  }

  function resetTimer(id) {
    const it = itemById(id);
    if (!it) return;
    const total = it.minutes * 60;
    rt.timers[id] = { remaining: total, total: total };
  }

  function setItemMinutes(id, minutes) {
    const it = itemById(id);
    if (!it) return;
    it.minutes = clamp(Math.round(minutes) || 1, 1, 600);
    resetTimer(id);
    saveSettings();
  }

  function resetAll() {
    settings.items.forEach(function (it) { resetTimer(it.id); });
    render();
  }

  /* ---------------------------------------------------------- 到点提醒 */
  function fire(id, opts) {
    if (rt.alertId) return;                       // 已有提醒在进行
    const it = itemById(id);
    if (!it) return;
    rt.alertId = id;
    const info = opts || {};
    const title = info.title || it.title || ('该' + it.name + '啦！');

    el.alertTitle.textContent = title;
    el.alertTitle.dataset.text = title;
    el.alertDesc.textContent = info.desc || it.desc || '';
    el.alertDone.textContent = info.done || it.done || '我完成了';
    el.overlay.style.setProperty('--accent', it.color || '#4A9BD4');
    el.overlay.hidden = false;

    alertStage.setMood('dance');
    alertStage.resize();
    spawnWords();
    stage.setMood('dance');
    setCaption('<b>' + (it.emoji || '') + ' ' + it.name + ' 时间到了！</b>');

    Sound.alert();
    speak(info.voice || it.voice || ('该' + it.name + '了'));
    notify(title, info.desc || it.desc || '');
    flashTitle(true);
    if (native) native.alert(id);
    try { el.alertDone.focus(); } catch (e) { }
  }

  function closeAlert() {
    rt.alertId = null;
    el.overlay.hidden = true;
    el.floatWords.innerHTML = '';
    flashTitle(false);
    if (native) native.dismiss();
    setMood('cheer', 2200);
  }

  function completeAlert() {
    const id = rt.alertId;
    if (!id) return;
    if (stats.date !== todayKey()) stats = { date: todayKey(), counts: {} };
    stats.counts[id] = (stats.counts[id] || 0) + 1;
    saveStats();
    resetTimer(id);
    Sound.confirm();
    closeAlert();
    render();
  }

  function snoozeAlert() {
    const id = rt.alertId;
    if (!id) return;
    const t = rt.timers[id] || { total: SNOOZE_SEC };
    rt.timers[id] = { remaining: SNOOZE_SEC, total: Math.max(t.total, SNOOZE_SEC) };
    const it = itemById(id);
    closeAlert();
    if (it) setCaption('<b>' + it.name + '</b>提醒已延后 5 分钟');
    render();
  }

  function setMood(m, ms) {
    stage.setMood(m);
    if (moodTimer) clearTimeout(moodTimer);
    if (ms) moodTimer = setTimeout(function () { if (!rt.alertId) stage.setMood('idle'); }, ms);
  }

  function setCaption(html) { el.caption.innerHTML = html; }

  /* ------------------------------------------- 睡眠 / 息屏自动暂停 */
  /* gapPause：不是电源事件、而是靠「两次 tick 间隔异常大」推测出来的暂停，
     时间恢复流动后自动解除；电源事件触发的暂停只能由 resume / unlock 解除。 */
  let gapPause = false;

  function setSleepPause(on) {
    if (rt.sleeping === on) return;
    rt.sleeping = on;
    last = Date.now();                 // 不管暂停还是恢复，都把基准时间拉到现在
    if (on) {
      setCaption('<b>电脑睡眠 / 息屏中</b> · 计时已自动暂停');
      stage.setMood('idle');
    } else {
      setCaption('电脑已唤醒 · 计时继续');
    }
    render();
  }

  /* ---------------------------------------------------------- 系统通知 */
  function notify(title, body) {
    if (!el.chkNotify.checked) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try { new Notification('电子坤坤 · ' + title, { body: body, tag: 'kunkun-reminder' }); } catch (e) { }
  }

  function askNotify() {
    if (!('Notification' in window)) { el.chkNotify.checked = false; return; }
    if (Notification.permission === 'granted') return;
    if (Notification.permission === 'denied') { el.chkNotify.checked = false; return; }
    Notification.requestPermission().then(function (p) { el.chkNotify.checked = (p === 'granted'); })
      .catch(function () { el.chkNotify.checked = false; });
  }

  /* ---------------------------------------------------------- 标题闪烁 */
  let flashTimer = null, flashOn = false;
  function flashTitle(on) {
    if (flashTimer) { clearInterval(flashTimer); flashTimer = null; }
    if (!on) { flashOn = false; updateTitle(); return; }
    flashTimer = setInterval(function () {
      flashOn = !flashOn;
      document.title = flashOn ? '🔔 时间到啦！' : '　　';
    }, 650);
  }

  function updateTitle() {
    if (flashTimer || rt.alertId) return;
    let best = null, bestKind = null;
    settings.items.forEach(function (it) {
      if (!it.enabled) return;
      const t = rt.timers[it.id];
      if (!t) return;
      if (best === null || t.remaining < best) { best = t.remaining; bestKind = it; }
    });
    if (bestKind) {
      document.title = fmt(best) + ' ' + (bestKind.emoji || '') + ' 电子坤坤';
    } else {
      document.title = '电子坤坤 · 喝水休息提醒器';
    }
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
  const DESIGN_W = 1180, DESIGN_H = 842;

  /* 宠物本体那一块的尺寸：只在「进入宠物模式」和「改宠物大小」时量一次。
     不在 resize 里量 —— 说话窗口缩放会让 Windows 把尺寸取整成 1px 的偏差，
     重量一次小鸡就会跟着动一下，看着就是闪。 */
  function syncPetBox() {
    if (!document.body.classList.contains('pet')) return;
    const w = Math.max(40, Math.round(window.innerWidth));
    const h = Math.max(40, Math.round(window.innerHeight));
    document.documentElement.style.setProperty('--pet-w', w + 'px');
    document.documentElement.style.setProperty('--pet-h', h + 'px');
  }

  function fitApp() {
    const app = $('#app');
    if (!app) return;
    if (document.body.classList.contains('pet')) {
      app.style.transform = '';
      app.style.left = '0px';
      app.style.top = '0px';
      syncPetBox();          // 宠物窗尺寸一变就重新量（说话不再改窗口，所以这里很安全）
      stage.resize();
      return;
    }
    const tb = $('#titlebar');
    const tbH = (tb && getComputedStyle(tb).display !== 'none') ? tb.offsetHeight : 0;
    const availW = Math.max(1, window.innerWidth);
    const availH = Math.max(1, window.innerHeight - tbH);
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
    requestAnimationFrame(function () { fitPending = false; fitApp(); });
  }
  window.addEventListener('resize', requestFit);

  /* ============================================================ 十二时辰 */
  function currentShichen(d) {
    const h = (d || new Date()).getHours();
    for (let i = 0; i < SHICHEN.length; i++) {
      const s = SHICHEN[i];
      if (s.from < s.to) {
        if (h >= s.from && h < s.to) return s;
      } else if (h >= s.from || h < s.to) {   // 子时跨午夜
        return s;
      }
    }
    return SHICHEN[0];
  }

  function renderShichen() {
    const cur = currentShichen();
    el.scNow.textContent = cur.name;
    el.scNowSub.textContent = cur.label + ' · ' + cur.meridian + '当令 · 宜' + cur.tag;
    el.scTip.textContent = cur.tip;
    el.scList.innerHTML = '';
    SHICHEN.forEach(function (s) {
      const row = document.createElement('div');
      row.className = 'sc-row' + (s === cur ? ' on' : '');
      const sn = document.createElement('span'); sn.className = 'sn'; sn.textContent = s.name;
      const st = document.createElement('span'); st.className = 'st'; st.textContent = s.label;
      const sm = document.createElement('span'); sm.className = 'sm'; sm.textContent = s.meridian;
      const sx = document.createElement('span'); sx.className = 'sx'; sx.textContent = s.tip;
      row.appendChild(sn); row.appendChild(st); row.appendChild(sm); row.appendChild(sx);
      el.scList.appendChild(row);
    });
  }

  function openShichen() {
    renderShichen();
    el.scOverlay.hidden = false;
    const on = el.scList.querySelector('.sc-row.on');
    if (on && on.scrollIntoView) {
      try { on.scrollIntoView({ block: 'center' }); } catch (e) { }
    }
  }
  function closeShichen() { el.scOverlay.hidden = true; }

  /* ================================================== 今日黄历（宜忌） */
  let almanacDate = '';

  function renderAlmanac() {
    if (!el.alGz) return;
    const al = almanacOf(new Date());
    almanacDate = todayKey();
    const gz = document.createElement('b');
    gz.textContent = al.day;
    el.alGz.textContent = '';
    el.alGz.appendChild(document.createTextNode(al.year + '年 ' + al.month + '月 '));
    el.alGz.appendChild(gz);
    el.alGz.appendChild(document.createTextNode('日 · ' + al.jc.name + '日 · ' + al.jie));
    el.alYi.textContent = al.jc.yi;
    el.alJi.textContent = al.jc.ji;
  }

  /* ============================================ 宠物说话（点一下小鸡） */
  let talkTimer = null;
  let talking = false;

  /* 最近要到的提醒，作为气泡最后一行 */
  function nextReminderText() {
    let best = null, bestIt = null;
    settings.items.forEach(function (it) {
      if (!it.enabled) return;
      const t = rt.timers[it.id];
      if (!t) return;
      if (best === null || t.remaining < best) { best = t.remaining; bestIt = it; }
    });
    if (!bestIt) return '现在没有开启的提醒事项';
    if (rt.sleeping) return '电脑睡着中 · 计时已暂停';
    const m = Math.max(1, Math.round(best / 60));
    return '再过约 ' + m + ' 分钟该' + bestIt.name + '了';
  }

  /* 气泡现已是独立的小窗（见 main.js），宠物窗说话时一动不动，
     所以这里不再需要「等两帧再动窗口」这套补丁了。 */
  function afterPaint(fn) {
    requestAnimationFrame(function () {
      requestAnimationFrame(fn);
    });
  }

  /* 气泡默认放宠物哪一侧：宠物在桌面左半边 → 放右边，反之放左边 */
  function talkPrefSide(screenX, winW) {
    const scr = window.screen || {};
    const availW = scr.availWidth || scr.width || 1920;
    return ((screenX || 0) + winW / 2) < availW / 2 ? 'right' : 'left';
  }

  function petTalk() {
    if (!document.body.classList.contains('pet')) return;

    /* 已经开着就先收起来，等于再点一次切换 */
    if (talking) { endTalk(); return; }

    const cur = currentShichen();
    talking = true;

    /* 只把文字内容交给主进程，位置由它按桌面边界算 ——
       宠物窗本身不缩放、不移动，所以不可能出现错位的闪烁。 */
    if (native && native.petTalk) {
      native.petTalk({
        head: '现在是 ' + cur.name + '（' + cur.label + '）',
        mer: cur.meridian + '当令 · 宜' + cur.tag,
        tip: cur.tip,
        next: nextReminderText(),
        side: talkPrefSide(window.screenX, Math.max(60, window.innerWidth))
      });
    }

    if (talkTimer) clearTimeout(talkTimer);
    talkTimer = setTimeout(endTalk, 5000);     // 气泡显示 5 秒后自动收起
  }

  function endTalk() {
    if (talkTimer) { clearTimeout(talkTimer); talkTimer = null; }
    if (!talking) return;
    talking = false;
    if (native && native.petTalkEnd) native.petTalkEnd();
  }

  /* ====================================================== 添加 / 编辑事项 */
  let editingId = null;
  let pickedEmoji = '⏰';

  function renderEmojiPick() {
    el.itEmoji.innerHTML = '';
    EMOJI_PICK.forEach(function (e) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = e;
      b.classList.toggle('on', e === pickedEmoji);
      b.addEventListener('click', function () { pickedEmoji = e; renderEmojiPick(); });
      el.itEmoji.appendChild(b);
    });
  }

  function openItemModal(id) {
    editingId = id || null;
    const it = id ? itemById(id) : null;
    el.itTitle.textContent = it ? '修改提醒事项' : '添加提醒事项';
    el.itName.value = it ? it.name : '';
    el.itMinutes.value = it ? it.minutes : 30;
    pickedEmoji = it ? it.emoji : '⏰';
    el.itName.style.borderColor = '';
    renderEmojiPick();
    el.itemOverlay.hidden = false;
    setTimeout(function () { try { el.itName.focus(); } catch (e) { } }, 50);
  }
  function closeItemModal() { el.itemOverlay.hidden = true; }

  function saveItemModal() {
    const name = el.itName.value.trim().slice(0, 12);
    if (!name) {
      el.itName.style.borderColor = '#e5484d';
      try { el.itName.focus(); } catch (e) { }
      return;
    }
    const minutes = clamp(Math.round(+el.itMinutes.value) || 30, 1, 600);

    if (editingId) {
      const it = itemById(editingId);
      if (it) {
        it.name = name;
        it.emoji = pickedEmoji;
        it.minutes = minutes;
        it.title = '该' + name + '啦！';
        it.desc = '到点啦，' + name + '的时间到了。';
        it.voice = '该' + name + '了';
        it.done = '我完成了';
        resetTimer(editingId);
      }
    } else {
      const it = makeItem(name, pickedEmoji, minutes);
      settings.items.push(it);
      resetTimer(it.id);
    }

    saveSettings();
    renderPanels();
    render();
    pushState();
    closeItemModal();
    Sound.click();
    setCaption('已保存提醒：<b>' + name + '</b>，每 ' + minutes + ' 分钟一次');
  }

  function deleteItem(id) {
    const it = itemById(id);
    if (!it) return;
    if (!window.confirm('确定删除「' + it.name + '」这条提醒吗？')) return;
    const i = itemIndex(id);
    if (i < 0) return;
    settings.items.splice(i, 1);
    delete rt.timers[id];
    if (stats.counts) delete stats.counts[id];
    saveSettings();
    saveStats();
    renderPanels();
    render();
    pushState();
    setCaption('已删除提醒：<b>' + it.name + '</b>');
  }

  /* ================================================================ 渲染 */
  const QUICK_MINUTES = [15, 30, 45, 60, 90];

  function buildPanel(it, idx) {
    const art = document.createElement('article');
    art.className = 'card panel';
    art.dataset.id = it.id;
    art.style.setProperty('--accent', it.color || PALETTE[idx % PALETTE.length]);
    art.innerHTML =
      '<header class="panel-head">' +
        '<h2><span class="ico"></span><span class="pname"></span></h2>' +
        '<div class="panel-tools">' +
          '<button class="icon-btn" data-role="edit" title="改名称 / 图标 / 间隔">编辑</button>' +
          '<button class="icon-btn del" data-role="del" title="删除这条提醒">删除</button>' +
          '<label class="switch" title="启用 / 停用">' +
            '<input type="checkbox" data-role="enable"><span class="slider"></span></label>' +
        '</div>' +
      '</header>' +
      '<div class="panel-body">' +
        '<div class="ring-wrap">' +
          '<svg class="ring" viewBox="0 0 120 120" aria-hidden="true">' +
            '<circle class="ring-bg" cx="60" cy="60" r="52"></circle>' +
            '<circle class="ring-fg" cx="60" cy="60" r="52" data-role="ring"></circle>' +
          '</svg>' +
          '<div class="ring-text"><b data-role="countdown">--:--</b><small>下次提醒</small></div>' +
        '</div>' +
        '<div class="ctrl">' +
          '<div class="row"><span class="label">间隔</span>' +
            '<input type="number" data-role="minutes" min="1" max="600" step="1">' +
            '<span class="unit">分钟</span></div>' +
          '<div class="quick"></div>' +
          '<div class="actions">' +
            '<button class="btn sm" data-role="reset">重置本轮</button>' +
            '<button class="btn sm" data-role="skip">立即提醒</button>' +
          '</div>' +
          '<div class="stat">今日已 <b data-role="count">0</b> 次 · 每日目标 ' +
            '<input type="number" class="goal-input" data-role="goal" min="1" max="99" step="1" title="每天想做几次，直接改这里"> 次</div>' +
          '<div class="bar"><i data-role="bar"></i></div>' +
        '</div>' +
      '</div>';

    /* 文本一律用 textContent 填，避免名字里的符号被当成 HTML */
    $('.ico', art).textContent = it.emoji || '⏰';
    $('.pname', art).textContent = it.name;
    $('[data-role="enable"]', art).checked = it.enabled;
    $('[data-role="minutes"]', art).value = it.minutes;
    $('[data-role="goal"]', art).value = it.goal || 8;
    const quick = $('.quick', art);
    QUICK_MINUTES.forEach(function (m) {
      const b = document.createElement('button');
      b.className = 'mini';
      b.dataset.min = String(m);
      b.textContent = m + '分';
      quick.appendChild(b);
    });
    return art;
  }

  function renderPanels() {
    el.panelList.innerHTML = '';
    settings.items.forEach(function (it, i) {
      el.panelList.appendChild(buildPanel(it, i));
    });
    capPanelList();
  }

  /* 提醒事项多了以后，整个界面不能被撑长（那样等比缩放会把字越缩越小）。
     这里量一下「列表之外」占了多少高度，把剩下的留给列表，多出来的就滚动看。 */
  function capPanelList() {
    const list = el.panelList;
    const app = $('#app');
    if (!list || !app) return;

    list.style.maxHeight = 'none';
    const others = app.offsetHeight - list.offsetHeight;   // offsetHeight 不含 transform 缩放
    const room = DESIGN_H - others;

    if (list.offsetHeight > room && room > 200) {
      list.style.maxHeight = Math.round(room) + 'px';
      list.classList.add('scrollable');
    } else {
      list.style.maxHeight = 'none';
      list.classList.remove('scrollable');
    }
    requestFit();
  }

  function render() {
    const now = new Date();
    const p = function (n) { return String(n).padStart(2, '0'); };
    el.clock.textContent = p(now.getHours()) + ':' + p(now.getMinutes()) + ':' + p(now.getSeconds());
    const wk = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][now.getDay()];
    el.date.textContent = now.getFullYear() + '年' + (now.getMonth() + 1) + '月' + now.getDate() + '日 · ' + wk;

    settings.items.forEach(function (it, i) {
      const art = el.panelList.children[i];
      if (!art) return;
      const t = rt.timers[it.id] || { remaining: 0, total: 1 };
      art.classList.toggle('off', !it.enabled);
      $('[data-role="countdown"]', art).textContent = it.enabled ? fmt(t.remaining) : '--:--';
      const ratio = t.total > 0 ? clamp(t.remaining / t.total, 0, 1) : 0;
      $('[data-role="ring"]', art).style.strokeDashoffset = String(RING_C * (1 - ratio));
      const n = (stats.counts && stats.counts[it.id]) || 0;
      $('[data-role="count"]', art).textContent = String(n);
      $('[data-role="bar"]', art).style.width = Math.min(100, (n / (it.goal || 8)) * 100) + '%';
    });

    el.btnToggle.textContent = rt.running ? '⏸ 暂停计时' : '▶ 继续计时';
    el.btnToggle.classList.toggle('primary', rt.running);

    if (!rt.alertId) {
      const anyOn = settings.items.some(function (it) { return it.enabled; });
      if (rt.sleeping) setCaption('<b>电脑睡眠 / 息屏中</b> · 计时已自动暂停');
      else if (!anyOn) setCaption('所有提醒都关掉了');
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

    /* 两次 tick 之间隔了很久 —— 电脑睡过 / 息屏过，这段时间不计入倒计时 */
    if (dt > 30) {
      if (!rt.sleeping) { gapPause = true; setSleepPause(true); }
      dt = 0;
    } else if (rt.sleeping && gapPause) {
      /* 时间又正常流动了，说明机器已经醒着（这条只对「推测出来的暂停」生效） */
      gapPause = false;
      setSleepPause(false);
    }

    if (rt.running && !rt.sleeping && !rt.alertId) {
      for (let i = 0; i < settings.items.length; i++) {
        const it = settings.items[i];
        if (!it.enabled) continue;
        const t = rt.timers[it.id];
        if (!t) continue;
        t.remaining -= dt;
        if (t.remaining <= 0) {
          t.remaining = 0;
          fire(it.id);
          break;
        }
      }
    }
    if (almanacDate !== todayKey()) renderAlmanac();   // 跨天刷新黄历
    /* 窗口看不见的时候不碰 DOM：倒计时照常算、到点照样弹提醒，
       但没必要每 250ms 去改一堆元素的文本和宽度。 */
    if (animRunning) render();
  }

  /* ------------------------------------------------- 空闲时把开销压到最低
     收进托盘后实测仍占近两个核心，原因就是隐藏时动画和 DOM 刷新全在跑。
     这里在窗口不可见时：停掉画布 rAF、把计时器降到 1 秒、暂停 CSS 动画。
     倒计时用 Date.now() 差值推进，所以降频不影响准点，最多晚 1 秒。 */
  let rafId = 0;
  let animRunning = false;      // 初始为 false，交给 startAnim() 真正拉起来
  let tickTimer = 0;
  let tickMs = 250;

  /* 限帧：rAF 每秒 60 次会让合成器每帧都给这扇（透明、1181×881 的）窗口做一次
     完整合成 —— 实测 GPU 进程因此长期吃满 140%，而画面本身根本没变。
     这个角色动画是慢速呼吸/摇摆，30fps 肉眼分辨不出，成本却直接砍半。
     注意用的是 rAF 的时间戳推进动画，所以动画速度不受限帧影响。 */
  const FRAME_MS = 1000 / 30;
  let lastFrameAt = 0;

  function loop(now) {
    if (!animRunning) return;
    rafId = requestAnimationFrame(loop);
    if (now - lastFrameAt < FRAME_MS - 1) return;   // 这一帧跳过
    lastFrameAt = now;
    stage.frame(now);
    if (!el.overlay.hidden) alertStage.frame(now);
  }

  function startAnim() {
    if (animRunning) return;
    animRunning = true;
    lastFrameAt = 0;
    rafId = requestAnimationFrame(loop);
  }

  function stopAnim() {
    animRunning = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  }

  function setTickRate(ms) {
    if (tickMs === ms && tickTimer) return;
    tickMs = ms;
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(tick, ms);
  }

  function applyVisibility(visible) {
    document.body.classList.toggle('anim-off', !visible);
    if (visible === animRunning) return;
    if (visible) {
      last = Date.now();
      setTickRate(250);
      startAnim();
      render();
    } else {
      setTickRate(1000);
      stopAnim();
    }
  }

  /* ---------------------------------------------------------- 事件绑定 */
  function bindPanelList() {
    /* 面板是动态生成的，事件用委托接 */
    el.panelList.addEventListener('click', function (e) {
      const art = e.target.closest ? e.target.closest('.panel') : null;
      if (!art) return;
      const id = art.dataset.id;
      const minBtn = e.target.closest ? e.target.closest('.mini') : null;
      if (minBtn) {
        setItemMinutes(id, +minBtn.dataset.min);
        render();
        return;
      }
      const roleEl = e.target.closest ? e.target.closest('[data-role]') : null;
      if (!roleEl) return;
      const role = roleEl.dataset.role;
      const it = itemById(id);
      if (role === 'reset') {
        resetTimer(id);
        Sound.click();
        if (it) setCaption('<b>' + it.name + '</b> 计时已重新开始');
        render();
      } else if (role === 'skip') {
        fire(id);
      } else if (role === 'edit') {
        openItemModal(id);
      } else if (role === 'del') {
        deleteItem(id);
      }
    });

    el.panelList.addEventListener('change', function (e) {
      const art = e.target.closest ? e.target.closest('.panel') : null;
      if (!art) return;
      const id = art.dataset.id;
      const it = itemById(id);
      if (!it) return;
      const role = e.target.dataset ? e.target.dataset.role : '';
      if (role === 'enable') {
        it.enabled = e.target.checked;
        saveSettings();
        Sound.click();
        render();
        pushState();
      } else if (role === 'minutes') {
        setItemMinutes(id, +e.target.value);
        e.target.value = it.minutes;
        render();
      } else if (role === 'goal') {
        it.goal = clamp(Math.round(+e.target.value) || 8, 1, 99);
        e.target.value = it.goal;
        saveSettings();
        render();
      }
    });

    /* 目标次数用输入框，边打边存 */
    el.panelList.addEventListener('input', function (e) {
      if (!e.target.dataset || e.target.dataset.role !== 'goal') return;
      const art = e.target.closest ? e.target.closest('.panel') : null;
      if (!art) return;
      const it = itemById(art.dataset.id);
      if (!it) return;
      const v = clamp(Math.round(+e.target.value) || 8, 1, 99);
      it.goal = v;
      saveSettings();
      const n = (stats.counts && stats.counts[it.id]) || 0;
      $('[data-role="bar"]', art).style.width = Math.min(100, (n / v) * 100) + '%';
    });
  }

  function bindAll() {
    bindPanelList();

    el.btnToggle.addEventListener('click', function () {
      rt.running = !rt.running;
      Sound.click();
      setCaption(rt.running ? '计时已继续' : '<b>计时已暂停</b>');
      pushState();
      render();
    });

    el.btnResetAll.addEventListener('click', function () {
      resetAll();
      Sound.click();
      setCaption('全部重置完毕 · 重新开始计时');
    });

    el.btnAddItem.addEventListener('click', function () { Sound.click(); openItemModal(null); });

    el.btnPet.addEventListener('click', function () {
      Sound.click();
      setPetMode(!document.body.classList.contains('pet'));
    });

    if (el.tbMin) el.tbMin.addEventListener('click', function () { if (native) native.minimize(); });
    if (el.tbTray) el.tbTray.addEventListener('click', function () { if (native) native.hideToTray(); });
    if (el.tbClose) el.tbClose.addEventListener('click', function () { if (native) native.hideToTray(); });

    if (el.btnTray) {
      el.btnTray.addEventListener('click', function () {
        Sound.click();
        if (native) native.hideToTray();
      });
    }

    /* 手动拖窗：普通模式拖标题栏，宠物模式整个窗口都能拖
       宠物模式下「按下没怎么动就松开」= 单击 → 让小鸡开口说话 */
    if (native && native.dragStart) {
      let dragging = false;
      let downX = 0, downY = 0, moved = 0;
      let lastX = 0, lastY = 0;
      let skipTalkOnce = false;      // 这一下是用来收起气泡的，松手时别再弹开
      const isPet = function () { return document.body.classList.contains('pet'); };

      document.addEventListener('pointerdown', function (e) {
        if (e.button !== 0) return;
        const t = e.target;
        const onButton = t && t.closest && t.closest('.pb-close, .tb-btn, .btn, .mini, .icon-btn, button, input, label, .sc-row');
        const inTitlebar = t && t.closest && t.closest('.titlebar');
        if (!isPet() && (!inTitlebar || onButton)) return;
        if (isPet() && onButton) return;

        dragging = true;
        moved = 0;
        downX = e.screenX; downY = e.screenY;
        lastX = e.screenX; lastY = e.screenY;
        try { document.body.setPointerCapture(e.pointerId); } catch (err) { }

        const beginDrag = function () {
          native.dragStart({ x: downX, y: downY });
        };

        /* 气泡开着的话，按下鼠标就先把它收掉再拖。
           气泡是独立小窗，收掉它一不影响宠物窗，所以这里不需要等帧、
           也不会出现任何错位或闪烁。 */
        if (isPet() && talking) {
          endTalk();
          skipTalkOnce = true;
        } else {
          skipTalkOnce = false;
        }
        beginDrag();
        e.preventDefault();
      });

      document.addEventListener('pointermove', function (e) {
        lastX = e.screenX; lastY = e.screenY;
        if (!dragging) return;
        moved = Math.max(moved, Math.abs(e.screenX - downX) + Math.abs(e.screenY - downY));
        if (moved > 6) native.dragMove({ x: e.screenX, y: e.screenY });
      });

      const stopDrag = function (e) {
        if (!dragging) return;
        dragging = false;
        try { document.body.releasePointerCapture(e.pointerId); } catch (err) { }
        native.dragEnd();
        if (isPet() && moved <= 6 && !skipTalkOnce) petTalk();   // 单击 = 说话
        skipTalkOnce = false;
      };
      document.addEventListener('pointerup', stopDrag);
      document.addEventListener('pointercancel', stopDrag);
    }

    /* 宠物模式右键 → 原生菜单 */
    document.addEventListener('contextmenu', function (e) {
      if (!native || !native.petMenu) return;
      if (!document.body.classList.contains('pet')) return;
      e.preventDefault();
      native.petMenu();
    });

    /* 十二时辰弹层 */
    el.scClose.addEventListener('click', closeShichen);
    el.scOverlay.addEventListener('click', function (e) { if (e.target === el.scOverlay) closeShichen(); });

    /* 添加 / 编辑弹层 */
    el.itSave.addEventListener('click', saveItemModal);
    el.itCancel.addEventListener('click', closeItemModal);
    el.itClose.addEventListener('click', closeItemModal);
    el.itemOverlay.addEventListener('click', function (e) { if (e.target === el.itemOverlay) closeItemModal(); });
    el.itName.addEventListener('keydown', function (e) { if (e.key === 'Enter') saveItemModal(); });
    el.itMinutes.addEventListener('keydown', function (e) { if (e.key === 'Enter') saveItemModal(); });

    el.chkSound.addEventListener('change', function (e) {
      settings.sound = e.target.checked;
      saveSettings();
      if (settings.sound) Sound.click();
    });

    el.chkSpeech.addEventListener('change', function (e) {
      settings.speech = e.target.checked;
      saveSettings();
      if (settings.speech) speak('语音播报已开启');
    });

    el.chkNotify.addEventListener('change', function (e) {
      if (e.target.checked) askNotify();
    });

    if (el.petSizeSeg) {
      el.petSizeSeg.addEventListener('click', function (e) {
        const b = e.target.closest ? e.target.closest('button[data-size]') : null;
        if (b) choosePetSize(b.dataset.size);
      });
    }

    if (el.skinSel) {
      el.skinSel.addEventListener('change', function () {
        settings.skin = el.skinSel.value || '__default';
        saveSettings();
        Sound.click();
        loadSkin(settings.skin);
        if (native && native.skinChanged) native.skinChanged(settings.skin);
      });
    }

    el.alertDone.addEventListener('click', completeAlert);
    el.alertSnooze.addEventListener('click', snoozeAlert);
    el.alertClose.addEventListener('click', snoozeAlert);
    el.overlay.addEventListener('click', function (e) { if (e.target === el.overlay) snoozeAlert(); });

    /* 主进程发来的指令 */
    if (native) {
      if (native.onTrayAlert) native.onTrayAlert(function (id) { if (itemById(id)) fire(id); });
      if (native.onTrayToggle) native.onTrayToggle(function () { el.btnToggle.click(); });
      if (native.onPetModeChanged) native.onPetModeChanged(function (on) { setPetMode(!!on, true); });
      if (native.onSetInterval) {
        native.onSetInterval(function (d) {
          if (!d || !itemById(d.id)) return;
          setItemMinutes(d.id, d.minutes);
          render();
          Sound.click();
          const it = itemById(d.id);
          if (it) setCaption('<b>' + it.name + '</b>间隔已设为 ' + it.minutes + ' 分钟');
        });
      }
      if (native.onSetPetSize) {
        native.onSetPetSize(function (name) {
          if (PET_SIZE_KEYS.indexOf(name) < 0) return;
          settings.petSize = name;
          saveSettings();
          updatePetSizeUI();
          /* 从托盘菜单 / 宠物右键菜单改大小走的是这条路，之前漏了这一步，
             窗口缩了但小鸡那块还是旧尺寸，看起来像「改了没用」。 */
          setTimeout(function () { fitApp(); stage.resize(); }, 120);
        });
      }
      if (native.onShowShichen) native.onShowShichen(function () { openShichen(); });
      if (native.onAddItem) native.onAddItem(function () { openItemModal(null); });
      if (native.onPower) {
        native.onPower(function (kind) {
          if (kind === 'suspend' || kind === 'lock') {
            gapPause = false;          // 电源事件为准，不再靠时间跳变推测
            setSleepPause(true);
          } else if (kind === 'resume' || kind === 'unlock') {
            gapPause = false;
            setSleepPause(false);
          }
        });
      }
    }

    document.addEventListener('keydown', function (e) {
      const k = (e.key || '').toLowerCase();
      if (k === 'escape') {
        if (!el.itemOverlay.hidden) { closeItemModal(); return; }
        if (!el.scOverlay.hidden) { closeShichen(); return; }
        if (rt.alertId) { snoozeAlert(); return; }
      }
      if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
      if (e.code === 'Space') {
        e.preventDefault();
        el.btnToggle.click();
      } else if (k === 'w') {
        const it = itemById('water') || settings.items[0];
        if (it) fire(it.id);
      } else if (k === 'r') {
        const it = itemById('rest') || settings.items[1];
        if (it) fire(it.id);
      } else if (k === 't') {
        openShichen();
      }
    });

    const unlock = function () { Sound.ensure(); document.removeEventListener('pointerdown', unlock); };
    document.addEventListener('pointerdown', unlock);

    /* 窗口可见性：主进程显式通知 + 网页自身的 visibilitychange 双保险 */
    if (native && native.onWinVisible) native.onWinVisible(applyVisibility);    /* 宠物模式右键菜单里换形象 */    if (native && native.onSetSkin) {      native.onSetSkin(function (id) {        settings.skin = id || '__default';        saveSettings();        if (el.skinSel) el.skinSel.value = settings.skin;        loadSkin(settings.skin);      });    }
    document.addEventListener('visibilitychange', function () {
      applyVisibility(!document.hidden);
    });
  }

  /* ---------------------------------------------------------- 启动 */
  function init() {
    loadStore();
    el.chkSound.checked = settings.sound;
    el.chkSpeech.checked = settings.speech;
    settings.items.forEach(function (it) { ensureTimer(it); });
    if ('Notification' in window && Notification.permission === 'granted') el.chkNotify.checked = true;
    if (native && el.btnTray) el.btnTray.hidden = false;
    if (native && el.petSizeRow) el.petSizeRow.hidden = false;
    updatePetSizeUI();
    if (native && native.setPetSize) native.setPetSize(settings.petSize);

    /* 皮肤：列出可选形象，并载入上次选的那个 */
    if (native && native.skinsList && el.skinRow) {
      el.skinRow.hidden = false;
      fillSkinPicker();
      if (settings.skin && settings.skin !== '__default') loadSkin(settings.skin);
    }

    bindAll();
    renderPanels();
    pushState();
    render();
    fitApp();
    setTimeout(fitApp, 60);
    setTimeout(capPanelList, 140);   // 等字体和布局稳定后再量一次

    last = Date.now();
    setTickRate(250);
    startAnim();
    renderAlmanac();
    setCaption('待机中 · 到点会提醒你');
    applyVisibility(!document.hidden);   // 启动时按当前可见性定档
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();