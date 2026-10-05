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
  html: 'text/html; charset=utf-8',
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

/** 从 `Author - Title.epub` 这类常见命名里猜作者；猜不到就返回 null。 */
function guessAuthor(stem: string): { author: string | null; title: string } {
  for (const sep of [' - ', ' – ', ' — ', ' by ']) {
    const idx = stem.indexOf(sep);
    if (idx > 0 && idx < stem.length - sep.length) {
      const author = stem.slice(0, idx).trim();
      const title = stem.slice(idx + sep.length).trim();
      if (author && title) return { author, title };
    }
  }
  return { author: null, title: stem };
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
