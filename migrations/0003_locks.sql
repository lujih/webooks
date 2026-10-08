-- webooks migration 0003：WebDAV Class 2 锁
--
-- 为什么需要：OpenList / 绝大多数「完整」WebDAV 客户端（RaiDrive、Cyberduck、
-- rclone 挂载、iOS Files、Android 文件管理器）挂载时首先发 LOCK 建立写锁。
-- 我们之前宣告 DAV: 1,3（无锁）返回 501，导致这些客户端判定「协议不完整」
-- 直接拒绝挂载。这是"能连 OpenList 却连不上我们"的最常见根因。
--
-- 锁模型（刻意做小）：
--   · 锁挂在「资源路径」上（虚拟目录 + 叶子），而非真实对象
--   · 仅区分 exclusive（读写锁）与 shared（读锁）
--   · 默认 300s 超时（Timeout 头可改），Infinity 表示 1 小时（规范上限）
--   · 锁存在 D1，写频率极低（挂载瞬间 1 次 + 刷新），扫描行数 = 1
CREATE TABLE IF NOT EXISTS locks (
  token      TEXT PRIMARY KEY,             -- <urn:uuid:...>
  resource   TEXT NOT NULL,                 -- /dav/... 规范路径
  owner      TEXT,                          -- DAV:owner 属性（可选）
  type       TEXT NOT NULL,                -- 'exclusive' | 'shared'
  depth     TEXT NOT NULL,                 -- '0' | '1' | 'infinity'
  timeout_sec INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_locks_resource ON locks(resource, expires_at);
