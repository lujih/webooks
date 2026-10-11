/**
 * 管理接口。全部需要 ADMIN_TOKEN；未配置 token 时整个路由返回 404，
 * 避免"忘记设置密钥"变成公开的写入口。
 */

import type { Env, Settings } from '../config';
import { letterBucket } from '../lib/collections';
import {
  adminListBooks,
  adminTotals,
  deleteBook,
  findBooksByLeafNames,
  listBucketTotals,
  rebuildBuckets,
  upsertBookStatement,
} from '../lib/db';
import { hasAdminToken } from '../lib/auth';
import { jsonResponse, textResponse } from '../lib/http';
import { deriveMetadata, leafNameFromKey, safeContentTypeFor, sanitiseLeafName, sha256Hex } from '../lib/metadata';
import { davCache, purgeEntries } from '../lib/cache';

const BATCH_SIZE = 50;
const MAX_LIST_LIMIT = 1000;

function authorised(request: Request, url: URL, cfg: Settings): boolean {
  return hasAdminToken(request, url, cfg.adminToken);
}

export async function handleAdmin(
  request: Request,
  env: Env,
  cfg: Settings,
  url: URL,
): Promise<Response> {
  if (!cfg.adminToken) return textResponse(404, 'Not Found');
  if (!authorised(request, url, cfg)) return textResponse(403, 'Forbidden');
  if (request.method !== 'POST' && request.method !== 'GET') {
    return textResponse(405, 'Method Not Allowed', { allow: 'GET, POST' });
  }

  const action = url.pathname.slice('/api/admin/'.length).replace(/\/+$/, '');
  switch (action) {
    case 'reindex':
      return reindex(env, url);
    case 'stats':
      return stats(env);
    case 'books':
      return listBooksAction(env, url);
    case 'delete':
      return deleteBooks(env, cfg, request);
    case 'purge':
      return purge(env, cfg, url);
    default:
      return textResponse(404, `Unknown admin action: ${action}`);
  }
}

/**
 * 列出全部书（管理视角）。
 * 返回体积统计与安全配置状态 —— 「有没有人在乱传/乱删」是后台最该一眼看到的事。
 */
async function listBooksAction(env: Env, url: URL): Promise<Response> {
  const q = url.searchParams.get('q') ?? '';
  const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get('limit') ?? '100', 10) || 100, 1), 500);
  const offset = Math.max(Number.parseInt(url.searchParams.get('offset') ?? '0', 10) || 0, 0);

  const [rows, totals] = await Promise.all([
    adminListBooks(env.DB, q, limit, offset),
    adminTotals(env.DB),
  ]);

  return Response.json({
    total: totals.books,
    usedBytes: totals.bytes,
    query: q,
    limit,
    offset,
    books: rows.map((b) => ({
      leafName: b.leaf_name,
      title: b.title,
      author: b.author,
      format: b.format,
      size: b.size,
      createdAt: b.created_at,
      hasCover: !!b.cover_key,
    })),
    security: securityStatus(env),
  });
}

/**
 * 删除若干本书（同时清理 R2 对象与封面）。
 * 这是管理后台的核心动作 —— 遇到侵权/恶意内容要能立刻移除。
 */
async function deleteBooks(env: Env, cfg: Settings, request: Request): Promise<Response> {
  let body: { leafNames?: unknown };
  try {
    body = (await request.json()) as { leafNames?: unknown };
  } catch {
    return jsonResponse({ error: 'bad-json' }, 400);
  }
  const raw = Array.isArray(body.leafNames) ? body.leafNames : [];
  const names = raw.filter((n): n is string => typeof n === 'string' && n.length > 0).slice(0, 200);
  if (names.length === 0) return jsonResponse({ error: 'no-leaf-names' }, 400);

  const found = await findBooksByLeafNames(env.DB, names);
  const deleted: string[] = [];
  const missing: string[] = names.filter((n) => !found.some((b) => b.leaf_name === n));

  for (const b of found) {
    await env.BUCKET.delete(b.r2_key);
    if (b.cover_key) await env.BUCKET.delete(b.cover_key);
    await deleteBook(env.DB, b.id);
    deleted.push(b.leaf_name);
  }

  if (deleted.length > 0) {
    await rebuildBuckets(env.DB);
    // 让读者侧的目录缓存立刻失效，否则删掉的书在 TTL 内仍会显示
    const targets: Array<readonly [string, 0 | 1]> = [['/', 1]];
    for (const b of found) {
      targets.push(
        [`/title/${b.title_letter}/`, 1],
        [`/author/${b.author_letter}/`, 1],
        [`/format/${b.format_bucket}/`, 1],
        ['/recent/', 1],
      );
    }
    await purgeEntries(targets);
  }

  return jsonResponse({ deleted, deletedCount: deleted.length, missing });
}

