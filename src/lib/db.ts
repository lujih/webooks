/** D1 访问层。所有查询都走索引，避免全表扫描（D1 按「扫描行数」计费）。 */

import type { CollectionId } from './collections';
import { mediaKindOfFormat } from './collections';

export interface BookRow {
  id: string;
  leaf_name: string;
  title: string;
  author: string | null;
  language: string | null;
  format: string;
  content_type: string;
  size: number;
  sha256: string | null;
  r2_key: string;
  etag: string | null;
  title_letter: string;
  author_letter: string;
  format_bucket: string;
  /** 大类：ebook / comic / audio（由 format_bucket 派生，供「按类型」集合使用） */
  kind_bucket: string;
  /**
   * kind_bucket 的来源（迁移 0006）：'sniffed' 内容嗅探 / 'derived' 按扩展名
   * / 'manual' 人工标注。'manual' 的值不得被 rebucket 或覆盖上传冲掉。
   */
  kind_source: string;
  published_at: string | null;
  created_at: string;
  updated_at: string;
  status: string;
  cover_key: string | null;
  description: string | null;
}

const BOOK_COLUMNS = `id, leaf_name, title, author, language, format, content_type, size,
  sha256, r2_key, etag, title_letter, author_letter, format_bucket, kind_bucket, kind_source,
  published_at, created_at, updated_at, status, cover_key, description`;

/** 导航页数据源：桶 + 计数。行数 ≤ 28，非常便宜。 */
export async function listBucketTotals(
  db: D1Database,
  collection: CollectionId,
): Promise<Array<{ bucket: string; total: number }>> {
  const { results } = await db
    .prepare(
      `SELECT bucket, total FROM buckets
        WHERE collection = ? AND total > 0
        ORDER BY bucket`,
    )
    .bind(collection)
    .all<{ bucket: string; total: number }>();
  return results ?? [];
}

