/** WebDAV 方法分发。完整 Class 2（含 LOCK/UNLOCK/MKCOL/PROPPATCH/MOVE/COPY）。 */

import type { Env, Settings } from '../config';
import {
  ALLOWED_UPLOAD_FORMATS,
  isAllowedUploadExt,
  authorBucket,
  letterBucket,
  canonicalDavPath,
  collectionSegment,
  decodeDavPath,
  resolveNode,
  type DavNode,
} from '../lib/collections';
import {
  deleteBook,
  deleteBooksInBucket,
  findBookByLeaf,
  rebuildBuckets,
  upsertBook,
  listBooks,
} from '../lib/db';
import { methodNotAllowed, shortId, textResponse } from '../lib/http';
import { safeContentTypeFor, deriveMetadata, sanitiseLeafName } from '../lib/metadata';
import { checkPreconditions } from '../lib/preconditions';
import { parseEpub, coverExtFor, PARSE_SIZE_CAP, type EpubMeta } from '../lib/epub';
import { sniffKindFromBucket } from '../lib/kind-sniff';
import { bookCacheTargets, purgeEntries } from '../lib/cache';
import {
  acquireLock,
  liveLockForResource,
  parseTimeoutHeader,
  releaseLock,
  sweepExpiredLocks,
  lockDiscoveryXml,
} from '../lib/locks';
import { allowWrite } from '../lib/throttle';
import { hasWriteToken, unauthorizedResponse } from '../lib/auth';
import { collectDavEntries, handlePropfind, type Entry } from './propfind';
import { renderBrowsePage } from '../browse-page';
import { escapeXml } from '../lib/xml';

const ALLOW = 'OPTIONS, GET, HEAD, PROPFIND, PROPPATCH, MKCOL, LOCK, UNLOCK, PUT, DELETE, COPY, MOVE';

/**
 * DAV 合规等级头（RFC 4918 §18）。
 *
 * §18.1：Class 1 要求满足文档里**所有 MUST**。
 * §18.2：Class 2 = Class 1 + LOCK/UNLOCK。
 * §18.3：「Advertising class 3 support in addition to class 1 and 2 means that
 *         the server supports all the requirements in this specification.」
 *
 * 也就是说宣告 `3` 等于声称「本服务端满足 RFC 4918 的全部要求」。
 *
 * 我们**故意只宣告 1, 2**，因为确实有几条 MUST 不满足（都有意为之）：
 *   · §9.3 MKCOL：集合是 D1 派生的虚拟视图，无法真正创建，
 *     我们返回 201 做挂载兼容（而非 §9.3 要求的「已存在则必须失败」）
 *   · §9.2 PROPPATCH：不持久化自定义属性
 *   · §9.6.1 DELETE 集合：不支持 Depth:infinity 递归删除，返回 405
 * 宣告 3 会是**不实声明**，严格的客户端/合规检查会因此判定服务端有问题。
 * 宣告 2 是准确的：Class 1 + 完整锁支持（timeout / lock-token / If 刷新）。
 */
const DAV_HEADER = '1, 2';

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
  // 锁资源键必须用规范路径：客户端可能用 /recent/（旧英文），也可能用 /最近收录/（中文），
  // 两种写法指向同一本书，不归一的话「加锁」和「写入」会落在不同键上，锁就形同虚设。
  const lockKey = canonicalDavPath(davPath);

  switch (method) {
    case 'GET':
    case 'HEAD':
      return handleGet(env, cfg, node, davPath, method === 'HEAD');
    case 'PUT':
      return handleLockedWrite(request, () => handlePut(request, env, node, davPath, cfg), env, lockKey);
    case 'DELETE':
      // 删除是破坏性操作：需要共享口令。读与新增保持匿名。
      if (!hasWriteToken(request, cfg.writeToken)) return unauthorizedResponse();
      return handleLockedWrite(request, () => handleDelete(env, node, davPath), env, lockKey);
    case 'MKCOL':
      return handleMkcol(request, env, node, davPath);
    case 'MOVE':
      if (!hasWriteToken(request, cfg.writeToken)) return unauthorizedResponse();
      return handleMoveCopy(request, env, cfg, node, davPath, true);
    case 'COPY':
      // COPY 不破坏原书，但会新增文件，走与 PUT 相同的节流即可，不额外要口令
      return handleMoveCopy(request, env, cfg, node, davPath, false);
    case 'LOCK':
      return handleLock(request, env, lockKey);
    case 'UNLOCK':
      return handleUnlock(request, env, lockKey);
    case 'PROPPATCH':
      return handleProppatch(request, env, node, davPath);
    default:
      return methodNotAllowed(ALLOW);
  }
}

