#!/usr/bin/env node
/**
 * WebDAV 一致性 / 边缘行为探针。
 *
 * 为什么不用 litmus 就够：litmus 是 C 程序，Windows 上要 autotools + gcc。
 * 这个脚本覆盖 litmus `basic` / `props` 套件的核心检查 PLUS 三个 litmus 覆盖不到、
 * 但对 Cloudflare 部署最关键的点：
 *
 *   1. 自定义动词是否被边缘放行（区分「源站按设计拒绝」和「边缘拦截」）
 *   2. Depth:infinity 的真实处理方式
 *   3. Expect: 100-continue —— 用原始套接字发，因为 fetch 会自己处理掉这个握手。
 *      这正是 r2-webdav 的 litmus `http` 套件挂掉的那个点。
 *
 * 用法：
 *   node scripts/dav-probe.mjs --url https://example.com/dav/
 *   node scripts/dav-probe.mjs --url https://example.com/dav/ --user u --pass p
 *   DAV_URL=https://example.com/dav/ node scripts/dav-probe.mjs
 *
 * 退出码：0 = 没有硬失败；1 = 有 FAIL。
 * 「按设计拒绝」（如 LOCK 返回 501）记为 INFO，不算失败。
 */

import { setTimeout as sleep } from 'node:timers/promises';
import tls from 'node:tls';
import net from 'node:net';

// ── 参数 ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {
    url: process.env.DAV_URL ?? '',
    user: process.env.DAV_USER ?? '',
    pass: process.env.DAV_PASS ?? '',
    timeout: 20000,
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--url') out.url = v ?? '';
    else if (k === '--user') out.user = v ?? '';
    else if (k === '--pass') out.pass = v ?? '';
    else if (k === '--timeout') out.timeout = Number(v) || 20000;
  }
  if (!out.url) {
    console.error('缺少 --url（或环境变量 DAV_URL）。示例：');
    console.error('  node scripts/dav-probe.mjs --url https://example.com/dav/');
    process.exit(2);
  }
  if (!out.url.endsWith('/')) out.url += '/';
  return out;
}

const args = parseArgs(process.argv);
const authHeader =
  args.user || args.pass
    ? `Basic ${Buffer.from(`${args.user}:${args.pass}`).toString('base64')}`
    : null;

// ── 探针框架 ──────────────────────────────────────────────────────────

const results = [];
const record = (group, name, status, detail = '') => {
  results.push({ group, name, status, detail });
};

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', red: '\x1b[31m',
  green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};
const ICON = { pass: '✅', fail: '❌', info: 'ℹ️ ', warn: '⚠️ ', skip: '⏭️ ' };
const COLOR = { pass: C.green, fail: C.red, info: C.dim, warn: C.yellow, skip: C.dim };

