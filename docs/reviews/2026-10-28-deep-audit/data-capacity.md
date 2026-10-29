# 数据一致性与容量审查（只读）

- **仓库 / HEAD**：`webooks` @ `7911d40`
- **审查日期**：2026-10-28
- **审查员**：data-auditor（共享任务板 task-6）
- **范围**：`src/lib/{db,cache,ingest,throttle}.ts`、`src/api/{upload,admin,import-url,import-manifest,requests}.ts`、`src/webdav/{index,propfind}.ts`、`migrations/*.sql`、`scripts/budget.mjs`、`scripts/seed/register.mjs`
- **方法**：静态通读 + `npm run budget`（纯 Node）+ **只 SELECT** 的本地 D1 查询 + 平台限额查官方文档
- **未做**：未改任何源码/迁移、未执行任何写入 SQL、未做 git 写操作、未跑 `npm run check`、未起 dev server

---

## 0. 结论摘要

| 项 | 结果 |
|---|---|
| 缓存失效矩阵 | 14 条写路径 × 7 列，**40 个「未失效」格**，归并后 **13 条根因缺口**（G1–G13） |
| 发现计数 | **严重 4 · 中 10 · 低 6**（共 20 条；只报未修/新发现，已修项见 §4.4） |
| 最危险的一条 | 集合 `DELETE`（`/dav/最近收录/`）在 800 本时**必然**撞 50 次子请求上限：D1 行已全删、R2 只删掉约 16 本、计数不重建、缓存不失效 |
| 次危险 | admin 批量删除 **约 7 本**就撞同一上限 → 缓存失效整段被跳过（历史 bug「删掉的书还在」的原形状） |
| 数据一致性 | 本地 dev 库实测 `books=16 / buckets=26`（**+10，+62.5%**），出现「/按书名/L/ 显示 7 本、点进去 0 本」的幽灵桶 |
| 配额（800 本、2 次同步/天） | 请求 **12.3%**（余 8.1×）、D1 行读 **9.5%**（余 10.5×）、忙日 3× **37.0%** —— 读路径余量充裕；**写路径的子请求预算不在模型里，而本轮 4 条严重级全在写路径** |
| budget 模型是否成立 | 读路径成立且偏保守（目录数高估 ~2.2×）；**写路径不成立**（模型完全不含 50 次子请求/10ms CPU 的写侧约束） |

---

## 1. 平台约束（本次据官方文档复核，不是引用项目注释）

`https://developers.cloudflare.com/workers/platform/limits/`（Last updated 2026-10-12）：

| 限额 | Workers Free |
|---|---|
| CPU/请求 | **10 ms** |
| 子请求/请求 | **50**（`fetch` 与对 R2/`D1`/KV 的调用都算） |
| Cache API `put/match/delete` 每次请求 | **50**，官方原文：*"This shares the same quota as subrequests (`fetch()`)"* |
| 内存 | 128 MB |
| 请求/天 | 100,000（UTC 0 点重置，超限 Error 1027） |

两条与项目注释一致、但**比注释更严**的事实：

1. Cache API 与子请求**共用同一个 50 的池**（`docs/review-2026-10-13.md:169` 也已记录）。所以「14 次 cache.delete 远低于上限」只有在同一请求没有其它 R2/D1 调用时才成立。
2. `db.batch()` **是事务**。`https://developers.cloudflare.com/d1/worker-api/d1-database/` 原文：*"Batched statements are SQL transactions. If a statement in the sequence fails, then an error is returned for that specific statement, and it aborts or rolls back the entire sequence."*
   → 任务描述里「D1 事务边界（batch 非原子）」这个假设**不成立**：`adjustBuckets`（1 个 batch）与 `rebuildBuckets`（1 个 batch）内部都是原子的。真正的原子性缺口在**两次独立调用之间**（`upsertBook` → `adjustBuckets`）和 `deleteBooksInBucket` 的**分页循环**（每页一次独立提交），见 §4.2。

---

## 2. 写路径 × 缓存失效矩阵

图例：`✅` 已失效 · `❌` **未失效（缺口）** · `⚠️` 部分失效 / 有条件 · `—` 不适用或有意不做

列含义：
- **叶子 d0**：`entriesCacheKey(path, 0)`，客户端用它判断「文件在不在」；命中时 `propfind.ts:566-578` 直接回缓存。
- **列表 d1**：桶/集合层（`/按书名/A/`、`/最近收录/`、`/` 等）depth 1。
- **分页 d1**：**分页目录本身**的键（`/最近收录/2/`、`/按格式/epub/2/`）。`canonicalDavPath` 有意保留它（`test/units.test.ts:217-229`），因此它是**独立于列表页的另一个键**。
- **榜单**：`/api/credits`（`cache.ts:99-121`，TTL 1h，内容含 credit 计数 + 最新上架那本）。
- **求书墙**：`/api/requests`（TTL 60s）。**所有写路径都不失效，这是 `api/requests.ts:52-56` 明文记录的取舍**，故列全 `—`，不计入缺口。
- **buckets**：`adjustBuckets` 增量 / `rebuildBuckets` 全量。
- **R2**：文件/封面对象是否留下孤儿。

