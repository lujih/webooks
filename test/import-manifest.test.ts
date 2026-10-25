/**
 * 公版种子库登记端点（`POST /api/admin/import/manifest`）测试。
 *
 * 这个端点的核心不是「写进去」，而是**不接受任何不自洽的登记**：
 *   · r2Key 必须是 books/<id>/<书名> 且与 id/leafName 自洽（否则等于把桶里
 *     任意对象挂到任意书名下，包括 uploads/ 里的垃圾）
 *   · 对象必须真的在桶里（否则登记出一条指向空气的书）
 *   · license_basis 必填且不接受 unknown
 *   · 同名不同 id 是冲突，同名同 id 是幂等重跑
 *
 * 每批 ≤8 本：一本 4 个子请求，8×4=32，落在 Workers Free 的 50/次以内。
 */

import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetLibrary, testEnv } from './setup';

const ORIGIN = 'https://webooks.test';
const ADMIN_HEADERS = {
  authorization: 'Bearer test-token',
  'content-type': 'application/json',
};

function hexId(n: number): string {
  return n.toString(16).padStart(16, '0');
}

async function putObject(idHex: string, leafName: string, bytes = 'PK\x03\x04seed'): Promise<string> {
  const key = `books/${idHex}/${leafName}`;
  await testEnv.BUCKET.put(key, new TextEncoder().encode(bytes));
  return key;
}

interface EntryOverrides {
  id?: string;
  leafName?: string;
  r2Key?: string;
  title?: string;
  author?: string | null;
  licenseBasis?: string;
  sourceUrl?: string | null;
  sourceKind?: string;
}

function entry(idHex: string, leafName: string, over: EntryOverrides = {}) {
  return {
    id: idHex,
    leafName,
    r2Key: `books/${idHex}/${leafName}`,
    title: leafName.replace(/\.epub$/, ''),
    author: '曹雪芹',
    licenseBasis: 'public-domain',
    sourceUrl: `https://zh.wikisource.org/wiki/${encodeURIComponent(leafName.replace(/\.epub$/, ''))}`,
    sourceKind: 'seed',
    ...over,
  };
}

function post(entries: unknown[], headers: Record<string, string> = ADMIN_HEADERS): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/admin/import/manifest`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ entries }),
  });
}

beforeEach(async () => {
  await resetLibrary();
  // R2 不随 resetLibrary 清空
  const list = await testEnv.BUCKET.list({ prefix: 'books/' });
  for (const o of list.objects) await testEnv.BUCKET.delete(o.key);
});

describe('登记成功', () => {
  it('一批 8 本全部入库，来源与署名正确，分桶同步更新', async () => {
    const titles = ['紅樓夢', '論語', '詩經', '史記', '莊子', '楚辭', '左傳', '孟子'];
    const entries = [];
    for (let i = 0; i < 8; i++) {
      const id = hexId(i + 1);
      const leaf = `${titles[i]}.epub`;
      await putObject(id, leaf);
      entries.push(entry(id, leaf, { title: titles[i]! }));
    }

    const res = await post(entries);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      registered: Array<{ leafName: string; bookId: string }>;
      existing: string[];
      rejected: unknown[];
      total: number;
    };
    expect(json.registered).toHaveLength(8);
    expect(json.existing).toEqual([]);
    expect(json.rejected).toEqual([]);
    expect(json.total).toBe(8);

    const row = await testEnv.DB.prepare(
      `SELECT title, author, format, kind_bucket, kind_source, credit,
              source_kind, license_basis, ingested_by, source_id, source_entry,
              title_letter, r2_key, status
         FROM books WHERE id = ?`,
    )
      .bind(hexId(1))
      .first<Record<string, string>>();

    expect(row?.title).toBe('紅樓夢');
    expect(row?.author).toBe('曹雪芹');
    expect(row?.format).toBe('epub');
    expect(row?.kind_bucket).toBe('ebook');
    expect(row?.credit).toBe('公版种子');
    expect(row?.source_kind).toBe('seed');
    expect(row?.license_basis).toBe('public-domain');
    expect(row?.ingested_by).toBe('seed');
    expect(row?.status).toBe('published');
    // 紅 的拼音首字母是 H
    expect(row?.title_letter).toBe('H');
    expect(row?.r2_key).toBe(`books/${hexId(1)}/紅樓夢.epub`);

    // 分桶计数：8 本都进 title/author/format/type 四个集合
    const bucket = await testEnv.DB.prepare(
      `SELECT total FROM buckets WHERE collection = 'title' AND bucket = 'H'`,
    ).first<{ total: number }>();
    expect(bucket?.total).toBe(1);
  });

  it('幂等重跑：同名同 id 记为 existing，不重复入库', async () => {
    const id = hexId(0xaa);
    const leaf = '論語.epub';
    await putObject(id, leaf);
    const first = await post([entry(id, leaf)]);
    expect(first.status).toBe(200);

    const again = await post([entry(id, leaf)]);
    const json = (await again.json()) as { registered: unknown[]; existing: string[] };
    expect(json.registered).toEqual([]);
    expect(json.existing).toEqual(['論語.epub']);

    const count = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM books`).first<{ n: number }>();
    expect(count?.n).toBe(1);
  });
});

