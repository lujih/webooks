/**
 * 条件请求求值（RFC 9110 §13）。
 *
 * 为什么这不是「合规洁癖」而是正确性问题：
 * 同步客户端（rclone / rsync 类 / Zotero / Calibre）上传前会先 HEAD 拿 ETag，
 * 再带 `If-Match: "<etag>"` 或 `If-None-Match: *` 发 PUT，目的是**避免误覆盖**。
 * 服务器不校验这些头就会直接覆盖 —— 对一个「所有人可上传」的公共书库，
 * 这意味着并发上传下可以静默覆盖别人的书，且双方都不知情。
 *
 * ── 本文件覆盖的范围（2026-10-20 重写，task-1）────────────────────────
 *
 *   §13.1.1 If-Match            → **强比较**（§8.8.3.2），失败 412
 *   §13.1.2 If-None-Match       → **弱比较**，失败：GET/HEAD 回 304，其他方法 412
 *   §13.1.3 If-Modified-Since   → 仅 GET/HEAD 且 If-None-Match 缺失时评估，失败 304
 *   §13.1.4 If-Unmodified-Since → 仅 If-Match 缺失时评估，失败 412
 *   §13.2.2                     → 严格按步 1→2→3→4 求值，前者失败即短路
 *
 * 重写前有三个**已经踩实的坑**（不是推测，见 docs/webdav-rfc-audit-2026-10-14.md
 * 的 🟠-2 / 🟠-3）：
 *
 *   1. `parseTagList()` 统一剥掉 `W/` 前缀。这对 If-None-Match（弱比较）正确，
 *      但 If-Match 与它共用同一条解析路径，于是 `If-Match: W/"x"` 会匹配强
 *      ETag `"x"` —— 实测回 204，而 §13.1.1 要求 **MUST use the strong
 *      comparison function**，正确结果应为 412。根因是「比较函数」被写进了
 *      「解析」里：解析只该拆语法，强弱是求值时的选择。
 *
 *   2. If-Unmodified-Since / If-Modified-Since 完全没参与求值；
 *      `isModifiedSince()` 是个**从未被调用**的死函数（注释还写着「暂未启用」）。
 *      同步客户端拿不到 ETag 时（老书、COPY 出来的目标行 etag 可能为 NULL）
 *      只能靠日期验证器，这条路径原本等于不存在。
 *
 *   2b. 反向的坑：一旦补上日期条件，就必须实现 §13.2.2 的**短路**语义 ——
 *      If-Match 存在且失败时**不得**再评估 If-Unmodified-Since（步 1 失败直接
 *      412；步 2 的前提是「If-Match 不存在」）。否则两条失败原因会互相掩盖，
 *      排障时看到的是 IUS 的日期，而真正的根因是 ETag 过期。
 *
 *   3. 原返回值只有 `{ok:false}`，无法表达 304。§13.2.2 步 3 明确要求
 *      「if false for GET/HEAD, respond 304; if false for other methods,
 *      respond 412」—— 同一个 If-None-Match 命中，GET 必须 304、PUT 必须 412。
 *      于是本文件现在返回 `status: 412 | 304`。
 *
 * ── 刻意**未实现**的边界（写在这里，避免文档里出现假声明）────────────
 *
 *   · §13.2.2 步 5：Range + If-Range。GET leaf 是 302 到 R2 直链，字节完全不
 *     经过 Worker（见 src/webdav/index.ts handleGet 的注释），Range/If-Range
 *     由 R2 自定义域终结。Worker 侧不做范围求值，也不假装做了。
 *   · GET leaf 的 304：同上。而且在 302 上判 304 反而违反 §13.2.1 ——
 *     「A server MUST ignore all received preconditions if its response to the
 *     same request without those conditions … would have been a status code
 *     other than a 2xx or 412」：302 不是 2xx，所以对 GET leaf **忽略**预条件
 *     才是规范要求的动作，不是漏做。
 *   · 目录（root/nav/list）GET/HEAD 的 304：目录 HTML 是 D1 派生的视图，
 *     没有可比的 Last-Modified；PROPFIND 的 collectionEtag() 只存在于 207 渲染
 *     路径，且对 root/nav 会退化成 1970 合成时间（见 propfind.ts）。没有可靠
 *     验证器就**不伪造**，见 handleGet 的注释。
 *   · 多值/带 `*` 混合的非法字段值（`If-Match: *, "x"`）：语法上不允许生成
 *     （§13.1.1 末尾），这里按「`*` 只在整个值就是 `*` 时生效，列表里的 `*`
 *     当作无法命中的垃圾丢弃」处理，不猜客户端意图。
 */

export type PreconditionFailureStatus = 412 | 304;

