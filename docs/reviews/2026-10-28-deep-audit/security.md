# webooks 安全审查（2026-10-28 · 深度审计轮）

**审查对象**：`webooks`（本地 HEAD `7911d40`）＋ 生产 `https://webooks.cszxorx.dpdns.org`
**审查方式**：源码通读（重点为 10-14 审计之后新增的 `import-url` / `import-manifest` / `ingest` 及被改动过的写路径）＋ 生产只读实测（GET / HEAD / PROPFIND / OPTIONS）＋ 公开仓库凭据扫描
**本轮定位**：**只报未修项与新代码问题**。`docs/security-audit.md` 已记录并修复的条目（HIGH-1 封面类型、HIGH-2 Content-Type、写口令分级、LOCK 门禁、大小上限、写入节流、批量通行证）不重复计数；文中仅在「与上一轮的关系」一节做交叉说明。

**实测约束（如实声明）**
- 未发送任何写方法（PUT / DELETE / MKCOL / LOCK / PROPPATCH / COPY / MOVE / POST 一律未发），未携带 ADMIN_TOKEN，未触发任何生产变更。
- 因此「生产是否设置了某个 secret」类判断，一律标注 **未验证**，不当作结论使用。
- 未起 dev server，未做本地复现（仅代码推断的条目均已标注）。

---

## 一、发现汇总

| 级别 | 数量 | 编号 |
|---|---|---|
| 高 | 3 | S1–S3 |
| 中 | 7 | S4–S10 |
| 低 | 6 | S11–S16 |

最该先修的三条：**S1（预签名上传体积无约束）、S2（管理端点无限速 + 弱口令）、S3（通行证签名复用 ADMIN_TOKEN）**。
三者可串联成一条无凭据的完整攻击链：S3/S2 拿到管理口令 → S1 烧掉存储与配额。

---

## 二、高

## [高] S1 预签名 PUT 不约束体积、暂存对象又永不清理 —— 匿名 2 次请求即可写满 R2 并借 `books.` 域名托管文件

- **位置**：`src/lib/sigv4.ts:94-118`；`src/api/upload.ts:259-262`、`src/api/upload.ts:305-320`；`src/lib/ingest.ts:163-181`
- **触发条件**：
  1. 匿名 `POST /api/upload/init`，请求体里把 `size` 声明成 1（人机验证默认关闭，见 S4）；
  2. 拿响应里的 `uploadUrl`，直接 PUT 任意字节数的 body（R2 单次 PUT 上限 5 GiB）；
  3. **不调用** `/api/upload/complete`。重复 1–2 换 key 即可叠加。
- **证据**：
  - 签名只覆盖 `host`，带 contentType 时加 `content-type`：`const signedHeaders = 'host'`（`sigv4.ts:94`），`canonicalRequest` 里 payload 写死 `'UNSIGNED-PAYLOAD'`（`sigv4.ts:118`）。**长度不在签名内**，预签名 URL 在 15 分钟内也不限使用次数。
  - `upload.ts:260` 的 `if (size > maxBytes)` 校验的是**请求体里声明的数字**，不是实际字节数；随后 `upload.ts:311` 直接签发，服务端没有任何长度钳制点。
  - 唯一看真实大小的地方在 `ingest.ts:170-181`（`head` 后 `actualSize > maxBytes` 才删）—— 属于 `complete` 路径，**不调 complete 永远走不到**。
  - 无清理：仓库内不存在任何 `uploads/` 前缀的生命周期配置或清扫实现（`grep -rn "uploads/" src | grep -Ei "delete|clean|sweep"` 无结果；`r2-cors.json` 只有 CORS）。
  - 生产该通道**确实可用**：`seed/README.md:185-193` 记录 800 卷正是走「公开上传 API（init+complete）」入库的，说明 Worker 侧已配 R2 S3 凭据。
  - `books.cszxorx.dpdns.org` 是**裸 R2 自定义域**：实测 `GET /` → 404，页面正文是 R2 自带的 `Object not found`（含 `buckets/` 说明链接与 🔥 cloudflare.com favicon，无本站品牌、无 `x-dav-*` 头），不是 Worker 代理；R2 自定义域对整桶生效、无前缀 ACL，故 `uploads/...` 与 `books/...` 同样可下载。
- **影响**：R2 免费额度 10 GB。约 **2 次**「init + PUT 5 GiB」即写满，且对象永不删除（不 complete、无生命周期），此后上传 / 导入 / 迁移全部失败或转计费；这是本项目威胁模型里排第一的「借你域名托管 + 烧配额」。白名单只限制扩展名，`uploads/…/<名>.epub` 仍可作为内容托管点。
- **建议修法**（预签名无法在签名里钉死 Content-Length，必须组合）：
  1. **先止血**：给桶配 `uploads/` 前缀的生命周期规则（1 天过期）——R2 只能在控制台/API 配，仓库里加一份 `r2-lifecycle.json` 说明文档；
  2. `init` 收紧到「每 IP 每日 10 次」这一档（与 300 次的一般写配额分开），并对同一 `filename` 去重；
  3. 恢复人机验证（见 S4），或对 `init` 加 Turnstile 的 fail-closed；
  4. 长期：小文件走 Worker 中转（可精确计数），大文件维持预签名但**必须在 PUT 后立刻 HEAD 校验并删除超限对象**（不能等到 complete）。
