/**
 * 入库管道：把「R2 上的一坨字节」变成「D1 里的一本书」。
 *
 * ── 为什么要有这个模块 ────────────────────────────────────────────────
 *
 * 这条逻辑（同名冲突 → 清洗文件名 → EPUB 解析取封面 → PDF/EPUB 嗅探 →
 * 补作者 → upsert → 增量分桶 → 两层缓存失效）此前**内联在
 * handleUploadComplete 里**，WebDAV PUT 另有一份，`reindex` 是第三份。
 * 结果是一组真实发生过、反复修过的 bug：
 *
 *   · 扩展名白名单只在 init 检查、complete 不检查 → 可绕过
 *   · `kind_bucket` 覆盖上传后被按扩展名重算 → 人工标注的漫画变回电子书
 *   · 缓存失效漏打榜单 → 传完 5 分钟内看不到新书
 *
 * 现在书源要从 1 条变成 4 条（URL 导入 / 公版种子库 / OPDS 同步 / 联邦源），
 * 再复制三份必然发散。所以先抽出唯一一条管道，把「字节从哪来」参数化。
 *
 * ── 调用方契约 ────────────────────────────────────────────────────────
 *
 *   1. **字节已经在 R2 上**（`stagingKey`）。本模块不负责下载 ——
 *      拉取属于调用方的事（URL 导入用 fetch，OPDS 用源站 feed），
 *      这样管道本身不碰网络，也不必关心重定向/鉴权/SSRF。
 *   2. **入参已过鉴权与节流**（guardWrite）。本模块不做限流：
 *      限流是「谁在写」的问题，管道只关心「写什么」。
 *   3. 本模块负责**失败时的暂存清理**（413/409/415 三条路径），
 *      调用方不要重复删 —— 但 `object-not-found` / `object-unreadable`
 *      不清（前者本来就没对象，后者是异常态，留着便于排查）。
 *
 * ── 失败语义 ──────────────────────────────────────────────────────────
 *
 * 返回结构化的 {@link IngestResult}，不直接构造 HTTP 响应；
 * 但 {@link ingestFailureResponse} 统一把失败翻成响应体 —— 四条入库路线
 * 必须给出**同一个错误体**，否则前端要按入口分别写错误处理。
 */

import type { Env } from '../config';
import {
  ALLOWED_UPLOAD_FORMATS,
  authorBucket,
  isAllowedUploadExt,
  letterBucket,
  normaliseFormat,
} from './collections';
import { deriveMetadata, guessAuthorFromText, safeContentTypeFor, sanitiseLeafName } from './metadata';
import { bookObjectKey, r2HttpMetadata } from './r2';
import { sniffKindFromBucket } from './kind-sniff';
import {
  adjustBuckets,
  bucketDeltas,
  bucketIdentityOf,
  findBookByLeaf,
  upsertBook,
} from './db';
import { PARSE_SIZE_CAP, coverExtFor, parseEpub } from './epub';
import { bookCacheTargets, purgeCreditCache, purgeEntries } from './cache';
import { jsonResponse, shortId } from './http';

/**
 * 单文件默认体积上限。
 *
 * 网页上传通道用预签名直传，字节不经过 Worker，因此不受 Cloudflare
 * 「请求体 ≤ 100 MB」的限制（那个限制只作用于 Worker 的入站请求），
 * 所以这里可以放 200 MiB。WebDAV PUT 的上限另由 config 的 100 MiB 控制。
 *
 * 定义从 api/upload.ts 搬到这里：URL 导入、OPDS 同步共用同一个数，
 * 分开写两份就会出现「网页能传 200MB、导入只认 100MB」这种说不清的差异。
 */
export const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;

/**
 * 书从哪来。写进 books.source_kind（迁移 0009）。
 *
 *   upload —— 网页上传 / WebDAV：只知道有人传了
 *   url    —— 从网址导入：原始 URL 记在 source_url
 *   opds   —— 从 OPDS 源同步：去重键 (source_id, source_entry)
 *   seed   —— 公版种子库：license_basis 必须是可自证的
 *   dav    —— 预留：WebDAV 通道若并入管道时使用
 */
export type IngestSourceKind = 'upload' | 'url' | 'opds' | 'seed' | 'dav';

/**
 * 授权依据（闭集）。
 *
 * ⚠️ 默认 `unknown`，且 **unknown 不该自动上架**（隔离区尚未实现，
 *   见 docs/source-ingest-design.md §3）。宁可让人看一眼，也不要把
 *   「说不清来源的书」当成正常书。
 */
