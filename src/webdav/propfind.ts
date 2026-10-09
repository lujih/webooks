/**
 * PROPFIND —— 免费方案的性能与预算核心。
 *
 * 三条关键措施：
 *   1. 目录树来自 D1，绝不调用 R2 list()。否则每次 PROPFIND = 1 次 Class A 操作，
 *      10 万次/天 × 30 天 = 300 万次/月，会超出 100 万次免费额度并产生约 $9/月账单
 *      —— 比直接买 $5 的 Workers Paid 还贵。
 *   2. 生成的 207 XML 进 Cache API。命中时 0 次 D1 读、0 次 R2 操作、CPU 接近 0。
 *   3. 单目录子项数硬上限 200，保证 XML 生成留在 Workers Free 的 10ms CPU 之内。
 *
 * Depth 语义（有意偏离 RFC 4918，已在 README 记录）：
 *   - 缺失       → 按 1 处理（规范要求按 infinity，那会在大目录上炸掉 CPU）
 *   - "0" / "1"  → 原样
 *   - "infinity" → 默认降级为 1；配置 DEPTH_INFINITY=deny 时返回 403
 */

import { PAGINATION_MAX, type Env, type Settings } from '../config';
import { davCache, entriesCacheKey } from '../lib/cache';
import {
  COLLECTIONS,
  bucketLabel,
  nodePath,
  resolveNode,
  type CollectionId,
  type DavNode,
} from '../lib/collections';
import { findBookByLeaf, getBucketTotal, listBooks, listBucketTotals, type BookRow } from '../lib/db';
import { httpDate, isoDate, multistatusResponse } from '../lib/http';
import { davError, davResponse, encodeHref, escapeXml, multistatus } from '../lib/xml';
import { allLiveLocks, matchLocksToPaths, lockDiscoveryXml } from '../lib/locks';
// ── 请求体解析 ──────────────────────────────────────────────────────────

type PropMode = 'allprop' | 'propname' | 'prop';

interface PropRequest {
  mode: PropMode;
  names: string[];
}

const TAG_RE = /<(?:[A-Za-z0-9_.-]+:)?([A-Za-z0-9_.-]+)\b[^>]*?(\/?)>/g;

export function parsePropfindBody(body: string | null): PropRequest {
  const text = (body ?? '').trim();
  if (text.length === 0) return { mode: 'allprop', names: [] };
  if (/<(?:[A-Za-z0-9_.-]+:)?propname\b/i.test(text)) return { mode: 'propname', names: [] };
  if (/<(?:[A-Za-z0-9_.-]+:)?allprop\b/i.test(text)) return { mode: 'allprop', names: [] };

  const block = text.match(
    /<(?:[A-Za-z0-9_.-]+:)?prop\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?prop>/i,
  );
  if (!block) return { mode: 'allprop', names: [] };

  const names: string[] = [];
  for (const tag of block[1]!.matchAll(TAG_RE)) {
    const name = tag[1]!;
    if (name === 'prop') continue;
    names.push(name);
  }
  if (names.length === 0) return { mode: 'allprop', names: [] };
  return { mode: 'prop', names: [...new Set(names)].sort() };
}

export function resolveDepth(
  header: string | null,
  cfg: Settings,
): { depth: 0 | 1 } | { rejected: true } {
  const raw = (header ?? '').trim().toLowerCase();
  if (raw === '0') return { depth: 0 };
  if (raw === '1') return { depth: 1 };
  if (raw === 'infinity') {
    return cfg.depthInfinity === 'deny' ? { rejected: true } : { depth: 1 };
  }
  return { depth: 1 };
}

// ── 属性渲染 ────────────────────────────────────────────────────────────

// RFC 4918 标准属性
const RFC_PROPS = [
  'resourcetype', 'getcontentlength', 'getcontenttype', 'getlastmodified',
  'getetag', 'displayname', 'creationdate', 'supportedlock', 'lockdiscovery',
  'getcontentlanguage',
] as const;

// MS-WebDAV 扩展（RFC 5582 之后的厂商扩展，Windows 系客户端强制要求）
const MS_PROPS = [
  'isdirectory', 'isreadonly', 'issymlink', 'iswriteable', 'issparsesupported',
  'maxuploadpacketsize', 'linkishint', 'qproptype', 'ms-fsstoragetype',
  'ms-author-via',
] as const;

const FILE_PROPS = [...RFC_PROPS, ...MS_PROPS];
const DIR_PROPS = [...RFC_PROPS, ...MS_PROPS];

