/**
 * 管理接口。全部需要 ADMIN_TOKEN；未配置 token 时整个路由返回 404，
 * 避免"忘记设置密钥"变成公开的写入口。
 */

import type { Env, Settings } from '../config';
import {
  COLLECTIONS,
  authorBucket, letterBucket,
  bucketSegment,
  collectionSegment,
  isAllowedUploadExt,
  mediaKindOfFormat,
} from '../lib/collections';
import {
  adjustBuckets,
  bucketDeltas,
  bucketIdentityOf,
  adminListBooks,
  adminTotals,
  deleteBook,
  findBooksByLeafNames,
  listBucketTotals,
  rebuildBuckets,
  upsertBookStatement,
} from '../lib/db';
import { sniffKindFromBucket } from '../lib/kind-sniff';
import { bookObjectKey, r2HttpMetadata } from '../lib/r2';
import { hasAdminToken } from '../lib/auth';
import { releaseLocksForLeafNames } from '../lib/locks';
import { handleAdminRequests, handleCreditBoard, handleCreditPurge } from './requests';
import { jsonResponse, textResponse } from '../lib/http';
import {
  deriveMetadata,
  extensionOf,
  guessAuthorFromText,
  leafNameFromKey,
  normaliseAuthor,
  safeContentTypeFor,
  sanitiseLeafName,
  sha256Hex,
} from '../lib/metadata';
import { bookCacheTargets, davCache, purgeEntries } from '../lib/cache';
import { purgeCreditCache } from './requests';
import { handleImportUrl } from './import-url';
import { handleImportManifest } from './import-manifest';

const BATCH_SIZE = 50;
const MAX_LIST_LIMIT = 1000;

/**
 * 回填动作每页最多处理几本。
 *
 * 上限卡得比 `MAX_LIST_LIMIT` 小得多，因为这一页里的每一本都要真读 + 真写一遍
 * 存储：Workers Free 的**子请求上限是 50/次**（D1 与 R2 调用都算），一本最坏是
 * `head` + `get` + `put` = 3 个，1（本页的 D1 查询）+ 3 × 16 = 49，刚好不越界。
 * 把 limit 调大不会「更快」，只会撞上子请求上限报错。
 *
 * 代价是书多了要翻页（5000 本 = 313 页）。这是免费套餐的硬约束，不是设计缺陷。
 */
const MAX_BACKFILL_LIMIT = 16;
const DEFAULT_BACKFILL_LIMIT = 10;

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
    case 'rebucket':
      return rebucket(env, url);
    case 'backfill-disposition':
      return backfillDisposition(env, url);
    case 'migrate-keys':
      return migrateKeys(env, url);
    case 'stats':
      return stats(env);
    case 'books':
      return listBooksAction(env, url);
    case 'delete':
      return deleteBooks(env, cfg, request);
    case 'update':
      return updateBook(env, request);
    case 'purge':
      return purge(env, cfg, url);
    case 'credits':
      return handleCreditBoard(request, env, url);
    case 'credits/purge':
      return handleCreditPurge(request);
    case 'import/manifest':
      // 公版种子库的**登记**批：字节已经由 S3 直传到 books/<id>/<书名>，
      // 这里只补 D1 元数据（每批 ≤8 本）。见 src/api/import-manifest.ts。
      return handleImportManifest(request, env);
    case 'import/url':
      // 从网址导入一本书。鉴权由 handleAdmin 统一做（ADMIN_TOKEN），
      // 这里只负责「拉取 → 入库」—— 字节不经过调用方，所以也不占额外请求。
      // 设计见 docs/source-ingest-design.md §5。
      return handleImportUrl(request, env);
    default:
      // `requests` 与 `requests/<id>` 都要走同一个处理器（列表 vs 标记状态），
      // 所以不能放在上面的精确匹配里 —— 标记状态需要 path 里带 id。
      if (action === 'requests' || action.startsWith('requests/')) {
        return handleAdminRequests(request, env, url);
      }
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
      // 内容嗅探出的类型（ebook/comic/audio），管理页用它渲染下拉框
      kind: b.kind_bucket,
      size: b.size,
      createdAt: b.created_at,
      hasCover: !!b.cover_key,
    })),
    security: securityStatus(env),
  });
}

