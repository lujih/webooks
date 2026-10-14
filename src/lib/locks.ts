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

// §14.12：lockroot 里的 href 要做百分号编码 —— §8.3 要求同一份响应里所有
// href 用同一种格式，而 <D:response><D:href> 是编码过的；中文文件名不编码
// 会让严格解析器读到前后不一致的格式。
import { encodeHref } from './xml';

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

/**
 * 解析 `Timeout` 请求头。
 *
 * RFC 4918 §10.7 的 BNF：
 *   TimeType = ("Second-" DAVTimeOutVal | "Infinite")
 *   DAVTimeOutVal = 1*DIGIT
 * 也就是说真实写法是 **`Second-300`**，不是 `Second-N=300`。
 *
 * 历史事故：这里曾经写 `/Second-N=(\d+)/`（把 BNF 里的 `N` 当成了字面量），
 * 于是**任何客户端指定的超时都被静默忽略**，一律退回 300 秒默认值。
 * 客户端要 `Second-604800`（一周）也只拿到 300 秒 —— 大文件同步到一半锁就过期。
 *
 * 同时兼容逗号分隔的候选列表（`Infinite, Second-4100000000`），按 RFC 取第一个
 * 服务端能接受的。
 */
export function parseTimeoutHeader(value: string | null): number {
  if (!value) return DEFAULT_LOCK_SECONDS;
  // 可能是逗号分隔的候选列表，逐个尝试
  for (const raw of value.split(',')) {
    const part = raw.trim();
    if (!part) continue;
    if (/^infinite$/i.test(part)) return INFINITE_LOCK_SECONDS;
    const m = part.match(/^Second-(\d+)$/i);
    if (m) {
      const n = Number(m[1]);
      if (!Number.isFinite(n) || n <= 0) continue;
      return Math.min(n, MAX_LOCK_SECONDS);
    }
  }
  return DEFAULT_LOCK_SECONDS;
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
 * 清扫已过期的锁。
 *
 * 为什么必须做：过期的锁虽然不再生效（所有查询都带 expires_at > now），
 * 但行会永久留在表里。匿名开放的 LOCK 端点意味着任何人都能不断建锁，
 * 表会无声膨胀直到 D1 配额被吃满。
 *
 * 在每次 LOCK 时顺带清理（LOCK 频率极低，多一条 DELETE 可忽略），
 * 而不是定时任务 —— 免费层没有 Cron 绑定时也能生效。
 */
export async function sweepExpiredLocks(db: D1Database): Promise<number> {
  const res = await db.prepare(`DELETE FROM locks WHERE expires_at <= ?`).bind(nowIso()).run();
  return res.meta?.changes ?? 0;
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

/**
 * 把锁渲染成 RFC 4918 §14.12 的 lockdiscovery XML 片段。
 *
 * 历史事故（必须记住）：
 *   1. 这里曾经写成 `<D:locktoken><D:locktoken><D:href>…` —— 标签开了两次只关一次，
 *      产出的**不是合法 XML**。.NET 的原话：
 *      "The 'D:locktoken' start tag does not match the end tag of 'D:lock'"。
 *      所有严格客户端在 LOCK 时都会解析失败。
 *   2. 而当时的测试只做 `expect(xml).toContain(...)` 字符串匹配，一路绿灯。
 *   现在由 test/xml-wellformed.test.ts 用严格检查器兜底。
 *
 * 关于 token 要不要转义（这里很容易改错，两个方向都试过）：
 *   锁令牌是 `<urn:uuid:…>`，**本身含尖括号**。
 *   · 不转义 → 正文里出现 `<D:href><urn:uuid:…></D:href>`，
 *     XML 解析器会把 `<urn:uuid:…>` 当成标签 → 依然不是合法 XML（实测过）。
 *   · 转义 → 解析器读出来的文本值恰好就是 `<urn:uuid:…>`，
 *     正是 §14.14 要求的「单个锁令牌 URI」。
 *   所以**必须转义**：转义是 XML 文本层的表示问题，与「值是什么」无关。
 *   客户端解析后拿到的仍是裸 URI，与 Lock-Token 响应头里的一致。
 *
 * ⚠️ 第三处历史事故：元素名与子元素顺序都写错了。
 *   原实现输出 `<D:lockdiscovery><D:lock>…`，而 RFC 4918 的 DTD 是：
 *
 *     <!ELEMENT lockdiscovery (activelock)* >                        (§15.7)
 *     <!ELEMENT activelock (lockscope, locktype, depth, owner?,
 *                            timeout?, locktoken?, lockroot)>       (§14.1)
 *
 *   两处错：① 元素名应是 `activelock`，不是 `lock`
 *          ② 顺序必须是 owner → timeout → locktoken → lockroot，
 *             原实现把 `timeout` 排在 `locktoken` 之后，违反 DTD 的序列约束
 *
 *   为什么 253 个测试全绿却没拦住：xml-wellformed.test.ts 只验**良构性**
 *   （标签配对），而 `<D:lock>…</D:lock>` 恰恰是良构的；断言也只是
 *   `toContain('<D:lock>')` 这种字符串匹配。严格客户端（.NET XmlDocument、
 *   SabreDAV、davfs2）按 `activelock` 取锁，结果**一把都读不到** ——
 *   锁功能形同虚设，而测试全绿。
 *
 *   现在由 test/lock-xml.test.ts 按上面两条 DTD 逐条校验。
 */
export function lockDiscoveryXml(lock: LockRow, requestHref: string): string {
  const ownerXml = lock.owner ? `<D:owner>${escapeOwner(lock.owner)}</D:owner>` : '';
  const scope = lock.type === 'shared' ? 'shared' : 'exclusive';
  const depth = lock.depth === '1' || lock.depth === '0' ? lock.depth : 'infinity';
  // ⚠️ locktype 只能是 write —— RFC 4918 §14.15 的 DTD 是
  //    `<!ELEMENT locktype (write) >`，**根本没有 read 锁**。
  //    原实现给 shared 锁输出 `<D:locktype><D:read/>`，等于宣告了一个
  //    本项目不实现的锁类型：客户端按它建立读锁，服务端却只认写锁语义。
  //    shared / exclusive 的区别在 lockscope，不在 locktype。
  return (
    `<D:lockdiscovery><D:activelock>` +
    `<D:lockscope><D:${scope}/></D:lockscope>` +
    `<D:locktype><D:write/></D:locktype>` +
    `<D:depth>${depth}</D:depth>` +
    ownerXml +
    // ⚠️ timeout 必须在 locktoken 之前（DTD 的 sequence 约束）
    `<D:timeout>Second-${lock.timeoutSec}</D:timeout>` +
    // token 含 <>，必须做 XML 转义，否则不是良构 XML
    `<D:locktoken><D:href>${escapeOwner(lock.token)}</D:href></D:locktoken>` +
    // §14.12：lockroot 给出被锁资源 URL（SHOULD）
    // href 要做百分号编码：§8.3 要求响应里每个 href 用同一种格式，
    // 而同一份响应的 <D:response><D:href> 是编码过的。
    `<D:lockroot><D:href>${escapeOwner(encodeHref(requestHref))}</D:href></D:lockroot>` +
    `</D:activelock></D:lockdiscovery>`
  );
}

function escapeOwner(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
