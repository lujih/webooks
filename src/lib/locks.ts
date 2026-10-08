/**
 * WebDAV Class 2 锁存储（RFC 4918 §10）。
 *
 * 为什么放 D1 而不是内存 / KV：
 *   · 锁必须有持久化语义，否则 Worker 隔离区重启就丢了
 *   · 锁的写入频率极低（挂载瞬间 1 次 + 周期性刷新），扫描行数可控
 *   · D1 是本项目已绑定的唯一存储层，不引入新资源
 *
 * 简化取舍（对公共书库足够）：
 *   · 不做 If 条件里的 (locktoken) 精确匹配 —— 我们只对「持锁者刷新」放行，
 *     其他写一律 423。真正的「带 If: (<token>) 写他人资源」场景在只读浏览
 *     + 单用户上传的模型里不会出现。
 *   · 不做锁继承（shared 锁挂在集合上覆盖子资源）—— 我们的目录是虚拟视图，
 *     客户端对目录加锁基本是「防并发上传同名文件」，按资源路径精确锁即可。
 */

export interface LockRow {
  token: string;
  resource: string;
  owner: string | null;
  type: 'exclusive' | 'shared';
  depth: string;
  timeoutSec: number;
  createdAt: string;
  expiresAt: string;
}

/** RFC 4918 §10.2.4：Timeout 为 'Infinite' 时按 1 小时处理 */
export const INFINITE_LOCK_SECONDS = 3600;
/** 默认锁超时（客户端没给 Timeout 头时） */
export const DEFAULT_LOCK_SECONDS = 300;
/** Timeout 头的合法上限，超过按 1 小时截断（规范：Infinite 之外的最大值） */
export const MAX_LOCK_SECONDS = INFINITE_LOCK_SECONDS;

function nowIso(): string {
  return new Date().toISOString();
}

function isoPlusSeconds(baseIso: string, seconds: number): string {
  return new Date(Date.parse(baseIso) + seconds * 1000).toISOString();
}

/** 解析 `Timeout: Second-N=300` / `Infinite` / 缺省 */
export function parseTimeoutHeader(value: string | null): number {
  if (!value || value === 'Infinite' || value === 'infinity') return INFINITE_LOCK_SECONDS;
  const m = value.match(/Second-N=(\d+)/i);
  if (!m) return DEFAULT_LOCK_SECONDS;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_LOCK_SECONDS;
  return Math.min(n, MAX_LOCK_SECONDS);
}

/** 生成一个 urn:uuid 格式的锁 token */
export function newLockToken(): string {
  // RFC 4918 §12.1：lock-token 必须 URN，推荐 urn:uuid:<uuid>
  const b = crypto.randomUUID();
  return `<urn:uuid:${b}>`;
}

export async function acquireLock(
  db: D1Database,
  opts: {
    resource: string;
    type: 'exclusive' | 'shared';
    depth: string;
    timeoutSec: number;
    owner?: string | null;
    /** 已有 token（刷新场景）。给了就更新，没给就新建 */
    refreshToken?: string | null;
  },
): Promise<{ lock: LockRow; isRefresh: boolean }> {
  const now = nowIso();
  const expires = isoPlusSeconds(now, opts.timeoutSec);

  // 刷新：资源上已有同 token 的活锁 → 直接更新超时（不重新创建）
  if (opts.refreshToken) {
    const existing = await db
      .prepare(`SELECT token FROM locks WHERE token = ? AND resource = ?`)
      .bind(opts.refreshToken, opts.resource)
      .first<{ token: string }>();
    if (existing) {
      await db
        .prepare(
          `UPDATE locks SET expires_at = ?, timeout_sec = ? WHERE token = ?`,
        )
        .bind(expires, opts.timeoutSec, opts.refreshToken)
        .run();
      return {
        lock: {
          token: opts.refreshToken,
          resource: opts.resource,
          owner: opts.owner ?? null,
          type: opts.type,
          depth: opts.depth,
          timeoutSec: opts.timeoutSec,
          createdAt: now,
          expiresAt: expires,
        },
        isRefresh: true,
      };
    }
  }

  // 冲突判定：资源上存在「过期前的活锁」且类型不兼容
  const live = await db
    .prepare(
      `SELECT token, type FROM locks
        WHERE resource = ? AND expires_at > ?
        AND (
          (? = 'exclusive' AND type = 'exclusive')
          OR (? = 'shared' AND type = 'exclusive')
        )
        LIMIT 1`,
    )
    .bind(opts.resource, now, opts.type, opts.type)
    .first<{ token: string; type: string }>();

  // 共享锁互斥：两个 exclusive 锁、一个 exclusive + 任意 shared 都冲突
  const token = newLockToken();
  if (live) {
    // 抛冲突，让调用方决定 423 / 409
    const err = new Error('LOCK_CONFLICT') as Error & { lockConflict: boolean; liveToken?: string };
    err.lockConflict = true;
    err.liveToken = live.token;
    throw err;
  }

  await db
    .prepare(
      `INSERT INTO locks (token, resource, owner, type, depth, timeout_sec, created_at, expires_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(token) DO UPDATE SET
         resource = excluded.resource,
         owner = excluded.owner,
         type = excluded.type,
         depth = excluded.depth,
         timeout_sec = excluded.timeout_sec,
         expires_at = excluded.expires_at`,
    )
    .bind(
      token,
      opts.resource,
      opts.owner ?? null,
      opts.type,
      opts.depth,
      opts.timeoutSec,
      now,
      expires,
    )
    .run();

  return {
    lock: {
      token,
      resource: opts.resource,
      owner: opts.owner ?? null,
      type: opts.type,
      depth: opts.depth,
      timeoutSec: opts.timeoutSec,
      createdAt: now,
      expiresAt: expires,
    },
    isRefresh: Boolean(opts.refreshToken),
  };
}

export async function releaseLock(db: D1Database, token: string): Promise<void> {
  await db.prepare(`DELETE FROM locks WHERE token = ?`).bind(token).run();
}

export async function liveLockForResource(
  db: D1Database,
  resource: string,
): Promise<LockRow | null> {
  const row = await db
    .prepare(`SELECT * FROM locks WHERE resource = ? AND expires_at > ? ORDER BY expires_at DESC LIMIT 1`)
    .bind(resource, nowIso())
    .first<Record<string, unknown>>();
  if (!row) return null;
  return {
    token: row.token as string,
    resource: row.resource as string,
    owner: (row.owner as string | null) ?? null,
    type: row.type as 'exclusive' | 'shared',
    depth: row.depth as string,
    timeoutSec: row.timeout_sec as number,
    createdAt: row.created_at as string,
    expiresAt: row.expires_at as string,
  };
}

/** 把锁渲染成 DAV 头里要的 lockdiscovery XML 片段 */
export function lockDiscoveryXml(lock: LockRow, requestHref: string): string {
  const ownerXml = lock.owner ? `<D:owner>${escapeOwner(lock.owner)}</D:owner>` : '';
  return (
    `<D:lockdiscovery><D:lock><D:lockscope><D:exclusive/></D:lockscope>` +
    `<D:locktype><D:write/></D:locktype>` +
    `<D:depth>${lock.depth}</D:depth>` +
    `<D:timeout>Second-${lock.timeoutSec}</D:timeout>` +
    `<D:locktoken><D:locktoken-${lock.type}>${lock.token}</D:locktoken-${lock.type}></D:locktoken>` +
    ownerXml +
    `</D:lock></D:lockdiscovery>`
  );
}

function escapeOwner(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
