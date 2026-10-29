# webooks WebDAV/HTTP 协议深度审查（2026-10-28）

**审查对象**：`webooks` @ `7911d40`。WebDAV 层 `src/webdav/{index,propfind}.ts` + `src/lib/{collections,cache,locks,preconditions,xml,http,db}.ts`。
**基准**：仓库自带 `refs/rfc4918.txt`、`refs/rfc9110.txt`（引文逐条 grep 原文核对，行号见各条的「依据」）。
**方法**：逐行读码；dev server（`127.0.0.1:8911`，HEAD `7911d40`，本地 D1）只读探测 `OPTIONS/GET/HEAD/PROPFIND`。
**写方法一次都没发**（对本机 dev 与生产都没有发 `PUT/DELETE/MOVE/COPY/LOCK/UNLOCK/MKCOL/PROPPATCH`），凡涉及写路径的结论均标注「静态」，并列出需要什么条件才能实测。
**前置文档**：已读 `docs/webdav-rfc-audit-2026-10-14.md`、`docs/rfc-compliance.md`、`docs/litmus-2026-10-16.md`。**文档已记录的缺口不重复**（清单见附录 B），只报「未修 / 比文档写的更严重 / 新发现」。

**重点**：2026-10-26 两次线上事故修复的边界 —— `f4a2771`（无尾斜杠二级目录）、`7911d40`（分页目录成员 href）。

**结论：25 条 —— 🔴 5 / 🟠 12 / 🟡 8。**

一句话总览：两次修复都只修了「报告出来的那**一种写法**」。`7911d40` 的判据是「页码 > 1 才带页段」，于是**第 1 页、以及被缓存键归一掉页码的 Depth:0 请求，仍然在返回「不在请求路径下」的 href —— 正是那两次事故的判定条件本身**（RFC 4918 §8.3 对此是 **MUST NOT**）。`f4a2771` 的桶段校验只加在「无尾斜杠」分支，带尾斜杠分支仍然接受任意桶名，于是同一个不存在的桶得到两个互相矛盾的答案（207 / 404）。

---

## 🔴 高危

### 🔴-1 `DELETE /<集合>/<桶>/<页码>/` 会删掉**整个桶**；`/最近收录/2/` 等于删掉整个书库

**文件**：`src/webdav/index.ts:1379-1380`（`const bucket = node.kind === 'list' ? node.bucket : ''` —— **`node.page` 被丢弃**）、`src/webdav/index.ts:1462`；`src/lib/db.ts:238-253`（`recent` 的 where 恒为 `1 = 1`）、`src/lib/db.ts:255-282`

**依据**：RFC 4918 §9.6.1 —— 「The DELETE method on a collection MUST act as if a 'Depth: infinity' header was used」+ §9.6「MUST remove the mapping from the Request-URI to any resource」。对 `/最近收录/2/` 来说，「该集合的成员」是它自己 207 里列出的那 200 本，不是全库。

**复现**（**静态**，未发 DELETE）：`DELETE /dav/最近收录/2/` → `resolveNode` = `list{recent, bucket:'all', page:2}` → `bucket='all'` → `deleteBooksInBucket(db,'recent','all')` → `DELETE FROM books WHERE status='published' AND 1=1` = **全库**。`DELETE /dav/按书名/A/2/` → 删整个 `A` 桶（第 1..N 页全部）。
连带：成员锁预检 `listBooksInBucket`（`index.ts:1451`）同样按**整桶**取候选 —— 任意一页上的任一本书被锁，第 2 页目录也删不掉（423）；而真正该保护的「第 2 页那 200 本」并不是判据。要实测需 `WRITE_TOKEN` + 发送 DELETE（本轮禁止）。

**建议**：`page > 1` 的 list 节点 DELETE 一律 405/403 —— 虚拟分页目录不是可删除资源（与「MKCOL 不建真目录」同一类取舍，且更安全）。不要试图给 `bucketWhere` 加 OFFSET 条件：删成员会立刻改变分页，无法定义清楚。
**最小回归测试**：`DELETE /recent/2/` → 4xx，且 `SELECT COUNT(*) FROM books` 不变。

### 🔴-2 `COPY` 到自身不拒绝，且**用自身 body 覆写同一个 R2 键**；D1 沿用旧 size

**文件**：`src/webdav/index.ts:567-576`（`sameResource` 判定只在 `isMove` 时短路）、`src/webdav/index.ts:671-678`（`targetR2Key` 复用源键后 `BUCKET.put(targetR2Key, sourceObj.body)`）、`src/webdav/index.ts:694`（`size: sourceBook.size`）

**依据**：RFC 4918 §9.8.5 —— 「**403 (Forbidden)** - The operation is forbidden. A special case for COPY **could be** that the source and destination resources are the same resource.」（`refs/rfc4918.txt:2744-2746`）；§9.8.1 —— 「Subsequent alterations to the destination resource will not modify the source resource」（同 URL 时二者是同一对象）。注：旧审计 `docs/webdav-rfc-audit-2026-10-14.md:52` 写的「COPY 到自身是合法的（幂等，见 §9.8.1）」是对 §9.8.1 的误读，正是这道检查被放过的原因。

