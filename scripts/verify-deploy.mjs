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
 *   OVERWRITE:F 且目标已存在        201     412   RFC 4918 §9.8.3
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
 * ⚠️ 写探针会**往书库里写临时文件**。而没有 WRITE_TOKEN 时它们会全部跳过，
 *   原因是本库的设计不对称：PUT（新增）匿名可写，DELETE（删除）需要口令。
 *   于是缺口令的探针能造垃圾、却清不掉垃圾（实测：一条命令让书库从 4 本
 *   变 8 本，多出来的 `__deploycheck_*` 只能手工清）。
 *   所以现在的规矩是「跑了不能收场就不跑」—— 报「无法判定」而不是留垃圾。
 *   配置 CI 时请把 WRITE_TOKEN 传进来，否则这三条探针永远拿不到结论。
 *
 * 需要的环境变量：
 *   WRITE_TOKEN  写口令。缺失时三条写探针跳过（其余两条静态层探针照跑）。
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
 * ⚠️ 没有口令时**根本不能跑写探针** —— 它们会往真实书库里留下删不掉的垃圾。
 *
 * 这是实测出来的，不是假想：在本地带真实 D1 的 `wrangler dev` 上跑一次
 * 不带 WRITE_TOKEN 的探针，书库从 4 本变成 8 本，多出来的全是
 * `__deploycheck_*` 文件，而且**删不掉**。
 *
 * 成因是本库一个有意的设计不对称：
 *   · PUT（新增）匿名即可 —— 这是产品的核心诉求，不能为了探针让步
 *   · DELETE（删除）需要口令 —— 破坏性操作必须设防
 * 于是探针能造垃圾、却清不掉垃圾。cleanup() 里 DELETE 拿到 401 被
 * 静默吞掉（`catch {}` 是故意的「尽力而为」），垃圾就此留在库里。
 *
 * 所以这里改成**直接不写**：判据不是「跑不跑得动」，而是「跑了能不能收场」。
 * 三条写探针都需要口令，缺口令时统一报「无法判定」并把原因说清楚 ——
 * 报 skip 是诚实的（真的没测），比造一堆垃圾去换一个结论好得多。
 */
const CAN_WRITE = TOKEN.length > 0;

/** 写探针的守卫：无口令时直接记 skip，绝不落盘 */
function skipWriteProbe(name, detail) {
  results.push({ name, status: 'skip', detail });
  return false;
}

/**
 * 探针 1：COPY 到被禁扩展名 → 必须是 415
 *
 * 修复前 handleMoveCopy 完全绕过扩展名白名单，所以这里会 201 且真的入库。
 */
async function probeCopyWhitelist() {
  const NAME = 'COPY 扩展名白名单（.exe）';
  if (!CAN_WRITE) {
    skipWriteProbe(NAME, '未提供 WRITE_TOKEN —— 落盘后删不掉，不留垃圾（见 CAN_WRITE 处说明）');
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
  if (!CAN_WRITE) {
    skipWriteProbe(NAME, '未提供 WRITE_TOKEN —— 落盘后删不掉，不留垃圾（见 CAN_WRITE 处说明）');
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
 * ⚠️ 必须带口令才跑，两个理由：
 *
 * ① 不带口令时**无法判定**，且报 fail 是错的 —— 这是线上踩出来的：
 *    CI 的 verify-live job 只传 `--url` 不传 WRITE_TOKEN（见 deploy.yml），
 *    于是它在**代码完全正确**的部署上稳定打印
 *    `❌ 实际 401` + `结论：线上仍是旧代码`，一次交付被自己的门卫判成
 *    假阴性，差点让我去追一个不存在的 bug。
 *
 *    401 在这里是**规范要求**，不是缺陷。RFC 4918 §10.6：
 *      「The server MUST do authorization checks before checking this or
 *        any conditional header.」
 *    §8.1 进一步要求「MUST return authorization errors in preference to
 *    other errors」—— 理由正是本站在意的那件事：不要用「412 还是 201」
 *    向匿名者泄露「目标位置是否已有资源」。所以覆盖已存在目标时，
 *    无口令必须 401，有口令才轮到 412 出场。
 *
 * ② 它会落盘（PUT src + dst），而无口令时删不掉 —— 见 CAN_WRITE 处的说明。
 */
async function probeOverwrite() {
  const NAME = 'Overwrite: F 撞已有目标（RFC §9.8.3）';
  if (!CAN_WRITE) {
    skipWriteProbe(NAME, '未提供 WRITE_TOKEN —— 无口令时服务端按 RFC §8.1 先拒授权，且落盘后删不掉');
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
  const routes = ['/', '/upload', '/requests'];
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
        : `❌ 被静态层抢答：${bad.join(' ')} —— 检查 not_found_handling 是不是被改成了 "404-page"`,
    });
  } catch (err) {
    results.push({ name: '浏览器导航头探测', status: 'skip', detail: String(err.message || err) });
  }
}

const ICON = { pass: '✅', fail: '❌', skip: '➖' };

console.log(`线上版本验证：${SITE}`);
if (!CAN_WRITE) {
  console.log('  ⚠️ 未设置 WRITE_TOKEN 环境变量');
  console.log('     三条写探针会跳过：本库 PUT 匿名可写、DELETE 需要口令，');
  console.log('     所以缺口令时探针能造垃圾却清不掉 —— 宁可不测，也不留垃圾。');
  console.log('     拿到结论：WRITE_TOKEN=xxx node scripts/verify-deploy.mjs --url …');
}
console.log('');

await probeCopyWhitelist();
await probeUnlockNoToken();
await probeOverwrite();
// 静态资源层与「浏览器导航头下 Worker 路由是否仍可达」不需要写口令，
// 所以放在最后：前三条要口令的探针若被跳过，这两条仍然会给出结论。
await probeStaticFavicon();
await probeWorkerRoutesWithNavigateHeader();

let fail = 0;
let pass = 0;
let skip = 0;
for (const r of results) {
  console.log(`  ${ICON[r.status]} ${r.name.padEnd(42)} ${r.detail}`);
  if (r.status === 'pass') pass++;
  else if (r.status === 'fail') fail++;
  else skip++;
}

console.log('');
if (pass > 0 && fail === 0) {
  console.log(`  结论：线上是**新代码**（${pass} 项通过）`);
  process.exit(STRICT ? 0 : 0);
}
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
console.log('  结论：无法判定（所有探针都被跳过）');
process.exit(STRICT ? 1 : 0);