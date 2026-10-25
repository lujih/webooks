# 书源接入设计：四条自动入库路线，以及公共书库的合规前置

**日期**：2026-10-23　**状态**：期 0、期 1 已实现并验证；期 2 工具链已实现、800 本待跑（需 R2 凭据）；期 3–4 待排期

---

## 0. 结论

**「自动爬源站」不做。** 不是保守，是在这个项目上它同时撞三堵墙：法务定性、Workers Free 的
物理上限、以及 10 GB 存储。三堵墙在 §2 逐条展开，其中前两条是
[可行性报告 §5.1](cloudflare-ebook-library-feasibility.md) 早就写下的结论，不是新判断。

**真正缺的不是「爬」，是「入库通道」。** 现在书要进库，必须有人先把文件放到本机，
再点上传或挂 WebDAV。把这一段自动化掉，书源立刻从「人手够不够」变成「配置几行」。

**四条路线，一条共同前置：**

| 期 | 内容 | 解决什么 | 工作量 | Worker 请求 |
|---|---|---|---|---|
| **0** | 抽出 `ingestBook()` 公共管道 + 来源声明列 | 下面四项的共同阻塞点 | 1–1.5 天 | 0（纯重构） |
| **1** | **A. URL 一键导入** | 「下载到本机再上传」的重复劳动 | ~1 天 | 1 本 = 1 |
| **2** | **D. 公版中文种子库** | 冷启动太空 | 1–2 天 | **0**（S3 直传） |
| **3** | **B. OPDS 源同步** | 书源数量真正变多 | 3–4 天 | 3000 本 ≈ 6000 |
| **4** | **C. 联邦式远程源**（可选） | 自有 Kavita/Komga 直接挂进来 | 5–7 天 | 0（302 直连） |

**顺序不能换。** 期 0 不做，后面四条会各自复制一遍 `handleUploadComplete` 那 200 行，
然后发散成四份互不一致的入库逻辑 —— 这正是这个仓库反复修过的那类 bug
（白名单只在 init 检查、complete 不检查；`kind_bucket` 被覆盖上传冲掉；缓存失效漏一条路径）。

---

## 1. 现状盘点：书是怎么进来的

| 入口 | 鉴权 | 配额 | 字节路径 | 入库逻辑 |
|---|---|---|---|---|
| 网页上传 `/api/upload/init` + `/complete` | Turnstile（默认关）+ ticket | `guardWrite` 300/日/IP | 预签名**直传 R2**，不过 Worker | `complete` 里内联 ~200 行 |
| WebDAV `PUT` | `WRITE_TOKEN` | 同上 | **过 Worker**（100 MB 体上限） | `handlePut` 里另一份 |
| S3 / rclone 直连 | R2 密钥 | 不占 Worker | 不占 Worker | **无**，要另跑 `reindex` |
| `POST /api/admin/reindex` | `ADMIN_TOKEN` | — | 读 R2 | 从对象**反推**，16 本/页 |

三个直接结论：

1. **入库逻辑没有单一事实来源。** `handleUploadComplete` 与 `handlePut` 各有一份，
   `reindex` 是第三份且**信息更少**（只能从键和字节反推，拿不到「谁传的、从哪来的」）。
   任何新书源接进来，都必然要在第四处再写一遍。
2. **`reindex` 无法承载来源信息。** 它走的 `upsertBook` 只认文件自身的事实。
   联邦源要记「源 id + entry id」，公版库要记「授权依据」，这些字段现在**无处可存**。
3. **`status` 列已经存在**（`'published'`，`migrations/0001_init.sql`），但只有这一个取值。
   隔离区（`inbox/`）在可行性报告 §5.2 里是明确要求的，实现上是**零成本**——只是没人往里写。

---

## 2. 明确不做的事

### 2.1 不做「源站爬虫」

