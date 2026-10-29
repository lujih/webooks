# 前后端联调实录（2026-10-23）

> 结论先行：五条用户旅程在真浏览器（Playwright Chromium × wrangler dev --local）
> 里全部跑通，36/36 断言通过；过程中抓出并修复了**一处真实的前后端错配**
> （complete 落库后不失效条目缓存，与上传页承诺「传完立刻能看到」矛盾），
> 并在本地把 `migrate-keys` 完整演练了一遍 —— 本地 16 本书的对象键形态
> 现在与生产一致（`books/<id>/<文件名>`）。
>
> 复跑方式：`npx wrangler dev --local --port 8907` + `node scripts/joint-debug.mjs`。
> 全程约 2 分钟（其中 61 秒是求书墙 60s 缓存的诚实等待，见 §3.3）。
>
> ⚠️ **管理旅程需要口令，且口令只能从环境变量来**：
> `JOINT_ADMIN_TOKEN=xxx node scripts/joint-debug.mjs`。未设置时整段跳过
> （打印 `[skip]`），不会失败。2026-10-28 审查发现本脚本早先**硬编码了
> 生产 ADMIN_TOKEN**，而仓库是公开的 —— 该值已进入 git 历史，唯一有效的
> 补救是**轮换密钥**（`npx wrangler secret put ADMIN_TOKEN`），
> 详见 `docs/reviews/2026-10-28-deep-audit/`。

## 0. 为什么需要这层联调

仓库里 681 个测试（联调前 678）全部停在两处：

- `SELF.fetch` —— Worker 层 HTTP，**不跑浏览器**：页面内联 JS 与后端的
  配合没有执行路径；
- 源码结构断言（`pages-syntax.test.ts` 等）—— 只证明「语法对、元素在」，
  不证明「点击后有对的行为」。

而五个页面（首页 / 求书墙 / 上传页 / 管理后台 / DAV 目录浏览）全部是
「服务端拼 HTML + 内联 JS」，没有前端框架 —— 恰恰是**内联 JS 与后端的
配合**零覆盖。这类 bug 的三个特点使它极难被现有套件发现：

- 语法对 ≠ 会调对接口；
- `Cannot set properties of null` 被 try/catch 吞成「登录失败」（真实事故）；
- 302 / CSP / 浏览器 HTTP 缓存这些只有真浏览器带 Origin / Sec-Fetch /
  If-None-Match 头时才显形 —— curl 和 SELF.fetch 都不带。

## 1. 联调环境（一键可重跑）

| 组件 | 值 | 说明 |
|---|---|---|
| dev server | `npx wrangler dev --local --port 8907` | 8907/8911/8923 备选，**不碰 8899**（属另一个工作区，保留其 python http.server） |
| 凭证 | `.dev.vars`（gitignore 第 7 行） | 测试专用 token；Turnstile 双双留空 = 生产关闭人机验证时的真实形态 |
| 浏览器 | Playwright 1.64.1 从 **npx 缓存** require | `~/.npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright`，**不给项目加依赖**（零运行时依赖红线）；脚本用 `createRequire(import.meta.url)` 在 .mjs 里加载 |
| 种子数据 | 本地 D1 的 16 本书 + 7 条求书 | 联调脚本自带 `cleanProbe()`（前后各跑一次）：D1 探针行、R2 `uploads/` 对象、榜单缓存 |

起停约定：PID 记在 `/tmp/wrangler-8907.pid`，杀进程用**显式 PID**，
绝不 `pkill -f`（误杀 8899 的 python3）。

## 2. 上传链路的本地边界（实测，不是推理）

这是本次联调最硬的一条边界，值得完整记录：

**miniflare 的 R2 没有 S3 端点。** `init` 用 SigV4 签出的预签名 PUT URL
指向 `<account>.r2.cloudflarestorage.com`（本地占位账号 `0000…`）——
浏览器 XHR 打过去 TLS 握手直接失败（`ERR_SSL_VERSION_OR_CIPHER_MISMATCH`，
实测约 0.5s）。所以本地**测不到真实的直传字节流**，那是线上能力。

联调实测的覆盖深度：

