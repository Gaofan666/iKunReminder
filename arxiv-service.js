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

/* 手动抓取的冷却：刚抓过就别再打 arXiv 了（官方建议间隔 ≥3 秒，这里更保守） */
const MANUAL_COOLDOWN_MS = 60 * 1000;
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

  /* ------------------------------------------------------------- 跑一轮抓取 */
  async function runFetch(reason) {
    const r = reason || '手动';
    if (running) return { ok: false, skipped: '正在抓取中' };
    const c = cfgNow();
    if (!c.keywords.length) {
      try { db.setConfig({ lastError: '还没设置关键词' }); } catch (e) { }
      lastResult = { ok: false, at: now(), reason: r, error: '还没设置关键词' };
      pushState();
      return { ok: false, error: '还没设置关键词' };
    }
    if (!c.enabled && r !== '手动') return { ok: false, skipped: '已关闭自动抓取' };
    if (r === '手动' && c.lastFetchAt && (now() - c.lastFetchAt) < MANUAL_COOLDOWN_MS) {
      return { ok: false, skipped: '刚抓过，等一下再点' };
    }

    running = true;
    pushState();                      // 界面/宠物据此显示「正在阅读文献…」
    const t0 = now();
    try {
      const res = await ARXIV.arxivFetch(c, {
        fetchImpl: fetchImpl,
        maxResults: c.maxResults,
        retries: 2
      });
      const entries = res.parsed.entries || [];
      const ins = db.addPapers(entries, { matchedFor: function (p) { return matchedFor(p, c.keywords); } });
      const fresh = entries.filter(function (p) { return ins.ids.indexOf(p.arxivId) >= 0; });

      let pushed = [];
      if (fresh.length) {
        pushed = fresh.slice(0, Math.max(1, c.pushCap));       // 一次最多推 N 条，避免信息过载
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

      db.setConfig({ lastFetchAt: now(), lastOkAt: now(), lastCount: ins.added, lastError: '' });
      lastResult = {
        ok: true, at: now(), reason: r, ms: now() - t0,
        total: res.parsed.total, got: entries.length, added: ins.added,
        pushed: pushed.length, query: res.query, tries: res.tries
      };
      log('arxiv-fetch-ok', {
        reason: r, 用时ms: now() - t0, 命中总数: res.parsed.total,
        这一页拿到: entries.length, 其中新的: ins.added, 推送: pushed.length
      });
      return lastResult;
    } catch (e) {
      const msg = String((e && e.message) || e);
      /* 退出程序时数据库可能已经关了，这里的写入失败只记日志，别再抛出去 */
      try { db.setConfig({ lastFetchAt: now(), lastError: msg }); } catch (e2) { }
      lastResult = { ok: false, at: now(), reason: r, error: msg, ms: now() - t0 };
      log('arxiv-fetch-fail', { reason: r, error: msg });
      return lastResult;
    } finally {
      running = false;
      try { const n = db.prune(); if (n) log('arxiv-pruned', { 删了: n }); } catch (e) { }
      try { armTimer(); } catch (e) { }
      try { pushState(); } catch (e) { }
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
