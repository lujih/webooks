/**
 * 求书 API（公开）。
 *
 * 两条路由，都不需要鉴权 —— 这是产品定位（公共书库、无需注册）。
 *
 *   POST /api/requests        提交求书
 *   GET  /api/requests        求书墙数据（给前端渲染）
 *
 * 防滥用：
 *   · 走 guardWrite（与其它写路径同一套节流，见 lib/throttle.ts）
 *   · 同一 IP + 同一本书 + 同一小时内只计一次命中（anonKey）
 *   · 体积与字段长度都有上限
 *
 * 注意：这里**没有** Turnstile。理由与 WebDAV 一致 ——
 * 「求书」是低价值写操作（不能覆盖已有内容、不能删除），
 * 而验证码会挡住真实的书迷用户。节流 + 去重已经足够。
 */

import type { Env } from '../config';
import { jsonResponse } from '../lib/http';
import { creditsCacheKey, davCache, requestsCacheKey } from '../lib/cache';
import { guardWrite } from '../lib/throttle';
import { latestBook } from '../lib/db';
import { collectionSegment } from '../lib/collections';
import {
  DEFAULT_CREDIT_NAME,
  listForAdmin,
  listWall,
  submitRequest,
  updateRequestStatus,
  validateRequestInput,
} from '../lib/requests';

export async function handleRequests(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === 'GET') {
    const limit = clampInt(url.searchParams.get('limit'), 50, 1, 200);
    const offset = clampInt(url.searchParams.get('offset'), 0, 0, 100_000);

    // ⚠️ 这条路径原来**完全没有缓存**，而它是求书墙的唯一数据源：
    //   每次打开 /requests = 1 次 Worker 请求 + 1 次 D1 聚合查询。
    //   求书墙是匿名公开页面，刷新的成本应该由缓存而不是 D1 承担。
    //
    // 缓存 60 秒。比榜单的 1 小时短，因为求书是「有人刚提交了就该看到」的
    // 场景 —— 但即便漏看 1 分钟也没有任何损失（清单本身不是实时数据）。
    //
    // 服务端 Cache API + 客户端 max-age 双层：
    //   · 客户端层挡住同一个人的连续刷新
    //   · 服务端层挡住**不同访客**的同一份查询 —— 这一层才是省 D1 的关键
    //
    // ⚠️ 不在这里做失效钩子：求书提交本身会改变列表，但漏看 60 秒的代价
    //   接近于零，而失效需要在上传/标记/删除三条路径上各挂一次钩子，
    //   漏挂一处就是「改了半天没变」。60 秒是更划算的取舍。
    const cache = davCache();
    const cacheKey = requestsCacheKey(limit, offset);
    if (cache) {
      const hit = await cache.match(cacheKey);
      if (hit) {
        return new Response(await hit.text(), { headers: hit.headers });
      }
    }

    const { rows, total } = await listWall(env.DB, limit, offset);
    const payload = JSON.stringify({
      total,
      limit,
      offset,
      requests: rows.map(publicView),
    });
    const headers = {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=60',
    };
    if (cache) {
      try {
        await cache.put(cacheKey, new Response(payload, {
          headers: { ...headers, 'cache-control': 'public, max-age=60' },
        }));
      } catch {
        /* 缓存写失败不影响功能 */
      }
    }
    return new Response(payload, { headers });
  }

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'method-not-allowed' }, 405);
  }

  // ── 节流：与 WebDAV PUT / 网页上传共用同一套配额 ──
  // 之前 upload 那条链路完全漏了节流（文档声称有、代码里没有），
  // 这次直接用统一的 guardWrite，新增入口时不会再漏。
  const blocked = await guardWrite(env, request, 300);
  if (blocked) return blocked;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'bad-json', message: '请求格式不对' }, 400);
  }

  const parsed = validateRequestInput(body);
  if (!parsed.ok) {
    return jsonResponse({ error: parsed.error, message: parsed.message }, 400);
  }

  try {
    const result = await submitRequest(env.DB, request, parsed.title, parsed.author);
    return jsonResponse(
      {
        ok: true,
        outcome: result.outcome,
        hits: result.hits,
        message:
          result.outcome === 'new'
            ? '已经记下了，书到了会有人来上传'
            : '你之前求过这本啦，已经在清单里',
      },
      result.outcome === 'new' ? 201 : 200,
    );
  } catch (err) {
    // D1 出错时不要把内部信息泄漏出去
    console.error('submitRequest failed:', err instanceof Error ? err.message : err);
    return jsonResponse({ error: 'submit-failed', message: '提交失败，过一会儿再试' }, 500);
  }
}