**复现**（**静态**）：带写口令发 `COPY /dav/最近收录/x.epub` + `Destination: https://本站/dav/最近收录/x.epub` →
① 不返回 403/204，走完整写入流程；② `targetBook.r2_key === sourceBook.r2_key`，随后从 `sourceObj.body` 读、往**同一个键**写（R2 上是「读自己→写自己」）；③ `upsertBook` 用 `sourceBook.size`/`etsg` 写回，若对象被截断/置空，D1 仍声明旧大小 → `GET` 302 出去的字节与 `HEAD`/207 的 `getcontentlength` 不一致，且无法自愈。要实测需口令 + COPY。

**建议**：`sameResource` 对 COPY 同样短路 —— **204 且一个字节都不动**（幂等最省事），或与 MOVE 一致回 403。绝不要再走 `put`。

### 🔴-3 分页叶子的条目缓存键把页码段归一掉 → 一次请求就能让**所有客户端**看到不在请求路径下的 href（事故 2 同类回归）

**文件**：`src/lib/cache.ts:26-28`（`entriesCacheKey` 对键做 `canonicalDavPath`）、`src/lib/collections.ts:118-129`（丢掉「居中的页码段」）、`src/webdav/propfind.ts:377` + `src/lib/collections.ts:507`（只有 `page > 1` 才带页段）

**依据**：RFC 4918 §8.3 —— 「Within Simple-ref productions, senders **MUST NOT**: … have prefixes that do not match the Request-URI」（`refs/rfc4918.txt:1602-1618`）；§9.1（207 描述 Request-URI 所标识的资源及其成员）。这就是 2026-10-26 事故 2 的条款依据：客户端是对的。

**复现**（**实测 dev 8911**）：
```bash
B=http://127.0.0.1:8911/dav; R=$B/%E6%9C%80%E8%BF%91%E6%94%B6%E5%BD%95   # /dav/最近收录
curl -sX PROPFIND "$R/2/Dune.epub" -H 'Depth: 0' | grep -o '<D:href>[^<]*'   # → …/最近收录/2/Dune.epub   (x-dav-cache: MISS)
curl -sX PROPFIND "$R/Dune.epub"   -H 'Depth: 0' | grep -o '<D:href>[^<]*'   # → 仍 …/最近收录/2/Dune.epub (x-dav-cache: HIT)
curl -sX PROPFIND "$R/1/Dune.epub" -H 'Depth: 0' | grep -o '<D:href>[^<]*'   # → 仍 …/最近收录/2/Dune.epub (HIT)
```
三个分页变体共用**同一个**缓存键 `/最近收录/Dune.epub`；谁先来就决定之后所有人（含其他客户端）拿到的 self href。反向亦然：先请求真实路径，则第 2 页目录的成员在 Depth:0 上掉回上一层 —— **事故 2 的「成员不在请求路径下」被判为空目录，在 Depth:0 上原样复现**，持续 `PROPFIND_TTL`（默认 300s），且可被反复重新投毒。

**建议**：缓存键与 href 生成必须用**同一套路径身份**。二选一：① depth:0 的叶子缓存键保留页码段（`canonicalDavPath` 只用于锁键与失效键）；② `bookEntry`/`nodePath` 在 `node.page !== undefined` 时一律带页段（含 1），并把页码作为缓存键维度。验收标准写成断言：**同一缓存键的任意两种写法，返回的 self href 必须逐字节相同**。

### 🔴-4 `/…/1/`（显式第 1 页）的 self、成员、分页子目录 href **全部**丢掉页段

**文件**：`src/lib/collections.ts:443,447`（`/1/` 被解析成 `list page 1`）、`src/lib/collections.ts:498`（`page === 1 ? '/': '/{p}/'`）、`src/lib/collections.ts:507`、`src/webdav/propfind.ts:377`

**依据**：RFC 4918 §8.3（同上 MUST NOT）；§9.1。

**复现**（**实测**）：`PROPFIND /dav/最近收录/1/ Depth:1` → 207、17 条，`<D:href>` 只有 `/dav/最近收录/` + 16 条 `/dav/最近收录/x.epub` —— **请求 URI `/dav/最近收录/1/` 在响应里一次都没出现**（`x-dav-entries` 与 `/最近收录/` 相同）；`/按书名/A/1/` 同理。分页子目录也错：`/1/` 的 Depth:1 会列出 `/最近收录/2/`（不在 `/1/` 之下）。另有第二处伤害：`/…/1/` 有**独立缓存键**（实测 `MISS`→`MISS`→`HIT`），而 `bookCacheTargets`（`src/lib/cache.ts:65-96`）永不失效它 → 写/删后 `/…/1/` 的 207 陈旧到 TTL 到期。

**建议**：与 🔴-3 用同一套修法（`page >= 1` 即带页段）。若选择「`/1/` 只是别名」，则必须 301/308 到无页段形态 —— 但 PROPFIND 客户端多数不跟随重定向，风险仍在，所以更推荐前者。
**回归测试**：`PROPFIND /recent/1/ Depth:1` 的全部 href 必须以 `/dav/最近收录/1/` 开头。

### 🔴-5 集合 DELETE 在真实馆藏规模上必然撞 50 子请求上限：D1 行已删完、R2 只删了一部分 → 500 + 半删状态

**文件**：`src/webdav/index.ts:1462-1466`（每本 1 次 `BUCKET.delete`，有封面再 1 次）、`src/lib/db.ts:255-282`（**先**分批删 D1 行，全部删完才返回）、`src/lib/db.ts:216-235`（`listBooksInBucket` 无 LIMIT，`recent` = 全库进内存）、`src/lib/db.ts:630-663`（`rebuildBuckets` 一次 `db.batch`）

