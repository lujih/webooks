# webooks

Cloudflare Workers **免费版** + R2 上的 WebDAV 电子书库。

Phase 0 骨架：验证「WebDAV 能不能在 10 万请求/天以内跑起来」。
设计取舍全部围绕这个预算，而不是围绕功能完整度。

---

## 快速开始

```bash
npm install

# 本地跑起来（D1 / R2 由 wrangler 自动创建，无需预先建资源）
npm run db:migrate:local
npm run dev            # http://127.0.0.1:8788/dav/
```

部署到线上：

```bash
npx wrangler login
npm run db:migrate                        # 建表（远端 D1，首次会自动创建）
npx wrangler secret put ADMIN_TOKEN
npm run deploy
```

`wrangler.jsonc` 里**故意不写 D1 / R2 的 ID 和名称** —— 用的是 wrangler 的
[自动资源创建](https://developers.cloudflare.com/changelog/post/2025-10-24-automatic-resource-provisioning/)
（需 ≥ 4.45）。好处是仓库不含任何账号信息，别人 fork 后一条命令就能部署。

⚠️ **还要做一件事**：给 R2 桶绑一个**公开自定义域**，填进 `wrangler.jsonc` 的
`R2_PUBLIC_BASE`。不做的症状是「能列目录，一点下载就 530」。
不要用 `r2.dev`（官方明示不适用于生产）。

**完整部署说明（三条路径、GitHub 集成、CI/CD、故障排查）见 [docs/DEPLOY.md](docs/DEPLOY.md)。**

部署后立刻验证：

```bash
node scripts/dav-probe.mjs --url https://你的域名/dav/
```

---

## 目录结构

```
src/
  index.ts              路由：/dav、/api/admin、/health
  config.ts             所有影响请求预算的参数集中在此，并对上限做硬 clamp
  webdav/
    index.ts            方法分发（Class 1：无 LOCK/UNLOCK）
    propfind.ts         ★ 预算核心：D1 目录树 + Cache API + 目录上限 + Depth 防护
  lib/
    collections.ts      ★ 虚拟目录树定义与路径解析
    db.ts               D1 访问（全部走索引）
    cache.ts            条目缓存的键与「写入即失效」逻辑
    metadata.ts         从文件名推导元数据（Phase 1 换成解析 EPUB OPF）
    xml.ts / http.ts    XML 与 HTTP 工具
  api/admin.ts          reindex / stats / purge
migrations/0001_init.sql
scripts/
  budget.mjs            ★ 请求预算模拟器
  dav-probe.mjs         ★ 线上 DAV 一致性 / 边缘动词放行 / 100-continue 探针
  size-probe.mjs        ★ 请求体 100 MB 边界探针
test/                   53 个测试（单元 + 端到端）
```

---

## 虚拟目录树（为什么长这样）

请求成本 ≈ **每个目录一次 `PROPFIND` + 每个文件一次 `GET`**。
所以目录数量直接乘进请求数 —— 目录树必须「宽而浅」。

```
/                        根：4 个集合
/title/                  导航：列出有书的首字母桶（A-Z / 0-9 / other）
/title/A/                列表第 1 页（≤ 200 本）
/title/A/2/              列表第 2 页（仅当超过 200 本）
/title/A/Dune.epub       书（叶子）
/author/  /format/       同构
/recent/                 扁平集合：/recent/、/recent/2/、/recent/Dune.epub
```

**目录总数上界 ≈ 110**（远低于 200 的设计上限）。

两条刻意的设计决定：

- **绝不「每本书一个目录」** —— 那会让目录数等于书数，请求数直接爆炸。
- **叶子按 `leaf_name` 全局唯一查找**，所以路径里的桶与书的实际分桶不要求一致。
  客户端即使 PUT 到了「错误的」桶，之后也一定取得到文件。

---

## 预算机制（这部分决定项目能不能免费跑）

### 1. PROPFIND 只读 D1，从不调用 `R2.list()`

这是最反直觉的一条。如果按常见做法用 `R2.list()` 实现 PROPFIND：

> 10 万次/天 × 30 天 = **300 万次 Class A 操作/月**，
> 超出免费额度 100 万 → 200 万 × $4.50/M = **$9/月** —— 比直接买 $5 的 Workers Paid 还贵。

本实现改为读 D1（索引查询），R2 Class A 只用于上传。

### 2. PROPFIND 结果缓存 300 秒

缓存的是**条目 JSON**（不是最终 XML），所以不同客户端请求不同属性集时**共享同一份缓存**，
命中率更高，purge 也能做对。

- 命中：0 次 D1 读、0 次 R2 操作、CPU 接近于 0
- 未命中：约 200 行 D1 读取

D1 免费额度是 500 万行读/天。10 万次全部未命中 = 2000 万行，**会超**；
90% 命中率则降到约 200 万行，安全。

### 3. `GET` 返回 302 跳到 R2 公开域

下载的字节完全不过 Worker：不占 CPU/内存，不受 100 MB 请求体上限影响，
还能被 CDN 缓存。R2 出网本来就免费。

### 4. 单目录硬上限 200 条

同时满足两件事：控制 PROPFIND 响应体积，以及把 XML 生成留在
**Workers Free 的 10 ms CPU** 之内（200 条约 1–3 ms，1000 条就会触发 Error 1102）。

### 5. rclone / 脚本用户应该走 S3，不走 WebDAV

**这是省预算最狠的一招**：rclone 原生支持 S3，直连 R2 端点是 **0 次 Worker 请求**。
WebDAV 只留给只会讲 WebDAV 的客户端（Finder、Windows 资源管理器、KOReader）。

```bash
# 推荐：rclone 直连 R2 的 S3 端点（0 次 Worker 请求）
rclone config create r2 s3 provider=Cloudflare \
  access_key_id=<R2_ACCESS_KEY> secret_access_key=<R2_SECRET> \
  endpoint=https://<ACCOUNT_ID>.r2.cloudflarestorage.com

# 只有必须用 WebDAV 时才走 Worker，并且把目录缓存拉长
rclone mount webooks: /mnt/books \
  --dir-cache-time 24h --poll-interval 0 --vfs-cache-mode off
```

---

## 用预算模拟器回答「10 万/天够不够」

```bash
npm run budget
npm run budget -- --books 20000 --browse 2000 --mounts 200 --syncs 20
```

它会区分两类额度，因为行为完全不同：

| 类型 | 超额后果 |
|---|---|
| **硬停类**（Worker 请求、D1 行读写） | 站点停摆到次日 UTC 0 点（**北京时间 08:00**） |
| **计费类**（R2 存储 / Class A / Class B） | 照常服务，产生小额账单（R2 不是硬停） |

默认场景（5,000 本 / 12 GB / 300 次浏览 / 20 次挂载 / 2 次全库同步）的结果：

```
硬停瓶颈        Worker 请求/天（16.3% 已用）
峰值承受力      峰值系数 3× → 49.0%（✅ 峰值也在额度内）
💳 R2 超额账单 ≈ $0.03/月（存储超 2.21 GB）
```

---

## 数据导入

把你的书放进 R2 的 `library/` 前缀下，然后重建索引：

```bash
curl -X POST "https://你的域名/api/admin/reindex?prefix=library/" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

返回 `nextCursor` 时，带上同一个 cursor 再调一次（R2 列表分页）。
扫完最后一个前缀才会重建分桶计数，所以中途查询目录树可能是空的。

其他管理接口：

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://你的域名/api/admin/stats
curl -X POST "https://你的域名/api/admin/purge?path=/title/A/" -H "Authorization: Bearer $ADMIN_TOKEN"
```

`stats` 会返回 `directoryCount` —— 这个数字必须远低于 200，否则挂载一次的请求数会失控。

---

## Phase 0 必须实测的事

**`r2-webdav` 的 litmus 一致性测试只跑过 `wrangler dev --local`，没有证明线上边缘行为。**
本仓库的 53 个测试跑在 workerd（miniflare）里，同样不是 Cloudflare 边缘。

所以部署到真实域名后，第一件事是跑这两个探针：

```bash
# ① DAV 一致性 + 边缘动词放行 + Expect: 100-continue
node scripts/dav-probe.mjs --url https://你的域名/dav/

# ② 请求体体积边界（100 MB 天花板在哪、超限时什么表现）
node scripts/size-probe.mjs --url https://你的域名/dav/ --dry-run   # 先看计划
node scripts/size-probe.mjs --url https://你的域名/dav/             # 再真跑
```

### `dav-probe.mjs` 覆盖什么

| 分组 | 检查内容 |
|---|---|
| **动词放行** | PROPFIND / PROPPATCH / MKCOL / COPY / MOVE / LOCK / UNLOCK 是否真的到达 Worker。**它会区分「源站按设计拒绝」和「边缘拦截」** —— 后者意味着整套方案要改 |
| Depth 语义 | 0 / 1 / 缺失 / infinity 四种情况的实际返回 |
| 协议声明 | OPTIONS 的 `DAV` 头，以及「声明 Class 2 但没实现 LOCK」这类谎言 |
| PROPFIND | allprop / propname / 未知属性进 404 propstat / 空 body（对应 litmus `props` 套件） |
| 写入读取 | PUT 201、覆盖 204、HEAD 长度、GET 302 目标可下载、DELETE 后 404 |
| 编码 | 中文文件名与 href 的百分号编码 |
| **Expect: 100-continue** | 用**原始套接字**手写 HTTP/1.1 —— fetch 会自己处理掉这个握手。这正是 r2-webdav 的 litmus `http` 套件挂掉的点 |

退出码：有 FAIL 时为 1。「按设计拒绝」（如 LOCK 返回 501）记为 INFO，不算失败。

### 关于真正的 litmus

litmus 是 C 程序，Windows 上要 autotools + gcc。想跑权威套件的话用 Docker：

```bash
docker run --rm -it alpine:latest sh -c '
  apk add --no-cache build-base git curl-dev libxml2-dev neon-dev openssl-dev zlib-dev &&
  git clone --depth 1 https://github.com/notroj/litmus /litmus && cd /litmus &&
  ./autogen.sh && ./configure && make &&
  TESTS="basic props copymove" ./litmus https://你的域名/dav/ 用户名 密码'
```

⚠️ 预期 `locks` 套件会失败 —— 本实现是 **WebDAV Class 1，不提供 LOCK/UNLOCK**（返回 501）。
这是有意为之：Class 2 需要 Durable Object 存锁表，会再切走一块免费额度。
`http` 套件预计在 `Expect: 100-continue` 上超时（`dav-probe` 会先告诉你这一点）。

### 待核实清单

详见 [docs/cloudflare-ebook-library-feasibility.md](docs/cloudflare-ebook-library-feasibility.md) 第 8 节。
`*.workers.dev` 与自定义域的行为是否一致，目前只能靠你自己在两个域名上各跑一遍探针对比。

---

## 已知取舍（有意为之，不是遗漏）

| 项 | 现状 | 原因 |
|---|---|---|
| **无 LOCK/UNLOCK** | 返回 501，`DAV: 1` | Class 2 需要 Durable Object 存锁表，会把免费额度再切一块走。Office/Finder 的锁需求在只读书库上是伪需求 |
| **MKCOL 返回 405** | 目录树是虚拟的，由 D1 推导 | 不允许手工建目录，否则树会漂移 |
| **MOVE/COPY 返回 501** | Phase 0 不实现 | 目录级 MOVE = 逐对象复制 + 删除，会撞上 `MOVE`/`COPY` 的子请求上限 |
| **Depth 缺失按 1 处理** | 有意偏离 RFC 4918 | 规范要求按 `infinity`，那会在大目录上炸掉 CPU |
| **PROPFIND 缓存有最长 300 秒延迟** | 新增的书最多 5 分钟后才出现在列表里 | 换取命中率。`/api/admin/purge` 可手动失效 |
| **重命名书名会改变所在桶** | 书会从 `/title/A/` 移到 `/title/B/` | 目录树是派生视图 |
| **PUT 不计算 SHA-256** | `sha256` 存 null | 流式计算哈希要缓冲整个 body，会撞 128 MB isolate 上限。Phase 1 交给 Queue consumer |
| **分桶计数用全表重建** | 每次 PUT/DELETE 跑一次聚合 | 写入频率低时可接受。写量大时应改成 Queue + 增量计数 |
| **单桶超过 20,000 本** | 分页子目录被 `PAGINATION_MAX=100` 截断 | Phase 1 应对超大桶做二级分桶（如按书名前两个字母） |

---

## 测试

```bash
npm test          # 53 个测试
npm run typecheck
npm run check:dav  -- --url https://你的域名/dav/   # 线上一致性探针
npm run check:size -- --url https://你的域名/dav/   # 请求体体积边界
```

覆盖：路径解析与分桶、元数据推导、content-type 取舍、XML 转义与编码、
PROPFIND 请求体解析、Depth 语义、207 响应结构、200 条硬上限与分页、
缓存命中与**写入即失效**（PUT/DELETE 后叶子与父列表必须立刻更新）、
PUT/GET/HEAD/DELETE 全流程、未实现方法的明确拒绝、admin 鉴权。

已用 `wrangler dev` + `curl` 做过真实 HTTP 冒烟测试，并用
`scripts/dav-probe.mjs` 跑过完整探针（**28 通过 / 0 失败 / 1 警告**，
唯一警告是运行时不发 `100 Continue` 这个已知限制）。

---

## 相关文档

- [可行性报告](docs/cloudflare-ebook-library-feasibility.md) —— 平台限制、合规、成本、落地路线
- [平台调研原始记录](docs/appendix-platform-research.md) —— 逐条引用与官方文档日期
