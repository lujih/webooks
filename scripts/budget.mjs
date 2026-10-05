#!/usr/bin/env node
/**
 * 请求预算模拟器。
 *
 * 回答一个问题：这套设计在 Workers Free 的额度内能撑多少用量？
 *
 * 它按真实实现建模，而不是拍脑袋：
 *   - PROPFIND 只读 D1（不调用 R2 list()），所以列表操作不消耗 R2 Class A；
 *     代价是缓存未命中时约 200 行 D1 读取。
 *   - GET 返回 302 跳到 R2 公开域：1 次 Worker 请求 + 1 次 R2 Class B，字节不过 Worker。
 *   - 目录页 HTML 可被 CDN 缓存，重复浏览不消耗 Worker 请求。
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
    cacheHitRate: 0.9,  // PROPFIND 条目缓存命中率
    uploadsPerDay: 20,
    cdPageViewHitRate: 0.8, // 目录页被 CDN 缓存的命中率
    peakFactor: 3,      // 峰值/均值比
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
  // 浏览会话：进 4 个目录 + 下 3 本书
  const browseRequests = 4 + 3;
  // 挂载：客户端列目录树。rclone 有 dir-cache 时只走一遍；Finder 会反复重发
  const mountRequests = 2 * directories;
  // 全库同步：每个目录 1 次 PROPFIND + 每本书 1 次 GET
  const syncRequests = directories + a.books;
  // 网页目录页：1 次请求，但可被 CDN 缓存
  const pageViewRequests = 1 - a.cdPageViewHitRate;

  const requestsPerDay =
    a.browse * browseRequests +
    a.mounts * mountRequests +
    a.syncs * syncRequests +
    a.pageViews * pageViewRequests +
    a.uploadsPerDay; // 上传各 1 次

  // ── D1 行读取 ─────────────────────────────────────────────────────────
  // 缓存未命中的 PROPFIND 会读：1 行（桶计数）+ 最多 200 行（书）
  const propfindCount =
    a.browse * 4 + a.mounts * 2 * directories + a.syncs * directories + a.uploadsPerDay;
  const cacheMisses = propfindCount * (1 - a.cacheHitRate);
  const d1RowsReadPerDay = cacheMisses * (1 + MAX_ENTRIES);

  const d1RowsWrittenPerDay = a.uploadsPerDay * 3; // upsert + 分桶重建

  // ── R2 操作（按月） ───────────────────────────────────────────────────
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
  console.log(`PROPFIND 缓存命中率 ${(a.cacheHitRate * 100).toFixed(0)}%`);
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
  console.log(`硬停瓶颈        ${bLabel}（${bindingPct.toFixed(1)}% 已用）`);
  console.log(`峰值承受力      峰值系数 ${a.peakFactor}× → ${peakPct.toFixed(1)}%（${peakPct < 100 ? '✅ 峰值也在额度内' : '❌ 峰值会打满'}）`);
  console.log('');

  if (bindingPct < 100) {
    const headroom = 100 / bindingPct;
    const peakHeadroom = 100 / peakPct;
    console.log(`✅ 站点不会因额度停摆。最紧的硬停指标还有 ${headroom.toFixed(1)} 倍余量，`);
    console.log(`   即使按 ${a.peakFactor}× 峰值估算也还有 ${peakHeadroom.toFixed(1)} 倍。`);
    console.log(`   折算约 ${Math.round(a.browse * peakHeadroom).toLocaleString('en-US')} 次浏览/天，`);
    console.log(`   或 ${Math.round(a.mounts * peakHeadroom).toLocaleString('en-US')} 次 WebDAV 挂载/天。`);
  } else {
    console.log('❌ 会超出硬停额度，站点每天会停摆。');
    console.log('   表现：每天 UTC 0 点（北京时间 08:00）重置，用光后停到次日 08:00。');
    console.log('   对策（按性价比排序）：');
    console.log('     1) 提高 PROPFIND 缓存命中率、减少目录总数 —— 最有效且免费');
    console.log('     2) 让 rclone/脚本用户改用 R2 的 S3 端点 —— 直接降到 0 次 Worker 请求');
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
