/**
 * URL 导入（`POST /api/admin/import/url`）测试。
 *
 * 这个端点的危险面在**拉取之前**：它会把任意 URL 的内容写进公开书库。
 * 所以测试的重点不是「能不能导入成功」，而是：
 *
 *   1. 内网地址在 fetch **调用之前**就被拒（不是靠返回码碰运气）
 *   2. 每一跳重定向都复检 —— 重定向到内网是 SSRF 最常见的绕过方式
 *   3. 上游给个 HTML 错误页时不能当成书入库
 *   4. 内容与扩展名不符（.epub 却不是 ZIP）必须拦下，且清理暂存对象
 *   5. 缺授权依据一律拒绝 —— 「说不清来源的书不进库」
 *
 * 注意：这里 stub 掉全局 fetch，**不访问外网**（workerd 测试环境也不允许）。
 */

import { SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isBlockedHost } from '../src/api/import-url';
import { resetLibrary, testEnv } from './setup';

const ORIGIN = 'https://webooks.test';
const ADMIN_HEADERS = {
  authorization: 'Bearer test-token',
  'content-type': 'application/json',
};

function importUrl(body: unknown, headers: Record<string, string> = ADMIN_HEADERS): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/admin/import/url`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

interface StubOptions {
  status?: number;
  headers?: Record<string, string>;
}

/** 把全局 fetch 换成一个只会返回固定内容的桩，并记录它被调用的地址。 */
function stubFetch(body: string | null, opts: StubOptions = {}) {
  const calls: string[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(body, { status: opts.status ?? 200, headers: opts.headers });
  });
  vi.stubGlobal('fetch', fn);
  return { calls, fn };
}

/** 列出暂存区里的对象 —— 用来断言失败路径真的清理干净了。 */
async function stagingObjects(): Promise<string[]> {
  const list = await testEnv.BUCKET.list({ prefix: 'uploads/import/' });
  return list.objects.map((o) => o.key);
}

async function seedDuplicate(leafName: string): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO books (id, leaf_name, title, author, language, format, content_type, size,
       sha256, r2_key, title_letter, author_letter, format_bucket, kind_bucket, kind_source,
       published_at, created_at, updated_at, status, credit)
     VALUES ('impdup01', ?1, '已存在的书', '测试', 'zh', 'epub', 'application/epub+zip', 100,
       NULL, 'books/impdup01', 'Y', 'C', 'epub', 'ebook', 'derived',
       '2026-01-01', '2026-01-01', '2026-01-01', 'published', '雷锋')`,
  )
    .bind(leafName)
    .run();
}

beforeEach(async () => {
  await resetLibrary();
  // R2 不随 resetLibrary 清空 —— 逐条删掉，避免上一个用例的暂存对象干扰断言
  for (const key of await stagingObjects()) {
    await testEnv.BUCKET.delete(key);
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isBlockedHost：内网判定', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.1.2.3', true],
    ['172.20.0.1', true],
    ['172.15.255.255', false],
    ['192.168.1.1', true],
    ['169.254.169.254', true],
    ['100.64.0.1', true],
    ['localhost', true],
    ['nas.local', true],
    ['metadata.internal', true],
    ['[::1]', true],
    ['::1', true],
    ['2130706433', true],
    ['8.8.8.8', false],
    ['www.gutenberg.org', false],
  ])('%s → %s', (host, blocked) => {
    expect(isBlockedHost(host)).toBe(blocked);
  });
});

