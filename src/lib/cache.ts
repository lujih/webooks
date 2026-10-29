/**
 * PROPFIND 条目缓存的键与失效逻辑。
 *
 * 缓存的是「条目 JSON」而不是最终 XML：不同客户端请求不同属性集时共享同一份缓存，
 * 命中率更高，失效也能做对。
 */

import { bucketSegment, canonicalDavPath, collectionSegment, mediaKindOfFormat } from './collections';

/** 缓存键用的假域名（Cache API 要求绝对 URL；这里只作键，不参与网络请求） */
export const CACHE_HOST = 'https://webooks.invalid';

export function davCache(): Cache | null {
  try {
    return typeof caches !== 'undefined' && 'default' in caches ? caches.default : null;
  } catch {
    return null;
  }
}

/**
 * 缓存键只含路径与 depth —— 不含属性集，因此不同属性的请求共享同一份条目缓存。
 * 路径先做规范化：/recent/ 与 /最近收录/ 必须落在同一个键上，
 * 否则写入后按规范路径失效会打不中，客户端会看到陈旧列表。
 */
export function entriesCacheKey(davPath: string, depth: 0 | 1): string {
  return `${CACHE_HOST}/dav-entries?p=${encodeURIComponent(canonicalDavPath(davPath))}&d=${depth}`;
}

/**
 * 删除指定 (路径, depth) 组合的缓存条目。
 * 注意 Workers Free 的 Cache API 调用上限是 50 次/请求，调用方要控制条目数量。
 */
export async function purgeEntries(
  targets: Iterable<readonly [string, 0 | 1]>,
): Promise<number> {
  const cache = davCache();
  if (!cache) return 0;
  const keys = new Set<string>();
  for (const [path, depth] of targets) keys.add(entriesCacheKey(path, depth));
  let removed = 0;
  for (const key of keys) {
    if (await cache.delete(key)) removed++;
  }
  return removed;
}

/**
 * 「导航层」的失效键：根目录 + 5 个集合根（按书名/作者/类型/格式/最近收录）。
 *
 * 用途：**批量**写路径（reindex / migrate-keys / import-manifest / MOVE）。
 * 这类路径一次可能动十几本书，而每本书的完整失效集是 14 个键 ——
 * 十几本 = 200+ 次 `cache.delete`，必然撞 Workers Free 的 50 子请求上限
 *（Cache API 与子请求共用同一个池）。所以批量路径只打导航层 + 榜单。
 *
 * 已知边界（与 `collectionDeleteCacheTargets` 同一类取舍）：
 * 单本书的 depth-0 叶子条目不会在批量路径里被失效，最长
 * `PROPFIND_TTL`（默认 300s）后自然过期。列表入口是立即生效的。
 */
export function navCacheTargets(): Array<readonly [string, 0 | 1]> {
  const collections: Array<'title' | 'author' | 'type' | 'format' | 'recent'> = [
    'title', 'author', 'type', 'format', 'recent',
  ];
  return [
    ['/', 1],
    ...collections.map((c) => [`/${collectionSegment(c)}/`, 1] as const),
  ];
}

export interface BookCacheIdentity {
  leafName: string;
  titleLetter: string;
  authorLetter: string;
  formatBucket: string;
}

/**
 * 一本书在目录树里同时出现在 5 个集合下，所以写入/删除后要让这些地方都失效：
 *   - 5 个叶子路径（depth 0，客户端会用它判断文件是否存在）
 *   - 5 个所属列表（depth 1）
 *   - 4 个导航页（depth 1，新增首字母/格式/类型桶时导航会变）
 * 合计 14 个键 —— 远低于 50 次/请求的 Cache API 上限。
 *
 * 注意：路径段用**中文**（collectionSegment / bucketSegment），
 * 必须与 nodePath() 生成的一致，否则缓存键对不上、失效会失效。
 */
