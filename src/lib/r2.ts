/**
 * R2 公开域直链与对象元数据的公共工具。
 *
 * 有两件事全站只允许有一份实现，否则一定会分裂成两种行为：
 *
 * 1. **`encodeR2Key`：对象键 → URL 路径。**
 *    浏览页书卡、GET 的 302 Location、以及将来任何指向 `books.<域名>`
 *    的链接都必须用同一套编码规则。同一个对象出现两种 URL 的后果不是
 *    「不好看」，而是缓存劈裂 + rclone 把一本书认成两个文件。
 *
 * 2. **`r2HttpMetadata`：落 R2 的 `httpMetadata`。**
 *    R2 对外提供的就是这份元数据，而对象键 `books/<随机 id>` 里**没有
 *    扩展名**，所以 Content-Type 与 Content-Disposition 都只能由上传时的
 *    书名推导：
 *      · Content-Type 只按扩展名推导（见 metadata.ts 的 `safeContentTypeFor`：
 *        信任客户端声明等于允许 `text/html` 托管，是真实踩过的漏洞）
 *      · Content-Disposition 让浏览器把文件存成书名，而不是存成随机 id
 *
 * ⚠️ R2 不支持 S3 的 `response-content-disposition` 之类的 response-* 覆盖
 * 查询参数（实测无效），所以下载名只能靠写入时的 `contentDisposition`。
 * 反过来说：**已经存在的对象必须重写一次才会带上这个头**。
 */
import { extensionOf, safeContentTypeFor } from './metadata';

/**
 * 对象键 → URL 路径。
 *
 * 逐段 `encodeURIComponent`（而不是整体编码一次）：
 *   · `/` 是层级分隔符，整体编码会变成 `%2F`，R2 会把它当成一个整段键而 404
 *   · 中文段必须编码：请求行里的原始非 ASCII 字节会被中间设备和日志改写
 */
export function encodeR2Key(key: string): string {
  return key.split('/').map((s) => encodeURIComponent(s)).join('/');
}

/**
 * HTTP 头里绝对不能出现的字符。
 *
 * 书名是**用户可控**的（`PUT /dav/<集合>/<书名>`），直接拼进响应头就是一个
 * 注入点：
 *   · CR / LF → 响应头注入，能凭空造出 `Set-Cookie` 之类的头
 *   · `"` 与 `\` → 提前闭合 quoted-string，把剩下的内容变成垃圾（或新参数）
 * 控制字符（含 DEL）一并去掉：它们在头里没有合法表示。
 *
 * ⚠️ **这个正则只能用于 `replace()`，不许拿去对单个字符做 `.test()`。**
 * 带 `/g` 的正则 `.test()` 是**有状态**的：命中一次就把 `lastIndex` 推到命中处
 * 之后，下一次 `test()` 从那里继续。实测复现过 ——
 * `UNSAFE_HEADER_CHARS.test('"')` 返回 true 且 `lastIndex=1`，紧接着
 * `UNSAFE_HEADER_CHARS.test('\\')` 从索引 1 开始查一个长度 1 的字符，返回
 * **false**：连续两个危险字符里第二个被判成安全，真的这样漏过一次
 * （`filename="\\.epub"`，尾部 `\` 把收尾引号转义掉，`filename*` 被吞进
 * quoted-string 里）。所以：带 `/g` 的这个只负责 `replace`（全局替换、无残留
 * 状态），单字符判断一律走下面的白名单，不碰这个正则。
 */
