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

import { pinyinInitial } from './pinyin-table';
import { contextualInitial } from './pinyin-context';

export const COLLECTION_IDS = ['title', 'author', 'type', 'format', 'recent'] as const;
export type CollectionId = (typeof COLLECTION_IDS)[number];

export interface CollectionDef {
  id: CollectionId;
  label: string;
  /**
   * URL 路径里实际使用的段名。**故意用中文**：
   * 绝大多数 WebDAV 客户端（Windows 资源管理器、rclone、Cyberduck…）
   * 直接用 href 的最后一段当文件夹名，只有少数会读 displayname 属性。
   * 所以想让客户端显示「按书名」而不是「title」，路径本身就必须是中文。
   */
  segment: string;
  /** true = 有分桶层级（/<按书名>/A/…）；false = 扁平（/<最近收录>/…） */
  bucketed: boolean;
}

export const COLLECTIONS: Record<CollectionId, CollectionDef> = {
  title: { id: 'title', label: '按书名', segment: '按书名', bucketed: true },
  author: { id: 'author', label: '按作者', segment: '按作者', bucketed: true },
  type: { id: 'type', label: '按类型', segment: '按类型', bucketed: true },
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

  // 分页目录段（/最近收录/2/书名、/按格式/epub/2/书名）是**虚拟**的一层：
  // 成员的真实路径在它的上一层。缓存键与锁键必须把这一层归一掉 ——
  // 否则「按分页路径读」和「按真实路径失效」落在两个键上，删除后仍命中
  // 旧缓存（同一本书出现两份缓存，其中一份永不失效）。
  // 判据：页码段**后面还有段**才算分页前缀；居末位的页码是真正的目录。
  const lastIdx = out.length - 1;
  const normalised = out.filter(
    (seg, i) => !(i > 0 && i < lastIdx && isPageSegment(seg)),
  );

  const joined = `/${normalised.join('/')}`;
  return trailing ? `${joined}/` : joined;
}

/** 字母桶：A-Z / 0-9 / other。桶数固定 28 个，不随书量增长。 */
export const LETTER_BUCKETS: readonly string[] = [
  '0-9',
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
  'other',
];

/**
 * 取排序用的首字母桶。
 *
 * 识别优先级：
 *   1. 拉丁字母 → 该大写字母（a-z）
 *   2. 数字 → '0-9'
 *   3. **汉字 → 拼音首字母**（这是中文书库的关键：以前所有中文书都堆在 other，
 *      按书名/作者浏览等于没有分类。现在「三体」进 S、「末世降临」进 M）
 *   4. 表里查不到（生僻字、日文假名、西里尔等）→ 'other'
 *
 * 第 3 步的「拼音首字母」是两段式：
 *   ① 先查 `pinyin-context.ts` 的**多音字上下文表**（人工维护）。
 *      为什么必须有这一段：`pinyin-table.ts` 只认单字的**默认读音**，
 *      于是「重庆」按 zhòng 进 Z 桶、「厦门」按 shà 进 S 桶、「单田芳」按
 *      dān 进 D 桶 —— 全错。而这里的 `input` 是**完整书名/作者名**，
 *      首字后面就带着上下文（重**庆**、厦**门**、单**田芳**），够用来定读音。
 *   ② 上下文表没命中（null）才回落 `pinyinInitial(ch)` 的单字默认读音，
 *      于是绝大多数不含多音字的书行为**完全不变**。
 *   表本身的边界（表外多音字仍会错）写在该文件头部。
 *
 * 前导的标点/空白会被跳过：`《三体》` 与 `三体` 归到同一个桶。
 */
