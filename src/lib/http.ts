/** HTTP 小工具：日期格式、缓存控制、统一错误响应。 */

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

/** RFC 1123 日期，WebDAV 的 getlastmodified 必须用这个格式。 */
export function httpDate(input: string | number | Date | null | undefined): string {
  const d = input == null ? new Date() : new Date(input);
  const t = Number.isNaN(d.getTime()) ? new Date() : d;
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${DAYS[t.getUTCDay()]}, ${pad(t.getUTCDate())} ${MONTHS[t.getUTCMonth()]} ${t.getUTCFullYear()} ` +
    `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())} GMT`
  );
}

/** ISO8601（creationdate 用） */
export function isoDate(input: string | number | Date | null | undefined): string {
  const d = input == null ? new Date() : new Date(input);
  const t = Number.isNaN(d.getTime()) ? new Date() : d;
  return t.toISOString();
}

export function textResponse(status: number, message: string, headers: HeadersInit = {}): Response {
  return new Response(`${message}\n`, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...headers },
  });
}

/** JSON 响应助手（上传 API 用） */
export function jsonResponse(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export function methodNotAllowed(allow: string): Response {
  return textResponse(405, 'Method Not Allowed', { allow });
}

/** WebDAV 的 207 响应 */
export function multistatusResponse(xml: string, ttl: number): Response {
  const headers: Record<string, string> = {
    'content-type': 'application/xml; charset=utf-8',
    // 让 Cache API 按这个 TTL 保存；这是免费方案里最关键的缓存头
    'cache-control': ttl > 0 ? `public, max-age=${ttl}` : 'no-store',
  };
  return new Response(xml, { status: 207, headers });
}

/** 稳定的短 id，用于 r2_key 与文件名去重后缀 */
export function shortId(bytes = 8): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 全站安全响应头。
 *
 * 分两类：
 *   · BASELINE —— 所有响应都加（含 WebDAV / JSON）。这些不影响协议语义，
 *     WebDAV 客户端也不解析它们。
 *   · HTML_CSP —— 只加在 HTML 页面上。CSP 用 'unsafe-inline' 是因为本项目
 *     的样式与脚本都是内联的（零构建、单文件返回），无法用 nonce 之外的
 *     方式外链；但已用 'unsafe-inline' 之外的全部收紧项：禁 frame-ancestors、
 *     禁 object、禁 base-uri、限制 form-action，能挡掉绝大多数注入利用链。
 *
 * 注意：不要给 WebDAV 的 207 响应加 CSP —— 客户端可能把它当成异常。
 */
const BASELINE_HEADERS: Record<string, string> = {
  // 阻止浏览器把 .txt/.epub 之类按内容猜成 HTML 执行
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  // HSTS 由 Cloudflare 边缘通常已加；这里显式声明以免换域名后丢失
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
};

const HTML_HEADERS: Record<string, string> = {
  ...BASELINE_HEADERS,
  'x-frame-options': 'DENY',
  'content-security-policy': [
    "default-src 'none'",
    "img-src 'self' data: https:",
    "style-src 'self' 'unsafe-inline'",
    // script-src：
    //   challenges.cloudflare.com      = Turnstile 验证码
    //   static.cloudflareinsights.com  = Cloudflare 自家 Web Analytics（边缘自动注入）
    "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com https://static.cloudflareinsights.com",
    "frame-src https://challenges.cloudflare.com",
    // connect-src：**必须包含 R2 的 S3 端点**。
    // 上传是「浏览器拿预签名 URL 直传 R2」，不走本站；漏掉它会让上传被 CSP 拦掉，
    // 而且报错发生在 XHR 上，看起来像「上传失败」而不是「策略拦截」（真实踩过）。
    "connect-src 'self' https://challenges.cloudflare.com https://cloudflareinsights.com https://*.r2.cloudflarestorage.com",
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; '),
};

/** 给响应补上安全头（不覆盖已有同名头） */
export function withSecurityHeaders(res: Response, isHtml = false): Response {
  const extra = isHtml ? HTML_HEADERS : BASELINE_HEADERS;
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(extra)) {
    if (!headers.has(k)) headers.set(k, v);
  }
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