interface ResourceMeta {
  displayName: string;
  lastModified?: string | null;
  created?: string | null;
  etag?: string | null;
  contentType?: string | null;
  contentLength?: number | null;
  language?: string | null;
  /** 活锁时注入的真实 lockdiscovery XML；无锁时 undefined */
  lockDiscoveryXml?: string;
}

// 最大单包上传大小（maxuploadpacketsize，MS 扩展）
const MAX_UPLOAD_PACKET_SIZE = 1024 * 1024; // 1 MiB

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function propNamesOnly(isCollection: boolean): string {
  const all = isCollection ? DIR_PROPS : FILE_PROPS;
  // MS 扩展里 linkishint/qproptype 是 vendor-specific，propname 里不列出
  return all
    .filter((n) => n !== 'linkishint' && n !== 'qproptype')
    .map((n) => `<D:${n}/>`)
    .join('');
}

function renderProps(
  isCollection: boolean,
  req: PropRequest,
  meta: ResourceMeta,
): { found: string; notFound: string[] } {
  if (req.mode === 'propname') return { found: propNamesOnly(isCollection), notFound: [] };

  const available: ReadonlySet<string> = new Set(isCollection ? DIR_PROPS : FILE_PROPS);
  const wanted = req.mode === 'prop' ? req.names : [...available];

  const found: string[] = [];
  const notFound: string[] = [];

  for (const name of wanted) {
    if (!available.has(name)) {
      notFound.push(name);
      continue;
    }
    switch (name) {
      case 'resourcetype':
        found.push(
          isCollection ? '<D:resourcetype><D:collection/></D:resourcetype>' : '<D:resourcetype/>',
        );
        break;
      case 'getcontentlength':
        found.push(`<D:getcontentlength>${meta.contentLength ?? 0}</D:getcontentlength>`);
        break;
      case 'getcontenttype':
        found.push(
          `<D:getcontenttype>${escapeXml(meta.contentType ?? 'application/octet-stream')}</D:getcontenttype>`,
        );
        break;
      case 'getlastmodified':
        found.push(`<D:getlastmodified>${httpDate(meta.lastModified)}</D:getlastmodified>`);
        break;
      case 'getetag':
        found.push(`<D:getetag>${escapeXml(meta.etag ?? `"auto-${hash(meta.displayName + String(meta.lastModified ?? ''))}"`)}</D:getetag>`);
        break;
      case 'displayname':
        found.push(`<D:displayname>${escapeXml(meta.displayName)}</D:displayname>`);
        break;
      case 'creationdate':
        found.push(`<D:creationdate>${isoDate(meta.created ?? meta.lastModified)}</D:creationdate>`);
        break;
      case 'getcontentlanguage':
        found.push(
          meta.language
            ? `<D:getcontentlanguage>${escapeXml(meta.language)}</D:getcontentlanguage>`
            : '<D:getcontentlanguage/>',
        );
        break;
      // 现在实现了完整 Class 2 锁：supportedlock 宣告 exclusive/write，
      // 让客户端知道我们对锁是真的支持的（而不是「不支持请忽略」）。
      case 'supportedlock':
        found.push(
          '<D:supportedlock>' +
            '<D:supportedlockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:supportedlockentry>' +
            '<D:supportedlockentry><D:lockscope><D:shared/></D:lockscope><D:locktype><D:read/></D:locktype></D:supportedlockentry>' +
            '</D:supportedlock>',
        );
        break;
      case 'lockdiscovery':
        found.push(
          meta.lockDiscoveryXml
            ? meta.lockDiscoveryXml
            : '<D:lockdiscovery/>',
        );
        break;
      // ── MS-WebDAV 扩展（Windows 系客户端挂载时强制要求）──
      case 'isdirectory':
        found.push(`<D:isdirectory>${isCollection ? 1 : 0}</D:isdirectory>`);
        break;
      case 'isreadonly':
        found.push(`<D:isreadonly>0</D:isreadonly>`);
        break;
      case 'issymlink':
        found.push('<D:issymlink>0</D:issymlink>');
        break;
      case 'iswriteable':
        found.push('<D:iswriteable>1</D:iswriteable>');
        break;
      case 'issparsesupported':
        found.push('<D:issparsesupported>0</D:issparsesupported>');
        break;
      case 'maxuploadpacketsize':
        found.push(`<D:maxuploadpacketsize>${MAX_UPLOAD_PACKET_SIZE}</D:maxuploadpacketsize>`);
        break;
      case 'linkishint':
      case 'qproptype':
      case 'ms-fsstoragetype':
      case 'ms-author-via':
        found.push(`<D:${name}/>`);
        break;
      default:
        notFound.push(name);
    }
  }

  return { found: found.join(''), notFound };
}

