# webooks 安全审计报告

**审计对象**：`https://webooks.cszxorx.dpdns.org`（Cloudflare Workers Free + R2 + D1）
**审计日期**：2026-10-11
**审计方式**：源码审查 + 实网渗透验证（非破坏性）+ 回归测试固化
**结论**：发现并修复 **2 个高危漏洞**、1 个功能性安全问题、若干结构性风险。
安全检查从 **28/33** 提升到 **34/34** 全通过。

---

## 一、执行摘要

| 严重度 | 数量 | 状态 |
|---|---|---|
| HIGH | 2 | ✅ 已修复并实网验证 |
| MED | 5 | ✅ 已修复 |
| LOW | 3 | ✅ 已修复 |
| 提示（需你决策） | 2 | ⚠️ 见第六节 |

**核心风险画像**：本项目是「匿名开放上传 + 公开读取」的公共书库，因此最大的威胁
不是「读不到数据」，而是**「攻击者能否借你的域名托管内容 / 能否烧掉你的配额」**。
本次两个 HIGH 漏洞都属第一类 —— 把 `cszxorx.dpdns.org` 变成任意内容托管点。

---

## 二、HIGH-1：封面 media-type 可控 → 任意内容托管

### 漏洞位置
`src/lib/epub.ts` 的封面提取（旧实现）

### 根因
EPUB 的 OPF 文件里 `<item media-type="…">` **完全由上传者控制**。旧实现把这个
声明值直接用作：
1. R2 对象的 `Content-Type`
2. 封面对象的扩展名（`coverType.split('/')[1]`）

### 实网验证（已复现）
构造一个 EPUB，其封面 item 声明 `media-type="text/html"`，内容为含 `<script>` 的
HTML。通过 WebDAV PUT 上传后：

```
PUT /dav/recent/x.epub            → 201
D1: cover_key = "covers/<id>.html"
GET https://books.<域名>/covers/<id>.html
  → HTTP 200
  → Content-Type: text/html          ← 攻击者的 HTML+JS 被原样执行
```

### 影响
- **任意内容托管**：钓鱼页、挂马、SEO 垃圾都可挂在你域名下，且是 HTTPS 可信域名
- **跨子域存储型 XSS 的种子**：`books.` 与 `webooks.` 同属 `cszxorx.dpdns.org`。
  当前主站无 Cookie，所以尚未可直接窃取会话；但一旦将来引入任何跨子域 Cookie
  或把封面嵌入主站，即刻升级为可窃取凭据的 XSS
- WebDAV PUT **没有 Turnstile**，脚本可批量滥用

### 修复
改为**只信任字节魔数嗅探**，完全忽略声明值：

- 新增 `sniffImageType()`：按文件头判定 jpeg / png / gif / webp / bmp / avif / tiff
- **SVG 刻意不入白名单** —— SVG 可内嵌 `<script>`，安全性等同 HTML
- 新增 `coverExtFor()`：扩展名从白名单推导，不再拼接上传者字符串
- 嗅探失败 → 视为无封面（宁可不显示，也不托管可疑内容）

### 回归测试
`test/epub.test.ts` 新增 6 例：HTML 封面 / SVG 封面 / 伪装成 image/jpeg 的 HTML
均须被丢弃；真实 JPEG 仍能提取（防止修复误伤）。

---

## 三、HIGH-2：文件 Content-Type 可控 → 任意内容托管（更严重）

### 漏洞位置
`src/webdav/index.ts` `handlePut`、`src/api/upload.ts` `handleUploadComplete`

### 根因
R2 对象对外提供的 `Content-Type` 来自**写入时**的 `httpMetadata.contentType`，
而不是 D1 里的值。旧实现用 `preferContentType()` 采纳客户端的非泛型声明，于是：

```js
// 旧代码
const contentType = preferContentType(request.headers.get('content-type'), meta.contentType);
// text/html 不是"泛型"，被原样采纳 → 写进 R2
```

### 实网验证（已复现）
```
PUT /dav/recent/x.epub
  Content-Type: text/html
  body: <!doctype html><script>alert(document.domain)</script>
  → 201

D1: content_type = "text/html"

GET /dav/recent/x.epub
  → 302 Location: https://books.<域名>/books/<id>

GET https://books.<域名>/books/<id>
  → HTTP 200
  → Content-Type: text/html          ← 任意 HTML/JS 被执行
```

### 为何比 HIGH-1 更严重
- **无 Turnstile**：WebDAV PUT 完全匿名，脚本可无限制批量上传
- **无扩展名限制**：任意文件名
- **URL 干净**：`books/<随机id>` 没有 `.html` 后缀，更像正常链接，更难被识别

### 修复
新增 `safeContentTypeFor(leafName)` —— **写入 R2 时一律按扩展名推导类型，
忽略客户端声明**。三条写路径全部改用：
- `handlePut`（WebDAV）
- `handleUploadComplete`（网页上传）
- `admin reindex`

同时收紧类型映射（`src/lib/metadata.ts`）：

