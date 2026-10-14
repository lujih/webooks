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
import { hasAdminToken } from '../lib/auth';
import { handleAdminRequests, handleCreditBoard, handleCreditPurge } from './requests';
import { jsonResponse, textResponse } from '../lib/http';
import {
  deriveMetadata,
  guessAuthorFromText,
  leafNameFromKey,
  normaliseAuthor,
  safeContentTypeFor,
  sanitiseLeafName,
  sha256Hex,
} from '../lib/metadata';
import { davCache, purgeEntries } from '../lib/cache';
import { purgeCreditCache } from './requests';

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
    case 'rebucket':
      return rebucket(env, url);
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
