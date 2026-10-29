/**
 * 来源字段的一次性修正（管理员）。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────
 *
 * 2026-10-26 种库时，本工作区没有 R2 S3 凭据、也没有站点 ADMIN_TOKEN，
 * 800 本只能走**公开上传通道**入库。那条通道（api/upload.ts）在设计上
 * 只能声明 license_basis = 'user-declared'（匿名上传者自称有权），
 * 于是种子库的书拿到了 upload / user-declared 的来源记录。
 *
 * 事实是：它们来自中文维基文库、逐条写了「总集成书年代 + 编者卒年」，
 * 应该是 seed / public-domain。这个端点就是把这个偏差修正回来。
 *
 * ── 为什么做成端点而不是让管理员手敲 SQL ────────────────────────────
 *
 *   · 手敲 SQL 没有校验：sourceKind / licenseBasis 是闭集，敲错了不会报错；
 *   · 改动范围必须收窄：只允许改「license_basis = user-declared」的行，
 *     且必须匹配 credit —— 否则一条 UPDATE 就能把任何人上传的书洗成公版；
 *   · 需要 dry-run：先看会命中多少行，再决定改不改。
 *
 * 这不是"漂白"工具：它不能把「有版权的内容」变成公版，只能把
 * **已经由人核对过来源**的批次（按 credit 圈定）的来源字段写正确。
 */

import type { Env } from '../config';
import { LICENSE_BASIS_VALUES, type LicenseBasis } from '../lib/ingest';
import { jsonResponse, textResponse } from '../lib/http';

/** 允许写入的 source_kind 闭集（与迁移 0009 的注释一致） */
const SOURCE_KINDS = ['upload', 'url', 'opds', 'seed', 'dav'] as const;

interface FixBody {
  /** 圈定批次：只改这些署名下的书（默认「公版种子」） */
  credit?: unknown;
  sourceKind?: unknown;
  licenseBasis?: unknown;
  ingestedBy?: unknown;
  sourceId?: unknown;
  /** 只统计不改（也可用 ?dryRun=1） */
  dryRun?: unknown;
}

export async function handleProvenanceFix(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (request.method !== 'POST') {
    return textResponse(405, 'Method Not Allowed', { allow: 'POST' });
  }

  let body: FixBody;
  try {
    body = (await request.json()) as FixBody;
  } catch {
    return jsonResponse({ error: 'bad-json' }, 400);
  }

  const credit = typeof body.credit === 'string' && body.credit.trim() ? body.credit.trim() : '公版种子';
  const sourceKind = typeof body.sourceKind === 'string' ? body.sourceKind : 'seed';
  if (!SOURCE_KINDS.includes(sourceKind as (typeof SOURCE_KINDS)[number])) {
    return jsonResponse({ error: 'bad-source-kind', allowed: SOURCE_KINDS }, 400);
  }

  const licenseBasis = typeof body.licenseBasis === 'string' ? body.licenseBasis : 'public-domain';
  if (!LICENSE_BASIS_VALUES.includes(licenseBasis as LicenseBasis)) {
    return jsonResponse(
      { error: 'bad-license-basis', allowed: LICENSE_BASIS_VALUES },
      400,
    );
  }

  const ingestedBy =
    typeof body.ingestedBy === 'string' && body.ingestedBy.trim() ? body.ingestedBy.trim() : 'seed';
  const sourceId =
    typeof body.sourceId === 'string' && body.sourceId.trim() ? body.sourceId.trim() : 'zh.wikisource.org';

  const dryRun = body.dryRun === true || url.searchParams.get('dryRun') === '1';

  // 范围锁死：只动「匿名上传者自称有权」且署名匹配的行。
  // 这条 WHERE 是本端点的安全边界 —— 少了它，一次调用就能改全库。
  //
  // 为什么要把 NULL 也算上：迁移 0009 之前入库的行没有 license_basis，
  // 种库那 800 本里就有 1 本是在新代码部署前传的（实测：dry-run 命中 799）。
  // NULL 只可能是「来源字段上线前的存量」，credit 过滤仍然是第二道锁。
  const scope = `WHERE credit = ? AND (license_basis = 'user-declared' OR license_basis IS NULL)`;

  const counted = await env.DB.prepare(`SELECT COUNT(*) AS n FROM books ${scope}`)
    .bind(credit)
    .first<{ n: number }>();
  const matched = counted?.n ?? 0;

  if (dryRun) {
    return jsonResponse({
      ok: true,
      dryRun: true,
      credit,
      matched,
      wouldUpdate: { sourceKind, licenseBasis, ingestedBy, sourceId },
    });
  }

  const res = await env.DB.prepare(
    `UPDATE books
        SET source_kind = ?,
            license_basis = ?,
            ingested_by = ?,
            source_id = COALESCE(source_id, ?)
      ${scope}`,
  )
    .bind(sourceKind, licenseBasis, ingestedBy, sourceId, credit)
    .run();

  const updated = res.meta?.changes ?? 0;

  return jsonResponse({
    ok: true,
    dryRun: false,
    credit,
    matched,
    updated,
    applied: { sourceKind, licenseBasis, ingestedBy, sourceId },
  });
}
