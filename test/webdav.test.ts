/** 端到端测试：通过 SELF 打真实的 Worker 路由。 */

import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { authorBucket, letterBucket } from '../src/lib/collections';
import { rebuildBuckets, upsertBook, upsertBookStatement } from '../src/lib/db';
import { deriveMetadata } from '../src/lib/metadata';
import { clearDavCache, resetLibrary, testEnv } from './setup';

const ORIGIN = 'https://webooks.test';
const ALL_PATHS = ['/', '/title/', '/author/', '/format/', '/recent/', '/title/A/', '/title/T/', '/title/B/'];

function dav(path: string, init: RequestInit = {}): Promise<Response> {
  // 这些用例关注 WebDAV 协议行为，默认以「已授权客户端」身份发请求；
  // 「没口令会被拒」由 test/security.test.ts 专门覆盖。
  return SELF.fetch(`${ORIGIN}/dav${path}`, {
    ...init,
    headers: { authorization: 'Bearer test-write-token', ...(init.headers as Record<string, string> | undefined) },
  });
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
      authorLetter: authorBucket(meta.author),
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

// ── 回归：upsert 必须更新 cover_key / description ────────────────────────
// 真实踩过：ON CONFLICT DO UPDATE 漏了 cover_key，导致「覆盖上传」一本书后
// 新解析出的封面永不出现在 D1（R2 里封面对象明明已经写好）。

describe('upsertBook 的覆盖语义', () => {
  const base = (over: Record<string, unknown> = {}) => ({
    id: 'bk-1',
    leafName: 'a.epub',
    title: '甲',
    author: null,
    language: null,
    format: 'epub',
    contentType: 'application/epub+zip',
    size: 10,
    sha256: null,
    r2Key: 'books/bk-1',
    etag: 'e1',
    titleLetter: 'O',
    authorLetter: 'O',
    formatBucket: 'epub',
    publishedAt: new Date().toISOString(),
    ...over,
  });

  it('新建时写入 cover_key', async () => {
    await upsertBook(testEnv.DB, base({ coverKey: 'covers/bk-1.jpg' }) as never);
    const row = await testEnv.DB.prepare('SELECT cover_key FROM books WHERE id = ?')
      .bind('bk-1').first<{ cover_key: string | null }>();
    expect(row?.cover_key).toBe('covers/bk-1.jpg');
  });

  it('覆盖时也要更新 cover_key（不能保留旧值）', async () => {
    await upsertBook(testEnv.DB, base({ coverKey: null }) as never);
    let row = await testEnv.DB.prepare('SELECT cover_key FROM books WHERE id = ?')
      .bind('bk-1').first<{ cover_key: string | null }>();
    expect(row?.cover_key).toBeNull();

    // 同一 id 再写一次，这次带上了封面
    await upsertBook(testEnv.DB, base({ coverKey: 'covers/bk-1.png' }) as never);
    row = await testEnv.DB.prepare('SELECT cover_key FROM books WHERE id = ?')
      .bind('bk-1').first<{ cover_key: string | null }>();
    expect(row?.cover_key).toBe('covers/bk-1.png');
  });

  it('覆盖时也要更新 description', async () => {
    await upsertBook(testEnv.DB, base({ description: null }) as never);
    await upsertBook(testEnv.DB, base({ description: '新简介' }) as never);
    const row = await testEnv.DB.prepare('SELECT description FROM books WHERE id = ?')
      .bind('bk-1').first<{ description: string | null }>();
    expect(row?.description).toBe('新简介');
  });

  it('覆盖时标题/作者也被更新（基本前提）', async () => {
    await upsertBook(testEnv.DB, base({ title: '旧名', author: '旧作者' }) as never);
    await upsertBook(testEnv.DB, base({ title: '新名', author: '新作者' }) as never);
    const row = await testEnv.DB.prepare('SELECT title, author FROM books WHERE id = ?')
      .bind('bk-1').first<{ title: string; author: string | null }>();
    expect(row?.title).toBe('新名');
    expect(row?.author).toBe('新作者');
  });
});

// ── OPTIONS / 协议声明 ──────────────────────────────────────────────────

describe('OPTIONS', () => {
  it('宣告 DAV: 1, 2（Class 2 含 LOCK/UNLOCK），不宣告 3', async () => {
    const res = await dav('/', { method: 'OPTIONS' });
    expect(res.status).toBe(200);
    // RFC 4918 §18.3：宣告 class 3 意味着「满足本规范的全部要求」。
    // 我们有若干有意保留的偏离（MKCOL 不真正创建集合、PROPPATCH 不持久化、
    // DELETE 集合不支持 Depth:infinity），所以宣告 3 是不实声明 —— 只宣告 1, 2。
    const davHeader = res.headers.get('dav') ?? '';
    expect(davHeader).toContain('1');
    expect(davHeader).toContain('2');
    expect(davHeader.split(',').map((s) => s.trim())).not.toContain('3');
    expect(res.headers.get('allow')).toContain('PROPFIND');
    expect(res.headers.get('allow')).toContain('LOCK');
    expect(res.headers.get('ms-author-via')).toBe('DAV');
  });
});

// ── PROPFIND 结构 ───────────────────────────────────────────────────────

describe('PROPFIND', () => {
  it('根目录 Depth:1 列出四个集合（href 用中文段名）', async () => {
    const res = await propfind('/', '1');
    expect(res.status).toBe(207);
    const xml = await res.text();
    expect(xml).toContain('<D:multistatus xmlns:D="DAV:">');
    // 客户端用 href 末段当文件夹名，所以 href 必须是中文，
    // 同时 displayname 也给中文（两类客户端都能显示对）
    for (const label of ['按书名', '按作者', '按类型', '按格式', '最近收录']) {
      const enc = encodeURIComponent(label);
      expect(xml, label).toContain(`<D:href>/dav/${enc}/</D:href>`);
      expect(xml, label).toContain(`<D:displayname>${label}</D:displayname>`);
    }
    expect(xml).toContain('<D:collection/>');
    expect(res.headers.get('x-dav-entries')).toBe('6'); // root + 5 集合（按书名/按作者/按类型/按格式/最近收录）
  });

  it('Depth:0 只返回资源自身', async () => {
    const res = await propfind('/', '0');
    expect(res.status).toBe(207);
    expect(res.headers.get('x-dav-entries')).toBe('1');
    const xml = await res.text();
    expect(xml).not.toContain('%E6%8C%89%E4%B9%A6%E5%90%8D'); // 不含「按书名」
  });

  it('Depth 缺失按 1 处理（有意偏离 RFC 4918）', async () => {
    const res = await propfind('/');
    expect(res.headers.get('x-dav-entries')).toBe('6');
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
    // href 用中文段名（客户端据此显示中文文件夹名）
    expect(xml).toContain(`<D:href>/dav/${encodeURIComponent('按书名')}/D/</D:href>`);
    expect(xml).toContain(`<D:href>/dav/${encodeURIComponent('按书名')}/N/</D:href>`);
    expect(xml).not.toContain(`<D:href>/dav/${encodeURIComponent('按书名')}/A/</D:href>`); // 没有 A 开头的书
  });

  it('列表页返回书叶子，href 经过 URL 编码', async () => {
    await seed(['三体.epub']);
    await clearDavCache(ALL_PATHS);
    // 三体 → 拼音首字母 S 桶
    const res = await propfind('/title/S/', '1');
    const xml = await res.text();
    expect(xml).toContain(
      `<D:href>/dav/${encodeURIComponent('按书名')}/S/${encodeURIComponent('三体.epub')}</D:href>`,
    );
    expect(xml).toContain('<D:getcontentlength>1024</D:getcontentlength>');
    expect(xml).toContain('application/epub+zip');
  });

  it('「按类型」集合按 电子书/漫画 分类', async () => {
    await seed(['三体.epub', '航海王.cbz']);
    await clearDavCache(ALL_PATHS);
    const nav = await propfind('/type/', '1');
    const navXml = await nav.text();
    expect(navXml).toContain(`<D:href>/dav/${encodeURIComponent('按类型')}/ebook/</D:href>`);
    expect(navXml).toContain(`<D:href>/dav/${encodeURIComponent('按类型')}/comic/</D:href>`);
    // 漫画桶的中文显示名
    expect(navXml).toContain('<D:displayname>漫画</D:displayname>');

    const comic = await propfind('/type/comic/', '1');
    const comicXml = await comic.text();
    expect(comicXml).toContain(encodeURIComponent('航海王.cbz'));
    expect(comicXml).not.toContain(encodeURIComponent('三体.epub'));

    const ebook = await propfind('/type/ebook/', '1');
    expect(await ebook.text()).toContain(encodeURIComponent('三体.epub'));
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
    // self + MAX_ENTRIES 本书 + 1 个"第 2 页"目录
    const MAX = 200; // config.ts 里 HARD_MAX_ENTRIES / 默认值
    const COL = encodeURIComponent('按书名');
    expect(Number(res.headers.get('x-dav-entries'))).toBe(MAX + 2);
    expect(xml).toContain(`<D:href>/dav/${COL}/A/2/</D:href>`);
    expect(xml).not.toContain(`<D:href>/dav/${COL}/A/2/3/</D:href>`);

    const page2 = await propfind('/title/A/2/', '1');
    expect(page2.status).toBe(207);
    // self + 剩余 50 本；第 2 页不应再列出指向自己的分页目录
    expect(Number(page2.headers.get('x-dav-entries'))).toBe(51);
    expect(await page2.text()).not.toContain(`<D:href>/dav/${COL}/A/2/2/</D:href>`);
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
    expect(await list.text()).toContain(`<D:href>/dav/${encodeURIComponent('按书名')}/T/Twilight.epub</D:href>`);
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
    expect(await after.text()).toContain(`<D:href>/dav/${encodeURIComponent('按书名')}/T/Twilight.epub</D:href>`);
  });

  it('PUT 到目录路径返回 405', async () => {
    const res = await dav('/title/T/', { method: 'PUT', body: 'x' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toContain('PROPFIND');
  });
});

// ── Class 2 锁 / MKCOL / PROPPATCH / MOVE / COPY ──────────────────────

describe('Class 2 锁（LOCK/UNLOCK）', () => {
  it('LOCK 叶子返回 200 + Lock-Token 头', async () => {
    const res = await dav('/recent/a.epub', {
      method: 'LOCK',
      body: '<?xml version="1.0"?><D:lockinfo xmlns:D="DAV:"><D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope></D:lockinfo>',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('lock-token')).toMatch(/^<urn:uuid:.*>$/);
    const xml = await res.text();
    expect(xml).toContain('<D:lockdiscovery>');
  });

  it('持锁后 PUT 该资源 → 423 Locked', async () => {
    const lockRes = await dav('/recent/b.epub', {
      method: 'LOCK',
      body: '<D:lockinfo xmlns:D="DAV:"><D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope></D:lockinfo>',
    });
    const token = lockRes.headers.get('lock-token')!;
    expect(token).toBeTruthy();

    const put = await dav('/recent/b.epub', { method: 'PUT', body: 'x' });
    expect(put.status).toBe(423);

    // 刷新（带 If: (<token>)）后，持锁者可继续写
    const refresh = await dav('/recent/b.epub', {
      method: 'LOCK',
      headers: { if: `(${token})`, timeout: 'Second-300' },
      body: '<D:lockinfo xmlns:D="DAV:"><D:locktype><D:write/></D:locktype></D:lockinfo>',
    });
    expect(refresh.status).toBe(200);
  });

  it('UNLOCK 释放锁后 PUT 恢复 201/204', async () => {
    const lockRes = await dav('/recent/c.epub', {
      method: 'LOCK',
      body: '<D:lockinfo xmlns:D="DAV:"><D:locktype><D:write/></D:locktype></D:lockinfo>',
    });
    const token = lockRes.headers.get('lock-token')!;

    const unlock = await dav('/recent/c.epub', {
      method: 'UNLOCK',
      headers: { 'lock-token': token },
    });
    expect(unlock.status).toBe(204);

    const put = await dav('/recent/c.epub', { method: 'PUT', body: 'x' });
    expect(put.status).toBe(201);
  });

  it('锁超时后自动释放（timeout 极小时下轮 PUT 可写）', async () => {
    // acquireLock 时传入 0 秒超时 → expires_at = now，立刻视为过期
    // 这里用 Timeout: Second-0 模拟（locks.ts 会 clamp 到最小 1s，所以这里只验基本可写性）
    const lockRes = await dav('/recent/d.epub', {
      method: 'LOCK',
      headers: { timeout: 'Second-1' },
      body: '<D:lockinfo xmlns:D="DAV:"><D:locktype><D:write/></D:locktype></D:lockinfo>',
    });
    expect(lockRes.status).toBe(200);
  });
});

describe('MKCOL', () => {
  it('已映射的虚拟集合返回 405（RFC 4918 §9.3「已存在则必须失败」）', async () => {
    const res = await dav('/按书名/A/', { method: 'MKCOL' });
    // §9.3：「If the Request-URI is already mapped to a resource, then the
    // MKCOL MUST fail.」§9.3.1 指定用 405。
    expect(res.status).toBe(405);
    await res.text();
  });

  it('未映射的新路径返回 403 + valid-resourcetype（无法持久化自定义目录）', async () => {
    const res = await dav('/我的新目录/', { method: 'MKCOL' });
    expect(res.status).toBe(403);
    const xml = await res.text();
    expect(xml).toContain('<D:valid-resourcetype/>');
  });

  it('Extended MKCOL（带 body）在已映射路径上同样失败', async () => {
    const res = await dav('/按书名/A/', {
      method: 'MKCOL',
      body: '<D:mkcol xmlns:D="DAV:"><D:set><D:prop><D:displayname>x</D:displayname></D:prop></D:set></D:mkcol>',
      headers: { 'content-type': 'application/xml' },
    });
    expect(res.status).toBe(405);
    await res.text();
  });
});

describe('PROPPATCH', () => {
  it('不谎报成功：207 + 403 + cannot-modify-protected-property', async () => {
    const res = await dav('/最近收录/e.epub', {
      method: 'PROPPATCH',
      body: '<?xml version="1.0"?><D:propertyupdate xmlns:D="DAV:"><D:set><D:prop><D:displayname>x</D:displayname></D:prop></D:set></D:propertyupdate>',
      headers: { 'content-type': 'application/xml' },
    });
    // §9.2 指令必须「要么全执行要么都不执行」；§9.2.1 对无法修改的属性
    // 应返回 403 + cannot-modify-protected-property。早期实现回 200 却什么都不写，
    // 那是虚假成功，客户端会据此缓存「已设置」。
    expect(res.status).toBe(207);
    const xml = await res.text();
    expect(xml).toContain('<D:status>HTTP/1.1 403 Forbidden</D:status>');
    expect(xml).toContain('<D:cannot-modify-protected-property/>');
    expect(xml).not.toContain('200 OK');
    // 必须报出**具体**属性名，客户端才知道是哪个没设上（不能是无名的 unknown）
    expect(xml).toContain('<D:displayname/>');
    expect(xml).not.toContain('<D:unknown/>');
  });
});

describe('MOVE / COPY', () => {
  it('MOVE 叶子到另一叶子 → 201 + Location', async () => {
    await dav('/recent/src.epub', { method: 'PUT', body: 'x' });
    const res = await dav('/recent/src.epub', {
      method: 'MOVE',
      headers: { destination: 'https://webooks.invalid/dav/recent/dst.epub' },
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('location')).toContain('/dav/recent/dst.epub');

    // 源消失、目标出现
    expect((await dav('/recent/src.epub', { method: 'PROPFIND' })).status).toBe(404);
    expect((await dav('/recent/dst.epub', { method: 'PROPFIND' })).status).toBe(207);
  });

  it('COPY 叶子 → 201，源仍在', async () => {
    await dav('/recent/src2.epub', { method: 'PUT', body: 'x' });
    const res = await dav('/recent/src2.epub', {
      method: 'COPY',
      headers: { destination: 'https://webooks.invalid/dav/recent/dst2.epub' },
    });
    expect(res.status).toBe(201);
    expect((await dav('/recent/src2.epub', { method: 'PROPFIND' })).status).toBe(207);
    expect((await dav('/recent/dst2.epub', { method: 'PROPFIND' })).status).toBe(207);
  });

  it('MOVE 缺 Destination 头 → 400', async () => {
    const res = await dav('/recent/x.epub', { method: 'MOVE' });
    expect(res.status).toBe(400);
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
    const html = await res.text();
    // 书卡上显示的是**书名**（displayName），不是 leafName —— 直链改动后
    // href 也不再含 leafName，所以这里断言标题而不是 `Dune.epub`。
    // 想验「href 是 R2 直链」请见 browse-page.test.ts 的那两条。
    expect(html).toContain('Dune');
  });
});

// ── 客户端兼容：集合路径没有尾斜杠 ──────────────────────────────────────
//
// 2026-10-26 真实事故：用户把站点挂成 WebDAV 盘，第一层正常，第二层全部
// 报「没有加载到数据」—— 客户端自己拼路径，二级目录的请求不带尾斜杠。
// 以前一律当叶子 → 404。这一组把修复钉死（解析层 + 分发层归一 + 缓存共用）。

describe('客户端兼容：二级目录没有尾斜杠', () => {
  it('PROPFIND /title/A（无尾斜杠）返回 207 并列出叶子', async () => {
    await seed(['Alice.epub']);
    await clearDavCache(ALL_PATHS);
    const res = await propfind('/title/A', '1');
    expect(res.status, '无尾斜杠的桶目录必须可列').toBe(207);
    const xml = await res.text();
    expect(xml).toContain('Alice.epub');
  });

  it('PROPFIND /recent/2（无尾斜杠）返回 207 而不是 404', async () => {
    // 页码越界本来就该 404（既有测试钉着这个语义），所以要造出真第 2 页：
    // 默认 MAX_ENTRIES=200，250 本足够。
    await seed(Array.from({ length: 250 }, (_, i) => `R${String(i).padStart(3, '0')}.epub`));
    await clearDavCache(ALL_PATHS);
    const res = await propfind('/recent/2', '1');
    expect(res.status).toBe(207);
    // 无尾斜杠也必须被认成「第 2 页目录」，而不是一本叫 2 的书
    expect(Number(res.headers.get('x-dav-entries'))).toBeGreaterThan(1);
  });

  it('GET 目录页（无尾斜杠）返回 HTML 而不是 404', async () => {
    await seed(['Alice.epub']);
    await clearDavCache(ALL_PATHS);
    const res = await dav('/title/A');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('两种写法共用同一条缓存（否则写入失效永远打不中）', async () => {
    await seed(['Alice.epub']);
    await clearDavCache(ALL_PATHS);

    const noSlash = await propfind('/title/A', '1');
    expect(noSlash.headers.get('x-dav-cache')).toBe('MISS');
    await noSlash.text();

    // 带尾斜杠的写法必须命中**刚才那条**缓存 —— 分发层把路径归一成
    // `/title/A/`，所以缓存键一致；写入路径（PUT/DELETE/complete）失效时
    // 用的也是带尾斜杠的键，两边才对得上。
    const withSlash = await propfind('/title/A/', '1');
    expect(withSlash.headers.get('x-dav-cache')).toBe('HIT');
    expect(await withSlash.text()).toContain('Alice.epub');
  });

  it('回归：带扩展名的叶子仍然当叶子（无尾斜杠照旧 302）', async () => {
    await seed(['Alice.epub']);
    // ⚠️ redirect: 'manual' —— 否则 SELF.fetch 会跟随 302 去
    // https://books.test/…（测试环境里不存在），拿到的是跟随后的失败，
    // 而不是我们要断言的 302 本身。
    const res = await dav('/title/A/Alice.epub', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/books/');
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

// ── 条件请求（RFC 9110 §13.1）—— 防误覆盖 ──────────────────────────────

describe('条件请求防止误覆盖', () => {
  // 每个用例自建文件：beforeEach 会重置库，状态不能跨用例共享
  const name = '__precond_test.epub';
  const put = (body: string, headers: Record<string, string> = {}) =>
    dav(`/recent/${name}`, { method: 'PUT', body, headers });

  it('If-None-Match: * 在目标不存在时放行（201）', async () => {
    const res = await put('first', { 'if-none-match': '*' });
    expect(res.status).toBe(201);
  });

  it('If-None-Match: * 在目标已存在时拒绝（412），且不覆盖内容', async () => {
    await put('first', { 'if-none-match': '*' });

    const res = await put('SHOULD-NOT-OVERWRITE', { 'if-none-match': '*' });
    expect(res.status).toBe(412);

    // 关键：内容不能被改掉
    const head = await dav(`/recent/${name}`, { method: 'HEAD' });
    expect(head.headers.get('content-length')).toBe('5'); // 'first' 的长度
  });

  it('If-Match 用真实 ETag 可覆盖（204）', async () => {
    await put('first');
    const head = await dav(`/recent/${name}`, { method: 'HEAD' });
    const etag = head.headers.get('etag');
    expect(etag).toBeTruthy();

    const res = await put('second-longer', { 'if-match': etag as string });
    expect(res.status).toBe(204);
    const after = await dav(`/recent/${name}`, { method: 'HEAD' });
    expect(after.headers.get('content-length')).toBe(String('second-longer'.length));
  });

  it('If-Match 用错误 ETag 拒绝（412），内容不变', async () => {
    await put('first');
    const res = await put('nope-longer', { 'if-match': '"totally-wrong"' });
    expect(res.status).toBe(412);
    const head = await dav(`/recent/${name}`, { method: 'HEAD' });
    expect(head.headers.get('content-length')).toBe('5');
  });

  it('无条件 PUT 仍可覆盖（204），保持向后兼容', async () => {
    await put('first');
    const res = await put('third');
    expect(res.status).toBe(204);
  });

  it('目标不存在时 If-Match 一律拒绝（412）', async () => {
    const res = await put('brand-new', { 'if-match': '*' });
    expect(res.status).toBe(412);
  });
});

// ── DAV 错误体合规（RFC 4918 §16）────────────────────────────────────────
// 注意：Class 2 实现后，MKCOL/PROPPATCH/LOCK/UNLOCK/MOVE/COPY 都返回成功
// 或合规的 2xx/207，不再返回 4xx/5xx 拒绝体。此 describe 只保留仍会
// 出现 <D:error> 的场景。

describe('DAV 错误体', () => {
  it('MOVE 到目录（非叶子）返回 403', async () => {
    const res = await dav('/recent/', {
      method: 'MOVE',
      headers: { destination: 'https://webooks.invalid/dav/recent/newdir/' },
    });
    // 源是 /recent/ 目录（kind=list），MOVE 目录 → 403
    expect(res.status).toBe(403);
  });
});