export function bookCacheTargets(book: BookCacheIdentity): Array<readonly [string, 0 | 1]> {
  const { leafName, titleLetter, authorLetter, formatBucket } = book;
  const leaf = (p: string): Array<readonly [string, 0 | 1]> => [[p, 0]];

  const title = collectionSegment('title');
  const author = collectionSegment('author');
  const type = collectionSegment('type');
  const format = collectionSegment('format');
  const recent = collectionSegment('recent');
  // 类型桶由格式派生，调用方不必额外传参
  const kind = bucketSegment(mediaKindOfFormat(formatBucket));

  return [
    // 叶子：路径里的桶以书自身为准
    ...leaf(`/${title}/${bucketSegment(titleLetter)}/${leafName}`),
    ...leaf(`/${author}/${bucketSegment(authorLetter)}/${leafName}`),
    ...leaf(`/${type}/${kind}/${leafName}`),
    ...leaf(`/${format}/${bucketSegment(formatBucket)}/${leafName}`),
    ...leaf(`/${recent}/${leafName}`),
    // 所属列表
    [`/${title}/${bucketSegment(titleLetter)}/`, 1],
    [`/${author}/${bucketSegment(authorLetter)}/`, 1],
    [`/${type}/${kind}/`, 1],
    [`/${format}/${bucketSegment(formatBucket)}/`, 1],
    [`/${recent}/`, 1],
    // 导航（新增某个首字母/格式/类型时会出现新桶）
    [`/${title}/`, 1],
    [`/${author}/`, 1],
    [`/${type}/`, 1],
    [`/${format}/`, 1],
  ];
}

/** 公开榜单的缓存键。榜单是「名字 + 本数」的聚合，低频变化，缓存 1 小时。 */
export function creditsCacheKey(): string {
  return `${CACHE_HOST}/public-credits`;
}

/**
 * 上传/删除/导入后让榜单缓存失效（1 次 Cache API 调用）。
 *
 * ⚠️ Cache API 在 Workers Free 有 50 次/请求的上限（见 purgeEntries 的注释），
 *   所以这里是**单独一次**调用，不与条目缓存的失效混在一起。
 *
 * 放在 lib 而不是 api/requests.ts：入库管道（lib/ingest.ts）要用它，
 * 而 lib 不应该反向依赖 api 层。api/requests.ts 仍原样转出这个名字，
 * 现有调用方（webdav、admin、upload）一行都不用改。
 */
export async function purgeCreditCache(): Promise<void> {
  const cache = davCache();
  if (!cache) return;
  try {
    await cache.delete(creditsCacheKey());
  } catch {
    /* 忽略 */
  }
}

/**
 * 求书墙列表的缓存键（分页参数不同则键不同）。
 * 求书提交后漏看 60 秒的代价接近零，所以**不做失效钩子** ——
 * 那是比缓存更贵的复杂度。见 api/requests.ts 的注释。
 */
export function requestsCacheKey(limit: number, offset: number): string {
  return `${CACHE_HOST}/api/requests?limit=${limit}&offset=${offset}`;
}

/**
 * 本 Worker 用到的全部缓存键前缀（`webooks.invalid/`）。
 *
 * ⚠️ **加新缓存时同步改这里** —— 否则测试之间会互相污染，
 * 表现为「上一个测试造的 Alice 出现在下一个测试的榜单里」这类
 * 无法解释的失败（真实踩过：榜单、求书墙各踩一次）。
 */
export const CACHE_KEY_PREFIXES = ['/public-credits', '/api/requests'] as const;

/** 按前缀清缓存（Cache API 没有 keys()，只能枚举已知前缀）。 */
export async function purgeByPrefixes(): Promise<number> {
  const cache = davCache();
  if (!cache) return 0;
  let n = 0;
  for (const p of CACHE_KEY_PREFIXES) {
    if (await cache.delete(`${CACHE_HOST}${p}`)) n++;
  }
  return n;
}
