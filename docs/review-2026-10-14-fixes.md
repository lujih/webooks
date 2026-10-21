# 2026-10-14 全面审查与修复记录

审查范围：协议合规（RFC 4918/9110）、安全、Cloudflare 成本容量、数据质量四个方向。
基线 `npm test` → 253 个测试全绿，线上站点 `security-probe` 33/33 通过。

修复后：**311 个测试全绿**，新增 58 条回归测试。

---

## 一、最重要的发现：测试全绿 ≠ 没有 bug

253 个测试**一个都拦不住**下面任何一条。原因很具体：

- 断言的是「输出包含某字符串」，不是「行为符合规范」
- `xml-wellformed.test.ts` 只验 **XML 良构性**（标签配对），
  而 `<D:lock>…</D:lock>` 恰恰是**良构的** —— 只是元素名用错了
- 缺陷集中在「实现细节」（元素名拼错、正则写错、标志位缺失），
  而这些恰好是"看起来能跑"的部分

新增的测试全部断言**数据在操作后是否完好**，而不是响应里有没有某个字符串。

---

## 二、数据丢失类（🔴 最高优先级）

| 缺陷 | 修复前实测 | 修复后 | 规范依据 |
|---|---|---|---|
| MOVE 到自身 | `201`，D1 行没了、R2 对象没了、GET 404 | `403`，三者全部完好 | RFC 4918 §9.9.4 |
| DELETE 集合（成员被锁） | `204`，被锁的书被删 | `423`，两本书都在 | §9.6 + §7 |
| MOVE 覆盖后源与目标同源 | 可能双双消失 | `204`，源删目标存 | §9.9.4 |
| 覆盖时 etag / 收录时间 | 被无条件重置 | 保留原值 | — |

MOVE 自毁那条最要紧：Windows 资源管理器、Nextcloud、Koofr 的同步引擎都会发
no-op MOVE（「文件已在目标路径，移动到自己」是同步的常见操作），所以这不是
理论上的畸形请求，而是**线上常态**。

修 DELETE 时踩了一个坑：`deleteBooksInBucket` 是**边翻页边 DELETE** 的，
锁检查写在它之后就永远查不到东西（行已经没了）。新增只读的
`listBooksInBucket`，顺序必须是「先取候选 → 查锁 → 再删」。

---

## 三、鉴权绕过

| 攻击 | 修复前 | 修复后 |
|---|---|---|
| 匿名 COPY 覆盖他人书籍 | `201`，内容变 `ATTACKER-PAYLOAD` | `401`，内容原封不动 |
| 匿名 COPY 塞 `.exe` | `201`，绕过白名单 | `415`，不落库 |
| `Overwrite: F` + 目标存在 | `201`，目标被破坏 | `412` |
| `If-None-Match: *` 撞已有书 | `204`，静默覆盖 | `412` |
| UNLOCK 不带 `Lock-Token` | `204`，**顺手释放了别人的锁** | `400` |

COPY 那条绕过了 `handlePut` 里的**全部三道防线**（口令 / 扩展名白名单 /
每日写节流）—— 因为 `targetId` 取自 `targetBook.id`，直接复用了受害者的 R2 键。
分发处的注释还写着「COPY 走与 PUT 相同的节流即可」，而 `allowWrite` 的唯一
调用点在 `handlePut` 内部。

---

## 四、可用性（匿名即可触发）

| 缺陷 | 修复前 | 修复后 |
|---|---|---|
| PDF 内容嗅探 | **430ms**（必然 Error 1102） | **6ms** |
| PROPPATCH / PROPFIND ReDoS | 24KB → 362ms，48KB → 1448ms | 24KB → **2ms**，384KB → 30ms |
| 超大 DAV 请求体 | 直接进解析器 | 读取阶段截断到 8KB |
| ZIP bomb | 408KB → 解压 400MB | 声明值预检 + 流式上限双防线 |

### PDF 嗅探：三次改法，两个错误中间方案

Workers Free 只有 10ms CPU，而采样是 2MiB。原实现用
「分块 + `String.fromCharCode(...spread)`」拼字符串再跑正则，实测 430ms。

1. 改用 `TextDecoder('latin1')` → 4.2ms，但**发现它其实是 windows-1252**
   （WHATWG Encoding 规范把 latin1 指向后者，`0x80` → U+20AC），
   不满足「字节 ↔ 码位一一映射」的语义承诺。**这个坑是原有代码没有、
   我的第一版改动引入的。**
