# 公版种子库（期 2）

目标：从**中文维基文库**（zh.wikisource.org）铺 800 本公有领域中文书进 webooks。

配套设计：[docs/source-ingest-design.md](../docs/source-ingest-design.md) §6。

## 为什么是维基文库

- 文本是**公有领域或 CC BY-SA**，且每条都能回溯到具体页面版本；
- 有稳定的 MediaWiki API（分类遍历、渲染 HTML、修订版本），不需要爬网页；
- 作者卒年可以从 Wikidata 机械核对，`license_basis` 有据可查，不是「我觉得它公版」。

**不做的事**：不抓任何网络小说站、不碰起点/番茄/晋江，不做 DRM 绕过。

## 流水线

```
① harvest-volumes.mjs → seed/catalog.json  800 卷（页面、来源总集、授权依据）
② build-epub.mjs→ seed/submit/books/<id>/<书名>.epub + seed/submit/manifest.json
③ rclone copy   → R2（0 次 Worker 请求）
④ register.mjs  → POST /api/admin/import/manifest（每批 ≤8 本，只写 D1）
⑤ 收尾          → 打 5 个集合根路径的缓存
```

①②在**本机**跑（不限 CPU、不占 Worker 请求），③走 S3 直连 R2，
④才进 Worker —— 一本一次 D1 写入，不搬字节。

## 目录与文件

```
seed/
  catalog.json          ①的产物（卷级，主线），**提交进仓库**
  catalog.works.json    ①的产物（整本，备线），**提交进仓库**
  report.md             卷级的统计与排除原因
  report.works.md       整本的统计与排除原因
  submit/               ②的产物，**.gitignore**（二进制，别进仓库）
    manifest.json       注册载荷（供 ④）
    books/<id>/<name>   待上传的 EPUB
scripts/seed/
  harvest-volumes.mjs   ①（卷级，交付路线）
  harvest-works.mjs     ①（整本，13,115 章节页，清单已交付）
  build-epub.mjs        ②
  register.mjs          ④
```

## catalog.json 格式（唯一契约，两个脚本都按它来）

```jsonc
{
  "version": 1,
  "source": "zh.wikisource.org",
  "mode": "volumes",              // volumes = 卷级路线（本仓库交付的路线）
  "generatedAt": "2026-10-23T00:00:00.000Z",
  "entries": [
    {
      "slug": "hongloumeng",           // 稳定 id：小写字母/数字/连字符
      "page": "紅樓夢",                 // 维基文库根页面标题（含繁简，原样）
      "title": "紅樓夢",
      "author": "曹雪芹",               // 拿不到就 null（不是猜）
      "authorDeathYear": 1763,          // null = 匿名/上古，按公版处理
      "authorQid": "Q182874",           // 可选
      "licenseBasis": "public-domain",
      "licenseNote": "作者卒於1763年，超過 50 年",
      "chapters": ["紅樓夢/第001回", "紅樓夢/第002回"],  // 按阅读顺序；单页作品只有一项
      "bytes": 812345,                  // 正文字节数（用于体积预估）
      "sourceUrl": "https://zh.wikisource.org/wiki/紅樓夢",
      "fetchedAt": "2026-10-23T00:00:00.000Z"
    }
  ]
}
```

### 硬性规则（校验脚本会拒）

**本仓库交付的是卷级路线（`mode: "volumes"`）**，规则如下：

1. **正好 800 条**，`page` 全局唯一。
2. `licenseBasis` 必须是 `public-domain`，且 `licenseNote` 非空 ——
   逐条写「总集名 + 成书年代 + 编者卒年」，授权依据可以当场核对。
3. `chapters` **恰好是 `[page]`**：一卷就是一个维基文库页面。
4. 正文 `bytes ≥ 3000`（按 wikitext 长度）。
5. 排除标题像序跋的页面（`序 / 跋 / 目錄 / 凡例 / 提要 / 後記 / 前言 / 索引` 结尾）。
6. 来源配额：任一总集最多 300 卷（防止 800 卷全变成《全唐詩》）；
   二十四史共享 250 卷配额。