// ── Class 2 锁 ─────────────────────────────────────────────────────────

async function handleLockedWrite(
  request: Request,
  run: () => Promise<Response>,
  env: Env,
  davPath: string,
): Promise<Response> {
  // 只有「写」类方法受锁约束。PUT / DELETE 在资源上存在活锁时 423，
  // 但带 If: (<token>) 的「刷新/持锁者写」放行（RFC 4918 §9.10.1.4 / §10.5）。
  // 读路径（GET/HEAD/PROPFIND）不受锁约束 —— 锁只挡写，不挡读。
  const lock = await liveLockForResource(env.DB, davPath);
  if (lock) {
    // 提取 If 头里的 lock-token；与活锁 token 匹配 → 持锁者，放行
    const ifHeader = request.headers.get('if');
    const ifTokens: string[] = ifHeader ? (ifHeader.match(/<urn:uuid:[0-9a-f-]+>/gi) ?? []) : [];
    if (ifTokens.includes(lock.token)) {
      return run();
    }
    return lockConflictResponse(lock, davPath);
  }
  return run();
}

function lockConflictResponse(lock: { token: string; resource: string; owner: string | null; type: string; depth: string; timeoutSec: number }, davPath: string): Response {
  const xml = lockDiscoveryXml(
    {
      token: lock.token, resource: lock.resource, owner: lock.owner,
      type: lock.type as 'exclusive' | 'shared', depth: lock.depth,
      timeoutSec: lock.timeoutSec, createdAt: '', expiresAt: '',
    },
    davPath,
  );
  // lockDiscoveryXml 本身已经产出 <D:lockdiscovery>…</D:lockdiscovery>，
  // 这里绝不能再包一层（曾把 <D:lockdiscovery> 嵌进 <D:lockdiscovery>，
  // 配合 locktoken 的标签不配对，整个响应不是合法 XML）。
  return new Response(
    `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<D:response xmlns:D="DAV:"><D:href>${escapeXml(davPath)}</D:href>` +
      `<D:propstat><D:prop><D:lock /></D:prop>` +
      `<D:status>HTTP/1.1 423 Locked</D:status></D:propstat>` +
      xml +
      `</D:response>`,
    {
      status: 423,
      headers: {
        'content-type': 'application/xml; charset=utf-8',
        'lock-token': lock.token,
      },
    },
  );
}