const UNSAFE_HEADER_CHARS = /[\u0000-\u001f\u007f"\\]/g;


/**
 * ASCII 兜底名里**允许保留**的字符集合（其余一律变 `_`）。
 *
 * 刻意取最小集合：字母数字、点、下划线、连字符。
 *
 * 为什么是白名单：兜底名唯一的用途是喂给「只认 `filename`、不认 `filename*`」
 * 的老客户端，而它们对这种名字的处理各不相同 —— 反斜杠会被 Windows 当路径、
 * `:` 在 NTFS 上非法、`%` 可能被二次解码。逐个枚举「哪些危险」是列不全的，
 * 漏掉一个就是一次注入；反过来只声明「哪些安全」，漏掉的字符自动变 `_`。
 * 丢掉的字符在 `filename*` 里是完整的，信息不丢。
 *
 * 用 `String.includes` 而不是正则判定：没有 `lastIndex` 状态可言，
 * 从类型上就不可能重蹈上面那个坑。
 */
const ASCII_SAFE_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-';

/** 下载名长度上限（码点）。与 sanitiseLeafName 的默认上限一致 */
const MAX_FILENAME_LENGTH = 200;

/** RFC 5987 `attr-char` 里除字母数字之外的部分，可以原样出现在 `filename*` 里 */
const ATTR_CHARS = '!#$&+.^_`|~-';

/** 名字净化后为空 / 没有任何 ASCII 字母数字时的兜底名 */
const FALLBACK_NAME = 'download';

/** 把名字压到上限内，尽量保留扩展名 */
function clampLength(name: string): string {
  const chars = Array.from(name);
  if (chars.length <= MAX_FILENAME_LENGTH) return name;
  const dot = name.lastIndexOf('.');
  // 只在「末段像扩展名」时保留它，避免把书名里最后一个句点当成后缀
  const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
  const keep = Math.max(MAX_FILENAME_LENGTH - Array.from(ext).length, 1);
  return chars.slice(0, keep).join('') + ext;
}

/** 清洗成可以安全拼进响应头的书名 */
function sanitiseForHeader(raw: string): string {
  const cleaned = clampLength(raw.replace(UNSAFE_HEADER_CHARS, '_').trim());
  return cleaned || FALLBACK_NAME;
}

/**
 * RFC 6266 的 `filename*=UTF-8''<value-chars>` 取值。
 *
 * 不用 `encodeURIComponent`：它保留 `!'()*`，其中 `'` 和 `*` 不是 RFC 5987
 * 的 `attr-char`，会把 `filename*` 变成语法错误的值。这里按码点重编：
 * 字母数字与 `attr-char` 原样，其余按 **UTF-8 字节**逐个 `%XX`。
 *
 * 走 `TextEncoder` 而不是手写编码还有个副作用是好的：JS 字符串里的孤立
 * 代理项会被替换成 U+FFFD，而 `encodeURIComponent` 遇到它直接抛 URIError ——
 * 那会把一次上传打成 500。
 */
function percentEncodeUtf8(name: string): string {
  let out = '';
  for (const b of new TextEncoder().encode(name)) {
    const isAlnum = (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);
    if (isAlnum || ATTR_CHARS.includes(String.fromCharCode(b))) {
      out += String.fromCharCode(b);
    } else {
      out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
}

/**
 * ASCII 兜底文件名。
 *
 * 中文书名会整段降级成下划线，这时退回 `download.<扩展名>` —— 「丢掉书名」
 * 比「文件名是一个下划线」更可接受，也更好排序。主体里留不下任何 ASCII
 * 字母数字时才退化（只给 `filename` 的老客户端才会走到这里）。
 *
 * 这里**不做黑名单判断**（见 `ASCII_SAFE_CHARS` 的注释）：先把非 ASCII 与
 * 控制字符拍成 `_`，再由白名单把「不在允许集合内」的字符统一替换掉。
 * 不存在「少列了一个危险字符就漏过去」的可能。
 *
 * ⚠️ **导出只为测试，不对外承诺 API。** 它是第二层防线，必须能被**独立**验证：
 * 只从 `contentDispositionFor` 打进去的话，第一层（`sanitiseForHeader`）会替它
 * 挡住一切，于是「这一层还能不能打」根本测不出来 —— 曾经就有一个
 * 黑名单 `.test()` 的状态化 bug 藏在这里，靠上游清洗侥幸不爆。
 * 直接调它、喂未经清洗的原始名，才是对它本身的验证。
 */
export function asciiFallback(name: string): string {
  const ascii = Array.from(name)
    .map((ch) => {
      const cp = ch.codePointAt(0) ?? 0;
      // 非 ASCII 与 C0/DEL 控制字符：兜底名里没有它们的合法表示
      if (cp < 0x20 || cp > 0x7e) return '_';
      return ASCII_SAFE_CHARS.includes(ch) ? ch : '_';
    })
    .join('');
  const ext = extensionOf(ascii);
  const tail = ext ? `.${ext}` : '';
  const stem = (ext ? ascii.slice(0, ascii.length - tail.length) : ascii)
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .trim();
  return /[A-Za-z0-9]/.test(stem) ? `${stem}${tail}` : `${FALLBACK_NAME}${tail}`;
}

/**
 * 生成 `Content-Disposition` 头的值。
 *
 * 为什么不写成一句 `attachment; filename="书名.epub"`：HTTP 头是 latin-1
 * 字节流，中文书名直接塞进去就是乱码，老浏览器甚至会截断。RFC 6266 的正解
 * 是**两个都给**：
 *
 *   · `filename="..."`     —— ASCII 兜底，只认这个的老客户端拿到的名字是
 *                             合法的（哪怕丢了汉字），不会是乱码或空
 *   · `filename*=UTF-8''…` —— RFC 5987 扩展，现代客户端优先用它，汉字不丢
 *
 * 只给 `filename*` 会让老客户端拿到空文件名；只给 `filename` 则中文必丢。
 *
 * 同时兜住 header 注入，而且是**两层独立**的：
 *   · `sanitiseForHeader` 先按 `UNSAFE_HEADER_CHARS` 把危险字符换成 `_`
 *   · `asciiFallback` 再用 `ASCII_SAFE_CHARS` 白名单兜一遍（只放行
 *     字母数字 `.` `_` `-`），所以即使上层漏掉某个字符，它也进不了 `filename=""`
 * `filename*` 侧本身安全（非 `attr-char` 一律百分号编码），
 * 但它必须先过 `sanitiseForHeader`，否则 CR/LF 会以 `%0D` 之外的形态留下。
 */
export function contentDispositionFor(leafName: string): string {
  const safe = sanitiseForHeader(leafName);
  return `attachment; filename="${asciiFallback(safe)}"; filename*=UTF-8''${percentEncodeUtf8(safe)}`;
}

/**
 * 落 R2 的 `httpMetadata`（书 / 音频 / 漫画等**可下载对象**用它）。
 *
 * 三条写入路径（WebDAV PUT 的两个分支、COPY/MOVE、网页上传的 complete）
 * 必须共用这一个函数 —— 各写一份的结果是「有的对象带下载名，有的不带」，
 * 而这种不一致只在浏览器里以「下载下来叫 3f9a2c1b」的形式暴露，很难定位。
 *
 * ⚠️ **封面（`covers/`）不要用这个函数**：封面是 `<img>` 内联展示的，
 * 带上 `attachment` 会让图片在浏览器里变成下载。
 */
export function r2HttpMetadata(leafName: string): R2HTTPMetadata {
  return {
    contentType: safeContentTypeFor(leafName),
    contentDisposition: contentDispositionFor(leafName),
  };
}
