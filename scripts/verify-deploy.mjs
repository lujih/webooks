/**
 * 线上版本验证 —— 用**行为差异**判断线上跑的是不是新代码。
 *
 * 为什么不用「查版本号」：这个项目没有版本端点，加一个又会多一次请求预算
 * 和一处可能不同步的地方。
 *
 * 为什么不用「看 /health 返回 200」：health 端点在旧代码上也返回 200，
 * 它验证的是「服务活着」，不是「是新版本」。
 *
 * 所以这里挑了几条**修复前后的返回码完全不同**的请求：
 *
 *   行为                          修复前   修复后
 *   ────────────────────────────  ──────  ──────
 *   COPY 到 .exe                    201     415   扩展名白名单
 *   UNLOCK 不带 Lock-Token 头       204     400   RFC 4918 §9.11.1
 *   OVERWRITE:F 且目标已存在        201     412   RFC 4918 §10.6 + §8.1
 *   /favicon.ico                    404     200   由静态资源层服务
 *   未知路径（/wp-login.php 之类）   Worker  静态 404  不花请求配额
 *   浏览页书卡 href                 /dav/…  R2 直链   点下载不再花请求配额
 *
 * ⚠️ OVERWRITE 那条**没有口令时不能判 fail**：RFC 4918 §10.6 要求
 *    「The server MUST do authorization checks before checking this or any
 *    conditional header」，§8.1 更要求授权错误优先于其它错误（否则匿名者
 *    可以用「412 还是 201」探测目标位置有没有东西）。所以拿到 401 是
 *    规范行为 —— 缺口令时那条报 skip「无法判定」。
 *    详见下面 writeTokenState 处的说明（含「传错口令 ≠ 没传口令」那个坑）。
 *
 * 任一条返回「修复后的值」，就证明线上是新代码；返回「修复前的值」则说明
 * 部署没生效（或部署到了别的域名/别的 Worker）。
 *
 * 用法：
 *   node scripts/verify-deploy.mjs --url https://你的域名
 *   WRITE_TOKEN=xxx node scripts/verify-deploy.mjs --url https://你的域名
 *   WRITE_TOKEN=xxx node scripts/verify-deploy.mjs --url https://你的域名 --strict
 *
 * `--strict` 时有任何一条不符合预期就 exit 1（供 CI 用）。
 *
 * ⚠️ 写探针会**往书库里写临时文件**。而口令不可用时它们会全部跳过，
 *   原因是本库的设计不对称：PUT（新增）匿名可写，DELETE（删除）需要口令。
 *   于是那时的探针能造垃圾、却清不掉垃圾（实测：一条命令让书库从 4 本
 *   变 8 本，多出来的 `__deploycheck_*` 只能手工清）。
 *   所以现在的规矩是「跑了不能收场就不跑」—— 报「无法判定」而不是留垃圾。
 *
 * 需要的环境变量：
 *   WRITE_TOKEN  写口令。**必须与 Worker 上的 WRITE_TOKEN 一致**
 *                 （`npx wrangler secret put WRITE_TOKEN` 设的那个），
 *                 而且**不等于 ADMIN_TOKEN** —— 那是另一个密钥，拿它发
 *                 DELETE 一样是 401。缺失或被拒时三条写探针跳过，
 *                 其余探针照跑；被拒时会明确报「凭据配错」而不是
 *                 「线上是旧代码」（详见 writeTokenState 处）。
 */

/**
 * 取写口令。
 *
 * ⚠️ 破坏性操作与本脚本的探针都需要口令。**不要**把口令写进仓库，
 * 也不要用 query 参数传（会进日志）。只从环境变量读。
 */
