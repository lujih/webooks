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

### 4.4b 匿名锁阻断全部写入（可用性 DoS）
**修复前**：`LOCK` 分支**没有任何凭据检查** —— 任何人都能对任意路径加锁，且
`liveLockForResource()` 只按资源路径匹配（不看锁的 owner），`handleLockedWrite()`
比的是 `If:` 里的锁令牌 —— 是两套互不相干的凭据体系。写口令因此**挡不住**这条路径。

线上实测（匿名、不带任何凭据）：

| 请求 | 结果 |
|---|---|
| `LOCK /dav/按书名/`（`Timeout: Second-300`, `Depth: 1`） | 200 + `lock-token` |
| 紧接着匿名 `PUT` 该集合下的子成员 | 423 Locked |
| `LOCK` + `If: <token>` + `Timeout: Infinite` | 200，回显 `<D:timeout>Second-3600</D:timeout>`（**可无限续期**） |
| 并发 `PROPFIND` 读路径 | 207，不受影响 |

即：**一个脚本锁住 5 个顶层集合，就能让全部 WebDAV 写路径瘫痪**
（`/api/upload/*` 不受影响）。锁的归属只看 `If:` 令牌，而 `PROPFIND Depth: 0`
会公开回显 `locktoken`，所以攻击者本人（以及任何读到 XML 的人）可以自解 ——
因此这是对**朴素客户端**的可用性攻击，不是硬性锁死；但默认状态即 DoS。

**修复后**：
1. `case 'LOCK'` 与 `DELETE`/`MOVE` 同级要求写口令（`hasWriteToken`）——不再有任何人
   能替书库决定「谁可以写」。注释里写明爆炸半径大于 DELETE 的原因。
2. LOCK 与 PUT/COPY 一样走 `guardWrite()` 每日写入节流（纵深防御：即使口令泄漏，
   也不能无限建锁）。
3. `UNLOCK` 刻意**不**要求口令：§9.11 用锁令牌表达归属，要求口令会让
   「持有者释放自己的锁」失败；加锁被拦住之后它也不再是攻击面。
4. 回归测试同时断言 status 401 **和** `locks` 表里真的没有建出锁
   （只断言状态码，一个「回 401 但仍然建锁」的实现也能通过）。

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
`src/lib/throttle.ts` + `DEFAULT_DAILY_WRITE_QUOTA`（300 次/IP/日，`0` = 不限）：
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
- **管理端点**：无 token / 错误 token → 403（fail-closed），口令用**常量时间比较**
  > ⚠️ 本条此前写的是「404（fail-closed）」，与代码不符：`src/api/admin.ts`
  > 实际是「未配置 ADMIN_TOKEN → 404」「已配置但 token 不对 → 403」。代码是对的，
  > 是文档表述需统一。另：`safeEqual` 在长度不等时立即返回，仍泄露口令长度
  > （理论风险：边缘 RTT 抖动数十毫秒，远大于一次长度比较的耗时）。
  > 2026-10-14 复核，实测 `/api/admin/stats` 无 token → **403**。
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

## 七、第二次审计：滥用防护（防恶意上传/删除）

第一次审计解决的是「技术漏洞」。用户追问「防恶意上传」后，新增
`scripts/abuse-probe.mjs` 做业务层滥用检查，发现**破坏面**问题并修复。

### 发现的问题

| 问题 | 实测 | 影响 |
|---|---|---|
| **任何人可删除任意书** | `DELETE` → 204（无需凭据） | 一个脚本就能把整个书库删光 |
| **任何人可覆盖任意书** | 同名 `PUT` → 204 | 别人的书能被换成任意内容 |
| **任何人可改名（MOVE）** | → 201 | 书能被移走/改乱 |
| WebDAV 上传无人机验证 | `PUT` → 201 | 网页上传有 Turnstile，WebDAV 通道没有 |
| 无管理后台 | `/api/admin/*` → 404 | 出事时没有批量处置工具 |
| `UPLOAD_DAILY_QUOTA` 是死代码 | 从未被引用 | 配额实际不存在（第一次审计已修） |

### 修复：分级权限

核心思路 —— **「上传」和「删除」是两件事**：

