# 部署到 Cloudflare

三条路径，按「省事程度」排序。**任选一条，不要混用。**

---

## 前置：先把 R2 的公开自定义域准备好

这一步**三条路径都需要，而且最容易漏**。漏掉的症状有两个：WebDAV 能列目录，但一点
下载就 302 到一个 530 / DNS 失败的地址；浏览页的书卡也是直接指向这个域的，所以点书卡
同样打不开。

```
Cloudflare Dashboard → R2 → 你的桶 → Settings → Public access → Custom Domains → Connect Domain
```

绑一个你自己的子域，例如 `books.example.com`，然后把这个地址填进 `wrangler.jsonc` 的
`R2_PUBLIC_BASE`。

这个地址同时是浏览页书卡 href 的来源：书卡直接指向 `R2_PUBLIC_BASE/books/<id>`，
所以点一次下载**不消耗 Worker 请求**（WebDAV 客户端那条 302 路径仍然保留）。
填完之后如果线上是旧数据、下载下来是个随机 id 的文件名，跑一次回填即可：

```bash
curl -X POST "https://你的域名/api/admin/backfill-disposition?dryRun=1" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

先 `dryRun=1` 看数字，确认后去掉它真跑，返回 `nextAfter` 则用 `after=<那个值>` 继续调。
详见 README 的「数据导入」一节。

⚠️ 不要用 `r2.dev`：官方文档明说 *"not intended for production"*，几百 req/s 就会 429。

---

## 路径 A：Cloudflare Dashboard 连 Git（最省事）

适合：不想碰 API token，希望 push 就自动部署。

### 1. 推到 GitHub

```bash
git init
git add -A
git commit -m "feat: WebDAV ebook library on Workers Free + R2"
gh repo create webooks --public --source=. --remote=origin --push
```

### 2. 在 Cloudflare 连仓库

```
Dashboard → Workers & Pages → Create → Workers → Connect to Git
  → 选 webooks 仓库
  → Build command:      npm ci
  → Deploy command:     npm run deploy:cloudflare
```

`deploy:cloudflare` 的内容是 **`wrangler deploy && wrangler d1 migrations apply DB --remote`**。

> ⚠️ **顺序不能反**。wrangler 的自动资源创建只发生在 `wrangler deploy` 期间，
> 所以首次构建时 D1 根本还不存在。写成 `migrations apply && wrangler deploy` 会直接报：
>
> ```
> ✘ [ERROR] Couldn't find an auto-provisioned D1 DB named 'webooks-db' for binding 'DB'.
>   Run 'wrangler deploy' to provision it, or add 'database_name' / 'database_id' to your config.
> ```
>
> 先 deploy 的代价是存在一个「Worker 已上线但还没建表」的窗口（几秒）。
> 这个窗口内访问会返回 **503 并附上修复命令**，不是裸 500。

### 3. 设密钥

```
Workers & Pages → webooks → Settings → Variables and Secrets → Add
  ADMIN_TOKEN = <自己生成一串随机值>
  类型选 Secret（不要选 Plaintext）
```

生成随机值：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

### 4. 资源是自动创建的

`wrangler.jsonc` 里只写**语义化名字**（`webooks-db` / `webooks-bucket`），
没有账号相关的 ID —— 这是 wrangler 的
[自动资源创建](https://developers.cloudflare.com/changelog/post/2025-10-24-automatic-resource-provisioning/)
（需 wrangler ≥ 4.45，当前 4.147 ✅）。首次部署时 wrangler 会按名字调 API
查找/创建资源并绑定。

配置文件的 vars 里**只有 R2_PUBLIC_BASE 一个必填项**。其余参数
（挂载前缀、单目录上限、缓存 TTL、上传体积、写配额、Depth 策略）
全部走 `src/config.ts` 的默认值 —— 那些值都是按实测定的，
理由写在那个文件的注释里。要临时覆盖：

```bash
npx wrangler deploy --var PROPFIND_TTL=600
```

不必（也不建议）为此修改配置文件 —— 两处各写一份会产生漂移。

想改回手动模式：先 `wrangler d1 create` / `wrangler r2 bucket create`，再把
`database_name` / `database_id` / `bucket_name` 填回配置文件。

---

## 路径 B：GitHub Actions（本仓库已配好）

适合：想用 API token 走标准 CI/CD，且不要人工点 Dashboard。

### 1. 建 API token

```
Dashboard → My Profile → API Tokens → Create Token
  → 模板选 "Edit Cloudflare Workers"
  → 额外加上 D1 的 Edit 权限（模板默认可能没覆盖）