/**
 * 手动修正一本书的作者与类型。
 *
 * 为什么必须有这个：作者猜测和「电子书/漫画」嗅探都是**启发式**，
 * 再准也会有判错的时候（PDF 漫画用对象流压缩、作者名是笔名、
 * 文件名格式古怪……）。没有人工兜底的话，用户看到错误分类就束手无策。
 * 这里改的是 D1 里的分类字段，不动 R2 内容。
 */
async function updateBook(env: Env, request: Request): Promise<Response> {
  let body: { leafName?: unknown; author?: unknown; kind?: unknown; title?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonResponse({ error: 'bad-json' }, 400);
  }
  const leafName = typeof body.leafName === 'string' ? body.leafName : '';
  if (!leafName) return jsonResponse({ error: 'leaf-name-required' }, 400);

  const row = await env.DB
    // title_letter / author_letter 要一并取出：改了书名或作者后需要知道
    // 旧桶是什么，才能算出该 -1 哪个桶（见 adjustBuckets 的 before 快照）
    .prepare(`SELECT id, title, author, format_bucket, title_letter, author_letter
                FROM books WHERE leaf_name = ?`)
    .bind(leafName)
    .first<{
      id: string;
      title: string;
      author: string | null;
      format_bucket: string;
      title_letter: string;
      author_letter: string;
    }>();
  if (!row) return jsonResponse({ error: 'not-found' }, 404);

  // 只更新明确传了的字段；空字符串表示「清空作者」
  const patch: string[] = [];
  const binds: unknown[] = [];

  if (typeof body.author === 'string') {
    const clean = normaliseAuthor(body.author);
    patch.push('author = ?', 'author_letter = ?');
    binds.push(clean, authorBucket(clean));
  }
  if (typeof body.title === 'string' && body.title.trim()) {
    patch.push('title = ?', 'title_letter = ?');
    binds.push(body.title.trim(), letterBucket(body.title.trim()));
  }
  if (typeof body.kind === 'string') {
    const kind = body.kind.trim();
    if (!['ebook', 'comic', 'audio'].includes(kind)) {
      return jsonResponse({ error: 'bad-kind', allowed: ['ebook', 'comic', 'audio'] }, 400);
    }
    patch.push('kind_bucket = ?');
    binds.push(kind);
    // ⚠️ 人工改过之后必须标记来源（迁移 0006），否则：
    //   · rebucket?sniff=1 会把它打回按扩展名猜的值
    //   · 覆盖上传同一个文件也会重置它
    // 这正是修复前实测到的静默数据丢失。
    patch.push('kind_source = ?');
    binds.push('manual');
  }
  if (patch.length === 0) return jsonResponse({ error: 'nothing-to-update' }, 400);

  patch.push('updated_at = ?');
  binds.push(new Date().toISOString(), row.id);
  await env.DB
    .prepare(`UPDATE books SET ${patch.join(', ')} WHERE id = ?`)
    .bind(...binds)
    .run();

  // 增量更新分桶：管理员改了 title/author/format 时，只有受影响的桶要动。
  // 走全量重算的话每次后台改一个字都要扫一遍 books 全表。
  await adjustBuckets(
    env.DB,
    bucketDeltas(
      bucketIdentityOf({
        titleLetter: row.title_letter,
        authorLetter: row.author_letter,
        formatBucket: row.format_bucket,
      }),
      {
        titleLetter: patch.includes('title_letter') ? (binds[patch.indexOf('title_letter')] as string) : row.title_letter,
        authorLetter: patch.includes('author_letter') ? (binds[patch.indexOf('author_letter')] as string) : row.author_letter,
        formatBucket: patch.includes('format_bucket') ? (binds[patch.indexOf('format_bucket')] as string) : row.format_bucket,
      },
    ),
  );
  // 分类变了，读者侧缓存要立刻失效，否则要等 TTL
  await purgeEntries([
    ['/', 1],
    ...Object.values(COLLECTIONS).map((d) => [`/${d.segment}/`, 1] as const),
  ]);

  return jsonResponse({ ok: true, leafName, updated: patch.length });
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
    // §9.6 MUST destroy：书没了，它在**所有别名路径**上的锁也必须销毁。
    // 管理后台按 leaf_name 删书，而一把锁的 resource 是某条具体路径
    // （`/最近收录/x.epub`、`/按书名/A/x.epub`…），只删一条路径会留下
    // 「资源已不存在、锁还在」的残行 —— TTL 内会挡住同名文件被重新上传。
    // 与 WebDAV 的 DELETE 用同一个 helper，判据（末段 leaf_name）也保持一致。
    await releaseLocksForLeafNames(env.DB, deleted);

    await rebuildBuckets(env.DB);
    // 让读者侧的目录缓存立刻失效，否则删掉的书在 TTL 内仍会显示。
    // 路径段必须与 nodePath() 一致（中文），否则缓存键对不上、失效没有效果。
    const titleCol = collectionSegment('title');
    const authorCol = collectionSegment('author');
    const formatCol = collectionSegment('format');
    const recentCol = collectionSegment('recent');
    const targets: Array<readonly [string, 0 | 1]> = [['/', 1]];
    for (const b of found) {
      targets.push(
        [`/${titleCol}/${bucketSegment(b.title_letter)}/`, 1],
        [`/${authorCol}/${bucketSegment(b.author_letter)}/`, 1],
        [`/${formatCol}/${bucketSegment(b.format_bucket)}/`, 1],
        [`/${recentCol}/`, 1],
      );
    }
    await purgeEntries(targets);
    // 榜单缓存失效（首页 /api/credits 缓存 1 小时）
    await purgeCreditCache();
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
  // 与 WebDAV 一致（DEFAULT_MAX_UPLOAD_BYTES = 100 MiB）：reindex 扫的是
  // 已经落进 R2 的对象，用 WebDAV 的标准判断才不会把「WebDAV 传不进来的
  // 大文件」当成正常数据静默跳过。
  const sizeCap = Number.parseInt(env.MAX_UPLOAD_BYTES ?? '', 10) || 100 * 1024 * 1024;

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
/**
 * 按当前分类规则重算所有书的桶，并重建 buckets 表。
 *
 * 什么时候需要它：**分类规则一旦变化，存量书不会自动跟上**。
 * 例如「中文按拼音首字母分桶」上线后，老书的 title_letter 还停在 'other'，
 * 按书名浏览时所有中文书仍然挤在一个桶里 —— 看起来像新功能没生效。
 * 加字段用迁移能解决，但「按新规则重算已有数据」必须由应用逻辑来做
 * （拼音表在 TS 里，SQL 算不出来）。
 *
 * 支持分页（?offset=&limit=），避免书量很大时一次扫描超 CPU 预算。
 *
 * **类型（kind_bucket）默认不动**：它现在来自内容嗅探或管理后台的人工修正，
 * 都比「按扩展名猜」更权威。按扩展名重算会把嗅探结果覆盖掉 ——
 * 例如扫描漫画 PDF 会被打回「电子书」（真实踩过）。
 * 想按内容重新嗅探存量书，显式加 `?sniff=1`（会读 R2，较慢）。
 */
async function rebucket(env: Env, url: URL): Promise<Response> {
  const limit = Math.min(
    Math.max(Number.parseInt(url.searchParams.get('limit') ?? '1000', 10) || 1000, 1),
    5000,
  );
  const offset = Math.max(Number.parseInt(url.searchParams.get('offset') ?? '0', 10) || 0, 0);
  const doSniff = url.searchParams.get('sniff') === '1';

  const { results } = await env.DB
    .prepare(
      `SELECT id, title, author, format_bucket, title_letter, author_letter,
              kind_bucket, kind_source, r2_key
         FROM books ORDER BY id LIMIT ? OFFSET ?`,
    )
    .bind(limit, offset)
    .all<{
      id: string;
      title: string;
      author: string | null;
      format_bucket: string;
      title_letter: string;
      author_letter: string;
      kind_bucket: string;
      /** 人工标注的书不得被 sniff 覆盖（迁移 0006） */
      kind_source: string;
      r2_key: string;
    }>();

  const rows = results ?? [];
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  let changed = 0;
  let resniffed = 0;
  let skippedManual = 0;
  const moved: Array<{ title: string; from: string; to: string }> = [];

  for (const r of rows) {
    const titleLetter = letterBucket(r.title);
    let author = r.author;
    let authorLetter = authorBucket(author);
    let kindBucket = r.kind_bucket;

    // ── 按内容重新提取（?sniff=1）──
    // 两件事：类型（PDF 扫描漫画 vs 文字书）、以及缺失的作者
    // （TXT 没有元数据，但很多中文小说开头就写着「作者：XXX」）。
    if (doSniff) {
      const sniffed = await sniffKindFromBucket(env.BUCKET, r.r2_key, r.format_bucket);

      // ⚠️ 人工标注不得被覆盖（迁移 0006 引入 kind_source）。
      //
      // 原实现无条件写 `kindBucket = sniffed ?? mediaKindOfFormat(...)`，
      // 而这个回退分支**丢弃了原值**。实测：
      //   人工把扫描漫画 PDF 标成 comic → rebucket?sniff=1 → 变回 ebook
      //
      // 为什么人工标注值得保护：内容嗅探在两种真实情况下必然失效 ——
      //   ① PDF 1.5+ 用对象流把字典压起来 → 标记看不到 → 判不出
      //   ② 带 OCR 层的扫描漫画引入字体资源 → 「零字体」判据直接崩
      // 这两类书只能靠人判断，而人判断恰恰是最脆弱的数据。
      //
      // README 早就写了「rebucket 默认不动 kind_bucket，比按扩展名猜更权威」，
      // 但 `?sniff=1` 一直在打破这个承诺，且没有任何警告。
      if (r.kind_source === 'manual') {
        // 保持原值，只统计以便管理员知道有多少本被跳过
        skippedManual++;
      } else {
        // EPUB 的固定版式判断需要解压 OPF，代价高，交给上传路径处理
        const next = sniffed ?? mediaKindOfFormat(r.format_bucket);
        if (next !== r.kind_bucket) {
          kindBucket = next;
          resniffed++;
        }
      }

      if (!author && r.format_bucket === 'txt') {
        try {
          const obj = await env.BUCKET.get(r.r2_key, { range: { offset: 0, length: 16 * 1024 } });
          if (obj) {
            const found = guessAuthorFromText(new TextDecoder('utf-8').decode(await obj.arrayBuffer()));
            if (found) {
              author = found;
              authorLetter = authorBucket(found);
              if (moved.length < 20) moved.push({ title: r.title, from: '（无作者）', to: found });
            }
          }
        } catch {
          // 读不到就算了，不影响其它书的处理
        }
      }
    }

    if (
      titleLetter === r.title_letter
      && authorLetter === r.author_letter
      && kindBucket === r.kind_bucket
      && author === r.author
    ) {
      continue; // 没变就不写，省 D1 写入额度
    }
    changed++;
    if (titleLetter !== r.title_letter && moved.length < 20) {
      moved.push({ title: r.title, from: r.title_letter, to: titleLetter });
    }
    statements.push(
      env.DB
        .prepare(
          `UPDATE books SET title_letter = ?, author_letter = ?, kind_bucket = ?, author = ?,
                            updated_at = ?
            WHERE id = ?`,
        )
        .bind(titleLetter, authorLetter, kindBucket, author, now, r.id),
    );
  }

  // D1 的 batch 一次别塞太多，分批执行
  for (let i = 0; i < statements.length; i += 100) {
    await env.DB.batch(statements.slice(i, i + 100));
  }
  await rebuildBuckets(env.DB);

  // 桶变了，读者侧缓存必须整体失效，否则要等 TTL 才看到新分类
  await purgeEntries([
    ['/', 1],
    ...Object.values(COLLECTIONS).map((d) => [`/${d.segment}/`, 1] as const),
  ]);

  return jsonResponse({
    scanned: rows.length,
    changed,
    resniffed,
    // 跳过了多少本人工标注的书。暴露出来而不是静默跳过 ——
    // 否则管理员会以为「跑了一次 sniff 就全都重新判定过了」，
    // 实际上有一部分书根本没被碰。
    skippedManual,
    sniffed: doSniff,
    offset,
    nextOffset: rows.length === limit ? offset + limit : null,
    movedExamples: moved,
    note: rows.length === limit
      ? '还有下一页，请带上 nextOffset 再调一次'
      : '已扫描完全部书，buckets 已重建、目录缓存已失效',
  });
}

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
  let rejectedByExt = 0;

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
    // 扩展名白名单：与 WebDAV PUT（src/webdav/index.ts）和网页上传共用同一个
    // 判定函数。reindex 是第三个入口，曾经漏掉这一关 —— R2 控制台或其它通道
    // 塞进来的 .exe / .m4a 跑一次 reindex 就直接入库上架。
    //
    // 单独计数而不是混进 skipped：运维要从响应里看出「少了的书是因为格式
    // 不允许」，否则只会看到「扫了 500 个只入库 480 本」而不知道另外 20 个
    // 去哪了。
    if (!isAllowedUploadExt(extensionOf(leafName))) {
      rejectedByExt++;
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
        authorLetter: authorBucket(meta.author),
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
    // 扩展名不在白名单里、被拒收的对象数。与 skipped 分开暴露：
    // 「前缀下的占位对象 / 非法文件名」和「格式不允许」是两件不同的事，
    // 混在一起运维就没法判断这次 reindex 为什么少了几本。
    rejectedByExt,
    truncated: listing.truncated,
    nextCursor: listing.truncated ? listing.cursor : null,
    bucketsRebuilt,
  });
}

