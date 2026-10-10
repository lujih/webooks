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
 *   · 锁继承：Depth:1/infinity 的目录锁覆盖其子资源（祖先目录前缀匹配），
 *     但根锁 `/` 的 Infinity 语义是「锁整个库」—— 对公共库这是可用性陷阱，
 *     故根锁只做精确匹配（不覆盖子资源），除非显式 Depth:1。
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

  // 冲突判定：资源 r 被锁（自身或祖先目录锁）且类型不兼容 → 冲突
  const blocking = await liveLockForResource(db, opts.resource);
  if (blocking) {
    const err = new Error('LOCK_CONFLICT') as Error & { lockConflict: boolean; liveToken?: string };
    err.lockConflict = true;
    err.liveToken = blocking.token;
    throw err;
  }

  const token = newLockToken();
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

/**
 * 取当前所有未过期活锁（PROPFIND 注入 lockdiscovery 用）。
 *
 * 为什么不用 IN 列表逐路径查：
 *   · D1/SQLite 对单条 prepare 的绑定参数数有上限（本地 workerd 默认 999），
 *     一个 200 条目目录 + expires_at 就 201 参数，接近上限，放宽条目后必炸
 *   · 活锁数量远小于条目数（挂载瞬间才建，TTL 300s），全量读一把最安全
 *
 * 调用方拿到 Map<resource, LockRow> 后，按「路径自身或任意祖先目录」匹配
 * 到具体条目（见 liveLockForResource 的 SQL 语义）。
 */
export async function allLiveLocks(db: D1Database): Promise<Map<string, LockRow>> {
  const out = new Map<string, LockRow>();
  const { results } = await db
    .prepare(`SELECT * FROM locks WHERE expires_at > ?`)
    .bind(nowIso())
    .all<Record<string, unknown>>();
  for (const row of results ?? []) {
    out.set(row.resource as string, {
      token: row.token as string,
      resource: row.resource as string,
      owner: (row.owner as string | null) ?? null,
      type: row.type as 'exclusive' | 'shared',
      depth: row.depth as string,
      timeoutSec: row.timeout_sec as number,
      createdAt: row.created_at as string,
      expiresAt: row.expires_at as string,
    });
  }
  return out;
}

/**
 * 给定一组条目路径，返回每个路径上「自身或祖先目录」的活锁。
 * 在 allLiveLocks 的结果上做内存前缀匹配（O(条目 × 锁数)，两者都小）。
 */
export function matchLocksToPaths(
  locks: Map<string, LockRow>,
  paths: string[],
): Map<string, LockRow> {
  const out = new Map<string, LockRow>();
  if (locks.size === 0) return out;
  for (const p of paths) {
    // 命中：锁 resource === p（自身）或锁 resource 是 p 的祖先目录（带尾斜杠前缀）
    let hit: LockRow | undefined;
    for (const lock of locks.values()) {
      const r = lock.resource;
      // 精确匹配自身；或目录锁（尾斜杠、非根）的前缀匹配
      const isAncestor = r !== '/' && r.endsWith('/') && p.startsWith(r);
      if (r === p || isAncestor) {
        if (!hit || lock.expiresAt > hit.expiresAt) hit = lock;
      }
    }
    if (hit) out.set(p, hit);
  }
  return out;
}

/**
 * Depth:1 集合锁的继承判定：资源 r 是否被「r 自身或任意祖先目录」上的活锁覆盖。
 *
 * 可用性问题（已踩过）：根锁 `/`（Depth:infinity）会前缀匹配整个库，
 * 任意客户端对根加个锁就锁死全站上传。故：
 *   · 根锁 `/` 仅精确匹配根本身，不覆盖子资源
 *   · 目录锁（尾斜杠路径）按前缀覆盖其子树（Depth:1 语义）
 */
export async function liveLockForResource(
  db: D1Database,
  resource: string,
): Promise<LockRow | null> {
  const now = nowIso();
  const row = await db
    .prepare(
      `SELECT * FROM locks
        WHERE (
             resource = ?
             OR (? LIKE resource || '%' AND resource != '/' AND resource LIKE '%/')
        )
        AND expires_at > ?
        ORDER BY (CASE WHEN resource = ? THEN 0 ELSE 1 END) ASC, expires_at DESC
        LIMIT 1`,
    )
    .bind(resource, resource, now, resource)
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
  const scope = lock.type === 'shared' ? 'shared' : 'exclusive';
  const lockType = lock.type === 'shared' ? 'read' : 'write';
  const depth = lock.depth === '1' || lock.depth === '0' ? lock.depth : 'infinity';
  return (
    `<D:lockdiscovery><D:lock>` +
    `<D:lockscope><D:${scope}/></D:lockscope>` +
    `<D:locktype><D:${lockType}/></D:locktype>` +
    `<D:depth>${depth}</D:depth>` +
    `<D:timeout>Second-${lock.timeoutSec}</D:timeout>` +
    `<D:locktoken><D:locktoken><D:href>${escapeOwner(lock.token)}</D:href></D:locktoken>` +
    ownerXml +
    `</D:lock></D:lockdiscovery>`
  );
}

function escapeOwner(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