/** 对外的字段（不泄漏 anon_keys —— 那是防刷用的内部数据） */
function publicView(r: {
  id: string;
  title: string;
  author: string | null;
  hits: number;
  last_at: string;
}) {
  return {
    id: r.id,
    title: r.title,
    author: r.author,
    hits: r.hits,
    lastAt: r.last_at,
  };
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}
// ── 管理后台接口（需要 ADMIN_TOKEN）──────────────────────────────────────

/**
 * 求书看板 + 上传者榜单。
 *
 * 「已被收录」**由管理员手动标记**，不做自动匹配 ——
 * 《活着》可能以「活着-余华.epub」「余华-活着.epub」等各种命名入库，
 * 自动匹配猜错的代价比漏判高。这与项目「判不出就返回 null」的哲学一致。
 */
export async function handleAdminRequests(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const action = url.pathname.slice('/api/admin/requests/'.length).replace(/\/+$/, '');

  if (action === '') {
    // 列表
    const statusParam = url.searchParams.get('status') ?? 'all';
    const status = (['all', 'open', 'fulfilled', 'ignored'] as const)
      .includes(statusParam as never) ? (statusParam as never) : 'all';
    const limit = clampInt(url.searchParams.get('limit'), 50, 1, 200);
    const offset = clampInt(url.searchParams.get('offset'), 0, 0, 100_000);
    const { rows, total } = await listForAdmin(env.DB, status, limit, offset);
    return jsonResponse({
      total,
      limit,
      offset,
      requests: rows.map((r) => ({
        id: r.id,
        title: r.title,
        author: r.author,
        hits: r.hits,
        status: r.status,
        lastAt: r.last_at,
        note: r.note,
        fulfilledBookId: r.fulfilled_book_id,
      })),
    });
  }

  // 标记状态：POST /api/admin/requests/<id>  { status, note?, bookId? }
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'method-not-allowed' }, 405);
  }
  const id = action;
  let body: { status?: string; note?: string; bookId?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonResponse({ error: 'bad-json' }, 400);
  }
  const status = body.status;
  if (status !== 'fulfilled' && status !== 'ignored' && status !== 'open') {
    return jsonResponse(
      { error: 'bad-status', allowed: ['open', 'fulfilled', 'ignored'] },
      400,
    );
  }
  const ok = await updateRequestStatus(env.DB, id, status, {
    note: typeof body.note === 'string' ? body.note.slice(0, 200) : null,
    bookId: typeof body.bookId === 'string' ? body.bookId : null,
  });
  if (!ok) return jsonResponse({ error: 'not-found' }, 404);
  return jsonResponse({ ok: true });
}

/**
 * 上传者榜单：按 credit 聚合。
 *
 * 「有多少人参与」比「谁传得最多」更有意义 —— 所以排序用
 * 「贡献书数」与「去重后的书数」并列，而不是单纯计数。
 */
