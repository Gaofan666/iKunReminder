/* =========================================================================
   别感冒 · 喝水休息提醒器
   纯前端实现：计时 / 提醒 / 音效 / 语音 / Canvas 别感冒动画
   所有美术与音乐均由代码实时绘制与合成（原创），无任何外部素材与依赖
   ========================================================================= */
(function () {
  'use strict';

  /* ---------------- 角色绘制 / 皮肤 / 音效：都在 pet-draw.js 里（桌面宠物窗共用同一份） */
  const PETDRAW = window.kunkunPet;
  const Kunkun = PETDRAW.Kunkun;
  const Sound = PETDRAW.Sound;
  const skinState = PETDRAW.skin;
  const drawFigure = PETDRAW.drawFigure;
  const drawLeg = PETDRAW.drawLeg;
  const drawChickHead = PETDRAW.drawChickHead;
  const linGrad = PETDRAW.linGrad;
  const roundRect = PETDRAW.roundRect;
  const segment = PETDRAW.segment;
  const ikArm = PETDRAW.ikArm;
  /* 皮肤「取列表 / 载入」要调主进程桥，放在 skin-picker.js */
  const SKINPICK = window.kunkunSkinPicker;

  /* ------------------------------------------------------------------ 常量 */
  const RING_C = 2 * Math.PI * 52;          // 进度环周长
  const SNOOZE_SEC = 5 * 60;                // 稍后提醒 = 5 分钟
  const STORE_KEY = {
    settings: 'kunkun.settings.v1',
    stats: 'kunkun.stats.v1',
    todos: 'kunkun.todos.v1',               // 备忘录 + 待办（一次存，省得两套版本号）
    ui: 'kunkun.ui.v1'                      // 界面偏好（当前标签页、设置项）
  };

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
    petSize: 'max',            // 桌面宠物大小：max 迷你 / mid 小小 / min 超小
    petOn: false,              // 桌面宠物是否显示（独立小窗，可与主界面同时存在）
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

  /* ------------------------------------------------ 备忘 / 待办 / 界面偏好
     memos：{ id, text, done, at }
     todos：{ id, text, done, at, dueAt, notify, remindAt }
       dueAt    用户设的提醒时间（毫秒时间戳）
       remindAt 下次该弹提醒的时间；snooze 会把它往后推，程序重开时它可能已经过期
     两者都存在 STORE_KEY.todos 里，一次读写。 */
  let memos = [];
  let todos = [];
  const ui = {
    tab: 'home',               // home | todo | settings
    todoGrabFront: true,       // 待办到点是否抢前台
    todoCatchUp: true          // 重开程序时是否补提醒过期待办
  };
  /* 提醒弹层当前弹的是哪一类：'item'（喝水/休息那种循环提醒）或 'todo' */
  let alertKind = 'item';
  let alertTodoId = null;
  let alertTodo = null;

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
     Canvas：别感冒
     ========================================================================= */
  /* 配色照着参考图取 */
  /* =========================================================================
     DOM & 交互
     ========================================================================= */
  const stage = new Kunkun($('#stage'));
  const alertStage = new Kunkun($('#alertStage'), { fit: 300 });

  const el = {
    clock: $('#tbClock'),        // 顶栏时间（HH:MM:SS）
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
    itClose: $('#itClose'),
    /* 标签页 */
    tabbar: $('#tabbar'),
    tabHome: $('#tabHome'),
    tabTodo: $('#tabTodo'),
    tabSettings: $('#tabSettings'),
    todoBadge: $('#todoBadge'),
    /* 备忘 / 待办 */
    memoList: $('#memoList'),
    todoList: $('#todoList'),
    btnAddMemo: $('#btnAddMemo'),
    btnAddTodo: $('#btnAddTodo'),
    memoOverlay: $('#memoOverlay'),
    memoTitle: $('#memoTitle'),
    memoText: $('#memoText'),
    memoSave: $('#memoSave'),
    memoCancel: $('#memoCancel'),
    memoClose: $('#memoClose'),
    todoOverlay: $('#todoOverlay'),
    tdTitle: $('#tdTitle'),
    tdText: $('#tdText'),
    tdDate: $('#tdDate'),
    tdTime: $('#tdTime'),
    tdQuick: $('#tdQuick'),
    tdSave: $('#tdSave'),
    tdCancel: $('#tdCancel'),
    tdClose: $('#tdClose'),
    /* 设置 */
    chkDesktopPet: $('#chkDesktopPet'),
    desktopPetRow: $('#desktopPetRow'),
    pageTodo: $('#pageTodo'),
    chkAutoLaunch: $('#chkAutoLaunch'),
    chkAutoLaunchTodo: $('#chkAutoLaunchTodo'),
    chkTodoCatchUp: $('#chkTodoCatchUp'),
    btnOpenDataDir: $('#btnOpenDataDir'),
    setAbout: $('#setAbout'),
    /* 软件更新 */
    updCur: $('#updCur'),
    updState: $('#updState'),
    updBar: $('#updBar'),
    updFill: $('#updFill'),
    updDesc: $('#updDesc'),
    updNote: $('#updNote'),
    updNoteRow: $('#updNoteRow'),
    btnUpdCheck: $('#btnUpdCheck'),
    btnUpdDownload: $('#btnUpdDownload'),
    btnUpdInstall: $('#btnUpdInstall'),
    chkUpdAuto: $('#chkUpdAuto'),
    /* 一键摸鱼 */
    chkMoyu: $('#chkMoyu'),
    moyuKey: $('#moyuKey'),
    moyuReset: $('#moyuReset'),
    moyuDesc: $('#moyuDesc'),
    moyuPick: $('#moyuPick'),
    moyuClear: $('#moyuClear'),
    moyuTarget: $('#moyuTarget')
  };

  /* 桌面版（Electron）才有：抢前台 / 托盘 / 宠物模式 / 电源事件 */

  /* 桌面版（Electron）才有：抢前台 / 托盘 / 宠物模式 / 电源事件。
     放在最前面声明：下面的皮肤初始化、屏幕缩放适配都要用它。 */
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
      petOn: !!settings.petOn,
      petSound: settings.sound,
      skin: settings.skin,
      items: settings.items.map(function (it) {
        return { id: it.id, name: it.name, emoji: it.emoji, minutes: it.minutes };
      })
    });
  }

  /* 主进程让「主界面出来」时用（托盘菜单点「待办 / 设置」） */
  function showWindowSelf() {
    if (native && native.showWindow) native.showWindow();
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
    if (native && native.setPetSize) native.setPetSize(name);   // 主进程负责改宠物窗尺寸
    const txt = { max: '迷你 150×170', mid: '小小 118×134', min: '超小 92×104' }[name];
    setCaption('宠物大小已设为 <b>' + txt + '</b>');
  }

  /* 桌面宠物已经拆成独立窗口（pet.html + pet.js），主界面不再变形。
     这里只保留「切换宠物大小 / 形象」这些与主界面控件有关的事。 */

  /* ---------------------------------------------------------- 皮肤（主界面侧）
     绘制与皮肤状态在 pet-draw.js，取列表/载入在 skin-picker.js；
     这里只把两边接起来，并把「皮肤提示」写到舞台下方的说明文字里。 */
  function initSkin() {
    PETDRAW.setCaptionHandler(function (html) { setCaption(html); });
    PETDRAW.setSoundOn(settings.sound);
    SKINPICK.init(native, PETDRAW, {});
    if (!native || !native.skinsList || !el.skinRow) return;
    el.skinRow.hidden = false;
    SKINPICK.fillSkinPicker(el.skinSel, function (list) {
      /* 存着的皮肤已经不存在了 → 退回默认（顺手存一下，免得每次启动都白找） */
      var ids = (list || []).map(function (s) { return s.id; });
      if (ids.indexOf(settings.skin) < 0) {
        settings.skin = '__default';
        saveSettings();
      }
      return settings.skin;
    });
    if (settings.skin && settings.skin !== '__default') SKINPICK.loadSkin(settings.skin);
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
        if (typeof s.petOn === 'boolean') settings.petOn = s.petOn;
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
    alertKind = 'item';
    alertTodoId = null;
    const info = opts || {};
    const title = info.title || it.title || ('该' + it.name + '啦！');

    el.alertTitle.textContent = title;
    el.alertTitle.dataset.text = title;
    el.alertDesc.textContent = info.desc || it.desc || '';
    el.alertDone.textContent = info.done || it.done || '我完成了';
    el.alertSnooze.textContent = '5 分钟后再说';
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

  /* 待办到点：复用同一套提醒弹层，只是内容来自待办那条 */
  function fireTodo(todo, late) {
    if (rt.alertId) return;
    if (!todo) return;
    rt.alertId = todo.id;
    alertKind = 'todo';
    alertTodoId = todo.id;
    alertTodo = todo;

    const title = late ? '这条待办已经过期啦' : '到点啦！';
    el.alertTitle.textContent = title;
    el.alertTitle.dataset.text = title;
    el.alertDesc.textContent = todo.text + '\n提醒时间：' + fmtTodoTime(todo.dueAt);
    el.alertDone.textContent = '完成 ✓';
    el.alertSnooze.textContent = '10 分钟后再说';
    el.overlay.style.setProperty('--accent', '#D9A15F');
    el.overlay.hidden = false;

    alertStage.setMood('dance');
    alertStage.resize();
    spawnWords();
    stage.setMood('dance');
    setCaption('<b>⏰ 待办到点：' + escapeHtml(todo.text) + '</b>');

    Sound.alert();
    speak(late ? '有一条待办已经过期了' : '待办时间到了');
    notify(title, todo.text);
    flashTitle(true);
    /* 用户可以在设置里关掉「抢前台」 —— 关掉就只弹窗 + 系统通知，不打断工作 */
    if (native && ui.todoGrabFront) native.alert(todo.id);
    try { el.alertDone.focus(); } catch (e) { }
  }

  function closeAlert() {
    rt.alertId = null;
    alertKind = 'item';
    alertTodoId = null;
    alertTodo = null;
    el.overlay.hidden = true;
    el.floatWords.innerHTML = '';
    flashTitle(false);
    if (native) native.dismiss();
    setMood('cheer', 2200);
  }

  function completeAlert() {
    const id = rt.alertId;
    if (!id) return;
    /* 待办：勾掉完成，不动「每日次数」统计（那是喝水/休息的目标计数） */
    if (alertKind === 'todo') {
      const td = todoById(id);
      if (td) {
        td.done = true;
        td.doneAt = Date.now();
        td.remindAt = 0;
        saveTodoStore();
        renderTodos();
      }
      Sound.confirm();
      closeAlert();
      return;
    }
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
    /* 待办：把下次提醒时间往后推 10 分钟 */
    if (alertKind === 'todo') {
      const td = todoById(id);
      if (td) {
        td.remindAt = Date.now() + 10 * 60 * 1000;
        saveTodoStore();
        renderTodos();
        setCaption('待办 <b>' + escapeHtml(td.text) + '</b> 已延后 10 分钟');
      }
      closeAlert();
      return;
    }
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
    try { new Notification('别感冒 · ' + title, { body: body, tag: 'kunkun-reminder' }); } catch (e) { }
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
      document.title = fmt(best) + ' ' + (bestKind.emoji || '') + ' 别感冒';
    } else {
      document.title = '别感冒 · 喝水休息提醒器';
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

  /* ---------------------------------------------------------- 屏幕缩放适配
     ui-scale.js 给出纯函数，主进程给出「当前屏缩放 / 基准屏缩放」。
     页面只负责把内容乘上这个系数 —— 窗口逻辑尺寸由主进程改，两边各管一半，
     不会互相打架（页面改窗口会导致抖动，主进程改内容会跨进程来回）。
     浏览器模式下没有主进程，回落到 devicePixelRatio（基准 1），也能自适应。 */
  const UI_SCALE = window.kunkunUiScale || null;
  const uiScale = (function () {
    let cur = 1;          // 当前界面的缩放系数 k（主进程权威值）
    let real = 1;         // 同 k，但用「真实」显示器缩放算：宠物窗/气泡窗按它定尺寸
    let dpr = 1;          // 当前屏的缩放比例
    let baseDpr = 1;
    let authoritative = false;   // 是否已经拿到主进程给的权威值
    let lastSig = '';

    function fromInfo(info) {
      if (!info) return cur;
      dpr = Number(info.pixelRatio) || dpr;
      baseDpr = Number(info.basePixelRatio) || baseDpr;
      cur = UI_SCALE
        ? UI_SCALE.computeUiScale(dpr, baseDpr)
        : (Number(info.scale) > 0 ? Number(info.scale) : cur);
      real = UI_SCALE
        ? UI_SCALE.computeUiScale(info.realPixelRatio || dpr, baseDpr)
        : cur;
      authoritative = true;      // 之后本地推算不再覆盖它
      return cur;
    }
    /* 兜底：拿不到主进程信息时（浏览器模式/首帧），用本页 devicePixelRatio 推算。
       一旦拿到权威值就只做「是否真的变了」的判断，不再改写 k ——
       否则每次窗口 resize 都会用本地像素比把主进程的结论覆盖掉，
       而跨屏时窗口尺寸先变、devicePixelRatio 后变，这一瞬间覆盖就会算出错的缩放。 */
    function localFallback() {
      if (!UI_SCALE) return cur;
      const p = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
      dpr = p;
      if (authoritative) return cur;
      const n = UI_SCALE.computeUiScale(p, 1);
      if (Math.abs(n - cur) > 0.001) { cur = n; real = n; }
      return cur;
    }
    return {
      get: function () { return cur; },
      /* 宠物窗/气泡窗是「按物理尺寸摆放的独立窗口」，它们的尺寸只能由真实像素比决定 */
      real: function () { return real; },
      dpr: function () { return dpr; },
      set: fromInfo,
      sync: localFallback,
      attach: function (onChange) {
        if (!native || !native.onDisplayInfo) return;
        native.onDisplayInfo(function (info) {
          const before = cur;
          fromInfo(info);
          /* 只在真的变了的时候重排，避免每次跨屏移动都白跑一次布局 */
          const sig = cur.toFixed(4) + '|' + (window.innerWidth || 0) + 'x' + (window.innerHeight || 0);
          if (sig === lastSig && Math.abs(before - cur) < 0.001) return;
          lastSig = sig;
          onChange();
        });
      }
    };
  })();

  /* ---------------------------------------------------------- 等比缩放 */
  const DESIGN_W = 1180, DESIGN_H = 801;   // 内容设计高（主界面实测，删掉顶部品牌区后的布局高）
  const TITLEBAR_H = 46;                   // 顶部一条（标题栏+标签栏合并）的布局高（见 style.css）
  const MAX_SCALE = 4;

  /* 内容设计高：老版写死 842，实测布局高 862（多出的 20px 是老版就在的余量，
     基准屏上 scale 正好 1.0）。所以这里只做「下限保护」：量出来的比 842 还大就抬高，
     保证以后往界面里加东西不会被裁掉；不然仍旧用 842 ——
     这样基准屏上的观感与老版【完全一致】，跨屏也精确恒定。 */
  let layoutH = DESIGN_H;
  let measured = false;
  function measureLayout() {
    const app = $('#app');
    if (!app) return;
    const saved = app.style.transform;
    app.style.transform = 'none';            // 量的是布局尺寸，必须先把缩放摘掉
    const natural = app.scrollHeight || app.offsetHeight || 0;
    app.style.transform = saved;
    if (natural > DESIGN_H + 24) layoutH = natural;   // 只是变高才采用（含 24px 容差）
  }

  /* 宠物本体那一块的尺寸：只在「进入宠物模式」和「改宠物大小」时量一次。
     不在 resize 里量 —— 说话窗口缩放会让 Windows 把尺寸取整成 1px 的偏差，
     重量一次小鸡就会跟着动一下，看着就是闪。 */
  /* 宠物本体那一块的尺寸变量（--pet-w/--pet-h）以前给「主窗口变形」用，
     现在宠物是独立窗口（pet.js 自己按 innerWidth 算），主界面不再需要。 */

  function fitApp() {
    const view = $('#view');
    if (!view) return;
    const k = uiScale.get();
    if (!measured) { measured = true; measureLayout(); }
    /* 设计尺寸是「物理像素」，按 k 换算到本屏的逻辑尺寸后，内容才会在
       不同分辨率/缩放的屏幕上保持一样的物理大小。 */
    const designW = DESIGN_W * k;
    document.documentElement.style.setProperty('--ui-scale', String(k));

    const tb = $('#titlebar');
    /* 顶栏布局高按 1/k 缩，但留 24 DIP 的地板（里面的字和按钮不能无限小）。 */
    const tbH = Math.max(24, Math.round(TITLEBAR_H / k));
    document.documentElement.style.setProperty('--tb-h', tbH + 'px');
    const tbShown = !!(tb && getComputedStyle(tb).display !== 'none');
    if (tb) tb.style.transform = tbShown ? 'scale(' + (1 / k).toFixed(4) + ')' : '';

    /* 顶部只有一条顶栏（标签页并入标题栏了），内容可用高度 = 窗口高 − 顶栏 */
    const topChrome = tbShown ? tbH : 0;
    const availW = Math.max(1, window.innerWidth);
    const availH = Math.max(1, window.innerHeight - topChrome);
    /* 待办页要「填满窗口剩余高度」：它比主界面高，用 JS 把可用高度写进 CSS 变量，
       比在 CSS 里拿 vh ÷ ui-scale 可靠（缩放容器里的 vh 语义容易算歪）。 */
    document.documentElement.style.setProperty('--page-min-h', Math.round(availH) + 'px');

    /* 内容高：主界面用实测的设计高；待办/设置页更高，就按当前实际布局高来算，
       这样切到长列表页面也不会被压扁。 */
    const natural = Math.max(1, view.scrollHeight || view.offsetHeight || 0);
    const designContentH = Math.max(layoutH, natural) * k;

    let s;
    if (UI_SCALE && UI_SCALE.computeContentScale) {
      s = UI_SCALE.computeContentScale(availW, availH, k, designW, designContentH);
    } else {
      s = Math.min(availW / designW, availH / designContentH, 1) * k;
    }
    if (!isFinite(s) || s <= 0) s = 1;
    s = Math.max(0.35, Math.min(MAX_SCALE, s));

    view.style.top = topChrome + 'px';
    view.style.left = Math.max(0, (availW - designW * s) / 2) + 'px';
    view.style.transform = 'scale(' + s + ')';
    /* 设置页合并成一整张卡片后要整体滚动：把「视口在设计空间里有多高」写成 CSS 变量。
       直接写 vh 在缩放容器里会算歪，所以由 JS 按实际缩放比换算。 */
    document.documentElement.style.setProperty('--page-view-h', Math.round(availH / s) + 'px');
    stage.resize();
    alertStage.resize();
  }

  let fitPending = false;
  function requestFit() {
    if (fitPending) return;
    fitPending = true;
    requestAnimationFrame(function () { fitPending = false; fitApp(); });
  }

  /* 换屏 / 改系统缩放：先在本地核对一次 devicePixelRatio（主进程的通知可能还没到），
     再重排。跨屏拖动时 Windows 会先送来 resize，所以这里同时兜住「没收到 IPC」的情况。 */
  let dpiCheckTimer = null;
  function onViewportChanged() {
    uiScale.sync();                 // 只在 devicePixelRatio 真的变了时才改 k
    requestFit();
    /* 有些切屏场景下 resize 送得早、devicePixelRatio 更新得晚，补一次核对 */
    if (dpiCheckTimer) clearTimeout(dpiCheckTimer);
    dpiCheckTimer = setTimeout(function () {
      dpiCheckTimer = null;
      const before = uiScale.get();
      uiScale.sync();
      if (Math.abs(uiScale.get() - before) > 0.001) requestFit();
    }, 150);
  }

  window.addEventListener('resize', onViewportChanged);

  /* ==========================================================================
     备忘 / 待办 / 标签页 / 设置
     --------------------------------------------------------------------------
     · memos：随手记，可勾完成，随时改
     · todos：带「提醒日期 + 时间」，到点弹提醒（复用上面那套提醒弹层）；
       程序没开时错过的，下次打开补提醒一次（可在设置里关掉）
     · 两者都存在 localStorage 的 STORE_KEY.todos 里，一次读写
     ========================================================================== */

  /* ---------------------------------------------------------------- 小工具 */
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function newLocalId(prefix) {
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /* 时间戳 → “8月17日 15:30” / 跨年时带上年份 */
  function fmtTodoTime(ms) {
    if (!ms) return '未设置';
    const d = new Date(ms);
    const now = new Date();
    const p = n => String(n).padStart(2, '0');
    const ymd = (d.getFullYear() === now.getFullYear() ? '' : d.getFullYear() + '年') +
      (d.getMonth() + 1) + '月' + d.getDate() + '日';
    return ymd + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* 距现在多久：用于待办列表里的「还有 2 小时」/「已过期 3 小时」 */
  function fmtFromNow(ms) {
    const diff = ms - Date.now();
    const abs = Math.abs(diff);
    const mins = Math.round(abs / 60000);
    let txt;
    if (mins < 60) txt = mins + ' 分钟';
    else if (mins < 60 * 24) txt = Math.round(mins / 60) + ' 小时';
    else txt = Math.round(mins / 1440) + ' 天';
    return diff >= 0 ? '还有 ' + txt : '已过期 ' + txt;
  }

  const pad2 = n => String(n).padStart(2, '0');
  function localDateValue(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function localTimeValue(d) {
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /* ------------------------------------------------------------ 数据读写 */
  function loadTodoStore() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY.todos) || '{}');
      if (Array.isArray(raw.memos)) {
        memos = raw.memos.filter(m => m && m.text).map(function (m) {
          return {
            id: String(m.id || newLocalId('m')),
            text: String(m.text).slice(0, 500),
            done: !!m.done,
            at: +m.at || Date.now()
          };
        });
      }
      if (Array.isArray(raw.todos)) {
        todos = raw.todos.filter(t => t && t.text).map(function (t) {
          return {
            id: String(t.id || newLocalId('t')),
            text: String(t.text).slice(0, 60),
            done: !!t.done,
            at: +t.at || Date.now(),
            dueAt: +t.dueAt || 0,
            remindAt: +t.remindAt || 0,
            notify: t.notify !== false
          };
        });
      }
    } catch (e) { /* 坏数据就当没有 */ }
  }

  function saveTodoStore() {
    try {
      localStorage.setItem(STORE_KEY.todos, JSON.stringify({ memos: memos, todos: todos }));
    } catch (e) { }
  }

  function loadUiPrefs() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY.ui) || '{}');
      if (typeof raw.todoGrabFront === 'boolean') ui.todoGrabFront = raw.todoGrabFront;
      if (typeof raw.todoCatchUp === 'boolean') ui.todoCatchUp = raw.todoCatchUp;
      if (raw.tab === 'home' || raw.tab === 'todo' || raw.tab === 'settings') ui.tab = raw.tab;
    } catch (e) { }
  }

  function saveUiPrefs() {
    try { localStorage.setItem(STORE_KEY.ui, JSON.stringify(ui)); } catch (e) { }
  }

  function memoById(id) { return memos.filter(m => m.id === id)[0] || null; }
  function todoById(id) { return todos.filter(t => t.id === id)[0] || null; }

  /* 排序：未完成在前；待办再按提醒时间升序（过期的排最前面，最扎眼） */
  function sortedMemos() {
    return memos.slice().sort(function (a, b) {
      if (a.done !== b.done) return a.done ? 1 : -1;
      return b.at - a.at;
    });
  }
  function sortedTodos() {
    return todos.slice().sort(function (a, b) {
      if (a.done !== b.done) return a.done ? 1 : -1;
      return (a.dueAt || Infinity) - (b.dueAt || Infinity);
    });
  }

  /* -------------------------------------------------------------- 渲染 */
  function renderMemos() {
    if (!el.memoList) return;
    const list = sortedMemos();
    el.memoList.innerHTML = '';
    if (!list.length) {
      el.memoList.innerHTML = '<div class="empty-tip">还没有备忘。<br>点右上角「＋ 新增备忘」写第一条吧。</div>';
      return;
    }
    list.forEach(function (m) {
      const row = document.createElement('div');
      row.className = 'memo-item' + (m.done ? ' done' : '');
      row.dataset.id = m.id;
      row.innerHTML =
        '<button class="item-chk" data-role="done" title="标记完成 / 取消"></button>' +
        '<div class="item-body">' +
          '<div class="item-text"></div>' +
          '<div class="item-meta"></div>' +
        '</div>' +
        '<div class="item-tools">' +
          '<button data-role="edit" title="编辑">编辑</button>' +
          '<button data-role="del" class="del" title="删除">删除</button>' +
        '</div>';
      row.querySelector('.item-text').textContent = m.text;
      row.querySelector('.item-meta').textContent = '记于 ' + fmtTodoTime(m.at);
      el.memoList.appendChild(row);
    });
  }

  function renderTodos() {
    if (!el.todoList) return;
    const list = sortedTodos();
    el.todoList.innerHTML = '';
    const pending = list.filter(t => !t.done).length;
    if (el.todoBadge) {
      el.todoBadge.hidden = pending === 0;
      el.todoBadge.textContent = String(pending);
    }
    if (!list.length) {
      el.todoList.innerHTML = '<div class="empty-tip">还没有待办。<br>点右上角「＋ 新增待办」，设好日期和时间就行。</div>';
      return;
    }
    list.forEach(function (t) {
      const late = !t.done && t.dueAt && t.dueAt < Date.now();
      const row = document.createElement('div');
      row.className = 'todo-item' + (t.done ? ' done' : '');
      row.dataset.id = t.id;
      row.innerHTML =
        '<button class="item-chk" data-role="done" title="标记完成 / 取消"></button>' +
        '<div class="item-body">' +
          '<div class="item-text"></div>' +
          '<div class="item-meta"></div>' +
        '</div>' +
        '<div class="item-tools">' +
          '<button data-role="edit" title="编辑">编辑</button>' +
          '<button data-role="del" class="del" title="删除">删除</button>' +
        '</div>';
      row.querySelector('.item-text').textContent = t.text;
      const meta = row.querySelector('.item-meta');
      meta.innerHTML = '⏰ <b></b> <span class="' + (late ? 'late' : '') + '"></span>';
      meta.querySelector('b').textContent = fmtTodoTime(t.dueAt);
      meta.querySelector('span').textContent = t.done ? '（已完成）' : fmtFromNow(t.dueAt);
      el.todoList.appendChild(row);
    });
  }

  /* ------------------------------------------------------------ 备忘弹层 */
  let editingMemoId = null;

  function openMemoModal(id) {
    editingMemoId = id || null;
    const m = id ? memoById(id) : null;
    el.memoTitle.textContent = m ? '修改备忘' : '新增备忘';
    el.memoText.value = m ? m.text : '';
    el.memoOverlay.hidden = false;
    setTimeout(function () { try { el.memoText.focus(); } catch (e) { } }, 50);
  }
  function closeMemoModal() { el.memoOverlay.hidden = true; editingMemoId = null; }

  function saveMemoModal() {
    const text = el.memoText.value.trim();
    if (!text) { try { el.memoText.focus(); } catch (e) { } return; }
    if (editingMemoId) {
      const m = memoById(editingMemoId);
      if (m) m.text = text.slice(0, 500);
    } else {
      memos.unshift({ id: newLocalId('m'), text: text.slice(0, 500), done: false, at: Date.now() });
    }
    saveTodoStore();
    renderMemos();
    closeMemoModal();
    Sound.click();
    requestFit();
  }

  function deleteMemo(id) {
    const m = memoById(id);
    if (!m) return;
    if (!window.confirm('删除这条备忘？\n\n' + m.text)) return;
    memos = memos.filter(x => x.id !== id);
    saveTodoStore();
    renderMemos();
    requestFit();
  }

  /* ------------------------------------------------------------ 待办弹层 */
  let editingTodoId = null;

  function openTodoModal(id) {
    editingTodoId = id || null;
    const t = id ? todoById(id) : null;
    el.tdTitle.textContent = t ? '修改待办' : '新增待办';
    el.tdText.value = t ? t.text : '';
    const due = t && t.dueAt ? new Date(t.dueAt) : (function () {
      const d = new Date(Date.now() + 60 * 60 * 1000);   // 默认「一小时后」
      d.setSeconds(0, 0);
      return d;
    })();
    el.tdDate.value = localDateValue(due);
    el.tdTime.value = localTimeValue(due);
    el.todoOverlay.hidden = false;
    setTimeout(function () { try { el.tdText.focus(); } catch (e) { } }, 50);
  }
  function closeTodoModal() { el.todoOverlay.hidden = true; editingTodoId = null; }

  /* 快捷档位：几分钟后 / 今天 18:00 / 明天 9:00 */
  function applyTodoQuick(btn) {
    const mins = btn.dataset.min;
    const at = btn.dataset.at;
    let d = new Date();
    if (mins) {
      d = new Date(Date.now() + (+mins) * 60000);
    } else if (at === 'today-1800') {
      d.setHours(18, 0, 0, 0);
      if (d.getTime() < Date.now()) d.setTime(Date.now() + 60000);
    } else if (at === 'tomorrow-0900') {
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
    }
    d.setSeconds(0, 0);
    el.tdDate.value = localDateValue(d);
    el.tdTime.value = localTimeValue(d);
  }

  function saveTodoModal() {
    const text = el.tdText.value.trim();
    if (!text) { try { el.tdText.focus(); } catch (e) { } return; }
    const dv = el.tdDate.value, tv = el.tdTime.value || '09:00';
    const parts = dv.split('-');
    if (parts.length !== 3) { try { el.tdDate.focus(); } catch (e) { } return; }
    const hm = tv.split(':');
    const due = new Date(+parts[0], +parts[1] - 1, +parts[2], +hm[0] || 0, +hm[1] || 0, 0, 0);
    const dueAt = due.getTime();
    if (!isFinite(dueAt)) return;

    if (editingTodoId) {
      const t = todoById(editingTodoId);
      if (t) {
        t.text = text.slice(0, 60);
        t.dueAt = dueAt;
        /* 改了时间就把「下次提醒」重置到新时间；已经完成的重新变回未完成 */
        t.remindAt = dueAt;
        if (t.done) { t.done = false; t.doneAt = 0; }
      }
    } else {
      todos.unshift({
        id: newLocalId('t'),
        text: text.slice(0, 60),
        done: false, at: Date.now(),
        dueAt: dueAt,
        remindAt: dueAt,          // 到点就提醒（过期的会在很短时间内被 tick 抓到）
        notify: true
      });
    }
    saveTodoStore();
    renderTodos();
    closeTodoModal();
    Sound.click();
    requestFit();
    const late = dueAt < Date.now();
    setCaption(late ? '待办已保存（时间已过，马上会提醒你）' : '待办已保存，到点会提醒你');
  }

  function deleteTodo(id) {
    const t = todoById(id);
    if (!t) return;
    if (!window.confirm('删除这条待办？\n\n' + t.text)) return;
    todos = todos.filter(x => x.id !== id);
    saveTodoStore();
    renderTodos();
    requestFit();
  }

  function toggleTodoDone(id) {
    const t = todoById(id);
    if (!t) return;
    t.done = !t.done;
    t.doneAt = t.done ? Date.now() : 0;
    if (t.done) t.remindAt = 0;                  // 完成了就别再提醒
    else if (t.dueAt && t.dueAt < Date.now()) t.remindAt = Date.now() + 60000;
    else t.remindAt = t.dueAt;
    saveTodoStore();
    renderTodos();
    Sound.click();
    if (t.done) setCaption('待办已完成：<b>' + escapeHtml(t.text) + '</b>');
  }

  /* -------------------------------------------------------- 待办到点调度 */
  /* 每轮 tick 调一次：到点的弹提醒；程序重开时错过的补一次。
     过期很久的不再打扰（超过 12 小时只标记为过期，不弹），避免半夜开机炸一屏。 */
  const TODO_LATE_GRACE = 12 * 60 * 60 * 1000;

  function checkTodoDue() {
    if (rt.alertId) return;                      // 已有提醒在进行
    const now = Date.now();
    const due = sortedTodos().filter(function (t) {
      return !t.done && t.remindAt && t.remindAt <= now;
    });
    if (!due.length) return;
    const t = due[0];
    const late = !!(t.dueAt && t.dueAt < now - 60000);
    /* 补提醒：只要还没超过宽限期就弹；超了就把提醒位清掉，只在列表里标过期 */
    if (late && (now - t.dueAt) > TODO_LATE_GRACE) {
      t.remindAt = 0;
      saveTodoStore();
      renderTodos();
      return;
    }
    fireTodo(t, late);
  }

  /* 启动时补提醒：程序没开的时候错过的那些（用户可在设置里关掉） */
  function catchUpTodos() {
    if (!ui.todoCatchUp) return;
    const now = Date.now();
    let changed = false;
    todos.forEach(function (t) {
      if (t.done || !t.dueAt) return;
      if (t.dueAt > now) return;                 // 还没到点
      if (!t.remindAt) t.remindAt = t.dueAt;     // 上次因为超期被清掉了，这里恢复一次
      if ((now - t.dueAt) <= TODO_LATE_GRACE) t.remindAt = Math.min(t.remindAt || t.dueAt, now);
      changed = true;
    });
    if (changed) { saveTodoStore(); setTimeout(checkTodoDue, 1200); }
  }

  /* ------------------------------------------------------------ 标签页 */
  const TAB_PAGES = { home: '#app', todo: '#pageTodo', settings: '#pageSettings' };

  function openTab(name) {
    if (!TAB_PAGES[name]) name = 'home';
    ui.tab = name;
    Object.keys(TAB_PAGES).forEach(function (key) {
      const node = $(TAB_PAGES[key]);
      if (node) node.hidden = (key !== name);
    });
    ['home', 'todo', 'settings'].forEach(function (key) {
      const btn = document.getElementById('tab' + key.charAt(0).toUpperCase() + key.slice(1));
      if (btn) btn.classList.toggle('on', key === name);
    });
    if (name !== 'home') { renderMemos(); renderTodos(); }
    saveUiPrefs();
    /* 切页后内容高度变了（待办页更高），重新按当前页排版 */
    requestAnimationFrame(function () { fitApp(); });
  }

  /* ------------------------------------------------------------ 设置项 */
  function bindSettings() {
    if (el.chkAutoLaunch) {
      /* 初始值以主进程为准（注册表才是真源，localStorage 只当缓存） */
      if (native && native.getAutoLaunch) {
        native.getAutoLaunch().then(function (on) {
          el.chkAutoLaunch.checked = !!on;
        }).catch(function () { });
      }
      el.chkAutoLaunch.addEventListener('change', function (e) {
        const want = e.target.checked;
        if (!native || !native.setAutoLaunch) { e.target.checked = false; return; }
        native.setAutoLaunch(want).then(function (real) {
          /* 以主进程实际写入的结果为准回填，避免「显示勾上了其实没写进去」 */
          e.target.checked = !!real;
          setCaption(real ? '已开启开机自动启动（开机后只留托盘，不弹主界面）' : '已关闭开机自动启动');
        }).catch(function () { e.target.checked = !want; });
      });
    }

    if (el.chkAutoLaunchTodo) {
      el.chkAutoLaunchTodo.checked = ui.todoGrabFront;
      el.chkAutoLaunchTodo.addEventListener('change', function (e) {
        ui.todoGrabFront = e.target.checked;
        saveUiPrefs();
      });
    }

    if (el.chkTodoCatchUp) {
      el.chkTodoCatchUp.checked = ui.todoCatchUp;
      el.chkTodoCatchUp.addEventListener('change', function (e) {
        ui.todoCatchUp = e.target.checked;
        saveUiPrefs();
      });
    }

    if (el.btnOpenDataDir && native && native.openDataDir) {
      el.btnOpenDataDir.addEventListener('click', function () { native.openDataDir(); });
    } else if (el.btnOpenDataDir) {
      el.btnOpenDataDir.hidden = true;
    }

    if (el.setAbout) {
      el.setAbout.textContent = '别感冒提醒器 v3.2.5 · 数据全部存在本机，只有「检查更新」会访问 GitHub。';
    }
  }

  /* ------------------------------------------------------------ 软件更新
     主进程负责查/下/装，这里只负责把状态画出来。
     策略是「只提示」：查到新版不会自动下，下完也不会自动装，都要用户点。 */
  const UPD_TEXT = {
    unsupported: { txt: '此版本无更新器', cls: '' },
    idle: { txt: '还没检查过', cls: '' },
    checking: { txt: '正在检查…', cls: '' },
    none: { txt: '已是最新版本', cls: 'ok' },
    available: { txt: '发现新版本', cls: 'warn' },
    downloading: { txt: '正在下载…', cls: 'warn' },
    downloaded: { txt: '已下载完成', cls: 'ok' },
    error: { txt: '检查失败', cls: 'err' }
  };

  const UPD_DEFAULT_DESC = '有新版本时会在这里告诉你，但不会自动下载、更不会自动安装 —— 下载和安装都要你点一下。';

  function renderUpdate(s) {
    if (!s) return;

    if (el.updCur) el.updCur.textContent = 'v' + s.currentVersion;
    if (el.chkUpdAuto) el.chkUpdAuto.checked = !!s.autoCheck;

    const meta = (s.state === 'unsupported' && s.devMode)
      ? { txt: '开发模式', cls: '' }
      : (UPD_TEXT[s.state] || { txt: s.state, cls: '' });
    const withVer = (s.state === 'available' || s.state === 'downloading' || s.state === 'downloaded');
    if (el.updState) {
      el.updState.textContent = meta.txt + (withVer && s.available ? ' v' + s.available : '');
      el.updState.className = 'upd-state' + (meta.cls ? ' ' + meta.cls : '');
    }

    /* 进度条只在下载中 / 下载完成时出现 */
    const showBar = (s.state === 'downloading' || s.state === 'downloaded');
    if (el.updBar) {
      el.updBar.hidden = !showBar;
      if (el.updFill) el.updFill.style.width = (s.state === 'downloaded' ? 100 : (s.percent || 0)) + '%';
    }

    if (el.btnUpdCheck) {
      el.btnUpdCheck.hidden = !s.supported;
      el.btnUpdCheck.disabled = (s.state === 'checking' || s.state === 'downloading');
      el.btnUpdCheck.textContent = (s.state === 'checking') ? '⏳ 检查中…' : '🔍 检查更新';
    }
    if (el.btnUpdDownload) el.btnUpdDownload.hidden = (s.state !== 'available');
    if (el.btnUpdInstall) el.btnUpdInstall.hidden = (s.state !== 'downloaded');

    if (el.updDesc) {
      let d = UPD_DEFAULT_DESC;
      if (!s.supported && s.devMode) {
        d = '这是直接跑源码的开发模式，不检查更新。装成正式版之后这里就能一键更新了。';
      } else if (!s.supported) {
        d = '这个版本没有内置更新器（v3.2.1 之前的版本都是这样），只能去发布页手动下载新的安装包。'
          + '手动装一次 v3.2.1 之后，以后就能在这里一键更新了。';
      } else if (s.state === 'available') {
        d = '新版本 v' + s.available + ' 已经发布。点「下载新版本」开始下载，下好再点「重启并安装」。';
      } else if (s.state === 'downloading') {
        d = '正在后台下载，已经完成 ' + (s.percent || 0) + '%。可以继续用软件，下好了会告诉你。';
      } else if (s.state === 'downloaded') {
        d = '新版本已经下载好了。点「重启并安装」会关掉软件、静默装上新版，装完自动重新打开 —— '
          + '待办、备忘、设置和宠物位置都不会丢。';
      } else if (s.state === 'error') {
        d = '检查更新失败：' + (s.error || '未知错误') + '（不影响正常使用，可以稍后再试）';
      } else if (s.state === 'none') {
        d = '已经是最新的了，不用做任何事。';
      }
      el.updDesc.textContent = d;
    }

    /* Release 里的更新说明。
       注意：electron-updater 从 GitHub 拿回来的 releaseNotes 其实是【渲染后的 HTML】
       （会带 <h2>/<ul>/<li>/<g-emoji> 这些），直接 textContent 出来就是一坨标签，
       所以先转成干净的纯文本再显示。 */
    if (el.updNote) {
      const show = !!s.notes && withVer;
      if (el.updNoteRow) el.updNoteRow.hidden = !show;
      if (show) el.updNote.textContent = notesToText(s.notes);
    }
  }

  /* 更新说明 → 干净纯文本。不渲染 HTML（那是远端内容，不往 DOM 里塞标签），
     只把结构还原成「标题 / 换行 / · 列表」这种能直接读的样子。 */
  function notesToText(raw) {
    if (!raw) return '';
    let s = String(raw);

    if (/<\s*[a-z][^>]*>/i.test(s)) {
      s = s
        /* 软换行：<br> 只是同一段里的折行，绝不能当成分段 */
        .replace(/<br\s*\/?>/gi, '\n')
        /* 列表：每个 li 起一行；闭合标签不产生换行，否则每两条之间会多一个空行 */
        .replace(/<li[^>]*>/gi, '\n· ')
        .replace(/<\/(li|ul|ol)>/gi, '')
        .replace(/<(ul|ol)[^>]*>/gi, '')
        /* 硬分段：标题 / 段落 / 引用块前后各留一个空行 */
        .replace(/<h[1-6][^>]*>/gi, '\n\n')
        .replace(/<\/(p|div|h[1-6]|blockquote|tr|table|section)>/gi, '\n\n')
        .replace(/<(p|blockquote|tr|table|section|div)[^>]*>/gi, '\n\n')
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"').replace(/&#0?39;/gi, "'")
        .replace(/&amp;/gi, '&');
    }

    /* 顺手把 markdown 的记号也去掉（万一哪天改回 markdown 格式） */
    s = s
      .replace(/^\s{0,3}#{1,6}\s*/gm, '')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/^\s{0,3}[-*+]\s+/gm, '· ')
      .replace(/^\s{0,3}>\s?/gm, '')
      .replace(/`([^`]*)`/g, '$1');

    /* 逐行去掉首尾空白，再把「3 个以上连续换行」压成 2 个（也就是最多一个空行） */
    const text = s
      .split('\n')
      .map(function (t) { return t.replace(/^[\s\u3000]+/, '').replace(/[\s\u3000]+$/, ''); })
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\n+/, '')
      .replace(/\n+$/, '');

    /* 统一成编号列表：老版 Release 说明是「小标题 + · 列表」那种写法，
       直接显示显得乱；把列表项编号成 1. 2. 3.，一眼就能看完有几条改动。
       已经自己编好号的（新版 Release 说明就是这么写的）原样保留。 */
    if (/^\s*\d+[.、)]\s/m.test(text)) return text;
    let n = 0;
    return text.split('\n').map(function (l) {
      if (/^·\s+/.test(l)) {
        n += 1;
        return n + '. ' + l.replace(/^·\s+/, '');
      }
      return l;
    }).join('\n');
  }

  function bindUpdate() {
    if (!el.updCur) return;                 // 页面里没这块 UI 就直接跳过

    if (!native || !native.updateGetState) {
      renderUpdate({
        state: 'unsupported', supported: false, currentVersion: '—',
        autoCheck: false, percent: 0, error: '', available: '', notes: ''
      });
      if (el.btnUpdCheck) el.btnUpdCheck.disabled = true;
      if (el.chkUpdAuto) el.chkUpdAuto.disabled = true;
      return;
    }

    if (el.chkUpdAuto) {
      el.chkUpdAuto.addEventListener('change', function (e) {
        const want = e.target.checked;
        native.updateSetAutoCheck(want).then(function (real) {
          e.target.checked = !!real;
          setCaption(real ? '已开启自动检查更新' : '已关闭自动检查更新（仍可手动点「检查更新」）');
        }).catch(function () { e.target.checked = !want; });
      });
    }

    if (el.btnUpdCheck) {
      el.btnUpdCheck.addEventListener('click', function () {
        setCaption('正在检查有没有新版本…');
        native.updateCheck().then(renderUpdate).catch(function () { });
      });
    }

    if (el.btnUpdDownload) {
      el.btnUpdDownload.addEventListener('click', function () {
        el.btnUpdDownload.hidden = true;
        setCaption('开始下载新版本，可以继续用软件');
        native.updateDownload();
      });
    }

    if (el.btnUpdInstall) {
      el.btnUpdInstall.addEventListener('click', function () {
        setCaption('正在安装新版本，软件马上会自己重新打开…');
        native.updateInstall();
      });
    }

    if (native.onUpdateStatus) native.onUpdateStatus(renderUpdate);
    if (native.onUpdateInstalling) native.onUpdateInstalling(function () {
      setCaption('正在安装新版本，软件马上会自己重新打开…');
    });

    /* 首屏主动拉一次：窗口刷新后主进程的 send 是收不到的，只能自己问 */
    native.updateGetState().then(renderUpdate).catch(function () { });
  }

  /* ------------------------------------------------------------ 一键摸鱼
     快捷键由主进程注册（globalShortcut），这里只负责录制和回显。
     录制时用【捕获阶段】监听 + stopPropagation，把按键吃掉，
     免得按 W 触发「立刻喝水」、按空格触发暂停计时。 */
  const MOYU_RESULT = {
    ok: '已生效',
    off: '已关闭',
    empty: '没设置快捷键',
    taken: '被占用了',
    invalid: '不合法'
  };

  let moyuRecording = false;

  function prettyAccel(a) {
    return String(a || '').split('+').join(' + ');
  }

  /* 键盘事件 → Electron 加速键（Ctrl+Alt+M 这种）。不合法返回空串。 */
  function accelFromEvent(e) {
    const k = e.key;
    /* 只按修饰键本身不算，等用户再按一个真键 */
    if (k === 'Control' || k === 'Alt' || k === 'Shift' || k === 'Meta' ||
        k === 'AltGraph' || k === 'CapsLock' || k === 'Dead') return '';

    let key = '';
    if (/^[a-zA-Z]$/.test(k)) key = k.toUpperCase();
    else if (/^[0-9]$/.test(k)) key = k;
    else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(k)) key = k.toUpperCase();
    else {
      const map = {
        ' ': 'Space', 'ArrowUp': 'Up', 'ArrowDown': 'Down', 'ArrowLeft': 'Left', 'ArrowRight': 'Right',
        'Escape': 'Esc', 'Enter': 'Return', 'Tab': 'Tab', 'Backspace': 'Backspace', 'Delete': 'Delete',
        'Insert': 'Insert', 'Home': 'Home', 'End': 'End', 'PageUp': 'PageUp', 'PageDown': 'PageDown',
        'PrintScreen': 'PrintScreen', ',': 'Comma', '.': 'Period', '/': 'Slash', ';': 'Semicolon',
        "'": 'Quote', '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash',
        '-': 'Minus', '=': 'Plus', '`': 'Backquote'
      };
      key = map[k] || '';
    }
    if (!key) return '';

    /* 必须有 Ctrl / Alt / Win，或者干脆用功能键 ——
       否则会抢走正常打字（Shift+A 这种也不算，太容易误触） */
    const strong = e.ctrlKey || e.altKey || e.metaKey;
    const isFn = /^F([1-9]|1[0-9]|2[0-4])$/.test(key);
    if (!strong && !isFn) return '';

    const mods = [];
    if (e.ctrlKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push('Super');
    return mods.concat([key]).join('+');
  }

  function onMoyuKey(e) {
    if (!moyuRecording) return;
    e.preventDefault();
    e.stopPropagation();

    if (e.key === 'Escape') {
      stopMoyuRecord();
      setCaption('已取消录制快捷键');
      return;
    }

    const accel = accelFromEvent(e);
    if (!accel) {
      /* 只按了修饰键，或是不允许的组合：闪一下红边，继续等 */
      if (el.moyuKey) {
        el.moyuKey.classList.add('bad');
        setTimeout(function () { if (el.moyuKey) el.moyuKey.classList.remove('bad'); }, 450);
      }
      return;
    }

    stopMoyuRecord();
    native.moyuSet({ accel: accel }).then(function (st) {
      renderMoyu(st);
      if (st && st.active) setCaption('摸鱼快捷键已设为 ' + prettyAccel(accel));
    }).catch(function () { });
  }

  function stopMoyuRecord() {
    if (!moyuRecording) return;
    moyuRecording = false;
    if (el.moyuKey) el.moyuKey.classList.remove('rec');
    document.removeEventListener('keydown', onMoyuKey, true);
    /* 录制期间主进程把全局热键摘掉了，这里重新注册回去 */
    if (native && native.moyuSuspend) {
      native.moyuSuspend(false).then(renderMoyu).catch(function () { });
    }
  }

  function startMoyuRecord() {
    if (!native || !native.moyuSet || moyuRecording) return;
    moyuRecording = true;
    if (el.moyuKey) {
      el.moyuKey.classList.add('rec');
      el.moyuKey.textContent = '请按组合键…（Esc 取消）';
    }
    /* 先把全局热键摘掉：否则用户按到旧组合，窗口会当场被收走 */
    if (native.moyuSuspend) native.moyuSuspend(true).catch(function () { });
    /* 捕获阶段 + stopPropagation，把按键吃掉，不让它触发页面快捷键 */
    document.addEventListener('keydown', onMoyuKey, true);
  }

  function renderMoyu(st) {
    if (!st) return;
    if (el.chkMoyu) el.chkMoyu.checked = !!st.on;

    if (el.moyuKey && !moyuRecording) {
      el.moyuKey.textContent = st.accel ? prettyAccel(st.accel) : '点这里，然后按组合键';
      el.moyuKey.classList.toggle('bad', !!st.on && !st.active);
    }

    if (el.moyuTarget) {
      if (st.target) {
        el.moyuTarget.textContent = (st.targetIsDoc ? '📄 文档：' : '🖥 程序：') + st.targetName
          + (st.targetIsDoc ? '（打开后会自动最大化）' : '（打开就行，不最大化）');
      } else {
        el.moyuTarget.textContent = '还没选。不选也行 —— 那就只把桌面收干净，不打开任何东西。';
      }
    }
    if (el.moyuClear) el.moyuClear.disabled = !st.target;

    if (el.moyuDesc) {
      let d;
      if (!st.on) {
        d = '一键摸鱼已关闭。勾上「启用一键摸鱼」就能用快捷键了。';
      } else if (!st.active) {
        d = (st.error || '快捷键没注册上') + '（可以点「恢复默认」换成 Ctrl + Alt + M）';
      } else if (st.running) {
        d = '正在摸鱼中：再按一次 ' + prettyAccel(st.accel) + ' 就把刚才收起来的窗口全部还原。';
      } else {
        d = '快捷键 ' + prettyAccel(st.accel) + ' 已生效：按一下收起桌面'
          + (st.target ? '并打开 ' + st.targetName : '') + '，再按一下还原。'
          + (st.autoPicked ? '（默认的 Ctrl + Alt + M 被别的软件占了，自动换成了这个）' : '');
      }
      el.moyuDesc.textContent = d;
      el.moyuDesc.className = 'set-desc' + ((st.on && !st.active) ? ' moyu-err' : '');
    }
  }

  function bindMoyu() {
    if (!el.moyuKey) return;                // 页面里没这块 UI

    if (!native || !native.moyuGet) {
      el.moyuKey.disabled = true;
      el.moyuKey.textContent = '仅桌面版可用';
      [el.chkMoyu, el.moyuReset, el.moyuPick, el.moyuClear].forEach(function (n) {
        if (n) n.disabled = true;
      });
      return;
    }

    if (el.chkMoyu) {
      el.chkMoyu.addEventListener('change', function (e) {
        const want = e.target.checked;
        native.moyuSet({ on: want }).then(function (st) {
          renderMoyu(st);
          setCaption(!want ? '一键摸鱼已关闭'
            : (st && st.active ? '一键摸鱼已开启' : '一键摸鱼已开启，但快捷键没注册上'));
        }).catch(function () { e.target.checked = !want; });
      });
    }

    if (el.moyuKey) el.moyuKey.addEventListener('click', startMoyuRecord);

    if (el.moyuReset) {
      el.moyuReset.addEventListener('click', function () {
        stopMoyuRecord();
        native.moyuReset().then(function (st) {
          renderMoyu(st);
          setCaption('已恢复默认快捷键 ' + prettyAccel(st && st.defaultAccel));
        }).catch(function () { });
      });
    }

    if (el.moyuPick && native.moyuPick) {
      el.moyuPick.addEventListener('click', function () {
        native.moyuPick().then(function (st) {
          renderMoyu(st);
          if (st && st.target) setCaption('伪装目标已设为 ' + st.targetName);
          else setCaption('没有选择文件');
        }).catch(function () { });
      });
    }

    if (el.moyuClear && native.moyuClearTarget) {
      el.moyuClear.addEventListener('click', function () {
        native.moyuClearTarget().then(function (st) {
          renderMoyu(st);
          setCaption('已清除伪装目标，以后按快捷键就只收桌面');
        }).catch(function () { });
      });
    }

    if (native.onMoyuChanged) native.onMoyuChanged(renderMoyu);
    native.moyuGet().then(renderMoyu).catch(function () { });
  }

  /* -------------------------------------------------- 备忘 / 待办 事件绑定 */
  function bindTodoPage() {
    /* 备忘：勾完成 / 改 / 删（事件委托，列表是动态渲染的） */
    if (el.memoList) {
      el.memoList.addEventListener('click', function (e) {
        const row = e.target.closest ? e.target.closest('.memo-item') : null;
        if (!row) return;
        const roleEl = e.target.closest ? e.target.closest('[data-role]') : null;
        const role = roleEl ? roleEl.dataset.role : '';
        const id = row.dataset.id;
        if (role === 'done') {
          const m = memoById(id);
          if (m) { m.done = !m.done; saveTodoStore(); renderMemos(); Sound.click(); }
        } else if (role === 'edit') {
          openMemoModal(id);
        } else if (role === 'del') {
          deleteMemo(id);
        }
      });
    }
    if (el.btnAddMemo) el.btnAddMemo.addEventListener('click', function () { Sound.click(); openMemoModal(null); });
    if (el.memoSave) el.memoSave.addEventListener('click', saveMemoModal);
    if (el.memoCancel) el.memoCancel.addEventListener('click', closeMemoModal);
    if (el.memoClose) el.memoClose.addEventListener('click', closeMemoModal);
    if (el.memoOverlay) el.memoOverlay.addEventListener('click', function (e) {
      if (e.target === el.memoOverlay) closeMemoModal();
    });

    /* 待办：勾完成 / 改 / 删 */
    if (el.todoList) {
      el.todoList.addEventListener('click', function (e) {
        const row = e.target.closest ? e.target.closest('.todo-item') : null;
        if (!row) return;
        const roleEl = e.target.closest ? e.target.closest('[data-role]') : null;
        const role = roleEl ? roleEl.dataset.role : '';
        const id = row.dataset.id;
        if (role === 'done') toggleTodoDone(id);
        else if (role === 'edit') openTodoModal(id);
        else if (role === 'del') deleteTodo(id);
      });
    }
    if (el.btnAddTodo) el.btnAddTodo.addEventListener('click', function () { Sound.click(); openTodoModal(null); });
    if (el.tdSave) el.tdSave.addEventListener('click', saveTodoModal);
    if (el.tdCancel) el.tdCancel.addEventListener('click', closeTodoModal);
    if (el.tdClose) el.tdClose.addEventListener('click', closeTodoModal);
    if (el.todoOverlay) el.todoOverlay.addEventListener('click', function (e) {
      if (e.target === el.todoOverlay) closeTodoModal();
    });
    if (el.tdQuick) {
      el.tdQuick.addEventListener('click', function (e) {
        const b = e.target.closest ? e.target.closest('button') : null;
        if (b) { applyTodoQuick(b); Sound.click(); }
      });
    }
    if (el.tdText) {
      el.tdText.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') saveTodoModal();
      });
    }

    /* 标签栏 */
    if (el.tabbar) {
      el.tabbar.addEventListener('click', function (e) {
        const b = e.target.closest ? e.target.closest('.tab-btn') : null;
        if (!b) return;
        Sound.click();
        openTab(b.dataset.tab);
      });
    }
  }

  /* ---------------------------------------------- 桌面宠物 / 宠物说话对接 */
  function bindDesktopPet() {
    /* 勾选框：主进程才是权威（托盘菜单也能改），这里只做「请求 + 跟随」 */
    if (el.chkDesktopPet) {
      el.chkDesktopPet.addEventListener('change', function (e) {
        const want = e.target.checked;
        Sound.click();
        if (native && native.setPetOn) {
          native.setPetOn(want).then(function (real) {
            e.target.checked = !!real;
            settings.petOn = !!real;
            saveSettings();
            pushState();
          }).catch(function () { e.target.checked = !want; });
        } else {
          e.target.checked = false;
        }
      });
    }
    if (native && native.onPetOnChanged) {
      native.onPetOnChanged(function (on) {
        if (el.chkDesktopPet) el.chkDesktopPet.checked = !!on;
        settings.petOn = !!on;
        saveSettings();
        pushState();
      });
    }

    /* 桌面上的宠物被点了一下：主进程来要「气泡里说什么」，
       这里用现成的时辰 + 下一次提醒文案回过去。 */
    if (native && native.onPetTalkRequest) {
      native.onPetTalkRequest(function () {
        if (!native.petTalkData) return;
        const cur = currentShichen();
        native.petTalkData({
          head: '现在是 ' + cur.name + '（' + cur.label + '）',
          mer: cur.meridian + '当令 · 宜' + cur.tag,
          tip: cur.tip,
          next: nextReminderText()
        });
      });
    }
  }

  /* ================================================================ 十二时辰 */
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

  /* 桌面宠物「说话」已经搬到宠物窗那边（pet.js + 主进程的 pet-talk-data），
     这里只留下供它使用的一句话文案。 */

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
    /* 待办到点检查：跟循环提醒各自独立（待办是「具体某个时刻」，
       不受「暂停计时」「睡眠暂停」影响 —— 约了几点就是几点） */
    if (!rt.alertId) {
      checkTodoDue();
      /* 待办到点时如果正开着列表，顺手刷新一下「还有多久 / 已过期」 */
      if (todoViewOpen()) renderTodos();
    }
    /* 窗口看不见的时候不碰 DOM：倒计时照常算、到点照样弹提醒，
       但没必要每 250ms 去改一堆元素的文本和宽度。 */
    if (animRunning) render();
  }

  function todoViewOpen() {
    return ui.tab === 'todo' && el.pageTodo && !el.pageTodo.hidden;
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

    if (el.tbMin) el.tbMin.addEventListener('click', function () { if (native) native.minimize(); });
    if (el.tbTray) el.tbTray.addEventListener('click', function () { if (native) native.hideToTray(); });
    if (el.tbClose) el.tbClose.addEventListener('click', function () { if (native) native.hideToTray(); });

    if (el.btnTray) {
      el.btnTray.addEventListener('click', function () {
        Sound.click();
        if (native) native.hideToTray();
      });
    }

    /* 手动拖窗：主界面只拖自绘标题栏（桌面宠物是独立窗口，自己在 pet.js 里拖） */
    if (native && native.dragStart) {
      let dragging = false;
      let downX = 0, downY = 0, moved = 0;

      document.addEventListener('pointerdown', function (e) {
        if (e.button !== 0) return;
        const t = e.target;
        const onButton = t && t.closest && t.closest('.pb-close, .tb-btn, .btn, .mini, .icon-btn, button, input, label, .sc-row, .tab-btn, select');
        const inTitlebar = t && t.closest && t.closest('.titlebar');
        if (!inTitlebar || onButton) return;

        dragging = true;
        moved = 0;
        downX = e.screenX; downY = e.screenY;
        try { document.body.setPointerCapture(e.pointerId); } catch (err) { }

        native.dragStart({ x: downX, y: downY });
        e.preventDefault();
      });

      document.addEventListener('pointermove', function (e) {
        if (!dragging) return;
        moved = Math.max(moved, Math.abs(e.screenX - downX) + Math.abs(e.screenY - downY));
        if (moved > 6) native.dragMove({ x: e.screenX, y: e.screenY });
      });

      const stopDrag = function (e) {
        if (!dragging) return;
        dragging = false;
        try { document.body.releasePointerCapture(e.pointerId); } catch (err) { }
        native.dragEnd();
      };
      document.addEventListener('pointerup', stopDrag);
      document.addEventListener('pointercancel', stopDrag);
    }

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
      /* 音效播放器在 pet-draw.js 里（桌面宠物窗共用），开关要同步过去 */
      PETDRAW.setSoundOn(settings.sound);
      if (native && native.setSound) native.setSound(settings.sound);
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
        SKINPICK.loadSkin(settings.skin);
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
    if (native && native.onWinVisible) native.onWinVisible(applyVisibility);
    /* 右键菜单 / 托盘菜单里换形象 */
    if (native && native.onSetSkin) {
      native.onSetSkin(function (id) {
        settings.skin = id || '__default';
        saveSettings();
        if (el.skinSel) el.skinSel.value = settings.skin;
        SKINPICK.loadSkin(settings.skin);
      });
    }
    /* 托盘 / 桌面宠物右键菜单里的入口 */
    if (native && native.onShowTodo) native.onShowTodo(function () { showWindowSelf(); openTab('todo'); });
    if (native && native.onShowSettings) native.onShowSettings(function () { showWindowSelf(); openTab('settings'); });
    /* 屏幕缩放变化（换屏 / 改系统缩放）：主进程已经把窗口尺寸改好了，
       这里只需要按新的 k 重排内容 */
    uiScale.attach(function () { fitApp(); });
    document.addEventListener('visibilitychange', function () {
      applyVisibility(!document.hidden);
    });

    /* 备忘 / 待办 / 设置 / 桌面宠物 / 软件更新（更新只挂设置页，主界面与待办页不动） */
    bindTodoPage();
    bindSettings();
    bindDesktopPet();
    bindUpdate();
    bindMoyu();
  }

  /* ---------------------------------------------------------- 启动 */
  function init() {
    loadStore();
    loadTodoStore();
    loadUiPrefs();
    el.chkSound.checked = settings.sound;
    el.chkSpeech.checked = settings.speech;
    settings.items.forEach(function (it) { ensureTimer(it); });
    if ('Notification' in window && Notification.permission === 'granted') el.chkNotify.checked = true;
    if (native && el.btnTray) el.btnTray.hidden = false;
    if (native && el.petSizeRow) el.petSizeRow.hidden = false;
    if (native && el.desktopPetRow) el.desktopPetRow.hidden = false;
    if (el.chkDesktopPet) el.chkDesktopPet.checked = !!settings.petOn;
    updatePetSizeUI();
    if (native && native.setPetSize) native.setPetSize(settings.petSize);

    /* 皮肤：列出可选形象，并载入上次选的那个 */
    initSkin();

    bindAll();
    renderPanels();
    renderMemos();
    renderTodos();
    openTab(ui.tab);          // 恢复上次看的页面（默认主界面）
    pushState();
    render();
    /* 先按当前（本地推算的）缩放排一次，避免出现「第一帧字很小」的闪动 */
    uiScale.sync();
    fitApp();
    /* 再向主进程要权威的缩放/基准缩放：拿到后重排一次 */
    if (native && native.getUiScale) {
      native.getUiScale().then(function (info) {
        uiScale.set(info);
        fitApp();
      }).catch(function () { });
    }
    setTimeout(fitApp, 60);
    setTimeout(capPanelList, 140);   // 等字体和布局稳定后再量一次

    last = Date.now();
    setTickRate(250);
    startAnim();
    renderAlmanac();
    setCaption('待机中 · 到点会提醒你');
    applyVisibility(!document.hidden);   // 启动时按当前可见性定档
    /* 程序没开的时候错过的待办，这里补提醒一次 */
    catchUpTodos();
    /* 桌面宠物状态以主进程为准（它可能被托盘菜单改过） */
    if (native && native.getPetOn) {
      native.getPetOn().then(function (on) {
        if (el.chkDesktopPet) el.chkDesktopPet.checked = !!on;
        settings.petOn = !!on;
      }).catch(function () { });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();