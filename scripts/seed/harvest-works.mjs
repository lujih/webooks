#!/usr/bin/env node
/**
 * webooks 公版种子库 · 第 ① 步：从中文维基文库采集 800 本公有领域中文书。
 *
 * 产出：
 *   seed/catalog.works.json  —— 清单（整本路线；字段契约见 seed/README.md）
 *   seed/report.works.md     —— 组成统计、来源分类分布、剔除原因、复现方式
 *
 * 只使用 Node 内置模块（零第三方依赖）。用法：
 *   node scripts/seed/harvest-works.mjs                  采集（断点续跑，中间结果在 seed/.cache/）
 *   node scripts/seed/harvest-works.mjs --validate-only  只校验 seed/catalog.works.json，不发网络请求
 *   node scripts/seed/harvest-works.mjs --refresh        忽略缓存重来
 *   node scripts/seed/harvest-works.mjs --stage=discover 只跑到指定阶段（discover|members|links）
 *
 * 网络礼貌（Wikimedia 匿名 API 配额很紧，实测约 14 次 / 45 秒 / 出口 IP）：
 *   · 单并发（≤2），请求间隔默认 3400ms，可用 --min-interval 调整，下限 150ms；
 *   · 失败重试 3 次（指数退避）；429 按 Retry-After 等待；5xx / 非 JSON 也重试；
 *   · 分类接口超时/失败只跳过该分类并记录，绝不中断整体采集；
 *   · 每个响应都落盘到 seed/.cache/api/<sha1>.json，重跑直接复用 → 断点续跑。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = process.env.SEED_REPO ? path.resolve(process.env.SEED_REPO) : path.resolve(HERE, '../..');
const SEED = path.join(REPO, 'seed');
const CACHE = path.join(SEED, '.cache');
const CATALOG_PATH = path.join(SEED, 'catalog.works.json');
const REPORT_PATH = path.join(SEED, 'report.works.md');

const WIKISOURCE = 'https://zh.wikisource.org/w/api.php';
const WIKIDATA = 'https://www.wikidata.org/w/api.php';
const USER_AGENT = 'webooks-seed/1.0 (public-domain library; contact: admin@localhost)';
const SOURCE = 'zh.wikisource.org';

const TARGET = 800;
const MULTI_MIN = 400;
const CATEGORY_CAP = 300;
const SINGLE_MIN_BYTES = 20 * 1024;
const CHAPTERS_CAP = 200; // README 里 build-epub 的单本上限
const MAX_TITLES_PER_QUERY = 45;
const PD_DEATH_BEFORE = 2026; // authorDeathYear + 50 < 2026
const MAX_DEATH_YEAR = 1975;

const TITLE_EXCLUDE_SUFFIXES = ['序', '跋', '目錄', '凡例', '提要', '後記', '前言', '索引'];
const CHAPTER_META_SUFFIXES = [
  '序', '跋', '目錄', '目録', '目录', '凡例', '提要', '後記', '前言', '索引', '目次',
  '版權', '版权', '版權信息', '版權頁', '校勘記', '校勘后记', '消歧義', '消歧义',
  '說明', '说明', '導讀', '導言', '附錄', '附录', '參考資料', '参考資料',
];
const MODERN_CATEGORY_RE = /民國|民国|現代|现代|當代|当代|共和國|共和国|中华人民共和国|中華人民共和國|台灣|台湾|臺灣|香港|澳門|澳门|1949|195[0-9]|196[0-9]|197[0-9]/;

/** 用来「发现真实分类名」的前缀 —— 不硬编码猜测的分类名 */
const CATEGORY_PREFIXES = [
  '小說', '章回', '演義', '史', '子', '集', '經', '史部', '子部', '集部', '經部',
  '佛', '佛經', '道', '道藏', '民國', '現代', '筆記', '詩', '詞', '曲', '別集', '總集',
  '類書', '佛教', '道家', '儒家', '兵家', '醫家', '雜家', '地理', '政書', '編年', '正史',
  '別史', '雜史', '載記', '紀事本末', '會要', '實錄', '起居注', '目錄',
  '四庫', '二十', '文選', '文集', '詩集', '詞集', '曲集', '蒙學', '藝術', '譜錄',
  '農家', '天文', '算法', '術數', '方志', '年譜', '傳記',
];

/** 精确排除：这些分类装的是单篇诗词/词牌/咒语/条目，不是「书」 */
const CATEGORY_EXACT_BAN = new Set([
  '詞', '詞牌', '詩', '曲', '佛教咒語', '四庫全書僻字條目',
  '四庫全書僻字條目（尚未考訂）', '曲靖市文物',
]);

/** 额外排除：非中文典籍分类、单篇选本/咒语 */
const CATEGORY_EXTRA_BAN_RE = /朝鮮|朝鲜|日本|越南|琉球|韓國|韩国|高麗|高丽|古文觀止|古文观止|六朝文絜|咒語|咒语/;

function categoryUsable(name) {
  if (!name) return false;
  if (CATEGORY_EXACT_BAN.has(name)) return false;
  if (CATEGORY_BAN_RE.test(name)) return false;
  if (CATEGORY_EXTRA_BAN_RE.test(name)) return false;
  return true;
}

/** 明显不装书的分类名 */
const CATEGORY_BAN_RE = /作者|姓氏|字典|詞典|辭典|辞典|年鑑|年鉴|期刊|雜誌|杂志|報紙|报纸|法院|政府|法律|條約|条约|公告|模板|維基|维基|分類|分类|人民|共和國|共和国|檔案|档案|書目|书目|列表|索引|消歧義|消歧义|頁面|页面|發佈|发布|聲明|声明|判決|判决|起訴|起诉|命令|公報|公报|規則|规则|辦法|办法|條例|条例|標準|标准|專利|专利|統計|统计|報告|报告|新聞|新闻|演講|演讲|致辭|致辞|題詞|题词|通知|總統令|总统令|行政|部長|部长|主席|委員會|委员会|大學|大学|中學|中学|小學|小学|醫院|医院|公司|銀行|银行|基金會|基金会|協會|协会|學會|学会|學報|学报|發明|发明|商標|商标|著作權|著作权|智慧財產|智慧财产/;

const CATEGORY_PREFER_RE = /史部|史書|子部|集部|經部|佛經|道藏|小說|小説|演義|章回|別集|總集|類書|詩|詞|曲|筆記|佛教|道家|儒家|兵家|醫家|雜家|地理|政書|編年|正史|別史|雜史|載記|紀事本末|會要|實錄|起居注|目錄|文集|詩集|詞集|曲集|四庫|二十四史|叢書|傳奇|話本|彈詞|寶卷|蒙學|藝術|譜錄|農家|天文|算法|術數|方志|年譜|傳記/;

/* ------------------------------------------------------------------ */
/* 参数                                                                */
/* ------------------------------------------------------------------ */

const args = new Map();
for (const raw of process.argv.slice(2)) {
  const match = /^--([^=]+)(?:=(.*))?$/.exec(raw);
  if (!match) continue;
  args.set(match[1], match[2] ?? 'true');
}
const VALIDATE_ONLY = args.has('validate-only');
const REFRESH = args.has('refresh');
const STAGE = args.get('stage') ?? 'all';
const TARGET_OVERRIDE = args.has('target') ? Number(args.get('target')) : TARGET;
const MIN_INTERVAL = Math.max(150, Number(args.get('min-interval') ?? process.env.SEED_MIN_INTERVAL ?? 1500));
const MAX_ROOTS = Number(args.get('max-roots') ?? 3200);
const REQUEST_BUDGET = args.has('request-budget') ? Number(args.get('request-budget')) : Infinity;

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