**依据**：RFC 4918 §9.6.1 的语义承诺是「删掉这个集合」并回 204；平台硬约束见本项目自己记录的 **50 子请求/请求**（`docs/appendix-platform-research.md:45`、`src/api/admin.ts:55` 都按「D1 与 R2 调用都算子请求」计费）。

**复现**（**静态**，本地 workerd 不施加该上限，**本地无法复现**）：`DELETE /最近收录/`（最近收录是扁平集合，成员=全库）在 800 卷（`docs/seed` 记录的实际入库量）下 ≈ 1(list)+1(locks)+16(D1 分页 8 读 8 删)+**800(R2)**+**~800(封面)**+1(batch)+3(purge) ≈ **1600+ 子请求**，超限 30 倍。失败点在 R2 循环中途：此时 D1 行已删完 → 索引里书没了、`rebuildBuckets` 没跑（桶计数漂移）、对象残留、客户端拿到 5xx。**本地 26 本、带封面的桶就已踩线（≈61）**。
附带风险：`listBooksInBucket` 无 LIMIT，`recent` 会把全库行读进 isolate（128MB/isolate 共享），800 卷尚可，2 万卷（README 提到的目标量级）时是 CPU/内存单点。

**建议**：① R2 清理移出请求（Queue / 下一次写操作的补偿扫描）；② 或按集合规模先算子请求预算，超限在**删任何一行之前**返回 503 + `retry-after`，绝不进入半删状态；③ `listBooksInBucket` 加 LIMIT 并改成「先用 D1 COUNT 判断规模」。

---

## 🟠 中危

### 🟠-1 MOVE/COPY **完全不做**条件求值（If-Match / If-Unmodified-Since / If-None-Match 列表全被忽略）

**文件**：`src/webdav/index.ts:493-766`（`handleMoveCopy` 全文无 `checkPreconditions`；全仓调用点只有 HEAD 叶子 `:874`、PUT `:1104`、DELETE 叶子 `:1301`、DELETE 集合 `:1413`）、`:610`（只识别 `If-None-Match: *`）

**依据**：RFC 9110 §13.2.2（「A recipient cache or origin server **MUST** evaluate the request preconditions … in the following order」，对所有方法）；RFC 4918 §10.6（「If-Match applies only to the Request-URI, and not to the Destination of a COPY or MOVE」—— 即 MOVE/COPY 的**源**仍受 If-Match 约束）。

**复现**（**静态**）：`MOVE /dav/最近收录/x.epub` 带 `If-Match: "stale"` → 不比对，直接搬走并 201/204；`COPY` 带 `If-None-Match: "etag"` → 列表形态被忽略（只认 `*`）。与 PUT 修好之前（审计 🟠-3 的动机）同型：同步客户端「只在版本对得上时改名/复制」的意图被静默丢弃，且**没有任何线索**。

**建议**：在口令检查之后、任何写之前，对**源**（`findBookByLeaf(node.leafName)`，ETag 用与 PUT 同一个表达式 `bookStrongEtag`）与**目标**分别调用 `checkPreconditions`，失败 412。注意 §10.6 的原文说明「If-Match 不覆盖 Destination」是规范的默认行为 —— 我们额外覆盖目标是为了自己那条 `If-None-Match: *` 语义，两者要写进注释避免后人"统一"掉。

### 🟠-2 锁只按 URL 路径匹配：同一本书的**跨集合别名路径**可绕过锁（Class 2 的核心承诺被打折）

**文件**：`src/webdav/index.ts:192-210`（`handleLockedWrite` → `liveLockForResource(env.DB, davPath)`）、`src/lib/locks.ts:474-503`（精确 + 祖先前缀）

**依据**：RFC 4918 §7（「PUT, …, DELETE, and MKCOL are affected by write locks」+ 锁根映射被改动同样受约束）、§6.1-1/§6.1-3；§5.2 承认「同一资源可以有多个别名 URL」是合法模型（并因此要求 PROPFIND 只暴露一个首选段）。

**复现**（**静态**）：`LOCK /dav/按书名/A/x.epub` → 行 `resource=/按书名/A/x.epub`；随后 `PUT /dav/最近收录/x.epub`（或 `DELETE /dav/按格式/epub/x.epub`）→ 查 `/最近收录/x.epub`，既非精确命中也不是祖先前缀 → **放行**。而 `handleDelete` 的集合分支（`:1457`）明确写着「同一本书出现在任何桶下都指向同一资源，锁不该因为路径写法不同就失效」—— 同一条原则没有用到 `handleLockedWrite`。未配置 `WRITE_TOKEN` 时 LOCK 与写都匿名可用，这条即「锁基本无效」。

**建议**：路径未命中时用已有的 `resourceMatchesLeafName()`（`src/lib/locks.ts:276`）按末段兜底一次；配 `WRITE_TOKEN` 时必须做。**负向测试**：锁 A 路径 → 走 B 路径 PUT 必须 423。

### 🟠-3 LOCK 刷新：无效/他人的 token 会**新造一把锁**并回 200 + `Lock-Token`（审计 🟠-4 未修，而合规文档标「已修正」）

