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
import { creditsCacheKey, davCache } from '../lib/cache';
import { guardWrite } from '../lib/throttle';
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
    const { rows, total } = await listWall(env.DB, limit, offset);
    return jsonResponse({
      total,
      limit,
      offset,
      requests: rows.map(publicView),
    });
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
      `SELECT credit AS name, COUNT(*) AS books
         FROM books
        WHERE status = 'published' AND credit IS NOT NULL AND credit <> ''
        GROUP BY credit
        ORDER BY books DESC, credit ASC
        LIMIT ?`,
    )
    .bind(limit)
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

  return jsonResponse({
    totalBooks: total?.n ?? 0,
    // 有多少人真的留了名（排除默认的「雷锋」）
    namedContributors: credited?.n ?? 0,
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
  // 否则一个人占满整个榜单会显得很假。
  const { results } = await env.DB
    .prepare(
      `SELECT credit AS name, COUNT(*) AS books
         FROM books
        WHERE status = 'published'
          AND credit IS NOT NULL AND credit <> ''
          AND credit <> ?
        GROUP BY credit
        ORDER BY books DESC, credit ASC
        LIMIT 12`,
    )
    .bind(DEFAULT_CREDIT_NAME)
    .all<{ name: string; books: number }>();

  const totals = await env.DB
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN credit IS NOT NULL AND credit <> '' AND credit <> ? THEN 1 ELSE 0 END) AS named
       FROM books WHERE status = 'published'`,
    )
    .bind(DEFAULT_CREDIT_NAME)
    .first<{ total: number; named: number }>();

  const payload = {
    totalBooks: totals?.total ?? 0,
    namedBooks: totals?.named ?? 0,
    contributors: results ?? [],
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