// ── 条目收集 ────────────────────────────────────────────────────────────

export interface Entry {
  /** 未编码的 DAV 路径（不含 /dav 前缀） */
  path: string;
  isCollection: boolean;
  meta: ResourceMeta;
}

function bookEntry(collection: CollectionId, bucket: string, book: BookRow): Entry {
  const def = COLLECTIONS[collection];
  return {
    path: def.bucketed
      ? `/${collection}/${bucket}/${book.leaf_name}`
      : `/${collection}/${book.leaf_name}`,
    isCollection: false,
    meta: {
      // 解析过 EPUB 时用真实书名/作者，否则退回文件名
      displayName: book.title || book.leaf_name,
      lastModified: book.updated_at,
      created: book.created_at,
      etag: `"${book.etag ?? book.id}"`,
      contentType: book.content_type,
      contentLength: book.size,
      language: book.language,
    },
  };
}

/**
 * 返回 null 表示 404。
 * collectionEtag 用于给目录一个「内容变了就会变」的 ETag，避免客户端永远不刷新。
 */
export async function collectDavEntries(
  node: DavNode,
  depth: 0 | 1,
  env: Env,
  cfg: Settings,
): Promise<Entry[] | null> {
  const now = new Date().toISOString();

  switch (node.kind) {
    case 'root': {
      const entries: Entry[] = [
        { path: '/', isCollection: true, meta: { displayName: 'webooks' } },
      ];
      if (depth === 0) return entries;
      for (const def of Object.values(COLLECTIONS)) {
        entries.push({
          path: `/${def.id}/`,
          isCollection: true,
          meta: { displayName: def.label },
        });
      }
      return entries;
    }

    case 'nav': {
      const label = COLLECTIONS[node.collection].label;
      const entries: Entry[] = [
        { path: `/${node.collection}/`, isCollection: true, meta: { displayName: label } },
      ];
      if (depth === 0) return entries;
      const buckets = await listBucketTotals(env.DB, node.collection);
      for (const b of buckets) {
        entries.push({
          path: `/${node.collection}/${b.bucket}/`,
          isCollection: true,
          meta: { displayName: bucketLabel(b.bucket) },
        });
      }
      return entries;
    }

    case 'list': {
      const total = await getBucketTotal(env.DB, node.collection, node.bucket);
      const offset = (node.page - 1) * cfg.maxEntries;
      // 页码越界 → 404。但第 1 页即使是空集合也返回 207：
      // 「集合存在但没有内容」比 404 更符合 WebDAV 语义，也避免 PUT 新建后
      // 客户端 PROPFIND 父目录拿到 404 而误判上传失败。
      if (node.page > 1 && offset >= total) return null;

      const selfPath = nodePath(node);
      const entries: Entry[] = [
        { path: selfPath, isCollection: true, meta: { displayName: selfPath } },
      ];
      if (depth === 0) return entries;

      const books = await listBooks(env.DB, node.collection, node.bucket, offset, cfg.maxEntries);
      for (const book of books) entries.push(bookEntry(node.collection, node.bucket, book));

      // 分页子目录只在第 1 页列出：/title/A/2/ 是 /title/A/ 的子节点，
      // 它自己的子节点只有书 —— 否则第 2 页会列出一个指向自己的「第 2 页」。
      if (node.page === 1) {
        const pageCount = Math.min(Math.ceil(total / cfg.maxEntries), PAGINATION_MAX + 1);
        const def = COLLECTIONS[node.collection];
        for (let p = 2; p <= pageCount; p++) {
          entries.push({
            path: def.bucketed ? `/${node.collection}/${node.bucket}/${p}/` : `/${node.collection}/${p}/`,
            isCollection: true,
            meta: { displayName: `第 ${p} 页` },
          });
        }
      }
      return entries;
    }

    case 'leaf': {
      const book = await findBookByLeaf(env.DB, node.leafName);
      if (!book) return null;
      // 叶子按 leaf_name 全局唯一查找，因此对路径宽容：
      // 即使客户端 PUT 到的桶与书的实际分桶不一致，也能取到文件。
      return [bookEntry(node.collection, node.bucket, book)];
    }

    default:
      return null;
  }
}

/** 目录 ETag：由子项数量与最新 mtime 决定，内容变化时必然变化。 */
function collectionEtag(entries: Entry[]): string {
  let newest = '';
  for (const e of entries) {
    const t = e.meta.lastModified ?? '';
    if (t > newest) newest = t;
  }
  return `"d-${entries.length}-${hash(newest + entries.map((e) => e.path).join('|'))}"`;
}

