#!/usr/bin/env node
/**
 * 请求预算模拟器。
 *
 * 回答一个问题：这套设计在 Workers Free 的额度内能撑多少用量？
 *
 * 它按真实实现建模，而不是拍脑袋：
 *   - PROPFIND 只读 D1（不调用 R2 list()），所以列表操作不消耗 R2 Class A；
 *     代价是缓存未命中时约 200 行 D1 读取。
 *   - **浏览器从浏览页点开一本书现在是 R2 直链**：0 次 Worker 请求
 *     + 1 次 R2 Class B。直链的 Location 由渲染层直接写进书卡 href，
 *     请求根本不进 Worker。
 *   - **WebDAV 客户端的 GET 仍然撞 302**：`GET /dav/<书>` 返回
 *     302 跳到 R2 公开域，1 次 Worker 请求 + 1 次 R2 Class B，
 *     字节不过 Worker。这一条**没有变** —— rclone / Finder 依赖它。
 *     所以「下载不再花请求」只对浏览页成立，WebDAV 同步那部分照旧。
 *   - 未知路径（扫描器的长尾）由 `public/404.html` 应答，不调用 Worker。
 *   - ⚠️ 目录页 HTML **不是**免费的：它是 Worker 渲染的，每个页面浏览
 *     都是 1 次请求。曾经这里写着「可被 CDN 缓存，重复浏览不消耗 Worker
 *     请求」，那句话是错的（Cache API 命中时 Worker 照跑），也是本站
 *     一度「模型说 16%、现实打满 10 万」的原因之一。
 *
 * 用法：
 *   node scripts/budget.mjs
 *   node scripts/budget.mjs --books 20000 --browse 500 --mounts 100 --syncs 10
 */

const FREE = {
  workerRequestsPerDay: 100_000,
  d1RowsReadPerDay: 5_000_000,
  d1RowsWrittenPerDay: 100_000,
  r2StorageGbMonth: 10,
  r2ClassAPerMonth: 1_000_000,
  r2ClassBPerMonth: 10_000_000,
};

const PAID = {
  workersBase: 5.0,
  workersRequestsIncluded: 10_000_000,
  workersRequestPerMillion: 0.3,
  r2StoragePerGbMonth: 0.015,
  r2ClassAPerMillion: 4.5,
  r2ClassBPerMillion: 0.36,
  d1RowsReadIncluded: 25_000_000_000,
  d1RowsReadPerMillion: 0.001,
  d1RowsWrittenIncluded: 50_000_000,
  d1RowsWrittenPerMillion: 1.0,
};

/** 与 src/config.ts 的 HARD_MAX_ENTRIES 保持一致 */
const MAX_ENTRIES = 200;

function parseArgs(argv) {
  const out = {
    books: 5000,
    avgBookMb: 2.5,
    browse: 300,        // 每天"浏览几个目录 + 下几本书"的会话数
    mounts: 20,         // 每天新挂载 WebDAV 的会话数
    syncs: 2,           // 每天全库 rclone 同步次数
    pageViews: 300,     // 每天网页目录页浏览
    // ── PROPFIND 条目缓存命中率（只减免 D1 行读，不减免请求）─────────────
    //
    // 2026-10-16 本地 `wrangler dev --port 8840` 实测。观测点是响应头
    // `x-dav-cache: HIT|MISS`（src/webdav/propfind.ts 天然设置，零插桩）；
    // 测前用 `POST /api/admin/purge?path=…` 或删 `.wrangler/state/v3/cache`
    // 清键 —— 不先清就会读到上一轮的 HIT，把「冷」测成「热」。
    //
    // 四种场景全测了，差异**极大**，所以拆成两个参数、各取自己那档，
    // 不做平均粉饰（取平均会同时高估遍历、低估重复）：
    //
    //   A 全库遍历（rclone 递归走全树，每个目录列 1 次）
    //     12 次 PROPFIND → **12 MISS / 0 HIT = 0%**
    //   B 紧接着重跑同一遍（300s TTL 内，键还是热的）
    //     12 次 → **0 MISS / 12 HIT = 100%** ← 两次真同步相隔数小时，用不上
    //   C 同一个键连打 8 次 → 1 MISS + 7 HIT = **87.5%**（预热后 100%）
    //     ← 这是**突发**上限，本模型没有对应用量（浏览页走 GET 不查缓存）
    //   D 模拟一次挂载会话：6 个目录各列 2 次 → 6 MISS + 6 HIT = **50%**
    //     ← 这才是 mounts 那一路的形状，所以下面取 50%
    //
    // 键只有「规范化路径 + depth」（src/lib/cache.ts 的 entriesCacheKey），
    // 不含 query，所以 `?limit=10` 之类的变体照样命中；换目录就是换键。
    cacheHitRate: 0.5,
    // 遍历场景（syncs 那一路）的命中率。实测 A 为 0，且从键的构成看没有
    // 任何命中余地 —— 一次全库同步就是把每个目录键各读一遍。
    cacheHitRateTraversal: 0.0,
    uploadsPerDay: 20,
    // 每次网页浏览附带的隐式请求数。现在是 0 —— favicon 已挪到静态资源层。
    // 加任何「浏览器自动请求且必须过 Worker」的东西时，把它加回来。
    implicitPerPageView: 0,
    // 未建模流量（爬虫/扫描器/重试）。默认 0 并在结论里标注；不猜。
    bots: 0,
    peakFactor: 3,      // 忙日系数：某天流量是平时的几倍（**不是** QPS 峰值，见结论处注释）
  };
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (!(name in out)) {
      console.error(`未知参数: ${key}`);
      process.exit(2);
    }
    const num = Number(val);
    if (!Number.isFinite(num) || num < 0) {
      console.error(`${key} 需要一个非负数字，收到: ${val}`);
      process.exit(2);
    }
    out[name] = num;
    i++;
  }
  return out;
}