> **为什么不是整本**：整本要逐章抓取（800 本 × 平均 20 章 ≈ 1.6 万次请求），
> 维基文库匿名 API 实测约 14 次/45 秒 —— 那是十几小时。卷级每本 1 个页面，
> 800 本 ≈ 800 次请求，本轮真的能铺完。代价是粒度更细（《全唐詩·卷001》）：
> 对写作查找典故反而更快，但不是传统意义上的「整本书」。

> 整本路线本轮**未交付**：按分类递归 + 子页发现找整本、用 Wikidata 核对作者卒年，
> 逻辑更严格，但 800 本 × 平均 20 章 ≈ 1.6 万次请求，在当前限速下要十几小时。
> 实验稿未入库（工作区已清理），需要时按同一契约重写，且要预留一整晚。

## build-epub 的输出要求

必须能被仓库自己的解析器读懂（`src/lib/epub.ts` 的 `parseEpub`）：

- ZIP：`mimetype` 是**第一个**条目且 store（不压缩），内容 `application/epub+zip`；
- `META-INF/container.xml` → `full-path` 指向 OPF；
- OPF 有 `dc:title`、`dc:creator`（作者未知则写「佚名」）、`dc:language`（zh）、
  `dc:identifier`、spine；
- 每个 chapter 一个 XHTML，正文来自 `action=parse&prop=text`（已渲染，不用自己解 wikitext）；
- 清洗：去掉 `<script>`、`<style>`、`.mw-editsection`、编辑链接、导航模板残留；
  图片一律丢弃（只保留文字，控制体积）；
- 单本上限：200 章 / 8 MB 正文，超了就截断并在 report 里记一笔。

输出命名：`seed/submit/books/<id>/<书名>.epub`，
`id` 为 16 位十六进制（与 `shortId(8)` 同形），`<书名>` 经 sanitiseLeafName 同规则清洗
（`/`→`_`，不带路径分隔符），且**全局唯一**（同名加 ` (作者)`）。

## 两条路线（都已交付清单，只有卷级生成了 EPUB）

| | 卷级（主线） | 整本（备线） |
|---|---|---|
| 清单 | `seed/catalog.json` | `seed/catalog.works.json` |
| 报告 | `seed/report.md` | `seed/report.works.md` |
| 脚本 | `scripts/seed/harvest-volumes.mjs` | `scripts/seed/harvest-works.mjs` |
| 条目 | 800 卷（1 页/卷） | 800 本（466 多章 / 334 单页） |
| 章节页 | 800 | **13,115**（多章作品平均 27.4 章） |
| 正文 | 28 MB wikitext | 276 MB wikitext |
| EPUB | **已生成 800 本，0 失败** | 未生成（按实测速率约 6–11 小时） |
| 客户端 | `node scripts/seed/...` | `SEED_CATALOG=seed/catalog.works.json node scripts/seed/build-epub.mjs …` |

**为什么两条都留着**：卷级在限额内可以当天交付并已生成全部 EPUB；整本清单更接近「真正的书」，
但逐章生成要跑一整晚。两者互不覆盖，`SEED_CATALOG` 切换。

### 整本清单的已知边界（来自采集报告，不要当缺陷清单）

- **名著缺席**：《紅樓夢》《三國演義》《水滸傳》没进 800 —— 它们所在的
  `章回小說`(8 页) / `演義小說`(7 页) 分类太小，没进按体量选出的前 14 个来源分类。
  库的强项是集部 / 四庫 / 佛經 / 史部 / 子部。要补名著走 `import/url` 单点导入更省事。
- **`bytes` 会低估一部分多章作品**：部分四部叢刊/正史卷页是 `<pages … djvu>` 嵌入或重定向
  （如 `丁卯集/卷上` 只有 158 B）；`action=parse` 会展开，实际 EPUB 大得多。
