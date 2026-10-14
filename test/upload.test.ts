/**
 * 上传 API 的端到端测试。
 *
 * 覆盖：配置缺失时的 fail-closed、Turnstile 未配时拒绝、参数校验、
 * complete 的对象存在性校验与元数据登记。
 *
 * 注意：这里不真正走 R2 预签名（那需要真实 R2 凭据 + 外部网络），
 * 只验证 Worker 侧的门禁逻辑与元数据登记路径。真实签名由 test/sigv4.test.ts 保证。
 */

import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { handleUploadInit } from '../src/api/upload';
import { rebuildBuckets } from '../src/lib/db';
import { resetLibrary, testEnv } from './setup';

const ORIGIN = 'https://webooks.test';

function api(path: string, body: unknown, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    body: JSON.stringify(body),
    ...init,
  });
}

beforeEach(async () => {
  await resetLibrary();
});

describe('/api/upload/init', () => {
  it('未配置 R2 凭据时 fail-closed（返回 503 并列出缺失项）', async () => {
    // 测试环境的 binding 里是有占位凭据的，所以这里**直接调用处理函数**并注入
    // 一个「缺凭据的 env」—— 比依赖全局 binding 是否配置更精确，
    // 也不会因为将来给测试环境补齐凭据而导致这条用例失效。
    const bare = { ...testEnv } as Record<string, unknown>;
    for (const k of [
      'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ACCOUNT_ID',
      'R2_BUCKET_NAME', 'TURNSTILE_SECRET',
    ]) {
      delete bare[k];
    }

    const req = new Request(`${ORIGIN}/api/upload/init`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'Book.epub', size: 1000, turnstileToken: 'fake' }),
    });
    const res = await handleUploadInit(req, bare as unknown as Parameters<typeof handleUploadInit>[1]);
    expect(res.status).toBe(503);
    const json = (await res.json()) as { error: string; missing: string[] };
    expect(json.error).toBe('upload-not-configured');
    expect(json.missing).toContain('R2_ACCESS_KEY_ID');
    // ⚠️ TURNSTILE_SECRET **不再**是无条件必填 —— 人机验证默认关闭，
    //   要求它等于「强制所有人配一个用不上的验证码」，而这正是之前
    //   「上传一直失败」的根因之一。改成开了验证时才要求（见下一条）。
    expect(json.missing).not.toContain('TURNSTILE_SECRET');
    // 通行证签名密钥是必填的 —— 但测试环境已经配了 WRITE_TOKEN，
    // 所以回落链生效，不必单独配 UPLOAD_TICKET_SECRET（这正是设计意图：
    // 不引入新的必填配置）。用「一个都不剩」的 env 单独验证这一点。
    expect(json.missing).not.toContain('UPLOAD_TICKET_SECRET');

    const noKeys = { ...bare, UPLOAD_TICKET_SECRET: undefined } as Record<string, unknown>;
    delete noKeys.WRITE_TOKEN;
    delete noKeys.ADMIN_TOKEN;
    const res2 = await handleUploadInit(
      new Request(`${ORIGIN}/api/upload/init`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: 'Book.epub', size: 1000 }),
      }),
      noKeys as unknown as Parameters<typeof handleUploadInit>[1],
    );
    const json2 = (await res2.json()) as { missing: string[] };
    expect(json2.missing).toContain('UPLOAD_TICKET_SECRET');
  });

  it('开启人机验证时，TURNSTILE_SECRET 恢复为必填', async () => {
    const bare = { ...testEnv, UPLOAD_REQUIRE_TURNSTILE: '1' } as Record<string, unknown>;
    for (const k of [
      'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ACCOUNT_ID',
      'R2_BUCKET_NAME', 'TURNSTILE_SECRET',
    ]) {
      delete bare[k];
    }
    const req = new Request(`${ORIGIN}/api/upload/init`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'Book.epub', size: 1000, turnstileToken: 'fake' }),
    });
    const res = await handleUploadInit(req, bare as unknown as Parameters<typeof handleUploadInit>[1]);
    expect(res.status).toBe(503);
    const json = (await res.json()) as { missing: string[] };
    expect(json.missing).toContain('TURNSTILE_SECRET');
  });

  it('默认（关闭验证）时，不带任何 token 也能通过 init', async () => {
    // 这是本次改动的核心行为：网页上传不再需要人机验证。
    // 防护没有降低 —— 真正的匿名写入口（WebDAV PUT）从来就没有验证，
    // 两者共用同一套 guardWrite 节流与每日配额。
    const res = await SELF.fetch(`${ORIGIN}/api/upload/init`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'Book.epub', size: 1000 }),
    });
    expect(res.status).not.toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.error).not.toBe('turnstile-token-required');
  });

  it('开启验证后，没给令牌会被拒（fail-closed 不被绕过）', async () => {
    const req = new Request(`${ORIGIN}/api/upload/init`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'Book.epub', size: 1000 }),
    });
    const withFlag = {
      ...testEnv,
      UPLOAD_REQUIRE_TURNSTILE: '1',
    } as unknown as Parameters<typeof handleUploadInit>[1];
    const res = await handleUploadInit(req, withFlag);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('turnstile-token-required');
  });

  it('拒绝不支持的格式（415，且在配置检查之前判定）', async () => {
    const res = await api('/api/upload/init', {
      filename: 'virus.exe', size: 1000, turnstileToken: 'fake',
    });
    expect(res.status).toBe(415);
    const json = (await res.json()) as { error: string; allowed: string[] };
    expect(json.error).toBe('unsupported-format');
    expect(json.allowed).toContain('epub');
    expect(json.allowed).toContain('cbz');
  });

  it('非法输入在校验配置之前就被拒（不泄露服务端配置状态）', async () => {
    const bare = {} as Parameters<typeof handleUploadInit>[1];
    const req = new Request(`${ORIGIN}/api/upload/init`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'x.exe', size: 1, turnstileToken: 't' }),
    });
    const res = await handleUploadInit(req, bare);
    // 即使 env 完全空白，也应该先报「格式不支持」，而不是 503 缺配置
    expect(res.status).toBe(415);
  });

  it('缺 filename 返回 400', async () => {
    const res = await api('/api/upload/init', { size: 10, turnstileToken: 'x' });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('filename-required');
  });

  it('GET 方法不允许', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/upload/init`, { method: 'GET' });
    expect(res.status).toBe(405);
  });
});

describe('/api/upload/complete', () => {
  it('key 不在 uploads/ 前缀时拒绝', async () => {
    const res = await api('/api/upload/complete', {
      key: 'books/../../etc', filename: 'x.epub', size: 10,
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('bad-key');
  });

  it('对象不存在时返回 404（防止前端伪造）', async () => {
    const res = await api('/api/upload/complete', {
      key: 'uploads/20260101/nonexistent.epub', filename: 'nonexistent.epub', size: 10,
    });
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('object-not-found');
  });
});

describe('/api/turnstile-config', () => {
  it('返回 siteKey 字段（值可为 null）', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/turnstile-config`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { siteKey: string | null };
    expect('siteKey' in json).toBe(true);
  });
});

