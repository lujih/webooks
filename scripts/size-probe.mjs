#!/usr/bin/env node
/**
 * 请求体体积边界探针。
 *
 * 目的：实测 Cloudflare 的 100 MB 请求体上限（Free/Pro 都是 100 MB），
 * 确认 WebDAV PUT 的真实天花板在哪，以及超限时的具体表现。
 *
 * 为什么必须实测：这是 zone 层（代理层）的限制，不是 Workers 计划的限制，
 * 文档说明了行为但没说明「流式 body 或 chunked 编码是否有豁免」。
 *
 * 用法：
 *   node scripts/size-probe.mjs --url https://example.com/dav/
 *   node scripts/size-probe.mjs --url https://example.com/dav/ --sizes 1,10,99,101
 *   node scripts/size-probe.mjs --url https://example.com/dav/ --dry-run
 *
 * ⚠️ 会真实上传数据：消耗 R2 存储与 Class A 操作，脚本结束时会自动删除。
 *    R2 出网免费，所以流量本身不花钱。
 *
 * 退出码：0 = 探测完成（无论结果如何）；1 = 无法连接目标。
 */

import { setTimeout as sleep } from 'node:timers/promises';

const MB = 1024 * 1024;

function parseArgs(argv) {
  const out = {
    url: process.env.DAV_URL ?? '',
    user: process.env.DAV_USER ?? '',
    pass: process.env.DAV_PASS ?? '',
    sizes: '1,10,99,101',
    timeout: 300000,
    dryRun: false,
    keep: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--url') out.url = v ?? '';
    else if (k === '--user') out.user = v ?? '';
    else if (k === '--pass') out.pass = v ?? '';
    else if (k === '--sizes') out.sizes = v ?? out.sizes;
    else if (k === '--timeout') out.timeout = Number(v) || out.timeout;
    else if (k === '--dry-run') out.dryRun = true;
    else if (k === '--keep') out.keep = true;
  }
  if (!out.url) {
    console.error('缺少 --url（或环境变量 DAV_URL）。');
    process.exit(2);
  }
  if (!out.url.endsWith('/')) out.url += '/';
  out.sizeList = out.sizes
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  if (out.sizeList.length === 0) {
    console.error('--sizes 没有解析出任何有效值');
    process.exit(2);
  }
  return out;
}

const args = parseArgs(process.argv);
const authHeader =
  args.user || args.pass
    ? `Basic ${Buffer.from(`${args.user}:${args.pass}`).toString('base64')}`
    : null;

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', red: '\x1b[31m',
  green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};

/** 生成不占内存的重复字节流 */
function payloadStream(size) {
  const CHUNK = 64 * 1024;
  const chunk = new Uint8Array(CHUNK).fill(0x41); // 'A'
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= size) {
        controller.close();
        return;
      }
      const n = Math.min(CHUNK, size - sent);
      controller.enqueue(chunk.subarray(0, n));
      sent += n;
    },
  });
}

function fmtBytes(n) {
  if (n >= MB) return `${(n / MB).toFixed(n % MB === 0 ? 0 : 1)} MB`;
  return `${(n / 1024).toFixed(1)} KB`;
}

