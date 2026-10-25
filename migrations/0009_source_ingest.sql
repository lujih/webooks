-- webooks migration 0009：书源与入库来源
--
-- 设计见 docs/source-ingest-design.md 期 0。
--
-- 为什么需要这几列（此前**无处可存**）：
--
--   * upload —— 网页上传 / WebDAV：只知道有人传了，不知道从哪来、凭什么可以放
--   * url    —— 从网址导入：必须记下原始 URL，否则事后无法回溯「这本书哪来的」
--   * opds   —— 从 OPDS 源同步：去重键是 (源 id, 源内条目 id)，不能只靠 leaf_name
--   * seed   —— 公版种子库：必须记授权依据（作者卒年 + 50 年），否则无法自证
--
-- 这一列组是「公共书库」的前提而不是锦上添花：定位是**公开可浏览、朋友可上传**
-- （见可行性报告 §5.1），一旦有批量导入通道，就必须能回答「这本书凭什么在这儿」。
-- 现有结构答不出来 —— 所以先加列，再谈通道。
--
-- ⚠️ 全部可空，且**不回填**：
--   · 迁移前的存量书无法区分「用户上传」与「自己扫描」，任何猜测性回填都是
--     在伪造来源记录 —— 比留空更坏（留空诚实，回填会让审计看到假的证据）。
--   · license_basis 的取值是闭集：public-domain / authorized / user-declared / unknown。
--     不加 CHECK 约束：SQLite 的 ALTER TABLE ADD COLUMN 带 CHECK 会拒绝存量行，
--     而存量行本来就该是 NULL。取值校验放在写入侧（src/lib/ingest.ts）。

ALTER TABLE books ADD COLUMN source_kind    TEXT;  -- upload|url|opds|seed|dav
ALTER TABLE books ADD COLUMN source_url     TEXT;  -- 原始地址（上传为空）
ALTER TABLE books ADD COLUMN license_basis  TEXT;  -- public-domain|authorized|user-declared|unknown
ALTER TABLE books ADD COLUMN ingested_by    TEXT;  -- 邀请码/管理员标识（不是账号体系）
ALTER TABLE books ADD COLUMN source_id      TEXT;  -- 远程源 id（B/C 路线）
ALTER TABLE books ADD COLUMN source_entry   TEXT;  -- 源内条目 id（去重键的一半）

-- 同步去重：同一源同一条目只入库一次。
-- 注意 SQLite 的唯一索引对 NULL 不生效 —— 这正是想要的：本地上传（source_id 为 NULL）
-- 不受「同源唯一」约束，同名冲突仍由 leaf_name 的唯一索引兜底。
CREATE UNIQUE INDEX IF NOT EXISTS idx_books_source
  ON books(source_id, source_entry);

-- 管理后台按「隔离区 + 类型」筛选（导入先进 inbox，人放行后才上架）
CREATE INDEX IF NOT EXISTS idx_books_status_kind
  ON books(status, kind_bucket);
