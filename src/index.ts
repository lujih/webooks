/**
 * webooks —— Cloudflare Workers Free + R2 上的 WebDAV 电子书库。
 *
 * 路由（挂载前缀可用 DAV_MOUNT 改，默认 /dav）：
 *   /dav/**            WebDAV（Class 1，读为主）
 *   /requests          求书墙（页面）
 *   /api/requests      求书（匿名公开 API）
 *   /api/credits       上传者榜单（匿名公开 API）
 *   /api/admin/**      管理接口（需要 ADMIN_TOKEN）
 *   /health            健康检查
 *   /                  首页
 */

import { handleAdmin } from './api/admin';
import { handleUploadComplete, handleUploadInit } from './api/upload';
import { handleCreditPublic, handleRequests } from './api/requests';
import { requestsHtml } from './requests-page';
import { settings, type Env, type Settings } from './config';
import { textResponse, withSecurityHeaders } from './lib/http';
import { indexHtml } from './home-page';
import { adminHtml } from './admin-page';
import { uploadHtml } from './upload-page';
import { handleDav } from './webdav';

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    // 所有出口统一补安全响应头，放在最外层是为了「不管走哪条分支都不会漏」。
    return withSecurityHeaders(await route(request, env), wantsHtml(request));
  },
} satisfies ExportedHandler<Env>;

/**
 * 是否需要 HTML 专属响应头（含 CSP）。
 * 只有「浏览器直接打开页面」的场景加 —— WebDAV 客户端的 207 不加 CSP，
 * 避免被客户端误判为异常响应。
 */
function wantsHtml(request: Request): boolean {
  const path = new URL(request.url).pathname;
  if (path === '/' || path === '' || path === '/upload' || path === '/upload/') return true;
  if (path === '/admin' || path === '/admin/') return true;
  const accept = request.headers.get('accept') ?? '';
  return request.method === 'GET' && accept.includes('text/html');
}

async function route(request: Request, env: Env): Promise<Response> {
  {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/health') {
      return Response.json({ ok: true, service: 'webooks' });
    }

    // 求书（匿名公开接口，同样在 settings() 之前）
    if (path === '/api/requests') {
      return handleRequests(request, env);
    }

    // 上传通道（在 settings() 之前：上传即使没配 R2_PUBLIC_BASE 也应给出明确错误）
    if (path === '/api/upload/init') {
      return handleUploadInit(request, env);
    }
    if (path === '/api/upload/complete') {
      return handleUploadComplete(request, env);
    }
    // 上传页用的 Turnstile 公钥（只暴露公钥，不暴露私钥）
    if (path === '/api/turnstile-config') {
      return Response.json({ siteKey: env.TURNSTILE_SITE_KEY ?? null });
    }

    let cfg: Settings;
    try {
      cfg = settings(env);
    } catch (err) {
      return textResponse(
        500,
        `Configuration error: ${(err as Error).message}\n` +
          `Set R2_PUBLIC_BASE in wrangler.jsonc vars to your R2 public custom domain.`,
      );
    }

    // admin 必须在 DAV 之前判断：DAV_MOUNT 为空（根挂载）时否则会被 DAV 吃掉
    if (path.startsWith('/api/admin/')) {
      return guarded(() => handleAdmin(request, env, cfg, url));
    }

    const mount = cfg.mountPath; // '' 表示挂在站点根
    const isDav =
      mount === '' || path === mount || path.startsWith(`${mount}/`);

    if (isDav) {
      const davPath = mount === '' ? path : path.slice(mount.length) || '/';
      return guarded(() => handleDav(request, env, cfg, davPath));
    }

    if (path === '/' || path === '') {
      return new Response(indexHtml(cfg.mountPath, cfg.r2PublicBase), {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'public, max-age=3600',
        },
      });
    }

    // 上传者榜单（匿名公开，只返回名字与计数）
    if (path === '/api/credits') {
      return handleCreditPublic(request, env);
    }

    // 求书墙
    if (path === '/requests' || path === '/requests/') {
      return new Response(requestsHtml(), {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          // 列表是动态拉的，页面本身可以缓存；但 ? 带参数不应被缓存
          'cache-control': 'public, max-age=300',
        },
      });
    }

    // 上传页（需要 Turnstile 公钥才能工作）
    if (path === '/upload' || path === '/upload/') {
      return new Response(uploadHtml(env.TURNSTILE_SITE_KEY ?? ''), {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    // 管理后台（页面本身不含任何数据，真正的数据接口在 /api/admin/* 后面）
    if (path === '/admin' || path === '/admin/') {
      return new Response(adminHtml(), {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          // 后台绝不能进任何共享缓存
          'cache-control': 'no-store, private',
        },
      });
    }

    return textResponse(404, 'Not Found');
  }
}

/**
 * 「先 deploy 再 migrate」是有意为之：wrangler 的自动资源创建只在 deploy 期间发生，
 * 首次构建时 D1 还不存在，迁移必须排在后面。代价是存在一个「已部署但没建表」的窗口。
 * 这里把这个窗口的报错换成可操作的提示，而不是裸 500。
 */
async function guarded(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/no such table|no such column|no such index/i.test(message)) {
      return textResponse(
        503,
        'Database schema is not initialised.\n\n' +
          'D1 已绑定但还没建表。执行：\n' +
          '  npm run db:migrate          # 本地配置了远端凭据时\n' +
          '  或在 Cloudflare 的 Deploy command 里使用：\n' +
          '  npx wrangler deploy && npx wrangler d1 migrations apply DB --remote\n',
        { 'retry-after': '60' },
      );
    }
    throw err;
  }
}