| # | 写路径（入口） | 叶子 d0 | 列表 d1 | 分页 d1 | 榜单 | 求书墙 | buckets | R2 孤儿 | 缺口 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | WebDAV **PUT 新书** `webdav/index.ts:967` | ✅ | ✅ | ❌ | ❌ | — | ✅ `adjust` | ✅ | G1 G2 |
| 2 | WebDAV **PUT 覆盖**（分桶可能变）`:967` | ⚠️ 新✅/旧❌ | ⚠️ 新桶✅/旧桶❌ | ❌ | ❌ | — | ✅ | ⚠️ 旧封面 | G1 G2 G3 |
| 3 | WebDAV **DELETE 叶子** `:1277` | ✅ | ✅ | ❌ | ✅ | — | ✅ | ✅ | G1 |
| 4 | WebDAV **DELETE 集合**（nav/list）`:1379` | ❌ | ❌ | ❌ | ✅ | — | ✅ `rebuild` | ❌ | G1 G4 |
| 5 | WebDAV **MOVE** `:493` | ⚠️ 目标✅/**源❌** | ⚠️ 目标✅/**源❌** | ❌ | ❌ | — | ✅ `rebuild` | ❌ 源封面 | G1 G6 |
| 6 | WebDAV **COPY** `:493` | ✅ | ✅ | ❌ | ❌ | — | ✅ `rebuild` | ❌ 目标无封面 | G1 G7 |
| 7 | 网页上传 **complete** → `ingestBook` `lib/ingest.ts:160` | ✅ | ✅ | ❌ | ✅ | — | ✅ `adjust` | ✅ | G1 |
| 8 | admin **delete**（批量）`api/admin.ts:258` | ❌ | ⚠️ 缺「按类型」 | ❌ | ⚠️ 预算击穿时不打 | — | ✅ `rebuild` | ✅ | G1 G8 G9 |
| 9 | admin **update**（title/author/kind）`admin.ts:166` | ❌ | ❌ | ❌ | — | — | ✅ `adjust` | — | G1 G10 |
| 10 | admin **rebucket** `admin.ts:404` | ❌ | ❌ | ❌ | — | — | ✅ `rebuild` | — | G1 G10 |
| 11 | admin **reindex** `admin.ts:547` | ❌ | ❌ | ❌ | ❌ | — | ⚠️ 仅 `!truncated` | — | G1 G11 |
| 12 | admin **migrate-keys** `admin.ts:813` | ✅ | ✅ | ❌ | ✅ | — | — | ⚠️ 旧键删除失败时 | G1 G12 |
| 13 | admin **import/manifest** `api/import-manifest.ts:78` | ❌ | ❌ | ❌ | ✅ | — | ✅ `adjust` | — | G1 G13 |
| 14 | admin **import/url** → `ingestBook` `api/import-url.ts:431` | ✅ | ✅ | ❌ | ✅ | — | ✅ `adjust` | ✅ | G1 |

**统计**：`❌` 共 **40 格**；按根因归并为 **13 条缺口**：

| 编号 | 缺口 | 涉及格数 |
|---|---|---|
| G1 | **分页目录键永不在 `bookCacheTargets` 里**（`cache.ts:65-96` 只生成 14 个键，无 `/2/`、`/3/`…）→ 影响全部 14 条写路径 | 14 |
| G2 | WebDAV PUT 新书/覆盖从不打榜单 | 2 |
| G3 | PUT 覆盖只失效**新**身份，旧桶列表与旧叶子留脏 | 2 |
| G4 | 集合 DELETE 只打 `['/',1]` + `['/<集合>/',1]` 两个键 | 2 |
| G5 | 集合 DELETE 的 R2 删除循环无视 50 次上限（半删） | 1 |
| G6 | MOVE 源路径（5 条叶子 + 5 个列表）0 失效 + 榜单不打 + 源封面成孤儿 | 4 |
| G7 | COPY 不打榜单；不复制封面 | 2 |
| G8 | admin delete 缺 depth-0 叶子、缺「按类型」列表 | 2 |
| G9 | admin delete 的失效段被 50 次上限击穿 | 1 |
| G10 | admin update / rebucket 只打到导航层（6 个键），桶列表与叶子全留脏 | 5 |
| G11 | reindex 一个缓存键都不打 | 3 |
| G12 | migrate-keys 的失效预算是 14×N，N≥3 必超上限；且第二次运行 `migrated=0` 永不失效 | 0（预算型，不在格内） |
| G13 | import/manifest 条目/列表全不失效，且"由 register.mjs 打根路径"只覆盖 5 个导航 | 2 |

---

## 3. 发现（按严重度）

### 3.1 严重（4 条）

#### S1 · 集合 DELETE 在 800 本时必然半删，且元数据不可恢复
- **位置**：`src/webdav/index.ts:1462-1488`（`deleteBooksInBucket` → R2 循环 → `rebuildBuckets` → `purgeEntries`）
- **现象**：先 `deleteBooksInBucket()` 把整桶 D1 行删完（800 本 = 8 页 × 2 次 D1 调用），再进 `for (const b of removed) { BUCKET.delete(r2_key); BUCKET.delete(cover_key) }`。子请求预算在进循环前已用掉约 18 次（`listBooksInBucket` 1 + `allLiveLocks` 1 + 删除循环 16），剩 ~32 次 → **只能删掉约 16 本 R2 对象**就抛 `Too many subrequests`。此时：`rebuildBuckets`（`:1467`）没跑、`purgeEntries`（`:1482`）没跑、`purgeCreditCache`（`:1487`）没跑、`releaseLocks*`（`:1478-1479`）没跑。
- **影响**：① 800 行 D1 已不可逆删除，其中 `source_url` / `license_basis` / `credit` / `title`（EPUB 内解析出的）**无法从 R2 重建**（`reindex` 只能按文件名猜，且会生成 `r2-<sha>` 新 id）；② ~784 个 R2 对象成孤儿（当前种子库均值 19 KB/本，约 15 MB，不是空间问题，是**数据面已删、对象面还在**的不可对账状态）；③ buckets 停在旧值 → 导航大面积幽灵桶；④ 缓存仍返回已删书的 207；⑤ 客户端收到 500，无法知道删到哪本。
- **建议**：把「删 D1 行」与「删 R2 对象」拆成两个阶段并让第二阶段可恢复 —— 最小改动是**先把待删清单落库/返回**，R2 删除改成分页（每次 ≤15 本）+ 客户端/管理员续跑；或直接改成「只删 D1 + 打 tombstone，R2 对象交给一个带游标的 cleanup 端点」（`migrate-keys?cleanup=1` 已有该形状可复用）。重排顺序：`purgeEntries` + `rebuildBuckets` 必须在 R2 循环**之前**，保证中途失败时状态自洽。

#### S2 · 集合 DELETE 只失效 2 个键：被删成员的叶子/其它集合列表/分页目录全部留脏
- **位置**：`src/webdav/index.ts:1482-1485`
- **现象**：`purgeEntries([['/', 1], ['/<col>/', 1]])`。而删除 `/按格式/epub/` 会删掉 800 本书，这 800 本各自还挂在 `/按书名/*/`、`/按作者/Y/`、`/按类型/ebook/`、`/最近收录/` 下；这些列表与它们的 5 条叶子路径、以及所有分页目录键**一个都没打**。
- **影响**：TTL（300s，`config.ts:150`）内，客户端 PROPFIND 仍能列出并「看到」刚删干净的书 —— 与 2026-10-23 修掉的「complete 只失效榜单」是同一形状，只是这次是**批量删除**，影响面是整桶而不是一本。
- **建议**：集合删除走「整层失效」而不是逐书枚举：打 `['/','1']` + 5 个集合导航 + **被删成员涉及到的所有桶列表（去重后通常 ≤30 个）** + 分页目录前缀；或给 `cache.ts` 加 `purgeCollectionTree(collection)`（按 `buckets` 表枚举该集合现存桶 + 各桶页数，一次算清）。逐书 `bookCacheTargets` 在 800 本时是 11,200 个键，本身也不可能，必须改用「按桶」的粗粒度失效。

#### S3 · admin 批量删除约 7 本即撞 50 次上限，缓存失效整段被跳过
- **位置**：`src/api/admin.ts:266`（`slice(0, 200)`）→ `:273-278` 循环 → `:288` `rebuildBuckets` → `:295-304` `purgeEntries` → `:306` `purgeCreditCache`
- **算术**：`findBooksByLeafNames` 1 + 每本 2~3 次（R2 文件 + R2 封面 + D1 delete）+ `rebuildBuckets` 1 + 失效 `1 + 4N` 个 cache.delete + 榜单 1。带封面时 `7N + 4 > 50` → **N ≥ 7**；不带封面 `6N + 4 > 50` → N ≥ 8。而 UI 允许一次选 200 本。
- **影响**：从第 7~8 本起抛错。**已删的书其 R2 与 D1 都已删（不可逆），但 `purgeEntries` 一次都没执行** → 目录与叶子缓存继续显示已删的书（TTL 300s），`rebuildBuckets` 也可能没跑 → 计数漂移。管理员只看到一个 500，不知道删了几本、不知道要不要重试（重试会得到一堆 `missing`）。
- **建议**：把「失效」从「同步内联」改成**预算感知**：① 先算键数，超过 ~30 就只打集合级粗粒度（5 个导航 + 涉及桶 + 根）；② 分页删除（`limit ≤ 5`）并返回 `nextAfter` 让调用方续跑（`migrate-keys` 已有该形状）；③ 任何写路径的 `purgeEntries` 都应包一层 try/catch，**失效失败不能让已完成的删除变成 500** —— 目前 `purgeEntries` 抛出会把「删除成功」报成失败。

#### S4 · admin 批量删除的失效集合本身不全：缺 depth-0 叶子 + 缺「按类型」列表
- **位置**：`src/api/admin.ts:295-304`
- **现象**：`targets = ['/',1] + 每本 [title 桶, author 桶, format 桶, recent]`。**没有** `'/<type>/<kind>/'`，**没有**任何 depth 0 叶子键。
- **影响**：① `/按类型/ebook/` 列表在 TTL 内仍列出已删的书；② 5 条叶子路径的 depth-0 缓存仍是旧 JSON，PROPFIND 该路径返回 207「存在」→ 同步客户端据此判断「文件还在」，可能不再尝试删除/重传（这正是 10-23 修过的「删掉的书还在」）。`bookCacheTargets()` 本来一次就给全 14 个键，这里手写 4 个反而漏了。
- **建议**：直接用 `bookCacheTargets()` 生成（+ 去重），或抽出 `bookPurgeTargets()` 供 admin/WebDAV/ingest 三处共用，杜绝手写遗漏。注意与 S3 的预算问题一起修：改用粗粒度后再谈逐书。

### 3.2 中（10 条）

#### M1 · MOVE 的源路径完全没失效，且不打榜单
- **位置**：`src/webdav/index.ts:709-748`（源行在 `:722-725` 删除，失效只对 `targetLeafName` 做一次 `:741-748`）
- **影响**：MOVE 之后 TTL 内，源文件名在 5 个集合里的 5 条叶子仍返回 207（同步客户端会认为「旧文件还在，新文件是副本」→ 反复搬运）；源桶列表仍列出它；`/api/credits` 1 小时内仍按旧本数计（MOVE 删掉一本书，credit 计数变了）。
- **建议**：失效集合 = `bookCacheTargets(源身份)` ∪ `bookCacheTargets(目标身份)`（≤28 键，预算够），并 `purgeCreditCache()`（MOVE 改变了总本数）。

#### M2 · WebDAV PUT 从不让榜单失效；覆盖上传不失效旧身份
- **位置**：`src/webdav/index.ts:1212-1236`（upsert）/ `:1247-1259`（adjust）/ `:1263-1270`（只 `purgeEntries`，无 `purgeCreditCache`）；旧身份只在 `adjustBuckets` 里用了，缓存侧没用
- **影响**：① 匿名 PUT 是**最高频的写入口**，新书（`credit='雷锋'`）会让 `/api/credits` 的计数与「最近上架」变旧，最多 1 小时；首页首屏「活书脊」跟着旧。② 覆盖上传若算出不同的 `title/author/format`（如管理员改过 title 后再 PUT），旧桶列表仍列出该书。
- **建议**：`await purgeCreditCache()` 与 `bookCacheTargets(旧身份)` 一并加上（PUT 路径当前 14 个键，加 14 + 1 仍 < 50，但需与 S1/S3 的预算改造统一核查）。

#### M3 · admin update / rebucket 只打到导航层，桶列表与叶子全留脏
- **位置**：`src/api/admin.ts:246-249`（update）、`:524-527`（rebucket）—— 都是 `['/',1] + 5 个集合导航`
- **影响**：改一部书的 `title`（首字母 A→B）或 `kind`（ebook→comic）后：`/按书名/A/` 仍列出它、`/按书名/B/` 里没有它；`/按类型/` 两个桶的列表都不对；该书 5 条叶子的 ETag/displayname 仍旧。rebucket 的响应还写着「目录缓存已失效」（`:541-543`）——**过强的声明**，实际只失效了导航。
- **建议**：rebucket 是批量操作，应按「受影响的桶集合」做粗粒度失效（先 `SELECT DISTINCT` 出将变化的桶，再打那些深度 1 键）；update 是单本，直接用 `bookCacheTargets(旧) ∪ bookCacheTargets(新)`。

#### M4 · reindex 一个缓存键都不打
- **位置**：`src/api/admin.ts:608-628`（只有 `rebuildBuckets`，无 `purgeEntries` / `purgeCreditCache`）
- **影响**：reindex 把 R2 里的存量对象登记成书后，目录页与 WebDAV 在 TTL 内看不到它们；`/api/credits` 1 小时内不算它们。与 `import/manifest` 不同，这里连注释性的取舍说明都没有 —— 看起来是漏的而不是有意的（对照 `backfillDisposition:653-654` 明确写了「不需要清缓存」）。
- **建议**：至少 `purgeCreditCache()` + 5 个导航 + `['/',1]`；书多时按桶粗粒度。

#### M5 · migrate-keys 的失效预算 14×N 必超上限；第二次运行永远不会失效
- **位置**：`src/api/admin.ts:942-954`；预算常量在 `:54-62`（`MAX_BACKFILL_LIMIT = 16`，注释自己写着「1 + 3×16 = 49，刚好不越界」）
- **现象**：循环预算已经按 49 用完（`:208-215` 的注释同理），然后 `moved.flatMap(bookCacheTargets)` 再打 **14×N** 个 cache.delete。默认 `limit=10` → 140 次 → 必炸。炸了之后 D1 已更新、旧 R2 键已删，只有缓存没打。第二次运行全部 `alreadyReadable` → `migrated=0` → `if (apply && migrated > 0)` 不成立 → **再也没有机会打缓存**。
- **建议**：把失效与迁移解耦（`limit` 只控迁移，失效每次固定只打 ≤30 个粗粒度键）；或者把「本次搬过的书」记到一个 `pending_purge` 里由独立端点补打。顺带修正 `:54-62` 注释里的预算式（它现在自相矛盾）。

#### M6 · 分页目录缓存（生产环境至少 13 个键）在所有写路径下都无法失效
- **位置**：`src/lib/cache.ts:65-96`（`bookCacheTargets` 只有 14 个键，无分页层）+ `src/webdav/propfind.ts:484-501`（第 1 页把 `/2/`、`/3/`… 作为子集合列出）+ `test/units.test.ts:217-229`（确认 `/最近收录/2/` 是独立缓存键）
- **实测规模**：`seed/submit/manifest.json` 的 800 本全部 `author=佚名` → `authorBucket('佚名')='Y'` → **`/按作者/Y/` 一个桶 800 本 = 4 页**；全部 `epub` → `/按格式/epub/` 4 页；全部 → `/按类型/ebook/` 4 页；`/最近收录/` 4 页；`/按书名/Q/`（首字为「全」的 390 本，拼音 q）2 页。即 **≥13 个 `/N/` 目录键**，每个都可被 PROPFIND 缓存，且永远不会被任何写路径打到。
- **影响**：任何增/删书都会让分页边界移动，但 `/最近收录/2/`、`/按作者/Y/3/` 这类键在 300s 内继续返回旧条目 —— 表现为「第 2 页有一本已经不存在的书」或「新书在第 4 页看不到」。rclone 全库遍历会经过这些页，所以不是理论问题。
- **建议**：① `bookCacheTargets` 增加「该桶页数变化时打 `/N/`」——但更简单可靠的是给定 `PAGINATION_MAX` 上限时按桶打满 `2..PAGINATION_MAX` 太贵，所以建议 ②**分页目录不进缓存**（`propfind.ts` 里 `if (node.page > 1) 跳过 cache.put`），用「第 1 页永远是最新的」换取「第 2 页最多旧 300s」变成「第 2 页永远现算」；计算量是 1 + 200 行，本来就在预算内。

#### M7 · COPY 不打榜单、不复制封面；MOVE 丢人工 `kind` 标注
- **位置**：`src/webdav/index.ts:681-707`（`coverKey: null` 在 `:706`；`upsertBook` 未传 `kindBucket/kindSource`）
- **影响**：① COPY 出的新书没有封面（书卡空白），但源书有 —— 用户会以为复制坏了；② MOVE 到一个新名字时目标是**新行**，`kind_bucket` 由扩展名派生、`kind_source='derived'` → 管理员人工标成 comic 的扫描 PDF，MOVE 改名后变回 ebook（迁移 0006 想保护的正是这个值，只保护了「覆盖上传同 id」这一条路径）；③ COPY 新增一本书 → `/api/credits` 计数变旧 1 小时。
- **建议**：COPY/MOVE 继承 `coverKey`（对象可以复用同一个 `covers/<id>` 键，但要注意删除时的引用计数 —— 最简单是重新 `BUCKET.put` 一份 `covers/<新id>.<ext>`）+ 显式透传源行的 `kindBucket/kindSource`；COPY 结束调 `purgeCreditCache()`。

#### M8 · import/manifest 的「收尾由 register.mjs 打根路径」只覆盖 5 个导航，桶列表仍脏
- **位置**：`src/api/import-manifest.ts:25-30`（取舍声明）、`:118-120`（只 `purgeCreditCache`）；`scripts/seed/register.mjs:164-176`（`purgeRoots` 打 `COLLECTION_ROOTS`）
- **现象**：文档说的补救是「5 个集合根路径的 purge」。但 `/按书名/`（nav）只影响桶计数展示；真正列出书的 **桶列表** `/按书名/Q/`、`/按作者/Y/`、`/按格式/epub/` 不在 `COLLECTION_ROOTS` 里，分页目录更不在。800 本一次入库后，这些列表最长 300s 内仍是旧内容（对批量入库可接受），但**没有文档写清这一层的存在**，运维会以为已经清了。
- **补充风险**：`registerOne` 每本 4 次子请求（head / 查同名 / upsert / adjust）+ 1 次榜单 = 33，预算正确；但 `upsertBook` 里有 `idx_books_source` 唯一索引，同一 `sourceEntry` 第二次登记会抛约束错误，而 `handleImportManifest` 的循环**没有 try/catch**（`:108-116`）→ 整批 500，且前几本已提交、重试时永远卡在同一条毒条目上。当前 800 条 manifest 实测 `sourceUrl` 无重复（0 条），所以是潜在风险而非现存故障。
- **建议**：① 在 `import-manifest.ts` 的注释与 `register.mjs` 的输出里明确「桶列表/分页目录最多旧 5 分钟」；② 给 `registerOne` 包 try/catch，把 D1 错误降级为单条 `rejected`，保住「任何一条失败不影响整批」的承诺。

#### M9 · `ON CONFLICT(id)` 与 `leaf_name` 唯一索引不匹配：并发同名上传 / reindex 都会 500 并留孤儿
- **位置**：`src/lib/db.ts:406`（`ON CONFLICT(id) DO UPDATE`）+ `migrations/0001_init.sql`（`CREATE UNIQUE INDEX idx_books_leaf`）；调用点 `webdav/index.ts:1067-1074`、`admin.ts:584-605`
- **现象 A（并发）**：两个客户端同时 PUT 同名**新书** → 都 `findBookByLeaf` 得到 null（`webdav/index.ts:1031`）→ 各自生成不同 id → 第二个 INSERT 撞 `idx_books_leaf` → 未捕获异常 500，且它的对象已经写在 `books/<另一个id>/<name>`（`:1150`/`:1175`）→ **R2 孤儿**（单文件可达 100 MB）。
- **现象 B（reindex）**：reindex 的 id 是确定性 `r2-<sha20>`，若目标对象对应的书此前由 PUT/上传/种子登记创建（id 是 `shortId`/16 位 hex），`INSERT` 会先撞 `leaf_name` 唯一索引 → 整个 `db.batch` 回滚 → 500，reindex 对该前缀完全不可用（`admin.ts:615` 的 `rebuildBuckets` 也走不到）。
- **建议**：`upsertBookStatement` 增加第二种冲突处理（`INSERT ... ON CONFLICT(leaf_name) DO UPDATE`，或在 catch 到 `UNIQUE constraint failed: books.leaf_name` 时回查旧行并按旧 id 覆盖）；reindex 先按 `leaf_name` 查已有行、存在则复用其 id。同时在「对象已写、行未写」的路径上补 `BUCKET.delete` 回滚（目前 `ingest.ts` 有，PUT/reindex 没有）。

#### M10 · 覆盖上传会把已有封面清成 NULL
- **位置**：`src/lib/db.ts:446`（`cover_key = excluded.cover_key` 无条件覆盖）+ `webdav/index.ts:1141-1163`（`parseable` 不成立时 `coverKey` 恒为 `null`）
- **条件**：`parseable = isEpub && declared>0 && declared<=PARSE_SIZE_CAP(50MB)`。所以「覆盖上传一个 >50MB 的 EPUB」「chunked 无 Content-Length」「EPUB 解析失败」三者都会让 `cover_key` 被写成 NULL —— 而 R2 里的旧封面对象还在（`covers/<id>.<ext>` 未删）。
- **影响**：书卡封面凭空消失（且没有线索），R2 多一份无人引用的孤儿。这与 `:443-445` 注释里记录的「历史 bug：重传带封面的 EPUB，cover_key 始终保持旧值 null」是**反向的同一条**：现在是「解析不出就抹掉」。
- **建议**：`cover_key = COALESCE(excluded.cover_key, books.cover_key)`（只在新值非空时替换），并在替换/清空时删除旧 `covers/` 对象；与 `credit`/`source_*` 的 COALESCE 保护保持同一原则。

### 3.3 低（6 条）

#### L1 · 迁移 0005 加的 4 个 `*_status` 索引已无读者，变成纯写放大
- **位置**：`migrations/0005_query_plans.sql:76-79`（`idx_books_{title,author,format,kind}_status`）；当时的前提是 `adjustBuckets` 会跑 `SELECT COUNT(*) ... WHERE x=?`（`src/lib/db.ts:498` 的注释还这么写），但现在实现改成 `ON CONFLICT ... SET total = MAX(0, total + ?)`（`:529-535`），不再 COUNT。
- **影响**：全仓已无 `COUNT(*) WHERE title_letter=?` 形状的查询（仅 `rebuildBuckets` 的 GROUP BY 全表扫）。4 个死索引让每次 `books` INSERT 多写 4 行（`budget.mjs` 实测口径：插入 = 1 表行 + 每个索引 1 行）。在生产已应用 0009 的库上是 19 行/插入里的 4 行 = **21% 的 D1 写入是空转**。
- **建议**：新增迁移 drop 这 4 个索引（先确认生产 `EXPLAIN QUERY PLAN` 无依赖），并同步删除 `db.ts:498` 那段已失效的注释。

#### L2 · budget 的「22 行/上传」在 0009 之后应为 24；命中路径的 D1 读也没全建模
- **位置**：`scripts/budget.mjs:439-466`（`D1_ROWS_PER_UPLOAD = 22`，依据「15 个显式索引 + autoindex」实测 17 行）
- **现象**：本地 dev 库实测 `sqlite_master` 里 `books` 只有 **15 个显式索引**（缺 0009 的 `idx_books_source` / `idx_books_status_kind`）→ 「17 行」是**未应用 0009 的库**的数字。生产应用 0009 后是 17 个显式索引 + autoindex → 插入 19 行，上传合计 24 行。另：PROPFIND **缓存命中**时仍会跑一次 `allLiveLocks`（`propfind.ts:611-622`），模型里命中路径按 0 行读。
- **影响**：D1 写入占用从 0.44% 变 0.48%，D1 行读每天多几十行 —— **不影响任何结论**，但「实测数字」的口径需要标注，否则下次 review 会当成回归。
- **建议**：在 `budget.mjs` 的注释里标明该实测点的迁移版本；`D1_ROWS_PER_UPLOAD` 提供按索引数的推导公式。

#### L3 · import-url 的 200 MiB 上限与 50 次子请求预算不匹配，超限会留 `books/` 孤儿
- **位置**：`src/lib/ingest.ts:68`（`DEFAULT_MAX_BYTES = 200 MiB`）、`src/api/import-url.ts:122-214`（8 MiB/分片 multipart）、`ingest.ts:241-249`（搬键后暂存已删）
- **算术**（按 §1 的共用配额）：`fetch` 1 + throttle 2 + `createMultipartUpload` 1 + 分片 p + `complete` 1 + 魔数 `get` 1 + `ingestBook`（head 1 + 查同名 1 + get 1 + put 1 + delete 1 + epub get 1 + cover put 1 + upsert 1 + adjust 1 + 榜单 1 + 条目失效 14）≈ **31 + p**。p ≤ 19 → **约 152 MiB**；超出后分片循环抛错 → `putLimitedStream` 的 catch 会 abort + 删暂存（返回 502，可接受），但若越界发生在 `ingestBook` 内部（搬键已完成）则**异常直接冒泡，`books/<id>/<书名>` 对象留下、D1 无行**。
- **建议**：`UPLOAD_MAX_BYTES` 对 import-url 单独降至 128 MiB（并在错误体里说清是平台限额），或把「搬键 → 登记」改成先登记后搬键，失败时可用 `r2_key` 反查清理。

#### L4 · `registerOne` 无 try/catch：一条 D1 错误 = 整批 500 + 部分提交
- **位置**：`src/api/import-manifest.ts:108-116`
- **影响**：文件头承诺「任何校验失败都只影响这一本，不中断整批」，但那只覆盖校验；D1 异常（唯一索引冲突、`Too many subrequests`、超时）会直接冒泡，已登记的前几本已提交，重试时会得到 `existing`，而毒条目永远卡住。
- **建议**：`try { result = await registerOne(...) } catch (e) { rejected.push({ code: 'db-error' }) }`，并保留原有「单条失败不中断」的语义。

#### L5 · buckets 没有一致性校验，且 `MAX(0, ...)` 会吞掉负漂移
- **位置**：`src/lib/db.ts:533`（`SET total = MAX(0, total + ?)`）、`:509-545`；无任何「buckets vs books」对账端点（`admin stats` 只回 `listBucketTotals` 的**桶里的数**，不与 `books` 对比，`admin.ts:989-1010`）
- **影响**：任何一次「行已改、计数未改」（S1/S3 的中断点、`upsertBook` 与 `adjustBuckets` 之间的失败、手工 SQL）都会永久留在库里；`MAX(0,…)` 只保证不出现负数，不再报警。实测证据见 §4.1。
- **建议**：加一个只读端点 `GET /api/admin/buckets/verify`（返回 drift 列表，人看一眼再决定要不要 `rebuild`）；把 `MAX(0,…)` 的钳制次数计数并上报（钳制即代表已经漂移）。

#### L6 · `adminTotals` 每次全表 `COUNT(*) + SUM(size)`
- **位置**：`src/lib/db.ts:189-196`，调用点 `src/api/admin.ts:127-158`（每次 `/admin/books` 列表都调）
- **影响**：800 本 = 800 行读/次页面；5,000 本 = 5,000 行/次。管理员翻一页就扫一遍全表，且无缓存。相对 500 万/天不算致命，但它是纯冗余（`buckets` 的 `recent/all` 已经是总量）。
- **建议**：总数直接读 `buckets('recent','all')`（1 行），体积只在 `/admin/stats` 里算。

---

## 4. 数据一致性专项

### 4.1 buckets 漂移：本地 dev 库实测 +10（+62.5%），出现幽灵桶

只读查询（`SELECT` only）结果：

```
books(全部) = 16   books(published) = 16
buckets 各集合求和 = 26 / 26 / 26 / 26 / 26（title / author / type / format / recent）
```

逐桶 diff（`actual` 来自 `books`，`bucket_total` 来自 `buckets`）：

| collection | bucket | actual | bucket_total | drift |
|---|---|---|---|---|
| author | unknown | 1 | 11 | **+10** |
| format | epub | 12 | 22 | **+10** |
| type | ebook | 14 | 24 | **+10** |
| recent | all | 16 | 26 | **+10** |
| title | L | **0** | 7 | **+7（幽灵桶）** |
| title | Y | **0** | 1 | +1（幽灵桶） |
| title | H | 1 | 2 | +1 |
| title | S | 3 | 4 | +1 |

**读法**：有 10 本书的 `-1` 增量从未落盘（10 本都是 epub/ebook、作者 `佚名`→`Y`… 注意 `author/unknown` 说明当年是按 `unknown` 桶计的）。`/按书名/L/` 现在导航上显示「7 本」，点进去 0 本。
**根因**：dev 库里的成因无法从库内断言（可能是手工 SQL 或一次中途失败的批量删除）。但代码结构确认存在这个窗口：`deleteBook()` 与 `adjustBuckets()` 是两次独立提交（`webdav/index.ts:1322-1334`、`admin.ts:276/288`），中间任何异常/子请求超限都会留下「行没了、数还在」——这正是 S1/S3 描述的中断点。
**结论**：漂移不是理论风险，而是可复现的既有状态；且**没有任何检测手段**（见 L5）。

### 4.2 D1 事务边界（澄清任务的假设）

| 结构 | 事务性 | 风险 |
|---|---|---|
| `db.batch([...])`（`adjustBuckets:544`、`rebuildBuckets:660`、`reindex:610`） | **原子**（官方文档，§1） | 无部分写入；但一条失败整串回滚 → 计数完全不更新 |
| `upsertBook` → `adjustBuckets`（两次 await） | 两个事务 | 中间失败 = 行有、数无（正向漂移） |
| `deleteBook` → `adjustBuckets`（同上） | 两个事务 | 中间失败 = 行无、数有（§4.1 的形状） |
| `deleteBooksInBucket` 的分页循环（`db.ts:266-285`） | **每页一个事务** | 800 本 = 8 个事务；第 3 页失败 → 前 300 行已删且不可回滚 |
| `deleteBooksInBucket` + 调用方的 `rebuildBuckets` | 两个事务 | 之间失败 = 计数永远停在删除前 |

### 4.3 幂等与孤儿

| 路径 | 重跑行为 | 残留 |
|---|---|---|
| `ingestBook`（upload/import-url） | 同名 → 409（`ingest.ts:194-211`），暂存对象已删 | 无（但 >152 MiB 时见 L3） |
| `import/manifest` | 同 id → `existing`（`import-manifest.ts:199-202`） | 无 |
| `migrate-keys` | 幂等（`alreadyReadable`） | 旧键删除失败时留旧对象（`admin.ts:918-921` 有意「最后删」） |
| `reindex` | **不幂等**：确定性 id 撞 `leaf_name` 唯一索引（M9） | 对象在、行没有 |
| WebDAV PUT 并发同名 | 500 | `books/<另一 id>/<name>` 孤儿（M9-A） |
| 集合 DELETE / admin 批量删除 | — | 800 本时约 784 个孤儿对象（S1）；封面在 MOVE 后成孤儿（M7） |
| 覆盖上传未解析出封面 | — | 旧 `covers/<id>.<ext>` 孤儿 + `cover_key` 被清（M10） |

### 4.4 `upsertBook` 冲突分支的列完整性（任务点 1）

逐列核对了 `db.ts:400-465`：`INSERT` 29 列，`ON CONFLICT` 更新 24 列。未更新的只有 `id`（PK）与 `created_at`（**有意**：收录时间不该被覆盖上传改写）。`cover_key` 在 `:446` 已覆盖 —— **历史上漏列 cover_key 的那条已经修好**，本次不再重复报告。`credit` / `source_*` 都用 COALESCE 保护，`source_id`/`source_entry` 有意不保护（`:457-461` 理由成立）。**结论：无漏列。** 唯一问题是 `cover_key` 保护得「过头」了（无条件覆盖 → M10）。

---

## 5. 配额与容量

### 5.1 `npm run budget` 实测输出（本机 Node，未改脚本）

**A. 任务指定场景：800 本、每天 2 次全库同步**（`node scripts/budget.mjs --books 800`）

```
书库规模    800 本 · 2.5 MB/本 · 1.95 GB      目录总数 74 个
每日用量    300 浏览 · 300 首页（每次 2 请求）· 20 挂载 · 2 次全库同步 · 20 上传