export type LicenseBasis = 'public-domain' | 'authorized' | 'user-declared' | 'unknown';

/**
 * 授权依据的闭集（运行时可枚举）。
 *
 * 单独导出是因为它同时被两处用：写入侧的类型约束，以及导入端点的
 * 入参校验。分两处写列表，早晚会出现「类型允许、校验拒绝」这种自相矛盾。
 */
export const LICENSE_BASIS_VALUES: readonly LicenseBasis[] = [
  'public-domain',
  'authorized',
  'user-declared',
  'unknown',
];

export interface IngestInput {
  /** 字节所在的 R2 键（通常是 `uploads/<日期>/<随机>/<文件名>`） */
  stagingKey: string;
  /** 展示用文件名。缺省取 stagingKey 的 basename。 */
  filename?: string;
  /** 调用方声明的大小，仅用于错误体回显；真实大小以 R2 head 为准 */
  declaredSize?: number;
  /** 上传者留名（已由 sanitiseCredit 清洗） */
  credit: string;
  sourceKind: IngestSourceKind;
  /** 原始地址；本地上传为 null */
  sourceUrl?: string | null;
  /** 授权依据；缺省 unknown */
  licenseBasis?: LicenseBasis | null;
  /** 邀请码/管理员标识（不是账号体系） */
  ingestedBy?: string | null;
  /** 远程源 id 与源内条目 id（OPDS/联邦源去重用） */
  sourceId?: string | null;
  sourceEntry?: string | null;
}

/** 入库成功的产物：字段与 /api/upload/complete 的响应体一一对应 */
export interface IngestedBook {
  bookId: string;
  leafName: string;
  title: string;
  author: string | null;
  language: string | null;
  format: string;
  size: number;
  contentType: string;
  coverKey: string | null;
  credit: string;
}

export type IngestErrorCode =
  | 'object-not-found'
  | 'file-too-large'
  | 'already-exists'
  | 'unsupported-format'
  | 'object-unreadable';

export type IngestResult =
  | { ok: true; book: IngestedBook }
  | {
      ok: false;
      status: number;
      code: IngestErrorCode;
      detail?: Record<string, unknown>;
    };

/**
 * 入库主流程。
 *
 * 前置：`input.stagingKey` 上的对象已存在。返回 ok 时暂存对象已被搬走并删除，
 * 书已登记、分桶已增量更新、两层缓存已失效 —— 调用方只需构造成功响应。
 */