| 环节 | 本地能否真测 | 怎么测的 |
|---|---|---|
| 拖放区/文件选择/留名输入框交互 | ✅ 真测 | Playwright `setInputFiles` + 点击焦点断言 |
| init 协议（200、uploadUrl、ticket） | ✅ 真测 | 浏览器真实发起，网络日志计数 |
| 直传 PUT 到 R2 | ❌ 本地必失败 | 如实断言「失败必须在 UI 可见」（❌ + 人话提示），静默才是 bug |
| complete 落库 → 目录立刻可见 | ✅ 用「种对象」打通 | 见下 |

**种对象手法**：complete 只信 `BUCKET.head(key)`。dev 的 R2 实际持久化在
`miniflare-R2BucketObject/*.sqlite`（`_mf_objects` 表 + blobs 目录），
直接往里 INSERT 一行（**原始中文键** —— 注意 `wrangler r2 object put
--local` 会把键百分号编码后落库，与 Worker 自写键的形态不一致，
head 不到，这是 wrangler 两个子命令的已知分裂），再调 complete，
即可在本地跑通「complete → D1 落库 → PROPFIND 立刻可见」全链路。

## 3. 五条旅程 × 结果

### 3.1 首页（活书脊）

- 有书态：JS 从 `/api/credits` 拿 latest 渲染书脊；**一次页面加载只发一次
  fetch**（书脊与榜单共用）；链接是 R2 绝对直链（点它不经过 Worker）；
  无浏览器控制台报错。
- 空库态由单元测试覆盖（latest=null → 移除容器），联调脚本测有书态。

### 3.2 DAV 目录浏览

- 根目录书架卡 → 最近收录 → 书卡（`a.bookcard`）直链即 R2 URL；
- PROPFIND 书叶（XML 里 href 是**百分号编码**的 `<D:href>` 元素 ——
  断言必须用编码形态，这个坑在回归测试里也踩过一次）→ GET 书叶 302
  → Location 带可读文件名（新键形态）；
- **旧键衔接实测**（goal 里的第 ④ 项）：联调开始时本地 D1 里 15 本书仍是
  旧键 `books/b01`…`b15`，而生产 R2 已迁移 —— 点这些书卡 302 到生产
  **已删除**的对象 = 404（实测 `books/b01` → 404，新键 → 200）。
  处理：给 15 本旧键书补上本地 R2 对象后，用 `migrate-keys?apply=1`
  完整迁移（15 migrated / 0 failed / 0 missing），本地键形态与生产对齐，
  书卡直链全部变成 `books/<id>/<文件名>`。断言「无 books/bNN 裸键残留」。

### 3.3 求书墙

- 提交 → 201 + 「已经记下了」提示 → D1 有行 → 管理端
  `POST /api/admin/requests/<id>` 标记 ignored（真实管理路径）。
- **60 秒缓存窗口**（有意设计，见 `src/api/requests.ts` 的取舍注释）：
  提交后立刻刷新拿到的仍是缓存旧列表。联调如实对待：等 61 秒后验证上墙。
  这不是 bug —— 不在上传/标记/删除三条路径挂钩子的理由写在源码里
  （漏挂一处就是「改了半天没变」），60s 是更划算的取舍。

### 3.4 上传页

- 交互：选文件**只入队不自动开始**（设计如此，点「开始上传」才走 init）；
  留名输入框在 #drop 外可正常聚焦打字（回归过真实事故的位置）；
  Turnstile 未配置时容器 hidden、`NEED_TURNSTILE=false` 整段跳过；
- 本地边界：init 发起后直传必失败，断言失败在 UI 可见
  （`❌ 上传请求未能发出：可能是广告拦截插件拦了 r2.cloudflarestorage.com…`
  —— 完整的人话提示）；
- complete 全链路（种对象）：落库成功 → 解析出书名 → **目录页立刻可见**。

### 3.5 管理后台

- 登录（`#loginBtn`，文案是「进入」）→ 书目统计渲染；
- 动作清单实录：搜索 / 刷新 / 删除选中 / 刷新求书 / 每条求书的
  已收录|忽略|撤销 —— 联调执行了「刷新」无 JS 错误，求书清理走了
  真实的 `ignored` 标记路径。