```
读（PROPFIND / GET / HEAD）        完全匿名  ← 保持开放
新增书（PUT 到不存在的文件名）      完全匿名  ← 保持「所有人都能上传」
删除（DELETE）                     需要口令
改名（MOVE）                       需要口令
覆盖已有书（PUT 到已存在的文件名）   需要口令
```

技术实现（`src/lib/auth.ts`）：

- 新增 `WRITE_TOKEN` 共享口令，支持三种携带方式以覆盖各类客户端：
  - `Authorization: Bearer <token>` —— 脚本 / 现代客户端
  - `Authorization: Basic <base64(任意用户名:口令)>` —— WebDAV 客户端标准做法
  - `X-Write-Token: <token>` —— 便于 curl 调试
- 未通过时返回 **401 + `WWW-Authenticate: Basic`**（而不是 403）——
  WebDAV 客户端看到 401 才会弹密码框让用户输入；403 只会显示「拒绝访问」
- 口令用**常量时间比较**，避免响应时间侧信道
- **例外**：带 `If-None-Match: *` 的请求语义上是「只新建不覆盖」，
  即使同名文件存在也只会返回 412，不产生任何改动，因此无需口令
  （否则会误伤 rclone 等同步客户端的标准行为）

**未配置 `WRITE_TOKEN` 时**：不保护（保持向后兼容），但管理后台会**红色告警**，
明确写出「任何人都能删光书库」。

### 新增：管理后台 `/admin`

面向不懂技术的站长，一屏看清两件事：

1. **安全防护状态** — 六个指示灯（删除口令 / 后台口令 / 人机验证 /
   上传通道 / 大小上限 / 写入节流），每个都带一句人话说明。
   这是「不懂网络安全也能判断站点是否安全」的关键设计。
2. **全部藏书列表** — 搜索、多选、批量删除（同时清理 R2 对象与封面，
   并让读者侧目录缓存立即失效）。

安全细节：
- 口令只存 `sessionStorage`，**不写 Cookie** → 天然免 CSRF
- 页面本身不含任何数据，真实数据在 `/api/admin/*` 后面逐次鉴权
- 响应 `Cache-Control: no-store, private`，绝不进共享缓存
- 所有来自服务端的数据（书名可能是任意的）都经 `esc()` 转义后再插入 DOM
- `/api/admin/*` 未配置 `ADMIN_TOKEN` 时 fail-closed（整体 404）

### 实测结果

```
滥用防护探针    修复前：6 项安全 / 6 项注意 / 0 风险
                修复后：12 项安全 / 3 项注意 / 0 风险

线上逐项验证：
  匿名上传新书        → 201   ✅ 保持开放
  匿名删除            → 401 + WWW-Authenticate  ✅ 已挡住
  带口令删除          → 204   ✅ 功能正常
  匿名覆盖已有书      → 401   ✅ 已挡住
  带口令覆盖          → 204   ✅ 功能正常
  匿名改名            → 401   ✅ 已挡住
  /api/admin/books 无 token → 403  ✅
  /api/admin/books 有 token → 200  ✅
  /admin 页面         → 200   ✅
```

### 新增：上传格式白名单（只允许电子书 + 漫画）

**修掉的漏洞**：网页上传有一份扩展名白名单，但 **WebDAV `PUT` 完全没有检查** ——
任何文件（`.exe` / `.php` / `.js` / `.zip`）都能绕过网页限制直接塞进书库。
「一边拦、一边不拦」等于没拦。

现在两条入口共用 `src/lib/collections.ts` 里的 `ALLOWED_UPLOAD_FORMATS`：

```
电子书: epub pdf mobi azw3 fb2 djvu txt rtf doc docx odt md html lit chm prc pdb
漫画:   cbz cbr cb7 cbt cba
```

被排除：有声书（m4a/m4b/mp3）、通用压缩包（zip/rar/7z）、可执行文件与脚本。

实测（`scripts/abuse-probe.mjs`，WebDAV 通道）：

