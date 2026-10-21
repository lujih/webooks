# RFC 4918 / RFC 9110 合规基线

本文档记录 webooks 当前的 WebDAV 合规基线。**每一行都可以用
[scripts/rfc-probe.mjs](../scripts/rfc-probe.mjs)、[scripts/webdav-litmus.mjs](../scripts/webdav-litmus.mjs)
和 `test/xml-wellformed.test.ts` 复验。**

> ⚠️ 本文档曾经与代码脱节（写着 `DAV: 1, 3`、PROPPATCH → 403、LOCK → 501，
> 而代码早已是 `1, 2, 3` 并实现了锁）。审查时已按代码与 RFC 原文逐条重写。

## 合规标准澄清

**常见误解**：「最新的 WebDAV 标准」。

- **RFC 4918（2007）** 是 WebDAV 基础标准，**至今未废弃**。它取代的是 RFC 2518（2002）。
- 所谓「更新」的是 **HTTP 核心语义**：RFC 9110 / 9111 / 9112（2022）取代 RFC 7230–7235。
- 若干扩展 RFC 也仍有效：RFC 5689（Extended MKCOL，2009）、RFC 5789（PATCH，2010）、
  RFC 5323（SEARCH，2010）、RFC 3253（DeltaV，2002）、RFC 3744（ACL，2003）。

webdav.org 的规格清单里被标记为 *obsoleted* 的只有 **RFC 2518**，不是 4918。

## 合规等级：Class 2（宣告 `DAV: 1, 2`）

**不宣告 3**，这是刻意的。RFC 4918 §18.3 原文：

> Advertising class 3 support in addition to class 1 and 2 means that the server
> supports all the requirements in this specification.

即宣告 `3` 等于声称「满足本规范全部要求」。本服务有多处有意保留的偏离（见下表），
宣告 3 会是**不实声明**。宣告 `1, 2` 是准确的：Class 1 + 完整锁支持
（锁协议本身完整；偏离的是**准入条件**，不是锁语义，见下表「LOCK 需写口令」）。

## 已实现（逐条对照 RFC 原文）

| RFC 条款 | 规范要求 | 本服务行为 | 状态 |
|---|---|---|---|
| §18.2 | Class 2 = Class 1 + LOCK/UNLOCK | `DAV: 1, 2`，含完整锁（timeout / lock-token / If 刷新） | ✅ |
| §9.10.1 | LOCK 响应体必须是 `prop` 元素里的 `lockdiscovery` | `<D:prop><D:lockdiscovery>…` | ✅ |
| §9.10 | LOCK 无需凭据（本服务**额外**要求写口令） | 未配置 `WRITE_TOKEN` 时匿名可用；配置后匿名 → 401 | ⚠️ 见偏离表 |
| §8.2 | 所有 XML「MUST be, at minimum, well formed」 | 全部响应体经严格良构校验（`test/xml-wellformed.test.ts`） | ✅ |

> ⚠️ 良构性**不等于**合规：`@cloudflare/vitest-pool-workers` 自带的良构检查
> 只验证标签配对与命名空间，不验 DTD。元素名拼错（`<D:lock>` vs
> `<D:activelock>`）、子元素顺序违反 sequence 这类问题它一律放过。
> 合规性由 `test/lock-xml.test.ts` 单独按 DTD 断言。
| §10.7 | `TimeType = ("Second-" DAVTimeOutVal \| "Infinite")` | 解析 `Second-600` 等真实写法 | ✅ |
| §14.12 | lockdiscovery 结构（含 `lockroot`） | 元素名 `activelock`（不是 `lock`），子元素顺序 `lockscope/locktype/depth/owner?/timeout?/locktoken?/lockroot` | ✅ 已修正 |

> **2026-10-14 订正**：本条此前标 ✅ 但结论是错的 —— 实现输出的是
> `<D:lockdiscovery><D:lock>`，而 RFC 4918 §15.7 的 DTD 是
> `<!ELEMENT lockdiscovery (activelock)* >`，元素名应为 `activelock`；
> 且子元素顺序把 `timeout` 排在 `locktoken` 之后，违反 §14.1 的 sequence。
> 严格客户端（.NET XmlDocument / SabreDAV / davfs2）按 `activelock` 取锁，
> **一把都读不到**。原有测试只验 XML 良构性（标签配对）—— 而
> `<D:lock>…</D:lock>` 恰恰是良构的，所以没拦住。
> 现由 `test/lock-xml.test.ts` 按 DTD 逐条校验。
| §14.7 / §14.14 | `lockdiscovery` 的 `<D:href>` 内是**令牌 URI 本体** | XML 里是裸 `urn:uuid:…`；尖括号只出现在头部（见 §10.5 行） | ✅ 已修正 |
| §6.5 / §10.5 | `Lock-Token: "<" absolute-URI ">"` | 头部出口一律走 `toCodedUrl()`：LOCK 响应与 423 的 `lock-token` 头都带尖括号；DB 里存的是裸本体 | ✅ |