export type ConditionResult =
  /** 可以继续处理请求 */
  | { ok: true }
  /**
   * 条件不满足。`status` 由 §13.2.2 决定：
   *   · 412 Precondition Failed —— If-Match / If-Unmodified-Since 失败，
   *     以及**非** GET/HEAD 方法上的 If-None-Match 失败（§13.2.2 步 3）
   *   · 304 Not Modified —— GET/HEAD 上的 If-None-Match / If-Modified-Since 失败
   */
  | { ok: false; status: PreconditionFailureStatus; reason: string };

/**
 * 当前「选中的表示」的验证器。
 *
 * ⚠️ 为什么 `exists` 与 `etag` 必须分开，不能像旧代码那样用
 *    `etag === null` 兼任「资源不存在」：
 *    旧实现把 `currentEtag = existing?.etag ? ... : null` 传进来，于是
 *    **D1 里 etag 为 NULL 的存量行**（迁移前写入、或 COPY 过来目标行 etag
 *    为 NULL）会被当成「不存在」。后果是双向错：
 *      · `If-Match: *` 明明资源在，却被判 412（本该放行）；
 *      · `If-None-Match: *` 本该 412（防误覆盖），却被放行 —— 而且
 *        handlePut 里 `onlyIfAbsent` 会因此**跳过写口令**，等于零凭据覆盖。
 *    这行注释对应的是「`*` 的语义只取决于存在性」（§13.1.1 步骤 1、
 *    §13.1.2 步骤 1），与 ETag 是否存在无关。
 */
export interface CurrentRepresentation {
  /** 是否**有**当前表示（WebDAV 资源是否存在） */
  exists: boolean;
  /**
   * 当前表示的**强 ETag**（含引号，例：`"9dd4e4…"`）；null = 服务端没有可用
   * 实体标签。若这里给的是 `W/"x"`，强比较一律不成立（§8.8.3.2）。
   */
  etag: string | null;
  /**
   * Last-Modified 的来源（ISO 字符串或 Date）；null/缺省 = 该资源没有可用的
   * 修改时间，此时日期条件按 §13.1.3 / §13.1.4 的「MUST ignore」处理。
   */
  lastModified?: string | Date | null;
}

export interface PreconditionCheck {
  /** HTTP 方法（大小写不敏感）。GET/HEAD 与非 GET/HEAD 的失败状态码不同 */
  method: string;
  headers: Headers;
  current: CurrentRepresentation;
}

type ComparisonMode = 'strong' | 'weak';

/** 解析后的实体标签。`opaque` 含引号本体（`"abc"`），比较时逐字符比它 */
interface EntityTag {
  weak: boolean;
  opaque: string;
}

/** entity-tag 的 opaque-tag：DQUOTE 之间不允许再出现 DQUOTE（RFC 9110 §8.8.3） */
const OPAQUE_TAG = /^"[^"]*"$/;

/**
 * 解析 `If-Match` / `If-None-Match` 的值：可能是 `*`，也可能是一个/多个 ETag。
 *
 * @param mode 该字段要求的比较函数。**解析必须感知它**，否则就会重演
 *   「If-Match 也被剥掉 `W/`」那个 bug：
 *   · `'strong'`（If-Match）：保留 weak 标记，交给 strongEqual() 拒绝；
 *   · `'weak'`（If-None-Match）：weak 标记无意义，归一到 false（弱比较只看
 *     opaque-tag，见 §8.8.3.2 的表 3：`W/"1"` vs `"1"` 弱比较为 match）。
 *
 * 容错：不合语法的成员（`garbage`、空串、列表里混进来的 `*`）一律**丢弃**。
 * 丢弃 = 永不命中，方向是保守的（If-Match 因而不成立 → 412），不会误放行。
 */
function parseTagList(header: string, mode: ComparisonMode): { star: boolean; tags: EntityTag[] } {
  const raw = header.trim();
  if (raw === '*') return { star: true, tags: [] };
  const tags: EntityTag[] = [];
  for (const part of raw.split(',')) {
    const t = part.trim();
    if (!t) continue;
    const weakRaw = t.startsWith('W/');
    const opaque = (weakRaw ? t.slice(2) : t).trim();
    if (!OPAQUE_TAG.test(opaque)) continue;
    tags.push({ weak: mode === 'weak' ? false : weakRaw, opaque });
  }
  return { star: false, tags };
}

/** 解析「当前表示的 ETag」；给不出合法实体标签就返回 null */
function parseEntityTag(value: string | null): EntityTag | null {
  if (value === null) return null;
  const t = value.trim();
  if (!t) return null;
  const weak = t.startsWith('W/');
  const opaque = (weak ? t.slice(2) : t).trim();
  if (!OPAQUE_TAG.test(opaque)) return null;
  return { weak, opaque };
}

/**
 * 强比较（§8.8.3.2）：两者都**不是**弱标签，且 opaque-tag 逐字符相同。
 * 注意 `W/"1"` vs `"1"` 在强比较下是 **no match** —— 这正是 🟠-2 要修的点。
 */
