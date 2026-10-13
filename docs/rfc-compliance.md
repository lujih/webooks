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

即宣告 `3` 等于声称「满足本规范全部要求」。本服务有三处有意保留的偏离（见下表），
宣告 3 会是**不实声明**。宣告 `1, 2` 是准确的：Class 1 + 完整锁支持。

## 已实现（逐条对照 RFC 原文）

| RFC 条款 | 规范要求 | 本服务行为 | 状态 |
|---|---|---|---|
| §18.2 | Class 2 = Class 1 + LOCK/UNLOCK | `DAV: 1, 2`，含完整锁（timeout / lock-token / If 刷新） | ✅ |
| §9.10.1 | LOCK 响应体必须是 `prop` 元素里的 `lockdiscovery` | `<D:prop><D:lockdiscovery>…` | ✅ |
| §8.2 | 所有 XML「MUST be, at minimum, well formed」 | 全部响应体经严格良构校验（`test/xml-wellformed.test.ts`） | ✅ |
| §10.7 | `TimeType = ("Second-" DAVTimeOutVal \| "Infinite")` | 解析 `Second-600` 等真实写法 | ✅ |
| §14.12 | lockdiscovery 结构（含 `lockroot`） | `lockscope/locktype/depth/locktoken/lockroot/timeout/owner` | ✅ |
| §14.14 | href 内是锁令牌 URI | 转义后写入，解析还原即裸 URI，与 `Lock-Token` 头一致 | ✅ |
| §6.5 / §10.5 | `Lock-Token: "<" absolute-URI ">"` | 带尖括号形式 | ✅ |
| §9.10.2 | 无 body + `If:` 头 = 刷新锁 | 支持，且刷新时不回 `Lock-Token` 头 | ✅ |
| §9.10.6 | 已有不兼容锁 → 423（不是 412） | 423 + `no-conflicting-lock` | ✅ |
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
| RFC 9110 §13.1 | If-Match / If-None-Match 完整语义 | 弱比较、多值、通配 `*`；**在写入前判定** | ✅ |
| RFC 9110 §13.1.2 | `If-None-Match: *` 且资源已存在 → 412 | 412 | ✅ |
| RFC 9110 §9.3.7 | OPTIONS `*` 服务器级查询 | 支持 | ✅ |
| RFC 9110 §14.2 | Range 头是建议性的（"only provides advice"） | GET 返回 302 交由 CDN 处理 | ✅ |
| RFC 9110 §8.6 | 204 不带非零 Content-Length | 遵守 | ✅ |
| RFC 5789 | PATCH 未实现 → 405 | 405 | ✅ |
| RFC 5689 §3.1 | 非法 resourcetype → 403 + `valid-resourcetype` | MKCOL 未映射路径时使用 | ✅ |

## 有意保留的偏离（不是 bug，是设计取舍）

| 项 | 现状 | 理由 |
|---|---|---|
| **Depth: infinity** | 降级为 Depth: 1，而不是 403 + `propfind-finite-depth` | 大目录上 `infinity` 会炸 CPU。§9.1 用的是 SHOULD 级建议；§9.1 的 MAY 允许禁用。可通过 `DEPTH_INFINITY=deny` 切换为显式 403 |
| **Depth 头缺失** | 按 1 处理 | §9.1 说 SHOULD 按 `infinity`；同样出于 CPU 保护按 1 处理 |
| **DELETE 根目录** | 405（不支持） | 根 = 整个书库。实现 §9.6.1 会让一次误操作 / 客户端 bug 造成不可逆的全量丢失。批量清理走管理后台 `/admin` |
| **MKCOL 无法真正建目录** | 403 + `valid-resourcetype` | 集合由 D1 派生，无法持久化自定义目录。如实告知优于假装成功 |
| **PROPPATCH 不持久化** | 207 + 403 + `cannot-modify-protected-property` | 属性是派生视图。早前「假装 200 成功」是不实声明，已改为规范要求的前置条件 |
| **未支持** | DeltaV(3253) / ACL(3744) / SEARCH(5323) / BIND(5842) | 公共书库无鉴权、无版本控制；用 PROPFIND 列举替代 SEARCH |

## 自测基线

```bash
# 协议语义（14 项）
node scripts/rfc-probe.mjs --url https://<host>/dav/ --token "$WRITE_TOKEN"

# 完整挂载握手（16 步）
node scripts/webdav-litmus.mjs --url https://<host>/dav/ --token "$WRITE_TOKEN"

# XML 良构性（含线上曾经出过的真实坏样本）
npx vitest run test/xml-wellformed.test.ts
```

当前实测：`rfc-probe` 14/14、`webdav-litmus` 16/16、XML 良构全部通过。

> 💡 **为什么必须有 XML 良构性测试**：LOCK 响应曾输出
> `<D:locktoken><D:locktoken><D:href>…` —— 标签开了两次只关一次。
> .NET 的 `XmlDocument` 报 *"The 'D:locktoken' start tag does not match the end tag of 'D:lock'"*，
> 所有严格客户端都会挂。而当时的测试只做 `expect(xml).toContain(...)` 字符串匹配，
> 字符串里确实含有那个片段，一路绿灯。
> **教训：验证 XML 必须用解析器，不能用字符串包含。**

要跑完整 litmus 套件（需要 Python + apache + workerd 镜像），参考
[dav-probe.mjs](../scripts/dav-probe.mjs) 的 `--url` 参数指向 litmus 服务。
