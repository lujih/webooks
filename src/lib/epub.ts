/**
 * EPUB 元数据解析器 —— 从 ZIP 容器里提取「权威」的书名/作者/语言/封面。
 *
 * 为什么放 Worker 侧而不是浏览器：
 *   · 元数据必须来自文件本身，不信任客户端的字段（否则上传页可以伪造书名）
 *   · WebDAV PUT 上传和网页上传两条路径共用同一份解析，行为一致
 *
 * 为什么这样切（3 个小条目，不全解压）：
 *   1. META-INF/container.xml  ->  rootfile full-path  = OPF 路径
 *   2. OPF                    ->  dc:title / dc:creator / cover item
 *   3. 封面图                 ->  按 OPF 目录解析后的绝对路径
 * 每步只读一个条目，CPU 开销集中在小文件上，大 EPUB 也能在 10ms 内跑完
 * （真正的 50MB 上限由调用方保证，见 PARSE_SIZE_CAP）。
 */

import type { ZipEntry } from './zip';
import { readZipDirectory, readZipEntry, ZipReadError } from './zip';

export const PARSE_SIZE_CAP = 50 * 1024 * 1024; // 50MB，超过就跳过解析，退回文件名推导

export interface EpubMeta {
  title: string | null;
  author: string | null;
  language: string | null;
  /** 封面图字节；没有封面或超过 COVER_CAP 时为 null */
  cover: { bytes: ArrayBuffer; contentType: string } | null;
  /**
   * 内容形态判断：'comic' = 固定版式/图集（漫画），'text' = 普通文字书，
   * null = 判不出来（交给调用方按扩展名回退）。
   */
  layout: 'comic' | 'text' | null;
}

/**
 * 从 OPF 判断这本 EPUB 是「漫画」还是「文字书」。
 *
 * 两条线索，前者更硬：
 *   1. **固定版式声明** —— 漫画几乎都是固定版式（每页一张图，排版不可重排）：
 *      · `<meta property="rendition:layout">pre-paginated</meta>`（EPUB3 标准）
 *      · `<meta name="fixed-layout" content="true">`（Apple / Kobo 工具链）
 *      · `<meta name="original-resolution">`（Kobo 漫画导出）
 *   2. **清单以图片为主** —— 图片项明显多于 xhtml 页。
 *      普通小说：1 张封面 + 几十个章节 xhtml；漫画：几百张图 + 极少数 xhtml。
 *
 * 判不出就返回 null，绝不硬猜 —— 猜错的代价比不判更大（用户会看到书跑到错分类里）。
 */
export function sniffEpubLayout(opf: string): 'comic' | 'text' | null {
  // 1. 固定版式声明
  const prePaginated =
    /<meta[^>]*\bproperty\s*=\s*"rendition:layout"[^>]*>\s*pre-paginated/i.test(opf)
    || /<meta[^>]*\bname\s*=\s*"fixed-layout"[^>]*\bcontent\s*=\s*"true"/i.test(opf)
    || /<meta[^>]*\bname\s*=\s*"original-resolution"/i.test(opf);
  if (prePaginated) return 'comic';

  // 2. 图片项 vs 文档项
  const items = opf.match(/<item\b[^>]*>/gi) ?? [];
  let images = 0;
  let docs = 0;
  for (const it of items) {
    const mt = (it.match(/\bmedia-type\s*=\s*"([^"]*)"/i)?.[1] ?? '').toLowerCase();
    if (mt.startsWith('image/')) images++;
    else if (mt === 'application/xhtml+xml' || mt === 'text/html') docs++;
  }
  if (images === 0 && docs === 0) return null;
  // 图集型：图片多且远超文档数
  if (images >= 10 && images >= docs * 2) return 'comic';
  // 明确是文字书：文档占多数
  if (docs >= 3 && images < docs) return 'text';
  return null;
}

/**
 * 封面体积上限。
 *
 * 实测教训：原设 2MB 导致真实书被误判为「无封面」——中文网文导出工具常把封面
 * 存成 2.5–3MB 的高清 PNG。丢掉封面比多存几 MB 的代价大得多（封面是书架页的
 * 核心视觉），所以放宽到 8MB，覆盖绝大多数真实情况。
 *
 * 页面重量由浏览页控制：`<img loading="lazy">` + 固定小尺寸显示，
 * 只有滚动进视口的封面才会真正下载。典型 EPUB 封面 50–500KB，实际可接受。
 */
const COVER_CAP = 8 * 1024 * 1024;

