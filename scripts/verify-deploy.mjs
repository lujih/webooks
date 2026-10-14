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
 *   node scripts/verify-deploy.mjs --url https://你的域名 --strict
 *
 * `--strict` 时有任何一条不符合预期就 exit 1（供 CI 用）。
 *
 * ⚠️ 这个脚本会**往书库里写临时文件**（因为要测 PUT/COPY 的行为）。
 *   所以需要写口令才能跑；跑完它自己会清理。
 *   注意：这三条探针都需要书已经上架过 —— 没有书时 COPY/PUT 的行为
 *   与预期不同（会 404 或 415），脚本会把那种情况标为「无法判定」而不是
 *   「失败」。
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
 * 探针 1：COPY 到被禁扩展名 → 必须是 415
 *
 * 修复前 handleMoveCopy 完全绕过扩展名白名单，所以这里会 201 且真的入库。
 */
async function probeCopyWhitelist() {
  const src = `${TMP}_src.txt`;
  const dst = `${TMP}_inject.exe`;
  try {
    const put = await call('PUT', src, { body: 'probe' });
    if (put.status >= 400) {
      results.push({ name: 'COPY 扩展名白名单', status: 'skip', detail: `PUT 被拒(${put.status})，无法继续` });
      return;
    }
    await put.text();

    const cp = await call('COPY', src, { headers: { destination: `${DAV}/${dst}` } });
    const status = cp.status;
    await cp.text();

    results.push({
      name: 'COPY 扩展名白名单（.exe）',
      status: status === 415 ? 'pass' : 'fail',
      detail: `期望 415（新代码），实际 ${status}`,
    });

    await cleanup(dst);
    await cleanup(src);
  } catch (err) {
    results.push({ name: 'COPY 扩展名白名单', status: 'skip', detail: String(err.message || err) });
  }
}

/**
 * 探针 2：UNLOCK 不带 Lock-Token 头 → 必须是 400
 *
 * 修复前会「顺手释放该路径上的锁」并回 204。匿名 LOCK 端点 +
 * 无 token UNLOCK = 任何人都能释放别人的锁。
 */
async function probeUnlockNoToken() {
  const name = `${TMP}_lock.epub`;
  try {
    const put = await call('PUT', name, { body: 'probe' });
    if (put.status >= 400) {
      results.push({ name: 'UNLOCK 需要 token', status: 'skip', detail: `PUT 被拒(${put.status})` });
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
      name: 'UNLOCK 缺 Lock-Token（RFC §9.11.1）',
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
 */
async function probeOverwrite() {
  const src = `${TMP}_ov_src.txt`;
  const dst = `${TMP}_ov_dst.txt`;
  try {
    const p1 = await call('PUT', src, { body: 'probe-src' });
    if (p1.status >= 400) {
      results.push({ name: 'Overwrite 头', status: 'skip', detail: `PUT 源文件被拒(${p1.status})` });
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
      name: 'Overwrite: F 撞已有目标（RFC §9.8.3）',
      status: status === 412 ? 'pass' : 'fail',
      detail: `期望 412（新代码），实际 ${status}`,
    });

    await cleanup(dst);
    await cleanup(src);
  } catch (err) {
    results.push({ name: 'Overwrite 头', status: 'skip', detail: String(err.message || err) });
  }
}

const ICON = { pass: '✅', fail: '❌', skip: '➖' };

console.log(`线上版本验证：${SITE}`);
if (!TOKEN) {
  console.log('  ⚠️ 未设置 WRITE_TOKEN 环境变量 —— 探针会跳过（它需要写权限）');
  console.log('     设置后重跑：WRITE_TOKEN=xxx node scripts/verify-deploy.mjs --url …');
}
console.log('');

await probeCopyWhitelist();
await probeUnlockNoToken();
await probeOverwrite();

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