export function letterBucket(input: string | null | undefined): string {
  const text = (input ?? '').trim();
  // 找到第一个「可定序」的字符：拉丁字母 / 数字 / 汉字（含扩展 A 区）
  const m = text.match(/[A-Za-z0-9\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/);
  if (!m) return 'other';
  const ch = m[0];
  if (ch >= 'A' && ch <= 'Z') return ch;
  if (ch >= 'a' && ch <= 'z') return ch.toUpperCase();
  if (ch >= '0' && ch <= '9') return '0-9';
  // ① 多音字上下文：只看开头能匹配到的词（姓氏/地名/常见词）
  const contextual = contextualInitial(text);
  if (contextual) return contextual;
  // ② 回落：单字默认读音（占绝大多数，行为与以前完全一致）
  const py = pinyinInitial(ch);
  if (py) return py;
  return 'other';
}

/**
 * 「未知作者」桶的内部 id。
 *
 * 为什么单开一个桶，而不是像以前那样拿书名首字母顶替：
 * 没有作者的书如果落到某个字母下，会**冒充**成「作者姓 X」——
 * 一个没有作者信息的书库看起来像分类坏了。单列一个桶才诚实，
 * 也让「这批书缺作者，需要补」这件事一眼可见。
 */
export const UNKNOWN_AUTHOR_BUCKET = 'unknown';

/**
 * 桶的内部 id -> URL 路径段。
 * 「other」「unknown」在客户端里显示中文比英文 id 直观得多。
 * 内部 id 保持不变（D1 里已存的 *_letter 不用迁移）。
 */
export function bucketSegment(bucket: string): string {
  if (bucket === 'other') return '其他';
  if (bucket === UNKNOWN_AUTHOR_BUCKET) return '未知作者';
  return bucket;
}

/** 路径段 -> 内部桶 id（接受中文别名，也接受旧的英文 id） */
export function bucketFromSegment(segment: string): string {
  if (segment === '其他') return 'other';
  if (segment === '未知作者') return UNKNOWN_AUTHOR_BUCKET;
  return segment;
}

/** 桶的内部 id -> 展示名（HTML 页面用，比路径段更详细） */
export function bucketLabel(bucket: string): string {
  if (bucket === 'other') return '其他';
  if (bucket === UNKNOWN_AUTHOR_BUCKET) return '未知作者';
  if (KIND_LABEL[bucket]) return KIND_LABEL[bucket]!;
  return bucket;
}

// ── 格式识别 ────────────────────────────────────────────────────────────

/**
 * 扩展名 → 归一化格式 id。
 *
 * 分三类，便于「按类型」浏览与上传白名单：
 *   ebook 电子书 / comic 漫画 / audio 有声书
 * 不在这张表里的扩展名一律归到 'other'（并会被上传白名单拒绝）。
 */
const FORMAT_MAP: Record<string, string> = {
  // ── 电子书 ──
  epub: 'epub',
  pdf: 'pdf',
  mobi: 'mobi',
  azw: 'azw3',
  azw3: 'azw3',
  fb2: 'fb2',
  fbz: 'fb2',
  djvu: 'djvu',
  djv: 'djvu',
  txt: 'txt',
  rtf: 'rtf',
  doc: 'doc',
  docx: 'docx',
  odt: 'odt',
  md: 'md',
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  lit: 'lit',
  chm: 'chm',
  prc: 'prc',
  pdb: 'pdb',
  // ── 漫画（图片打包成压缩档）──
  cbz: 'cbz',
  cbr: 'cbr',
  cb7: 'cb7',
  cbt: 'cbt',
  cba: 'cba',
  // ── 有声书 ──
  m4a: 'm4a',
  m4b: 'm4b',
  mp3: 'mp3',
  // 通用压缩包：不是书籍格式，保留映射只为正确显示，但上传白名单会拒绝
  zip: 'zip',
};

/** 漫画格式（图片压缩档） */
export const COMIC_FORMATS: readonly string[] = ['cbz', 'cbr', 'cb7', 'cbt', 'cba'];
/** 有声书格式 */
export const AUDIO_FORMATS: readonly string[] = ['m4a', 'm4b', 'mp3'];
/** 电子书格式（非漫画、非音频的其余书籍格式） */
export const EBOOK_FORMATS: readonly string[] = [
  'epub', 'pdf', 'mobi', 'azw3', 'fb2', 'djvu', 'txt', 'rtf',
  'doc', 'docx', 'odt', 'md', 'html', 'lit', 'chm', 'prc', 'pdb',
];

/**
 * 允许上传的扩展名 = 电子书 + 漫画（**不含**有声书与通用压缩包）。
 *
 * 这是站点的上传白名单：WebDAV PUT 与网页上传共用同一份，
 * 避免出现「网页不让传、WebDAV 却能塞进来」的缺口。
 * 可用环境变量 MAX_UPLOAD_BYTES 之外的 ALLOWED_FORMATS 覆盖（见 config.ts）。
 */
export const ALLOWED_UPLOAD_FORMATS: readonly string[] = [...EBOOK_FORMATS, ...COMIC_FORMATS];

/** 原始扩展名（小写、不含点）是否在白名单内 */
export function isAllowedUploadExt(ext: string | null | undefined): boolean {
  const key = (ext ?? '').trim().toLowerCase().replace(/^\./, '');
  if (!key) return false;
  const fmt = FORMAT_MAP[key];
  return !!fmt && ALLOWED_UPLOAD_FORMATS.includes(fmt);
}

/** 类型桶的 id：ebook / comic / audio */
export type MediaKind = 'ebook' | 'comic' | 'audio';

/** 由归一化格式判断所属大类（用于「按类型」集合） */
export function mediaKindOfFormat(format: string): MediaKind {
  if (COMIC_FORMATS.includes(format)) return 'comic';
  if (AUDIO_FORMATS.includes(format)) return 'audio';
  return 'ebook';
}

const KIND_LABEL: Record<string, string> = {
  ebook: '电子书',
  comic: '漫画',
  audio: '有声书',
};

export function normaliseFormat(ext: string | null | undefined): string {
  const key = (ext ?? '').trim().toLowerCase().replace(/^\./, '');
  return FORMAT_MAP[key] ?? (key || 'other');
}

/** 「按格式」集合会出现的桶（按常见度排序，便于客户端展示） */
export const FORMAT_BUCKETS: readonly string[] = [
  'epub', 'pdf', 'mobi', 'azw3', 'txt', 'cbz', 'cbr', 'fb2', 'djvu',
  'doc', 'docx', 'rtf', 'md', 'html', 'm4b', 'mp3', 'other',
];

/** 「按类型」集合的桶 */
export const KIND_BUCKETS: readonly string[] = ['ebook', 'comic', 'audio'];

/** 叶子节点在某个集合里归到哪个桶 */
export type BucketResolver = (book: { title: string; author: string | null; format_bucket: string }) => string;

export const BUCKET_RESOLVERS: Record<CollectionId, BucketResolver> = {
  title: (b) => letterBucket(b.title),
  // 没有作者 → 「未知作者」桶。**不要**拿书名首字母顶替 ——
  // 那会让一本书看起来像「作者姓某字」，是错误信息而不是缺信息。
  author: (b) => (b.author && b.author.trim() ? letterBucket(b.author) : UNKNOWN_AUTHOR_BUCKET),
  format: (b) => b.format_bucket,
  type: (b) => mediaKindOfFormat(b.format_bucket),
  recent: () => 'all',
};

/** 取出「作者桶」——多处需要（写入、重算）用同一套规则 */
export function authorBucket(author: string | null | undefined): string {
  return author && author.trim() ? letterBucket(author) : UNKNOWN_AUTHOR_BUCKET;
}

// ── 路径解析 ────────────────────────────────────────────────────────────

export type DavNode =
  | { kind: 'root' }
  | { kind: 'nav'; collection: CollectionId }
  /**
   * `pageExplicit` 表示请求路径里**显式写了页码段**（`/最近收录/2/`、`/按书名/A/1/`）。
   * 为什么必须区分：RFC 4918 §8.3 要求成员 href 落在被请求集合之下，所以
   * 「显式分页」的列表成员的 href 必须带页段；而 `/最近收录/` 这种规范写法不带。
   * 两者是**不同 URL、不同缓存身份**（2026-10-28 审查 🔴-3/🔴-4）。
   */
  | { kind: 'list'; collection: CollectionId; bucket: string; page: number; pageExplicit?: boolean }
  /**
   * `page` 只在**经分页目录访问**时出现（`/最近收录/2/书名.epub`）。
   * 为什么需要：分页目录返回的成员 href 必须落在分页路径之下，否则严格的
   * WebDAV 客户端会认为「这些条目不属于被请求的集合」而当成空目录
   * （2026-10-26 真实事故：分页路径报「没有加载到数据」）。见 propfind.ts
   * 的 bookEntry 注释。
   */
  | { kind: 'leaf'; collection: CollectionId; bucket: string; leafName: string; page?: number }
  | { kind: 'unknown' };

export function isPageSegment(seg: string): boolean {
  return /^[1-9][0-9]{0,4}$/.test(seg);
}

/**
 * 这个路径段是不是该集合的**合法桶段**（`A`、`0-9`、`其他`、`epub`…）。
 *
 * 用途：在没有尾斜杠时判断「末段可能是目录」还是「末段是叶子」。
 * 见 resolveNode 里那段客户端事故注释。
 */
export function isBucketSegmentOf(collection: CollectionId, segment: string): boolean {
  const bucket = bucketFromSegment(segment);
  switch (collection) {
    case 'title':
      return LETTER_BUCKETS.includes(bucket);
    case 'author':
      return LETTER_BUCKETS.includes(bucket) || bucket === UNKNOWN_AUTHOR_BUCKET;
    case 'type':
      return KIND_BUCKETS.includes(bucket);
    case 'format':
      return FORMAT_BUCKETS.includes(bucket);
    case 'recent':
      // 扁平集合没有桶层
      return false;
  }
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
      //
      // ⚠️ 例外：**合法桶段即使没有尾斜杠也按目录解析**（2026-10-26 真实事故）。
      //
      //   现象：用户把站点挂成 WebDAV 盘后，第一层（`/dav/最近收录/`、
      //   `/dav/按书名/`）能正常列出；第二层全部报「没有加载到数据，请检查
      //   配置信息是否正确」—— `/dav/最近收录/2`、`/dav/按书名/A` 全挂。
      //
      //   原因：这类客户端**不按 PROPFIND 返回的 href 拼路径**，而是自己拼
      //   「父路径 + 名字」，拼出来的二级路径**没有尾斜杠**。而这里原来
      //   一律把「无尾斜杠」当叶子 → 去 D1 找一本名叫 `A` 的书 → 404。
      //   第一层之所以没事，是因为单段路径（`/最近收录`）无论有无尾斜杠
      //   都解析成集合，绕过了这条分支。
      //
      //   为什么用「合法桶段」当判据不会误伤叶子：本站所有叶子都必须带
      //   允许的扩展名（`isAllowedUploadExt` 在 WebDAV PUT、网页上传、
      //   reindex 三处都拦），所以 `A`、`2`、`其他` 这种**无点号的末段
      //   根本不可能**是书名。真书名一定带 `.epub` 之类，走下面的 leaf 分支。
      if (trailingSlash) return { kind: 'list', collection, bucket: seg1, page: 1 };
      if (isBucketSegmentOf(collection, segments[1] as string)) {
        return { kind: 'list', collection, bucket: seg1, page: 1 };
      }
      return { kind: 'leaf', collection, bucket: seg1, leafName: segments[1] as string };
    }
    // recent：seg 只能是页码（目录）或叶子（文件）
    if (trailingSlash) {
      if (isPageSegment(seg1)) {
        return {
          kind: 'list', collection, bucket: 'all',
          page: Number(seg1), pageExplicit: true,
        };
      }
      return { kind: 'unknown' };
    }
    // 同上：页码是无点号的纯数字，不可能是书名 —— 无尾斜杠也按目录解析。
    if (isPageSegment(seg1)) {
      return {
        kind: 'list', collection, bucket: 'all',
        page: Number(seg1), pageExplicit: true,
      };
    }
    return { kind: 'leaf', collection, bucket: 'all', leafName: segments[1] as string };
  }

  // /<集合>/<bucket>/<seg>/
  if (segments.length === 3) {
    const rawSeg2 = segments[2] as string;
    if (!def.bucketed) {
      // 扁平集合（最近收录）的这一层是**分页目录下的成员**：
      // /最近收录/2/书名.epub —— 分页列表把成员 href 放在分页路径下
      // （严格客户端的硬要求），所以这里必须能解析回来。
      if (isPageSegment(segments[1] as string)) {
        return {
          kind: 'leaf', collection, bucket: 'all',
          leafName: rawSeg2, page: Number(segments[1]),
        };
      }
      return { kind: 'unknown' };
    }
    if (trailingSlash) {
      if (isPageSegment(rawSeg2)) {
        return {
          kind: 'list', collection, bucket: seg1,
          page: Number(rawSeg2), pageExplicit: true,
        };
      }
      return { kind: 'unknown' };
    }
    // 页码段无尾斜杠同样按目录解析（同上面二级路径的客户端事故）
    if (isPageSegment(rawSeg2)) {
      return {
        kind: 'list', collection, bucket: seg1,
        page: Number(rawSeg2), pageExplicit: true,
      };
    }
    return { kind: 'leaf', collection, bucket: seg1, leafName: rawSeg2 };
  }

  // /<集合>/<bucket>/<页码>/<叶子> —— 分页目录下的成员（有分桶集合）
  if (segments.length === 4) {
    if (!def.bucketed) return { kind: 'unknown' };
    if (!isPageSegment(segments[2] as string)) return { kind: 'unknown' };
    return {
      kind: 'leaf', collection, bucket: seg1,
      leafName: segments[3] as string, page: Number(segments[2]),
    };
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
      // 只有**显式分页**才把页码写回自身 href；`/最近收录/` 的规范形态不带 /1/
      const pageSeg = node.pageExplicit ? `/${node.page}` : '';
      if (!def.bucketed) return `/${col}${pageSeg}/`;
      const b = bucketSegment(node.bucket);
      return `/${col}/${b}${pageSeg}/`;
    }
    case 'leaf': {
      const def = COLLECTIONS[node.collection];
      const col = collectionSegment(node.collection);
      // 经分页目录访问时，自身 href 也要带分页段（与请求路径一致，
      // 否则严格的客户端会认为「返回的不是我要的那个资源」）
      const pageSeg = node.page && node.page > 1 ? `/${node.page}` : '';
      return def.bucketed
        ? `/${col}/${bucketSegment(node.bucket)}${pageSeg}/${node.leafName}`
        : `/${col}${pageSeg}/${node.leafName}`;
    }
    default:
      return '/';
  }
}