/**
 * 安全配置状态 —— 直接告诉使用者「哪些防护开着、哪些没开」。
 * 这是「不懂网络安全的人也能判断自己站点是否安全」的关键。
 *
 * 注意：ok 的判断必须与 hint 的文案完全一致，否则会出现
 * 「显示未启用、说明却写已启用」这种自相矛盾（踩过一次）。
 */
function securityStatus(env: Env): Array<{ key: string; ok: boolean; label: string; hint: string }> {
  const hasSiteKey = !!env.TURNSTILE_SITE_KEY;
  const hasSecret = !!env.TURNSTILE_SECRET;
  const uploadReady = !!(
    env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_ACCOUNT_ID && env.R2_BUCKET_NAME
  );
  const quota = Number.parseInt(env.DAILY_WRITE_QUOTA ?? '', 10) || 300;
  const sizeCap = Number.parseInt(env.MAX_UPLOAD_BYTES ?? '', 10) || 209715200;

  let turnstileHint: string;
  if (hasSiteKey && hasSecret) turnstileHint = '已启用：网页上传需通过验证码';
  else if (!hasSiteKey && !hasSecret) turnstileHint = '未启用：未配置 TURNSTILE_SITE_KEY / TURNSTILE_SECRET';
  else if (!hasSiteKey) turnstileHint = '不完整：缺 TURNSTILE_SITE_KEY（前端画不出验证码组件）';
  else turnstileHint = '不完整：缺 TURNSTILE_SECRET（服务端无法校验，上传会被拒）';

  return [
    {
      key: 'writeToken',
      ok: !!env.WRITE_TOKEN,
      label: '删除/覆盖口令',
      hint: env.WRITE_TOKEN
        ? '已启用：陌生人无法删除或替换书库内容'
        : '未启用：任何人都能删光书库。用 wrangler secret put WRITE_TOKEN 设置',
    },
    {
      key: 'adminToken',
      ok: !!env.ADMIN_TOKEN,
      label: '管理后台口令',
      hint: env.ADMIN_TOKEN ? '已启用' : '未启用：后台无法登录',
    },
    {
      key: 'turnstile',
      ok: hasSiteKey && hasSecret,
      label: '网页上传人机验证',
      hint: turnstileHint,
    },
    {
      key: 'uploadApi',
      ok: uploadReady,
      label: '网页上传通道',
      hint: uploadReady
        ? '已配置：网页上传可用'
        : '缺少 R2 凭据（R2_ACCESS_KEY_ID 等）：网页上传不可用，只能走 WebDAV',
    },
    {
      key: 'sizeCap',
      ok: sizeCap > 0,
      label: '单文件大小上限',
      hint: sizeCap > 0
        ? `${Math.round(sizeCap / 1024 / 1024)} MiB（超出返回 413）`
        : '未限制：一个脚本即可写满 R2 免费配额',
    },
    {
      key: 'throttle',
      ok: quota > 0,
      label: '每日写入节流',
      hint: quota > 0 ? `${quota} 次/IP/日（尽力而为，非硬限制）` : '已关闭',
    },
  ];
}

/**
 * 把 R2 里已有的书索引进 D1。
 * 幂等：id 由对象键的哈希推导，重复运行不会产生重复记录。
 * 一次调用最多处理 MAX_LIST_LIMIT 个对象；返回 nextCursor 时用同一个 cursor 再调一次。
 */
