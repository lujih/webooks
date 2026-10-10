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
    const mediaType = itemAttrs.match(/\bmedia-type\s*=\s*"([^"]+)"/i)?.[1] ?? 'image/jpeg';
    if (href) {
      const coverPath = resolveZipPath(opfDir, href);
      const coverBuf = await readZipEntry(buf, entries, coverPath);
      if (coverBuf && coverBuf.byteLength <= COVER_CAP) {
        cover = { bytes: coverBuf, contentType: mediaType };
      }
    }
  }

  return {
    title: stripTags(title ?? '') || null,
    author: stripTags(author ?? '') || null,
    language: language?.trim() || null,
    cover,
  };
}