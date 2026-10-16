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
 *
 * ⚠️ 这些快照只喂给 workerd 项目。Node 项目**不读**它们 —— 那边的测试
 * 直接在文件系统上动手（起假服务器、spawn 真脚本），断言源码文本的活
 * 干不了也不该干。两者互补，不是重复。
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
    // 线上验证探针。它有若干已实测的事故：缺口令时报假阴性、把正确的部署
    // 判成「线上仍是旧代码」、缺口令时还去写留下删不掉的垃圾。
    //
    // ⚠️ 这个字段只能钉住「**调用点**在不在」。它原理上钉不住
    //    emitFailureAnnotation 的**函数体**是不是空壳 —— 把函数体改成
    //    开头就 `return;`，所有 toContain('emitFailureAnnotation(') 依然成立。
    //    所以下面这个脚本的**行为**由 Node 项目真跑一遍来钉
    //    （test/verify-deploy.behavior.test.mjs）。两边都要，少一条就是漏洞。
    verifyDeploySource: read('scripts/verify-deploy.mjs'),
    deployWorkflow: read('.github/workflows/deploy.yml'),
    // 路由分发源码。wrangler.jsonc 的 run_worker_first 是「哪些路径归 Worker」
    // 的唯一清单，而漏一条 = 那个路由对真人静默 404、测试套件还抓不到
    // （SELF.fetch 不经过资源路由层）。所以在这里读源码，让测试把
    // 路由字面量与那份清单**逐条比对** —— 这是唯一能自动发现漏项的防线。
    indexSource: read('src/index.ts'),
  };
}

const staticAssets = readStaticAssetsSnapshot();

/**
 * 两个项目（vitest 4 的 `test.projects`），按**运行环境**分开。
 *
 * ⚠️ 为什么必须拆开，不能塞进同一个项目：
 *   workerd 里没有 child_process、没有文件系统。让 Node 侧的测试待在同一个
 *   项目里，它要 spawn 时只会拿到一个空壳 child_process —— 跟 `node:fs`
 *   在 workerd 里是同一种陷阱（typeof 成立、调用即炸）。这个仓库已经为
 *   node:fs 交过一次学费（见上面 readStaticAssetsSnapshot 的注释）。
 *
 *   另外 `setupFiles: ['./test/setup.ts']` 会 import `cloudflare:test`，
 *   那个模块在 Node 项目里根本不存在 —— 不拆开，Node 项目在 setup 阶段
 *   就整个炸掉。所以隔离是**必须**的，不是洁癖。
 *
 * ⚠️ 两个项目的 include 互补且**互斥**（互斥是靠 ① 显式写死 include 做到的，
 *   不是靠默认值 —— 默认值会把 node 项目的文件也收进来，见那处注释）：
 *   · worker 项目只跑 `test` 目录下以 `.test.ts` 结尾的文件，都在 workerd 里；
 *   · node 项目只跑 `test` 目录下以 `.behavior.test.mjs` 结尾的文件。
 *   为什么用 `.mjs` 而不是 `.ts`：本仓库**没有 @types/node**，而这些测试
 *   要用 node:http / node:child_process。在 TS 里补齐只能靠
 *   `@ts-expect-error` 或 `declare module` 糊，而 tsconfig.json 是**写范围
 *   之外**的文件，改它等于越界。tsconfig.json 的 include 只有
 *   `src` 与 `test` 两个目录下的 `.ts` 文件（逐层通配）—— 不含 `.mjs`，
 *   于是 typecheck 天然跳过它，不必改 tsconfig，也不必新增任何依赖。
 *   代价是新测试不受 typecheck 保护。值不值：值 —— 这些测试的断言对象是
 *   HTTP 请求与 exit code，本来就以**运行时行为**为准，静态类型帮不上忙；
 *   而让 `npm run typecheck` 保持零改动、零新增依赖更重要。
 */
export default defineConfig({
  test: {
    projects: [
      {
        // ① 业务逻辑：跑在 workerd 里（SELF.fetch / D1 / R2 / Cache）。
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
          name: 'worker',
          setupFiles: ['./test/setup.ts'],
          // ⚠️ 必须显式写死，不能吃默认值。默认 include 是
          // `**/*.{test,spec}.?(c|m)[jt]s?(x)` —— 它**也会**匹配
          // `test/verify-deploy.behavior.test.mjs`（文件名以 `.test.mjs` 结尾）。
          // 于是那个文件被两个项目同时收集，在 workerd 里跑，`spawn` 直接抛
          // `The child_process.spawn method is not implemented`，8 条全红。
          // （`npx vitest list --project node` 能看到 node 项目收集对了，
          //  但那只证明 node 项目对，不证明 worker 项目不越界。）
          // 这里只收 `.ts`，与 node 项目的 `.behavior.test.mjs` 严格互斥。
          include: ['test/**/*.test.ts'],
        },
      },
      {
        // ② 脚本行为：`scripts/*.mjs` 是**跑在 Node 里**的东西
        //    （CI 的 verify-live job 就是 `node scripts/verify-deploy.mjs`）。
        //    workerd 够不着它们，只能在这里 spawn 真进程来跑。
        test: {
          name: 'node',
          environment: 'node',
          include: ['test/**/*.behavior.test.mjs'],
        },
      },
    ],
  },
});