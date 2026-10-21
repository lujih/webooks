/**
 * 条件请求（RFC 9110 §13）单元测试。
 *
 * 这是防误覆盖的核心逻辑，必须覆盖各种边界：
 * 强弱比较、多值、星号通配、§13.2.2 的**求值顺序与短路**、304/412 的分歧、
 * 以及日期验证器的容错路径。
 *
 * ── 实测计数（2026-10-20，本文件重写时）──────────────────────────────
 *   重写前：1 个 describe / **11** 个用例（全部围绕 ok:boolean，无法表达 304）
 *   重写后：5 个 describe / **36** 个用例（`npx vitest run test/preconditions.test.ts`）
 *   其中原有 11 条的**语义**全部保留（必要时改成断言 status 而非 ok），
 *   新增 25 条覆盖强比较、求值顺序、304/412 分歧、日期容错与秒截断。
 *   ⚠️ 这个数字是**跑出来的**，不是估的；改动后请同步这个注释。
 */

import { describe, expect, it } from 'vitest';
import { checkPreconditions, type CurrentRepresentation } from '../src/lib/preconditions';

const h = (obj: Record<string, string>): Headers => new Headers(obj);

/**
 * 造一个「当前表示」。
 *
 * 默认 `exists` 由 etag 推断，但**允许显式覆盖** —— 这正是本次重写要钉住的
 * 语义：`exists` 与 `etag` 是两个独立事实。「资源在、但服务端没有 ETag」
 * 是真实存在的状态（迁移前写入的存量行 / COPY 出来的目标行 etag 为 NULL），
 * 旧实现用 `etag === null` 兼任「不存在」，于是把这种行当成 404 号资源。
 */
const rep = (
  etag: string | null,
  opts: { exists?: boolean; lastModified?: string | Date | null } = {},
): CurrentRepresentation => ({
  exists: opts.exists ?? etag !== null,
  etag,
  lastModified: opts.lastModified ?? null,
});

/** 缺省表示：资源不存在 */
const MISSING: CurrentRepresentation = { exists: false, etag: null, lastModified: null };

/** 「一定早于任何真实 mtime」的 HTTP-date（1970），用于制造 IUS 失败 */
const PAST_DATE = 'Thu, 01 Jan 1970 00:00:00 GMT';
/** 「晚于任何真实 mtime」的 HTTP-date（2100），用于制造 IMS 命中 / IUS 通过 */
const FUTURE_DATE = 'Sun, 01 Jan 2100 00:00:00 GMT';

const check = (
  method: string,
  headers: Record<string, string>,
  current: CurrentRepresentation = rep('"abc"'),
) => checkPreconditions({ method, headers: h(headers), current });

/** 断言「412 且理由里含某个关键词」——理由文案是排障的第一手信息 */
function expect412(
  result: ReturnType<typeof check>,
  pattern?: RegExp,
): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.status).toBe(412);
  if (pattern) expect(result.reason).toMatch(pattern);
}

function expect304(result: ReturnType<typeof check>, pattern?: RegExp): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.status).toBe(304);
  if (pattern) expect(result.reason).toMatch(pattern);
}

// ── 基础放行 / 通配符 ───────────────────────────────────────────────────

describe('无条件头与通配符', () => {
  it('无条件头时始终放行', () => {
    expect(check('PUT', {}).ok).toBe(true);
    expect(check('PUT', {}, rep('"abc"')).ok).toBe(true);
    expect(check('GET', {}).ok).toBe(true);
  });

  it('If-None-Match: * 在目标不存在时放行、在存在时拒绝（PUT → 412）', () => {
    expect(check('PUT', { 'if-none-match': '*' }, MISSING).ok).toBe(true);
    expect412(check('PUT', { 'if-none-match': '*' }, rep('"abc"')), /已存在/);
  });

  it('If-None-Match: * 是防覆盖的关键路径（理由必须说清「已存在」）', () => {
    const r = check('PUT', { 'if-none-match': '*' }, rep('"exists"'));
    expect412(r, /已存在/);
  });

  it('If-Match: * 在目标存在时放行', () => {
    expect(check('PUT', { 'if-match': '*' }, rep('"abc"')).ok).toBe(true);
  });

  it('If-Match 在目标不存在时拒绝（任何值都拒绝：* 与列表）', () => {
    expect412(check('PUT', { 'if-match': '*' }, MISSING), /不存在/);
    expect412(check('PUT', { 'if-match': '"abc"' }, MISSING), /不存在/);
  });

  it('「资源存在但 etag 为 NULL」时，* 的语义仍按存在性判定（回归：旧实现会当成不存在）', () => {
    // 旧实现 currentEtag = existing?.etag ? ... : null → 这一支被判「不存在」，
    // 于是 If-Match: * 被误拒、If-None-Match: * 被误放行（→ 零凭据覆盖）。
    expect(check('PUT', { 'if-match': '*' }, rep(null, { exists: true })).ok).toBe(true);
    expect412(check('PUT', { 'if-none-match': '*' }, rep(null, { exists: true })), /已存在/);
  });
});