- **未验证**：账号侧是否手工配了 R2 生命周期规则（仓库内无痕迹，外部只读无法确认）。

## [高] S2 `/api/admin/*` 没有任何速率限制，而生产 ADMIN_TOKEN 仅 10 个字符 —— 可在线爆破拿到全站管理权

- **位置**：`src/api/admin.ts:64-78`（`authorised` 与 403 分支，全文无 `guardWrite`/`allowWrite`）；`src/lib/auth.ts:54-67`
- **触发条件**：对 `/api/admin/` 任一动作（`stats` 最轻）循环猜口令。
- **证据**：
  - `handleAdmin` 只在 `admin.ts:75` 做一次 `authorised()`，失败即 `403 Forbidden`；没有失败计数、没有退避、没有锁定，响应也不带 `retry-after`。
  - 实测（只读）：`GET /api/admin/stats` 无 token → **403**；`?token=wrongtoken123` → **403**；`Authorization: Bearer wrongtoken123` → **403**，三种路径均无速率限制相关响应头。返回 403 而非 404 说明 **ADMIN_TOKEN 在生产已配置**。
  - 口令长度：`c84cb53` 中硬编码的字面量（已由 Lead 确认为生产 ADMIN_TOKEN，**本报告不复述明文**）长度为 **10 个字符**，且与本地 `.dev.vars` 的联调口令**同值**（逐字节比对一致）。结构为人可记忆型（短字母段 + 分隔符 + 重复数字），估算搜索空间远小于 10⁶。
  - `safeEqual` 长度不等时立即返回（`auth.ts:15-20`），因此响应时间还额外泄露口令长度。
- **影响**：猜中即全站管理权 —— `/api/admin/delete` 删库（含 R2 对象与封面）、`update` 改任意书、`migrate-keys?apply=1` 重写全库对象键、`reindex`/`rebucket` 扫全表。公开仓库 + README 把这些端点写得很清楚，攻击者的信息成本几乎为零。
- **建议修法**：① 立即轮换为 ≥32 字节随机（`openssl rand -hex 32`，`npx wrangler secret put ADMIN_TOKEN`）；② 给 `/api/admin/*` 加按 IP 的失败计数 + 指数退避（Cache API 即可，与 `throttle.ts` 同款实现）；③ 长期改用 Cloudflare Access 或带签名的会话 Cookie。

## [高] S3 上传通行证的 HMAC 密钥回落到 ADMIN_TOKEN，而 HMAC 结果又匿名下发 —— 弱管理口令可被离线验证/爆破

- **位置**：`src/api/upload.ts:157-163`（`ticketSecret`）、`src/api/upload.ts:178-184`（`mintTicket`）、`src/api/upload.ts:324-333`（响应里回传 ticket）
- **触发条件**：匿名 `POST /api/upload/init`，从响应体读 `ticket`（形如 `<exp>.<64 hex>`）。
- **证据**：

  ```ts
  // upload.ts:162
  return env.UPLOAD_TICKET_SECRET || env.WRITE_TOKEN || env.ADMIN_TOKEN || null;
  ```

  `mintTicket` = `HMAC-SHA256(secret, "<exp>|<ip>")`，`verifyTicket` 用同一 secret 重算。也就是说：**只要前两个变量没配，签名密钥就是 ADMIN_TOKEN**，而「已知明文 + 对应 HMAC 输出」是校验口令猜测的标准弹药 —— 可完全离线、不受任何限速地跑。
- **影响**：把 S2 的「在线爆破」升级成「GPU 离线爆破」，对 10 字符的人可记忆口令几乎是秒级命中。命中后同 S2。此外，通行证本身是匿名发放的（默认不做人机验证），攻击者连一次验证成本都不用付。
- **建议修法**：`ticketSecret` 删掉 `|| WRITE_TOKEN || ADMIN_TOKEN` 两级回落，只认 `UPLOAD_TICKET_SECRET`；未配置时让 `init` fail-closed（`upload.ts:251` 已有 `missing` 检查，改成只认专用密钥即可）。密钥用途隔离是基本原则：**同一 secret 不要既当口令又当 HMAC key**。
- **未验证**：生产是否单独设了 `UPLOAD_TICKET_SECRET`（外部无法只读确认）。若已单独设置，本条自动降为「不良默认」而不是可利用漏洞。

---

## 三、中

## [中] S4 人机验证默认关闭，但后台「安全状态」在配了 Turnstile 密钥时会显示「已启用」—— 安全指示灯可能与事实相反

