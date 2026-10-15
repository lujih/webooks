import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const ORIGIN = 'https://webooks.test';
const API = `${ORIGIN}/api/requests`;

/**
 * ⚠️ 这一组是**安全测试**，不是性能测试。
 *
 * 背景：`wrangler.jsonc` 里的 `cache.enabled` 打开后，Cloudflare 会在调用
 * Worker **之前**先查缓存 —— 命中时 Worker 一次都不跑，这是唯一能省下
 * 每日 100,000 请求额度的机制（Cache API 做不到，官方明说
 * 「every request still executes your Worker on the way in」）。
 *
 * 但开启它带来一个默认危险。官方文档原文：
 *
 *   > Responses with no `Cache-Control` header are still cached.
 *   > 200 → 7200 秒（2 小时）
 *
 * 而缓存键**只含**「路径 + 查询串 + Worker 版本」——
 * `Authorization` 不在键里（官方文档明确列出）。
 *
 * 所以：**任何带鉴权的 GET 接口，只要忘了设 cache-control，
 * 它的响应就会被匿名缓存 2 小时，任何访客都能拿到。**
 *
 * 对策是 lib/http.ts 里 `withSecurityHeaders` 的兜底 no-store：
 * 默认不可缓存，需要缓存的路由显式声明。漏写只会少省额度（性能问题），
 * 不会泄漏数据（安全问题）。
 *
 * 这一组测试就是钉死那个兜底。**将来新增任何带鉴权的 GET 接口，
 * 都必须在这里加一条。**
 */
describe('缓存安全：鉴权/敏感接口必须明确不可缓存', () => {
  /**
   * 判定标准：
   *   · 有 `cache-control` 且含 `no-store` 或 `private` → ✅
   *   · 完全没有 cache-control → ❌ 会被 Workers Caching 按默认 TTL 缓存
   */
  function assertUncacheable(res: Response, label: string): void {
    const cc = res.headers.get('cache-control');
    expect(cc, `${label} 没有任何 cache-control —— 开启 Workers Caching 后会被匿名缓存 2 小时`).not.toBeNull();
    expect(
      /no-store|private/.test(cc ?? ''),
      `${label} 的 cache-control 是 "${cc}"，不含 no-store/private，会被边缘缓存`,
    ).toBe(true);
  }

  it('/api/admin/books 带口令时不可缓存', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/admin/books?limit=1`, {
      headers: { authorization: 'Bearer test-token' },
    });
    expect(res.status).toBe(200);
    assertUncacheable(res, '/api/admin/books（带口令）');
  });

  it('/api/admin/requests 带口令时不可缓存', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/admin/requests?limit=1`, {
      headers: { authorization: 'Bearer test-token' },
    });
    expect(res.status).toBe(200);
    assertUncacheable(res, '/api/admin/requests（带口令）');
  });

  it('/api/admin/stats 带口令时不可缓存', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/admin/stats`, {
      headers: { authorization: 'Bearer test-token' },
    });
    // 该端点可能不存在，但无论 200 还是 404 都不能被缓存
    assertUncacheable(res, '/api/admin/stats');
  });

  it('/api/admin/** 未授权时也不可缓存（403 不该被缓存住）', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/admin/books?limit=1`);
    expect(res.status).toBe(403);
    assertUncacheable(res, '/api/admin/books（未授权 403）');
  });

  it('/api/turnstile-config 不可缓存（含运行时配置，且曾完全裸奔）', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/turnstile-config`);
    expect(res.status).toBe(200);
    assertUncacheable(res, '/api/turnstile-config');
  });

  it('POST 端点不可缓存（虽然 Workers Caching 本就不缓存 POST，仍显式声明）', async () => {
    const res = await SELF.fetch(`${API}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '1.2.3.4' },
      body: JSON.stringify({ title: '缓存安全测试书' }),
    });
    // 无论成功与否，POST 响应都不该被缓存
    assertUncacheable(res, 'POST /api/requests');
  });

  it('404 也不可缓存（默认 TTL 是 180 秒，且会掩盖后续新增的路由）', async () => {
    const res = await SELF.fetch(`${ORIGIN}/definitely-not-a-route`);
    expect(res.status).toBe(404);
    // 404 的默认 TTL 是 3 分钟。虽然危害小，但缓存住 404 会让
    // 「刚部署的新路由」在 3 分钟内继续 404 —— 排查时会很困惑。
    const cc = res.headers.get('cache-control');
    expect(cc, '404 应该显式声明，而不是靠默认 TTL').not.toBeNull();
  });
});

describe('缓存安全：明确可缓存的路由必须真的带缓存头', () => {
  /**
   * 反向断言：这些路由**应该**被 Workers Caching 缓存（省额度）。
   * 它们必须显式写 cache-control，而不是靠 no-store 兜底 ——
   * 否则兜底会让它们意外变成不可缓存，白白浪费额度。
   */
  it('/health 明确可缓存', async () => {
    const res = await SELF.fetch(`${ORIGIN}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toMatch(/max-age=\d+/);
  });

  it('/api/credits 明确可缓存', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/credits`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toMatch(/max-age=\d+/);
  });

  it('/api/requests GET 明确可缓存', async () => {
    const res = await SELF.fetch(`${API}?limit=3&offset=0`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toMatch(/max-age=\d+/);
  });

  it('首页 / 明确可缓存', async () => {
    const res = await SELF.fetch(`${ORIGIN}/`, { headers: { accept: 'text/html' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toMatch(/max-age=\d+/);
  });

  it('/upload 明确可缓存', async () => {
    const res = await SELF.fetch(`${ORIGIN}/upload`, { headers: { accept: 'text/html' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toMatch(/max-age=\d+/);
  });

  it('/dav/ 目录页明确可缓存', async () => {
    const res = await SELF.fetch(`${ORIGIN}/dav/`, { headers: { accept: 'text/html' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toMatch(/max-age=\d+/);
  });

  it('PROPFIND 207 明确可缓存（WebDAV 列表是最大宗的 Worker 请求）', async () => {
    const res = await SELF.fetch(`${ORIGIN}/dav/`, {
      method: 'PROPFIND',
      headers: { depth: '1' },
    });
    expect(res.status).toBe(207);
    expect(res.headers.get('cache-control')).toMatch(/max-age=\d+/);
  });
});

describe('缓存安全：所有 GET 响应都有 cache-control（兜底生效）', () => {
  /**
   * 遍历一批有代表性的 GET 路径，断言**每一个**都有 cache-control。
   * 这是「兜底 no-store」这个设计的核心保证：不可能漏。
   */
  const PATHS = [
    '/',
    '/health',
    '/upload',
    '/requests',
    '/admin',
    '/definitely-404',
    '/api/credits',
    '/api/requests?limit=5&offset=0',
    '/api/turnstile-config',
    '/dav/',
  ];

  for (const p of PATHS) {
    it(`GET ${p} 必有 cache-control（不会有裸奔响应）`, async () => {
      const res = await SELF.fetch(`${ORIGIN}${p}`, { headers: { accept: 'text/html' } });
      await res.text().catch(() => {});
      expect(
        res.headers.get('cache-control'),
        `${p} 没有 cache-control —— withSecurityHeaders 的兜底没生效`,
      ).not.toBeNull();
    });
  }
});
