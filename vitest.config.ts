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
          // 破坏性操作口令：测试里设为非空，才能验证「没口令就删不掉」
          WRITE_TOKEN: 'test-write-token',
          MAX_UPLOAD_BYTES: '1048576', // 1 MiB，方便测 413
          DAILY_WRITE_QUOTA: '0', // 测试里关掉节流，避免互相干扰
          TEST_MIGRATIONS: migrations,
        },
      },
    }),
  ],
  test: {
    setupFiles: ['./test/setup.ts'],
  },
});
