/** WebDAV 方法分发。Class 1（不含 LOCK/UNLOCK），读为主。 */

import type { Env, Settings } from '../config';
import { letterBucket, resolveNode, type DavNode } from '../lib/collections';
import { deleteBook, findBookByLeaf, rebuildBuckets } from '../lib/db';
import { methodNotAllowed, shortId, textResponse } from '../lib/http';
import { preferContentType, deriveMetadata, sanitiseLeafName } from '../lib/metadata';
import { checkPreconditions } from '../lib/preconditions';
import { parseEpub, PARSE_SIZE_CAP, type EpubMeta } from '../lib/epub';
import { bookCacheTargets, purgeEntries } from '../lib/cache';
import { collectDavEntries, handlePropfind, type Entry } from './propfind';
import { escapeXml } from '../lib/xml';
import { listBooks, upsertBook } from '../lib/db';

const ALLOW = 'OPTIONS, GET, HEAD, PROPFIND, PUT, DELETE';

/**
 * DAV 合规等级头（RFC 4918 §18）：
 *   1 = Class 1（无锁）
 *   2 = Class 2（支持 LOCK/UNLOCK）—— 本服务是只读库，不支持
 *   3 = 符合 RFC 4918 全部要求
 * 只宣告我们真的做到了的等级，虚报会让客户端做出错误假设。
 */
const DAV_HEADER = '1, 3';

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
        dav: DAV_HEADER,
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
      // RFC 5689 Extended MKCOL 也不支持：本服务的集合是虚拟视图（由 D1 派生），
      // 客户端无法真正创建目录。用 405 + Allow 明确告知可用动词。
      return textResponse(405, 'Collections are virtual and cannot be created with MKCOL', { allow: ALLOW });
    case 'MOVE':
    case 'COPY':
      return davErrorResponse(501, `${method} is not implemented (read-mostly library)`, ALLOW);
    case 'LOCK':
    case 'UNLOCK':
      // 未宣告 Class 2 时按 RFC 4918 §10.2 返回 501，并带上
      // <D:supported-lock/> 说明不支持任何锁类型 —— 否则客户端会一直重试。
      return davErrorResponse(501, 'LOCK/UNLOCK is not supported (WebDAV Class 1)', ALLOW, 'supported-lock');
    case 'PROPPATCH':
      // RFC 4918 §14：只读属性必须用 DAV 错误体明确拒绝，
      // 不能返回纯文本 —— 部分客户端解析失败后会当作服务端故障。
      return davErrorResponse(403, 'Properties are read-only', ALLOW, 'cannot-modify-protected-property');
    default:
      return methodNotAllowed(ALLOW);
  }
}

/**
 * 合规的 DAV 错误响应。
 *
 * RFC 4918 §16 定义了 <D:error> 预置元素（如 <D:cannot-modify-protected-property/>、
 * <D:supported-lock/>），要求用 application/xml 返回。返回纯文本会让部分客户端
 * 把它当成 5xx 传输故障反复重试，而不是理解为「服务端明确拒绝该操作」。
 */
function davErrorResponse(
  status: number,
  message: string,
  allow: string,
  precondition?: string,
): Response {
  const inner = precondition ? `<D:${precondition}/>` : '';
  const xml =
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<D:error xmlns:D="DAV:">${inner}<D:responsedescription>${escapeXml(message)}</D:responsedescription></D:error>`;
  return new Response(xml, {
    status,
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      allow,
    },
  });
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

  // 条件请求（RFC 9110 §13.1）：在**写入之前**判定，否则会把别人的书覆盖掉。
  // 同步客户端依赖 If-None-Match: * 做到「仅新建、不覆盖」，服务端必须配合。
  const currentEtag = existing?.etag ? `"${existing.etag}"` : null;
  const precondition = checkPreconditions(request.headers, currentEtag);
  if (!precondition.ok) {
    return textResponse(412, `Precondition Failed: ${precondition.reason}`, { allow: ALLOW });
  }

  // EPUB 且预计不超解析上限：读进内存以便解析真实元数据/封面。
  // 不用 Content-Length 当门槛——很多客户端（rclone/脚本）不带该头或走 chunked，
  // 依赖它会漏解析。改为：EPUB 就尝试读，读完看实际字节数，超 50MB 立即丢弃不解析。
  const isEpub = meta.format === 'epub';

  let parsed: EpubMeta | null = null;
  let coverKey: string | null = null;
  let object;

  if (isEpub) {
    const buf = await request.arrayBuffer();
    if (buf.byteLength <= PARSE_SIZE_CAP) {
      object = await env.BUCKET.put(r2Key, new Uint8Array(buf), { httpMetadata: { contentType } });
      try {
        parsed = await parseEpub(buf);
        if (parsed?.cover) {
          const coverType = parsed.cover.contentType || 'image/jpeg';
          const ext = coverType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'jpg';
          coverKey = `covers/${id}.${ext}`;
          await env.BUCKET.put(coverKey, new Uint8Array(parsed.cover.bytes), {
            httpMetadata: { contentType: coverType },
          });
        }
      } catch {
        // 解析失败不影响写入，退回文件名推导
      }
    } else {
      // 超大 EPUB：不落完整字节也能存（R2 流式），但不解析
      object = await env.BUCKET.put(r2Key, buf, { httpMetadata: { contentType } });
    }
  } else {
    // 非 EPUB：直接流式落 R2，绝不把 body 读进内存（isolate 上限 128MB）
    object = await env.BUCKET.put(r2Key, request.body, {
      httpMetadata: { contentType },
    });
  }

  const title = parsed?.title ?? meta.title;
  const author = parsed?.author ?? meta.author;

  await upsertBook(env.DB, {
    id,
    leafName,
    title,
    author,
    language: parsed?.language ?? null,
    format: meta.format,
    contentType,
    size: object?.size ?? 0,
    sha256: null, // Phase 1：Queue consumer 计算哈希并校验墓碑表
    r2Key,
    etag: object?.etag ?? null,
    titleLetter: letterBucket(title),
    authorLetter: letterBucket(author ?? title),
    formatBucket: meta.format,
    publishedAt: new Date().toISOString(),
    coverKey,
  });

  // 分桶计数重建。全表聚合在写入频率低时开销可接受；
  // 写量大时应改为 Queue + 增量计数（见 README「已知取舍」）。
  await rebuildBuckets(env.DB);

  // 写入后立刻失效相关缓存。不做这一步的话，客户端在 TTL 内 PROPFIND 会拿到旧列表，
  // 更糟的是 DELETE 之后叶子仍返回 207，同步客户端会误判文件还在。
  await purgeEntries(
    bookCacheTargets({
      leafName,
      titleLetter: letterBucket(title),
      authorLetter: letterBucket(author ?? title),
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