// ── If-Match 强比较（§13.1.1 + §8.8.3.2）──────────────────────────────

describe('If-Match 强比较（RFC 9110 §13.1.1）', () => {
  it('强 ETag 精确匹配 → 通过', () => {
    expect(check('PUT', { 'if-match': '"abc"' }, rep('"abc"')).ok).toBe(true);
    expect412(check('PUT', { 'if-match': '"abc"' }, rep('"xyz"')), /不匹配/);
  });

  it('If-Match 的弱标签 W/"abc" **不得**匹配强 ETag "abc"（🟠-2 的修复点）', () => {
    // 修复前这里回 ok:true（PUT 实测 204），§13.1.1 要求强比较 → 412
    expect412(check('PUT', { 'if-match': 'W/"abc"' }, rep('"abc"')), /强比较/);
  });

  it('当前表示的 ETag 是弱标签时，If-Match 也无法强比较成立', () => {
    // §8.8.3.2 表 3：W/"1" vs "1" 强比较 = no match（双向）
    expect412(check('PUT', { 'if-match': '"abc"' }, rep('W/"abc"')));
    expect412(check('PUT', { 'if-match': 'W/"abc"' }, rep('W/"abc"')));
  });

  it('If-Match 支持多个 ETag，命中任一即放行；混入弱标签只跳过那一个', () => {
    expect(check('PUT', { 'if-match': '"a", "abc", "z"' }, rep('"abc"')).ok).toBe(true);
    expect412(check('PUT', { 'if-match': '"a", "b"' }, rep('"abc"')), /不匹配/);
    // 弱标签在强比较下不成立，但同一列表里的强标签仍可命中
    expect(check('PUT', { 'if-match': 'W/"abc", "abc"' }, rep('"abc"')).ok).toBe(true);
  });

  it('If-Match 列出标签但服务端没有 ETag → 412（失败关闭，绝不放行写）', () => {
    expect412(
      check('PUT', { 'if-match': '"abc"' }, rep(null, { exists: true })),
      /没有可用的 ETag/,
    );
  });

  it('If-Match: * 不看 ETag，只看存在性（ETag 为 NULL 也放行）', () => {
    expect(check('PUT', { 'if-match': '*' }, rep(null, { exists: true })).ok).toBe(true);
  });
});

// ── If-None-Match 弱比较（§13.1.2）────────────────────────────────────

describe('If-None-Match 弱比较（RFC 9110 §13.1.2）', () => {
  it('弱标签 W/"abc" 命中强 ETag "abc" → 条件为假（PUT 412）', () => {
    // ⚠️ 这是**不能回退**的行为：修 If-Match 强比较时如果顺手把
    //    If-None-Match 也改成强比较，这条会立刻变红。
    expect412(check('PUT', { 'if-none-match': 'W/"abc"' }, rep('"abc"')), /弱比较/);
    expect(check('PUT', { 'if-none-match': 'W/"abc"' }, rep('"xyz"')).ok).toBe(true);
  });

  it('当前 ETag 是弱标签时，If-None-Match 强标签同样弱比较命中', () => {
    expect412(check('PUT', { 'if-none-match': '"abc"' }, rep('W/"abc"')));
  });

  it('If-None-Match 显式列出未命中的 ETag 时放行', () => {
    expect(check('PUT', { 'if-none-match': '"other"' }, rep('"abc"')).ok).toBe(true);
  });

  it('If-None-Match 多值：命中任一即条件为假', () => {
    expect412(check('PUT', { 'if-none-match': '"a", W/"abc"' }, rep('"abc"')));
    expect(check('PUT', { 'if-none-match': '"a", "b"' }, rep('"abc"')).ok).toBe(true);
  });

  it('资源存在但无 ETag 时，显式列出的标签无法命中 → 放行（§13.1.2 求值第 3 条）', () => {
    expect(check('PUT', { 'if-none-match': '"abc"' }, rep(null, { exists: true })).ok).toBe(true);
  });

  it('If-Match 与 If-None-Match 同时出现时都要满足', () => {
    expect(check('PUT', { 'if-match': '"abc"', 'if-none-match': '"zzz"' }, rep('"abc"')).ok).toBe(true);
    expect412(check('PUT', { 'if-match': '"nope"', 'if-none-match': '"zzz"' }, rep('"abc"')), /If-Match/);
    expect412(check('PUT', { 'if-match': '"abc"', 'if-none-match': '*' }, rep('"abc"')), /If-None-Match/);
  });

  it('同一个 If-None-Match 命中：GET/HEAD → 304，PUT/DELETE → 412（§13.2.2 步 3）', () => {
    const headers = { 'if-none-match': '"abc"' };
    expect304(check('GET', headers, rep('"abc"')), /命中/);
    expect304(check('HEAD', headers, rep('"abc"')), /命中/);
    expect412(check('PUT', headers, rep('"abc"')));
    expect412(check('DELETE', headers, rep('"abc"')));
  });

  it('If-None-Match: * 命中时 GET/HEAD 也是 304（不是 412）', () => {
    expect304(check('GET', { 'if-none-match': '*' }, rep('"abc"')), /已存在/);
    expect304(check('HEAD', { 'if-none-match': '*' }, rep('"abc"')));
  });
});