Worker 请求/天     12,328 次   100,000   12.3%
D1 行读取/天      475,848 行  5,000,000    9.5%
D1 行写入/天       440.00 行    100,000    0.4%
R2 Class A/月       1,200 次  1,000,000    0.1%
R2 Class B/月     267,000 次 10,000,000    2.7%
R2 存储/月          1.95 GB     10.00 GB   19.5%

硬停瓶颈 Worker 请求/天（12.3% 已用）
忙日承受力 3× → 37.0%（✅ 忙日也在额度内）
最紧的硬停指标还有 8.1 倍余量，按 3× 忙日估算还有 2.7 倍
按当前用量（2 次全库同步/天）反推，免费层约能装 9,348 本书
```

**B. 脚本默认场景（5,000 本）作为对照**：请求 55,378（55.4%）、D1 读 712,398（14.2%）、忙日 3× → **166.1%（❌ 会打满）**。

请求分解（20 + 600 + 600 + 2,960 + 8,148 = 12,328）：
- 全库同步 `2 × (74 + 5×800) = 8,148` → **占总请求 66%**
- 挂载 `20 × 2 × 74 = 2,960`
- 浏览/首页 `600 + 600`
- 上传 `20`

### 5.2 在 800 本、2 次同步下「余量还有多少」

- **Worker 请求**：已用 12,328/天 → **余量 87,672 次/天（8.1 倍）**。其中同步本身占 8,148（8.1% 的额度）。把同步提到 4 次/天，总量变约 20,476 → 20.5%，仍安全。
- **D1 行读**：已用 475,848 → **余量 4,524,152 行/天（10.5 倍）**。同步相关约 37,748 行（`2×74×201` 的 PROPFIND 未命中 + `2×5×800` 的叶子 GET），占额度 0.75%。
- **D1 行写**：440 行/天，余量巨大；但注意 20 次上传是假设，`import/manifest` 一次 800 本 = 800×(19+5) ≈ 19,200 行写，**一次就吃掉 19% 的日写额度** —— 批量入库是写额度的唯一真实压力点，模型里没有这一项。
- **R2 存储**：模型按 2.5 MB/本算 1.95 GB。**实测** `seed/submit/manifest.json` 800 条合计 **15,418,300 B = 0.015 GB**（均值 18.8 KB、最大 70 KB、全部 epub）→ 真实占用 **0.15%** 而不是 19.5%，模型在这一项上**高估约 126 倍**。
- **承受力上限**：脚本给 **9,348 本**（2 次同步/天）= 从当前 800 本再涨 **约 3.5 次翻倍**（`log2(9348/800) ≈ 3.55`）。原因是同步请求与书量线性绑定：9,348 本时 `treeShape` 得目录 126 个，同步那一路 `2 × (126 + 5×9,348) = 93,732` 次，**单独占掉 93.7% 的日额度**，其余全部流量（浏览 600 + 首页 600 + 挂载 5,040 + 上传 20）只剩 6.3%。**换句话说，本库的请求上限由「rclone 按 5 条路径重复下载」这一件事单独决定。**

### 5.3 模型对**写路径**不成立（本次最重要的模型结论）

budget 模型只算**读**（浏览/挂载/同步/上传次数 × 每条读的行数），完全不建模：

| 未被建模的写侧成本 | 实测/推算 |
|---|---|
| 50 次子请求/请求的**写**侧占用 | 一次 `ingestBook` 约 30 次（含 14 次 cache.delete）；集合 DELETE 在 800 本时需要 1,600+ 次 → **预算爆炸，模型无感知** |
| 10 ms CPU | 模型完全没有这一项；大目录 PROPFIND 单响应 200 条目、`browse-page` 渲染 200 张书卡，都在这条线上，`docs/cloudflare-ebook-library-feasibility.md:523` 自己也把「大目录 PROPFIND 的真实 CPU」列为未验证 |
| `rebuildBuckets` 的全表成本 | 一次 = 5 条 GROUP BY × 800 行 ≈ 4,000 行读 + 100 行写；COPY 是**匿名**入口，单 IP 每天 300 次写节流 × 4,000 ≈ **120 万行读/天 = 24% 的 D1 日额度**（`webdav/index.ts:740` 每次 COPY/MOVE 都调用） |
| 批量入库的 D1 行写 | 800 本 ≈ 19,200 行写（上面 5.2） |

### 5.4 PROPFIND 的条目数与 CPU（800 本 + 分页后）

- 单响应条目上限 = `HARD_MAX_ENTRIES = 200`（`config.ts:94`）+ 1 个集合自身 → **201 条，不随书库增长**（这是分页的唯一价值）。`x-dav-entries` 响应头（`propfind.ts:635`）是现成的观测点。
- 生产 800 本的真实目录形状与模型不同：`treeShape()`（`budget.mjs:147-165`）假设 28 个字母桶**均匀**分布，而 manifest 实测是 **1 个作者桶（`佚名`→Y，800 本）、1 个格式桶（epub，800 本）、1 个类型桶（ebook，800 本）→ 各 4 页**；书名首字只有 19 种（`全` 390 本 → 2 页），归并成拼音首字母后约 10–14 个桶。按这个真实分布手算目录数 = `1 root + 5 nav + (10~14) title 字母桶 + 3 个单桶 + 13 个额外页目录 = 32~36`（取 ≈34）；模型给 74 → **模型把挂载 PROPFIND 高估约 2.2 倍**（保守方向，可接受）。另外 `treeShape` 只加了 4 个导航（`1 + 4 + …`）却**漏了 `type` 集合**（实际 5 个）—— 方向与上面相反，但两个误差叠加后总量仍偏保守（用真实目录数重算 800 本总量：`600+600+20×2×34+2×(34+4000)+20 = 10,648`，比模型的 12,328 低 13.6%）。
- CPU 10 ms：**全仓库没有一行 CPU 实测**。能确定的是「条目数有上界 200」，但 200 条 × 每条 ~12 个属性 + XML 转义 + 一次 `JSON.stringify`/`parse` 的缓存读写是否在 10 ms 内，只能上真机量。建议在 `x-dav-entries` 之外再输出 `x-dav-cache` 与耗时（本地 `wrangler dev` + `/api/admin/stats` 的 `directoryCount` 已经具备条件），因为 10 ms 是**硬停**，超了直接 1102。

### 5.5 索引与查询（只读复核）

| 查询 | 计划 | 行读 | 备注 |
|---|---|---|---|
| `findBookByLeaf`（`db.ts:148`） | `idx_books_leaf`（唯一） | 1 | ✅ |
| `/最近收录/` 列表（`db.ts:138`） | `idx_books_recent2 (status, published_at DESC, id)` | offset+limit ≤ 201 | ✅ 0005 的修复有效 |
| 分桶列表（`db.ts:122-135`） | `idx_books_{title,author,format,kind}_bucket` + 临时排序/回表 | ≤201 | ✅ |
| `adminListBooks` 无关键词（`db.ts:170`） | 排序 `created_at` **无索引** → 全表 + 临时 B-tree | **N（800）** | ⚠️ 管理员每页一次；`idx_books_status` 帮不上 |
| `adminListBooks` 带 `LIKE '%q%'`（`db.ts:177-185`） | 3 列全表扫描 | **N** | ✅ 可接受（admin） |
| `adminTotals`（`db.ts:193`） | 全表 COUNT + SUM | **N** | 见 L6 |
| `listBucketCounts`（`db.ts:83`） | buckets 全表 GROUP BY | ≤40 | ✅ |
| `buckets` 增量 UPSERT（`db.ts:529`） | PK 命中 | 1 写/桶 | ✅ |
| 4 个 `*_status` 索引 | **无查询使用** | — | 见 L1 |

缺失索引中唯一值得补的是 `adminListBooks` 的 `ORDER BY created_at DESC, id`（加 `(status, created_at DESC, id)` 或直接接受全表，因为它只在 admin 用）。`idx_books_recent`（0001）与 `idx_books_recent2`（0005）功能重叠，可评估合并。

### 5.6 一句话结论（budget 模型）

> **在 800 本、每天 2 次全库同步的假设下，budget 模型给出的硬停余量是请求 8.1 倍（12,328/10 万）、D1 行读 10.5 倍（475,848/500 万）、忙日 3× 也只到 37%，但这份余量完全属于读路径 —— 模型不含任何写侧的子请求/CPU/批量写额度，而本轮 4 条严重级缺陷全部命中写路径的 50 次/请求上限，所以在「读得动」之后，下一个会打满额度的不是读者，是一次 800 本的集合删除或一次 20 本的批量删除。**

---

## 6. 建议的修复顺序

1. **先止血批量写的失效预算**（S1 + S3 + S2 + S4 共用一套改造）：`purgeEntries` 加预算上限与 try/catch；批量删除改成「粗粒度失效 + 分页执行 + 返回游标」；集合 DELETE 把 `rebuildBuckets` / `purgeEntries` / `releaseLocks` 移到 R2 循环**之前**。
2. **补齐 WebDAV 单本写路径**（M1 + M2 + M7）：MOVE 打源身份、PUT/MOVE/COPY 打榜单、COPY 继承 `coverKey`、MOVE 继承 `kindBucket/kindSource`。
3. **统一失效来源**（M3 + M4 + M5 + M8 + M9）：把三处手写键（admin delete / update / rebucket）全部换成 `bookCacheTargets` 或其粗粒度版本；reindex 至少打导航 + 榜单；给 `bookCacheTargets` 增加分页层（或在 `propfind.ts` 里让分页目录不进缓存，成本更低）。
4. 之后再做：L1 删死索引、L5 加 `buckets/verify`、M10 的 `cover_key` COALESCE（一行改动，收益明确）。

---

## 7. 未覆盖范围 / 边界

- 无法验证生产库的迁移应用状态（本地 dev 库只到 0007，缺 0009 的 6 列 + 2 索引；`d1_migrations` 表存在但本地 `books` 无 `source_*` 列）。**生产是否真在 0009 之后无法从仓库判断**，`idx_books_source` 的唯一性因此只能按「迁移已应用」来评估风险。
- 未在 workerd 里跑任何请求，因此 CPU 10 ms 与「200 条目单响应」的实际耗时没有实测数字（§5.4 已标注）。
- 未审查 `src/lib/locks.ts` 的锁语义、SigV4 预签名、前端渲染 —— 属其它审查员范围。
- 所有 SQL 均为 `SELECT` / `EXPLAIN` 之外的只读形态；未执行任何写语句，未修改源码与迁移。

### 复现命令（只读）

```bash
# 容量模型
node scripts/budget.mjs --books 800

# 本地 D1：书量 vs 分桶计数（漂移）
npx wrangler d1 execute webooks-db --local --command \
  "SELECT (SELECT COUNT(*) FROM books WHERE status='published') AS published,
          (SELECT SUM(total) FROM buckets WHERE collection='recent') AS recent_total;"

# 本地 D1：逐桶漂移（含幽灵桶，用 merged 保证两侧都出现）
#   SQL 见 §4.1，核心是 actual(books GROUP BY) FULL OUTER JOIN buckets

# 本地 D1：索引清单（验证 0009 是否已应用）
npx wrangler d1 execute webooks-db --local --command \
  "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='books' ORDER BY name;"
```