- **法务**：起点/番茄/晋江/七猫/哔哩哔哩漫画/快看 的授权条款一律禁止抓取转载；
  抓取后对外分发，项目定性就从「存储服务」变成「内容提供方」。
  [可行性报告 §5.1](cloudflare-ebook-library-feasibility.md) 已经写明后果：
  收到 DMCA 即停服（Cloudflare §8「无需理由随时终止」），且当前匿名上传结构
  **无法执行重复侵权者政策 → 没有 §512(c) 避风港资格**。
- **平台**：Workers Free 是 10 ms CPU + **50 子请求/请求**。抓一本 300 章的小说，
  仅子请求就爆；HTML 解析 + 反爬对抗是**持续维护**的活，不是一次性开发。
- **存储**：R2 免费 10 GB。EPUB 平均 1.5 MB，能放约 6000 本；
  漫画 CBZ 平均 100 MB，**只能放 100 本**。自动抓漫画等于自动把额度撑爆并开始计费。

### 2.2 不做的具体形态

- ❌ 登录态抓取、绕过付费墙/反爬验证（《著作权法》第 53 条、刑法 285 条风险）
- ❌ DRM 移除
- ❌ 在 Worker 内跑站内爬虫/HTML 采集
- ❌ 「漫画全自动扩张」——10 GB 是硬约束，与法律无关
- ❌ 把抓来的「全集包」整包入库

### 2.3 采集器可以存在，但必须放在平台外

真要跑采集（只对公版/授权源），放到**自己的 NAS** 上（这台机器就是 fnOS），
采完用 S3 直传 R2 入库，Worker 只负责「存」。这样 CPU 无限、不占请求、不碰条款边缘。
这正好也是 D 路线（§5）的形态。

---

## 3. 前置：公共书库的合规门槛

作者已确认定位是**公开可浏览、朋友可上传的公共书库**。在这个定位下，
批量导入通道上线**之前**必须先有下面四件，否则等于把「每小时能灌 300 本」变成公开能力：

| 门槛 | 现状 | 本期要做 |
|---|---|---|
| **来源声明** | 无 | 每本书记 `source_kind` / `source_url` / `license_basis` / `ingested_by`（§4.2） |
| **隔离区** | `status` 列有，但只写 `published` | 导入先落 `inbox/` + `status='inbox'`，`/admin` 逐本/批量放行后才进任何列表 |
| **下架与墓碑** | `tombstones` 表已存在、`isTombstoned` 已有调用方 | 导入路径接上墓碑检查（同一 sha256 不再进库） |
| **可追责性** | 完全匿名 | 至少：朋友上传用邀请码（一个 HMAC 参数，无账号体系）；举报入口 `/abuse` |

`tombstones` 和 `isTombstoned` 已经是现成的，这项几乎是白捡；**来源声明**是本设计唯一
必须新增的表结构，所以放在期 0。

> 说明：邀请码不是账号体系，也**不构成** §512 避风港要求的「重复侵权者封号」政策。
> 它只是把「任何人」收窄到「拿到码的人」。真要主张避风港，需要身份层——
> 那是另一个量级的改动，不在本设计范围，但**必须让作者知道这层没有解决**。

---

## 4. 期 0：抽出 `ingestBook()`（唯一的重构风险点）

### 4.1 目标签名

新建 `src/lib/ingest.ts`，把 `handleUploadComplete` 里的管道原样搬出来，只把
「字节从哪来」参数化：

```ts
export type IngestOrigin =
  | { kind: 'upload'; stagingKey: string; credit: string }
  | { kind: 'url'; url: string; declaredUrl: string; credit: string; licenseBasis: string }
  | { kind: 'opds'; sourceId: string; entryId: string; credit: string; licenseBasis: string }
  | { kind: 'seed'; manifestId: string; licenseBasis: string };

export type IngestResult =
  | { ok: true; bookId: string; leafName: string; title: string; author: string | null;
      format: string; size: number; coverKey: string | null; deduped: boolean }
  | { ok: false; code: 'already-exists' | 'unsupported-format' | 'file-too-large'
              | 'tombstoned' | 'object-unreadable' | 'bad-magic'; detail: unknown };

/** 由调用方保证：字节已经在 R2 的 staging key 上（或由 url 现场拉取） */
export async function ingestBook(env: Env, origin: IngestOrigin): Promise<IngestResult>;
```

