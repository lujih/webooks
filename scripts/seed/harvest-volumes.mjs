#!/usr/bin/env node
/**
 * 公版种子库 · 第 ① 步（卷级路线）：把「卷」当作一本书来采。
 *
 * ── 为什么不是「整本」 ────────────────────────────────────────────────
 *
 * 整本（如《紅樓夢》120 回）要逐章抓取：800 本 × 平均 20 章 ≈ 1.6 万次请求。
 * 维基文库对匿名 API 的限速实测约 14 次/45 秒 —— 那是十几个小时。
 * 卷级条目每本只有 1 个页面，800 本 ≈ 800 次请求，加上元数据批量查询
 * 总共不到 100 次，几分钟就能出清单、半小时级能生成完 EPUB。
 *
 * 代价写清楚：库里的「书」粒度是**卷**（《全唐詩·卷001》），不是传统整本。
 * 对写作参考来说这反而好用：找典故按卷翻，比在 120 回里翻快。
 *
 * ── 授权怎么证 ────────────────────────────────────────────────────────
 *
 * 每个条目来自一部**清代以前成书的公版总集/正史/佛典**，逐条记
 * licenseNote（总集名 + 成书年代 + 编者卒年），不靠「我觉得它公版」。
 * 不收任何民國/現代分类下的作品 —— 那些作者卒年可能未过 50 年。
 *
 * 用法：
 *   node scripts/seed/harvest-volumes.mjs                # 采集（带持久缓存）
 *   node scripts/seed/harvest-volumes.mjs --validate-only
 *   node scripts/seed/harvest-volumes.mjs --refresh      # 忽略缓存
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const SEED = path.join(ROOT, 'seed');
const CACHE = path.join(SEED, '.cache', 'volumes');
const CATALOG = path.join(SEED, 'catalog.json');
const REPORT = path.join(SEED, 'report.md');

const WS = 'https://zh.wikisource.org/w/api.php';
const WD = 'https://www.wikidata.org/w/api.php';
const UA = 'webooks-seed/1.0 (public-domain library; contact: admin@localhost)';

const TARGET = 800;
const MIN_VOLUME_BYTES = 3000;
/** 匿名 API 实测约 14 次/45 秒；3.4s 间隔刚好贴着上限，不冒进。 */
const MIN_INTERVAL_MS = 3400;

/**
 * 采集范围：每部总集/正史一个前缀。
 *
 * `cap` 是这类作品最多占多少本 —— 防止 800 本全变成《全唐詩》。
 * 全部是清代以前成书的公版文献；`note` 就是逐条写进 licenseNote 的依据。
 */
const COLLECTIONS = [
  { prefix: '全唐詩/卷', label: '全唐詩', cap: 300, note: '清康熙年間官修唐詩總集（1705），編者曹寅卒於1712年，全書逾 50 年' },
  { prefix: '全唐文/卷', label: '全唐文', cap: 150, note: '清嘉慶年間官修唐文總集（1814），編者董誥卒於1818年，全書逾 50 年' },
  { prefix: '資治通鑑/卷', label: '資治通鑑', cap: 80, note: '北宋司馬光撰（1084），作者卒於1086年，逾 50 年' },
  { prefix: '續資治通鑑/卷', label: '續資治通鑑', cap: 40, note: '清畢沅撰（1801），作者卒於1797年，逾 50 年' },
  { prefix: '文獻通考/卷', label: '文獻通考', cap: 40, note: '元馬端臨撰（1307），作者卒於1323年，逾 50 年' },
];

/** 二十四史：共享一个配额，卷数合计远超需求。 */
const HISTORIES = [
  '史記', '漢書', '後漢書', '三國志', '晉書', '宋書', '南齊書', '梁書', '陳書',
  '魏書', '北齊書', '周書', '隋書', '南史', '北史', '舊唐書', '新唐書',
  '舊五代史', '新五代史', '宋史', '遼史', '金史', '元史', '明史',
];
const HISTORY_CAP = 250;
const HISTORY_NOTE = '二十四史（清乾隆欽定正史），成書於清代以前，作者均卒於 18 世紀前';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 带持久缓存的请求 ──────────────────────────────────────────────────────
let lastAt = 0;
const REFRESH = process.argv.includes('--refresh');