// ── §13.2.2 求值顺序与短路 ─────────────────────────────────────────────

describe('§13.2.2 求值顺序与短路', () => {
  // 一个「看起来会通过」的 IUS：未来 100 年，任何真实 mtime 都 ≤ 它。
  const FUTURE = new Date(Date.now() + 100 * 365 * 24 * 3600 * 1000).toUTCString();
  // 一个「一定失败」的 IUS：资源最后修改于 2026，而请求说「不要晚于 1970」
  const PAST = 'Thu, 01 Jan 1970 00:00:00 GMT';
  const MODIFIED_AT = '2026-01-01T00:00:00.000Z';

  it('步 1 失败即短路：If-Match 失败 + IUS 通过 → 仍 412，且理由来自 If-Match', () => {
    const r = check(
      'PUT',
      { 'if-match': '"wrong"', 'if-unmodified-since': FUTURE },
      rep('"abc"', { lastModified: MODIFIED_AT }),
    );
    // 若 IUS 被求值（它会通过），理由里不会出现 If-Match —— 这条断言就是短路证明
    expect412(r, /If-Match/);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).not.toMatch(/If-Unmodified-Since/);
  });

  it('步 2：If-Match 缺失 + IUS 失败 → 412', () => {
    expect412(
      check('PUT', { 'if-unmodified-since': PAST }, rep('"abc"', { lastModified: MODIFIED_AT })),
      /If-Unmodified-Since/,
    );
  });

  it('步 2：If-Match 存在且**通过**时，IUS 必须被忽略（哪怕它本身会失败）', () => {
    // §13.1.4 与 §13.2.2 步 2 都写着「If-Match 存在时忽略 IUS」。
    // IUS 用 1970 这种「必然失败」的值，证明它真的没被评估。
    expect(
      check(
        'PUT',
        { 'if-match': '"abc"', 'if-unmodified-since': PAST },
        rep('"abc"', { lastModified: MODIFIED_AT }),
      ).ok,
    ).toBe(true);
  });

  it('步 2 通过时继续步 3：IUS 通过 + If-None-Match 命中 → 仍 412', () => {
    expect412(
      check(
        'PUT',
        { 'if-unmodified-since': FUTURE, 'if-none-match': '"abc"' },
        rep('"abc"', { lastModified: MODIFIED_AT }),
      ),
      /If-None-Match/,
    );
  });

  it('步 3 存在时步 4 根本不运行：INM 未命中 + IMS 命中 → 200（IMS 被 MUST ignore）', () => {
    // ⚠️ 这条用例原来写反了，值得记一笔：
    //    原标题是「步 3 通过后才轮到步 4」，断言 INM 未命中 + IMS 命中 → 304。
    //    但 RFC 9110 §13.1.3 第一句就是：
    //      "A recipient MUST ignore If-Modified-Since if the request contains
    //       an If-None-Match header field"
    //    §13.2.2 步 4 的前提同样是 "If-None-Match is not present"。
    //    也就是说 IMS 与 INM **不是先后关系，是互斥关系** —— INM 一旦存在，
    //    IMS 连评估的机会都没有。原用例把两者当成串行流水线，于是要求一个
    //    规范明令禁止的 304。
    //
    //    这里改成断言**正确**行为：INM 存在且未命中 → 条件为真 → 200，
    //    IMS 即便「看起来会命中」也必须被忽略。理由文案里不能出现 IMS。
    const AFTER = new Date(Date.parse(MODIFIED_AT) + 60_000).toUTCString();
    const r = check(
      'GET',
      { 'if-none-match': '"other"', 'if-modified-since': AFTER },
      rep('"abc"', { lastModified: MODIFIED_AT }),
    );
    expect(r.ok, 'INM 存在时 IMS 必须被忽略，不该回 304').toBe(true);
  });

  it('INM 缺失时步 4 才生效：GET + IMS 命中 → 304', () => {
    // 与上一条互补：去掉 INM，IMS 才能真的参与求值。
    const AFTER = new Date(Date.parse(MODIFIED_AT) + 60_000).toUTCString();
    expect304(
      check('GET', { 'if-modified-since': AFTER }, rep('"abc"', { lastModified: MODIFIED_AT })),
      /If-Modified-Since/,
    );
  });

  it('步 3 失败时短路，不再评估 IMS（GET 命中 INM → 304 且理由来自 INM）', () => {
    const r = check(
      'GET',
      { 'if-none-match': '"abc"', 'if-modified-since': PAST },
      rep('"abc"', { lastModified: MODIFIED_AT }),
    );
    expect304(r, /If-None-Match/);
    if (!r.ok) expect(r.reason).not.toMatch(/If-Modified-Since/);
  });
});

