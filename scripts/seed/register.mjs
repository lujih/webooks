#!/usr/bin/env node
/**
 * 公版种子库 · 第 ④ 步：把本地清单登记进 D1。
 *
 * 前置：
 *   · `seed/submit/manifest.json` 与 EPUB 已生成（scripts/seed/build-epub.mjs）
 *   · 字节已经用 S3/rclone 直传进 R2（见 seed/README.md 第 ③ 步）
 *
 * 为什么只登记、不传字节：800 本走 Worker 是 800 次请求 + 800 次 R2 put，
 * 而 S3 直传是 0 次 Worker 请求。免费额度要留给读者，不是留给导入。
 *
 * 用法：
 *   node scripts/seed/register.mjs --dry-run
 *   node scripts/seed/register.mjs --site https://你的域名 --token "$ADMIN_TOKEN"
 *   node scripts/seed/register.mjs --site … --token … --limit 16 --no-purge
 *
 * 退出码：0 = 全部登记成功（或 dry-run 通过）；1 = 有被拒条目/校验失败。
 */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const MANIFEST = path.join(ROOT, 'seed/submit/manifest.json');
// 允许用 SEED_CATALOG 指定清单（两条路线并存：catalog.json / catalog.volumes.json）
const CATALOG = path.resolve(ROOT, process.env.SEED_CATALOG ?? 'seed/catalog.json');
const BATCH_LIMIT = 8; // 与 src/api/import-manifest.ts 的 MAX_ENTRIES 一致

/** 收尾要打掉的缓存根路径（目录列表最多 300 秒后自然刷新，这里是提前打） */
const COLLECTION_ROOTS = ['/', '/按书名/', '/按作者/', '/按类型/', '/按格式/', '/最近收录/'];

function parseArgs(argv) {
  const out = {
    dryRun: false,
    site: '',
    token: '',
    limit: Infinity,
    purge: true,
    only: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--site') out.site = (argv[++i] ?? '').replace(/\/+$/, '');
    else if (a === '--token') out.token = argv[++i] ?? '';
    else if (a === '--limit') out.limit = Number.parseInt(argv[++i] ?? '', 10) || Infinity;
    else if (a === '--only') out.only = argv[++i] ?? '';
    else if (a === '--no-purge') out.purge = false;
    else if (a === '--help' || a === '-h') {
      console.log('用法：node scripts/seed/register.mjs [--dry-run] [--site URL --token TOKEN] [--limit N] [--only slug] [--no-purge]');
      process.exit(0);
    } else {
      console.error(`未知参数：${a}`);
      process.exit(2);
    }
  }
  return out;
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exitCode = 1;
}

async function loadJson(file, what) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    fail(`${what} 读不到或不是合法 JSON：${path.relative(ROOT, file)}（${err.message}）`);
    return null;
  }
}

/** 本地一致性校验（不发任何网络请求）。返回可登记条目与问题清单。 */
async function validate(manifest, catalog) {
  const problems = [];
  const entries = [];

  if (!Array.isArray(manifest?.entries) || manifest.entries.length === 0) {
    problems.push('manifest.entries 为空');
    return { entries, problems };
  }

  const catalogBySlug = new Map();
  for (const c of catalog?.entries ?? []) catalogBySlug.set(c.slug, c);

  const seenLeaf = new Set();
  for (const e of manifest.entries) {
    const tag = e?.leafName ?? '(无 leafName)';
    if (!/^[0-9a-f]{16}$/.test(e.id ?? '')) {
      problems.push(`${tag}: id 不是 16 位十六进制`);
      continue;
    }
    if (e.r2Key !== `books/${e.id}/${e.leafName}`) {
      problems.push(`${tag}: r2Key 与 id/leafName 不自洽`);
      continue;
    }
    if (seenLeaf.has(e.leafName)) {
      problems.push(`${tag}: leafName 重复`);
      continue;
    }
    seenLeaf.add(e.leafName);

    if (e.licenseBasis !== 'public-domain') {
      problems.push(`${tag}: licenseBasis 必须是 public-domain（实际 ${e.licenseBasis}）`);
      continue;
    }
    if (!e.title) {
      problems.push(`${tag}: 缺 title`);
      continue;
    }

    const cat = catalogBySlug.get(e.slug);
    if (catalog) {
      if (!cat) problems.push(`${tag}: catalog 里找不到 slug=${e.slug}`);
      else if (!cat.licenseNote) problems.push(`${tag}: catalog 缺 licenseNote（授权依据必须可读）`);
    }

    const file = path.join(ROOT, 'seed/submit', e.r2Key);
    let size = 0;
    try {
      size = (await stat(file)).size;
    } catch {
      problems.push(`${tag}: 本地文件不存在（${path.relative(ROOT, file)}）`);
      continue;
    }
    if (size !== e.size) {
      problems.push(`${tag}: 文件大小与清单不符（磁盘 ${size} / 清单 ${e.size}）`);
      continue;
    }
    entries.push(e);
  }

  return { entries, problems };
}