**文件**：`src/lib/locks.ts:142-176`（查不到就继续走新建分支）、`src/webdav/index.ts:315-341`（`isRefresh` 解构出来**从未使用**，恒 200、恒回 `Lock-Token`）

**依据**：RFC 4918 §9.10.6 —— 「**412 (Precondition Failed)**, with 'lock-token-matches-request-uri' precondition code … the token may be invalid」（`refs/rfc4918.txt:3225-3234`）；§9.10.2 —— 「The Lock-Token header is **not** returned in the response for a successful refresh LOCK request」。

**复现**（**静态**）：`LOCK /a.epub` 得 `T`；`LOCK /b.epub` + `If: (<T>)` → 200 + **新的** `Lock-Token`（新锁建在 b 上），规范要求 412。刷新也照样回 `Lock-Token` → 客户端据此更新本地令牌，旧的 T 仍占着 a → a 在 TTL 内 423，而客户端以为自己已释放。
**这条比文档写的严重**：`docs/rfc-compliance.md:77-82` 把 §9.10.2 标为「⚠️ 已修正」并复述了两条修法，代码里两条都没实现；`isRefresh` 未被使用本身就是证据。

**建议**：`refreshToken` 非空但查不到 → 抛 `lockTokenMismatch`，`handleLock` 回 412 + `lock-token-matches-request-uri`；`isRefresh === true` 时不发 `Lock-Token`。

### 🟠-4 分页目录（第 2..N 页）的条目缓存**永不失效** → 写/删后 300s 内看到旧成员

**文件**：`src/lib/cache.ts:65-96`（`bookCacheTargets` 只覆盖 5 条叶子 + 5 条第 1 页列表 + 4 条导航）、`src/lib/cache.ts:26-28`

**依据**：一致性要求（RFC 4918 §9.6「MUST remove the mapping」之后不应还能 PROPFIND 到该资源）；与 `7911d40` 提交自己写的「否则删除后仍显示」同类。

**复现**（**静态**；本地库 26 本造不出第 2 页，`MAX_ENTRIES=200`）：写入/删除后 `/按书名/A/2/`、`/最近收录/2/` 的 207 保持旧内容直到 TTL（默认 300s）；`/…/1/` 另有独立键（实测 MISS/MISS）。分页边界会随增删移动，所以「第 2 页」的陈旧内容与真实成员完全错位。

**建议**：给分页目录缓存键加「集合版本号」（D1 里每集合一个 serial，写时 +1）—— 比逐个 `cache.delete`（最多 101 条，超 50 次/请求上限）可靠得多；`PROPFIND_TTL` 对分页目录单独调短只能缓解。

### 🟠-5 分页路径下的 `lockdiscovery` 丢失：成员 href 带页段，锁键不带

**文件**：`src/webdav/propfind.ts:611-621`（用 `entry.path` 去匹配）、`src/lib/locks.ts:444-464`（`r === p` 或祖先前缀）

**依据**：RFC 4918 §15.8（`lockdiscovery` —— 「Contains the active locks on the resource」）+ §7.5/§10.5（客户端靠它拿令牌自救）。

**复现**（**静态**）：第 2 页成员的 `entry.path = /最近收录/2/x.epub`，锁行 `/最近收录/x.epub` → 既不相等也非祖先前缀 → `<D:lockdiscovery/>` 为空。客户端在第 2 页看到一本「没锁」的书，写入时 423，令牌只在 423 的响应体里才出现（自愈路径变长）。
注意祖先前缀对**集合锁**仍然有效（`/按书名/A/` 是 `/按书名/A/2/x.epub` 的前缀）—— 只有「锁在叶子上」的场景会漏。

**建议**：匹配前对 `e.path` 做一次 `canonicalDavPath`（锁键已是规范形态），或让 `matchLocksToPaths` 额外接受「规范化后相等」。

### 🟠-6 桶名只在「无尾斜杠」时校验 → `/按书名/ZZZ/` 207、`/按书名/ZZZ` 404（同一个不存在的桶两个答案）

**文件**：`src/lib/collections.ts:435-439`（`if (trailingSlash) return list(...)` **先**命中，`isBucketSegmentOf` 只在无尾斜杠分支）；`src/lib/collections.ts:363-378`

**依据**：RFC 4918 §5.2 —— 「In cases where a server treats a set of segments as equivalent, the server **MUST** expose only one preferred segment per mapping, consistently chosen, in PROPFIND responses」（`refs/rfc4918.txt:843-851`）；§9.1。

**复现**（**实测**）：
```
PROPFIND /dav/按书名/ZZZ/  Depth:1 → 207（仅 self，creationdate 1970-01-01，getetag "d-1-…"）
PROPFIND /dav/按书名/ZZZ   Depth:0 → 404
```
**后果**（静态）：① `MKCOL /按书名/Q` → 403，`MKCOL /按书名/Q/` → 405（同一资源两种状态码）；② `PUT /按书名/Q/新书.epub` 会成功建书，但书的真实桶由书名算出，`/按书名/Q/` 的 Depth:1 永远为空 → **「上传成功却看不到」**，与那两次事故的用户体验同型；③ 任意桶名（`/按书名/随便/`）都能作为容器出现，而父目录的 Depth:1 不列出它（违反 §5.2 的 MUST）。

