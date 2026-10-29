# 前端 / 测试质量 / 文档一致性 深度审查

- **审查对象**：webooks，HEAD `7911d40`（`fix(webdav): 分页目录的成员 href 必须落在分页路径之下`）
- **审查日期**：2026-10-28
- **审查方式**：只读源码审计 + 一次全量 `npm run check` + 在 `/tmp` 副本上做变异实验（工作区未改任何文件，未做 git 写操作，未起 dev server）
- **范围**：`src/home-page.ts`、`browse-page.ts`、`upload-page.ts`、`requests-page.ts`、`admin-page.ts`、`src/lib/theme.ts`、`src/lib/http.ts`、`public/`、`test/`（36 文件）、`README.md`、`docs/`
- **范围外**：`src/lib/requests.ts` 的 NUL 字节属可维护性，见附录 A；工作区里 `docs/frontend-backend-joint-debug.md` / `scripts/joint-debug.mjs` 有**他人未提交改动**（涉及凭据处理，由并行审查负责），本报告结论不依赖它们

---

## 0. 基线（`npm run check`，只跑了一次）

```
$ npm run check        # = tsc --noEmit && vitest run
Test Files  36 passed (36)
     Tests  736 passed (736)
  Duration  96.64s
exit code 0
```

与任务给的基线（36 文件 / 736 用例）一致，typecheck 无输出（干净）。

辅助脚本（只读）：
- `node scripts/contrast-check.mjs` → 18 项全部"达标"，exit 0（但它对 `--paper-faint` 的判据是 3:1，见 F-04）
- `node scripts/budget.mjs` → `Worker 请求 55.4% 已用 / 忙日 3× → 166.1% / R2 ≈ $0.03/月`，与 README:451-453 完全一致

### 变异实验（在 `/tmp/webooks-mut` 副本上，实验后已删除）

| # | 变异 | 结果 | 结论 |
|---|---|---|---|
| M1 | `src/webdav/propfind.ts:377` `pageSeg` 恒为 `''`（回退 7911d40 修复） | `test/webdav.test.ts` **2 红**，报错直接列出 50 条越界 href | **守卫有效** |
| M2 | `src/lib/collections.ts:436/446/470` 去掉"无尾斜杠也认目录"（回退 f4a2771 修复） | `units` 2 红 + `webdav` 4 红，共 **6 红**（units 2 + webdav 4：桶/页码 207、浏览页 200、缓存共用；302 那条因叶子解析未改而仍绿） | **守卫有效** |
| M3 | `src/lib/collections.ts:124` 去掉 `canonicalDavPath` 的分页段归一 | `units` **1 红**，无端到端用例变红 | 仅函数级守卫，见 T-03 |
| M4 | 给 `src/requests-page.ts` 加一条 `.wrap{max-width:60rem}` | `pages-syntax` 的"没有自造 .wrap"与"共用同一份 .wrap 宽度"**全绿** | **假绿**，见 T-01/T-02 |
| M5 | `src/webdav/propfind.ts:480` 让分页第 2 页不列任何成员 | "分桶集合的分页目录同理"**仍绿**（该回归只被 MAX_ENTRIES 与 `/recent/2` 两处无关用例兜住） | 断言空转，见 T-05 |
| P1 | 直接调 Worker 入口、`DAV_MOUNT=''`（根挂载），逐路径探测 | `/upload` `/requests` `/api/credits` `/admin` 全部 **404**；`/` 变成目录浏览页（首页不可达）；仅 `/health` 正常 | 路由 bug，见 F-01 |

---

## 1. 前端问题（按严重度）

严重度口径：**高**＝用户可见的功能性死路/数据风险；**中**＝明显影响某一类用户或某一端；**低**＝打磨项；**信息**＝结论性说明。

### F-01 高（条件触发）：`DAV_MOUNT=''`（根挂载）会把四个页面吞进 WebDAV 处理器

- 位置：`src/index.ts:113-120`（`isDav` 判定）与 `:140/:145/:157/:177`（`/api/credits`、`/requests`、`/upload`、`/admin` 的判定都在 `isDav` **之后**）
- 代码事实：`mount === ''` 时 `isDav` 对所有路径为真；只有 `/api/admin/**`（`:109`）在它之前。`src/index.ts:108` 的注释已经写明"admin 必须在 DAV 之前判断……否则会被 DAV 吃掉"——但**只修了 admin 一条**。
- 实测（P1）：`DAV_MOUNT=''` 时 `/upload`、`/requests`、`/api/credits`、`/admin` 均返回 `404 text/plain`（DAV 的 404）；`/` 返回 200 但内容是**目录浏览页**（含"全部藏书"，不是"一间不熄灯的"首页），即首页不可达。
- 配置明确宣称支持根挂载：`src/config.ts:143-144`（`rawMount === '' || rawMount === '/' ? ''`）、`src/index.ts:166-167`、`wrangler.jsonc:125-126`（"空串 = 挂在站点根"）。
- 影响：按注释把书库挂到站点根的使用者，得到一个只剩健康检查和 admin API 的站点。默认 `/dav` 部署不受影响，因此没有任何测试发现它（全套测试都跑默认挂载）。
- 建议：把五条页面/API 判定整体提到 `isDav` 之前（或先排除 `path === '/'`、`/requests`、`/upload`、`/admin`、`/api/` 前缀），并补一条 `DAV_MOUNT=''` 的路由用例。

### F-02 高：上传停滞会永久卡死整个上传页，且 `xhr.ontimeout` 是死代码

- 位置：`src/upload-page.ts:499-514`（`putToR2`）、`:646-675`（批量驱动）
- 代码事实：`xhr.open(...)` 后**从未设置 `xhr.timeout`**，所以 `:512` 的 `xhr.ontimeout` 永远不会触发。R2 直传一旦 TCP 半开/被中间设备挂起，Promise 永不 reject。
- 后果链：`running` 停在 `true` → `:421` `$('go').disabled = true`、`:424` `$('addmore').disabled = true`、`:684` `#clear` 直接 `return`。页面没有任何取消/中断入口，只能刷新。`fetch('/api/upload/init')`（`:595`）与 `complete`（`:627`）同样没有超时。
- 旁证：同一文件 `:508-511` 已经为 `xhr.onerror` 写了"能实际解决问题"的提示，说明这条链是被认真设计的——唯独漏了超时。
- 建议：`xhr.timeout = 120000`（并按文件大小设阈值）；`fetch` 用 `AbortController` + 超时；给队列加"取消/停止"按钮，`#clear` 在 `running` 时也允许中止。