export async function ingestBook(env: Env, input: IngestInput): Promise<IngestResult> {
  const key = input.stagingKey;

  // ── 1. 对象存在性与真实大小 ───────────────────────────────────────
  // 前端/上游声明的 size 不可信：只用于错误体回显，判定一律用 head.size。
  const head = await env.BUCKET.head(key);
  if (!head) {
    return { ok: false, status: 404, code: 'object-not-found' };
  }

  const actualSize = head.size;
  const maxBytes = Number.parseInt(env.UPLOAD_MAX_BYTES ?? '', 10) || DEFAULT_MAX_BYTES;
  if (actualSize > maxBytes) {
    // 超标：立刻删除刚传上来的文件，别让 R2 里堆垃圾
    await env.BUCKET.delete(key);
    return {
      ok: false,
      status: 413,
      code: 'file-too-large',
      detail: { maxBytes, size: input.declaredSize ?? actualSize },
    };
  }

  // ── 2. 文件名清洗 ────────────────────────────────────────────────
  // 必须与 WebDAV PUT 完全一致（sanitiseLeafName）：早期只替换 / 和 \，
  // 于是控制字符、<>:"|?* 与超长名字都能进 D1。虽然后续渲染都有转义，
  // 但「入库前就该干净」是更可靠的防线。
  const safeName =
    sanitiseLeafName((input.filename || key.split('/').pop() || 'book').replace(/[\/\\]/g, '_')) ??
    `book-${shortId(6)}`;

  // ── 3. 同名书检测 ────────────────────────────────────────────────
  // 网页上传是匿名的：只要猜到文件名，谁都能把别人的书顶掉。
  // 策略是**默认拒绝并说清**，给出改名建议；要覆盖请走 WebDAV（带口令）。
  const clash = await findBookByLeaf(env.DB, safeName);
  if (clash) {
    await env.BUCKET.delete(key);
    return {
      ok: false,
      status: 409,
      code: 'already-exists',
      detail: {
        leafName: safeName,
        existing: {
          title: clash.title,
          author: clash.author,
          size: clash.size,
          publishedAt: clash.published_at,
        },
      },
    };
  }

  // ── 4. 扩展名白名单 ──────────────────────────────────────────────
  // 必须在这里再做一次：init 的检查挡不住「init 传 a.epub、complete 传 a.exe」
  // 这条绕过路径（真实漏洞）。白名单的唯一定义在 collections.ts。
  const ext = safeName.split('.').pop()?.toLowerCase() ?? '';
  if (!isAllowedUploadExt(ext)) {
    await env.BUCKET.delete(key);
    return {
      ok: false,
      status: 415,
      code: 'unsupported-format',
      detail: { ext, allowed: [...ALLOWED_UPLOAD_FORMATS] },
    };
  }

  // ── 5. 搬键：uploads/ → books/<id>/<书名> ─────────────────────────
  // 对象键带可读文件名（见 lib/r2.ts 的 bookObjectKey）：走 S3 协议的客户端
  // 只看键、不看 Content-Disposition，旧键会让它们拿到一堆无法识别的 id。
  //
  // ⚠️ id 必须**单独**算出来，不能从键反推：新键是两段（books/<id>/<书名>），
  //   slice 会把 id + 文件名一起切出来，于是每一行数据都是错的（真实踩过）。
  const meta = deriveMetadata(safeName);
  const format = normaliseFormat(safeName.split('.').pop());
  // 安全关键：落 R2 的 Content-Type 只按扩展名推导，绝不用上游声明的类型 ——
  // R2 对外提供的就是它，信任它等于允许 text/html 托管。
  // Content-Disposition 一并由 r2HttpMetadata 生成：这是唯一能写下载名的时机。
  const httpMetadata = r2HttpMetadata(safeName);
  const contentType = httpMetadata.contentType ?? safeContentTypeFor(safeName);

  const source = await env.BUCKET.get(key);
  if (!source) {
    return { ok: false, status: 404, code: 'object-unreadable' };
  }

  const bookId = shortId(8);
  const bookKey = bookObjectKey(bookId, safeName);
  await env.BUCKET.put(bookKey, source.body, { httpMetadata });
  await env.BUCKET.delete(key);

  // ── 6. EPUB：用文件内部的权威元数据取代文件名的猜测 ───────────────
  let title = meta.title;
  let author = meta.author;
  let language: string | null = null;
  let coverKey: string | null = null;
  /** 内容嗅探出的形态；null = 判不出，交给 upsertBook 按扩展名派生 */
  let sniffedKind: 'ebook' | 'comic' | 'audio' | null = null;

  if (format === 'epub') {
    try {
      const fetched = await env.BUCKET.get(bookKey);
      const epubBuf = await fetched?.arrayBuffer();
      if (epubBuf && epubBuf.byteLength <= PARSE_SIZE_CAP) {
        const parsed = await parseEpub(epubBuf);
        if (parsed) {
          if (parsed.title) title = parsed.title;
          if (parsed.author) author = parsed.author;
          language = parsed.language;
          // 固定版式判断来自 OPF（已解析出来，不额外读盘）
          if (parsed.layout === 'comic') sniffedKind = 'comic';
          else if (parsed.layout === 'text') sniffedKind = 'ebook';
          if (parsed.cover) {
            const coverType = parsed.cover.contentType;
            // 扩展名由白名单推导（封面类型只可能来自字节嗅探，见 epub.ts）
            const ext = coverExtFor(coverType);
            if (ext) {
              coverKey = `covers/${bookId}.${ext}`;
              await env.BUCKET.put(coverKey, new Uint8Array(parsed.cover.bytes), {
                httpMetadata: { contentType: coverType },
              });
            }
          }
        }
      }
    } catch {
      // 解析失败不影响上架：退回文件名推导，封面留空
    }
  }

  // ── 7. 没有作者就再尽力找一次（TXT 常在开头写「作者：XXX」）────────
  if (!author && format === 'txt') {
    try {
      const obj = await env.BUCKET.get(bookKey, { range: { offset: 0, length: 16 * 1024 } });
      if (obj) {
        const sample = new TextDecoder('utf-8').decode(await obj.arrayBuffer());
        const found = guessAuthorFromText(sample);
        if (found) author = found;
      }
    } catch {
      // 读不到就算了，不影响上架
    }
  }

  // ── 8. PDF：区分「文字书 PDF」与「扫描漫画 PDF」──────────────────
  if (format === 'pdf') {
    try {
      sniffedKind = await sniffKindFromBucket(env.BUCKET, bookKey, format);
    } catch {
      sniffedKind = null;
    }
  }

  // ── 9. 登记 ─────────────────────────────────────────────────────
  // 内容嗅探优先于扩展名；判不出才交给 upsertBook 按扩展名派生。
  // 来源标记 'sniffed'：内容嗅探得出来的值比「按扩展名猜」更权威，
  // 但仍可被重新嗅探覆盖（只有管理员手工改的才是 'manual'，见迁移 0006）。
  await upsertBook(env.DB, {
    id: bookId,
    leafName: safeName,
    title,
    author,
    language,
    format,
    contentType,
    size: actualSize,
    sha256: null,
    r2Key: bookKey,
    etag: head.etag,
    titleLetter: letterBucket(title),
    authorLetter: authorBucket(author),
    formatBucket: format,
    ...(sniffedKind ? { kindBucket: sniffedKind, kindSource: 'sniffed' as const } : {}),
    publishedAt: new Date().toISOString(),
    coverKey,
    credit: input.credit,
    // 书源（迁移 0009）：不传就是 null/unknown，绝不猜
    sourceKind: input.sourceKind,
    sourceUrl: input.sourceUrl ?? null,
    licenseBasis: input.licenseBasis ?? 'unknown',
    ingestedBy: input.ingestedBy ?? null,
    sourceId: input.sourceId ?? null,
    sourceEntry: input.sourceEntry ?? null,
  });

  // ── 10. 增量更新分桶计数 ────────────────────────────────────────
  // 不是全量重算：rebuildBuckets 每次 5 条 GROUP BY 会扫全表，
  // 批量导入时 D1 行读额度会被自己吃光（见 lib/db.ts 的 adjustBuckets）。
  // 入库的一定是新书（books/<新 id>），所以 before = null。
  await adjustBuckets(
    env.DB,
    bucketDeltas(
      null,
      bucketIdentityOf({
        titleLetter: letterBucket(title),
        authorLetter: authorBucket(author),
        formatBucket: format,
      }),
    ),
  );

  // ── 11. 缓存失效（两层，必须都打）───────────────────────────────
  // 榜单缓存 1 小时：不打的话新书不进榜，首页活书脊看不到。
  await purgeCreditCache();

  // 条目缓存（PROPFIND/目录页，TTL 默认 300s）：bookCacheTargets 返回这本书
  // 出现的全部路径（5 条叶子 + 5 个列表），漏一条就有一个入口继续指旧列表。
  // 一次多花 ≤20 次 cache.delete，在 Cache API 的 50 次/请求上限内。
  await purgeEntries(
    bookCacheTargets({
      leafName: safeName,
      titleLetter: letterBucket(title),
      authorLetter: authorBucket(author),
      formatBucket: format,
    }),
  );

  return {
    ok: true,
    book: {
      bookId,
      leafName: safeName,
      title,
      author,
      language,
      format,
      size: actualSize,
      contentType,
      coverKey,
      credit: input.credit,
    },
  };
}