**建议**：把 `isBucketSegmentOf` 提到尾斜杠判定**之前**，对两段路径一律生效；不在合法桶集合内的 `unknown`（404）。补测试 `PROPFIND /title/notabucket/ → 404`。

### 🟠-7 MOVE/COPY 的 Destination：mount 前缀用 `startsWith` 无边界、跨主机不拒 → 站外/相似前缀被当成 DAV 目标，`Location` 可能指回 404

**文件**：`src/webdav/index.ts:530-535`（`if (mount && rawPath.startsWith(mount)) rawPath = rawPath.slice(mount.length)`；未比较 host）、`src/webdav/index.ts:757-758`（`Location` 用剥过的 `targetDavPath`）

**依据**：RFC 4918 §10.3 —— 「If the Destination value is an absolute-URI, it may name a different server … If the source server cannot attempt a copy to the remote server, it **MUST fail the request**」（`refs/rfc4918.txt:3611-3623`）；`Destination = "Destination" ":" Simple-ref`。

**复现**（**静态**）：mount=`/dav` 时 ——
① `Destination: https://evil.example/dav/x.epub` → 只取 pathname，**跨主机不拒**（MUST fail 未做）；
② `Destination: https://本站/davrecent/x.epub` → `slice(4)` 得 `recent/x.epub` → 解析为 `/recent/x.epub` → **书真的建进「最近收录」**，响应 `Location: /davrecent/x.epub` 指回一个 404 路径；
③ `Destination: /最近收录/x.epub`（完全不带 mount）→ 也接受并建书。

**建议**：mount 必须按边界匹配（`path === mount || path.startsWith(mount + '/')`）；host/scheme 与 `request.url` 不同 → 502；`targetDavPath` 强制以 `/` 开头。

### 🟠-8 `DELETE /<集合>/`（nav 节点）静默 **204 且一本都没删**

**文件**：`src/webdav/index.ts:1379-1380`（nav 节点 `bucket = ''`）、`src/lib/db.ts:238-242`（`title_letter = ''` → 0 行）

**依据**：RFC 4918 §9.6/§9.6.1；RFC 9110 §15.3.5（204 表示「已成功执行，且不需要返回内容」）。

**复现**（**静态**）：`DELETE /dav/按书名/` → `deleteBooksInBucket('title','')` → `WHERE title_letter=''` → 0 行 → **204**；之后 `/按书名/` 照旧列出全部桶。`docs/rfc-compliance.md:89` 的 §9.6.1 一行标 ✅ 且写「递归删除该桶全部书」—— 只对 `list` 节点成立，对 `nav` 是假声明。
**注**：`list`（桶）节点确实会删（这正是 🔴-1 的放大器）。

**建议**：nav 的 DELETE 要么真的删整个集合（5 个集合都能拆成桶循环，但立刻撞 🔴-5 的子请求上限），要么明确 405/403。**不能回 204**。

### 🟠-9 `supportedlock` 宣告 `shared`，但任何活锁（含 shared）都判 423

**文件**：`src/lib/locks.ts:179-185`（`blocking = liveLockForResource(...)` 不看 `type`）、`src/webdav/propfind.ts:303-308`（宣告 `shared`）

**依据**：RFC 4918 §6.1-3（只有 **exclusive** 锁与任何锁冲突；「A server MUST NOT create **conflicting** locks」）、§6.2（「if five principals have taken out shared write locks on the same resource, there will be five locks and five lock tokens」）、§15.10（`supportedlock` 是能力宣告）。

**复现**（**静态**）：第二个 `shared` LOCK 请求 → 命中第一把 shared → 423。客户端据 §15.10 认为可建共享锁，且 §6.2 明说可以有 5 把。这是**宣告了做不到的能力**（不实声明），与 2026-10-14 报告 🔴-5 同类，只是方向相反（那次是多宣告 `read`）。

**建议**：`acquireLock` 只在「已有 exclusive」或「本次要 exclusive 且已有任意锁」时冲突；或者立刻把 `supportedlock` 里的 shared 条目删掉（回到诚实状态），等实现后再加回来。

### 🟠-10 LOCK 的 Depth 从**请求体**取、请求头被忽略；`Depth: 0` 会得到 infinity 锁（过度加锁）

**文件**：`src/webdav/index.ts:301-302`（`body.match(/<...depth>\s*(\w+)\s*</i)`，`\w+` 全收）

**依据**：RFC 4918 §9.10.3 —— 「Values other than 0 or infinity **MUST NOT** be used with the Depth header on a LOCK method」「If no Depth header is submitted on a LOCK request, then the request MUST act as if a 'Depth:infinity' had been submitted」（`refs/rfc4918.txt`）；§6.1-4（只有 depth-infinity 覆盖成员）。

**复现**（**静态**）：`LOCK /dav/按书名/A/` + 请求头 `Depth: 0` → 库里落 `infinity`（或 body 缺省），`liveLockForResource` 的前缀匹配**不看 `depth`** → 整棵子树 423。客户端以为自己只锁了目录本身，后续上传全部失败。反向：body 里 `<D:depth>1</D:depth>` 会被接受（§9.10.3 禁止），并原样渲染成 `<D:depth>1</D:depth>`（宣告一个规范不会发的值）。

**建议**：读 `request.headers.get('depth')`，只接受 `0`/`infinity`（缺省 infinity），其余 400；`liveLockForResource` 的祖先前缀匹配仅在 `depth === 'infinity'` 时成立。

