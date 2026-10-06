/**
 * 条件请求求值（RFC 9110 §13）。
 *
 * 为什么这不是「合规洁癖」而是正确性问题：
 * 同步客户端（rclone / rsync 类 / Zotero / Calibre）上传前会先 HEAD 拿 ETag，
 * 再带 `If-Match: "<etag>"` 或 `If-None-Match: *` 发 PUT，目的是**避免误覆盖**。
 * 服务器不校验这些头就会直接覆盖 —— 对一个「所有人可上传」的公共书库，
 * 这意味着并发上传下可以静默覆盖别人的书，且双方都不知情。
 *
 * 支持 If-Match / If-None-Match（RFC 9110 §13.1.1/§13.1.2），
 * 以及 RFC 9110 §13.1.3 的 If-Range 仅用于 GET，这里不实现。
 *
 * 注意：条件头只影响「写入是否存在这一件事」，不参与 ETag 的并发控制语义
 * （那是 If-Match 的强比较，由调用方决定强/弱）。
 */

export type ConditionResult =
  /** 可以继续处理请求 */
  | { ok: true }
  /** 条件不满足，应返回 412 Precondition Failed */
  | { ok: false; reason: string };

/** 解析 If-Match / If-None-Match 的值：可能是 * 或一个/多个 ETag */
function parseTagList(header: string): { star: boolean; tags: string[] } {
  const raw = header.trim();
  if (raw === '*') return { star: true, tags: [] };
  const tags = raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    // 弱比较：W/"x" 与 "x" 在 If-None-Match 下等价；这里统一剥掉 W/ 前缀
    .map((t) => (t.startsWith('W/') ? t.slice(2) : t));
  return { star: false, tags };
}

/**
 * 校验一次 PUT。
 *
 * @param headers     请求头
 * @param currentEtag 目标当前 ETag；null 表示资源不存在
 */
export function checkPreconditions(
  headers: Headers,
  currentEtag: string | null,
): ConditionResult {
  const ifMatch = headers.get('if-match');
  const ifNoneMatch = headers.get('if-none-match');

  // RFC 9110 §13.1.1：If-Match
  if (ifMatch !== null) {
    const { star, tags } = parseTagList(ifMatch);
    if (currentEtag === null) {
      // 资源不存在，任何 If-Match 都无法满足（* 也一样）
      return { ok: false, reason: 'If-Match 指定了条件，但目标不存在' };
    }
    const matches = star || tags.includes(currentEtag);
    if (!matches) {
      return { ok: false, reason: `If-Match 不匹配（当前 ETag=${currentEtag}）` };
    }
  }

  // RFC 9110 §13.1.2：If-None-Match
  if (ifNoneMatch !== null) {
    const { star, tags } = parseTagList(ifNoneMatch);
    if (star) {
      // "*" 语义：仅当资源「不存在」时才允许写入 —— 这是防误覆盖的关键
      if (currentEtag !== null) {
        return { ok: false, reason: 'If-None-Match: * 要求目标不存在，但目标已存在' };
      }
    } else if (currentEtag !== null && tags.includes(currentEtag)) {
      // 显式列出的 ETag 命中 → 条件不满足
      return { ok: false, reason: `If-None-Match 命中（当前 ETag=${currentEtag}）` };
    }
  }

  return { ok: true };
}

/** RFC 9110 §13.2：304 Not Modified 用于条件 GET（本实现以 R2 302 为主，暂未启用） */
export function isModifiedSince(headers: Headers, lastModified: string | null): boolean | null {
  const ims = headers.get('if-modified-since');
  if (!ims || !lastModified) return null;
  const since = Date.parse(ims);
  const last = Date.parse(lastModified);
  if (Number.isNaN(since) || Number.isNaN(last)) return null;
  return last > since;
}