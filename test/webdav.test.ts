/** 端到端测试：通过 SELF 打真实的 Worker 路由。 */

import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { letterBucket } from '../src/lib/collections';
import { rebuildBuckets, upsertBookStatement } from '../src/lib/db';
import { deriveMetadata } from '../src/lib/metadata';
import { clearDavCache, resetLibrary, testEnv } from './setup';

const ORIGIN = 'https://webooks.test';
const ALL_PATHS = ['/', '/title/', '/author/', '/format/', '/recent/', '/title/A/', '/title/T/', '/title/B/'];

function dav(path: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/dav${path}`, init);
}

function propfind(path: string, depth?: string, body?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/xml' };
  if (depth !== undefined) headers.depth = depth;
  return dav(path, { method: 'PROPFIND', headers, body: body ?? '' });
}

async function seed(leafNames: string[]): Promise<void> {
  const statements = leafNames.map((leaf, i) => {
    const meta = deriveMetadata(leaf);
    return upsertBookStatement(testEnv.DB, {
      id: `test-${i}`,
      leafName: leaf,
      title: meta.title,
      author: meta.author,
      language: null,
      format: meta.format,
      contentType: meta.contentType,
      size: 1024 + i,
      sha256: null,
      r2Key: `books/test-${i}`,
      etag: `etag-${i}`,
      titleLetter: letterBucket(meta.title),
      authorLetter: letterBucket(meta.author ?? meta.title),
      formatBucket: meta.format,
      publishedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    });
  });
  await testEnv.DB.batch(statements);
  await rebuildBuckets(testEnv.DB);
}

beforeEach(async () => {
  await resetLibrary();
  await clearDavCache(ALL_PATHS);
});

// ── OPTIONS / 协议声明 ──────────────────────────────────────────────────

describe('OPTIONS', () => {
  it('声明 WebDAV Class 1 且不声明 LOCK', async () => {
    const res = await dav('/', { method: 'OPTIONS' });
    expect(res.status).toBe(200);
    expect(res.headers.get('dav')).toBe('1'); // Class 1：明确不含 2
    expect(res.headers.get('allow')).toContain('PROPFIND');
    expect(res.headers.get('allow')).not.toContain('LOCK');
    expect(res.headers.get('ms-author-via')).toBe('DAV');
  });
});

// ── PROPFIND 结构 ───────────────────────────────────────────────────────

describe('PROPFIND', () => {
  it('根目录 Depth:1 列出四个集合', async () => {
    const res = await propfind('/', '1');
    expect(res.status).toBe(207);
    const xml = await res.text();
    expect(xml).toContain('<D:multistatus xmlns:D="DAV:">');
    for (const c of ['title', 'author', 'format', 'recent']) {
      expect(xml).toContain(`<D:href>/dav/${c}/</D:href>`);
    }
    expect(xml).toContain('<D:collection/>');
    expect(res.headers.get('x-dav-entries')).toBe('5'); // root + 4 集合
  });

  it('Depth:0 只返回资源自身', async () => {
    const res = await propfind('/', '0');
    expect(res.status).toBe(207);
    expect(res.headers.get('x-dav-entries')).toBe('1');
    const xml = await res.text();
    expect(xml).not.toContain('<D:href>/dav/title/</D:href>');
  });

  it('Depth 缺失按 1 处理（有意偏离 RFC 4918）', async () => {
    const res = await propfind('/');
    expect(res.headers.get('x-dav-entries')).toBe('5');
  });

  it('Depth:infinity 默认降级为 1，不返回 403', async () => {
    const res = await propfind('/', 'infinity');
    expect(res.status).toBe(207);
    await res.text();
  });

  it('分桶导航只列出有书的桶', async () => {
    await seed(['Dune.epub', 'Neuromancer.epub']);
    await clearDavCache(ALL_PATHS);
    const res = await propfind('/title/', '1');
    const xml = await res.text();
    expect(xml).toContain('<D:href>/dav/title/D/</D:href>');
    expect(xml).toContain('<D:href>/dav/title/N/</D:href>');
    expect(xml).not.toContain('<D:href>/dav/title/A/</D:href>'); // 没有 A 开头的书
  });

  it('列表页返回书叶子，href 经过 URL 编码', async () => {
    await seed(['三体.epub']);
    await clearDavCache(ALL_PATHS);
    const res = await propfind('/title/other/', '1');
    const xml = await res.text();
    expect(xml).toContain(`<D:href>/dav/title/other/${encodeURIComponent('三体.epub')}</D:href>`);
    expect(xml).toContain('<D:getcontentlength>1024</D:getcontentlength>');
    expect(xml).toContain('application/epub+zip');
  });

  it('只有被请求的属性出现在 200 propstat，其余进 404 propstat', async () => {
    await seed(['Dune.epub']);
    await clearDavCache(ALL_PATHS);
    const body =
      '<D:propfind xmlns:D="DAV:"><D:prop>' +
      '<D:getcontentlength/><D:doesnotexist/>' +
      '</D:prop></D:propfind>';
    const res = await propfind('/title/D/Dune.epub', '0', body);
    const xml = await res.text();
    expect(xml).toContain('<D:getcontentlength>1024</D:getcontentlength>');
    expect(xml).toContain('<D:status>HTTP/1.1 404 Not Found</D:status>');
    expect(xml).toContain('<D:doesnotexist/>');
    expect(xml).not.toContain('<D:getcontenttype>'); // 未请求就不返回
  });

  it('propname 只返回属性名', async () => {
    await seed(['Dune.epub']);
    await clearDavCache(ALL_PATHS);
    const body = '<D:propfind xmlns:D="DAV:"><D:propname/></D:propfind>';
    const res = await propfind('/title/D/Dune.epub', '0', body);
    const xml = await res.text();
    expect(xml).toContain('<D:resourcetype/>');
    expect(xml).not.toContain('<D:getcontentlength>');
  });

  it('未知路径返回 404', async () => {
    const res = await propfind('/nope/', '1');
    expect(res.status).toBe(404);
  });

  it('第二次相同请求命中缓存', async () => {
    const first = await propfind('/', '1');
    expect(first.headers.get('x-dav-cache')).toBe('MISS');
    await first.text();

    const second = await propfind('/', '1');
    expect(second.headers.get('x-dav-cache')).toBe('HIT');
    expect(second.status).toBe(207);
    await second.text();
  });

  it('单目录条目数被硬限制在 MAX_ENTRIES，超出的进分页子目录', async () => {
    const many = Array.from({ length: 250 }, (_, i) => `A${String(i).padStart(3, '0')}.epub`);
    await seed(many);
    await clearDavCache(ALL_PATHS);

    const res = await propfind('/title/A/', '1');
    const xml = await res.text();
    // self + 200 本书 + 1 个"第 2 页"目录
    expect(Number(res.headers.get('x-dav-entries'))).toBe(202);
    expect(xml).toContain('<D:href>/dav/title/A/2/</D:href>');
    expect(xml).not.toContain('<D:href>/dav/title/A/2/3/</D:href>');

    const page2 = await propfind('/title/A/2/', '1');
    expect(page2.status).toBe(207);
    // self + 剩余 50 本；第 2 页不应再列出指向自己的分页目录
    expect(Number(page2.headers.get('x-dav-entries'))).toBe(51);
    expect(await page2.text()).not.toContain('<D:href>/dav/title/A/2/2/</D:href>');
  });

  it('页码越界返回 404', async () => {
    await seed(['Dune.epub']);
    await clearDavCache(ALL_PATHS);
    const res = await propfind('/title/D/99/', '1');
    expect(res.status).toBe(404);
  });
});

// ── 读写 ────────────────────────────────────────────────────────────────

describe('PUT / GET / DELETE', () => {
  it('PUT 新建后可在列表中看到，状态码 201', async () => {
    const put = await dav('/title/T/Twilight.epub', {
      method: 'PUT',
      headers: { 'content-type': 'application/epub+zip' },
      body: 'not-a-real-epub',
    });
    expect(put.status).toBe(201);

    await clearDavCache(ALL_PATHS);
    const list = await propfind('/title/T/', '1');
    expect(await list.text()).toContain('<D:href>/dav/title/T/Twilight.epub</D:href>');
  });

  it('PUT 覆盖同名文件返回 204 而不是新建', async () => {
    const first = await dav('/title/T/Twilight.epub', { method: 'PUT', body: 'v1' });
    expect(first.status).toBe(201);
    const second = await dav('/title/T/Twilight.epub', { method: 'PUT', body: 'v2-longer' });
    expect(second.status).toBe(204);
  });

  it('GET 返回 302 指向 R2 公开域，字节不过 Worker', async () => {
    await dav('/title/T/Twilight.epub', { method: 'PUT', body: 'x' });
    await clearDavCache(ALL_PATHS);

    const res = await dav('/title/T/Twilight.epub', { method: 'GET', redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/^https:\/\/books\.test\/books\//);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('HEAD 直接回元数据，不产生重定向', async () => {
    await dav('/title/T/Twilight.epub', { method: 'PUT', body: 'x' });
    await clearDavCache(ALL_PATHS);

    const res = await dav('/title/T/Twilight.epub', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('1');
    expect(res.headers.get('content-type')).toContain('epub');
  });

  it('叶子查找按文件名全局唯一，路径里的桶与书的实际分桶不要求一致', async () => {
    await dav('/title/T/Twilight.epub', { method: 'PUT', body: 'x' });
    await clearDavCache(ALL_PATHS);
    // 书实际归在 T 桶，但用 A 桶的路径也能取到
    const res = await propfind('/title/A/Twilight.epub', '0');
    expect(res.status).toBe(207);
    expect(await res.text()).toContain('Twilight.epub');
  });

  it('DELETE 后 404', async () => {
    await dav('/title/T/Twilight.epub', { method: 'PUT', body: 'x' });
    await clearDavCache(ALL_PATHS);

    const del = await dav('/title/T/Twilight.epub', { method: 'DELETE' });
    expect(del.status).toBe(204);

    await clearDavCache(ALL_PATHS);
    const after = await propfind('/title/T/Twilight.epub', '0');
    expect(after.status).toBe(404);
  });

  it('DELETE 会使已缓存的叶子立刻失效（不能让同步客户端误判文件还在）', async () => {
    await dav('/title/T/Twilight.epub', { method: 'PUT', body: 'x' });

    // 先 PROPFIND 一次把叶子写进缓存
    const before = await propfind('/title/T/Twilight.epub', '0');
    expect(before.status).toBe(207);
    expect(before.headers.get('x-dav-cache')).toBe('MISS');
    await before.text();

    const del = await dav('/title/T/Twilight.epub', { method: 'DELETE' });
    expect(del.status).toBe(204);

    // 不清缓存，直接再查：写入路径必须自己失效，而不是靠 TTL 过期
    const after = await propfind('/title/T/Twilight.epub', '0');
    expect(after.status).toBe(404);
  });

  it('PUT 后父列表的缓存立刻失效', async () => {
    // 先缓存一个空列表
    const before = await propfind('/title/T/', '1');
    expect(before.headers.get('x-dav-cache')).toBe('MISS');
    await before.text();

    await dav('/title/T/Twilight.epub', { method: 'PUT', body: 'x' });

    // 不手动清缓存
    const after = await propfind('/title/T/', '1');
    expect(after.headers.get('x-dav-cache')).toBe('MISS');
    expect(await after.text()).toContain('<D:href>/dav/title/T/Twilight.epub</D:href>');
  });

  it('PUT 到目录路径返回 405', async () => {
    const res = await dav('/title/T/', { method: 'PUT', body: 'x' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toContain('PROPFIND');
  });
});

// ── 未实现的方法要明确拒绝 ──────────────────────────────────────────────

describe('未实现的方法', () => {
  it('MKCOL 返回 405（目录树是虚拟的）', async () => {
    const res = await dav('/title/T/', { method: 'MKCOL' });
    expect(res.status).toBe(405);
  });

  it('LOCK/UNLOCK 返回 501（Class 1）', async () => {
    expect((await dav('/title/T/x.epub', { method: 'LOCK' })).status).toBe(501);
    expect((await dav('/title/T/x.epub', { method: 'UNLOCK' })).status).toBe(501);
  });

  it('MOVE/COPY 返回 501', async () => {
    expect((await dav('/title/T/x.epub', { method: 'MOVE' })).status).toBe(501);
    expect((await dav('/title/T/x.epub', { method: 'COPY' })).status).toBe(501);
  });
});

// ── 浏览器目录页 ────────────────────────────────────────────────────────

describe('浏览器目录页', () => {
  it('GET 目录返回 HTML 且可被 CDN 缓存', async () => {
    await seed(['Dune.epub']);
    await clearDavCache(ALL_PATHS);
    const res = await dav('/title/D/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toContain('max-age=300');
    expect(await res.text()).toContain('Dune.epub');
  });
});

// ── 管理接口鉴权 ────────────────────────────────────────────────────────

describe('admin 鉴权', () => {
  it('无 token 返回 403', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/admin/stats`);
    expect(res.status).toBe(403);
  });

  it('token 正确时返回统计', async () => {
    await seed(['Dune.epub', 'Neuromancer.epub']);
    const res = await SELF.fetch(`${ORIGIN}/api/admin/stats`, {
      headers: { authorization: 'Bearer test-token' },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { totalBooks: number; directoryCount: number };
    expect(json.totalBooks).toBe(2);
    // 目录总数是预算模型的关键输入，必须远低于 200
    expect(json.directoryCount).toBeLessThan(200);
  });
});