async function req(path, init = {}) {
  const url = new URL(path.replace(/^\//, ''), args.url).toString();
  const headers = new Headers(init.headers ?? {});
  if (authHeader && !headers.has('authorization')) headers.set('authorization', authHeader);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeout);
  try {
    return await fetch(url, { ...init, headers, signal: controller.signal, redirect: 'manual' });
  } finally {
    clearTimeout(timer);
  }
}

/** 判断响应是否来自我们的 Worker，而不是 Cloudflare 边缘的拦截页 */
function originReached(res, body) {
  const allow = res.headers.get('allow') ?? '';
  if (allow.includes('PROPFIND')) return true;
  if (res.headers.get('dav')) return true;
  // Worker 自己加的标记头（PROPFIND 的 207 响应没有 Allow/DAV 头，只能靠这个认）
  if (res.headers.get('x-dav-entries') !== null) return true;
  if (res.headers.get('x-dav-cache') !== null) return true;
  const text = (body ?? '').slice(0, 800);
  if (/<D:multistatus/.test(text)) return true;
  if (/Collections are virtual|not implemented|Properties are read-only|Not Found/i.test(text)) return true;
  return false;
}

function countResponses(xml) {
  return (xml.match(/<D:response>/g) ?? []).length;
}

function hrefs(xml) {
  return [...xml.matchAll(/<D:href>([^<]*)<\/D:href>/g)].map((m) => m[1]);
}

function hasStatus(xml, code) {
  return new RegExp(`<D:status>[^<]*${code}[^<]*</D:status>`).test(xml);
}

// ── A. 动词放行 ───────────────────────────────────────────────────────

async function probeVerbs() {
  const verbs = ['OPTIONS', 'PROPFIND', 'PROPPATCH', 'MKCOL', 'COPY', 'MOVE', 'LOCK', 'UNLOCK', 'DELETE', 'PUT'];
  const blocked = [];

  for (const verb of verbs) {
    let res;
    let body = '';
    try {
      res = await req('./', { method: verb });
      body = await res.text().catch(() => '');
    } catch (err) {
      record('动词放行', verb, 'fail', `请求异常：${err.message}`);
      blocked.push(verb);
      continue;
    }

    const reached = originReached(res, body);
    if (!reached) {
      record('动词放行', verb, 'fail',
        `HTTP ${res.status}，但响应里没有本 Worker 的标记 —— 极可能是被 Cloudflare 边缘拦截`);
      blocked.push(verb);
    } else {
      record('动词放行', verb, 'pass', `HTTP ${res.status}（已到达源站）`);
    }
  }
  return blocked;
}

// ── B. Depth 语义 ─────────────────────────────────────────────────────

async function probeDepth() {
  const cases = [
    ['Depth: 0', '0'],
    ['Depth: 1', '1'],
    ['Depth 缺失', undefined],
    ['Depth: infinity', 'infinity'],
  ];
  for (const [label, depth] of cases) {
    const headers = { 'content-type': 'application/xml' };
    if (depth !== undefined) headers.depth = depth;
    let res;
    try {
      res = await req('./', { method: 'PROPFIND', headers, body: '<D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>' });
    } catch (err) {
      record('Depth 语义', label, 'fail', err.message);
      continue;
    }
    const xml = await res.text().catch(() => '');
    const n = countResponses(xml);
    const entries = res.headers.get('x-dav-entries');

    if (res.status === 403 && /propfind-finite-depth/.test(xml)) {
      record('Depth 语义', label, 'info', `403 + DAV:propfind-finite-depth（配置为 deny，符合 RFC 4918 §9.1.5）`);
    } else if (res.status === 207) {
      record('Depth 语义', label, 'pass', `207，${n} 个 response${entries ? `（x-dav-entries=${entries}）` : ''}`);
    } else {
      record('Depth 语义', label, 'fail', `HTTP ${res.status}，期望 207`);
    }
  }
}

// ── C. RFC 4918 一致性（litmus basic / props 的核心）────────────────────

async function probeConformance() {
  await req('./', { method: 'OPTIONS' });
  const opt = await req('./', { method: 'OPTIONS' });
  const davHeader = opt.headers.get('dav') ?? '';
  record('协议声明', 'OPTIONS 的 DAV 头', davHeader.includes('1') ? 'pass' : 'fail',
    `DAV: ${davHeader || '(缺失)'}`);
  if (davHeader.includes('2')) {
    record('协议声明', 'Class 2 声明一致性', 'warn',
      '声明了 Class 2，请确认 LOCK/UNLOCK 真的实现了（有些项目 DAV 头写 1,2 但 Allow 里没有 LOCK）');
  }

  // allprop / propname / prop
  const allprop = await req('./', {
    method: 'PROPFIND', headers: { depth: '0' },
    body: '<D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>',
  });
  const allpropXml = await allprop.text();
  record('PROPFIND', 'allprop 返回 multistatus', allpropXml.includes('<D:multistatus') ? 'pass' : 'fail');

  const propname = await req('./', {
    method: 'PROPFIND', headers: { depth: '0' },
    body: '<D:propfind xmlns:D="DAV:"><D:propname/></D:propfind>',
  });
  const propnameXml = await propname.text();
  record('PROPFIND', 'propname 只返回属性名',
    /<D:resourcetype\/>/.test(propnameXml) && !/<D:getcontentlength>/.test(propnameXml) ? 'pass' : 'fail',
    '（litmus props 套件会检查这一条）');

  const missing = await req('./', {
    method: 'PROPFIND', headers: { depth: '0' },
    body: '<D:propfind xmlns:D="DAV:"><D:prop><D:no-such-prop/></D:prop></D:propfind>',
  });
  const missingXml = await missing.text();
  record('PROPFIND', '未知属性进 404 propstat', hasStatus(missingXml, '404') ? 'pass' : 'fail',
    '（少了这条 Windows 客户端会判定整个请求失败）');

  const emptyBody = await req('./', { method: 'PROPFIND', headers: { depth: '0' } });
  record('PROPFIND', '空 body 按 allprop 处理', emptyBody.status === 207 ? 'pass' : 'fail',
    `HTTP ${emptyBody.status}`);

  // 写路径往返
  const name = `__probe_${Date.now()}.epub`;
  const payload = `probe-payload-${Date.now()}`;

  const put = await req(`./recent/${encodeURIComponent(name)}`, {
    method: 'PUT', body: payload, headers: { 'content-type': 'application/epub+zip' },
  });
  record('写入', 'PUT 新建返回 201', put.status === 201 ? 'pass' : 'fail', `HTTP ${put.status}`);

  const putAgain = await req(`./recent/${encodeURIComponent(name)}`, { method: 'PUT', body: payload });
  record('写入', 'PUT 覆盖返回 204', putAgain.status === 204 ? 'pass' : 'fail', `HTTP ${putAgain.status}`);

  const listed = await req('./recent/', { method: 'PROPFIND', headers: { depth: '1' } });
  const listedXml = await listed.text();
  const leafVisible = await req(`./recent/${encodeURIComponent(name)}`, {
    method: 'PROPFIND', headers: { depth: '0' },
  });

  record('读取', 'PUT 后叶子可访问（权威检查）',
    leafVisible.status === 207 ? 'pass' : 'fail', `HTTP ${leafVisible.status}`);
  await leafVisible.text().catch(() => '');

  if (hrefs(listedXml).some((h) => decodeURIComponent(h).endsWith(name))) {
    record('读取', 'PUT 后出现在列表里', 'pass');
  } else {
    record('读取', 'PUT 后出现在列表里', 'warn',
      '列表缓存 TTL 未过期时的正常现象（新增书目最长 5 分钟后才出现）；' +
      '若持续不出现才是问题，可用 /api/admin/purge 手动失效');
  }

  const head = await req(`./recent/${encodeURIComponent(name)}`, { method: 'HEAD' });
  record('读取', 'HEAD 返回 Content-Length',
    head.status === 200 && head.headers.get('content-length') === String(payload.length) ? 'pass' : 'fail',
    `HTTP ${head.status}, len=${head.headers.get('content-length')}, 期望 ${payload.length}`);

  // 下载：302 到 R2，或者直接 200
  const localTarget = /127\.0\.0\.1|localhost/.test(args.url);
  const get = await req(`./recent/${encodeURIComponent(name)}`);
  if (get.status === 302) {
    const loc = get.headers.get('location') ?? '';
    record('读取', 'GET 302 指向 R2 公开域', loc ? 'pass' : 'fail', loc || '(缺少 Location)');
    // 本地测试时 R2_PUBLIC_BASE 是占位域名，这里必然不通 —— 判为 skip 而不是 fail
    const checkTarget = async () => {
      try {
        const r2 = await fetch(loc, { signal: AbortSignal.timeout(args.timeout) });
        const text = await r2.text();
        if (r2.status === 200 && text === payload) return ['pass', `HTTP 200，内容一致`];
        return ['fail', `HTTP ${r2.status}${r2.status === 530 ? '（Cloudflare 530 = 源站 DNS 解析失败，R2 公开域没配好）' : ''}`];
      } catch (err) {
        return ['fail', err.message];
      }
    };
    if (localTarget) {
      record('读取', '重定向目标可下载', 'skip',
        `本地测试跳过（R2_PUBLIC_BASE 是占位域名，目标 ${new URL(loc).host} 不可达）；部署后用线上地址重跑`);
    } else {
      const [status, detail] = await checkTarget();
      record('读取', '重定向目标可下载且内容一致', status, detail);
    }
  } else if (get.status === 200) {
    const text = await get.text();
    record('读取', 'GET 直接返回内容（未走 302）',
      text === payload ? 'pass' : 'fail',
      '注意：本设计预期是 302，直连会消耗 Worker 的 CPU/内存');
  } else {
    record('读取', 'GET 下载', 'fail', `HTTP ${get.status}`);
  }

  // URL 编码
  const cjk = `__探针_${Date.now()}.epub`;
  const putCjk = await req(`./recent/${encodeURIComponent(cjk)}`, { method: 'PUT', body: 'x' });
  const cjkOk = putCjk.status === 201;
  record('编码', '中文文件名 PUT', cjkOk ? 'pass' : 'fail', `HTTP ${putCjk.status}`);
  if (cjkOk) {
    // 直接对叶子做 depth-0 PROPFIND：不依赖可能已被缓存的列表，
    // 这样测的才是 href 编码本身。
    const pf = await req(`./recent/${encodeURIComponent(cjk)}`, {
      method: 'PROPFIND', headers: { depth: '0' },
    });
    const xml = await pf.text();
    const href = hrefs(xml)[0] ?? '';
    record('编码', 'href 经过 URL 编码',
      href.includes(encodeURIComponent(cjk)) ? 'pass' : 'fail',
      href ? `href = ${href}` : '响应里没有 href');
  }

  // 清理
  for (const n of [name, cjk]) {
    await req(`./recent/${encodeURIComponent(n)}`, { method: 'DELETE' }).catch(() => {});
  }
  const afterDelete = await req(`./recent/${encodeURIComponent(name)}`, { method: 'PROPFIND', headers: { depth: '0' } });
  record('删除', 'DELETE 后访问返回 404', afterDelete.status === 404 ? 'pass' : 'fail',
    `HTTP ${afterDelete.status}`);
}

// ── D. Expect: 100-continue（原始套接字）───────────────────────────────
// fetch 会自己处理掉这个握手，所以要手写 HTTP/1.1。
// r2-webdav 的 litmus `http` 套件就是在这里超时的。

function rawExpectContinue({ host, port, secure, path, authHeader: auth, body }) {
  return new Promise((resolve) => {
    const socket = secure
      ? tls.connect({ host, port, servername: host })
      : net.connect({ host, port });

    let buffer = '';
    let sentBody = false;
    let sawContinue = false;
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        sawContinue,
        reason: sawContinue
          ? '收到 100 Continue 但 20 秒内没有最终响应（这正是 r2-webdav litmus http 套件挂掉的症状）'
          : '20 秒内既没有 100 Continue 也没有最终响应 —— 服务器没有处理 Expect 握手',
      });
    }, 20000);

    const onReady = () => {
      const head = [
        `PUT ${path} HTTP/1.1`,
        `Host: ${host}`,
        'User-Agent: webooks-dav-probe',
        'Expect: 100-continue',
        'Content-Type: application/epub+zip',
        `Content-Length: ${Buffer.byteLength(body)}`,
        auth ? `Authorization: ${auth}` : null,
        'Connection: close',
        '',
        '',
      ].filter((l) => l !== null).join('\r\n');
      socket.write(head);

      // 给服务器 2 秒发 100 Continue；不发也照样把 body 推过去（RFC 允许）
      setTimeout(() => {
        if (!settled && !sentBody) {
          sentBody = true;
          socket.write(body);
        }
      }, 2000);
    };

    if (secure) socket.on('secureConnect', onReady);
    else socket.on('connect', onReady);

    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      if (!sawContinue && /^HTTP\/1\.1 100/.test(buffer)) {
        sawContinue = true;
        if (!sentBody) {
          sentBody = true;
          socket.write(body);
        }
      }
      if (sentBody && /\r\n\r\n/.test(buffer) && !/^HTTP\/1\.1 100/.test(buffer.split('\r\n\r\n')[0])) {
        const statusLine = buffer.slice(0, buffer.indexOf('\r\n'));
        const code = Number(statusLine.split(' ')[1]);
        finish({ ok: true, sawContinue, status: code, statusLine });
      }
    });

    socket.on('error', (err) => finish({ ok: false, sawContinue, reason: err.message }));
    socket.on('close', () => {
      if (!settled) {
        const statusLine = buffer.split('\r\n')[0] ?? '';
        const code = Number(statusLine.split(' ')[1]);
        if (Number.isFinite(code) && code > 0) finish({ ok: true, sawContinue, status: code, statusLine });
        else finish({ ok: false, sawContinue, reason: '连接关闭但没有可解析的响应' });
      }
    });
  });
}

