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
    const res = await route(request, env);
    // 所有出口统一补安全响应头（含 cache-control 兜底），放在最外层是为了
    // 「不管走哪条分支都不会漏」—— 漏一条就是数据泄漏，见 lib/http.ts 的长注释。
    return withSecurityHeaders(res, isHtmlResponse(res));
  },
} satisfies ExportedHandler<Env>;

/**
 * 该响应是否算 HTML（决定加不加 CSP 那一组头）。
 *
 * ⚠️ 这里判的是**响应**的 content-type，而不是请求的 `Accept`。
 *
 * 原来判的是 `Accept: text/html`，启用 Workers Caching 后就不成立了：
 * 缓存键只含「路径 + 查询串 + Worker 版本」，**不含 `Accept`**
 * （官方文档明确列出 `Authorization`/`Cookie`/`Accept-Language`/`User-Agent`
 *   都不在键里）。于是同一 URL 先被谁访问、缓存里就是谁的那份响应头：
 *
 *   · 浏览器先来（Accept: text/html）→ 缓存带 CSP
 *   · curl 先来（Accept: * / *）→ 缓存**不带 CSP**，之后浏览器也拿到这份
 *
 * 结果是安全头随机丢失。而判响应类型是**确定性的**：同一个 URL 的响应
 * content-type 固定，浏览器和 curl 拿到同一份缓存是正确行为。
 *
 * 顺带解决了「207 不能带 CSP」：WebDAV 多状态响应是 application/xml，
 * 天然落在这条判断之外 —— 比原来靠 Accept 猜更准确。
 */
function isHtmlResponse(res: Response): boolean {
  const ct = res.headers.get('content-type') ?? '';
  return ct.startsWith('text/html');
}

async function route(request: Request, env: Env): Promise<Response> {
  {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/health') {
      // ⚠️ 这个响应是**编译期常量**（连 D1 都不查），却完全没缓存 ——
      //   每次探针/监控调用都实打实消耗 1 次 Worker 请求。
      //
      //   30 秒足够：健康检查关心的是「站点活着」而不是「这一秒活着」，
      //   而真正的故障（Worker 挂了、D1 连不上）会持续远超过 30 秒。
      //   缓存 30 秒最多让故障发现晚半分钟，换来的是探针成本降到 1/30。
      //
      //   注：这里返回 ok:true 不代表「真的健康」—— 它只证明 Worker 在跑。
      //   要检查 D1/R2 得看具体业务接口。所以这个端点的语义
      //   对缓存是免疫的：它本来就不该被依赖来做实时判断。
      return Response.json(
        { ok: true, service: 'webooks' },
        { headers: { 'cache-control': 'public, max-age=30' } },
      );
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
      // ⚠️ 首页**不再查 D1**。首屏那张「活书脊」（最近上架的书）
      //   改由前端 fetch /api/credits 拿 —— 那个接口已经缓存 1 小时，
      //   而首页是流量最大的入口。原来这里每次未命中都跑一次
      //   latestBook()，等于把最贵的路径放在最热门的页面上。
      //
      //   代价：书脊比榜单晚一点点出现（多一次 fetch）。
      //   换来的是首页本身可以被 CDN 无限缓存。
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

    // 上传页
    if (path === '/upload' || path === '/upload/') {
      // 原来是 no-store，理由是「页面里有 Turnstile 公钥」——
      // 但**人机验证已经默认关闭**（见 api/upload.ts 的 requireTurnstile），
      // 那个变量现在是空串，页面实质上是编译期常量。
      //
      // 缓存 1 小时。Turnstile 只有被显式打开（UPLOAD_REQUIRE_TURNSTILE=1）
      // 时 siteKey 才非空，届时密钥轮换最多让访客 1 小时内拿到旧 key
      // —— 而打开验证码本来就要配套刷新页面，这个代价可接受。
      // 传 mountPath：页脚的「进入书库」要指向真实的挂载路径
      // （DAV_MOUNT 可能是空串 = 根挂载，那时书库根就是 '/'）。
      return new Response(uploadHtml(env.TURNSTILE_SITE_KEY ?? '', cfg.mountPath), {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'public, max-age=3600',
        },
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

