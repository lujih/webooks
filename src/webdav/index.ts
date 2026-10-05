/** WebDAV 方法分发。Class 1（不含 LOCK/UNLOCK），读为主。 */

import type { Env, Settings } from '../config';
import { letterBucket, resolveNode, type DavNode } from '../lib/collections';
import { deleteBook, findBookByLeaf, rebuildBuckets, upsertBook } from '../lib/db';
import { methodNotAllowed, shortId, textResponse } from '../lib/http';
import { preferContentType, deriveMetadata, sanitiseLeafName } from '../lib/metadata';
import { bookCacheTargets, purgeEntries } from '../lib/cache';
import { collectDavEntries, handlePropfind, type Entry } from './propfind';

const ALLOW = 'OPTIONS, GET, HEAD, PROPFIND, PUT, DELETE';

export async function handleDav(
  request: Request,
  env: Env,
  cfg: Settings,
  davPath: string,
): Promise<Response> {
  const method = request.method.toUpperCase();

  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: {
        allow: ALLOW,
        // Class 1：明确声明不支持 LOCK，客户端会退回无锁模式
        dav: '1',
        'ms-author-via': 'DAV',
      },
    });
  }

  if (method === 'PROPFIND') return handlePropfind(request, env, cfg, davPath);

  const node = resolveNode(davPath);

  switch (method) {
    case 'GET':
    case 'HEAD':
      return handleGet(env, cfg, node, davPath, method === 'HEAD');
    case 'PUT':
      return handlePut(request, env, node);
    case 'DELETE':
      return handleDelete(env, node);
    case 'MKCOL':
      return textResponse(405, 'Collections are virtual and cannot be created with MKCOL', { allow: ALLOW });
    case 'MOVE':
    case 'COPY':
      return textResponse(501, 'MOVE/COPY not implemented in Phase 0', { allow: ALLOW });
    case 'LOCK':
    case 'UNLOCK':
      return textResponse(501, 'LOCK/UNLOCK not implemented (WebDAV Class 1)', { allow: ALLOW });
    case 'PROPPATCH':
      return textResponse(403, 'Properties are read-only', { allow: ALLOW });
    default:
      return methodNotAllowed(ALLOW);
  }
}

// ── 读 ──────────────────────────────────────────────────────────────────

async function handleGet(
  env: Env,
  cfg: Settings,
  node: DavNode,
  davPath: string,
  headOnly: boolean,
): Promise<Response> {
  if (node.kind === 'leaf') {
    const book = await findBookByLeaf(env.DB, node.leafName);
    if (!book) return textResponse(404, 'Not Found');

    if (headOnly) {
      // HEAD 直接回元数据，省掉客户端为了拿大小而多跑一次重定向
      return new Response(null, {
        status: 200,
        headers: {
          'content-length': String(book.size),
          'content-type': book.content_type,
          etag: `"${book.etag ?? book.id}"`,
          'last-modified': new Date(book.updated_at).toUTCString(),
          'accept-ranges': 'bytes',
        },
      });
    }

    // 关键：302 跳到 R2 公开自定义域。
    // 下载字节完全不过 Worker —— 不占 CPU/内存，也不会被 100MB 请求体上限卡住；
    // R2 出网本来就免费，还能被 CDN 缓存。
    return new Response(null, {
      status: 302,
      headers: {
        location: `${cfg.r2PublicBase}/${encodeR2Key(book.r2_key)}`,
        'cache-control': 'no-store',
      },
    });
  }

  // 目录：给浏览器一个简单的 HTML 列表，并让 CDN 缓存，重复浏览不消耗 Worker 请求。
  const entries = await collectDavEntries(node, 1, env, cfg);
  if (!entries) return textResponse(404, 'Not Found');

  const headers = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'public, max-age=300',
  };
  if (headOnly) return new Response(null, { status: 200, headers });
  return new Response(renderHtmlIndex(davPath, entries, cfg.mountPath), { status: 200, headers });
}

function encodeR2Key(key: string): string {
  return key.split('/').map((s) => encodeURIComponent(s)).join('/');
}