/**
 * 给库里**已经存在**的书补上 `Content-Disposition`（书卡直链方案的收尾动作）。
 *
 * 为什么需要单独跑一次：R2 的 `httpMetadata` **只在写入时生效**，而且 R2 不支持
 * S3 的 `response-content-disposition` 之类 response-* 覆盖查询参数（实测无效）。
 * 所以那些在 `src/lib/r2.ts` 落地之前写进去的对象，直链下载下来会叫
 * `95e860d26bd874cf` 这种随机 id —— 没有扩展名，浏览器也不知道怎么打开。
 *
 * 做法：**按 D1 走，不按 R2 列表猜**。
 *   · 对象键是 `books/<随机 id>`，里面没有扩展名，光看键推不出书名；
 *     真正权威的书名是 D1 的 `leaf_name` 列。按 list 猜只会得到一堆
 *     `download` 兜底名（甚至更糟：把 id 当书名写进下载名）。
 *   · 顺带这也能覆盖「键不在 `books/` 前缀下」的老书（reindex 出过 `library/`）。
 *
 * 幂等、可反复跑：已经带对元数据的对象直接跳过（`skipped`），所以中断后
 * 重跑一次不会重复搬运。`?dryRun=1` 只统计不写，适合第一次上手动之前先看一眼。
 *
 * `bytesRewritten` 如实报告这次搬了多少字节：R2 没有「只改元数据」的 API，
 * 每修一本都要 `get` 真读一遍、`put` 真写一遍（流式，不占内存），所以读与写
 * 各是这么多字节。R2 的 Class A/B 操作与出网都不按字节计费，这里报出来是为了
 * 「操作有多大」这件事不靠猜。
 *
 * 不需要清任何缓存：对象键与 D1 行都没变，变的只是 R2 响应头，目录列表与书卡
 * href 完全不受影响。
 */
