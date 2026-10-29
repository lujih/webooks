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

`wrangler.jsonc` 里只写**语义化名字**（`webooks-db` / `webooks-bucket`），
不带任何账号相关的 ID —— 用的是 wrangler 的
[自动资源创建](https://developers.cloudflare.com/changelog/post/2025-10-24-automatic-resource-provisioning/)
（需 ≥ 4.45）。好处是仓库不含任何账号信息，别人 fork 后一条命令就能部署。

配置文件里**只有一个必填项**（`R2_PUBLIC_BASE`）。挂载前缀、单目录上限、
缓存 TTL、上传体积、写配额这些都走 `src/config.ts` 里的默认值 ——
理由和实测数据都写在那个文件的注释里。想临时覆盖用
`wrangler deploy --var KEY=VALUE`，不必改文件。

⚠️ **还要做一件事**：给 R2 桶绑一个**公开自定义域**，填进 `wrangler.jsonc` 的
`R2_PUBLIC_BASE`。这个地址有两个用途 —— WebDAV 的 `GET` 302 目标，以及浏览页书卡
的直链。不做的症状是「能列目录，一点下载就 530」（直链会 404/530，Worker 也会在
第一次请求时就因 `R2_PUBLIC_BASE` 为空而报错）。
不要用 `r2.dev`（官方明示不适用于生产）。

**完整部署说明（三条路径、GitHub 集成、CI/CD、故障排查）见 [docs/DEPLOY.md](docs/DEPLOY.md)。**

部署后立刻验证：

```bash
node scripts/dav-probe.mjs --url https://你的域名/dav/
# 写路径（LOCK / DELETE / MOVE / 覆盖）需要写口令，不带口令时这些动词只会看到 401
node scripts/dav-probe.mjs --url https://你的域名/dav/ --user x --pass "$WRITE_TOKEN"
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
    ingest.ts           ★ 唯一的入库管道：搬键/解析/封面/嗅探/分桶/缓存失效
    xml.ts / http.ts    XML 与 HTTP 工具
  api/admin.ts          reindex / stats / purge / backfill-disposition / migrate-keys
  api/import-url.ts     从网址导入（管理员）：SSRF 防护 + 流式落 R2
migrations/0009_source_ingest.sql   书源与入库来源（source_*/license_basis）
public/                 ★ 静态资源：唯一「不计入请求配额」的一类请求
  favicon.ico           浏览器每次浏览都会猜它；没有它就是每次白花一次请求
  robots.txt            挡住爬虫枚举 /dav/ 那棵可无限展开的目录树
  _headers              静态资源的响应头（对 Worker 响应无效，见下）
scripts/
  budget.mjs            ★ 请求预算模拟器
  gen-favicon.mjs       生成 public/favicon.ico（开发期跑，产物提交进仓库）
  gen-pinyin-table.mjs  生成 src/lib/pinyin-table.ts（同上，运行时零依赖）
  dav-probe.mjs         ★ 线上 DAV 一致性 / 边缘动词放行 / 100-continue 探针
  size-probe.mjs        ★ 请求体 100 MB 边界探针
test/                   单元 + 端到端 + 回归（`npm test` 会报当前条数）
```

---

## 虚拟目录树（为什么长这样）

请求成本 ≈ **每个目录一次 `PROPFIND` + 每个文件一次 `GET`**（浏览页书卡直连 R2，
那一侧不花请求；WebDAV 客户端的 `GET` 仍算一次）。
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
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" https://你的域名/api/admin/rebucket

# 按内容重新嗅探类型 + 补齐缺失作者（会读 R2，较慢）
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "https://你的域名/api/admin/rebucket?sniff=1"
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

> 以下描述的是**开启**人机验证时的行为；默认已关闭（见下方取舍说明）。

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
> 密钥取自 `UPLOAD_TICKET_SECRET`，**回落链是 `WRITE_TOKEN` → `ADMIN_TOKEN`**
> （`src/api/upload.ts` 的 `ticketSecret()`）。三个都没配时上传接口整体 503。
>
> ⚠️ 2026-10-28 订正：本节此前写「默认复用 `TURNSTILE_SECRET`」—— 那条回落链
> 早已删除，照旧文档配置会「上传能发起但永远拿不到通行证」。
> 另外这条回落链意味着 **通行证的安全性等于 ADMIN_TOKEN 的强度**，
> 所以建议显式设置独立的 `UPLOAD_TICKET_SECRET`。

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

### 3. 下载完全绕开 Worker：书卡直连 R2，WebDAV 的 `GET` 走 302

两种客户端各走一条路，但**字节都不过 Worker**：

| 谁 | 怎么下载 | 消耗 Worker 请求？ |
|---|---|---|
| 浏览页（浏览器点书卡） | 书卡 href 直接是 `R2_PUBLIC_BASE` 上的对象地址 | ❌ **0 次** |
| WebDAV 客户端（rclone / Finder / 资源管理器） | `GET /dav/<路径>` → 302 到同一个公开域 | 1 次（读目录时已经在花的那些） |

浏览页那条是**后改的**：更早的时候书卡 href 是 `/dav/<路径>`，所以「点开一本书」
必须先撞一次 Worker 拿 302；而那个 302 带 `no-store`，CDN 缓存不上，于是每次点击
都实打实消耗一次配额。现在书卡直接指向 R2，这一次彻底没了（`test/download-direct.test.ts`
有守卫，防止改回去）。

WebDAV 那条 302 **有意保留**：它带着鉴权与写配额判定，rclone / Finder 也依赖它
（含 Range 透传），删掉等于把 WebDAV 客户端挡在门外。

两条路的共同点：下载的字节不占 CPU/内存，不受 100 MB 请求体上限影响，还能被
CDN 缓存。R2 出网本来就免费。

⚠️ **下载名只能靠写入时的 `Content-Disposition`。** 对象键是 `books/<随机 id>`，
既没有扩展名也没有书名；而 R2 **不支持** S3 的 `response-content-disposition` 之类
response-* 覆盖参数（实测无效）。所以三条写入路径（WebDAV PUT 的两个分支、COPY/MOVE、
网页上传 complete）统一用 [src/lib/r2.ts](src/lib/r2.ts) 里的同一个 helper 写入下载名。
**在它落地之前就存在的对象需要跑一次回填**，否则直链下载下来叫 `95e860d26bd874cf` ——
命令见下方「数据导入」一节的 `backfill-disposition`。

### 4. 单目录硬上限 200 条

同时满足两件事：控制 PROPFIND 响应体积，以及把 XML 生成留在
**Workers Free 的 10 ms CPU** 之内（200 条约 1–3 ms，1000 条就会触发 Error 1102）。

### 5. rclone / 脚本用户应该走 S3，不走 WebDAV

**这是省预算最狠的一招**：rclone 原生支持 S3，直连 R2 端点是 **0 次 Worker 请求**。
WebDAV 只留给只会讲 WebDAV 的客户端（Finder、Windows 资源管理器、KOReader）。

> ✅ **对象键已可读（2026-10-21 修）**：书籍对象键从 `books/<随机 id>` 改成
> **`books/<随机 id>/<书名>`**（如 `books/ae468f7f5061110d/新书测试.epub`）。
> 原因是 rclone / aws-cli 走 S3 时，落盘文件名来自**键的 basename**，
> 不读 `Content-Disposition` —— 旧键会让它们拿到 `b01`、`b02` 一堆既无扩展名、
> 又认不出是哪本书的文件。
>
> 为什么保留 `<id>` 段而不是直接用 `books/<书名>.epub`：
>   · **唯一性**：同名不同版本的书真实存在，键直接撞了就是互相覆盖；
>     id 段保证唯一，去重/覆盖语义与以前完全一致。
>   · **改名成本**：MOVE/改名时若键里只有书名，就得 copy+delete 整个对象。
>   · **可控字符**：书名是用户可控的，文件名段经 `sanitiseLeafName()` 清洗，
>     永远单段（`/`→`_`，`.`/`..` 整名拒绝），不会多出层级或穿越。
>
> **兼容**：`r2_key` 是 D1 里的一列（不是从 leaf_name 推导），所有读取都走
> `book.r2_key`，所以**新旧格式可以共存**。覆盖上传会**沿用旧键**，
> 不会产生孤儿对象。
>
> **存量对象**：有 `POST /api/admin/migrate-keys` 迁移端点
> （`src/api/admin.ts`），把 `books/<id>` 搬到 `books/<id>/<书名>`。
> 默认 **dry-run 只统计不改**，需显式 `apply=1` 才真搬；幂等、可分页、
> 先写新键再删旧键（最坏结果是孤儿旧对象，不是丢数据）。
> 注意 `reindex` 改不了这件事 —— 它写的是 `r2Key: object.key`（发现对象），
> 不是重命名。实现见 [src/lib/r2.ts](src/lib/r2.ts) 的 `bookObjectKey`。

```bash
# 推荐：rclone 直连 R2 的 S3 端点（0 次 Worker 请求）
rclone config create r2 s3 provider=Cloudflare \
  access_key_id=<R2_ACCESS_KEY> secret_access_key=<R2_SECRET> \
  endpoint=https://<ACCOUNT_ID>.r2.cloudflarestorage.com

# 只有必须用 WebDAV 时才走 Worker，并且把目录缓存拉长
rclone mount webooks: /mnt/books \
  --dir-cache-time 24h --poll-interval 0 --vfs-cache-mode off
```

> ⚠️ **集合路径有没有尾斜杠都必须认（2026-10-26 修）**
>
> 现象：把站点挂成 WebDAV 盘后，第一层（`最近收录/`、`按书名/`）正常，
> **第二层全部报「没有加载到数据」**——`最近收录/2`、`按书名/A` 全打不开。
>
> 原因：这类客户端**不按 PROPFIND 返回的 href 拼路径**，而是自己拼「父路径 + 名字」，
> 拼出来的二级路径没有尾斜杠；解析器原来把「无尾斜杠」一律当叶子（去 D1 找一本
> 叫 `A` 的书）→ 404。第一层没暴露，是因为单段路径无论有无尾斜杠都解析成集合。
>
> 修法：`resolveNode()` 用「合法桶段 / 页码且无点号」判定这是目录而不是叶子
> （本站叶子必带扩展名，`isAllowedUploadExt` 在三条写入路径上都拦），并在
> `handleDav()` 里把集合路径**统一补成带尾斜杠的规范形态** —— 否则 PROPFIND
> 条目缓存会出现「写入时按 `/A/` 失效、读取时按 `/A` 命中」永不失效的漏洞。
> 守卫见 `test/units.test.ts`（解析层）与 `test/webdav.test.ts`（207 / 缓存共用 / 302 回归）。

### 6. 静态资源（`public/`）—— 唯一真正不计费的请求类型

先说三个反直觉的事实，因为这里最容易走错路：

| 机制 | 省请求数？ | 说明 |
|---|---|---|
| **Cache API**（`caches.default`，本项目在用） | ❌ **一次都不省** | 官方原文：「every request still executes your Worker on the way in」。它只省上游（D1/R2）。 |
| **Workers Caching**（`cache.enabled`） | ❌ **而且更贵** | 命中仍按标准费率计费（「Cache hits count as requests but do not consume CPU time」），且开启后连本来免费的静态资源请求也变成计费。我们的瓶颈是**请求数**不是 CPU → **故不开**。 |
| **静态资源** | ✅ **free and unlimited** | 官方原文：「Requests to static assets are free and unlimited.」且**完全不经过 Worker 代码**。 |

所以 `public/` 里放的是「每次访问都会发生、但内容恒定」的东西：

- **`favicon.ico`** —— 页面不声明 `<link rel="icon">` 时，浏览器会自己去请求 `/favicon.ico`。
  在这个文件存在之前，那个路径是 404：**每打开一个页面就白花一次 Worker 请求**。
  现在每个页面都显式声明它（`test/pages-syntax.test.ts` 有守卫）。
- **`robots.txt`** —— 首页有个「进入书柜」链接指向 `/dav/`，而那是棵**可无限枚举**的目录树。
  没有 robots.txt 时爬虫会顺着目录把整个书库翻一遍。注意 HTML 页上的
  `<meta name="robots" content="noindex">` **只阻止收录、不阻止抓取** —— 抓取照样花请求。
- **`404.html`** —— 见下，它承担的是最大的一块：**所有不存在的路径**。

#### 未知路径：`404-page` + `run_worker_first`

扫描器打过来的不存在的路径（`/wp-login.php`、`/.env`、`/administrator`…）数量**不受本站控制**，
而它们在 `not_found_handling: "none"` 下每一条都要花一次 Worker 配额去回一个十来个字节的文本 404。
这正是上次一天打满 10 万的形态，所以现在配的是：

```jsonc
"assets": {
  "directory": "./public",
  "not_found_handling": "404-page",
  "run_worker_first": [ /* 每一条 Worker 路由，缺一条那条路由就对真人 404 */ ]
}
```

**这两个设置必须成对出现，且是一条线的两端**：

- 只要 `404-page`，不加 `run_worker_first` → 真人浏览器的每一次顶层导航都被静态 404 页吃掉。
  触发条件只有 `Sec-Fetch-Mode: navigate` 一个头（curl 不带），所以 curl 冒烟测试全绿而线上整站 404。
- 只要 `run_worker_first` 的语义有一条漏掉 → 那条路径静默 404。实测三条容易漏的规则：
  `/x/*` **不匹配 `/x` 本身**；字面量精确匹配、**大小写敏感**；`run_worker_first` **优先于**命中的静态资源。
- `run_worker_first: true`（布尔）**不是**「全部走 Worker」的安全写法 —— 实测它让任何静态资源都不被服务，
  优化归零。必须用数组。

`test/static-assets.test.ts` 把这条线钉住了：它从 `src/index.ts` 里抠出全部路由字面量，
断言每一条都被某个 `run_worker_first` 模式覆盖 —— 新加一条路由却忘了同步列表，测试会红。
`scripts/verify-deploy.mjs` 另有两端哨兵：一条带 navigate 头确认 Worker 路由仍可达，
一条确认未知路径返回的是 `public/404.html`（而不是 Worker 的文本 `Not Found`）。
两处都读真实文件，改动会被逼着重新读一遍上面这段论证。

HTML 页面**故意不放进 `public/`**：它们是动态渲染的（首页插 `DAV_MOUNT`/`R2_PUBLIC_BASE`，
上传页插 Turnstile 公钥），一旦落成静态文件，部署时的 `--var` 覆盖就再也反映不到页面上 —— 那是静默失效。

⚠️ `public/_headers` 只对静态资源生效，**对 Worker 生成的响应完全无效**；反之 Worker 里的
`withSecurityHeaders()` 也管不到静态资源。两边各管各的，**漏一边就是静默缺失**，
所以每个 `public/` 文件都必须在 `_headers` 里有对应规则（`test/static-assets.test.ts` 守卫这条）。

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
硬停瓶颈        Worker 请求/天（55.4% 已用）
忙日承受力      忙日系数 3× → 166.1%（❌ 忙日会打满）
💳 R2 超额账单 ≈ $0.03/月（存储超 2.21 GB）
```

> ⚠️ **这个结论在 2026-10-20 变了，而且是往坏的方向变。**
> 修掉 `syncRequests` 的 5× 量纲错之后（详见下面第 5 条），默认场景从
> 「15.4%、忙日 46%（很宽裕）」翻成「**55.4%、忙日 166%（那天会打满）**」。
> 旧结论不是算错，是**少算了一个 5 倍因子**，而且恰好落在最大那一项上。
> 按默认用量反推，免费层现在约能装 **9,850 本书**（每次全库同步 1 遍）；
> 跑 1 次同步能装约 19,700 本。过了这条线，只要有人真跑一次全库同步，
> 那天就打满 —— 这正是「模型说 16%、现实打满 10 万」的形态。

「忙日系数」而不是「峰值 QPS」：100,000/天 是**日总量**额度，不是速率上限
（官方 limits 页：「There is no general limit on requests per second.」）。
所以这里乘的是「某天流量是平时的几倍」，与日额度**同量纲**，可以直接比。
相乘出来的百分比用的就是同一个判据 —— 上一行说「忙日会打满」、下一行说
「站点不会停摆」这种自相矛盾曾经真的出现过（只判均值不判忙日），现已修掉。

⚠️ **这个百分比只算「可预期的使用量」，不含爬虫 / 扫描器 / 客户端重试。**
这不是谨慎，是踩过的坑：这个模型曾在显示 16% 的当天，站点真的打满了 10 万次并停摆到次日 08:00。

差距来自模型本身的三个错误，都已修掉（并写进代码注释，防止有人「优化」回去）：

1. **把 Cache API 的命中当成了省请求**。它一次都不省（见上一节表格）。
   模型里那个 `cdPageViewHitRate: 0.8` 参数已**删除** —— 留着就会有人继续传一个
   「假装能省请求」的数字，现在传它会直接报 `未知参数` 然后退出。
2. **没算每次浏览附带的隐式请求**。`/favicon.ico` 那条 404 是其中最普遍的一个
   （现已由静态资源层消掉，所以 `implicitPerPageView` 现在是 0，
   但参数保留着 —— 加任何「浏览器自动请求且必须过 Worker」的东西时都要加回它）。
3. **压根没建模爬虫流量**。这个无法猜（本机没有 CF 凭据，拿不到线上计数），
   所以默认 0，并且**在结论里显式标注**「不含未建模流量」——
   宁可让人一眼看见这个空白，也不要再给一个虚假的安全感。
4. **同一个量纲被数了两遍**（2026-10-20 修）。`browse` 曾按「每次会话 4 个
   请求」计价，但那 4 次里有 **2 次是首页**（`GET /` + `GET /api/credits`）；
   后来补首页记账时又按 `homeViews × 2` 记了一遍 → 首页被算两次。
   现在拆干净：目录页 2 次（`browseRequests`）＋ 首页 2 次（`homeRequests`）。
5. **每本书在一次全库同步里被下载 5 次，只算了 1 次**（2026-10-20 修）。
   一本书同时挂在 5 个集合下（按书名/按作者/按类型/按格式/最近收录），
   5 条路径指向同一个 R2 对象，但 rclone 按**路径**去重 → 每本被 GET 5 次。
   这是模型里**唯一随书量线性放大**的一项，也是最贵的一项：
   修前它占默认总量 66%，修后占 **91%**。两份独立证据：`src/lib/cache.ts`
   的 `bookCacheTargets()` 硬编码了这 5 条叶子路径；真 rclone 实测
   GET 75 次 / 唯一书名 15 本 = 5.0×，每本路径数分布 `Counter({5: N})`。
   **两本账都改了**（Worker 请求 + R2 Class B），只改一边会让表里两行互相矛盾。
   顺带补了第三个漏项：`GET /dav/<书>` 会走 `findBookByLeaf()` 读 **1 行** D1
   （唯一索引），以前整个没算；它**不能**和 PROPFIND 的「一页 200 行」混在一起
   乘 `1 + MAX_ENTRIES`，否则 1 行会被放大成 201 行，把 D1 误判成超标。

   **独立复核（2026-10-21，真 rclone 对本地 dev）**：15 本书跑一次
   `rclone copy`，dev 日志里精确数出 **75 次 GET / 15 本 = 每本 5 次**，
   与上面的结论**逐本吻合**（不是平均值碰巧撞上，是每本书都恰好 5 次）。
   同一次实测还暴露模型的一处**高估**：PROPFIND 实发 35 次，而
   `treeShape(15)` 算 71 个目录 —— 因为 `listBucketTotals()` 只列
   **非空桶**（`WHERE total > 0`），而模型按 28 个字母桶全算。
   这条**刻意不修**：默认场景 5,000 本时 28 个桶平均 179 本/桶、全部非空，
   模型是对的；只有小书库（< 28 本）才会高估，而那时它也不影响主结论
   （主结论由 `syncRequests` 支配）。已在 `treeShape()` 头部记为已知边界。

想估算真实占用，用 Cloudflare 控制台的请求量反推：`--bots <次数/天>`。

---

## 数据导入

把你的书放进 R2 的 `library/` 前缀下，然后重建索引：

```bash
curl -X POST "https://你的域名/api/admin/reindex?prefix=library/" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

返回 `nextCursor` 时，带上同一个 cursor 再调一次（R2 列表分页）。
扫完最后一个前缀才会重建分桶计数，所以中途查询目录树可能是空的。

### 从网址导入一本（`import/url`）

书在别人站点上、你只想给个链接时，不必先下载到本机再上传：

```bash
curl -X POST "https://你的域名/api/admin/import/url" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"url":"https://www.gutenberg.org/cache/epub/84/pg84.epub","licenseBasis":"public-domain"}'
```

- **`licenseBasis` 必填**：`public-domain` / `authorized` / `user-declared`。
  `unknown` 不接受 —— 说不清来源的书不进库（依据落 `books.license_basis`，迁移 0009）。
- 只允许公网 `http/https`：内网 IP、`localhost` / `.local` / `.internal`、带账号口令的
  URL 一律 **422**，且**每一跳重定向都复检**（重定向到内网是 SSRF 最常见的绕过）。
  想更严格就配 `IMPORT_URL_ALLOWLIST`（逗号分隔域名）。
  ⚠️ Workers **没有 DNS 解析 API**，挡不住「公网域名解析到内网地址」——
  这条防护**不完整**，所以端点只给管理员用。完整说明见
  [书源接入设计](docs/source-ingest-design.md) §5.2，不要把它当完整 SSRF 防护。
- 上游返回 HTML 错误页、内容与扩展名不符（`.epub` 却不是 ZIP）、超过 200 MiB：
  分别 **415 / 415 / 413**，失败路径都会清掉暂存对象，不在桶里留垃圾。
- 与匿名上传共用 `DAILY_WRITE_QUOTA`（默认 300/日）—— 管理员不是「无限写」。

### 但如果你是从 R2 直接导入的书，还要补一次下载名

对象键 `books/<随机 id>` 里没有书名也没有扩展名，浏览器只能靠对象上的
`Content-Disposition` 决定「下载下来叫什么」。**这个头只在写入时生效**，
而 R2 也不支持用查询参数临时覆盖它。所以**在下载名功能上线之前就已经躺在桶里的书**
需要重写一次元数据：

```bash
# 先预演：只统计不动对象（建议第一次都这么跑）
curl -X POST "https://你的域名/api/admin/backfill-disposition?dryRun=1" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# 确认数字对得上再真跑，每页 10 本
curl -X POST "https://你的域名/api/admin/backfill-disposition" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

返回 `nextAfter` 时，用 `after=<那个值>` 继续调，直到 `nextAfter` 为 `null`。
逐本处理，所以可以反复跑（已经带对的会进 `skipped`，不会重复搬运字节）。
返回的 `backfilled / skipped / missing / failed` 四类数量分开计数：
`backfilled` 是这次重写的本数，`bytesRewritten` 是这些对象的字节数之和
（每本都是一次 `get` + 一次 `put`，所以实际出入流量约为它的两倍 ——
R2 没有「只改元数据」的接口，只能整对象重写，这是如实报告，不是估算）。
`missing` 是「D1 有记录、R2 里没对象」的数据不一致，值得单独看一眼。

每页上限是 **16 本**（`limit` 参数调大也会被 clamp）：Workers Free 的子请求上限是
50/次，而一本最坏要 `head` + `get` + `put` 三个子请求。

其他管理接口：

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://你的域名/api/admin/stats
curl -X POST "https://你的域名/api/admin/purge?path=/title/A/" -H "Authorization: Bearer $ADMIN_TOKEN"
```

`stats` 会返回 `directoryCount` —— 这个数字必须远低于 200，否则挂载一次的请求数会失控。

### 迁移存量对象键（`migrate-keys`）

新书的对象键是 `books/<id>/<书名>`（见第 5 节），但「可读键」上线前
已经入库的书仍是 `books/<id>`。`POST /api/admin/migrate-keys` 把存量对象
搬成可读键，与 `backfill-disposition` 的纪律一致：**先预演，再真跑，分页收尾**。

```bash
# ① 预演：不传 apply，只统计。返回的 plan 列出「谁将从哪个键搬到哪个键」
curl -X POST "https://你的域名/api/admin/migrate-keys" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# ② 确认 plan 无误后真跑，每页 10 本；nextAfter 非空就带 after 继续
curl -X POST "https://你的域名/api/admin/migrate-keys?apply=1" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# ③ 全量跑完再来一遍，带 cleanup=1 清掉「put 成功但 delete 没跑成」的
#    孤儿旧键（正常跑完不会有孤儿；这一步只是收尾保险）
curl -X POST "https://你的域名/api/admin/migrate-keys?apply=1&cleanup=1" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

为什么敢做：

- **默认 dry-run**，不传 `apply=1` 就一个字节都不写；
- **幂等**：已经在新键的行会进 `alreadyReadable` 直接跳过，可以反复跑；
- **顺序即安全**：先 put 新键 → 再更新 D1 → 最后 delete 旧键。任何一步失败
  最坏结果是「旧对象变成孤儿」（占空间但可读，下一步 cleanup 清掉），
  而不是丢数据。顺序如果反了，一次 put 失败就永久丢书 —— 这是
  `test/migrate-keys.test.ts` 里那条**源码结构断言**专门守住的
  （变异测试实测过：把 delete 提前，11 条行为用例全绿，只有结构断言变红）；
- 每页上限同 backfill 的 16 本：一本最坏 `head + get + put + delete` 四个子请求。

### 公版种子库（800 本，期 2）

从**中文维基文库**铺公有领域的书（古籍、白话小说、民國公版作品）。
流水线、清单格式与验收命令都在 **[seed/README.md](seed/README.md)**，这里只给最短路径：

```bash
# ① 采集清单（本机跑，限速礼貌抓取；产出 seed/catalog.json，可入库）
#    卷级路线：一个维基文库页面 = 一卷 = 一本。整本路线太慢，见 seed/README.md
node scripts/seed/harvest-volumes.mjs

# ② 生成 EPUB（本机跑，零运行时依赖；产出 seed/submit/）
node scripts/seed/build-epub.mjs --all
# 整本清单已交付但未生成 EPUB（13,115 章节页，约 6–11 小时）：
# SEED_CATALOG=seed/catalog.works.json node scripts/seed/build-epub.mjs --all

# ③ 字节直传 R2 —— 走 S3，0 次 Worker 请求
rclone copy seed/submit/books r2:webooks-bucket/books --progress

# ④ 登记元数据（每批 8 本 = 1 次 Worker 请求；跑完自己打缓存）
node scripts/seed/register.mjs --dry-run          # 先验清单与文件
node scripts/seed/register.mjs --site https://你的域名 --token "$ADMIN_TOKEN"
```

几条边界，**不要改写**：

- **授权逐条可查**：每个条目都记「总集名 + 成书年代 + 编者卒年」
  （如《全唐詩》1705 年官修、編者曹寅卒於 1712）；不收任何民國/現代分类下的作品。
  `license_basis` 落库，事后可审。
- **粒度是「卷」不是「整本」**：整本要逐章抓取（800 本 × 平均 20 章 ≈ 1.6 万次请求），
  维基文库匿名 API 实测约 14 次/45 秒 —— 那是十几小时。卷级每本 1 个页面，
  800 本 ≈ 800 次请求。代价是《全唐詩·卷001》这样的一卷一本，不是传统整本。
- 登记端点只接受 `books/<id>/<书名>` 且与 id/书名自洽的键 —— 否则就成了
  「把桶里任意对象挂到任意书名下」的入口（`test/import-manifest.test.ts` 钉死）。
- 种子库**不搬字节**：800 本走 Worker 是 800 次请求 + 800 次 `put`，
  而 S3 直传是 0 次。免费额度留给读者。
- 目录列表在种库后最多 5 分钟才全部刷新（`PROPFIND_TTL`），第 ④ 步会主动打
  5 个集合根路径的缓存；单本书的 20 个缓存键**不打** —— 8 本就是 160 次
  Cache API 删除，超 Workers Free 的 50/次上限。

---

## Phase 0 必须实测的事

**`r2-webdav` 的 litmus 一致性测试只跑过 `wrangler dev --local`，没有证明线上边缘行为。**
本仓库的测试跑在 workerd（miniflare）里，同样不是 Cloudflare 边缘。

所以部署到真实域名后，第一件事是跑这两个探针：

```bash
# ① DAV 一致性 + 边缘动词放行 + Expect: 100-continue
node scripts/dav-probe.mjs --url https://你的域名/dav/
#    再带口令跑一遍，才能把写路径也验证到（否则 LOCK/DELETE/MOVE 只会看到 401）
node scripts/dav-probe.mjs --url https://你的域名/dav/ --user x --pass "$WRITE_TOKEN"

# ② 请求体体积边界（100 MB 天花板在哪、超限时什么表现）
node scripts/size-probe.mjs --url https://你的域名/dav/ --dry-run   # 先看计划
node scripts/size-probe.mjs --url https://你的域名/dav/             # 再真跑
```

### `dav-probe.mjs` 覆盖什么

| 分组 | 检查内容 |
|---|---|
| **动词放行** | PROPFIND / PROPPATCH / MKCOL / COPY / MOVE / LOCK / UNLOCK / DELETE / PUT 是否真的到达 Worker。**它会区分「源站按设计拒绝」和「边缘拦截」** —— 后者意味着整套方案要改 |
| **凭据路径** | 写动词现在需要写口令（见下）。不带口令时它们返回的 401 是**自家 Worker 的凭据闸门**（`www-authenticate: Basic realm="webooks"`），探针记为 INFO 并在结论区写「N 个写动词的凭据路径未验证」；**带了口令仍 401 才算 FAIL**（口令错） |
| Depth 语义 | 0 / 1 / 缺失 / infinity 四种情况的实际返回 |
| 协议声明 | OPTIONS 的 `DAV` 头，以及「声明 Class 2 但没实现 LOCK」这类谎言 |
| PROPFIND | allprop / propname / 未知属性进 404 propstat / 空 body（对应 litmus `props` 套件） |
| 写入读取 | PUT 201、覆盖 204、HEAD 长度、GET 302 目标可下载、DELETE 后 404 |
| 编码 | 中文文件名与 href 的百分号编码 |
| **Expect: 100-continue** | 用**原始套接字**手写 HTTP/1.1 —— fetch 会自己处理掉这个握手。这正是 r2-webdav 的 litmus `http` 套件挂掉的点 |

退出码：有 FAIL 时为 1。「按设计拒绝」（如未带口令时 LOCK 返回 401）记为 INFO，不算失败。

**不带 `--pass` 跑出来的「0 失败」不等于写路径已验证。** 写动词（LOCK / DELETE /
MOVE / 覆盖已有书）需要写口令 —— 不带凭据时它们只会返回 401，探针记 INFO 而不是
FAIL。所以结论区会额外打印一条 `⚠ N 个写动词的凭据路径未验证`，并提醒：**不带凭据
时探针清理也删不掉自己写进去的文件**，`__probe_*` 会永久留在书库里（「清理」分组会
逐条列出残留文件名）。要真正验证写路径，带上写口令重跑；若带了口令仍 401，那才是
真失败（口令错），探针会报 `✘ 已提供凭据但被拒`。

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
| **两个上传通道都没有人机验证** | 原先网页上传有 Turnstile，现已默认关闭 | 见下方「为什么关掉人机验证」。用「每日写入次数」节流缓解（减速带，非硬限制） |

### 为什么关掉人机验证

网页上传原本有 Turnstile，现在**默认关闭**。三个理由：

**1. 它防不住真正的匿名写入口。** 整个 R2 写入路径（WebDAV PUT、COPY/MOVE、
删除）从来就没有人机验证 —— WebDAV 协议里根本没有验证码的位置。所以挡住的
只是网页上传，脚本用 rclone 直接 PUT 照样能灌。真正的防线一直是
`guardWrite` 节流 + 每日写配额（见 [src/lib/throttle.ts](src/lib/throttle.ts)），
两个入口共用。

**2. 它的实际故障率很高，且症状难查。** Turnstile 要求站点域名在控制台逐一
登记（不支持通配符、不能带协议），漏登记就是 widget 一直转圈，报
`Error 1101`。浏览器控制台只有一条 `[Report Only]` 的 CSP 报告，
而真正的错误在 Cloudflare 那边 —— 表现为「网站上传坏了」却查不到原因。

**3. 对开架书库是纯粹的负收益。** 这个站点的定位是「免注册、开架、免审」，
拦住真实上传者的代价远大于防住脚本的收益。

想临时打开（担心被刷）：

```bash
npx wrangler secret put UPLOAD_REQUIRE_TURNSTILE   # 值填 1
```

⚠️ 打开后 **必须**同时配好 `TURNSTILE_SECRET`，否则会 fail-closed
（上传完全不可用）—— 这正是当初设计它的本意。
`TURNSTILE_SITE_KEY` 则要放在 vars 里（公钥，可以公开）。

---

## 测试

```bash
npm test          # 见末尾的「Test Files / Tests」两行
npm run typecheck
npm run check:dav  -- --url https://你的域名/dav/   # 线上一致性探针
npm run check:size -- --url https://你的域名/dav/   # 请求体体积边界
```

覆盖：路径解析与分桶（含**中文拼音首字母**）、分类体系与 `rebucket` 重算、
格式白名单（网页上传与 WebDAV 两条入口）、元数据推导、content-type 取舍、
XML 转义与编码、PROPFIND 请求体解析、Depth 语义、207 响应结构、
200 条硬上限与分页、缓存命中与**写入即失效**、PUT/GET/HEAD/DELETE 全流程、
未实现方法的明确拒绝、admin 鉴权、**页面内联脚本的语法自检**，
以及**缓存安全**（每个响应都必须显式声明 `cache-control`，敏感接口不许可缓存）
与**静态资源层**（`public/` 的产物字节、`_headers` 规则、`404-page` +
`run_worker_first` 必须覆盖全部 Worker 路由），还有一组**下载路径不许倒退**的守卫
（书卡必须直连 R2、必须保留 `/dav` 回退、三处写入路径 —— WebDAV PUT / COPY-MOVE /
网页上传 complete —— 与回填动作必须共用同一个 helper 带上 `Content-Disposition`，
详见 `test/download-direct.test.ts`）。

后两组值得一提：静态资源层跑在 Worker **之外**，`SELF.fetch()` 完全看不到它 ——
所以它们不测运行时行为，而是**在 Node 侧把 `public/` 的真实文件内容读进来当夹具**
（workerd 的 `node:fs` 是个空壳，读不到仓库文件），把配置与产物本身钉死。
理由很实际：这一层配错的后果是「线上整站 404，而 400+ 个测试全绿」。
下载路径那组同理：它断言的是**源码文本本身**（用 `import ... ?raw` 把 `src/` 读进来），
因为「书卡改回 `/dav`」或「某条写入路径漏掉下载名」都不会让任何行为测试变红 ——
前者只是每次下载多花一次配额，后者只是下载下来文件名难看，两个都很难在运行时发现。

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
- [书源接入设计](docs/source-ingest-design.md) —— **为什么不爬源站**、四条自动入库路线（URL / 公版种子 / OPDS / 联邦）、合规前置与配额测算
- [平台调研原始记录](docs/appendix-platform-research.md) —— 逐条引用与官方文档日期
- [安全审计报告](docs/security-audit.md) —— 漏洞复现、修复与实测数据
- [RFC 合规清单](docs/rfc-compliance.md) —— 逐条对照 RFC 4918 / 9110
- [2026-10-14 全面审查与修复记录](docs/review-2026-10-14-fixes.md) —— **数据丢失、鉴权绕过、ReDoS、ZIP bomb、锁不可用**的修复全过程
- [WebDAV RFC 深度审计](docs/webdav-rfc-audit-2026-10-14.md) —— 逐条对照 RFC 原文的完整审计
- [前端设计说明](docs/frontend-design.md) —— 「开架目录」的版面语言、颜色职责、**踩过的 CSS 坑**与可访问性基线