async function api(base, params) {
  const key = createHash('sha1').update(`${base}?${new URLSearchParams(params)}`).digest('hex');
  const file = path.join(CACHE, `${key}.json`);
  if (!REFRESH) {
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch {
      /* 未缓存 */
    }
  }

  const wait = MIN_INTERVAL_MS - (Date.now() - lastAt);
  if (wait > 0) await sleep(wait);
  lastAt = Date.now();

  for (let attempt = 0; attempt < 6; attempt++) {
    const url = `${base}?${new URLSearchParams({ format: 'json', ...params })}`;
    let res;
    try {
      res = await fetch(url, { headers: { 'user-agent': UA } });
    } catch (err) {
      if (attempt === 5) throw err;
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      const ra = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
      await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 3000 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    await mkdir(CACHE, { recursive: true });
    await writeFile(file, JSON.stringify(json), 'utf8');
    return json;
  }
  throw new Error('重试已用尽（429/5xx）');
}

// ── 采集 ──────────────────────────────────────────────────────────────────
async function listPrefix(prefix) {
  const out = [];
  let cont = {};
  for (let page = 0; page < 4; page++) {
    const d = await api(WS, {
      action: 'query',
      list: 'allpages',
      apprefix: prefix,
      apnamespace: '0',
      aplimit: '500',
      ...cont,
    });
    out.push(...(d.query?.allpages ?? []).map((p) => p.title));
    if (!d.continue) break;
    cont = { apcontinue: d.continue.apcontinue };
  }
  return out;
}

async function infoFor(titles) {
  const out = new Map();
  for (let i = 0; i < titles.length; i += 50) {
    const d = await api(WS, {
      action: 'query',
      prop: 'info',
      titles: titles.slice(i, i + 50).join('|'),
      formatversion: '2',
    });
    for (const p of d.query?.pages ?? []) {
      if (p.missing) continue;
      out.set(p.title, p.length ?? 0);
    }
  }
  return out;
}

function volumeTitle(page, label) {
  const tail = page.slice(page.lastIndexOf('/') + 1);
  return `${label}·${tail}`;
}

async function collect() {
  await mkdir(CACHE, { recursive: true });
  const candidates = [];

  for (const c of COLLECTIONS) {
    const pages = await listPrefix(c.prefix);
    console.error(`  · ${c.label}: ${pages.length} 卷`);
    for (const page of pages) {
      candidates.push({ page, collection: c.label, cap: c.cap, note: c.note });
    }
  }

  // 二十四史：24 个前缀，共享配额
  const historyPages = [];
  for (const name of HISTORIES) {
    const pages = await listPrefix(`${name}/卷`);
    historyPages.push(...pages.map((page) => ({ page, collection: name, cap: Infinity, note: HISTORY_NOTE })));
  }
  console.error(`  · 二十四史: ${historyPages.length} 卷`);
  for (const h of historyPages) candidates.push({ ...h, group: '二十四史', cap: HISTORY_CAP, note: HISTORY_NOTE });

  // 去重（同一页面只收一次）
  const seen = new Set();
  const unique = [];
  for (const c of candidates) {
    if (seen.has(c.page)) continue;
    seen.add(c.page);
    unique.push(c);
  }
  console.error(`候选：${unique.length} 卷`);

  // 长度（批量，50 个/请求）
  const info = await infoFor(unique.map((c) => c.page));
  const usable = unique
    .map((c) => ({ ...c, bytes: info.get(c.page) ?? 0 }))
    .filter((c) => c.bytes >= MIN_VOLUME_BYTES)
    .sort((a, b) => b.bytes - a.bytes);
  console.error(`有效（≥${MIN_VOLUME_BYTES}B）：${usable.length}`);

  // 配额挑选：先按组上限，再填满
  const perCap = new Map();
  const picked = [];
  for (const c of usable) {
    const capKey = c.group ?? c.collection;
    const cap = c.group ? HISTORY_CAP : c.cap;
    const used = perCap.get(capKey) ?? 0;
    if (used >= cap) continue;
    if (picked.length >= TARGET) break;
    perCap.set(capKey, used + 1);
    picked.push(c);
  }

  // 不够就用二十四史/佛经补？这里如实报告，不静默造假
  const entries = picked.map((c) => ({
    slug: `vol-${createHash('sha1').update(c.page).digest('hex').slice(0, 10)}`,
    page: c.page,
    title: c.group === '二十四史' ? volumeTitle(c.page, c.collection) : volumeTitle(c.page, c.collection),
    author: null,
    authorDeathYear: null,
    licenseBasis: 'public-domain',
    licenseNote: c.note,
    chapters: [c.page],
    bytes: c.bytes,
    category: c.group === '二十四史' ? '二十四史' : c.collection,
    sourceUrl: `https://zh.wikisource.org/wiki/${encodeURIComponent(c.page.replace(/ /g, '_'))}`,
    fetchedAt: new Date().toISOString(),
  }));

  const catalog = {
    version: 1,
    source: 'zh.wikisource.org',
    mode: 'volumes',
    generatedAt: new Date().toISOString(),
    entries,
  };
  await writeFile(CATALOG, JSON.stringify(catalog, null, 2) + '\n', 'utf8');

  const byCat = new Map();
  for (const e of entries) byCat.set(e.category, (byCat.get(e.category) ?? 0) + 1);
  const bytes = entries.reduce((n, e) => n + e.bytes, 0);
  const lines = [
    '# 公版种子库采集报告（卷级路线）',
    '',
    `生成时间：${catalog.generatedAt}　来源：中文维基文库　目标：${TARGET} 卷`,
    '',
    `- 实得：**${entries.length}** 卷`,
    `- 正文合计：${(bytes / 1048576).toFixed(1)} MB（wikitext 字节）`,
    '',
    '## 来源分布',
    '',
    '| 来源 | 卷数 |',
    '| --- | ---: |',
    ...[...byCat.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${v} |`),
    '',
    '## 为什么是卷级',
    '',
    '整本要逐章抓取（800 本 × 平均 20 章 ≈ 1.6 万次请求），维基文库匿名 API',
    '限速约 14 次/45 秒，那是十几小时。卷级每本 1 个页面，800 本 ≈ 800 次请求。',
    '代价是粒度更细（《全唐詩·卷001》），换来的是**本轮真的能铺完**。',
    '',
    '## 授权依据',
    '',
    '全部条目来自清代以前成书的公版总集 / 正史，逐条 licenseNote 记录来源与年代；',
    '不收任何民國/現代分类下的作品。',
    '',
    '## 复现',
    '',
    '```bash',
    'node scripts/seed/harvest-volumes.mjs',
    'node scripts/seed/harvest-volumes.mjs --validate-only',
    '```',
    '',
  ];
  await writeFile(REPORT, lines.join('\n'), 'utf8');
  console.error(`完成：${entries.length} 卷，${(bytes / 1048576).toFixed(1)} MB`);
}

// ── 校验 ──────────────────────────────────────────────────────────────────
async function validate() {
  let catalog;
  try {
    catalog = JSON.parse(await readFile(CATALOG, 'utf8'));
  } catch (err) {
    console.error(`✗ 读不到 seed/catalog.json：${err.message}`);
    process.exitCode = 1;
    return;
  }
  const problems = [];
  const entries = catalog.entries ?? [];
  if (entries.length !== TARGET) problems.push(`条数 ${entries.length}，要求 ${TARGET}`);
  const seen = new Set();
  const perCat = new Map();
  for (const e of entries) {
    if (seen.has(e.page)) problems.push(`${e.page}: 重复`);
    seen.add(e.page);
    if (e.licenseBasis !== 'public-domain' || !e.licenseNote) problems.push(`${e.page}: 授权依据缺失`);
    if (!Array.isArray(e.chapters) || e.chapters.length !== 1 || e.chapters[0] !== e.page) {
      problems.push(`${e.page}: chapters 必须恰好是 [page]`);
    }
    if ((e.bytes ?? 0) < MIN_VOLUME_BYTES) problems.push(`${e.page}: 正文过短（${e.bytes}）`);
    if (/(序|跋|目錄|凡例|提要|後記|前言|索引)$/.test(e.page)) problems.push(`${e.page}: 标题像序跋`);
    perCat.set(e.category ?? '?', (perCat.get(e.category ?? '?') ?? 0) + 1);
  }
  if (problems.length === 0) {
    console.log(`✓ 清单合格：${entries.length} 卷，来源 ${perCat.size} 个。`);
    return;
  }
  console.error(`✗ 校验未通过（${problems.length} 项）：`);
  for (const p of problems.slice(0, 30)) console.error(`  · ${p}`);
  process.exitCode = 1;
}

if (process.argv.includes('--validate-only')) await validate();
else {
  await collect();
  await validate();
}