function strongEqual(a: EntityTag, b: EntityTag): boolean {
  return !a.weak && !b.weak && a.opaque === b.opaque;
}

/** 弱比较（§8.8.3.2）：忽略双方的 weak 标记，只比 opaque-tag */
function weakEqual(a: EntityTag, b: EntityTag): boolean {
  return a.opaque === b.opaque;
}

/**
 * HTTP-date 的三种合法写法（RFC 9110 §5.6.7）：
 *   IMF-fixdate  `Sun, 06 Nov 1994 08:49:37 GMT`      ← 服务端 SHOULD 生成这种
 *   RFC 850      `Sunday, 06-Nov-94 08:49:37 GMT`      ← 必须接受
 *   asctime      `Sun Nov  6 08:49:37 1994`            ← 必须接受
 */
const IMF_FIXDATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;
const RFC850_DATE = /^[A-Z][a-z]+, \d{2}-[A-Z][a-z]{2}-\d{2} \d{2}:\d{2}:\d{2} GMT$/;
const ASCTIME_DATE = /^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/;

/**
 * 解析 HTTP-date；非法值、多值、非 HTTP-date 写法一律返回 null。
 *
 * ⚠️ 为什么必须自己写正则而不是直接 `Date.parse()`：
 *    Date.parse 极其宽松 —— 实测（workerd / Node 同一引擎族）：
 *      `Date.parse('1')`           → 2000-12-31T16:00:00Z
 *      `Date.parse('2026')`        → 2026-01-01T00:00:00Z
 *      `Date.parse('2026-10-20')`  → 2026-10-20T00:00:00Z
 *    而 §13.1.3 / §13.1.4 都写着「MUST ignore … if the field value is not a
 *    valid HTTP-date」。若把 `'1'` 解析成 2000 年，一个垃圾头就会让
 *    If-Unmodified-Since 判定「资源在 2000 年之后改过」→ 无条件 412，
 *    同步客户端会陷入「永远传不上去」且报错完全看不懂。
 *    多值（`d1, d2`）同样要拒：Date.parse 给 NaN 是运气，不是契约。
 *
 * ⚠️ **返回整秒，不是毫秒** —— 这是踩出来的第二大坑：
 *    本函数原本返回 `Date.parse()` 的毫秒，而 `toEpochSeconds()` 返回**秒**。
 *    两个数字直接拿来比，等于把「秒」当「毫秒」看：
 *      · IUS（`last > since`）里 since 大了 1000 倍 → 永远成立 → 每次 PUT
 *        带 IUS 都被 412，同步客户端彻底传不上书；
 *      · IMS（`last <= since`）里 since 同样大 1000 倍 → 永远成立 → 每次都
 *        回 304，客户端永远拿到空内容。
 *    两个方向的后果都很糟，而且单测如果只用「同一形态的常量」比较，
 *    很容易写出看起来对、其实假绿的断言。所以：**本文件所有 epoch
 *    一律是整秒**，跨函数传递前先想清楚单位。
 */
