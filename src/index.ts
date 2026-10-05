/**
 * webooks —— Cloudflare Workers Free + R2 上的 WebDAV 电子书库。
 *
 * 路由（挂载前缀可用 DAV_MOUNT 改，默认 /dav）：
 *   /dav/**            WebDAV（Class 1，读为主）
 *   /api/admin/**      管理接口（需要 ADMIN_TOKEN）
 *   /health            健康检查
 *   /                  首页
 */

import { handleAdmin } from './api/admin';
import { settings, type Env, type Settings } from './config';
import { textResponse } from './lib/http';
import { handleDav } from './webdav';

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/health') {
      return Response.json({ ok: true, service: 'webooks' });
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
      return new Response(indexHtml(cfg), {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'public, max-age=3600',
        },
      });
    }

    return textResponse(404, 'Not Found');
  },
} satisfies ExportedHandler<Env>;

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

function indexHtml(cfg: Settings): string {
  const mount = `${cfg.mountPath}/`;
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>webooks</title>
<style>
  body{font:16px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:44rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a}
  h1{font-size:1.3rem}
  code,pre{background:#f4f4f5;border-radius:4px;font-size:.9em}
  code{padding:.15em .4em}
  pre{padding:.8rem 1rem;overflow-x:auto}
  li{margin:.3rem 0}
</style></head>
<body>
<h1>webooks</h1>
<p>Cloudflare Workers Free + R2 上的 WebDAV 电子书库。</p>
<ul>
  <li>WebDAV 端点：<a href="${mount}"><code>${mount}</code></a></li>
  <li>健康检查：<code>/health</code></li>
</ul>
<p>客户端挂载建议用 rclone，并把目录缓存拉长以节省每日请求额度：</p>
<pre><code>rclone mount webooks: /mnt/books \\
  --dir-cache-time 24h --poll-interval 0 --vfs-cache-mode off</code></pre>
<p>注意：WebDAV 每个请求都会消耗 Workers Free 每天 100,000 次的额度。
能讲 S3 的客户端（rclone、脚本）请直接连 R2 的 S3 端点，那样是 0 次 Worker 请求。</p>
</body></html>`;
}