describe('拒绝不自洽的登记', () => {
  it('r2Key 与 id/leafName 不自洽：拒绝', async () => {
    const id = hexId(2);
    await putObject(id, '論語.epub');
    const res = await post([
      entry(id, '論語.epub', { r2Key: 'uploads/2026-10-23/x/論語.epub' }),
    ]);
    const json = (await res.json()) as { rejected: Array<{ code: string }> };
    expect(json.rejected[0]?.code).toBe('bad-r2-key');
  });

  it('对象不在桶里：拒绝，不留 D1 行', async () => {
    const id = hexId(3);
    const res = await post([entry(id, '不存在.epub')]);
    const json = (await res.json()) as { rejected: Array<{ code: string }> };
    expect(json.rejected[0]?.code).toBe('object-not-found');
    const count = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM books`).first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it('licenseBasis=unknown：拒绝', async () => {
    const id = hexId(4);
    await putObject(id, '詩經.epub');
    const res = await post([entry(id, '詩經.epub', { licenseBasis: 'unknown' })]);
    const json = (await res.json()) as { rejected: Array<{ code: string }> };
    expect(json.rejected[0]?.code).toBe('license-basis-required');
  });

  it('不在白名单的格式：拒绝', async () => {
    const id = hexId(5);
    await putObject(id, '恶意.exe');
    const res = await post([entry(id, '恶意.exe')]);
    const json = (await res.json()) as { rejected: Array<{ code: string }> };
    expect(json.rejected[0]?.code).toBe('unsupported-format');
  });

  it('同名但不同 id：already-exists（不静默顶掉）', async () => {
    const first = hexId(6);
    await putObject(first, '論語.epub');
    await post([entry(first, '論語.epub')]);

    const second = hexId(7);
    await putObject(second, '論語.epub');
    const res = await post([entry(second, '論語.epub')]);
    const json = (await res.json()) as { rejected: Array<{ code: string; detail: string }> };
    expect(json.rejected[0]?.code).toBe('already-exists');
    expect(json.rejected[0]?.detail).toContain(first);
  });

  it('缺 title：拒绝', async () => {
    const id = hexId(8);
    await putObject(id, '無題.epub');
    const res = await post([entry(id, '無題.epub', { title: '' })]);
    const json = (await res.json()) as { rejected: Array<{ code: string }> };
    expect(json.rejected[0]?.code).toBe('title-required');
  });
});

describe('批量边界与鉴权', () => {
  it('超过 8 本：400 并说明子请求上限', async () => {
    const entries = Array.from({ length: 9 }, (_, i) => entry(hexId(100 + i), `书${i}.epub`));
    const res = await post(entries);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; max: number };
    expect(json.error).toBe('too-many-entries');
    expect(json.max).toBe(8);
  });

  it('没有 ADMIN_TOKEN：403', async () => {
    const res = await post([], { 'content-type': 'application/json' });
    expect(res.status).toBe(403);
  });
});