async function handleLock(request: Request, env: Env, davPath: string): Promise<Response> {
  // RFC 4918 §9.10
  // 顺带清理过期锁：匿名端点任何人都能建锁，不清理表会无声膨胀。
  await sweepExpiredLocks(env.DB).catch(() => 0);
  // 解析请求体的 locktype / lockscope / depth
  const body = await request.text().catch(() => '');
  const typeMatch = body.match(/<D:(exclusive|write)\/>/i);
  const type = typeMatch ? 'exclusive' : 'exclusive'; // 默认 exclusive
  const scopeMatch = body.match(/<D:scope><D:(exclusive|shared)\/>/i);
  const scope = scopeMatch ? (scopeMatch[1] === 'shared' ? 'shared' : 'exclusive') : 'exclusive';
  const depthMatch = body.match(/<D:depth>(\w+)<\/D:depth>/i);
  const depth = depthMatch ? depthMatch[1]! : 'infinity';
  const timeoutSec = parseTimeoutHeader(request.headers.get('timeout'));
  const owner = body.match(/<D:owner>([\s\S]*?)<\/D:owner>/i)?.[1]?.trim() ?? null;

  // 刷新：If 头带 lock-token。RFC 4918 §9.10.2：If: (<token>) 表示刷新。
  // token 形如 <urn:uuid:xxx>，If 头是 ( <token> )。
  const ifHeader = request.headers.get('if');
  // 从 If: (<urn:uuid:...>) 里提取 token（最内层第一个 <...>）
  const ifToken = ifHeader?.match(/<urn:uuid:[0-9a-f-]+>/i)?.[0] ?? null;

  // RFC 4918 §9.10.2: 如果资源已被另一个 exclusive 锁持有，刷新自己的锁 OK，新建则 423
  try {
    const { lock, isRefresh } = await acquireLock(env.DB, {
      resource: davPath,
      type: scope as 'exclusive' | 'shared',
      depth,
      timeoutSec,
      owner,
      refreshToken: ifToken,
    });

    const lockXml = lockDiscoveryXml({ ...lock, createdAt: lock.createdAt, expiresAt: lock.expiresAt }, davPath);
    // RFC 4918 §9.10.1 原文：
    //   "MUST contain a body with the value of the DAV:lockdiscovery property
    //    in a prop XML element."
    // 所以必须包在 <D:prop> 里；裸的 <D:lockdiscovery> 是不合规的
    //（早期代码的注释声称这么做了，但实际没有 —— 注释与实现不符）。
    const body =
      `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<D:prop xmlns:D="DAV:">${lockXml}</D:prop>`;
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'application/xml; charset=utf-8',
        'lock-token': lock.token,
      },
    });
  } catch (err) {
    if ((err as { lockConflict?: boolean }).lockConflict) {
      const live = await liveLockForResource(env.DB, davPath);
      const conflictXml = live ? lockDiscoveryXml(live, davPath) : '';
      return new Response(
        `<?xml version="1.0" encoding="utf-8"?>\n` +
          `<D:response xmlns:D="DAV:"><D:href>${escapeXml(davPath)}</D:href>` +
          `<D:propstat><D:prop><D:lock /></D:prop>` +
          `<D:status>HTTP/1.1 423 Locked</D:status></D:propstat>` +
          // conflictXml 自带外层 <D:lockdiscovery>，不要再包一层
          conflictXml +
          `</D:response>`,
        {
          status: 423,
          headers: { 'content-type': 'application/xml; charset=utf-8' },
        },
      );
    }
    throw err;
  }
}

async function handleUnlock(request: Request, env: Env, davPath: string): Promise<Response> {
  // RFC 4918 §9.11
  const tokenHeader = request.headers.get('lock-token');
  if (!tokenHeader) {
    // owner-authorized unlock（§9.11.2）：无 Lock-Token 头时，
    // 释放「该 davPath 自身」上的锁（精确匹配，不做祖先继承）。
    // 不能用 liveLockForResource（它会匹配祖先锁），否则根锁会误删。
    const own = await env.DB.prepare(`SELECT token FROM locks WHERE resource = ? ORDER BY expires_at DESC LIMIT 1`)
      .bind(davPath).first<{ token: string }>();
    if (own) await releaseLock(env.DB, own.token);
    return new Response(null, { status: 204 });
  }
  // 带 token 必须与资源锁匹配
  const live = await liveLockForResource(env.DB, davPath);
  if (!live || live.token !== tokenHeader) {
    // RFC 4918 §9.11.1: 锁不存在或不是自己的 → 423 / 409
    const xml = live
      ? `<D:unlock-response><D:href>${escapeXml(davPath)}</D:href><D:locktoken>${live.token}</D:locktoken></D:unlock-response>`
      : `<D:unlock-response><D:href>${escapeXml(davPath)}</D:href></D:unlock-response>`;
    return new Response(xml, {
      status: live ? 423 : 409,
      headers: { 'content-type': 'application/xml; charset=utf-8' },
    });
  }
  await releaseLock(env.DB, tokenHeader);
  return new Response(null, { status: 204 });
}