### F-03 中高：管理后台只渲染前 200 本，且没有分页——与"能看到全部书"直接矛盾

- 位置：`src/admin-page.ts:350`（`api('/api/admin/books?limit=200&q=' + q)`，无 `offset`、无"加载更多"）、`:6`（文件头设计目标写"能看到全部书、搜索、批量删除"）
- 服务端能力：`src/api/admin.ts:129` 的 `limit` 上限是 500，并支持 `offset`——是前端没有用。
- 实测影响：仓库在第 4 步种了 800 本（`961cf5e`），后台只显示 200 本；统计行 `:276` 却写"共 800 本"。按书名/作者筛选可以找到其余的书，但"浏览全部/批量处置"这条路径对 75% 的书不可用；配合 `:485` 的"删除选中"存在误删/漏删风险。
- 建议：加 `offset` 分页或"加载更多"，或至少显示"仅显示前 200 本，请用搜索"的提示；`共 N 本` 与列表行数不一致时必须有说明。

### F-04 中：`--paper-faint` 承载真实信息但只有 3.60:1（低于 WCAG AA 4.5:1）

- 位置：`src/lib/theme.ts:49` 定义（注释写"仅用于装饰性标记，不承载信息"）；实际承载信息的用法：
  - `src/browse-page.ts:374` `.csize` = 文件大小（`48.8 MB`），而 `:397` 的注释自己说它是"点不点开的判断依据"
  - `src/browse-page.ts:298`/`:303` `.cmeta`/`.cu` = 本数单位（个/种）、`:285` 序号（aria-hidden，装饰）
  - `src/requests-page.ts:117` `.rwhen` = 相对时间；`:86` `.count` = "共 N 本"；`:55` `.opt` = "可留空"；`:108` 行号
  - `src/admin-page.ts:94` 表头；`:103` 文件名；`:59` 说明；`:126` 输入框 placeholder（`theme.ts:184` 全局把 placeholder 改成 `--paper-dim`，这里又覆盖回 faint）
  - `src/upload-page.ts:108` "会显示在书卡上"；`:145` 队列统计；`:133` "等 22 种"
- 实测对比度（本机计算）：`--paper-faint #6f6b5f` 对 `--ink #0b100e` = **3.60:1**，对 `--ink-2` = 3.33:1，对 `--ink-3` = 3.06:1。这些文字字号是 12～12.5px（`--fz-micro/xs`），属"正常字号"，AA 要求 4.5:1。
- 为什么测试没红：`scripts/contrast-check.mjs:65-66` 把该色定义为"行号用的 faint：辅助文字，按 3:1 兜底"，即**判据本身把需求降到了 3:1**；而其余 17 项都达标，输出"全部达标 ✅"。
- 建议：把承载信息的 faint 文字改用 `--paper-dim`（7.53:1）；确属装饰的（序号、点线、`/` 分隔符）保留 faint。同时把 `contrast-check.mjs` 的 faint 阈值提到 4.5，并注明"仅限 aria-hidden 的装饰位"。

### F-05 中：目录页被截断到 200 条时不告诉用户——提示块是死代码

- 位置：`src/browse-page.ts:120`（`extra.truncatedNote` 参数）、`:411`、`:426`（`<p class="note">只显示本页条目。用下一页继续……</p>`）
- 代码事实：唯一的调用点 `src/webdav/index.ts:961-963` `renderHtmlIndex()` 只传三个参数，**从不传 `extra`**；全仓没有第二处调用。于是 `.note` 分支与 `N 项 · …` 分支永远不会渲染。
- 影响：用户看到"200 项"就以为是全部；第 201 本以后只能靠注意到那张"第 2 页"卡片。这是"空/截断数据必须有 UI 反馈"的典型缺口。
- 建议：在 `renderHtmlIndex` 里按 `entries.length >= cfg.maxEntries`（或 node.page 与子目录存在性）传入 `truncatedNote`，并补一条断言 `class="note"` 会出现的测试。

### F-06 中：管理后台的求书看板/榜单加载失败会永远停在"加载中…"

- 位置：`src/admin-page.ts:354-355`（`loadRequests().catch(() => {})`、`loadCredits().catch(() => {})`）、`:217`/`:221`（初始文案"加载中…"）
- 影响：`/api/admin/requests` 或 `/api/admin/credits` 返回非 2xx 时，两块面板永久显示"加载中…"，没有任何错误提示；只有用户手动点"刷新求书"（`:471`）才会看到 toast。录得的问题还有：`/api/admin/credits?limit=50` 失败时 `#creditWrap` 连错误都不显示。
- 建议：catch 里把对应 wrap 改为可操作的错误块（含重试按钮），或至少 `toast($('msg'), '求书看板加载失败：…', false)`。

### F-07 中：`selected` 集合跨筛选/刷新存活，"删除选中"会删掉看不见的书

- 位置：`src/admin-page.ts:245`（`const selected = new Set()`）、`:287-288`/`:326-338`（渲染时按集合恢复勾选）、`:485-487`（`const names = [...selected]` + 只报数量的 `confirm`）
- 场景：勾书 A → 搜索"三体"（A 不在结果里）→ 点"删除选中 (1)" → 删除的是 A，而屏幕上只有三体；确认框只说"确定删除这 1 本书？"，不列书名。
- 建议：`load()` 成功后清空 `selected`（或只保留当前可见项），并在确认框里列出前 N 个书名。

### F-08 中低：`#drop` 是 `role="button"`，内部又嵌了真 `<button>` 与 file input

