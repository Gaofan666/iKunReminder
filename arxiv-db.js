/* =========================================================================
   arxiv-db.js —— 科研动态的本地库（SQLite，用 Electron 内置的 node:sqlite）
   -------------------------------------------------------------------------
   为什么要 SQLite：需求里要「按 arXiv ID 去重」「记录已推送的论文和推送时间」
   「配置持久化」，还要能按提交时间倒序翻页。Electron 44 自带 Node 24，
   node:sqlite 直接可用 —— 不用装 better-sqlite3 那种要编译的原生依赖。

   三张表：
     config    键值对（关键词、字段、匹配模式、频率……都存这儿）
     papers    论文本体，arxiv_id 做主键 = 天然去重
     push_log  每次推送的记录（推了几条、什么时候、为什么）
   ========================================================================= */
'use strict';

const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const ARXIV = require('./arxiv');

const MAX_KEYWORDS = 5;            // 需求：关键词最多 5 个（也防止查询串过长）
const PAPERS_KEEP = 800;           // 库里最多留这么多篇，多了删最老的

/* 默认配置：装了就能用（关键词留空，等用户去界面里加） */
const DEFAULT_CONFIG = {
  enabled: true,
  keywords: [],
  fields: ['ti', 'abs'],
  matchAny: true,          // 任一条件
  days: 7,                 // 只要最近 7 天提交的
  intervalH: 24,           // 每 24 小时抓一次
  maxResults: 30,          // 每次向 arXiv 要几条
  pushCap: 5,              // 每次最多推几条（避免信息过载）
  lastFetchAt: 0,
  lastOkAt: 0,
  lastCount: 0,
  lastError: ''
};