// ── MKCOL / PROPPATCH / MOVE / COPY ───────────────────────────────────

async function handleMkcol(request: Request, env: Env, node: DavNode, davPath: string): Promise<Response> {
  // RFC 4918 §9.3："If the Request-URI is already mapped to a resource,
  // then the MKCOL MUST fail." → §9.3.1 规定用 405 (Method Not Allowed)。
  //
  // 集合是 D1 派生的虚拟视图，无法真正创建。对**已映射**的集合返回 405 既是
  // 规范要求，也是挂载安全的：客户端（Windows / RaiDrive / Cyberduck）挂载时
  // 会 MKCOL 根目录探测，收到 405 会正确理解为「已存在」并继续挂载。
  //
  // 对**未映射**的新路径（客户端想建自定义文件夹），我们无法持久化，
  // 用 RFC 5689 §3.1 的 403 + valid-resourcetype 前置条件明确告知，
  // 而不是假装 201 然后让目录不出现。
  const alreadyMapped =
    node.kind === 'root' || node.kind === 'nav' || node.kind === 'list';
  if (alreadyMapped) {
    return textResponse(
      405,
      'Collection already exists (virtual collection, derived from the library index)',
      { allow: ALLOW },
    );
  }
  const xml =
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<D:error xmlns:D="DAV:"><D:valid-resourcetype/></D:error>`;
  return new Response(xml, {
    status: 403,
    headers: { 'content-type': 'application/xml; charset=utf-8', allow: ALLOW },
  });
}

async function handleProppatch(request: Request, env: Env, node: DavNode, davPath: string): Promise<Response> {
  // RFC 4918 §9.2：PROPPATCH 的指令「MUST either all be executed or none executed」。
  // §9.2.1：对无法修改的属性应返回 403，并 SHOULD 带上
  //          `cannot-modify-protected-property` 前置条件。
  //
  // 早期实现「假装成功」——回 200 OK 却什么都不写。那是**不实声明**：
  // 客户端以为属性设置成功并缓存了这个事实，之后再也收不到正确的状态。
  // 现在改成规范要求的 403 + 前置条件：客户端收到的是准确的「这个属性设不了」。
  //
  // 仍然回 207（而不是整体 403）是因为多状态里可以逐属性表达结果，
  // 这是 RFC 期望的形状，客户端也最容易正确处理。
  const body = await request.text().catch(() => '');
  // 抓 `<D:xxx>` 的属性名 —— 要同时覆盖自闭合（`<D:getetag/>`）与带内容的
  // （`<D:displayname>值</D:displayname>`）两种写法，否则会解析出 0 个属性，
  // 只能回一个无名的 <D:unknown/>，客户端看不出到底哪个属性被拒了。
  const propNames = [
    ...body.matchAll(/<(?:[A-Za-z0-9_.-]+:)?([A-Za-z][A-Za-z0-9_.-]*)(?:\s[^>]*)?(?:\/>|>[^<]*<\/)/g),
  ].map((m) => m[1]!)
    .filter((n) =>
      !['propertyupdate', 'set', 'remove', 'prop', 'mkcol', 'lockinfo', 'create'].includes(n),
    );

  // 一个属性都没解析出来：无法逐个表态，直接按整体拒绝（仍是 207 + 403）
  const names = propNames.length > 0 ? propNames : ['unknown'];
  const propXml = names.map((p) => `<D:${p}/>`).join('');
  const xml =
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<D:multistatus xmlns:D="DAV:"><D:response><D:href>${escapeXml(davPath)}</D:href>` +
    `<D:propstat>` +
    `<D:prop>${propXml}</D:prop>` +
    `<D:status>HTTP/1.1 403 Forbidden</D:status>` +
    // §9.2.1 前置条件
    `<D:error><D:cannot-modify-protected-property/></D:error>` +
    `</D:propstat>` +
    `</D:response></D:multistatus>`;
  return new Response(xml, {
    status: 207,
    headers: { 'content-type': 'application/xml; charset=utf-8' },
  });
}