> **2026-10-17 订正**：`§14.14` 那一行此前写的是「转义后写入，解析还原即裸 URI，**与 `Lock-Token` 头一致**」并标 ✅ ——
> **判据本身就是错的**：§10.5 要求头部是带尖括号的 Coded-URL，§14.7 要求 XML 里是 URI 本体，
> 「与头部一致」恰恰是 bug 的表现。这就是它长期存活的原因：文档标 ✅ → 无人复核 → 缺陷长期存活。
>
> 实际后果（线上复现）：`newLockToken()` 返回带括号形态并入库，`<D:href>` 里于是多一层尖括号。
> 规范客户端走 §9.10.1 设计的自救路径（被 423 挡住 → 读响应体／PROPFIND 发现锁 → 用 href 拼
> `Lock-Token` 头）时拼出 `<<urn:uuid:…>>` → 服务端逐字符比较失配 → **409**，
> **客户端无法用自己刚建的那把锁的 XML 形态解除它**；只有「建锁当下就记住响应头」的客户端能自救。
> 而我们自己的 423 响应体里嵌的正是 `lockDiscoveryXml(...)`，所以这条自救路径对规范客户端本来是走不通的。
>
> 自研探针为什么没抓到：`scripts/rfc-probe.mjs` 的旧检查只做 `body.includes(bare)`，而
> `&lt;urn:uuid:xxx&gt;` **也包含** `urn:uuid:xxx` 这个子串；两个探针又都只用头部令牌（从响应头拿的形态一直是对的）。
> 现由 `test/lock-xml.test.ts` 的端到端用例兜底：LOCK → `PROPFIND Depth:0` 取 href → 用 href **原样**拼
> `Lock-Token` → UNLOCK 必须 204。
>
> 兼容性：DB 里可能还有 TTL 内的存量行是带括号形态。比较路径两侧统一做 `stripBrackets()` 归一
> （`If:` 抓取、`Lock-Token` 头比较、刷新查行、删除），所以存量锁不会变成解不开的孤儿 —— 见
> `test/lock-xml.test.ts` 的「兼容存量行」用例。
| §9.10.2 | 无 body + `If:` 头 = 刷新锁 | 支持刷新 | ⚠️ 已修正 |