### 🟠-11 LOCK 到未映射 URL 回 200、且不创建空资源 → 「先锁后建」握手在 PROPFIND 处断掉

**文件**：`src/webdav/index.ts:263-368`（`handleLock` 无存在性检查，恒 200）

**依据**：RFC 4918 §6.1-2 —— 「If at the time of the request, the URL is not mapped to a resource, a new empty resource is created and directly locked」（`refs/rfc4918.txt:906-908`）；§9.10.4 —— 「A successful LOCK method **MUST** result in the creation of an empty resource … Empty resources MUST then appear in PROPFIND responses」；§9.10.6 的 201。

**复现**（**静态**）：`LOCK /dav/按书名/A/ghost.epub` → 200 + lockdiscovery，但 `PROPFIND /…/ghost.epub` → 404（`collectDavEntries` 的 leaf 分支 `findBookByLeaf` 为空即 null）。审计 🟠-5 已记录但**未修**；列入是因为它是 §9.10.4 的 MUST，而 `DAV: 1, 2` 的宣告意味着 Class 2 全项成立 —— 长期「已记录」等于长期不实声明。

**建议**：实现空资源登记（`upsertBook` size 0 + 201 + `purgeEntries`），或在 README/§9.10.4 明确记为取舍。二者取一。

### 🟠-12 MOVE 只释放「本次请求那条路径」的锁，别名路径上的锁残留 → 违反 §6.1-8 的 MUST

**文件**：`src/webdav/index.ts:737`（只有 `releaseLocksForResource(env.DB, davPath)`；对比 DELETE 叶子 `:1358` 是 `releaseLocksForLeafNames` + `releaseLocksForResource` 两路都清）

**依据**：RFC 4918 §6.1-8 —— 「If a request causes the lock-root of any lock to become an unmapped URL, then the lock **MUST** also be deleted by that request」（`refs/rfc4918.txt:940-942`）。

**复现**（**静态**）：`MOVE /按书名/A/x.epub → /按书名/A/y.epub` 后，`/按格式/epub/x.epub`、`/最近收录/x.epub` 等别名上的锁仍是活锁，而那些 URL 已不映射到任何资源 → 旧名在 TTL（≤3600s）内 PUT 一律 423。用户看到「刚改完名字，一小时内传不上同名文件」。

**建议**：MOVE 分支补 `releaseLocksForLeafNames(env.DB, [sourceBook.leaf_name])`，与 DELETE 对齐。

---

## 🟡 低危

### 🟡-1 207 里**所有集合条目共用同一个 ETag**（同一响应内 6 个不同资源同一强验证器；分页目录内容变了父 ETag 不变）

**文件**：`src/webdav/propfind.ts:624-626`（`dirEtag` 对响应里**每个**集合条目复用）、`src/webdav/propfind.ts:519-526`（`collectionEtag(entries)` 的输入是**整个响应**的条目）

**依据**：RFC 9110 §8.8.1/§8.8.3（验证器必须与表示的字节变化一致；不同表示共用同一强验证器会让 `If-Match` 与再验证指向错误资源）。

**复现**（**实测**）：`PROPFIND /dav/ Depth:1` → 根 + 5 个集合全部 `getetag "d-6-1346603759"`；`PROPFIND /dav/按书名/ Depth:1` → 13 个桶目录全部 `"d-17-1070073929"`。

**后果**：客户端按 ETag 判「某个子目录变没变」永远得不出答案；分页目录的成员变了，父集合 ETag 不变（`childCount` 不进 ETag，`entries` 也不含分页内容）。

**建议**：集合 ETag 按「该集合自己的成员 + 最大 mtime」单独算（root/nav 一条 `MAX(updated_at)` 的 SQL 即可）；做不到就**不要**给集合发 `getetag`（放 404 propstat）——RFC 4918 §15.6 的适用前提是「GET 会回 ETag」，而集合的 GET 并不回。给错验证器比不给更糟。

### 🟡-2 HEAD 与 GET 语义相反：`HEAD → 200/304`，`GET → 302`（且 302 上没有 ETag/Last-Modified）

**文件**：`src/webdav/index.ts:867-930`

**依据**：RFC 9110 §9.3.2 —— 「The HEAD method is identical to GET except that the server MUST NOT send content」「The server SHOULD send the same header fields in response to a HEAD request as it would have sent if the request had been a GET」；§13.2.1（无条件响应不是 2xx/412 时**必须忽略**预条件）。

**复现**（**实测**）：同一本书 `GET → 302`（无 ETag/Last-Modified）、`HEAD → 200`（有 ETag/Content-Length/Accept-Ranges）；`If-None-Match: "e12"` 时 `HEAD → 304`、`GET → 302`。

**与文档的关系**：审计 🟡-3 已记「GET 302 / HEAD 200 两个状态码」，本轮新增的是 **304/302 分歧**（HEAD 的 304 是这轮才实现的），且 302 上没有验证器 —— 客户端无法从 GET 侧播种 ETag，缓存只能靠 HEAD。

**建议**：让 HEAD 与 GET 对齐。两条路：① HEAD 也回 302 + Location + 元数据头（§13.2.1 下此时**不该**有 304，现有的 304 分支要删）；② 或者接受现状但**必须**在 302 上补 `etag`/`last-modified`，否则 `HEAD → 304` 之后 `GET → 302` 是一个自相矛盾的缓存决策序列。

