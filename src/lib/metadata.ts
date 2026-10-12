/** 从文件名推导元数据。Phase 1 会换成解析 EPUB OPF / PDF XMP 的 Queue consumer。 */

import { normaliseFormat } from './collections';

const CONTENT_TYPES: Record<string, string> = {
  epub: 'application/epub+zip',
  pdf: 'application/pdf',
  mobi: 'application/x-mobipocket-ebook',
  azw3: 'application/vnd.amazon.ebook',
  azw: 'application/vnd.amazon.ebook',
  fb2: 'application/fb2+xml',
  djvu: 'image/vnd.djvu',
  txt: 'text/plain; charset=utf-8',
  rtf: 'application/rtf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  cbz: 'application/vnd.comicbook+zip',
  cbr: 'application/vnd.comicbook-rar',
  m4a: 'audio/mp4',
  m4b: 'audio/mp4',
  mp3: 'audio/mpeg',
  zip: 'application/zip',
  md: 'text/markdown; charset=utf-8',
  // 安全：HTML 一律按纯文本提供，绝不用 text/html。
  // 公开匿名书库若以 text/html 提供文件，等于把项目域名变成任意内容托管点
  // （钓鱼/挂马/存储型 XSS）。浏览器仍能查看源码或下载，只是不渲染。
  html: 'text/plain; charset=utf-8',
  htm: 'text/plain; charset=utf-8',
  xhtml: 'text/plain; charset=utf-8',
  svg: 'application/octet-stream',
};

export interface DerivedMetadata {
  title: string;
  author: string | null;
  format: string;
  contentType: string;
  extension: string;
}

export function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