- 位置：`src/upload-page.ts:229`（`<div id="drop" role="button" tabindex="0" aria-label="…">`）、`:235`（内部 `<button id="pickbtn">`）、`:237`（`<input type=file>`）
- 问题：ARIA 规定 `role="button"` 的后代是 presentation 语义，读屏可能**不再把内部按钮单独暴露**；键盘两个焦点位（外层 div 与内层 button）都能打开文件框，语义重复。`:228-234` 的注释只论证了"必须是真按钮"，没有论证"真按钮不能放在 role=button 里"。
- 建议：把 `#drop` 改成普通区域（`<div>` + `aria-describedby` 指向格式说明），只保留一个真按钮触发选择；拖放事件仍挂在区域上。需要真读屏（NVDA/VoiceOver）复核——本审查未起浏览器，见 §4。

### F-09 中低：五页都没有 `<main>` 地标，也没有跳转链接；后台结果提示缺 live region

- 位置：`src/home-page.ts:295`、`src/browse-page.ts:407`、`src/upload-page.ts:215`、`src/requests-page.ts:151`、`src/admin-page.ts:167`（均为 `<div class="wrap">`）
- 后果：读屏用户无法"跳到主内容"；页脚、面包屑、侧栏链接逐个 Tab 才能到达正文（WCAG 1.3.1 / 2.4.1）。
- 另：`src/admin-page.ts:222` 的 `#msg`（删除/刷新结果都写这里）**没有** `role="status"`/`aria-live`，只有 `#toast2`（`:223`）有；删除结果对读屏不可感知。
- 建议：加 `<main>` + 页首"跳到正文"链接；`#msg` 补 `role="status" aria-live="polite"`。

### F-10 中低：作者输入框失焦即写库（未编辑也会写）

- 位置：`src/admin-page.ts:316-320`（`el.addEventListener('blur', save)`）
- 场景：用 Tab 依次划过 200 行的作者框，每行都发一次 `POST /api/admin/update`；写失败时 `:452` `await load()` 重渲染，焦点与滚动位置丢失。
- 建议：记录初值，`blur` 时仅在 `el.value !== original` 才提交；失败时不要整表重载，只回滚该输入框。

### F-11 中低：手机上"类型"下拉被 CSS 隐藏，手动修正 PDF 误判的入口消失

- 位置：`src/admin-page.ts:156-161`（`@media (max-width:700px)` 隐藏 `th/td:nth-child(4..6)`，第 4 列正是"类型" `<select class="edit-k">`）、`:299-303`
- 影响：README:187 承诺"管理后台里每本书都能直接改作者与类型"；在 <700px 视口上类型改不了，且没有任何替代入口（作者框仍在，类型没有）。
- 建议：手机上把类型下拉移到书名单元格内（或折叠成一行"类型：电子书 ▾"），不要整列 `display:none`。

### F-12 中低："看更多"没有在途保护，双击会追加重复行

- 位置：`src/requests-page.ts:332`（`moreEl.addEventListener('click', function(){ load(true); })`）、`:278-289`（`offset=shown`，`shown` 只在响应回来后才增加）
- 场景：快速双击 → 两个相同 `offset` 的请求 → 两次 `render(rows, true)` 都往同一个列表追加 → 同一批书出现两遍，行号也重复。
- 建议：请求期间禁用按钮（或记录 `inFlight`），失败后恢复。

### F-13 低：请求列表加载失败时，错误显示在表单下面，列表区域空白且无重试

- 位置：`src/requests-page.ts:290-293`（`#msg` 复用提交表单的消息位）、`:287`（失败时 `.empty` 仍 `hidden`）
- 建议：在列表区域放一个内联错误块（"加载失败 · 重试"），并让 `#msg` 只负责提交反馈。

### F-14 低：`prefers-reduced-motion` 没有覆盖后台的闪烁红点

- 位置：`src/lib/theme.ts:337-340`（只关 `.lamps i, body::after`）、`src/admin-page.ts:74`（`.dot2.no{animation:flicker 1.8s ease-in-out infinite}`）
- 影响：开启"减少动态效果"的用户，后台"未开启防护"的红点仍在闪；`docs/frontend-design.md:156` 声称已全部关闭。
- 建议：把 `.dot2.no` 加进降级选择器（或改成不闪的边框样式）。

### F-15 低：首页"最近上架"整张卡有 hover，但只有书名可点

- 位置：`src/home-page.ts:118-122`（`.fresh:hover` 整块变色）、`:314`（容器是 `<div>`）、`:440-455`（只有 `<a class="freshtitle">` 是链接）
- 影响：卡片两侧和上下留白看起来可点、悬停有反馈，点击无反应；键盘也只有书名一个焦点。
- 建议：要么整卡做成链接（`<a class="fresh">`，但会牵动 `.freshmeta` 的语义），要么去掉整卡 hover，只在书名上给反馈。

### F-16 低：两处 CSS 与注释不符/无效

- `src/browse-page.ts:402`：`.dirs{grid-template-columns:1fr;border-bottom:0}` —— `.dirs` 在 `:256-261` 是 `display:flex`，`grid-template-columns` 对 flex 容器无效，`border-bottom` 本来也没画。该行是旧版"手机上隐去目录"方案留下的：它既没有生效（flex 容器忽略 `grid-template-columns`），`border-bottom:0` 也没有对应边框可去掉——注释与实现脱节。
- `src/browse-page.ts:397-399`：`.cend .fmt,.csize{font-size:var(--fz-micro)}`，而 `:370`/`:374` 已经是 `--fz-micro`，这条"改小一点"是空操作。
- 建议：删掉死声明，或在 flex 下改用 `flex-direction:column`/`width:100%` 真正实现单列。

### F-17 低：`DAV_MOUNT` 的转义不一致（配置注入面，低风险）

- 位置：`src/home-page.ts:57`（`href="${s.path}"`，`s.path` 含未转义 `mount`）、`:308`（`href="${mount}"`）、`src/upload-page.ts:293`（`href="${mountHref}"`）
- 对照：`src/home-page.ts:339`/`:340` 与 `src/browse-page.ts` 全量用 `esc(mountPath)`；`config.ts:143-144` 只做了首尾斜杠裁剪，**没有**拒绝引号。
- 影响：`DAV_MOUNT` 由部署者通过 `--var` 控制，能设它的人已能改站点，因此只是纵深防御缺口；但同一文件里两种做法并存会在重构时误导人。
- 建议：统一 `esc()`，并在 `settings()` 里对 `mountPath` 做字符白名单（`[A-Za-z0-9/_-]`）。

