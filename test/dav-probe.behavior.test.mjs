/**
 * `scripts/dav-probe.mjs` 的**行为**测试。
 *
 * ## 为什么要这个文件（不是又一份「读源码」守卫）
 *
 * 本任务的缺陷不是「某一行写错了」，而是**判定逻辑认不出自家响应**：
 * task-10 给 LOCK/DELETE/MOVE 加了写口令闸门（401 + `www-authenticate:
 * Basic realm="webooks"`），而 `originReached()` 只认 Allow/DAV/x-dav-*
 * 头与四句正文 —— 认不出这个 401 也是自家 Worker 发的。于是：
 *
 *   LOCK — HTTP 401，无法归类
 *   主因判定：Cloudflare 边缘没有把这些动词转发到 Worker。
 *
 * 而请求**明明到达了 Worker**（401 是它自己回的）。这是假诊断，比不报更坏：
 * 它会让人去查 WAF 规则，而真正该做的是补一个写口令。
 *
 * 这类缺陷正好是**源码文本断言钉不住**的那一类（函数还在、那一行还在，
 * 只是判据不对），所以这里起本地假服务器、`spawn` 真跑脚本，
 * 断言的是观察到的 stdout / exit code / 桩收到的请求。一行源码都没读。
 *
 * ## 桩服务器的诚实性要求
 *
 * 桩必须**照真实语义**应答 `src/webdav/index.ts` 的分发层，否则测的是幻觉：
 *   · 写口令缺失/错误 → 401 + `www-authenticate: Basic realm="webooks"`
 *     （`src/lib/auth.ts` 的 `unauthorizedResponse()`）
 *   · 需要口令的是 DELETE / MOVE / LOCK（分发层），以及「覆盖已有书」的 PUT
 *   · 「PUT 新建」保持匿名 —— 这是产品的核心诉求，桩不能一刀切要口令
 *   · 已到达源站的拒绝要带 `allow: …PROPFIND…` 头（脚本靠它认源站）
 *
 * ## 为什么是 `.mjs` 不是 `.ts`
 *
 * 本仓库没有 `@types/node`，而这里要用 node:http / node:child_process。
 * `.mjs` 不在 tsconfig 的 include 里，typecheck 天然跳过 —— 零改动、
 * 零新增依赖，也让 `vitest.config.ts` 的 node 项目（include 写死
 * `test/**\/*.behavior.test.mjs`）能收到它。与
 * `test/verify-deploy.behavior.test.mjs` 同一套理由与写法。
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../scripts/dav-probe.mjs', import.meta.url));

/** 与 src/webdav/index.ts 的 ALLOW 常量一致 */
const ALLOW = 'OPTIONS, GET, HEAD, PROPFIND, PROPPATCH, MKCOL, LOCK, UNLOCK, PUT, DELETE, COPY, MOVE';

/** `unauthorizedResponse()` 的固定形态；脚本与桩都靠 realm 认「自家 401」 */
const WWW_AUTH = 'Basic realm="webooks", charset="UTF-8"';

/** 桩认的写口令。❌ 与 ✅ 两条路径都用它对比，证明判据真的落在口令上 */
const GOOD_TOKEN = 'goodtoken';

const PROPFIND_XML = (href) =>
  '<?xml version="1.0" encoding="utf-8"?>\n'
  + '<D:multistatus xmlns:D="DAV:">'
  + `<D:response><D:href>${href}</D:href><D:propstat><D:prop>`
  + '<D:resourcetype/></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>'
  + '</D:multistatus>';

/**
 * 从 `Authorization: Basic <b64>` 里取出**冒号之后**的部分。
 *
 * 必须与 `src/lib/auth.ts` 的 `extractToken()` 同语义：用户名任意、
 * 口令即密码（本项目的模型里只有一个共享口令）。用 `indexOf(':')` 而不是
 * `split(':')`，是因为口令本身可能含冒号。
 */
function basicPassword(header) {
  const m = /^Basic\s+(.+)$/i.exec(header ?? '');
  if (!m) return '';
  try {
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    return idx >= 0 ? decoded.slice(idx + 1) : decoded;
  } catch {
    return '';
  }
}

