/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { Env } from '../src/config';

/** public/ 下的产物快照 + 跑在 Worker 之外、SELF.fetch() 看不到的仓库文件 */
export interface StaticAssetsSnapshot {
  files: Record<string, string>;
  wranglerJsonc: string;
  budgetSource: string;
}

// 让 cloudflare:test 里 env 的类型与 src/config.ts 的 Env 对齐
declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
    ADMIN_TOKEN: string;
    // Node 侧读好的静态资源快照 —— workerd 的 node:fs 是空壳，读不到仓库文件
    TEST_STATIC_ASSETS: StaticAssetsSnapshot;
  }
}