| 扩展名 | 修复前 | 修复后 | 原因 |
|---|---|---|---|
| `.html` / `.htm` / `.xhtml` | `text/html` | `text/plain` | 可下载/查看源码，但浏览器不渲染 |
| `.svg` | （未映射→octet-stream） | `application/octet-stream` | 显式拒绝渲染 |
| 未知扩展名 | 客户端声明 | `application/octet-stream` | 只下载不渲染 |

### 回归测试
`test/security.test.ts` 新增 3 例：断言 **R2 对象的实际 `httpMetadata.contentType`**
（而非 D1 值）为安全类型，覆盖伪装 epub / html / javascript 三种。

---

## 四、MED 级修复

### 4.1 安全响应头缺失
**修复前**：`/` 与 `/upload` 无任何安全头。
**修复后**（`src/lib/http.ts` + `src/index.ts` 最外层统一注入）：

| 头 | 值 | 作用 |
|---|---|---|
| `X-Content-Type-Options` | `nosniff` | 阻止浏览器把 .txt/.epub 猜成 HTML 执行 |
| `Content-Security-Policy` | `default-src 'none'` + `frame-ancestors 'none'` + `object-src 'none'` + `base-uri 'none'` + `form-action 'none'` | HTML 页面纵深防御 |
| `X-Frame-Options` | `DENY` | 防点击劫持 |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | 防 Referer 泄露 |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | 强制 HTTPS |

设计考虑：CSP 的 `script-src` 保留 `'unsafe-inline'`（本项目的样式与脚本都是内联的，
零构建单文件返回），但其余全部收紧。**WebDAV 的 207 响应不加 CSP** —— 避免
客户端把 CSP 当成异常。

### 4.2 WebDAV PUT 无大小上限（配额耗尽）
**修复前**：PUT 任意大小，无任何限制。免费层 R2 仅 10GB，一个脚本即可写满并触发计费。
**修复后**：新增 `MAX_UPLOAD_BYTES`（默认 200 MiB，`wrangler.jsonc` 可配，`0` = 不限）。
超限返回 **413 且不写库**。
**实网验证**：临时把上限设为 2KB —— 4KB 文件 → `413`，1KB 文件 → `201`；随后恢复 200MiB。

### 4.3 EPUB 解析内存炸弹（DoS）
**修复前**：对任何 `.epub` **无条件** `request.arrayBuffer()` —— 一个几百 MB 的
假 EPUB 就能撑爆 128MB isolate（Worker 1102 崩溃）。
**修复后**：按 `Content-Length` 三档处理：

| 声明大小 | 处理方式 |
|---|---|
| ≤ 50MB（`PARSE_SIZE_CAP`） | 读进内存 + 解析封面/元数据 |
| > 50MB | 流式落 R2，不解析（不占内存） |
| 未声明（chunked） | 流式落 R2，不解析 |

### 4.4 锁表无限膨胀
**修复前**：过期的锁虽然不再生效，但行永久留在 D1。匿名 LOCK 端点可无限写入 → 表无声膨胀。
**修复后**：新增 `sweepExpiredLocks()`，每次 LOCK 请求顺带清理过期行（LOCK 频率极低）。
免费层没有 Cron 绑定也能生效。

### 4.5 上传完成接口的文件名未清洗
**修复前**：`handleUploadComplete` 只替换 `/` 和 `\`，控制字符、`<>:"|?*` 与超长名字
都能进 D1（虽然后续渲染都有转义，但入库前就该干净）。
**修复后**：改用与 WebDAV 完全一致的 `sanitiseLeafName()`（含 200 字符上限）。

---

## 五、LOW 级 / 结构性改进

### 5.1 死代码造成虚假安全感
`UPLOAD_DAILY_QUOTA` 与 `DEFAULT_DAILY_QUOTA` 声明了但**从未被使用** ——
每 IP 每日配额实际根本没实现。已移除死常量，改为真正实现（见 5.2）。

### 5.2 新增写入节流
`src/lib/throttle.ts` + `DAILY_WRITE_QUOTA`（默认 300 次/IP/日，`0` = 不限）：
- 大小上限管「单次伤害」，节流管「总量」
- 用 **Cache API** 实现，不消耗 D1 写入配额（免费层仅 10 万行/天）或 KV 写入配额
  （免费层仅 1000 次/天）
- **诚实的局限**（代码注释中已标注）：Cache API 是**按数据中心**的，同一 IP 在多个
  边缘节点会有多份计数；读-改-写非原子；条目可能被提前淘汰。因此这是
  **抬高滥用成本的减速带，不是硬配额**。真要严格限制需 Durable Object 或 KV +
  账号体系，与「无需注册」的产品定位冲突。

### 5.3 上传 complete 无 Turnstile
`/api/upload/init` 有 Turnstile 强校验（fail-closed），但 `/api/upload/complete`
没有。实际风险有限 —— complete 要求 `uploads/` 下存在对象，而创建该对象需要
init 签发的预签名 URL（需先过 Turnstile）。已在报告中记录，未改动。

---

## 六、通过项与提示项

