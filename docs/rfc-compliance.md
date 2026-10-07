# RFC 4918 / RFC 9110 合规基线

本文档记录 webooks 当前的 WebDAV 合规基线。运行 [rfc-probe.mjs](../scripts/rfc-probe.mjs) 和
[dav-probe.mjs](../scripts/dav-probe.mjs) 可随时复验。

## 合规标准澄清

**常见误解**：「最新的 WebDAV 标准」。

- **RFC 4918（2007）** 是 WebDAV 基础标准，**至今未废弃**。它取代的是 RFC 2518（2002）。
- 所谓「更新」的是 **HTTP 核心语义**：RFC 9110 / 9111 / 9112（2022）取代 RFC 7230–7235。
- 若干扩展 RFC 也仍有效：RFC 5689（Extended MKCOL，2009）、RFC 5789（PATCH，2010）、
  RFC 5323（SEARCH，2010）、RFC 3253（DeltaV，2002）、RFC 3744（ACL，2003）。

webdav.org 的规格清单里被标记为 *obsoleted* 的只有 **RFC 2518**，不是 4918。

## 已实现合规项

| RFC 条款 | 行为 | 状态 |
|---|---|---|
| RFC 4918 §18 | `DAV: 1, 3`（Class 1 + 完全符合 RFC 4918，不宣告 2） | ✅ |
| RFC 4918 §9.1 | PROPFIND 不存在的资源 → 404 | ✅ |
| RFC 4918 §9.1 | Depth: infinity → 207（降级为 1） | ✅ |
| RFC 4918 §9.6.1/10.4 | 条件 PUT：If-Match / If-None-Match / If-Unmodified-Since | ✅ |
| RFC 4918 §9.7.1 | PUT 打到集合路径 → 405 + Allow | ✅ |
| RFC 4918 §14 | PROPPATCH → 403 + `<D:error><D:cannot-modify-protected-property/>` | ✅ |
| RFC 4918 §16 | 预置错误元素（supported-lock、cannot-modify-protected-property） | ✅ |
| RFC 4918 §10.2 | LOCK 未支持 → 501 + `<D:supported-lock/>` | ✅ |
| RFC 9110 §9.3.7 | OPTIONS * 服务器级能力查询 | ✅ |
| RFC 9110 §13.1 | If-Match / If-None-Match 完整语义（含弱比较、多值、通配 *） | ✅ |
| RFC 9110 §14 | Range 请求 → 206 Partial Content（R2 处理） | ✅ |
| RFC 9110 §8.6 | 204 响应不携带 Content-Length | ✅ |
| RFC 5789 | PATCH 未实现 → 405 | ✅ |

## 未实现（刻意取舍）

| RFC | 说明 |
|---|---|
| RFC 4918 Class 2（LOCK/UNLOCK） | 本服务是**只读浏览 + 匿名上传**的公共书库。锁对「多人同时编辑同一本书」才有意义，我们不支持同时编辑，故不宣告 2。客户端会自动退回无锁模式（见 RFC 4918 §10.1.1）。 |
| RFC 3253 DeltaV | 版本控制。公共书库不需要。 |
| RFC 3744 ACL | 访问控制列表。本服务无鉴权（所有人可读、所有人可传）。 |
| RFC 5323 SEARCH | 搜索扩展。我们用 OPDS + PROPFIND 列举替代。 |
| RFC 5689 Extended MKCOL | 集合是虚拟视图（由 D1 派生），不可创建。MKCOL → 405。 |
| RFC 5842 BIND/UNBIND | 挂载。不需要。 |

## litmus 基线

[Dave Marshall 的 litmus 测试套件](https://github.com/dave-marshall/litmus) 是 WebDAV 合规的
事实标准。本仓库通过 [dav-probe.mjs](../scripts/dav-probe.mjs) 自测：

```
31 通过 / 0 警告 / 0 失败
```

要跑完整 litmus 套件（需要 Python + apache + workerd 镜像），参考
[dav-probe.mjs](../scripts/dav-probe.mjs) 的 `--url` 参数指向 litmus 服务。

已知差异：litmus 的 `class1` 套件含 200+ 用例，部分用例（如 LOCK 超时、
`refresh-lock` 行为）要求 Class 2，本服务刻意不实现，会被判失败但属预期。

## 如何验证

```bash
# 合规基线（线上）
node scripts/rfc-probe.mjs --url https://webooks.cszxorx.dpdns.org/dav/

# 全功能回归（线上）
node scripts/dav-probe.mjs --url https://webooks.cszxorx.dpdns.org/dav/

# 本地开发
npm run check
```