async function backfillDisposition(env: Env, url: URL): Promise<Response> {
  const after = url.searchParams.get('after') ?? '';
  const requested = Number.parseInt(
    url.searchParams.get('limit') ?? String(DEFAULT_BACKFILL_LIMIT),
    10,
  );
  const limit = Math.min(Math.max(requested || DEFAULT_BACKFILL_LIMIT, 1), MAX_BACKFILL_LIMIT);
  const dryRun = ['1', 'true', 'yes'].includes(
    (url.searchParams.get('dryRun') ?? '').toLowerCase(),
  );

  // 多查一行当作「还有没有下一页」的探针：只多取 1 行，不额外发 D1 查询，
  // 但能给**确定的**答案。不要用 `rows.length === limit` 去推断 —— 那只说明
  // 「这一页装满了」，装满了和「后面还有」是两件事：库里刚好剩最后一页时，
  // 页满会返回一个非 null 的 nextAfter，而按 nextAfter 分页的客户端（包括
  // `while (nextAfter) …` 这种写法）会白打一次请求才发现是空的。
  // 线上实测过这个假信号：16 本全库、limit=16 时 scanned=16 却仍返回 nextAfter。
  const { results } = await env.DB
    .prepare(
      `SELECT id, leaf_name, r2_key, size FROM books
        WHERE status = 'published' AND id > ?
        ORDER BY id LIMIT ?`,
    )
    .bind(after, limit + 1)
    .all<{ id: string; leaf_name: string; r2_key: string; size: number }>();
  const fetched = results ?? [];
  const hasMore = fetched.length > limit;
  // 探针那一行只用来判断有没有下一页，不参与回填，否则会多改一本。
  const rows = hasMore ? fetched.slice(0, limit) : fetched;

  let backfilled = 0;
  let skipped = 0;
  let missing = 0;
  let failed = 0;
  let bytesRewritten = 0;
  const failures: Array<{ id: string; leafName: string; error: string }> = [];

  for (const row of rows) {
    // 封面（`covers/`）永远不许带 Content-Disposition：它是 <img> 内联展示的，
    // 带上 attachment 会让封面在浏览器里变成下载。正常数据里封面只出现在
    // cover_key 列，这里挡的是「脏数据把封面键写进了 r2_key」。
    // `uploads/` 是上传暂存区，不该被当成书上架。
    if (row.r2_key.startsWith('covers/') || row.r2_key.startsWith('uploads/')) {
      skipped++;
      continue;
    }

    try {
      const head = await env.BUCKET.head(row.r2_key);
      if (!head) {
        // D1 有行、R2 没对象：这是数据不一致，值得单独计数（不是「跳过」）
        missing++;
        continue;
      }

      // 目标元数据要**一次给全**：put 会用新的 httpMetadata 整体替换旧值，
      // 只写 contentDisposition 会把 Content-Type 清成默认值（比不回填更糟）。
      const want = r2HttpMetadata(row.leaf_name);
      const current = head.httpMetadata;
      if (
        current?.contentDisposition === want.contentDisposition &&
        current?.contentType === want.contentType
      ) {
        skipped++;
        continue;
      }

      if (dryRun) {
        backfilled++;
        bytesRewritten += head.size;
        continue;
      }

      const source = await env.BUCKET.get(row.r2_key);
      if (!source) {
        // head 与 get 之间被删掉了（并发删除），不算失败
        missing++;
        continue;
      }
      const written = await env.BUCKET.put(row.r2_key, source.body, { httpMetadata: want });
      backfilled++;
      bytesRewritten += written.size;
    } catch (err) {
      failed++;
      // 只留前几条：一页最多 16 本，多留也没有信息量，反而把响应撑大
      if (failures.length < 5) {
        failures.push({
          id: row.id,
          leafName: row.leaf_name,
          error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        });
      }
    }
  }

  const last = rows[rows.length - 1];
  // hasMore 是探针给出的确定答案（见上面的查询），不是「页满」的推断。
  const nextAfter = hasMore && last ? last.id : null;

  return jsonResponse({
    action: 'backfill-disposition',
    after,
    limit,
    dryRun,
    scanned: rows.length,
    backfilled,
    skipped,
    missing,
    failed,
    bytesRewritten,
    nextAfter,
    failures,
    note: nextAfter
      ? `还有下一页，请带上 after=${nextAfter} 再调一次`
      : dryRun
        ? '预演完成，没有写入任何对象；去掉 dryRun 参数再跑一次才会真的补上'
        : '已扫描完全部书；R2 响应头已补上下载名，D1 与目录缓存都不需要改动',
  });
}