export async function getBucketTotal(
  db: D1Database,
  collection: CollectionId,
  bucket: string,
): Promise<number> {
  const row = await db
    .prepare(`SELECT total FROM buckets WHERE collection = ? AND bucket = ?`)
    .bind(collection, bucket)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

/** 列出某个分桶的一页书。调用方负责保证 limit ≤ HARD_MAX_ENTRIES。 */
export async function listBooks(
  db: D1Database,
  collection: CollectionId,
  bucket: string,
  offset: number,
  limit: number,
): Promise<BookRow[]> {
  const base = `SELECT ${BOOK_COLUMNS} FROM books WHERE status = 'published'`;
  const paging = `LIMIT ? OFFSET ?`;

  let stmt: D1PreparedStatement;
  switch (collection) {
    case 'title':
      stmt = db.prepare(`${base} AND title_letter = ? ORDER BY title, id ${paging}`)
        .bind(bucket, limit, offset);
      break;
    case 'author':
      stmt = db.prepare(`${base} AND author_letter = ? ORDER BY author, title, id ${paging}`)
        .bind(bucket, limit, offset);
      break;
    case 'format':
      stmt = db.prepare(`${base} AND format_bucket = ? ORDER BY title, id ${paging}`)
        .bind(bucket, limit, offset);
      break;
    case 'type':
      stmt = db.prepare(`${base} AND kind_bucket = ? ORDER BY title, id ${paging}`)
        .bind(bucket, limit, offset);
      break;
    case 'recent':
      stmt = db.prepare(`${base} ORDER BY published_at DESC, id ${paging}`)
        .bind(limit, offset);
      break;
  }

  const { results } = await stmt.all<BookRow>();
  return results ?? [];
}

/** 叶子节点查找：leaf_name 上有唯一索引，1 次索引命中。 */
export async function findBookByLeaf(db: D1Database, leafName: string): Promise<BookRow | null> {
  const row = await db
    .prepare(`SELECT ${BOOK_COLUMNS} FROM books WHERE leaf_name = ? AND status = 'published'`)
    .bind(leafName)
    .first<BookRow>();
  return row ?? null;
}

/**
 * 管理后台：全局列出书（可按书名/作者/文件名模糊搜）。
 * 与面向读者的 listBooks 不同 —— 这里不按分桶，直接按时间倒序，
 * 目的是「管理」而非「浏览」。
 */
export async function adminListBooks(
  db: D1Database,
  query: string,
  limit: number,
  offset: number,
): Promise<BookRow[]> {
  const q = query.trim();
  if (!q) {
    const { results } = await db
      .prepare(`SELECT ${BOOK_COLUMNS} FROM books ORDER BY created_at DESC, id LIMIT ? OFFSET ?`)
      .bind(limit, offset)
      .all<BookRow>();
    return results ?? [];
  }
  // LIKE 的通配符要转义，否则用户输入 % 会变成「匹配一切」
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const { results } = await db
    .prepare(
      `SELECT ${BOOK_COLUMNS} FROM books
        WHERE title LIKE ?1 ESCAPE '\\' OR author LIKE ?1 ESCAPE '\\' OR leaf_name LIKE ?1 ESCAPE '\\'
        ORDER BY created_at DESC, id LIMIT ?2 OFFSET ?3`,
    )
    .bind(like, limit, offset)
    .all<BookRow>();
  return results ?? [];
}

/** 管理后台：总数 + 占用空间（用于容量告警，免费层 R2 只有 10GB） */
export async function adminTotals(
  db: D1Database,
): Promise<{ books: number; bytes: number }> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS books, COALESCE(SUM(size), 0) AS bytes FROM books`)
    .first<{ books: number; bytes: number }>();
  return { books: row?.books ?? 0, bytes: row?.bytes ?? 0 };
}

/**
 * 递归删除一个集合下的**全部**书（RFC 4918 §9.6.1：集合上的 DELETE 等价于
 * `Depth: infinity`）。
 *
 * 分页拉取是因为单页有上限，而一个桶里可能有上千本。循环用「按 id 升序 + 大于
 * 游标」而不是 OFFSET —— 删除过程中 OFFSET 会跳过行（每删一批后面的行就前移）。
 *
 * 返回被删掉的书，供调用方清理 R2 对象与缓存。
 */
/**
 * 列出某个桶/集合里将被删除的书（**不删**）。
 *
 * 单独提供只读版本是必需的：`deleteBooksInBucket` 一边翻页一边执行
 * DELETE，调用方拿不到「完整待删清单」就已经把行删掉了。而集合 DELETE
 * 必须先判断成员锁（RFC 4918 §9.6）—— 被锁时整体拒绝，一条都不能删。
 *
 * 修复前正是因为顺序反了，锁检查在删除之后才跑，永远看不到待删的书。
 */
export async function listBooksInBucket(
  db: D1Database,
  collection: CollectionId,
  bucket: string,
): Promise<BookRow[]> {
  const where = bucketWhere(collection, bucket);
  // 条件里有没有占位符，决定要不要 bind。
  // `recent` 的条件是常量 `1 = 1`，多 bind 一个参数会直接报
  // D1_ERROR: Wrong number of parameter bindings。
  const bindArgs = where.includes('?') ? [bucket] : [];
  const { results } = await db
    .prepare(
      `SELECT ${BOOK_COLUMNS} FROM books
         WHERE status = 'published' AND ${where}
         ORDER BY id`,
    )
    .bind(...bindArgs)
    .all<BookRow>();
  return results ?? [];
}

/** 集合 → SQL 过滤条件。`recent` 是扁平集合，成员就是全部书。 */
function bucketWhere(collection: CollectionId, bucket: string): string {
  switch (collection) {
    case 'title':
      return `title_letter = ?`;
    case 'author':
      return `author_letter = ?`;
    case 'format':
      return `format_bucket = ?`;
    case 'type':
      return `kind_bucket = ?`;
    case 'recent':
      return `1 = 1`;
    default:
      return `1 = 0`;
  }
}

export async function deleteBooksInBucket(
  db: D1Database,
  collection: CollectionId,
  bucket: string,
): Promise<BookRow[]> {
  const where = bucketWhere(collection, bucket);
  const bindArgs = where.includes('?') ? [bucket] : [];

  const deleted: BookRow[] = [];
  const PAGE = 100;
  let cursor = '';
  for (;;) {
    const { results } = await db
      .prepare(
        `SELECT ${BOOK_COLUMNS} FROM books
           WHERE status = 'published' AND ${where} AND id > ?
           ORDER BY id LIMIT ?`,
      )
      .bind(...bindArgs, cursor, PAGE)
      .all<BookRow>();
    const rows = results ?? [];
    if (rows.length === 0) break;

    const ids = rows.map((r) => r.id);
    const ph = ids.map(() => '?').join(',');
    await db.prepare(`DELETE FROM books WHERE id IN (${ph})`).bind(...ids).run();

    deleted.push(...rows);
    cursor = rows[rows.length - 1]!.id;
    if (rows.length < PAGE) break;
  }
  return deleted;
}

/** 管理后台：按 leaf_name 批量查（先查回 r2_key 以便一并清理对象） */
export async function findBooksByLeafNames(
  db: D1Database,
  leafNames: string[],
): Promise<BookRow[]> {
  if (leafNames.length === 0) return [];
  const out: BookRow[] = [];
  // D1 单条语句绑定参数有限，分批查
  const BATCH = 90;
  for (let i = 0; i < leafNames.length; i += BATCH) {
    const chunk = leafNames.slice(i, i + BATCH);
    const ph = chunk.map(() => '?').join(',');
    const { results } = await db
      .prepare(`SELECT ${BOOK_COLUMNS} FROM books WHERE leaf_name IN (${ph})`)
      .bind(...chunk)
      .all<BookRow>();
    out.push(...(results ?? []));
  }
  return out;
}

export async function getBookById(db: D1Database, id: string): Promise<BookRow | null> {
  const row = await db
    .prepare(`SELECT ${BOOK_COLUMNS} FROM books WHERE id = ?`)
    .bind(id)
    .first<BookRow>();
  return row ?? null;
}

export async function isTombstoned(db: D1Database, sha256: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS hit FROM tombstones WHERE sha256 = ?`)
    .bind(sha256)
    .first<{ hit: number }>();
  return row !== null;
}