async function putWithSize(url, size) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeout);
  const started = Date.now();
  try {
    const headers = { 'content-type': 'application/epub+zip', 'content-length': String(size) };
    if (authHeader) headers.authorization = authHeader;
    const res = await fetch(url, {
      method: 'PUT',
      headers,
      body: payloadStream(size),
      duplex: 'half',
      signal: controller.signal,
    });
    const elapsed = Date.now() - started;
    // 必须把 body 读掉，否则连接不会释放
    const text = await res.text().catch(() => '');
    return { kind: 'response', status: res.status, elapsed, snippet: text.slice(0, 200) };
  } catch (err) {
    const elapsed = Date.now() - started;
    const code = err.cause?.code ?? err.code ?? '';
    return { kind: 'error', message: err.message, code, elapsed };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  console.log(`${C.cyan}请求体边界探针${C.reset}  ${args.url}`);
  console.log(`待测尺寸：${args.sizeList.map((s) => `${s} MB`).join(' · ')}`);
  console.log('='.repeat(74));

  if (args.dryRun) {
    console.log('--dry-run：只列出计划，不实际上传。');
    console.log('');
    console.log('预期结果（基于 Cloudflare 官方文档：Free/Pro 上限 100 MB）：');
    for (const s of args.sizeList) {
      console.log(`  ${String(s).padStart(4)} MB → ${s <= 100 ? '应成功 (201/204)' : '应被拦成 413'}`);
    }
    console.log('');
    console.log('如果 >100 MB 也成功，说明该 zone 的上限更高（Business 200 MB / Enterprise 可调）。');
    return;
  }

  try {
    const opt = await fetch(args.url, {
      method: 'OPTIONS',
      headers: authHeader ? { authorization: authHeader } : {},
      signal: AbortSignal.timeout(20000),
    });
    await opt.text().catch(() => {});
    console.log(`${C.dim}OPTIONS → ${opt.status}，DAV: ${opt.headers.get('dav') ?? '(无)'}${C.reset}`);
  } catch (err) {
    console.error(`${C.red}无法连接 ${args.url}：${err.message}${C.reset}`);
    process.exit(1);
  }

  const stamp = Date.now();
  const outcomes = [];

  for (const sizeMb of args.sizeList) {
    const size = sizeMb * MB;
    const name = `__size_${sizeMb}mb_${stamp}.epub`;
    const url = new URL(`recent/${encodeURIComponent(name)}`, args.url).toString();

    process.stdout.write(`  ${String(sizeMb).padStart(4)} MB … `);
    const r = await putWithSize(url, size);

    if (r.kind === 'response') {
      const ok = r.status === 201 || r.status === 204;
      const status = ok ? 'pass' : r.status === 413 ? 'blocked' : 'other';
      outcomes.push({ sizeMb, status, detail: `HTTP ${r.status}`, elapsed: r.elapsed });
      const color = ok ? C.green : r.status === 413 ? C.yellow : C.red;
      console.log(`${color}HTTP ${r.status}${C.reset}${C.dim} (${(r.elapsed / 1000).toFixed(1)}s)${C.reset}`);
      if (r.status === 413) {
        const snippet = r.snippet.replace(/\s+/g, ' ').trim();
        if (snippet) console.log(`${C.dim}         响应体：${snippet.slice(0, 120)}${C.reset}`);
      }
    } else {
      // 超限时边缘可能直接断连，此时拿不到状态码
      const likelySize = /socket|reset|ECONNRESET|UND_ERR/i.test(`${r.code} ${r.message}`);
      outcomes.push({
        sizeMb,
        status: likelySize ? 'reset' : 'error',
        detail: r.code || r.message,
        elapsed: r.elapsed,
      });
      console.log(`${C.yellow}连接中断${C.reset}${C.dim} (${r.code || r.message}, ${(r.elapsed / 1000).toFixed(1)}s)${C.reset}`);
    }

    if (!args.keep) {
      await fetch(url, {
        method: 'DELETE',
        headers: authHeader ? { authorization: authHeader } : {},
        signal: AbortSignal.timeout(20000),
      }).then((r) => r.text()).catch(() => {});
    }
    await sleep(300); // 给 R2/D1 一点喘息，避免连续大请求互相干扰
  }

  console.log('');
  console.log('='.repeat(74));
  console.log('结论');
  console.log('-'.repeat(74));

  const succeeded = outcomes.filter((o) => o.status === 'pass');
  const blocked = outcomes.filter((o) => o.status === 'blocked' || o.status === 'reset');

  if (succeeded.length === 0) {
    console.log(`${C.red}没有任何尺寸成功。${C.reset}先确认 OPTIONS 是 200，且路径可写。`);
  } else {
    const largest = Math.max(...succeeded.map((o) => o.sizeMb));
    console.log(`实测 PUT 天花板：${C.green}≥ ${largest} MB${C.reset}`);
  }
  if (blocked.length > 0) {
    const smallestBlocked = Math.min(...blocked.map((o) => o.sizeMb));
    console.log(`首次被拒/中断：${C.yellow}${smallestBlocked} MB${C.reset}`);
    console.log('');
    console.log('这意味着：');
    console.log(`  · 电子书（EPUB 通常 <5 MB、PDF 1–50 MB）→ ${smallestBlocked > 50 ? '没问题' : '部分会受影响'}`);
    console.log(`  · 有声书（M4B 常 >100 MB）、扫描画册 → ${smallestBlocked <= 200 ? '❌ 走 WebDAV 传不上去' : '可能可以'}`);
    console.log('');
    console.log('大文件的唯一出路是绕过 Worker：');
    console.log('  1. 浏览器/客户端 → POST /api/upload/init 拿预签名 URL');
    console.log('  2. 直接 PUT 到 <ACCOUNT_ID>.r2.cloudflarestorage.com（不在被代理的 zone 内）');
    console.log('  3. POST /api/upload/complete 收尾');
    console.log('  WebDAV 协议固定为单次 PUT，用不了这条路 —— 这就是「WebDAV 只做只读挂载」的原因。');
  } else if (succeeded.length === args.sizeList.length) {
    const maxTested = Math.max(...args.sizeList);
    const testedAboveLimit = args.sizeList.some((s) => s > 100);
    if (testedAboveLimit) {
      console.log(`所有尺寸都成功，包括 ${maxTested} MB（>100 MB）。`);
      console.log('说明该 zone 的请求体上限高于 100 MB（Business 200 MB 或 Enterprise 可调）。');
    } else {
      console.log(`所有测得尺寸都成功（最大 ${maxTested} MB，还没触及 100 MB 上限）。`);
      console.log('要定位真实天花板，显式测一个超过 100 MB 的尺寸：');
      console.log(`  node scripts/size-probe.mjs --url ${args.url} --sizes 99,101,150`);
    }
  }

  const slowest = [...outcomes].sort((a, b) => b.elapsed - a.elapsed)[0];
  if (slowest) {
    console.log('');
    console.log(`${C.dim}最慢一次：${slowest.sizeMb} MB 用了 ${(slowest.elapsed / 1000).toFixed(1)}s` +
      `（${(slowest.sizeMb / (slowest.elapsed / 1000)).toFixed(1)} MB/s）${C.reset}`);
    console.log(`${C.dim}注意：字节是经 Worker 流式落 R2 的，不占内存但占 CPU 时长。${C.reset}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