2. 手写严格 ISO-8859-1 循环 → 60ms，仍然超 6 倍。
3. **逐标记各扫一遍字节** → 7 趟扫描，98–221ms。
4. **单趟字节扫描 + 首字母分派** → 26ms（2MiB）／6ms（512KiB）。
   同时把采样量从 2MiB 降到 512KiB —— 实测同一份 PDF 在两个采样量下
   判定结果完全一致，而 CPU 回到预算内。

结论：**不建字符串**是正解。既避开编码器陷阱，也零分配。

### ZIP bomb：两道防线缺一不可

`PARSE_SIZE_CAP`（50MB）约束的是**压缩前**的文件大小，管不到解压后 ——
两者之间差着膨胀比，这就是绕过它的原因。

- 防线①：中央目录里的 `uncompressedSize` 预检（该字段此前解析了却从未使用）
- 防线②：inflate 逐块读取、越界即 `cancel()`

单靠①不够：声明值可以撒谎（实测构造「声明 1KB、实际 60MB」仍被②拦住）。

顺带修了 `parseEpub` 不捕获 `ZipReadError` 的问题 —— 解析失败应当退回
文件名推导，不该让异常冒泡打断上传。

---

## 五、锁（WebDAV Class 2 的实际可用性）

这是**功能性缺陷**而非合规瑕疵：严格客户端按 `activelock` 取锁，
一把都读不到，锁功能形同虚设。

| 缺陷 | 规范 | 修复 |
|---|---|---|
| `<D:lock>` | §15.7 是 `<!ELEMENT lockdiscovery (activelock)* >` | 改为 `activelock` |
| 子元素顺序 | §14.1 是 `…depth, owner?, timeout?, locktoken?, lockroot` | `timeout` 移到 `locktoken` 前 |
| `<D:supportedlockentry>` | §15.10 是 `lockentry` | 改为 `lockentry` |
| `<D:locktype><D:read/>` | §14.15 是 `<!ELEMENT locktype (write) >`，**没有 read 锁** | 两个条目都是 write |
| LOCK 解析 `<D:scope>` | 规范是 `lockscope` | 修正，**shared 锁不再被静默降级成 exclusive** |
| UNLOCK 错误体 `<D:unlock-response>` | RFC 4918 全文**零命中**（来自未实现的 RFC 3253） | 改为 `lock-token-matches-request-uri` |
| 423 用 `<D:propstat>` | 那是 207 专有容器 | 改为 `<D:error>` + `lock-token-submitted` |

顺带修出一个新 bug：无命名空间前缀的 `lockinfo`（`<lockinfo>` 而非
`<D:lockinfo>`，规范允许）此前解析不到任何字段 —— 原实现全部硬编码 `D:` 前缀。

`test/webdav-class2.test.ts` 里有一条断言 `shared/read` 的测试 ——
**它把 bug 写成了断言**。已改为 `shared/write`。

### 为什么原测试拦不住

`@cloudflare/vitest-pool-workers` 自带的良构检查只验标签配对与命名空间，
**不验 DTD**。新增 `test/lock-xml.test.ts` 按 §14.1 / §15.7 / §14.15
逐条校验元素名与顺序 —— 一条测试同时拦住两个高危。

---

## 六、Cloudflare 成本与容量

### `/最近收录/` 曾是全表扫描

`idx_books_recent(published_at)` 无法与 `status='published'` 等值过滤组合，
SQLite 退化成 `idx_books_status`（对 published 匹配全部 N 行）
+ `USE TEMP B-TREE FOR ORDER BY` → **rows_read = N**。

实测计划（sqlite 复刻全部索引）：
```
修复前：SEARCH books USING INDEX idx_books_status (status=?)
        USE TEMP B-TREE FOR ORDER BY
修复后：SEARCH books USING INDEX idx_books_recent2 (status=?)
20,000 本下：2.7ms / 200 行
```

这条路径是浏览页落地页与 rclone 全库同步的必经之路。20,000 本时仅 250 次
缓存未命中就会打满 D1 的 500 万行/天额度 —— 而 `budget.mjs` 一直假设恒定 200 行。

`allLiveLocks` 同理（`idx_locks_resource` 前导列是 `resource`，对
`expires_at` 过滤无用 → `SCAN locks`）。迁移 0005 补两个索引。

### 分桶计数：全量重建 → 增量更新

