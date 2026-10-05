/**
 * 虚拟目录树 —— 整个免费方案的成败在这里。
 *
 * 设计约束（来自可行性报告 7.6 节）：
 *   1. 目录总数 ≤ 200。绝不「每本书一个目录」，否则请求数直接乘以目录数。
 *   2. 目录「宽而浅」：根 → 集合 → 分桶 → 分页子目录 → 书（叶子）。
 *   3. 目录结构完全由 D1 推导，不对 R2 做 list()，因此不消耗 Class A 额度。
 *
 * 形状：
 *   /                          根（列出 4 个集合）
 *   /title/                    导航（列出有书的首字母桶）
 *   /title/A/                  列表第 1 页（≤ MAX_ENTRIES 本）
 *   /title/A/2/                列表第 2 页
 *   /title/A/<leaf_name>       书的叶子节点
 *   /author/  /format/         同构
 *   /recent/                   扁平集合，无分桶：/recent/、/recent/2/、/recent/<leaf>
 *
 * 目录总数上界：1(root) + 3(nav) + 28*3(字母/格式桶) + 分页目录 ≈ 110，远低于 200。
 */

export const COLLECTION_IDS = ['title', 'author', 'format', 'recent'] as const;
export type CollectionId = (typeof COLLECTION_IDS)[number];

export interface CollectionDef {
  id: CollectionId;
  label: string;
  /** true = 有分桶层级（/title/A/…）；false = 扁平（/recent/…） */
  bucketed: boolean;
}

export const COLLECTIONS: Record<CollectionId, CollectionDef> = {
  title: { id: 'title', label: '按书名', bucketed: true },
  author: { id: 'author', label: '按作者', bucketed: true },
  format: { id: 'format', label: '按格式', bucketed: true },
  recent: { id: 'recent', label: '最近收录', bucketed: false },
};

export function isCollectionId(value: string): value is CollectionId {
  return (COLLECTION_IDS as readonly string[]).includes(value);
}

/** 字母桶：A-Z / 0-9 / other。桶数固定 28 个，不随书量增长。 */
export const LETTER_BUCKETS: readonly string[] = [
  '0-9',
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
  'other',
];

export function letterBucket(input: string | null | undefined): string {
  const text = (input ?? '').trim();
  // 跳过前导的标点/空白，取第一个有意义的字符
  const m = text.match(/[A-Za-z0-9\u4e00-\u9fff]/);
  if (!m) return 'other';
  const ch = m[0];
  if (ch >= 'A' && ch <= 'Z') return ch;
  if (ch >= 'a' && ch <= 'z') return ch.toUpperCase();
  if (ch >= '0' && ch <= '9') return '0-9';
  // CJK 等其他文字统一进 other（Phase 1 可改成拼音首字母）
  return 'other';
}

export function bucketLabel(bucket: string): string {
  if (bucket === 'other') return '其他（含中文）';
  return bucket;
}

/** 已知的电子书/有声书扩展名白名单；不在表内的一律 other。 */
const FORMAT_MAP: Record<string, string> = {
  epub: 'epub',
  pdf: 'pdf',
  mobi: 'mobi',
  azw: 'azw3',
  azw3: 'azw3',
  fb2: 'fb2',
  djvu: 'djvu',
  txt: 'txt',
  rtf: 'rtf',
  doc: 'doc',
  docx: 'docx',
  cbz: 'cbz',
  cbr: 'cbr',
  m4a: 'm4a',
  m4b: 'm4b',
  mp3: 'mp3',
  zip: 'zip',
  md: 'md',
  html: 'html',
};

export function normaliseFormat(ext: string | null | undefined): string {
  const key = (ext ?? '').trim().toLowerCase().replace(/^\./, '');
  return FORMAT_MAP[key] ?? (key || 'other');
}

export const FORMAT_BUCKETS: readonly string[] = [
  'epub', 'pdf', 'mobi', 'azw3', 'txt', 'cbz', 'cbr', 'fb2', 'djvu', 'm4b', 'mp3', 'other',
];