管道内容（**逐段照搬现有实现，行为不变**）：
`sanitiseLeafName` → 同名冲突检测（`findBookByLeaf`）→ 扩展名白名单（`isAllowedUploadExt`）→
`bookObjectKey` 搬键 → EPUB 解析（`parseEpub` + `PARSE_SIZE_CAP`）→ 封面落 `covers/<id>.<ext>` →
TXT 作者嗅探（前 16 KiB）→ PDF 布局嗅探（`sniffKindFromBucket`）→ `upsertBook` →
`adjustBuckets(bucketDeltas(...))` → `purgeCreditCache()` → `purgeEntries(bookCacheTargets(...))`。

**验收方式（这是期 0 唯一的硬要求）**：`handleUploadComplete` 改为调用 `ingestBook`，
`test/upload.test.ts`、`test/upload-cache-purge.test.ts`、`test/admin-reindex-safety.test.ts`
**一行不改全绿**。测试有改动就说明行为变了，需要单独论证。

### 4.2 数据模型（`migrations/0009_source_ingest.sql`）

```sql
-- 来源声明：为什么这本书可以在这里
ALTER TABLE books ADD COLUMN source_kind   TEXT;   -- upload|url|opds|seed|dav
ALTER TABLE books ADD COLUMN source_url    TEXT;   -- 原始地址（可空：上传无地址）
ALTER TABLE books ADD COLUMN license_basis TEXT;   -- public-domain|authorized|user-declared|unknown
ALTER TABLE books ADD COLUMN ingested_by   TEXT;   -- 邀请码/管理员标识，非账号
ALTER TABLE books ADD COLUMN source_id    TEXT;   -- 远程源 id（B/C 路线用）
ALTER TABLE books ADD COLUMN source_entry TEXT;   -- 源内条目 id（去重键）

CREATE INDEX IF NOT EXISTS idx_books_source ON books(source_id, source_entry);
CREATE INDEX IF NOT EXISTS idx_books_status_kind ON books(status, kind_bucket);
```

`license_basis` 刻意做成闭集且**默认 `unknown`**：导入时声明不清的一律进 `inbox`，
由人放行。这与项目「判不出就返回 null，宁缺毋滥」的既有哲学一致。

---

## 5. 期 1：A. URL 一键导入

### 5.1 接口

```
POST /api/admin/import/url        （ADMIN_TOKEN；朋友入口留到期 2 之后，用邀请码）
{ "url": "https://…/book.epub", "filename": "可选，缺省取 URL basename",
  "credit": "可选", "licenseBasis": "public-domain|authorized|user-declared" }
→ 200 { ok:true, title, author, format, size, leafName, coverUrl }
→ 409 { error:"already-exists", existing:{…} }   ← 沿用现有错误体，前端可复用
→ 415 { error:"unsupported-format", ext, allowed }
→ 413 { error:"file-too-large", maxBytes }
→ 422 { error:"would-be-internal" }              ← SSRF 拒绝
```

**为什么先只给管理员**：这一步是「把任意 URL 的内容写进公开书库」，等于把 SSRF 和
版权风险各开一个口。朋友入口必须等邀请码 + `inbox` 隔离都就位（期 2）再开。

### 5.2 SSRF 防护（这里必须诚实）

Workers 运行时**没有 DNS 解析 API**，无法在 `fetch` 之前把域名解析成 IP 再判断内网。
所以做不到教科书式的完整防护。可行的组合是：

