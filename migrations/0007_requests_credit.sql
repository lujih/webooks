-- webooks migration 0007：求书 + 上传留名
--
-- 两个功能共用一个迁移，因为它们都只是**加列 / 加表**，
-- 彼此没有依赖关系（放一起是为了少一次 D1 往返）。

-- ═══════════════════════════════════════════════════════════════════════
-- 1) 上传留名（credit）
-- ═══════════════════════════════════════════════════════════════════════
--
-- 「上传时可以留个名（留空统一显示雷锋）」。
--
-- 为什么存这一列而不是只在 UI 层拼：
--   · 留名需要能追溯到具体一本书（覆盖上传不该抹掉原上传者）
--   · /admin 的「上传者榜单」要按名字聚合，必须有可 GROUP BY 的列
--
-- ⚠️ 隐私提醒（这是一个**公开**书库）：
--   留名会显示在书卡片上，等于公开署名。所以：
--   · 长度硬限制 32 字符（防止刷超长字符串撑爆列表页）
--   · 只存纯文本，渲染时转义（HTML 由 browse-page 的 esc() 兜底）
--   · 不做用户账号 —— 留名只是署名，不是身份，出事无法追责，
--     这是产品层面刻意接受的取舍（见 README「合规」）

ALTER TABLE books ADD COLUMN credit TEXT;

-- 上传者榜单要按 credit 聚合，走索引避免全表扫描
CREATE INDEX IF NOT EXISTS idx_books_credit ON books(credit, id);

-- 回填：存量书都是「之前传的」，统一算作匿名
UPDATE books SET credit = '雷锋' WHERE credit IS NULL;

-- ═══════════════════════════════════════════════════════════════════════
-- 2) 求书（requests）
-- ═══════════════════════════════════════════════════════════════════════
--
-- 「提交求书 → 公开求书墙 → 有人上传了就在后台标记已收录」
--
-- 设计取舍：
--
-- **为什么用「书名 + 作者」双键去重**
--   同一本书可以由多人求（表示需求强度），但同名不同作者必须分开
--   （《活着》是余华还是老舍的？是两本不同的书）。所以主键是两列的组合。
--
-- **为什么 anon_key 而不是做账号体系**
--   公共书库不注册。但匿名提交会让「同一人反复刷」变得毫无成本，
--   所以用一个**不可逆的哈希**做同一人的标识：
--     sha256(规范化书名 + 规范化作者 + 每小时轮换的盐 + IP 粗粒度)
--   它只能防止「同一人同一天重复刷」，不能防有心的攻击者
--   （换 IP 即可）。这是节流性质的减速带，不是身份认证 —— 与
--   lib/throttle.ts 的定位一致，不要把它当强保证。
--
-- **为什么「已被收录」由管理员手动标记**
--   自动匹配看似聪明，实际很不可靠：
--     · 《活着》可能以「活着-余华.epub」「余华-活着.epub」等各种命名入库
--     · 用户求的可能是「未出版」「绝版」「英文版」
--   猜错的代价（把已收录的书继续挂在求书墙上）远大于漏判的代价，
--   与项目「判不出就返回 null，宁缺毋滥」的哲学一致。

CREATE TABLE IF NOT EXISTS requests (
  id            TEXT PRIMARY KEY,        -- shortId(8)
  -- 归一化后的双键：用于去重与查询（trim + 小写 + 全角转半角）
  title_key     TEXT NOT NULL,
  author_key    TEXT NOT NULL,           -- 无作者时用空串 ''
  -- 原始输入：展示用，保留用户怎么打的
  title         TEXT NOT NULL,
  author        TEXT,
  -- 多少人求过（同一 anon_key 只计一次）
  hits          INTEGER NOT NULL DEFAULT 1,
  first_at      TEXT NOT NULL,
  last_at       TEXT NOT NULL,
  -- 'open' 待收录 | 'fulfilled' 已收录 | 'ignored' 已忽略（不再展示）
  status        TEXT NOT NULL DEFAULT 'open',
  -- 管理员标记时关联到具体书籍（可选）
  fulfilled_book_id TEXT,
  note          TEXT,                    -- 管理员备注：为什么忽略 / 从哪弄到的
  -- 防刷：同一人同一本书只计一次命中
  anon_keys     TEXT NOT NULL DEFAULT '' -- 逗号分隔的哈希集合
);

-- 去重的核心索引：书名 + 作者 双键
CREATE UNIQUE INDEX IF NOT EXISTS idx_requests_key
  ON requests(title_key, author_key);

-- 求书墙列表：按需求强度（hits）排序，状态过滤
CREATE INDEX IF NOT EXISTS idx_requests_wall
  ON requests(status, hits DESC, last_at DESC);

-- 后台按时间查最近提交
CREATE INDEX IF NOT EXISTS idx_requests_recent
  ON requests(last_at DESC);