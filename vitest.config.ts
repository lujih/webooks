import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// 迁移在 Node 侧读好，作为 binding 传给测试 worker（vitest-pool-workers 的官方模式）
const migrations = await readD1Migrations('./migrations');

/**
 * 仓库文件快照（Node 侧读好，同 TEST_MIGRATIONS 一套做法）。
 *
 * 为什么必须绕这一道：测试跑在 workerd 里，而 workerd 的 `node:fs`
 * **是个空壳** —— `typeof readFileSync === 'function'` 成立，
 * 但任何路径都抛 ENOENT（连 process.cwd() 自己都 readdir 不了）。
 * 早期用「typeof 检查」探测过，结论是假的，值得记下来。
 *
 * 于是把 public/ 的内容、wrangler.jsonc、budget.mjs 在 Node 侧读好、
 * 当成 binding 传进去，让测试能对**真实文件**断言那些
 * 「跑在 Worker 之外、SELF.fetch() 看不到」的东西。
 */
function readStaticAssetsSnapshot() {
  const root = process.cwd();
  const dir = resolve(root, 'public');
  const files: Record<string, string> = {};
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      // favicon.ico 是二进制，用 latin1 才不会在 UTF-8 解码时损坏字节；
      // 测试里只做头部字节校验，latin1 能原样往返。
      files[name] = readFileSync(resolve(dir, name), 'latin1');
    }
  }
  const read = (rel: string): string => {
    const p = resolve(root, rel);
    return existsSync(p) ? readFileSync(p, 'utf8') : '';
  };
  return {
    files,
    wranglerJsonc: read('wrangler.jsonc'),
    // 预算模型的源码。它不是静态资源，但它**跑在 Worker 之外**，
    // 同样只能这样读到 —— 测试要钉的是它的「诚实性」：
    // 不许再把 Cache API 命中当成省请求，也不许在忙日会打满时说「不会停摆」。
    budgetSource: read('scripts/budget.mjs'),
  };
}

const staticAssets = readStaticAssetsSnapshot();

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
          // 上传链路的占位凭据：只为让「格式检查 → 验证码」这段逻辑能跑到。
          // Turnstile 校验在测试里必然失败（没有真实 token），这正是我们要断言的行为。
          R2_ACCOUNT_ID: 'test-account',
          R2_ACCESS_KEY_ID: 'test-access-key',
          R2_SECRET_ACCESS_KEY: 'test-secret-key',
          R2_BUCKET_NAME: 'webooks-test',
          TURNSTILE_SECRET: 'test-turnstile-secret',
          TEST_MIGRATIONS: migrations,
          TEST_STATIC_ASSETS: staticAssets,
        },
      },
    }),
  ],
  test: {
    setupFiles: ['./test/setup.ts'],
  },
});