| 措施 | 做法 |
|---|---|
| 协议 | 只允许 `http:` / `https:` |
| 拒绝 IP 字面量 | URL host 匹配 IPv4/IPv6 字面量即拒（正则即可，不需要解析） |
| 拒绝内网后缀 | `.local` `.internal` `.localhost` `.lan` `.home.arpa` 及裸 `localhost` |
| 手动跟随重定向 | `redirect: 'manual'`，最多 3 跳，**每一跳重新做上面三条检查** |
| 体积 | 有 `Content-Length` 先判；无则流式计数，超 `UPLOAD_MAX_BYTES` 中断 |
| 超时 | `AbortController` 25 s（Worker 无硬超时，但客户端 100 s 会断） |
| 类型 | `ALLOWED_UPLOAD_FORMATS` + **magic-byte 校验**（别信扩展名；`kind-sniff.ts` 可扩一个 `sniffMagic`） |
| 白名单（可选） | `IMPORT_URL_ALLOWLIST` 环境变量，配了就只允许这些域；**比黑名单可靠** |

> 局限写进注释：这三条挡不住「公网域名解析到内网 IP」的 DNS rebinding。
> 缓解手段是**默认关闭朋友入口**，管理员手动导入时自己看 URL。
> 不要假装这条已经解决。

### 5.3 配额

1 本 = 1 次 `fetch` + 1 次 `put` + 1 次 `head` + ≤1 次 `get`（EPUB 解析）+ ≤1 次 cover `put`
+ ~2 次 D1 + ≤20 次 `cache.delete`。**总计 ≈ 1 Worker 请求**（Cache API 调用不额外计入请求配额，
按仓库现有说法计入 50 次/请求上限——`handleUploadComplete` 已经是这个量级，实测可行）。

导入 300 本/天（`DAILY_WRITE_QUOTA` 默认值）≈ 300 请求 = **日配额的 0.3%**。可以忽略。

### 5.4 测试（`test/import-url.test.ts`）

- 内网 IP 字面量（`127.0.0.1` / `169.254.169.254` / `[::1]` / `10.0.0.1`）→ 422，且**断言 fetch 未被调用**
- 重定向到内网 → 422
- 超过 3 跳 → 422
- `Content-Type: text/html` 的 200 响应 → 415
- 无 `Content-Length` 的超大流 → 中断并 413
- 同名书 → 409，且暂存对象被删（不留垃圾）
- 正常 EPUB → 201/200，且 `source_kind='url'`、`license_basis` 落库

---

## 6. 期 2：D. 公版中文种子库（冷启动最快见效）

### 6.1 形态：本机脚本 + S3 直传，**0 次 Worker 请求**

```
scripts/seed-public-domain.mjs
  seed/manifest.yaml      ← 人工维护：书名/作者/卒年/来源 URL/授权依据/sha256
  ↓ 逐本下载（本机，不限 CPU）→ 校验 sha256 → rclone/S3 直传 R2（books/<id>/<书名>）
  ↓ 产出 seed/result.json（每本的 r2_key / size / 元数据）
  ↓ POST /api/admin/import/manifest   每批 ≤16 行，只写 D1、不搬字节
```

`reindex` 不能用，因为它带不了 `license_basis` 与 `source_kind`。所以新增
`POST /api/admin/import/manifest`：校验 R2 对象存在（`head`，每批 ≤16 与
`MAX_BACKFILL_LIMIT` 同一量级，理由见 `src/api/admin.ts` 的注释）→ 走 `ingestBook`
的**登记分支**（不重搬字节）。

### 6.2 合法源清单

| 源 | 协议 | 中文内容 | 备注 |
|---|---|---|---|
| 中文维基文库 | MediaWiki API | 古籍/民国文献 | 逐页取 wikitext 或导出 EPUB，需自己转 |
| ctext.org（中国哲学书电子化计划） | 官方 API | 先秦典籍 | 有 API key 申请 |
| Project Gutenberg | OPDS | 少量中文译本 | 7 万+ 英文公版，OPDS 分页成熟 |
| Standard Ebooks | OPDS | 无 | 排版质量最高，适合当「样板书」 |
| Internet Archive | advancedsearch + item API | 民国期刊/扫描件 | 有 PDF/CBZ，体量大要挑 |
| 书格（shuge.org） | 网页 | 公版扫描 PDF | 需脚本化，无 API |
| Digital Comic Museum / Comic Book Plus | 网页 | 无中文 | 美国黄金时代公版漫画，CBZ 可直接用 |

