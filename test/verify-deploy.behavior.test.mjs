/**
 * `scripts/verify-deploy.mjs` 的**行为**测试。
 *
 * ## 为什么需要这个文件（不是又一份「读源码」的守卫）
 *
 * `test/budget-download.test.ts` 里那些针对 verify-deploy 的断言全是
 * `toContain(verifyDeploySource, 'emitFailureAnnotation(')` 这种**源码文本**
 * 断言。它们原理上钉不住一件事：**函数体有没有真的执行**。
 * 实测存活的变异 —— 在 `emitFailureAnnotation` 开头插一行 `return;`：
 *
 *   ```js
 *   function emitFailureAnnotation(title, detail) {
 *     +  return; // ← 整个函数变成空壳，谁都收不到 annotation
 *       if (typeof process === 'undefined' || ...) return;
 *   ```
 *
 *   调用点还在，被断言的那行文本也还在 → **21 条测试全绿**。
 *
 * 本文件的做法相反：起一个**本地假服务器**，用 `spawn` 真把脚本跑起来，
 * 断言的是**观察到的东西** —— exit code、stdout 上的结论行、Actions
 * annotation 行、以及假服务器**收到过哪些请求**。
 * 一行源码都没读。
 *
 * ## 为什么能在 workerd 项目旁边跑（而不是塞进去）
 *
 * workerd 里既没有 child_process 也没有文件系统（`node:fs` 那个空壳在
 * `vitest.config.ts` 的注释里已经交过学费了）。而 CI 的 verify-live job
 * 就是 `node scripts/verify-deploy.mjs` —— 它本来就是跑在 Node 里的东西。
 * 所以 `vitest.config.ts` 把它拆成独立的 `node` 项目（`environment: 'node'`）。
 *
 * ## 为什么是 `.mjs` 不是 `.ts`
 *
 * 本仓库没有 `@types/node`，而这个文件要用 node:http / node:child_process。
 * 补类型只能靠 `@ts-expect-error` / `declare module` 糊，而 tsconfig.json
 * 在写范围之外。`.mjs` 不在 tsconfig 的 include 里（那里只有 `src` 与 `test`
 * 两个目录下的 `.ts`，逐层通配），于是 typecheck 天然跳过 —— 零改动、
 * 零新增依赖。
 * 代价是不受 typecheck 保护；这些断言的对象是 HTTP 请求和 exit code，
 * 本来就以运行时行为为准，静态类型帮不上忙。
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../scripts/verify-deploy.mjs', import.meta.url));

/** 脚本的 `--collection` 默认值，必须按它的编码规则拼出 DAV 前缀 */
const COLLECTION = '最近收录';
const DAV_PREFIX = `/dav/${encodeURIComponent(COLLECTION)}/`;

/** 同一个前缀的**解码**形式，用来解析 COPY/MOVE 的 `destination` 头 */
const DAV_DECODED_PREFIX = `/dav/${COLLECTION}/`;

const NAV_ROUTES = new Set(['/', '/upload', '/requests', '/upload/', '/requests/', '/admin/', '/dav/']);

/** 假「静态资源层」的 favicon：一个 ICO 头 + public/_headers 里的 max-age */
const ICO_BYTES = Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x10, 0x10]);

// ────────────────────────────────────────────────────────────────────────────
// 假服务器
// ────────────────────────────────────────────────────────────────────────────

/**
 * 一个「线上站点」的替身。
 *
 * ⚠️ 故意**不**打真实线上域名：本仓库的守卫必须能在离线 CI 里跑，而且
 *   探针真的会 PUT/DELETE —— 对着真站点跑等于每跑一次测试就往线上书库
 *   写几个 `__deploycheck_*` 再删掉。这个设计本身就是脚本要防的那类垃圾。
 *
 * 行为开关（`opts`）对应脚本各条探针的判据：哪个开关翻掉，就模拟「线上跑的是
 * 旧代码」或「凭据配错」。请求日志则是 B5 的全部依据。
 */
