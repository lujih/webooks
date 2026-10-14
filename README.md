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
test/                   253+ 个测试（单元 + 端到端 + 回归）
```

---

## 虚拟目录树（为什么长这样）

请求成本 ≈ **每个目录一次 `PROPFIND` + 每个文件一次 `GET`**。
所以目录数量直接乘进请求数 —— 目录树必须「宽而浅」。

```
/                        根：5 个集合
/按书名/                  导航：列出有书的首字母桶
/按书名/A/                列表第 1 页（≤ 200 本）
/按书名/A/2/              列表第 2 页（仅当超过 200 本）
/按书名/A/Dune.epub       书（叶子）
/按作者/  /按类型/  /按格式/   同构
/最近收录/                扁平集合：/最近收录/、/最近收录/2/、/最近收录/Dune.epub
```

**目录总数上界 ≈ 120**（远低于 200 的设计上限）。

两条刻意的设计决定：

- **绝不「每本书一个目录」** —— 那会让目录数等于书数，请求数直接爆炸。
- **叶子按 `leaf_name` 全局唯一查找**，所以路径里的桶与书的实际分桶不要求一致。
  客户端即使 PUT 到了「错误的」桶，之后也一定取得到文件。

### 路径段用中文（不是 displayname）

绝大多数 WebDAV 客户端（Windows 资源管理器、rclone、Cyberduck…）**直接用 href 的
最后一段当文件夹名**，只有少数会读 `displayname` 属性。所以想让客户端显示「按书名」
而不是「title」，**路径本身就必须是中文**。

英文旧路径（`/dav/title/` 等）保留为**兼容别名**，中英文指向同一本书。
两者通过 `canonicalDavPath()` 归一 —— 否则缓存键与锁资源会分裂（用英文路径缓存的目录，
按中文路径失效时打不中，客户端会一直看到旧列表）。

### 分类规则

| 集合 | 分桶依据 |
|---|---|
| 按书名 / 按作者 | 拉丁字母 A–Z、数字 `0-9`、**汉字取拼音首字母**、**没有作者 → 「未知作者」**、其余进「其他」 |
| 按类型 | 电子书 / 漫画 / 有声书（**按内容嗅探**，不只是扩展名） |
| 按格式 | epub / pdf / cbz / … 归一化后的格式 |
| 最近收录 | 不分组，按收录时间倒序 |

**中文按拼音分桶**是中文书库的关键：早期实现把所有中文书都塞进 `other`，
按书名浏览等于没有分类。「三体」现在进 S、「末世降临」进 M、「活着」进 H。

拼音表由 `scripts/gen-pinyin-table.mjs` 在**开发期**用 `pinyin-pro` 烘成静态表
（`src/lib/pinyin-table.ts`，63 KiB，20935 个汉字），**运行时不引入任何依赖** ——
项目仍然是零运行时依赖。重新生成：

```bash
node scripts/gen-pinyin-table.mjs
```

### 作者识别

三层，从最可靠到最猜测：

1. **EPUB 的 `dc:creator`** —— 文件内的权威元数据，优先于一切猜测
2. **文件名显式标记** —— `作者：X`、`X 著`、`[X]书名`、`书名 (X)`
3. **分隔符 + 姓氏表** —— `A - B` 的方向靠「哪边以常见中文姓氏开头」判断

第 3 条是关键：`书名 - 作者` 与 `作者 - 书名` 两种命名约定都真实存在，写死任何一边
都会让另一半错得离谱。而**姓氏是极强的判据**：`萧冬连` 的「萧」是姓、
`筚路维艰` 的「筚」不是 —— 于是 `筚路维艰 - 萧冬连` 能判对，
`Frank Herbert - Dune` 靠「多个首字母大写的单词更像人名」也能判对。

**TXT 会读正文找作者**：很多中文小说开头就写着 `作者：XXX`，没有元数据也能捞回来
（实测把「神秘复苏」的作者补成了「佛前献花」）。

**没有作者就进「未知作者」桶**，而不是拿书名首字母顶替 ——
后者会让一本书看起来像「作者姓某字」，是**错误信息**而不是缺信息。

### 电子书 / 漫画：按内容识别

只看扩展名是不准的：`.pdf` 既可能是文字书，也可能是扫描漫画（用户书库里的
`敖丙传（17-24）.pdf` 就是）。所以读**内容**判断：

| 格式 | 判据 |
|---|---|
| `cbz` / `cbr` / `cb7` / `cbt` / `cba` | 容器格式本身就是漫画，无需读内容 |
| `pdf` | **零字体 + 每页一图** → 漫画；有字体资源 → 文字书 |
| `epub` | 固定版式声明（`rendition:layout: pre-paginated`）或图片项远多于文档项 → 漫画 |

PDF 的判据来自实测：用户那本 86MB 的扫描漫画，采样 2.86MB 得到
`/Type/Page` 17 个、`/Subtype/Image` 17 个、`/DCTDecode` 17 个、**`/Type/Font` 0 个**。
文字书即使正文全是图，页眉/书签/目录也要字体资源，所以「零字体」非常硬。

两个工程要点：

- **用 ranged GET 只读前 2MB**，不把整个文件读进 128MB 的 isolate（那本漫画有 86MB）
- **判不出就返回 null**，回退到按扩展名分类。猜错的代价比不判更大

### 手动修正（启发式的兜底）

再准的启发式也会判错（PDF 用对象流压缩把字典藏起来、作者是笔名、文件名格式古怪）。
管理后台 `/admin` 里每本书都能直接改**作者**与**类型**，改完立刻重算分桶并失效缓存。

也可以批量按内容重新提取存量书：

```bash
# 只重算字母桶（不动类型）
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://你的域名/api/admin/rebucket