// ── 写入 ────────────────────────────────────────────────────────────────

export interface UpsertBookInput {
  id: string;
  leafName: string;
  title: string;
  author: string | null;
  language: string | null;
  format: string;
  contentType: string;
  size: number;
  sha256: string | null;
  r2Key: string;
  etag: string | null;
  titleLetter: string;
  authorLetter: string;
  formatBucket: string;
  /**
   * 大类（ebook/comic/audio）。**可省略**：省略时由 formatBucket 自动派生，
   * 保证只有一个事实来源，调用方也不会忘记设置。
   */
  kindBucket?: string;
  /**
   * kindBucket 的来源（迁移 0006）：
   *   'sniffed' —— 内容嗅探得出（读 PDF/EPUB 内部结构，可被重新嗅探覆盖）
   *   'derived' —— 按扩展名猜的（可被重新嗅探覆盖）
   *   'manual'  —— 管理员手工标注，**自动化不得覆盖**
   *
   * 为什么需要这个字段：PDF 1.5+ 用对象流把字典压起来时内容嗅探判不出，
   * 带 OCR 层的扫描漫画又会引入字体让「零字体」判据失效 —— 这两类书
   * 只能靠人工标注。而人工标注恰恰是最容易被自动化覆盖的：
   * 实测人工标成 comic 后跑 `rebucket?sniff=1` 会被打回 ebook。
   *
   * 省略时默认 'derived'（最弱来源，可被覆盖），保持向后兼容。
   */
  kindSource?: 'sniffed' | 'derived' | 'manual';
  publishedAt: string | null;
  coverKey?: string | null;
  description?: string | null;
  status?: string;
}