### 6.3 公版判定的硬规则（必须写进 manifest 校验）

- 中国大陆：自然人作品 = **作者终生 + 死后 50 年**（至第 50 年 12 月 31 日）；
  法人作品 = 首次发表后 50 年。
- 所以可用的民国通俗小说：**张恨水**（1967 卒 → 2017 公版）、**还珠楼主**（1961 → 2011）、
  **平江不肖生**（1957 → 2007）、**鲁迅**（1936 → 1986）、**老舍**（1966 → 2016）。
- 不可用：**金庸**（2018 卒 → 2068）、以及全部当代网文。
- 校验脚本对每题检查「卒年 + 50 ≤ 今年」，不通过直接拒，**不给人肉放行的选项**。
- 译本单独算（译者另有 50 年）——manifest 里译本必须填译者卒年。

### 6.4 体量与目标

EPUB 平均 1.5 MB → **1500 本 ≈ 2.2 GB**，占 10 GB 的 22%，留足余量给朋友上传。
建议首批 800 本中文公版 + 400 本英文经典，够把「按作者/按书名」两个集合填满。

---

## 7. 期 3：B. OPDS 源同步

### 7.1 分页是硬约束，不是优化

Workers Free **50 子请求/请求**。一个 feed 页最多 20 条，每本 1 `fetch` + 1 `put`，
再加 D1 与缓存失效 → **每批 15 本**才安全。所以协议设计成「一次拉一页，返回游标」：

```
POST /api/admin/opds/sync
{ "sourceId": "gutenberg-zh", "limit": 15, "cursor": "可选" }
→ { "imported": 12, "skipped": 3, "next": "…", "done": false }
```

前端或本机脚本循环调用，直到 `done:true`。**Worker 内不做循环**——
这正是「爬虫不适合 Worker」的同一条约束，只是这里它是良性的（分页可中断、可重入）。

### 7.2 数据模型

```sql
CREATE TABLE opds_sources (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  url           TEXT NOT NULL UNIQUE,     -- feed 入口
  kind          TEXT NOT NULL,            -- public-domain | self-hosted
  license_basis TEXT NOT NULL,            -- 必填，不给默认值
  auth_env      TEXT,                     -- 存**环境变量名**，不存密钥本身
  enabled       INTEGER NOT NULL DEFAULT 1,
  cursor        TEXT,
  last_sync_at  TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE opds_entries (
  source_id     TEXT NOT NULL,
  entry_id      TEXT NOT NULL,            -- Atom <id> 或 acquisition URL 的 sha256
  title         TEXT,
  author        TEXT,
  acquisition   TEXT NOT NULL,
  updated_at    TEXT,
  imported_book TEXT,                     -- books.id，NULL = 跳过/冲突
  PRIMARY KEY (source_id, entry_id)
);
```

**密钥不进 D1**：`auth_env` 只存变量名（如 `KAVITA_TOKEN`），值从 `env` 读。
理由和 `TICKET_SECRET` 的回落链一样——密钥落库就等于多一个泄露面。

### 7.3 去重与冲突

- 一级：`(source_id, entry_id)` 唯一键，重复同步天然幂等。
- 二级：`books.sha256`——**同一个文件从两个源来**只入库一次（`tombstones` 同理拦截）。
- 三级：`leaf_name` 冲突 → 自动改名 `书名 [源名].epub`，而不是跳过。
  理由：公版源之间同名书（《论语》）极多，跳过会让源看起来「同步失败」。

### 7.4 配额（3000 本全量首同步）

