/* =========================================================================
   论文投稿时间与状态监控（「🔬 科研动态」页的第二块）—— 第六版

   模型（按用户确认的规格）：
   · 一条记录 = 一篇论文：只有一个**标题** + 一串**状态条目**。
   · 每条条目 = { 类型, 日期, 详细信息 }；**添加时只选类型**，日期和各字段都在
     右侧「详细信息」里填 —— 点哪条就弹哪条的详情，字段随类型不同：
       准备中   拟投稿期刊/会议、级别、ddl、备注
       已投稿   作者、我的角色、期刊/会议+类型、级别、链接、备注（不重复标题、不要 DOI）
       审稿中   日期（= 从这天起在审）
       收到意见 意见类型、收到日期、返修截止、提交返修稿、备注
       接收     校稿时间、发表/见刊时间、检索时间、DOI、备注
       检索     DOI、备注
       撤稿/其他 日期、备注
   · 「已投稿」的详细信息会**继承前面「准备中」填过的期刊/级别**（可改）。
   · 列表上显示的期刊/级别/角色，取"最近一条填过这些的条目"推出来。
   · **当前状态**同样不手填：最新一条带状态的条目推出来。
   · 每条记录还有一个「完整时间线」按钮：弹窗里一眼看完全过程。
   · 数据存本机 localStorage 的 kunkun.papers.v1。
   ========================================================================= */