# 按内容重新嗅探类型 + 补齐缺失作者（会读 R2，较慢）
curl -H "Authorization: Bearer $ADMIN_TOKEN" "https://你的域名/api/admin/rebucket?sniff=1"
```

> `rebucket` **默认不动 `kind_bucket`**：它现在来自内容嗅探或人工修正，比「按扩展名猜」
> 更权威。按扩展名重算会把扫描漫画打回「电子书」（真实踩过）。
>
> **`?sniff=1` 也一样** —— 迁移 0006 起每本书都记了 `kind_source`
> （`sniffed` / `derived` / `manual`），`manual` 的值**任何自动化都不会覆盖**
> （`rebucket` 会跳过并报告 `skippedManual`，覆盖上传也会保留）。
> 这不是多余的约束：内容嗅探在两种真实情况下必然失效 ——
> ① PDF 1.5+ 用对象流把字典压起来，标记根本看不到
> ② 带 OCR 层的扫描漫画引入字体资源，让「零字体」判据直接崩
> 这两类书只能靠人判断，而人判断恰恰是最容易被脚本覆盖掉的数据。

分类规则一旦变化，**存量书不会自动跟上**（`title_letter` 等是入库时算好存起来的），
所以改规则后要跑一次 `rebucket`。

### 上传格式白名单

只接受**电子书 + 漫画**格式（`src/lib/collections.ts` 里的
`ALLOWED_UPLOAD_FORMATS`，是唯一定义处）：

```
电子书: epub pdf mobi azw3 fb2 djvu txt rtf doc docx odt md html lit chm prc pdb
漫画:   cbz cbr cb7 cbt cba
```

**被排除**：有声书（m4a/m4b/mp3）、通用压缩包（zip/rar/7z）、以及一切可执行文件
和脚本。想调整就改那一个数组，网页上传与 WebDAV PUT 会同时生效。

> 早先网页上传有一份白名单，但 **WebDAV PUT 完全没有检查**，任何文件都能绕过网页
> 限制塞进书库。现在两条入口共用 `isAllowedUploadExt()`，不存在只改一边的可能。

### 批量上传：一批只验证一次

网页上传支持多选与多文件拖入，串行上传并逐项显示进度。

这里有个容易做错的点：**Turnstile 令牌是一次性的**。最初按「每个文件领一个新令牌」
实现，结果是**传 10 本书要点 10 次验证** —— 批量上传等于没用。

正确做法是把「验证码」与「上传次数」解耦：

```
第 1 个文件  → 带一次性 turnstileToken 调 /api/upload/init
              服务端 siteverify 通过 → 回一张通行证（HMAC 签名，10 分钟，绑定 IP）