export function contentTypeFor(ext: string): string {
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * 泛型 content-type —— 这些值没有信息量，应该让位给扩展名推导。
 * 典型场景：客户端用 fetch 发字符串 body 时会自动带上 text/plain，
 * 或者 WebDAV 客户端统一用 application/octet-stream。
 */
const GENERIC_TYPES = new Set([
  '',
  'text/plain',
  'application/octet-stream',
  'binary/octet-stream',
]);

/** 优先用客户端给的具体类型；给的是泛型就回退到扩展名推导。 */
export function preferContentType(
  headerValue: string | null | undefined,
  derived: string,
): string {
  const raw = (headerValue ?? '').trim();
  const essence = raw.split(';')[0]!.trim().toLowerCase();
  return GENERIC_TYPES.has(essence) ? derived : raw;
}

/**
 * **写入存储时必须使用的** Content-Type —— 只按扩展名推导。
 *
 * 安全要点（真实漏洞）：R2 对象提供的就是写入时 httpMetadata.contentType，
 * 而不是 D1 里的值。早期实现把客户端声明的 Content-Type 原样写进 R2，
 * 于是 `PUT /dav/recent/x.epub` 带 `Content-Type: text/html` 就能让
 * `books.<域名>/books/<id>` 以 text/html 返回任意 HTML/JS —— WebDAV 端点
 * 没有 Turnstile，脚本可批量滥用。现在一律以扩展名为准（未知扩展名 →
 * application/octet-stream，浏览器只会下载不会渲染）。
 */
export function safeContentTypeFor(leafName: string): string {
  return contentTypeFor(extensionOf(leafName));
}

/**
 * 清洗叶子文件名。
 * WebDAV 的 href 里不能出现 `/`、控制字符；`.` 和 `..` 直接拒绝。
 */
export function sanitiseLeafName(raw: string, maxLength = 200): string | null {
  let name = raw.trim();
  if (!name) return null;
  // 去掉路径分隔符与控制字符
  name = name.replace(/[/\\\u0000-\u001f\u007f]/g, '_');
  // 去掉 Windows 不允许的字符
  name = name.replace(/[<>:"|?*]/g, '_');
  name = name.replace(/\s+/g, ' ').trim();
  if (!name || name === '.' || name === '..') return null;
  if (name.length > maxLength) {
    // 保留扩展名，从中间截断
    const ext = extensionOf(name);
    const keep = maxLength - (ext ? ext.length + 1 : 0);
    name = ext ? `${name.slice(0, Math.max(keep, 1))}.${ext}` : name.slice(0, maxLength);
  }
  return name;
}

/**
 * 作者名规范化：去掉常见的修饰，返回干净的名字或 null。
 * 真实文件名里作者位的写法非常杂：`作者：X`、`X 著`、`[X]`、`（X）`、
 * `X、Y 合著`……统一在这里收敛。
 */
export function normaliseAuthor(raw: string | null | undefined): string | null {
  let s = (raw ?? '').trim();
  if (!s) return null;

  // 先判占位符，**再**做拆分 —— 否则 `N/A` 会被 `/` 拆成 `N` 而漏判
  if (/^(未知|佚名|不详|无|none|unknown|n\/a|anonymous)$/i.test(s)) return null;

  // 去掉「作者：」「著：」「by 」这类前缀
  s = s.replace(/^\s*(?:作者|著者|原著|文|by)\s*[:：]?\s*/i, '').trim();
  // 去掉「 著」「 作品」「 编」这类后缀
  s = s.replace(/\s*(?:著|作品|编著|编|译|原著)\s*$/u, '').trim();
  // 去掉包裹符号
  s = s.replace(/^[\[【(《（<]\s*/, '').replace(/\s*[\]】)）》>]$/, '').trim();

  // 多作者：只取第一位用于分桶（「刘慈欣、韩松」→ 刘慈欣）
  const first = s.split(/[、,，;；/|]|\s+and\s+/i)[0];
  if (first) s = first.trim();

  // 去掉残留的首尾标点
  s = s.replace(/^[\s\-–—_·.]+/, '').replace(/[\s\-–—_·.]+$/, '').trim();

  if (!s || s.length > 60) return null;
  // 全是标点/数字的不当作者
  if (!/[\p{L}\u3400-\u9fff]/u.test(s)) return null;
  // 拆完可能又变成占位符（例如「作者：未知」）
  if (/^(未知|佚名|不详|无|none|unknown|n\/a|anonymous)$/i.test(s)) return null;
  return s;
}

/**
 * 常见中文姓氏（百家姓里使用频率最高的一批 + 常见复姓）。
 *
 * 为什么要它：`筚路维艰 - 萧冬连` 这种「书名 - 作者」里，两边都是 3-4 个汉字，
 * 光看长度完全分不出来。但**姓氏是极强的判据**：`萧`是姓、`筚`不是。
 * 这张表只有几百字节，却能把方向判断的准确率拉上一个台阶。
 */
const CJK_SURNAME_CHARS =
  '王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾萧田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤';

const CJK_SURNAMES = new Set(CJK_SURNAME_CHARS.split(''));

/** 复姓（两字）单独一张表，用于「名字以复姓开头」的判断 */
const CJK_COMPOUND_SURNAMES = [
  '欧阳', '上官', '司马', '诸葛', '东方', '独孤', '南宫', '慕容',
  '皇甫', '尉迟', '长孙', '宇文', '轩辕', '令狐', '夏侯', '公孙',
];

/** 名字是否以中文姓氏开头 */
function startsWithCjkSurname(s: string): boolean {
  if (CJK_COMPOUND_SURNAMES.some((c) => s.startsWith(c))) return true;
  const first = s[0];
  return !!first && CJK_SURNAMES.has(first);
}

/** 判断某个字符串有多「像人名」——用于消解 `A - B` 里哪边是作者。 */
function authorLikeness(s: string): number {
  const t = s.trim();
  if (!t) return -10;
  let score = 0;

  // 标题特征：强烈减分
  if (/[：:（(【\[《]/.test(t)) score -= 4;
  if (/\d/.test(t)) score -= 3;                       // 卷号/年份/册数
  if (/(全集|套装|合集|文集|上册|下册|第\s*\d|卷|册|话|回|部)/.test(t)) score -= 5;
  if (/[！!？?。，,、]/.test(t)) score -= 2;
  if (t.length > 14) score -= 3;

  const cjk = (t.match(/[\u3400-\u9fff]/g) ?? []).length;
  const latin = (t.match(/[A-Za-z]/g) ?? []).length;
  const dotFree = t.replace(/[·．.\s]/g, '');

  if (cjk > 0 && latin === 0) {
    const core = dotFree;
    if (/^[\u3400-\u9fff]+$/.test(core)) {
      // 姓氏开头是最强的信号
      if (startsWithCjkSurname(core)) score += 6;
      // 中文姓名绝大多数是 2-3 字（复姓 + 1-2 字名）
      if (core.length === 2 || core.length === 3) score += 4;
      else if (core.length === 4) score += 1;
      else score -= 1;
    }
  } else if (latin > 0 && cjk === 0) {
    const words = t.split(/\s+/).filter(Boolean);
    if (words.length >= 2 && words.length <= 4 && words.every((w) => /^[A-Z]/.test(w))) score += 4;
  }

  return score;
}

/**
 * 从文件名猜测作者与书名。
 *
 * 分两层，显式标记永远优先（无歧义）：
 *   1. 显式标记：`作者：X` / `X 著` / 结尾的 `[X]`、`（X）`
 *   2. 分隔符 ` - ` / ` – ` / ` — ` / ` by `，用打分判断哪边是人名
 *
 * 为什么要打分而不是写死方向：`书名 - 作者` 与 `作者 - 书名` 两种约定都真实存在。
 * 写死任何一边都会让另一半错得离谱。打分看「哪边更像人名」，
 * 两边都不像时退回原有行为（作者在前），保持向后兼容。
 */
function guessAuthor(stem: string): { author: string | null; title: string } {
  const s = stem.trim();
  if (!s) return { author: null, title: stem };

  // ── 1. 显式标记 ──
  // `书名 作者：X` / `书名 (作者：X)`
  const marked = s.match(/^(.*?)[\s\-–—_]*[（(\[【]?\s*(?:作者|著者|原著)\s*[:：]\s*([^)）\]】]+?)\s*[)）\]】]?\s*$/u);
  if (marked && marked[1] && marked[2]) {
    const a = normaliseAuthor(marked[2]);
    const t = marked[1].trim();
    if (a && t) return { author: a, title: cleanTitle(t) };
  }
  // `书名 X 著`（中文常见）
  const zhuz = s.match(/^(.*?)\s+([^\s]{1,20})\s*著$/u);
  if (zhuz && zhuz[1] && zhuz[2]) {
    const a = normaliseAuthor(zhuz[2]);
    const t = zhuz[1].trim();
    if (a && t) return { author: a, title: cleanTitle(t) };
  }
  // 开头方括号里是作者：`[刘慈欣]三体`
  const lead = s.match(/^[\[【(（]\s*([^\]】)）]{1,20})\s*[\]】)）]\s*(.+)$/u);
  if (lead && lead[1] && lead[2]) {
    const inner = lead[1].trim();
    if (authorLikeness(inner) >= 4) {
      const a = normaliseAuthor(inner);
      const t = lead[2].trim();
      if (a && t) return { author: a, title: cleanTitle(t) };
    }
  }
  // 结尾括号里是作者：`书名 (张三)` / `书名 [张三]`
  const tail = s.match(/^(.*?)[\s]*[\[【(（]([^\]】)）]{1,30})[\]】)）]\s*$/u);
  if (tail && tail[1] && tail[2]) {
    const inner = tail[2].trim();
    // 括号里必须是「像人名」才认，否则可能是「(套装共4册)」这类说明
    if (authorLikeness(inner) >= 4) {
      const a = normaliseAuthor(inner);
      const t = tail[1].trim();
      if (a && t) return { author: a, title: cleanTitle(t) };
    }
  }

  // ── 2. 分隔符 + 打分 ──
  for (const sep of [' - ', ' – ', ' — ', ' by ', ' -- ']) {
    const idx = s.indexOf(sep);
    if (idx <= 0 || idx >= s.length - sep.length) continue;
    const left = s.slice(0, idx).trim();
    const right = s.slice(idx + sep.length).trim();
    if (!left || !right) continue;

    const leftScore = authorLikeness(left);
    const rightScore = authorLikeness(right);
    // 右边明显更像人名 → 书名 - 作者
    if (rightScore > leftScore + 1) {
      const a = normaliseAuthor(right);
      if (a) return { author: a, title: cleanTitle(left) };
    }
    // 否则沿用原约定：作者 - 书名
    const a = normaliseAuthor(left);
    if (a) return { author: a, title: cleanTitle(right) };
  }

  return { author: null, title: stem };
}