- **位置**：`src/api/upload.ts:152-155`（`requireTurnstile`，默认 false）、`src/api/upload.ts:264-283`；`src/api/admin.ts:319-347`（`securityStatus`）
- **触发条件**：部署时按旧文档设了 `TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET`（`security-audit.md` 时代的推荐配置），但没有设 `UPLOAD_REQUIRE_TURNSTILE=1`。
- **证据**：
  - `requireTurnstile()` 只读 `UPLOAD_REQUIRE_TURNSTILE`，默认 `false`；因此 `init` 里 `else if (needTurnstile)` 整段被跳过 —— **既不要 ticket 也不要 turnstileToken 就能拿到 uploadUrl**。
  - `securityStatus()` 的判定条件却是 `hasSiteKey && hasSecret`，命中时 hint 固定为「已启用：网页上传需通过验证码」（`admin.ts:330`）。两者判据不同，于是出现「后台绿灯、实际上传无验证」。
  - 实测：`GET /api/turnstile-config` → `{"siteKey":null}`（16 字节）→ 生产当前**根本没配** siteKey，所以此刻后台显示「未启用」是对的；但一旦按旧文档补上两把 key，绿灯就会变成假绿灯。
  - `docs/security-audit.md:221-223`（§5.3）仍写着「`/api/upload/init` 有 Turnstile 强校验（fail-closed），但 `/api/upload/complete` 没有」——与当前实现相反。
- **影响**：站长（本项目的目标用户是不懂安全的站长）据此判断「站点已被验证码保护」，而实际匿名脚本可无限 `init`（只受 300/日/IP 节流，S1 说明这不够）。安全控制状态的**错误上报**比没有上报更危险。
- **建议修法**：`securityStatus` 改成判 `requireTurnstile(env) && !!env.TURNSTILE_SECRET`，并新增一档 hint「密钥已配置但未启用（UPLOAD_REQUIRE_TURNSTILE≠1）」；同步修正 `security-audit.md` §5.3 与 README 的表述。

## [中] S5 管理口令可通过 URL 查询参数传递，且破坏性动作接受 GET —— 口令进日志 + 可 CSRF 的写操作

- **位置**：`src/lib/auth.ts:61-67`（`hasAdminToken`）；`src/api/admin.ts:76-78`
- **触发条件**：任何把 `?token=<ADMIN_TOKEN>` 拼进 URL 的调用（脚本书签、浏览器地址栏、第三方探针）。
- **证据**：

  ```ts
  // auth.ts:65
  const provided = bearer || (url.searchParams.get('token') ?? '');
  ```

  `handleAdmin` 只要求 `method ∈ {GET, POST}`（`admin.ts:76`），`delete` / `migrate-keys` / `reindex` / `rebucket` / `purge` 都不再校验方法。实测 `?token=wrongtoken123` 与 `Bearer wrongtoken123` 行为等价（都 403）。
- **影响**：① 口令会落进浏览器历史、Cloudflare 访问日志、中间代理、以及同源 Referer（响应头 `referrer-policy: strict-origin-when-cross-origin` 只挡跨源，同源与日志照样带完整 URL）；② 口令一旦在 URL 里，一个 `<img src="https://站/api/admin/delete?token=…">` 或预取即可触发状态变更 —— GET 上的破坏性动作天然无 CSRF 防护。
- **建议修法**：删除 `url.searchParams.get('token')` 分支，只保留 `Authorization`；破坏性 action 强制 `POST` + `content-type: application/json`（顺带获得「跨源不能带 JSON content-type 而不触发预检」的天然 CSRF 屏障）。管理页本来就用 `sessionStorage` + Bearer，去掉查询参数不影响任何既有功能。

## [中] S6 `import-url` 的私网过滤可被「尾点」主机名绕过，且未覆盖组播/保留段

- **位置**：`src/api/import-url.ts:59-89`（`isBlockedHost`）、`src/api/import-url.ts:99-109`（`rejectTarget`）
- **触发条件**：对 `POST /api/admin/import/url` 传入 `http://localhost.:8080/…`、`http://foo.internal./…`、`http://x.local./…`。
- **证据**：
  - 判定是**精确/后缀**比较：`h === 'localhost'`、`h.endsWith('.local')`（`import-url.ts:64-67`）。
  - WHATWG URL 对**带尾点的域名不做归一化**（本地实测）：`new URL('http://localhost./x').hostname === 'localhost.'`、`'foo.internal.'`、`'foo.local.'` 均原样保留 → 全部绕过上述三个判断。IP 字面量带尾点则会被归一化（`169.254.169.254.` → `169.254.169.254`），因此这条只影响域名形态，**不影响**元数据地址直连。
  - 另有未列入的段：`192.0.0.0/24`、`198.18.0.0/15`、`224.0.0.0/4`、`240.0.0.0/4`（`isBlockedHost('224.0.0.1')` 返回 `false`）。
  - `IMPORT_URL_ALLOWLIST` 默认为空，为空时**不做任何主机限制**（`if (allowlist.length > 0)`，`import-url.ts:103`）。
