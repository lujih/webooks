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
 * 这不是假设：实测 `not_found_handling: "404-page"` 时，只要请求带
 * `Sec-Fetch-Mode: navigate`（真实浏览器每次顶层导航都带，curl 不带），
 * `/`、`/upload`、`/requests`、`/admin`、`/dav/` **全部**被静态 404 页吃掉。
 * curl 冒烟测试因此全是假绿。
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

describe('静态资源配置：not_found_handling 必须是 none', () => {
  const cfg = readWranglerConfig();

  it('assets 块存在且指向 ./public', () => {
    // 这条断言同时是「assets 块没被人删掉」的守卫 ——
    // 删掉它不会让任何功能测试变红，只会让 favicon/robots 静默变回
    // 「每次访问花一次 Worker 请求」，属于最难察觉的那类回退。
    expect(cfg.assets, 'assets 块丢失，静态资源优化被移除').toBeTruthy();
    expect(cfg.assets.directory).toBe('./public');
  });

  it('not_found_handling 是 none —— 改成 404-page 会让整站对真人 404', () => {
    // 这是本文件最重要的一条断言。理由见文件头：
    // "404-page" 在带 Sec-Fetch-Mode: navigate 的请求上会抢走所有 Worker 路由。
    expect(cfg.assets.not_found_handling).toBe('none');
  });

  it('没有用 run_worker_first 反转顺序', () => {
    // run_worker_first: true 等于「每个请求都先跑 Worker」——
    // 静态资源再也省不下一次请求，本优化归零。
    // （数组形式理论上可用，但它要逐个列出 Worker 路径，而 DAV_MOUNT
    //   是部署期可覆盖的，静态列表无法保持同步 —— 所以整体禁用。）
    expect(cfg.assets.run_worker_first).toBeUndefined();
  });

  it('DAV_MOUNT 没有被 wrangler.jsonc 覆盖（robots.txt 的写死路径依赖它）', () => {
    // robots.txt 是静态文件，只能写死 `/dav/`。若有人在 vars 里把
    // DAV_MOUNT 改成别的（比如 /library），这条 Disallow 就失效了，
    // 而爬虫会重新开始枚举那棵可无限展开的目录树。
    // 这条断言把这层「隐式耦合」变成显式的：改了就红，逼你去同步 robots.txt。
    expect(cfg.vars?.DAV_MOUNT, 'DAV_MOUNT 被覆盖了，请同步 public/robots.txt 的 Disallow').toBeUndefined();
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
  it('每个 public/ 下的实体文件都有对应的头规则', () => {
    // 静态资源不经过 Worker，拿不到 withSecurityHeaders() 的那套头。
    // 漏一条规则 = 那个文件裸奔（没有 Cache-Control 也没有 nosniff）。
    const files = Object.keys(FILES).filter((f) => f !== '_headers');
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(headerRules.has(`/${f}`), `public/${f} 没有 _headers 规则`).toBe(true);
    }
  });

  it('每个静态资源都带 cache-control 与 nosniff', () => {
    for (const [path, names] of headerRules) {
      expect(names, `${path} 缺 cache-control`).toContain('cache-control');
      expect(names, `${path} 缺 x-content-type-options`).toContain('x-content-type-options');
    }
  });

  it('没有重复规则（同一个头发两遍时，浏览器对 CSP 取交集，极难排查）', () => {
    const paths: string[] = [];
    for (const rawLine of headersFile.split('\n')) {
      const line = rawLine.replace(/\s+$/, '');
      if (!line.trim() || line.trim().startsWith('#')) continue;
      if (!/^\s/.test(line)) paths.push(line.trim());
    }
    expect(paths.length).toBe(new Set(paths).size);
  });

  it('没有用 /* 兜底（兜底规则会和具体规则叠加，导致重复发头）', () => {
    expect(headerRules.has('/*')).toBe(false);
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
});