/**
 * 把存量对象从旧键 `books/<id>` 迁到可读键 `books/<id>/<书名>`。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────
 * `bookObjectKey()` 让**新书**的键带上了书名，于是走 S3 协议的客户端
 * （rclone / aws-cli）落盘时能拿到可读文件名。但**存量对象仍是旧键**：
 * 它们拉下来还是 `b01`、`b02`。`reindex` 救不了这件事 —— 它写的是
 * `r2Key: object.key`，只**发现**对象，不**重命名**对象。
 *
 * ── 安全性设计（这是唯一会动线上真实数据的端点，所以每一步都保守）──
 *
 *  1. **默认 dry-run**：不传 `apply=1` 就只统计、不改任何东西。
 *     需要显式 `apply=1` 才真的搬。这是 R2 `delete` / `put` 这类不可逆操作
 *     的底线 —— 一个手滑的 GET 请求不该能重写整库。
 *
 *  2. **先 put 新的、再删旧的**：顺序反过来会在两步之间留下「D1 指着新键、
 *     R2 里还没有」的窗口，那段时间这本书 404。先写后删则最坏情况是
 *     **孤儿旧对象**（占空间但可读），而不是**数据丢失**。
 *     孤儿可以在下一次跑这个端点时被 `cleanup=1` 清掉。
 *
 *  3. **元数据一次给全**：`put` 会用新的 httpMetadata 整体替换旧值。
 *     只搬字节不带元数据，会把 Content-Type 与 Content-Disposition 清成默认
 *     （比不迁移更糟：文件变成 `binary/octet-stream` 且没有下载名）。
 *
 *  4. **一次只处理一页、带 cursor**：几百本 × 2.5 MB 的搬移会超出 Worker
 *     的时长与内存限制。`while (nextAfter)` 分页跑，每页有界。
 *     游标语义：`nextAfter` = 本页已扫描（`scanned` 行）中最大的 id；
 *     多查的 1 行探针只用于判断 `hasMore`，不能作为游标——错用探针 id
 *     会把探针那本整个跳过（生产预演曾因此让 16 本永远扫不到、每页
 *     死在同一批 10+6 本上）。
 *
 *  5. **失败不中断**：单本失败只计数并留前 5 条原因，不让一本坏书卡住整库。
 *
 * ── 幂等 ────────────────────────────────────────────────────────────────
 * 已经在新格式的键（`books/<id>/<...>`）直接跳过，可以反复跑。
 * 这就是为什么迁移脚本可以「跑到全绿为止」而不需要额外状态记录。
 */