function parseHttpDate(value: string | null): number | null {
  if (value === null) return null;
  const raw = value.trim();
  if (!IMF_FIXDATE.test(raw) && !RFC850_DATE.test(raw) && !ASCTIME_DATE.test(raw)) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/**
 * 把「最后修改时间」归一成**整秒**的 epoch。
 *
 * ⚠️ 这一行是 304 能不能真的发生的分水岭，踩过才知道：
 *   `books.updated_at` 存的是 `new Date().toISOString()`，带毫秒
 *   （`2026-01-01T00:00:00.500Z`）；而 HEAD/PROPFIND 回给客户端的
 *   Last-Modified 是 RFC 1123 / `toUTCString()` 形态，**只有秒**。
 *   客户端原样回送这个日期后，如果拿带毫秒的源值去比，`last > since`
 *   永远成立 → If-Modified-Since 永远判「已修改」→ 304 永远不出现，
 *   而且测试会假绿（比较逻辑「看起来对」）。所以双方都必须截断到秒再比。
 */
function toEpochSeconds(value: string | Date): number | null {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

function failure(status: PreconditionFailureStatus, reason: string): ConditionResult {
  return { ok: false, status, reason };
}

/**
 * 按 RFC 9110 §13.2.2 的顺序求值请求预条件。
 *
 * 步 1  If-Match 存在            → 强比较；失败 412，**短路**（不再看 IUS）
 * 步 2  If-Match 缺失 且 IUS 存在 → last ≤ since 才通过；失败 412
 * 步 3  If-None-Match 存在        → 弱比较；失败：GET/HEAD 304，其他方法 412
 * 步 4  GET/HEAD 且 INM 缺失 且 IMS 存在 → last ≤ since 时 304（未修改）
 * 步 5  Range + If-Range：**未实现**，见文件头
 * 步 6  执行方法
 *
 * 调用方注意（§13.2.1）：本函数必须在**常规检查之后、方法体之前**调用。
 * 也就是说 404 / 401 / 405 / 403 等判定要先做 —— 「同样的请求去掉条件头
 * 就不会是 2xx」时，规范要求忽略预条件，而不是回 304/412。
 */
export function checkPreconditions(input: PreconditionCheck): ConditionResult {
  const method = input.method.trim().toUpperCase();
  const readMethod = method === 'GET' || method === 'HEAD';
  const { headers, current } = input;

  const ifMatch = headers.get('if-match');
  const ifNoneMatch = headers.get('if-none-match');
  const ifUnmodifiedSince = headers.get('if-unmodified-since');
  const ifModifiedSince = headers.get('if-modified-since');

  const currentTag = parseEntityTag(current.etag);

  // ── 步 1：If-Match（§13.1.1，**强比较**）────────────────────────────
  if (ifMatch !== null) {
    const { star, tags } = parseTagList(ifMatch, 'strong');
    if (star) {
      // `*` 只看「有没有当前表示」，与 ETag 是否为 NULL 无关
      if (!current.exists) {
        return failure(412, 'If-Match: * 要求目标存在，但目标不存在');
      }
    } else {
      if (!current.exists) {
        return failure(412, 'If-Match 指定了条件，但目标不存在');
      }
      // 资源在、但服务端给不出 ETag：任何列出的标签都无法强比较成立。
      // 这是**失败关闭**（fail closed）：宁可 412 也不放行一次可能误覆盖的写。
      if (!currentTag) {
        return failure(
          412,
          'If-Match 列出了实体标签，但服务端对该资源没有可用的 ETag，强比较不可能成立',
        );
      }
      if (!tags.some((t) => strongEqual(t, currentTag))) {
        return failure(412, `If-Match 不匹配（当前 ETag=${current.etag}，强比较）`);
      }
    }
    // 通过 → 直接进步 3：§13.2.2 步 2 的前提是「If-Match 不存在」，
    // 所以 If-Unmodified-Since 在这一支里**必须**被忽略（§13.1.4 也有同款
    // MUST ignore 的要求）。这就是下面的 else-if。
  } else if (ifUnmodifiedSince !== null) {
    // ── 步 2：If-Unmodified-Since（§13.1.4）──────────────────────────
    const since = parseHttpDate(ifUnmodifiedSince);
    const last = current.lastModified == null ? null : toEpochSeconds(current.lastModified);
    // 非法日期 → 忽略；资源没有修改时间 → 忽略（两条都是 MUST ignore）
    if (since !== null && last !== null && last > since) {
      return failure(
        412,
        `If-Unmodified-Since 失败：资源最后修改于 ${new Date(last * 1000).toUTCString()}，`
        + `晚于请求给出的 ${new Date(since * 1000).toUTCString()}`,
      );
    }
  }

  // ── 步 3：If-None-Match（§13.1.2，**弱比较**）──────────────────────
  if (ifNoneMatch !== null) {
    const { star, tags } = parseTagList(ifNoneMatch, 'weak');
    let matched: boolean;
    if (star) {
      // `*` 的语义：资源「存在」就命中（防误覆盖的关键路径）
      matched = current.exists;
    } else {
      // 没有可用 ETag 时，列出的标签不可能命中 → 条件为真（放行）
      matched = currentTag !== null && tags.some((t) => weakEqual(t, currentTag));
    }
    if (matched) {
      const why = star
        ? 'If-None-Match: * 要求目标不存在，但目标已存在'
        : `If-None-Match 命中（当前 ETag=${current.etag}，弱比较）`;
      // ★ §13.2.2 步 3 的核心分歧：同一个命中，GET/HEAD 是 304，其他方法是 412
      return failure(readMethod ? 304 : 412, why);
    }
  } else if (readMethod && ifModifiedSince !== null) {
    // ── 步 4：If-Modified-Since（§13.1.3，仅 GET/HEAD）─────────────
    // 前提由上面的 else 保证：If-None-Match 缺失（§13.1.3 要求它被忽略）。
    const since = parseHttpDate(ifModifiedSince);
    const last = current.lastModified == null ? null : toEpochSeconds(current.lastModified);
    // 条件为 false（未修改）→ 304。last ≤ since 即「不比我手上的新」。
    if (since !== null && last !== null && last <= since) {
      return failure(
        304,
        `If-Modified-Since 未修改：资源最后修改于 ${new Date(last * 1000).toUTCString()}`,
      );
    }
  }

  // ── 步 5 未实现（Range/If-Range，见文件头）；步 6 交给调用方 ────────
  return { ok: true };
}