### F-18 信息：XSS 面结论——未发现可利用注入，但有两个"配置层"残余风险

逐点核对了五页所有 `innerHTML` 与属性插值：

| 位置 | 插值来源 | 防线 | 结论 |
|---|---|---|---|
| `src/home-page.ts:434,502` | 仅 `''` 清空 | — | 安全 |
| `src/home-page.ts:376-420` | 上传者名/计数 | 全部 `textContent` | 安全 |
| `src/requests-page.ts:228-276` | 求书标题/作者/时间/人数 | 全部 `textContent`（文件内无 `esc`） | 安全 |
| `src/upload-page.ts:388-409` | 文件名/服务端标题/封面 URL/错误串 | `escapeHtml` 全包；status/mark/pct 来自代码枚举 | 安全（`coverUrl` 未校验 scheme，但 `<img>` 不执行脚本） |
| `src/admin-page.ts:266-273,276-313,367-394,420-429` | 书名/作者/文件名/求书/贡献者 | `esc()` 覆盖 `& < > " '`；`markBtn` 的 payload 用 `JSON.stringify` + `esc` | 安全 |
| `src/browse-page.ts:129-213` | 路径/书名/作者/署名/封面/格式 | 服务端 `esc()` 覆盖属性与文本上下文 | 安全 |

残余风险（均需部署者级权限，属加固项）：
1. `src/home-page.ts:454` `title.href = latest.downloadUrl || latest.href`，以及 `src/browse-page.ts:180-182` 的 `<a href>`：`downloadUrl` 直接来自 `R2_PUBLIC_BASE`，`settings()`（`src/config.ts:139-142`）只校验非空、**不校验 scheme**。若配成 `javascript:...`，书卡点击即执行脚本。建议 `settings()` 里强制 `https:` 且拒绝控制字符。
2. `src/admin-page.ts:276` `data.total`、`:373` `r.hits`、`:424` `c.books` 以裸值拼 `innerHTML`（当前 API 都是数字）。类型一旦从 `number` 变成字符串，就是注入点；建议统一 `Number()` 或 `esc()`。

### F-19 低：移动端/低端机的渲染成本

- `src/lib/theme.ts:142` `background-attachment:fixed` + `:156-163` 一个 `70vmax`、`filter:blur(24px)`、`position:fixed` 的伪元素，`@keyframes breathe` 常驻。桌面无感，低端 Android 上模糊大图层 + 固定背景是常见掉帧来源（且它只是装饰）。
- `src/lib/theme.ts:143` `overflow-x:hidden` 会掩盖真实的横向溢出，排查移动端"内容被切掉"时容易误判。
- 建议：移动端媒体查询里关掉 `body::after` 的模糊层（或降为纯渐变），不要用 `overflow-x:hidden` 兜底布局。

---

## 2. 测试质量清单

> 结论先说：**736 个用例大部分是行为断言，质量明显高于常见项目**（`SELF.fetch` 真打路由、D1/R2/Cache 真跑、不少用例自带"哨兵"防止空转）。下面 18 条是**具体的假绿/脆弱点**，不是否定整体。
> 判定口径：① 断言的是源码文本而非行为；② 断言恒真/空转；③ 断言与用例名不符；④ 时钟/顺序依赖；⑤ 缺空数据哨兵。