export function renderHtmlIndex(davPath: string, entries: Entry[], mountPath: string): string {
  const rows = entries
    .filter((e) => e.path !== davPath)
    .map((e) => {
      const label = e.isCollection ? `${e.meta.displayName}/` : e.meta.displayName;
      const size = e.isCollection ? '' : ` <span class="sz">${formatSize(e.meta.contentLength ?? 0)}</span>`;
      return `<li><a href="${escapeAttr(`${mountPath}${e.path}`)}">${escapeAttr(label)}</a>${size}</li>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeAttr(davPath)} — webooks</title>
<style>
  body{font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem;color:#1a1a1a}
  h1{font-size:1.05rem;font-weight:600;border-bottom:1px solid #e5e5e5;padding-bottom:.5rem;word-break:break-all}
  ul{list-style:none;padding:0}li{padding:.15rem 0}
  a{color:#0b62d0;text-decoration:none}a:hover{text-decoration:underline}
  .sz{color:#999;font-size:.85em}
  footer{margin-top:2rem;color:#888;font-size:.85rem}
</style></head>
<body>
<h1>${escapeAttr(davPath)}</h1>
<ul>${rows}</ul>
<footer>WebDAV 端点 <code>/dav/</code> · 客户端挂载建议用 rclone（见 README）</footer>
</body></html>`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function escapeAttr(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

// ── 写 ──────────────────────────────────────────────────────────────────

async function handlePut(request: Request, env: Env, node: DavNode): Promise<Response> {
  if (node.kind !== 'leaf') {
    return textResponse(405, 'PUT is only allowed on file paths', { allow: ALLOW });
  }

  const leafName = sanitiseLeafName(node.leafName);
  if (!leafName) return textResponse(400, 'Invalid file name');
  if (!request.body) return textResponse(411, 'Length Required');

  const meta = deriveMetadata(leafName);
  const existing = await findBookByLeaf(env.DB, leafName);
  const id = existing?.id ?? shortId(8);
  const r2Key = `books/${id}`;
  // 客户端给泛型类型（如 text/plain、application/octet-stream）时以扩展名为准
  const contentType = preferContentType(request.headers.get('content-type'), meta.contentType);

  // 直接流式落 R2，绝不把 body 读进内存（isolate 上限 128MB）
  const object = await env.BUCKET.put(r2Key, request.body, {
    httpMetadata: { contentType },
  });

  await upsertBook(env.DB, {
    id,
    leafName,
    title: meta.title,
    author: meta.author,
    language: null,
    format: meta.format,
    contentType,
    size: object?.size ?? 0,
    sha256: null, // Phase 1：Queue consumer 计算哈希并校验墓碑表
    r2Key,
    etag: object?.etag ?? null,
    titleLetter: letterBucket(meta.title),
    authorLetter: letterBucket(meta.author ?? meta.title),
    formatBucket: meta.format,
    publishedAt: new Date().toISOString(),
  });

  // 分桶计数重建。全表聚合在写入频率低时开销可接受；
  // 写量大时应改为 Queue + 增量计数（见 README「已知取舍」）。
  await rebuildBuckets(env.DB);

  // 写入后立刻失效相关缓存。不做这一步的话，客户端在 TTL 内 PROPFIND 会拿到旧列表，
  // 更糟的是 DELETE 之后叶子仍返回 207，同步客户端会误判文件还在。
  await purgeEntries(
    bookCacheTargets({
      leafName,
      titleLetter: letterBucket(meta.title),
      authorLetter: letterBucket(meta.author ?? meta.title),
      formatBucket: meta.format,
    }),
  );

  const headers = new Headers();
  if (object?.etag) headers.set('etag', `"${object.etag}"`);
  return new Response(null, { status: existing ? 204 : 201, headers });
}

async function handleDelete(env: Env, node: DavNode): Promise<Response> {
  if (node.kind !== 'leaf') {
    return textResponse(405, 'DELETE is only allowed on file paths', { allow: ALLOW });
  }
  const book = await findBookByLeaf(env.DB, node.leafName);
  if (!book) return textResponse(404, 'Not Found');

  await env.BUCKET.delete(book.r2_key);
  await deleteBook(env.DB, book.id);
  await rebuildBuckets(env.DB);

  // 同上：不失效的话，已删除的文件在 TTL 内仍会返回 207
  await purgeEntries(
    bookCacheTargets({
      leafName: book.leaf_name,
      titleLetter: book.title_letter,
      authorLetter: book.author_letter,
      formatBucket: book.format_bucket,
    }),
  );

  return new Response(null, { status: 204 });
}
