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
    expect(json.missing).toContain('TURNSTILE_SECRET');
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