```

### 2. 加到 GitHub Secrets

```
仓库 → Settings → Secrets and variables → Actions
  Secrets:
    CLOUDFLARE_API_TOKEN  = 上一步的 token
    CLOUDFLARE_ACCOUNT_ID = Dashboard 右侧栏的 Account ID
    WRITE_TOKEN           = 站点的 WebDAV 写口令（可选，但强烈建议配）
  Variables（可选，但强烈建议）:
    WORKER_URL            = https://webooks.<你的子域>.workers.dev
```

`WORKER_URL` 用来在部署后自动跑冒烟测试、`dav-probe` 和
`scripts/verify-deploy.mjs`（行为探针 —— 它比对「修复前/后的返回码」，所以能
真正回答「线上跑的到底是不是新代码」）。

**`WRITE_TOKEN` 不配不会让 CI 变红，但会让最后三条探针静默跳过**，而那三条
才是版本判定的真正判据。之前的配置就是这样，结果探针拿一个匿名请求去测一条
「无口令必须 401」的用例（RFC 4918 §8.1 要求先拒授权），稳定打印

```
❌ Overwrite: F 撞已有目标（RFC §9.8.3）   期望 412（新代码），实际 401
结论：线上仍是旧代码（1 项不符预期）
```

—— 一次完全正确的部署被自己的门卫判成失败，让人去追一个不存在的问题。

另外，缺口令时那三条探针还会**往真实书库写临时文件而删不掉**（本站设计上
PUT 匿名可写、DELETE 需要口令），实测一条命令就把书库从 4 本变 8 本、多出来的
`__deploycheck_*` 只能手工清。所以探针现在的规矩是「跑了不能收场就不跑」：
没有 `WRITE_TOKEN` 时它们报「无法判定」并说明原因，一个字节都不写。

（`ADMIN_TOKEN` 不在这个列表里 —— 它是用 `npx wrangler secret put ADMIN_TOKEN`
直接设到 Worker 上的，CI 不需要它。早期文档把它列在这里是错的。）

### 3. push 即部署

工作流（[.github/workflows/deploy.yml](../.github/workflows/deploy.yml)）会依次做：

```
typecheck → npm test → npm run budget → d1 migrations apply → wrangler deploy → 行为探针
```

PR 只跑校验不部署；`workflow_dispatch` 可手动触发，并能关掉部署只做演练。

---

## 路径 C：本地 wrangler（调试最快）

适合：第一次跑通、或者想直接看日志。

```bash
npx wrangler login

# 本地建表 + 本地起服务
npm run db:migrate:local
npm run dev            # http://127.0.0.1:8788/dav/