async function reindex(env: Env, url: URL): Promise<Response> {
  const prefix = url.searchParams.get('prefix') ?? 'library/';
  const cursor = url.searchParams.get('cursor') ?? undefined;
  const limit = Math.min(
    Math.max(Number.parseInt(url.searchParams.get('limit') ?? '500', 10) || 500, 1),
    MAX_LIST_LIMIT,
  );

  const listing = await env.BUCKET.list({ prefix, cursor, limit });

  const statements: D1PreparedStatement[] = [];
  let skipped = 0;

  for (const object of listing.objects) {
    // R2 控制台创建的"目录占位对象"（键以 / 结尾且为 0 字节）跳过
    if (object.key.endsWith('/')) {
      skipped++;
      continue;
    }
    const leafName = sanitiseLeafName(leafNameFromKey(object.key));
    if (!leafName) {
      skipped++;
      continue;
    }
    const meta = deriveMetadata(leafName);
    const id = `r2-${(await sha256Hex(object.key)).slice(0, 20)}`;

    statements.push(
      upsertBookStatement(env.DB, {
        id,
        leafName,
        title: meta.title,
        author: meta.author,
        language: null,
        format: meta.format,
        // 同样只按扩展名推导：R2 里旧对象的元数据可能带 text/html（历史漏洞遗留）
        contentType: safeContentTypeFor(leafName),
        size: object.size,
        sha256: null,
        r2Key: object.key,
        etag: object.etag,
        titleLetter: letterBucket(meta.title),
        authorLetter: letterBucket(meta.author ?? meta.title),
        formatBucket: meta.format,
        publishedAt: object.uploaded?.toISOString() ?? new Date().toISOString(),
      }),
    );
  }

  // 分批写入：D1 batch 一次别塞太多语句
  for (let i = 0; i < statements.length; i += BATCH_SIZE) {
    await env.DB.batch(statements.slice(i, i + BATCH_SIZE));
  }

  // 只有扫完整个前缀才重建分桶计数，否则中间态会让目录树看起来是空的
  const bucketsRebuilt = !listing.truncated;
  if (bucketsRebuilt) await rebuildBuckets(env.DB);

  return Response.json({
    prefix,
    indexed: statements.length,
    skipped,
    truncated: listing.truncated,
    nextCursor: listing.truncated ? listing.cursor : null,
    bucketsRebuilt,
  });
}

async function stats(env: Env): Promise<Response> {
  const collections = ['title', 'author', 'format', 'recent'] as const;
  const out: Record<string, Array<{ bucket: string; total: number }>> = {};
  let total = 0;

  for (const collection of collections) {
    const rows = await listBucketTotals(env.DB, collection);
    out[collection] = rows;
    if (collection === 'recent') total = rows.reduce((sum, r) => sum + r.total, 0);
  }

  // 目录总数直接决定 PROPFIND 的种类上限，是预算模型里的关键输入
  const directoryCount =
    1 + // root
    collections.length + // nav
    (out.title?.length ?? 0) +
    (out.author?.length ?? 0) +
    (out.format?.length ?? 0) +
    1; // recent/

  return Response.json({ totalBooks: total, directoryCount, buckets: out });
}

/**
 * 让某个路径的条目缓存立即失效（新增/删除书之后调用）。
 * 同时清掉父路径，因为父目录的列表也变了。
 */
async function purge(env: Env, cfg: Settings, url: URL): Promise<Response> {
  if (!davCache() || cfg.propfindTtl === 0) {
    return Response.json({ purged: 0, note: 'cache disabled or unavailable' });
  }

  const rawPath = url.searchParams.get('path') ?? '/';
  const normalised = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  const parent = normalised.replace(/[^/]+\/?$/, '') || '/';

  const purged = await purgeEntries([
    [normalised, 0],
    [normalised, 1],
    [parent, 0],
    [parent, 1],
  ]);

  return Response.json({
    purged,
    attempted: 4,
    note: '缓存 TTL 到期也会自动失效；批量重建建议直接等 TTL',
  });
}
