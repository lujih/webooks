/**
 * PROPFIND 条目缓存的键与失效逻辑。
 *
 * 缓存的是「条目 JSON」而不是最终 XML：不同客户端请求不同属性集时共享同一份缓存，
 * 命中率更高，失效也能做对。
 */

import { bucketSegment, canonicalDavPath, collectionSegment, mediaKindOfFormat } from './collections';

const CACHE_HOST = 'https://webooks.invalid'; // 保留域名，仅作缓存键

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
