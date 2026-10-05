/**
 * 管理接口。全部需要 ADMIN_TOKEN；未配置 token 时整个路由返回 404，
 * 避免"忘记设置密钥"变成公开的写入口。
 */

import type { Env, Settings } from '../config';
import { letterBucket } from '../lib/collections';
import { listBucketTotals, rebuildBuckets, upsertBookStatement } from '../lib/db';
import { textResponse } from '../lib/http';
import { deriveMetadata, leafNameFromKey, preferContentType, sanitiseLeafName, sha256Hex } from '../lib/metadata';
import { davCache, purgeEntries } from '../lib/cache';

const BATCH_SIZE = 50;
const MAX_LIST_LIMIT = 1000;

/** 定长比较，避免 token 通过响应时间泄漏 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorised(request: Request, url: URL, cfg: Settings): boolean {
  if (!cfg.adminToken) return false;
  const header = request.headers.get('authorization') ?? '';
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  const provided = bearer || (url.searchParams.get('token') ?? '');
  return provided.length > 0 && safeEqual(provided, cfg.adminToken);
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
    case 'purge':
      return purge(env, cfg, url);
    default:
      return textResponse(404, `Unknown admin action: ${action}`);
  }
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
        contentType: preferContentType(object.httpMetadata?.contentType, meta.contentType),
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
