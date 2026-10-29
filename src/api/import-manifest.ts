/**
 * 公版种子库的**登记**端点（期 2，管理员）。
 *
 * ── 它和 URL 导入的区别 ──────────────────────────────────────────────
 *
 * URL 导入负责「把字节弄进来」；这个端点只管**登记**：
 * 字节已经由本机脚本用 S3/rclone 直传到了 `books/<id>/<书名>`
 * （0 次 Worker 请求），这里把 D1 元数据补齐。
 *
 * 为什么不让 Worker 搬字节：800 本 × 1.5 MB 走 Worker 是 800 个请求 +
 * 800 次 R2 put，而 S3 直传是 0 请求、0 Worker 字节。免费额度要留给读者。
 *
 * ── 为什么必须校验 r2Key ──────────────────────────────────────────────
 *
 * 只接受形如 `books/<id>/<leafName>` 的键，且 id 与 leafName 必须和条目
 * 自洽。否则这个端点就成了「把桶里任意对象挂到任意书名下」的入口 ——
 * 包括 `uploads/` 里的暂存垃圾、别人的封面、甚至 `covers/` 下的图片。
 *
 * ── 每批为什么是 8 本 ─────────────────────────────────────────────────
 *
 * 每本要 4 个子请求：head 对象、查同名、upsert、adjustBuckets。
 * 8 × 4 = 32，加 1 次榜单缓存失效，安全落在 Workers Free 的 50/次以内。
 * 800 本 = 100 批，脚本侧循环即可（每批 1 次 Worker 请求）。
 *
 * ── 不做缓存条目失效 ──────────────────────────────────────────────────
 *
 * 一本书的条目缓存要打 20 个键（`bookCacheTargets`），8 本就是 160 次
 * Cache API 删除，超 50/次上限。种库是批量操作，目录列表最多 5 分钟
 * （PROPFIND_TTL）后自然刷新；收尾由 scripts/seed/register.mjs 打 5 个
 * 集合根路径的 purge。这是有意的取舍，不是漏了。
 */

import type { Env } from '../config';
import { isAllowedUploadExt, normaliseFormat } from '../lib/collections';
import { safeContentTypeFor, sanitiseLeafName } from '../lib/metadata';
import { bookObjectKey } from '../lib/r2';
import {
  adjustBuckets,
  bucketDeltas,
  bucketIdentityOf,
  findBookByLeaf,
  upsertBook,
} from '../lib/db';
import { navCacheTargets, purgeCreditCache, purgeEntries } from '../lib/cache';
import { LICENSE_BASIS_VALUES, type LicenseBasis } from '../lib/ingest';
import { jsonResponse, textResponse } from '../lib/http';
import { authorBucket, letterBucket } from '../lib/collections';

/** 每批上限：8 本 × 4 个子请求 = 32，见文件头注释。 */
const MAX_ENTRIES = 8;

/** 种子库的统一署名（会显示在书卡上） */
const SEED_CREDIT = '公版种子';

export interface ManifestEntry {
  id: string;
  leafName: string;
  r2Key: string;
  title: string;
  author?: string | null;
  language?: string | null;
  licenseBasis: string;
  sourceUrl?: string | null;
  sourceKind?: string;
}

interface Rejection {
  leafName: string;
  code: string;
  detail?: string;
}

interface Accepted {
  leafName: string;
  bookId: string;
}

export async function handleImportManifest(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return textResponse(405, 'Method Not Allowed', { allow: 'POST' });
  }

  let body: { entries?: unknown };
  try {
    body = (await request.json()) as { entries?: unknown };
  } catch {
    return jsonResponse({ error: 'bad-json' }, 400);
  }

  if (!Array.isArray(body.entries) || body.entries.length === 0) {
    return jsonResponse({ error: 'entries-required' }, 400);
  }
  if (body.entries.length > MAX_ENTRIES) {
    return jsonResponse(
      {
        error: 'too-many-entries',
        max: MAX_ENTRIES,
        hint: '每批最多 8 本：一本 4 个子请求，超了会撞 Workers Free 的 50/次上限。',
      },
      400,
    );
  }

  const registered: Accepted[] = [];
  const existing: string[] = [];
  const rejected: Rejection[] = [];

  for (const raw of body.entries) {
    const result = await registerOne(env, raw);
    if (result.ok === true) {
      if (result.existing) existing.push(result.leafName);
      else registered.push({ leafName: result.leafName, bookId: result.bookId });
    } else {
      rejected.push({ leafName: result.leafName, code: result.code, detail: result.detail });
    }
  }

  // 榜单缓存 1 小时：种库后不打的话首页活书脊看不到新书。
  // 只打 1 个键，远低于 Cache API 的 50/次上限。
  //
  // ⚠️ 2026-10-28 审查 G：原来只打榜单，**导航层与列表一个都没打** ——
  // 一条 manifest 里已经登记过的书，在 TTL 内目录里仍然看不到。
  // 这里补上有界的导航层失效（8 个键），批量路径不做逐本叶子失效
  //（理由见 navCacheTargets 的注释）。
  if (registered.length > 0) {
    await purgeEntries(navCacheTargets());
    await purgeCreditCache();
  }

  return jsonResponse({
    ok: true,
    registered,
    existing,
    rejected,
    total: registered.length + existing.length + rejected.length,
  });
}