| # | 文件:行 | 类型 | 具体理由 |
|---|---|---|---|
| T-01 | `test/pages-syntax.test.ts:513-521` | **假绿（已用变异证实）** | "没有自造 `.wrap`"用 `/(^\|\})\s*\.wrap\s*\{/` 在拼接 CSS 里数次数，断言 `<=1`。但 theme 的 `.wrap{` 前面是注释结尾 `*/`，正则**根本匹配不到 theme 那一条**；页面自己加一条 `.wrap{max-width:60rem}` 时计数=1，`<=1` 通过。M4 实测：加了自造 `.wrap` 后两条测试全绿。这条正是它自己声称要挡的"上一版求书墙自造 .wrap"回归。 |
| T-02 | `test/pages-syntax.test.ts:524-536` | 假绿 | "五个页面共用同一份 .wrap 宽度"用 `html.match(...)` 只取**第一个** `.wrap{…max-width}`（即 theme 的 52rem），页面级覆盖写在后面永远看不到。M4 同时绿。 |
| T-03 | `test/units.test.ts:217-228` | 守卫层级不足 | 分页段归一只有**函数级**断言（`canonicalDavPath('/recent/2/x.epub') === '/最近收录/x.epub'`）；没有任何端到端用例证明"删除书后，经分页路径的 PROPFIND 不再显示它"。M3 证实：去掉归一只红这一条单元测试。commit 声称的"缓存归一"在行为层没有守卫。 |
| T-04 | `test/webdav.test.ts:604-627` | 顺序依赖（已证实） | 这条是 7911d40 的有效守卫（M1 变红），但它通常吃**缓存 HIT**：上一条用例（`:569`）已把 `/recent/2` 归一成 `/recent/2/` 并写入缓存；`clearDavCache(ALL_PATHS)`（`:18`）不含 `/recent/2/`。我实测 `/recent/2` MISS → `/recent/2/` HIT。于是"第 2 页成员 href"断言的是上一条用例生成的响应，孤立跑与串行跑的语义不同；以后谁改了前一条，这条会静默失去"独立验证生成逻辑"的意义。 |
| T-05 | `test/webdav.test.ts:629-642` | 空转断言（已用变异证实） | "分桶集合的分页目录同理"只断言 `hrefs[0]` 正确 + `outside` 为空，**没有 `members.length > 0` 哨兵**。M5 让分页第 2 页不列任何成员，这条**仍然是绿的**（只有无关的 MAX_ENTRIES 用例变红）。补一句 `expect(hrefs.length).toBeGreaterThan(1)` 即可。 |
| T-06 | `test/pages-syntax.test.ts:456-468` | 名不符实 | 用例名"署名缺失时回落到「雷锋」"，断言却是 `row!.credit === null`（服务端**不**回落）。真正的前端兜底 `latest.credit \|\| COLLECTIVE`（`src/home-page.ts:460`）没有任何断言覆盖；如果它被删掉，只会让卡片显示"空字符串 传来"，测试全绿。 |
| T-07 | `test/pages-syntax.test.ts:346-353` | 名不符实 | "首页零 D1 依赖"只断言 HTML 里没有渲染结果；无法发现"首页代码里真的查了一次 D1 但把结果丢掉"（例如有人把 `latestBook()` 加回 `index.ts:130` 附近）。要成立需要 spy D1 或统计查询次数。 |
| T-08 | `test/pages-syntax.test.ts:364-369, 574-582` | 源码文本代替行为 | "书库为空时整块移除"/"取不到数据时静默移除"断言的是生成脚本里的正则（`remove()` 出现在 200/400 字符内），不执行任何 JS。把逻辑抽成 `function dropFresh(){}` 或前置 `if (!d) return;` 都会改变行为/红绿关系，但与真实渲染无关。 |
| T-09 | `test/pages-syntax.test.ts:409-421` | 源码形状脆弱（双向） | 精确断言 `title.href = latest.downloadUrl \|\| latest.href` 的文本形状：等价重构（先算 `const u = …; title.href = u`）会**误红**；把这一行放进不可达分支或注释掉调用会**误绿**。 |
| T-10 | `test/pages-syntax.test.ts:123-145` | 源码文本代替行为 | 批量上传"一批只验证一次"靠 `perFileToken.length <= 2`、`body.ticket = ticket` 等正则断言。行为层只覆盖 API 侧（`batch-ticket.test.ts`），浏览器端"第二个文件不再取 token"没有端到端证据；把第二处 `takeToken()` 换个写法即可绕过计数。 |
| T-11 | `test/requests.test.ts:262-264` | 源码文本代替行为 + 注释过期 | XSS 防线断言 `script` 含 `title.textContent = r.title`、不含 `innerHTML = …esc(`；改名/改用 `insertAdjacentHTML`/`outerHTML` 即可绕过。同文件 `:246` 注释还写"页面脚本用 `esc()` 转义（见 requests-page.ts）"，而 `src/requests-page.ts:214` 明确说**刻意没有 esc()**——注释与代码互相矛盾。 |
| T-12 | `test/requests.test.ts:616-628` | 条件跳过 | `if (body.latest) { expect(keys).toEqual([...]) }`：一旦 `latest` 变 null，字段白名单断言**静默跳过**。同一个 describe 的 `:595` 确实插了书，当前不会 null，但这条守卫缺少 `expect(body.latest).not.toBeNull()`。 |
| T-13 | `test/download-direct.test.ts:441-447` | 弱断言 | "上限被硬 clamp 到 16"只断言响应里 `body.limit === 16`，库是空的、没有任何对象；把 clamp 只做在回显字段、查询仍按 1000 跑，测试照样绿。真正的 clamp 在 `src/api/admin.ts:662`，但守卫没钉住"实际扫描量"。 |
| T-14 | `test/author-kind.test.ts:185-197` | **时钟依赖** | 用 `Date.now()` 断言 512KiB 扫描 `< 80ms`。这正是 `test/requests.test.ts:632-639` 明确批评并移除过的"测机器闲不闲"模式（那里换成"改库看返回旧值"的确定性判据）。CI 负载高时会 flake，而且 80ms 阈值对"数量级退化"的判别力有限。 |
| T-15 | `test/migrate-keys.test.ts:243-268`、`test/admin-reindex-safety.test.ts:342` | 源码顺序断言（设计如此） | put → D1 → delete 的安全顺序**只**由 `indexOf` 文本比较守护（README:613 也承认行为用例抓不到）。把三步抽成 helper（如 `await moveObject()`）会误红；helper 内部调换顺序则看不到。这是"只能这样守"的取舍，但应标注为**文本级守卫**，并在 PR 模板里要求人工复核。 |
| T-16 | `test/static-assets.test.ts:173-213` | 抓取盲区 | 路由字面量只从 `path === '…'` / `path.startsWith('…')` 两种写法抠；新增 `switch`/正则/表驱动路由不会进入集合。`:192` 的 7 条"骨架路由"哨兵能挡住"整体换写法"，挡不住"新增一条用别的写法"。`/dav` 不在抠出的集合里（动态 `mount`），靠 `:222-223` 单独硬编码兜住。 |
| T-17 | `test/pages-syntax.test.ts:686-692` | 名不符实 | 用例名"声明的大小与产物一致（sizes 写着 32x32，图标就得真是 32×32）"，注释说"产物尺寸由 static-assets.test.ts 读真实字节校验"——但 `test/static-assets.test.ts:238-260` **只读** ICONDIR/偏移/PNG magic，**没有读 ICONDIRENTRY 的 width/height 字节**（偏移 6/7）。当前图标确实是 32×32（我读过头），但换成一个 16×16 图、`sizes` 仍写 32x32，两处都会绿。 |
| T-18 | `test/pages-syntax.test.ts:177-234` | 抓取盲区 | "脚本引用的每个 id 都在 DOM 里"从整段 HTML（**含注释和脚本字符串**）抠 `id="…"`，所以一个只存在于注释里的 id 会被当成"存在"；引用侧也只认 `$('x')`/`getElementById('x')` 字面量，动态 id 不可见。 |

补充说明（不单列条目）：
- **无 skip/todo**：全仓 `it.skip`/`describe.skip`/`todo` 为 0（grep 验证），这一点做得好。
- **无 admin 页 XSS 行为覆盖**：后台是唯一把匿名上传的 `title/author/leaf_name` 拼进 `innerHTML` 的页面，`esc()` 的存在只被间接依赖，没有任何测试断言"恶意书名不会变成标签"。workerd 里没有 DOM，但可以用 `linkedom`/`happy-dom`（新增依赖需权衡），或至少加一条"`renderList` 的模板里每个 `${}` 都经过 `esc(`"的源码免检清单并在 PR 里 review。
- **根挂载无覆盖**：36 个测试文件没有一个设置 `DAV_MOUNT:''`（`vitest.config.ts` 固定 bindings），F-01 因此不可见。
- **缓存跨用例污染是已知风险**：`test/setup.ts:36-56` 自己写了"Cache API 不随 isolatedStorage 回滚"，但各文件的 `clearDavCache(ALL_PATHS)` 列表是**手写子集**（`webdav.test.ts:18` 无 `/recent/2/`、`browse-page.test.ts:18` 无分页路径）。T-04 是第一个已实现的踩坑点；建议把 `ALL_PATHS` 换成"按前缀 purge"（`purgeByPrefixes` 已有）。