/**
 * 封面允许的图片类型白名单。
 *
 * 安全要点（真实漏洞）：OPF 里 `<item media-type="…">` 完全由上传者控制。
 * 早期实现直接把这个声明值当作 R2 对象的 Content-Type 与扩展名，于是攻击者
 * 只要声明 `media-type="text/html"`，就能把任意 HTML/JS 以 `.html` 存进公开桶，
 * 由 `books.<域名>` 以 `text/html` 原样返回 —— 等于把项目域名变成任意内容
 * 托管点（钓鱼 / 挂马 / SEO 垃圾），并埋下跨子域存储型 XSS 隐患。
 *
 * 现在改为：**只信任字节魔数嗅探的结果**，声明值一律忽略。
 * SVG 刻意不入白名单 —— SVG 可内嵌 <script>，安全性等同 HTML。
 */
const COVER_TYPES: Record<string, { mime: string; ext: string }> = {
  jpeg: { mime: 'image/jpeg', ext: 'jpg' },
  png: { mime: 'image/png', ext: 'png' },
  gif: { mime: 'image/gif', ext: 'gif' },
  webp: { mime: 'image/webp', ext: 'webp' },
  bmp: { mime: 'image/bmp', ext: 'bmp' },
  avif: { mime: 'image/avif', ext: 'avif' },
  tiff: { mime: 'image/tiff', ext: 'tiff' },
};

/** 由封面 MIME 推导安全的扩展名；非白名单类型返回 null */
export function coverExtFor(contentType: string): string | null {
  const hit = Object.values(COVER_TYPES).find((v) => v.mime === contentType);
  return hit ? hit.ext : null;
}

/** 按魔数嗅探图片类型；返回白名单内的类型键，无法识别返回 null */
function sniffImageType(bytes: ArrayBuffer): string | null {
  if (bytes.byteLength < 12) return null;
  const b = new Uint8Array(bytes);
  const at = (i: number) => b[i] ?? -1;
  const ascii = (i: number, s: string) =>
    s.split('').every((c, k) => at(i + k) === c.charCodeAt(0));

  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'jpeg';
  if (at(0) === 0x89 && ascii(1, 'PNG') && at(4) === 0x0d && at(5) === 0x0a) return 'png';
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'webp';
  if (ascii(0, 'BM')) return 'bmp';
  if (ascii(0, 'II') && at(2) === 0x2a && at(3) === 0x00) return 'tiff';
  if (ascii(0, 'MM') && at(2) === 0x00 && at(3) === 0x2a) return 'tiff';
  if (ascii(4, 'ftyp')) {
    const brand = String.fromCharCode(at(8), at(9), at(10), at(11));
    if (brand === 'avif' || brand === 'avis') return 'avif';
  }
  return null;
}

/** 容器名有大小写/前缀差异（`META-INF/` vs `Meta-inf/`），按「不区分大小写」匹配 */
function findEntry(
  entries: Map<string, ZipEntry>,
  candidates: string[],
): string | null {
  for (const c of candidates) {
    if (entries.has(c)) return c;
  }
  // 回退：在已知的 key 里做不区分大小写匹配（EPUB 规范允许大小写不敏感查找）
  const target = candidates[0]?.toLowerCase();
  if (target) {
    for (const key of entries.keys()) {
      if (key.toLowerCase() === target) return key;
    }
  }
  return null;
}

