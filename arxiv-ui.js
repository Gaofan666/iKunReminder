/* =========================================================================
   arxiv-ui.js —— 「科研动态」页的界面逻辑
   -------------------------------------------------------------------------
   只做两件事：把主进程推来的状态画出来、把用户的改动传回去。
   抓取、解析、存库全在主进程（arxiv.js / arxiv-db.js / arxiv-service.js），
   所以这一页永远不会因为网络慢而卡住。

   和 skin-picker.js 一个路子：由 app.js 注入 native 桥和「切页」回调，
   自己不去认识 Electron。
   ========================================================================= */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.kunkunArxivUI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var native = null;
  var hooks = {};
  var st = null;                       // 主进程推来的状态
  var listData = { items: [], total: 0 };
  var filter = 'all';
  var onlyKw = true;                   // 列表默认只看「命中当前关键词」的论文
  var inited = false;
  var busyLocal = false;               // 本地「刚点了抓取」的标记，等状态回来清掉
  var lastMsg = '';

  var el = {};
  function $(id) { return document.getElementById(id); }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  /* ------------------------------------------------------------ 小工具 */
  function fmtWhen(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function fmtAgo(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var m = Math.round((Date.now() - d.getTime()) / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return m + ' 分钟前';
    if (m < 60 * 24) return Math.round(m / 60) + ' 小时前';
    return Math.round(m / 1440) + ' 天前';
  }
  function fmtNext(ms) {
    var m = Math.round((ms - Date.now()) / 60000);
    if (m <= 0) return '马上';
    if (m < 60) return m + ' 分钟后';
    if (m < 60 * 24) return Math.round(m / 60) + ' 小时后';
    return Math.round(m / 1440) + ' 天后';
  }
  function fmtAuthors(a) {
    a = a || [];
    if (!a.length) return '作者未知';
    return a.slice(0, 3).join('、') + (a.length > 3 ? ' 等 ' + a.length + ' 人' : '');
  }
  function clip(s, n) {
    var t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return t.length > n ? (t.slice(0, n) + '…') : t;
  }
  function mkBtn(label, cls, fn) {
    var b = document.createElement('button');
    b.className = 'btn sm' + (cls ? ' ' + cls : '');
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  }
  function setVal(node, v) {
    if (!node || document.activeElement === node) return;   // 正在输入时别被覆盖
    if (String(node.value) !== String(v)) node.value = String(v);
  }
  function setChk(node, v) { if (node && node.checked !== !!v) node.checked = !!v; }
  function hasCjk(s) { return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(String(s || '')); }

  /* ---------------------------------------------------- 命中关键词的显示
     两件事：标题里把命中的关键词标色；摘要只挑「含关键词的那几句」。 */
  function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  /* 这篇论文的 matched（抓的时候记下来的）里，哪些真的出现在这段文字里 */
  function hitsIn(text, keywords) {
    const low = String(text == null ? '' : text).toLowerCase();
    return (keywords || []).filter(function (k) {
      const kk = String(k || '').trim();
      return kk && low.indexOf(kk.toLowerCase()) >= 0;
    });
  }

  /* 把文字写进节点，命中的关键词套 <mark>（不用 innerHTML，全部走 DOM 节点） */
  function fillHighlighted(node, text, keywords) {
    const t = String(text == null ? '' : text);
    node.textContent = '';
    const kws = (keywords || []).map(function (k) { return String(k || '').trim(); })
      .filter(Boolean)
      .sort(function (a, b) { return b.length - a.length; });   // 长的先匹配，免得被短的切碎
    if (!kws.length) { node.textContent = t; return 0; }
    let re;
    try { re = new RegExp('(' + kws.map(escRe).join('|') + ')', 'gi'); }
    catch (e) { node.textContent = t; return 0; }
    let last = 0, m, n = 0;
    while ((m = re.exec(t))) {
      if (m.index > last) node.appendChild(document.createTextNode(t.slice(last, m.index)));
      const mk = document.createElement('mark');
      mk.className = 'ax-hit';
      mk.textContent = m[0];
      node.appendChild(mk);
      last = m.index + m[0].length;
      n++;
      if (re.lastIndex <= m.index) re.lastIndex = m.index + 1;   // 防死循环
    }
    if (last < t.length) node.appendChild(document.createTextNode(t.slice(last)));
    return n;
  }

  /* 摘要切成句子（英文句号/问号/感叹号，也认中文标点） */
  function splitSentences(s) {
    return String(s == null ? '' : s)
      .split(/(?<=[.!?。！？])\s+/)
      .map(function (x) { return x.trim(); })
      .filter(Boolean);
  }

  /* 摘要怎么显示：优先只给「含关键词的那几句」（这才是有用的部分），
     一句都没命中（比如是分类/作者字段命中的）就退回摘要开头那几句。
     最多 3 句 / 400 字，避免一篇把列表撑太长。
     before/after 用来在首尾加「…」，让用户知道这是摘要里摘出来的一段。 */
  function pickAbstract(summary, keywords) {
    const text = String(summary == null ? '' : summary).trim();
    if (!text) return { text: '', before: false, after: false, hit: false };
    const sents = splitSentences(text);
    if (!sents.length) {
      return { text: text.slice(0, 400), before: false, after: text.length > 400, hit: false };
    }
    const hitSents = sents.filter(function (s) { return hitsIn(s, keywords).length > 0; });
    const useHit = hitSents.length > 0;
    const pool = useHit ? hitSents : sents;
    const picked = pool.slice(0, 3);
    const before = useHit && sents.indexOf(picked[0]) > 0;
    const after = pool.length > picked.length;
    let out = picked.join(' ');
    let clipped = false;
    if (out.length > 400) { out = out.slice(0, 400); clipped = true; }
    return { text: out, before: before, after: after || clipped, hit: useHit };
  }

  /* ------------------------------------------------------ 右侧：条件表单 */
  function renderFields() {
    if (!el.fields) return;
    if (!el.fields.childNodes.length && st && st.fields) {
      st.fields.forEach(function (f) {
        var lab = document.createElement('label');
        lab.className = 'ax-field';
        lab.title = f.hint || '';
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = f.id;
        cb.addEventListener('change', function () {
          var picked = [];
          el.fields.querySelectorAll('input').forEach(function (x) { if (x.checked) picked.push(x.value); });
          if (!picked.length) { cb.checked = true; note('至少要留一个搜索字段', 'bad'); return; }
          save({ fields: picked }, '搜索字段已更新');
        });
        var name = document.createElement('span');
        name.textContent = f.label;
        lab.appendChild(cb);
        lab.appendChild(name);
        el.fields.appendChild(lab);
      });
    }
    var cfg = (st && st.config) || {};
    var cur = cfg.fields || [];
    if (el.fields) {
      el.fields.querySelectorAll('input').forEach(function (x) { x.checked = cur.indexOf(x.value) >= 0; });
    }
  }

  function renderChips() {
    if (!el.chips) return;
    var cfg = (st && st.config) || {};
    var kws = cfg.keywords || [];
    el.chips.innerHTML = '';
    if (!kws.length) {
      var none = document.createElement('span');
      none.className = 'ax-chip none';
      none.textContent = '还没有关键词';
      el.chips.appendChild(none);
    }
    kws.forEach(function (k) {
      var chip = document.createElement('span');
      chip.className = 'ax-chip';
      var txt = document.createElement('span');
      txt.textContent = k;
      var del = document.createElement('button');
      del.type = 'button';
      del.title = '删掉这个关键词';
      del.textContent = '✕';
      del.addEventListener('click', function () {
        var next = kws.filter(function (x) { return x !== k; });
        save({ keywords: next }, '已删掉关键词「' + k + '」');
      });
      chip.appendChild(txt);
      chip.appendChild(del);
      el.chips.appendChild(chip);
    });
    if (el.kwCount) el.kwCount.textContent = kws.length + ' / ' + ((st && st.maxKeywords) || 5);
  }

  function note(msg) {
    lastMsg = msg || '';
    renderStatus();
  }
  function kwNote(msg, bad) {
    if (!el.kwHint) return;
    el.kwHint.dataset.kw = '1';
    el.kwHint.className = 'ax-hint' + (bad ? ' bad' : (msg ? ' ok' : ''));
    el.kwHint.textContent = msg || '';
  }

  function renderMatch() {
    var cfg = (st && st.config) || {};
    var any = cfg.matchAny !== false;
    if (el.match) {
      el.match.querySelectorAll('button').forEach(function (b) {
        b.classList.toggle('on', (b.dataset.m === 'any') === any);
      });
    }
    if (el.matchHint) {
      el.matchHint.textContent = any
        ? '任一条件：所有关键词 × 所有字段平铺开，全部用 OR 连接 —— 沾到任意一个就收进来（结果多、更宽松）。'
        : '全部条件：按关键词分组，组内字段 OR、组间 AND —— 每个关键词都得命中（结果少、更精准）。';
    }
  }

  /* 关键词多了之后「关键词 × 字段」会变成几十段条件，查询串很长、arXiv 会慢甚至查不动。
     这里只是提醒，不拦着用户 —— 上限本身是 10 个关键词（DB 那边卡的）。 */
  function renderWidthHint() {
    if (!el.widthHint) return;
    const c = (st && st.config) || {};
    const kw = (c.keywords || []).length, fd = (c.fields || []).length;
    const n = kw * fd;
    let text = '', bad = false;
    if (n > 40) {
      text = '⚠ 现在是 ' + kw + ' 个关键词 × ' + fd + ' 个字段 = ' + n +
        ' 段条件，查询串很长，arXiv 可能会很慢或者查不动 —— 建议少勾几个字段。';
      bad = true;
    } else if (n > 24) {
      text = '当前条件偏宽（' + kw + ' 个关键词 × ' + fd + ' 个字段 = ' + n + ' 段），结果会比较多。';
    }
    el.widthHint.hidden = !text;
    el.widthHint.className = 'ax-hint' + (bad ? ' bad' : '');
    el.widthHint.textContent = text;
  }

  function renderStatus() {
    if (!el.status) return;
    if (!st || !st.config) {
      el.status.textContent = '科研动态在当前环境不可用（本地数据库没起来）。';
      return;
    }
    var c = st.config;
    var parts = [];
    if (!c.keywords.length) parts.push('还没设置关键词 —— 在右边加几个英文关键词就会自动开始抓');
    else if (!c.enabled) parts.push('自动抓取已关闭（还能手动抓）');
    if (st.running || busyLocal) parts.push('正在抓取…');
    if (c.lastOkAt) parts.push('上次抓取 ' + fmtAgo(new Date(c.lastOkAt).toISOString()) + '，新增 ' + (c.lastCount || 0) + ' 篇');
    else if (c.lastFetchAt) parts.push('上次尝试 ' + fmtAgo(new Date(c.lastFetchAt).toISOString()));
    if (c.keywords.length && c.enabled && st.nextAt) parts.push('下次自动抓取 ' + fmtNext(st.nextAt));
    if (c.lastError) parts.push('⚠ ' + c.lastError);
    if (lastMsg) parts.push(lastMsg);
    el.status.textContent = parts.join('　·　');
  }

  function renderQuery() {
    if (!el.query) return;
    el.query.textContent = (st && st.query) ? st.query : '（先把关键词加上，这里会显示拼好的查询串）';
  }

  function render() {
    renderChips();
    renderFields();
    renderMatch();
    renderWidthHint();
    renderStatus();
    renderQuery();
    var c = (st && st.config) || {};
    setChk(el.enabled, c.enabled !== false);
    setVal(el.days, c.days == null ? 7 : c.days);
    setVal(el.cap, c.pushCap == null ? 5 : c.pushCap);
    setVal(el.max, c.maxResults == null ? 30 : c.maxResults);
    if (el.interval && c.intervalH != null) {
      var want = String(c.intervalH);
      var has = false;
      for (var i = 0; i < el.interval.options.length; i++) if (el.interval.options[i].value === want) has = true;
      if (!has) {   /* 老配置里的值不在下拉里（比如 48），临时塞一个进去，别让用户看到错的值 */
        var o = document.createElement('option');
        o.value = want;
        o.textContent = '每 ' + want + ' 小时';
        el.interval.appendChild(o);
      }
      setVal(el.interval, want);
    }
    setBadge((st && st.unread) || 0);
  }

  /* ------------------------------------------------------- 左侧：论文列表 */
  function setBadge(n) {
    var b = document.getElementById('arxivBadge');
    if (!b) return;
    if (n > 0) { b.hidden = false; b.textContent = n > 99 ? '99+' : String(n); }
    else { b.hidden = true; b.textContent = ''; }
  }

  function openUrl(url) {
    if (!url || !native || !native.arxivOpen) return;
    native.arxivOpen(url);
  }
  function openPaper(p) {
    if (native && native.arxivMarkRead && !p.read) native.arxivMarkRead(p.arxivId);
    openUrl(p.pdfUrl || p.absUrl);
    p.read = true;
    setTimeout(refresh, 400);
  }

  function paperNode(p) {
    var it = document.createElement('div');
    it.className = 'arxiv-item' + (p.read ? ' done' : (p.pushed ? ' unread' : ''));

    /* 标色用这篇论文自己记录的命中关键词（抓的时候算好的）；
       老数据没有就退回当前设置里的关键词 */
    var kws = (p.matched && p.matched.length) ? p.matched : ((st && st.config && st.config.keywords) || []);

    var t = document.createElement('div');
    t.className = 'arxiv-title';
    fillHighlighted(t, p.title || '(无标题)', kws);
    t.title = '点一下用浏览器打开 PDF 原文';
    t.addEventListener('click', function () { openPaper(p); });
    it.appendChild(t);

    var meta = document.createElement('div');
    meta.className = 'arxiv-meta';
    var add = function (txt, cls) {
      var s = document.createElement('span');
      if (cls) s.className = cls;
      s.textContent = txt;
      meta.appendChild(s);
    };
    add(fmtWhen(p.published) || '时间未知');
    add(fmtAgo(p.published));
    if (p.primary) add(p.primary, 'ax-cat');
    add('arXiv:' + p.arxivId);
    it.appendChild(meta);

    var au = document.createElement('div');
    au.className = 'arxiv-meta';
    var aus = document.createElement('span');
    aus.textContent = fmtAuthors(p.authors);
    au.appendChild(aus);
    it.appendChild(au);

    var ab = document.createElement('div');
    ab.className = 'arxiv-abs';
    /* 真正出现在这篇文字里的关键词：标色和「命中」都用它（不虚报） */
    var realHits = hitsIn(String(p.title || '') + ' ' + String(p.summary || ''), kws);
    var pick = pickAbstract(p.summary, realHits);
    if (pick.text) {
      if (pick.before) ab.appendChild(document.createTextNode(pick.hit ? '…（摘要里命中关键词的句子）' : '…'));
      fillHighlighted(ab, pick.text, realHits);
      if (pick.after) ab.appendChild(document.createTextNode('…'));
    }
    it.appendChild(ab);

    if (realHits.length) {
      var hit = document.createElement('div');
      hit.className = 'arxiv-hit';
      hit.textContent = '命中：' + realHits.join(' / ');
      it.appendChild(hit);
    }

    var btns = document.createElement('div');
    btns.className = 'arxiv-btns';
    btns.appendChild(mkBtn('📄 打开 PDF', 'primary', function () { openPaper(p); }));
    btns.appendChild(mkBtn('🔗 arXiv 页面', '', function () { openUrl(p.absUrl); }));
    btns.appendChild(mkBtn(p.star ? '★ 已收藏' : '☆ 收藏', '', function () {
      if (native.arxivStar) native.arxivStar(p.arxivId, !p.star).then(function () { p.star = !p.star; refresh(); });
    }));
    if (!p.read) {
      btns.appendChild(mkBtn('标为已读', '', function () {
        if (native.arxivMarkRead) native.arxivMarkRead(p.arxivId).then(function () { p.read = true; refresh(); });
      }));
    }
    btns.appendChild(mkBtn('删掉这条', '', function () {
      if (native.arxivRemove) native.arxivRemove(p.arxivId).then(refresh);
    }));
    it.appendChild(btns);
    return it;
  }

  function renderList() {
    if (!el.list) return;
    el.list.innerHTML = '';
    var items = listData.items || [];
    if (!items.length) {
      var d = document.createElement('div');
      d.className = 'arxiv-empty';
      var cfg = (st && st.config) || {};
      if (!cfg.keywords || !cfg.keywords.length) {
        d.textContent = '还没设置关键词。\n\n右边加几个英文关键词（比如 graph neural network），' +
          '程序就会按你设的频率自己去 arXiv 找，找到了让宠物来告诉你。';
      } else if (filter === 'unread') {
        d.textContent = '没有未读的论文了。';
      } else if (filter === 'star') {
        d.textContent = '还没收藏过论文。看到喜欢的点「☆ 收藏」。';
      } else {
        d.textContent = '还没有论文。\n\n点右上角「↻ 立即抓取」试试（联网状态下几秒钟就有结果）。';
      }
      el.list.appendChild(d);
      return;
    }
    items.forEach(function (p) { el.list.appendChild(paperNode(p)); });
  }

  function refresh() {
    if (!native || !native.arxivList) return Promise.resolve();
    /* onlyKw 打开时只列「命中当前关键词」的论文：换了关键词再抓，
       列表就只显示这一轮的结果（不然会看到上一轮那批，像没生效一样） */
    const kw = (onlyKw && st && st.config) ? (st.config.keywords || []) : [];
    return native.arxivList({ filter: filter, limit: 60, matchKeywords: kw }).then(function (res) {
      listData = res || { items: [], total: 0 };
      renderList();
    }).catch(function () { renderList(); });
  }

  function save(patch, msg) {
    if (!native || !native.arxivSetConfig) return Promise.resolve();
    return native.arxivSetConfig(patch).then(function (cfg) {
      if (cfg && st) st.config = cfg;
      render();
      if (msg) note(msg);
      refresh();
      return cfg;
    }).catch(function () { note('⚠ 保存失败，再试一次'); });
  }

  /* ---------------------------------------------------------------- 事件 */
  function buildStatic() {
    /* 字段勾选框依赖 st.fields，第一次拿到状态后由 renderFields() 建 */
  }

  function bind() {
    if (el.kwAdd) {
      el.kwAdd.addEventListener('click', addKeyword);
    }
    if (el.kwInput) {
      el.kwInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); addKeyword(); }
      });
    }
    if (el.match) {
      el.match.querySelectorAll('button').forEach(function (b) {
        b.addEventListener('click', function () {
          save({ matchAny: b.dataset.m === 'any' }, b.dataset.m === 'any' ? '已设为「任一条件」' : '已设为「全部条件」');
        });
      });
    }
    if (el.enabled) {
      el.enabled.addEventListener('change', function (e) {
        save({ enabled: e.target.checked }, e.target.checked ? '自动抓取已开启' : '自动抓取已关闭');
      });
    }
    if (el.days) el.days.addEventListener('change', function (e) { save({ days: e.target.value }); });
    if (el.interval) el.interval.addEventListener('change', function (e) { save({ intervalH: e.target.value }); });
    if (el.cap) el.cap.addEventListener('change', function (e) { save({ pushCap: e.target.value }); });
    if (el.max) el.max.addEventListener('change', function (e) { save({ maxResults: e.target.value }); });

    if (el.fetchBtn) {
      el.fetchBtn.addEventListener('click', function () {
        if (busyLocal) return;
        busyLocal = true;
        lastMsg = '正在抓取…';
        renderStatus();
        native.arxivFetchNow().then(function (r) {
          busyLocal = false;
          if (r && r.ok) {
            lastMsg = '抓取完成：arXiv 命中 ' + r.total + ' 篇，这一页拿到 ' + r.got +
              ' 篇，其中新的 ' + r.added + ' 篇，推送 ' + r.pushed + ' 篇（用了 ' + Math.round((r.ms || 0) / 100) / 10 + ' 秒）';
          } else {
            lastMsg = '⚠ ' + ((r && (r.error || r.skipped)) || '抓取没成功');
          }
          renderStatus();
          refresh();
        }).catch(function (e) {
          busyLocal = false;
          lastMsg = '⚠ 抓取失败：' + String((e && e.message) || e);
          renderStatus();
        });
      });
    }
    if (el.readAll) {
      el.readAll.addEventListener('click', function () {
        native.arxivMarkAllRead().then(function (n) {
          note(n ? '已把 ' + n + ' 篇标为已读' : '本来就没有未读的');
          refresh();
        });
      });
    }
    if (el.clearAll) {
      el.clearAll.addEventListener('click', function () {
        if (!window.confirm('清空本地已抓到的论文？\n（只是清空列表和去重记录，设置和关键词都留着；清空后下次抓到会被当成新的）')) return;
        native.arxivClear().then(function () { note('列表已清空'); refresh(); });
      });
    }
    if (el.filter) {
      el.filter.querySelectorAll('.ax-tab').forEach(function (b) {
        b.addEventListener('click', function () {
          filter = b.dataset.af || 'all';
          el.filter.querySelectorAll('.ax-tab').forEach(function (x) { x.classList.toggle('on', x === b); });
          refresh();
        });
      });
    }
    if (el.onlyKw) {
      el.onlyKw.checked = onlyKw;
      el.onlyKw.addEventListener('change', function (e) {
        onlyKw = !!e.target.checked;
        note(onlyKw ? '只显示命中当前关键词的论文' : '显示所有抓过的论文');
        refresh();
      });
    }
  }

  function addKeyword() {
    if (!el.kwInput) return;
    var raw = String(el.kwInput.value || '').trim();
    if (!raw) return;
    var parts = raw.split(/[,，;；\n]+/).map(function (s) { return s.replace(/\s+/g, ' ').trim(); }).filter(Boolean);
    var bad = parts.filter(hasCjk);
    if (bad.length) {
      kwNote('⚠ arXiv 是美国英文库，中文基本搜不到东西，请换成英文（比如 graph neural network）。', true);
      return;
    }
    var cur = ((st && st.config && st.config.keywords) || []).slice();
    var max = (st && st.maxKeywords) || 5;
    var added = 0, dup = 0, over = 0;
    parts.forEach(function (k) {
      if (cur.some(function (x) { return x.toLowerCase() === k.toLowerCase(); })) { dup++; return; }
      if (cur.length >= max) { over++; return; }
      cur.push(k);
      added++;
    });
    el.kwInput.value = '';
    if (!added) {
      kwNote(over ? ('⚠ 最多 ' + max + ' 个关键词（arXiv 查询串太长会失败），先删一个再加') : '⚠ 这个词已经在列表里了', true);
      return;
    }
    kwNote('已添加 ' + added + ' 个；加完 8 秒左右会自动去抓一次' + (dup ? '（' + dup + ' 个重复，跳过了）' : '') +
      (over ? '（' + over + ' 个超上限，没加）' : ''), false);
    save({ keywords: cur });
  }

  /* ---------------------------------------------------------------- 对外 */
  function init(nativeBridge, h) {
    if (inited) return;
    native = nativeBridge || null;
    hooks = h || {};
    if (!native || !native.arxivState) return;

    el = {
      list: $('arxivList'),
      status: $('arxivStatus'),
      chips: $('axChips'),
      kwCount: $('axKwCount'),
      kwInput: $('axKwInput'),
      kwAdd: $('axKwAdd'),
      kwHint: $('axKwHint'),
      fields: $('axFields'),
      widthHint: $('axWidthHint'),
      match: $('axMatch'),
      matchHint: $('axMatchHint'),
      enabled: $('axEnabled'),
      days: $('axDays'),
      interval: $('axInterval'),
      cap: $('axCap'),
      max: $('axMax'),
      query: $('axQuery'),
      fetchBtn: $('btnArxivFetch'),
      readAll: $('btnArxivReadAll'),
      clearAll: $('axClearAll'),
      filter: $('arxivFilter'),
      onlyKw: $('axOnlyKw')
    };
    if (!el.list) return;
    inited = true;
    bind();
    if (native.onArxivState) native.onArxivState(function (s) {
      /* 主进程每次抓取完都会推一次状态。这里要盯住「是不是刚抓完」：
         抓取可能是自动跑起来的（到点了 / 刚改完条件），那种情况没人会去调
         refresh()，列表就会一直停在上一次的内容 ——
         用户报过「点了立即抓取，宠物弹窗提示了但科研界面没显示，
         点了气泡才有」。所以只要这一轮跑完、或者库里条数变了，就自己把列表重拉一遍。 */
      const was = st;
      st = s;
      if (busyLocal && st && !st.running) busyLocal = false;
      render();
      const finished = !!was && was.running && st && !st.running;
      const resultChanged = !!(st && st.lastResult) &&
        (!was || !was.lastResult || was.lastResult.at !== st.lastResult.at);
      const totalChanged = !!was && !!st && was.total !== st.total;
      if (finished || resultChanged || totalChanged) refresh();
      else renderList();
    });
    native.arxivState().then(function (s) { st = s; render(); }).catch(function () { render(); });
    refresh();
  }

  /* 切到科研动态页时调一次：刷新列表（顺便把红点消掉） */
  function open() {
    if (!inited) return;
    render();
    refresh();
    if (native && native.arxivState) {
      native.arxivState().then(function (s) { st = s; render(); renderList(); }).catch(function () { });
    }
  }

  return {
    init: init,
    open: open,
    refresh: refresh,
    setBadge: setBadge,
    /* 自检用：把当前状态和列表拿出去看 */
    _debug: function () {
      return {
        inited: inited,
        config: (st && st.config) || null,
        query: (st && st.query) || '',
        unread: (st && st.unread) || 0,
        filter: filter,
        listCount: (listData.items || []).length,
        firstTitle: ((listData.items || [])[0] || {}).title || '',
        status: el.status ? el.status.textContent : ''
      };
    }
  };
});
