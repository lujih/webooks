/**
 * PROPFIND 条目缓存的键与失效逻辑。
 *
 * 缓存的是「条目 JSON」而不是最终 XML：不同客户端请求不同属性集时共享同一份缓存，
 * 命中率更高，失效也能做对。
 */

const CACHE_HOST = 'https://webooks.invalid'; // 保留域名，仅作缓存键

export function davCache(): Cache | null {
  try {
    return typeof caches !== 'undefined' && 'default' in caches ? caches.default : null;
  } catch {
    return null;
  }
}

/** 缓存键只含路径与 depth —— 不含属性集，因此不同属性的请求共享同一份条目缓存。 */
export function entriesCacheKey(davPath: string, depth: 0 | 1): string {
  return `${CACHE_HOST}/dav-entries?p=${encodeURIComponent(davPath)}&d=${depth}`;
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
 * 一本书在目录树里同时出现在 4 个集合下，所以写入/删除后要让这 4 处都失效：
 *   - 4 个叶子路径（depth 0，客户端会用它判断文件是否存在）
 *   - 4 个所属列表（depth 1）
 *   - 3 个导航页（depth 1，新增首字母桶时导航会变）
 * 合计 11 个键 —— 远低于 50 次/请求的 Cache API 上限。
 */
export function bookCacheTargets(book: BookCacheIdentity): Array<readonly [string, 0 | 1]> {
  const { leafName, titleLetter, authorLetter, formatBucket } = book;
  const leaf = (p: string): Array<readonly [string, 0 | 1]> => [[p, 0]];
  return [
    // 叶子：路径里的桶以书自身为准
    ...leaf(`/title/${titleLetter}/${leafName}`),
    ...leaf(`/author/${authorLetter}/${leafName}`),
    ...leaf(`/format/${formatBucket}/${leafName}`),
    ...leaf(`/recent/${leafName}`),
    // 所属列表
    [`/title/${titleLetter}/`, 1],
    [`/author/${authorLetter}/`, 1],
    [`/format/${formatBucket}/`, 1],
    ['/recent/', 1],
    // 导航（新增某个首字母/格式时会出现新桶）
    ['/title/', 1],
    ['/author/', 1],
    ['/format/', 1],
  ];
}
