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

  // ★ 凭据闸门：401 + `WWW-Authenticate: Basic realm="webooks"` 是**自家 Worker**
  //   的固定形态（src/lib/auth.ts 的 unauthorizedResponse()，realm 是它的默认值）。
  //   边缘/WAF 拦截**不会**替我们发 Basic 挑战 —— 它只会回 HTML/403。
  //
  //   少了这一条，LOCK / DELETE / MOVE 这些要求写口令的动词（task-10 起闸门在
  //   分发层）在未带凭据时全部落进 classifyFailure() 的 unknown，结论区于是
  //   打印「主因判定：Cloudflare 边缘没有把这些动词转发到 Worker」——
  //   而请求其实早就到达 Worker、是 Worker 自己回的 401。这是**假诊断**，
  //   比不报还坏：它会让人去查 WAF 规则，而真正该做的是补一个写口令。
  //
  //   判据必须连 realm 一起认：裸 401 也可能来自前置的 Cloudflare Access，
  //   那种情况确实不该当成「自家源站已经答上了」。
  const wwwAuth = res.headers.get('www-authenticate') ?? '';
  if (res.status === 401 && /realm="webooks"/.test(wwwAuth)) return true;

  const text = (body ?? '').slice(0, 800);
  if (/<D:multistatus/.test(text)) return true;
  // ★ 自家 Worker 生成的 DAV XML 错误/成功体（RFC 4918 §16 的 `<D:error>` 根元素，
  //   以及 §9.10.1 的 LOCK 200 `<D:prop>`）。
  //
  //   少了这一条，**UNLOCK** 会重演同一个假诊断：匿名 UNLOCK 不带 Lock-Token
  //   时按 §9.11.1 回 400，正文正是
  //   `<D:error xmlns:D="DAV:"><D:lock-token-matches-request-uri/></D:error>`
  //   —— 没有 Allow/DAV/x-dav-* 任何一个头，四句正文也不匹配，于是
  //   originReached() 判否、classifyFailure() 归到 unknown（400 不是 5xx/401/403/405），
  //   最后照样打印「主因判定：Cloudflare 边缘没有把这些动词转发到 Worker」。
  //   实测：光修 401 那条，匿名跑法仍然是这个假结论（红灯在
  //   test/dav-probe.behavior.test.mjs 的 A1）。
  //
  //   判据用 `xmlns:D="DAV:"`：DAV 命名空间前缀是**我们自己**拼的（见
  //   src/lib/xml.ts 与各 handler 的模板字符串），而边缘/WAF 拦截页是 HTML，
  //   不会出现这个命名空间。它比逐个列举根元素稳，新增 DAV XML 响应也不必回来改。
  if (/xmlns:D="DAV:"/.test(text)) return true;
  if (/Collections are virtual|not implemented|Properties are read-only|Not Found/i.test(text)) return true;
  return false;
}

/**
 * 把失败归类。这四种情况处置完全不同，绝不能混为一谈：
 *
 *   worker-crash  5xx 且响应体形如 "error code: 1101"  → 请求已经到达 Worker，
 *                 是 Worker 自己的代码抛了异常。
 *                 ⚠️ 典型误区是把它当成「边缘拦了 WebDAV 动词」——但边缘拦截
 *                    只影响 PROPFIND/MKCOL 这类自定义动词，不会影响 GET/OPTIONS；
 *                    而且边缘的拦截页是 HTML/403，不会是 1101。
 *   auth-required 401 + `WWW-Authenticate: Basic realm="webooks"` → 也到达了
 *                 Worker，是自家凭据闸门（写动词需要口令）。见 originReached()。
 *   edge-block    403/405 且响应里没有任何 Worker 标记     → 边缘/WAF 拦截。
 *   unknown       归不了类，如实报告，不猜。
 *
 * ⚠️ `auth-required` 的 detail 必须给出可执行的下一步（--pass 用法），
 *   光说「需要认证」等于把诊断工作推给读输出的人。
 */