describe('拒绝在拉取之前', () => {
  it('内网 IP 字面量：422，且 fetch 一次都没被调用', async () => {
    const { fn } = stubFetch('PK');
    const res = await importUrl({ url: 'http://127.0.0.1/book.epub', licenseBasis: 'public-domain' });
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('would-be-internal');
    expect(fn, '内网地址必须在 fetch 之前被拒').not.toHaveBeenCalled();
  });

  it('云元数据地址（169.254.169.254）同样拒绝', async () => {
    const { fn } = stubFetch('PK');
    const res = await importUrl({
      url: 'http://169.254.169.254/latest/meta-data/book.epub',
      licenseBasis: 'public-domain',
    });
    expect(res.status).toBe(422);
    expect(fn).not.toHaveBeenCalled();
  });

  it('非 http(s) 协议：422', async () => {
    const { fn } = stubFetch('PK');
    const res = await importUrl({ url: 'file:///etc/passwd.epub', licenseBasis: 'public-domain' });
    expect(res.status).toBe(422);
    expect(fn).not.toHaveBeenCalled();
  });

  it('URL 里带账号口令：422（口令会进日志与 source_url）', async () => {
    const { fn } = stubFetch('PK');
    const res = await importUrl({
      url: 'https://user:pass@example.com/book.epub',
      licenseBasis: 'public-domain',
    });
    expect(res.status).toBe(422);
    expect(fn).not.toHaveBeenCalled();
  });

  it('扩展名不在白名单：415，且不下载', async () => {
    const { fn } = stubFetch('PK');
    const res = await importUrl({ url: 'https://example.com/book.rar.exe', licenseBasis: 'public-domain' });
    expect(res.status).toBe(415);
    expect(fn).not.toHaveBeenCalled();
  });

  it('没扩展名又没显式 filename：415 并说清怎么办', async () => {
    const { fn } = stubFetch('PK');
    const res = await importUrl({ url: 'https://example.com/download', licenseBasis: 'public-domain' });
    expect(res.status).toBe(415);
    const json = (await res.json()) as { hint?: string };
    expect(json.hint).toContain('filename');
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('授权依据必填', () => {
  it('缺 licenseBasis：400，且不发起拉取', async () => {
    const { fn } = stubFetch('PK');
    const res = await importUrl({ url: 'https://example.com/book.epub' });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; allowed: string[] };
    expect(json.error).toBe('license-basis-required');
    expect(json.allowed).toEqual(['public-domain', 'authorized', 'user-declared']);
    expect(fn).not.toHaveBeenCalled();
  });

  it('licenseBasis=unknown 不接受（说不清来源的书不进库）', async () => {
    const { fn } = stubFetch('PK');
    const res = await importUrl({ url: 'https://example.com/book.epub', licenseBasis: 'unknown' });
    expect(res.status).toBe(400);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('重定向：每一跳都复检', () => {
  it('重定向到内网：422，且只请求了第一跳', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/x.epub' } });
      }),
    );
    const res = await importUrl({ url: 'https://example.com/book.epub', licenseBasis: 'public-domain' });
    expect(res.status).toBe(422);
    expect(calls).toEqual(['https://example.com/book.epub']);
  });

  it('超过 3 跳：422 too-many-redirects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 302, headers: { location: '/loop.epub' } })),
    );
    const res = await importUrl({ url: 'https://example.com/book.epub', licenseBasis: 'public-domain' });
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('too-many-redirects');
  });

  it('正常重定向会跟随，并把跳转后的 URL 记进 source_url', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input));
        if (calls.length === 1) {
          return new Response(null, { status: 301, headers: { location: 'https://cdn.example.com/a.epub' } });
        }
        return new Response('PK\x03\x04fake', { status: 200 });
      }),
    );
    const res = await importUrl({ url: 'https://example.com/book.epub', licenseBasis: 'public-domain' });
    expect(res.status).toBe(200);
    expect(calls).toEqual(['https://example.com/book.epub', 'https://cdn.example.com/a.epub']);

    const row = await testEnv.DB.prepare(
      `SELECT source_kind, source_url, license_basis, leaf_name FROM books WHERE leaf_name = ?`,
    )
      .bind('book.epub')
      .first<{ source_kind: string; source_url: string; license_basis: string }>();
    expect(row?.source_kind).toBe('url');
    expect(row?.source_url).toBe('https://cdn.example.com/a.epub');
    expect(row?.license_basis).toBe('public-domain');
  });
});

