#!/usr/bin/env node
/**
 * build-epub.mjs —— 把中文维基文库（zh.wikisource.org）的页面打成 **EPUB 3**。
 *
 * 流水线第 ② 步（见 seed/README.md）：
 *   seed/catalog.json → seed/submit/books/<id>/<书名>.epub + seed/submit/manifest.json
 *
 * 为什么这样取舍：
 *   · **运行时零依赖**：只用 node: 内置模块（zlib / crypto / fs / fetch）。
 *     ZIP 容器自己写（scripts/seed/lib/zip-write.mjs），不依赖系统 `zip` 命令 ——
 *     有的机器没有，而 EPUB 只需要 store/deflate 两种条目，手写反而更可控。
 *   · **正文取自 `action=parse&prop=text` 的已渲染 HTML**，本脚本不解 wikitext。
 *     模板展开/魔术字只该由 MediaWiki 自己解释，自己写解析器必然有偏差。
 *   · **清洗走白名单**：只输出 <p>/<h2>/<h3>/<h4>/<blockquote>/<br/>，
 *     文本一律转义，其余标签拆成纯文本（<a> 不保留链接，避免站外死链）。
 *     宁可用 textContent 式的粗暴清洗，也不产出坏 XML —— EPUB 是 XML，
 *     一个未闭合标签就让整本书打不开。生成后还会跑一遍自检（assertWellFormedXml）。
 *   · **礼貌抓取**：Wikimedia 对匿名 API 有突发限流（429 + Retry-After）。
 *     默认并发 2、起始间隔 1.2s，遇 429 按 Retry-After 冷却并自动放慢；
 *     页面缓存到 seed/submit/.cache/，断点续跑不重复抓。
 *   · **可回退**：API 重试耗尽（且是限流类错误）时，改用 `action=render`
 *     取同一份已渲染 HTML（应用服务器，限流桶不同）。只在这条路上才用，
 *     且会在日志与统计里标出来。
 *
 * 用法：
 *   node scripts/seed/build-epub.mjs                 # 默认只做前 3 本，不跑全量
 *   node scripts/seed/build-epub.mjs --limit 10      # 前 10 本
 *   node scripts/seed/build-epub.mjs --all           # 完整清单
 *   node scripts/seed/build-epub.mjs --only hongloumeng
 *   node scripts/seed/build-epub.mjs --only hongloumeng --force
 *
 * 目录不存在时的行为：用内置的 3 本样板（紅樓夢 / 論語 / 三國志）跑通流程；
 * 不写 seed/catalog.json —— 那是 harvest.mjs 的文件，本脚本只读。
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createZip } from './lib/zip-write.mjs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── 常量 ────────────────────────────────────────────────────────────────
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SEED_DIR = path.join(REPO_ROOT, 'seed');
// 允许用 SEED_CATALOG 指定清单（两条路线并存：catalog.json / catalog.volumes.json）
const CATALOG_PATH = path.resolve(process.cwd(), process.env.SEED_CATALOG ?? 'seed/catalog.json');
const SUBMIT_DIR = path.join(SEED_DIR, 'submit');
const BOOKS_DIR = path.join(SUBMIT_DIR, 'books');
const MANIFEST_PATH = path.join(SUBMIT_DIR, 'manifest.json');
const CACHE_DIR = path.join(SUBMIT_DIR, '.cache', 'pages');

const SITE = 'zh.wikisource.org';
const API_URL = `https://${SITE}/w/api.php`;
const RENDER_URL = `https://${SITE}/w/index.php`;
const USER_AGENT = 'webooks-seed/1.0';
const LANGUAGE = 'zh';
const UNKNOWN_AUTHOR = '佚名';

const DEFAULT_LIMIT = 3; // 不带 --all 时默认只做前 3 本（README 的验收入口）
const CONCURRENCY = 2; // 同时最多 2 个请求（任务要求 ≤2）
const MIN_REQUEST_INTERVAL_MS = 1200; // 起始节奏；遇 429 会自适应放慢
const MAX_RETRIES = 3; // 「失败重试 3 次」= 首次 + 3 次重试
const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_BACKOFF_MS = [1500, 4000, 10_000];
const HARD_RATE_LIMIT_MS = 5000; // Retry-After 超过这个值就别干等 API，先用 render
const MAX_CHAPTERS = 200;
const MAX_CONTENT_BYTES = 8 * 1024 * 1024;
const MAX_LEAF_LENGTH = 180;
const ID_RE = /^[0-9a-f]{16}$/;
const CHUNK_NOTE = '本章正文超过体积上限，已截断';

const STYLE_CSS = `@charset "utf-8";
body { margin: 0 1em; line-height: 1.75; font-family: "Noto Serif CJK SC", "Songti SC", serif; }
h1 { font-size: 1.4em; margin: 1.2em 0 0.8em; text-align: center; }
h2 { font-size: 1.15em; margin: 1.4em 0 0.6em; }
h3 { font-size: 1.05em; margin: 1.2em 0 0.5em; }
p { margin: 0 0 0.65em; text-indent: 2em; }
blockquote { margin: 0.8em 2em; }
p.truncated { color: #666; font-size: 0.9em; text-indent: 0; }
`.replace(/\n$/, '');

const stats = {
  requests: 0,
  cacheHits: 0,
  http429: 0,
  renderFallbacks: 0,
  booksBuilt: 0,
  booksSkipped: 0,
  booksFailed: 0,
  chaptersFetched: 0,
};

// ── 小工具 ──────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 16 位小写十六进制 id（与项目的 shortId(8) 同形） */
function randomId() {
  return randomBytes(8).toString('hex');
}

function escapeXmlText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 去掉 XML 1.0 里非法的控制字符（会直接让 epubcheck / 解析器报错） */
function stripInvalidXml(value) {
  return String(value).replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ufffe\uffff]/g,
    '',
  );
}

/** 元数据：去控制字符 + 首尾空白，空串返回 null */
function cleanMeta(value) {
  if (value === null || value === undefined) return null;
  const s = stripInvalidXml(String(value)).replace(/\s+/g, ' ').trim();
  return s || null;
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function sha1(text) {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

function pageUrl(page) {
  const segments = String(page).trim().replace(/ /g, '_').split('/');
  return `https://${SITE}/wiki/${segments.map(encodeURIComponent).join('/')}`;
}

async function statOrNull(file) {
  try {
    return await fsp.stat(file);
  } catch {
    return null;
  }
}

async function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, data);
  try {
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

// ── 命令行 ──────────────────────────────────────────────────────────────
function usage() {
  return `用法：node scripts/seed/build-epub.mjs [选项]

  --limit N        只做清单里的前 N 本
  --all            做完整清单（默认只做前 ${DEFAULT_LIMIT} 本）
  --only <slug>    只做指定 slug
  --force          目标文件已存在也重做
  -h, --help       显示本帮助
`;
}

function parseArgs(argv) {
  const opts = { limit: null, all: false, only: null, force: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--limit') {
      const raw = argv[++i];
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) throw new UsageError(`--limit 需要正整数，收到 ${JSON.stringify(raw)}`);
      opts.limit = n;
    } else if (arg === '--all') {
      opts.all = true;
    } else if (arg === '--only') {
      const slug = argv[++i];
      if (!slug || slug.startsWith('--')) throw new UsageError('--only 需要一个 slug');
      opts.only = slug;
    } else if (arg === '--force') {
      opts.force = true;
    } else if (arg === '-h' || arg === '--help') {
      opts.help = true;
    } else {
      throw new UsageError(`未知参数：${arg}`);
    }
  }
  return opts;
}