function classifyFailure(res, body) {
  const text = (body ?? '').slice(0, 2000);
  // Cloudflare 的 1101 错误页有两种形态：纯文本 "error code: 1101"，
  // 以及 HTML 的 <span class="cf-error-code">1101</span>。两种都要认。
  const cfCode =
    text.match(/error code:\s*(\d+)/)?.[1] ??
    text.match(/cf-error-code">\s*(\d+)/)?.[1] ??
    text.match(/Worker threw exception/i) ? '1101' : undefined;

  if (res.status >= 500 && cfCode) {
    return {
      kind: 'worker-crash',
      detail: `Worker 运行时异常（Cloudflare ${cfCode}）—— 请求已到达 Worker，是代码抛异常，不是边缘拦截`,
    };
  }
  const wwwAuth = res.headers.get('www-authenticate') ?? '';
  if (res.status === 401 && /realm="webooks"/.test(wwwAuth)) {
    return {
      kind: 'auth-required',
      detail:
        '请求已到达源站：这是本站自己的凭据闸门（写动词需要写口令），不是边缘拦截。'
        + '用 --pass <WRITE_TOKEN> 重跑即可验证写路径',
    };
  }
  if (res.status === 403 || res.status === 405) {
    return {
      kind: 'edge-block',
      detail: `HTTP ${res.status} 且响应里没有 Worker 的任何标记 —— 疑似边缘/WAF 拦截`,
    };
  }
  return { kind: 'unknown', detail: `HTTP ${res.status}，无法归类` };
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
  const crashed = [];
  /** 未带凭据时被自家闸门挡下的动词 —— 结论区据此提示「写路径未验证」 */
  const needsAuth = [];
  /** 给了凭据仍被拒的动词 —— 这才是真 fail（口令错/权限不足） */
  const rejected = [];

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

    // ★ 5xx 必须在 originReached() **之前**判定。
    //
    //   ⚠️ 顺序不是风格问题：裸 500 的正文（"Internal Server Error"）既没有
    //     Allow/DAV 头也没有 DAV XML，originReached() 判否 → 掉进下面那个
    //     「边缘没转发」分支 → 结论区打印
    //     「主因判定：Cloudflare 边缘没有把这些动词转发到 Worker」。
    //     而真相是 Worker 自己抛了异常。实测：本地 wrangler dev 的崩就是这种
    //     裸 500（不带 cf-error-code），所以这条分支是**日常**会走到的，不是边角。
    //
    //   判据是状态码本身：`/health` 已经证明链路通（预检在上面），随后所有
    //   动词 5xx —— 边缘拦截只影响 PROPFIND/MKCOL 这类自定义动词、且回
    //   HTML/403，绝不会对 GET/OPTIONS 也回 5xx。
    if (res.status >= 500) {
      const verdict = classifyFailure(res, body);
      record('动词放行', verb, 'fail',
        verdict.kind === 'worker-crash'
          ? verdict.detail
          : `HTTP ${res.status} —— Worker 自己回的错误（请求已到达源站，不是边缘拦截）`);
      crashed.push(`${verb} → HTTP ${res.status}`);
      continue;
    }

    if (!originReached(res, body)) {
      const verdict = classifyFailure(res, body);
      record('动词放行', verb, 'fail', verdict.detail);
      blocked.push(verb);
      continue;
    }

    // 已到达源站。**401 单独处理**（写动词的凭据闸门）。
    //
    // ⚠️ 判据必须落在**状态码**上，不能只看 classifyFailure 的 kind：
    //   kind 的判定一旦漏了（改坏/改名），401 就会掉进下面的 pass 分支，
    //   于是「缺凭据」被报成「动词放行正常」—— 比报错更坏，因为它假装
    //   验证过了。状态码是唯一不会漂的判据。
    if (res.status === 401) {
      if (authHeader) {
        // 已经给了凭据还是 401 —— 说明口令不对（或权限不足）。
        // 这必须是 fail：脚本带着口令跑出全绿，人就会以为写路径是通的。
        record('动词放行', verb, 'fail',
          'HTTP 401 —— 已带凭据仍被拒，口令错误或权限不足（不是「边缘拦截」）');
        rejected.push(verb);
      } else {
        // 没给凭据 → 这条动词的凭据路径**根本没验证过**。
        // 记 info 而不是 fail：这不是站点的缺陷，是本次调用缺输入。
        record('动词放行', verb, 'info',
          'HTTP 401 —— 到达源站，该动词需要写口令；本次未提供凭据（--pass <WRITE_TOKEN>）');
        needsAuth.push(verb);
      }
      continue;
    }

    // 4xx 且不是自家源站（没有 Allow/DAV/x-dav-* 头、也不是自家 DAV XML）：
    // 这才有「边缘没转发」的意义。
    if (res.status >= 400 && !originReached(res, body)) {
      const verdict = classifyFailure(res, body);
      record('动词放行', verb, 'fail', verdict.detail);
      blocked.push(verb);
      continue;
    }

    record('动词放行', verb, 'pass', `HTTP ${res.status}（已到达源站）`);
  }
  return { blocked, crashed, needsAuth, rejected };
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
  //
  // ⚠️ 凭据闸门（task-10 起在分发层）：本段有两处需要写口令的地方 ——
  //   · PUT **覆盖**已有书（handlePut：existing && !onlyIfAbsent → 401）
  //   · 清理用的 DELETE（分发层无条件要口令）
  //   PUT **新建**保持匿名，所以无凭据时前半截照样通过、后半截是 401。
  //   那种 401 要如实说成「本次没验证过」，不能记成站点失败。
  const name = `__probe_${Date.now()}.epub`;
  const payload = `probe-payload-${Date.now()}`;
  const leafPath = `./recent/${encodeURIComponent(name)}`;

  const put = await req(leafPath, {
    method: 'PUT', body: payload, headers: { 'content-type': 'application/epub+zip' },
  });
  const putBody = await put.text().catch(() => '');
  if (put.status === 201) {
    record('写入', 'PUT 新建返回 201', 'pass', 'HTTP 201（新建保持匿名）');
  } else if (classifyFailure(put, putBody).kind === 'auth-required') {
    // 新建本应匿名。真拿到 401 = 闸门位置变了，如实报（但别混进「站点坏了」）
    record('写入', 'PUT 新建返回 201', 'info',
      'HTTP 401 —— 新建被凭据闸门挡下，与本仓库「新增保持匿名」的设定不符，请核对分发层');
  } else {
    record('写入', 'PUT 新建返回 201', 'fail', `HTTP ${put.status}`);
  }

  const putAgain = await req(leafPath, { method: 'PUT', body: payload });
  const putAgainBody = await putAgain.text().catch(() => '');
  const overwriteVerdict = classifyFailure(putAgain, putAgainBody);
  if (putAgain.status === 204) {
    record('写入', 'PUT 覆盖返回 204', 'pass', 'HTTP 204');
  } else if (overwriteVerdict.kind === 'auth-required' && !authHeader) {
    record('写入', 'PUT 覆盖返回 204', 'info',
      'HTTP 401 —— 覆盖已有书需要写口令（设计如此，见 handlePut）；本次未提供凭据，故未验证');
  } else if (overwriteVerdict.kind === 'auth-required') {
    // 带了凭据还是 401 → 口令错。必须 fail，否则「带口令跑出全绿」是假的
    record('写入', 'PUT 覆盖返回 204', 'fail',
      'HTTP 401 —— 已带凭据仍被拒，口令错误或权限不足（不是「边缘拦截」）');
  } else {
    record('写入', 'PUT 覆盖返回 204', 'fail', `HTTP ${putAgain.status}`);
  }

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

  // ── 清理 ────────────────────────────────────────────────────────────
  //
  // ⚠️ 这里**绝不许静默失败**。本段前面的 PUT 已经在真实书库里落了两个
  //   `__probe_*` / `__探针_*` 对象；DELETE 是需要写口令的（分发层无条件
  //   要凭据），所以**不传凭据跑探针必然删不掉** —— 如果不报出来，每跑一次
  //   探针就往线上书库糊一个永久垃圾文件，而且没人会知道。
  //
  //   修复前这里就是 `await req(...).catch(() => {})`：既不看状态码也不看
  //   正文，401 被完全吞掉。下面按状态码逐个判定并记 fail/warn。
  const leftovers = [];
  for (const n of [name, cjk]) {
    const del = await req(`./recent/${encodeURIComponent(n)}`, { method: 'DELETE' }).catch((err) => err);
    if (del instanceof Error) {
      record('清理', `DELETE ${n}`, 'fail', `请求异常：${del.message}`);
      leftovers.push(n);
      continue;
    }
    const delBody = await del.text().catch(() => '');
    if (del.status === 204 || del.status === 404) continue; // 删掉或本来就没落盘
    if (classifyFailure(del, delBody).kind === 'auth-required') {
      // 这是无凭据跑法的**必然**结果，不是站点缺陷 —— 但垃圾是真的留下了
      record('清理', `DELETE ${n}`, authHeader ? 'fail' : 'warn',
        authHeader
          ? 'HTTP 401 —— 已带凭据仍被拒，探针文件留在书库里了，请手工清理'
          : 'HTTP 401 —— DELETE 需要写口令，探针文件留在了书库里（用 --pass 重跑可自动清掉）');
    } else {
      record('清理', `DELETE ${n}`, 'fail', `HTTP ${del.status} —— 探针文件可能仍在书库里`);
    }
    leftovers.push(n);
  }
  for (const n of leftovers) {
    // 把「留了什么垃圾」写进结论区，让人能照着清
    record('清理', `残留文件：${n}`, 'info',
      `书库里还剩 /最近收录/${n}（可用 POST /api/admin/delete 带 {"leafNames":["${n}"]} 清理）`);
  }

  // 只有前面的 DELETE 真成功了，这条才有意义 —— 否则量到的是「垃圾还在」
  // 而不是「DELETE 的语义对不对」。
  if (leftovers.length === 0) {
    const afterDelete = await req(`./recent/${encodeURIComponent(name)}`, { method: 'PROPFIND', headers: { depth: '0' } });
    record('删除', 'DELETE 后访问返回 404', afterDelete.status === 404 ? 'pass' : 'fail',
      `HTTP ${afterDelete.status}`);
  } else {
    record('删除', 'DELETE 后访问返回 404', 'skip',
      '清理未成功，跳过（否则测到的是残留文件而不是 DELETE 语义）');
  }
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
      // 找最终响应：跳过可能存在的 100 中间响应（后面还有真正的最终状态）
      const blocks = buffer.split(/\r\n\r\n/);
      // 100 响应本身后面紧跟最终响应；把 100 段落滤掉，取最后一个完整块
      const finalBlock = [...blocks].reverse().find((b) => /^HTTP\/1\.[01]\s+\d{3}/.test(b));
      if (finalBlock && sentBody && Number(finalBlock.split(' ')[1]) !== 100) {
        const statusLine = finalBlock.split('\r\n')[0];
        const code = Number(statusLine.split(' ')[1]);
        if (Number.isFinite(code) && code !== 100) finish({ ok: true, sawContinue, status: code, statusLine });
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
      `服务器未发 100 Continue，但最终仍返回 ${r.status} —— 客户端会白等 1 秒`);
  } else {
    record('Expect: 100-continue', 'PUT 握手', 'pass', `收到 100 Continue，最终 ${r.status}`);
  }
  // 最终状态必须是 201/204（201 新建 / 204 覆盖）。
  // 100 是中间响应（informational），不是最终结果，之前误把它当最终响应。
  if (r.status !== 201 && r.status !== 204) {
    record('Expect: 100-continue', 'PUT 结果', 'warn', `最终状态码 ${r.status}，期望 201/204`);
  } else {
    record('Expect: 100-continue', 'PUT 结果', 'pass', `最终 ${r.status}`);
  }
  // 清理（与 probeConformance 同一套要求：DELETE 需要写口令，失败必须报出来）
  await req('./recent/', { method: 'PROPFIND', headers: { depth: '1' } }).catch(() => {});
  const probeLeaf = String(path.split('/').pop());
  const cleanup = await req(`./recent/${encodeURIComponent(probeLeaf)}`, { method: 'DELETE' }).catch((err) => err);
  if (cleanup instanceof Error) {
    record('Expect: 100-continue', '探针文件清理', 'fail', `请求异常：${cleanup.message}`);
    return;
  }
  const cleanupBody = await cleanup.text().catch(() => '');
  if (cleanup.status === 204 || cleanup.status === 404) return;
  if (classifyFailure(cleanup, cleanupBody).kind === 'auth-required') {
    record('Expect: 100-continue', '探针文件清理', authHeader ? 'fail' : 'warn',
      authHeader
        ? 'HTTP 401 —— 已带凭据仍被拒，探针文件留在书库里了，请手工清理'
        : `HTTP 401 —— DELETE 需要写口令，残留 /最近收录/${probeLeaf}（用 --pass 重跑可自动清掉）`);
  } else {
    record('Expect: 100-continue', '探针文件清理', 'fail',
      `HTTP ${cleanup.status} —— 残留 /最近收录/${probeLeaf}`);
  }
}