export function upsertBookStatement(db: D1Database, b: UpsertBookInput): D1PreparedStatement {
  const now = new Date().toISOString();
  const kind = b.kindBucket ?? mediaKindOfFormat(b.formatBucket);
  // 来源默认最弱（derived）：调用方没显式声明就视为「可被覆盖」，
  // 这样即便新代码忘了传，也不会意外永久锁死某本书的分类。
  const kindSource = b.kindSource ?? 'derived';
  return db
    .prepare(
      `INSERT INTO books (id, leaf_name, title, author, language, format, content_type, size,
         sha256, r2_key, etag, title_letter, author_letter, format_bucket, kind_bucket, kind_source,
          published_at, cover_key, description, created_at, updated_at, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         leaf_name = excluded.leaf_name,
         title = excluded.title,
         author = excluded.author,
         language = excluded.language,
         format = excluded.format,
         content_type = excluded.content_type,
         size = excluded.size,
         sha256 = excluded.sha256,
         r2_key = excluded.r2_key,
         etag = excluded.etag,
         title_letter = excluded.title_letter,
         author_letter = excluded.author_letter,
         format_bucket = excluded.format_bucket,
         -- ⚠️ 人工标注不得被覆盖写入冲掉（迁移 0006）。
         --   覆盖上传同一个文件时，这里如果无条件写 excluded.kind_source，
         --   管理员在 /admin 里改过的分类就会被重置回 derived。
         --   只有当新值本身是人工标注时才允许覆盖 —— 自动化流程（上传、
         --   reindex、rebucket）都不会传 'manual'。
         kind_source = CASE
           WHEN excluded.kind_source = 'manual' THEN 'manual'
           ELSE books.kind_source
         END,
         -- ⚠️ kind_bucket 本身也必须一起保护。
         --   只保护 kind_source 是不够的：覆盖上传会算出一个新的 kind_bucket
         --   （按扩展名派生），原值就被冲掉了 —— 实测人工标注的 comic
         --   在覆盖上传后变回 ebook，而 kind_source 还留在 manual，
         --   形成「来源标成人工、值却是机器猜的」这种自相矛盾的状态。
         --   判定依据是**旧行**的来源，所以要引用 books.kind_source
         --   （excluded 是新值，books 是旧值 —— ON CONFLICT DO UPDATE 里
         --   后者指被更新的那一行）。
         kind_bucket = CASE
           WHEN books.kind_source = 'manual' AND excluded.kind_source <> 'manual'
             THEN books.kind_bucket
           ELSE excluded.kind_bucket
         END,
         published_at = excluded.published_at,
         -- cover_key / description 必须一起更新：否则「覆盖上传」一本书后，
         -- 新解析出的封面与简介永远不会写进去（真实踩过：重传带封面的 EPUB，
         -- R2 里封面对象已存在，但 D1 行的 cover_key 始终保持旧值 null）。
         cover_key = excluded.cover_key,
         description = excluded.description,
         updated_at = excluded.updated_at,
         status = excluded.status`,
    )
    .bind(
      b.id, b.leafName, b.title, b.author, b.language, b.format, b.contentType, b.size,
      b.sha256, b.r2Key, b.etag, b.titleLetter, b.authorLetter, b.formatBucket, kind, kindSource,
      b.publishedAt,
      b.coverKey ?? null, b.description ?? null,
      now, now, b.status ?? 'published',
    );
}

export async function upsertBook(db: D1Database, b: UpsertBookInput): Promise<void> {
  await upsertBookStatement(db, b).run();
}