function xmlText(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
  const m = xml.match(re);
  if (!m) return null;
  const text = stripTags(m[2]!);
  return text || null;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

/** 把 OPF 里的相对 href 解析成 zip 内的绝对路径（OPF 的目录 + href） */
function resolveZipPath(opfDir: string, href: string): string {
  let h = href.split('#')[0]!.trim();
  if (!h) return opfDir ? opfDir.replace(/\/+$/, '') : '';
  // 规范化：去掉 ./ 与 ../。注意 opfDir 可能带尾斜杠（OEBPS/），要过滤掉空段
  const base = opfDir.replace(/\/+$/, '');
  const parts: string[] = base ? base.split('/') : [];
  for (const seg of h.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.' && seg !== '') parts.push(seg);
  }
  return parts.filter((s) => s !== '').join('/');
}

export async function parseEpub(buf: ArrayBuffer): Promise<EpubMeta | null> {
  let entries;
  try {
    entries = readZipDirectory(buf);
  } catch (e) {
    if (e instanceof ZipReadError) return null;
    throw e;
  }

  const containerName = findEntry(entries, ['META-INF/container.xml']);
  if (!containerName) return null;
  const containerBuf = await readZipEntry(buf, entries, containerName);
  if (!containerBuf) return null;
  const containerXml = new TextDecoder().decode(new Uint8Array(containerBuf));

  const m = containerXml.match(/full-path\s*=\s*"([^"]+)"/i);
  const opfPath = m ? m[1]!.trim() : null;
  if (!opfPath) return null;
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

  const opfBuf = await readZipEntry(buf, entries, opfPath);
  if (!opfBuf) return null;
  const opf = new TextDecoder().decode(new Uint8Array(opfBuf));

  // 标题 / 作者 / 语言（EPUB 3 用 <dc:*>，EPUB 2 可能带包命名空间，都做容错）
  const title = xmlText(opf, 'dc:title') ?? xmlText(opf, 'title');
  const author = xmlText(opf, 'dc:creator') ?? xmlText(opf, 'creator');
  const language = xmlText(opf, 'dc:language') ?? xmlText(opf, 'language');

  // 封面：三条线索按可靠性依次尝试
  //   1. EPUB2 最常用：<meta name="cover" content="<item-id>"/>
  //      —— 真实世界绝大多数 EPUB（Calibre / Sigil / 各类导出工具）走这条
  //   2. EPUB3 正式写法：<item properties="cover-image"/>
  //   3. 部分工具：<meta property="ebooks:cover"><item-id></meta>
  let coverId: string | null = null;

  // (1) EPUB2 <meta name="cover" content="cover-img"/>
  const metaNameCover = opf.match(
    /<meta[^>]*\bname\s*=\s*"cover"[^>]*\bcontent\s*=\s*"([^"]+)"/i,
  );
  if (metaNameCover) coverId = metaNameCover[1]!.trim();

  // (3) <meta property="ebooks:cover">id</meta>
  if (!coverId) {
    const metaPropCover = opf.match(
      /<meta[^>]*property\s*=\s*"ebooks:cover"[^>]*>([\w-]+)<\/meta>/i,
    );
    if (metaPropCover) coverId = stripTags(metaPropCover[1] ?? '');
  }

  // 遍历 manifest：命中 coverId 的 item，或 (2) 带 properties="cover-image" 的 item
  const itemRe = /<item\b([^>]*?)\/?>/gi;
  let mItem: RegExpExecArray | null;
  let itemAttrs: string | null = null;
  let propsAttrs: string | null = null;
  let propsId: string | null = null;
  while ((mItem = itemRe.exec(opf)) !== null) {
    const attrs = mItem[1] ?? '';
    const id = attrs.match(/\bid\s*=\s*"([^"]+)"/i)?.[1] ?? null;
    // 精确命中 meta 声明的封面 id
    if (coverId && id === coverId) {
      itemAttrs = attrs;
      break;
    }
    // 记下 cover-image 属性作为回退（EPUB3），继续找精确命中
    if (!propsAttrs) {
      const props = attrs.match(/\bproperties\s*=\s*"([^"]+)"/i)?.[1] ?? '';
      if (/(^|\s)cover-image(\s|$)/.test(props)) {
        propsAttrs = attrs;
        propsId = id;
      }
    }
  }
  if (!itemAttrs && propsAttrs) {
    itemAttrs = propsAttrs;
    coverId = propsId;
  }

  let cover: EpubMeta['cover'] = null;
  if (coverId && itemAttrs) {
    const href = (itemAttrs.match(/\bhref\s*=\s*"([^"]+)"/i)?.[1]) ?? null;
    if (href) {
      const coverPath = resolveZipPath(opfDir, href);
      const coverBuf = await readZipEntry(buf, entries, coverPath);
      if (coverBuf && coverBuf.byteLength <= COVER_CAP) {
        // 安全关键：**忽略 OPF 里声明的 media-type**，只按字节魔数判定类型。
        // 声明值由上传者控制，信任它等于允许把 text/html 存进公开桶。
        // 嗅探不出来（或不是白名单内的位图）就当作没有封面。
        const sniffed = sniffImageType(coverBuf);
        if (sniffed) {
          cover = { bytes: coverBuf, contentType: COVER_TYPES[sniffed]!.mime };
        }
      }
    }
  }

  return {
    title: stripTags(title ?? '') || null,
    author: stripTags(author ?? '') || null,
    language: language?.trim() || null,
    cover,
    layout: sniffEpubLayout(opf),
  };
}