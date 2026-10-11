/**
 * 鉴权小工具。
 *
 * 设计取舍：
 *   · 书库的「读」与「新增」保持完全匿名 —— 这是产品的核心诉求
 *   · 「破坏性操作」（删除 / 改名 / 覆盖已有书）需要共享口令
 *   · 口令用**常量时间比较**，避免响应时间侧信道泄露
 *
 * 为什么用共享口令而不是账号体系：
 *   本项目的定位是「无需注册的公共书库」。引入账号会让上传门槛变高，
 *   与产品目标冲突；而破坏性操作只需要「防住陌生人」，一个共享口令足够。
 */

/** 定长比较，防止通过响应时间逐字符猜解 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * 从请求里取出候选口令。支持三种携带方式，覆盖各类 WebDAV 客户端：
 *   · `Authorization: Bearer <token>`       —— 现代客户端 / 脚本
 *   · `Authorization: Basic <base64(u:p)>`  —— WebDAV 客户端的标准做法
 *     （用户名任意，口令即密码；因为我们的模型里只有「一个共享口令」）
 *   · `X-Write-Token: <token>`              —— 简单直给，方便 curl
 */
export function extractToken(request: Request): string {
  const header = request.headers.get('authorization') ?? '';
  const lower = header.toLowerCase();

  if (lower.startsWith('bearer ')) return header.slice(7).trim();

  if (lower.startsWith('basic ')) {
    const b64 = header.slice(6).trim();
    try {
      // atob 在 Workers 与浏览器都可用
      const decoded = atob(b64);
      const idx = decoded.indexOf(':');
      return idx >= 0 ? decoded.slice(idx + 1) : decoded;
    } catch {
      return '';
    }
  }

  return (request.headers.get('x-write-token') ?? '').trim();
}

/**
 * 校验写口令。
 * @param expected 期望口令；为空字符串/null 表示**未启用保护**
 */
export function hasWriteToken(request: Request, expected: string | null): boolean {
  if (!expected) return true; // 未配置 = 不保护（保持向后兼容，后台会明确告警）
  const provided = extractToken(request);
  return provided.length > 0 && safeEqual(provided, expected);
}

/** 校验管理口令（比写口令更高的权限） */
export function hasAdminToken(request: Request, url: URL, expected: string | null): boolean {
  if (!expected) return false; // 未配置 = 管理接口整体关闭（fail-closed）
  const header = request.headers.get('authorization') ?? '';
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  const provided = bearer || (url.searchParams.get('token') ?? '');
  return provided.length > 0 && safeEqual(provided, expected);
}

/**
 * 需要口令才能继续时的标准响应。
 *
 * 返回 **401 + WWW-Authenticate: Basic**，而不是 403 —— WebDAV 客户端
 * 看到 401 才会弹出密码框让用户输入；403 只会显示「拒绝访问」，
 * 用户无从填写口令。
 */
export function unauthorizedResponse(realm = 'webooks'): Response {
  return new Response('Authentication required for this operation\n', {
    status: 401,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'www-authenticate': `Basic realm="${realm}", charset="UTF-8"`,
    },
  });
}
