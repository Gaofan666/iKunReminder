/* =========================================================================
   schol-sources.js —— 科研动态的多来源检索（arXiv 之外的新学术源）
   -------------------------------------------------------------------------
   背景：原来只抓 arXiv 官方 API。用户希望像 Google Scholar 那样一网打尽。
   Google Scholar 本身没有官方 API、反爬极凶（CAPTCHA/封 IP，Google 2025 年
   还起诉了 SerpApi），直连爬 HTML 不可行 —— 所以这里接的是「覆盖面与之
   等效」的开放学术 API（全部免费、无需密钥即可用）：

     openalex    OpenAlex   —— 2.5 亿条，Scholar 的最佳开放替代（含 OA PDF 链接）
     crossref    Crossref   —— 1.8 亿条 DOI 记录，期刊/会议元数据最全
     europepmc   Europe PMC —— 生物医学补充（可选）
     s2          Semantic Scholar —— 无密钥经常被限流（429），默认关，失败自动跳过

   每个 source 对外暴露同一个接口：
     fetch(cfg, { fetchImpl, maxResults, now }) → { total, entries }
   entries 归一成和 arxiv.js 的 parseAtom() 一样的形状：
     { arxivId(合成键), title, summary, authors[], published, updated,
       primary, categories[], comment, journalRef, pdfUrl, absUrl, source }
   「arxivId」这一栏是全局去重键（papers 表主键），非 arXiv 论文用
     doi:10.xxx/yyy ／ openalex:W… ／ epmc:… ／ s2:… 这样的合成 ID ——
   同一篇论文只要两家都给了 DOI，就自然合成同一个键，跨源自动去重。

   刻意不 require('electron')：fetch 由调用方传进来，和 arxiv.js 一个路子，
   自检可以直接喂假数据。
   ========================================================================= */
'use strict';

const ARXIV = require('./arxiv');

/* ----------------------------------------------------------------- 工具 */
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/* YYYY-MM-DD（本地 now 往前 days 天） */
function ymd(d) {
  const t = (d instanceof Date) ? d : new Date(d);
  return t.getUTCFullYear() + '-' +
    ('0' + (t.getUTCMonth() + 1)).slice(-2) + '-' +
    ('0' + t.getUTCDate()).slice(-2);
}

/* 归一化条目的兜底：pdf/abs 链接绝不能是空（rowToPaper 的 fallback 会拼出
   假的 arxiv.org 链接），published 给不了就空字符串。 */
function entry(p) {
  const e = Object.assign({
    arxivId: '', title: '', summary: '', authors: [],
    published: '', updated: '', primary: '', categories: [],
    comment: '', journalRef: '', pdfUrl: '', absUrl: '',
    source: ''
  }, p);
  if (!e.pdfUrl) e.pdfUrl = e.absUrl || '';
  if (!e.absUrl) e.absUrl = e.pdfUrl || '';
  return e;
}

/* HTTP GET + JSON 解析（带重试）。OpenAlex/Crossref 偶发 5xx/429，退避重试。 */
async function getJson(fetchImpl, url, retries) {
  const n = Math.max(0, Math.round(retries == null ? 2 : retries));
  let lastErr = null;
  for (let i = 0; i <= n; i++) {
    try {
      const res = await fetchImpl(url, { redirect: 'follow' });
      if (!res || !res.ok) throw new Error('HTTP ' + ((res && res.status) || '?'));
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch (e) { throw new Error('返回的不是 JSON'); }
      return json;
    } catch (e) {
      lastErr = e;
      if (i < n) await sleep(1200 * (i + 1));
    }
  }
  throw new Error(String((lastErr && lastErr.message) || lastErr));
}

/* 关键词数组（已经清洗过）按需要连接 */
function joinKws(kws, sep) { return (kws || []).join(sep); }

/* 通用收尾：非「任一条件」模式下做一次精确后过滤（关键词必须全出现在标题+摘要里）。
   OpenAlex/Crossref/EPMC 的搜索都是「相关性排序」，AND 语义只能靠本地过滤保证。 */