async function probeExpectContinue() {
  const u = new URL(args.url);
  const secure = u.protocol === 'https:';
  const port = u.port ? Number(u.port) : secure ? 443 : 80;
  const path = `${u.pathname.replace(/\/$/, '')}/recent/__probe_expect_${Date.now()}.epub`;
  const body = 'expect-continue-probe';

  const r = await rawExpectContinue({
    host: u.hostname, port, secure, path, authHeader: authHeader, body,
  });

  if (!r.ok) {
    record('Expect: 100-continue', 'PUT 握手', 'fail', r.reason);
    return;
  }
  if (!r.sawContinue) {
    record('Expect: 100-continue', 'PUT 握手', 'warn',
      `服务器未发 100 Continue，但最终仍返回 ${r.status} —— 客户端会白等 1 秒，litmus http 套件可能仍会判失败`);
  } else {
    record('Expect: 100-continue', 'PUT 握手', 'pass', `收到 100 Continue，最终 ${r.status}`);
  }
  if (r.status !== 201 && r.status !== 204) {
    record('Expect: 100-continue', 'PUT 结果', 'warn', `最终状态码 ${r.status}，期望 201/204`);
  }
  // 清理
  await req('./recent/', { method: 'PROPFIND', headers: { depth: '1' } }).catch(() => {});
  const cleanup = await req(`./recent/${encodeURIComponent(path.split('/').pop())}`, { method: 'DELETE' }).catch(() => null);
  if (cleanup) await cleanup.text().catch(() => {});
}

