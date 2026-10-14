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
