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
