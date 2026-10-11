/**
 * 安全回归测试 —— 锁住已修复的漏洞，防止回退。
 *
 * 覆盖：
 *   · 安全响应头（HTML 带 CSP，协议响应带 nosniff）
 *   · 封面类型白名单（防任意内容托管到公开域名）
 *   · WebDAV PUT 大小上限（防存储配额耗尽）
 *   · 上传完成接口的文件名清洗（与 WebDAV 一致）
 *   · 过期锁清扫（防 D1 表无限膨胀）
 */

import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { sweepExpiredLocks } from '../src/lib/locks';
import { safeContentTypeFor } from '../src/lib/metadata';
import { resetLibrary, testEnv } from './setup';

const ORIGIN = 'https://webooks.test';

beforeEach(async () => {
  await resetLibrary();
});

describe('安全响应头', () => {
  it('HTML 页面带 CSP / nosniff / frame-options / referrer-policy', async () => {
    for (const path of ['/', '/upload']) {
      const res = await SELF.fetch(`${ORIGIN}${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('x-content-type-options'), path).toBe('nosniff');
      expect(res.headers.get('x-frame-options'), path).toBe('DENY');
      expect(res.headers.get('referrer-policy'), path).toBeTruthy();
      const csp = res.headers.get('content-security-policy') ?? '';
      expect(csp, path).toContain("default-src 'none'");
      expect(csp, path).toContain("frame-ancestors 'none'");
      expect(csp, path).toContain("object-src 'none'");
    }
  });

  it('WebDAV 协议响应带 nosniff，但不带 CSP（避免客户端误判）', async () => {
    const res = await SELF.fetch(`${ORIGIN}/dav/`, {
      method: 'PROPFIND',
      headers: { depth: '0' },
    });
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBeNull();
  });

  it('JSON 接口带 nosniff', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/turnstile-config`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('WebDAV PUT 大小上限', () => {
  it('声明超过上限时返回 413 且不写库', async () => {
    // 造一个超过上限的请求：只声明 Content-Length，不带真实 body
    const res = await SELF.fetch(`${ORIGIN}/dav/recent/huge.epub`, {
      method: 'PUT',
      headers: { 'content-length': String(300 * 1024 * 1024), 'content-type': 'application/epub+zip' },
      body: 'x',
    });
    expect([413, 400]).toContain(res.status);
  });

  it('正常大小仍可写入（回归）', async () => {
    const res = await SELF.fetch(`${ORIGIN}/dav/recent/normal.epub`, {
      method: 'PUT',
      headers: { 'content-type': 'application/epub+zip' },
      body: 'small',
    });
    expect([201, 204]).toContain(res.status);
  });
});

describe('上传完成接口的文件名清洗', () => {
  it('危险字符与超长名被清洗，与 WebDAV 规则一致', async () => {
    const key = 'uploads/2026-01-01/abc123/raw.epub';
    await testEnv.BUCKET.put(key, new TextEncoder().encode('x'), {
      httpMetadata: { contentType: 'application/epub+zip' },
    });

    const nasty = `<script>alert(1)</script>${'A'.repeat(500)}.epub`;
    const res = await SELF.fetch(`${ORIGIN}/api/upload/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, filename: nasty, size: 1, contentType: 'application/epub+zip' }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { leafName: string };

    // 尖括号等必须被替换成下划线
    expect(json.leafName).not.toContain('<');
    expect(json.leafName).not.toContain('>');
    // 长度受 sanitiseLeafName 的 200 字符上限约束
    expect(json.leafName.length).toBeLessThanOrEqual(200);
    // 扩展名保留
    expect(json.leafName.endsWith('.epub')).toBe(true);
  });

  it('D1 里存的 leaf_name 也是清洗后的值', async () => {
    const key = 'uploads/2026-01-01/def456/raw2.epub';
    await testEnv.BUCKET.put(key, new TextEncoder().encode('x'), {
      httpMetadata: { contentType: 'application/epub+zip' },
    });
    await SELF.fetch(`${ORIGIN}/api/upload/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, filename: 'bad<>name.epub', size: 1 }),
    });
    const row = await testEnv.DB.prepare(
      `SELECT leaf_name FROM books ORDER BY rowid DESC LIMIT 1`,
    ).first<{ leaf_name: string }>();
    expect(row?.leaf_name).not.toContain('<');
    expect(row?.leaf_name).not.toContain('>');
  });
});

describe('Content-Type 注入防护（存储层）', () => {
  /** 取某本书在 R2 里的实际对象元数据（这才是对外提供的类型） */
  async function storedType(leafName: string): Promise<string> {
    const row = await testEnv.DB.prepare('SELECT r2_key FROM books WHERE leaf_name = ?')
      .bind(leafName).first<{ r2_key: string }>();
    expect(row?.r2_key, `D1 里找不到 ${leafName}`).toBeTruthy();
    const head = await testEnv.BUCKET.head(row!.r2_key);
    return head?.httpMetadata?.contentType ?? '';
  }

  it('PUT 声明 text/html 时，R2 里存的仍是扩展名推导的安全类型', async () => {
    // 真实漏洞：R2 对外提供的 Content-Type 来自写入时的 httpMetadata，
    // 早期实现信任客户端声明，于是 PUT 一个 Content-Type: text/html 的 .epub
    // 就能让 books.<域名>/books/<id> 以 text/html 返回任意 HTML/JS。
    const res = await SELF.fetch(`${ORIGIN}/dav/recent/xsstest.epub`, {
      method: 'PUT',
      headers: { 'content-type': 'text/html' },
      body: '<!doctype html><script>alert(1)</script>',
    });
    expect([201, 204]).toContain(res.status);

    const stored = await storedType('xsstest.epub');
    expect(stored).not.toContain('text/html');
    expect(stored).toBe('application/epub+zip');
  });

  it('.html 文件按纯文本存储，不以 text/html 提供', async () => {
    await SELF.fetch(`${ORIGIN}/dav/recent/page.html`, {
      method: 'PUT',
      headers: { 'content-type': 'text/html' },
      body: '<h1>hi</h1>',
    });
    expect(await storedType('page.html')).toBe('text/plain; charset=utf-8');
  });

  it('伪造任意类型都被忽略（application/javascript 也不行）', async () => {
    await SELF.fetch(`${ORIGIN}/dav/recent/tricky.txt`, {
      method: 'PUT',
      headers: { 'content-type': 'application/javascript' },
      body: 'alert(1)',
    });
    expect(await storedType('tricky.txt')).toBe('text/plain; charset=utf-8');
  });

  it('safeContentTypeFor：未知扩展名退回 application/octet-stream', () => {
    expect(safeContentTypeFor('a.epub')).toBe('application/epub+zip');
    expect(safeContentTypeFor('a.pdf')).toBe('application/pdf');
    expect(safeContentTypeFor('a.html')).toBe('text/plain; charset=utf-8');
    expect(safeContentTypeFor('a.svg')).toBe('application/octet-stream');
    expect(safeContentTypeFor('noext')).toBe('application/octet-stream');
    expect(safeContentTypeFor('weird.xyz')).toBe('application/octet-stream');
  });
});

describe('破坏性操作的写口令保护', () => {
  /** 不带任何凭据的原始请求（path 为完整路径，含 /dav 前缀） */
  function anon(path: string, init: RequestInit = {}): Promise<Response> {
    // redirect: 'manual' —— 否则 fetch 会跟随 GET 叶子的 302 跳到 R2 公开域
    return SELF.fetch(`${ORIGIN}${path}`, { redirect: 'manual', ...init });
  }
  /** 带正确口令 */
  function auth(path: string, init: RequestInit = {}): Promise<Response> {
    return SELF.fetch(`${ORIGIN}${path}`, {
      redirect: 'manual',
      ...init,
      headers: { authorization: 'Bearer test-write-token', ...(init.headers as Record<string, string> | undefined) },
    });
  }
  const put = (body = 'x'): RequestInit => ({
    method: 'PUT',
    headers: { 'content-type': 'application/epub+zip' },
    body,
  });

  it('新书上传保持匿名可用（不能误伤核心功能）', async () => {
    const res = await anon('/dav/recent/newbook.epub', put());
    expect([201, 204]).toContain(res.status);
  });

  it('覆盖已有书：无口令 → 401，且有 WWW-Authenticate（客户端才会弹密码框）', async () => {
    await auth('/dav/recent/existing.epub', put());
    const res = await anon('/dav/recent/existing.epub', put('replaced'));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Basic');
  });

  it('覆盖已有书：带口令 → 204', async () => {
    await auth('/dav/recent/existing2.epub', put());
    const res = await auth('/dav/recent/existing2.epub', put('replaced'));
    expect(res.status).toBe(204);
  });

  it('带 If-None-Match: * 的「只新建」请求无需口令（它不会改动任何东西）', async () => {
    await auth('/dav/recent/guard.epub', put());
    const res = await anon('/dav/recent/guard.epub', {
      ...put('nope'),
      headers: { 'content-type': 'application/epub+zip', 'if-none-match': '*' },
    });
    expect(res.status).toBe(412); // 已存在 → 前置条件失败，而不是 401
  });

  it('删除：无口令 → 401，且书仍然在', async () => {
    await auth('/dav/recent/keepme.epub', put());
    const del = await anon('/dav/recent/keepme.epub', { method: 'DELETE' });
    expect(del.status).toBe(401);
    const still = await anon('/dav/recent/keepme.epub', { method: 'PROPFIND', headers: { depth: '0' } });
    expect(still.status).toBe(207);
  });

  it('删除：带口令 → 204，书消失', async () => {
    await auth('/dav/recent/deleteme.epub', put());
    const del = await auth('/dav/recent/deleteme.epub', { method: 'DELETE' });
    expect(del.status).toBe(204);
    const gone = await anon('/dav/recent/deleteme.epub', { method: 'PROPFIND', headers: { depth: '0' } });
    expect(gone.status).toBe(404);
  });

  it('改名（MOVE）：无口令 → 401', async () => {
    await auth('/dav/recent/moveme.epub', put());
    const res = await anon('/dav/recent/moveme.epub', {
      method: 'MOVE',
      headers: { destination: `${ORIGIN}/dav/recent/renamed.epub` },
    });
    expect(res.status).toBe(401);
  });

  it('口令错误 → 401（且不能靠长度差异绕过）', async () => {
    await auth('/dav/recent/len.epub', put());
    for (const bad of ['wrong', 'test-write-toke', 'test-write-tokenX']) {
      const res = await SELF.fetch(`${ORIGIN}/dav/recent/len.epub`, {
        ...put('x'),
        headers: { 'content-type': 'application/epub+zip', authorization: `Bearer ${bad}` },
      });
      expect(res.status, bad).toBe(401);
    }
  });

  it('Basic 认证也接受（WebDAV 客户端用这种方式）', async () => {
    await auth('/dav/recent/basic.epub', put());
    const b64 = btoa('anyuser:test-write-token');
    const res = await SELF.fetch(`${ORIGIN}/dav/recent/basic.epub`, {
      ...put('via basic'),
      headers: { 'content-type': 'application/epub+zip', authorization: `Basic ${b64}` },
    });
    expect(res.status).toBe(204);
  });

  it('读操作完全不受口令影响（挂载后能正常浏览）', async () => {
    const created = await auth('/dav/recent/readable.epub', put());
    expect([201, 204]).toContain(created.status);

    // 目录列表可匿名读取
    const pf = await anon('/dav/recent/', { method: 'PROPFIND', headers: { depth: '1' } });
    expect(pf.status).toBe(207);

    // 叶子可匿名下载（302 → R2 公开域）
    const get = await anon('/dav/recent/readable.epub', { method: 'GET' });
    expect(get.status).toBe(302);
    expect(get.headers.get('location')).toContain('/books/');

    // 元数据可匿名读取
    const head = await anon('/dav/recent/readable.epub', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('accept-ranges')).toBe('bytes');
  });
});

describe('管理后台 API', () => {
  it('无 token 一律 403/404', async () => {
    for (const p of ['/api/admin/books', '/api/admin/stats']) {
      const res = await SELF.fetch(`${ORIGIN}${p}`);
      expect([403, 404]).toContain(res.status);
    }
  });

  it('带 token 可列出书并返回安全状态', async () => {
    await SELF.fetch(`${ORIGIN}/dav/recent/adminlist.epub`, {
      method: 'PUT',
      headers: { 'content-type': 'application/epub+zip', authorization: 'Bearer test-write-token' },
      body: 'x',
    });
    const res = await SELF.fetch(`${ORIGIN}/api/admin/books`, {
      headers: { authorization: 'Bearer test-token' },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      total: number; books: Array<{ leafName: string }>;
      security: Array<{ key: string; ok: boolean }>;
    };
    expect(json.total).toBeGreaterThan(0);
    expect(json.books.some((b) => b.leafName === 'adminlist.epub')).toBe(true);
    // 安全状态里必须能看到写口令已启用
    expect(json.security.find((s) => s.key === 'writeToken')?.ok).toBe(true);
  });

  it('带 token 可批量删除（同时清理 R2 对象）', async () => {
    await SELF.fetch(`${ORIGIN}/dav/recent/todelete.epub`, {
      method: 'PUT',
      headers: { 'content-type': 'application/epub+zip', authorization: 'Bearer test-write-token' },
      body: 'x',
    });
    const res = await SELF.fetch(`${ORIGIN}/api/admin/delete`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ leafNames: ['todelete.epub'] }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { deletedCount: number; deleted: string[] };
    expect(json.deletedCount).toBe(1);
    expect(json.deleted).toContain('todelete.epub');

    const row = await testEnv.DB.prepare('SELECT id FROM books WHERE leaf_name = ?')
      .bind('todelete.epub').first();
    expect(row).toBeNull();
  });

  it('删除不存在的书不报错，只在 missing 里列出', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/admin/delete`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ leafNames: ['never-existed.epub'] }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { deletedCount: number; missing: string[] };
    expect(json.deletedCount).toBe(0);
    expect(json.missing).toContain('never-existed.epub');
  });

  it('/admin 页面可访问，且不带任何敏感数据', async () => {
    const res = await SELF.fetch(`${ORIGIN}/admin`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    // 后台页面绝不能进共享缓存
    expect(res.headers.get('cache-control')).toContain('no-store');
    const html = await res.text();
    expect(html).not.toContain('test-token');
    expect(html).not.toContain('test-write-token');
  });
});

describe('过期锁清扫', () => {  it('sweepExpiredLocks 删除过期行、保留活锁', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO locks (token, resource, owner, type, depth, timeout_sec, created_at, expires_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).bind('<urn:uuid:expired>', '/expired', null, 'exclusive', '0', 1, past, past),
      testEnv.DB.prepare(
        `INSERT INTO locks (token, resource, owner, type, depth, timeout_sec, created_at, expires_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).bind('<urn:uuid:live>', '/live', null, 'exclusive', '0', 300, past, future),
    ]);

    const removed = await sweepExpiredLocks(testEnv.DB);
    expect(removed).toBe(1);

    const rows = await testEnv.DB.prepare('SELECT token FROM locks').all<{ token: string }>();
    expect(rows.results?.map((r) => r.token)).toEqual(['<urn:uuid:live>']);
  });

  it('LOCK 请求会顺带清理过期锁', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    await testEnv.DB.prepare(
      `INSERT INTO locks (token, resource, owner, type, depth, timeout_sec, created_at, expires_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).bind('<urn:uuid:stale>', '/stale', null, 'exclusive', '0', 1, past, past).run();

    await SELF.fetch(`${ORIGIN}/dav/recent/x.epub`, {
      method: 'LOCK',
      headers: { 'content-type': 'application/xml' },
      body: '<D:lockinfo xmlns:D="DAV:"><D:locktype><D:write/></D:locktype></D:lockinfo>',
    });

    const stale = await testEnv.DB.prepare(`SELECT token FROM locks WHERE token = ?`)
      .bind('<urn:uuid:stale>').first();
    expect(stale).toBeNull();
  });
});
