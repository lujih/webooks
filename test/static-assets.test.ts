/**
 * 静态资源层（public/）的守卫测试。
 *
 * ── 为什么需要这个文件 ───────────────────────────────────────────────────
 * 这一层跑在 **Worker 之外**，所以 `SELF.fetch()` **完全看不到它** ——
 * vitest-pool-workers 里的请求直接进 Worker 代码，不经过 Cloudflare 的
 * 静态资源路由。也就是说：本套测试里其它 400+ 个用例全绿，
 * 也**证明不了** public/ 配对了。
 *
 * 而这一层的配置一旦错，后果是「线上整站 404，而测试全绿」——
 * 这不是假设：实测 `not_found_handling: "404-page"` **而漏配
 * `run_worker_first`** 时，只要请求带 `Sec-Fetch-Mode: navigate`
 * （真实浏览器每次顶层导航都带，curl 不带），`/`、`/upload`、
 * `/requests`、`/admin`、`/dav/` **全部**被静态 404 页吃掉。
 * curl 冒烟测试因此全是假绿。
 *
 * 反过来，`"none"` 没有这个陷阱，但**每一个不存在的路径都要花一次
 * Worker 请求**去回文本 404 —— 扫描器打过来的路径数量不受本站控制，
 * 这是上次一天打满 10 万次额度的形态。所以现在的配置是
 * `"404-page"` + 一份必须覆盖全部 Worker 路由的 `run_worker_first` 列表，
 * 本文件的两组断言就是这两个条件各自的守卫。
 *
 * 既然测不了运行时行为，就退一步**把配置与产物本身钉死**：
 * 这些断言读的是真实的文件内容，任何一条被改动都会立刻红，
 * 逼改动者重新读一遍那段论证。
 */

import { describe, expect, it } from 'vitest';
import { testEnv } from './setup';

/**
 * public/ 的产物与 wrangler.jsonc 都由 vitest.config.ts 在 **Node 侧** 读好，
 * 作为 binding 传进来（TEST_STATIC_ASSETS）。
 *
 * 为什么不在这里直接 import node:fs：**workerd 的 node:fs 是个空壳** ——
 * `typeof readFileSync === 'function'` 成立，但任何路径都抛 ENOENT
 * （连 process.cwd() 自己都 readdir 不了）。这条弯路踩过，别再踩。
 *
 * 顺带一个坑：本项目没装 @types/node，所以**不能用 Buffer**，
 * 这里一律用 Uint8Array + 手写小端读取。
 */
const SNAPSHOT = testEnv.TEST_STATIC_ASSETS;
const FILES = SNAPSHOT.files;

/** latin1 字符串 → 原始字节（latin1 保证 charCode === byte，往返无损） */
function latin1Bytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** latin1 → 原文（快照为保字节而用 latin1，取文本时再按 UTF-8 解码） */
function utf8(text: string): string {
  return new TextDecoder('utf-8').decode(latin1Bytes(text));
}

/** 取 public/ 下的文件字节 */
function publicFile(name: string): Uint8Array {
  const text = FILES[name];
  if (text === undefined) {
    throw new Error(`public/${name} 不存在（快照键：${Object.keys(FILES).join(', ')}）`);
  }
  return latin1Bytes(text);
}

// 小端读取（noUncheckedIndexedAccess 下必须断言非空）
const u16 = (b: Uint8Array, o: number): number => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number): number =>
  (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

/** 读 wrangler.jsonc 并容掉全行注释（本仓库的注释都是整行 //，无行尾注释） */
function readWranglerConfig(): Record<string, any> {
  const stripped = SNAPSHOT.wranglerJsonc
    .split('\n')
    .filter((line: string) => !line.trim().startsWith('//'))
    .join('\n');
  return JSON.parse(stripped);
}

/**
 * 解析 _headers 文件。
 * 格式：首行是路径/模式，随后缩进行是 `名: 值`；`#` 开头是注释。
 * 返回 Map<路径, 头名小写数组>。
 */
function parseHeadersFile(text: string): Map<string, string[]> {
  const rules = new Map<string, string[]>();
  let current: string | null = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (/^\s/.test(line)) {
      // 缩进行 = 头。只取冒号前的名字，值里可能有冒号（如 CSP）
      const name = line.trim().split(':')[0]?.trim().toLowerCase();
      if (current && name) rules.get(current)!.push(name);
    } else {
      current = line.trim();
      rules.set(current, []);
    }
  }
  return rules;
}

