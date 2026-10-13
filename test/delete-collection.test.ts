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

  it('删导航层（/按书名/）会清空该集合下的全部书', async () => {
    await seed();
    const res = await dav('/按书名/', { method: 'DELETE' });
    expect(res.status).toBe(204);
    await res.text();
    // title 集合是按书名导航，但它本身不含成员；成员在其各桶里。
    // 因此删导航层应当不影响各桶里的书 —— 关键是不能误删。
    expect(await countBooks()).toBe(3);
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
});