/**
 * 一个「webooks 线上站点」的替身。
 *
 * 只实现 dav-probe 会打到的那些路径，但**每条都照真实语义**答：
 * `/health`、挂载根 `/dav/`、集合 `/dav/recent/`、叶子 `/dav/recent/<名>`。
 *
 * ⚠️ 桩的形态是拿**真实 wrangler dev** 逐条量出来的（不是照文档猜的）：
 *   401 头、LOCK 200 的 `<D:prop>`、UNLOCK 无 token 的 400、未知属性的
 *   404 propstat、MKCOL 405、COPY 403、GET 302 no-store、HEAD 的
 *   Content-Length = 对象字节数。桩不照现实，测的就是幻觉。
 */
async function startFakeDav(opts = {}) {
  const state = { token: GOOD_TOKEN };
  const log = [];
  /** 桩里「已存在」的叶子 —— PUT 覆盖与 DELETE 的语义都要靠它 */
  const objects = new Map();
  /**
   * 「Worker 抛异常」形态：所有 /dav/ 方法回裸 500。
   *
   * ⚠️ 正文刻意**不带** Cloudflare 的 `error code: 1101` / `cf-error-code`：
   *   本地 `wrangler dev` 与线上某些未包装的异常就是这种裸 500。脚本若只认
   *   cfCode，这种 500 会一路掉到 pass 分支，把「Worker 崩了」报成
   *   「动词放行正常」—— 实测过，是真实存在的洞。
   */
  const bare500 = opts.bare500 === true;

  /** 读请求体（PROPFIND 的 propname / 未知属性判定要用） */
  const readBody = (req) => new Promise((resolve) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(data));
  });

  const server = createServer(async (req, res) => {
    const path = (req.url || '/').split('?')[0];
    const method = (req.method || 'GET').toUpperCase();
    const provided = basicPassword(req.headers.authorization) || (req.headers['x-write-token'] ?? '');
    log.push({ method, path, provided });

    const send = (status, body, headers = {}) => {
      res.writeHead(status, headers);
      res.end(body);
    };
    /** src/lib/auth.ts 的 unauthorizedResponse() —— 形态按实测抄 */
    const unauthorized = () => send(401, 'Authentication required for this operation\n', {
      'content-type': 'text/plain; charset=utf-8',
      'www-authenticate': WWW_AUTH,
    });
    const authed = () => provided === state.token;

    if (path === '/health') return send(200, 'ok', { 'content-type': 'text/plain' });

    if (!path.startsWith('/dav/')) return send(404, 'Not Found');

    // 「Worker 抛异常」：所有 DAV 方法回裸 500（正文**刻意不带** cfCode）。
    // 注意 /health 在上面已经答过 200 —— 预检过了、动词却全崩，正是脚本
    // 「主因判定：Worker 运行时异常」那一段要覆盖的形状。
    if (bare500) return send(500, 'Internal Server Error');

    /** 照 src/webdav/propfind.ts 的形态生成 multistatus（含 x-dav-cache 标记） */
    const multistatus = (extraHeaders = {}) => send(207,
      '<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">'
      + '<D:response><D:href>/dav/</D:href><D:propstat><D:prop><D:resourcetype/>'
      + '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>'
      + '</D:multistatus>',
      {
        'content-type': 'application/xml; charset=utf-8',
        // 实测线上/本地都有这两个头；脚本的 originReached() 靠它们认源站
        'x-dav-cache': 'MISS',
        'x-dav-entries': '1',
        ...extraHeaders,
      });

    const leafName = path.slice('/dav/recent/'.length);
    const isRecentLeaf = path.startsWith('/dav/recent/') && leafName !== '';

    // ── 叶子 ────────────────────────────────────────────────────────────
    if (isRecentLeaf) {
      if (method === 'PUT') {
        const body = await readBody(req);
        // 分发层放行 PUT（读与新增保持匿名），口令判据在 handlePut 内部：
        // **只有覆盖已有书才要口令**。实测：新建 201 / 匿名覆盖 401 / 带凭据覆盖 204。
        if (!authed() && objects.has(leafName)) return unauthorized();
        const existed = objects.has(leafName);
        objects.set(leafName, body);
        return send(existed ? 204 : 201, '');
      }
      if (method === 'DELETE') {
        // 分发层无条件要口令（破坏性操作）
        if (!authed()) return unauthorized();
        if (!objects.has(leafName)) return send(404, 'Not Found');
        objects.delete(leafName);
        return send(204, '');
      }
      if (method === 'PROPFIND') {
        // ⚠️ 叶子不存在 → **404**（实测：删掉后的叶子 PROPFIND 回 404，不是 207）。
        //   脚本的「DELETE 后访问返回 404」这条探针就靠它 —— 桩若一律回 207，
        //   那条探针在有凭据的好跑法里会假红。
        if (!objects.has(leafName)) return send(404, 'Not Found');
        return send(207,
          '<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">'
          + `<D:response><D:href>${path}</D:href><D:propstat><D:prop><D:resourcetype/>`
          + '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>'
          + '</D:multistatus>',
          { 'content-type': 'application/xml; charset=utf-8', 'x-dav-cache': 'MISS', 'x-dav-entries': '1' });
      }
      if (method === 'HEAD') {
        // 实测：Content-Length 就是对象字节数，且带 Accept-Ranges/ETag/no-store
        const body = objects.get(leafName) ?? '';
        return send(200, '', {
          'content-length': String(Buffer.byteLength(body)),
          'content-type': 'application/epub+zip',
          'accept-ranges': 'bytes',
          'cache-control': 'no-store',
        });
      }
      if (method === 'GET') {
        // 实测：302 + no-store 指向 R2 公开域（下载不经过 Worker 的那条路）
        return send(302, '', {
          location: 'https://books.example/books/abc',
          'cache-control': 'no-store',
        });
      }
      return send(405, 'Method Not Allowed', { allow: ALLOW });
    }

    if (path.startsWith('/dav/recent/')) {
      // 集合本身
      if (method === 'PROPFIND') {
        const hrefs = ['/dav/recent/', ...[...objects.keys()].map((n) => `/dav/recent/${encodeURIComponent(n)}`)];
        return send(207,
          '<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">'
          + hrefs.map((h) => `<D:response><D:href>${h}</D:href><D:propstat><D:prop><D:resourcetype/>`
            + '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>').join('')
          + '</D:multistatus>',
          { 'content-type': 'application/xml; charset=utf-8', 'x-dav-cache': 'MISS', 'x-dav-entries': String(hrefs.length) });
      }
      return send(405, 'Method Not Allowed', { allow: ALLOW });
    }

    // ── 挂载根 /dav/ ───────────────────────────────────────────────────
    // 分发层（src/webdav/index.ts）：PUT/PROPFIND/GET/HEAD/OPTIONS/PROPPATCH/
    // MKCOL/COPY/UNLOCK 匿名；DELETE/MOVE/LOCK 要口令。
    if (method === 'OPTIONS') {
      return send(200, '', { allow: ALLOW, dav: '1, 2' });
    }
    if (method === 'PROPFIND') {
      const body = await readBody(req);
      // 未知属性 → §9.1 要求进 404 propstat（probeConformance 断言这一条）
      if (body.includes('no-such-prop')) {
        return send(207,
          '<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">'
          + '<D:response><D:href>/dav/</D:href><D:propstat><D:prop><D:no-such-prop/></D:prop>'
          + '<D:status>HTTP/1.1 404 Not Found</D:status></D:propstat></D:response></D:multistatus>',
          { 'content-type': 'application/xml; charset=utf-8', 'x-dav-cache': 'MISS', 'x-dav-entries': '1' });
      }
      // propname → 只回**名字**，不能带回值（断言用 `!<D:getcontentlength>` 判，
      // 所以必须写成自闭合 `<D:getcontentlength/>` 而不是带值的成对标签）
      if (body.includes('propname')) {
        return send(207,
          '<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">'
          + '<D:response><D:href>/dav/</D:href><D:propstat><D:prop><D:resourcetype/>'
          + '<D:getcontentlength/><D:getcontenttype/><D:displayname/>'
          + '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>',
          { 'content-type': 'application/xml; charset=utf-8', 'x-dav-cache': 'MISS', 'x-dav-entries': '1' });
      }
      // allprop / 空 body → 207（空 body 实测也按 allprop 处理）
      return multistatus();
    }
    if (method === 'PROPPATCH') {
      // 属性只读 → 403 + DAV:cannot-modify-protected-property（§9.2）
      return send(207,
        '<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:"><D:response>'
        + '<D:href>/dav/</D:href><D:propstat><D:prop><D:k/></D:prop>'
        + '<D:status>HTTP/1.1 403 Forbidden</D:status>'
        + '<D:error><D:cannot-modify-protected-property/></D:error></D:propstat></D:response></D:multistatus>',
        { 'content-type': 'application/xml; charset=utf-8', allow: ALLOW });
    }
    if (method === 'MKCOL') {
      // 已映射集合 → 405（RFC 4918 §9.3.1）。实测本地也是 405。
      return send(405, 'Collection already exists (virtual collection, derived from the library index)', { allow: ALLOW });
    }
    if (method === 'COPY') {
      // 源不是叶子 → 403 + allow（实测形态）
      return send(403, 'Only leaf files can be moved/copied (virtual collections are derived, not stored)', { allow: ALLOW });
    }
    if (method === 'MOVE') {
      if (!authed()) return unauthorized();
      return send(403, 'Only leaf files can be moved/copied (virtual collections are derived, not stored)', { allow: ALLOW });
    }
    if (method === 'LOCK') {
      // 建锁要写口令（分发层）。200 的正文是 `<D:prop>` 包 lockdiscovery（§9.10.1），
      // 头回 Coded-URL —— **注意这个 200 没有任何 Allow/DAV 头**，
      // 脚本只能靠正文的 `xmlns:D="DAV:"` 认出是自家源站。
      if (!authed()) return unauthorized();
      const token = 'urn:uuid:11111111-2222-3333-4444-555555555555';
      return send(200,
        '<?xml version="1.0" encoding="utf-8"?>\n'
        + `<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock>`
        + '<D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype>'
        + '<D:depth>infinity</D:depth><D:timeout>Second-60</D:timeout>'
        + `<D:locktoken><D:href>${token}</D:href></D:locktoken>`
        + `</D:activelock></D:lockdiscovery></D:prop>`,
        { 'content-type': 'application/xml; charset=utf-8', 'lock-token': `<${token}>` });
    }
    if (method === 'UNLOCK') {
      // §9.11.1：没带 Lock-Token → **400**，正文是自家的 `<D:error>`。
      // ⚠️ 这是第二个假诊断入口：这个 400 同样没有 Allow/DAV 头，
      //   只修 401 那条的话它照样落进「边缘没有转发」。实测确认过 400 形态。
      if (!req.headers['lock-token']) {
        return send(400,
          '<?xml version="1.0" encoding="utf-8"?>\n<D:error xmlns:D="DAV:"><D:lock-token-matches-request-uri/></D:error>',
          { 'content-type': 'application/xml; charset=utf-8' });
      }
      return send(204, '');
    }
    if (method === 'DELETE') {
      if (!authed()) return unauthorized();
      return send(405, 'DELETE on the mount root is not supported (it would delete the whole library).', { allow: ALLOW });
    }
    if (method === 'PUT') {
      // 挂载根不是叶子 → 405 + allow
      return send(405, 'PUT is only allowed on file paths', { allow: ALLOW });
    }
    return send(405, 'Method Not Allowed', { allow: ALLOW });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    /** 探针期望的形态：以 `/dav/` 结尾，`../health` 才解析得到 |
     *  这正是线上 `--url https://…/dav/` 的形状 */
    url: `http://127.0.0.1:${port}/dav/`,
    state,
    log,
    /** 桩收到过哪些方法（证明脚本真的把请求发出去了，测试不是空转） */
    methods: () => log.map((e) => e.method),
    /**
     * 书库里**还剩下**哪些探针对象 —— 是存活状态，不是请求历史。
     *
     * ⚠️ 别用 log 里出现过的路径来判「清理干净了没」：PUT 和 DELETE 都会
     *   打同一个路径，按 log 判的话删干净了也照样"残留"。清理由 objects
     *   这个真正的对象表说话。
     */
    survivingProbes: () => [...objects.keys()]
      .map((n) => { try { return decodeURIComponent(n); } catch { return n; } })
      .filter((n) => n.startsWith('__probe_') || n.startsWith('__探针_')),
    /** 对象表里的一切（调试用） */
    surviving: () => [...objects.keys()],
    /** ⚠️ 必须先 closeAllConnections()，否则 keep-alive 连接挂着会卡死 afterEach */
    close: () => new Promise((r) => {
      server.closeAllConnections();
      server.close(r);
    }),
  };
}

