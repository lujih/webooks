import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// 迁移在 Node 侧读好，作为 binding 传给测试 worker（vitest-pool-workers 的官方模式）
const migrations = await readD1Migrations('./migrations');

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './src/index.ts',
      miniflare: {
        compatibilityDate: '2026-08-22',
        d1Databases: { DB: 'webooks-test' },
        r2Buckets: { BUCKET: 'webooks-test' },
        cache: true,
        bindings: {
          R2_PUBLIC_BASE: 'https://books.test',
          MAX_ENTRIES: '200',
          PROPFIND_TTL: '300',
          DEPTH_INFINITY: 'downgrade',
          ADMIN_TOKEN: 'test-token',
          TEST_MIGRATIONS: migrations,
        },
      },
    }),
  ],
  test: {
    setupFiles: ['./test/setup.ts'],
  },
});