// ── 主流程 ────────────────────────────────────────────────────────────

async function main() {
  console.log(`${C.cyan}WebDAV 探针${C.reset}  ${args.url}`);
  if (authHeader) console.log(`${C.dim}使用 Basic 认证${C.reset}`);
  console.log('='.repeat(74));

  // 先确认目标活着
  try {
    const ping = await req('./', { method: 'OPTIONS' });
    await ping.text().catch(() => {});
  } catch (err) {
    console.error(`${C.red}无法连接 ${args.url}：${err.message}${C.reset}`);
    process.exit(1);
  }

  await probeVerbs();
  await probeDepth();
  await probeConformance();
  await probeExpectContinue();

  // 输出
  let lastGroup = '';
  for (const r of results) {
    if (r.group !== lastGroup) {
      console.log('');
      console.log(`${C.cyan}${r.group}${C.reset}`);
      lastGroup = r.group;
    }
    const color = COLOR[r.status] ?? '';
    console.log(`  ${ICON[r.status]} ${r.name}${r.detail ? `${C.dim} — ${r.detail}${C.reset}` : ''}`);
  }

  const fails = results.filter((r) => r.status === 'fail');
  const warns = results.filter((r) => r.status === 'warn');
  const passes = results.filter((r) => r.status === 'pass');

  console.log('');
  console.log('='.repeat(74));
  console.log(`${passes.length} 通过 · ${warns.length} 警告 · ${fails.length} 失败 · ${results.length} 项`);

  if (fails.length > 0) {
    console.log('');
    console.log(`${C.red}失败项：${C.reset}`);
    for (const f of fails) console.log(`  ❌ [${f.group}] ${f.name} — ${f.detail}`);
    console.log('');
    console.log('若失败集中在「动词放行」，说明 Cloudflare 边缘没有把该动词转发到 Worker。');
    console.log('这是本项目最大的未知数，需要据此调整方案（例如把写入收敛到 POST + 预签名直传）。');
  }
  process.exit(fails.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
