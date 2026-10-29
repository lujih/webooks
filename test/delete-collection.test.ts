/**
 * 集合上的 DELETE（RFC 4918 §9.6.1）。
 *
 * §9.6.1 原文：「The DELETE method on a collection MUST act as if a
 * "Depth: infinity" header was used on it.」也就是删集合 = 删它的所有成员。
 *
 * 安全边界（本文件重点断言的部分）：
 *   · 删集合必须带写口令（分发层已强制），否则任何人都能清空书库
 *   · **根目录不可删** —— 那等于「删掉整个书库」，一次手滑就不可逆
 *   · 删完之后导航页要立刻反映（缓存已失效），不留幽灵目录
 */

import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { rebuildBuckets, upsertBookStatement } from '../src/lib/db';
import { authorBucket, letterBucket } from '../src/lib/collections';
import { clearDavCache, resetLibrary, testEnv } from './setup';

const ORIGIN = 'https://webooks.test';
const COL = encodeURIComponent('按书名');
const PATHS = ['/', '/按书名/', '/按书名/A/', '/按书名/B/', '/按作者/', '/最近收录/'];

function dav(path: string, init: RequestInit = {}, withToken = true): Promise<Response> {
  const headers = { ...(init.headers as Record<string, string>) };
  if (withToken) headers.authorization = 'Bearer test-write-token';
  return SELF.fetch(`${ORIGIN}/dav${path}`, { ...init, headers });
}

async function seed(): Promise<void> {
  const rows = [
    { leaf: 'Alpha.epub', title: 'Alpha' },
    { leaf: 'Bravo.epub', title: 'Bravo' },
    { leaf: 'Charlie.epub', title: 'Charlie' },
  ];
  await testEnv.DB.batch(
    rows.map((r, i) =>
      upsertBookStatement(testEnv.DB, {
        id: `cd-${i}`, leafName: r.leaf, title: r.title, author: null, language: null,
        format: 'epub', contentType: 'application/epub+zip', size: 100, sha256: null,
        r2Key: `books/cd-${i}`, etag: `e${i}`,
        titleLetter: letterBucket(r.title), authorLetter: authorBucket(null),
        formatBucket: 'epub', publishedAt: new Date().toISOString(),
      }),
    ),
  );
  await rebuildBuckets(testEnv.DB);
}

async function countBooks(): Promise<number> {
  const row = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM books').first<{ n: number }>();
  return row?.n ?? 0;
}

beforeEach(async () => {
  await resetLibrary();
  await clearDavCache(PATHS);
});