> **2026-10-14 订正**：本条此前标 ✅，实测是错的：
>   ① 刷新路径仍然回了 `Lock-Token` 头，违反 §9.10.2 的「not returned」
>   ② 对**不存在的** token 回 200 并新造一把锁 —— §9.10.6 要求
>      412 + `lock-token-matches-request-uri`
| §9.10.6 | 已有不兼容锁 → 423（不是 412） | 423 + `lock-token-submitted` | ✅ 已修正 |
| §11.3 | 对已锁资源写入 → 423 Locked | 423 | ✅ |
| §9.1 | PROPFIND 不存在的资源 → 404 | 404 | ✅ |
| §9.1 | Depth: infinity **MAY** 被禁用；拒绝时 SHOULD 用 403 + `propfind-finite-depth` | 降级为 Depth: 1 | ⚠️ 见偏离表 |
| §9.2 / §9.2.1 | 指令「MUST either all be executed or none」；受保护属性用 403 + `cannot-modify-protected-property` | 207 + 403 + 前置条件 | ✅ |
| §9.3 | URI 已映射时 MKCOL「MUST fail」 | 已映射 → 405；未映射 → 403 + `valid-resourcetype` | ✅ |
| §9.6.1 | 集合 DELETE「MUST act as if Depth: infinity」 | 递归删除该桶全部书；**根目录例外**（见偏离表） | ✅ |
| §9.7.2 | PUT 到集合「MAY be treated as an error (405)」 | 405 + Allow | ✅ |
| §9.4 | GET 集合「may return … a human-readable view」 | 返回 HTML 目录页 | ✅ |
| §15.6 | entity-tag 是 ASCII token | 原样输出不转义，客户端 If-Match 能对上 | ✅ |
| §15.7 | `getlastmodified` 用 rfc1123-date | 手写 RFC 1123 格式化 | ✅ |
| §15.1 | `creationdate` 用 RFC 3339 date-time | `toISOString()` | ✅ |
| §16 | 预置错误元素 | `supported-lock`、`cannot-modify-protected-property`、`valid-resourcetype` | ✅ |
| RFC 9110 §13.1 | 条件请求完整语义（If-Match / If-None-Match / IUS / IMS） | §13.2.2 顺序求值；If-Match **强比较**、If-None-Match **弱比较**、多值、通配 `*`；**在写入前判定**；失败区分 412 与 304 | ✅ |
| RFC 9110 §13.1.2 | `If-None-Match: *` 且资源已存在 → 412 | 412（PUT/DELETE；GET/HEAD 为 304） | ✅ |
| RFC 9110 §13.1.4 | `If-Unmodified-Since` 失败 → 412 | 412；用 `books.updated_at` 作验证器 | ✅ |
| RFC 9110 §13.1.3 | `If-Modified-Since` 失败 → 304 | 304（HEAD 支持；GET leaf 见下方说明） | ✅¹ |
| RFC 9110 §13.2.2 步 5 | Range + If-Range | **未实现**：GET leaf 是 302 到 R2，字节不经 Worker | ⚠️ 边界 |
| RFC 9110 §13.2.1 | 预条件晚于常规检查 | 404/401/405/415 等先于预条件求值 | ✅ |
| RFC 9110 §9.3.7 | OPTIONS `*` 服务器级查询 | 支持 | ✅ |
| RFC 9110 §14.2 | Range 头是建议性的（"only provides advice"） | GET 返回 302 交由 CDN 处理 | ✅ |
| RFC 9110 §8.6 | 204 不带非零 Content-Length | 遵守 | ✅ |
| RFC 5789 | PATCH 未实现 → 405 | 405 | ✅ |
| RFC 5689 §3.1 | 非法 resourcetype → 403 + `valid-resourcetype` | MKCOL 未映射路径时使用 | ✅ |

> ¹ **关于 GET leaf 的 304**：`GET /dav/<书>` 返回 **302** 到 R2 公开域，字节
> 完全不经过 Worker。§13.2.1 要求「不带条件头本来就**不是 2xx**」时**忽略**预条件
> —— 302 不是 2xx，所以对 GET leaf **忽略** If-None-Match / If-Modified-Since
> 才是规范要求的动作，不是漏做。`HEAD /dav/<书>` 是 200 + 元数据，因此**支持**
> 条件求值并会返回 304。
> 目录（root/nav/list）的 304 **未实现**：目录 HTML 是 D1 派生视图，没有
> 「集合本身的修改时间」这条数据，用当前页条目的合成 ETag 回 304 等于伪造
> 「内容没变」的断言，客户端会长期看不到新书。如实记为边界，不伪造。

## 有意保留的偏离（不是 bug，是设计取舍）

