/** 极小的 XML 工具。不引入 XML 库：解析/生成都走字符串，CPU 开销最低。 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c] as string);
}

/** 逐段编码路径，保留 `/` 分隔符；目录以 `/` 结尾（由参数或输入路径的尾斜杠判定）。 */
export function encodeHref(path: string, isCollection = false): string {
  const wantsSlash = isCollection || path.endsWith('/');
  const segments = path.split('/').filter((s) => s.length > 0);
  const encoded = segments.map((s) => encodeURIComponent(s)).join('/');
  const withLeading = `/${encoded}`;
  if (!wantsSlash) return withLeading;
  return withLeading === '/' ? '/' : `${withLeading}/`;
}

/**
 * 组装一个 <D:response>。
 * 不认识的属性必须放进 404 的 propstat，否则 Windows 客户端会判定整个请求失败。
 */
export function davResponse(href: string, found: string, notFound: string[] = []): string {
  const parts: string[] = [];
  if (found) {
    parts.push(`<D:propstat><D:prop>${found}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>`);
  }
  if (notFound.length > 0) {
    const names = notFound.map((n) => `<D:${n}/>`).join('');
    parts.push(
      `<D:propstat><D:prop>${names}</D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>`,
    );
  }
  return `<D:response><D:href>${escapeXml(href)}</D:href>${parts.join('')}</D:response>`;
}

export function multistatus(responses: string[]): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<D:multistatus xmlns:D="DAV:">${responses.join('')}</D:multistatus>`
  );
}

export function davError(precondition: string): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<D:error xmlns:D="DAV:"><D:${precondition}/></D:error>`
  );
}
