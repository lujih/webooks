# WebDAV 协议合规审查报告

**审查对象**：`webooks`（Cloudflare Workers + R2 + D1）
**审查基准**：`refs/rfc4918.txt`（WebDAV）、`refs/rfc9110.txt`（HTTP 语义）、`refs/rfc5689.txt`（MKCOL 扩展）
**方法**：逐行读源码 + 在 `refs/*.txt` 中 grep 原文 + 在 workerd 里跑探针实测（探针已删除，源码零改动）

**总评**：DAV 头的诚实性（`1, 2`）与 207 骨架、`propstat` 的 200/404 分组、`getetag` 不转义、href 百分号编码都做得对。
但 **Class 2 锁的 XML 元素名整体写错**，且 **COPY/MOVE 完全没实现 Overwrite 与同源判定** —— 后者会造成**不可逆的数据丢失**。
README「已知取舍」表里记录的偏离（MKCOL 不建目录、Depth 缺失按 1）本次**不重复报告**；下面标注的 ⚪ 都是「偏离本身可以接受，但实现方式引入了新问题」。

---

## 🔴 高危（客户端必然解析失败 / 数据丢失）

### 🔴-1 MOVE 源==目标 时**删掉了自己**，返回 201 而非 403

**文件**：[src/webdav/index.ts:425-430](src/webdav/index.ts#L425-L430)（判定缺失）、[src/webdav/index.ts:448-454](src/webdav/index.ts#L448-L454)（状态码）

**现象**：MOVE 的源与目标解析到同一个 `leafName` 时，`targetBook === sourceBook`，于是先 `BUCKET.put(targetR2Key, sourceObj.body)` 把对象读进内存写回自身，再执行 `isMove` 分支的 `BUCKET.delete(sourceBook.r2_key)` + `deleteBook(sourceBook.id)` —— **资源被彻底销毁**。客户端收到 `201 Created`，以为改名成功。

实测（B1）：
```
PUT /dav/按书名/A/self.epub            → 201
before  [{"id":"a5cd8a4ca97cfd0d","leaf_name":"self.epub","r2_key":"books/a5cd8a4c..."}]
MOVE /dav/按书名/A/self.epub  (Destination: 同一路径)  → 201   ← 规范要求 403
after   []                       ← D1 行没了
R2 object exists? false                 ← 对象没了
后续 GET /dav/按书名/A/self.epub → 404
```

**RFC 原文**：
> **403 (Forbidden)** - Among many possible reasons for forbidding a MOVE operation, this status code is recommended for use when the source and destination resources are the same.
> — `refs/rfc4918.txt` §9.9.4（L2984-L2986）

**复现**：
```bash
B=https://你的域名/dav; T=$WRITE_TOKEN
curl -sX PUT "$B/按书名/A/self.epub" -H "X-Write-Token: $T" \
     -H 'Content-Length: 1' --data-binary 'x'
curl -i -X MOVE "$B/按书名/A/self.epub" -H "X-Write-Token: $T" \
     -H "Destination: https://你的域名/dav/按书名/A/self.epub"
# → 201 + Location（书已消失）
curl -i "$B/按书名/A/self.epub"        # → 404，数据永久丢失
```

**建议修法**：在 `handleMoveCopy` 里，紧接 `targetNode` 判定之后加同源短路。
```ts
if (canonicalDavPath(davPath) === canonicalDavPath(targetDavPath)) {
  return davErrorResponse(403, 'Source and destination are the same resource', ALLOW);
}
```
COPY 到自身是合法的（幂等，见 §9.8.1），但当前实现会**制造孤儿 R2 对象**（见 🔴-4），也应一并处理。

---

### 🔴-2 COPY/MOVE **完全忽略 `Overwrite: F`**，必然破坏目标

**文件**：[src/webdav/index.ts:343-455](src/webdav/index.ts#L343-L455)（全函数无 `overwrite` 读取）

**现象**：`handleMoveCopy` 从未读取 `Overwrite` 头。无论客户端发 `Overwrite: F`，只要目标已存在就直接覆盖/删除。

实测（A5）：
```
s.epub、d.epub 都存在
COPY /dav/按书名/A/s.epub  Destination: .../d.epub  Overwrite: F
→ 201     ← 规范要求 412，且目标必须保持不变
```

**RFC 原文**：
> If the Overwrite header is not included in a COPY or MOVE request, then the resource MUST treat the request as if it has an overwrite header of value "T". […] If a COPY or MOVE is not performed due to the value of the Overwrite header, the method MUST fail with a 412 (Precondition Failed) status code. The server MUST do authorization checks before checking this or any conditional header.
> — `refs/rfc4918.txt` §10.6（L3913-L3927）

> **412 (Precondition Failed)** - […] Specific to MOVE, this could mean that the Overwrite header is "F" and the destination URL is already mapped to a resource.
> — `refs/rfc4918.txt` §9.9.4（L2995-L2997）

**复现**：
```bash
curl -i -X COPY "$B/按书名/A/s.epub" -H "Destination: $B/按书名/A/d.epub" -H 'Overwrite: F'
# → 201（应为 412），且 d.epub 已被覆盖
```

**建议修法**：口令校验之后、任何写操作之前插入
```ts
const overwrite = (request.headers.get('overwrite') ?? 'T').trim().toUpperCase();
const destExists = (await findBookByLeaf(env.DB, targetNode.leafName)) !== null;
if (overwrite === 'F' && destExists) {
  return davErrorResponse(412, 'Destination exists and Overwrite is F', ALLOW,
    'lock-token-matches-request-uri');   // §16 无专用码，用 412 + responsedescription 即可
}
```
注意顺序：§10.6 明确要求**先鉴权后判 Overwrite**，当前代码的 `hasWriteToken` 已在分发层，位置合适。

---

### 🔴-3 MOVE/COPY 覆盖已有目标时返回 **201**，且旧目标对象泄漏

**文件**：[src/webdav/index.ts:448-454](src/webdav/index.ts#L448-L454)

**现象**：无论目标是否已存在，响应恒为 `201 Created`。且当目标已存在时，`targetBook.id` 被复用（`:394`），而**被覆盖掉的旧目标对象从未删除** —— R2 里留下永久孤儿。

实测（B2 / C3）：
```
MOVE /dav/按书名/A/x.epub → Destination: .../y.epub（y.epub 已存在）
→ 201            ← 规范要求 204 No Content
before  [x.epub→books/d1aa2cd1..., y.epub→books/48b4dc53...]
after   [y.epub→books/48b4dc53...]
R2 objects: ["books/06032d6e...", "books/380c19da...", "books/48b4dc53..."]
                    ^^^^^^^^^^^^^^^^^^^ 孤儿：d1aa2cd1 的内容已不复存在任何 D1 行
```

**RFC 原文**：
> **201 (Created)** - The source resource was successfully copied. The COPY operation resulted in the creation of a new resource.
> **204 (No Content)** - The source resource was successfully copied to a preexisting destination resource.
> — `refs/rfc4918.txt` §9.8.5（L2730-L2734）
> MOVE 侧同构：§9.9.4（L2970-L2974）

> If a resource exists at the destination, the destination resource will be deleted as a side-effect of the MOVE operation, subject to the restrictions of the Overwrite header.
> — `refs/rfc4918.txt` §9.9（L2873-L2875）

**复现**：
```bash
curl -i -X MOVE "$B/按书名/A/x.epub" -H "X-Write-Token: $T" -H "Destination: $B/按书名/A/y.epub"
# → 201（应为 204）
```

**建议修法**：
1. 记录 `const destExisted = targetBook !== null`，末尾按它选 `201` / `204`；
2. 若 `destExisted`，在写新对象前 `await env.BUCKET.delete(targetBook.r2_key)` 与 `if (targetBook.cover_key) await env.BUCKET.delete(targetBook.cover_key)` —— 对齐 §9.6「DELETE MUST remove the mapping」；
3. `Location` 头在 204 时也应保留（当前已保留），符合 RFC 9110 §10.2.2。

---

### 🔴-4 `lockdiscovery` 里输出 `<D:lock>`，规范要求 `<D:activelock>`；且子元素顺序违反 DTD

**文件**：[src/lib/locks.ts:318](src/lib/locks.ts#L318)、[src/lib/locks.ts:323-327](src/lib/locks.ts#L323-L327)

**现象**：`lockDiscoveryXml()` 产出 `<D:lockdiscovery><D:lock>…`。RFC 4918 里 **`DAV:lock` 这个元素根本不存在**；内容容器叫 `activelock`。且顺序是 `lockscope, locktype, depth, locktoken, lockroot, timeout`，而 DTD 规定 `timeout` 必须在 `locktoken` **之前**。

实测（A1 原文）：
```xml
<D:lockdiscovery><D:lock>
  <D:lockscope><D:exclusive/></D:lockscope>
  <D:locktype><D:write/></D:locktype>
  <D:depth>infinity</D:depth>
  <D:locktoken><D:href>&lt;urn:uuid:…&gt;</D:href></D:locktoken>
  <D:lockroot><D:href>/按书名/A/probe.epub</D:href></D:lockroot>
  <D:timeout>Second-300</D:timeout>          ← 位置错，应在 locktoken 前
</D:lock></D:lockdiscovery>
```

**RFC 原文**：
> `<!ELEMENT lockdiscovery (activelock)* >`
> — `refs/rfc4918.txt` §15.7（L4794）

> `<!ELEMENT activelock (lockscope, locktype, depth, owner?, timeout?, locktoken?, lockroot)>`
> — `refs/rfc4918.txt` §14.1（L4129-L4130）

> If there are one or more locks, an 'activelock' element appears for each lock on the resource.
> — `refs/rfc4918.txt` §15.7（L4790-L4791）

**影响面**：这条污染了**全部 4 个锁出口** —— LOCK 成功体、423 冲突体（`src/webdav/index.ts:145-170` 与 `:225-237`）、PROPFIND 的 `lockdiscovery` 属性（`src/webdav/propfind.ts:196-202`）。严格客户端（.NET `HttpWebRequest`、SabreDAV、davfs2）按 `activelock` 取锁，会**一个锁都读不到**。`docs/rfc-compliance.md` 里「§14.12 lockdiscovery 结构 ✅」的结论是错的（§14.12 讲的是 `lockroot`，不是容器元素）。

**复现**：
```bash
curl -i -X LOCK "$B/按书名/A/probe.epub" -H 'Content-Type: application/xml' --data-binary \
 '<?xml version="1.0"?><D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>'
# 200 OK，body 里出现 <D:lock> 而非 <D:activelock>
```

**建议修法**：[src/lib/locks.ts:318-328](src/lib/locks.ts#L318-L328) 改标签名并重排顺序（`owner?` 紧跟 `depth`）：
```ts
`<D:lockdiscovery><D:activelock>` +
`<D:lockscope><D:${scope}/></D:lockscope>` +
`<D:locktype><D:write/></D:locktype>` +
`<D:depth>${depth}</D:depth>` +
ownerXml +                                    // owner 必须在 depth 之后
`<D:timeout>Second-${lock.timeoutSec}</D:timeout>` +
`<D:locktoken><D:href>${escapeOwner(lock.token)}</D:href></D:locktoken>` +
`<D:lockroot><D:href>${escapeOwner(requestHref)}</D:href></D:lockroot>` +
`</D:activelock></D:lockdiscovery>`
```
并同步修 `test/xml-wellformed.test.ts:54,63,65` 里硬编码了 `<D:lock>` 的三处断言——**注意**那些测试现在只验良构性，不验 DTD，所以改完它们仍应全绿，但应补一条 `expect(xml).toContain('<D:activelock>')` 兜底。

---

### 🔴-5 `supportedlock` 用 `<D:supportedlockentry>`，并宣告了不存在的 `<D:read/>` 锁类型

**文件**：[src/webdav/propfind.ts:188-195](src/webdav/propfind.ts#L188-L195)

**现象**：RFC 4918 里容器是 `supportedlock`，子项叫 `lockentry`（不是 `supportedlockentry`）；`locktype` 的 DTD 只允许 `write`，而实现宣告了 `shared`+`read` 这一组合 —— 客户端会据此发 LOCK 请求要一个服务端**根本没有实现**的读锁。

实测（A2 原文）：
```xml
<D:supportedlock>
  <D:supportedlockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:supportedlockentry>
  <D:supportedlockentry><D:lockscope><D:shared/></D:lockscope><D:locktype><D:read/></D:locktype></D:supportedlockentry>
</D:supportedlock>
```

**RFC 原文**：
> `<!ELEMENT supportedlock (lockentry)* >`
> — `refs/rfc4918.txt` §15.10（L4916）
> 示例用的是 `<D:lockentry>` —— §15.10.1（L4945-L4955）

> `<!ELEMENT locktype (write) >`
> — `refs/rfc4918.txt` §14.15（L4310）
> "At present, this specification only defines one lock type, the write lock." — §14.15（L4306-L4307）

**建议修法**：改为
```ts
'<D:supportedlock>' +
  '<D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry>' +
  '<D:lockentry><D:lockscope><D:shared/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry>' +
'</D:supportedlock>'
```
（与 §15.10.1 示例一致。`shared` 作用域只在 🔴-7 修好之后才真正可用；在修好之前仍**不应**宣告 `shared`，否则是第二个不实声明。）

---

### 🔴-6 LOCK 解析 `<D:scope>`（正则写错），导致 `shared` 锁被静默降级为 `exclusive`

**文件**：[src/webdav/index.ts:181-182](src/webdav/index.ts#L181-L182)

**现象**：
```ts
const scopeMatch = body.match(/<D:scope><D:(exclusive|shared)\/>/i);
```
正确的元素名是 `lockscope`，不是 `scope`。这个正则**永远匹配不上**，于是 `scope` 恒为 `'exclusive'`，`:198` 又把它当作 `type` 传进 `acquireLock`。

实测（B4）：客户端请求 `<D:lockscope><D:shared/></D:lockscope>`，服务端回的却是 `<D:lockscope><D:exclusive/></D:lockscope>`。
同理 `:179` 的 `/<D:(exclusive|write)\/>/i` 把 `<D:exclusive/>`（lockscope 的内容）误认成 locktype —— `:180` 写死 `type ? 'exclusive' : 'exclusive'`，说明作者自己也知道这是死代码。

**RFC 原文**：
> `<!ELEMENT lockscope (exclusive | shared) >` — §14.13（`refs/rfc4918.txt` L4286）
> `<!ELEMENT lockinfo (lockscope, locktype, owner?) >` — §14.11（L4263）
> `<!ELEMENT locktype (write) >` — §14.15（L4310）

**建议修法**：不要用正则解析 XML，至少改成按 `locktype`/`lockscope` 分别取：
```ts
const scope = /<[A-Za-z0-9_.-]+:lockscope>\s*<[A-Za-z0-9_.-]+:(exclusive|shared)\s*\/?>/i.exec(body)?.[1] ?? 'exclusive';
const lockType = /<[A-Za-z0-9_.-]+:locktype>\s*<[A-Za-z0-9_.-]+:(write|read)\s*\/?>/i.exec(body)?.[1] ?? 'write';
```
并把 `type` 与 `scope` 拆成两个字段传给 `acquireLock`（现在 `LockRow.type` 一个字段兼表 scope 和 type，是 🔴-5/🔴-7 的根因）。

---

### 🔴-7 UNLOCK 错误体用 `<D:unlock-response>`，RFC 4918 未定义此元素

**文件**：[src/webdav/index.ts:259-265](src/webdav/index.ts#L259-L265)

**现象**：在 `refs/rfc4918.txt` 全文 grep `unlock-response` **零命中**。该元素来自 RFC 3253（DeltaV，本项目未实现 DeltaV）。RFC 4918 要求的预置元素是 `lock-token-matches-request-uri`（§16，L5042-L5051）。

实测（A9）：
```
UNLOCK + Lock-Token: <urn:uuid:0000...>
→ 409，body: <D:unlock-response><D:href>/按书名/A/u.epub</D:href></D:unlock-response>
```

**RFC 原文**：
> **409 (Conflict), with 'lock-token-matches-request-uri' precondition** - The resource was not locked, or the request was made to a Request-URI that was not within the scope of the lock.
> — `refs/rfc4918.txt` §9.11.1（L3466-L3468）
> Name: `lock-token-matches-request-uri` / Use with: 409 Conflict — §16（L5042-L5051）

**建议修法**：
```ts
return davErrorResponse(live ? 423 : 409, 'No such lock, or Request-URI outside its scope', ALLOW,
                        'lock-token-matches-request-uri');
```
注意 `davErrorResponse`（`src/webdav/index.ts:464`）已经**定义好但从未被调用** —— 正好是这个修法的落点。

---

### 🔴-8 UNLOCK 不带 `Lock-Token` 头时**静默释放锁并返回 204**（§9.11.1 要求 400）

**文件**：[src/webdav/index.ts:246-253](src/webdav/index.ts#L246-L253)

**现象**：
```ts
if (!tokenHeader) {
  const own = await env.DB.prepare(`SELECT token FROM locks WHERE resource = ? …`).…
  if (own) await releaseLock(env.DB, own.token);
  return new Response(null, { status: 204 });
}
```
没有 `Lock-Token` 头时，不是 400，而是**按 davPath 精确匹配把锁悄悄删掉**。这既是状态码错误，也是**未授权的锁破坏**：`UNLOCK /集合/ ` 能干掉集合上的根锁。

实测（A8）：
```
先 LOCK /dav/按书名/A/u.epub，再裸发 UNLOCK（无 Lock-Token 头）
→ 204    ← 规范要求 400 Bad Request
```

**RFC 原文**：
> **400 (Bad Request)** - No lock token was provided.
> — `refs/rfc4918.txt` §9.11.1（L3461）
> The UNLOCK method removes the lock identified by the lock token in the Lock-Token request header. — §9.11（L3426-L3427）

**建议修法**：
```ts
if (!tokenHeader) return davErrorResponse(400, 'Lock-Token header required', ALLOW);
```
同时保留 `Lock-Token` 与「请求 URI 落在该锁作用域内」的校验 —— 后者现在用 `liveLockForResource`（会向上匹配祖先锁）而非精确匹配，语义也要收紧到 §10.5「MUST identify a lock that contains the resource identified by Request-URI as a member」。

---

### 🔴-9 DELETE 集合会**删掉被锁住的成员**，返回 204

**文件**：[src/webdav/index.ts:767-782](src/webdav/index.ts#L767-L782)

**现象**：`handleDelete` 对 `nav`/`list` 节点直接 `deleteBooksInBucket()` 递归删除，**不检查成员上的活锁**。分发层 `handleLockedWrite`（`:122`）只对 `davPath` **自身**做锁检查，而集合删除要动的是它的成员。实测（C9）：

```
PUT /dav/按书名/A/q.epub
LOCK /dav/按书名/A/q.epub            → 200（活锁生效）
DELETE /dav/按书名/A/                → 204     ← 成员 q.epub 被删掉了
remaining rows: [{"leaf_name":"q.epub"}]   ← D1 行还在（R2 对象已删）
```
注意最后一行暴露了**第二个问题**：`deleteBooksInBucket` 只删 D1 行，R2 对象与 `cover_key` 在集合路径上没被清理（`:771-774` 的 `for (const b of removed)` 遍历返回值，若该函数不返回 R2 键则会泄漏——需另行确认，但存储泄漏风险已成立）。

**RFC 原文**：
> A server processing a successful DELETE request: **MUST destroy locks rooted on the deleted resource** … **MUST remove the mapping from the Request-URI to any resource.**
> — `refs/rfc4918.txt` §9.6（L2443-L2447）
> If an error occurs deleting a member resource […] then the response **can** be a 207 (Multi-Status). […] the Multi-Status body could include a response with status 423 (Locked) if an internal resource was locked.
> — §9.6.1（L2475-L2481）
> Of the methods defined in HTTP and WebDAV, PUT, POST, PROPPATCH, LOCK, UNLOCK, MOVE, COPY (for the destination resource), **DELETE**, and MKCOL are affected by write locks.
> — §7（L1160-L1164）

**复现**：
```bash
curl -i -X LOCK "$B/按书名/A/q.epub" --data-binary '…lockinfo…'
curl -i -X DELETE "$B/按书名/A/" -H "X-Write-Token: $T"   # → 204，锁内的书没了
```

**状态：已修复**（本条实际是三个独立缺陷，逐个定论）

1. **成员锁被无视** —— 已修复（`1e9306c`）。修法不是本条原先建议的 207 逐条，而是**在删除前整体拒绝**：`handleDelete` 的集合分支先用**只读**的 `listBooksInBucket` 取候选、再取 `allLiveLocks(env.DB)`，凡命中候选的 leaf_name 就 `return lockConflictResponse(lock, resource)`（423）。
   - 为什么不用 207：集合删除只删 D1/R2，成员一个都没删成功就整体不删，退回 423 比「删了一半再回报 207」对客户端更安全（207 会让同步引擎以为部分成功）。
   - 修的过程中踩到一个值得记的坑：最初用 `deleteBooksInBucket`（边翻页边 DELETE）当候选来源，于是「检查时行已经没了」，锁检查永远查不到东西 → 必须用只读的 `listBooksInBucket`。
   - 比对只看末段 `leaf_name`：叶子是全局唯一查找，同一本书在任何桶下都指向同一资源，锁不该因路径写法不同而失效。

2. **`releaseLock` 传的是资源路径（§9.6 MUST destroy 未实现）** —— 已修复（本次，task-13）。`handleDelete` 的成功路径原先完全不碰 locks 表，集合分支同样不碰：删掉的书在 TTL（最长 3600s）内**无法被同一路径重新创建**（DELETE 204 后同路径 PUT → 423）。修法：
   - 新增 `releaseLocksForResource(db, resourcePath)` —— 参数名刻意叫 `resourcePath` 防复发（「路径与 token 都是 string」这个坑已踩两次：`0b8e38b` 的 `handleUnlock`、`9071c1b` 的 MOVE）；尾斜杠两种形态 + 子树 `LIKE '…/%'` 都覆盖；根路径只删根锁本身（前缀匹配会清空全库的锁）。
   - 新增 `releaseLocksForLeafNames(db, leafNames)` —— 一本书有多个别名路径（按书名/按作者/按格式/最近收录），§9.6 针对的是**资源**而不是「这次请求用的那条路径」。
   - 叶子 DELETE / 集合 DELETE / MOVE 源 / 管理后台 `/api/admin/delete` 四处都接上了。
   - MOVE 分支里那句 `await releaseLock(env.DB, davPath)`（把路径当 token，`9071c1b` 引入）已被 `releaseLocksForResource` 取代 —— 原语句只匹配零行、静默空操作。

3. **`deleteBooksInBucket` 疑似漏删 R2 对象** —— **不成立**（已核实）。当前 `handleDelete` 集合分支明确遍历 `for (const b of removed)` 删 `b.r2_key` 与 `b.cover_key`；本条当初的「需另行确认」以实测为准：无泄漏。

**验证**（`test/lock-lifecycle.test.ts`，7 例）：`LOCK → 带 If 令牌 DELETE → 204` 后断言 `SELECT token, resource FROM locks` **为空**（DB 事实）**且**同一路径再 PUT 得 **201**（用户可见状态码）；集合删除后集合自身锁 + 成员残留锁都清空；别名路径（`/recent/` 这种 ASCII 形态）建的集合锁也必须能按别名路径删掉；MOVE 后源锁清空；admin delete 后清空。每组都带**负向控制**（不带 If 令牌仍 423），否则「锁整个不生效了」会让所有断言一起假绿。变异验证 6 组全部变红（详见 task-13 报告）。

> 别名那条是**真机验证时抓到的漏网**：helper 最初只做 `decodeDavPath`（管百分号编码，不管别名），而单测的路径恰好全都是规范形态，于是「LOCK `/recent/` → DELETE `/recent/`」在真机上留下 `resource = /最近收录/` 的残锁、单测却全绿。现在 helper 用 `canonicalDavPath` 归一，并补了这条回归用例（变异：把归一改回 `decodeDavPath` → 该条变红）。

---

## 🟠 中危（状态码错 / 条件请求语义错）

### 🟠-1 `If` 头几乎不被求值：带不相关 token 的 PUT 返回 204 而非 412

**文件**：[src/webdav/index.ts:131-142](src/webdav/index.ts#L131-L142)

**现象**：`handleLockedWrite` 只在资源**已有活锁**时才读 `If` 头，且只做「token 在不在列表里」的子串判断。资源无锁时，`If` 头**被完全忽略** —— 无论里面的状态列表是全真还是全假。

实测（C5）：
```
PUT /dav/按书名/A/if.epub   If: (<urn:uuid:11111111-1111-1111-1111-111111111111>)
→ 204    ← §10.4.1 要求 412 Precondition Failed
```

**RFC 原文**：
> The first purpose is to make a request conditional by supplying a series of state lists with conditions that match tokens and ETags to a specific resource. **If this header is evaluated and all state lists fail, then the request MUST fail with a 412 (Precondition Failed) status.**
> — `refs/rfc4918.txt` §10.4.1（L3644-L3648）
> While the Overwrite header appears to duplicate the functionality of using an "If-Match: *" header, **If-Match applies only to the Request-URI, and not to the Destination of a COPY or MOVE.** — §10.6（L3919-L3922）

**建议修法**：`src/lib/preconditions.ts` 目前只处理 If-Match/If-None-Match。建议新增一个最小可用的 `If` 求值器：解析 `List` 序列（`(Cond | [etag] | Not Cond)*`），对 Request-URI 与 Destination 两个 resource-tag 分别求值，任一 tag 下所有 list 全失败即 412；**不要**只做正则抽 token。同时把 §10.4.1 第二用途记在注释里 —— token 出现在 `If` 里即算「已提交」，与是否求值通过无关。

**进展（task-13，部分修复）**：本条**只**解决了「MOVE/COPY 完全不看 `If` 头」这一个子问题 —— 修复前 `handleMoveCopy` 的锁检查是裸的 `liveLockForResource` 循环，导致**持锁者自己带正确令牌也被 423**（违反 §9.9.1）。现在 MOVE/COPY 的锁检查复用 `ifTokenAuthorizes()`（与 PUT/DELETE 同一判据：`extractLockTokens(ifHeader)` ∩ `stripBrackets(lock.token)`）。
完整的 `If` 求值器（含 `[etag]`、`Not`、多 resource-tag、无锁时的 412）**仍未实现**，本条其余部分继续有效。

### 🟠-2 `If-Match` 用了**弱比较**（剥掉 `W/` 前缀），且 `If-Match` 与 `If-None-Match` 语义被同一条代码路径处理

**文件**：[src/lib/preconditions.ts:31-32](src/lib/preconditions.ts#L31-L32)

**现象**：
```ts
// 弱比较：W/"x" 与 "x" 在 If-None-Match 下等价；这里统一剥掉 W/ 前缀
.map((t) => (t.startsWith('W/') ? t.slice(2) : t));
```
这行注释自己承认只对 If-None-Match 成立，但 `parseTagList` 被 `If-Match` 和 `If-None-Match` **共用**。

实测（A15）：
```
HEAD → ETag: "9dd4e461268c8034f5c8564e155c67a6"
PUT ... If-Match: W/"9dd4e461268c8034f5c8564e155c67a6"
→ 204    ← 规范要求 412
```

**RFC 原文**：
> An origin server **MUST use the strong comparison function when comparing entity tags for If-Match** (§8.8.3.2), since the client intends this precondition to prevent the method from being applied if there have been any changes to the representation data.
> — `refs/rfc9110.txt` §13.1.1（L5794-L5797）
> A recipient **MUST use the weak comparison function** when comparing entity tags for If-None-Match.
> — `refs/rfc9110.txt` §13.1.2（L5880-L5883）

**建议修法**：`parseTagList(header, 'strong' | 'weak')`，strong 模式**原样**保留 `W/` 并在比较时拒绝任何带 `W/` 的标签。

### 🟠-3 条件请求求值顺序未按 §13.2.2 实现，且 `If-Unmodified-Since` 缺失

**文件**：[src/lib/preconditions.ts:42-77](src/lib/preconditions.ts#L42-L77)、[src/lib/preconditions.ts:80-87](src/lib/preconditions.ts#L80-L87)

**现象**：
1. `checkPreconditions` 只按 If-Match → If-None-Match 的固定顺序（碰巧与 §13.2.2 的 1→3 一致，这点**没问题**），但 **`If-Unmodified-Since` 与 `If-Modified-Since` 完全没有参与 `checkPreconditions`**。`isModifiedSince()`（`:80`）是个**从未被调用**的死函数，注释里还写着「暂未启用」。
2. 更要紧的是 §13.2.2 的第 1 步前置了第 3 步：只有当 **If-Match 不存在**时才轮到 If-Unmodified-Since。当前代码在 If-Match 失败后立刻 412，恰好等价；但一旦补上 If-Unmodified-Since，若两者同时出现且 If-Match 失败，应直接 412 而**不**再评估 date 条件 —— 现在的骨架能容纳，只是没实现。
3. §13.2.1 还有一条被违反：预条件求值必须**晚于**常规检查、早于方法体。当前 `handlePut` 在 `:600-603` 先做了 `unauthorizedResponse`（401）、在 `:614` 才求值预条件 —— 顺序是对的 ✅。

**RFC 原文**：
> A recipient cache or origin server MUST evaluate the request preconditions defined by this specification in the following order: 1. […] If-Match […] 2. […] If-Match is not present, and If-Unmodified-Since is present […] 3. When If-None-Match is present […] 4. When the method is GET or HEAD, If-None-Match is not present, and If-Modified-Since is present […] 5. When the method is GET and both Range and If-Range are present […]
> — `refs/rfc9110.txt` §13.2.2（L6233-L6273）
> *if false for GET/HEAD, respond 304 (Not Modified); if false for other methods, respond 412 (Precondition Failed)* — §13.2.2 step 3（L6260-L6262）

**建议修法**：把 `checkPreconditions` 改成返回**状态码**而不只是 ok/reason，让 304 与 412 能自然区分；补 `If-Unmodified-Since`（PUT/DELETE 语义，失败 412）与 `If-Modified-Since`（GET/HEAD 语义，失败 304）。GET 走 302 转 R2，这块见 🟡-3。

**进展（2026-10-20，🟠-2 与 🟠-3 已修复）**：`src/lib/preconditions.ts` 重写，
`checkPreconditions({ method, headers, current })` 现在严格按 §13.2.2 步 1→4 求值：

- **步 1 If-Match**：改为**强比较**（§8.8.3.2）。`If-Match: W/"x"` 对强 ETag `"x"`
  **不再匹配**（实测 412，修复前是 204）。根因正如本条诊断的 ——「比较函数」被写进了
  「解析」里：现在 `parseTagList` 只拆语法（保留 weak 标记），强弱由求值时的
  `strongEqual` / `weakEqual` 决定。
- **步 2 If-Unmodified-Since**：仅在 If-Match **缺失**时求值，失败 412，用
  `books.updated_at` 作验证器（语义是该行最后一次写入，不是 ISBN）。
- **步 3 If-None-Match**：弱比较不变；失败按 §13.2.2 分叉 —— GET/HEAD → **304**，
  其他方法 → **412**。返回值从 `{ok}` 改为带 `status: 412 | 304`。
- **步 4 If-Modified-Since**：仅 GET/HEAD **且 If-None-Match 缺失**时求值，失败 304。
  `isModifiedSince()` 那个从未被调用的死函数已删除。
- **接入范围**：PUT、DELETE（叶子 + 集合）、HEAD leaf。GET leaf 刻意**不**求值
  （302 不是 2xx，§13.2.1 要求忽略预条件）。

**踩到并修掉的两个单位坑**（都留了注释，因为很容易再犯）：
1. `parseHttpDate()` 原本返回**毫秒**，而 `toEpochSeconds()` 返回**秒** —— 两个数字
   直接比较，等于把秒当毫秒：IUS 永远成立（客户端永远传不上书）、IMS 永远命中
   （客户端永远拿到 304）。现在全文件 epoch **一律整秒**。
2. `books.updated_at` 带毫秒、`Last-Modified` 只到秒，不截断会让 304 永不发生。

**顺带修掉的一个真 bug**：旧实现用 `existing?.etag ? … : null` 兼任「资源不存在」，
于是 **etag 为 NULL 的存量行**（迁移前写入 / COPY 出来的目标行）被判成不存在 ——
`If-None-Match: *` 本该 412 防误覆盖，却被放行，而且 `handlePut` 的 `onlyIfAbsent`
会因此**跳过写口令**，等于零凭据覆盖他人书籍。现在 `exists` 与 `etag` 是两个独立
字段（`CurrentRepresentation`），`*` 只取决于存在性。

**仍未实现（如实记录，不是漏做）**：§13.2.2 步 5（Range/If-Range，字节不经 Worker）；
`GET /dav/<书>` 的 304（302 边界，见 §13.2.1）；目录集合的 304（没有「集合自身修改
时间」这条数据，用合成 ETag 回 304 等于伪造「内容没变」）；🟠-1 的完整 `If` 求值器
（`Not`、`[etag]`、多 resource-tag）仍**未**实现，本条修复不含它。

### 🟠-4 LOCK 刷新对**不存在的 token** 返回 200 并**新造一把锁**，应为 412

**文件**：[src/webdav/index.ts:190-192](src/webdav/index.ts#L190-L192)、[src/lib/locks.ts:99-125](src/lib/locks.ts#L99-L125)、[src/lib/locks.ts:172](src/lib/locks.ts#L172)

**现象**：`handleLock` 从 `If` 头抽出一个 token 交给 `acquireLock`。若该 token 在库里查不到（过期/不存在/属于别的资源），`acquireLock` 的刷新分支 `:100` 查不到就**继续往下走新锁流程**，凭空创建一把新锁，并因 `isRefresh: Boolean(opts.refreshToken)` 而**回一个 `Lock-Token` 响应头**。

实测（A11）：
```
LOCK /dav/按书名/A/x.epub        → 拿到 token T
LOCK /dav/按书名/A/y.epub  If: (T)     ← T 不覆盖 y.epub
→ 200 + Lock-Token: <新 token>       ← 规范要求 412 lock-token-matches-request-uri
```

**RFC 原文**：
> A lock is refreshed by sending a LOCK request to the URL of a resource within the scope of the lock. This request MUST NOT have a body and it MUST specify which lock to refresh by using the 'If' header with a single lock token…
> — `refs/rfc4918.txt` §9.10.2（L3120-L3124）
> **412 (Precondition Failed), with 'lock-token-matches-request-uri' precondition code** - The LOCK request was made with an If header, indicating that the client wishes to refresh the given lock. However, the Request-URI did not fall within the scope of the lock identified by the token. The lock may have a scope that does not include the Request-URI, or the lock could have disappeared, or the token may be invalid.
> — §9.10.6（L3228-L3234）

**另**：`§9.10.2` 明确「The Lock-Token header is **not** returned** in the response for a successful refresh LOCK request」（L3132-L3134），但当前刷新路径照样发（实测 A10：`refresh status 200 lock-token hdr <urn:uuid:…>`）。这与 `docs/rfc-compliance.md` 里写的「刷新时不回 Lock-Token 头 ✅」**不符** —— 文档结论是错的。

**建议修法**：`acquireLock` 里当 `refreshToken` 非空但查不到时抛 `err.lockTokenMismatch = true`；`handleLock` catch 该错误返回
```ts
davErrorResponse(412, 'Lock token does not match Request-URI', ALLOW, 'lock-token-matches-request-uri')
```
并按 `isRefresh` 决定是否发 `Lock-Token` 头（刷新时**不发**）。

### 🟠-5 LOCK 到**未映射 URL** 返回 200；规范要求 201 + 创建空资源

**文件**：[src/webdav/index.ts:214-220](src/webdav/index.ts#L214-L220)

**现象**：`handleLock` 不区分资源是否已存在，一律 200。

实测（A13）：
```
LOCK /dav/按书名/A/ghost.epub（该书不存在）
→ 200    ← 规范要求 201 Created，且空资源必须出现在 PROPFIND 里
```

**RFC 原文**：
> **201 (Created)** - The LOCK request was to an unmapped URL, the request succeeded and resulted in the creation of a new resource, and the value of the DAV:lockdiscovery property is included in the response body.
> — `refs/rfc4918.txt` §9.10.6（L3212-L3215）
> A successful LOCK method **MUST** result in the creation of an empty resource that is locked (and that is not a collection) when a resource did not previously exist at that URL. […] Empty resources **MUST** then appear in PROPFIND responses including that URL in the response scope.
> — §9.10.4（L3169-L3175）

**建议修法**：`handleLock` 先 `findBookByLeaf`，不存在则登记一行 size=0 的空书（复用 `upsertBook`）并 `purgeEntries`，响应改 201。这条实现起来有成本，但只要不打算做，也**必须在 §9.10.4 上明确记为取舍** —— 因为它会让 litmus `locks` 套件的 `lock_null` 用例失败。

### 🟠-6 LOCK 接受 `Depth: 1`；`§9.10.3` 只允许 `0` 或 `infinity`

**文件**：[src/webdav/index.ts:183-184](src/webdav/index.ts#L183-L184)

**现象**：`depthMatch = body.match(/<D:depth>(\w+)<\/D:depth>/i)` —— **从请求体里取 depth**（LOCK 的 Depth 是**请求头**，不在体里），且接受任意 `\w+`。客户端发 `Depth: 1` 请求头时被完全忽略；发体里的伪 depth 则被采纳。

实测（A12）：
```
LOCK /dav/按书名/A/d1/   Depth: 1
→ 200，回 <D:depth>infinity</D:depth>
```
（实际行为是「忽略请求头、按 infinity 处理」，恰好落在规范允许的值内 —— 但它**不是靠校验实现的**，客户端发 `Depth: 2` 也会静默变 infinity，属于把错误输入当对处理。）

**RFC 原文**：
> The Depth header may be used with the LOCK method. **Values other than 0 or infinity MUST NOT be used with the Depth header on a LOCK method.** […] A server **MUST ignore the Depth header on a LOCK refresh.**
> If no Depth header is submitted on a LOCK request, then the request **MUST** act as if a "Depth:infinity" had been submitted.
> — `refs/rfc4918.txt` §9.10.3（L3138-L3141、L3126、L3163-L3164）

**建议修法**：改读 `request.headers.get('depth')`，只接受 `'0'` 与 `'infinity'`（缺省 → `'infinity'`，刷新路径直接忽略），其余值回 400；同时删掉从 body 取 depth 的那段。

### 🟠-7 423 响应体塞了 `<D:propstat>` 与 `<D:lockdiscovery>`，但缺 `lock-token-submitted`

**文件**：[src/webdav/index.ts:144-171](src/webdav/index.ts#L144-L171)（`lockConflictResponse`，被 PUT/DELETE/MOVE/COPY 共用）

**现象**：423 的 body 是 `<D:response>` 包 `<D:propstat>` + `<D:lockdiscovery>`。`<D:propstat>` 只在 `multistatus`/`response` 语义下有意义，塞进单个 423 响应属结构误用；更实际的问题是**该带的预置条件元素一个都没有**。

实测（A16 / B5 / B6）：
```
DELETE 锁定资源 → 423，body 含 lock-token-submitted? false
LOCK 冲突      → 423，body 含 no-conflicting-lock?      false
```

**RFC 原文**：
> **423 (Locked)** - The source or destination resource, the source or destination resource parent, or some resource within the source or destination collection, was locked. This response **SHOULD** contain the 'lock-token-submitted' precondition element.
> — `refs/rfc4918.txt` §9.9.4（L2999-L3002）
> The 423 (Locked) status code means the source or destination resource of a method is locked. This response **SHOULD** contain an appropriate precondition or postcondition code, such as 'lock-token-submitted' or 'no-conflicting-lock'.
> — `refs/rfc4918.txt` §11.3（L4023-L4026）
> `<!ELEMENT lock-token-submitted (href+) >` — §16（L5070）

**建议修法**：把 `lockConflictResponse` 的 body 改成规范的 `<D:error>` + 对应前置条件（复用那个已定义但从未调用的 `davErrorResponse`）：
```ts
// 写操作撞锁
davErrorResponse(423, 'Resource is locked', ALLOW, 'lock-token-submitted')  // 需扩成带 href 的形式
// LOCK 请求撞锁
davErrorResponse(423, 'Conflicting lock exists', ALLOW, 'no-conflicting-lock')
```
若要保留给客户端看锁信息，可另发 `Lock-Token` 响应头（当前 `:168` 已这么做 ✅）。

### 🟠-8 MKCOL 不检查请求体 → 缺 415；且未映射路径缺 409

**文件**：[src/webdav/index.ts:273-300](src/webdav/index.ts#L273-L300)

**现象**（两项）：
1. `handleMkcol` **从不读 `request.body`**，因此对任何实体类型都不会回 415。
2. 父集合不存在时返回 **403**（`valid-resourcetype`），规范要求 **409**。

实测（A7 / C10 / B14）：
```
MKCOL /dav/按书名/A/newdir/  Content-Type: application/xml  body: '<garbage/>' → 403（应 415）
MKCOL /dav/按书名/ZZ/deep/  （父 ZZ/ 不存在）                → 403（应 409）
```

**RFC 原文**：
> When the MKCOL operation creates a new collection resource, **all ancestors MUST already exist, or the method MUST fail with a 409 (Conflict) status code.** For example, if a request to create collection /a/b/c/d/ is made, and /a/b/c/ does not exist, the request must fail.
> — `refs/rfc4918.txt` §9.3（L2342-L2346）
> If the server receives a MKCOL request entity type it does not support or understand, it **MUST respond with a 415 (Unsupported Media Type)** status code.
> — §9.3（L2357-L2358）

**建议修法**：在 `handleMkcol` 开头加
```ts
if (request.headers.get('content-length') && Number(request.headers.get('content-length')) > 0) {
  const ct = request.headers.get('content-type') ?? '';
  // 只接受 RFC 5689 §3.1 的 mkcol 体；其余 415
  if (!/application\/xml|text\/xml/i.test(ct))
    return davErrorResponse(415, 'MKCOL body must be application/xml (RFC 5689)', ALLOW);
}
```
父不存在的 409 判定放在 `alreadyMapped` 之前：`node.kind === 'unknown'` 时看第一段是否是已知集合段，不是则 409。

---

## 🟡 低危

### 🟡-1 PROPFIND / PROPPATCH **丢弃属性命名空间**，且不校验 XML 良构性

**文件**：[src/lib/xml.ts:29-41](src/lib/xml.ts#L29-L41)、[src/webdav/propfind.ts:42-63](src/webdav/propfind.ts#L42-L63)、[src/webdav/index.ts:317-326](src/webdav/index.ts#L317-L326)

**现象**：属性名正则只捕获 local name，响应里一律输出 `<D:name/>`。请求里的 `xmlns:Z="http://ns.example.com/z39.50/"` 被完全遗忘 —— 客户端收到的是「Z 命名空间的属性变成了 DAV: 命名空间的属性」。且畸形 XML body 不回 400。

实测（A19 / A6b / A17）：
```
PROPFIND <D:prop><Z:Authors/></D:prop>  (xmlns:Z=…z39.50/)
→ 207，404 propstat 里是 <D:Authors/>       ← 命名空间被偷换成 DAV:
PROPPATCH body: 'not xml at all <<<'      → 207（应 400）
PROPFIND  body: '<<< not xml'             → 207（应 400）
PROPPATCH 合法 foreign-ns body → 207，<D:Author/>   ← <Z:Author> 变成 DAV 命名空间
```

**RFC 原文**：
> All XML used in either requests or responses **MUST be, at minimum, well formed and use namespaces correctly. If a server receives XML that is not well-formed, then the server MUST reject the entire request with a 400 (Bad Request).**
> — `refs/rfc4918.txt` §8.2（L1567-L1571）
> 元素命名空间须保留的形态见 §9.2.2 示例（L2308-L2324）：`<D:prop><Z:Authors/></D:prop>`。

**建议修法**：`TAG_RE` 改为捕获完整 `prefix:local`，并在 207 里**重放请求里的 `xmlns:` 声明**（把 `propfind` body 的 xmlns 收集起来输出到 `<D:multistatus>` 上，这正是 §9.2.2 示例的形状）。入参侧加一个廉价的良构性守卫（不引 XML 库：检查标签配对与首字符），失败即 400。注意这会让 `handleProppatch` 的 403 断言仍然成立，只是命名空间正确。

### 🟡-2 `allprop` 的 `include` 子元素被静默忽略

**文件**：[src/webdav/propfind.ts:47-48](src/webdav/propfind.ts#L47-L48)

**现象**：`/<...propname\b/` 与 `/<...allprop\b/` 命中即返回，`<D:include>` 的内容直接丢弃。

实测（A18）：请求 `<D:allprop><D:include><D:getetag/></D:include></D:allprop>` 侥幸含 etag（因为 allprop 本来就全给），但 `include` 对任何 `allprop` 之外的属性都无效。

**RFC 原文**：
> Request property values for those properties defined in this specification (at a minimum) plus dead properties, by using the 'allprop' element (**the 'include' element can be used with 'allprop' to instruct the server to also include additional live properties that may not have been returned otherwise**)
> — `refs/rfc4918.txt` §9.1（L1800-L1804）

**建议修法**：`parsePropfindBody` 在 allprop 分支里额外收集 `include` 内的名字，`renderProps` 把它们并入 `wanted`。

### 🟡-3 GET 返回 302 但**不带 ETag / Last-Modified**；`Range` 头在 Worker 层完全不处理；`If-None-Match` 不产生 304

**文件**：[src/webdav/index.ts:513-521](src/webdav/index.ts#L513-L521)

**现象**：`handleGet` 的 302 只有 `location` / `cache-control: no-store` / `accept-ranges`。而 HEAD 分支（`:496-507`）**有**完整 ETag/Last-Modified —— 两者不一致，违反「HEAD 与 GET 语义相同」。带 `Range` 或 `If-None-Match` 也都只是原样 302。

实测（A20 / C7 / C8）：
```
GET  … Range: bytes=0-1   → 302，etag null，last-modified null
GET  … If-None-Match: <现有 etag>  → 302（规范：304）
GET → 302   HEAD → 200   ← 同一资源两个状态码
```

**RFC 原文**：
> *if false for GET/HEAD, respond 304 (Not Modified)* — `refs/rfc9110.txt` §13.2.2 step 3（L6260）
> While conditional request header fields are defined as being usable with the HEAD method (to keep HEAD's semantics consistent with those of GET)…
> — `refs/rfc9110.txt` §13.2.1（L6215-L6217）
> A client **MUST NOT assume that receiving an Accept-Ranges field means that future range requests will return partial responses.**
> — `refs/rfc9110.txt` §14.3（L6567-L6568）

**说明**：`docs/rfc-compliance.md` 把「Range 是建议性的，GET 返 302 交由 CDN 处理」列为 ✅ —— 作为**取舍**我认可（304/206 由 R2 自定义域终结）。但「302 与 HEAD 状态码不一致」不是取舍，是**实现疏漏**，且会破坏 `If-None-Match` 去重。

**建议修法**：在 302 上补 `etag` 与 `last-modified`（HEAD 分支已有，直接复用），并对 `If-None-Match` 命中 / `If-Modified-Since` 未变的情况在 Worker 侧直接回 304（RFC 9110 §15.4.5 允许 304 自带 ETag/Last-Modified/Cache-Control）。

### 🟡-4 `lockroot` / `lockConflictResponse` 的 href **未做百分号编码**，与同级 `<D:href>` 格式不一致

**文件**：[src/webdav/index.ts:158](src/webdav/index.ts#L158)、[src/webdav/index.ts:227](src/webdav/index.ts#L227)、[src/webdav/propfind.ts:467](src/webdav/propfind.ts#L467)

**现象**：PROPFIND 的 `<D:response><D:href>` 经 `encodeHref()` 编码，但同一条 `<D:response>` 里 `lockdiscovery/lockroot` 的 href 是**原始中文**。非 ASCII 文件名一出现，两个 href 就不再指向同一资源。

实测（C1 原文，同一条 response 内）：
```xml
<D:response>
  <D:href>/dav/%E6%8C%89%E4%B9%A6%E5%90%8D/A/aa.epub</D:href>      ← 编码
  <D:propstat><D:prop><D:lockdiscovery><D:lock>
    …
    <D:lockroot><D:href>/dav/按书名/A/aa.epub</D:href></D:lockroot>   ← 未编码
```

**RFC 原文**：
> The rules in this section apply not only to resource URLs in the 'href' element in Multi-Status responses, but also to the Destination and If header resource URLs. […] **A server MUST ensure that every 'href' value within a Multi-Status response uses the same format.**
> — `refs/rfc4918.txt` §8.3（L1596-L1603）
> Within Simple-ref productions, senders **MUST NOT**: use dot-segments ("." or ".."), or have prefixes that do not match the Request-URI.
> — §8.3（L1613-L1618）

**复现**：
```bash
curl -i -X PROPFIND "$B/按书名/A/" -H 'Depth: 1' -H 'Content-Type: application/xml' \
  --data-binary '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:lockdiscovery/></D:prop></D:propfind>'
```

**建议修法**：`lockDiscoveryXml(lock, requestHref)` 的入参改为**已编码**的 href —— `propfind.ts:467` 传 `encodeHref(`${cfg.mountPath}${e.path}`, false)`，`index.ts:151`/`:227` 同理传 `encodeHref(davPath)`。这样一次修好三处。

### 🟡-5 207 响应缺 `Vary`，且 `Cache-Control: public` 与 `Authorization` / `If` 头共存

**文件**：[src/lib/http.ts:47-54](src/lib/http.ts#L47-L54)

**现象**：`multistatusResponse` 只发 `cache-control: public, max-age=300`，无 `Vary`。实测（B12）：
```
PROPFIND … Authorization: Bearer tok   If: (<urn:uuid:…>)
→ 207，cache-control: public, max-age=300，vary: null
```

**RFC 原文**：
> A server **MUST** generate a Vary header field in a response to a request containing an Authorization header field if the response would have differed had the request not included the Authorization field.
> — `refs/rfc9110.txt` §12.5.5（见 `Vary` 章）

**风险（实际更严重的一条）**：条目缓存 + `public` 共享缓存意味着**一个客户端的 PROPFIND 结果可能被回给另一个客户端**。当前所有响应内容与身份无关，所以暂时无害；但一旦 `PROPPATCH`/`DELETE` 引入按身份差异化属性，这立刻变成信息泄漏。

**建议修法**：`multistatusResponse` 加 `'vary': 'Authorization, If'`。若担心 Cache API 与 `Vary` 交互，可改为 `private, max-age=…`。

### 🟡-6 PUT / COPY 目标为叶子但**父集合不存在**时返回 405，应 409

**文件**：[src/webdav/index.ts:552-554](src/webdav/index.ts#L552-L554)

**现象**：`handlePut` 用 `node.kind !== 'leaf'` 判定，把「父不存在」和「目标是集合」两种完全不同的错误都回 405。

实测（B9）：
```
PUT /dav/nosuchcoll/x.epub → 405 "PUT is only allowed on file paths"
```

**RFC 原文**：
> A PUT that would result in the creation of a resource **without an appropriately scoped parent collection MUST fail with a 409 (Conflict)**.
> — `refs/rfc4918.txt` §9.7.1（L2542-L2544）
> A PUT request to an existing collection **MAY** be treated as an error (405 Method Not Allowed). — §9.7.2（L2569-L2570）

**建议修法**：
```ts
if (node.kind === 'unknown') return davErrorResponse(409, 'Parent collection does not exist', ALLOW);
if (node.kind !== 'leaf')   return textResponse(405, 'PUT is only allowed on file paths', { allow: ALLOW });
```

### 🟡-7 MOVE/COPY 的 Destination 目标非叶子时返回 400，规范用 403（目标已存在且不可覆盖）或 502（跨服务器）

**文件**：[src/webdav/index.ts:380-383](src/webdav/index.ts#L380-L383)、[src/webdav/index.ts:354](src/webdav/index.ts#L354)

**现象**：`targetNode.kind !== 'leaf'` → 400；缺 `Destination` → 400。另外 §9.8.5/§9.9.4 都把「目标已存在但不能覆盖」指向 **403**，跨命名空间指向 **502**，当前没有对应分支。

实测（A23）：
```
COPY … Destination: .../按书名/A/3/deep.epub   → 400 "Destination must be a file path"
```

**RFC 原文**：
> **403 (Forbidden)** - The operation is forbidden. A special case for a COPY could be that the source and destination resources are the same resource. — §9.8.5（L2744-L2746）
> **502 (Bad Gateway)** - This may occur when the destination is on another server, repository, or URL namespace. — §9.8.5（L2765-L2769）
> If the Destination value is too long or otherwise unacceptable, the server **SHOULD** return 400 (Bad Request) — §10.3（L3628-L3630）

**建议修法**：目标已映射 → 403；`resolveNode` 为 `unknown` → 409；Destination 的 host 与 `request.url` 不一致 → 502（§10.3 说「must fail the request」）。

---

## ⚪ 取舍（偏离本身可接受，但实现方式有瑕疵）

### ⚪-1 MKCOL「不真的建目录」—— 偏离可接受，但 405 用了纯文本而非 `DAV:error`

README 记录：MKCOL 返回 201 但不真的建目录。**代码实际做法与 README 不符**（已映射 → 405，未映射 → 403 + `valid-resourcetype`），而且 `docs/rfc-compliance.md` 说「已映射 → 405 ✅」。偏离方向本身（拒绝而非假装成功）是对的，但：

- **README 与代码不一致**（README 说 201，代码是 405/403）。文档需要更新。
- 已映射分支（`src/webdav/index.ts:286-292`）返回的是 `textResponse(405, …)`，不是 `application/xml` + `DAV:error`。§16 的精神是预置错误元素走 XML。
- `handleMkcol` 签名收了 `request`/`env` 却从未使用 body —— 这直接导致了 🟠-8 的 415 缺失。

**建议修法**：改用 `davErrorResponse(405, …, ALLOW)`，并把 README「MKCOL 返回 201」更正为「405（已映射）/ 403 + `valid-resourcetype`（未映射）」。

### ⚪-2 Depth 缺失按 1、infinity 降级为 1 —— 偏离可接受，但 §9.1 的拒绝路径与降级路径的 `Depth: 0` 语义要留意

README 记录：Depth 缺失按 1 处理。代码 `resolveDepth`（`src/webdav/propfind.ts:65-76`）实现正确，实测 A26 确认 infinity 降级为 1（返回 1 个 response）。**符合已记录的取舍 ✅**。

唯一小瑕疵：`propfind-finite-depth` 的 403 分支（`propfind.ts:404-409`）返回的 `davError('propfind-finite-depth')` 是对的 ✅，但 `Depth: 0` 判定发生在 `handlePropfind` 的最前面 —— 若 `davPath` 根本不存在，`Depth: infinity` + 不存在路径会先因 deny 配置回 403 而非 404。§13.2.1 的「常规检查优先于预条件」精神下应先 404。

### ⚪-3 DELETE 根目录返回 405 —— 可接受（README 已记录）

`src/webdav/index.ts:758-765` 明确拒绝并给出指引，符合 §9.7.2 的「MAY be treated as an error」精神（虽然 §9.6.1 没给这个豁免）。**作为产品取舍可接受**，但从严格审查看它是对 §9.6.1「DELETE on a collection MUST act as if Depth: infinity」的一处 MUST 违反。既然 README 已明示，记录为取舍而非缺陷。

### ⚪-4 PROPFIND 不持久化自定义属性 —— 可接受

返回 207 + 403 + `cannot-modify-protected-property` 的**形状**是对的（符合 §9.2.1 L2258-L2261），只是错误元素对「dead property 不可改」而言语义偏差（应为 403 无特定 precondition，或 409）。见 🟡-1 的命名空间问题。

---

## ✅ 通过项（简述）

| 检查项 | 结论 |
|---|---|
| `DAV: 1, 2` 头 | ✅ 诚实声明（`:63`），不宣告 3 的理由在代码注释里站得住（§18.3） |
| `Allow` 头 | ✅ 覆盖全部 12 个动词，405 响应都带 |
| 207 + `propstat` 的 200/404 分组 | ✅ 结构正确（`src/lib/xml.ts:29-41`） |
| `propname` 只返名字不返值 | ✅ 实测 B13 确认 |
| `getetag` 不做 XML 转义 | ✅ 且注释解释了为什么（`:167-171`），客户端 If-Match 能对上 |
| `getlastmodified` 用 RFC 1123、`creationdate` 用 RFC 3339 | ✅ 手工格式化正确（`src/lib/http.ts:10-25`） |
| Timeout 头解析 `Second-N` / `Infinite` | ✅ BNF 正确（`src/lib/locks.ts:59-74`），注释还记录了 `Second-N=` 的历史事故 |
| 锁 token 转义 | ✅ `<urn:uuid:…>` 转义后解析还原即裸 URI，与 `Lock-Token` 头一致（实测 A1） |
| `OPTIONS` 在任何路径都回 200 + DAV/Allow | ✅ 对 `*` 与具体资源一致，符合 §9.3.7 |
| 204 响应不带 `Content-Length` | ✅ 实测 C12 `cl null`，符合 RFC 9110 §8.6 |
| DELETE 不存在的叶子 → 404 | ✅ 实测 A22 |
| 未实现方法（PATCH 等）→ 405 | ✅ `methodNotAllowed` 带 `Allow` |
| `allprop` 空 body 等价处理 | ✅ 空 body → allprop，符合 §9.1 L1809-L1810 |
| Depth 对无内部成员的资源被忽略 | ✅ 实测 B7，叶子带 `Depth: 1` 只返 1 个 response（§10.2 L3605-L3607） |
| href 百分号编码（非 ASCII） | ✅ `encodeHref` 逐段 `encodeURIComponent` 且保留 `/`，集合带尾斜杠（`src/lib/xml.ts:16-23`） |
| 424 的使用 | ✅ 代码里**没有**误用 424（§9.8.3/§9.9.2/§9.6.1 都 SHOULD NOT 放进 207） |

---

## 修复优先级建议

1. **立刻**（数据丢失）：🔴-1 MOVE 自毁、🔴-9 DELETE 集合删掉锁定成员、🔴-3 覆盖时 R2 孤儿泄漏 —— 三条均已修复（🔴-9 的成员锁部分见 `1e9306c`；其 §9.6 MUST destroy 部分见 task-13）
2. **本迭代**（协议正确性）：🔴-4 `activelock`、🔴-2 `Overwrite`、🟠-4 LOCK 刷新 412、🟠-8 UNLOCK 400
3. **下迭代**：🔴-5/🔴-6/🔴-7 锁属性与解析、🟠-1 `If` 头求值、🟠-2 强比较、🟠-5/🟠-6 LOCK 状态码与 Depth
4. **可排期**：🟠-3 条件请求顺序、🟡 全部
5. **文档**：⚪-1 README 与代码不一致；`docs/rfc-compliance.md` 中「§14.12 ✅」「刷新时不回 Lock-Token ✅」两条结论与实测不符

**测试缺口**：现有 253 个测试全绿，但 `test/xml-wellformed.test.ts` 只验**良构性不验 DTD**，`test/webdav-class2.test.ts:124` 只断言 `<D:lockdiscovery>` 字符串存在 —— 这正是 🔴-4/🔴-5 能长期存活的原因。建议引入一个对 `refs/rfc4918.txt` 中 DTD 的最小子集校验（`<!ELEMENT activelock (lockscope, locktype, depth, owner?, timeout?, locktoken?, lockroot)>` 足以拦住这两条）。