// ── 主流程 ────────────────────────────────────────────────────────────

async function main() {
  console.log(`${C.cyan}WebDAV 探针${C.reset}  ${args.url}`);
  if (authHeader) console.log(`${C.dim}使用 Basic 认证${C.reset}`);
  console.log('='.repeat(74));

  // ── 预检：Worker 本身是否活着 ──────────────────────────────────────
  // /health 不碰 D1 也不碰任何绑定，是判断「Worker 能否正常响应」最干净的探针。
  // 如果它就崩了，后面所有 WebDAV 检查都无意义，直接停下并指明方向。
  let ping;
  let pingBody = '';
  try {
    ping = await req('../health', { method: 'GET' });
    pingBody = await ping.text().catch(() => '');
  } catch (err) {
    console.error(`${C.red}无法连接 ${args.url}：${err.message}${C.reset}`);
    process.exit(1);
  }

  if (!ping.ok) {
    const verdict = classifyFailure(ping, pingBody);
    console.log('');
    console.log(`${C.red}✘ Worker 本身没有正常响应，WebDAV 检查已跳过。${C.reset}`);
    console.log('');
    console.log(`  /health → ${verdict.detail}`);
    console.log('');
    if (verdict.kind === 'worker-crash') {
      console.log('这不是「边缘拦了 WebDAV 动词」——边缘只拦 PROPFIND/MKCOL 这类自定义动词，');
      console.log('不会影响 GET/OPTIONS，而且边缘拦截页是 HTML/403，不会是 1101。');
      console.log('真实原因：Worker 自己的代码抛了异常。');
      console.log('');
      console.log('拿真实堆栈：');
      console.log('  Dashboard → Workers & Pages → webooks → Logs → Live，然后访问一次站点');
      console.log('本地复现对照：');
      console.log('  npm install && npm run db:migrate:local && npm run dev');
    } else if (verdict.kind === 'edge-block') {
      console.log('边缘/WAF 拦截了 /health。先查该域名的 WAF 规则与 Bot Fight Mode。');
    } else {
      console.log('无法归类，请手工核对 /health 的响应。');
    }
    console.log('');
    console.log('='.repeat(74));
    process.exit(1);
  }

  const { blocked, crashed, needsAuth, rejected } = await probeVerbs();
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
  const infos = results.filter((r) => r.status === 'info');

  console.log('');
  console.log('='.repeat(74));
  console.log(
    `${passes.length} 通过 · ${warns.length} 警告 · ${fails.length} 失败 · ${results.length} 项`
    + (infos.length > 0 ? `（其中 ${infos.length} 条 INFO）` : ''),
  );

  // ── 哪些内容「没被验证」────────────────────────────────────────────
  //
  // ⚠️ 这一节的存在理由：没有凭据时，写动词全被 401 挡下、清理也删不掉，
  //   而这些都是 info（不是 fail）—— 于是「0 失败」看起来像「一切都好」。
  //   实际上写路径**一个字都没验证过**。不把这件事说出来，全绿就是误读。
  if (needsAuth.length > 0 || rejected.length > 0) {
    console.log('');
    if (rejected.length > 0) {
      console.log(`${C.red}✘ 已提供凭据但被拒：${rejected.join(', ')}${C.reset}`);
      console.log('  口令不对（或权限不足）。请核对 WRITE_TOKEN 后重跑 —— 这不代表边缘有问题。');
    }
    if (needsAuth.length > 0) {
      console.log(`${C.yellow}⚠ ${needsAuth.length} 个写动词的凭据路径未验证：${needsAuth.join(', ')}${C.reset}`);
      console.log('  它们返回的都是自家 Worker 的 401（www-authenticate: Basic realm="webooks"）——');
      console.log('  请求已经到达源站，只是本次调用没带写口令。要真正验证写路径，请带上凭据重跑：');
      console.log('');
      console.log('    node scripts/dav-probe.mjs --url <本站>/dav/ --user x --pass <WRITE_TOKEN>');
      console.log('');
      console.log('  注意：不带凭据时 DELETE 也会被拒，探针落盘的 __probe_* 文件会留在书库里');
      console.log('  （上面的「清理」分组会逐条列出残留文件名，可走 /api/admin/delete 清掉）。');
    }
  }

  if (fails.length > 0) {
    console.log('');
    console.log(`${C.red}失败项：${C.reset}`);
    for (const f of fails) console.log(`  ❌ [${f.group}] ${f.name} — ${f.detail}`);
    console.log('');
    if (crashed.length > 0) {
      console.log(`${C.red}主因判定：Worker 运行时异常（不是边缘拦截）。${C.reset}`);
      console.log('所有动词都返回 5xx，包括 GET/OPTIONS。');
      console.log('边缘只会拦自定义动词，不会这样。去 Dashboard → webooks → Logs → Live 看真实堆栈。');
    } else if (blocked.length > 0) {
      console.log('主因判定：Cloudflare 边缘没有把这些动词转发到 Worker。');
      console.log('这是本项目最大的未知数，需要据此调整方案（例如把写入收敛到 POST + 预签名直传）。');
    } else {
      // 没有 blocked 也没有 crashed，却仍有 fail：那都是具体探针的失败，
      // 不能再去猜「边缘拦没拦」—— 曾经这里什么都不打，读者只能自己猜。
      console.log('主因判定：没有整体性故障（动词与 /health 都到达了源站），');
      console.log('上面的失败项是具体行为不符，逐条看 detail 即可。');
    }
  }
  process.exit(fails.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
