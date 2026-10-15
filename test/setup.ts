import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll } from 'vitest';
import type { Env } from '../src/config';
import { entriesCacheKey, purgeByPrefixes } from '../src/lib/cache';

export interface TestEnv extends Env {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
  ADMIN_TOKEN: string;
}

export const testEnv = env as unknown as TestEnv;

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

/**
 * Cache API 的内容不会随 isolatedStorage 回滚，测试之间会互相污染。
 * 每个测试开始前清掉用到的路径。
 */
export async function clearDavCache(paths: string[]): Promise<void> {
  const cache = caches.default;
  for (const p of paths) {
    await cache.delete(entriesCacheKey(p, 0));
    await cache.delete(entriesCacheKey(p, 1));
  }
}

/**
 * 每个测试前把业务数据清空。
 *
 * ⚠️ 加新表时**必须**往这里加一行 —— 否则该表的数据会在测试之间累积，
 * 表现为「单测逻辑全对，但涉及这张表的端到端测试莫名失败」。
 * （requests 表就是这样踩过一次：resetLibrary 没清它，
 *  「重复提交应合并成一条」于是看到 2 行。）
 */
export async function resetLibrary(): Promise<void> {
  await testEnv.DB.exec(
    'DELETE FROM books; DELETE FROM buckets; DELETE FROM locks; DELETE FROM requests;',
  );
  // ⚠️ 缓存也必须清 —— workerd 的 Cache API 对同一 isolate 是持久的，
  //   **不会**随 isolatedStorage 回滚，所以会跨测试共享。
  //   不清的话「上一个测试造的 Alice」会出现在「下一个测试的榜单」里。
  //
  //   踩过三次，每次都是同一形状：榜单（credits）、求书墙（requests）、
  //   分页参数组合（limit/offset 不同则键不同）。
  //
  //   对策是 purgeByPrefixes() —— 按前缀枚举删除。
  //   ⚠️ **加新缓存时必须同步改 CACHE_KEY_PREFIXES**，
  //      否则新缓存会成为下一个「莫名失败」的源头。
  await purgeByPrefixes();
}