## 4. 抓出的真实错配（已修 + 回归测试）

**complete 落库后没有失效 PROPFIND 条目缓存。**

上传页文案原话：「传完立刻能在 WebDAV 客户端与浏览器书架里看到」。
但 `handleUploadComplete` 只调了 `purgeCreditCache()`（榜单缓存）——
预热过的条目缓存（PROPFIND TTL 默认 300s）里新书最长 5 分钟不可见。
单元测试抓不到它：测试之间 `resetLibrary()` 清掉全部缓存，只有
「先预热 → complete → 不清缓存 → 立刻再查」这个顺序才暴露。

修复（`src/api/upload.ts`）：complete 里用与 migrate-keys / 删除路径
同一套 `bookCacheTargets({leafName, titleLetter, authorLetter, formatBucket})`
+ `purgeEntries()` 精准失效新书出现的全部路径（5 条叶子 + 5 个列表），
一次上传多花 ≤20 次 cache.delete，远在 Workers Free 的 50 次/请求上限内。

回归测试（`test/upload-cache-purge.test.ts`，3 条，全部**变异验证过**）：

1. 预热「最近收录」→ complete → 立刻可见（核心守卫，变异下红）；
2. 预热按书名/K/、按格式/epub/ → complete → 分桶立即可见
   （范围守卫；⚠️ 不预热时是假阴性 —— 第一次查询本来就会回源，
   变异测试实测过，测试注释里写了）；
3. 与新书无关的路径（按作者/L/）complete 后**仍然 HIT** ——
   失效必须精准，不能退化成全量清空。

变异验证：删掉 `purgeEntries` 调用 → 1 红（加固后 2 红）；还原 → 全绿。

## 5. 能力边界清单（如实记录，未实现/测不到的）

- **直传 PUT 字节流**：本地测不到（无 S3 口子）；线上验证属于
  `scripts/verify-presign.mjs` + 生产部署验证的职责。
- **Turnstile 真实挑战**：本地无挑战服务口子，联调覆盖的是
  「未配置 siteKey」缺省路径（NEED_TURNSTILE=false 整段跳过），
  这是生产关闭人机验证时的真实形态；开启后的 interaction-only
  渲染由单元测试覆盖（`pages-syntax.test.ts`）。
- **浏览器 HTTP 缓存层**：目录页带 `cache-control: max-age=300`，
  同一会话内二次导航直接吃缓存不发请求 —— 联调脚本用新 query string
  绕开（`?nocache=<ts>`）。这层是**设计**（重复浏览不耗 Worker 请求），
  联调断言的是服务端行为。
- **求书墙 60s 缓存**：见 §3.3，设计取舍而非 bug。
- **`wrangler r2 object put --local` 键编码分裂**：落库键被百分号编码，
  Worker `head()` 用原始键查不到 —— 种对象必须直接写 sqlite（§2）。
  这是 wrangler 工具链的已知边界，已在脚本注释里记录。
- **管理端「删除选中」**：需要 WRITE_TOKEN 且破坏性大，联调只做了
  登录 + 列表 + 无害动作 + 求书 ignored 标记，未真删书。

## 6. 覆盖矩阵总表

| 旅程 | 断言数 | DOM | HTTP | D1 | R2 键 | 本地边界 |
|---|---|---|---|---|---|---|
| 首页活书脊 | 5 | ✓ | ✓（/api/credits ×1） | — | ✓（直链形态） | — |
| DAV 目录→书叶→302 | 7 | ✓ | ✓（PROPFIND/GET） | — | ✓（新键迁移） | — |
| 求书提交→上墙→管理清理 | 8 | ✓ | ✓（POST/标记） | ✓ | — | 60s 缓存等待 |
| 上传 UI→init→complete→目录 | 12 | ✓ | ✓（init/complete） | — | ✓（种对象） | 直传 PUT 必失败 |
| 管理登录→列表→动作 | 4 | ✓ | — | — | — | — |

脚本：`scripts/joint-debug.mjs`（零项目依赖，Playwright 走 npx 缓存）。
