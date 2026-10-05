# 在 Cloudflare 上搭公共电子书库（WebDAV / OPDS / HTTP）：可行性报告

**调研日期：2026-10-05**　所有平台数字均取自当日 Cloudflare 官方文档、GitHub API 与条款原文。
详细英文原始记录（含逐条引用与文档日期）见 [appendix-platform-research.md](appendix-platform-research.md)。

---

## 0. 结论

**能实现，而且 Cloudflare 是这类项目最划算的平台。** 已有 10+ 个"Workers + R2 提供 WebDAV"的现成实现，
WebDAV 的全部动词（含 `PROPFIND` / `MKCOL` / `MOVE` / `LOCK`）在 Workers 里都能用。
R2 出网流量**完全免费**，5 TB/月的下载量成本是 $0 —— 这一条基本锁定了技术选型。

但要先接受 **4 个硬约束**，其中第 3、4 条会直接决定项目形态：

| # | 约束 | 严重度 | 应对 |
|---|---|---|---|
| 1 | **请求体上限 100 MB**（Free **和** Pro 都是 100 MB） | 🔴 高 | 大文件走 **R2 S3 预签名直传**，绕过 Worker |
| 2 | **免费版可用，但受 100k 请求/天硬约束**；CDN 服务大文件的条款点名付费服务 | 🟡 中 | 见 [第 7 节](#7-专项只用免费额度可行吗)：**WebDAV 能跑在免费版上**，关键是压请求 |
| 3 | **"任何人可上传"会结构性破坏 DMCA 避风港**（§512(c) 要求"重复侵权者封号"政策，匿名就无法执行） | 🔴 高 | 匿名只读；上传要可追责身份 |
| 4 | **Cloudflare 条款 §8 可"无需理由随时终止"**，且收到 DMCA 通知即可停服 | 🔴 高 | 内容治理必须先于上传功能上线 |

**一句话建议**：**读**全开（WebDAV + OPDS + HTTP + S3 只读），**写**走
`Turnstile + 轻量身份 + 配额 + 隔离区审核`。用户体感依然是"谁都能传"，但你保留了追责和删除的抓手。

---

## 1. 硬约束详解

### 1.1 请求体 100 MB —— 唯一的真正技术阻塞点

Cloudflare 官方 [Workers Limits](https://developers.cloudflare.com/workers/platform/limits/) 原文：

> Request body size limits depend on your **Cloudflare account plan, not your Workers plan**.

| Cloudflare 套餐 | 最大请求体 |
|---|---|
| Free | **100 MB** |
| Pro | **100 MB** |
| Business | 200 MB |
| Enterprise | 自助最高 5 GB（默认仅 500 MB） |

超限返回 `413`，**在代理层拦截，请求根本到不了 Worker**，代码里无法绕过，流式读取也没有豁免。

影响：
- EPUB 0.3–5 MB、普通 PDF 1–50 MB → ✅ WebDAV 直传没问题
- **有声书（M4B）、扫描画册、合集 → ❌ 传不上去**

现成项目也确认了这一点。FlareDrive README 原文：
> *"the standard WebDAV protocol does not support large file (≥128MB) uploads due to the limitation of Cloudflare Workers.
> You must upload large files through the web interface which supports chunked uploads."*

**逃生通道**：R2 的 S3 端点 `<ACCOUNT_ID>.r2.cloudflarestorage.com` **不是被代理的域名**，
所以**预签名 PUT 直传不受 zone 的 100 MB 限制**（受 R2 自身单次 5 GiB 限制）。
这就是"WebDAV 只做只读挂载、大文件走 Web UI/API 直传"的核心理由 —— WebDAV 协议固定为单次 PUT，用不了这条路。

### 1.2 Workers 计算限额（官方文档）

| 项目 | Free | Paid |
|---|---|---|
| 请求数 | 100,000/天（Error 1027） | 无限制 |
| **CPU/请求** | **10 ms** | 5 min（默认 30 s） |
| 内存/isolate | 128 MB | 128 MB |
| 子请求/请求 | **50** | 10,000 |
| 同时出站连接 | 6 | 6 |
| HTTP 请求时长 | 无限制 | 无限制 |
| 响应体 | 无强制限制 | 无强制限制 |

- **10 ms CPU 对公开站点是致命的**：`PROPFIND` 生成大目录 XML 很容易超。必须 Paid。
- **子请求 50/请求**：`MOVE`/`COPY` 目录 = 逐对象复制+删除，稍大就爆。
- **128 MB 是 per-isolate 而非 per-request**，并发请求共享，所以务必流式（`env.BUCKET.put(key, request.body)`）。

### 1.3 服务条款：好消息与坏消息

**好消息：原 2.8 条早已删除。** 现行 [自助订阅协议](https://www.cloudflare.com/terms/)（最后更新 **2025-09-12**）
里没有 2.8、没有"非 HTML 内容"、没有"文件存储"限制。Cloudflare 在
[2023-05-16 官方博客](https://blog.cloudflare.com/updated-tos/) 中明确：
> *"customers can serve video and other large files using the CDN so long as that content is hosted by a Cloudflare service like Stream, Images, or R2."*

**坏消息：同一段话后面跟着"必须用付费服务"。** 限制移到了
[Service-Specific Terms → CDN](https://www.cloudflare.com/service-specific-terms-application-services/)：
> *"Unless you are an Enterprise customer, Cloudflare offers specific **Paid** Services (e.g., the **Developer Platform**, Images, and Stream) that you must use in order to serve video and other large files via the CDN."*

→ **Workers + R2 是被官方认可的路径，但前提是付费套餐。$5/月 是合规成本，不只是容量升级。**

**真正的终止风险在 §8**：*"We may at our sole discretion terminate your user account … at any time, with or without notice for any reason or no reason at all."*
再加上 *"terminate your user account upon receiving any number of DMCA notifications"*。
2.7(b) 另禁止存储侵权文件。**你成为内容托管方，重复侵权者的身份就挂在你自己的账号上。**

### 1.4 R2 的三个反直觉限制

- **❌ 没有对象版本控制**（`PutBucketVersioning` 未实现）→ **覆盖即永久丢失，无法回滚**。
  生命周期规则有（最多 1000 条，约 24 h 生效），这是你的滥用清理手段。
- **`r2.dev` 明文"不适用于生产"**，数百 req/s 就 429，且不支持 CNAME 到它 → **必须绑自定义域**。
- **预签名 URL 不能配合自定义域使用**（只能用 `*.r2.cloudflarestorage.com`）。
- 其他：单键写入限速 1 次/秒；S3 兼容层 region 必须是 `auto`；无 ACL / tagging / SSE-KMS；
  **分片重传失败会破坏原有分片**。

---

## 2. 现成实现盘点

### 2.1 WebDAV-on-R2 项目（数据取自 GitHub API，方法列表读自源码而非 README）

| 项目 | ★ | 协议 | 最后提交 | 后端 | WebDAV 方法 | 匿名读 / 写 |
|---|---|---|---|---|---|---|
| [longern/FlareDrive](https://github.com/longern/FlareDrive) | 554 | MIT | 2026-05-14 | R2 | 除 PROPPATCH/LOCK/UNLOCK（`DAV: 1`） | ✅ / ❌ |
| [ooyyh/Cloudflare-Clist](https://github.com/ooyyh/Cloudflare-Clist) | 424 | MIT | 2026-09-24 | 多存储+D1 | OPTIONS/GET/HEAD/PUT/DELETE/PROPFIND/MKCOL/COPY/MOVE | ❌ / ❌ |
| [abersheeran/r2-webdav](https://github.com/abersheeran/r2-webdav) | 419 | Apache-2.0 | 2026-09-30 | R2 | **全部 12 个**（含 LOCK/UNLOCK，`DAV: 1, 2`） | ❌ / ❌ |
| [aigem/CFr2-webdav](https://github.com/aigem/CFr2-webdav) | 225 | ⚠️ 无 LICENSE 文件 | 2024-09-20（停更） | R2 | 无 PROPPATCH/LOCK/UNLOCK | ❌ / ❌ |
| [fanchenggang/Davflare](https://github.com/fanchenggang/Davflare) | 73 | MIT | 2026-09-30 | R2 | **全部 12 个** + POST，支持分片 | ✅ / ❌ |
| [Joshuajrodrigues/bookodav](https://github.com/Joshuajrodrigues/bookodav) | 33 | GPL-3.0 | 2025-04-22 | R2 | OPTIONS/PROPFIND/PUT/DELETE/COPY | ❌ / ❌ |
| [zlanly/edge-openlist](https://github.com/zlanly/edge-openlist) | 9 | ⚠️ 无 | 2026-08-28 | D1+KV+R2 | `DAV: 1,2`，Allow 含 LOCK/UNLOCK | ❌ / ❌ |
| [lx200916/webdav-s3](https://github.com/lx200916/webdav-s3) | 5 | ⚠️ 无 | 2023-02（废弃） | 任意 S3 | `DAV: 1`，无 LOCK | ❌ / ❌ |

**四个关键发现：**

1. **没有任何项目支持"匿名公开写入"。** 公开**读**开关存在（`WEBDAV_PUBLIC_READ=1`，只放开 GET/HEAD/PROPFIND），
   公开**写**一个都没有。要做就得自己加 —— 这反而是好事，见第 5 节。
2. **LOCK/UNLOCK 是分水岭。** 只有 `abersheeran/r2-webdav`、`Davflare`、`edge-openlist` 实现了它。
   缺了它，Windows 资源管理器 / macOS Finder / Office 会出问题（webdav-s3 的 README 直接把 Finder 失败归因于缺 ETag 和 Lock）。
3. **DAV 响应头会说谎。** Cloudflare-Clist 广播 `DAV: 1, 2`，但 Allow 头里没有 LOCK/UNLOCK。**要看 Allow，不要信 DAV。**
4. **成熟度普遍偏薄。** `r2-webdav` 有一个 2024-12 起的未关闭 issue "Files Replaced with 0 KB Version"；
   CFr2-webdav 已停更 2 年且带 12 个 issue。**没有一个是生产级。**

**最推荐的起点：[abersheeran/r2-webdav](https://github.com/abersheeran/r2-webdav)**
（12 个方法最全、Apache-2.0、有 litmus CI、仍在维护）。注意它的 litmus 只跑
`basic`/`copymove`/`props`/`locks` 四套，`http` 套件因本地 Workers 对 `Expect: 100-continue` 超时而**被排除**
—— 也就是说它的一致性证明是在 `wrangler dev --local` 上拿到的，**不是线上边缘**。这是你要自己实测的第一件事。

### 2.2 电子书软件生态：一个令人不快的事实

**没有任何电子书服务端能跑在 Cloudflare Workers 上**（全是需要文件系统+长连接的 Go/Python/Java/.NET 服务）。
更麻烦的是存在**结构性错配**：

- **能对接 S3/R2 的**（Nextcloud、Seafile、Cloudreve、AList/OpenList、Pydio Cells）→ **全都不支持 OPDS**
- **支持 OPDS 的**（Calibre-Web、Komga、Kavita、Stump、BookLore）→ **全都只能用本地磁盘**

所以"R2 存字节 + 应用跑别处"这条捷径**不成立**。真实选择只有两个：

| | 路线 A：Workers 原生自研 | 路线 B：VPS + 成熟软件 |
|---|---|---|
| 形态 | 自己写 OPDS + WebDAV + Web UI，跑在 Workers，字节在 R2 | Calibre-Web / Komga / Kavita + 本地磁盘 |
| 功能 | 要自己实现，但可控 | 开箱即用，阅读器生态成熟 |
| 成本 | ≈ $5.6/月，5 TB 出网 $0 | VPS 费用 + 磁盘 + 流量费 |
| 运维 | 零 | 一台机器 |
| R2 优势 | ✅ 用得上 | ❌ 用不上 |

> 附：**Cloudreve 从未提供过 Cloudflare Workers 部署目标**（已核查并否定）。所有
> "Cloudreve + Workers"的资料都是反过来的 —— 用一个 Worker 给 Cloudreve 做反向代理。
> 网上流传的说法很可能源于混淆了 V3 更新日志里的 PWA **Service Worker**。

### 2.3 最接近你需求的现成项目

[**bookodav**](https://github.com/Joshuajrodrigues/bookodav)（33★，GPL-3.0）——
一个专门为 **KOReader 和电子书**做的 Workers + R2 WebDAV 服务端。功能还很薄（只有 5 个方法、无 MKCOL），
但它的存在本身就证明了"Cloudflare + 电子书 + WebDAV"这条路走得通，可以直接拿来读代码。

---

## 3. 协议选型：WebDAV 其实排在第三

对电子书来说，各协议的真实价值：

| 优先级 | 协议 | 谁在用 | 理由 |
|---|---|---|---|
| 🥇 | **HTTP + 网页目录** | 所有人、搜索引擎、分享链接 | 你的**真实流量**。OPDS 是加分项，不是产品 |
| 🥈 | **OPDS 1.2**（Atom XML） | KOReader、Thorium、Calibre-Web、Moon+、Librera、Panels | 电子书领域的**真协议** |
| 🥉 | **WebDAV** | rclone、RaiDrive、Finder、资源管理器、KOReader 云存储 | 面向前置用户的**文件搬运**，不是目录浏览 |
| 4 | OPDS 2.0（JSON） | 采用率仍低 | 元数据模型建好后是**廉价的 JSON 投影**，可顺手提供 |
| 5 | S3 API | 脚本、rclone、备份 | **R2 原生自带，零成本** |

### OPDS 要点（规范已通读）

- **OPDS 1.2**（2018-11-11 冻结，稳定）：Atom/XML + **Dublin Core**。
  `http://opds-spec.org/acquisition/open-access` 这个 relation 的定义就是
  *"免费获取、无需任何认证"* —— **正是你要的模型，不需要 DRM、不需要账号。**
- **OPDS 2.0**（living standard）：JSON + **schema.org** + Readium Web Publication Manifest。
  `download` 关系等价于 1.2 的 open-access。自带分页（`numberOfItems`、`next`/`prev`）。
- **不要碰 Readium LCP。** LCP 是授权/借阅的 DRM 机制，对开放下载的公共书库毫无意义且有害。
- **OPDS-PSE**（分页流式）只在服务 CBZ/漫画时有用，EPUB 用不上。
- ⚠️ **OPDS 规范只定义"分发"，不定义"投稿"。** 没有上传动词、没有审核模型、没有贡献者身份。
  **"带开放上传的公共书库"没有现成标准，必须自己设计入库流水线。**

### WebDAV 实现清单（踩坑指南）

- ⚠️ **`PROPFIND Depth: 1` 在根目录会列出全部对象** → 书一多必然爆 CPU/内存。
  而且 `CFr2-webdav` 和 `r2-webdav` **在客户端不发 Depth 头时默认按 `infinity` 处理** —— 非常危险。
  **必须**：虚拟目录分层（按首字母/分类/作者）+ 单目录分页上限 + 硬拒 `Depth: infinity`。
- `LOCK`/`UNLOCK` 需要有状态存储 → **Durable Object**（唯一强一致的串行化原语）。
  **KV 不能用**：免费版每天只有 1,000 次写，且最终一致（传播可达 60 s）。
- 必须正确实现 `ETag` / `If-Match` / `If-None-Match` / `Range`，否则客户端会反复下载整本书。
- 用 [litmus](https://github.com/notroj/litmus) 做一致性测试 —— **但要打在真实部署上**，不要只跑本地。
- 只读场景下 `LOCK` 可以直接返回 `405`，多数客户端可接受。
- macOS Finder 的 WebDAV 客户端出了名难伺候，优先保证 **rclone / Windows / KOReader**。

> **rclone 路线**：`rclone serve webdav` 可以把 R2 挂成 WebDAV（源码里用 `webdav.NewMemLS()`，**确实支持 LOCK**，
> 尽管文档没写）。但 rclone **必须跑在 VPS/容器上**，不能跑在 Cloudflare。
> 写语义取决于 `--vfs-cache-mode`：默认 `off` 不能 seek、忽略 `O_APPEND`/`O_TRUNC`、失败不能重试。

---

## 4. 推荐架构（路线 A）

```
              ┌────────────────────────────────────────────────┐
 浏览器 WebUI │  Worker (Hono) —— 单入口多路由                  │
 KOReader ───►│   /            网页目录 + 搜索 (HTML)           │
  (OPDS)      │   /opds        OPDS 1.2 (Atom + Dublin Core)   │
 rclone  ────►│   /opds/v2     OPDS 2.0 (JSON + schema.org)    │
  (WebDAV)    │   /dav/*       WebDAV（Class 1/2，D1 目录树）    │
 脚本/S3 ────►│   /d/:id/:slug 下载（Range/ETag/304）           │
              │   /api/upload/{init,complete}  预签名直传        │
              └──────┬───────────┬───────────┬─────────────────┘
                     │           │           │
                 R2 bucket      D1        Durable Object
               books/  公开   metadata   · WebDAV LOCK 表
               inbox/  暂存   + FTS5     · 上传配额
               quarantine/     + 标签
                     │
                     └─► Queue + Consumer
                          · 解析 EPUB OPF / PDF XMP → Dublin Core
                          · magic-byte 校验、SHA-256 去重、恶意文件扫描
                          · 通过后 inbox/ → books/
```

### 4.1 上传路径（核心）

**小文件（≤100 MB）**：`PUT /dav/...` 或 `POST /api/upload` → Worker 流式 `R2.put()`，不缓冲。

**大文件（>100 MB）**：必须客户端直传，Worker 只签名、不碰字节：

1. `POST /api/upload/init` → Worker 校验 Turnstile、账号配额、IP 限流；
   用 [`aws4fetch`](https://github.com/mhart/aws4fetch) 调 S3 API `CreateMultipartUpload`，返回**预签名分片 URL**
2. 客户端直接 PUT 分片到 `https://<ACCOUNT_ID>.r2.cloudflarestorage.com/...`
   —— **不在被代理的 zone 内，完全绕过 100 MB 限制**（R2 单对象 5 TiB / 最多 10,000 分片）
3. `POST /api/upload/complete` → `CompleteMultipartUpload`，写 D1（状态 `pending`），投递 Queue
4. 校验通过后 `inbox/` → `books/`，状态改 `published`
5. 未完成的分片由生命周期规则自动清理（R2 默认 7 天）

> ⚠️ **R2 没有版本控制**，覆盖即永久丢失。所以"提升"操作要做成**写新键 + 删旧键**，不要原地覆盖。

### 4.2 元数据层

- **D1**：`books(id, title, author, isbn, language, format, size, sha256, status, uploader, created_at)` + `books_fts`（FTS5）
- **Queue Consumer** 解析 EPUB `content.opf` / PDF XMP，抽取标题作者封面 → 写 D1
- **Dublin Core 作为内部规范模型**（OPF 天然映射），再**投影**成 OPDS 1.2 XML 和 OPDS 2.0 JSON
- **WebDAV 的目录树从 D1 查，不要用 `R2.list()` 实时遍历整个桶**

### 4.3 成本

| 项目 | 用量 | 计费 | 费用 |
|---|---|---|---|
| Workers Paid 底价 | — | — | **$5.00** |
| R2 存储 | 50 GB-mo | 40 GB × $0.015 | **$0.60** |
| R2 出网 | **5 TB** | 免费 | **$0.00** |
| R2 Class A（写/列举） | 10 万 | 免费额度内 | $0.00 |
| R2 Class B（读） | 200 万 | 免费额度内 | $0.00 |
| D1 | 5000 万行读 / 10 万行写 | 额度内 | $0.00 |
| Durable Objects | ~20 万请求 | 额度内 | $0.00 |
| Turnstile | 无限 | 免费 | $0.00 |
| **合计** | | | **≈ $5.60 / 月** |

**对比**：同样 5 TB/月出网，S3 约 $0.09/GB ≈ **$450/月**。

> ⚠️ **索引敏感性**：D1 按**扫描行数**计费，不是返回行数。
> 如果每个元数据查询扫 1,000 行而非 1 行，读取量从 5,000 万暴涨到 500 亿 → **+$25/月**。
> 给筛选列建索引大约值 $25/月，这笔账要算清楚。

⚠️ **免费额度全部不够用**：Workers Free 10 万请求/天、10 ms CPU；
D1 Free 5 GB 且**不可扩容**（Paid 上限 10 GB，同样不可再扩）；KV Free 每天仅 1,000 次写。
**$5/月 是地板价。**

---

## 5. 上传治理：决定项目生死的一环

### 5.1 为什么不能做"完全匿名上传"

这不只是"怕被滥用"，而是**结构性的法律缺陷**：

- **DMCA §512(c) 避风港的前提条件之一是"重复侵权者封号政策"**。
  没有账号体系，你**无法执行**这条政策，也就**丧失避风港资格**。
- **18 U.S.C. §2258A 强制要求向 NCMEC 报告**疑似 CSAM，不作为要担责。这没有任何避风港覆盖。
- **"我们是图书馆"在美国不是抗辩理由**：Internet Archive 的 CDL 案已于 2024-12 走完全部程序
  （第二巡回法院认定不构成转换性合理使用，最高法院拒绝调卷），**案件终结**。
  只有**真正进入公有领域或获得授权**的内容才能公开托管。
- **Cloudflare §8** 允许"无需理由随时终止"，且收到 DMCA 通知即可停服。
  你成为托管方，重复侵权者身份就落在你的账号上。

### 5.2 推荐做法：开放但可追责

| 层 | 措施 |
|---|---|
| 反机器人 | **Turnstile**（免费，无限验证、20 个 widget）—— 性价比最高的上传门禁 |
| 身份 | 不要完全匿名。GitHub/Google OAuth 或邮箱魔法链接，**一次性成本极低、威慑力极高**，且是执行重复侵权者政策的**前提** |
| 配额 | 每账号/每 IP：如 200 MB/天、5 文件/天、总量 2 GB |
| 限流 | ⚠️ Cloudflare 免费版**只有 1 条**限流规则（固定 10 s 窗口、仅 IP、表达式仅限 Path + Verified Bot）→ 需要自建或用 Workers Rate Limiting binding。**不要用 DO 做限流**（最贵），DO 留给 LOCK |
| 暂存 | 所有上传先落 `inbox/`，**不出现在任何列表和搜索结果中** |
| 类型校验 | **magic-byte 判断真实类型**（别信扩展名），白名单 `epub/pdf/mobi/azw3/txt/cbz/m4b`，单文件大小上限 |
| 去重 | SHA-256 内容哈希去重 —— 同时是防重复上传和**永久封禁已删除文件哈希**的基础 |
| 扫描 | ⚠️ **R2 不提供任何内置病毒扫描**；Cloudflare 的 **WAF Malicious Uploads Detection** 有，但针对 webshell/恶意载荷，**不针对 CSAM** |
| 审核 | 三选一：人工队列 / 社区举报加权 / 自动规则（哈希黑名单+类型校验通过即上架，其余进人工） |
| 下架 | 每本书页脚举报按钮、`/abuse` 表单、**注册 DMCA 指定代理人**（版权局电子目录登记 + 网站公示联系方式）、哈希墓碑表阻止重复上传、保留证据以备 NCMEC 报告 |

### 5.3 ⚠️ 一个容易踩的坑：CSAM 扫描工具不管 R2 静态对象

Cloudflare 的 **CSAM Scanning Tool** 文档挂在 `/cache/reference/csam-scanning` 下
（→ [docs](https://developers.cloudflare.com/cache/reference/csam-scanning/)，2025-02-04 简化了接入），
说明它作用于**经过 Cloudflare 代理的 HTTP 流量**，**不扫描躺在 R2 桶里的静态对象**。

**推论：你的私有隔离区（永远不会被公开访问）不会被它扫到。**
必须在**上传/入库边界自建哈希匹配**（PhotoDNA / PDQ 类感知哈希 → 自动隔离 → 报告 NCMEC → 永久封禁哈希）。

### 5.4 内容策略：这是唯一能长期活下去的路

参考**古腾堡计划**和 **Standard Ebooks** 的做法 —— 两者都是**发布前完成权利核实**，
而不是"先传后审"。建议：

- 定位在**公有领域 + 明确授权**内容：古腾堡、Standard Ebooks、CC 授权作品、
  中文公有领域（四大名著、鲁迅等），或用户上传自己的原创/扫描件
- **中国大陆视角**：服务器在境外虽不强制 ICP 备案，但《著作权法》《信息网络传播权保护条例》
  下的侵权责任依然适用；大规模未经授权传播情节严重可涉刑。
  "任何人可上传"的通道会显著放大风险，且难以主张"仅提供存储空间"以外的抗辩空间。
- Cloudflare 官方参考架构 [Storing user generated content](https://developers.cloudflare.com/reference-architecture/diagrams/storage/storing-user-generated-content/)
  推荐的也是 **"校验权限后再签发 URL"**，而非无限制匿名上传。

---

## 6. 落地路线图

### Phase 0 —— 半天：验证最大的未知数

**先别写代码，先实测。** 全项目最大的未知数是
**线上边缘是否真的放行 WebDAV 动词并正确处理 `Depth` 头**（`r2-webdav` 的 litmus 测试只跑过本地）。

1. `npx wrangler` 把 [abersheeran/r2-webdav](https://github.com/abersheeran/r2-webdav) 部署到你的自定义域
2. 用 `curl -X PROPFIND -H "Depth: 1"` 直接打线上域名，确认 207 响应
3. 装 [litmus](https://github.com/notroj/litmus)，**打线上部署**跑 `basic` / `props` / `copymove` / `locks`
4. 用 rclone 挂载，实测 `rclone copy` 上传下载、大文件边界（99 MB / 101 MB / 200 MB）
5. 测 `Expect: 100-continue`（已知 r2-webdav 的 litmus `http` 套件就是这个挂的）

**这一步的结果会决定后面所有设计**，尤其是第 1 节的大文件通道是否必须。

### Phase 1 —— 3~5 天：可公开访问的只读书库

- 单 Worker + R2，HTML 目录 + 搜索 + `GET /d/:id/:slug`（Range / ETag / 304）
- D1 建表 + FTS5 + EPUB OPF 元数据抽取
- **OPDS 1.2 端点**，用 KOReader / Thorium 实测
- 绑定自定义域（不要用 `r2.dev`），设长缓存 + immutable

### Phase 2 —— 3~5 天：WebDAV 只读挂载

- 移植 r2-webdav 的 `PROPFIND`/`GET`/`HEAD`，目录树来自 D1
- **硬拒 `Depth: infinity`**，单目录分页上限，虚拟目录分层
- litmus 回归；Windows / macOS / rclone 三端实测

### Phase 3 —— 1~2 周：受控上传

- Turnstile + OAuth + 配额 + 限流（Workers Rate Limiting binding）
- **分片预签名直传** + Queue 校验流水线 + 隔离区
- 自建哈希黑名单（CSAM / 已删除盗版）
- 举报按钮 + `/abuse` 流程 + 审计日志

### Phase 4：合规与运营

- 注册 DMCA 指定代理人（版权局电子目录，费用约 $6 / 3 年，**此细节未逐字核实**），并在站点公示
- 撰写 CSAM 应急响应预案（发现 → 隔离 → 保留证据 → NCMEC 报告）
- 发布内容政策与下架 SLA
- （可选）OPDS 2.0 投影、封面缩略图、Kobo/Kindle 推送

---

## 7. 专项：只用免费额度可行吗？

### 7.1 先确认：哪些是"真·硬停"，不会产生账单

| 产品 | 超额行为 |
|---|---|
| Workers Free | 100,000 请求/天，**硬停**（Error 1027；路由可配 fail open / fail closed；`run_worker_first` 场景返回 429），UTC 0 点重置 |
| D1 Free | **2026-09-01 起查询直接报错**，直到 UTC 0 点重置；**数据不受影响**，会发邮件告警 |
| KV Free | 硬停（10 万读/天、1,000 写/天） |
| Workers 静态资源 | **免费且无限** —— 这是免费方案最关键的一根杠杆 |

**这部分判断是对的：Workers / D1 / KV 用完就停，不会产生账单。**

### 7.2 但 R2 不是 —— 而书恰好存在 R2 里

**R2 的本质是"订阅 + 内含免费额度"，不是"免费套餐"。** 官方 Get started 原文：

> You need a Cloudflare account with an **R2 subscription**... Complete the **checkout flow** to add an R2 subscription to your account.
> R2 is free to get started with included free monthly usage. **You are billed for your usage on a monthly basis.**

[用量计费总览](https://developers.cloudflare.com/billing/understand/usage-based-billing/)也把 R2 明确列入按量计费产品：
*"you are only charged for usage that exceeds the included amount."*

R2 免费额度：**10 GB-month 存储 / 100 万 Class A / 1000 万 Class B**。
**超了继续服务，照常计费，不会停。**

而且 Cloudflare **只有预算告警（邮件），没有硬性消费刹车** ——
[Budget alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/) 文档原文只承诺
*"notify you by email when your account-wide usage-based spend crosses a dollar threshold"*，是警报，不是刹车。

> ⚠️ **最坏情况不是"服务停了"，而是"书库继续跑，账单继续涨"** —— 恰好是免费方案最想避免的那件事。
> 好消息是 R2 单价极低，50 GB 也才 $0.60/月，不会失控；但它是**账单**，不是**停止**。

### 7.3 就算自动停，那也不是安全网，是每天固定时段宕机

重置时刻是 **UTC 0 点 = 北京时间早 8 点**。真实表现：

- 早上 8 点恢复 → 白天某个时刻额度用光 → **站点挂掉** → 直到第二天早上 8 点
- 对**公开**服务这是最糟的失败模式：访客分不清"站点宕了"还是"这站跑路了"
- **下载会在传输中途断掉**
- WebDAV 尤其吃请求：客户端挂载一次 = 每个目录一次 `PROPFIND`，每个文件一次 `GET`。
  按请求池算，10 万/天约等于**每天 6,500 次"浏览+下几本书"的会话**，或 **20 次全库同步**（详见 7.5）

### 7.4 配额完全防不住真正的风险

请求配额与 **Cloudflare §8 账号终止**、**DMCA**、**CSAM** 毫无关系。
§8 是"随时无需理由终止**账号**"—— 赔进去的是你账号下的全部资产，不只这一个 Worker。
免费额度对此**零防护**。

### 7.5 更正：WebDAV 在免费版**能跑**，它是预算问题，不是可行性问题

本文早先版本把结论写成"免费方案与 WebDAV 互斥"，**说重了，此处更正**。

事实是：**WebDAV 可以完全跑在 Workers Free 上**，只受
**100,000 请求/天**约束 —— 注意这是**按账号**计（不是按 Worker），
且 [Pages Functions 共享同一配额](https://developers.cloudflare.com/pages/platform/limits/)：
*"Requests to Pages functions count towards your quota for Workers plans."*
（所以"拆成两个项目拿双倍额度"这条路不存在。）

而这个池子比直觉大得多 —— 请求成本主要是**每个目录一次 `PROPFIND` + 每个文件一次 `GET`**：

| 典型用法 | 每次会话请求数 | 100k/天 可支撑 |
|---|---|---|
| 浏览几个目录 + 下载 3 本 | ~15 | **约 6,500 次** |
| 挂载后翻 20 个目录 | ~30 | **约 3,300 次** |
| rclone 全库同步 5,000 本 | ~5,000 | **约 20 次** |
| Finder 长期挂载（爱反复发 PROPFIND） | 数千 | 几十个用户 |

**对新建/小众书库，这个额度相当宽裕。** 而且它自带一个清晰的升级触发器：
**哪天 10 万/天不够用了，说明书库真的成功了 —— 那时 $5 已经不是问题。**

非 WebDAV 的部分本来就几乎不花请求，可以顺手做掉：

| 组件 | 免费做法 | Worker 请求 |
|---|---|---|
| 书籍下载 | **R2 公开自定义域直链** | **0**（消耗 Class B，1000 万/月） |
| 网页 UI | **Workers 静态资源** | **0**（官方：免费且无限） |
| OPDS feed | **预生成为文件写入 R2**，走公开域 | **0** |
| 搜索 | 预生成 JSON 索引 + 前端搜索 | **0** |

### 7.6 把 WebDAV 请求压下来的 8 条设计 —— 免费版的成败全在这里

1. **目录树"宽而浅"**：目录总数控制在 200 以内。
   **绝不按"每本书一个目录"组织** —— 目录数会直接乘进请求数。
2. **单目录条目上限 ~200 条**，超出拆子目录。这同时也满足 **10 ms CPU**：
   生成 200 条 PROPFIND XML 约 1–3 ms，1,000 条就会顶到上限。
3. **硬拒 `Depth: infinity`**（返回 403 或降级为 Depth 1），防 CPU 爆炸。
4. ⚠️ **PROPFIND 的结果必须缓存** —— 这条最容易漏，而且最致命。
   具体瓶颈取决于实现方式：
   - **若用 `R2.list()` 实现**（多数现成项目的做法）：每次未缓存的 PROPFIND = **1 次 Class A 操作**。
     10 万次/天 × 30 天 = **300 万次/月**，超出免费额度 100 万次 → 200 万 × $4.50/M = **$9/月**，
     **比直接买 $5 套餐还贵。**
   - **若改用 D1 存目录树**（`webooks` 实现的选择）：Class A 归零，但每次未缓存的 PROPFIND
     要读约 200 行 D1。10 万次全部未命中 = 2000 万行/天，**会超出 D1 的 500 万行/天**。

   两条路的结论一样：**缓存不是优化，是必需品**。命中率 90% 时 D1 读取降到约 200 万行/天，安全。
5. **`GET` 返回 302 跳到 R2 公开自定义域**：下载不再占用 Worker 的 CPU/内存，并让 CDN 缓存生效。
6. **让 rclone / 脚本用户直接走 R2 的 S3 端点**（rclone 原生支持 S3）→ **0 个 Worker 请求**。
   把 WebDAV 的受众收窄到**只会讲 WebDAV 的客户端**（Finder、Windows、KOReader）。
   这是省预算最狠的一招。
7. **推荐 rclone 挂载而非 Finder**，并给一行配置把目录缓存拉长：
   `rclone mount --dir-cache-time 24h --poll-interval 0 --vfs-cache-mode off`
8. **用免费版唯一的那条限流规则按 IP 限速**，防止单个客户端吃光全天预算。

### 7.7 免费额度耗尽时会发生什么（必须接受这一点）

- 每天 **UTC 0 点 = 北京时间早 8 点**重置。用光后 Worker 停摆到第二天早 8 点。
- 表现为返回 1027，或按路由配置回退到源站（无源站即 404/522）。
  建议配 **fail closed**，让故障状态可预期。
- **务必挂用量告警**，不要等用户来告诉你站点挂了。

### 7.8 如果 10 万/天真的不够，且仍然要 $0

把 **WebDAV 端点**从 Cloudflare 挪到 **Oracle Cloud Always Free**，存储仍然指向 R2 —— 总成本仍是 $0：

| Oracle Always Free 资源 | 规格（2026-10 官方文档） |
|---|---|
| Arm Ampere A1 | **2 OCPU / 12 GB**（1,500 OCPU 小时 + 9,000 GB 小时/月） |
| AMD Micro | 2 台（1/8 OCPU / 1 GB） |
| 块存储 | 200 GB 总计 |
| **出网流量** | **10 TB / 月** |
| 时长 | **永久免费**（*"available for an unlimited period of time"*） |

在这台机器上跑 `rclone serve webdav`（或 dufs / OpenList），后端指向 R2 → **WebDAV 请求不限量**。

⚠️ 两个必须先知道的风险：

1. **注册折腾**：需要信用卡验证，且经常报 *"out of host capacity"*（可用性域缺货）。
2. **空闲会被回收**：官方原文 —— 7 天内 CPU、网络、内存的 **95 分位都低于 20%** 时，
   *"Idle Always Free compute instances **may be reclaimed** by Oracle."*
   低流量文件服务器很容易落进这个区间。公开书库有真实流量时风险较低，但**依然存在**。

> 别考虑 GCP / AWS：GCP e2-micro 免费额度只有 **1 GB/月出网**，AWS 免费只有 12 个月 —— 都撑不起书库。

### 7.9 建议路线

**别过度设计。先按 7.6 节把免费版跑起来**，10 万请求/天对新建书库完全够用。
只在真的被打满、且你确实不想付那 $5 时，才把 WebDAV 端点迁到 Oracle ——
**R2 里的书一本都不用动。**

---

## 8. 待实测 / 待核实清单

| # | 事项 | 状态 |
|---|---|---|
| 1 | 线上边缘对 `PROPFIND`/`MKCOL`/`COPY`/`MOVE`/`LOCK` 的实际行为、`Depth: infinity` 处理、WAF 是否插手中文动词 | ⚠️ **未验证**，Phase 0 必测（官方只说 *"In Workers, all HTTP request methods are supported, except for CONNECT."*） |
| 2 | `*.workers.dev` / 橙云 Route / Workers Custom Domains 三者对自定义动词是否有差异 | ⚠️ 未验证 |
| 3 | 云 CDN 是否会缓存非 GET 请求 | 官方：不会 |
| 4 | Workers Paid 下大目录 `PROPFIND` 的真实 CPU 消耗 | 未验证，无公开 benchmark |
| 5 | Cloudreve 是否曾有 Workers 部署目标 | ✅ **已否定**（无任何证据，相关说法系混淆） |
| 6 | R2 是否存在官方 WebDAV 支持 / 路线图 | ✅ **无**，R2 文档零次提及 WebDAV |
| 7 | DMCA 代理人 $6 / 3 年 的具体费用与续期规则 | 未逐字核实 |
| 8 | CSAM 扫描工具是否覆盖 R2 静态对象 | ⚠️ 推断**不覆盖**（文档位于 `/cache/` 下），需向 Cloudflare 确认 |
| 9 | Cloudflare 滥用处理页面的托管服务列表**未列 R2** | 疑为文档过时，未核实 |

---

## 9. 参考链接

**平台**
- [Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)（2026-09-05）· [Workers Pricing](https://developers.cloudflare.com/workers/platform/pricing/)（2026-10-02）
- [R2 Limits](https://developers.cloudflare.com/r2/platform/limits/)（2026-06-08）· [R2 Pricing](https://developers.cloudflare.com/r2/pricing/)（2026-10-01）· [R2 Get started](https://developers.cloudflare.com/r2/get-started/)（2026-04-21）
- [用量计费总览](https://developers.cloudflare.com/billing/understand/usage-based-billing/)（2026-05-29）· [预算告警](https://developers.cloudflare.com/billing/manage/budget-alerts/)（2026-05-29）
- [D1 免费额度强制执行变更](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/)（2026-09-01）· [静态资源计费](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)（2026-04-23）
- [Pages Limits](https://developers.cloudflare.com/pages/platform/limits/)（2026-09-05，确认 Pages Functions 共享 Workers 配额）

**免费替代宿主**
- [Oracle Cloud Always Free 资源清单](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)（2 OCPU/12 GB ARM · 200 GB 块存储 · **10 TB/月出网** · 永久免费；含空闲回收条款）
- [R2 S3 兼容性](https://developers.cloudflare.com/r2/api/s3/api/)（2026-07-31）· [预签名 URL](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)（2026-08-22）
- [公开桶](https://developers.cloudflare.com/r2/buckets/public-buckets/)（2026-09-25）· [生命周期规则](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
- [D1 Limits](https://developers.cloudflare.com/d1/platform/limits/)（2026-04-21）· [D1 Pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [Durable Objects Limits](https://developers.cloudflare.com/durable-objects/platform/limits/)（2026-06-01）· [Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)（2026-09-30）
- [KV Limits](https://developers.cloudflare.com/kv/platform/limits/)（2026-04-21）
- [限流规则](https://developers.cloudflare.com/waf/rate-limiting-rules/)（2026-08-25）· [Turnstile 套餐](https://developers.cloudflare.com/turnstile/plans/)（2026-08-14）
- [WAF Malicious Uploads Detection](https://developers.cloudflare.com/waf/detections/malicious-uploads/)

**条款与合规**
- [Cloudflare 自助订阅协议](https://www.cloudflare.com/terms/)（2025-09-12）· [2.8 条删除说明](https://blog.cloudflare.com/updated-tos/)（2023-05-16）
- [Service-Specific Terms](https://www.cloudflare.com/service-specific-terms-application-services/) · [滥用处理方式](https://www.cloudflare.com/trust-hub/abuse-approach/)
- [CSAM 扫描工具](https://developers.cloudflare.com/cache/reference/csam-scanning/) · [儿童安全](https://www.cloudflare.com/trust-hub/child-safety/)
- 17 U.S.C. §512（DMCA 避风港）· 18 U.S.C. §2258A（NCMEC 强制报告）
- [Internet Archive CDL 案终结](https://blog.archive.org/2024/12/04/end-of-hachette-v-internet-archive/)（2024-12-04）
- [古腾堡权利核实政策](https://www.gutenberg.org/policy/permission.html) · [Standard Ebooks 公有领域说明](https://standardebooks.org/about/standard-ebooks-and-the-public-domain)

**协议与实现**
- [OPDS 1.2](https://specs.opds.io/opds-1.2) · [OPDS 2.0](https://specs.opds.io/opds-2.0)
- [abersheeran/r2-webdav](https://github.com/abersheeran/r2-webdav) · [longern/FlareDrive](https://github.com/longern/FlareDrive) · [fanchenggang/Davflare](https://github.com/fanchenggang/Davflare) · [Joshuajrodrigues/bookodav](https://github.com/Joshuajrodrigues/bookodav)
- [litmus WebDAV 一致性测试](https://github.com/notroj/litmus) · [rclone serve webdav](https://rclone.org/commands/rclone_serve_webdav/) · [aws4fetch](https://github.com/mhart/aws4fetch)