写路径原本每次都跑 `DELETE FROM buckets` + 5 条 `GROUP BY`，每条扫一遍
books 全表。实测 @5000 本约 **25,000 行读 + 205 行写**，而 D1 Free 只有
500 万行读/天、10 万行写/天（都是硬停）：

| | 上限 | 全量重算实际能撑 |
|---|---|---|
| 行读 25,000/次 | 5,000,000/天 | **每天约 200 次写操作** |
| 行写 215/次 | 100,000/天 | 每天约 465 次 |

改成 `adjustBuckets`（只重算这本书所属/曾所属的桶），实测：

```
全量重建 rebuildBuckets: 32.71 ms/次
增量更新 adjustBuckets:   7.44 ms/次     4.4×
```

但**增量也算对了才有用** —— `WHERE status=? AND title_letter=?` 原本仍
退化到 `idx_books_status`（匹配全部 N 行），等于增量白做。补上
`(title_letter, status)` 等四个索引后变成 covering index：

```
SEARCH books USING COVERING INDEX idx_books_title_status
      (title_letter=? AND status=?)
2.44ms → 0.088ms        28×
```

`test/classification.test.ts` 用「增量结果必须与全量重算**逐桶相同**」
来断言 —— 增量算错不会报错，只会让导航页页数慢慢对不上，这类 bug 极难发现。

### 平台限额核实（2026-10-14，官方文档 Last updated Oct 12, 2026）

| 项 | Free | 核实结论 |
|---|---|---|
| 请求/天 | 100,000 | 与项目假设一致 |
| CPU/请求 | 10ms | 与项目假设一致 |
| 内存/isolate | 128MB | 与项目假设一致 |
| 子请求/请求 | 50 | 与项目假设一致 |
| **请求体** | **Free/Pro = 100MB** | ⚠️ 与项目假设不一致 |

**请求体上限按账户套餐计算，不是 Workers 套餐** —— 超限在代理层回 413，
请求根本到不了 Worker。所以 `MAX_UPLOAD_BYTES = 200MiB` 的上半段是
「配置说支持、实际永远失败」的死路径。已改为 100MiB，并在
`test/security.test.ts` 加断言防止将来调回去。

网页上传不受此限 —— 它预签名直传 R2，字节不过 Worker，上限单独控制。

---

## 七、人工数据被静默覆盖

`kind_bucket` 有三种来源，但此前无法区分：

| 来源 | 可否被自动覆盖 |
|---|---|
| `sniffed` 内容嗅探 | 可以 |
| `derived` 按扩展名猜 | 可以 |
| `manual` 管理员标注 | **不可以** |

修复前实测：人工把扫描漫画 PDF 标成 `comic` → 跑 `rebucket?sniff=1` → 变回 `ebook`。
根因是 `kindBucket = sniffed ?? mediaKindOfFormat(...)` 的回退分支**丢弃了原值**。

为什么人工标注值得保护：内容嗅探在两种真实情况下必然失效 ——
① PDF 1.5+ 用对象流把字典压起来，标记看不到
② 带 OCR 层的扫描漫画引入字体资源，让「零字体」判据直接崩。
这两类书只能靠人判断，而人判断恰恰是最容易被脚本覆盖的数据。

迁移 0006 加 `kind_source` 列。**测试过程中发现第二处同类 bug**：
最初只保护了标志位 `kind_source`，但 `ON CONFLICT` 里 `kind_bucket`
本身还是无条件覆盖 —— 结果形成「来源标成 manual、值却是机器猜的」这种
自相矛盾状态。两条 SQL 都要用 `books.kind_source`（旧值）做判定。

---

## 八、文档失真订正

| 位置 | 原文 | 实际 |
|---|---|---|
| README:68/331 | 53 个测试 | 253（实测） |
| README:404 | 230 个测试 | 同上 |
| README 已知取舍 | MKCOL 返回 201 | 实际 405 / 403 |
| rfc-compliance §14.12 | ✅ | 元素名与顺序都错 |
| rfc-compliance §9.10.2 | ✅ | 刷新时仍回 `Lock-Token`，且不存在的 token 回 200 |
| security-audit:359 | 「匿名上传有节流兜底」 | `allowWrite` 唯一调用点在 `handlePut` |
| README 通行证 | 「无法被搬到别的 IP」 | 依赖不回落到 X-Forwarded-For |

---

## 九、仍未修的（按建议顺序）