# 部署到线上（先 deploy 创建资源，再迁移；顺序不能反，原因见路径 A）
npx wrangler secret put ADMIN_TOKEN
npm run deploy:cloudflare
```

⚠️ 首次 `wrangler deploy` 后，wrangler 会把自动生成的 `database_id` **写回 `wrangler.jsonc`**。
这会让配置文件带上你的账号信息。两种处理：

- **想保持仓库可分叉**：把写回的 ID 撤掉（`git checkout wrangler.jsonc`）。
  资源绑定关系已经存在服务端，后续部署不依赖配置文件里的 ID。
- **不介意**：直接提交。对单独自用更省事。

---

## 部署后必做：跑探针

三条路径都一样。**这是本项目最大的未知数，务必第一时间验证。**

```bash
node scripts/dav-probe.mjs --url https://你的域名/dav/
node scripts/size-probe.mjs --url https://你的域名/dav/ --dry-run
node scripts/size-probe.mjs --url https://你的域名/dav/
```

判定标准：

| 结果 | 含义 |
|---|---|
| **「动词放行」全绿** | 方案成立，继续往下做 |
| **PROPFIND 被边缘拦掉** | WebDAV 路线要推翻，需改为「写入走 POST + 预签名直传」 |
| `size-probe` 在 101 MB 被拒 | 符合预期，大文件只能走预签名直传 |
| `Expect: 100-continue` 警告 | 已知的 workerd 行为，Windows 资源管理器/Finder 建议用 rclone 代替 |

---

## 导入书籍

```bash
# 用 rclone 直连 R2 的 S3 端点（0 次 Worker 请求，最省钱）
rclone config create r2 s3 provider=Cloudflare \
  access_key_id=<R2_ACCESS_KEY> secret_access_key=<R2_SECRET> \
  endpoint=https://<ACCOUNT_ID>.r2.cloudflarestorage.com

rclone copy ./我的书库 r2:webooks/library/

# 建索引
curl -X POST "https://你的域名/api/admin/reindex?prefix=library/" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

返回 `nextCursor` 时带上同一个 cursor 再调一次，直到 `bucketsRebuilt: true`。

---

## 常见故障

| 症状 | 原因 | 处理 |
|---|---|---|
| `Couldn't find an auto-provisioned D1 DB named 'webooks-db' for binding 'DB'` | 迁移跑在 deploy 之前，而 D1 要等 deploy 才创建 | Deploy command 改成 `npm run deploy:cloudflare`（deploy 在前）|
| 访问返回 503 `Database schema is not initialised` | 已部署但还没跑迁移 | `npm run db:migrate`，或重跑一次 deploy command |
| 下载 302 到 530 / DNS 失败（含浏览页书卡点不开） | R2 公开自定义域没配，或 `R2_PUBLIC_BASE` 没改 | 见本文开头 |
| 下载下来是个随机 id 的文件名（如 `95e860d26bd874cf`） | 对象没有 `Content-Disposition`（下载名功能上线前写进去的） | `POST /api/admin/backfill-disposition`，见本文开头 |
| `PROPFIND` 返回 404 | 表没建 | `npm run db:migrate` |
| 目录列得出来但一直是空的 | 没跑 reindex，或 reindex 没走到最后一个 cursor | 看 `bucketsRebuilt` 是否为 true |
| 新增的书 5 分钟内不出现 | PROPFIND 缓存 TTL | 正常。`POST /api/admin/purge?path=/title/A/` 可立即失效 |
| 每天固定时段整站 1027 | Workers Free 每天 10 万请求打满（UTC 0 点 = 北京 08:00 重置） | `npm run budget` 看瓶颈；引导 rclone 用户走 S3 端点 |
| `wrangler deploy` 报账号未认证 | 没 `wrangler login` | 路径 C 第 1 步，或改用路径 A/B |

### 兜底：自动资源创建始终不工作时

改用显式创建（wrangler 的自动创建还是 open beta）：

```bash
npx wrangler d1 create webooks-db     # 记下返回的 database_id
npx wrangler r2 bucket create webooks
```

然后把 `wrangler.jsonc` 里的绑定补全：

```jsonc
"r2_buckets":  [{ "binding": "BUCKET", "bucket_name": "webooks" }],
"d1_databases":[{ "binding": "DB", "database_name": "webooks-db",
                  "database_id": "<上一步的 id>", "migrations_dir": "migrations" }]
```

这样配置里就带上了你的账号信息 —— 自己用没问题，但仓库不再适合直接 fork 部署。
