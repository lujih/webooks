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
  /**
   * URL 路径里实际使用的段名。**故意用中文**：
   * 绝大多数 WebDAV 客户端（Windows 资源管理器、rclone、Cyberduck…）
   * 直接用 href 的最后一段当文件夹名，只有少数会读 displayname 属性。
   * 所以想让客户端显示「最近收录」而不是「recent」，路径本身就必须是中文。
   */
  segment: string;
  /** true = 有分桶层级（/<按书名>/A/…）；false = 扁平（/<最近收录>/…） */
  bucketed: boolean;
}

export const COLLECTIONS: Record<CollectionId, CollectionDef> = {
  title: { id: 'title', label: '按书名', segment: '按书名', bucketed: true },
  author: { id: 'author', label: '按作者', segment: '按作者', bucketed: true },
  format: { id: 'format', label: '按格式', segment: '按格式', bucketed: true },
  recent: { id: 'recent', label: '最近收录', segment: '最近收录', bucketed: false },
};

export function isCollectionId(value: string): value is CollectionId {
  return (COLLECTION_IDS as readonly string[]).includes(value);
}

/**
 * 把路径段解析成集合 id。
 * 同时接受**中文段名**（新，客户端友好）与**英文 id**（旧链接兼容），
 * 这样改了路径也不会让已有书签/收藏失效。
 */
export function collectionFromSegment(segment: string): CollectionId | null {
  if (isCollectionId(segment)) return segment;
  for (const def of Object.values(COLLECTIONS)) {
    if (def.segment === segment) return def.id;
  }
  return null;
}

/** 集合 id -> URL 路径段（生成 href 用） */
export function collectionSegment(id: CollectionId): string {
  return COLLECTIONS[id].segment;
}

/**
 * 把请求路径里的百分号编码还原成可读文本。
 * 展示（面包屑/标题）必须用它，否则页面会显示 %E6%8C%89%E4%B9%A6%E5%90%8D 这种东西。
 * 同时「与节点路径比较」也必须用还原后的形式 —— 节点路径是解码过的。
 */
export function decodeDavPath(pathname: string): string {
  return pathname
    .split('/')
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    })
    .join('/');
}

/**
 * 把请求路径规范化成「规范形式」：集合段与桶段一律用中文段名。
 *
 * 为什么必须做：路径既接受中文段名（客户端友好），也接受旧的英文段名（兼容），
 * 且浏览器/客户端发来的是**百分号编码**形式。缓存键、锁资源这类「路径身份」
 * 场合，同一资源的各种写法必须归一到同一个键，否则会出现：
 *   · 客户端用 /recent/ 缓存了一份目录，写书时按 /最近收录/ 去失效 → 失效不中，列表变陈旧
 *   · 在 /最近收录/x.epub 上加锁，却往 /recent/x.epub 写 → 锁形同虚设
 *   · 中文路径是 %E6%8C%89… 编码的，不先解码就认不出是哪个集合
 * 尾斜杠（目录标记）原样保留。
 */
export function canonicalDavPath(pathname: string): string {
  const trailing = pathname.length > 1 && pathname.endsWith('/');
  // 先解码：客户端发来的是 %E6%8C%89%E4%B9%A6%E5%90%8D 这种形式
  const segs = decodeDavPath(pathname)
    .split('/')
    .filter((s) => s.length > 0);
  if (segs.length === 0) return '/';

  const col = collectionFromSegment(segs[0]!);
  if (!col) return decodeDavPath(pathname); // 未知集合：解码后原样返回

  const out: string[] = [collectionSegment(col)];
  if (segs.length > 1) {
    // 第二段在分桶集合里是桶；在 recent 里是页码或文件名（映射为恒等）
    out.push(bucketSegment(bucketFromSegment(segs[1]!)));
    for (let i = 2; i < segs.length; i++) out.push(segs[i]!);
  }
  const joined = `/${out.join('/')}`;
  return trailing ? `${joined}/` : joined;
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

/**
 * 桶的内部 id -> URL 路径段。
 * 「other」桶装的是中文书，客户端里显示「其他」比「other」直观得多。
 * 内部 id 保持不变（D1 里已存的 format_bucket / *_letter 不用迁移）。
 */
export function bucketSegment(bucket: string): string {
  return bucket === 'other' ? '其他' : bucket;
}

/** 路径段 -> 内部桶 id（接受中文别名，也接受旧的英文 other） */
export function bucketFromSegment(segment: string): string {
  return segment === '其他' ? 'other' : segment;
}

/** 桶的内部 id -> 展示名（HTML 页面用，比路径段更详细） */
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
  const collection = collectionFromSegment(rawCollection);
  if (!collection) return { kind: 'unknown' };
  const def = COLLECTIONS[collection];

  // /<集合>/
  if (segments.length === 1) {
    if (!def.bucketed) return { kind: 'list', collection, bucket: 'all', page: 1 };
    return { kind: 'nav', collection };
  }

  // 桶这一层可能是中文路径段（「其他」），转回内部 id
  const seg1 = bucketFromSegment(segments[1] as string);

  // /<集合>/<seg>/
  if (segments.length === 2) {
    if (def.bucketed) {
      // 有分桶的集合这一层只能是桶（目录）；没有尾斜杠则当叶子处理。
      if (trailingSlash) return { kind: 'list', collection, bucket: seg1, page: 1 };
      return { kind: 'leaf', collection, bucket: seg1, leafName: segments[1] as string };
    }
    // recent：seg 只能是页码（目录）或叶子（文件）
    if (trailingSlash) {
      if (isPageSegment(seg1)) return { kind: 'list', collection, bucket: 'all', page: Number(seg1) };
      return { kind: 'unknown' };
    }
    return { kind: 'leaf', collection, bucket: 'all', leafName: segments[1] as string };
  }

  // /<集合>/<bucket>/<seg>/
  if (segments.length === 3) {
    if (!def.bucketed) return { kind: 'unknown' };
    const rawSeg2 = segments[2] as string;
    if (trailingSlash) {
      if (isPageSegment(rawSeg2)) return { kind: 'list', collection, bucket: seg1, page: Number(rawSeg2) };
      return { kind: 'unknown' };
    }
    return { kind: 'leaf', collection, bucket: seg1, leafName: rawSeg2 };
  }

  return { kind: 'unknown' };
}

/** 构造节点自身的 href（不含 base 前缀）。路径段一律用中文，客户端才会显示中文。 */
export function nodePath(node: DavNode): string {
  switch (node.kind) {
    case 'root':
      return '/';
    case 'nav':
      return `/${collectionSegment(node.collection)}/`;
    case 'list': {
      const def = COLLECTIONS[node.collection];
      const col = collectionSegment(node.collection);
      if (!def.bucketed) return node.page === 1 ? `/${col}/` : `/${col}/${node.page}/`;
      const b = bucketSegment(node.bucket);
      return node.page === 1 ? `/${col}/${b}/` : `/${col}/${b}/${node.page}/`;
    }
    case 'leaf': {
      const def = COLLECTIONS[node.collection];
      const col = collectionSegment(node.collection);
      return def.bucketed
        ? `/${col}/${bucketSegment(node.bucket)}/${node.leafName}`
        : `/${col}/${node.leafName}`;
    }
    default:
      return '/';
  }
}