function clampInt(v, lo, hi, dflt) {
  const n = Math.round(Number(v));
  if (!isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

/* 把用户改过的配置收拾干净：类型不对的丢掉、关键词最多 5 个、字段只认白名单 */
function normalizeConfig(patch, base) {
  const cur = Object.assign({}, DEFAULT_CONFIG, base || {});
  const p = patch || {};
  const out = Object.assign({}, cur);

  if (typeof p.enabled === 'boolean') out.enabled = p.enabled;
  if (typeof p.matchAny === 'boolean') out.matchAny = p.matchAny;
  if (Array.isArray(p.keywords)) {
    const seen = {};
    out.keywords = [];
    p.keywords.forEach(function (k) {
      const kw = ARXIV.cleanKeyword(k);
      if (!kw || seen[kw.toLowerCase()]) return;
      if (out.keywords.length >= MAX_KEYWORDS) return;
      seen[kw.toLowerCase()] = true;
      out.keywords.push(kw);
    });
  }
  if (Array.isArray(p.fields)) {
    const f = p.fields.filter(function (x) { return ARXIV.FIELD_IDS.indexOf(x) >= 0; });
    out.fields = f.length ? f : ['all'];
  }
  if (p.days != null) out.days = clampInt(p.days, 0, 365, cur.days);          // 0 = 不限日期
  if (p.intervalH != null) out.intervalH = clampInt(p.intervalH, 1, 24 * 30, cur.intervalH);
  if (p.maxResults != null) out.maxResults = clampInt(p.maxResults, 5, 100, cur.maxResults);
  if (p.pushCap != null) out.pushCap = clampInt(p.pushCap, 1, 20, cur.pushCap);
  if (p.lastFetchAt != null) out.lastFetchAt = Math.max(0, Math.round(Number(p.lastFetchAt) || 0));
  if (p.lastOkAt != null) out.lastOkAt = Math.max(0, Math.round(Number(p.lastOkAt) || 0));
  if (p.lastCount != null) out.lastCount = Math.max(0, Math.round(Number(p.lastCount) || 0));
  if (typeof p.lastError === 'string') out.lastError = p.lastError.slice(0, 300);
  return out;
}

/* 打开（没有就建）数据库，返回一个带方法的小对象 */
function openArxivDb(file) {
  const db = new DatabaseSync(file);
  try { db.exec('PRAGMA journal_mode = WAL'); } catch (e) { /* 有些磁盘不支持，无所谓 */ }
  try { db.exec('PRAGMA synchronous = NORMAL'); } catch (e) { }

  db.exec([
    'CREATE TABLE IF NOT EXISTS config(k TEXT PRIMARY KEY, v TEXT NOT NULL);',
    'CREATE TABLE IF NOT EXISTS papers(',
    '  arxiv_id TEXT PRIMARY KEY,',
    '  title TEXT NOT NULL, summary TEXT, authors TEXT, categories TEXT, primary_cat TEXT,',
    '  published TEXT, updated TEXT, comment TEXT, journal_ref TEXT,',
    '  pdf_url TEXT, abs_url TEXT, matched TEXT,',
    '  fetched_at INTEGER, pushed INTEGER DEFAULT 0, pushed_at INTEGER DEFAULT 0,',
    '  read INTEGER DEFAULT 0, star INTEGER DEFAULT 0',
    ');',
    'CREATE INDEX IF NOT EXISTS idx_papers_pub ON papers(published DESC);',
    'CREATE INDEX IF NOT EXISTS idx_papers_pushed ON papers(pushed, read);',
    'CREATE TABLE IF NOT EXISTS push_log(',
    '  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, count INTEGER, note TEXT',
    ');'
  ].join('\n'));

  const q = {
    getCfg: db.prepare('SELECT v FROM config WHERE k = ?'),
    setCfg: db.prepare('INSERT INTO config(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),
    insPaper: db.prepare([
      'INSERT OR IGNORE INTO papers(',
      ' arxiv_id, title, summary, authors, categories, primary_cat, published, updated,',
      ' comment, journal_ref, pdf_url, abs_url, matched, fetched_at, pushed, pushed_at, read',
      ') VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,0)'
    ].join('')),
    hasPaper: db.prepare('SELECT 1 AS x FROM papers WHERE arxiv_id = ?'),
    markPushed: db.prepare('UPDATE papers SET pushed = 1, pushed_at = ? WHERE arxiv_id = ?'),
    markRead: db.prepare('UPDATE papers SET read = 1 WHERE arxiv_id = ?'),
    markAllRead: db.prepare('UPDATE papers SET read = 1 WHERE read = 0'),
    star: db.prepare('UPDATE papers SET star = ? WHERE arxiv_id = ?'),
    delPaper: db.prepare('DELETE FROM papers WHERE arxiv_id = ?'),
    clearPapers: db.prepare('DELETE FROM papers'),
    unread: db.prepare('SELECT COUNT(*) AS n FROM papers WHERE read = 0 AND pushed = 1'),
    total: db.prepare('SELECT COUNT(*) AS n FROM papers'),
    logPush: db.prepare('INSERT INTO push_log(at, count, note) VALUES (?,?,?)'),
    lastPush: db.prepare('SELECT at, count, note FROM push_log ORDER BY id DESC LIMIT 1'),
    pruneCount: db.prepare('SELECT COUNT(*) AS n FROM papers'),
    pruneIds: db.prepare([
      'SELECT arxiv_id FROM papers ORDER BY (published IS NULL), published DESC, fetched_at DESC',
      ' LIMIT -1 OFFSET ?'
    ].join(''))
  };

  function getConfig() {
    let raw = null;
    try {
      const row = q.getCfg.get('main');
      if (row && row.v) raw = JSON.parse(row.v);
    } catch (e) { raw = null; }
    /* 每次都过一遍 normalize：旧版本存下来的字段/越界值会被自动修正 */
    return normalizeConfig(raw || {}, DEFAULT_CONFIG);
  }

  function setConfig(patch) {
    const next = normalizeConfig(patch, getConfig());
    q.setCfg.run('main', JSON.stringify(next));
    return next;
  }

  function rowToPaper(r) {
    if (!r) return null;
    return {
      arxivId: r.arxiv_id,
      /* 标题/摘要在这里再过一遍公式清洗：清洗是入库时做的，但库里可能存着
         「清洗之前抓进来的」老数据（用户升级后才发现摘要里还是一堆 $ 和反斜杠）——
         读的时候再洗一次，老数据也就跟着正常了。重复洗是无害的（已经是纯文本时不变）。 */
      title: ARXIV.plainText(r.title),
      summary: ARXIV.plainText(r.summary || ''),
      authors: safeArr(r.authors),
      categories: safeArr(r.categories),
      primary: r.primary_cat || '',
      published: r.published || '',
      updated: r.updated || '',
      comment: r.comment || '',
      journalRef: r.journal_ref || '',
      pdfUrl: r.pdf_url || ('https://arxiv.org/pdf/' + r.arxiv_id),
      absUrl: r.abs_url || ('https://arxiv.org/abs/' + r.arxiv_id),
      matched: safeArr(r.matched),
      fetchedAt: r.fetched_at || 0,
      pushed: !!r.pushed,
      pushedAt: r.pushed_at || 0,
      read: !!r.read,
      star: !!r.star
    };
  }
  function safeArr(s) {
    if (!s) return [];
    try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch (e) { return []; }
  }

  /* 入库：以 arXiv ID 去重（主键 + INSERT OR IGNORE）。
     返回「这次真正新进来的」那几条 —— 只有新的才值得推送。 */
  function addPapers(list, opts) {
    const o = opts || {};
    const now = Date.now();
    const added = [];
    (list || []).forEach(function (p) {
      if (!p || !p.arxivId || !p.title) return;
      if (q.hasPaper.get(p.arxivId)) return;             // 老熟人，跳过（连改都不改）
      const info = q.insPaper.run(
        p.arxivId, p.title, p.summary || '', JSON.stringify(p.authors || []),
        JSON.stringify(p.categories || []), p.primary || '', p.published || '', p.updated || '',
        p.comment || '', p.journalRef || '', p.pdfUrl || '', p.absUrl || '',
        JSON.stringify(o.matchedFor ? o.matchedFor(p) : (p.matched || [])), now);
      if (info && info.changes > 0) added.push(p.arxivId);
    });
    return { added: added.length, ids: added };
  }

  function listPapers(opts) {
    const o = opts || {};
    const limit = clampInt(o.limit, 1, 200, 30);
    const offset = Math.max(0, Math.round(Number(o.offset) || 0));
    /* 默认按提交日期倒序；只看未读 / 只看收藏都支持 */
    let where = '';
    if (o.filter === 'unread') where = 'WHERE read = 0 AND pushed = 1';
    else if (o.filter === 'star') where = 'WHERE star = 1';
    else if (o.filter === 'new') where = 'WHERE pushed = 0';
    const rows = db.prepare(
      'SELECT * FROM papers ' + where +
      ' ORDER BY (published IS NULL), published DESC, fetched_at DESC LIMIT ? OFFSET ?'
    ).all(limit, offset);
    const cnt = db.prepare('SELECT COUNT(*) AS n FROM papers ' + where).get();
    return { items: rows.map(rowToPaper), total: (cnt && cnt.n) || 0, limit: limit, offset: offset };
  }

  function markPushed(ids) {
    const now = Date.now();
    let n = 0;
    (ids || []).forEach(function (id) { const r = q.markPushed.run(now, id); if (r && r.changes) n++; });
    return n;
  }
  function markRead(id) { const r = q.markRead.run(id); return !!(r && r.changes); }
  function markAllRead() { const r = q.markAllRead.run(); return (r && r.changes) || 0; }
  function setStar(id, on) { const r = q.star.run(on ? 1 : 0, id); return !!(r && r.changes); }
  function removePaper(id) { const r = q.delPaper.run(id); return !!(r && r.changes); }
  function clearPapers() { q.clearPapers.run(); return true; }

  function unreadCount() { const r = q.unread.get(); return (r && r.n) || 0; }
  function totalCount() { const r = q.total.get(); return (r && r.n) || 0; }
  function logPush(count, note) {
    const r = q.logPush.run(Date.now(), count, String(note || '').slice(0, 200));
    return !!(r && r.changes);
  }
  function lastPush() {
    const r = q.lastPush.get();
    return r ? { at: r.at, count: r.count, note: r.note } : null;
  }

  /* 库别无限长大：只留最新的 PAPERS_KEEP 篇 */
  function prune() {
    const r = q.pruneCount.get();
    const n = (r && r.n) || 0;
    if (n <= PAPERS_KEEP) return 0;
    const ids = q.pruneIds.all(PAPERS_KEEP).map(function (x) { return x.arxiv_id; });
    ids.forEach(function (id) { q.delPaper.run(id); });
    return ids.length;
  }

  function close() { try { db.close(); } catch (e) { } }

  return {
    file: file,
    getConfig: getConfig,
    setConfig: setConfig,
    addPapers: addPapers,
    listPapers: listPapers,
    markPushed: markPushed,
    markRead: markRead,
    markAllRead: markAllRead,
    setStar: setStar,
    removePaper: removePaper,
    clearPapers: clearPapers,
    unreadCount: unreadCount,
    totalCount: totalCount,
    logPush: logPush,
    lastPush: lastPush,
    prune: prune,
    close: close
  };
}

/* 库文件放 userData（和别的数据一起），更新软件不会动它 */
function arxivDbPath(userDataDir) {
  return path.join(userDataDir, 'arxiv.db');
}

module.exports = {
  MAX_KEYWORDS: MAX_KEYWORDS,
  PAPERS_KEEP: PAPERS_KEEP,
  DEFAULT_CONFIG: DEFAULT_CONFIG,
  normalizeConfig: normalizeConfig,
  openArxivDb: openArxivDb,
  arxivDbPath: arxivDbPath
};