### 最近两轮修复的守卫复核（任务重点）

| 修复 | 守卫 | 能否抓住回归 | 残留问题 |
|---|---|---|---|
| `f4a2771` 尾斜杠 | `units.test.ts:125-149`（解析层 3 条）+ `webdav.test.ts:560-602`、`:644-652`（207 / 浏览页 / 缓存共用 / 302） | **能**。M2 回退后 6 条红，含"207 而不是 404""两种写法共用缓存"这类真行为断言 | "缓存共用"只测了桶目录 `/title/A`，没测分页目录 `/recent/2`（同一分支，风险低但没证据） |
| `7911d40` 分页 href | `webdav.test.ts:604-627`（分页路径前缀 + 任取一条 GET 302）+ `:629-642`（分桶集合）+ `units.test.ts:151-162` | **能**（M1 精确变红），但 `:629` 自身空转（T-05） | 典型跑法是缓存 HIT（T-04），独立性与顺序有关 |
| `7911d40` 缓存归一 | `units.test.ts:217-228` | **仅函数级**，行为层无守卫（T-03） | 建议补"删除后经分页路径 PROPFIND 不再返回该书"的端到端用例 |
| 首页/求书 XSS | `browse-page.test.ts:111-121` 是真行为断言（种子恶意书名看 HTML）；home/requests 只有源码正则 | 部分 | 缺 admin 页覆盖（见上） |

---

## 3. 文档矛盾清单（文档说法 vs 代码事实）

> 说明：`docs/review-2026-10-13.md`、`review-2026-10-14-fixes.md`、`webdav-rfc-audit-2026-10-14.md`、`frontend-backend-joint-debug.md` 是**带日期的历史记录**，其中的测试条数（253/311/681）不算矛盾、未列入。下表只列"以现在时断言当前系统"的条目。