describe('集合 DELETE（RFC 4918 §9.6.1）', () => {
  it('删桶会连同成员一起删除', async () => {
    await seed();
    expect(await countBooks()).toBe(3);

    const res = await dav(`/按书名/A/`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    await res.text();

    // Alpha 被删掉，Bravo/Charlie 还在
    const rest = await testEnv.DB
      .prepare('SELECT leaf_name FROM books ORDER BY leaf_name')
      .all<{ leaf_name: string }>();
    const names = (rest.results ?? []).map((r) => r.leaf_name);
    expect(names).not.toContain('Alpha.epub');
    expect(names).toContain('Bravo.epub');
    expect(names).toContain('Charlie.epub');
  });

  it('删导航层（/按书名/）必须被拒绝，且一本书都不能少', async () => {
    await seed();
    // 2026-10-28 审查订正：旧实现返回 **204 但一本没删** —— 对客户端宣称
    // 「按 §9.6.1 我把这个集合连同成员都删了」，实际什么都没发生，
    // 属于静默说谎。导航层的成员是「派生出来的桶」，没有实体行可删；
    // 真要删就等于删全库，风险与根目录同级 → 与根目录一致明确拒绝。
    const res = await dav('/按书名/', { method: 'DELETE' });
    expect(res.status).toBe(405);
    await res.text();
    expect(await countBooks()).toBe(3);
  });

  // ── 2026-10-28 审查：分页目录 DELETE 曾会删掉整个桶/整个书库 ──────────
  it('删分页目录（/按书名/A/2/）必须被拒绝，且一本书都不能少', async () => {
    await seed();
    // 修复前：`node.page` 被丢掉，DELETE /按书名/A/2/ 等价于删整个 A 桶。
    const res = await dav('/按书名/A/2/', { method: 'DELETE' });
    expect(res.status).toBe(405);
    await res.text();
    expect(await countBooks(), '分页目录不是可删集合').toBe(3);
  });

  it('删最近收录的分页目录（/最近收录/2/）不得清空书库', async () => {
    await seed();
    // 修复前最严重的一条：recent 的删除条件是 `1 = 1`，
    // DELETE /最近收录/2/ 会删掉**全库**。
    const res = await dav('/最近收录/2/', { method: 'DELETE' });
    expect(res.status).toBe(405);
    await res.text();
    expect(await countBooks(), '一次请求删全库必须被阻止').toBe(3);
  });

  it('集合成员超过单请求上限时拒绝（409），不做半删', async () => {
    // 9 本 > MAX_COLLECTION_DELETE(8)：必须整体拒绝，而不是删 8 本留 1 本
    await testEnv.DB.batch(
      Array.from({ length: 9 }, (_, i) =>
        upsertBookStatement(testEnv.DB, {
          id: `bulk-${i}`, leafName: `Bulk${i}.epub`, title: `Bulk${i}`, author: null,
          language: null, format: 'epub', contentType: 'application/epub+zip',
          size: 100, sha256: null, r2Key: `books/bulk-${i}`, etag: `b${i}`,
          titleLetter: letterBucket(`Bulk${i}`), authorLetter: authorBucket(null),
          formatBucket: 'epub', publishedAt: new Date().toISOString(),
        }),
      ),
    );
    await rebuildBuckets(testEnv.DB);
    expect(await countBooks()).toBe(9);

    const res = await dav('/按书名/B/', { method: 'DELETE' });
    expect(res.status).toBe(409);
    await res.text();
    expect(await countBooks(), '超限时必须一本都不删').toBe(9);
  });

  it('无口令不能删集合（防止匿名清空书库）', async () => {
    await seed();
    const res = await dav(`/按书名/A/`, { method: 'DELETE' }, false);
    expect(res.status).toBe(401);
    await res.text();
    expect(await countBooks(), '书不能被匿名删除').toBe(3);
  });

  it('根目录不可删除（否则等于删掉整个书库）', async () => {
    await seed();
    const res = await dav('/', { method: 'DELETE' });
    expect(res.status).toBe(405);
    await res.text();
    expect(await countBooks(), '根目录删除必须被拒绝').toBe(3);
  });

  it('删除后导航页立即反映（缓存已失效，不留幽灵目录）', async () => {
    await seed();
    const nav = () =>
      SELF.fetch(`${ORIGIN}/dav/按书名/`, {
        method: 'PROPFIND',
        headers: { depth: '1', 'content-type': 'application/xml' },
        body: '<D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>',
      }).then((r) => r.text());

    expect(await nav()).toContain(`/dav/${COL}/A/`);
    await dav(`/按书名/A/`, { method: 'DELETE' }).then((r) => r.text());
    // 集合被清空后，A 桶不应再出现
    expect(await nav()).not.toContain(`/dav/${COL}/A/`);
  });

  // ── 成员锁（RFC 4918 §9.6 + §7）──────────────────────────────────
  //
  // 集合 DELETE 等价于 Depth: infinity，所以受锁约束。修复前这里**完全
  // 没有检查成员锁**：分发层的 handleLockedWrite 只看集合自身的 davPath，
  // 于是 LOCK 住一本书之后 DELETE 整个集合照样成功，那本书就没了。
  // 实测（修复前）：LOCK locked.epub → 200，DELETE /最近收录/ → 204，
  // locked.epub 的 D1 行与 R2 对象双双消失。
  it('成员被锁时拒绝删除整个集合（不能删一半）', async () => {
    await dav('/最近收录/locked.epub', { method: 'PUT', body: 'LOCKED' }).then((r) => r.text());
    await dav('/最近收录/free.epub', { method: 'PUT', body: 'FREE' }).then((r) => r.text());

    const lock = await dav('/最近收录/locked.epub', {
      method: 'LOCK',
      headers: { 'content-type': 'application/xml', timeout: 'Second-300' },
      body:
        '<?xml version="1.0" encoding="utf-8" ?>'
        + '<D:lockinfo xmlns:D="DAV:">'
        + '<D:lockscope><D:exclusive/></D:lockscope>'
        + '<D:locktype><D:write/></D:locktype>'
        + '<D:owner>tester</D:owner>'
        + '</D:lockinfo>',
    });
    await lock.text();
    expect(lock.status).toBe(200);

    const del = await dav('/最近收录/', { method: 'DELETE' });
    await del.text();
    expect(del.status, '有活锁成员的集合必须整体拒绝，而不是删一半').toBe(423);

    const rows = await testEnv.DB
      .prepare('SELECT leaf_name FROM books ORDER BY leaf_name')
      .all<{ leaf_name: string }>();
    expect((rows.results ?? []).map((r) => r.leaf_name)).toEqual(['free.epub', 'locked.epub']);
  });

  it('无锁时集合照常删除（锁检查不能误伤正常路径）', async () => {
    await dav('/最近收录/a.epub', { method: 'PUT', body: 'A' }).then((r) => r.text());
    await dav('/最近收录/b.epub', { method: 'PUT', body: 'B' }).then((r) => r.text());

    const del = await dav('/最近收录/', { method: 'DELETE' });
    await del.text();
    expect(del.status).toBe(204);
    expect(await countBooks()).toBe(0);
  });
});