| 项 | 消耗 | 占免费额度 |
|---|---|---|
| Worker 请求 | ~6000 | **6%** |
| D1 行写 | ~1.5 万 | 15% |
| R2 Class A | ~6000 | 0.6%（月度） |
| R2 存储 | ~4.5 GB | 45% |

**结论：可行，但必须分页、分天或分批。** 一次性拉 3000 本会把当天剩下的写入额度
（`DAILY_WRITE_QUOTA` 与 D1 10 万行/天）吃掉一大半，朋友上传会被误伤。

---

## 8. 期 4：C. 联邦式远程源（可选，最后一个做）

把自有 Calibre-Web / Komga / Kavita / Stump 挂成「远程集合」：**元数据进 D1，字节不搬**。

- **redirect 模式**：`/dav/远程/<源>/…` 的叶子返回 302 直连源站。
  只适用于**匿名可读**的源（公版站点）。0 请求、0 存储。
- **proxy 模式**：Worker 反代，把源站 key 加在服务端。字节过 Worker，
  1 文件 = 1 请求。
- ⚠️ **不要做 OPDS-PSE 流式分页**：一本 100 页漫画在 KOReader 里 = 100+ 请求/次阅读，
  20 本就把日额度打穿。漫画只做「整本 CBZ 直连」或「一次性镜像入库」。

**结论**：C 的价值在「漫画不用进 R2」，但只有 redirect 模式成立时才有价值。
如果只有 proxy 模式，它比「用 rclone 镜像进来」更贵。所以 C 放最后，且要先证明
目标源支持匿名访问。

---

## 9. 汇总：请求与存储预算

| 动作 | Worker 请求 | R2 存储 | 判定 |
|---|---|---|---|
| URL 导入 1 本 | 1 | ~1.5 MB | ✅ |
| seed 1500 本 | **0** | ~2.2 GB | ✅ |
| OPDS 3000 本首同步 | ~6000 | ~4.5 GB | ✅（分批） |
| 远程源 redirect | 0 | 0 | ✅ |
| 远程源 proxy 流式漫画 | 100+/本 | 0 | ❌ |
| 站内爬虫抓 1 本 300 章小说 | 300+ | 1.5 MB | ❌ |

---

## 10. 安全与合规检查清单（每期上线前逐条打勾）

- [ ] 新入口走 `hasAdminToken` 或邀请码，且**未配置 token 时返回 404**（沿用 `handleAdmin` 语义）
- [ ] 所有写入走 `guardWrite`，配额与现有上传共用 `DAILY_WRITE_QUOTA`
- [ ] 扩展名白名单用 `isAllowedUploadExt`，**不新建第二份白名单**
- [ ] `Content-Type` 只按扩展名推导（`safeContentTypeFor`），**绝不信上游声明的类型**
- [ ] magic-byte 校验在入库前，不通过就删暂存对象
- [ ] 墓碑检查（`isTombstoned`）在搬字节**之前**，避免白搬
- [ ] `license_basis` 缺失 → 落 `inbox`，不自动上架
- [ ] 导入来源写进 `books.source_*`，`/admin` 可筛选
- [ ] 缓存失效走 `bookCacheTargets`，漏一条就有一条入口显示旧列表
- [ ] README 与 `docs/DEPLOY.md` 补「合规」段落：来源声明、举报入口、下架流程

---

## 11. 分期验收（DoD）

| 期 | 交付 | 验收 |
|---|---|---|
| 0 | `src/lib/ingest.ts` + 迁移 0009 + `complete` 改调 | 现有测试**零改动**全绿；`typecheck` 通过 |
| 1 | `/api/admin/import/url` + 上传页「从网址导入」输入框 | `import-url.test.ts` 全绿 + 真机导入 3 本（EPUB/PDF/CBZ） |
| 2 | `scripts/seed-public-domain.mjs` + `/api/admin/import/manifest` | manifest 校验拒绝金庸；导入 20 本后 `rebucket?sniff=1` 不改变结果 |
| 3 | `/api/admin/opds/sync` + `/admin` 源管理页 | 对 Gutenberg 实拉 100 本；重复同步 0 新增（幂等） |
| 4 | `/dav/远程/` 集合 | 一台真实 Komga 匿名源；KOReader 打开一本 CBZ |