describe('上游内容校验', () => {
  it('上游返回 HTML 错误页（200 + text/html）：415，不当成书入库', async () => {
    stubFetch('<!doctype html><title>404</title>', {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
    const res = await importUrl({ url: 'https://example.com/book.epub', licenseBasis: 'public-domain' });
    expect(res.status).toBe(415);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('upstream-is-html');
    expect(await stagingObjects()).toEqual([]);
  });

  it('声明 .epub 但内容不是 ZIP：415 magic-mismatch，并清掉暂存对象', async () => {
    stubFetch('this is not an epub at all');
    const res = await importUrl({ url: 'https://example.com/book.epub', licenseBasis: 'public-domain' });
    expect(res.status).toBe(415);
    const json = (await res.json()) as { error: string; expected: string };
    expect(json.error).toBe('magic-mismatch');
    expect(json.expected).toBe('PK');
    expect(await stagingObjects(), '失败路径必须清理暂存对象').toEqual([]);
  });

  it('Content-Length 超限：413，且完全不读响应体', async () => {
    const cancel = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('PK'));
            // 不 close：如果实现去读体，这里会挂住；cancel 会被记录
          },
          cancel,
        });
        return new Response(stream, {
          status: 200,
          headers: { 'content-length': String(300 * 1024 * 1024) },
        });
      }),
    );
    const res = await importUrl({ url: 'https://example.com/big.epub', licenseBasis: 'public-domain' });
    expect(res.status).toBe(413);
  });

  it('无 Content-Length 时按实际字节数中断（流式计数）', async () => {
    // 直接调处理函数并注入一个小上限的 env：比给全局 binding 塞小值更精确
    const { handleImportUrl } = await import('../src/api/import-url');
    const big = new Uint8Array(1024).fill(0x41);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(big, { status: 200 })),
    );

    const req = new Request(`${ORIGIN}/api/admin/import/url`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/big.epub', licenseBasis: 'public-domain' }),
    });
    const env = { ...testEnv, UPLOAD_MAX_BYTES: '16' };
    const res = await handleImportUrl(req, env as typeof testEnv);
    expect(res.status).toBe(413);
    expect(await stagingObjects()).toEqual([]);
  });
});

describe('成功与冲突', () => {
  it('导入一本 EPUB：入库、来源落库、暂存清空', async () => {
    stubFetch('PK\x03\x04fake-epub-bytes', { headers: { 'content-type': 'application/epub+zip' } });
    const res = await importUrl({
      url: 'https://example.com/三体.epub',
      credit: '测试员',
      licenseBasis: 'authorized',
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      leafName: string;
      sourceKind: string;
      licenseBasis: string;
      size: number;
    };
    expect(json.ok).toBe(true);
    expect(json.leafName).toBe('三体.epub');
    expect(json.sourceKind).toBe('url');
    expect(json.licenseBasis).toBe('authorized');
    expect(json.size).toBeGreaterThan(0);

    const row = await testEnv.DB.prepare(
      `SELECT title, credit, source_kind, source_url, license_basis, ingested_by, r2_key
         FROM books WHERE leaf_name = ?`,
    )
      .bind('三体.epub')
      .first<Record<string, string>>();
    expect(row?.title).toContain('三体');
    expect(row?.credit).toBe('测试员');
    expect(row?.source_kind).toBe('url');
    // URL 存的是**规范化**形式：new URL() 会把非 ASCII 百分号编码。
    // 这是有意的 —— 存原样输入会让「同一个地址的两种写法」看起来像两个源。
    expect(row?.source_url).toBe(new URL('https://example.com/三体.epub').toString());
    expect(row?.ingested_by).toBe('admin');
    // 键必须是 books/<id>/<书名>，不能是 uploads/ 下的暂存键
    expect(row?.r2_key).toMatch(/^books\/[0-9a-f]{16}\/三体\.epub$/);

    expect(await stagingObjects()).toEqual([]);
  });

  it('同名书：409 already-exists，提示改名，暂存清理掉', async () => {
    await seedDuplicate('重名.epub');
    stubFetch('PK\x03\x04whatever');
    const res = await importUrl({ url: 'https://example.com/重名.epub', licenseBasis: 'public-domain' });
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string; message: string };
    expect(json.error).toBe('already-exists');
    expect(json.message).toContain('已经在书库里了');
    expect(json.message).toMatch(/改个文件名/);
    expect(await stagingObjects()).toEqual([]);
    // 原书内容不受影响
    const existing = await testEnv.DB.prepare(`SELECT size FROM books WHERE leaf_name = ?`)
      .bind('重名.epub')
      .first<{ size: number }>();
    expect(existing?.size).toBe(100);
  });
});

describe('鉴权', () => {
  it('没有 ADMIN_TOKEN：403，且不发起拉取', async () => {
    const { fn } = stubFetch('PK');
    const res = await importUrl(
      { url: 'https://example.com/book.epub', licenseBasis: 'public-domain' },
      { 'content-type': 'application/json' },
    );
    expect(res.status).toBe(403);
    expect(fn).not.toHaveBeenCalled();
  });
});