const headersFile = FILES['_headers'] ?? '';
const headerRules = parseHeadersFile(headersFile);

describe('静态资源配置：404-page + run_worker_first 必须成对出现', () => {
  const cfg = readWranglerConfig();

  it('assets 块存在且指向 ./public', () => {
    // 这条断言同时是「assets 块没被人删掉」的守卫 ——
    // 删掉它不会让任何功能测试变红，只会让 favicon/robots/404 静默变回
    // 「每次访问花一次 Worker 请求」，属于最难察觉的那类回退。
    expect(cfg.assets, 'assets 块丢失，静态资源优化被移除').toBeTruthy();
    expect(cfg.assets.directory).toBe('./public');
  });

  it('not_found_handling 是 404-page —— 未知路径必须免费，而不是花一次请求', () => {
    // ⚠️ 这条断言的方向**被推翻过一次**，别再翻回去：
    //
    //   最初配的是 "none"，理由是「404-page 会让整站对真人 404」。
    //   那个观察是对的（下面那条断言仍然在防它），但结论错了：
    //   配上 run_worker_first 之后，"404-page" 是安全的，而且它是
    //   **唯一能免费应答未知路径**的配置。
    //
    //   为什么这件事重要：扫描器/爬虫打过来的不存在的路径
    //   （/wp-login.php、/.env、/administrator…）数量不受本站控制，
    //   而 "none" 下每一条都要花 1 次 Worker 请求去回一个文本 404。
    //   请求量毫无预兆翻几倍正是上次打满 10 万的形态。
    expect(cfg.assets.not_found_handling).toBe('404-page');
  });

  it('404.html 存在（404-page 靠它应答，缺了就退回 Worker）', () => {
    // 缺少 404.html 时 404-page 无页可服，实测会回落给 Worker ——
    // 于是整条优化静默失效，而功能测试全绿。
    expect(FILES['404.html'], 'public/404.html 丢失，未知路径又变成计费请求').toBeDefined();
    expect(utf8(FILES['404.html']!)).toContain('没有这一页');
  });

  it('run_worker_first 是数组，不是 true（true 等于每个请求都先跑 Worker）', () => {
    const rwf = cfg.assets.run_worker_first;
    expect(Array.isArray(rwf), 'run_worker_first 必须是数组；true 会让静态资源优化归零').toBe(true);
    expect(rwf.length, '空数组等于所有路径都吃静态 404，整站会瘫').toBeGreaterThan(0);
  });

  it('DAV_MOUNT 没有被 wrangler.jsonc 覆盖（列表里的 /dav 与 robots.txt 都写死了它）', () => {
    // run_worker_first 里写死 `/dav`，robots.txt 里写死 `Disallow: /dav/`。
    // 若有人在 vars 里把 DAV_MOUNT 改成别的（比如 /library），
    // 两处会同时失效：整棵书柜树被静态 404 吃掉，而爬虫重新开始枚举它。
    // 这条断言把这层「隐式耦合」变成显式的：改了就红，逼你去同步两处。
    expect(cfg.vars?.DAV_MOUNT, 'DAV_MOUNT 被覆盖了，请同步 run_worker_first 与 public/robots.txt').toBeUndefined();
  });
});

/**
 * run_worker_first 的模式匹配。语义全部是**实测**得来的（wrangler dev 逐条 curl）：
 *   · `/x/*` 匹配 `/x/` 与 `/x/任意`，但**不匹配 `/x` 本身**
 *   · 字面量精确匹配，**大小写敏感**（`/HEALTH`、`/health/` 会漏）
 *   · 它**优先于**命中的静态资源
 */
function routeMatches(pattern: string, path: string): boolean {
  if (pattern.endsWith('*')) return path.startsWith(pattern.slice(0, -1));
  return path === pattern;
}

/**
 * 从 src/index.ts 里抠出所有属于 Worker 的路径字面量。
 *
 * 做法是找路由判定处的那几种写法（`path === '...'`、`path.startsWith('...')`），
 * 而不是解析 AST —— 够用且不会因为重构而变脆。**找不到就断言失败**，
 * 所以如果有人把 `path === '/health'` 改成别的形状，这里会先红，
 * 而不是静默地漏掉一条路由。
 */