describe('/upload 页面', () => {
  it('返回 HTML 且包含上传表单', async () => {
    const res = await SELF.fetch(`${ORIGIN}/upload`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('上架书籍');
    expect(html).toContain('/api/upload/init');
    // 拖放区必须键盘可达（role=button + tabindex）
    expect(html).toContain('id="drop"');
    expect(html).toContain('role="button"');
  });

  it('支持批量：文件选择可多选，且只接受电子书/漫画格式', async () => {
    const res = await SELF.fetch(`${ORIGIN}/upload`);
    const html = await res.text();
    // multiple 是批量上传的前提
    expect(html).toMatch(/<input[^>]+type="file"[^>]+multiple/);
    // accept 里带上了允许的格式，浏览器会据此过滤选择框
    expect(html).toMatch(/accept="[^"]*\.epub/);
    expect(html).toMatch(/accept="[^"]*\.cbz/);
    // 队列容器
    expect(html).toContain('id="queue"');
  });
});
describe('报错提示的可操作性', () => {
  const DAV = `${ORIGIN}/dav/${encodeURIComponent('最近收录')}`;

  it('覆盖已存在的书：说清「书已经有了」并给出替代方案', async () => {
    // 先放一本
    await SELF.fetch(`${DAV}/${encodeURIComponent('提示测试.epub')}`, {
      method: 'PUT',
      body: 'original-content',
      headers: { authorization: 'Bearer test-write-token' },
    });

    // 匿名覆盖（无口令）
    const res = await SELF.fetch(`${DAV}/${encodeURIComponent('提示测试.epub')}`, {
      method: 'PUT',
      body: 'hijacked',
    });
    expect(res.status).toBe(401);
    const text = await res.text();

    // 旧提示只有一句 "Authentication required for this operation"，
    // 用户会以为「我没登录」然后反复重试 —— 而这里根本没有账号可填。
    expect(text).toContain('已经在书库里');
    expect(text).toContain('提示测试.epub');
    // 给出可操作的两条出路
    expect(text).toMatch(/X-Write-Token|If-None-Match/);
    expect(text).toContain('换');

    // ⚠️ 关键：内容必须没被改掉
    const after = await SELF.fetch(`${DAV}/${encodeURIComponent('提示测试.epub')}`, {
      headers: { authorization: 'Bearer test-write-token' },
    });
    await after.text();
    const row = await testEnv.DB
      .prepare('SELECT size FROM books WHERE leaf_name = ?')
      .bind('提示测试.epub')
      .first<{ size: number }>();
    expect(row?.size, '被拒绝的覆盖不应改变原书大小').toBe(16);
  });

  it('体积超限：说清上限来自 Cloudflare，并指向网页上传', async () => {
    const res = await SELF.fetch(`${DAV}/${encodeURIComponent('超大.epub')}`, {
      method: 'PUT',
      body: 'x',
      headers: { 'content-length': String(200 * 1024 * 1024) },
    });
    expect(res.status).toBe(413);
    const text = await res.text();
    expect(text).toMatch(/100MB|100 MB/);
    expect(text).toContain('/upload');
  });

  it('不支持的格式：列出可接受的格式', async () => {
    const res = await SELF.fetch(`${DAV}/bad.rar`, { method: 'PUT', body: 'x' });
    expect(res.status).toBe(415);
    const text = await res.text();
    expect(text).toContain('rar');
    expect(text).toMatch(/EPUB|PDF/i);
  });

  it('网页上传同名文件被拒并说清原因', async () => {
    // 网页上传**完全没检测过重复** —— 匿名用户只要猜到文件名，
    // 就能把别人的书静默顶掉。这是本次修掉的一个真实缺陷。
    const db = testEnv.DB;
    await db.prepare(
      `INSERT INTO books (id, leaf_name, title, author, language, format, content_type, size,
         sha256, r2_key, title_letter, author_letter, format_bucket, kind_bucket, kind_source,
         published_at, created_at, updated_at, status, credit)
       VALUES ('dup01','网页重名.epub','网页重名','测试','zh','epub','application/epub+zip',100,
         'sha','books/dup01','W','C','ebook','ebook','derived',
         '2026-01-01','2026-01-01','2026-01-01','published','雷锋')`,
    ).run();

    // 往 uploads/ 放一个对象，模拟 init 之后的暂存
    await testEnv.BUCKET.put('uploads/dup-test', new TextEncoder().encode('new content'));
    await testEnv.BUCKET.put('books/dup01', new TextEncoder().encode('original'));

    const res = await SELF.fetch(`${ORIGIN}/api/upload/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'uploads/dup-test', filename: '网页重名.epub', size: 11 }),
    });
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string; message: string };
    expect(json.error).toBe('already-exists');
    expect(json.message).toContain('已经在书库里');
    expect(json.message).toMatch(/改名|换|文件名/);

    // 原书内容必须完好
    const obj = await testEnv.BUCKET.get('books/dup01');
    expect(await obj!.text()).toBe('original');
    // 暂存的垃圾文件应被清掉，不能留在 R2 里
    expect(await testEnv.BUCKET.get('uploads/dup-test'), '暂存文件应被删除').toBeNull();
  });

  it('上传页的错误提示要说清「能做什么」而不是复述状态码', async () => {
    const html = await (await SELF.fetch(`${ORIGIN}/upload`, { headers: { accept: 'text/html' } })).text();
    // 每个提示都应包含可操作信息
    expect(html).toContain('本站只接受');
    expect(html).toContain('改个文件名');
    expect(html).toMatch(/刷新页面重试/);
  });
});