/**
 * 复刻 src/lib/collections.ts 的目录树形状，用来算目录总数。
 * 目录总数直接决定「挂载一次要发多少个 PROPFIND」。
 */
function treeShape(books) {
  const LETTER_BUCKETS = 28;   // A-Z + 0-9 + other
  const FORMAT_BUCKETS = 12;
  // 书尽量平均分布到各个桶；每个桶超过 MAX_ENTRIES 就要分页
  const pages = (n, buckets) => Math.ceil(Math.ceil(n / Math.max(buckets, 1)) / MAX_ENTRIES);
  const titlePages = pages(books, LETTER_BUCKETS);
  const authorPages = books > 0 ? pages(books, LETTER_BUCKETS) : 0;
  const formatPages = books > 0 ? pages(books, Math.min(FORMAT_BUCKETS, 6)) : 0;
  const recentPages = books > 0 ? Math.ceil(books / MAX_ENTRIES) : 0;

  const directories =
    1 +                       // root
    4 +                       // title/author/format/recent 四个导航
    (books > 0 ? LETTER_BUCKETS : 0) * 2 +  // title + author 的字母桶
    (books > 0 ? Math.min(FORMAT_BUCKETS, 6) : 0) + // format 桶
    titlePages + authorPages + formatPages + recentPages;

  return { directories, titlePages, authorPages, formatPages, recentPages };
}