每期额外共通项：`node scripts/budget.mjs` 增加对应建模项；新增探针脚本
`scripts/import-probe.mjs`（线上一致性，防止「本地通、线上 404」那类历史问题）。

---

## 12. 风险登记

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| SSRF 防护不完整（无 DNS 解析） | 中 | 高 | 管理端先用 + 白名单可选 + 朋友入口延后 |
| 期 0 重构引入回归 | 中 | 高 | 零测试改动作为硬门槛 |
| 公版判定出错（译本/法人作品） | 中 | 中 | manifest 机器校验 + 人工复核双签 |
| OPDS 源改版导致同步失败 | 高 | 低 | 每源独立游标，失败只影响该源 |
| 朋友入口被刷爆配额 | 中 | 高 | 邀请码 + 300/日 + `inbox` 隔离 + 计数告警 |
| 免费层额度被 seed 打满 | 低 | 中 | seed 走 S3（0 请求）；D1 写入分批 |

---

## 附：与写作工作台的关系

本设计的 D 路线（公版种子库）顺带解决了写作侧的语料问题：民国通俗小说与古籍
正好是「拆书/参考」的合法素材，且 `novel_reference_source` 的
`basisKind: checkable-license` 能直接承接本设计的 `license_basis` 字段。
两边共用一套「来源可查、依据可证」的约定，不必各写一套。

---

## 13. 实现记录（2026-10-23）

### 13.1 期 0：入库管道的唯一化

| 改动 | 文件 |
|---|---|
| 新增唯一的入库管道（搬键 → EPUB 解析 → 封面 → 嗅探 → 补作者 → upsert → 分桶 → 两层缓存失效） | `src/lib/ingest.ts` |
| `handleUploadComplete` 改为「三件上传特有的事 + 调管道」，约 260 行内联逻辑移出 | `src/api/upload.ts` |
| 书源六列 + 两个索引 | `migrations/0009_source_ingest.sql` |
| `upsertBook` 支持来源字段，覆盖写入时用 COALESCE 保护首次来源 | `src/lib/db.ts` |
| `purgeCreditCache` 从 `api/requests.ts` 移到 `lib/cache.ts`（lib 不反向依赖 api），原文件保留同名转出 | `src/lib/cache.ts`、`src/api/requests.ts` |

**验收结果**：`npm run typecheck` 通过；`npm test` **714 项全绿**（基线 681 + 新增 33）。

**唯一两处测试改动**：`test/download-direct.test.ts` 里的两份**源码位置清单**
（`r2HttpMetadata` 调用点、封面写入点）从 `api/upload.ts` 改成 `lib/ingest.ts`。
这两条断言的是「代码落在哪个文件」，不是行为；行为断言一条没动。
其余 679 项基线测试**零改动**通过。

### 13.2 期 1：URL 导入

| 改动 | 文件 |
|---|---|
| `POST /api/admin/import/url`：内网/后缀/协议/凭据校验、手动跟随重定向且每跳复检、可选域名白名单、体积与魔数校验、流式落 R2 | `src/api/import-url.ts` |
| 路由接入管理员鉴权 | `src/api/admin.ts` |
| `IMPORT_URL_ALLOWLIST` 环境变量 | `src/config.ts` |
| 33 项测试（含「内网地址必须在 fetch 之前被拒」「重定向到内网只请求第一跳」「HTML 错误页不入库」「魔数不符清理暂存」） | `test/import-url.test.ts` |

### 13.3 与设计稿的两处偏差（都是实现中被事实纠正的）

