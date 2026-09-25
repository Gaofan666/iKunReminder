/* =========================================================================
   arxiv.js —— arXiv 检索的纯逻辑部分
   -------------------------------------------------------------------------
   三件事：
     1. buildArxivQuery()  按用户配置拼 search_query（字段前缀 / 大写运算符 / 括号 / 日期过滤）
     2. parseAtom()        解析 arXiv 返回的 Atom XML
     3. arxivFetch()       调官方 API（限速 3 秒、失败重试）

   刻意不 require('electron')：fetch 由调用方传进来（主进程用 net.fetch，
   自检里可以直接喂假数据），这样这一层能单独跑、查询串能单独打出来对照。
   ========================================================================= */
'use strict';

/* arXiv 官方 API：免费、不用密钥 */
const API = 'http://export.arxiv.org/api/query';

/* 可以在界面上多选的元数据字段（arXiv 的前缀语法） */
const FIELDS = [
  { id: 'ti', label: '标题', hint: '题目里出现' },
  { id: 'abs', label: '摘要', hint: '摘要里出现' },
  { id: 'au', label: '作者', hint: '作者名，如 Hinton' },
  { id: 'cat', label: '分类', hint: '如 cs.LG、cs.CL、stat.ML' },
  { id: 'all', label: '全字段', hint: '标题+摘要+作者+……（最宽）' },
  { id: 'co', label: '评论', hint: '作者备注（会议名、页数）' },
  { id: 'jr', label: '期刊引用', hint: 'journal ref' },
  { id: 'rn', label: '报告编号', hint: 'report number' },
  { id: 'id', label: 'arXiv ID', hint: '如 2401.12345' }
];
const FIELD_IDS = FIELDS.map(function (f) { return f.id; });

/* 运算符必须大写 —— arXiv 只认大写的 AND / OR / ANDNOT */
const OPS = ['AND', 'OR', 'ANDNOT'];

const MIN_INTERVAL_MS = 3000;      // 官方建议的请求间隔：别比 3 秒更快
let lastRequestAt = 0;             // 上一次真的发请求的时刻（全局限速）

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function pad2(n) { return n < 10 ? '0' + n : String(n); }

/* arXiv 的日期过滤格式：YYYYMMDDHHMM（UTC，不含秒） */
function arxivDate(d) {
  const t = (d instanceof Date) ? d : new Date(d);
  return String(t.getUTCFullYear()) + pad2(t.getUTCMonth() + 1) + pad2(t.getUTCDate()) +
    pad2(t.getUTCHours()) + pad2(t.getUTCMinutes());
}