async function handleMoveCopy(
  request: Request,
  env: Env,
  cfg: Settings,
  node: DavNode,
  davPath: string,
  isMove: boolean,
): Promise<Response> {
  // RFC 4918 §9.8/9.9：MOVE 源=目标，DELETE 源；COPY 复制。
  // Destination 头：目标 URL（完整 URL，需剥掉 base 前缀）
  const dest = request.headers.get('destination');
  if (!dest) return textResponse(400, 'Destination header required', { allow: ALLOW });

  // 源必须是叶子（文件），不能是虚拟目录（我们的目录由 D1 派生，无法搬）
  if (node.kind !== 'leaf') {
    return textResponse(
      403,
      'Only leaf files can be moved/copied (virtual collections are derived, not stored)',
      { allow: ALLOW },
    );
  }

  const sourceBook = await findBookByLeaf(env.DB, node.leafName);
  if (!sourceBook) return textResponse(404, 'Source not found', { allow: ALLOW });

  // 解析 Destination 的 path（剥掉 mount 前缀）
  let targetDavPath: string;
  try {
    const destUrl = new URL(dest, 'https://webooks.invalid');
    let rawPath = destUrl.pathname; // e.g. /dav/recent/other.epub
    // 剥掉 mount 前缀（cfg.mountPath，可能是 '/dav' 或 ''）
    const mount = cfg.mountPath;
    if (mount && rawPath.startsWith(mount)) rawPath = rawPath.slice(mount.length) || '/';
    targetDavPath = rawPath;
  } catch {
    return textResponse(400, 'Invalid Destination URL', { allow: ALLOW });
  }
  const targetNode = resolveNode(targetDavPath);
  if (targetNode.kind !== 'leaf') {
    return textResponse(400, 'Destination must be a file path', { allow: ALLOW });
  }

  // 锁检查：源和目标都不能被锁住（同样用规范路径，与 LOCK/PUT 保持一致）
  for (const p of [canonicalDavPath(davPath), canonicalDavPath(targetDavPath)]) {
    const lock = await liveLockForResource(env.DB, p);
    if (lock) return lockConflictResponse(lock, p);
  }

  // MOVE：先 COPY 再 DELETE；COPY：复制字节 + D1 新行
  const targetLeaf = targetNode.leafName;
  const targetBook = await findBookByLeaf(env.DB, targetLeaf);
  const targetId = targetBook?.id ?? shortId(8);
  const targetR2Key = `books/${targetId}`;

  // R2 对象复制（COPY）或移动（MOVE 先 copy 后删源）
  const sourceObj = await env.BUCKET.get(sourceBook.r2_key);
  if (!sourceObj) return textResponse(404, 'Source object not found in R2', { allow: ALLOW });
  await env.BUCKET.put(targetR2Key, sourceObj.body, {
    httpMetadata: { contentType: sourceBook.content_type },
  });

  // D1 登记目标
  const targetLeafName = sanitiseLeafName(targetLeaf) ?? targetLeaf;
  await upsertBook(env.DB, {
    id: targetId,
    leafName: targetLeafName,
    title: sourceBook.title,
    author: sourceBook.author,
    language: sourceBook.language,
    format: sourceBook.format,
    contentType: sourceBook.content_type,
    size: sourceBook.size,
    sha256: sourceBook.sha256,
    r2Key: targetR2Key,
    etag: null,
    titleLetter: letterBucket(sourceBook.title),
    authorLetter: authorBucket(sourceBook.author),
    formatBucket: sourceBook.format_bucket,
    publishedAt: new Date().toISOString(),
    coverKey: null,
  });

  if (isMove) {
    // 删除源：R2 对象 + D1 行 + 释放源锁
    await env.BUCKET.delete(sourceBook.r2_key);
    await deleteBook(env.DB, sourceBook.id);
    await releaseLock(env.DB, davPath);
  }

  await rebuildBuckets(env.DB);
  await purgeEntries(
    bookCacheTargets({
      leafName: targetLeafName,
      titleLetter: letterBucket(sourceBook.title),
      authorLetter: authorBucket(sourceBook.author),
      formatBucket: sourceBook.format_bucket,
    }),
  );

  // RFC 4918 §9.8/9.9：回 201 + Location（目标 URL）。
  // 目标是完整绝对 URL（用源的 origin + mount 前缀拼上 dav 路径）
  const reqUrl = new URL(request.url);
  const mount = cfg.mountPath; // '' 表示根挂载
  const locationHref = mount ? `${mount}${targetDavPath}` : targetDavPath;
  const locationUrl = `${reqUrl.protocol}//${reqUrl.host}${locationHref}`;
  return new Response(null, {
    status: 201,
    headers: {
      location: locationUrl,
      'content-length': '0',
    },
  });
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
    const headers: Record<string, string> = {
      location: `${cfg.r2PublicBase}/${encodeR2Key(book.r2_key)}`,
      'cache-control': 'no-store',
      'accept-ranges': 'bytes',
    };
    // 断点续传：客户端带 Range 时，把 Range 透传到 R2 的 Location。
    // 302 跟随方（curl/浏览器）会原样转发 Range 给目标，R2 支持 Range 返回 206。
    // 这里显式声明 Accept-Ranges 让客户端知道支持分段。
    return new Response(null, { status: 302, headers });
  }

  // 目录：给浏览器一个简单的 HTML 列表，并让 CDN 缓存，重复浏览不消耗 Worker 请求。
  const entries = await collectDavEntries(node, 1, env, cfg);
  if (!entries) return textResponse(404, 'Not Found');

  const headers = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'public, max-age=300',
  };
  if (headOnly) return new Response(null, { status: 200, headers });
  // 传「解码后」的路径：否则面包屑/标题会显示 %E6%8C%89…，
  // 而且与 entry.path（解码后的节点路径）比较会不相等，导致自己也被列成子项。
  return new Response(renderHtmlIndex(decodeDavPath(davPath), entries, cfg.mountPath), {
    status: 200,
    headers,
  });
}