/**
 * 把入库失败翻成 HTTP 响应。**四条入库路线共用**，保证同一个错误
 * 在任何入口都是同一个响应体。
 *
 * 错误提示的原则：说清「能做什么」，而不是复述状态码。
 */
export function ingestFailureResponse(result: Extract<IngestResult, { ok: false }>): Response {
  switch (result.code) {
    case 'object-not-found':
      return jsonResponse({ error: 'object-not-found' }, 404);
    case 'object-unreadable':
      return jsonResponse({ error: 'object-unreadable' }, 404);
    case 'file-too-large':
      return jsonResponse(
        { error: 'file-too-large', maxBytes: result.detail?.maxBytes, size: result.detail?.size },
        413,
      );
    case 'unsupported-format':
      return jsonResponse(
        {
          error: 'unsupported-format',
          ext: result.detail?.ext,
          allowed: result.detail?.allowed,
        },
        415,
      );
    case 'already-exists': {
      const existing = (result.detail?.existing ?? {}) as {
        title?: string | null;
        author?: string | null;
        size?: number;
      };
      const leafName = (result.detail?.leafName as string | undefined) ?? '';
      return jsonResponse(
        {
          error: 'already-exists',
          message:
            `《${existing.title || leafName}》已经在书库里了`
            + `${existing.author ? `（作者：${existing.author}）` : ''}。`
            + `如果要收录另一本同名书，请改个文件名（加版本号、译者或副标题）。`,
          existing,
        },
        409,
      );
    }
  }
}
