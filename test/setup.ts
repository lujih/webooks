import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll } from 'vitest';
import type { Env } from '../src/config';
import { entriesCacheKey } from '../src/lib/cache';

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
}