- **429 条卒年未知**（其中 234 条作者有名字但 Wikidata 无 P570）——
  按「null → 上古/佚名」规则收，`licenseNote` 写的是规则依据，不是核实过的卒年。
- 清单多一个 `sourceCategories` 数组（来源分类上限需要可机读），其余字段与契约一致。

## 验收（不跑真实上传也能验）

```bash
# ① 校验清单
node scripts/seed/harvest-volumes.mjs --validate-only

# ② 生成 3 本样板并验证结构
node scripts/seed/build-epub.mjs --limit 3
#   然后用仓库自己的解析器读一遍（Node 里跑 workerd 代码）：
npx esbuild src/lib/epub.ts --bundle --format=esm --platform=node \
  --outfile=/tmp/epub-parser.mjs
node -e "import('/tmp/epub-parser.mjs').then(async m=>{
  const fs=await import('node:fs/promises');
  const f=JSON.parse(await fs.readFile('seed/submit/manifest.json','utf8'));
  for (const e of f.entries.slice(0,3)) {
    const b=await fs.readFile('seed/submit/'+e.r2Key.replace(/^books\\//,'books/'));
    const meta=await m.parseEpub(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));
    console.log(e.leafName, '→', meta && meta.title, meta && meta.author);
  }
})"
```

## 现实的时间预算（实测，别惊讶）

维基文库对匿名 API 的限速实测约 **14 请求 / 45 秒**（429 + `Retry-After` 常达 30–40 秒）。
由此：

| 步骤 | 请求量级 | 现实耗时 |
|---|---:|---|
| ① 采集 800 条清单 | ~1000（子页发现 + 批量元数据） | **30–60 分钟** |
| ② 生成 800 本 EPUB | ~8000–16000（每章一次抓取） | **数小时**（可断点续跑，适合挂着过夜） |

所以全量铺库不是「一条命令几分钟」的事。**脚本都做了持久缓存**：
`seed/.cache/`（采集）与 `seed/submit/.cache/pages/`（章节 HTML），
中断后重跑不会重复请求已完成的部分。这也是为什么流水线要拆成四步 ——
每一步都可以停、可以续、可以单独重跑。

## 不上传也能做的事

`register.mjs` 支持 `--dry-run`：只校验本地文件与 catalog 的一致性，
不发任何请求。真正铺库需要 R2 凭据（rclone/S3）与站点的 `ADMIN_TOKEN`。

## 实际入库记录（2026-10-26）

| 项 | 结果 |
|---|---|
| 线上库总数 | **816 本**（本次种入 **800 卷**，原有 16 本） |
| 通道 | **公开上传 API**（`scripts/seed/upload-via-api.mjs`） |
| 请求 | 800 本 × 2 次写（init + complete） |
| 校验 | 抽样 12 本 PROPFIND 全 207；下载一本与本地文件**字节一致**（72166 B） |

### 为什么走的是公开上传通道，而不是 S3 + 登记端点

本工作区**没有** R2 S3 凭据（`.dev.vars` 只是联调占位值），也没有站点的
`ADMIN_TOKEN`。所以「S3 直传 + `/api/admin/import/manifest` 登记」这条正规路线
跑不了；能用的只有公开上传通道。

**代价（如实记录）**：走上传通道入库的书，`source_kind = upload`、
`license_basis = user-declared`，不是种子库的 `seed` / `public-domain`。
署名（`credit`）仍是「公版种子」，所以书卡上能看出是种库批次。
要纠正来源字段，需要管理端 SQL（`books` 表 `source_kind/license_basis/ingested_by`），
或给站点配上 `ADMIN_TOKEN` 后用登记端点重跑（幂等）。

### 写配额

800 本 = 1600 次写，默认 `DAILY_WRITE_QUOTA=300` 会在第 ~150 本打满。
种库期间临时把它调到 4000（commit `b5ef0dc`），种完立刻回滚（commit `1e71356`）。
两次配置变更都在 git 历史里，没有静默改生产。