class UsageError extends Error {}

// ── 内置样板（catalog.json 还没生成时用） ───────────────────────────────
// 3 个真实页面：多子页的 紅樓夢、少量子页的 論語、多子页的 三國志。
// 章节目录按维基文库当前的分页标题写死，避免样板阶段再依赖一次目录页解析。
function makeSamples() {
  const hongloumengChapters = Array.from({ length: 120 }, (_, i) => `紅樓夢/第${String(i + 1).padStart(3, '0')}回`);
  const sanguozhiChapters = Array.from({ length: 65 }, (_, i) => `三國志/卷${String(i + 1).padStart(2, '0')}`);
  const lunyuChapters = [
    '論語/序說',
    '論語/學而第一',
    '論語/爲政第二',
    '論語/八佾第三',
    '論語/里仁第四',
    '論語/公冶長第五',
    '論語/雍也第六',
    '論語/述而第七',
    '論語/泰伯第八',
    '論語/子罕第九',
    '論語/鄉黨第十',
    '論語/先進第十一',
    '論語/顏淵第十二',
    '論語/子路第十三',
    '論語/憲問第十四',
    '論語/衞靈公第十五',
    '論語/季氏第十六',
    '論語/陽貨第十七',
    '論語/微子第十八',
    '論語/子張第十九',
    '論語/堯曰第二十',
    '論語/知道第二十二',
  ];
  return [
    {
      slug: 'hongloumeng',
      page: '紅樓夢',
      title: '紅樓夢',
      author: '曹雪芹',
      authorDeathYear: 1763,
      licenseBasis: 'public-domain',
      licenseNote: '作者卒於1763年，超過 50 年',
      sourceUrl: 'https://zh.wikisource.org/wiki/紅樓夢',
      chapters: hongloumengChapters,
    },
    {
      slug: 'lunyu',
      page: '論語',
      title: '論語',
      author: '孔子',
      authorDeathYear: null,
      licenseBasis: 'public-domain',
      licenseNote: '作者為春秋時人（上古），作品屬公有領域',
      sourceUrl: 'https://zh.wikisource.org/wiki/論語',
      chapters: lunyuChapters,
    },
    {
      slug: 'sanguozhi',
      page: '三國志',
      title: '三國志',
      author: '陳壽',
      authorDeathYear: 297,
      licenseBasis: 'public-domain',
      licenseNote: '作者卒於297年，超過 50 年',
      sourceUrl: 'https://zh.wikisource.org/wiki/三國志',
      chapters: sanguozhiChapters,
    },
  ];
}

// ── 清单加载 ────────────────────────────────────────────────────────────
async function loadCatalog() {
  let raw;
  try {
    raw = await fsp.readFile(CATALOG_PATH, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    console.warn('[info] seed/catalog.json 不存在，使用内置的 3 本样板');
    return { mode: 'samples', source: 'builtin-samples', entries: makeSamples() };
  }

  let json;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`seed/catalog.json 不是合法 JSON：${err.message}`);
  }
  if (!json || typeof json !== 'object' || !Array.isArray(json.entries)) {
    throw new Error('seed/catalog.json 缺少 entries 数组');
  }
  if (json.entries.length === 0) throw new Error('seed/catalog.json 的 entries 为空');

  const seenSlugs = new Set();
  json.entries.forEach((entry, index) => {
    const where = `catalog[${index}]`;
    if (!entry || typeof entry !== 'object') throw new Error(`${where} 不是对象`);
    if (!cleanMeta(entry.slug)) throw new Error(`${where} 缺少 slug`);
    if (!cleanMeta(entry.title)) throw new Error(`${where}（${entry.slug}）缺少 title`);
    if (!Array.isArray(entry.chapters) || entry.chapters.length === 0) {
      throw new Error(`${where}（${entry.slug}）的 chapters 为空`);
    }
    if (entry.chapters.some((c) => !cleanMeta(c))) {
      throw new Error(`${where}（${entry.slug}）的 chapters 含空标题`);
    }
    if (seenSlugs.has(entry.slug)) throw new Error(`catalog 里 slug 重复：${entry.slug}`);
    seenSlugs.add(entry.slug);
    if (entry.licenseBasis && entry.licenseBasis !== 'public-domain') {
      console.warn(`[warn] ${entry.slug}: licenseBasis=${entry.licenseBasis}（本脚本按公有领域处理）`);
    }
  });

  return { mode: 'catalog', source: SITE, entries: json.entries };
}

// 只保留本脚本认识的字段，并把章节标题规范成字符串
function normaliseEntry(entry) {
  const slug = cleanMeta(entry.slug);
  const title = cleanMeta(entry.title) || cleanMeta(entry.page) || slug;
  const page = cleanMeta(entry.page) || title || slug;
  const author = cleanMeta(entry.author) || UNKNOWN_AUTHOR;
  const chapters = [];
  const seen = new Set();
  for (const raw of entry.chapters ?? []) {
    const c = cleanMeta(raw);
    if (c && !seen.has(c)) {
      seen.add(c);
      chapters.push(c);
    }
  }
  return {
    slug,
    page,
    title,
    author,
    authorDeathYear: entry.authorDeathYear ?? null,
    chapters,
    licenseBasis: cleanMeta(entry.licenseBasis) || 'public-domain',
    licenseNote: cleanMeta(entry.licenseNote),
    sourceUrl: cleanMeta(entry.sourceUrl) || pageUrl(page),
  };
}