// ── 日期验证器（§13.1.3 / §13.1.4）─────────────────────────────────────

describe('If-Modified-Since / If-Unmodified-Since 与容错', () => {
  const MODIFIED_AT = '2026-01-01T00:00:00.000Z';
  /** 资源修改时间对应的、客户端会看到的 Last-Modified 形态（精确到秒） */
  const MODIFIED_HTTP = new Date(MODIFIED_AT).toUTCString();
  const BEFORE = new Date(Date.parse(MODIFIED_AT) - 60_000).toUTCString();
  const AFTER = new Date(Date.parse(MODIFIED_AT) + 60_000).toUTCString();

  it('GET + IMS 等于资源时间 → 304（未修改）', () => {
    expect304(
      check('GET', { 'if-modified-since': MODIFIED_HTTP }, rep('"abc"', { lastModified: MODIFIED_AT })),
      /未修改/,
    );
  });

  it('GET + IMS 早于资源时间 → 放行（已修改，需要新表示）', () => {
    expect(
      check('GET', { 'if-modified-since': BEFORE }, rep('"abc"', { lastModified: MODIFIED_AT })).ok,
    ).toBe(true);
  });

  it('HEAD + IMS 等于资源时间 → 304（HEAD 与 GET 同规则）', () => {
    expect304(
      check('HEAD', { 'if-modified-since': MODIFIED_HTTP }, rep('"abc"', { lastModified: MODIFIED_AT })),
    );
  });

  it('PUT + IMS 一律忽略（§13.1.3：方法不是 GET/HEAD 时 MUST ignore）', () => {
    expect(
      check('PUT', { 'if-modified-since': MODIFIED_HTTP }, rep('"abc"', { lastModified: MODIFIED_AT })).ok,
    ).toBe(true);
  });

  it('PUT + IUS 等于资源时间 → 放行（条件为 last ≤ since）', () => {
    expect(
      check('PUT', { 'if-unmodified-since': MODIFIED_HTTP }, rep('"abc"', { lastModified: MODIFIED_AT })).ok,
    ).toBe(true);
  });

  it('PUT + IUS 早于资源时间 → 412', () => {
    expect412(
      check('PUT', { 'if-unmodified-since': BEFORE }, rep('"abc"', { lastModified: MODIFIED_AT })),
    );
  });

  it('毫秒截断：updated_at 带 .000Z / .500Z 时，用 toUTCString 回送仍能命中 304/放行', () => {
    // 这是 304 能不能真的发生的分水岭：books.updated_at 精确到毫秒，
    // Last-Modified 只到秒。不截断的话 last(500ms) > since(0ms) 永远成立
    // → IMS 永远判「已修改」、IUS 永远判「失败」。
    const withMs = '2026-01-01T00:00:00.500Z';
    expect304(
      check('GET', { 'if-modified-since': MODIFIED_HTTP }, rep('"abc"', { lastModified: withMs })),
    );
    expect(
      check('PUT', { 'if-unmodified-since': MODIFIED_HTTP }, rep('"abc"', { lastModified: withMs })).ok,
    ).toBe(true);
  });

  it('非法 HTTP-date 一律忽略（MUST ignore），不是当成 1970', () => {
    // ⚠️ 这几种写法 Date.parse 都「能解析」但不是 HTTP-date：
    //    '1' → 2000 年、'2026' → 2026-01-01、'2026-10-20' → 当天 0 点。
    // 若放行它们，垃圾头会让 IUS 判定「资源在很久以后改过」→ 无条件 412，
    // 同步客户端永远传不上去。§13.1.3/§13.1.4 要求 MUST ignore。
    for (const bad of ['1', '2026', '2026-10-20', 'garbage', 'not a date']) {
      expect(
        check('PUT', { 'if-unmodified-since': bad }, rep('"abc"', { lastModified: '2020-01-01T00:00:00.000Z' })).ok,
        `If-Unmodified-Since: ${bad} 应被忽略`,
      ).toBe(true);
      expect(
        check('GET', { 'if-modified-since': bad }, rep('"abc"', { lastModified: '2020-01-01T00:00:00.000Z' })).ok,
        `If-Modified-Since: ${bad} 应被忽略`,
      ).toBe(true);
    }
  });

  it('多值 HTTP-date（逗号列表）忽略（§13.1.4：including when the value appears to be a list of dates）', () => {
    const list = `${BEFORE}, ${AFTER}`;
    expect(check('PUT', { 'if-unmodified-since': list }, rep('"abc"', { lastModified: '2020-01-01T00:00:00.000Z' })).ok)
      .toBe(true);
    expect(check('GET', { 'if-modified-since': list }, rep('"abc"', { lastModified: '2020-01-01T00:00:00.000Z' })).ok)
      .toBe(true);
  });

  it('资源没有修改时间（lastModified = null）→ 日期条件一律忽略', () => {
    expect(check('PUT', { 'if-unmodified-since': PAST_DATE }, rep('"abc"')).ok).toBe(true);
    expect(check('GET', { 'if-modified-since': FUTURE_DATE }, rep('"abc"')).ok).toBe(true);
  });

  it('RFC 850 与 asctime 两种历史写法都能被接受（§5.6.7 要求接受）', () => {
    // IMF-fixdate 的等价写法：Sunday, 06-Nov-94 08:49:37 GMT / Sun Nov  6 08:49:37 1994
    const last = '1994-11-06T08:49:37.000Z';
    expect304(
      check('GET', { 'if-modified-since': 'Sun, 06 Nov 1994 08:49:37 GMT' }, rep('"abc"', { lastModified: last })),
    );
    expect304(
      check('GET', { 'if-modified-since': 'Sunday, 06-Nov-94 08:49:37 GMT' }, rep('"abc"', { lastModified: last })),
    );
  });
});