function postFilter(entries, cfg) {
  if (cfg && cfg.matchAny === false && cfg.keywords && cfg.keywords.length) {
    const kws = cfg.keywords.map(function (k) { return String(k).toLowerCase(); });
    return entries.filter(function (p) {
      const hay = (String(p.title || '') + ' ' + String(p.summary || '')).toLowerCase();
      return kws.every(function (k) { return hay.indexOf(k) >= 0; });
    });
  }
  return entries;
}

/* ================================================================ OpenAlex */
const OPENALEX_API = 'https://api.openalex.org/works';
const OPENALEX_SELECT = 'id,doi,title,authorships,publication_date,primary_location,' +
  'open_access,best_oa_location,abstract_inverted_index,primary_topic,type,cited_by_count';

/* OpenAlex 的摘要是个「倒排索引」（词 → 出现位置数组），要自己拼回句子 */
function oaAbstract(inv) {
  if (!inv || typeof inv !== 'object') return '';
  const words = [];
  let max = -1;
  Object.keys(inv).forEach(function (w) {
    const pos = inv[w] || [];
    pos.forEach(function (i) {
      if (i > max) max = i;
      words.push({ i: i, w: w });
    });
  });
  if (max < 0) return '';
  const arr = new Array(max + 1);
  words.forEach(function (x) { arr[x.i] = x.w; });
  return arr.join(' ').replace(/\s+/g, ' ').trim();
}

function oaIdToKey(openalexId) {
  const m = /openalex\.org\/(W\d+)/i.exec(String(openalexId || ''));
  return m ? m[1] : '';
}