/** 书名清洗：去掉包裹的书名号，保留原有信息 */
function cleanTitle(t: string): string {
  const s = t.trim().replace(/^[《【]\s*/, '').replace(/\s*[》】]$/, '').trim();
  return s || t.trim();
}

/** 从文件内容（前若干 KB，按文本解码）里猜作者。用于 TXT 这类没有元数据的格式。 */
export function guessAuthorFromText(sample: string): string | null {
  if (!sample) return null;
  // 只看开头部分：中文小说一般在前几行标注作者
  const head = sample.slice(0, 4000);
  const patterns = [
    /作\s*者\s*[:：]\s*([^\r\n]{1,40})/u,
    /著\s*者\s*[:：]\s*([^\r\n]{1,40})/u,
    /原\s*著\s*[:：]\s*([^\r\n]{1,40})/u,
    /^\s*([^\r\n]{1,40}?)\s*著\s*$/mu,
    /Author\s*[:：]\s*([^\r\n]{1,40})/i,
  ];
  for (const re of patterns) {
    const m = head.match(re);
    if (m && m[1]) {
      const a = normaliseAuthor(m[1]);
      if (a) return a;
    }
  }
  return null;
}

export function deriveMetadata(leafName: string): DerivedMetadata {
  const ext = extensionOf(leafName);
  const stem = ext ? leafName.slice(0, -(ext.length + 1)) : leafName;
  const cleanedStem = stem.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim() || stem;
  const { author, title } = guessAuthor(cleanedStem);
  const format = normaliseFormat(ext);
  return { title: title || cleanedStem || leafName, author, format, contentType: contentTypeFor(ext), extension: ext };
}

/** R2 对象键里的文件名部分 */
export function leafNameFromKey(key: string): string {
  const base = key.split('/').filter(Boolean).pop() ?? key;
  return base;
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