- **影响**：与文件头注释「拒绝 localhost/.local/.internal 等后缀」的承诺不符，是**纵深防御的缺口**。实际打穿程度受平台限制：Cloudflare Workers 的 `fetch` 一般连不上环回/内网，所以更现实的风险是「管理员被钓鱼 → 服务端代为请求任意公网 URL 并写入公开书库」。该端点本身需要 ADMIN_TOKEN（`admin.ts:108-112` 走 `handleAdmin` 统一鉴权，已核实，不是未鉴权端点）。
- **建议修法**：判定前先 `h = h.replace(/\.+$/, '')`（去掉所有尾点）再比较；补 192.0.0.0/24、198.18.0.0/15、224.0.0.0/4、240.0.0.0/4；把「默认允许任意公网主机」写进注释与文档，并在 `docs/source-ingest-design.md` 里明确建议生产配置 allowlist。

## [中] S7 `handleUploadComplete` 的 `filename` 与 staging key 无绑定，且冲突/非法时会删掉该 key 指向的对象

- **位置**：`src/api/upload.ts:366-372`；`src/lib/ingest.ts:187-225`
- **触发条件**：知道他人未完成上传的 staging key（`uploads/<UTC 日期>/<12 hex>/<名>`），调用 `complete` 时传一个**与库中已有书同名**的 `filename`（或一个 `.exe` 之类会被白名单拒绝的 `filename`）。
- **证据**：
  - `ingest.ts:187` 的 `safeName` 完全来自 `input.filename`，与 `stagingKey` 的 basename **没有任何一致性校验**；
  - `ingest.ts:194-198`（同名冲突）与 `ingest.ts:217-219`（白名单失败）都会 `await env.BUCKET.delete(key)` —— 删的是**请求者指定的 key**，不是「自己刚创建的对象」。
- **影响**：可销毁他人正在上传的暂存对象（受害者的 `complete` 随后返回 `object-not-found`）。key 的随机段是 `shortId(6)`（6 字节 / 48 bit），盲猜不现实，因此是低概率定向 DoS，而不是批量破坏；但它暴露了「暂存区没有所有权概念」这个结构问题：`complete` 对任何 `uploads/` 对象都一视同仁。
- **建议修法**：`complete` 里校验 `filename` 的末段与 `key` 的末段一致（或干脆以 key 为准、丢弃 body 里的 `filename`）；删除动作限定为「本次请求自己写入的对象」；给 `uploads/` 对象加 owner 标记（ticket 里的 IP 或随机 owner id）。
- **未验证**：管理员 `import/url` 的暂存键同样落在 `uploads/import/...` 下（`import-url.ts:394`），但同样含 48 bit 随机段。

## [中] S8 WebDAV PUT 的「是否覆盖」判定与写入之间存在 TOCTOU —— 并发两个匿名 PUT 可互相覆盖，绕过「覆盖需口令」

- **位置**：`src/webdav/index.ts:1031`（`const existing = await findBookByLeaf(...)`）～`src/webdav/index.ts:1181`（写入完成）
- **触发条件**：两个并发匿名 `PUT` 到**同一个尚不存在**的文件名。
- **证据**：`existing` 只在 `1031` 读一次；`1038` 的 `if (existing && !onlyIfAbsent && !hasWriteToken(...))` 因此对两个请求都为假 → 两者都免口令通过；随后各自 `shortId(8)` 生成 id（`1067`）与不同的 `bookObjectKey`（`1074`），最后 `upsertBook` 以 `id` 为冲突键。表上另有 `CREATE UNIQUE INDEX idx_books_leaf ON books(leaf_name)`（`migrations/0001_init.sql:31`），所以后写者会撞 UNIQUE 约束而失败 —— 但它**已经写进 R2 的字节不会回滚**。
- **影响**：「覆盖已有书需要口令」这条设计承诺在毫秒级窗口内不成立（A 的内容被 B 的字节替换，而 B 没付任何凭据）；同时留下 D1 行指向 A 的键、R2 里却是 B 的字节（或反之）的错位，以及 `books/<id>/` 下的孤儿对象。这也是「上传成功但内容不是我的」这类难排查事故的来源之一。
- **建议修法**：把叶子名的抢占前移为一次原子写入 —— `INSERT INTO books(leaf_name, …) VALUES(…) ON CONFLICT(leaf_name) DO NOTHING`，`changes === 0` 时再走口令校验与覆盖分支；或先把对象写到 `books/<临时 id>`，D1 抢占成功后再确认。**以 `leaf_name` 唯一索引为准，不要用「先查后写」。**
- **未验证**：实际竞态窗口与 D1 的约束报错形态（需本地 miniflare 复现；本任务禁止写生产，故仅为代码推断）。

## [中] S9 覆盖上传超限时，413 兜底会删除**旧书**的 R2 对象 —— 一次失败的上传即可让整本书内容永久丢失

- **位置**：`src/webdav/index.ts:1074`（覆盖时沿用 `existing.r2_key`）、`src/webdav/index.ts:1181-1192`（超限删除）
- **触发条件**：带写口令覆盖一本已存在的书，而实际收到的字节数 > `cfg.maxUploadBytes`（例如把 `MAX_UPLOAD_BYTES` 调到 10 MiB 以节省空间，然后误传一个 50 MiB 的文件；或 chunked 请求无 `Content-Length` 时预检被跳过）。
- **证据**：

  ```ts
  const r2Key = existing?.r2_key ?? bookObjectKey(id, leafName);   // 覆盖 → 旧键
  ...
  object = await env.BUCKET.put(r2Key, request.body, { httpMetadata }); // 旧键已被新字节替换
  if (cap > 0 && (object?.size ?? 0) > cap) {
    await env.BUCKET.delete(r2Key);   // 把刚覆盖进去的对象（也就是原书的位置）删掉
    return textResponse(413, ...);
  }
  ```

  删除的是**这本书的唯一对象键**，而不是「本次新写的临时对象」。