### 🟡-3 非法 `Depth` 值（`2`、`0,1`）静默按 1 处理

**文件**：`src/webdav/propfind.ts:140-151`

**依据**：RFC 4918 §10.2 —— `Depth = "Depth" ":" ("0" | "1" | "infinity")`。非法值应回 400（具体条款定位：§10.2 只给语法、未明写状态码 → **条款待核**；按 RFC 9110 对畸形字段值的一般处理，400 是安全选择）。

**复现**（**实测**）：`Depth: 2` → 207；`Depth: 0,1` → 207；`Depth: 1.5` → 207。

**建议**：无法识别的 Depth 回 400（比静默降级更可诊断）；文档里把「缺失按 1」与「非法值按 1」分开写，后者不是取舍。

### 🟡-4 集合条目的 `getcontenttype`/`getcontentlength` 与同一 URI 的 GET 不符

**文件**：`src/webdav/propfind.ts:260-267`（集合也走同一分支：`meta.contentLength ?? 0`、`meta.contentType ?? 'application/octet-stream'`）

**依据**：RFC 4918 §15.3 —— 「getcontenttype … contains the Content-Type header value that would have been returned by a GET without accept headers」；§15.4 同构。

**复现**（**实测**）：集合条目回 `<D:getcontentlength>0</D:getcontentlength><D:getcontenttype>application/octet-stream</D:getcontenttype>`，而 `GET` 同一 URI 回 `text/html; charset=utf-8` 的目录页。

**建议**：集合回 `text/html`，或干脆把这两个属性放进 404 propstat（「集合没有内容」是常见做法）。

### 🟡-5 写路径忽略页码：`PUT`/`MOVE`/`COPY` 到 `/最近收录/2/x.epub` 的落点不是第 2 页

**文件**：`src/webdav/index.ts:967-995`（PUT 只取 `node.leafName`）、`src/webdav/index.ts:592`（MOVE/COPY 的 `targetLeaf`）

**依据**：无直接条款（虚拟分页目录的自洽性问题）；与 §8.3「一个映射只暴露一个首选段」同精神。

**复现**（**静态**）：`PUT /dav/最近收录/2/新书.epub` 合法并建书（页码被 `canonicalDavPath` 丢弃），但新书按 `published_at DESC` 排在**最后一页**；客户端随后 `PROPFIND /最近收录/2/` 看不到它（第 2 页整体后移）。

**建议**：分页目录声明为只读（`page > 1` 的写请求 405），或在响应里给出实际落点（`Location` / `Content-Location`）。

### 🟡-6 `If: (Not <token>)` 被当成「已提交令牌」→ 反向授权

**文件**：`src/lib/locks.ts:122-124`（正则只抓 `urn:uuid:` 串，不保留 `Not`）、`src/webdav/index.ts:223-230`

**依据**：RFC 4918 §10.4.1 —— `If` 的产生式是 `( "Not"? Coded-URL | ... )`，`Not` 表示条件取反；「If this header is evaluated and all state lists fail, then the request MUST fail with a 412」。

**复现**（**静态**）：`If: (Not <urn:uuid:T>)`（T 正是该资源的活锁）→ `ifTokenAuthorizes` 命中 → 放行；规范语义是「仅当不被 T 锁住时才继续」，应 412。

**建议**：解析时保留 `Not` 标记，带 `Not` 的令牌不参与「已提交」判定（完整 If 求值器是审计 🟠-1 的遗留项，这一小块可以单独先修）。

### 🟡-7 `canonicalDavPath` 不看路径形状，非法 5 段路径被归一到**真实分页目录**的身份

**文件**：`src/lib/collections.ts:118-129`（`filter` 只判 `i > 0 && i < lastIdx`，不看段数/集合形状）

**依据**：无直接条款（内部归一规则）；风险是「归一函数比解析函数宽松」。

**复现**（**静态**）：`/按书名/A/2/3/` 被 `resolveNode` 判为 `unknown`（404），但 `canonicalDavPath` 归一成 `/按书名/A/3` —— **真实第 3 页目录的身份**。于是 `LOCK /dav/按书名/A/2/3` 会写一行 `resource=/按书名/A/3` 的锁（lockroot 却渲染请求路径），随后真实 `/按书名/A/3/` 上的 LOCK 会 423；缓存键同理。当前只在配置了 `WRITE_TOKEN` 时可触发，影响面小，但结构性问题。

**建议**：归一页码段前先跑与 `resolveNode` 相同的形状判定（扁平集合页码在第 2 段、分桶集合在第 3 段，且段数匹配），否则原样返回。

### 🟡-8 集合条目的 `displayname` 给的是**路径**而不是名字

**文件**：`src/webdav/propfind.ts:475`（`displayName: selfPath`）

**依据**：RFC 4918 §15.2 —— `displayname` 「is intended to be used in presentations to a user」。

**复现**（**实测**）：`<D:displayname>/最近收录/</D:displayname>`；分页目录 `<D:displayname>/按书名/A/2/</D:displayname>`。

**建议**：给集合一个名字（`最近收录`、`第 2 页`），路径留给 `href`。多数客户端取 href 末段，所以这条只在读 displayname 的客户端上可见。

---

## 附录 A：两次修复的边界核对表（任务重点 1）