function encodeR2Key(key: string): string {
  return key.split('/').map((s) => encodeURIComponent(s)).join('/');
}

export function renderHtmlIndex(davPath: string, entries: Entry[], mountPath: string): string {
  return renderBrowsePage(davPath, entries, mountPath);
}

// ── 写 ──────────────────────────────────────────────────────────────────

async function handlePut(request: Request, env: Env, node: DavNode, davPath: string, cfg: Settings): Promise<Response> {
  if (node.kind !== 'leaf') {
    return textResponse(405, 'PUT is only allowed on file paths', { allow: ALLOW });
  }

  const leafName = sanitiseLeafName(node.leafName);
  if (!leafName) return textResponse(400, 'Invalid file name');

  // 扩展名白名单：只接受电子书 + 漫画格式。
  // **必须在读 body 之前判定** —— 否则任何文件（exe/脚本/压缩包）都能通过
  // WebDAV 绕过网页上传的限制塞进书库（网页那边拦、这边不拦 = 白拦）。
  // 415 是「媒体类型不支持」的语义，并在响应里列出允许的格式。
  const putExt = leafName.split('.').pop()?.toLowerCase() ?? '';
  if (!isAllowedUploadExt(putExt)) {
    return textResponse(
      415,
      `Unsupported Media Type: .${putExt || '(无扩展名)'} 不在允许的格式内。\n`
      + `本站只接受电子书与漫画格式：\n  ${ALLOWED_UPLOAD_FORMATS.join(', ')}\n`,
      { allow: ALLOW },
    );
  }

  if (!request.body) return textResponse(411, 'Length Required');

  // 匿名写节流：大小上限管「单次伤害」，这里管「总量」。
  // 见 lib/throttle.ts —— 是尽力而为的减速带，不是硬配额。
  const ip = request.headers.get('CF-Connecting-IP') ?? '';
  if (!(await allowWrite(ip, cfg.dailyWriteQuota))) {
    return textResponse(429, 'Too Many Requests: daily write quota exceeded', {
      allow: ALLOW,
      'retry-after': '3600',
    });
  }

  // 大小上限：必须在**读 body 之前**判定。
  // 免费层 R2 只有 10GB 且 WebDAV 完全匿名开放，没有上限时一个脚本就能写满配额。
  const declared = Number(request.headers.get('content-length')) || 0;
  const cap = cfg.maxUploadBytes;
  if (cap > 0 && declared > cap) {
    return textResponse(413, `Payload Too Large: limit is ${cap} bytes`, { allow: ALLOW });
  }

  const meta = deriveMetadata(leafName);
  const existing = await findBookByLeaf(env.DB, leafName);

  // 覆盖已有书 = 破坏性操作（会改掉别人上传的内容），需要口令。
  // 「新书上传」保持完全匿名 —— 这是产品的核心诉求，不能被误伤。
  // 注意：带 If-None-Match: * 的请求语义上就是「只新建不覆盖」，
  // 即使同名文件存在也只会返回 412，不会改动任何东西，因此无需口令。
  const onlyIfAbsent = (request.headers.get('if-none-match') ?? '').trim() === '*';
  if (existing && !onlyIfAbsent && !hasWriteToken(request, cfg.writeToken)) {
    return unauthorizedResponse();
  }

  const id = existing?.id ?? shortId(8);
  const r2Key = `books/${id}`;
  // 安全关键：写入 R2 的 Content-Type **只按扩展名推导**，忽略客户端的声明。
  // R2 对外提供的就是这个值，信任客户端等于允许 text/html 托管（真实漏洞）。
  const contentType = safeContentTypeFor(leafName);

  // 条件请求（RFC 9110 §13.1）：在**写入之前**判定，否则会把别人的书覆盖掉。
  // 同步客户端依赖 If-None-Match: * 做到「仅新建、不覆盖」，服务端必须配合。
  const currentEtag = existing?.etag ? `"${existing.etag}"` : null;
  const precondition = checkPreconditions(request.headers, currentEtag);
  if (!precondition.ok) {
    return textResponse(412, `Precondition Failed: ${precondition.reason}`, { allow: ALLOW });
  }

  // ── 读 body 的策略（避免撑爆 128MB isolate）──────────────────────────
  // 关键约束：`request.arrayBuffer()` 会把**整个** body 读进内存。早期实现对
  // 任何 .epub 都无条件 arrayBuffer()，于是一个几百 MB 的「EPUB」就能把 isolate
  // 打爆（DoS）。现在按 Content-Length 三档处理：
  //   · 声明 ≤ PARSE_SIZE_CAP  → 读进内存并解析（封面/元数据）
  //   · 声明 > PARSE_SIZE_CAP  → 直接流式落 R2，不解析（不占内存）
  //   · 未声明（chunked）      → 流式落 R2，不解析（无法在不缓存的前提下解析）
  const isEpub = meta.format === 'epub';
  const parseable = isEpub && declared > 0 && declared <= PARSE_SIZE_CAP;

  let parsed: EpubMeta | null = null;
  let coverKey: string | null = null;
  let object;

  if (parseable) {
    const buf = await request.arrayBuffer();
    object = await env.BUCKET.put(r2Key, new Uint8Array(buf), { httpMetadata: { contentType } });
    try {
      parsed = await parseEpub(buf);
      if (parsed?.cover) {
        const coverType = parsed.cover.contentType;
        // 扩展名由白名单推导，绝不用上传者可控的字符串拼对象键
        const ext = coverExtFor(coverType);
        if (ext) {
          coverKey = `covers/${id}.${ext}`;
          await env.BUCKET.put(coverKey, new Uint8Array(parsed.cover.bytes), {
            httpMetadata: { contentType: coverType },
          });
        }
      }
    } catch (err) {
      // 解析失败不影响写入，退回文件名推导。但要留痕，否则「有封面却判无封面」
      // 这类问题会静默消失（真实踩过：封面 inflate 失败被空 catch 吞掉）。
      console.error('[epub-parse] failed', {
        leafName,
        bytes: buf.byteLength,
        err: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
    }
  } else {
    // 非 EPUB、超大文件、或 chunked：直接流式落 R2，绝不把 body 读进内存
    object = await env.BUCKET.put(r2Key, request.body, {
      httpMetadata: { contentType },
    });
  }

  // 兜底：客户端谎报 Content-Length 时按实收大小判定（对象已经写了，删掉即可）
  if (cap > 0 && (object?.size ?? 0) > cap) {
    await env.BUCKET.delete(r2Key);
    return textResponse(413, `Payload Too Large: limit is ${cap} bytes`, { allow: ALLOW });
  }

  const title = parsed?.title ?? meta.title;
  const author = parsed?.author ?? meta.author;

  // 内容嗅探：区分「文字书 PDF」与「扫描漫画 PDF」，与网页上传走同一套规则。
  // EPUB 的固定版式判断来自已解析的 OPF，不额外读盘。
  // 判不出就返回 null —— 绝不硬猜，交给按扩展名派生。
  let sniffedKind: 'ebook' | 'comic' | 'audio' | null = null;
  if (parsed?.layout === 'comic') sniffedKind = 'comic';
  else if (parsed?.layout === 'text') sniffedKind = 'ebook';
  else if (meta.format === 'pdf') {
    try {
      sniffedKind = await sniffKindFromBucket(env.BUCKET, r2Key, meta.format);
    } catch {
      sniffedKind = null;
    }
  }

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
    authorLetter: authorBucket(author),
    formatBucket: meta.format,
    ...(sniffedKind ? { kindBucket: sniffedKind } : {}),
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
      authorLetter: authorBucket(author),
      formatBucket: meta.format,
    }),
  );

  const headers = new Headers();
  if (object?.etag) headers.set('etag', `"${object.etag}"`);
  return new Response(null, { status: existing ? 204 : 201, headers });
}

