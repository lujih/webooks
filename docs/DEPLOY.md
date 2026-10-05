# 部署到 Cloudflare

三条路径，按「省事程度」排序。**任选一条，不要混用。**

---

## 前置：先把 R2 的公开自定义域准备好

这一步**三条路径都需要，而且最容易漏**。漏掉的症状是：WebDAV 能列目录，但一点下载就
302 到一个 530 / DNS 失败的地址。

```
Cloudflare Dashboard → R2 → 你的桶 → Settings → Public access → Custom Domains → Connect Domain
```

绑一个你自己的子域，例如 `books.example.com`，然后把这个地址填进 `wrangler.jsonc` 的
`R2_PUBLIC_BASE`。

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
  → Deploy command:     npx wrangler d1 migrations apply DB --remote && npx wrangler deploy
```

**Deploy command 必须把迁移串在前面**：先有表结构，Worker 上线才能正常服务。
（这个仓库里 `.github/workflows/deploy.yml` 是路径 B 用的，走路径 A 时不会执行，
但放着不影响。）

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

`wrangler.jsonc` 里故意没写 D1 / R2 的 ID 和名称 —— 这是 wrangler 的
[自动资源创建](https://developers.cloudflare.com/changelog/post/2025-10-24-automatic-resource-provisioning/)
（需 wrangler ≥ 4.45，当前 4.147 ✅）。首次部署时 wrangler 会调 API 建好 D1 和 R2 并绑定。

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
    ADMIN_TOKEN           = 那串随机值
  Variables（可选，但强烈建议）:
    WORKER_URL            = https://webooks.<你的子域>.workers.dev
```

`WORKER_URL` 用来在部署后自动跑冒烟测试和 `dav-probe`。

### 3. push 即部署

工作流（[.github/workflows/deploy.yml](../.github/workflows/deploy.yml)）会依次做：

```
typecheck → npm test → npm run budget → d1 migrations apply → wrangler deploy → 冒烟测试
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

# 部署到线上
npm run db:migrate     # 应用到远端 D1（会自动创建 D1 和 R2）
npx wrangler secret put ADMIN_TOKEN
npm run deploy
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
| 下载 302 到 530 / DNS 失败 | R2 公开自定义域没配，或 `R2_PUBLIC_BASE` 没改 | 见本文开头 |
| `PROPFIND` 返回 404 | 表没建 | `npm run db:migrate` |
| 目录列得出来但一直是空的 | 没跑 reindex，或 reindex 没走到最后一个 cursor | 看 `bucketsRebuilt` 是否为 true |
| 新增的书 5 分钟内不出现 | PROPFIND 缓存 TTL | 正常。`POST /api/admin/purge?path=/title/A/` 可立即失效 |
| 每天固定时段整站 1027 | Workers Free 每天 10 万请求打满（UTC 0 点 = 北京 08:00 重置） | `npm run budget` 看瓶颈；引导 rclone 用户走 S3 端点 |
| `wrangler deploy` 报账号未认证 | 没 `wrangler login` | 路径 C 第 1 步，或改用路径 A/B |