async function postBatch(site, token, entries) {
  const url = `${site}/api/admin/import/manifest`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ entries }),
    });
    if (res.status >= 500 || res.status === 429) {
      await new Promise((r) => setTimeout(r, 500 * attempt));
      continue;
    }
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 下面按状态码处理 */
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}：${text.slice(0, 300)}`);
    }
    return json;
  }
  throw new Error('连续 3 次 5xx/429，放弃这一批');
}

async function purgeRoots(site, token) {
  let ok = 0;
  for (const p of COLLECTION_ROOTS) {
    try {
      const res = await fetch(`${site}/api/admin/purge?path=${encodeURIComponent(p)}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
      if (res.ok) ok++;
    } catch {
      /* 打缓存失败不影响登记结果 */
    }
  }
  console.log(`  · 缓存根路径已打掉 ${ok}/${COLLECTION_ROOTS.length}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = await loadJson(MANIFEST, 'seed/submit/manifest.json');
  if (!manifest) return;
  const catalog = await loadJson(CATALOG, 'seed/catalog.json'); // 可选，仅用于交叉核对

  const { entries, problems } = await validate(manifest, catalog);
  for (const p of problems) fail(p);

  let selected = entries;
  if (args.only) selected = selected.filter((e) => e.slug === args.only);
  selected = selected.slice(0, args.limit);

  const bytes = selected.reduce((n, e) => n + e.size, 0);
  console.log(
    `清单 ${entries.length} 条，本次处理 ${selected.length} 条，共 ${(bytes / 1048576).toFixed(1)} MB；` +
      `预计 ${Math.ceil(selected.length / BATCH_LIMIT)} 次 Worker 请求。`,
  );
  if (problems.length > 0) {
    console.error(`✗ 发现 ${problems.length} 个问题，未发送任何请求。`);
    return;
  }

  if (args.dryRun) {
    console.log('✓ dry-run 通过：清单自洽、文件齐全、授权依据齐备（未发任何请求）。');
    return;
  }

  if (!args.site || !args.token) {
    console.error('✗ 真正登记需要 --site 与 --token（ADMIN_TOKEN）。想只校验请加 --dry-run。');
    process.exitCode = 1;
    return;
  }

  let registered = 0;
  let existing = 0;
  const rejected = [];
  const batches = [];
  for (let i = 0; i < selected.length; i += BATCH_LIMIT) batches.push(selected.slice(i, i + BATCH_LIMIT));

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    try {
      const json = await postBatch(args.site, args.token, batch);
      registered += json.registered?.length ?? 0;
      existing += json.existing?.length ?? 0;
      for (const r of json.rejected ?? []) rejected.push(r);
      process.stdout.write(
        `\r  批次 ${b + 1}/${batches.length}：已登记 ${registered}，已存在 ${existing}，被拒 ${rejected.length}`,
      );
    } catch (err) {
      fail(`批次 ${b + 1} 失败：${err.message}`);
      break;
    }
  }
  process.stdout.write('\n');

  if (args.purge && registered > 0) await purgeRoots(args.site, args.token);

  console.log(`\n结果：登记 ${registered} 本，已存在 ${existing} 本，被拒 ${rejected.length} 本。`);
  if (rejected.length > 0) {
    for (const r of rejected.slice(0, 20)) console.error(`  ✗ ${r.leafName}：${r.code} ${r.detail ?? ''}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`✗ ${err.stack ?? err.message}`);
  process.exit(1);
});