function workerRouteLiterals(src: string): string[] {
  const out = new Set<string>();
  // `path === ''` 是源码里与 `/` 合并写在同一分支的别名（URL 的 pathname
  // 永远至少是 `/`，所以它实际不可达）。归一到 `/`，否则它会以空串的形式
  // 混进结果，让「有没有漏项」的判据失效。
  for (const m of src.matchAll(/\bpath\s*===\s*'([^']*)'/g)) out.add(m[1] === '' ? '/' : m[1]!);
  for (const m of src.matchAll(/\bpath\.startsWith\('([^']*)'\)/g)) out.add(`${m[1]}*`);
  return [...out];
}

describe('run_worker_first 必须覆盖每一个 Worker 路由（漏一条 = 该路由对真人 404）', () => {
  const cfg = readWranglerConfig();
  const patterns: string[] = cfg.assets.run_worker_first;
  const src = SNAPSHOT.indexSource;

  it('源码读到了（否则下面的断言会假绿）', () => {
    expect(src.length).toBeGreaterThan(1000);
  });

  it('路由字面量确实抠出来了（抠不到就说明正则失效，必须先修这个）', () => {
    const routes = workerRouteLiterals(src);
    // 这几条是路由表的骨架，任何一条抠不到都说明上面的正则已经跟不上代码
    for (const known of ['/health', '/api/requests', '/requests', '/upload', '/admin', '/api/credits', '/']) {
      expect(routes, `src/index.ts 里没找到路由 ${known} —— 抠取正则失效了`).toContain(known);
    }
  });

  it('src/index.ts 里的每条路由都被某条 run_worker_first 模式覆盖', () => {
    const missing = workerRouteLiterals(src).filter(
      (r) => !patterns.some((p) => {
        // 抠出来的 `startsWith('/api/admin/')` 变成 `/api/admin/*`，
        // 它要匹配的实际是 `/api/admin/anything`，用样例路径来判。
        const sample = r.endsWith('*') ? `${r.slice(0, -1)}sample` : r;
        return routeMatches(p, sample) || r === p;
      }),
    );
    expect(
      missing,
      `这些路由没进 run_worker_first，加了静态层后会对真人静默 404：${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('每个带斜杠的页面路由都单列了一条（`/x/*` 不匹配 `/x/` 之外的东西，实测）', () => {
    // `/requests/` 既不对应静态资源、也不会被自动重定向，必须显式列出。
    for (const p of ['/requests/', '/upload/', '/admin/']) {
      expect(patterns, `${p} 没被列出，访问它会吃静态 404`).toContain(p);
    }
    // `/dav` 与 `/dav/*` 缺一不可：前者是书柜根（PROPFIND 挂载点），
    // 后者是它下面的一切。实测 `/dav/*` 不匹配 `/dav` 本身。
    expect(patterns).toContain('/dav');
    expect(patterns).toContain('/dav/*');
  });

  it('没有把静态资源路径也塞进 run_worker_first（那等于自己废掉优化）', () => {
    // run_worker_first 优先于静态资源：一旦把 /favicon.ico 列进去，
    // 它又变成「每次页面浏览花一次 Worker 请求」，而且测试全绿。
    for (const f of Object.keys(FILES)) {
      if (f === '_headers') continue;
      const p = `/${f}`;
      expect(patterns.some((pat) => routeMatches(pat, p)), `${p} 被 run_worker_first 抢走了`).toBe(false);
    }
  });
});

describe('public/ 产物完整性', () => {
  it('favicon.ico 是合法的 ICO（含 PNG 载荷）', () => {
    const buf = publicFile('favicon.ico');
    // ICONDIR 占 6 字节：reserved(2) type(2) count(2)
    expect(u16(buf, 0)).toBe(0);
    expect(u16(buf, 2)).toBe(1);
    expect(u16(buf, 4)).toBeGreaterThanOrEqual(1);

    // ⚠️ 条目字段的偏移要**加上 ICONDIR 的 6 字节**，这是最容易写错的地方：
    //   ICONDIRENTRY 从绝对偏移 6 开始，其中
    //     +8  = dwBytesInRes → 绝对 14
    //     +12 = dwImageOffset → 绝对 18
    //   第一版测试写成 readUInt32LE(8)/(12)，读出来是「颜色数+保留位」和
    //   「平面数+位深」拼成的垃圾值，于是报「10551328 > 182」。
    //   是**测试写错了**，不是图标错了 —— file(1) 当时已确认图标合法。
    const size = u32(buf, 14);
    const offset = u32(buf, 18);
    expect(offset + size, '条目声明的载荷越界').toBeLessThanOrEqual(buf.length);
    expect(size).toBeGreaterThan(0);

    // 本项目用 PNG 内嵌（Vista+ 支持），比 BMP 版本小得多
    const magic = buf.subarray(offset, offset + 8);
    expect([...magic]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it('favicon.ico 足够小（它换来的是「省一次请求」，不该自己变成负担）', () => {
    expect(publicFile('favicon.ico').length).toBeLessThan(8 * 1024);
  });

  it('robots.txt 挡住 WebDAV 目录树', () => {
    const lines = utf8(FILES['robots.txt']!).split('\n').map((l: string) => l.trim());
    // /dav/ 是唯一「可以被无限枚举」的路径：每一层目录一次请求，
    // 每本书一次下载。放爬虫进来等于把 100,000 次/天直接烧掉。
    expect(lines).toContain('Disallow: /dav/');
    expect(lines).toContain('Disallow: /api/');
    expect(lines).toContain('Disallow: /admin');
  });

  it('robots.txt 没有误伤整站', () => {
    const lines = utf8(FILES['robots.txt']!).split('\n').map((l: string) => l.trim());
    // Disallow: / 会让首页与求书墙一起从搜索引擎消失 ——
    // 书库是希望被找到的，这属于「优化过头把功能关掉了」。
    expect(lines).not.toContain('Disallow: /');
    expect(lines).toContain('Allow: /');
  });
});

describe('_headers 规则', () => {
  /**
   * 静态资源不经过 Worker，拿不到 withSecurityHeaders() 的那套头。
   * 漏一条 = 那个文件裸奔（没有 nosniff / 没有 CSP）。
   *
   * 规则是**两层**的，所以判据要看「这条路径会命中哪些规则」，
   * 而不是「有没有一条同名规则」：
   *   · `/*`  —— 所有静态资源的安全头（含未知路径，它们命中这条）
   *   · 具体路径 —— 自己的 Cache-Control
   * 两层都命中是**设计如此**，但它们携带的头**必须不相交** ——
   * 同一个头命中两次会被发两遍，而浏览器对重复 CSP 取交集（越并越严）。
   */
  const catchAll = headerRules.get('/*') ?? [];
  const specific = [...headerRules].filter(([p]) => p !== '/*');
  /** 该路径实际会命中的头（`/*` 的 + 它自己那条规则的） */
  const headersFor = (p: string): string[] => [...catchAll, ...(headerRules.get(p) ?? [])];

  it('/* 规则存在，且带上了 Worker 那份的基础安全头', () => {
    expect(headerRules.has('/*'), '/* 规则丢失，未知路径的静态 404 就没有安全头了').toBe(true);
    for (const h of ['x-content-type-options', 'referrer-policy', 'content-security-policy']) {
      expect(catchAll, `/* 缺 ${h}`).toContain(h);
    }
  });

  it('每个 public/ 下的实体文件都拿到 nosniff 与 CSP', () => {
    const files = Object.keys(FILES).filter((f) => f !== '_headers');
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const names = headersFor(`/${f}`);
      expect(names, `public/${f} 拿不到 x-content-type-options`).toContain('x-content-type-options');
      expect(names, `public/${f} 拿不到 content-security-policy`).toContain('content-security-policy');
    }
  });

  it('每个静态资源都有自己的 Cache-Control（或明确接受默认值）', () => {
    // 404.html 故意不给 Cache-Control：保留平台默认的
    // `public, max-age=0, must-revalidate` + ETag —— 改版立刻生效，
    // 而静态请求本来就免费，不必靠长缓存省什么。
    for (const [path, names] of specific) {
      expect(names, `${path} 缺 cache-control`).toContain('cache-control');
    }
    // 但需要长缓存的那两个必须有 —— 少了它们，浏览器每次浏览都回来问一次
    for (const p of ['/favicon.ico', '/robots.txt']) {
      expect(headerRules.has(p), `${p} 没有独立规则`).toBe(true);
      expect(specific.find(([k]) => k === p)?.[1], `${p} 缺 cache-control`).toContain('cache-control');
    }
  });

  it('/* 与具体规则的头**不相交**（同一个头发两遍时浏览器取交集，极难排查）', () => {
    for (const [path, names] of specific) {
      const dup = names.filter((n) => catchAll.includes(n));
      expect(dup, `${path} 与 /* 重复定义：${dup.join(', ')}`).toEqual([]);
    }
  });

  it('没有重复的规则路径', () => {
    const paths: string[] = [];
    for (const rawLine of headersFile.split('\n')) {
      const line = rawLine.replace(/\s+$/, '');
      if (!line.trim() || line.trim().startsWith('#')) continue;
      if (!/^\s/.test(line)) paths.push(line.trim());
    }
    expect(paths.length).toBe(new Set(paths).size);
  });

  it('CSP 允许内联样式（404 页的样式是内联的），但不允许脚本', () => {
    // 静态资源里没有任何 JS。一旦哪天有人给静态页加了 <script>，
    // 这条 CSP 会让它静默不执行 —— 所以在断言里写明这个前提。
    const csp = headersFile.match(/Content-Security-Policy:\s*(.+)/i)?.[1] ?? '';
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("script-src 'self'");
    expect(csp).not.toContain('script-src *');
  });

  it('_headers 与 robots.txt 自身不会被当成资源下发', () => {
    // 官方文档：_headers 「will not itself be served as a static asset」。
    // 这条断言把该约定记下来 —— 若哪天 Cloudflare 改了行为，
    // 我们会在这里知道，而不是让爬虫规则文件漏给访客。
    expect(FILES['_headers']).toBeDefined();
    expect(headerRules.has('/_headers')).toBe(false);
    expect(headerRules.has('/robots.txt')).toBe(true);
  });
});

/**
 * 预算模型（scripts/budget.mjs）的诚实性守卫。
 *
 * 为什么要给一个「模拟器脚本」写测试：它已经错过两次，而两次都不是
 * 「算错一位小数」，是**结论性的错误** —— 它报「只用 16%」，而站点当天
 * 真的打满了 10 万次并停摆到次日。一个会给人虚假安全感的模型，
 * 比没有模型更危险：它会让人停止追问。
 *
 * 这里读的是**源码文本**（budgetSource），断言的是「那两处论证不许被
 * 改回去」。这看起来像在测字符串，但被钉住的其实是**一个已被证伪的假设** ——
 * 而它极易被重新引入，因为直觉上「缓存命中 = 少一次请求」太自然了。
 */
describe('预算模型不许倒退（每个断言都对应一次真实误判）', () => {
  const src = SNAPSHOT.budgetSource;

  it('源码读到了（否则下面的断言会假绿）', () => {
    expect(src.length, 'budget.mjs 没读到，快照键或路径变了').toBeGreaterThan(1000);
  });

  it('不许把 Cache API 的命中当成省请求（曾被证伪：它一次都不省）', () => {
    // 官方原文（Workers Cache API）：
    //   "every request still executes your Worker on the way in"
    // 曾经的写法：`const pageViewRequests = 1 - a.cdPageViewHitRate;`
    // 它假设 80% 的目录页浏览被 CDN 缓存，于是把请求数打了八折。
    //
    // 注意断言的是「它不再作为**参数或算式**出现」，而不是「这个字符串不存在」——
    // 因为 budget.mjs 里那段解释**必须**能提到这个名字（不然下一个读代码的人
    // 不知道被删掉的是什么、为什么删）。第一版就是写成 not.toContain，
    // 结果被自己的注释绊倒。
    expect(src, 'cdPageViewHitRate 又变成可传参数了').not.toMatch(/cdPageViewHitRate\s*:/);
    expect(src, '算式又用上了缓存命中率 —— 缓存命中不减免请求数').not.toMatch(
      /pageViewRequests\s*=\s*1\s*-\s*a\./,
    );
    // 而必须是硬编码的 1（每次网页浏览至少一次请求，一次都不能少）
    expect(src).toMatch(/const pageViewRequests = 1;/);
  });

  it('不许用「峰值 QPS」当乘数（日额度与速率不同量纲）', () => {
    // 100,000/天 是**日总量**。官方 limits 页：
    //   "There is no general limit on requests per second."
    // 用 QPS 峰值去乘日额度是量纲错误 —— 乘出来的百分比没有意义。
    expect(src, 'peakFactor 的语义又含混了').not.toContain('峰值/均值比');
    expect(src).toContain('忙日系数');
  });

  it('结论必须按**忙日**判，不能只看均值（曾输出自相矛盾的两行）', () => {
    // 真实出现过的输出：
    //   `峰值承受力 3× → 229.7%（❌ 峰值会打满）`
    //   `✅ 站点不会因额度停摆。`          ← 同一个预测，相反结论
    // 判据必须与上面那行百分比用同一套，否则谁读到都不知道该信哪句。
    expect(src, '结论只看均值了 —— 忙日会打满时它仍会说「不会停摆」').toMatch(/if \(peakPct >= 100\)/);
    // 且这个分支必须排在「安全」分支之前（否则先命中安全分支就出不来了）
    const peakIdx = src.indexOf('if (peakPct >= 100)');
    const safeIdx = src.indexOf('} else if (bindingPct < 100) {');
    expect(peakIdx, '忙日分支不见了').toBeGreaterThan(-1);
    expect(safeIdx, '安全分支不见了').toBeGreaterThan(-1);
    expect(peakIdx, '忙日分支必须排在安全分支之前').toBeLessThan(safeIdx);
  });

  it('默认输出必须显式声明「不含未建模流量」', () => {
    // 这是给「模型说 16%、现实打满」打的补丁。没有这句话，
    // 16% 又会变成一个让人安心的假象。
    expect(src).toContain('不含未建模流量');
  });

  it('有 --bots 参数可估算真实流量（不猜，但要能算）', () => {
    expect(src, 'bots 参数消失了，就没法用量控制台的数字反推').toMatch(/bots:\s*0/);
  });
});

/**
 * 线上验证探针（scripts/verify-deploy.mjs）的守卫。
 *
 * 这个脚本是部署流水线的**最后一道门**：它说「线上仍是旧代码」时，
 * 我是真的会去追的 —— 本次就追了，而且追的是一个不存在的东西。
 *
 * 它错过两次，两次都是自己的问题：
 *   ① **假阴性**：CI 的 verify-live job 只传 `--url`，不传 WRITE_TOKEN，
 *      于是它拿一个匿名请求去测「Overwrite: F 撞已有目标」，拿到 401
 *      （RFC 4918 §8.1 要求先拒授权，这是**正确**行为）却报
 *      `❌ 期望 412（新代码），实际 401` + `结论：线上仍是旧代码`。
 *      代码完全正确的部署被自己的门卫判成失败。
 *   ② **留垃圾**：同一轮里它还真的去写。本库 PUT 匿名可写、DELETE 需要口令，
 *      所以缺口令时它造得出垃圾却删不掉 —— 实测书库从 4 本变 8 本，
 *      多出来的 `__deploycheck_*` 只能手工清。
 *
 * 两个缺陷的共同根因是同一个：**它没有先问「我有权限收场吗」**。
 * 下面钉住的就是这个判断必须存在、且必须挡在写操作之前。
 */
describe('线上验证探针：不许再报假阴性、不许再留垃圾', () => {
  const src = SNAPSHOT.verifyDeploySource;
  const workflow = SNAPSHOT.deployWorkflow;

  it('源码读到了（否则下面的断言会假绿）', () => {
    expect(src.length, 'verify-deploy.mjs 没读到，快照键或路径变了').toBeGreaterThan(1000);
  });

  it('必须有「能不能收场」的判定，且它挡在三个写探针之前', () => {
    // 判定的名字本身就把结论说清楚了：不是「有没有权限」，是「跑了能不能收场」。
    expect(src, 'CAN_WRITE 判定不见了').toMatch(/const CAN_WRITE\s*=/);
    // 且它必须真的**取决于口令**。只断言「存在一个叫 CAN_WRITE 的常量」不够 ——
    // 变异验证抓到过：把它改成 `const CAN_WRITE = true` 后所有断言照样绿，
    // 而那正是最坏的形态（守卫看着在、实则永远放行）。
    expect(src, 'CAN_WRITE 不再取决于口令 —— 守卫被架空了').toMatch(
      /const CAN_WRITE = TOKEN\.length > 0;/,
    );

    const guardIdx = src.indexOf('const CAN_WRITE');
    expect(guardIdx, 'CAN_WRITE 不见了').toBeGreaterThan(-1);

    // 三个写探针的**函数定义**都必须在判定之后出现。
    // 用函数定义而不是调用点：调用点在后，那是执行顺序；这里要钉的是
    // 「写这一段的代码时，作者必须先看到那个判定」。
    for (const fn of ['async function probeCopyWhitelist', 'async function probeUnlockNoToken', 'async function probeOverwrite']) {
      const fnIdx = src.indexOf(fn);
      expect(fnIdx, `${fn} 不见了`).toBeGreaterThan(-1);
      expect(fnIdx, `${fn} 排在 CAN_WRITE 之前 —— 写这段时看不到「能不能收场」`).toBeGreaterThan(guardIdx);
    }
  });

  it('写探针必须被 CAN_WRITE 挡住（缺口令时一个字节都不许写）', () => {
    // 三个写探针各自的第一句都必须是「没有口令就跳过」的早退。
    // 这条断言防的是「只在注释里写了要检查、代码却没做」——
    // 那正是上一版的形态：注释说「需要写口令才能跑」，代码照跑。
    const skipCalls = src.match(/skipWriteProbe\(/g) ?? [];
    // 1 处定义 + 3 处调用
    expect(skipCalls.length, `skipWriteProbe 应被 3 个写探针调用，实际出现 ${skipCalls.length} 次`).toBe(4);
  });

  it('Overwrite 探针不许在缺口令时判 fail（401 是规范要求，不是缺陷）', () => {
    // 曾经的写法直接把任何非 412 判成 fail，于是匿名请求稳定拿到一个 ❌。
    // 现在它必须在缺口令时走 skip 分支。
    expect(src, 'Overwrite 探针又变成无条件 fail 了').toMatch(/if \(!CAN_WRITE\) \{[\s\S]{0,200}?skipWriteProbe/);
    // 且论证必须留在源码里 —— 下一个改这里的人要知道 401 是有意为之。
    expect(src, 'RFC 4918 §10.6 的授权优先论证被删了').toContain('10.6');
    expect(src, '§8.1「授权错误优先」的论证被删了').toContain('8.1');
  });

  it('CI 必须把 WRITE_TOKEN 传进探针（否则三条探针永远 skipped）', () => {
    // 这是缺陷①的直接成因：探针支持口令，但 CI 从来不传。
    // 不传时它不会红，只会静默跳过 —— 静默是这里最坏的失败模式。
    expect(workflow.length, 'deploy.yml 没读到').toBeGreaterThan(100);
    expect(workflow, 'CI 没把 WRITE_TOKEN 传给探针 —— 三条写探针会静默跳过').toMatch(
      /WRITE_TOKEN:\s*\$\{\{\s*secrets\.WRITE_TOKEN\s*\}\}/,
    );
    // 且缺口令时要发出警告（GitHub 的 ::warning:: 注解），别让它静默。
    expect(workflow, '缺 WRITE_TOKEN 时没有告警').toContain('::warning::');
  });

  it('CI 必须用 --strict 调探针（否则这个 job 永远不会红）', () => {
    // 缺陷③：探针的三条退出路径全是 `process.exit(STRICT ? 1 : 0)`，
    // 而不加 --strict 时 STRICT 为 false —— 于是它**即使每一条都报 ❌ 也退出 0**。
    // 那个 job 因此永远不会失败，比没有门卫更糟：
    // 它会被读成「线上已验证通过」，而实际上什么都没验证。
    expect(workflow.length, 'deploy.yml 没读到').toBeGreaterThan(100);
    expect(workflow, 'CI 调探针时没加 --strict —— 报了错也不会红').toMatch(
      /node\s+scripts\/verify-deploy\.mjs[^\n]*--strict/,
    );
  });

  it('探针的退出码必须真的取决于 STRICT 与结果（不是恒 0）', () => {
    const src = SNAPSHOT.verifyDeploySource;
    expect(src.length).toBeGreaterThan(1000);
    // 曾经写成 `process.exit(STRICT ? 0 : 0)` —— 两个分支一样，
    // 也就是「成功」那条路径上的恒 0，看着像有意为之。
    expect(src, 'exit 表达式的两个分支不能相同').not.toMatch(/process\.exit\(\s*STRICT\s*\?\s*0\s*:\s*0\s*\)/);
    // 成功路径必须无条件退出 0（它不接受「非严格模式」这种说法）
    expect(src, '成功路径的退出码应当恒为 0').toMatch(/结论：线上是\*\*新代码\*\*/);
  });
});