// ── 文件名清洗（与 src/lib/metadata.ts 的 sanitiseLeafName 同规则，上限 180） ──
function sanitiseLeafName(raw, maxLength = MAX_LEAF_LENGTH) {
  let name = String(raw ?? '').trim();
  if (!name) return null;
  // 路径分隔符与控制字符 → _（与仓库里的 sanitiseLeafName 一致）
  name = name.replace(/[/\\\u0000-\u001f\u007f]/g, '_');
  // Windows 不允许的字符
  name = name.replace(/[<>:"|?*]/g, '_');
  name = name.replace(/\s+/g, ' ').trim();
  if (!name || name === '.' || name === '..') return null;
  if (name.length > maxLength) name = name.slice(0, maxLength);
  return name;
}

function makeLeafName(title, suffix = '') {
  const ext = '.epub';
  const budget = MAX_LEAF_LENGTH - ext.length;
  let base = sanitiseLeafName(title, budget) || 'book';
  // 追加后缀（作者名/随机串）时，给后缀留出位置，别把后缀本身截掉
  if (suffix) {
    const room = Math.max(1, budget - suffix.length);
    base = base.slice(0, room);
    return `${base}${suffix}${ext}`;
  }
  return `${base}${ext}`;
}

/**
 * 全局分配叶子文件名：同一本书在多轮运行里尽量稳定，同一个名字只给一个 slug。
 * 冲突时按 README 的约定追加 ` (作者)`；仍冲突再加 4 位随机后缀。
 */
function allocateLeafNames(entries, previousEntries) {
  const used = new Map(); // lower(leafName) -> slug
  const leafBySlug = new Map();

  // 1) 旧清单里已有的名字先占位（保证断点续跑时路径不变）
  for (const prev of previousEntries) {
    const slug = cleanMeta(prev?.slug);
    const leaf = cleanMeta(prev?.leafName);
    if (!slug || !leaf) continue;
    if (!used.has(leaf.toLowerCase())) {
      used.set(leaf.toLowerCase(), slug);
      if (!leafBySlug.has(slug)) leafBySlug.set(slug, leaf);
    }
  }

  // 2) 按清单顺序给还没名字的条目分配
  for (const entry of entries) {
    if (leafBySlug.has(entry.slug)) continue;
    const base = makeLeafName(entry.title);
    let candidate = base;
    const takenBy = used.get(candidate.toLowerCase());
    if (takenBy !== undefined && takenBy !== entry.slug) {
      const withAuthor = makeLeafName(entry.title, ` (${entry.author || UNKNOWN_AUTHOR})`);
      if (!used.has(withAuthor.toLowerCase())) {
        candidate = withAuthor;
      } else {
        // 极端情况：同名同作者 —— 用随机后缀保证全局唯一
        for (let attempt = 0; attempt < 50; attempt++) {
          const alt = makeLeafName(entry.title, ` (${randomId().slice(0, 4)})`);
          if (!used.has(alt.toLowerCase())) {
            candidate = alt;
            break;
          }
        }
      }
    }
    used.set(candidate.toLowerCase(), entry.slug);
    leafBySlug.set(entry.slug, candidate);
  }

  return leafBySlug;
}

// ── 限流器 ──────────────────────────────────────────────────────────────
class RateLimiter {
  constructor(minIntervalMs) {
    this.baseInterval = minIntervalMs;
    this.minInterval = minIntervalMs;
    this.nextAt = 0;
  }

  /** 在发出下一个请求前等待；把「允许开始」的时间点往后排 */
  async acquire() {
    const now = Date.now();
    const wait = Math.max(0, this.nextAt - now);
    this.nextAt = Math.max(now, this.nextAt) + this.minInterval;
    if (wait > 0) await sleep(wait);
  }

  /** 收到 429：按 Retry-After 冷却，并把整体节奏放慢（自适应） */
  penalise(waitMs) {
    this.nextAt = Math.max(this.nextAt, Date.now() + Math.max(0, waitMs));
    this.minInterval = Math.min(6000, Math.round(this.minInterval * 1.5));
  }

  /**
   * 成功一次就慢慢回到基准节奏（每次 -3%）。
   * 只放慢不恢复的话，一次 429 会把后面几百章都拖成 2–3 倍耗时。
   */
  noteSuccess() {
    if (this.minInterval > this.baseInterval) {
      this.minInterval = Math.max(this.baseInterval, Math.round(this.minInterval * 0.97));
    }
  }
}

// API 与 render 是两个不同的限流桶（实测 API 429 时 render 仍可用），
// 分开计节奏：一个端点被限流不应该把另一个端点也卡住。
const apiLimiter = new RateLimiter(MIN_REQUEST_INTERVAL_MS);
const webLimiter = new RateLimiter(MIN_REQUEST_INTERVAL_MS);

// API 429 后的冷却窗口：窗口内的页面直接走 render，不再每页先撞一次 429。
let apiBlockedUntil = 0;

async function httpGet(url, accept, limiter) {
  await limiter.acquire();
  stats.requests += 1;
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: accept },
    redirect: 'follow',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await res.text();
  return { status: res.status, headers: res.headers, body };
}

function retryAfterMs(headers) {
  const raw = headers?.get?.('retry-after');
  if (!raw) return 0;
  const seconds = Number.parseInt(raw, 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

// ── 抓取（缓存 + 重试 + render 回退） ───────────────────────────────────
class FatalPageError extends Error {}

function parseApiUrl(page) {
  return `${API_URL}?action=parse&format=json&formatversion=2&page=${encodeURIComponent(page)}`
    + '&prop=text&disableeditsection=1&disabletoc=1&redirects=1';
}

function renderUrl(page) {
  return `${RENDER_URL}?title=${encodeURIComponent(page)}&action=render`;
}

function extractRenderHtml(body) {
  if (!body) return null;
  const text = body.trim();
  if (!text) return null;
  // action=render 正常返回 mw-parser-output 片段；个别错误页是完整 HTML。
  // 这里不追求精确，只挡掉明显不是正文的响应（空串、错误页）。
  if (/^<!DOCTYPE html/i.test(text) && !/mw-parser-output/.test(text)) return null;
  return body;
}

async function readCache(file) {
  try {
    const text = await fsp.readFile(file, 'utf8');
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

async function writeCache(file, html) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, html, 'utf8');
  try {
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * 取一个页面的已渲染 HTML。
 * 顺序：磁盘缓存 → action=parse（重试 3 次）→ action=render（重试 3 次）。
 * 404/页面不存在属于永久失败，不再重试。
 */
async function fetchPageHtml(page) {
  const cacheFile = path.join(CACHE_DIR, `${sha1(page)}.html`);
  const cached = await readCache(cacheFile);
  if (cached) {
    stats.cacheHits += 1;
    return cached;
  }

  let lastError = null;
  let fatal = null;

  // 1) 主路径：action=parse&prop=text
  //    API 正处于 429 冷却窗口时跳过这一路（窗口结束后会自动再试）。
  if (Date.now() >= apiBlockedUntil) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) await sleep(RETRY_BACKOFF_MS[attempt - 1] ?? 10_000);
      let out;
      try {
        out = await httpGet(parseApiUrl(page), 'application/json', apiLimiter);
      } catch (err) {
        lastError = err;
        continue;
      }
      if (out.status === 200) {
        let json;
        try {
          json = JSON.parse(out.body);
        } catch {
          lastError = new Error('API 返回的不是 JSON');
          continue;
        }
        if (json?.error) {
          fatal = new FatalPageError(
            `MediaWiki 错误 ${json.error.code ?? '?'}: ${json.error.info ?? ''}`.trim(),
          );
          break;
        }
        const html = json?.parse?.text;
        if (typeof html === 'string' && html.trim()) {
          await writeCache(cacheFile, html);
          stats.chaptersFetched += 1;
          apiLimiter.noteSuccess();
          return html;
        }
        lastError = new Error('API 返回里没有 parse.text');
        continue;
      }
      if (out.status === 429) {
        stats.http429 += 1;
        const waitMs = retryAfterMs(out.headers) || 5000;
        apiLimiter.penalise(waitMs + 500);
        apiBlockedUntil = Math.max(apiBlockedUntil, Date.now() + waitMs);
        lastError = new Error(`API 429（retry-after ${Math.round(waitMs / 1000)}s）`);
        // 惩罚窗口太长就别等了：render 端点通常还能用（EPUB 内容完全一样）
        if (waitMs >= HARD_RATE_LIMIT_MS) break;
        continue;
      }
      if (out.status === 404 || out.status === 400) {
        fatal = new FatalPageError(`Wikipedia API HTTP ${out.status}`);
        break;
      }
      lastError = new Error(`Wikipedia API HTTP ${out.status}`);
    }
  } else {
    lastError = new Error('API 处于限流冷却窗口');
  }

  if (fatal) throw fatal;

  // 2) 回退路径：action=render（同一份已渲染 HTML，不同的限流桶）
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(RETRY_BACKOFF_MS[attempt - 1] ?? 10_000);
    let out;
    try {
      out = await httpGet(renderUrl(page), 'text/html', webLimiter);
    } catch (err) {
      lastError = err;
      continue;
    }
    if (out.status === 200) {
      const html = extractRenderHtml(out.body);
      if (html) {
        stats.renderFallbacks += 1;
        stats.chaptersFetched += 1;
        webLimiter.noteSuccess();
        await writeCache(cacheFile, html);
        // 限流窗口内可能连续几十页都走回退，逐页打日志会淹没输出：
        // 前 3 次逐条打印，之后每 25 次报一次累计值，最终汇总里还有总数。
        if (stats.renderFallbacks <= 3 || stats.renderFallbacks % 25 === 0) {
          console.warn(
            `[warn] ${page}: API 不可用，已用 action=render 取回（累计 ${stats.renderFallbacks} 次）`,
          );
        }
        return html;
      }
      lastError = new Error('render 返回空正文');
      continue;
    }
    if (out.status === 429) {
      stats.http429 += 1;
      const waitMs = retryAfterMs(out.headers) || 5000;
      webLimiter.penalise(waitMs + 500);
      lastError = new Error(`render 429（retry-after ${Math.round(waitMs / 1000)}s）`);
      continue;
    }
    if (out.status === 404) {
      fatal = new FatalPageError('Wikipedia render HTTP 404');
      break;
    }
    lastError = new Error(`render HTTP ${out.status}`);
  }

  if (fatal) throw fatal;
  throw new Error(`抓取失败：${lastError?.message ?? '未知错误'}`);
}

// ── HTML 实体解码 ───────────────────────────────────────────────────────
// MediaWiki 渲染结果里的非 ASCII 大多写成数字实体（&#91; 之类），
// 命名实体只覆盖常用的那些；不认识的保留字面量，转义后不会破坏 XML。
const NAMED_ENTITIES = Object.freeze({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', hairsp: ' ',
  zwnj: '', zwj: '', lrm: '', rlm: '',
  ndash: '–', mdash: '—', horbar: '―', hellip: '…',
  lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„',
  laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›',
  dagger: '†', Dagger: '‡', bull: '•', middot: '·', prime: '′', Prime: '″', permil: '‰',
  times: '×', divide: '÷', plusmn: '±', minus: '−', deg: '°', micro: 'µ',
  para: '¶', sect: '§', copy: '©', reg: '®', trade: '™',
  cent: '¢', pound: '£', yen: '¥', euro: '€', curren: '¤',
  frac14: '¼', frac12: '½', frac34: '¾', sup1: '¹', sup2: '²', sup3: '³',
  iexcl: '¡', iquest: '¿', ordf: 'ª', ordm: 'º', not: '¬', shy: '­',
  macr: '¯', acute: '´', cedil: '¸', uml: '¨', brvbar: '¦',
  szlig: 'ß', aelig: 'æ', AElig: 'Æ', oslash: 'ø', Oslash: 'Ø',
  larr: '←', uarr: '↑', rarr: '→', darr: '↓', harr: '↔', crarr: '↵',
  lArr: '⇐', rArr: '⇒', hArr: '⇔',
  le: '≤', ge: '≥', ne: '≠', asymp: '≈', infin: '∞', sum: '∑', prod: '∏',
  radic: '√', int: '∫', part: '∂', nabla: '∇', isin: '∈', notin: '∉',
  cap: '∩', cup: '∪', sub: '⊂', sup: '⊃', and: '∧', or: '∨',
  forall: '∀', exist: '∃', empty: '∅', there4: '∴', sim: '∼',
  cong: '≅', equiv: '≡', prop: '∝', ang: '∠', perp: '⊥', sdot: '⋅',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ',
  eta: 'η', theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ',
  nu: 'ν', xi: 'ξ', omicron: 'ο', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ',
  upsilon: 'υ', phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Alpha: 'Α', Beta: 'Β', Gamma: 'Γ', Delta: 'Δ', Epsilon: 'Ε', Zeta: 'Ζ',
  Eta: 'Η', Theta: 'Θ', Iota: 'Ι', Kappa: 'Κ', Lambda: 'Λ', Mu: 'Μ',
  Nu: 'Ν', Xi: 'Ξ', Omicron: 'Ο', Pi: 'Π', Rho: 'Ρ', Sigma: 'Σ', Tau: 'Τ',
  Upsilon: 'Υ', Phi: 'Φ', Chi: 'Χ', Psi: 'Ψ', Omega: 'Ω',
});

function decodeEntities(input) {
  if (!input.includes('&')) return input;
  return input.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (whole, body) => {
    if (body[0] === '#') {
      const codePoint = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      if (
        !Number.isFinite(codePoint)
        || codePoint <= 0
        || codePoint > 0x10ffff
        || (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        return '\uFFFD';
      }
      return String.fromCodePoint(codePoint);
    }
    const named = NAMED_ENTITIES[body];
    return named !== undefined ? named : whole;
  });
}

// ── HTML 清洗（白名单式） ───────────────────────────────────────────────
// 只保留块级语义 + <br/>；其余标签一律拆成文字。这样输出天然是合法 XHTML。
const BLOCK_TAGS = new Set([
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'tr', 'caption',
  'table', 'tbody', 'thead', 'tfoot',
  'section', 'article', 'header', 'footer', 'aside', 'main', 'nav', 'address', 'center',
]);

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

// 这些标签的内容整体丢弃（不是「拆标签留文字」）
const SKIP_TAGS = new Set([
  'script', 'style', 'noscript', 'iframe', 'object', 'embed', 'svg', 'math',
  'canvas', 'form', 'button', 'select', 'textarea', 'option', 'optgroup',
  'audio', 'video', 'picture', 'figure', 'figcaption', 'img', 'input',
  'link', 'meta', 'base', 'param', 'template', 'map', 'area', 'dialog',
  'output', 'progress', 'meter',
]);

// 这些 class/id 是维基的文风/导航/授权模板残留，整块删除。
// 说明：`noprint` 是「打印时隐藏」的导航（姊妹计划、页脚导航）；
// `licenseContainer`/`licensetpl` 是页脚授权模板（授权信息写进 OPF 的 dc:rights）；
// `ws-header`/`headerContainer` 是章节页眉（上一回/下一回），章节标题由 nav 提供；
// `mw-editsection` 是「[编辑]」链接，`mw-cite-backlink` 是脚注回跳箭头。
const SKIP_CLASSES = new Set([
  'mw-editsection', 'noprint', 'licenseContainer', 'licensetpl',
  'mw-cite-backlink', 'navbox', 'sistersitebox', 'ws-header', 'ws-footer',
  'ws-noexport', 'mw-empty-elt', 'mw-jump-link', 'printfooter', 'catlinks',
  'mw-indicators',
]);

const SKIP_IDS = new Set(['headerContainer', 'plainSister', 'toc', 'mw-toc-heading']);

function isNameChar(ch) {
  const c = ch.charCodeAt(0);
  return (
    (c >= 0x41 && c <= 0x5a)
    || (c >= 0x61 && c <= 0x7a)
    || (c >= 0x30 && c <= 0x39)
    || ch === '-'
    || ch === ':'
    || ch === '_'
  );
}

const ATTR_RE = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function parseAttrs(source) {
  const attrs = Object.create(null);
  ATTR_RE.lastIndex = 0;
  let match;
  while ((match = ATTR_RE.exec(source)) !== null) {
    const key = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    if (!(key in attrs)) attrs[key] = value;
  }
  return attrs;
}

/**
 * 把 HTML 切成 text / open / close token。
 * 注释（MediaWiki 的 NewPP 报告、缓存注释）与 DOCTYPE 直接丢弃；
 * 属性值里的 `>` 通过跳过引号内容正确处理。
 */
function tokenizeHtml(input) {
  const tokens = [];
  const n = input.length;
  let i = 0;

  while (i < n) {
    const lt = input.indexOf('<', i);
    if (lt === -1) {
      tokens.push({ type: 'text', text: input.slice(i) });
      break;
    }
    if (lt > i) tokens.push({ type: 'text', text: input.slice(i, lt) });

    if (input.startsWith('<!--', lt)) {
      const end = input.indexOf('-->', lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    const next = input[lt + 1];
    if (next === '!' || next === '?') {
      // DOCTYPE / CDATA / 处理指令：整段丢掉
      const end = input.indexOf('>', lt + 1);
      i = end === -1 ? n : end + 1;
      continue;
    }

    let p = lt + 1;
    let closing = false;
    if (input[p] === '/') {
      closing = true;
      p += 1;
    }
    const nameStart = p;
    while (p < n && isNameChar(input[p])) p += 1;
    if (p === nameStart) {
      // 不是标签（例如正文里的 "<"），按文本处理
      tokens.push({ type: 'text', text: '<' });
      i = lt + 1;
      continue;
    }
    const name = input.slice(nameStart, p).toLowerCase();
    const nameEnd = p;

    let quote = '';
    while (p < n) {
      const ch = input[p];
      if (quote) {
        if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
      p += 1;
    }
    if (p >= n) {
      // 标签没有闭合：剩下的都当文本，宁可露出尖括号，也不要吞掉正文
      tokens.push({ type: 'text', text: input.slice(lt) });
      break;
    }

    let attrText = input.slice(nameEnd, p);
    const selfClosing = /\/\s*$/.test(attrText);
    if (selfClosing) attrText = attrText.replace(/\/\s*$/, '');
    tokens.push({
      type: closing ? 'close' : 'open',
      name,
      attrs: parseAttrs(attrText),
      selfClosing,
    });
    i = p + 1;
  }

  return tokens;
}

function hasClass(attrs, name) {
  return String(attrs.class ?? '').split(/\s+/).includes(name);
}

function skipMode(token) {
  if (token.type !== 'open') return null;
  if (SKIP_TAGS.has(token.name)) return VOID_TAGS.has(token.name) ? 'tag' : 'subtree';
  if (token.name === 'sup' && hasClass(token.attrs, 'reference')) return 'subtree';
  const id = token.attrs.id;
  if (id && SKIP_IDS.has(id)) return 'subtree';
  const classes = String(token.attrs.class ?? '').split(/\s+/).filter(Boolean);
  if (classes.some((c) => SKIP_CLASSES.has(c))) return 'subtree';
  return null;
}

/** 从开标签位置跳到对应闭标签之后；无闭标签时跳到文档末尾 */
function skipSubtree(tokens, startIndex, tagName) {
  const open = tokens[startIndex];
  if (open.selfClosing) return startIndex;
  let depth = 0;
  for (let j = startIndex; j < tokens.length; j++) {
    const token = tokens[j];
    if (token.type === 'text' || token.name !== tagName) continue;
    if (token.type === 'open' && !token.selfClosing) {
      depth += 1;
    } else if (token.type === 'close') {
      depth -= 1;
      if (depth <= 0) return j;
    }
  }
  return tokens.length;
}

/** 文本节点的转义与空白规范化 */
function textToXml(raw) {
  if (!raw) return '';
  let s = decodeEntities(raw);
  // 零宽字符与软连字符没有排版意义，直接去掉
  s = s.replace(/[\u00ad\u200b\u200c\u200d\u2060\ufeff]/g, '');
  // 全角空格是有意的排版（「第一回　甄士隱…」），保留；其余空白折叠成半角空格
  s = s.replace(/\u3000+/g, '\u3000');
  s = s.replace(/[ \t\n\r\f\v]+/g, ' ');
  s = stripInvalidXml(s);
  return escapeXmlText(s);
}

const CJK_CLASS = '\\u2e80-\\u303f\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef';
const CJK_SPACE_AFTER = new RegExp(`([${CJK_CLASS}]) +`, 'g');
const CJK_SPACE_BEFORE = new RegExp(` +([${CJK_CLASS}])`, 'g');

const NAV_TOKEN_RE = /^(?:上一[回章節篇頁页]|下一[回章節篇頁页]|上一篇|下一篇|上一頁|下一頁|上篇|下篇|回目[錄录]|目[錄录]|返回目[錄录]|返回|首[頁页]|末[頁页]|←|→|↑|↓|◄|►|‹|›)$/;

function isNavBlock(html) {
  const plain = html.replace(/<br\/>/g, ' ');
  const tokens = plain.replace(/[　\s|·・、,，/]+/g, ' ').trim().split(' ').filter(Boolean);
  if (tokens.length === 0) return false;
  return tokens.every((token) => NAV_TOKEN_RE.test(token));
}

/** 规范化一个块的内容；返回空串表示整块丢弃 */
function normaliseBlock(html) {
  if (!html) return '';
  let s = html;
  // 换行前后的空格没有意义
  s = s.replace(/ +(?=<br\/>)/g, '');
  s = s.replace(/(<br\/>) +/g, '$1');
  // 中文两侧的多余空格（MediaWiki 模板换行会留下大量空格）
  s = s.replace(CJK_SPACE_AFTER, '$1');
  s = s.replace(CJK_SPACE_BEFORE, '$1');
  s = s.replace(/ {2,}/g, ' ');
  s = s.replace(/^(?:\s|<br\/>)+/, '');
  s = s.replace(/(?:\s|<br\/>)+$/, '');
  // 连续空行最多留一个
  s = s.replace(/(?:<br\/>){3,}/g, '<br/><br/>');
  s = s.trim();
  if (!s) return '';
  // 纯标点/纯符号（←、|、· 之类）不是正文
  if (!/[\p{L}\p{N}]/u.test(s)) return '';
  // 「上一回  回目录」这种导航段落
  if (isNavBlock(s)) return '';
  return s;
}

function blockTagFor(tagName) {
  switch (tagName) {
    case 'h1':
    case 'h2':
      return 'h2';
    case 'h3':
      return 'h3';
    case 'h4':
    case 'h5':
    case 'h6':
      return 'h4';
    case 'blockquote':
      return 'blockquote';
    default:
      return 'p';
  }
}

/**
 * 已渲染 HTML → 块数组 [{ tag, html }]。
 * 只产出 p/h2/h3/h4/blockquote，html 是已转义的文本（可含 <br/>）。
 */
function cleanHtml(html) {
  const tokens = tokenizeHtml(html);
  const blocks = [];
  let tag = 'p';
  let parts = [];

  const flush = () => {
    const content = normaliseBlock(parts.join(''));
    if (content) blocks.push({ tag, html: content });
    tag = 'p';
    parts = [];
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token.type === 'text') {
      parts.push(textToXml(token.text));
      continue;
    }

    if (token.type === 'close') {
      if (BLOCK_TAGS.has(token.name)) flush();
      continue;
    }

    const mode = skipMode(token);
    if (mode === 'tag') continue;
    if (mode === 'subtree') {
      i = skipSubtree(tokens, i, token.name);
      continue;
    }

    if (token.name === 'br') {
      parts.push('<br/>');
      continue;
    }
    if (token.name === 'hr') {
      flush();
      continue;
    }
    // 表格单元格：同一行内用空格分隔，换行由 <tr> 处理
    if (token.name === 'td' || token.name === 'th') {
      if (parts.length) parts.push(' ');
      continue;
    }
    if (BLOCK_TAGS.has(token.name)) {
      flush();
      tag = blockTagFor(token.name);
      continue;
    }
    // 其余内联标签（a/span/b/i/sup/sub/small…）一律拆掉，只留文字
  }

  flush();
  return blocks;
}

// ── XHTML / OPF 生成 ────────────────────────────────────────────────────
const CHAPTER_FILE_RE = (n) => `chapter-${String(n).padStart(4, '0')}.xhtml`;

function renderBlocks(blocks) {
  return blocks.map((block) => `<${block.tag}>${block.html}</${block.tag}>`).join('\n');
}

function chapterLabel(rootPage, page) {
  if (rootPage && page === rootPage) return '正文';
  if (rootPage && page.startsWith(`${rootPage}/`)) {
    const rest = page.slice(rootPage.length + 1);
    if (rest) return rest;
  }
  const slash = page.lastIndexOf('/');
  return slash >= 0 ? page.slice(slash + 1) : page;
}

function buildChapterXhtml({ bookTitle, label, blocks, index, note }) {
  const heading = escapeXmlText(label || `第 ${index} 章`);
  const body = renderBlocks(blocks);
  const noteNode = note ? `\n<p class="truncated">${escapeXmlText(note)}</p>` : '';
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${LANGUAGE}" lang="${LANGUAGE}">
  <head>
    <meta charset="utf-8"/>
    <title>${heading} — ${escapeXmlText(bookTitle)}</title>
    <link rel="stylesheet" type="text/css" href="style.css"/>
  </head>
  <body>
    <section epub:type="chapter" id="ch${String(index).padStart(4, '0')}">
      <h1>${heading}</h1>
${body ? `${body}\n` : ''}${noteNode}
    </section>
  </body>
</html>
`;
}

function buildNavXhtml(chapters) {
  const items = chapters
    .map((chapter, i) => `        <li><a href="${CHAPTER_FILE_RE(i + 1)}">${escapeXmlText(chapter.label)}</a></li>`)
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${LANGUAGE}" lang="${LANGUAGE}">
  <head>
    <meta charset="utf-8"/>
    <title>目錄</title>
    <link rel="stylesheet" type="text/css" href="style.css"/>
  </head>
  <body>
    <nav epub:type="toc" id="toc">
      <h1>目錄</h1>
      <ol>
${items}
      </ol>
    </nav>
  </body>
</html>
`;
}

function buildContainerXml() {
  return `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;
}

function buildOpf({ identifier, title, author, sourceUrl, rights, modified, chapters }) {
  const manifestItems = [
    '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '    <item id="css" href="style.css" media-type="text/css"/>',
    ...chapters.map((_, i) => {
      const id = `ch${String(i + 1).padStart(4, '0')}`;
      return `    <item id="${id}" href="${CHAPTER_FILE_RE(i + 1)}" media-type="application/xhtml+xml"/>`;
    }),
  ].join('\n');
  const spineItems = chapters
    .map((_, i) => `    <itemref idref="ch${String(i + 1).padStart(4, '0')}"/>`)
    .join('\n');

  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="${LANGUAGE}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">${escapeXmlText(identifier)}</dc:identifier>
    <dc:title>${escapeXmlText(title)}</dc:title>
    <dc:creator>${escapeXmlText(author)}</dc:creator>
    <dc:language>${LANGUAGE}</dc:language>
    <dc:source>${escapeXmlText(sourceUrl)}</dc:source>
    <dc:rights>${escapeXmlText(rights)}</dc:rights>
    <meta property="dcterms:modified">${modified}</meta>
  </metadata>
  <manifest>
${manifestItems}
  </manifest>
  <spine>
${spineItems}
  </spine>
</package>
`;
}

const ENTITY_RE = /&(?:#\d+|#x[0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/g;

/**
 * 生成后的自检：标签必须成对、文本里不能有裸 `&` 或 `<`。
 * 这里复用 tokenizer，所以检查的是「实际写进 ZIP 的那串字节」。
 */
function assertWellFormedXml(xml, label) {
  const tokens = tokenizeHtml(xml);
  const stack = [];
  for (const token of tokens) {
    if (token.type === 'text') {
      const stripped = token.text.replace(ENTITY_RE, '');
      if (stripped.includes('&')) throw new Error(`${label}: 文本里有未转义的 &`);
      if (stripped.includes('<')) throw new Error(`${label}: 文本里有未转义的 <`);
      continue;
    }
    if (token.type === 'open') {
      if (!token.selfClosing) stack.push(token.name);
      continue;
    }
    const expected = stack.pop();
    if (expected !== token.name) {
      throw new Error(`${label}: 标签错配（期望 </${expected ?? '?'}>，实际 </${token.name}>）`);
    }
  }
  if (stack.length > 0) throw new Error(`${label}: 未闭合标签 <${stack[stack.length - 1]}>`);
}

// ── 单本书构建 ──────────────────────────────────────────────────────────
async function loadChapters(pages, context) {
  const limit = Math.min(pages.length, MAX_CHAPTERS);
  const chapters = [];
  const notes = [];
  let totalBytes = 0;
  let stopped = false;
  let nextIndex = 0;

  const prepare = async (index) => {
    const page = pages[index];
    const html = await fetchPageHtml(page);
    const blocks = cleanHtml(html);
    const label = chapterLabel(context.rootPage, page);
    const info = { bookTitle: context.bookTitle, label, index: index + 1 };
    let doc = buildChapterXhtml({ ...info, blocks });
    let size = Buffer.byteLength(doc);
    // 极端的单章超限：从尾部丢块，直到塞得进预算（正常章节只有几十 KB）
    if (size > MAX_CONTENT_BYTES) {
      let lo = 0;
      let hi = blocks.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const candidate = buildChapterXhtml({ ...info, blocks: blocks.slice(0, mid), note: CHUNK_NOTE });
        if (Buffer.byteLength(candidate) <= MAX_CONTENT_BYTES) lo = mid;
        else hi = mid - 1;
      }
      const truncatedBlocks = blocks.slice(0, lo);
      doc = buildChapterXhtml({ ...info, blocks: truncatedBlocks, note: CHUNK_NOTE });
      size = Buffer.byteLength(doc);
      return {
        page, label, blocks: truncatedBlocks, doc, size,
        number: index + 1, truncated: true, empty: truncatedBlocks.length === 0,
      };
    }
    return {
      page, label, blocks, doc, size,
      number: index + 1, truncated: false, empty: blocks.length === 0,
    };
  };

  const inflight = [];
  const startMore = () => {
    while (!stopped && inflight.length < CONCURRENCY && nextIndex < limit) {
      const index = nextIndex++;
      const promise = prepare(index);
      // 立刻挂 catch：后面的章节先失败、而前面章节还在 await 时，
      // 否则会变成 unhandled rejection（Node 15+ 会直接终止进程）
      promise.catch(() => {});
      inflight.push({ index, promise });
    }
  };

  let stopReason = null;
  startMore();
  while (inflight.length > 0) {
    const job = inflight.shift();
    const chapter = await job.promise;
    if (chapters.length > 0 && totalBytes + chapter.size > MAX_CONTENT_BYTES) {
      stopReason = 'bytes';
      stopped = true;
      break;
    }
    chapters.push(chapter);
    totalBytes += chapter.size;
    if (chapter.empty) notes.push(`第 ${chapter.number} 章清洗后无正文`);
    if (chapter.truncated) notes.push(`第 ${chapter.number} 章正文超限已截断`);
    if (chapters.length % 25 === 0 && chapters.length < pages.length) {
      console.log(`      已处理 ${chapters.length}/${pages.length} 章`);
    }
    if (totalBytes >= MAX_CONTENT_BYTES) {
      stopReason = 'bytes';
      stopped = true;
      break;
    }
    startMore();
  }

  if (chapters.length === 0) throw new Error('清洗后没有任何正文');
  if (!Number.isInteger(chapters[0]?.number)) throw new Error('内部错误：章节序号丢失');

  if (chapters.length < pages.length) {
    if (stopReason === 'bytes') {
      notes.unshift(
        `正文超过 ${MAX_CONTENT_BYTES / 1024 / 1024} MB，已截断为前 ${chapters.length} 章（共 ${pages.length} 章）`,
      );
    } else {
      notes.unshift(
        `章节数 ${pages.length} 超过上限 ${MAX_CHAPTERS}，已截断为前 ${MAX_CHAPTERS} 章`,
      );
    }
  }

  return { chapters, totalBytes, notes: [...new Set(notes)] };
}

async function buildBook(entry, plan, options) {
  const id = plan.idBySlug.get(entry.slug);
  const leafName = plan.leafBySlug.get(entry.slug);
  if (!ID_RE.test(id)) throw new Error(`内部错误：id 不是 16 位十六进制（${id}）`);
  if (!leafName) throw new Error('内部错误：没有分配文件名');

  const dir = path.join(BOOKS_DIR, id);
  const target = path.join(dir, leafName);

  if (!options.force) {
    const existing = await statOrNull(target);
    if (existing && existing.size > 0) {
      stats.booksSkipped += 1;
      console.log(`  ↷ 目标已存在（${formatBytes(existing.size)}），跳过`);
      return { skipped: true, rebuilt: false };
    }
  }

  const startedAt = Date.now();
  const rootPage = entry.page || entry.title;
  console.log(`  抓取 ${entry.chapters.length} 章`);
  const { chapters, totalBytes, notes } = await loadChapters(entry.chapters, {
    rootPage,
    bookTitle: entry.title,
  });

  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const identifier = `urn:uuid:${randomUUID()}`;
  const opf = buildOpf({
    identifier,
    title: entry.title,
    author: entry.author,
    sourceUrl: entry.sourceUrl,
    rights: '公有领域（Public Domain）',
    modified,
    chapters,
  });
  const nav = buildNavXhtml(chapters);
  const container = buildContainerXml();

  // 自检：写进 ZIP 的每一份 XML/XHTML 都必须是良构的
  assertWellFormedXml(container, 'container.xml');
  assertWellFormedXml(opf, 'content.opf');
  assertWellFormedXml(nav, 'nav.xhtml');
  chapters.forEach((chapter, i) => {
    assertWellFormedXml(chapter.doc, `chapter-${String(i + 1).padStart(4, '0')}.xhtml`);
  });

  const epub = createZip([
    // EPUB 规范：mimetype 必须是第一个条目且不压缩
    { name: 'mimetype', data: 'application/epub+zip', store: true },
    { name: 'META-INF/container.xml', data: container },
    { name: 'OEBPS/content.opf', data: opf },
    { name: 'OEBPS/nav.xhtml', data: nav },
    { name: 'OEBPS/style.css', data: STYLE_CSS },
    ...chapters.map((chapter, i) => ({
      name: `OEBPS/${CHAPTER_FILE_RE(i + 1)}`,
      data: chapter.doc,
    })),
  ]);

  await fsp.mkdir(dir, { recursive: true });
  await writeFileAtomic(target, epub);
  const written = await fsp.stat(target);
  stats.booksBuilt += 1;

  // 新文件落盘之后再清理旧的书名文件（顺序很重要：先写后删，中途失败不会丢书）
  try {
    for (const stale of await fsp.readdir(dir)) {
      if (stale === leafName || !stale.endsWith('.epub')) continue;
      const stalePath = path.join(dir, stale);
      if (!stalePath.startsWith(`${dir}${path.sep}`)) continue;
      await fsp.rm(stalePath, { force: true });
    }
  } catch (err) {
    console.warn(`[warn] 清理旧文件失败（${err.message}），不影响本次产物`);
  }

  const notesFinal = notes.slice();
  if (chapters.length < entry.chapters.length) {
    // loadChapters 已写入截断说明；这里只兜底
    if (!notesFinal.some((n) => n.includes('已截断'))) {
      notesFinal.push(`已截断为前 ${chapters.length} 章（共 ${entry.chapters.length} 章）`);
    }
  }

  console.log(
    `  ✓ ${chapters.length} 章 / 正文 ${formatBytes(totalBytes)} / EPUB ${formatBytes(written.size)}`
    + `（${((Date.now() - startedAt) / 1000).toFixed(1)}s）`,
  );

  return {
    skipped: false,
    rebuilt: true,
    size: written.size,
    chapters: chapters.length,
    contentBytes: totalBytes,
    notes: notesFinal,
  };
}

// ── 清单（manifest） ────────────────────────────────────────────────────
async function loadPreviousManifest() {
  try {
    const json = JSON.parse(await fsp.readFile(MANIFEST_PATH, 'utf8'));
    return Array.isArray(json?.entries) ? json.entries.filter((e) => e && typeof e === 'object') : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    console.warn(`[warn] 旧 manifest.json 读不了（${err.message}），按空清单处理`);
    return [];
  }
}

async function scanBookFiles() {
  let dirents;
  try {
    dirents = await fsp.readdir(BOOKS_DIR, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const files = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory() || !ID_RE.test(dirent.name)) continue;
    const dir = path.join(BOOKS_DIR, dirent.name);
    for (const name of await fsp.readdir(dir)) {
      if (!name.endsWith('.epub')) continue;
      const file = path.join(dir, name);
      const info = await statOrNull(file);
      if (info && info.size > 0) {
        files.push({ id: dirent.name, leafName: name, size: info.size });
      }
    }
  }
  return files;
}

async function writeManifest({ catalogEntries, entriesBySlug, idBySlug, notesBySlug, previousEntries }) {
  const files = await scanBookFiles();
  const idToSlug = new Map();
  for (const [slug, id] of idBySlug) idToSlug.set(id, slug);
  const prevById = new Map(previousEntries.filter((e) => e?.id).map((e) => [e.id, e]));
  const prevBySlug = new Map(previousEntries.filter((e) => e?.slug).map((e) => [e.slug, e]));
  const order = new Map(catalogEntries.map((entry, index) => [entry.slug, index]));

  const entries = [];
  const seenSlugs = new Set();
  for (const file of files) {
    const slug = idToSlug.get(file.id) ?? prevById.get(file.id)?.slug;
    if (!slug) {
      console.warn(`[warn] 目录 ${file.id} 里的 ${file.leafName} 找不到对应清单条目，已忽略`);
      continue;
    }
    if (seenSlugs.has(slug)) {
      console.warn(`[warn] slug ${slug} 对应多个文件，保留第一个`);
      continue;
    }
    const entry = entriesBySlug.get(slug);
    const previous = prevBySlug.get(slug) ?? prevById.get(file.id);
    const title = entry?.title ?? previous?.title ?? file.leafName.replace(/\.epub$/, '');
    const author = entry?.author ?? previous?.author ?? UNKNOWN_AUTHOR;
    const note = notesBySlug.has(slug) ? (notesBySlug.get(slug) || undefined) : previous?.note;
    entries.push({
      id: file.id,
      leafName: file.leafName,
      r2Key: `books/${file.id}/${file.leafName}`,
      size: file.size,
      format: 'epub',
      title,
      author,
      language: LANGUAGE,
      licenseBasis: entry?.licenseBasis ?? previous?.licenseBasis ?? 'public-domain',
      sourceUrl: entry?.sourceUrl ?? previous?.sourceUrl ?? pageUrl(title),
      sourceKind: 'seed',
      slug,
      ...(note ? { note } : {}),
    });
    seenSlugs.add(slug);
  }

  entries.sort((a, b) => {
    const oa = order.has(a.slug) ? order.get(a.slug) : Number.MAX_SAFE_INTEGER;
    const ob = order.has(b.slug) ? order.get(b.slug) : Number.MAX_SAFE_INTEGER;
    return oa - ob || a.id.localeCompare(b.id);
  });

  await writeFileAtomic(MANIFEST_PATH, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`);
  return entries;
}

// ── 主流程 ──────────────────────────────────────────────────────────────
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return 0;
  }

  await fsp.mkdir(SUBMIT_DIR, { recursive: true });
  const catalog = await loadCatalog();
  const entries = catalog.entries.map(normaliseEntry);
  const entriesBySlug = new Map();
  for (const entry of entries) {
    if (entriesBySlug.has(entry.slug)) throw new Error(`slug 重复：${entry.slug}`);
    entriesBySlug.set(entry.slug, entry);
  }

  const previousEntries = await loadPreviousManifest();
  // id 一经分配就复用：--force 会覆盖同一路径，不会留下孤儿目录
  const existingIds = new Set(previousEntries.map((e) => e.id).filter((id) => ID_RE.test(id ?? '')));
  const previousIdBySlug = new Map();
  for (const prev of previousEntries) {
    if (ID_RE.test(prev?.id ?? '') && prev?.slug && !previousIdBySlug.has(prev.slug)) {
      previousIdBySlug.set(prev.slug, prev.id);
    }
  }
  for (const dirent of await fsp.readdir(BOOKS_DIR, { withFileTypes: true }).catch(() => [])) {
    if (dirent.isDirectory() && ID_RE.test(dirent.name)) existingIds.add(dirent.name);
  }
  const idBySlug = new Map();
  for (const entry of entries) {
    const previousId = previousIdBySlug.get(entry.slug);
    if (previousId) {
      idBySlug.set(entry.slug, previousId);
      continue;
    }
    let id;
    do {
      id = randomId();
    } while (existingIds.has(id));
    existingIds.add(id);
    idBySlug.set(entry.slug, id);
  }

  const leafBySlug = allocateLeafNames(entries, previousEntries);

  // 选择本次要做的书
  let selection;
  if (options.only) {
    const hit = entries.filter((entry) => entry.slug === options.only);
    if (hit.length === 0) throw new UsageError(`清单里没有 slug=${options.only}`);
    selection = hit;
  } else if (options.all) {
    selection = options.limit ? entries.slice(0, options.limit) : entries;
  } else {
    selection = entries.slice(0, options.limit ?? DEFAULT_LIMIT);
  }

  console.log(`清单：${catalog.mode === 'samples' ? '内置 3 本样板' : CATALOG_PATH}，共 ${entries.length} 本`);
  console.log(`本次处理 ${selection.length} 本${options.force ? '（--force）' : ''}\n`);

  const notesBySlug = new Map();
  let failures = 0;

  for (let i = 0; i < selection.length; i++) {
    const entry = selection[i];
    console.log(`[${i + 1}/${selection.length}] ${entry.title}（${entry.slug}，${entry.chapters.length} 章）`);
    let result;
    try {
      result = await buildBook(entry, { idBySlug, leafBySlug }, options);
      if (!result.skipped) {
        // 重做过就覆盖旧 note（截断消失时不能留着旧说明）；跳过时用旧 manifest 里的
        notesBySlug.set(entry.slug, result.notes?.length ? result.notes.join('；') : '');
      }
    } catch (err) {
      failures += 1;
      stats.booksFailed += 1;
      console.error(`  ✗ 失败：${err.message}`);
      if (err instanceof FatalPageError) {
        console.error('    （页面不存在或标题有误：请检查 catalog 的 chapters，或稍后重试）');
      }
      continue;
    }

    // 每本写完就落一次清单：长跑被中断后，重跑能凭 manifest 找回 id，不会重建孤儿目录
    try {
      await writeManifest({
        catalogEntries: entries,
        entriesBySlug,
        idBySlug,
        notesBySlug,
        previousEntries,
      });
    } catch (err) {
      console.warn(`[warn] manifest 增量写入失败（${err.message}），结束时还会再写一次`);
    }
  }

  const manifestEntries = await writeManifest({
    catalogEntries: entries,
    entriesBySlug,
    idBySlug,
    notesBySlug,
    previousEntries,
  });

  console.log('\n完成');
  console.log(`  新建 ${stats.booksBuilt} 本 / 跳过 ${stats.booksSkipped} 本 / 失败 ${stats.booksFailed} 本`);
  console.log(
    `  请求 ${stats.requests} 次（缓存命中 ${stats.cacheHits}，429 ${stats.http429}，`
    + `render 回退 ${stats.renderFallbacks}）`,
  );
  console.log(`  manifest：${path.relative(REPO_ROOT, MANIFEST_PATH)}（${manifestEntries.length} 条）`);

  if (failures > 0) return 1;
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      if (err instanceof UsageError) {
        console.error(`错误：${err.message}\n`);
        process.stderr.write(usage());
        process.exitCode = 2;
      } else {
        console.error(`错误：${err?.stack ?? err}`);
        process.exitCode = 1;
      }
    });
}

export {
  allocateLeafNames,
  assertWellFormedXml,
  buildChapterXhtml,
  cleanHtml,
  escapeXmlText,
  sanitiseLeafName,
  tokenizeHtml,
};