| # | 文档:行 | 文档说法 | 代码事实 | 严重度/建议 |
|---|---|---|---|---|
| D-01 | `README.md:64` | 目录结构树："`index.ts  方法分发（Class 1：无 LOCK/UNLOCK）`" | `src/webdav/index.ts:1` "完整 Class 2（含 LOCK/UNLOCK/MKCOL/PROPPATCH/MOVE/COPY）"；`:161-182` 真实现 LOCK/UNLOCK；`src/index.ts:5` 同样写着"Class 1"；README 自己 `:710` 又说"本实现是 WebDAV Class 2" | **高**（同一份 README 自相矛盾，且 README 是唯一入口文档）。订正 `:64` 与 `src/index.ts:5` |
| D-02 | `README.md:255-256` | "密钥默认复用 `TURNSTILE_SECRET`（想独立轮换再设 `UPLOAD_TICKET_SECRET`），不引入新的必填配置" | `src/api/upload.ts:157-163`：`env.UPLOAD_TICKET_SECRET \|\| env.WRITE_TOKEN \|\| env.ADMIN_TOKEN`，注释明确写"**曾经**回落到 TURNSTILE_SECRET……回落链会断，所以改为回落到站点自己的密钥"；`:251` 一个都没有时上传 503 | **高**。按 README 配 TURNSTILE_SECRET 的人会拿到"上传能发起但永远拿不到通行证" |
| D-03 | `README.md:309-310`、`:550` | 现在时："对象键是 `books/<随机 id>`，既没有扩展名也没有书名" | `src/lib/r2.ts:84-87` `bookObjectKey()` → `books/<id>/<sanitised leaf>`；README 自己在 `:326-341` 用 ✅ 标题写"对象键已可读（2026-10-21 修）" | **高**（读者会以为直链下载名只能靠 Content-Disposition、且 `books/<id>` 是当前形态）。两处应改为"2026-10-21 之前的存量对象" |
| D-04 | `README.md:733` | 已知取舍："分桶计数用全表重建 · **每次 PUT/DELETE 跑一次聚合**" | `src/webdav/index.ts:1240-1256`（PUT 已改 `adjustBuckets` 增量）、`:1323-1324`（单本 DELETE 增量）；`src/lib/db.ts:503-504` 写明只有 reindex/批量修正/整集合删除才全量（`:1467`） | **中**。这是"取舍表"，描述的性能代价已不存在，会误导后续优化方向 |
| D-05 | `docs/frontend-design.md:208` | "每页 `.wrap{` 只定义一次，且 `max-width` 五个页面一致（**现在 64rem**）" | `src/lib/theme.ts:233` 是 **52rem**；同一文档 `:64-73` 自己写"现在全站统一 52rem"；"只定义一次"也没有测试真正守住（T-01/M4） | **高**（文档内部矛盾 + 声称的守卫不存在）。改为 52rem，并把"由测试守住"改成"人工约定"或修好 T-01 |
| D-06 | `docs/frontend-design.md:153-154` | "**所有**点击目标（含页脚链接、面包屑、返回链接）`min-height:44px` 且 `min-width:44px`" | 只对 `.site-foot a,.crumbs a,.back,.mk a`（`theme.ts:200-205`）成立。后台表格里：`input[type=checkbox]` 15×15（`src/admin-page.ts:111-114`）、`.edit-k` select ≈24px 高（`:127-131`）、`.edit-a` 输入 ≈23px（`:118-123`）、`.pill` 非交互 | **中**。改成"页面级导航链接 ≥44px；表格内联控件例外"并单独记录例外 |
| D-07 | `docs/frontend-design.md:182` | "现在全站最小可见文字是 12px，实测零个元素低于 12px" | `src/admin-page.ts:372` 在 13.5px 单元格里用了 `<small>`（UA `font-size: smaller` ≈ 11px）；`:126` 的 placeholder 用 12.5px 但对比度不足（F-04） | **中**。`<small>` 换成 `<span style="font-size:var(--fz-micro)">` |
| D-08 | `docs/frontend-design.md:105-109` | 教训："`auto-fill` 会留空轨道……**条目数量可变的网格用 `auto-fit`**" | `src/browse-page.ts:252-255` 写的是相反结论："grid 的 auto-fit 在条目少于轨道数时会留下 0px 空轨道——而 column-gap 照旧生效……flex-wrap 没有空轨道这回事"（代码已改 flex） | **中**。文档在推荐代码明确放弃的方案；应改成"用 flex-wrap，auto-fit 的 gap 仍会留空" |
| D-09 | `docs/frontend-design.md:156` | "`prefers-reduced-motion: reduce` 关掉呼吸光、闪烁点与淡入" | `theme.ts:337-340` 只关 `.lamps i, body::after`；`src/admin-page.ts:74` 的 `.dot2.no` 仍在 `animation:flicker`；且"淡入"早已不存在 | **低**。补齐选择器；删掉"淡入" |
| D-10 | `docs/frontend-design.md:158` | "最小字号 12px……**且不用 rem**" | `theme.ts:96-97` 的 `--fz-title/--fz-hero` 是 `clamp(…rem…)`；`theme.ts:334` `.empty b{font-size:1.1rem}` | **低**。改为"正文/小字不用 rem；标题用 rem 是有意的" |
| D-11 | `docs/frontend-design.md:3` | "解释 theme.ts 与**四个页面**里……" | 五个页面（`theme.ts:4` 自己列了五个；`src/index.ts` 服务五个） | **低**。四个→五个 |
| D-12 | `docs/frontend-design.md:99-103` | 现在时："浏览页的上传者署名 `.ccredit` 是 `display:inline-block` 的 `<span>`，但父元素是 flex column" | 代码是 `display:inline-flex`（`src/browse-page.ts:355`），父元素 `.cline` 是 `display:flex` **横向**（`:349`） | **低**。这段是历史 bug 复述，应改为过去时/加"已改为" |
| D-13 | `src/lib/theme.ts:49`（源注释） | `--paper-faint` "仅用于装饰性标记，**不承载信息**" | 19 处 `paper-faint` 使用中约 13 处承载信息（`browse-page.ts:298/303/374`、`requests-page.ts:55/86/108/117`、`admin-page.ts:59/94/103/126`、`upload-page.ts:108/133/145/160`）；`scripts/contrast-check.mjs:65-66` 按"行号"3:1 建模 | **中**（F-04 的根因）。注释与检索引擎都要改 |
| D-14 | `src/lib/http.ts:133-136`（源注释） | "启用 Workers Caching……**这是唯一能省下每日 100,000 请求额度的机制**" | `README.md:380-384` 与 `wrangler.jsonc:65-78` 的结论相反：Cache API **一次都不省**，Workers Caching **命中仍计费**、"净亏损，故不开"；`wrangler.jsonc` 里根本没有 `cache` 块；`README.md:384` 说唯一免费的是静态资源 | **高**（这是一段"为什么默认 no-store"的论证，前提错了；`test/cache-safety.test.ts:37` 也沿用了同一错误前提）。改成"若将来开启 Workers Caching，默认缓存会造成泄漏"（假设语气） |
| D-15 | `src/admin-page.ts:6`（源注释） | 设计目标"**能看到全部书**、搜索、批量删除" | `:350` `limit=200`，无 `offset`/分页；800 本的部署只能看到 200 本（F-03） | **中**。改注释或补分页 |
| D-16 | `README.md:419-420` | "它从 `src/index.ts` 里抠出**全部路由字面量**，断言每一条都被某个 `run_worker_first` 模式覆盖" | `test/static-assets.test.ts:173-181` 只抠 `path === '…'` 与 `path.startsWith('…')`；`/dav` 不在结果里（动态 `mount`），靠 `:222-223` 单独硬编码 | **低**。改成"全部以这两种写法声明的路由；`/dav` 另有一条硬编码断言" |
| D-17 | `README.md:793` | "400+ 个测试全绿" | 实际 **736** | **低**。改成"736 个"或"700+"（避免下次漂移） |
| D-18 | `docs/security-audit.md:221` | "`/api/upload/init` 有 Turnstile 强校验（fail-closed）" | `src/api/upload.ts:152-155` 默认**关闭**（`UPLOAD_REQUIRE_TURNSTILE` 未设即 false）；`:247-249` 只在开启时才要求 `TURNSTILE_SECRET`。审计日期 2026-10-11，早于"默认关闭"的决定（2026-10-2x），但没有被标注为"已过时" | **中**。加一条"§5.3 已于 2026-10-xx 失效，见 README §已知取舍"的抬头 |
| D-19 | `wrangler.jsonc:137` | "每条都写「带斜杠」与「不带斜杠」两种形态" | 列表（`:139-151`）里没有 `/health/`、没有裸 `/api`（只有 `/api/*`）、没有 `/dav/`（只有 `/dav` 与 `/dav/*`） | **低**。改成"页面路由写两种形态；`/x/*` 覆盖其子路径" |
| D-20 | `README.md:34-37` | "配置文件里**只有一个必填项**（`R2_PUBLIC_BASE`）" | 对"站点能起来"成立（`src/config.ts:140-142` 只对它抛错）；但**网页上传**还需要 `UPLOAD_TICKET_SECRET`/`WRITE_TOKEN`/`ADMIN_TOKEN` 之一（`src/api/upload.ts:251`），否则上传 503 | **低**。补一句"上传功能额外需要一个签名密钥（三者取其一）" |

### 已核对为"正确/已订正"的历史断言（供对照）