function main() {
  const a = parseArgs(process.argv);
  const { directories } = treeShape(a.books);

  // ── 每次操作的请求成本 ────────────────────────────────────────────────
  // 浏览会话：进 4 个目录 + 下 3 本书。
  //
  // 下载那 3 次**不花 Worker 请求**：浏览页的书卡 href 现在是 R2 直链
  // （`${r2PublicBase}/${encodeR2Key(book.r2_key)}`），点击直接落到 R2，
  // 完全不进 Worker。以前是 `/dav/<书>` → Worker 回 302 + `no-store`，
  // 于是**每点一次下载白花一次请求**。
  //
  // 但别把这个数字误读成「下载免费」：
  //   · 这里省掉的只是**浏览页**那一条路；
  //   · WebDAV 客户端的 `GET /dav/<书>` 仍然花 1 次 Worker 请求（302 未变），
  //     那部分算在 mountRequests / syncRequests 里；
  //   · R2 的 Class B 计数照旧 —— 它在 downloadsPerDay 那一行单独记。
  //
  // 所以这一栏从 `4 + 3` 变成 `4`。这不是乐观假设，是「请求不再经过
  // Worker」的直接推论 —— 与 pageViewRequests 那条不同，那条是纠错
  // （曾经以为缓存能省、其实省不了），这条是真的少了一次调用。
  const browseRequests = 4;
  // 挂载：客户端列目录树。rclone 有 dir-cache 时只走一遍；Finder 会反复重发
  const mountRequests = 2 * directories;
  // 全库同步：每个目录 1 次 PROPFIND + 每本书 1 次 GET
  //
  // 注意这里的 `a.books` **不能**因为「下载已改直链」而删掉：
  // rclone / Finder 走的是 WebDAV，`GET /dav/<书>` 依然花 1 次 Worker
  // 请求（302 是 WebDAV 客户端依赖的行为，不能改）。浏览页那条路省下的
  // 请求只体现在 browseRequests 上。
  // 真正能让这一项归零的是让 rclone 走 R2 的 S3 端点（见结论处的提示）。
  const syncRequests = directories + a.books;
  // 网页目录页：**1 次请求，一次都不少**。
  //
  // 这里原本写的是 `1 - a.cdPageViewHitRate`（假设 80% 被 CDN 缓存）。
  // 那个假设是错的，而且正是「模型说只用 16%，实际却打满 10 万」的一部分原因：
  //
  //   · Cache API（caches.default，本站一直在用的那个）
  //     官方原文：「every request still executes your Worker on the way in」
  //     —— 它只省**上游**（D1/R2），一次请求都不省。
  //   · Workers Caching（cache.enabled，本站**没开**，且决定不开）
  //     命中时确实不跑 Worker，但官方定价页脚注写明
  //     「Cache hits count as requests but do not consume CPU time」
  //     —— **请求数照收**。所以它同样不进这个模型。
  //   · 只有**静态资源**请求是 free and unlimited、且完全不跑 Worker。
  //     而目录页是 Worker 渲染的，不属于这一类。
  //
  // 所以这一栏只能是 1。把 `cdPageViewHitRate` 参数一并删掉是有意的：
  // 保留它就会有人继续传一个「假装能省请求」的数字，而现在是**报未知参数退出**。
  const pageViewRequests = 1;

  // ── 每次网页浏览**附带**的隐式请求 ──────────────────────────────────────
  //
  // 这一项是为一个真实事故加的：模型一直报「只用 16%」，而站点**真的**
  // 在一天里打满了 10 万次并停摆到次日。差距的一部分就来自这里 ——
  // 浏览一个页面从来不只是「1 次请求」。
  //
  // 现在这一项是 0，因为已经用静态资源把唯一那条普遍存在的隐式请求
  // 消掉了：浏览器在页面没声明 <link rel="icon"> 时会去请求 /favicon.ico，
  // 而那个路径以前不存在 —— **每次页面浏览都白花一次请求**换回 404。
  // 现在它是 public/favicon.ico，由静态资源层应答（free and unlimited）。
  //
  // 保留这个参数而不是删掉，是为了让「加一个页面级资源」时有个明确的
  // 记账位置：**凡是浏览器会自动请求、又必须经过 Worker 的东西，都算在这里**。
  // 数字一旦不为 0，上面那句「只用 16%」就自动跟着变诚实。
  const implicitPerPageView = a.implicitPerPageView;

  // ── 未建模流量 ─────────────────────────────────────────────────────────
  //
  // 「可预期的使用量」和「实际打进来的请求」是两件事。差额来自：
  //   · 搜索引擎 / 归档站 / AI 抓取器的爬取（robots.txt 只能约束守规矩的）
  //   · 漏洞扫描器探测 /wp-login.php、/.env、/administrator 之类
  //   · 用户反复刷新、断点续传、客户端重试
  //
  // 2026-10 起，**不存在的路径已不再计入**：`not_found_handling: "404-page"`
  // 让它们由 public/404.html 应答，不调用 Worker（扫描器那类流量因此归零）。
  // 官方定价页：「Requests to static assets are free and unlimited.」
  // 剩下仍要计费的是**打到了真路由**的爬取与重试 —— 那些无法靠配置消除。
  //
  // 因为没有 API token（本机无 CF 凭据），拿不到线上的真实计数，所以**不猜**：
  // 默认 0，并在结论里明确标注「不含未建模流量」。
  // 想估算真实占用时，用 Cloudflare 控制台的请求量反推这一个数字即可。
  const unmodeled = a.bots;

  const requestsPerDay =
    a.browse * browseRequests +
    a.mounts * mountRequests +
    a.syncs * syncRequests +
    a.pageViews * (pageViewRequests + implicitPerPageView) +
    a.uploadsPerDay + // 上传各 1 次
    a.bots; // 未建模流量：爬虫 / 扫描器 / 探测（见下方说明）

  // ── D1 行读取 ─────────────────────────────────────────────────────────
  // 缓存未命中的 PROPFIND 会读：1 行（桶计数）+ 最多 200 行（书）
  //
  // 三路流量分开算，因为实测命中率差了一整档（50% vs 0% vs 不适用）：
  //   · 网页浏览（browse）→ 走 GET，**根本不查条目缓存**，不乘任何命中率
  //   · WebDAV 挂载（mounts）→ 同一目录在一次会话里被重列（mountRequests
  //     是 2×directories），第二次落在 300s TTL 内 → 用 cacheHitRate（=50%）
  //   · 全库同步（syncs）→ 每个目录一次、两次同步相隔数小时，键早就过期
  //     → 用 cacheHitRateTraversal（实测 0）
  // 取平均会把这三件事混成一笔糊涂账，所以宁可多一个参数。
  //
  // ⚠️ 第三处失真（2026-10-16 实测后修正）：**浏览页那 4 次不查条目缓存**，
  //    它们不该乘任何命中率。浏览页走 `GET /dav/<目录>/` →
  //    src/webdav/index.ts 的 handleGet 直接 `collectDavEntries()` 现算，
  //    全仓库只有 src/webdav/propfind.ts:518 会 `cache.match(entriesCacheKey(...))`。
  //    实测对照（同一路径连打 3 次）：
  //      GET      → 三次都**没有** `x-dav-cache` 响应头（缓存路径压根没走）
  //      PROPFIND → MISS, HIT, HIT
  //    所以浏览那 4 次是**每次都读 D1** 的，命中率救不了它。改之前
  //    `propfindCount = a.browse * 4 + …` 再整体乘 (1 - 0.9)，等于把
  //    90% 的浏览页 D1 读取凭空抹掉了 —— 这与「模型说 16%、现实打满」
  //    是同一类错误：让唯一真正走缓存的路径替别的路径背了折扣。
  const browseReads = a.browse * 4; // 浏览页 GET：不走条目缓存，100% 读 D1
  //
  // 挂载那一路用 (1 - cacheHitRate)：实测场景 D 的形状就是「每个目录先列
  // 一次（MISS，读 D1）、同一会话里再列一次（HIT）」= 50%，而
  // `2 * directories` 正好是那个形状，所以直接相乘即可，不用手工扣常数。
  const mountMisses = a.mounts * 2 * directories * (1 - a.cacheHitRate);
  // 同步那一路每个键只碰一次，乘不乘都一样 —— 写出来是为了让它显式可见。
  const syncMisses = a.syncs * directories * (1 - a.cacheHitRateTraversal);
  const cacheMisses = browseReads + mountMisses + syncMisses + a.uploadsPerDay;
  const d1RowsReadPerDay = cacheMisses * (1 + MAX_ENTRIES);

  // ── D1 行写入 ─────────────────────────────────────────────────────────
  //
  // 2026-10-16 实测（本地 workerd；miniflare 真实实现 meta.rows_written，
  // 见 node_modules/miniflare/dist/src/workers/d1/database.worker.js:168
  // `rows_written: cursor.rowsWritten`；在 /tmp 副本给 src/lib/db.ts 插桩
  // 打印真实值，受跟踪仓库未动）。规律经合成表验证：
  //   rows_written = 1 表行 + 被改写的二级索引条数
  //   （CREATE TABLE synth + N 个索引 → INSERT 写 N+1 行，UPDATE 非索引列恒 1 行）
  //
  // 一次上传 = books 表 upsert + buckets 表 5 个桶 upsert + 1 条 DELETE：
  //   · books   INSERT 新书    17 行 = 1 表行 + **16 个索引项**
  //             （15 个显式索引 + sqlite_autoindex_books_1；实测原始输出
  //               `>>> D1WRITE upsertBook rows_written=17`）
  //   · books   UPDATE 覆盖上传 16 行 = 1 + 15（id 不变，PK 自动索引不重写）
  //   · buckets 每桶已存在 1 行 / 每桶首次新建 2 行（1 表行 + PK 索引）
  //   · buckets 末尾那条清零 DELETE = **0 行**（上传路径 delta 全是 +1，
  //     永远没有 total <= 0 的桶可删）
  //
  // 实测三次的上传合计（原始输出见 task-8 报告）：
  //   首本（5 个桶全新建） 17 + [2,2,2,2,2,0] = 17 + 10 = **27 行**
  //   稳态（桶都已存在）   17 + [1,1,1,1,1,0] = 17 +  5 = **22 行**
  //   覆盖上传（同 id）    16 + [1,1,1,1,1,0] = 16 +  5 = **21 行**
  //
  // 默认取稳态 22 行。原建模 `* 3` 错约 7 倍，漏掉的几乎全是索引放大 ——
  // 直觉上「写一行书 = 一行」，而 D1 的计费口径把每个被改写的索引条目
  // 都算一行。
  const D1_ROWS_PER_UPLOAD = 22;
  const d1RowsWrittenPerDay = a.uploadsPerDay * D1_ROWS_PER_UPLOAD;

  // ── R2 操作（按月） ───────────────────────────────────────────────────
  //
  // 这里才是「下载」真正的记账位置，而且**两种下载都算**：
  //   · 浏览页的 3 次点击 —— 现在是直链，不再是 Worker 请求，但仍然是
  //     一次 R2 Class B（GetObject），所以它从 requestsPerDay 搬到了这一行；
  //   · rclone 全库同步的 `a.books` 次 —— 走 WebDAV，既是 Worker 请求
  //     （记在 syncRequests）也是 R2 Class B。
  // 换句话说：直链省的是**请求配额**，不是 R2 的读操作计数。两本账，别混。
  const downloadsPerDay = a.browse * 3 + a.syncs * a.books;
  const r2ClassAPerMonth = a.uploadsPerDay * 30 * 2; // PutObject + CreateMultipartUpload
  const r2ClassBPerMonth = downloadsPerDay * 30;

  const storageGb = (a.books * a.avgBookMb) / 1024;

  // ── 判定 ──────────────────────────────────────────────────────────────
  // 两类额度行为完全不同，必须分开看：
  //   硬停类（超额 = 服务停摆到次日 UTC 0 点）：Worker 请求、D1 行读写
  //   计费类（超额 = 照常服务，产生小额账单）：R2 存储 / Class A / Class B
  const hardLimits = [
    ['Worker 请求/天', requestsPerDay, FREE.workerRequestsPerDay, '次'],
    ['D1 行读取/天', d1RowsReadPerDay, FREE.d1RowsReadPerDay, '行'],
    ['D1 行写入/天', d1RowsWrittenPerDay, FREE.d1RowsWrittenPerDay, '行'],
  ];
  const billedLimits = [
    ['R2 Class A/月', r2ClassAPerMonth, FREE.r2ClassAPerMonth, '次'],
    ['R2 Class B/月', r2ClassBPerMonth, FREE.r2ClassBPerMonth, '次'],
    ['R2 存储/月', storageGb, FREE.r2StorageGbMonth, 'GB'],
  ];

  const fmt = (n) => (n >= 1000 ? Math.round(n).toLocaleString('en-US') : n.toFixed(2));
  const pct = (n, limit) => `${((n / limit) * 100).toFixed(1)}%`;

  console.log('webooks 请求预算模拟');
  console.log('='.repeat(74));
  console.log(`书库规模        ${a.books.toLocaleString('en-US')} 本 · ${a.avgBookMb} MB/本 · ${storageGb.toFixed(2)} GB`);
  console.log(`目录总数        ${directories} 个（设计上限 200，${directories <= 200 ? '✅ 合规' : '❌ 超标'}）`);
  console.log(`每日用量        ${a.browse} 次浏览 · ${a.mounts} 次挂载 · ${a.syncs} 次全库同步 · ${a.pageViews} 次网页浏览 · ${a.uploadsPerDay} 次上传`);
  console.log(
    `PROPFIND 缓存命中率 挂载会话 ${(a.cacheHitRate * 100).toFixed(0)}%`
    + ` / 跨目录遍历 ${(a.cacheHitRateTraversal * 100).toFixed(0)}%`
    + `（只对 PROPFIND 生效；浏览页走 GET、压根不查条目缓存，`
    + `且 Cache API 命中时 Worker 照跑，请求数不减免）`,
  );
  console.log('='.repeat(74));

  const printTable = (title, rows) => {
    console.log('');
    console.log(title);
    console.log('-'.repeat(74));
    console.log('指标'.padEnd(18) + '用量'.padStart(15) + '免费额度'.padStart(16) + '占用'.padStart(10));
    for (const [label, used, limit, unit] of rows) {
      console.log(
        label.padEnd(18) +
          `${fmt(used)} ${unit}`.padStart(15) +
          `${fmt(limit)} ${unit}`.padStart(16) +
          pct(used, limit).padStart(10) +
          (used > limit ? '  ⚠️ 超额' : ''),
      );
    }
  };

  printTable('① 硬停类额度 —— 超额后站点停摆，直到次日 UTC 0 点（北京 08:00）', hardLimits);
  printTable('② 计费类额度 —— 超额后照常服务，只是产生账单', billedLimits);

  const binding = hardLimits.reduce(
    (worst, row) => (row[1] / row[2] > worst[1] / worst[2] ? row : worst),
    hardLimits[0],
  );
  const [bLabel, bUsed, bLimit] = binding;
  const bindingPct = (bUsed / bLimit) * 100;
  const peakPct = bindingPct * a.peakFactor;

  console.log('');
  console.log('结论');
  console.log('-'.repeat(74));
  // ⚠️ 这一行是给「模型说 16%、现实却打满」打的补丁：宁可让人一眼看见
  //    「这个数字没算爬虫」，也不要再让百分比给人一种虚假的安全感。
  if (unmodeled === 0) {
    console.log('⚠️  以上**不含未建模流量**（爬虫 / 扫描器 / 客户端重试）。');
    console.log('    真实占用通常高于此表 —— 本站曾在此表显示 16% 时打满 10 万次。');
    console.log('    用 `--bots <次数>` 估算；数字请从 Cloudflare 控制台取。');
  } else {
    console.log(`（已计入未建模流量 ${unmodeled.toLocaleString('en-US')} 次/天）`);
  }
  console.log(`硬停瓶颈        ${bLabel}（${bindingPct.toFixed(1)}% 已用）`);
  console.log(`忙日承受力      忙日系数 ${a.peakFactor}× → ${peakPct.toFixed(1)}%（${peakPct < 100 ? '✅ 忙日也在额度内' : '❌ 忙日会打满'}）`);

  // ── 结论：判据必须是「**忙日**是否越线」，不能只看均值 ──────────────────
  //
  // 这里原来只看 bindingPct（均值占用），于是出现过自相矛盾的两行输出：
  //     `峰值承受力 3× → 229.7%（❌ 峰值会打满）`
  //     `✅ 站点不会因额度停摆。`
  // 同一个预测，上一行说会打满、下一行说不会 —— 谁读到都会不知道该信哪句。
  //
  // 语义澄清（重要）：100,000/天 是**日总量**，不是速率上限。
  // 官方 limits 页：「There is no general limit on requests per second.」
  // 所以这里乘的是**忙日系数**（某天流量是平时的几倍，比如被爬虫翻了一遍），
  // 而不是「峰值 QPS」—— 后者的乘法和日额度不可比，是量纲错误。
  // 忙日系数是**同量纲**的：忙日的总量照样从这 10 万里扣。
  if (peakPct >= 100) {
    console.log('');
    console.log(`❌ 忙日会超出硬停额度（${peakPct.toFixed(1)}%），那天会停摆。`);
    console.log('   注意：均值看着安全不代表安全 —— 这正是本站上次停摆的形态。');
    console.log('   对策（按性价比排序）：');
    console.log('     1) 先量出真实流量：用 Cloudflare 控制台的请求数反推 --bots');
    console.log('     2) 让 rclone/脚本用户改用 R2 的 S3 端点 —— 直接降到 0 次 Worker 请求');
    console.log('     3) 提高 PROPFIND 缓存命中率、减少目录总数 —— 只省 D1，不省请求');
    console.log('     4) 上 Workers Paid（$5/月），或把 WebDAV 端点迁到 Oracle Always Free');
  } else if (bindingPct < 100) {
    const headroom = 100 / bindingPct;
    const peakHeadroom = 100 / peakPct;
    console.log('');
    console.log(`✅ 站点不会因额度停摆。最紧的硬停指标还有 ${headroom.toFixed(1)} 倍余量，`);
    console.log(`   按 ${a.peakFactor}× 忙日估算也还有 ${peakHeadroom.toFixed(1)} 倍。`);
    console.log(`   折算约 ${Math.round(a.browse * peakHeadroom).toLocaleString('en-US')} 次浏览/天，`);
    console.log(`   或 ${Math.round(a.mounts * peakHeadroom).toLocaleString('en-US')} 次 WebDAV 挂载/天。`);
  } else {
    console.log('');
    console.log('❌ 会超出硬停额度，站点每天都会停摆。');
    console.log('   表现：每天 UTC 0 点（北京时间 08:00）重置，用光后停到次日 08:00。');
    console.log('   对策（按性价比排序）：');
    console.log('     1) 让 rclone/脚本用户改用 R2 的 S3 端点 —— 直接降到 0 次 Worker 请求');
    console.log('     2) 提高 PROPFIND 缓存命中率、减少目录总数 —— 只省 D1，不省请求');
    console.log('     3) 上 Workers Paid（$5/月），或把 WebDAV 端点迁到 Oracle Always Free');
  }

  // ── 计费类额度的实际账单（免费计划下 R2 超额也是要付钱的） ──────────────
  const storageOver = Math.max(0, storageGb - FREE.r2StorageGbMonth);
  const aOver = Math.max(0, r2ClassAPerMonth - FREE.r2ClassAPerMonth);
  const bOver = Math.max(0, r2ClassBPerMonth - FREE.r2ClassBPerMonth);
  const r2Overage =
    storageOver * PAID.r2StoragePerGbMonth +
    (aOver / 1e6) * PAID.r2ClassAPerMillion +
    (bOver / 1e6) * PAID.r2ClassBPerMillion;

  console.log('');
  if (r2Overage > 0) {
    console.log(`💳 R2 超额账单 ≈ $${r2Overage.toFixed(2)}/月（R2 不是硬停，超额照常计费）`);
    if (storageOver > 0) console.log(`   存储超 ${storageOver.toFixed(2)} GB × $0.015 = $${(storageOver * 0.015).toFixed(2)}`);
    if (aOver > 0) console.log(`   Class A 超 ${Math.round(aOver).toLocaleString('en-US')} 次 × $4.50/M = $${((aOver / 1e6) * 4.5).toFixed(2)}`);
    if (bOver > 0) console.log(`   Class B 超 ${Math.round(bOver).toLocaleString('en-US')} 次 × $0.36/M = $${((bOver / 1e6) * 0.36).toFixed(2)}`);
  } else {
    console.log('💳 R2 超额账单 $0.00/月（全部落在免费额度内）');
  }

  // ── 如果改成付费 ──────────────────────────────────────────────────────
  const monthRequests = requestsPerDay * 30;
  const billableRequests = Math.max(0, monthRequests - PAID.workersRequestsIncluded);
  const d1ReadBillable = Math.max(0, d1RowsReadPerDay * 30 - PAID.d1RowsReadIncluded);
  const d1WriteBillable = Math.max(0, d1RowsWrittenPerDay * 30 - PAID.d1RowsWrittenIncluded);

  const egressTb = (downloadsPerDay * 30 * a.avgBookMb) / 1024 / 1024;
  const paidCost =
    PAID.workersBase +
    (billableRequests / 1e6) * PAID.workersRequestPerMillion +
    (d1ReadBillable / 1e6) * PAID.d1RowsReadPerMillion +
    (d1WriteBillable / 1e6) * PAID.d1RowsWrittenPerMillion +
    r2Overage; // R2 部分无论免费还是付费都是同一个账单

  console.log('');
  console.log('如果改用 Workers Paid（$5/月）');
  console.log('-'.repeat(74));
  console.log(`月度请求        ${Math.round(monthRequests).toLocaleString('en-US')} 次`);
  console.log(`月度出网        ${egressTb.toFixed(2)} TB —— R2 出网永远 $0.00`);
  console.log(`月度成本        ≈ $${paidCost.toFixed(2)}（含上面那份 R2 账单）`);
  console.log('');
  console.log('提示：超额时最划算的一步往往不是加钱，而是把 rclone / 脚本用户');
  console.log('      从 WebDAV 引导到 R2 的 S3 端点 —— 那部分请求直接归零。');
}

main();