第 2..N 个   → 带 ticket 调用，服务端只验签名，不再打扰用户
```

通行证是**无状态**的（`<过期时间戳>.<HMAC(密钥, 过期时间|IP)>`），不占 D1 写入，
不需要新表；IP 不写进通行证里，验证时用当前请求的 IP 重算签名比对 ——
所以通行证**只能由签发它的那台机器使用**。

> ⚠️ 这条保证依赖 IP 取自 `CF-Connecting-IP`（Cloudflare 边缘强制设置）。
> 实现上**只信任这个头**、不回落到 `X-Forwarded-For`：后者完全由客户端提供，
> 一旦回退生效，攻击者只要把 XFF 填成签发时的 IP 就能在别的机器上复用通行证。
> 早期实现有那个回落，承诺实际上是失效的。
>
> 密钥默认复用 `TURNSTILE_SECRET`（想独立轮换再设 `UPLOAD_TICKET_SECRET`），
> 不引入新的必填配置。

同时 widget 设成 `appearance: 'interaction-only'`：正常用户根本看不到验证框，
只有 Cloudflare 判定可疑时才弹出来要求交互。

**权衡**：一张通行证在有效期内可多次使用，即「一次验证码换 10 分钟上传窗口」。
匿名上传本来就有每日写入次数节流兜底，验证码的边际价值有限，
用这一点换掉「每本弹一次验证」是划算的。

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
本仓库的测试跑在 workerd（miniflare）里，同样不是 Cloudflare 边缘。

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

✅ 本实现是 **WebDAV Class 2**（`DAV: 1, 2`），提供完整的 LOCK/UNLOCK ——
锁表存在 D1 里，不依赖 Durable Objects。`locks` 套件应当能通过大部分用例。
（曾有一处真实缺陷：LOCK 响应体输出了不成对的 `<D:locktoken>` 标签，
所有严格客户端都会解析失败。已修复，并由 `test/xml-wellformed.test.ts` 持续兜底。）

`http` 套件预计在 `Expect: 100-continue` 上超时（`dav-probe` 会先告诉你这一点）。

### 待核实清单

详见 [docs/cloudflare-ebook-library-feasibility.md](docs/cloudflare-ebook-library-feasibility.md) 第 8 节。
`*.workers.dev` 与自定义域的行为是否一致，目前只能靠你自己在两个域名上各跑一遍探针对比。

---

## 已知取舍（有意为之，不是遗漏）

| 项 | 现状 | 原因 |
|---|---|---|
| **MKCOL 一律拒绝（已映射的集合回 405，未映射回 403 + `valid-resourcetype`）** | 目录树是虚拟的，由 D1 推导，建了也不会出现在树里 | 假装 201 再让目录消失，比直接拒绝更糟：客户端会缓存「创建成功」这个事实，之后再也收不到正确的状态。收到 405 的客户端能正确理解为「已存在」并继续挂载 |
| **Depth 缺失按 1 处理** | 有意偏离 RFC 4918 | 规范要求按 `infinity`，那会在大目录上炸掉 CPU |
| **PROPFIND 缓存有最长 300 秒延迟** | 新增的书最多 5 分钟后才出现在列表里 | 换取命中率。`/api/admin/purge` 或 `/api/admin/rebucket` 可手动失效 |
| **重命名书名会改变所在桶** | 书会从 `/按书名/A/` 移到 `/按书名/B/` | 目录树是派生视图 |
| **PUT 不计算 SHA-256** | `sha256` 存 null | 流式计算哈希要缓冲整个 body，会撞 128 MB isolate 上限 |
| **分桶计数用全表重建** | 每次 PUT/DELETE 跑一次聚合 | 写入频率低时可接受。写量大时应改成 Queue + 增量计数 |
| **单桶超过 20,000 本** | 分页子目录被 `PAGINATION_MAX=100` 截断 | Phase 1 应对超大桶做二级分桶（如按书名前两个字母） |
| **PDF 用对象流压缩时判不出类型** | 退回按扩展名分类 | PDF 1.5+ 可以把对象字典压进对象流，标记就看不到了。这类文件请在管理后台手动指定类型 |
| **服务端不扫描文件内容** | 只按扩展名放行 | 免费层没有可用的杀毒/沙箱。伪装成 `.epub` 的可执行文件会被接受，但浏览器只会下载不会执行 |
| **WebDAV 通道无人机验证** | 网页上传有 Turnstile，WebDAV 没有 | WebDAV 协议里没有验证码的位置。用「每日写入次数」节流缓解（减速带，非硬限制） |

---

## 测试

```bash
npm test          # 297 个测试
npm run typecheck
npm run check:dav  -- --url https://你的域名/dav/   # 线上一致性探针
npm run check:size -- --url https://你的域名/dav/   # 请求体体积边界
```

覆盖：路径解析与分桶（含**中文拼音首字母**）、分类体系与 `rebucket` 重算、
格式白名单（网页上传与 WebDAV 两条入口）、元数据推导、content-type 取舍、
XML 转义与编码、PROPFIND 请求体解析、Depth 语义、207 响应结构、
200 条硬上限与分页、缓存命中与**写入即失效**、PUT/GET/HEAD/DELETE 全流程、
未实现方法的明确拒绝、admin 鉴权、以及**页面内联脚本的语法自检**。

线上另有几套探针（见 `scripts/`）：

```bash
node scripts/webdav-litmus.mjs  --url https://你的域名/dav/ --token $WRITE_TOKEN  # 16/16
node scripts/rfc-probe.mjs      --url https://你的域名/dav/ --token $WRITE_TOKEN  # 14/14
node scripts/security-probe.mjs --url https://你的域名                            # 33/33
node scripts/abuse-probe.mjs    --url https://你的域名/dav --token $WRITE_TOKEN   # 22 项
node scripts/verify-upload-chain.mjs --site https://你的域名                       # 上传链路 4 项
```

> 探针会创建临时文件并自行删除。破坏性操作现在需要口令，所以**必须带 `--token`**，
> 否则临时文件删不掉，会在书库里堆积。

---

## 相关文档

- [可行性报告](docs/cloudflare-ebook-library-feasibility.md) —— 平台限制、合规、成本、落地路线
- [平台调研原始记录](docs/appendix-platform-research.md) —— 逐条引用与官方文档日期
- [安全审计报告](docs/security-audit.md) —— 漏洞复现、修复与实测数据
- [RFC 合规清单](docs/rfc-compliance.md) —— 逐条对照 RFC 4918 / 9110
- [2026-10-14 全面审查与修复记录](docs/review-2026-10-14-fixes.md) —— **数据丢失、鉴权绕过、ReDoS、ZIP bomb、锁不可用**的修复全过程
- [WebDAV RFC 深度审计](docs/webdav-rfc-audit-2026-10-14.md) —— 逐条对照 RFC 原文的完整审计
