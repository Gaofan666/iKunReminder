/* =========================================================================
   arxiv-service.js —— 科研动态的「跑腿的」：定时、抓取、去重、推送
   -------------------------------------------------------------------------
   它把 arxiv.js（查询+抓取）和 arxiv-db.js（存库）串起来：
     定时到点 / 用户点「立即抓取」/ 启动补抓
       → 抓 arXiv → 入库（arXiv ID 去重）→ 有新的就按上限推送给用户
   推送怎么送由外部注入（main.js 里送成：宠物气泡 + 托盘气泡 + 标签页红点）。

   刻意做成「注入依赖」的小工厂：自检时可以直接喂假的 fetch / 假的通知函数，
   不碰网络也能把「去重、上限、调度、错误处理」这些逻辑跑一遍。
   ========================================================================= */
'use strict';

const ARXIV = require('./arxiv');
const DB = require('./arxiv-db');

/* 手动抓取的冷却：刚抓过就别再打 arXiv 了（官方建议间隔 ≥3 秒，这里更保守）。
   自动抓取正在跑的时候点「立即抓取」不算冷却 —— 那一下会等这一轮跑完并把结果给界面。 */
const MANUAL_COOLDOWN_MS = 20 * 1000;
const STARTUP_DELAY_MS = 15 * 1000;     // 启动补抓：等界面起来、别和启动抢资源
const NEW_KEYWORD_DELAY_MS = 8 * 1000;  // 刚加完关键词：稍等一下就去抓一次
const MIN_TIMER_MS = 30 * 1000;         // 定时器最短间隔（自检时可以把 intervalH 设很小）