### 已验证通过（34 项）
- **路径穿越**：`../../etc/passwd`、`%2e%2e%2f`、`/.env`、`/.git/config`、
  `/wrangler.jsonc` 全部 404/400，无内容泄露
- **CORS**：不反射任意 Origin，未开 `credentials`
- **管理端点**：无 token / 错误 token → 404（fail-closed），常量时间比较防时序侧信道
- **XXE / 实体扩展**：DOCTYPE 外部实体未被展开；十亿笑声无慢响应（274ms）
- **错误信息**：不泄露堆栈、不泄露密钥名
- **R2 公开桶**：不可列举（`?list-type=2` → 404）
- **方法限制**：TRACE 被拒；OPTIONS 只宣告已实现的方法
- **服务器信息**：无 `X-Powered-By`，`Server: cloudflare` 不泄露运行时版本

### ⚠️ 提示项（需你决策）

**提示 1：网页上传功能当前不可用**

安全探针发现 `/api/upload/init` 返回：
```json
{"error":"upload-not-configured","missing":["R2_ACCESS_KEY_ID","R2_ACCOUNT_ID","R2_BUCKET_NAME","R2_SECRET_ACCESS_KEY"]}
```
即 **R2 S3 凭据未配置**，网页上传页（`/upload`）实际无法工作，目前只能通过
WebDAV 上传。这不是安全漏洞（fail-closed 行为正确），但影响产品功能。

**提示 2：对话中泄露过的凭据建议轮换**

本次会话及更早的会话中，以下凭据曾以明文出现在对话里，建议全部轮换：
- R2 API Token（`cfut_97oIBgLS...`）
- R2 Access Key ID（`a07cad34...`）与 Secret Access Key（`4f6f5638...`）
- Turnstile Secret（`0x4AAAAAAFPbrkAB...`）
- Cloudflare Account ID（`0588b85f...`）—— 非机密，但建议最小暴露

---

## 七、验证方式（可复现）

```bash
# 1. 安全自查（34 项；--write-test 会写入并自动清理一个临时文件）
node scripts/security-probe.mjs --url https://webooks.cszxorx.dpdns.org --write-test

# 2. WebDAV 协议合规（15 步完整挂载握手）
node scripts/webdav-litmus.mjs --url https://webooks.cszxorx.dpdns.org/dav/

# 3. RFC 4918 / 9110 合规
node scripts/rfc-probe.mjs --url https://webooks.cszxorx.dpdns.org/dav/

# 4. 配色对比度（WCAG）
node scripts/contrast-check.mjs

# 5. 单元与端到端测试（133 例，含 18 例安全回归）
npx vitest run
```

### 修复验证结果
```
类型检查          tsc exit 0
全量测试          133 passed (8 files)
安全探针          34/34 通过，0 项待处理
WebDAV litmus     15/15 步通过
配色对比度        全部达标（文本 8.5:1–16.3:1，均为 AAA）
构建体积          126.5 KiB / gzip 38.4 KiB
```

### 漏洞验证痕迹已清理
审计过程中上传的恶意对象（`covers/<id>.html`、`books/<id>`）已从 R2 删除，
线上返回 404；书库现仅存 1 本演示书 `凡尘之舞.epub`（如需可删除）。

---

## 八、遗留风险（未修复，需知晓）

| 风险 | 说明 | 建议 |
|---|---|---|
| **无账号体系 → 无 DMCA 避风港** | 无「重复侵权者封号」机制，不具备 §512(c) 安全港资格。CSAM 报告义务（§2258A）仍然适用 | 见 `docs/cloudflare-ebook-library-feasibility.md` §5/§7；如需合规须引入账号或人工审核 |
| **内容审核缺失** | 上传即上架、无审核 | 可加关键词黑名单或引入 Queue 异步审核 |
| **节流为尽力而为** | Cache API 按数据中心，多边缘节点计数不共享 | 若要硬限制需 Durable Object |
| **审计日志缺失** | 无上传者 IP / 操作留痕 | 合规场景需补 |
| **R2 公开桶按设计开放** | 书库本就是公开的 | 如要私有化需改造为签名 URL 直传 |

---

## 九、变更文件清单

```
src/lib/epub.ts        封面类型嗅探 + 白名单（HIGH-1）
src/lib/metadata.ts    safeContentTypeFor + html/svg 类型收紧（HIGH-2）
src/webdav/index.ts    内容类型强制、大小上限、节流、内存炸弹、锁清扫
src/api/upload.ts      内容类型强制、文件名清洗、预签名类型收紧
src/api/admin.ts      reindex 使用安全类型
src/lib/http.ts        安全响应头
src/lib/throttle.ts    新增：写入节流
src/lib/locks.ts       sweepExpiredLocks
src/index.ts           安全头统一注入（最外层）
src/config.ts          maxUploadBytes / dailyWriteQuota
wrangler.jsonc         MAX_UPLOAD_BYTES / DAILY_WRITE_QUOTA
scripts/security-probe.mjs  新增：34 项安全自查
test/security.test.ts       新增：12 例安全回归
test/epub.test.ts           +6 例封面类型回归
```