- ✅ **Cache API 省请求数**：README:382 已明确写"❌ 一次都不省"，`wrangler.jsonc:65-78` 同；本次抽查未发现残留的"省请求"主张（除 D-14 的 http.ts 注释）。
- ✅ **304 省 Worker 请求**：README 无此主张；`docs/rfc-compliance.md:108-114` 只讨论 GET leaf 302/目录未实现 304 的语义，并明确"目录的 304 未实现"，与代码一致。
- ✅ **reindex 能重命名对象键**：README:347-348 已写"`reindex` 改不了这件事——它写的是 `r2Key: object.key`（发现对象），不是重命名"，与 `src/api/admin.ts` 的 reindex 实现一致。
- ✅ **migrate-keys 不可逆**：README:606-615 现在是"默认 dry-run、幂等、先 put 新键→更新 D1→删旧键"，与 `src/api/admin.ts` 的 `migrateKeys` 顺序一致；`test/migrate-keys.test.ts` 同时覆盖行为与顺序。
- ✅ **预算模拟器数字**：`npm run budget` 输出与 README:451-453 逐字一致（55.4% / 166.1% / $0.03）。
- ✅ **拼音表**：README:138 "63 KiB，20935 个汉字" —— 文件 64,520 B（63.0 KiB），文件头同样写 20,935。
- ✅ **上传通行证**：README:242-252（HMAC、10 分钟、绑定 IP、只信 `CF-Connecting-IP`）与 `src/api/upload.ts:127/178-201`、`src/lib/throttle.ts:116-117` 一致。
- ⚠️ **未验证**（需要线上/真实客户端，本审查不起服务）：README:801-805 的探针计数（16/16、14/14、33/33、22 项、4 项）；litmus 套件结论；`*.workers.dev` 与自定义域行为一致性。

---

## 4. 需要真浏览器验证的项（建议，不在本次执行）

本审查按要求没有起 dev server。以下结论**只能**在真实浏览器/读屏里确认，建议用 Playwright 补测：

1. `#drop` 的 `role="button"` 是否让内部"选择文件"按钮在读屏里消失（F-08）——用一个真实 Tab 序列 + NVDA/VoiceOver 录屏。
2. 390×844 下：上传页顺序（标题→说明→按钮）、首页 `.roll-list` 单列、后台表格隐藏列后是否仍有横向溢出（F-11/F-19）。
3. 把 `--paper-faint` 用在 12px 文本上的实际观感（F-04）——对比度是算出来的，但"看不看得清"要人眼确认。
4. 首页"最近上架"整卡 hover 但只有书名可点（F-15）——鼠标移到卡片右半边。
5. `prefers-reduced-motion: reduce` 下后台红点是否仍闪（F-14）。
6. 断网/慢网（DevTools 3G + offline）下：首页榜单、求书"看更多"、上传队列各自停在哪一帧（F-02/F-06/F-13）。
7. 上传 200MB 文件时中断网络，确认队列是否永久"上传中"（F-02 的复现步骤）。

---

## 附录 A：可维护性（任务 4，补充）

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| A-1 | `src/lib/requests.ts:69`（第 69 行只有一个裸 NUL 字节，字节偏移 2759） | `const NO_AUTHOR = '\u0000';` 在源码里是**裸 NUL 字节**，不是转义写法。后果：`grep`/`git diff`/`file` 把整个文件当二进制（实测 `file` 输出 `data`，`grep` 报 "binary file matches"），代码审查、搜索、部分编辑器都会静默跳过它；任何会剥掉 NUL 的工具会把哨兵变成空串（正是注释里说"语义不清"的值）。 | 写成 `'\u0000'` 转义；同时确认 D1 里 `title_key` 的哨兵不受影响（行为不变）。 |
| A-2 | `src/upload-page.ts:356-362` | 前端 `derive()` 复制了服务端 `deriveMetadata()` 的作者/标题推断规则（注释自认"轻量版"）。两份规则已经存在偏差风险（分隔符列表、`_` 归一化），且服务端才是权威。 | 只用于"上传前预览"就够；考虑把规则表抽成共享常量，或预览改名为"文件名预览"避免暗示权威。 |
| A-3 | `src/browse-page.ts:120/411/426` | `extra.truncatedNote` 是死参数（F-05）。 | 传入或删除。 |
| A-4 | `src/browse-page.ts:402`、`:397-399` | 死 CSS / 空操作声明（F-16）。 | 删。 |
| A-5 | `src/admin-page.ts`（521 行）、`src/upload-page.ts`（695 行） | 单文件同时承载 CSS + HTML + 500+ 行内联 JS；没有任何语法/类型检查（`pages-syntax.test.ts` 只做 `new Function` 语法解析和文本正则）。改一个函数无法被 tsc 保护。 | 若要长期维护，把内联 JS 抽成 `.ts` 再在构建期字符串化（会破坏"零构建"取舍，需权衡）；至少给两个最大的脚本加集成级测试（T-10/T-17 之外）。 |
| A-6 | `src/admin-page.ts:266-429` | 多套 `innerHTML` 模板各自手写 `esc(`，没有一个统一的 `row()`/`cell()` helper——这正是"记得调用"的防线（`requests-page.ts:214` 明确批评过）。 | 抽 `function td(x){return '<td>'+esc(x)+'</td>'}` 之类的最小 helper，减少遗漏面。 |

---

## 附录 B：审查方法与可复现命令

```bash
# 基线（只跑一次）
cd webooks && npm run check

# 只读辅助
node scripts/contrast-check.mjs
node scripts/budget.mjs

# 变异实验（在 /tmp 副本，避免污染工作区）
mkdir -p /tmp/webooks-mut
tar --exclude=node_modules --exclude=.git -cf - . | (cd /tmp/webooks-mut && tar -xf -)
ln -s "$PWD/node_modules" /tmp/webooks-mut/node_modules
#   M1: propfind.ts  bookEntry 的 pageSeg 置空
#   M2: collections.ts 去掉 isBucketSegmentOf / isPageSegment 的无尾斜杠分支
#   M3: collections.ts 去掉 canonicalDavPath 的 normalised 过滤
#   M4: requests-page.ts 加 .wrap{max-width:60rem}
#   M5: propfind.ts 分页第 2 页不列成员
cd /tmp/webooks-mut && npx vitest run --project worker <相关文件>
rm -rf /tmp/webooks-mut          # 实验后已删除
```

所有 `file:line` 引用均以 HEAD `7911d40` 为准。