export async function handleCreditBoard(request: Request, env: Env, url: URL): Promise<Response> {
  const limit = clampInt(url.searchParams.get('limit'), 50, 1, 200);
  const { results } = await env.DB
    .prepare(
      // 与公开端点保持一致：雷锋计入且永久置顶（见 handleCreditPublic 的说明）
      `SELECT credit AS name, COUNT(*) AS books
         FROM books
        WHERE status = 'published' AND credit IS NOT NULL AND credit <> ''
        GROUP BY credit
        ORDER BY (credit = ?) DESC, books DESC, credit ASC
        LIMIT ?`,
    )
    .bind(DEFAULT_CREDIT_NAME, limit)
    .all<{ name: string; books: number }>();

  const total = await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM books WHERE status='published'`)
    .first<{ n: number }>();
  const credited = await env.DB
    .prepare(
      `SELECT COUNT(*) AS n FROM books
        WHERE status='published' AND credit IS NOT NULL AND credit <> '' AND credit <> ?`,
    )
    .bind(DEFAULT_CREDIT_NAME)
    .first<{ n: number }>();

  const collective = await env.DB
    .prepare(
      `SELECT COUNT(*) AS n FROM books
        WHERE status='published' AND credit = ?`,
    )
    .bind(DEFAULT_CREDIT_NAME)
    .first<{ n: number }>();

  return jsonResponse({
    totalBooks: total?.n ?? 0,
    // 留了自己名字的书数（不含集体署名）
    namedContributors: credited?.n ?? 0,
    // 集体署名的书数
    collectiveBooks: collective?.n ?? 0,
    contributors: results ?? [],
  });
}

// ── 公开的上传者榜单（匿名）─────────────────────────────────────────────

/**
 * 上传者榜单 —— 首页公开展示，**不需要**任何鉴权。
 *
 * 为什么要有这个公开端点，而不是让首页直接读 admin 接口：
 *   · admin 接口需要口令（fail-closed），首页是匿名的
 *   · 榜单本身就是「公开署名」的聚合结果 —— 它**不是**管理信息
 *     （不含 IP、时间戳、留言、书籍 id），公开不构成风险
 *   · 与 lib/requests.ts 的求书墙同一个定位：让社区行为可见，
 *     从而鼓励更多人参与
 *
 * ⚠️ 预算：D1 Free 是 500 万行读/天，首页是流量最大的入口。
 *   所以这个查询必须走索引（idx_books_credit）且**必须**缓存。
 *   实测 @20,000 本的全表 GROUP BY 约 20,000 行读 —— 不缓存的话
 *   250 次首页访问就打满一天额度。这里用 Cache API 存 60 分钟。
 *
 * ⚠️ 只返回「名字 + 本数」。任何其它字段都不要加进来 —— 一旦
 *   开始返回更多信息，就该重新审视它是否还该公开。
 */
export async function handleCreditPublic(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return jsonResponse({ error: 'method-not-allowed' }, 405);
  }

  const cache = davCache();
  const cacheKey = creditsCacheKey();
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      // 命中也要回 200 而不是 304：浏览器会自己按 cache-control 处理，
      // 304 只会让匿名客户端更难处理。
      return new Response(await hit.text(), {
        headers: hit.headers,
      });
    }
  }

  // 「雷锋」是留空时的默认署名，不是真人 —— 不计入榜单，
  // ⚠️ 「雷锋」**要计入榜单，且永久置顶** —— 这是一个刻意的产品决策。
  //
  // 它不是「未填写」的占位符，而是**一个集体署名**：所有没有留名的人
  // （忘记留的、选择不写的）共同持有它。人人都可以是雷锋。
  //
  // 我最初把它排除在外，理由是「一个人占满榜单显得很假」。那个判断
  // 是错的 —— 它掩盖的恰恰是这个书库最真实的状态：绝大多数书是匿名
  // 传上来的。把「雷锋」藏起来，等于让书库看起来像是人人都在署名，
  // 而事实相反。
  //
  // 排序也必须是**真的置顶**，而不是「碰巧排第一」：如果某天有人传了
  // 200 本而雷锋只有 3 本，按本数排雷锋就该掉到底下 —— 那会让这个
  // 集体署名看起来像个冷门选项。用 `ORDER BY` 的 CASE 强制置顶。
  const { results } = await env.DB
    .prepare(
      `SELECT credit AS name, COUNT(*) AS books
         FROM books
        WHERE status = 'published' AND credit IS NOT NULL AND credit <> ''
        GROUP BY credit
        ORDER BY (credit = ?) DESC, books DESC, credit ASC
        LIMIT 12`,
    )
    .bind(DEFAULT_CREDIT_NAME)
    .all<{ name: string; books: number }>();

  // namedBooks 改为「**留了自己名字**」的书的数量 —— 也就是排除了雷锋的。
  // 首页文案要说清这一点，否则「18 / 19 本」会让人搞不清雷锋算哪边。
  const totals = await env.DB
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN credit IS NOT NULL AND credit <> '' AND credit <> ? THEN 1 ELSE 0 END) AS named,
         SUM(CASE WHEN credit = ? THEN 1 ELSE 0 END) AS collective
       FROM books WHERE status = 'published'`,
    )
    .bind(DEFAULT_CREDIT_NAME, DEFAULT_CREDIT_NAME)
    .first<{ total: number; named: number; collective: number }>();

  // 「最近上架」—— 首页首屏那张活书脊。
  //
  // ⚠️ 为什么并到这里而不是首页单独查：
  //   首页原来每次未命中都跑一次 latestBook()（1 行 D1 读）。
  //   但首页是流量最大的入口，而这行数据**变化频率极低**（一天几十本），
  //   榜单那边已经缓存了 1 小时 —— 顺手把它一起返回，
  //   首页就变成了零 D1 读（命中时）。
  // ⚠️ 挂载前缀的默认值必须与 config.ts 的 settings() 一致（'/dav'）——
  //   那里是 `(env.DAV_MOUNT ?? '/dav')`。这里如果写成 `|| ''`，
  //   测试环境（没配 DAV_MOUNT）就会拼出 `/最近收录/...` 这种
  //   少了前缀的路径，而生产环境是 `/dav/最近收录/...` —— 两端不一致。
  const mount = (env.DAV_MOUNT ?? '/dav').trim().replace(/^\/+|\/+$/g, '');
  const latest = await latestBook(env.DB, mount, collectionSegment('recent'));

  const payload = {
    totalBooks: totals?.total ?? 0,
    namedBooks: totals?.named ?? 0,
    // 雷锋那一栏的书的数量。前端用它写「人人可署名」。
    collectiveBooks: totals?.collective ?? 0,
    contributors: results ?? [],
    // 首屏活书脊。null = 书库为空（前端不渲染那张卡）
    latest: latest
      ? {
          title: latest.title,
          author: latest.author,
          credit: latest.credit,
          publishedAt: latest.published_at,
          href: latest.href,
        }
      : null,
  };

  const body = JSON.stringify(payload);
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'public, max-age=600',
  };
  if (cache) {
    try {
      // Cache API 存 60 分钟。失效点在上传 complete 里打（见 purgeCreditCache）——
      // 上传是低频操作，每次多花一次 cache.delete 完全可接受。
      await cache.put(
        cacheKey,
        new Response(body, { headers: { ...headers, 'cache-control': 'public, max-age=3600' } }),
      );
    } catch {
      /* 缓存写失败不影响功能 */
    }
  }
  return new Response(body, { headers });
}

/**
 * 上传/删除后让榜单缓存失效（1 次 Cache API 调用）。
 *
 * ⚠️ Cache API 在 Workers Free 有 50 次/请求的上限（见 purgeEntries 的注释），
 *   所以这里是**单独一次**调用，不与条目缓存的失效混在一起。
 */
export async function purgeCreditCache(): Promise<void> {
  const cache = davCache();
  if (!cache) return;
  try {
    await cache.delete(creditsCacheKey());
  } catch {
    /* 忽略 */
  }
}

/**
 * 手动打掉榜单缓存（管理端用）。
 *
 * 为什么需要：/api/credits 缓存 1 小时。上线改动、或刚调整了
 * 某些书的署名之后，管理员会立刻看到**旧数据**，而访客看到的也是。
 * 没有这个端点就只能干等一小时。
 *
 * ⚠️ 它不能替代 purgeCreditCache() —— 那是自动的（挂在写路径上）。
 *   这个是给「改了数据但没走写路径」的场景兜底，比如手工执行 SQL。
 */
export async function handleCreditPurge(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'method-not-allowed' }, 405);
  }
  await purgeCreditCache();
  return jsonResponse({ ok: true, note: '榜单缓存已清除，下一次请求会重新聚合' });
}
