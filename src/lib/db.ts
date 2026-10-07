/** D1 访问层。所有查询都走索引，避免全表扫描（D1 按「扫描行数」计费）。 */

import type { CollectionId } from './collections';

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
  published_at: string | null;
  created_at: string;
  updated_at: string;
  status: string;
  cover_key: string | null;
  description: string | null;
}

const BOOK_COLUMNS = `id, leaf_name, title, author, language, format, content_type, size,
  sha256, r2_key, etag, title_letter, author_letter, format_bucket, published_at,
  created_at, updated_at, status, cover_key, description`;

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
  publishedAt: string | null;
  coverKey?: string | null;
  description?: string | null;
  status?: string;
}

export function upsertBookStatement(db: D1Database, b: UpsertBookInput): D1PreparedStatement {
  const now = new Date().toISOString();
  return db
    .prepare(
      `INSERT INTO books (id, leaf_name, title, author, language, format, content_type, size,
         sha256, r2_key, etag, title_letter, author_letter, format_bucket, published_at,
          cover_key, description, created_at, updated_at, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
         published_at = excluded.published_at,
         updated_at = excluded.updated_at,
         status = excluded.status`,
    )
    .bind(
      b.id, b.leafName, b.title, b.author, b.language, b.format, b.contentType, b.size,
      b.sha256, b.r2Key, b.etag, b.titleLetter, b.authorLetter, b.formatBucket, b.publishedAt,
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
 * 重算 buckets 表。在每次写入/删除后调用。
 * 用 GROUP BY 一次算完，比「每本书 +1/-1」更不容易漂移。
 * 注意：这一句会扫描 books 全表，只在 admin 操作里调用，不在读路径上。
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
       SELECT 'recent', 'all', COUNT(*), ?
         FROM books WHERE status = 'published'`,
    ).bind(now),
  ];
  await db.batch(statements);
}