export async function deleteBook(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM books WHERE id = ?`).bind(id).run();
}

/**
 * 增量更新 buckets：**只重算被影响的那几个桶**，不做全表扫描。
 *
 * 为什么不直接用 rebuildBuckets：它每次都跑
 * `DELETE FROM buckets` + 5 条 `GROUP BY`，而每条 GROUP BY 都会扫一遍
 * books 全表。实测 @5000 本时每次写操作约 **25,000 行读 + 205 行写** ——
 * 而 D1 Free 只有 500 万行读/天、10 万行写/天，且**都是硬停**
 * （打满即全站停摆到次日 UTC 0 点）。
 *
 *   D1 行读：5000 本时每天只能做 ~200 次写操作
 *   D1 行写：~215 行/次 → 每天 ~465 次就打满
 *
 * 本函数只对「这本书所属的桶」执行 `COUNT(*) WHERE <bucket>=?`。
 * WHERE 走的是 (title_letter, title) / (author_letter, author) 等索引，
 * 所以每次只读该桶内的行数 —— 单桶通常几十到几百行，不是 N。
 *
 * 何时用哪个：
 *   · 单本写入/删除/改名/改分类 → adjustBuckets（这里）
 *   · reindex、批量修正 → rebuildBuckets（全量，因为要纠正历史漂移）
 *
 * ⚠️ 「只对受影响的桶」这个前提要求调用方知道**旧值**（改名时要同时
 *   减少旧桶、增加新桶）。因此接口接收 before/after 两个快照。
 */
export async function adjustBuckets(
  db: D1Database,
  deltas: BucketDelta[],
): Promise<void> {
  if (deltas.length === 0) return;
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];

  // 按 (collection, bucket) 合并同一桶的多个增量，避免重复 SQL
  const merged = new Map<string, number>();
  for (const d of deltas) {
    const key = `${d.collection}\u0000${d.bucket}`;
    merged.set(key, (merged.get(key) ?? 0) + d.delta);
  }

  for (const [key, delta] of merged) {
    const [collection, bucket] = key.split('\u0000');
    if (!collection || bucket === undefined || delta === 0) continue;
    // UPSERT：桶可能还不存在（第一次有书落进这个桶）
    statements.push(
      db.prepare(
        `INSERT INTO buckets (collection, bucket, total, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(collection, bucket) DO UPDATE
           SET total = MAX(0, total + ?), updated_at = ?`,
      ).bind(collection, bucket, Math.max(delta, 0), now, delta, now),
    );
  }

  // 计数为 0 的桶要删掉，否则导航页会出现空桶（与 rebuildBuckets 的
  // DELETE+INSERT 语义保持一致）
  statements.push(
    db.prepare(`DELETE FROM buckets WHERE total <= 0 AND updated_at = ?`).bind(now),
  );

  if (statements.length > 1) await db.batch(statements);
}

export interface BucketDelta {
  collection: 'title' | 'author' | 'format' | 'type' | 'recent';
  bucket: string;
  /** +1 增加一本书，-1 移除一本 */
  delta: number;
}

/**
 * 由一本书的「变更前 / 变更后」快照算出全部桶增量。
 *
 * 调用方只需给出两次 upsertBook 前后的值，函数负责推导：
 *   · title_letter 变了 → 旧桶 -1、新桶 +1
 *   · author_letter 变了 → 同上
 *   · format_bucket 变了 → format 桶与 type 桶都变
 *   · 新增 → 全部 +1
 *   · 删除 → 全部 -1
 *   · 都没变 → 返回空数组（调用方可以直接跳过）
 */
export function bucketDeltas(
  before: BucketIdentity | null,
  after: BucketIdentity | null,
): BucketDelta[] {
  const out: BucketDelta[] = [];
  const push = (collection: BucketDelta['collection'], bucket: string, delta: number) => {
    out.push({ collection, bucket, delta });
  };

  // 移除旧值的贡献
  if (before) {
    push('title', before.titleLetter, -1);
    push('author', before.authorLetter, -1);
    push('format', before.formatBucket, -1);
    push('type', mediaKindOfFormat(before.formatBucket), -1);
    push('recent', 'all', -1);
  }
  // 加入新值的贡献
  if (after) {
    push('title', after.titleLetter, 1);
    push('author', after.authorLetter, 1);
    push('format', after.formatBucket, 1);
    push('type', mediaKindOfFormat(after.formatBucket), 1);
    push('recent', 'all', 1);
  }

  // 抵消掉「没变」的部分（同一 collection+bucket 上 +1 与 -1 相消）
  const net = new Map<string, number>();
  for (const d of out) {
    const k = `${d.collection}\u0000${d.bucket}`;
    net.set(k, (net.get(k) ?? 0) + d.delta);
  }
  return [...net.entries()]
    .filter(([, delta]) => delta !== 0)
    .map(([key, delta]) => {
      const [collection, bucket] = key.split('\u0000');
      return { collection: collection as BucketDelta['collection'], bucket: bucket!, delta };
    });
}

/** 算出「这本书对桶的贡献」，用于新增时（after = 这本书，before = null） */
export function bucketIdentityOf(book: {
  titleLetter: string;
  authorLetter: string;
  formatBucket: string;
}): BucketIdentity {
  return {
    titleLetter: book.titleLetter,
    authorLetter: book.authorLetter,
    formatBucket: book.formatBucket,
  };
}

export interface BucketIdentity {
  titleLetter: string;
  authorLetter: string;
  formatBucket: string;
}

/**
 * 全量重算 buckets 表。在批量场景（reindex / rebucket）里调用。
 *
 * ⚠️ 注意：这一句会扫描 books 全表 5 次，因此**只用于低频的批量操作**。
 *   单本写入请用 adjustBuckets —— 详见该函数的注释。
 */
export async function rebuildBuckets(db: D1Database): Promise<void> {
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    db.prepare(`DELETE FROM buckets`),
    db.prepare(
      `INSERT INTO buckets (collection, bucket, total, updated_at)
       SELECT 'title', title_letter, COUNT(*), ?
         FROM books WHERE status = 'published' GROUP BY title_letter`,
    ).bind(now),
    db.prepare(
      `INSERT INTO buckets (collection, bucket, total, updated_at)
       SELECT 'author', author_letter, COUNT(*), ?
         FROM books WHERE status = 'published' GROUP BY author_letter`,
    ).bind(now),
    db.prepare(
      `INSERT INTO buckets (collection, bucket, total, updated_at)
       SELECT 'format', format_bucket, COUNT(*), ?
         FROM books WHERE status = 'published' GROUP BY format_bucket`,
    ).bind(now),
    db.prepare(
      `INSERT INTO buckets (collection, bucket, total, updated_at)
       SELECT 'type', kind_bucket, COUNT(*), ?
         FROM books WHERE status = 'published' GROUP BY kind_bucket`,
    ).bind(now),
    db.prepare(
      `INSERT INTO buckets (collection, bucket, total, updated_at)
       SELECT 'recent', 'all', COUNT(*), ?
         FROM books WHERE status = 'published'`,
    ).bind(now),
  ];
  await db.batch(statements);
}
