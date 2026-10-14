-- webooks migration 0006：记录 kind_bucket 的**来源**
--
-- 为什么需要：kind_bucket 这一列有三种来源，但此前无法区分：
--
--   1. sniffed —— 内容嗅探得出（读 PDF/EPUB 内部结构）
--   2. derived —— 按扩展名猜的（fallback）
--   3. manual  —— 管理员在 /admin 里手工改的
--
-- 区别很实际，因为第 3 种是**人的判断**，且重启发起不可靠：
--   · PDF 1.5+ 用对象流把字典压起来时，内容嗅探判不出 → 只能按扩展名
--   · 带 OCR 层的扫描漫画会引入字体资源，让「零字体」判据完全失效
-- 这两类都只能靠人工标注，而人工标注恰恰是最容易被自动化覆盖的。
--
-- 实测（修复前）：
--   人工把扫描漫画 PDF 标成 comic
--   → 跑 `POST /api/admin/rebucket?sniff=1` → 变回 ebook
--
-- 根因在 rebucket：`kindBucket = sniffed ?? mediaKindOfFormat(...)`
-- 的回退分支**丢弃了原值**（而不是保留它）。
-- 而 README 明写「rebucket 默认不动 kind_bucket：它现在来自内容嗅探或
-- 人工修正，比按扩展名猜更权威」—— `?sniff=1` 打破了这个承诺，
-- 且没有任何警告、没有标志位能区分二者。覆盖上传也有同样的问题。
--
-- 这一列只加不加删：不影响任何现有查询，索引照旧可用。

ALTER TABLE books ADD COLUMN kind_source TEXT NOT NULL DEFAULT 'derived';

-- 回填：迁移前的数据无法区分来源，一律按「派生」处理 ——
-- 这是保守选择：宁可让 sniff 重新判定一次，也不把可能是人工修正的值
-- 永久锁死成不可自动更新。
--
-- ⚠️ 官方明确要求大批量 UPDATE 分批执行
-- （D1 limits FAQ：「A single query that attempts to modify hundreds of
-- thousands of rows … will exceed execution limits」）。
-- 这里用 0004 建表时的写法：D1 单库上限 500MB，书籍规模远小于这个量级，
-- 单条 UPDATE 不会触发限制。若将来书量逼近十万级，必须改成迁移脚本分批。

UPDATE books SET kind_source = 'derived' WHERE kind_source IS NULL OR kind_source = '';

-- 让「按类型」集合的查询能顺带拿到来源（管理后台要按它决定能否覆盖）。
-- 不新建索引：kind_bucket 已有一个 (kind_bucket, title) 索引，
-- 本迁移只是多一个可投影的列，不改变访问模式。
CREATE INDEX IF NOT EXISTS idx_books_kind_source
  ON books(kind_source, id);