function oaNormalize(w) {
  if (!w) return null;
  const title = ARXIV.plainText(w.display_name || w.title || '');
  if (!title) return null;
  const doi = String(w.doi || '').replace(/^https?:\/\/doi\.org\//i, '').trim();
  const wkey = oaIdToKey(w.id);
  if (!doi && !wkey) return null;

  const authors = (w.authorships || [])
    .map(function (a) { return a && a.author && a.author.display_name; })
    .filter(Boolean);

  const venue = (w.primary_location && w.primary_location.source &&
    w.primary_location.source.display_name) || '';
  const cats = (w.primary_topic && w.primary_topic.display_name)
    ? [w.primary_topic.display_name] : [];
  const pdfUrl = (w.best_oa_location && w.best_oa_location.pdf_url) ||
    (w.open_access && w.open_access.oa_url) || '';
  const landing = (w.primary_location && w.primary_location.landing_page_url) || '';
  const absUrl = doi ? ('https://doi.org/' + doi) : (landing || (wkey ? ('https://openalex.org/' + wkey) : ''));

  return entry({
    arxivId: doi ? ('doi:' + doi) : ('openalex:' + wkey),
    title: title,
    summary: oaAbstract(w.abstract_inverted_index),
    authors: authors,
    published: w.publication_date || '',
    primary: venue || (w.type || ''),
    categories: cats,
    comment: (w.cited_by_count ? ('被引 ' + w.cited_by_count) : ''),
    pdfUrl: pdfUrl,
    absUrl: absUrl,
    source: 'openalex'
  });
}

async function openalexFetch(cfg, opts) {
  const o = opts || {};
  const fetchImpl = o.fetchImpl;
  const kws = (cfg.keywords || []).map(ARXIV.cleanKeyword).filter(Boolean);
  if (!kws.length) throw new Error('还没设置关键词');
  const want = Math.min(200, Math.max(1, Math.round(Number(o.maxResults) || 30)));

  /* 任一条件：kw1|kw2|kw3（| 是 OpenAlex filter 里的 OR）
     全部条件：直接把词组扔给全文搜索（相关性排序），精确 AND 由本地 postFilter 兜底 */
  const tas = (cfg.matchAny === false)
    ? joinKws(kws, ' ')
    : joinKws(kws, '|');
  const filters = ['title_and_abstract.search:' + tas];
  const days = Math.max(0, Math.round(Number(cfg.days) || 0));
  if (days > 0) {
    const now = (o.now instanceof Date) ? o.now : new Date(o.now || Date.now());
    filters.push('from_publication_date:' + ymd(now.getTime() - days * 24 * 3600 * 1000));
  }
  const url = OPENALEX_API + '?' + new URLSearchParams({
    filter: filters.join(','),
    per_page: String(want),
    page: '1',
    select: OPENALEX_SELECT
  }).toString();

  const j = await getJson(fetchImpl, url);
  const total = (j.meta && j.meta.count) || 0;
  const entries = postFilter((j.results || []).map(oaNormalize).filter(Boolean), cfg);
  return { url: url, total: total, entries: entries };
}

/* ================================================================ Crossref */
const CROSSREF_API = 'https://api.crossref.org/works';

/* Crossref 的摘要是 JATS XML（<jats:p>…），剥掉标签再用 */
function crAbstract(s) {
  return ARXIV.plainText(String(s || '').replace(/<[^>]+>/g, ' '));
}

function crDate(item) {
  const dp = (item.issued && item.issued['date-parts'] && item.issued['date-parts'][0]) || [];
  if (!dp.length) return '';
  const y = dp[0] || '';
  const m = dp[1] != null ? ('0' + dp[1]).slice(-2) : '';
  const d = dp[2] != null ? ('0' + dp[2]).slice(-2) : '';
  return [y, m, d].filter(Boolean).join('-');
}

function crNormalize(it) {
  if (!it) return null;
  const title = ARXIV.plainText((it.title && it.title[0]) || '');
  const doi = String(it.DOI || '').trim();
  if (!title || !doi) return null;

  const authors = (it.author || [])
    .map(function (a) { return [a.given, a.family].filter(Boolean).join(' ').trim(); })
    .filter(Boolean);
  const venue = (it['container-title'] && it['container-title'][0]) || '';
  const typeMap = { 'journal-article': '期刊论文', 'proceedings-article': '会议论文', 'book-chapter': '书章', 'preprint': '预印本' };
  const typeName = typeMap[it.type] || it.type || '';

  let pdfUrl = '';
  (it.link || []).forEach(function (l) {
    if (!pdfUrl && l && String(l['content-type'] || '') === 'application/pdf' && l.URL) pdfUrl = l.URL;
  });

  return entry({
    arxivId: 'doi:' + doi,
    title: title,
    summary: crAbstract(it.abstract),
    authors: authors,
    published: crDate(it),
    primary: venue || typeName,
    categories: typeName && !venue ? [typeName] : [],
    comment: (it['is-referenced-by-count'] ? ('被引 ' + it['is-referenced-by-count']) : ''),
    pdfUrl: pdfUrl,
    absUrl: 'https://doi.org/' + doi,
    journalRef: venue,
    source: 'crossref'
  });
}

async function crossrefFetch(cfg, opts) {
  const o = opts || {};
  const fetchImpl = o.fetchImpl;
  const kws = (cfg.keywords || []).map(ARXIV.cleanKeyword).filter(Boolean);
  if (!kws.length) throw new Error('还没设置关键词');
  const want = Math.min(100, Math.max(1, Math.round(Number(o.maxResults) || 30)));

  const params = {
    query: joinKws(kws, ' '),        /* Crossref 是相关性检索，AND 语义由 postFilter 兜底 */
    rows: String(want),
    select: 'DOI,title,author,abstract,issued,container-title,type,link,is-referenced-by-count,URL'
  };
  const days = Math.max(0, Math.round(Number(cfg.days) || 0));
  if (days > 0) {
    const now = (o.now instanceof Date) ? o.now : new Date(o.now || Date.now());
    params['filter'] = 'from-pub-date:' + ymd(now.getTime() - days * 24 * 3600 * 1000);
  }
  const url = CROSSREF_API + '?' + new URLSearchParams(params).toString();

  const j = await getJson(fetchImpl, url);
  const msg = j.message || {};
  const total = msg['total-results'] || 0;
  const entries = postFilter((msg.items || []).map(crNormalize).filter(Boolean), cfg);
  return { url: url, total: total, entries: entries };
}

/* ============================================================== Europe PMC */
const EPMC_API = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';

function epmcNormalize(r) {
  if (!r) return null;
  const title = ARXIV.plainText(r.title || '');
  if (!title) return null;
  const doi = String(r.doi || '').replace(/^https?:\/\/doi\.org\//i, '').trim();
  const pmid = String(r.pmid || '').trim();
  const pmcid = String(r.pmcid || '').trim();
  if (!doi && !pmid && !pmcid) return null;

  const authors = String(r.authorString || '')
    .split(/,\s*/)
    .map(function (s) { return s.trim(); })
    .filter(Boolean);

  const venue = (r.journalInfo && r.journalInfo.journal && r.journalInfo.journal.title) || '';
  let pdfUrl = '';
  const urls = (r.fullTextUrlList && r.fullTextUrlList.fullTextUrl) || [];
  urls.forEach(function (u) {
    if (!pdfUrl && u && String(u.documentStyle || '') === 'pdf' && u.url) pdfUrl = u.url;
  });
  const absUrl = doi ? ('https://doi.org/' + doi)
    : (pmcid ? ('https://europepmc.org/article/' + pmcid)
      : ('https://europepmc.org/article/MED/' + pmid));

  return entry({
    arxivId: doi ? ('doi:' + doi) : (pmcid ? ('epmc:' + pmcid) : ('epmc:pmid:' + pmid)),
    title: title,
    summary: ARXIV.plainText(r.abstractText || ''),
    authors: authors,
    published: r.firstPublicationDate || r.firstIndexDate || '',
    primary: venue || '生物医学',
    categories: [],
    pdfUrl: pdfUrl,
    absUrl: absUrl,
    journalRef: venue,
    source: 'europepmc'
  });
}

async function europepmcFetch(cfg, opts) {
  const o = opts || {};
  const fetchImpl = o.fetchImpl;
  const kws = (cfg.keywords || []).map(ARXIV.cleanKeyword).filter(Boolean);
  if (!kws.length) throw new Error('还没设置关键词');
  const want = Math.min(200, Math.max(1, Math.round(Number(o.maxResults) || 30)));

  /* Europe PMC 认真正的布尔语法：任一 → OR，全部 → AND */
  const op = (cfg.matchAny === false) ? ' AND ' : ' OR ';
  let q = '(' + joinKws(kws.map(function (k) { return '"' + k + '"'; }), op) + ')';
  const days = Math.max(0, Math.round(Number(cfg.days) || 0));
  if (days > 0) {
    const now = (o.now instanceof Date) ? o.now : new Date(o.now || Date.now());
    const from = ymd(now.getTime() - days * 24 * 3600 * 1000);
    const to = ymd(now);
    q += ' AND (FIRST_PDATE:[' + from + ' TO ' + to + '])';
  }
  const url = EPMC_API + '?' + new URLSearchParams({
    query: q,
    format: 'json',
    resultType: 'core',
    pageSize: String(want)
  }).toString();

  const j = await getJson(fetchImpl, url);
  const total = j.hitCount || 0;
  const entries = postFilter(((j.resultList && j.resultList.result) || [])
    .map(epmcNormalize).filter(Boolean), cfg);
  return { url: url, total: total, entries: entries };
}

/* ========================================================= Semantic Scholar */
const S2_API = 'https://api.semanticscholar.org/graph/v1/paper/search';

function s2Normalize(p) {
  if (!p) return null;
  const title = ARXIV.plainText(p.title || '');
  if (!title) return null;
  const ext = p.externalIds || {};
  const doi = String(ext.DOI || '').trim();
  const axv = String(ext.ArXiv || '').trim();
  if (!doi && !axv && !p.paperId) return null;

  /* S2 给了 arXiv ID 就直接用裸 arXiv ID —— 和 arXiv 源抓到的是同一篇，天然合并 */
  const authors = (p.authors || []).map(function (a) { return a && a.name; }).filter(Boolean);

  return entry({
    arxivId: axv ? axv : (doi ? ('doi:' + doi) : ('s2:' + p.paperId)),
    title: title,
    summary: ARXIV.plainText(p.abstract || ''),
    authors: authors,
    published: p.publicationDate || '',
    primary: p.venue || '',
    categories: [],
    pdfUrl: (p.openAccessPdf && p.openAccessPdf.url) || '',
    absUrl: doi ? ('https://doi.org/' + doi)
      : (axv ? ('https://arxiv.org/abs/' + axv)
        : ('https://www.semanticscholar.org/paper/' + p.paperId)),
    source: 's2'
  });
}

async function s2Fetch(cfg, opts) {
  const o = opts || {};
  const fetchImpl = o.fetchImpl;
  const kws = (cfg.keywords || []).map(ARXIV.cleanKeyword).filter(Boolean);
  if (!kws.length) throw new Error('还没设置关键词');
  const want = Math.min(100, Math.max(1, Math.round(Number(o.maxResults) || 30)));

  const url = S2_API + '?' + new URLSearchParams({
    query: joinKws(kws, ' '),
    limit: String(want),
    fields: 'paperId,title,abstract,authors,publicationDate,externalIds,openAccessPdf,venue'
  }).toString();

  const j = await getJson(fetchImpl, url, 1);
  const total = (j.total) || 0;
  const entries = postFilter((j.data || []).map(s2Normalize).filter(Boolean), cfg);
  return { url: url, total: total, entries: entries };
}

/* ================================================================ 注册表 */
const SOURCES = [
  {
    id: 'arxiv', label: 'arXiv', hint: '预印本库（原来的数据源，字段前缀只对它生效）',
    def: true, fetch: null       /* arXiv 仍走 arxiv-service 里原来的翻页逻辑 */
  },
  {
    id: 'openalex', label: 'OpenAlex', hint: '2.5 亿条学术记录（Google Scholar 的最佳开放替代，含 OA 全文链接）',
    def: true, fetch: openalexFetch
  },
  {
    id: 'crossref', label: 'Crossref', hint: '1.8 亿条 DOI 记录，IEEE/Elsevier/Springer 等期刊会议元数据最全',
    def: true, fetch: crossrefFetch
  },
  {
    id: 'europepmc', label: 'Europe PMC', hint: '生物医学文献（生命科学方向再开）',
    def: false, fetch: europepmcFetch
  },
  {
    id: 's2', label: 'Semantic Scholar', hint: '无密钥经常被限流（429），失败会自动跳过；建议申请免费 API key 后再开',
    def: false, fetch: s2Fetch
  }
];
const SOURCE_IDS = SOURCES.map(function (s) { return s.id; });
const DEFAULT_SOURCES = SOURCES.filter(function (s) { return s.def; }).map(function (s) { return s.id; });

function byId(id) {
  return SOURCES.filter(function (s) { return s.id === id; })[0] || null;
}

/* 给界面用的精简列表 */
function uiList() {
  return SOURCES.map(function (s) {
    return { id: s.id, label: s.label, hint: s.hint, def: s.def };
  });
}

module.exports = {
  SOURCES: SOURCES,
  SOURCE_IDS: SOURCE_IDS,
  DEFAULT_SOURCES: DEFAULT_SOURCES,
  byId: byId,
  uiList: uiList,
  ymd: ymd,
  postFilter: postFilter,
  oaAbstract: oaAbstract,
  oaNormalize: oaNormalize,
  openalexFetch: openalexFetch,
  crNormalize: crNormalize,
  crossrefFetch: crossrefFetch,
  epmcNormalize: epmcNormalize,
  europepmcFetch: europepmcFetch,
  s2Normalize: s2Normalize,
  s2Fetch: s2Fetch
};