1. **R2 的流式写入需要已知长度，所以用了 multipart。**
   设计时假定 `BUCKET.put(key, upstream.body)` 可以直接吃上游流。实测报错：
   `Provided readable stream must have a known length`。最终实现是
   `createMultipartUpload` + 8 MiB 分片 + 边写边计数：不需要预先知道总长度，
   超限时中断且不落对象，内存只占一个分片（不把整本书读进 128 MB 的 isolate）。
   代价是一本书多 2 个子请求（create + complete），仍在 50 之内。
2. **期 1 的上传页输入框暂缓。**
   端点只认 `ADMIN_TOKEN`，而上传页是给匿名访客的 —— 在那儿放入口等于放一个
   所有人都点不通的按钮。UI 与「朋友入口」一起做：需要先有邀请码 + `inbox` 隔离
   （§3），否则就是给公开书库开一个无人看守的写入口。

另有一条**有意保留**的行为：管理员导入同样走 `guardWrite`，
默认 300 本/日。管理员身份不是无限写的许可证；批量导入（期 2/3）需要单独配额时
再讨论，不在这一期偷偷开口子。

### 13.4 期 2 开工前需要作者拍板的两件事

1. **首批名单**：建议 800 本中文公版 + 400 本英文经典。中文这批要不要先出一份
   100 本的候选清单（作者 + 卒年 + 来源 + 授权依据）过目？
2. **入库路径**：走 S3 直传（0 次 Worker 请求，但要 `R2_ACCESS_KEY` 与你自己的
   机器跑脚本），还是先小批量走 `import/url`（每本 1 次请求，可在 Workers 里直接跑完）？
   前者适合一次性铺底，后者适合零散补书 —— 两者可以并存。

### 13.5 期 2：公版种子库工具链

| 改动 | 文件 |
|---|---|
| 清单契约与流水线（采集 → 生成 EPUB → S3 直传 → 登记） | `seed/README.md` |
| 采集脚本·卷级（交付路线：一个页面 = 一卷，几分钟出 800 条） | `scripts/seed/harvest-volumes.mjs` |
| 采集脚本·整本（实验：分类递归 + 子页发现 + Wikidata 卒年；限速下数小时） | `scripts/seed/harvest.mjs` |
| EPUB 生成脚本（已渲染 HTML → EPUB 3，零依赖手写 ZIP） | `scripts/seed/build-epub.mjs` |
| 登记脚本（`--dry-run` 校验本地一致性；正式跑按批 8 本 + 收尾打缓存） | `scripts/seed/register.mjs` |
| 登记端点：只接受 `books/<id>/<书名>` 自洽键、head 验存、每批 ≤8 本 | `src/api/import-manifest.ts` |
| 10 项测试（键不自洽/对象缺失/unknown 授权/同名不同 id/批量上限/幂等） | `test/import-manifest.test.ts` |

为什么把「采集 / 生成 / 上传 / 登记」拆成四步而不是一个脚本：
前两步在本机跑（不限 CPU、不占配额），第三步走 S3（0 次 Worker 请求），
第四步才进 Worker（一本一次 D1 写入）。合并成一个脚本就会把 800 次
`put` 和 800 次 `fetch` 都塞进 Worker —— 那正是设计稿 §2 拒绝的形态。

**路线调整（2026-10-23 深夜）**：整本路线在当前限速下需要十几小时，
本轮改为**卷级路线**（《全唐詩·卷001》这样的一卷一本）：清单几分钟出齐，
800 本 EPUB 约半小时生成。授权依据从「作者卒年」改为「总集成书年代 + 编者卒年」，
逐条写进 `licenseNote`，仍然可核对。

**仍未完成（需要用户侧条件）**：真正的 800 本入库需要
① 本机 `build-epub --all` 跑完 ② R2 凭据供 rclone 直传 ③ 站点 `ADMIN_TOKEN`。
本工作区没有真实 R2 凭据（`.dev.vars` 里是联调占位值），所以字节没有推上去。
