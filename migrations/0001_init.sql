-- webooks —— D1 元数据层
--
-- 设计要点：
--   * books.leaf_name 全局唯一，WebDAV 叶子节点直接按它查找（1 次索引命中）。
--   * buckets 表把"每个分桶有多少本书"denormalize 下来，这样目录导航页
--     (/title/) 只需读 ~37 行，而不是对 books 做全表 COUNT。
--   * title_letter / author_letter 是预先算好的分桶键（A-Z / 0-9 / _），
--     避免在查询里做 substr() 导致索引失效（D1 按"扫描行数"计费）。

CREATE TABLE IF NOT EXISTS books (
  id             TEXT PRIMARY KEY,
  leaf_name      TEXT NOT NULL,          -- WebDAV 中显示的文件名
  title          TEXT NOT NULL,
  author         TEXT,
  language       TEXT,
  format         TEXT NOT NULL,          -- epub / pdf / mobi / ...
  content_type   TEXT NOT NULL,
  size           INTEGER NOT NULL,
  sha256         TEXT,
  r2_key         TEXT NOT NULL,          -- R2 对象键
  etag           TEXT,
  title_letter   TEXT NOT NULL,          -- A-Z / 0-9 / _
  author_letter  TEXT NOT NULL,
  format_bucket  TEXT NOT NULL,          -- 与小写 format 相同，单独列出便于索引
  published_at   TEXT,                   -- ISO8601，用于 /recent/
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'published'
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_books_leaf          ON books(leaf_name);
CREATE INDEX        IF NOT EXISTS idx_books_title_bucket  ON books(title_letter, title);
CREATE INDEX        IF NOT EXISTS idx_books_author_bucket ON books(author_letter, author);
CREATE INDEX        IF NOT EXISTS idx_books_format_bucket ON books(format_bucket, title);
CREATE INDEX        IF NOT EXISTS idx_books_recent        ON books(published_at DESC);
CREATE INDEX        IF NOT EXISTS idx_books_sha           ON books(sha256);
CREATE INDEX        IF NOT EXISTS idx_books_status        ON books(status);

-- 分桶计数：让导航页和分页计算变成 1 次小查询
CREATE TABLE IF NOT EXISTS buckets (
  collection TEXT NOT NULL,              -- title / author / format / recent
  bucket     TEXT NOT NULL,              -- A / Z / epub / all
  total      INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (collection, bucket)
);

-- 已删除内容的哈希墓碑：阻止同一文件被重复上传（滥用治理用）
CREATE TABLE IF NOT EXISTS tombstones (
  sha256     TEXT PRIMARY KEY,
  reason     TEXT NOT NULL,
  created_at TEXT NOT NULL
);