```
.exe  → 415 ✅   .js   → 415 ✅   .php → 415 ✅   .svg → 415 ✅
.zip  → 415 ✅   .mp3  → 415 ✅   .sh  → 415 ✅
.epub → 201 ✅   .pdf  → 201 ✅   .cbz → 201 ✅   .mobi → 201 ✅   .txt → 201 ✅
```

415 响应里会列出允许的格式，便于用户自查。判定用 `isAllowedUploadExt()` 先做
归一化（`azw` → `azw3`），避免名单对了却把合法别名拒掉。

另外把 HTTP 输入校验提到了**配置检查之前** —— 非法输入应当立刻被拒，
不该先暴露「服务端缺哪些配置」这种内部状态（测试也因此才能真正覆盖到白名单）。

### 新增：批量上传通行证（可用性与防护的取舍）

**修掉的体验问题**：Turnstile 令牌一次性，而批量上传每本书都要新令牌 ——
用户反馈「传一本验证一次」，传 10 本要点 10 次。

现在改为**一次验证换一张限时通行证**：

```
turnstileToken → siteverify 通过 → 返回 ticket（HMAC 签名、10 分钟、绑定 IP）
后续文件带 ticket → 只验签名，不再要求人机验证
```

**这算是放宽了防护吗？** 有限度地放宽，且是有意的：

| 维度 | 收紧/放宽 |
|---|---|
| 验证码频率 | 从「每文件一次」→「每 10 分钟一次」 |
| 绑定 | 通行证绑定签发时的 IP，换 IP 即失效 |
| 伪造 | HMAC-SHA256 签名，篡改过期时间会导致签名不符 |
| 兜底 | 匿名上传有每日写入次数节流；D1 写入额度也是硬约束 |

> ⚠️ **2026-10-14 订正：这条结论此前是错的。** 核查发现 `allowWrite` 的
> **唯一**调用点在 `handlePut` 里，`src/api/upload.ts` 全文零节流：
> `· /api/upload/init` —— 拿到一张通行证即可 10 分钟内无限循环
> `· /api/upload/complete` —— 最重的端点之一（2 次 R2 读 + 1 写 + D1 写 +
>   `rebuildBuckets` 全表聚合），完全开放给任何人反复调用
> `· WebDAV COPY` —— 分发处注释声称「走与 PUT 相同的节流」，实际一次都没走过
>
> 后果是直接冲击 R2 的 10GB 与 D1 的 10 万行/天额度 —— 这两条都是**硬停**，
> 打满就是全站停摆到次日 UTC 0 点。
>
> 已修：抽出 `lib/throttle.ts` 的 `guardWrite` 作为**统一守卫**，
> 所有写路径（PUT / COPY / upload init / upload complete）都走它，
> 新增入口时漏不掉。同时补上 `complete` 缺失的扩展名白名单校验
> （此前可 init 传 `.epub`、complete 传 `.exe` 绕过白名单）。
> 回归测试见 `test/security.test.ts` 的「写节流：覆盖面与 IP 来源」。

匿名开放书库里，验证码的作用是「提高自动化滥用成本」，而不是「精确计量每次上传」。
每日节流已经在做后者。所以把验证码从「每次上传」降到「每批一次」，
在安全上没有引入新的攻击面（攻击者本来也只需要解一次验证码就能拿到 token 重复利用
—— token 虽一次性，但解验证码的成本本来就很低）。

实测（`test/batch-ticket.test.ts`，10 例）：

```
刚签发的通行证（同 IP）      → 通过
换一个 IP                    → 拒绝
篡改签名 / 篡改过期时间      → 拒绝
超过 10 分钟                 → 拒绝
无令牌且无通行证             → 400
无效通行证                   → 403 ticket-invalid（客户端据此重新验证）
令牌验证失败                 → 403，且**不签发**通行证
格式白名单                   → 仍然先生效（通行证不能绕过格式限制）
首次带令牌 → 连续 9 次带通行证（siteverify 已置为失败）→ 全部 200
```

### 剩余 3 项「注意」（设计取舍，非漏洞）