- **影响**：旧内容在上一步 `put` 时已被覆盖（不可恢复），随后连新对象也被删掉，而 D1 行仍在 → 该书在目录里可见、点开 404。属于**数据丢失**级别，触发者是持有写口令的正常用户的一次误操作。
- **建议修法**：覆盖路径改为「先写 `books/<id>/.tmp-<rand>`，校验大小与解析都通过后再 `put` 到最终键并删旧键」，失败时只删临时键；至少要在超限分支里判断 `existing`：若为覆盖，**不要删除**，只回 413 并把对象回滚为旧内容（需要事先备份旧对象或改用临时键）。

## [中] S10 `WRITE_TOKEN` 未配置时鉴权 fail-open —— 全新部署默认「任何人可删光书库」

- **位置**：`src/lib/auth.ts:54-58`（`if (!expected) return true;`）、`src/webdav/index.ts:145-147`、`151-153`、`179-180`
- **触发条件**：部署时没有设置 `WRITE_TOKEN`（`wrangler.jsonc` 的 vars 里没有它，README 只说「建议配」）。
- **证据**：`hasWriteToken` 在 `expected` 为空时**直接返回 true**；`DELETE` / `MOVE` / `LOCK` 三道门禁全部依赖它。设计上是有意的「向后兼容」，但方向反了：管理口令（`hasAdminToken`）未配置时是 fail-closed（`auth.ts:62`），写口令却是 fail-open。
- **影响**：这是本轮**唯一会直接导致「全库被一个脚本删光」的配置状态**，且默认状态即如此。项目是公开仓库 + README 明写 WebDAV 用法，攻击者不需要读源码就知道试 `DELETE`。后台虽有红色告警（`admin.ts:344-350`），但它只在有人登录后台时可见。
- **建议修法**：改 fail-closed —— 未配置 `WRITE_TOKEN` 时，破坏性方法直接回 `403`/`501` 并附一句「本站未启用写保护，请联系站长设置 WRITE_TOKEN」；如担心破坏老部署，可用一个显式逃生开关 `ALLOW_UNPROTECTED_WRITES=1`。同时把 README/`wrangler.jsonc` 里 `WRITE_TOKEN` 从「建议」改为「部署必填」。
- **未验证**：生产是否已设置 `WRITE_TOKEN`（需要发一次 DELETE 才能区分 401/404，按本轮只读约束未做）。

---

## 四、低

## [低] S11 死代码 `preferContentType()` 仍在，而它正是 HIGH-2 的成因

- **位置**：`src/lib/metadata.ts:62-70`
- **触发条件**：将来任何一次写路径重构重新引用它。
- **证据**：全仓 `grep -rn "preferContentType" src/` 只有定义处一次命中 —— 没有任何调用者；但函数体仍是「客户端声明优先」的旧语义，且注释还写着「泛型就回退到扩展名推导」，读起来像推荐用法。
- **影响**：上一轮 HIGH-2（`text/html` 托管）的根因就是这个函数。留着它等于把已拆除的引信放回抽屉，下一次「复用现有工具」的重构会静默重演漏洞。
- **建议修法**：删除该函数；如需保留历史说明，把语义写进 `safeContentTypeFor` 的注释里（那里已经有完整的安全理由）。

## [低] S12 求书墙的「匿名标识」盐是公开的小时桶 —— 拿到 D1 即可离线还原 IP

- **位置**：`src/lib/requests.ts:158-171`（`anonKey`）
- **触发条件**：攻击者取得 D1 快照（或拥有只读管理权限）后，对 `requests.anon_keys` 做离线暴力。
- **证据**：`material = "${titleKey}|${authorKey}|${ip}|${hourBucket}"`，`hourBucket` 由 `Date.now()/3600000` 直接算出（不是 secret），摘要截断到 16 hex。求书时 `title/author` 是攻击者可自行提交的，因此除 IP 外全部已知 —— 32 bit 的 IPv4 空间在一张 GPU 上是分钟级。
- **影响**：伪匿名（pseudonymisation）被当成匿名使用。`anon_keys` 不对外暴露（`publicView` 只出 title/author/hits/lastAt，已核实），所以当前仅影响「拿到库的人」；但项目声明「审计日志缺失、不留 IP」，这条与该承诺不完全一致。
- **建议修法**：改用带**服务端密钥**的 HMAC（`UPLOAD_TICKET_SECRET` 之类的专用 secret，且不要复用），或干脆只存「本条目的匿名计数」而不存任何可还原标识。

## [低] S13 `NO_AUTHOR` 用裸 NUL 作哨兵：源码被 grep 判为二进制，且求书入参不过滤控制字符