/**
 * 真 spawn 一个 node 进程跑 `scripts/dav-probe.mjs`。
 *
 * ⚠️ 环境变量必须**完全可控**：脚本从 `DAV_URL/DAV_USER/DAV_PASS` 读默认值，
 *   宿主环境里恰好设了任何一个都会让「无凭据跑法」变成另一种场景。
 *   这里一律显式传空串（空串即「没设」）。
 */
function runDavProbe({ url, user = '', pass = '' }) {
  const args = [SCRIPT, '--url', url];
  if (user || pass) {
    args.push('--user', user, '--pass', pass);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, DAV_URL: '', DAV_USER: '', DAV_PASS: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`dav-probe.mjs 超过 60s 没退出；stderr:\n${stderr}`));
    }, 60_000);
    child.on('error', reject);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * 抽出探针结果行，并**带上所属分组**：`  <图标> <名字>  — <详情>`。
 *
 * ⚠️ 三个坑，都是实测踩出来的：
 *   ① info/warn/skip 的图标在脚本里**自带一个尾随空格**（`ℹ️ ` / `⚠️ ` / `⏭️ `，
 *      为的是让四列图标对齐），所以那些行是**两个**空格再接名字。
 *      按「一个空格」写正则，这些行会全部解析不出来。
 *   ② 名字与 `—` 之间有 ANSI 复位序列（`[2m`），不先剥掉的话
 *      `startsWith('LOCK ')` 永远不成立（`LOCK` 后面紧跟的是 ESC 而不是空格）。
 *   ③ **同名动词会出现在不同分组里**：`PUT` 既是「动词放行」组的一条，
 *      也是「Expect: 100-continue」组的 `PUT 握手`/`PUT 结果`。只按名字找会
 *      串组 —— 分组头是脚本里唯一不带前导空格的行。
 */