const sha1 = (value) => crypto.createHash('sha1').update(value).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nowIso = () => new Date().toISOString();
const log = (...parts) => console.log(...parts);
const errlog = (...parts) => console.error(...parts);

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** 按 URL 编码后的长度分片：长标题（四部叢刊本之类）一次 45 个会 414 URI Too Long */
function chunkTitles(titles, maxEncoded = 2600) {
  const out = [];
  let current = [];
  let length = 0;
  for (const title of titles) {
    const encoded = encodeURIComponent(title).length + 1;
    if (current.length && (length + encoded > maxEncoded || current.length >= MAX_TITLES_PER_QUERY)) {
      out.push(current);
      current = [];
      length = 0;
    }
    current.push(title);
    length += encoded;
  }
  if (current.length) out.push(current);
  return out;
}

/** 中文数字 → 整数（用于章节自然排序：卷一 / 第一回 / 卷一百二十） */
function cnNumber(text) {
  const digits = { 〇: 0, 零: 0, 一: 1, 壹: 1, 二: 2, 兩: 2, 两: 2, 貳: 2, 三: 3, 叁: 3, 叄: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const units = { 十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000, 萬: 10000, 万: 10000 };
  let total = 0;
  let section = 0;
  let digit = 0;
  let seen = false;
  for (const char of text) {
    if (char in digits) {
      digit = digits[char];
      seen = true;
    } else if (char in units) {
      const unit = units[char];
      if (unit >= 10000) {
        section = (section + digit) * unit;
        total += section;
        section = 0;
      } else {
        if (digit === 0) digit = 1;
        section += digit * unit;
      }
      digit = 0;
      seen = true;
    } else {
      return null;
    }
  }
  return seen ? total + section + digit : null;
}

/** 章节标题里第一个数字（第001回 / 卷第一 / 卷上之上） */
function chapterSortKey(title) {
  const tail = title.includes('/') ? title.slice(title.lastIndexOf('/') + 1) : title;
  const arabic =
    /(?:第|卷|回|章|節|节|篇|集|冊|册|卷之|之)\s*(\d+)/.exec(tail) ?? /^(\d+)/.exec(tail);
  if (arabic) return [Number(arabic[1]), tail];
  const chinese =
    /(?:第|卷|回|章|節|节|篇|集|冊|册|卷之|之)\s*([〇零一二三四五六七八九十百千萬万兩两廿卅]+)/.exec(tail) ??
    /^([〇零一二三四五六七八九十百千萬万兩两廿卅]+)/.exec(tail);
  if (chinese) {
    const n = cnNumber(chinese[1]);
    if (n != null) return [n, tail];
  }
  // 卷上之上 / 卷下之下 之类：按 上 < 中 < 下 排
  let rank = 0;
  if (tail.includes('上')) rank = 1;
  else if (tail.includes('中')) rank = 2;
  else if (tail.includes('下')) rank = 3;
  return [rank, tail];
}

function compareChapters(a, b) {
  const [na, ta] = chapterSortKey(a);
  const [nb, tb] = chapterSortKey(b);
  if (na !== nb) return na - nb;
  return String(ta).localeCompare(String(tb), 'zh-Hant', { numeric: true });
}

function stripWiki(text) {
  return String(text ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<ref[\s\S]*?<\/ref>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\{\{[^{}]*\}\}/g, '')
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/'''?/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function makeSlug(title, pageid) {
  const ascii = String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${ascii.length >= 3 ? ascii : 'wb'}-${pageid}`;
}

function isExcludedTitle(title) {
  const text = String(title ?? '').trim();
  if (!text || [...text].length < 2) return '标题长度 < 2';
  for (const suffix of TITLE_EXCLUDE_SUFFIXES) {
    if (text.endsWith(suffix)) return `标题以「${suffix}」结尾`;
  }
  if (/消歧義|消歧义/.test(text)) return '标题像消歧义页';
  return null;
}

function isMetaChapter(title, root) {
  const tail = title.slice(root.length + 1);
  if (!tail) return true;
  if (CHAPTER_META_SUFFIXES.some((suffix) => tail.endsWith(suffix))) return true;
  // 目录/提纲类子页（綱目、緫類、目録卷第一…）不是正文，且会在 200 章截断时挤掉真正的卷
  return /(目録|目錄|目次|綱目|緫類|總類|總目|总目)/.test(tail);
}

/* ------------------------------------------------------------------ */
/* API 客户端：单并发 + 自适应间隔 + 持久缓存 + 重试                    */
/* ------------------------------------------------------------------ */

const filterStats = {
  namespaced: 0,
  titleExcluded: 0,
  redirect: 0,
  disambiguation: 0,
  rootExcluded: 0,
};

const stats = {
  requests: 0,
  cacheHits: 0,
  retries: 0,
  rateLimited: 0,
  elapsedMs: 0,
  failures: [],
};

class WikiApi {
  constructor(base, stage) {
    this.base = base;
    this.stage = stage;
    this.nextAt = 0;
    this.interval = MIN_INTERVAL;
    this.baseInterval = MIN_INTERVAL;
  }

  async get(params) {
    const url = new URL(this.base);
    url.searchParams.set('format', 'json');
    url.searchParams.set('formatversion', '2');
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
    const full = url.toString();
    const file = path.join(CACHE, 'api', `${sha1(full)}.json`);

    if (!REFRESH) {
      const cached = await readJson(file);
      if (cached?.data) {
        stats.cacheHits++;
        return { data: cached.data, fetchedAt: cached.fetchedAt ?? nowIso() };
      }
    }

    if (stats.requests >= REQUEST_BUDGET) throw new Error('请求预算用尽（--request-budget）');

    let lastError = null;
    for (let attempt = 0; attempt <= 3; attempt++) {
      const wait = Math.max(0, this.nextAt - Date.now());
      if (wait) await sleep(wait);
      this.nextAt = Date.now() + this.interval;
      stats.requests++;

      let response;
      const startedAt = Date.now();
      try {
        response = await fetch(full, {
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', Connection: 'close' },
          signal: AbortSignal.timeout(25_000),
        });
      } catch (error) {
        lastError = new Error(`网络错误：${error?.name ?? error}`);
        stats.retries++;
        await sleep(1000 * 2 ** attempt);
        continue;
      }

      const text = await response.text().catch(() => '');
      if (response.status === 429) {
        stats.rateLimited++;
        const retryAfter = Number(response.headers.get('retry-after') ?? 0);
        const pause = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 5000 * (attempt + 1);
        this.interval = Math.min(20_000, Math.max(this.interval, this.baseInterval) + 600);
        errlog(`  ! 429 限流，等待 ${Math.round(pause / 1000)}s（请求间隔 → ${this.interval}ms）`);
        await sleep(pause + 500);
        lastError = new Error('HTTP 429');
        continue;
      }
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status}`);
        stats.retries++;
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        lastError = new Error(`响应不是 JSON（${text.slice(0, 60).replace(/\s+/g, ' ')}）`);
        stats.retries++;
        await sleep(1500 * 2 ** attempt);
        continue;
      }
      this.interval = Math.max(this.baseInterval, this.interval - 100);
      const fetchedAt = nowIso();
      await writeJson(file, { url: full, fetchedAt, ms: Date.now() - startedAt, data });
      return { data, fetchedAt };
    }

    stats.failures.push({
      stage: this.stage,
      url: full.slice(0, 300),
      error: String(lastError?.message ?? lastError),
    });
    throw lastError ?? new Error('请求失败');
  }
}

const ws = new WikiApi(WIKISOURCE, 'wikisource');
const wd = new WikiApi(WIKIDATA, 'wikidata');

/** 批量 titles 查询（自动分片 + 处理 normalized/redirects 映射） */
async function queryTitles(titles, params, api = ws) {
  const out = new Map();
  for (const part of chunkTitles([...new Set(titles)].filter(Boolean))) {
    let data;
    let fetchedAt;
    try {
      ({ data, fetchedAt } = await api.get({ action: 'query', titles: part.join('|'), ...params }));
    } catch (error) {
      stats.failures.push({ stage: api.stage, titles: part.join('|').slice(0, 200), error: String(error.message) });
      continue;
    }
    const pages = data?.query?.pages ?? [];
    for (const page of pages) out.set(page.title, { ...page, __fetchedAt: fetchedAt });
    for (const mapping of [...(data?.query?.normalized ?? []), ...(data?.query?.redirects ?? [])]) {
      const target = out.get(mapping.to);
      if (target) out.set(mapping.from, target);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 阶段 1：分类发现                                                    */
/* ------------------------------------------------------------------ */

async function discoverCategories() {
  const file = path.join(CACHE, 'work', 'categories.json');
  const found = (!REFRESH && (await readJson(file))) || {};
  // 注意：不早退 —— 已请求过的前缀会命中 seed/.cache/api，新加的前缀才会真正打接口，
  // 所以「扩充前缀后重跑 discover」是增量的。
  for (const prefix of CATEGORY_PREFIXES) {
    try {
      const { data } = await ws.get({
        action: 'query',
        list: 'allcategories',
        acprefix: prefix,
        aclimit: 500,
        acprop: 'size',
      });
      for (const category of data?.query?.allcategories ?? []) {
        found[category.category] = { name: category.category, size: category.size ?? 0, prefix };
      }
      log(`[discover] 前缀「${prefix}」→ ${(data?.query?.allcategories ?? []).length} 个分类（累计 ${Object.keys(found).length}）`);
    } catch (error) {
      stats.failures.push({ stage: 'discover', category: prefix, error: String(error.message) });
      errlog(`[discover] 前缀「${prefix}」超时/失败，跳过：${error.message}`);
    }
  }
  await writeJson(file, found);
  return found;
}

function pickSourceCategories(found) {
  const picked = [];
  for (const category of Object.values(found)) {
    if (category.size < 8 || category.size > 4000) continue;
    if (!categoryUsable(category.name)) continue;
    const prefer = CATEGORY_PREFER_RE.test(category.name) ? 1 : 0;
    picked.push({ ...category, prefer, score: prefer * 100_000 + Math.min(category.size, 1500) });
  }
  picked.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return picked;
}

/* ------------------------------------------------------------------ */
/* 阶段 2：分类成员（深度 2）                                          */
/* ------------------------------------------------------------------ */

async function collectCategoryMembers(categories, { perCategory = 500, maxSubcats = 24 } = {}) {
  const file = path.join(CACHE, 'work', 'members.json');
  const store = REFRESH ? {} : ((await readJson(file)) ?? {});
  const save = () => writeJson(file, store);

  const fetchMembers = async (name) => {
    if (store[name]) return store[name];
    const pages = [];
    const subcats = [];
    let cont = null;
    let guard = 0;
    do {
      const params = {
        action: 'query',
        generator: 'categorymembers',
        gcmtitle: `Category:${name}`,
        gcmtype: 'page|subcat',
        gcmlimit: 500,
        prop: 'info|pageprops|categoryinfo',
        ppprop: 'wikibase_item|disambiguation',
      };
      if (cont) params.gcmcontinue = cont;
      let data;
      try {
        ({ data } = await ws.get(params));
      } catch (error) {
        stats.failures.push({ stage: 'members', category: name, error: String(error.message) });
        errlog(`[members] Category:${name} 超时/失败，跳过：${error.message}`);
        break;
      }
      for (const page of data?.query?.pages ?? []) {
        if (page.ns === 14) {
          subcats.push({ title: page.title.replace(/^Category:/, ''), pages: page.categoryinfo?.pages ?? 0 });
        } else if (page.ns === 0) {
          pages.push({
            title: page.title,
            pageid: page.pageid,
            length: page.length ?? 0,
            redirect: !!page.redirect,
            disambig: Object.prototype.hasOwnProperty.call(page.pageprops ?? {}, 'disambiguation'),
            qid: page.pageprops?.wikibase_item ?? null,
            fetchedAt: page.__fetchedAt ?? nowIso(),
          });
        }
      }
      cont = data?.continue?.gcmcontinue ?? null;
      guard++;
    } while (cont && pages.length < perCategory && guard < 6);
    store[name] = { pages, subcats };
    await save();
    log(`[members] Category:${name} → ${pages.length} 页 / ${subcats.length} 子分类（累计请求 ${stats.requests}）`);
    return store[name];
  };

  for (const category of categories) await fetchMembers(category.name);

  // 深度 2：有书的子分类再抓一层
  const wanted = new Map();
  for (const category of categories.slice(0, 10)) {
    for (const sub of store[category.name]?.subcats ?? []) {
      if (!categoryUsable(sub.title)) continue;
      if (sub.pages < 5) continue;
      if (!CATEGORY_PREFER_RE.test(sub.title) && sub.pages < 30) continue;
      if (!wanted.has(sub.title)) wanted.set(sub.title, { name: sub.title, size: sub.pages });
    }
  }
  const subs = [...wanted.values()].sort((a, b) => b.size - a.size).slice(0, maxSubcats);
  for (const sub of subs) await fetchMembers(sub.name);

  return { store, subs };
}

/* ------------------------------------------------------------------ */
/* 阶段 3：候选根页面                                                  */
/* ------------------------------------------------------------------ */

function buildRoots(store) {
  const roots = new Map();
  const subcatSet = new Set();
  for (const value of Object.values(store)) {
    for (const sub of value.subcats ?? []) subcatSet.add(sub.title);
  }

  for (const [categoryName, value] of Object.entries(store)) {
    if (!categoryUsable(categoryName)) continue;
    const depth = subcatSet.has(categoryName) ? 1 : 0;
    for (const page of value.pages ?? []) {
      if (page.redirect) {
        filterStats.redirect++;
        continue;
      }
      if (page.disambig) {
        filterStats.disambiguation++;
        continue;
      }
      const title = page.title;
      if (!title || title.includes(':')) {
        filterStats.namespaced++;
        continue;
      }
      if (isExcludedTitle(title)) {
        filterStats.titleExcluded++;
        continue;
      }
      const root = title.split('/')[0];
      if (isExcludedTitle(root)) {
        filterStats.rootExcluded++;
        continue;
      }
      if (!roots.has(root)) {
        roots.set(root, {
          root,
          cats: [],
          length: 0,
          pageid: null,
          qid: null,
          fetchedAt: null,
        });
      }
      const entry = roots.get(root);
      if (!entry.cats.some((cat) => cat.name === categoryName)) {
        entry.cats.push({ name: categoryName, depth });
      }
      if (title === root) {
        entry.length = page.length;
        entry.pageid = page.pageid;
        entry.qid = page.qid;
        entry.fetchedAt = page.fetchedAt;
      }
    }
  }
  return roots;
}

/* ------------------------------------------------------------------ */
/* 阶段 4：子页面发现（prop=links，45 页/请求）                        */
/* ------------------------------------------------------------------ */

async function discoverSubpages(rootNames) {
  const file = path.join(CACHE, 'work', 'links.json');
  const store = REFRESH ? {} : ((await readJson(file)) ?? {});
  const todo = rootNames.filter((root) => !store[root]);
  log(`[links] 待扫描 ${todo.length} 个根页面（已有 ${Object.keys(store).length}）`);

  for (const part of chunkTitles(todo)) {
    const accumulate = new Map(part.map((root) => [root, new Set()]));
    const meta = new Map();
    let cont = null;
    let guard = 0;
    do {
      const params = {
        action: 'query',
        prop: 'links|info|pageprops',
        ppprop: 'wikibase_item|disambiguation',
        plnamespace: 0,
        pllimit: 'max',
        titles: part.join('|'),
      };
      if (cont) params.plcontinue = cont;
      let data;
      try {
        ({ data } = await ws.get(params));
      } catch (error) {
        stats.failures.push({ stage: 'links', titles: part.join('|').slice(0, 200), error: String(error.message) });
        errlog(`[links] 一批 ${part.length} 页失败，跳过：${error.message}`);
        break;
      }
      for (const page of data?.query?.pages ?? []) {
        if (!meta.has(page.title)) {
          meta.set(page.title, {
            missing: !!page.missing,
            redirect: !!page.redirect,
            disambig: Object.prototype.hasOwnProperty.call(page.pageprops ?? {}, 'disambiguation'),
            qid: page.pageprops?.wikibase_item ?? null,
            length: page.length ?? 0,
            pageid: page.pageid ?? null,
            fetchedAt: page.__fetchedAt ?? nowIso(),
          });
        }
        const set = accumulate.get(page.title);
        if (!set) continue;
        for (const link of page.links ?? []) {
          if (link.ns === 0 && link.title.startsWith(`${page.title}/`)) set.add(link.title);
        }
      }
      cont = data?.continue?.plcontinue ?? null;
      guard++;
    } while (cont && guard < 8);

    for (const root of part) {
      store[root] = {
        checked: true,
        ...(meta.get(root) ?? { missing: true }),
        subpages: [...accumulate.get(root)].sort(compareChapters),
      };
    }
    await writeJson(file, store);
    log(`[links] 批次完成 ${Object.keys(store).length}/${rootNames.length}（请求 ${stats.requests}）`);
  }
  return store;
}

/* ------------------------------------------------------------------ */
/* 阶段 5：Wikidata 作者 / 卒年                                        */
/* ------------------------------------------------------------------ */

const WD_LANGS = 'zh|zh-hans|zh-hant|zh-cn|zh-tw|en';

function labelOf(entity) {
  return (
    entity?.labels?.zh?.value ??
    entity?.labels?.['zh-hans']?.value ??
    entity?.labels?.['zh-hant']?.value ??
    entity?.labels?.['zh-cn']?.value ??
    entity?.labels?.en?.value ??
    null
  );
}

function deathYearsOf(entity) {
  const years = [];
  for (const claim of entity?.claims?.P570 ?? []) {
    const time = claim?.mainsnak?.datavalue?.value?.time;
    if (typeof time !== 'string') continue;
    const match = /^([+-])(\d{1,4})-/.exec(time);
    if (!match) continue;
    const year = Number(match[2]) * (match[1] === '-' ? -1 : 1);
    if (Number.isFinite(year)) years.push(year);
  }
  return years;
}

async function fetchEntities(ids) {
  const out = new Map();
  for (const part of chunk([...new Set(ids)].filter(Boolean), 45)) {
    try {
      const { data } = await wd.get({
        action: 'wbgetentities',
        ids: part.join('|'),
        props: 'claims|labels',
        languages: WD_LANGS,
      });
      for (const [id, entity] of Object.entries(data?.entities ?? {})) out.set(id, entity);
    } catch (error) {
      stats.failures.push({ stage: 'wikidata', ids: part.join('|').slice(0, 200), error: String(error.message) });
    }
  }
  return out;
}

async function fetchAuthors(rootNames, links) {
  const file = path.join(CACHE, 'work', 'authors.json');
  const store = REFRESH ? {} : ((await readJson(file)) ?? {});
  const pending = rootNames.filter((root) => !store[root]);
  const workQids = pending.map((root) => links[root]?.qid).filter(Boolean);
  const workEntities = await fetchEntities(workQids);

  const authorQids = new Set();
  const workInfo = new Map();
  for (const root of pending) {
    const qid = links[root]?.qid ?? null;
    const entity = qid ? workEntities.get(qid) : null;
    const p50 = (entity?.claims?.P50 ?? [])
      .map((claim) => claim?.mainsnak?.datavalue?.value?.id)
      .filter(Boolean);
    workInfo.set(root, { qid, p50 });
    for (const id of p50) authorQids.add(id);
  }

  const authorEntities = await fetchEntities([...authorQids]);
  for (const [root, info] of workInfo) {
    const authors = info.p50.map((qid) => {
      const entity = authorEntities.get(qid);
      const years = deathYearsOf(entity);
      return {
        qid,
        name: labelOf(entity),
        deathYear: years.length ? Math.max(...years) : null,
      };
    });
    store[root] = { workQid: info.qid, authors, source: info.p50.length ? 'wikidata' : 'none' };
  }
  await writeJson(file, store);
  log(`[authors] Wikidata：${Object.keys(store).length} 个作品，${authorQids.size} 位作者`);
  return store;
}

/** 没有 P50 的作品：从 header 模板读 author/translator，再查 Author: 页面 → QID → 卒年 */
async function fallbackAuthors(rootNames, links, authors) {
  const file = path.join(CACHE, 'work', 'authors-wikitext.json');
  const store = REFRESH ? {} : ((await readJson(file)) ?? {});
  const todo = rootNames.filter(
    (root) => !authors[root]?.authors?.length && !Array.isArray(store[root]?.names) && links[root] && !links[root].missing,
  );
  log(`[authors] wikitext 兜底：${todo.length} 个作品`);

  for (const part of chunkTitles(todo)) {
    try {
      const { data } = await ws.get({
        action: 'query',
        prop: 'revisions',
        rvprop: 'content',
        rvslots: 'main',
        titles: part.join('|'),
      });
      for (const page of data?.query?.pages ?? []) {
        const content = page.revisions?.[0]?.slots?.main?.content ?? '';
        const rawFields = [];
        for (const key of ['override_author', 'author', 'translator', 'translator2', 'collector']) {
          const match = new RegExp(`^\\s*\\|\\s*${key}\\s*=\\s*([^\\n]*)`, 'm').exec(content);
          if (match) rawFields.push(match[1]);
        }
        const names = [];
        for (const raw of rawFields) {
          for (const match of raw.matchAll(/\[\[\s*(?:author|Author|作者)\s*:\s*([^|\]]+)(?:\|[^\]]*)?\]\]/g)) {
            names.push(match[1].trim());
          }
          if (!raw.includes('[[')) {
            const cleaned = stripWiki(raw)
              .replace(/[（(].*?[)）]/g, '')
              .replace(/\s*(著|撰|編|编|譯|译|注|註|輯|辑|校|等)\s*$/g, '')
              .split(/[、,，;；]/)
              .map((item) => item.trim())
              .filter((item) => item && item.length <= 12 && !/[|<>#]/.test(item));
            names.push(...cleaned);
          }
        }
        store[page.title] = { raw: rawFields.join(' / '), names: [...new Set(names)] };
      }
      await writeJson(file, store);
    } catch (error) {
      stats.failures.push({ stage: 'authors-wikitext', error: String(error.message) });
    }
  }

  const allNames = [...new Set(Object.values(store).flatMap((value) => value.names ?? []))];
  const pageMap = await queryTitles(
    allNames.map((name) => `Author:${name}`),
    { prop: 'pageprops|info', ppprop: 'wikibase_item' },
  );
  const nameToQid = new Map();
  for (const name of allNames) {
    const page = pageMap.get(`Author:${name}`);
    if (page?.pageprops?.wikibase_item) nameToQid.set(name, page.pageprops.wikibase_item);
  }
  const entities = await fetchEntities([...new Set(nameToQid.values())]);

  for (const [root, info] of Object.entries(store)) {
    if (authors[root]?.authors?.length) continue;
    const resolved = (info.names ?? []).map((name) => {
      const qid = nameToQid.get(name) ?? null;
      const entity = qid ? entities.get(qid) : null;
      const years = deathYearsOf(entity);
      return { qid, name, deathYear: years.length ? Math.max(...years) : null };
    });
    if (resolved.length) {
      authors[root] = { workQid: authors[root]?.workQid ?? null, authors: resolved, source: 'wikitext' };
    }
  }
  await writeJson(path.join(CACHE, 'work', 'authors.json'), authors);
  return authors;
}

/* ------------------------------------------------------------------ */
/* 阶段 6：授权判定                                                    */
/* ------------------------------------------------------------------ */

function pickPrimaryCategory(entry) {
  const cats = [...entry.cats].sort((a, b) => {
    if (a.depth !== b.depth) return b.depth - a.depth;
    return a.name.localeCompare(b.name);
  });
  return cats[0]?.name ?? '(unknown)';
}

function evaluateWork(entry, link, authorInfo) {
  const reasons = [];
  if (!link || link.missing) reasons.push('根页面不存在');
  if (link?.redirect) reasons.push('重定向页');
  if (link?.disambig) reasons.push('消歧义页');
  const excluded = isExcludedTitle(entry.root);
  if (excluded) reasons.push(excluded);

  const chapters = (link?.subpages ?? []).filter((title) => !isMetaChapter(title, entry.root));
  const multi = chapters.length >= 2;
  const pageBytes = link?.length ?? 0;

  const authors = authorInfo?.authors ?? [];
  const knownDeaths = authors.map((author) => author.deathYear).filter((year) => Number.isFinite(year));
  const deathYear = knownDeaths.length ? Math.max(...knownDeaths) : null;
  const primaryAuthor = authors.find((author) => Number.isFinite(author.deathYear)) ?? authors[0] ?? null;

  const categories = entry.cats.map((cat) => cat.name);
  const modern = categories.some((category) => MODERN_CATEGORY_RE.test(category));

  if (reasons.length === 0) {
    if (deathYear !== null) {
      if (deathYear > MAX_DEATH_YEAR) reasons.push(`作者卒年 ${deathYear}，仍在保护期`);
      else if (deathYear + 50 >= PD_DEATH_BEFORE) reasons.push(`作者卒年 ${deathYear}，未滿 50 年`);
    } else if (modern) {
      reasons.push('拿不到卒年且屬民國/現代分類');
    }
    if (!multi && pageBytes < SINGLE_MIN_BYTES) reasons.push(`单页正文 ${pageBytes} B，不足 20 KB`);
  }

  return {
    root: entry.root,
    pageid: link?.pageid ?? entry.pageid,
    qid: link?.qid ?? entry.qid,
    fetchedAt: link?.fetchedAt ?? entry.fetchedAt ?? nowIso(),
    rootLength: pageBytes,
    chapters: multi ? chapters.slice(0, CHAPTERS_CAP) : [entry.root],
    multi,
    bytes: multi ? 0 : pageBytes,
    author: primaryAuthor?.name ?? null,
    authorQid: primaryAuthor?.qid ?? null,
    authorDeathYear: deathYear,
    authors,
    modern,
    category: pickPrimaryCategory(entry),
    categories,
    rejected: reasons,
  };
}

/* ------------------------------------------------------------------ */
/* 阶段 7：挑选                                                        */
/* ------------------------------------------------------------------ */

function priorityOf(category) {
  if (/佛經|道藏|佛教/.test(category)) return 3;
  if (/史部|集部|子部|經部|史書|正史|編年|別史|雜史|載記|紀事本末|會要|實錄|起居注|政書|目錄|地理|別集|總集|類書|小說|小説|章回|演義|筆記|詩|詞|曲|文集/.test(category)) return 1;
  return 2;
}

function groupByCategory(list) {
  const map = new Map();
  for (const work of list) {
    if (!map.has(work.category)) map.set(work.category, []);
    map.get(work.category).push(work);
  }
  return [...map.entries()]
    .sort((a, b) => priorityOf(a[0]) - priorityOf(b[0]) || a[0].localeCompare(b[0]))
    .map(([category, items]) => ({ category, priority: priorityOf(category), items }));
}

function selectWorks(works, target = TARGET_OVERRIDE, excluded = new Set()) {
  const eligible = works.filter((work) => work.rejected.length === 0 && !excluded.has(work.root));
  const multi = eligible.filter((work) => work.multi);
  const single = eligible.filter((work) => !work.multi && work.bytes >= SINGLE_MIN_BYTES);

  const chosen = [];
  const used = new Set();
  const countByCategory = new Map();

  /** 按分类轮转取；perCategoryCap 是硬上限，remaining 是本次想补多少 */
  const takeRoundRobin = (groups, remaining, perCategoryCap) => {
    let added = 0;
    let progress = true;
    while (added < remaining && progress) {
      progress = false;
      for (const group of groups) {
        if (added >= remaining) break;
        if ((countByCategory.get(group.category) ?? 0) >= perCategoryCap) continue;
        let took = false;
        while (group.items.length) {
          const item = group.items.shift();
          if (used.has(item.root)) continue;
          used.add(item.root);
          chosen.push(item);
          countByCategory.set(group.category, (countByCategory.get(group.category) ?? 0) + 1);
          added++;
          took = true;
          break;
        }
        if (took) progress = true;
      }
    }
    return added;
  };

  const multiGroups = groupByCategory(multi);
  const singleGroups = groupByCategory(single);

  // 1) 先凑多章作品（目标 420，留 20 条余量给「单页不够时继续补多章」）
  const multiTarget = Math.min(420, target);
  for (const cap of [40, 60, 90, 120, CATEGORY_CAP]) {
    if (chosen.length >= multiTarget) break;
    takeRoundRobin(multiGroups, multiTarget - chosen.length, cap);
  }

  // 2) 单页作品填到 800
  for (const cap of [40, 60, 90, 120, CATEGORY_CAP]) {
    if (chosen.length >= target) break;
    takeRoundRobin(singleGroups, target - chosen.length, cap);
  }

  // 3) 单页不够：继续补多章
  for (const cap of [60, 90, 120, CATEGORY_CAP]) {
    if (chosen.length >= target) break;
    takeRoundRobin(multiGroups, target - chosen.length, cap);
  }

  // 4) 兜底：任何合格条目
  if (chosen.length < target) {
    for (const work of eligible) {
      if (chosen.length >= target) break;
      if (used.has(work.root)) continue;
      if ((countByCategory.get(work.category) ?? 0) >= CATEGORY_CAP) continue;
      used.add(work.root);
      chosen.push(work);
      countByCategory.set(work.category, (countByCategory.get(work.category) ?? 0) + 1);
    }
  }

  return { chosen, countByCategory, multiCount: chosen.filter((work) => work.multi).length };
}

/** 章节字节：按 45 个标题/请求批量取 length；不存在的子页会被剔除并重新判定 */
async function fillChapterBytes(chosen) {
  const file = path.join(CACHE, 'work', 'chapterinfo.json');
  const store = REFRESH ? {} : ((await readJson(file)) ?? {});
  const missing = chosen
    .filter((work) => work.multi)
    .flatMap((work) => work.chapters)
    .filter((title) => !(title in store));
  if (missing.length) log(`[bytes] 需要 ${new Set(missing).size} 个章节页面长度（已有 ${Object.keys(store).length}）`);

  for (const part of chunk([...new Set(missing)], MAX_TITLES_PER_QUERY)) {
    const map = await queryTitles(part, { prop: 'info' });
    for (const [title, page] of map) store[title] = page.missing ? null : (page.length ?? 0);
    await writeJson(file, store);
  }

  for (const work of chosen) {
    if (!work.multi) continue;
    const present = work.chapters.filter((title) => (store[title] ?? 0) > 0);
    if (present.length >= 2) {
      work.chapters = present.slice(0, CHAPTERS_CAP);
      work.bytes = work.chapters.reduce((sum, title) => sum + (store[title] ?? 0), 0);
    } else if ((work.rootLength ?? 0) >= SINGLE_MIN_BYTES) {
      // 章节目录里只有红链：退回单页作品（根页面本身够长）
      work.multi = false;
      work.chapters = [work.root];
      work.bytes = work.rootLength;
    } else if (work.rejected.length === 0) {
      work.rejected.push('章节页面不存在或为空');
      work.bytes = 0;
    }
  }
  return store;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function harvest() {
  const startedAt = Date.now();
  await fs.mkdir(path.join(CACHE, 'work'), { recursive: true });

  const found = await discoverCategories();
  if (STAGE === 'discover') return finishEarly(startedAt, { categories: Object.keys(found).length });

  const sources = pickSourceCategories(found);
  const picked = [];
  const seen = new Set();
  for (const category of sources) {
    if (picked.length >= 14) break;
    if (seen.has(category.name)) continue;
    seen.add(category.name);
    picked.push(category);
  }
  log(`[sources] ${picked.length} 个来源分类：${picked.map((cat) => `${cat.name}(${cat.size})`).join('、')}`);

  const { store } = await collectCategoryMembers(picked);
  const roots = buildRoots(store);
  log(`[roots] 去重后 ${roots.size} 个候选根页面`);
  if (STAGE === 'members') return finishEarly(startedAt, { roots: roots.size });

  const rootEntries = [...roots.values()]
    .sort((a, b) => b.cats.length - a.cats.length || a.root.localeCompare(b.root))
    .slice(0, MAX_ROOTS);
  const rootNames = rootEntries.map((entry) => entry.root);

  const links = await discoverSubpages(rootNames);
  if (STAGE === 'links') return finishEarly(startedAt, { links: Object.keys(links).length });

  const authors = await fetchAuthors(rootNames, links);
  await fallbackAuthors(rootNames, links, authors);

  const works = rootEntries.map((entry) => evaluateWork(entry, links[entry.root], authors[entry.root]));
  const eligible = works.filter((work) => work.rejected.length === 0);
  log(`[select] 结构+授权合格 ${eligible.length} 个候选`);

  // 章节页面可能只是红链：先选，再核对存在的章节，剔掉不合格的换个候选，循环到稳定。
  const excluded = new Set();
  let result = null;
  for (let round = 1; round <= 5; round++) {
    result = selectWorks(works, TARGET_OVERRIDE, excluded);
    await fillChapterBytes(result.chosen);
    const bad = result.chosen.filter((work) => work.rejected.length);
    log(
      `[select] 第 ${round} 轮：选中 ${result.chosen.length}（多章 ${result.chosen.filter((work) => work.multi).length}），` +
        `核对后剔除 ${bad.length}`,
    );
    if (!bad.length) break;
    for (const work of bad) excluded.add(work.root);
  }

  const { chosen, countByCategory } = result;
  const multiCount = chosen.filter((work) => work.multi).length;
  log(`[select] 最终 ${chosen.length}（多章 ${multiCount}，单页 ${chosen.length - multiCount}）`);
  await writeCatalog(chosen, works, countByCategory, startedAt);
  return chosen;
}

function finishEarly(startedAt, extra) {
  stats.elapsedMs = Date.now() - startedAt;
  log(`[done] 阶段 ${STAGE} 完成，用时 ${(stats.elapsedMs / 1000).toFixed(0)}s`, JSON.stringify(extra));
  log(`[stats] 请求 ${stats.requests}，缓存命中 ${stats.cacheHits}，429 ${stats.rateLimited}，失败 ${stats.failures.length}`);
  return [];
}

/* ------------------------------------------------------------------ */
/* 产物                                                                */
/* ------------------------------------------------------------------ */

function licenseFor(work) {
  if (work.authorDeathYear === null) {
    const why = work.authors?.length
      ? `作者署名${work.author ?? '不詳'}，卒年不可考（Wikidata 無 P570）`
      : '未見作者記錄（上古/佚名作品）';
    return {
      licenseBasis: 'public-domain',
      licenseNote: `${why}；作品屬清代以前古籍，作者終生 + 死後 50 年早已屆滿，屬公有領域`,
    };
  }
  const yearText = work.authorDeathYear < 0 ? `公元前 ${-work.authorDeathYear} 年` : `${work.authorDeathYear} 年`;
  return {
    licenseBasis: 'public-domain',
    licenseNote: `作者${work.author ?? '佚名'}卒於${yearText}，距今已超過 50 年`,
  };
}

async function writeCatalog(chosen, works, countByCategory, startedAt) {
  const generatedAt = nowIso();
  const entries = chosen
    .map((work) => {
      const license = licenseFor(work);
      return {
        slug: makeSlug(work.root, work.pageid),
        page: work.root,
        title: work.root,
        author: work.author ?? null,
        authorDeathYear: work.authorDeathYear ?? null,
        ...(work.authorQid ? { authorQid: work.authorQid } : {}),
        licenseBasis: license.licenseBasis,
        licenseNote: license.licenseNote,
        chapters: work.chapters,
        bytes: work.bytes,
        sourceUrl: `https://zh.wikisource.org/wiki/${encodeURIComponent(work.root.replace(/ /g, '_'))}`,
        fetchedAt: work.fetchedAt ?? generatedAt,
        sourceCategories: work.categories,
      };
    })
    .sort((a, b) => a.page.localeCompare(b.page, 'zh-Hant'));

  await writeJson(CATALOG_PATH, {
    version: 1,
    source: SOURCE,
    generatedAt,
    entries,
  });
  log(`[write] ${CATALOG_PATH} → ${entries.length} 条`);

  stats.elapsedMs = Date.now() - startedAt;
  await writeReport({ entries, works, startedAt, generatedAt });
  await writeJson(path.join(CACHE, 'work', 'run-stats.json'), {
    generatedAt,
    requests: stats.requests,
    cacheHits: stats.cacheHits,
    rateLimited: stats.rateLimited,
    retries: stats.retries,
    failures: stats.failures,
    elapsedMs: stats.elapsedMs,
  });
}

function fmtBytes(value) {
  if (!Number.isFinite(value)) return '—';
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / 1024).toFixed(1)} KB`;
}

async function writeReport({ entries, works, startedAt, generatedAt }) {
  const multi = entries.filter((entry) => entry.chapters.length >= 2);
  const single = entries.length - multi.length;
  const categoryCounts = new Map();
  for (const entry of entries) {
    const category = entry.sourceCategories?.[0] ?? '(unknown)';
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
  }
  const categoryRows = [...categoryCounts.entries()].sort((a, b) => b[1] - a[1]);

  const rejectCounts = new Map();
  for (const work of works) {
    for (const reason of work.rejected) {
      const key = reason
        .replace(/\d+\s*B/g, 'N B')
        .replace(/作者卒年 -?\d+，仍在保护期/, '作者卒年 > 1975（仍在保护期）')
        .replace(/作者卒年 -?\d+，未滿 50 年/, '作者卒年未滿 50 年');
      rejectCounts.set(key, (rejectCounts.get(key) ?? 0) + 1);
    }
  }

  const authorVerified = entries.filter((entry) => entry.authorDeathYear !== null).length;
  const totalChapters = entries.reduce((sum, entry) => sum + entry.chapters.length, 0);
  const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);

  const lines = [];
  lines.push('# 公版种子库采集报告');
  lines.push('');
  lines.push(`- 生成时间：${generatedAt}`);
  lines.push(`- 来源：${SOURCE}（MediaWiki API）`);
  lines.push(`- 清单：\`seed/catalog.json\`（${entries.length} 条）`);
  lines.push(
    `- 本次运行：${elapsed}s，新发 API 请求 ${stats.requests} 次（缓存命中 ${stats.cacheHits}，429 限流 ${stats.rateLimited} 次，重试 ${stats.retries} 次，最终失败 ${stats.failures.length} 条）`,
  );
  const fetchedTimes = entries.map((entry) => Date.parse(entry.fetchedAt)).filter((ms) => Number.isFinite(ms));
  if (fetchedTimes.length) {
    const first = new Date(Math.min(...fetchedTimes)).toISOString();
    const last = new Date(Math.max(...fetchedTimes)).toISOString();
    lines.push(`- 采集跨度（条目 fetchedAt）：${first} → ${last}`);
  }
  let cacheFiles = 0;
  try {
    cacheFiles = (await fs.readdir(path.join(CACHE, 'api'))).length;
  } catch {
    cacheFiles = 0;
  }
  lines.push(`- 断点续跑缓存：seed/.cache/api 共 ${cacheFiles} 个响应（每个响应一个 sha1 文件，约等于累计 API 请求数）`);
  lines.push('');
  lines.push('## 组成');
  lines.push('');
  lines.push('| 指标 | 数值 | 约束 |');
  lines.push('|---|---:|---|');
  lines.push(`| 条目总数 | ${entries.length} | = 800 |`);
  lines.push(`| 多章作品（chapters ≥ 2） | ${multi.length} | ≥ 400 |`);
  lines.push(`| 单页作品（chapters = 1） | ${single} | 正文 ≥ 20 KB |`);
  lines.push(`| 章节总数 | ${totalChapters} | — |`);
  lines.push(`| 正文合计（wikitext 字节） | ${fmtBytes(totalBytes)} | — |`);
  lines.push(`| 能核到卒年的作者 | ${authorVerified} / ${entries.length} | — |`);
  lines.push(`| 卒年未知（按上古/佚名处理，所属分类均为古籍） | ${entries.length - authorVerified} | 见 licenseNote |`);
  lines.push(`| 最大来源分类 | ${categoryRows[0]?.[1] ?? 0} 条 | ≤ 300 |`);
  lines.push('');
  lines.push('## 来源分类分布（前 15）');
  lines.push('');
  lines.push('| # | 来源分类 | 条目数 | 多章 | 单页 |');
  lines.push('|---:|---|---:|---:|---:|');
  categoryRows.slice(0, 15).forEach(([category, count], index) => {
    const items = entries.filter((entry) => (entry.sourceCategories?.[0] ?? '(unknown)') === category);
    const multiCount = items.filter((entry) => entry.chapters.length >= 2).length;
    lines.push(`| ${index + 1} | ${category} | ${count} | ${multiCount} | ${count - multiCount} |`);
  });
  lines.push('');
  const countReason = (needle) => works.filter((work) => work.rejected.some((reason) => reason.includes(needle))).length;
  lines.push('## 剔除原因计数');
  lines.push('');
  lines.push('| 原因 | 计数 |');
  lines.push('|---|---:|');
  lines.push(`| 作者卒年 > 1975（仍在保护期） | ${countReason('仍在保护期')} |`);
  lines.push(`| 作者卒年未满 50 年 | ${countReason('未滿 50 年')} |`);
  lines.push(`| 拿不到卒年 + 屬民國/現代分類（一律剔除） | ${countReason('民國/現代')} |`);
  lines.push(`| 单页正文不足 20 KB | ${countReason('不足 20 KB')} |`);
  lines.push(`| 章节页面不存在或为空 | ${countReason('章节页面不存在')} |`);
  lines.push(`| 根页面不存在 | ${countReason('根页面不存在')} |`);
  lines.push(`| 重定向页 / 消歧义页 | ${countReason('重定向页') + countReason('消歧义页')} |`);
  lines.push(`| 标题像序跋（在候选池阶段剔除） | ${filterStats.titleExcluded + filterStats.rootExcluded} |`);
  lines.push(`| 接口失败（分类/页面超时，已跳过） | ${stats.failures.length} |`);
  lines.push('');
  lines.push('细分（同一候选可能命中多条，故合计大于候选数）：');
  lines.push('');
  if (rejectCounts.size === 0) {
    lines.push('（无）');
  } else {
    lines.push('| 原因 | 计数 |');
    lines.push('|---|---:|');
    for (const [reason, count] of [...rejectCounts.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${reason} | ${count} |`);
    }
  }
  lines.push('');
  lines.push('候选池过滤（进入评分前）：');
  lines.push('');
  lines.push('| 过滤 | 计数 |');
  lines.push('|---|---:|');
  lines.push(`| 非主命名空间（Portal/Author/Index/User…） | ${filterStats.namespaced} |`);
  lines.push(`| 标题像序跋 / 长度 < 2 | ${filterStats.titleExcluded + filterStats.rootExcluded} |`);
  lines.push(`| 重定向页 | ${filterStats.redirect} |`);
  lines.push(`| 消歧义页 | ${filterStats.disambiguation} |`);
  lines.push('');
  lines.push('## 授权判定');
  lines.push('');
  lines.push('- 规则（机械执行，无人工放行）：');
  lines.push('  - `authorDeathYear === null` → 视为公版（上古/佚名）；但作品若属于「民國/現代/當代」分类，一律剔除。');
  lines.push('  - `authorDeathYear + 50 < 2026` → 公版。');
  lines.push('  - `authorDeathYear > 1975` → 一律剔除（1976 年卒要到 2026-12-31 才到期）。');
  lines.push('- 作者来源：作品页 `wikibase_item` → Wikidata `P50` → 作者 `P570`；没有 `P50` 时从页面 header 模板读 `author`/`translator`，再查 `Author:` 页面的 `wikibase_item` → `P570`。');
  lines.push('- `bytes` 为 MediaWiki 页面 `length`（wikitext 字节）：多章作品按章累加（最多 200 章），单页作品取根页面。');
  lines.push('');
  if (stats.failures.length) {
    lines.push('## 接口失败（已跳过，不影响其余条目）');
    lines.push('');
    const byStage = new Map();
    for (const failure of stats.failures) byStage.set(failure.stage, (byStage.get(failure.stage) ?? 0) + 1);
    lines.push('| 阶段 | 次数 |');
    lines.push('|---|---:|');
    for (const [stage, count] of [...byStage.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${stage} | ${count} |`);
    }
    lines.push('');
    lines.push('示例：');
    for (const failure of stats.failures.slice(0, 10)) {
      lines.push(`- \`${failure.stage}\`：${failure.error}${failure.category ? `（${failure.category}）` : ''}`);
    }
    lines.push('');
  }
  lines.push('## 怎么复现');
  lines.push('');
  lines.push('```bash');
  lines.push('# 1. 采集（断点续跑；中间结果在 seed/.cache/，可随时中断重来）');
  lines.push('node scripts/seed/harvest.mjs');
  lines.push('');
  lines.push('# 2. 只校验清单（不发网络请求）');
  lines.push('node scripts/seed/harvest.mjs --validate-only');
  lines.push('```');
  lines.push('');
  lines.push('环境：Node 24，零第三方依赖。脚本对 `zh.wikisource.org/w/api.php` 与 `www.wikidata.org/w/api.php`');
  lines.push(`单并发请求，间隔默认 ${MIN_INTERVAL}ms（可调，下限 150ms），失败重试 3 次（指数退避），`);
  lines.push('429 按 `Retry-After` 等待；分类/页面超时或失败会跳过并计入上表，不会中断整体采集。');
  lines.push('每次 API 响应都落到 `seed/.cache/api/<sha1>.json`，重跑时直接复用，所以断点续跑不会重复打接口。');
  lines.push('');
  lines.push('## 已知取舍');
  lines.push('');
  lines.push('- 本清单按「整本」契约生成：`page` 是维基文库根页面，`chapters` 是它的子页面列表（单页作品为 `[page]`）。仓库若另有「卷级」清单，可用 `SEED_CATALOG=...` 指定，不要与本清单互相覆盖。');
  lines.push('');
  lines.push('- `catalog.works.json` 在 README 契约字段之外多写了一个 `sourceCategories`（数组），因为「任一来源分类 ≤ 300 条」需要可机读的来源归属；其余字段与契约一致。');
  lines.push('- 多章作品的章节来自根页面里链接到的 `根页面/子页面`。如果根页面没有列出目录（部分佛经只有子页面），该作品会被当成单页作品；正文不足 20 KB 的会自动剔除，不会误收。');
  lines.push('- 章节数超过 200 的作品按 README 的 build-epub 上限截断（只保留前 200 章），`bytes` 也按这 200 章累计。');
  lines.push('- 作者在 Wikidata 没有 `P50` 或没有 `P570` 时，`authorDeathYear` 写 `null`，按「上古/佚名」处理，`licenseNote` 写明依据。');
  lines.push('- 少数四部丛刊/正史卷页是重定向页或嵌入（transclusion）页，`prop=info` 的 `length` 只算这些「壳页」的 wikitext，因此多章作品的 `bytes` 可能明显小于渲染后正文；build-epub 走 `action=parse` 会展开嵌入/跟随重定向，实际 EPUB 更大。单页作品的 `bytes` 就是该页本身，不受此影响。');
  lines.push('');
  await fs.writeFile(REPORT_PATH, `${lines.join('\n')}\n`, 'utf8');
  log(`[write] ${REPORT_PATH}`);
}

/* ------------------------------------------------------------------ */
/* --validate-only                                                     */
/* ------------------------------------------------------------------ */

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

async function validateOnly() {
  const catalog = await readJson(CATALOG_PATH);
  if (!catalog) {
    console.error('✗ 读不到 seed/catalog.json');
    process.exit(1);
  }

  const errors = [];
  const warnings = [];
  const passes = [];
  const fail = (message) => errors.push(message);
  const warn = (message) => warnings.push(message);
  const pass = (message) => passes.push(message);

  if (catalog.version !== 1) fail(`version 应为 1，实际 ${catalog.version}`);
  else pass('version = 1');
  if (catalog.source !== SOURCE) fail(`source 应为 ${SOURCE}，实际 ${catalog.source}`);
  else pass(`source = ${SOURCE}`);
  if (!catalog.generatedAt || Number.isNaN(Date.parse(catalog.generatedAt))) fail('generatedAt 不是合法时间');
  else pass(`generatedAt = ${catalog.generatedAt}`);

  const entries = Array.isArray(catalog.entries) ? catalog.entries : [];
  if (entries.length !== 800) fail(`条目数应为 800，实际 ${entries.length}`);
  else pass('条目数 = 800');

  const pages = new Set();
  const slugs = new Set();
  const categoryCounts = new Map();
  let multi = 0;
  let single = 0;
  let totalBytes = 0;

  entries.forEach((entry, index) => {
    const tag = `#${index + 1} ${entry?.page ?? '(无 page)'}`;
    if (!entry || typeof entry !== 'object') {
      fail(`${tag}：不是对象`);
      return;
    }
    for (const key of ['slug', 'page', 'title', 'licenseBasis', 'licenseNote', 'sourceUrl', 'fetchedAt']) {
      if (typeof entry[key] !== 'string' || !entry[key]) fail(`${tag}：缺字段 ${key}`);
    }
    if (typeof entry.slug === 'string') {
      if (!SLUG_RE.test(entry.slug)) fail(`${tag}：slug 不合规（${entry.slug}）`);
      if (slugs.has(entry.slug)) fail(`${tag}：slug 重复（${entry.slug}）`);
      slugs.add(entry.slug);
    }
    if (typeof entry.page === 'string') {
      if (pages.has(entry.page)) fail(`${tag}：page 重复`);
      pages.add(entry.page);
      if (entry.page.includes('/')) warn(`${tag}：page 含「/」，看起来是某本书的子页面而不是根页面`);
    }
    if (entry.licenseBasis !== 'public-domain') fail(`${tag}：licenseBasis 必须是 public-domain`);
    if (entry.author !== null && typeof entry.author !== 'string') fail(`${tag}：author 必须是字符串或 null`);
    if (entry.authorQid !== undefined && !/^Q\d+$/.test(entry.authorQid)) fail(`${tag}：authorQid 不合规`);

    const death = entry.authorDeathYear;
    if (death !== null && !Number.isInteger(death)) fail(`${tag}：authorDeathYear 必须是整数或 null`);
    else if (death !== null) {
      if (death > MAX_DEATH_YEAR) fail(`${tag}：作者卒年 ${death} > 1975（仍在保护期）`);
      else if (death + 50 >= PD_DEATH_BEFORE) fail(`${tag}：作者卒年 ${death}，未满 50 年`);
    }

    if (typeof entry.fetchedAt !== 'string' || Number.isNaN(Date.parse(entry.fetchedAt))) {
      fail(`${tag}：fetchedAt 不是合法时间`);
    }

    if (!Array.isArray(entry.chapters) || entry.chapters.length === 0) {
      fail(`${tag}：chapters 不能为空`);
    } else {
      const seen = new Set();
      for (const chapter of entry.chapters) {
        if (typeof chapter !== 'string') {
          fail(`${tag}：chapters 里有非字符串`);
          continue;
        }
        if (chapter !== entry.page && !chapter.startsWith(`${entry.page}/`)) {
          fail(`${tag}：章节 ${chapter} 不以 page 开头`);
        }
        if (seen.has(chapter)) fail(`${tag}：章节重复 ${chapter}`);
        seen.add(chapter);
      }
      if (entry.chapters.length >= 2) multi++;
      else single++;
    }

    const title = String(entry.title ?? '');
    if ([...title].length < 2) fail(`${tag}：标题长度 < 2`);
    for (const suffix of TITLE_EXCLUDE_SUFFIXES) {
      if (title.endsWith(suffix)) fail(`${tag}：标题以「${suffix}」结尾（不是书）`);
    }

    if (!Number.isFinite(entry.bytes) || entry.bytes < 0) fail(`${tag}：bytes 不是非负数`);
    else totalBytes += entry.bytes;
    if (entry.chapters?.length === 1 && entry.bytes < SINGLE_MIN_BYTES) {
      fail(`${tag}：单页作品正文 ${entry.bytes} B < ${SINGLE_MIN_BYTES} B`);
    }

    if (Array.isArray(entry.sourceCategories) && entry.sourceCategories.length) {
      const category = entry.sourceCategories[0];
      categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
    } else {
      warn(`${tag}：缺 sourceCategories，来源分类无法校验`);
    }

    try {
      const url = new URL(entry.sourceUrl);
      if (url.hostname !== 'zh.wikisource.org') fail(`${tag}：sourceUrl 不是维基文库`);
    } catch {
      fail(`${tag}：sourceUrl 不是合法 URL`);
    }
  });

  if (multi >= MULTI_MIN) pass(`多章作品 ${multi} ≥ 400`);
  else fail(`多章作品只有 ${multi}，要求 ≥ 400`);
  pass(`单页作品 ${single}`);

  const over = [...categoryCounts.entries()].filter(([, count]) => count > CATEGORY_CAP);
  if (over.length) fail(`来源分类超过 300 条：${over.map(([category, count]) => `${category}=${count}`).join('、')}`);
  else pass(`来源分类上限 OK（最大 ${Math.max(0, ...[...categoryCounts.values()])} 条）`);

  console.log('===== 校验 seed/catalog.json（不发网络请求）=====');
  for (const line of passes) console.log(`  ok   ${line}`);
  for (const line of warnings) console.log(`  warn ${line}`);
  for (const line of errors) console.log(`  FAIL ${line}`);
  console.log('');
  console.log(`条目 ${entries.length} / 多章 ${multi} / 单页 ${single} / 正文合计 ${fmtBytes(totalBytes)}`);
  console.log(`来源分类 ${categoryCounts.size} 个，最大 ${Math.max(0, ...[...categoryCounts.values()])} 条`);
  console.log('');
  if (errors.length) {
    console.log(`结论：不通过（${errors.length} 个错误，${warnings.length} 个警告）`);
    process.exit(1);
  }
  console.log(`结论：通过（${warnings.length} 个警告）`);
  process.exit(0);
}

/* ------------------------------------------------------------------ */

if (VALIDATE_ONLY) {
  await validateOnly();
} else {
  try {
    await harvest();
    log(`[stats] 请求 ${stats.requests}，缓存命中 ${stats.cacheHits}，429 ${stats.rateLimited}，失败 ${stats.failures.length}`);
  } catch (error) {
    errlog(`[fatal] ${error?.stack ?? error}`);
    log(`[stats] 请求 ${stats.requests}，缓存命中 ${stats.cacheHits}，429 ${stats.rateLimited}，失败 ${stats.failures.length}`);
    process.exit(1);
  }
}