type OneResult =
  | { ok: true; existing: boolean; leafName: string; bookId: string }
  | { ok: false; leafName: string; code: string; detail?: string };

/** 单本登记。任何校验失败都只影响这一本，不中断整批。 */
async function registerOne(env: Env, raw: unknown): Promise<OneResult> {
  const e = (raw ?? {}) as Partial<ManifestEntry>;
  const rawLeaf = typeof e.leafName === 'string' ? e.leafName : '';

  // ── 1. 档名、id、键三者必须自洽 ──────────────────────────────────
  const leafName = sanitiseLeafName(rawLeaf.replace(/[\/\\]/g, '_'));
  if (!leafName) {
    return { ok: false, leafName: rawLeaf, code: 'bad-leaf-name' };
  }

  const id = typeof e.id === 'string' ? e.id.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{16}$/.test(id)) {
    return { ok: false, leafName, code: 'bad-id', detail: 'id 必须是 16 位十六进制' };
  }

  const expectedKey = bookObjectKey(id, leafName);
  if (e.r2Key !== expectedKey) {
    return {
      ok: false,
      leafName,
      code: 'bad-r2-key',
      detail: `只接受 books/<id>/<书名>，且必须与 id/leafName 自洽（期望 ${expectedKey}）`,
    };
  }

  // ── 2. 格式与授权依据 ────────────────────────────────────────────
  const ext = leafName.split('.').pop()?.toLowerCase() ?? '';
  if (!isAllowedUploadExt(ext)) {
    return { ok: false, leafName, code: 'unsupported-format', detail: ext };
  }

  const basis = typeof e.licenseBasis === 'string' ? e.licenseBasis : '';
  if (!LICENSE_BASIS_VALUES.includes(basis as LicenseBasis) || basis === 'unknown') {
    return {
      ok: false,
      leafName,
      code: 'license-basis-required',
      detail: '公版/授权/自称三者之一；unknown 不接受',
    };
  }

  const title = typeof e.title === 'string' ? e.title.trim().slice(0, 500) : '';
  if (!title) {
    return { ok: false, leafName, code: 'title-required' };
  }

  const sourceKind = typeof e.sourceKind === 'string' ? e.sourceKind : 'seed';
  if (!['seed', 'url', 'opds'].includes(sourceKind)) {
    return { ok: false, leafName, code: 'bad-source-kind' };
  }

  const author = typeof e.author === 'string' && e.author.trim() ? e.author.trim().slice(0, 200) : null;
  const language = typeof e.language === 'string' && e.language.trim() ? e.language.trim().slice(0, 16) : 'zh';
  const sourceUrl = typeof e.sourceUrl === 'string' && e.sourceUrl.trim() ? e.sourceUrl.trim() : null;

  // ── 3. 对象真的在桶里（不然会登记一条指向空气的书）────────────────
  const head = await env.BUCKET.head(expectedKey);
  if (!head) {
    return { ok: false, leafName, code: 'object-not-found', detail: expectedKey };
  }

  // ── 4. 同名冲突：同 id 视为幂等重跑，不同 id 视为冲突 ──────────────
  const clash = await findBookByLeaf(env.DB, leafName);
  if (clash) {
    if (clash.id === id) {
      return { ok: true, existing: true, leafName, bookId: id };
    }
    return {
      ok: false,
      leafName,
      code: 'already-exists',
      detail: `已有另一本同名书（id=${clash.id}）`,
    };
  }

  // ── 5. 登记 ─────────────────────────────────────────────────────
  const format = normaliseFormat(ext);
  const contentType = safeContentTypeFor(leafName);
  await upsertBook(env.DB, {
    id,
    leafName,
    title,
    author,
    language,
    format,
    contentType,
    size: head.size,
    sha256: null,
    r2Key: expectedKey,
    etag: head.etag,
    titleLetter: letterBucket(title),
    authorLetter: authorBucket(author),
    formatBucket: format,
    // 种子库不做内容嗅探：公版古籍/小说都是文字书，按扩展名派生即可，
    // 来源标 derived（可被之后的 rebucket?sniff=1 纠正）。
    publishedAt: new Date().toISOString(),
    credit: SEED_CREDIT,
    sourceKind,
    sourceUrl,
    licenseBasis: basis,
    ingestedBy: 'seed',
    // 来源 id 是「哪个源站」，条目 id 用页面 URL（唯一、可回溯）。
    // 不要拿 sourceUrl 当 sourceId：那会让「同一个源站」在库里看起来像 800 个源。
    sourceId: 'zh.wikisource.org',
    sourceEntry: sourceUrl ?? id,
    // 直接上架。设计稿 §3 的 inbox 隔离对匿名上传是必须的；
    // 种子库每一条都经过「卒年 + 50 < 今年」的机械校验，不经过人审也站得住。
    status: 'published',
  });

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

  return { ok: true, existing: false, leafName, bookId: id };
}