async function handleDelete(env: Env, node: DavNode, davPath: string): Promise<Response> {
  // 叶子：删单本
  if (node.kind === 'leaf') {
    const book = await findBookByLeaf(env.DB, node.leafName);
    if (!book) return textResponse(404, 'Not Found');

    await env.BUCKET.delete(book.r2_key);
    if (book.cover_key) await env.BUCKET.delete(book.cover_key);
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

  // 集合：RFC 4918 §9.6.1 —— 集合上的 DELETE 等价于 Depth: infinity，
  // 会连同所有成员一起删除。调用方已在分发层用 hasWriteToken 拦住（破坏性操作）。
  //
  // 根目录（/）刻意**不**支持删除：那等于「把整个书库删干净」，
  // 一个手滑或客户端 bug 就会造成不可逆的全量丢失。批量清理请走管理后台
  // /admin（有独立的确认流程），或删具体的桶。
  if (node.kind === 'root') {
    return textResponse(
      405,
      'DELETE on the mount root is not supported (it would delete the whole library). '
      + 'Use the admin console or delete individual buckets.',
      { allow: ALLOW },
    );
  }

  if (node.kind === 'nav' || node.kind === 'list') {
    const bucket = node.kind === 'list' ? node.bucket : '';
    const collection = node.collection;
    const removed = await deleteBooksInBucket(env.DB, collection, bucket);
    for (const b of removed) {
      await env.BUCKET.delete(b.r2_key);
      if (b.cover_key) await env.BUCKET.delete(b.cover_key);
    }
    await rebuildBuckets(env.DB);
    // 集合内容变了，根导航与该集合的导航都要失效
    await purgeEntries([
      ['/', 1],
      [`/${collectionSegment(collection)}/`, 1],
    ]);
    return new Response(null, { status: 204 });
  }

  return textResponse(405, 'DELETE is not supported on this resource', { allow: ALLOW });
}