- **位置**：`src/lib/requests.ts:69`（`const NO_AUTHOR = '<0x00>';`）、`src/lib/requests.ts:117/133`（`validateRequestInput` 只 `trim()`）
- **触发条件**：① 任何对 `src/lib/requests.ts` 做 `grep`/`rg` 的安全扫描；② 提交 `{"title":"\u0000"}` 之类的求书请求。
- **证据**：文件中存在**字面量 NUL 字节**（`file` 判为 `data`，`grep` 输出「binary file matches」并**跳过匹配行**）；`normaliseKey()` 不剥离 C0 控制字符，`validateRequestInput` 只用 `trim()`，因此 `title` 归一化后可以是 `"\u0000"` —— 与 `NO_AUTHOR` 哨兵同值，混进 `UNIQUE(title_key, author_key)`。
- **影响**：① 审计工具链会**静默漏扫**这个文件（本轮实测：`grep -rn` 对 `src/lib/requests.ts` 与 `src/api/requests.ts` 直接报 binary），这本身是安全流程缺陷；② 数据层面可造出语义上「无作者」的键，污染求书聚合。危害有限，但两条都该修。
- **建议修法**：哨兵改成不可能出现在输入里的形态（如 `'\u0001no-author'`，或直接 `NULL` 语义 + 单独列），源码里用转义写法 `'\u0000'` 而**不要**写字面 NUL；`validateRequestInput` 增加 `[\u0000-\u001f\u007f]` 过滤（`sanitiseCredit` 已有同样的写法，可直接复用）。

## [低] S14 公开仓库暴露了账号相关的资源标识与真实凭据前缀

- **位置**：`wrangler.jsonc:45-57`（`database_id: b0edfbd4-…`、`bucket_name: webooks-bucket`）；`docs/security-audit.md:256-262`
- **触发条件**：任何人 `git clone` 本仓库。
- **证据**：线上是公开仓库（`api.github.com` 返回 `private:false`，由 Lead 交叉确认）。`wrangler.jsonc` 里 `database_id` 是**账号相关**值（文件自己的注释也承认「它是账号相关的」）；`docs/security-audit.md` 的「提示 2」以明文列出了 R2 API Token / Access Key ID / Secret Access Key / Turnstile Secret / Account ID 的**前缀**，并写着「建议全部轮换」。
- **影响**：单独的 `database_id` + `bucket_name` 不可直接利用（仍需账号凭据），但可被用于指纹与定向钓鱼；凭据前缀本身不构成泄露（剩余熵很高），真正的风险是**该文档自述的轮换是否真的执行过**——如果没执行，那些凭据仍在有效期内。这一点无法从仓库侧验证。
- **建议修法**：把 `database_id` 换成占位注释（部署时由 `wrangler deploy` 自动回填），或用 `wrangler.jsonc` 的 secrets/环境变量方案；`docs/security-audit.md` 的凭据前缀一并打码成 `<已轮换，值略>`；在文档里给出轮换完成的时间戳，避免「建议轮换」长期悬空。

## [低] S15 CI 供应链：第三方 action 只用 tag 固定，且 fork PR 会执行 `npm ci` 的安装脚本

- **位置**：`.github/workflows/deploy.yml`（`actions/checkout@v4`、`cloudflare/wrangler-action@v3`；`npm ci`）
- **触发条件**：① 上游 action tag 被移动（供应链投毒）；② 外部 PR 修改 `package-lock.json` 引入带 `postinstall` 的依赖。
- **证据**：workflow 里 `permissions: contents: read`（好），secret 只在 `deploy` / `verify-live` job 注入（好）；但 action 引用是 `@v3`/`@v4` 而非 commit SHA，`npm ci` 也没有 `--ignore-scripts`，而 `on: pull_request` 会对 fork PR 跑 `verify` job。
- **影响**：fork PR 可在该 job 内执行任意安装脚本；由于该 job 不注入任何 secret、权限只有 `contents: read`，影响面被限制在 CI 资源与「污染 runner 缓存」层面，属于低风险但常见缺口。
- **建议修法**：`cloudflare/wrangler-action` 等第三方 action 固定到 commit SHA（Dependabot 可自动更新）；`npm ci` 加 `--ignore-scripts`（本项目没有需要构建的原生依赖）；或给 `pull_request` 增加 `paths` 过滤 / 用 `pull_request_target` 时要格外小心。

## [低] S16 `import/manifest` 绕过了「所有写路径统一走 `guardWrite`」的规则，且 `sourceUrl` 无长度上限

