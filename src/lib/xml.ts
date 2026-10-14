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

/**
 * DAV 请求体的合理上限。
 *
 * PROPFIND / PROPPATCH / LOCK 的请求体只装几个属性名 —— litmus 的
 * `props` 套件里最长的也就 1 KB 量级。8 KB 已经有三个数量级的余量。
 *
 * 为什么必须有上限：这两个动词是**匿名可发**的，请求体完全由攻击者控制。
 * 原先用来提取属性名的正则含嵌套量词（`(?:\s[^>]*)?(?:\/>|>[^<]*<\/`），
 * 遇到「大量 `<a ` 但没有 `>`」的输入会退化成二次方回溯：
 * 实测 24 KB → 362 ms、48 KB → 1448 ms，而 Workers Free 的 CPU 预算
 * 只有 10 ms。也就是说**一个几百 KB 的请求体就能让单个 Worker 实例
 * 长时间不可用**，且不需要任何凭据。
 */
export const DAV_BODY_LIMIT = 8 * 1024;

/**
 * 读 DAV 请求体，超过上限就截断（并可据此拒绝）。
 *
 * 在**读取**阶段就限长，而不是解析完再判断 —— `request.text()` 本身
 * 就会把整个 body 读进内存，先限长才能同时挡住内存与 CPU 两头。
 *
 * ⚠️ 注意：Content-Length 只能作为快速路径，不能作为唯一依据 ——
 * 客户端可以伪造或省略它。
 */
export async function readDavBody(
  request: Request,
  limit = DAV_BODY_LIMIT,
): Promise<{ text: string; truncated: boolean }> {
  const declared = Number(request.headers.get('content-length')) || 0;
  if (declared > limit) {
    return { text: '', truncated: true };
  }
  // 没有 Content-Length（chunked 传输）时按流式截断，避免读进完整 body
  if (!request.body || declared > 0) {
    const text = await request.text().catch(() => '');
    if (text.length > limit) return { text: text.slice(0, limit), truncated: true };
    return { text, truncated: false };
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    chunks.push(value);
    if (total >= limit) {
      truncated = true;
      // 提前停止读取：这是关键，否则大 body 仍会被整个搬进内存
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const buf = new Uint8Array(Math.min(total, limit));
  let off = 0;
  for (const c of chunks) {
    if (off >= buf.length) break;
    const take = Math.min(c.byteLength, buf.length - off);
    buf.set(c.subarray(0, take), off);
    off += take;
  }
  return { text: new TextDecoder().decode(buf), truncated };
}

/** 标签名合法字符（不含 ':' —— 命名空间前缀单独处理） */
function isTagNameChar(c: string): boolean {
  return (
    (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
    (c >= '0' && c <= '9') || c === '_' || c === '-' || c === '.'
  );
}

/**
 * 线性扫描出所有标签名（去掉命名空间前缀）。
 *
 * 不用正则是有原因的，见 DAV_BODY_LIMIT 的说明：嵌套量词在恶意输入上
 * 是二次方的。这里是「找 `<` → 读名字 → 找 `>`」的单趟推进，
 * 每个字符最多被看两遍，CPU 与输入长度线性相关。
 *
 * 同时覆盖自闭合（`<D:getetag/>`）与带内容（`<D:displayname>x</D:displayname>`）
 * 两种写法 —— 只处理前者会让客户端看到一个无名的 `<D:unknown/>`。
 */
export function extractTagNames(xml: string): string[] {
  const names: string[] = [];
  const n = xml.length;
  let i = 0;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) break;
    i = lt + 1;
    // 跳过结束标签、注释、声明、CDATA
    if (i >= n) break;
    const c = xml[i]!;
    if (c === '/' || c === '!' || c === '?') {
      const gt = xml.indexOf('>', i);
      i = gt < 0 ? n : gt + 1;
      continue;
    }
    // 跳过命名空间前缀：`D:getetag` 里的 `D:` 不是标签名的一部分。
    // 不跳的话 `<D:propfind>` 会被读成标签名 "D"，后面全部判错。
    //
    // ⚠️ 分两段读，不能把 ':' 放进白名单一把读完 —— 那样会把
    // `D:propfind` 整个当成「命名空间」，读出来是空串。
    let k = i;
    while (k < n && isTagNameChar(xml[k]!)) k++;
    if (k < n && xml[k] === ':' && k > i) {
      k++; // 跳过 ':'
    } else {
      k = i; // 没有前缀，回到原处
    }

    // 读标签名：首个字符须是字母
    if (k >= n || !((xml[k]! >= 'A' && xml[k]! <= 'Z') || (xml[k]! >= 'a' && xml[k]! <= 'z'))) continue;
    let j = k;
    while (j < n && isTagNameChar(xml[j]!)) j++;

    let name = xml.slice(k, j);
    // 跳到标签结束（属性值里的 '>' 按 XML 规范必须写成 &gt;，
    // 所以这里直接找第一个 '>' 是安全的）
    const gt = xml.indexOf('>', j);
    if (gt < 0) break;
    i = gt + 1;

    // 注意：**不要**跳过子树。DAV 请求体里元素值都是属性名或简单文本，
    // 我们要的正是 `<prop>…</prop>` 里面的那些标签名；跳过子树会连它们
    // 一起吞掉，于是 parsePropfindBody 永远返回 allprop。
    // 同理不需要担心「值里的 '<' 被当成标签」——XML 规范要求值里的 '<' 
    // 必须转义为 &lt;，未转义的 '<' 不是合法 XML。
    if (name) names.push(name);
  }
  return names;
}