/* 关键词清洗：压掉连续空白、去掉会破坏查询语法的引号/括号（不然用户能拼出奇怪查询） */
function cleanKeyword(s) {
  return String(s == null ? '' : s)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/["'()[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* 一行一个 / 逗号分隔都能用；中文逗号、分号也当分隔符 */
function splitKeywords(text) {
  return String(text == null ? '' : text)
    .split(/[,，;；\n\r]+/)
    .map(cleanKeyword)
    .filter(Boolean);
}

/* 中文（含日文假名、韩文）—— arXiv 基本是英文库，界面上要提示换英文 */
function hasCjk(s) {
  return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(String(s || ''));
}

/* 一个「字段:关键词」原子。多词关键词一定用双引号包成短语，
   否则 arXiv 会当成几个词分别匹配，结果会变样。 */
function atom(field, kw) {
  const f = FIELD_IDS.indexOf(field) >= 0 ? field : 'all';
  return f + ':"' + kw + '"';
}

/* ---------------------------------------------------------------- 查询构造
   两种匹配模式（需求里的「任一条件 / 全部条件」）：

   任一条件（matchAny = true）：
     把「所有字段 × 所有关键词」平铺开，全部用 OR 连；外面再 AND 日期。
       (ti:"a" OR abs:"a" OR ti:"b" OR abs:"b") AND submittedDate:[... TO ...]

   全部条件（matchAny = false）：
     按【关键词】分组，组内字段之间 OR，组与组之间 AND；外面再 AND 日期。
       ((ti:"a" OR abs:"a") AND (ti:"b" OR abs:"b")) AND submittedDate:[... TO ...]

   括号一律显式写出来，不依赖 AND/OR 的优先级，读起来也清楚。 */
function buildArxivQuery(cfg, now) {
  const c = cfg || {};
  const kws = (c.keywords || []).map(cleanKeyword).filter(Boolean);
  let fields = (c.fields && c.fields.length ? c.fields : ['all'])
    .filter(function (f) { return FIELD_IDS.indexOf(f) >= 0; });
  if (!fields.length) fields = ['all'];
  if (!kws.length) return '';

  const groups = [];
  if (c.matchAny) {
    kws.forEach(function (kw) {
      fields.forEach(function (f) { groups.push(atom(f, kw)); });
    });
  } else {
    kws.forEach(function (kw) {
      const one = fields.map(function (f) { return atom(f, kw); });
      groups.push(one.length > 1 ? '(' + one.join(' OR ') + ')' : one[0]);
    });
  }

  let q = groups.join(c.matchAny ? ' OR ' : ' AND ');
  if (groups.length > 1) q = '(' + q + ')';

  const days = Math.max(0, Math.round(Number(c.days) || 0));
  if (days > 0) {
    const to = (now instanceof Date) ? now : new Date();
    const from = new Date(to.getTime() - days * 24 * 3600 * 1000);
    q += ' AND submittedDate:[' + arxivDate(from) + ' TO ' + arxivDate(to) + ']';
  }
  return q;
}

/* ------------------------------------------------------------------ 解析 */
function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#0*38;/g, '&')
    .replace(/&amp;/g, '&');
}

/* 取一个标签里的纯文本（arXiv 的标题/摘要里有换行和缩进，这里压成单行） */
function tagText(block, name) {
  const re = new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>');
  const m = re.exec(block);
  if (!m) return '';
  return decodeEntities(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/* 从 abs/pdf 链接里抠出 arXiv ID；版本号（v2 之类）去掉 —— 去重认的是文章本身 */
function arxivIdFromUrl(url) {
  const s = String(url == null ? '' : url).trim();
  if (!s) return '';
  const m = /arxiv\.org\/(?:abs|pdf)\/([^?#\s]+)/i.exec(s);
  let id = m ? m[1] : s;
  id = id.replace(/\.pdf$/i, '').replace(/^\/+/, '').trim();
  id = id.replace(/v\d+$/i, '');
  return id;
}

/* 解析 <link .../> 这类自闭合标签的属性（属性顺序不固定，所以不能靠一个正则硬抠） */
function links(block) {
  const out = [];
  const re = /<link\b([^>]*)\/?>/g;
  let m;
  while ((m = re.exec(block))) {
    const attrs = {};
    const are = /([a-zA-Z:_-]+)\s*=\s*"([^"]*)"/g;
    let am;
    while ((am = are.exec(m[1]))) attrs[am[1].toLowerCase()] = decodeEntities(am[2]);
    out.push(attrs);
  }
  return out;
}

/* Atom XML → { total, entries: [...] } */
function parseAtom(xml) {
  const text = String(xml == null ? '' : xml);
  const out = { total: 0, entries: [] };
  const tm = /<opensearch:totalResults[^>]*>([\s\S]*?)<\/opensearch:totalResults>/.exec(text);
  if (tm) out.total = parseInt(String(tm[1]).trim(), 10) || 0;

  const blocks = text.split(/<entry>/).slice(1);
  blocks.forEach(function (raw) {
    const block = raw.split('</entry>')[0];
    const idUrl = tagText(block, 'id');
    const arxivId = arxivIdFromUrl(idUrl);
    if (!arxivId) return;

    const authors = [];
    const are = /<author>([\s\S]*?)<\/author>/g;
    let am;
    while ((am = are.exec(block))) {
      const n = tagText(am[1], 'name');
      if (n) authors.push(n);
    }

    const categories = [];
    const cre = /<category\b[^>]*\bterm="([^"]*)"/g;
    let cm;
    while ((cm = cre.exec(block))) {
      const t = decodeEntities(cm[1]).trim();
      if (t && categories.indexOf(t) < 0) categories.push(t);
    }

    const ls = links(block);
    let pdfUrl = '';
    let absUrl = '';
    ls.forEach(function (a) {
      const rel = String(a.rel || '').toLowerCase();
      const title = String(a.title || '').toLowerCase();
      const type = String(a.type || '').toLowerCase();
      const href = a.href || '';
      if (!href) return;
      if (!pdfUrl && (title === 'pdf' || /\/pdf\//.test(href) || type === 'application/pdf')) pdfUrl = href;
      if (!absUrl && (rel === 'alternate' || /\/abs\//.test(href))) absUrl = href;
    });
    if (!pdfUrl) pdfUrl = 'https://arxiv.org/pdf/' + arxivId;
    if (!absUrl) absUrl = 'https://arxiv.org/abs/' + arxivId;

    const prim = /<arxiv:primary_category\b[^>]*\bterm="([^"]*)"/.exec(block);
    out.entries.push({
      arxivId: arxivId,
      title: tagText(block, 'title'),
      summary: tagText(block, 'summary'),
      authors: authors,
      published: tagText(block, 'published'),
      updated: tagText(block, 'updated'),
      primary: prim ? decodeEntities(prim[1]).trim() : (categories[0] || ''),
      categories: categories,
      comment: tagText(block, 'arxiv:comment'),
      journalRef: tagText(block, 'arxiv:journal_ref'),
      pdfUrl: pdfUrl,
      absUrl: absUrl
    });
  });
  return out;
}

/* -------------------------------------------------------------- 网络请求
   限速（≥3 秒）+ 失败重试（网络抖动、429、5xx、代理抽风都能扛一下）。
   注意：这里只负责「拿到 XML」，写库/推送在 arxiv-service.js 里。 */
async function arxivFetch(cfg, opts) {
  const o = opts || {};
  const fetchImpl = o.fetchImpl;
  if (typeof fetchImpl !== 'function') throw new Error('内部错误：没给 fetch');

  const query = buildArxivQuery(cfg, o.now);
  if (!query) throw new Error('还没设置关键词：先去「科研动态」里加几个英文关键词');

  const maxResults = Math.min(200, Math.max(1, Math.round(Number(o.maxResults) || 20)));
  const start = Math.max(0, Math.round(Number(o.start) || 0));
  const params = new URLSearchParams({
    search_query: query,
    start: String(start),
    max_results: String(maxResults),
    sortBy: 'submittedDate',
    sortOrder: 'descending'
  });
  const url = API + '?' + params.toString();
  const retries = Math.max(0, Math.round(o.retries == null ? 2 : o.retries));

  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    try {
      const res = await fetchImpl(url, { redirect: 'follow' });
      if (!res || !res.ok) throw new Error('HTTP ' + ((res && res.status) || '?'));
      const xml = await res.text();
      const parsed = parseAtom(xml);
      if (!parsed.entries.length && xml.indexOf('totalResults') < 0) {
        throw new Error('返回的内容不像 arXiv 的 Atom');
      }
      return { url: url, query: query, xml: xml, parsed: parsed, tries: i + 1 };
    } catch (e) {
      lastErr = e;
      if (i < retries) await sleep(1500 * (i + 1));      // 简单退避，别把对方惹毛
    }
  }
  throw new Error('arXiv 请求失败（试了 ' + (retries + 1) + ' 次）：' +
    String((lastErr && lastErr.message) || lastErr));
}

module.exports = {
  API: API,
  FIELDS: FIELDS,
  FIELD_IDS: FIELD_IDS,
  OPS: OPS,
  MIN_INTERVAL_MS: MIN_INTERVAL_MS,
  arxivDate: arxivDate,
  cleanKeyword: cleanKeyword,
  splitKeywords: splitKeywords,
  hasCjk: hasCjk,
  buildArxivQuery: buildArxivQuery,
  parseAtom: parseAtom,
  arxivIdFromUrl: arxivIdFromUrl,
  arxivFetch: arxivFetch
};
