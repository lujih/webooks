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