- **位置**：`src/api/import-manifest.ts:78-129`（无 `guardWrite`）、`src/api/import-manifest.ts:189-190`（`sourceUrl` 未截断）
- **触发条件**：持有 ADMIN_TOKEN 者批量调用；或单条 `sourceUrl` 传入超长字符串。
- **证据**：`handleImportManifest` 是四条写路径里唯一没有 `guardWrite` 的（其它三条 `PUT`/`COPY`/`upload init`/`upload complete` 都有）；`title` 截到 500、`author` 截到 200、`language` 截到 16，但 `sourceUrl` / `sourceEntry` 原样写入 D1。
- **影响**：`throttle.ts` 的注释把「写路径必须调用 guardWrite」立成一条可 review 的规则，这里破了例，后续新增入口会照抄。`sourceUrl` 超长会让单行超出 D1 的值大小限制而报错（批量导入时表现为「某几条莫名失败」）。
- **建议修法**：`handleImportManifest` 开头补 `guardWrite`（管理员也计入日配额，与 `import/url` 保持一致）；`sourceUrl` / `sourceEntry` 各 `slice(0, 2048)`。

---

## 五、已核验通过（本轮复测，不重复计数）

只读实测 + 代码复核，以下控制**当前有效**：

| 项 | 实测 / 依据 |
|---|---|
| 管理端点未配置时 fail-closed | `admin.ts:74` 返回 404；生产已配置故实测 403，无 token/错 token/错 bearer 均 **403** |
| 安全响应头 | `/dav/` HTML：CSP 全套 + `x-frame-options: DENY` + `nosniff` + `referrer-policy` + HSTS，实测均存在 |
| 207 响应不带 CSP | `PROPFIND /dav/` → `content-type: application/xml`，无 CSP（符合设计） |
| 路径穿越 / 源码泄露 | `/package.json`、`/wrangler.jsonc`、`/.env`、`/.git/config`、`/src/index.ts`、`/docs/security-audit.md`、`/scripts/joint-debug.mjs` 全部 404 |
| R2 桶不可列举 | `https://books.…/?list-type=2&prefix=uploads/` → **404**（无 XML 列表） |
| 下载类型强制 | 书籍对象 `content-type: application/epub+zip` + `content-disposition: attachment`（实测 HEAD） |
| XML 转义完备 | `escapeXml` 覆盖 `& < > " '`；`encodeHref` 逐段 `encodeURIComponent`；`extractTagNames` 的标签名字符集是 `[A-Za-z0-9_.-]`，PROPPATCH 回显无法注入 XML |
| HTML 转义完备 | `browse-page.ts`、`admin-page.ts` 所有插值均过 `esc()`；资产/作者/署名/下载 URL 全部转义；requests 页用 `textContent` |
| Header 注入 | `r2.ts` 双层清洗（`UNSAFE_HEADER_CHARS` 替换 + `ASCII_SAFE_CHARS` 白名单），`filename*` 走 UTF-8 百分号编码；`sanitiseLeafName` 已剥离 CR/LF |
| 预签名作用域 | 单键（路径已签名）、单方法（canonicalRequest 固定 `PUT`）、content-type 已签名、15 分钟过期；`verifyTicket` 用 `safeEqual` |
| 上传 complete 不可重放放大 | 首次 complete 会搬走并删除 staging 键，重放 → `object-not-found`；扩展名白名单在 `ingest.ts:216-225` 再做一次 |
| 匿名 LOCK 已有门禁 | 分发层 `webdav/index.ts:179-180` 要求写口令（上一轮 4.4b 已修，本轮确认仍在） |
| COPY 白名单/口令/节流 | `handleMoveCopy` 对目标扩展名、覆盖口令、`Overwrite: F`、`If-None-Match: *`、`guardWrite` 均有分支 |
| 求书 POST 有节流 | `api/requests.ts:94` 调 `guardWrite`（300/日） |
| XXE / 实体扩展 | 不使用 XML 解析库，正则/线性扫描；`DAV_BODY_LIMIT = 8 KiB` 前置限长，1 MB 构造输入未触发慢响应（服务端首字节 1.4 s，其中大部分是客户端上传时间） |
| 并发/内存炸弹 | EPUB 三档（≤50 MB 解析、>50 MB 流式、chunked 流式）；`zip.ts` 有 `MAX_INFLATION_RATIO=200` + inflate 上限 |
| 错误信息 | 不泄露堆栈；D1 schema 错误单独转 503 提示，其余 500 由平台兜底 |
| `Depth: infinity` | 实测 207 且按 `depthInfinity=downgrade` 降级为 1（未放大） |

---

## 六、需运营确认（无法只读验证，均不计入上面的级别统计）

| 项 | 为什么无法验证 | 建议动作 |
|---|---|---|
| 生产是否设置 `WRITE_TOKEN` | 只能靠一次 `DELETE` 的 401/404 区分，本轮约束禁止写方法 | 登录后台看「删除/覆盖口令」指示灯，或 `npx wrangler secret list` |
| 生产是否设置 `UPLOAD_TICKET_SECRET` | 外部不可见 | `npx wrangler secret list`；未设则 S3 立即可利用 |
| R2 是否配了 `uploads/` 生命周期规则 | 仓库无痕迹，控制台外部不可见 | R2 → Bucket → Settings → Object lifecycle |
| 上一轮文档所述 R2/Turnstile 凭据是否已轮换 | 文档只写「建议」 | 轮换并在文档里记录时间戳 |
| 生产 `MAX_UPLOAD_BYTES` 实际值 | `--var` 可临时覆盖，仓库只有默认值 | `wrangler` 配置核对；若调小则 S9 更易触发 |