async function startFakeSite() {
  const state = {
    /** 服务端认的口令；请求头 `x-write-token` 与它不符一律 401 */
    token: 'correct-token',
    /** false = 模拟旧代码：favicon 由 Worker 文本 404 应答（修复前的行为） */
    staticFavicon: true,
  };
  const log = [];
  /** 假站点里「已存在」的资源，用于 Overwrite: F 判 412 */
  const objects = new Set();
  let origin = '';

  const server = createServer((req, res) => {
    const path = (req.url || '/').split('?')[0];
    const method = req.method || 'GET';
    const got = req.headers['x-write-token'];
    log.push({ method, path, token: got });

    const send = (status, body, headers = {}) => {
      res.writeHead(status, headers);
      res.end(body);
    };
    const navHtml = () => [
      '<!doctype html><html lang="zh"><head><title>书库</title></head>',
      `<body>${path}</body></html>`,
    ].join('');

    // ── 静态资源层 ────────────────────────────────────────────────────────
    if (path === '/favicon.ico') {
      if (!state.staticFavicon) {
        // 旧代码：Worker 兜底 404，纯文本
        return send(404, 'Not Found', { 'content-type': 'text/plain' });
      }
      return send(200, ICO_BYTES, {
        'content-type': 'image/x-icon',
        // _headers 里的值；探针专门查它有没有被应用（604800 = 7 天）
        'cache-control': 'public, max-age=604800, immutable',
      });
    }

    // ── 浏览页书卡（探针 7 查「直链 R2」）─────────────────────────────────
    if (path === DAV_PREFIX) {
      return send(200,
        '<a class="card shelfcard" href="/">集合</a>'
        // 直链 R2（绝对地址）—— 修复后的形态
        + `<a class="card bookcard" href="${origin}/books/b1">搜神记</a>`,
        { 'content-type': 'text/html; charset=utf-8' });
    }
    if (path.startsWith('/books/')) {
      return send(200, 'epub-bytes', { 'content-type': 'application/epub+zip' });
    }

    // ── WebDAV 写侧 ───────────────────────────────────────────────────────
    if (path.startsWith(DAV_PREFIX)) {
      const name = decodeURIComponent(path.slice(DAV_PREFIX.length));
      // 分发层先查口令再做任何事（src/webdav/index.ts）。口令不符 → 401，
      // 就算目标不存在也一样 —— 这正是「预检 DELETE 不存在的叶子」成立的原因。
      if (got !== state.token) return send(401, 'Unauthorized');

      if (method === 'DELETE') {
        // 不存在的叶子 → 404（口令有效时的正确应答）。
        // 这条是预检的全部依据：脚本拿它区分「口令有效（404）」与
        // 「口令被拒（401）」，所以假服务器必须照真实语义答，
        // 不能偷懒一律 204 —— 那会让预检落到 unknown，
        // 三条写探针全被跳过，B2a/B4/B5 就都测不到东西了。
        if (!objects.has(name)) return send(404, 'Not Found');
        objects.delete(name);
        return send(204, '');
      }
      if (method === 'PUT') {
        objects.add(name);
        return send(201, '');
      }
      if (method === 'LOCK') {
        return send(200, '<D:prop xmlns:D="DAV:"><D:lockdiscovery/></D:prop>', {
          'content-type': 'application/xml',
          'lock-token': '<urn:uuid:11111111-2222-3333-4444-555555555555>',
        });
      }
      if (method === 'UNLOCK') {
        // 无 Lock-Token 头 → 400（RFC 4918 §9.11.1）；修复前是 204。
        if (!req.headers['lock-token']) return send(400, 'Lock-Token required');
        return send(204, '');
      }
      if (method === 'COPY') {
        // ⚠️ `destination` 是**百分号编码**的（脚本用 `${DAV}/${dst}` 拼，
        //   DAV 里的集合名经过了 encodeURIComponent）。所以必须先解码整个头、
        //   再拿**解码后**的路径去比 `dav/<集合>/`，不能拿解码后的字符串去比
        //   编码过的 DAV_PREFIX —— 那样永远比不上，412 就永远不会触发。
        //   （实测踩过：这里写错时 Overwrite 探针稳定拿到 201。）
        const dstUrl = String(req.headers.destination || '');
        const dstPath = decodeURIComponent(dstUrl.replace(/^https?:\/\/[^/]+/, ''));
        const dstName = dstPath.startsWith(DAV_DECODED_PREFIX)
          ? dstPath.slice(DAV_DECODED_PREFIX.length)
          : dstPath;
        // 授权过了才轮到条件头 —— RFC 4918 §8.1 要求授权错误优先
        if (String(req.headers.overwrite).toUpperCase() === 'F' && objects.has(dstName)) {
          return send(412, 'Precondition Failed');
        }
        // 扩展名白名单：COPY 到 .exe → 415；修复前是 201 且真的入库
        if (dstName.endsWith('.exe')) return send(415, 'Unsupported Media Type');
        objects.add(dstName);
        return send(201, '');
      }
      return send(405, 'Method Not Allowed');
    }

    // ── Worker 路由（探针 5：带 sec-fetch-mode:navigate 仍要拿到 Worker 的 HTML）
    if (NAV_ROUTES.has(path)) {
      return send(200, navHtml(), {
        'content-type': 'text/html; charset=utf-8',
        // Worker 生成的 HTML 一定带 CSP，静态 404 页不会 —— 探针就用它区分
        'content-security-policy': "default-src 'self'",
      });
    }

    // ── 未知路径：静态 404 页（免费，未调用 Worker）────────────────────────
    return send(404, '<!doctype html><title>404</title><h1>没有这一页</h1>', {
      'content-type': 'text/html; charset=utf-8',
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  origin = `http://127.0.0.1:${port}`;

  return {
    url: origin,
    state,
    log,
    /**
     * 收到的 DAV **叶子**名（去掉前缀解出文件名），用于 B5。
     *
     * ⚠️ 集合根本身（`/dav/<集合>/`，探针 7 列书卡那条 GET）切完前缀是空串，
     *   混在叶子名里会让「什么都没落盘」这种断言误判，所以这里滤掉。
     */
    davNames: () => log
      .filter((e) => e.path.startsWith(DAV_PREFIX) && e.path !== DAV_PREFIX)
      .map((e) => decodeURIComponent(e.path.slice(DAV_PREFIX.length))),
    close: () => new Promise((r) => server.close(r)),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 运行被测脚本
// ────────────────────────────────────────────────────────────────────────────

/**
 * 真 spawn 一个 node 进程跑 `scripts/verify-deploy.mjs`。
 *
 * ⚠️ 环境变量必须**完全可控**：脚本只在 `GITHUB_ACTIONS === 'true'` 时才打
 *   annotation，而在 `WRITE_TOKEN` 非空时才跑写探针。所以这里把两个变量
 *   （以及历史遗留的 `WEBDAV_WRITE_TOKEN`）都显式赋值，空串即「没设」，
 *   不能指望宿主环境恰好没有 —— 那会让测试在某些机器上莫名变成另一种场景。
 */
function runVerifyDeploy({ url, token = '', strict = false, githubActions = '' }) {
  const args = [SCRIPT, '--url', url];
  if (strict) args.push('--strict');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env: {
        ...process.env,
        WRITE_TOKEN: token,
        WEBDAV_WRITE_TOKEN: token,
        GITHUB_ACTIONS: githubActions,
      },
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
      reject(new Error(`verify-deploy.mjs 超过 60s 没退出；stderr:\n${stderr}`));
    }, 60_000);
    child.on('error', reject);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/** 从 stdout 里抽出每条探针的结果行（`  <图标> <名字> <详情>`） */
function parseProbes(stdout) {
  const ICON = { '✅': 'pass', '❌': 'fail', '➖': 'skip' };
  return stdout
    .split('\n')
    .map((line) => {
      const m = /^ {2}([✅❌➖]) (.*?)\s{2,}(\S.*)$/.exec(line);
      return m ? { status: ICON[m[1]], name: m[2], detail: m[3] } : null;
    })
    .filter(Boolean);
}

/** 抽 Actions annotation（`::error title=…::正文`） */
function parseAnnotations(stdout) {
  return stdout
    .split('\n')
    .filter((l) => l.startsWith('::error '))
    .map((l) => {
      const m = /^::error title=(.*?)::(.*)$/.exec(l);
      return m ? { title: m[1], body: m[2] } : null;
    })
    .filter(Boolean);
}

// ────────────────────────────────────────────────────────────────────────────

let site;

beforeEach(async () => { site = await startFakeSite(); });
afterEach(async () => { await site.close(); });

describe('verify-deploy.mjs 的行为（真跑脚本，不是读源码）', () => {
  test('B1｜emitFailureAnnotation 真的会打出 annotation（变异验证点）', async () => {
    // 模拟「线上仍是旧代码」：favicon 由 Worker 文本 404 应答。
    site.state.staticFavicon = false;

    const run = await runVerifyDeploy({
      url: site.url,
      githubActions: 'true',
      strict: true,
    });

    // 结论行：确实判成了旧代码（前提，否则下面断言的是空壳）
    expect(run.stdout).toContain('结论：线上仍是**旧代码**');
    expect(run.code).toBe(1);

    // ★ 核心断言：annotation 真出现在 stdout 上，且**带具体探针名**。
    //   只断言 title 是不够的 —— 那只证明「打过一条」，
    //   带上探针名才证明「打的是有用的那一条」（日志在本仓库拿不到，
    //   annotation 是唯一通道，见脚本里 emitFailureAnnotation 的注释）。
    const notes = parseAnnotations(run.stdout);
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe('线上仍是旧代码');
    expect(notes[0].body).toContain('/favicon.ico 由静态层服务');
    expect(notes[0].body).toContain('404');
    // annotation 正文被压成一行（Actions 单条有长度限制）
    expect(notes[0].body).not.toContain('\n');
  });

  test('B1b｜不在 Actions 上跑时**不**打 annotation', async () => {
    // 反向守卫：annotation 是 GitHub Actions 的专属协议，本地跑打出去只是噪音。
    site.state.staticFavicon = false;
    const run = await runVerifyDeploy({ url: site.url, strict: true });
    expect(run.stdout).toContain('结论：线上仍是**旧代码**');
    expect(parseAnnotations(run.stdout)).toHaveLength(0);
  });

  test('B2a｜口令有效 → 预检拿 404 → 三条写探针真的跑了', async () => {
    const run = await runVerifyDeploy({
      url: site.url,
      token: site.state.token,
      githubActions: 'true',
      strict: true,
    });

    // 结论：新代码，strict 下也 exit 0（门卫不该在正确部署上变红）
    expect(run.stdout).toContain('结论：线上是**新代码**');
    expect(run.code).toBe(0);
    expect(parseAnnotations(run.stdout)).toHaveLength(0);

    // ★ 关键：不能只看结论，要看**假服务器真的收到了写请求**。
    //   「结论是新代码」在写探针全被跳过时也可能出现（读探针 pass 就够），
    //   所以这里直接查请求日志。
    //   预检那条 DELETE 打的是 `__deploycheck_<stamp>_tokencheck.txt`，
    //   stamp 由 Date.now() 生成，所以只能匹配后缀，不能比全名。
    const names = site.davNames();
    const endsWith = (suffix) => names.some((n) => n.endsWith(suffix));
    expect(names.filter((n) => n.endsWith('_tokencheck.txt'))).toHaveLength(1);
    // 三条写探针各自落过盘
    expect(endsWith('_src.txt')).toBe(true);
    expect(endsWith('_lock.epub')).toBe(true);
    expect(endsWith('_ov_dst.txt')).toBe(true);
    const putCount = site.log.filter((e) => e.method === 'PUT').length;
    expect(putCount).toBe(4); // _src.txt / _lock.epub / _ov_src.txt / _ov_dst.txt

    // 三条写探针的结果都是 pass（而不是 skip）—— 预检通过就该真跑
    const probes = parseProbes(run.stdout);
    for (const name of [
      'COPY 扩展名白名单（.exe）',
      'UNLOCK 缺 Lock-Token（RFC §9.11.1）',
      'Overwrite: F 撞已有目标（RFC §10.6）',
    ]) {
      expect(probes.find((p) => p.name === name)?.status, `${name} 应当是 pass`).toBe('pass');
    }
  });

  test('B2b｜口令被拒 → 结论是「凭据配错」而不是「线上仍是旧代码」', async () => {
    const run = await runVerifyDeploy({
      url: site.url,
      token: 'definitely-wrong',
      githubActions: 'true',
      strict: true,
    });

    // 这条是脚本的**第四个实测缺陷**：以前传错口令与没传口令在输出上无法区分，
    // 「凭据配错了」被读成「代码没部署」，白追两轮。所以必须钉死：
    expect(run.stdout).toContain('结论：**凭据配错**');
    expect(run.stdout).not.toContain('线上仍是**旧代码**');
    // 「验证没做完」在 strict 下照样红 —— 绿灯才危险（探针有一条没跑却说通过）
    expect(run.code).toBe(1);

    // 这条失败分支也必须打自己的 annotation，且 title 明确写着「不是代码问题」
    expect(parseAnnotations(run.stdout).map((a) => a.title))
      .toEqual(['写口令预检失败（凭据问题，不是代码问题）']);

    // 三条写探针一条都没跑 → 假服务器**没收到任何 PUT**
    expect(site.log.filter((e) => e.method === 'PUT')).toHaveLength(0);

    // 其余读探针照跑（结论仍然有效）
    expect(parseProbes(run.stdout).some((p) => p.status === 'pass')).toBe(true);
  });

  /**
   * 口令闸门的**第三种**状态：压根没给 WRITE_TOKEN。
   *
   * 脚本里 `writeTokenState` 有 absent / unverified / ok / rejected / unknown
   * 五个取值。unverified 与 ok 由 B2a/B2b 盖住，rejected 也是 B2b；剩下
   * `absent` 这一支此前无人断言，而它恰好是最要紧的一支 —— **没有口令就绝
   * 不能落盘**（落了删不掉，只能留垃圾）。
   */
  test('B2c｜压根没给 WRITE_TOKEN → 三条写探针 skip，且一个字都没落盘', async () => {
    const run = await runVerifyDeploy({
      url: site.url,
      token: '', // 显式空串，等价于「没设」
      githubActions: 'true',
      strict: true,
    });

    // 读侧全过，所以结论仍然是新代码（skip 不算 fail）
    expect(run.stdout).toContain('结论：线上是**新代码**');
    expect(run.code).toBe(0);
    expect(parseAnnotations(run.stdout)).toHaveLength(0);

    // **一条写请求都不许发出去**：这是「探针不能在线上留垃圾」的底线，
    // 也是没口令时唯一安全的做法。
    const writes = site.log.filter((e) => e.method !== 'GET' && e.method !== 'HEAD');
    expect(writes).toEqual([]);
    expect(site.davNames()).toEqual([]);

    // 没有口令就不会去预检（预检那行根本不该出现在结果表里）——
    // 发了 DELETE 也是白问，还会让人以为口令验过了。
    const probes = parseProbes(run.stdout);
    expect(probes.map((p) => p.name))
      .not.toContain('写口令预检（DELETE 不存在的叶子）');

    // skip 必须**说清为什么**：skip 的三种原因措辞完全不同，
    // 「没给口令」被读成「口令被拒」就会指向完全不同的排查方向。
    for (const name of [
      'COPY 扩展名白名单（.exe）',
      'UNLOCK 缺 Lock-Token（RFC §9.11.1）',
      'Overwrite: F 撞已有目标（RFC §10.6）',
    ]) {
      const p = probes.find((x) => x.name === name);
      expect(p?.status, `${name} 应当是 skip`).toBe('skip');
      expect(p.detail).toContain('未提供 WRITE_TOKEN');
      expect(p.detail).not.toContain('凭据问题');
    }
  });

  test('B3｜站点完全不可达 → 结论是「连不上」且 strict 下 exit 1', async () => {
    const run = await runVerifyDeploy({
      url: 'http://127.0.0.1:1/', // 必然失败的地址：127.0.0.1:1 没有监听
      githubActions: 'true',
      strict: true,
    });

    // 「连不上」和「无法判定」的处置完全不同（前者查地址与网络，
    // 后者才轮到改配置），所以这条区别本身就是不变量
    expect(run.stdout).toContain('结论：**连不上 http://127.0.0.1:1**');
    expect(run.stdout).not.toContain('无法判定');
    expect(run.code).toBe(1);
    // 一条都没跑起来 —— 不是「跑了但不对」
    expect(parseProbes(run.stdout).every((p) => p.status === 'skip')).toBe(true);
    // 这个结局也有自己的 annotation（否则 CI 上只剩一句 exit code）
    expect(parseAnnotations(run.stdout).map((a) => a.title))
      .toEqual(['探针连不上目标站点']);
  });

  test('B4｜全部通过 → exit 0 且结论是「线上是新代码」', async () => {
    const run = await runVerifyDeploy({
      url: site.url,
      token: site.state.token,
      githubActions: 'true',
      strict: true,
    });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('结论：线上是**新代码**');
    const probes = parseProbes(run.stdout);
    expect(probes).toHaveLength(8);
    expect(probes.filter((p) => p.status !== 'pass')).toHaveLength(0);
    // 通过的那一轮不该有重试痕迹（有的话说明这次不是干净的单次通过）
    expect(run.stdout).not.toContain('靠重试才拿到响应');
    // 通过也不打 annotation —— 绿灯时打 error annotation 是噪音
    expect(parseAnnotations(run.stdout)).toHaveLength(0);
  });

  test('B5｜垃圾清理：每一条 PUT 出去的路径都被 DELETE 过，一个不漏', async () => {
    const run = await runVerifyDeploy({
      url: site.url,
      token: site.state.token,
      strict: true,
    });
    expect(run.code).toBe(0);

    const putNames = site.log.filter((e) => e.method === 'PUT')
      .map((e) => decodeURIComponent(e.path.slice(DAV_PREFIX.length)));
    const deleteNames = site.log.filter((e) => e.method === 'DELETE')
      .map((e) => decodeURIComponent(e.path.slice(DAV_PREFIX.length)));

    // 前置：这条场景真的写了东西（否则下面的断言是空集恒真）
    expect(putNames.length).toBeGreaterThan(0);

    // ★ 不变量：写探针在线上留不得垃圾。实测踩过 —— 一条命令让书库从 4 本
    //   变 8 本，多出来的 `__deploycheck_*` 只能手工清。
    const leftovers = putNames.filter((n) => !deleteNames.includes(n));
    expect(leftovers).toEqual([]);

    // 反向也不该有：删掉的东西必须是「确实写过的东西」，
    // 否则这条断言会掩盖 cleanup 删错了对象（COPY 的 .exe 目标从未 PUT 过，
    // 对它发 DELETE 是防御性清理，允许）。
    expect(deleteNames.length).toBeGreaterThanOrEqual(putNames.length);
  });
});