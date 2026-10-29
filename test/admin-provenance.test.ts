/**
 * 来源字段修正端点（`POST /api/admin/provenance`）测试。
 *
 * 这个端点的风险不在"能不能改"，而在**别改过头**：它必须只动
 * `credit` 匹配且 `license_basis='user-declared'` 的行。少一个条件，
 * 一次调用就能把全库的来源洗成公版 —— 所以测试的重点是"不该改的没被改"。
 */

import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetLibrary, testEnv } from './setup';

const ORIGIN = 'https://webooks.test';
const ADMIN_HEADERS = {
  authorization: 'Bearer test-token',
  'content-type': 'application/json',
};

async function seedBook(
  id: string,
  leaf: string,
  credit: string,
  licenseBasis: string,
  sourceKind = 'upload',
): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO books (id, leaf_name, title, author, language, format, content_type, size,
       sha256, r2_key, title_letter, author_letter, format_bucket, kind_bucket, kind_source,
       published_at, created_at, updated_at, status, credit, source_kind, license_basis, ingested_by)
     VALUES (?, ?, ?, '佚名', 'zh', 'epub', 'application/epub+zip', 100,
       NULL, ?, 'Q', 'W', 'epub', 'ebook', 'derived',
       '2026-10-26', '2026-10-26', '2026-10-26', 'published', ?, ?, ?, 'anonymous')`,
  )
    .bind(id, leaf, `${leaf}`, `books/${id}/${leaf}`, credit, sourceKind, licenseBasis)
    .run();
}

function fix(body: unknown, headers: Record<string, string> = ADMIN_HEADERS): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/admin/provenance`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await resetLibrary();
});

describe('范围与幂等', () => {
  it('dry-run 只统计：命中 credit 匹配且 user-declared 的行', async () => {
    await seedBook('a1', '公版一.epub', '公版种子', 'user-declared');
    await seedBook('a2', '公版二.epub', '公版种子', 'user-declared');
    await seedBook('b1', '别人的书.epub', '张三', 'user-declared');
    await seedBook('c1', '已是公版.epub', '公版种子', 'public-domain', 'seed');

    const res = await fix({ dryRun: true });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { dryRun: boolean; matched: number; updated?: number };
    expect(json.dryRun).toBe(true);
    expect(json.matched).toBe(2);
    expect(json.updated).toBeUndefined();

    // dry-run 不落库
    const row = await testEnv.DB.prepare(`SELECT license_basis FROM books WHERE id='a1'`).first<{
      license_basis: string;
    }>();
    expect(row?.license_basis).toBe('user-declared');
  });

  it('正式执行：只改命中的 2 条，别人的书与已公版的书不动', async () => {
    await seedBook('a1', '公版一.epub', '公版种子', 'user-declared');
    await seedBook('a2', '公版二.epub', '公版种子', 'user-declared');
    await seedBook('b1', '别人的书.epub', '张三', 'user-declared');
    await seedBook('c1', '已是公版.epub', '公版种子', 'public-domain', 'seed');

    const res = await fix({});
    expect(res.status).toBe(200);
    const json = (await res.json()) as { matched: number; updated: number };
    expect(json.matched).toBe(2);
    expect(json.updated).toBe(2);

    const fixed = await testEnv.DB.prepare(
      `SELECT source_kind, license_basis, ingested_by, source_id FROM books WHERE id='a1'`,
    ).first<Record<string, string>>();
    expect(fixed?.source_kind).toBe('seed');
    expect(fixed?.license_basis).toBe('public-domain');
    expect(fixed?.ingested_by).toBe('seed');
    expect(fixed?.source_id).toBe('zh.wikisource.org');

    const other = await testEnv.DB.prepare(`SELECT license_basis FROM books WHERE id='b1'`).first<{
      license_basis: string;
    }>();
    expect(other?.license_basis).toBe('user-declared');

    const already = await testEnv.DB.prepare(`SELECT ingested_by FROM books WHERE id='c1'`).first<{
      ingested_by: string;
    }>();
    expect(already?.ingested_by).toBe('anonymous');
  });

  it('license_basis 为 NULL 的存量行也会被命中（种库实测少 1 本的原因）', async () => {
    await seedBook('a1', '公版一.epub', '公版种子', 'user-declared');
    await testEnv.DB.prepare(`UPDATE books SET license_basis = NULL WHERE id = 'a1'`).run();

    const res = await fix({});
    const json = (await res.json()) as { matched: number; updated: number };
    expect(json.matched).toBe(1);
    expect(json.updated).toBe(1);

    const row = await testEnv.DB.prepare(`SELECT license_basis FROM books WHERE id='a1'`).first<{
      license_basis: string;
    }>();
    expect(row?.license_basis).toBe('public-domain');
  });

  it('重复执行是幂等的：第二次 updated = 0', async () => {
    await seedBook('a1', '公版一.epub', '公版种子', 'user-declared');
    await fix({});
    const again = await fix({});
    const json = (await again.json()) as { matched: number; updated: number };
    expect(json.matched).toBe(0);
    expect(json.updated).toBe(0);
  });
});

describe('参数与鉴权', () => {
  it('非法 licenseBasis：400 并列白名单', async () => {
    const res = await fix({ licenseBasis: 'public-domain-forever' });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; allowed: string[] };
    expect(json.error).toBe('bad-license-basis');
    expect(json.allowed).toContain('public-domain');
  });

  it('非法 sourceKind：400', async () => {
    const res = await fix({ sourceKind: 'ebook' });
    expect(res.status).toBe(400);
  });

  it('没有 ADMIN_TOKEN：403 且不改库', async () => {
    await seedBook('a1', '公版一.epub', '公版种子', 'user-declared');
    const res = await fix({}, { 'content-type': 'application/json' });
    expect(res.status).toBe(403);
    const row = await testEnv.DB.prepare(`SELECT license_basis FROM books WHERE id='a1'`).first<{
      license_basis: string;
    }>();
    expect(row?.license_basis).toBe('user-declared');
  });
});