| 项 | 现状 | 理由 |
|---|---|---|
| **Depth: infinity** | 降级为 Depth: 1，而不是 403 + `propfind-finite-depth` | 大目录上 `infinity` 会炸 CPU。§9.1 用的是 SHOULD 级建议；§9.1 的 MAY 允许禁用。可通过 `DEPTH_INFINITY=deny` 切换为显式 403 |
| **Depth 头缺失** | 按 1 处理 | §9.1 说 SHOULD 按 `infinity`；同样出于 CPU 保护按 1 处理 |
| **DELETE 根目录** | 405（不支持） | 根 = 整个书库。实现 §9.6.1 会让一次误操作 / 客户端 bug 造成不可逆的全量丢失。批量清理走管理后台 `/admin` |
| **MKCOL 无法真正建目录** | 403 + `valid-resourcetype` | 集合由 D1 派生，无法持久化自定义目录。如实告知优于假装成功 |
| **PROPPATCH 不持久化** | 207 + 403 + `cannot-modify-protected-property` | 属性是派生视图。早前「假装 200 成功」是不实声明，已改为规范要求的前置条件 |
| **LOCK 需写口令** | 配置了 `WRITE_TOKEN` 时匿名 LOCK → 401（未配置时匿名仍可用，与 PUT/DELETE 同一判据） | RFC 4918 §9.10 本身**不要求**任何凭据。但 LOCK 是「承载写入权威」的操作（§14.15 规定 `locktype` 只有 `write` 一种），**一把集合锁会让整个子树的写全部 423**，爆炸半径大于 DELETE。实测：匿名 `LOCK /dav/按书名/`（`Depth: 1`）→ 200 + `lock-token`，随后匿名 PUT 子成员 → 423；锁 5 个顶层集合即可瘫痪全部 WebDAV 写路径。故与 DELETE/MOVE 同级要求写口令。UNLOCK 刻意不变（§9.11 用锁令牌表达归属，要求口令会让「持有者释放自己的锁」失败） |
| **未支持** | DeltaV(3253) / ACL(3744) / SEARCH(5323) / BIND(5842) | 公共书库无鉴权、无版本控制；用 PROPFIND 列举替代 SEARCH |
| **PUT 扩展名白名单** | 白名单外的扩展名 → 415（`ALLOWED_UPLOAD_FORMATS`） | 公共书库只收电子书/漫画格式；任意扩展名会让桶变成通用文件托管（存储成本 + 滥用面）。RFC 9110 §8.3 允许服务端基于媒体类型拒绝，但**严格客户端可能不预期** —— 标准 litmus 套件的 fixture 多为 `.txt`/`.xml`，会被一并 415。属本地取舍，非协议违背 |

## 自测基线

```bash
# 协议语义（22 项）——⚠️ 必须带 --token：LOCK 现在需要写口令，不带会把 401 误报成不合规
node scripts/rfc-probe.mjs --url https://<host>/dav/ --token "$WRITE_TOKEN"

# 完整挂载握手（16 步）——同样必须带 --token，否则第 6~8 步的锁流程无法验证
node scripts/webdav-litmus.mjs --url https://<host>/dav/ --token "$WRITE_TOKEN"

# XML 良构性（含线上曾经出过的真实坏样本）
npx vitest run test/xml-wellformed.test.ts
```

当前实测（2026-10-17，本地 `wrangler dev` 全量跑）：`rfc-probe` **22/22**（带 `--token`）；
不带 `--token` 时为 **16 项（15 ✅ + 1 ⚠️）** —— 其中 6 条锁协议检查被**一行显式说明替代**
（「未提供 --token，跳过锁协议检查，401 属预期」），`If-Match` 那 1 项因无凭据记 ⚠️。
`webdav-litmus` **16/16**（带 `--token`）；XML 良构全部通过。
（原文档写的 `14/14` 是陈旧数字；`21` 也是 —— 本次为令牌形态修复新增了
「锁令牌 href 是裸 URI」「用 href 拼出的 Coded-URL 等于响应头」两条检查，
其中前者在修复前**永远是 ✅**：旧判据只做 `body.includes(bare)`，而带括号的
`&lt;urn:uuid:…&gt;` 也包含裸子串 —— 判据写错正是这个 bug 长期存活的原因。）

> ⚠️ **不带 `--token` 时这两个探针的行为**（都已实测）：
> `LOCK` 会返回 **401**（本站有意要求写口令，见偏离表），这不是协议退化。
> 两个探针都会**显式打印一条说明**（`rfc-probe` 记一行「跳过锁检查，401 属预期」；
> `webdav-litmus` 记一行「未提供 --token，LOCK → 401 属预期」并跳过刷新/释放两步），
> 而不是静默跳过或记成失败 —— 前者会让「锁协议真的坏掉」和「只是没带口令」
> 在输出里长得一模一样。

> 💡 **为什么必须有 XML 良构性测试**：LOCK 响应曾输出
> `<D:locktoken><D:locktoken><D:href>…` —— 标签开了两次只关一次。
> .NET 的 `XmlDocument` 报 *"The 'D:locktoken' start tag does not match the end tag of 'D:lock'"*，
> 所有严格客户端都会挂。而当时的测试只做 `expect(xml).toContain(...)` 字符串匹配，
> 字符串里确实含有那个片段，一路绿灯。
> **教训：验证 XML 必须用解析器，不能用字符串包含。**

要跑完整 litmus 套件（需要 Python + apache + workerd 镜像），参考
[dav-probe.mjs](../scripts/dav-probe.mjs) 的 `--url` 参数指向 litmus 服务。