function createArxivService(opts) {
  const o = opts || {};
  const db = o.db;
  const fetchImpl = o.fetchImpl;
  const notify = o.notify || function () { };
  const broadcast = o.broadcast || function () { };
  const log = o.log || function () { };
  const now = o.now || function () { return Date.now(); };

  let timer = null;
  let running = false;
  let inflight = null;              // 正在跑的那一轮抓取（手动点撞上时复用它，别丢结果）
  let lastResult = null;
  let startedAt = now();
  let lastPushAt = 0;

  function cfgNow() { return db.getConfig(); }

  /* 下一次该在什么时候抓（0 = 没开或没关键词，不排期） */
  function nextRunAt(cfg) {
    const c = cfg || cfgNow();
    if (!c.enabled || !c.keywords.length) return 0;
    const base = c.lastFetchAt || startedAt;
    return base + Math.max(1, c.intervalH) * 3600 * 1000;
  }

  /* 给界面看的完整状态（配置 + 计数 + 下次抓取时间 + 当前查询串） */
  function state() {
    const c = cfgNow();
    return {
      config: c,
      unread: db.unreadCount(),
      total: db.totalCount(),
      lastPush: db.lastPush(),
      running: running,
      lastResult: lastResult,
      nextAt: nextRunAt(c),
      maxKeywords: DB.MAX_KEYWORDS,
      fields: ARXIV.FIELDS,
      query: ARXIV.buildArxivQuery(c)
    };
  }

  function pushState() { try { broadcast(state()); } catch (e) { } }

  /* 这一篇命中了哪些关键词（库里存下来，列表和气泡提示都能用上） */
  function matchedFor(p, keywords) {
    const hay = String(p.title || '') + ' \u0001 ' + String(p.summary || '');
    const low = hay.toLowerCase();
    const hit = keywords.filter(function (k) { return low.indexOf(String(k).toLowerCase()) >= 0; });
    return hit.length ? hit : keywords.slice(0, 1);
  }

  /* 把「会影响查询结果的那几项」拼成一个签名：关键词 / 字段 / 匹配模式 / 天数。
     换过条件之后再点手动抓取，就不该再吃「刚抓过」的冷却了。 */
  function querySig(c) {
    return JSON.stringify([c.keywords || [], c.fields || [], !!c.matchAny, c.days || 0]);
  }

  /* ------------------------------------------------------------- 跑一轮抓取
     两种情况的返回要区分清楚：
       · 已经有别的抓取在跑（比如刚加完关键词，8 秒后自动抓的那一轮）→ 手动点的时候
         不是直接甩一句「正在抓取中」就完了 —— 那样界面拿不到结果、列表不会刷新
         （用户报过：「点了立即抓取，宠物弹窗提示了，科研界面却没显示」）。
         这里改成【等这一轮跑完，把它的结果原样返回】。
       · 冷却期内的重复点击 → 老老实实说还剩几秒。 */
  async function runFetch(reason) {
    const r = reason || '手动';
    if (running) {
      if (inflight) {
        try { return await inflight; } catch (e) {
          return { ok: false, at: now(), reason: r, error: String((e && e.message) || e) };
        }
      }
      return { ok: false, skipped: '正在抓取中' };
    }
    const c = cfgNow();
    if (!c.keywords.length) {
      try { db.setConfig({ lastError: '还没设置关键词' }); } catch (e) { }
      lastResult = { ok: false, at: now(), reason: r, error: '还没设置关键词' };
      pushState();
      return { ok: false, error: '还没设置关键词' };
    }
    if (!c.enabled && r !== '手动') return { ok: false, skipped: '已关闭自动抓取' };
    /* 冷却只针对「条件没变、刚抓过又点一次」；换了关键词/字段/模式/天数 → 放行 */
    if (r === '手动' && c.lastFetchAt && c.lastQuerySig === querySig(c) &&
        (now() - c.lastFetchAt) < MANUAL_COOLDOWN_MS) {
      const left = Math.max(1, Math.ceil((MANUAL_COOLDOWN_MS - (now() - c.lastFetchAt)) / 1000));
      return { ok: false, skipped: '同样的条件刚抓过（' + left + ' 秒前），过一会儿再点' };
    }

    running = true;
    pushState();                      // 界面/宠物据此显示「正在阅读文献…」
    inflight = doFetch(r, c).then(function (res) {
      return res;
    }, function (e) {
      return { ok: false, at: now(), reason: r, error: String((e && e.message) || e) };
    }).then(function (res) {
      /* 收尾：不管成功失败都要做，放在这里（而不是 finally）是为了让
         「撞上来的手动请求」等到这一刻才拿到结果 */
      inflight = null;
      running = false;
      try { const n = db.prune(); if (n) log('arxiv-pruned', { 删了: n }); } catch (e) { }
      try { armTimer(); } catch (e) { }
      try { pushState(); } catch (e) { }
      return res;
    });
    return inflight;
  }

  /* 真正干活的那一轮（查询 → 抓取 → 入库 → 推送 → 记账） */
  async function doFetch(r, c) {
    const t0 = now();
    try {
      /* 一次抓取要多少篇就翻页抓多少篇：
         arXiv 一个请求最多给 2000 条，但一次要太多会很慢、响应也大，
         所以按每页最多 100 条分几次请求（每次之间照样隔 3 秒，这是 arXiv 的要求）。
         用户设「一次最多取回 200 篇」就自动翻 2~3 页，不用自己再点一次。 */
      const want = Math.max(1, Math.round(Number(c.maxResults) || 30));
      const PAGE = 100;
      const MAX_PAGES = 10;
      let got = [];
      let start = 0;
      let pages = 0;
      let total = 0;
      let lastQuery = '';
      let tries = 0;
      while (got.length < want && pages < MAX_PAGES) {
        const size = Math.min(PAGE, want - got.length);
        const res = await ARXIV.arxivFetch(c, {
          fetchImpl: fetchImpl, maxResults: size, start: start, retries: 2
        });
        pages++;
        tries += res.tries || 1;
        total = res.parsed.total || total;
        lastQuery = res.query;
        const batch = res.parsed.entries || [];
        got = got.concat(batch);
        start += batch.length;
        /* 这一页没给满 = 后面没有了，别再翻 */
        if (batch.length < size) break;
        if (total && start >= total) break;
      }
      const entries = got;
      const ins = db.addPapers(entries, { matchedFor: function (p) { return matchedFor(p, c.keywords); } });
      const fresh = entries.filter(function (p) { return ins.ids.indexOf(p.arxivId) >= 0; });

      let pushed = [];
      if (fresh.length) {
        /* 不再限制「一次最多推几篇」—— 用户要的是「直接告诉我一共发现多少篇」。
           通知里给的是【总数】，气泡里只列最前面几条当例子，剩下的点进去看。 */
        pushed = fresh;
        db.markPushed(pushed.map(function (p) { return p.arxivId; }));
        db.logPush(pushed.length, r + ' · 抓到 ' + entries.length + ' 篇，其中新的 ' + fresh.length + ' 篇');
        lastPushAt = now();
        try {
          notify({
            count: pushed.length,
            freshCount: fresh.length,
            reason: r,
            keywords: c.keywords,
            items: pushed.map(function (p) {
              const m = matchedFor(p, c.keywords);
              return {
                arxivId: p.arxivId, title: p.title, authors: p.authors,
                published: p.published, pdfUrl: p.pdfUrl, absUrl: p.absUrl,
                summary: p.summary, matched: m
              };
            })
          });
        } catch (e) { log('arxiv-notify-fail', { message: String((e && e.message) || e) }); }
      }

      db.setConfig({
        lastFetchAt: now(), lastOkAt: now(), lastCount: ins.added, lastError: '',
        lastQuerySig: querySig(c)          // 记下「这一批是用什么条件抓的」
      });
      lastResult = {
        ok: true, at: now(), reason: r, ms: now() - t0,
        total: total, got: entries.length, added: ins.added,
        pushed: pushed.length, query: lastQuery, tries: tries, pages: pages
      };
      log('arxiv-fetch-ok', {
        reason: r, 用时ms: now() - t0, 命中总数: total, 翻了几页: pages,
        拿到: entries.length, 其中新的: ins.added, 推送: pushed.length
      });
      return lastResult;
    } catch (e) {
      const msg = String((e && e.message) || e);
      /* 退出程序时数据库可能已经关了，这里的写入失败只记日志，别再抛出去 */
      try { db.setConfig({ lastFetchAt: now(), lastError: msg }); } catch (e2) { }
      lastResult = { ok: false, at: now(), reason: r, error: msg, ms: now() - t0 };
      log('arxiv-fetch-fail', { reason: r, error: msg });
      return lastResult;
    }
  }

  /* 排下一次定时抓取：按 lastFetchAt + intervalH 算，最短 30 秒后再查一次 */
  function armTimer() {
    if (timer) { clearTimeout(timer); timer = null; }
    const c = cfgNow();
    if (!c.enabled || !c.keywords.length) return;
    const at = nextRunAt(c);
    const delay = Math.max(MIN_TIMER_MS, at - now());
    timer = setTimeout(function () {
      timer = null;
      runFetch('定时').catch(function () { });
      /* 万一没跑成（比如正在抓），过一会儿再排一次，别把定时链断了 */
      setTimeout(function () { armTimer(); }, 5000);
    }, delay);
    if (timer.unref) timer.unref();
  }

  /* 启动补抓：开着软件、上次抓取已经超过一个周期 → 等一会儿补一次 */
  function maybeCatchUp() {
    const c = cfgNow();
    if (!c.enabled || !c.keywords.length) return false;
    if (!c.lastFetchAt) { scheduleSoon(STARTUP_DELAY_MS, '首次抓取'); return true; }
    if (now() - c.lastFetchAt >= Math.max(1, c.intervalH) * 3600 * 1000) {
      scheduleSoon(STARTUP_DELAY_MS, '启动补抓');
      return true;
    }
    return false;
  }

  function scheduleSoon(ms, reason) {
    if (timer) { clearTimeout(timer); timer = null; }
    timer = setTimeout(function () {
      timer = null;
      runFetch(reason || '定时').catch(function () { });
    }, Math.max(1000, ms));
    if (timer.unref) timer.unref();
  }

  /* 界面改了配置：存下来、重排定时；刚加了关键词就顺手去抓一次 */
  function setConfig(patch) {
    const before = cfgNow();
    const after = db.setConfig(patch || {});
    const kwChanged = JSON.stringify(before.keywords) !== JSON.stringify(after.keywords) ||
      JSON.stringify(before.fields) !== JSON.stringify(after.fields) ||
      before.matchAny !== after.matchAny || before.days !== after.days;
    if (!after.enabled || !after.keywords.length) {
      if (timer) { clearTimeout(timer); timer = null; }
    } else if (kwChanged) {
      scheduleSoon(NEW_KEYWORD_DELAY_MS, '设置了新条件');
    } else {
      armTimer();
    }
    pushState();
    return after;
  }

  function dispose() {
    if (timer) { clearTimeout(timer); timer = null; }
  }

  return {
    state: state,
    runFetch: runFetch,
    setConfig: setConfig,
    armTimer: armTimer,
    maybeCatchUp: maybeCatchUp,
    scheduleSoon: scheduleSoon,
    dispose: dispose,
    get running() { return running; },
    get lastPushAt() { return lastPushAt; }
  };
}

module.exports = {
  MANUAL_COOLDOWN_MS: MANUAL_COOLDOWN_MS,
  STARTUP_DELAY_MS: STARTUP_DELAY_MS,
  NEW_KEYWORD_DELAY_MS: NEW_KEYWORD_DELAY_MS,
  createArxivService: createArxivService
};