function writeToken() {
  return process.env.WRITE_TOKEN || process.env.WEBDAV_WRITE_TOKEN || '';
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const SITE = (arg('--url', 'https://webooks.cszxorx.dpdns.org')).replace(/\/+$/, '');
const STRICT = process.argv.includes('--strict');
const TOKEN = writeToken();

/** 上传用的集合路径（中文段要编码） */
const COLLECTION = process.argv.includes('--collection')
  ? arg('--collection', '最近收录')
  : '最近收录';
const DAV = `${SITE}/dav/${encodeURIComponent(COLLECTION)}`;

const stamp = Date.now().toString(36);
const TMP = `__deploycheck_${stamp}`;

/** 三个探针的结果：pass=新代码 / fail=旧代码 / skip=无法判定 */
const results = [];

async function call(method, path, init = {}) {
  const headers = { ...(init.headers || {}) };
  if (TOKEN) headers['x-write-token'] = TOKEN;
  return fetch(`${DAV}/${path}`, { ...init, method, headers });
}

/** 清理：尽力而为，失败不影响结论 */
async function cleanup(name) {
  for (const method of ['UNLOCK', 'DELETE']) {
    try {
      await call(method, name, { headers: { 'lock-token': `<urn:uuid:cleanup>` } });
    } catch {
      /* 清理失败无所谓 */
    }
  }
}

/**
 * 写口令的**可用性**（不是「有没有传」）。
 *
 *   'absent'     —— 没传口令
 *   'unverified' —— 传了，还没预检
 *   'ok'         —— 预检通过，三条写探针可以跑
 *   'rejected'   —— 传了但服务端说不对
 *   'unknown'    —— 预检本身没跑成（网络/意外状态码）
 *
 * ## 判据不是「跑不跑得动」，而是「跑了能不能收场」
 *
 * ⚠️ 没有可用口令时**根本不能跑写探针** —— 它们会往真实书库里留下删不掉的
 * 垃圾。这是实测出来的，不是假想：在本地带真实 D1 的 `wrangler dev` 上跑一次
 * 缺口令的探针，书库从 4 本变成 8 本，多出来的全是 `__deploycheck_*`，
 * 而且**删不掉**。
 *
 * 成因是本库一个有意的设计不对称：
 *   · PUT（新增）匿名即可 —— 这是产品的核心诉求，不能为了探针让步
 *   · DELETE（删除）需要口令 —— 破坏性操作必须设防
 * 于是探针能造垃圾、却清不掉垃圾。cleanup() 里 DELETE 拿到 401 被
 * 静默吞掉（`catch {}` 是故意的「尽力而为」），垃圾就此留在库里。
 *
 * ## 为什么是状态机而不是一个布尔量
 *
 * 原来只有 `const CAN_WRITE = TOKEN.length > 0`，于是**传错口令**与**没传口令**
 * 在输出上完全无法区分（都表现为写探针失败）。这是真实踩出来的第四个缺陷：
 * CI 的 WRITE_TOKEN secret 是个无效值（填成了 ADMIN_TOKEN），探针因此稳定打印
 *     ❌ Overwrite: F 撞已有目标  期望 412（新代码），实际 401
 *     结论：线上仍是**旧代码**（1 项不符预期）
 * 于是「凭据配错了」被读成「代码没部署」，我去追了两轮才发现线上其实是
 * 新代码 —— 判据：修复前 COPY 撞已有目标必然 201 并破坏目标，根本不可能
 * 返回 401，能返 401 恰恰证明口令检查已上线。
 *
 * 教训：**报 skip 是诚实的，报 fail 是错的**。
 * 「拿这个口令什么都没验成」不等于「线上代码不对」。
 */
let writeTokenState = TOKEN.length > 0 ? 'unverified' : 'absent';

/** 写探针的守卫：口令不可用时直接记 skip，绝不落盘 */
function skipWriteProbe(name, detail) {
  results.push({ name, status: 'skip', detail });
  return false;
}

/** 三条写探针能不能跑 —— 必须**预检通过**，光「传了」不算 */
function canWrite() {
  return writeTokenState === 'ok';
}

/** skip 时要说清原因：读日志的人必须一眼分清凭据问题与代码问题 */
function writeGuardDetail() {
  if (writeTokenState === 'rejected') {
    return 'WRITE_TOKEN 被服务端拒绝（**凭据问题，不是代码问题**）—— 落盘后删不掉，跳过';
  }
  if (writeTokenState === 'unknown') {
    return '写口令预检没跑成，无法判定 —— 落盘后删不掉，跳过';
  }
  return '未提供 WRITE_TOKEN —— 落盘后删不掉，不留垃圾（见 writeTokenState 处说明）';
}

/**
 * 探针 0（预检）：**这个口令到底能不能用**
 *
 * 做法：拿一个**必然不存在**的叶子做 DELETE。
 *   口令有效 → 走到 handleDelete 的 findBookByLeaf 拿 null → 404
 *   口令无效 → 分发层的 hasWriteToken 先拦成 401
 *              （src/webdav/index.ts:121）
 * 这条请求不写任何东西，是最便宜也最安全的写口令探针。
 *
 * ⚠️ 路径必须落在**叶子上**（`/dav/<集合>/<名字>`，两段），不能是
 *    `/dav/<集合>/` —— 那会走「集合 DELETE 等价于 Depth: infinity」的
 *    分支，把整个集合连成员一起删掉。
 *
 * 结果不参与「线上是不是新代码」的判定（它验的是凭据不是代码），
 * 但它决定另外三条写探针是跑还是跳。
 */
async function probeWriteToken() {
  if (writeTokenState === 'absent') return;
  try {
    const res = await call('DELETE', `${TMP}_tokencheck.txt`);
    await res.text();
    if (res.status === 404) {
      writeTokenState = 'ok';
      return;
    }
    if (res.status === 401 || res.status === 403) {
      writeTokenState = 'rejected';
      results.push({
        name: '写口令预检（DELETE 不存在的叶子）',
        status: 'fail',
        // 打上标记：这个 fail 是**凭据问题**，不该被算进「线上是不是新代码」
        // 的判定里（见结论区 credentialFail 分支）。
        kind: 'credential',
        detail: `${res.status} —— WRITE_TOKEN 被服务端拒绝。**这是凭据问题，不是代码问题**：`
          + 'CI 的 secret 与 Worker 上的 WRITE_TOKEN 不是同一个值'
          + '（顺带提醒：ADMIN_TOKEN 不能当写口令用，两者是独立的密钥）',
      });
      return;
    }
    writeTokenState = 'unknown';
    results.push({
      name: '写口令预检（DELETE 不存在的叶子）',
      status: 'skip',
      detail: `期望 404 或 401，实际 ${res.status} —— 无法判定口令是否可用`,
    });
  } catch (err) {
    writeTokenState = 'unknown';
    results.push({
      name: '写口令预检（DELETE 不存在的叶子）',
      status: 'skip',
      detail: String(err.message || err),
    });
  }
}

/**
 * 探针 1：COPY 到被禁扩展名 → 必须是 415
 *
 * 修复前 handleMoveCopy 完全绕过扩展名白名单，所以这里会 201 且真的入库。
 */
async function probeCopyWhitelist() {
  const NAME = 'COPY 扩展名白名单（.exe）';
  if (!canWrite()) {
    skipWriteProbe(NAME, writeGuardDetail());
    return;
  }
  const src = `${TMP}_src.txt`;
  const dst = `${TMP}_inject.exe`;
  try {
    const put = await call('PUT', src, { body: 'probe' });
    if (put.status >= 400) {
      results.push({ name: NAME, status: 'skip', detail: `PUT 被拒(${put.status})，无法继续` });
      return;
    }
    await put.text();

    const cp = await call('COPY', src, { headers: { destination: `${DAV}/${dst}` } });
    const status = cp.status;
    await cp.text();

    results.push({
      name: NAME,
      status: status === 415 ? 'pass' : 'fail',
      detail: `期望 415（新代码），实际 ${status}`,
    });

    await cleanup(dst);
    await cleanup(src);
  } catch (err) {
    results.push({ name: NAME, status: 'skip', detail: String(err.message || err) });
  }
}

/**
 * 探针 2：UNLOCK 不带 Lock-Token 头 → 必须是 400
 *
 * 修复前会「顺手释放该路径上的锁」并回 204。匿名 LOCK 端点 +
 * 无 token UNLOCK = 任何人都能释放别人的锁。
 */
async function probeUnlockNoToken() {
  const NAME = 'UNLOCK 缺 Lock-Token（RFC §9.11.1）';
  if (!canWrite()) {
    skipWriteProbe(NAME, writeGuardDetail());
    return;
  }
  const name = `${TMP}_lock.epub`;
  try {
    const put = await call('PUT', name, { body: 'probe' });
    if (put.status >= 400) {
      results.push({ name: NAME, status: 'skip', detail: `PUT 被拒(${put.status})` });
      return;
    }
    await put.text();

    const lock = await call('LOCK', name, {
      headers: { 'content-type': 'application/xml', timeout: 'Second-30' },
      body:
        '<?xml version="1.0" encoding="utf-8" ?>'
        + '<D:lockinfo xmlns:D="DAV:">'
        + '<D:lockscope><D:exclusive/></D:lockscope>'
        + '<D:locktype><D:write/></D:locktype>'
        + '</D:lockinfo>',
    });
    const token = lock.headers.get('lock-token');
    await lock.text();

    const un = await call('UNLOCK', name);
    const status = un.status;
    await un.text();

    results.push({
      name: NAME,
      status: status === 400 ? 'pass' : 'fail',
      detail: `期望 400（新代码），实际 ${status}`,
    });

    // 解锁 + 删除，别把临时文件留在书库里
    if (token) {
      const rel = await call('UNLOCK', name, { headers: { 'lock-token': token } });
      await rel.text().catch(() => {});
    }
    await cleanup(name);
  } catch (err) {
    results.push({ name: 'UNLOCK 需要 token', status: 'skip', detail: String(err.message || err) });
  }
}

/**
 * 探针 3：Overwrite: F 且目标已存在 → 必须是 412
 *
 * 修复前 handleMoveCopy 完全不读 Overwrite 头，所以必然 201 并破坏目标。
 *
 * ⚠️ 必须有**可用**口令才跑，两个理由：
 *
 * ① 缺口令时**无法判定**，且报 fail 是错的 —— 这是线上踩出来的：
 *    CI 的 verify-live job 一开始在**代码完全正确**的部署上稳定打印
 *    `❌ 实际 401` + `结论：线上仍是旧代码`，一次交付被自己的门卫判成
 *    假阴性，差点让我去追一个不存在的 bug。当时的原因有两层：
 *      · 第一版：CI 根本没传 WRITE_TOKEN
 *      · 第二版：CI 传了，但填的是 ADMIN_TOKEN（无效值）—— 于是
 *        「传错口令」和「没传口令」在输出上无法区分，两版都栽在这里。
 *    现在由探针 0（口令预检）把这两件事分开。
 *
 *    401 在这里是**规范要求**，不是缺陷。RFC 4918 §10.6：
 *      「The server MUST do authorization checks before checking this or
 *        any conditional header.」
 *    §8.1 进一步要求「MUST return authorization errors in preference to
 *    other errors」—— 理由正是本站在意的那件事：不要用「412 还是 201」
 *    向匿名者泄露「目标位置是否已有资源」。所以覆盖已存在目标时，
 *    无口令必须 401，有口令才轮到 412 出场。
 *
 * ② 它会落盘（PUT src + dst），而口令不可用时删不掉 —— 见 writeTokenState 处。
 */
async function probeOverwrite() {
  const NAME = 'Overwrite: F 撞已有目标（RFC §10.6）';
  if (!canWrite()) {
    skipWriteProbe(NAME, writeGuardDetail());
    return;
  }
  const src = `${TMP}_ov_src.txt`;
  const dst = `${TMP}_ov_dst.txt`;
  try {
    const p1 = await call('PUT', src, { body: 'probe-src' });
    if (p1.status >= 400) {
      results.push({ name: NAME, status: 'skip', detail: `PUT 源文件被拒(${p1.status})` });
      return;
    }
    await p1.text();
    const p2 = await call('PUT', dst, { body: 'probe-dst' });
    await p2.text();

    const cp = await call('COPY', src, {
      headers: { destination: `${DAV}/${dst}`, overwrite: 'F' },
    });
    const status = cp.status;
    await cp.text();

    results.push({
      name: NAME,
      status: status === 412 ? 'pass' : 'fail',
      detail: `期望 412（新代码），实际 ${status}`,
    });

    await cleanup(dst);
    await cleanup(src);
  } catch (err) {
    results.push({ name: NAME, status: 'skip', detail: String(err.message || err) });
  }
}

/**
 * 探针 4：静态资源层是否真的上线了。
 *
 * 期望：/favicon.ico → 200 且 content-type 是图标
 * 修复前：404 text/plain（而且**每次页面浏览**都白花一次 Worker 请求）
 *
 * 判据特意不只看状态码，还看 content-type —— Worker 的兜底 404 也是
 * 200/404 之类的整数，光看码分不清「静态层在服务」还是「Worker 说没有」。
 */
async function probeStaticFavicon() {
  try {
    const res = await fetch(`${SITE}/favicon.ico`);
    const ct = res.headers.get('content-type') || '';
    const cc = res.headers.get('cache-control') || '';
    const body = new Uint8Array(await res.arrayBuffer());
    // PNG 魔数（本项目用 PNG 内嵌 ICO）或 ICO 头（00 00 01 00）
    const isIco = body.length > 4
      && ((body[0] === 0x89 && body[1] === 0x50) || (body[0] === 0 && body[1] === 0 && body[2] === 1));

    results.push({
      name: '/favicon.ico 由静态层服务',
      status: res.status === 200 && isIco ? 'pass' : 'fail',
      detail: res.status === 404
        ? '404 —— public/ 没上传（静态资源优化未生效，每次浏览白花一次请求）'
        : `期望 200 + 图标字节，实际 ${res.status} ${ct} ${body.length}B`,
    });

    // _headers 里的 Cache-Control 是否真的被应用了。
    // 默认头是 `public, max-age=0, must-revalidate`，我们在 _headers 里
    // 改成了 max-age=604800 —— 值不一样才说明 _headers 被解析了。
    if (res.status === 200) {
      results.push({
        name: '_headers 规则生效（favicon）',
        status: cc.includes('604800') ? 'pass' : 'fail',
        detail: cc.includes('604800')
          ? cc
          : `期望 max-age=604800（_headers 生效），实际 "${cc}"（可能是默认头）`,
      });
    }
  } catch (err) {
    results.push({ name: '静态资源层', status: 'skip', detail: String(err.message || err) });
  }
}

/**
 * 探针 5：★ 最关键的一条 ★ —— 真人浏览器能不能打开 Worker 路由。
 *
 * 这条是给一个**真实踩过的坑**立的哨兵：
 *
 *   `assets.not_found_handling: "404-page"` 时，只要请求带
 *   `Sec-Fetch-Mode: navigate`（真实浏览器每次顶层导航都会带，curl 不带），
 *   `/`、`/upload`、`/requests`、`/admin`、`/dav/` **全部**被静态 404 页吃掉。
 *
 *   于是 curl 冒烟测试全绿，真人打开全是 404 —— 最恶劣的那种「测试通过但
 *   线上是坏的」。这就是为什么这里必须**带着 navigate 头**发请求。
 *
 * 判据：带 navigate 头时，这几条路径必须仍返回 Worker 的 HTML。
 * Worker 的 HTML 一定带 `content-security-policy`（withSecurityHeaders 加的），
 * 而静态 404 页不会带 —— 用头区分，而不是用状态码（两边都是 200/404）。
 */
async function probeWorkerRoutesWithNavigateHeader() {
  const NAV = {
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  };
  // 含带尾斜杠的形式：实测 `/x/*` **不匹配** `/x` 本身，漏在
  // run_worker_first 里的话这些路径会吃静态 404。
  const routes = ['/', '/upload', '/requests', '/upload/', '/requests/', '/admin/', '/dav/'];
  try {
    const bad = [];
    for (const path of routes) {
      const res = await fetch(`${SITE}${path}`, { headers: NAV });
      const csp = res.headers.get('content-security-policy');
      const body = await res.text();
      // 成功判据：有 CSP（=Worker 生成的 HTML）且正文里有本站的 <title>
      const ok = res.status === 200 && !!csp && /<title>/.test(body);
      if (!ok) bad.push(`${path}→${res.status}${csp ? '' : '(无CSP=静态层抢答)'}`);
      else await res.arrayBuffer().catch(() => {});
    }
    results.push({
      name: '浏览器导航头下 Worker 路由仍可达',
      status: bad.length === 0 ? 'pass' : 'fail',
      detail: bad.length === 0
        ? `${routes.length} 条路由带 sec-fetch-mode:navigate 均正常`
        : `❌ 被静态层抢答：${bad.join(' ')} —— 检查 wrangler.jsonc 的 run_worker_first 是否漏了这条路径`,
    });
  } catch (err) {
    results.push({ name: '浏览器导航头探测', status: 'skip', detail: String(err.message || err) });
  }
}

/**
 * 探针 6：**未知路径必须由静态 404 页应答**（免费），而不是 Worker 的文本 404
 *
 * 这才是省请求的那一半。扫描器打过来的不存在的路径数量不受本站控制
 * （/wp-login.php、/.env、/administrator…），每一条在 Worker 应答时就是一
 * 次配额。两个条件共同决定它免费：`not_found_handling: "404-page"` 叫它
 * 不调 Worker，`run_worker_first` 只列真路由、没把 `*` 之类的也揽进来。
 *
 * ⚠️ 必须带**浏览器导航头**。`not_found_handling` 对
 * `Sec-Fetch-Mode: navigate` 的行为**不一样**（miniflare 里那条 flag 叫
 * SEC_FETCH_MODE_NAVIGATE_HEADER_PREFERS_ASSET_SERVING，本仓库的
 * compatibility_date 之后默认开启）。纯 curl 测会假绿 —— 曾经配了
 * "404-page" 却漏掉 run_worker_first，curl 看到的是正常 Worker 路由，
 * 而真人浏览器看到的是整站 404。
 *
 * 判据不只看状态码（Worker 的兜底 404 也是 404），要区分正文：
 *   · 静态 404 页 = public/404.html，有本站排版（含「没有这一页」）
 *   · Worker 的 404 = 纯文本 `Not Found`
 */
async function probeUnknownPathIsStatic404() {
  const NAV = {
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  };
  const path = `/${TMP}_nope`;
  try {
    const res = await fetch(`${SITE}${path}`, { headers: NAV });
    const body = await res.text();
    const isStaticPage = res.status === 404 && /没有这一页/.test(body);
    const isWorkerText = body.trim() === 'Not Found';
    results.push({
      name: '未知路径由静态 404 应答（不花请求）',
      status: isStaticPage ? 'pass' : 'fail',
      detail: isStaticPage
        ? '404 + public/404.html（免费，未调用 Worker）'
        : isWorkerText
          ? '404 但正文是 Worker 的文本 "Not Found" —— 未知路径仍在花配额，检查 not_found_handling 是不是 "none"'
          : `${res.status}，正文 ${body.length}B 既不像 public/404.html 也不像 Worker 文本`,
    });
  } catch (err) {
    results.push({ name: '未知路径静态 404', status: 'skip', detail: String(err.message || err) });
  }
}

/**
 * 探针 7：**浏览页的书卡必须直链 R2**（点一次下载不再花一次 Worker 请求）
 *
 * 这是给一条真实存在的浪费立的哨兵：
 *
 *   以前书卡 href 是 `/dav/最近收录/搜神记.epub`，点它会撞上 Worker 的
 *   302（响应头写死 `cache-control: no-store`）→ 跳 R2。于是**每点开一本
 *   书就消耗一次请求配额**，而下载的字节本来完全不必经过 Worker。
 *
 *   现在 href 直接是 `${r2PublicBase}/books/<id>`，请求根本不进 Worker。
 *
 * 判据分三层，缺一层就可能假绿：
 *   ① 目录页里确实有书卡（没有书就无从验证 —— 报 skip 而不是 pass）
 *   ② 书卡的 href 是 http(s) **绝对地址**（相对路径一律 fail：`/dav/…` 是
 *      没改，`""` 或 `undefined` 是拼坏了，两种都不能放过）
 *   ③ 那个绝对地址真的能拿到书（200/206 + 非 text/html），
 *      否则可能只是 href 拼错了 —— 「拼错」和「直链」在 ①② 下看起来一样
 */
async function probeBookCardsLinkDirectToR2() {
  const NAME = '书卡直链 R2（不再经 Worker）';
  try {
    const res = await fetch(`${DAV}/`, { headers: { accept: 'text/html' } });
    const html = await res.text();
    if (res.status !== 200) {
      results.push({ name: NAME, status: 'skip', detail: `目录页 ${res.status}，无法判定` });
      return;
    }
    // 书卡的 class 是 bookcard（集合卡是 shelfcard，两者都必须区分开）
    const cards = [...html.matchAll(/<a class="card bookcard" href="([^"]+)"/g)].map((m) => m[1]);
    if (cards.length === 0) {
      results.push({ name: NAME, status: 'skip', detail: '这个集合里没有书，无法判定' });
      return;
    }
    // ② 必须是绝对 URL。只断言「不以 /dav/ 开头」是不够的 —— 空的 href、
    //    或者渲染失败留下的 `href="undefined"` 都是**相对路径**，同样不以
    //    /dav/ 开头，却会让点击 404（前者还等于没链接）。这里要求 http(s)
    //    绝对地址，顺带把「直链指向另一个域名」这种错配也挡在外面。
    //
    //    顺序：先挑出 `/dav/` 再挑「不是绝对地址」。两种都是 fail，但
    //    `/dav/` 那条的提示更准确（它说的是「还在花配额」），而 `/dav/` 也
    //    同样不匹配 http(s)，先判相对地址会把这条诊断吞掉。
    const viaWorker = cards.filter((h) => h.startsWith('/dav/'));
    if (viaWorker.length > 0) {
      results.push({
        name: NAME,
        status: 'fail',
        detail: `${cards.length} 张书卡里有 ${viaWorker.length} 张仍走 /dav/（例：${viaWorker[0]}）`
          + ' —— 每次点开一本书仍在花请求配额',
      });
      return;
    }
    const relative = cards.filter((h) => !/^https?:\/\//i.test(h));
    if (relative.length > 0) {
      results.push({
        name: NAME,
        status: 'fail',
        detail: `${cards.length} 张书卡里有 ${relative.length} 张**不是绝对地址**（例：${JSON.stringify(relative[0])}）`
          + ' —— 直链没拼出来，点击会 404 或跳到错误的位置',
      });
      return;
    }
    // ③ 真去取一本：href 拼错的话这里会拿到 404
    const probe = cards[0];
    const book = await fetch(probe, { method: 'HEAD' });
    const ct = book.headers.get('content-type') || '';
    const cd = book.headers.get('content-disposition') || '';
    // R2 公开域对 HEAD 返回 200；带 Range 时是 206。两者都算通。
    const ok = (book.status === 200 || book.status === 206) && !ct.startsWith('text/html');
    results.push({
      name: NAME,
      status: ok ? 'pass' : 'fail',
      detail: ok
        ? `${cards.length} 张书卡全指向 R2 直链，抽查 ${book.status} ${ct}`
          + (cd ? `，content-disposition 已设置` : '，⚠️ 缺 content-disposition（文件名会是无扩展名的 id）')
        : `${cards.length} 张书卡是直链，但抽查取不到书：${book.status} ${ct} —— href 可能拼错了`
          + `（例：${probe}）`,
    });
  } catch (err) {
    results.push({ name: NAME, status: 'skip', detail: String(err.message || err) });
  }
}

const ICON = { pass: '✅', fail: '❌', skip: '➖' };

console.log(`线上版本验证：${SITE}`);
if (writeTokenState === 'absent') {
  console.log('  ⚠️ 未设置 WRITE_TOKEN 环境变量');
  console.log('     三条写探针会跳过：本库 PUT 匿名可写、DELETE 需要口令，');
  console.log('     所以缺口令时探针能造垃圾却清不掉 —— 宁可不测，也不留垃圾。');
  console.log('     拿到结论：WRITE_TOKEN=xxx node scripts/verify-deploy.mjs --url …');
}
console.log('');

// 先预检口令：不可用就别让三条写探针各自报一次「期望 412 实际 401」，
// 那种输出会被读成「代码没部署」，而真实原因是凭据配错了。
await probeWriteToken();
await probeCopyWhitelist();
await probeUnlockNoToken();
await probeOverwrite();
// 静态资源层与「浏览器导航头下 Worker 路由是否仍可达」不需要写口令，
// 所以放在最后：前三条要口令的探针若被跳过，这两条仍然会给出结论。
await probeStaticFavicon();
await probeWorkerRoutesWithNavigateHeader();
await probeUnknownPathIsStatic404();
await probeBookCardsLinkDirectToR2();

let fail = 0;
let pass = 0;
let skip = 0;
// 凭据类失败单独计：它证明不了线上代码是新的，但也**证伪不了** ——
// 分不清这两件事正是第四个缺陷的根源（见 writeTokenState 处说明）。
let credentialFail = 0;
for (const r of results) {
  console.log(`  ${ICON[r.status]} ${r.name.padEnd(42)} ${r.detail}`);
  if (r.status === 'pass') pass++;
  else if (r.status === 'fail') {
    if (r.kind === 'credential') credentialFail++;
    else fail++;
  } else skip++;
}

console.log('');
if (fail > 0) {
  console.log(`  结论：线上仍是**旧代码**（${fail} 项不符预期）`);
  console.log('');
  console.log('  可能原因：');
  console.log('    · 部署 job 被跳过（没配 CLOUDFLARE_API_TOKEN / ACCOUNT_ID）');
  console.log('    · 部署到了另一个 Worker / 另一个域名');
  console.log('    · 部署失败但 CI 没把它标红（看 Actions 页面的日志）');
  console.log('    · 边缘缓存还没更新（等几十秒重跑本脚本）');
  process.exit(STRICT ? 1 : 0);
}
if (credentialFail > 0) {
  // ① 故意不打印「线上仍是旧代码」：那是错的结论，而且会把人引向不存在的问题。
  // ② 但**照样 exit 1**（--strict 下）：红在这里表示「本轮验证没做完」，
  //    不是「部署坏了」。绿灯才危险 —— 探针里有一条不跑却说「已验证通过」，
  //    正是这个项目反复在打的假绿（见 deploy.yml 里那句「一个不会失败的
  //    门卫比没有门卫更糟」）。三条写探针没跑就是没验到，如实报出来。
  //    deploy job 在 `needs.deploy.result == 'success'` 里独立判过部署，
  //    这里的红只针对「验证未完成」。
  console.log(`  结论：**凭据配错**，写探针一条都没验成（${credentialFail} 项）`);
  console.log('');
  console.log('  ⚠️ 这不是代码问题 —— 部署本身可能是好的，只是本轮验证没做完。');
  console.log('     CI 的 WRITE_TOKEN secret 必须与 Worker 上的 WRITE_TOKEN 一致：');
  console.log('       npx wrangler secret put WRITE_TOKEN');
  console.log('     ⚠️ ADMIN_TOKEN 不能当写口令用 —— 两者是各自独立的密钥，');
  console.log('        拿管理口令发 DELETE 一样是 401。');
  console.log('     订正 secret 后重跑：GitHub → Settings → Secrets → Actions。');
  // 打 error annotation：Actions 页面上一眼能看到，不必翻日志才知道是配置问题。
  if (typeof process !== 'undefined' && process.env.GITHUB_ACTIONS === 'true') {
    console.log('::error title=写口令预检失败（凭据问题，不是代码问题）::'
      + 'WRITE_TOKEN 与 Worker 上的值不一致，或误填了 ADMIN_TOKEN。'
      + '三条写探针本轮未运行，其余探针的结论仍然有效。订正后重跑本 job。');
  }
  process.exit(STRICT ? 1 : 0);
}
if (pass > 0) {
  console.log(`  结论：线上是**新代码**（${pass} 项通过）`);
  process.exit(0);
}

// 到这里：没有 fail（否则上面就退出了）、没有 pass。可能是全部被跳过，
// 也可能是 skip 混着 pass —— 但 pass 已经在上面处理掉了，所以此刻
// 一定是一项都没验成。
//
// ⚠️ 这里曾经印「无法判定（所有探针都被跳过）」就 exit 1，而那正是
// **WORKER_URL 配错时的输出**：所有探针都 fetch failed → 全 skip →
// 一句「无法判定」把「地址根本不通」说成了「没什么可验的」。这两种
// 情况的处置完全相反（一个要改仓库变量，一个要改代码），不能混。
//
// 所以先分辨：是「站点压根没连上」还是「连上了但没东西可验」。
const siteDown = skip > 0 && results.every((r) => r.status !== 'pass' && r.status !== 'fail');
if (siteDown) {
  console.log(`  结论：**连不上 ${SITE}** —— ${skip} 条探针全部没能取到任何响应`);
  console.log('');
  console.log('  ⚠️ 这不是代码问题：一条探针都没跑起来，验不到任何东西。');
  console.log('     最常见的原因是 `--url`（CI 里是仓库变量 WORKER_URL）');
  console.log('     指向了一个不存在的地址。Worker 的 workers.dev 子域是');
  console.log('     <worker 名>.<账户子域>.workers.dev，不等于自定义域；');
  console.log('     域名不存在时 DNS 会给一个通配地址，连接直接超时而不是 404，');
  console.log('     于是症状是「每条探针 fetch failed」而不是「探针报 fail」。');
  console.log('     先确认这个地址能打开：curl -m 20 -o /dev/null -w "%{http_code}" <地址>/health');
  console.log('     订正后重跑本 job。');
  if (typeof process !== 'undefined' && process.env.GITHUB_ACTIONS === 'true') {
    console.log('::error title=探针连不上目标站点::'
      + `${SITE} 无法访问，${skip} 条探针全部未运行，本轮没有验证任何东西。`
      + '请检查仓库变量 WORKER_URL 是否指向了正确的自定义域。');
  }
} else {
  console.log('  结论：无法判定（探针全部跳过，没有一条跑起来）');
}
process.exit(STRICT ? 1 : 0);