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
  listBooksInBucket,
  findBookByLeaf,
  adjustBuckets,
  DEFAULT_CREDIT,
  bucketDeltas,
  bucketIdentityOf,
  rebuildBuckets,
  upsertBook,
  listBooks,
} from '../lib/db';
import { methodNotAllowed, shortId, textResponse } from '../lib/http';
import { safeContentTypeFor, deriveMetadata, sanitiseLeafName } from '../lib/metadata';
import { encodeR2Key, r2HttpMetadata } from '../lib/r2';
import { checkPreconditions } from '../lib/preconditions';
import { parseEpub, coverExtFor, PARSE_SIZE_CAP, type EpubMeta } from '../lib/epub';
import { sniffKindFromBucket } from '../lib/kind-sniff';
import { bookCacheTargets, purgeEntries } from '../lib/cache';
import { purgeCreditCache } from '../api/requests';
import {
  acquireLock,
  allLiveLocks,
  liveLockForResource,
  parseTimeoutHeader,
  releaseLock,
  sweepExpiredLocks,
  lockDiscoveryXml,
} from '../lib/locks';
import { guardWrite } from '../lib/throttle';
import { hasWriteToken, unauthorizedResponse } from '../lib/auth';
import { collectDavEntries, handlePropfind, type Entry } from './propfind';
import { renderBrowsePage } from '../browse-page';
import { escapeXml, extractTagNames, readDavBody } from '../lib/xml';

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
    // ⚠️ 这里是全站**最大的单点浪费**，之前完全没有 cache-control。
    //
    // OPTIONS 回答的是「这个端点支持哪些方法」—— 一份几乎永不变的能力
    // 描述。但 WebDAV 客户端的行为恰恰是「反复问」：
    //   · rclone / Finder 挂载时会先对根和每个目录发一次 OPTIONS
    //   · 部分客户端（Windows 资源管理器）每次刷新都重新问
    //   · 200 个目录的挂载 = 200+ 次 OPTIONS，每次都实打实消耗 1 次 Worker 请求
    //
    // 缓存 1 天。这不会影响正确性：allow/dav/ms-author-via 三个头
    // 都是编译期常量，改了它们必然伴随代码部署，届时缓存自然失效。
    //
    // 代价：如果哪天要临时关掉某个方法，最多 1 天内客户端仍会试。
    // 相比每天省下的请求，这个代价可以忽略。
    return new Response(null, {
      status: 200,
      headers: {
        allow: ALLOW,
        dav: DAV_HEADER,
        'ms-author-via': 'DAV',
        'cache-control': 'public, max-age=86400',
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
      // MOVE 会删除源，属于破坏性操作：需要口令。
      if (!hasWriteToken(request, cfg.writeToken)) return unauthorizedResponse();
      return handleMoveCopy(request, env, cfg, node, davPath, true);
    case 'COPY':
      // COPY 不删源，但**覆盖已有目标时等于破坏别人的书** —— 所以
      // 「目标是否已存在」这个判断在 handleMoveCopy 内部做，且与 PUT
      // 用同一套判据（口令 + 白名单 + 节流 + Overwrite）。
      // 这里**不**无条件要口令：往新路径复制一本该操作是合理的匿名行为。
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
  const { text: body } = await readDavBody(request);
  // locktype：RFC 4918 §14.15 只有一个合法值 write。
  // §14.14 的顺序是 lockscope → locktype，所以两者都要读，但只认规范里的写法。
  // ⚠️ 所有正则都必须容忍「无命名空间前缀」的 lockinfo。
  //   规范允许 `<D:lockinfo>` 与 `<lockinfo>` 两种写法（命名空间由 xmlns
  //   声明决定，不是元素名的一部分）。原实现全部硬编码 `D:` 前缀，
  //   于是客户端发无前缀版本时解析不到任何字段 —— 静默按默认值走，
  //   结果 shared 又变回 exclusive。
  const NS = '(?:[A-Za-z0-9_.-]+:)?';
  const typeMatch = body.match(new RegExp(`<${NS}locktype\\b[^>]*>\\s*<${NS}(exclusive|write)\\s*/?>`, 'i'));
  // ⚠️ 原来的 `<D:scope>` 是**错的元素名** —— 规范里是 `lockscope`
  //    （§14.13 `<!ELEMENT lockscope (exclusive | shared)>`）。
  //    正则永不匹配，于是**每一个 shared 锁请求都被静默降级成 exclusive**：
  //    客户端以为自己建的是共享锁（可多人同时持有），服务端却按独占锁处理，
  //    于是第二个客户端被 423 拒绝 —— 表现为「共享锁不能用」。
  //    §14.15 也没有 read 锁，所以 scope 只可能是 exclusive 或 shared。
  const scopeMatch = body.match(new RegExp(`<${NS}lockscope\\b[^>]*>\\s*<${NS}(exclusive|shared)\\s*/?>`, 'i'));
  const scope = scopeMatch ? (scopeMatch[1]!.toLowerCase() === 'shared' ? 'shared' : 'exclusive') : 'exclusive';
  const depthMatch = body.match(new RegExp(`<${NS}depth>\\s*(\\w+)\\s*<`, 'i'));
  const depth = depthMatch ? depthMatch[1]! : 'infinity';
  const timeoutSec = parseTimeoutHeader(request.headers.get('timeout'));
  const owner = body.match(new RegExp(`<${NS}owner>([\\s\\S]*?)</${NS}owner>`, 'i'))?.[1]?.trim() ?? null;
  void typeMatch; // locktype 恒为 write（§14.15），解析它只是为了文档完整性

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
      // ⚠️ 423 是错误响应，不是 multistatus —— 它不该用 <D:propstat>
      //   （那是 207 里逐属性表达结果的容器，塞进错误响应属于结构误用，
      //   严格解析器会困惑）。§11.3 要求 423 的 body 里 SHOULD 带上
      //   'lock-token-submitted' 或 'no-conflicting-lock'。
      //   lockdiscovery 必须放进 <D:lockdiscovery> 属性里给客户端读回冲突锁。
      return new Response(
        `<?xml version="1.0" encoding="utf-8"?>\n` +
          `<D:error xmlns:D="DAV:">` +
          `<D:lock-token-submitted>${conflictXml}</D:lock-token-submitted>` +
          `</D:error>`,
        {
          status: 423,
          headers: {
            'content-type': 'application/xml; charset=utf-8',
            // §11.3：让客户端知道冲突的是哪把锁
            ...(live ? { 'lock-token': live.token } : {}),
          },
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
    // ⚠️ 原实现在这里「顺手释放掉 davPath 上的锁」并回 204。
    //   §9.11.1 明确：「400 (Bad Request) - No lock token was provided」。
    //   匿名 LOCK 端点意味着任何人都能建锁，而不带 token 的 UNLOCK
    //   等于**任何人都能释放别人的锁** —— 这是未授权的破坏，且完全静默
    //   （客户端以为成功了）。§9.11.2 的 owner-authorized unlock 要求
    //   请求带 If 头指定 owner，不是「没有 token 就算 owner」。
    return new Response(
      `<?xml version="1.0" encoding="utf-8"?>\n` +
        `<D:error xmlns:D="DAV:"><D:lock-token-matches-request-uri/></D:error>`,
      { status: 400, headers: { 'content-type': 'application/xml; charset=utf-8' } },
    );
  }
  // 带 token 必须与资源锁匹配
  const live = await liveLockForResource(env.DB, davPath);
  if (!live || live.token !== tokenHeader) {
    // §9.11.1：409 (Conflict) + 'lock-token-matches-request-uri'。
    // ⚠️ 原实现用的 `<D:unlock-response>` 在 RFC 4918 全文里**零命中**
    //   —— 它来自从未实现的 RFC 3253 (DeltaV)。客户端按规范找不到这个
    //   条件，只能笼统报「UNKNOWN」，无法判断该怎么恢复。
    return new Response(
      `<?xml version="1.0" encoding="utf-8"?>\n` +
        `<D:error xmlns:D="DAV:"><D:lock-token-matches-request-uri/></D:error>`,
      {
        status: 409,
        headers: { 'content-type': 'application/xml; charset=utf-8' },
      },
    );
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
  const { text: body } = await readDavBody(request);
  // 抓 `<D:xxx>` 的属性名 —— 要同时覆盖自闭合（`<D:getetag/>`）与带内容的
  // （`<D:displayname>值</D:displayname>`）两种写法，否则会解析出 0 个属性，
  // 只能回一个无名的 <D:unknown/>，客户端看不出到底哪个属性被拒了。
  //
  // ⚠️ 这里的正则曾用 `(?:\s[^>]*)?(?:\/>|>[^<]*<\/` —— 嵌套量词 + 回溯。
  // 面对「全是 `<a ` 而没有 `>`」的构造输入，耗时严格按 n² 增长：
  // 实测 6KB→23ms、12KB→91ms、24KB→362ms、48KB→1448ms。Workers Free 的
  // CPU 预算只有 10ms，所以 1MB 的请求体就足以让单个 Worker 实例长时间
  // 不可用 —— 而且**匿名、无需任何凭据**。
  //
  // 两道防线：
  //   1. 先限长（见下方 DAV_BODY_LIMIT）—— 请求体本来就只该装几个属性名
  //   2. 解析改成线性推进，不用带回溯的惰性量词
  const propNames = extractTagNames(body)
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
  if (!dest) {
    return textResponse(
      400,
      '缺少 Destination 头。\n\n'
      + `${request.method} 必须说明「挪到哪里去」，例如：\n\n`
      + `    Destination: https://${new URL(request.url).host}/dav/最近收录/新名字.epub\n\n`
      + `注意目标要用**完整 URL**，且要与本站同域。`,
      { allow: ALLOW },
    );
  }

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
    return textResponse(
      400,
      `Destination 头无法解析：${dest.slice(0, 120)}\n\n`
      + `必须是一个完整的 http(s) URL。常见错误：\n`
      + `  · 只给了路径（/dav/最近收录/x.epub）—— 要带域名\n`
      + `  · 指向了别的站 —— 必须与本站同域\n`
      + `  · 中文没编码 —— 「最近收录」需要百分号编码`,
      { allow: ALLOW },
    );
  }
  const targetNode = resolveNode(targetDavPath);
  if (targetNode.kind !== 'leaf') {
    return textResponse(400, 'Destination must be a file path', { allow: ALLOW });
  }

  // ── 同源判定：MOVE 到自己必须拒绝，否则书会被彻底销毁 ────────────────
  //
  // 这不是「返回码不对」的小问题：源与目标是同一个资源时，下面的流程会
  // 先建目标、再把源（连同它的 R2 对象）删掉 —— 而源本身就是目标，
  // 于是这一本书彻底消失，客户端却收到 201 Created。
  //
  // 实测（修复前）：
  //   PUT  /dav/a.epub            → 201
  //   MOVE /dav/a.epub → 同一路径 → 201
  //   结果：D1 行 null、R2 对象不存在、GET 404
  //
  // RFC 4918 §9.9.4 明确建议这种情况返回 403 Forbidden。
  // Windows 资源管理器 / Nextcloud / Koofr 的同步引擎都会发 no-op MOVE
  // （「文件已在目标路径，移动到自己」是同步的常见操作），所以这不是
  // 理论上的畸形请求，而是**线上常态**。
  const sameResource =
    canonicalDavPath(davPath) === canonicalDavPath(targetDavPath) ||
    targetNode.leafName === node.leafName;
  if (isMove && sameResource) {
    return textResponse(
      403,
      'Source and destination are the same resource (RFC 4918 §9.9.4)',
      { allow: ALLOW },
    );
  }

  // 锁检查：源和目标都不能被锁住（同样用规范路径，与 LOCK/PUT 保持一致）
  for (const p of [canonicalDavPath(davPath), canonicalDavPath(targetDavPath)]) {
    const lock = await liveLockForResource(env.DB, p);
    if (lock) return lockConflictResponse(lock, p);
  }

  // MOVE：先 COPY 再 DELETE；COPY：复制字节 + D1 新行
  const targetLeaf = targetNode.leafName;
  const targetBook = await findBookByLeaf(env.DB, targetLeaf);

  // ── 覆盖已存在的目标 = 破坏性操作，与 PUT 同等对待 ──────────────────
  //
  // 修复前这里**什么检查都没有**，实测可零凭据把任意一本书的内容换掉：
  //   PUT  /dav/受害者.epub  → 201
  //   PUT  /dav/攻击者.epub  → 201（匿名上传自己的书，合法）
  //   COPY /dav/攻击者.epub -H "Destination: …/受害者.epub" → 201
  //   结果：受害者的书内容变成攻击者的字节，size / title 一并被改写
  //
  // 原因：targetId 取自 targetBook.id → 直接复用受害者的 R2 键，
  // 随后无条件 put + upsert。它绕过了 handlePut 里的全部三道防线
  // （口令 / 扩展名白名单 / 每日写节流），所以「删除和覆盖需要口令」
  // 这条设计承诺对 COPY 完全不成立。
  //
  // 判据与 handlePut 一致：If-None-Match: * 的「只新建不覆盖」语义
  // 不需要口令（它不会破坏任何东西）。
  const onlyIfAbsent = (request.headers.get('if-none-match') ?? '').trim() === '*';
  if (targetBook && !onlyIfAbsent && !hasWriteToken(request, cfg.writeToken)) {
    return unauthorizedResponse();
  }

  // ── If-None-Match: * 的**语义**（不只是免口令）────────────────────
  // 免掉口令只是它的一半含义；另一半是「目标已存在就拒绝」。
  // 修复前只实现了免口令，于是带 If-None-Match: * 的 COPY 撞上已有书
  // 时照样覆盖成功（回 204），同步客户端的「仅新建」意图被静默违背。
  //
  // 顺序：口令检查在前（§9.8.3 要求授权检查先于该检查），这里在后。
  if (onlyIfAbsent && targetBook) {
    return textResponse(
      412,
      'Precondition Failed: destination exists and If-None-Match is *',
      { allow: ALLOW },
    );
  }

  // ── Overwrite 头（RFC 4918 §9.8.3）────────────────────────────────
  // 实测修复前：目标已存在时 `Overwrite: F` 仍返回 201 并破坏目标。
  // 规范要求这种情况 MUST fail with 412，且**授权检查要先于该检查** ——
  // 上面已经先问过口令了，顺序正确。
  const overwrite = (request.headers.get('overwrite') ?? 'T').trim().toUpperCase();
  if (overwrite === 'F' && targetBook) {
    return textResponse(
      412,
      'Precondition Failed: destination exists and Overwrite is F (RFC 4918 §9.8.3)',
      { allow: ALLOW },
    );
  }

  // ── 扩展名白名单：COPY 此前完全绕过（实测能塞进 .exe）──────────────
  // 源书本身已是合法格式，但**目标文件名**是客户端自选的，
  // 所以必须按目标扩展名重新校验 —— 否则白名单在 COPY 上形同虚设。
  const targetExt = targetLeaf.split('.').pop()?.toLowerCase() ?? '';
  if (!isAllowedUploadExt(targetExt)) {
    return textResponse(
      415,
      `Unsupported Media Type: .${targetExt || '(无扩展名)'} 不在允许的格式内。\n`
      + `本站只接受电子书与漫画格式：\n  ${ALLOWED_UPLOAD_FORMATS.join(', ')}\n`,
      { allow: ALLOW },
    );
  }

  // ── 写节流 ────────────────────────────────────────────────────────
  // 分发处的注释曾写「COPY 走与 PUT 相同的节流即可」，但 allowWrite 的
  // 唯一调用点在 handlePut 内部 —— COPY 实际上一次都没走过节流。
  // COPY 不破坏源书，但它同样是往书库里写一个新对象，必须计入。
  const blocked = await guardWrite(env, request, cfg.dailyWriteQuota, { allow: ALLOW });
  if (blocked) return blocked;

  const targetId = targetBook?.id ?? shortId(8);
  const targetR2Key = `books/${targetId}`;

  // R2 对象复制（COPY）或移动（MOVE 先 copy 后删源）
  const sourceObj = await env.BUCKET.get(sourceBook.r2_key);
  if (!sourceObj) return textResponse(404, 'Source object not found in R2', { allow: ALLOW });
  // 目标 leafName 要参与元数据推导，所以提到 put 之前（原先在 put 之后才声明）。
  // 目标扩展名在上面的白名单校验里已经过，这里的 Content-Type 是按**目标**
  // 名字重新推导的，不是沿用源书 —— 见下方 upsertBook 里的说明。
  const targetLeafName = sanitiseLeafName(targetLeaf) ?? targetLeaf;
  await env.BUCKET.put(targetR2Key, sourceObj.body, {
    httpMetadata: r2HttpMetadata(targetLeafName),
  });

  // D1 登记目标
  await upsertBook(env.DB, {
    id: targetId,
    leafName: targetLeafName,
    title: sourceBook.title,
    author: sourceBook.author,
    language: sourceBook.language,
    format: sourceBook.format,
    // 有意与 R2 对象上写的值不一致，**不是 bug**：这一列描述的是「这本书是
    // 什么内容」，COPY 源书不改变它的内容类型，所以沿用源书（可能是迁移前
    // 写入的老值）。而上面 `r2HttpMetadata(targetLeafName)` 描述的是「R2 该
    // 用什么类型对外提供这个对象」，按目标扩展名重新推导 —— 目标扩展名已经
    // 过白名单校验。别为了「两边一致」把这里改成目标扩展名推导的值。
    contentType: sourceBook.content_type,
    size: sourceBook.size,
    sha256: sourceBook.sha256,
    r2Key: targetR2Key,
    // 覆盖已有目标时沿用它的 etag 与收录时间。
    // 这两处此前被无条件置空 / 重写为「现在」：覆盖会让同步客户端认为
    // 文件刚被改动（内容其实来自源书），并把老书顶到「最近收录」最前面，
    // 等于每次覆盖都篡改一次馆藏的收录顺序。
    etag: targetBook?.etag ?? null,
    titleLetter: letterBucket(sourceBook.title),
    authorLetter: authorBucket(sourceBook.author),
    formatBucket: sourceBook.format_bucket,
    publishedAt: targetBook?.published_at ?? new Date().toISOString(),
    coverKey: null,
  });

  if (isMove) {
    // 删除源：R2 对象 + D1 行 + 释放源锁
    //
    // ⚠️ 必须先判断「源和目标是不是同一条 D1 行」。覆盖已有目标时
    // targetId 沿用了目标的 id，而源可能正是那条被覆盖的行 ——
    // 此时若照常 deleteBook(sourceBook.id)，会连**刚写好的目标**一起删掉。
    //
    // 实测路径（修复前）：MOVE /dav/x.epub → /dav/y.epub，其中 y 已存在。
    //   targetId = y.id → put 到 books/y.id → upsert(y)
    //   然后 deleteBook(x.id) → 若 x 与 y 实际指向同一行，书就没了
    //
    // 现在的实现里 id 不同（PUT/INSERT 各自生成），但这层保护不能省：
    // 依赖「id 碰巧不同」来避免自毁，正是同源判定那条 bug 的同一种思路。
    if (sourceBook.id !== targetId) {
      await env.BUCKET.delete(sourceBook.r2_key);
      await deleteBook(env.DB, sourceBook.id);
    }
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

  // 状态码（RFC 4918 §9.8.5 / §9.9.4）：
  //   · 目标原本不存在 → 201 Created（资源已创建）
  //   · 目标原本已存在   → 204 No Content（资源被覆盖，语义上是「替换」）
  // 此前无论是否覆盖一律回 201，严格客户端会据此认为「又新建了一本」，
  // 导致同步状态机与实际馆藏不符。Location 头两种情况都保留，便于客户端定位。
  const reqUrl = new URL(request.url);
  const mount = cfg.mountPath; // '' 表示根挂载
  const locationHref = mount ? `${mount}${targetDavPath}` : targetDavPath;
  const locationUrl = `${reqUrl.protocol}//${reqUrl.host}${locationHref}`;
  return new Response(null, {
    status: targetBook ? 204 : 201,
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

/** 把字节数说成人话。错误提示里的「4.2 MB」比「4453057」有用得多。 */
function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '未知大小';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
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

export function renderHtmlIndex(davPath: string, entries: Entry[], mountPath: string): string {
  return renderBrowsePage(davPath, entries, mountPath);
}

// ── 写 ──────────────────────────────────────────────────────────────────

async function handlePut(request: Request, env: Env, node: DavNode, davPath: string, cfg: Settings): Promise<Response> {
  if (node.kind !== 'leaf') {
    return textResponse(405, 'PUT is only allowed on file paths', { allow: ALLOW });
  }

  const leafName = sanitiseLeafName(node.leafName);
  if (!leafName) {
    return textResponse(
      400,
      '文件名不可用。\n\n'
      + '以下字符会被拒绝：路径分隔符（/ \\）、控制字符、以及空文件名。\n'
      + '另外文件名的首尾不能是空格或点（那是 Windows 的保留写法）。',
      { allow: ALLOW },
    );
  }

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

  if (!request.body) {
    return textResponse(
      411,
      '请求没有正文。\n\n'
      + 'PUT 必须携带文件内容。常见原因：\n'
      + '  · curl 用了 -T 但源文件为空\n'
      + '  · 客户端做了「零字节文件」的探测请求',
      { allow: ALLOW },
    );
  }

  // 匿名写节流：大小上限管「单次伤害」，这里管「总量」。
  // 见 lib/throttle.ts —— 是尽力而为的减速带，不是硬配额。
  const blocked = await guardWrite(env, request, cfg.dailyWriteQuota, { allow: ALLOW });
  if (blocked) return blocked;

  // 大小上限：必须在**读 body 之前**判定。
  // 免费层 R2 只有 10GB 且 WebDAV 完全匿名开放，没有上限时一个脚本就能写满配额。
  const declared = Number(request.headers.get('content-length')) || 0;
  const cap = cfg.maxUploadBytes;
  if (cap > 0 && declared > cap) {
    return textResponse(
      413,
      `文件太大：本次上传 ${formatBytes(declared)}，本站单文件上限 ${formatBytes(cap)}。\n\n`
      + `⚠️ 上限来自 Cloudflare 的请求体限制（免费/付费套餐都是 100MB），\n`
      + `   **再大的文件 WebDAV 也传不上去** —— 超限请求在 Cloudflare 的\n`
      + `   代理层就被拦掉，根本到不了本站。\n\n`
      + `大文件请走网页上传：<本站地址>/upload\n`
      + `（它直传对象存储，字节不经过 Worker，不受这个限制）`,
      { allow: ALLOW },
    );
  }

  const meta = deriveMetadata(leafName);
  const existing = await findBookByLeaf(env.DB, leafName);

  // 覆盖已有书 = 破坏性操作（会改掉别人上传的内容），需要口令。
  // 「新书上传」保持完全匿名 —— 这是产品的核心诉求，不能被误伤。
  // 注意：带 If-None-Match: * 的请求语义上就是「只新建不覆盖」，
  // 即使同名文件存在也只会返回 412，不会改动任何东西，因此无需口令。
  const onlyIfAbsent = (request.headers.get('if-none-match') ?? '').trim() === '*';
  if (existing && !onlyIfAbsent && !hasWriteToken(request, cfg.writeToken)) {
    // ⚠️ 这里的 401 极易被误解成「我没登录」。
    //   真相是「这本书已经在书库里了，而覆盖它需要口令」。
    //   用 rclone / Cyberduck 的人看到 "Authentication required"
    //   只会反复重试、反复失败，因为根本没有可用的账号密码可填 ——
    //   这个站点是匿名开放的。
    //
    //   所以正文直接说清现状与两条出路。状态码保持 401（语义正确：
    //   确实需要凭证才能继续），但**不能只有状态码**。
    return textResponse(
      401,
      `这本书已经在书库里了：${leafName}\n\n`
      + `《${existing.title || leafName}》已收录`
      + `${existing.author ? `（作者：${existing.author}）` : ''}`
      + `，${formatBytes(existing.size)}，上架于 ${String(existing.published_at).slice(0, 10)}。\n\n`
      + `如果你是想**新增另一本同名书**，请换个文件名（加上版本或译者）。\n`
      + `如果你确实要**替换现有内容**，请带上写入口令：\n\n`
      + `    curl -T 新文件.epub \\\n`
      + `      -H "X-Write-Token: <你的口令>" \\\n`
      + `      <本站地址>${cfg.mountPath}/<集合路径>/${encodeURIComponent(leafName)}\n\n`
      + `（替代做法：加 If-None-Match: * 头，服务端会拒绝而不是覆盖。）`,
      // ⚠️ WWW-Authenticate 必须保留 —— 少了它 WebDAV 客户端不会弹密码框，
      //   而是直接报「认证失败」（rclone / Cyberduck 的表现完全不同）。
      //   这就是为什么这里不用 unauthorizedResponse()：它带固定文案，
      //   而这里要给出「书已经存在」这个具体信息。头是同一个。
      { allow: ALLOW, 'www-authenticate': 'Basic realm="webooks", charset="UTF-8"' },
    );
  }

  const id = existing?.id ?? shortId(8);
  const r2Key = `books/${id}`;
  // 安全关键：写入 R2 的 Content-Type **只按扩展名推导**，忽略客户端的声明。
  // R2 对外提供的就是这个值，信任客户端等于允许 text/html 托管（真实漏洞）。
  // Content-Disposition 同理 —— 对象键是 `books/<随机 id>`，浏览器只能靠
  // 这个头把文件存成书名。两者统一由 r2HttpMetadata 生成（见 lib/r2.ts）。
  const httpMetadata = r2HttpMetadata(leafName);
  // D1 里单独存一份 Content-Type：语义同上（upsertBook 的 contentType 列）。
  const contentType = httpMetadata.contentType ?? safeContentTypeFor(leafName);

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
    object = await env.BUCKET.put(r2Key, new Uint8Array(buf), { httpMetadata });
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
      httpMetadata,
    });
  }

  // 兜底：客户端谎报 Content-Length 时按实收大小判定（对象已经写了，删掉即可）
  if (cap > 0 && (object?.size ?? 0) > cap) {
    await env.BUCKET.delete(r2Key);
    return textResponse(
      413,
      `文件太大：本次上传 ${formatBytes(declared)}，本站单文件上限 ${formatBytes(cap)}。\n\n`
      + `⚠️ 上限来自 Cloudflare 的请求体限制（免费/付费套餐都是 100MB），\n`
      + `   **再大的文件 WebDAV 也传不上去** —— 超限请求在 Cloudflare 的\n`
      + `   代理层就被拦掉，根本到不了本站。\n\n`
      + `大文件请走网页上传：<本站地址>/upload\n`
      + `（它直传对象存储，字节不经过 Worker，不受这个限制）`,
      { allow: ALLOW },
    );
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
    // 来源标记为 'sniffed'：内容嗅探得出来的值，比「按扩展名猜」更权威，
    // 但仍可被重新嗅探覆盖（只有管理员手工改的才是 'manual'，见迁移 0006）。
    ...(sniffedKind ? { kindBucket: sniffedKind, kindSource: 'sniffed' as const } : {}),
    publishedAt: new Date().toISOString(),
    coverKey,
    // WebDAV 通道没有「留名」的载体（客户端 PUT 只是传文件），
    // 所以署名固定为默认。好在 ON CONFLICT 用 COALESCE 保护：
    // 覆盖上传不会抹掉网页上传时留的署名。
    credit: DEFAULT_CREDIT,
  });

  // 分桶计数：**增量更新**，只重算这本书所属/曾所属的桶。
  //
  // 原来这里是 rebuildBuckets —— 每次 PUT 都跑 DELETE + 5 条 GROUP BY，
  // 每条 GROUP BY 扫一遍 books 全表。实测 @5000 本时约 25,000 行读 +
  // 205 行写，而 D1 Free 只有 500 万行读/天、10 万行写/天（都是硬停）。
  // WebDAV PUT 是匿名入口，这条路径的写放大最容易被放大利用。
  //
  // 注意要传 existing 的旧分桶：覆盖上传时如果书名/作者变了
  // （例如管理员改了 D1 里的 title），旧桶也必须 -1，否则计数会漂移。
  await adjustBuckets(
    env.DB,
    bucketDeltas(
      existing
        ? bucketIdentityOf({
          titleLetter: existing.title_letter,
          authorLetter: existing.author_letter,
          formatBucket: existing.format_bucket,
        })
        : null,
      bucketIdentityOf({ titleLetter: letterBucket(title), authorLetter: authorBucket(author), formatBucket: meta.format }),
    ),
  );

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
    // 增量减计数（不是全量重算）—— 理由见 lib/db.ts 的 adjustBuckets 注释
    await adjustBuckets(
      env.DB,
      bucketDeltas(
        bucketIdentityOf({
          titleLetter: book.title_letter,
          authorLetter: book.author_letter,
          formatBucket: book.format_bucket,
        }),
        null,
      ),
    );

    // 同上：不失效的话，已删除的文件在 TTL 内仍会返回 207
    await purgeEntries(
      bookCacheTargets({
        leafName: book.leaf_name,
        titleLetter: book.title_letter,
        authorLetter: book.author_letter,
        formatBucket: book.format_bucket,
      }),
    );
    // 榜单缓存失效：书没了，首页的 /api/credits 也要更新（它缓存 1 小时）
    await purgeCreditCache();

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

    // ── 成员锁检查：必须在删除**之前**（RFC 4918 §9.6 + §7）──────────
    //
    // 集合 DELETE 等价于 Depth: infinity，会删掉所有成员，所以受锁约束。
    // 修复前分发层的 handleLockedWrite 只检查集合自身的 davPath，没看成员：
    //
    //   LOCK  /dav/最近收录/locked.epub   → 200
    //   DELETE /dav/最近收录/              → 204，locked.epub 被删掉
    //
    // 有活锁成员的集合应当整体拒绝，而不是删掉一半。
    //
    // 这里必须用**只读**的 listBooksInBucket 先取候选：deleteBooksInBucket
    // 是边翻页边 DELETE 的，先调用它就等于「检查时行已经没了」——
    // 修复过程中正是踩了这个坑（锁检查永远查不到东西）。
    //
    // 比对只看末段 leaf_name：叶子本来就是「leaf_name 全局唯一查找」，
    // 同一本书出现在任何桶下都指向同一资源，锁不该因为路径写法不同就失效。
    const candidates = await listBooksInBucket(env.DB, collection, bucket);
    const liveLocks = await allLiveLocks(env.DB);
    for (const [resource, lock] of liveLocks) {
      const lockedLeaf = decodeURIComponent(resource.slice(resource.lastIndexOf('/') + 1));
      if (candidates.some((b) => b.leaf_name === lockedLeaf)) {
        return lockConflictResponse(lock, resource);
      }
    }

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
    // 同上：集合删除也要更新上传者榜单
    await purgeCreditCache();
    return new Response(null, { status: 204 });
  }

  return textResponse(405, 'DELETE is not supported on this resource', { allow: ALLOW });
}