/**
 * 给没有 mtime 的合成目录（root / nav / 分页目录）填一个稳定值，
 * 否则每次请求都会生成不同的 getlastmodified 和 ETag，客户端缓存直接失效。
 */
function stabiliseEntryTimes(entries: Entry[]): string {
  let newest = '';
  for (const e of entries) {
    const t = e.meta.lastModified ?? '';
    if (t > newest) newest = t;
  }
  const fallback = newest || '1970-01-01T00:00:00.000Z';
  for (const e of entries) {
    if (!e.meta.lastModified) e.meta.lastModified = fallback;
    if (!e.meta.created) e.meta.created = fallback;
  }
  return fallback;
}

// ── 主入口 ──────────────────────────────────────────────────────────────

export async function handlePropfind(
  request: Request,
  env: Env,
  cfg: Settings,
  davPath: string,
): Promise<Response> {
  const depthResult = resolveDepth(request.headers.get('depth'), cfg);
  if ('rejected' in depthResult) {
    return new Response(davError('propfind-finite-depth'), {
      status: 403,
      headers: { 'content-type': 'application/xml; charset=utf-8' },
    });
  }
  const { depth } = depthResult;

  const bodyText = await request.text().catch(() => '');
  const propReq = parsePropfindBody(bodyText);

  const cache = cfg.propfindTtl > 0 ? davCache() : null;
  const cacheKeyUrl = entriesCacheKey(davPath, depth);

  let entries: Entry[] | null = null;
  let cacheState: 'HIT' | 'MISS' | 'OFF' = cache ? 'MISS' : 'OFF';

  if (cache) {
    const hit = await cache.match(cacheKeyUrl);
    if (hit) {
      entries = (await hit.json()) as Entry[];
      cacheState = 'HIT';
    }
  }

  if (!entries) {
    // 条目来自 D1（索引查询），绝不调用 R2 list()，因此不消耗 Class A 额度。
    entries = await collectDavEntries(resolveNode(davPath), depth, env, cfg);
    if (!entries) {
      return new Response('Not Found\n', { status: 404, headers: { 'content-type': 'text/plain' } });
    }
    stabiliseEntryTimes(entries);
    if (cache) {
      try {
        await cache.put(
          cacheKeyUrl,
          new Response(JSON.stringify(entries), {
            headers: {
              'content-type': 'application/json',
              'cache-control': `public, max-age=${cfg.propfindTtl}`,
            },
          }),
        );
      } catch {
        // 缓存写入失败不影响正确性
      }
    }
  }

  // 活锁注入：把每个条目路径上的活锁渲染成真实 lockdiscovery XML，
  // 客户端（尤其 Windows 系）在 PROPFIND 时就能看到哪些资源被锁。
  // 锁是动态的（300s TTL），不能写进条目缓存；每次渲染时查一次全量活锁
  // （活锁数量远小于条目数，一把 D1 读最安全，避免 IN 参数超限）。
  //
  // 注意：锁的 resource 键是「相对 davPath」（不含 mount 前缀），与 handleLock
  // 存锁时用的 davPath 一致。所以这里用 entry.path（相对路径）匹配，不带 mount。
  {
    const allLocks = await allLiveLocks(env.DB);
    if (allLocks.size > 0) {
      const matched = matchLocksToPaths(allLocks, entries.map((e) => e.path));
      for (const e of entries) {
        const lock = matched.get(e.path);
        if (lock) {
          e.meta.lockDiscoveryXml = lockDiscoveryXml(lock, `${cfg.mountPath}${e.path}`);
        }
      }
    }
  }

  const dirEtag = collectionEtag(entries);
  const responses = entries.map((entry) => {
    const meta: ResourceMeta = entry.isCollection ? { ...entry.meta, etag: dirEtag } : entry.meta;
    const { found, notFound } = renderProps(entry.isCollection, propReq, meta);
    // href 必须带上挂载前缀：WebDAV 客户端按请求 URL 解析相对 href，
    // 少了 /dav 客户端会跑到站点根目录去。
    const href = encodeHref(`${cfg.mountPath}${entry.path}`, entry.isCollection);
    return davResponse(href, found, notFound);
  });

  const response = multistatusResponse(multistatus(responses), cfg.propfindTtl);
  response.headers.set('x-dav-entries', String(entries.length));
  response.headers.set('x-dav-cache', cacheState);
  return response;
}
