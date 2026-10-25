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
① harvest.mjs   → seed/catalog.json      800 条候选（页面、作者、卒年、授权依据）
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
  catalog.json          ①的产物，**提交进仓库**（它是清单，不是内容）
  report.md             ①的统计与排除原因
  submit/               ②的产物，**.gitignore**（二进制，别进仓库）
    manifest.json       注册载荷（供 ④）
    books/<id>/<name>   待上传的 EPUB
scripts/seed/
  harvest.mjs           ①
  build-epub.mjs        ②
  register.mjs          ④
```

## catalog.json 格式（唯一契约，两个脚本都按它来）

```jsonc
{
  "version": 1,
  "source": "zh.wikisource.org",
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

1. **正好 800 条**，`page` 全局唯一。
2. `licenseBasis` 必须是 `public-domain`。
3. 授权判定：`authorDeathYear === null` → 视为公版（上古/匿名），
   或 `authorDeathYear + 50 < 2026`。**卒年 > 1975 一律剔除**
   （1976 年卒 → 2026-12-31 才到期，现在仍在保护期）。
4. `chapters` 非空，且每一项都以 `page` 开头（`page` 本身或 `page/子页`）。
5. 排除「不是书」的页面：标题以 `序 / 跋 / 目錄 / 凡例 / 提要 / 後記 / 前言 / 索引`
   结尾，或标题长度 < 2。
6. 组成约束（防止整库都是佛经或短诗）：
   - 至少 **400 条**是多章作品（`chapters.length ≥ 2`）；
   - 任一来源分类最多 **300 条**；
   - 单页作品（`chapters.length === 1`）正文至少 **20 KB**。

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

## 验收（不跑真实上传也能验）

```bash
# ① 校验清单
node scripts/seed/harvest.mjs --validate-only

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