(function () {
  'use strict';

  var STORE_KEY = 'kunkun.papers.v1';

  var EVENTS = [
    { id: 'preparing', name: '准备中', color: '#8A9AA5', state: 'preparing' },
    { id: 'submitted', name: '已投稿', color: '#4A9BD4', state: 'submitted' },
    { id: 'editorReview', name: '编辑初审', color: '#88A9C9', state: 'editorReview' },
    { id: 'review', name: '审稿中', color: '#7FA8D9', state: 'review' },
    { id: 'awaitingDecision', name: '等待编辑决定', color: '#8FB3E0', state: 'awaitingDecision' },
    { id: 'opinion', name: '收到意见', color: '#E8B843', state: null, opinion: true },
    { id: 'reject', name: '拒稿', color: '#D9534F', state: 'rejected', final: true },
    { id: 'accept', name: '接收', color: '#3F9E6E', state: 'accepted', final: true },
    { id: 'index', name: '检索', color: '#4FB3A8', state: null },
    { id: 'withdraw', name: '撤稿', color: '#9B8EA8', state: 'withdrawn', final: true },
    { id: 'other', name: '其他进展', color: '#8A9AA5', state: null }
  ];
  /* 意见类型里**没有「接收」** —— 接收是独立的状态条目（有自己的校稿/见刊/检索/DOI），
     放在这里既重复又自相矛盾（"接收"还要填返修截止，不合理）。 */
  var KINDS = [
    { id: 'major', name: '大修', state: 'major' },
    { id: 'minor', name: '小修', state: 'minor' },
    { id: 'resubOther', name: '重投', state: 'submitted' }
  ];
  var ROLES = { first: '一作', cofirst: '共同一作', corresponding: '通讯作者', second: '二作', other: '其他参与' };
  var OPEN_STATES = { preparing: 1, submitted: 1, editorReview: 1, review: 1, awaitingDecision: 1, major: 1, minor: 1 };

  var papers = [];
  var editingId = null;
  var filter = 'open';
  var openedId = null;
  var addType = 'preparing';
  var detailFor = null;      // { pid, eid, isNew }

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function newId(pfx) { return (pfx || 'pp') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function evOf(id) {
    for (var i = 0; i < EVENTS.length; i++) if (EVENTS[i].id === id) return EVENTS[i];
    return EVENTS[EVENTS.length - 1];
  }
  function kindOf(id) {
    for (var i = 0; i < KINDS.length; i++) if (KINDS[i].id === id) return KINDS[i];
    return null;
  }
  function D(e) { return (e && e.d) || {}; }
  function evName(e) {
    var d = evOf(e.type);
    if (d.opinion) { var k = kindOf(D(e).kind); return '收到意见' + (k ? '：' + k.name : ''); }
    if (e.type === 'other' && D(e).label) return String(D(e).label).slice(0, 30);
    return d.name;
  }
  function dayTs(v) {
    if (!v) return 0;
    var t = new Date(String(v) + 'T00:00').getTime();
    return isNaN(t) ? 0 : t;
  }
  function tsDay(ts) {
    if (!ts) return '';
    var d = new Date(ts), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function fmtDay(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }
  function days(a, b) { return Math.round((b - a) / 86400000); }
  /* ⚠️ 这些日期都是「某一天」，不带时刻（dayTs 存的就是本地零点）。
     所以「还剩几天 / 过期没有」必须拿**今天零点**去比，不能拿 Date.now() 比：
     拿瞬时比的话，ddl 是明天会显示「就是今天」，ddl 当天一整天都会显示「已过期 1 天」并标红
     （用户视角：截稿日当天一早就变红了）。 */
  function midnight(ts) {
    var d = new Date(ts || Date.now());
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  function daysFromToday(ts) { return days(midnight(Date.now()), midnight(ts)); }
  function isOverdueDay(ts) { return !!ts && midnight(ts) < midnight(Date.now()); }
  function isSoonDay(ts) { return !!ts && !isOverdueDay(ts) && daysFromToday(ts) <= 7; }
  function fromNow(ts) {
    if (!ts) return '';
    var d = daysFromToday(ts);
    if (d === 0) return '就是今天';
    return d > 0 ? ('还有 ' + d + ' 天') : ('已过期 ' + (-d) + ' 天');
  }
  function evAt(e) { return +e.at || +e.createdAt || 0; }
  /* ⚠️ 「当前状态」「列表小字」都按**录入顺序**（createdAt）走，不按日期。
     真实录入里日期常常是倒着的（先记准备中、再补一条日期更早的已投稿），
     按日期取"最新"会把状态判回准备中 —— 用户实测就遇到了（哦哦哦那条）。 */
  function byCreated(p) {
    return (p.events || []).slice().sort(function (a, b) {
      var x = +a.createdAt || 0, y = +b.createdAt || 0;
      if (x !== y) return x - y;
      return evAt(a) - evAt(b);
    });
  }
  /* 时间线**显示**仍按日期排（看起来才顺） */
  function sortedEvents(p) {
    return (p.events || []).slice().sort(function (a, b) {
      var x = evAt(a), y = evAt(b);
      if (x !== y) return x - y;
      return (+a.createdAt || 0) - (+b.createdAt || 0);
    });
  }
  function byId(id) { return papers.filter(function (x) { return x.id === id; })[0]; }
  function evById(p, eid) { return ((p && p.events) || []).filter(function (x) { return x.id === eid; })[0]; }

  /* 当前状态：按录入顺序，最后一条带状态的条目说了算 */
  function statusOfPaper(p) {
    var st = 'preparing', lastAt = 0;
    byCreated(p).forEach(function (e) {
      var d = evOf(e.type);
      var s = d.opinion ? ((kindOf(D(e).kind) || {}).state || null) : d.state;
      if (s) { st = s; lastAt = evAt(e); }
    });
    return { id: st, at: lastAt };
  }
  function statusName(id) {
    if (id === 'preparing') return '准备中';
    for (var i = 0; i < EVENTS.length; i++) if (EVENTS[i].state === id) return EVENTS[i].name;
    for (var j = 0; j < KINDS.length; j++) if (KINDS[j].state === id) return KINDS[j].name;
    return id;
  }
  function statusColor(id) {
    if (id === 'major') return '#E8B843';
    if (id === 'minor') return '#6FB56B';
    if (id === 'accepted') return '#3F9E6E';
    if (id === 'rejected') return '#D9534F';
    if (id === 'withdrawn') return '#9B8EA8';
    if (id === 'submitted') return '#4A9BD4';
    if (id === 'editorReview') return '#88A9C9';
    if (id === 'awaitingDecision') return '#8FB3E0';
    if (id === 'review') return '#7FA8D9';
    return '#8A9AA5';
  }
  function isOpen(p) { return !!OPEN_STATES[statusOfPaper(p).id]; }

  /* 列表上那行小字：期刊/级别/角色 —— 按录入顺序取最后一次填的 */
  function paperMeta(p) {
    var out = { venue: '', level: '', role: '' };
    byCreated(p).forEach(function (e) {
      var d = D(e);
      if (d.venue) out.venue = d.venue;
      if (d.level) out.level = d.level;
      if (d.role) out.role = d.role;
    });
    return out;
  }
  /* 还在等的返修轮次：返修截止有值、交稿还空着 */
  function waitingRounds(p) {
    return sortedEvents(p).filter(function (e) { return evOf(e.type).opinion && +D(e).dueAt && !+D(e).submitAt; });
  }
  function activeDue(p) {
    var cand = [], list = sortedEvents(p);
    /* 「准备中」的投稿 ddl：只要它后面还没有「已投稿」，就一直算数（和返修截止一个道理）——
       按录入顺序判断，不是按日期。 */
    var lastSubAt = 0;
    list.forEach(function (e) { if (e.type === 'submitted') lastSubAt = Math.max(lastSubAt, +e.createdAt || 0); });
    list.forEach(function (e) {
      if (e.type !== 'preparing') return;
      var due = +D(e).due;
      if (!due) return;
      if (lastSubAt && (+e.createdAt || 0) < lastSubAt) return;   // 这之后的某次已投稿 = 已经投出去了
      cand.push(due);
    });
    var w = waitingRounds(p);
    if (w.length) cand.push(+D(w[0]).dueAt);
    if (!cand.length) return 0;
    return Math.min.apply(null, cand);
  }

  /* ------------------------------------------------------------ 存储 + 迁移 */
  /* ⚠️ 读失败（JSON 坏了、迁移抛错）时**不许再写盘**：以前 catch 里只是 papers=[]，
     之后任何一次保存（新增一条、改标题、删条目）都会把这个空数组写回去，
     用户攒了几个月的投稿就一次性没了。现在读失败会把原始串备份到一个单独的键，
     并置 saveBlocked 让 save() 拒绝覆盖 —— 宁可这一次改动没存上，也不能把老数据抹掉。 */
  var saveBlocked = false;
  var saveWarned = false;
  function load() {
    papers = [];
    saveBlocked = false;
    var rawText = null;
    try {
      rawText = localStorage.getItem(STORE_KEY) || '{}';
      var raw = JSON.parse(rawText);
      if (raw && Array.isArray(raw.papers)) papers = raw.papers.filter(Boolean).map(migrate);
    } catch (e) {
      papers = [];
      saveBlocked = true;
      try {
        if (rawText && rawText !== '{}') localStorage.setItem(STORE_KEY + '.broken.' + Date.now(), rawText);
      } catch (e2) { }
      try { console.warn('[我的投稿] 读取出错：已备份原始数据并停止写盘', e); } catch (e3) { }
    }
  }
  /* 老结构一路搬过来：固定日期 → 条目；独立「返修截止/返修已提交」→ 并进前一条「收到意见」；
     记录上的期刊/等级/角色 → 落到第一个「已投稿」条目的详细信息里（列表显示要用）。 */
  function migrate(p) {
    if (!p) return p;
    if (!Array.isArray(p.events)) {
      var evs = [];
      var push = function (type, at, d) {
        if (!at) return;
        evs.push({ id: newId('ev'), type: type, at: +at, createdAt: Date.now(), d: d || {} });
      };
      var base = { venue: p.venue || '', level: p.level || '', role: p.role || '', authors: p.authors || '', venueType: p.venueType || 'journal', link: p.link || '', note: p.note || '' };
      if (+p.submittedAt) push('submitted', +p.submittedAt, base);
      if (!+p.submittedAt) push('preparing', Date.now(), { venue: p.venue || '', level: p.level || '', due: +p.submitDueAt || 0, note: p.note || '' });
      push('review', +p.reviewAt || 0, {});
      if (+p.decisionAt) {
        push('opinion', +p.decisionAt, {
          kind: (p.status === 'rejected' ? 'reject' : (p.status === 'accepted' ? 'accept' : (p.status === 'minor' ? 'minor' : 'major'))),
          dueAt: +p.reviseDueAt || 0, submitAt: +p.resubmitAt || 0
        });
      } else if (+p.reviseDueAt || +p.resubmitAt) {
        push('opinion', Date.now(), { kind: 'major', dueAt: +p.reviseDueAt || 0, submitAt: +p.resubmitAt || 0 });
      }
      if (+p.acceptedAt) push('accept', +p.acceptedAt, { doi: '' });
      if (+p.closedAt && p.status === 'withdrawn') push('withdraw', +p.closedAt, {});
      p.events = evs;
    } else {
      /* 旧类型归一 + 并条目 */
      /* ⚠️ 只转换**旧版的状态类型**（major/minor/reject/rejectResubmit → 收到意见 + kind）。
         绝不能把 accept 也算进来：v6 起「接收」是正经类型、带校稿/见刊/检索/DOI 字段，
         一转换就变成「收到意见：接收」—— 用户填在接收里的内容就"跑到收到意见里"了（实测踩过）。 */
      var kindMap = { major: 'major', minor: 'minor', rejectResubmit: 'resubOther' };
      p.events.forEach(function (e) {
        if (!e.d) e.d = {};
        if (kindMap[e.type]) {
          e.d.kind = e.d.kind || kindMap[e.type];
          if (e.dueAt && !e.d.dueAt) e.d.dueAt = +e.dueAt;
          if (e.submitAt && !e.d.submitAt) e.d.submitAt = +e.submitAt;
          e.type = 'opinion';
        }
        delete e.kind; delete e.dueAt; delete e.submitAt;
      });
      /* 老数据里可能留着「收到意见 · kind=接收」：接收是独立状态，还原成 accept 条目并去掉 kind
         （KINDS 里已经没有 accept 了，留着它会选不中、显示成空白） */
      p.events.forEach(function (e) {
        /* 老数据里把「接收 / 拒稿」记成了收到意见的类型 —— 它们现在是独立状态，还原过去 */
        if (e.type === 'opinion' && e.d && e.d.kind === 'accept') { e.type = 'accept'; delete e.d.kind; }
        if (e.type === 'opinion' && e.d && e.d.kind === 'reject') {
          e.type = 'reject';
          if (e.d.note && !e.d.reason) e.d.reason = e.d.note;
          delete e.d.kind;
        }
      });
      var out = [];
      p.events.forEach(function (e) {
        if (e.type === 'reviseDue' || e.type === 'resubmit') {
          var host = null;
          for (var i = out.length - 1; i >= 0; i--) if (out[i].type === 'opinion') { host = out[i]; break; }
          if (!host) {
            host = { id: newId('ev'), type: 'opinion', at: +e.at || Date.now(), createdAt: +e.createdAt || Date.now(), d: { kind: 'major' } };
            out.push(host);
          }
          /* ⚠️ 老条目可能根本没有 d 字段；以前这里直接写 host.d.dueAt，
             会抛异常并中断合并 —— 用户的返修截止/交稿就是这么丢的。必须先兜住。 */
          if (!host.d) host.d = { kind: 'major' };
          if (e.type === 'reviseDue') host.d.dueAt = +e.at || 0;
          else host.d.submitAt = +e.at || 0;
          return;
        }
        out.push(e);
      });
      /* 记录上残留的期刊/等级/角色 → 补进第一个已投稿条目（或准备中） */
      if (p.venue || p.level || p.role || p.authors || p.link || p.note) {
        var sub = null, prep = null;
        out.forEach(function (e) { if (!sub && e.type === 'submitted') sub = e; if (!prep && e.type === 'preparing') prep = e; });
        var t = sub || prep;
        if (t) {
          t.d = t.d || {};
          ['venue', 'level', 'role', 'authors', 'link', 'note'].forEach(function (k) {
            if (p[k] && !t.d[k]) t.d[k] = p[k];
          });
          if (p.venueType && !t.d.venueType) t.d.venueType = p.venueType;
        }
      }
      p.events = out;
    }
    if (p.submitDueAt && !p.events.some(function (e) { return e.type === 'preparing'; })) {
      p.events.unshift({ id: newId('ev'), type: 'preparing', at: Date.now(), createdAt: Date.now(), d: { due: +p.submitDueAt } });
    }
    delete p.submittedAt; delete p.reviewAt; delete p.decisionAt; delete p.reviseDueAt;
    delete p.resubmitAt; delete p.acceptedAt; delete p.closedAt; delete p.status;
    delete p.decisionText; delete p.reply; delete p.log; delete p.submitDueAt;
    delete p.authors; delete p.role; delete p.venue; delete p.venueType; delete p.level;
    delete p.link; delete p.note;
    p.createdAt = +p.createdAt || Date.now();
    p.updatedAt = +p.updatedAt || p.createdAt;
    return p;
  }
  function save() {
    if (saveBlocked) {
      if (!saveWarned) {
        saveWarned = true;
        flash('投稿数据读取出错，这次改动没有保存（原数据已备份）');
      }
      return;
    }
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ papers: papers })); } catch (e) { }
    syncMemos();
  }

  /* ------------------------------------------------ 投稿截止 → 备忘（**只做单向**）
     用户要求：先把"投稿里的截止"搬到备忘（日历上就能看到、能提醒），
     并**禁止反向修改** —— 备忘那边改了时间，不回写投稿的任何事件。
     映射单独存一份（kunkun.paperlinks.v1），不往备忘对象上挂自定义字段：
     备忘在 app.js 里是白名单重建的，挂上去重启就丢，会导致重复建备忘。 */
  var LINK_KEY = 'kunkun.paperlinks.v1';
  function loadLinks() {
    try { return JSON.parse(localStorage.getItem(LINK_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function saveLinks(o) {
    try { localStorage.setItem(LINK_KEY, JSON.stringify(o)); } catch (e) { }
  }
  /* 这一篇论文"还没了结"的截止有哪些 */
  function liveDeadlines(p) {
    var out = [], list = byCreated(p), lastSub = 0;
    list.forEach(function (e) { if (e.type === 'submitted') lastSub = Math.max(lastSub, +e.createdAt || 0); });
    list.forEach(function (e) {
      if (e.type !== 'preparing') return;
      var due = +D(e).due;
      if (!due) return;
      if (lastSub && (+e.createdAt || 0) < lastSub) return;    // 这之后已经投出去了
      out.push({
        evId: e.id, field: 'due', due: due,
        text: '📄 投稿 · ' + (p.title || '（没写标题）') + ' · 投稿 ddl'
      });
    });
    list.forEach(function (e) {
      var d = D(e);
      if (!evOf(e.type).opinion) return;
      if (!(+d.dueAt) || +d.submitAt) return;                  // 没截止、或已经交掉了
      var k = kindOf(d.kind);
      out.push({
        evId: e.id, field: 'dueAt', due: +d.dueAt,
        text: '📄 投稿 · ' + (p.title || '（没写标题）') + ' · 返修截止' + (k ? '（' + k.name + '）' : '')
      });
    });
    return out;
  }
  /* 一条截止对应备忘该写的文本（同步和收尾都用它，标题改了也能刷新） */
  function deadlineText(p, e) {
    var k = kindOf(D(e).kind);
    if (e.type === 'preparing') return '📄 投稿 · ' + (p.title || '（没写标题）') + ' · 投稿 ddl';
    return '📄 投稿 · ' + (p.title || '（没写标题）') + ' · 返修截止' + (k ? '（' + k.name + '）' : '');
  }
  /* 一条截止"了结"了吗？了结的**完成时间落在真实发生的那一天**（用户要求）：
     · 投稿 ddl → 它后面那条「已投稿」的日期（投出去那天）
     · 返修截止 → 这条收到意见里的「提交返修稿」日期
     没写日期的（比如论文直接进终态）才退回用当前时间。 */
  function resolveDeadline(p, e) {
    var d = D(e);
    /* 这里只回答「这条截止了结了吗、完成时间落在哪天」，返回 {done, doneAt}；不要写显示用的 HTML（曾被批量替换误插过一句拒稿原因）。 */
    if (e.type === 'preparing') {
      var sub = null;
      byCreated(p).forEach(function (x) {
        if (!sub && x.type === 'submitted' && (+x.createdAt || 0) > (+e.createdAt || 0)) sub = x;
      });
      return sub ? { done: true, doneAt: evAt(sub) } : { done: false, doneAt: 0 };
    }
    if (evOf(e.type).opinion && +d.submitAt) return { done: true, doneAt: +d.submitAt };
    return { done: false, doneAt: 0 };
  }
  /* 幂等：一切以 paperlinks 里的 memoId 为准，绝不无脑新建 */
  function syncMemos() {
    var bridge = window.KUNKUN_MEMOS;
    if (!bridge) return;
    var L = loadLinks(), live = {};
    /* 先清理孤儿：论文被删、或那条状态条目被删之后，映射还留着 ——
       这种备忘完全是为那条截止而生成的，源头没了就该一起删掉，
       不然它会一直提醒你一篇已经不存在的论文。 */
    Object.keys(L).forEach(function (evId) {
      var ent = L[evId];
      var pp = byId(ent.paperId);
      var ee = pp ? evById(pp, evId) : null;
      if (!pp || !ee) {
        bridge.remove(ent.memoId);
        delete L[evId];
      }
    });
    papers.forEach(function (p) {
      liveDeadlines(p).forEach(function (it) {
        var old = L[it.evId] || {};
        var memoId = old.memoId || ('pm_' + it.evId);
        live[it.evId] = 1;
        /* 只推 dueAt：投稿这边的截止变了才动备忘的截止时间；备忘自己那边（提醒时间/分类、
           以及用户手改过的截止）不会被反向修改（用户明确要求禁止反向）。
           ⚠️ forceDue 一直给 true：桥那头是「due 和现在不一样才改」，重复调用是空操作；
           以前这里靠映射里记的 due 判断，映射一旦没跟上（比如截止被清空过、又被填回同一个日期），
           那次就永远是 false，备忘会一直停在"已完成"。 */
        bridge.upsert(memoId, deadlineText(p, evById(p, it.evId) || { type: 'preparing' }), it.due, 86400000, true);
        L[it.evId] = { memoId: memoId, paperId: p.id, evId: it.evId, field: it.field, due: it.due };
      });
    });
    /* 已经了结的（交掉了 / 投出去了 / 进了终态）：备忘标记完成 + 完成时间落在真实那天。
       ⚠️ 只有 resolveDeadline 说"真的了结"才 finish；截止被清空（用户把那个日期删了）
       不是完成 —— 那种情况这条截止已经不存在了，生成出来的备忘该直接删掉，
       否则会被标成"已完成（今天）"，在日历上凭空多出一天完成记录。 */
    Object.keys(L).forEach(function (evId) {
      if (live[evId]) return;
      var ent = L[evId];
      var p = byId(ent.paperId);
      var e = p ? evById(p, evId) : null;
      var res = (p && e) ? resolveDeadline(p, e) : { done: false, doneAt: 0 };
      if (res.done) bridge.finish(ent.memoId, (p && e) ? deadlineText(p, e) : null, res.doneAt || 0);
      else bridge.remove(ent.memoId);
    });
    saveLinks(L);
  }
  function touch(p) { if (p) p.updatedAt = Date.now(); }

  /* ------------------------------------------------------------ 统计 */
  function stats() {
    var total = papers.length, open = 0, accepted = 0, rejected = 0, waiting = 0;
    var gaps = [], decided = 0, roundSum = 0, roundCnt = 0;
    papers.forEach(function (p) {
      var st = statusOfPaper(p).id;
      if (OPEN_STATES[st]) open++;
      if (st === 'accepted') accepted++;
      if (st === 'rejected') rejected++;
      if (activeDue(p)) waiting++;
      var list = sortedEvents(p), sub = 0, firstOp = 0, n = 0;
      list.forEach(function (e) {
        if (e.type === 'submitted' && !sub) sub = evAt(e);
        var d = evOf(e.type);
        if (d.opinion) {
          if (!firstOp) firstOp = evAt(e);
          var k = kindOf(D(e).kind);
          if (k && k.state !== 'submitted') n++;
        }
      });
      if (sub && firstOp && firstOp > sub) { gaps.push(days(sub, firstOp)); decided++; }
      if (n) { roundSum += n; roundCnt++; }
    });
    return {
      total: total, open: open, accepted: accepted, rejected: rejected, waiting: waiting,
      avg: gaps.length ? Math.round(gaps.reduce(function (s, x) { return s + x; }, 0) / gaps.length) : 0,
      decided: decided,
      avgRound: roundCnt ? Math.round((roundSum / roundCnt) * 10) / 10 : 0
    };
  }

  /* ------------------------------------------------------------ 渲染 */
  function renderFilter() {
    var box = $('paperFilter');
    if (!box) return;
    var counts = {};
    papers.forEach(function (p) { var st = statusOfPaper(p).id; counts[st] = (counts[st] || 0) + 1; });
    /* ⚠️ 筛的那个状态可能已经没有论文了（删掉它下面最后一篇、或那篇换了状态）：
       这种按钮不会再生成，界面就会「一个都没高亮、列表还空着」。先退回「全部」。 */
    if (filter !== 'all' && filter !== 'open' && !counts[filter]) filter = 'all';
    var items = [{ id: 'open', name: '进行中' }, { id: 'all', name: '全部' }];
    ['submitted', 'editorReview', 'review', 'awaitingDecision', 'major', 'minor', 'preparing', 'accepted', 'rejected', 'withdrawn'].forEach(function (st) {
      if (counts[st]) items.push({ id: st, name: statusName(st) + ' ' + counts[st] });
    });
    box.innerHTML = items.map(function (it) {
      return '<button class="ax-tab' + (filter === it.id ? ' on' : '') + '" data-pf="' + it.id + '">' + esc(it.name) + '</button>';
    }).join('');
  }
  function renderStats() {
    var box = $('paperStats');
    if (!box) return;
    var s = stats();
    if (!s.total) {
      box.textContent = '还没有论文。点右上角「＋ 新增论文」：填个标题、选「准备中」或「已投稿」，之后每走一步就「＋ 添加一条状态」，点条目右侧「详细信息」填细节。';
      return;
    }
    var bits = ['共 ' + s.total + ' 篇', '进行中 ' + s.open];
    if (s.accepted) bits.push('已接收 ' + s.accepted);
    if (s.rejected) bits.push('已拒稿 ' + s.rejected);
    if (s.waiting) bits.push('待处理 ' + s.waiting + ' 篇');
    if (s.avg) bits.push('平均审稿周期 ' + s.avg + ' 天（' + s.decided + ' 篇有数据）');
    if (s.avgRound) bits.push('平均 ' + s.avgRound + ' 轮意见');
    box.textContent = bits.join(' · ');
  }

  /* 一行摘要里该显示什么（按类型） */
  function evSummary(e) {
    var d = D(e);
    if (evOf(e.type).opinion) {
      var due = +d.dueAt || 0, sub = +d.submitAt || 0;
      if (due && sub) return '<span class="pp-ev-ok">截止 ' + fmtDay(due) + ' · 已于 ' + fmtDay(sub) + ' 提交</span>';
      if (due) return '<span class="' + (isOverdueDay(due) ? 'pp-ev-late' : (isSoonDay(due) ? 'pp-ev-soon' : 'pp-ev-tip')) + '">返修截止 ' + fmtDay(due) + ' · ' + fromNow(due) + '</span>';
      if (sub) return '<span class="pp-ev-ok">已于 ' + fmtDay(sub) + ' 提交</span>';
      return '<span class="pp-ev-tip">点「详细信息」填类型和返修时间</span>';
    }
    if (e.type === 'reject' && d.reason) return '<span class="pp-ev-tip">' + esc(d.reason) + '</span>';
    if (e.type === 'preparing') {
      var t = [];
      if (d.venue) t.push(esc(d.venue));
      if (d.level) t.push(esc(d.level));
      /* 投稿 ddl 要和返修截止一样醒目：同一套变色（临近橙、过期红），不再只是灰色提示 */
      var ddl = '';
      if (+d.due) {
        ddl = '<span class="' + (isOverdueDay(+d.due) ? 'pp-ev-late' : (isSoonDay(+d.due) ? 'pp-ev-soon' : 'pp-ev-tip')) + '">投稿 ddl ' +
          fmtDay(d.due) + ' · ' + fromNow(d.due) + '</span>';
      }
      return (t.length ? '<span class="pp-ev-tip">' + t.join(' · ') + '</span>' : '') + (ddl ? (t.length ? ' ' : '') + ddl : '');
    }
    if (e.type === 'submitted') {
      var s2 = [];
      if (d.venue) s2.push(esc(d.venue));
      if (d.level) s2.push(esc(d.level));
      if (d.role) s2.push(esc(ROLES[d.role] || d.role));
      return s2.length ? '<span class="pp-ev-tip">' + s2.join(' · ') + '</span>' : '';
    }
    if (e.type === 'accept') {
      var a = [];
      if (+d.publishAt) a.push('见刊 ' + fmtDay(d.publishAt));
      if (+d.indexAt) a.push('检索 ' + fmtDay(d.indexAt));
      if (d.doi) a.push(esc(d.doi));
      return a.length ? '<span class="pp-ev-tip">' + a.join(' · ') + '</span>' : '';
    }
    if (e.type === 'index' && d.doi) return '<span class="pp-ev-tip">' + esc(d.doi) + '</span>';
    return '';
  }

  function evRowHtml(p, e) {
    var d = evOf(e.type);
    /* 「还没了结」的截止整条给点警示：返修截止（没交稿）+ 投稿 ddl（还没投出去）*/
    var urgent = (d.opinion && +D(e).dueAt && !+D(e).submitAt) ||
      (e.type === 'preparing' && +D(e).due && !resolveDeadline(p, e).done);
    return '<div class="pp-ev' + (urgent ? ' urgent' : '') + '" data-ev="' + esc(e.id) + '">' +
      '<span class="pp-ev-dot" style="background:' + (d.opinion ? (kindOf(D(e).kind) || { color: '#E8B843' }).color || '#E8B843' : d.color) + '"></span>' +
      '<span class="pp-ev-name">' + esc(evName(e)) + '</span>' +
      evSummary(e) +
      '<span class="pp-ev-date">' + esc(tsDay(evAt(e))) + '</span>' +
      '<button class="pp-ev-more" data-role="evdetail">详细信息</button>' +
      '<button class="pp-ev-ico del" data-role="evdel" title="删这条">✕</button>' +
    '</div>';
  }

  function detailHtml(p) {
    return '' +
      '<div class="pp-detail">' +
        '<div class="pp-ev-head">状态时间线' +
          '<span class="pp-ev-tip">添加时只选类型；日期和各项内容点条目右侧「详细信息」填</span></div>' +
        '<div class="pp-evs">' +
          (sortedEvents(p).length
            ? sortedEvents(p).slice().reverse().map(function (e) { return evRowHtml(p, e); }).join('')
            : '<div class="pp-empty">还没有状态条目。下面选个类型「＋ 添加一条状态」开始记。</div>') +
        '</div>' +
        '<div class="pp-add-ev">' +
          '<select class="skin-sel" id="ppEvType">' + EVENTS.map(function (e) {
            return '<option value="' + e.id + '"' + (e.id === addType ? ' selected' : '') + '>' + esc(e.name) + '</option>';
          }).join('') + '</select>' +
          '<button class="btn sm primary" id="ppEvAdd">＋ 添加一条状态</button>' +
        '</div>' +
        '<div class="pp-acts">' +
          '<button class="btn sm" data-role="timeline">论文完整信息</button>' +
          '<button class="btn sm" data-role="del">删除这篇论文</button>' +
        '</div>' +
      '</div>';
  }

  function rowHtml(p) {
    var st = statusOfPaper(p);
    var open = openedId === p.id;
    var m = paperMeta(p);
    var due = activeDue(p);
    var overdue = isOverdueDay(due);
    var soon = isSoonDay(due);
    var dueLabel = (st.id === 'preparing') ? '投稿 ddl ' : '返修 ';
    var bits = [];
    if (m.venue) bits.push('<span class="pp-venue">' + esc(m.venue) + '</span>');
    if (m.level) bits.push('<span class="pp-level">' + esc(m.level) + '</span>');
    if (m.role) bits.push('<span class="pp-role">' + esc(ROLES[m.role] || m.role) + '</span>');
    var sub = sortedEvents(p).filter(function (e) { return e.type === 'submitted'; })[0];
    if (sub) bits.push('<span>投 ' + fmtDay(evAt(sub)) + '</span>');
    if (st.at) bits.push('<span>' + esc(statusName(st.id)) + ' ' + fmtDay(st.at) + '</span>');
    bits.push('<span>' + (p.events || []).length + ' 条状态</span>');
    return '' +
      '<div class="paper-item' + (open ? ' open' : '') + '" data-id="' + esc(p.id) + '">' +
        '<div class="pp-head">' +
          '<span class="pp-status" style="background:' + statusColor(st.id) + '">' + esc(statusName(st.id)) + '</span>' +
          '<span class="pp-title">' + esc(p.title || '（没写标题）') + '</span>' +
          (due ? '<span class="pp-due' + (overdue ? ' late' : (soon ? ' soon' : '')) + '">' + dueLabel + fmtDay(due) + ' · ' + fromNow(due) + '</span>' : '') +
          '<span class="pp-caret">' + (open ? '▴' : '▾') + '</span>' +
        '</div>' +
        '<div class="pp-meta">' + bits.join('') + '</div>' +
        (open ? detailHtml(p) : '') +
      '</div>';
  }

  function renderList() {
    var box = $('paperList');
    if (!box) return;
    var list = papers.filter(function (p) {
      if (filter === 'all') return true;
      if (filter === 'open') return isOpen(p);
      return statusOfPaper(p).id === filter;
    });
    list.sort(function (a, b) {
      var da = activeDue(a), db = activeDue(b);
      if (!!da !== !!db) return da ? -1 : 1;
      if (da && db && da !== db) return da - db;
      var oa = isOpen(a) ? 0 : 1, ob = isOpen(b) ? 0 : 1;
      if (oa !== ob) return oa - ob;
      return statusOfPaper(b).at - statusOfPaper(a).at;
    });
    if (!list.length) {
      box.innerHTML = '<div class="empty-tip">' + (papers.length ? '这个筛选下没有记录，点上面的「全部」看看。' : '还没有论文。') + '</div>';
      return;
    }
    box.innerHTML = list.map(rowHtml).join('');
  }

  function render() { renderStats(); renderFilter(); renderList(); }

  /* ------------------------------------------------------------ 新增/改标题：只要标题 + 两选一 */
  function paintMode(mode) {
    var prep = mode === 'preparing';
    if ($('ppModePrep')) $('ppModePrep').classList.toggle('on', prep);
    if ($('ppModeSub')) $('ppModeSub').classList.toggle('on', !prep);
    /* ⚠️ 这两行必须跟着模式切：准备中填「投稿 ddl」、已投稿填「投稿日期」。
       以前只切了按钮的高亮，两行永远停在初始状态（「投稿日期」那行压根打不开），
       而 saveModal 又不读这两个框 —— 用户在新增弹窗里填的日期当场被丢掉。 */
    if ($('ppSubmitDueRow')) $('ppSubmitDueRow').hidden = !prep;
    if ($('ppSubmittedRow')) $('ppSubmittedRow').hidden = prep;
  }
  function openModal(id) {
    editingId = id || null;
    var p = id ? byId(id) : null;
    if ($('paperTitle')) $('paperTitle').textContent = p ? '改标题' : '新增论文';
    if ($('ppTitle')) $('ppTitle').value = p ? p.title : '';
    paintMode('preparing');
    var row = $('paperModeRow');
    if (row) row.hidden = !!p;
    if (p) {
      /* 改标题：日期那两行藏起来（这一次只改标题，别让人以为填了会存） */
      if ($('ppSubmitDueRow')) $('ppSubmitDueRow').hidden = true;
      if ($('ppSubmittedRow')) $('ppSubmittedRow').hidden = true;
    } else {
      /* 新增：把三个框清干净，别留着上一次的值让人以为已经填好了 */
      if ($('ppSubmitDue')) $('ppSubmitDue').value = '';
      if ($('ppSubmitted')) $('ppSubmitted').value = '';
      if ($('ppRole')) $('ppRole').value = 'first';
    }
    var ov = $('paperOverlay');
    if (ov) ov.hidden = false;
    if ($('ppTitle')) { try { $('ppTitle').focus(); } catch (e) { } }
  }
  function closeModal() { var ov = $('paperOverlay'); if (ov) ov.hidden = true; editingId = null; }
  function saveModal() {
    var title = $('ppTitle') ? String($('ppTitle').value || '').trim().slice(0, 300) : '';
    if (!title) { flash('标题不能空着'); return; }
    var p = editingId ? byId(editingId) : null;
    if (p) {
      p.title = title;
      touch(p);
      save(); closeModal(); render();
      return;
    }
    var isPrep = $('ppModePrep') ? $('ppModePrep').classList.contains('on') : true;
    var np = { id: newId('pp'), title: title, createdAt: Date.now(), updatedAt: Date.now(), events: [] };
    var ev = { id: newId('ev'), type: isPrep ? 'preparing' : 'submitted', at: dayTs(tsDay(Date.now())), createdAt: Date.now(), d: {} };
    /* 弹窗里填的「我的角色」和日期要真的存下来（以前这三个框没有任何代码读取） */
    var role = $('ppRole') ? String($('ppRole').value || '') : '';
    if (role) ev.d.role = role;
    if (isPrep) {
      var ddl = dayTs($('ppSubmitDue') ? $('ppSubmitDue').value : '');
      if (ddl) ev.d.due = ddl;                 // 准备中：这就是那个会进备忘的投稿 ddl
    } else {
      var subDay = dayTs($('ppSubmitted') ? $('ppSubmitted').value : '');
      if (subDay) ev.at = subDay;              // 已投稿：投出去那天
    }
    np.events.push(ev);
    papers.unshift(np);
    openedId = np.id;
    save(); closeModal(); render();
    /* 建完直接把这条的详细信息打开 —— 期刊/作者这些就在里面填 */
    openDetail(np.id, np.events[0].id);
  }

  var flashTimer = null;
  var undoAction = null;
  /* 提示条：带「撤销」时多一个按钮 —— 删东西手滑了能立刻找回来（用户反馈删除太容易误删） */
  function flash(msg, undo) {
    var box = $('paperFlash');
    if (!box) {
      box = document.createElement('div');
      box.id = 'paperFlash';
      box.className = 'paper-flash';
      document.body.appendChild(box);
    }
    box.innerHTML = '';
    var span = document.createElement('span');
    span.textContent = msg;
    box.appendChild(span);
    undoAction = undo || null;
    if (undo) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'paper-undo';
      btn.textContent = '撤销';
      btn.addEventListener('click', function () {
        var fn = undoAction;
        undoAction = null;
        box.classList.remove('on');
        if (fn) fn();
      });
      box.appendChild(btn);
    }
    box.classList.add('on');
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(function () {
      box.classList.remove('on');
      undoAction = null;
    }, undo ? 7000 : 2200);
  }

  /* ------------------------------------------------------------ 详细信息（字段随类型变） */
  function field(label, inner) {
    return '<label>' + esc(label) + '</label>' + inner;
  }
  function input(id, val, ph, max) {
    return '<input type="text" id="' + id + '" maxlength="' + (max || 200) + '" value="' + esc(val || '') +
      '" placeholder="' + esc(ph || '') + '">';
  }
  function dateIn(id, ts) {
    return '<input type="date" id="' + id + '" value="' + tsDay(ts) + '">';
  }
  /* 「已投稿」的默认值：从前面「准备中」继承期刊/级别 */
  function inheritFrom(p, eid) {
    var out = { venue: '', level: '', venueType: 'journal' };
    var list = sortedEvents(p);
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === eid) break;
      if (list[i].type === 'preparing') {
        var d = D(list[i]);
        if (d.venue) out.venue = d.venue;
        if (d.level) out.level = d.level;
      }
    }
    return out;
  }

  /* 常用期刊/会议 + 级别候选（级别里不要 Q1~Q4 —— 用户明确点名） */
  var VENUE_LIST = ['IEEE TIP', 'IEEE TGRS', 'IEEE TNNLS', 'IEEE TCSVT', 'IEEE TIM', 'IEEE TITS',
    'Pattern Recognition', 'Information Fusion', 'Remote Sensing', 'ISPRS J', '自动化学报', '电子学报',
    'CVPR', 'ICCV', 'ECCV', 'NeurIPS', 'ICML', 'AAAI', 'IJCAI', 'ACM MM', 'ICRA', 'IROS'];
  var LEVEL_LIST = ['中科院一区', '中科院二区', '中科院三区', '中科院四区',
    'CCF A', 'CCF B', 'CCF C', 'CCF N', 'EI', '中文核心', 'SCI'];
  function dataList(id, arr) {
    return '<datalist id="' + id + '">' + arr.map(function (x) { return '<option value="' + esc(x) + '"></option>'; }).join('') + '</datalist>';
  }
  function venueInput(id, val) {
    return '<input type="text" id="' + id + '" list="ppVenueList" maxlength="120" value="' + esc(val || '') +
      '" placeholder="选一个或自己写"><' + '/input>';
  }
  function levelInput(id, val) {
    return '<input type="text" id="' + id + '" list="ppLevelList" maxlength="40" value="' + esc(val || '') +
      '" placeholder="选一个或自己写"><' + '/input>';
  }
  function dateField(id, ts) { return '<label>日期</label><input type="date" id="' + id + '" value="' + tsDay(ts) + '">'; }
  /* 日期那一栏的名字随类型变 —— 「接收」就该叫接收时间，不该是光秃秃一个「日期」 */
  function dateLabel(t) {
    if (t === 'submitted') return '投稿日期';
    if (t === 'review') return '开始审稿';
    if (t === 'accept') return '接收时间';
    if (t === 'index') return '检索日期';
    if (t === 'withdraw') return '撤稿日期';
    return '日期';
  }
  /* 日期这一栏的名字随类型变 —— 「接收」就该叫接收时间，不该是个光秃秃的「日期」 */
  function dateLabel(t) {
    if (t === 'submitted') return '投稿日期';
    if (t === 'review') return '开始审稿';
    if (t === 'accept') return '接收时间';
    if (t === 'index') return '检索日期';
    if (t === 'withdraw') return '撤稿日期';
    return '日期';
  }

  function openDetail(pid, eid) {
    var p = byId(pid);
    var e = evById(p, eid);
    if (!p || !e) return;
    detailFor = { pid: pid, eid: eid };
    var t = e.type, d = D(e);
    var inh = (t === 'submitted') ? inheritFrom(p, eid) : { venue: '', level: '', venueType: 'journal' };
    var venue = d.venue || inh.venue || '';
    var level = d.level || inh.level || '';
    var vtype = d.venueType || inh.venueType || 'journal';
    var body = '';
    if (t === 'preparing') {
      body =
        field('拟投期刊/会议', venueInput('ppDVenue', venue)) +
        field('级别', levelInput('ppDLevel', level)) +
        field('投稿 ddl', dateIn('ppDDue', d.due)) +
        field('备注', input('ppDNote', d.note, '可空'));
    } else if (t === 'submitted') {
      body =
        field('作者', input('ppDAuthors', d.authors, '按顺序：张三, 李四')) +
        /* 角色：可以从候选里挑，也可以自己写（写什么就显示什么）*/
        field('我的角色', '<input type="text" id="ppDRole" list="ppRoleList" maxlength="20" value="' +
          esc(d.role ? (ROLES[d.role] || d.role) : '一作') + '">' +
          '<datalist id="ppRoleList">' + Object.keys(ROLES).map(function (k) {
            return '<option value="' + esc(ROLES[k]) + '"></option>';
          }).join('') + '</datalist>') +
        field('期刊/会议', venueInput('ppDVenue', venue)) +
        field('类型', '<select class="skin-sel" id="ppDVenueType">' +
          '<option value="journal"' + (vtype === 'journal' ? ' selected' : '') + '>期刊</option>' +
          '<option value="conference"' + (vtype === 'conference' ? ' selected' : '') + '>会议</option></select>') +
        field('级别', levelInput('ppDLevel', level)) +
        field('链接', input('ppDLink', d.link, 'https://…', 300)) +
        field('备注', input('ppDNote', d.note, '可空'));
    } else if (t === 'opinion') {
      body =
        field('意见类型', '<select class="skin-sel" id="ppOpKind">' + KINDS.map(function (k) {
          return '<option value="' + k.id + '"' + (k.id === (d.kind || 'major') ? ' selected' : '') + '>' + esc(k.name) + '</option>';
        }).join('') + '</select>') +
        field('收到日期', '<input type="date" id="ppOpAt" value="' + tsDay(evAt(e)) + '">') +
        field('返修截止', '<input type="date" id="ppOpDue" value="' + tsDay(d.dueAt) + '">') +
        field('提交返修稿', '<input type="date" id="ppOpSubmit" value="' + tsDay(d.submitAt) + '">') +
        field('备注', input('ppDNote', d.note, '可空'));
    } else if (t === 'accept') {
      body =
        field('校稿时间', dateIn('ppDProof', d.proofAt)) +
        field('发表/见刊', dateIn('ppDPublish', d.publishAt)) +
        field('检索时间', dateIn('ppDIndex', d.indexAt)) +
        field('DOI', input('ppDDoi', d.doi, '10.1109/…', 200)) +
        field('备注', input('ppDNote', d.note, '可空'));
    } else if (t === 'index') {
      body = field('DOI', input('ppDDoi', d.doi, '10.1109/…', 200)) + field('备注', input('ppDNote', d.note, '可空'));
    } else if (t === 'reject') {
      body = field('拒稿原因（可空）', input('ppDReason', d.reason, '比如：创新性不足 / 版面不符 / 建议改投')) +
        field('备注', input('ppDNote', d.note, '可空'));
    } else if (t === 'other') {
      body = field('状态说明（会显示在时间线上）', input('ppDLabel', d.label, '比如：送外审 / 补材料 / 等待答复')) +
        field('备注', input('ppDNote', d.note, '可空'));
    } else {
      body = field('备注', input('ppDNote', d.note, '可空'));
    }
    var old = $('ppOpinionOverlay');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var ov = document.createElement('div');
    ov.className = 'overlay modal';
    ov.id = 'ppOpinionOverlay';
    ov.innerHTML = '<div class="overlay-card item-card pp-op-card">' +
      '<button class="close" id="ppOpClose" title="关闭">✕</button>' +
      '<h3 class="it-title">' + esc(evName(e)) + ' · 详细信息</h3>' +
      '<p class="col-sub">' + (t === 'review' ? '审稿中只记一个日期：从这天起在审。' :
        (t === 'submitted' ? '期刊/级别如果前面「准备中」填过，这里会自动带出来，可以改。作者 / 期刊 / 级别 / 链接都记在这一条里；论文标题在这个弹窗最上面也能改。' :
          '填的都在这一条状态上，列表上的小字和倒计时都跟着它走。')) + '</p>' +
      '<div class="pp-op-grid">' +
        /* 论文标题放在最上面 —— 记录级的字段，在哪个状态的详细信息里都能顺手改 */
        '<label>论文标题</label><input type="text" id="ppDTitle" maxlength="300" value="' + esc(p.title || '') + '">' +
        /* 日期永远排最上面（用户要求：接收里先「接收时间」，再校稿/见刊/检索/DOI）。
           「收到意见」自己有「收到日期」（在 body 第一行），不重复。 */
        (t === 'opinion' ? '' : '<label>' + esc(dateLabel(t)) + '</label><input type="date" id="ppDAt" value="' + tsDay(evAt(e)) + '">') +
        body +
      '</div>' +
      dataList('ppVenueList', VENUE_LIST) + dataList('ppLevelList', LEVEL_LIST) +
      '<div class="alert-btns">' +
        '<button class="btn primary big" id="ppOpOk">保存</button>' +
        '<button class="btn big" id="ppOpCancel">取消</button>' +
      '</div>' +
    '</div>';
    document.body.appendChild(ov);
    if ($('ppOpOk')) $('ppOpOk').addEventListener('click', saveDetail);
    if ($('ppOpCancel')) $('ppOpCancel').addEventListener('click', closeDetail);
    if ($('ppOpClose')) $('ppOpClose').addEventListener('click', closeDetail);
    ov.addEventListener('click', function (ev) { if (ev.target === ov) closeDetail(); });
  }
  function closeDetail() {
    var ov = $('ppOpinionOverlay');
    if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
    detailFor = null;
  }
  function saveDetail() {
    var p = detailFor ? byId(detailFor.pid) : null;
    var e = p ? evById(p, detailFor.eid) : null;
    if (!p || !e) { closeDetail(); return; }
    var t = e.type;
    var val = function (id) { var el = $(id); return el ? String(el.value || '').trim() : ''; };
    var ts = function (id) { return dayTs(val(id)); };
    if (!e.d) e.d = {};
    var d = e.d;
    /* 详细信息里能改论文标题（记录级）—— 留空则不动 */
    var titleNew = val('ppDTitle');
    if (titleNew) p.title = titleNew.slice(0, 300);
    if (t === 'preparing') {
      d.venue = val('ppDVenue').slice(0, 120);
      d.level = val('ppDLevel').slice(0, 40);
      d.due = ts('ppDDue');
      d.note = val('ppDNote').slice(0, 300);
      if (ts('ppDDue')) e.at = e.at || dayTs(tsDay(Date.now()));
    } else if (t === 'submitted') {
      d.authors = val('ppDAuthors').slice(0, 200);
      /* 角色存的是 key（一作→first）或自定义文字原样存 */
      var roleRaw = val('ppDRole');
      var roleKey = 'first';
      Object.keys(ROLES).forEach(function (k) { if (ROLES[k] === roleRaw) roleKey = k; });
      d.role = (roleKey === 'first' && roleRaw && roleRaw !== ROLES.first) ? roleRaw.slice(0, 20) : roleKey;
      d.venue = val('ppDVenue').slice(0, 120);
      d.venueType = val('ppDVenueType') || 'journal';
      d.level = val('ppDLevel').slice(0, 40);
      d.link = val('ppDLink').slice(0, 300);
      d.note = val('ppDNote').slice(0, 300);
    } else if (t === 'opinion') {
      d.kind = val('ppOpKind') || 'major';
      var at = ts('ppOpAt');
      if (at) e.at = at;
      d.dueAt = ts('ppOpDue');
      d.submitAt = ts('ppOpSubmit');
      d.note = val('ppDNote').slice(0, 300);
    } else if (t === 'accept') {
      d.proofAt = ts('ppDProof');
      d.publishAt = ts('ppDPublish');
      d.indexAt = ts('ppDIndex');
      d.doi = val('ppDDoi').slice(0, 200);
      d.note = val('ppDNote').slice(0, 300);
    } else if (t === 'index') {
      d.doi = val('ppDDoi').slice(0, 200);
      d.note = val('ppDNote').slice(0, 300);
    } else if (t === 'reject') {
      d.reason = val('ppDReason').slice(0, 200);
      d.note = val('ppDNote').slice(0, 300);
    } else if (t === 'other') {
      d.label = val('ppDLabel').slice(0, 30);
      d.note = val('ppDNote').slice(0, 300);
    } else {
      d.note = val('ppDNote').slice(0, 300);
    }
    if ($('ppDAt')) { var a2 = ts('ppDAt'); if (a2) e.at = a2; }
    touch(p);
    closeDetail();
    save(); render();
    flash('已保存：' + evName(e));
  }

  /* ------------------------------------------------------------ 完整时间线弹窗 */
  function showTimeline(pid) {
    var p = byId(pid);
    if (!p) return;
    var st = statusOfPaper(p);
    var rows = sortedEvents(p).map(function (e) {
      var d = evOf(e.type), dd = D(e);
      var extras = [];
      if (d.opinion) {
        if (+dd.dueAt) extras.push('返修截止 ' + tsDay(dd.dueAt));
        if (+dd.submitAt) extras.push('交稿 ' + tsDay(dd.submitAt));
        if (dd.note) extras.push(dd.note);
      } else if (e.type === 'preparing') {
        if (dd.venue) extras.push(dd.venue);
        if (dd.level) extras.push(dd.level);
        if (+dd.due) extras.push('ddl ' + tsDay(dd.due));
      } else if (e.type === 'submitted') {
        if (dd.authors) extras.push('作者 ' + dd.authors);
        if (dd.role) extras.push(ROLES[dd.role] || dd.role);
        if (dd.venue) extras.push(dd.venue);
        if (dd.level) extras.push(dd.level);
        if (dd.link) extras.push(dd.link);
      } else if (e.type === 'accept') {
        if (+dd.proofAt) extras.push('校稿 ' + tsDay(dd.proofAt));
        if (+dd.publishAt) extras.push('见刊 ' + tsDay(dd.publishAt));
        if (+dd.indexAt) extras.push('检索 ' + tsDay(dd.indexAt));
        if (dd.doi) extras.push('DOI ' + dd.doi);
      } else if (e.type === 'index' && dd.doi) extras.push('DOI ' + dd.doi);
      if (dd.note && extras.indexOf(dd.note) < 0) extras.push(dd.note);
      return '<div class="pp-tl-row">' +
        '<span class="pp-tl-date">' + esc(tsDay(evAt(e))) + '</span>' +
        '<span class="pp-tl-dot" style="background:' + d.color + '"></span>' +
        '<span class="pp-tl-name">' + esc(evName(e)) + '</span>' +
        '<span class="pp-tl-ext">' + esc(extras.join(' · ')) + '</span>' +
      '</div>';
    }).join('');
    var m = paperMeta(p);
    var head = [];
    if (m.venue) head.push(esc(m.venue) + (m.level ? '（' + esc(m.level) + '）' : ''));
    if (m.role) head.push(esc(ROLES[m.role] || m.role));
    var old = $('ppTimelineOverlay');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var ov = document.createElement('div');
    ov.className = 'overlay modal';
    ov.id = 'ppTimelineOverlay';
    ov.innerHTML = '<div class="overlay-card item-card pp-tl-card">' +
      '<button class="close" id="ppTlClose" title="关闭">✕</button>' +
      '<h3 class="it-title">论文完整信息</h3>' +
      /* 标题先**完整展示**（长标题要能看全），要改再点「✎ 修改标题」进编辑态 ——
         不要一进来就是个输入框。 */
      '<div class="pp-tl-title" id="ppTlTitleView">' +
        '<span class="pp-tl-title-text" id="ppTlTitleText">' + esc(p.title || '（没写标题）') + '</span>' +
        '<button class="btn sm" id="ppTlEditTitle">✎ 修改标题</button>' +
      '</div>' +
      '<div class="pp-tl-edit" id="ppTlEditBox" hidden>' +
        '<label>标题</label>' +
        '<input type="text" id="ppTlTitle" maxlength="300" value="' + esc(p.title || '') + '">' +
        '<button class="btn sm primary" id="ppTlSaveTitle">保存</button>' +
        '<button class="btn sm" id="ppTlCancelTitle">取消</button>' +
      '</div>' +
      '<p class="col-sub">当前状态：<b style="color:' + statusColor(st.id) + '">' + esc(statusName(st.id)) + '</b>' +
        (st.at ? '（' + fmtDay(st.at) + '）' : '') + (head.length ? ' · ' + head.join(' · ') : '') + '</p>' +
      '<div class="pp-tl">' + (rows || '<div class="pp-empty">还没有状态条目。</div>') + '</div>' +
    '</div>';
    document.body.appendChild(ov);
    if ($('ppTlEditTitle')) {
      $('ppTlEditTitle').addEventListener('click', function () {
        if ($('ppTlTitleView')) $('ppTlTitleView').hidden = true;
        if ($('ppTlEditBox')) $('ppTlEditBox').hidden = false;
        if ($('ppTlTitle')) { $('ppTlTitle').value = p.title || ''; try { $('ppTlTitle').focus(); } catch (e) { } }
      });
    }
    if ($('ppTlCancelTitle')) {
      $('ppTlCancelTitle').addEventListener('click', function () {
        if ($('ppTlEditBox')) $('ppTlEditBox').hidden = true;
        if ($('ppTlTitleView')) $('ppTlTitleView').hidden = false;
      });
    }
    if ($('ppTlSaveTitle')) {
      $('ppTlSaveTitle').addEventListener('click', function () {
        var v = $('ppTlTitle') ? String($('ppTlTitle').value || '').trim().slice(0, 300) : '';
        if (!v) { flash('标题不能空着'); return; }
        p.title = v;
        touch(p);
        save(); render();
        flash('标题改好了');
        if (ov.parentNode) ov.parentNode.removeChild(ov);
        showTimeline(p.id);
      });
    }
    if ($('ppTlTitle')) {
      $('ppTlTitle').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); if ($('ppTlSaveTitle')) $('ppTlSaveTitle').click(); }
      });
    }
    if ($('ppTlClose')) $('ppTlClose').addEventListener('click', function () { if (ov.parentNode) ov.parentNode.removeChild(ov); });
    ov.addEventListener('click', function (e) { if (e.target === ov && ov.parentNode) ov.parentNode.removeChild(ov); });
  }

  /* ------------------------------------------------------------ 条目：增 / 删 */
  function addEvent(pid) {
    var p = byId(pid);
    if (!p) return;
    var type = $('ppEvType') ? $('ppEvType').value : addType;
    addType = type;
    if (!Array.isArray(p.events)) p.events = [];
    var e = { id: newId('ev'), type: type, at: dayTs(tsDay(Date.now())), createdAt: Date.now(), d: {} };
    p.events.push(e);
    touch(p);
    save(); render();
    openDetail(pid, e.id);        // 加完直接打开详细信息填内容
  }
  function delEvent(pid, eid) {
    var p = byId(pid);
    if (!p || !Array.isArray(p.events)) return;
    var e = p.events.filter(function (x) { return x.id === eid; })[0];
    if (!e) return;
    /* 删状态也要问一句：以前一个 ✕ 就没了，手滑就找不回来（用户反馈） */
    if (!window.confirm('删掉「' + evName(e) + '」这条状态？\n（删了可以用下面的「撤销」找回）')) return;
    var idx = p.events.indexOf(e);
    p.events = p.events.filter(function (x) { return x.id !== eid; });
    if (detailFor && detailFor.eid === eid) closeDetail();
    touch(p);
    save(); render();
    flash('已删掉「' + evName(e) + '」', function () {
      p.events.splice(idx, 0, e);
      touch(p);
      save(); render();
      flash('已找回「' + evName(e) + '」');
    });
  }

  /* ------------------------------------------------------------ 导出 Markdown */
  function exportMarkdown() {
    var lines = ['# 投稿记录', '', '> 导出时间：' + new Date().toLocaleString('sv-SE').slice(0, 16), ''];
    var groups = {};
    papers.forEach(function (p) { var st = statusOfPaper(p).id; (groups[st] = groups[st] || []).push(p); });
    ['review', 'editorReview', 'awaitingDecision', 'submitted', 'major', 'minor', 'preparing', 'accepted', 'rejected', 'withdrawn'].forEach(function (st) {
      var arr = groups[st];
      if (!arr || !arr.length) return;
      lines.push('## ' + statusName(st) + '（' + arr.length + '）', '');
      arr.forEach(function (p) {
        var m = paperMeta(p);
        lines.push('### ' + (p.title || '（没写标题）'));
        var meta = [];
        if (m.venue) meta.push('期刊/会议：' + m.venue);
        if (m.level) meta.push('等级：' + m.level);
        if (m.role) meta.push('我的角色：' + (ROLES[m.role] || m.role));
        meta.forEach(function (x) { lines.push('- ' + x); });
        lines.push('', '**状态时间线**：');
        sortedEvents(p).forEach(function (e) {
          var dd = D(e), extra = [];
          if (evOf(e.type).opinion) {
            if (+dd.dueAt) extra.push('截止 ' + tsDay(dd.dueAt));
            if (+dd.submitAt) extra.push('已交 ' + tsDay(dd.submitAt));
          }
          if (e.type === 'submitted' && dd.venue) extra.push(dd.venue);
          if (e.type === 'accept' && +dd.publishAt) extra.push('见刊 ' + tsDay(dd.publishAt));
          if (dd.doi) extra.push('DOI ' + dd.doi);
          lines.push('- ' + tsDay(evAt(e)) + ' ' + evName(e) + (extra.length ? '（' + extra.join('，') + '）' : ''));
        });
        lines.push('');
      });
    });
    return lines.join('\n');
  }
  function showExport() {
    var old = $('paperExportOverlay');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var ov = document.createElement('div');
    ov.className = 'overlay modal';
    ov.id = 'paperExportOverlay';
    ov.innerHTML = '<div class="overlay-card item-card">' +
      '<button class="close" id="ppExpClose" title="关闭">✕</button>' +
      '<h3 class="it-title">导出 Markdown</h3>' +
      '<p class="col-sub">全选（Ctrl+A）复制走就行。</p>' +
      '<textarea class="pp-export" id="ppExpText" rows="16" readonly></textarea></div>';
    document.body.appendChild(ov);
    var ta = $('ppExpText');
    if (ta) { ta.value = exportMarkdown(); try { ta.focus(); ta.select(); } catch (e) { } }
    if ($('ppExpClose')) $('ppExpClose').addEventListener('click', function () { if (ov.parentNode) ov.parentNode.removeChild(ov); });
    ov.addEventListener('click', function (e) { if (e.target === ov && ov.parentNode) ov.parentNode.removeChild(ov); });
  }

  /* ------------------------------------------------------------ 两块切换 */
  function switchTo(which) {
    var btns = document.querySelectorAll('#arxivSwitch .psw-btn');
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('on', btns[i].dataset.psw === which);
    var cols = document.querySelectorAll('#pageArxiv > section.arxiv-col');
    for (var j = 0; j < cols.length; j++) cols[j].hidden = (which !== 'arxiv');
    if ($('paperPane')) $('paperPane').hidden = (which !== 'papers');
    if (which === 'papers') render();
  }

  /* ------------------------------------------------------------ 事件绑定 */
  function bind() {
    if ($('arxivSwitch')) {
      $('arxivSwitch').addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('.psw-btn') : null;
        if (b) switchTo(b.dataset.psw);
      });
    }
    if ($('btnPaperAdd')) $('btnPaperAdd').addEventListener('click', function () { openModal(null); });
    if ($('btnPaperExport')) {
      $('btnPaperExport').addEventListener('click', function () {
        if (!papers.length) { flash('还没有记录可导出'); return; }
        showExport();
      });
    }
    if ($('ppModePrep')) $('ppModePrep').addEventListener('click', function () { paintMode('preparing'); });
    if ($('ppModeSub')) $('ppModeSub').addEventListener('click', function () { paintMode('submitted'); });
    if ($('paperFilter')) {
      $('paperFilter').addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('[data-pf]') : null;
        if (!b) return;
        filter = b.dataset.pf;
        render();
      });
    }
    var list = $('paperList');
    if (list) {
      list.addEventListener('click', function (e) {
        var item = e.target.closest ? e.target.closest('.paper-item') : null;
        if (!item) return;
        var pid = item.dataset.id;
        var hit = e.target.closest ? e.target.closest('[data-role]') : null;
        if (hit) {
          var what = hit.dataset.role;
          var evRow = hit.closest('.pp-ev');
          var eid = evRow ? evRow.dataset.ev : '';
          if (what === 'evdel') { delEvent(pid, eid); return; }
          if (what === 'evdetail') { openDetail(pid, eid); return; }
          if (what === 'timeline') { showTimeline(pid); return; }
          if (what === 'edit') { openModal(pid); return; }
          if (what === 'del') {
            var p = byId(pid);
            if (!p) return;
            if (!window.confirm('删除「' + (p.title || '') + '」这篇论文？\n' +
              '它下面 ' + ((p.events || []).length) + ' 条状态会一起删掉。\n（删了可以用下面的「撤销」找回）')) return;
            var idx = papers.indexOf(p);
            papers = papers.filter(function (x) { return x.id !== pid; });
            if (openedId === pid) openedId = null;
            save(); render();
            flash('已删除「' + (p.title || '') + '」', function () {
              papers.splice(idx < 0 ? 0 : idx, 0, p);
              openedId = p.id;
              save(); render();
              flash('已找回「' + (p.title || '') + '」');
            });
            return;
          }
          return;
        }
        if (e.target.closest && e.target.closest('button, input, textarea, select')) return;
        openedId = (openedId === pid) ? null : pid;
        render();
      });
      list.addEventListener('click', function (e) {
        if (!e.target || e.target.id !== 'ppEvAdd') return;
        var item = e.target.closest('.paper-item');
        if (item) addEvent(item.dataset.id);
      });
      list.addEventListener('change', function (e) {
        if (e.target && e.target.id === 'ppEvType') addType = e.target.value;
      });
    }
    if ($('paperSave')) $('paperSave').addEventListener('click', saveModal);
    if ($('paperCancel')) $('paperCancel').addEventListener('click', closeModal);
    if ($('paperClose')) $('paperClose').addEventListener('click', closeModal);
    var ov = $('paperOverlay');
    if (ov) {
      ov.addEventListener('click', function (e) { if (e.target === ov) closeModal(); });
      ov.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); closeModal(); } });
    }
  }

  window.PAPERS = {
    open: function () { if ($('paperPane')) { render(); syncMemos(); } },
    _data: function () { return papers; },
    _stats: function () { return stats(); },
    _status: function (p) { return statusOfPaper(p); },
    _activeDue: function (p) { return activeDue(p); },
    _waiting: function (p) { return waitingRounds(p).length; },
    _meta: function (p) { return paperMeta(p); },
    /* 供自检用：手动触发一次同步，返回同步后备忘条数（验幂等） */
    _sync: function () { syncMemos(); return window.KUNKUN_MEMOS ? window.KUNKUN_MEMOS.list().length : -1; },
    _live: function (p) { return liveDeadlines(p); }
  };

  function boot() {
    if (!$('paperPane')) return;
    load();
    bind();
    render();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