/** 叶子节点在某个集合里归到哪个桶 */
export type BucketResolver = (book: { title: string; author: string | null; format_bucket: string }) => string;

export const BUCKET_RESOLVERS: Record<CollectionId, BucketResolver> = {
  title: (b) => letterBucket(b.title),
  author: (b) => letterBucket(b.author ?? b.title),
  format: (b) => b.format_bucket,
  recent: () => 'all',
};

// ── 路径解析 ────────────────────────────────────────────────────────────

export type DavNode =
  | { kind: 'root' }
  | { kind: 'nav'; collection: CollectionId }
  | { kind: 'list'; collection: CollectionId; bucket: string; page: number }
  | { kind: 'leaf'; collection: CollectionId; bucket: string; leafName: string }
  | { kind: 'unknown' };

export function isPageSegment(seg: string): boolean {
  return /^[1-9][0-9]{0,4}$/.test(seg);
}

export function splitPath(pathname: string): { segments: string[]; trailingSlash: boolean } {
  const trailingSlash = pathname.length > 1 && pathname.endsWith('/');
  const segments = pathname
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
  return { segments, trailingSlash };
}

export function resolveNode(pathname: string): DavNode {
  const { segments, trailingSlash } = splitPath(pathname);

  if (segments.length === 0) return { kind: 'root' };

  const rawCollection = segments[0] as string;
  if (!isCollectionId(rawCollection)) return { kind: 'unknown' };
  const collection = rawCollection;
  const def = COLLECTIONS[collection];

  // /<collection>/
  if (segments.length === 1) {
    if (!def.bucketed) return { kind: 'list', collection, bucket: 'all', page: 1 };
    return { kind: 'nav', collection };
  }

  const seg1 = segments[1] as string;

  // /<collection>/<seg>/
  if (segments.length === 2) {
    if (def.bucketed) {
      // 有分桶的集合这一层只能是桶（目录）；没有尾斜杠则当叶子处理。
      if (trailingSlash) return { kind: 'list', collection, bucket: seg1, page: 1 };
      return { kind: 'leaf', collection, bucket: seg1, leafName: seg1 };
    }
    // recent：seg 只能是页码（目录）或叶子（文件）
    if (trailingSlash) {
      if (isPageSegment(seg1)) return { kind: 'list', collection, bucket: 'all', page: Number(seg1) };
      return { kind: 'unknown' };
    }
    return { kind: 'leaf', collection, bucket: 'all', leafName: seg1 };
  }

  // /<collection>/<bucket>/<seg>/
  if (segments.length === 3) {
    if (!def.bucketed) return { kind: 'unknown' };
    const seg2 = segments[2] as string;
    if (trailingSlash) {
      if (isPageSegment(seg2)) return { kind: 'list', collection, bucket: seg1, page: Number(seg2) };
      return { kind: 'unknown' };
    }
    return { kind: 'leaf', collection, bucket: seg1, leafName: seg2 };
  }

  return { kind: 'unknown' };
}

/** 构造节点自身的 href（不含 base 前缀） */
export function nodePath(node: DavNode): string {
  switch (node.kind) {
    case 'root':
      return '/';
    case 'nav':
      return `/${node.collection}/`;
    case 'list': {
      const def = COLLECTIONS[node.collection];
      if (!def.bucketed) return node.page === 1 ? `/${node.collection}/` : `/${node.collection}/${node.page}/`;
      return node.page === 1
        ? `/${node.collection}/${node.bucket}/`
        : `/${node.collection}/${node.bucket}/${node.page}/`;
    }
    case 'leaf': {
      const def = COLLECTIONS[node.collection];
      return def.bucketed
        ? `/${node.collection}/${node.bucket}/${node.leafName}`
        : `/${node.collection}/${node.leafName}`;
    }
    default:
      return '/';
  }
}
