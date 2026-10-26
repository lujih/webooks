#!/usr/bin/env node
/**
 * 公版种子库 · 备用通道：经**公开上传 API** 把本地 EPUB 推进线上库。
 *
 * 为什么需要它：正常路线是「S3 直传 R2 + /api/admin/import/manifest 登记」，
 * 那需要 R2 S3 凭据与站点 ADMIN_TOKEN。两者都拿不到时，公开上传通道是唯一
 * 不需要任何凭据的写入口（本站匿名上传本来就是开放的）。
 *
 * ⚠️ 代价（必须如实记录）：
 *   · 每本 2 次写操作（init + complete），会消耗每 IP 每日写配额；
 *     配额打满时会收到 write-quota-exceeded，脚本会停并报告已传数量。
 *   · 走的是上传通道，所以入库的 source_kind = upload、
 *     license_basis = user-declared —— 与种子库的 seed/public-domain 不同。
 *     这是通道限制，不是数据错误；事后可用管理端 SQL 更正。
 *
 * 用法：
 *   node scripts/seed/upload-via-api.mjs --limit 5
 *   node scripts/seed/upload-via-api.mjs --all
 *   node scripts/seed/upload-via-api.mjs --all --site https://你的域名 --concurrency 2
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const MANIFEST = path.join(ROOT, 'seed/submit/manifest.json');

function args() {
  const a = process.argv.slice(2);
  const out = { limit: 0, site: 'https://webooks.cszxorx.dpdns.org', concurrency: 2, credit: '公版种子' };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--all') out.limit = Infinity;
    else if (a[i] === '--limit') out.limit = Number.parseInt(a[++i] ?? '', 10) || 0;
    else if (a[i] === '--site') out.site = (a[++i] ?? '').replace(/\/+$/, '');
    else if (a[i] === '--concurrency') out.concurrency = Math.max(1, Number.parseInt(a[++i] ?? '', 10) || 2);
    else if (a[i] === '--credit') out.credit = a[++i] ?? '公版种子';
  }
  if (!out.limit) out.limit = 5;
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(url, init, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, init);
      if (res.status === 429 || res.status >= 500) {
        await sleep(500 * (i + 1));
        continue;
      }
      return res;
    } catch (err) {
      if (i === tries - 1) throw err;
      await sleep(500 * (i + 1));
    }
  }
  throw new Error(`请求失败：${url}`);
}

/** 单本：init → PUT 字节 → complete。返回 {ok} 或 {skip} 或 {blocked} / {error} */
async function uploadOne(site, book, credit) {
  const file = path.join(ROOT, 'seed/submit', book.r2Key);
  const bytes = await readFile(file);

  const initRes = await req(`${site}/api/upload/init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filename: book.leafName, size: bytes.byteLength }),
  });
  const init = await initRes.json();
  if (init.error === 'write-quota-exceeded') return { blocked: 'quota' };
  if (init.error) return { error: `init:${init.error}` };

  const putRes = await req(init.uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': init.headers['content-type'] },
    body: bytes,
  });
  if (!putRes.ok) return { error: `put:${putRes.status}` };

  const doneRes = await req(`${site}/api/upload/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: init.key, filename: book.leafName, size: bytes.byteLength, credit }),
  });
  const done = await doneRes.json();
  if (done.error === 'write-quota-exceeded') return { blocked: 'quota' };
  if (done.error === 'already-exists') return { skip: true };
  if (done.error) return { error: `complete:${done.error}` };
  return { ok: true };
}

const A = args();
const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
const books = manifest.entries.slice(0, A.limit === Infinity ? undefined : A.limit);

console.log(`目标 ${books.length} 本 → ${A.site}，并发 ${A.concurrency}`);
let ok = 0, skip = 0, blocked = false;
const errors = [];

let next = 0;
async function worker() {
  while (!blocked) {
    const i = next++;
    if (i >= books.length) return;
    const b = books[i];
    try {
      const r = await uploadOne(A.site, b, A.credit);
      if (r.blocked) {
        blocked = true;
        console.log(`\n⚠️ 写配额已满（第 ${i + 1} 本起停止）：${b.leafName}`);
        return;
      }
      if (r.skip) { skip++; }
      else if (r.ok) { ok++; }
      else { errors.push(`${b.leafName}: ${r.error}`); }
    } catch (err) {
      errors.push(`${b.leafName}: ${err.message}`);
    }
    if ((ok + skip + errors.length) % 10 === 0) {
      process.stdout.write(`\r  已传 ${ok} / 跳过 ${skip} / 失败 ${errors.length}`);
    }
  }
}

await Promise.all(Array.from({ length: A.concurrency }, worker));
console.log(`\n结果：成功 ${ok}，跳过 ${skip}，失败 ${errors.length}${blocked ? '（配额中断）' : ''}`);
for (const e of errors.slice(0, 20)) console.error(`  ✗ ${e}`);
process.exitCode = blocked || errors.length ? 1 : 0;