async function migrateKeys(env: Env, url: URL): Promise<Response> {
  const after = url.searchParams.get('after') ?? '';
  const requested = Number.parseInt(
    url.searchParams.get('limit') ?? String(DEFAULT_BACKFILL_LIMIT),
    10,
  );
  const limit = Math.min(Math.max(requested || DEFAULT_BACKFILL_LIMIT, 1), MAX_BACKFILL_LIMIT);
  // ⚠️ 默认 false：不传 apply 只做预演。见上面第 1 条。
  const apply = ['1', 'true', 'yes'].includes(
    (url.searchParams.get('apply') ?? '').toLowerCase(),
  );
  // cleanup=1 时，顺带删掉「已迁移但旧对象还留着」的孤儿。
  // 与 apply 独立：可以只清孤儿、不搬新书。
  const cleanup = ['1', 'true', 'yes'].includes(
    (url.searchParams.get('cleanup') ?? '').toLowerCase(),
  );

  // 与 backfillDisposition 相同的「多查一行当探针」手法，理由见那里的长注释。
  // 多查一列（分桶字段）是为了**正确失效目录缓存**：键一改，书卡 href 与
  // GET 302 的 Location 都变了，缓存里指向旧键的条目必须清掉，否则客户端会
  // 拿着已经不存在的键去请求。`bookCacheTargets()` 需要的正是这几列。
  const { results } = await env.DB
    .prepare(
      `SELECT id, leaf_name, r2_key, size, title_letter, author_letter, format_bucket
         FROM books
        WHERE status = 'published' AND id > ?
        ORDER BY id LIMIT ?`,
    )
    .bind(after, limit + 1)
    .all<{
      id: string;
      leaf_name: string;
      r2_key: string;
      size: number;
      title_letter: string;
      author_letter: string;
      format_bucket: string;
    }>();
  const fetched = results ?? [];
  const hasMore = fetched.length > limit;
  const rows = hasMore ? fetched.slice(0, limit) : fetched;

  let migrated = 0;
  let alreadyReadable = 0;
  let orphanCleaned = 0;
  let missing = 0;
  let failed = 0;
  let bytesMoved = 0;
  const failures: Array<{ id: string; leafName: string; error: string }> = [];
  /** 预演时列出将要发生的改名，方便人工先看一眼 */
  const plan: Array<{ id: string; from: string; to: string }> = [];

  for (const row of rows) {
    if (row.r2_key.startsWith('covers/') || row.r2_key.startsWith('uploads/')) {
      // 与 backfill 同样的防御：脏数据把封面/暂存键写进 r2_key 时不许搬
      continue;
    }

    const wantKey = bookObjectKey(row.id, row.leaf_name);
    // 幂等：已经是可读键就跳过（也可能上次 put 成功、删旧键失败）
    if (row.r2_key === wantKey) {
      alreadyReadable++;
      // cleanup 分支：旧键 `books/<id>` 若还在，删掉它。
      if (apply && cleanup) {
        const legacy = `books/${row.id}`;
        if (await env.BUCKET.head(legacy)) {
          await env.BUCKET.delete(legacy);
          orphanCleaned++;
        }
      }
      continue;
    }

    try {
      const head = await env.BUCKET.head(row.r2_key);
      if (!head) {
        // D1 有行、R2 没对象 —— 数据不一致，单独计数
        missing++;
        continue;
      }

      if (!apply) {
        // 预演：只记录计划，不碰任何对象
        migrated++;
        bytesMoved += head.size;
        if (plan.length < limit) plan.push({ id: row.id, from: row.r2_key, to: wantKey });
        continue;
      }

      // 读原文 → 用**完整**元数据写新键（见上面第 3 条）
      const source = await env.BUCKET.get(row.r2_key);
      if (!source) {
        missing++;
        continue;
      }
      const written = await env.BUCKET.put(wantKey, source.body, {
        httpMetadata: r2HttpMetadata(row.leaf_name),
      });

      // D1 指向新键。**必须在删除旧对象之前** —— 顺序见上面第 2 条。
      await env.DB
        .prepare('UPDATE books SET r2_key = ?, updated_at = ? WHERE id = ?')
        .bind(wantKey, new Date().toISOString(), row.id)
        .run();

      // 旧键删除放在最后：即使这里失败，数据仍然完整可读
      if (row.r2_key !== wantKey) {
        await env.BUCKET.delete(row.r2_key);
      }

      migrated++;
      bytesMoved += written.size;
    } catch (err) {
      failed++;
      if (failures.length < 5) {
        failures.push({
          id: row.id,
          leafName: row.leaf_name,
          error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        });
      }
    }
  }

  // 键变了意味着书卡 href 与 GET 302 的 Location 都变了 —— 目录缓存里的
  // 旧 href 会指向已经不存在的键，必须失效这部分。用现成的 bookCacheTargets()
  // 而不是手拼路径：一本书同时出现在 5 个集合下（5 条叶子路径 + 5 个所属列表），
  // 漏掉任何一条就会让某个入口继续指向旧键。
  // 榜单（/api/credits）也带 downloadUrl，一并清。
  if (apply && migrated > 0) {
    const moved = rows.filter((r) => r.r2_key !== bookObjectKey(r.id, r.leaf_name));
    const targets = moved.flatMap((r) =>
      bookCacheTargets({
        leafName: r.leaf_name,
        titleLetter: r.title_letter,
        authorLetter: r.author_letter,
        formatBucket: r.format_bucket,
      }),
    );
    await purgeEntries(targets);
    await purgeCreditCache();
  }

  const last = rows[rows.length - 1];
  // nextAfter 取**已扫描行的 id**（不是探针行的）：id 是 hex 短串，lex 排序，
  // `WHERE id > ?` 用「已扫描的最后一行」做游标不会漏也不会重。
  // 如果错用探针行（第 limit+1 行）的 id，那本在下一页**没有出现在 plan**
  // 中，却直接跳到了它的后一行，导致它被整个跳过（生产预演里曾因此让
  // 16 本书永远扫不到，每页都死在同一批 10+6 本上）。
  const nextAfter = hasMore && last ? last.id : null;

  return jsonResponse({
    action: 'migrate-keys',
    after,
    limit,
    apply,
    cleanup,
    scanned: rows.length,
    migrated,
    alreadyReadable,
    orphanCleaned,
    missing,
    failed,
    bytesMoved,
    nextAfter,
    failures,
    plan: apply ? undefined : plan,
    note: !apply
      ? '预演模式：没有写入任何对象。确认 plan 无误后加 apply=1 再跑'
      : nextAfter
        ? `已迁移 ${migrated} 本，还有下一页，请带上 after=${nextAfter} 再调一次`
        : '已扫描完全部书；存量对象键已变成可读格式',
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
