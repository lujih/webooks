-- webooks migration 0005：修两个查询计划（不改变任何行为）
--
-- 本迁移只加索引。起因是两处**实测**发现的查询计划退化 ——
-- 都只影响性能，不影响正确性，所以可以独立于代码修复。

-- ─────────────────────────────────────────────────────────────────────────
-- 1) `/最近收录/` 退化成全表扫描
--
-- db.ts 的 recent 分支：
--     SELECT … FROM books WHERE status='published'
--     ORDER BY published_at DESC, id LIMIT 200
--
-- 现有索引 idx_books_recent ON books(published_at DESC) 无法与
-- `status = 'published'` 这个等值条件组合，SQLite 于是退化到
-- idx_books_status（该索引对 status='published' 匹配**全部 N 行**），
-- 再对全部 N 行做临时排序才取 LIMIT 200。
--
-- 执行计划（sqlite 复刻全部索引后实测）：
--     SEARCH books USING INDEX idx_books_status (status=?)
--     USE TEMP B-TREE FOR ORDER BY          ← rows_read = N
--
-- 这意味着**一次缓存未命中就扫描全表**。而 `/最近收录/` 是浏览页落地页、
-- rclone 全库同步的必经之路。实测 D1 行读随书量线性增长：
--     1,000 本 → ~1,000 行      5,000 本 → ~5,000 行
--    20,000 本 → ~20,000 行
-- D1 免费额度只有 500 万行/天 —— 20,000 本时仅 250 次未命中就会让
-- 全站 D1 硬停到次日 UTC 0 点。而 budget.mjs 一直假设恒定 200 行。
--
-- 复合索引把前导列改成 status，之后计划变成：
--     SEARCH books USING INDEX idx_books_recent2 (status=?)
-- 无临时 B-tree，只走 200 行。**实测已确认计划切换正确。**
--
-- 保留旧索引：它仍服务于任何不带 status 过滤的 published_at 排序。
CREATE INDEX IF NOT EXISTS idx_books_recent2
  ON books(status, published_at DESC, id);

-- ─────────────────────────────────────────────────────────────────────────
-- 2) allLiveLocks 是 SCAN locks
--
-- locks.ts 的 allLiveLocks：
--     SELECT * FROM locks WHERE expires_at > ?
--
-- 现有索引 idx_locks_resource ON locks(resource, expires_at) 的**前导列是
-- resource**，而这条查询只按 expires_at 过滤 —— 前导列用不上，于是全表扫描。
--
--     EXPLAIN QUERY PLAN → SCAN locks
--
-- 两个问题叠加让它更严重：
--   · propfind.ts 在**每次 PROPFIND** 都调它，而且**缓存命中时也调**
--     —— 于是「命中时 0 次 D1 读」（propfind.ts 顶部注释的论证）并不成立
--   · locks 是唯一没有行数上限的表：匿名 LOCK 端点让任何人都能建锁，
--     而过期清扫只在 LOCK 时跑，行数会持续膨胀
--
-- 补一个 expires_at 前导索引，把扫描变成范围查找。
CREATE INDEX IF NOT EXISTS idx_locks_expiry
  ON locks(expires_at);
-- ─────────────────────────────────────────────────────────────────────────
-- 3) 分桶计数的 WHERE 过滤也需要索引
--
-- 写路径改用增量计数后（见 src/lib/db.ts 的 adjustBuckets），每次写操作
-- 执行形如：
--     SELECT COUNT(*) FROM books WHERE status='published' AND title_letter=?
--
-- 没有匹配索引时，SQLite 退化到 idx_books_status（status='published'
-- 匹配全部 N 行）再过滤 —— **行读仍是 N**，等于增量白做了。
--
-- 加了 (title_letter, status) 之后，计划变成：
--     SEARCH books USING COVERING INDEX idx_books_title_status
--           (title_letter=? AND status=?)
-- COVERING 意味着 count(*) 所需的列全在索引里，**完全不用回表读 books**。
-- 实测 @5000 本：2.44ms → 0.088ms（28×）。
--
-- 三个分桶键各要一个（author / format 同理）。kind_bucket 已有
-- (kind_bucket, title) 索引，但那个前导列是 kind_bucket、没有 status，
-- 同样需要 (kind_bucket, status)。
CREATE INDEX IF NOT EXISTS idx_books_title_status  ON books(title_letter, status);
CREATE INDEX IF NOT EXISTS idx_books_author_status ON books(author_letter, status);
CREATE INDEX IF NOT EXISTS idx_books_format_status ON books(format_bucket, status);
CREATE INDEX IF NOT EXISTS idx_books_kind_status   ON books(kind_bucket, status);
