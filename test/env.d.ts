/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { Env } from '../src/config';

// 让 cloudflare:test 里 env 的类型与 src/config.ts 的 Env 对齐
declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
    ADMIN_TOKEN: string;
  }
}
