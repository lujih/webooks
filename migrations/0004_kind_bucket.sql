-- 「按类型」集合：电子书 / 漫画 / 有声书
--
-- 为什么单开一列而不是从 format_bucket 现算：
--   buckets 表用 GROUP BY 一次算完（见 rebuildBuckets），
--   要能对「类型」分组就必须有一个可索引的列。
--   本列完全由 format_bucket 派生，不引入新的信息来源。

ALTER TABLE books ADD COLUMN kind_bucket TEXT NOT NULL DEFAULT 'ebook';

-- 回填历史数据：按格式归入对应大类。
-- 与 src/lib/collections.ts 的 mediaKindOfFormat() 必须保持一致。
UPDATE books SET kind_bucket = CASE
  WHEN format_bucket IN ('cbz', 'cbr', 'cb7', 'cbt', 'cba')      THEN 'comic'
  WHEN format_bucket IN ('m4a', 'm4b', 'mp3')                    THEN 'audio'
  ELSE 'ebook'
END;

CREATE INDEX IF NOT EXISTS idx_books_kind_bucket ON books(kind_bucket, title);