| 优先级 | 项 | 说明 |
|---|---|---|
| ✅ 已修 | `budget.mjs` 建模失真 | 命中率与行写 10-16 实测修掉；**页面浏览量纲重复计数 + 首页未记账** 10-20 修掉；**「每本书 5 条路径」5× 放大** 10-20 修掉（Worker 请求与 R2 Class B 两本账同时改），并补上漏算的叶子 GET 定点行读（1 行，不是一页）。修后默认场景 **15,378 → 55,378（55.4%）**，忙日 3× **166% 会打满**；免费层按默认用量约能装 **9,850 本**。模型里已无已知量纲错 |
| ✅ 已修 | 弱比较 `If-Match` + 条件请求求值顺序 | 2026-10-20：`src/lib/preconditions.ts` 重写 —— If-Match 强比较、§13.2.2 步 1→4 顺序、IUS/IMS 接入、412 与 304 区分。**部分**：完整 `If` 头求值器（`Not`/`[etag]`/多 resource-tag）仍未实现 |
| ✅ 已修 | 多音字上下文表 | 2026-10-20：新增 `src/lib/pinyin-context.ts`（人工维护）。实测清单 62 条 **51.6% → 96.8%**；表外多音字仍会错，边界写在文件头 |
| 🟡 低 | reindex 绕过扩展名白名单 | `.m4a` / `.exe` 经 reindex 直接入库 |
| 🟡 低 | `rebuildBuckets` 剩余调用点 | 集合 DELETE（876/976）仍是全量，属低频可接受 |
| ⚪ 已知边界 | 作者识别残余 ~8.5% | 单字笔名（老舍/阿城）与「姓+2字名」形状相同的书名（白夜 vs 东野圭吾）无法区分，需要外部词库 |

---

## 十一、作者识别：75.2% → 91.5%

新建 `test/author-accuracy.test.ts`（117 条真实中文畅销书）作为**定量基准**。
此前只有举例式断言，无法反映整体水平 —— 这也是为什么中间一次改动能把
准确率从 75% 打到 40% 却没人发现。

| 版本 | 准确率 | 关键改动 |
|---|---|---|
| 基线 | 75.2% | 早期实现用「长度」猜人名 |
| 兜底改方向 | 87.2% | 长度启发在中文上根本不成立 |
| 姓氏长度约束 | 90.6% | 中文书名首字是常见姓氏的概率极高 |
| 书名结构特征 | 91.5% | 「记/传/演义/志」结尾几乎不会是人名 |

### 三次走错的路（都留了记录在测试的注释里）

1. **只扩姓氏表不改兜底** → 掉到 **40%**。所有无姓笔名（紫金陈、老舍、
   加缪、兰陵笑笑生、今何在）全部判反。教训：单个判据改进 ≠ 整体改进。

2. **`TextDecoder('latin1')` 当成 ISO-8859-1** → 在 workerd 里它其实是
   **windows-1252**（`0x80` → U+20AC）。这个坑原有代码没有，是我的第一版
   改动引入的。最终方案是**不建字符串、直接在字节上单趟扫描**。

3. **为单字笔名加规则**（`阿城`）→ 主基准反而从 90.6% 降到 89.7%，
   说明它伤害了其它用例。回滚。

### 残余边界

`老舍`、`阿城` 这类**单字笔名**，以及 `白夜` vs `东野圭吾` 这种形状完全
相同的中文歧义，没有外部词库时无法可靠区分。继续加规则会开始过拟合
测试集 —— 所以这里**刻意停在 91.5%**，并在测试里如实记录边界。

---

## 十、这次审查暴露的方法论问题

1. **「文档声称有防护」比「没有防护」更危险** —— 本项目有三处
   （节流、白名单、lockdiscovery）注释与 README 都声称做了，
   代码里只做了一半或整条路径漏掉。评审时应该反过来看：
   文档声称的每一条防护，都去代码里找**所有**入口。

2. **测试断言的层次决定它能拦住什么** ——
   `toContain('<D:lock>')` 只能证明「字符串在」，证明不了「规范对」。
   DTD 级校验、合规性断言必须显式写出来。

3. **性能优化必须留基准** —— PDF 嗅探的三次错误改法全靠基准测试挡住。
   测试里现在有 `expect(elapsed).toBeLessThan(80)`，慢 40 倍的实现会被拦下。

4. **权威来源要在本地** —— 本仓库有 `refs/rfc4918.txt`。
   本次所有 RFC 引用都先 grep 原文再写，纠正了三条凭记忆会写错的结论
   （`unlock-response` 在 RFC 4918 里零命中、§14.15 没有 read 锁、
   §15.10 是 `lockentry`）。