// ── 容错（不崩溃）──────────────────────────────────────────────────────

describe('语法容错', () => {
  it('非法 ETag 列表不应崩溃，且方向保守（If-Match 不成立 → 412）', () => {
    expect412(check('PUT', { 'if-match': 'garbage' }, rep('"abc"')), /不匹配/);
    expect(check('PUT', { 'if-none-match': ',,,' }, rep('"abc"')).ok).toBe(true);
  });

  it('列表里混入 * 时按「无法命中的垃圾」丢弃（语法上不允许生成，§13.1.1 末尾）', () => {
    // `If-Match: *, "abc"` —— 不猜客户端意图；* 不生效，但 "abc" 仍可命中
    expect(check('PUT', { 'if-match': '*, "abc"' }, rep('"abc"')).ok).toBe(true);
    expect412(check('PUT', { 'if-match': '*, "zzz"' }, rep('"abc"')));
  });

  it('方法名大小写不敏感（小写 get 也按 GET 语义回 304）', () => {
    expect304(check('get', { 'if-none-match': '"abc"' }, rep('"abc"')));
  });

  it('空字段值（If-Match: "" / If-None-Match: ""）不会崩溃，且 If-Match 不成立', () => {
    // 空串解析出零个标签 → If-Match 无从成立 → 412；If-None-Match 零个标签 → 放行
    expect412(check('PUT', { 'if-match': '' }, rep('"abc"')), /不匹配/);
    expect(check('PUT', { 'if-none-match': '' }, rep('"abc"')).ok).toBe(true);
  });
});