| 场景 | 期望 | 实测/静态结论 | 结论 |
|---|---|---|---|
| `PROPFIND /按书名/A`（无尾斜杠）Depth:0 | 207，self href 可用 | 207，href `/dav/按书名/A/`（比请求多一个 `/`，属 §8.3 允许的前缀关系） | ✅ |
| 同上 Depth:1 | 成员以请求路径为前缀 | 成员 `/dav/按书名/A/x.epub` | ✅ |
| 同上 Depth:infinity | 降级 1（或 deny→403） | 207，1 层 | ✅（已记录取舍） |
| `PROPFIND /最近收录/2/` Depth:1 | 成员 href 在 `/2/` 下 | `/dav/最近收录/2/x.epub` | ✅（修复生效） |
| `PROPFIND /最近收录/1/` Depth:1 | 成员 href 在 `/1/` 下 | 全部落在 `/最近收录/`，请求 URI 不出现 | ❌ 🔴-4 |
| `PROPFIND /最近收录/2/x.epub` Depth:0 | self href = 请求 URI | 取决于缓存首个访问者 | ❌ 🔴-3 |
| MOVE/COPY `Destination` 集合路径（无斜杠/无扩展名） | 拒绝 | 400（`targetNode.kind !== 'leaf'`） | ✅（状态码见附录 B） |
| MOVE/COPY `Destination` 前缀/跨主机 | 按 §10.3 失败 | 被当成 DAV 目标，可能建到错桶 | ❌ 🟠-7 |
| `MKCOL /按书名/A`（无斜杠桶） | 映射则失败 | 405 | ✅ |
| `MKCOL /按书名/Q/`（幽灵桶） | 不存在 → 409/403 | 405（`/按书名/Q` 反而 403） | ❌ 🟠-6 |
| `PUT /按书名/A`（无斜杠桶） | 错误 | 405（改前是 415；§9.7.2 允许 405） | ✅ |
| `PUT /按书名/Q/x.epub`（幽灵桶） | 404/409 | 建书成功、`/按书名/Q/` 永远空 | ❌ 🟠-6 |
| 分页叶子 PUT/DELETE/MOVE/COPY | 可用 | 可用；DELETE 走 leaf 分支（**不会**误删整桶），但写落点忽略页码 | ⚠️ 🟡-5 |
| 分页**目录** DELETE | 只删该页成员 | 删整桶（`/最近收录/2/` = 全库） | ❌ 🔴-1 |
| `canonicalDavPath` 误归一 | 只归一合法位置的页段 | 任意中间页段都丢；5 段路径也被归一 | ❌ 🟡-7 |
| 页码段与叶子名冲突 | 叶子必带扩展名 → 不可能冲突 | 成立（PUT/网页上传/reindex 三处白名单） | ✅ |
| 桶名与页码段冲突 | 无数字桶 → 不会误判 | 成立（`0-9` 不是页码段） | ✅ |

## 附录 B：不重复报告的已知项（文档已记录，本报告只用不展开）

`Range`/`If-Range` 未实现（GET 302 → R2 终结）、目录 GET/PROPFIND 的 304 未实现（无集合级验证器）、`If` 求值器不完整（`[etag]`/多 resource-tag；本报告只取其中 `Not` 一条 🟡-6）、PROPFIND 坏 body 未回 400、MKCOL 不建真目录/无 415/无 409、PROPPATCH 不持久化、207 无 `Vary`、OPTIONS 缓存 1 天、`PAGINATION_MAX=100` 截断（`README.md:734`）、LOCK 需写口令、DELETE 根目录 405、GET leaf 忽略预条件（§13.2.1 有据）、`etag ?? id` 回退不是内容派生验证器。
本报告与文档**冲突**的两处：`docs/rfc-compliance.md:77-82`（LOCK 刷新「已修正」——未修，🟠-3）、`:89`（§9.6.1「递归删除该桶全部书」——nav 是 no-op，🟠-8）、`:36-46`（§14.12/§9.10.2 结论）。

## 附录 C：环境、清理与不可复现项

- **dev**：`npx wrangler dev --port 8911 --ip 127.0.0.1`（HEAD `7911d40`，本地 D1，26 本 / `recent=26` / `format/epub=22`）。探测全程只发 `OPTIONS/GET/HEAD/PROPFIND`；**未对生产发任何请求**（生产探测对本任务的结论没有增量，且事故面不值得再碰）。
- 按 PID 结束 dev（见 task 回复），未触碰 8899，未改任何源码/测试，未做 git 写操作。
- **本地无法复现、仅静态分析**的项：🔴-1（需写 + 200 本以上）、🔴-2（需写）、🔴-5（workerd 不施加 50 子请求上限）、🟠-1/🟠-2/🟠-3/🟠-5/🟠-7/🟠-8/🟠-9/🟠-10/🟠-11/🟠-12、🟡-5/🟡-6/🟡-7（均需写方法或 `WRITE_TOKEN`）。🟠-4 需 >200 本（`MAX_ENTRIES`）才能造出第 2 页。
- **建议补的测试**（都在现有测试文件里加，不需要改源码）：`/recent/1/` 的 href 前缀断言；同一叶子三种写法 Depth:0 的 href 一致性；`DELETE /recent/2/` 不得删库；锁 A 路径后走 B 路径必须 423；MOVE 后别名锁清空；`PROPFIND /title/notabucket/` 404。