function parseProbes(stdout) {
  let group = '';
  const out = [];
  for (const raw of stdout.replace(ANSI, '').split('\n')) {
    // 分组头：整行非空、不以空格开头、不是分隔线/标题
    if (/^[^\s=]/.test(raw) && !raw.startsWith('WebDAV 探针')) {
      group = raw.trim();
      continue;
    }
    const m = /^ {2}(✅|❌|ℹ️|⚠️|⏭️) +(.+)$/.exec(raw);
    if (m) out.push({ group, icon: m[1], text: m[2] });
  }
  return out;
}

/** 兼容旧名（不带分组） */
function probeLines(stdout) {
  return parseProbes(stdout);
}

/** 某分组里的全部结果行 */
function groupLines(stdout, group) {
  return parseProbes(stdout).filter((l) => l.group === group);
}

/** 某条动词的放行结论（**限定在「动词放行」组**，避免与 PUT 握手等串组） */
function verbLine(stdout, verb) {
  return groupLines(stdout, '动词放行')
    .find((l) => l.text === verb || l.text.startsWith(`${verb} `)) ?? null;
}

let site;

beforeEach(async () => { site = await startFakeDav(); });
afterEach(async () => { await site.close(); });

describe('dav-probe.mjs：写动词需凭据时不许报假诊断（真跑脚本，不是读源码）', () => {
  test('A0｜前提：桩真的被打了（否则下面全是空转）', async () => {
    const run = await runDavProbe({ url: site.url });
    // 脚本先探 /health，再逐动词打 /dav/
    expect(site.log.some((e) => e.path === '/health')).toBe(true);
    expect(site.methods()).toEqual(expect.arrayContaining(['OPTIONS', 'PROPFIND', 'LOCK', 'DELETE', 'MOVE']));
    // 无凭据时桩确实看到「没给口令」，对照后面 B 组
    expect(site.log.find((e) => e.method === 'LOCK').provided).toBe('');
    expect(run.code).toBe(0);
  });

  test('A1｜无凭据：三个写动词被认成「已到达源站、只是缺凭据」，不是「无法归类」', async () => {
    const run = await runDavProbe({ url: site.url });

    // ★ 缺陷本体：401 曾被判成 unknown，输出「HTTP 401，无法归类」
    expect(run.stdout).not.toContain('无法归类');
    // ★ 假诊断的结论行：不该再出现（请求明明到达了 Worker）
    expect(run.stdout).not.toContain('边缘没有把这些动词转发');
    // 也不该报成「Worker 运行时异常」
    expect(run.stdout).not.toContain('主因判定：Worker 运行时异常');

    // 三条要口令的动词，各自记 INFO（不是 fail、不是 blocked）
    for (const verb of ['LOCK', 'DELETE', 'MOVE']) {
      const line = verbLine(run.stdout, verb);
      expect(line, `${verb} 应当出现在结果里`).not.toBeNull();
      expect(line.icon, `${verb} 应为 INFO（缺凭据是本次调用缺输入，不是站点缺陷）`).toBe('ℹ️');
      expect(line.text).toContain('到达源站');
    }

    // 反面：匿名动词不许被算进「缺凭据」
    const options = verbLine(run.stdout, 'OPTIONS');
    expect(options.icon).toBe('✅');

    // 无成功失败 → exit 0（INFO 不算失败）
    expect(run.code).toBe(0);
  });

  test('A2｜无凭据：结论区必须显式写明「N 个写动词的凭据路径未验证」', async () => {
    const run = await runDavProbe({ url: site.url });

    // ★ 要求 4：全绿不许被误读成「写路径已验证」
    expect(run.stdout).toContain('个写动词的凭据路径未验证');
    expect(run.stdout).toContain('LOCK');
    // 并且给出可执行的下一步，而不只是「需要认证」
    expect(run.stdout).toContain('--pass <WRITE_TOKEN>');
  });

  test('A3｜无凭据：清理失败不许静默 —— 残留文件必须被点名，并给清理途径', async () => {
    const run = await runDavProbe({ url: site.url });

    // 桩里 PUT 新建是匿名的 → 探针文件真的落了盘（不是空谈）
    expect(site.survivingProbes().some((n) => n.startsWith('__probe_'))).toBe(true);

    // ★ 要求 5：DELETE 需要口令 → 删不掉 → 必须报出来
    expect(run.stdout).toContain('DELETE 需要写口令');
    expect(run.stdout).toContain('残留文件：');
    // 残留提示要给出可照做的清理路径（admin 接口）
    expect(run.stdout).toContain('/api/admin/delete');
    // 清理没成功时，那条「DELETE 后 404」必须记成 skip 而不是 pass
    //（pass 意味着量到的其实是残留文件，等于把「没删掉」报成「删掉了」）
    const afterDelete = probeLines(run.stdout).find((l) => l.text.startsWith('DELETE 后访问返回 404'));
    expect(afterDelete.icon, '清理失败时这条必须 skip，不能是 pass').toBe('⏭️');
  });

  test('B1｜给了错口令：必须 fail（否则「带口令跑出全绿」是假的）', async () => {
    const run = await runDavProbe({ url: site.url, user: 'x', pass: 'wrong-token' });

    // ★ 要求 3：带凭据仍 401 = 真 fail
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('已带凭据仍被拒');
    expect(run.stdout).toContain('口令错误或权限不足');
    // 但仍**不是**边缘拦截 —— 这条假诊断在错口令场景下同样不许出现
    expect(run.stdout).not.toContain('边缘没有把这些动词转发');
    expect(run.stdout).not.toContain('无法归类');

    const line = verbLine(run.stdout, 'LOCK');
    expect(line.icon).toBe('❌');
    // 结论区要明说是口令问题，不是站点坏了
    expect(run.stdout).toContain('已提供凭据但被拒');
    expect(run.stdout).not.toContain('个写动词的凭据路径未验证');
  });

  test('B2｜给了错口令：清理也失败，同样要点名残留', async () => {
    const run = await runDavProbe({ url: site.url, user: 'x', pass: 'wrong-token' });
    expect(run.stdout).toContain('残留文件：');
  });

  test('C1｜给了对口令：三种跑法输出必须各不相同 —— 全绿且不再有未验证提示', async () => {
    const run = await runDavProbe({ url: site.url, user: 'x', pass: GOOD_TOKEN });

    // 桩确实看到了口令（证明是凭据在起作用，不是碰巧放行）
    expect(site.log.find((e) => e.method === 'LOCK').provided).toBe(GOOD_TOKEN);

    expect(run.code).toBe(0);
    // 全绿：没有失败项、没有未验证提示、没有假诊断
    expect(run.stdout).not.toContain('个写动词的凭据路径未验证');
    expect(run.stdout).not.toContain('已提供凭据但被拒');
    expect(run.stdout).not.toContain('边缘没有把这些动词转发');

    // 三条写动词这次走的是**真实放行**路径（不再是 INFO）
    for (const verb of ['LOCK', 'DELETE', 'MOVE']) {
      const line = verbLine(run.stdout, verb);
      expect(line.icon, `${verb} 带对凭据后应为 PASS`).toBe('✅');
      expect(line.text).toContain('已到达源站');
    }
  });

  test('C2｜给了对口令：覆盖 PUT 与清理都真的成功，书库不留垃圾', async () => {
    const run = await runDavProbe({ url: site.url, user: 'x', pass: GOOD_TOKEN });

    // PUT 覆盖需要口令；这次应当成功（无凭据时是 401 → INFO）
    const overwrite = probeLines(run.stdout).find((l) => l.text.startsWith('PUT 覆盖返回 204'));
    expect(overwrite.icon).toBe('✅');

    // 清理成功 → 没有残留提示；且桩里那些 __probe_ 对象真的被删了
    expect(run.stdout).not.toContain('残留文件：');
    expect(site.survivingProbes()).toEqual([]);

    // 清理干净了才允许报「DELETE 后访问返回 404」
    const afterDelete = probeLines(run.stdout).find((l) => l.text.startsWith('DELETE 后访问返回 404'));
    expect(afterDelete.icon).toBe('✅');
  });

  test('E1｜Worker 回裸 500（无 cf-error-code）：必须报成 Worker 崩了，不许报成「动词放行正常」', async () => {
    // ⚠️ 这条补的是变异 M6 暴露的洞：脚本原来只认正文里的
    //   `error code: 1101`，于是本地 wrangler dev 那种裸 500 会掉进 pass
    //   分支 —— 「Worker 抛异常」被报成 10 个动词全部放行。桩不带 cfCode
    //   正是为了钉住「判据落在状态码上」。
    const broken = await startFakeDav({ bare500: true });
    try {
      const run = await runDavProbe({ url: broken.url });

      expect(run.code).toBe(1);
      // 5xx 的动词不许有任何一条被记成 pass（**只看「动词放行」组**；
      // 「Expect: 100-continue」组里的 `PUT 握手` 是套接字层的另一回事）
      const verbPasses = groupLines(run.stdout, '动词放行').filter((l) => l.icon === '✅');
      expect(verbPasses, `裸 500 被记成通过的动词：${verbPasses.map((l) => l.text).join(' | ')}`).toEqual([]);
      // 主因要指向 Worker，而不是「边缘没转发」
      expect(run.stdout).toContain('Worker 运行时异常');
      expect(run.stdout).not.toContain('边缘没有把这些动词转发');
    } finally {
      await broken.close();
    }
  });

  test('D1｜对照：三种跑法的 stdout 互不相同（不是同一份输出换了个 exit code）', async () => {
    const anon = await runDavProbe({ url: site.url });
    const wrong = await runDavProbe({ url: site.url, user: 'x', pass: 'wrong-token' });
    const right = await runDavProbe({ url: site.url, user: 'x', pass: GOOD_TOKEN });

    expect(anon.stdout).not.toBe(wrong.stdout);
    expect(anon.stdout).not.toBe(right.stdout);
    expect(wrong.stdout).not.toBe(right.stdout);

    // 三种场景各自的**签名结论**（缺凭据 / 口令错 / 通过）必须一一对应
    expect(anon.stdout).toContain('个写动词的凭据路径未验证');
    expect(wrong.stdout).toContain('已提供凭据但被拒');
    expect(right.stdout).not.toContain('个写动词的凭据路径未验证');
    expect(right.stdout).not.toContain('已提供凭据但被拒');

    expect([anon.code, wrong.code, right.code]).toEqual([0, 1, 0]);
  });
});
