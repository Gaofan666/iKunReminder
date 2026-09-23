/* =========================================================================
   桌面待办日历窗的逻辑
   -------------------------------------------------------------------------
   数据从主进程来（主进程缓存主界面推过来的待办 + 备忘录），本页只负责画：
     · 左栏：备忘录（点一条 = 勾/取消完成，改的是同一份数据）
     · 右栏：月历网格，周一开头，固定 6 行 × 7 列 = 42 格，含上/下月补位
     · 每格：日期 + 农历（ICU 的中国农历，不用自己塞数据表）+ 当天的待办条
     · 待办条按优先级上色（高红 / 中橙 / 低蓝），超过 4 条就 3 条 + 「+N」
     · 点格子 → 当天清单，可勾完成（走主进程回主界面改数据，再推回来）
   窗口尺寸与位置全由主进程管，本页不碰窗口（只报「拖到哪了」）。
   ========================================================================= */
(function () {
  'use strict';

  const bridge = window.kunkunCalWindow || {};
  const $ = function (s) { return document.querySelector(s); };
  const el = {
    cal: $('#cal'), title: $('#title'), week: $('#week'), grid: $('#grid'),
    legendRight: $('#legendRight'), memoList: $('#memoList'), memoCount: $('#memoCount'),
    panel: $('#panel'), panelTitle: $('#panelTitle'), panelList: $('#panelList'),
    btnPrev: $('#btnPrev'), btnNext: $('#btnNext'), btnToday: $('#btnToday'),
    btnTheme: $('#btnTheme'), btnLock: $('#btnLock'),
    zoomVal: $('#zoomVal'), btnZoomIn: $('#btnZoomIn'), btnZoomOut: $('#btnZoomOut'),
    btnAdd: $('#btnAdd'), btnSet: $('#btnSet'), btnHide: $('#btnHide'),
    btnAddMemo: $('#btnAddMemo'), memoNewRow: $('#memoNewRow'),
    memoNew: $('#memoNew'), memoNewOk: $('#memoNewOk'),
    panelClose: $('#panelClose')
  };

  const DESIGN_W = 940, DESIGN_H = 610;
  const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日'];
  /* 格子里最多画几条（超过就 2 条 + 「+N 条」）。
     卡片压扁到 610 高之后，一行日期 + 3 条会顶到格子边，所以跟着降到 2。 */
  const MAX_BARS = 2;

  let todos = [];                          // [{id,text,done,dueAt,prio}]
  let memos = [];                          // [{id,text,done,at}]
  let cur = null;                          // 当前显示的月份 { y, m }（m: 0-11）
  let selected = null;                     // 当前打开清单的那天（yyyy-mm-dd）
  let pendingDelete = null;                // 正在二次确认删除的那条待办 id
  let todayKey = '';
  let calLocked = false;                   // 固定状态：锁住后不拖窗、不点开某天

  /* ------------------------------------------------------------ 日期小工具 */
  function pad2(n) { return n < 10 ? '0' + n : String(n); }
  function keyOfDate(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function keyOfTs(ms) { return keyOfDate(new Date(ms)); }
  function fmtTime(ms) {
    const d = new Date(ms);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  /* 周一 = 0，周日 = 6（中文日历习惯周一开头） */
  function mondayIndex(d) { return (d.getDay() + 6) % 7; }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ------------------------------------------------------------ 农历
     用 Chromium 自带的 ICU 中国农历：格式化成中文月名 + 阿拉伯数字日，
     再把 1~30 换成「初一/十二/廿九/三十」。闰月 ICU 会自带「闰」字。
     个别精简运行时不带这个日历，那就干脆不显示农历（不影响其它功能）。 */
  const LUNAR_DAY = ['', '初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九',
    '初十', '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九',
    '二十', '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十'];
  const lunarFmt = (function () {
    try {
      const f = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { month: 'long', day: 'numeric' });
      /* 验一下真的能用（有的运行时会静默退回公历） */
      const probe = f.formatToParts(new Date(2026, 1, 17));   // 2026 年春节 = 正月初一
      const ok = probe.some(function (p) { return p.type === 'month' && p.value.indexOf('月') >= 0; }) &&
        probe.some(function (p) { return p.type === 'day'; });
      return ok ? f : null;
    } catch (e) { return null; }
  })();

  function lunarOf(d) {
    if (!lunarFmt) return null;
    try {
      const parts = lunarFmt.formatToParts(d);
      let mon = '', day = 0;
      parts.forEach(function (p) {
        if (p.type === 'month') mon = p.value;
        else if (p.type === 'day') day = parseInt(p.value, 10) || 0;
      });
      if (!day) return null;
      return {
        month: mon,                 // 「八月」/「闰四月」
        day: day,                   // 1~30
        /* 初一显示月名（一眼看出换月了），其余显示日名 */
        text: day === 1 ? mon : (LUNAR_DAY[day] || String(day))
      };
    } catch (e) { return null; }
  }

  /* ------------------------------------------------------------ 当天待办
     按优先级（高在前）再按时间排 */
  function prioRank(p) {
    if (p === 'high') return 0;
    if (p === 'low') return 2;
    return 1;
  }
  function prioClass(p) {
    return p === 'high' ? 'p-high' : (p === 'low' ? 'p-low' : 'p-mid');
  }
  function prioText(p) {
    return p === 'high' ? '高' : (p === 'low' ? '低' : '中');
  }
  function eventsOf(key) {
    return todos.filter(function (t) { return t && t.dueAt && keyOfTs(t.dueAt) === key; })
      .sort(function (a, b) {
        const ra = prioRank(a.prio), rb = prioRank(b.prio);
        if (ra !== rb) return ra - rb;
        return a.dueAt - b.dueAt;
      });
  }

  /* ------------------------------------------------------------ 左栏：备忘录 */
  function renderMemos() {
    const list = memos.slice().sort(function (a, b) {
      if (a.done !== b.done) return a.done ? 1 : -1;
      return (b.at || 0) - (a.at || 0);
    });
    const undone = list.filter(function (m) { return !m.done; }).length;
    el.memoCount.textContent = list.length ? (undone + ' / ' + list.length) : '';
    if (!list.length) {
      el.memoList.innerHTML = '<div class="memo-empty">还没有备忘。<br>' +
        '在主界面「待办」页左边新增，这里会同步显示。</div>';
      return;
    }
    el.memoList.innerHTML = list.map(function (m) {
      const d = m.at ? new Date(m.at) : null;
      const when = d ? (d.getMonth() + 1) + '月' + d.getDate() + '日' : '';
      return '<div class="memo' + (m.done ? ' done' : '') + '" data-id="' + esc(m.id) + '" ' +
        'title="' + esc(m.done ? '点一下取消完成' : '点一下标记完成') + '">' +
        '<i class="bullet"></i><div class="txt">' + esc(m.text) +
        (when ? '<div class="when">记于 ' + when + '</div>' : '') + '</div></div>';
    }).join('');
  }

  /* ------------------------------------------------------------ 右栏：月历 */
  function renderHead() {
    el.title.innerHTML = cur.y + '年 <b>' + (cur.m + 1) + ' 月</b>';
    const thisMonth = todos.filter(function (t) {
      const d = new Date(t.dueAt);
      return !t.done && d.getFullYear() === cur.y && d.getMonth() === cur.m;
    }).length;
    el.legendRight.textContent = '本月 ' + thisMonth + ' 条未完成';
  }

  function renderWeek() {
    el.week.innerHTML = WEEK_LABELS.map(function (w, i) {
      return '<span' + (i >= 5 ? ' class="we"' : '') + '>' + w + '</span>';
    }).join('');
  }

  function renderGrid() {
    const first = new Date(cur.y, cur.m, 1);
    const start = new Date(cur.y, cur.m, 1 - mondayIndex(first));
    const frag = document.createDocumentFragment();
    for (let i = 0; i < 42; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const key = keyOfDate(d);
      const out = d.getMonth() !== cur.m;
      const cell = document.createElement('div');
      cell.className = 'cell' + (out ? ' out' : '') +
        (key === todayKey ? ' today' : '') + (key === selected ? ' sel' : '');
      cell.dataset.key = key;

      const head = document.createElement('div');
      head.className = 'd';
      const num = document.createElement('span');
      num.textContent = String(d.getDate());
      head.appendChild(num);
      const lu = lunarOf(d);
      if (lu) {
        const l = document.createElement('span');
        l.className = 'lunar';
        l.textContent = lu.text;
        head.appendChild(l);
      }
      cell.appendChild(head);

      const evs = eventsOf(key);
      let show = evs, more = 0;
      if (evs.length > MAX_BARS) {
        show = evs.slice(0, MAX_BARS - 1);
        more = evs.length - show.length;
      }
      show.forEach(function (t) {
        const bar = document.createElement('div');
        bar.className = 'ev ' + prioClass(t.prio) + (t.done ? ' done' : '');
        bar.title = fmtTime(t.dueAt) + ' · ' + prioText(t.prio) + '优先级 · ' + t.text +
          (t.repeatText ? '（' + t.repeatText + '）' : '');
        const span = document.createElement('span');
        span.className = 't';
        /* 重复待办前面挂个 🔁，一眼看出它每期都会来 */
        span.textContent = (t.repeatText ? '🔁 ' : '') + t.text;
        bar.appendChild(span);
        cell.appendChild(bar);
      });
      if (more > 0) {
        const m2 = document.createElement('div');
        m2.className = 'more';
        m2.textContent = '+' + more + ' 条';
        cell.appendChild(m2);
      }
      frag.appendChild(cell);
    }
    el.grid.innerHTML = '';
    el.grid.appendChild(frag);
  }

  function render() {
    if (!cur) return;
    renderHead();
    renderGrid();
    if (selected) renderPanel();
  }

  /* -------------------------------------------------------- 当天清单面板 */
  function renderPanel() {
    const parts = selected.split('-');
    const d = new Date(+parts[0], +parts[1] - 1, +parts[2]);
    const evs = eventsOf(selected);
    const wk = '日一二三四五六'[d.getDay()];
    const lu = lunarOf(d);
    const undone = evs.filter(function (t) { return !t.done; }).length;
    el.panelTitle.textContent = (+parts[1]) + '月' + (+parts[2]) + '日 周' + wk +
      (lu ? ' · 农历' + lu.month + lu.text : '') +
      ' · ' + evs.length + ' 条' + (evs.length ? '（未完成 ' + undone + '）' : '');

    if (!evs.length) {
      el.panelList.innerHTML = '<div class="panel-empty">这天还没有待办。<br>' +
        '点右上角「＋」新增一条，设成这天就行。</div>';
    } else {
      el.panelList.innerHTML = evs.map(function (t) {
        /* 正在确认删除的那条：整行换成确认条，避免弹系统对话框打断操作 */
        if (t.id === pendingDelete) {
          return '<div class="pi confirming" data-id="' + esc(t.id) + '">' +
            '<div class="confirm-txt">删除「' + esc(t.text) + '」？' +
            (t.repeatText ? '<br><span class="warn">这是重复待办（' + esc(t.repeatText) + '），整个周期都会删掉。</span>' : '') +
            '</div>' +
            '<button class="act danger" data-act="ok">删除</button>' +
            '<button class="act" data-act="cancel">取消</button></div>';
        }
        return '<div class="pi' + (t.done ? ' done' : '') + '" data-id="' + esc(t.id) + '">' +
          '<div class="box"></div>' +
          '<div class="body">' +
          '<div class="txt">' + esc(t.text) + '</div>' +
          '<div class="meta"><i class="dot ' + prioClass(t.prio) + '"></i>' +
          '<span>' + prioText(t.prio) + '优先级</span><span>' + fmtTime(t.dueAt) + '</span>' +
          (t.repeatText ? '<span>🔁 ' + esc(t.repeatText) + '</span>' : '') +
          (t.done ? '<span>已完成</span>' : '') + '</div>' +
          '</div>' +
          /* 编辑走主界面那个「修改待办」弹窗（日期/时间/优先级都在那儿），
             删除就在这儿就地确认，不弹系统对话框 */
          '<div class="acts">' +
          '<button class="act" data-act="edit" title="编辑（打开主界面的修改窗口）">✏️</button>' +
          '<button class="act" data-act="del" title="删除这条待办">🗑</button>' +
          '</div></div>';
      }).join('');
    }
    el.panel.hidden = false;
  }

  function closePanel() {
    selected = null;
    pendingDelete = null;
    el.panel.hidden = true;
    const sel = el.grid.querySelector('.cell.sel');
    if (sel) sel.classList.remove('sel');
  }

  /* ---------------------------------------------------------- 翻月 / 本月 */
  function shiftMonth(delta) {
    const d = new Date(cur.y, cur.m + delta, 1);
    cur = { y: d.getFullYear(), m: d.getMonth() };
    closePanel();
    render();
  }
  /* 回本月（「今天」按钮）。原来删过一次，用户说其实有用，又要回来了。 */
  function gotoToday() {
    const d = new Date();
    cur = { y: d.getFullYear(), m: d.getMonth() };
    todayKey = keyOfDate(d);
    closePanel();
    render();
  }

  /* ------------------------------------------------------------ 主题 / 不透明度
     两样都由主界面设置页持有（localStorage），主进程转发过来。
     不透明度作用在【整张卡片】上（CSS 的 opacity）：网格、色条、文字一起淡，
     只给底色加 alpha 的话，带待办的那几格会仍然是实心的，看着很割裂。 */
  let styleState = { theme: 'light', opacity: 97, scale: 1, locked: false };
  function applyStyle(st) {
    if (st && typeof st === 'object') {
      styleState = {
        theme: st.theme === 'dark' ? 'dark' : 'light',
        opacity: Math.min(100, Math.max(30, Number(st.opacity) || 97)),
        scale: Math.min(1.5, Math.max(0.8, Number(st.scale) || 1)),
        /* 用户点的那一档：屏幕装不下时 scale 会被压小，但按钮该按「到没到头」变灰 */
        scaleWant: Math.min(1.5, Math.max(0.8, Number(st.scaleWant || st.scale) || 1)),
        locked: !!st.locked
      };
    }
    const dark = styleState.theme === 'dark';
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    document.documentElement.style.setProperty('--opa', String(styleState.opacity / 100));
    if (el.btnTheme) {
      el.btnTheme.textContent = dark ? '☀' : '🌙';
      el.btnTheme.title = dark ? '切换到浅色主题' : '切换到深色主题';
    }
    /* 缩放：百分比按【实际生效】的缩放显示（屏幕装不下时主进程会往回收），
       按钮到没到头按【点的那一档】判断 */
    if (el.zoomVal) el.zoomVal.textContent = Math.round(styleState.scale * 100) + '%';
    if (el.btnZoomOut) el.btnZoomOut.disabled = styleState.scaleWant <= 0.801;
    if (el.btnZoomIn) el.btnZoomIn.disabled = styleState.scaleWant >= 1.499;
    /* 固定：锁住之后不拖窗、不点开某天 */
    calLocked = styleState.locked;
    document.body.classList.toggle('locked', calLocked);
    if (el.btnLock) {
      el.btnLock.textContent = calLocked ? '🔒' : '🔓';
      el.btnLock.classList.toggle('on', calLocked);
      el.btnLock.title = calLocked
        ? '已固定：不能拖动、也点不开某天（点一下解锁）'
        : '固定日历（锁住后不能拖动、也不能点开某天）';
    }
    if (calLocked && selected) { selected = null; renderGrid(); renderPanel(); }
  }

  /* ------------------------------------------------------------ 新增备忘
     ＋ 展开一条输入行；回车/✓ 存一条并清空输入框（方便连着写几条）。
     真数据在主界面那边，这里只把文字发过去，存完它会推回来。 */
  function openMemoNew() {
    el.memoNewRow.hidden = false;
    try { el.memoNew.focus(); } catch (e) { }
  }
  function closeMemoNew() {
    el.memoNewRow.hidden = true;
    el.memoNew.value = '';
  }
  function submitMemoNew() {
    const t = String(el.memoNew.value || '').trim();
    if (!t) { closeMemoNew(); return; }
    if (bridge.addMemo) bridge.addMemo(t);
    el.memoNew.value = '';
    try { el.memoNew.focus(); } catch (e) { }
  }

  /* ------------------------------------------------------------ 拖动窗口
     整张卡片都能拖：按下先记拖动基准，位移超过 6px 才算真拖动；
     没超过就当成点击（格子 → 当天清单，备忘录条目 → 勾完成）。
     按钮和面板不参与拖动。 */
  const MIN_MOVE = 6;
  let dragging = false, isDrag = false, moved = 0, downPt = null, downTarget = null;

  el.cal.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    if (e.target.closest && e.target.closest('button, input, .panel')) return;
    /* 固定状态：不拖窗、也不点开某天（免得手一滑就把日历挪走 / 弹出一堆格子）。
       备忘录那条勾选是明确操作，留着还能用。 */
    if (calLocked) {
      const t = e.target.closest ? e.target.closest('.memo') : null;
      if (t && t.dataset.id && bridge.toggleMemo) bridge.toggleMemo(t.dataset.id);
      return;
    }
    dragging = true; isDrag = false; moved = 0;
    downPt = { x: e.screenX, y: e.screenY };
    downTarget = e.target.closest ? e.target.closest('.cell, .memo') : null;
    try { el.cal.setPointerCapture(e.pointerId); } catch (err) { }
    document.body.classList.add('dragging');
    bridge.dragStart({ x: downPt.x, y: downPt.y });
    e.preventDefault();
  });

  el.cal.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    moved = Math.max(moved, Math.abs(e.screenX - downPt.x) + Math.abs(e.screenY - downPt.y));
    if (moved > MIN_MOVE) {
      isDrag = true;
      downTarget = null;               // 已经在拖了，松手不算点击
      bridge.dragMove({ x: e.screenX, y: e.screenY });
    }
  });

  function endDrag() {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('dragging');
    bridge.dragEnd();
    if (!isDrag && downTarget) {
      if (downTarget.classList.contains('cell') && downTarget.dataset.key) {
        selected = downTarget.dataset.key;
        renderGrid();
        renderPanel();
      } else if (downTarget.classList.contains('memo') && downTarget.dataset.id) {
        if (bridge.toggleMemo) bridge.toggleMemo(downTarget.dataset.id);
      }
    }
    downTarget = null;
  }
  el.cal.addEventListener('pointerup', endDrag);
  el.cal.addEventListener('pointercancel', endDrag);

  /* 右键 → 原生菜单（翻月 / 回今天 / 打开主界面 / 隐藏） */
  el.cal.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    if (bridge.menu) bridge.menu();
  });

  /* 点当天清单里的条目：
       · 点「✏️」→ 打开主界面的修改弹窗
       · 点「🗑」→ 就地变成「确定删除？」再确认一次
       · 点其它地方 → 勾选/取消完成（数据在主界面那边，改完会推回来） */
  el.panelList.addEventListener('click', function (e) {
    const row = e.target.closest ? e.target.closest('.pi') : null;
    if (!row || !row.dataset.id) return;
    const id = row.dataset.id;
    const btn = e.target.closest ? e.target.closest('button[data-act]') : null;
    if (btn) {
      const act = btn.dataset.act;
      if (act === 'edit') {
        if (bridge.editTodo) bridge.editTodo(id);
      } else if (act === 'del') {
        pendingDelete = id;
        renderPanel();
      } else if (act === 'ok') {
        pendingDelete = null;
        if (bridge.deleteTodo) bridge.deleteTodo(id);
      } else if (act === 'cancel') {
        pendingDelete = null;
        renderPanel();
      }
      return;
    }
    if (pendingDelete === id) return;      // 确认条上的其它地方不算「勾完成」
    if (bridge.toggleTodo) bridge.toggleTodo(id);
  });

  el.btnPrev.addEventListener('click', function () { shiftMonth(-1); });
  el.btnNext.addEventListener('click', function () { shiftMonth(1); });
  el.btnToday.addEventListener('click', gotoToday);
  el.btnTheme.addEventListener('click', function () { if (bridge.toggleTheme) bridge.toggleTheme(); });
  if (el.btnZoomIn) el.btnZoomIn.addEventListener('click', function () { if (bridge.zoom) bridge.zoom(1); });
  if (el.btnZoomOut) el.btnZoomOut.addEventListener('click', function () { if (bridge.zoom) bridge.zoom(-1); });
  if (el.btnLock) el.btnLock.addEventListener('click', function () { if (bridge.toggleLock) bridge.toggleLock(); });
  el.btnAdd.addEventListener('click', function () { if (bridge.addTodo) bridge.addTodo(); });
  el.btnSet.addEventListener('click', function () { if (bridge.openSettings) bridge.openSettings(); });
  el.btnHide.addEventListener('click', function () { if (bridge.hide) bridge.hide(); });

  /* 固定之后，头部那一排按钮（翻月 / 今天 / 缩放 / 主题 / ＋ / ⚙ / ✕）全都不响应。
     用捕获阶段统一拦下来最省事，省得每个监听里都塞一遍判断。
     ⚠️ 只放行 🔒 自己：不然锁上就解不开了。
     左侧备忘录不在头部里，所以「＋ 加一条」照常能用。 */
  const head = document.querySelector('.head');
  if (head) {
    head.addEventListener('click', function (e) {
      if (!calLocked) return;
      if (e.target.closest && e.target.closest('#btnLock')) return;
      e.stopPropagation();
      e.preventDefault();
    }, true);
  }
  el.panelClose.addEventListener('click', closePanel);
  el.panel.addEventListener('click', function (e) {
    if (e.target === el.panel || e.target === el.panelList) closePanel();
  });

  /* 新增备忘 */
  el.btnAddMemo.addEventListener('click', function () {
    if (el.memoNewRow.hidden) openMemoNew(); else closeMemoNew();
  });
  el.memoNewOk.addEventListener('click', submitMemoNew);
  el.memoNew.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); submitMemoNew(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeMemoNew(); }
  });

  document.addEventListener('keydown', function (e) {
    if (e.target && e.target.tagName === 'INPUT') return;      // 正在写备忘，别抢键
    if (e.key === 'Escape') closePanel();
    else if (e.key === 'ArrowLeft') shiftMonth(-1);
    else if (e.key === 'ArrowRight') shiftMonth(1);
  });

  /* ------------------------------------------------------------ 主进程 → 这里 */
  if (bridge.onTodos) {
    bridge.onTodos(function (list) {
      todos = Array.isArray(list) ? list : [];
      render();
    });
  }
  if (bridge.onMemos) {
    bridge.onMemos(function (list) {
      memos = Array.isArray(list) ? list : [];
      renderMemos();
    });
  }
  if (bridge.onNav) {
    bridge.onNav(function (dir) {
      if (dir === 'prev') shiftMonth(-1);
      else if (dir === 'next') shiftMonth(1);
      else gotoToday();
    });
  }
  if (bridge.onStyle) {
    bridge.onStyle(function (st) { applyStyle(st); });
  }
  /* 窗口实际尺寸：装得下就 1:1，装不下（小屏）整体等比缩一点 */
  if (bridge.onFit) {
    bridge.onFit(function (box) {
      if (!box || !box.width || !box.height) return;
      /* ⚠️ 容差 4px：主进程报的是窗口外框，和设计尺寸常常差几个像素（Windows 取整）。
         不留容差的话 941×680 会被算成 1.001 没缩、940×679 却算成 0.998 缩一丁点 ——
         卡片一缩小、四周就空出一条缝，拖到屏幕角上看着就是「贴不到边」（朋友报过）。 */
      const sw = (box.width + 4) / DESIGN_W, sh = (box.height + 4) / DESIGN_H;
      const s = Math.min(sw, sh, 1);
      document.documentElement.style.setProperty('--fit', String(Math.max(0.5, s)));
    });
  }

  /* ------------------------------------------------------------ 启动 */
  const now = new Date();
  todayKey = keyOfDate(now);
  cur = { y: now.getFullYear(), m: now.getMonth() };
  applyStyle(null);            // 先把主题属性写上（拿到主进程的值后会再刷一次）
  renderWeek();
  render();
  renderMemos();
  if (bridge.ready) bridge.ready();
})();