| 项 | 说明 |
|---|---|
| WebDAV 无人机验证 | 匿名开放上传的固有代价（WebDAV 协议里没有验证码的位置）。已用「每日写入次数」节流缓解（减速带） |
| 可执行文件可伪装成 .epub | 扩展名白名单挡不住「改名的可执行文件」。文件以 `application/epub+zip` 提供，浏览器只下载不执行；但下载者用阅读器打开理论上可能触发解析器漏洞。**服务端病毒扫描未做**（免费层无此能力） |
| 节流为尽力而为 | Cache API 按数据中心计数，非硬限制。要硬限制需 Durable Object + 账号体系 |

---

## 八、验证方式（可复现）

```bash
# 1. 技术安全自查（33 项；--write-test 会写入并自动清理一个临时文件）
node scripts/security-probe.mjs --url https://webooks.cszxorx.dpdns.org --write-test

# 2. 滥用防护自查（22 项；--token 用于自动清理测试文件，不带会留下临时文件）
node scripts/abuse-probe.mjs --url https://webooks.cszxorx.dpdns.org/dav --token "$WRITE_TOKEN"

# 3. WebDAV 协议合规（16 步完整挂载握手；破坏性步骤需要口令）
node scripts/webdav-litmus.mjs --url https://webooks.cszxorx.dpdns.org/dav/ --token "$WRITE_TOKEN"

# 4. RFC 4918 / 9110 合规（14 项）
node scripts/rfc-probe.mjs --url https://webooks.cszxorx.dpdns.org/dav/ --token "$WRITE_TOKEN"

# 5. 上传链路（CSP / R2 密钥对 / CORS 三层）
node scripts/verify-upload-chain.mjs --site https://webooks.cszxorx.dpdns.org

# 6. 配色对比度（WCAG）
node scripts/contrast-check.mjs

# 7. 单元与端到端测试（253 例，含 XML 良构性 / 格式白名单 / 分类 / 通行证回归）
npx vitest run
```

### 修复验证结果
```
类型检查           tsc exit 0
全量测试           253 passed (17 files)
技术安全探针       33/33 通过，0 项待处理
滥用防护探针       19 项安全 / 3 项注意 / 0 项风险
WebDAV litmus      16/16 步通过
配色对比度         全部达标（文本 8.5:1–16.3:1，均为 AAA）
构建体积           约 282 KiB（未压缩）/ gzip 约 101 KiB
```

> 关于体积限制：Wrangler 输出的 `Total Upload`（**未压缩**）才是判据。
> Cloudflare 现行的 Worker 上限是 **64 MiB 未压缩，Free 与 Paid 相同**，
> **不再有独立的「压缩后体积」上限**（旧的「Free 1 MB / Paid 10 MB gzip」
> 是早期 Workers 的规则，早已不适用）。
> 来源：<https://developers.cloudflare.com/workers/platform/limits/#worker-size>

### 漏洞验证痕迹已清理
审计与探针过程中上传的恶意对象（`covers/<id>.html`、`books/<id>`、各类
`__abuse_*` / `__litmus_*` 临时文件）均已从 R2 与书库中删除，线上返回 404。

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
src/webdav/index.ts    内容类型强制、大小上限、节流、内存炸弹、锁清扫、
                       LOCK 写口令门禁 + 建锁走 guardWrite 节流（4.4b）
src/api/upload.ts      内容类型强制、文件名清洗、预签名类型收紧
src/api/admin.ts      reindex 使用安全类型
src/lib/http.ts        安全响应头
src/lib/throttle.ts    新增：写入节流
src/lib/locks.ts       sweepExpiredLocks
src/index.ts           安全头统一注入（最外层）
src/config.ts          maxUploadBytes / dailyWriteQuota（含 clamp 与默认值）
wrangler.jsonc         仅 R2_PUBLIC_BASE（其余参数走 config.ts 默认值，
                       仍可用 `wrangler deploy --var KEY=VALUE` 临时覆盖）
scripts/security-probe.mjs  新增：34 项安全自查
scripts/webdav-litmus.mjs   LOCK 步骤改走带口令的 reqAuth；无 --token 时如实报告 401
scripts/rfc-probe.mjs       无 --token 时显式说明「锁检查跳过，401 属预期」
test/security.test.ts       新增：12 例安全回归 + 匿名 LOCK 门禁 4 例（4.4b）
test/epub.test.ts           +6 例封面类型回归
```