---

## 七、仓库公开后的凭据扫描（Lead 交办项）

**范围**：`git ls-files` 全部 **149** 个跟踪文件 + `git log --all` 全部 **108** 个提交（`.git` 仅 7.1 MB，全历史已扫）；覆盖 `src/ scripts/ test/ docs/ migrations/ seed/ refs/ .github/ README.md`。

| 检查 | 结果 |
|---|---|
| `cfut_` / `0x4AAAAA`（Turnstile）/ `AKIA…` / `ghp_…` / `sk-…` 形态 | 工作区仅 `docs/security-audit.md:259,261` 的两处**前缀**（见 S14）；历史中**零命中** |
| `TOKEN/SECRET/PASSWORD/API_KEY = "<字面量>"` | 工作区仅 `vitest.config.ts:114,123` 的测试占位；`test/` 下唯一 Bearer 字面量长 16 字符且以 `tes…` 开头，明显是测试占位；**无生产凭据** |
| 长 base64 / 40+ 位 hex | 3 处 base64 形态均为字符集常量与测试夹具（`r2.ts:126`、`test/r2-download.test.ts:372`、`joint-debug.mjs:51` 的 miniflare sqlite 文件名）；**无 32 位 account id** |
| 全历史里的令牌字面量 | 仅 `c84cb53` 的 `scripts/joint-debug.mjs:28` `const ADMIN = '…'` 一处 |
| 本地密钥文件 | `.dev.vars` **未被跟踪**且 `.gitignore:7` 已挡；内容为占位（Turnstile 空、R2 凭据占位），但 `ADMIN_TOKEN` 与线上同值（见 S2，应随之一并更换） |

> **已由 Lead 确认并处置**：`scripts/joint-debug.mjs` 在 `c84cb53` 中硬编码了生产 ADMIN_TOKEN，仓库公开导致该值进入 `origin/main` 历史；工作区已改为只读 `JOINT_ADMIN_TOKEN` 环境变量，历史中的值只能靠轮换作废（本地 wrangler 未登录，需用户执行）。本报告不再复述明文。

**公开仓库的次生风险（除 S14 外）**：README / `docs/DEPLOY.md` 完整公开了管理端点路径、secret 名（`ADMIN_TOKEN` / `WRITE_TOKEN` / `UPLOAD_TICKET_SECRET`）与 `?token=` 之类的调试用法。对 OSS 而言这是常规且可接受的信息，但它把「S2 在线爆破」与「S5 URL 传口令」的**信息成本降到零**——修 S2/S5 时不必额外考虑「攻击者不知道端点」这种不存在的保护。

---

## 八、与上一轮审计的关系（交叉说明）

- `docs/security-audit.md` 的 HIGH-1/HIGH-2 修复**仍然有效**（`safeContentTypeFor` 三条写路径、封面魔数嗅探、`r2HttpMetadata` 落盘），本轮未发现回退；但 HIGH-2 的成因函数 `preferContentType` 仍作为死代码留存（S11）。
- 上一轮 5.3「`/api/upload/init` 有 Turnstile 强校验」**已与当前实现不符**（S4）。这是一次功能性回退 + 文档未同步，不是新代码的问题，但必须一起修。
- 上一轮「节流为尽力而为」「无账号体系」「内容审核缺失」等**遗留风险**不变，本轮不重复计数。
- 本轮新增攻击面集中在三条新代码路径（`import-url` / `import-manifest` / `ingest`）以及**被改动过的 `upload.ts`**（通行证改为 HMAC、人机验证默认关闭、`complete` 接入统一管道）—— 新问题几乎全部落在后者，`import-url` 只贡献了 S6。

---

## 九、复现方式（只读）

```bash
B=https://webooks.cszxorx.dpdns.org
# 1) 管理端点鉴权（应为 403 且无限速）
curl -sS -o /dev/null -w '%{http_code}\n' "$B/api/admin/stats"
curl -sS -o /dev/null -w '%{http_code}\n' "$B/api/admin/stats?token=wrong"
# 2) 人机验证实际状态
curl -sS "$B/api/turnstile-config"            # {"siteKey":null}
# 3) R2 桶不可列举 + 裸自定义域
curl -sS -o /dev/null -w '%{http_code}\n' "https://books.cszxorx.dpdns.org/?list-type=2&prefix=uploads/"
curl -sS -D - -o /dev/null "https://books.cszxorx.dpdns.org/" | head -3   # R2 默认 404
# 4) WebDAV 能力面（只读动词）
curl -sS -X OPTIONS -D - -o /dev/null "$B/dav/"
curl -sS -X PROPFIND -H 'Depth: 0' -H 'Content-Type: application/xml' \
  --data '<D:propfind xmlns:D="DAV:"><D:prop><D:lockdiscovery/></D:prop></D:propfind>' "$B/dav/"
```

凭据扫描复现：`git ls-files -z | xargs -0 grep -EIn '<模式>'`，以及 `git log --all -p -- <路径> | grep -E '^\+.*<模式>'`；本报告中的所有密钥均已掩码，未落盘明文。
